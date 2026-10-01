require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const cluster = require('cluster');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { generateSecret: generateTotpSecret, generateURI: generateTotpURI, verify: verifyTotpCode } = require('otplib');
const QRCode = require('qrcode');
const db = require('./db');
const { pool, tx } = db;

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
// Number of worker processes. All state lives in Postgres, so any number of workers (or servers) can share the load.
const WORKERS = Math.max(1, parseInt(process.env.WEB_CONCURRENCY || '1', 10));

app.use(helmet({
  contentSecurityPolicy: false // app relies on inline <script>/<style>; CSP would need a rewrite of every page to use nonces
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets'), { maxAge: '1h' }));
// Files uploaded before uploads moved into Postgres; anything not found here falls through to the DB route below.
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

app.get('/uploads/:name', async (req, res) => {
  const { rows } = await pool.query('SELECT content_type, bytes FROM app.uploads WHERE name = $1', [req.params.name]);
  if (!rows.length) return res.status(404).end();
  // Upload names are server-generated and never reused, so the content behind a URL never changes.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(rows[0].content_type).send(rows[0].bytes);
});

function getConfig(c = pool) { return db.getSetting(c, 'platform_config'); }

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }
function generateUID() { return 'MLK' + Math.random().toString(36).substr(2, 8).toUpperCase(); }
function generateOrderNumber() { return Date.now().toString() + Math.floor(Math.random() * 100000).toString(); }

function generateVerificationCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

const EMAIL_LOGO_URL = 'https://metalinknft.com/assets/images/MetaLink-NFT-horizontal-light.png';

function emailWrapper(bodyHtml) {
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222;background:#ffffff;">
    <div style="text-align:center;margin-bottom:28px;">
      <img src="${EMAIL_LOGO_URL}" alt="MetaLinkNFT" style="height:36px;">
    </div>
    ${bodyHtml}
    <p style="margin-top:32px;font-size:0.8rem;color:#888;">Best regards,<br>MetaLink NFT Team</p>
  </div>`;
}

function verificationEmailHtml(code) {
  return emailWrapper(`
    <p>Hello,</p>
    <p>Thank you for signing up with MetaLink NFT.</p>
    <p>To complete your email verification and activate your account, please use the verification code below:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:6px;text-align:center;padding:16px;background:#f4f4fa;border-radius:8px;">${code}</p>
    <p>This code will expire shortly for your security. If you did not request this verification code, please ignore this email or contact our support team.</p>
    <p>Thank you for choosing MetaLink NFT.</p>`);
}

function passwordResetEmailHtml(code) {
  return emailWrapper(`
    <p>Hello,</p>
    <p>We received a request to reset your MetaLink NFT password.</p>
    <p>Use the verification code below to confirm this request and set a new password:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:6px;text-align:center;padding:16px;background:#f4f4fa;border-radius:8px;">${code}</p>
    <p>This code will expire shortly for your security. If you did not request a password reset, please ignore this email &mdash; your password will not be changed.</p>`);
}

function welcomeEmailHtml(username, uid) {
  return emailWrapper(`
    <p>Hi ${username},</p>
    <p>Welcome to MetaLink NFT! Your account has been created successfully and you're ready to start exploring.</p>
    <p style="text-align:center;padding:14px;background:#f4f4fa;border-radius:8px;font-family:'Courier New',monospace;font-weight:700;letter-spacing:1px;">UID: ${uid}</p>
    <p>Here's what you can do next:</p>
    <ul style="padding-left:20px;line-height:1.8;">
      <li><strong>Stake</strong> &mdash; put your balance to work in our Exclusive Zone NFT stakes</li>
      <li><strong>Earn</strong> &mdash; explore Growth, Comprehensive, Ecology and USDT Finance plans</li>
      <li><strong>Reserve</strong> &mdash; try a daily reservation draw for a chance at bonus rewards</li>
      <li><strong>Invite friends</strong> &mdash; earn team commission when the people you refer make deposits</li>
    </ul>
    <p>If you have any questions, our team is always here to help.</p>`);
}

function levelUpgradeEmailHtml(username, level, balance) {
  return emailWrapper(`
    <p>Hi ${username},</p>
    <p style="text-align:center;font-size:22px;font-weight:800;color:#4F46E5;margin:20px 0;">&#127881; Congratulations! You've reached Level ${level}</p>
    <p>Your wallet balance has crossed the threshold for Level ${level}, and your account has been automatically upgraded.</p>
    <p style="text-align:center;padding:14px;background:#f4f4fa;border-radius:8px;">Current Balance: <strong>${fmtMoney(balance)} USDT</strong></p>
    <p>Higher levels can unlock better rewards across the platform. Keep growing your balance to reach the next one.</p>`);
}

function depositConfirmedEmailHtml(username, amount, newBalance) {
  return emailWrapper(`
    <p>Hi ${username},</p>
    <p>Your deposit has been confirmed and credited to your account.</p>
    <p style="text-align:center;padding:14px;background:#f4f4fa;border-radius:8px;">
      Amount Deposited: <strong>${fmtMoney(amount)} USDT</strong><br>
      New Balance: <strong>${fmtMoney(newBalance)} USDT</strong>
    </p>
    <p>Thank you for using MetaLink NFT.</p>`);
}

function withdrawalStatusEmailHtml(username, amount, netAmount, status) {
  if (status === 'Approved') {
    return emailWrapper(`
      <p>Hi ${username},</p>
      <p>Your withdrawal request has been processed.</p>
      <p style="text-align:center;padding:14px;background:#f4f4fa;border-radius:8px;">
        Requested Amount: <strong>${fmtMoney(amount)} USDT</strong><br>
        Net Amount Sent: <strong>${fmtMoney(netAmount)} USDT</strong>
      </p>
      <p>Please allow some time for the transaction to reflect on your wallet, depending on network conditions.</p>`);
  }
  return emailWrapper(`
    <p>Hi ${username},</p>
    <p>Your withdrawal request for <strong>${fmtMoney(amount)} USDT</strong> was not approved, and the amount has been returned to your wallet balance.</p>
    <p>If you believe this is a mistake, please contact our support team.</p>`);
}

function fmtMoney(n) { return parseFloat(n || 0).toFixed(2); }

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) throw new Error('Email service not configured');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'MetaLinkNFT <onboarding@resend.dev>', to, subject, html })
  });
  if (!resp.ok) throw new Error('Failed to send email: ' + (await resp.text()));
}

// Legacy unsalted-SHA256 hash, kept only to verify passwords created before the bcrypt migration.
function legacyHash(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function isBcryptHash(h) { return typeof h === 'string' && /^\$2[aby]?\$/.test(h); }
async function hashPassword(pw) { return bcrypt.hash(pw, 10); }
// Verifies against bcrypt hashes; transparently accepts one-time legacy sha256 hashes so existing accounts aren't locked out.
async function verifyPassword(pw, storedHash) {
  if (isBcryptHash(storedHash)) return bcrypt.compare(pw, storedHash);
  return legacyHash(pw) === storedHash;
}

function isFrozen(user) {
  return !!user.frozenUntil && new Date(user.frozenUntil).getTime() > Date.now();
}

// epochTolerance: 30 accepts codes from one 30s step before/after the current one, to absorb minor clock drift between server and phone.
async function isValidTotp(code, secret) {
  if (!code || !secret) return false;
  const result = await verifyTotpCode({ secret, token: String(code).trim(), epochTolerance: 30 });
  return !!(result && result.valid);
}

const DEFAULT_LEVEL_THRESHOLDS = { 1: 100, 2: 500, 3: 1000, 4: 5000, 5: 10000, 6: 50000 };

// Mutates `user` in place if the user's balance now qualifies for a higher level; the caller still
// saves the user. The upgrade email is queued on `emails` and sent only after the transaction commits,
// so a rolled-back change never produces an email (and a slow send never blocks the request).
function checkAndApplyLevelUpgrade(user, config, emails) {
  let newLevel = user.level || 0;
  for (let lv = 1; lv <= 6; lv++) {
    const threshold = config['levelThreshold' + lv] !== undefined ? parseFloat(config['levelThreshold' + lv]) : DEFAULT_LEVEL_THRESHOLDS[lv];
    if (user.walletBalance >= threshold && lv > newLevel) newLevel = lv;
  }
  if (newLevel > (user.level || 0)) {
    user.level = newLevel;
    emails.push([user.email, `Congratulations! You've reached Level ${newLevel}`, levelUpgradeEmailHtml(user.username, newLevel, user.walletBalance)]);
  }
}

function sendQueuedEmails(emails) {
  emails.forEach(([to, subject, html]) => sendEmail(to, subject, html).catch(() => {}));
}

function publicProfile(user) {
  const { password, secondPassword, ...profile } = user;
  return profile;
}

// Short-lived state shared by all worker processes (stored in Postgres, see db.ephemeral).
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const LOGIN_2FA_TTL_MS = 5 * 60 * 1000;
const EPH_SIGNUP = 'signup';       // pending (unverified) signups, keyed by email
const EPH_RESET = 'reset';         // pending password resets, keyed by email
const EPH_2FA_SETUP = '2fa_setup'; // 2FA secret generated but not yet confirmed, keyed by userId
const EPH_LOGIN = 'login_2fa';     // logins awaiting a 2FA code, keyed by a random token

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // admin sessions are idle-timeout, not fixed -- see adminMiddleware
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const ACTIVITY_WRITE_THROTTLE_MS = 60 * 1000; // avoid a DB write on every single request

// Only a hash of each token is stored, so a leaked sessions table can't be used to log in.
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function createSession(subjectId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = role === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  await pool.query('INSERT INTO app.sessions (token_hash, user_id, role, expires_at) VALUES ($1, $2, $3, $4)', [hashToken(token), subjectId, role, Date.now() + ttl]);
  return token;
}

function deleteSession(tokenHash) {
  return pool.query('DELETE FROM app.sessions WHERE token_hash = $1', [tokenHash]);
}

function deleteSessionsFor(userId, role, exceptTokenHash = '') {
  return pool.query('DELETE FROM app.sessions WHERE user_id = $1 AND role = $2 AND token_hash <> $3', [userId, role, exceptTokenHash]);
}

async function loadSession(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const tokenHash = hashToken(token);
  const { rows } = await pool.query('SELECT user_id, role, expires_at, last_activity_write FROM app.sessions WHERE token_hash = $1', [tokenHash]);
  if (!rows.length) return null;
  return { tokenHash, userId: rows[0].user_id, role: rows[0].role, expiresAt: Number(rows[0].expires_at), lastActivityWrite: Number(rows[0].last_activity_write) };
}

async function authMiddleware(req, res, next) {
  const session = await loadSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  if (session.expiresAt < Date.now()) { await deleteSession(session.tokenHash); return res.status(401).json({ error: 'Session expired' }); }
  req.tokenHash = session.tokenHash;
  req.userId = session.userId;
  req.userRole = session.role || 'user';

  // Throttled "last active" tracking (also doubles as the freeze check, so a freeze takes
  // effect for an active session within ~1 minute rather than needing a fresh login).
  const now = Date.now();
  if (now - session.lastActivityWrite > ACTIVITY_WRITE_THROTTLE_MS) {
    // One round trip: claim the write slot (of several simultaneous requests only one wins), stamp
    // lastActiveAt, and read back the freeze date.
    const { rows } = await pool.query(`
      WITH s AS (UPDATE app.sessions SET last_activity_write = $2 WHERE token_hash = $1 AND last_activity_write = $3 RETURNING user_id)
      UPDATE app.users u SET data = u.data || jsonb_build_object('lastActiveAt', $4::text)
      FROM s WHERE u.id = s.user_id
      RETURNING u.data->>'frozenUntil' AS frozen_until`,
      [session.tokenHash, now, session.lastActivityWrite, new Date(now).toISOString()]);
    if (rows.length && isFrozen({ frozenUntil: rows[0].frozen_until })) {
      await deleteSession(session.tokenHash);
      return res.status(403).json({ error: 'Account frozen', frozenUntil: rows[0].frozen_until });
    }
  }

  next();
}

async function adminMiddleware(req, res, next) {
  const session = await loadSession(req);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  if (session.expiresAt < Date.now()) { await deleteSession(session.tokenHash); return res.status(403).json({ error: 'Session expired' }); }
  // sliding window: stays alive while actively used, expires 2h after the last request
  await pool.query('UPDATE app.sessions SET expires_at = $2 WHERE token_hash = $1', [session.tokenHash, Date.now() + ADMIN_SESSION_TTL_MS]);
  req.tokenHash = session.tokenHash;
  req.userId = session.userId;
  req.userRole = 'admin';
  next();
}

// Initialize default admin
async function initAdmin() {
  await tx(async c => {
    await c.query('LOCK TABLE app.admins IN EXCLUSIVE MODE');
    const { rows } = await c.query('SELECT 1 FROM app.admins LIMIT 1');
    if (rows.length) return;
    await db.insertDoc(c, 'admins', {
      id: generateId(),
      username: 'admin',
      password: await hashPassword('admin123'),
      createdAt: new Date().toISOString()
    });
  });
}

// Initialize default NFT stakes catalog
async function initStakes() {
  await tx(async c => {
    await c.query('LOCK TABLE app.nft_catalog IN EXCLUSIVE MODE');
    const { rows } = await c.query('SELECT 1 FROM app.nft_catalog LIMIT 1');
    if (rows.length) return;
    const stakes = [
      { id: 'nft1', name: 'Exclusive Stake1', collection: 'Stake', image: '/assets/images/nfts/stake-1.jpg', pledgeRange: '199 - 1000', dailyIncome: '1.5%', handlingFee: '1%', duration: 7, color: '#7C3AED', levelReq: 'LV1-LV8' },
      { id: 'nft2', name: 'Exclusive Stake2', collection: 'Stake', image: '/assets/images/nfts/stake-2.jpg', pledgeRange: '499 - 2000', dailyIncome: '1.8%', handlingFee: '1%', duration: 14, color: '#4F46E5', levelReq: 'LV2-LV8' },
      { id: 'nft3', name: 'Exclusive Stake3', collection: 'Stake', image: '/assets/images/nfts/stake-3.jpg', pledgeRange: '799 - 3000', dailyIncome: '2.1%', handlingFee: '1%', duration: 30, color: '#14B8A6', levelReq: 'LV2-LV8' },
      { id: 'nft4', name: 'Exclusive Stake4', collection: 'Stake', image: '/assets/images/nfts/stake-4.png', pledgeRange: '999 - 4000', dailyIncome: '2.5%', handlingFee: '1%', duration: 60, color: '#3B82F6', levelReq: 'LV2-LV8' },
      { id: 'nft5', name: 'Exclusive Stake5', collection: 'Stake', image: '/assets/images/nfts/stake-5.png', pledgeRange: '1499 - 5000', dailyIncome: '3.0%', handlingFee: '1%', duration: 90, color: '#EF4444', levelReq: 'LV2-LV5' },
      { id: 'nft6', name: 'Exclusive Stake6', collection: 'Stake', image: '/assets/images/nfts/stake-6.png', pledgeRange: '1999 - 6000', dailyIncome: '3.5%', handlingFee: '1%', duration: 90, color: '#F59E0B', levelReq: 'LV2-LV8' },
    ];
    for (const s of stakes) await db.insertDoc(c, 'nft_catalog', s);
  });
}

// ===================== AUTH ROUTES =====================

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, email, password, confirmPassword, referralCode, phoneCountryCode, phoneNumber } = req.body;
  if (!username || !email || !password || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, - or _ only' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!phoneCountryCode || !phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

  if (await db.findUserBy(pool, 'email', email)) return res.status(400).json({ error: 'Email already registered' });
  if (await db.findUserBy(pool, 'username_lower', username.toLowerCase())) return res.status(400).json({ error: 'Username is already taken' });

  let referredBy = null;
  if (referralCode) {
    const referrer = await db.findUserBy(pool, 'uid', referralCode);
    if (!referrer) return res.status(400).json({ error: 'Invalid referral code' });
    referredBy = referrer.id;
  }

  const code = generateVerificationCode();
  await db.ephSet(EPH_SIGNUP, email, {
    code,
    expiresAt: Date.now() + VERIFICATION_TTL_MS,
    passwordHash: await hashPassword(password),
    username,
    referredBy,
    phoneCountryCode,
    phoneNumber
  });

  try {
    await sendEmail(email, 'Verify your MetaLinkNFT account', verificationEmailHtml(code));
  } catch (e) {
    await db.ephDel(EPH_SIGNUP, email);
    return res.status(502).json({ error: 'Failed to send verification email. Please try again.' });
  }

  res.json({ message: 'Verification code sent to your email', email });
});

