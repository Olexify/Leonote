import { test } from "node:test";
import assert from "node:assert/strict";
import { rankOf, RANKS, xpForLevel, levelOf, costOf, badgesOf, dayBonus } from "../stats.js";

test("ranks: each lasts several levels, climbed in tiers, and the next step is where that tier begins", () => {
  assert.equal(rankOf(0).name, "Awakened I");
  assert.equal(rankOf(17).name, "Hunter I");
  assert.equal(rankOf(50).name, "Scholar I");
  assert.equal(rankOf(960).name, "King of the Pride I");
  assert.equal(rankOf(5000).name, "Starkindler");
  assert.equal(rankOf(24999).name, "Starkindler ★19");
  for (let l = 0; l < 11000; l += l < 400 ? 1 : 7) {
    const r = rankOf(l);
    assert.ok(r.next.level > l, `level ${l}: the next step is ahead`);
    assert.equal(rankOf(r.next.level).name, r.next.name, `level ${l}: ${r.next.name} begins at ${r.next.level}`);
    if (l > 0) assert.ok(rankOf(l - 1).name === r.name || rankOf(l - 1).next.name === r.name, `level ${l}: no tier is skipped`);
  }
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i][0] - RANKS[i - 1][0] >= 3, "a rank lasts at least three levels");
});

test("levels: the old curve to level 30, then a slow climb to a steady cost, with no ceiling", () => {
  // as it always was, so nobody loses a level
  assert.equal(xpForLevel(10), 2400);
  assert.equal(xpForLevel(17), 2400 + 7 * 800);
  assert.equal(xpForLevel(30), 2400 + 20 * 800);
  assert.equal(costOf(31), 840);
  assert.equal(costOf(60), 2000);
  assert.equal(costOf(5000), 2000);
  for (let l = 1; l < 300; l++) assert.equal(xpForLevel(l) - xpForLevel(l - 1), costOf(l), `level ${l} costs what costOf says`);
  for (const l of [0, 1, 9, 10, 11, 30, 31, 59, 60, 61, 1000, 12345]) {
    assert.equal(levelOf(xpForLevel(l)), l, `exactly at level ${l}`);
    if (l) assert.equal(levelOf(xpForLevel(l) - 1), l - 1, `just short of level ${l}`);
  }
});

test("rank colours: one per rank; the sidebar's level icon and bar wear the theme colour", async () => {
  const { RANK_COLORS, rankColor } = await import("../stats.js");
  assert.equal(RANK_COLORS.length, RANKS.length, "a colour for every rank");
  for (const [l, i] of [[0, 0], [28, 5], [29, 5], [30, 6], [5000, RANKS.length - 1], [99999, RANKS.length - 1]]) assert.equal(rankColor(l), RANK_COLORS[i], `level ${l}`);
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  assert.match(css, /\n\.sb-level-ico \{[^}]*color: var\(--accent\)/, "the chip icon wears the theme colour");
  assert.match(css, /\n\.sb-level-bar > span \{ background: var\(--accent\)/, "the chip bar wears the theme colour");
});

test("badges and the day bonus", () => {
  const b = badgesOf({ tasks_done: 120, pomo_total_work_secs: 3600 * 12, streak: { best: 8 }, xp: xpForLevel(26) });
  const by = Object.fromEntries(b.map((x) => [x.id, x]));
  assert.equal(by.tasks.got, 4); assert.equal(by.tasks.next, 250); assert.equal(by.tasks.stage, 0);
  assert.equal(by.focus.got, 2); assert.equal(by.level.got, 2);
  // a stage shows until complete; then the next; the third stays
  const deep = Object.fromEntries(badgesOf({ tasks_done: 800, pomo_total_work_secs: 3600 * 20000 }).map((x) => [x.id, x]));
  assert.equal(deep.tasks.stage, 1); assert.deepEqual(deep.tasks.shown, [750, 1000, 1500, 2000, 3000]);
  assert.equal(deep.focus.got, 16); assert.equal(deep.focus.stage, 2); assert.equal(deep.focus.next, null);
  assert.equal(badgesOf({ pomo_daily: { a: { work: 60 }, b: { work: 0 }, c: { work: 5 } } }).find((x) => x.id === "days").value, 2);
  assert.equal(dayBonus(1), 10); assert.equal(dayBonus(3), 20); assert.equal(dayBonus(50), 60);
});

test("daily challenges: three a day, the same all day, only for what has been used, met once and taken back with the work", async () => {
  const { challengesFor, createStats } = await import("../stats.js");
  const a = challengesFor("2026-10-03", {});
  assert.deepEqual(a, challengesFor("2026-10-03", {}), "the same all day");
  assert.ok(a.every((c) => ["taskDone", "subtaskDone"].includes(c.kind)), "no focus or habits before they were ever used");
  assert.ok(challengesFor("2026-10-03", { focusMin: 5, habitDone: 2, recurringDone: 1 }).length === 3);
  const S = createStats({ saveStats: async () => {} }, { xp: 0 });
  const t = S.challenges().find((c) => c.kind === "taskDone") || S.challenges()[0];
  const kind = t.kind;
  for (let i = 0; i < t.target; i++) S.award(15, kind);
  assert.ok(S.challenges().find((c) => c.id === t.id).done, "met");
  const xp = S.xp;
  S.award(-15, kind);
  assert.ok(!S.challenges().find((c) => c.id === t.id).done, "taken back");
  assert.equal(S.xp, xp - 15 - t.reward);
});
