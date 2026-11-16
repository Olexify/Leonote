// Workout, food and fasting: what a typed line becomes, and what the day adds up to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSet, parseSets, parseFood, exerciseName, keyOf, wordsToDigits, groupSets, records, daySummaries, foodTotals, fastHours, fastStats, openFast, fmtDur, fmtHours } from "../fit.js";

test("a set typed the usual ways", () => {
  assert.deepEqual(parseSet("10 pushups"), { ex: "Push-ups", reps: 10, sets: 1, w: 0, unit: "kg", dist: 0, dunit: "km", dur: 0 });
  assert.deepEqual(parseSet("push ups 12"), { ex: "Push-ups", reps: 12, sets: 1, w: 0, unit: "kg", dist: 0, dunit: "km", dur: 0 });
  assert.deepEqual(parseSet("3x10 push-ups"), { ex: "Push-ups", reps: 10, sets: 3, w: 0, unit: "kg", dist: 0, dunit: "km", dur: 0 });
  assert.deepEqual(parseSet("10 bench 50 kilo"), { ex: "Bench press", reps: 10, sets: 1, w: 50, unit: "kg", dist: 0, dunit: "km", dur: 0 });
  assert.deepEqual(parseSet("bench 60kg x 5"), { ex: "Bench press", reps: 5, sets: 1, w: 60, unit: "kg", dist: 0, dunit: "km", dur: 0 });
  assert.deepEqual(parseSet("deadlift 5 reps at 100 kg"), { ex: "Deadlift", reps: 5, sets: 1, w: 100, unit: "kg", dist: 0, dunit: "km", dur: 0 });
  assert.deepEqual(parseSet("squat 135 lbs 8"), { ex: "Squats", reps: 8, sets: 1, w: 135, unit: "lb", dist: 0, dunit: "km", dur: 0 });
  assert.deepEqual(parseSet("run 5 km 28 min"), { ex: "Run", reps: 0, sets: 1, w: 0, unit: "kg", dist: 5, dunit: "km", dur: 1680 });
  assert.deepEqual(parseSet("run 5k 27:30"), { ex: "Run", reps: 0, sets: 1, w: 0, unit: "kg", dist: 5, dunit: "km", dur: 1650 });
  assert.deepEqual(parseSet("plank 60 s"), { ex: "Plank", reps: 0, sets: 1, w: 0, unit: "kg", dist: 0, dunit: "km", dur: 60 });
  assert.deepEqual(parseSet("plank"), { ex: "Plank", reps: 1, sets: 1, w: 0, unit: "kg", dist: 0, dunit: "km", dur: 0 });
  assert.equal(parseSet("10 curls", {}, "lb").unit, "lb");
  assert.equal(parseSet("10 curls 20 kg", {}, "lb").unit, "kg");
  assert.equal(parseSet(""), null);
  assert.equal(parseSet("10 50 kg"), null);
});

test("spoken numbers and the names an exercise goes by", () => {
  assert.equal(wordsToDigits("ten push-ups"), "10 push-ups");
  assert.equal(wordsToDigits("bench sixty kilo five reps"), "bench 60 kilo 5 reps");
  assert.equal(wordsToDigits("twenty-five squats"), "25 squats");
  assert.equal(parseSet("ten push ups").reps, 10);
  assert.equal(keyOf("Push-ups"), keyOf("push ups"));
  assert.equal(keyOf("pushups"), keyOf("Pushup"));
  assert.equal(exerciseName("pull ups"), "Pull-ups");
  assert.equal(exerciseName("Bulgarian split squat"), "Bulgarian split squat");
  assert.equal(exerciseName("bulgarian split squats", { bulgariansplitsquat: { name: "Bulgarian split squat" } }), "Bulgarian split squat");
  assert.equal(parseSet("10 bulgarian split squats", { bulgariansplitsquat: { name: "Bulgarian split squat" } }).ex, "Bulgarian split squat");
});

test("a meal typed, and a food seen before", () => {
  assert.deepEqual(parseFood("2 eggs 150 kcal 12g protein"), { text: "2 eggs", kcal: 150, prot: 12 });
  assert.deepEqual(parseFood("banana 100 cal"), { text: "banana", kcal: 100, prot: 0 });
  assert.deepEqual(parseFood("banana", { banana: { text: "Banana", kcal: 105, prot: 1 } }), { text: "Banana", kcal: 105, prot: 1 });
  assert.deepEqual(parseFood("chicken 30 g protein 250 kcal"), { text: "chicken", kcal: 250, prot: 30 });
  assert.equal(parseFood("150 kcal"), null);
  assert.equal(parseFood(""), null);
});

