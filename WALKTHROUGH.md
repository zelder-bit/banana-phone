# banana-phone walkthrough 🍌📞

This document explains how banana-phone works from the moment you launch it to the moment pixels from a Windows server appear in a split pane. It goes file by file, shows the important code, and explains the JavaScript syntax and the ideas behind it as they come up.

Contents

1. [The big picture](#1-the-big-picture)
2. [The files and how they fit together](#2-the-files-and-how-they-fit-together)
3. [Electron in five minutes: main, preload, renderer](#3-electron-in-five-minutes-main-preload-renderer)
4. [`package.json`: scripts, dependencies, packaging](#4-packagejson-scripts-dependencies-packaging)
5. [`store.js`: saving connections and bulk edits](#5-storejs-saving-connections-and-bulk-edits)
6. [`main.js`: the back end](#6-mainjs-the-back-end)
7. [`preload.js`: the bridge](#7-preloadjs-the-bridge)
8. [`guacd.js`: remote desktops through Guacamole](#8-guacdjs-remote-desktops-through-guacamole)
9. [`renderer/index.html` and `fruit.css`: the look](#9-rendererindexhtml-and-fruitcss-the-look)
10. [`renderer/app.js`: the front end](#10-rendererappjs-the-front-end)
11. [Following one click all the way through](#11-following-one-click-all-the-way-through)
12. [Security choices](#12-security-choices)
13. [Tests and CI](#13-tests-and-ci)
14. [Building and running the AppImage](#14-building-and-running-the-appimage)
15. [JavaScript syntax cheat sheet](#15-javascript-syntax-cheat-sheet)

---

## 1. The big picture

banana-phone is a desktop app built with **Electron**. Electron bundles a copy of the Chromium browser and Node.js together, so you write the user interface as a web page (HTML, CSS, JavaScript) and you still get to do "real computer" things such as opening network sockets, spawning shells and reading files.

It speaks three kinds of connection:

| Type | Used for | How it is drawn | Library doing the work |
| --- | --- | --- | --- |
| `ssh` | Linux servers | xterm.js terminal | `ssh2` |
| `local` | a shell on this machine | xterm.js terminal | `node-pty` |
| `rdp` / `vnc` | Windows (Active Directory), xrdp, VNC desktops | a `<canvas>` drawn by Guacamole | `guacd` (in Docker) + `guacamole-lite` + `guacamole-common-js` |

Here is how data moves:

```
            ┌──────────────────────────── Electron app ────────────────────────────┐
            │                                                                      │
 you ──────▶│  renderer (web page)          preload            main (Node.js)       │
 keyboard   │  app.js, xterm.js,    ◀──IPC──▶ bridge ◀──IPC──▶ main.js, store.js     │
 mouse      │  guacamole-common-js                             guacd.js             │
            │        │                                            │   │   │          │
            └────────┼────────────────────────────────────────────┼───┼───┼──────────┘
                     │ websocket (127.0.0.1:random)                │   │   │
                     └──────────────▶ guacamole-lite ◀─────────────┘   │   │
                                            │ TCP 127.0.0.1:4822       │   │
                                            ▼                          │   │
                                  guacd (Docker container)             │   │
                                            │ RDP / VNC                │   │
                                            ▼                          │   │
                                   Windows / xrdp / VNC host           │   │
                                                         SSH (ssh2) ◀──┘   │
                                                         local shell (node-pty) ◀┘
```

Two rules shape the whole design:

1. **The web page never touches the network or the disk directly.** It asks the main process to do things through a small, named list of messages (IPC). This keeps a bug in the page from being able to read your files.
2. **Passwords never reach the web page.** They are encrypted on disk, decrypted only inside the main process at the moment they are needed, and handed straight to SSH or (encrypted again) to Guacamole.

---

## 2. The files and how they fit together

```
banana-phone/
├── package.json        dependencies, npm scripts, AppImage settings
├── main.js             Electron main process: window, IPC handlers, SSH, local shells
├── preload.js          exposes a safe `window.bp` API to the page
├── store.js            load/save connections.json, search, bulk update (pure logic)
├── guacd.js            starts guacd in Docker, runs the websocket bridge, makes tokens
├── store.test.js       tests for store.js
├── guacd.test.js       test for token encryption
├── scripts/
│   ├── check-walkthrough.js   CI check that this document matches the code
│   └── ui.e2e.js       end-to-end test: drives the real app's window (tabs, splits, dialogs)
├── .github/workflows/ci.yml   runs the tests and that check on every push / PR
├── .github/workflows/release.yml  builds and publishes the AppImage for a version tag
├── .npmrc              npm settings for this project (skip optional dependencies)
├── .github/workflows/scan.yml     scans every push and PR for secrets and personal data
├── .gitleaks.toml      rules for that scan
├── .githooks/pre-push  runs the same scan before a push leaves your machine
├── requirements.txt    what a machine needs to run the AppImage (shipped with each release)
├── build/icon.png      AppImage icon
├── docs/screenshots/   README pictures (made-up hosts and names)
└── renderer/           everything the window shows
    ├── index.html      layout and dialogs
    ├── fruit.css       theme (light "orchard" and dark "night grove")
    ├── app.js          all interface behaviour
    ├── clipboard.js    copy/paste between this computer and remote desktops
    ├── shared.mjs      pure helpers both sides use: fruit list, folder paths, search rule
    ├── icon.png        window icon
    ├── fonts/          Fredoka (headings) and Nunito (text)
    └── svg/            fruit icons
```

Who loads whom:

```
electron .  ──▶ main.js ──require──▶ store.js ──require──▶ renderer/shared.mjs
                  │      └─require──▶ guacd.js, ssh2, node-pty
                  │
                  └─ new BrowserWindow({ preload: preload.js })
                           │
                           └─ loads renderer/index.html
                                     ├─ <link> fruit.css, xterm.css
                                     └─ <script type="module"> app.js
                                              └─ import xterm, addon-fit, guacamole-common-js,
                                                        clipboard.js, shared.mjs
```

`shared.mjs` is the one file both sides load. It holds small pure helpers, `FRUITS` (the fruit pictures), `inFolder` and `parentOf` (the folder-path rules) and `matches` (the search rule), so there is one copy of each instead of one in the store and another in the page that could quietly drift apart. The page imports it as an ES module; `store.js` loads it with plain `require()`, which recent Node and Electron allow for an ES module with no top-level `await`.

---

## 3. Electron in five minutes: main, preload, renderer

An Electron app runs **several processes**:

* **Main process** (`main.js`). Plain Node.js. There is exactly one. It creates windows and can do anything Node can: files, sockets, child processes.
* **Renderer process** (`renderer/`). One per window. It is a Chromium tab showing a web page. For safety we run it **sandboxed** with **context isolation**, so it behaves like an ordinary website: no `require`, no file access.
* **Preload script** (`preload.js`). Runs inside the renderer just before the page, but with access to a few Electron APIs. Its job is to hand the page a tiny, explicit API.

They talk using **IPC** (inter-process communication). There are two styles used here:

```js example
// request/response: the page waits for an answer (a Promise)
// renderer side (through preload):
const result = await ipcRenderer.invoke('store:get');
// main side:
ipcMain.handle('store:get', () => publicView());

// fire-and-forget: no answer expected
// renderer side:
ipcRenderer.send('session:write', id, 'ls\r');
// main side:
ipcMain.on('session:write', (_e, id, d) => sessions.get(id)?.write(d));

// main pushing to the page:
win.webContents.send('session:data', id, 'hello');
// renderer side:
ipcRenderer.on('session:data', (_e, id, d) => { /* ... */ });
```

The channel names (`'store:get'`, `'session:write'`…) are just strings. The `store:` and `session:` prefixes are a naming habit to group them; Electron does not care.

---

## 4. `package.json`: scripts, dependencies, packaging

```json example
{
  "name": "banana-phone",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test",
    "postinstall": "electron-builder install-app-deps",
    "dist": "electron-builder --linux AppImage --publish never"
  },
  ...
}
```

* `"main": "main.js"` tells Electron which file is the main process.
* `npm start` runs `electron .`, meaning "run the app in this folder".
* `npm test` runs Node's built-in test runner, which finds every `*.test.js` file.
* `postinstall` runs automatically after `npm install`. `node-pty` contains C++ code compiled for one specific version of Node; Electron ships its own Node with a different binary interface (ABI), so `install-app-deps` recompiles it for Electron.
* `npm run dist` builds the AppImage into `dist/`. `--publish never` stops electron-builder from trying to upload anything itself when it notices it is running for a git tag; publishing is the release workflow's job (see [§14](#14-building-and-running-the-appimage)).

The `"build"` section configures **electron-builder**:

```json example
"build": {
  "appId": "dev.fruit.banana-phone",
  "files": ["main.js", "preload.js", "store.js", "guacd.js", "renderer/**", "node_modules/**"],
  "asarUnpack": ["node_modules/node-pty/**"],
  "linux": { "target": "AppImage", "category": "Network", "icon": "build/icon.png", "syncDesktopName": true }
}
```

* `files` lists what goes into the package. `**` means "this folder and everything below it". Dev-only packages (Electron itself, electron-builder) are left out automatically.
* electron-builder packs the app into one archive file called `app.asar`. Native `.node` libraries cannot be loaded from inside an archive, so `asarUnpack` keeps `node-pty` as real files next to it.

`allowScripts` is an npm 11 safety feature: packages may only run install scripts you have approved. `node-pty` is allowed because it must compile; `ssh2`'s optional native crypto binding is denied because `ssh2` works fine in pure JavaScript.

`.npmrc` holds npm settings for this project:

```ini
omit=optional
```

It tells npm to skip *optional* dependencies. The one that matters is `cpu-features`, a small native helper `ssh2` uses only to pick the fastest cipher; `ssh2` loads it inside `try { … } catch {}` and works the same without it. It has to be compiled against Electron's C++ headers, and those need a newer compiler than the Debian 12 system the release is built on (see [§14](#releases)), so leaving it out keeps every build working. The other optional packages are build-tool extras for Windows signing and proxies.

---

## 5. `store.js`: saving connections and bulk edits

This file has **no Electron code at all**. That is deliberate: it can be tested with plain Node, and the main process just calls it.

### The data on disk

`~/.config/banana-phone/connections.json`:

```json example
{
  "ordered": true,
  "folders": ["Prod", "Prod/Windows", "Lab"],
  "folderIcons": { "Lab": "kiwi" },
  "connections": [
    {
      "id": "8c1e…",
      "name": "dc01",
      "protocol": "rdp",
      "host": "10.0.0.5",
      "port": 3389,
      "username": "admin",
      "domain": "CORP",
      "password": "djExNOUCiQK/…",
      "folder": "Prod/Windows",
      "tags": ["ad"]
    }
  ]
}
```

A folder is just a string like `"Prod/Windows"`. There is no separate tree structure: the sidebar builds the tree from these strings every time it draws. The path is also the **key** everywhere a folder is mentioned: in `folders`, in each connection's `folder`, and in `folderIcons`, which maps a folder path to the fruit shown next to it (a folder with no entry gets the `crate` picture). So there *is* something to keep in sync: when a folder moves, its path changes in all three places. `renameFolder(data, from, to)` in `store.js` is the only function that rewrites a path, and it does all three at once, for the folder and everything under it.

`folders` always lists **every** folder, including the parents of `"Prod/Windows"` and folders only a connection mentions. `fillFolders` makes that true on load and wherever a folder can appear (`addFolder`, `upsert`, `moveConn`), so the page can use `folders` as the full list without working anything out. It is also what lets an *empty* folder exist. `addFolder` and `removeFolder` live in the store too; `removeFolder` refuses a folder that still holds connections and drops its icons along with it.

`setFolderIcon` checks the name against the fixed fruit list (`FRUITS`, from `shared.mjs`) before saving, so the renderer can never make the app read an arbitrary file name, and refuses a folder that does not exist, so no stray icon entries pile up.

`password` is encrypted (see [§6](#encrypting-passwords)).

### Loading

```js
function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('connections file is not a JSON object');
    const d = { ...empty(), folders: data.folders || [], folderIcons: data.folderIcons || {}, connections: data.connections || [] };
    fillFolders(d);
    if (!data.ordered) { // an old file: start from the alphabetical order the sidebar used to show
      d.folders.sort((a, b) => a.localeCompare(b));
      d.connections.sort((a, b) => a.name.localeCompare(b.name));
    }
    return d;
  } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw e; // a corrupt file must not be silently replaced with an empty one
  }
}
```

* `fs.readFileSync(file, 'utf8')` reads the whole file as text. "Sync" means the program waits until it is done, which is fine for a small file read once at start-up.
* `JSON.parse` turns the text into a JavaScript object.
* `{ ...empty(), folders: … }` starts from a fresh empty store (which has `ordered: true`) and puts the file's arrays on top, so a loaded store always has every field.
* `data.folders || []`: the `||` operator returns its left side if that is "truthy", otherwise the right side. So a missing `folders` becomes an empty array.
* The `typeof data !== 'object'` line rejects files that are valid JSON but not an object (for example a file containing just `null`).
* `try { … } catch (e) { … }` catches errors. `ENOENT` ("Error NO ENTry") means the file does not exist yet: first launch, so start empty. Any other error (for example broken JSON) is re-thrown with `throw e`, so the app refuses to start rather than overwrite your connections with an empty list. `main.js` catches it and shows a dialog naming the file and its `.bak` copies.

### Order and moving

The order you see is the order of the two arrays in the file. There is no separate `order` field: the sidebar does not sort, it just draws `folders` and `connections` in array order (siblings only, so the order of a folder relative to a connection never matters).

* `fillFolders(data)` makes every folder explicit, adding the parents of `"a/b/c"` and folders only a connection mentions, so each folder has a place in the order.
* Old files had no order and the sidebar sorted by name. A file without `"ordered": true` is sorted by name once at load, so it looks the same as before. Every store `load()` returns, and every new one, has `ordered: true`, so the next save writes it and from then on the arrays are left alone.
* `moveConn(data, id, to, before)` takes a connection out of the array and puts it back in front of connection `before` (or last), with `folder` set to `to` (`''` is the top level).
* `moveFolder(data, from, to, before)` does the same for a folder, in three steps: check, rename, reorder. A folder's name is its last path segment, so moving `"Prod"` into `"Lab"` makes it `"Lab/Prod"`. It throws if either folder does not exist, if the target is the folder itself or inside it, or if the new path already exists. Then `renameFolder` swaps the prefix on the folder, its subfolders, their connections and their icons (`inFolder` finds them), and finally the moved folders are cut out of the array and put back in front of `before`. It returns the new path, which the page needs (see [§10](#the-sidebar-tree)).

```js
// The only place a folder path is rewritten: the folder, its subfolders, their connections and their icons.
function renameFolder(data, from, to) {
  const re = (f) => (inFolder(f, from) ? to + f.slice(from.length) : f);
  data.folders = data.folders.map(re);
  for (const c of data.connections) if (c.folder) c.folder = re(c.folder);
  data.folderIcons = Object.fromEntries(Object.entries(data.folderIcons).map(([k, v]) => [re(k), v]));
}
```

`re` maps one path: if it is `from` or under it, the `from` part is replaced with `to` (`"Prod/Windows"` → `"Lab/Prod/Windows"`), otherwise it is returned unchanged. `Object.entries` turns `folderIcons` into `[path, fruit]` pairs, each path goes through `re`, and `Object.fromEntries` builds the object back up.

### Saving safely

```js
// backup: true writes file.bak, a string writes to that path.
function save(file, data, { backup = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file)) fs.copyFileSync(file, typeof backup === 'string' ? backup : file + '.bak');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
```

* `{ backup = false } = {}` is **destructuring with defaults**. The third argument is an object; we pull out its `backup` property, defaulting to `false`. The trailing `= {}` means the whole argument may be left out.
* `JSON.stringify(data, null, 2)` turns the object back into text, indented with 2 spaces so it is readable.
* `mode: 0o600` sets Unix permissions to "only my user can read and write". `0o` marks an octal number.
* **Write-then-rename** is a classic trick. If the computer crashes halfway through `writeFileSync`, only the `.tmp` file is damaged. `renameSync` replaces the real file in one step, so you either have the old file or the new one, never half of each.
* Deletes pass `{ backup: true }`, so the previous version is kept as `connections.json.bak`. Bulk edits pass a full path instead, `connections.json.<timestamp>.bak`, so every bulk edit keeps its own backup and a later delete can never overwrite it. `typeof backup === 'string'` is how the function tells the two apart.

### Searching

The search rule lives in `shared.mjs`, because quick search in the page uses it too; `store.js` passes it on in its exports, which is where the tests reach it.

```js
export function matches(conn, q) {
  q = q.trim().toLowerCase();
  if (!q) return true;
  const hay = [conn.name, conn.host, conn.username, conn.domain, conn.folder, conn.protocol, ...(conn.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}
```

* `...(conn.tags || [])` is the **spread operator**: it unpacks the tags array into the surrounding array.
* `.filter(Boolean)` drops empty values (`undefined`, `''`), because `Boolean(x)` is `false` for them.
* `.join(' ')` glues everything into one "haystack" string.
* `q.split(/\s+/)` splits the query on any run of whitespace. `/\s+/` is a **regular expression**: `\s` is a whitespace character, `+` means "one or more".
* `.every(fn)` is `true` only if `fn` is true for every word. So `prod admin` finds connections containing both words anywhere: name, host, folder, etc.

### Bulk updating

```js
// filter: { username } or { folder }; ids (optional) narrows to what the user ticked.
function select(data, filter) {
  return data.connections.filter((c) => {
    if (filter.ids && !filter.ids.includes(c.id)) return false;
    if (filter.username != null) return (c.username || '') === filter.username;
    if (filter.folder != null) return inFolder(c.folder, filter.folder);
    return false;
  });
}

function bulkUpdate(data, filter, patch) {
  const hits = select(data, filter);
  for (const c of hits) {
    for (const k of ['username', 'domain', 'password']) if (patch[k] !== undefined) c[k] = patch[k];
  }
  return hits.length;
}
```

`inFolder` comes from `shared.mjs`, next to `parentOf`, which the page uses to find a folder's siblings:

```js
export const inFolder = (folder, f) => folder === f || (folder || '').startsWith(f + '/');
// 'a/b/c' -> 'a/b'; a top-level folder -> ''.
export const parentOf = (f) => f.slice(0, Math.max(0, f.lastIndexOf('/')));
```

* `select` returns the connections a bulk edit will touch. The dialog calls it once to **preview** the list and again to **apply**, with `ids` set to the checkboxes you left ticked.
* `inFolder` treats `"Prod/Windows"` as inside `"Prod"`, by checking for `"Prod/"` with the slash. Without the slash, a folder called `"Production"` would wrongly match `"Prod"`. There is a test for exactly this.
* `parentOf` cuts at the last `/`. For a top-level folder `lastIndexOf` gives `-1`, and `Math.max(0, …)` turns that into `slice(0, 0)`, the empty string that means "top level".
* `!= null` (two equals signs) is true for anything except `null` and `undefined`. It allows an empty string `''` as a real value to search for.
* `bulkUpdate` only copies the three credential fields, and only those the caller actually set (`!== undefined`), so leaving "New username" empty keeps every username as it was.
* `for (const c of hits)` loops over the array's values. Because objects are shared by reference, changing `c` changes the object inside `data`.

`upsert` ("update or insert") and `remove` round out the file:

```js
function upsert(data, input) {
  const { copyPasswordFrom, ...conn } = input;
  if (copyPasswordFrom && !conn.id && conn.password === undefined) { // new connections only
    const src = data.connections.find((c) => c.id === copyPasswordFrom);
    if (src?.password) conn.password = src.password; // copied still encrypted: never decrypted on the way
  }
  if (!conn.id) conn.id = crypto.randomUUID();
  const i = data.connections.findIndex((c) => c.id === conn.id);
  if (i >= 0) data.connections[i] = { ...data.connections[i], ...conn };
  else data.connections.push(conn);
  fillFolders(data);
  return conn;
}
```

`{ ...old, ...conn }` builds a new object with all of `old`'s properties, then `conn`'s on top. That is how a partial update such as `{ id, folder }` changes only the folder. `fillFolders` then makes sure a folder typed into the edit dialog for the first time (and its parents) is listed in `folders`.

The first lines handle **Duplicate**. The page never sees passwords, so it cannot copy one into the duplicate. It sends `copyPasswordFrom: <id of the original>` instead, and `upsert` copies the original's stored value, which is still encrypted. The same keyring key encrypted it, so the copy decrypts just like the original. The rest pattern `{ copyPasswordFrom, ...conn }` keeps the helper field out of the saved file. `src?.password` is **optional chaining**: if no connection has that id, `src` is `undefined` and the expression gives `undefined` instead of throwing. A password typed in the dialog (or `''` from "Remove the saved password") always wins, because the copy only happens while `conn.password` is still `undefined`, and only for a new connection (no `id` yet), so an existing connection can never have its password swapped this way.

---

## 6. `main.js`: the back end

### Imports and state

```js
const { app, BrowserWindow, ipcMain, safeStorage, Menu, dialog, clipboard } = require('electron');
const { Client } = require('ssh2');
const pty = require('node-pty');
const store = require('./store');
const guacd = require('./guacd');

const dir = app.getPath('userData'); // ~/.config/banana-phone
const FILE = path.join(dir, 'connections.json');

// One instance only: each holds connections.json in memory and rewrites it whole.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

let win;
let data;
const sessions = new Map(); // id -> { write, resize, close }
```

* `require(...)` is Node's (CommonJS) way of loading a module. `const { a, b } = require('x')` **destructures**: it takes the `a` and `b` properties of what the module exports.
* `app.getPath('userData')` is the right per-user folder for app data on each OS; on Linux that is `~/.config/<app name>`.
* The **single-instance lock** matters for your data. The app reads `connections.json` once and rewrites the whole file on every change, so two running copies would silently undo each other's edits. A second launch exits immediately and the first window is brought to the front instead.
* `sessions` is a `Map` from a random session id to three small functions. Terminals of both kinds (SSH and local) end up with the same shape, `{ write, resize, close }`, so the rest of the code does not care which kind it is talking to.

### Encrypting passwords

```js
const enc = (s) => (s ? safeStorage.encryptString(s).toString('base64') : '');
const dec = (s) => {
  if (!s) return '';
  try { return safeStorage.decryptString(Buffer.from(s, 'base64')); }
  catch { throw new Error('Could not unlock the saved password: …'); }
};
```

* `safeStorage` is Electron's wrapper around the operating system's keyring (GNOME Keyring / KWallet on Linux, via libsecret). The keyring holds a secret key; Electron uses it to encrypt your passwords. The file on disk is useless without your logged-in keyring.
* Encryption gives raw bytes (a `Buffer`). JSON can only hold text, so the bytes are written as **base64**, a way to spell any bytes using letters, digits, `+` and `/`.
* `(s) => (…)` is an **arrow function**. `cond ? a : b` is the **ternary operator**: `a` if `cond` is truthy, otherwise `b`.
* If the keyring cannot be found, Electron falls back to a fixed built-in key (`basic_text`). The page shows a warning in the sidebar when that happens, because then the encryption is only obfuscation.

### Only a safe view goes to the page

```js
const publicView = () => ({
  folders: data.folders,
  folderIcons: data.folderIcons,
  connections: data.connections.map(({ password, ...c }) => ({ ...c, hasPassword: !!password })),
  keyring: safeStorage.getSelectedStorageBackend?.() || 'unknown',
});
```

* `({ password, ...c })` in a parameter list destructures each connection: `password` goes into its own variable and `c` gets **all the other** properties (the "rest" pattern). The returned object therefore has no password at all, only `hasPassword: true/false`.
* `!!x` turns any value into a real boolean.
* `?.()` is **optional chaining**: call the function only if it exists. Older Electron versions lacked `getSelectedStorageBackend`.

### IPC handlers for the store

Every handler that changes the store does the same three things: apply the change, write the file, and answer with the new safe view. One small helper registers them all, so none can forget a step:

```js
const persist = (backup) => store.save(FILE, data, { backup });
```

```js
// Every change to the store: apply it, write the file, answer with the new view (plus the change's own result).
// backup: true keeps the old file as .bak, a function returns the path to copy it to.
const change = (channel, fn, backup = false) => ipcMain.handle(channel, (_e, ...args) => {
  const result = fn(...args);
  persist(typeof backup === 'function' ? backup() : backup);
  return { ...publicView(), result };
});
```

* `(_e, ...args)`: the first parameter is the IPC event; the leading underscore is a common hint that "this argument is unused". `...args` collects whatever the page sent, and `fn(...args)` passes it on.
* If `fn` throws (a refused move, an unknown folder), the file is not written and the page's Promise rejects with the message.
* `result` is whatever the change returned: a moved folder's new path, or how many connections a bulk edit changed. The page reads it as `v.result`; most changes return nothing.
* `backup` is passed as a function for bulk edits so the timestamp is taken at the moment of the change, not when the app started.

The handlers themselves are then one line each:

```js
change('store:save', ({ password, ...conn }) => {
  if (password !== undefined) conn.password = enc(password); // undefined = keep existing
  store.upsert(data, conn); // its return value holds the encrypted password, so it is not passed on
});
change('store:delete', (id) => store.remove(data, id), true);
change('store:addFolder', (f) => store.addFolder(data, f));
change('store:removeFolder', (f) => store.removeFolder(data, f));
change('store:folderIcon', (f, name) => store.setFolderIcon(data, f, name));
// kind: 'conn' (id) or 'folder' (path); `to` is the target folder ('' = top level), `before` the sibling to land in front of.
// A moved folder's result is its new path.
change('store:move', (kind, id, to, before) => (kind === 'conn' ? store.moveConn : store.moveFolder)(data, id, to, before));
```

When you edit a connection and leave the password field empty, the page does not send `password` at all, so `upsert`'s merge keeps the old encrypted one. `store:save`'s function has a body in braces and no `return`, so its `result` is `undefined`: `upsert` returns the saved connection, encrypted password included, and that must not travel back to the page. `(kind === 'conn' ? store.moveConn : store.moveFolder)(…)` picks one of two functions with the ternary operator and calls it straight away.

Removing a saved password needs a third state besides "new password" and "keep it". The edit dialog shows a **Remove the saved password** checkbox when the connection has one, and the page then sends an empty string:

```js
    if (f.clearPassword.checked) conn.password = ''; // '' = remove the saved one
    else if (f.password.value) conn.password = f.password.value; // empty = keep existing
```

`''` is not `undefined`, so main does write it, and `enc('')` returns `''` without touching the keyring. JavaScript treats `''` as **falsy**, so `hasPassword: !!password` becomes `false` and the SSH and RDP code see "no password". This matters when a server moves from password login to a key or ssh-agent: an old password would otherwise still be offered.

```js
// result: how many connections changed.
change('store:bulkApply', (filter, patch) => {
  const p = {};
  if (patch.username) p.username = patch.username;
  if (patch.domain !== undefined && patch.domain !== null) p.domain = patch.domain;
  if (patch.clearPassword) p.password = '';
  else if (patch.password) p.password = enc(patch.password);
  return store.bulkUpdate(data, filter, p);
}, bulkBackup);
```

```js
const bulkBackup = () => `${FILE}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
```

`toISOString()` gives a time like `2026-11-19T23:20:05.123Z`; replacing `:` and `.` with `-` makes it safe and readable as part of a file name.

The page sends the new password in plain text over IPC (it lives in your own process memory), main encrypts it once and the same ciphertext is written to every matching connection. The bulk dialog's **Remove their saved passwords instead** checkbox sends `clearPassword: true`, which writes `''` to each match the same way; the page refuses to send both a new password and the checkbox.

### SSH sessions

```js
function openSsh(id, conn, cols, rows) {
  const client = new Client();
  let stream;
  const out = (s) => send('session:data', id, s);
  const password = dec(conn.password);

  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', cols, rows }, (err, s) => {
      if (err) { out(`\r\n${err.message}\r\n`); return client.end(); }
      stream = s;
      s.on('data', (d) => out(d.toString('utf8')));
      s.stderr.on('data', (d) => out(d.toString('utf8')));
      s.on('close', () => { client.end(); });
    });
  });
  // With a key file the stored secret is its passphrase, so it must never go to the server.
  client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(privateKey ? [] : prompts.map(() => password)));
  client.on('error', (e) => out(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`));
  client.on('close', () => { sessions.delete(id); send('session:exit', id); });
  ...
```

* `client.on('ready', fn)` registers an **event listener**: `ssh2` calls `fn` later, when the SSH handshake and login have finished. Node code is full of this pattern: you describe what to do *when* something happens.
* `client.shell({ term, cols, rows }, callback)` asks the server for an interactive shell with a pseudo-terminal of the given size. `term: 'xterm-256color'` tells programs like `vim` and `htop` which escape codes the terminal understands (xterm.js understands xterm's).
* `` `…${err.message}…` `` is a **template literal**: backticks allow `${expression}` inside a string.
* `\r\n` is carriage return + line feed: terminals need both to start a new line at column 0.
* `\x1b[31m … \x1b[0m` are **ANSI escape codes**. `\x1b` is the Escape character; `[31m` means "red text", `[0m` means "reset". That is how the error appears red in the terminal.
* `keyboard-interactive` is a login method some servers use instead of plain `password` (common with PAM). We answer every prompt with the stored password, except when a key file is set (see below).

Connecting:

```js
  client.connect({
    host: conn.host, port: conn.port || 22, username: conn.username || os.userInfo().username,
    password: privateKey ? undefined : password || undefined, privateKey, passphrase: privateKey ? password || undefined : undefined,
    agent: process.env.SSH_AUTH_SOCK, tryKeyboard: !privateKey, readyTimeout: 20000,
    hostHash: 'sha256',
    hostVerifier: (fp, verify) => { … },
  });
```

* Three ways to log in are offered: a private key file (`keyPath`), your running **ssh-agent** (`SSH_AUTH_SOCK`), or a password.
* A connection has one secret field. With a key file it is the key's **passphrase**, which only unlocks the key locally. `ssh2` tries password login before key login, so if the passphrase were also passed as `password` it would be sent to the server. That is why `password` and keyboard-interactive are switched off whenever `privateKey` is set.
* A key file that cannot be read throws an error, which ends up in the pane's status message:

```js
    catch (e) { throw new Error(`Could not read key ${conn.keyPath}: ${e.message}`); }
```
* `hostVerifier` implements **trust on first use** (the same idea as `~/.ssh/known_hosts`). The bookkeeping is shared with RDP certificates (see [Opening a session](#opening-a-session)):

```js
// An unreadable file must not count as "no hosts known": that would silently re-trust every server.
function knownHosts() {
  try { return JSON.parse(fs.readFileSync(HOSTS, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${HOSTS} is unreadable (${e.message}); fix or delete it to trust servers anew`);
  }
}
const saveHosts = (hosts) => store.save(HOSTS, hosts); // atomic write, mode 600

function trust(id, fp) {
  const hosts = knownHosts();
  const saved = hosts[id];
  if (!saved) { hosts[id] = fp; saveHosts(hosts); }
  return saved;
}
```

```js
    hostVerifier: (fp, verify) => {
      let saved;
      try { saved = trust(hostId, fp); } catch (e) { out(`\x1b[31m${e.message}\x1b[0m\r\n`); return verify(false); }
      if (!saved) out(`\x1b[33mNew host key for ${hostId} saved (SHA256 ${fp}).\x1b[0m\r\n`);
      if (!saved || saved === fp) return verify(true);
```

```js
      confirmChanged(hostId, 'host key', hostId, saved, fp).then((ok) => {
        out(ok ? '\x1b[33mTrusted the new host key.\x1b[0m\r\n' : '\x1b[31mNot trusted: connection refused.\x1b[0m\r\n');
        try { verify(ok); } catch {} // the connection may have timed out or been closed meanwhile
      }, () => { try { verify(false); } catch {} });
```

If `known_hosts.json` exists but cannot be read (half-written, hand-edited into broken JSON), `knownHosts` refuses instead of pretending no server was ever seen, which would quietly trust impostors; saving reuses `store.save`, so the file is written to a temporary file and renamed, never half-written. `trust` returns what was saved *before* the call. `undefined` (falsy) means the host was never seen: its fingerprint is saved now and the connection continues. Equal to `fp`: same server as last time. Anything else: a different key. `fp` is a SHA-256 fingerprint of the server's public key; if someone ever intercepts the connection, their key will differ.

A changed key is legitimate after a server is reinstalled, and suspicious otherwise, and only you can tell which. So banana-phone **asks**:

```js
async function confirmChanged(id, what, host, saved, fp) {
  const { response } = await dialog.showMessageBox(win, {
```

```js
    buttons: ['Cancel', `Trust the new ${what}`],
    defaultId: 0,
    cancelId: 0,
```

* `dialog.showMessageBox` shows a native warning dialog over the window, with both fingerprints. It returns a Promise of `{ response }`, the index of the button you pressed.
* `defaultId: 0` makes **Cancel** the button Enter presses, and `cancelId: 0` is what Esc or closing the dialog counts as. Refusing is therefore the default, and trusting takes a deliberate click. Only then is the new fingerprint saved over the old one.
* `const { response } = await …` waits for your answer and **destructures** the `response` property out of the result object.

`ssh2` lets the check take its time. A `hostVerifier` that takes a second parameter, `verify`, may answer later by calling `verify(true)` or `verify(false)`, and the handshake waits until then. `.then(onOk, onError)` runs the first function with the dialog's answer, or the second if showing the dialog failed, which also refuses. The handshake still has an overall limit, `readyTimeout` (20 seconds, which also covers reaching the server at all). If you take longer to answer, that session ends, but a key you trust is still saved, so opening the connection again goes straight through. `try { verify(ok); } catch {}` is there because ssh2 throws if it is answered after it gave up.

Fingerprints live in `~/.config/banana-phone/known_hosts.json`. To make banana-phone forget a server without connecting, right-click its connection and choose **Forget saved key**; the next connection saves whatever key it sees:

```js
ipcMain.handle('store:forgetHost', (_e, connId) => {
  const c = data.connections.find((x) => x.id === connId);
  if (!c) return false;
  const hosts = knownHosts();
  const id = c.protocol === 'rdp' ? rdpId(c) : sshId(c);
  if (!(id in hosts)) return false;
  delete hosts[id];
  saveHosts(hosts);
  return true;
});
```

`id in hosts` is `true` if the object has that key (`!(…)` negates it, so nothing is rewritten when there was nothing to forget). `delete hosts[id]` removes it. SSH entries are stored as `host:port` and RDP ones as `rdp host:port`, so one server can have both.

Finally `openSsh` returns the common session shape:

```js
  return {
    write: (d) => stream?.write(d),
    resize: (c, r) => stream?.setWindow(r, c, 0, 0),
    close: () => client.end(),
  };
```

`stream?.write(d)` does nothing if the shell is not open yet (`stream` is still `undefined`), instead of crashing.

### Local terminals

```js
function openLocal(id, cols, rows) {
  const shell = process.env.SHELL || '/bin/bash';
  const p = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: shellEnv() });
  p.onData((d) => send('session:data', id, d));
  p.onExit(() => { sessions.delete(id); send('session:exit', id); });
  return { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), close: () => p.kill() };
}
```

`shellEnv()` hands the shell your environment minus what the AppImage launcher adds:

```js
function shellEnv() {
  const env = { ...process.env };
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'GDK_BACKEND', 'ELECTRON_RUN_AS_NODE', 'ORIGINAL_XDG_CURRENT_DESKTOP']) delete env[k];
  if (process.env.APPDIR) for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS']) {
    if (env[k]) env[k] = env[k].split(':').filter((d) => d && !d.startsWith(process.env.APPDIR)).join(':');
  }
  return env;
}
```

An AppImage runs from a temporary mount (`$APPDIR`) and puts folders from it on `PATH` and `LD_LIBRARY_PATH`. Leaking those into your terminal would make commands load the AppImage's libraries. `{ ...process.env }` copies the environment so the app's own is untouched; `split(':')`/`filter`/`join(':')` rebuild each path list without the AppImage's entries.

A plain child process (`child_process.spawn`) would not work for an interactive shell: programs check whether they are attached to a **terminal** and behave differently (no prompt, no colours, no `vim`). `node-pty` creates a **pseudo-terminal** (pty), the same kernel feature your terminal emulator uses, so the shell believes it is talking to a real terminal.

### Opening a session

```js
ipcMain.handle('session:open', async (_e, connId, cols = 80, rows = 24) => {
  const conn = connId === 'local' ? { protocol: 'local' } : data.connections.find((c) => c.id === connId);
  if (!conn) throw new Error('Connection not found');
  if (conn.protocol === 'rdp') {
    // Check the server's identity ourselves first (clear errors, trust on first use);
    // guacd then accepts only that exact certificate on its own connection.
    const cert = await guacd.rdpFingerprint(conn.host, conn.port || 3389);
    const fp = cert.fingerprint;
    const saved = trust(rdpId(conn), fp);
    if (saved && saved !== fp && !(await confirmChanged(rdpId(conn), 'certificate', `${conn.host}:${conn.port || 3389}`, saved, fp))) {
      throw new Error(`The certificate of ${conn.host} has changed and was not trusted, so banana-phone did not connect. Expected SHA256 ${saved}, got ${fp}.`);
    }
    const notice = !saved ? `Saved the certificate of ${conn.host}: SHA256 ${fp}`
      : saved !== fp ? `Trusted the new certificate of ${conn.host}: SHA256 ${fp}` : undefined;
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password), cert), notice };
  }
  if (conn.protocol === 'vnc') {
    return { kind: 'remote', url: await guacd.openRemote(conn, dec(conn.password)) };
  }
  const id = crypto.randomUUID();
  sessions.set(id, conn.protocol === 'ssh' ? openSsh(id, conn, cols, rows) : openLocal(id, cols, rows));
  return { kind: 'term', id };
});
```

* `async` makes the function return a **Promise** and lets it use `await`, which pauses this function (not the whole app) until another Promise settles. `guacd.openRemote` may need to start a Docker container, which takes a while.
* `throw new Error(...)` inside a `handle` rejects the Promise on the page side, where `connect()` catches it and shows the message in the pane.
* **RDP server identity** works like SSH host keys: the certificate's fingerprint is saved the first time and must match afterwards. A changed certificate opens a warning dialog with both fingerprints: Cancel (the default) stops the connection with an explanation in the pane, and Trust saves the new one and connects. A newly saved or newly trusted certificate is announced with a `notice` carrying the full fingerprint, which the page shows as a toast for 12 seconds so you can compare it with the one the server's administrator sees. See [`rdpFingerprint`](#checking-the-rdp-servers-identity) for how the certificate is fetched.
* VNC has no certificate to check: guacd's VNC support has no TLS, so VNC is best kept on trusted networks or inside a VPN.
* The page only ever sends a connection **id**. It cannot ask main to connect to an arbitrary host with stored credentials.

### Creating the window

```js
app.whenReady().then(() => {
  try { data = store.load(FILE); }
  catch (e) {
    dialog.showErrorBox('banana-phone cannot read your connections', `${FILE}\n\n${e.message}\n\nFix the file or restore it from a .bak file in the same folder, then start again.`);
    return app.exit(1);
  }
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 820,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // The window can leave full screen without the page asking (a window manager shortcut): tell the page.
  // Not when the page asked for it itself, and not when the window was only minimized.
  win.on('leave-full-screen', () => { if (wantFull && !win.isMinimized()) send('win:left-fullscreen'); });
  win.webContents.on('did-start-loading', () => { for (const s of sessions.values()) s.close(); });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
```

* `app.whenReady()` returns a Promise; `.then(fn)` runs `fn` once Electron has finished starting.
* `__dirname` is the folder of the current file. Inside the AppImage that is a path inside `app.asar`, which Electron's `fs` can read like a normal folder.
* `contextIsolation` and `sandbox` keep the page locked down (see [§12](#12-security-choices)).
* `leave-full-screen` fires whenever the window stops being full screen, whatever the reason. `wantFull` is what the page last asked for (set in the `win:fullscreen` handler), so main only tells the page when the page did not ask to leave, and never for a minimize. Telling the page lets it drop its own full-screen state too (see [Full screen current](#tabs-and-panes-the-data-model)), so the pinned pane never stays stuck over a normal-sized window.
* If the page reloads, its terminals are gone, so `did-start-loading` closes their shells in main too, rather than leaving orphan processes.
* `will-navigate` and `setWindowOpenHandler` stop the window from ever leaving the app's own page or opening pop-ups.

### Quitting cleanly

```js
app.on('window-all-closed', () => app.quit());
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.quit());
app.on('will-quit', () => {
  for (const s of sessions.values()) s.close();
  guacd.stopGuacd();
});
```

Closing the window and being killed by the system (logout sends `SIGTERM`) both go through `will-quit`, which ends every session and stops the guacd container.

---

## 7. `preload.js`: the bridge

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bp', {
  get: () => ipcRenderer.invoke('store:get'),
  save: (conn) => ipcRenderer.invoke('store:save', conn),
  ...
  open: (connId, cols, rows) => ipcRenderer.invoke('session:open', connId, cols, rows),
  write: (id, d) => ipcRenderer.send('session:write', id, d),
  onData: (fn) => ipcRenderer.on('session:data', (_e, id, d) => fn(id, d)),
  onExit: (fn) => ipcRenderer.on('session:exit', (_e, id) => fn(id)),
});
```

`exposeInMainWorld('bp', {...})` creates `window.bp` in the page. Because of context isolation, the page gets a *copy* of these functions across a boundary; it cannot reach `ipcRenderer` itself and invent new channels. Every capability the page has is one line in this file, which makes it easy to audit.

The full list of channels:

| Channel | Style | What it does |
| --- | --- | --- |
| `store:get` | invoke | the connection list without passwords |
| `store:save` | invoke | create or update one connection (encrypts a new password) |
| `store:delete` | invoke | delete a connection (writes `.bak` first) |
| `store:addFolder` | invoke | add a folder (and its parents), empty for now |
| `store:removeFolder` | invoke | remove a folder and its subfolders; refused if any connection is inside |
| `store:folderIcon` | invoke | set a folder's fruit icon, `(folder, name)`; refused for an unknown fruit or folder |
| `store:move` | invoke | `(kind, id, to, before)`: move a connection (`'conn'`, its id) or folder (`'folder'`, its path) into folder `to`, in front of sibling `before` (saves the order); `result` is a moved folder's new path |
| `store:bulkPreview` | invoke | which connections a bulk edit would touch |
| `store:bulkApply` | invoke | apply a bulk edit (writes a timestamped backup first); `result` is how many changed |
| `store:forgetHost` | invoke | forget a connection's saved SSH host key or RDP certificate |
| `session:open` | invoke | start a terminal (returns a session id) or a remote desktop (returns a websocket URL) |
| `session:write` | send | keystrokes into a terminal |
| `session:resize` | send | new terminal size in columns and rows |
| `session:close` | send | end a terminal session |
| `session:data` | main → page | terminal output |
| `session:exit` | main → page | the shell or SSH connection ended |
| `clipboard:read` | invoke | the system clipboard's text |
| `win:fullscreen` | send | `setFullScreen(on)` on the window |
| `win:minimize` | send | minimize the window |
| `win:left-fullscreen` | main → page | the window left full screen without the page asking (not sent for a minimize) |
| `clipboard:write` | send | put text on the system clipboard |

Every `store:` channel that changes something answers the same way, with the new view plus a `result` (see `change` in [§6](#ipc-handlers-for-the-store)), so the page can pass the answer straight to `refresh`.

Note `onData` strips the IPC event object (`_e`) before calling the page's function, so no Electron internals leak into the page either.

---

## 8. `guacd.js`: remote desktops through Guacamole

Drawing a Windows desktop inside a web page is a hard problem that the **Apache Guacamole** project has already solved. It has three parts, and banana-phone uses all three:

1. **guacd**: a C program that speaks RDP, VNC and SSH to real servers and translates everything into the simple text-based *Guacamole protocol* ("draw this image here", "mouse moved there"). We run the official Docker image.
2. **guacamole-lite**: a small Node.js server that accepts **websocket** connections from the page and forwards them to guacd over TCP.
3. **guacamole-common-js**: the browser library that draws the Guacamole protocol onto a `<canvas>` and sends your keyboard and mouse back.

### Starting guacd

```js
const NAME = 'banana-phone-guacd';
const IMAGE = 'guacamole/guacd:1.6.0'; // 1.6 adds cert-fingerprints; still serves guacamole-common-js 1.5 clients

const docker = (args) => new Promise((resolve, reject) =>
  execFile('docker', args, { timeout: 300000 }, (err, stdout, stderr) =>
    err ? reject(new Error(err.code === 'ENOENT' ? 'Docker is not installed. …' : (stderr || err.message).trim()))
        : resolve(stdout.trim())));
```

* `new Promise((resolve, reject) => …)` wraps old-style **callback** code (`execFile` calls a function when done) into a Promise, so callers can simply `await docker([...])`.
* `execFile` runs a program with an **argument array**, not a shell command string. Nothing in the arguments can be misread as shell syntax, which avoids injection bugs.

```js
let starting;
let startedHere = false; // only stop a guacd this launch created
function ensureGuacd() {
  return (starting ||= (async () => {
    // Reuse a running container only if it is the image this version expects.
    const running = await docker(['inspect', '-f', '{{.State.Running}} {{.Config.Image}}', NAME]).catch(() => '');
    if (running !== `true ${IMAGE}`) {
      await docker(['rm', '-f', NAME]).catch(() => {});
      await docker(['run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${GUACD_PORT}:4822`, IMAGE]);
      startedHere = true;
    }
    for (let i = 0; i < 50; i++) {
      if (await portOpen()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('guacd did not start listening on 127.0.0.1:4822');
  })().catch((e) => { starting = null; throw e; }));
}
```

* `starting ||= (…)` is **logical OR assignment**: only assign if `starting` is currently falsy. If you open four RDP panes at once, all four share the *same* start-up Promise instead of racing to start four containers.
* `(async () => { … })()` defines an async arrow function and immediately calls it (an *IIFE*: immediately invoked function expression).
* `docker inspect -f` prints fields of the container using a Go template: here whether it is running and which image it came from, e.g. `true guacamole/guacd:1.6.0`. A container left over from an older banana-phone (an older guacd that cannot pin certificates) is replaced instead of reused.
* `-p 127.0.0.1:4822:4822` publishes guacd's port **only on localhost**, so other machines on your network cannot use your guacd.
* `--rm` deletes the container when it stops; nothing is left behind.
* The loop polls up to 10 s (50 × 200 ms) for the port to accept connections.
* If anything fails, `.catch` clears `starting` so the next attempt tries again rather than reusing a failed Promise.
* `startedHere` records whether *this* launch created the container. On quit, `stopGuacd` only stops a container it started, so it never cuts off sessions belonging to something else that was already using it.
* If the container dies later (Docker restarted, crash), the cached Promise would still say "started". `openRemote` checks the port first and forgets the cache when nothing answers:

```js
  if (starting && !(await portOpen())) starting = null; // container died or Docker restarted: start again
```

### The websocket bridge

```js
const key = crypto.randomBytes(32); // per-launch: tokens die with the app

function ensureBridge() {
  if (bridge) return bridge;
  bridge = new Promise((resolve) => {
    const server = new GuacamoleLite(
      { host: '127.0.0.1', port: 0 },
      { host: '127.0.0.1', port: GUACD_PORT },
      { crypt: { cypher: 'AES-256-CBC', key }, log: { level: 'ERRORS' }, maxInactivityTime: 0 },
    );
    server.webSocketServer.on('listening', () => resolve(server.webSocketServer.address().port));
  });
  return bridge;
}
```

* `port: 0` asks the operating system for any free port; we read the real one once it is `listening`.
* `maxInactivityTime: 0` turns off guacamole-lite's idle disconnect, so an RDP session you are only watching does not get dropped.

### Tokens: how credentials reach guacd without passing through the page

The page opens a websocket to guacamole-lite and must say *what* to connect to. guacamole-lite's answer is an **encrypted token**: a JSON object with the host and credentials, encrypted with a key only the main process knows. The page holds the token but cannot read or change it.

```js
// guacamole-lite decrypts as ASCII, so escape non-ASCII (e.g. "pässword") to \uXXXX first.
function encryptToken(obj) {
  const json = JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const value = Buffer.concat([cipher.update(json, 'ascii'), cipher.final()]);
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value: value.toString('base64') })).toString('base64');
}
```

* **AES-256-CBC** is a standard cipher. The 32-byte `key` is generated fresh on every launch, so tokens are useless after you quit. The `iv` (initialisation vector) is 16 random bytes that make every token different even for the same input.
* guacamole-lite's own decryption reads the plaintext as ASCII, which would garble a password like `pässword`. JSON allows any character to be written as `\uXXXX`, so we escape everything outside plain ASCII first. `[\u007f-\uffff]` is a regex character range; `charCodeAt(0).toString(16)` gives the character's number in hexadecimal; `padStart(4, '0')` pads it to 4 digits. `guacd.test.js` checks that `pässwörd€` survives the round trip.

### Checking the RDP server's identity

Every RDP connection starts the same way: the client sends a short binary *Connection Request* saying which security it supports, the server answers which one it picked, and if that is TLS (or NLA, which runs inside TLS) both sides switch to TLS. The server's TLS certificate is its identity. `rdpFingerprint` performs just that opening and reads the certificate, without logging in. The real work happens in `probeRdp`:

```js
function probeRdp(host, port, tlsOptions) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const fail = (msg) => { sock.destroy(); reject(new Error(msg)); }; // no-op once resolved
    sock.setTimeout(10000, () => fail(`${host}:${port} did not answer in time`)); // idle timer, covers the TLS handshake too
    sock.once('error', (e) => fail(`${host}:${port}: ${e.message}`));
    sock.once('close', () => fail(`${host}:${port} closed the connection`));
    // TPKT header (4 bytes) + X.224 Connection Request (7) + RDP_NEG_REQ (8) asking for TLS (1) or NLA (2)
    sock.write(Buffer.from([3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0]));
    let buf = Buffer.alloc(0);
    sock.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (buf[0] !== 3) return fail(`${host}:${port} does not look like an RDP server`); // TPKT version is always 3
      if (buf.length < 4 || buf.length < buf.readUInt16BE(2)) return; // TPKT length says more is coming
      sock.off('data', onData);
      // byte 11: 2 = RDP_NEG_RSP, 3 = RDP_NEG_FAILURE; bytes 15-18: the protocol picked (or failure code)
      if (buf.length >= 19 && buf[11] === 3) return fail(`${host} refused TLS and NLA (failure code ${buf.readUInt32LE(15)})`);
      const selected = buf.length >= 19 && buf[11] === 2 ? buf.readUInt32LE(15) : 0;
      if ((selected & 3) === 0) return fail(`${host} only offers legacy RDP security, so its identity cannot be checked`);
      const t = tls.connect({ socket: sock, rejectUnauthorized: false, ...tlsOptions }, () => {
        const fingerprint = t.getPeerCertificate().fingerprint256;
        t.destroy();
        fingerprint ? resolve({ fingerprint, nla: (selected & 2) !== 0 }) : reject(new Error(`${host} sent no certificate`));
      });
      t.once('error', (e) => fail(`${host}: TLS failed: ${e.message}`));
    });
  });
}
```

* `Buffer.from([3, 0, 0, 19, …])` builds raw bytes. `3, 0` starts a **TPKT** packet and `0, 19` is its total length (19 bytes) as a 16-bit big-endian number. `14, 0xe0` is an X.224 *Connection Request*. `1, 0, 8, 0` starts an RDP negotiation request of 8 bytes, and `3, 0, 0, 0` is a 32-bit little-endian bit mask: `1` (TLS) + `2` (NLA) = `3`.
* TCP delivers a stream, not messages, so the reply may arrive in pieces. `buf` collects them until it holds as many bytes as the TPKT header announced (`readUInt16BE(2)`: a big-endian 16-bit number starting at byte 2).
* `fail` destroys the socket and rejects. A Promise can settle only once, so a `fail` after `resolve` (for example the `close` that follows `t.destroy()`) does nothing. Listening for `close` matters: a server that simply hangs up sends no error, and without it the pane would say "Connecting…" forever. The idle timeout stays on for the TLS handshake, so a server that stalls there is caught too.
* `buf[0] !== 3` fails fast when something other than RDP answers on the port (an SSH server, say), instead of waiting for the timeout.
* `& 3` is a **bitwise AND**: it keeps only the TLS and NLA bits of the protocol the server picked. Zero means the server will only talk legacy RDP encryption, which has no certificate, so there is no identity to check and the connection is refused.
* `tls.connect({ socket: sock, … })` upgrades the existing TCP connection to TLS. `rejectUnauthorized: false` is deliberate here: Windows servers usually have self-signed certificates that no certificate authority vouches for. Trust comes from the fingerprint matching what was seen before, not from an authority.
* `nla: (selected & 2) !== 0` records whether the server chose NLA (bit 2) or plain TLS (bit 1).
* `fingerprint256` is the SHA-256 hash of the certificate, written as hex pairs separated by colons (`07:34:83:…`).

`rdpFingerprint` wraps `probeRdp` to handle one Windows quirk:

```js
async function rdpFingerprint(host, port) {
  try {
    return await probeRdp(host, port, {});
  } catch (e) {
    if (!/KEY_USAGE_BIT_INCORRECT/.test(e.message)) throw e;
    return probeRdp(host, port, RSA_KEY_EXCHANGE).catch(() => {
      throw new Error(`${host}'s certificate only allows RSA key exchange, which the server refused, so its identity could not be read`);
    });
  }
}
```

```js
const RSA_KEY_EXCHANGE = { maxVersion: 'TLSv1.2', ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA:AES128-SHA' };
```

A certificate lists what its key may be used for (**key usage**). The self-signed certificate Windows makes for RDP usually says only *key encipherment*: the client may encrypt a secret to the key. Modern TLS handshakes (ECDHE key exchange, and every TLS 1.3 handshake) instead need the server to *sign* with its key, which that certificate doesn't allow. Electron uses Google's **BoringSSL** rather than OpenSSL, and BoringSSL enforces the rule, failing with `KEY_USAGE_BIT_INCORRECT`. FreeRDP inside guacd uses OpenSSL, which doesn't, so only this probe is affected.

The fix asks for exactly what the certificate permits. TLS 1.2 with **RSA key exchange**, the `AES…-SHA` cipher suites without `ECDHE` in their name, is "encrypt a secret to the server's key", which is key encipherment. Modern handshakes are still tried first, because some hardened servers turn RSA key exchange off. The weaker exchange is fine for this connection: it only reads the certificate, which the server sends in the clear anyway, and nothing secret is sent over it.

* `/KEY_USAGE_BIT_INCORRECT/.test(e.message)` is a **regular expression** test: true if the text appears anywhere in the error message.
* `throw e` re-throws every other error unchanged, so only this one case is retried.
* `.catch(() => { throw … })` replaces the retry's error, if it fails too, with one naming the real cause: a server can turn RSA key exchange off, and then this certificate cannot be read at all.
* `{ ...tlsOptions }` spreads the options into the `tls.connect` call: nothing for the first try, the TLS 1.2 limits for the retry.

Plain Node also uses OpenSSL, so the unit tests would pass even with the bug. `npm run test:electron` runs `guacd.test.js` inside Electron's runtime (`ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave like `node`), where a certificate made with `-addext keyUsage=keyEncipherment,dataEncipherment` reproduces the Windows case. CI runs it in the `ui` job, which already has Electron.

