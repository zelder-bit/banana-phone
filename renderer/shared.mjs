// Pure helpers used on both sides: the renderer imports this file, store.js requires it.

// The fruit pictures in svg/: what a folder icon may be, and what falls behind the top bar.
export const FRUITS = ['apple', 'banana', 'coconut', 'grapes', 'kiwi', 'lemon', 'orange', 'orange-slice', 'peach', 'strawberry', 'watermelon'];

// Folders are slash paths. inFolder: is `folder` the folder `f` or somewhere under it?
export const inFolder = (folder, f) => folder === f || (folder || '').startsWith(f + '/');
// 'a/b/c' -> 'a/b'; a top-level folder -> ''.
export const parentOf = (f) => f.slice(0, Math.max(0, f.lastIndexOf('/')));

// Quick search: every word of q must appear somewhere in the connection.
export function matches(conn, q) {
  q = q.trim().toLowerCase();
  if (!q) return true;
  const hay = [conn.name, conn.host, conn.username, conn.domain, conn.folder, conn.protocol, ...(conn.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}
