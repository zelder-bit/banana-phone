const { app, BrowserWindow, ipcMain, safeStorage, Menu, dialog, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const pty = require('node-pty');
const store = require('./store');
const guacd = require('./guacd');

const dir = app.getPath('userData'); // ~/.config/banana-phone
const FILE = path.join(dir, 'connections.json');
const HOSTS = path.join(dir, 'known_hosts.json');

// One instance only: each holds connections.json in memory and rewrites it whole.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

let win;
let data;
const sessions = new Map(); // id -> { write, resize, close }

const enc = (s) => (s ? safeStorage.encryptString(s).toString('base64') : '');
const dec = (s) => {
  if (!s) return '';
  try { return safeStorage.decryptString(Buffer.from(s, 'base64')); }
  catch { throw new Error('Could not unlock the saved password: the system keyring is locked or unavailable. Unlock it, or edit the connection and enter the password again.'); }
};

// Renderer never sees passwords, only whether one is stored.
const publicView = () => ({
  folders: data.folders,
  connections: data.connections.map(({ password, ...c }) => ({ ...c, hasPassword: !!password })),
  keyring: safeStorage.getSelectedStorageBackend?.() || 'unknown',
});
const persist = (backup) => store.save(FILE, data, { backup });
// Bulk edits get their own timestamped backup so a later delete cannot overwrite it.
const bulkBackup = () => `${FILE}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
const send = (ch, ...args) => win && !win.isDestroyed() && win.webContents.send(ch, ...args);

ipcMain.handle('store:get', () => publicView());

ipcMain.handle('store:save', (_e, conn) => {
  const { password, ...rest } = conn;
  if (password !== undefined) rest.password = enc(password); // undefined = keep existing
  store.upsert(data, rest);
  persist(false);
  return publicView();
});

ipcMain.handle('store:delete', (_e, id) => { store.remove(data, id); persist(true); return publicView(); });

ipcMain.handle('store:folder', (_e, { add, remove }) => {
  if (add && !data.folders.includes(add)) data.folders.push(add);
  if (remove) {
    if (data.connections.some((c) => store.inFolder(c.folder, remove))) throw new Error('Folder is not empty');
    data.folders = data.folders.filter((f) => !store.inFolder(f, remove));
  }
  persist(false);
  return publicView();
});

// { conn: id } or { folder: path }, plus `to` (target folder, '' = top level) and optional `before` (sibling to land in front of).
ipcMain.handle('store:move', (_e, { conn, folder, to, before }) => {
  if (conn) store.moveConn(data, conn, to, before);
  else store.moveFolder(data, folder, to, before);
  persist(false);
  return publicView();
});

ipcMain.handle('store:bulkPreview', (_e, filter) => store.select(data, filter).map((c) => ({ id: c.id, name: c.name, host: c.host, folder: c.folder, username: c.username })));

ipcMain.handle('store:bulkApply', (_e, filter, patch) => {
  const p = {};
  if (patch.username) p.username = patch.username;
  if (patch.domain !== undefined && patch.domain !== null) p.domain = patch.domain;
  if (patch.clearPassword) p.password = '';
  else if (patch.password) p.password = enc(patch.password);
  const n = store.bulkUpdate(data, filter, p);
  persist(bulkBackup());
  return { count: n, view: publicView() };
});

// ---- sessions ---------------------------------------------------------------

// An unreadable file must not count as "no hosts known": that would silently re-trust every server.
function knownHosts() {
  try { return JSON.parse(fs.readFileSync(HOSTS, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${HOSTS} is unreadable (${e.message}); fix or delete it to trust servers anew`);
  }
}
const saveHosts = (hosts) => store.save(HOSTS, hosts); // atomic write, mode 600

