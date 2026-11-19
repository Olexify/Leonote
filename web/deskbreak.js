// Breaks that move you: when the Timer's work block ends, the break names something to do - an exercise that fits
// the equipment you said you have, something for the eyes, a glass of water. Each is a tick box. "I tick" waits for
// you (and the numbers can be changed: planned 10, did 5); "Count it for me" ticks them on trust, and any can be
// unticked later. The log is `breaks` in fit.json; a ticked exercise is also a set in the Workout log, with the same id.
// Nothing runs between breaks: the Timer calls start() when a break begins.

import { h, uuid, localIso, dayKey } from "./util.js";
import { icon } from "./icons.js";
import { cornerCard, askDialog, menu } from "./ui.js";
import { XP } from "./stats.js";
import { keyOf, onDay, parseSet } from "./fit.js";
import { exerciseInfo } from "./fitprograms.js";

export const EQUIPMENT = [["mat", "Mat or floor space"], ["dumbbells", "Dumbbells"], ["bar", "Pull-up bar"], ["band", "Resistance band"], ["kettlebell", "Kettlebell"], ["barbell", "Barbell and bench"], ["bench", "Bench"]];
const M = (ex, need, reps, dur = 0) => ({ ex, need, reps, dur });
/** Short things for a break, in an order that changes the body part each time. need: "" = nothing at all. */
export const MOVES = [
  M("Push-ups", "", 10), M("Squats", "", 15), M("Dumbbell row", "dumbbells", 10), M("Plank", "mat", 0, 30), M("Pull-ups", "bar", 5),
  M("Lunges", "", 10), M("Overhead press", "dumbbells", 10), M("Glute bridge", "mat", 15), M("Face pulls", "band", 15), M("Calf raises", "", 20),
  M("Curls", "dumbbells", 10), M("Dead bug", "mat", 10), M("Bench press", "barbell", 10), M("Jumping jacks", "", 20), M("Goblet squat", "kettlebell", 10),
  M("Stretching", "", 0, 30), M("Hanging leg raise", "bar", 8), M("Rows", "band", 12), M("Deadlift", "barbell", 5), M("Lateral raises", "dumbbells", 12), M("Cat-cow", "mat", 0, 30),
];
/** Ready-made sets: the equipment they need and only their own exercises, taking turns. Your own exercises join any of them. */
export const PRESETS = [
  { id: "oleks", name: "Oleks", title: "Oleks's own: bodyweight, a band, a bench and dumbbells", have: ["mat", "band", "bench", "dumbbells"], moves: [
    M("Push-ups", "", 15), M("Burpees", "", 10), M("Hyperextension", "bench", 12), M("Curls", "dumbbells", 12), M("Push press", "dumbbells", 10),
    M("Band pull-aparts", "band", 15), M("Squats", "", 20), M("Band rows", "band", 12), M("Dumbbell lunges", "dumbbells", 10), M("Plank", "mat", 0, 40),
    M("Band face pulls", "band", 15), M("Dumbbell row", "dumbbells", 10), M("Glute bridge", "mat", 15), M("Mountain climbers", "", 20)] },
  { id: "home", name: "Nothing needed", title: "Bodyweight only, anywhere", have: [], moves: [
    M("Push-ups", "", 12), M("Squats", "", 20), M("Burpees", "", 8), M("Lunges", "", 10), M("Mountain climbers", "", 20), M("Wall sit", "", 0, 30),
    M("Superman", "", 12), M("Jumping jacks", "", 25), M("Calf raises", "", 20), M("Plank", "", 0, 30), M("Pike push-ups", "", 8), M("High knees", "", 0, 30)] },
  { id: "band", name: "Band", title: "A resistance band", have: ["band"], moves: [
    M("Band pull-aparts", "band", 15), M("Band rows", "band", 12), M("Band chest press", "band", 12), M("Band squats", "band", 15), M("Band face pulls", "band", 15),
    M("Band curls", "band", 12), M("Band overhead press", "band", 10), M("Band good mornings", "band", 12)] },
  { id: "dumbbells", name: "Dumbbells", title: "A pair of dumbbells", have: ["dumbbells"], moves: [
    M("Curls", "dumbbells", 12), M("Push press", "dumbbells", 10), M("Dumbbell row", "dumbbells", 10), M("Goblet squat", "dumbbells", 12), M("Romanian deadlift", "dumbbells", 10),
    M("Lateral raises", "dumbbells", 12), M("Dumbbell lunges", "dumbbells", 10), M("Hammer curls", "dumbbells", 12)] },
  { id: "office", name: "At the desk", title: "Quiet, no sweat, in work clothes", have: [], moves: [
    M("Chair squats", "", 12), M("Desk push-ups", "", 12), M("Calf raises", "", 20), M("Shoulder rolls", "", 15), M("Neck stretch", "", 0, 30),
    M("Standing hip stretch", "", 0, 30), M("Wall angels", "", 10), M("Seated twist", "", 0, 30)] },
];
export const EYES = [
  { name: "Look out of the window", dur: 30, cue: "Something far away, for 30 seconds." },
  { name: "Near and far", reps: 10, dur: 40, cue: "A thumb at arm's length, then something far - 10 times, slowly." },
  { name: "Slow blinks, then palms over closed eyes", dur: 20, cue: "10 slow blinks, then 20 seconds of dark." },
];

