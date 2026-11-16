// Home: today at a glance. Due tasks, habits, today's note, recent notes and
// what your agents have been doing.

import { h, dayKey, relTime, debounce, parseDay, uuid } from "./util.js";
import { sortable } from "./ui.js";
import { icon } from "./icons.js";
import { excerpt } from "./mdparse.js";
import { parseQuickAdd } from "./taskstore.js";
import { dueLabel } from "./tasksview.js";
import { taskMenu, trashTask, priorityMenu, dateMenu } from "./taskmenu.js";
import { KIND_ICON } from "./fileview.js";

/* ── what you open most ─────────────────────────────────────────────────
   A count per note or file that fades with time (half every two weeks), so
   "most used" means lately, not ever. Kept in this computer's storage, per
   vault: every tab switch would otherwise rewrite the settings file. */
const HALF = 14 * 86400000;
export const usageScore = (e, now = Date.now()) => (e ? e.n * 0.5 ** ((now - e.at) / HALF) : 0);
/** The map after one more open of `path`: at most `keep` entries, the weakest dropped. */
export function countUse(map, path, now = Date.now(), keep = 200) {
  const u = { ...map };
  u[path] = { n: usageScore(u[path], now) + 1, at: now };
  const keys = Object.keys(u);
  if (keys.length > keep) keys.sort((a, b) => usageScore(u[a], now) - usageScore(u[b], now)).slice(0, keys.length - keep).forEach((k) => delete u[k]);
  return u;
}
const usageKey = (app) => "leonote.usage:" + String(app.vault.root || "");
// counted in memory at each switch and written once things are quiet: holding Ctrl+Tab no longer parses,
// sorts and writes the whole list for every tab passed
let held = null; // { key, map }
function readUsage(app) {
  const key = usageKey(app);
  if (held && held.key === key) return held.map;
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; }
}
/** Counts every note or file brought to the front (once per change of tab). */
export function trackUsage(app) {
  let last = "";
  const write = () => { if (held) try { localStorage.setItem(held.key, JSON.stringify(held.map)); } catch {} };
  const writeSoon = debounce(write, 2000);
  addEventListener("pagehide", write);
  app.bus.on("view", (t) => {
    if (!t || (t.kind !== "note" && t.kind !== "file") || !t.path || t.path === last) return;
    last = t.path;
    held = { key: usageKey(app), map: countUse(readUsage(app), t.path) };
    writeSoon();
  });
}