test("the day's sets grouped, and an exercise's records", () => {
  const sets = [
    { t: "2026-09-25T10:00:00", ex: "Bench press", reps: 5, w: 60, unit: "kg" },
    { t: "2026-09-25T10:05:00", ex: "Bench press", reps: 5, w: 70, unit: "kg" },
    { t: "2026-09-25T10:10:00", ex: "Push-ups", reps: 20, w: 0, unit: "kg" },
    { t: "2026-09-24T10:00:00", ex: "Bench press", reps: 8, w: 70, unit: "kg" },
  ];
  const g = groupSets(sets.filter((s) => s.t.startsWith("2026-09-25")));
  assert.deepEqual(g.map((x) => [x.name, x.sets.length, x.reps, x.volume]), [["Bench press", 2, 10, 650], ["Push-ups", 1, 20, 0]]);
  const r = records(sets, keyOf("bench press"));
  assert.equal(r.maxW, 70);
  assert.equal(r.maxWReps, 8);
  assert.equal(r.maxReps, 8);
  assert.equal(r.bestDay, "2026-09-25");
  assert.equal(r.bestDayVolume, 650);
  assert.equal(r.count, 3);
  assert.equal(records(sets, "nothing"), null);
  const days = daySummaries(sets, "2026-09-20", "2026-09-25");
  assert.deepEqual(days.map((d) => [d.day, d.sets, d.reps, d.volume, d.exercises.length]), [["2026-09-25", 3, 30, 650, 2], ["2026-09-24", 1, 8, 560, 1]]);
  assert.deepEqual(foodTotals([{ kcal: 100, prot: 5 }, { kcal: 250 }]), { kcal: 350, prot: 5, n: 2 });
});

test("fasts: the open one, its hours, and the run of good days", () => {
  const fasts = [
    { start: "2026-09-22T20:00:00", end: "2026-09-23T12:00:00" },
    { start: "2026-09-23T20:00:00", end: "2026-09-24T13:30:00" },
    { start: "2026-09-24T21:00:00", end: null },
  ];
  assert.equal(openFast(fasts), fasts[2]);
  assert.equal(fastHours(fasts[0]), 16);
  assert.equal(fastHours(fasts[1]), 17.5);
  assert.equal(fastHours(fasts[2], new Date("2026-09-25T05:00:00").getTime()), 8);
  const st = fastStats(fasts, 16, "2026-09-25");
  assert.equal(st.n, 2);
  assert.equal(st.avg, 16.75);
  assert.equal(st.longest, 17.5);
  assert.equal(st.streak, 2); // today's is still running, so the run is counted from yesterday
  assert.equal(fastStats(fasts, 18, "2026-09-25").streak, 0);
  assert.equal(fmtDur(45), "45 s");
  assert.equal(fmtDur(1680), "28 min");
  assert.equal(fmtDur(1650), "27m 30s");
  assert.equal(fmtDur(3900), "1h 05m");
  assert.equal(fmtHours(16.5), "16h 30m");
});

test("a whole sentence of exercises, as said", () => {
  const names = (s) => parseSets(s).map((p) => `${p.ex}:${p.reps || ""}${p.w ? "@" + p.w : ""}${p.dist ? "/" + p.dist + p.dunit : ""}`);
  assert.deepEqual(names("I did ten push-ups, twenty squats and a 5 km run."), ["Push-ups:10", "Squats:20", "Run:/5km"]);
  assert.deepEqual(names("Bench 62.5 kg 5 reps then 3x10 pull-ups"), ["Bench press:5@62.5", "Pull-ups:10"]);
  assert.deepEqual(names("clean and jerk 60 kg"), ["Clean jerk:@60"]);
  assert.deepEqual(names("10 pushups"), ["Push-ups:10"]);
  assert.deepEqual(names("Twelve curls. That's it."), ["Curls:12"]);
  assert.deepEqual(names("plank, 60 s"), ["Plank:"]);
  assert.deepEqual(parseSets(""), []);
});
