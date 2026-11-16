// Recurring tasks and reminders ("water the plants every
// Tuesday"). Shares ~/.leonote_recurring.json with the Python app. The
// calendar engine lives in recurring.js; this file schedules it, turns due
// occurrences into real tasks, and renders the list at the bottom of Habits.

import * as R from "./recurring.js";
import { h, dayKey, localIso, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu } from "./ui.js";
import { XP } from "./stats.js";

const WD = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export function createRecurring(app, initial) {
  const data = initial && typeof initial === "object" ? initial : { version: 1, rules: [], log: {} };
  if (!Array.isArray(data.rules)) data.rules = [];
  if (!data.log || typeof data.log !== "object") data.log = {};
  for (const r of data.rules) R.normRule(r, dayKey());

  const persist = debounce(() => app.host.saveRecurring(data).catch((e) => app.toast("Could not save recurring: " + e, { kind: "error" })), 300);
  const changed = () => { persist(); app.bus.emit("recurring"); };
  const byId = (rid) => data.rules.find((r) => r.id === rid);
  const nowIso = () => localIso().slice(0, 19);

  function existingKeys() {
    const keys = new Set();
    for (const t of app.tasks.all) if (t.rec_id) keys.add(R.occKey(t.rec_id, t.rec_date || ""));
    return keys;
  }

  /** Idempotent: materialise whatever became due. Safe to call often. */
  function catchUp() {
    const today = dayKey();
    const live = data.rules.filter((r) => !r.deleted);
    if (!live.length) return 0;
    const { spawns, updates, fired } = R.catchUpPlan(data.rules, today, existingKeys(), data.log);
    if (!spawns.length && !Object.keys(updates).length) return 0;
    let made = 0;
    for (const sp of spawns) {
      if (sp.mode !== "task") continue;
      const fields = R.specToTask(sp, nowIso());
      app.tasks.create(fields.text, fields, { silent: true });
      made++;
    }
    let moved = false;
    for (const rid in updates) {
      const r = byId(rid);
      if (r) for (const k in updates[rid]) if (r[k] !== updates[rid][k]) { r[k] = updates[rid][k]; moved = true; }
    }
    if (made || moved) changed();
    const names = fired.map((rid) => byId(rid)).filter(Boolean).map((r) => r.title);
    if (names.length) {
      app.toast(`Due now: ${names[0]}${names.length > 1 ? ` +${names.length - 1} more` : ""}`, {
        ms: 6000,
        action: { label: made ? "Tasks" : "Open", run: () => app.openView(made ? "tasks" : "habits") },
      });
    }
    return made;
  }

  const openTasksFor = (rid) => app.tasks.all.filter((t) => t.rec_id === rid && t.rec_date && !t.done && !t.deleted);

  const api = {
    data,
    catchUp,
    /** A rule was changed in place by someone else (the Google push): save and tell. */
    touch: changed,

    /** A spawned task was completed or reopened in the task list: keep the
     *  completion log (which drives streaks) in step. XP came from the task. */
    taskToggled(t, done) {
      if (!t || !t.rec_id || !t.rec_date) return;
      const list = data.log[t.rec_id] || (data.log[t.rec_id] = []);
      const i = list.indexOf(t.rec_date);
      if (done && i < 0) list.push(t.rec_date);
      if (!done && i >= 0) list.splice(i, 1);
      changed();
    },

    markDone(rid) {
      const res = R.markDone(data, rid, dayKey(), openTasksFor(rid));
      if (!res) { app.toast("Nothing due for this one yet"); return; }
      if (res.closeTaskId) {
        const t = app.tasks.get(res.closeTaskId);
        if (t && !t.done) app.tasks.toggle(res.closeTaskId);
      } else if (res.awardXp && !(byId(rid).created && res.iso < String(byId(rid).created).slice(0, 10))) {
        // The legacy engine lets an occurrence from before the rule existed be
        // marked done, once per click - logged, but it earns nothing.
        app.stats.award(XP.recurringDone, "recurringDone");
      }
      changed();
    },

    snooze(rid, days = 1) { R.snooze(data, rid, dayKey(), days); changed(); },
    skipNext(rid) { R.skipNext(data, rid, dayKey()); changed(); },
    toggleActive(rid) { R.toggleActive(data, rid); changed(); catchUp(); },

    remove(rid) {
      const r = byId(rid);
      if (!r) return;
      R.softDelete(data, rid, nowIso());
      changed();
      app.toast(`Deleted “${r.title}”`, { action: { label: "Undo", run: () => { r.deleted = false; r.deleted_at = null; r.active = true; changed(); } } });
    },

    upsert(rule) {
      const existing = rule.id && byId(rule.id);
      if (existing) Object.assign(existing, rule);
      else data.rules.push(rule);
      R.normRule(existing || rule, dayKey());
      changed();
      catchUp();
    },

    pendingCount() {
      const today = dayKey();
      let n = 0;
      for (const r of data.rules) {
        if (r.deleted || !r.active) continue;
        const nd = R.nextDue(r, today);
        if (nd && nd.date && nd.date <= today) n++;
      }
      return n;
    },

    mountInto(container) { mountList(app, api, container); },
  };

  // schedule: shortly after boot, every minute, and when the window regains focus
  setTimeout(catchUp, 400);
  // kept on a minute's tick on purpose: a rule's time ("Due now" at 9:00) is worked out by catchUpPlan, and a
  // timeout to the next due moment would have to repeat that reckoning; this is one pass over the rules a minute
  setInterval(catchUp, 60000);
  let lastFocus = 0;
  window.addEventListener("focus", () => { if (Date.now() - lastFocus > 30000) { lastFocus = Date.now(); catchUp(); } });
  return api;
}

