// Moves USDT from users' personal deposit addresses to the company wallet ("sweeping"). Used by the
// admin panel's Sweep button (server) and by tools/deposit-wallet (owner's computer).
//
// Signing needs the deposit wallet's recovery phrase. User number i's address is
// m/44'/195'/0'/0/i (TRON) or m/44'/60'/0'/0/i (BNB Chain); network fees come from the "fee wallet"
// (number 0 of account 1'), which tops up each address with just enough TRX / BNB before moving it.

const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');
const { HDKey } = require('@scure/bip32');
const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');

const PATHS = {
  trc20: { account: "m/44'/195'/0'", fee: "m/44'/195'/1'/0/0" },
  bep20: { account: "m/44'/60'/0'", fee: "m/44'/60'/1'/0/0" }
};
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

function rootFromMnemonic(mnemonic) {
  const m = String(mnemonic || '').trim().toLowerCase().split(/\s+/).join(' ');
  if (!bip39.validateMnemonic(m, wordlist)) throw new Error('The recovery phrase is not valid. Check the words and their order.');
  return HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(m));
}

const hexKey = node => Buffer.from(node.privateKey).toString('hex');
const accountXpub = (root, network) => root.derive(PATHS[network].account).publicExtendedKey;
const tronAddressOf = node => TronWeb.address.fromPrivateKey(hexKey(node));
const bscAddressOf = node => new ethers.Wallet('0x' + hexKey(node)).address;
const feeWalletAddress = (root, network) => (network === 'trc20' ? tronAddressOf : bscAddressOf)(root.derive(PATHS[network].fee));
const isAddress = (network, a) => network === 'trc20' ? TronWeb.isAddress(String(a || '')) && String(a).startsWith('T') : ethers.isAddress(String(a || '')) && String(a).startsWith('0x');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sweeps send through BNB Chain's own public endpoints. Some free endpoints (publicnode) answer
// "archive requests require a token" when asked about a transaction they haven't seen yet, so
// confirmation is checked on several of them and errors just mean "ask again".
const BSC_SEND_RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.bnbchain.org', 'https://bsc-dataseed2.bnbchain.org'];

async function waitBscReceipt(hash, rpcUrls) {
  const providers = rpcUrls.map(u => new ethers.JsonRpcProvider(u, 56, { staticNetwork: true }));
  for (let n = 0; n < 60; n++) {
    await sleep(3000);
    for (const p of providers) {
      try {
        const r = await p.send('eth_getTransactionReceipt', [hash]);
        if (r && r.blockNumber) {
          if (r.status !== '0x1') throw Object.assign(new Error(`Transaction ${hash} failed on the blockchain`), { final: true });
          return r;
        }
      } catch (e) {
        if (e.final) throw e;
      }
    }
  }
  throw new Error(`Transaction ${hash} was not confirmed within 3 minutes. Check it on bscscan.com, then run the sweep again.`);
}

const tronClient = apiKey => new TronWeb({ fullHost: 'https://api.trongrid.io', headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {} });

// The fee wallet's native balance as a number of TRX / BNB.
async function feeWalletBalance(root, network, { rpcUrl, apiKey }) {
  const addr = feeWalletAddress(root, network);
  if (network === 'trc20') return (await tronClient(apiKey).trx.getBalance(addr)) / 1e6;
  return Number(ethers.formatEther(await new ethers.JsonRpcProvider(rpcUrl, 56).getBalance(addr)));
}

// Each sweep function checks the addresses numbered in `indexes` and, with `go`, moves every USDT
// balance of at least `min` to `to`. Without `go` it only reports. `log(line)` receives progress.
// Returns { total (USDT), count (addresses), fees (TRX/BNB), sent: [{ index, address, amount, txid }] }.

async function sweepBsc({ root, indexes, to, min = 1, go = false, rpcUrl, log = console.log }) {
  if (!isAddress('bep20', to)) throw new Error('The company BEP20 address is not valid');
  const rpcs = [...BSC_SEND_RPCS, rpcUrl].filter((u, i, all) => u && all.indexOf(u) === i);
  const provider = new ethers.JsonRpcProvider(rpcs[0], 56, { staticNetwork: true });
  const usdt = new ethers.Contract(USDT_BEP20, ERC20_ABI, provider);
  const feeWallet = new ethers.Wallet('0x' + hexKey(root.derive(PATHS.bep20.fee)), provider);
  const account = root.derive(PATHS.bep20.account);
  const { gasPrice } = await provider.getFeeData();
  if (!gasPrice) throw new Error('Could not read the BNB Chain gas price. Try again in a minute.');
  const minUnits = ethers.parseUnits(String(min), 18);
  const out = { total: 0, count: 0, fees: 0, sent: [] };
  await log(`Fee wallet ${feeWallet.address}: ${ethers.formatEther(await provider.getBalance(feeWallet.address))} BNB`);
  for (const i of indexes) {
    const wallet = new ethers.Wallet('0x' + hexKey(account.deriveChild(0).deriveChild(i)), provider);
    const bal = await usdt.balanceOf(wallet.address);
    if (bal === 0n || bal < minUnits) continue;
    let gasLimit;
    try { gasLimit = await usdt.transfer.estimateGas(to, bal, { from: wallet.address }); } catch (e) { gasLimit = 60000n; }
    gasLimit = gasLimit * 12n / 10n;
    const fee = gasLimit * gasPrice;
    const amount = Number(ethers.formatUnits(bal, 18));
    await log(`#${i} ${wallet.address}: ${amount} USDT (fee about ${ethers.formatEther(fee)} BNB)`);
    out.total += amount; out.count++; out.fees += Number(ethers.formatEther(fee));
    if (!go) continue;
    const bnb = await provider.getBalance(wallet.address);
    if (bnb < fee) {
      const top = await feeWallet.sendTransaction({ to: wallet.address, value: fee - bnb, gasPrice });
      await log(`   fee top-up ${top.hash}`);
      await waitBscReceipt(top.hash, rpcs);
    }
    const tx = await usdt.connect(wallet).transfer(to, bal, { gasLimit, gasPrice });
    await waitBscReceipt(tx.hash, rpcs);
    await log(`   sent -> ${tx.hash}`);
    out.sent.push({ index: i, address: wallet.address, amount, txid: tx.hash });
  }
  return out;
}

