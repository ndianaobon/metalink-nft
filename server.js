require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
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
  // Count per visitor. The default key (the socket address) is Hostinger's proxy, which would make
  // every user on the site share a single 20-attempt budget.
  keyGenerator: req => getClientIp(req),
  validate: { xForwardedForHeader: false }, // we read X-Forwarded-For ourselves in getClientIp
  message: { error: 'Too many attempts. Please try again later.' }
});

app.use(express.json({ limit: '10mb' }));
// Images in /assets and /uploads are embedded in emails and by other sites (link previews), which helmet's
// default same-origin resource policy would block. Private deposit screenshots are never served from here.
app.use(['/assets', '/uploads'], (req, res, next) => { res.set('Cross-Origin-Resource-Policy', 'cross-origin'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets'), { maxAge: '1h' }));
// Files uploaded before uploads moved into Postgres; anything not found here falls through to the DB route below.
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// Deposit screenshots are private (they show users' wallets/transactions): stored under this prefix and
// only served through the admin-only route, never through the public /uploads/ URL.
const PRIVATE_UPLOAD_PREFIX = 'proof_';

app.get('/uploads/:name', async (req, res) => {
  if (req.params.name.startsWith(PRIVATE_UPLOAD_PREFIX)) return res.status(404).end();
  const { rows } = await pool.query('SELECT content_type, bytes FROM app.uploads WHERE name = $1', [req.params.name]);
  if (!rows.length) return res.status(404).end();
  // Upload names are server-generated and never reused, so the content behind a URL never changes.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(rows[0].content_type).send(rows[0].bytes);
});

function getConfig(c = pool) { return db.getSetting(c, 'platform_config'); }

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }
// UIDs double as referral codes, so they skip look-alike characters (I/O/0/1) that people mistype.
const UID_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const UID_DIGITS = '23456789';
// 10 characters, always a mix: at least 4 letters and 4 digits, shuffled.
function generateUID() {
  const pick = set => set[crypto.randomInt(set.length)];
  const chars = [];
  for (let i = 0; i < 4; i++) chars.push(pick(UID_LETTERS), pick(UID_DIGITS));
  for (let i = 0; i < 2; i++) chars.push(pick(UID_LETTERS + UID_DIGITS));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
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

const SITE_URL = 'https://metalinknft.com';
const EMAIL_WELCOME_IMAGE_URL = SITE_URL + '/assets/images/MetaLink-NFT-welcome.jpg';
const TELEGRAM_URL = 'https://t.me/metaLinkNFT';

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emailButton(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:8px;background:#4F46E5;">
    <a href="${href}" style="display:inline-block;padding:12px 28px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
  </td></tr></table>`;
}

function welcomeEmailHtml(username, uid) {
  return `<div style="background:#f4f5f7;padding:24px 0;">
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;color:#1e2329;">
    <a href="${SITE_URL}"><img src="${EMAIL_WELCOME_IMAGE_URL}" alt="MetaLink NFT &mdash; The Future of Digital Ownership" width="560" style="display:block;width:100%;height:auto;border:0;"></a>
    <div style="padding:28px 28px 8px;">
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Welcome to MetaLink NFT, ${escHtml(username)}!</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#474d57;">Your account has been created successfully and you're ready to start exploring.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4fa;border-radius:8px;margin:0 0 20px;">
        <tr><td style="padding:14px 16px;font-size:13px;color:#707a8a;">Your UID</td>
            <td style="padding:14px 16px;text-align:right;font-family:'Courier New',monospace;font-size:16px;font-weight:700;letter-spacing:1px;">${escHtml(uid)}</td></tr>
      </table>
      <p style="margin:0 0 8px;font-size:15px;font-weight:700;">Here's what you can do next:</p>
      <ul style="margin:0 0 8px;padding-left:20px;font-size:14px;line-height:1.8;color:#474d57;">
        <li><strong>Stake</strong> &mdash; put your balance to work in our Exclusive Zone NFT stakes</li>
        <li><strong>Earn</strong> &mdash; explore Growth, Comprehensive, Ecology and USDT Finance plans</li>
        <li><strong>Reserve</strong> &mdash; try a daily reservation draw for a chance at bonus rewards</li>
        <li><strong>Daily check-in</strong> &mdash; claim your sign-in reward every 24 hours</li>
        <li><strong>Invite friends</strong> &mdash; earn team commission when the people you refer make deposits</li>
      </ul>
      ${emailButton('Go to My Account', SITE_URL + '/app.html')}
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#474d57;">Join our community on Telegram for news and support: <a href="${TELEGRAM_URL}" style="color:#4F46E5;font-weight:700;text-decoration:none;">t.me/metaLinkNFT</a></p>
    </div>
    ${emailFooter()}
  </div></div>`;
}

function emailFooter() {
  return `<div style="padding:20px 28px;background:#fafafa;border-top:1px solid #eaecef;font-size:12px;line-height:1.6;color:#848e9c;">
    <p style="margin:0 0 8px;"><strong>Don't recognize this activity?</strong> Please reset your password and contact our support team immediately.</p>
    <p style="margin:0;">This is an automated message, please do not reply. &copy; ${new Date().getUTCFullYear()} MetaLink NFT. All rights reserved.</p>
  </div>`;
}

// Exchange-style transaction email (deposit / withdrawal): logo, headline, short message,
// a details table, a call-to-action, and the standard security footer.
function transactionEmailHtml({ title, titleColor = '#1e2329', greeting, message, rows }) {
  const detailRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eaecef;font-size:13px;color:#707a8a;vertical-align:top;">${label}</td>
      <td style="padding:10px 0 10px 16px;border-bottom:1px solid #eaecef;font-size:13px;font-weight:700;text-align:right;word-break:break-all;">${value}</td>
    </tr>`).join('');
  return `<div style="background:#f4f5f7;padding:24px 0;">
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;color:#1e2329;">
    <div style="padding:20px 28px;border-bottom:1px solid #eaecef;">
      <img src="${EMAIL_LOGO_URL}" alt="MetaLink NFT" style="height:30px;display:block;">
    </div>
    <div style="padding:28px 28px 8px;">
      <h1 style="margin:0 0 20px;font-size:24px;line-height:1.3;color:${titleColor};">${title}</h1>
      <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#474d57;">${greeting}</p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#474d57;">${message}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eaecef;">${detailRows}</table>
      ${emailButton('Visit Your Account', SITE_URL + '/app.html')}
    </div>
    ${emailFooter()}
  </div></div>`;
}

function emailTime(date = new Date()) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19) + ' (UTC)';
}

function networkLabel(network) {
  return network === 'bep20' ? 'BNB Smart Chain (BEP20)' : network === 'trc20' ? 'Tron (TRC20)' : '&mdash;';
}

