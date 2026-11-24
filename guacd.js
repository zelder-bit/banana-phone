// Runs guacd in Docker and a guacamole-lite websocket bridge on localhost, for RDP/VNC panes.
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const dns = require('dns');
const GuacamoleLite = require('guacamole-lite');

const NAME = 'banana-phone-guacd';
const IMAGE = 'guacamole/guacd:1.6.0'; // 1.6 adds cert-fingerprints; still serves guacamole-common-js 1.5 clients
const GUACD_PORT = 4822;
const key = crypto.randomBytes(32); // per-launch: tokens die with the app

const docker = (args) => new Promise((resolve, reject) =>
  execFile('docker', args, { timeout: 300000 }, (err, stdout, stderr) =>
    err ? reject(new Error(err.code === 'ENOENT' ? 'Docker is not installed. RDP and VNC need Docker to run guacd.' : (stderr || err.message).trim()))
        : resolve(stdout.trim())));

const portOpen = () => new Promise((resolve) => {
  const s = net.connect(GUACD_PORT, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

let starting;
let startedHere = false; // only stop a guacd this launch created
function ensureGuacd() {
  return (starting ||= (async () => {
    // Reuse a running container only if it is the image this version expects.
    const running = await docker(['inspect', '-f', '{{.State.Running}} {{.Config.Image}}', NAME]).catch(() => '');
    if (running !== `true ${IMAGE}`) {
      await docker(['rm', '-f', NAME]).catch(() => {});
      await docker(['run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${GUACD_PORT}:4822`, IMAGE]);
      startedHere = true;
    }
    for (let i = 0; i < 50; i++) {
      if (await portOpen()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('guacd did not start listening on 127.0.0.1:4822');
  })().catch((e) => { starting = null; throw e; }));
}

// One websocket bridge per guacd. `guacd` is where that guacd answers: a TCP port on localhost,
// or the path of a unix socket (a shared folder's guacd, below).
const bridges = new Map();
function ensureBridge(guacd = GUACD_PORT) {
  if (!bridges.has(guacd)) bridges.set(guacd, new Promise((resolve) => {
    const server = new GuacamoleLite(
      { host: '127.0.0.1', port: 0 },
      { host: '127.0.0.1', port: guacd }, // guacamole-lite calls net.connect(port, host), which takes a socket path in place of the port
      { crypt: { cypher: 'AES-256-CBC', key }, log: { level: 'ERRORS' }, maxInactivityTime: 0 },
    );
    server.webSocketServer.on('listening', () => resolve(server.webSocketServer.address().port));
  }));
  return bridges.get(guacd);
}

// ---- shared folders -----------------------------------------------------------
// A connection that shares a folder gets a guacd of its own, in a container that can see that one
// folder and nothing else of this computer. guacd follows symlinks and trusts whoever connects to it,
// so the limits are set by the container, not by guacd:
//  - only the shared folder is mounted, read-only unless the share is writable. A link inside it that
//    points elsewhere leads nowhere, and sessions with different shares cannot reach each other's.
//  - guacd runs as you (--user), so it can open only what you can, and what the remote side writes is yours.
//  - guacd listens on the container's own loopback (-b 127.0.0.1) and no port is published. The plain
//    guacd's port on localhost is harmless; this one would hand the folder to any program or user on
//    this computer that connected to it. The only way in is `docker exec`, through relay() below.
const DRIVE = '/drive'; // where the folder appears inside the container
const shares = new Map(); // container name -> { starting: Promise of its relay's socket path }
const me = () => `${process.getuid()}:${process.getgid()}`;

// share: { path: an absolute folder on this computer, writable: boolean }. The caller has checked the folder.
const shareName = (share) => `${NAME}-${process.getuid()}-`
  + crypto.createHash('sha256').update(`${share.path}\n${!!share.writable}`).digest('hex').slice(0, 12);

function shareRunArgs(name, share) {
  // --mount takes comma-separated fields, so a path with a comma or quote could add fields of its own.
  if (typeof share?.path !== 'string' || !path.isAbsolute(share.path) || /[,"\x00-\x1f\x7f]/.test(share.path)) {
    throw new Error('This folder cannot be shared: its path must be absolute, without commas, quotes or control characters');
  }
  return ['run', '-d', '--rm', '--name', name,
    '--user', me(), '-e', 'HOME=/tmp', // FreeRDP wants a home it can write to; yours does not exist in there
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    // Unlike -v, --mount fails if the folder is missing instead of creating it as root.
    '--mount', `type=bind,source=${share.path},target=${DRIVE}${share.writable === true ? '' : ',readonly'}`,
    IMAGE, '-b', '127.0.0.1']; // the image's entrypoint passes extra arguments to guacd; the last -b wins
}

// A unix socket in a folder only you can enter; each connection to it becomes one connection to the
// guacd inside container `name`. Resolves to the socket's path.
let runDir;
const relays = [];
function relay(name) {
  runDir ||= fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'bp-')); // mkdtemp makes it mode 700
  const sock = path.join(runDir, `${name.slice(-12)}.sock`); // short: socket paths end at 107 bytes
  const server = net.createServer((c) => {
    const p = spawn('docker', ['exec', '-i', name, 'nc', '127.0.0.1', String(GUACD_PORT)], { stdio: ['pipe', 'pipe', 'ignore'] });
    const end = () => { c.destroy(); p.kill(); };
    for (const x of [c, p, p.stdin, p.stdout]) x.on('error', end);
    c.on('close', end);
    p.on('close', end); // 'close', not 'exit': by then everything guacd sent has been passed on
    c.pipe(p.stdin);
    p.stdout.pipe(c);
  });
  relays.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => { fs.chmodSync(sock, 0o600); resolve(sock); });
  });
}

// Containers of this kind still around when this launch first shares a folder were left by a launch
// that crashed: only one banana-phone runs per user, and a normal quit stops them (stopGuacd).
let swept;
const sweep = () => (swept ||= (async () => {
  const prefix = `${NAME}-${process.getuid()}-`;
  const old = (await docker(['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}'])).split('\n').filter((n) => n.startsWith(prefix));
  if (old.length) await docker(['rm', '-f', ...old]);
})().catch(() => {}));

const shareRunning = (name) => docker(['inspect', '-f', '{{.State.Running}}', name]).then((out) => out === 'true', () => false);

function ensureShare(share) {
  const name = shareName(share);
  const s = shares.get(name) || shares.set(name, {}).get(name);
  return (s.starting ||= (async () => {
    const args = shareRunArgs(name, share); // refuses a bad path before anything is started
    await sweep();
    await docker(['rm', '-f', name]).catch(() => {});
    await docker(args);
    for (let i = 0; i < 50; i++) {
      const up = await docker(['exec', name, 'nc', '-z', '127.0.0.1', String(GUACD_PORT)]).then(() => true, () => false);
      if (up) return (s.sock ||= relay(name).catch((e) => { s.sock = null; throw e; }));
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('guacd for the shared folder did not start');
  })().catch((e) => { s.starting = null; throw e; }));
}

// guacamole-lite decrypts as ASCII, so escape non-ASCII (e.g. "pässword") to \uXXXX first.
function encryptToken(obj) {
  const json = JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const value = Buffer.concat([cipher.update(json, 'ascii'), cipher.final()]);
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value: value.toString('base64') })).toString('base64');
}

// Asks an RDP server to switch to TLS, as every RDP client does first, and returns
// { fingerprint: SHA-256 of its certificate ("AB:CD:…"), nla: whether it picked NLA over plain TLS }.
// Fails if the server only offers legacy RDP security, which has no certificate to check.
// Windows' self-signed RDP certificates usually allow only "key encipherment". Electron's TLS library
// (BoringSSL) then rejects a modern (ECDHE) handshake with KEY_USAGE_BIT_INCORRECT, while FreeRDP in guacd
// accepts it. RSA key exchange is exactly what key encipherment permits, so retry with that; the probe
// only reads the certificate and sends nothing secret.
const RSA_KEY_EXCHANGE = { maxVersion: 'TLSv1.2', ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA:AES128-SHA' };

async function rdpFingerprint(host, port) {
  try {
    return await probeRdp(host, port, {});
  } catch (e) {
    if (!/KEY_USAGE_BIT_INCORRECT/.test(e.message)) throw e;
    return probeRdp(host, port, RSA_KEY_EXCHANGE).catch(() => {
      throw new Error(`${host}'s certificate only allows RSA key exchange, which the server refused, so its identity could not be read`);
    });
  }
}

function probeRdp(host, port, tlsOptions) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const fail = (msg) => { sock.destroy(); reject(new Error(msg)); }; // no-op once resolved
    sock.setTimeout(10000, () => fail(`${host}:${port} did not answer in time`)); // idle timer, covers the TLS handshake too
    sock.once('error', (e) => fail(`${host}:${port}: ${e.message}`));
    sock.once('close', () => fail(`${host}:${port} closed the connection`));
    // TPKT header (4 bytes) + X.224 Connection Request (7) + RDP_NEG_REQ (8) asking for TLS (1) or NLA (2)
    sock.write(Buffer.from([3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0]));
    let buf = Buffer.alloc(0);
    sock.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (buf[0] !== 3) return fail(`${host}:${port} does not look like an RDP server`); // TPKT version is always 3
      if (buf.length < 4 || buf.length < buf.readUInt16BE(2)) return; // TPKT length says more is coming
      sock.off('data', onData);
      // byte 11: 2 = RDP_NEG_RSP, 3 = RDP_NEG_FAILURE; bytes 15-18: the protocol picked (or failure code)
      if (buf.length >= 19 && buf[11] === 3) return fail(`${host} refused TLS and NLA (failure code ${buf.readUInt32LE(15)})`);
      const selected = buf.length >= 19 && buf[11] === 2 ? buf.readUInt32LE(15) : 0;
      if ((selected & 3) === 0) return fail(`${host} only offers legacy RDP security, so its identity cannot be checked`);
      const t = tls.connect({ socket: sock, rejectUnauthorized: false, ...tlsOptions }, () => {
        const fingerprint = t.getPeerCertificate().fingerprint256;
        t.destroy();
        fingerprint ? resolve({ fingerprint, nla: (selected & 2) !== 0 }) : reject(new Error(`${host} sent no certificate`));
      });
      t.once('error', (e) => fail(`${host}: TLS failed: ${e.message}`));
    });
  });
}

