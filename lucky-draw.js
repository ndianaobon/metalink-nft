// Lucky Draw: users collect points and spend them on spins of a prize wheel (6 to 12 slots) that pays USDT into
// their balance. The settings live in platform_config.luckyDraw (edited on the admin Rewards page),
// so checkAndApplyLevelUpgrade can award level-up points from the config it already has.
//
// Points come from: buying them with balance (packs, e.g. 5 points for 10 USDT), a daily claim (resets at 6:00 AM UK time, like reservations), reaching a new
// level, an invited member's first deposit (tiers by deposit size), and later deposits ("re-deposit",
// a % of the amount). The server picks every prize; the wheel in the app only animates the result.
const crypto = require('crypto');

const MIN_SLOTS = 6, MAX_SLOTS = 12;
const slotsOk = prizes => Array.isArray(prizes) && prizes.length >= MIN_SLOTS && prizes.length <= MAX_SLOTS;

const DEFAULTS = {
  enabled: true,
  spinCost: 10,
  tenSpinCost: 95,
  dailyPoints: 1,
  levelPoints: { 1: 5, 2: 10, 3: 20, 4: 40, 5: 80, 6: 150 },
  inviteTiers: [
    { minDeposit: 50, points: 1 },
    { minDeposit: 100, points: 3 },
    { minDeposit: 200, points: 7 },
    { minDeposit: 300, points: 11 }
  ],
  redepositMin: 100,
  redepositPct: 5,
  buyEnabled: true,
  buyPoints: 5,
  buyPrice: 10,
  // Clockwise from the top. `chance` is a relative weight (a prize's share of the total); users
  // see the prizes on the wheel but never the chances. A 0 prize is a losing slot.
  prizes: [
    { amount: 5, chance: 24 },
    { amount: 10, chance: 15 },
    { amount: 0, chance: 12 },
    { amount: 30, chance: 2 },
    { amount: 5, chance: 24 },
    { amount: 100, chance: 0.5 },
    { amount: 10, chance: 10 },
    { amount: 0, chance: 12 },
    { amount: 200, chance: 0.5 },
    { amount: 500, chance: 0 }
  ]
};

const round2 = n => Math.round(Number(n) * 100) / 100;

// The saved settings filled in with defaults, so older configs and partial saves keep working.
function settingsOf(config) {
  const s = (config && config.luckyDraw) || {};
  const pick = (k, fallback) => (s[k] !== undefined && s[k] !== null ? s[k] : fallback);
  return {
    enabled: pick('enabled', DEFAULTS.enabled) !== false,
    spinCost: Number(pick('spinCost', DEFAULTS.spinCost)),
    tenSpinCost: Number(pick('tenSpinCost', DEFAULTS.tenSpinCost)),
    dailyPoints: Number(pick('dailyPoints', DEFAULTS.dailyPoints)),
    levelPoints: Object.assign({}, DEFAULTS.levelPoints, s.levelPoints || {}),
    inviteTiers: (Array.isArray(s.inviteTiers) ? s.inviteTiers : DEFAULTS.inviteTiers).map(t => ({ minDeposit: Number(t.minDeposit), points: Number(t.points) })),
    redepositMin: Number(pick('redepositMin', DEFAULTS.redepositMin)),
    redepositPct: Number(pick('redepositPct', DEFAULTS.redepositPct)),
    buyEnabled: pick('buyEnabled', DEFAULTS.buyEnabled) !== false,
    buyPoints: Number(pick('buyPoints', DEFAULTS.buyPoints)),
    buyPrice: Number(pick('buyPrice', DEFAULTS.buyPrice)),
    prizes: (slotsOk(s.prizes) ? s.prizes : DEFAULTS.prizes).map(p => ({ amount: Number(p.amount), chance: Number(p.chance) }))
  };
}

