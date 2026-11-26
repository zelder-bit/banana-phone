# What banana-phone tests, and what it does not

This page lists every automated test and check in the repository, in plain words, so you can see the gaps.
Counts are from `npm test` on 2026-11-25 (42 passed, with `share.test.js`) and from reading `scripts/ui.e2e.js`, as of the Send Ctrl+Alt+Del change.

| Suite | File | Tests |
|---|---|---|
| Store | `store.test.js` | 19 |
| Remote desktop | `guacd.test.js` | 13 |
| UI end-to-end | `scripts/ui.e2e.js` | 1 test with 17 steps |

## How to run

| Command | What it runs | Needs | Run by CI? |
|---|---|---|---|
| `npm test` | `node --test`: `store.test.js` and `guacd.test.js` (42 tests). It does not pick up `scripts/ui.e2e.js`. | Node only, plus `openssl` on the PATH (the fake RDP server makes a certificate with it). No display, no Electron, no Docker. | Yes: CI `test` job, and the Release `build` job before the AppImage is built. |
| `npm run test:electron` | `guacd.test.js` again, inside Electron's own Node (`ELECTRON_RUN_AS_NODE=1`). This matters because Electron's TLS library is stricter than Node's. | The Electron binary, and `openssl`. No display. | Yes: CI `ui` job. |
| `npm run test:ui` | `scripts/ui.e2e.js`: starts the real app with a throwaway profile and drives it. | Electron, node-pty built for Electron (`npm ci` without `--ignore-scripts`), and a display (CI uses `xvfb-run -a`). No Docker. | Yes: CI `ui` job, with a 10 minute limit. Not run by the Release job. |
| `npm run check:walkthrough` (or `node scripts/check-walkthrough.js`) | Checks that `WALKTHROUGH.md` still matches the code. | Node only. | Yes: CI `test` job and Release `build` job. |
| Secret scan (gitleaks) | Scans the whole git history with `.gitleaks.toml`. | Docker (or a local `gitleaks`). | Yes: `scan.yml`, on every push to any branch and every pull request. Also the optional pre-push hook. |

CI (`ci.yml`) runs on pushes to `main` and on pull requests. The Release workflow (`release.yml`) runs on `v*` tags and also checks that the tag matches the version in `package.json`.

## Store suite (`store.test.js`, 19 tests)

These test `store.js` directly on plain data and temporary files. No Electron, no keyring: passwords here are stand-in strings such as `'ENC'`.

| Test | What it proves |
|---|---|
| search matches every word across fields | Quick search finds a connection only when every word you type appears somewhere in it (name, host, user, folder and so on), and an empty search shows everything. |
| an empty password removes the saved one, undefined keeps it | Saving a connection without touching the password keeps the saved one; clearing it really removes it, for one connection and in a bulk edit. |
| copyPasswordFrom copies the encrypted password unless a new one is given | Duplicate carries the saved password over to the copy, unless you type a new one or clear it, and never changes an existing connection. |
| bulk update by username changes only that username | Bulk edit by username changes exactly the connections with that username and no others. |
| bulk update by folder includes subfolders but not lookalike names | Bulk edit of folder "Prod" also changes "Prod/Windows" but not a different folder called "Production". |
| bulk update respects ticked ids | Bulk edit changes only the rows you left ticked in the preview. |
| save writes a backup and load round-trips | Saving and loading gives back the same data, a save with backup keeps the old file as `.bak`, and a missing file loads as an empty store. |
| folder icons: unknown name rejected, follow a folder move, removed with the folder | Only real fruit names and the default crate are accepted as folder icons (no file paths), icons follow a moved folder, and deleting a folder deletes its icons. |
| setFolderIcon refuses a folder that does not exist | You cannot set an icon on a folder that is not there. |
| removeFolder refuses a folder with connections in it or below, then removes its subfolders | A folder with connections in it, or in a subfolder, cannot be deleted; an empty one is deleted with its subfolders, and a lookalike name stays. |
| addFolder and upsert list every parent folder | Making "a/b/c", or saving a connection into "x/y", makes every parent folder appear in the sidebar too. |
| a brand-new store keeps insertion order across save and load | In a new store, folders and connections stay in the order you made them after a restart. |
| a file saved before folder icons existed still loads | An older connections file without folder icons still opens. |
| moveConn reorders within and across folders | Moving a connection puts it in the chosen folder in front of the chosen row, or last at the top level. |
| moveFolder takes children along, reorders and un-nests | Moving a folder takes its subfolders and connections with it, a lookalike folder stays put, and a folder can go back to the top level in a chosen place. |
| moveFolder refuses itself, its children and duplicate paths | A folder cannot be moved into itself or its own subfolder, or onto a name that already exists, and a refused move changes nothing. |
| an old file loads alphabetical and keeps a saved order afterwards | A file from before drag-to-reorder opens in the old alphabetical order, and after one move the order you chose is kept. |
| a folder moved by drag keeps its icon, and so do its subfolders | Moving a folder keeps the icons of the folder and its subfolders. |
| upsert keeps only well-formed saved commands | Saved commands from the page are cleaned up: entries without a name and a command are dropped, "Run on start" is only on when it is really `true`, a value that is not a list becomes no commands, and leaving the field out keeps the saved ones. |

