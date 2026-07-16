require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');

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
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/uploads', express.static(path.join(__dirname, 'data/uploads')));

if (!fs.existsSync(path.join(DATA_DIR, 'uploads'))) {
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
}

function readData(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeData(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

function readConfig(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeConfig(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

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

// Pending (unverified) signups, keyed by email. In-memory like sessions — acceptable for the
// same reason: single-instance deployment. Entries are short-lived (10 min) so restart impact is minimal.
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const pendingSignups = {};
// Pending password resets, keyed by email. Same in-memory/short-lived rationale as pendingSignups.
const passwordResets = {};

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

const DEFAULT_LEVEL_THRESHOLDS = { 1: 100, 2: 500, 3: 1000, 4: 5000, 5: 10000, 6: 50000 };

// Mutates users[userIdx] in place if the user's balance now qualifies for a higher level;
// caller is still responsible for writeData('users.json', users) afterward. Fires the
// upgrade email in the background (not awaited) so a slow/failed send never blocks the
// balance-changing request that triggered this check.
function checkAndApplyLevelUpgrade(users, userIdx) {
  const user = users[userIdx];
  const config = readConfig('platform_config.json');
  let newLevel = user.level || 0;
  for (let lv = 1; lv <= 6; lv++) {
    const threshold = config['levelThreshold' + lv] !== undefined ? parseFloat(config['levelThreshold' + lv]) : DEFAULT_LEVEL_THRESHOLDS[lv];
    if (user.walletBalance >= threshold && lv > newLevel) newLevel = lv;
  }
  if (newLevel > (user.level || 0)) {
    user.level = newLevel;
    sendEmail(user.email, `Congratulations! You've reached Level ${newLevel}`, levelUpgradeEmailHtml(user.username, newLevel, user.walletBalance)).catch(() => {});
  }
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // admin sessions are idle-timeout, not fixed -- see adminMiddleware
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const ACTIVITY_WRITE_THROTTLE_MS = 60 * 1000; // avoid a disk write on every single request
const sessions = {};

function createSession(subjectId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = role === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  sessions[token] = { userId: subjectId, role, expiresAt: Date.now() + ttl };
  return token;
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = token && sessions[token];
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  if (session.expiresAt < Date.now()) { delete sessions[token]; return res.status(401).json({ error: 'Session expired' }); }
  req.token = token;
  req.userId = session.userId;
  req.userRole = session.role || 'user';

  // Throttled "last active" tracking (also doubles as the freeze check, so a freeze takes
  // effect for an active session within ~1 minute rather than needing a fresh login).
  const now = Date.now();
  if (!session.lastActivityWrite || now - session.lastActivityWrite > ACTIVITY_WRITE_THROTTLE_MS) {
    session.lastActivityWrite = now;
    let users = readData('users.json');
    const idx = users.findIndex(u => u.id === session.userId);
    if (idx !== -1) {
      if (isFrozen(users[idx])) {
        delete sessions[token];
        return res.status(403).json({ error: 'Account frozen', frozenUntil: users[idx].frozenUntil });
      }
      users[idx].lastActiveAt = new Date().toISOString();
      writeData('users.json', users);
    }
  }

  next();
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = token && sessions[token];
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  if (session.expiresAt < Date.now()) { delete sessions[token]; return res.status(403).json({ error: 'Session expired' }); }
  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS; // sliding window: stays alive while actively used, expires 2h after the last request
  req.token = token;
  req.userId = session.userId;
  req.userRole = 'admin';
  next();
}

// Initialize default admin
async function initAdmin() {
  let admins = readData('admins.json');
  if (admins.length === 0) {
    admins.push({
      id: generateId(),
      username: 'admin',
      password: await hashPassword('admin123'),
      createdAt: new Date().toISOString()
    });
    writeData('admins.json', admins);
  }
}
initAdmin();

// Initialize default NFT stakes catalog
function initStakes() {
  let stakes = readData('nft_catalog.json');
  if (stakes.length === 0) {
    stakes = [
      { id: 'nft1', name: 'Exclusive Stake1', collection: 'Stake', image: '/assets/images/nfts/stake-1.jpg', pledgeRange: '199 - 1000', dailyIncome: '1.5%', handlingFee: '1%', duration: 7, color: '#7C3AED', levelReq: 'LV1-LV8' },
      { id: 'nft2', name: 'Exclusive Stake2', collection: 'Stake', image: '/assets/images/nfts/stake-2.jpg', pledgeRange: '499 - 2000', dailyIncome: '1.8%', handlingFee: '1%', duration: 14, color: '#4F46E5', levelReq: 'LV2-LV8' },
      { id: 'nft3', name: 'Exclusive Stake3', collection: 'Stake', image: '/assets/images/nfts/stake-3.jpg', pledgeRange: '799 - 3000', dailyIncome: '2.1%', handlingFee: '1%', duration: 30, color: '#14B8A6', levelReq: 'LV2-LV8' },
      { id: 'nft4', name: 'Exclusive Stake4', collection: 'Stake', image: '/assets/images/nfts/stake-4.png', pledgeRange: '999 - 4000', dailyIncome: '2.5%', handlingFee: '1%', duration: 60, color: '#3B82F6', levelReq: 'LV2-LV8' },
      { id: 'nft5', name: 'Exclusive Stake5', collection: 'Stake', image: '/assets/images/nfts/stake-5.png', pledgeRange: '1499 - 5000', dailyIncome: '3.0%', handlingFee: '1%', duration: 90, color: '#EF4444', levelReq: 'LV2-LV5' },
      { id: 'nft6', name: 'Exclusive Stake6', collection: 'Stake', image: '/assets/images/nfts/stake-6.png', pledgeRange: '1999 - 6000', dailyIncome: '3.5%', handlingFee: '1%', duration: 90, color: '#F59E0B', levelReq: 'LV2-LV8' },
    ];
    writeData('nft_catalog.json', stakes);
  }
}
initStakes();

// ===================== AUTH ROUTES =====================

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, email, password, confirmPassword, referralCode, phoneCountryCode, phoneNumber } = req.body;
  if (!username || !email || !password || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, - or _ only' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!phoneCountryCode || !phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

  const users = readData('users.json');
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email already registered' });
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: 'Username is already taken' });

  let referredBy = null;
  if (referralCode) {
    const referrer = users.find(u => u.uid === referralCode);
    if (!referrer) return res.status(400).json({ error: 'Invalid referral code' });
    referredBy = referrer.id;
  }

  const code = generateVerificationCode();
  pendingSignups[email] = {
    code,
    expiresAt: Date.now() + VERIFICATION_TTL_MS,
    passwordHash: await hashPassword(password),
    username,
    referredBy,
    phoneCountryCode,
    phoneNumber
  };

  try {
    await sendEmail(email, 'Verify your MetaLinkNFT account', verificationEmailHtml(code));
  } catch (e) {
    delete pendingSignups[email];
    return res.status(502).json({ error: 'Failed to send verification email. Please try again.' });
  }

  res.json({ message: 'Verification code sent to your email', email });
});

app.post('/api/auth/resend-code', authLimiter, async (req, res) => {
  const { email } = req.body;
  const pending = pendingSignups[email];
  if (!pending) return res.status(404).json({ error: 'No pending signup found for this email. Please register again.' });

  pending.code = generateVerificationCode();
  pending.expiresAt = Date.now() + VERIFICATION_TTL_MS;

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

  const pending = pendingSignups[email];
  if (!pending) return res.status(400).json({ error: 'No pending signup found. Please register again.' });
  if (pending.expiresAt < Date.now()) {
    delete pendingSignups[email];
    return res.status(400).json({ error: 'Verification code expired. Please register again.' });
  }
  if (pending.code !== code) return res.status(400).json({ error: 'Invalid verification code' });

  let users = readData('users.json');
  if (users.find(u => u.email === email)) {
    delete pendingSignups[email];
    return res.status(400).json({ error: 'Email already registered' });
  }
  if (users.find(u => u.username.toLowerCase() === pending.username.toLowerCase())) {
    delete pendingSignups[email];
    return res.status(400).json({ error: 'Username is already taken. Please register again with a different one.' });
  }

  const config = readConfig('platform_config.json');
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

  users.push(user);
  writeData('users.json', users);
  sendEmail(user.email, 'Welcome to MetaLink NFT!', welcomeEmailHtml(user.username, user.uid)).catch(() => {});

  if (user.referredBy) {
    let teams = readData('teams.json');
    const tiers = ['A', 'B', 'C'];
    let currentReferrerId = user.referredBy;
    for (let i = 0; i < tiers.length && currentReferrerId; i++) {
      teams.push({ userId: currentReferrerId, memberId: user.id, tier: tiers[i], joinedAt: new Date().toISOString() });
      const referrer = users.find(u => u.id === currentReferrerId);
      currentReferrerId = referrer ? referrer.referredBy : null;
    }
    writeData('teams.json', teams);
  }

  delete pendingSignups[email];

  const token = createSession(user.id, 'user');

  res.json({ token, user: { id: user.id, email: user.email, username: user.username, uid: user.uid, level: user.level, points: user.points } });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  let users = readData('users.json');
  const idx = users.findIndex(u => u.email === email);
  if (idx === -1 || !(await verifyPassword(password, users[idx].password))) {
    return res.status(401).json({ error: 'Account or password is incorrect' });
  }
  if (!isBcryptHash(users[idx].password)) {
    users[idx].password = await hashPassword(password);
    writeData('users.json', users);
  }
  const user = users[idx];

  if (isFrozen(user)) {
    return res.status(403).json({ error: 'Account frozen', frozenUntil: user.frozenUntil });
  }

  const token = createSession(user.id, 'user');

  res.json({
    token,
    user: { id: user.id, email: user.email, username: user.username, uid: user.uid, level: user.level, points: user.points, avatar: user.avatar }
  });
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const users = readData('users.json');
  const user = users.find(u => u.email === email);

  // Always respond the same way whether or not the account exists, so this endpoint can't be used to enumerate registered emails.
  if (user) {
    const code = generateVerificationCode();
    passwordResets[email] = { code, expiresAt: Date.now() + VERIFICATION_TTL_MS };
    try {
      await sendEmail(email, 'Reset your MetaLinkNFT password', passwordResetEmailHtml(code));
    } catch (e) {
      delete passwordResets[email];
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

  const reset = passwordResets[email];
  if (!reset) return res.status(400).json({ error: 'No password reset requested for this email. Please request a new code.' });
  if (reset.expiresAt < Date.now()) {
    delete passwordResets[email];
    return res.status(400).json({ error: 'Reset code expired. Please request a new one.' });
  }
  if (reset.code !== code) return res.status(400).json({ error: 'Invalid reset code' });

  let users = readData('users.json');
  const idx = users.findIndex(u => u.email === email);
  if (idx === -1) { delete passwordResets[email]; return res.status(400).json({ error: 'Account not found' }); }

  users[idx].password = await hashPassword(password);
  writeData('users.json', users);
  delete passwordResets[email];

  // Invalidate existing sessions so a token stolen before the reset stops working.
  const resetUserId = users[idx].id;
  Object.keys(sessions).forEach(token => { if (sessions[token].userId === resetUserId) delete sessions[token]; });

  res.json({ message: 'Password reset successfully' });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  delete sessions[req.token];
  res.json({ message: 'Logged out' });
});

// ===================== USER ROUTES =====================

app.get('/api/user/profile', authMiddleware, (req, res) => {
  const users = readData('users.json');
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { password, secondPassword, ...profile } = user;
  res.json(profile);
});

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const AVATAR_RE = /^(\/uploads\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)|data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*)$/;

app.put('/api/user/profile', authMiddleware, (req, res) => {
  let users = readData('users.json');
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const { username, avatar } = req.body;
  if (username) {
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, - or _ only' });
    users[idx].username = username;
  }
  if (avatar) {
    if (!AVATAR_RE.test(avatar)) return res.status(400).json({ error: 'Invalid avatar format' });
    users[idx].avatar = avatar;
  }
  writeData('users.json', users);

  const { password, secondPassword, ...profile } = users[idx];
  res.json(profile);
});

app.post('/api/user/change-password', authLimiter, authMiddleware, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  let users = readData('users.json');
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  if (!(await verifyPassword(currentPassword, users[idx].password))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  users[idx].password = await hashPassword(newPassword);
  writeData('users.json', users);

  // Invalidate other sessions but keep this one alive so the user isn't logged out mid-flow.
  Object.keys(sessions).forEach(token => {
    if (sessions[token].userId === req.userId && token !== req.token) delete sessions[token];
  });

  res.json({ message: 'Password changed successfully' });
});

app.post('/api/admin/change-password', authLimiter, adminMiddleware, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  let admins = readData('admins.json');
  const idx = admins.findIndex(a => a.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Admin not found' });

  if (!(await verifyPassword(currentPassword, admins[idx].password))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  admins[idx].password = await hashPassword(newPassword);
  writeData('admins.json', admins);

  Object.keys(sessions).forEach(token => {
    if (sessions[token].userId === req.userId && sessions[token].role === 'admin' && token !== req.token) delete sessions[token];
  });

  res.json({ message: 'Password changed successfully' });
});

app.put('/api/user/wallet', authMiddleware, (req, res) => {
  let users = readData('users.json');
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const { trc20, bep20 } = req.body;
  const now = new Date();
  const lastUpdate = users[idx].walletAddressUpdatedAt ? new Date(users[idx].walletAddressUpdatedAt) : null;

  if (lastUpdate) {
    const hoursSince = (now - lastUpdate) / (1000 * 60 * 60);
    if (hoursSince < 48) {
      const remaining = 48 - hoursSince;
      const days = Math.floor(remaining / 24);
      const hours = Math.floor(remaining % 24);
      const mins = Math.floor((remaining * 60) % 60);
      return res.status(400).json({
        error: `Withdrawal services will be suspended for ${days} days ${hours} hours ${mins} min after changing wallet address.`,
        cooldown: true
      });
    }
  }

  if (trc20 !== undefined) users[idx].walletAddress.trc20 = trc20;
  if (bep20 !== undefined) users[idx].walletAddress.bep20 = bep20;
  // Keep erc20 field in sync with bep20 for withdrawal compatibility
  if (bep20 !== undefined) users[idx].walletAddress.erc20 = bep20;
  users[idx].walletAddressUpdatedAt = now.toISOString();
  writeData('users.json', users);

  // Log wallet submission for admin review
  let submissions = readData('wallet_submissions.json');
  submissions.push({
    id: generateId(),
    userId: users[idx].id,
    email: users[idx].email,
    username: users[idx].username,
    uid: users[idx].uid,
    trc20: users[idx].walletAddress.trc20 || '',
    bep20: users[idx].walletAddress.bep20 || users[idx].walletAddress.erc20 || '',
    submittedAt: now.toISOString()
  });
  writeData('wallet_submissions.json', submissions);

  res.json({ message: 'Wallet address updated', walletAddress: { trc20: users[idx].walletAddress.trc20, bep20: users[idx].walletAddress.bep20 || users[idx].walletAddress.erc20 } });
});

app.get('/api/user/team', authMiddleware, (req, res) => {
  const teams = readData('teams.json');
  const users = readData('users.json');
  const deposits = readData('deposits.json');
  const depositedUserIds = new Set(deposits.filter(d => d.status === 'Approved').map(d => d.userId));
  const myTeam = teams.filter(t => t.userId === req.userId);

  const members = myTeam.map(t => {
    const member = users.find(u => u.id === t.memberId);
    return {
      id: t.memberId,
      username: member?.username || 'Unknown',
      tier: t.tier,
      joinedAt: t.joinedAt,
      // A member only counts as "valid" once they've made at least one approved deposit —
      // wallet balance alone isn't a reliable signal since every account starts with a signup bonus.
      isValid: depositedUserIds.has(t.memberId)
    };
  });

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

app.get('/api/stakes/catalog', authMiddleware, (req, res) => {
  const catalog = readData('nft_catalog.json');
  res.json(catalog);
});

app.get('/api/stakes/my', authMiddleware, (req, res) => {
  const stakes = readData('user_stakes.json');
  const myStakes = stakes.filter(s => s.userId === req.userId);
  res.json(myStakes);
});

app.post('/api/stakes', authMiddleware, (req, res) => {
  const { nftId, amount } = req.body;
  const catalog = readData('nft_catalog.json');
  const nft = catalog.find(n => n.id === nftId);
  if (!nft) return res.status(404).json({ error: 'NFT not found' });

  let users = readData('users.json');
  const userIdx = users.findIndex(u => u.id === req.userId);
  if (userIdx === -1) return res.status(404).json({ error: 'User not found' });

  const [min, max] = nft.pledgeRange.split(' - ').map(Number);
  if (amount < min || amount > max) return res.status(400).json({ error: `Amount must be between ${min} and ${max} USDT` });

  const feeEnabled = readConfig('platform_config.json').handlingFeeEnabled === true;
  const feePct = feeEnabled ? parseFloat(nft.handlingFee) / 100 : 0;
  const fee = parseFloat((amount * feePct).toFixed(5));
  const totalCharge = amount + fee;
  if (users[userIdx].walletBalance < totalCharge) return res.status(400).json({ error: `Insufficient balance. You need ${totalCharge} USDT (${amount} + ${fee} handling fee)` });

  users[userIdx].walletBalance -= totalCharge;
  writeData('users.json', users);

  const dailyRate = parseFloat(nft.dailyIncome) / 100;
  const expectedTotal = amount * dailyRate * nft.duration;

  let stakes = readData('user_stakes.json');
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
  stakes.push(stake);
  writeData('user_stakes.json', stakes);

  res.json(stake);
});

app.post('/api/stakes/:id/claim', authMiddleware, (req, res) => {
  let stakes = readData('user_stakes.json');
  const idx = stakes.findIndex(s => s.id === req.params.id && s.userId === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Stake not found' });
  if (stakes[idx].claimed) return res.status(400).json({ error: 'Already claimed' });

  const now = new Date();
  const start = new Date(stakes[idx].startDate);
  const daysElapsed = Math.min((now - start) / (1000 * 60 * 60 * 24), stakes[idx].duration);
  const dailyRate = parseFloat(stakes[idx].dailyIncome) / 100;
  const income = stakes[idx].pledgeValue * dailyRate * daysElapsed;

  stakes[idx].income = parseFloat(income.toFixed(5));
  stakes[idx].claimed = true;
  stakes[idx].status = 'completed';
  writeData('user_stakes.json', stakes);

  let users = readData('users.json');
  const userIdx = users.findIndex(u => u.id === req.userId);
  users[userIdx].walletBalance += stakes[idx].pledgeValue + income;
  users[userIdx].totalIncome += income;
  users[userIdx].dailyIncome.stake += income;
  checkAndApplyLevelUpgrade(users, userIdx);
  writeData('users.json', users);

  res.json({ message: 'Claimed successfully', income: parseFloat(income.toFixed(5)) });
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

app.get('/api/earn/my', authMiddleware, (req, res) => {
  const positions = readData('earn_positions.json');
  res.json(positions.filter(p => p.userId === req.userId));
});

app.post('/api/earn', authMiddleware, (req, res) => {
  const { planId } = req.body;
  const plan = EARN_PLANS.find(p => p.id === planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  let users = readData('users.json');
  const userIdx = users.findIndex(u => u.id === req.userId);
  if (userIdx === -1) return res.status(404).json({ error: 'User not found' });
  if (users[userIdx].walletBalance < plan.amount) return res.status(400).json({ error: 'Insufficient balance' });

  users[userIdx].walletBalance -= plan.amount;
  writeData('users.json', users);

  const expectedTotal = plan.amount * (plan.dailyRatePct / 100) * plan.days;

  let positions = readData('earn_positions.json');
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
  positions.push(position);
  writeData('earn_positions.json', positions);

  res.json(position);
});

app.post('/api/earn/:id/claim', authMiddleware, (req, res) => {
  let positions = readData('earn_positions.json');
  const idx = positions.findIndex(p => p.id === req.params.id && p.userId === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Position not found' });
  if (positions[idx].claimed) return res.status(400).json({ error: 'Already claimed' });

  const now = new Date();
  const start = new Date(positions[idx].startDate);
  const daysElapsed = Math.min((now - start) / (1000 * 60 * 60 * 24), positions[idx].days);
  const income = positions[idx].amount * (positions[idx].dailyRatePct / 100) * daysElapsed;

  positions[idx].income = parseFloat(income.toFixed(5));
  positions[idx].claimed = true;
  positions[idx].status = 'completed';
  writeData('earn_positions.json', positions);

  let users = readData('users.json');
  const userIdx = users.findIndex(u => u.id === req.userId);
  users[userIdx].walletBalance += positions[idx].amount + income;
  users[userIdx].totalIncome += income;
  const cat = positions[idx].category;
  if (users[userIdx].dailyIncome[cat] !== undefined) users[userIdx].dailyIncome[cat] += income;
  checkAndApplyLevelUpgrade(users, userIdx);
  writeData('users.json', users);

  res.json({ message: 'Claimed successfully', income: parseFloat(income.toFixed(5)) });
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

app.get('/api/reserve/orders', authMiddleware, (req, res) => {
  const orders = readData('reserve_orders.json');
  const myOrders = orders.filter(o => o.userId === req.userId);
  const users = readData('users.json');
  const user = users.find(u => u.id === req.userId);

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

app.post('/api/reserve/orders', authMiddleware, (req, res) => {
  const existingOrders = readData('reserve_orders.json').filter(o => o.userId === req.userId);
  const nextReservationAt = getNextReservationAt(existingOrders);
  if (nextReservationAt) return res.status(400).json({ error: 'You can only reserve once every 24 hours', nextReservationAt });

  let users = readData('users.json');
  const userIdx = users.findIndex(u => u.id === req.userId);
  const balance = users[userIdx].walletBalance;

  const affordableLevels = RESERVE_LEVELS.filter(lv => lv.min <= balance);
  if (!affordableLevels.length) return res.status(400).json({ error: `Insufficient balance. Minimum reservation is ${RESERVE_LEVELS[0].min} USDT` });

  const level = affordableLevels[Math.floor(Math.random() * affordableLevels.length)];
  const maxAmount = Math.min(level.max, balance);
  const amount = parseFloat((level.min + Math.random() * (maxAmount - level.min)).toFixed(2));

  users[userIdx].walletBalance -= amount;
  writeData('users.json', users);

  const cfg = readConfig('platform_config.json');
  const winRatePct = cfg.reserveWinRatePct !== undefined ? parseFloat(cfg.reserveWinRatePct) : 70;
  const won = Math.random() * 100 < winRatePct;
  const reward = won ? amount * (level.rewardPct / 100) : 0;

  let orders = readData('reserve_orders.json');
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
  orders.push(order);
  writeData('reserve_orders.json', orders);

  if (won) {
    users[userIdx].walletBalance += amount + reward;
    users[userIdx].totalIncome += reward;
    users[userIdx].dailyIncome.reserve += reward;
  } else {
    users[userIdx].walletBalance += amount;
  }
  checkAndApplyLevelUpgrade(users, userIdx);
  writeData('users.json', users);

  res.json(order);
});

// ===================== ASSETS / WALLET ROUTES =====================

app.get('/api/assets', authMiddleware, (req, res) => {
  const users = readData('users.json');
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const withdrawals = readData('withdrawals.json').filter(w => w.userId === req.userId);
  const deposits = readData('deposits.json').filter(d => d.userId === req.userId);

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

app.post('/api/withdrawals', authMiddleware, (req, res) => {
  const { amount, walletType } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  let users = readData('users.json');
  const userIdx = users.findIndex(u => u.id === req.userId);
  const user = users[userIdx];

  if (user.walletBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const walletAddr = (walletType === 'bep20' || walletType === 'erc20') ? (user.walletAddress.bep20 || user.walletAddress.erc20) : user.walletAddress.trc20;
  if (!walletAddr) return res.status(400).json({ error: 'Please set your wallet address first' });

  if (user.walletAddressUpdatedAt) {
    const hoursSince = (new Date() - new Date(user.walletAddressUpdatedAt)) / (1000 * 60 * 60);
    if (hoursSince < 48) {
      const remaining = 48 - hoursSince;
      const days = Math.floor(remaining / 24);
      const hours = Math.floor(remaining % 24);
      const mins = Math.floor((remaining * 60) % 60);
      return res.status(400).json({
        error: `Withdrawal Failed. Due to a change in wallet settings, withdrawal services will be suspended for ${days} days ${hours} hours ${mins} min ${Math.floor((remaining * 3600) % 60)} s to protect your account.`
      });
    }
  }

  const cfg = readConfig('platform_config.json');
  const withdrawalFeePct = cfg.withdrawalFeePct !== undefined ? parseFloat(cfg.withdrawalFeePct) : 4;
  const fee = parseFloat((amount * withdrawalFeePct / 100).toFixed(2));
  const tax = 0;
  const netAmount = parseFloat((amount - fee - tax).toFixed(2));

  users[userIdx].walletBalance -= amount;
  users[userIdx].totalWithdrawn += amount;
  writeData('users.json', users);

  let withdrawals = readData('withdrawals.json');
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
  withdrawals.push(withdrawal);
  writeData('withdrawals.json', withdrawals);

  res.json(withdrawal);
});

app.get('/api/withdrawals', authMiddleware, (req, res) => {
  const withdrawals = readData('withdrawals.json').filter(w => w.userId === req.userId);
  res.json(withdrawals);
});

// ===================== DEPOSIT ROUTES =====================

app.post('/api/deposits', authMiddleware, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const config = readConfig('platform_config.json');
  const minDeposit = config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50;
  if (amount < minDeposit) return res.status(400).json({ error: `Minimum deposit is $${minDeposit}` });

  let deposits = readData('deposits.json');
  const deposit = {
    id: generateId(),
    userId: req.userId,
    amount: parseFloat(amount),
    status: 'Pending',
    createdAt: new Date().toISOString()
  };
  deposits.push(deposit);
  writeData('deposits.json', deposits);

  res.json(deposit);
});

// ===================== ANNOUNCEMENT ROUTES =====================

app.get('/api/announcements', (req, res) => {
  const announcements = readData('announcements.json');
  res.json(announcements.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.get('/api/announcements/:id', (req, res) => {
  const announcements = readData('announcements.json');
  const ann = announcements.find(a => a.id === req.params.id);
  if (!ann) return res.status(404).json({ error: 'Announcement not found' });
  res.json(ann);
});

// ===================== ADMIN ROUTES =====================

app.post('/api/admin/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  let admins = readData('admins.json');
  const idx = admins.findIndex(a => a.username === username);
  if (idx === -1 || !(await verifyPassword(password, admins[idx].password))) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  if (!isBcryptHash(admins[idx].password)) {
    admins[idx].password = await hashPassword(password);
    writeData('admins.json', admins);
  }
  const admin = admins[idx];

  const token = createSession(admin.id, 'admin');
  res.json({ token, admin: { id: admin.id, username: admin.username } });
});

app.post('/api/admin/logout', adminMiddleware, (req, res) => {
  delete sessions[req.token];
  res.json({ message: 'Logged out' });
});

app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const users = readData('users.json');
  const withdrawals = readData('withdrawals.json');
  const deposits = readData('deposits.json');
  const stakes = readData('user_stakes.json');

  res.json({
    totalUsers: users.length,
    totalDeposits: deposits.reduce((s, d) => s + d.amount, 0),
    totalWithdrawals: withdrawals.filter(w => w.status === 'Approved').reduce((s, w) => s + w.amount, 0),
    pendingWithdrawals: withdrawals.filter(w => w.status === 'Pending').length,
    activeStakes: stakes.filter(s => s.status === 'active').length,
    totalStakeValue: stakes.filter(s => s.status === 'active').reduce((s, st) => s + st.pledgeValue, 0)
  });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = readData('users.json').map(u => {
    const { password, secondPassword, ...rest } = u;
    const online = !!u.lastActiveAt && (Date.now() - new Date(u.lastActiveAt).getTime()) < ONLINE_THRESHOLD_MS;
    return { ...rest, online };
  });
  res.json(users);
});

app.put('/api/admin/users/:id', adminMiddleware, (req, res) => {
  let users = readData('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const { walletBalance, level, points, username, frozenUntil } = req.body;
  if (walletBalance !== undefined) users[idx].walletBalance = parseFloat(walletBalance);
  if (level !== undefined) users[idx].level = parseInt(level);
  if (points !== undefined) users[idx].points = parseFloat(points);
  if (username !== undefined) users[idx].username = username;
  if (frozenUntil !== undefined) {
    if (frozenUntil === null || frozenUntil === '') {
      users[idx].frozenUntil = null;
    } else {
      const d = new Date(frozenUntil);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid freeze date' });
      users[idx].frozenUntil = d.toISOString();
    }
  }
  writeData('users.json', users);

  const { password, secondPassword, ...profile } = users[idx];
  res.json(profile);
});

app.put('/api/admin/users/:id/wallet', adminMiddleware, (req, res) => {
  let users = readData('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const { trc20, erc20 } = req.body;
  if (trc20 !== undefined) users[idx].walletAddress.trc20 = trc20;
  if (erc20 !== undefined) users[idx].walletAddress.erc20 = erc20;
  writeData('users.json', users);

  res.json({ message: 'Wallet updated', walletAddress: users[idx].walletAddress });
});

app.put('/api/admin/users/:id/balance', adminMiddleware, (req, res) => {
  let users = readData('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const { amount, action } = req.body;
  if (action === 'add') {
    users[idx].walletBalance += parseFloat(amount);
    let deposits = readData('deposits.json');
    deposits.push({
      id: generateId(),
      userId: users[idx].id,
      amount: parseFloat(amount),
      status: 'Approved',
      approvedBy: 'admin',
      createdAt: new Date().toISOString()
    });
    writeData('deposits.json', deposits);
  } else if (action === 'subtract') {
    users[idx].walletBalance = Math.max(0, users[idx].walletBalance - parseFloat(amount));
  } else if (action === 'set') {
    users[idx].walletBalance = parseFloat(amount);
  }
  checkAndApplyLevelUpgrade(users, idx);
  writeData('users.json', users);

  const { password, secondPassword, ...profile } = users[idx];
  res.json(profile);
});

app.get('/api/admin/withdrawals', adminMiddleware, (req, res) => {
  const withdrawals = readData('withdrawals.json');
  res.json(withdrawals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.put('/api/admin/withdrawals/:id', adminMiddleware, (req, res) => {
  let withdrawals = readData('withdrawals.json');
  const idx = withdrawals.findIndex(w => w.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Withdrawal not found' });

  const { status } = req.body;
  withdrawals[idx].status = status;
  withdrawals[idx].processedAt = new Date().toISOString();

  if (status === 'Rejected') {
    let users = readData('users.json');
    const userIdx = users.findIndex(u => u.id === withdrawals[idx].userId);
    if (userIdx !== -1) {
      users[userIdx].walletBalance += withdrawals[idx].amount;
      users[userIdx].totalWithdrawn -= withdrawals[idx].amount;
      writeData('users.json', users);
    }
  }

  if (status === 'Approved' || status === 'Rejected') {
    sendEmail(
      withdrawals[idx].email,
      status === 'Approved' ? 'Your withdrawal has been processed' : 'Your withdrawal request was not approved',
      withdrawalStatusEmailHtml(withdrawals[idx].username, withdrawals[idx].amount, withdrawals[idx].netAmount, status)
    ).catch(() => {});
  }

  writeData('withdrawals.json', withdrawals);
  res.json(withdrawals[idx]);
});

app.get('/api/admin/deposits', adminMiddleware, (req, res) => {
  const deposits = readData('deposits.json');
  res.json(deposits.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.put('/api/admin/deposits/:id', adminMiddleware, (req, res) => {
  let deposits = readData('deposits.json');
  const idx = deposits.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Deposit not found' });

  const { status } = req.body;
  deposits[idx].status = status;
  deposits[idx].processedAt = new Date().toISOString();

  if (status === 'Approved') {
    let users = readData('users.json');
    const userIdx = users.findIndex(u => u.id === deposits[idx].userId);
    if (userIdx !== -1) {
      users[userIdx].walletBalance += deposits[idx].amount;
      checkAndApplyLevelUpgrade(users, userIdx);
      sendEmail(users[userIdx].email, 'Your deposit has been confirmed', depositConfirmedEmailHtml(users[userIdx].username, deposits[idx].amount, users[userIdx].walletBalance)).catch(() => {});

      if (!deposits[idx].referralPaid) {
        const cfg = readConfig('platform_config.json');
        const tiers = [
          { tier: 'A', pct: cfg.referralBonusPct !== undefined ? parseFloat(cfg.referralBonusPct) : 15 },
          { tier: 'B', pct: cfg.referralBonusPctB !== undefined ? parseFloat(cfg.referralBonusPctB) : 8 },
          { tier: 'C', pct: cfg.referralBonusPctC !== undefined ? parseFloat(cfg.referralBonusPctC) : 3 }
        ];
        const payouts = [];
        let currentReferrerId = users[userIdx].referredBy;
        for (let i = 0; i < tiers.length && currentReferrerId; i++) {
          const referrerIdx = users.findIndex(u => u.id === currentReferrerId);
          if (referrerIdx === -1) break;
          const bonus = parseFloat((deposits[idx].amount * tiers[i].pct / 100).toFixed(2));
          users[referrerIdx].walletBalance += bonus;
          users[referrerIdx].totalIncome += bonus;
          users[referrerIdx].dailyIncome.team += bonus;
          checkAndApplyLevelUpgrade(users, referrerIdx);
          payouts.push({ userId: currentReferrerId, tier: tiers[i].tier, pct: tiers[i].pct, bonus });
          currentReferrerId = users[referrerIdx].referredBy;
        }
        deposits[idx].referralPaid = true;
        deposits[idx].referralPayouts = payouts;
      }

      writeData('users.json', users);
    }
  }

  writeData('deposits.json', deposits);
  res.json(deposits[idx]);
});

app.post('/api/admin/announcements', adminMiddleware, (req, res) => {
  const { title, date, category, content, image } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  let announcements = readData('announcements.json');
  const announcement = {
    id: generateId(),
    title,
    date: date || new Date().toISOString().split('T')[0],
    category: category || 'Announcement',
    content,
    image: image || '',
    createdAt: new Date().toISOString()
  };
  announcements.push(announcement);
  writeData('announcements.json', announcements);
  res.json(announcement);
});

app.put('/api/admin/announcements/:id', adminMiddleware, (req, res) => {
  let announcements = readData('announcements.json');
  const idx = announcements.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Announcement not found' });

  const { title, date, category, content, image } = req.body;
  if (title) announcements[idx].title = title;
  if (date) announcements[idx].date = date;
  if (category) announcements[idx].category = category;
  if (content) announcements[idx].content = content;
  if (image !== undefined) announcements[idx].image = image;
  announcements[idx].updatedAt = new Date().toISOString();

  writeData('announcements.json', announcements);
  res.json(announcements[idx]);
});

app.delete('/api/admin/announcements/:id', adminMiddleware, (req, res) => {
  let announcements = readData('announcements.json');
  announcements = announcements.filter(a => a.id !== req.params.id);
  writeData('announcements.json', announcements);
  res.json({ message: 'Deleted' });
});

app.get('/api/admin/announcements', adminMiddleware, (req, res) => {
  const announcements = readData('announcements.json');
  res.json(announcements.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// ===================== ADMIN WALLET SUBMISSIONS =====================

app.get('/api/admin/wallet-submissions', adminMiddleware, (req, res) => {
  const submissions = readData('wallet_submissions.json');
  res.json(submissions.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)));
});

app.delete('/api/admin/wallet-submissions/:id', adminMiddleware, (req, res) => {
  let submissions = readData('wallet_submissions.json');
  submissions = submissions.filter(s => s.id !== req.params.id);
  writeData('wallet_submissions.json', submissions);
  res.json({ message: 'Deleted' });
});

// Admin upload image (base64)
app.post('/api/admin/upload', adminMiddleware, (req, res) => {
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
  const fpath = path.join(DATA_DIR, 'uploads', fname);

  fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
  res.json({ url: '/uploads/' + fname });
});

// ===================== PLATFORM CONFIG ROUTES =====================

app.get('/api/platform/deposit-addresses', (req, res) => {
  const config = readConfig('platform_config.json');
  res.json({
    trc20: config.depositAddressTrc20 || '',
    bep20: config.depositAddressBep20 || ''
  });
});

app.get('/api/platform/info', (req, res) => {
  const config = readConfig('platform_config.json');
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

app.get('/api/admin/platform-config', adminMiddleware, (req, res) => {
  const config = readConfig('platform_config.json');
  res.json(config);
});

app.put('/api/admin/platform-config', adminMiddleware, (req, res) => {
  let config = readConfig('platform_config.json');
  const { depositAddressTrc20, depositAddressBep20, signupBonus, minDeposit, referralBonusPct, referralBonusPctB, referralBonusPctC, withdrawalFeePct, reserveWinRatePct, handlingFeeEnabled } = req.body;
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
    if (isNaN(rate) || rate < 0 || rate > 100) return res.status(400).json({ error: 'Reservation win rate must be between 0 and 100' });
    config.reserveWinRatePct = rate;
  }
  for (let lv = 1; lv <= 6; lv++) {
    const key = 'levelThreshold' + lv;
    if (req.body[key] !== undefined) {
      const val = parseFloat(req.body[key]);
      if (isNaN(val) || val < 0) return res.status(400).json({ error: `Level ${lv} threshold must be a non-negative number` });
      config[key] = val;
    }
  }
  writeConfig('platform_config.json', config);
  res.json(config);
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// SPA catch-all
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
  console.log(`MetaLinkNFT server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin`);
});
