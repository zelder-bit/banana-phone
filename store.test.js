const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const sample = () => ({
  folders: ['Prod', 'Prod/Windows', 'Lab'],
  connections: [
    { id: 'a', name: 'dc01', host: '10.0.0.1', protocol: 'rdp', username: 'admin', domain: 'CORP', folder: 'Prod/Windows' },
    { id: 'b', name: 'web', host: 'web.lan', protocol: 'ssh', username: 'admin', folder: 'Prod' },
    { id: 'c', name: 'pi', host: 'pi.lan', protocol: 'ssh', username: 'pi', folder: 'Lab' },
    { id: 'd', name: 'prodx', host: 'x', protocol: 'ssh', username: 'admin', folder: 'Production' },
  ],
});

test('search matches every word across fields', () => {
  const d = sample();
  assert.deepStrictEqual(d.connections.filter((c) => store.matches(c, 'admin windows')).map((c) => c.id), ['a']);
  assert.strictEqual(d.connections.filter((c) => store.matches(c, '')).length, 4);
});

test('an empty password removes the saved one, undefined keeps it', () => {
  const d = sample();
  store.bulkUpdate(d, { username: 'admin' }, { password: 'ENC' });
  store.upsert(d, { id: 'a', name: 'dc01' });
  assert.strictEqual(d.connections[0].password, 'ENC');
  store.upsert(d, { id: 'a', password: '' });
  assert.strictEqual(d.connections[0].password, '');
  store.bulkUpdate(d, { folder: 'Prod' }, { password: '' });
  assert.deepStrictEqual(d.connections.map((c) => c.password), ['', '', undefined, 'ENC']);
});

test('copyPasswordFrom copies the encrypted password unless a new one is given', () => {
  const d = sample();
  d.connections[0].password = 'ENC';
  const copy = store.upsert(d, { name: 'dc01 copy', copyPasswordFrom: 'a' });
  assert.strictEqual(copy.password, 'ENC');
  assert.ok(!('copyPasswordFrom' in d.connections.at(-1)));
  assert.strictEqual(store.upsert(d, { name: 'other', password: 'NEW', copyPasswordFrom: 'a' }).password, 'NEW');
  assert.strictEqual(store.upsert(d, { name: 'cleared', password: '', copyPasswordFrom: 'a' }).password, '');
  assert.strictEqual(store.upsert(d, { name: 'gone', copyPasswordFrom: 'nope' }).password, undefined);
  store.upsert(d, { id: 'b', copyPasswordFrom: 'a' });
  assert.strictEqual(d.connections[1].password, undefined);
});

test('bulk update by username changes only that username', () => {
  const d = sample();
  assert.strictEqual(store.bulkUpdate(d, { username: 'admin' }, { password: 'ENC' }), 3);
  assert.deepStrictEqual(d.connections.map((c) => c.password), ['ENC', 'ENC', undefined, 'ENC']);
  assert.strictEqual(d.connections[0].username, 'admin');
});

test('bulk update by folder includes subfolders but not lookalike names', () => {
  const d = sample();
  assert.strictEqual(store.bulkUpdate(d, { folder: 'Prod' }, { username: 'svc', domain: 'NEW' }), 2);
  assert.deepStrictEqual(d.connections.map((c) => c.username), ['svc', 'svc', 'pi', 'admin']);
});

test('bulk update respects ticked ids', () => {
  const d = sample();
  assert.strictEqual(store.bulkUpdate(d, { username: 'admin', ids: ['b'] }, { username: 'x' }), 1);
  assert.deepStrictEqual(d.connections.map((c) => c.username), ['admin', 'x', 'pi', 'admin']);
});

test('save writes a backup and load round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'));
  const file = path.join(dir, 'connections.json');
  store.save(file, sample());
  const d = store.load(file);
  d.connections[0].name = 'changed';
  store.save(file, d, { backup: true });
  assert.strictEqual(store.load(file + '.bak').connections[0].name, 'dc01');
  assert.strictEqual(store.load(file).connections[0].name, 'changed');
  assert.deepStrictEqual(store.load(path.join(dir, 'missing.json')), { folders: [], folderIcons: {}, connections: [] });
});

test('folder icons: unknown name rejected, follows a rename, removed with the folder', () => {
  const d = { ...sample(), folderIcons: {} };
  assert.throws(() => store.setFolderIcon(d, 'Prod', '../etc/passwd'));
  assert.deepStrictEqual(d.folderIcons, {});
  store.setFolderIcon(d, 'Prod', 'kiwi');
  store.setFolderIcon(d, 'Prod/Windows', 'peach');
  store.setFolderIcon(d, 'Production', 'lemon');
  store.moveFolderIcons(d, 'Prod', 'Live');
  assert.deepStrictEqual(d.folderIcons, { Live: 'kiwi', 'Live/Windows': 'peach', Production: 'lemon' });
  store.moveFolderIcons(d, 'Live', null);
  assert.deepStrictEqual(d.folderIcons, { Production: 'lemon' });
});

test('a file saved before folder icons existed still loads', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-')), 'c.json');
  fs.writeFileSync(file, JSON.stringify({ folders: ['A'], connections: [] }));
  assert.deepStrictEqual(store.load(file).folderIcons, {});
});