app.post('/api/auth/resend-code', authLimiter, async (req, res) => {
  const { email } = req.body;
  const pending = email && await db.ephGet(EPH_SIGNUP, email);
  if (!pending) return res.status(404).json({ error: 'No pending signup found for this email. Please register again.' });

  pending.code = generateVerificationCode();
  pending.expiresAt = Date.now() + VERIFICATION_TTL_MS;
  await db.ephSet(EPH_SIGNUP, email, pending);

  try {
    await sendEmail(email, 'Verify your MetaLinkNFT account', verificationEmailHtml(pending.code));
  } catch (e) {
    return res.status(502).json({ error: 'Failed to send verification email. Please try again.' });
  }

  res.json({ message: 'Verification code resent' });
});

app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

  const pending = await db.ephGet(EPH_SIGNUP, email);
  if (!pending) return res.status(400).json({ error: 'No pending signup found. Please register again.' });
  if (pending.expiresAt < Date.now()) {
    await db.ephDel(EPH_SIGNUP, email);
    return res.status(400).json({ error: 'Verification code expired. Please register again.' });
  }
  if (pending.code !== code) return res.status(400).json({ error: 'Invalid verification code' });

  const result = await tx(async c => {
    // Serializes account creation so two simultaneous signups can't claim the same email/username.
    await c.query('SELECT pg_advisory_xact_lock(424243)');
    if (await db.findUserBy(c, 'email', email)) return { error: 'Email already registered' };
    if (await db.findUserBy(c, 'username_lower', pending.username.toLowerCase())) return { error: 'Username is already taken. Please register again with a different one.' };

    const config = await getConfig(c);
    const signupBonus = config.signupBonus !== undefined ? parseFloat(config.signupBonus) : 10;

    const user = {
      id: generateId(),
      email,
      password: pending.passwordHash,
      secondPassword: pending.passwordHash,
      username: pending.username,
      uid: generateUID(),
      phoneCountryCode: pending.phoneCountryCode,
      phoneNumber: pending.phoneNumber,
      level: 0,
      points: 0,
      walletBalance: signupBonus,
      walletBalanceMLK: 0,
      walletAddress: { trc20: '', erc20: '' },
      walletAddressUpdatedAt: null,
      avatar: '',
      referralCode: null,
      referredBy: pending.referredBy,
      createdAt: new Date().toISOString(),
      totalIncome: 0,
      totalWithdrawn: 0,
      dailyIncome: { comprehensive: 0, reserve: 0, team: 0, activity: 0, finance: 0, earn: 0, ecology: 0, growth: 0, stake: 0 }
    };
    await db.insertUser(c, user);

    const tiers = ['A', 'B', 'C'];
    let currentReferrerId = user.referredBy;
    for (let i = 0; i < tiers.length && currentReferrerId; i++) {
      const entry = { userId: currentReferrerId, memberId: user.id, tier: tiers[i], joinedAt: new Date().toISOString() };
      await c.query('INSERT INTO app.teams (id, user_id, member_id, data) VALUES ($1, $2, $3, $4)', [db.newId(), entry.userId, entry.memberId, JSON.stringify(entry)]);
      const referrer = await db.getUser(c, currentReferrerId);
      currentReferrerId = referrer ? referrer.referredBy : null;
    }
    return { user };
  });

  await db.ephDel(EPH_SIGNUP, email);
  if (result.error) return res.status(400).json({ error: result.error });

  const user = result.user;
  sendEmail(user.email, 'Welcome to MetaLink NFT!', welcomeEmailHtml(user.username, user.uid)).catch(() => {});
  const token = await createSession(user.id, 'user');

  res.json({ token, user: { id: user.id, email: user.email, username: user.username, uid: user.uid, level: user.level, points: user.points } });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = await db.findUserBy(pool, 'email', email);
  if (!user || !(await verifyPassword(password, user.password))) {
    return res.status(401).json({ error: 'Account or password is incorrect' });
  }
  if (!isBcryptHash(user.password)) {
    await db.patchDoc(pool, 'users', user.id, { password: await hashPassword(password) });
  }

  if (isFrozen(user)) {
    return res.status(403).json({ error: 'Account frozen', frozenUntil: user.frozenUntil });
  }

  if (user.twoFactorEnabled) {
    const tempToken = crypto.randomBytes(32).toString('hex');
    await db.ephSet(EPH_LOGIN, tempToken, { userId: user.id, expiresAt: Date.now() + LOGIN_2FA_TTL_MS });
    return res.json({ requires2FA: true, tempToken });
  }

  const token = await createSession(user.id, 'user');

  res.json({
    token,
    user: { id: user.id, email: user.email, username: user.username, uid: user.uid, level: user.level, points: user.points, avatar: user.avatar }
  });
});

