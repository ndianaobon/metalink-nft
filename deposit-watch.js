// Automatic deposits. The server watches the platform's own USDT deposit addresses on TRON (TRC20)
// and BNB Smart Chain (BEP20), and matches each incoming transfer to a deposit request by its exact
// amount: every request is given a unique amount (e.g. 100.37 USDT) for its network.
// It is read-only: it only ever needs the public addresses, never a private key or recovery phrase.

const crypto = require('crypto');

const USDT = {
  trc20: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
  bep20: { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 }
};
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// A payment still matches its request if it arrives up to 24 hours after the request was made
// (the user sees a shorter window), and amounts stay reserved for that long so they're never reused.
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
// Allows for the chain's clock and ours differing slightly.
const CLOCK_SKEW_MS = 2 * 60 * 1000;

// Amounts are compared as whole micro-USDT (6 decimals), so float rounding can never make two
// different amounts equal. `exact` is false when the transfer has more precision than that.
function microOf(units, decimals) {
  const v = BigInt(units);
  if (decimals <= 6) return { micro: Number(v * 10n ** BigInt(6 - decimals)), exact: true };
  const div = 10n ** BigInt(decimals - 6);
  return { micro: Number(v / div), exact: v % div === 0n };
}

function amountToMicro(amount) { return Math.round(Number(amount) * 1e6); }

function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Picks the amount a user must send: the whole-USDT amount they asked for plus a few cents that no
// other request on the network is using. Tries 2 decimals first (100.37), then 3 (100.374).
// Returns null if every amount for this whole number is taken.
function pickPayAmount(base, takenMicros, random = Math.random) {
  const baseMicro = Math.floor(base) * 1e6;
  const cents = shuffle(Array.from({ length: 99 }, (_, i) => baseMicro + (i + 1) * 10000), random);
  const mills = shuffle(Array.from({ length: 999 }, (_, i) => i + 1).filter(k => k % 10 !== 0).map(k => baseMicro + k * 1000), random);
  for (const micro of cents.concat(mills)) {
    if (!takenMicros.has(micro)) return micro / 1e6;
  }
  return null;
}

// The request a transfer pays, or null. Needs the exact amount, the same network, and a transfer made
// after the request (within the match window). More than one candidate is never guessed between.
function findMatch(transfer, requests) {
  if (!transfer.exact) return null;
  const hits = requests.filter(r =>
    r.network === transfer.network &&
    r.payMicro === transfer.micro &&
    transfer.timeMs >= r.createdAtMs - CLOCK_SKEW_MS &&
    transfer.timeMs <= r.createdAtMs + MATCH_WINDOW_MS);
  return hits.length === 1 ? hits[0] : null;
}

// ---------- TRON (TronGrid) ----------

// Confirmed incoming USDT transfers to `address` since `sinceMs`, oldest first. `complete` is false
// if there were more pages than we read, so the caller doesn't skip past the unread ones.
async function fetchTronTransfers({ address, sinceMs, apiKey, fetchImpl = fetch, maxPages = 5 }) {
  const base = `https://api.trongrid.io/v1/accounts/${encodeURIComponent(address)}/transactions/trc20` +
    `?only_to=true&only_confirmed=true&limit=200&order_by=block_timestamp,asc` +
    `&contract_address=${USDT.trc20.contract}&min_timestamp=${Math.max(0, Math.floor(sinceMs))}`;
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  const transfers = [];
  let url = base;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`TronGrid returned HTTP ${res.status}`);
    const j = await res.json();
    if (j.success === false) throw new Error('TronGrid: ' + (j.error || 'request failed'));
    for (const t of j.data || []) {
      if (t.type && t.type !== 'Transfer') continue;
      if (t.to !== address || !t.token_info || t.token_info.address !== USDT.trc20.contract) continue;
      transfers.push({
        network: 'trc20', txid: t.transaction_id, from: t.from, to: t.to,
        ...microOf(t.value, USDT.trc20.decimals), timeMs: t.block_timestamp
      });
    }
    const next = j.meta && j.meta.fingerprint;
    if (!next) return { transfers, complete: true };
    url = base + '&fingerprint=' + encodeURIComponent(next);
  }
  return { transfers, complete: false };
}

// ---------- BNB Smart Chain (JSON-RPC) ----------

