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

On first start against a database that still has the old `kv_store` table, the data is imported
into the new tables automatically (once). `kv_store` is left untouched as a backup.

**Local development:** the `DATABASE_URL` in `.env` points at the live database, and every action
you take locally changes live data. Point it at a separate database for testing.
