// Connection store: one JSON file, folders are slash paths, passwords arrive pre-encrypted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ICONS, inFolder, parentOf, matches, account, clipboardWord, gatewayPort, gatewayWho } = require('./renderer/shared.mjs');

// `ordered`: array order is the order the user chose. Only files from before drag-to-reorder lack it.
const empty = () => ({ ordered: true, folders: [], folderIcons: {}, connections: [] });

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('connections file is not a JSON object');
    const d = { ...empty(), folders: data.folders || [], folderIcons: data.folderIcons || {}, connections: (data.connections || []).map(manyShares) };
    fillFolders(d);
    if (!data.ordered) { // an old file: start from the alphabetical order the sidebar used to show
      d.folders.sort((a, b) => a.localeCompare(b));
      d.connections.sort((a, b) => a.name.localeCompare(b.name));
    }
    return d;
  } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw e; // a corrupt file must not be silently replaced with an empty one
  }
}

// Shared folders as they are kept: only well-formed entries, `writable` only when said outright.
const tidyShares = (list) => (Array.isArray(list) ? list : [])
  .filter((s) => typeof s?.path === 'string' && s.path.trim())
  .map((s) => ({ path: s.path, writable: s.writable === true }));
// A connection used to share one folder (`share`) and now shares a list (`shares`): an old one becomes a list of one.
// Its agreement was for the old form and is not carried over, so the user is asked once more.
// The file can be edited by hand, so a list read from it is tidied like one the page sends, and an empty one is no list.
const manyShares = ({ share, shares = share ? [share] : [], ...c }) => { const list = tidyShares(shares); return list.length ? { ...c, shares: list } : c; };

// backup: true writes file.bak, a string writes to that path.
function save(file, data, { backup = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file)) fs.copyFileSync(file, typeof backup === 'string' ? backup : file + '.bak');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Every folder is listed: parents of "a/b/c" and folders only a connection mentions too, so each has a
// place in the order. Everything that adds a folder calls this.
function fillFolders(data) {
  const set = new Set(data.folders);
  for (const f of [...data.folders, ...data.connections.map((c) => c.folder).filter(Boolean)]) {
    const parts = f.split('/');
    parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/')));
  }
  data.folders = [...set];
}

function addFolder(data, f) {
  if (!f) return;
  data.folders.push(f);
  fillFolders(data);
}

function removeFolder(data, f) {
  if (data.connections.some((c) => inFolder(c.folder, f))) throw new Error('Only empty folders can be deleted');
  data.folders = data.folders.filter((x) => !inFolder(x, f));
  for (const k of Object.keys(data.folderIcons)) if (inFolder(k, f)) delete data.folderIcons[k];
}

// The only place a folder path is rewritten: the folder, its subfolders, their connections and their icons.
function renameFolder(data, from, to) {
  const re = (f) => (inFolder(f, from) ? to + f.slice(from.length) : f);
  data.folders = data.folders.map(re);
  for (const c of data.connections) if (c.folder) c.folder = re(c.folder);
  data.folderIcons = Object.fromEntries(Object.entries(data.folderIcons).map(([k, v]) => [re(k), v]));
}

// Array order is the saved order. Move a connection into folder `to` ('' = top level), before connection `before` (default: last).
function moveConn(data, id, to, before) {
  const i = data.connections.findIndex((c) => c.id === id);
  if (i < 0 || before === id) return;
  const [c] = data.connections.splice(i, 1);
  if (to) c.folder = to; else delete c.folder;
  const j = before ? data.connections.findIndex((x) => x.id === before) : -1;
  data.connections.splice(j < 0 ? data.connections.length : j, 0, c);
  fillFolders(data);
}

