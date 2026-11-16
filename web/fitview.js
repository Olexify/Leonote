// Workout, food and fasting in one view (Alt+W). A line typed - or said -
// at the top becomes a set ("10 pushups", "bench 60 kg x 5", "run 5 km
// 28 min") or a meal ("2 eggs 150 kcal"); under Fasting two buttons do it.
// Program is the book: a run of sessions from a template or written by
// hand, reordered by their handles, each line's numbers fields; the next
// session waits at the top of Workout with a box per planned set, and a
// box ticked logs that set with its planned numbers.
// The day's entries sit in rows whose numbers are fields - change one and
// it is saved - with +1/+5/+10 at hand, and every exercise or food seen
// before is a chip that adds its last entry again. The log is fit.json next
// to the other data files; the pure parts live in fit.js.

import { h, dayKey, parseDay, addDays, fmtDay, localIso, uuid, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu, askDialog, confirmDialog, inlineEdit, sortable } from "./ui.js";
import { XP } from "./stats.js";
import * as F from "./fit.js";
import * as P from "./fitprograms.js";
import { voiceButton } from "./voice.js";

const TABS = [["workout", "Workout", "dumbbell"], ["program", "Program", "book"], ["food", "Food", "apple"], ["fasting", "Fasting", "clock"]];
const fmtN = (n) => (Math.round(n * 10) / 10).toLocaleString();
const hhmm = (t) => String(t || "").slice(11, 16);