// Trust on first use, for SSH host keys and RDP certificates alike. Returns the fingerprint saved
// before this call: undefined the first time (fp is saved now), equal to fp if unchanged.
function trust(id, fp) {
  const hosts = knownHosts();
  const saved = hosts[id];
  if (!saved) { hosts[id] = fp; saveHosts(hosts); }
  return saved;
}
// A known server now shows a different key or certificate. Ask, with Cancel as the default (Enter and
// Esc both refuse); Trust replaces the saved fingerprint. Resolves true when trusted.
async function confirmChanged(id, what, host, saved, fp) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: `${host}: ${what} changed`,
    message: `The ${what} of ${host} has changed since you last connected.`,
    detail: 'This is expected after the server is reinstalled or its certificate is renewed. It can also mean '
      + 'someone is impersonating the server to capture your password. Only trust it if you expected the change.'
      + `\n\nSaved fingerprint (SHA256):\n${saved}\n\nNew fingerprint (SHA256):\n${fp}`,
    buttons: ['Cancel', `Trust the new ${what}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return false;
  const hosts = knownHosts();
  hosts[id] = fp;
  saveHosts(hosts);
  return true;
}

const sshId = (c) => `${c.host}:${c.port || 22}`;
const rdpId = (c) => `rdp ${c.host}:${c.port || 3389}`;

// For a renewed certificate or reinstalled server: forget what was saved so the next connect saves it anew.
ipcMain.handle('store:forgetHost', (_e, connId) => {
  const c = data.connections.find((x) => x.id === connId);
  if (!c) return false;
  const hosts = knownHosts();
  const id = c.protocol === 'rdp' ? rdpId(c) : sshId(c);
  if (!(id in hosts)) return false;
  delete hosts[id];
  saveHosts(hosts);
  return true;
});

function openSsh(id, conn, cols, rows) {
  const client = new Client();
  let stream;
  const out = (s) => send('session:data', id, s);
  const hostId = sshId(conn);
  const password = dec(conn.password);

  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', cols, rows }, (err, s) => {
      if (err) { out(`\r\n${err.message}\r\n`); return client.end(); }
      stream = s;
      s.on('data', (d) => out(d.toString('utf8')));
      s.stderr.on('data', (d) => out(d.toString('utf8')));
      s.on('close', () => { client.end(); });
    });
  });
  // With a key file the stored secret is its passphrase, so it must never go to the server.
  client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(privateKey ? [] : prompts.map(() => password)));
  client.on('error', (e) => out(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`));
  client.on('close', () => { sessions.delete(id); send('session:exit', id); });

  let privateKey;
  if (conn.keyPath) {
    try { privateKey = fs.readFileSync(conn.keyPath.replace(/^~(?=\/)/, os.homedir())); }
    catch (e) { throw new Error(`Could not read key ${conn.keyPath}: ${e.message}`); }
  }
  client.connect({
    host: conn.host, port: conn.port || 22, username: conn.username || os.userInfo().username,
    password: privateKey ? undefined : password || undefined, privateKey, passphrase: privateKey ? password || undefined : undefined,
    agent: process.env.SSH_AUTH_SOCK, tryKeyboard: !privateKey, readyTimeout: 20000,
    hostHash: 'sha256',
    // Trust on first use; if a known host's key changes, ask. ssh2 waits until verify() is called.
    hostVerifier: (fp, verify) => {
      let saved;
      try { saved = trust(hostId, fp); } catch (e) { out(`\x1b[31m${e.message}\x1b[0m\r\n`); return verify(false); }
      if (!saved) out(`\x1b[33mNew host key for ${hostId} saved (SHA256 ${fp}).\x1b[0m\r\n`);
      if (!saved || saved === fp) return verify(true);
      out(`\x1b[31mThe host key of ${hostId} has CHANGED.\r\nSaved ${saved}\r\nNow   ${fp}\x1b[0m\r\n`
        + 'Waiting for your answer in the dialog. After 20 seconds the connection gives up, but a key you trust is still saved: open it again.\r\n');
      confirmChanged(hostId, 'host key', hostId, saved, fp).then((ok) => {
        out(ok ? '\x1b[33mTrusted the new host key.\x1b[0m\r\n' : '\x1b[31mNot trusted: connection refused.\x1b[0m\r\n');
        try { verify(ok); } catch {} // the connection may have timed out or been closed meanwhile
      }, () => { try { verify(false); } catch {} });
    },
  });
  return {
    write: (d) => stream?.write(d),
    resize: (c, r) => stream?.setWindow(r, c, 0, 0),
    close: () => client.end(),
  };
}

