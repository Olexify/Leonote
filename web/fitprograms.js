// Programs: the book a workout follows. An exercise library with a cue for
// each, program templates that unfold into a run of sessions (chapters), and
// the sums that say how far along a session or a program is - all pure, so
// the view only draws. A program is
//   { id, name, tpl, note, perWeek, created, sessions: [session] }
//   session: { id, name, note, done: "YYYY-MM-DD"|null, exercises: [{ id, ex, sets, reps, w, unit, dur, dist }] }
// and its progress is read off the log: a planned exercise is complete on a
// day once that many sets of it are logged that day.

import { keyOf } from "./fit.js";
import { uuid } from "./util.js";

export const GROUPS = ["Chest", "Back", "Shoulders", "Arms", "Legs", "Glutes", "Core", "Cardio", "Mobility"];

/** kind: weight (reps × load), reps (bodyweight), time (seconds), cardio (distance and time). */
const E = (name, group, kind, cue) => ({ name, group, kind, cue });
export const EXERCISES = [
  E("Bench press", "Chest", "weight", "Bar to the lower chest, elbows about 45°, feet driving into the floor."),
  E("Incline bench press", "Chest", "weight", "Bench at 30°; the bar meets the upper chest."),
  E("Dumbbell press", "Chest", "weight", "Palms forward, dumbbells meet above the chest without clashing."),
  E("Chest fly", "Chest", "weight", "Soft elbows, wide arc, stop when the chest stretches."),
  E("Push-ups", "Chest", "reps", "Body one straight line, chest to the floor, elbows tucked."),
  E("Dips", "Chest", "reps", "Lean forward for chest, upright for triceps; shoulders below elbows."),
  E("Deadlift", "Back", "weight", "Bar over mid-foot, flat back, push the floor away, lock out tall."),
  E("Rows", "Back", "weight", "Hinge, pull the bar to the lower ribs, squeeze the blades together."),
  E("Dumbbell row", "Back", "weight", "One hand on the bench, elbow to the hip, no twisting."),
  E("Pull-ups", "Back", "reps", "Overhand, chest to the bar, full hang at the bottom."),
  E("Chin-ups", "Back", "reps", "Underhand; more biceps than the pull-up."),
  E("Lat pulldown", "Back", "weight", "Lean back a touch, bar to the collarbones, elbows down and back."),
  E("Face pulls", "Back", "weight", "Rope to the face, elbows high, pause with the hands apart."),
  E("Overhead press", "Shoulders", "weight", "Bar from the collarbones straight up; head through at the top."),
  E("Arnold press", "Shoulders", "weight", "Start palms in, turn out as you press."),
  E("Lateral raises", "Shoulders", "weight", "Lead with the elbows to shoulder height; light and slow."),
  E("Rear delt fly", "Shoulders", "weight", "Bent over, arms out wide, thumbs down."),
  E("Curls", "Arms", "weight", "Elbows pinned at the sides; no swinging."),
  E("Hammer curls", "Arms", "weight", "Palms facing each other; forearms work too."),
  E("Triceps pushdown", "Arms", "weight", "Elbows still, push to full lockout."),
  E("Skull crushers", "Arms", "weight", "Bar to the forehead, elbows pointing up."),
  E("Close-grip bench", "Arms", "weight", "Hands shoulder-width, elbows in; triceps lead."),
  E("Squats", "Legs", "weight", "Hips back and down, knees over the toes, below parallel, chest up."),
  E("Front squat", "Legs", "weight", "Bar on the shoulders, elbows high, torso upright."),
  E("Goblet squat", "Legs", "weight", "Dumbbell at the chest; elbows brush the knees at the bottom."),
  E("Leg press", "Legs", "weight", "Feet mid-plate, lower until the hips start to tuck, never lock hard."),
  E("Lunges", "Legs", "reps", "Long step, back knee near the floor, front shin vertical."),
  E("Bulgarian split squat", "Legs", "reps", "Rear foot on the bench; most of the weight on the front leg."),
  E("Step-ups", "Legs", "reps", "Drive through the top foot; do not push off the floor."),
  E("Romanian deadlift", "Legs", "weight", "Soft knees, hips back, bar down the thighs until the hamstrings pull."),
  E("Leg curl", "Legs", "weight", "Heels to the glutes, a pause, then slow down."),
  E("Leg extension", "Legs", "weight", "Full lockout at the top, controlled on the way down."),
  E("Calf raises", "Legs", "weight", "Full stretch at the bottom, a pause at the top."),
  E("Hip thrust", "Glutes", "weight", "Shoulders on the bench, chin tucked, squeeze at the top."),
  E("Glute bridge", "Glutes", "reps", "Feet flat, drive the hips up, hold a second."),
  E("Plank", "Core", "time", "Elbows under the shoulders, glutes tight, one straight line."),
  E("Side plank", "Core", "time", "Hips high, stacked feet; switch sides each set."),
  E("Crunches", "Core", "reps", "Ribs to the hips; the neck stays long."),
  E("Leg raises", "Core", "reps", "Lower slowly; the lower back stays on the floor."),
  E("Hanging leg raise", "Core", "reps", "From a dead hang, legs to horizontal or higher."),
  E("Dead bug", "Core", "reps", "Opposite arm and leg reach out; the back stays flat."),
  E("Russian twists", "Core", "reps", "Lean back, feet up, turn from the ribs."),
  E("Ab wheel", "Core", "reps", "Roll out as far as the back stays flat."),
  E("Mountain climbers", "Cardio", "reps", "Plank position; knees drive in fast, hips low."),
  E("Burpees", "Cardio", "reps", "Down, kick back, push-up, jump up."),
  E("Jumping jacks", "Cardio", "reps", "Light on the feet; a warm-up staple."),
  E("Jump rope", "Cardio", "time", "Small hops, wrists turning, elbows in."),
  E("Run", "Cardio", "cardio", "Easy pace means you could still talk."),
  E("Walk", "Cardio", "cardio", "Brisk enough to warm up."),
  E("Cycling", "Cardio", "cardio", "Cadence around 80-90; save the legs for the hills."),
  E("Swim", "Cardio", "cardio", "Long strokes, breathe on both sides."),
  E("Rowing machine", "Cardio", "cardio", "Legs, then body, then arms - and back in reverse."),
  E("Stretching", "Mobility", "time", "Hold, breathe out, ease a little further."),
  E("Foam rolling", "Mobility", "time", "Slow passes; pause on the tender spots."),
  E("Hip openers", "Mobility", "time", "Deep lunge, lean into the front hip."),
  E("Cat-cow", "Mobility", "time", "Round and arch the back with the breath."),
];
const BY_KEY = new Map(EXERCISES.map((e) => [keyOf(e.name), e]));

