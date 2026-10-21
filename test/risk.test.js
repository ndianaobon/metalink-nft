const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeAccount, withdrawalDecision, nextReviewStatus, BUSY_IP_ACCOUNTS } = require('../risk');

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-01T10:00:00Z').getTime();
const user = (id, extra = {}) => ({ id, uid: id.toUpperCase(), username: id, createdAt: new Date(T0).toISOString(), walletAddress: {}, ...extra });
const codes = r => r.flags.map(f => f.code).sort();

test('same device: two accounts on one device token are linked and need review', () => {
  const world = {
    users: [user('alice'), user('bob', { createdAt: new Date(T0 + 30 * DAY).toISOString() })],
    devices: [
      { userId: 'alice', deviceHash: 'h1', platform: 'android' },
      { userId: 'bob', deviceHash: 'h1', platform: 'android' }
    ],
    ips: [{ userId: 'alice', ip: '102.89.1.1' }, { userId: 'bob', ip: '41.58.2.2' }]
  };
  const r = analyzeAccount('alice', world);
  assert.deepEqual(codes(r), ['shared_device']);
  assert.equal(r.level, 'medium');
  assert.equal(r.needsReview, true);
  assert.deepEqual(r.linked, [{ userId: 'bob', via: ['device'] }]);

  const d = withdrawalDecision(r);
  assert.equal(d.allowed, true, 'withdrawals are never blocked outright');
  assert.equal(d.holdForReview, true);
});

test('same device: more accounts on the device raise the score', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const world = {
    users: ids.map((id, i) => user(id, { createdAt: new Date(T0 + i * 10 * DAY).toISOString() })),
    devices: ids.map(id => ({ userId: id, deviceHash: 'shared', platform: 'web' }))
  };
  const two = analyzeAccount('a', { ...world, devices: world.devices.slice(0, 2) });
  const four = analyzeAccount('a', world);
  assert.ok(four.score > two.score);
  assert.equal(four.flags.find(f => f.code === 'shared_device').points, 55);
});

test('different devices: unrelated accounts get no flags', () => {
  const world = {
    users: [user('alice'), user('bob')],
    devices: [
      { userId: 'alice', deviceHash: 'h1', platform: 'android' },
      { userId: 'bob', deviceHash: 'h2', platform: 'ios' }
    ],
    ips: [{ userId: 'alice', ip: '102.89.1.1' }, { userId: 'bob', ip: '41.58.2.2' }],
    deposits: [{ userId: 'alice', status: 'Approved' }, { userId: 'bob', status: 'Approved' }]
  };
  for (const id of ['alice', 'bob']) {
    const r = analyzeAccount(id, world);
    assert.equal(r.score, 0);
    assert.equal(r.level, 'low');
    assert.equal(r.needsReview, false);
    assert.deepEqual(r.flags, []);
    assert.deepEqual(r.linked, []);
  }
});

test('shared Wi-Fi: a household on one IP with separate phones stays low risk', () => {
  const family = ['mum', 'dad', 'son', 'daughter'];
  const world = {
    users: family.map(id => user(id)),
    devices: family.map((id, i) => ({ userId: id, deviceHash: 'phone' + i, platform: 'android' })),
    ips: family.map(id => ({ userId: id, ip: '105.112.10.20' })),
    deposits: family.map(id => ({ userId: id, status: 'Approved' })),
    withdrawals: [{ userId: 'mum', status: 'Pending', walletAddress: 'TMumWallet111' }]
  };
  const r = analyzeAccount('mum', world);
  assert.deepEqual(codes(r), ['shared_ip']);
  assert.equal(r.level, 'low');
  assert.equal(r.needsReview, false);
  assert.equal(withdrawalDecision(r).holdForReview, false, 'shared IP alone must not hold a withdrawal');
});

test('shared Wi-Fi: shared IP is capped below the review threshold even with no deposit', () => {
  // Worst case for weak signals: many accounts on one IP and a withdrawal with no deposit.
  const others = Array.from({ length: BUSY_IP_ACCOUNTS - 2 }, (_, i) => 'n' + i);
  const world = {
    users: [user('me'), ...others.map(id => user(id))],
    devices: [{ userId: 'me', deviceHash: 'mine' }, ...others.map(id => ({ userId: id, deviceHash: 'd-' + id }))],
    ips: ['me', ...others].map(id => ({ userId: id, ip: '197.210.5.5' })),
    withdrawals: [{ userId: 'me', status: 'Pending', walletAddress: 'TMine' }]
  };
  const r = analyzeAccount('me', world);
  assert.deepEqual(codes(r), ['bonus_withdrawal', 'shared_ip']);
  assert.equal(r.level, 'low');
  assert.equal(r.needsReview, false);
  assert.deepEqual(withdrawalDecision(r), { allowed: true, holdForReview: false, reason: '' });
});

