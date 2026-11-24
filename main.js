const { app, BrowserWindow, ipcMain, safeStorage, Menu, dialog, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const pty = require('node-pty');
const store = require('./store');
const guacd = require('./guacd');
const share = require('./share');

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
  folderIcons: data.folderIcons,
  connections: data.connections.map(({ password, shareOk, ...c }) => ({ ...c, hasPassword: !!password })),
  keyring: safeStorage.getSelectedStorageBackend?.() || 'unknown',
});
const persist = (backup) => store.save(FILE, data, { backup });
// Bulk edits get their own timestamped backup so a later delete cannot overwrite it.
const bulkBackup = () => `${FILE}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
const send = (ch, ...args) => win && !win.isDestroyed() && win.webContents.send(ch, ...args);

ipcMain.handle('store:get', () => publicView());

// Every change to the store: apply it, write the file, answer with the new view (plus the change's own result).
// backup: true keeps the old file as .bak, a function returns the path to copy it to.
const change = (channel, fn, backup = false) => ipcMain.handle(channel, (_e, ...args) => {
  const result = fn(...args);
  persist(typeof backup === 'function' ? backup() : backup);
  return { ...publicView(), result };
});

// shareOk is dropped: the page may ask for a shared folder, but only the user agrees to one (shareFor, below).
change('store:save', ({ password, shareOk, ...conn }) => {
  if (password !== undefined) conn.password = enc(password); // undefined = keep existing
  // Saved as its real path, so what is shown, agreed to and mounted are the same folder.
  if (conn.share?.path) conn.share = { ...conn.share, path: share.checkFolder(String(conn.share.path), shareRules()) };
  store.upsert(data, conn); // its return value holds the encrypted password, so it is not passed on
});
change('store:delete', (id) => store.remove(data, id), true);
change('store:addFolder', (f) => store.addFolder(data, f));
change('store:removeFolder', (f) => store.removeFolder(data, f));
change('store:folderIcon', (f, name) => store.setFolderIcon(data, f, name));
// kind: 'conn' (id) or 'folder' (path); `to` is the target folder ('' = top level), `before` the sibling to land in front of.
// A moved folder's result is its new path.
change('store:move', (kind, id, to, before) => (kind === 'conn' ? store.moveConn : store.moveFolder)(data, id, to, before));

ipcMain.handle('store:bulkPreview', (_e, filter) => store.select(data, filter).map((c) => ({ id: c.id, name: c.name, host: c.host, folder: c.folder, username: c.username })));

// result: how many connections changed.
change('store:bulkApply', (filter, patch) => {
  const p = {};
  if (patch.username) p.username = patch.username;
  if (patch.domain !== undefined && patch.domain !== null) p.domain = patch.domain;
  if (patch.clearPassword) p.password = '';
  else if (patch.password) p.password = enc(patch.password);
  return store.bulkUpdate(data, filter, p);
}, bulkBackup);

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
async function confirmChanged(id, what, host, saved, fp, also = '') {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: `${host}: ${what} changed`,
    message: `The ${what} of ${host} has changed since you last connected.`,
    detail: 'This is expected after the server is reinstalled or its certificate is renewed. It can also mean '
      + 'someone is impersonating the server to capture your password. Only trust it if you expected the change.'
      + also + `\n\nSaved fingerprint (SHA256):\n${saved}\n\nNew fingerprint (SHA256):\n${fp}`,
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

// ---- shared folders (RDP) -----------------------------------------------------

// No share may hold or lie in the app's own folder: the connections, their encrypted passwords, the trusted fingerprints.
// Two homes: the one the environment names ($HOME), and the one the system has on record, in case they differ.
const shareRules = () => ({ home: [os.homedir(), os.userInfo().homedir], keep: [dir] });
// For text in a system dialog that the page had a hand in: nothing invisible, nothing that reads right to left, no line breaks.
const plain = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 100);

// The edit dialog's "Choose…" button. The page is sandboxed and cannot browse folders itself.
ipcMain.handle('share:pick', async (_e, from) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Folder to share with the remote computer',
    defaultPath: typeof from === 'string' && path.isAbsolute(from) ? from : os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths[0] ? null : share.checkFolder(filePaths[0], shareRules());
});

// The folder an RDP connection shares, as guacd.openRemote wants it, or null. The folder is checked again
// (it may have moved or been replaced since it was saved), and the user must have agreed to exactly
// this: this folder, read-only or not, with this server showing this certificate. The agreement is
// asked here, in a system dialog, because a saved connection is not proof of it: the page writes those.
async function shareFor(conn, fp) {
  if (!conn.share) return null;
  // The name in the dialog must be the name that is dialled. Lookups fold look-alike letters and invisible
  // characters ("ℓocalhost" is localhost), so a host that is not plain is not shared with at all.
  if (!/^[A-Za-z0-9.:_-]+$/.test(conn.host)) throw new Error('To share a folder, the host must be written with plain letters, digits, dots and hyphens only (an international name in its xn-- form).');
  const pinned = share.pin(conn.share.path, shareRules());
  if (pinned.path !== conn.share.path) throw new Error(`The shared folder ${conn.share.path} now leads to ${pinned.path}. Edit the connection and choose the folder again.`);
  const writable = conn.share.writable === true;
  const ok = share.approvalOf(conn, fp);
  if (conn.shareOk !== ok) {
    const account = conn.username ? `, signed in as ${plain((conn.domain ? conn.domain + '\\' : '') + conn.username)},` : '';
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: `Share a folder with ${conn.host}`,
      message: `Share this folder with ${conn.host}?`,
      detail: `${pinned.path}\n\n`
        + (writable ? `${conn.host}${account} will be able to read, change and delete everything in this folder.`
          : `${conn.host}${account} will be able to read everything in this folder, but not change it.`)
        + ' So will any program running there.\n\nYou are asked once for this folder, this server and this account, and again if any of them changes.',
      buttons: ['Cancel', 'Share and connect'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) throw new Error('Did not connect: the folder was not shared. To connect without it, edit the connection and empty its shared folder.');
    // The answer is for what the dialog said. If the connection was saved or bulk-edited meanwhile, it is not for this.
    if (data.connections.find((c) => c.id === conn.id) !== conn || share.approvalOf(conn, fp) !== ok) {
      throw new Error('The connection was changed while you were being asked, so nothing was shared. Connect again.');
    }
    conn.shareOk = ok;
    persist();
  }
  return { ...pinned, writable, id: conn.id };
}

function openSsh(id, conn, cols, rows, start) {
  const client = new Client();
  let stream;
  const out = (s) => send('session:data', id, s);
  const hostId = sshId(conn);
  const password = dec(conn.password);

  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', cols, rows }, (err, s) => {
      if (err) { out(`\r\n${err.message}\r\n`); return client.end(); }
      stream = s;
      for (const d of start) s.write(d); // saved commands wait for the shell; keys typed before it are dropped (below)
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

function openLocal(id, cols, rows, start) {
  const shell = process.env.SHELL || '/bin/bash';
  const p = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: shellEnv() });
  for (const d of start) p.write(d); // the pty holds them until the shell reads its input
  p.onData((d) => send('session:data', id, d));
  p.onExit(() => { sessions.delete(id); send('session:exit', id); });
  return { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), close: () => p.kill() };
}

ipcMain.handle('session:open', async (_e, connId, cols = 80, rows = 24, run) => {
  const conn = connId === 'local' ? { protocol: 'local' } : data.connections.find((c) => c.id === connId);
  if (!conn) throw new Error('Connection not found');
  if (conn.protocol === 'rdp') {
    // Check the server's identity ourselves first (clear errors, trust on first use);
    // guacd then accepts only that exact certificate on its own connection.
    const cert = await guacd.rdpFingerprint(conn.host, conn.port || 3389);
    const fp = cert.fingerprint;
    const saved = trust(rdpId(conn), fp);
    const also = conn.share ? `\n\nThis connection shares the folder ${conn.share.path} with the server.` : '';
    if (saved && saved !== fp && !(await confirmChanged(rdpId(conn), 'certificate', `${conn.host}:${conn.port || 3389}`, saved, fp, also))) {
      throw new Error(`The certificate of ${conn.host} has changed and was not trusted, so banana-phone did not connect. Expected SHA256 ${saved}, got ${fp}.`);
    }
    const notice = !saved ? `Saved the certificate of ${conn.host}: SHA256 ${fp}`
      : saved !== fp ? `Trusted the new certificate of ${conn.host}: SHA256 ${fp}` : undefined;
    const shared = await shareFor(conn, fp); // after the identity check: the agreement is with that server
    // openRemote copies the connection before it waits for anything, so the session is the one just agreed to.
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password), cert, shared), notice, shared: shared && { path: shared.path, writable: shared.writable } };
  }
  if (conn.protocol === 'vnc') {
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password)) };
  }
  const id = crypto.randomUUID();
  // Typed in as soon as the shell is ready: the saved "Run on start" commands, then `run` (a saved command picked from the menu).
  const start = [...(conn.commands || []).filter((x) => x.onStart).map((x) => x.cmd), ...(typeof run === 'string' && run ? [run] : [])].map((c) => c + '\r');
  sessions.set(id, conn.protocol === 'ssh' ? openSsh(id, conn, cols, rows, start) : openLocal(id, cols, rows, start));
  return { kind: 'term', id };
});

ipcMain.on('session:write', (_e, id, d) => sessions.get(id)?.write(d));
ipcMain.on('session:resize', (_e, id, c, r) => sessions.get(id)?.resize(c, r));
ipcMain.on('session:close', (_e, id) => sessions.get(id)?.close());

// ---- window (Full screen current) --------------------------------------------

let wantFull = false; // what the page last asked for
ipcMain.on('win:fullscreen', (_e, on) => { wantFull = !!on; win?.setFullScreen(wantFull); });
ipcMain.on('win:minimize', () => win?.minimize());

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
  guacd.sweep(); // shared folders' containers left by a launch that crashed; quiet if there is no Docker
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    title: 'banana-phone',
    icon: path.join(__dirname, 'renderer/icon.png'),
    backgroundColor: '#FFF8EC',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // The window can leave full screen without the page asking (a window manager shortcut): tell the page.
  // Not when the page asked for it itself, and not when the window was only minimized.
  win.on('leave-full-screen', () => { if (wantFull && !win.isMinimized()) send('win:left-fullscreen'); });
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
