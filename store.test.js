const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

// Well-formed like load() output: every folder a connection uses is listed.
const sample = () => ({
  ordered: true,
  folders: ['Prod', 'Prod/Windows', 'Lab', 'Production'],
  folderIcons: {},
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
  assert.deepStrictEqual(store.load(path.join(dir, 'missing.json')), { ordered: true, folders: [], folderIcons: {}, connections: [] });
});

test('folder icons: unknown name rejected, follow a folder move, removed with the folder', () => {
  const d = sample();
  assert.throws(() => store.setFolderIcon(d, 'Prod', '../etc/passwd'), /Unknown folder icon/);
  assert.deepStrictEqual(d.folderIcons, {});
  store.setFolderIcon(d, 'Prod', 'kiwi');
  store.setFolderIcon(d, 'Prod/Windows', 'peach');
  store.setFolderIcon(d, 'Production', 'lemon');
  store.moveFolder(d, 'Prod', 'Lab');
  assert.deepStrictEqual(d.folderIcons, { 'Lab/Prod': 'kiwi', 'Lab/Prod/Windows': 'peach', Production: 'lemon' });
  store.remove(d, 'a');
  store.remove(d, 'b');
  store.removeFolder(d, 'Lab/Prod');
  assert.deepStrictEqual(d.folderIcons, { Production: 'lemon' });
});

test('setFolderIcon refuses a folder that does not exist', () => {
  const d = sample();
  assert.throws(() => store.setFolderIcon(d, 'Nope', 'kiwi'), /No such folder/);
  assert.deepStrictEqual(d.folderIcons, {});
});

test('removeFolder refuses a folder with connections in it or below, then removes its subfolders', () => {
  const d = sample();
  store.setFolderIcon(d, 'Prod/Windows', 'peach');
  store.setFolderIcon(d, 'Production', 'lemon');
  store.remove(d, 'b'); // Prod itself is now empty, Prod/Windows still holds dc01
  assert.throws(() => store.removeFolder(d, 'Prod'), /Only empty folders can be deleted/);
  assert.deepStrictEqual(d.folders, ['Prod', 'Prod/Windows', 'Lab', 'Production']);
  store.remove(d, 'a');
  store.removeFolder(d, 'Prod');
  assert.deepStrictEqual(d.folders, ['Lab', 'Production']); // look-alike prefix stays
  assert.deepStrictEqual(d.folderIcons, { Production: 'lemon' });
});

test('addFolder and upsert list every parent folder', () => {
  const d = { ordered: true, folders: [], folderIcons: {}, connections: [] };
  store.addFolder(d, 'a/b/c');
  assert.deepStrictEqual([...d.folders].sort(), ['a', 'a/b', 'a/b/c']);
  store.upsert(d, { name: 'n', folder: 'x/y' });
  assert.deepStrictEqual([...d.folders].sort(), ['a', 'a/b', 'a/b/c', 'x', 'x/y']);
});

test('a brand-new store keeps insertion order across save and load', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-')), 'c.json');
  const d = store.load(f);
  store.addFolder(d, 'b');
  store.addFolder(d, 'a');
  store.upsert(d, { id: '1', name: 'z' });
  store.upsert(d, { id: '2', name: 'y' });
  store.save(f, d);
  const back = store.load(f);
  assert.deepStrictEqual([back.folders, back.connections.map((c) => c.id)], [['b', 'a'], ['1', '2']]);
});

test('a file saved before folder icons existed still loads', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-')), 'c.json');
  fs.writeFileSync(file, JSON.stringify({ folders: ['A'], connections: [] }));
  assert.deepStrictEqual(store.load(file).folderIcons, {});
});

test('moveConn reorders within and across folders', () => {
  const d = sample();
  store.moveConn(d, 'a', 'Prod', 'b'); // dc01 into Prod, in front of web
  assert.deepStrictEqual(d.connections.map((c) => c.id), ['a', 'b', 'c', 'd']);
  assert.strictEqual(d.connections[0].folder, 'Prod');
  store.moveConn(d, 'a', ''); // to the top level, last
  assert.deepStrictEqual(d.connections.map((c) => c.id), ['b', 'c', 'd', 'a']);
  assert.strictEqual(d.connections[3].folder, undefined);
});

test('moveFolder takes children along, reorders and un-nests', () => {
  const d = sample();
  assert.strictEqual(store.moveFolder(d, 'Prod', 'Lab'), 'Lab/Prod');
  assert.deepStrictEqual(d.folders, ['Lab', 'Production', 'Lab/Prod', 'Lab/Prod/Windows']);
  assert.strictEqual(d.connections.find((c) => c.id === 'a').folder, 'Lab/Prod/Windows');
  assert.strictEqual(d.connections.find((c) => c.id === 'd').folder, 'Production'); // look-alike prefix stays put
  store.moveFolder(d, 'Lab/Prod', '', 'Lab'); // back to the top, in front of Lab
  assert.deepStrictEqual(d.folders, ['Prod', 'Prod/Windows', 'Lab', 'Production']);
});

test('moveFolder refuses itself, its children and duplicate paths', () => {
  const d = sample();
  assert.throws(() => store.moveFolder(d, 'Prod', 'Prod'), /inside itself/);
  assert.throws(() => store.moveFolder(d, 'Prod', 'Prod/Windows'), /inside itself/);
  d.folders.push('Lab/Windows');
  assert.throws(() => store.moveFolder(d, 'Prod/Windows', 'Lab'), /already exists/);
  assert.deepStrictEqual(d.connections.find((c) => c.id === 'a').folder, 'Prod/Windows');
});

test('an old file loads alphabetical and keeps a saved order afterwards', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-')), 'c.json');
  fs.writeFileSync(f, JSON.stringify({ folders: ['b', 'a'], connections: [{ id: '1', name: 'z' }, { id: '2', name: 'y' }] }));
  const d = store.load(f);
  assert.strictEqual(d.ordered, true);
  assert.deepStrictEqual([d.folders, d.connections.map((c) => c.id)], [['a', 'b'], ['2', '1']]);
  store.moveConn(d, '2', '');
  store.save(f, d);
  assert.deepStrictEqual(store.load(f).connections.map((c) => c.id), ['1', '2']);
});

test('a folder moved by drag keeps its icon, and so do its subfolders', () => {
  const d = { ordered: true, folders: ['a', 'a/b', 'c'], folderIcons: { a: 'kiwi', 'a/b': 'lemon' }, connections: [] };
  store.moveFolder(d, 'a', 'c');
  assert.deepStrictEqual(d.folderIcons, { 'c/a': 'kiwi', 'c/a/b': 'lemon' });
});
