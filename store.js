// Connection store: one JSON file, folders are slash paths, passwords arrive pre-encrypted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ICONS, inFolder, parentOf, matches } = require('./renderer/shared.mjs');

// `ordered`: array order is the order the user chose. Only files from before drag-to-reorder lack it.
const empty = () => ({ ordered: true, folders: [], folderIcons: {}, connections: [] });

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('connections file is not a JSON object');
    const d = { ...empty(), folders: data.folders || [], folderIcons: data.folderIcons || {}, connections: data.connections || [] };
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

// What the user's agreement to a shared folder (shareOk) was about, as far as the store can see: change
// any of it and the agreement is gone for good, so changing it back does not bring an old one back.
// (main.js's share.approvalOf adds the server's certificate.)
const agreedTo = (c) => JSON.stringify([c.share?.path, c.share?.writable === true, c.protocol, c.host, c.port || null, c.username || '', c.domain || '', c.adminSession === true]);

// patch keys: username, domain, password (already encrypted). Undefined keys are left alone.
function bulkUpdate(data, filter, patch) {
  const hits = select(data, filter);
  for (const c of hits) {
    const was = agreedTo(c);
    for (const k of ['username', 'domain', 'password']) if (patch[k] !== undefined) c[k] = patch[k];
    if (agreedTo(c) !== was) delete c.shareOk; // the folder would now go to another account
  }
  return hits.length;
}

function upsert(data, input) {
  // shareOk is never taken from what is being saved: only main.js records an agreement, on the saved connection itself.
  const { copyPasswordFrom, shareOk, ...conn } = input;
  // Saved commands come from the page: keep only well-formed ones.
  if (conn.commands !== undefined) {
    conn.commands = (Array.isArray(conn.commands) ? conn.commands : [])
      .filter((x) => typeof x?.name === 'string' && typeof x.cmd === 'string' && x.name.trim() && x.cmd.trim())
      .map((x) => ({ name: x.name.trim(), cmd: x.cmd.trim(), onStart: x.onStart === true }));
  }
  // A shared folder comes from the page too: keep a well-formed one, and anything else (null, '') removes it.
  // Whether that folder may be shared at all is main.js's question (share.js); `writable` must be said outright.
  if (conn.share !== undefined) {
    const s = conn.share;
    conn.share = typeof s?.path === 'string' && s.path.trim() ? { path: s.path, writable: s.writable === true } : undefined; // the path as main.js checked it
  }
  if (copyPasswordFrom && !conn.id && conn.password === undefined) { // new connections only
    const src = data.connections.find((c) => c.id === copyPasswordFrom);
    if (src?.password) conn.password = src.password; // copied still encrypted: never decrypted on the way
  }
  if (!conn.id) conn.id = crypto.randomUUID();
  const i = data.connections.findIndex((c) => c.id === conn.id);
  const was = i >= 0 ? agreedTo(data.connections[i]) : null;
  if (i >= 0) data.connections[i] = { ...data.connections[i], ...conn };
  else data.connections.push(conn);
  const saved = data.connections[i >= 0 ? i : data.connections.length - 1];
  // Only RDP has drives. A connection changed to another type loses its share, and the user's agreement with it.
  if (saved.protocol !== 'rdp' || !saved.share) delete saved.share;
  if (!saved.share || agreedTo(saved) !== was) delete saved.shareOk;
  fillFolders(data);
  return conn;
}

function remove(data, id) {
  data.connections = data.connections.filter((c) => c.id !== id);
}

module.exports = { load, save, matches, select, bulkUpdate, upsert, remove, addFolder, removeFolder, moveConn, moveFolder, setFolderIcon };