export function mountHome(app, el) {
  let stale = true;
  let kind = "task";

  const kindBtn = h("button", { class: "cap-kind", title: "Tab switches between task and daily note" });
  const capInput = h("input", { class: "cap-input", spellcheck: false });
  const cap = h("div", { class: "capture" }, kindBtn, capInput, h("kbd", { text: "Enter" }));
  const body = h("div", { class: "home-grid" });
  const greet = h("h1", { class: "home-greet" });
  const date = h("div", { class: "home-date" });
  const stats = h("div", { class: "home-stats" });

  el.append(h("div", { class: "view-inner home" }, h("header", { class: "home-head" }, h("div", {}, date, greet), stats), cap, body));

  function setKind(k) {
    kind = k;
    kindBtn.replaceChildren(icon(k === "task" ? "checkSquare" : "calendar"), k === "task" ? "Task" : "Today's note");
    capInput.placeholder = k === "task" ? "What needs doing?   !h  @tomorrow  ^fri" : "Jot something into today's note…";
  }
  setKind("task");
  kindBtn.addEventListener("click", () => { setKind(kind === "task" ? "note" : "task"); capInput.focus(); });
  capInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Tab") { e.preventDefault(); setKind(kind === "task" ? "note" : "task"); return; }
    if (e.key === "Escape") { capInput.value = ""; capInput.blur(); return; }
    if (e.key !== "Enter" || !capInput.value.trim()) return;
    if (kind === "task") {
      const p = parseQuickAdd(capInput.value, new Date(), (s) => app.areas.find(s));
      // only "!h @tomorrow" with no words: nothing to add, and what was typed stays to be finished
      if (!p.text) return;
      app.tasks.create(p.text, { priority: p.priority || "none", due_date: p.due_date, start_date: p.start_date, ...(p.focus_id ? { focus_id: p.focus_id } : {}) });
      app.toast("Task added", { action: { label: "View", run: () => app.openView("tasks") } });
    } else {
      app.appendToDaily(capInput.value.trim());
      app.toast("Added to today's note", { action: { label: "Open", run: () => app.openDaily() } });
    }
    capInput.value = "";
  });

  const card = (title, ic, action, ...kids) =>
    h("section", { class: "card" }, h("header", { class: "card-head" }, icon(ic), h("h2", { text: title }), action || null), ...kids);

  // the Today card: which tasks show their steps, which are picked, and
  // whether a row is in the air (a repaint then would drop it)
  const openTasks = new Set();
  const picked = new Set();
  let pickAnchor = null;
  let dragging = false;
  let refocusAdd = null;

  function render() {
    if (el.hidden) { stale = true; return; }
    if (dragging) { stale = true; return; }
    stale = false;
    const now = new Date();
    const hr = now.getHours();
    greet.textContent = hr < 5 ? "Good night" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
    date.textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

    const today = dayKey();
    const weekAgo = Date.now() - 7 * 86400000;
    const doneWeek = app.tasks.all.filter((t) => t.done && !t.deleted && t.completed_at && new Date(t.completed_at).getTime() > weekAgo).length;
    let words = 0;
    for (const n of app.vault.notes.values()) words += n.words;
    stats.replaceChildren(
      stat(app.vault.notes.size, app.vault.notes.size === 1 ? "note" : "notes"),
      stat(words >= 10000 ? Math.round(words / 1000) + "k" : words, "words"),
      stat(doneWeek, "done this week"));

    // Ticked off, but not gone: a task you complete stays on the card for a
    // day, faded, so an accidental tick is one click away from undone.
    const justDone = app.tasks.all
      .filter((t) => t.done && !t.deleted && t.completed_at && Date.now() - new Date(t.completed_at).getTime() < 86400000)
      .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));

    // focus: due/overdue first, then high priority
    const seen = new Set();
    const focus = [];
    for (const t of app.tasks.all) {
      if (t.deleted || t.done) continue;
      if (t.due_date && t.due_date <= today) { focus.push(t); seen.add(t.id); }
    }
    focus.sort((a, b) => a.due_date.localeCompare(b.due_date));
    for (const t of app.tasks.select("inbox")) {
      if (focus.length >= 8) break;
      if (!seen.has(t.id) && t.priority === "high") { focus.push(t); seen.add(t.id); }
    }
    for (const t of app.tasks.select("inbox")) {
      if (focus.length >= 6) break;
      if (!seen.has(t.id)) { focus.push(t); seen.add(t.id); }
    }
    // which tasks make the card is decided above; the ORDER is yours - the
    // same one the Tasks view keeps, so a row dragged here stays where it is put
    const rank = new Map(app.tasks.all.map((t, i) => [t.id, i]));
    focus.sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const shown = focus.slice(0, 8);
    for (const id of [...picked]) if (!shown.some((t) => t.id === id)) picked.delete(id);
    const areas = app.areas.all.slice(0, 6);
    const openIn = (aid) => app.tasks.all.filter((t) => t.focus_id === aid && !t.done && !t.deleted).length;
    const areasCard = card("Life focus", "focus", h("button", { class: "link-btn", onclick: () => app.openView("focus") }, "Open"),
      areas.length
        ? h("div", { class: "area-mini" }, areas.map((a, i) =>
            h("button", { class: "area-mini-row", onclick: () => app.openView("focus") },
              h("span", { class: "area-rank", text: String(i + 1) }),
              h("span", { class: "mini-text", text: a.title }),
              openIn(a.id) ? h("span", { class: "chip is-quiet", text: `${openIn(a.id)} open` }) : null)))
        : h("div", { class: "card-empty" }, "Nothing set yet. ", h("button", { class: "link-btn", onclick: () => app.openView("focus") }, "Add what matters most")));

    const taskCard = card("Today", "sun", h("button", { class: "link-btn", onclick: () => app.openView("tasks") }, "All tasks"),
      focus.length || justDone.length
        ? miniList(shown, justDone, today)
        : h("div", { class: "card-empty", text: app.tasks.all.length ? "Nothing pressing. Enjoy it." : "Type a task in the box above - !h for high priority, @fri for a due day." }));

    // habits
    const hd = app.habits && Array.isArray(app.habits.habits) ? app.habits : null;
    const doneToday = new Set((hd && hd.log && hd.log[today]) || []);
    const habitCard = card("Habits", "flame", h("button", { class: "link-btn", onclick: () => app.openView("habits") }, "Open"),
      hd && hd.habits.length
        ? h("div", { class: "habit-chips" }, hd.habits.map((x) =>
            h("button", { class: "habit-chip" + (doneToday.has(x.id) ? " is-done" : ""), onclick: () => app.toggleHabit(x.id, today) }, icon("check"), x.name)))
        : h("div", { class: "card-empty" }, "No habits yet. ", h("button", { class: "link-btn", onclick: () => app.openView("habits") }, "Add one")));

    // today's note
    const dp = app.dailyPath(today);
    const dn = app.vault.get(dp);
    const dailyCard = card("Today's note", "calendar", h("kbd", { text: "Alt D" }),
      h("button", { class: "daily-open", onclick: () => app.openDaily() },
        dn ? h("span", { class: "daily-ex", text: excerpt(dn.content, 220) || "Empty so far" }) : h("span", { class: "daily-ex is-new", text: "Start today's note" }),
        icon("forward")));

    // recent
    const recent = [...app.vault.notes.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 6);
    const recentCard = card("Recent", "clock", h("button", { class: "link-btn", onclick: () => app.palette("switcher") }, "Search"),
      recent.length
        ? h("div", { class: "recent" }, recent.map((n) =>
            h("button", { class: "recent-item", onclick: (e) => app.openNote(n.path, { newTab: e.ctrlKey }) },
              h("div", { class: "recent-title", text: n.title }),
              h("div", { class: "recent-ex", text: excerpt(n.content, 90) || " " }),
              h("div", { class: "recent-meta", text: (n.folder ? n.folder + " · " : "") + relTime(n.mtime) }))))
        : h("div", { class: "card-empty", text: "Your notes will show up here." }));

    // shortcuts: what you pinned, and what you open most lately
    const has = (p) => app.vault.notes.has(p) || app.vault.files.has(p);
    const pins = (app.settings.pinned || []).filter(has);
    const nowMs = Date.now();
    const use = readUsage(app);
    const used = Object.keys(use).filter((p) => has(p) && !pins.includes(p) && usageScore(use[p], nowMs) >= 1.5)
      .sort((a, b) => usageScore(use[b], nowMs) - usageScore(use[a], nowMs)).slice(0, 6);
    const openIt = (p, e) => (app.vault.notes.has(p) ? app.openNote(p, { newTab: e && e.ctrlKey }) : app.openFile(p, { newTab: e && e.ctrlKey }));
    const nameOf = (p) => { const b = p.slice(p.lastIndexOf("/") + 1); return app.vault.notes.has(p) ? b.replace(/\.md$/i, "") : b; };
    const icoOf = (p) => (app.vault.notes.has(p) ? "fileText" : KIND_ICON[(app.vault.files.get(p) || {}).kind] || "file");
    const scMenu = (p, e) => { e.preventDefault(); app.menu(e.clientX, e.clientY, [
      { label: "Open in a new tab", icon: "plus", run: () => openIt(p, { ctrlKey: true }) },
      { label: pins.includes(p) ? "Unpin" : "Pin", icon: "pin", run: () => app.togglePin(p) },
      { label: "Show in the file tree", icon: "folder", run: () => app.revealInTree(p) },
    ]); };
    const shortcutsCard = pins.length || used.length ? card("Shortcuts", "pin", null,
      pins.length
        ? h("div", { class: "sc-pins" }, pins.map((p) => h("button", { class: "sc-pin", title: p, onclick: (e) => openIt(p, e), oncontextmenu: (e) => scMenu(p, e) }, icon(icoOf(p)), h("span", { text: nameOf(p) }))))
        : null,
      used.length
        ? h("div", { class: "sc-used" }, h("div", { class: "sc-label", text: "Most used lately" }), used.map((p) =>
            h("button", { class: "sc-row", title: p, onclick: (e) => openIt(p, e), oncontextmenu: (e) => scMenu(p, e) }, icon(icoOf(p)),
              h("span", { class: "sc-name", text: nameOf(p) }),
              h("span", { class: "sc-where", text: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "" }))))
        : null,
      !pins.length ? h("div", { class: "sc-hint", text: "Right-click a note or file in the tree and Pin it: it waits here." }) : null) : null;

    // agents
    const acts = app.activity.slice(0, 7);
    const agentCard = card("Agent activity", "sparkles", h("span", { class: "live-dot" }, h("span", { class: "dot" }), "Live"),
      acts.length
        ? h("div", { class: "activity" }, acts.map((a) =>
            h("button", { class: "act-row", onclick: () => a.path ? app.openNote(a.path) : app.openView("tasks") },
              h("span", { class: "act-by", text: a.by }),
              h("span", { class: "act-text", text: a.text }),
              h("span", { class: "act-time", text: relTime(a.at) }))))
        : h("div", { class: "card-empty" }, "When an AI agent edits a note or ticks a task, it appears here the moment it happens. ",
            h("button", { class: "link-btn", onclick: () => { app.setSetting("aiHomeTab", "setup"); app.openView("assistant"); } }, "How to connect one")));

    body.replaceChildren(
      h("div", { class: "home-col" }, taskCard, areasCard, dailyCard),
      h("div", { class: "home-col" }, habitCard, shortcutsCard, recentCard, agentCard));
  }

  /* ── the Today card's rows ──────────────────────────────────────────── */

  const stepsOf = (id) => { const t = app.tasks.get(id); return Array.isArray(t && t.subtasks) ? t.subtasks.map((s) => ({ ...s })) : []; };

  function miniList(shown, justDone, today) {
    const ids = shown.map((t) => t.id);
    const paintPicked = () => { for (const r of listEl.querySelectorAll(".mini-item")) r.classList.toggle("is-picked", picked.has(r.dataset.id)); };

    const item = (t) => {
      // the same handful of things as the row menu in Tasks, where the hand
      // already is: the dots, or a right-click anywhere on the row
      const text = h("span", { class: "mini-text", text: (t.text || "").split("\n")[0] });
      const open = (e, anchor) => { e.preventDefault(); e.stopPropagation(); taskMenu(app, t, anchor, { textEl: text, onChange: () => render() }); };
      const steps = Array.isArray(t.subtasks) ? t.subtasks : [];
      const left = steps.filter((s) => !s.done).length;
      const isOpen = openTasks.has(t.id);
      const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
      const row = h("div", { class: "mini-task" + (t.done ? " is-done" : "") + (t.priority && t.priority !== "none" ? " p-" + t.priority : ""),
          oncontextmenu: (e) => open(e, row),
          onclick: (e) => {
            if (e.target.closest("button, .inline-edit")) return;
            if (e.shiftKey && !t.done) { // from the last one picked to here
              const a = ids.indexOf(pickAnchor);
              const b = ids.indexOf(t.id);
              if (!(e.ctrlKey || e.metaKey)) picked.clear();
              for (let i = Math.min(a < 0 ? b : a, b); i <= Math.max(a < 0 ? b : a, b); i++) picked.add(ids[i]);
              window.getSelection()?.removeAllRanges();
              return paintPicked();
            }
            if ((e.ctrlKey || e.metaKey) && !t.done) { picked.has(t.id) ? picked.delete(t.id) : picked.add(t.id); pickAnchor = t.id; return paintPicked(); }
            if (picked.size) { picked.clear(); paintPicked(); }
            pickAnchor = t.id;
            if (t.done) return;
            // a click opens the steps, right here
            openTasks.has(t.id) ? openTasks.delete(t.id) : openTasks.add(t.id);
            render();
          } },
        h("button", { class: "task-check", title: t.done ? "Put it back" : "Complete", onclick: () => { row.classList.toggle("is-done", !t.done); setTimeout(() => app.tasks.toggle(t.id), 350); } }, icon("check")),
        text,
        steps.length && !t.done ? h("span", { class: "chip is-quiet mini-steps", title: `${steps.length - left} of ${steps.length} steps done` }, icon(isOpen ? "chevronDown" : "chevron"), `${steps.length - left}/${steps.length}`) : null,
        t.done ? h("span", { class: "chip is-quiet", text: relTime(t.completed_at) }) : null,
        !t.done && t.due_date ? h("span", { class: "chip" + (t.due_date < today ? " is-overdue" : " is-today") }, dueLabel(t.due_date)) : null,
        // shown on hover, and only where the card is wide enough for them (CSS)
        t.done ? null : h("span", { class: "mini-acts" },
          h("button", { class: "mini-act", title: "Priority", onclick: stop((e) => priorityMenu(app, t.id, e.currentTarget)) }, icon("flag")),
          h("button", { class: "mini-act", title: "Due date", onclick: stop((e) => dateMenu(app, t.id, e.currentTarget)) }, icon("calendar")),
          h("button", { class: "mini-act is-danger", title: "Move to trash", onclick: stop(() => trashTask(app, t)) }, icon("trash"))),
        h("button", { class: "mini-more", title: "More…", onclick: (e) => open(e, e.currentTarget) }, icon("more")));

      let subs = null;
      if (isOpen && !t.done) {
        const add = h("input", { class: "sub-add mini-sub-add", placeholder: steps.length ? "Add a step…" : "Break it into steps…", spellcheck: false });
        const commit = (keep) => {
          const v = add.value.trim();
          if (!v) return;
          add.value = "";
          const next = stepsOf(t.id);
          next.push({ id: uuid(), text: v, done: false });
          if (keep) refocusAdd = t.id;
          app.tasks.setSubtasks(t.id, next);
        };
        add.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") commit(true); if (e.key === "Escape") { add.value = ""; add.blur(); } });
        add.addEventListener("blur", () => commit(false));
        subs = h("div", { class: "mini-subs" },
          steps.map((s2, i) => h("div", { class: "mini-sub" + (s2.done ? " is-done" : "") },
            h("button", { class: "sub-check", title: s2.done ? "Not done after all" : "Done", onclick: () => { const next = stepsOf(t.id); const at = s2.id ? next.findIndex((x) => x.id === s2.id) : i; if (at < 0) return; next[at].done = !next[at].done; app.tasks.setSubtasks(t.id, next); } }, icon("check")),
            h("span", { class: "sub-text", text: s2.text || "" }))),
          add);
        if (refocusAdd === t.id) { refocusAdd = null; requestAnimationFrame(() => add.focus({ preventScroll: true })); }
      }
      return h("div", { class: "mini-item" + (picked.has(t.id) ? " is-picked" : ""), dataset: { id: t.id }, draggable: !t.done }, row, subs);
    };

    const listEl = h("div", { class: "mini-tasks is-scroll", tabIndex: 0 }, [...shown, ...justDone].map(item));
    listEl.addEventListener("keydown", (e) => {
      if (e.target !== listEl || !picked.size) return;
      if (e.key === "Escape") { picked.clear(); paintPicked(); }
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const many = [...picked];
        picked.clear();
        for (const id of many) app.tasks.trash(id);
        app.toast(`${many.length} task${many.length === 1 ? "" : "s"} moved to trash`, { ms: 6000, action: { label: "Undo", run: () => { for (const id of many) app.tasks.restore(id); } } });
      } else if (e.key === " " || e.key === "x") { e.preventDefault(); const many = [...picked]; picked.clear(); for (const id of many) app.tasks.toggle(id); }
    });
    // a repaint while a row is in the air would drop it on the floor
    listEl.addEventListener("dragstart", () => { dragging = true; });
    listEl.addEventListener("dragend", () => { dragging = false; if (stale) render(); });
    sortable(listEl, {
      item: ".mini-item[draggable=true]",
      onMove: (from, to, elx) => {
        const dragged = elx.dataset.id;
        const group = picked.size > 1 && picked.has(dragged) ? ids.filter((id) => picked.has(id)) : [dragged];
        const rest = ids.filter((id) => !group.includes(id));
        const others = ids.filter((id) => id !== dragged); // `to` counts places without the dragged row
        const at = Math.max(0, Math.min(rest.length, to - others.slice(0, to).filter((id) => group.includes(id)).length));
        let before = rest[at - 1] || null;
        for (const id of group) { app.tasks.place(id, before, rest[at] || null); before = id; }
        dragging = false;
      },
    });
    return listEl;
  }

  const stat = (v, label) => h("div", { class: "stat" }, h("b", { text: String(v) }), h("span", { text: label }));

  const soon = debounce(render, 120);
  app.tasks.bus.on("changed", soon);
  app.bus.on("habits", soon);
  app.bus.on("areas", soon);
  app.bus.on("activity", soon);
  app.vault.bus.on("structure", soon);
  app.bus.on("settings", (k) => { if (k === "pinned") soon(); });

  return {
    show() { if (stale) render(); else soon(); },
    focusCapture() { capInput.focus(); },
  };
}
