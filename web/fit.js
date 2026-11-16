// Workout, food and fasting: the pure parts. A line typed (or said) becomes
// a set, a meal or nothing; the day's entries become totals and records.
// No DOM, no clock reads except where a caller omits `now`.
//
// The file (fit.json) is one object:
//   sets:  [{ id, t, ex, reps, sets?, w, unit, dist, dunit, dur }]   dur in seconds
//   food:  [{ id, t, text, kcal, prot }]
//   fasts: [{ id, start, end|null }]
//   ex:    { key: { name, last } }      exercises seen, with the last set of each
//   foods: { key: { text, kcal, prot } } foods seen, so "banana" knows its calories again
// Times are local-naive ISO like everything else in Leonote.

/** A name as a key: lower-case letters and digits only, so "Push-ups", "push ups" and "pushup" meet. */
export const keyOf = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").replace(/s$/u, "");

// the usual names, so the log reads the same however they were typed
const ALIASES = {
  pushup: "Push-ups", pressup: "Push-ups", pullup: "Pull-ups", chinup: "Chin-ups", situp: "Sit-ups", squat: "Squats", airsquat: "Squats",
  bench: "Bench press", benchpress: "Bench press", deadlift: "Deadlift", ohp: "Overhead press", overheadpress: "Overhead press", shoulderpress: "Overhead press",
  row: "Rows", barbellrow: "Rows", curl: "Curls", bicepcurl: "Curls", bicepscurl: "Curls", dip: "Dips", lunge: "Lunges", plank: "Plank", burpee: "Burpees",
  crunch: "Crunches", latpulldown: "Lat pulldown", pulldown: "Lat pulldown", legpress: "Leg press", legcurl: "Leg curl", legextension: "Leg extension",
  run: "Run", running: "Run", jog: "Run", jogging: "Run", walk: "Walk", walking: "Walk", bike: "Cycling", cycling: "Cycling", cycle: "Cycling", swim: "Swim", swimming: "Swim",
  jumprope: "Jump rope", skipping: "Jump rope", hiphinge: "Hip hinge", hipthrust: "Hip thrust", calfraise: "Calf raises", legraise: "Leg raises",
};
const FILLER = new Set(["of", "at", "with", "for", "and", "x", "×", "reps", "rep", "set", "sets", "did", "done", "a", "the", "my", "i", "on", "kg", "kgs", "kilo", "kilos", "lb", "lbs"]);
const WEIGHT = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|kilos?|kilograms?|lbs?|pounds?)\b/i;
const DIST = /(\d+(?:[.,]\d+)?)\s*(km|kms|k|kilomet(?:er|re)s?|mi|miles?|m|met(?:er|re)s?)\b/i;
const DUR = /(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?|min|mins|minutes?|s|secs?|seconds?)\b/i;
const CLOCK = /\b(\d{1,2}):(\d{2})\b/;
const SETSX = /\b(\d+)\s*[x×]\s*(\d+)\b/i;
const num = (s) => parseFloat(String(s).replace(",", "."));

// spoken numbers arrive as words now and then ("ten push-ups"); the small ones are turned into digits
const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export function wordsToDigits(s) {
  return String(s).replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-]+(one|two|three|four|five|six|seven|eight|nine))?\b|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|hundred)\b/gi,
    (m, tens, ones, small) => tens ? String(TENS[tens.toLowerCase()] + (ones ? SMALL[ones.toLowerCase()] : 0)) : small.toLowerCase() === "hundred" ? "100" : String(SMALL[small.toLowerCase()]));
}

