// Shared folders: which folders an RDP connection may share, and what the user has agreed to.
// Pure rules, no Electron: main.js asks them, share.test.js checks them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Is `p` the folder `dir` or somewhere under it? Both are real, absolute paths.
const within = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// Not places files are kept: devices, kernel views, system settings, other programs' sockets.
// /run/media stays allowed: it is where some systems mount USB drives.
const SYSTEM = ['/proc', '/sys', '/dev', '/etc', '/boot', '/root', '/run'];

// Looks at a folder once and answers with what was seen: { path: where it really is, dev, ino: which
// folder that is on disk }, or an error saying why it may not be shared.
// home: the user's home folder, or several (see main.js). keep: folders no share may hold or lie in (the app's own data).
//
// The folder is opened first and everything is asked of the open folder, not of the path again: its
// real path (links followed) is what the rules judge, and its device and inode numbers are what
// guacd.js later compares with the folder Docker mounted. A path looked up twice can lead to two places.
function pin(input, { home = os.homedir(), keep = [] } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('Choose the folder to share by its full path, starting with /');
  const no = (why) => new Error(`${input} cannot be shared: ${why}`);
  let fd;
  try { fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); } catch (e) {
    throw no({ ENOENT: 'it does not exist', ENOTDIR: 'it is not a folder', EACCES: 'you are not allowed to open it' }[e.code] || e.message);
  }
  let folder, st;
  try {
    folder = fs.readlinkSync(`/proc/self/fd/${fd}`); // the kernel's own name for what was opened
    st = fs.fstatSync(fd, { bigint: true }); // bigint: inode numbers can be larger than a JavaScript number holds exactly
  } finally { fs.closeSync(fd); }
  if (!path.isAbsolute(folder)) throw no('its real location could not be worked out');
  // guacd.js refuses these too; said here in words a person who chose a folder can act on.
  if (/[,"\x00-\x1f\x7f]/.test(folder) || folder !== folder.trim()) throw no('its path has a comma, a quote, a control character or a space at either end, which Docker cannot mount');
  const homes = [...new Set([].concat(home).filter(Boolean).map(real))];
  // Covers /, /home and the home folder itself: with them would go your keys, settings and saved logins.
  if (homes.some((h) => within(h, folder))) throw no('it holds your whole home folder. Share one folder inside it instead');
  if (folder.split('/').length < 3) throw no('it is a top-level folder. Share a folder inside it instead');
  if (SYSTEM.some((s) => within(folder, s) && !homes.some((h) => within(h, s))) && !within(folder, '/run/media')) throw no('it is a system folder'); // root's own home is /root
  for (const h of homes) {
    if (!within(folder, h)) continue;
    const parts = path.relative(h, folder).split(path.sep);
    // Hidden folders in the home folder are where keys and settings live: ~/.ssh, ~/.gnupg, ~/.config, ~/.mozilla ...
    if (parts.some((part) => part.startsWith('.'))) throw no('it is inside a hidden folder of your home folder, where keys and settings are kept');
    // ~/snap is not hidden but holds the same things: snap programs keep their settings there (Firefox's logins, for one).
    if (parts[0] === 'snap') throw no('~/snap is where snap programs keep their settings and saved logins');
  }
  for (const k of keep.map(real)) if (within(folder, k) || within(k, folder)) throw no("it holds banana-phone's own files");
  return { path: folder, dev: String(st.dev), ino: String(st.ino) };
}
// Only the answer to "may it be shared, and where is it really": for saving and for the folder dialog.
const checkFolder = (input, rules) => pin(input, rules).path;

// What a share's approval stands for: this folder, shared this way, with this account on the server
// at this address showing this certificate. Change any of them and the user is asked again.
function approvalOf(conn, fingerprint) {
  const { path: folder, writable } = conn.share;
  return crypto.createHash('sha256').update(JSON.stringify([
    folder, writable === true, conn.host, conn.port || 3389, conn.username || '', conn.domain || '', conn.adminSession === true, fingerprint,
  ])).digest('hex');
}

module.exports = { pin, checkFolder, approvalOf };
