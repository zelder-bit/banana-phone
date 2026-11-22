import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import Guacamole from '../node_modules/guacamole-common-js/dist/esm/guacamole-common.js';
import { shareClipboard, clean } from './clipboard.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
const ICON = { ssh: 'banana', rdp: 'orange-slice', vnc: 'grapes', local: 'kiwi' };
const icon = (p) => el('img', { src: `svg/${ICON[p] || 'lemon'}.svg`, alt: '' });
const MAX_PANES = 4;

let view = { folders: [], connections: [] };
let selected = null;

// Falling fruit behind the top bar: each fruit gets its own position, size, speed and sway.
const FALL_FRUITS = ['apple', 'banana', 'coconut', 'grapes', 'kiwi', 'lemon', 'orange-slice', 'orange', 'peach', 'strawberry', 'watermelon'];
function rain(fall, n = 10) {
  for (let i = 0; i < n; i++) {
    const img = el('img', { src: `svg/${FALL_FRUITS[Math.floor(Math.random() * FALL_FRUITS.length)]}.svg`, alt: '' });
    const vars = {
      '--left': `${(i * (100 / n) + 2 + Math.random() * 6).toFixed(1)}%`, // spread evenly, then jitter
      '--size': `${(16 + Math.random() * 6).toFixed(1)}px`,
      '--dur': `${(6 + Math.random() * 6).toFixed(2)}s`,
      '--delay': `${(-Math.random() * 12).toFixed(2)}s`, // negative: start mid-fall, not all at the top
      '--sway': `${((Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 10)).toFixed(1)}px`,
    };
    for (const [k, v] of Object.entries(vars)) img.style.setProperty(k, v);
    fall.append(img);
  }
}
rain($('.top .fall'));

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- theme

const themeKey = 'bp-theme';
try { const t = localStorage.getItem(themeKey); if (t) document.documentElement.dataset.theme = t; } catch {}
$('#theme').onclick = () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(themeKey, next); } catch {}
  retheme();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);

function termTheme() {
  const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return {
    background: v('--term-bg'), foreground: v('--ink'), cursor: v('--orange'), cursorAccent: v('--term-bg'),
    selectionBackground: v('--peel') + '66',
    // ANSI colours from the fruit palette, so prompts stay readable on both themes.
    black: v('--muted'), brightBlack: v('--muted'),
    red: v('--berry'), brightRed: v('--berry'),
    green: v('--leaf'), brightGreen: v('--leaf'),
    yellow: v('--orange-deep'), brightYellow: v('--orange'),
    blue: '#3D7FC4', brightBlue: '#4A90D9', magenta: '#B4518F', brightMagenta: '#C963A3', cyan: '#2E9C9C', brightCyan: '#36B0B0',
    white: v('--ink'), brightWhite: v('--ink'),
  };
}
function retheme() {
  for (const t of tabs) for (const p of t.panes) if (p.term) p.term.options.theme = termTheme();
}

// ---------------------------------------------------------------- sidebar tree

// Collapse the whole sidebar (button or Ctrl+B); remembered between launches.
function setSide(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  $('#toggle-side').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('bp-side', collapsed ? '1' : ''); } catch {}
}
$('#toggle-side').onclick = () => setSide(!document.body.classList.contains('side-collapsed'));
try { setSide(localStorage.getItem('bp-side') === '1'); } catch {}

async function refresh(v) {
  view = v || (await window.bp.get());
  $('#keyring-warn').hidden = view.keyring !== 'basic_text';
  renderTree();
  $('#folder-list').replaceChildren(...allFolders().map((f) => el('option', { value: f })));
}

// Every folder path, including parents of "a/b/c" and folders only implied by a connection.
function allFolders() {
  const set = new Set();
  for (const f of [...view.folders, ...view.connections.map((c) => c.folder).filter(Boolean)]) {
    const parts = f.split('/');
    parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/')));
  }
  return [...set];
}

const openFolders = new Set(JSON.parse((() => { try { return localStorage.getItem('bp-open') || '[]'; } catch { return '[]'; } })()));
const saveOpen = () => { try { localStorage.setItem('bp-open', JSON.stringify([...openFolders])); } catch {} };

// Saved order = array order, so these do not sort.
const connsIn = (f) => view.connections.filter((c) => (c.folder || '') === f);
const kidsOf = (parent) => allFolders().filter((f) => f.split('/').length === (parent ? parent.split('/').length + 1 : 1) && (!parent || f.startsWith(parent + '/')));

