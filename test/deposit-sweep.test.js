const test = require('node:test');
const assert = require('node:assert');
const { tronCall } = require('../deposit-sweep');

const tooMany = () => Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });

test('TronGrid 429: waits and tries again', async () => {
  let calls = 0;
  const r = await tronCall(async () => { if (++calls < 3) throw tooMany(); return 'ok'; }, { waitMs: 1 });
  assert.strictEqual(r, 'ok');
  assert.strictEqual(calls, 3);
});

test('TronGrid 429: gives up after the last try', async () => {
  let calls = 0;
  await assert.rejects(tronCall(async () => { calls++; throw tooMany(); }, { tries: 3, waitMs: 1 }), /429/);
  assert.strictEqual(calls, 3);
});

test('other errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(tronCall(async () => { calls++; throw new Error('bad address'); }, { waitMs: 1 }), /bad address/);
  assert.strictEqual(calls, 1);
});
