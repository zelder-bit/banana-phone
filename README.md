# banana-phone 🍌📞

A small, fruity connection manager for Linux: SSH and local terminals, plus RDP (including Active Directory logins) and VNC desktops, in tabs or split views of up to four sessions. Connections live in a collapsible folder tree, are searchable with Ctrl+K, and their credentials can be bulk-edited by username or by folder.

```bash
npm install
npm start          # run from source
npm run dist       # build dist/banana-phone-<version>.AppImage
```

RDP and VNC need Docker (the app runs `guacamole/guacd` on 127.0.0.1). The AppImage needs `libfuse2t64`, or run it with `APPIMAGE_EXTRACT_AND_RUN=1`.

How it all works, file by file: [WALKTHROUGH.md](WALKTHROUGH.md).
