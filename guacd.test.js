const test = require('node:test');
const assert = require('node:assert');
const Crypt = require('guacamole-lite/lib/Crypt');
const { encryptToken, key } = require('./guacd');

test('token survives guacamole-lite decryption, non-ASCII password included', () => {
  const token = { connection: { type: 'rdp', settings: { hostname: 'dc01', password: 'pässwörd€', domain: 'CORP' } } };
  assert.deepStrictEqual(new Crypt('AES-256-CBC', key).decrypt(encryptToken(token)), token);
});

// A fake RDP server: answers the X.224 request, then speaks TLS with a throwaway self-signed certificate.
const net = require('net');
const tls = require('tls');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { X509Certificate } = require('crypto');
const { rdpFingerprint } = require('./guacd');

function fakeRdp(selected) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fake-rdp',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const key = fs.readFileSync(path.join(dir, 'k.pem'));
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  const server = net.createServer((s) => s.once('data', () => {
    s.write(Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0, 0, 0, 2, 0, 8, 0, selected, 0, 0, 0]));
    if (selected) new tls.TLSSocket(s, { isServer: true, key, cert }).on('error', () => {});
    else s.end();
  }));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, fp: new X509Certificate(cert).fingerprint256 })));
}

test('rdpFingerprint returns the certificate fingerprint after the RDP-to-TLS switch', async () => {
  const { server, port, fp } = await fakeRdp(2); // 2 = server picked NLA
  try { assert.deepStrictEqual(await rdpFingerprint('127.0.0.1', port), { fingerprint: fp, nla: true }); } finally { server.close(); }
});

test('rdpFingerprint fails fast when the server hangs up or is not RDP', async () => {
  const hangUp = net.createServer((s) => s.once('data', () => s.end()));
  const ssh = net.createServer((s) => s.write('SSH-2.0-OpenSSH_9.6\r\n'));
  await Promise.all([hangUp, ssh].map((srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r))));
  try {
    await assert.rejects(rdpFingerprint('127.0.0.1', hangUp.address().port), /closed the connection/);
    await assert.rejects(rdpFingerprint('127.0.0.1', ssh.address().port), /does not look like an RDP server/);
  } finally { hangUp.close(); ssh.close(); }
});

test('rdpFingerprint refuses servers that only offer legacy RDP security', async () => {
  const { server, port } = await fakeRdp(0);
  try { await assert.rejects(rdpFingerprint('127.0.0.1', port), /legacy RDP security/); } finally { server.close(); }
});
