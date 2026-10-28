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
const { readDeviceToken, readPlatform, hashDeviceToken } = require('./device');
const { analyzeAccount, withdrawalDecision, nextReviewStatus } = require('./risk');
const depositWatch = require('./deposit-watch');

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

// The mobile app (Capacitor) bundles the frontend and calls the API from its own local origin.
// Auth is a Bearer header, not cookies, so allowing these origins exposes nothing extra.
const MOBILE_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);
app.use(['/api', '/uploads'], (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && MOBILE_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Device-Platform');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
// Images in /assets and /uploads are embedded in emails and by other sites (link previews), which helmet's
// default same-origin resource policy would block. Private deposit screenshots are never served from here.
app.use(['/assets', '/uploads'], (req, res, next) => { res.set('Cross-Origin-Resource-Policy', 'cross-origin'); next(); });
// HTML pages must always be revalidated: without a Cache-Control header, phones, the Android app's
// WebView and Hostinger's CDN keep serving an old copy for a while after a deploy, so some users
// see the previous design. "no-cache" still allows a fast 304 when the page hasn't changed.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));
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
  if (kind === 'cancelled') {
    rows.push(['Status', '<span style="color:#707a8a;">Cancelled</span>'], ['Time', emailTime()]);
    return { subject: `[MetaLink NFT] Withdrawal Cancelled - ${amount}`, html: transactionEmailHtml({
      title: 'Withdrawal Cancelled', greeting, rows,
      message: `You cancelled your withdrawal request of <strong>${amount}</strong>. The full amount has been returned to your MetaLink NFT balance.`
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

// Country for an IP from the offline GeoLite2 country database bundled with geoip-country, so no
// user IPs are sent to a third-party lookup service. Country-level only: city data would need a
// ~115 MB in-memory database.
const geoipCountry = require('geoip-country');
function ipLocation(ip) {
  if (!ip || !net.isIP(ip) || isPrivateIp(ip)) return null;
  const g = geoipCountry.lookup(ip);
  return g ? { country: g.country, countryName: g.name } : null;
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

// ---------- devices and risk scoring (multi-account detection; see device.js and risk.js) ----------

// Key for hashing device tokens. Set DEVICE_HASH_SECRET in production; otherwise one is generated
// once and kept in app.settings so every worker process and restart uses the same key.
let deviceSecretPromise = null;
function getDeviceSecret() {
  if (process.env.DEVICE_HASH_SECRET) return Promise.resolve(process.env.DEVICE_HASH_SECRET);
  if (!deviceSecretPromise) {
    deviceSecretPromise = (async () => {
      await pool.query("INSERT INTO app.settings (key, value) VALUES ('device_hash_secret', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify({ secret: crypto.randomBytes(32).toString('hex') })]);
      return (await db.getSetting(pool, 'device_hash_secret')).secret;
    })().catch(e => { deviceSecretPromise = null; throw e; });
  }
  return deviceSecretPromise;
}

// Records that this account used this device. Requests without a device token (old app versions,
// API clients) are simply not recorded. Never throws: detection must not break sign-in.
async function recordUserDevice(userId, req) {
  const token = readDeviceToken(req);
  if (!userId || !token) return;
  try {
    const hash = hashDeviceToken(token, await getDeviceSecret());
    const { rows } = await pool.query(`
      INSERT INTO app.user_devices (user_id, device_hash, platform) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = now(), hits = app.user_devices.hits + 1, platform = EXCLUDED.platform
      RETURNING (xmax = 0) AS inserted`, [userId, hash, readPlatform(req)]);
    if (!rows[0].inserted) return;
    // First time this account is seen on this device: if other accounts use it too, mark it shared
    // and rescore everyone on it.
    const { rows: others } = await pool.query('SELECT DISTINCT user_id FROM app.user_devices WHERE device_hash = $1 AND user_id <> $2', [hash, userId]);
    if (others.length) {
      await pool.query("UPDATE app.user_devices SET risk_flags = ARRAY['shared_device'] WHERE device_hash = $1", [hash]);
      scheduleRiskRecompute([userId, ...others.map(r => r.user_id)]);
    }
  } catch (e) { console.error('[device] record failed:', e.message); }
}

const walletKeySql = expr => `lower(trim(${expr}))`;

// Loads the rows around one account that risk.analyzeAccount() needs: everyone on its devices, IPs
// and payout wallets, plus its referrer and referees.
async function loadRiskWorld(c, userId) {
  const q = (sql, params) => c.query(sql, params).then(r => r.rows);
  const me = await db.getUser(c, userId);
  if (!me) return null;

  const devices = await q(`
    SELECT d.user_id, d.device_hash, d.platform FROM app.user_devices d
    WHERE d.device_hash IN (SELECT device_hash FROM app.user_devices WHERE user_id = $1)`, [userId]);
  // At most 100 accounts per IP: enough to tell a household from a carrier NAT (risk.BUSY_IP_ACCOUNTS).
  const ips = await q(`
    SELECT user_id, ip FROM (
      SELECT user_id, ip, row_number() OVER (PARTITION BY ip ORDER BY last_seen DESC) AS n
      FROM app.user_ips WHERE ip IN (SELECT ip FROM app.user_ips WHERE user_id = $1)) t
    WHERE n <= 100`, [userId]);

  const w = me.walletAddress || {};
  const myWithdrawals = await q("SELECT data->>'walletAddress' AS addr FROM app.withdrawals WHERE user_id = $1", [userId]);
  const myWallets = [...new Set([w.trc20, w.bep20, w.erc20, ...myWithdrawals.map(r => r.addr)]
    .map(a => String(a || '').trim().toLowerCase()).filter(Boolean))];
  const walletUsers = myWallets.length ? await q(`
    SELECT id AS user_id FROM app.users
    WHERE ${walletKeySql("data->'walletAddress'->>'trc20'")} = ANY($1) OR ${walletKeySql("data->'walletAddress'->>'bep20'")} = ANY($1)
       OR ${walletKeySql("data->'walletAddress'->>'erc20'")} = ANY($1)
    UNION SELECT user_id FROM app.withdrawals WHERE ${walletKeySql("data->>'walletAddress'")} = ANY($1)`, [myWallets]) : [];
  const referees = await q('SELECT id FROM app.users WHERE referred_by = $1', [userId]);

  const ids = [...new Set([userId, me.referredBy, ...devices.map(r => r.user_id), ...walletUsers.map(r => r.user_id), ...referees.map(r => r.id)].filter(Boolean))];
  const users = (await q('SELECT data FROM app.users WHERE id = ANY($1)', [ids])).map(r => r.data);
  const withdrawals = await q("SELECT user_id, data->>'status' AS status, data->>'walletAddress' AS addr FROM app.withdrawals WHERE user_id = ANY($1)", [ids]);
  const deposits = await q("SELECT DISTINCT user_id FROM app.deposits WHERE user_id = ANY($1) AND data->>'status' = 'Approved'", [ids]);
  const bonuses = await q("SELECT user_id, (data->>'amount')::numeric AS amount FROM app.transactions WHERE user_id = ANY($1) AND data->>'type' = 'signup_bonus'", [ids]);

  return {
    users: users.map(u => ({ id: u.id, uid: u.uid, username: u.username, createdAt: u.createdAt, referredBy: u.referredBy, walletAddress: u.walletAddress, deletedAt: u.deletedAt })),
    devices: devices.map(r => ({ userId: r.user_id, deviceHash: r.device_hash, platform: r.platform })),
    ips: ips.map(r => ({ userId: r.user_id, ip: r.ip })),
    deposits: deposits.map(r => ({ userId: r.user_id, status: 'Approved' })),
    withdrawals: withdrawals.map(r => ({ userId: r.user_id, status: r.status, walletAddress: r.addr })),
    signupBonuses: bonuses.map(r => ({ userId: r.user_id, amount: Number(r.amount) }))
  };
}

async function recomputeRisk(userId) {
  const world = await loadRiskWorld(pool, userId);
  if (!world) return null;
  const r = analyzeAccount(userId, world);
  const { rows } = await pool.query(`
    INSERT INTO app.account_risk (user_id, score, level, needs_review, flags, linked, computed_at)
    VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT (user_id) DO UPDATE SET score = EXCLUDED.score, level = EXCLUDED.level, needs_review = EXCLUDED.needs_review,
      flags = EXCLUDED.flags, linked = EXCLUDED.linked, computed_at = now()
    RETURNING review_status, reviewed_flags`,
    [userId, r.score, r.level, r.needsReview, JSON.stringify(r.flags), JSON.stringify(r.linked)]);
  const current = rows[0].review_status;
  const reviewStatus = nextReviewStatus(current, rows[0].reviewed_flags, r);
  if (reviewStatus !== current) await pool.query('UPDATE app.account_risk SET review_status = $2 WHERE user_id = $1', [userId, reviewStatus]);
  return { ...r, reviewStatus };
}

// Rescores accounts in the background (one at a time, so it never competes with real requests).
// With propagate, accounts strongly linked to them (device / wallet) are rescored as well, so a new
// link shows up on both sides.
function scheduleRiskRecompute(userIds, { propagate = false } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  setImmediate(async () => {
    const done = new Set();
    for (const id of ids) {
      try {
        const r = await recomputeRisk(id);
        done.add(id);
        if (propagate && r) {
          for (const l of r.linked) {
            if (done.has(l.userId) || !l.via.some(v => v === 'device' || v === 'wallet')) continue;
            await recomputeRisk(l.userId);
            done.add(l.userId);
          }
        }
      } catch (e) { console.error('[risk] recompute failed for', id, e.message); }
    }
  });
}

async function isIpBanned(ip) {
  const { rows } = await pool.query('SELECT 1 FROM app.banned_ips WHERE ip = $1', [ip]);
  return rows.length > 0;
}
async function noteLogin(userId, req) {
  const ip = getClientIp(req);
  const now = new Date().toISOString();
  // A login counts as activity too, so the admin's Online badge and Last Seen agree.
  await db.patchDoc(pool, 'users', userId, { lastIp: ip, lastLoginAt: now, lastActiveAt: now });
  await recordUserIp(userId, ip);
  await recordUserDevice(userId, req);
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
  gift_reward: 'Gift Reward',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  withdrawal_refund: 'Withdrawal Refund',
  withdrawal_cancelled: 'Withdrawal Cancelled',
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
      recordUserDevice(session.userId, req);
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
    if (!referrer || referrer.deletedAt) return res.status(400).json({ error: 'Invalid referral code' });
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
  await recordUserDevice(user.id, req);
  scheduleRiskRecompute([user.id, user.referredBy], { propagate: true });
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

const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/; // Tron base58 address
const BEP20_RE = /^0x[0-9a-fA-F]{40}$/;          // BNB Smart Chain (EVM) address

// Saved addresses stay on the account until the user changes them:
//  - a blank field means "keep what's saved" (it never erases an address);
//  - adding an address to an empty slot is always allowed and doesn't start the withdrawal hold;
//  - changing an existing address starts the 48h security hold (and is blocked while one is running);
//  - re-saving the same address changes nothing.
app.put('/api/user/wallet', authMiddleware, async (req, res) => {
  const trc20 = typeof req.body.trc20 === 'string' ? req.body.trc20.trim() : '';
  const bep20 = typeof req.body.bep20 === 'string' ? req.body.bep20.trim() : '';
  if (trc20 && !TRC20_RE.test(trc20)) return res.status(400).json({ error: 'That TRC-20 address doesn\'t look right. It should start with "T" and be 34 characters long.' });
  if (bep20 && !BEP20_RE.test(bep20)) return res.status(400).json({ error: 'That BEP-20 address doesn\'t look right. It should start with "0x" followed by 40 letters/numbers.' });

  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };
    user.walletAddress = user.walletAddress || {};
    const current = { trc20: user.walletAddress.trc20 || '', bep20: user.walletAddress.bep20 || user.walletAddress.erc20 || '' };

    const wanted = { trc20, bep20 };
    const added = [], changed = [];
    for (const net of ['trc20', 'bep20']) {
      if (!wanted[net] || wanted[net] === current[net]) continue;
      (current[net] ? changed : added).push(net);
    }
    if (!added.length && !changed.length) {
      return { status: 400, body: { error: 'No changes — your saved wallet address is already up to date.', walletAddress: current } };
    }

    const now = new Date();
    if (changed.length && user.walletAddressUpdatedAt) {
      const hoursSince = (now - new Date(user.walletAddressUpdatedAt)) / (1000 * 60 * 60);
      if (hoursSince < 48) {
        const remaining = 48 - hoursSince;
        const days = Math.floor(remaining / 24);
        const hours = Math.floor(remaining % 24);
        const mins = Math.floor((remaining * 60) % 60);
        return {
          status: 400,
          body: { error: `You changed your wallet address recently. You can change it again in ${days} days ${hours} hours ${mins} min.`, cooldown: true }
        };
      }
    }

    for (const net of [...added, ...changed]) user.walletAddress[net] = wanted[net];
    // Keep erc20 in sync with bep20 for withdrawal compatibility
    if (wanted.bep20 && [...added, ...changed].includes('bep20')) user.walletAddress.erc20 = wanted.bep20;
    if (changed.length) user.walletAddressUpdatedAt = now.toISOString(); // starts the 48h withdrawal hold
    user.walletAddressSavedAt = now.toISOString();
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
      action: changed.length ? 'changed' : 'added',
      networks: [...added, ...changed],
      submittedAt: now.toISOString()
    });

    const holdStarted = changed.length > 0;
    return { status: 200, body: {
      message: holdStarted ? 'Wallet address changed. For your security, withdrawals are paused for 48 hours.' : 'Wallet address saved',
      holdStarted,
      walletAddress: { trc20: user.walletAddress.trc20 || '', bep20: user.walletAddress.bep20 || user.walletAddress.erc20 || '' }
    } };
  });

  // A payout wallet shared with another account is a strong multi-account signal.
  if (result.status === 200) scheduleRiskRecompute([req.userId], { propagate: true });
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

// Every team commission the user has earned, with the member whose deposit paid it and that
// member's level (A/B/C). The commission's refId is the deposit id, which identifies the member.
app.get('/api/user/team/rebates', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.data->>'amount' AS amount, t.data->>'createdAt' AS created_at, t.data->>'description' AS description,
           d.user_id AS member_id, u.data->>'username' AS username, tm.data->>'tier' AS tier
    FROM app.transactions t
    LEFT JOIN app.deposits d ON d.id = t.data->>'refId'
    LEFT JOIN app.users u ON u.id = d.user_id
    LEFT JOIN app.teams tm ON tm.user_id = t.user_id AND tm.member_id = d.user_id
    WHERE t.user_id = $1 AND t.data->>'type' = 'team_commission'
    ORDER BY t.seq DESC`, [req.userId]);

  res.json(rows.map(r => ({
    memberId: r.member_id,
    username: r.username || 'Unknown',
    // Older rows may predate the team link; the description always names the level.
    tier: r.tier || (/Level ([ABC])/.exec(r.description || '') || [])[1] || null,
    amount: parseFloat(r.amount) || 0,
    date: r.created_at
  })));
});

// Orders placed by the user's team (reservations, stakes and Earn plans), newest first.
// Each branch filters by member id first so the user_id indexes are used.
app.get('/api/user/team/orders', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    WITH m AS (SELECT member_id, data->>'tier' AS tier FROM app.teams WHERE user_id = $1)
    SELECT o.kind, o.data, o.at, m.tier, u.data->>'username' AS username FROM (
      SELECT 'reserve' AS kind, user_id, data, data->>'reservationDate' AS at FROM app.reserve_orders WHERE user_id IN (SELECT member_id FROM m)
      UNION ALL
      SELECT 'stake', user_id, data, data->>'startDate' FROM app.user_stakes WHERE user_id IN (SELECT member_id FROM m)
      UNION ALL
      SELECT 'earn', user_id, data, data->>'startDate' FROM app.earn_positions WHERE user_id IN (SELECT member_id FROM m)
    ) o
    JOIN m ON m.member_id = o.user_id
    LEFT JOIN app.users u ON u.id = o.user_id
    ORDER BY o.at DESC
    LIMIT 2000`, [req.userId]);

  res.json(rows.map(r => {
    const d = r.data || {};
    const base = { type: r.kind, username: r.username || 'Unknown', tier: r.tier, date: r.at, status: d.status || '' };
    if (r.kind === 'reserve') return { ...base, name: d.itemName || `LV${d.level}`, orderNumber: d.orderNumber || '', amount: d.reservationAmount || 0, profit: d.reward || 0 };
    if (r.kind === 'stake') return { ...base, name: `${d.nftName || 'Stake'} ${d.nftNumber || ''}`.trim(), orderNumber: '', amount: d.pledgeValue || 0, profit: d.income || 0 };
    return { ...base, name: d.planName || 'Earn', orderNumber: '', amount: d.amount || 0, profit: d.income || 0 };
  }));
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

// Three rounds a day: a user can reserve again 8 hours after their last reservation. A level's
// reward % is per day, so each round pays a third of it and three rounds add up to the full %.
const RESERVE_ROUNDS_PER_DAY = 3;
const RESERVE_COOLDOWN_MS = (24 / RESERVE_ROUNDS_PER_DAY) * 60 * 60 * 1000;
const roundPctOf = level => parseFloat((level.rewardPct / RESERVE_ROUNDS_PER_DAY).toFixed(4));

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
    roundsPerDay: RESERVE_ROUNDS_PER_DAY,
    roundHours: RESERVE_COOLDOWN_MS / 3600000,
    levels: RESERVE_LEVELS.map(lv => ({ ...lv, roundPct: roundPctOf(lv) })),
    orders: myOrders
  });
});

app.post('/api/reserve/orders', authMiddleware, async (req, res) => {
  const emails = [];
  const result = await tx(async c => {
    // Locking the user first also serializes the 8h cooldown check, so a double-click can't reserve twice.
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    const existingOrders = await db.listDocs(c, 'reserve_orders', { userId: req.userId });
    const nextReservationAt = getNextReservationAt(existingOrders);
    if (nextReservationAt) return { status: 400, body: { error: `You can reserve once every ${RESERVE_COOLDOWN_MS / 3600000} hours (${RESERVE_ROUNDS_PER_DAY} rounds a day)`, nextReservationAt } };

    const RESERVE_LEVELS = await getReserveLevels(c);
    const balance = user.walletBalance;
    const affordableLevels = RESERVE_LEVELS.filter(lv => lv.min <= balance);
    if (!affordableLevels.length) return { status: 400, body: { error: `Insufficient balance. Minimum reservation is ${RESERVE_LEVELS[0].min} USDT` } };

    // The user picks a level from the dropdown; without one (older app versions) a random affordable level is used.
    let level;
    if (req.body && req.body.level !== undefined && req.body.level !== null) {
      level = RESERVE_LEVELS.find(lv => lv.level === Number(req.body.level));
      if (!level) return { status: 400, body: { error: 'That reservation level is not available' } };
      if (level.min > balance) return { status: 400, body: { error: `Your balance is too low for Level ${level.level}. You need at least ${level.min} USDT.` } };
    } else {
      level = affordableLevels[Math.floor(Math.random() * affordableLevels.length)];
    }
    const maxAmount = Math.min(level.max, balance);
    const amount = parseFloat((level.min + Math.random() * (maxAmount - level.min)).toFixed(2));

    user.walletBalance -= amount;

    const cfg = await getConfig(c);
    const winRatePct = cfg.reserveWinRatePct !== undefined ? parseFloat(cfg.reserveWinRatePct) : 70;
    const won = Math.random() * 100 < winRatePct;
    // Rounded once, so the amount shown on the order is exactly what gets credited.
    const roundPct = roundPctOf(level);
    const reward = won ? parseFloat((amount * (roundPct / 100)).toFixed(2)) : 0;

    const order = {
      id: generateId(),
      userId: req.userId,
      orderNumber: generateOrderNumber(),
      reservationDate: new Date().toISOString(),
      reservationAmount: amount,
      level: level.level,
      rewardPct: level.rewardPct, // per day
      roundPct,                   // what this round paid (rewardPct / rounds per day)
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
  // Rejected withdrawals the admin hid: drop both the withdrawal and its refund from the history
  // (together they net to zero, so the remaining balanceAfter figures still line up).
  const hiddenWithdrawals = new Set(withdrawals.filter(w => w.status === 'Rejected' && w.hiddenFromUser).map(w => w.id));

  const totalWithdrawn = withdrawals.filter(w => w.status === 'Approved').reduce((s, w) => s + w.amount, 0);
  const notWithdrawn = user.totalIncome - totalWithdrawn;

  // Everything that changed the balance comes from the ledger. Deposits/withdrawals the ledger doesn't
  // cover (still pending, rejected, or from before the ledger existed) come from their own records.
  const txs = (await db.listDocs(pool, 'transactions', { userId: req.userId }))
    .filter(t => !((t.type === 'withdrawal' || t.type === 'withdrawal_refund') && hiddenWithdrawals.has(t.refId)));
  const ledgerDeposits = new Set(txs.filter(t => t.type === 'deposit').map(t => t.refId));
  const ledgerWithdrawals = new Set(txs.filter(t => t.type === 'withdrawal').map(t => t.refId));
  const withdrawalById = Object.fromEntries(withdrawals.map(w => [w.id, w]));
  const withdrawalStatus = w => !w ? 'Completed'
    : w.status === 'Approved' ? 'Completed' : w.status === 'Rejected' ? 'Rejected' : w.status === 'Cancelled' ? 'Cancelled' : 'Processing';
  // Pending withdrawals can still be cancelled by the user (see POST /api/withdrawals/:id/cancel).
  const withdrawalExtras = w => w ? { withdrawalId: w.id, cancellable: w.status === 'Pending' } : {};

  const history = [
    ...txs.map(t => ({
      kind: t.type,
      type: TX_LABELS[t.type] || t.type,
      description: t.description || '',
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      date: t.createdAt,
      status: t.type === 'withdrawal' ? withdrawalStatus(withdrawalById[t.refId]) : 'Completed',
      ...(t.type === 'withdrawal' ? withdrawalExtras(withdrawalById[t.refId]) : {})
    })),
    ...withdrawals.filter(w => !ledgerWithdrawals.has(w.id) && !hiddenWithdrawals.has(w.id)).map(w => ({
      kind: 'withdrawal', type: TX_LABELS.withdrawal, description: '', amount: -w.amount, date: w.createdAt, status: withdrawalStatus(w),
      ...withdrawalExtras(w)
    })),
    // Unpaid automatic deposit requests that expired or were cancelled never involved any money.
    ...deposits.filter(d => !ledgerDeposits.has(d.id) && d.status !== 'Expired' && d.status !== 'Cancelled').map(d => ({
      kind: 'deposit', type: TX_LABELS.deposit,
      description: d.status === 'Pending' ? (d.auto ? 'Waiting for payment' : 'Waiting for confirmation') : d.status === 'Rejected' ? 'Not credited' : '',
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

// Admin-set minimum per withdrawal (Settings); 0 / unset means no minimum.
function minWithdrawalOf(config) {
  const v = parseFloat(config.minWithdrawal);
  return v > 0 ? v : 0;
}

app.post('/api/withdrawals', authMiddleware, async (req, res) => {
  const { amount, walletType } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const minWithdrawal = minWithdrawalOf(await getConfig());
  if (amount < minWithdrawal) return res.status(400).json({ error: `The minimum withdrawal is ${fmtMoney(minWithdrawal)} USDT.`, minWithdrawal });

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
    // Rescore so the admin sees up-to-date risk next to this withdrawal. The request itself is never
    // refused for risk (and never for shared IP): risky ones are only marked for review (risk.js).
    scheduleRiskRecompute([req.userId], { propagate: true });
  }
  res.status(result.status).json(result.body);
});

// Users can cancel a withdrawal while it's still Pending; the full amount goes back to their balance.
// Locks the withdrawal before the user, the same order the admin approve/reject route uses, so a cancel
// racing an admin decision can't deadlock — whichever commits first wins and the other sees the new status.
app.post('/api/withdrawals/:id/cancel', authMiddleware, async (req, res) => {
  const result = await tx(async c => {
    const w = await db.getDoc(c, 'withdrawals', req.params.id, { lock: true });
    if (!w || w.userId !== req.userId) return { status: 404, body: { error: 'Withdrawal not found' } };
    if (w.status !== 'Pending') return { status: 400, body: { error: `This withdrawal can no longer be cancelled (it is ${w.status.toLowerCase()}).` } };
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };

    w.status = 'Cancelled';
    w.cancelledAt = new Date().toISOString();
    await db.saveDoc(c, 'withdrawals', w);
    user.walletBalance += w.amount;
    user.totalWithdrawn -= w.amount;
    await recordTx(c, user, 'withdrawal_cancelled', w.amount, 'You cancelled this withdrawal — amount returned', w.id);
    await db.saveUser(c, user);
    return { status: 200, body: { message: 'Withdrawal cancelled. The amount is back in your balance.', withdrawal: w, walletBalance: user.walletBalance } };
  });
  if (result.status === 200) {
    const { subject, html } = withdrawalEmail('cancelled', result.body.withdrawal);
    sendEmail(result.body.withdrawal.email, subject, html).catch(() => {});
  }
  res.status(result.status).json(result.body);
});

app.get('/api/withdrawals', authMiddleware, async (req, res) => {
  const withdrawals = await db.listDocs(pool, 'withdrawals', { userId: req.userId });
  res.json(withdrawals.filter(w => !(w.status === 'Rejected' && w.hiddenFromUser)));
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

// Which proof fields the deposit form shows/requires. Both default to on; the admin can switch either
// off in Settings (e.g. to make depositing quicker).
function depositProofSettings(config) {
  return {
    screenshotEnabled: config.depositScreenshotEnabled !== false,
    txidEnabled: config.depositTxidEnabled !== false
  };
}

// Automatic deposits: the user is shown this long to send the exact amount. A payment that arrives
// later (up to depositWatch.MATCH_WINDOW_MS after the request) is still matched and credited.
const AUTO_DEPOSIT_PAY_WINDOW_MS = 5 * 60 * 1000;
// The watcher keeps polling fast this long after a request is made, so a payment sent near the end of
// the countdown (or a little after) is still credited within seconds.
const AUTO_DEPOSIT_FAST_POLL_MS = 30 * 60 * 1000;
const MAX_OPEN_AUTO_DEPOSITS = 3;      // per user, waiting for payment at the same time
const MAX_AUTO_DEPOSITS_PER_DAY = 10;  // per user and network; each one reserves an amount for 24h
const autoDepositsOn = config => config.autoDepositEnabled === true;

async function createAutoDeposit(userId, config, network, amount) {
  const address = network === 'bep20' ? config.depositAddressBep20 : config.depositAddressTrc20;
  if (!address) return { status: 400, body: { error: 'This network is not available yet — choose another' } };
  const base = Math.floor(parseFloat(amount));
  const minDeposit = config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50;
  if (!(base >= minDeposit)) return { status: 400, body: { error: `Minimum deposit is $${minDeposit}` } };
  if (base > 1000000) return { status: 400, body: { error: 'Amount is too large' } };

  return tx(async c => {
    // One request at a time picks an amount, so two requests can never be given the same one.
    await c.query('SELECT pg_advisory_xact_lock(424246)');
    const since = new Date(Date.now() - depositWatch.MATCH_WINDOW_MS).toISOString();
    const { rows } = await c.query(`SELECT user_id, data FROM app.deposits
      WHERE data->>'auto' = 'true' AND data->>'network' = $1 AND data->>'createdAt' > $2`, [network, since]);
    const mine = rows.filter(r => r.user_id === userId).map(r => r.data);
    if (mine.length >= MAX_AUTO_DEPOSITS_PER_DAY) {
      return { status: 429, body: { error: 'Too many deposit requests today on this network. Please try again later.' } };
    }
    const nowIso = new Date().toISOString();
    if (mine.filter(d => d.status === 'Pending' && d.expiresAt > nowIso).length >= MAX_OPEN_AUTO_DEPOSITS) {
      return { status: 400, body: { error: 'You already have deposits waiting for payment. Pay or cancel one first.' } };
    }
    const payAmount = depositWatch.pickPayAmount(base, new Set(rows.map(r => depositWatch.amountToMicro(r.data.payAmount))));
    if (payAmount === null) return { status: 400, body: { error: 'Too many deposits of this amount right now. Please try a different amount.' } };

    const deposit = {
      id: generateId(),
      userId,
      amount: payAmount,
      requestedAmount: base,
      payAmount,
      network,
      address,
      auto: true,
      txid: '',
      status: 'Pending',
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + AUTO_DEPOSIT_PAY_WINDOW_MS).toISOString()
    };
    await db.insertDoc(c, 'deposits', deposit);
    return { status: 200, body: deposit };
  });
}

app.post('/api/deposits', authMiddleware, async (req, res) => {
  const { amount, network, txid, screenshot, mode } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (network !== 'trc20' && network !== 'bep20') return res.status(400).json({ error: 'Select a deposit network' });

  const config = await getConfig();
  // With automatic deposits on, the user gets an exact amount to send instead of uploading proof.
  // mode 'manual' keeps the proof form for payments that didn't match (e.g. a wrong amount was sent).
  if (autoDepositsOn(config) && mode !== 'manual') {
    const result = await createAutoDeposit(req.userId, config, network, amount);
    return res.status(result.status).json(result.body);
  }

  const { screenshotEnabled, txidEnabled } = depositProofSettings(config);
  const cleanTxid = txidEnabled && typeof txid === 'string' ? txid.trim() : '';
  if (cleanTxid.length > 120) return res.status(400).json({ error: 'Transaction ID is too long' });
  if (await findCreditedTxid(pool, cleanTxid)) return res.status(400).json({ error: 'This transaction has already been credited.' });
  // With screenshots switched off, any image sent anyway (e.g. from an old open page) is ignored.
  let proof = null;
  if (screenshotEnabled) {
    proof = decodeImageDataUrl(screenshot, MAX_PROOF_BYTES);
    if (!proof) return res.status(400).json({ error: 'Please upload a screenshot of your transfer (PNG, JPG or WEBP, max 5 MB)' });
  }

  const minDeposit = config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50;
  if (amount < minDeposit) return res.status(400).json({ error: `Minimum deposit is $${minDeposit}` });

  const deposit = {
    id: generateId(),
    userId: req.userId,
    amount: parseFloat(amount),
    network,
    txid: cleanTxid,
    ...(proof ? { proofName: PRIVATE_UPLOAD_PREFIX + generateId() + '.' + proof.ext } : {}),
    status: 'Pending',
    createdAt: new Date().toISOString()
  };
  await tx(async c => {
    if (proof) await c.query('INSERT INTO app.uploads (name, content_type, bytes) VALUES ($1, $2, $3)', [deposit.proofName, proof.contentType, proof.bytes]);
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

// Cancels an automatic deposit request that hasn't been paid. If the payment still arrives within
// 24 hours it is credited anyway, so cancelling can never lose a user's money.
app.post('/api/deposits/:id/cancel', authMiddleware, async (req, res) => {
  const result = await tx(async c => {
    const d = await db.getDoc(c, 'deposits', req.params.id, { lock: true });
    if (!d || d.userId !== req.userId) return { status: 404, body: { error: 'Deposit not found' } };
    if (!d.auto || (d.status !== 'Pending' && d.status !== 'Expired')) return { status: 400, body: { error: 'This deposit can no longer be cancelled' } };
    d.status = 'Cancelled';
    d.processedAt = new Date().toISOString();
    return { status: 200, body: await db.saveDoc(c, 'deposits', d) };
  });
  res.status(result.status).json(result.body);
});

// The user pastes the transaction ID of a payment they made for one of their automatic deposit requests
// (e.g. they sent a different amount than shown, so it couldn't be matched by amount). The server reads
// the transaction from the blockchain and credits what actually arrived to this user's account.
// Transactions are public, so a TxID alone doesn't prove who paid: the claim must fit a request this
// user made before the payment (same network, amount within 10%), and the payment must not already
// belong to someone else (by exact amount or by a wallet that has paid for another account).
const txidClaimLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => getClientIp(req),
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});
const TXID_CLAIM_TOLERANCE = 0.10;

app.post('/api/deposits/claim-txid', txidClaimLimiter, authMiddleware, async (req, res) => {
  const { network, depositId } = req.body;
  if (network !== 'trc20' && network !== 'bep20') return res.status(400).json({ error: 'Select a deposit network' });
  const txid = depositWatch.normalizeTxid(network, req.body.txid);
  if (!txid) return res.status(400).json({ error: network === 'bep20'
    ? 'That doesn\'t look like a BEP20 transaction ID. It should be "0x" followed by 64 characters.'
    : 'That doesn\'t look like a TRC20 transaction ID. It should be 64 letters and numbers.' });
  const config = await getConfig();
  if (!autoDepositsOn(config)) return res.status(400).json({ error: 'Automatic deposits are switched off. Please submit your deposit for review.' });
  const address = network === 'bep20' ? config.depositAddressBep20 : config.depositAddressTrc20;
  if (!address) return res.status(400).json({ error: 'This network is not available' });

  let found;
  try {
    found = network === 'trc20'
      ? await depositWatch.lookupTronTx({ txid, address, apiKey: process.env.TRONGRID_API_KEY })
      : await depositWatch.lookupBscTx({ txid, address, rpcUrl: BSC_RPC_URL, confirmations: BSC_CONFIRMATIONS });
  } catch (e) {
    console.error('[Deposits] TxID lookup failed:', e.message);
    return res.status(503).json({ error: 'Could not reach the blockchain right now. Please try again in a minute.' });
  }
  const netName = network === 'bep20' ? 'BNB Smart Chain (BEP20)' : 'Tron (TRC20)';
  if (found.state === 'notfound') return res.status(400).json({ error: `Transaction not found on ${netName}. Check the TxID and the network, or wait a minute if you just sent it.` });
  if (found.state === 'pending') return res.status(409).json({ pending: true, error: 'Your payment is still being confirmed on the blockchain. Please try again in a minute.' });
  if (found.state === 'failed') return res.status(400).json({ error: 'This transaction failed on the blockchain, so no USDT arrived.' });
  if (!found.transfers.length) return res.status(400).json({ error: `This transaction did not send USDT to our ${netName} deposit address.` });
  if (found.transfers.length > 1) return res.status(400).json({ error: 'This transaction has several transfers. Please submit it for review.' });
  const t = found.transfers[0];
  const received = t.micro / 1e6;

  const emails = [];
  const result = await tx(async c => {
    await c.query(`INSERT INTO app.deposit_transfers (network, txid, from_address, to_address, amount, block_time)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [t.network, t.txid, t.from, t.to, received.toFixed(6), t.timeMs ? new Date(t.timeMs).toISOString() : null]);
    const row = (await c.query('SELECT status, deposit_id FROM app.deposit_transfers WHERE network = $1 AND txid = $2 FOR UPDATE', [t.network, t.txid])).rows[0];
    const creditedId = (row && row.deposit_id) || await findCreditedTxid(c, t.txid);
    if (creditedId) {
      const prev = await db.getDoc(c, 'deposits', creditedId);
      return prev && prev.userId === req.userId
        ? { status: 200, body: { ...prev, alreadyCredited: true } }
        : { status: 400, body: { error: 'This transaction has already been credited.' } };
    }
    if (row && row.status === 'ignored') return { status: 400, body: { error: 'This payment needs to be checked by support. Please contact us.' } };

    // Requests (any user's) this payment could belong to.
    const since = new Date(t.timeMs - depositWatch.MATCH_WINDOW_MS).toISOString();
    const { rows } = await c.query(`SELECT data FROM app.deposits WHERE data->>'auto' = 'true' AND data->>'network' = $1
      AND data->>'status' IN ('Pending', 'Expired', 'Cancelled') AND data->>'createdAt' > $2`, [network, since]);
    const requests = rows.map(r => r.data);
    const exact = depositWatch.findMatch(t, requests.map(d => ({
      id: d.id, userId: d.userId, network: d.network, payMicro: depositWatch.amountToMicro(d.payAmount), createdAtMs: Date.parse(d.createdAt)
    })));
    if (exact && exact.userId !== req.userId) return { status: 400, body: { error: 'This payment belongs to another deposit request.' } };
    const owner = await findSenderOwner(c, t);
    if (owner && owner !== req.userId) return { status: 400, body: { error: 'This payment was sent from a wallet linked to another account. Please contact support.' } };

    const fits = d => d.userId === req.userId &&
      t.timeMs >= Date.parse(d.createdAt) - depositWatch.CLOCK_SKEW_MS &&
      t.timeMs <= Date.parse(d.createdAt) + depositWatch.MATCH_WINDOW_MS &&
      Math.abs(received - d.requestedAmount) <= d.requestedAmount * TXID_CLAIM_TOLERANCE;
    // The request on the user's screen first, then their newest.
    const mine = requests.filter(d => d.userId === req.userId);
    const pick = exact ? mine.find(d => d.id === exact.id)
      : mine.filter(fits).sort((a, b) => (b.id === depositId) - (a.id === depositId) || b.createdAt.localeCompare(a.createdAt))[0];
    if (!pick) {
      const late = mine.length && mine.every(d => t.timeMs < Date.parse(d.createdAt) - depositWatch.CLOCK_SKEW_MS);
      return { status: 400, body: { error: late
        ? 'This payment was sent before your deposit request, so it can\'t be verified automatically. Please submit it for review.'
        : `We couldn't match ${fmtMoney(received)} USDT to a recent deposit request of yours on this network. Please submit it for review.` } };
    }
    const minDeposit = config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50;
    if (received < minDeposit) return { status: 400, body: { error: `Only ${fmtMoney(received)} USDT arrived, below the minimum deposit of ${minDeposit} USDT. Please contact support.` } };

    const d = await db.getDoc(c, 'deposits', pick.id, { lock: true });
    if (!d || d.status === 'Approved' || d.status === 'Rejected') return { status: 400, body: { error: 'This deposit request has already been processed.' } };
    await approveWithTransfer(c, d, t, emails, exact ? undefined : 'txid');
    return { status: 200, body: d };
  });
  sendQueuedEmails(emails);
  if (result.status === 200 && !result.body.alreadyCredited) console.log(`[Deposits] Credited ${received} USDT (${network}) by TxID to user ${req.userId}, tx ${txid}`);
  res.status(result.status).json(result.body);
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

// ===================== GIFT REWARDS =====================
// Admin-created rewards shown behind the gift icon on the My page. Each one can be claimed
// once per user while it is active and not expired; claimed ids are kept on the user row,
// which is locked while claiming so a double tap can't pay twice.

async function getGiftRewards(c = pool) {
  return (await db.getSetting(c, 'gift_rewards')).rewards || [];
}

// A locked reward can still be opened for individual users (e.g. once they meet its requirement).
function giftRewardLockedFor(r, userId) {
  return !!r.locked && !(r.unlockedFor || []).includes(userId);
}

function giftRewardOpen(r) {
  return r.active !== false && (!r.endsAt || new Date(r.endsAt).getTime() > Date.now());
}

app.get('/api/rewards', authMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const claimed = new Set(user.claimedRewards || []);
  res.json((await getGiftRewards()).filter(giftRewardOpen).map(r => ({
    id: r.id, title: r.title, description: r.description || '', amount: r.amount, endsAt: r.endsAt || null,
    requirement: r.requirement || '', locked: giftRewardLockedFor(r, user.id), claimed: claimed.has(r.id)
  })));
});

app.post('/api/rewards/:id/claim', authMiddleware, async (req, res) => {
  const emails = [];
  const result = await tx(async c => {
    const user = await db.getUser(c, req.userId, { lock: true });
    if (!user) return { status: 404, body: { error: 'User not found' } };
    const reward = (await getGiftRewards(c)).find(r => r.id === req.params.id);
    if (!reward || !giftRewardOpen(reward)) return { status: 404, body: { error: 'This reward is no longer available' } };
    if (giftRewardLockedFor(reward, user.id)) return { status: 400, body: { error: reward.requirement ? 'This reward is locked. To unlock it: ' + reward.requirement : 'This reward is locked. It will open soon.' } };
    user.claimedRewards = user.claimedRewards || [];
    if (user.claimedRewards.includes(reward.id)) return { status: 400, body: { error: 'You have already claimed this reward' } };

    const amount = parseFloat(Number(reward.amount).toFixed(2));
    user.claimedRewards.push(reward.id);
    user.walletBalance += amount;
    await recordTx(c, user, 'gift_reward', amount, reward.title, reward.id);
    user.totalIncome += amount;
    user.dailyIncome = user.dailyIncome || {};
    user.dailyIncome.activity = (user.dailyIncome.activity || 0) + amount;
    checkAndApplyLevelUpgrade(user, await getConfig(c), emails);
    await db.saveUser(c, user);
    return { status: 200, body: { claimed: amount, title: reward.title, walletBalance: user.walletBalance } };
  });
  sendQueuedEmails(emails);
  res.status(result.status).json(result.body);
});

app.get('/api/admin/rewards', adminMiddleware, async (req, res) => {
  const rewards = await getGiftRewards();
  const { rows } = await pool.query(`
    SELECT data->>'refId' AS id, COUNT(*)::int AS claims, COALESCE(SUM((data->>'amount')::numeric), 0)::float AS paid
    FROM app.transactions WHERE data->>'type' = 'gift_reward' GROUP BY 1`);
  const stats = Object.fromEntries(rows.map(r => [r.id, r]));
  // names for the users each reward was unlocked for
  const ids = [...new Set(rewards.flatMap(r => r.unlockedFor || []))];
  const names = {};
  if (ids.length) {
    const u = await pool.query("SELECT id, uid, data->>'username' AS username FROM app.users WHERE id = ANY($1)", [ids]);
    u.rows.forEach(x => { names[x.id] = { id: x.id, uid: x.uid, username: x.username }; });
  }
  res.json(rewards.map(r => ({
    ...r, claims: stats[r.id]?.claims || 0, paid: stats[r.id]?.paid || 0,
    unlockedUsers: (r.unlockedFor || []).map(id => names[id] || { id, uid: '', username: '(deleted user)' })
  })));
});

function validateGiftReward(body) {
  const title = String(body.title || '').trim().slice(0, 80);
  const description = String(body.description || '').trim().slice(0, 300);
  const requirement = String(body.requirement || '').trim().slice(0, 200);
  const amount = parseFloat(body.amount);
  if (!title) return { error: 'Give the reward a title' };
  if (!(amount > 0) || amount > 100000) return { error: 'Amount must be between 0.01 and 100,000 USDT' };
  let endsAt = null;
  if (body.endsAt) {
    const t = new Date(body.endsAt);
    if (isNaN(t)) return { error: 'Invalid end date' };
    endsAt = t.toISOString();
  }
  return { reward: { title, description, amount: parseFloat(amount.toFixed(2)), endsAt, active: body.active !== false, locked: !!body.locked, requirement } };
}

app.post('/api/admin/rewards', adminMiddleware, async (req, res) => {
  const { reward, error } = validateGiftReward(req.body);
  if (error) return res.status(400).json({ error });
  const saved = await tx(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('gift_rewards'))");
    const rewards = await getGiftRewards(c);
    const r = { id: generateId(), ...reward, createdAt: new Date().toISOString() };
    rewards.unshift(r);
    await db.setSetting(c, 'gift_rewards', { rewards });
    return r;
  });
  res.json(saved);
});

app.put('/api/admin/rewards/:id', adminMiddleware, async (req, res) => {
  const { reward, error } = validateGiftReward(req.body);
  if (error) return res.status(400).json({ error });
  const saved = await tx(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('gift_rewards'))");
    const rewards = await getGiftRewards(c);
    const i = rewards.findIndex(r => r.id === req.params.id);
    if (i < 0) return null;
    rewards[i] = { ...rewards[i], ...reward };
    await db.setSetting(c, 'gift_rewards', { rewards });
    return rewards[i];
  });
  if (!saved) return res.status(404).json({ error: 'Reward not found' });
  res.json(saved);
});

app.put('/api/admin/rewards/:id/lock', adminMiddleware, async (req, res) => {
  const saved = await tx(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('gift_rewards'))");
    const rewards = await getGiftRewards(c);
    const r = rewards.find(x => x.id === req.params.id);
    if (!r) return null;
    r.locked = !!req.body.locked;
    await db.setSetting(c, 'gift_rewards', { rewards });
    return r;
  });
  if (!saved) return res.status(404).json({ error: 'Reward not found' });
  res.json(saved);
});

// Unlock a locked reward for one user (found by UID, email or username), or lock it for them again.
async function findUserForAdmin(c, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  return (await db.findUserBy(c, 'uid', q.toUpperCase())) || (await db.findUserBy(c, 'uid', q))
    || (await db.findUserBy(c, 'username_lower', q.toLowerCase()))
    || (await c.query('SELECT data FROM app.users WHERE lower(email) = lower($1) ORDER BY seq LIMIT 1', [q])).rows[0]?.data || null;
}

app.post('/api/admin/rewards/:id/unlock-user', adminMiddleware, async (req, res) => {
  const result = await tx(async c => {
    const user = await findUserForAdmin(c, req.body.user);
    if (!user) return { status: 404, body: { error: 'No user found with that UID, email or username' } };
    await c.query("SELECT pg_advisory_xact_lock(hashtext('gift_rewards'))");
    const rewards = await getGiftRewards(c);
    const r = rewards.find(x => x.id === req.params.id);
    if (!r) return { status: 404, body: { error: 'Reward not found' } };
    r.unlockedFor = r.unlockedFor || [];
    if (r.unlockedFor.includes(user.id)) return { status: 400, body: { error: user.username + ' already has this reward unlocked' } };
    r.unlockedFor.push(user.id);
    await db.setSetting(c, 'gift_rewards', { rewards });
    return { status: 200, body: { success: true, user: { id: user.id, uid: user.uid, username: user.username } } };
  });
  res.status(result.status).json(result.body);
});

app.delete('/api/admin/rewards/:id/unlock-user/:userId', adminMiddleware, async (req, res) => {
  const ok = await tx(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('gift_rewards'))");
    const rewards = await getGiftRewards(c);
    const r = rewards.find(x => x.id === req.params.id);
    if (!r || !(r.unlockedFor || []).includes(req.params.userId)) return false;
    r.unlockedFor = r.unlockedFor.filter(id => id !== req.params.userId);
    await db.setSetting(c, 'gift_rewards', { rewards });
    return true;
  });
  if (!ok) return res.status(404).json({ error: 'Not unlocked for that user' });
  res.json({ success: true });
});

app.delete('/api/admin/rewards/:id', adminMiddleware, async (req, res) => {
  const removed = await tx(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('gift_rewards'))");
    const rewards = await getGiftRewards(c);
    const left = rewards.filter(r => r.id !== req.params.id);
    if (left.length === rewards.length) return false;
    await db.setSetting(c, 'gift_rewards', { rewards: left });
    return true;
  });
  if (!removed) return res.status(404).json({ error: 'Reward not found' });
  res.json({ success: true });
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

// ===================== ACCOUNT DELETION =====================
// Follows the Privacy Policy / delete-account page: personal data is wiped, but the user row stays as
// an anonymous stub (UID only) so deposits, withdrawals and the ledger still add up for the records
// we're allowed to keep. Used by both the user (Settings) and the admin (Users page).
async function deleteUserAccount(c, userId, deletedBy) {
  const u = await db.getUser(c, userId, { lock: true });
  if (!u || u.deletedAt) return { status: 404, body: { error: 'User not found' } };

  // Money in flight has to be settled first, or it could be paid to / credited to a deleted account.
  const pending = await c.query(`
    SELECT (SELECT count(*) FROM app.withdrawals WHERE user_id = $1 AND data->>'status' = 'Pending')::int AS w,
           (SELECT count(*) FROM app.deposits WHERE user_id = $1 AND data->>'status' = 'Pending')::int AS d`, [userId]);
  if (pending.rows[0].w) return { status: 400, body: { error: deletedBy === 'admin'
    ? 'This user has a pending withdrawal. Approve or reject it first.'
    : 'You have a pending withdrawal. Cancel it or wait until it is processed, then try again.' } };
  if (pending.rows[0].d) return { status: 400, body: { error: deletedBy === 'admin'
    ? 'This user has a pending deposit. Approve or reject it first.'
    : 'You have a deposit waiting for review. Please wait until it is processed, then try again.' } };

  const avatar = typeof u.avatar === 'string' && u.avatar.match(/^\/uploads\/([\w-]+\.\w+)$/);
  if (avatar) await c.query('DELETE FROM app.uploads WHERE name = $1', [avatar[1]]);
  await c.query(`DELETE FROM app.uploads WHERE name IN (SELECT data->>'proofName' FROM app.deposits WHERE user_id = $1 AND data ? 'proofName')`, [userId]);
  await c.query(`UPDATE app.deposits SET data = data - 'proofName' WHERE user_id = $1`, [userId]);
  const anonName = 'deleted_' + u.uid;
  await c.query(`UPDATE app.withdrawals SET data = (data - 'email') || jsonb_build_object('username', $2::text) WHERE user_id = $1`, [userId, anonName]);
  await c.query('DELETE FROM app.wallet_submissions WHERE user_id = $1', [userId]);
  await c.query('DELETE FROM app.user_ips WHERE user_id = $1', [userId]);
  await c.query('DELETE FROM app.user_devices WHERE user_id = $1', [userId]);
  await c.query('DELETE FROM app.account_risk WHERE user_id = $1', [userId]);
  await c.query('DELETE FROM app.sessions WHERE user_id = $1 AND role = $2', [userId, 'user']);
  await c.query('DELETE FROM app.ephemeral WHERE (kind = $1 AND key = $2) OR (kind = $3 AND key = $4)', [EPH_2FA_SETUP, userId, EPH_RESET, u.email]);

  const unusable = await hashPassword(crypto.randomBytes(32).toString('hex'));
  const email = u.email;
  Object.assign(u, {
    email: `deleted+${u.id}@deleted.invalid`,
    username: anonName,
    password: unusable,
    secondPassword: unusable,
    phoneCountryCode: '',
    phoneNumber: '',
    avatar: '',
    walletAddress: { trc20: '', erc20: '', bep20: '' },
    walletAddressUpdatedAt: null,
    walletAddressSavedAt: null,
    twoFactorEnabled: false,
    signupIp: '',
    lastIp: '',
    deletedAt: new Date().toISOString(),
    deletedBy
  });
  delete u.twoFactorSecret;
  await db.saveUser(c, u);
  return { status: 200, body: { message: 'Account deleted' }, email, username: anonName };
}

app.post('/api/user/delete-account', authLimiter, authMiddleware, async (req, res) => {
  const { password, code } = req.body;
  if (!password) return res.status(400).json({ error: 'Enter your password to confirm' });
  const user = await db.getUser(pool, req.userId);
  if (!user || user.deletedAt) return res.status(404).json({ error: 'User not found' });
  if (!(await verifyPassword(password, user.password))) return res.status(400).json({ error: 'Password is incorrect' });
  if (user.twoFactorEnabled && user.twoFactorSecret && !(await isValidTotp(code, user.twoFactorSecret))) {
    return res.status(400).json({ error: 'Invalid authentication code' });
  }
  const result = await tx(c => deleteUserAccount(c, req.userId, 'user'));
  res.status(result.status).json(result.body);
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
    (SELECT count(*) FROM app.users WHERE NOT data ? 'deletedAt') AS total_users,
    (SELECT coalesce(sum(${num('amount')}), 0) FROM app.deposits WHERE coalesce(data->>'status', '') NOT IN ('Expired', 'Cancelled')) AS total_deposits,
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

// Each user's total of approved deposits.
const APPROVED_DEPOSIT_TOTALS_SQL = `SELECT user_id, sum((data->>'amount')::numeric) AS total
  FROM app.deposits WHERE data->>'status' = 'Approved' GROUP BY user_id`;

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  // For each user: how many *other* accounts have used any of the same IP addresses.
  const { rows: shared } = await pool.query(`
    SELECT a.user_id, count(DISTINCT b.user_id)::int AS n
    FROM app.user_ips a JOIN app.user_ips b ON b.ip = a.ip AND b.user_id <> a.user_id
    GROUP BY a.user_id`);
  const sharedMap = Object.fromEntries(shared.map(r => [r.user_id, r.n]));
  // Each user's team (levels A/B/C): members, valid members (at least one approved deposit, as in
  // the app's Team page) and the total those members have deposited.
  const { rows: teams } = await pool.query(`
    SELECT t.user_id, count(*)::int AS registered, count(dep.user_id)::int AS valid, coalesce(sum(dep.total), 0) AS deposited
    FROM app.teams t LEFT JOIN (${APPROVED_DEPOSIT_TOTALS_SQL}) dep ON dep.user_id = t.member_id
    GROUP BY t.user_id`);
  const teamMap = Object.fromEntries(teams.map(r => [r.user_id, { registered: r.registered, valid: r.valid, deposited: Number(r.deposited) }]));
  const users = (await db.listDocs(pool, 'users')).filter(u => !u.deletedAt).map(u => {
    const online = !!u.lastActiveAt && (Date.now() - new Date(u.lastActiveAt).getTime()) < ONLINE_THRESHOLD_MS;
    return { ...publicProfile(u), online, sharedIpAccounts: sharedMap[u.id] || 0, location: ipLocation(u.lastIp || u.signupIp),
      team: teamMap[u.id] || { registered: 0, valid: 0, deposited: 0 } };
  });
  res.json(users);
});

// One user's team members with the level, whether each is valid, and how much each has deposited.
app.get('/api/admin/users/:id/team', adminMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { rows } = await pool.query(`
    SELECT t.member_id, t.data->>'tier' AS tier, t.data->>'joinedAt' AS joined_at,
           u.data->>'username' AS username, u.data->>'uid' AS uid, u.data ? 'deletedAt' AS deleted,
           dep.user_id IS NOT NULL AS is_valid, coalesce(dep.total, 0) AS deposited
    FROM app.teams t
    LEFT JOIN app.users u ON u.id = t.member_id
    LEFT JOIN (${APPROVED_DEPOSIT_TOTALS_SQL}) dep ON dep.user_id = t.member_id
    WHERE t.user_id = $1
    ORDER BY t.data->>'tier', deposited DESC, t.seq`, [user.id]);
  res.json({
    user: accountSummary(user),
    members: rows.map(r => ({
      id: r.member_id, uid: r.uid, username: r.username || 'Unknown', deleted: !!r.deleted, tier: r.tier,
      joinedAt: r.joined_at, isValid: r.is_valid, deposited: Number(r.deposited)
    }))
  });
});

// Accounts that have ever used an IP containing `q` (full address or part of one, e.g. an IPv6 prefix),
// with the matching IPs, so the Users page can search by IP.
app.get('/api/admin/users/ip-search', adminMiddleware, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 3 || q.length > 64 || !/^[0-9a-f:.]+$/.test(q)) return res.status(400).json({ error: 'Enter at least 3 characters of an IP address' });
  const { rows } = await pool.query(`
    SELECT user_id, array_agg(DISTINCT ip) AS ips FROM (
      SELECT user_id, ip FROM app.user_ips WHERE lower(ip) LIKE '%' || $1 || '%'
      UNION ALL
      SELECT id, data->>'lastIp' FROM app.users WHERE lower(data->>'lastIp') LIKE '%' || $1 || '%'
      UNION ALL
      SELECT id, data->>'signupIp' FROM app.users WHERE lower(data->>'signupIp') LIKE '%' || $1 || '%'
    ) m GROUP BY user_id LIMIT 500`, [q]);
  res.json(rows.map(r => ({ userId: r.user_id, ips: r.ips })));
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
    phoneCountryCode: u.phoneCountryCode || '', phoneNumber: u.phoneNumber || '',
    walletBalance: u.walletBalance, status: accountStatus(u), frozenUntil: u.frozenUntil || null,
    suspendReason: u.suspendReason || '', bannedAt: u.bannedAt || null, banReason: u.banReason || '',
    referredBy: u.referredBy || null, lastActiveAt: u.lastActiveAt || null, lastLoginAt: u.lastLoginAt || null,
    avatar: u.avatar || '', lastIp: u.lastIp || null, location: ipLocation(u.lastIp || u.signupIp)
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
    location: ipLocation(r.ip),
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
    user: { ...accountSummary(user), signupIp: user.signupIp || null, lastIp: user.lastIp || null, signupLocation: ipLocation(user.signupIp) },
    ips: rows.map(r => ({ ip: r.ip, location: ipLocation(r.ip), firstSeen: r.first_seen, lastSeen: r.last_seen, hits: r.hits, otherAccounts: r.other_accounts, ipBanned: r.ip_banned }))
  });
});