function depositEmail(kind, username, deposit, newBalance) {
  const amount = `${fmtMoney(deposit.amount)} USDT`;
  const rows = [['Amount', amount]];
  if (deposit.network) rows.push(['Network', networkLabel(deposit.network)]);
  if (deposit.txid) rows.push(['Transaction ID', escHtml(deposit.txid)]);
  const greeting = `Hi ${escHtml(username)},`;
  if (kind === 'submitted') {
    rows.push(['Status', '<span style="color:#d97706;">Pending review</span>'], ['Submitted', emailTime(deposit.createdAt)]);
    return { subject: `[MetaLink NFT] Deposit Request Received - ${amount}`, html: transactionEmailHtml({
      title: 'Deposit Request Received', greeting, rows,
      message: `We've received your deposit request of <strong>${amount}</strong>. Our team is verifying your transfer, and your balance will be credited as soon as it is confirmed.`
    }) };
  }
  if (kind === 'approved') {
    rows.push(['Status', '<span style="color:#03a66d;">Completed</span>'], ['Available Balance', `${fmtMoney(newBalance)} USDT`], ['Time', emailTime()]);
    return { subject: `[MetaLink NFT] Deposit Successful - ${amount}`, html: transactionEmailHtml({
      title: 'Deposit Successful', titleColor: '#03a66d', greeting, rows,
      message: `Your deposit of <strong>${amount}</strong> is now available in your MetaLink NFT account. Log in to check your balance.`
    }) };
  }
  rows.push(['Status', '<span style="color:#cf304a;">Rejected</span>'], ['Time', emailTime()]);
  return { subject: `[MetaLink NFT] Deposit Unsuccessful - ${amount}`, html: transactionEmailHtml({
    title: 'Deposit Unsuccessful', titleColor: '#cf304a', greeting, rows,
    message: `We could not confirm your deposit of <strong>${amount}</strong>, so it has not been credited. Please check that the transfer and screenshot are correct, or contact our support team.`
  }) };
}

function withdrawalEmail(kind, withdrawal) {
  const amount = `${fmtMoney(withdrawal.amount)} USDT`;
  const rows = [
    ['Amount', amount],
    ['Fee', `${fmtMoney(withdrawal.fee)} USDT`],
    ['You Receive', `${fmtMoney(withdrawal.netAmount)} USDT`],
    ['Network', networkLabel(withdrawal.walletType === 'erc20' ? 'bep20' : withdrawal.walletType)],
    ['Address', escHtml(withdrawal.walletAddress)]
  ];
  const greeting = `Hi ${escHtml(withdrawal.username)},`;
  if (kind === 'submitted') {
    rows.push(['Status', '<span style="color:#d97706;">Processing</span>'], ['Submitted', emailTime(withdrawal.createdAt)]);
    return { subject: `[MetaLink NFT] Withdrawal Request Submitted - ${amount}`, html: transactionEmailHtml({
      title: 'Withdrawal Request Submitted', greeting, rows,
      message: `You have submitted a withdrawal request of <strong>${amount}</strong>. It is now being processed, and we'll email you again once it has been sent.`
    }) };
  }
  if (kind === 'approved') {
    rows.push(['Status', '<span style="color:#03a66d;">Completed</span>'], ['Time', emailTime()]);
    return { subject: `[MetaLink NFT] Withdrawal Successful - ${amount}`, html: transactionEmailHtml({
      title: 'Withdrawal Successful', titleColor: '#03a66d', greeting, rows,
      message: `You have successfully withdrawn <strong>${fmtMoney(withdrawal.netAmount)} USDT</strong> to the address below. Depending on network conditions, it may take a few minutes to arrive in your wallet.`
    }) };
  }
  rows.push(['Status', '<span style="color:#cf304a;">Rejected</span>'], ['Time', emailTime()]);
  return { subject: `[MetaLink NFT] Withdrawal Rejected - ${amount}`, html: transactionEmailHtml({
    title: 'Withdrawal Rejected', titleColor: '#cf304a', greeting, rows,
    message: `Your withdrawal request of <strong>${amount}</strong> was not approved, and the full amount has been returned to your MetaLink NFT balance.`
  }) };
}

function levelUpgradeEmailHtml(username, level, balance) {
  // Celebration layout. Gradients have a solid background-color fallback for clients (Outlook) that drop them.
  return `<div style="background:#f4f5f7;padding:24px 0;">
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;color:#1e2329;">
    <div style="background-color:#4F46E5;background-image:linear-gradient(135deg,#7C3AED 0%,#4F46E5 55%,#14B8A6 100%);padding:36px 28px 32px;text-align:center;">
      <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 22px;"><tr><td style="background:#ffffff;border-radius:10px;padding:8px 14px;">
        <img src="${EMAIL_LOGO_URL}" alt="MetaLink NFT" style="height:24px;display:block;">
      </td></tr></table>
      <div style="font-size:30px;line-height:1;letter-spacing:6px;margin-bottom:14px;">&#127881;&#127942;&#127881;</div>
      <div style="font-size:14px;font-weight:700;letter-spacing:3px;color:#e0e7ff;text-transform:uppercase;">Congratulations</div>
      <h1 style="margin:8px 0 22px;font-size:28px;line-height:1.25;color:#ffffff;">You've been upgraded!</h1>
      <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;"><tr><td style="background:#ffffff;border-radius:999px;padding:12px 34px;">
        <span style="font-size:13px;font-weight:700;letter-spacing:2px;color:#7C3AED;">LEVEL</span>
        <span style="font-size:34px;font-weight:800;color:#1e2329;vertical-align:middle;margin-left:6px;">${level}</span>
      </td></tr></table>
    </div>
    <div style="padding:28px 28px 8px;">
      <p style="margin:0 0 14px;font-size:16px;line-height:1.6;">Hi <strong>${escHtml(username)}</strong>,</p>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#474d57;">Great news &mdash; your wallet balance has crossed the threshold for <strong>Level ${level}</strong>, and your MetaLink NFT account has been upgraded automatically.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4fa;border-radius:10px;margin:0 0 18px;">
        <tr><td style="padding:14px 16px;font-size:13px;color:#707a8a;">New level</td><td style="padding:14px 16px;text-align:right;font-size:15px;font-weight:800;color:#7C3AED;">LV ${level}</td></tr>
        <tr><td style="padding:0 16px 14px;font-size:13px;color:#707a8a;">Current balance</td><td style="padding:0 16px 14px;text-align:right;font-size:15px;font-weight:800;">${fmtMoney(balance)} USDT</td></tr>
      </table>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#474d57;">Higher levels unlock better opportunities across the platform. Keep growing your balance to reach the next one &mdash; and share your win with the community!</p>
      ${emailButton('Open My Account', SITE_URL + '/app.html')}
    </div>
    ${emailFooter()}
  </div></div>`;
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

function isBanned(user) { return !!user.bannedAt; }

// The 403 body every blocked-account check returns; the login page and app show it to the user.
function blockedResponse(user) {
  if (isBanned(user)) return { error: 'Account banned', banned: true, reason: user.banReason || '' };
  return { error: 'Account frozen', frozenUntil: user.frozenUntil, reason: user.suspendReason || '' };
}

// ---------- client IP (for multi-account detection) ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

function normalizeIp(raw) {
  let ip = String(raw || '').trim().replace(/^::ffff:/i, '');
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(':')[0]; // strip a port some proxies append
  return net.isIP(ip) ? ip : '';
}

// The site sits behind Hostinger's CDN and proxies, so the socket address is a proxy. The visitor's
// address is the first public entry in X-Forwarded-For (proxies append theirs after it).
function getClientIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(normalizeIp).filter(Boolean);
  const publicIp = chain.find(ip => !isPrivateIp(ip));
  if (publicIp) return publicIp;
  const realIp = normalizeIp(req.headers['x-real-ip']);
  if (realIp && !isPrivateIp(realIp)) return realIp;
  return chain[0] || normalizeIp(req.socket.remoteAddress) || 'unknown';
}