// Move folder `from` (with everything under it) into folder `to` ('' = top level), before sibling folder
// path `before` (default: last). Returns its new path.
function moveFolder(data, from, to, before) {
  const dest = (to ? to + '/' : '') + from.split('/').pop();
  if (!data.folders.includes(from)) throw new Error('No such folder');
  if (to && !data.folders.includes(to)) throw new Error('No such folder');
  if (to && inFolder(to, from)) throw new Error('A folder cannot go inside itself');
  if (dest !== from && data.folders.includes(dest)) throw new Error(`"${dest}" already exists`);
  if (before && inFolder(before, from)) return dest;
  renameFolder(data, from, dest);
  const moved = data.folders.filter((f) => inFolder(f, dest));
  data.folders = data.folders.filter((f) => !inFolder(f, dest));
  const j = before ? data.folders.indexOf(before) : -1;
  data.folders.splice(j < 0 ? data.folders.length : j, 0, ...moved);
  return dest;
}

function setFolderIcon(data, folder, name) {
  if (!ICONS.includes(name)) throw new Error(`Unknown folder icon: ${name}`);
  if (!data.folders.includes(folder)) throw new Error('No such folder');
  data.folderIcons[folder] = name;
}

// filter: { username } or { folder }; ids (optional) narrows to what the user ticked.
function select(data, filter) {
  return data.connections.filter((c) => {
    if (filter.ids && !filter.ids.includes(c.id)) return false;
    if (filter.username != null) return (c.username || '') === filter.username;
    if (filter.folder != null) return inFolder(c.folder, filter.folder);
    return false;
  });
}

// An RDP connection may go through a Remote Desktop Gateway. These are kept only while it names one.
// GATEWAY_ID is what says which gateway, which account there and which server behind it; the password is the rest.
const GATEWAY_ID = ['gatewayHost', 'gatewayPort', 'gatewayUsername', 'gatewayDomain', 'serverFingerprint'];
const GATEWAY = [...GATEWAY_ID, 'gatewayPassword'];

