// Automatic deposits. The server watches the platform's own USDT deposit addresses on TRON (TRC20)
// and BNB Smart Chain (BEP20), and matches each incoming transfer to a deposit request by its exact
// amount: every request is given a unique amount (e.g. 100.37 USDT) for its network.
// It is read-only: it only ever needs the public addresses, never a private key or recovery phrase.

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

// Incoming USDT transfers to `address` from block `fromBlock` up to the newest block that has
// `confirmations` blocks on top of it, read in chunks. `nextBlock` is where the next poll starts.
async function fetchBscTransfers({ address, fromBlock, rpcUrl, confirmations = 15, chunk = 1000, maxChunks = 10, fetchImpl = fetch }) {
  const latest = parseInt(await rpc(rpcUrl, 'eth_blockNumber', [], fetchImpl), 16);
  const safe = latest - confirmations;
  let from = fromBlock != null ? fromBlock : safe - 200;
  const toTopic = '0x' + address.slice(2).toLowerCase().padStart(64, '0');
  const transfers = [];
  for (let n = 0; n < maxChunks && from <= safe; n++) {
    const to = Math.min(from + chunk - 1, safe);
    const logs = await rpc(rpcUrl, 'eth_getLogs', [{
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      address: USDT.bep20.contract, topics: [TRANSFER_TOPIC, null, toTopic]
    }], fetchImpl);
    for (const log of logs || []) {
      if (log.removed || String(log.address).toLowerCase() !== USDT.bep20.contract.toLowerCase()) continue;
      if (String(log.topics[2]).toLowerCase() !== toTopic) continue;
      transfers.push({
        network: 'bep20', txid: log.transactionHash, from: '0x' + String(log.topics[1]).slice(26), to: address,
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

module.exports = {
  USDT, MATCH_WINDOW_MS, CLOCK_SKEW_MS,
  microOf, amountToMicro, pickPayAmount, findMatch,
  fetchTronTransfers, fetchBscTransfers, bscBlockTimeMs
};
