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
  connections: data.connections.map(({ password, gatewayPassword, shareOk, ...c }) => ({ ...c, hasPassword: !!password, hasGatewayPassword: !!gatewayPassword })),
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

// Which folders a saved connection may share: ones the user chose in the system's folder dialog in this
// launch (share:pick adds each here, by its real path), or ones already saved, in any connection. The folder is not
// looked at, so the answer tells the page nothing about what is on disk.
// The set only grows, folders chosen and then never saved included: each passed the folder rules, so none need forgetting.
const picked = new Set();
const mayShare = (p) => picked.has(p) || data.connections.some((c) => c.shares?.some((s) => s.path === p));

// shareOk is dropped: the page may ask for shared folders, but only the user agrees to them (shareFor, below).
change('store:save', ({ password, gatewayPassword, shareOk, ...conn }) => {
  if (password !== undefined) conn.password = enc(password); // undefined = keep existing, while it is for the same server and account
  if (gatewayPassword !== undefined) conn.gatewayPassword = enc(gatewayPassword); // the same, for a Remote Desktop Gateway and its account
  // Every folder in the list must be one the user chose, and the answer is the same whichever is not and whatever
  // is on disk. What a list must be that needs no look at the disk is asked here too; the rest waits for the connect.
  const list = Array.isArray(conn.shares) ? conn.shares : [];
  if (list.some((s) => !mayShare(s?.path))) throw new Error('Not saved: choose the shared folder with the Choose… button.');
  if (list.length) share.together(list);
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
// Through a Remote Desktop Gateway, the certificate banana-phone can read and remember is the gateway's.
const gatewayOf = (c) => (c.gatewayHost ? `${c.gatewayHost}:${store.gatewayPort(c)}` : '');
const rdpId = (c) => (c.gatewayHost ? `rdgw ${gatewayOf(c)}` : `rdp ${c.host}:${c.port || 3389}`);
// Whose certificate banana-phone reads itself before an RDP connection, and how.
//   who, label: its name in a sentence, and in the title of the "changed" dialog
//   read(): { fp: the fingerprint just read, cert: what guacd is to accept from the server, as rdpFingerprint gives it }
//   gateway(fp): only through a gateway: what guacd.openRemote needs to know about it
function identityOf(conn) {
  const gw = gatewayOf(conn);
  if (!gw) {
    return { who: conn.host, label: `${conn.host}:${conn.port || 3389}`,
      read: async () => { const cert = await guacd.rdpFingerprint(conn.host, conn.port || 3389); return { fp: cert.fingerprint, cert }; } };
  }
  // Through a gateway the server cannot be reached from here to read its certificate. The gateway's is
  // read and remembered instead, and the server's is the one the user wrote in the connection.
  if (!conn.serverFingerprint) throw new Error(`To connect through the gateway ${conn.gatewayHost}, edit the connection and fill in the server's certificate fingerprint (SHA-256).`);
  return { who: `the gateway ${conn.gatewayHost}`, label: `the gateway ${gw}`,
    // Behind a gateway, NLA only: what the server would pick cannot be asked from here, and NLA is the strictest.
    read: async () => ({ fp: await guacd.tlsFingerprint(conn.gatewayHost, store.gatewayPort(conn)), cert: { fingerprint: conn.serverFingerprint, nla: true } }),
    gateway: (fp) => ({ fingerprint: fp, password: dec(conn.gatewayPassword) }) };
}

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
// Agreements to share are signed with a key of the app's own, kept the way passwords are: encrypted by
// the system keyring. Someone who can only write files here cannot write an agreement (share.approvalOf).
// A key that cannot be read (another keyring, a file brought from another computer) is replaced, which
// ends every agreement: each share is asked about again. One that cannot be saved lasts for this launch.
const SHARE_KEY = path.join(dir, 'share-key.json');
let shareKey;
function agreementKey() {
  if (shareKey) return shareKey;
  try { shareKey = Buffer.from(dec(JSON.parse(fs.readFileSync(SHARE_KEY, 'utf8')).key), 'hex'); } catch { shareKey = null; }
  if (shareKey?.length !== 32) {
    shareKey = crypto.randomBytes(32);
    try { store.save(SHARE_KEY, { key: enc(shareKey.toString('hex')) }); } catch { /* not saved: asked again next launch */ }
  }
  return shareKey;
}

// The edit dialog's "Choose…" buttons. The page is sandboxed and cannot browse folders itself.
// What the user chose is remembered (`picked`, above) as its real path, so that what is shown, saved,
// agreed to and mounted are the same folder.
ipcMain.handle('share:pick', async (_e, from) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Folder to share with the remote computer',
    defaultPath: typeof from === 'string' && path.isAbsolute(from) ? from : os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  const folder = share.checkFolder(filePaths[0], shareRules());
  picked.add(folder);
  return folder;
});

// The folders an RDP connection shares, as guacd.openRemote wants them, or null. Every folder is checked again
// (it may have moved or been replaced since it was saved), and the user must have agreed to exactly
// this: these folders, each read-only or not, with this server showing this certificate. The agreement is
// asked here, in a system dialog, because a saved connection is not proof of it: the page writes those.
// firstSeen: the certificate was saved on this very connect, which the question then says.
async function shareFor(conn, fp, firstSeen) {
  if (!conn.shares?.length) return null; // none, or a list left empty in the file by hand: nothing is shared
  // The name in the dialog must be the name that is dialled. Lookups fold look-alike letters and invisible
  // characters ("ℓocalhost" is localhost), so a host that is not plain is not shared with at all.
  if (!/^[A-Za-z0-9.:_-]+$/.test(conn.host) || !/^[A-Za-z0-9.:_-]*$/.test(conn.gatewayHost || '')) throw new Error('To share a folder, the host must be written with plain letters, digits, dots and hyphens only (an international name in its xn-- form).');
  const folders = share.pinAll(conn.shares, shareRules());
  for (const [i, f] of folders.entries()) {
    if (f.path !== conn.shares[i].path) throw new Error(`The shared folder ${conn.shares[i].path} now leads to ${f.path}. Edit the connection and choose the folder again.`);
  }
  const ok = share.approvalOf(conn, fp, agreementKey());
  if (conn.shareOk !== ok) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      ...share.question(conn, folders, { fingerprint: fp, firstSeen }),
      buttons: ['Cancel', 'Share and connect'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) throw new Error('Did not connect: nothing was shared. To connect without sharing, edit the connection and remove its shared folders.');
    // The answer is for what the dialog said. If the connection was saved or bulk-edited meanwhile, it is not for this.
    if (data.connections.find((c) => c.id === conn.id) !== conn || share.approvalOf(conn, fp, agreementKey()) !== ok) {
      throw new Error('The connection was changed while you were being asked, so nothing was shared. Connect again.');
    }
    conn.shareOk = ok;
    persist();
  }
  return { folders, id: conn.id, server: `${conn.host}:${conn.port || 3389}` };
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
    const { who, label, read, gateway } = identityOf(conn); // the server itself, or the gateway in front of it
    const { fp, cert } = await read();
    const saved = trust(rdpId(conn), fp);
    const also = Array.isArray(conn.shares) ? `\n\nThis connection shares with the server: ${conn.shares.map((s) => share.visible(s?.path)).join(', ')}` : '';
    if (saved && saved !== fp && !(await confirmChanged(rdpId(conn), 'certificate', label, saved, fp, also))) {
      throw new Error(`The certificate of ${who} has changed and was not trusted, so banana-phone did not connect. Expected SHA256 ${saved}, got ${fp}.`);
    }
    const notice = !saved ? `Saved the certificate of ${who}: SHA256 ${fp}`
      : saved !== fp ? `Trusted the new certificate of ${who}: SHA256 ${fp}` : undefined;
    // After the identity check: the agreement is with that server. Behind a gateway the server is known by the fingerprint written down, so it is never "first seen".
    const shared = await shareFor(conn, cert.fingerprint, !gateway && !saved);
    // openRemote copies the connection before it waits for anything, so the session is the one just agreed to.
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password), cert, shared, { gateway: gateway?.(fp) }), notice, shared: shared && { folders: shared.folders.map(({ path, writable, name }) => ({ path, writable, name })) } };
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
