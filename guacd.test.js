const test = require('node:test');
const assert = require('node:assert');
const Crypt = require('guacamole-lite/lib/Crypt');
const { encryptToken, key } = require('./guacd');

test('token survives guacamole-lite decryption, non-ASCII password included', () => {
  const token = { connection: { type: 'rdp', settings: { hostname: 'dc01', password: 'pässwörd€', domain: 'CORP' } } };
  assert.deepStrictEqual(new Crypt('AES-256-CBC', key).decrypt(encryptToken(token)), token);
});

// A fake RDP server: answers the X.224 request, then speaks TLS with a throwaway self-signed certificate.
const net = require('net');
const tls = require('tls');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { X509Certificate } = require('crypto');
const { rdpFingerprint } = require('./guacd');

function fakeRdp(selected, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fake-rdp', ...extra,
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const key = fs.readFileSync(path.join(dir, 'k.pem'));
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  const server = net.createServer((s) => s.once('data', () => {
    s.write(Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0, 0, 0, 2, 0, 8, 0, selected, 0, 0, 0]));
    if (selected) new tls.TLSSocket(s, { isServer: true, key, cert }).on('error', () => {});
    else s.end();
  }));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, fp: new X509Certificate(cert).fingerprint256 })));
}

test('rdpFingerprint returns the certificate fingerprint after the RDP-to-TLS switch', async () => {
  const { server, port, fp } = await fakeRdp(2); // 2 = server picked NLA
  try { assert.deepStrictEqual(await rdpFingerprint('127.0.0.1', port), { fingerprint: fp, nla: true }); } finally { server.close(); }
});

// Windows' self-signed RDP certificate allows only key encipherment. Electron's BoringSSL refuses that in a
// modern handshake (plain Node's OpenSSL does not), so run this file with `npm run test:electron` too.
test('rdpFingerprint reads a Windows-style certificate (key encipherment only)', async () => {
  const { server, port, fp } = await fakeRdp(2, ['-addext', 'keyUsage=keyEncipherment,dataEncipherment', '-addext', 'extendedKeyUsage=serverAuth']);
  try { assert.deepStrictEqual(await rdpFingerprint('127.0.0.1', port), { fingerprint: fp, nla: true }); } finally { server.close(); }
});

test('rdpFingerprint fails fast when the server hangs up or is not RDP', async () => {
  const hangUp = net.createServer((s) => s.once('data', () => s.end()));
  const ssh = net.createServer((s) => s.write('SSH-2.0-OpenSSH_9.6\r\n'));
  await Promise.all([hangUp, ssh].map((srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r))));
  try {
    await assert.rejects(rdpFingerprint('127.0.0.1', hangUp.address().port), /closed the connection/);
    await assert.rejects(rdpFingerprint('127.0.0.1', ssh.address().port), /does not look like an RDP server/);
  } finally { hangUp.close(); ssh.close(); }
});

test('rdpFingerprint refuses servers that only offer legacy RDP security', async () => {
  const { server, port } = await fakeRdp(0);
  try { await assert.rejects(rdpFingerprint('127.0.0.1', port), /legacy RDP security/); } finally { server.close(); }
});

test('RDP settings: pinned certificate, and the admin (console) session only when asked', () => {
  const { remoteSettings } = require('./guacd');
  const cert = { fingerprint: 'AA:BB', nla: true };
  const base = { protocol: 'rdp', host: 'dc01', username: 'admin', domain: 'CORP' };
  const s = remoteSettings(base, 'pw', cert);
  assert.deepStrictEqual([s.security, s['cert-fingerprints'], s.port, 'console' in s], ['nla', 'sha256:AA:BB', '3389', false]);
  assert.strictEqual(remoteSettings({ ...base, adminSession: true }, 'pw', cert).console, 'true');
  assert.ok(!('console' in remoteSettings({ protocol: 'vnc', host: 'k', adminSession: true }, 'pw')));
});

// ---- shared folders ----

test('the drive is on only for an RDP connection that was given a share', () => {
  const { remoteSettings } = require('./guacd');
  const cert = { fingerprint: 'AA:BB', nla: true };
  const rdp = { protocol: 'rdp', host: 'dc01' };
  const s = remoteSettings(rdp, 'pw', cert, { path: '/home/u/Projects' });
  // The path guacd gets is the mount point in its container, never the folder's real path.
  assert.deepStrictEqual([s['enable-drive'], s['drive-path'], s['drive-name'], s['client-name']], ['true', '/drive', 'Shared', 'banana-phone']);
  assert.ok(!JSON.stringify(s).includes('/home/u'));
  // Files move through the folder only: guacd's own transfer through the page is off, and with it the "Download" folder it would make.
  assert.deepStrictEqual([s['disable-download'], s['disable-upload']], ['true', 'true']);
  for (const plain of [remoteSettings(rdp, 'pw', cert), remoteSettings({ protocol: 'vnc', host: 'k' }, 'pw', undefined, { path: '/x' })]) {
    assert.ok(!Object.keys(plain).some((k) => /drive|client-name|disable-/.test(k)));
  }
});

