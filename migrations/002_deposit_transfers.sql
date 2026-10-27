-- Automatic deposits: every incoming USDT transfer the watcher has seen on the platform's deposit
-- addresses, once per (network, txid). The primary key is what stops a transfer being credited twice.
-- Applied automatically at server start by db.runMigrations() (recorded in app.schema_migrations).
CREATE TABLE IF NOT EXISTS app.deposit_transfers (
  network      text          NOT NULL,                 -- trc20 | bep20
  txid         text          NOT NULL,
  from_address text,
  to_address   text          NOT NULL,
  amount       numeric(30,6) NOT NULL,
  block_time   timestamptz,
  status       text          NOT NULL DEFAULT 'unmatched', -- matched | unmatched | assigned | ignored
  deposit_id   text,                                   -- the deposit it credited (matched / assigned)
  seen_at      timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (network, txid)
);
CREATE INDEX IF NOT EXISTS deposit_transfers_status_idx ON app.deposit_transfers (status, block_time);

-- Looking deposits up by transaction hash (duplicate-credit checks).
CREATE INDEX IF NOT EXISTS deposits_txid_idx ON app.deposits (lower(data->>'txid'));
