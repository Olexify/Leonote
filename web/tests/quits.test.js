// The quit trackers' numbers: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { quitStats, clock, span, daysSpanned, DAY } from "../quitstats.js";

const at = (s) => new Date(s).getTime();

test("a clean run with no relapse counts from the start", () => {
  const q = { start: new Date(2026, 8, 1, 9, 0).toISOString(), relapses: [] };
  const s = quitStats(q, at(new Date(2026, 8, 11, 12, 0)));
  assert.equal(s.days, 10);
  assert.equal(s.previous, null);
  assert.equal(s.best, s.current);
  assert.equal(s.relapses, 0);
  assert.equal(s.next, 14, "the next milestone after 10 days");
  assert.ok(s.progress > 0 && s.progress < 1);
  assert.equal(Math.round(s.nextDayIn / 3_600_000), 21, "the tenth day ended at 09:00; the next is 21 h off");
});

test("a relapse starts the count again and keeps what came before", () => {
  const q = { start: new Date(2026, 0, 1, 0, 0).toISOString(), relapses: [new Date(2026, 3, 1, 22, 0).toISOString(), new Date(2026, 3, 11, 22, 0).toISOString()] };
  const now = at(new Date(2026, 3, 14, 22, 0));
  const s = quitStats(q, now);
  assert.equal(s.days, 3, "three days since the last slip");
  assert.equal(Math.round(s.previous / DAY), 10, "the streak between the two slips");
  assert.equal(Math.floor(s.best / DAY), 90, "Jan 1 to the evening of Apr 1 is still the best");
  assert.equal(s.relapses, 2);
  // Jan 1 - Apr 14 is 104 days; two of them had a slip
  assert.equal(s.yearTracked, 104);
  assert.equal(s.yearClean, 102);
});

test("a relapse given before the start or in the future is left out", () => {
  const q = { start: new Date(2026, 5, 1).toISOString(), relapses: [new Date(2026, 4, 1).toISOString(), new Date(2027, 0, 1).toISOString()] };
  assert.equal(quitStats(q, at(new Date(2026, 5, 5))).relapses, 0);
});

test("a year that began before the tracker counts only its own days", () => {
  const q = { start: new Date(2025, 11, 20).toISOString(), relapses: [] };
  const s = quitStats(q, at(new Date(2026, 0, 10, 12)));
  assert.equal(s.yearTracked, 10);
  assert.equal(s.yearClean, 10);
  assert.equal(daysSpanned(at(new Date(2026, 2, 28)), at(new Date(2026, 2, 30, 5))), 3, "a DST weekend is still three days");
});

test("times read the way people say them", () => {
  assert.equal(clock(3 * DAY + 4 * 3600e3 + 23 * 60e3 + 51e3), "3 d 04:23:51");
  assert.equal(clock(59e3), "00:00:59");
  assert.equal(span(2 * DAY + 5), "2 days");
  assert.equal(span(DAY), "1 day");
  assert.equal(span(5 * 3600e3), "5 h");
  assert.equal(span(null), "—");
});
