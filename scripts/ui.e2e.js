// End-to-end UI test: starts the real app with a throwaway profile and drives it through the
// Chrome DevTools Protocol (CDP), with real mouse and keyboard events. Run with `npm run test:ui`
// (needs Electron and node-pty built, plus a display: CI wraps it in xvfb-run).
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron'); // in plain Node this is the path to the Electron binary

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ui-'));
  const args = ['.', '--remote-debugging-port=0', `--user-data-dir=${profile}`];
  if (process.env.CI) args.push('--no-sandbox'); // CI runners cannot set up Chromium's sandbox
  const proc = spawn(electron, args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((r) => proc.once('exit', r));
  const cleanup = async () => { proc.kill(); await exited; fs.rmSync(profile, { recursive: true, force: true }); };
  try {
    return await connect(proc, cleanup);
  } catch (e) {
    await cleanup(); // never leave the app (or its profile) behind when start-up fails
    throw e;
  }
}

async function connect(proc, cleanup) {
  // Chromium prints "DevTools listening on ws://127.0.0.1:<port>/..." once it is ready.
  const port = await new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
      if (m) resolve(m[1]);
    });
    proc.on('exit', (code) => reject(new Error(`app exited (${code}) before DevTools was ready:\n${err}`)));
    setTimeout(() => reject(new Error(`DevTools did not start within 30 s:\n${err}`)), 30000).unref();
  });
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('the app opened no window');
  // Node's built-in WebSocket (same API as in browsers).
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect to DevTools')); });
  // Each request carries an id; the reply with the same id settles that request's Promise.
  const pending = new Map();
  let n = 0;
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    const p = pending.get(d.id);
    if (!p) return; // events, not replies
    pending.delete(d.id);
    d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
  };
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('the app closed the DevTools connection')); pending.clear(); };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await call('Emulation.setFocusEmulationEnabled', { enabled: true }); // behave as if the window has focus
  const app = {
    async eval(expr) {
      const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, ms = 10000) {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await app.eval(expr)) return;
      const seen = await app.eval(`(async () => JSON.stringify({ tabs: ${count('.tab')}, panes: ${count('.pane')}, visible: ${visiblePanes}, dialogs: ${count('dialog[open]')},
        saved: (await window.bp.get()).connections.map((c) => c.name) }))()`);
      throw new Error(`timed out waiting for: ${expr}\n  page state: ${seen}`);
    },
    async center(selector) {
      const r = await app.eval(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
      return { x: r[0], y: r[1] };
    },
    mouse: (type, { x, y }, extra = {}) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }),
    async click(selector, modifiers = 0) {
      const at = await app.center(selector);
      await app.mouse('mousePressed', at, { modifiers });
      await app.mouse('mouseReleased', at, { modifiers });
    },
    async drag(selector, dx, dy) {
      const from = await app.center(selector);
      await app.mouse('mousePressed', from);
      for (let i = 1; i <= 5; i++) await app.mouse('mouseMoved', { x: from.x + (dx * i) / 5, y: from.y + (dy * i) / 5 });
      await app.mouse('mouseReleased', { x: from.x + dx, y: from.y + dy });
    },
    async key(key, code = key, keyCode) {
      const k = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      if (key === 'Enter') await call('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...k });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    },
    type: (text) => call('Input.insertText', { text }),
    async close() { ws.close(); await cleanup(); },
  };
  await app.waitFor('document.readyState === "complete" && !!window.bp && document.querySelector("#new-term").getBoundingClientRect().width > 0');
  return app;
}

