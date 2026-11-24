// Focus: the handful of things that matter most in life, in order - the old
// Leonote's Focus tab. Shares ~/.leonote_priorities.json with the Python app
// ([{id, title, notes, subtasks:[{id,text,done}]}], array order = rank).
// Tasks belong to an area through a `focus_id` field on the task.

import { h, uuid, debounce, dayKey, TOUCH } from "./util.js";
import { icon } from "./icons.js";
import { taskMenu } from "./taskmenu.js";
import { inlineEdit, menu, sortable } from "./ui.js";
import { parseQuickAdd } from "./taskstore.js";
import { dueLabel } from "./tasksview.js";

// tasks picked with Ctrl / Shift clicks in the Focus view, acted on together
const pickedTasks = new Set();
let pickAnchor = null;
function paintPickedTasks() {
  for (const r of document.querySelectorAll(".area-card .mini-task[data-task]")) r.classList.toggle("is-picked", pickedTasks.has(r.dataset.task));
}

export function createAreas(app, initial) {
  let list = Array.isArray(initial) ? initial.filter((a) => a && typeof a === "object") : [];
  for (const a of list) {
    if (!a.id) a.id = uuid();
    if (typeof a.title !== "string") a.title = "Focus";
    if (typeof a.notes !== "string") a.notes = "";
    if (!Array.isArray(a.subtasks)) a.subtasks = [];
  }
  const persist = debounce(() => app.host.savePriorities(list).catch((e) => app.toast("Could not save focus areas: " + e, { kind: "error" })), 300);
  const changed = () => { persist(); app.bus.emit("areas"); };
  const get = (id) => list.find((a) => a.id === id);

  return {
    get all() { return list; },
    get,
    /** "+busi" in quick-add: exact title first, then a prefix ignoring spaces */
    find(name) {
      const n = String(name).toLowerCase();
      return list.find((a) => a.title.toLowerCase() === n) ||
        list.find((a) => a.title.toLowerCase().replace(/\s+/g, "").startsWith(n.replace(/\s+/g, "")));
    },
    add(title) {
      const a = { id: uuid(), title, notes: "", subtasks: [] };
      list.push(a);
      changed();
      return a;
    },
    update(id, fields) {
      const a = get(id);
      if (a) { Object.assign(a, fields); changed(); }
    },
    move(id, d) {
      const i = list.findIndex((a) => a.id === id);
      const j = i + d;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      changed();
    },
    /** Put an area at `index`, which is what dragging one does. */
    place(id, index) {
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) return;
      const [a] = list.splice(i, 1);
      list.splice(Math.max(0, Math.min(index, list.length)), 0, a);
      changed();
    },
    remove(id) {
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) return null;
      const [a] = list.splice(i, 1);
      changed();
      return { a, i };
    },
    restore(a, i) {
      list.splice(Math.min(i, list.length), 0, a);
      changed();
    },
    flush() { persist.flush(); },
  };
}

