// Tasks. Keyed rows: a patch - from you, Python, or an agent - touches only
// the rows whose ids changed, and rows move rather than re-render.

import { h, dayKey, parseDay, addDays, fmtDay, relTime, uuid, debounce, animateRows, collapseOut, countTo, motionFull } from "./util.js";
import { icon } from "./icons.js";
import { parseQuickAdd, similarTasks, TRASH_KEEP, filterTasks } from "./taskstore.js";
import { inlineEdit, menu, sortable, confirmDialog } from "./ui.js";
import { duplicateTask } from "./taskmenu.js";

const SEGMENTS = [
  ["inbox", "Inbox", "inbox"],
  ["today", "Today", "sun"],
  ["upcoming", "Upcoming", "calendar"],
  ["done", "Completed", "check"],
  ["archive", "Archive", "archive"],
  ["trash", "Trash", "trash"],
  // shown only while the tasks are split (Settings › AI agents)
  ["ai", "AI's", "sparkles"],
];
const PRI_LABEL = { high: "High", medium: "Medium", low: "Low", none: "None" };
const AGENT_WINDOW = 15 * 60000;

export function dueLabel(key) {
  if (!key) return null;
  const today = parseDay(dayKey());
  const d = parseDay(key);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return fmtDay(d, { day: "numeric", month: "short", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

export function mountTasks(app, el) {
  const store = app.tasks;
  let seg = app.settings.taskSegment || "inbox";
  const rows = new Map();
  const expanded = new Set();
  const linger = new Map();
  let lastOrder = [];
  let focusId = null;
  let stale = true;

  /* ── skeleton ───────────────────────────────────────────────────────── */
  const summary = h("div", { class: "vh-sub" });
  const live = h("div", { class: "live-dot", title: `Agents writing to ${app.dataDir && app.dataDir !== "user" && app.dataRoot ? app.dataRoot + "\\log\\*.jsonl" : "~/.leonote/log/*.jsonl"} show up here instantly` }, h("span", { class: "dot" }), "Live");
  const segEls = new Map();
  const segBar = h("div", { class: "segmented" }, SEGMENTS.map(([id, label, ic]) => {
    const count = h("span", { class: "seg-count" });
    const b = h("button", { class: "seg", title: label, onclick: () => setSegment(id) }, icon(ic), h("span", { class: "seg-label", text: label }), count);
    segEls.set(id, { b, count });
    return b;
  }));

  // a box that grows with a long task (lines wrap, nothing scrolls away sideways); Enter still adds it
  const addInput = h("textarea", { class: "qa-input", rows: 1, placeholder: "Add a task…", title: "Typing works too: !h priority, @tomorrow due, ^fri start, +Area files it under a focus area · N or / gets here from the list", spellcheck: false });
  addInput.addEventListener("input", () => { if (addInput.value.includes("\n")) addInput.value = addInput.value.replace(/\s*\n\s*/g, " "); });
  const addChips = h("div", { class: "qa-chips" });
  // shown while something is typed: erase it, or add it without knowing about Enter
  const qaBtn = (ic, title, run) => h("button", { class: "qa-btn", title, onmousedown: (e) => e.preventDefault(), onclick: run }, icon(ic));
  const addEnd = h("span", { class: "qa-end", hidden: true },
    qaBtn("x", "Clear (Esc)", () => { clearAdd(); addInput.focus(); }),
    qaBtn("send", "Add the task (Enter)", () => addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))));
  const addBar = h("div", { class: "qa" }, icon("plus"), addInput, addChips, addEnd);
  /* While a task is being written: whose it is, its priority and when it is due, a click each.
     Typed !h / @tomorrow still win; it all resets after Enter (whose: back to the default). */
  const qaDefault = () => (app.settings.tasksDefaultOwner === "ai" ? "ai" : "human");
  const qa = { owner: qaDefault(), priority: null, due: null, start: null };
  const qaIn = h("div", { class: "qa-opts-in" });
  const qaOpts = h("div", { class: "qa-opts" }, qaIn);
  const PRI_SHORT = [["low", "Low"], ["medium", "Med"], ["high", "High"]];
  function paintQa() {
    const btn = (on, label, run, cls = "", title = "") => h("button", { class: "qa-opt" + (on ? " is-on" : "") + cls, title, onmousedown: (e) => e.preventDefault(), onclick: () => { run(); paintQa(); addInput.focus(); } }, label);
    const tomorrow = dayKey(addDays(new Date(), 1)), today = dayKey(), week = dayKey(addDays(new Date(), 7));
    // another day: a chip that opens the calendar and then shows the day picked
    const pickDay = (key, presets, title) => {
      const val = qa[key];
      const other = !!val && !presets.includes(val);
      const inp = h("input", { type: "date", class: "qa-date-in", tabindex: -1, value: other ? val : "", onchange: (e) => { qa[key] = e.target.value || null; paintQa(); addInput.focus(); } });
      return h("button", { class: "qa-opt qa-pick" + (other ? " is-on" : ""), title, onmousedown: (e) => e.preventDefault(),
        onclick: () => { if (other) { qa[key] = null; paintQa(); } else try { inp.showPicker(); } catch { inp.click(); } } },
        icon("calendar"), other ? new Date(val + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Pick…", inp);
    };
    // the two days need saying which is which: when it shows up, and when it must be done
    const row = (label, hint, ...chips) => h("div", { class: "qa-row" }, h("span", { class: "qa-lab" }, h("b", { text: label }), h("small", { text: hint })), h("div", { class: "qa-chips-in" }, ...chips));
    const set = (key, v) => () => { qa[key] = qa[key] === v ? null : v; };
    qaIn.replaceChildren(
      h("div", { class: "qa-chips-in" },
        h("div", { class: "segmented is-small qa-owner" },
          btn(qa.owner !== "ai", "Mine", () => { qa.owner = "human"; }, " is-mine", "Your task"),
          btn(qa.owner === "ai", "AI", () => { qa.owner = "ai"; }, " is-ai", graceMs() ? `AI's - agents get it ${graceMs() / 60000} min after it is added` : "AI's task")),
        // one block; when it is narrow the words give way and the flags stay
        h("div", { class: "segmented is-small qa-pri" },
          ...PRI_SHORT.map(([v, label]) => btn(qa.priority === v, [icon("flag"), h("span", { class: "qa-pri-t", text: label })], set("priority", v), " p-" + v, `${label} priority (or !${v[0]})`)))),
      row("Starts", "shows up from", btn(qa.start === tomorrow, "Tomorrow", set("start", tomorrow), "", "Out of your lists until then (or ^tomorrow)"),
        btn(qa.start === week, "In a week", set("start", week)), pickDay("start", [tomorrow, week], "The day it shows up in your lists")),
      row("Due", "done by", btn(qa.due === today, "Today", set("due", today)), btn(qa.due === tomorrow, "Tomorrow", set("due", tomorrow), "", "Or @tomorrow"),
        btn(qa.due === week, "In a week", set("due", week)), pickDay("due", [today, tomorrow, week], "The day it must be done by")));
  }
  // they slide in with the first letter and away when the box is empty again (written, sent or erased)
  const syncQa = () => {
    const want = app.settings.taskAddOptions !== false && !!addInput.value.trim();
    if (want && !qaOpts.classList.contains("is-open")) paintQa();
    qaOpts.classList.toggle("is-open", want);
    addEnd.hidden = !addInput.value;
  };
  addInput.addEventListener("input", syncQa);
  // tasks like the one being typed - one click reuses its steps
  const addLike = h("div", { class: "qa-like", hidden: true });

  const list = h("div", { class: "task-list", tabIndex: 0 });
  // what is picked right now, and the bar that acts on it (see "picking
  // several at once" below)
  const sel = new Set();
  let anchorId = null;
  const selBar = h("div", { class: "task-selbar", hidden: true });
  sortable(list, {
    item: ".sub, .task",
    onMove: (from, to, el) => {
      if (el.classList.contains("task")) return moveTask(from, to, el);
      const id = el.closest(".task").dataset.id;
      const t = store.get(id);
      if (!t || !Array.isArray(t.subtasks)) return;
      const next = t.subtasks.map((s) => ({ ...s }));
      next.splice(to, 0, next.splice(from, 1)[0]);
      store.setSubtasks(id, next);
    },
    // a step dragged onto another task moves there: on the row it goes to the
    // end of that task's steps, on one of its steps it lands beside it
    adopt: ".task",
    onAdopt: (el, host, before) => {
      if (!el.classList.contains("sub")) return;
      const fromId = el.closest(".task") && el.closest(".task").dataset.id;
      const toId = host.dataset.id;
      const src = fromId && store.get(fromId);
      const dst = store.get(toId);
      if (!src || !dst || fromId === toId || dst.deleted) return;
      const srcSteps = stepsOf(fromId);
      const i = stepIndex(srcSteps, el);
      if (i < 0) return;
      const [step] = srcSteps.splice(i, 1);
      const dstSteps = stepsOf(toId);
      const at = before ? stepIndex(dstSteps, before) : -1;
      dstSteps.splice(at < 0 ? dstSteps.length : at, 0, step);
      store.setSubtasks(toId, dstSteps);
      store.setSubtasks(fromId, srcSteps, { expected: true });
      expanded.add(toId);
      const r = rows.get(toId);
      if (r) renderRow(store.get(toId), r);
      const name = String(dst.text || "").split(/\r?\n/)[0].slice(0, 40);
      app.toast(`Step moved to “${name}”`, { ms: 2200 });
    },
  });

  /** A row dragged to a new place - with everything else picked, if it was. */
  function moveTask(from, to, el) {
    const ids = [...list.querySelectorAll(".task")].map((r) => r.dataset.id);
    const dragged = el.dataset.id;
    const group = sel.size > 1 && sel.has(dragged) ? ids.filter((id) => sel.has(id)) : [dragged];
    // where the row landed, in terms of the rows that are staying put
    const rest = ids.filter((id) => !group.includes(id));
    // `to` counts places in the list WITHOUT the dragged row. Counting it in
    // (as this did) put every downward drag one place short: a row moved down
    // by one landed exactly where it started, which looked like a dead drag.
    const others = ids.filter((id) => id !== dragged);
    const at = Math.max(0, Math.min(rest.length, to - others.slice(0, to).filter((id) => group.includes(id)).length));
    let before = rest[at - 1] || null;
    for (const id of group) {
      store.place(id, before, rest[at] || null);
      before = id;
    }
  }
  const empty = h("div", { class: "empty-state" });

  /* ── trash: it empties itself, and says so ────────────────────────────
     A day after you trash something it is gone for good, here and in the
     Python app. That is only fair if the clock is visible, so every row
     carries its own, and the ones about to go say so louder. */
  const trashNote = h("div", { class: "trash-note", hidden: true });
  // the Archive can grow long: narrowed by when it was finished and by priority (the box above narrows by words)
  const arch = { period: app.settings.archivePeriod || "all", priority: app.settings.archivePriority || "" };
  const PERIODS = [["all", "Any time"], ["7", "7 days"], ["30", "30 days"], ["year", "This year"]];
  const periodBar = h("div", { class: "segmented is-small" }, PERIODS.map(([id, label]) =>
    h("button", { class: "seg", dataset: { p: id }, onclick: () => { arch.period = id; app.setSetting("archivePeriod", id); paintArch(); reconcile(null); } }, label)));
  const monthBtn = h("button", { class: "chip-btn", title: "A month of your choice", onclick: (e) => {
    const months = [...new Set(store.all.filter((x) => x.done && x.completed_at).map((x) => x.completed_at.slice(0, 7)))].sort().reverse().slice(0, 24);
    const r = e.currentTarget.getBoundingClientRect();
    app.menu(r.left, r.bottom + 4, months.length ? months.map((m) => ({ label: new Date(m + "-01T12:00").toLocaleDateString(undefined, { month: "long", year: "numeric" }), checked: arch.period === m, run: () => { arch.period = m; app.setSetting("archivePeriod", m); paintArch(); reconcile(null); } })) : [{ header: "Nothing finished yet" }]);
  } }, icon("calendar"), h("span"));
  const priBtn = h("button", { class: "chip-btn", onclick: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    app.menu(r.left, r.bottom + 4, [["", "Any priority"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["none", "No priority"]].map(([id, label]) => ({ label, checked: arch.priority === id, run: () => { arch.priority = id; app.setSetting("archivePriority", id); paintArch(); reconcile(null); } })));
  } }, icon("flag"), h("span"));
  const archBar = h("div", { class: "arch-bar", hidden: true }, periodBar, monthBtn, priBtn);
  function paintArch() {
    archBar.hidden = seg !== "archive";
    for (const b of periodBar.children) b.classList.toggle("is-active", b.dataset.p === arch.period);
    const month = /^\d{4}-\d{2}$/.test(arch.period);
    monthBtn.classList.toggle("is-on", month);
    monthBtn.lastChild.textContent = month ? new Date(arch.period + "-01T12:00").toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "Month…";
    priBtn.classList.toggle("is-on", !!arch.priority);
    priBtn.lastChild.textContent = arch.priority ? PRI_LABEL[arch.priority] || "No priority" : "Priority";
  }

  /** "6h 20m left" - and the closer it gets, the louder the chip. */
  function trashChip(t) {
    const left = store.trashLeft(t);
    const mins = Math.floor(left / 60000);
    const h1 = Math.floor(mins / 60);
    const m = mins % 60;
    const text = left <= 0 ? "going now" : h1 >= 1 ? `${h1}h ${String(m).padStart(2, "0")}m left` : `${m || 1}m left`;
    const state = left <= 15 * 60000 ? " is-soon" : left <= 2 * 3600000 ? " is-warn" : "";
    return h("span", {
      class: "chip is-timer" + state,
      title: t.deleted_at ? `Trashed ${relTime(new Date(t.deleted_at).getTime())} - deleted for good a day after that, its words erased from every old copy too` : "Deleted for good a day after it was trashed",
      style: { "--left": String(Math.max(0, Math.min(1, left / TRASH_KEEP))) },
    }, icon("clock"), h("span", { text }));
  }

  function paintTrashNote() {
    trashNote.hidden = seg !== "trash";
    if (seg !== "trash") return;
    const n = store.count ? store.select("trash").length : 0; // only when the trash is shown
    trashNote.replaceChildren(
      icon("trash"),
      h("div", { class: "trash-note-main" },
        h("b", { text: "Trash empties itself." }),
        h("span", { text: " Each task here is deleted for good 24 hours after it was trashed (its clock says when), and its words are erased from Leonote's old copies too. Ctrl+Z brings back what you just trashed." })),
      n ? h("button", { class: "btn btn-sm is-danger", onclick: async () => {
        if (!(await confirmDialog("Empty the trash?", `${n} task${n === 1 ? "" : "s"} will be deleted for good. This cannot be undone.`, { ok: "Delete them", safe: true }))) return;
        const gone = store.sweepTrash(true);
        app.toast(gone ? `${gone} task${gone === 1 ? "" : "s"} deleted for good` : "Trash is already empty", { ms: 3000 });
      } }, "Empty it now") : "");
  }

  /* One clock, a minute apart, only while the list is on screen and the window shows: the relative times and
     agent badges, and in the trash its countdowns. It stops itself when the list or the window hides; show()
     and the window coming back start it again. */
  let clock = 0;
  function clockTick() {
    if (el.hidden || document.hidden) { clearInterval(clock); clock = 0; return; }
    if (seg === "trash") {
      for (const [id, r] of rows) {
        const t = store.get(id);
        const old = r.querySelector(".chip.is-timer");
        if (t && old) old.replaceWith(trashChip(t));
      }
      store.sweepTrash();
    }
    reconcile(null);
  }
  const clockOn = () => { if (!clock && !el.hidden && !document.hidden) clock = setInterval(clockTick, 60000); };
  document.addEventListener("visibilitychange", clockOn);

  // yours and AI's (Settings › AI agents › Keep your tasks apart): which ones the list shows
  const split = () => !!(app.proposals && app.proposals.tasksSplit());
  const isAi = (t) => t.owner === "ai";
  // handed to AI: agents see it after the grace minutes of Settings (taken back before then, it never reached them)
  const graceMs = () => Math.max(0, Number(app.settings.aiTaskGrace ?? 1)) * 60000;
  const toAi = () => ({ owner: "ai", ai_from: graceMs() ? Date.now() + graceMs() : null });
  const pendingAi = (t) => isAi(t) && Number(t.ai_from) > Date.now();
  const hhmm = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const theirs = (list, s = seg) => (!split() || s === "trash" ? list : s === "ai" ? list.filter(isAi) : list.filter((t) => !isAi(t)));
  // the AI's list shows only while the tasks are split; switching the split off leaves it
  function paintOwners() {
    const ai = segEls.get("ai");
    if (ai) { ai.b.hidden = !split(); ai.b.classList.add("is-ai"); ai.b.title = "AI's tasks - agents and the chat see only these; yours stay out of their reach"; }
    if (!split() && seg === "ai") setSegment("inbox");
  }
  app.bus.on("aiaccess", () => { paintOwners(); reconcile(null); });

  // the open tasks put in order once - by due date or priority - then dragged as before
  const RANK = { high: 0, medium: 1, low: 2 };
  const sortBtn = h("button", { class: "icon-btn", title: "Put the open tasks in order once…", onclick: (e) => menu(0, 0, [
    { label: "By due date, soonest first", icon: "calendar", run: () => sortOnce("due") },
    { label: "By priority, high first", icon: "flag", run: () => sortOnce("priority") },
  ], { anchor: e.currentTarget }) }, icon("list"));
  function sortOnce(by) {
    const open = theirs(store.select(seg)).filter((t) => !t.done && !t.deleted);
    if (open.length < 2) return;
    const was = open.map((t) => t.id);
    const key = by === "due" ? (t) => t.due_date || "9999" : (t) => RANK[t.priority] ?? 3;
    const next = [...open].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).map((t) => t.id); // stable: ties keep their order
    store.reorder(next);
    const back = () => store.reorder(was);
    pushUndo(`sorted ${open.length} tasks`, back);
    app.toast(`${open.length} tasks sorted ${by === "due" ? "by due date" : "by priority"}`, { ms: 4000, action: { label: "Undo", run: back } });
  }

  el.append(h("div", { class: "view-inner tasks-view" },
    h("header", { class: "vh" }, h("div", {}, h("h1", { class: "vh-title", text: "Tasks" }), summary), sortBtn, live),
    segBar, addBar, qaOpts, addLike, archBar, trashNote, list, empty, selBar));

  /* ── quick add ──────────────────────────────────────────────────────── */
  const findArea = (s) => app.areas && app.areas.find(s);
  // "done something like this?" looks through every task: once typing pauses, not at each key, and from what the
  // box holds then, so a late one never brings back a suggestion after Enter has cleared it
  const likeSoon = debounce(() => paintLike(parseQuickAdd(addInput.value, new Date(), findArea).text), 150);
  addInput.addEventListener("input", () => {
    const p = parseQuickAdd(addInput.value, new Date(), findArea);
    addChips.replaceChildren(...[
      p.area ? h("span", { class: "chip is-area" }, icon("focus"), p.area) : null,
      p.priority ? h("span", { class: "chip p-" + p.priority }, icon("flag"), PRI_LABEL[p.priority]) : null,
      p.due_date ? h("span", { class: "chip" }, icon("calendar"), dueLabel(p.due_date)) : null,
      p.start_date ? h("span", { class: "chip" }, icon("clock"), "Starts " + dueLabel(p.start_date)) : null,
    ].filter(Boolean));
    likeSoon();
    narrow(p.text);
  });
  // the words typed also narrow the list to the tasks that carry them - the
  // box is a search too; the list comes back whole when it is empty
  let narrowWords = [];
  const narrowRows = () => { for (const r of list.querySelectorAll(".task")) { const t = r.querySelector(".task-text"); const s = (t ? t.textContent : r.textContent).toLowerCase(); r.hidden = narrowWords.length > 0 && !narrowWords.every((w) => s.includes(w)); } };
  function narrow(text) {
    narrowWords = String(text || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    list.classList.toggle("is-narrowed", narrowWords.length > 0);
    narrowRows();
    // picked before the narrowing and hidden by it: no longer picked, so nothing unseen is ticked or binned
    const hiddenPicked = [...sel].filter((id) => rows.get(id) && rows.get(id).hidden);
    if (hiddenPicked.length) setSel([...sel].filter((id) => !hiddenPicked.includes(id)));
  }
  new MutationObserver(() => { if (narrowWords.length) narrowRows(); }).observe(list, { childList: true, subtree: false });
  // "you did something like this before" - reuse it as a template
  function paintLike(text) {
    const like = text && text.trim().length >= 3 ? similarTasks(text, store.all, { limit: 3 }) : [];
    addLike.hidden = !like.length;
    if (!like.length) return addLike.replaceChildren();
    addLike.replaceChildren(
      h("span", { class: "qa-like-lead", text: "Done something like this?" }),
      ...like.map((t) => {
        const steps = (t.subtasks || []).length;
        const where = t.deleted ? "trash" : t.done ? "the finished list" : "your tasks";
        return h("span", { class: "qa-like-item" + (t.done ? " is-done" : "") },
          h("button", { class: "qa-like-go", title: `Go to “${t.text}” in ${where}`, onclick: () => jumpTo(t) },
            icon(t.done ? "check" : "checkSquare"), h("span", { class: "qa-like-text", text: t.text }),
            steps ? h("span", { class: "qa-like-n", text: `${steps}` }) : null),
          h("button", { class: "qa-like-copy", title: `Start a new task from this one${steps ? `, with its ${steps} step${steps === 1 ? "" : "s"}` : ""}`, onclick: () => reuse(t) }, icon("plus")));
      }));
  }

  app.showTask = (id) => { const t = store.get(id); if (!t) return; app.openView("tasks"); setTimeout(() => jumpTo(store.get(id) || t), 60); };
  // just show me that one: switch to the list it lives in and light it up
  function jumpTo(t) {
    const seen = t.deleted ? "trash" : t.done ? (store.buckets.done(t) ? "done" : "archive") : store.buckets.upcoming(t) ? "upcoming" : store.buckets.today(t) ? "today" : "inbox";
    if (seen !== seg) setSegment(seen);
    addInput.value = "";
    addChips.replaceChildren();
    narrow("");
    paintLike("");
    requestAnimationFrame(() => {
      setFocus(t.id);
      expanded.add(t.id);
      const r = rows.get(t.id);
      if (r) {
        renderRow(store.get(t.id), r);
        r.classList.remove("is-found");
        void r.offsetWidth;
        r.classList.add("is-found");
        setTimeout(() => r.classList.remove("is-found"), 1400);
      }
      list.focus({ preventScroll: true });
    });
  }

  // the same task again, beside it: dates, priority, area and steps kept, steps unticked
  function duplicate(t) { focusId = duplicateTask(app, t); }

  // a copy of an earlier task: same priority, area and steps, all unticked
  function reuse(t) {
    const p = parseQuickAdd(addInput.value, new Date(), findArea);
    const extra = {
      // what the add box's chips say counts, as it does for Enter
      priority: p.priority || qa.priority || t.priority || "none",
      due_date: p.due_date || qa.due || null,
      start_date: p.start_date || qa.start || null,
      ...(p.focus_id || t.focus_id ? { focus_id: p.focus_id || t.focus_id } : {}),
    };
    // a task that starts later is not due today as well (it would be in Upcoming and Today at once, and late tomorrow)
    if (seg === "today" && !extra.due_date && !(extra.start_date && extra.start_date > dayKey())) extra.due_date = dayKey();
    if (seg === "ai" || qa.owner === "ai") Object.assign(extra, toAi());
    const id = store.create(p.text || t.text, extra);
    Object.assign(qa, { owner: qaDefault(), priority: null, due: null, start: null });
    syncQa();
    const steps = (t.subtasks || []).map((s) => ({ ...s, done: false }));
    if (steps.length) store.setSubtasks(id, steps);
    focusId = id;
    expanded.add(id);
    addInput.value = "";
    addChips.replaceChildren();
    narrow("");
    paintLike("");
    app.toast(steps.length ? `Copied “${t.text}” with ${steps.length} step${steps.length === 1 ? "" : "s"}` : `Copied “${t.text}”`, { ms: 2600 });
  }

  function clearAdd() { addInput.value = ""; addChips.replaceChildren(); paintLike(""); narrow(""); syncQa(); }
  addInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { clearAdd(); list.focus({ preventScroll: true }); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); list.focus({ preventScroll: true }); moveFocus(1); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const p = parseQuickAdd(addInput.value, new Date(), findArea);
    if (!p.text) return;
    const extra = { priority: p.priority || qa.priority || "none", due_date: p.due_date || qa.due, start_date: p.start_date || qa.start };
    if (p.focus_id) extra.focus_id = p.focus_id;
    // a task that starts later is not due today as well (it would be in Upcoming and Today at once, and late tomorrow)
    if (seg === "today" && !extra.due_date && !(extra.start_date && extra.start_date > dayKey())) extra.due_date = dayKey();
    if (seg === "upcoming" && !extra.start_date) extra.start_date = dayKey(addDays(new Date(), 1));
    if (seg === "ai" || qa.owner === "ai") Object.assign(extra, toAi());
    const id = store.create(p.text, extra);
    focusId = id;
    addInput.value = "";
    addChips.replaceChildren();
    Object.assign(qa, { owner: qaDefault(), priority: null, due: null, start: null });
    syncQa();
    narrow("");
    paintLike("");
  });

  /* ── rows ───────────────────────────────────────────────────────────── */
  function chip(ic, text, cls = "") {
    return h("span", { class: "chip " + cls }, icon(ic), text);
  }

  function renderRow(t, row) {
    row = row || h("div", { class: "task", dataset: { id: t.id }, draggable: true, title: "" });
    if (row.dataset.editing) { row.dataset.stale = "1"; return row; }
    const open = expanded.has(t.id);
    row.className = "task" + (isAi(t) ? " is-ai" : "") + (pendingAi(t) ? " is-ai-wait" : "") + (t.done ? " is-done" : "") + (t.priority && t.priority !== "none" ? " p-" + t.priority : "") +
      (open ? " is-open" : "") + (focusId === t.id ? " is-focus" : "") + (sel.has(t.id) ? " is-picked" : "") + (linger.has(t.id) ? " is-leaving" : "");
    row.draggable = true;

    const meta = [];
    if (t.due_date) {
      const overdue = !t.done && t.due_date < dayKey();
      meta.push(chip("calendar", dueLabel(t.due_date) + (t.due_time ? " " + t.due_time : ""), overdue ? "is-overdue" : t.due_date === dayKey() ? "is-today" : ""));
    }
    if (t.start_date && t.start_date > dayKey()) meta.push(chip("clock", "Starts " + dueLabel(t.start_date)));
    const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
    // the steps counter rides inline after the text: same line when it fits
    const subsChip = subs.length
      ? h("span", { class: "chip is-inline", dataset: { act: "expand" }, title: "Steps" }, icon("list"), `${subs.filter((s) => s.done).length}/${subs.length}`)
      : null;
    if (t.rec_id) meta.push(chip("undo", "Repeats"));
    const area = t.focus_id && app.areas && app.areas.get(t.focus_id);
    if (area) meta.push(chip("focus", area.title, "is-area"));
    if (seg === "done" || seg === "archive") { if (t.completed_at) meta.push(h("span", { class: "chip is-quiet", text: "Done " + relTime(new Date(t.completed_at).getTime()) })); }
    if (seg === "trash") meta.push(trashChip(t));
    // what an agent did with it: on it now, its result, or why it came back
    const aiSaid = String(t.ai_result || "");
    if (t.ai_status === "working" && !t.done) meta.push(h("span", { class: "chip is-agent", title: `${t.ai_by || "An agent"} took it ${t.ai_started ? relTime(Number(t.ai_started)) : ""}` }, icon("aiBot"), `${t.ai_by || "AI"} is on it`));
    else if (t.ai_status === "done" && aiSaid) meta.push(h("span", { class: "chip is-agent is-said", title: aiSaid }, icon("aiBot"), aiSaid.length > 70 ? aiSaid.slice(0, 68) + "…" : aiSaid));
    else if (t.ai_status === "returned") meta.push(h("span", { class: "chip is-returned", title: aiSaid || "Given back by AI" }, icon("aiBot"), "Back from AI" + (aiSaid ? `: ${aiSaid.length > 60 ? aiSaid.slice(0, 58) + "…" : aiSaid}` : "")));
    const by = store.touchedBy.get(t.id);
    if (by && Date.now() - by.at < AGENT_WINDOW) meta.push(h("span", { class: "chip is-agent", title: `Changed by ${by.by}` }, icon("sparkles"), `${by.by} · ${relTime(by.at)}`));

    const acts = h("div", { class: "task-acts" },
      h("button", { class: "icon-btn act-2", title: "Priority (1 2 3 0)", dataset: { act: "priority" } }, icon("flag")),
      h("button", { class: "icon-btn act-2", title: "Due date (T)", dataset: { act: "date" } }, icon("calendar")),
      t.deleted
        ? h("button", { class: "icon-btn act-2", title: "Restore", dataset: { act: "restore" } }, icon("undo"))
        : h("button", { class: "icon-btn act-2", title: "Move to trash (Del)", dataset: { act: "trash" } }, icon("trash")),
      h("button", { class: "icon-btn", title: "More", dataset: { act: "more" } }, icon("more")));
    // whose it is: always in sight, one click hands it over
    // AI's show always; yours on hover (always while your tasks are kept apart)
    const ownerBtn = h("button", { class: "task-owner " + (isAi(t) ? "is-ai" : "is-mine") + (pendingAi(t) ? " is-pending" : ""),
      title: pendingAi(t) ? `Given to AI - your AI agents get it at ${hhmm(Number(t.ai_from))}. Until then it is still yours: click to take it back.`
        : isAi(t) ? "AI's task. AI agents you connected (Hermes, Claude over MCP, the chat here) may pick it up and work on it.\nClick to make it yours again."
        : "Your task - you do it.\nClick to give it to AI: AI agents you connected (Hermes, Claude over MCP, the chat here) can then pick it up and work on it.",
      dataset: { act: "owner" } }, icon(isAi(t) ? "aiBot" : "me"), h("span", { class: "task-owner-say", text: pendingAi(t) ? `AI at ${hhmm(Number(t.ai_from))}` : isAi(t) ? "AI's" : "Mine" }));

    const draft = keepDraft(row);
    row.replaceChildren(
      h("button", { class: "task-check", title: "Complete (Space)", dataset: { act: "toggle" } }, icon("check")),
      h("div", { class: "task-body", dataset: { act: "expand" } },
        h("div", { class: "task-text", dataset: { act: "edit" } }, t.text || "", subsChip),
        meta.length ? h("div", { class: "task-meta" }, meta) : null,
        open ? renderSubs(t, subs) : null),
      acts);
    acts.prepend(ownerBtn);
    restoreDraft(row, draft);
    delete row.dataset.stale;
    return row;
  }

  /** The steps of a task as they are RIGHT NOW, copied so callers can edit. */
  const stepsOf = (id) => {
    const t = store.get(id);
    return Array.isArray(t && t.subtasks) ? t.subtasks.map((s) => ({ ...s })) : [];
  };

  /**
   * Which step a `.sub` row stands for, by the step's own id. A patch that
   * landed since the row was drawn may have reordered or removed steps, and
   * the position alone would then tick off - or delete - the wrong one.
   */
  function stepIndex(steps, subEl) {
    if (!subEl) return -1;
    const sid = subEl.dataset.sid;
    if (sid) {
      const byId = steps.findIndex((s) => s.id === sid);
      if (byId >= 0) return byId;
      return -1; // it is gone; doing it by position would hit a stranger
    }
    const i = Number(subEl.dataset.i);
    return Number.isInteger(i) && i >= 0 && i < steps.length ? i : -1;
  }

  function renderSubs(t, subs) {
    const addSub = h("input", { class: "sub-add", placeholder: "Add a step…", dataset: { act: "sub-add" }, spellcheck: false });
    // Enter is not obvious to everyone. So: the moment there are words in the
    // box, the next empty step shows itself underneath - click it and the one
    // you typed is kept and the box moves down to it. Clicking anywhere else
    // keeps it too; only Escape throws it away.
    const nextStep = h("button", {
      class: "sub sub-next", hidden: true, tabIndex: -1, title: "Add this step and start the next one",
      onmousedown: (e) => e.preventDefault(), // the box must not blur first
      onclick: () => commitSub(true),
    }, h("span", { class: "sub-check is-ghost" }, icon("plus")), h("span", { class: "sub-text", text: "…and the next one" }));

    function commitSub(keepOpen) {
      const text = addSub.value.trim();
      if (!text) return;
      // the steps as they are now, not as they were when this box was drawn:
      // the captured array would silently drop anything added in between
      const next = stepsOf(t.id);
      next.push({ id: uuid(), text, done: false });
      // empty the box BEFORE the write, or the draft-keeping below would
      // carry the same text into the box the re-render puts here
      addSub.value = "";
      nextStep.hidden = true;
      store.setSubtasks(t.id, next);
      if (keepOpen) requestAnimationFrame(() => { const r = rows.get(t.id); const i = r && r.querySelector(".sub-add"); if (i) i.focus(); });
    }

    addSub.addEventListener("input", () => { nextStep.hidden = !addSub.value.trim(); });
    addSub.addEventListener("blur", () => { nextStep.hidden = true; commitSub(false); });
    addSub.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { addSub.value = ""; nextStep.hidden = true; addSub.blur(); list.focus({ preventScroll: true }); return; }
      if (e.key !== "Enter") return;
      commitSub(true);
    });
    return h("div", { class: "subs" },
      subs.map((s, i) => h("div", { class: "sub" + (s.done ? " is-done" : ""), dataset: { i: String(i), sid: s.id || "" }, draggable: true, title: "Drag to reorder" },
        h("button", { class: "sub-check", title: s.done ? "Mark step not done" : "Mark step done", dataset: { act: "sub-toggle" } }, icon("check")),
        h("div", { class: "sub-text", dataset: { act: "sub-edit" }, text: s.text || "" }),
        h("button", { class: "icon-btn sub-del", title: "Remove step", dataset: { act: "sub-del" } }, icon("x")))),
      addSub, nextStep);
  }

  /* ── a half-typed step survives any re-render ───────────────────────────
     renderRow rebuilds the whole row, so the "Add a step…" box under the
     caret is thrown away and replaced. A patch from an agent, the `ord`
     renumbering the background compaction emits after boot, or the
     once-a-minute refresh below all do that - and the text being typed used
     to vanish with it, leaving the caret on <body>. */
  function keepDraft(row) {
    const inp = row.querySelector(".sub-add");
    if (!inp || (!inp.value && document.activeElement !== inp)) return null;
    return { value: inp.value, start: inp.selectionStart, end: inp.selectionEnd, focused: document.activeElement === inp };
  }

  function restoreDraft(row, draft) {
    if (!draft) return;
    const inp = row.querySelector(".sub-add");
    if (!inp) return;
    inp.value = draft.value;
    if (!draft.focused) return;
    inp.focus();
    try { inp.setSelectionRange(draft.start, draft.end); } catch {}
  }

  /* ── reconcile ──────────────────────────────────────────────────────── */
  function order() {
    let picked = theirs(store.select(seg));
    if (seg === "archive" && (arch.period !== "all" || arch.priority)) {
      const keep = new Set(filterTasks(picked, { when: "resolved", period: arch.period, priority: arch.priority }).map((t) => t.id));
      picked = picked.filter((t) => keep.has(t.id));
    }
    const ids = picked.map((t) => t.id);
    const set = new Set(ids);
    for (const id of linger.keys()) {
      if (set.has(id) || !store.get(id)) continue;
      const at = lastOrder.indexOf(id);
      ids.splice(at < 0 ? ids.length : Math.min(at, ids.length), 0, id);
      set.add(id);
    }
    // tasks finished in the last 24 hours stay visible at the bottom of Inbox (and of AI's list)
    if (seg === "inbox" || seg === "ai") {
      const done = theirs(store.select("done")).map((t) => t.id).filter((id) => !set.has(id));
      if (done.length) {
        ids.push(DONE_SEP);
        if (!app.settings.inboxDoneCollapsed) ids.push(...done);
      }
    }
    return ids;
  }

  const DONE_SEP = "__done";
  // rows the add box's words have hidden are out of reach of the keys, as they are out of sight
  const navIds = () => lastOrder.filter((id) => id !== DONE_SEP && !(rows.get(id) && rows.get(id).hidden));

  function paintSep(el) {
    const n = theirs(store.select("done")).length;
    el.className = "done-sep" + (app.settings.inboxDoneCollapsed ? " is-collapsed" : "");
    el.replaceChildren(icon("chevronDown"), `Completed today · ${n}`);
    return el;
  }

  // a repaint while a row is in the air replaces the very element being
  // dragged, and the drop then lands on nothing
  let inAir = false;
  list.addEventListener("dragstart", () => { inAir = true; });
  list.addEventListener("dragend", () => { inAir = false; if (stale) reconcile(null); });
  list.addEventListener("drop", () => { inAir = false; });

  function reconcile(dirty) {
    paintOwners();
    if (el.hidden) { stale = true; return; }
    if (inAir) { stale = true; return; }
    stale = false;
    const ids = order();
    const want = new Set(ids);
    // one or two rows leaving close their own gap; a bulk change just goes,
    // since twenty holes shutting at once is noise, not feedback
    const leaving = [];
    for (const [id, r] of rows) if (!want.has(id)) { rows.delete(id); leaving.push(r); }
    for (const r of leaving) (leaving.length > 6 ? r.remove() : collapseOut(r));
    let prev = null;
    for (const id of ids) {
      let r = rows.get(id);
      const t = store.get(id);
      if (id === DONE_SEP) {
        if (!r) {
          r = h("button", { onclick: () => { app.setSetting("inboxDoneCollapsed", !app.settings.inboxDoneCollapsed); reconcile(null); } });
          rows.set(id, r);
        }
        paintSep(r);
      } else if (!r) { r = renderRow(t); rows.set(id, r); if (dirty) r.classList.add("is-enter"); }
      else if (!dirty || dirty.has(id)) renderRow(t, r);
      const next = prev ? prev.nextSibling : list.firstChild;
      if (next !== r) list.insertBefore(r, next);
      prev = r;
    }
    lastOrder = ids;
    renderEmpty(ids.length);
    renderCounts();
    if (focusId && !want.has(focusId)) focusId = null;
  }

  function renderEmpty(n) {
    empty.hidden = n > 0;
    if (n) return;
    const text = {
      inbox: ["All clear", "Nothing waiting. Add a task above - !h for priority, @tomorrow for a due day, ^fri to start later - or let an agent add one."],
      today: ["Nothing due today", "Tasks with a due date of today or earlier appear here."],
      upcoming: ["No scheduled tasks", "Add ^tomorrow or ^fri to start a task later."],
      done: ["Nothing completed today", "Completed tasks stay here for 24 hours."],
      archive: ["Archive is empty", "Tasks completed more than a day ago."],
      trash: ["Trash is empty", "Anything you trash waits here for 24 hours, then it is deleted for good."],
      ai: ["Nothing for AI yet", "Add a task here, or give it one of yours with the button on its row. Agents and the chat see only this list."],
    }[seg];
    empty.replaceChildren(icon(SEGMENTS.find((s) => s[0] === seg)[2]), h("h3", { text: text[0] }), h("p", { text: text[1] }));
  }

  function renderCounts() {
    paintTrashNote();
    paintArch();
    const counted = {};
    for (const [id, { b, count }] of segEls) {
      b.classList.toggle("is-active", id === seg);
      const n = id === "trash" || id === "archive" ? 0 : (counted[id] = theirs(store.select(id), id).length);
      countTo(count, n, { fmt: (v) => (v ? String(v) : "") });
    }
    // the summary is about your own tasks when AI has its own (the counts above, not counted again)
    const open = counted.inbox ?? theirs(store.select("inbox"), "inbox").length;
    const today = counted.today ?? theirs(store.select("today"), "today").length;
    const overdue = theirs(store.all.filter((t) => !t.deleted && !t.done && t.due_date && t.due_date < dayKey()), "inbox").length;
    summary.textContent = [`${open} open`, today ? `${today} due` : null, overdue ? `${overdue} overdue` : null].filter(Boolean).join(" · ");
  }

  function setSegment(id) {
    if (id === seg) return;
    seg = id;
    app.setSetting("taskSegment", id);
    clearSel();
    if (id === "trash") store.sweepTrash();
    for (const r of rows.values()) r.remove();
    rows.clear();
    focusId = null;
    reconcile(null);
    animateRows(list);
    list.scrollTop = 0;
  }

  /* ── actions ────────────────────────────────────────────────────────── */
  function toggle(id) {
    const t = store.get(id);
    if (!t) return;
    const completing = !t.done;
    pushUndo(`${completing ? "finished" : "reopened"} “${short(t.text)}”`, () => { const now = store.get(id); if (now && now.done === completing) store.toggle(id); });
    // a tick by mistake: a moment to take it back, right there
    if (completing) app.toast(`Done: “${short(t.text)}”`, { ms: 5000, action: { label: "Undo", run: () => { const now = store.get(id); if (now && now.done) store.toggle(id); } } });
    if (completing && (seg === "inbox" || seg === "today" || seg === "upcoming")) {
      clearTimeout(linger.get(id));
      linger.set(id, setTimeout(() => { linger.delete(id); reconcile(new Set()); }, 900));
    }
    store.toggle(id);
    // after the patch, not before: renderRow rewrites the row's className.
    // The strike sweep only reads right on one line, so a wrapped task keeps
    // the plain line-through.
    const row = completing && rows.get(id);
    if (row && motionFull()) {
      const txt = row.querySelector(".task-text");
      row.classList.toggle("no-sweep", !txt || txt.offsetHeight > 26);
      row.classList.add("is-just-done");
      setTimeout(() => row.classList.remove("is-just-done", "no-sweep"), 340);
    }
  }

  // Ctrl+Z: the last thing done to a task here - trashed, finished, handed over - undone
  const undos = [];
  const pushUndo = (label, run) => { undos.push({ label, run }); if (undos.length > 30) undos.shift(); };
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.code !== "KeyZ" || !undos.length) return;
    if (!el.isConnected || el.hidden || el.closest("[hidden]")) return;
    const a = document.activeElement;
    if (a && a.matches("input, textarea, [contenteditable], [contenteditable] *")) return;
    if (a && a !== document.body && !el.contains(a)) return;
    if (document.querySelector(".dlg-back")) return;
    e.preventDefault();
    e.stopPropagation();
    const u = undos.pop();
    u.run();
    app.toast(`Undone: ${u.label}`, { ms: 1800 });
  }, true);

  function trash(id) {
    const t = store.get(id);
    if (!t) return;
    const next = neighbour(id);
    pushUndo(`trashed “${short(t.text)}”`, () => store.restore(id));
    store.trash(id);
    focusId = next;
    app.toast(`Moved “${short(t.text)}” to trash`, { action: { label: "Undo", run: () => store.restore(id) } });
  }

  const short = (s) => { s = (s || "").replace(/\s+/g, " "); return s.length > 40 ? s.slice(0, 39) + "…" : s; };

  function edit(id) {
    const r = rows.get(id);
    const t = store.get(id);
    if (!r || !t) return;
    const text = r.querySelector(".task-text");
    r.dataset.editing = "1";
    inlineEdit(text, t.text || "", {
      multiline: true,
      className: "task-edit",
      onCommit: (v) => { delete r.dataset.editing; store.update(id, { text: v.trim() }); list.focus({ preventScroll: true }); },
      onCancel: () => { delete r.dataset.editing; if (r.dataset.stale) renderRow(store.get(id), r); list.focus({ preventScroll: true }); },
    });
  }

  function setPriority(id, p) { for (const x of acting(id)) store.update(x, { priority: p }); }
  // T / Shift+T / R: every picked task, and Undo puts each one's own date back
  function setDue(id, due, word = "") {
    const many = acting(id);
    const was = many.map((x) => [x, (store.get(x) || {}).due_date ?? null]);
    for (const x of many) store.update(x, { due_date: due });
    const back = () => { for (const [x, d] of was) store.update(x, { due_date: d }); };
    const n = many.length > 1 ? ` · ${many.length} tasks` : "";
    pushUndo(due ? `set due ${word}${n}` : `took the date off${n}`, back);
    app.toast(due ? `Due ${word}${n}` : `Date taken off${n}`, { ms: 4000, action: { label: "Undo", run: back } });
  }

  function dateMenu(id, anchor) {
    const many = Array.isArray(id) ? id : acting(id);
    const t = store.get(many[0]);
    const set = (k, v) => { for (const x of many) store.update(x, { [k]: v }); };
    const nextMon = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return dayKey(d); };
    menu(0, 0, [
      { header: "Due" },
      { label: "Today", icon: "sun", keys: "T", run: () => set("due_date", dayKey()) },
      { label: "Tomorrow", icon: "calendar", keys: "Shift T", run: () => set("due_date", dayKey(addDays(new Date(), 1))) },
      { label: "Next week", icon: "calendar", run: () => set("due_date", nextMon()) },
      { label: "Pick a date…", icon: "edit", run: () => pickDate(many, "due_date", anchor) },
      t && t.due_date ? { label: "Clear due date", icon: "x", keys: "R", run: () => set("due_date", null) } : null,
      "sep",
      { header: "Start" },
      { label: "Start tomorrow", icon: "clock", run: () => set("start_date", dayKey(addDays(new Date(), 1))) },
      { label: "Start next week", icon: "clock", run: () => set("start_date", nextMon()) },
      t && t.start_date ? { label: "Start now", icon: "x", run: () => set("start_date", null) } : null,
    ], { anchor });
  }

  function pickDate(ids, key, anchor) {
    const t = store.get(ids[0]);
    const inp = h("input", { type: "date", class: "date-pop", value: (t && t[key]) || dayKey() });
    const r = anchor.getBoundingClientRect();
    Object.assign(inp.style, { left: Math.min(r.left, innerWidth - 180) + "px", top: r.bottom + 4 + "px" });
    document.getElementById("overlay-root").append(inp);
    inp.focus();
    try { inp.showPicker(); } catch {}
    const done = () => { if (inp.value) for (const x of ids) store.update(x, { [key]: inp.value }); inp.remove(); };
    inp.addEventListener("change", done);
    inp.addEventListener("blur", () => inp.remove());
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") inp.remove(); if (e.key === "Enter") done(); });
  }

  function priorityMenu(id, anchor) {
    const many = Array.isArray(id) ? id : acting(id);
    const t = store.get(many[0]) || {};
    menu(0, 0, ["high", "medium", "low", "none"].map((p, i) => ({
      label: PRI_LABEL[p], icon: "flag", keys: String(i === 3 ? 0 : i + 1), checked: (t.priority || "none") === p,
      run: () => { for (const x of many) store.update(x, { priority: p }); },
    })), { anchor });
  }

  function moreMenu(id, anchor) {
    const t = store.get(id);
    menu(0, 0, [
      { label: "Edit", icon: "edit", keys: "Enter", run: () => edit(id) },
      { label: "Add step", icon: "plus", run: () => {
        if (!expanded.has(id)) toggleExpand(id);
        requestAnimationFrame(() => { const r = rows.get(id); const i = r && r.querySelector(".sub-add"); if (i) i.focus(); });
      } },
      { label: expanded.has(id) ? "Hide steps" : "Show steps", icon: "list", keys: "Tab", run: () => toggleExpand(id) },
      { label: "Priority…", icon: "flag", keys: "1 2 3", run: () => priorityMenu(id, anchor) },
      { label: "Dates…", icon: "calendar", keys: "T", run: () => dateMenu(id, anchor) },
      app.areas && app.areas.all.length ? { label: "Focus area…", icon: "focus", run: () => areaMenu(id, anchor) } : null,
      { label: "Copy text", icon: "file", run: () => { navigator.clipboard.writeText(t.text || ""); app.toast("Copied", { ms: 1400 }); } },
      t.deleted ? null : { label: "Duplicate", icon: "layers", run: () => duplicate(t) },
      { label: "Turn into a note", icon: "fileText", run: () => toNote(t) },
      "sep",
      t.deleted ? { label: "Restore", icon: "undo", run: () => store.restore(id) } : null,
      t.deleted ? { label: "Delete for good…", icon: "trash", danger: true, keys: "Del", run: () => trashMany([id]) } : { label: "Move to trash", icon: "trash", danger: true, keys: "Del", run: () => trash(id) },
    ], { anchor });
  }

  function areaMenu(id, anchor) {
    const many = Array.isArray(id) ? id : acting(id);
    const t = store.get(many[0]) || {};
    const set = (v) => { for (const x of many) store.update(x, { focus_id: v }); };
    menu(0, 0, [
      ...app.areas.all.map((a) => ({ label: a.title, icon: "focus", checked: t.focus_id === a.id, run: () => set(a.id) })),
      t.focus_id ? "sep" : null,
      t.focus_id ? { label: "No focus area", icon: "x", run: () => set(null) } : null,
    ].filter(Boolean), { anchor });
  }

  async function toNote(t) {
    const first = (t.text || "Task").split("\n")[0].slice(0, 80);
    const rest = (t.text || "").split("\n").slice(1).join("\n").trim();
    const steps = (t.subtasks || []).map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n");
    const body = [rest, steps].filter(Boolean).join("\n\n") + "\n";
    app.newNote({ name: first, content: body });
  }

  // Typing on a picked task goes into its steps: the first letters are held
  // until the box exists and has the caret, so nothing is typed twice.
  let typing = null; // { id, text }
  function startStep(id, ch) {
    if (typing && typing.id === id) { typing.text += ch; return; }
    typing = { id, text: ch };
    if (!expanded.has(id)) { expanded.add(id); const r = rows.get(id); if (r) renderRow(store.get(id), r); }
    requestAnimationFrame(() => {
      const row = rows.get(id);
      const inp = row && row.querySelector(".sub-add");
      const text = typing ? typing.text : "";
      typing = null;
      if (!inp) return;
      inp.focus();
      inp.value += text;
      inp.setSelectionRange(inp.value.length, inp.value.length);
    });
  }

  function toggleExpand(id) {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    const r = rows.get(id);
    if (r) renderRow(store.get(id), r);
  }

  function neighbour(id) {
    const ids = navIds();
    const i = ids.indexOf(id);
    return ids[i + 1] || ids[i - 1] || null;
  }

  function setFocus(id, scroll = true) {
    const prev = focusId && rows.get(focusId);
    if (prev) prev.classList.remove("is-focus");
    focusId = id;
    const r = id && rows.get(id);
    if (r) { r.classList.add("is-focus"); if (scroll) r.scrollIntoView({ block: "nearest" }); }
  }

  function moveFocus(d) {
    const ids = navIds();
    if (!ids.length) return;
    const i = ids.indexOf(focusId);
    const n = i < 0 ? (d > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + d));
    setFocus(ids[n]);
  }

  function reorder(id, d) {
    // said, not silent: elsewhere the list keeps its own order (by date)
    if (seg !== "inbox") { app.toast("Alt+↑↓ moves tasks in Inbox - this list is in date order", { ms: 2600 }); return; }
    // only among open tasks: the completed block at the bottom has its own order
    const open = navIds().filter((x) => { const t = store.get(x); return t && !t.done; });
    const i = open.indexOf(id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= open.length) return;
    if (d < 0) store.place(id, open[j - 1] || null, open[j]);
    else store.place(id, open[j], open[j + 1] || null);
  }

  /* ── picking several at once ──────────────────────────────────────────
     Like a file manager, because that is what people already know: click
     picks one, Ctrl adds, Shift takes the run between, a drag across the
     empty part of the list draws a band, Ctrl+A takes everything listed.
     What you do next - tick, bin, a priority, a date - happens to all of
     them. */

  // Ctrl+A and Shift take only what is shown: a list narrowed by the add box keeps the rest out of it
  const visibleIds = () => [...list.querySelectorAll(".task")].filter((r) => !r.hidden).map((r) => r.dataset.id);
  /** What an action should act on: the picked ones, or the focused one. */
  const acting = (id) => (sel.size && (id == null || sel.has(id)) ? [...sel] : id != null ? [id] : focusId ? [focusId] : []);

  function paintSel() {
    for (const [id, r] of rows) r.classList.toggle("is-picked", sel.has(id));
    const n = sel.size;
    selBar.hidden = n < 1;
    if (!n) return;
    const ids = [...sel];
    const anyOpen = ids.some((id) => { const t = store.get(id); return t && !t.done && !t.deleted; });
    selBar.replaceChildren(
      h("span", { class: "task-selcount", text: `${n} picked` }),
      h("button", { class: "btn btn-sm", onclick: () => {
        const changed = ids.filter((id) => { const t = store.get(id); return t && !t.done === anyOpen; });
        for (const id of changed) store.toggle(id);
        clearSel();
        // several at once: one Undo for all of them (the toast and Ctrl+Z)
        const back = () => { for (const id of changed) { const t = store.get(id); if (t && !!t.done === anyOpen) store.toggle(id); } };
        pushUndo(`${anyOpen ? "completed" : "put back"} ${changed.length} tasks`, back);
        app.toast(`${anyOpen ? "Completed" : "Put back"} ${changed.length} task${changed.length === 1 ? "" : "s"}`, { ms: 5000, action: { label: "Undo", run: back } });
      } }, icon("check"), anyOpen ? "Complete" : "Put back"),
      h("button", { class: "btn btn-sm", onclick: (e) => priorityMenu(ids, e.currentTarget) }, icon("flag"), "Priority"),
      h("button", { class: "btn btn-sm", onclick: (e) => dateMenu(ids, e.currentTarget) }, icon("calendar"), "Dates"),
      app.areas && app.areas.all.length ? h("button", { class: "btn btn-sm", onclick: (e) => areaMenu(ids, e.currentTarget) }, icon("focus"), "Focus area") : "",
      // as a checklist to paste into a note, a mail or a chat - in the order they are shown
      h("button", { class: "btn btn-sm", title: "Copy them as a Markdown checklist", onclick: () => {
        const shown = (a, b) => { const x = rows.get(a), y = rows.get(b); return x && y ? (x.compareDocumentPosition(y) & 4 ? -1 : 1) : 0; };
        const list = [...sel].sort(shown).map((id) => store.get(id)).filter(Boolean).map((t) => `- [${t.done ? "x" : " "}] ${t.text}`);
        navigator.clipboard.writeText(list.join("\n") + "\n").then(() => app.toast(`${list.length} task${list.length === 1 ? "" : "s"} copied as a checklist`, { ms: 2500 }), () => {});
      } }, icon("clipboard"), "Copy"),
      h("span", { class: "task-selgap" }),
      h("button", { class: "btn btn-sm is-danger", onclick: () => trashMany(ids) }, icon("trash"), seg === "trash" ? "Delete for good" : "Trash"),
      h("button", { class: "icon-btn", title: "Clear the picking (Esc)", onclick: () => clearSel() }, icon("x")));
  }

  function setSel(ids) {
    sel.clear();
    for (const id of ids) sel.add(id);
    paintSel();
  }
  function clearSel() {
    if (!sel.size) return;
    sel.clear();
    anchorId = null;
    paintSel();
  }
  function toggleSel(id) {
    sel.has(id) ? sel.delete(id) : sel.add(id);
    anchorId = id;
    paintSel();
  }
  function rangeSel(id, add) {
    const ids = visibleIds();
    const a = ids.indexOf(anchorId == null ? id : anchorId);
    const b = ids.indexOf(id);
    if (a < 0 || b < 0) return setSel([id]);
    const run = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    if (!add) sel.clear();
    for (const x of run) sel.add(x);
    paintSel();
  }
  function selectAll() {
    setSel(visibleIds());
    anchorId = visibleIds()[0] || null;
  }

  async function trashMany(ids) {
    if (seg === "trash") {
      if (!(await confirmDialog(`Delete ${ids.length} task${ids.length === 1 ? "" : "s"} for good?`, "Their words are erased from Leonote's old copies too. This cannot be undone.", { ok: "Delete them", safe: true }))) return;
      store.purge(ids);
      app.toast(`${ids.length} deleted for good`, { ms: 3000 });
    } else {
      for (const id of ids) store.trash(id);
      app.toast(`${ids.length} moved to trash`, { ms: 5000, action: { label: "Undo", run: () => { for (const id of ids) store.restore(id); } } });
    }
    clearSel();
  }

  /* the band: drawn on the empty part of the list, picks what it crosses */
  const band = h("div", { class: "task-band", hidden: true });
  list.append(band);
  list.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".task, button, input, textarea, .inline-edit")) return;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = add ? [...sel] : [];
    const r0 = list.getBoundingClientRect();
    const x0 = e.clientX - r0.left + list.scrollLeft;
    const y0 = e.clientY - r0.top + list.scrollTop;
    let moved = false;
    try { list.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const x = ev.clientX - r0.left + list.scrollLeft;
      const y = ev.clientY - r0.top + list.scrollTop;
      if (!moved && Math.hypot(x - x0, y - y0) < 4) return;
      moved = true;
      band.hidden = false;
      Object.assign(band.style, {
        left: Math.min(x0, x) + "px", top: Math.min(y0, y) + "px",
        width: Math.abs(x - x0) + "px", height: Math.abs(y - y0) + "px",
      });
      const box = { left: Math.min(x0, x), right: Math.max(x0, x), top: Math.min(y0, y), bottom: Math.max(y0, y) };
      const hit = [];
      for (const [id, row] of rows) {
        if (id === DONE_SEP || !row.isConnected) continue;
        const top = row.offsetTop;
        const bottom = top + row.offsetHeight;
        if (bottom > box.top && top < box.bottom) hit.push(id);
      }
      setSel([...base, ...hit]);
    };
    const up = () => {
      list.removeEventListener("pointermove", move);
      list.removeEventListener("pointerup", up);
      list.removeEventListener("pointercancel", up);
      band.hidden = true;
      if (!moved && !add) clearSel();
    };
    list.addEventListener("pointermove", move);
    list.addEventListener("pointerup", up);
    list.addEventListener("pointercancel", up);
  });

  /* ── events ─────────────────────────────────────────────────────────── */
  list.addEventListener("click", (e) => {
    const r = e.target.closest(".task");
    if (!r || e.target.closest(".inline-edit, .sub-add")) return;
    const id = r.dataset.id;
    const actEl = e.target.closest("[data-act]");
    const act = actEl && actEl.dataset.act;
    setFocus(id, false);
    if (!act || act === "edit") {
      if (e.shiftKey) { e.preventDefault(); return rangeSel(id, e.ctrlKey || e.metaKey); }
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); return toggleSel(id); }
      // a plain click lets the picking go - even on a row that was picked (after Ctrl+A every row is)
      if (sel.size && (sel.size > 1 || !sel.has(id))) clearSel();
    }
    const sub = e.target.closest(".sub");
    // the steps area belongs to the steps: a near-miss there must never fold
    // the task away while you are reaching for a checkbox
    if (act === "expand" && e.target.closest(".subs")) return;
    switch (act) {
      case "toggle": return toggle(id);
      case "priority": return priorityMenu(id, actEl);
      case "date": return dateMenu(id, actEl);
      case "trash": return trash(id);
      case "restore": return store.restore(id);
      case "more": return moreMenu(id, actEl);
      case "owner": {
        const t = store.get(id);
        if (!t) return;
        const give = !isAi(t);
        const back = { owner: t.owner || "human", ai_from: t.ai_from ?? null };
        store.update(id, give ? toAi() : { owner: "human", ai_from: null });
        pushUndo(give ? `gave “${short(t.text)}” to AI` : `took “${short(t.text)}” back`, () => store.update(id, back));
        app.toast(give ? (graceMs() ? `Given to AI - agents get it at ${hhmm(Date.now() + graceMs())}` : "Given to AI") : "Yours again - out of AI's reach", { ms: 2400, action: { label: "Undo", run: () => store.update(id, back) } });
        paintOwners();
        return;
      }
      case "sub-toggle": {
        const next = stepsOf(id);
        const i = stepIndex(next, sub);
        if (i < 0) return;
        next[i].done = !next[i].done;
        return store.setSubtasks(id, next);
      }
      case "sub-del": {
        const next = stepsOf(id);
        const i = stepIndex(next, sub);
        if (i < 0) return;
        next.splice(i, 1);
        return store.setSubtasks(id, next, { expected: true });
      }
      case "sub-edit": {
        const at = stepIndex(stepsOf(id), sub);
        if (at < 0) return;
        r.dataset.editing = "1";
        sub.draggable = false; // text selection inside the editor, not a row drag
        return inlineEdit(e.target, (stepsOf(id)[at] || {}).text || "", {
          multiline: true,
          onCommit: (v) => {
            delete r.dataset.editing;
            // resolve the step again on commit: the edit may have been open
            // while an agent reordered the list
            const next = stepsOf(id);
            const i = stepIndex(next, sub);
            if (i < 0) return renderRow(store.get(id), r);
            next[i].text = v.trim();
            store.setSubtasks(id, next);
          },
          onCancel: () => { delete r.dataset.editing; if (r.dataset.stale) renderRow(store.get(id), r); },
        });
      }
      case "edit":
        // Expand at once; the second click of a double click takes that
        // back and renames instead (detail counts clicks even though the
        // re-render replaced the element under the pointer).
        if (e.detail === 2) { toggleExpand(id); return edit(id); }
        if (e.detail > 2) return;
        return toggleExpand(id);
      case "expand":
        return toggleExpand(id);
    }
  });


  list.addEventListener("contextmenu", (e) => {
    const r = e.target.closest(".task");
    if (!r) return;
    e.preventDefault();
    setFocus(r.dataset.id, false);
    moreMenu(r.dataset.id, { getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY }) });
  });

  list.addEventListener("keydown", (e) => {
    if (e.target !== list) return;
    const id = focusId;
    const k = e.code;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === "KeyA" && (e.ctrlKey || e.metaKey)) { handled(); return selectAll(); }
    if (k === "Escape" && sel.size) { handled(); return clearSel(); }
    // the list's own letters and keys are plain ones: Ctrl+X, Ctrl+R or Ctrl+Backspace ticked, undated or binned a
    // task (Alt still passes, for Alt+arrows moving one)
    if ((e.ctrlKey || e.metaKey) && !/^Arrow(Up|Down)$/.test(k)) return; // Ctrl+Shift+arrows still pick a range
    if (k === "ArrowDown" || k === "KeyJ") {
      handled();
      if (e.altKey && id) reorder(id, 1);
      else { moveFocus(1); if (e.shiftKey && focusId) rangeSel(focusId, false); }
      return;
    }
    if (k === "ArrowUp" || k === "KeyK") {
      handled();
      if (e.altKey && id) reorder(id, -1);
      else { moveFocus(-1); if (e.shiftKey && focusId) rangeSel(focusId, false); }
      return;
    }
    if (k === "KeyN" || k === "Slash") { handled(); addInput.focus(); return; }
    if (!id) return;
    // A step box asked for by typing is one frame away. Until the caret is in
    // it these keys belong to the text being typed, not to the task: Space
    // used to tick the task off and Backspace used to bin it, mid-word.
    if (typing && typing.id === id && (k === "Space" || k === "Backspace")) {
      handled();
      typing.text = k === "Space" ? typing.text + " " : typing.text.slice(0, -1);
      return;
    }
    if (k === "Space" || k === "KeyX") { handled(); for (const x of acting(id)) toggle(x); }
    else if (k === "Enter" || k === "NumpadEnter") { handled(); edit(id); }
    else if (k === "Tab") { handled(); toggleExpand(id); }
    else if (k === "Delete" || k === "Backspace") {
      handled();
      const many = acting(id);
      if (many.length > 1) trashMany(many);
      // in the trash, Del deletes (asked first), as it does for several; Restore is in the menu
      else store.get(id).deleted ? trashMany([id]) : trash(id);
    }
    else if (k === "Digit1") { handled(); setPriority(id, "high"); }
    else if (k === "Digit2") { handled(); setPriority(id, "medium"); }
    else if (k === "Digit3") { handled(); setPriority(id, "low"); }
    else if (k === "Digit0") { handled(); setPriority(id, "none"); }
    else if (k === "KeyT") { handled(); setDue(id, dayKey(addDays(new Date(), e.shiftKey ? 1 : 0)), e.shiftKey ? "tomorrow" : "today"); }
    else if (k === "KeyR") { handled(); setDue(id, null); }
    // just start typing on a picked task: it opens its steps and writes there
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== " ") {
      handled();
      startStep(id, e.key);
    }
  });

  /* ── live updates ───────────────────────────────────────────────────── */
  store.bus.on("changed", ({ ids, writers }) => {
    reconcile(ids);
    // a task that left this list is no longer picked
    let dropped = false;
    for (const id of [...sel]) if (!rows.has(id)) { sel.delete(id); dropped = true; }
    if (dropped) paintSel();
    if (writers && !el.hidden) {
      // the Live dot gives a few beats: something did come in
      live.classList.remove("is-pulse"); void live.offsetWidth; live.classList.add("is-pulse");
      for (const id of ids) {
        const r = rows.get(id);
        if (r) { r.classList.remove("is-agent-flash"); void r.offsetWidth; r.classList.add("is-agent-flash"); }
      }
    }
  });
  clockOn();

  return {
    show() {
      // a repaint after the view was away is a first paint as far as the eye
      // is concerned, so it gets the stagger; a live patch never does
      if (stale) { reconcile(null); animateRows(list); }
      clockOn();
      requestAnimationFrame(() => { if (!app.isTyping()) list.focus({ preventScroll: true }); });
    },
    focusAdd() { addInput.focus(); },
    setSegment,
  };
}
