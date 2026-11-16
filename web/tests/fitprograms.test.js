// Programs: templates unfold into sessions, and the log says how far along each is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, EXERCISES, GROUPS, exerciseInfo, exerciseNames, buildProgram, blankProgram, blankSession, blankLine, sessionProgress, programProgress, lineLabel } from "../fitprograms.js";
import { keyOf } from "../fit.js";

test("the library is tidy: every exercise in a known group, every template line in the library", () => {
  const keys = new Set();
  for (const e of EXERCISES) {
    assert.ok(GROUPS.includes(e.group), e.name);
    assert.ok(["weight", "reps", "time", "cardio"].includes(e.kind), e.name);
    assert.ok(e.cue.length > 10, e.name);
    assert.ok(!keys.has(keyOf(e.name)), "twice: " + e.name);
    keys.add(keyOf(e.name));
  }
  for (const t of TEMPLATES) for (const d of t.days) for (const [name] of d.lines) assert.ok(exerciseInfo(name), `${t.id}: ${name}`);
  assert.equal(exerciseInfo("push ups").name, "Push-ups");
  assert.equal(exerciseInfo("nothing"), null);
  const names = exerciseNames({ x: { name: "Farmer's walk" }, y: { name: "pushups" } });
  assert.ok(names.includes("Farmer's walk"));
  assert.equal(names.filter((n) => keyOf(n) === keyOf("pushups")).length, 1);
});

test("a template unfolds week by week, with its weekly step and alternation", () => {
  const bw = buildProgram(TEMPLATES.find((t) => t.id === "bodyweight"));
  assert.equal(bw.sessions.length, 12);
  assert.equal(bw.perWeek, 3);
  assert.equal(bw.sessions[0].exercises[0].reps, 8);
  assert.equal(bw.sessions[3].exercises[0].reps, 10); // week 2: +2 reps
  assert.equal(bw.sessions[0].exercises[3].dur, 30);
  assert.equal(bw.sessions[9].exercises[3].dur, 60); // week 4: +30 s
  assert.ok(bw.sessions.every((s) => s.done === null && s.id && s.exercises.every((e) => e.id)));
  const five = buildProgram(TEMPLATES.find((t) => t.id === "5x5"));
  assert.deepEqual(five.sessions.map((s) => s.name).join(""), "ABABABABABAB");
  assert.equal(five.sessions.length, 12);
  const run = buildProgram(TEMPLATES.find((t) => t.id === "run5k"));
  assert.equal(run.sessions.length, 24);
  assert.equal(run.sessions[0].exercises[0].dist, 1.5);
  assert.equal(run.sessions[21].exercises[0].dist, 5); // week 8
  const core = buildProgram(TEMPLATES.find((t) => t.id === "core"));
  assert.equal(core.sessions.length, 14);
  const b = blankProgram("Mine");
  assert.equal(b.sessions.length, 0);
  assert.equal(blankSession("Push").exercises.length, 0);
  assert.equal(blankLine("Squats").sets, 3);
});

test("progress is read off the day's sets", () => {
  const s = { id: "s", name: "A", exercises: [{ id: "1", ex: "Squats", sets: 3, reps: 5 }, { id: "2", ex: "Bench press", sets: 2, reps: 5 }, { id: "3", ex: "Run", sets: 1, dist: 2 }] };
  const none = sessionProgress(s, []);
  assert.deepEqual([none.done, none.total, none.pct, none.complete], [0, 6, 0, false]);
  // sets are logged under their display name ("Bench press"), so that is what a line is matched by
  const some = sessionProgress(s, [{ ex: "squat" }, { ex: "Squats" }, { ex: "Bench press" }, { ex: "Squats" }, { ex: "Squats" }]);
  assert.deepEqual(some.rows.map((r) => [r.logged, r.done, r.target]), [[4, 3, 3], [1, 1, 2], [0, 0, 1]]);
  assert.deepEqual([some.done, some.pct, some.complete], [4, 67, false]);
  const all = sessionProgress(s, [{ ex: "Squats" }, { ex: "Squats" }, { ex: "Squats" }, { ex: "Bench press" }, { ex: "Bench press" }, { ex: "run" }]);
  assert.equal(all.complete, true);
  assert.equal(sessionProgress({ exercises: [] }, []).complete, false);
  const p = { sessions: [{ id: "a", done: "2026-09-20" }, { id: "b", done: null }, { id: "c", done: null }] };
  const pp = programProgress(p);
  assert.deepEqual([pp.n, pp.done, pp.pct, pp.next.id], [3, 1, 33, "b"]);
  assert.equal(programProgress({ sessions: [] }).next, null);
  assert.equal(lineLabel({ sets: 3, reps: 8, w: 60, unit: "kg" }), "3 × 8 @ 60 kg");
  assert.equal(lineLabel({ sets: 3, reps: 8 }), "3 × 8");
  assert.equal(lineLabel({ sets: 2, dur: 30 }), "2 × 30 s");
  assert.equal(lineLabel({ sets: 1, dist: 5, dur: 1680 }), "5 km in 28 min");
});
