# Deposit wallet tool

You can also sweep with one click on the admin panel's **Company Wallet** page (see the main
README). This tool does the same from your own computer, without the server needing the phrase.

Run this on **your own computer**. Run `npm install` in the main project folder first. It:

- creates the deposit wallet that every user's personal deposit address comes from, and
- moves the USDT from those addresses into your main wallet ("sweeping").

The server only ever gets the wallet's **public** keys. It can create addresses for users, but it
cannot spend from them. Only the 24-word recovery phrase can, and that stays with you.

## Setup (once)

You need [Node.js](https://nodejs.org) 20 or newer. In this folder:

```
npm install
node index.js new
```

1. Write the 24 words down on paper, in order. Keep them safe and offline. Anyone with them can
   take every deposit; if you lose them, the deposits are lost.
2. Copy the two `DEPOSIT_XPUB_...` lines into the server's environment settings and restart the
   server.
3. Check: open Deposit in the app with a test account. The admin Deposits page should say
   **Personal Deposit Addresses · On**.
4. Send some **TRX** and **BNB** to the two "fee wallet" addresses it printed. Sweeping takes its
   network fees from these.

Lost the printout of the keys? `node index.js keys` asks for the 24 words and shows them again.

## Moving deposits to your main wallet

Find the **sweep tool count** for the network on the admin Deposits page, then run a dry run first:

```
node index.js sweep --network trc20 --count 120 --to <your main TRON address>
node index.js sweep --network bep20 --count 120 --to <your main BNB Chain address>
```

It asks for the 24 words, lists every address holding USDT and the estimated fees, and sends
nothing. When it looks right, run the same command with `--go` added.

- `--min 20` skips addresses holding less than 20 USDT (default 1), so small amounts don't
  waste fees.
- Fees per address: on BNB Chain a few cents; on TRON about 7–15 TRX (the first time an address
  is used it also needs about 1.1 TRX to activate it). So it's cheaper to sweep TRON less often,
  once more has collected.
- For TRON, set a free `TRONGRID_API_KEY` from trongrid.io (e.g.
  `set TRONGRID_API_KEY=...` on Windows) if you see timeouts.
- If it stops with an error, just run it again: addresses already emptied are skipped.

## How the addresses are made

Standard BIP44 paths. Most phone wallets only open the first address of a recovery phrase, so this
tool is the practical way to reach the rest; keep a copy of this folder. Any developer can recover
the funds from the 24 words with these paths if needed:

| | User addresses | Fee wallet |
|---|---|---|
| TRON | `m/44'/195'/0'/0/i` | `m/44'/195'/1'/0/0` |
| BNB Chain | `m/44'/60'/0'/0/i` | `m/44'/60'/1'/0/0` |

User number `i` is shown nowhere to users; the server stores it with each address.
