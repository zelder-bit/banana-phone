// Runs guacd in Docker and a guacamole-lite websocket bridge on localhost, for RDP/VNC panes.
const { execFile, execFileSync } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const GuacamoleLite = require('guacamole-lite');

const NAME = 'banana-phone-guacd';
const IMAGE = 'guacamole/guacd:1.5.5'; // matches guacamole-common-js 1.5.x in the renderer
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
    const running = await docker(['inspect', '-f', '{{.State.Running}}', NAME]).catch(() => 'false');
    if (running !== 'true') {
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

async function openRemote(conn, password) {
  if (starting && !(await portOpen())) starting = null; // container died or Docker restarted: start again
  await ensureGuacd();
  const port = await ensureBridge();
  const settings = { hostname: conn.host, port: String(conn.port || (conn.protocol === 'rdp' ? 3389 : 5900)), password: password || '' };
  if (conn.protocol === 'rdp') {
    Object.assign(settings, {
      username: conn.username || '', domain: conn.domain || '',
      security: 'any',
      // shortcut: accepts any RDP certificate (typical for self-signed AD hosts); add per-connection pinning if needed.
      'ignore-cert': 'true',
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

module.exports = { openRemote, stopGuacd, encryptToken, key };
