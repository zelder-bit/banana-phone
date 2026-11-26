const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { pin, pinAll, together, driveNames, checkFolder, approvalOf, question, runsFrom, visible } = require('./share');

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
  const conn = { host: 'gw.example', username: 'admin', domain: 'CORP' };
  const readOnly = [{ path: folder, writable: false, name: 'acme' }];
  const q = question(conn, readOnly, { fingerprint: 'AA:BB' });
  assert.strictEqual(q.message, 'Share this folder with gw.example?');
  assert.ok(q.detail.startsWith(`${folder}\n\ngw.example, signed in as CORP\\admin, will be able to read everything in this folder, but not change it.`));
  assert.ok(!/first time|AA:BB|holds/.test(q.detail));
  // The usual port goes without saying; any other is part of which computer it is.
  assert.strictEqual(question({ ...conn, port: 3389 }, readOnly).message, q.message);
  for (const port of [3391, '3391']) {
    const other = question({ ...conn, port }, readOnly);
    assert.deepStrictEqual([other.title, other.message], ['Share a folder with gw.example:3391', 'Share this folder with gw.example:3391?']);
    assert.match(other.detail, /\ngw\.example:3391, signed in as/);
  }
  // A server met a moment ago is said to be one, with the certificate to compare.
  const first = question(conn, readOnly, { fingerprint: 'AA:BB', firstSeen: true }).detail;
  assert.match(first, /first time banana-phone has connected to gw\.example, .*\(SHA256\):\nAA:BB\n\nYou are asked once/s);
  // A share the server may change says what it could change, when that is something this computer runs.
  fs.mkdirSync(path.join(folder, '.git'));
  assert.ok(!/holds/.test(question(conn, readOnly).detail)); // read-only: nothing can be changed
  const writable = question(conn, [{ path: folder, writable: true, name: 'acme' }]).detail;
  assert.match(writable, /read, change and delete everything.*\n\nThis folder holds a git repository\. A server that can change files here/s);
  // Nothing the page wrote can add lines or turn the text around.
  const odd = question({ ...conn, username: 'adm\nin\u202E', domain: '' }, [{ path: '/srv/a\u202Eb' }]).detail;
  assert.ok(odd.startsWith('/srv/a\\u{202e}b\n\ngw.example, signed in as adm?in?,'));
});

test('the question for several folders names each one, its name in the drive and whether it can be changed', (t) => {
  const w = world(t);
  const conn = { host: 'gw.example', username: 'admin' };
  fs.mkdirSync(w.at('Scans', '.git'), { recursive: true });
  const acme = { path: w.at('Projects', 'acme'), writable: false, name: 'acme' };
  const scans = { path: w.at('Scans'), writable: false, name: 'Scans' };
  const none = question(conn, [acme, scans]);
  assert.deepStrictEqual([none.title, none.message], ['Share 2 folders with gw.example', 'Share these folders with gw.example?']);
  assert.ok(none.detail.startsWith(`${acme.path}\n    as acme: read-only\n${scans.path}\n    as Scans: read-only\n\ngw.example, signed in as admin, will be able to read everything in these folders, but not change it.`));
  assert.ok(!/holds/.test(none.detail));
  assert.match(none.detail, /You are asked once for these folders, this server and this account/);
  // One of the two writable: the question says which, and what that one would let the server change.
  const some = question(conn, [acme, { ...scans, writable: true }]).detail;
  assert.match(some, /as acme: read-only\n.*\n    as Scans: CAN BE CHANGED\n\n.* read everything in these folders, and to change and delete everything in the one marked CAN BE CHANGED\./);
  assert.match(some, /\n\nWhat can be changed holds a git repository\./);
  assert.ok(!/holds/.test(question(conn, [{ ...acme, writable: true }, scans]).detail)); // the repository is in the read-only one
  assert.match(question(conn, [{ ...acme, writable: true }, { ...scans, writable: true }]).detail, /will be able to read, change and delete everything in these folders\./);
  // A name is the page's as much as a path is: nothing in it can add a line.
  assert.match(question(conn, [acme, { path: '/srv/x', name: 'a\nb' }]).detail, /\n    as a\\u\{a\}b: read-only\n\n/);
});