function renderTree() {
  const build = (parent) => {
    const nodes = kidsOf(parent).map((f) => {
      const total = view.connections.filter((c) => c.folder === f || (c.folder || '').startsWith(f + '/')).length;
      const sum = el('summary', {}, el('span', { textContent: f.split('/').pop() }), el('span', { className: 'count', textContent: total }));
      sum.oncontextmenu = (e) => folderMenu(e, f);
      sum.draggable = true;
      sum.ondragstart = (e) => { e.stopPropagation(); e.dataTransfer.setData('bp/folder', f); };
      dropTarget(sum, f, true);
      const d = el('details', { open: openFolders.has(f) }, sum, ...build(f), ...connsIn(f).map(connRow));
      d.ontoggle = () => { d.open ? openFolders.add(f) : openFolders.delete(f); saveOpen(); };
      return d;
    });
    return nodes;
  };
  $('#tree').replaceChildren(...build(''), ...connsIn('').map(connRow));
}

// Drop on the empty part of the list: back to the top level.
$('#tree').ondragover = (e) => { if (e.target === e.currentTarget && dragKind(e)) e.preventDefault(); };
$('#tree').ondrop = (e) => { if (e.target === e.currentTarget) dropMove(e, ''); };

function connRow(c) {
  const row = el('div', { className: 'conn' + (selected === c.id ? ' sel' : ''), draggable: true, tabIndex: 0, title: `${c.username ? c.username + '@' : ''}${c.host || 'local'}` },
    icon(c.protocol), el('span', { className: 'label', textContent: c.name }), el('span', { className: 'host', textContent: c.host || '' }));
  row.onclick = () => { selected = c.id; document.querySelectorAll('.conn.sel').forEach((n) => n.classList.remove('sel')); row.classList.add('sel'); };
  row.ondblclick = (e) => connect(c.id, e.shiftKey);
  row.onkeydown = (e) => { if (e.key === 'Enter') connect(c.id, e.shiftKey); };
  row.oncontextmenu = (e) => connMenu(e, c);
  row.ondragstart = (e) => e.dataTransfer.setData('bp/conn', c.id);
  dropTarget(row, c.folder || '', false, c.id);
  return row;
}

const dragKind = (e) => ['bp/conn', 'bp/folder'].find((t) => e.dataTransfer.types.includes(t));

// Move what is being dragged into folder `to` ('' = top level), in front of `before` (a connection id or folder path).
async function moveTo(op) {
  const { folder, to } = op;
  const r = await window.bp.move(op);
  if (folder) { // carry the open/closed state of the folder and its subfolders to their new paths
    const dest = (to ? to + '/' : '') + folder.split('/').pop();
    for (const f of [...openFolders]) if (f === folder || f.startsWith(folder + '/')) { openFolders.delete(f); openFolders.add(dest + f.slice(folder.length)); }
    saveOpen();
  }
  refresh(r);
}
function dropMove(e, to, before) {
  const conn = e.dataTransfer.getData('bp/conn');
  const folder = e.dataTransfer.getData('bp/folder');
  if (conn || folder) moveTo({ ...(conn ? { conn } : { folder }), to, before });
}

// A folder row: drop into it (a folder's top edge instead lands the dragged folder in front of it).
// A connection row (isFolder false): drop a connection in front of it.
function dropTarget(node, folder, isFolder, connId) {
  const edge = (e) => isFolder && dragKind(e) === 'bp/folder' && e.offsetY < node.offsetHeight / 4;
  const clear = () => node.classList.remove('drop', 'drop-before');
  node.ondragover = (e) => {
    const k = dragKind(e);
    if (!k || (!isFolder && k !== 'bp/conn')) return;
    e.preventDefault(); e.stopPropagation();
    clear();
    node.classList.add(isFolder && !edge(e) ? 'drop' : 'drop-before');
  };
  node.ondragleave = clear;
  node.ondrop = (e) => {
    e.stopPropagation(); // the tree's own drop means "top level"
    const before = edge(e);
    clear();
    if (!isFolder) dropMove(e, folder, connId);
    else if (before) dropMove(e, folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '', folder);
    else dropMove(e, folder);
  };
}

