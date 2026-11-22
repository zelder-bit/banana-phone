// Connection store: one JSON file, folders are slash paths, passwords arrive pre-encrypted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const empty = () => ({ folders: [], folderIcons: {}, connections: [] });

const FOLDER_ICONS = ['apple', 'banana', 'coconut', 'grapes', 'kiwi', 'lemon', 'orange', 'orange-slice', 'peach', 'strawberry', 'watermelon'];

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('connections file is not a JSON object');
    const d = { ordered: !!data.ordered, folders: data.folders || [], folderIcons: data.folderIcons || {}, connections: data.connections || [] };
    fillFolders(d);
    if (!d.ordered) { // files from before drag-to-reorder: start from the alphabetical order the sidebar used to show
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

const inFolder = (folder, f) => folder === f || (folder || '').startsWith(f + '/');

// Make every folder explicit (parents of "a/b/c", folders only a connection mentions) so each has a place in the order.
function fillFolders(data) {
  const set = new Set(data.folders);
  for (const f of [...data.folders, ...data.connections.map((c) => c.folder).filter(Boolean)]) {
    const parts = f.split('/');
    parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/')));
  }
  data.folders = [...set];
}

// Array order is the saved order. Move a connection into folder `to` ('' = top level), before connection `before` (default: last).
function moveConn(data, id, to, before) {
  const i = data.connections.findIndex((c) => c.id === id);
  if (i < 0 || before === id) return;
  const [c] = data.connections.splice(i, 1);
  if (to) c.folder = to; else delete c.folder;
  const j = before ? data.connections.findIndex((x) => x.id === before) : -1;
  data.connections.splice(j < 0 ? data.connections.length : j, 0, c);
  data.ordered = true;
  fillFolders(data);
}

// Move folder `from` (with everything under it) into folder `to` ('' = top level), before sibling folder path `before` (default: last).
function moveFolder(data, from, to, before) {
  fillFolders(data);
  const name = from.split('/').pop();
  const dest = to ? `${to}/${name}` : name;
  if (!data.folders.includes(from)) throw new Error('No such folder');
  if (to && !data.folders.includes(to)) throw new Error('No such folder');
  if (to && inFolder(to, from)) throw new Error('A folder cannot go inside itself');
  if (dest !== from && data.folders.includes(dest)) throw new Error(`"${dest}" already exists`);
  if (before && inFolder(before, from)) return dest;
  const rename = (f) => dest + f.slice(from.length);
  const moved = data.folders.filter((f) => inFolder(f, from)).map(rename);
  data.folders = data.folders.filter((f) => !inFolder(f, from));
  const j = before ? data.folders.indexOf(before) : -1;
  data.folders.splice(j < 0 ? data.folders.length : j, 0, ...moved);
  for (const c of data.connections) if (inFolder(c.folder, from)) c.folder = rename(c.folder);
  if (dest !== from) moveFolderIcons(data, from, dest);
  data.ordered = true;
  return dest;
}

function setFolderIcon(data, folder, name) {
  if (!FOLDER_ICONS.includes(name)) throw new Error(`Unknown folder icon: ${name}`);
  data.folderIcons[folder] = name;
}

// Call when a folder path changes ("a" -> "b"); subfolders follow. Drop with to = null.
function moveFolderIcons(data, from, to) {
  for (const k of Object.keys(data.folderIcons)) {
    if (!inFolder(k, from)) continue;
    const icon = data.folderIcons[k];
    delete data.folderIcons[k];
    if (to != null) data.folderIcons[to + k.slice(from.length)] = icon;
  }
}

function matches(conn, q) {
  q = q.trim().toLowerCase();
  if (!q) return true;
  const hay = [conn.name, conn.host, conn.username, conn.domain, conn.folder, conn.protocol, ...(conn.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
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

// patch keys: username, domain, password (already encrypted). Undefined keys are left alone.
function bulkUpdate(data, filter, patch) {
  const hits = select(data, filter);
  for (const c of hits) {
    for (const k of ['username', 'domain', 'password']) if (patch[k] !== undefined) c[k] = patch[k];
  }
  return hits.length;
}

function upsert(data, input) {
  const { copyPasswordFrom, ...conn } = input;
  if (copyPasswordFrom && !conn.id && conn.password === undefined) { // new connections only
    const src = data.connections.find((c) => c.id === copyPasswordFrom);
    if (src?.password) conn.password = src.password; // copied still encrypted: never decrypted on the way
  }
  if (!conn.id) conn.id = crypto.randomUUID();
  const i = data.connections.findIndex((c) => c.id === conn.id);
  if (i >= 0) data.connections[i] = { ...data.connections[i], ...conn };
  else data.connections.push(conn);
  if (conn.folder && !data.folders.includes(conn.folder)) data.folders.push(conn.folder);
  return conn;
}

function remove(data, id) {
  data.connections = data.connections.filter((c) => c.id !== id);
}

module.exports = { load, save, matches, select, bulkUpdate, upsert, remove, inFolder, moveConn, moveFolder, FOLDER_ICONS, setFolderIcon, moveFolderIcons };
