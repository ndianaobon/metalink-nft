#!/usr/bin/env node
// MetaLink deposit wallet. Run this on YOUR OWN COMPUTER.
//
//   node index.js new                         create the deposit wallet (shows the recovery phrase once)
//   node index.js keys                        show the public keys again from the recovery phrase
//   node index.js sweep --network trc20 --count 120 --to <your main wallet>          dry run
//   node index.js sweep --network trc20 --count 120 --to <your main wallet> --go     really send
//
// Users' personal deposit addresses are numbers 0, 1, 2, ... of this wallet:
//   TRON  m/44'/195'/0'/0/i      BNB Chain  m/44'/60'/0'/0/i
// The admin panel can also sweep (Company Wallet page) when the server has the phrase; this tool
// does the same from your computer. The sweep code itself is in ../../deposit-sweep.js.
//
// The recovery phrase is typed in when asked (or set in DEPOSIT_MNEMONIC) and never saved.

const readline = require('readline');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');
const sweep = require('../../deposit-sweep');

const BSC_RPC = process.env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com';

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

async function readRoot() {
  return sweep.rootFromMnemonic(process.env.DEPOSIT_MNEMONIC || await askHidden('Recovery phrase (hidden): '));
}

function printKeys(root) {
  const t = root.derive(sweep.PATHS.trc20.account), b = root.derive(sweep.PATHS.bep20.account);
  console.log('\nPut these two lines in the server environment (.env / hosting panel), then restart the server:\n');
  console.log('DEPOSIT_XPUB_TRC20=' + t.publicExtendedKey);
  console.log('DEPOSIT_XPUB_BEP20=' + b.publicExtendedKey);
  console.log('\nFee wallets (send a little TRX / BNB here; sweeping takes network fees from them):');
  console.log('  TRX fee wallet:  ' + sweep.feeWalletAddress(root, 'trc20'));
  console.log('  BNB fee wallet:  ' + sweep.feeWalletAddress(root, 'bep20'));
  console.log('\nFirst user addresses, to check against the admin panel / app:');
  console.log('  TRC20 #0: ' + sweep.tronAddressOf(t.deriveChild(0).deriveChild(0)));
  console.log('  BEP20 #0: ' + sweep.bscAddressOf(b.deriveChild(0).deriveChild(0)));
}

async function cmdNew() {
  const mnemonic = bip39.generateMnemonic(wordlist, 256);
  console.log('\n================  RECOVERY PHRASE  (24 words)  ================\n');
  console.log(mnemonic.split(' ').map((w, i) => String(i + 1).padStart(2) + '. ' + w).join('\n'));
  console.log('\n================================================================');
  console.log('Write these 24 words on paper, in order, and keep them somewhere safe and offline.');
  console.log('Anyone with these words can take ALL deposits. If you lose them, the deposits are lost.');
  console.log('Never put them in email, chat, screenshots or cloud notes.');
  printKeys(sweep.rootFromMnemonic(mnemonic));
}

async function cmdSweep(a) {
  const network = a.network;
  if (network !== 'trc20' && network !== 'bep20') throw new Error('--network must be trc20 or bep20');
  const count = parseInt(a.count, 10);
  if (!(count > 0)) throw new Error('--count is required: the "sweep tool count" on the admin Deposits page');
  if (!a.to || a.to === true) throw new Error('--to is required: your main wallet address on this network');
  const go = a.go === true;
  if (!go) console.log('DRY RUN: nothing will be sent. Add --go to really move the funds.\n');
  const opts = {
    root: await readRoot(), indexes: Array.from({ length: count }, (_, i) => i), to: a.to,
    min: a.min !== undefined ? Number(a.min) : 1, go, rpcUrl: BSC_RPC, apiKey: process.env.TRONGRID_API_KEY
  };
  const r = network === 'bep20' ? await sweep.sweepBsc(opts) : await sweep.sweepTron(opts);
  const unit = network === 'bep20' ? 'BNB' : 'TRX';
  console.log(`\n${go ? 'Moved' : 'Would move'} ${r.total} USDT from ${r.count} address(es); network fees about ${r.fees.toFixed(4)} ${unit}.`);
}

(async () => {
  const a = args();
  const cmd = a._[0];
  if (cmd === 'new') return cmdNew();
  if (cmd === 'keys') return printKeys(await readRoot());
  if (cmd === 'sweep') return cmdSweep(a);
  console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
})().catch(e => { console.error('\nError: ' + e.message); process.exit(1); });
