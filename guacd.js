// Runs guacd in Docker and a guacamole-lite websocket bridge on localhost, for RDP/VNC panes.
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const dns = require('dns');
const url = require('url');
const GuacamoleLite = require('guacamole-lite');
const Crypt = require('guacamole-lite/lib/Crypt');
const ClientConnection = require('guacamole-lite/lib/ClientConnection');
const Parser = require('guacamole-lite/lib/vendor/GuacamoleParser');

const NAME = 'banana-phone-guacd';
// 1.6 adds cert-fingerprints; still serves guacamole-common-js 1.5 clients. The digest is the one of the multi-platform
// index (x86 and ARM), from `docker buildx imagetools inspect guacamole/guacd:1.6.0`: a tag can be moved, a digest cannot.
const IMAGE = 'guacamole/guacd:1.6.0@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f';
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

let bridge, bridgeServer;
function ensureBridge() {
  if (bridge) return bridge;
  bridge = new Promise((resolve) => {
    const server = bridgeServer = new GuacamoleLite(
      { host: '127.0.0.1', port: 0, verifyClient },
      { host: '127.0.0.1', port: GUACD_PORT }, // where a token goes unless it names another guacd (a shared folder's, below)
      { crypt: { cypher: 'AES-256-CBC', key }, log: { level: 'ERRORS' }, maxInactivityTime: 0 },
    );
    server.webSocketServer.on('listening', () => resolve(server.webSocketServer.address().port));
  });
  return bridge;
}

// A token opens one websocket, within a minute of being made. The page holds every token it was
// given, and a token decides what guacd is told (which server, which folder), so one that worked
// twice would let the page open an agreed share again after you had taken it away.
const TOKEN_LIFE = 60000;
const tickets = new Map(); // a token's `once` -> when it stops being good
function ticket() {
  for (const [t, end] of tickets) if (end < Date.now()) tickets.delete(t);
  const t = crypto.randomBytes(16).toString('hex');
  tickets.set(t, Date.now() + TOKEN_LIFE);
  return t;
}
// Asked by the websocket server before it accepts a connection, so a spent token never reaches guacamole-lite.
function verifyClient(info) {
  try {
    const { token } = url.parse(info.req.url, true).query; // parsed the way guacamole-lite will parse it
    if (typeof token !== 'string') return false;
    const { once } = new Crypt('AES-256-CBC', key).decrypt(token);
    const end = tickets.get(once);
    tickets.delete(once);
    return end > Date.now();
  } catch {
    return false;
  }
}

// What the page sends is read one instruction at a time and written out again for guacd, without the
// two that ask for files. guacd shows a shared folder as a "filesystem object": `get` asks it for a
// folder's listing or a file, `put` hands it a file. Nothing else uses those two (the screen, keys,
// mouse and clipboard have instructions of their own), and guacd answers a listing even with file
// transfer off, so they stop here. guacd is sent what was understood here, never the page's own text:
// an instruction cut across two messages, or one hidden inside another's value, is read here the way
// guacd would read it.
const FILE_REQUESTS = new Set(['get', 'put']);
const MAX_WAITING = 1 << 20; // characters of an instruction not yet complete; guacd's own limit is far lower
function fromPage(send) {
  const parser = new Parser();
  let waiting = 0;
  parser.oninstruction = (opcode, args) => {
    waiting = 0;
    if (!FILE_REQUESTS.has(opcode)) send(Parser.toInstruction([opcode, ...args]));
  };
  return (message) => {
    const text = String(message); // a Buffer from the websocket
    if (text.includes('\0')) throw new Error('The page sent a NUL character'); // guacd's names end at one: "get\0" would be `get` to guacd and something else here
    waiting += text.length;
    parser.receive(text); // throws on what is not an instruction
    // shortcut: an instruction that ends in this message resets the count, so what follows it in the same message is not counted (one message is 100 MB at most, the websocket's limit); count inside the parser if that ever matters
    if (waiting > MAX_WAITING) throw new Error('The page sent an instruction that does not end');
  };
}
// guacamole-lite passes each websocket message to guacd as it came, and has no hook to change that.
const passOn = ClientConnection.prototype.sendMessageToGuacd;
ClientConnection.prototype.sendMessageToGuacd = function (message) {
  this.fromPage ||= fromPage((instruction) => passOn.call(this, instruction));
  try { this.fromPage(message); } catch (e) { this.close(e); }
};