## Remote desktop suite (`guacd.test.js`, 13 tests)

These test the pieces of `guacd.js` that do not need Docker. The RDP tests use a small fake RDP server on localhost with a throwaway certificate made by `openssl`. No real RDP or VNC server, and no guacd, is involved.

| Test | What it proves |
|---|---|
| token survives guacamole-lite decryption, non-ASCII password included | The connection details handed to the remote-desktop bridge can be read back intact, including a password with characters like "ä" or "€". |
| rdpFingerprint returns the certificate fingerprint after the RDP-to-TLS switch | The app reads an RDP server's certificate fingerprint correctly and notices that the server chose NLA. |
| rdpFingerprint reads a Windows-style certificate (key encipherment only) | The fingerprint can be read from the kind of self-signed certificate Windows uses (this is why the file also runs inside Electron). |
| rdpFingerprint fails fast when the server hangs up or is not RDP | Pointing an RDP connection at a server that hangs up, or at an SSH port, gives a clear error instead of hanging. |
| rdpFingerprint refuses servers that only offer legacy RDP security | A server that offers only old RDP security (no certificate to check) is refused with a clear message. |
| RDP settings: pinned certificate, and the admin (console) session only when asked | guacd is told to accept only the pinned certificate and the security the server chose, uses port 3389 by default, and joins the admin (console) session only when you ticked it, never for VNC. |
| the bridge drops the page's requests for files, however they are cut up, and passes the rest | The page cannot ask guacd for the files in a shared folder or their names: those requests are removed between the page and guacd, also when split across messages, while keys, mouse and clipboard pass unchanged. Checked through the real bridge with a stand-in guacd. |
| resolveHost looks names up with the system resolver (including /etc/hosts) | Host names are looked up the way the rest of the system does (so `/etc/hosts` entries work for RDP and VNC), and an unknown name gives a clear error. |

## UI end-to-end suite (`scripts/ui.e2e.js`, 1 test, 17 steps)

One test, "tabs, splits, gutter and dialogs", starts the real app with an empty throwaway profile and drives it through the Chrome DevTools Protocol with mouse and keyboard events. The 17 steps run in order and share one app, so a failing step can make later ones fail too.

All steps use local terminals only. No SSH, RDP or VNC session is opened. The SSH connections the test saves have no host and are never connected to; the saved-commands and tab steps use saved *local terminal* connections.