// ---------- risk review (device / wallet / referral / IP signals combined; see risk.js) ----------

const REVIEW_STATUSES = new Set(['open', 'cleared', 'confirmed']);

// Accounts with a risk score, highest first. ?status=open|cleared|confirmed|all, ?min=<score>.
app.get('/api/admin/risk', adminMiddleware, async (req, res) => {
  const status = REVIEW_STATUSES.has(req.query.status) ? req.query.status : null;
  const min = Math.max(0, parseInt(req.query.min, 10) || 1);
  const { rows } = await pool.query(`
    SELECT r.*, u.data AS user,
           (SELECT count(*)::int FROM app.user_devices d WHERE d.user_id = r.user_id) AS devices
    FROM app.account_risk r JOIN app.users u ON u.id = r.user_id
    WHERE r.score >= $1 AND ($2::text IS NULL OR r.review_status = $2) AND NOT u.data ? 'deletedAt'
    ORDER BY r.needs_review DESC, r.score DESC, r.computed_at DESC
    LIMIT 500`, [min, status]);
  const { rows: counts } = await pool.query(`
    SELECT review_status, count(*)::int AS n, count(*) FILTER (WHERE needs_review)::int AS review
    FROM app.account_risk WHERE score > 0 GROUP BY review_status`);
  res.json({
    counts: Object.fromEntries(counts.map(c => [c.review_status, { total: c.n, needsReview: c.review }])),
    rescanRunning: riskRescan.running,
    accounts: rows.map(r => ({
      ...accountSummary(r.user), score: r.score, level: r.level, needsReview: r.needs_review, flags: r.flags,
      linkedCount: r.linked.length, devices: r.devices, computedAt: r.computed_at,
      reviewStatus: r.review_status, reviewNote: r.review_note || '', reviewedAt: r.reviewed_at
    }))
  });
});