function recordUserIp(userId, ip, c = pool) {
  // A private address means we only saw an internal proxy, which every visitor would share;
  // recording it would flag all users as one group.
  if (!userId || !net.isIP(ip) || isPrivateIp(ip)) return Promise.resolve();
  return c.query(`
    INSERT INTO app.user_ips (user_id, ip) VALUES ($1, $2)
    ON CONFLICT (user_id, ip) DO UPDATE SET last_seen = now(), hits = app.user_ips.hits + 1`, [userId, ip])
    .catch(e => console.error('[ip] record failed:', e.message));
}

async function isIpBanned(ip) {
  const { rows } = await pool.query('SELECT 1 FROM app.banned_ips WHERE ip = $1', [ip]);
  return rows.length > 0;
}
async function noteLogin(userId, req) {
  const ip = getClientIp(req);
  await db.patchDoc(pool, 'users', userId, { lastIp: ip, lastLoginAt: new Date().toISOString() });
  await recordUserIp(userId, ip);
}

const IP_BLOCKED_ERROR ='New accounts cannot be created from your network. Please contact support.';

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

// Ledger: one row per balance change, shown to the user as Account Activity. Call it right after
// changing user.walletBalance (inside the same transaction) so balanceAfter is accurate.
const TX_LABELS = {
  signup_bonus: 'Sign-up Bonus',
  checkin: 'Daily Check-in Reward',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  withdrawal_refund: 'Withdrawal Refund',
  stake: 'Stake',
  stake_return: 'Stake Principal Returned',
  stake_income: 'Stake Income',
  earn: 'Earn Plan',
  earn_return: 'Earn Principal Returned',
  earn_income: 'Earn Income',
  reserve_reward: 'Reservation Reward',
  team_commission: 'Team Commission',
  admin_credit: 'Balance Credit',
  admin_debit: 'Balance Deduction'
};

