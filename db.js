// Postgres data layer. Every record lives in its own row (indexed columns for lookups + the full
// record as a jsonb `data` blob, so API responses keep exactly the shape the frontend already uses).
// Balance-changing code runs inside tx() and locks the rows it touches with FOR UPDATE, so two
// concurrent requests can no longer overwrite each other's changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[DB] DATABASE_URL is not set. The server needs Postgres to run (see README).');
  process.exit(1);
}

const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_SIZE || '10', 10)
});
pool.on('error', e => console.error('[DB] idle client error:', e.message));

// Plain document collections: table name -> legacy JSON filename (used only for the one-time import).
const DOC_TABLES = {
  admins: 'admins.json',
  announcements: 'announcements.json',
  deposits: 'deposits.json',
  earn_positions: 'earn_positions.json',
  nft_catalog: 'nft_catalog.json',
  reserve_orders: 'reserve_orders.json',
  user_stakes: 'user_stakes.json',
  wallet_submissions: 'wallet_submissions.json',
  withdrawals: 'withdrawals.json'
};

async function createSchema(c) {
  for (const t of Object.keys(DOC_TABLES)) {
    await c.query(`CREATE TABLE IF NOT EXISTS ${t} (
      seq bigserial,
      id text PRIMARY KEY,
      user_id text,
      data jsonb NOT NULL
    )`);
    await c.query(`CREATE INDEX IF NOT EXISTS ${t}_user_id_idx ON ${t} (user_id, seq)`);
    await c.query(`CREATE INDEX IF NOT EXISTS ${t}_seq_idx ON ${t} (seq)`);
  }
  await c.query(`CREATE TABLE IF NOT EXISTS users (
    seq bigserial,
    id text PRIMARY KEY,
    email text NOT NULL,
    username_lower text NOT NULL,
    uid text,
    referred_by text,
    data jsonb NOT NULL
  )`);
  await c.query('CREATE INDEX IF NOT EXISTS users_email_idx ON users (email)');
  await c.query('CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (username_lower)');
  await c.query('CREATE INDEX IF NOT EXISTS users_uid_idx ON users (uid)');
  await c.query('CREATE INDEX IF NOT EXISTS users_seq_idx ON users (seq)');
  await c.query(`CREATE TABLE IF NOT EXISTS teams (
    seq bigserial,
    id text PRIMARY KEY,
    user_id text NOT NULL,
    member_id text NOT NULL,
    data jsonb NOT NULL
  )`);
  await c.query('CREATE INDEX IF NOT EXISTS teams_user_id_idx ON teams (user_id, seq)');
  await c.query('CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL)');
  await c.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id text NOT NULL,
    role text NOT NULL,
    expires_at bigint NOT NULL,
    last_activity_write bigint NOT NULL DEFAULT 0
  )`);
  await c.query('CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)');
  await c.query('CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)');
  // Short-lived state (pending signups, password resets, 2FA setups/logins) shared across processes.
  await c.query(`CREATE TABLE IF NOT EXISTS ephemeral (
    kind text NOT NULL,
    key text NOT NULL,
    data jsonb NOT NULL,
    expires_at bigint NOT NULL,
    PRIMARY KEY (kind, key)
  )`);
  await c.query(`CREATE TABLE IF NOT EXISTS uploads (
    name text PRIMARY KEY,
    content_type text NOT NULL,
    bytes bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

function newId() { return Date.now().toString(36) + crypto.randomBytes(6).toString('hex'); }

// ---------- generic documents ----------

async function getDoc(c, table, id, { lock = false } = {}) {
  const { rows } = await c.query(`SELECT data FROM ${table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows.length ? rows[0].data : null;
}

async function listDocs(c, table, { userId, order = 'ASC' } = {}) {
  const { rows } = userId !== undefined
    ? await c.query(`SELECT data FROM ${table} WHERE user_id = $1 ORDER BY seq ${order}`, [userId])
    : await c.query(`SELECT data FROM ${table} ORDER BY seq ${order}`);
  return rows.map(r => r.data);
}

async function insertDoc(c, table, doc) {
  await c.query(`INSERT INTO ${table} (id, user_id, data) VALUES ($1, $2, $3)`, [doc.id, doc.userId || null, JSON.stringify(doc)]);
  return doc;
}

async function saveDoc(c, table, doc) {
  await c.query(`UPDATE ${table} SET data = $2 WHERE id = $1`, [doc.id, JSON.stringify(doc)]);
  return doc;
}

// Merges fields into a record in one statement, so it can't clobber concurrent changes to other fields.
// For users, only use this for fields that aren't mirrored into columns (email, username, uid, referredBy).
async function patchDoc(c, table, id, patch) {
  await c.query(`UPDATE ${table} SET data = data || $2::jsonb WHERE id = $1`, [id, JSON.stringify(patch)]);
}

async function deleteDoc(c, table, id) {
  await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

// ---------- users ----------

function userColumns(u) {
  return [u.id, u.email || '', String(u.username || '').toLowerCase(), u.uid || null, u.referredBy || null, JSON.stringify(u)];
}

async function getUser(c, id, opts) { return getDoc(c, 'users', id, opts); }

async function findUserBy(c, column, value) {
  const { rows } = await c.query(`SELECT data FROM users WHERE ${column} = $1 ORDER BY seq LIMIT 1`, [value]);
  return rows.length ? rows[0].data : null;
}

async function insertUser(c, u) {
  await c.query('INSERT INTO users (id, email, username_lower, uid, referred_by, data) VALUES ($1, $2, $3, $4, $5, $6)', userColumns(u));
  return u;
}

async function saveUser(c, u) {
  await c.query('UPDATE users SET email = $2, username_lower = $3, uid = $4, referred_by = $5, data = $6 WHERE id = $1', userColumns(u));
  return u;
}

// Locks several users in a stable order (by id) so concurrent transactions can't deadlock.
async function lockUsers(c, ids) {
  const unique = [...new Set(ids.filter(Boolean))].sort();
  if (!unique.length) return {};
  const { rows } = await c.query('SELECT id, data FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE', [unique]);
  const map = {};
  rows.forEach(r => { map[r.id] = r.data; });
  return map;
}

// ---------- settings ----------

async function getSetting(c, key) {
  const { rows } = await c.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : {};
}

async function setSetting(c, key, value) {
  await c.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, JSON.stringify(value)]);
}

// ---------- ephemeral ----------

async function ephGet(kind, key) {
  const { rows } = await pool.query('SELECT data FROM ephemeral WHERE kind = $1 AND key = $2', [kind, key]);
  return rows.length ? rows[0].data : null;
}

async function ephSet(kind, key, data) {
  await pool.query(
    'INSERT INTO ephemeral (kind, key, data, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, key) DO UPDATE SET data = $3, expires_at = $4',
    [kind, key, JSON.stringify(data), data.expiresAt]
  );
}

async function ephDel(kind, key) {
  await pool.query('DELETE FROM ephemeral WHERE kind = $1 AND key = $2', [kind, key]);
}

// ---------- one-time import of the old JSON-blob storage ----------

async function importLegacyData(c, dataDir) {
  const done = await c.query("SELECT 1 FROM settings WHERE key = '_legacy_import_done'");
  if (done.rows.length) return;

  const hasKv = (await c.query("SELECT to_regclass('kv_store') AS t")).rows[0].t !== null;
  async function load(file) {
    if (hasKv) {
      const { rows } = await c.query('SELECT value FROM kv_store WHERE key = $1', [file]);
      if (rows.length) return rows[0].value;
    }
    const p = path.join(dataDir, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  }

  // Duplicate/missing ids get a fresh id rather than being dropped -- these are financial records.
  async function insertRow(sql, makeParams, doc) {
    if (!doc.id) doc.id = newId();
    const r = await c.query(sql + ' ON CONFLICT (id) DO NOTHING', makeParams(doc));
    if (r.rowCount === 0) {
      console.warn('[DB] import: duplicate id', doc.id, '- assigning a new one');
      doc.id = newId();
      await c.query(sql, makeParams(doc));
    }
  }

  const counts = {};
  const users = await load('users.json');
  if (Array.isArray(users)) {
    for (const u of users) {
      await insertRow('INSERT INTO users (id, email, username_lower, uid, referred_by, data) VALUES ($1, $2, $3, $4, $5, $6)', userColumns, u);
    }
    counts.users = users.length;
  }
  for (const [table, file] of Object.entries(DOC_TABLES)) {
    const docs = await load(file);
    if (!Array.isArray(docs)) continue;
    for (const d of docs) {
      await insertRow(`INSERT INTO ${table} (id, user_id, data) VALUES ($1, $2, $3)`, x => [x.id, x.userId || null, JSON.stringify(x)], d);
    }
    counts[table] = docs.length;
  }
  const teams = await load('teams.json');
  if (Array.isArray(teams)) {
    for (const t of teams) {
      await c.query('INSERT INTO teams (id, user_id, member_id, data) VALUES ($1, $2, $3, $4)', [newId(), t.userId, t.memberId, JSON.stringify(t)]);
    }
    counts.teams = teams.length;
  }
  const config = await load('platform_config.json');
  if (config && typeof config === 'object' && !Array.isArray(config)) await setSetting(c, 'platform_config', config);

  await setSetting(c, '_legacy_import_done', { at: new Date().toISOString(), counts });
  console.log('[DB] Imported legacy data:', JSON.stringify(counts));
}

async function initDb(dataDir) {
  await tx(async c => {
    // Transaction-scoped lock: safe through Supabase's pooler, and stops two booting processes racing the import.
    await c.query('SELECT pg_advisory_xact_lock(424242)');
    await createSchema(c);
    await importLegacyData(c, dataDir);
  });
}

async function cleanupExpired() {
  const now = Date.now();
  await pool.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
  await pool.query('DELETE FROM ephemeral WHERE expires_at < $1', [now]);
}

module.exports = {
  pool, tx, newId, initDb, cleanupExpired,
  getDoc, listDocs, insertDoc, saveDoc, patchDoc, deleteDoc,
  getUser, findUserBy, insertUser, saveUser, lockUsers,
  getSetting, setSetting,
  ephGet, ephSet, ephDel
};
