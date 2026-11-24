const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkFolder, approvalOf } = require('./share');

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
  for (const p of ['/etc', '/etc/ssl', '/proc/self', '/dev', '/sys/kernel', '/run', '/usr', '/var']) no(p, /system folder/);
  for (const p of ['Projects/acme', '', '~/Projects', undefined, null, 42, { path: '/tmp' }]) assert.throws(() => checkFolder(p, w.rules), /full path/, String(p));
});

test("the app's own folder is kept out wherever it is", (t) => {
  const w = world(t);
  const keep = [path.join(w.root, 'elsewhere', 'appdata')];
  assert.throws(() => checkFolder(keep[0], { home: w.home, keep }), /own files/);
  assert.throws(() => checkFolder(path.join(w.root, 'elsewhere'), { home: w.home, keep }), /own files/); // a folder holding it
  assert.strictEqual(checkFolder(w.at('Projects'), { home: w.home, keep }), w.at('Projects'));
});

test('an agreement covers one folder, one mode, one server and one certificate', () => {
  const conn = { host: 'dc01', share: { path: '/home/user/Projects', writable: false } };
  const ok = approvalOf(conn, 'AA:BB');
  assert.match(ok, /^[0-9a-f]{64}$/);
  assert.strictEqual(approvalOf({ ...conn, port: 3389, share: { path: '/home/user/Projects' } }, 'AA:BB'), ok); // the same thing said differently
  const changed = [
    approvalOf({ ...conn, share: { ...conn.share, path: '/home/user/Documents' } }, 'AA:BB'),
    approvalOf({ ...conn, share: { ...conn.share, writable: true } }, 'AA:BB'),
    approvalOf({ ...conn, host: 'dc02' }, 'AA:BB'),
    approvalOf({ ...conn, port: 3390 }, 'AA:BB'),
    approvalOf(conn, 'CC:DD'),
  ];
  assert.strictEqual(new Set([ok, ...changed]).size, 6);
});
