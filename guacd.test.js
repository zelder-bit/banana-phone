const test = require('node:test');
const assert = require('node:assert');
const Crypt = require('guacamole-lite/lib/Crypt');
const { encryptToken, key } = require('./guacd');

test('token survives guacamole-lite decryption, non-ASCII password included', () => {
  const token = { connection: { type: 'rdp', settings: { hostname: 'dc01', password: 'pässwörd€', domain: 'CORP' } } };
  assert.deepStrictEqual(new Crypt('AES-256-CBC', key).decrypt(encryptToken(token)), token);
});
