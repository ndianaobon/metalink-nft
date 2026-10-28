-- Personal deposit addresses (see deposit-addresses.js): one per user and network, derived from the
-- deposit wallet's public key at number `idx`. Rows are never deleted or reassigned, so an address
-- always belongs to the same user, even after their account is deleted.
CREATE TABLE IF NOT EXISTS app.user_deposit_addresses (
  network         text        NOT NULL,                -- trc20 | bep20
  address         text        NOT NULL,
  user_id         text        NOT NULL,
  idx             integer     NOT NULL,                -- derivation number: .../0/idx
  key_id          text        NOT NULL,                -- which public key it was derived from
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_viewed_at  timestamptz NOT NULL DEFAULT now(),  -- watched closely for a while after the user sees it
  checked_at      timestamptz,                         -- TRON: last time its transfers were read
  since_ms        bigint,                              -- TRON: read transfers from this time on
  PRIMARY KEY (network, address),
  UNIQUE (network, key_id, idx),
  UNIQUE (network, key_id, user_id)
);
CREATE INDEX IF NOT EXISTS user_deposit_addresses_user_idx ON app.user_deposit_addresses (user_id);

-- One transaction can pay several of our addresses (exchanges sometimes batch withdrawals), so a
-- transfer is identified by its destination as well as its hash.
ALTER TABLE app.deposit_transfers DROP CONSTRAINT IF EXISTS deposit_transfers_pkey;
ALTER TABLE app.deposit_transfers ADD PRIMARY KEY (network, txid, to_address);
