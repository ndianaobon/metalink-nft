const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { HDKey } = require('@scure/bip32');
const { parseXpub, deriveAddress, checksumAddress, keyId, loadKeys } = require('../deposit-addresses');
const { fetchBscTransfers, USDT } = require('../deposit-watch');

// The standard BIP39 test phrase; its addresses are published by every wallet library.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512'));
const XPUB_BEP20 = root.derive("m/44'/60'/0'").publicExtendedKey;
const XPUB_TRC20 = root.derive("m/44'/195'/0'").publicExtendedKey;

test('user addresses match the well-known addresses of the test phrase', () => {
  assert.strictEqual(deriveAddress(parseXpub(XPUB_BEP20), 'bep20', 0), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.strictEqual(deriveAddress(parseXpub(XPUB_BEP20), 'bep20', 1), '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0');
  assert.strictEqual(deriveAddress(parseXpub(XPUB_TRC20), 'trc20', 0), 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
});

test('every number gives a different address', () => {
  const key = parseXpub(XPUB_TRC20);
  const seen = new Set(Array.from({ length: 50 }, (_, i) => deriveAddress(key, 'trc20', i)));
  assert.strictEqual(seen.size, 50);
});

test('a private key is refused, so it can never be put on the server by mistake', () => {
  assert.throws(() => parseXpub(root.derive("m/44'/60'/0'").privateExtendedKey), /private key/);
  assert.throws(() => parseXpub('not a key'));
});

test('BNB Chain addresses use the EIP-55 checksum', () => {
  assert.strictEqual(checksumAddress('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
});

test('keys load from the environment; a bad key leaves that network off', () => {
  const keys = loadKeys({ DEPOSIT_XPUB_TRC20: XPUB_TRC20, DEPOSIT_XPUB_BEP20: 'xpub-garbage' });
  assert.ok(keys.trc20);
  assert.strictEqual(keys.trc20.id, keyId(XPUB_TRC20));
  assert.strictEqual(keys.bep20, undefined);
});

test('BSC: one log query watches many addresses and reports which one was paid', async () => {
  const a = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const b = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
  const topic = x => '0x' + x.slice(2).toLowerCase().padStart(64, '0');
  let filter;
  const fetchImpl = async (url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    if (method === 'eth_blockNumber') return { ok: true, json: async () => ({ result: '0x' + (1100).toString(16) }) };
    filter = params[0];
    return { ok: true, json: async () => ({ result: [{
      address: USDT.bep20.contract, transactionHash: '0xt', blockNumber: '0x400',
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic('0x' + 'aa'.repeat(20)), topic(b)],
      data: '0x' + (25n * 10n ** 18n).toString(16)
    }] }) };
  };
  const r = await fetchBscTransfers({ address: [a, b], fromBlock: 1000, rpcUrl: 'http://rpc', confirmations: 15, fetchImpl });
  assert.deepStrictEqual(filter.topics[2], [topic(a), topic(b)]);
  assert.strictEqual(r.transfers.length, 1);
  assert.strictEqual(r.transfers[0].to, b, 'reported with the address as given');
  assert.strictEqual(r.transfers[0].micro, 25000000);
});
