// A reservation day runs from 6:00 AM to 6:00 AM UK time (Europe/London, so it follows GMT and
// BST). Each user can make one reservation per day, at any time during it.
const RESET_HOUR = 6;

const londonClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
});

function londonParts(ms) {
  const parts = {};
  for (const p of londonClock.formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return parts;
}

// The moment it's `hour`:00 in London on the given date (Date.UTC rolls day 0 or 32 into the next month).
function londonTime(year, month, day, hour) {
  const guess = Date.UTC(year, month - 1, day, hour);
  const p = londonParts(guess);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
  return new Date(guess - offset);
}

function reservationDay(now = Date.now()) {
  const p = londonParts(now);
  const day = p.hour < RESET_HOUR ? p.day - 1 : p.day;
  return { start: londonTime(p.year, p.month, day, RESET_HOUR), end: londonTime(p.year, p.month, day + 1, RESET_HOUR) };
}

// When the user can reserve again, or null if they haven't reserved yet this reservation day.
function nextReservationAt(orders, now = Date.now()) {
  const { start, end } = reservationDay(now);
  return orders.some(o => new Date(o.reservationDate) >= start) ? end.toISOString() : null;
}

module.exports = { reservationDay, nextReservationAt };