// Keyboard path: Move up / Move down among siblings.
const upDown = (ids, i, key) => [['Move up', i > 0, ids[i - 1]], ['Move down', i < ids.length - 1, ids[i + 2]]]
  .filter((m) => m[1]).map((m) => [m[0], () => moveTo({ ...key, before: m[2] })]);

// Cancel buttons are type=button so Enter submits the form's real action instead.
document.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => b.closest('dialog').close('cancel')));

// Any failed call to main (keyring, disk) shows up instead of failing silently.
addEventListener('unhandledrejection', (e) => toast(String(e.reason?.message || e.reason).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));

// ---------------------------------------------------------------- context menus

function menu(e, items) {
  e.preventDefault();
  const m = $('#menu');
  m.replaceChildren(...items.map((it) => it === '-' ? el('hr') : el('button', { textContent: it[0], className: it[2] || '', onclick: () => { m.hidden = true; it[1](); } })));
  m.hidden = false;
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + 'px';
}
addEventListener('click', () => ($('#menu').hidden = true));
addEventListener('blur', () => ($('#menu').hidden = true));

function connMenu(e, c) {
  menu(e, [
    ['Connect in new tab', () => connect(c.id)],
    ['Connect in split', () => connect(c.id, true)],
    ...(() => { const sib = connsIn(c.folder || '').map((x) => x.id), m = upDown(sib, sib.indexOf(c.id), { conn: c.id, to: c.folder || '' }); return m.length ? ['-', ...m] : []; })(),
    '-',
    ['Edit…', () => editConn(c)],
    ['Duplicate', () => { const { id, ...rest } = c; editConn({ ...rest, name: c.name + ' copy', copyPasswordFrom: c.hasPassword ? id : undefined }); }],
    ['Bulk edit everyone with this username…', () => openBulk('username', c.username || '')],
    ...(c.protocol === 'ssh' || c.protocol === 'rdp' ? [['Forget saved key', async () => toast(await window.bp.forgetHost(c.id) ? `Forgot the saved key of ${c.host}; the next connect saves the new one` : 'No saved key for this host')]] : []),
    '-',
    ['Delete', async () => { if (confirm(`Delete "${c.name}"?`)) refresh(await window.bp.remove(c.id)); }, 'danger'],
  ]);
}

