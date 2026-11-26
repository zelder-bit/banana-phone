// Pure helpers used on both sides: the renderer imports this file, store.js requires it.

// The fruit pictures in svg/ that fall behind the top bar.
export const FRUITS = ['apple', 'banana', 'coconut', 'grapes', 'kiwi', 'lemon', 'orange', 'orange-slice', 'peach', 'strawberry', 'watermelon'];
// What a folder icon may be: the default crate first, then the fruit. The crate does not fall.
export const ICONS = ['crate', ...FRUITS];

// Folders are slash paths. inFolder: is `folder` the folder `f` or somewhere under it?
export const inFolder = (folder, f) => folder === f || (folder || '').startsWith(f + '/');
// 'a/b/c' -> 'a/b'; a top-level folder -> ''.
export const parentOf = (f) => f.slice(0, Math.max(0, f.lastIndexOf('/')));

// What a saved password is for: this server and this account. Under any other, it is not sent (store.js, upsert).
export const account = (c) => JSON.stringify([c.protocol, c.host, c.port || null, c.username || '']);

// Quick search: every word of q must appear somewhere in the connection.
export function matches(conn, q) {
  q = q.trim().toLowerCase();
  if (!q) return true;
  const hay = [conn.name, conn.host, conn.username, conn.domain, conn.folder, conn.protocol, ...(conn.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

// Said in a toast when a session with a shared folder opens, and kept as the tooltip of the pane's label.
// The last sentence is there because a server that refuses redirected drives looks, from here, like any other.
// folders: every folder the session shares, [{ path, writable }], each said with what the server may do to it.
export const sharingText = (folders, host) => `Sharing ${folders.map((s) => `${s.path} (${s.writable ? 'it can change files' : 'read-only'})`).join(', ')} with ${host}. If no drive appears there, the server may be set to refuse shared drives.`;
