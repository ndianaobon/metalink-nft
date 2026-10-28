#!/usr/bin/env node
// MetaLink deposit wallet. Run this on YOUR OWN COMPUTER, never on the server.
//
//   node index.js new                         create the deposit wallet (shows the recovery phrase once)
//   node index.js keys                        show the public keys again from the recovery phrase
//   node index.js sweep --network trc20 --count 120 --to <your main wallet>          dry run
//   node index.js sweep --network trc20 --count 120 --to <your main wallet> --go     really send
//
// Users' personal deposit addresses are numbers 0, 1, 2, ... of this wallet:
//   TRON  m/44'/195'/0'/0/i      BNB Chain  m/44'/60'/0'/0/i
// The server only gets the public keys (xpub) of m/44'/195'/0' and m/44'/60'/0', so it can create
// addresses but never spend from them. Moving the money out needs a little TRX / BNB for network
// fees, which this tool takes from the "fee wallet" (number 0 of account 1') shown by `new` / `keys`.
//
// The recovery phrase is typed in when asked (or set in DEPOSIT_MNEMONIC) and never saved.

const readline = require('readline');
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
const BSC_RPC = process.env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

function args() {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      out[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
    } else out._.push(a[i]);
  }
  return out;
}

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function readMnemonic() {
  const m = (process.env.DEPOSIT_MNEMONIC || await askHidden('Recovery phrase (hidden): ')).trim().toLowerCase().split(/\s+/).join(' ');
  if (!bip39.validateMnemonic(m, wordlist)) throw new Error('That recovery phrase is not valid. Check the words and their order.');
  return HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(m));
}

const hexKey = node => Buffer.from(node.privateKey).toString('hex');
const tronAddressOf = node => TronWeb.address.fromPrivateKey(hexKey(node));
const bscAddressOf = node => new ethers.Wallet('0x' + hexKey(node)).address;

function printKeys(root) {
  const t = root.derive(PATHS.trc20.account), b = root.derive(PATHS.bep20.account);
  console.log('\nPut these two lines in the server environment (.env / hosting panel), then restart the server:\n');
  console.log('DEPOSIT_XPUB_TRC20=' + t.publicExtendedKey);
  console.log('DEPOSIT_XPUB_BEP20=' + b.publicExtendedKey);
  console.log('\nFee wallets (send a little TRX / BNB here; sweeping takes network fees from them):');
  console.log('  TRX fee wallet:  ' + tronAddressOf(root.derive(PATHS.trc20.fee)));
  console.log('  BNB fee wallet:  ' + bscAddressOf(root.derive(PATHS.bep20.fee)));
  console.log('\nFirst user addresses, to check against the admin panel / app:');
  console.log('  TRC20 #0: ' + tronAddressOf(t.deriveChild(0).deriveChild(0)));
  console.log('  BEP20 #0: ' + bscAddressOf(b.deriveChild(0).deriveChild(0)));
}

async function cmdNew() {
  const mnemonic = bip39.generateMnemonic(wordlist, 256);
  console.log('\n================  RECOVERY PHRASE  (24 words)  ================\n');
  console.log(mnemonic.split(' ').map((w, i) => String(i + 1).padStart(2) + '. ' + w).join('\n'));
  console.log('\n================================================================');
  console.log('Write these 24 words on paper, in order, and keep them somewhere safe and offline.');
  console.log('Anyone with these words can take ALL deposits. If you lose them, the deposits are lost.');
  console.log('Never put them on the server, in email, chat, screenshots or cloud notes.');
  printKeys(HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)));
}