// Everything needed to investigate one account. Recomputes first so the admin sees current data.
app.get('/api/admin/risk/:userId', adminMiddleware, async (req, res) => {
  const user = await db.getUser(pool, req.params.userId);
  if (!user || user.deletedAt) return res.status(404).json({ error: 'User not found' });
  const risk = await recomputeRisk(user.id);
  const { rows: [review] } = await pool.query('SELECT review_note, reviewed_by, reviewed_at FROM app.account_risk WHERE user_id = $1', [user.id]);

  // Device hashes are shown shortened: enough to tell devices apart, and they mean nothing outside this server.
  const { rows: devices } = await pool.query(`
    SELECT d.device_hash, d.platform, d.first_seen, d.last_seen, d.hits, d.risk_flags,
           coalesce((SELECT json_agg(o.user_id) FROM app.user_devices o WHERE o.device_hash = d.device_hash AND o.user_id <> d.user_id), '[]') AS others
    FROM app.user_devices d WHERE d.user_id = $1 ORDER BY d.last_seen DESC`, [user.id]);

  const linkedIds = risk.linked.map(l => l.userId);
  const { rows: linkedRows } = linkedIds.length ? await pool.query(`
    SELECT u.data AS user,
      (SELECT coalesce(sum((d.data->>'amount')::numeric), 0) FROM app.deposits d WHERE d.user_id = u.id AND d.data->>'status' = 'Approved') AS deposited,
      (SELECT coalesce(sum((w.data->>'amount')::numeric), 0) FROM app.withdrawals w WHERE w.user_id = u.id AND w.data->>'status' IN ('Pending', 'Approved')) AS withdrawn
    FROM app.users u WHERE u.id = ANY($1)`, [linkedIds]) : { rows: [] };
  const linkedById = Object.fromEntries(linkedRows.map(r => [r.user.id, r]));
  const totals = async id => (await pool.query(`SELECT
      (SELECT coalesce(sum((data->>'amount')::numeric), 0) FROM app.deposits WHERE user_id = $1 AND data->>'status' = 'Approved') AS deposited,
      (SELECT coalesce(sum((data->>'amount')::numeric), 0) FROM app.withdrawals WHERE user_id = $1 AND data->>'status' IN ('Pending', 'Approved')) AS withdrawn`, [id])).rows[0];
  const own = await totals(user.id);

  res.json({
    user: { ...accountSummary(user), deposited: Number(own.deposited), withdrawn: Number(own.withdrawn) },
    risk: { ...risk, reviewNote: (review && review.review_note) || '', reviewedBy: review && review.reviewed_by, reviewedAt: review && review.reviewed_at },
    devices: devices.map(d => ({
      device: d.device_hash.slice(0, 12), platform: d.platform, firstSeen: d.first_seen, lastSeen: d.last_seen, hits: d.hits,
      riskFlags: d.risk_flags, otherAccounts: d.others.length
    })),
    linked: risk.linked.filter(l => linkedById[l.userId]).map(l => {
      const r = linkedById[l.userId];
      return { ...accountSummary(r.user), via: l.via, deleted: !!r.user.deletedAt, deposited: Number(r.deposited), withdrawn: Number(r.withdrawn) };
    })
  });
});

