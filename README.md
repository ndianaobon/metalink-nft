# metalink-nft

## Running

```
npm install
npm start
```

All data (users, balances, deposits, sessions, uploaded images) is stored in Postgres, so the server
needs a database to start.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (Supabase in production). |
| `RESEND_API_KEY`, `EMAIL_FROM` | for email | Verification, reset and notification emails. |
| `WEB_CONCURRENCY` | no (default 1) | Number of server processes. Set to the number of CPU cores on the host. |
| `DB_POOL_SIZE` | no (default 10) | Database connections per process. |
| `DEVICE_HASH_SECRET` | recommended | Key for hashing device IDs (any long random string). If unset, one is generated and stored in `app.settings`. Changing it unlinks all existing device records. |

On first start against a database that still has the old `kv_store` table, the data is imported
into the new tables automatically (once). `kv_store` is left untouched as a backup.

**Local development:** the `DATABASE_URL` in `.env` points at the live database, and every action
you take locally changes live data. Point it at a separate database for testing.

## Database migrations

The base tables are created in `db.js` (`createSchema`). Later changes are SQL files in
`migrations/`, named `NNN_description.sql`. At startup each file that isn't yet listed in
`app.schema_migrations` runs once, in filename order, in the same transaction as the rest of the
setup. To change the schema, add a new numbered file; don't edit one that has already run.

| Migration | Adds |
| --- | --- |
| `001_device_tracking_and_risk.sql` | `app.user_devices`, `app.account_risk` |

## Tests

```
npm test
```

Runs the unit tests in `test/` with Node's built-in test runner (no database needed): device ID
handling, the browser script, and the risk scoring scenarios (same device, different devices,
shared Wi-Fi, bonus abuse).

## Multi-account detection

Spots one person running several accounts (usually to farm the sign-up bonus or referral
commissions) without punishing people who simply share a network.

**Device identification (privacy-conscious).** `public/assets/device.js` is loaded by `app.html`
and `signup.html`, so it covers the website and the Android/iOS app (which loads the live site).
On first use it creates a random 128-bit ID, keeps it in `localStorage` (with a first-party cookie
as a backup), and adds `X-Device-Id` and `X-Device-Platform` headers to API calls on this site
only. It reads nothing about the hardware: no IMEI, advertising ID, MAC address or browser
fingerprint. Clearing the app's or browser's data gives a new ID. The server (`device.js`) stores
only `HMAC-SHA256(DEVICE_HASH_SECRET, id)`, never the ID itself. Device rows are deleted when an
account is deleted, and automatically after 12 months unseen.

Devices are recorded at sign-up, at login, and on activity (throttled like the IP tracking), in
`app.user_devices`: user, device hash, platform (`web`/`android`/`ios`), first seen, last seen,
use count and `risk_flags` (`shared_device` once a second account uses it).

**Risk score (`risk.js`).** Weak signals are combined; no single weak one is treated as proof.

| Signal | Points | Strength |
| --- | --- | --- |
| Same device as another account | 35, +10 per extra account (max 55) | strong |
| Same withdrawal wallet (saved, or used in a withdrawal) | 40, +10 per extra (max 55) | strong |
| Referral between accounts sharing a device or wallet | 25 | strong |
| 2+ linked accounts took the sign-up bonus and never deposited | 20 | strong |
| Created within 72 h of another account on the same device | 10 | weak |
| Withdrawal requested without any approved deposit | 10 | weak |
| Same public IP as other accounts | 3 per account (max 15) | weak |

Score is capped at 100: **low** < 30, **medium** 30–59, **high** ≥ 60. An account *needs review*
only if it's medium or high **and** has a strong signal. IPs shared by 25 or more accounts (mobile
carrier NAT, campus, public hotspot) are ignored. Weak signals together can reach at most 25, so
shared IP can never put an account up for review on its own.

Scores are stored in `app.account_risk` and recomputed in the background when a new account/device
pair appears, after sign-up, when a wallet address is saved and when a withdrawal is requested.
When a link appears, the other linked accounts are rescored too.

**Withdrawals are never blocked by this.** Every withdrawal already waits for admin approval. For a
flagged account the admin Withdrawals page shows a risk badge, and Approve asks for confirmation.

**Admin: Risk Review page.** Lists scored accounts (Open / Confirmed / Cleared). *Investigate* shows
the signals, the account's devices (shortened hash, platform, first/last seen, other accounts),
the linked accounts (and how each is linked, with their deposits and withdrawals), and Suspend / Ban
buttons. The admin can *Clear* (stays cleared unless a new strong signal appears later), *Confirm
abuse*, or *Reopen*, with a note. *Rescan all accounts* rescores every account that shares a
device, wallet or IP, e.g. after first deploying this or after changing the rules. The existing
Multi-Accounts page (accounts grouped by shared IP) is unchanged.

Accounts only get a device record once they use the site or the updated app after this is
deployed, so expect device links to build up over the first days.