async function recordTx(c, user, type, amount, description = '', refId = null, createdAt = null) {
  amount = parseFloat(Number(amount).toFixed(5));
  if (!amount) return;
  await db.insertDoc(c, 'transactions', {
    id: generateId(),
    userId: user.id,
    type,
    amount,
    balanceAfter: user.walletBalance !== undefined ? parseFloat(Number(user.walletBalance).toFixed(5)) : null,
    description,
    refId,
    createdAt: createdAt || new Date().toISOString()
  });
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

  // Throttled "last active" tracking. Suspending/banning deletes sessions immediately; this re-check
  // is a backstop (e.g. a suspension set through the edit form on another server process).
  const now = Date.now();
  if (now - session.lastActivityWrite > ACTIVITY_WRITE_THROTTLE_MS) {
    const ip = getClientIp(req);
    // One round trip: claim the write slot (of several simultaneous requests only one wins), stamp
    // lastActiveAt/lastIp, and read back the account's status.
    const { rows } = await pool.query(`
      WITH s AS (UPDATE app.sessions SET last_activity_write = $2 WHERE token_hash = $1 AND last_activity_write = $3 RETURNING user_id)
      UPDATE app.users u SET data = u.data || jsonb_build_object('lastActiveAt', $4::text, 'lastIp', $5::text)
      FROM s WHERE u.id = s.user_id
      RETURNING u.data->>'frozenUntil' AS "frozenUntil", u.data->>'suspendReason' AS "suspendReason",
                u.data->>'bannedAt' AS "bannedAt", u.data->>'banReason' AS "banReason"`,
      [session.tokenHash, now, session.lastActivityWrite, new Date(now).toISOString(), ip]);
    if (rows.length) {
      recordUserIp(session.userId, ip);
      if (isBanned(rows[0]) || isFrozen(rows[0])) {
        await deleteSession(session.tokenHash);
        return res.status(403).json(blockedResponse(rows[0]));
      }
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

  if (await isIpBanned(getClientIp(req))) return res.status(403).json({ error: IP_BLOCKED_ERROR });
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

  const ip = getClientIp(req);
  if (await isIpBanned(ip)) return res.status(403).json({ error: IP_BLOCKED_ERROR });

  const result = await tx(async c => {
    // Serializes account creation so two simultaneous signups can't claim the same email/username.
    await c.query('SELECT pg_advisory_xact_lock(424243)');
    if (await db.findUserBy(c, 'email', email)) return { error: 'Email already registered' };
    if (await db.findUserBy(c, 'username_lower', pending.username.toLowerCase())) return { error: 'Username is already taken. Please register again with a different one.' };

    const config = await getConfig(c);
    const signupBonus = config.signupBonus !== undefined ? parseFloat(config.signupBonus) : 10;

    let uid = generateUID();
    while (await db.findUserBy(c, 'uid', uid)) uid = generateUID();

    const user = {
      id: generateId(),
      email,
      password: pending.passwordHash,
      secondPassword: pending.passwordHash,
      username: pending.username,
      uid,
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
      signupIp: ip,
      lastIp: ip,
      createdAt: new Date().toISOString(),
      totalIncome: 0,
      totalWithdrawn: 0,
      dailyIncome: { comprehensive: 0, reserve: 0, team: 0, activity: 0, finance: 0, earn: 0, ecology: 0, growth: 0, stake: 0 }
    };
    await db.insertUser(c, user);
    await recordTx(c, user, 'signup_bonus', signupBonus, 'Welcome bonus for creating your account');
    await recordUserIp(user.id, ip, c);

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

  if (isBanned(user) || isFrozen(user)) return res.status(403).json(blockedResponse(user));

  if (user.twoFactorEnabled) {
    const tempToken = crypto.randomBytes(32).toString('hex');
    await db.ephSet(EPH_LOGIN, tempToken, { userId: user.id, expiresAt: Date.now() + LOGIN_2FA_TTL_MS });
    return res.json({ requires2FA: true, tempToken });
  }

  await noteLogin(user.id, req);
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
  if (isBanned(user) || isFrozen(user)) return res.status(403).json(blockedResponse(user));
  await noteLogin(user.id, req);
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
    await recordTx(c, user, 'stake', -totalCharge, `${nft.name} ${stake.nftNumber}${fee ? ` (incl. ${fee} USDT fee)` : ''}`, stake.id);
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
    // Rounded once, so the recorded income is exactly what gets credited.
    const income = parseFloat((stake.pledgeValue * dailyRate * daysElapsed).toFixed(5));

    stake.income = income;
    stake.claimed = true;
    stake.status = 'completed';
    await db.saveDoc(c, 'user_stakes', stake);

    user.walletBalance += stake.pledgeValue;
    await recordTx(c, user, 'stake_return', stake.pledgeValue, `${stake.nftName} ${stake.nftNumber}`, stake.id);
    user.walletBalance += income;
    await recordTx(c, user, 'stake_income', income, `${stake.nftName} ${stake.nftNumber} · ${stake.dailyIncome}/day`, stake.id);
    user.totalIncome += income;
    user.dailyIncome.stake += income;
    checkAndApplyLevelUpgrade(user, await getConfig(c), emails);
    await db.saveUser(c, user);

    return { status: 200, body: { message: 'Claimed successfully', income, name: `${stake.nftName} ${stake.nftNumber}`, days: stake.duration } };
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
    await recordTx(c, user, 'earn', -plan.amount, `${plan.categoryLabel} · ${plan.name}`, position.id);
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
    const income = parseFloat((position.amount * (position.dailyRatePct / 100) * daysElapsed).toFixed(5));

    position.income = income;
    position.claimed = true;
    position.status = 'completed';
    await db.saveDoc(c, 'earn_positions', position);

    user.walletBalance += position.amount;
    await recordTx(c, user, 'earn_return', position.amount, `${position.categoryLabel} · ${position.planName}`, position.id);
    user.walletBalance += income;
    await recordTx(c, user, 'earn_income', income, `${position.categoryLabel} · ${position.planName} · ${position.dailyRatePct}%/day`, position.id);
    user.totalIncome += income;
    const cat = position.category;
    if (user.dailyIncome[cat] !== undefined) user.dailyIncome[cat] += income;
    checkAndApplyLevelUpgrade(user, await getConfig(c), emails);
    await db.saveUser(c, user);

    return { status: 200, body: { message: 'Claimed successfully', income, name: `${position.categoryLabel} · ${position.planName}` } };
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

// Used until the admin saves their own levels from the dashboard (stored in settings 'reserve_levels').
const DEFAULT_RESERVE_LEVELS = [
  { level: 1, min: 50, max: 499, rewardPct: 2.5, name: 'Blue Cap Ape', image: '/assets/images/nfts/blue-cap-ape.jpg' },
  { level: 2, min: 500, max: 1999, rewardPct: 3.0, name: 'Purple Hat Ape', image: '/assets/images/nfts/purple-hat-ape.jpg' },
  { level: 3, min: 2000, max: 4999, rewardPct: 3.5, name: 'Cartoon Ape', image: '/assets/images/nfts/cartoon-ape.jpg' },
  { level: 4, min: 5000, max: 9999, rewardPct: 4.0, name: 'Steampunk Rat', image: '/assets/images/nfts/steampunk-rat.jpg' },
  { level: 5, min: 10000, max: 49999, rewardPct: 4.5, name: 'Collector Edition I', image: '/assets/images/nfts/col1.jpg' },
  { level: 6, min: 50000, max: 100000, rewardPct: 5.0, name: 'Collector Edition II', image: '/assets/images/nfts/col2.jpg' }
];

async function getReserveLevels(c = pool) {
  const stored = await db.getSetting(c, 'reserve_levels');
  return Array.isArray(stored.levels) && stored.levels.length ? stored.levels : DEFAULT_RESERVE_LEVELS;
}

// Returns { levels } (sorted by min, numbered 1..n) or { error }.
function validateReserveLevels(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) return { error: 'Provide between 1 and 20 reservation levels' };
  const levels = [];
  for (const raw of input) {
    const min = parseFloat(raw.min), max = parseFloat(raw.max), rewardPct = parseFloat(raw.rewardPct);
    const name = String(raw.name || '').trim();
    const image = String(raw.image || '').trim();
    if (!name || name.length > 60) return { error: 'Each level needs a name (max 60 characters)' };
    if (!(min >= 0) || !(max > min)) return { error: `"${name}": maximum must be greater than minimum, and minimum at least 0` };
    if (!(rewardPct >= 0 && rewardPct <= 100)) return { error: `"${name}": reward % must be between 0 and 100` };
    if (image && !/^(\/(assets|uploads)\/[\w\-./]+|https:\/\/\S+)$/.test(image)) return { error: `"${name}": invalid image` };
    levels.push({ min, max, rewardPct, name, image });
  }
  levels.sort((a, b) => a.min - b.min);
  levels.forEach((lv, i) => { lv.level = i + 1; });
  return { levels };
}

app.get('/api/reserve/orders', authMiddleware, async (req, res) => {
  const myOrders = await db.listDocs(pool, 'reserve_orders', { userId: req.userId });
  const user = await db.getUser(pool, req.userId);
  const RESERVE_LEVELS = await getReserveLevels();

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
    reservationRange: `${Math.min(...RESERVE_LEVELS.map(l => l.min))} - ${Math.max(...RESERVE_LEVELS.map(l => l.max))}`,
    walletBalance: user?.walletBalance || 0,
    balanceForReservation: Math.min(user?.walletBalance || 0, Math.max(...RESERVE_LEVELS.map(l => l.max))),
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

    const RESERVE_LEVELS = await getReserveLevels(c);
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
    // Rounded once, so the amount shown on the order is exactly what gets credited.
    const reward = won ? parseFloat((amount * (level.rewardPct / 100)).toFixed(2)) : 0;

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
      await recordTx(c, user, 'reserve_reward', order.reward, `${level.name} · Level ${level.level} · Order ${order.orderNumber}`, order.id);
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

  // Everything that changed the balance comes from the ledger. Deposits/withdrawals the ledger doesn't
  // cover (still pending, rejected, or from before the ledger existed) come from their own records.
  const txs = await db.listDocs(pool, 'transactions', { userId: req.userId });
  const ledgerDeposits = new Set(txs.filter(t => t.type === 'deposit').map(t => t.refId));
  const ledgerWithdrawals = new Set(txs.filter(t => t.type === 'withdrawal').map(t => t.refId));
  const withdrawalById = Object.fromEntries(withdrawals.map(w => [w.id, w]));
  const withdrawalStatus = w => !w ? 'Completed' : w.status === 'Approved' ? 'Completed' : w.status === 'Rejected' ? 'Rejected' : 'Processing';

  const history = [
    ...txs.map(t => ({
      kind: t.type,
      type: TX_LABELS[t.type] || t.type,
      description: t.description || '',
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      date: t.createdAt,
      status: t.type === 'withdrawal' ? withdrawalStatus(withdrawalById[t.refId]) : 'Completed'
    })),
    ...withdrawals.filter(w => !ledgerWithdrawals.has(w.id)).map(w => ({
      kind: 'withdrawal', type: TX_LABELS.withdrawal, description: '', amount: -w.amount, date: w.createdAt, status: withdrawalStatus(w)
    })),
    ...deposits.filter(d => !ledgerDeposits.has(d.id)).map(d => ({
      kind: 'deposit', type: TX_LABELS.deposit,
      description: d.status === 'Pending' ? 'Waiting for confirmation' : d.status === 'Rejected' ? 'Not credited' : '',
      // Pending/rejected deposits haven't changed the balance.
      amount: d.amount, pending: d.status !== 'Approved', date: d.createdAt,
      status: d.status === 'Approved' ? 'Completed' : d.status === 'Rejected' ? 'Rejected' : 'Processing'
    }))
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
    await recordTx(c, user, 'withdrawal', -amount, `To ${withdrawal.walletType.toUpperCase()} ${walletAddr.slice(0, 6)}…${walletAddr.slice(-4)} · fee ${fee} USDT`, withdrawal.id);
    return { status: 200, body: withdrawal };
  });

  if (result.status === 200) {
    const { subject, html } = withdrawalEmail('submitted', result.body);
    sendEmail(result.body.email, subject, html).catch(() => {});
  }
  res.status(result.status).json(result.body);
});

app.get('/api/withdrawals', authMiddleware, async (req, res) => {
  res.json(await db.listDocs(pool, 'withdrawals', { userId: req.userId }));
});

// ===================== DEPOSIT ROUTES =====================

const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+=*)$/;
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_BYTES = 1024 * 1024;

// Returns { ext, contentType, bytes } for a valid base64 image data URL, or null.
function decodeImageDataUrl(dataUrl, maxBytes) {
  const m = typeof dataUrl === 'string' && dataUrl.match(IMAGE_DATA_URL_RE);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) return null;
  return { ext, contentType: 'image/' + (ext === 'jpg' ? 'jpeg' : ext), bytes };
}

app.post('/api/deposits', authMiddleware, async (req, res) => {
  const { amount, network, txid, screenshot } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (network !== 'trc20' && network !== 'bep20') return res.status(400).json({ error: 'Select a deposit network' });
  const cleanTxid = typeof txid === 'string' ? txid.trim() : '';
  if (cleanTxid.length > 120) return res.status(400).json({ error: 'Transaction ID is too long' });
  const proof = decodeImageDataUrl(screenshot, MAX_PROOF_BYTES);
  if (!proof) return res.status(400).json({ error: 'Please upload a screenshot of your transfer (PNG, JPG or WEBP, max 5 MB)' });

  const config = await getConfig();
  const minDeposit = config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50;
  if (amount < minDeposit) return res.status(400).json({ error: `Minimum deposit is $${minDeposit}` });

  const deposit = {
    id: generateId(),
    userId: req.userId,
    amount: parseFloat(amount),
    network,
    txid: cleanTxid,
    proofName: PRIVATE_UPLOAD_PREFIX + generateId() + '.' + proof.ext,
    status: 'Pending',
    createdAt: new Date().toISOString()
  };
  await tx(async c => {
    await c.query('INSERT INTO app.uploads (name, content_type, bytes) VALUES ($1, $2, $3)', [deposit.proofName, proof.contentType, proof.bytes]);
    await db.insertDoc(c, 'deposits', deposit);
  });

  const user = await db.getUser(pool, req.userId);
  if (user) {
    const { subject, html } = depositEmail('submitted', user.username, deposit);
    sendEmail(user.email, subject, html).catch(() => {});
  }
  res.json(deposit);
});

app.get('/api/deposits', authMiddleware, async (req, res) => {
  res.json(await db.listDocs(pool, 'deposits', { userId: req.userId, order: 'DESC' }));
});

// ===================== DAILY CHECK-IN =====================

const CHECKIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function checkinStatus(user, config) {
  const reward = parseFloat(config.dailyCheckinReward) || 0;
  const last = user.lastCheckinAt ? new Date(user.lastCheckinAt).getTime() : 0;
  const nextAt = last ? last + CHECKIN_COOLDOWN_MS : 0;
  return {
    enabled: reward > 0,
    reward,
    lastCheckinAt: user.lastCheckinAt || null,
    nextCheckinAt: nextAt > Date.now() ? new Date(nextAt).toISOString() : null,
    canClaim: reward > 0 && nextAt <= Date.now(),
    totalClaimed: user.checkinTotal || 0,
    streak: user.checkinStreak || 0
  };
}

app.get('/api/checkin', authMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(checkinStatus(user, await getConfig()));
});