async function cmdKeys() {
  printKeys(await readMnemonic());
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtUsdt = (units, decimals) => ethers.formatUnits(units, decimals);

async function sweepBsc(root, { count, to, min, go }) {
  if (!ethers.isAddress(to)) throw new Error('--to is not a valid BNB Chain address');
  const provider = new ethers.JsonRpcProvider(BSC_RPC, 56);
  const usdt = new ethers.Contract(USDT_BEP20, ERC20_ABI, provider);
  const feeWallet = new ethers.Wallet('0x' + hexKey(root.derive(PATHS.bep20.fee)), provider);
  const account = root.derive(PATHS.bep20.account);
  const { gasPrice } = await provider.getFeeData();
  const minUnits = ethers.parseUnits(String(min), 18);
  let total = 0n, moved = 0, feeTotal = 0n;
  console.log(`Fee wallet ${feeWallet.address}: ${ethers.formatEther(await provider.getBalance(feeWallet.address))} BNB`);
  for (let i = 0; i < count; i++) {
    const wallet = new ethers.Wallet('0x' + hexKey(account.deriveChild(0).deriveChild(i)), provider);
    const bal = await usdt.balanceOf(wallet.address);
    if (bal === 0n || bal < minUnits) continue;
    let gasLimit;
    try { gasLimit = await usdt.transfer.estimateGas(to, bal, { from: wallet.address }); } catch (e) { gasLimit = 60000n; }
    gasLimit = gasLimit * 12n / 10n;
    const fee = gasLimit * gasPrice;
    const bnb = await provider.getBalance(wallet.address);
    console.log(`#${i} ${wallet.address}: ${fmtUsdt(bal, 18)} USDT, fee about ${ethers.formatEther(fee)} BNB`);
    total += bal; feeTotal += fee;
    if (!go) continue;
    if (bnb < fee) {
      const top = await feeWallet.sendTransaction({ to: wallet.address, value: fee - bnb });
      await top.wait();
    }
    const tx = await usdt.connect(wallet).transfer(to, bal, { gasLimit, gasPrice });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`Transfer from #${i} failed: ${tx.hash}`);
    console.log(`   sent -> ${tx.hash}`);
    moved++;
  }
  console.log(`\n${go ? 'Moved' : 'Would move'} ${fmtUsdt(total, 18)} USDT${go ? ` from ${moved} address(es)` : ''}; network fees about ${ethers.formatEther(feeTotal)} BNB.`);
}

async function sweepTron(root, { count, to, min, go }) {
  const headers = process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {};
  const tw = new TronWeb({ fullHost: 'https://api.trongrid.io', headers });
  if (!TronWeb.isAddress(to)) throw new Error('--to is not a valid TRON address');
  const feeKey = hexKey(root.derive(PATHS.trc20.fee));
  const feeAddr = TronWeb.address.fromPrivateKey(feeKey);
  const account = root.derive(PATHS.trc20.account);
  const params = await tw.trx.getChainParameters();
  const energyFee = (params.find(p => p.key === 'getEnergyFee') || { value: 210 }).value; // sun per energy
  const minUnits = BigInt(Math.round(Number(min) * 1e6));
  let total = 0n, moved = 0, feeTotal = 0;
  console.log(`Fee wallet ${feeAddr}: ${(await tw.trx.getBalance(feeAddr)) / 1e6} TRX`);

  const usdtBalance = async addr => {
    const r = await tw.transactionBuilder.triggerConstantContract(USDT_TRC20, 'balanceOf(address)', {}, [{ type: 'address', value: addr }], addr);
    return BigInt('0x' + (r.constant_result && r.constant_result[0] || '0'));
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

  for (let i = 0; i < count; i++) {
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
    const trx = await tw.trx.getBalance(addr);
    console.log(`#${i} ${addr}: ${Number(bal) / 1e6} USDT, fee about ${(fee / 1e6).toFixed(2)} TRX`);
    total += bal; feeTotal += fee;
    if (!go) continue;
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
    console.log(`   sent -> ${signed.txID}`);
    moved++;
  }
  console.log(`\n${go ? 'Moved' : 'Would move'} ${Number(total) / 1e6} USDT${go ? ` from ${moved} address(es)` : ''}; network fees about ${(feeTotal / 1e6).toFixed(2)} TRX.`);
}

async function cmdSweep(a) {
  const network = a.network;
  if (network !== 'trc20' && network !== 'bep20') throw new Error('--network must be trc20 or bep20');
  const count = parseInt(a.count, 10);
  if (!(count > 0)) throw new Error('--count is required: the "sweep tool count" on the admin Deposits page');
  if (!a.to || a.to === true) throw new Error('--to is required: your main wallet address on this network');
  const opts = { count, to: a.to, min: a.min !== undefined ? Number(a.min) : 1, go: a.go === true };
  if (!opts.go) console.log('DRY RUN: nothing will be sent. Add --go to really move the funds.\n');
  const root = await readMnemonic();
  if (network === 'bep20') await sweepBsc(root, opts);
  else await sweepTron(root, opts);
}

(async () => {
  const a = args();
  const cmd = a._[0];
  if (cmd === 'new') return cmdNew();
  if (cmd === 'keys') return cmdKeys();
  if (cmd === 'sweep') return cmdSweep(a);
  console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
})().catch(e => { console.error('\nError: ' + e.message); process.exit(1); });
