const test = require('node:test');
const assert = require('node:assert');
const { incomeOverview } = require('../income');

const now = new Date('2026-10-31T12:00:00.000Z');
const since = new Date('2026-10-31T00:00:00.000Z');
const today = '2026-10-31T09:00:00.000Z';
const user = { dailyIncome: {} };
const overview = (fields = {}) => incomeOverview({ user, txs: [], stakes: [], earnPositions: [], since, now, ...fields });
const stake = fields => ({ id: 's1', pledgeValue: 1000, dailyIncome: '2.0%', startDate: '2026-10-29T12:00:00.000Z', endDate: '2026-11-28T12:00:00.000Z', claimed: false, income: 0, ...fields });

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);

test('Daily Comprehensive adds up Reserve, Stake/Earn, Team and Activity for today', () => {
  const { daily } = overview({
    txs: [
      { type: 'reserve_reward', amount: 3, createdAt: today },
      { type: 'team_commission', amount: 4, createdAt: today },
      { type: 'checkin', amount: 1, createdAt: today },
      { type: 'gift_reward', amount: 2, createdAt: today }
    ],
    stakes: [stake()]
  });
  assert.deepStrictEqual([daily.reserve, daily.team, daily.activity], [3, 4, 3]);
  close(daily.plans, 10); // half a day at 20 USDT a day
  close(daily.comprehensive, 20);
});

test('earnings from before today stay out of Daily', () => {
  const { daily } = overview({ txs: [
    { type: 'reserve_reward', amount: 5, createdAt: '2026-10-30T23:59:59.999Z' },
    { type: 'reserve_reward', amount: 7, createdAt: since.toISOString() }
  ] });
  assert.strictEqual(daily.comprehensive, 7);
});

test('money that is not profit is left out', () => {
  const { daily } = overview({ txs: [
    'signup_bonus', 'deposit', 'stake_return', 'earn_return', 'withdrawal_refund', 'admin_credit'
  ].map(type => ({ type, amount: 100, createdAt: today })) });
  assert.strictEqual(daily.comprehensive, 0);
});

test('a running stake counts its profit so far in Total Comprehensive', () => {
  const { total } = overview({ user: { dailyIncome: { reserve: 5, team: 6, activity: 7 } }, stakes: [stake()] });
  close(total.plans, 40); // two days at 20 USDT a day
  close(total.comprehensive, 58);
});

test('a running earn plan counts the same way', () => {
  const { daily, total } = overview({ earnPositions: [{ id: 'e1', amount: 100, dailyRatePct: 2, startDate: '2026-10-30T12:00:00.000Z', endDate: '2026-11-29T12:00:00.000Z', claimed: false, income: 0 }] });
  close(daily.plans, 1);
  close(total.plans, 2);
});

test('claiming a plan today does not count its older profit as today', () => {
  const claimed = stake({ claimed: true, income: 37.5 });
  const { daily, total } = overview({
    stakes: [claimed],
    txs: [{ type: 'stake_income', amount: 37.5, refId: 's1', createdAt: '2026-10-31T06:00:00.000Z' }]
  });
  close(daily.plans, 5); // midnight to the 6 AM claim
  assert.strictEqual(total.plans, 37.5);
});

test('a plan stops counting after its end date', () => {
  const ended = stake({ startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-31T06:00:00.000Z' });
  const { daily, total } = overview({ stakes: [ended] });
  close(daily.plans, 5);
  close(total.plans, 605);
});

test('a plan claimed on an earlier day adds nothing today', () => {
  const claimed = stake({ startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-08T00:00:00.000Z', claimed: true, income: 140 });
  const { daily, total } = overview({
    stakes: [claimed],
    txs: [{ type: 'stake_income', amount: 140, refId: 's1', createdAt: '2026-10-08T00:00:00.000Z' }]
  });
  assert.strictEqual(daily.plans, 0);
  assert.strictEqual(total.plans, 140);
});
