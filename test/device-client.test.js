// Runs public/assets/device.js in a sandbox with a fake browser to check what it sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'device.js'), 'utf8');

function browser({ storage = {}, cookie = '', userAgent = 'Mozilla/5.0 (Windows NT 10.0)', capacitor } = {}) {
  const calls = [];
  const window = {
    crypto: { getRandomValues: a => nodeCrypto.randomFillSync(a) },
    fetch: (input, init) => { calls.push({ input, init }); return Promise.resolve({}); }
  };
  if (capacitor) window.Capacitor = { getPlatform: () => capacitor };
  const sandbox = {
    window,
    navigator: { userAgent },
    location: { origin: 'https://metalinknft.com', protocol: 'https:' },
    document: { cookie },
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); }
    },
    Uint8Array
  };
  vm.runInNewContext(SOURCE, sandbox);
  return { window, calls, storage, document: sandbox.document };
}

test('client: creates a random 32-hex token and keeps it', () => {
  const b = browser();
  assert.match(b.window.MLK_DEVICE.id, /^[0-9a-f]{32}$/);
  assert.equal(b.storage.mlk_device_id, b.window.MLK_DEVICE.id);
  assert.match(b.document.cookie, /mlk_did=[0-9a-f]{32}/);

  const again = browser({ storage: b.storage });
  assert.equal(again.window.MLK_DEVICE.id, b.window.MLK_DEVICE.id, 'same browser, same token');
  assert.notEqual(browser().window.MLK_DEVICE.id, b.window.MLK_DEVICE.id, 'another browser gets its own token');
});

test('client: restores the token from the cookie if localStorage was cleared', () => {
  const b = browser({ cookie: 'other=1; mlk_did=abcdef0123456789abcdef0123456789' });
  assert.equal(b.window.MLK_DEVICE.id, 'abcdef0123456789abcdef0123456789');
});

test('client: adds device headers to API calls only, keeping existing headers', async () => {
  const b = browser();
  await b.window.fetch('/api/user/profile', { method: 'GET', headers: { Authorization: 'Bearer t' } });
  await b.window.fetch('/assets/images/logo.svg');
  await b.window.fetch('https://evil.example.com/api/steal');

  const api = b.calls[0].init.headers;
  assert.equal(api.Authorization, 'Bearer t');
  assert.equal(api['X-Device-Id'], b.window.MLK_DEVICE.id);
  assert.equal(api['X-Device-Platform'], 'web');
  assert.equal(b.calls[0].init.method, 'GET');
  assert.equal(b.calls[1].init, undefined);
  assert.equal(b.calls[2].init, undefined, 'the token never goes to other sites');
});

test('client: reports the app platform', () => {
  assert.equal(browser({ userAgent: 'Mozilla/5.0 (Linux; Android 9) MetaLinkApp/1.1' }).window.MLK_DEVICE.platform, 'android');
  assert.equal(browser({ capacitor: 'ios' }).window.MLK_DEVICE.platform, 'ios');
  assert.equal(browser({ capacitor: 'something-else' }).window.MLK_DEVICE.platform, 'web');
});