| Step | What it proves |
|---|---|
| terminal opens in its own tab | Clicking Terminal opens one tab with a terminal in it. |
| Shift+Terminal splits, the third pane switches to a 2x2 grid | Shift+clicking Terminal adds sessions to the same tab, and with four sessions the tab switches to a 2x2 grid. |
| a fifth session gets a new tab (4 per tab) | A tab holds at most four sessions: a fifth opens a new tab, and the tab's close button closes that tab. |
| side-by-side gutter drag widens the first pane | In side-by-side layout, dragging the divider with the mouse widens the first pane by about the distance dragged. |
| stacked gutter drag makes the first pane taller | In stacked layout, dragging the divider makes the first pane taller by about the distance dragged. |
| Tab all, then Split all | "Tab all" gives each session its own tab, and "Split all" gathers them back into one tab. |
| Full screen current fills the window, Back to tab restores the split | The Full screen button pins the selected pane over the whole window and shows the banana; hovering the banana and clicking "Back to tab" puts the four-pane split back with all terminals still there. |
| full screen repeats the header's shared-folder label under the banana | A pane whose header carries the "shared folder" label shows the same words and tooltip next to the buttons under the banana in full screen, and a pane without the label shows none. The label is placed on a terminal's header by the test, since no RDP server is available. |
| the pane button pops a session into its own tab | The "Own tab" button on a pane header moves that session into a new tab. |
| edit dialog: Esc cancels, Enter saves, Esc after a save still cancels | In the New connection dialog, Esc saves nothing, Enter saves, a quick save then reopen neither loses nor repeats the save, and Esc after that still saves nothing. |
| folder prompt: Esc cancels, Enter creates the folder | In the New folder prompt, Esc creates nothing, and Enter creates the folder and shows it in the sidebar. |
| dragging a connection onto a folder moves it and the order is saved | Dropping a connection on a folder moves it there and the move is saved. |
| folders: set an icon, drag a folder into another with its contents, only empty folders delete | "Change icon…" in a folder's right-click menu sets its fruit; dropping a folder on another moves it there with its connection and its icon; deleting a folder that still holds a connection is refused with a message. The crate tile is shown as the current icon of a folder that has none. |
| tabs are grouped by folder with a chip; mixing folders in one tab makes it Mixed | A local-terminal connection saved in a folder opens as the first tab with that folder's chip; plain terminals get a "No folder" chip; splitting a terminal into the folder's tab moves it to the "Mixed" group at the end. |
| tab groups follow the sidebar order, even for a subfolder made later | A subfolder created after another top-level folder still has its tabs placed where the sidebar draws it (inside its parent), not at the end. |
| tab right-click: rename, duplicate, reconnect, close others | From a tab's right-click menu: Rename changes its title, Duplicate opens the same two sessions with the same name, Close other tabs leaves only it, Reconnect gives fresh terminals under the same name, and after one session's saved connection is deleted, Reconnect keeps that session running and says so. |
| saved commands: edited in the dialog, run on start, run again from the pane menu | The Saved commands box is shown for a local terminal and hidden for RDP; a command typed in it is saved; marked "Run on start" it runs when the connection opens (the terminal shows its output); the pane header's "Run:" runs it again; and the sidebar's "Run:" with no session open opens one and runs it there. |
| the sidebar grip widens the list, collapse still hides it, and the width survives a reload | Dragging the sidebar's edge widens it by the distance dragged, Ctrl+B-style collapse still slides it fully out at the new width, and after a reload the width is the same. This step reloads the window, so it must stay last. |

The two drag steps do not use a real mouse drag. Real mouse drags sent through DevTools do not start HTML drag-and-drop, so the test fires synthetic `dragstart`, `dragover` and `drop` events on the row and the folder. It proves the drop handling works, not that a real mouse drag starts one. (The two gutter steps do use real mouse events.)

The full screen step checks that the pane covers the page. It does not check that the real window went full screen at the window-manager level.

## Checks that are not tests

### Walkthrough check (`scripts/check-walkthrough.js`)

Fails when `WALKTHROUGH.md` has drifted from the code. Its three rules:

1. Every source file (`.js`, `.mjs`, `.html`, `.css` and `package.json`, outside `node_modules`, `dist`, `.git`, `.claude`, `fonts` and `svg`) must be named in `WALKTHROUGH.md`.
2. Every IPC channel used in `preload.js` must be named in `WALKTHROUGH.md`.
3. Every line of every `js`, `css`, `html` or `json` code block in `WALKTHROUGH.md` must still exist somewhere in the source. A block marked with an extra word (for example `js example`) is skipped, and lines with an elision ("…" or "...") are skipped.

It says nothing about whether the code works.

### Secret scan (gitleaks)

- CI (`scan.yml`): on every push to any branch and every pull request, gitleaks v8.28.0 in Docker scans the whole history with `.gitleaks.toml` and fails if it finds secrets or personal data.
- Pre-push hook (`.githooks/pre-push`): the same scan before each push. It is off until you run `git config core.hooksPath .githooks` once per clone. It uses a local `gitleaks` or Docker; if it finds neither it prints a warning and lets the push through. `git push --no-verify` skips it.

## Not tested

"Logic tested, UI not" means a unit test covers the underlying store or helper code, but nothing checks the screen or the wiring to it. "Not tested at all" means no automated test touches it.

### SSH

- Connecting to an SSH server at all: not tested at all.
- Password login: not tested at all.
- Key file login, including `~` in the path, the passphrase, and the error for an unreadable key: not tested at all.
- SSH agent login: not tested at all.
- Keyboard-interactive login, and that a key passphrase is never sent to the server as an answer: not tested at all.
- Host key trust on first use (the "New host key saved" line): not tested at all.
- The "host key changed" dialog, with Cancel as the default and Trust saving the new key: not tested at all.
- An unreadable `known_hosts.json` refusing to connect instead of trusting everything anew: not tested at all.
- "Forget saved key" in the connection menu, for SSH and RDP: not tested at all.
- Saved commands on SSH: "Run on start", and a command picked from the sidebar with no session open, are typed by main once the shell is ready; keys typed before that are dropped: not tested at all (only local terminals are tested).

### RDP and VNC

- The RDP certificate trust on first use and the "certificate changed" dialog: logic tested, UI not (the fingerprint probe and the pinned settings are tested; the trust store and dialog are not).
- Any real RDP or VNC session through guacd and Docker: not tested at all.
- Starting guacd, reusing a running container of the right image, replacing one of the wrong image, restarting after the container dies, and stopping it on quit only if this launch started it: not tested at all.
- The "Docker is not installed" message: tested together with the installed guacd (`guacd.test.js`, "without Docker…"), with a stand-in `guacd` program.
- A real guacd installed on the computer (version 1.6.0 or newer) carrying a session: not tested at all; only the stand-in has been run.
- The remote screen scaling to the pane and asking the server for the pane size: not tested at all.
- A remote session ending: "Disconnected", an error, or a normal sign-out closing the pane: not tested at all.
- Keyboard input reaching only the focused remote pane: not tested at all.
- The fallback to RSA key exchange for a Windows certificate that Electron rejects at first: logic tested only as far as the "Windows-style certificate" test reaches; the retry and its error message are not tested on their own.

### Clipboard

- Text clipboard sharing with remote desktops, both directions, and that it is not echoed back: not tested at all.
- Paste sanitising (`clean` in `renderer/clipboard.js`, which strips control characters from pasted text): not tested at all, not even as a unit test.
- Ctrl+Shift+C and Ctrl+Shift+V in a terminal: not tested at all.

### Passwords and the keyring

- Encrypting passwords with the system keyring when saving, and decrypting them when connecting: not tested at all (the store tests use stand-in strings).
- The "system keyring is locked or unavailable" error: not tested at all.
- The renderer never receiving passwords, only whether one is stored: not tested at all.
- The edit dialog's "clear password" box and the "(unchanged)" / "(copied)" hints: logic tested, UI not.

### Connections and folders in the sidebar