// ---- shared folders -----------------------------------------------------------
// A connection that shares a folder gets a guacd of its own, in a container that can see that one
// folder and nothing else of this computer. guacd follows symlinks and trusts whoever connects to it,
// so the limits are set by the container, not by guacd:
//  - only the shared folder is mounted, read-only unless the share is writable, and read-only all the
//    way down: a drive mounted inside the folder is read-only too (READ_ONLY, below). A link inside it
//    that points elsewhere on this computer leads nowhere. Each connection has its own container, so
//    two servers never meet in one.
//  - which container a session reaches is written inside its encrypted token (guacdPort), with the
//    settings you agreed to. The page cannot pair one share's settings with another share's folder.
//  - guacd runs as you (--user, with the groups you are in), so it can open only what you can, and what
//    the remote side writes is yours. It can write nowhere but the folder and a /tmp kept in memory.
//  - guacd listens on the container's own loopback (-b 127.0.0.1) and no port is published. The plain
//    guacd's port on localhost is harmless; this one would hand the folder to any program or user on
//    this computer that connected to it. The only way in is `docker exec`, through relay() below.
const DRIVE = '/drive'; // where the folder appears inside the container
// guacd has a second way to move files: through the Guacamole connection itself, to and from the page.
// The folder is the whole feature here, so that way is closed. Left open, guacd makes a "Download"
// folder in your folder, and a file the remote side moves into it is sent to the page instead of
// being moved; the page takes no files, so the move would seem to work and do nothing.
const NO_TRANSFER = { 'disable-download': 'true', 'disable-upload': 'true' };
const shares = new Map(); // container name -> { starting: Promise of its relay's socket path, up: it has started }
const me = () => `${process.getuid()}:${process.getgid()}`;
// The other groups you are in. --user alone leaves them out, and a folder you reach through one of
// them (a team's folder) would then look empty from the remote side.
const myGroups = () => process.getgroups().filter((g) => g !== process.getgid()).flatMap((g) => ['--group-add', String(g)]);

// Docker mounts a folder together with whatever is mounted inside it: a USB drive, a network share.
// On its own, `readonly` reaches those inner mounts only on Docker Engine 25 and later with Linux
// 5.12 and later; before that they stay writable, without a word. bind-recursive=readonly asks for
// read-only all the way down and makes Docker refuse to start the container where it cannot be had
// (it must be said together with bind-propagation=rprivate, Docker's default).
const READ_ONLY = ',readonly,bind-recursive=readonly,bind-propagation=rprivate';
// An Engine older than 25 does not know that option. Asked first, so the refusal says what to do.
const READ_ONLY_SINCE = 25;
async function readOnlyOrRefuse() {
  const version = await docker(['version', '--format', '{{.Server.Version}}']); // asked each time: a share's container starts rarely, and Docker can be updated meanwhile
  if (!(parseInt(version, 10) >= READ_ONLY_SINCE)) {
    throw new Error(`A read-only shared folder needs Docker Engine ${READ_ONLY_SINCE} or newer, and this is ${version || 'not known'}. Older ones leave a drive mounted inside the folder open to changes. Update Docker, then connect again.`);
  }
}

// share: what share.js's pin() found, for one connection:
//   { path: the folder, writable: boolean, dev, ino: which folder that was on disk, id: the connection, server: its host and port }
// The name says whose it is: your user number, then this launch (its process id), then the connection, server, folder and mode.
// The server is in it so that a connection pointed at another server does not join the first one's container.
const shareName = (share) => `${NAME}-${process.getuid()}-${process.pid}-`
  + crypto.createHash('sha256').update(JSON.stringify([share.id, share.server, share.path, share.writable === true])).digest('hex').slice(0, 12);

