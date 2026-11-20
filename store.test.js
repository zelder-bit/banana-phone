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
  assert.deepStrictEqual(store.load(path.join(dir, 'missing.json')), { folders: [], connections: [] });
});
