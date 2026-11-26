// Runs guacd (in Docker, or the one installed on this computer) and a guacamole-lite websocket bridge on localhost, for RDP/VNC panes.
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
require('./pagefilter'); // before any session: the page's requests for files never reach guacd

const NAME = 'banana-phone-guacd';
// 1.6 adds cert-fingerprints; still serves guacamole-common-js 1.5 clients. The digest is the one of the multi-platform
// index (x86 and ARM), from `docker buildx imagetools inspect guacamole/guacd:1.6.0`: a tag can be moved, a digest cannot.
const IMAGE = 'guacamole/guacd:1.6.0@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f';
const GUACD_PORT = 4822;
const key = crypto.randomBytes(32); // per-launch: tokens die with the app

const docker = (args) => new Promise((resolve, reject) =>
  execFile('docker', args, { timeout: 300000 }, (err, stdout, stderr) =>
    err ? reject(err.code === 'ENOENT' ? Object.assign(new Error('Docker is not installed'), { code: 'NO_DOCKER' }) : new Error((stderr || err.message).trim()))
        : resolve(stdout.trim())));

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

async function startDockerGuacd() {
  // Reuse a running container only if it is the image this version expects.
  const running = await docker(['inspect', '-f', '{{.State.Running}} {{.Config.Image}}', NAME]).catch(() => '');
  if (running !== `true ${IMAGE}`) {
    await docker(['rm', '-f', NAME]).catch(() => {});
    await docker(['run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${GUACD_PORT}:4822`, IMAGE]);
    startedHere = true;
  }
  for (let i = 0; i < 50; i++) {
    if (await portOpen(GUACD_PORT)) return GUACD_PORT;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('guacd did not start listening on 127.0.0.1:4822');
}

// ---- without Docker: the guacd installed on this computer -----------------------
// Older guacds ignore settings they do not know. One that ignored cert-fingerprints would connect to a
// server whose certificate nobody checked, so anything older than the version tested here is not used.
const MIN_GUACD = [1, 6, 0];
// out: what `guacd -v` printed, e.g. "Guacamole proxy daemon (guacd) version 1.6.0". Returns '' if it will do, or why not.
function guacdTooOld(out) {
  const m = /version (\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!m) return 'guacd is not installed on this computer';
  const older = MIN_GUACD.map((n, i) => Number(m[i + 1]) - n).find((d) => d !== 0) < 0;
  return older ? `the guacd installed on this computer is ${m.slice(1).join('.')}, and ${MIN_GUACD.join('.')} or newer is needed (an older one would not check the RDP server's certificate)` : '';
}
// -f: stay in the foreground, so it is our child and can be stopped. -b: reachable from this computer only.
const localGuacdArgs = (port) => ['-f', '-b', '127.0.0.1', '-l', String(port)];
// A port nothing is using, so a guacd service already on 4822 (Debian's package starts one) is not in the way.
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let local; // the guacd process this launch started, if Docker is not installed
let quit = new AbortController(); // stopGuacd aborts it: that ends the guacd started here, and stops a start still under way
// shortcut: if banana-phone is killed outright (kill -9, a crash) this guacd stays on its localhost
// port until you log out; add a sweep like the shares' if that turns out to happen.
async function startLocalGuacd(signal) {
  const version = await new Promise((resolve) => execFile('guacd', ['-v'], { timeout: 10000 }, (err, stdout, stderr) => resolve(err ? '' : stdout + stderr)));
  const why = guacdTooOld(version);
  if (why) throw new Error(why);
  const port = await freePort();
  if (signal.aborted) throw new Error('banana-phone is quitting'); // stopGuacd ran meanwhile: do not start what nothing would stop
  const child = local = spawn('guacd', localGuacdArgs(port), { signal, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '', gone = false, up = false;
  child.stderr.on('data', (d) => { said = (said + d).slice(-500); }); // read always, so guacd never waits on a full pipe
  child.on('error', (e) => { said = e.message; gone = true; });
  // Once it has ended its port is free for any program to take, so the port is forgotten with it.
  child.on('exit', () => { gone = true; if (local === child) { local = null; if (up) starting = null; } });
  for (let i = 0; i < 50 && !gone; i++) {
    if (await portOpen(port)) { up = true; return port; }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`guacd did not start listening on 127.0.0.1:${port}${said.trim() && `: ${said.trim()}`}`);
}

let starting; // a Promise of the port the plain guacd listens on
let startedHere = false; // only stop a guacd this launch created
// Docker first: there guacd is shut in a container, and that is the way that has been run for real.
// The guacd of this computer runs as you, so it is used only where Docker is not installed.
function ensureGuacd() {
  const { signal } = quit; // this launch's, taken now: a quit while Docker is still being tried must reach the guacd started after it
  return (starting ||= startDockerGuacd().catch((viaDocker) => {
    // A Docker that is installed and failed (not running, no permission, no image) is to be put right, not quietly swapped for the weaker way.
    if (viaDocker.code !== 'NO_DOCKER') throw new Error(`${viaDocker.message}\nThe guacd installed on this computer is used only when Docker is not installed.`);
    return startLocalGuacd(signal).catch((viaLocal) => {
      throw new Error(`RDP and VNC need Docker, or guacd ${MIN_GUACD.join('.')} or newer installed on this computer.\nDocker: ${viaDocker.message}\nguacd: ${viaLocal.message}`);
    });
  }).catch((e) => { starting = null; throw e; }));
}

// Forgets a guacd that was started and no longer answers (it died, or Docker restarted), so that the next call starts one.
async function forgetDeadGuacd() {
  const was = starting;
  if (!was) return;
  const port = await was.catch(() => null); // a start that failed has already cleared `starting` itself
  if (port && !(await portOpen(port)) && starting === was) starting = null; // unless someone else already started the next one
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
const tickets = new Map(); // a token's `once` -> { end: when it stops being good, release, timer: for a share's token (hold, below) }
function ticket(release) {
  for (const [t, { end }] of tickets) if (end < Date.now()) tickets.delete(t);
  const t = crypto.randomBytes(16).toString('hex');
  // A share's container is held for its token: until the token runs out unused, or else until its websocket has closed.
  const timer = release && setTimeout(() => { tickets.delete(t); release(); }, TOKEN_LIFE).unref();
  tickets.set(t, { end: Date.now() + TOKEN_LIFE, release, timer });
  return t;
}
// Asked by the websocket server before it accepts a connection, so a spent token never reaches guacamole-lite.
// It does two things: it checks the token, and for a share's token it hands the hold on the share's
// container (hold, below) from the token to the connection, to be let go when that closes.
function verifyClient(info) {
  try {
    const { token } = url.parse(info.req.url, true).query; // parsed the way guacamole-lite will parse it
    if (typeof token !== 'string') return false;
    const { once } = new Crypt('AES-256-CBC', key).decrypt(token);
    const t = tickets.get(once);
    tickets.delete(once);
    if (!(t?.end > Date.now())) return false;
    // The socket under the websocket, not guacamole-lite's 'close': that one is not sent for every way a connection can end.
    if (t.release) { clearTimeout(t.timer); info.req.socket.once('close', t.release); }
    return true;
  } catch {
    return false;
  }
}

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
// What is known of each share's container, by its name:
//   starting: the Promise of its relay's socket path, once a start has begun (startShare)
//   up:       it has started
//   sock:     the Promise of its relay's socket path; the relay outlives the container (relay)
//   held:     how many sessions and good tokens are using it (hold)
//   idle:     the timer that removes it once nothing holds it (hold)
//   stopping: the Promise of its removal, once one has begun (removeShare)
const shares = new Map();
const shareEntry = (name) => shares.get(name) || shares.set(name, { starting: null, up: false, sock: null, held: 0, idle: null, stopping: null }).get(name);
// The one way a share's container goes while the app runs (its network stays: that is the launch's, removed on quit). It is marked as not started in the same
// step in which the removal begins, so nobody takes it for running, and a start that comes meanwhile
// waits for `stopping` (startShare).
function removeShare(s, name) {
  Object.assign(s, { starting: null, up: false });
  return (s.stopping = docker(['rm', '-f', name]).catch(() => {}));
}
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

// Ways of running containers where a share is known not to work. Left to fail on its own, the folder
// shows up empty, refuses writes, or is said to have "changed".
// Each row: how one is recognised (i: docker info, v: docker version, options: info's security options
// as one string), and what is said about it. The first row that fits is the answer.
const OTHER_USER = 'the container as another user on this computer, so the folder would be unreadable or files would arrive with the wrong owner';
const BLOCKERS = [
  // Podman's own `docker` command answers in Podman's shape (host, store). Reached through its socket by the real docker, it names itself as a component.
  [(i, v) => (i.host && !i.ServerVersion) || /podman/i.test(JSON.stringify(v.Server?.Components || '')), `with Podman yet: it can run ${OTHER_USER}`],
  [(i) => i.OperatingSystem === 'Docker Desktop', 'with Docker Desktop yet: its containers run in a virtual machine, where banana-phone cannot confirm that the folder mounted is the one you chose'],
  [(i, v, options) => /\bname=rootless\b/.test(options), `with rootless Docker yet: it runs ${OTHER_USER}`],
  [(i, v, options) => /\bname=selinux\b/.test(options), 'where Docker enforces SELinux (Fedora, RHEL) yet: the folder has no label that lets a container in, and banana-phone will not relabel a folder you also use elsewhere'],
];

// Why this Docker cannot serve a share, said before anything is started, or nothing where it can.
// info, version: what `docker info` and `docker version` print with --format '{{json .}}'. writable: the share's mode.
function shareBlocker(info, version, writable) {
  const json = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
  const i = json(info), v = json(version);
  // An answer that is no JSON object could hide any of the rows above, so it is not taken for "none of them".
  if (!i || !v) return "Docker's answer about how it runs could not be read, so nothing was shared.";
  // Searched as one string, not compared entry by entry: an entry can say more than its name ("name=seccomp,profile=builtin").
  const options = [].concat(i.SecurityOptions || []).join(' ');
  const why = BLOCKERS.find(([fits]) => fits(i, v, options))?.[1];
  if (why) return `Shared folders do not work ${why}. Nothing was shared.`;
  // Only now the Engine's number: Podman's is its own (5.x) and would read as an Engine that is too old.
  const engine = v.Server?.Version;
  if (writable !== true && !(parseInt(engine, 10) >= READ_ONLY_SINCE)) {
    return `A read-only shared folder needs Docker Engine ${READ_ONLY_SINCE} or newer, and this is ${engine || 'not known'}. Older ones leave a drive mounted inside the folder open to changes. Update Docker, then connect again.`;
  }
  return null;
}
const dockerSays = (what) => docker([what, '--format', '{{json .}}']);

// share: what share.js's pin() found, for one connection:
//   { path: the folder, writable: boolean, dev, ino: which folder that was on disk, id: the connection, server: its host and port }
// The name says whose it is: your user number, then this launch (its process id), then the connection, server, folder and mode.
// The server is in it so that a connection pointed at another server does not join the first one's container.
const shareName = (share) => `${NAME}-${process.getuid()}-${process.pid}-`
  + crypto.createHash('sha256').update(JSON.stringify([share.id, share.server, share.path, share.writable === true])).digest('hex').slice(0, 12);

// Measured with one session and a busy screen: 54 MB at 1920x1080, 128 MB at 3840x2160, 189 MB at 7680x2160.
// A limit, not a reservation; /tmp counts towards it. The same figure for --memory-swap means no swap on top.
const MEMORY = '1g';
// Share containers get a network of their own, one per launch, where containers cannot talk to each
// other (enable_icc=false). On Docker's default bridge a guacd turned against you could reach the plain
// guacd's port and every other container there. It still reaches the servers you connect to.
const shareNet = () => `${NAME}-${process.getuid()}-${process.pid}`;
const NO_ICC = 'com.docker.network.bridge.enable_icc';
let networking;
// Asked each time a share's container starts: the network may have been pruned while no share was up.
const ensureNet = () => (networking ||= (async () => {
  const closed = () => docker(['network', 'inspect', '-f', `{{index .Options "${NO_ICC}"}}`, shareNet()]).then((icc) => icc === 'false', () => false);
  if (await closed()) return;
  // Docker may only have been too busy to answer the first time: a network that is there and closed after all is fine.
  // One of that name that is not closed was not made here (the name carries our process id), and nothing is started on it.
  await docker(['network', 'create', '-o', `${NO_ICC}=false`, shareNet()]).catch(async (e) => { if (!(await closed())) throw e; });
})().finally(() => { networking = null; }));

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
    '--network', shareNet(), '--memory', MEMORY, '--memory-swap', MEMORY,
    // Unlike -v, --mount fails if the folder is missing instead of creating it as root.
    '--mount', `type=bind,source=${share.path},target=${DRIVE}${share.writable === true ? '' : READ_ONLY}`,
    IMAGE, '-b', '127.0.0.1']; // the image's entrypoint passes extra arguments to guacd; the last -b wins
}

// A unix socket in a folder only you can enter; each connection to it becomes one connection to the
// guacd inside container `name`. Resolves to the socket's path.
let runDir;
const relays = [];
const execs = new Set(); // the `docker exec`s of sessions that are open
function relay(name) {
  runDir ||= fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'bp-')); // mkdtemp makes it mode 700
  const sock = path.join(runDir, `${name.slice(-12)}.sock`); // short: socket paths end at 107 bytes
  const server = net.createServer((c) => {
    const p = spawn('docker', ['exec', '-i', name, 'nc', '127.0.0.1', String(GUACD_PORT)], { stdio: ['pipe', 'pipe', 'ignore'] });
    execs.add(p);
    const end = () => { c.destroy(); p.kill(); execs.delete(p); };
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
  const running = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }; // signal 0 only asks
  // Containers first: Docker does not remove a network that still has one on it.
  for (const [list, format, hash, rm] of [[['ps', '-a'], '{{.Names}}', '-[0-9a-f]{12}', ['rm', '-f']], [['network', 'ls'], '{{.Name}}', '', ['network', 'rm']]]) {
    const ours = new RegExp(`^${NAME}-${process.getuid()}-(\\d+)${hash}$`);
    const old = (await docker([...list, '--filter', `name=${NAME}-${process.getuid()}-`, '--format', format]))
      .split('\n').filter((n) => ours.test(n) && !running(Number(ours.exec(n)[1])));
    if (old.length) await docker([...rm, ...old]);
  }
})().catch(() => {}));

const shareRunning = (name) => docker(['inspect', '-f', '{{.State.Running}}', name]).then((out) => out === 'true', () => false);

// A share's container runs only while it is in use. Every session holds it, from before its token is
// made until its websocket has closed, and a while after the last one lets go the container is removed:
// a folder is not left mounted for hours, and the next session's container sees drives plugged in since.
// The wait spares a quick reconnect the restart.
const IDLE = 10000;
function hold(share) {
  const name = shareName(share);
  const s = shareEntry(name);
  s.held++;
  clearTimeout(s.idle);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--s.held > 0) return;
    s.idle = setTimeout(() => {
      if (s.held || shares.get(name) !== s) return; // held again, or the app has quit
      removeShare(s, name);
    }, IDLE).unref();
  };
}