/** The exercise for this break: of those the equipment allows, the one done longest ago (never done first), with the numbers of last time. */
/** `defs`: the numbers you made an exercise's default (by keyOf of its name) - they win over last time's. */
export function pickMove(have, sets = [], skip = [], own = [], base = MOVES, defs = {}, offered = []) {
  const last = new Map();
  for (const s of sets) { const k = keyOf(s.ex); if (!last.has(k) || String(s.t) >= String(last.get(k).t)) last.set(k, s); }
  // offered in a break but not ticked counts as seen too: a skipped one does not come straight back
  const seen = new Map();
  for (const o of offered) { const k = keyOf(o.name); if (String(o.t) > String(seen.get(k) || "")) seen.set(k, String(o.t)); }
  const pool = [...own, ...base].filter((m) => (!m.need || have.includes(m.need)) && !skip.includes(m.ex));
  if (!pool.length) return null;
  const at = (m) => { const l = last.get(keyOf(m.ex)); const a = l ? String(l.t) : "", b = seen.get(keyOf(m.ex)) || ""; return a > b ? a : b; };
  const m = pool.reduce((a, b) => (at(b) < at(a) ? b : a));
  const l = (defs && defs[keyOf(m.ex)]) || last.get(keyOf(m.ex));
  return { name: m.ex, reps: l && l.reps ? l.reps : m.reps || 0, dur: l && l.dur ? l.dur : m.dur || 0, w: l && l.w ? l.w : m.w || 0, unit: (l && l.unit) || m.unit || "kg" };
}

/** The part of the day a time is in, for habits that come up in breaks: before noon, noon to 5 pm, after. */
export const dayPart = (t) => { const hr = Number(String(t).slice(11, 13)); return hr < 12 ? "start" : hr < 17 ? "middle" : "end"; };

/** What one break asks for. kinds: of "move", "eyes", "water". `habits`: those set to come up in breaks
 *  ({ id, name, inBreaks }), less the ones done today - one of them, at random, comes with the exercise. */
export function planBreak({ kinds, have, own, base, defs, habits = [], rnd = Math.random }, data, t) {
  const today = onDay(data.breaks, String(t).slice(0, 10));
  const out = [];
  const mv = kinds.includes("move") ? pickMove(have, data.sets, [], own, base, defs, data.breaks.filter((b) => b.kind === "move")) : null;
  if (mv) out.push({ id: uuid(), t, kind: "move", ...mv, done: false });
  // a habit for this part of the day that has not come up in the last hour
  if (kinds.includes("move")) {
    const lately = (id) => today.some((b) => b.kind === "habit" && b.habit === id && Date.parse(t) - Date.parse(b.t) < 60 * 60000);
    const pool = habits.filter((hb) => (hb.inBreaks === "any" || hb.inBreaks === dayPart(t)) && !lately(hb.id));
    if (pool.length) { const hb = pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))]; out.push({ id: uuid(), t, kind: "habit", habit: hb.id, name: hb.name, done: false }); }
  }
  if (kinds.includes("eyes")) { const e = EYES[today.filter((b) => b.kind === "eyes").length % EYES.length]; out.push({ id: uuid(), t, kind: "eyes", name: e.name, reps: e.reps || 0, dur: e.dur || 0, done: false }); }
  // water at most once an hour
  const lastWater = today.filter((b) => b.kind === "water").map((b) => String(b.t)).sort().pop();
  const fresh = lastWater && Date.parse(t) - Date.parse(lastWater) < 60 * 60000;
  if (kinds.includes("water") && !fresh) out.push({ id: uuid(), t, kind: "water", name: "A glass of water", done: false });
  return out;
}

/** fit.json as this module needs it. */
export function shape(d) {
  d = d && typeof d === "object" ? d : {};
  for (const k of ["sets", "breaks"]) if (!Array.isArray(d[k])) d[k] = [];
  if (!d.ex || typeof d.ex !== "object") d.ex = {};
  return d;
}
const asSet = (b) => ({ id: b.id, t: b.t, ex: b.name, reps: b.reps || 0, w: b.w || 0, unit: b.unit || "kg", dur: b.dur || 0, src: "break" });
/** Tick or untick one: a ticked exercise is a set in the Workout log, an unticked one is not. */
export function setDone(d, id, done) {
  const b = d.breaks.find((x) => x.id === id);
  if (!b) return;
  b.done = !!done;
  if (b.kind !== "move") return;
  d.sets = d.sets.filter((s) => s.id !== id);
  const k = keyOf(b.name);
  if (done) { d.sets.push(asSet(b)); d.ex[k] = { name: b.name, last: { reps: b.reps, w: b.w, unit: b.unit, dur: b.dur }, n: ((d.ex[k] || {}).n || 0) + 1, at: b.t }; }
  else if (d.ex[k] && d.ex[k].n > 0) d.ex[k].n--;
}
/** Glasses of water ticked on a day (YYYY-MM-DD). */
export const glassesOn = (d, day) => onDay(d.breaks, day).filter((b) => b.kind === "water" && b.done).length;