The app then hands both results to guacd, so that FreeRDP (the RDP library inside guacd) accepts **exactly** that certificate, over exactly that kind of security, on its own connection:

```js
      security: cert.nla ? 'nla' : 'tls',
      // Accept exactly this certificate, self-signed or not; anything else is refused by FreeRDP in guacd.
      'cert-fingerprints': `sha256:${cert.fingerprint}`,
```

Both halves are needed. An impostor sitting between you and the server could let the app's check through to the real server, then answer guacd's connection a moment later with its own certificate (refused by `cert-fingerprints`) or with legacy RDP security, which has no certificate at all and would skip the fingerprint check. Telling guacd to use `tls` or `nla` rather than `any` closes that second door: the server must speak TLS, so it must show the pinned certificate. Both attacks were reproduced with a fake server; guacd logs `Certificate validation failed` and `Security negotiation failed` respectively.

### Building the connection

```js
async function openRemote(conn, password, cert) {
  if (starting && !(await portOpen())) starting = null; // container died or Docker restarted: start again
  await ensureGuacd();
  const port = await ensureBridge();
  const host = await resolveHost(conn.host);
  const token = encryptToken({ connection: { type: conn.protocol, settings: remoteSettings({ ...conn, host }, password, cert) } });
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

async function resolveHost(host) {
  try {
    return (await dns.promises.lookup(host, { order: 'ipv4first' })).address;
  } catch (e) {
    throw new Error(`Could not look up ${host}: ${e.code || e.message}`);
  }
}

function remoteSettings(conn, password, cert) {
  const settings = { hostname: conn.host, port: String(conn.port || (conn.protocol === 'rdp' ? 3389 : 5900)), password: password || '' };
  if (conn.protocol === 'rdp') {
    Object.assign(settings, {
      username: conn.username || '', domain: conn.domain || '',
      // Exactly the security the server picked when checked: never 'any', which would let an
      // impostor fall back to legacy RDP (no certificate) and slip past the pinned fingerprint.
      security: cert.nla ? 'nla' : 'tls',
      // Accept exactly this certificate, self-signed or not; anything else is refused by FreeRDP in guacd.
      'cert-fingerprints': `sha256:${cert.fingerprint}`,
      'resize-method': 'display-update',
    });
    if (conn.adminSession) settings.console = 'true'; // the server's console / admin session, like mstsc /admin
  } else if (conn.username) settings.username = conn.username;
  return settings;
}
```