app.post('/api/auth/login/2fa', authLimiter, async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'Code is required' });

  const pending = await db.ephGet(EPH_LOGIN, tempToken);
  if (!pending) return res.status(400).json({ error: 'Login session expired. Please log in again.' });
  if (pending.expiresAt < Date.now()) {
    await db.ephDel(EPH_LOGIN, tempToken);
    return res.status(400).json({ error: 'Login session expired. Please log in again.' });
  }

  const user = await db.getUser(pool, pending.userId);
  if (!user || !user.twoFactorSecret) {
    await db.ephDel(EPH_LOGIN, tempToken);
    return res.status(400).json({ error: 'Login session invalid. Please log in again.' });
  }

  if (!(await isValidTotp(code, user.twoFactorSecret))) {
    return res.status(401).json({ error: 'Invalid authentication code' });
  }

  await db.ephDel(EPH_LOGIN, tempToken);
  const token = await createSession(user.id, 'user');

  res.json({
    token,
    user: { id: user.id, email: user.email, username: user.username, uid: user.uid, level: user.level, points: user.points, avatar: user.avatar }
  });
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = await db.findUserBy(pool, 'email', email);

  // Always respond the same way whether or not the account exists, so this endpoint can't be used to enumerate registered emails.
  if (user) {
    const code = generateVerificationCode();
    await db.ephSet(EPH_RESET, email, { code, expiresAt: Date.now() + VERIFICATION_TTL_MS });
    try {
      await sendEmail(email, 'Reset your MetaLinkNFT password', passwordResetEmailHtml(code));
    } catch (e) {
      await db.ephDel(EPH_RESET, email);
      return res.status(502).json({ error: 'Failed to send reset email. Please try again.' });
    }
  }

  res.json({ message: 'If that email is registered, a reset code has been sent.' });
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { email, code, password, confirmPassword } = req.body;
  if (!email || !code || !password || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const reset = await db.ephGet(EPH_RESET, email);
  if (!reset) return res.status(400).json({ error: 'No password reset requested for this email. Please request a new code.' });
  if (reset.expiresAt < Date.now()) {
    await db.ephDel(EPH_RESET, email);
    return res.status(400).json({ error: 'Reset code expired. Please request a new one.' });
  }
  if (reset.code !== code) return res.status(400).json({ error: 'Invalid reset code' });

  const user = await db.findUserBy(pool, 'email', email);
  if (!user) { await db.ephDel(EPH_RESET, email); return res.status(400).json({ error: 'Account not found' }); }

  await db.patchDoc(pool, 'users', user.id, { password: await hashPassword(password) });
  await db.ephDel(EPH_RESET, email);

  // Invalidate existing sessions so a token stolen before the reset stops working.
  await deleteSessionsFor(user.id, 'user');

  res.json({ message: 'Password reset successfully' });
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  await deleteSession(req.tokenHash);
  res.json({ message: 'Logged out' });
});

// ===================== USER ROUTES =====================

