-- Sweeps started from the admin panel (moving USDT from users' deposit addresses to the company
-- wallet). Kept as a record; progress is written here so any server process can show it.
CREATE TABLE IF NOT EXISTS app.sweep_jobs (
  id            text        PRIMARY KEY,
  network       text        NOT NULL,               -- trc20 | bep20
  to_address    text        NOT NULL,
  dry_run       boolean     NOT NULL,
  min_amount    numeric     NOT NULL,
  status        text        NOT NULL,               -- running | done | failed
  log           jsonb       NOT NULL DEFAULT '[]',  -- progress lines
  result        jsonb,                              -- totals and transactions when finished
  error         text,
  admin_id      text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now(), -- a running job whose heartbeat stops was interrupted
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS sweep_jobs_started_idx ON app.sweep_jobs (started_at DESC);