test('several folders: each is checked on its own, none twice or inside another, and each gets a name', (t) => {
  const w = world(t);
  for (const d of ['Scans', 'Work/Documents', 'Home/documents']) fs.mkdirSync(w.at(d), { recursive: true });
  const acme = w.at('Projects', 'acme');
  const all = pinAll([{ path: acme }, { path: w.at('Scans'), writable: true }, { path: w.at('Work', 'Documents'), writable: 'yes' }, { path: w.at('Home', 'documents') }], w.rules);
  assert.deepStrictEqual(all.map((f) => [f.path, f.writable, f.name]), [
    [acme, false, 'acme'], [w.at('Scans'), true, 'Scans'], [w.at('Work', 'Documents'), false, 'Documents'], [w.at('Home', 'documents'), false, 'documents (2)'],
  ]);
  assert.deepStrictEqual({ path: all[0].path, dev: all[0].dev, ino: all[0].ino }, pin(acme, w.rules)); // identified, as one folder is
  // The rules hold for every folder in the list, not only the first.
  assert.throws(() => pinAll([{ path: acme }, { path: w.at('.ssh') }], w.rules), /hidden folder/);
  assert.throws(() => pinAll([{ path: acme }, { path: w.home }], w.rules), /whole home folder/);
  assert.throws(() => pinAll([{ path: acme }, {}], w.rules), /full path/);
  assert.throws(() => pinAll([{ path: acme }, null], w.rules), /full path/);
  // The same folder twice, by its path or through a link, and a folder together with one inside it.
  fs.symlinkSync(acme, w.at('acme-again'));
  assert.throws(() => pinAll([{ path: acme }, { path: acme, writable: true }], w.rules), /twice/);
  assert.throws(() => pinAll([{ path: acme }, { path: w.at('acme-again') }], w.rules), /twice/);
  assert.throws(() => pinAll([{ path: acme, writable: true }, { path: w.at('Projects') }], w.rules), /cannot both be shared/);
  assert.throws(() => pinAll([{ path: w.at('Projects') }, { path: acme }], w.rules), /cannot both be shared/);
  // No list, an empty one, or one too long to read in a question.
  for (const none of [undefined, null, [], 'x', { path: acme }]) assert.throws(() => pinAll(none, w.rules), /at least one folder/);
  assert.throws(() => pinAll(Array(9).fill({ path: acme }), w.rules), /8 folders at most/);

  // What a list must be is asked of the paths alone when a connection is saved: no folder is looked at, so none need exist.
  const nowhere = (...names) => names.map((n) => ({ path: `/bp-nowhere/${n}` }));
  assert.doesNotThrow(() => together(nowhere('a', 'b', 'ab')));
  assert.throws(() => together(nowhere('a', 'b', 'a')), /\/bp-nowhere\/a is in the list of shared folders twice/);
  assert.throws(() => together(nowhere('a/b', 'c', 'a')), /cannot both be shared/);
  assert.throws(() => together(nowhere('a', 'c', 'a/b/c')), /cannot both be shared/);
  assert.throws(() => together(nowhere(...'abcdefghi')), /8 folders at most/);
  assert.doesNotThrow(() => together(nowhere(...'abcdefgh')));

  // Names in the drive: the folder's own, made fit for Windows, and never two that read the same there.
  assert.deepStrictEqual(driveNames(['/a/Documents', '/b/DOCUMENTS', '/c/Documents', '/d/Documents (2)']), ['Documents', 'DOCUMENTS (2)', 'Documents (3)', 'Documents (2) (2)']);
  assert.deepStrictEqual(driveNames(['/a/what?', '/a/a:b|c', '/a/ends. .', '/a/...']), ['what_', 'a_b_c', 'ends', 'Folder']);
  assert.deepStrictEqual(driveNames(['/a/nul', '/a/CON.txt', '/a/com1', '/a/console', '/a/lpt10']), ['nul_', 'CON_.txt', 'com1_', 'console', 'lpt10']); // device names there
});

test('an agreement covers the list of folders, each with its mode, one account on one server, and one certificate', () => {
  const conn = { host: 'dc01', username: 'admin', domain: 'CORP', shares: [{ path: '/home/user/Projects', writable: false }] };
  const scans = { path: '/home/user/Scans', writable: false };
  const key = crypto.randomBytes(32);
  const ok = approvalOf(conn, 'AA:BB', key);
  assert.match(ok, /^[0-9a-f]{64}$/);
  assert.strictEqual(approvalOf({ ...conn, port: 3389, shares: [{ path: '/home/user/Projects' }] }, 'AA:BB', key), ok); // the same thing said differently
  const changed = [
    approvalOf({ ...conn, shares: [{ ...conn.shares[0], path: '/home/user/Documents' }] }, 'AA:BB', key),
    approvalOf({ ...conn, shares: [{ ...conn.shares[0], writable: true }] }, 'AA:BB', key),
    // A folder added, the same two the other way round (their names in the drive follow the order), one of two made writable.
    approvalOf({ ...conn, shares: [conn.shares[0], scans] }, 'AA:BB', key),
    approvalOf({ ...conn, shares: [scans, conn.shares[0]] }, 'AA:BB', key),
    approvalOf({ ...conn, shares: [conn.shares[0], { ...scans, writable: true }] }, 'AA:BB', key),
    approvalOf({ ...conn, host: 'dc02' }, 'AA:BB', key),
    approvalOf({ ...conn, port: 3390 }, 'AA:BB', key),
    approvalOf({ ...conn, username: 'guest' }, 'AA:BB', key),
    approvalOf({ ...conn, domain: 'OTHER' }, 'AA:BB', key),
    approvalOf({ ...conn, adminSession: true }, 'AA:BB', key),
    approvalOf(conn, 'CC:DD', key),
  ];
  assert.strictEqual(new Set([ok, ...changed]).size, 12);
  // Signed, not only summed up: without the key nobody can work one out, and there is none without a key.
  assert.notStrictEqual(approvalOf(conn, 'AA:BB', crypto.randomBytes(32)), ok);
  for (const none of [undefined, null, '', 'k'.repeat(32), Buffer.alloc(8)]) assert.throws(() => approvalOf(conn, 'AA:BB', none), /needs a key/);
});
