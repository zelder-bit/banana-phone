# banana-phone 🍌📞

A small, fruity connection manager for Linux: SSH and local terminals, plus RDP (including Active Directory logins) and VNC desktops, in tabs or split views of up to four sessions. Connections live in a collapsible folder tree, are searchable with Ctrl+K, and their credentials can be bulk-edited by username or by folder.

```bash
npm install
npm start          # run from source
npm run dist       # build dist/banana-phone-<version>.AppImage
```

## Running the AppImage on another machine

Only the AppImage file is needed: Electron, Node and the terminal libraries are inside it. The machine still needs:

| Need | For | Notes |
| --- | --- | --- |
| 64-bit x86 Linux | everything | built for x64 only, not ARM |
| `chmod +x banana-phone-*.AppImage` | everything | |
| FUSE 2 | everything | `libfuse2t64` (Debian 13, Ubuntu 24.04+) or `libfuse2` (older). Without it: `APPIMAGE_EXTRACT_AND_RUN=1 ./banana-phone-*.AppImage` |
| Docker, with your user in the `docker` group | RDP and VNC | the first RDP/VNC connection downloads `guacamole/guacd` (about 100 MB, needs internet); SSH and local terminals work without Docker |
| A system keyring (GNOME Keyring or KWallet) | saved passwords | without one, passwords are only obfuscated and the app shows a warning |

Connections are stored per machine in `~/.config/banana-phone/connections.json`. You can copy that file to another machine, but saved passwords will not decrypt there because they are locked to the original machine's keyring; re-enter them (bulk edit by username or folder makes that quick).

On Ubuntu 23.10 and newer, AppArmor may stop Electron AppImages from starting with a "SUID sandbox helper" error; starting it with `--no-sandbox` works around it. Only Debian 13 has been tested so far.

How it all works, file by file: [WALKTHROUGH.md](WALKTHROUGH.md).
