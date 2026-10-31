// Which Income Overview row each kind of earning belongs to. Every type listed counts towards
// Comprehensive; stake and earn income have no row of their own (null). Sign-up bonuses, deposits,
// returned principal and admin adjustments aren't profit, so they aren't listed.
const INCOME_ROWS = {
  stake_income: null,
  earn_income: null,
  reserve_reward: 'reserve',
  team_commission: 'team',
  checkin: 'activity',
  gift_reward: 'activity'
};

function incomeSince(txs, since) {
  const income = { comprehensive: 0, reserve: 0, team: 0, activity: 0 };
  for (const t of txs) {
    if (!(t.type in INCOME_ROWS) || new Date(t.createdAt) < since) continue;
    income.comprehensive += t.amount;
    const row = INCOME_ROWS[t.type];
    if (row) income[row] += t.amount;
  }
  return income;
}

module.exports = { incomeSince };
