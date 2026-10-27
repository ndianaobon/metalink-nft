const test = require('node:test');
const assert = require('node:assert');
const {
  USDT, microOf, amountToMicro, pickPayAmount, findMatch, fetchTronTransfers, fetchBscTransfers
} = require('../deposit-watch');

const HOUR = 60 * 60 * 1000;
const TRON_ADDR = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const BSC_ADDR = '0x1111111111111111111111111111111111111111';

const json = body => ({ ok: true, json: async () => body });

test('amounts are compared in whole micro-USDT for both token precisions', () => {
  assert.deepStrictEqual(microOf('100370000', 6), { micro: 100370000, exact: true });
  assert.deepStrictEqual(microOf('100370000000000000000', 18), { micro: 100370000, exact: true });
  assert.strictEqual(microOf('100370000000000000001', 18).exact, false);
  assert.strictEqual(amountToMicro(100.37), 100370000);
  assert.strictEqual(amountToMicro(0.1 + 0.2), 300000);
});

test('pay amount keeps the whole number and adds unused cents', () => {
  const amount = pickPayAmount(100, new Set());
  assert.ok(amount > 100 && amount < 101);
  assert.strictEqual(Math.round(amount * 100), amount * 100); // 2 decimals first
});

test('pay amount never repeats one that is taken, falls back to 3 decimals, then gives up', () => {
  const taken = new Set();
  for (let k = 1; k <= 99; k++) taken.add(50e6 + k * 10000);
  const third = pickPayAmount(50, taken);
  assert.ok(third > 50 && third < 51);
  assert.ok(!taken.has(amountToMicro(third)));
  assert.notStrictEqual(Math.round(third * 1000) % 10, 0); // a real 3rd decimal, not 50.370

  for (let k = 1; k <= 999; k++) taken.add(50e6 + k * 1000);
  assert.strictEqual(pickPayAmount(50, taken), null);
});

test('a transfer matches only the request with its exact amount, network and time window', () => {
  const t0 = Date.parse('2026-10-27T10:00:00Z');
  const requests = [
    { id: 'a', network: 'trc20', payMicro: 100370000, createdAtMs: t0 },
    { id: 'b', network: 'bep20', payMicro: 100370000, createdAtMs: t0 },
    { id: 'c', network: 'trc20', payMicro: 250050000, createdAtMs: t0 }
  ];
  const tr = (micro, timeMs, network = 'trc20', exact = true) => ({ network, micro, exact, timeMs });

  assert.strictEqual(findMatch(tr(100370000, t0 + 60000), requests).id, 'a');
  assert.strictEqual(findMatch(tr(100370000, t0 + 60000, 'bep20'), requests).id, 'b');
  assert.strictEqual(findMatch(tr(100000000, t0 + 60000), requests), null, 'wrong amount');
  assert.strictEqual(findMatch(tr(100370000, t0 + 60000, 'trc20', false), requests), null, 'extra precision');
  assert.strictEqual(findMatch(tr(100370000, t0 - HOUR), requests), null, 'sent before the request existed');
  assert.strictEqual(findMatch(tr(100370000, t0 + 23 * HOUR), requests).id, 'a', 'late payment still matches');
  assert.strictEqual(findMatch(tr(100370000, t0 + 25 * HOUR), requests), null, 'after the 24h window');
  assert.strictEqual(findMatch(tr(100370000, t0 + 60000), requests.concat({ id: 'dup', network: 'trc20', payMicro: 100370000, createdAtMs: t0 })), null, 'ambiguous');
});

test('TronGrid: keeps only real USDT transfers to our address and follows pages', async () => {
  const calls = [];
  const pages = [
    { success: true, data: [
      { transaction_id: 'tx1', type: 'Transfer', from: 'TFrom1', to: TRON_ADDR, value: '100370000', block_timestamp: 1000, token_info: { address: USDT.trc20.contract, decimals: 6 } },
      { transaction_id: 'fake', type: 'Transfer', from: 'TFrom2', to: TRON_ADDR, value: '100370000', block_timestamp: 1001, token_info: { address: 'TFakeTokenContract1111111111111111', decimals: 6 } },
      { transaction_id: 'out', type: 'Transfer', from: TRON_ADDR, to: 'TOther', value: '5', block_timestamp: 1002, token_info: { address: USDT.trc20.contract, decimals: 6 } }
    ], meta: { fingerprint: 'page2' } },
    { success: true, data: [
      { transaction_id: 'tx2', type: 'Transfer', from: 'TFrom3', to: TRON_ADDR, value: '50000000', block_timestamp: 2000, token_info: { address: USDT.trc20.contract, decimals: 6 } }
    ], meta: {} }
  ];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return json(pages[calls.length - 1]); };
  const r = await fetchTronTransfers({ address: TRON_ADDR, sinceMs: 500, apiKey: 'k', fetchImpl });

  assert.deepStrictEqual(r.transfers.map(t => t.txid), ['tx1', 'tx2']);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.transfers[0].micro, 100370000);
  assert.match(calls[0].url, /only_confirmed=true/);
  assert.match(calls[0].url, /min_timestamp=500/);
  assert.match(calls[1].url, /fingerprint=page2/);
  assert.strictEqual(calls[0].opts.headers['TRON-PRO-API-KEY'], 'k');
});

test('TronGrid: an error response throws instead of looking like "no payments"', async () => {
  await assert.rejects(fetchTronTransfers({ address: TRON_ADDR, sinceMs: 0, fetchImpl: async () => ({ ok: false, status: 429 }) }), /429/);
});

test('BSC: reads confirmed blocks in chunks and decodes USDT transfer logs', async () => {
  const toTopic = '0x' + BSC_ADDR.slice(2).padStart(64, '0');
  const ranges = [];
  const fetchImpl = async (url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    if (method === 'eth_blockNumber') return json({ result: '0x' + (2115).toString(16) });
    const { fromBlock, toBlock } = params[0];
    ranges.push([parseInt(fromBlock, 16), parseInt(toBlock, 16)]);
    const logs = ranges.length === 1 ? [{
      address: USDT.bep20.contract.toLowerCase(), transactionHash: '0xabc', blockNumber: '0x7d0',
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '22'.repeat(32).slice(0, 24) + 'aa'.repeat(20), toTopic],
      data: '0x' + (100370000n * 10n ** 12n).toString(16)
    }] : [];
    return json({ result: logs });
  };
  const r = await fetchBscTransfers({ address: BSC_ADDR, fromBlock: 1000, rpcUrl: 'http://rpc', confirmations: 15, chunk: 600, fetchImpl });

  assert.deepStrictEqual(ranges, [[1000, 1599], [1600, 2100]]); // stops 15 blocks behind the tip (2115)
  assert.strictEqual(r.nextBlock, 2101);
  assert.strictEqual(r.transfers.length, 1);
  assert.strictEqual(r.transfers[0].micro, 100370000);
  assert.strictEqual(r.transfers[0].exact, true);
  assert.strictEqual(r.transfers[0].from, '0x' + 'aa'.repeat(20));
});

test('BSC: an RPC error throws', async () => {
  const fetchImpl = async () => json({ error: { message: 'limit exceeded' } });
  await assert.rejects(fetchBscTransfers({ address: BSC_ADDR, fromBlock: 1, rpcUrl: 'http://rpc', fetchImpl }), /limit exceeded/);
});
