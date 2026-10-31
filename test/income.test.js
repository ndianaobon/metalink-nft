const test = require('node:test');
const assert = require('node:assert');
const { incomeSince } = require('../income');

const since = new Date('2026-10-31T00:00:00.000Z');
const today = '2026-10-31T09:00:00.000Z';

test('Comprehensive adds up every kind of profit made since the start of the day', () => {
  const income = incomeSince([
    { type: 'stake_income', amount: 10, createdAt: today },
    { type: 'earn_income', amount: 20, createdAt: today },
    { type: 'reserve_reward', amount: 3, createdAt: today },
    { type: 'team_commission', amount: 4, createdAt: today },
    { type: 'checkin', amount: 1, createdAt: today },
    { type: 'gift_reward', amount: 2, createdAt: today }
  ], since);
  assert.deepStrictEqual(income, { comprehensive: 40, reserve: 3, team: 4, activity: 3 });
});

test('earnings from before the start of the day are left out', () => {
  const income = incomeSince([
    { type: 'reserve_reward', amount: 5, createdAt: '2026-10-30T23:59:59.999Z' },
    { type: 'reserve_reward', amount: 7, createdAt: since.toISOString() }
  ], since);
  assert.deepStrictEqual(income, { comprehensive: 7, reserve: 7, team: 0, activity: 0 });
});

test('money that is not profit is left out', () => {
  const income = incomeSince([
    'signup_bonus', 'deposit', 'stake_return', 'earn_return', 'withdrawal_refund', 'admin_credit'
  ].map(type => ({ type, amount: 100, createdAt: today })), since);
  assert.deepStrictEqual(income, { comprehensive: 0, reserve: 0, team: 0, activity: 0 });
});