**Why the app looks up the name, not guacd.** guacd runs inside a Docker container, and Docker gives the container only a copy of the host's `/etc/resolv.conf` (the list of DNS servers). Your own machine resolves names through more than that: `/etc/hosts`, mDNS for `.local` names, and DNS servers a VPN sets for particular domains (*split DNS*, e.g. "ask the office DNS server about `*.prod.example.com`"). The container sees none of those, so a private name that works in Remmina or `ping` could fail in guacd. `resolveHost` looks the name up in the app, through the same system resolver every other program uses (`dns.promises.lookup` calls the C library's `getaddrinfo`), and hands guacd the address instead.

* `{ ...conn, host }` makes a copy of the connection with `host` replaced (the *spread* syntax), so the saved connection keeps its name.
* `order: 'ipv4first'` prefers an IPv4 address, because Docker's default network has no IPv6.
* Connecting by address is safe for the certificate check: guacd accepts only the pinned fingerprint, whatever name or address it dialled.

The settings are built by their own function, `remoteSettings`, which only computes values and never touches Docker or the network. That lets `guacd.test.js` check them directly without starting guacd.

* For **Active Directory**, RDP sends `username` + `domain` + `password` (the equivalent of typing `CORP\admin` at a Windows login). `security` is NLA or TLS, whichever the server chose during the identity check (see above).
* `cert-fingerprints` pins the certificate checked above, as explained in the previous section.
* `resize-method: display-update` lets the remote desktop change resolution live when you resize a pane or switch from one pane to a 2×2 grid.
* `console: 'true'` is set only when the connection's **Admin session (mstsc /admin)** box is ticked. It connects to the server's console session (session 0 on older Windows, the "admin" session on Remote Desktop Session Host servers) instead of a new user session. Admins use it to reach a server directly when a session-host farm's load balancing would send them elsewhere, or when the normal session limit is reached. guacd's parameters are all strings, hence `'true'` rather than `true`.
* `Object.assign(target, source)` copies `source`'s properties onto `target`.
* `encodeURIComponent` makes the token safe to put in a URL (escaping `+`, `/`, `=`).

