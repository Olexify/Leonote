import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMove, planBreak, shape, setDone, setNumbers, swapMove, removeBreak, dayPart, xpFor, MOVES, EQUIPMENT } from "../deskbreak.js";
import { exerciseInfo } from "../fitprograms.js";

test("break exercises: all known to the library, and only for equipment the user has", () => {
  for (const m of MOVES) { assert.ok(exerciseInfo(m.ex), m.ex); assert.ok(!m.need || EQUIPMENT.some(([id]) => id === m.need), m.ex); }
  assert.equal(pickMove([], []).name, "Push-ups");
  const none = new Set(MOVES.filter((m) => !m.need).map((m) => m.ex));
  const sets = [];
  for (let i = 0; i < 12; i++) { const m = pickMove([], sets); assert.ok(none.has(m.name), m.name); sets.push({ ex: m.name, t: `2026-11-10T10:${10 + i}:00`, reps: m.reps }); }
  assert.equal(new Set(sets.slice(0, none.size).map((s) => s.ex)).size, none.size, "each one once before any repeats");
  assert.equal(pickMove(["bar"], [{ ex: "Push-ups", t: "2026-11-10T10:00:00" }, { ex: "Squats", t: "2026-11-10T10:01:00" }]).name, "Pull-ups");
});

test("the numbers of last time come back, and what was really done is what is logged", () => {
  const d = shape({ sets: [{ id: "old", ex: "Bench press", t: "2026-11-01T10:00:00", reps: 10, w: 100, unit: "kg" }] });
  const only = (name) => MOVES.filter((m) => m.ex !== name).map((m) => m.ex);
  const m = pickMove(["barbell"], d.sets, only("Bench press"));
  assert.deepEqual([m.name, m.reps, m.w], ["Bench press", 10, 100]);
  d.breaks.push({ id: "b1", t: "2026-11-10T11:00:00", kind: "move", ...m, done: false });
  setDone(d, "b1", true);
  assert.equal(d.sets.length, 2);
  setNumbers(d, "b1", { reps: 5 });
  assert.deepEqual(d.sets.filter((s) => s.id === "b1").map((s) => [s.reps, s.w, s.src]), [[5, 100, "break"]], "one set, with the new number");
  setDone(d, "b1", false);
  assert.deepEqual(d.sets.map((s) => s.id), ["old"], "unticked: out of the Workout log, the entry stays as a box");
  assert.equal(d.breaks[0].done, false);
});

test("a break: what was asked for, eyes taking turns, another exercise on request", () => {
  const d = shape({});
  const t = "2026-11-10T12:00:00";
  const a = planBreak({ kinds: ["move", "eyes", "water"], have: [] }, d, t);
  assert.deepEqual(a.map((b) => b.kind), ["move", "eyes", "water"]);
  d.breaks.push(...a);
  const b = planBreak({ kinds: ["eyes"], have: [] }, d, t);
  assert.equal(b.length, 1);
  assert.notEqual(b[0].name, a[1].name);
  const was = a[0].name;
  swapMove(d, a[0].id, []);
  assert.notEqual(d.breaks[0].name, was);
  setDone(d, a[2].id, true);
  assert.equal(d.sets.length, 0, "water is no set");
});

test("own exercises take their turn; XP once per entry", async () => {
  const { ownMove, xpFor } = await import("../deskbreak.js");
  assert.deepEqual(ownMove("wall sit 30 sec"), { ex: "Wall sit", need: "", reps: 0, dur: 30, w: 0, unit: "kg" });
  const halo = ownMove("kettlebell halo 10");
  assert.equal(halo.reps, 10);
  assert.equal(ownMove("   "), null);
  assert.equal(pickMove([], [], [], [halo]).name, halo.ex, "a new one of your own comes first");
  const d = shape({});
  const [mv, , water] = planBreak({ kinds: ["move", "eyes", "water"], have: [], own: [halo] }, d, "2026-11-10T12:00:00");
  d.breaks.push(mv, water);
  assert.equal(xpFor(d, mv.id, 3), 0, "not ticked, nothing");
  setDone(d, mv.id, true); setDone(d, water.id, true);
  assert.equal(xpFor(d, mv.id, 3) + xpFor(d, water.id, 3), 4);
  setDone(d, mv.id, false); setDone(d, mv.id, true);
  assert.equal(xpFor(d, mv.id, 3), 0, "ticking again gives nothing");
});