/** The library's entry for a name, however it was typed, or null. */
export const exerciseInfo = (name) => BY_KEY.get(keyOf(name)) || null;

/** Names for a picker: the library plus whatever the user has done, without repeats. */
export function exerciseNames(known = {}) {
  const out = EXERCISES.map((e) => e.name);
  const have = new Set(out.map(keyOf));
  for (const x of Object.values(known)) if (x && x.name && !have.has(keyOf(x.name))) { out.push(x.name); have.add(keyOf(x.name)); }
  return out;
}

// ── templates ──
// An exercise line: [name, sets, reps] for lifting, [name, sets, 0, { dur }] for time, [name, 1, 0, { dist, dur }] for cardio.
// `weekly` is what each later week adds to every line of its kind: reps, dur (s), dist (km).
const S = (name, ...lines) => ({ name, lines });
export const TEMPLATES = [
  {
    id: "bodyweight", name: "Bodyweight start", level: "Beginner", weeks: 4, perWeek: 3,
    blurb: "No kit at all. Three short sessions a week, a little more each week.",
    weekly: { reps: 2, dur: 10 },
    days: [
      S("Push and legs", ["Push-ups", 3, 8], ["Squats", 3, 12], ["Lunges", 2, 10], ["Plank", 3, 0, { dur: 30 }]),
      S("Hips and core", ["Glute bridge", 3, 12], ["Dips", 3, 6], ["Crunches", 3, 15], ["Mountain climbers", 3, 20]),
      S("Everything", ["Burpees", 3, 8], ["Squats", 3, 15], ["Push-ups", 3, 10], ["Side plank", 2, 0, { dur: 20 }]),
    ],
  },
  {
    id: "5x5", name: "Strength 5×5", level: "Beginner to intermediate", weeks: 4, perWeek: 3,
    blurb: "The classic barbell start: two sessions in turn, three times a week. Set your weights, then add 2.5 kg whenever all five sets are done.",
    days: [
      S("A", ["Squats", 5, 5], ["Bench press", 5, 5], ["Rows", 5, 5]),
      S("B", ["Squats", 5, 5], ["Overhead press", 5, 5], ["Deadlift", 1, 5]),
    ],
  },
  {
    id: "ppl", name: "Push / Pull / Legs", level: "Intermediate", weeks: 4, perWeek: 3,
    blurb: "One push day, one pull day, one leg day a week - the split most gyms run.",
    days: [
      S("Push", ["Bench press", 4, 8], ["Overhead press", 3, 10], ["Incline bench press", 3, 10], ["Lateral raises", 3, 15], ["Triceps pushdown", 3, 12]),
      S("Pull", ["Deadlift", 3, 5], ["Pull-ups", 3, 8], ["Rows", 3, 10], ["Face pulls", 3, 15], ["Curls", 3, 12]),
      S("Legs", ["Squats", 4, 8], ["Romanian deadlift", 3, 10], ["Leg press", 3, 12], ["Leg curl", 3, 12], ["Calf raises", 4, 15], ["Plank", 3, 0, { dur: 45 }]),
    ],
  },
  {
    id: "upperlower", name: "Upper / Lower", level: "Intermediate", weeks: 4, perWeek: 4,
    blurb: "Four days a week, each half of the body twice.",
    days: [
      S("Upper A", ["Bench press", 4, 6], ["Rows", 4, 8], ["Overhead press", 3, 10], ["Lat pulldown", 3, 10], ["Curls", 2, 12], ["Triceps pushdown", 2, 12]),
      S("Lower A", ["Squats", 4, 6], ["Romanian deadlift", 3, 10], ["Leg press", 3, 12], ["Calf raises", 3, 15], ["Plank", 3, 0, { dur: 45 }]),
      S("Upper B", ["Overhead press", 4, 6], ["Pull-ups", 4, 8], ["Dumbbell press", 3, 10], ["Dumbbell row", 3, 10], ["Lateral raises", 3, 15], ["Hammer curls", 2, 12]),
      S("Lower B", ["Deadlift", 4, 5], ["Front squat", 3, 8], ["Lunges", 3, 10], ["Leg curl", 3, 12], ["Hanging leg raise", 3, 10]),
    ],
  },
  {
    id: "fullbody", name: "Full body ×3", level: "Beginner", weeks: 4, perWeek: 3,
    blurb: "The whole body every visit, three visits a week. Simple and it works.",
    days: [
      S("Full body", ["Squats", 3, 8], ["Bench press", 3, 8], ["Rows", 3, 8], ["Overhead press", 2, 10], ["Plank", 3, 0, { dur: 30 }]),
      S("Full body", ["Deadlift", 3, 5], ["Dumbbell press", 3, 10], ["Lat pulldown", 3, 10], ["Lunges", 2, 10], ["Leg raises", 3, 10]),
      S("Full body", ["Goblet squat", 3, 10], ["Push-ups", 3, 12], ["Dumbbell row", 3, 10], ["Lateral raises", 3, 15], ["Side plank", 2, 0, { dur: 30 }]),
    ],
  },
  {
    id: "run5k", name: "Run to 5 km", level: "Beginner", weeks: 8, perWeek: 3,
    blurb: "Three easy runs a week, half a kilometre longer each week, until 5 km feels ordinary.",
    weekly: { dist: 0.5 },
    days: [
      S("Easy run", ["Run", 1, 0, { dist: 1.5 }]),
      S("Easy run", ["Run", 1, 0, { dist: 1.5 }]),
      S("Long run", ["Run", 1, 0, { dist: 1.5 }], ["Walk", 1, 0, { dist: 1 }]),
    ],
  },
  {
    id: "core", name: "Core and mobility, 10 minutes", level: "Anyone", weeks: 2, perWeek: 7,
    blurb: "Ten minutes every day for two weeks. Good on its own, better beside anything else.",
    days: [
      S("Core", ["Plank", 2, 0, { dur: 30 }], ["Dead bug", 2, 10], ["Side plank", 2, 0, { dur: 20 }], ["Leg raises", 2, 10], ["Cat-cow", 1, 0, { dur: 60 }], ["Stretching", 1, 0, { dur: 180 }]),
    ],
  },
];

