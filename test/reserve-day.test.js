const test = require('node:test');
const assert = require('node:assert');
const { reservationDay, nextReservationAt } = require('../reserve-day');

const day = iso => {
  const { start, end } = reservationDay(new Date(iso).getTime());
  return [start.toISOString(), end.toISOString()];
};

test('winter (GMT): the day starts at 6:00 UTC', () => {
  assert.deepStrictEqual(day('2026-11-02T05:59:59Z'), ['2026-11-01T06:00:00.000Z', '2026-11-02T06:00:00.000Z']);
  assert.deepStrictEqual(day('2026-11-02T06:00:00Z'), ['2026-11-02T06:00:00.000Z', '2026-11-03T06:00:00.000Z']);
});

test('summer (BST): the day starts at 5:00 UTC', () => {
  assert.deepStrictEqual(day('2026-07-15T04:59:59Z'), ['2026-07-14T05:00:00.000Z', '2026-07-15T05:00:00.000Z']);
  assert.deepStrictEqual(day('2026-07-15T05:00:00Z'), ['2026-07-15T05:00:00.000Z', '2026-07-16T05:00:00.000Z']);
});

test('clocks going forward: that day is 23 hours long', () => {
  assert.deepStrictEqual(day('2026-03-29T04:30:00Z'), ['2026-03-28T06:00:00.000Z', '2026-03-29T05:00:00.000Z']);
  assert.deepStrictEqual(day('2026-03-29T05:30:00Z'), ['2026-03-29T05:00:00.000Z', '2026-03-30T05:00:00.000Z']);
});

test('clocks going back: that day is 25 hours long', () => {
  assert.deepStrictEqual(day('2026-10-25T05:30:00Z'), ['2026-10-24T05:00:00.000Z', '2026-10-25T06:00:00.000Z']);
  assert.deepStrictEqual(day('2026-10-25T06:30:00Z'), ['2026-10-25T06:00:00.000Z', '2026-10-26T06:00:00.000Z']);
});

test('month and year ends roll over', () => {
  assert.deepStrictEqual(day('2026-12-01T03:00:00Z'), ['2026-11-30T06:00:00.000Z', '2026-12-01T06:00:00.000Z']);
  assert.deepStrictEqual(day('2027-01-01T05:00:00Z'), ['2026-12-31T06:00:00.000Z', '2027-01-01T06:00:00.000Z']);
  assert.deepStrictEqual(day('2026-12-31T22:00:00Z'), ['2026-12-31T06:00:00.000Z', '2027-01-01T06:00:00.000Z']);
});

test('one reservation per day, and no 24-hour wait after it', () => {
  const now = new Date('2026-11-02T14:00:00Z').getTime();
  const at = iso => [{ reservationDate: iso }];
  assert.strictEqual(nextReservationAt([], now), null);
  // Reserved at 11 PM last night: a new day started at 6 AM, so they can reserve again.
  assert.strictEqual(nextReservationAt(at('2026-11-01T23:00:00Z'), now), null);
  assert.strictEqual(nextReservationAt(at('2026-11-02T05:59:00Z'), now), null);
  // Reserved after this morning's reset: wait for tomorrow's.
  assert.strictEqual(nextReservationAt(at('2026-11-02T06:00:00Z'), now), '2026-11-03T06:00:00.000Z');
  assert.strictEqual(nextReservationAt(at('2026-11-02T13:59:00Z'), now), '2026-11-03T06:00:00.000Z');
});