export function mountAreas(app, el) {
  const A = app.areas;
  // the picked tasks answer to the same keys as in Tasks and on Home
  document.addEventListener("keydown", (e) => {
    if (!pickedTasks.size || el.hidden || !el.isConnected || !el.offsetParent) return;
    if (e.target.closest && e.target.closest("input, textarea, [contenteditable], .inline-edit, .menu")) return;
    const many = [...pickedTasks].filter((id) => app.tasks.get(id));
    if (e.key === "Escape") { pickedTasks.clear(); paintPickedTasks(); }
    else if (e.key === "Delete") {
      pickedTasks.clear();
      for (const id of many) app.tasks.trash(id);
      app.toast(`${many.length} task${many.length === 1 ? "" : "s"} moved to trash`, { ms: 6000, action: { label: "Undo", run: () => { for (const id of many) app.tasks.restore(id); } } });
    } else if (e.key === " " || e.key === "x") { pickedTasks.clear(); for (const id of many) app.tasks.toggle(id); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  let stale = true;
  const collapsed = new Set(app.settings.areasCollapsed || []);
  const listEl = h("div", { class: "area-list" });
  // Three things can be dragged here and they all live in this list: a step
  // inside its area, a task inside its area, and a whole area by its header.
  // Moving a task to ANOTHER area is a drop on that card, below.
  sortable(listEl, {
    item: ".sub, .mini-task, .area-card",
    onMove: (from, to, el) => {
      if (el.classList.contains("area-card")) return A.place(el.dataset.id, to);
      if (el.classList.contains("mini-task")) return moveTask(el, to);
      const a = A.get(el.closest(".area-card").dataset.id);
      if (!a) return;
      const next = a.subtasks.map((s) => ({ ...s }));
      next.splice(to, 0, next.splice(from, 1)[0]);
      A.update(a.id, { subtasks: next });
    },
  });

  /** A task dragged within its own area: the order it keeps everywhere. */
  function moveTask(el, to) {
    const box = el.parentElement;
    const ids = [...box.querySelectorAll(".mini-task")].map((r) => r.dataset.task).filter(Boolean);
    const id = el.dataset.task;
    const rest = ids.filter((x) => x !== id);
    const at = Math.max(0, Math.min(rest.length, to));
    app.tasks.place(id, rest[at - 1] || null, rest[at] || null);
  }

  // a task dropped on another area card changes which area it belongs to
  const TASK_TYPE = "application/x-leonote-task";
  listEl.addEventListener("dragstart", (e) => {
    const row = e.target.closest && e.target.closest(".mini-task");
    if (!row || !row.dataset.task) return;
    try { e.dataTransfer.setData(TASK_TYPE, row.dataset.task); } catch {}
  });
  const cardUnder = (e) => e.target.closest && e.target.closest(".area-card");
  const clearCards = () => { for (const c of listEl.querySelectorAll(".is-task-drop")) c.classList.remove("is-task-drop"); };
  listEl.addEventListener("dragover", (e) => {
    const card = cardUnder(e);
    if (!card || !e.dataTransfer || ![...e.dataTransfer.types].includes(TASK_TYPE)) return;
    // inside its own area the sortable handles it; this is for the others
    if (e.target.closest(".mini-task") && e.target.closest(".area-card") === card) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearCards();
    card.classList.add("is-task-drop");
  });
  listEl.addEventListener("dragleave", (e) => { if (!listEl.contains(e.relatedTarget)) clearCards(); });
  listEl.addEventListener("drop", (e) => {
    const card = cardUnder(e);
    clearCards();
    if (!card || !e.dataTransfer) return;
    let id = "";
    try { id = e.dataTransfer.getData(TASK_TYPE); } catch {}
    if (!id) return;
    const t = app.tasks.get(id);
    if (!t || t.focus_id === card.dataset.id) return;
    e.preventDefault();
    e.stopPropagation();
    const was = t.focus_id || null;
    const area = A.get(card.dataset.id);
    app.tasks.update(id, { focus_id: card.dataset.id });
    app.toast(`Moved to ${area ? area.title : "this area"}`, {
      ms: 4000,
      action: { label: "Undo", run: () => app.tasks.update(id, { focus_id: was }) },
    });
  });
  listEl.addEventListener("dragend", clearCards);
  const addIn = h("input", { class: "qa-input", placeholder: "New focus area…", spellcheck: false });

  el.append(h("div", { class: "view-inner areas-view" },
    h("header", { class: "vh" }, h("div", {},
      h("h1", { class: "vh-title", text: "Focus" }),
      h("div", { class: "vh-sub", text: "What matters most, in order. Type +Name when adding a task to file it here." }))),
    h("div", { class: "qa" }, icon("plus"), addIn),
    listEl));

  addIn.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { addIn.value = ""; addIn.blur(); }
    if (e.key !== "Enter" || !addIn.value.trim()) return;
    A.add(addIn.value.trim());
    addIn.value = "";
  });

  const openTasks = (aid) => app.tasks.all.filter((t) => t.focus_id === aid && !t.deleted && !t.done);
  // a task ticked off stays in its area for a day, in case it was a slip
  const justDone = (aid) =>
    app.tasks.all
      .filter((t) => t.focus_id === aid && t.done && !t.deleted && t.completed_at && Date.now() - new Date(t.completed_at).getTime() < 86400000)
      .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const doneThisWeek = (aid) =>
    app.tasks.all.filter((t) => t.focus_id === aid && t.done && !t.deleted && t.completed_at && Date.now() - new Date(t.completed_at) < 7 * 86400000).length;

  function toggleCollapsed(id) {
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    app.setSetting("areasCollapsed", [...collapsed]);
    render(true);
  }

  const rename = (a, titleEl) => inlineEdit(titleEl, a.title, { onCommit: (v) => A.update(a.id, { title: v.trim() }) });

  // Enter adds it, and so does clicking away: what was typed is never lost
  // just because the person did not know the shortcut. Escape throws it away.
  function inputOn(input, onEnter) {
    const commit = () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = "";
      onEnter(v);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { input.value = ""; input.blur(); }
      if (e.key === "Enter") commit();
    });
    input.addEventListener("blur", commit);
    return input;
  }

  function card(a, i) {
    const tasks = openTasks(a.id);
    const steps = a.subtasks;
    const stepsDone = steps.filter((s) => s.done).length;
    const week = doneThisWeek(a.id);

    const title = h("div", { class: "area-title", text: a.title, title: "Double-click to rename" });
    title.addEventListener("dblclick", (e) => { e.stopPropagation(); rename(a, title); });

    const sub = [tasks.length ? `${tasks.length} open` : "no open tasks"];
    if (steps.length) sub.push(`${stepsDone}/${steps.length} steps`);
    if (week) sub.push(`${week} done this week`);

    const head = h("header", { class: "area-head", draggable: true, title: "Drag to reorder these areas", onclick: (e) => { if (!e.target.closest("button, .inline-edit")) toggleCollapsed(a.id); } },
      h("span", { class: "area-rank", text: String(i + 1) }),
      h("div", { class: "area-head-main" }, title, h("div", { class: "area-sub", text: sub.join(" · ") })),
      h("button", { class: "icon-btn", title: "More", onclick: (e) => menu(0, 0, [
        { label: "Rename", icon: "edit", run: () => rename(a, title) },
        i > 0 ? { label: "Move up", icon: "arrowUp", run: () => A.move(a.id, -1) } : null,
        i < A.all.length - 1 ? { label: "Move down", icon: "arrowDown", run: () => A.move(a.id, 1) } : null,
        "sep",
        { label: "Delete focus area", icon: "trash", danger: true, run: () => {
          const r = A.remove(a.id);
          if (r) app.toast(`Deleted “${a.title}” - its tasks stay in Tasks`, { action: { label: "Undo", run: () => A.restore(r.a, r.i) } });
        } },
      ], { anchor: e.currentTarget }) }, icon("more")),
      icon("chevronDown", "area-caret"));

    if (collapsed.has(a.id)) return h("section", { class: "area-card is-collapsed", dataset: { id: a.id } }, head);

    const notes = h("div", { class: "area-notes" + (a.notes ? "" : " is-empty"), text: a.notes || "Why this matters, what “done” looks like…" });
    notes.addEventListener("click", () => {
      const ed = inlineEdit(notes, a.notes || "", { multiline: true, onCommit: (v) => A.update(a.id, { notes: v.trim() }) });
      // allow clearing the notes entirely (inlineEdit ignores empty commits)
      ed.addEventListener("blur", () => { if (!ed.value.trim() && a.notes) A.update(a.id, { notes: "" }); });
    });

    const areaIds = tasks.map((t) => t.id);
    const taskRows = [...tasks, ...justDone(a.id)].map((t) => {
      const text = h("span", { class: "mini-text", text: (t.text || "").split("\n")[0], title: t.text || "" });
      const open = (e, anchor) => { e.preventDefault(); e.stopPropagation(); taskMenu(app, t, anchor, { textEl: text, onChange: () => render(true) }); };
      const trow = h("div", { class: "mini-task" + (t.done ? " is-done" : "") + (t.priority && t.priority !== "none" ? " p-" + t.priority : ""),
          draggable: true, dataset: { task: t.id }, title: "Drag to reorder, or onto another focus area. Ctrl-click and Shift-click pick several",
          onclick: (e) => {
            if (e.target.closest("button, .inline-edit")) return;
            if (t.done) return;
            if (e.shiftKey) { // from the last one picked to here, within this area
              const from = areaIds.indexOf(pickAnchor);
              const to = areaIds.indexOf(t.id);
              if (!(e.ctrlKey || e.metaKey)) pickedTasks.clear();
              for (let k = Math.min(from < 0 ? to : from, to); k <= Math.max(from < 0 ? to : from, to); k++) pickedTasks.add(areaIds[k]);
              window.getSelection()?.removeAllRanges();
              return paintPickedTasks();
            }
            if (e.ctrlKey || e.metaKey) { pickedTasks.has(t.id) ? pickedTasks.delete(t.id) : pickedTasks.add(t.id); pickAnchor = t.id; return paintPickedTasks(); }
            if (pickedTasks.size) { pickedTasks.clear(); paintPickedTasks(); }
            pickAnchor = t.id;
          },
          oncontextmenu: (e) => open(e, trow) },
      h("button", { class: "task-check", title: t.done ? "Put it back" : "Complete", onclick: (e) => {
        e.currentTarget.parentElement.classList.toggle("is-done", !t.done);
        setTimeout(() => app.tasks.toggle(t.id), 300);
      } }, icon("check")),
      text,
      Array.isArray(t.subtasks) && t.subtasks.length ? h("span", { class: "chip is-quiet", text: `${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}` }) : null,
      t.due_date ? h("span", { class: "chip" + (t.due_date < dayKey() ? " is-overdue" : t.due_date === dayKey() ? " is-today" : "") }, dueLabel(t.due_date)) : null,
      h("button", { class: "mini-more", title: "More…", onclick: (e) => open(e, e.currentTarget) }, icon("more")));
      if (pickedTasks.has(t.id)) trow.classList.add("is-picked");
      return trow;
    });

    const taskAdd = inputOn(h("input", { class: "sub-add", placeholder: TOUCH ? `Add a task to ${a.title}…` : `Add a task to ${a.title}…   !h @tomorrow`, spellcheck: false, dataset: { focusKey: a.id + ":task" } }), (v) => {
      const p = parseQuickAdd(v, new Date(), (s) => A.find(s));
      if (p.text) app.tasks.create(p.text, { priority: p.priority || "none", due_date: p.due_date, start_date: p.start_date, focus_id: p.focus_id || a.id });
    });

    const stepRows = steps.map((s, si) => {
      const text = h("div", { class: "sub-text", text: s.text || "" });
      text.addEventListener("dblclick", () => { if (text.parentElement) text.parentElement.draggable = false; });
      text.addEventListener("dblclick", () => inlineEdit(text, s.text || "", { multiline: true, onCommit: (v) => {
        const next = steps.map((x) => ({ ...x }));
        next[si].text = v.trim();
        A.update(a.id, { subtasks: next });
      } }));
      return h("div", { class: "sub" + (s.done ? " is-done" : ""), draggable: true, title: "Drag to reorder" },
        h("button", { class: "sub-check", onclick: () => {
          const next = steps.map((x) => ({ ...x }));
          next[si].done = !next[si].done;
          A.update(a.id, { subtasks: next });
        } }, icon("check")),
        text,
        h("button", { class: "icon-btn sub-del", title: "Remove step", onclick: () => A.update(a.id, { subtasks: steps.filter((_, k) => k !== si) }) }, icon("x")));
    });
    const stepAdd = inputOn(h("input", { class: "sub-add", placeholder: "Add a step…", spellcheck: false, dataset: { focusKey: a.id + ":step" } }), (v) => {
      A.update(a.id, { subtasks: [...steps.map((x) => ({ ...x })), { id: uuid(), text: v, done: false }] });
    });

    return h("section", { class: "area-card", dataset: { id: a.id } },
      head,
      notes,
      h("div", { class: "area-block" }, h("div", { class: "area-label", text: "Tasks" }), h("div", { class: "mini-tasks is-scroll" }, taskRows), taskAdd),
      h("div", { class: "area-block" }, h("div", { class: "area-label", text: "Steps" }), stepRows, stepAdd));
  }

  function render(force) {
    if (el.hidden) { stale = true; return; }
    // never rebuild under an open editor; its own commit triggers the next render
    if (!force && listEl.querySelector(".inline-edit")) return;
    stale = false;
    const active = document.activeElement;
    const key = active && active.dataset && active.dataset.focusKey;
    listEl.replaceChildren(...(A.all.length
      ? A.all.map(card)
      : [h("div", { class: "empty-state" }, icon("focus"), h("h3", { text: "What matters most?" }), h("p", { text: "Add a few life focus areas above - health, work, a big project - and file tasks under them." }))]));
    if (key) {
      const again = listEl.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (again) again.focus();
    }
  }

  const soon = debounce(() => render(false), 60);
  app.bus.on("areas", soon);
  app.tasks.bus.on("changed", soon);

  return { show() { if (stale) render(true); else soon(); } };
}