test("a share's container sees only that folder, read-only by default, as you, with no port", () => {
  const { shareRunArgs, shareName } = require('./guacd');
  const args = shareRunArgs('n', { path: '/home/u/My Files' });
  const after = (a, flag) => a[a.indexOf(flag) + 1];
  assert.strictEqual(after(args, '--mount'), 'type=bind,source=/home/u/My Files,target=/drive,readonly');
  assert.strictEqual(after(args, '--user'), `${process.getuid()}:${process.getgid()}`);
  assert.strictEqual(after(args, '--cap-drop'), 'ALL');
  assert.strictEqual(after(args, '--security-opt'), 'no-new-privileges');
  assert.ok(!args.some((a) => /^(-p|-P|--publish|--publish-all|-v|--volume|--privileged|--network|--net)/.test(a)));
  assert.strictEqual(args.filter((a) => a === '--mount').length, 1);
  assert.deepStrictEqual(args.slice(-3), ['guacamole/guacd:1.6.0', '-b', '127.0.0.1']); // guacd on the container's own loopback
  // Writable only when asked in so many words.
  assert.strictEqual(after(shareRunArgs('n', { path: '/srv/x', writable: true }), '--mount'), 'type=bind,source=/srv/x,target=/drive');
  for (const writable of [undefined, null, false, 'true', 1, {}]) assert.match(after(shareRunArgs('n', { path: '/srv/x', writable }), '--mount'), /,readonly$/);
  // A path that could add mount options of its own, or is no path at all, starts nothing.
  for (const bad of ['relative/x', '', '/a,readonly=false', '/a,source=/', '/a"b', '/a\nb', '/a\u0000b', undefined, null, 42, ['/a']]) {
    assert.throws(() => shareRunArgs('n', { path: bad }), /cannot be shared/, String(bad));
  }
  assert.throws(() => shareRunArgs('n', undefined), /cannot be shared/);
  // One container per folder and mode, named for this user.
  assert.match(shareName({ path: '/a' }), new RegExp(`^banana-phone-guacd-${process.getuid()}-${process.pid}-[0-9a-f]{12}$`));
  assert.strictEqual(shareName({ path: '/a' }), shareName({ path: '/a', writable: false }));
  assert.notStrictEqual(shareName({ path: '/a' }), shareName({ path: '/a', writable: true }));
  assert.notStrictEqual(shareName({ path: '/a' }), shareName({ path: '/b' }));
});

// A stand-in for the docker program: writes down what it was asked, `exec -i` (the relay's way in) echoes,
// and `ps` lists the container names in `existing`.
function fakeDocker(t, existing = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-docker-'));
  const log = path.join(dir, 'log');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1 $2" = "exec -i" ] && exec cat\n[ "$1" = inspect ] && echo true\n[ "$1" = ps ] && cat "${dir}/ps"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ps'), existing.map((n) => n + '\n').join(''));
  const before = { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  Object.assign(process.env, { PATH: `${dir}:${before.PATH}`, XDG_RUNTIME_DIR: dir });
  t.after(() => {
    process.env.PATH = before.PATH;
    if (before.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = before.XDG_RUNTIME_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

test('a share starts its container once, is reached through a private socket, and is stopped on quit', async (t) => {
  // Containers already there: one left by a launch that has ended, one of a launch still running (this
  // process stands in for it), one of another user, and one that only looks similar.
  const uid = process.getuid();
  const ended = require('child_process').spawnSync(process.execPath, ['-e', '']).pid;
  const left = `banana-phone-guacd-${uid}-${ended}-aaaaaaaaaaaa`;
  const calls = fakeDocker(t, [left, `banana-phone-guacd-${uid}-${process.pid}-bbbbbbbbbbbb`, `banana-phone-guacd-${uid + 1}-${ended}-cccccccccccc`, `banana-phone-guacd-${uid}-${ended}-not-ours`]);
  const { ensureShare, shareName, stopGuacd } = require('./guacd');
  const share = { path: fs.mkdtempSync(path.join(os.tmpdir(), 'bp-share-')) };
  const name = shareName(share);
  const [sock, again] = await Promise.all([ensureShare(share), ensureShare(share)]);
  assert.strictEqual(sock, again);
  const runs = calls().filter((c) => c.startsWith('run '));
  assert.strictEqual(runs.length, 1);
  assert.match(runs[0], new RegExp(`--name ${name} .*--mount type=bind,source=${share.path},target=/drive,readonly `));
  assert.deepStrictEqual(calls().filter((c) => c.startsWith('rm -f ') && c !== `rm -f ${name}`), [`rm -f ${left}`]); // only the crashed launch's
  // Only this user may connect: the socket and the folder around it.
  assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
  // Bytes go in and come back through `docker exec -i <container> nc 127.0.0.1 4822`.
  const echoed = await new Promise((resolve, reject) => {
    const c = net.connect(sock);
    c.on('error', reject);
    c.on('data', (d) => { resolve(d.toString()); c.destroy(); });
    c.write('6.select,3.rdp;');
  });
  assert.strictEqual(echoed, '6.select,3.rdp;');
  assert.ok(calls().includes(`exec -i ${name} nc 127.0.0.1 4822`));
  stopGuacd();
  assert.ok(calls().includes(`stop -t 1 ${name}`));
  assert.ok(!fs.existsSync(path.dirname(sock)));
});

test('resolveHost looks names up with the system resolver (including /etc/hosts)', async () => {
  const { resolveHost } = require('./guacd');
  assert.strictEqual(await resolveHost('localhost'), '127.0.0.1'); // from /etc/hosts, which guacd's container never sees
  assert.strictEqual(await resolveHost('10.1.2.3'), '10.1.2.3');
  await assert.rejects(resolveHost('no-such-host.invalid'), /Could not look up no-such-host\.invalid/);
});
