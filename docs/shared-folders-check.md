# Shared folders: what has been checked, and what to check on Windows

RDP shared folders ([README](../README.md#features), [walkthrough §8](../WALKTHROUGH.md#shared-folders-a-guacd-of-its-own)) rest on three things that only a real run can prove: Docker starting guacd the way `guacd.js` asks, guacd's drive redirection, and how the RDP server treats the drive. This page says which of those have been run, how to run them again, and what is still unseen.

## Checked automatically, on every pull request

`npm run test:share` (`scripts/share.itest.js`, the `share` job in CI) runs the app's own connection code against the real `guacamole/guacd:1.6.0` image and an **xrdp** server standing in for Windows, then looks at the drive from inside the RDP session:

| Check | Read-only share | Writable share |
| --- | --- | --- |
| The remote side reads files in the folder | yes | yes |
| Create, append, delete, rename from the remote side | all refused, folder unchanged | work |
| Files the remote side creates | | belong to the local user, mode 600 |
| A link in the folder to a file outside it | cannot be opened | cannot be opened |
| A link in the folder to `/etc/hostname` | shows the container's, not this computer's | |
| The remote side making a symlink | | refused |
| A "Download" folder appearing in the shared folder | no | no |
| The container: one mount, your user, no capabilities, no published port | yes | |
| guacd reachable on the container's address | no | |
| Another account reaching the socket | no | |
| Quitting stops the containers | yes | |

To run it yourself you need Docker, an xrdp server on port 3389 with an account other than yours, and passwordless `sudo`; the top of `scripts/share.itest.js` has the details and the CI job is a working recipe.

The same checks passed before CI existed on a hand-built rig (Ubuntu 24.04, Docker 29, xrdp 0.9.24, and guacd 1.3 in a stand-in image with the official image's entrypoint). Two things were learned there and are now in the code: guacd needs a writable `HOME` when it does not run as the image's own user (without `-e HOME=/tmp` the connection fails with "Security negotiation failed"), and with guacd's own file transfer left on, a `Download` folder appears in a writable share.

`npm run test:ui` covers the edit dialog (the box is there for RDP only, the home folder is refused, read-only unless ticked, the page cannot write an agreement), and `npm test` covers the folder rules, the agreement, the `docker run` arguments and the relay.

## Not checked yet: do this once against Windows

xrdp is not Windows. Before relying on the feature, connect to a real Windows host with a share and tick these off. About ten minutes.

1. Edit an RDP connection, choose a folder with a few files in it, leave the checkbox unticked, and connect. The system dialog asks whether to share: **Share and connect**.
2. In Explorer, *This PC* shows **Shared on banana-phone**, and `\\tsclient\Shared` opens it.
   - [ ] the drive is there, and opening it does not drop the session (there is an old report of guacd failing on Explorer's `desktop.ini` lookup)
   - [ ] files open; non-ASCII names and names with spaces look right
3. Still read-only: try to save a file into the drive, rename one, delete one.
   - [ ] all three fail, and nothing changes in the folder on this computer
   - [ ] note the message Windows shows (guacd reports a read-only folder as "invalid parameter", so it may be an odd one)
4. Disconnect, tick *Let the remote computer change and delete files in it*, connect. The dialog asks again, now saying *read, change and delete*.
   - [ ] saving, renaming and deleting work in both directions, and a file made on this computer shows up in Explorer after a refresh
   - [ ] no `Download` folder appears in the folder
   - [ ] a file of a gigabyte or so copies both ways
5. With a session open, in a terminal: `docker ps` shows `banana-phone-guacd-<uid>-…` with nothing under PORTS. Quit banana-phone: it is gone.
6. If you use them: an NLA server, an admin session (`mstsc /admin`), and signing out of Windows with a file from the drive open.

## Not checked, and not expected to work without changes

- **Rootless Docker and Podman.** The container runs with `--user <your uid>`, which those map to a different user on the host, so the folder is likely to appear empty or refuse writes.
- **SELinux-enforcing Docker (Fedora, RHEL).** The folder is mounted without relabelling it, so the container may be denied. Relabelling a folder you also use elsewhere is not something to do silently.
- **A guacd that is not in Docker** (issue #6). guacd follows symlinks and the container is what stops them leading out of the folder; a system guacd has no such wall. Shared folders should stay Docker-only unless that is solved another way.