async function sweepTron({ root, indexes, to, min = 1, go = false, apiKey, log = console.log }) {
  if (!isAddress('trc20', to)) throw new Error('The company TRC20 address is not valid');
  const tw = tronClient(apiKey);
  const feeKey = hexKey(root.derive(PATHS.trc20.fee));
  const feeAddr = TronWeb.address.fromPrivateKey(feeKey);
  const account = root.derive(PATHS.trc20.account);
  const params = await tw.trx.getChainParameters();
  const energyFee = (params.find(p => p.key === 'getEnergyFee') || { value: 210 }).value; // sun per energy
  const minUnits = BigInt(Math.round(Number(min) * 1e6));
  const out = { total: 0, count: 0, fees: 0, sent: [] };
  await log(`Fee wallet ${feeAddr}: ${(await tw.trx.getBalance(feeAddr)) / 1e6} TRX`);

  const usdtBalance = async addr => {
    const r = await tw.transactionBuilder.triggerConstantContract(USDT_TRC20, 'balanceOf(address)', {}, [{ type: 'address', value: addr }], addr);
    return BigInt('0x' + ((r.constant_result && r.constant_result[0]) || '0'));
  };
  const waitTx = async txid => {
    for (let n = 0; n < 40; n++) {
      await sleep(3000);
      const info = await tw.trx.getTransactionInfo(txid);
      if (info && info.blockNumber) {
        if (info.receipt && info.receipt.result && info.receipt.result !== 'SUCCESS') throw new Error(`Transaction ${txid} failed: ${info.receipt.result}`);
        return info;
      }
    }
    throw new Error(`Transaction ${txid} was not confirmed in time`);
  };

  for (const i of indexes) {
    const key = hexKey(account.deriveChild(0).deriveChild(i));
    const addr = TronWeb.address.fromPrivateKey(key);
    const bal = await usdtBalance(addr);
    if (bal === 0n || bal < minUnits) continue;
    const transferParams = [{ type: 'address', value: to }, { type: 'uint256', value: bal.toString() }];
    let energy = 65000;
    try {
      const est = await tw.transactionBuilder.triggerConstantContract(USDT_TRC20, 'transfer(address,uint256)', {}, transferParams, addr);
      if (est.energy_used) energy = est.energy_used;
    } catch (e) { /* use the typical amount */ }
    // Energy plus about 0.4 TRX of bandwidth, with some room.
    const fee = Math.ceil(energy * energyFee * 1.15) + 400000;
    const amount = Number(bal) / 1e6;
    await log(`#${i} ${addr}: ${amount} USDT (fee about ${(fee / 1e6).toFixed(2)} TRX)`);
    out.total += amount; out.count++; out.fees += fee / 1e6;
    if (!go) continue;
    const trx = await tw.trx.getBalance(addr);
    if (trx < fee) {
      // The first TRX sent to an address also activates it on TRON.
      const top = await tw.trx.sendTrx(addr, Math.max(fee - trx, 1100000), feeKey);
      if (!top.result) throw new Error('Could not send TRX for fees: ' + JSON.stringify(top));
      await waitTx(top.txid || top.transaction.txID);
    }
    const built = await tw.transactionBuilder.triggerSmartContract(USDT_TRC20, 'transfer(address,uint256)', { feeLimit: fee + 2000000 }, transferParams, addr);
    const signed = await tw.trx.sign(built.transaction, key);
    const sent = await tw.trx.sendRawTransaction(signed);
    if (!sent.result) throw new Error(`Transfer from #${i} was rejected: ${JSON.stringify(sent)}`);
    await waitTx(signed.txID);
    await log(`   sent -> ${signed.txID}`);
    out.sent.push({ index: i, address: addr, amount, txid: signed.txID });
  }
  return out;
}

module.exports = {
  PATHS, rootFromMnemonic, accountXpub, feeWalletAddress, feeWalletBalance, isAddress,
  tronAddressOf, bscAddressOf, sweepBsc, sweepTron
};