test('shared Wi-Fi: very busy IPs (carrier NAT, public hotspots) are ignored entirely', () => {
  const crowd = Array.from({ length: BUSY_IP_ACCOUNTS + 5 }, (_, i) => 'u' + i);
  const world = {
    users: crowd.map(id => user(id)),
    devices: crowd.map(id => ({ userId: id, deviceHash: 'd-' + id })),
    ips: crowd.map(id => ({ userId: id, ip: '102.88.0.1' }))
  };
  const r = analyzeAccount('u0', world);
  assert.equal(r.score, 0);
  assert.equal(r.busyIps, 1);
});

test('bonus abuse: a referral chain of fresh accounts on one phone is high risk', () => {
  const ids = ['farm1', 'farm2', 'farm3', 'farm4'];
  const world = {
    users: ids.map((id, i) => user(id, {
      createdAt: new Date(T0 + i * 2 * 60 * 60 * 1000).toISOString(), // two hours apart
      referredBy: i > 0 ? ids[i - 1] : null
    })),
    devices: ids.map(id => ({ userId: id, deviceHash: 'cheap-phone', platform: 'android' })),
    ips: ids.map(id => ({ userId: id, ip: '102.89.40.4' })),
    signupBonuses: ids.map(id => ({ userId: id, amount: 10 })),
    deposits: [],
    withdrawals: [{ userId: 'farm2', status: 'Pending', walletAddress: 'TFarmCashout' }]
  };
  const r = analyzeAccount('farm2', world);
  assert.deepEqual(codes(r), ['bonus_farming', 'bonus_withdrawal', 'device_signup_burst', 'referral_ring', 'shared_device', 'shared_ip']);
  assert.equal(r.level, 'high');
  assert.equal(r.score, 100);
  assert.equal(r.needsReview, true);
  const farm1 = r.linked.find(l => l.userId === 'farm1');
  assert.deepEqual(farm1.via, ['device', 'ip', 'referral']);
  assert.equal(withdrawalDecision(r).holdForReview, true);
  assert.equal(withdrawalDecision(r).allowed, true);
});

test('bonus abuse: accounts on different phones cashing out to one wallet are linked', () => {
  const world = {
    users: [
      user('x1', { walletAddress: { trc20: 'TSameCashoutWallet' } }),
      user('x2', { walletAddress: { trc20: 'tsamecashoutwallet ' } }) // case/whitespace differences don't hide it
    ],
    devices: [{ userId: 'x1', deviceHash: 'p1' }, { userId: 'x2', deviceHash: 'p2' }],
    signupBonuses: [{ userId: 'x1', amount: 10 }, { userId: 'x2', amount: 10 }]
  };
  const r = analyzeAccount('x1', world);
  assert.deepEqual(codes(r), ['bonus_farming', 'shared_wallet']);
  assert.equal(r.level, 'high');
  assert.equal(r.needsReview, true);
});

test('bonus abuse: a wallet used in a past withdrawal also counts', () => {
  const world = {
    users: [user('y1'), user('y2')],
    withdrawals: [
      { userId: 'y1', status: 'Approved', walletAddress: '0xAbC123' },
      { userId: 'y2', status: 'Pending', walletAddress: '0xabc123' }
    ],
    deposits: [{ userId: 'y1', status: 'Approved' }, { userId: 'y2', status: 'Approved' }]
  };
  assert.deepEqual(codes(analyzeAccount('y2', world)), ['shared_wallet']);
});

test('genuine referral on separate devices is not flagged', () => {
  const world = {
    users: [user('friend'), user('newbie', { referredBy: 'friend' })],
    devices: [{ userId: 'friend', deviceHash: 'f' }, { userId: 'newbie', deviceHash: 'n' }],
    signupBonuses: [{ userId: 'friend', amount: 10 }, { userId: 'newbie', amount: 10 }]
  };
  assert.equal(analyzeAccount('newbie', world).score, 0);
});

test('review status: cleared stays cleared until a new strong signal appears', () => {
  const sameDevice = { flags: [{ code: 'shared_device', strong: true }, { code: 'shared_ip', strong: false }] };
  assert.equal(nextReviewStatus('cleared', ['shared_device'], sameDevice), 'cleared');
  const plusWallet = { flags: [...sameDevice.flags, { code: 'shared_wallet', strong: true }] };
  assert.equal(nextReviewStatus('cleared', ['shared_device'], plusWallet), 'open');
  assert.equal(nextReviewStatus('confirmed', ['shared_device'], plusWallet), 'confirmed');
  assert.equal(nextReviewStatus(undefined, [], plusWallet), 'open');
});
