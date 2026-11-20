// Connection store: one JSON file, folders are slash paths, passwords arrive pre-encrypted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const empty = () => ({ folders: [], connections: [] });

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('connections file is not a JSON object');
    return { folders: data.folders || [], connections: data.connections || [] };
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

function upsert(data, conn) {
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

module.exports = { load, save, matches, select, bulkUpdate, upsert, remove, inFolder };
