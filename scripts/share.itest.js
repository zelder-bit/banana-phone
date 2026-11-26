// Integration test for shared folders: the real Docker, the real guacd image, and a real RDP server.
// Not part of `npm test`, because it needs a machine set up for it:
//   - Docker, usable by you
//   - an xrdp server on this machine's port 3389 (standing in for Windows; drive redirection is on by default)
//   - BP_RDP_USER and BP_RDP_PASSWORD: an account xrdp can log in as, other than yours
//   - sudo without a password, to look at the drive the way that account sees it
// The "share" job in .github/workflows/ci.yml sets all of that up. Run with `npm run test:share`.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const guacd = require('../guacd');
const { pin } = require('../share');

const USER = process.env.BP_RDP_USER;
const PASSWORD = process.env.BP_RDP_PASSWORD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ok: did it succeed; out: everything it printed (guacd, for one, logs to stderr).
const sh = (file, args) => { const r = spawnSync(file, args, { encoding: 'utf8', timeout: 20000 }); return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }; };
const docker = (...args) => sh('docker', args);
// A command as the account logged in over RDP: what a program on the remote computer could do.
const remote = (cmd) => sh('sudo', ['-n', '-u', USER, 'sh', '-c', cmd]);
// xrdp shows a redirected drive in the session's home under its 8-letter device name, which guacd sets to GUACFS.
// It is looked at through the session's own view of the disk (/proc/<its pid>/root): some systems give
// every login its own mount table, and then the drive cannot be seen from outside the session.
let DRIVE = '';
const findDrive = () => {
  const pid = remote('pgrep -u "$(id -u)" -f xrdp-chansrv | head -n 1').out;
  DRIVE = `/proc/${/^\d+$/.test(pid) ? pid : 'self'}/root/home/${USER}/thinclient_drives/GUACFS`;
  return remote(`ls ${DRIVE}`).ok;
};

async function until(what, check, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await check()) return;
  throw new Error(`timed out waiting for ${what}`);
}

// Does the bridge accept a websocket for this URL? (It refuses before guacd hears of it.)
const accepted = (url) => new Promise((resolve) => {
  const ws = new WebSocket(`${url}&width=1024&height=768&dpi=96`, 'guacamole');
  ws.onopen = () => { ws.close(); resolve(true); };
  ws.onerror = () => resolve(false);
});

// One RDP session through the app's own code, with `share` as its drive. `inside(url)` runs while the drive is up.
async function session(host, share, inside) {
  const cert = await guacd.rdpFingerprint(host, 3389);
  const url = await guacd.openRemote({ id: share.id, protocol: 'rdp', host, username: USER }, PASSWORD, cert, share);
  // What the page does: a websocket to the bridge, answering guacd's sync messages so it keeps sending.
  const ws = new WebSocket(`${url}&width=1024&height=768&dpi=96`, 'guacamole');
  let failed = null;
  ws.onmessage = (e) => {
    const data = String(e.data);
    for (const m of data.matchAll(/(?:^|;)4\.sync,(\d+\.\d+)[,;]/g)) ws.send(`4.sync,${m[1]};`);
    const err = /(?:^|;)5\.error,\d+\.([^;]*)/.exec(data);
    if (err) failed = err[1];
  };
  ws.onclose = () => { failed ||= 'the connection closed'; };
  // The page's Guacamole client says "still here" every five seconds; guacd drops a client that is silent for fifteen.
  const alive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('3.nop;'); }, 5000);
  try {
    await until('the shared drive to appear in the RDP session', () => { if (failed) throw new Error(`RDP session failed: ${failed}`); return findDrive(); });
    failed = null;
    await inside(url);
    assert.strictEqual(failed, null, 'the session stayed up');
  } catch (e) {
    // A failure here is rarely explained by the assertion alone: add what guacd logged.
    e.message += `\n--- guacd, in ${guacd.shareName(share)}:\n${docker('logs', '--tail', '40', guacd.shareName(share)).out}`
      + `\n--- the RDP session's drives:\n${remote(`ls -la ~/thinclient_drives ${path.dirname(DRIVE)}; grep -i fuse /proc/mounts`).out}`;
    throw e;
  } finally {
    clearInterval(alive);
    ws.onclose = null;
    ws.close();
    await until('the drive to go away after disconnecting', () => !remote(`ls ${DRIVE}`).ok, 30000).catch(() => {});
  }
}