app.get('/api/user/profile', authMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicProfile(user));
});

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const AVATAR_RE = /^(\/uploads\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)|data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*)$/;

app.put('/api/user/profile', authMiddleware, async (req, res) => {
  const { username, avatar } = req.body;
  if (username && !USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, - or _ only' });
  if (avatar && !AVATAR_RE.test(avatar)) return res.status(400).json({ error: 'Invalid avatar format' });

  const user = await tx(async c => {
    const u = await db.getUser(c, req.userId, { lock: true });
    if (!u) return null;
    if (username) u.username = username;
    if (avatar) u.avatar = avatar;
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json(publicProfile(user));
});

app.post('/api/user/change-password', authLimiter, authMiddleware, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const user = await db.getUser(pool, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!(await verifyPassword(currentPassword, user.password))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  await db.patchDoc(pool, 'users', user.id, { password: await hashPassword(newPassword) });

  // Invalidate other sessions but keep this one alive so the user isn't logged out mid-flow.
  await deleteSessionsFor(req.userId, 'user', req.tokenHash);

  res.json({ message: 'Password changed successfully' });
});

app.post('/api/user/2fa/setup', authLimiter, authMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.twoFactorEnabled) return res.status(400).json({ error: 'Two-factor authentication is already enabled' });

  const secret = generateTotpSecret();
  await db.ephSet(EPH_2FA_SETUP, req.userId, { secret, expiresAt: Date.now() + VERIFICATION_TTL_MS });

  const otpauth = generateTotpURI({ issuer: 'MetaLinkNFT', label: user.email, secret });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

  res.json({ secret, qrCodeDataUrl });
});

app.post('/api/user/2fa/verify', authLimiter, authMiddleware, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  const pending = await db.ephGet(EPH_2FA_SETUP, req.userId);
  if (!pending) return res.status(400).json({ error: 'No pending 2FA setup found. Please start again.' });
  if (pending.expiresAt < Date.now()) {
    await db.ephDel(EPH_2FA_SETUP, req.userId);
    return res.status(400).json({ error: '2FA setup expired. Please start again.' });
  }
  if (!(await isValidTotp(code, pending.secret))) {
    return res.status(400).json({ error: 'Invalid code. Please check your authenticator app and try again.' });
  }

  if (!(await db.getUser(pool, req.userId))) return res.status(404).json({ error: 'User not found' });
  await db.patchDoc(pool, 'users', req.userId, { twoFactorEnabled: true, twoFactorSecret: pending.secret });
  await db.ephDel(EPH_2FA_SETUP, req.userId);

  res.json({ message: 'Two-factor authentication enabled successfully' });
});

app.post('/api/user/2fa/disable', authLimiter, authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });

  const user = await db.getUser(pool, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!(await verifyPassword(password, user.password))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  await db.patchDoc(pool, 'users', req.userId, { twoFactorEnabled: false, twoFactorSecret: null });
  await db.ephDel(EPH_2FA_SETUP, req.userId);

  res.json({ message: 'Two-factor authentication disabled' });
});

app.post('/api/admin/change-password', authLimiter, adminMiddleware, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const admin = await db.getDoc(pool, 'admins', req.userId);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });

  if (!(await verifyPassword(currentPassword, admin.password))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  await db.patchDoc(pool, 'admins', admin.id, { password: await hashPassword(newPassword) });
  await deleteSessionsFor(req.userId, 'admin', req.tokenHash);

  res.json({ message: 'Password changed successfully' });
});

app.put('/api/user/wallet', authMiddleware, async (req, res) => {
  const { trc20, bep20 } = req.body;

  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    const now = new Date();
    const lastUpdate = user.walletAddressUpdatedAt ? new Date(user.walletAddressUpdatedAt) : null;
    if (lastUpdate) {
      const hoursSince = (now - lastUpdate) / (1000 * 60 * 60);
      if (hoursSince < 48) {
        const remaining = 48 - hoursSince;
        const days = Math.floor(remaining / 24);
        const hours = Math.floor(remaining % 24);
        const mins = Math.floor((remaining * 60) % 60);
        return {
          status: 400,
          body: { error: `Withdrawal services will be suspended for ${days} days ${hours} hours ${mins} min after changing wallet address.`, cooldown: true }
        };
      }
    }

    if (trc20 !== undefined) user.walletAddress.trc20 = trc20;
    if (bep20 !== undefined) user.walletAddress.bep20 = bep20;
    // Keep erc20 field in sync with bep20 for withdrawal compatibility
    if (bep20 !== undefined) user.walletAddress.erc20 = bep20;
    user.walletAddressUpdatedAt = now.toISOString();
    await db.saveUser(c, user);

    // Log wallet submission for admin review
    await db.insertDoc(c, 'wallet_submissions', {
      id: generateId(),
      userId: user.id,
      email: user.email,
      username: user.username,
      uid: user.uid,
      trc20: user.walletAddress.trc20 || '',
      bep20: user.walletAddress.bep20 || user.walletAddress.erc20 || '',
      submittedAt: now.toISOString()
    });

    return { status: 200, body: { message: 'Wallet address updated', walletAddress: { trc20: user.walletAddress.trc20, bep20: user.walletAddress.bep20 || user.walletAddress.erc20 } } };
  });

  res.status(result.status).json(result.body);
});

app.get('/api/user/team', authMiddleware, async (req, res) => {
  // A member only counts as "valid" once they've made at least one approved deposit —
  // wallet balance alone isn't a reliable signal since every account starts with a signup bonus.
  const { rows } = await pool.query(`
    SELECT t.member_id, t.data->>'tier' AS tier, t.data->'joinedAt' AS joined_at, u.data->>'username' AS username,
           EXISTS (SELECT 1 FROM app.deposits d WHERE d.user_id = t.member_id AND d.data->>'status' = 'Approved') AS is_valid
    FROM app.teams t LEFT JOIN app.users u ON u.id = t.member_id
    WHERE t.user_id = $1
    ORDER BY t.seq`, [req.userId]);

  const members = rows.map(r => ({
    id: r.member_id,
    username: r.username || 'Unknown',
    tier: r.tier,
    joinedAt: r.joined_at,
    isValid: r.is_valid
  }));

  const stats = {
    totalRegistered: members.length,
    totalValid: members.filter(m => m.isValid).length,
    aTier: { registered: members.filter(m => m.tier === 'A').length, valid: members.filter(m => m.tier === 'A' && m.isValid).length },
    bTier: { registered: members.filter(m => m.tier === 'B').length, valid: members.filter(m => m.tier === 'B' && m.isValid).length },
    cTier: { registered: members.filter(m => m.tier === 'C').length, valid: members.filter(m => m.tier === 'C' && m.isValid).length },
  };

  res.json({ members, stats });
});

// ===================== STAKE ROUTES =====================

app.get('/api/stakes/catalog', authMiddleware, async (req, res) => {
  res.json(await db.listDocs(pool, 'nft_catalog'));
});

app.get('/api/stakes/my', authMiddleware, async (req, res) => {
  res.json(await db.listDocs(pool, 'user_stakes', { userId: req.userId }));
});

app.post('/api/stakes', authMiddleware, async (req, res) => {
  const { nftId, amount } = req.body;
  const nft = await db.getDoc(pool, 'nft_catalog', nftId);
  if (!nft) return res.status(404).json({ error: 'NFT not found' });

  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    const [min, max] = nft.pledgeRange.split(' - ').map(Number);
    if (amount < min || amount > max) return { status: 400, body: { error: `Amount must be between ${min} and ${max} USDT` } };

    const feeEnabled = (await getConfig(c)).handlingFeeEnabled === true;
    const feePct = feeEnabled ? parseFloat(nft.handlingFee) / 100 : 0;
    const fee = parseFloat((amount * feePct).toFixed(5));
    const totalCharge = amount + fee;
    if (user.walletBalance < totalCharge) return { status: 400, body: { error: `Insufficient balance. You need ${totalCharge} USDT (${amount} + ${fee} handling fee)` } };

    user.walletBalance -= totalCharge;
    await db.saveUser(c, user);

    const dailyRate = parseFloat(nft.dailyIncome) / 100;
    const expectedTotal = amount * dailyRate * nft.duration;

    const stake = {
      id: generateId(),
      userId: req.userId,
      nftId: nft.id,
      nftName: nft.name,
      nftNumber: '#' + Math.floor(Math.random() * 9999),
      collection: nft.collection,
      color: nft.color,
      pledgeValue: amount,
      handlingFee: fee,
      dailyIncome: nft.dailyIncome,
      duration: nft.duration,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + nft.duration * 24 * 60 * 60 * 1000).toISOString(),
      income: 0,
      expectedTotal,
      status: 'active',
      claimed: false
    };
    await db.insertDoc(c, 'user_stakes', stake);
    return { status: 200, body: stake };
  });

  res.status(result.status).json(result.body);
});