/** A session's exercise line from a template line, for week `w` (1-based). */
function lineOf([name, sets, reps, extra = {}], w, weekly = {}) {
  const k = w - 1;
  return {
    id: uuid(), ex: name, sets: sets || 1,
    reps: reps ? reps + (weekly.reps || 0) * k : 0,
    w: 0, unit: "kg",
    dur: extra.dur ? extra.dur + (weekly.dur || 0) * k : 0,
    dist: extra.dist ? Math.round((extra.dist + (weekly.dist || 0) * k) * 10) / 10 : 0,
  };
}

/** A template unfolded into a program: `weeks` × `perWeek` sessions, cycling through its days (so two days at three a week go A B A, B A B…). */
export function buildProgram(tpl, { now = new Date() } = {}) {
  const sessions = [];
  let turn = 0;
  for (let w = 1; w <= (tpl.weeks || 1); w++) {
    for (let d = 0; d < (tpl.perWeek || tpl.days.length); d++) {
      const day = tpl.days[turn++ % tpl.days.length];
      sessions.push({ id: uuid(), name: day.name, note: "", done: null, exercises: day.lines.map((l) => lineOf(l, w, tpl.weekly)) });
    }
  }
  return { id: uuid(), name: tpl.name, tpl: tpl.id, note: tpl.blurb || "", perWeek: tpl.perWeek || tpl.days.length, created: now.toISOString().slice(0, 10), sessions };
}