/** The display name for an exercise typed as `raw`: an alias, a name already known, or the words as typed. */
export function exerciseName(raw, known = {}) {
  const k = keyOf(raw);
  if (!k) return "";
  if (ALIASES[k]) return ALIASES[k];
  if (known[k] && known[k].name) return known[k].name;
  const words = String(raw).trim().replace(/\s+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * "10 pushups", "3x10 push ups", "10 bench 50 kg", "bench 60kg x 5",
 * "run 5 km 28 min", "plank 60 s" -> { ex, reps, sets, w, unit, dist, dunit, dur } or null.
 * A bare number is reps; "3x10" is sets × reps; the words left are the exercise.
 */
export function parseSet(input, known = {}, unit = "kg") {
  let s = " " + wordsToDigits(String(input || "").trim()) + " ";
  if (!s.trim()) return null;
  const out = { ex: "", reps: 0, sets: 1, w: 0, unit: unit === "lb" ? "lb" : "kg", dist: 0, dunit: "km", dur: 0 };
  let m;
  if ((m = SETSX.exec(s))) { out.sets = Math.max(1, parseInt(m[1], 10)); out.reps = parseInt(m[2], 10); s = s.replace(m[0], " "); }
  if ((m = WEIGHT.exec(s))) { out.w = num(m[1]); out.unit = /^(lb|pound)/i.test(m[2]) ? "lb" : "kg"; s = s.replace(m[0], " "); }
  if ((m = CLOCK.exec(s))) { out.dur = parseInt(m[1], 10) * 60 + parseInt(m[2], 10); s = s.replace(m[0], " "); }
  else if ((m = DUR.exec(s))) { const u = m[2].toLowerCase(); out.dur = Math.round(num(m[1]) * (u.startsWith("h") ? 3600 : u.startsWith("m") ? 60 : 1)); s = s.replace(m[0], " "); }
  if ((m = DIST.exec(s))) { const u = m[2].toLowerCase(); out.dist = num(m[1]); out.dunit = u.startsWith("mi") ? "mi" : u.startsWith("k") ? "km" : "m"; s = s.replace(m[0], " "); }
  if (!out.reps && (m = /(?:^|\s)(\d+)(?:\s*reps?)?(?=\s)/.exec(s))) { out.reps = parseInt(m[1], 10); s = s.replace(m[0], " "); }
  const words = s.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((w) => w && !FILLER.has(w.toLowerCase()) && !/^\d+([.,]\d+)?$/.test(w));
  out.ex = exerciseName(words.join(" "), known);
  if (!out.ex) return null;
  if (!out.reps && !out.w && !out.dist && !out.dur) out.reps = 1; // "plank" alone still counts as one
  return out;
}

/**
 * A whole sentence of what was done - said or typed: "I did ten push-ups, twenty squats and a 5 km run".
 * Split at commas, full stops (not decimal points), ";" and an "and" / "then" that comes before a number;
 * each piece is a set. When the pieces do not each make a set, the sentence is read as one (so "clean and
 * jerk 60 kg" stays one exercise). Returns the sets, possibly none.
 */
export function parseSets(input, known = {}, unit = "kg") {
  const s = wordsToDigits(String(input || ""));
  const parts = s.split(/\s*(?:[,;]|\.(?!\d)|\b(?:and|then|and then|plus)\b(?=\s+(?:a\s+|an\s+)?\d))\s*/i).map((x) => x.trim()).filter(Boolean);
  // the pieces with a number of their own are the sets (one without, like "that's it", is left out)
  const counted = parts.filter((p) => /\d/.test(p)).map((p) => parseSet(p, known, unit));
  if (parts.length > 1 && counted.length && counted.every(Boolean)) return counted;
  const one = parseSet(s, known, unit);
  return one ? [one] : [];
}

/** "2 eggs 150 kcal 12g protein", "banana", "coffee 5 cal" -> { text, kcal, prot } or null. A known food fills what was left out. */
export function parseFood(input, known = {}) {
  let s = " " + String(input || "").trim() + " ";
  if (!s.trim()) return null;
  const out = { text: "", kcal: 0, prot: 0 };
  let m;
  if ((m = /(\d+(?:[.,]\d+)?)\s*(kcal|cal|cals|calories|kalor\w*)\b/i.exec(s))) { out.kcal = Math.round(num(m[1])); s = s.replace(m[0], " "); }
  if ((m = /(\d+(?:[.,]\d+)?)\s*g?\s*(?:of\s+)?(protein|prot|pro)\b/i.exec(s))) { out.prot = Math.round(num(m[1])); s = s.replace(m[0], " "); }
  out.text = s.replace(/\s+/g, " ").trim().replace(/^[,\-–]+|[,\-–]+$/g, "").trim();
  if (!out.text) return null;
  const k = known[keyOf(out.text)];
  if (k) { if (!out.kcal) out.kcal = k.kcal || 0; if (!out.prot) out.prot = k.prot || 0; out.text = k.text || out.text; }
  return out;
}

// ── sums ──
const dayOf = (t) => String(t || "").slice(0, 10);
export const onDay = (list, day) => (list || []).filter((e) => dayOf(e.t) === day);

/** A set's work: reps × weight (bodyweight counts as reps only). */
export const volume = (s) => (s.w ? s.reps * s.w : 0);

/** The day's sets by exercise, in the order first done: [{ name, sets: [...], reps, volume, dist, dur }]. */
export function groupSets(sets) {
  const by = new Map();
  for (const s of sets) {
    const k = keyOf(s.ex);
    if (!by.has(k)) by.set(k, { key: k, name: s.ex, sets: [], reps: 0, volume: 0, dist: 0, dur: 0, unit: s.unit || "kg" });
    const g = by.get(k);
    g.sets.push(s);
    g.reps += s.reps || 0;
    g.volume += volume(s);
    g.dist += s.dist || 0;
    g.dur += s.dur || 0;
  }
  return [...by.values()];
}

/** The best of an exercise over all sets: heaviest set, most reps, and the day with the most work. */
export function records(sets, key) {
  const mine = sets.filter((s) => keyOf(s.ex) === key);
  if (!mine.length) return null;
  const out = { maxW: 0, maxWReps: 0, maxReps: 0, bestDay: "", bestDayVolume: 0, bestDayReps: 0, count: mine.length, maxDist: 0, maxDur: 0 };
  const days = new Map();
  for (const s of mine) {
    if (s.w > out.maxW || (s.w === out.maxW && s.w && s.reps > out.maxWReps)) { out.maxW = s.w; out.maxWReps = s.reps; }
    if (s.reps > out.maxReps) out.maxReps = s.reps;
    if (s.dist > out.maxDist) out.maxDist = s.dist;
    if (s.dur > out.maxDur) out.maxDur = s.dur;
    const d = dayOf(s.t);
    const v = days.get(d) || { volume: 0, reps: 0 };
    v.volume += volume(s); v.reps += s.reps || 0;
    days.set(d, v);
  }
  for (const [d, v] of days) if (v.volume > out.bestDayVolume || (!out.bestDayVolume && v.reps > out.bestDayReps)) { out.bestDay = d; out.bestDayVolume = v.volume; out.bestDayReps = v.reps; }
  return out;
}

/** Days from `from` to `to` (inclusive) with anything on them: [{ day, sets, reps, volume }]. */
export function daySummaries(sets, from, to) {
  const by = new Map();
  for (const s of sets) {
    const d = dayOf(s.t);
    if (d < from || d > to) continue;
    const v = by.get(d) || { day: d, sets: 0, reps: 0, volume: 0, exercises: new Set() };
    v.sets++; v.reps += s.reps || 0; v.volume += volume(s); v.exercises.add(s.ex);
    by.set(d, v);
  }
  return [...by.values()].sort((a, b) => b.day.localeCompare(a.day)).map((v) => ({ ...v, exercises: [...v.exercises] }));
}

/** The day's food added up. */
export function foodTotals(entries) {
  return entries.reduce((a, e) => ({ kcal: a.kcal + (e.kcal || 0), prot: a.prot + (e.prot || 0), n: a.n + 1 }), { kcal: 0, prot: 0, n: 0 });
}

// ── fasting ──
const ms = (iso) => new Date(iso).getTime();
/** Hours a fast lasted, or has lasted so far (`now` for an open one). */
export const fastHours = (f, now = Date.now()) => Math.max(0, ((f.end ? ms(f.end) : now) - ms(f.start)) / 3600000);
export const openFast = (fasts) => (fasts || []).find((f) => f.start && !f.end) || null;

/** Finished fasts: how many, the average and the longest, and the run of days ending today with a fast at least `goal` hours long. */
export function fastStats(fasts, goal, today) {
  const done = (fasts || []).filter((f) => f.start && f.end);
  const hours = done.map((f) => fastHours(f));
  const out = { n: done.length, avg: hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : 0, longest: hours.length ? Math.max(...hours) : 0, streak: 0 };
  const days = new Set(done.filter((f) => fastHours(f) >= goal).map((f) => dayOf(f.end)));
  let d = today;
  if (!days.has(d)) d = shift(d, -1); // today's may still be running
  while (days.has(d)) { out.streak++; d = shift(d, -1); }
  return out;
}
function shift(day, n) {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "1h 05m", "45 s", "2:30:00" style: seconds as people read them. */
export function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return s ? `${m}m ${String(s).padStart(2, "0")}s` : `${m} min`;
}
export const fmtHours = (hrs) => { const h = Math.floor(hrs), m = Math.round((hrs - h) * 60); return m === 60 ? `${h + 1}h 00m` : `${h}h ${String(m).padStart(2, "0")}m`; };