app.post('/api/stakes/:id/claim', authMiddleware, async (req, res) => {
  const emails = [];
  const result = await tx(async c => {
    // Lock the user before the stake (same order as every other balance change) to avoid deadlocks.
    const user = await db.getUser(c, req.userId, { lock: true });
    const stake = await db.getDoc(c, 'user_stakes', req.params.id, { lock: true });
    if (!user || !stake || stake.userId !== req.userId) return { status: 404, body: { error: 'Stake not found' } };
    if (stake.claimed) return { status: 400, body: { error: 'Already claimed' } };

    const now = new Date();
    const start = new Date(stake.startDate);
    const daysElapsed = Math.min((now - start) / (1000 * 60 * 60 * 24), stake.duration);
    const dailyRate = parseFloat(stake.dailyIncome) / 100;
    const income = stake.pledgeValue * dailyRate * daysElapsed;

    stake.income = parseFloat(income.toFixed(5));
    stake.claimed = true;
    stake.status = 'completed';
    await db.saveDoc(c, 'user_stakes', stake);

    user.walletBalance += stake.pledgeValue + income;
    user.totalIncome += income;
    user.dailyIncome.stake += income;
    checkAndApplyLevelUpgrade(user, await getConfig(c), emails);
    await db.saveUser(c, user);

    return { status: 200, body: { message: 'Claimed successfully', income: parseFloat(income.toFixed(5)) } };
  });

  sendQueuedEmails(emails);
  res.status(result.status).json(result.body);
});

// ===================== EARN ROUTES =====================

const EARN_PLANS = [
  { id: 'earn-growth-1', category: 'growth', categoryLabel: 'Growth Finance', name: 'GrowthStarter', amount: 100, dailyRatePct: 2.0, days: 30, icon: '📈', color: '#7C3AED' },
  { id: 'earn-growth-2', category: 'growth', categoryLabel: 'Growth Finance', name: 'GrowthPro', amount: 500, dailyRatePct: 2.5, days: 60, icon: '📈', color: '#7C3AED' },
  { id: 'earn-growth-3', category: 'growth', categoryLabel: 'Growth Finance', name: 'GrowthElite', amount: 2000, dailyRatePct: 3.0, days: 90, icon: '📈', color: '#7C3AED' },
  { id: 'earn-comp-1', category: 'comprehensive', categoryLabel: 'Comprehensive Finance', name: 'CompStarter', amount: 100, dailyRatePct: 2.2, days: 30, icon: '💎', color: '#4F46E5' },
  { id: 'earn-comp-2', category: 'comprehensive', categoryLabel: 'Comprehensive Finance', name: 'CompPro', amount: 500, dailyRatePct: 2.6, days: 60, icon: '💎', color: '#4F46E5' },
  { id: 'earn-comp-3', category: 'comprehensive', categoryLabel: 'Comprehensive Finance', name: 'CompElite', amount: 2000, dailyRatePct: 3.2, days: 90, icon: '💎', color: '#4F46E5' },
  { id: 'earn-eco-1', category: 'ecology', categoryLabel: 'Ecology Finance', name: 'EcoStarter', amount: 100, dailyRatePct: 1.8, days: 30, icon: '🌿', color: '#14B8A6' },
  { id: 'earn-eco-2', category: 'ecology', categoryLabel: 'Ecology Finance', name: 'EcoPro', amount: 500, dailyRatePct: 2.2, days: 60, icon: '🌿', color: '#14B8A6' },
  { id: 'earn-eco-3', category: 'ecology', categoryLabel: 'Ecology Finance', name: 'EcoElite', amount: 2000, dailyRatePct: 2.8, days: 90, icon: '🌿', color: '#14B8A6' },
  { id: 'earn-usdt-1', category: 'finance', categoryLabel: 'USDT Finance', name: 'USDTStarter', amount: 100, dailyRatePct: 1.5, days: 30, icon: '💵', color: '#F59E0B' },
  { id: 'earn-usdt-2', category: 'finance', categoryLabel: 'USDT Finance', name: 'USDTPro', amount: 500, dailyRatePct: 1.9, days: 60, icon: '💵', color: '#F59E0B' },
  { id: 'earn-usdt-3', category: 'finance', categoryLabel: 'USDT Finance', name: 'USDTElite', amount: 2000, dailyRatePct: 2.4, days: 90, icon: '💵', color: '#F59E0B' }
];

app.get('/api/earn/plans', authMiddleware, (req, res) => {
  res.json(EARN_PLANS);
});

app.get('/api/earn/my', authMiddleware, async (req, res) => {
  res.json(await db.listDocs(pool, 'earn_positions', { userId: req.userId }));
});

app.post('/api/earn', authMiddleware, async (req, res) => {
  const { planId } = req.body;
  const plan = EARN_PLANS.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };
    if (user.walletBalance < plan.amount) return { status: 400, body: { error: 'Insufficient balance' } };

    user.walletBalance -= plan.amount;
    await db.saveUser(c, user);

    const expectedTotal = plan.amount * (plan.dailyRatePct / 100) * plan.days;
    const position = {
      id: generateId(),
      userId: req.userId,
      planId: plan.id,
      planName: plan.name,
      category: plan.category,
      categoryLabel: plan.categoryLabel,
      color: plan.color,
      icon: plan.icon,
      amount: plan.amount,
      dailyRatePct: plan.dailyRatePct,
      days: plan.days,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000).toISOString(),
      income: 0,
      expectedTotal,
      status: 'active',
      claimed: false
    };
    await db.insertDoc(c, 'earn_positions', position);
    return { status: 200, body: position };
  });

  res.status(result.status).json(result.body);
});

app.post('/api/earn/:id/claim', authMiddleware, async (req, res) => {
  const emails = [];
  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    const position = await db.getDoc(c, 'earn_positions', req.params.id, { lock: true });
    if (!user || !position || position.userId !== req.userId) return { status: 404, body: { error: 'Position not found' } };
    if (position.claimed) return { status: 400, body: { error: 'Already claimed' } };

    const now = new Date();
    const start = new Date(position.startDate);
    const daysElapsed = Math.min((now - start) / (1000 * 60 * 60 * 24), position.days);
    const income = position.amount * (position.dailyRatePct / 100) * daysElapsed;

    position.income = parseFloat(income.toFixed(5));
    position.claimed = true;
    position.status = 'completed';
    await db.saveDoc(c, 'earn_positions', position);

    user.walletBalance += position.amount + income;
    user.totalIncome += income;
    const cat = position.category;
    if (user.dailyIncome[cat] !== undefined) user.dailyIncome[cat] += income;
    checkAndApplyLevelUpgrade(user, await getConfig(c), emails);
    await db.saveUser(c, user);

    return { status: 200, body: { message: 'Claimed successfully', income: parseFloat(income.toFixed(5)) } };
  });

  sendQueuedEmails(emails);
  res.status(result.status).json(result.body);
});

// ===================== RESERVE ROUTES =====================

const RESERVE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getNextReservationAt(myOrders) {
  if (!myOrders.length) return null;
  const lastOrder = myOrders.reduce((latest, o) => new Date(o.reservationDate) > new Date(latest.reservationDate) ? o : latest);
  const nextAt = new Date(lastOrder.reservationDate).getTime() + RESERVE_COOLDOWN_MS;
  return nextAt > Date.now() ? new Date(nextAt).toISOString() : null;
}

