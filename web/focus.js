// Pomodoro timer and the Focus view (timer, level, focus history).
// The timer is wall-clock based (an end timestamp, not a countdown of ticks),
// so a throttled or sleeping webview can never make it drift.

import { h, dayKey, addDays, clamp } from "./util.js";
import { icon } from "./icons.js";
import { fmtDuration, rankOf } from "./stats.js";
import { levelsSection } from "./levels.js";

export function createPomodoro(app) {
  const S = app.stats;
  let phase = "work";
  let running = false;
  let endsAt = 0;
  let remaining = S.data.pomo_work_mins * 60000;
  let lastAcc = 0;
  let timer = 0;
  let lastSec = -1;
  let everStarted = false;
  const audio = {};

  const full = () => clamp(phase === "work" ? S.data.pomo_work_mins : S.data.pomo_break_mins, 1, 180) * 60000;

  // The timer outlives a restart: its state is saved on start, pause, reset,
  // skip and phase change - never per tick - and picked up by restore().
  function persist() {
    if (!app.setSetting) return;
    app.setSetting("pomoState", running
      ? { phase, running: true, endsAt, everStarted }
      : { phase, running: false, remaining, everStarted });
  }

  function sound(name, volume) {
    if (audio[name] === null) return; // not there (the published source has no sound files): stay silent
    try {
      const a = audio[name] || (audio[name] = new Audio("sounds/" + name));
      a.onerror = () => { audio[name] = null; };
      a.volume = clamp(Number(volume) || 0, 0, 1);
      a.currentTime = 0;
      a.play().catch(() => {});
    } catch {}
  }

  // A gap this long between two ticks is not work: the computer slept or was switched off with Leonote open
  // (a hidden window still ticks at least once a minute)
  const AWAY = 5 * 60000;
  /** Banks the focus since the last tick. Returns false when the gap was the computer away - then the timer is
      paused at the moment it went away, and the gap is not counted. */
  function accumulate(now) {
    if (!lastAcc) return true;
    if (now - lastAcc > AWAY) {
      const away = now - lastAcc;
      remaining = Math.max(0, endsAt - lastAcc);
      running = false;
      clearTimeout(timer);
      lastAcc = 0;
      S.flush();
      persist();
      app.bus.emit("pomo");
      app.toast(`Timer paused - the computer was away for ${fmtDuration(Math.round(away / 1000))}, which is not counted`, { ms: 8000, action: { label: "Resume", run: () => api.start() } });
      return false;
    }
    const secs = Math.floor((now - lastAcc) / 1000);
    if (secs > 0) {
      S.addFocus(phase, secs);
      lastAcc += secs * 1000;
    }
    return true;
  }

  function next(now) {
    phase = phase === "work" ? "break" : "work";
    remaining = full();
    endsAt = now + remaining;
    lastAcc = running ? now : 0;
    if (S.data.pomo_alert_enabled) sound(phase === "work" ? "workstart.wav" : "breakstart.wav", S.data.pomo_alert_volume);
    if (S.data.pomo_notify_enabled !== false) app.toast(phase === "work" ? "Break over - back to focus" : `Focus block done - ${S.data.pomo_break_mins} min break`, { ms: 3500 });
    persist();
    app.bus.emit("pomo");
    if (phase === "break" && app.deskBreaks) app.deskBreaks.start(); // what to do with the break (deskbreak.js)
    if (phase === "work" && app.deskBreaks) app.deskBreaks.backToWork(); // said, when breaks speak
  }

  // Once a second, on the second: each run schedules the next for the moment
  // the remaining time next crosses a whole second, so there is one wake-up a
  // second and the tick lands where the clock changes.
  function loop() {
    const now = Date.now();
    if (lastAcc && now - lastAcc > AWAY) { accumulate(now); return; } // away: paused and said (accumulate)
    // a tick that came late (a hidden window ticks about once a minute): each phase is counted only up to its own
    // end, and the next one starts then - not at the late tick, which made the times and the cycle drift
    while (running && now >= endsAt) { if (!accumulate(endsAt)) return; next(endsAt); }
    if (!accumulate(now)) return;
    if (app.deskBreaks) app.deskBreaks.tick(now, phase, running);
    const sec = Math.ceil((endsAt - now) / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      if (S.data.pomo_tick_enabled && !(phase === "break" && S.data.pomo_no_tick_break))
        sound(`clockticksound${1 + Math.floor(Math.random() * 16)}.wav`, S.data.pomo_tick_volume);
      app.bus.emit("pomo");
    }
    if (running) timer = setTimeout(loop, Math.max(20, ((endsAt - Date.now()) % 1000 + 1000) % 1000 + 5));
  }

  const api = {
    get running() { return running; },
    get phase() { return phase; },
    get touched() { return running || remaining !== full() || phase !== "work"; },
    remainingMs: () => (running ? Math.max(0, endsAt - Date.now()) : remaining),
    fullMs: full,

    start() {
      if (running) return;
      // the first start, and every resume after a pause, says so (softer than a block's change)
      if (S.data.pomo_alert_enabled) sound("workstart.wav", (Number(S.data.pomo_alert_volume) || 0) * (everStarted ? 0.5 : 1));
      everStarted = true;
      running = true;
      const now = Date.now();
      endsAt = now + remaining;
      lastAcc = now;
      loop();
      persist();
      app.bus.emit("pomo");
    },

    pause(quiet = false) {
      if (!running) return;
      const now = Date.now();
      if (!accumulate(now)) return;
      if (!quiet && S.data.pomo_alert_enabled) sound("breakstart.wav", (Number(S.data.pomo_alert_volume) || 0) * 0.5);
      remaining = Math.max(0, endsAt - now);
      running = false;
      clearTimeout(timer);
      lastAcc = 0;
      S.flush();
      persist();
      app.bus.emit("pomo");
    },

    toggle() { running ? api.pause() : api.start(); },

    /**
     * The app is quitting: bank the focus time so far, but leave the saved
     * state saying "running" so the next session picks the block back up.
     * (pause() would record it as stopped.)
     */
    suspend() {
      if (!running) return;
      accumulate(Date.now());
      clearTimeout(timer);
      S.flush();
    },

    reset() {
      // a block's time is not lost to a slip: Undo puts it back as it was
      const was = api.touched && { phase, remaining: api.remainingMs(), running, everStarted };
      api.pause(true);
      phase = "work";
      remaining = full();
      everStarted = false;
      persist();
      app.bus.emit("pomo");
      if (was) app.toast("Timer reset", { ms: 5000, action: { label: "Undo", run: () => {
        if (running) return;
        phase = was.phase; remaining = was.remaining; everStarted = was.everStarted;
        persist(); app.bus.emit("pomo");
        if (was.running) api.start();
      } } });
    },

    /** A few more minutes on the block that is running (or waiting). */
    extend(mins) {
      const ms = mins * 60000;
      if (running) endsAt += ms; else remaining += ms;
      lastSec = -1;
      persist();
      app.bus.emit("pomo");
    },

    skip() {
      const now = Date.now();
      if (running) accumulate(now);
      next(now);
      if (!running) { remaining = full(); persist(); }
    },

    /**
     * Pick up where the last session left off. A block still in progress
     * keeps running on the wall clock (the closed stretch is not counted as
     * focus time); one that ended while Leonote was closed carries on into
     * whichever block the clock has reached; a paused timer comes back paused.
     */
    restore() {
      const was = app.settings.pomoState;
      if (!was || (was.phase !== "work" && was.phase !== "break")) return;
      phase = was.phase;
      everStarted = !!was.everStarted;
      const now = Date.now();
      if (was.running && was.endsAt > now) {
        remaining = Math.min(was.endsAt - now, full());
        api.start();
        return;
      }
      if (was.running) {
        // It was ticking when Leonote closed (a restart, a shutdown), so it
        // is ticking now: the blocks went on by the wall clock, and we join
        // the one that would be running at this moment. It used to come back
        // paused, which read as "the timer died with the restart".
        const len = (ph) => clamp(ph === "work" ? S.data.pomo_work_mins : S.data.pomo_break_mins, 1, 180) * 60000;
        let over = (now - was.endsAt) % (len("work") + len("break"));
        phase = phase === "work" ? "break" : "work";
        while (over >= len(phase)) { over -= len(phase); phase = phase === "work" ? "break" : "work"; }
        remaining = len(phase) - over;
        api.start();
        app.toast(`The timer kept going while Leonote was closed - ${phase === "work" ? "focus" : "break"} block, ${api.label()} left`, { ms: 4500 });
        return;
      } else if (was.remaining > 0) {
        remaining = Math.min(was.remaining, full());
      }
      app.bus.emit("pomo");
    },

    /** Durations changed in settings: an idle, untouched timer picks them up. */
    refresh() {
      if (!running) { remaining = full(); app.bus.emit("pomo"); }
    },

    label() {
      const ms = api.remainingMs();
      const s = Math.ceil(ms / 1000);
      return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    },

    badge: () => (api.touched ? api.label() : ""),
  };
  return api;
}