- Bulk edit dialog: preview, unticking rows, applying, and the timestamped backup it writes: logic tested, UI not.
- Quick search dialog (Ctrl+K), arrow keys, Enter to connect, Shift+Enter to split: logic tested, UI not (only the matching rule is tested).
- Folder icon picker ("Change icon…"): tested in the UI for one folder and one fruit. Keyboard use of the picker: not tested at all.
- Move up / Move down menu items for connections and folders: logic tested, UI not.
- Reordering by drag (drop on the top edge of a folder or on a row), and dropping on the empty part of the list to go back to the top level, in the real app: logic tested, UI not. "Connection onto a folder" and "folder into a folder" are tested in the UI, with synthetic events.
- Open or closed folder state following a moved folder, and being remembered across restarts: not tested at all.
- Delete connection (with its confirm box and the `.bak` it writes): logic tested, UI not.
- Delete folder: the refusal and its message for a non-empty folder are tested in the UI. Deleting an empty folder: logic tested, UI not.
- Duplicate: logic tested, UI not.
- New subfolder, New connection here, Open all in split (and the "first 4 of N" toast): not tested at all.
- Editing an existing connection, switching protocol (port placeholder, RDP-only fields), tags, and the admin session box: not tested at all.
- Connecting by double-click, Enter on a row, or "Connect in new tab" / "Connect in split" from the menu: not tested at all.
- A corrupt `connections.json` showing an error and refusing to start instead of starting empty: not tested at all (only a missing file is tested).

### Tabs, panes and terminals

- That a local terminal actually runs a shell: tested only through saved commands (their output appears). Typing into it by keyboard: not tested at all.
- A session ending ("session ended — press any key to close") and the pane closing on a key: not tested at all.
- Dragging a pane header onto a tab, or onto the empty tab bar: not tested at all.
- Switching tabs by clicking, Ctrl+Tab and Ctrl+Shift+Tab, and middle-click to close a tab: not tested at all.
- The tab menu's layout rows, "Split all into this tab", "Give each session its own tab" and "Close tabs to the right": not tested at all (the toolbar buttons that do the same are).
- Ctrl+Shift+T for a new terminal and Ctrl+Alt+Arrow to move between panes: not tested at all.
- The pane Close button, and closing a pane while it is still connecting: not tested at all.
- The shell environment cleanup when running from the AppImage (AppImage variables and paths removed): not tested at all.
- Reloading the window ending its shells: not tested at all.

### Full screen

- The Ctrl+Alt+F shortcut, both to enter and to leave: not tested at all.
- The Minimize button on the banana: not tested at all.
- Leaving full screen when the session ends or the pane closes: not tested at all.
- Leaving full screen when the window manager takes the window out of full screen: not tested at all.
- Leaving full screen when you switch to another tab: not tested at all.
- A remote-desktop pane in full screen: not tested at all. This includes its Ctrl+Alt+Del button; the test only checks that a terminal does not get one. The shared-folder label under the banana is tested only with a label the test puts on a terminal's header, not with a real shared session, and not for a pane that goes full screen while still connecting.
- Send Ctrl+Alt+Del in a remote desktop's pane menu, the keys it sends, and that Windows shows its security screen: not tested at all (the pane-menu step only checks that a terminal's menu does not offer it).
- That the real window goes full screen (not just the pane covering the page): not tested at all.

### Look and window

- Theme toggle, and that it is remembered: not tested at all.
- Sidebar collapse by the button is tested together with resizing; Ctrl+B, and that collapse is remembered: not tested at all.
- Sidebar resize by keyboard (← →), double-click to reset, and narrowing when the window gets smaller: not tested at all.
- Error toasts for failed calls to the main process: one is tested in the UI (deleting a non-empty folder). The others: not tested at all.

### App and packaging

- Single-instance lock: a second launch focusing the first window instead of opening another: not tested at all.
- Quitting on SIGTERM or SIGINT and closing sessions on quit: not tested at all.
- The packaged AppImage: it is built by the Release job but never started or tested. In particular, nothing checks that `store.js` loading `renderer/shared.mjs` (an ES module, through `require`) works from inside the package.
- That native `node-pty` loads on the oldest Linux the AppImage targets: not tested at all.