/** One taken off the log (and its set off the Workout log). */
export function removeBreak(d, id) {
  d.breaks = d.breaks.filter((b) => b.id !== id);
  d.sets = d.sets.filter((s) => s.id !== id);
}
/** XP for an entry ticked for the first time (ticking it again gives nothing): an exercise as a workout set, eyes and water 1. */
export function xpFor(d, id, set) {
  const b = d.breaks.find((x) => x.id === id);
  if (!b || !b.done || b.xp) return 0;
  b.xp = true;
  return b.kind === "move" ? set : b.kind === "habit" ? 0 : 1; // a habit earns its own XP when it is ticked
}
/** A line typed for an exercise of one's own: "kettlebell halo 10", "wall sit 30 sec", "farmer walk 20 kg 40 sec". */
export function ownMove(line, unit) {
  const p = parseSet(line, {}, unit);
  return p ? { ex: p.ex, need: "", reps: p.dur ? 0 : p.reps, dur: p.dur, w: p.w, unit: p.unit } : null;
}
/** What was really done: planned 10, did 5. */
export function setNumbers(d, id, patch) {
  const b = d.breaks.find((x) => x.id === id);
  if (!b) return;
  for (const k of ["reps", "w", "dur"]) if (k in patch) b[k] = Math.max(0, Number(patch[k]) || 0);
  if (b.done) setDone(d, id, true);
}
/** Another exercise instead of this one (not done yet). */
export function swapMove(d, id, have, own, base, defs) {
  const b = d.breaks.find((x) => x.id === id);
  if (!b || b.done || b.kind !== "move") return;
  const today = onDay(d.breaks, String(b.t).slice(0, 10)).filter((x) => x.kind === "move").map((x) => x.name);
  const m = pickMove(have, d.sets, today, own, base, defs) || pickMove(have, d.sets, [b.name], own, base, defs);
  if (m) Object.assign(b, m);
}

