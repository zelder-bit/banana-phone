# banana-phone 🍌📞

![A pixel-art banana sitting at a desk, typing at a terminal](renderer/banana-typing.gif)

A small, fruity connection manager for Linux: SSH and local terminals, plus RDP (including Active Directory logins) and VNC desktops, in tabs or split views of up to four sessions. Connections live in a collapsible folder tree, are searchable with Ctrl+K, and their credentials can be bulk-edited by username or by folder.

![banana-phone with four sessions in a 2×2 grid: two SSH servers and two local terminals, next to a folder tree with fruit icons. The juice cup in the top bar is full.](docs/screenshots/main.webp)

## Features

- **Tabs and splits.** Open sessions in tabs, side by side, stacked, or in a 2×2 grid. Drag the gutter between panes to resize them, drag a pane onto another tab, and pop any session out into its own tab.
- **Full screen current.** Ctrl+Alt+F makes the active session fill the whole screen. A faint banana at the top brings back Minimize and Back to tab.
- **Folders.** Group connections in nested folders in a collapsible sidebar (Ctrl+B hides it). Right-click a folder to open everything in it as a split, add a subfolder, or bulk edit it.
- **Drag to reorganize.** Drag connections and folders to reorder them or nest one folder in another; the order is saved. Move up / Move down in the right-click menu do the same from the keyboard.
- **Folder fruit icons.** Right-click a folder → Change icon… and pick a fruit, or the crate to go back to the default. Folders without one show a crate.
- **Quick search.** Ctrl+K finds connections by name, host, user, folder or tag. Enter opens a result, Shift+Enter opens it in a split.
- **Bulk credential edit.** Change the username, domain or password of every connection with a given username, or in a folder, after previewing exactly which ones will change. A backup is kept.
- **SSH, RDP, VNC and local terminals.** RDP supports Active Directory logins (domain, user, password) and admin sessions, and its pane closes when you sign out of Windows.
- **Identity checks.** SSH host keys and RDP certificates are remembered on first connect. If one changes, you're shown both fingerprints and asked whether to trust it, with Cancel as the default.
- **Clipboard sharing** with RDP and VNC desktops.
- **Saved passwords encrypted** with your system keyring, and never shown to the window.
- **Juice cup status.** The cup in the top bar is empty <img src="renderer/juice-empty.png" alt="an empty glass" width="24"> when nothing is open, and full and glowing <img src="renderer/juice-full.png" alt="a full glass of orange juice" width="24"> as soon as a connection tab is open.
- **Light and dark themes.**

| Quick search (Ctrl+K) | Bulk edit by username or folder |
|---|---|
| ![Quick search showing four connections matching "prod"](docs/screenshots/search.webp) | ![Bulk edit dialog matching three connections with the username admin](docs/screenshots/bulk.webp) |
| **Editing an RDP connection** | **Dark theme** |
| ![Edit dialog for an RDP connection with host, username, Active Directory domain and the admin session option](docs/screenshots/edit.webp) | ![The main window in the dark theme](docs/screenshots/dark.webp) |
| **Folder right-click menu** | **Picking a folder's fruit icon** |
| ![Right-click menu of a folder: new connection, new subfolder, open all in split, change icon, bulk edit, move up, delete](docs/screenshots/menu.webp) | ![Folder icon dialog with eleven fruit to choose from](docs/screenshots/icons.webp) |

Screenshots use made-up hosts and names.

```bash
npm install
npm start          # run from source
npm run dist       # build dist/banana-phone-<version>.AppImage
```

## Running the AppImage on another machine

Download `banana-phone-<version>.AppImage` from the [latest release](https://github.com/zelder-bit/banana-phone/releases/latest), or build it with `npm run dist`. Only that file is needed, but the machine needs FUSE 2, Docker for RDP/VNC, and a keyring for saved passwords: see [requirements.txt](requirements.txt) for the full list.

## Releasing

Bump `version` in `package.json`, merge to `main`, then tag that commit:

```bash
git tag v0.2.1 && git push origin v0.2.1
```

The Release workflow runs the tests and the walkthrough check, builds the AppImage, and publishes a GitHub release with the AppImage and `requirements.txt` attached. The tag must match the version in `package.json`.

## Before your first push

Turn on the pre-push scan for secrets and personal data (once per clone):

```bash
git config core.hooksPath .githooks
```

GitHub runs the same scan on every push and pull request.

How it all works, file by file: [WALKTHROUGH.md](WALKTHROUGH.md).
