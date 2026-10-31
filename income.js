// Income Overview: Comprehensive is the sum of the Reserve, Stake/Earn, Team and Activity rows.
const DAY_MS = 24 * 60 * 60 * 1000;

// Which row each ledger entry belongs to. Stake and earn profit isn't listed: it builds up over a
// plan's life (see below) rather than landing on claim day. Sign-up bonuses, deposits, returned
// principal and admin adjustments aren't profit, so they aren't listed either.
const LEDGER_ROWS = {
  reserve_reward: 'reserve',
  team_commission: 'team',
  checkin: 'activity',
  gift_reward: 'activity'
};

function stakePlan(s) {
  return { id: s.id, principal: s.pledgeValue, dailyRate: parseFloat(s.dailyIncome) / 100, start: s.startDate, end: s.endDate, claimed: s.claimed, income: s.income };
}

function earnPlan(p) {
  return { id: p.id, principal: p.amount, dailyRate: p.dailyRatePct / 100, start: p.startDate, end: p.endDate, claimed: p.claimed, income: p.income };
}

// Profit a plan built up between two times, at the same rate the claim routes pay.
function profitBetween(plan, from, to) {
  const ms = to - Math.max(from, new Date(plan.start).getTime());
  return ms > 0 ? plan.principal * plan.dailyRate * (ms / DAY_MS) : 0;
}

// A plan stops building profit at its end date, or when it's claimed early.
function stopTime(plan, claimedAt, now) {
  const end = new Date(plan.end).getTime();
  return Math.min(end, plan.claimed && claimedAt ? new Date(claimedAt).getTime() : now);
}

function incomeOverview({ user, txs, stakes, earnPositions, since, now = new Date() }) {
  const sinceMs = since.getTime();
  const nowMs = now.getTime();
  const counters = user.dailyIncome || {};

  const daily = { reserve: 0, plans: 0, team: 0, activity: 0 };
  const total = { reserve: counters.reserve || 0, plans: 0, team: counters.team || 0, activity: counters.activity || 0 };

  const claimedAt = {};
  for (const t of txs) {
    if (t.type === 'stake_income' || t.type === 'earn_income') claimedAt[t.refId] = t.createdAt;
    const row = LEDGER_ROWS[t.type];
    if (row && new Date(t.createdAt) >= since) daily[row] += t.amount;
  }

  for (const plan of [...stakes.map(stakePlan), ...earnPositions.map(earnPlan)]) {
    const stop = stopTime(plan, claimedAt[plan.id], nowMs);
    daily.plans += profitBetween(plan, sinceMs, stop);
    total.plans += plan.claimed ? (plan.income || 0) : profitBetween(plan, 0, stop);
  }

  const sum = r => r.reserve + r.plans + r.team + r.activity;
  return { daily: { ...daily, comprehensive: sum(daily) }, total: { ...total, comprehensive: sum(total) } };
}

module.exports = { incomeOverview };