const RESERVE_LEVELS = [
  { level: 1, min: 50, max: 499, rewardPct: 2.5, name: 'Blue Cap Ape', image: '/assets/images/nfts/blue-cap-ape.jpg' },
  { level: 2, min: 500, max: 1999, rewardPct: 3.0, name: 'Purple Hat Ape', image: '/assets/images/nfts/purple-hat-ape.jpg' },
  { level: 3, min: 2000, max: 4999, rewardPct: 3.5, name: 'Cartoon Ape', image: '/assets/images/nfts/cartoon-ape.jpg' },
  { level: 4, min: 5000, max: 9999, rewardPct: 4.0, name: 'Steampunk Rat', image: '/assets/images/nfts/steampunk-rat.jpg' },
  { level: 5, min: 10000, max: 49999, rewardPct: 4.5, name: 'Collector Edition I', image: '/assets/images/nfts/col1.jpg' },
  { level: 6, min: 50000, max: 100000, rewardPct: 5.0, name: 'Collector Edition II', image: '/assets/images/nfts/col2.jpg' }
];

app.get('/api/reserve/orders', authMiddleware, async (req, res) => {
  const myOrders = await db.listDocs(pool, 'reserve_orders', { userId: req.userId });
  const user = await db.getUser(pool, req.userId);

  const todayEarnings = myOrders
    .filter(o => o.status === 'Won' && new Date(o.reservationDate).toDateString() === new Date().toDateString())
    .reduce((sum, o) => sum + (o.reward || 0), 0);
  const cumulativeIncome = myOrders
    .filter(o => o.status === 'Won')
    .reduce((sum, o) => sum + (o.reward || 0), 0);

  res.json({
    todayEarnings,
    cumulativeIncome,
    teamBenefits: user?.dailyIncome?.team || 0,
    reservationRange: `${RESERVE_LEVELS[0].min} - ${RESERVE_LEVELS[RESERVE_LEVELS.length - 1].max}`,
    walletBalance: user?.walletBalance || 0,
    balanceForReservation: Math.min(user?.walletBalance || 0, RESERVE_LEVELS[RESERVE_LEVELS.length - 1].max),
    nextReservationAt: getNextReservationAt(myOrders),
    levels: RESERVE_LEVELS,
    orders: myOrders
  });
});

app.post('/api/reserve/orders', authMiddleware, async (req, res) => {
  const emails = [];
  const result = await tx(async c => {
    // Locking the user first also serializes the 24h cooldown check, so a double-click can't reserve twice.
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    const existingOrders = await db.listDocs(c, 'reserve_orders', { userId: req.userId });
    const nextReservationAt = getNextReservationAt(existingOrders);
    if (nextReservationAt) return { status: 400, body: { error: 'You can only reserve once every 24 hours', nextReservationAt } };

    const balance = user.walletBalance;
    const affordableLevels = RESERVE_LEVELS.filter(lv => lv.min <= balance);
    if (!affordableLevels.length) return { status: 400, body: { error: `Insufficient balance. Minimum reservation is ${RESERVE_LEVELS[0].min} USDT` } };

    const level = affordableLevels[Math.floor(Math.random() * affordableLevels.length)];
    const maxAmount = Math.min(level.max, balance);
    const amount = parseFloat((level.min + Math.random() * (maxAmount - level.min)).toFixed(2));

    user.walletBalance -= amount;

    const cfg = await getConfig(c);
    const winRatePct = cfg.reserveWinRatePct !== undefined ? parseFloat(cfg.reserveWinRatePct) : 70;
    const won = Math.random() * 100 < winRatePct;
    const reward = won ? amount * (level.rewardPct / 100) : 0;

    const order = {
      id: generateId(),
      userId: req.userId,
      orderNumber: generateOrderNumber(),
      reservationDate: new Date().toISOString(),
      reservationAmount: amount,
      level: level.level,
      rewardPct: level.rewardPct,
      itemName: level.name,
      itemImage: level.image,
      itemPrice: amount,
      estimatedMin: level.min,
      estimatedMax: level.max,
      status: won ? 'Won' : 'Not Won',
      reward: parseFloat(reward.toFixed(2))
    };
    await db.insertDoc(c, 'reserve_orders', order);

    if (won) {
      user.walletBalance += amount + reward;
      user.totalIncome += reward;
      user.dailyIncome.reserve += reward;
    } else {
      user.walletBalance += amount;
    }
    checkAndApplyLevelUpgrade(user, cfg, emails);
    await db.saveUser(c, user);

    return { status: 200, body: order };
  });

  sendQueuedEmails(emails);
  res.status(result.status).json(result.body);
});

// ===================== ASSETS / WALLET ROUTES =====================

app.get('/api/assets', authMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const withdrawals = await db.listDocs(pool, 'withdrawals', { userId: req.userId });
  const deposits = await db.listDocs(pool, 'deposits', { userId: req.userId });

  const totalWithdrawn = withdrawals.filter(w => w.status === 'Approved').reduce((s, w) => s + w.amount, 0);
  const notWithdrawn = user.totalIncome - totalWithdrawn;

  const history = [
    ...withdrawals.map(w => ({ type: 'Withdraw', amount: -w.amount, date: w.createdAt, status: w.status === 'Approved' ? 'Deposited' : w.status === 'Rejected' ? 'Rejected' : 'Processing' })),
    ...deposits.map(d => ({ type: 'Deposit', amount: d.amount, date: d.createdAt, status: d.status === 'Approved' ? 'Deposited' : 'Processing' })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  res.json({
    balance: user.walletBalance,
    totalRevenue: user.totalIncome,
    totalWithdrawn,
    notWithdrawn: Math.max(0, notWithdrawn),
    history
  });
});

// ===================== WITHDRAWAL ROUTES =====================

app.post('/api/withdrawals', authMiddleware, async (req, res) => {
  const { amount, walletType } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    if (user.walletBalance < amount) return { status: 400, body: { error: 'Insufficient balance' } };

    const walletAddr = (walletType === 'bep20' || walletType === 'erc20') ? (user.walletAddress.bep20 || user.walletAddress.erc20) : user.walletAddress.trc20;
    if (!walletAddr) return { status: 400, body: { error: 'Please set your wallet address first' } };

    if (user.walletAddressUpdatedAt) {
      const hoursSince = (new Date() - new Date(user.walletAddressUpdatedAt)) / (1000 * 60 * 60);
      if (hoursSince < 48) {
        const remaining = 48 - hoursSince;
        const days = Math.floor(remaining / 24);
        const hours = Math.floor(remaining % 24);
        const mins = Math.floor((remaining * 60) % 60);
        return {
          status: 400,
          body: { error: `Withdrawal Failed. Due to a change in wallet settings, withdrawal services will be suspended for ${days} days ${hours} hours ${mins} min ${Math.floor((remaining * 3600) % 60)} s to protect your account.` }
        };
      }
    }

    const cfg = await getConfig(c);
    const withdrawalFeePct = cfg.withdrawalFeePct !== undefined ? parseFloat(cfg.withdrawalFeePct) : 4;
    const fee = parseFloat((amount * withdrawalFeePct / 100).toFixed(2));
    const tax = 0;
    const netAmount = parseFloat((amount - fee - tax).toFixed(2));

    user.walletBalance -= amount;
    user.totalWithdrawn += amount;
    await db.saveUser(c, user);

    const withdrawal = {
      id: generateId(),
      userId: req.userId,
      email: user.email,
      username: user.username,
      uid: user.uid,
      amount,
      fee,
      tax,
      netAmount,
      walletType: walletType || 'trc20',
      walletAddress: walletAddr,
      status: 'Pending',
      createdAt: new Date().toISOString()
    };
    await db.insertDoc(c, 'withdrawals', withdrawal);
    return { status: 200, body: withdrawal };
  });

  res.status(result.status).json(result.body);
});

app.get('/api/withdrawals', authMiddleware, async (req, res) => {
  res.json(await db.listDocs(pool, 'withdrawals', { userId: req.userId }));
});

// ===================== DEPOSIT ROUTES =====================

app.post('/api/deposits', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const config = await getConfig();
  const minDeposit = config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50;
  if (amount < minDeposit) return res.status(400).json({ error: `Minimum deposit is $${minDeposit}` });

  const deposit = {
    id: generateId(),
    userId: req.userId,
    amount: parseFloat(amount),
    status: 'Pending',
    createdAt: new Date().toISOString()
  };
  await db.insertDoc(pool, 'deposits', deposit);

  res.json(deposit);
});