test('a shared folder, end to end', { skip: !USER && 'set BP_RDP_USER and BP_RDP_PASSWORD (see the top of this file)', timeout: 300000 }, async (t) => {
  // The address of this machine as a container sees it: where xrdp answers both us and guacd.
  const host = docker('network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}').out;
  assert.match(host, /^\d+\.\d+\.\d+\.\d+$/, 'Docker is running');

  // A folder to share, a file next to it that is not shared, and links from inside pointing out.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-share-it-')));
  const folder = path.join(base, 'shared');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(base, 'not-shared.txt'), 'TOP SECRET');
  fs.writeFileSync(path.join(folder, 'hello.txt'), 'hello from this computer');
  fs.writeFileSync(path.join(folder, 'doomed.txt'), 'delete me');
  fs.symlinkSync(path.join(base, 'not-shared.txt'), path.join(folder, 'link-out'));
  fs.symlinkSync('/etc/hostname', path.join(folder, 'link-hostname'));
  t.after(() => { guacd.stopGuacd(); fs.rmSync(base, { recursive: true, force: true }); });
  const listing = () => fs.readdirSync(folder).sort().join();
  const before = listing();
  // What main.js hands to openRemote: the folder as share.js saw it (path, device, inode), for one connection.
  const shareOf = (id, writable) => ({ ...pin(folder, { home: os.homedir() }), writable, id });

  await t.test('read-only: the remote side reads the folder and can change nothing', async () => {
    const share = shareOf('conn-1', false);
    await session(host, share, async (url) => {
      assert.strictEqual(remote(`cat ${DRIVE}/hello.txt`).out, 'hello from this computer');
      for (const cmd of [`echo x > ${DRIVE}/new.txt`, `mkdir ${DRIVE}/newdir`, `echo more >> ${DRIVE}/hello.txt`, `rm ${DRIVE}/doomed.txt`, `mv ${DRIVE}/hello.txt ${DRIVE}/moved.txt`]) {
        assert.ok(!remote(cmd).ok, `refused: ${cmd}`);
      }
      assert.strictEqual(listing(), before);
      assert.strictEqual(fs.readFileSync(path.join(folder, 'hello.txt'), 'utf8'), 'hello from this computer');

      // Links out of the folder: one to a file beside it, one to a file every Linux system has.
      assert.ok(!remote(`cat ${DRIVE}/link-out`).ok, 'a link to a file outside the folder leads nowhere');
      const viaLink = remote(`cat ${DRIVE}/link-hostname`);
      assert.ok(!viaLink.ok || viaLink.out !== fs.readFileSync('/etc/hostname', 'utf8').trim(), "a link to /etc/hostname shows the container's, never this computer's");

      // The container itself: only that folder, read-only, as us, with no way in from this machine's network.
      const name = guacd.shareName(share);
      const facts = JSON.parse(docker('inspect', '-f', '{{json .}}', name).out);
      assert.deepStrictEqual(facts.Mounts.map((m) => [m.Source, m.Destination, m.RW]), [[folder, '/drive', false]]);
      assert.strictEqual(facts.Config.User, `${process.getuid()}:${process.getgid()}`);
      assert.deepStrictEqual(facts.HostConfig.CapDrop, ['ALL']);
      assert.strictEqual(facts.HostConfig.ReadonlyRootfs, true, 'guacd can write to the folder and its own /tmp, nowhere else');
      // The image declares port 4822 (EXPOSE), which shows up here with nothing bound to it; published would list an address.
      assert.deepStrictEqual(Object.values(facts.NetworkSettings.Ports || {}).filter((bound) => bound && bound.length), []);
      assert.strictEqual(facts.HostConfig.PortBindings && Object.keys(facts.HostConfig.PortBindings).length || 0, 0);
      // On this launch's own network, away from other containers, and with a limit on memory.
      assert.deepStrictEqual(Object.keys(facts.NetworkSettings.Networks), [guacd.shareNet()]);
      assert.strictEqual(docker('network', 'inspect', '-f', '{{index .Options "com.docker.network.bridge.enable_icc"}}', guacd.shareNet()).out, 'false');
      assert.ok(facts.HostConfig.Memory > 0 && facts.HostConfig.MemorySwap === facts.HostConfig.Memory);
      const ip = Object.values(facts.NetworkSettings.Networks)[0].IPAddress;
      const reached = await new Promise((resolve) => {
        const s = net.connect(4822, ip);
        s.setTimeout(3000, () => { s.destroy(); resolve(false); });
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
      });
      assert.ok(!reached, "guacd does not answer on the container's address");
      // The socket that does lead to it is ours alone.
      const sock = await guacd.ensureShare(share);
      assert.ok(!remote(`ls ${path.dirname(sock)}`).ok, 'another account cannot reach the socket');
      // The page keeps the URL it was given. It opened this session and is good for nothing more.
      assert.ok(!(await accepted(url)), 'a token cannot be used twice');
    });
  });

  await t.test('a folder swapped for a link to another one is not shared', async () => {
    // What someone who can write to the folder above could do between the check and the mount.
    const share = shareOf('conn-swap', false);
    const aside = path.join(base, 'aside');
    fs.renameSync(folder, aside);
    fs.symlinkSync(base, folder); // the path now leads to the folder holding not-shared.txt
    try {
      await assert.rejects(guacd.ensureShare(share), /changed while it was being shared/);
      assert.ok(!docker('inspect', guacd.shareName(share)).ok, 'the container that mounted the wrong folder is gone');
    } finally {
      fs.unlinkSync(folder);
      fs.renameSync(aside, folder);
    }
  });

  await t.test('read-only goes all the way down: a drive mounted inside the folder cannot be changed either', async () => {
    // The way a USB stick sits under /run/media/<you>: a mount of its own, inside the folder that is shared.
    // Docker brings such mounts along, and before Engine 25 left them writable in a read-only share.
    const outer = path.join(base, 'with-drive');
    const stick = path.join(outer, 'stick');
    fs.mkdirSync(stick, { recursive: true });
    assert.ok(sh('sudo', ['-n', 'mount', '-t', 'tmpfs', '-o', 'mode=777', 'none', stick]).ok, 'a drive is mounted inside the folder');
    try {
      fs.writeFileSync(path.join(stick, 'on-the-stick.txt'), 'kept');
      const share = { ...pin(outer, { home: os.homedir() }), writable: false, id: 'conn-drive' };
      await guacd.ensureShare(share);
      // Asked of the container itself, as guacd's user: the limit is the kernel's, whatever guacd is told to do.
      const inside = (cmd) => docker('exec', guacd.shareName(share), 'sh', '-c', cmd);
      assert.strictEqual(inside('cat /drive/stick/on-the-stick.txt').out, 'kept');
      for (const cmd of ['echo x > /drive/stick/planted', 'echo x >> /drive/stick/on-the-stick.txt', 'rm /drive/stick/on-the-stick.txt', 'echo x > /drive/planted']) {
        assert.ok(!inside(cmd).ok, `refused: ${cmd}`);
      }
      assert.deepStrictEqual(fs.readdirSync(stick), ['on-the-stick.txt']);
      assert.strictEqual(fs.readFileSync(path.join(stick, 'on-the-stick.txt'), 'utf8'), 'kept');
      // And guacd has nowhere of its own to write but the /tmp that is its home.
      assert.ok(!inside('echo x > /opt/planted').ok, "the container's own files are read-only");
      assert.ok(inside('echo x > /tmp/scratch').ok, 'its /tmp is writable');
    } finally {
      sh('sudo', ['-n', 'umount', stick]);
    }
  });

  await t.test('writable: what the remote side writes is ours, and guacd adds nothing of its own', async () => {
    await session(host, shareOf('conn-1', true), async () => {
      assert.ok(remote(`echo from the remote side > ${DRIVE}/new.txt`).ok);
      assert.ok(remote(`rm ${DRIVE}/doomed.txt`).ok);
      await until('the new file to arrive', () => fs.existsSync(path.join(folder, 'new.txt')), 10000);
      const st = fs.statSync(path.join(folder, 'new.txt'));
      assert.strictEqual(fs.readFileSync(path.join(folder, 'new.txt'), 'utf8').trim(), 'from the remote side');
      assert.deepStrictEqual([st.uid, st.mode & 0o777], [process.getuid(), 0o600]);
      assert.ok(!fs.existsSync(path.join(folder, 'doomed.txt')));
      assert.ok(!remote(`ln -s /etc/shadow ${DRIVE}/evil-link`).ok, 'the remote side cannot make links');
      assert.ok(!remote(`cat ${DRIVE}/link-out`).ok);
      // guacd's own file transfer is off, so its "Download" folder never shows up in ours.
      assert.strictEqual(listing(), 'hello.txt,link-hostname,link-out,new.txt');
    });
  });

  await t.test('quitting stops the containers and removes their network and the socket', () => {
    const names = () => docker('ps', '-a', '--filter', `name=banana-phone-guacd-${process.getuid()}-`, '--format', '{{.Names}}').out;
    assert.notStrictEqual(names(), '');
    guacd.stopGuacd();
    assert.strictEqual(names(), '');
    assert.strictEqual(docker('network', 'ls', '--filter', `name=${guacd.shareNet()}`, '--format', '{{.Name}}').out, '');
  });
});