// The AppImage launcher adds its own variables; keep them out of the user's shell.
function shellEnv() {
  const env = { ...process.env };
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'GDK_BACKEND', 'ELECTRON_RUN_AS_NODE', 'ORIGINAL_XDG_CURRENT_DESKTOP']) delete env[k];
  if (process.env.APPDIR) for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS']) {
    if (env[k]) env[k] = env[k].split(':').filter((d) => d && !d.startsWith(process.env.APPDIR)).join(':');
  }
  return env;
}

function openLocal(id, cols, rows) {
  const shell = process.env.SHELL || '/bin/bash';
  const p = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: shellEnv() });
  p.onData((d) => send('session:data', id, d));
  p.onExit(() => { sessions.delete(id); send('session:exit', id); });
  return { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), close: () => p.kill() };
}

ipcMain.handle('session:open', async (_e, connId, cols = 80, rows = 24) => {
  const conn = connId === 'local' ? { protocol: 'local' } : data.connections.find((c) => c.id === connId);
  if (!conn) throw new Error('Connection not found');
  if (conn.protocol === 'rdp') {
    // Check the server's identity ourselves first (clear errors, trust on first use);
    // guacd then accepts only that exact certificate on its own connection.
    const cert = await guacd.rdpFingerprint(conn.host, conn.port || 3389);
    const fp = cert.fingerprint;
    const saved = trust(rdpId(conn), fp);
    if (saved && saved !== fp && !(await confirmChanged(rdpId(conn), 'certificate', `${conn.host}:${conn.port || 3389}`, saved, fp))) {
      throw new Error(`The certificate of ${conn.host} has changed and was not trusted, so banana-phone did not connect. Expected SHA256 ${saved}, got ${fp}.`);
    }
    const notice = !saved ? `Saved the certificate of ${conn.host}: SHA256 ${fp}`
      : saved !== fp ? `Trusted the new certificate of ${conn.host}: SHA256 ${fp}` : undefined;
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password), cert), notice };
  }
  if (conn.protocol === 'vnc') {
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password)) };
  }
  const id = crypto.randomUUID();
  sessions.set(id, conn.protocol === 'ssh' ? openSsh(id, conn, cols, rows) : openLocal(id, cols, rows));
  return { kind: 'term', id };
});

ipcMain.on('session:write', (_e, id, d) => sessions.get(id)?.write(d));
ipcMain.on('session:resize', (_e, id, c, r) => sessions.get(id)?.resize(c, r));
ipcMain.on('session:close', (_e, id) => sessions.get(id)?.close());

// ---- clipboard (text only, shared with remote desktops) ----------------------

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text) => { if (typeof text === 'string') clipboard.writeText(text); });

// ---- app --------------------------------------------------------------------

app.whenReady().then(() => {
  try { data = store.load(FILE); }
  catch (e) {
    dialog.showErrorBox('banana-phone cannot read your connections', `${FILE}\n\n${e.message}\n\nFix the file or restore it from a .bak file in the same folder, then start again.`);
    return app.exit(1);
  }
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    title: 'banana-phone',
    icon: path.join(__dirname, 'renderer/icon.png'),
    backgroundColor: '#FFF8EC',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // A reloaded page has lost its terminals, so end their shells too.
  win.webContents.on('did-start-loading', () => { for (const s of sessions.values()) s.close(); });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  // No navigation away from the app shell.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => app.quit());
// Logout / kill sends SIGTERM; route it through a normal quit so cleanup runs.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.quit());
app.on('will-quit', () => {
  for (const s of sessions.values()) s.close();
  guacd.stopGuacd();
});