export function mountDeskBreaks(app) {
  const S = app.settings;
  const kinds = () => (Array.isArray(S.deskBreakKinds) ? S.deskBreakKinds : ["move", "eyes", "water"]);
  const have = () => (Array.isArray(S.deskEquipment) ? S.deskEquipment : []);
  const mine = () => (Array.isArray(S.deskMoves) ? S.deskMoves.filter((m) => m && m.ex) : []);
  // a preset: its exercises only, plus your own; none: the built-in list plus your own
  const preset = () => PRESETS.find((p) => p.id === S.deskPreset) || null;
  const own = () => [...mine(), ...((preset() || {}).moves || [])];
  const base = () => (preset() ? [] : MOVES);
  const defs = () => (S.deskDefaults && typeof S.deskDefaults === "object" ? S.deskDefaults : {});
  // right-click an exercise: its numbers become its default, or it gets a weight
  function moveMenu(e, b) {
    e.preventDefault();
    const k = keyOf(b.name), has = defs()[k];
    const what = `${b.reps ? b.reps + " ×" : ""}${b.dur ? " " + b.dur + " s" : ""}${b.w ? " " + b.w + " " + (b.unit || "kg") : ""}`.trim();
    menu(e.clientX, e.clientY, [
      { label: `Make ${what || "these numbers"} its default`, icon: "check", run: () => { app.setSetting("deskDefaults", { ...defs(), [k]: { reps: b.reps || 0, dur: b.dur || 0, w: b.w || 0, unit: b.unit || "kg" } }); app.toast(`${b.name}: ${what} from now on`, { ms: 2200 }); } },
      !b.w ? { label: "Add a weight", icon: "plus", run: () => change((d) => setNumbers(d, b.id, { w: 10 })) } : { label: "No weight", icon: "x", run: () => change((d) => setNumbers(d, b.id, { w: 0 })) },
      has ? { label: "Back to last time's numbers", icon: "undo", run: () => { const n = { ...defs() }; delete n[k]; app.setSetting("deskDefaults", n); } } : null,
    ]);
  }
  const reward = (d, ids) => {
    const n = ids.reduce((k, id) => k + xpFor(d, id, XP.workoutSet), 0);
    if (n) app.stats.award(n);
    // a habit ticked (or unticked) in a break is ticked on the Habits page too, for today
    for (const id of ids) {
      const b = d.breaks.find((x) => x.id === id);
      if (!b || b.kind !== "habit" || !app.toggleHabit) continue;
      const day = String(b.t).slice(0, 10), on = ((app.habits && app.habits.log && app.habits.log[day]) || []).includes(b.habit);
      if (on !== !!b.done) app.toggleHabit(b.habit, day);
    }
  };
  let data = null;
  const lists = new Set(); // every drawn list of tick boxes: { el, ids() }
  const paint = () => { popSend(); for (const l of lists) { if (l.temp && !l.el.isConnected && l.seen) lists.delete(l); else { l.seen = l.seen || l.el.isConnected; l.draw(); } } };
  /* Leonote out of sight (minimized, in the tray): the break shows on the desktop too, in a small window at the top
     right (breakpop.html) - Settings: "On the desktop when Leonote is hidden". A tick there is a tick here. */
  let pop = null; // { ids, title, timer }
  const popItems = () => (pop && data ? data.breaks.filter((b) => pop.ids.includes(b.id)).map((b) => ({ id: b.id, kind: b.kind, name: b.name, done: !!b.done, sub: b.reps ? `× ${b.reps}${b.w ? " · " + b.w + " " + (b.unit || "kg") : ""}` : b.dur ? `${b.dur} s` : "" })) : []);
  function popSend() {
    if (!pop || !app.host.emitTo) return;
    const items = popItems();
    app.host.emitTo("breakpop", "breakpop:show", { title: pop.title, items, endAt: S.deskPopStay === true ? 0 : pop.endAt, look: { theme: document.documentElement.dataset.theme, style: document.documentElement.getAttribute("style") || "" }, prefs: { voice: S.deskVoice !== false, stay: S.deskPopStay === true, pop: S.deskPopOut !== false } }).catch(() => {});
    // all of it ticked: it goes by itself, a moment later
    if (pop.ticked && items.length && items.every((x) => x.done)) { clearTimeout(pop.timer); pop.timer = setTimeout(popClose, 1500); }
  }
  function popClose() { if (!pop) return; clearTimeout(pop.timer); pop = null; app.host.breakPop(false).catch(() => {}); }
  async function popOut(ids, title, ms) {
    if (S.deskPopOut === false || !app.host.breakPop || !app.host.win) return;
    const unseen = await Promise.all([app.host.win.isVisible(), app.host.win.isMinimized()]).then(([v, m]) => !v || m).catch(() => false);
    if (!unseen) return;
    if (pop) clearTimeout(pop.timer);
    // "stays until closed": no clock on it
    const stay = S.deskPopStay === true;
    pop = { ids, title, endAt: Date.now() + ms, timer: stay ? 0 : setTimeout(popClose, ms) };
    app.host.breakPop(true).then(popSend).catch(() => { pop = null; });
  }
  // Leonote back in sight: the break is on its own card there, the desktop one goes
  if (typeof window !== "undefined") window.addEventListener("focus", () => { if (pop) popClose(); });
  if (app.host.on) app.host.on("breakpop:cmd", (p) => {
    const c = p && p.cmd;
    if (c === "hello") popSend();
    else if (c === "tick" && pop && pop.ids.includes(p.id)) { pop.ticked = true; if (p.done) app.sound("done"); change((d) => { setDone(d, p.id, !!p.done); reward(d, [p.id]); }); }
    // closed by hand: its voice stops at once, and its timer with it (as the in-app card does)
    else if (c === "closed") { if (pop) { clearTimeout(pop.timer); if (timer && pop.ids.includes(timer.id)) stopTimer(); } pop = null; hush(); }
    // the card's own settings, changed on the card (its gear): applied at once, here as on the Timer page
    else if (c === "set" && pop) {
      const v = !!p.value;
      if (p.key === "voice") { app.setSetting("deskVoice", v); if (!v) hush(); }
      else if (p.key === "stay") { app.setSetting("deskPopStay", v); clearTimeout(pop.timer); if (!v && pop.endAt < Date.now() + 15000) pop.endAt = Date.now() + 60000; pop.timer = v ? 0 : setTimeout(popClose, pop.endAt - Date.now()); } // its time again: at least a minute
      else if (p.key === "pop") app.setSetting("deskPopOut", v);
      popSend();
    }
    else if (c === "settings") { popClose(); app.host.win.show().catch(() => {}); if (app.host.win.unminimize) app.host.win.unminimize().catch(() => {}); app.openView("timer"); setTimeout(() => { const el = document.querySelector(".db-panel"); if (el) el.scrollIntoView({ block: "start", behavior: "smooth" }); }, 300); }
    else if (c === "open") { popClose(); app.host.win.show().catch(() => {}); if (app.host.win.unminimize) app.host.win.unminimize().catch(() => {}); app.openView("timer"); }
  });
  const load = async () => (data = shape(await app.host.fitLoad().catch(() => ({}))));
  // read, change, write: the Workout view holds its own copy and takes the new one from the "fit" message
  async function change(fn) {
    const d = await load();
    fn(d);
    try { await app.host.fitSave(d); } catch (e) { app.toast("Could not save the break log: " + e, { kind: "error" }); }
    app.bus.emit("fit", d);
    paint();
  }
  app.bus.on("fit", (d) => { if (d !== data) { data = null; paint(); } });

  const num = (b, key, unit) => h("label", { class: "db-num" },
    h("input", { type: "number", min: "0", value: String(b[key] || 0), "aria-label": `${b.name}: ${{ reps: "reps", w: "weight", dur: "seconds" }[key]}`, onchange: (e) => change((d) => setNumbers(d, b.id, { [key]: e.target.value })) }), unit);
  // Spoken, when "Say it out loud" is on: short lines recorded once (web/voice/<the words>.ogg), one after another;
  // a line with no recording stays silent
  const voiceOn = () => S.deskVoice !== false;
  let sayQueue = Promise.resolve(), saying = null, sayGen = 0;
  // stopped at once (the card closed, the voice turned off): what is playing and everything waiting
  const hush = () => { sayGen++; if (saying) { try { saying.pause(); } catch {} saying = null; } sayQueue = Promise.resolve(); };
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const say = (...lines) => { if (!voiceOn()) return; const gen = sayGen; for (const t of lines) sayQueue = sayQueue.then(() => new Promise((done) => {
    if (gen !== sayGen) return done();
    let late = 0;
    const end = () => { clearTimeout(late); saying = null; done(); };
    // a short breath after each line, so two names do not run together
    try { const a = new Audio(`voice/${slug(t)}.ogg`); saying = a; a.volume = 0.9; a.onended = () => { clearTimeout(late); setTimeout(end, 450); }; a.onerror = end; a.play().catch(end); late = setTimeout(end, 8000); } catch { end(); }
  })); };
  // one timed entry at a time: its seconds count down on its row, a tick each second, and it is ticked when they run out
  let timer = null; // { id, left, iv }
  const tickSound = () => { try { const a = new Audio(`sounds/clockticksound${1 + Math.floor(Math.random() * 16)}.wav`); a.volume = Math.min(1, Math.max(0, Number(app.stats.data.pomo_tick_volume) || 0.3)); a.play().catch(() => {}); } catch {} };
  function stopTimer() { if (timer) { clearInterval(timer.iv); timer = null; paint(); } }
  // a timed one counts down; one counted in reps (burpees) counts up while you do them, and stopping it ticks it off
  function runTimer(b) {
    if (timer && timer.id === b.id) {
      const up = timer.up, id = timer.id;
      stopTimer();
      if (up) { app.sound("done"); say("Well done."); change((d) => { setDone(d, id, true); reward(d, [id]); }); }
      return;
    }
    stopTimer();
    timer = { id: b.id, left: b.dur || 0, up: !b.dur, iv: 0 };
    const gen0 = sayGen; // hushed (the card closed, the voice off): the count is quiet too
    timer.iv = setInterval(() => {
      if (!timer) return;
      // only the seconds change each second: the lists are not redrawn (focus, tooltips and screen readers stay)
      const show = () => { for (const el of document.querySelectorAll(".db-left")) el.textContent = `${timer.left} s`; };
      if (timer.up) { timer.left++; tickSound(); show(); return; }
      timer.left--;
      // the last three seconds, one word each, on the second itself (not queued: a queued line waits its breath)
      if (timer.left >= 1 && timer.left <= 3 && voiceOn() && gen0 === sayGen) { try { const a = new Audio(`voice/${["", "one", "two", "three"][timer.left]}.ogg`); a.volume = 0.9; a.play().catch(() => {}); } catch {} }
      if (timer.left > 0) { if (timer.left > 3 || !voiceOn()) tickSound(); show(); return; }
      const id = timer.id;
      clearInterval(timer.iv); timer = null;
      app.sound("done");
      say("Time is up.");
      change((d) => { setDone(d, id, true); reward(d, [id]); });
    }, 1000);
    tickSound();
    paint();
  }
  function row(b) {
    const info = b.kind === "move" ? exerciseInfo(b.name) : null;
    const timing = timer && timer.id === b.id;
    const cue = b.kind === "eyes" ? (EYES.find((e) => e.name === b.name) || {}).cue : info && info.cue;
    return h("div", { class: "db-row" + (b.done ? " is-done" : ""), title: cue ? cue + (b.kind === "move" ? " · right-click: make it the default, add a weight" : "") : b.kind === "move" ? "Right-click: make it the default, add a weight" : "", oncontextmenu: b.kind === "move" ? (e) => moveMenu(e, b) : null },
      h("input", { type: "checkbox", checked: !!b.done, "aria-label": b.name, onchange: (e) => { if (e.target.checked) app.sound("done"); change((d) => { setDone(d, b.id, e.target.checked); reward(d, [b.id]); }); } }),
      icon(b.kind === "move" ? "dumbbell" : b.kind === "eyes" ? "eye" : b.kind === "habit" ? "flame" : "drop"),
      h("span", { class: "db-name", text: b.name }),
      b.kind === "move" && b.reps ? num(b, "reps", "×") : null,
      // a weight only once it has one (right-click › Add a weight): an empty "0 kg" pushed the card's close off its edge
      b.kind === "move" && b.w ? num(b, "w", b.unit || "kg") : null,
      timing ? h("span", { class: "db-sub db-left", text: `${timer.left} s` })
        : b.dur ? (b.kind === "move" ? num(b, "dur", "s") : h("span", { class: "db-sub", text: b.reps ? `× ${b.reps} · ${b.dur} s` : `${b.dur} s` })) : null,
      b.kind === "eyes" && b.reps && !b.dur ? h("span", { class: "db-sub", text: `× ${b.reps}` }) : null,
      (b.dur || b.reps) && !b.done ? h("button", { class: "icon-btn", title: timing ? (timer.up ? "Done - stop and tick it off" : "Stop the timer") : b.dur ? `Start a ${b.dur}-second timer - it ticks, and ticks this off when it ends` : "Start a ticking clock while you do them - press again when done", onclick: () => runTimer(b) }, icon(timing ? (timer.up ? "check" : "pause") : "play")) : null,
      b.kind === "move" && !b.done ? h("button", { class: "icon-btn", title: "Another exercise instead", onclick: () => change((d) => { const was = b.name; swapMove(d, b.id, have(), own(), base(), defs()); const now = d.breaks.find((x) => x.id === b.id); if (now && now.name === was) app.toast("No other exercise fits your equipment", { ms: 2500 }); }) }, icon("shuffle")) : null,
      h("button", { class: "icon-btn db-del", title: "Take it off the list", onclick: () => {
        if (timer && timer.id === b.id) stopTimer();
        let was = null;
        change((d) => { was = { b: d.breaks.find((x) => x.id === b.id), s: d.sets.find((x) => x.id === b.id) }; removeBreak(d, b.id); });
        app.toast(`${b.name} taken off`, { ms: 5000, action: { label: "Undo", run: () => change((d) => { if (was && was.b && !d.breaks.some((x) => x.id === b.id)) { d.breaks.push(was.b); if (was.s) d.sets.push(was.s); } }) } });
      } }, icon("x")));
  }
  /** A list of tick boxes that keeps itself up to date. pick(data) → the entries to show. */
  function list(pick, { temp, empty } = {}) {
    const el = h("div", { class: "db-list" });
    const l = { el, temp, draw: () => { if (!data) return void load().then(paint); const rows = pick(data); el.replaceChildren(...(rows.length ? rows.map(row) : empty ? [h("div", { class: "db-empty", text: empty })] : [])); } };
    lists.add(l);
    l.draw();
    return el;
  }

  /** A break begins (the Timer calls this), or "Try one now". */
  async function start(force, only) {
    if (!force && S.deskBreaks !== true) return;
    const ks = only ? kinds().filter((k) => only.includes(k)) : kinds();
    if (!ks.length) return;
    let ids = [];
    await change((d) => {
      const now = localIso().slice(0, 19), doneToday = ((app.habits && app.habits.log && app.habits.log[now.slice(0, 10)]) || []);
      const habits = ((app.habits && app.habits.habits) || []).filter((hb) => hb.inBreaks && !doneToday.includes(hb.id));
      const items = planBreak({ kinds: ks, have: have(), own: own(), base: base(), defs: defs(), habits }, d, now);
      d.breaks.push(...items);
      ids = items.map((b) => b.id);
      // counted for you: everything but a habit, which only you can say you did
      if (S.deskBreakAuto === true) { const auto = items.filter((b) => b.kind !== "habit").map((b) => b.id); for (const id of auto) setDone(d, id, true); reward(d, auto); }
    });
    if (!ids.length) return;
    if (ks.includes("move") && !(data ? data.breaks : []).some((b) => ids.includes(b.id) && b.kind === "move")) app.toast("No exercise fits the equipment you picked - Timer › Breaks that move you", { ms: 5000 });
    // said out loud: the break, then what it asks for
    const asked = (data ? data.breaks : []).filter((b) => ids.includes(b.id));
    // with its numbers, when a recording has them (the common ones: 4-30 reps, 20-60 s, 5-100 kg)
    const REPS = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30], SECS = [20, 30, 40, 45, 60], KG = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
    const numbers = (b) => b.kind !== "move" ? [] : [
      REPS.includes(b.reps) ? `${b.reps} reps` : null, SECS.includes(b.dur) ? `${b.dur} seconds` : null,
      (b.unit || "kg") === "kg" && KG.includes(b.w) ? `${b.w} kilos` : null].filter(Boolean);
    say(...(only ? [] : ["Time for a break."]), ...asked.flatMap((b) => [b.name, ...numbers(b)]));
    const title = only ? "A minute for your eyes" : S.deskBreakAuto === true ? "Break - counted for you, untick what you skip" : "Break - tick what you do";
    // closing the card ends its clock and its voice too
    const closeCard = () => { if (timer && ids.includes(timer.id)) stopTimer(); hush(); card.close(); };
    const card = h("div", { class: "db-card" },
      h("div", { class: "db-card-head" }, icon("dumbbell"), h("b", { text: title }),
        h("button", { class: "icon-btn", title: "Close", onclick: closeCard }, icon("x"))),
      list((d) => d.breaks.filter((b) => ids.includes(b.id)), { temp: true }),
      h("button", { class: "link-btn", text: "Today's log", onclick: () => { closeCard(); app.openView("timer"); } }));
    const ms = only ? 60000 : Math.max(60000, (Number(app.stats.data.pomo_break_mins) || 5) * 60000);
    // it stays while one of its timers runs
    cornerCard(card, { ms, hold: () => !!(timer && ids.includes(timer.id)) });
    // dragged by its head anywhere in the window (it keeps that place while it stays)
    const head = card.querySelector(".db-card-head");
    head.style.cursor = "grab";
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      const [x0, y0] = (card.style.translate || "0px 0px").split(" ").map((v) => parseFloat(v) || 0);
      const sx = e.clientX, sy = e.clientY;
      head.setPointerCapture(e.pointerId);
      const move = (m) => { card.style.translate = `${x0 + m.clientX - sx}px ${y0 + m.clientY - sy}px`; };
      const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
    });
    popOut(ids, title, ms);
    if (only && !voiceOn()) app.sound("habit");
  }
  // During a work block: every so many minutes of running work, eyes and water (never an exercise). The Timer's own
  // once-a-second tick calls this; nothing here keeps time by itself.
  let since = 0;
  function tick(now, phase, running) {
    const mins = Number(S.deskRemindMins) || 0;
    if (!mins || S.deskBreaks !== true || phase !== "work" || !running || !since) { since = now; return; }
    if (now - since >= mins * 60000) { since = now; start(false, ["eyes", "water"]); }
  }

  /** The card on the Timer page: on or off, how, what, the equipment, and today's log. */
  function panel() {
    const sw = (on, set) => { const b = h("button", { class: "switch" + (on() ? " is-on" : ""), role: "switch", "aria-checked": String(on()) }); b.onclick = () => { set(!on()); b.classList.toggle("is-on", on()); b.setAttribute("aria-checked", String(on())); }; return b; };
    const flip = (key, id) => { const cur = key === "deskBreakKinds" ? kinds() : have(); app.setSetting(key, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]); };
    const chips = (key, cur, all) => h("div", { class: "db-chips" }, all.map(([id, label]) => { const c = h("button", { class: "seg" + (cur().includes(id) ? " is-active" : ""), text: label, "aria-pressed": String(cur().includes(id)) }); c.onclick = () => { flip(key, id); c.classList.toggle("is-active", cur().includes(id)); c.setAttribute("aria-pressed", String(cur().includes(id))); }; return c; }));
    const mode = h("div", { class: "segmented is-small" });
    const paintMode = () => mode.replaceChildren(...[[false, "I tick what I did"], [true, "Count it for me"]].map(([v, label]) =>
      h("button", { class: "seg" + ((S.deskBreakAuto === true) === v ? " is-active" : ""), title: v ? "Every break is ticked on trust - untick what you skipped" : "Nothing counts until you tick it", onclick: () => { app.setSetting("deskBreakAuto", v); paintMode(); } }, label)));
    paintMode();
    const today = () => dayKey();
    const remind = h("div", { class: "segmented is-small", title: "Eyes and water only, while a work block runs" });
    const paintRemind = () => remind.replaceChildren(...[[0, "Off"], [20, "20 min"], [30, "30 min"], [45, "45 min"], [60, "60 min"]].map(([v, label]) =>
      h("button", { class: "seg" + ((Number(S.deskRemindMins) || 0) === v ? " is-active" : ""), onclick: () => { app.setSetting("deskRemindMins", v); paintRemind(); } }, label)));
    paintRemind();
    const ownEl = h("div", { class: "db-chips" });
    const label = (m) => `${m.ex}${m.reps ? ` × ${m.reps}` : ""}${m.w ? ` ${m.w} ${m.unit}` : ""}${m.dur ? ` ${m.dur} s` : ""}`;
    const paintOwn = () => ownEl.replaceChildren(
      ...mine().map((m) => h("button", { class: "seg is-active", title: "Click to take it off your list", text: label(m) + "  ×", onclick: () => { const was = mine(); app.setSetting("deskMoves", was.filter((x) => x !== m)); paintOwn(); app.toast(`${m.ex} taken off your list`, { ms: 5000, action: { label: "Undo", run: () => { app.setSetting("deskMoves", was); paintOwn(); } } }); } })),
      h("button", { class: "seg", text: "+ Add an exercise", onclick: async () => {
        const r = await askDialog("An exercise of your own", [{ key: "line", placeholder: "wall sit 30 sec   ·   kettlebell halo 10   ·   bench 100 kg 10" }], { ok: "Add", text: "Its name, then how many times or how long, and a weight if it has one. It takes its turn with the others in your breaks." });
        const m = r && ownMove(r.line, S.fitUnit);
        if (r && !m) return app.toast("That needs a name", { ms: 2000 });
        if (m) { app.setSetting("deskMoves", [...mine().filter((x) => keyOf(x.ex) !== keyOf(m.ex)), m]); paintOwn(); }
      } }));
    paintOwn();
    // a preset brings its equipment along; clicking it again goes back to the built-in list
    const presetEl = h("div", { class: "db-chips" });
    const haveEl = h("div");
    const paintHave = () => haveEl.replaceChildren(chips("deskEquipment", have, EQUIPMENT));
    const paintPreset = () => presetEl.replaceChildren(...PRESETS.map((p) => h("button", { class: "seg" + (S.deskPreset === p.id ? " is-active" : ""), title: p.title + " - " + p.moves.map((m) => m.ex).join(", "), text: p.name, onclick: () => {
      const on = S.deskPreset !== p.id;
      app.setSetting("deskPreset", on ? p.id : "");
      if (on) app.setSetting("deskEquipment", p.have.slice());
      paintPreset(); paintHave();
    } })));
    paintPreset(); paintHave();
    // water: the glasses ticked today (a break's, or one logged here), and how much that is with the glass size given
    function water() {
      const el = h("span", { class: "db-water" });
      const ml = () => Math.max(0, Number(S.deskGlassMl) || 250);
      const size = h("input", { type: "number", min: "50", max: "2000", step: "50", value: String(ml()), title: "Your glass, in ml", onchange: (e) => { app.setSetting("deskGlassMl", Math.min(2000, Math.max(50, Number(e.target.value) || 250))); paint(); } });
      const count = h("span", { class: "db-water-n" });
      const l = { el, temp: false, draw: () => { if (!data) return void load().then(paint); const n = glassesOn(data, today()); count.textContent = `${n} glass${n === 1 ? "" : "es"} of water · ${((n * ml()) / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} l`; } };
      lists.add(l);
      el.append(icon("drop"), count, h("label", { class: "db-num", title: "Your glass, in ml" }, size, "ml"),
        h("button", { class: "btn btn-sm", title: "Log a glass you drank", onclick: () => change((d) => { const id = uuid(); d.breaks.push({ id, t: localIso().slice(0, 19), kind: "water", name: "A glass of water", done: true }); reward(d, [id]); }) }, "+1 glass"));
      l.draw();
      return el;
    }
    return h("section", { class: "card db-panel" },
      h("header", { class: "card-head" }, icon("dumbbell"), h("h2", { text: "Breaks that move you" }), h("span", { class: "fit-fill" }),
        h("label", { class: "pomo-opt" }, sw(() => S.deskBreaks === true, (v) => app.setSetting("deskBreaks", v)), "Suggest something each break"),
        h("label", { class: "pomo-opt", title: "With Leonote minimized or in the tray, the break shows in a small window at the top right of the screen" }, sw(() => S.deskPopOut !== false, (v) => app.setSetting("deskPopOut", v)), "On the desktop when hidden"),
        h("label", { class: "pomo-opt", title: "Off: the desktop card goes when the break ends, its line running down; on: it stays until you close it" }, sw(() => S.deskPopStay === true, (v) => app.setSetting("deskPopStay", v)), "Keep it until closed"),
        h("label", { class: "pomo-opt", title: "A voice says the break and what it asks for, and counts the end of a timer down" }, sw(voiceOn, (v) => { app.setSetting("deskVoice", v); if (!v) hush(); }), "Say it out loud")),
      h("div", { class: "db-opts" },
        h("div", { class: "db-opt" }, h("span", { class: "db-label", text: "How it counts" }), mode),
        h("div", { class: "db-opt" }, h("span", { class: "db-label", text: "Each break" }), chips("deskBreakKinds", kinds, [["move", "An exercise"], ["eyes", "Eyes"], ["water", "Water"]])),
        h("div", { class: "db-opt" }, h("span", { class: "db-label", text: "Preset" }), presetEl),
        h("div", { class: "db-opt" }, h("span", { class: "db-label", text: "Equipment" }), haveEl)),
      h("div", { class: "db-opt" }, h("span", { class: "db-label", text: "Your exercises" }), ownEl),
      h("div", { class: "db-opt" }, h("span", { class: "db-label", text: "While working" }), remind),
      h("div", { class: "db-today" }, h("span", { class: "db-label", text: "Today" }), kinds().includes("water") ? water() : null, h("button", { class: "link-btn", text: "Try one now", onclick: () => start(true) })),
      list((d) => onDay(d.breaks, today()).slice().reverse(), { empty: "Nothing yet today. A ticked exercise also lands in the Workout log." }));
  }
  // a break with things to do just ended: said once, when breaks are on and speak
  const backToWork = () => { if (S.deskBreaks === true) say("Back to work."); };
  return { start, panel, tick, backToWork };
}
