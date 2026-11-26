const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { pin, checkFolder, approvalOf, question, runsFrom, visible } = require('./share');

// A pretend home folder: ~/Projects/acme to share, ~/.ssh and the app's own folder to keep out.
function world(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-rules-')));
  const home = path.join(root, 'home', 'user');
  const app = path.join(home, '.config', 'banana-phone');
  for (const d of ['Projects/acme', '.ssh', '.config/banana-phone', '.local/share/notes', 'Odd, name']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(root, 'elsewhere', 'appdata'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Projects', 'file.txt'), 'x');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, app, rules: { home, keep: [app] }, at: (...p) => path.join(home, ...p) };
}

test('an ordinary folder in the home folder may be shared, by its real path', (t) => {
  const w = world(t);
  assert.strictEqual(checkFolder(w.at('Projects', 'acme'), w.rules), w.at('Projects', 'acme'));
  assert.strictEqual(checkFolder(w.at('Projects', 'acme') + '/', w.rules), w.at('Projects', 'acme'));
  fs.symlinkSync(w.at('Projects', 'acme'), w.at('link-to-acme'));
  assert.strictEqual(checkFolder(w.at('link-to-acme'), w.rules), w.at('Projects', 'acme'));
});

test('folders that would give away more than they seem are refused', (t) => {
  const w = world(t);
  const no = (p, why) => assert.throws(() => checkFolder(p, w.rules), why, p);
  no(w.home, /whole home folder/);
  no(path.dirname(w.home), /whole home folder/);
  no('/', /whole home folder/);
  no(w.at('.ssh'), /hidden folder/);
  no(w.at('.local', 'share', 'notes'), /hidden folder/);
  no(w.app, /hidden folder|own files/);
  // A link does not get around a rule: the folder it leads to is what is judged.
  fs.symlinkSync(w.at('.ssh'), w.at('Projects', 'keys'));
  no(w.at('Projects', 'keys'), /hidden folder/);
  fs.symlinkSync(w.home, w.at('Projects', 'everything'));
  no(w.at('Projects', 'everything'), /whole home folder/);
  no(w.at('Projects', 'file.txt'), /not a folder/);
  no(w.at('Projects', 'gone'), /does not exist/);
  no(w.at('Odd, name'), /comma/);
  for (const p of ['/etc', '/etc/ssl', '/proc/self', '/dev', '/sys/kernel', '/run', '/usr', '/var']) no(p, /system folder|top-level folder/);
  // Not hidden, but where snap programs keep their settings and logins.
  fs.mkdirSync(w.at('snap', 'firefox', 'common'), { recursive: true });
  no(w.at('snap', 'firefox'), /snap programs/);
  no(w.at('snap'), /snap programs/);
  for (const p of ['Projects/acme', '', '~/Projects', undefined, null, 42, { path: '/tmp' }]) assert.throws(() => checkFolder(p, w.rules), /full path/, String(p));
});

test('the folder is identified as well as located, and both homes are protected', (t) => {
  const w = world(t);
  const seen = pin(w.at('Projects', 'acme'), w.rules);
  const st = fs.statSync(w.at('Projects', 'acme'), { bigint: true });
  assert.deepStrictEqual(seen, { path: w.at('Projects', 'acme'), dev: String(st.dev), ino: String(st.ino) });
  // Through a link, it is still that folder: same place, same numbers.
  fs.symlinkSync(w.at('Projects', 'acme'), w.at('via-link'));
  assert.deepStrictEqual(pin(w.at('via-link'), w.rules), seen);
  // $HOME may point somewhere else than the home folder the system has on record: neither can be shared.
  const other = path.join(w.root, 'home', 'other');
  fs.mkdirSync(path.join(other, '.ssh'), { recursive: true });
  const both = { home: [w.home, other], keep: [] };
  assert.throws(() => checkFolder(other, both), /whole home folder/);
  assert.throws(() => checkFolder(path.join(other, '.ssh'), both), /hidden folder/);
  assert.throws(() => checkFolder(w.home, both), /whole home folder/);
  assert.strictEqual(checkFolder(w.at('Projects'), both), w.at('Projects'));
});

test("the app's own folder is kept out wherever it is", (t) => {
  const w = world(t);
  const keep = [path.join(w.root, 'elsewhere', 'appdata')];
  assert.throws(() => checkFolder(keep[0], { home: w.home, keep }), /own files/);
  assert.throws(() => checkFolder(path.join(w.root, 'elsewhere'), { home: w.home, keep }), /own files/); // a folder holding it
  assert.strictEqual(checkFolder(w.at('Projects'), { home: w.home, keep }), w.at('Projects'));
});

test('a home folder is recognised by what it is, not only by where it is', (t) => {
  const w = world(t);
  // A copy of a home folder (a snapshot, a backup) has another path and is another folder on disk,
  // but it holds what a home folder holds.
  const copy = path.join(w.root, 'snapshots', 'monday', 'user');
  fs.mkdirSync(path.join(copy, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(copy, 'Projects'));
  assert.throws(() => checkFolder(copy, w.rules), /holds a \.ssh folder.*copy of a home folder/);
  assert.strictEqual(checkFolder(path.join(copy, 'Projects'), w.rules), path.join(copy, 'Projects'));
  fs.writeFileSync(w.at('Projects', '.ssh'), 'a file of that name is not a folder of keys');
  assert.strictEqual(checkFolder(w.at('Projects'), w.rules), w.at('Projects'));

  // The same folder mounted in a second place has another path and is the same folder. Mounting needs
  // root: as root directly, or through sudo where that asks no password (CI). Elsewhere this part is skipped.
  const alias = path.join(w.root, 'alias');
  fs.mkdirSync(alias);
  const asRoot = (cmd, ...args) => [[cmd, args], ['sudo', ['-n', cmd, ...args]]].some(([file, a]) => spawnSync(file, a).status === 0);
  if (!asRoot('mount', '--bind', path.join(w.root, 'home'), alias)) return t.diagnostic('skipped the second-mount part: mounting needs root');
  try {
    assert.throws(() => checkFolder(path.join(alias, 'user'), w.rules), /whole home folder/);
    assert.throws(() => checkFolder(alias, w.rules), /whole home folder/); // the folder that holds it
    assert.throws(() => checkFolder(path.join(alias, 'user', '.ssh'), w.rules), /hidden folder/);
    assert.throws(() => checkFolder(path.join(alias, 'user', '.local', 'share', 'notes'), w.rules), /hidden folder/);
    assert.throws(() => checkFolder(path.join(alias, 'user', '.config', 'banana-phone'), w.rules), /hidden folder|own files/);
    assert.strictEqual(checkFolder(path.join(alias, 'user', 'Projects', 'acme'), w.rules), path.join(alias, 'user', 'Projects', 'acme'));
    // The app's own folder too, when it is not in the home folder.
    fs.mkdirSync(path.join(w.root, 'home', 'appdata'));
    const keep = [path.join(w.root, 'home', 'appdata')];
    assert.throws(() => checkFolder(path.join(alias, 'appdata'), { home: w.home, keep }), /own files/);
  } finally {
    asRoot('umount', alias); // before the pretend home is deleted, which would otherwise be deleted through it
  }
});

test('what a writable share would let the server change is named, and odd characters in a path are shown', (t) => {
  const w = world(t);
  assert.deepStrictEqual(runsFrom(w.at('Projects', 'acme')), []);
  fs.writeFileSync(w.at('Projects', 'acme', 'notes.txt'), 'x');
  assert.deepStrictEqual(runsFrom(w.at('Projects', 'acme')), []);
  fs.writeFileSync(w.at('Projects', 'acme', 'build.sh'), '#!/bin/sh\n', { mode: 0o755 });
  assert.deepStrictEqual(runsFrom(w.at('Projects', 'acme')), ['programs or scripts']);
  fs.mkdirSync(w.at('Projects', 'acme', '.git'));
  assert.deepStrictEqual(runsFrom(w.at('Projects', 'acme')), ['a git repository', 'programs or scripts']);
  assert.deepStrictEqual(runsFrom(w.at('Projects', 'gone')), []);

  assert.strictEqual(visible('/home/user/Projets été/日本'), '/home/user/Projets été/日本'); // letters of any language stay
  assert.strictEqual(visible('/home/user/a‮gpj.exe'), '/home/user/a\\u{202e}gpj.exe'); // read right to left it would end in "exe.jpg"
  assert.strictEqual(visible('a​b\nc d'), 'a\\u{200b}b\\u{a}c\\u{2028}d');
});

test('the question names the server with its port, the account, and what is not yet known', (t) => {
  const w = world(t);
  const folder = w.at('Projects', 'acme');
  const conn = { host: 'gw.example', username: 'admin', domain: 'CORP', share: { path: folder, writable: false } };
  const q = question(conn, folder, { fingerprint: 'AA:BB' });
  assert.strictEqual(q.message, 'Share this folder with gw.example?');
  assert.ok(q.detail.startsWith(`${folder}\n\ngw.example, signed in as CORP\\admin, will be able to read everything in this folder, but not change it.`));
  assert.ok(!/first time|AA:BB|holds/.test(q.detail));
  // The usual port goes without saying; any other is part of which computer it is.
  assert.strictEqual(question({ ...conn, port: 3389 }, folder).message, q.message);
  for (const port of [3391, '3391']) {
    const other = question({ ...conn, port }, folder);
    assert.deepStrictEqual([other.title, other.message], ['Share a folder with gw.example:3391', 'Share this folder with gw.example:3391?']);
    assert.match(other.detail, /\ngw\.example:3391, signed in as/);
  }
  // A server met a moment ago is said to be one, with the certificate to compare.
  const first = question(conn, folder, { fingerprint: 'AA:BB', firstSeen: true }).detail;
  assert.match(first, /first time banana-phone has connected to gw\.example, .*\(SHA256\):\nAA:BB\n\nYou are asked once/s);
  // A share the server may change says what it could change, when that is something this computer runs.
  fs.mkdirSync(path.join(folder, '.git'));
  assert.ok(!/holds/.test(question(conn, folder).detail)); // read-only: nothing can be changed
  const writable = question({ ...conn, share: { path: folder, writable: true } }, folder).detail;
  assert.match(writable, /read, change and delete everything.*\n\nThis folder holds a git repository\. A server that can change files here/s);
  // Nothing the page wrote can add lines or turn the text around.
  const odd = question({ ...conn, username: 'adm\nin\u202E', domain: '' }, '/srv/a\u202Eb').detail;
  assert.ok(odd.startsWith('/srv/a\\u{202e}b\n\ngw.example, signed in as adm?in?,'));
});

test('an agreement covers one folder, one mode, one account on one server, and one certificate', () => {
  const conn = { host: 'dc01', username: 'admin', domain: 'CORP', share: { path: '/home/user/Projects', writable: false } };
  const key = crypto.randomBytes(32);
  const ok = approvalOf(conn, 'AA:BB', key);
  assert.match(ok, /^[0-9a-f]{64}$/);
  assert.strictEqual(approvalOf({ ...conn, port: 3389, share: { path: '/home/user/Projects' } }, 'AA:BB', key), ok); // the same thing said differently
  const changed = [
    approvalOf({ ...conn, share: { ...conn.share, path: '/home/user/Documents' } }, 'AA:BB', key),
    approvalOf({ ...conn, share: { ...conn.share, writable: true } }, 'AA:BB', key),
    approvalOf({ ...conn, host: 'dc02' }, 'AA:BB', key),
    approvalOf({ ...conn, port: 3390 }, 'AA:BB', key),
    approvalOf({ ...conn, username: 'guest' }, 'AA:BB', key),
    approvalOf({ ...conn, domain: 'OTHER' }, 'AA:BB', key),
    approvalOf({ ...conn, adminSession: true }, 'AA:BB', key),
    approvalOf(conn, 'CC:DD', key),
  ];
  assert.strictEqual(new Set([ok, ...changed]).size, 9);
  // Signed, not only summed up: without the key nobody can work one out, and there is none without a key.
  assert.notStrictEqual(approvalOf(conn, 'AA:BB', crypto.randomBytes(32)), ok);
  for (const none of [undefined, null, '', 'k'.repeat(32), Buffer.alloc(8)]) assert.throws(() => approvalOf(conn, 'AA:BB', none), /needs a key/);
});