async function rpc(rpcUrl, method, params, fetchImpl = fetch) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`BSC RPC returned HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error('BSC RPC: ' + (j.error.message || 'request failed'));
  return j.result;
}

// Incoming USDT transfers to `address` (one address, or a list of them) from block `fromBlock` up to
// the newest block that has `confirmations` blocks on top of it, read in chunks. `nextBlock` is where
// the next poll starts. Each transfer's `to` is the watched address exactly as it was passed in.
async function fetchBscTransfers({ address, fromBlock, rpcUrl, confirmations = 15, chunk = 1000, maxChunks = 10, fetchImpl = fetch }) {
  const latest = parseInt(await rpc(rpcUrl, 'eth_blockNumber', [], fetchImpl), 16);
  const safe = latest - confirmations;
  let from = fromBlock != null ? fromBlock : safe - 200;
  const watched = new Map([].concat(address).map(a => ['0x' + a.slice(2).toLowerCase().padStart(64, '0'), a]));
  const toTopics = [...watched.keys()];
  const transfers = [];
  for (let n = 0; n < maxChunks && from <= safe; n++) {
    const to = Math.min(from + chunk - 1, safe);
    const logs = await rpc(rpcUrl, 'eth_getLogs', [{
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      address: USDT.bep20.contract, topics: [TRANSFER_TOPIC, null, toTopics.length === 1 ? toTopics[0] : toTopics]
    }], fetchImpl);
    for (const log of logs || []) {
      if (log.removed || String(log.address).toLowerCase() !== USDT.bep20.contract.toLowerCase()) continue;
      const dest = watched.get(String(log.topics[2]).toLowerCase());
      if (!dest) continue;
      transfers.push({
        network: 'bep20', txid: log.transactionHash, from: '0x' + String(log.topics[1]).slice(26), to: dest,
        ...microOf(log.data === '0x' ? 0 : log.data, USDT.bep20.decimals),
        blockNumber: parseInt(log.blockNumber, 16), timeMs: null
      });
    }
    from = to + 1;
  }
  return { transfers, nextBlock: from, latest };
}

async function bscBlockTimeMs(rpcUrl, blockNumber, fetchImpl = fetch) {
  const block = await rpc(rpcUrl, 'eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false], fetchImpl);
  if (!block) throw new Error('BSC RPC: block ' + blockNumber + ' not found');
  return parseInt(block.timestamp, 16) * 1000;
}

// ---------- Looking up one transaction by its hash (a TxID the user pasted) ----------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256 = buf => crypto.createHash('sha256').update(buf).digest();

function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('Invalid base58 character');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const zeros = s.length - s.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}

function base58Encode(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}

// A TRON address (T...) as the 20-byte hex used in event logs, or null if it isn't a valid address.
function tronToHex(address) {
  try {
    const raw = base58Decode(address);
    if (raw.length !== 25 || raw[0] !== 0x41) return null;
    const body = raw.subarray(0, 21);
    if (!sha256(sha256(body)).subarray(0, 4).equals(raw.subarray(21))) return null;
    return body.subarray(1).toString('hex');
  } catch (e) { return null; }
}

function hexToTron(hex20) {
  const body = Buffer.from('41' + hex20, 'hex');
  return base58Encode(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}

// A pasted transaction hash in the form each chain uses (TRON: 64 hex; BSC: 0x + 64 hex), or null.
function normalizeTxid(network, txid) {
  const h = String(txid || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  return network === 'bep20' ? '0x' + h : h;
}

// The USDT transfers to `address` in transaction `txid`. `state` is 'ok' once it's confirmed,
// otherwise 'pending' (seen but not confirmed yet), 'failed' (reverted) or 'notfound'.
async function lookupTronTx({ txid, address, apiKey, fetchImpl = fetch }) {
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) };
  const get = async path => {
    const res = await fetchImpl('https://api.trongrid.io' + path, { method: 'POST', headers, body: JSON.stringify({ value: txid }) });
    if (!res.ok) throw new Error(`TronGrid returned HTTP ${res.status}`);
    return res.json();
  };
  // walletsolidity only knows confirmed transactions.
  const info = await get('/walletsolidity/gettransactioninfobyid');
  if (!info || !info.id) {
    const unconfirmed = await get('/wallet/gettransactioninfobyid');
    return { state: unconfirmed && unconfirmed.id ? 'pending' : 'notfound', transfers: [] };
  }
  if (info.receipt && info.receipt.result && info.receipt.result !== 'SUCCESS') return { state: 'failed', transfers: [] };
  const contractHex = tronToHex(USDT.trc20.contract);
  const toHex = tronToHex(address);
  const transfers = [];
  for (const log of info.log || []) {
    const topics = (log.topics || []).map(t => String(t).toLowerCase().replace(/^0x/, ''));
    if (String(log.address).toLowerCase().replace(/^41/, '') !== contractHex) continue;
    if (topics.length < 3 || '0x' + topics[0] !== TRANSFER_TOPIC || topics[2].slice(24) !== toHex) continue;
    transfers.push({
      network: 'trc20', txid, from: hexToTron(topics[1].slice(24)), to: address,
      ...microOf('0x' + (log.data || '0'), USDT.trc20.decimals), timeMs: info.blockTimeStamp
    });
  }
  return { state: 'ok', transfers };
}

async function lookupBscTx({ txid, address, rpcUrl, confirmations = 15, fetchImpl = fetch }) {
  const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txid], fetchImpl);
  if (!receipt) return { state: 'notfound', transfers: [] };
  if (receipt.status === '0x0') return { state: 'failed', transfers: [] };
  const blockNumber = parseInt(receipt.blockNumber, 16);
  const latest = parseInt(await rpc(rpcUrl, 'eth_blockNumber', [], fetchImpl), 16);
  if (latest - blockNumber < confirmations) return { state: 'pending', transfers: [] };
  const toTopic = '0x' + address.slice(2).toLowerCase().padStart(64, '0');
  const transfers = [];
  for (const log of receipt.logs || []) {
    if (log.removed || String(log.address).toLowerCase() !== USDT.bep20.contract.toLowerCase()) continue;
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC || String(log.topics[2]).toLowerCase() !== toTopic) continue;
    transfers.push({
      network: 'bep20', txid, from: '0x' + String(log.topics[1]).slice(26), to: address,
      ...microOf(log.data === '0x' ? 0 : log.data, USDT.bep20.decimals), blockNumber, timeMs: null
    });
  }
  if (transfers.length) {
    const timeMs = await bscBlockTimeMs(rpcUrl, blockNumber, fetchImpl);
    transfers.forEach(t => { t.timeMs = timeMs; });
  }
  return { state: 'ok', transfers };
}

module.exports = {
  USDT, MATCH_WINDOW_MS, CLOCK_SKEW_MS,
  microOf, amountToMicro, pickPayAmount, findMatch,
  fetchTronTransfers, fetchBscTransfers, bscBlockTimeMs,
  tronToHex, hexToTron, normalizeTxid, lookupTronTx, lookupBscTx
};
