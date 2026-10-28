// Personal deposit addresses: every user gets their own USDT address on TRON (TRC20) and BNB Smart
// Chain (BEP20), so a payment to it can only be theirs, whatever amount they send.
//
// The addresses come from the account-level extended PUBLIC keys (xpub) of the platform's deposit
// wallet (BIP44 m/44'/195'/0' for TRON, m/44'/60'/0' for BNB Chain); user number i gets .../0/i.
// The server can derive addresses but can never spend from them: the recovery phrase stays with the
// owner, who moves the funds with tools/deposit-wallet on their own computer.

const crypto = require('crypto');
const { HDKey } = require('@scure/bip32');
const { secp256k1 } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');
const { hexToTron } = require('./deposit-watch');

const NETWORKS = ['trc20', 'bep20'];

function parseXpub(xpub) {
  const key = HDKey.fromExtendedKey(String(xpub || '').trim());
  if (key.privateKey) throw new Error('This is a private key (xprv). Use the public key (xpub) only.');
  return key;
}

// The 20-byte account hash both chains build their addresses from.
function accountHash(publicKey) {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  return Buffer.from(keccak_256(uncompressed.subarray(1))).subarray(12).toString('hex');
}

// EIP-55 mixed-case checksum, as wallets and explorers display BNB Chain addresses.
function checksumAddress(hex20) {
  const hash = Buffer.from(keccak_256(Buffer.from(hex20, 'ascii'))).toString('hex');
  return '0x' + [...hex20].map((ch, i) => parseInt(hash[i], 16) >= 8 ? ch.toUpperCase() : ch).join('');
}

function deriveAddress(accountKey, network, index) {
  const hex20 = accountHash(accountKey.deriveChild(0).deriveChild(index).publicKey);
  return network === 'trc20' ? hexToTron(hex20) : checksumAddress(hex20);
}

// Short id of a key, stored with every address made from it, so that if the key in the server settings
// ever changes, addresses from the old key are never handed out or confused with new ones.
function keyId(xpub) {
  return crypto.createHash('sha256').update(String(xpub).trim()).digest('hex').slice(0, 16);
}

// { trc20: HDKey, bep20: HDKey } for the networks configured in the environment
// (DEPOSIT_XPUB_TRC20 / DEPOSIT_XPUB_BEP20). A bad key is logged and that network left off.
function loadKeys(env = process.env) {
  const keys = {};
  for (const network of NETWORKS) {
    const xpub = env['DEPOSIT_XPUB_' + network.toUpperCase()];
    if (!xpub) continue;
    try {
      keys[network] = { key: parseXpub(xpub), id: keyId(xpub) };
    } catch (e) {
      console.error(`[Deposits] DEPOSIT_XPUB_${network.toUpperCase()} is not a valid extended public key:`, e.message);
    }
  }
  return keys;
}

module.exports = { NETWORKS, parseXpub, deriveAddress, checksumAddress, keyId, loadKeys };