export function mountTimer(app, el) {
  const P = app.pomo;
  const S = app.stats;
  const R = 108;
  const C = 2 * Math.PI * R;

  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("viewBox", "0 0 260 260");
  ring.classList.add("pomo-ring");
  ring.innerHTML = `<circle cx="130" cy="130" r="${R}" class="pomo-track"/><circle cx="130" cy="130" r="${R}" class="pomo-arc" stroke-dasharray="${C}" stroke-dashoffset="0" transform="rotate(-90 130 130)"/>`;
  const arc = ring.querySelector(".pomo-arc");
  const time = h("div", { class: "pomo-time" });
  const phaseEl = h("div", { class: "pomo-phase" });
  const playBtn = h("button", { class: "btn btn-primary pomo-play", onclick: () => P.toggle() });
  const face = h("div", { class: "pomo-face" }, ring, h("div", { class: "pomo-center" }, phaseEl, time));

  // Hold a step button and it runs away with you: one a beat at first, then
  // faster and in fives and tens, so 25 -> 90 minutes is a hold, not 65 taps.
  // Or type the number straight into the field: "90", "1h30", "1:30".
  const stepper = (key, label, min, max) => {
    const val = h("input", { class: "step-val", inputmode: "numeric", spellcheck: false, size: 3, title: "Type the minutes, or hold - and + " });
    const paint = () => { if (document.activeElement !== val) val.value = String(S.data[key]); };
    const put = (n) => { S.set(key, clamp(Math.round(n), min, max)); paint(); P.refresh(); };
    const set = (d) => put(S.data[key] + d);
    paint();

    const commit = () => {
      const m = mins(val.value);
      if (m !== null) put(m);
      val.value = String(S.data[key]); // show what it settled on, tidied up
    };
    val.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { commit(); val.blur(); }
      else if (e.key === "Escape") { paint(); val.blur(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); set(e.shiftKey ? 5 : 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); set(e.shiftKey ? -5 : -1); }
    });
    val.addEventListener("blur", commit);
    val.addEventListener("focus", () => val.select());

    const stepBtn = (dir, title, ic) => {
      const b = h("button", { class: "icon-btn", title: title + " (hold to run)" }, icon(ic));
      let timer = 0;
      let held = 0;
      const stop = () => { clearTimeout(timer); timer = 0; held = 0; };
      const tick = () => {
        held++;
        // after a second it moves in fives, after three in tens
        const size = held > 26 ? 10 : held > 9 ? 5 : 1;
        const wait = held > 26 ? 45 : held > 9 ? 60 : held > 4 ? 90 : 130;
        set(dir * size);
        timer = setTimeout(tick, wait);
      };
      b.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        set(dir);
        timer = setTimeout(tick, 420);
        try { b.setPointerCapture(e.pointerId); } catch {}
      });
      for (const ev of ["pointerup", "pointercancel", "pointerleave", "blur"]) b.addEventListener(ev, stop);
      return b;
    };

    return h("div", { class: "stepper" }, h("span", { class: "step-label", text: label }),
      stepBtn(-1, "Less", "minus"), val,
      stepBtn(1, "More", "plus"), h("span", { class: "step-unit", text: "min" }));
  };

  /** "90", "90m", "1h", "1h30", "1:30", "1.5h" -> minutes, or null. */
  function mins(text) {
    const t = String(text).trim().toLowerCase().replace(/\s+/g, "");
    if (!t) return null;
    let m = t.match(/^(\d+)[:h](\d{1,2})m?$/);
    if (m) return +m[1] * 60 + +m[2];
    m = t.match(/^(\d+(?:[.,]\d+)?)h$/);
    if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 60);
    m = t.match(/^(\d+(?:[.,]\d+)?)m?$/);
    if (m) return Math.round(parseFloat(m[1].replace(",", ".")));
    return null;
  }
  const toggleRow = (key, label) => {
    const b = h("button", { class: "switch" });
    const paint = () => b.classList.toggle("is-on", !!S.data[key]);
    b.addEventListener("click", () => { S.set(key, !S.data[key]); paint(); });
    paint();
    return h("label", { class: "pomo-opt" }, b, label);
  };

  const levelsHost = h("div", { class: "lv-host" });
  const drawLevels = levelsSection(app, levelsHost);
  const levelEl = h("div", { class: "level-card", title: "Levels, ranks, streak and badges - below", onclick: () => levelsHost.scrollIntoView({ block: "start", behavior: "smooth" }) });
  const statsEl = h("div", { class: "focus-stats" });
  const chartEl = h("div", { class: "focus-chart" });
  // the chart's span, remembered
  let range = ["days", "weeks", "months", "all"].includes(app.settings.focusChartRange) ? app.settings.focusChartRange : "days";
  const chartTitle = h("h2", { text: "Focus" });
  const chartRange = h("div", { class: "segmented is-small" });
  const paintRange = () => chartRange.replaceChildren(...[["days", "14 days"], ["weeks", "Weeks"], ["months", "Months"], ["all", "All time"]].map(([id, label]) =>
    h("button", { class: "seg" + (range === id ? " is-active" : ""), onclick: () => { range = id; app.setSetting("focusChartRange", id); paintRange(); paintStats(); } }, label)));
  paintRange();

  el.append(h("div", { class: "view-inner focus-view" },
    h("header", { class: "vh" }, h("div", {}, h("h1", { class: "vh-title", text: "Timer" }), h("div", { class: "vh-sub kbd-hint", text: "Focus timer · Alt+P start or pause, from anywhere in the app" }))),
    h("div", { class: "focus-top" },
      h("section", { class: "card pomo-card" },
        face,
        h("div", { class: "pomo-controls" },
          h("button", { class: "icon-btn", title: "Reset", onclick: () => P.reset() }, icon("undo")),
          playBtn,
          h("button", { class: "icon-btn", title: "Skip to next phase", onclick: () => P.skip() }, icon("forward"))),
        h("div", { class: "pomo-settings" },
          stepper("pomo_work_mins", "Work", 1, 180),
          stepper("pomo_break_mins", "Break", 1, 60),
          toggleRow("pomo_alert_enabled", "Start and break sounds"),
          toggleRow("pomo_notify_enabled", "Messages when a block ends"),
          toggleRow("pomo_tick_enabled", "Clock ticking"))),
      h("div", { class: "focus-side" }, levelEl, statsEl)),
    app.deskBreaks ? app.deskBreaks.panel() : null,
    h("section", { class: "card" }, h("header", { class: "card-head" }, icon("clock"), chartTitle, h("span", { class: "fit-fill" }), chartRange), chartEl),
    levelsHost));

  function paintTimer() {
    if (el.hidden) return;
    const frac = 1 - P.remainingMs() / P.fullMs();
    arc.setAttribute("stroke-dashoffset", String(C * (1 - clamp(frac, 0, 1))));
    face.classList.toggle("is-break", P.phase === "break");
    face.classList.toggle("is-running", P.running);
    time.textContent = P.label();
    phaseEl.textContent = P.phase === "work" ? "Work" : "Break";
    playBtn.replaceChildren(icon(P.running ? "pause" : "play"), P.running ? "Pause" : P.touched ? "Resume" : "Start");
  }

  function paintStats() {
    if (el.hidden) return;
    const p = S.progress();
    const rank = rankOf(p.level);
    levelEl.replaceChildren(
      h("div", { class: "level-top" }, h("span", { class: "level-badge", text: String(p.level) }), h("div", {},
        h("b", { class: "level-rank" }, `Level ${p.level} · `, icon(rank.icon), rank.name),
        h("div", { class: "vh-sub", text: `${S.xp.toLocaleString()} XP · ${p.next - S.xp} to level ${p.level + 1}${rank.next ? ` · ${rank.next.name} at level ${rank.next.level}` : ""}` }))),
      h("div", { class: "level-bar" }, h("span", { style: { width: `${Math.round((p.into / p.span) * 100)}%` } })));

    const today = dayKey();
    let week = 0;
    for (let i = 0; i < 7; i++) week += S.focusOn(dayKey(addDays(new Date(), -i)));
    const stat = (v, l) => h("div", { class: "fstat" }, h("b", { text: v }), h("span", { text: l }));
    statsEl.replaceChildren(
      // today's focus can be put right by hand (a count that went wrong); its XP follows
      Object.assign(stat(fmtDuration(S.focusOn(today)), "focus today"), { title: "Click to correct it", style: "cursor:pointer", onclick: async () => {
        const { askDialog } = await import("./ui.js");
        const r = await askDialog("Focus today", [{ key: "min", label: "Minutes", value: String(Math.round(S.focusOn(today) / 60)), type: "number" }], { ok: "Set", text: "The minutes of work today. XP for focus changes with it." });
        if (!r || r.min === "" || !(Number(r.min) >= 0)) return;
        S.setFocusOn(today, Math.round(Number(r.min) * 60));
        paintStats(); drawLevels();
      } }),
      stat(fmtDuration(week), "this week"),
      stat(fmtDuration(S.data.pomo_total_work_secs || 0), "all time"),
      stat(String(S.data.tasks_done || 0), "tasks done"),
      stat(String(S.data.tasks_created || 0), "tasks created"));

    // the bars: each a day, a week or a month - the work, and the breaks lighter on top
    const daily = S.data.pomo_daily || {};
    const buckets = focusBuckets(range, daily, today);
    chartTitle.textContent = { days: "Focus, last 14 days", weeks: "Focus, last 12 weeks", months: "Focus, last 12 months", all: "Focus, all time" }[range];
    const vals = buckets.map((b) => b.work), rests = buckets.map((b) => b.rest);
    const max = Math.max(60, ...vals.map((v, i) => v + rests[i]));
    const pct = (v) => (v ? Math.max(3, (v / max) * 100) : 0);
    chartEl.classList.toggle("is-many", buckets.length > 24);
    chartEl.replaceChildren(...buckets.map((b, i) =>
      h("div", { class: "bar-col" + (b.now ? " is-today" : ""), title: `${b.title}: ${fmtDuration(vals[i])} focus${rests[i] ? ` · ${fmtDuration(rests[i])} break` : ""}` },
        h("div", { class: "bar-wrap" },
          h("div", { class: "bar-stack", style: { height: `${pct(vals[i] + rests[i])}%` } },
            rests[i] ? h("div", { class: "bar is-rest", style: { flex: `${rests[i]} 1 0` } }) : null,
            vals[i] ? h("div", { class: "bar", style: { flex: `${vals[i]} 1 0` } }) : null)),
        h("span", { class: "bar-label", text: b.label }))));
  }

  let statsRaf = 0;
  app.bus.on("pomo", paintTimer);
  // drawn only while the view is up: hidden, it costs nothing
  // the ranks, badges and year are rebuilt when XP moves (once a focus minute), not at every tick: a rank's
  // hover text would vanish each second
  let lastXp = -1;
  // everything it shows is in whole minutes: while the timer runs it is drawn again once a minute (or when XP or the
  // task counts move), not every second
  let lastStats = "";
  const statsKey = () => { const d = dayKey(); return [range, d, S.xp, S.data.tasks_done, S.data.tasks_created, Math.floor(S.focusOn(d) / 60), Math.floor((S.data.pomo_total_work_secs || 0) / 60), Math.floor((((S.data.pomo_daily || {})[d] || {}).break || 0) / 60)].join("|"); };
  S.bus.on("changed", () => { if (!statsRaf) statsRaf = setTimeout(() => { statsRaf = 0; if (!el.hidden) { const k = statsKey(); if (k !== lastStats) { lastStats = k; paintStats(); } if (S.xp !== lastXp) { lastXp = S.xp; drawLevels(); } } }, 1000); });

  return { show() { paintTimer(); paintStats(); lastXp = S.xp; drawLevels(); } };
}