export function mountFit(app, el) {
  let data = null; // fit.json, once loaded
  let tab = "workout";
  let day = dayKey();
  const persist = debounce(() => app.host.fitSave(data).then(() => app.bus.emit("fit", data)).catch((e) => app.toast("Could not save the workout log: " + e, { kind: "error" })), 400);
  const save = () => { persist(); render(); };
  const stamp = () => (day === dayKey() ? localIso().slice(0, 19) : day + "T12:00:00");
  const unit = () => (app.settings.fitUnit === "lb" ? "lb" : "kg");

  // ── frame ──
  const sub = h("div", { class: "vh-sub" });
  const dayLabel = h("button", { class: "fit-daylabel", title: "Pick a day", onclick: (e) => pickDay(e.currentTarget) });
  const nav = h("div", { class: "fit-nav" },
    h("button", { class: "icon-btn", title: "The day before", onclick: () => { day = dayKey(addDays(parseDay(day), -1)); render(); } }, icon("back")),
    dayLabel,
    h("button", { class: "icon-btn", title: "The day after", onclick: () => { day = dayKey(addDays(parseDay(day), 1)); render(); } }, icon("forward")),
    h("button", { class: "btn", onclick: () => { day = dayKey(); render(); } }, "Today"));
  const tabs = h("div", { class: "segmented" }, TABS.map(([id, name, ic]) => h("button", { class: "seg", dataset: { id }, onclick: () => { tab = id; render(); if (id !== "fasting") input.focus(); } }, icon(ic), name)));
  const input = h("input", { class: "qa-input", spellcheck: false });
  const mic = voiceButton({ cls: "icon-btn fit-mic", title: "Say what you did - “ten push-ups, twenty squats and a 5 km run”, “bench sixty kilo five reps”", onText: (said) => { input.value = said; if (submit(said, { said: true })) input.value = ""; else app.toast(`Heard “${said}” - no exercise in it`, { ms: 3500 }); } });
  const qa = h("div", { class: "qa fit-qa" }, icon("plus"), input, mic, h("kbd", { text: "Enter" }));
  const chips = h("div", { class: "fit-chips" });
  const body = h("div", { class: "fit-body" });
  // ── rest between sets: a countdown at hand, longer with +30, started by itself after a set if wanted ──
  let rest = null; // { until, total }
  const restBar = h("div", { class: "fit-rest" });
  const restClock = h("span", { class: "fit-rest-clock" });
  const restFill = h("div", { class: "fit-bar-fill" });
  const restSets = h("span", { class: "fit-rest-auto" });
  const fmtRest = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
  let restTimer = 0;
  function paintRest() {
    if (rest && !restTimer) restTimer = setInterval(paintRest, 250);
    else if (!rest && restTimer) { clearInterval(restTimer); restTimer = 0; }
    restBar.classList.toggle("is-on", !!rest);
    const auto = Math.max(0, +app.settings.fitAutoRest || 0);
    restSets.textContent = auto ? `auto ${auto} s after a set` : "";
    if (!rest) { restClock.textContent = ""; restFill.style.width = "0%"; return; }
    const left = rest.until - Date.now();
    restClock.textContent = fmtRest(left);
    restFill.style.width = Math.max(0, Math.min(100, (left / rest.total) * 100)) + "%";
    if (left <= 0) { rest = null; clearInterval(restTimer); restTimer = 0; restBar.classList.remove("is-on"); app.sound("done"); app.toast("Rest over - next set", { ms: 2500 }); }
  }
  function startRest(sec) { rest = { until: Date.now() + sec * 1000, total: sec * 1000 }; paintRest(); }
  function moreRest(sec) { if (!rest) return startRest(sec); rest.until += sec * 1000; rest.total += sec * 1000; paintRest(); }
  // the clock ticks only while a rest counts down: every change to the rest goes through paintRest, which starts and stops it
  restBar.append(icon("clock"), h("span", { class: "fit-rest-label", text: "Rest" }), restClock,
    h("div", { class: "fit-bar fit-rest-bar" }, restFill),
    h("button", { class: "fit-bump", title: "Rest 30 s", onclick: () => startRest(30) }, "30"),
    h("button", { class: "fit-bump", title: "Rest 60 s", onclick: () => startRest(60) }, "60"),
    h("button", { class: "fit-bump", title: "Rest 90 s", onclick: () => startRest(90) }, "90"),
    h("button", { class: "fit-bump", title: "Not recovered yet: 30 s more", onclick: () => moreRest(30) }, "+30"),
    h("button", { class: "icon-btn", title: "Stop the rest", onclick: () => { rest = null; paintRest(); } }, icon("x")),
    restSets,
    h("button", { class: "icon-btn", title: "Rest by itself after every set (Settings › Workout)", onclick: (e) => menu(0, 0, [{ header: "After every set, rest" }, ...[0, 30, 45, 60, 90, 120, 180].map((n) => ({ label: n ? `${n} s` : "Only when I press", checked: (+app.settings.fitAutoRest || 0) === n, run: () => { app.setSetting("fitAutoRest", n); paintRest(); } }))], { anchor: e.currentTarget }) }, icon("settings")));
  el.append(h("div", { class: "view-inner fit" },
    h("header", { class: "vh" }, h("div", {}, h("h1", { class: "vh-title", text: "Workout" }), sub), nav),
    tabs, qa, chips, restBar, body));

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") input.blur();
    if (e.key !== "Enter" || !input.value.trim()) return;
    if (submit(input.value)) input.value = "";
  });

  function pickDay(anchor) {
    const inp = h("input", { type: "date", class: "date-pop", value: day });
    const r = anchor.getBoundingClientRect();
    Object.assign(inp.style, { left: Math.min(r.left, innerWidth - 180) + "px", top: r.bottom + 4 + "px" });
    document.getElementById("overlay-root").append(inp);
    inp.focus();
    try { inp.showPicker(); } catch {}
    inp.addEventListener("change", () => { if (inp.value) { day = inp.value; render(); } inp.remove(); });
    inp.addEventListener("blur", () => inp.remove());
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") inp.remove(); });
  }

  // ── adding ──
  function submit(text, { said } = {}) {
    if (tab === "workout") {
      // one sentence can hold several: "ten push-ups, twenty squats and a 5 km run" - each its own entry, one note of them all
      const ps = F.parseSets(text, data.ex, unit());
      if (!ps.length) return false;
      for (const p of ps) addSets(p, { quiet: !said || ps.length > 1 });
      if (ps.length > 1) app.toast(ps.map((p) => `${p.ex}: ${setLabel(p)}${p.sets > 1 ? ` × ${p.sets}` : ""}`).join(" · "), { ms: 3500 });
      return true;
    }
    if (tab === "food") { const p = F.parseFood(text, data.foods); if (!p) return false; addFood(p); return true; }
    return false;
  }
  function addSets(p, { quiet } = {}) {
    const k = F.keyOf(p.ex);
    for (let i = 0; i < p.sets; i++) data.sets.push({ id: uuid(), t: stamp(), ex: p.ex, reps: p.reps, w: p.w, unit: p.unit, dist: p.dist, dunit: p.dunit, dur: p.dur });
    const prev = data.ex[k] || {};
    data.ex[k] = { name: p.ex, last: { reps: p.reps, w: p.w, unit: p.unit, dist: p.dist, dunit: p.dunit, dur: p.dur }, n: (prev.n || 0) + p.sets, at: stamp() };
    app.stats.award(XP.workoutSet * p.sets);
    app.sound("done");
    if (day === dayKey() && +app.settings.fitAutoRest > 0) startRest(+app.settings.fitAutoRest);
    if (!quiet) app.toast(`${p.ex}: ${setLabel(p)}${p.sets > 1 ? ` × ${p.sets} sets` : ""}`, { ms: 1800 });
    const pg = program() || freeProgram();
    for (const s of plannedAll(pg)) if (!s.done && P.sessionProgress(s, F.onDay(data.sets, day)).complete) finish(pg, s);
    save();
  }
  function addFood(p) {
    data.food.push({ id: uuid(), t: stamp(), text: p.text, kcal: p.kcal, prot: p.prot });
    data.foods[F.keyOf(p.text)] = { text: p.text, kcal: p.kcal, prot: p.prot, at: stamp() };
    app.sound("done");
    save();
  }
  const setLabel = (s) => [s.reps ? `${s.reps} reps` : "", s.w ? `${fmtN(s.w)} ${s.unit}` : "", s.dist ? `${fmtN(s.dist)} ${s.dunit}` : "", s.dur ? F.fmtDur(s.dur) : ""].filter(Boolean).join(" · ");

  // ── rows: numbers as fields ──
  function numField(e, key, step, after, { min = 0, width } = {}) {
    const i = h("input", { type: "number", class: "fit-num", value: String(e[key] || 0), min: String(min), step: String(step), style: width ? { width } : null });
    i.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") i.blur(); });
    i.addEventListener("change", () => { const v = parseFloat(i.value); e[key] = Number.isFinite(v) && v >= min ? v : 0; persist(); if (after) after(); });
    return i;
  }
  /** Seconds kept, minutes shown: that is how a run is thought of. */
  function durField(e, after = render) {
    const i = h("input", { type: "number", class: "fit-num", value: String(Math.round((e.dur || 0) / 6) / 10), min: "0", step: "0.5" });
    i.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") i.blur(); });
    i.addEventListener("change", () => { const v = parseFloat(i.value); e.dur = Number.isFinite(v) && v > 0 ? Math.round(v * 60) : 0; persist(); if (after) after(); });
    return i;
  }
  function timeField(e) {
    const i = h("input", { type: "time", class: "fit-time", value: hhmm(e.t) });
    i.addEventListener("keydown", (ev) => ev.stopPropagation());
    i.addEventListener("change", () => { if (i.value) { e.t = day + "T" + i.value + ":00"; save(); } });
    return i;
  }
  const bump = (e, key, n, label) => h("button", { class: "fit-bump", title: `${key === "reps" ? "Reps" : "Weight"} ${n > 0 ? "+" : ""}${n}`, onclick: () => { e[key] = Math.max(0, Math.round(((e[key] || 0) + n) * 100) / 100); save(); } }, label || (n > 0 ? "+" : "") + n);
  const remove = (list, e, what) => h("button", { class: "icon-btn fit-x", title: `Remove this ${what}`, onclick: async () => { if (!(await confirmDialog(`Remove this ${what}?`, list === data.sets ? "It leaves the log, and its XP with it." : "It leaves the log; nothing else changes.", { ok: "Remove", safe: true }))) return; const i = list.indexOf(e); if (i >= 0) { list.splice(i, 1); if (list === data.sets) takeBackSet(e); } save(); } }, icon("x"));
  // a set taken out of the log takes its XP with it, as the Levels page says (a break's set keeps its own rule: it paid once, on the tick)
  const takeBackSet = (s) => { if (s && s.src !== "break") app.stats.award(-XP.workoutSet); };

  // ── workout ──
  function renderWorkout() {
    const today = F.onDay(data.sets, day);
    const groups = F.groupSets(today);
    const totals = groups.reduce((a, g) => ({ sets: a.sets + g.sets.length, reps: a.reps + g.reps, volume: a.volume + g.volume }), { sets: 0, reps: 0, volume: 0 });
    sub.textContent = today.length ? `${totals.sets} set${totals.sets === 1 ? "" : "s"} · ${totals.reps} reps${totals.volume ? ` · ${fmtN(totals.volume)} ${unit()} lifted` : ""}` : "Type what you did: “10 pushups”, “bench 60 kg x 5”, “run 5 km 28 min”";

    // exercises seen before, most recent first: one click adds the last set again
    const seen = Object.entries(data.ex).sort((a, b) => String(b[1].at || "").localeCompare(String(a[1].at || ""))).slice(0, 14);
    chips.replaceChildren(...seen.map(([k, x]) => {
      const c = h("button", { class: "chip-btn fit-chip", title: `Add again: ${setLabel({ ...x.last, unit: x.last.unit || unit() })}` }, icon("plus"), x.name);
      c.onclick = () => addSets({ ex: x.name, sets: 1, ...x.last }, { quiet: true });
      c.oncontextmenu = (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [{ label: `Forget “${x.name}”`, icon: "trash", run: () => { delete data.ex[k]; save(); } }]); };
      return c;
    }));

    const jump = groups.length > 1 ? h("div", { class: "fit-jump" }, groups.map((g) => h("button", { class: "chip-btn", onclick: () => { const c = body.querySelector(`.fit-group[data-key="${g.key}"]`); if (c) { c.scrollIntoView({ behavior: "smooth", block: "start" }); c.classList.add("is-lit"); setTimeout(() => c.classList.remove("is-lit"), 900); } } }, g.name, h("span", { class: "fit-prognav-pct", text: String(g.sets.length) })))) : null;
    const cards = groups.map((g) => dragAnywhere(h("section", { class: "card fit-group", dataset: { key: g.key } },
      h("header", { class: "card-head" }, icon("dumbbell"),
        h("h2", { text: g.name, title: "Click to rename - every set of it today follows", onclick: (e) => inlineEdit(e.currentTarget, g.name, { onCommit: (v) => renameGroup(g, v) }) }),
        h("span", { class: "chip is-quiet", text: `${g.sets.length} set${g.sets.length === 1 ? "" : "s"}` }),
        g.reps ? h("span", { class: "chip is-quiet", text: `${g.reps} reps` }) : null,
        g.volume ? h("span", { class: "chip is-quiet", text: `${fmtN(g.volume)} ${g.unit}` }) : null,
        g.dist ? h("span", { class: "chip is-quiet", text: `${fmtN(g.dist)} ${g.sets[0].dunit || "km"}` }) : null,
        g.dur ? h("span", { class: "chip is-quiet", text: F.fmtDur(g.dur) }) : null,
        h("button", { class: "link-btn", onclick: () => { const last = g.sets[g.sets.length - 1]; addSets({ ex: g.name, sets: 1, reps: last.reps, w: last.w, unit: last.unit, dist: last.dist, dunit: last.dunit, dur: last.dur }, { quiet: true }); } }, "+ Same again"),
        h("button", { class: "icon-btn", title: "This exercise today", onclick: (e) => groupMenu(g, e.currentTarget) }, icon("more"))),
      h("div", { class: "fit-rows" }, g.sets.map((s, i) => {
        const cardio = !s.reps && (s.dist || s.dur);
        return dragAnywhere(h("div", { class: "fit-row fit-set", dataset: { id: s.id }, title: "Drag to reorder" },
          h("span", { class: "fit-idx", text: String(i + 1) }),
          timeField(s),
          cardio ? null : h("span", { class: "fit-cell" }, numField(s, "reps", 1, render), h("span", { class: "fit-unit", text: "reps" }), bump(s, "reps", 1), bump(s, "reps", 5), bump(s, "reps", 10)),
          s.w || (!cardio && data.ex[g.key] && data.ex[g.key].last && data.ex[g.key].last.w) ? h("span", { class: "fit-cell" }, h("span", { class: "fit-unit", text: "×" }), numField(s, "w", 0.5, render), h("span", { class: "fit-unit", text: s.unit || unit() }), bump(s, "w", -2.5, "−2.5"), bump(s, "w", 2.5, "+2.5")) : null,
          s.dist || cardio ? h("span", { class: "fit-cell" }, numField(s, "dist", 0.1, render), h("span", { class: "fit-unit", text: s.dunit || "km" })) : null,
          s.dur || cardio ? h("span", { class: "fit-cell" }, durField(s), h("span", { class: "fit-unit", text: "min" })) : null,
          h("span", { class: "fit-fill" }),
          h("button", { class: "icon-btn fit-menu", title: "More", onclick: (e) => setMenu(s, e.currentTarget) }, icon("more")),
          remove(data.sets, s, "set")));
      })))));

    // the week, the records, the last days
    const from = dayKey(addDays(parseDay(day), -6));
    const week = F.daySummaries(data.sets, from, day);
    const wk = week.reduce((a, d) => ({ sets: a.sets + d.sets, reps: a.reps + d.reps, volume: a.volume + d.volume }), { sets: 0, reps: 0, volume: 0 });
    const recKeys = groups.length ? groups.map((g) => g.key) : Object.entries(data.ex).sort((a, b) => (b[1].n || 0) - (a[1].n || 0)).slice(0, 6).map(([k]) => k);
    const recs = recKeys.map((k) => [k, F.records(data.sets, k)]).filter(([, r]) => r);
    const history = F.daySummaries(data.sets, dayKey(addDays(parseDay(day), -30)), day).filter((d) => d.day !== day).slice(0, 10);
    const side = h("div", { class: "fit-side" },
      h("section", { class: "card" }, h("header", { class: "card-head" }, icon("chart"), h("h2", { text: "Last 7 days" })),
        h("div", { class: "fit-stats" }, stat(String(week.length), "days"), stat(String(wk.sets), "sets"), stat(String(wk.reps), "reps"), wk.volume ? stat(fmtN(wk.volume), unit()) : null)),
      recs.length ? h("section", { class: "card" }, h("header", { class: "card-head" }, icon("trophy"), h("h2", { text: "Records" })),
        h("div", { class: "fit-list" }, recs.map(([k, r]) => h("div", { class: "fit-li" }, h("span", { class: "fit-li-name", text: (data.ex[k] || {}).name || k }),
          h("span", { class: "fit-li-sub", text: [r.maxW ? `${fmtN(r.maxW)} ${unit()} × ${r.maxWReps}` : "", r.maxReps ? `${r.maxReps} reps` : "", r.maxDist ? `${fmtN(r.maxDist)} km` : "", r.maxDur ? F.fmtDur(r.maxDur) : "", `${r.count} set${r.count === 1 ? "" : "s"}`].filter(Boolean).join(" · ") }))))) : null,
      library(),
      history.length ? h("section", { class: "card" }, h("header", { class: "card-head" }, icon("clock"), h("h2", { text: "Before" })),
        h("div", { class: "fit-list" }, history.map((d) => h("button", { class: "fit-li is-link", onclick: () => { day = d.day; render(); } }, h("span", { class: "fit-li-name", text: fmtDay(parseDay(d.day)) }),
          h("span", { class: "fit-li-sub", text: `${d.exercises.slice(0, 3).join(", ")}${d.exercises.length > 3 ? ` +${d.exercises.length - 3}` : ""} · ${d.sets} sets${d.volume ? ` · ${fmtN(d.volume)} ${unit()}` : ""}` }))))) : null);

    const plan = planCard(today);
    const main = h("div", { class: "fit-main" }, plan, jump, cards.length ? cards : plan ? null : h("div", { class: "card-empty fit-empty", text: day === dayKey() ? "Nothing yet today. Type a set above, tap an exercise chip to repeat its last set, or pick a program under Program." : "Nothing on this day." }));
    // drag a set within its exercise, or a whole exercise past another: the log's order is the day's order
    sortable(main, { item: ".fit-group, .fit-set, .fit-pex:not(.in-plan), .fit-plan-row", onMove: (from, to, elm) => {
      if (elm.classList.contains("fit-pex") || elm.classList.contains("fit-plan-row")) {
        const pg = program() || freeProgram();
        const card = elm.closest(".fit-plan");
        const s = plannedAll(pg).find((x) => card && card.dataset.sid === x.id);
        if (s) { s.exercises.splice(to, 0, s.exercises.splice(from, 1)[0]); save(); }
        return;
      }
      const todays = F.onDay(data.sets, day);
      if (elm.classList.contains("fit-set")) {
        const g = groups.find((x) => x.key === elm.closest(".fit-group").dataset.key);
        if (!g) return;
        const moved = g.sets[from], target = g.sets[to];
        data.sets.splice(data.sets.indexOf(moved), 1);
        data.sets.splice(data.sets.indexOf(target) + (to > from ? 1 : 0), 0, moved);
      } else {
        const order = groups.slice();
        order.splice(to, 0, order.splice(from, 1)[0]);
        const at = data.sets.indexOf(todays[0]);
        for (const x of todays) data.sets.splice(data.sets.indexOf(x), 1);
        data.sets.splice(at, 0, ...order.flatMap((g) => g.sets));
      }
      save();
    } });
    body.replaceChildren(main, side);
  }
  function renameGroup(g, v) {
    const name = F.exerciseName(v, data.ex) || v.trim();
    if (!name || name === g.name) return;
    for (const s of g.sets) s.ex = name;
    const k = F.keyOf(name), old = data.ex[g.key];
    if (old && !data.ex[k]) { data.ex[k] = { ...old, name }; delete data.ex[g.key]; }
    save();
  }
  function groupMenu(g, anchor) {
    const other = g.unit === "lb" ? "kg" : "lb";
    menu(0, 0, [
      { label: "Rename", icon: "edit", run: () => { const t = anchor.closest(".fit-group").querySelector("h2"); inlineEdit(t, g.name, { onCommit: (v) => renameGroup(g, v) }); } },
      { label: `Weights in ${other}`, icon: "swap", run: () => { for (const s of g.sets) s.unit = other; save(); } },
      { label: "Move all to yesterday", icon: "back", run: () => { const d = dayKey(addDays(parseDay(day), -1)); for (const s of g.sets) s.t = d + s.t.slice(10); save(); } },
      day !== dayKey() ? { label: "Move all to today", icon: "sun", run: () => { for (const s of g.sets) s.t = dayKey() + s.t.slice(10); save(); } } : null,
      "sep",
      { label: `Remove all ${g.sets.length} sets`, icon: "trash", run: async () => { if (await confirmDialog(`Remove ${g.name} today?`, `${g.sets.length} set${g.sets.length === 1 ? "" : "s"} leave the log.`, { ok: "Remove", safe: true })) { for (const s of g.sets) data.sets.splice(data.sets.indexOf(s), 1); for (const s of g.sets) takeBackSet(s); save(); } } },
    ].filter(Boolean), { anchor });
  }

  // ── the plan: the program's session for this day, a box per planned set ──
  const program = () => data.programs.find((p) => p.id === data.program) || null;
  // no program enabled: the day's own plan, written on the spot, is the session
  const FREE = "free";
  const freeProgram = () => ({ id: FREE, name: "Your own plan", sessions: Object.values(data.free) });
  const freeFor = (d) => data.free[d] || (data.free[d] = { id: "free-" + d, name: "Today's plan", note: "", on: d, done: null, exercises: [] });
  const lastFree = () => Object.keys(data.free).filter((d) => d < day && data.free[d].exercises.length).sort().pop();
  /** The sessions this day is about: those put on it, the one picked for it, those finished on it - else the next undone. */
  function plannedAll(p) {
    if (!p) return [];
    const out = p.sessions.filter((x) => x.on === day || x.done === day);
    if (p.pick && p.pick.day === day) { const s = p.sessions.find((x) => x.id === p.pick.sid); if (s && !out.includes(s)) out.unshift(s); }
    if (out.length) return out;
    const next = P.programProgress(p).next;
    return next ? [next] : [];
  }
  const planned = (p) => plannedAll(p)[0] || null;
  const logPlanned = (e) => addSets({ ex: e.ex, sets: 1, reps: e.reps || 0, w: e.w || 0, unit: e.unit || unit(), dist: e.dist || 0, dunit: "km", dur: e.dur || 0 }, { quiet: true });
  function finish(p, s) {
    if (s.done) return;
    s.done = day;
    app.stats.award(XP.sessionDone);
    app.sound("level");
    const pp = P.programProgress(p);
    app.toast(p.id === FREE ? "Plan done - well done" : pp.done === pp.n ? `${p.name}: every session done` : `Session done: ${s.name} - ${pp.n - pp.done} to go`, { ms: 3000 });
  }
  const goDo = (p, s) => { data.program = p.id; p.pick = { day: dayKey(), sid: s.id }; day = dayKey(); tab = "workout"; save(); };
  function planCard(today) {
    const p = program();
    if (!p) {
      const fp = freeProgram();
      const list = plannedAll(fp);
      if (list.length) return list.map((s) => sessionCard(fp, s, today, null));
      const prev = lastFree();
      return h("section", { class: "card fit-plan is-free" },
        h("header", { class: "card-head" }, icon("edit"), h("h2", { text: "Plan the day" }), h("span", { class: "chip is-quiet", text: "no program needed" })),
        h("p", { class: "set-hint", text: "Write today's plan here and tick the sets off as you go - lines, blocks, or yesterday's plan again. A program (the Program tab) is only for when you want a whole book laid out." }),
        h("div", { class: "fit-add-row" },
          h("button", { class: "fit-add-ex", onclick: (e) => extraMenu(freeFor(day), e.currentTarget) }, icon("plus"), "Exercise"),
          h("button", { class: "fit-add-ex", onclick: (e) => blockMenu(freeFor(day), e.currentTarget) }, icon("layers"), "Block"),
          prev ? h("button", { class: "fit-add-ex", title: `The plan of ${fmtDay(parseDay(prev))} again`, onclick: () => { const s = freeFor(day); s.exercises.push(...copyLines(data.free[prev].exercises)); save(); } }, icon("redo"), "Last plan again") : null,
          h("button", { class: "fit-add-ex", onclick: () => { tab = "program"; render(); } }, icon("book"), "A program")));
    }
    const list = plannedAll(p);
    const openBook = () => h("button", { class: "link-btn", onclick: () => { tab = "program"; render(); } }, "The book");
    if (!list.length) return h("section", { class: "card fit-plan is-complete" }, h("header", { class: "card-head" }, icon("trophy"), h("h2", { text: p.name }), h("span", { class: "chip is-today", text: "Every session done" }), h("span", { class: "fit-fill" }), openBook()));
    return list.map((s) => sessionCard(p, s, today, openBook()));
  }
  let editPlan = null; // the session whose plan card shows its lines as fields
  let editLine = null; // one line shown as fields, by a double-click; a click anywhere else closes it
  document.addEventListener("mousedown", (e) => { if (editLine && !e.target.closest(".fit-plan-row.is-editing, .menu, .dlg-back")) { editLine = null; render(); } }, true);
  /** A row that drags by any spot except its fields and buttons. */
  const dragAnywhere = (el) => { el.addEventListener("mousedown", (e) => { el.draggable = !e.target.closest("input, button, select, textarea, .inline-edit, a"); }); el.addEventListener("dragend", () => { el.draggable = false; }); return el; };
  function sessionCard(p, s, today, openBook) {
    const pp = P.programProgress(p);
    const pr = P.sessionProgress(s, today);
    const editing = editPlan === s.id;
    const free = p.id === FREE;
    const idx = p.sessions.indexOf(s) + 1;
    const done = !!s.done || pr.complete;
    const rows = pr.rows.map((r) => editLine === r.e.id ? dragAnywhere(h("div", { class: "fit-plan-row is-editing", dataset: { line: r.e.id }, title: "Drag to reorder; click elsewhere when done" }, (() => { const px = pex(p, s, r.e); px.classList.add("in-plan"); return px; })(), h("button", { class: "link-btn", onclick: () => { editLine = null; render(); } }, "Done"))) : dragAnywhere(h("div", { class: "fit-plan-row" + (r.done >= r.target ? " is-done" : ""), dataset: { line: r.e.id }, title: "Double-click to change this line; drag to reorder", ondblclick: (e) => { if (e.target.closest(".fit-tick")) return; editLine = r.e.id; render(); } },
      h("span", { class: "fit-plan-name", text: r.e.ex, title: (P.exerciseInfo(r.e.ex) || {}).cue || "" }),
      h("span", { class: "fit-plan-target", text: P.lineLabel(r.e) }),
      h("span", { class: "fit-ticks" },
        Array.from({ length: r.target }, (_, i) => { const t = h("button", { class: "fit-tick" + (i < r.done ? " is-on" : ""), title: i < r.done ? "Logged - right-click to take it back" : `Log set ${i + 1}: ${P.lineLabel({ ...r.e, sets: 1 })} - right-click for other numbers`, onclick: () => { if (i >= r.done) logPlanned(r.e); } }, icon("check")); t.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); tickMenu(p, s, r, t); }); return t; }),
        r.logged > r.target ? h("span", { class: "chip is-quiet", text: `+${r.logged - r.target}` }) : null))));
    return h("section", { class: "card fit-plan" + (done ? " is-complete" : ""), dataset: { sid: s.id } },
      h("header", { class: "card-head" }, icon(free ? "edit" : "book"), h("h2", { text: free ? s.name : `${idx}. ${s.name}`, title: "Click to rename", onclick: (e) => inlineEdit(e.currentTarget, s.name, { onCommit: (v) => { s.name = v.trim(); save(); } }) }),
        free ? null : h("span", { class: "chip is-quiet", text: `${p.name} · ${pp.done} of ${pp.n}` }),
        s.on && s.on !== day ? h("span", { class: "chip is-quiet", title: "The day it is put on", text: `for ${fmtDay(parseDay(s.on))}` }) : null,
        done ? h("span", { class: "chip is-today" }, icon("check"), "Done") : h("span", { class: "chip is-quiet", text: `${pr.done} of ${pr.total} sets` }),
        h("span", { class: "fit-fill" }), openBook,
        h("button", { class: "icon-btn", title: "More", onclick: (e) => planMenu(p, s, e.currentTarget) }, icon("more"))),
      h("div", { class: "fit-bar" + (done ? " is-done" : "") }, h("div", { class: "fit-bar-fill", style: { width: (done ? 100 : pr.pct) + "%" } })),
      s.note ? h("p", { class: "fit-chapter-note", text: s.note }) : null,
      editing ? h("div", { class: "fit-pex-list" }, s.exercises.map((e) => pex(p, s, e)))
        : rows.length ? h("div", { class: "fit-plan-rows" }, rows) : h("div", { class: "card-empty", text: "This session has no lines yet - add one below." }),
      h("div", { class: "fit-plan-foot" },
        h("div", { class: "fit-add-row" },
          h("button", { class: "fit-add-ex", title: "One more exercise in this session - the odd extra", onclick: (e) => extraMenu(s, e.currentTarget) }, icon("plus"), "Exercise"),
          h("button", { class: "fit-add-ex", title: "A block of lines into this session", onclick: (e) => blockMenu(s, e.currentTarget) }, icon("layers"), "Block"),
          h("button", { class: "fit-add-ex" + (editing ? " is-on" : ""), title: "The lines as fields: numbers, order, names - edited right here", onclick: () => { editPlan = editing ? null : s.id; render(); } }, icon("edit"), editing ? "Done editing" : "Edit")),
        !done ? h("button", { class: "link-btn", onclick: () => { finish(p, s); save(); } }, "Mark the session done") : null));
  }
  /** An extra line for the session: something done now and then, picked from what is known. */
  function extraMenu(s, anchor) {
    const seen = Object.values(data.ex).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 8);
    const add = (ex, extra = {}) => { const info = P.exerciseInfo(ex); const l = { ...P.blankLine(ex), ...(info && info.kind === "time" ? { reps: 0, dur: 30 } : info && info.kind === "cardio" ? { reps: 0, sets: 1, dist: 2 } : {}), ...extra }; s.exercises.push(l); save(); };
    menu(0, 0, [
      { header: "Type one" },
      { el: (() => { const i = h("input", { class: "text-input fit-extra-in", list: "fit-exlist", placeholder: "Exercise, then Enter", spellcheck: false }); i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && i.value.trim()) { const p = F.parseSet(i.value, data.ex, unit()); if (p) add(p.ex, { sets: p.sets > 1 ? p.sets : 3, reps: p.reps || 0, w: p.w, dur: p.dur, dist: p.dist }); closeMenuSoon(); } }); setTimeout(() => i.focus(), 30); return h("div", { class: "menu-row" }, i); })() },
      seen.length ? { header: "Done before" } : null,
      ...seen.map((x) => ({ label: x.name, icon: "dumbbell", run: () => add(x.name, x.last ? { reps: x.last.reps || 0, w: x.last.w || 0, dur: x.last.dur || 0, dist: x.last.dist || 0, sets: 3 } : {}) })),
    ].filter(Boolean), { anchor });
    if (!exList) { exList = h("datalist", { id: "fit-exlist" }); el.append(exList); exList.replaceChildren(...P.exerciseNames(data.ex).map((n) => h("option", { value: n }))); }
  }
  const closeMenuSoon = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  /** A tick's own menu: take a set back, log it with other numbers, change the line, drop it from this session. */
  function tickMenu(p, s, r, anchor) {
    const mine = F.onDay(data.sets, day).filter((x) => F.keyOf(x.ex) === F.keyOf(r.e.ex));
    const last = mine[mine.length - 1];
    menu(0, 0, [
      last ? { label: `Take back the last set (${setLabel(last)})`, icon: "undo", run: () => { data.sets.splice(data.sets.indexOf(last), 1); takeBackSet(last); if (s.done === day) s.done = null; save(); } } : null,
      { label: "Log a set with other numbers…", icon: "edit", run: async () => {
        const v = await askDialog(r.e.ex, [{ key: "reps", label: "Reps", value: String(r.e.reps || 0) }, { key: "w", label: `Weight (${r.e.unit || unit()})`, value: String(r.e.w || 0) }], { ok: "Log" });
        if (v) logPlanned({ ...r.e, reps: parseInt(v.reps, 10) || 0, w: parseFloat(v.w) || 0 });
      } },
      { label: "Change this line for the session…", icon: "layers", run: async () => {
        const v = await askDialog(r.e.ex, [{ key: "sets", label: "Sets", value: String(r.e.sets || 1) }, { key: "reps", label: "Reps", value: String(r.e.reps || 0) }, { key: "w", label: `Weight (${r.e.unit || unit()})`, value: String(r.e.w || 0) }], { ok: "Change" });
        if (v) { r.e.sets = Math.max(1, parseInt(v.sets, 10) || 1); r.e.reps = parseInt(v.reps, 10) || 0; r.e.w = parseFloat(v.w) || 0; save(); }
      } },
      "sep",
      { label: "Not in this session", icon: "x", run: () => { s.exercises.splice(s.exercises.indexOf(r.e), 1); save(); } },
    ].filter(Boolean), { anchor });
  }
  function planMenu(p, s, anchor) {
    const others = p.id === FREE ? [] : p.sessions.filter((x) => x !== s && !x.done).slice(0, 10);
    menu(0, 0, [
      s.exercises.length ? { label: "Save these lines as a block", icon: "save", run: () => saveBlock(s.exercises, s.name) } : null,
      p.id === FREE ? { label: "Clear the plan", icon: "trash", run: async () => { if (await confirmDialog("Clear today's plan?", "The sets you logged stay.", { ok: "Clear", safe: true })) { delete data.free[s.on]; save(); } } } : null,
      s.done ? { label: "Not done after all", icon: "undo", run: () => { s.done = null; save(); } } : { label: "Mark the session done", icon: "check", run: () => { finish(p, s); save(); } },
      others.length ? "sep" : null, others.length ? { header: "Do instead" } : null,
      ...others.map((x) => ({ label: `${p.sessions.indexOf(x) + 1}. ${x.name}`, icon: "book", run: () => goDo(p, x) })),
      p.id === FREE ? null : "sep",
      p.id === FREE ? null : { label: "Open the book", icon: "book", run: () => { tab = "program"; render(); } },
    ].filter(Boolean), { anchor });
  }

  // ── the book ──
  let picking = false;
  let viewing = null; // the program the book shows; `data.program` is the one enabled
  let previewTpl = null;
  const shown = () => data.programs.find((x) => x.id === viewing) || program();
  let focusLine = null;
  let exList = null;
  function renderProgram() {
    chips.replaceChildren();
    const p = shown();
    const pp = p ? P.programProgress(p) : null;
    const enabled = p && p.id === data.program;
    sub.textContent = p ? `${p.name} · ${pp.done} of ${pp.n} sessions done${enabled ? " · enabled" : " · not enabled"}` : "Pick a program to follow, or write your own";
    if (!p || picking) { body.replaceChildren(templatePicker()); return; }
    if (!exList) { exList = h("datalist", { id: "fit-exlist" }); el.append(exList); }
    exList.replaceChildren(...P.exerciseNames(data.ex).map((n) => h("option", { value: n })));
    const nav = h("div", { class: "fit-prognav" },
      data.programs.map((x) => { const q = P.programProgress(x); return h("button", { class: "chip-btn" + (x.id === p.id ? " is-on" : ""), title: `${q.done} of ${q.n} sessions done${x.id === data.program ? " · enabled: the Workout tab follows it" : " · click to view"}`, onclick: () => { viewing = x.id; render(); } }, icon(x.id === data.program ? "check" : "book"), x.name, h("span", { class: "fit-prognav-pct", text: `${q.pct}%` })); }),
      h("button", { class: "chip-btn", title: "Another program: a template or a blank one", onclick: () => { picking = true; render(); } }, icon("plus"), "New"));
    const head = h("section", { class: "card fit-book-head" },
      h("div", { class: "fit-book-title" },
        h("h2", { class: "fit-book-name", text: p.name, title: "Click to rename", onclick: (e) => inlineEdit(e.currentTarget, p.name, { onCommit: (v) => { p.name = v.trim(); save(); } }) }),
        h("button", { class: "icon-btn", title: "This program", onclick: (e) => programMenu(p, e.currentTarget) }, icon("more"))),
      p.note ? h("p", { class: "fit-book-note", text: p.note }) : null,
      h("div", { class: "fit-bar" + (pp.n && pp.done === pp.n ? " is-done" : "") }, h("div", { class: "fit-bar-fill", style: { width: pp.pct + "%" } })),
      h("div", { class: "fit-book-meta" }, h("span", { class: "chip is-quiet", text: `${pp.done} of ${pp.n} sessions · ${pp.pct}%` }),
        enabled ? h("span", { class: "chip is-today", title: "The Workout tab plans from this one" }, icon("check"), "Enabled", h("button", { class: "link-btn", onclick: () => { data.program = null; save(); } }, "disable"))
          : h("button", { class: "btn", title: "The Workout tab then plans from this one", onclick: () => { data.program = p.id; save(); } }, icon("play"), "Enable this program"),
        pp.next ? h("button", { class: "btn btn-primary", onclick: () => goDo(p, pp.next) }, icon("play"), `Do next: ${p.sessions.indexOf(pp.next) + 1}. ${pp.next.name}`) : pp.n ? h("span", { class: "chip is-today" }, icon("check"), "Complete") : null));
    const chapters = [];
    p.sessions.forEach((s, i) => {
      if (p.perWeek > 0 && i % p.perWeek === 0) chapters.push(h("div", { class: "fit-week", text: `Week ${Math.floor(i / p.perWeek) + 1}` }));
      chapters.push(chapter(p, s, i));
    });
    const book = h("div", { class: "fit-book" }, chapters,
      h("button", { class: "btn fit-add-session", onclick: () => { p.sessions.push(P.blankSession(`Session ${p.sessions.length + 1}`)); save(); } }, icon("plus"), "Add a session"));
    sortable(book, { item: ".fit-chapter, .fit-pex", onMove: (from, to, elm) => {
      if (elm.classList.contains("fit-chapter")) { p.sessions.splice(to, 0, p.sessions.splice(from, 1)[0]); save(); return; }
      const s = p.sessions.find((x) => x.id === elm.closest(".fit-chapter").dataset.id);
      if (s) { s.exercises.splice(to, 0, s.exercises.splice(from, 1)[0]); save(); }
    } });
    body.replaceChildren(h("div", { class: "fit-main" }, nav, head, book), h("div", { class: "fit-side" }, blocksCard(), library()));
    if (focusLine) { const i = body.querySelector(`[data-line="${focusLine}"] .fit-pex-name`); if (i) { i.focus(); i.select(); } focusLine = null; }
  }
  const handle = () => h("span", { class: "fit-handle", draggable: true, title: "Drag to reorder" }, icon("drag"));
  function chapter(p, s, i) {
    const pr = s.done ? null : P.sessionProgress(s, F.onDay(data.sets, dayKey()));
    const status = s.done ? h("span", { class: "chip is-today" }, icon("check"), fmtDay(parseDay(s.done))) : pr && pr.done ? h("span", { class: "chip is-quiet", text: `today · ${pr.pct}%` }) : s.on ? h("span", { class: "chip" + (s.on < dayKey() ? " is-overdue" : s.on === dayKey() ? " is-today" : " is-quiet"), title: "Click for another day", onclick: () => onDay(s) }, icon("calendar"), s.on === dayKey() ? "today" : fmtDay(parseDay(s.on))) : null;
    return h("section", { class: "fit-chapter card" + (s.done ? " is-done" : ""), dataset: { id: s.id } },
      h("header", { class: "fit-chapter-head" }, handle(), h("span", { class: "fit-chapter-n", text: String(i + 1) }),
        h("h3", { class: "fit-chapter-name", text: s.name, title: "Click to rename", onclick: (e) => inlineEdit(e.currentTarget, s.name, { onCommit: (v) => { s.name = v.trim(); save(); } }) }),
        status, h("span", { class: "fit-fill" }),
        !s.done ? h("button", { class: "link-btn", onclick: () => goDo(p, s) }, "Do today") : null,
        h("button", { class: "icon-btn", title: "More", onclick: (e) => sessionMenu(p, s, e.currentTarget) }, icon("more"))),
      s.note ? h("p", { class: "fit-chapter-note", text: s.note }) : null,
      h("div", { class: "fit-pex-list" }, s.exercises.map((e) => pex(p, s, e))),
      h("div", { class: "fit-add-row" },
        h("button", { class: "fit-add-ex", onclick: () => { const l = P.blankLine(); s.exercises.push(l); focusLine = l.id; save(); } }, icon("plus"), "Exercise"),
        h("button", { class: "fit-add-ex", onclick: (e) => blockMenu(s, e.currentTarget) }, icon("layers"), "Block")));
  }

  // ── blocks: groups of lines to drop into any session - a warm-up, a cardio finisher, an arms pump ──
  const copyLines = (lines) => lines.map((l) => ({ ...l, id: uuid() }));
  function blockMenu(s, anchor) {
    menu(0, 0, [
      { header: data.blocks.length ? "Add a block" : "No blocks yet" },
      ...data.blocks.map((b) => ({ label: `${b.name} · ${b.lines.map((l) => l.ex).join(", ")}`, icon: "layers", run: () => { s.exercises.push(...copyLines(b.lines)); save(); } })),
      "sep",
      s.exercises.length ? { label: "Save this session's lines as a block", icon: "save", run: () => saveBlock(s.exercises, s.name) } : null,
      { label: "New block…", icon: "plus", run: () => saveBlock([], "") },
    ].filter(Boolean), { anchor });
  }
  async function saveBlock(lines, name) {
    const r = await askDialog("A block", [{ key: "name", label: "Its name", value: name, placeholder: "Warm-up" }], { ok: "Save" });
    if (!r || !r.name.trim()) return;
    data.blocks.push({ id: uuid(), name: r.name.trim(), lines: copyLines(lines) });
    save();
  }
  function blocksCard() {
    const rows = data.blocks.map((b) => {
      const open = openBlock === b.id;
      return h("div", { class: "fit-block" + (open ? " is-open" : "") },
        h("div", { class: "fit-block-head" },
          h("button", { class: "fit-block-name", onclick: () => { openBlock = open ? null : b.id; render(); } }, icon(open ? "chevronDown" : "chevron"), h("span", { text: b.name }), h("span", { class: "fit-li-sub", text: ` · ${b.lines.length}` })),
          h("button", { class: "icon-btn", title: "More", onclick: (e) => menu(0, 0, [
            { label: "Rename", icon: "edit", run: async () => { const r = await askDialog("Rename", [{ key: "name", label: "Name", value: b.name }]); if (r && r.name.trim()) { b.name = r.name.trim(); save(); } } },
            { label: "Add to today's session", icon: "play", run: () => { const p = program(), t = p && planned(p); if (t) { t.exercises.push(...copyLines(b.lines)); save(); app.toast(`${b.name} added to ${t.name}`, { ms: 2000 }); } else app.toast("No session is up today"); } },
            "sep", { label: "Delete the block…", icon: "trash", run: async () => { if (!(await confirmDialog(`Delete ${b.name}?`, "This cannot be taken back.", { ok: "Delete", safe: true }))) return; data.blocks.splice(data.blocks.indexOf(b), 1); save(); } },
          ], { anchor: e.currentTarget }) }, icon("more"))),
        open ? [h("div", { class: "fit-pex-list" }, b.lines.map((l) => pex(null, b, l, { block: true }))),
          h("button", { class: "fit-add-ex", onclick: () => { const l = P.blankLine(); b.lines.push(l); focusLine = l.id; save(); } }, icon("plus"), "Exercise")] : null);
    });
    return h("section", { class: "card fit-blocks" },
      h("header", { class: "card-head" }, icon("layers"), h("h2", { text: "Blocks" }), h("button", { class: "link-btn", onclick: () => saveBlock([], "") }, "+ Block")),
      h("p", { class: "set-hint", text: "Building blocks: a few lines you drop into any session with “+ Block” - a warm-up, a cardio finisher, the arms you add now and then." }),
      rows.length ? h("div", { class: "fit-block-list" }, rows) : null);
  }
  let openBlock = null;
  function pex(p, s, e, { block = false } = {}) {
    const list = block ? s.lines : s.exercises;
    const info = P.exerciseInfo(e.ex);
    const kind = info ? info.kind : e.dist ? "cardio" : e.dur && !e.reps ? "time" : e.w ? "weight" : "reps";
    const name = h("input", { class: "fit-pex-name", list: "fit-exlist", value: e.ex, placeholder: "Exercise", spellcheck: false });
    name.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") name.blur(); });
    name.addEventListener("change", () => {
      e.ex = F.exerciseName(name.value, data.ex) || name.value.trim();
      const k = P.exerciseInfo(e.ex);
      if (k && k.kind === "time" && !e.dur) { e.dur = 30; e.reps = 0; }
      if (k && k.kind === "cardio" && !e.dist) { e.dist = 2; e.reps = 0; }
      save();
    });
    const n = (key, step, width, min = 0) => numField(e, key, step, null, { width, min });
    const cells = kind === "cardio"
      ? [h("span", { class: "fit-cell" }, n("dist", 0.5, "62px"), h("span", { class: "fit-unit", text: "km" })), h("span", { class: "fit-cell" }, durField(e, null), h("span", { class: "fit-unit", text: "min" }))]
      : kind === "time"
        ? [h("span", { class: "fit-cell" }, n("sets", 1, "48px", 1), h("span", { class: "fit-unit", text: "×" }), n("dur", 5, "56px"), h("span", { class: "fit-unit", text: "s" }))]
        : [h("span", { class: "fit-cell" }, n("sets", 1, "48px", 1), h("span", { class: "fit-unit", text: "×" }), n("reps", 1, "52px"), h("span", { class: "fit-unit", text: "reps" })),
          kind === "weight" || e.w ? h("span", { class: "fit-cell" }, h("span", { class: "fit-unit", text: "@" }), n("w", 2.5, "62px"), h("span", { class: "fit-unit", text: e.unit || unit() })) : null];
    return h("div", { class: "fit-pex", dataset: { line: e.id }, title: info ? info.cue : "" }, block ? null : handle(), name, ...cells, h("span", { class: "fit-fill" }),
      block ? null : h("button", { class: "icon-btn", title: "More", onclick: (ev) => lineMenu(p, s, e, ev.currentTarget) }, icon("more")),
      h("button", { class: "icon-btn fit-x", title: "Remove", onclick: () => { list.splice(list.indexOf(e), 1); save(); } }, icon("x")));
  }
  function lineMenu(p, s, e, anchor) {
    const info = P.exerciseInfo(e.ex);
    const later = p.sessions.slice(p.sessions.indexOf(s) + 1);
    const same = (l) => F.keyOf(l.ex) === F.keyOf(e.ex);
    menu(0, 0, [
      info ? { header: info.cue } : null,
      { label: "Same numbers in every later session", icon: "layers", run: () => { let n = 0; for (const x of later) for (const l of x.exercises) if (same(l)) { Object.assign(l, { sets: e.sets, reps: e.reps, w: e.w, unit: e.unit, dur: e.dur, dist: e.dist }); n++; } app.toast(`${n} line${n === 1 ? "" : "s"} updated`, { ms: 2000 }); save(); } },
      { label: "Add to every later session that lacks it", icon: "plus", run: () => { for (const x of later) if (!x.exercises.some(same)) x.exercises.push({ ...e, id: uuid() }); save(); } },
      "sep",
      { label: "Remove", icon: "trash", run: () => { s.exercises.splice(s.exercises.indexOf(e), 1); save(); } },
    ].filter(Boolean), { anchor });
  }
  function sessionMenu(p, s, anchor) {
    const i = p.sessions.indexOf(s);
    menu(0, 0, [
      !s.done ? { label: "Do today", icon: "play", run: () => goDo(p, s) } : null,
      s.done ? { label: "Not done after all", icon: "undo", run: () => { s.done = null; save(); } } : { label: "Mark done", icon: "check", run: () => { s.done = dayKey(); save(); } },
      { label: s.on ? `On a day: ${fmtDay(parseDay(s.on))}` : "On a day…", icon: "calendar", run: () => onDay(s) },
      s.on ? { label: "Off the calendar", icon: "x", run: () => { delete s.on; save(); } } : null,
      { label: "A note under the title", icon: "edit", run: async () => { const r = await askDialog("Session note", [{ key: "note", label: "Shown under the title, and on the day", value: s.note }]); if (r) { s.note = r.note; save(); } } },
      { label: "Duplicate", icon: "layers", run: () => { p.sessions.splice(i + 1, 0, { ...s, id: uuid(), done: null, exercises: s.exercises.map((e) => ({ ...e, id: uuid() })) }); save(); } },
      data.programs.length > 1 ? { label: "Copy to another program", icon: "book", sub: data.programs.filter((x) => x.id !== p.id).map((x) => ({ label: x.name, icon: "book", run: () => { x.sessions.push({ ...s, id: uuid(), done: null, on: undefined, exercises: copyLines(s.exercises) }); app.toast(`Copied to ${x.name}`, { ms: 2000 }); save(); } })) } : null,
      "sep",
      { label: "Remove this session…", icon: "trash", run: async () => { if (!(await confirmDialog(`Remove ${s.name}?`, "This cannot be taken back.", { ok: "Remove", safe: true }))) return; p.sessions.splice(p.sessions.indexOf(s), 1); save(); } },
    ].filter(Boolean), { anchor });
  }
  function programMenu(p, anchor) {
    const others = data.programs.filter((x) => x.id !== p.id);
    menu(0, 0, [
      p.id === data.program ? { label: "Disable - the Workout tab follows none", icon: "x", run: () => { data.program = null; save(); } } : { label: "Enable this program", icon: "play", run: () => { data.program = p.id; save(); } },
      { label: "Description", icon: "edit", run: async () => { const r = await askDialog("About this program", [{ key: "note", label: "A line or two under the title", value: p.note }]); if (r) { p.note = r.note; save(); } } },
      { label: `Sessions per week: ${p.perWeek}`, icon: "calendar", run: async () => { const r = await askDialog("Sessions per week", [{ key: "n", label: "How many sessions make a week in the book", value: String(p.perWeek) }]); const n = r && parseInt(r.n, 10); if (n > 0) { p.perWeek = n; save(); } } },
      { label: "Put the sessions on days…", icon: "calendar", run: () => schedule(p) },
      p.sessions.some((s) => s.on) ? { label: "Take them off the days", icon: "x", run: () => { for (const s of p.sessions) delete s.on; save(); } } : null,
      { label: "Reset progress…", icon: "undo", run: async () => { if (!(await confirmDialog("Reset progress?", "Every session of this program counts as not done again.", { ok: "Reset", safe: true }))) return; for (const s of p.sessions) s.done = null; delete p.pick; save(); } },
      "sep", { header: "Programs" },
      ...others.map((x) => ({ label: `View ${x.name}`, icon: "book", run: () => { viewing = x.id; render(); } })),
      others.length ? { label: "Take sessions from…", icon: "layers", sub: others.map((x) => ({ label: `${x.name} · ${x.sessions.length}`, icon: "book", run: () => { p.sessions.push(...x.sessions.map((s) => ({ ...s, id: uuid(), done: null, exercises: copyLines(s.exercises) }))); save(); } })) } : null,
      { label: "New from a template…", icon: "plus", run: () => { picking = true; render(); } },
      { label: "New blank program", icon: "filePlus", run: () => adopt(P.blankProgram()) },
      "sep",
      { label: "Delete this program", icon: "trash", run: async () => { if (await confirmDialog("Delete this program?", `“${p.name}” and its book go; the sets you logged stay.`, { ok: "Delete", safe: true })) { data.programs.splice(data.programs.indexOf(p), 1); data.program = data.programs.length ? data.programs[0].id : null; save(); } } },
    ].filter(Boolean), { anchor });
  }
  function adopt(p) { data.programs.push(p); if (!data.program) data.program = p.id; viewing = p.id; picking = false; save(); }
  /** One session put on a day, by a date picker under the chip or menu. */
  async function onDay(s) {
    const r = await askDialog("On a day", [{ key: "on", label: "The day (YYYY-MM-DD)", value: s.on || dayKey() }], { ok: "Put it there" });
    if (!r) return;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(r.on.trim()) ? r.on.trim() : "";
    if (d) s.on = d; else delete s.on;
    save();
  }
  /** Every undone session laid onto days: from a start, on chosen weekdays, so many a day. */
  async function schedule(p) {
    const r = await askDialog("Put the sessions on days", [
      { key: "from", label: "Starting on (YYYY-MM-DD)", value: dayKey() },
      { key: "days", label: "Weekdays, e.g. mon wed fri - or every day", value: p.perWeek >= 7 ? "every day" : ["mon wed fri", "mon tue thu fri", "mon tue wed thu fri", "mon tue wed thu fri sat"][Math.min(3, Math.max(0, p.perWeek - 3))] || "mon wed fri" },
      { key: "per", label: "Sessions a day", value: "1" },
    ], { ok: "Lay them out", text: "Undone sessions are laid out in their order; done ones keep their dates. Every session's day can still be changed on its own." });
    if (!r) return;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(r.from.trim()) ? r.from.trim() : dayKey();
    const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const wd = /every|daily|all/i.test(r.days) ? [0, 1, 2, 3, 4, 5, 6] : names.map((n, i) => (new RegExp("\\b" + n, "i").test(r.days) ? i : -1)).filter((i) => i >= 0);
    const per = Math.max(1, parseInt(r.per, 10) || 1);
    if (!wd.length) { app.toast("No weekday understood - try “mon wed fri”"); return; }
    let d = parseDay(from), n = 0, put = 0;
    for (const s of p.sessions) {
      if (s.done) continue;
      while (!wd.includes(d.getDay())) d = addDays(d, 1);
      s.on = dayKey(d);
      put++;
      if (++n >= per) { n = 0; d = addDays(d, 1); }
    }
    app.toast(`${put} session${put === 1 ? "" : "s"} laid out - the Calendar shows them too`, { ms: 3500 });
    save();
  }
  function templatePicker() {
    const p = program();
    return h("div", { class: "fit-templates" },
      h("div", { class: "fit-templates-head" }, h("h2", { text: "Pick a program" }),
        h("p", { class: "set-hint", text: "A template unfolds into a book of sessions - reorder them by their handles, rename them, edit every line. Weights are yours to fill in; the next session waits at the top of Workout." }),
        p ? h("button", { class: "link-btn", onclick: () => { picking = false; render(); } }, "Back to the book") : null),
      h("div", { class: "fit-tpl-grid" },
        P.TEMPLATES.map((t) => {
          const open = previewTpl === t.id;
          const week = open ? P.buildProgram(t).sessions.slice(0, t.perWeek) : [];
          return h("div", { class: "card fit-tpl" + (open ? " is-open" : "") },
            h("div", { class: "fit-tpl-name", text: t.name }),
            h("div", { class: "fit-tpl-meta", text: `${t.level} · ${t.weeks} week${t.weeks === 1 ? "" : "s"} · ${t.perWeek} a week` }),
            h("div", { class: "fit-tpl-blurb", text: t.blurb }),
            open ? h("div", { class: "fit-tpl-week" }, week.map((s, i) => h("div", { class: "fit-tpl-session" }, h("div", { class: "fit-li-name", text: `${i + 1}. ${s.name}` }), s.exercises.map((e) => h("div", { class: "fit-li-sub", text: `${e.ex} — ${P.lineLabel(e)}` })))), t.weekly ? h("div", { class: "set-hint", text: `Each later week adds${t.weekly.reps ? ` ${t.weekly.reps} reps` : ""}${t.weekly.dur ? ` ${t.weekly.dur} s` : ""}${t.weekly.dist ? ` ${t.weekly.dist} km` : ""}.` }) : null)
              : h("div", { class: "fit-tpl-days" }, t.days.map((d) => h("span", { class: "chip is-quiet", text: `${d.name}: ${d.lines.map((l) => l[0]).join(", ")}` }))),
            h("div", { class: "fit-tpl-btns" },
              h("button", { class: "link-btn", onclick: () => { previewTpl = open ? null : t.id; render(); } }, open ? "Less" : "Look through week 1"),
              h("button", { class: "btn btn-primary", onclick: () => adopt(P.buildProgram(t)) }, icon("plus"), "Take it")));
        }),
        h("button", { class: "card fit-tpl is-blank", onclick: () => adopt(P.blankProgram()) }, h("div", { class: "fit-tpl-name", text: "Blank" }), h("div", { class: "fit-tpl-blurb", text: "Start from nothing and write every session yourself." }))));
  }
  function library() {
    const groups = new Map(P.GROUPS.map((g) => [g, []]));
    for (const e of P.EXERCISES) groups.get(e.group).push(e);
    return h("section", { class: "card fit-lib" },
      h("header", { class: "card-head" }, icon("list"), h("h2", { text: "Exercises" }), h("span", { class: "chip is-quiet", text: String(P.EXERCISES.length) })),
      h("p", { class: "set-hint", text: "The library behind the pickers, with a cue each. Anything else you type is welcome too." }),
      [...groups].map(([g, list]) => h("details", { class: "fit-lib-group" }, h("summary", { text: `${g} · ${list.length}` }),
        h("div", { class: "fit-lib-list" }, list.map((e) => h("div", { class: "fit-lib-row" }, h("span", { class: "fit-li-name", text: e.name }), h("span", { class: "fit-li-sub", text: e.cue })))))));
  }
  const stat = (n, label) => h("div", { class: "fit-stat" }, h("div", { class: "fit-stat-n", text: n }), h("div", { class: "fit-stat-l", text: label }));

  function setMenu(s, anchor) {
    menu(0, 0, [
      { label: "Same again", icon: "plus", run: () => addSets({ ex: s.ex, sets: 1, reps: s.reps, w: s.w, unit: s.unit, dist: s.dist, dunit: s.dunit, dur: s.dur }, { quiet: true }) },
      { label: "Move to yesterday", icon: "back", run: () => { s.t = dayKey(addDays(parseDay(day), -1)) + s.t.slice(10); save(); } },
      { label: "Move to today", icon: "sun", run: () => { s.t = dayKey() + s.t.slice(10); save(); } },
      "sep",
      { label: "Remove", icon: "trash", run: async () => { if (!(await confirmDialog("Remove this set?", "It leaves the log, and its XP with it.", { ok: "Remove", safe: true }))) return; const i = data.sets.indexOf(s); if (i >= 0) { data.sets.splice(i, 1); takeBackSet(s); } save(); } },
    ], { anchor });
  }

  // ── food ──
  function renderFood() {
    const today = F.onDay(data.food, day).sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const tot = F.foodTotals(today);
    const goal = Math.max(0, +app.settings.foodKcalGoal || 0);
    sub.textContent = today.length ? `${tot.kcal.toLocaleString()} kcal${goal ? ` of ${goal.toLocaleString()}` : ""}${tot.prot ? ` · ${tot.prot} g protein` : ""}` : "What you ate: “2 eggs 150 kcal 12 g protein”, “banana” - a food seen before knows its numbers";
    const seen = Object.entries(data.foods).sort((a, b) => String(b[1].at || "").localeCompare(String(a[1].at || ""))).slice(0, 14);
    chips.replaceChildren(...seen.map(([k, f]) => {
      const c = h("button", { class: "chip-btn fit-chip", title: `Add again${f.kcal ? `: ${f.kcal} kcal` : ""}` }, icon("plus"), f.text);
      c.onclick = () => addFood({ text: f.text, kcal: f.kcal || 0, prot: f.prot || 0 });
      c.oncontextmenu = (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [{ label: `Forget “${f.text}”`, icon: "trash", run: () => { delete data.foods[k]; save(); } }]); };
      return c;
    }));
    const pct = goal ? Math.min(100, Math.round((tot.kcal / goal) * 100)) : 0;
    const bar = goal ? h("div", { class: "fit-bar" + (tot.kcal > goal ? " is-over" : "") }, h("div", { class: "fit-bar-fill", style: { width: pct + "%" } })) : null;
    const rows = today.map((e) => {
      const txt = h("input", { class: "fit-text", value: e.text, spellcheck: false });
      txt.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") txt.blur(); });
      txt.addEventListener("change", () => { e.text = txt.value.trim() || e.text; persist(); });
      return h("div", { class: "fit-row" }, timeField(e), txt,
        h("span", { class: "fit-cell" }, numField(e, "kcal", 10, render, { width: "70px" }), h("span", { class: "fit-unit", text: "kcal" })),
        h("span", { class: "fit-cell" }, numField(e, "prot", 1, render, { width: "56px" }), h("span", { class: "fit-unit", text: "g protein" })),
        h("span", { class: "fit-fill" }), remove(data.food, e, "entry"));
    });
    const week = [];
    for (let i = 1; i <= 7; i++) { const d = dayKey(addDays(parseDay(day), -i)); const t = F.foodTotals(F.onDay(data.food, d)); if (t.n) week.push([d, t]); }
    body.replaceChildren(
      h("div", { class: "fit-main" },
        h("section", { class: "card" }, h("header", { class: "card-head" }, icon("apple"), h("h2", { text: fmtDay(parseDay(day), { weekday: "long", day: "numeric", month: "long" }) }),
          h("span", { class: "chip" + (goal && tot.kcal > goal ? " is-overdue" : " is-quiet"), text: `${tot.kcal.toLocaleString()} kcal` }), tot.prot ? h("span", { class: "chip is-quiet", text: `${tot.prot} g protein` }) : null),
          bar, rows.length ? h("div", { class: "fit-rows" }, rows) : h("div", { class: "card-empty", text: "Nothing logged. Type a meal above." }))),
      h("div", { class: "fit-side" }, week.length ? h("section", { class: "card" }, h("header", { class: "card-head" }, icon("clock"), h("h2", { text: "The days before" })),
        h("div", { class: "fit-list" }, week.map(([d, t]) => h("button", { class: "fit-li is-link", onclick: () => { day = d; render(); } }, h("span", { class: "fit-li-name", text: fmtDay(parseDay(d)) }), h("span", { class: "fit-li-sub", text: `${t.kcal.toLocaleString()} kcal · ${t.n} entries${t.prot ? ` · ${t.prot} g protein` : ""}` }))))) : null));
  }

  // ── fasting ──
  let timerEl = null;
  function renderFasting() {
    const goal = Math.max(1, +app.settings.fastHours || 16);
    const open = F.openFast(data.fasts);
    const st = F.fastStats(data.fasts, goal, dayKey());
    sub.textContent = open ? `Fasting since ${fmtDay(new Date(open.start), { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : st.n ? `${st.n} fasts · ${F.fmtHours(st.avg)} on average · longest ${F.fmtHours(st.longest)}` : `A ${goal}-hour window by default - change it in Settings › Workout`;
    chips.replaceChildren();
    const when = (f, key) => {
      const i = h("input", { type: "datetime-local", class: "fit-time is-wide", value: String(f[key] || "").slice(0, 16) });
      i.addEventListener("keydown", (ev) => ev.stopPropagation());
      i.addEventListener("change", () => { if (i.value) { f[key] = i.value + ":00"; save(); } });
      return i;
    };
    timerEl = h("div", { class: "fit-timer" });
    const paint = () => {
      if (!open) return;
      const hrs = F.fastHours(open);
      const pct = Math.min(100, (hrs / goal) * 100);
      timerEl.replaceChildren(
        h("div", { class: "fit-timer-n", text: F.fmtHours(hrs) }),
        h("div", { class: "fit-timer-sub", text: hrs >= goal ? `Past your ${goal} h - well done` : `${F.fmtHours(goal - hrs)} to go of ${goal} h` }),
        h("div", { class: "fit-bar" + (hrs >= goal ? " is-done" : "") }, h("div", { class: "fit-bar-fill", style: { width: pct + "%" } })));
    };
    paint();
    const big = h("section", { class: "card fit-fast" },
      h("header", { class: "card-head" }, icon("clock"), h("h2", { text: open ? "Fasting now" : "Not fasting" })),
      open ? [timerEl, h("div", { class: "fit-row" }, h("span", { class: "fit-unit", text: "Started" }), when(open, "start"), h("span", { class: "fit-fill" }),
        h("button", { class: "btn btn-primary", onclick: () => { open.end = localIso().slice(0, 19); if (F.fastHours(open) >= goal) app.stats.award(XP.fastDone); app.sound("done"); save(); } }, icon("check"), "End the fast"))]
        : h("div", { class: "fit-row" }, h("button", { class: "btn btn-primary", onclick: () => { data.fasts.push({ id: uuid(), start: localIso().slice(0, 19), end: null }); save(); } }, icon("play"), "Start a fast"),
          h("span", { class: "set-hint", text: `Ends when you say so; ${goal} h is the goal.` })));
    const past = data.fasts.filter((f) => f.end).sort((a, b) => String(b.start).localeCompare(String(a.start))).slice(0, 20);
    body.replaceChildren(
      h("div", { class: "fit-main" }, big,
        past.length ? h("section", { class: "card" }, h("header", { class: "card-head" }, icon("list"), h("h2", { text: "Past fasts" })),
          h("div", { class: "fit-rows" }, past.map((f) => h("div", { class: "fit-row" }, when(f, "start"), h("span", { class: "fit-unit", text: "to" }), when(f, "end"),
            h("span", { class: "chip" + (F.fastHours(f) >= goal ? " is-today" : " is-quiet"), text: F.fmtHours(F.fastHours(f)) }), h("span", { class: "fit-fill" }), remove(data.fasts, f, "fast"))))) : null),
      h("div", { class: "fit-side" }, h("section", { class: "card" }, h("header", { class: "card-head" }, icon("chart"), h("h2", { text: "So far" })),
        h("div", { class: "fit-stats" }, stat(String(st.n), "fasts"), stat(st.n ? F.fmtHours(st.avg) : "–", "average"), stat(st.n ? F.fmtHours(st.longest) : "–", "longest"), stat(String(st.streak), `day${st.streak === 1 ? "" : "s"} ≥ ${goal} h`)))));
    return paint;
  }
  let repaintTimer = null;
  setInterval(() => { if (!el.hidden && tab === "fasting" && repaintTimer) repaintTimer(); }, 30000);

  // ── render ──
  const placeholder = () => { input.placeholder = tab === "workout" ? "10 pushups · bench 60 kg x 5 · run 5 km 28 min" : "2 eggs 150 kcal · banana · coffee"; };
  function render() {
    if (el.hidden) { stale = true; return; }
    if (!data) return;
    stale = false;
    for (const b of tabs.children) b.classList.toggle("is-active", b.dataset.id === tab);
    dayLabel.textContent = day === dayKey() ? "Today" : fmtDay(parseDay(day), { weekday: "short", day: "numeric", month: "short" });
    qa.hidden = tab === "fasting" || tab === "program";
    restBar.hidden = tab !== "workout";
    paintRest();
    chips.hidden = tab === "fasting" || tab === "program";
    placeholder();
    repaintTimer = null;
    if (tab === "workout") renderWorkout();
    else if (tab === "program") renderProgram();
    else if (tab === "food") renderFood();
    else repaintTimer = renderFasting();
  }

  let stale = true;
  let loading = null;
  function load() {
    if (data) return Promise.resolve();
    if (!loading) loading = app.host.fitLoad().catch(() => ({})).then((d) => {
      data = d && typeof d === "object" ? d : {};
      data.version = 1;
      for (const k of ["sets", "food", "fasts"]) if (!Array.isArray(data[k])) data[k] = [];
      for (const k of ["ex", "foods"]) if (!data[k] || typeof data[k] !== "object") data[k] = {};
      if (!Array.isArray(data.programs)) data.programs = [];
      if (!data.free || typeof data.free !== "object") data.free = {};
      if (!Array.isArray(data.blocks)) data.blocks = [];
      if (!data.programs.some((p) => p && p.id === data.program)) data.program = data.programs.length ? data.programs[0].id : null;
      for (const p of data.programs) { if (!Array.isArray(p.sessions)) p.sessions = []; for (const s of p.sessions) if (!Array.isArray(s.exercises)) s.exercises = []; }
      render();
    });
    return loading;
  }
  app.bus.on("settings", (k) => { if (["fitUnit", "foodKcalGoal", "fastHours"].includes(k)) render(); });
  // the log changed elsewhere (a break ticked on the Timer): this copy is old, read it again
  app.bus.on("fit", (d) => { if (d !== data && data) { data = null; loading = null; stale = true; if (el.offsetParent) load(); } });

  return {
    show(opts = {}) {
      if (opts.tab && TABS.some(([id]) => id === opts.tab)) tab = opts.tab;
      if (opts.day) { day = opts.day; stale = true; }
      load().then(() => { if (stale || opts.tab) render(); });
    },
  };
}
