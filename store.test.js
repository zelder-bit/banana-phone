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
  const same = { host: '10.0.0.1', protocol: 'rdp', username: 'admin' }; // the server and account of 'a'
  const copy = store.upsert(d, { ...same, name: 'dc01 copy', copyPasswordFrom: 'a' });
  assert.strictEqual(copy.password, 'ENC');
  assert.ok(!('copyPasswordFrom' in d.connections.at(-1)));
  assert.strictEqual(store.upsert(d, { ...same, name: 'other', password: 'NEW', copyPasswordFrom: 'a' }).password, 'NEW');
  assert.strictEqual(store.upsert(d, { ...same, name: 'cleared', password: '', copyPasswordFrom: 'a' }).password, '');
  assert.strictEqual(store.upsert(d, { ...same, name: 'gone', copyPasswordFrom: 'nope' }).password, undefined);
  store.upsert(d, { id: 'b', copyPasswordFrom: 'a' });
  assert.strictEqual(d.connections[1].password, undefined);
});

test('a saved password stays with its server and account: not copied to another, dropped when re-pointed', () => {
  const d = sample();
  d.connections[0].password = 'ENC';
  const same = { host: '10.0.0.1', protocol: 'rdp', username: 'admin' };
  for (const other of [{ host: 'evil.example' }, { port: 3390 }, { protocol: 'vnc' }, { username: 'guest' }]) {
    assert.strictEqual(store.upsert(d, { ...same, ...other, name: 'copy', copyPasswordFrom: 'a' }).password, undefined, `copied to ${JSON.stringify(other)}`);
    const e = sample();
    e.connections[0].password = 'ENC';
    store.upsert(e, { id: 'a', ...other });
    assert.ok(!('password' in e.connections[0]), `kept for ${JSON.stringify(other)}`);
  }
  // Anything else may change, and a password that comes with the save is for the new server.
  store.upsert(d, { id: 'a', ...same, name: 'renamed', folder: 'Lab', domain: 'OTHER', port: undefined });
  assert.strictEqual(d.connections[0].password, 'ENC');
  store.upsert(d, { id: 'a', host: 'new.lan', password: 'NEW' });
  assert.strictEqual(d.connections[0].password, 'NEW');
  // Changing it back does not bring the old one back.
  store.upsert(d, { id: 'a', host: 'elsewhere' });
  store.upsert(d, { id: 'a', host: 'new.lan' });
  assert.strictEqual(d.connections[0].password, undefined);
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
  store.setFolderIcon(d, 'Production', 'crate'); // the default picture is a valid choice too
  assert.strictEqual(d.folderIcons.Production, 'crate');
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

test('upsert keeps only well-formed saved commands', () => {
  const d = { ordered: true, folders: [], folderIcons: {}, connections: [] };
  const c = store.upsert(d, { name: 'box', protocol: 'ssh', commands: [
    { name: ' Attach ', cmd: ' tmux attach ', onStart: 'yes' },
    { name: 'empty', cmd: '   ' },
    { name: 5, cmd: 'ls' },
    null,
    { name: 'logs', cmd: 'journalctl -f', onStart: true },
  ] });
  assert.deepStrictEqual(d.connections[0].commands, [
    { name: 'Attach', cmd: 'tmux attach', onStart: false },
    { name: 'logs', cmd: 'journalctl -f', onStart: true },
  ]);
  store.upsert(d, { id: c.id, commands: 'rm -rf /' }); // not a list: no commands
  assert.deepStrictEqual(d.connections[0].commands, []);
  store.upsert(d, { id: c.id, name: 'box2' }); // not sent: left alone
  assert.deepStrictEqual(d.connections[0].commands, []);
});

test('shared folders are kept only well-formed, only on RDP, and lose their agreement when removed', () => {
  const d = sample();
  const shares = () => d.connections[0].shares;
  store.upsert(d, { id: 'a', shares: [{ path: '/home/user/Projects', writable: 'yes', extra: 1 }] });
  assert.deepStrictEqual(shares(), [{ path: '/home/user/Projects', writable: false }]); // writable only when exactly true
  // Several folders, each with its own mode; what is not a folder is left out of the list.
  store.upsert(d, { id: 'a', shares: [{ path: '/home/user/Projects', writable: true }, null, { path: ' ' }, { path: 42 }, '/x', { path: '/home/user/Scans' }] });
  assert.deepStrictEqual(shares(), [{ path: '/home/user/Projects', writable: true }, { path: '/home/user/Scans', writable: false }]);
  d.connections[0].shareOk = 'agreed'; // main.js sets this once the user has agreed
  store.upsert(d, { id: 'a', name: 'dc01 renamed' }); // an edit that does not mention the shares keeps both
  assert.deepStrictEqual([shares().length, d.connections[0].shareOk], [2, 'agreed']);
  for (const off of [null, '', [], '/home/user/Projects', { path: '/home/user/Projects' }, [{ path: '' }], [{ path: '  ' }], [{ path: 42 }], [{}], [null]]) {
    Object.assign(d.connections[0], { shares: [{ path: '/x', writable: false }], shareOk: 'agreed' });
    store.upsert(d, { id: 'a', shares: off });
    assert.ok(!('shares' in d.connections[0]) && !('shareOk' in d.connections[0]), JSON.stringify(off));
  }
  // SSH has no drives: shares sent for one are dropped, and an RDP connection turned into SSH loses its own.
  store.upsert(d, { id: 'b', shares: [{ path: '/home/user/Projects' }] });
  assert.ok(!('shares' in d.connections[1]));
  Object.assign(d.connections[0], { shares: [{ path: '/x', writable: false }], shareOk: 'agreed' });
  store.upsert(d, { id: 'a', protocol: 'ssh' });
  assert.ok(!('shares' in d.connections[0]) && !('shareOk' in d.connections[0]));
  assert.ok(store.upsert(d, { name: 'new rdp', protocol: 'rdp', shares: [{ path: '/srv/files' }] }).shares[0].path === '/srv/files');
});

test('a file saved when a connection shared one folder loads as a list of one, to be agreed to again', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-')), 'c.json');
  const rdp = { id: 'a', name: 'dc01', protocol: 'rdp', host: '10.0.0.1' };
  fs.writeFileSync(file, JSON.stringify({ ordered: true, connections: [
    { ...rdp, share: { path: '/srv/files', writable: true }, shareOk: 'agreed' }, { ...rdp, id: 'b' }, { ...rdp, id: 'c', shares: [{ path: '/srv/new', writable: false }] },
    // Written by hand: an empty list, a list with things in it that are no folders, and something that is no list.
    { ...rdp, id: 'd', shares: [] }, { ...rdp, id: 'e', shares: [null, { path: 42 }, { path: '/srv/kept', writable: 'yes', extra: 1 }, '/x'] }, { ...rdp, id: 'f', shares: { path: '/srv/x' } },
  ] }));
  const d = store.load(file);
  assert.deepStrictEqual(d.connections.map((c) => [c.shares, 'share' in c]), [[[{ path: '/srv/files', writable: true }], false], [undefined, false], [[{ path: '/srv/new', writable: false }], false],
    [undefined, false], [[{ path: '/srv/kept', writable: false }], false], [undefined, false]]);
  assert.ok(!('shares' in d.connections[3]) && !('shares' in d.connections[5])); // no list at all, so the connection opens without sharing
  // The old form is not a way in for the page: only a file is read that way.
  store.upsert(d, { id: 'b', share: { path: '/srv/files', writable: true } });
  assert.ok(!('share' in d.connections[1]) && !('shares' in d.connections[1]));
});

test("an agreement ends with any change to what was agreed, and cannot be saved in or brought back", () => {
  const d = sample();
  const c = () => d.connections[0];
  const agree = () => { Object.assign(c(), { shares: [{ path: '/srv/files', writable: true }], host: '10.0.0.1', username: 'admin', domain: 'CORP', shareOk: 'agreed' }); delete c().port; delete c().adminSession; };
  // What the edit dialog sends when nothing was changed keeps the agreement.
  agree();
  store.upsert(d, { id: 'a', name: 'dc01', protocol: 'rdp', host: '10.0.0.1', port: undefined, username: 'admin', domain: 'CORP', adminSession: false, shares: [{ path: '/srv/files', writable: true }] });
  assert.strictEqual(c().shareOk, 'agreed');
  const more = { path: '/srv/more', writable: false };
  for (const change of [{ shares: [{ path: '/srv/files', writable: false }] }, { shares: [{ path: '/srv/other', writable: true }] }, { shares: [{ path: '/srv/files', writable: true }, more] }, { host: '10.0.0.2' }, { port: 3390 }, { username: 'guest' }, { domain: 'OTHER' }, { adminSession: true }]) {
    agree();
    store.upsert(d, { id: 'a', ...change });
    assert.ok(!('shareOk' in c()), JSON.stringify(change));
    // Changing it back does not bring the old agreement back: the user made it read-only, so writable is a new question.
    store.upsert(d, { id: 'a', shares: [{ path: '/srv/files', writable: true }], host: '10.0.0.1', port: undefined, username: 'admin', domain: 'CORP', adminSession: false });
    assert.ok(!('shareOk' in c()), `back from ${JSON.stringify(change)}`);
  }
  // Nothing that is saved can carry an agreement in.
  agree(); delete c().shareOk;
  store.upsert(d, { id: 'a', shareOk: 'forged' });
  assert.ok(!('shareOk' in c()));
  assert.ok(!('shareOk' in store.upsert(d, { name: 'new', protocol: 'rdp', shares: [{ path: '/srv/files' }], shareOk: 'forged' })));
  // A folder taken out of the list, or the same folders in another order, is a change too.
  for (const shares of [[more], [more, { path: '/srv/files', writable: true }]]) {
    agree(); c().shares.push(more);
    store.upsert(d, { id: 'a', shares });
    assert.ok(!('shareOk' in c()), JSON.stringify(shares));
  }
  // Bulk edit: another account ends it, a new password does not.
  agree();
  store.bulkUpdate(d, { ids: ['a'], username: 'admin' }, { password: 'ENC' });
  assert.strictEqual(c().shareOk, 'agreed');
  store.bulkUpdate(d, { ids: ['a'], username: 'admin' }, { username: 'svc' });
  assert.ok(!('shareOk' in c()));
  agree();
  store.bulkUpdate(d, { ids: ['a'], username: 'admin' }, { domain: 'NEW' });
  assert.ok(!('shareOk' in c()));
});

test('the sharing toast says how the folder is shared, and why a drive may be missing', () => {
  const { sharingText } = require('./renderer/shared.mjs');
  const ro = sharingText([{ path: '/home/me/out', writable: false }], 'win.test');
  assert.match(ro, /^Sharing \/home\/me\/out \(read-only\) with win\.test\./);
  assert.match(ro, /If no drive appears there, the server may be set to refuse shared drives\.$/);
  assert.match(sharingText([{ path: '/x', writable: true }], 'h'), /\(it can change files\)/);
  // Several folders: each is named, with what the server may do to it.
  assert.match(sharingText([{ path: '/a', writable: false }, { path: '/b', writable: true }], 'h'), /^Sharing \/a \(read-only\), \/b \(it can change files\) with h\./);
});
