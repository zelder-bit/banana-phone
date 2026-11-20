const { app, BrowserWindow, ipcMain, safeStorage, Menu, dialog } = require('electron');
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

ipcMain.handle('store:bulkPreview', (_e, filter) => store.select(data, filter).map((c) => ({ id: c.id, name: c.name, host: c.host, folder: c.folder, username: c.username })));

ipcMain.handle('store:bulkApply', (_e, filter, patch) => {
  const p = {};
  if (patch.username) p.username = patch.username;
  if (patch.domain !== undefined && patch.domain !== null) p.domain = patch.domain;
  if (patch.password) p.password = enc(patch.password);
  const n = store.bulkUpdate(data, filter, p);
  persist(bulkBackup());
  return { count: n, view: publicView() };
});

// ---- sessions ---------------------------------------------------------------

function knownHosts() {
  try { return JSON.parse(fs.readFileSync(HOSTS, 'utf8')); } catch { return {}; }
}

function openSsh(id, conn, cols, rows) {
  const client = new Client();
  let stream;
  const out = (s) => send('session:data', id, s);
  const hostId = `${conn.host}:${conn.port || 22}`;
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
    // Trust on first use; refuse if a known host's key changes.
    hostVerifier: (fp) => {
      const hosts = knownHosts();
      if (!hosts[hostId]) {
        hosts[hostId] = fp;
        fs.writeFileSync(HOSTS, JSON.stringify(hosts, null, 2), { mode: 0o600 });
        out(`\x1b[33mNew host key for ${hostId} saved (SHA256 ${fp}).\x1b[0m\r\n`);
        return true;
      }
      if (hosts[hostId] === fp) return true;
      out(`\x1b[31mHOST KEY CHANGED for ${hostId}! Refusing to connect.\r\nExpected ${hosts[hostId]}, got ${fp}.\r\nIf this is expected, remove the entry from ${HOSTS}.\x1b[0m\r\n`);
      return false;
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
  if (conn.protocol === 'rdp' || conn.protocol === 'vnc') {
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password)) };
  }
  const id = crypto.randomUUID();
  sessions.set(id, conn.protocol === 'ssh' ? openSsh(id, conn, cols, rows) : openLocal(id, cols, rows));
  return { kind: 'term', id };
});

ipcMain.on('session:write', (_e, id, d) => sessions.get(id)?.write(d));
ipcMain.on('session:resize', (_e, id, c, r) => sessions.get(id)?.resize(c, r));
ipcMain.on('session:close', (_e, id) => sessions.get(id)?.close());

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
