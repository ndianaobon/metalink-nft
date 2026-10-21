// Multi-account risk scoring. Pure functions only (no database), so the rules can be unit-tested;
// server.js loads the rows around one account and passes them in.
//
// No single weak signal is treated as proof. Each signal adds points; the total decides the level:
//   - Strong signals (same device token, same payout wallet, a referral ring or bonus farming across
//     linked accounts) can on their own put an account up for review.
//   - Weak signals (shared public IP, a quick burst of sign-ups, withdrawing without ever depositing)
//     only add weight. Families, offices, mobile carriers and public Wi-Fi share IPs, so shared IP is
//     capped well below the review threshold and can never hold a withdrawal by itself.
// Nothing here blocks anything: withdrawals already need admin approval, and a high score only marks
// them "review before approving".

const LEVELS = { MEDIUM: 30, HIGH: 60 };

const RULES = {
  shared_device:       { strong: true,  base: 35, perExtra: 10, max: 55 },
  shared_wallet:       { strong: true,  base: 40, perExtra: 10, max: 55 },
  referral_ring:       { strong: true,  base: 25 },
  bonus_farming:       { strong: true,  base: 20 },
  device_signup_burst: { strong: false, base: 10 },
  bonus_withdrawal:    { strong: false, base: 10 },
  shared_ip:           { strong: false, perAccount: 3, max: 15 }
};

// An IP used by this many accounts or more is a carrier NAT, campus or public hotspot, not a household.
const BUSY_IP_ACCOUNTS = 25;
const SIGNUP_BURST_MS = 72 * 60 * 60 * 1000;

function walletKey(addr) {
  const a = String(addr || '').trim();
  return a ? a.toLowerCase() : '';
}

function userWallets(user) {
  const w = (user && user.walletAddress) || {};
  return [w.trc20, w.bep20, w.erc20].map(walletKey).filter(Boolean);
}

function levelFor(score) {
  if (score >= LEVELS.HIGH) return 'high';
  if (score >= LEVELS.MEDIUM) return 'medium';
  return 'low';
}

function scaled(rule, n) {
  if (rule.perAccount) return Math.min(rule.max, rule.perAccount * n);
  if (rule.perExtra) return Math.min(rule.max, rule.base + rule.perExtra * (n - 1));
  return rule.base;
}

/**
 * Scores one account against the accounts around it.
 * world: {
 *   users:         [{ id, uid, username, createdAt, referredBy, walletAddress: {trc20, bep20, erc20}, deletedAt }]
 *   devices:       [{ userId, deviceHash, platform }]
 *   ips:           [{ userId, ip }]
 *   deposits:      [{ userId, status }]
 *   withdrawals:   [{ userId, status, walletAddress }]
 *   signupBonuses: [{ userId, amount }]
 * }
 * Only rows touching the account's devices, IPs, wallets and referrals need to be included.
 */