function mountList(app, api, container) {
  const list = h("div", { class: "rec-list" });
  const formHost = h("div");
  const card = h("section", { class: "card rec-card" },
    h("header", { class: "card-head" }, icon("repeat"), h("h2", { text: "Recurring" }),
      h("button", { class: "link-btn", onclick: () => openForm(null) }, "+ Recurring")),
    formHost, list);
  container.append(card);

  function render() {
    const today = dayKey();
    const rules = api.data.rules.filter((r) => !r.deleted);
    if (!rules.length) {
      list.replaceChildren(h("div", { class: "card-empty", text: "Nothing repeating yet. e.g. “water the plants” every Tuesday." }));
      return;
    }
    const rank = (r) => {
      const nd = R.nextDue(r, today);
      if (!nd || !nd.date) return [3, "9999"];
      if (nd.overdue) return [0, nd.date];
      if (nd.date === today) return [1, nd.date];
      return [2, nd.date];
    };
    rules.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1].localeCompare(y[1]); });

    list.replaceChildren(...rules.map((r) => {
      const nd = R.nextDue(r, today);
      const streak = R.streak(r, api.data.log, today);
      const rate = R.rate(r, api.data.log, today, 8);
      const due = nd && nd.date;
      const dueCls = !due ? "is-quiet" : nd.overdue ? "is-overdue" : due === today ? "is-today" : "";
      return h("div", { class: "rec-row" + (r.active ? "" : " is-paused") },
        h("button", { class: "task-check", title: "Done for this occurrence", onclick: () => api.markDone(r.id) }, icon("check")),
        h("div", { class: "rec-main" },
          h("div", { class: "rec-title", text: r.title }),
          h("div", { class: "rec-meta" },
            h("span", { class: "chip" }, icon("repeat"), R.describe(r)),
            h("span", { class: "chip " + dueCls }, icon("calendar"), due ? R.fmtDate(due, today) + (r.time ? " " + r.time : "") : "no more dates"),
            streak ? h("span", { class: "chip is-today" }, icon("flame"), String(streak)) : null,
            rate.total ? h("span", { class: "chip is-quiet", text: `${rate.hits}/${rate.total} recent` }) : null,
            r.mode === "reminder" ? h("span", { class: "chip", text: "Reminder" }) : null,
            r.active ? null : h("span", { class: "chip", text: "Paused" }))),
        h("div", { class: "rec-acts" },
          h("button", { class: "icon-btn", title: "Edit", onclick: () => openForm(r) }, icon("edit")),
          h("button", { class: "icon-btn", title: "More", onclick: (e) => menu(0, 0, [
            { label: "Snooze a day", icon: "clock", run: () => api.snooze(r.id, 1) },
            { label: "Snooze a week", icon: "clock", run: () => api.snooze(r.id, 7) },
            { label: "Skip next", icon: "forward", run: () => api.skipNext(r.id) },
            { label: r.active ? "Pause" : "Resume", icon: r.active ? "pause" : "play", run: () => api.toggleActive(r.id) },
            "sep",
            { label: "Delete", icon: "trash", danger: true, run: () => api.remove(r.id) },
          ], { anchor: e.currentTarget }) }, icon("more"))));
    }));
  }

  function openForm(rule) {
    const today = dayKey();
    const r = rule ? structuredClone(rule) : R.normRule({ title: "", rule: { kind: "weekly", days: [new Date().getDay() === 0 ? 6 : new Date().getDay() - 1], interval: 1 } }, today);
    const title = h("input", { class: "text-input", value: r.title, placeholder: "What repeats?", spellcheck: false });
    const kind = select(["daily", "weekly", "monthly", "once"], r.rule.kind, { daily: "Daily", weekly: "Weekly", monthly: "Monthly", once: "Once" });
    const interval = h("input", { class: "text-input", type: "number", min: 1, max: 99, value: r.rule.interval || 1, style: { width: "64px", flex: "0 0 64px", minWidth: "0" } });
    const dom = h("input", { class: "text-input", type: "number", min: 1, max: 31, value: r.rule.day || 1, style: { width: "64px", flex: "0 0 64px", minWidth: "0" } });
    const days = new Set(r.rule.days || []);
    const dayBtns = h("div", { class: "rec-days" }, WD.map((n, i) => {
      const b = h("button", { class: "rec-day" + (days.has(i) ? " is-on" : ""), text: n });
      b.addEventListener("click", () => { days.has(i) ? days.delete(i) : days.add(i); b.classList.toggle("is-on", days.has(i)); preview(); });
      return b;
    }));
    const anchor = h("input", { class: "text-input", type: "date", value: r.anchor || today, style: { flex: "0 0 150px" } });
    const until = h("input", { class: "text-input", type: "date", value: r.until || "", style: { flex: "0 0 150px" } });
    const time = h("input", { class: "text-input", type: "time", value: r.time || "", style: { flex: "0 0 110px" } });
    const priority = select(["none", "low", "medium", "high"], r.priority, { none: "No priority", low: "Low", medium: "Medium", high: "High" });
    const mode = select(["task", "reminder"], r.mode, { task: "Create a task", reminder: "Reminder only" });
    const catchup = select(["collapse", "all", "skip"], r.catchup, { collapse: "One task for missed dates", all: "A task per missed date", skip: "Ignore missed dates" });
    const prev = h("div", { class: "rec-preview" });
    const intervalUnit = h("span", { class: "rec-preview" });

    const build = () => ({
      ...r,
      title: title.value.trim(),
      anchor: anchor.value || today,
      until: until.value || null,
      time: time.value || "",
      priority: priority.value,
      mode: mode.value,
      catchup: catchup.value,
      rule: { kind: kind.value, interval: Math.max(1, Number(interval.value) || 1), days: [...days].sort(), day: Math.min(31, Math.max(1, Number(dom.value) || 1)) },
    });

    function preview() {
      const k = kind.value;
      dayBtns.hidden = k !== "weekly";
      dom.hidden = k !== "monthly";
      interval.hidden = k === "once";
      intervalUnit.hidden = k === "once";
      intervalUnit.textContent = { daily: "day(s)", weekly: "week(s)", monthly: "month(s)" }[k] || "";
      const draft = R.normRule(build(), today);
      const next = R.nextOccurrences(draft, today, 3);
      prev.textContent = next.length ? `${R.describe(draft)} · next: ${next.map((d) => R.fmtDate(d, today)).join(", ")}` : "No upcoming dates";
    }
    for (const x of [kind, interval, dom, anchor, until]) x.addEventListener("input", preview);

    const save = () => {
      const next = build();
      if (!next.title) { title.focus(); return; }
      api.upsert(next);
      formHost.replaceChildren();
    };
    title.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") save(); if (e.key === "Escape") formHost.replaceChildren(); });

    const row = (label, ...kids) => h("div", { class: "rec-form-row" }, h("label", { text: label }), ...kids);
    formHost.replaceChildren(h("div", { class: "rec-form" },
      row("Title", title),
      row("Repeats", kind, h("span", { class: "rec-preview", text: "every" }), interval, intervalUnit, dayBtns, dom),
      row("Starts", anchor, h("span", { class: "rec-preview", text: "ends" }), until, h("span", { class: "rec-preview", text: "at" }), time),
      row("Then", mode, priority, catchup),
      prev,
      h("div", { class: "rec-form-row" },
        h("button", { class: "btn btn-primary", onclick: save }, rule ? "Save" : "Add recurring"),
        h("button", { class: "btn", onclick: () => formHost.replaceChildren() }, "Cancel"))));
    preview();
    title.focus();
  }

  function select(values, current, labels) {
    const s = h("select", { class: "select" }, values.map((v) => h("option", { value: v, text: labels[v] || v })));
    s.value = current;
    return s;
  }

  render();
  app.bus.on("recurring", render);
  app.tasks.bus.on("changed", debounce(render, 200));
  // the "next" dates turn over with the clock: drawn again a minute apart, but only while the list is in sight
  setInterval(() => { if (container.isConnected && container.offsetParent !== null && !document.hidden) render(); }, 60000);
}