/** The focus chart's bars from the daily log: 14 days, 12 weeks (from Monday), 12 months, or every month
 *  since the first day with focus. Each { title, label, work, rest, now }. */
export function focusBuckets(range, daily, today) {
  const ents = Object.entries(daily); // once, not once per bar
  const sum = (from, to) => {
    let work = 0, rest = 0;
    for (const [k, v] of ents) if (k >= from && k <= to && v) { work += v.work || 0; rest += v.break || 0; }
    return { work, rest };
  };
  const t = parseISO(today);
  if (range === "weeks") {
    const mon = addDays(t, -((t.getDay() + 6) % 7));
    return [...Array(12)].map((_, i) => {
      const a = addDays(mon, -7 * (11 - i)), b = addDays(a, 6);
      return { ...sum(dayKey(a), dayKey(b)), title: `Week of ${dayKey(a)}`, label: a.toLocaleDateString(undefined, { day: "numeric", month: "numeric" }), now: i === 11 };
    });
  }
  if (range === "months" || range === "all") {
    const first = Object.keys(daily).filter((k) => (daily[k] || {}).work > 0).sort()[0];
    let n = 12;
    if (range === "all" && first) { const f = parseISO(first); n = Math.max(1, (t.getFullYear() - f.getFullYear()) * 12 + t.getMonth() - f.getMonth() + 1); }
    return [...Array(n)].map((_, i) => {
      const m = new Date(t.getFullYear(), t.getMonth() - (n - 1 - i), 1);
      const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
      const name = m.toLocaleDateString(undefined, { month: "short" });
      return { ...sum(dayKey(m), dayKey(end)), title: m.toLocaleDateString(undefined, { month: "long", year: "numeric" }), label: m.getMonth() === 0 || n <= 12 ? (m.getMonth() === 0 && n > 12 ? String(m.getFullYear()) : name) : "", now: i === n - 1 };
    });
  }
  return [...Array(14)].map((_, i) => {
    const d = addDays(t, -(13 - i));
    return { ...sum(dayKey(d), dayKey(d)), title: dayKey(d), label: d.toLocaleDateString(undefined, { weekday: "narrow" }), now: i === 13 };
  });
}
const parseISO = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