function folderMenu(e, f) {
  menu(e, [
    ['New connection here…', () => editConn({ folder: f, protocol: 'ssh' })],
    ['New subfolder…', () => newFolder(f + '/')],
    ['Open all in split', () => openFolder(f)],
    ['Bulk edit this folder…', () => openBulk('folder', f)],
    ...(() => { const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', sib = kidsOf(parent), m = upDown(sib, sib.indexOf(f), { folder: f, to: parent }); return m.length ? ['-', ...m] : []; })(),
    '-',
    ['Delete folder', async () => {
      try { refresh(await window.bp.folder({ remove: f })); } catch { toast('Only empty folders can be deleted'); }
    }, 'danger'],
  ]);
}

async function ask(title, value = '') {
  const d = $('#prompt-dlg');
  $('#prompt-title').textContent = title;
  $('#prompt-in').value = value;
  d.showModal();
  return new Promise((res) => {
    d.querySelector('form').onsubmit = () => res($('#prompt-in').value.trim()); // OK or Enter
    d.onclose = () => { if (!d.open) res(null); }; // Esc/Cancel; a late close arriving after a reopen is ignored
  });
}

async function newFolder(prefix = '') {
  const name = await ask('New folder', prefix);
  if (name) { openFolders.add(name); saveOpen(); refresh(await window.bp.folder({ add: name.replace(/^\/+|\/+$/g, '') })); }
}
$('#new-folder').onclick = () => newFolder();

function openFolder(f) {
  const ids = view.connections.filter((c) => c.folder === f || (c.folder || '').startsWith(f + '/')).map((c) => c.id);
  if (ids.length > MAX_PANES) toast(`Opening the first ${MAX_PANES} of ${ids.length}`);
  ids.slice(0, MAX_PANES).forEach((id, i) => connect(id, i > 0));
}

// ---------------------------------------------------------------- edit dialog

const form = $('#edit-form');
const DEFAULT_PORT = { ssh: 22, rdp: 3389, vnc: 5900 };

function editConn(c = { protocol: 'ssh' }) {
  const d = $('#edit-dlg');
  form.reset();
  $('#edit-title').textContent = c.id ? 'Edit connection' : 'New connection';
  for (const k of ['name', 'protocol', 'folder', 'host', 'port', 'username', 'domain', 'keyPath']) form.elements[k].value = c[k] ?? '';
  form.elements.tags.value = (c.tags || []).join(', ');
  form.elements.password.placeholder = c.hasPassword ? (c.copyPasswordFrom ? '•••••• (copied)' : '•••••• (unchanged)') : '';
  $('#clear-pw').hidden = !c.hasPassword;
  form.elements.password.disabled = false;
  form.elements.clearPassword.onchange = (e) => { form.elements.password.disabled = e.target.checked; };
  d.dataset.proto = c.protocol || 'ssh';
  form.elements.adminSession.checked = !!c.adminSession;
  form.elements.port.placeholder = DEFAULT_PORT[d.dataset.proto] || '';
  form.elements.protocol.onchange = () => { d.dataset.proto = form.elements.protocol.value; form.elements.port.placeholder = DEFAULT_PORT[d.dataset.proto] || ''; };
  d.showModal();
  // Save on submit (Save button or Enter; Cancel is not a submit button). Not on close: Chromium can
  // deliver the close event late, after the dialog has already been reopened with other values.
  form.onsubmit = async () => {
    const f = form.elements;
    const conn = {
      id: c.id, name: f.name.value.trim(), protocol: f.protocol.value, folder: f.folder.value.trim().replace(/^\/+|\/+$/g, ''),
      host: f.host.value.trim(), port: f.port.value ? Number(f.port.value) : undefined, username: f.username.value.trim(),
      domain: f.domain.value.trim(), keyPath: f.keyPath.value.trim(),
      tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      copyPasswordFrom: c.copyPasswordFrom, // main copies the encrypted password unless a new one is given
    };
    if (f.clearPassword.checked) conn.password = ''; // '' = remove the saved one
    else if (f.password.value) conn.password = f.password.value; // empty = keep existing
    if (!conn.id) delete conn.id;
    if (conn.folder) { openFolders.add(conn.folder); saveOpen(); }
    conn.adminSession = conn.protocol === 'rdp' && f.adminSession.checked;
    refresh(await window.bp.save(conn));
  };
}
$('#new-conn').onclick = () => editConn({ protocol: 'ssh', folder: selectedFolder() });
const selectedFolder = () => view.connections.find((c) => c.id === selected)?.folder || '';

// ---------------------------------------------------------------- bulk edit

const bform = $('#bulk-form');
let bulkFilter = null;

function openBulk(by = 'username', value = '') {
  bform.reset();
  bform.elements.by.value = by;
  bform.elements.value.value = value;
  $('#bulk-err').hidden = true;
  bulkOptions();
  bulkPreview();
  $('#bulk-dlg').showModal();
}
$('#bulk').onclick = () => openBulk('username', view.connections.find((c) => c.id === selected)?.username || '');

function bulkOptions() {
  const vals = bform.elements.by.value === 'folder' ? allFolders() : [...new Set(view.connections.map((c) => c.username).filter(Boolean))].sort();
  $('#bulk-values').replaceChildren(...vals.map((v) => el('option', { value: v })));
}
bform.elements.by.onchange = () => { bform.elements.value.value = ''; bulkOptions(); bulkPreview(); };
bform.elements.value.oninput = () => bulkPreview();

async function bulkPreview() {
  const by = bform.elements.by.value;
  const value = bform.elements.value.value.trim();
  bulkFilter = value || by === 'username' ? { [by]: value } : null; // empty folder would mean "everything"
  const rows = bulkFilter ? await window.bp.bulkPreview(bulkFilter) : [];
  $('#bulk-matches').replaceChildren(...rows.map((r) => el('label', {},
    el('input', { type: 'checkbox', checked: true, value: r.id }),
    el('span', { textContent: r.name }), el('span', { className: 'meta', textContent: `${r.username || '—'} · ${r.folder || 'no folder'}` }))));
}

$('#bulk-apply').onclick = async (e) => {
  e.preventDefault();
  const f = bform.elements;
  const err = (m) => { $('#bulk-err').textContent = m; $('#bulk-err').hidden = false; };
  const ids = [...document.querySelectorAll('#bulk-matches input:checked')].map((i) => i.value);
  if (!bulkFilter || !ids.length) return err('Nothing selected.');
  if (f.clearPassword.checked && (f.password.value || f.password2.value)) return err('Either set a new password or remove it, not both.');
  if (f.password.value !== f.password2.value) return err('Passwords do not match.');
  const patch = { username: f.username.value.trim() || undefined, password: f.password.value || undefined, domain: f.domain.value.trim() || undefined, clearPassword: f.clearPassword.checked };
  if (!patch.username && !patch.password && !patch.clearPassword && patch.domain === undefined) return err('Fill in at least one new value.');
  const what = patch.clearPassword ? 'Remove the saved password of' : 'Update';
  if (!confirm(`${what} ${ids.length} connection${ids.length > 1 ? 's' : ''}? A backup of the old file is kept.`)) return;
  const res = await window.bp.bulkApply({ ...bulkFilter, ids }, patch);
  $('#bulk-dlg').close();
  refresh(res.view);
  toast(`Updated ${res.count} connection${res.count === 1 ? '' : 's'} 🍌`);
};

// ---------------------------------------------------------------- quick search

const sIn = $('#search-in');
const sList = $('#search-list');
let hits = [];
let hitIdx = 0;

function openSearch() {
  sIn.value = '';
  runSearch();
  $('#search-dlg').showModal();
  sIn.focus();
}
$('#open-search').onclick = openSearch;

function runSearch() {
  const q = sIn.value.trim().toLowerCase();
  // same rule as store.matches: every word must appear somewhere
  hits = view.connections.filter((c) => {
    const hay = [c.name, c.host, c.username, c.domain, c.folder, c.protocol, ...(c.tags || [])].filter(Boolean).join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }).slice(0, 50);
  hitIdx = 0;
  drawHits();
}
function drawHits() {
  sList.replaceChildren(...hits.map((c, i) => {
    const li = el('li', { role: 'option', ariaSelected: String(i === hitIdx) },
      icon(c.protocol), el('span', { textContent: c.name }),
      el('span', { className: 'meta', textContent: `${c.username ? c.username + '@' : ''}${c.host || 'local'} · ${c.folder || '—'}` }));
    li.onclick = (e) => { $('#search-dlg').close(); connect(c.id, e.shiftKey); };
    return li;
  }));
  sList.children[hitIdx]?.scrollIntoView({ block: 'nearest' });
}
sIn.oninput = runSearch;
sIn.onkeydown = (e) => {
  if (e.key === 'ArrowDown') { hitIdx = Math.min(hits.length - 1, hitIdx + 1); drawHits(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { hitIdx = Math.max(0, hitIdx - 1); drawHits(); e.preventDefault(); }
  if (e.key === 'Enter' && hits[hitIdx]) { $('#search-dlg').close(); connect(hits[hitIdx].id, e.shiftKey); }
};

// ---------------------------------------------------------------- tabs and panes
// tab  = { id, layout: 'h'|'v'|'grid', panes: [pane], active: pane, root: <div.split> }
// pane = { id, title, protocol, root, body, term?, fit?, sid?, guac?, dispose() }

const tabs = [];
let current = null;
const stage = $('#stage');

function newTab() {
  const t = { id: crypto.randomUUID(), layout: 'h', panes: [], active: null, root: el('div', { className: 'split' }) };
  stage.append(t.root);
  tabs.push(t);
  return t;
}

function selectTab(t) {
  if (fsPane && !t?.panes.includes(fsPane)) leaveFull();
  current = t;
  for (const x of tabs) x.root.hidden = x !== t;
  if (t?.active) focusPane(t.active);
  render();
}

function render() {
  $('#empty').hidden = tabs.length > 0;
  $('#fullscreen').disabled = !current?.active;
  $('#tabs').replaceChildren(...tabs.map((t) => {
    const title = t.panes.length === 1 ? t.panes[0].title : `${t.panes.length} sessions`;
    const tab = el('div', { className: 'tab' + (t === current ? ' active' : ''), title },
      icon(t.panes.length === 1 ? t.panes[0].protocol : 'mixed'), el('span', { className: 't', textContent: title }),
      el('button', { className: 'x', textContent: '×', title: 'Close tab', onclick: (e) => { e.stopPropagation(); closeTab(t); } }));
    tab.onclick = () => selectTab(t);
    tab.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    paneDrop(tab, () => t);
    return tab;
  }));
  for (const t of tabs) layout(t);
  document.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', current?.layout === b.dataset.layout && current.panes.length > 1));
}

// Rebuild a tab's split: panes in order with a gutter between each pair.
function layout(t) {
  const single = t.panes.length === 1;
  t.root.className = 'split ' + (single ? 'single' : t.layout);
  const kids = [];
  t.panes.forEach((p, i) => {
    if (i > 0) kids.push(gutter(t, i));
    p.root.classList.toggle('active', p === t.active && !single);
    kids.push(p.root);
  });
  t.root.replaceChildren(...kids);
}

// Drag between two panes to resize them (h / v layouts).
function gutter(t, i) {
  const g = el('div', { className: 'gutter' });
  g.onpointerdown = (e) => {
    const a = t.panes[i - 1].root, b = t.panes[i].root;
    const horiz = t.layout === 'h';
    const size = (n) => (horiz ? n.getBoundingClientRect().width : n.getBoundingClientRect().height);
    const total = size(a) + size(b);
    const start = horiz ? e.clientX : e.clientY;
    const sa = size(a);
    const grow = (Number(a.style.flexGrow) || 1) + (Number(b.style.flexGrow) || 1);
    g.setPointerCapture(e.pointerId);
    g.classList.add('dragging');
    g.onpointermove = (m) => {
      const na = Math.max(80, Math.min(total - 80, sa + (horiz ? m.clientX : m.clientY) - start));
      a.style.flexGrow = (grow * na) / total;
      b.style.flexGrow = grow - a.style.flexGrow;
    };
    g.onpointerup = () => { g.onpointermove = null; g.classList.remove('dragging'); };
  };
  return g;
}

document.querySelectorAll('[data-layout]').forEach((b) => (b.onclick = () => {
  if (!current) return;
  current.layout = b.dataset.layout;
  current.panes.forEach((p) => (p.root.style.flexGrow = ''));
  render();
}));

function focusPane(p) {
  const t = tabs.find((x) => x.panes.includes(p));
  if (!t) return;
  t.active = p;
  for (const x of t.panes) x.root.classList.toggle('active', x === p && t.panes.length > 1);
  (p.term || p.body).focus();
}

function movePane(p, to) {
  const from = tabs.find((x) => x.panes.includes(p));
  if (from === to) return;
  if (to && to.panes.length >= MAX_PANES) return toast(`A tab holds up to ${MAX_PANES} sessions`);
  to ||= newTab();
  from.panes.splice(from.panes.indexOf(p), 1);
  if (from.active === p) from.active = from.panes[0] || null;
  to.panes.push(p);
  to.active = p;
  if (!from.panes.length) dropTab(from);
  selectTab(to);
}

// Where pane headers can be dropped: a tab (join it) or empty tab bar (new tab).
function paneDrop(node, target) {
  node.ondragover = (e) => { if (e.dataTransfer.types.includes('bp/pane')) { e.preventDefault(); e.stopPropagation(); node.classList.add('drop'); } };
  node.ondragleave = () => node.classList.remove('drop');
  node.ondrop = (e) => {
    e.stopPropagation();
    node.classList.remove('drop');
    const p = allPanes().find((x) => x.id === e.dataTransfer.getData('bp/pane'));
    if (p) movePane(p, target());
  };
}
paneDrop($('#tabs'), () => null);
const allPanes = () => tabs.flatMap((t) => t.panes);

$('#merge').onclick = () => {
  if (!current) return;
  for (const p of allPanes()) if (!current.panes.includes(p) && current.panes.length < MAX_PANES) movePane(p, current);
  if (current.layout === 'h' && current.panes.length > 2) current.layout = 'grid';
  selectTab(current);
};
$('#explode').onclick = () => {
  if (!current) return;
  const keep = current;
  for (const p of [...current.panes].slice(1)) movePane(p, null);
  selectTab(keep);
};

// Full screen current: pin the active pane over the window (no re-parenting, so the session
// keeps running) and full-screen the real window. The pane's own ResizeObserver re-fits it.
let fsPane = null;
function enterFull() {
  const p = current?.active;
  if (!p || fsPane) return;
  fsPane = p;
  p.root.classList.add('full');
  $('#fs-banana').hidden = false;
  window.bp.fullScreen(true);
  p.body.focus();
}
function leaveFull() {
  if (!fsPane) return;
  const p = fsPane;
  fsPane = null;
  p.root.classList.remove('full');
  $('#fs-banana').hidden = true;
  window.bp.fullScreen(false);
  (p.term || p.body).focus();
}
const toggleFull = () => (fsPane ? leaveFull() : enterFull());
$('#fullscreen').onclick = enterFull;
$('#fs-back').onclick = leaveFull;
$('#fs-min').onclick = () => window.bp.minimize();

function closePane(p) {
  p.closed = true;
  if (p === fsPane) leaveFull();
  p.dispose();
  const t = tabs.find((x) => x.panes.includes(p));
  if (!t) return;
  t.panes.splice(t.panes.indexOf(p), 1);
  if (t.active === p) t.active = t.panes[0] || null;
  if (!t.panes.length) dropTab(t);
  selectTab(tabs.includes(current) ? current : tabs.at(-1) || null);
}
function closeTab(t) { for (const p of [...t.panes]) closePane(p); }
function dropTab(t) {
  tabs.splice(tabs.indexOf(t), 1);
  t.root.remove();
  if (current === t) current = tabs.at(-1) || null;
}

function makePane(title, protocol) {
  const p = { id: crypto.randomUUID(), title, protocol, dispose: () => {} };
  const head = el('div', { className: 'pane-head', draggable: true, title: 'Drag onto a tab to move this session' },
    icon(protocol), el('span', { className: 't', textContent: title }),
    el('button', { className: 'icon-btn small', textContent: '⇱', title: 'Own tab', onclick: () => movePane(p, null) }),
    el('button', { className: 'icon-btn small', textContent: '×', title: 'Close', onclick: () => closePane(p) }));
  head.ondragstart = (e) => e.dataTransfer.setData('bp/pane', p.id);
  p.body = el('div', { className: 'pane-body', tabIndex: -1 });
  p.root = el('div', { className: 'pane' }, head, p.body);
  p.root.addEventListener('pointerdown', () => focusPane(p), true);
  p.root.addEventListener('focusin', () => focusPane(p));
  return p;
}

function status(p, text, err = false) {
  p.body.querySelector('.status')?.remove();
  if (text == null) return;
  p.body.append(el('div', { className: 'status' + (err ? ' err' : '') }, el('img', { src: `svg/${err ? 'coconut' : 'banana'}.svg`, alt: '' }), el('div', { textContent: text })));
}

// Open a connection: new tab, or (split) beside the current tab's sessions.
async function connect(connId, split = false) {
  const c = connId === 'local' ? { id: 'local', name: 'Terminal', protocol: 'local' } : view.connections.find((x) => x.id === connId);
  if (!c) return;
  const p = makePane(c.name, c.protocol);
  let t = split && current && current.panes.length < MAX_PANES ? current : newTab();
  if (split && t === current && t.layout === 'h' && t.panes.length >= 2) t.layout = 'grid';
  t.panes.push(p);
  t.active = p;
  selectTab(t);
  try {
    if (c.protocol === 'rdp' || c.protocol === 'vnc') await openRemote(p, c);
    else await openTerm(p, c);
  } catch (e) {
    status(p, String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  }
}

// ---------------------------------------------------------------- terminals

const terms = new Map(); // session id -> pane

async function openTerm(p, c) {
  const term = new Terminal({ fontFamily: 'ui-monospace, "DejaVu Sans Mono", monospace', fontSize: 14, cursorBlink: true, theme: termTheme() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const box = el('div', { className: 'term' });
  p.body.append(box);
  term.open(box);
  fit.fit();
  p.term = term;
  p.fit = fit;
  const res = await window.bp.open(c.id, term.cols, term.rows);
  if (p.closed) { window.bp.close(res.id); term.dispose(); return; } // pane closed while connecting
  p.sid = res.id;
  terms.set(p.sid, p);
  term.onData((d) => window.bp.write(p.sid, d));
  // Ctrl+Shift+C / Ctrl+Shift+V, as in most Linux terminals (plain Ctrl+C must stay "interrupt").
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) { window.bp.clipboardWrite(term.getSelection()); return false; }
    if (k === 'v') { e.preventDefault(); window.bp.clipboardRead().then((t) => t && term.paste(clean(t))); return false; }
    return true;
  });
  term.onResize(({ cols, rows }) => window.bp.resize(p.sid, cols, rows));
  const ro = new ResizeObserver(() => { if (box.offsetWidth) fit.fit(); });
  ro.observe(box);
  p.dispose = () => { ro.disconnect(); window.bp.close(p.sid); terms.delete(p.sid); term.dispose(); };
  term.focus();
}

window.bp.onData((id, d) => terms.get(id)?.term.write(d));
window.bp.onExit((id) => {
  const p = terms.get(id);
  if (!p) return;
  terms.delete(id);
  if (p === fsPane) leaveFull();
  p.term.write('\r\n\x1b[2m[session ended — press any key to close]\x1b[0m');
  p.term.onKey(() => closePane(p));
});

// ---------------------------------------------------------------- remote desktops (guacamole)

async function openRemote(p, c) {
  status(p, `Connecting to ${c.host}…`);
  const { url, notice } = await window.bp.open(c.id);
  if (notice) toast(notice, 12000); // long enough to compare the fingerprint
  if (p.closed) return; // pane closed while guacd was starting
  const [base, query] = url.split('?');
  const client = new Guacamole.Client(new Guacamole.WebSocketTunnel(base));
  const display = client.getDisplay();
  const wrap = el('div', { className: 'remote' }, display.getElement());
  p.body.append(wrap);
  p.body.tabIndex = 0;
  p.guac = client;

  // Scale the remote screen to fit the pane, and ask the server to match the pane size.
  const fitDisplay = () => {
    const w = p.body.clientWidth, h = p.body.clientHeight;
    if (!w || !h) return;
    if (display.getWidth()) display.scale(Math.min(w / display.getWidth(), h / display.getHeight()));
  };
  let sizeTimer;
  const ro = new ResizeObserver(() => {
    fitDisplay();
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => p.body.clientWidth && client.sendSize(p.body.clientWidth, p.body.clientHeight), 300);
  });
  ro.observe(p.body);
  display.onresize = fitDisplay;

  const clip = shareClipboard(client, p.body, window.bp);
  client.onstatechange = (s) => {
    if (s === 3) { status(p, null); clip.onConnected(); } // CONNECTED
    if (s === 5 && !p.closed && !p.failed) { status(p, 'Disconnected', true); if (p === fsPane) leaveFull(); }
  };
  client.onerror = (e) => {
    // Status 0 (SUCCESS) is guacd's normal end, e.g. "Manually logged off." when you sign out: just close.
    if (e.code === 0) return void (p.closed || closePane(p));
    p.failed = true; if (p === fsPane) leaveFull();
    status(p, `${c.host}: ${e.message || 'connection error'}`, true);
  };

  const mouse = new Guacamole.Mouse(display.getElement());
  mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e) => { client.sendMouseState(e.state, true); });
  // Keyboard only reaches this pane while it has focus, so splits never share keystrokes.
  const kb = new Guacamole.Keyboard(p.body);
  kb.onkeydown = (k) => { client.sendKeyEvent(1, k); return false; };
  kb.onkeyup = (k) => client.sendKeyEvent(0, k);

  const dpi = Math.round(96 * devicePixelRatio);
  client.connect(`${query}&width=${p.body.clientWidth || 1024}&height=${p.body.clientHeight || 768}&dpi=${dpi}`);
  p.dispose = () => { p.closed = true; ro.disconnect(); kb.reset(); client.disconnect(); };
  p.body.focus();
}

// ---------------------------------------------------------------- shortcuts

$('#new-term').onclick = (e) => connect('local', e.shiftKey);
addEventListener('keydown', (e) => {
  const remoteFocused = document.activeElement?.closest('.pane-body') && current?.active?.guac;
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !remoteFocused) { e.preventDefault(); openSearch(); }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); connect('local'); }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b' && !remoteFocused) { e.preventDefault(); $('#toggle-side').click(); }
  if (e.ctrlKey && e.key === 'Tab' && tabs.length) {
    e.preventDefault();
    selectTab(tabs[(tabs.indexOf(current) + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]);
  }
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'f' && (fsPane || current?.active)) { e.preventDefault(); e.stopPropagation(); toggleFull(); }
  // Ctrl+Alt+Arrow: move focus between panes in this tab
  if (e.ctrlKey && e.altKey && e.key.startsWith('Arrow') && current?.panes.length > 1) {
    e.preventDefault();
    const i = current.panes.indexOf(current.active);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    focusPane(current.panes[(i + step + current.panes.length) % current.panes.length]);
  }
}, true);

refresh();
