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

// The real path of a folder that may be shared, or an error saying why it may not.
// home: the user's home folder. keep: folders no share may hold or lie in (the app's own data).
function checkFolder(input, { home = os.homedir(), keep = [] } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('Choose the folder to share by its full path, starting with /');
  const no = (why) => new Error(`${input} cannot be shared: ${why}`);
  let folder;
  // Links are followed first, so the rules below judge where the folder really is.
  try { folder = fs.realpathSync(input); } catch (e) { throw no(e.code === 'ENOENT' ? 'it does not exist' : e.message); }
  if (!fs.statSync(folder).isDirectory()) throw no('it is not a folder');
  // guacd.js refuses these too; said here in words a person chose a folder can act on.
  if (/[,"\x00-\x1f\x7f]/.test(folder)) throw no('its path has a comma, a quote or a control character, which Docker cannot mount');
  home = real(home);
  // Covers /, /home and the home folder itself: with them would go your keys, settings and saved logins.
  if (within(home, folder)) throw no('it holds your whole home folder. Share one folder inside it instead');
  if (folder.split('/').length < 3) throw no('it is a top-level system folder. Share a folder inside it instead');
  if (SYSTEM.some((s) => within(folder, s) && !within(home, s)) && !within(folder, '/run/media')) throw no('it is a system folder'); // root's own home is /root
  // Hidden folders in the home folder are where keys and settings live: ~/.ssh, ~/.gnupg, ~/.config, ~/.mozilla ...
  if (within(folder, home) && path.relative(home, folder).split(path.sep).some((part) => part.startsWith('.'))) {
    throw no('it is inside a hidden folder of your home folder, where keys and settings are kept');
  }
  for (const k of keep.map(real)) if (within(folder, k) || within(k, folder)) throw no("it holds banana-phone's own files");
  return folder;
}

// What a share's approval stands for: this folder, shared this way, with the server at this address
// showing this certificate. Change any of them and the user is asked again.
function approvalOf(conn, fingerprint) {
  const { path: folder, writable } = conn.share;
  return crypto.createHash('sha256').update(JSON.stringify([folder, writable === true, conn.host, conn.port || 3389, fingerprint])).digest('hex');
}

module.exports = { checkFolder, approvalOf };