app.post('/api/checkin', authMiddleware, async (req, res) => {
  const emails = [];
  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };
    const config = await getConfig(c);
    const status = checkinStatus(user, config);
    if (!status.enabled) return { status: 400, body: { error: 'Daily check-in rewards are not available right now' } };
    if (!status.canClaim) return { status: 400, body: { error: 'You have already claimed today\'s reward', nextCheckinAt: status.nextCheckinAt } };

    const now = Date.now();
    const last = user.lastCheckinAt ? new Date(user.lastCheckinAt).getTime() : 0;
    // A streak continues if the previous claim was within 48h (i.e. the user didn't skip a whole day).
    user.checkinStreak = last && now - last < 2 * CHECKIN_COOLDOWN_MS ? (user.checkinStreak || 0) + 1 : 1;
    user.lastCheckinAt = new Date(now).toISOString();
    user.checkinTotal = parseFloat(((user.checkinTotal || 0) + status.reward).toFixed(2));
    user.walletBalance += status.reward;
    await recordTx(c, user, 'checkin', status.reward, `Day ${user.checkinStreak} of your check-in streak`);
    user.totalIncome += status.reward;
    user.dailyIncome = user.dailyIncome || {};
    user.dailyIncome.activity = (user.dailyIncome.activity || 0) + status.reward;
    checkAndApplyLevelUpgrade(user, config, emails);
    await db.saveUser(c, user);
    return { status: 200, body: { ...checkinStatus(user, config), claimed: status.reward, walletBalance: user.walletBalance } };
  });

  sendQueuedEmails(emails);
  res.status(result.status).json(result.body);
});