app.post('/api/admin/risk/:userId/review', adminMiddleware, async (req, res) => {
  const status = req.body.status;
  if (!REVIEW_STATUSES.has(status)) return res.status(400).json({ error: 'Status must be open, cleared or confirmed' });
  const note = String(req.body.note || '').trim().slice(0, 500);
  const { rows } = await pool.query(`
    UPDATE app.account_risk SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(),
      reviewed_flags = ARRAY(SELECT jsonb_array_elements(flags)->>'code')
    WHERE user_id = $1 RETURNING user_id`, [req.params.userId, status, note, req.userId || 'admin']);
  if (!rows.length) return res.status(404).json({ error: 'No risk record for this user' });
  res.json({ message: 'Saved' });
});

// Rescores every account that shares a device, wallet or IP with another account (for example after
// deploying this feature, or after changing the rules). Runs in the background.
const riskRescan = { running: false };
app.post('/api/admin/risk/rescan', adminMiddleware, async (req, res) => {
  if (riskRescan.running) return res.json({ message: 'A rescan is already running', running: true });
  const { rows } = await pool.query(`
    SELECT user_id FROM app.user_devices WHERE device_hash IN (SELECT device_hash FROM app.user_devices GROUP BY device_hash HAVING count(*) > 1)
    UNION SELECT user_id FROM app.user_ips WHERE ip IN (SELECT ip FROM app.user_ips GROUP BY ip HAVING count(*) > 1)
    UNION SELECT w.user_id FROM app.withdrawals w WHERE lower(trim(w.data->>'walletAddress')) IN (
      SELECT lower(trim(data->>'walletAddress')) FROM app.withdrawals GROUP BY 1 HAVING count(DISTINCT user_id) > 1)
    UNION SELECT user_id FROM app.account_risk`);
  riskRescan.running = true;
  (async () => {
    for (const r of rows) {
      try { await recomputeRisk(r.user_id); } catch (e) { console.error('[risk] rescan failed for', r.user_id, e.message); }
    }
  })().finally(() => { riskRescan.running = false; });
  res.json({ message: `Rescanning ${rows.length} accounts`, accounts: rows.length, running: true });
});

