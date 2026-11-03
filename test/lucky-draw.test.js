const test = require('node:test');
const assert = require('node:assert');
const ld = require('../lucky-draw');

test('settings fall back to the defaults', () => {
  const s = ld.settingsOf({});
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.spinCost, 10);
  assert.strictEqual(s.prizes.length, 10);
  assert.ok(s.prizes.some(p => p.amount === 0), 'the default wheel has a 0 slot');
  assert.strictEqual(ld.settingsOf({ luckyDraw: { spinCost: 20, enabled: false } }).spinCost, 20);
  assert.strictEqual(ld.settingsOf({ luckyDraw: { enabled: false } }).enabled, false);
});

test('pickSlot follows the weights and skips 0% prizes', () => {
  const prizes = [{ amount: 1, chance: 1 }, { amount: 2, chance: 0 }, { amount: 3, chance: 3 }];
  // total weight 4,000,000: [0, 1e6) -> slot 0, [1e6, 4e6) -> slot 2
  assert.strictEqual(ld.pickSlot(prizes, () => 0), 0);
  assert.strictEqual(ld.pickSlot(prizes, () => 999999), 0);
  assert.strictEqual(ld.pickSlot(prizes, () => 1000000), 2);
  assert.strictEqual(ld.pickSlot(prizes, n => n - 1), 2);
  assert.throws(() => ld.pickSlot([{ amount: 1, chance: 0 }]));
  // fractional chances count
  assert.strictEqual(ld.pickSlot([{ amount: 9, chance: 0.5 }, { amount: 1, chance: 99.5 }], () => 0), 0);
});

test('pickSlot with real randomness lands roughly on the odds', () => {
  const prizes = [{ amount: 5, chance: 75 }, { amount: 50, chance: 25 }];
  let big = 0;
  for (let i = 0; i < 20000; i++) if (ld.pickSlot(prizes) === 1) big++;
  assert.ok(big > 4500 && big < 5500, `25% slot hit ${big} / 20000`);
});

test('odds and expected prize', () => {
  const prizes = [{ amount: 10, chance: 1 }, { amount: 0, chance: 3 }];
  assert.deepStrictEqual(ld.prizeOdds(prizes), [25, 75]);
  assert.strictEqual(ld.expectedPrize(prizes), 2.5);
});

test('invite points use the highest tier reached', () => {
  const tiers = ld.DEFAULTS.inviteTiers;
  assert.strictEqual(ld.invitePointsFor(49, tiers), 0);
  assert.strictEqual(ld.invitePointsFor(50, tiers), 1);
  assert.strictEqual(ld.invitePointsFor(199, tiers), 3);
  assert.strictEqual(ld.invitePointsFor(5000, tiers), 11);
});

test('re-deposit points need the minimum', () => {
  const s = ld.settingsOf({});
  assert.strictEqual(ld.redepositPointsFor(99, s), 0);
  assert.strictEqual(ld.redepositPointsFor(100, s), 5);
  assert.strictEqual(ld.redepositPointsFor(250, s), 12.5);
});

test('level points for each level passed, and a history entry each', () => {
  const user = {};
  assert.strictEqual(ld.awardLevelPoints(user, {}, 0, 2), 15);
  assert.strictEqual(user.drawPoints, 15);
  assert.strictEqual(user.drawPointsLog.length, 2);
  assert.strictEqual(user.drawPointsLog[0].note, 'Reached Level 2');
  assert.strictEqual(ld.awardLevelPoints({}, { luckyDraw: { enabled: false } }, 0, 3), 0);
  ld.spendPoints(user, 10, '1 spin');
  assert.strictEqual(user.drawPoints, 5);
  assert.strictEqual(user.drawPointsEarned, 15);
});

test('admin settings are checked', () => {
  const body = {
    enabled: true, spinCost: 10, tenSpinCost: 95, buyEnabled: true, buyPoints: 5, buyPrice: 10, dailyPoints: 1, redepositMin: 100, redepositPct: 5,
    levelPoints: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 },
    inviteTiers: [{ minDeposit: 100, points: 3 }, { minDeposit: 50, points: 1 }],
    prizes: ld.DEFAULTS.prizes
  };
  const ok = ld.validateSettings(body);
  assert.ok(ok.settings, ok.error);
  assert.deepStrictEqual(ok.settings.inviteTiers.map(t => t.minDeposit), [50, 100]);
  assert.match(ld.validateSettings({ ...body, prizes: body.prizes.slice(0, 5) }).error, /6 to 12/);
  assert.ok(ld.validateSettings({ ...body, prizes: body.prizes.slice(0, 8) }).settings, '8 slots are fine');
  assert.match(ld.validateSettings({ ...body, prizes: body.prizes.concat(body.prizes) }).error, /6 to 12/);
  assert.match(ld.validateSettings({ ...body, buyPrice: 0 }).error, /Pack price/);
  assert.match(ld.validateSettings({ ...body, buyPoints: 2.5 }).error, /whole number/);
  assert.match(ld.validateSettings({ ...body, spinCost: 0 }).error, /Points per spin/);
  assert.match(ld.validateSettings({ ...body, prizes: body.prizes.map(p => ({ ...p, chance: 0 })) }).error, /At least one/);
  assert.match(ld.validateSettings({ ...body, levelPoints: { 1: 1 } }).error, /Level 2/);
});
