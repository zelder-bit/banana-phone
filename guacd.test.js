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
  assert.strictEqual(after(args, '--mount'), 'type=bind,source=/home/u/My Files,target=/drive,readonly,bind-recursive=readonly,bind-propagation=rprivate');
  assert.strictEqual(after(args, '--user'), `${process.getuid()}:${process.getgid()}`);
  assert.strictEqual(after(args, '--cap-drop'), 'ALL');
  assert.strictEqual(after(args, '--security-opt'), 'no-new-privileges');
  assert.ok(!args.some((a) => /^(-p|-P|--publish|--publish-all|-v|--volume|--privileged|--network|--net)/.test(a)));
  // In the groups you are in, so a folder you reach through one of them is not empty over there.
  const added = args.flatMap((a, i) => (a === '--group-add' ? [Number(args[i + 1])] : []));
  assert.deepStrictEqual(added, process.getgroups().filter((g) => g !== process.getgid()));
  // Nothing of its own to write to: its files read-only, /tmp in memory, a limit on how many processes.
  assert.ok(args.includes('--read-only'));
  assert.strictEqual(after(args, '--tmpfs'), `/tmp:uid=${process.getuid()},gid=${process.getgid()},mode=700`); // the home FreeRDP writes to
  assert.match(after(args, '--pids-limit'), /^\d+$/);
  assert.strictEqual(args.filter((a) => a === '--mount').length, 1);
  assert.deepStrictEqual(args.slice(-2), ['-b', '127.0.0.1']); // guacd on the container's own loopback
  assert.match(args.at(-3), /^guacamole\/guacd:1\.6\.0@sha256:[0-9a-f]{64}$/); // by digest: a tag can be pointed at another image
  // Writable only when asked in so many words.
  assert.strictEqual(after(shareRunArgs('n', { path: '/srv/x', writable: true }), '--mount'), 'type=bind,source=/srv/x,target=/drive');
  for (const writable of [undefined, null, false, 'true', 1, {}]) assert.match(after(shareRunArgs('n', { path: '/srv/x', writable }), '--mount'), /,target=\/drive,readonly,bind-recursive=readonly,/);
  // A path that could add mount options of its own, or is no path at all, starts nothing.
  for (const bad of ['relative/x', '', '/a,readonly=false', '/a,source=/', '/a"b', '/a\nb', '/a\u0000b', undefined, null, 42, ['/a']]) {
    assert.throws(() => shareRunArgs('n', { path: bad }), /cannot be shared/, String(bad));
  }
  assert.throws(() => shareRunArgs('n', undefined), /cannot be shared/);
  // One container per connection, folder and mode, named for this user and this launch.
  assert.match(shareName({ id: 'c1', path: '/a' }), new RegExp(`^banana-phone-guacd-${process.getuid()}-${process.pid}-[0-9a-f]{12}$`));
  assert.strictEqual(shareName({ id: 'c1', path: '/a' }), shareName({ id: 'c1', path: '/a', writable: false, dev: '1', ino: '2' }));
  const names = [{ id: 'c1', path: '/a' }, { id: 'c1', path: '/a', writable: true }, { id: 'c1', path: '/b' }, { id: 'c2', path: '/a' }, { id: 'c1', server: 'dc02:3389', path: '/a' }].map(shareName);
  assert.strictEqual(new Set(names).size, 5); // two servers never share a container, nor do read-only and writable
});