function startShare(share) {
  const name = shareName(share);
  const s = shareEntry(name);
  return (s.starting ||= (async () => {
    await s.stopping; // a session that arrives while the container is being removed starts a new one after it
    const args = shareRunArgs(name, share); // refuses a bad path before anything is started
    const blocked = shareBlocker(...await Promise.all([dockerSays('info'), dockerSays('version')]), share.writable); // asked each time: a share's container starts rarely, and Docker can be updated meanwhile
    if (blocked) throw new Error(blocked);
    await sweep();
    await docker(['rm', '-f', name]).catch(() => {});
    await ensureNet();
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
    // Deliberate, even while other sessions hold it: a swapped folder is served to nobody, so open sessions lose their drive.
    await removeShare(shares.get(name), name);
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
  const release = share && hold(share); // before the first await: from here on the share's container is not stopped as idle
  try {
    if (share) {
      // Never the guacd of this computer: it runs as you and follows links, so nothing would keep the server inside the folder.
      guacdPort = await ensureShare(share).catch((e) => {
        throw e.code === 'NO_DOCKER' ? new Error('A shared folder needs Docker, which is not installed: its container is what keeps the remote computer inside that one folder. Install Docker, or take the shared folder off this connection.') : e;
      });
    } else {
      await forgetDeadGuacd();
      guacdPort = await ensureGuacd();
    }
    const port = await ensureBridge();
    const host = await resolveHost(conn.host);
    const token = encryptToken({ once: ticket(release), connection: { type: conn.protocol, settings: remoteSettings({ ...conn, host }, password, cert, share), ...(guacdPort && { guacdPort }) } });
    return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  } catch (e) {
    release?.(); // no token was made, so nothing else would let go
    throw e;
  }
}

// guacd usually runs in Docker, whose DNS is only a copy of /etc/resolv.conf: no /etc/hosts, mDNS or VPN
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
  // `docker stop` waits for a `docker exec` that is still attached, and nothing here can read from one while
  // the stop below blocks: a session left open at quit held the stop up until it timed out.
  for (const p of execs) p.kill();
  execs.clear();
  quit.abort(); // Node ends the guacd process spawned with this signal
  quit = new AbortController();
  local = starting = null;
  if (names.length) try { execFileSync('docker', ['stop', '-t', '1', ...names], { timeout: 10000, stdio: 'ignore' }); } catch {}
  if (shares.size) try { execFileSync('docker', ['network', 'rm', shareNet()], { timeout: 10000, stdio: 'ignore' }); } catch {}
  bridgeServer?.close();
  bridge = bridgeServer = null;
  for (const r of relays.splice(0)) r.close();
  shares.clear();
  tickets.clear();
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
  runDir = null;
}

// ensureBridge is here for guacd.test.js alone, which sends a page's messages through the real bridge to see what comes out.
module.exports = { openRemote, remoteSettings, resolveHost, rdpFingerprint, stopGuacd, encryptToken, key, guacdTooOld, localGuacdArgs, shareRunArgs, shareName, shareNet, shareBlocker, ensureShare, sweep, verifyClient, ticket, ensureBridge };