/** An empty program to fill by hand. */
export const blankProgram = (name = "My program") => ({ id: uuid(), name, tpl: "", note: "", perWeek: 3, created: new Date().toISOString().slice(0, 10), sessions: [] });
export const blankSession = (name = "Session") => ({ id: uuid(), name, note: "", done: null, exercises: [] });
export const blankLine = (ex = "") => ({ id: uuid(), ex, sets: 3, reps: 10, w: 0, unit: "kg", dur: 0, dist: 0 });

// ── progress ──
/** How much of a session the day's logged sets cover: rows with done/target, and the whole. */
export function sessionProgress(session, setsOnDay) {
  const rows = (session.exercises || []).map((e) => {
    const logged = setsOnDay.filter((s) => keyOf(s.ex) === keyOf(e.ex)).length;
    const target = Math.max(1, e.sets || 1);
    return { e, logged, target, done: Math.min(logged, target) };
  });
  const total = rows.reduce((a, r) => a + r.target, 0);
  const done = rows.reduce((a, r) => a + r.done, 0);
  return { rows, total, done, pct: total ? Math.round((done / total) * 100) : 0, complete: total > 0 && done >= total };
}

/** Sessions done against all, and the next one to do. */
export function programProgress(p) {
  const n = (p.sessions || []).length;
  const done = (p.sessions || []).filter((s) => s.done).length;
  return { n, done, pct: n ? Math.round((done / n) * 100) : 0, next: (p.sessions || []).find((s) => !s.done) || null };
}

/** "3 × 8 @ 60 kg", "3 × 30 s", "5 km" - a planned line in words. */
export function lineLabel(e) {
  const sets = Math.max(1, e.sets || 1);
  if (e.dist) return `${e.dist} km${e.dur ? ` in ${Math.round(e.dur / 60)} min` : ""}`;
  if (e.dur && !e.reps) return `${sets} × ${e.dur} s`;
  return `${sets} × ${e.reps || 0}${e.w ? ` @ ${e.w} ${e.unit || "kg"}` : ""}`;
}