function analyzeAccount(userId, world) {
  const users = world.users || [];
  const byId = new Map(users.map(u => [u.id, u]));
  const me = byId.get(userId);
  const flags = [];
  const linked = new Map(); // userId -> Set(via)
  const link = (id, via) => {
    if (id === userId) return;
    if (!linked.has(id)) linked.set(id, new Set());
    linked.get(id).add(via);
  };

  // --- same device token ---
  const devices = world.devices || [];
  const myHashes = new Set(devices.filter(d => d.userId === userId).map(d => d.deviceHash));
  const deviceLinked = new Set(devices.filter(d => myHashes.has(d.deviceHash) && d.userId !== userId).map(d => d.userId));
  deviceLinked.forEach(id => link(id, 'device'));

  // --- same payout wallet (saved address, or an address they withdrew to) ---
  const withdrawals = world.withdrawals || [];
  const walletsOf = id => new Set(userWallets(byId.get(id))
    .concat(withdrawals.filter(w => w.userId === id).map(w => walletKey(w.walletAddress)).filter(Boolean)));
  const myWallets = walletsOf(userId);
  const walletLinked = new Set();
  if (myWallets.size) {
    const candidates = new Set(users.map(u => u.id).concat(withdrawals.map(w => w.userId)));
    candidates.forEach(id => {
      if (id === userId) return;
      for (const a of walletsOf(id)) if (myWallets.has(a)) { walletLinked.add(id); break; }
    });
  }
  walletLinked.forEach(id => link(id, 'wallet'));

  // --- shared public IP (weak; busy IPs ignored) ---
  const ips = world.ips || [];
  const myIps = new Set(ips.filter(i => i.userId === userId).map(i => i.ip));
  const ipLinked = new Set();
  let busyIps = 0;
  myIps.forEach(ip => {
    const others = new Set(ips.filter(i => i.ip === ip && i.userId !== userId).map(i => i.userId));
    if (others.size + 1 >= BUSY_IP_ACCOUNTS) { busyIps++; return; }
    others.forEach(id => ipLinked.add(id));
  });
  ipLinked.forEach(id => link(id, 'ip'));

  // --- referrals between accounts that share a device or wallet ---
  const strongLinked = new Set([...deviceLinked, ...walletLinked]);
  const referralPartners = new Set();
  if (me && me.referredBy && strongLinked.has(me.referredBy)) referralPartners.add(me.referredBy);
  users.forEach(u => { if (u.referredBy === userId && strongLinked.has(u.id)) referralPartners.add(u.id); });
  referralPartners.forEach(id => link(id, 'referral'));

  // --- deposits / bonuses ---
  const hasDeposit = id => (world.deposits || []).some(d => d.userId === id && d.status === 'Approved');
  const gotBonus = id => (world.signupBonuses || []).some(b => b.userId === id && Number(b.amount) > 0);

  if (deviceLinked.size) {
    flags.push(flag('shared_device', scaled(RULES.shared_device, deviceLinked.size),
      `Same device as ${deviceLinked.size} other account${deviceLinked.size > 1 ? 's' : ''}`));
  }
  if (walletLinked.size) {
    flags.push(flag('shared_wallet', scaled(RULES.shared_wallet, walletLinked.size),
      `Same withdrawal wallet as ${walletLinked.size} other account${walletLinked.size > 1 ? 's' : ''}`));
  }
  if (referralPartners.size) {
    flags.push(flag('referral_ring', RULES.referral_ring.base,
      `Referred, or was referred by, ${referralPartners.size} account${referralPartners.size > 1 ? 's' : ''} on the same device or wallet`));
  }

  const cluster = [userId, ...strongLinked];
  const bonusOnly = cluster.filter(id => gotBonus(id) && !hasDeposit(id));
  if (strongLinked.size && bonusOnly.length >= 2) {
    flags.push(flag('bonus_farming', RULES.bonus_farming.base,
      `${bonusOnly.length} linked accounts took the sign-up bonus without ever depositing`));
  }

  if (me && me.createdAt) {
    const t = new Date(me.createdAt).getTime();
    const burst = [...deviceLinked].filter(id => {
      const u = byId.get(id);
      return u && u.createdAt && Math.abs(new Date(u.createdAt).getTime() - t) <= SIGNUP_BURST_MS;
    });
    if (burst.length) {
      flags.push(flag('device_signup_burst', RULES.device_signup_burst.base,
        `Created within 72 hours of ${burst.length} other account${burst.length > 1 ? 's' : ''} on the same device`));
    }
  }

  const requestedWithdrawal = withdrawals.some(w => w.userId === userId && w.status !== 'Cancelled');
  if (requestedWithdrawal && !hasDeposit(userId)) {
    flags.push(flag('bonus_withdrawal', RULES.bonus_withdrawal.base, 'Requested a withdrawal without ever making a deposit'));
  }

  if (ipLinked.size) {
    flags.push(flag('shared_ip', scaled(RULES.shared_ip, ipLinked.size),
      `Same public IP as ${ipLinked.size} other account${ipLinked.size > 1 ? 's' : ''} (weak: households and Wi-Fi share IPs)`));
  }

  const score = Math.min(100, flags.reduce((s, f) => s + f.points, 0));
  const level = levelFor(score);
  return {
    userId,
    score,
    level,
    // Review only when there is a strong signal; weak signals alone never reach the threshold anyway.
    needsReview: level !== 'low' && flags.some(f => f.strong),
    flags,
    linked: [...linked].map(([id, via]) => ({ userId: id, via: [...via].sort() })),
    busyIps
  };
}

function flag(code, points, detail) {
  return { code, points, strong: RULES[code].strong, detail };
}

// What a withdrawal request should do given the account's risk. Never blocks: the request is
// always accepted (it waits for admin approval like every withdrawal); risky ones are marked so the
// admin checks the linked accounts before approving.
function withdrawalDecision(risk) {
  if (risk && risk.needsReview) {
    return { allowed: true, holdForReview: true, reason: risk.flags.filter(f => f.strong).map(f => f.code).join(', ') };
  }
  return { allowed: true, holdForReview: false, reason: '' };
}

// After an admin clears an account, keep it cleared unless a strong signal appears that wasn't there
// when they decided (a new device link, a new shared wallet...).
function nextReviewStatus(current, reviewedFlags, risk) {
  if (!current || current === 'open') return 'open';
  const seen = new Set(reviewedFlags || []);
  const newStrong = risk.flags.some(f => f.strong && !seen.has(f.code));
  return current === 'cleared' && newStrong ? 'open' : current;
}

module.exports = { analyzeAccount, withdrawalDecision, nextReviewStatus, levelFor, LEVELS, RULES, BUSY_IP_ACCOUNTS };