// Lets the admin confirm the server is seeing real visitor IPs (should match whatismyip.com).
app.get('/api/admin/my-ip', adminMiddleware, async (req, res) => {
  res.json({ ip: getClientIp(req), forwardedFor: req.headers['x-forwarded-for'] || null });
});

const MAX_SUSPEND_MS = 10 * 365 * 24 * 60 * 60 * 1000;

app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const result = await tx(c => deleteUserAccount(c, req.params.id, 'admin'));
  res.status(result.status).json(result.body);
});

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
  // The admin form sends the BEP-20 address as `erc20` (older field name); accept either.
  const trc20 = typeof req.body.trc20 === 'string' ? req.body.trc20.trim() : undefined;
  const bep20Raw = req.body.bep20 !== undefined ? req.body.bep20 : req.body.erc20;
  const bep20 = typeof bep20Raw === 'string' ? bep20Raw.trim() : undefined;
  const result = await tx(async c => {
    const u = await db.getUser(c, req.params.id, { lock: true });
    if (!u) return { status: 404, body: { error: 'User not found' } };
    u.walletAddress = u.walletAddress || {};
    const curTrc = u.walletAddress.trc20 || '';
    const curBep = u.walletAddress.bep20 || u.walletAddress.erc20 || '';
    // Admins may clear an address (empty string); a new value must be valid. Unchanged values are
    // left alone even if an old one isn't in a valid format, so they never block other edits.
    if (trc20 && trc20 !== curTrc && !TRC20_RE.test(trc20)) return { status: 400, body: { error: 'Invalid TRC-20 address (must start with "T", 34 characters)' } };
    if (bep20 && bep20 !== curBep && !BEP20_RE.test(bep20)) return { status: 400, body: { error: 'Invalid BEP-20 address (must be "0x" + 40 hex characters)' } };
    if (trc20 !== undefined && trc20 !== curTrc) u.walletAddress.trc20 = trc20;
    // Set both fields: the app shows `bep20` first, so updating only `erc20` used to have no visible effect.
    if (bep20 !== undefined && bep20 !== curBep) { u.walletAddress.bep20 = bep20; u.walletAddress.erc20 = bep20; }
    await db.saveUser(c, u);
    return { status: 200, user: u };
  });
  if (result.status !== 200) return res.status(result.status).json(result.body);
  const user = result.user;

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
  // Attach each user's current risk so risky withdrawals stand out (see withdrawalDecision in risk.js).
  const { rows } = await pool.query(`SELECT user_id, score, level, needs_review, review_status, flags FROM app.account_risk
    WHERE user_id = ANY($1) AND score > 0`, [[...new Set(withdrawals.map(w => w.userId))]]);
  const risk = Object.fromEntries(rows.map(r => {
    const decision = withdrawalDecision({ needsReview: r.needs_review && r.review_status !== 'cleared', flags: r.flags });
    return [r.user_id, { score: r.score, level: r.level, reviewStatus: r.review_status, holdForReview: decision.holdForReview, reason: decision.reason }];
  }));
  // Phone numbers, so the admin can contact the user about a withdrawal.
  const { rows: phones } = await pool.query(`SELECT id, data->>'phoneCountryCode' AS cc, data->>'phoneNumber' AS num
    FROM app.users WHERE id = ANY($1) AND coalesce(data->>'phoneNumber', '') <> ''`, [[...new Set(withdrawals.map(w => w.userId))]]);
  const phone = Object.fromEntries(phones.map(r => [r.id, { phoneCountryCode: r.cc || '', phoneNumber: r.num }]));
  res.json(withdrawals.map(w => ({ ...w, ...(phone[w.userId] || {}), ...(risk[w.userId] ? { risk: risk[w.userId] } : {}) }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.put('/api/admin/withdrawals/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;

  let previousStatus;
  const withdrawal = await tx(async c => {
    const w = await db.getDoc(c, 'withdrawals', req.params.id, { lock: true });
    if (!w) return null;

    previousStatus = w.status;
    // The user already got this money back; approving now would pay it out a second time.
    if (previousStatus === 'Cancelled') return { cancelled: true };
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
  if (withdrawal.cancelled) return res.status(400).json({ error: 'The user cancelled this withdrawal and the amount was already returned to their balance.' });

  if ((status === 'Approved' || status === 'Rejected') && status !== previousStatus) {
    const { subject, html } = withdrawalEmail(status === 'Approved' ? 'approved' : 'rejected', withdrawal);
    sendEmail(withdrawal.email, subject, html).catch(() => {});
  }

  res.json(withdrawal);
});

// Hide (or show again) a rejected withdrawal in the user's history. Only rejected ones: anything
// else still affects what the user sees as withdrawn or pending.
app.put('/api/admin/withdrawals/:id/visibility', adminMiddleware, async (req, res) => {
  const hidden = !!req.body.hidden;
  const result = await tx(async c => {
    const w = await db.getDoc(c, 'withdrawals', req.params.id, { lock: true });
    if (!w) return { status: 404, body: { error: 'Withdrawal not found' } };
    if (w.status !== 'Rejected') return { status: 400, body: { error: 'Only rejected withdrawals can be hidden.' } };
    w.hiddenFromUser = hidden;
    return { status: 200, body: await db.saveDoc(c, 'withdrawals', w) };
  });
  res.status(result.status).json(result.body);
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

// Credits a deposit that is moving into Approved: balance, ledger, level upgrade, team commission and
// the email. The caller holds the deposit's row lock and only calls this on the transition into
// Approved, so a deposit can't be credited twice. Used by admin approval and automatic deposits.
async function creditDeposit(c, d, emails) {
  const user = await db.getUser(c, d.userId, { lock: true });
  if (!user) return;
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

// Another approved deposit (or an automatically matched transfer) with this transaction hash, if any.
async function findCreditedTxid(c, txid, exceptDepositId) {
  if (!txid) return null;
  const { rows } = await c.query(`
    SELECT id FROM app.deposits WHERE lower(data->>'txid') = lower($1) AND data->>'status' = 'Approved' AND id <> $2
    UNION ALL
    SELECT deposit_id FROM app.deposit_transfers WHERE lower(txid) = lower($1) AND deposit_id IS NOT NULL AND deposit_id <> $2
    LIMIT 1`, [txid, exceptDepositId || '']);
  return rows.length ? rows[0].id : null;
}

app.put('/api/admin/deposits/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const emails = [];

  const result = await tx(async c => {
    const d = await db.getDoc(c, 'deposits', req.params.id, { lock: true });
    if (!d) return { status: 404, body: { error: 'Deposit not found' } };

    const previousStatus = d.status;
    // Only credit on the transition into Approved, so approving twice can't credit twice.
    const crediting = status === 'Approved' && previousStatus !== 'Approved';
    if (crediting && await findCreditedTxid(c, d.txid, d.id)) {
      return { status: 400, body: { error: 'This transaction ID has already been credited on another deposit.' } };
    }
    d.status = status;
    d.processedAt = new Date().toISOString();

    if (status === 'Rejected' && previousStatus !== 'Rejected') {
      const user = await db.getUser(c, d.userId);
      if (user) {
        const { subject, html } = depositEmail('rejected', user.username, d);
        emails.push([user.email, subject, html]);
      }
    }

    if (crediting) await creditDeposit(c, d, emails);
    return { status: 200, body: await db.saveDoc(c, 'deposits', d) };
  });

  if (result.status === 200) sendQueuedEmails(emails);
  res.status(result.status).json(result.body);
});

// ===================== AUTOMATIC DEPOSITS (watcher) =====================
// Runs in one process only (the primary). Each poll reads new confirmed USDT transfers to the deposit
// addresses, records every one in app.deposit_transfers (once per txid), and credits the request whose
// exact amount it pays. Anything that doesn't match stays in the admin's "Unmatched payments" list.
// Settings: TRONGRID_API_KEY (optional, raises TronGrid's rate limit), BSC_RPC_URL (BNB Chain node).
const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com';
const BSC_CONFIRMATIONS = 15;
const DEPOSIT_POLL_FAST_MS = 15 * 1000; // while someone is waiting for a payment
const DEPOSIT_POLL_IDLE_MS = 60 * 1000;

// The user a payment without a matching request belongs to, judged by the wallet it came from, or null.
// A wallet that has already funded a deposit only ever credits that same user, so copying someone
// else's sending wallet into your profile doesn't redirect their deposits. Otherwise the wallet must
// be the saved withdrawal wallet of exactly one account. Anything ambiguous is left for the admin.
async function findSenderOwner(c, t) {
  const from = String(t.from || '').toLowerCase();
  if (!from) return null;
  const prior = await c.query(`SELECT DISTINCT user_id FROM app.deposits
    WHERE lower(data->>'fromAddress') = $1 AND data->>'status' = 'Approved'`, [from]);
  const keys = t.network === 'bep20' ? ['bep20', 'erc20'] : ['trc20'];
  const saved = await c.query(`SELECT id FROM app.users WHERE NOT data ? 'deletedAt'
    AND (${keys.map(k => `lower(data->'walletAddress'->>'${k}') = $1`).join(' OR ')})`, [from]);
  const priorIds = prior.rows.map(r => r.user_id);
  const savedIds = saved.rows.map(r => r.id);
  if (priorIds.length) return priorIds.length === 1 && savedIds.every(id => id === priorIds[0]) ? priorIds[0] : null;
  return savedIds.length === 1 ? savedIds[0] : null;
}

// Credits automatic deposit request `d` (row-locked, not yet Approved) with on-chain transfer `t`,
// for the amount that actually arrived, and marks the transfer as used.
async function approveWithTransfer(c, d, t, emails, matchedBy) {
  d.status = 'Approved';
  d.processedAt = new Date().toISOString();
  d.paidAt = t.timeMs ? new Date(t.timeMs).toISOString() : d.processedAt;
  d.amount = t.micro / 1e6;
  d.txid = t.txid;
  d.fromAddress = t.from;
  d.approvedBy = 'auto';
  if (matchedBy) d.matchedBy = matchedBy;
  await creditDeposit(c, d, emails);
  await db.saveDoc(c, 'deposits', d);
  await c.query('UPDATE app.deposit_transfers SET status = $3, deposit_id = $4 WHERE network = $1 AND txid = $2', [t.network, t.txid, 'matched', d.id]);
}

// Stores one transfer and, if it pays a request (or comes from a user's own wallet), credits it.
// Safe to call again for the same transfer.
async function handleIncomingTransfer(t, match) {
  const emails = [];
  const credited = await tx(async c => {
    const amount = (t.micro / 1e6).toFixed(6);
    const ins = await c.query(`INSERT INTO app.deposit_transfers (network, txid, from_address, to_address, amount, block_time)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING txid`,
      [t.network, t.txid, t.from, t.to, amount, t.timeMs ? new Date(t.timeMs).toISOString() : null]);
    if (!ins.rows.length) return false; // already handled

    if (!match) {
      const ownerId = await findSenderOwner(c, t);
      if (!ownerId || await findCreditedTxid(c, t.txid)) return false;
      const cfg = await getConfig(c);
      const minDeposit = cfg.minDeposit !== undefined ? parseFloat(cfg.minDeposit) : 50;
      if (t.micro / 1e6 < minDeposit) return false;
      const nowIso = new Date().toISOString();
      const d = {
        id: generateId(),
        userId: ownerId,
        amount: t.micro / 1e6,
        network: t.network,
        txid: t.txid,
        fromAddress: t.from,
        status: 'Approved',
        approvedBy: 'auto',
        matchedBy: 'wallet',
        createdAt: nowIso,
        processedAt: nowIso,
        paidAt: t.timeMs ? new Date(t.timeMs).toISOString() : nowIso
      };
      await db.insertDoc(c, 'deposits', d);
      await creditDeposit(c, d, emails);
      await db.saveDoc(c, 'deposits', d);
      await c.query('UPDATE app.deposit_transfers SET status = $3, deposit_id = $4 WHERE network = $1 AND txid = $2', [t.network, t.txid, 'matched', d.id]);
      return true;
    }

    // A user may also have submitted this hash on the manual form and had it approved.
    const already = await findCreditedTxid(c, t.txid, match.id);
    const d = await db.getDoc(c, 'deposits', match.id, { lock: true });
    if (already || !d || d.status === 'Approved' || d.status === 'Rejected') {
      if (already) await c.query('UPDATE app.deposit_transfers SET status = $3, deposit_id = $4 WHERE network = $1 AND txid = $2', [t.network, t.txid, 'matched', already]);
      return false; // left for the admin to look at
    }
    await approveWithTransfer(c, d, t, emails);
    return true;
  });
  if (credited) {
    sendQueuedEmails(emails);
    console.log(`[Deposits] Auto-credited ${t.micro / 1e6} USDT (${t.network}) ${match ? 'to deposit ' + match.id : 'by sender wallet'}, tx ${t.txid}`);
  }
  return credited;
}

async function pollDeposits() {
  const config = await getConfig();
  if (!autoDepositsOn(config)) return { waiting: false };
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  await pool.query(`UPDATE app.deposits SET data = data || '{"status":"Expired"}'::jsonb
    WHERE data->>'auto' = 'true' AND data->>'status' = 'Pending' AND data->>'expiresAt' < $1`, [nowIso]);
  // Expired and cancelled requests can still be paid late; they're matched for the full window.
  const { rows } = await pool.query(`SELECT data FROM app.deposits WHERE data->>'auto' = 'true'
    AND data->>'status' IN ('Pending', 'Expired', 'Cancelled') AND data->>'createdAt' > $1`,
    [new Date(now - depositWatch.MATCH_WINDOW_MS).toISOString()]);
  const requests = rows.map(r => ({
    id: r.data.id, network: r.data.network, status: r.data.status,
    payMicro: depositWatch.amountToMicro(r.data.payAmount), createdAtMs: Date.parse(r.data.createdAt)
  }));

  const state = await db.getSetting(pool, 'deposit_watch');
  for (const network of ['trc20', 'bep20']) {
    const address = network === 'bep20' ? config.depositAddressBep20 : config.depositAddressTrc20;
    if (!address) { delete state[network]; continue; }
    // A new address starts watching from now; transfers to the old one aren't read any more.
    const st = state[network] && state[network].address === address ? state[network] : { address };
    try {
      let transfers;
      if (network === 'trc20') {
        const sinceMs = st.sinceMs || now - 10 * 60 * 1000;
        const r = await depositWatch.fetchTronTransfers({ address, sinceMs: sinceMs - 60 * 1000, apiKey: process.env.TRONGRID_API_KEY });
        transfers = r.transfers;
        const newest = transfers.reduce((m, t) => Math.max(m, t.timeMs || 0), 0);
        // Confirmation takes about a minute on TRON, so it's safe to move on to 5 minutes ago once
        // every page has been read.
        st.sinceMs = Math.max(sinceMs, newest, r.complete ? now - 5 * 60 * 1000 : 0);
      } else {
        const r = await depositWatch.fetchBscTransfers({ address, fromBlock: st.nextBlock, rpcUrl: BSC_RPC_URL, confirmations: BSC_CONFIRMATIONS });
        transfers = r.transfers;
        st.nextBlock = r.nextBlock;
        // Block times are only needed (one call each) for transfers whose amount matches a request.
        const wanted = new Set(requests.filter(q => q.network === 'bep20').map(q => q.payMicro));
        for (const t of transfers) {
          if (t.exact && wanted.has(t.micro)) t.timeMs = await depositWatch.bscBlockTimeMs(BSC_RPC_URL, t.blockNumber);
        }
      }
      for (const t of transfers) {
        const match = depositWatch.findMatch(t, requests);
        if (await handleIncomingTransfer(t, match) && match) requests.splice(requests.indexOf(match), 1);
      }
      st.lastPollAt = nowIso;
      st.lastError = null;
    } catch (e) {
      st.lastError = e.message;
      st.lastErrorAt = nowIso;
      console.error(`[Deposits] ${network} poll failed:`, e.message);
    }
    state[network] = st;
  }
  await db.setSetting(pool, 'deposit_watch', state);
  return { waiting: requests.some(q => q.status === 'Pending' || (q.status === 'Expired' && now - q.createdAtMs < AUTO_DEPOSIT_FAST_POLL_MS)) };
}

function startDepositWatcher() {
  const loop = async () => {
    let waiting = false;
    try { waiting = (await pollDeposits()).waiting; }
    catch (e) { console.error('[Deposits] watcher failed:', e.message); }
    setTimeout(loop, waiting ? DEPOSIT_POLL_FAST_MS : DEPOSIT_POLL_IDLE_MS).unref();
  };
  setTimeout(loop, 5000).unref();
}

app.get('/api/admin/deposit-watch', adminMiddleware, async (req, res) => {
  const config = await getConfig();
  const state = await db.getSetting(pool, 'deposit_watch');
  const { rows } = await pool.query(`SELECT network, txid, from_address, amount, block_time, seen_at
    FROM app.deposit_transfers WHERE status = 'unmatched' ORDER BY coalesce(block_time, seen_at) DESC LIMIT 200`);
  res.json({
    enabled: autoDepositsOn(config),
    tronApiKey: !!process.env.TRONGRID_API_KEY,
    bscRpc: new URL(BSC_RPC_URL).host,
    networks: {
      trc20: { address: config.depositAddressTrc20 || '', ...(state.trc20 || {}) },
      bep20: { address: config.depositAddressBep20 || '', ...(state.bep20 || {}) }
    },
    unmatched: rows.map(r => ({ network: r.network, txid: r.txid, from: r.from_address, amount: Number(r.amount), time: r.block_time || r.seen_at }))
  });
});

// Credits an unmatched payment to a user by UID (e.g. they sent the wrong amount and contacted support).
app.post('/api/admin/deposit-transfers/assign', adminMiddleware, async (req, res) => {
  const { network, txid, uid } = req.body;
  const emails = [];
  const result = await tx(async c => {
    const { rows } = await c.query('SELECT * FROM app.deposit_transfers WHERE network = $1 AND txid = $2 FOR UPDATE', [network, txid]);
    const t = rows[0];
    if (!t) return { status: 404, body: { error: 'Payment not found' } };
    if (t.status !== 'unmatched') return { status: 400, body: { error: 'This payment has already been handled' } };
    if (await findCreditedTxid(c, txid)) return { status: 400, body: { error: 'This transaction has already been credited.' } };
    const found = await db.findUserBy(c, 'uid', String(uid || '').trim());
    if (!found || found.deletedAt) return { status: 404, body: { error: 'No user with that UID' } };
    const d = {
      id: generateId(),
      userId: found.id,
      amount: Number(t.amount),
      network,
      txid,
      fromAddress: t.from_address,
      status: 'Approved',
      approvedBy: 'admin',
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString()
    };
    await db.insertDoc(c, 'deposits', d);
    await creditDeposit(c, d, emails);
    await db.saveDoc(c, 'deposits', d);
    await c.query("UPDATE app.deposit_transfers SET status = 'assigned', deposit_id = $3 WHERE network = $1 AND txid = $2", [network, txid, d.id]);
    return { status: 200, body: d };
  });
  if (result.status === 200) sendQueuedEmails(emails);
  res.status(result.status).json(result.body);
});

// Hides an unmatched payment that isn't a user deposit (e.g. the owner topping up the wallet).
app.post('/api/admin/deposit-transfers/ignore', adminMiddleware, async (req, res) => {
  const { rowCount } = await pool.query("UPDATE app.deposit_transfers SET status = 'ignored' WHERE network = $1 AND txid = $2 AND status = 'unmatched'", [req.body.network, req.body.txid]);
  if (!rowCount) return res.status(404).json({ error: 'Payment not found or already handled' });
  res.json({ ok: true });
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

// Every user who currently has a withdrawal address saved, most recently saved first.
app.get('/api/admin/wallets', adminMiddleware, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.data, (SELECT count(*)::int FROM app.wallet_submissions s WHERE s.user_id = u.id) AS submissions
    FROM app.users u
    WHERE coalesce(u.data->'walletAddress'->>'trc20', '') <> ''
       OR coalesce(u.data->'walletAddress'->>'bep20', '') <> ''
       OR coalesce(u.data->'walletAddress'->>'erc20', '') <> ''`);
  const HOLD_MS = 48 * 60 * 60 * 1000;
  const list = rows.map(({ data: u, submissions }) => {
    const changedAt = u.walletAddressUpdatedAt ? new Date(u.walletAddressUpdatedAt).getTime() : 0;
    return {
      id: u.id, username: u.username, email: u.email, uid: u.uid, avatar: u.avatar || '',
      status: accountStatus(u), location: ipLocation(u.lastIp || u.signupIp),
      trc20: u.walletAddress.trc20 || '',
      bep20: u.walletAddress.bep20 || u.walletAddress.erc20 || '',
      savedAt: u.walletAddressSavedAt || u.walletAddressUpdatedAt || null,
      withdrawalHoldUntil: changedAt && changedAt + HOLD_MS > Date.now() ? new Date(changedAt + HOLD_MS).toISOString() : null,
      submissions
    };
  });
  list.sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
  res.json(list);
});

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
    minDeposit: config.minDeposit !== undefined ? parseFloat(config.minDeposit) : 50,
    ...depositProofSettings(config),
    autoDeposit: autoDepositsOn(config),
    autoPayMinutes: AUTO_DEPOSIT_PAY_WINDOW_MS / 60000
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
    minWithdrawal: minWithdrawalOf(config),
    handlingFeeEnabled: config.handlingFeeEnabled === true,
    telegramLink: config.telegramLink || DEFAULT_TELEGRAM_LINK,
    groupLink: config.groupLink || DEFAULT_GROUP_LINK
  });
});

app.get('/api/admin/platform-config', adminMiddleware, async (req, res) => {
  res.json(await getConfig());
});

app.put('/api/admin/platform-config', adminMiddleware, async (req, res) => {
  const { depositAddressTrc20, depositAddressBep20, signupBonus, minDeposit, referralBonusPct, referralBonusPctB, referralBonusPctC, withdrawalFeePct, reserveWinRatePct, handlingFeeEnabled, dailyCheckinReward, telegramLink, groupLink, depositScreenshotEnabled, depositTxidEnabled, minWithdrawal, autoDepositEnabled } = req.body;

  const result = await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(424244)');
    const config = await getConfig(c);
    // Automatic deposits watch these addresses on-chain, so a typo would silently miss payments.
    for (const [value, re, label] of [[depositAddressTrc20, TRC20_RE, 'TRC-20 address (starts with T, 34 characters)'], [depositAddressBep20, BEP20_RE, 'BEP-20 address (starts with 0x, 42 characters)']]) {
      if (value !== undefined && String(value).trim() !== '' && !re.test(String(value).trim())) {
        return { status: 400, body: { error: `That doesn't look like a valid ${label}` } };
      }
    }
    if (depositAddressTrc20 !== undefined) config.depositAddressTrc20 = String(depositAddressTrc20).trim();
    if (depositAddressBep20 !== undefined) config.depositAddressBep20 = String(depositAddressBep20).trim();
    if (autoDepositEnabled !== undefined) config.autoDepositEnabled = autoDepositEnabled === true || autoDepositEnabled === 'true';
    if (signupBonus !== undefined) config.signupBonus = parseFloat(signupBonus);
    if (minDeposit !== undefined) config.minDeposit = parseFloat(minDeposit);
    if (referralBonusPct !== undefined) config.referralBonusPct = parseFloat(referralBonusPct);
    if (referralBonusPctB !== undefined) config.referralBonusPctB = parseFloat(referralBonusPctB);
    if (referralBonusPctC !== undefined) config.referralBonusPctC = parseFloat(referralBonusPctC);
    if (withdrawalFeePct !== undefined) config.withdrawalFeePct = parseFloat(withdrawalFeePct);
    if (minWithdrawal !== undefined) {
      const v = minWithdrawal === '' ? 0 : parseFloat(minWithdrawal);
      if (isNaN(v) || v < 0 || v > 1000000) return { status: 400, body: { error: 'Minimum withdrawal must be 0 or more (0 means no minimum)' } };
      config.minWithdrawal = v;
    }
    if (handlingFeeEnabled !== undefined) config.handlingFeeEnabled = handlingFeeEnabled === true || handlingFeeEnabled === 'true';
    for (const [key, value, label] of [['telegramLink', telegramLink, 'Telegram link'], ['groupLink', groupLink, 'Group link']]) {
      if (value === undefined) continue;
      const link = validLink(value);
      if (link === null) return { status: 400, body: { error: `${label} must be a web link, e.g. https://t.me/yourchannel` } };
      config[key] = link; // '' falls back to the default link
    }
    if (depositScreenshotEnabled !== undefined) config.depositScreenshotEnabled = depositScreenshotEnabled === true || depositScreenshotEnabled === 'true';
    if (depositTxidEnabled !== undefined) config.depositTxidEnabled = depositTxidEnabled === true || depositTxidEnabled === 'true';
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
    if (process.env.DEPOSIT_WATCHER !== 'off') startDepositWatcher();

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