// ===================== PROFILE PICTURE =====================

app.post('/api/user/avatar', authMiddleware, async (req, res) => {
  const img = decodeImageDataUrl(req.body.image, MAX_AVATAR_BYTES);
  if (!img || img.ext === 'gif') return res.status(400).json({ error: 'Please choose a PNG, JPG or WEBP image under 1 MB' });

  const name = generateId() + '.' + img.ext;
  const user = await tx(async c => {
    const u = await db.getUser(c, req.userId, { lock: true });
    if (!u) return null;
    await c.query('INSERT INTO app.uploads (name, content_type, bytes) VALUES ($1, $2, $3)', [name, img.contentType, img.bytes]);
    // Drop the previous picture so replaced avatars don't pile up in the database.
    const previous = typeof u.avatar === 'string' && u.avatar.match(/^\/uploads\/([\w-]+\.\w+)$/);
    if (previous) await c.query('DELETE FROM app.uploads WHERE name = $1', [previous[1]]);
    u.avatar = '/uploads/' + name;
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicProfile(user));
});

app.delete('/api/user/avatar', authMiddleware, async (req, res) => {
  const user = await tx(async c => {
    const u = await db.getUser(c, req.userId, { lock: true });
    if (!u) return null;
    const previous = typeof u.avatar === 'string' && u.avatar.match(/^\/uploads\/([\w-]+\.\w+)$/);
    if (previous) await c.query('DELETE FROM app.uploads WHERE name = $1', [previous[1]]);
    u.avatar = '';
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicProfile(user));
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
  // For each user: how many *other* accounts have used any of the same IP addresses.
  const { rows: shared } = await pool.query(`
    SELECT a.user_id, count(DISTINCT b.user_id)::int AS n
    FROM app.user_ips a JOIN app.user_ips b ON b.ip = a.ip AND b.user_id <> a.user_id
    GROUP BY a.user_id`);
  const sharedMap = Object.fromEntries(shared.map(r => [r.user_id, r.n]));
  const users = (await db.listDocs(pool, 'users')).map(u => {
    const online = !!u.lastActiveAt && (Date.now() - new Date(u.lastActiveAt).getTime()) < ONLINE_THRESHOLD_MS;
    return { ...publicProfile(u), online, sharedIpAccounts: sharedMap[u.id] || 0 };
  });
  res.json(users);
});

// ---------- multi-account detection, suspensions and bans ----------

function accountStatus(u) {
  if (isBanned(u)) return 'banned';
  if (isFrozen(u)) return 'suspended';
  return 'active';
}

function accountSummary(u) {
  return {
    id: u.id, username: u.username, email: u.email, uid: u.uid, createdAt: u.createdAt,
    walletBalance: u.walletBalance, status: accountStatus(u), frozenUntil: u.frozenUntil || null,
    suspendReason: u.suspendReason || '', bannedAt: u.bannedAt || null, banReason: u.banReason || '',
    referredBy: u.referredBy || null
  };
}

// IP addresses used by 2+ different accounts, most accounts first.
app.get('/api/admin/multi-accounts', adminMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT i.ip, max(i.last_seen) AS last_seen,
           json_agg(json_build_object('userId', i.user_id, 'firstSeen', i.first_seen, 'lastSeen', i.last_seen, 'hits', i.hits) ORDER BY i.first_seen) AS seen,
           EXISTS (SELECT 1 FROM app.banned_ips b WHERE b.ip = i.ip) AS ip_banned
    FROM app.user_ips i
    WHERE i.ip IN (SELECT ip FROM app.user_ips GROUP BY ip HAVING count(DISTINCT user_id) > 1)
    GROUP BY i.ip
    ORDER BY count(DISTINCT i.user_id) DESC, max(i.last_seen) DESC
    LIMIT 500`);
  const userIds = [...new Set(rows.flatMap(r => r.seen.map(s => s.userId)))];
  const users = {};
  const { rows: userRows } = userIds.length ? await pool.query('SELECT data FROM app.users WHERE id = ANY($1)', [userIds]) : { rows: [] };
  userRows.forEach(r => { users[r.data.id] = r.data; });
  res.json(rows.map(r => ({
    ip: r.ip,
    lastSeen: r.last_seen,
    ipBanned: r.ip_banned,
    accounts: r.seen.filter(s => users[s.userId]).map(s => ({ ...accountSummary(users[s.userId]), firstSeenOnIp: s.firstSeen, lastSeenOnIp: s.lastSeen, hits: s.hits }))
  })).filter(g => g.accounts.length > 1));
});

// Every IP one user has used, with how many other accounts share each.
app.get('/api/admin/users/:id/ips', adminMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { rows } = await pool.query(`
    SELECT i.ip, i.first_seen, i.last_seen, i.hits,
           (SELECT count(DISTINCT o.user_id)::int FROM app.user_ips o WHERE o.ip = i.ip AND o.user_id <> i.user_id) AS other_accounts,
           EXISTS (SELECT 1 FROM app.banned_ips b WHERE b.ip = i.ip) AS ip_banned
    FROM app.user_ips i WHERE i.user_id = $1 ORDER BY i.last_seen DESC`, [user.id]);
  res.json({
    user: { ...accountSummary(user), signupIp: user.signupIp || null, lastIp: user.lastIp || null },
    ips: rows.map(r => ({ ip: r.ip, firstSeen: r.first_seen, lastSeen: r.last_seen, hits: r.hits, otherAccounts: r.other_accounts, ipBanned: r.ip_banned }))
  });
});

// Lets the admin confirm the server is seeing real visitor IPs (should match whatismyip.com).
app.get('/api/admin/my-ip', adminMiddleware, async (req, res) => {
  res.json({ ip: getClientIp(req), forwardedFor: req.headers['x-forwarded-for'] || null });
});

const MAX_SUSPEND_MS = 10 * 365 * 24 * 60 * 60 * 1000;

app.post('/api/admin/users/:id/suspend', adminMiddleware, async (req, res) => {
  const until = new Date(req.body.until);
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (isNaN(until.getTime()) || until.getTime() <= Date.now()) return res.status(400).json({ error: 'Choose an end date/time in the future' });
  if (until.getTime() - Date.now() > MAX_SUSPEND_MS) return res.status(400).json({ error: 'Suspensions can be at most 10 years. Use Ban instead.' });
  const user = await tx(async c => {
    const u = await db.getUser(c, req.params.id, { lock: true });
    if (!u) return null;
    u.frozenUntil = until.toISOString();
    u.suspendReason = reason;
    u.suspendedAt = new Date().toISOString();
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await deleteSessionsFor(user.id, 'user'); // logs them out everywhere immediately
  res.json(accountSummary(user));
});

app.post('/api/admin/users/:id/unsuspend', adminMiddleware, async (req, res) => {
  const user = await tx(async c => {
    const u = await db.getUser(c, req.params.id, { lock: true });
    if (!u) return null;
    u.frozenUntil = null;
    u.suspendReason = '';
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(accountSummary(user));
});

app.post('/api/admin/users/:id/ban', adminMiddleware, async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  const blockIps = req.body.blockIps === true;
  const result = await tx(async c => {
    const u = await db.getUser(c, req.params.id, { lock: true });
    if (!u) return null;
    u.bannedAt = new Date().toISOString();
    u.banReason = reason;
    await db.saveUser(c, u);
    let blockedIps = 0;
    if (blockIps) {
      const r = await c.query(`
        INSERT INTO app.banned_ips (ip, user_id, reason)
        SELECT ip, $1, $2 FROM app.user_ips WHERE user_id = $1
        ON CONFLICT (ip) DO NOTHING`, [u.id, reason]);
      blockedIps = r.rowCount;
    }
    return { user: u, blockedIps };
  });
  if (!result) return res.status(404).json({ error: 'User not found' });
  await deleteSessionsFor(result.user.id, 'user');
  res.json({ ...accountSummary(result.user), blockedIps: result.blockedIps });
});

app.post('/api/admin/users/:id/unban', adminMiddleware, async (req, res) => {
  const user = await tx(async c => {
    const u = await db.getUser(c, req.params.id, { lock: true });
    if (!u) return null;
    u.bannedAt = null;
    u.banReason = '';
    await c.query('DELETE FROM app.banned_ips WHERE user_id = $1', [u.id]);
    return db.saveUser(c, u);
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(accountSummary(user));
});

app.get('/api/admin/banned-ips', adminMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT b.ip, b.reason, b.created_at, b.user_id, u.data->>'username' AS username
    FROM app.banned_ips b LEFT JOIN app.users u ON u.id = b.user_id ORDER BY b.created_at DESC`);
  res.json(rows.map(r => ({ ip: r.ip, reason: r.reason, createdAt: r.created_at, userId: r.user_id, username: r.username })));
});

