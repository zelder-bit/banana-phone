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

// saved: what connections.json holds when the app starts (default: no file).
async function launch(saved) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ui-'));
  if (saved) fs.writeFileSync(path.join(profile, 'connections.json'), JSON.stringify(saved));
  const args = ['--inspect=0', '.', '--remote-debugging-port=0', `--user-data-dir=${profile}`]; // --inspect: see `main` below
  if (process.env.CI) args.push('--no-sandbox'); // CI runners cannot set up Chromium's sandbox
  const proc = spawn(electron, args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((r) => proc.once('exit', r));
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  // Runs an expression in the main process, through Node's inspector: for what no click in the page
  // can reach, such as the system's folder dialog.
  let inspector; // its address, set below once Node has printed it
  const main = (expr) => new Promise((resolve, reject) => {
    const ws = new WebSocket(inspector);
    ws.onerror = () => reject(new Error('could not connect to the main process'));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, includeCommandLineAPI: true } })); // which is what gives the expression `require`
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== 1) return;
      ws.close();
      d.error || d.result.exceptionDetails ? reject(new Error(`main process: ${JSON.stringify(d.error || d.result.exceptionDetails)}`)) : resolve();
    };
  });
  const cleanup = async () => { proc.kill(); await exited; fs.rmSync(profile, { recursive: true, force: true }); };
  try {
    const app = await connect(proc, cleanup);
    // Node prints "Debugger listening on ws://…" on stderr too, but nothing says it comes before the window is ready.
    for (const end = Date.now() + 10000; !(inspector = /Debugger listening on (ws:\S+)/.exec(log)?.[1]); await sleep(50)) {
      if (Date.now() > end) throw new Error(`the main process's inspector did not start within 10 s:\n${log}`);
    }
    return Object.assign(app, { profile, main }); // profile: where this run's connections.json is
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
const visiblePanes = 'document.querySelectorAll(".split:not([hidden]) .pane").length';
const size = (i, dim) => `document.querySelectorAll(".split:not([hidden]) .pane")[${i}].getBoundingClientRect().${dim}`;

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

  await t.test('a tab holds eight sessions in a 3+3+2 grid, a ninth gets a new tab', async () => {
    for (let i = 0; i < 4; i++) await app.click('#new-term', SHIFT);
    await app.waitFor(`${visiblePanes} === 8 && ${count('.xterm')} === 8`);
    assert.strictEqual(await app.eval(count('.tab')), 1);
    assert.strictEqual(await app.eval('[...document.querySelectorAll(".split:not([hidden]) > .node > .node")].map((row) => row.children.length).join()'), '5,5,3'); // panes and the gutters between them
    await app.click('#new-term', SHIFT);
    await app.waitFor(`${count('.tab')} === 2`);
    await app.click('.tab.active .x');
    await app.waitFor(`${count('.tab')} === 1 && ${visiblePanes} === 8`);
    // Back to four for the steps below: closing a pane leaves the others where they are.
    for (let n = 7; n >= 4; n--) {
      await app.eval('[...document.querySelectorAll(".split:not([hidden]) .pane button[title=Close]")].at(-1).click()');
      await app.waitFor(`${visiblePanes} === ${n}`);
    }
    assert.strictEqual(await app.eval(count('.xterm')), 4);
  });

  await t.test('side-by-side gutter drag widens the first pane', async () => {
    await app.click('[data-layout="h"]');
    await app.waitFor('document.querySelector(".split:not([hidden])").classList.contains("h")');
    const before = await app.eval(size(0, 'width'));
    await app.drag('.split:not([hidden]) .gutter', 120, 0);
    const after = await app.eval(size(0, 'width'));
    assert.ok(Math.abs(after - before - 120) < 15, `width ${before} -> ${after}, expected about +120`);
  });

  await t.test('stacked gutter drag makes the first pane taller', async () => {
    await app.click('[data-layout="v"]');
    await app.waitFor('document.querySelector(".split:not([hidden])").classList.contains("v")');
    const before = await app.eval(size(0, 'height'));
    await app.drag('.split:not([hidden]) .gutter', 0, 60);
    const after = await app.eval(size(0, 'height'));
    assert.ok(Math.abs(after - before - 60) < 15, `height ${before} -> ${after}, expected about +60`);
    // Adding a session keeps the dragged size: the first pane is still the taller one.
    await app.click('#new-term', SHIFT);
    await app.waitFor(`${visiblePanes} === 5 && ${count('.xterm')} === 5`);
    assert.ok(await app.eval('document.querySelector(".split:not([hidden])").classList.contains("v")'));
    const [first, second] = [await app.eval(size(0, 'height')), await app.eval(size(1, 'height'))];
    assert.ok(first - second > 40, `first pane ${first} should still be taller than the second ${second}`);
    await app.eval('[...document.querySelectorAll(".split:not([hidden]) .pane button[title=Close]")].at(-1).click()');
    await app.waitFor(`${visiblePanes} === 4`);
  });

  await t.test('nested splits: split a pane down, then right; inner gutter drag; Shift+open; Duplicate; closing collapses', async () => {
    // Panes by position in reading order; each as [x, y, width, height], rounded.
    const rects = async () => JSON.parse(await app.eval(`JSON.stringify([...document.querySelectorAll('.split:not([hidden]) .pane')].map((p) => { const r = p.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }))`));
    const paneMenu = (i, item) => app.eval(`(() => { document.querySelectorAll('.split:not([hidden]) .pane-head')[${i}].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.textContent === '${item}').click(); })()`);
    const near = (a, b, what) => assert.ok(Math.abs(a - b) < 3, `${what}: ${a} vs ${b}`);
    const same = (r, r0, what) => assert.ok(r.every((v, i) => Math.abs(v - r0[i]) < 2), `${what}: ${r} vs ${r0}`); // a pixel of rounding is fine
    await app.click('[data-layout="grid"]');
    await app.waitFor('document.querySelector(".split:not([hidden])").classList.contains("grid")');
    const [a0, b0] = await rects(); // the 2x2 grid: a b / c d

    await paneMenu(1, 'Split down'); // b becomes b over e, inside the top row: a | (b / e)
    await app.waitFor(`${visiblePanes} === 5 && ${count('.xterm')} === 5`);
    assert.ok(await app.eval('document.querySelector(".split:not([hidden])").classList.contains("custom")'));
    assert.strictEqual(await app.eval(count('.layouts .on')), 0, 'no toolbar layout is lit for a hand-made split');
    let [a, b, e, c] = await rects();
    same(a, a0, 'the pane beside the split one did not move');
    near(e[0], b[0], 'e sits under b'); near(e[2], b0[2], 'e is as wide as b was');
    near(b[3] + e[3] + 6, b0[3], 'b and e share the height b had');
    near(c[1], a0[1] + a0[3] + 6, 'the bottom row did not move');

    const before = b;
    await app.drag('.split:not([hidden]) .node .node .node > .gutter', 0, 30); // the gutter between b and e, three levels down
    [a, b, e, c] = await rects();
    assert.ok(Math.abs(b[3] - before[3] - 30) < 10, `height ${before[3]} -> ${b[3]}, expected about +30`);
    near(b[3] + e[3] + 6, b0[3], 'only b and e changed');
    same(a, a0, 'a is untouched by the inner drag');

    await paneMenu(2, 'Split right'); // e becomes e | f: a | (b / (e | f))
    await app.waitFor(`${visiblePanes} === 6 && ${count('.xterm')} === 6`);
    const [, b2, e2, f2] = await rects();
    same(b2, b, 'the dragged size survived a redraw');
    near(f2[1], e2[1], 'f is beside e'); near(e2[2] + f2[2] + 6, b2[2], 'e and f share the width e had');
    near(f2[0], e2[0] + e2[2] + 6, 'f is to the right of e');

    // Shift+open in a hand-made layout splits the active pane (f, wider than tall, so to its right).
    await app.click('#new-term', SHIFT);
    await app.waitFor(`${visiblePanes} === 7 && ${count('.xterm')} === 7`);
    const seven = await rects(), [, , e3, f3, g3] = seven;
    near(g3[1], f3[1], 'g is beside f'); near(e3[2] + f3[2] + g3[2] + 12, b2[2], 'e, f and g share the width');
    assert.strictEqual(await app.eval(count('.tab')), 1);

    // Duplicate keeps the arrangement and the dragged sizes.
    await app.eval(`(() => { document.querySelector('.tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Duplicate').click(); })()`);
    await app.waitFor(`${count('.tab')} === 2 && ${visiblePanes} === 7 && ${count('.xterm')} === 14`);
    (await rects()).forEach((r, i) => same(r, seven[i], `pane ${i} of the copy`));
    await app.click('.tab.active .x');
    await app.waitFor(`${count('.tab')} === 1 && ${visiblePanes} === 7`);

    // Close e, f, then g: each split left with one child collapses, back to the 2x2 arrangement.
    for (const n of [6, 5, 4]) {
      await app.eval(`document.querySelectorAll('.split:not([hidden]) .pane button[title=Close]')[2].click()`);
      await app.waitFor(`${visiblePanes} === ${n}`);
    }
    assert.strictEqual(await app.eval(count('.split:not([hidden]) .node .node .node')), 0);
    assert.ok(await app.eval('document.querySelector(".split:not([hidden])").classList.contains("grid") && document.querySelector("[data-layout=grid]").classList.contains("on")'), 'it is a grid again, and the toolbar says so');
    assert.deepStrictEqual((await rects()).slice(0, 2), [a0, b0]);
  });

  await t.test('Tab all, then Split all', async () => {
    await app.click('#explode');
    await app.waitFor(`${count('.tab')} === 4 && ${visiblePanes} === 1`);
    await app.click('#merge');
    await app.waitFor(`${count('.tab')} === 1 && ${visiblePanes} === 4`);
  });

  await t.test('Full screen current fills the window, Back to tab restores the split', async () => {
    const rect = 'JSON.stringify(document.querySelector(".pane.full")?.getBoundingClientRect().toJSON())';
    await app.click('.split:not([hidden]) .gutter ~ .pane');
    await app.click('#fullscreen');
    await app.waitFor('!!document.querySelector(".pane.full") && !document.querySelector("#fs-banana").hidden');
    await app.waitFor(`(() => { const r = JSON.parse(${rect}); return r.width === innerWidth && r.height === innerHeight; })()`);
    assert.strictEqual(await app.eval(count('.pane.full')), 1);
    assert.ok(await app.eval('document.querySelector("#fs-cad").hidden'), 'no Ctrl+Alt+Del button for a terminal');
    await app.mouse('mouseMoved', await app.center('#fs-banana img')); // hovering the banana reveals the buttons
    await app.click('#fs-back');
    await app.waitFor(`!document.querySelector(".pane.full") && ${visiblePanes} === 4 && document.querySelector("#fs-banana").hidden`);
    assert.strictEqual(await app.eval(count('.xterm')), 4);
  });

  await t.test('full screen repeats the header\'s shared-folder label under the banana', async () => {
    // No RDP server here, so the label is put on the selected pane's header the way openRemote does it.
    const fsShared = '(() => { const s = document.querySelector("#fs-shared"); return JSON.stringify([s.offsetParent !== null, s.textContent, s.title]); })()';
    await app.eval(`(() => { const s = document.createElement('span'); s.className = 'shared'; s.textContent = 'shared folder: read-only'; s.title = 'Sharing /tmp/x with win.test (read-only)';
      document.querySelector('.pane.active .pane-head .t').after(s); })()`);
    await app.click('#fullscreen');
    // The window goes full screen too and the banana is centred on it: wait for that before aiming at its buttons.
    await app.waitFor('!!document.querySelector(".pane.full") && document.querySelector(".pane.full").getBoundingClientRect().width === innerWidth && innerWidth === screen.width');
    await app.mouse('mouseMoved', await app.center('#fs-banana img'));
    assert.deepStrictEqual(JSON.parse(await app.eval(fsShared)), [true, 'shared folder: read-only', 'Sharing /tmp/x with win.test (read-only)']);
    await app.click('#fs-back');
    await app.waitFor('!document.querySelector(".pane.full")');
    await app.eval('document.querySelector(".pane.active .pane-head .shared").remove()');
    await app.click('#fullscreen'); // the same pane, now sharing nothing: no label is left over
    // The window goes full screen too and the banana is centred on it: wait for that before aiming at its buttons.
    await app.waitFor('!!document.querySelector(".pane.full") && document.querySelector(".pane.full").getBoundingClientRect().width === innerWidth && innerWidth === screen.width');
    await app.mouse('mouseMoved', await app.center('#fs-banana img'));
    assert.deepStrictEqual(JSON.parse(await app.eval(fsShared)), [false, '', '']);
    await app.click('#fs-back');
    await app.waitFor(`!document.querySelector(".pane.full") && ${visiblePanes} === 4`);
  });

  await t.test('the pane button pops a session into its own tab', async () => {
    await app.click('.split:not([hidden]) .gutter ~ .pane button[title="Own tab"]');
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

  await t.test('tabs are grouped by folder with a chip; mixing folders in one tab makes it Mixed', async () => {
    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open');
    await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; f.name.value = 'lt'; f.protocol.value = 'local'; f.folder.value = 'Box/Lab'; })()`);
    await app.click('#edit-dlg .btn.primary');
    const lt = `[...document.querySelectorAll('#tree .conn')].find((n) => n.textContent.startsWith('lt'))`;
    await app.waitFor(`!!${lt}`);
    const tabsBefore = await app.eval(count('.tab'));
    await app.eval(`${lt}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await app.waitFor(`${count('.tab')} === ${tabsBefore + 1}`);
    // The folder's group comes first (local terminals have no folder and no chip), its chip in front of the tab.
    await app.waitFor(`${count('.tab-group')} === 2 && document.querySelector('#tabs').firstElementChild.title === 'Box/Lab'`); // and "No folder" before the terminals
    assert.ok(await app.eval(`document.querySelector('#tabs').children[1].classList.contains('active')`));
    await app.click('#new-term', SHIFT); // a local terminal split into the Box/Lab tab
    await app.waitFor(`${count('.tab-group')} === 2 && document.querySelector('#tabs').lastElementChild.previousElementSibling.textContent === 'Mixed'`);
  });

  await t.test('tab groups follow the sidebar order, even for a subfolder made later', async () => {
    const save = async (name, folder) => {
      await app.click('#new-conn');
      await app.waitFor('document.querySelector("#edit-dlg").open');
      await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; f.name.value = '${name}'; f.protocol.value = 'local'; f.folder.value = '${folder}'; })()`);
      await app.click('#edit-dlg .btn.primary');
      await app.waitFor(`[...document.querySelectorAll('#tree .conn')].some((n) => n.textContent.startsWith('${name}'))`);
    };
    await save('in-crate', 'Crate');
    await save('in-late', 'Box/Late'); // made after Crate, but drawn inside Box, above Crate
    for (const n of ['in-crate', 'in-late']) await app.eval(`[...document.querySelectorAll('#tree .conn')].find((n) => n.textContent.startsWith('${n}')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    // (the Box/Lab tab became Mixed in the step before)
    await app.waitFor(`[...document.querySelectorAll('.tab-group')].map((c) => c.title).join() === 'Box/Late,Crate,Local terminals and connections outside any folder,Sessions from different folders'`);
  });

  await t.test('tab right-click: rename, duplicate, reconnect, close others', async () => {
    const tabMenu = (item) => app.eval(`(() => { document.querySelector('.tab.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.textContent === '${item}').click(); })()`);
    const active = `document.querySelector('.tab.active .t').textContent`;
    await app.eval(`document.querySelector('#tabs > .tab:last-child').click()`); // the Mixed tab: two sessions (scrolled out of view, so no real click)
    await app.waitFor(`${active} === '2 sessions'`);
    await tabMenu('Rename…');
    await app.waitFor('document.querySelector("#prompt-dlg").open && document.activeElement.id === "prompt-in"');
    await app.eval('document.querySelector("#prompt-in").select()');
    await app.type('mine');
    await app.key('Enter', 'Enter', 13);
    await app.waitFor(`${active} === 'mine'`);

    const n = await app.eval(count('.tab'));
    await tabMenu('Duplicate');
    await app.waitFor(`${count('.tab')} === ${n + 1} && ${visiblePanes} === 2 && ${active} === 'mine'`); // same two sessions, same name

    await tabMenu('Close other tabs');
    await app.waitFor(`${count('.tab')} === 1 && ${count('.pane')} === 2`);

    await tabMenu('Reconnect');
    await app.waitFor(`${count('.tab')} === 1 && ${count('.pane')} === 2 && ${count('.xterm')} === 2 && ${active} === 'mine'`);

    // Delete the saved connection of one session: Reconnect keeps that session running instead of closing it.
    await app.eval(`(() => { window.confirm = () => true;
      [...document.querySelectorAll('#tree .conn')].find((n) => n.textContent.startsWith('lt')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Delete').click(); })()`);
    await app.waitFor(`![...document.querySelectorAll('#tree .conn')].some((n) => n.textContent.startsWith('lt'))`);
    await tabMenu('Reconnect');
    await app.waitFor(`${count('.tab')} === 1 && ${count('.pane')} === 2 && document.querySelector('#toast').textContent.startsWith('Kept 1 session')`);
  });

  await t.test('saved commands: edited in the dialog, run on start, run again from the pane menu', async () => {
    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open');
    await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; f.name.value = 'cmdbox'; f.protocol.value = 'local'; f.protocol.dispatchEvent(new Event('change')); })()`);
    assert.ok(await app.eval('document.querySelector("#edit-dlg .cmds").offsetParent !== null'), 'command block shown for a local terminal');
    await app.click('#cmd-name');
    await app.type('answer');
    await app.click('#cmd-text');
    await app.type('echo bp-$((6*7))');
    await app.click('#cmd-start');
    assert.strictEqual(await app.eval('[...document.querySelector("#cmd-pick").options].map((o) => o.text).join()'), 'answer,＋ New command');
    await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; f.protocol.value = 'rdp'; f.protocol.dispatchEvent(new Event('change')); })()`);
    assert.ok(await app.eval('document.querySelector("#edit-dlg .cmds").offsetParent === null'), 'command block hidden for RDP');
    await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; f.protocol.value = 'local'; f.protocol.dispatchEvent(new Event('change')); })()`);
    await app.click('#edit-dlg .btn.primary');
    const saved = '(async () => JSON.stringify((await window.bp.get()).connections.find((c) => c.name === "cmdbox")?.commands))()';
    await app.waitFor(`(async () => (await ${saved}) === ${JSON.stringify(JSON.stringify([{ name: 'answer', cmd: 'echo bp-$((6*7))', onStart: true }]))})()`);

    const row = `[...document.querySelectorAll('#tree .conn')].find((n) => n.textContent.startsWith('cmdbox'))`;
    await app.eval(`${row}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const answers = `(document.querySelector('.split:not([hidden]) .xterm-rows')?.textContent.match(/bp-42/g) || []).length`;
    await app.waitFor(`${answers} === 1`); // ran on start
    const paneMenu = await app.eval(`(() => { document.querySelector('.split:not([hidden]) .pane-head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      const items = [...document.querySelectorAll('#menu button')];
      items.find((b) => b.textContent === 'Run: answer').click();
      return items.map((b) => b.textContent); })()`);
    assert.ok(!paneMenu.includes('Send Ctrl+Alt+Del'), 'no Ctrl+Alt+Del in a terminal\'s menu');
    await app.waitFor(`${answers} === 2`);

    // From the sidebar with no session open: a new one runs "Run on start", then the picked command.
    await app.click('.tab.active .x');
    await app.waitFor(`![...document.querySelectorAll('.pane-head')].some((h) => h.textContent.includes('cmdbox'))`);
    await app.eval(`(() => { ${row}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Run: answer').click(); })()`);
    await app.waitFor(`${answers} === 2 && document.querySelector('.tab.active .t').textContent === 'cmdbox'`);
  });

  await t.test('shared folders: RDP only, chosen in the folder dialog only, read-only unless ticked, refused for the home folder, several with a mode each, emptied to stop sharing', async () => {
    // Somewhere that may be shared: outside the home folder, and not the app's own folder (this run's profile).
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ui-share-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const fill = (fields) => app.eval(`(() => { const f = document.querySelector('#edit-form').elements;
      for (const [k, v] of Object.entries(${JSON.stringify(fields)})) f[k].value = v;
      f.protocol.dispatchEvent(new Event('change')); })()`);
    // Stands in for the user choosing `dir` in the system's folder dialog, then clicks Choose… in that row.
    const choose = async (dir, row = 0) => {
      await app.main(`require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(dir)}] })`);
      await app.click(`#share-rows .share-row:nth-child(${row + 1}) .share-pick`);
    };
    const sharePath = 'document.querySelector("#edit-form").elements.sharePath.value';
    const boxShown = 'document.querySelector("#edit-dlg .share-box").offsetParent !== null';
    const winbox = '(async () => JSON.stringify((await window.bp.get()).connections.find((c) => c.name === "winbox") || null))()';
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(app.profile, 'connections.json'), 'utf8')).connections.find((c) => c.name === 'winbox');
    const editWinbox = async () => {
      await app.eval(`(() => { [...document.querySelectorAll('#tree .conn')].find((n) => n.textContent.startsWith('winbox')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
        [...document.querySelectorAll('#menu button')].find((b) => b.textContent === 'Edit…').click(); })()`);
      await app.waitFor('document.querySelector("#edit-dlg").open');
    };

    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open');
    await fill({ name: 'winbox', protocol: 'ssh', host: 'win.test' });
    assert.ok(!(await app.eval(boxShown)), 'no shared folder box for SSH');
    await fill({ protocol: 'rdp' });
    assert.ok(await app.eval(boxShown), 'shared folder box shown for RDP');
    assert.ok(await app.eval('document.querySelector("#edit-form").elements.sharePath.readOnly'), 'the path cannot be typed');
    await choose(os.homedir());
    await app.waitFor(`/cannot be shared: it holds your whole home folder/.test(document.querySelector('#toast').textContent)`);
    assert.strictEqual(await app.eval(sharePath), '', 'the home folder is not taken');

    // A page that sends a path of its own gets one answer, whether the folder is there or not, and nothing is saved.
    const refused = (dir, known = null) => app.eval(`window.bp.save({ name: 'sneak', protocol: 'rdp', host: 'win.test', shares: [${JSON.stringify(known)}, { path: ${JSON.stringify(dir)}, writable: false }].filter(Boolean) }).then(() => 'saved', (e) => e.message)`);
    const answer = await refused(folder);
    assert.match(answer, /choose the shared folder with the Choose… button/);
    for (const dir of [path.join(folder, 'not-there'), os.homedir(), '/etc']) assert.strictEqual(await refused(dir), answer);
    assert.strictEqual(await app.eval('(async () => (await window.bp.get()).connections.some((c) => c.name === "sneak"))()'), false);

    await choose(`${folder}/`);
    await app.waitFor(`${sharePath} === ${JSON.stringify(folder)}`); // shown by its real path
    await app.click('#edit-dlg .btn.primary');
    await app.waitFor(`(async () => (await ${winbox}) !== 'null')()`);
    assert.deepStrictEqual(JSON.parse(await app.eval(winbox)).shares, [{ path: folder, writable: false }]); // tidied to its real path, read-only

    await editWinbox();
    assert.deepStrictEqual(await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; return [f.sharePath.value, f.shareWritable.checked]; })()`), [folder, false]);
    await app.click('#edit-form [name=shareWritable]');
    await app.click('#edit-dlg .btn.primary');
    await app.waitFor(`(async () => JSON.parse(await ${winbox}).shares[0].writable === true)()`);

    // The page can ask for a share but cannot agree to one: an agreement it sends is not kept, and it is never shown one.
    const id = onDisk().id;
    await app.eval(`window.bp.save({ id: ${JSON.stringify(id)}, shareOk: 'f'.repeat(64) })`);
    assert.ok(!('shareOk' in onDisk()), 'a page-made agreement does not reach the file');
    assert.ok(!('shareOk' in JSON.parse(await app.eval(winbox))));
    assert.deepStrictEqual(onDisk().shares, [{ path: folder, writable: true }]);

    // Nor does a path of the page's own get in beside a folder that was chosen: the answer is the same one, whatever is on disk.
    for (const dir of [path.join(folder, 'not-there'), os.homedir(), '/etc']) assert.strictEqual(await refused(dir, { path: folder, writable: false }), answer);

    // A second folder gets a row of its own, read-only until ticked. A row left empty is not a folder.
    const second = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-ui-share-')));
    t.after(() => fs.rmSync(second, { recursive: true, force: true }));
    const rows = `[...document.querySelectorAll('#share-rows .share-row')]`;
    const shown = () => app.eval(`JSON.stringify(${rows}.map((r) => [r.querySelector('[name=sharePath]').value, r.querySelector('[name=shareWritable]').checked]))`).then(JSON.parse);
    // More rows make the dialog taller than the window, and it scrolls: Save is brought into view as a person would.
    const save = async () => { await app.eval(`document.querySelector('#edit-dlg .btn.primary').scrollIntoView()`); await app.click('#edit-dlg .btn.primary'); };
    await editWinbox();
    await app.click('#share-add');
    await app.click('#share-add');
    assert.deepStrictEqual(await shown(), [[folder, true], ['', false], ['', false]]);
    assert.ok(await app.eval(`${rows}.every((r) => r.querySelector('[name=sharePath]').readOnly)`), 'no row can be typed in');
    await choose(second, 2);
    await app.waitFor(`${rows}[2].querySelector('[name=sharePath]').value === ${JSON.stringify(second)}`);
    await save();
    await app.waitFor(`(async () => JSON.parse(await ${winbox}).shares.length === 2)()`);
    assert.deepStrictEqual(onDisk().shares, [{ path: folder, writable: true }, { path: second, writable: false }]);
    // What a list must be is asked on saving: the same folder chosen twice is refused by the main process, and nothing is saved.
    await editWinbox();
    assert.deepStrictEqual(await shown(), [[folder, true], [second, false]]);
    await choose(folder, 1);
    await app.waitFor(`${rows}[1].querySelector('[name=sharePath]').value === ${JSON.stringify(folder)}`);
    await save();
    await app.waitFor(`/is in the list of shared folders twice/.test(document.querySelector('#toast').textContent)`);
    assert.deepStrictEqual(onDisk().shares, [{ path: folder, writable: true }, { path: second, writable: false }]);
    // ✕ takes a folder out of the list.
    await editWinbox();
    await app.click('#share-rows .share-row .share-drop');
    assert.deepStrictEqual(await shown(), [[second, false]]);
    await app.click('#edit-dlg .btn.primary');
    await app.waitFor(`(async () => JSON.parse(await ${winbox}).shares.length === 1)()`);
    assert.deepStrictEqual(onDisk().shares, [{ path: second, writable: false }]);

    // ✕ on the only row leaves an empty one: nothing is shared.
    await editWinbox();
    await app.click('#share-rows .share-row .share-drop');
    assert.deepStrictEqual(await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; return [f.sharePath.value, f.shareWritable.checked]; })()`), ['', false]);
    await app.click('#edit-dlg .btn.primary');
    await app.waitFor(`(async () => !('shares' in JSON.parse(await ${winbox})))()`);
    assert.ok(!('shares' in onDisk()));
  });

  await t.test('saved password: kept on an edit, asked for again when the server changes, copied by Duplicate only to the same server', async () => {
    const menuOf = (item) => app.eval(`(() => { [...document.querySelectorAll('#tree .conn')].find((n) => n.textContent.startsWith('pwbox')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
      [...document.querySelectorAll('#menu button')].find((b) => b.textContent === '${item}').click(); })()`);
    const hint = 'document.querySelector("#edit-form").elements.password.placeholder';
    const setHost = (h) => app.eval(`(() => { const i = document.querySelector('#edit-form').elements.host; i.value = '${h}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const has = (name) => `(async () => (await window.bp.get()).connections.find((c) => c.name === '${name}')?.hasPassword)()`;
    const submit = async () => { await app.eval('document.querySelector("#edit-form").requestSubmit()'); await app.waitFor('!document.querySelector("#edit-dlg").open'); };
    // CI has no keyring, so safeStorage cannot encrypt there: a stand-in that only marks the text is enough to test what is kept.
    await app.main(`Object.assign(require('electron').safeStorage, { encryptString: (t) => Buffer.from('x' + t), decryptString: (b) => b.toString().slice(1) })`);
    await app.click('#new-conn');
    await app.waitFor('document.querySelector("#edit-dlg").open');
    await app.eval(`(() => { const f = document.querySelector('#edit-form').elements; f.name.value = 'pwbox'; f.host.value = 'one.test'; f.username.value = 'u'; f.password.value = 'not-a-real-one'; })()`);
    await submit();
    await app.waitFor(`(async () => (await ${has('pwbox')}) === true)()`);

    await menuOf('Duplicate');
    await app.waitFor('document.querySelector("#edit-dlg").open');
    assert.match(await app.eval(hint), /copied/);
    await setHost('two.test');
    assert.match(await app.eval(hint), /Enter it again/);
    await submit();
    await app.waitFor(`(async () => (await ${has('pwbox copy')}) === false)()`); // another server: not copied

    await menuOf('Edit…');
    await app.waitFor('document.querySelector("#edit-dlg").open');
    assert.match(await app.eval(hint), /unchanged/);
    await submit();
    assert.strictEqual(await app.eval(has('pwbox')), true); // nothing about the server changed: kept
    await menuOf('Edit…');
    await app.waitFor('document.querySelector("#edit-dlg").open');
    await setHost('three.test');
    assert.match(await app.eval(hint), /Enter it again/);
    await submit();
    await app.waitFor(`(async () => (await ${has('pwbox')}) === false)()`);
    // Tidy up: the next step drags the sidebar's grip, and a row at the height it grabs would be dragged instead.
    await app.eval('window.confirm = () => true');
    for (const left of [1, 0]) { await menuOf('Delete'); await app.waitFor(`[...document.querySelectorAll('#tree .conn')].filter((n) => n.textContent.startsWith('pwbox')).length === ${left}`); }
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

// Shares saved before this launch (by an older version too) were never chosen in this launch's folder dialog.
test('a share saved earlier is kept on edit and on Duplicate, with no choosing again', async (t) => {
  const folder = '/bp-ui/not-there'; // saving does not look at the folder, so it need not exist
  const app = await launch({ ordered: true, connections: [{ id: 'old', name: 'old', protocol: 'rdp', host: 'win.test', share: { path: folder, writable: false } }] });
  t.after(() => app.close());
  const save = (conn) => app.eval(`window.bp.save(${JSON.stringify(conn)}).then((v) => v.connections.filter((c) => c.shares?.some((s) => s.path === ${JSON.stringify(folder)})).length, (e) => e.message)`);
  // The file has the old single-folder form (`share`); it was read as a list of one.
  assert.strictEqual(await save({ id: 'old', name: 'old', protocol: 'rdp', host: 'win.test', shares: [{ path: folder, writable: true }] }), 1);
  assert.strictEqual(await save({ name: 'old copy', protocol: 'rdp', host: 'win.test', shares: [{ path: folder, writable: true }] }), 2);
  assert.match(await save({ name: 'other', protocol: 'rdp', host: 'win.test', shares: [{ path: folder + '2', writable: false }] }), /choose the shared folder/);
  assert.match(await save({ name: 'other', protocol: 'rdp', host: 'win.test', shares: [{ path: folder, writable: false }, { path: folder + '2', writable: false }] }), /choose the shared folder/);
  // What a list must be needs no look at the disk either: a folder that is saved already, twice in one list, is refused by its path.
  assert.strictEqual(await save({ name: 'inner', protocol: 'rdp', host: 'win.test', shares: [{ path: folder, writable: false }] }), 3);
  assert.match(await save({ name: 'both', protocol: 'rdp', host: 'win.test', shares: [{ path: folder, writable: false }, { path: folder, writable: true }] }), /twice/);
});
