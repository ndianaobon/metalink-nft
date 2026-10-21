const test = require('node:test');
const assert = require('node:assert/strict');
const { readDeviceToken, readPlatform, hashDeviceToken } = require('../device');

const req = headers => ({ headers });

test('device token: accepts the client format and rejects junk', () => {
  assert.equal(readDeviceToken(req({ 'x-device-id': '0123456789abcdef0123456789abcdef' })), '0123456789abcdef0123456789abcdef');
  assert.equal(readDeviceToken(req({})), null);
  assert.equal(readDeviceToken(req({ 'x-device-id': 'short' })), null);
  assert.equal(readDeviceToken(req({ 'x-device-id': "x'; DROP TABLE app.users; --1234" })), null);
  assert.equal(readDeviceToken(req({ 'x-device-id': 'a'.repeat(65) })), null);
});

test('device hash: same token gives the same hash, the raw token is never exposed', () => {
  const token = '0123456789abcdef0123456789abcdef';
  const h1 = hashDeviceToken(token, 'secret-1');
  assert.equal(h1, hashDeviceToken(token, 'secret-1'));
  assert.notEqual(h1, hashDeviceToken('fedcba9876543210fedcba9876543210', 'secret-1'));
  assert.notEqual(h1, hashDeviceToken(token, 'secret-2'), 'hashes are keyed, so they are useless without the server secret');
  assert.ok(!h1.includes(token));
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(hashDeviceToken(null, 'secret-1'), null);
});

test('platform: only known values are stored', () => {
  assert.equal(readPlatform(req({ 'x-device-platform': 'Android' })), 'android');
  assert.equal(readPlatform(req({ 'x-device-platform': 'ios' })), 'ios');
  assert.equal(readPlatform(req({ 'x-device-platform': '<script>' })), 'web');
  assert.equal(readPlatform(req({ 'user-agent': 'Mozilla/5.0 (Linux; Android 10) MetaLinkApp/1.1' })), 'android');
  assert.equal(readPlatform(req({ 'user-agent': 'Mozilla/5.0 (iPhone) MetaLinkApp/1.1' })), 'ios');
  assert.equal(readPlatform(req({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' })), 'web');
});
