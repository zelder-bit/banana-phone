# Shared folders: what has been checked, and what to check on Windows

RDP shared folders ([README](../README.md#features), [walkthrough §8](../WALKTHROUGH.md#shared-folders-a-guacd-of-its-own)) rest on three things that only a real run can prove: Docker starting guacd the way `guacd.js` asks, guacd's drive redirection, and how the RDP server treats the drive. This page says which of those have been run, how to run them again, and what is still unseen.

## Checked automatically, on every pull request

`npm run test:share` (`scripts/share.itest.js`, the `share` job in CI) runs the app's own connection code against the real `guacamole/guacd:1.6.0` image (pinned by digest in `guacd.js`) and an **xrdp** server standing in for Windows, then looks at the drive from inside the RDP session:

| Check | Read-only share | Writable share |
| --- | --- | --- |
| The remote side reads files in the folder | yes | yes |
| Create, append, delete, rename from the remote side | all refused, folder unchanged | work |
| Files the remote side creates | | belong to the local user, mode 600 |
| A link in the folder to a file outside it | cannot be opened | cannot be opened |
| A link in the folder to `/etc/hostname` | shows the container's, not this computer's | |
| The remote side making a symlink | | refused |
| A "Download" folder appearing in the shared folder | no | no |
| A drive mounted inside the folder (as a USB stick is under `/run/media`) | can be read, cannot be changed | |
| The container: one mount, your user, no capabilities, no published port | yes | |
| The container's own files | read-only; only its `/tmp` can be written | |
| guacd reachable on the container's address | no | |
| The container's network and memory | this launch's own network, not `bridge`; a limit of 1 GiB | |
| Another account reaching the socket | no | |
| Using a session's token a second time | refused | |
| The folder swapped for a link to another folder before mounting | nothing is shared, the container is removed | |
| Closing the last session stops its container; the next session starts it again | | yes |
| Quitting stops the containers and removes their network | yes | |

To run it yourself you need Docker, an xrdp server on port 3389 with an account other than yours, and passwordless `sudo`; the top of `scripts/share.itest.js` has the details and the CI job is a working recipe. The job runs on Ubuntu 24.04 deliberately: its xrdp (0.9.24) shows a redirected drive as a folder in the session, which is how the test looks at it. With Ubuntu 26.04's xrdp (0.10.1) guacd connects and the drive is announced, but that folder never appeared, so the test had nothing to look at; that is a limit of the test fixture, not a finding about the feature.

The same checks were first run on a hand-built rig (Ubuntu 24.04, Docker 29, xrdp 0.9.24, and guacd 1.3 in a stand-in image with the official image's entrypoint). Two things were learned there and are now in the code: guacd needs a writable `HOME` when it does not run as the image's own user (without `-e HOME=/tmp` the connection fails with "Security negotiation failed"), and with guacd's own file transfer left on, a `Download` folder appears in a writable share.

A separate security review of the whole feature found, among smaller things, that a token for one share could be used on another share's bridge, that another account able to write above the shared folder could redirect the mount, and that an old agreement could come back after a change was undone. All three are fixed and tested; walkthrough §8 and §12 describe the result.

A second review, of the pull requests themselves, added these:

- **Read-only at every level.** Docker mounts a folder together with whatever is mounted inside it, and before Engine 25 (or Linux 5.12) left those inner mounts writable in a read-only share. Read-only is now asked for all the way down, and a read-only share is refused on an older Engine. Checked against a real Docker: a file could be written to a drive mounted inside a "read-only" share the old way, and not the new way.
- **A home folder under another name.** The folder rules compared paths only. A home folder mounted in a second place is now recognised by which folder it is on disk, and a folder that holds `.ssh`, `.gnupg` or the like is refused as a copy of one (a snapshot, a backup).
- **The question says more.** It names the server with its port when that is not 3389, says when the server's certificate was first seen on this very connect and shows it, says when a writable share holds a git repository or programs, and writes out invisible and direction-changing characters in the folder's path.
- **Agreements are signed.** They were a plain hash of things written in the app's own files; they are now signed with a key kept behind the system keyring.
- **The container is tighter**: its own files read-only, `/tmp` in memory, a limit on processes. Since issue #68 also a network of its own, where containers cannot reach each other or the ordinary guacd, and a memory limit of 1 GiB (measured against xrdp: 189 MB for one session at 7680×2160; not yet measured against Windows). It also runs in the groups you are in, so a folder you reach through a group is not empty on the remote side.

A third pass found that guacd answers a request for a folder's listing even with its file transfer off, so the page (the app's own window) could learn the names of the files in a shared folder. The bridge now drops the two instructions that ask guacd's filesystem for anything (`get` and `put`) before they reach guacd (issue #61). Checked by hand against the real `guacamole/guacd:1.6.0` image with a read-only share: asked for the folder's listing, guacd sent the file names when the filter was taken out, and nothing with it in. That run got no further than the server's login, so a signed-in session through the filter is covered only by `npm test`, where a stand-in guacd receives keys, mouse and clipboard unchanged; the Windows checklist below exercises it for real.

`npm run test:ui` covers the edit dialog (the box is there for RDP only, the home folder is refused, read-only unless ticked, the page cannot write an agreement, and a path the page sends without your choosing it in the folder dialog gets one refusal whether the folder exists or not), and `npm test` covers the folder rules, the agreement, the `docker run` arguments, the relay and the bridge's filter.

## Not checked yet: do this once against Windows

xrdp is not Windows. Before relying on the feature, connect to a real Windows host with a share and tick these off. About ten minutes.

1. Edit an RDP connection, choose a folder with a few files in it (**Choose…**; the path cannot be typed), leave the checkbox unticked, and connect. The system dialog asks whether to share: **Share and connect**.
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
5. With a session open, in a terminal: `docker ps` shows `banana-phone-guacd-<uid>-<pid>-…` with nothing under PORTS. Quit banana-phone: it is gone.
6. If you use them: an NLA server, an admin session (`mstsc /admin`), and signing out of Windows with a file from the drive open.

## Known limits

- An ordinary folder that holds secrets is not recognised: only the home folder itself, hidden folders, `~/snap`, system folders and the app's own folder are refused.
- A share's container runs while a session uses it and for about ten seconds after the last one closes (and for the minute a session's token is good, if the page never connects).
- Shared team folders work, but think about who else can write there: what a share shows is whatever is in the folder at the time. Files the remote side creates are readable by you alone (mode 600, and 700 for folders), so teammates will not see them until you change that: `chmod -R g+rX <folder>` after a session. Nothing set on the folder beforehand helps, because guacd asks for exactly that mode when it creates a file (`open(…, S_IRUSR | S_IWUSR)` and `mkdir(…, S_IRWXU)` in its `fs.c`, still so in 1.6.0). A setgid folder gives the new file the team's group but no rights for it, and default ACLs (`setfacl -d`) are inherited but switched off, since the mode asked for becomes the new file's ACL mask (`getfacl` shows `group::rwx #effective:---`). Both were tried on ext4. The app does not loosen the files itself: it would be changing permissions on names the remote side chose, in a folder others can write to. The real fix belongs upstream, in guacamole-server: guacd leaving the mode to the umask.
- A read-only share needs Docker Engine 25 or newer and Linux 5.12 or newer. On anything older it does not start, and the message says why.
- A drive plugged in, or anything else mounted inside the shared folder, *while* a session is open does not show up in it: the container keeps the mounts it started with. Close every session of that connection, wait about ten seconds (up to a minute more if a pane of it was started and never connected), and connect again.
- Windows is not told when a file changes on this computer. Press F5 in Explorer to see it.
- Writing to a read-only share fails on the remote side with an unhelpful message (guacd reports it as an invalid parameter), not with "access denied".
- Many organisations set their Windows servers to refuse redirected drives (the CIS and DISA baselines both say to). The session then opens without the drive, and nothing on this side can tell, so the toast shown on connecting (and the tooltip of the pane's *shared folder* label) always adds: "If no drive appears there, the server may be set to refuse shared drives."

## Refused, with the reason

A share does not start on these, and the message names which one it is. banana-phone tells them apart from what `docker info` and `docker version` report (`shareBlocker` in `guacd.js`). Which of them to support properly is still to be decided.

- **Rootless Docker** (`name=rootless` among the security options) and **Podman** (its own `docker` command, or the real one talking to Podman's socket). The container runs with `--user <your uid>`, which those map to a different user on the host, so the folder would be unreadable or files would arrive with the wrong owner.
- **Docker that enforces SELinux** (`name=selinux`; Fedora, RHEL). The folder is mounted without relabelling it, so the container is denied. Relabelling a folder you also use elsewhere is not something to do silently. Docker lists SELinux whenever it was started with it, so a system set to permissive is refused too.
- **Docker Desktop for Linux.** Containers run in a virtual machine and files cross through a file-sharing layer, so the folder the container sees cannot be matched with the one that was checked.

Only the recognising is tested, against sample answers; the plain-Docker sample is real, the others follow each program's documented output. None of the four has been run: not the refusal on a real one, and not what happened there before it.

## Not checked, and not expected to work without changes

- **A guacd that is not in Docker** (issue #6). guacd follows symlinks and the container is what stops them leading out of the folder; a system guacd has no such wall. Shared folders should stay Docker-only unless that is solved another way.