app.delete('/api/admin/banned-ips/:ip', adminMiddleware, async (req, res) => {
  await pool.query('DELETE FROM app.banned_ips WHERE ip = $1', [req.params.ip]);
  res.json({ message: 'Unblocked' });
});

app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const { walletBalance, level, points, username, frozenUntil } = req.body;

  const result = await tx(async c => {
    const user = await db.getUser(c, req.params.id, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    if (walletBalance !== undefined) {
      const before = user.walletBalance;
      user.walletBalance = parseFloat(walletBalance);
      const diff = user.walletBalance - before; // the edit form always sends the balance; only log real changes
      if (Math.abs(diff) >= 0.000005) await recordTx(c, user, diff > 0 ? 'admin_credit' : 'admin_debit', diff, 'Adjusted by MetaLink support');
    }
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

  if (result.status === 200 && isFrozen(result.body)) await deleteSessionsFor(result.body.id, 'user');
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
      const deposit = {
        id: generateId(),
        userId: u.id,
        amount: parseFloat(amount),
        status: 'Approved',
        approvedBy: 'admin',
        createdAt: new Date().toISOString()
      };
      await db.insertDoc(c, 'deposits', deposit);
      await recordTx(c, u, 'deposit', deposit.amount, 'Credited by MetaLink support', deposit.id);
      const { subject, html } = depositEmail('approved', u.username, deposit, u.walletBalance);
      emails.push([u.email, subject, html]);
    } else if (action === 'subtract' || action === 'set') {
      const before = u.walletBalance;
      u.walletBalance = action === 'subtract' ? Math.max(0, u.walletBalance - parseFloat(amount)) : parseFloat(amount);
      const diff = u.walletBalance - before;
      await recordTx(c, u, diff > 0 ? 'admin_credit' : 'admin_debit', diff, 'Adjusted by MetaLink support');
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

  let previousStatus;
  const withdrawal = await tx(async c => {
    const w = await db.getDoc(c, 'withdrawals', req.params.id, { lock: true });
    if (!w) return null;

    previousStatus = w.status;
    w.status = status;
    w.processedAt = new Date().toISOString();

    // Only refund on the transition into Rejected, so rejecting twice can't refund twice.
    if (status === 'Rejected' && previousStatus !== 'Rejected') {
      const user = await db.getUser(c, w.userId, { lock: true });
      if (user) {
        user.walletBalance += w.amount;
        user.totalWithdrawn -= w.amount;
        await recordTx(c, user, 'withdrawal_refund', w.amount, 'Withdrawal request was not approved — amount returned', w.id);
        await db.saveUser(c, user);
      }
    }

    return db.saveDoc(c, 'withdrawals', w);
  });
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

  if ((status === 'Approved' || status === 'Rejected') && status !== previousStatus) {
    const { subject, html } = withdrawalEmail(status === 'Approved' ? 'approved' : 'rejected', withdrawal);
    sendEmail(withdrawal.email, subject, html).catch(() => {});
  }

  res.json(withdrawal);
});

app.get('/api/admin/deposits', adminMiddleware, async (req, res) => {
  // Joined here so the admin page doesn't have to download every user just to label deposits.
  const { rows } = await pool.query(`
    SELECT d.data, u.data->>'username' AS username, u.data->>'email' AS email, u.data->>'uid' AS uid
    FROM app.deposits d LEFT JOIN app.users u ON u.id = d.user_id`);
  const deposits = rows.map(r => ({ ...r.data, username: r.username, email: r.email, uid: r.uid, hasProof: !!r.data.proofName }));
  res.json(deposits.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get('/api/admin/deposits/:id/proof', adminMiddleware, async (req, res) => {
  const d = await db.getDoc(pool, 'deposits', req.params.id);
  if (!d || !d.proofName) return res.status(404).json({ error: 'No screenshot for this deposit' });
  const { rows } = await pool.query('SELECT content_type, bytes FROM app.uploads WHERE name = $1', [d.proofName]);
  if (!rows.length) return res.status(404).json({ error: 'Screenshot not found' });
  res.set('Cache-Control', 'private, no-store');
  res.type(rows[0].content_type).send(rows[0].bytes);
});

app.get('/api/admin/reserve-levels', adminMiddleware, async (req, res) => {
  res.json(await getReserveLevels());
});

app.put('/api/admin/reserve-levels', adminMiddleware, async (req, res) => {
  const { levels, error } = validateReserveLevels(req.body.levels);
  if (error) return res.status(400).json({ error });
  await db.setSetting(pool, 'reserve_levels', { levels });
  res.json(levels);
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

    if (status === 'Rejected' && previousStatus !== 'Rejected') {
      const user = await db.getUser(c, d.userId);
      if (user) {
        const { subject, html } = depositEmail('rejected', user.username, d);
        emails.push([user.email, subject, html]);
      }
    }

    // Only credit on the transition into Approved, so approving twice can't credit twice.
    if (status === 'Approved' && previousStatus !== 'Approved') {
      const user = await db.getUser(c, d.userId, { lock: true });
      if (user) {
        const cfg = await getConfig(c);
        user.walletBalance += d.amount;
        await recordTx(c, user, 'deposit', d.amount, d.network ? `USDT · ${d.network === 'bep20' ? 'BEP20' : 'TRC20'}` : 'USDT', d.id);
        checkAndApplyLevelUpgrade(user, cfg, emails);
        const { subject, html } = depositEmail('approved', user.username, d, user.walletBalance);
        emails.push([user.email, subject, html]);
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
            await recordTx(c, referrer, 'team_commission', bonus, `Level ${tiers[i].tier} (${tiers[i].pct}%) from ${user.username}'s ${d.amount} USDT deposit`, d.id);
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
  const trc20 = config.depositAddressTrc20 || '';
  const bep20 = config.depositAddressBep20 || '';
  const qrOpts = { margin: 1, width: 360 };
  res.json({
    trc20,
    bep20,
    qr: {
      trc20: trc20 ? await QRCode.toDataURL(trc20, qrOpts) : '',
      bep20: bep20 ? await QRCode.toDataURL(bep20, qrOpts) : ''
    },
    minDeposit: config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50
  });
});

// Community links behind the app menu's Telegram and Group buttons (admin-editable in Settings).
const DEFAULT_TELEGRAM_LINK = 'https://t.me/MetaLinkNFT_Admin';
const DEFAULT_GROUP_LINK = 'https://t.me/+pOKs2lnyBXM5NjI9';

function validLink(value) {
  const v = String(value).trim();
  if (v === '') return '';
  try {
    const u = new URL(v.startsWith('http') ? v : 'https://' + v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
}

app.get('/api/platform/info', async (req, res) => {
  const config = await getConfig();
  res.json({
    signupBonus: config.signupBonus !== undefined ? config.signupBonus : 10,
    minDeposit: config.minDeposit !== undefined ? config.minDeposit : 50,
    referralBonusPct: config.referralBonusPct !== undefined ? config.referralBonusPct : 15,
    referralBonusPctB: config.referralBonusPctB !== undefined ? config.referralBonusPctB : 8,
    referralBonusPctC: config.referralBonusPctC !== undefined ? config.referralBonusPctC : 3,
    withdrawalFeePct: config.withdrawalFeePct !== undefined ? config.withdrawalFeePct : 4,
    handlingFeeEnabled: config.handlingFeeEnabled === true,
    telegramLink: config.telegramLink || DEFAULT_TELEGRAM_LINK,
    groupLink: config.groupLink || DEFAULT_GROUP_LINK
  });
});

app.get('/api/admin/platform-config', adminMiddleware, async (req, res) => {
  res.json(await getConfig());
});

app.put('/api/admin/platform-config', adminMiddleware, async (req, res) => {
  const { depositAddressTrc20, depositAddressBep20, signupBonus, minDeposit, referralBonusPct, referralBonusPctB, referralBonusPctC, withdrawalFeePct, reserveWinRatePct, handlingFeeEnabled, dailyCheckinReward, telegramLink, groupLink } = req.body;

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
    for (const [key, value, label] of [['telegramLink', telegramLink, 'Telegram link'], ['groupLink', groupLink, 'Group link']]) {
      if (value === undefined) continue;
      const link = validLink(value);
      if (link === null) return { status: 400, body: { error: `${label} must be a web link, e.g. https://t.me/yourchannel` } };
      config[key] = link; // '' falls back to the default link
    }
    if (dailyCheckinReward !== undefined) {
      const reward = parseFloat(dailyCheckinReward);
      if (isNaN(reward) || reward < 0 || reward > 100000) return { status: 400, body: { error: 'Daily check-in reward must be 0 or more (0 turns it off)' } };
      config.dailyCheckinReward = reward;
    }
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

// One-time: add ledger rows for earnings that happened before the ledger existed, using the dates
// the original records carry. Stake/earn claim times weren't stored, so those use the plan's end date
// (or the backfill time if the plan was claimed early). balanceAfter is unknown for these rows.
async function backfillLedger() {
  await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(424245)');
    const done = await c.query("SELECT 1 FROM app.settings WHERE key = '_ledger_backfill_done'");
    if (done.rows.length) return;
    const nowIso = new Date().toISOString();
    const pastOrNow = iso => (iso && iso < nowIso ? iso : nowIso);
    let n = 0;
    const add = async (userId, type, amount, description, refId, createdAt) => {
      if (!userId || !(amount > 0)) return;
      await recordTx(c, { id: userId }, type, amount, description, refId, createdAt);
      n++;
    };

    for (const o of await db.listDocs(c, 'reserve_orders')) {
      if (o.status === 'Won') await add(o.userId, 'reserve_reward', o.reward, `${o.itemName || 'Reservation'} · Level ${o.level} · Order ${o.orderNumber}`, o.id, o.reservationDate);
    }
    for (const d of await db.listDocs(c, 'deposits')) {
      for (const p of d.referralPayouts || []) {
        await add(p.userId, 'team_commission', p.bonus, `Level ${p.tier} (${p.pct}%) from a ${d.amount} USDT team deposit`, d.id, d.processedAt || d.createdAt);
      }
    }
    for (const s of await db.listDocs(c, 'user_stakes')) {
      if (!s.claimed) continue;
      const at = pastOrNow(s.endDate);
      await add(s.userId, 'stake_return', s.pledgeValue, `${s.nftName} ${s.nftNumber || ''}`.trim(), s.id, at);
      await add(s.userId, 'stake_income', s.income, `${s.nftName} ${s.nftNumber || ''} · ${s.dailyIncome}/day`.trim(), s.id, at);
    }
    for (const p of await db.listDocs(c, 'earn_positions')) {
      if (!p.claimed) continue;
      const at = pastOrNow(p.endDate);
      await add(p.userId, 'earn_return', p.amount, `${p.categoryLabel} · ${p.planName}`, p.id, at);
      await add(p.userId, 'earn_income', p.income, `${p.categoryLabel} · ${p.planName} · ${p.dailyRatePct}%/day`, p.id, at);
    }
    await db.setSetting(c, '_ledger_backfill_done', { at: nowIso, rows: n });
    console.log(`[DB] Ledger backfill: added ${n} past activity rows.`);
  });
}

async function startServer() {
  if (cluster.isPrimary) {
    // One-time setup runs once, in the primary, before any worker starts taking requests.
    await db.initDb(DATA_DIR);
    await backfillLedger();
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