---

## 9. `renderer/index.html` and `fruit.css`: the look

### HTML

The page is a fixed skeleton; `app.js` fills it in.

```html example
<header class="top"> falling fruit · brand · search pill · Terminal / + Connection / Bulk edit / theme </header>
<div class="app">
  <aside class="side">  … <div id="tree"> (folder tree) </aside>
  <section class="work">
    <nav class="tabbar"> <div id="tabs"> · layout buttons </nav>
    <div id="stage"> (one .split per tab lives here) </div>
  </section>
</div>
<dialog id="search-dlg"> … <dialog id="edit-dlg"> … <dialog id="bulk-dlg"> …
<script type="module" src="app.js"></script>
```

* `<dialog>` is a built-in HTML element for pop-ups. `dialog.showModal()` opens it on top of everything with a dimmed backdrop, traps focus inside it, and closes on Esc.
* A `<form method="dialog">` inside a dialog closes the dialog when submitted, and the clicked button's `value` becomes `dialog.returnValue`. That is how the code tells "Save" (`ok`) from "Cancel".
* The Cancel buttons are `type="button"` (not submit buttons) and close their dialog in code. When you press Enter in a form, the browser "clicks" the form's first submit button; with Cancel as a plain button, Enter means Save / OK.

```js
document.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => b.closest('dialog').close('cancel')));
```

