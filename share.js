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

// Folders that only a home folder has, and that hold keys and saved logins. A folder holding one of
// them is a home folder under another name: a snapshot of it, a backup, a copy.
const HOME_MARKS = ['.ssh', '.gnupg', '.mozilla', '.password-store', '.aws', '.kube'];

// The folder at `p` and every folder above it, nearest first, each as "device:inode": the two numbers
// the kernel tells folders apart by. A folder has one such pair whatever path led to it, so this is
// how a home folder is recognised when it is reached by another name (mounted in a second place).
// Each step up is ".." asked of the folder itself. The root is its own parent, which ends the climb.
function lineage(p) {
  const ids = [];
  for (let at = p; ids.length < 256; at += '/..') {
    let id;
    try { const st = fs.statSync(at, { bigint: true }); id = `${st.dev}:${st.ino}`; } catch { break; }
    if (id === ids[ids.length - 1]) break;
    ids.push(id);
  }
  return ids;
}

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
  let folder, st, above, mark;
  try {
    const open = `/proc/self/fd/${fd}`;
    folder = fs.readlinkSync(open); // the kernel's own name for what was opened
    st = fs.fstatSync(fd, { bigint: true }); // bigint: inode numbers can be larger than a JavaScript number holds exactly
    above = lineage(open); // above[0] is the folder, above[1] the folder it is in, and so on up
    mark = HOME_MARKS.find((m) => { try { return fs.lstatSync(`${open}/${m}`).isDirectory(); } catch { return false; } });
  } finally { fs.closeSync(fd); }
  if (!path.isAbsolute(folder)) throw no('its real location could not be worked out');
  // guacd.js refuses these too; said here in words a person who chose a folder can act on.
  if (/[,"\x00-\x1f\x7f]/.test(folder) || folder !== folder.trim()) throw no('its path has a comma, a quote, a control character or a space at either end, which Docker cannot mount');
  const homes = [...new Set([].concat(home).filter(Boolean).map(real))];
  const names = folder.split('/');
  // Covers /, /home and the home folder itself: with them would go your keys, settings and saved logins.
  // Asked twice: of the path, and of the folder itself, which is the home folder or holds it wherever it is mounted.
  if (homes.some((h) => within(h, folder) || lineage(h).includes(above[0]))) throw no('it holds your whole home folder. Share one folder inside it instead');
  if (names.length < 3) throw no('it is a top-level folder. Share a folder inside it instead');
  if (SYSTEM.some((s) => within(folder, s) && !homes.some((h) => within(h, s))) && !within(folder, '/run/media')) throw no('it is a system folder'); // root's own home is /root
  for (const h of homes) {
    // How many folders up the home folder is: by what it is, and failing that by its path.
    const up = above.indexOf(lineage(h)[0]);
    if (up < 1 && !within(folder, h)) continue;
    const parts = up > 0 ? names.slice(-up) : path.relative(h, folder).split(path.sep);
    // Hidden folders in the home folder are where keys and settings live: ~/.ssh, ~/.gnupg, ~/.config, ~/.mozilla ...
    if (parts.some((part) => part.startsWith('.'))) throw no('it is inside a hidden folder of your home folder, where keys and settings are kept');
    // ~/snap is not hidden but holds the same things: snap programs keep their settings there (Firefox's logins, for one).
    if (parts[0] === 'snap') throw no('~/snap is where snap programs keep their settings and saved logins');
  }
  for (const k of keep.map(real)) {
    const own = lineage(k);
    if (within(folder, k) || within(k, folder) || own.includes(above[0]) || (own[0] && above.includes(own[0]))) throw no("it holds banana-phone's own files");
  }
  if (mark) throw no(`it holds a ${mark} folder, where keys and saved logins are kept, so it looks like a copy of a home folder. Share one folder inside it instead`);
  return { path: folder, dev: String(st.dev), ino: String(st.ino) };
}
// Only the answer to "may it be shared, and where is it really": for the folder dialog.
const checkFolder = (input, rules) => pin(input, rules).path;

// A connection may share several folders, but no more than a person will read in the question.
const MOST = 8;

// With several folders the drive holds one folder for each, and these are their names there: each
// folder's own name, with what Windows does not allow in a name replaced (CON, NUL and the like are
// devices there, with or without an ending). Two that would read the same (Windows does not tell
// capitals apart) are told apart by a number: Documents, Documents (2).
function driveNames(paths) {
  const taken = new Set();
  return paths.map((p) => {
    const base = path.basename(p).replace(/[<>:"/\\|?*,\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').replace(/^(con|prn|aux|nul|com\d|lpt\d)(?=\.|$)/i, '$1_') || 'Folder';
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    taken.add(name.toLowerCase());
    return name;
  });
}

// What a list of folders ([{ path }], each path a string) must be, whatever is on disk: not too long,
// no folder in it twice, and none holding another: the same files would then be read-only by one name
// and writable by the other. Asked of the paths as they are written, so main.js can ask it when a
// connection is saved without looking at a folder. Where the folders have been identified (pinAll),
// the same folder under two paths counts as twice.
function together(folders) {
  if (folders.length > MOST) throw new Error(`A connection can share ${MOST} folders at most, and this one has ${folders.length}`);
  for (const [i, f] of folders.entries()) for (const g of folders.slice(0, i)) {
    if (g.path === f.path || (f.dev && g.dev === f.dev && g.ino === f.ino)) throw new Error(`${f.path} is in the list of shared folders twice`);
    if (within(f.path, g.path) || within(g.path, f.path)) throw new Error(`${g.path} and ${f.path} cannot both be shared: one holds the other`);
  }
}

// Every folder a connection shares ([{ path, writable }]), each through pin() on its own:
// [{ path, dev, ino, writable, name }], in the order given, and fit to be shared together.
function pinAll(shares, rules) {
  if (!Array.isArray(shares) || !shares.length) throw new Error('Choose at least one folder to share');
  const pinned = shares.map((s) => ({ ...pin(s?.path, rules), writable: s?.writable === true }));
  together(pinned);
  const names = driveNames(pinned.map((f) => f.path));
  return pinned.map((f, i) => ({ ...f, name: names[i] }));
}

// What in a folder this computer runs or obeys, for the warning on a share the server may change: a
// git repository (git runs what its settings name) and programs or scripts. Only the folder's own
// entries are looked at, and no more than a thousand: this is advice for a dialog, not a rule.
function runsFrom(folder) {
  const found = [];
  try {
    const dir = fs.opendirSync(folder);
    try {
      let entry, program = false;
      for (let seen = 0; seen < 1000 && (entry = dir.readSync()); seen++) {
        if (entry.name === '.git') found.unshift('a git repository');
        else if (!program && entry.isFile() && fs.statSync(path.join(folder, entry.name)).mode & 0o111) program = true;
      }
      if (program) found.push('programs or scripts');
    } finally { dir.closeSync(); }
  } catch { /* gone or unreadable: nothing to say about it */ }
  return found;
}

// A path as it is shown in a system dialog: characters that cannot be seen, or that change the
// direction text is read in, are written out as their code. A name with a right-to-left mark in it
// would otherwise read as another name.
const visible = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);

// For text in a system dialog that the page had a hand in: nothing invisible, nothing that reads right to left, no line breaks.
const plain = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 100);

// The words of the question main.js asks before folders are shared, for a system dialog.
// folders: what pinAll() answered, so each is named by its real path. fingerprint: the server's certificate as just read. firstSeen: that
// certificate was saved a moment ago, on this very connect, so nothing yet says the server is the one meant.
function question(conn, folders, { fingerprint, firstSeen = false } = {}) {
  const port = Number(conn.port) || 3389;
  // Two computers behind one address differ only in their port, so a port that is not the usual one is part of the name.
  const server = conn.host + (port === 3389 ? '' : `:${port}`);
  const one = folders.length === 1;
  const these = one ? 'this folder' : 'these folders';
  const writable = folders.filter((f) => f.writable === true);
  const account = conn.username ? `, signed in as ${plain((conn.domain ? conn.domain + '\\' : '') + conn.username)},` : '';
  const runs = [...new Set(writable.flatMap((f) => runsFrom(f.path)))];
  return {
    title: one ? `Share a folder with ${server}` : `Share ${folders.length} folders with ${server}`,
    message: `Share ${these} with ${server}?`,
    // Several folders: each on a line of its own, with its name in the drive and whether it can be changed.
    detail: (one ? visible(folders[0].path) : folders.map((f) => `${visible(f.path)}\n    as ${visible(f.name)}: ${f.writable === true ? 'CAN BE CHANGED' : 'read-only'}`).join('\n'))
      + '\n\n'
      + (writable.length === folders.length ? `${server}${account} will be able to read, change and delete everything in ${these}.`
        : writable.length ? `${server}${account} will be able to read everything in these folders, and to change and delete everything in ${writable.length === 1 ? 'the one' : `the ${writable.length}`} marked CAN BE CHANGED.`
        : `${server}${account} will be able to read everything in ${these}, but not change it.`)
      + ' So will any program running there.'
      + (runs.length ? `\n\n${one ? 'This folder holds' : 'What can be changed holds'} ${runs.join(' and ')}. A server that can change files here can change what this computer runs.` : '')
      + (firstSeen ? `\n\nThis is the first time banana-phone has connected to ${server}, so nothing yet confirms it is the computer you mean. If that matters, compare its certificate before you share (SHA256):\n${fingerprint}` : '')
      + `\n\nYou are asked once for ${these}, this server and this account, and again if any of them changes.`,
  };
}

// What a share's approval stands for: these folders in this order, each shared this way, with this account on the server
// at this address showing this certificate. Change any of them and the user is asked again.
// It is signed with `key`, which main.js keeps behind the system keyring: the things it covers are
// all written in files anyone running as you can change, so a plain hash of them could be worked out
// and written in beside them.
function approvalOf(conn, fingerprint, key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('An agreement to share a folder needs a key to be signed with');
  return crypto.createHmac('sha256', key).update(JSON.stringify([
    conn.shares.map((s) => [s.path, s.writable === true]), conn.host, conn.port || 3389, conn.username || '', conn.domain || '', conn.adminSession === true, fingerprint,
  ])).digest('hex');
}

module.exports = { pin, pinAll, together, driveNames, checkFolder, approvalOf, question, runsFrom, visible };