// A stand-in for the docker program: writes down what it was asked, `exec -i` (the relay's way in) echoes,
// `ps` lists the container names in `existing`, and `exec <name> stat` says which folder is mounted (the file `mounted`).
function fakeDocker(t, existing = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-docker-'));
  const log = path.join(dir, 'log');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1 $2" = "exec -i" ] && exec cat\n[ "$1" = inspect ] && echo true\n[ "$1" = version ] && cat "${dir}/version"\n[ "$1" = info ] && cat "${dir}/info"\n[ "$1" = ps ] && cat "${dir}/ps"\n[ "$1 $3" = "exec stat" ] && cat "${dir}/mounted"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ps'), existing.map((n) => n + '\n').join(''));
  const engine = (v) => fs.writeFileSync(path.join(dir, 'version'), JSON.stringify({ Server: { Version: v } }) + '\n');
  engine('29.1.0');
  fs.writeFileSync(path.join(dir, 'info'), '{}\n');
  const before = { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  Object.assign(process.env, { PATH: `${dir}:${before.PATH}`, XDG_RUNTIME_DIR: dir });
  t.after(() => {
    process.env.PATH = before.PATH;
    if (before.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = before.XDG_RUNTIME_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return Object.assign(calls, { mounted: (id) => fs.writeFileSync(path.join(dir, 'mounted'), id + '\n'), engine, info: (o) => fs.writeFileSync(path.join(dir, 'info'), JSON.stringify(o) + '\n') });
}

test('a share starts its container once, is reached through a private socket, and is stopped on quit', async (t) => {
  // Containers already there: one left by a launch that has ended, one of a launch still running (this
  // process stands in for it), one of another user, and one that only looks similar.
  const uid = process.getuid();
  const ended = require('child_process').spawnSync(process.execPath, ['-e', '']).pid;
  const left = `banana-phone-guacd-${uid}-${ended}-aaaaaaaaaaaa`;
  const calls = fakeDocker(t, [left, `banana-phone-guacd-${uid}-${process.pid}-bbbbbbbbbbbb`, `banana-phone-guacd-${uid + 1}-${ended}-cccccccccccc`, `banana-phone-guacd-${uid}-${ended}-not-ours`]);
  const { ensureShare, shareName, stopGuacd } = require('./guacd');
  const share = { id: 'c1', path: fs.mkdtempSync(path.join(os.tmpdir(), 'bp-share-')), dev: '64', ino: '1234' };
  const name = shareName(share);
  calls.mounted('64:1234');
  const [sock, again] = await Promise.all([ensureShare(share), ensureShare(share)]);
  assert.strictEqual(sock, again);
  const runs = calls().filter((c) => c.startsWith('run '));
  assert.strictEqual(runs.length, 1);
  assert.match(runs[0], new RegExp(`--name ${name} .*--mount type=bind,source=${share.path},target=/drive,readonly,bind-recursive=readonly,bind-propagation=rprivate `));
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

  // The container must hold the folder that was looked at, not whatever its path led to when Docker mounted it.
  calls.mounted('64:9999'); // as if the folder had been swapped for a link to another one
  await assert.rejects(ensureShare(share), /changed while it was being shared/);
  assert.strictEqual(calls().filter((c) => c === `rm -f ${name}`).length, 2); // once before starting, once now
  await assert.rejects(ensureShare({ id: 'c2', path: share.path }), /changed while it was being shared/); // a share nobody identified is not served either

  stopGuacd();
  assert.ok(calls().some((c) => c.startsWith('stop -t 1 ') && c.split(' ').includes(name)));
  assert.ok(!fs.existsSync(path.dirname(sock)));
});

test('a read-only share is not started where Docker cannot keep all of it read-only', async (t) => {
  const calls = fakeDocker(t);
  const { ensureShare, shareName, stopGuacd } = require('./guacd');
  t.after(stopGuacd);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-share-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  calls.mounted('64:1234');
  // Before Engine 25 a drive mounted inside the folder would stay writable, so nothing is started at all.
  for (const old of ['24.0.7', '20.10.24', '', 'what']) {
    calls.engine(old);
    await assert.rejects(ensureShare({ id: 'old', path: folder, dev: '64', ino: '1234' }), /needs Docker Engine 25 or newer/, old);
  }
  assert.deepStrictEqual(calls().filter((c) => c.startsWith('run ')), []);
  // A writable share promises no such thing, and starts on any Engine.
  const writable = { id: 'old', path: folder, writable: true, dev: '64', ino: '1234' };
  await ensureShare(writable);
  assert.match(calls().filter((c) => c.startsWith('run '))[0], new RegExp(`--name ${shareName(writable)} .*,target=/drive guacamole/guacd`));
  // And the read-only one starts once Docker is new enough.
  calls.engine('25.0.0');
  await ensureShare({ id: 'old', path: folder, dev: '64', ino: '1234' });
  assert.strictEqual(calls().filter((c) => c.startsWith('run ')).length, 2);
});

// Sample answers, cut down to the fields that are read. The plain Docker one is from Debian 13 (Engine 26.1);
// the others follow what each program is documented to print and were not captured from a real one.
test('shareBlocker names rootless Docker, Podman, SELinux, Docker Desktop and an Engine too old, and nothing else', () => {
  const { shareBlocker } = require('./guacd');
  const info = (o) => JSON.stringify({ ServerVersion: '26.1.5', OperatingSystem: 'Debian GNU/Linux 13 (trixie)', SecurityOptions: ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'], ...o });
  const version = JSON.stringify({ Client: { Version: '26.1.5' }, Server: { Version: '26.1.5', Components: [{ Name: 'Engine', Version: '26.1.5' }, { Name: 'containerd' }] } });
  assert.strictEqual(shareBlocker(info(), version), null);
  assert.match(shareBlocker(info({ SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'] }), version), /^Shared folders do not work with rootless Docker yet: .*Nothing was shared\.$/);
  assert.match(shareBlocker(info({ OperatingSystem: 'Fedora Linux 42 (Workstation Edition)', SecurityOptions: ['name=seccomp,profile=builtin', 'name=selinux'] }), version), /where Docker enforces SELinux/);
  assert.match(shareBlocker(info({ OperatingSystem: 'Docker Desktop' }), version), /with Docker Desktop yet/);
  // Podman's own `docker` command: info in Podman's shape, and a version with no Server at all.
  const podmanInfo = JSON.stringify({ host: { security: { rootless: true, selinuxEnabled: false } }, store: {}, version: { Version: '5.4.2' } });
  assert.match(shareBlocker(podmanInfo, JSON.stringify({ Client: { Version: '5.4.2' } })), /with Podman yet/);
  // The real docker talking to Podman's socket: Docker-shaped info, and Podman named among the components.
  assert.match(shareBlocker(info({ SecurityOptions: ['name=rootless'] }), JSON.stringify({ Server: { Version: '5.4.2', Components: [{ Name: 'Podman Engine', Version: '5.4.2' }] } })), /with Podman yet/);
  // A read-only share also needs Engine 25; a writable one starts on any. Podman's 5.x is called Podman, not an old Engine.
  const engine = (v) => JSON.stringify({ Server: { Version: v } });
  for (const old of ['24.0.7', '20.10.24', '', 'what', undefined]) {
    assert.match(shareBlocker(info(), engine(old)), /needs Docker Engine 25 or newer/, old);
    assert.strictEqual(shareBlocker(info(), engine(old), true), null, old);
  }
  assert.match(shareBlocker(info(), engine('')), /and this is not known\./);
  assert.strictEqual(shareBlocker(info(), engine('25.0.0')), null);
  assert.match(shareBlocker(podmanInfo, engine('5.4.2')), /with Podman yet/);
  // An answer that cannot be read could hide any of them, so it shares nothing, writable or not.
  for (const odd of ['', 'what', 'null', '42', '[]', '"name=rootless"', '{"SecurityOptions":']) {
    for (const [i, v] of [[odd, version], [info(), odd], [odd, odd]]) {
      for (const writable of [true, false]) assert.match(shareBlocker(i, v, writable), /^Docker's answer about how it runs could not be read, so nothing was shared\.$/, odd);
    }
  }
  // One that can be read but says something unexpected names none of the four.
  assert.strictEqual(shareBlocker('{"SecurityOptions":"name=other"}', version), null);
});

test('a share is not started where it is known not to work, and the message says why', async (t) => {
  const calls = fakeDocker(t);
  const { ensureShare, stopGuacd } = require('./guacd');
  t.after(stopGuacd);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-share-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  calls.mounted('64:1234');
  calls.info({ ServerVersion: '27.0.3', SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] });
  for (const writable of [false, true]) await assert.rejects(ensureShare({ id: 'r', path: folder, writable, dev: '64', ino: '1234' }), /do not work with rootless Docker/);
  // Podman gives its own version number (5.x). The reason given is Podman, not an Engine that is too old.
  calls.engine('5.4.2');
  calls.info({ host: { security: { rootless: true } }, version: { Version: '5.4.2' } });
  await assert.rejects(ensureShare({ id: 'r', path: folder, dev: '64', ino: '1234' }), /do not work with Podman/);
  assert.deepStrictEqual(calls().filter((c) => c.startsWith('run ')), []);
  // Asked again on the next connect: with an ordinary Docker the same share starts.
  calls.engine('27.0.3');
  calls.info({ ServerVersion: '27.0.3', SecurityOptions: ['name=seccomp,profile=builtin'] });
  await ensureShare({ id: 'r', path: folder, dev: '64', ino: '1234' });
  assert.strictEqual(calls().filter((c) => c.startsWith('run ')).length, 1);
});

test('a token opens one websocket, soon, and says itself which guacd it is for', async (t) => {
  const calls = fakeDocker(t);
  const { openRemote, verifyClient, ticket, stopGuacd } = require('./guacd');
  t.after(stopGuacd);
  const asked = (token) => verifyClient({ req: { url: `/?token=${encodeURIComponent(token)}&width=1` } });
  const make = (once) => encryptToken({ once, connection: { type: 'rdp', settings: {} } });
  const good = make(ticket());
  assert.strictEqual(asked(good), true);
  assert.strictEqual(asked(good), false, 'a second use is refused');
  assert.strictEqual(asked(make('never-issued')), false);
  assert.strictEqual(asked(encryptToken({ connection: { type: 'rdp', settings: {} } })), false, 'a token without a ticket');
  assert.strictEqual(asked('not a token'), false);
  assert.strictEqual(verifyClient({ req: { url: '/' } }), false);
  assert.strictEqual(verifyClient({ req: { url: `/?token=${encodeURIComponent(make(ticket()))}&token=x` } }), false, 'two tokens');
  t.mock.timers.enable({ apis: ['Date'] });
  const late = make(ticket());
  t.mock.timers.tick(61000);
  assert.strictEqual(asked(late), false, 'too late');
  t.mock.timers.reset();

  // A share's token carries the way to its own guacd, encrypted with the settings that were agreed to.
  // The page cannot pair those settings with another share's folder: there is one bridge, and no port to choose.
  const share = (id, dir) => ({ id, path: fs.mkdtempSync(path.join(os.tmpdir(), dir)), dev: '64', ino: '1' });
  calls.mounted('64:1');
  const cert = { fingerprint: 'AA:BB', nla: false };
  const conn = { protocol: 'rdp', host: '127.0.0.1', username: 'u' };
  const open = async (c, s) => { const u = new URL(await openRemote(c, 'pw', cert, s)); return { port: u.port, ...new Crypt('AES-256-CBC', key).decrypt(u.searchParams.get('token')) }; };
  const a = await open({ ...conn, id: 'c1' }, share('c1', 'bp-a-'));
  const b = await open({ ...conn, id: 'c2' }, share('c2', 'bp-b-'));
  assert.strictEqual(a.port, b.port);
  assert.match(a.connection.guacdPort, /\.sock$/);
  assert.notStrictEqual(a.connection.guacdPort, b.connection.guacdPort);
  assert.strictEqual(a.connection.settings['enable-drive'], 'true');
  assert.notStrictEqual(a.once, b.once);
});

test('the bridge drops the page\'s requests for files, however they are cut up, and passes the rest', async (t) => {
  const { fromPage } = require('./pagefilter');
  const { ensureBridge, ticket, stopGuacd } = require('./guacd');
  const through = (...messages) => { const out = []; const f = fromPage((i) => out.push(i)); for (const m of messages) f(Buffer.from(m)); return out.join(''); };
  const rest = '4.sync,2.10;5.mouse,1.1,1.2,1.0;3.key,5.65307,1.1;9.clipboard,1.0,10.text/plain;4.blob,1.0,4.aGk=;3.end,1.0;3.ack,1.1,2.OK,1.0;3.nop;';
  assert.strictEqual(through(rest), rest, 'screen, mouse, keys and clipboard pass as they are');
  assert.strictEqual(through('3.get,1.0,1./;3.nop;3.put,1.0,1.1,10.text/plain,2./x;'), '3.nop;');
  assert.strictEqual(through('3.g', 'et,1.0,', '1./;3.n', 'op;'), '3.nop;', 'cut across messages');
  assert.strictEqual(through('3.nop,14.;3.get,1.0,1./;'), '3.nop,14.;3.get,1.0,1./;', 'inside a value it is only text');
  assert.strictEqual(through('3.nop,1.😀;3.get,1.0,1./;'), '3.nop,1.😀;', 'lengths count characters the way guacd counts them');
  assert.strictEqual(through('3abc.get,1.0,1./;03.nop;'), '3.nop;', 'guacd is sent what was understood, not what was written');
  assert.throws(() => through('get.files;'), /length/);
  assert.throws(() => through('4.get\0,1.0,1./;'), /NUL/, 'guacd would read that name as get');
  assert.throws(() => through('9999999.', 'x'.repeat(1 << 20), 'x'), /does not end/);

  // The real bridge, with a stand-in for guacd that does the handshake and then keeps what it is sent.
  let got = '';
  const guacd = net.createServer((s) => s.on('error', () => {}).on('data', (d) => {
    got += d;
    if (got.endsWith('6.select,3.vnc;')) s.write('4.args,13.VERSION_1_1_0,8.hostname;');
    if (/7\.connect,[^;]*;$/.test(got)) { got = ''; s.write('5.ready,2.$1;'); }
  }));
  await new Promise((r) => guacd.listen(0, '127.0.0.1', r));
  t.after(() => { stopGuacd(); guacd.close(); });
  const token = encryptToken({ once: ticket(), connection: { type: 'vnc', settings: { hostname: 'h' }, guacdPort: guacd.address().port } });
  const ws = new WebSocket(`ws://127.0.0.1:${await ensureBridge()}/?token=${encodeURIComponent(token)}`, 'guacamole');
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.onmessage = resolve; ws.onerror = reject; }); // guacd's "ready", passed on to the page
  ws.send('3.get,1.0,1./;4.sync,1.1;3.g');
  ws.send('et,1.0,1./;3.key,2.65,1.1;');
  for (let i = 0; i < 100 && !got.endsWith('3.key,2.65,1.1;'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(got, '4.sync,1.1;3.key,2.65,1.1;');
});

test('resolveHost looks names up with the system resolver (including /etc/hosts)', async () => {
  const { resolveHost } = require('./guacd');
  assert.strictEqual(await resolveHost('localhost'), '127.0.0.1'); // from /etc/hosts, which guacd's container never sees
  assert.strictEqual(await resolveHost('10.1.2.3'), '10.1.2.3');
  await assert.rejects(resolveHost('no-such-host.invalid'), /Could not look up no-such-host\.invalid/);
});
