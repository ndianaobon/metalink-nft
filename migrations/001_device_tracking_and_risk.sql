-- Multi-account detection: devices each account uses, and a risk score per account.
-- Applied automatically at server start by db.runMigrations() (recorded in app.schema_migrations).

-- One row per (account, device). device_hash is an HMAC-SHA256 of a random token the app/site
-- generates on first launch; the raw token is never stored, and nothing about the hardware is read.
CREATE TABLE IF NOT EXISTS app.user_devices (
  user_id     text        NOT NULL,
  device_hash text        NOT NULL,
  platform    text        NOT NULL DEFAULT 'web',   -- web | android | ios
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  hits        integer     NOT NULL DEFAULT 1,
  risk_flags  text[]      NOT NULL DEFAULT '{}',    -- e.g. {shared_device} once another account uses it
  PRIMARY KEY (user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS user_devices_hash_idx ON app.user_devices (device_hash);
CREATE INDEX IF NOT EXISTS user_devices_last_seen_idx ON app.user_devices (last_seen);

-- Latest risk assessment per account, plus the admin's review decision.
CREATE TABLE IF NOT EXISTS app.account_risk (
  user_id        text        PRIMARY KEY,
  score          integer     NOT NULL DEFAULT 0,
  level          text        NOT NULL DEFAULT 'low',  -- low | medium | high
  needs_review   boolean     NOT NULL DEFAULT false,  -- has a strong signal (device / wallet / referral ring)
  flags          jsonb       NOT NULL DEFAULT '[]',   -- [{code, points, strong, detail}]
  linked         jsonb       NOT NULL DEFAULT '[]',   -- [{userId, via: [...]}]
  computed_at    timestamptz NOT NULL DEFAULT now(),
  review_status  text        NOT NULL DEFAULT 'open', -- open | cleared | confirmed
  reviewed_flags text[]      NOT NULL DEFAULT '{}',   -- flag codes present when the admin decided
  review_note    text,
  reviewed_by    text,
  reviewed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS account_risk_score_idx ON app.account_risk (score DESC);