// ===================== ANNOUNCEMENT ROUTES =====================

app.get('/api/announcements', async (req, res) => {
  const announcements = await db.listDocs(pool, 'announcements');
  res.json(announcements.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.get('/api/announcements/:id', async (req, res) => {
  const ann = await db.getDoc(pool, 'announcements', req.params.id);
  if (!ann) return res.status(404).json({ error: 'Announcement not found' });
  res.json(ann);
});

// ===================== ADMIN ROUTES =====================

app.post('/api/admin/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query("SELECT data FROM app.admins WHERE data->>'username' = $1 ORDER BY seq LIMIT 1", [username]);
  const admin = rows.length ? rows[0].data : null;
  if (!admin || !(await verifyPassword(password, admin.password))) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  if (!isBcryptHash(admin.password)) {
    await db.patchDoc(pool, 'admins', admin.id, { password: await hashPassword(password) });
  }

  const token = await createSession(admin.id, 'admin');
  res.json({ token, admin: { id: admin.id, username: admin.username } });
});

app.post('/api/admin/logout', adminMiddleware, async (req, res) => {
  await deleteSession(req.tokenHash);
  res.json({ message: 'Logged out' });
});

app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const num = field => `CASE WHEN jsonb_typeof(data->'${field}') = 'number' THEN (data->>'${field}')::float8 ELSE 0 END`;
  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM app.users) AS total_users,
    (SELECT coalesce(sum(${num('amount')}), 0) FROM app.deposits) AS total_deposits,
    (SELECT coalesce(sum(${num('amount')}), 0) FROM app.withdrawals WHERE data->>'status' = 'Approved') AS total_withdrawals,
    (SELECT count(*) FROM app.withdrawals WHERE data->>'status' = 'Pending') AS pending_withdrawals,
    (SELECT count(*) FROM app.user_stakes WHERE data->>'status' = 'active') AS active_stakes,
    (SELECT coalesce(sum(${num('pledgeValue')}), 0) FROM app.user_stakes WHERE data->>'status' = 'active') AS total_stake_value`);
  const r = rows[0];

  res.json({
    totalUsers: Number(r.total_users),
    totalDeposits: Number(r.total_deposits),
    totalWithdrawals: Number(r.total_withdrawals),
    pendingWithdrawals: Number(r.pending_withdrawals),
    activeStakes: Number(r.active_stakes),
    totalStakeValue: Number(r.total_stake_value)
  });
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  const users = (await db.listDocs(pool, 'users')).map(u => {
    const online = !!u.lastActiveAt && (Date.now() - new Date(u.lastActiveAt).getTime()) < ONLINE_THRESHOLD_MS;
    return { ...publicProfile(u), online };
  });
  res.json(users);
});

app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const { walletBalance, level, points, username, frozenUntil } = req.body;

  const result = await tx(async c => {
    const user = await db.getUser(c, req.params.id, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    if (walletBalance !== undefined) user.walletBalance = parseFloat(walletBalance);
    if (level !== undefined) user.level = parseInt(level);
    if (points !== undefined) user.points = parseFloat(points);
    if (username !== undefined) user.username = username;
    if (frozenUntil !== undefined) {
      if (frozenUntil === null || frozenUntil === '') {
        user.frozenUntil = null;
      } else {
        const d = new Date(frozenUntil);
        if (isNaN(d.getTime())) return { status: 400, body: { error: 'Invalid freeze date' } };
        user.frozenUntil = d.toISOString();
      }
    }
    await db.saveUser(c, user);
    return { status: 200, body: publicProfile(user) };
  });

  res.status(result.status).json(result.body);
});

app.put('/api/admin/users/:id/wallet', adminMiddleware, async (req, res) => {
  const { trc20, erc20 } = req.body;

  const user = await tx(async c => {
    const u = await db.getUser(c, req.params.id, { lock: true });
    if (!u) return null;
    if (trc20 !== undefined) u.walletAddress.trc20 = trc20;
    if (erc20 !== undefined) u.walletAddress.erc20 = erc20;
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({ message: 'Wallet updated', walletAddress: user.walletAddress });
});

app.put('/api/admin/users/:id/balance', adminMiddleware, async (req, res) => {
  const { amount, action } = req.body;
  const emails = [];

  const user = await tx(async c => {
    const u = await db.getUser(c, req.params.id, { lock: true });
    if (!u) return null;

    if (action === 'add') {
      u.walletBalance += parseFloat(amount);
      await db.insertDoc(c, 'deposits', {
        id: generateId(),
        userId: u.id,
        amount: parseFloat(amount),
        status: 'Approved',
        approvedBy: 'admin',
        createdAt: new Date().toISOString()
      });
    } else if (action === 'subtract') {
      u.walletBalance = Math.max(0, u.walletBalance - parseFloat(amount));
    } else if (action === 'set') {
      u.walletBalance = parseFloat(amount);
    }
    checkAndApplyLevelUpgrade(u, await getConfig(c), emails);
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  sendQueuedEmails(emails);
  res.json(publicProfile(user));
});

app.get('/api/admin/withdrawals', adminMiddleware, async (req, res) => {
  const withdrawals = await db.listDocs(pool, 'withdrawals');
  res.json(withdrawals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.put('/api/admin/withdrawals/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;

  const withdrawal = await tx(async c => {
    const w = await db.getDoc(c, 'withdrawals', req.params.id, { lock: true });
    if (!w) return null;

    const previousStatus = w.status;
    w.status = status;
    w.processedAt = new Date().toISOString();

    // Only refund on the transition into Rejected, so rejecting twice can't refund twice.
    if (status === 'Rejected' && previousStatus !== 'Rejected') {
      const user = await db.getUser(c, w.userId, { lock: true });
      if (user) {
        user.walletBalance += w.amount;
        user.totalWithdrawn -= w.amount;
        await db.saveUser(c, user);
      }
    }

    return db.saveDoc(c, 'withdrawals', w);
  });
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

  if (status === 'Approved' || status === 'Rejected') {
    sendEmail(
      withdrawal.email,
      status === 'Approved' ? 'Your withdrawal has been processed' : 'Your withdrawal request was not approved',
      withdrawalStatusEmailHtml(withdrawal.username, withdrawal.amount, withdrawal.netAmount, status)
    ).catch(() => {});
  }

  res.json(withdrawal);
});

app.get('/api/admin/deposits', adminMiddleware, async (req, res) => {
  const deposits = await db.listDocs(pool, 'deposits');
  res.json(deposits.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.put('/api/admin/deposits/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const emails = [];

  const deposit = await tx(async c => {
    const d = await db.getDoc(c, 'deposits', req.params.id, { lock: true });
    if (!d) return null;

    const previousStatus = d.status;
    d.status = status;
    d.processedAt = new Date().toISOString();

    // Only credit on the transition into Approved, so approving twice can't credit twice.
    if (status === 'Approved' && previousStatus !== 'Approved') {
      const user = await db.getUser(c, d.userId, { lock: true });
      if (user) {
        const cfg = await getConfig(c);
        user.walletBalance += d.amount;
        checkAndApplyLevelUpgrade(user, cfg, emails);
        emails.push([user.email, 'Your deposit has been confirmed', depositConfirmedEmailHtml(user.username, d.amount, user.walletBalance)]);
        await db.saveUser(c, user);

        if (!d.referralPaid) {
          const tiers = [
            { tier: 'A', pct: cfg.referralBonusPct !== undefined ? parseFloat(cfg.referralBonusPct) : 15 },
            { tier: 'B', pct: cfg.referralBonusPctB !== undefined ? parseFloat(cfg.referralBonusPctB) : 8 },
            { tier: 'C', pct: cfg.referralBonusPctC !== undefined ? parseFloat(cfg.referralBonusPctC) : 3 }
          ];
          const payouts = [];
          let currentReferrerId = user.referredBy;
          for (let i = 0; i < tiers.length && currentReferrerId; i++) {
            const referrer = await db.getUser(c, currentReferrerId, { lock: true });
            if (!referrer) break;
            const bonus = parseFloat((d.amount * tiers[i].pct / 100).toFixed(2));
            referrer.walletBalance += bonus;
            referrer.totalIncome += bonus;
            referrer.dailyIncome.team += bonus;
            checkAndApplyLevelUpgrade(referrer, cfg, emails);
            await db.saveUser(c, referrer);
            payouts.push({ userId: currentReferrerId, tier: tiers[i].tier, pct: tiers[i].pct, bonus });
            currentReferrerId = referrer.referredBy;
          }
          d.referralPaid = true;
          d.referralPayouts = payouts;
        }
      }
    }

    return db.saveDoc(c, 'deposits', d);
  });
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

  sendQueuedEmails(emails);
  res.json(deposit);
});

app.post('/api/admin/announcements', adminMiddleware, async (req, res) => {
  const { title, date, category, content, image } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  const announcement = {
    id: generateId(),
    title,
    date: date || new Date().toISOString().split('T')[0],
    category: category || 'Announcement',
    content,
    image: image || '',
    createdAt: new Date().toISOString()
  };
  await db.insertDoc(pool, 'announcements', announcement);
  res.json(announcement);
});

app.put('/api/admin/announcements/:id', adminMiddleware, async (req, res) => {
  const { title, date, category, content, image } = req.body;

  const announcement = await tx(async c => {
    const a = await db.getDoc(c, 'announcements', req.params.id, { lock: true });
    if (!a) return null;
    if (title) a.title = title;
    if (date) a.date = date;
    if (category) a.category = category;
    if (content) a.content = content;
    if (image !== undefined) a.image = image;
    a.updatedAt = new Date().toISOString();
    return db.saveDoc(c, 'announcements', a);
  });
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

  res.json(announcement);
});

app.delete('/api/admin/announcements/:id', adminMiddleware, async (req, res) => {
  await db.deleteDoc(pool, 'announcements', req.params.id);
  res.json({ message: 'Deleted' });
});

app.get('/api/admin/announcements', adminMiddleware, async (req, res) => {
  const announcements = await db.listDocs(pool, 'announcements');
  res.json(announcements.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// ===================== ADMIN WALLET SUBMISSIONS =====================

app.get('/api/admin/wallet-submissions', adminMiddleware, async (req, res) => {
  const submissions = await db.listDocs(pool, 'wallet_submissions');
  res.json(submissions.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)));
});

app.delete('/api/admin/wallet-submissions/:id', adminMiddleware, async (req, res) => {
  await db.deleteDoc(pool, 'wallet_submissions', req.params.id);
  res.json({ message: 'Deleted' });
});

// Admin upload image (base64). Stored in Postgres so uploads survive redeploys and are shared by every server process.
app.post('/api/admin/upload', adminMiddleware, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided' });

  const matches = image.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) return res.status(400).json({ error: 'Invalid image format' });

  const allowedExt = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const ext = matches[1].toLowerCase();
  if (!allowedExt.includes(ext)) return res.status(400).json({ error: 'Unsupported image type' });
  const data = matches[2];
  // Filename is always server-generated — never derived from client input — to prevent path traversal.
  const fname = generateId() + '.' + ext;

  await pool.query('INSERT INTO app.uploads (name, content_type, bytes) VALUES ($1, $2, $3)', [fname, 'image/' + (ext === 'jpg' ? 'jpeg' : ext), Buffer.from(data, 'base64')]);
  res.json({ url: '/uploads/' + fname });
});

// ===================== PLATFORM CONFIG ROUTES =====================

app.get('/api/platform/deposit-addresses', async (req, res) => {
  const config = await getConfig();
  res.json({
    trc20: config.depositAddressTrc20 || '',
    bep20: config.depositAddressBep20 || ''
  });
});

app.get('/api/platform/info', async (req, res) => {
  const config = await getConfig();
  res.json({
    signupBonus: config.signupBonus !== undefined ? config.signupBonus : 10,
    minDeposit: config.minDeposit !== undefined ? config.minDeposit : 50,
    referralBonusPct: config.referralBonusPct !== undefined ? config.referralBonusPct : 15,
    referralBonusPctB: config.referralBonusPctB !== undefined ? config.referralBonusPctB : 8,
    referralBonusPctC: config.referralBonusPctC !== undefined ? config.referralBonusPctC : 3,
    withdrawalFeePct: config.withdrawalFeePct !== undefined ? config.withdrawalFeePct : 4,
    handlingFeeEnabled: config.handlingFeeEnabled === true
  });
});

app.get('/api/admin/platform-config', adminMiddleware, async (req, res) => {
  res.json(await getConfig());
});

app.put('/api/admin/platform-config', adminMiddleware, async (req, res) => {
  const { depositAddressTrc20, depositAddressBep20, signupBonus, minDeposit, referralBonusPct, referralBonusPctB, referralBonusPctC, withdrawalFeePct, reserveWinRatePct, handlingFeeEnabled } = req.body;

  const result = await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(424244)');
    const config = await getConfig(c);
    if (depositAddressTrc20 !== undefined) config.depositAddressTrc20 = depositAddressTrc20;
    if (depositAddressBep20 !== undefined) config.depositAddressBep20 = depositAddressBep20;
    if (signupBonus !== undefined) config.signupBonus = parseFloat(signupBonus);
    if (minDeposit !== undefined) config.minDeposit = parseFloat(minDeposit);
    if (referralBonusPct !== undefined) config.referralBonusPct = parseFloat(referralBonusPct);
    if (referralBonusPctB !== undefined) config.referralBonusPctB = parseFloat(referralBonusPctB);
    if (referralBonusPctC !== undefined) config.referralBonusPctC = parseFloat(referralBonusPctC);
    if (withdrawalFeePct !== undefined) config.withdrawalFeePct = parseFloat(withdrawalFeePct);
    if (handlingFeeEnabled !== undefined) config.handlingFeeEnabled = handlingFeeEnabled === true || handlingFeeEnabled === 'true';
    if (reserveWinRatePct !== undefined) {
      const rate = parseFloat(reserveWinRatePct);
      if (isNaN(rate) || rate < 0 || rate > 100) return { status: 400, body: { error: 'Reservation win rate must be between 0 and 100' } };
      config.reserveWinRatePct = rate;
    }
    for (let lv = 1; lv <= 6; lv++) {
      const key = 'levelThreshold' + lv;
      if (req.body[key] !== undefined) {
        const val = parseFloat(req.body[key]);
        if (isNaN(val) || val < 0) return { status: 400, body: { error: `Level ${lv} threshold must be a non-negative number` } };
        config[key] = val;
      }
    }
    await db.setSetting(c, 'platform_config', config);
    return { status: 200, body: config };
  });

  res.status(result.status).json(result.body);
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// SPA catch-all
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Express 5 forwards errors from async handlers here (e.g. the database being briefly unreachable).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : (err.expose ? err.message : 'Bad request') });
});

function listen() {
  app.listen(PORT, HOST, () => {
    const nets = os.networkInterfaces();
    let localIP = 'unknown';
    for (const iface of Object.values(nets)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          localIP = addr.address;
          break;
        }
      }
      if (localIP !== 'unknown') break;
    }
    if (cluster.isWorker && cluster.worker.id !== 1) return;
    console.log(`MetaLinkNFT server running (${WORKERS} process${WORKERS > 1 ? 'es' : ''}):`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${localIP}:${PORT}`);
    console.log(`  Admin:   http://localhost:${PORT}/admin`);
  });
}

async function startServer() {
  if (cluster.isPrimary) {
    // One-time setup runs once, in the primary, before any worker starts taking requests.
    await db.initDb(DATA_DIR);
    await initAdmin();
    await initStakes();
    setInterval(() => db.cleanupExpired().catch(e => console.error('[DB] cleanup failed:', e.message)), 10 * 60 * 1000).unref();

    if (WORKERS > 1) {
      for (let i = 0; i < WORKERS; i++) cluster.fork();
      cluster.on('exit', (worker, code) => {
        console.warn(`Worker ${worker.process.pid} exited (code ${code}); starting a replacement.`);
        cluster.fork();
      });
      return;
    }
  }
  listen();
}

startServer().catch(e => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