* The edit and prompt dialogs act on the form's **`submit`** event, not on the dialog's `close` event. `submit` fires at the moment you press Save or Enter (the Cancel button is not a submit button), while the form still holds what you typed. `close` fires for Save, Cancel and Esc alike, and Chromium may deliver it late, even after the dialog has been reopened with other values. See [§13](#13-tests-and-ci) for the bug this caused.

```js
  form.onsubmit = async () => {
    const f = form.elements;
```

```js
    d.querySelector('form').onsubmit = () => res($('#prompt-in').value.trim()); // OK or Enter
    d.onclose = () => { if (!d.open) res(null); }; // Esc/Cancel; a late close arriving after a reopen is ignored
```

* `ask()` returns a Promise that settles exactly once. OK resolves it with the text. A later `res(null)` from the close that follows does nothing, because a Promise that has already settled ignores further calls. Assigning `onsubmit`/`onclose` (rather than `addEventListener`) **replaces** the previous opening's handler instead of stacking another one.
* `<datalist>` gives an `<input>` a dropdown of suggestions (existing folders, existing usernames) while still allowing free text.
* `type="module"` makes `app.js` an **ES module**, which allows `import` statements.

The **Content-Security-Policy** meta tag is a second line of defence:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ws://127.0.0.1:*; font-src 'self'">
```

It tells Chromium to load scripts only from the app's own files and to open network connections only to websockets on localhost. Even if some text were ever injected into the page as HTML, it could not load a script from the internet or send data anywhere.

### CSS theme

The colours come from the same palette as fruit-fs, defined once as **custom properties** (CSS variables):

```css example
:root {
  --orange: #FF8A00; --banana: #FFE135; --leaf: #4E9F3D; --berry: #E8434B;
  --bg: #FFF8EC; --surface: #FFFFFF; --ink: #3B2A1A; --line: #F1DFC4;
  --term-bg: #FFFDF8;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #161311; --ink: #F7EFE6; … }
}
:root[data-theme="dark"] { --bg: #161311; --ink: #F7EFE6; … }
```

* Everything else uses `var(--orange)` etc., so switching theme only means switching these values.
* The `@media` block follows your system's light/dark setting. The ◐ button sets `data-theme="light"` or `"dark"` on `<html>`, which wins over the system setting through the `:not([data-theme="light"])` and `[data-theme="dark"]` selectors.

The split layouts are pure CSS, driven by one class on each tab's container:

```css example
.split       { position: absolute; inset: 0; display: flex; padding: 6px; }  /* h: side by side */
.split.v     { flex-direction: column; }                                       /* v: stacked */
.split.grid  { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; gap: 6px; }
.pane        { flex: 1 1 0; min-width: 0; min-height: 0; … }
```

* **Flexbox** (`display: flex`) lays children in a row (or a column with `flex-direction: column`). `flex: 1 1 0` means "start from zero size and share the free space equally". The gutter drag changes a pane's `flex-grow` to give it a bigger share.
* `min-width: 0` matters: by default a flex item will not shrink below its content's size, which would stop terminals from getting narrower.
* **CSS grid** with `grid-template-columns: 1fr 1fr` makes two equal columns (`fr` = "fraction of free space"); `grid-auto-rows: 1fr` makes rows equal height. Four panes fill a 2×2 grid, three panes fill three cells.

The whole sidebar can be collapsed with the ☰ button or **Ctrl+B**, which gives the sessions the full width:

```css
.side-collapsed .side { margin-left: -272px; visibility: hidden; }
```

A negative `margin-left` slides the sidebar out of view (with a `transition` for the animation) and the work area's flexbox grows into the space. `visibility: hidden` also takes its buttons out of the keyboard tab order while it is hidden. The open terminals notice their new size through their ResizeObserver and refit.

### Falling fruit in the top bar

The top bar has a light shower of fruit drifting down behind the buttons. It is the same effect as bunch-banana's header. It has three parts.

An empty, decorative container is the first thing in the header:

```html
    <div class="fall" aria-hidden="true"></div>
```

`aria-hidden="true"` tells screen readers to skip it, since it is decoration only.

CSS stacks the fruit **behind** everything else and lets clicks pass through:

```css
.top { position: relative; overflow: hidden; }
.top > :not(.fall) { position: relative; z-index: 1; }
.fall { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
```

* `position: absolute; inset: 0` stretches `.fall` over the whole header. It is positioned against the header because the header is `position: relative`.
* `z-index` decides what is drawn on top: the buttons (`1`) cover the fruit layer (`0`). `.top > :not(.fall)` means "every direct child of the header except the fruit layer".
* `pointer-events: none` makes the layer invisible to the mouse: a click on a falling banana lands on the button underneath.
* `overflow: hidden` clips fruit that has fallen below the header's bottom edge.

Each fruit is an `<img>` that runs one **keyframe animation** forever:

```css
  animation: fruit-fall var(--dur, 9s) linear var(--delay, 0s) infinite;
```

```css example
@keyframes fruit-fall {
  0%   { transform: translateY(-30px) translateX(0) rotate(0deg); }
  50%  { transform: translateY(21px) translateX(var(--sway, 10px)) rotate(18deg); }
  100% { transform: translateY(72px) translateX(calc(var(--sway, 10px) * -0.5)) rotate(-28deg); }
}
```

* `@keyframes` lists poses at points in time. The browser moves smoothly between them: from above the bar (-30px), drifting sideways by `--sway` and turning, to below it (72px), where it is clipped.
* The fruit differ only in their **CSS variables**. `var(--dur, 9s)` reads `--dur` and falls back to `9s` if it is not set.
* `@media (prefers-reduced-motion: reduce) { .fall { display: none; } }` hides it all for people who ask their system for less motion.
* `body:has(dialog[open]) .fall img { animation-play-state: paused; }` freezes the fruit while a dialog is open. `:has()` matches an element that *contains* something, here "the body, when it contains an open dialog". Dialogs blur everything behind them, and a blur over moving fruit would have to be recalculated on every frame.

`app.js` fills the layer with ten fruit at startup:

```js
function rain(fall, n = 10) {
  for (let i = 0; i < n; i++) {
    const img = el('img', { src: `svg/${FRUITS[Math.floor(Math.random() * FRUITS.length)]}.svg`, alt: '' });
```

`FRUITS` is the list from `shared.mjs`, the same one that decides which fruit a folder icon may be.

```js
      '--left': `${(i * (100 / n) + 2 + Math.random() * 6).toFixed(1)}%`, // spread evenly, then jitter
      '--delay': `${(-Math.random() * 12).toFixed(2)}s`, // negative: start mid-fall, not all at the top
```

```js
    for (const [k, v] of Object.entries(vars)) img.style.setProperty(k, v);
```

* `Math.random()` gives a number from 0 up to (not including) 1. `Math.floor(Math.random() * list.length)` turns that into a random index into the list.
* `i * (100 / n)` spaces the ten fruit evenly across the bar (0%, 10%, 20% …). The small random extra stops them looking like a grid.
* A **negative** `animation-delay` starts the animation as if it had already been running that long, so the fruit are spread through their fall from the first frame instead of all appearing at the top together.
* `toFixed(1)` rounds to one decimal and returns a string.
* `Object.entries(vars)` turns the object into `[key, value]` pairs, and `for (const [k, v] of …)` unpacks each pair. `style.setProperty` sets a CSS variable on that one image. Setting styles through the DOM API like this works under any Content-Security-Policy, unlike writing a `style="…"` attribute into HTML.

The `<details>`/`<summary>` sidebar is the "dropdown view": every folder is a native disclosure widget, so clicking, keyboard toggling and accessibility come for free. The arrow is drawn with `summary::before` and rotated 90° when `details[open]`.

---

### The juice cup and the typing banana

The left of the top bar holds two pictures instead of the app's name:

```html
    <div class="brand"><img id="juice" src="juice-empty.png" alt="No active connections"><img class="brand-anim" src="banana-typing.gif" alt="banana-phone"></div>
```

* `banana-typing.gif` is an animated picture of a banana at a terminal. A GIF plays and loops by itself, so no code drives it. Its `alt` text is the app's name, which is what a screen reader says in place of the picture.
* The cup starts empty. `render()` in `app.js`, which runs every time a tab opens or closes, sets it:

```js
  const juice = $('#juice');
  juice.classList.toggle('on', tabs.length > 0);
  juice.src = tabs.length ? 'juice-full.png' : 'juice-empty.png';
  juice.alt = tabs.length ? 'Connections active' : 'No active connections';
```

* `tabs.length ? a : b` picks `a` when at least one tab is open (any number but 0 counts as true) and `b` when none is.
* `classList.toggle('on', condition)` adds the class `on` when the condition is true and removes it when false. The class only adds the glow:

```css
#juice.on { filter: drop-shadow(0 0 5px var(--orange)); }
```

* `drop-shadow` follows the shape of the picture, not its square box, so the orange light hugs the cup. The three numbers are: no sideways offset, no downward offset, 5px of blur.
* "Active" here means "a tab is open". A tab whose session has dropped still counts until you close it.

## 10. `renderer/app.js`: the front end

### Imports and helpers

```js
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import Guacamole from '../node_modules/guacamole-common-js/dist/esm/guacamole-common.js';
import { shareClipboard, clean } from './clipboard.js';
import { FRUITS, inFolder, parentOf, matches } from './shared.mjs';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
```

* `import { Terminal } from '…'` is ES-module syntax: take the export named `Terminal`. `import Guacamole from '…'` takes the module's **default** export.
* There is no bundler (webpack, vite…). The page imports the libraries' ready-made ES-module files straight from `node_modules`, which keeps the build to zero steps.
* `./shared.mjs` is the helper file `store.js` also loads (see [§2](#2-the-files-and-how-they-fit-together)), so the page and the store agree on folder paths, search and the fruit list by construction.
* `$` is a short alias for `document.querySelector`.
* `el('div', { className: 'pane' }, child1, child2)` creates an element, copies properties onto it, and appends children. `...kids` is a **rest parameter**: it collects all remaining arguments into an array.

**Why `el` and `textContent` instead of building HTML strings?** Connection names, hosts and tags are your data. If code did `div.innerHTML = '<b>' + name + '</b>'`, a name like `<img src=x onerror=…>` would become live HTML. Setting `textContent` always treats the value as plain text. The whole file never writes user data through `innerHTML`.

### The sidebar tree

The page works straight from `view.folders`. The store guarantees it lists every folder, parents and folders only a connection mentions included (`fillFolders`, see [§5](#the-data-on-disk)), so the page has nothing to work out. It is not sorted: the saved order is the order.

`renderTree` builds nested `<details>` with a **recursive** function `build(parent)` that finds the folders exactly one level below `parent`, and for each one calls `build` again for its children:

```js
const kidsOf = (parent) => view.folders.filter((f) => parentOf(f) === parent);
const build = (parent) => {
  const nodes = kidsOf(parent).map((f) => {
    const sum = el('summary', {}, el('img', { className: 'folder-icon', src: `svg/${view.folderIcons[f] || 'crate'}.svg`, alt: '' }), el('span', { textContent: f.split('/').pop() }), el('span', { className: 'count', textContent: total }));
    const d = el('details', { open: openFolders.has(f) }, sum, ...build(f), ...connsIn(f).map(connRow));
    d.ontoggle = () => { d.open ? openFolders.add(f) : openFolders.delete(f); saveOpen(); };
    return d;
  });
  return nodes;
};
```

`kidsOf('')` is the top-level folders, because `parentOf` of a top-level folder is `''`. The same `view.folders` fills the folder suggestions in the edit dialog and the bulk edit dialog.

The collapse toggle for the whole sidebar is a class on `<body>`:

```js
function setSide(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  $('#toggle-side').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('bp-side', collapsed ? '1' : ''); } catch {}
}
```

`classList.toggle(name, force)` adds the class when `force` is true and removes it when false. `aria-expanded` tells screen readers whether the list is showing.

Each folder shows its fruit icon (`crate` by default). Right-click → **Change icon…** opens `#icon-dlg`, a grid of `button.pic`; each has an `aria-label` with the fruit name and `aria-pressed` on the current one, and they are real buttons so Tab and Enter work.

Which folders are open is remembered in `localStorage` (a small per-app key/value store in the browser), wrapped in `try`/`catch` because storage can be unavailable.

Each connection row supports: click to select, double-click or Enter to connect, **Shift**+double-click to connect into a split, right-click for a menu, and drag to move it (HTML5 drag-and-drop with a custom data type `bp/conn`).

Dragging works on folders too (`bp/folder`). Every place something can be dropped (the tree itself, folder rows, connection rows, and the tab bar for pane headers) goes through one helper:

```js
// Drag and drop, once. `types` are the drag kinds this node accepts; `where(e, kind)` says what a drop
// here would do: nothing (falsy: not handled here, the event bubbles on), or { cls, drop(id) }.
function dropZone(node, types, where) {
  const hit = (e) => { const k = types.find((t) => e.dataTransfer.types.includes(t)); const w = k && where(e, k); return w && { k, ...w }; };
  const clear = () => node.classList.remove('drop', 'drop-before');
  node.ondragover = (e) => {
    const h = hit(e);
    if (!h) return;
    e.preventDefault(); e.stopPropagation();
    clear();
    if (h.cls) node.classList.add(h.cls);
  };
  node.ondragleave = clear;
  node.ondrop = (e) => {
    clear();
    const h = hit(e);
    if (!h) return;
    e.stopPropagation(); // an outer zone (the tree: "top level") must not also act
    h.drop(e.dataTransfer.getData(h.k));
  };
}
```

* `hit(e)` asks the same question on hover and on drop: is something I accept being dragged (`e.dataTransfer.types`), and if so, what would dropping it here do? Asking once in one place means the highlight you see while dragging always matches what the drop does.
* In `dragover`, `e.preventDefault()` is what tells the browser "a drop is allowed here"; without it the drop event never fires. `cls` is the highlight: `drop` (dashed outline, "into") or `drop-before` (a line above, "in front of").
* `e.stopPropagation()` keeps an outer zone from acting too. The tree contains every row, so without it a drop onto a folder would also count as a drop on the tree, meaning "top level".

Each caller only says what a drop means:

* a connection onto a connection row: in front of that row (a line shows above it);
* a connection or folder onto a folder row: into that folder, at the end (dashed outline). For a folder being dragged, the top quarter of the row means "in front of this folder" instead (the line);
* onto the empty part of the list: the top level. Its `where` is falsy unless `e.target === e.currentTarget`, i.e. the pointer is on the tree itself and not on a row inside it.

```js
dropZone($('#tree'), ['bp/conn', 'bp/folder'], (e, k) => e.target === e.currentTarget && { drop: (id) => moveTo(k, id, '') });
```

Each drop calls `moveTo`, which calls `window.bp.move(kind, id, to, before)` and so reaches `moveConn` or `moveFolder` in the store. A refused move (a folder into itself, a duplicate path) throws, and the error shows as a toast. A folder's open/closed state is remembered by path, so after a folder move the renderer renames the matching entries in `openFolders`, using the new path main returns as `result` rather than working it out again:

```js
    for (const f of [...openFolders]) if (inFolder(f, id)) { openFolders.delete(f); openFolders.add(v.result + f.slice(id.length)); }
```

The right-click menus have **Move up** and **Move down**, so the feature works without a mouse. `moveRows(kind, id, to, sibs)` builds those two menu rows for a connection or a folder from its siblings in order: up lands it in front of the one above, down in front of the one *two* below (the one just below is the one it passes; past the end means "last"). They call the same `moveTo`.

### Quick search (Ctrl+K)

```js
sIn.onkeydown = (e) => {
  if (e.key === 'ArrowDown') { hitIdx = Math.min(hits.length - 1, hitIdx + 1); drawHits(); e.preventDefault(); }
  if (e.key === 'ArrowUp')   { hitIdx = Math.max(0, hitIdx - 1); drawHits(); e.preventDefault(); }
  if (e.key === 'Enter' && hits[hitIdx]) { $('#search-dlg').close(); connect(hits[hitIdx].id, e.shiftKey); }
};
```

`runSearch` is one line, `view.connections.filter((c) => matches(c, sIn.value))`: it calls the very `matches` from `shared.mjs` that `store.js` exports and `store.test.js` exercises (see [§5](#searching)), so quick search and the store cannot disagree about what "every word must appear somewhere" means. `Math.min`/`Math.max` keep the highlighted index inside the list. `e.preventDefault()` stops the arrow key from also moving the text cursor. The highlighted row has `aria-selected="true"`, which both styles it (banana yellow) and tells screen readers which option is current.

### Tabs and panes: the data model

```js
// tab  = { id, layout: 'h'|'v'|'grid', panes: [pane], active: pane, root: <div.split> }
// pane = { id, title, protocol, root, body, term?, fit?, sid?, guac?, dispose() }
const tabs = [];
let current = null;
```

The model is deliberately small:

* A **tab** is a list of up to 4 panes plus a layout name. Its `root` is one `<div class="split">` inside `#stage`. Only the current tab's root is visible (`hidden` on the others).
* A **pane** is one session. Its `root` element is created once and then only ever *moved* between tabs with `appendChild`/`replaceChildren`. Moving a DOM element keeps its state, so a running terminal or remote desktop survives being dragged into another tab or switched from split to grid.

```js
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
```

That is the entire layout engine: set a class (`h`, `v`, `grid` or `single`) and put the panes in order with a gutter between neighbours. CSS does the rest.

How the user's actions map onto it:

| Action | What the code does |
| --- | --- |
| Double-click / Enter | `connect(id)` → new tab with one pane |
| Shift + double-click / Shift+Enter | `connect(id, true)` → add pane to current tab (switches to grid at 3+) |
| ◫ ⬒ ⊞ buttons | set `current.layout` to `h`, `v` or `grid`, then `render()` |
| **Split all** | `movePane` every open pane into the current tab (up to 4) |
| **Tab all** | `movePane(p, null)` for every pane but the first: each gets a new tab |
| **Full screen current** (Ctrl+Alt+F) | `setFull(current.active)`: adds `.full` to the active pane (`position: fixed; inset: 0`, header hidden) and calls `window.bp.fullScreen(true)`; the pane stays in the DOM. A faint banana at top centre reveals **Minimize** (`window.bp.minimize()`) and **Back to tab** (`setFull(null)`). It also leaves when the pane closes or its session ends, and when the window leaves full screen by itself (see below) |
| ⇱ on a pane / drag a pane header onto the tab bar | `movePane(p, null)` → its own tab |
| Drag a pane header onto another tab | `movePane(p, thatTab)` → joins that tab's split |
| Folder menu → Open all in split | opens up to 4 connections of that folder in one tab |
| Ctrl+Alt+Arrow | move focus between panes in the tab |
| Ctrl+Tab / Ctrl+Shift+Tab | next / previous tab |
| Ctrl+Shift+C / Ctrl+Shift+V in a terminal | copy selection / paste |

Full screen has three parts that must always agree: the pane's `.full` class, the banana, and the real window. One function changes all three, so they cannot get out of step:

```js
function setFull(p) { // p = the pane to full-screen, or null to leave; pane class, banana and real window change together
  if (p === fsPane) return;
  const was = fsPane;
  fsPane = p;
  was?.root.classList.remove('full');
  p?.root.classList.add('full');
  $('#fs-banana').hidden = !p;
  window.bp.fullScreen(!!p);
  focusPane(p || was); // focusPane ignores a pane that is no longer in a tab
}
const unfull = (p) => { if (p === fsPane) setFull(null); }; // a pane that closes or ends leaves full screen
window.bp.onLeftFullScreen(() => setFull(null)); // e.g. a window manager shortcut took the window out of full screen
```

* `was?.root…` and `p?.root…` use optional chaining, so the same lines work for entering (`was` is `null`), leaving (`p` is `null`) and switching panes.
* `unfull(p)` is for "this pane went away": closing it, its shell ending, or a remote desktop failing all call it, and it only acts if that pane is the full-screen one.
* `onLeftFullScreen` is the page's end of `win:left-fullscreen` (see [§6](#creating-the-window)). If your window manager takes the window out of full screen, the page drops its pinned pane too instead of leaving it covering a normal window.

### The draggable gutter

```js
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
    g.onpointermove = (m) => {
      const na = Math.max(80, Math.min(total - 80, sa + (horiz ? m.clientX : m.clientY) - start));
      a.style.flexGrow = (grow * na) / total;
      b.style.flexGrow = grow - a.style.flexGrow;
    };
    g.onpointerup = () => { g.onpointermove = null; g.classList.remove('dragging'); };
  };
  return g;
}
```

* **Pointer events** cover mouse, pen and touch with one API. `setPointerCapture` keeps sending `pointermove` to the gutter even when the pointer races over a terminal.
* The two neighbouring panes share their combined `flex-grow`; dragging just changes how it is split between them. `Math.max(80, Math.min(total - 80, …))` **clamps** the size so neither pane can shrink below 80 px.

### Opening a connection

```js
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
    status(p, errText(e), true);
  }
}
```

The pane is shown **first** and filled afterwards, so you see "Connecting to …" with a bobbing banana immediately. Errors from main arrive wrapped as "Error invoking remote method 'session:open': Error: …"; `errText` strips that prefix so you see only the useful part (see [Errors you can see](#errors-you-can-see)).

### Terminal panes (xterm.js)

```js
async function openTerm(p, c) {
  const term = new Terminal({ fontFamily: 'ui-monospace, "DejaVu Sans Mono", monospace', fontSize: 14, cursorBlink: true, theme: termTheme() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const box = el('div', { className: 'term' });
  p.body.append(box);
  term.open(box);
  fit.fit();
  const res = await window.bp.open(c.id, term.cols, term.rows);
  if (p.closed) { window.bp.close(res.id); term.dispose(); return; } // pane closed while connecting
  p.sid = res.id;
  terms.set(p.sid, p);
  term.onData((d) => window.bp.write(p.sid, d));
  term.onResize(({ cols, rows }) => window.bp.resize(p.sid, cols, rows));
  const ro = new ResizeObserver(() => { if (box.offsetWidth) fit.fit(); });
  ro.observe(box);
  p.dispose = () => { ro.disconnect(); window.bp.close(p.sid); terms.delete(p.sid); term.dispose(); };
}

window.bp.onData((id, d) => terms.get(id)?.term.write(d));
```

The loop for a terminal is:

```
 key press ─▶ term.onData ─▶ bp.write ─IPC─▶ main ─▶ ssh stream / pty
                                                      │
 screen    ◀─ term.write ◀─ bp.onData ◀─IPC── main ◀──┘ output
```

* xterm.js only *draws* a terminal and turns key presses into the bytes a terminal would send (for example the Up arrow becomes `\x1b[A`). It has no idea where those bytes go.
* `FitAddon.fit()` measures the box and works out how many columns and rows of characters fit. A **ResizeObserver** calls it whenever the pane changes size (window resize, gutter drag, switching to grid). xterm then fires `onResize`, which tells main, which tells the pty or the SSH server, so programs like `htop` redraw at the new size.
* `termTheme()` reads the CSS variables with `getComputedStyle` so the terminal matches the fruit theme, and is re-applied when the theme changes.
* When a session ends, the pane shows "[session ended — press any key to close]".

### Remote desktop panes (Guacamole)

```js
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
  …
  const mouse = new Guacamole.Mouse(display.getElement());
  mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e) => { client.sendMouseState(e.state, true); });
  const kb = new Guacamole.Keyboard(p.body);
  kb.onkeydown = (k) => { client.sendKeyEvent(1, k); return false; };
  kb.onkeyup = (k) => client.sendKeyEvent(0, k);

  client.connect(`${query}&width=${p.body.clientWidth || 1024}&height=${p.body.clientHeight || 768}&dpi=${dpi}`);
}
```

* `if (p.closed) return;` handles closing a pane while it still says "Connecting" (the first RDP connection may wait minutes while Docker downloads guacd). `closePane` sets `p.closed = true`; without this check the connection would carry on in a pane nobody can see. Terminals do the same and close the session main just opened.
* `const [base, query] = url.split('?')` is **array destructuring**: the first piece goes to `base`, the second to `query`.
* `WebSocketTunnel(base)` is the connection to guacamole-lite; `client.connect(query)` appends the token plus the pane's current size, so the remote desktop starts at exactly the right resolution.
* `display.getElement()` is a `<div>` containing layered `<canvas>` elements that guacd's drawing instructions paint on.
* `Guacamole.Mouse` turns browser mouse events into remote mouse events; the `true` in `sendMouseState(state, true)` corrects for the display's scaling.
* `Guacamole.Keyboard(p.body)` listens **only on that pane**, so with four desktops in a grid your typing goes only to the one you clicked. It sends X11 "keysyms", which handle keyboard layouts and modifier keys properly. `return false` stops the browser acting on the key itself (e.g. Ctrl+W would otherwise not reach Windows).
* A ResizeObserver scales the display to fit the pane straight away, then (after the pane has been still for 300 ms, a **debounce**) calls `client.sendSize(w, h)` to ask the remote desktop for the new resolution.
* `client.onstatechange` and `client.onerror` drive the status overlay: it disappears when connected (state 3) and shows the error message, for example "Connection failed (server unreachable?)", if guacd cannot reach the host.
* Signing out of Windows (or choosing Disconnect in its Start menu) closes the pane by itself. guacd ends every session with an *error* message, even a normal one, and attaches a status code. Code `0` means SUCCESS: guacd uses it when you logged off or disconnected yourself ("Manually logged off."). Anything else (server unreachable, idle timeout, another login took the session, the network dropped) keeps the pane open with the message, so you can see what happened.

```js
const fail = (msg) => { p.failed = true; unfull(p); status(p, msg, true); }; // the one way a remote session ends in error
client.onerror = (e) => {
  if (e.code === 0) return void (p.closed || closePane(p));
  fail(`${c.host}: ${e.message || 'connection error'}`);
};
```

`fail` is shared with the state handler, which calls `fail('Disconnected')` when the connection drops without an error: either way the pane is marked failed, leaves full screen (`unfull`) and shows the message. `p.closed || closePane(p)` runs `closePane` only when the pane is not closed already (`||` stops at the first true value). `return void …` returns nothing, so the rest of the function is skipped.

### Errors you can see

```js
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
addEventListener('unhandledrejection', (e) => toast(errText(e.reason)));
```

Every call to `window.bp` returns a Promise. If main throws (keyring locked, disk full, a folder that is not empty), the Promise **rejects**; if nothing catches that, the browser fires `unhandledrejection`. One listener turns all of those into a toast message at the bottom of the window instead of failing silently. That is why **Delete folder** has no `try` of its own: main's "Only empty folders can be deleted" arrives here as a toast.

`errText` turns an error into the message you should see. Electron wraps every error from an `invoke` handler as "Error invoking remote method 'store:move': Error: …"; the regex removes that prefix. `[^']+` matches the channel name (anything up to the next quote) and `(Error: )?` the optional second prefix. `connect` uses the same function for the pane's status line.

### Clipboard: `clipboard.js` and terminal shortcuts

Copy and paste works between this computer and remote desktops, as text. The page is sandboxed, so it cannot touch the system clipboard itself; main does it with Electron's `clipboard` module:

```js
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text) => { if (typeof text === 'string') clipboard.writeText(text); });
```

`renderer/clipboard.js` connects one Guacamole client to that:

```js
export const clean = (text) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

export function shareClipboard(client, target, bp) {
  let last = null; // last text seen on either side, so it is never echoed back
  let received = 0; // bumped on every remote copy, so a slow push can tell it is out of date
  let connected = false;

  client.onclipboard = (stream, mimetype) => {
    if (!mimetype.startsWith('text/')) return stream.sendAck('Unsupported clipboard type', 0x0100);
    const reader = new Guacamole.StringReader(stream);
    let text = '';
    reader.ontext = (t) => (text += t);
    reader.onend = () => {
      // Only the pane you are working in may change your clipboard; empty means nothing was copied.
      if (!text || document.activeElement !== target || !document.hasFocus()) return;
      received++;
      last = clean(text);
      bp.clipboardWrite(last);
    };
  };

  const push = async () => {
    if (!connected) return;
    const before = received;
    const text = await bp.clipboardRead();
    if (!text || text === last || received !== before) return;
    last = text;
    const writer = new Guacamole.StringWriter(client.createClipboardStream('text/plain'));
    writer.sendText(text);
    writer.sendEnd();
  };
  target.addEventListener('focus', push);

  return { onConnected: () => { connected = true; push(); } };
}
```

* **`clean`** removes control characters except tab and newlines. A hostile remote host could otherwise put an escape sequence on your clipboard, such as `ESC[201~`, which ends a terminal's *bracketed paste* early: anything after it would run as typed commands when you paste into a local shell. `[\x00-\x08…]` is a regex character class of ranges written as hexadecimal character codes.
* **Remote → local.** When you copy on the remote desktop, guacd sends a `clipboard` instruction that opens a **stream**, then the text in one or more `blob` chunks, then `end`. `Guacamole.StringReader` reassembles the chunks (and decodes UTF-8, so `pässwörd ✓` arrives intact); `onend` writes the result to your clipboard, but only if that pane is the one you are using (`document.activeElement === target`, with the window focused) and the text is not empty. A pane in the background, or in another tab, can never replace what you just copied. Anything that is not text (an image, for example) is refused with an **ack** carrying an error code, which tells guacd to stop sending that stream.
* **Local → remote.** There is no event for "the system clipboard changed", so the pane pushes your clipboard to the remote side whenever it **gains focus**: when you click into it, and also when you come back to the window from another app (the focused element receives `focus` again). Paste on the remote desktop then pastes what you copied locally. `createClipboardStream` opens the outgoing stream and `StringWriter` sends the text.
* `received` guards a small race. Reading the clipboard is an IPC round trip; if a remote copy lands while `push` is waiting for it, the text `push` read is already out of date, so it gives up instead of overwriting the remote side with it. The counter changing across the `await` is how it notices.
* `last` stops ping-pong: text that just arrived from the remote side is not sent straight back to it, and focusing the same pane twice does not resend the same text.
* `connected` holds pushes until the session is up; Guacamole drops data sent before then. `app.js` calls `onConnected()` from its state handler:

```js
  const clip = shareClipboard(client, p.body, window.bp);
  client.onstatechange = (s) => {
    if (s === 3) { status(p, null); clip.onConnected(); } // CONNECTED
```

Each remote pane has its own `shareClipboard`, so with two desktops in a split, text goes to the one you click into.

Terminals get the usual Linux shortcuts, because plain Ctrl+C must stay "interrupt" in a shell:

```js
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) { window.bp.clipboardWrite(term.getSelection()); return false; }
    if (k === 'v') { e.preventDefault(); window.bp.clipboardRead().then((t) => t && term.paste(clean(t))); return false; }
    return true;
  });
```

`attachCustomKeyEventHandler` lets the app see each key before xterm.js does; returning `false` means "handled, don't send this key to the shell". `term.paste` (rather than writing the text directly) uses *bracketed paste* when the shell supports it, so a pasted multi-line command is not run line by line by accident; `clean` makes sure the text cannot switch that protection off.

### Bulk edit dialog

```js
async function bulkPreview() {
  const by = bform.elements.by.value;
  const value = bform.elements.value.value.trim();
  bulkFilter = value || by === 'username' ? { [by]: value } : null;
  const rows = bulkFilter ? await window.bp.bulkPreview(bulkFilter) : [];
  $('#bulk-matches').replaceChildren(...rows.map((r) => el('label', {},
    el('input', { type: 'checkbox', checked: true, value: r.id }),
    el('span', { textContent: r.name }), …)));
}
```

* `by` is `'username'` or `'folder'`, from the dropdown.
* `{ [by]: value }` is a **computed property name**: the key is whatever string `by` holds, so this builds `{ username: 'admin' }` or `{ folder: 'Prod' }`.
* An empty folder value would mean "every connection", so it is treated as "nothing selected" instead. (An empty *username* is allowed: it finds connections that have no username yet.)
* The preview re-runs on every keystroke (`oninput`), so you watch the list change as you type.

Applying:

```js
$('#bulk-apply').onclick = async (e) => {
  e.preventDefault();
  const ids = [...document.querySelectorAll('#bulk-matches input:checked')].map((i) => i.value);
  if (!bulkFilter || !ids.length) return err('Nothing selected.');
  if (f.password.value !== f.password2.value) return err('Passwords do not match.');
  …
  const what = patch.clearPassword ? 'Remove the saved password of' : 'Update';
  if (!confirm(`${what} ${ids.length} connection${ids.length > 1 ? 's' : ''}? A backup of the old file is kept.`)) return;
  const res = await window.bp.bulkApply({ ...bulkFilter, ids }, patch);
  $('#bulk-dlg').close();
  refresh(res);
  toast(`Updated ${res.result} connection${res.result === 1 ? '' : 's'} 🍌`);
};
```

Like every store change, `bulkApply` answers with the new view plus `result`, here the number of connections changed, so the same object goes to `refresh` and its count to the toast.

The filter **and** the ticked `ids` both go to main, and `store.select` requires both to match. Unticking a row really does protect that connection, and a connection added between preview and apply cannot sneak in.

---

## 11. Following one click all the way through

You hold **Shift** and double-click `dc01` (RDP, `admin` / `CORP`) while an SSH session is already open:

1. `connRow`'s `ondblclick` calls `connect('8c1e…', true)`.
2. `connect` creates a pane, sees `split` is true and the current tab has room, adds the pane to it and calls `render()`. The tab is now a side-by-side split; the new pane shows "Connecting to 10.0.0.5…".
3. `openRemote` calls `window.bp.open(id)` → preload → `ipcRenderer.invoke('session:open', id)`.
4. In main, `session:open` finds the connection, sees `rdp`, decrypts the password with `safeStorage`, and calls `guacd.openRemote(conn, password)`.
5. `ensureGuacd` starts the `guacamole/guacd` container if needed and waits for port 4822. `ensureBridge` starts guacamole-lite on a random port.
6. `encryptToken` packs `{ hostname, username: 'admin', domain: 'CORP', password, … }` into an encrypted token. Main returns `ws://127.0.0.1:<port>/?token=…` to the page.
7. The page opens a websocket to guacamole-lite with the token and the pane's width/height.
8. guacamole-lite decrypts the token, connects to guacd, and tells it "RDP to 10.0.0.5 as CORP\admin, at this size".
9. guacd logs in to Windows (NLA with your domain credentials), then streams screen updates back: guacd → guacamole-lite → websocket → `Guacamole.Client` → canvases in the pane.
10. You click into the pane and type. `Guacamole.Keyboard` on that pane sends key events back along the same path. The SSH pane next to it is unaffected because its keyboard listener is separate.
11. You drag the gutter. Both panes resize; xterm refits and tells the SSH server its new size; the RDP pane scales immediately and asks Windows for the new resolution 300 ms later.

---

## 12. Security choices

| Risk | What banana-phone does |
| --- | --- |
| Passwords readable on disk | Encrypted with the OS keyring via `safeStorage`; file mode `600`. A sidebar warning appears if no keyring is available. |
| Page compromised by injected HTML | No user data is ever written with `innerHTML`; a strict Content-Security-Policy blocks outside scripts and connections. |
| Page doing more than it should | `contextIsolation` + `sandbox`; only the functions in `preload.js` exist. The page asks for sessions by **id**, never by host + password. |
| Passwords visible to the page | Never sent. Remote desktop credentials go into an AES token encrypted with a per-launch key. |
| SSH man-in-the-middle | Trust-on-first-use host key fingerprints; a changed key is only accepted after you confirm it in a warning dialog that defaults to Cancel. |
| RDP server impersonation | The certificate fingerprint is saved on first use and pinned in guacd (`cert-fingerprints`); a changed certificate is only accepted after you confirm it, and the newly trusted one is pinned instead. guacd is told to use exactly the TLS or NLA security seen during the check, so an impostor cannot fall back to legacy RDP; servers offering only legacy RDP security are refused. |
| Other machines using your guacd | guacd and the websocket bridge listen on `127.0.0.1` only. |
| Shell injection | `docker` is called with `execFile` and an argument array, never a shell string. |
| Clipboard leaking to remote hosts | Only text, and only to the remote pane you click into; the page can read the clipboard through `clipboard:read`, but the CSP leaves it nowhere to send it except localhost. |
| A bad bulk edit | Preview with checkboxes, a confirmation, and `connections.json.bak` before every bulk edit or delete. |
| Half-written file after a crash | Write to `.tmp`, then atomic rename. |

Known trade-offs: the first connection to a server is trusted without proof (the nature of trust on first use: check the fingerprint shown in the toast if it matters); VNC connections cannot be verified at all; and anyone who can run Docker commands as your user can also inspect the guacd container.

---

## 13. Tests and CI

```bash
npm test
```

```bash
npm run check:walkthrough
```

```bash
npm run test:ui
```

`store.test.js` uses Node's built-in `node:test` and `node:assert`:

```js
test('bulk update by folder includes subfolders but not lookalike names', () => {
  const d = sample();
  assert.strictEqual(store.bulkUpdate(d, { folder: 'Prod' }, { username: 'svc', domain: 'NEW' }), 2);
  assert.deepStrictEqual(d.connections.map((c) => c.username), ['svc', 'svc', 'pi', 'admin']);
});
```

* `test(name, fn)` registers a test; it fails if `fn` throws.
* `assert.strictEqual(a, b)` checks `a === b`; `assert.deepStrictEqual` compares arrays and objects by their contents.
* `sample()` returns a fresh data set each time, so tests cannot affect each other.

### The end-to-end UI test

`npm test` checks the logic, but not the window: tabs, splits, the drag gutter and the dialogs. `scripts/ui.e2e.js` checks those by starting the real app with a throwaway profile and driving it the way you would, with real mouse clicks, drags and key presses. Its file name deliberately does not end in `.test.js`, so plain `npm test` (which finds every `*.test.js`) does not pick it up: it needs Electron and a screen.

It talks to the app through the **Chrome DevTools Protocol** (CDP), the same channel Chrome's developer tools use. Electron is told to open it on a free port:

```js
  const args = ['.', '--remote-debugging-port=0', `--user-data-dir=${profile}`];
```

```js
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
```

* `--remote-debugging-port=0` means "any free port". Chromium then prints `DevTools listening on ws://127.0.0.1:<port>/…` on stderr, and the regex captures the digits after the colon. `(\d+)` is a **capture group**: `m[1]` is the text it matched.
* `--user-data-dir` points at a new empty folder, so the test never touches your real connections, and a running copy of the app does not block it (the single-instance lock is per profile).

Every CDP message is JSON with an `id`. The reply carries the same `id`, which is how `call()` matches a reply to its request:

```js
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++n;
```

The test then uses three kinds of call:

* `Runtime.evaluate` runs JavaScript in the page and returns the result (`app.eval`).
* `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` send input as if it came from the real mouse and keyboard. A drag is a press, five moves and a release, so the gutter's `setPointerCapture` and `pointermove` code runs exactly as it does for you:

```js
      for (let i = 1; i <= 5; i++) await app.mouse('mouseMoved', { x: from.x + (dx * i) / 5, y: from.y + (dy * i) / 5 });
```

Page updates are not instant, so instead of sleeping for a guessed time the test waits for a condition, checking every 100 ms. On timeout it reports what the page actually looked like:

```js
      for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await app.eval(expr)) return;
```

`t.test(name, fn)` inside a test makes **subtests**, so the report shows each step (split, grid, gutter, Tab all, dialogs) as its own pass or fail, while all of them share one running app.

The dialog step caught a real bug. The edit dialog used to save from its `close` event, with a new listener added each time it opened. Chromium can deliver a `close` event late. Under the test's fast input, the Esc that cancelled one opening only "arrived" together with the next opening's Save. Both listeners then read `returnValue` as `ok`, and the connection was saved twice. In the opposite order (Save, then reopen at once), a Save could be lost. The dialogs now save on `submit` instead (see [§9](#9-rendererindexhtml-and-fruitcss-the-look)), and the test covers both orders: Esc then Save, and Save then an immediate reopen.

The connection to DevTools uses the `WebSocket` class that Node has built in since version 22, the same API as in a browser, so the test needs no extra package. A reply is matched to its request through a `Map` from id to that request's `resolve`/`reject` functions:

```js
    const p = pending.get(d.id);
```

If the app crashes, `ws.onclose` rejects every request still waiting, so the test fails at once with a clear message instead of hanging. `cleanup()` kills the app, **waits for it to exit**, and only then deletes the throwaway profile. Electron still writes to it while shutting down, so deleting first would leave files behind.

### Keeping this document honest

`scripts/check-walkthrough.js` fails if this walkthrough has fallen behind the code. It checks three things:

1. Every `.js`, `.mjs`, `.html` and `.css` file (and `package.json`) is named somewhere in this document, so a new file cannot be added without being explained.
2. Every IPC channel used in `preload.js` appears in it, so the channel table in [§7](#7-preloadjs-the-bridge) stays complete.
3. Every line of every ` ```js `, ` ```css `, ` ```html ` and ` ```json ` block in this document still exists in the source (ignoring indentation). Change a line of code that is quoted here and the check fails until the quote is updated. Lines containing `…` are treated as "code left out". Blocks written to illustrate an idea rather than quote the code are marked with an extra word after the language (` ```js example `) and skipped.

```js
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const corpus = sources.map((f) => fs.readFileSync(path.join(root, f), 'utf8').split('\n').map(norm).join('\n')).join('\n');
```

`norm` collapses every run of whitespace to one space, so re-indenting code does not break the check. The whole source tree becomes one big string, `corpus`, and each quoted line must be found inside it with `corpus.includes(line)`.

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

```yaml
      - run: npm ci --ignore-scripts
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'
      - run: npm test
      - name: Walkthrough matches the code
        run: node scripts/check-walkthrough.js
```

`npm ci` installs exactly what `package-lock.json` lists. `--ignore-scripts` and `ELECTRON_SKIP_BINARY_DOWNLOAD` skip compiling `node-pty` and downloading Electron, which neither the tests nor the check need, so this job takes seconds.

A second job, `ui`, runs the end-to-end test. It needs the real thing, so it runs a full `npm ci` (downloading Electron and building `node-pty` for it). CI machines have no screen, so it runs under a virtual one:

```yaml
      - run: xvfb-run -a npm run test:ui
```

**Xvfb** ("X virtual framebuffer") is an X display server that draws into memory instead of a monitor. `xvfb-run -a` starts one on a free display number, runs the command inside it, and stops it afterwards. GitHub sets `CI=true`, and the test then adds `--no-sandbox`, because Chromium's sandbox needs privileges a CI runner does not give it.

### Secrets and personal data

Nothing private should ever reach GitHub: no passwords, API keys or private keys, and no personal details such as email addresses or home-directory paths that reveal a username. **gitleaks** scans for these, in two places:

1. `.githooks/pre-push` runs before `git push` sends anything, and blocks the push if it finds something. This is the layer that actually keeps a secret off GitHub.
2. `.github/workflows/scan.yml` runs the same scan on GitHub for every push and pull request, as a backstop for clones where the hook is not turned on.

Git does not run hooks from the repository by default (a cloned repository must not be able to run code on your machine on its own), so each clone turns it on once:

```bash
git config core.hooksPath .githooks
```

Both scan the **whole history**, not only the newest files: a password committed and then deleted in the next commit is still in the repository, and anyone with a clone can read it. The workflow therefore checks out everything:

```yaml
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # whole history: something removed in a later commit is still in the repository
      - name: Scan for secrets and personal data
        run: docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.28.0 git /repo --config /repo/.gitleaks.toml --redact --verbose
```

`fetch-depth: 0` means "all commits" (the default fetches only the newest). gitleaks runs from its official Docker image at a fixed version, so the hook and CI behave the same. `--redact` hides the found values in the output, so the log does not leak them a second time.

The hook runs the same image, with one difference. In a second working copy made with `git worktree add`, the commit history is not inside the folder. It stays in the main checkout's `.git` folder, and the worktree only has a small `.git` file pointing there by absolute path. Docker sees only the folders it is given, so the hook mounts both at their real paths:

```sh
common=$(cd "$(git rev-parse --git-common-dir)" && pwd)
  docker run --rm -v "$repo:$repo" -v "$common:$common" "$image" git "$repo" --config "$repo/.gitleaks.toml" --redact --verbose
```

`git rev-parse --git-common-dir` prints that shared `.git` folder, and `cd … && pwd` turns it into an absolute path. Without the second mount, git inside the container could not find any history, so gitleaks scanned nothing and reported "no leaks".

`.gitleaks.toml` starts from gitleaks' built-in rules (hundreds of patterns for API keys, tokens, private keys and the like) and adds two for personal data:

```toml
[extend]
useDefault = true # gitleaks' built-in rules: API keys, tokens, private keys, passwords in URLs, ...

[[rules]]
id = "email-address"
description = "Email address (personal data)"
regex = '''[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'''
keywords = ["@"]

[[rules.allowlists]]
description = "Placeholder and bot addresses"
regexes = ['''@(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid|localhost))$''', '''^noreply@anthropic\.com$''', '''^git@github\.com$''']

[[rules]]
id = "home-directory-path"
description = "Home directory path (reveals a local username)"
# The username is reported as the finding: gitleaks' defaults ignore findings that look like whole paths.
regex = '''(?:/home|/Users)/([a-z_][a-z0-9._-]*)/'''
secretGroup = 1
keywords = ["/home/", "/users/"]
```

* TOML is a simple settings format. `[[rules]]` (double brackets) starts one more entry in a list of rules; `[[rules.allowlists]]` attaches an exception list to the rule just above it. `'''…'''` is a "literal" string in which backslashes are not special, convenient for regular expressions.
* `keywords` is a fast pre-filter: gitleaks only runs the (slower) regular expression on text containing one of them.
* The email allowlist lets through addresses that cannot belong to a person: the reserved `example.com` / `.test` / `.invalid` domains, the commit co-author bot address, and GitHub's SSH user. `package-lock.json` is skipped by gitleaks itself; it quotes package maintainers' public contacts.
* `secretGroup = 1` makes the **username** (the part in parentheses) the finding rather than the whole path. gitleaks' built-in exceptions ignore anything that looks like a full Unix path, which would otherwise have silenced this rule entirely; a second allowlist (not shown) skips generic names such as `runner`, the account GitHub's CI machines use.

The rules were tested by committing throwaway fakes (a random AWS-style key, a random GitHub-style token, a freshly generated private key, an email address and a `/home/<name>/` path) to a scratch copy: each was reported and the push was blocked, while the allowed addresses and paths passed. For a genuine false positive, `git push --no-verify` skips the hook, and the pattern belongs in an allowlist.

Covered: multi-word search, that an empty password removes the saved one while a missing one keeps it, that Duplicate's `copyPasswordFrom` copies the encrypted password unless a new one is given, bulk update by username, by folder (including subfolders but not `Production` when asking for `Prod`), respecting unticked ids, backup and round-trip of the file, and (in `guacd.test.js`) that a token with a non-ASCII password decrypts correctly with guacamole-lite's own code, that `rdpFingerprint` returns the right fingerprint from a fake RDP server using a throwaway certificate made with `openssl`, and that it refuses a server offering only legacy RDP security, and that it fails quickly when the server hangs up or is not an RDP server at all.

`guacd.test.js` also checks `remoteSettings`: the RDP settings pin the certificate, and ask for the admin session only when it is ticked.

---

## 14. Building and running the AppImage

```bash
npm install
```

```bash
npm test
```

```bash
npm start
```

```bash
npm run dist
```

```bash
./dist/banana-phone-0.1.0.AppImage
```

An **AppImage** is a single executable file containing the app and everything it needs. It mounts itself with **FUSE** when run. Debian 13 only ships FUSE 3 by default; AppImages need the FUSE 2 library:

```bash
sudo apt install libfuse2t64
```

Without it, you can still run it by having it unpack to a temporary folder first:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./dist/banana-phone-0.1.0.AppImage
```

Requirements on the machine running it:

* **Docker** (and your user in the `docker` group) for RDP and VNC. The first RDP connection pulls `guacamole/guacd:1.6.0` (about 100 MB). SSH and local terminals work without Docker.
* A keyring (GNOME Keyring or KWallet) for proper password encryption.

Data lives in `~/.config/banana-phone/`: `connections.json`, `connections.json.bak`, `known_hosts.json`.

---

### Releases

A release is a GitHub Release page with the AppImage and `requirements.txt` attached, built by GitHub Actions rather than on anyone's machine. To make one, set `version` in `package.json`, merge to `main`, and push a tag for that version:

```bash
git tag v0.1.3 && git push origin v0.1.3
```

`.github/workflows/release.yml` runs for any tag starting with `v`, in two jobs. The first builds the AppImage:

```yaml
  build:
    runs-on: ubuntu-latest
    # Build on Debian 12 (glibc 2.36). Native modules (node-pty) only load on systems with a glibc at least
    # as new as the one they were compiled against, and GitHub's ubuntu-latest is newer than many desktops.
    container: node:24-bookworm
    steps:
      - uses: actions/checkout@v4
      - name: Tag matches package.json version
        run: |
          version=$(node -p "require('./package.json').version")
          [ "$GITHUB_REF_NAME" = "v$version" ] || { echo "Tag $GITHUB_REF_NAME does not match package.json version $version"; exit 1; }
      - run: npm ci # also rebuilds node-pty for Electron (postinstall)
      - run: npm test
      - run: node scripts/check-walkthrough.js
      - run: npm run dist
      - uses: actions/upload-artifact@v4
        with:
          name: appimage
          path: dist/banana-phone-*.AppImage
```

* **Why a container.** Compiled code on Linux records the newest version of the C library (**glibc**) it was built against, and refuses to load on a system with an older one. The first release was built directly on GitHub's newest Ubuntu image, so `node-pty` demanded glibc 2.42 and the app crashed at start on Debian 13 (glibc 2.41). `container: node:24-bookworm` runs every step inside the official Node.js image for Debian 12 (glibc 2.36), so the result needs only glibc 2.34 and runs on Debian 12+, Ubuntu 22.04+ and similar. That minimum is listed in `requirements.txt`. You can check what a native module needs with `objdump -T pty.node | grep GLIBC`.
* `$GITHUB_REF_NAME` is the tag that triggered the run, e.g. `v0.1.3`. `node -p` prints the result of a JavaScript expression, here the version from `package.json`. `[ a = b ] || { …; exit 1; }` fails the job when they differ, so a release can never be labelled with the wrong version.
* Unlike the CI workflow, this one runs `npm ci` **with** install scripts, because it needs the real native modules for the AppImage. The tests and the walkthrough check run again, so nothing that fails them is ever published.
* `upload-artifact` hands the built file to the next job; jobs run on separate machines and share nothing otherwise.

The second job publishes it:

```yaml
  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write # create the release and upload its files
    steps:
      - uses: actions/checkout@v4 # for requirements.txt
      - uses: actions/download-artifact@v4
        with:
          name: appimage
          path: dist
      - name: Publish release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" dist/banana-phone-*.AppImage requirements.txt --title "banana-phone $GITHUB_REF_NAME" --generate-notes
```

* `needs: build` makes it wait for, and depend on, the build job.
* `permissions: contents: write` lets the job's built-in token create releases; by default it can only read. Only this job gets that permission; the job that runs `npm ci` and third-party install scripts never holds a token that can write to the repository.
* `gh release create` makes the release and uploads the files. `--generate-notes` writes the release notes from the merged pull requests since the previous tag.

## 15. JavaScript syntax cheat sheet

Everything below appears somewhere in this codebase.

| Syntax | Meaning | Example from the code |
| --- | --- | --- |
| `const` / `let` | a variable that cannot / can be reassigned | `const sessions = new Map();` |
| `(a, b) => expr` | arrow function returning `expr` | `const $ = (s) => document.querySelector(s);` |
| `` `text ${x}` `` | template literal | `` `Connecting to ${c.host}…` `` |
| `{ a, b } = obj` | object destructuring | `const { Client } = require('ssh2');` |
| `{ a, ...rest } = obj` | take `a`, put the remaining properties in `rest` | `({ password, ...c }) => …` |
| `[x, y] = arr` | array destructuring | `const [base, query] = url.split('?');` |
| `...arr` in a call/array | spread values out | `n.append(...kids)` |
| `...args` in parameters | collect remaining arguments | `(tag, props = {}, ...kids) =>` |
| `{ ...a, ...b }` | merge objects, later wins | `{ ...data.connections[i], ...conn }` |
| `x = default` in parameters | default value | `async function connect(connId, split = false)` |
| `a?.b` / `a?.()` | only if `a` is not null/undefined | `stream?.write(d)` |
| `a \|\| b` | `a` if truthy, else `b` | `conn.port \|\| 22` |
| `a \|\|= b` | assign `b` only if `a` is falsy | `starting \|\|= (async () => …)()` |
| `cond ? a : b` | ternary | `split ? current : newTab()` |
| `!!x` | convert to boolean | `hasPassword: !!password` |
| `{ [key]: v }` | computed property name | `{ [by]: value }` |
| `async` / `await` | write Promise-based code top to bottom | `const res = await window.bp.open(...)` |
| `new Promise((resolve, reject) => …)` | turn callback code into a Promise | `docker()` in `guacd.js` |
| `x.then(fn)` | run `fn` when Promise `x` resolves | `app.whenReady().then(() => …)` |
| `try { } catch (e) { }` | handle errors | `store.load` |
| `/regex/` | regular expression | `q.split(/\s+/)` |
| `arr.map / filter / find / every` | transform / keep / first match / all match | `view.connections.filter(...)` |
| `new Map()` / `new Set()` | key→value store / unique values | `sessions`, `openFolders` |
| `require()` / `module.exports` | CommonJS modules (Node side) | `store.js` |
| `import` / `export` | ES modules (page side) | top of `app.js` |
| `0o600` | octal number | file permission mode |
| `\x1b[31m` | escape character + ANSI code | red error text in terminals |