// cert: required for RDP (the result of rdpFingerprint), ignored for VNC.
// share: a folder to show the RDP server as a drive ({ path, writable }), already checked by the caller. VNC has no drives.
async function openRemote(conn, password, cert, share) {
  if (conn.protocol !== 'rdp') share = null;
  let port;
  if (share) {
    const s = shares.get(shareName(share));
    if (s?.starting && !(await shareRunning(shareName(share)))) s.starting = null; // container died or Docker restarted: start again
    port = await ensureBridge(await ensureShare(share));
  } else {
    if (starting && !(await portOpen())) starting = null; // container died or Docker restarted: start again
    await ensureGuacd();
    port = await ensureBridge();
  }
  const host = await resolveHost(conn.host);
  const token = encryptToken({ connection: { type: conn.protocol, settings: remoteSettings({ ...conn, host }, password, cert, share) } });
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

// guacd runs in Docker, whose DNS is only a copy of /etc/resolv.conf: no /etc/hosts, mDNS or VPN
// split DNS. So look the name up here, the way the rest of the system (and other RDP apps) does,
// and give guacd the address. IPv4 first: Docker's default bridge network has no IPv6.
async function resolveHost(host) {
  try {
    return (await dns.promises.lookup(host, { order: 'ipv4first' })).address;
  } catch (e) {
    throw new Error(`Could not look up ${host}: ${e.code || e.message}`);
  }
}

// The guacd connection parameters for one RDP or VNC connection.
function remoteSettings(conn, password, cert, share) {
  const settings = { hostname: conn.host, port: String(conn.port || (conn.protocol === 'rdp' ? 3389 : 5900)), password: password || '' };
  if (conn.protocol === 'rdp') {
    Object.assign(settings, {
      username: conn.username || '', domain: conn.domain || '',
      // Exactly the security the server picked when checked: never 'any', which would let an
      // impostor fall back to legacy RDP (no certificate) and slip past the pinned fingerprint.
      security: cert.nla ? 'nla' : 'tls',
      // Accept exactly this certificate, self-signed or not; anything else is refused by FreeRDP in guacd.
      'cert-fingerprints': `sha256:${cert.fingerprint}`,
      'resize-method': 'display-update',
    });
    if (conn.adminSession) settings.console = 'true'; // the server's console / admin session, like mstsc /admin
    // The shared folder as a drive: "Shared on banana-phone" in Explorer, \\tsclient\Shared in a path.
    if (share) Object.assign(settings, { 'enable-drive': 'true', 'drive-path': DRIVE, 'drive-name': 'Shared', 'client-name': 'banana-phone' });
  } else if (conn.username) settings.username = conn.username;
  return settings;
}

// Sync so it finishes before the process exits. Shared folders' containers always go: nothing else uses them.
function stopGuacd() {
  const names = [...(startedHere ? [NAME] : []), ...shares.keys()];
  if (names.length) try { execFileSync('docker', ['stop', '-t', '1', ...names], { timeout: 10000, stdio: 'ignore' }); } catch {}
  for (const r of relays.splice(0)) r.close();
  shares.clear();
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
  runDir = null;
}

module.exports = { openRemote, remoteSettings, resolveHost, rdpFingerprint, stopGuacd, encryptToken, key, shareRunArgs, shareName, ensureShare };
