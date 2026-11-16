import test from "node:test";
import assert from "node:assert/strict";
import { timeLeft, agoText, keepLabel } from "../trash.js";

const DAY = 86400000;
const now = Date.UTC(2026, 8, 21, 12);

test("trash: how long an entry has left", () => {
  assert.equal(timeLeft(now - 3 * DAY, 30, now), "27 days left");
  assert.equal(timeLeft(now - 29 * DAY - 1000, 30, now), "24 hours left");
  assert.equal(timeLeft(now - 31 * DAY, 30, now), "goes at the next clean-up");
  assert.equal(timeLeft(now - 400 * DAY, 0, now), "kept until you delete it");
  assert.equal(timeLeft(null, 30, now), "age unknown - kept");
});

test("trash: when it went, in words", () => {
  assert.equal(agoText(now - 20000, now), "just now");
  assert.equal(agoText(now - 5 * 60000, now), "5 min ago");
  assert.equal(agoText(now - 3 * 3600000, now), "3 hours ago");
  assert.equal(agoText(now - 3 * DAY, now), "3 days ago");
  assert.equal(agoText(null, now), "");
  assert.equal(keepLabel(0), "Forever");
  assert.equal(keepLabel(365), "1 year");
});