// A SHA-256 certificate fingerprint as a person pastes it (colons, spaces, either case, a "sha256:" in
// front), as it is kept: "AB:CD:…". Nothing given is none; anything else that is not one is refused.
function fingerprint(s) {
  if (s == null || s === '') return undefined;
  const hex = String(s).replace(/^\s*sha-?256\s*:?/i, '').replace(/[\s:]/g, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("The server's fingerprint must be the SHA-256 of its certificate: 64 letters and digits (0-9, A-F). Windows shows a shorter SHA-1 \"thumbprint\", which is not it.");
  return hex.toUpperCase().match(/../g).join(':');
}

// What the user's agreement to shared folders (shareOk) was about, as far as the store can see: change
// any of it and the agreement is gone for good, so changing it back does not bring an old one back.
// (main.js's share.approvalOf adds the server's certificate.)
const agreedTo = (c) => JSON.stringify([(c.shares || []).map((s) => [s.path, s.writable === true]), c.protocol, c.host, c.port || null, c.username || '', c.domain || '', c.adminSession === true,
  ...GATEWAY_ID.map((k) => (k === 'gatewayPort' ? gatewayPort(c) : c[k] || ''))]); // no port said and 443 are one gateway

// patch keys: username, domain, password (already encrypted). Undefined keys are left alone.
function bulkUpdate(data, filter, patch) {
  const hits = select(data, filter);
  for (const c of hits) {
    const was = agreedTo(c);
    for (const k of ['username', 'domain', 'password']) if (patch[k] !== undefined) c[k] = patch[k];
    if (agreedTo(c) !== was) delete c.shareOk; // the folders would now go to another account
  }
  return hits.length;
}

function upsert(data, input) {
  // shareOk is never taken from what is being saved: only main.js records an agreement, on the saved connection itself.
  const { copyPasswordFrom, shareOk, share, ...conn } = input; // `share` is the old single-folder form: only load() reads it
  // Saved commands come from the page: keep only well-formed ones.
  if (conn.commands !== undefined) {
    conn.commands = (Array.isArray(conn.commands) ? conn.commands : [])
      .filter((x) => typeof x?.name === 'string' && typeof x.cmd === 'string' && x.name.trim() && x.cmd.trim())
      .map((x) => ({ name: x.name.trim(), cmd: x.cmd.trim(), onStart: x.onStart === true }));
  }
  // Shared folders come from the page too: keep the well-formed ones, and none left (or null, '') removes the list.
  // Whether those folders may be shared at all is main.js's question (share.js); `writable` must be said outright.
  if (conn.shares !== undefined) {
    conn.shares = tidyShares(conn.shares); // each path as main.js let it through
    if (!conn.shares.length) conn.shares = undefined;
  }
  // Clipboard sharing (RDP and VNC) comes from the page too: one of the known words, and anything else shares nothing.
  if (conn.clipboard !== undefined) conn.clipboard = clipboardWord(conn.clipboard); // undefined = keep what is saved
  // So does the gateway: text or nothing, a port that is one, and the server's fingerprint in one form.
  for (const k of ['gatewayHost', 'gatewayUsername', 'gatewayDomain']) if (conn[k] !== undefined) conn[k] = typeof conn[k] === 'string' ? conn[k].trim() : '';
  if (conn.gatewayPort !== undefined) conn.gatewayPort = Number.isInteger(conn.gatewayPort) && conn.gatewayPort > 0 && conn.gatewayPort < 65536 ? conn.gatewayPort : undefined;
  if (conn.serverFingerprint !== undefined) conn.serverFingerprint = fingerprint(conn.serverFingerprint);
  if (copyPasswordFrom && !conn.id) { // new connections only
    const src = data.connections.find((c) => c.id === copyPasswordFrom);
    // Copied still encrypted, never decrypted on the way, and only to the server and account it was saved for.
    if (src?.password && conn.password === undefined && account(src) === account(conn)) conn.password = src.password;
    // The gateway's goes along only to the same gateway and account: a copy pointed elsewhere must not take it there.
    if (src?.gatewayPassword && conn.gatewayPassword === undefined && gatewayWho(conn) === gatewayWho(src)) conn.gatewayPassword = src.gatewayPassword;
  }
  if (!conn.id) conn.id = crypto.randomUUID();
  const i = data.connections.findIndex((c) => c.id === conn.id);
  const old = i >= 0 ? data.connections[i] : undefined;
  const was = old && agreedTo(old);
  if (old) data.connections[i] = { ...old, ...conn };
  else data.connections.push(conn);
  const saved = data.connections[old ? i : data.connections.length - 1];
  // Only RDP has drives. A connection changed to another type loses its shares.
  if (saved.protocol !== 'rdp' || !saved.shares) delete saved.shares;
  // The page saves connections freely, so what was given for one server or account does not follow the
  // connection to another: neither the saved password (unless one came with this save, for the new server:
  // it must never be sent to a server of the page's choosing) nor the user's agreement to its shared folders.
  if (old && conn.password === undefined && account(saved) !== account(old)) delete saved.password;
  // The same for the gateway's password: given for one gateway and one account there (gatewayWho).
  if (old && conn.gatewayPassword === undefined && gatewayWho(saved) !== gatewayWho(old)) delete saved.gatewayPassword;
  // A gateway is kept only on RDP while one is named. Without one, nothing of it is kept: not its password, not the fingerprint.
  if (saved.protocol !== 'rdp' || !saved.gatewayHost) for (const k of GATEWAY) delete saved[k];
  if (!saved.shares || agreedTo(saved) !== was) delete saved.shareOk;
  fillFolders(data);
  return conn;
}

function remove(data, id) {
  data.connections = data.connections.filter((c) => c.id !== id);
}

module.exports = { load, save, matches, select, fingerprint, gatewayPort, bulkUpdate, upsert, remove, addFolder, removeFolder, moveConn, moveFolder, setFolderIcon };