// Checks an admin save. Returns { settings } or { error }.
function validateSettings(body) {
  const num = (v, label, { min = 0, max = 1e9, int = false } = {}) => {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
      throw new Error(`${label} must be ${int ? 'a whole number' : 'a number'} from ${min} to ${max}`);
    }
    return n;
  };
  try {
    const settings = {
      enabled: body.enabled === true || body.enabled === 'true',
      spinCost: num(body.spinCost, 'Points per spin', { min: 1, max: 100000 }),
      tenSpinCost: num(body.tenSpinCost, 'Points for 10 spins', { min: 1, max: 1000000 }),
      dailyPoints: num(body.dailyPoints, 'Daily points', { max: 100000 }),
      levelPoints: {},
      inviteTiers: [],
      redepositMin: num(body.redepositMin, 'Re-deposit minimum', { max: 1e7 }),
      redepositPct: num(body.redepositPct, 'Re-deposit points %', { max: 100 }),
      buyEnabled: body.buyEnabled === true || body.buyEnabled === 'true',
      buyPoints: num(body.buyPoints, 'Points per pack', { min: 1, max: 1e6, int: true }),
      buyPrice: round2(num(body.buyPrice, 'Pack price', { min: 0.01, max: 1e6 })),
      prizes: []
    };
    for (let lv = 1; lv <= 6; lv++) settings.levelPoints[lv] = num((body.levelPoints || {})[lv], `Level ${lv} points`, { max: 1e6 });
    const tiers = Array.isArray(body.inviteTiers) ? body.inviteTiers : [];
    if (tiers.length > 10) throw new Error('Use at most 10 invite tiers');
    for (const [i, t] of tiers.entries()) {
      settings.inviteTiers.push({
        minDeposit: num(t.minDeposit, `Invite tier ${i + 1} deposit`, { min: 0.01, max: 1e7 }),
        points: num(t.points, `Invite tier ${i + 1} points`, { max: 1e6 })
      });
    }
    settings.inviteTiers.sort((a, b) => a.minDeposit - b.minDeposit);
    const prizes = Array.isArray(body.prizes) ? body.prizes : [];
    if (!slotsOk(prizes)) throw new Error(`The wheel needs ${MIN_SLOTS} to ${MAX_SLOTS} prizes`);
    for (const [i, p] of prizes.entries()) {
      settings.prizes.push({
        amount: round2(num(p.amount, `Prize ${i + 1} amount`, { max: 1e6 })),
        chance: num(p.chance, `Prize ${i + 1} chance`, { max: 1e6 })
      });
    }
    if (!settings.prizes.some(p => p.chance > 0)) throw new Error('At least one prize needs a chance above 0');
    return { settings };
  } catch (e) {
    return { error: e.message };
  }
}

// Each slot's chance as a percentage of the total weight.
function prizeOdds(prizes) {
  const total = prizes.reduce((s, p) => s + Math.max(0, p.chance), 0);
  return prizes.map(p => (total > 0 ? (Math.max(0, p.chance) / total) * 100 : 0));
}

// The average USDT a spin pays out, for the admin page.
function expectedPrize(prizes) {
  const odds = prizeOdds(prizes);
  return prizes.reduce((s, p, i) => s + p.amount * odds[i] / 100, 0);
}

// Picks a slot index by weight. `rand(n)` returns an integer in [0, n).
function pickSlot(prizes, rand = n => crypto.randomInt(n)) {
  // Weights to whole millionths, so fractional chances like 0.5 work with an integer random number.
  const weights = prizes.map(p => Math.max(0, Math.round(p.chance * 1e6)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) throw new Error('No prize has a chance above 0');
  let r = rand(total);
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}

// Points an inviter gets when their invited member's first deposit is `amount`: the highest tier it reaches.
function invitePointsFor(amount, tiers) {
  let pts = 0;
  for (const t of tiers) if (amount >= t.minDeposit) pts = t.points;
  return pts;
}

function redepositPointsFor(amount, settings) {
  if (!(settings.redepositPct > 0) || amount < settings.redepositMin) return 0;
  return round2(amount * settings.redepositPct / 100);
}

// Adds points to a user record in place and keeps a short history on it. Returns the points added.
const LOG_LIMIT = 100;
function addPoints(user, points, kind, note, at = new Date().toISOString()) {
  points = round2(points);
  if (!(points > 0)) return 0;
  user.drawPoints = round2((user.drawPoints || 0) + points);
  user.drawPointsEarned = round2((user.drawPointsEarned || 0) + points);
  user.drawPointsBy = user.drawPointsBy || {};
  user.drawPointsBy[kind] = round2((user.drawPointsBy[kind] || 0) + points);
  user.drawPointsLog = [{ kind, points, note, at }].concat(user.drawPointsLog || []).slice(0, LOG_LIMIT);
  return points;
}

// Level-up points for every level the user just passed (fromLevel exclusive, toLevel inclusive).
function awardLevelPoints(user, config, fromLevel, toLevel) {
  const s = settingsOf(config);
  if (!s.enabled) return 0;
  let added = 0;
  for (let lv = fromLevel + 1; lv <= toLevel; lv++) {
    added += addPoints(user, Number(s.levelPoints[lv]) || 0, 'level', `Reached Level ${lv}`);
  }
  return added;
}

// The caller has checked the user has enough points.
function spendPoints(user, points, note) {
  user.drawPoints = round2((user.drawPoints || 0) - points);
  user.drawPointsLog = [{ kind: 'spin', points: -points, note, at: new Date().toISOString() }].concat(user.drawPointsLog || []).slice(0, LOG_LIMIT);
}

module.exports = {
  MIN_SLOTS, MAX_SLOTS, DEFAULTS, settingsOf, validateSettings, prizeOdds, expectedPrize, pickSlot,
  invitePointsFor, redepositPointsFor, addPoints, spendPoints, awardLevelPoints
};