const SHIFT = 8; // CDP modifier bit
const count = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).length`;
const visiblePanes = 'document.querySelectorAll(".split:not([hidden]) > .pane").length';
const size = (i, dim) => `document.querySelectorAll(".split:not([hidden]) > .pane")[${i}].getBoundingClientRect().${dim}`;

test('tabs, splits, gutter and dialogs', { timeout: 120000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close()); // awaited: the app exits and its profile is removed

  await t.test('terminal opens in its own tab', async () => {
    await app.click('#new-term');
    await app.waitFor(`${count('.tab')} === 1 && ${count('.xterm')} === 1`);
  });

  await t.test('Shift+Terminal splits, the third pane switches to a 2x2 grid', async () => {
    for (let i = 0; i < 3; i++) await app.click('#new-term', SHIFT);
    await app.waitFor(`${visiblePanes} === 4`);
    assert.strictEqual(await app.eval(count('.tab')), 1);
    assert.ok(await app.eval('document.querySelector(".split:not([hidden])").classList.contains("grid")'));
  });

  await t.test('a fifth session gets a new tab (4 per tab)', async () => {
    await app.click('#new-term', SHIFT);
    await app.waitFor(`${count('.tab')} === 2`);
    await app.click('.tab.active .x');
    await app.waitFor(`${count('.tab')} === 1 && ${visiblePanes} === 4`);
  });

  await t.test('side-by-side gutter drag widens the first pane', async () => {
    await app.click('[data-layout="h"]');
    await app.waitFor('document.querySelector(".split:not([hidden])").classList.contains("h")');
    const before = await app.eval(size(0, 'width'));
    await app.drag('.split:not([hidden]) > .gutter', 120, 0);
    const after = await app.eval(size(0, 'width'));
    assert.ok(Math.abs(after - before - 120) < 15, `width ${before} -> ${after}, expected about +120`);
  });

  await t.test('stacked gutter drag makes the first pane taller', async () => {
    await app.click('[data-layout="v"]');
    await app.waitFor('document.querySelector(".split:not([hidden])").classList.contains("v")');
    const before = await app.eval(size(0, 'height'));
    await app.drag('.split:not([hidden]) > .gutter', 0, 60);
    const after = await app.eval(size(0, 'height'));
    assert.ok(Math.abs(after - before - 60) < 15, `height ${before} -> ${after}, expected about +60`);
  });

  await t.test('Tab all, then Split all', async () => {
    await app.click('#explode');
    await app.waitFor(`${count('.tab')} === 4 && ${visiblePanes} === 1`);
    await app.click('#merge');
    await app.waitFor(`${count('.tab')} === 1 && ${visiblePanes} === 4`);
  });

  await t.test('Full screen current fills the window, Back to tab restores the split', async () => {
    const rect = 'JSON.stringify(document.querySelector(".pane.full")?.getBoundingClientRect().toJSON())';
    await app.click('.split:not([hidden]) > .pane ~ .pane');
    await app.click('#fullscreen');
    await app.waitFor('!!document.querySelector(".pane.full") && !document.querySelector("#fs-banana").hidden');
    await app.waitFor(`(() => { const r = JSON.parse(${rect}); return r.width === innerWidth && r.height === innerHeight; })()`);
    assert.strictEqual(await app.eval(count('.pane.full')), 1);
    await app.mouse('mouseMoved', await app.center('#fs-banana img')); // hovering the banana reveals the buttons
    await app.click('#fs-back');
    await app.waitFor(`!document.querySelector(".pane.full") && ${visiblePanes} === 4 && document.querySelector("#fs-banana").hidden`);
    assert.strictEqual(await app.eval(count('.xterm')), 4);
  });

  await t.test('the pane button pops a session into its own tab', async () => {
    await app.click('.split:not([hidden]) > .pane ~ .pane button[title="Own tab"]');
    await app.waitFor(`${count('.tab')} === 2 && ${visiblePanes} === 1`);
  });

  await t.test('edit dialog: Esc cancels, Enter saves, Esc after a save still cancels', async () => {
    const names = '(async () => (await window.bp.get()).connections.map((c) => c.name).join())()';
    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open && document.activeElement.name === "name"');
    await app.type('nope');
    await app.key('Escape', 'Escape', 27);
    await app.waitFor('!document.querySelector("#edit-dlg").open');
    assert.strictEqual(await app.eval(names), '');

    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open && document.activeElement.name === "name"');
    await app.type('kept');
    await app.key('Enter', 'Enter', 13);
    await app.waitFor(`(async () => (await ${names}) === "kept")()`);

    // Save and reopen straight away: the save must not be lost or repeated.
    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open && document.activeElement.name === "name"');
    await app.type('quick');
    await app.key('Enter', 'Enter', 13);
    await app.click('#new-conn');
    await app.waitFor(`(async () => (await ${names}) === "kept,quick")()`);
    await app.key('Escape', 'Escape', 27);
    await app.waitFor('!document.querySelector("#edit-dlg").open');

    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open && document.activeElement.name === "name"');
    await app.type('nope2');
    await app.key('Escape', 'Escape', 27);
    await app.waitFor('!document.querySelector("#edit-dlg").open');
    await sleep(300);
    assert.strictEqual(await app.eval(names), 'kept,quick');
  });

  await t.test('folder prompt: Esc cancels, Enter creates the folder', async () => {
    const folders = '(async () => (await window.bp.get()).folders.join())()';
    await app.click('#new-folder');
    await app.waitFor('document.querySelector("#prompt-dlg").open && document.activeElement.id === "prompt-in"');
    await app.type('Nope');
    await app.key('Escape', 'Escape', 27);
    await app.waitFor('!document.querySelector("#prompt-dlg").open');
    await app.click('#new-folder');
    await app.waitFor('document.querySelector("#prompt-dlg").open && document.activeElement.id === "prompt-in"');
    await app.type('Lab');
    await app.key('Enter', 'Enter', 13);
    await app.waitFor(`(async () => (await ${folders}) === "Lab")()`);
    assert.ok(await app.eval('document.querySelector("#tree").textContent.includes("Lab")'));
  });

  await t.test('dragging a connection onto a folder moves it and the order is saved', async () => {
    const where = '(async () => (await window.bp.get()).connections.map((c) => c.name + ":" + (c.folder || "")).join())()';
    assert.strictEqual(await app.eval(where), 'kept:,quick:');
    // Real mouse drags do not start HTML5 drag-and-drop through CDP, so dispatch the drag events.
    await app.eval(`(() => {
      const dt = new DataTransfer();
      const fire = (n, type) => n.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      const row = [...document.querySelectorAll('.conn')].find((n) => n.textContent.startsWith('quick'));
      const lab = [...document.querySelectorAll('#tree summary')].find((n) => n.textContent.startsWith('Lab'));
      fire(row, 'dragstart'); fire(lab, 'dragover'); fire(lab, 'drop');
    })()`);
    await app.waitFor(`(async () => (await ${where}) === "kept:,quick:Lab")()`);
  });

  await t.test('folders: set an icon, drag a folder into another with its contents, only empty folders delete', async () => {
    const state = '(async () => { const v = await window.bp.get(); return JSON.stringify([v.folders, v.folderIcons, v.connections.map((c) => c.folder || "")]); })()';
    const row = (name) => `[...document.querySelectorAll('#tree summary')].find((n) => n.textContent.startsWith('${name}'))`;
    const menu = (name, item) => `(() => { ${row(name)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      [...document.querySelectorAll('#menu button')].find((b) => b.textContent === '${item}').click(); })()`;
    await app.click('#new-folder');
    await app.waitFor('document.querySelector("#prompt-dlg").open && document.activeElement.id === "prompt-in"');
    await app.type('Box');
    await app.key('Enter', 'Enter', 13);
    await app.waitFor(`!!${row('Box')}`);

    await app.eval(menu('Lab', 'Change icon…'));
    await app.waitFor('document.querySelector("#icon-dlg").open');
    assert.ok(await app.eval('document.querySelector(\'#icon-grid .pic[title="crate"]\').ariaPressed === "true"')); // no icon yet = the crate
    await app.click('#icon-grid .pic[title="kiwi"]');
    await app.waitFor(`${row('Lab')}.querySelector('img').src.endsWith('svg/kiwi.svg')`);

    // Dropped on the middle of the Box row: into it (the top quarter would mean "in front of it").
    await app.eval(`(() => {
      const dt = new DataTransfer();
      const box = ${row('Box')}, r = box.getBoundingClientRect();
      const fire = (n, type) => n.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      fire(${row('Lab')}, 'dragstart'); fire(box, 'dragover'); fire(box, 'drop');
    })()`);
    const moved = JSON.stringify([['Box', 'Box/Lab'], { 'Box/Lab': 'kiwi' }, ['', 'Box/Lab']]);
    await app.waitFor(`(async () => (await ${state}) === ${JSON.stringify(moved)})()`);
    await app.waitFor(`${row('Lab')}.querySelector('img').src.endsWith('svg/kiwi.svg')`); // the icon came along

    await app.eval(menu('Box', 'Delete folder'));
    await app.waitFor('!document.querySelector("#toast").hidden && document.querySelector("#toast").textContent === "Only empty folders can be deleted"');
    assert.strictEqual(await app.eval(state), moved);
  });

  await t.test('the sidebar grip widens the list, collapse still hides it, and the width survives a reload', async () => {
    const sideW = 'document.querySelector("#side").getBoundingClientRect().width';
    const before = await app.eval(sideW);
    await app.drag('#side-grip', 150, 0);
    const after = await app.eval(sideW);
    assert.ok(Math.abs(after - before - 150) < 10, `width ${before} -> ${after}, expected about +150`);
    await app.click('#toggle-side');
    await app.waitFor('document.querySelector("#side").getBoundingClientRect().right <= 0'); // slid fully out at the new width
    await app.click('#toggle-side');
    await app.waitFor(`Math.abs(document.querySelector("#side").getBoundingClientRect().left) < 1`);
    await app.eval('location.reload()'); // last test: the reload drops every open session
    await app.waitFor(`document.readyState === "complete" && Math.abs(${sideW} - ${after}) < 2`);
  });
});