test("a preset gives only its own exercises, with your own ones taking their turn too", async () => {
  const { PRESETS, pickMove, MOVES } = await import("../deskbreak.js");
  const oleks = PRESETS.find((p) => p.id === "oleks");
  const names = new Set(oleks.moves.map((m) => m.ex));
  for (const n of ["Push-ups", "Hyperextension", "Curls", "Burpees", "Push press"]) assert.ok(names.has(n), n);
  const sets = [];
  const seen = new Set();
  for (let i = 0; i < oleks.moves.length; i++) {
    const m = pickMove(oleks.have, sets, [], oleks.moves, []);
    seen.add(m.name);
    sets.push({ ex: m.name, t: "2026-11-11T10:" + String(i).padStart(2, "0") });
  }
  assert.equal(seen.size, oleks.moves.length, "every exercise of the preset comes up once before any repeats");
  assert.ok([...seen].every((n) => names.has(n)), "nothing from the built-in list");
  for (const p of PRESETS) for (const m of p.moves) assert.ok(!m.need || p.have.includes(m.need), p.id + ": " + m.ex + " needs " + m.need);
  assert.ok(MOVES.length > 0);
});

test("water at most once an hour; an entry can be taken off with its set", () => {
  const d = shape({});
  const at = (hm) => `2026-11-14T${hm}:00`;
  const one = planBreak({ kinds: ["water"], have: [] }, d, at("10:00"));
  assert.equal(one.length, 1);
  d.breaks.push(...one);
  assert.equal(planBreak({ kinds: ["water"], have: [] }, d, at("10:40")).length, 0, "within the hour");
  assert.equal(planBreak({ kinds: ["water"], have: [] }, d, at("12:00")).length, 1, "an unticked one does not stop the next hour's");
  setDone(d, one[0].id, true);
  assert.equal(planBreak({ kinds: ["water"], have: [] }, d, at("10:30")).length, 0, "within the hour");
  assert.equal(planBreak({ kinds: ["water"], have: [] }, d, at("11:05")).length, 1);
  const mv = planBreak({ kinds: ["move"], have: [] }, d, at("11:10"));
  d.breaks.push(...mv);
  setDone(d, mv[0].id, true);
  assert.equal(d.sets.length, 1);
  removeBreak(d, mv[0].id);
  assert.equal(d.sets.length, 0);
  assert.ok(!d.breaks.some((b) => b.id === mv[0].id));
});

test("glasses of water: those ticked on the day", async () => {
  const { glassesOn } = await import("../deskbreak.js");
  const d = shape({ breaks: [
    { id: "a", t: "2026-11-14T09:00:00", kind: "water", done: true },
    { id: "b", t: "2026-11-14T11:00:00", kind: "water", done: false },
    { id: "c", t: "2026-11-14T13:00:00", kind: "water", done: true },
    { id: "d", t: "2026-11-13T13:00:00", kind: "water", done: true },
  ] });
  assert.equal(glassesOn(d, "2026-11-14"), 2);
});

test("an exercise's own default wins over last time's numbers", () => {
  const sets = [{ ex: "Hyperextension", reps: 12, t: "2026-11-14T10:00:00" }];
  const own = [{ ex: "Hyperextension", need: "", reps: 12 }];
  assert.equal(pickMove([], sets, [], own, []).reps, 12);
  const m = pickMove([], sets, [], own, [], { hyperextension: { reps: 20, w: 15, unit: "kg" } });
  assert.deepEqual([m.reps, m.w], [20, 15]);
});

test("an exercise offered and skipped does not come straight back", () => {
  const own = [{ ex: "Push-ups", need: "", reps: 10 }, { ex: "Squats", need: "", reps: 10 }];
  const first = pickMove([], [], [], own, []);
  const next = pickMove([], [], [], own, [], {}, [{ name: first.name, t: "2026-11-16T10:00:00" }]);
  assert.notEqual(next.name, first.name);
});

test("a habit set to come up in breaks joins the exercise at its part of the day, not again within the hour", () => {
  assert.deepEqual(["09:00", "13:30", "18:00"].map((h) => dayPart(`2026-11-18T${h}:00`)), ["start", "middle", "end"]);
  const habits = [{ id: "h1", name: "Stretch hamstrings", inBreaks: "start" }, { id: "h2", name: "Read 10 pages", inBreaks: "end" }, { id: "h3", name: "Floss", inBreaks: "any" }];
  const d = shape({});
  const at = (h, rnd = () => 0) => planBreak({ kinds: ["move"], have: [], habits, rnd }, d, `2026-11-18T${h}:00`).filter((b) => b.kind === "habit").map((b) => b.habit);
  assert.deepEqual(at("09:00"), ["h1"], "the morning one first");
  assert.deepEqual(at("09:00", () => 0.99), ["h3"], "or the any-time one, at random");
  assert.deepEqual(at("18:00"), ["h2"]);
  assert.deepEqual(planBreak({ kinds: ["eyes"], have: [], habits }, d, "2026-11-18T09:00:00").filter((b) => b.kind === "habit"), [], "only with the exercise");
  d.breaks.push({ id: "x", t: "2026-11-18T09:00:00", kind: "habit", habit: "h1", name: "Stretch hamstrings", done: false });
  assert.deepEqual(at("09:30"), ["h3"], "not the same one again within the hour");
  assert.deepEqual(at("10:05"), ["h1"]);
  d.breaks[0].done = true;
  assert.equal(xpFor(d, "x", 5), 0, "a habit earns its own XP, not a workout set's");
});
