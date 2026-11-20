// Runs guacd in Docker and a guacamole-lite websocket bridge on localhost, for RDP/VNC panes.
const { execFile, execFileSync } = require('child_process');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
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

let bridge;
function ensureBridge() {
  if (bridge) return bridge;
  bridge = new Promise((resolve) => {
    const server = new GuacamoleLite(
      { host: '127.0.0.1', port: 0 },
      { host: '127.0.0.1', port: GUACD_PORT },
      { crypt: { cypher: 'AES-256-CBC', key }, log: { level: 'ERRORS' }, maxInactivityTime: 0 },
    );
    server.webSocketServer.on('listening', () => resolve(server.webSocketServer.address().port));
  });
  return bridge;
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
function rdpFingerprint(host, port) {
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
      const t = tls.connect({ socket: sock, rejectUnauthorized: false }, () => {
        const fingerprint = t.getPeerCertificate().fingerprint256;
        t.destroy();
        fingerprint ? resolve({ fingerprint, nla: (selected & 2) !== 0 }) : reject(new Error(`${host} sent no certificate`));
      });
      t.once('error', (e) => fail(`${host}: TLS failed: ${e.message}`));
    });
  });
}

// cert: required for RDP (the result of rdpFingerprint), ignored for VNC.
async function openRemote(conn, password, cert) {
  if (starting && !(await portOpen())) starting = null; // container died or Docker restarted: start again
  await ensureGuacd();
  const port = await ensureBridge();
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
  } else if (conn.username) settings.username = conn.username;
  const token = encryptToken({ connection: { type: conn.protocol, settings } });
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

// Sync so it finishes before the process exits.
function stopGuacd() {
  if (!startedHere) return;
  try { execFileSync('docker', ['stop', '-t', '1', NAME], { timeout: 10000, stdio: 'ignore' }); } catch {}
}

module.exports = { openRemote, rdpFingerprint, stopGuacd, encryptToken, key };