function shareRunArgs(name, share) {
  // --mount takes comma-separated fields, so a path with a comma or quote could add fields of its own.
  if (typeof share?.path !== 'string' || !path.isAbsolute(share.path) || /[,"\x00-\x1f\x7f]/.test(share.path)) {
    throw new Error('This folder cannot be shared: its path must be absolute, without commas, quotes or control characters');
  }
  return ['run', '-d', '--rm', '--name', name,
    '--user', me(), ...myGroups(), '-e', 'HOME=/tmp', // FreeRDP wants a home it can write to; yours does not exist in there
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    // guacd reads whatever the server sends. Should that ever turn it against you, it finds nothing to
    // change but the folder: its own files are read-only, /tmp is memory that is yours alone (said outright:
    // left to itself Docker gives it the owner the image's /tmp has), and it cannot multiply without end.
    '--read-only', '--tmpfs', `/tmp:uid=${process.getuid()},gid=${process.getgid()},mode=700`, '--pids-limit', '512',
    // Unlike -v, --mount fails if the folder is missing instead of creating it as root.
    '--mount', `type=bind,source=${share.path},target=${DRIVE}${share.writable === true ? '' : READ_ONLY}`,
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

// A normal quit stops this launch's containers (stopGuacd). Ones whose launch is no longer running were
// left by a crash: remove them the first time a folder is shared. A second banana-phone that is still
// running (another profile, a test run) keeps its own.
let swept;
const sweep = () => (swept ||= (async () => {
  const ours = new RegExp(`^${NAME}-${process.getuid()}-(\\d+)-[0-9a-f]{12}$`);
  const running = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }; // signal 0 only asks
  const old = (await docker(['ps', '-a', '--filter', `name=${NAME}-${process.getuid()}-`, '--format', '{{.Names}}']))
    .split('\n').filter((n) => ours.test(n) && !running(Number(ours.exec(n)[1])));
  if (old.length) await docker(['rm', '-f', ...old]);
})().catch(() => {}));

const shareRunning = (name) => docker(['inspect', '-f', '{{.State.Running}}', name]).then((out) => out === 'true', () => false);

function startShare(share) {
  const name = shareName(share);
  const s = shares.get(name) || shares.set(name, {}).get(name);
  return (s.starting ||= (async () => {
    const args = shareRunArgs(name, share); // refuses a bad path before anything is started
    if (share.writable !== true) await readOnlyOrRefuse();
    await sweep();
    await docker(['rm', '-f', name]).catch(() => {});
    await docker(args);
    for (let i = 0; i < 50; i++) {
      const up = await docker(['exec', name, 'nc', '-z', '127.0.0.1', String(GUACD_PORT)]).then(() => true, () => false);
      if (up) { s.up = true; return (s.sock ||= relay(name).catch((e) => { s.sock = null; throw e; })); }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('guacd for the shared folder did not start');
  })().catch((e) => { s.starting = null; throw e; }));
}

// The socket that leads to this share's guacd, once its container is known to hold the right folder.
// Docker mounts by path, and a path can be made to lead elsewhere between the moment the folder was
// checked and the moment it is mounted (someone who can write to a folder above it swaps in a link).
// So the folder is identified the way the kernel does, by device and inode number: what the container
// has at /drive must be the very folder share.js looked at. Asked on every connect, as the folder at
// that path may have been replaced since the container started.
async function ensureShare(share) {
  const name = shareName(share);
  const s = shares.get(name);
  // Only a container that had started can have died: one still starting is not "gone".
  if (s?.up && !(await shareRunning(name))) Object.assign(s, { starting: null, up: false }); // Docker restarted, or it crashed
  const sock = await startShare(share);
  const mounted = await docker(['exec', name, 'stat', '-c', '%d:%i', DRIVE]).catch(() => '');
  if (!share.dev || !share.ino || mounted !== `${share.dev}:${share.ino}`) {
    Object.assign(shares.get(name), { starting: null, up: false });
    await docker(['rm', '-f', name]).catch(() => {});
    throw new Error(`${share.path} changed while it was being shared, so nothing was shared. Connect again.`);
  }
  return sock;
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
// share: a folder to show the RDP server as a drive (see shareName), already checked and agreed to. VNC has no drives.
async function openRemote(conn, password, cert, share) {
  if (conn.protocol !== 'rdp') share = null;
  conn = { ...conn }; // as it is now: a change made while Docker starts must not reach a session already agreed to
  let guacdPort; // guacamole-lite reads this from the token and calls net.connect(guacdPort, host), which takes a socket path too
  if (share) guacdPort = await ensureShare(share);
  else {
    if (starting && !(await portOpen())) starting = null; // container died or Docker restarted: start again
    await ensureGuacd();
  }
  const port = await ensureBridge();
  const host = await resolveHost(conn.host);
  const token = encryptToken({ once: ticket(), connection: { type: conn.protocol, settings: remoteSettings({ ...conn, host }, password, cert, share), ...(guacdPort && { guacdPort }) } });
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
    if (share) Object.assign(settings, { 'enable-drive': 'true', 'drive-path': DRIVE, 'drive-name': 'Shared', 'client-name': 'banana-phone', ...NO_TRANSFER });
  } else if (conn.username) settings.username = conn.username;
  return settings;
}

// Sync so it finishes before the process exits. Shared folders' containers always go: nothing else uses them.
function stopGuacd() {
  const names = [...(startedHere ? [NAME] : []), ...shares.keys()];
  if (names.length) try { execFileSync('docker', ['stop', '-t', '1', ...names], { timeout: 10000, stdio: 'ignore' }); } catch {}
  bridgeServer?.close();
  bridge = bridgeServer = null;
  for (const r of relays.splice(0)) r.close();
  shares.clear();
  tickets.clear();
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
  runDir = null;
}

module.exports = { openRemote, remoteSettings, resolveHost, rdpFingerprint, stopGuacd, encryptToken, key, shareRunArgs, shareName, ensureShare, sweep, verifyClient, ticket, ensureBridge, fromPage };
