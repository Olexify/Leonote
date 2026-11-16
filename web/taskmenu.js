// The task menu that Home and Focus share.
//
// The Tasks view has its own, richer one (it can expand steps, reorder, walk
// the list with the keyboard). This is the same handful of things people
// reach for when a task is sitting on a card somewhere else: rename it, when
// it is due, how important it is, and getting rid of it.

import { h, dayKey, addDays } from "./util.js";
import { menu, inlineEdit } from "./ui.js";

const PRI_LABEL = { high: "High", medium: "Medium", low: "Low", none: "No priority" };
const nextMonday = () => {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return dayKey(d);
};

function pickDate(app, id, key, anchor) {
  const t = app.tasks.get(id);
  const inp = h("input", { type: "date", class: "date-pop", value: (t && t[key]) || dayKey() });
  const r = anchor.getBoundingClientRect();
  Object.assign(inp.style, { left: Math.min(r.left, innerWidth - 180) + "px", top: r.bottom + 4 + "px" });
  document.getElementById("overlay-root").append(inp);
  inp.focus();
  try { inp.showPicker(); } catch {}
  const done = () => { if (inp.value) app.tasks.update(id, { [key]: inp.value }); inp.remove(); };
  inp.addEventListener("change", done);
  inp.addEventListener("blur", () => inp.remove());
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") inp.remove(); if (e.key === "Enter") done(); });
}

export function dateMenu(app, id, anchor) {
  const t = app.tasks.get(id);
  const set = (k, v) => app.tasks.update(id, { [k]: v });
  menu(0, 0, [
    { header: "Due" },
    { label: "Today", icon: "sun", run: () => set("due_date", dayKey()) },
    { label: "Tomorrow", icon: "calendar", run: () => set("due_date", dayKey(addDays(new Date(), 1))) },
    { label: "Next week", icon: "calendar", run: () => set("due_date", nextMonday()) },
    { label: "Pick a date…", icon: "edit", run: () => pickDate(app, id, "due_date", anchor) },
    t && t.due_date ? { label: "No due date", icon: "x", run: () => set("due_date", null) } : null,
    "sep",
    { header: "Start" },
    { label: "Start tomorrow", icon: "clock", run: () => set("start_date", dayKey(addDays(new Date(), 1))) },
    { label: "Start next week", icon: "clock", run: () => set("start_date", nextMonday()) },
    t && t.start_date ? { label: "Start now", icon: "x", run: () => set("start_date", null) } : null,
  ].filter(Boolean), { anchor });
}

export function priorityMenu(app, id, anchor) {
  const t = app.tasks.get(id) || {};
  menu(0, 0, ["high", "medium", "low", "none"].map((p) => ({
    label: PRI_LABEL[p], icon: "flag", checked: (t.priority || "none") === p,
    run: () => app.tasks.update(id, { priority: p }),
  })), { anchor });
}

function areaMenu(app, id, anchor) {
  const t = app.tasks.get(id) || {};
  menu(0, 0, [
    ...app.areas.all.map((a) => ({ label: a.title, icon: "focus", checked: t.focus_id === a.id, run: () => app.tasks.update(id, { focus_id: a.id }) })),
    t.focus_id ? "sep" : null,
    t.focus_id ? { label: "No focus area", icon: "x", run: () => app.tasks.update(id, { focus_id: null }) } : null,
  ].filter(Boolean), { anchor });
}

/** Trash it, and say so with a way back. */
export function trashTask(app, t) {
  app.tasks.trash(t.id);
  const first = (t.text || "Task").split("\n")[0];
  app.toast(`“${first.slice(0, 40)}${first.length > 40 ? "…" : ""}” moved to trash`, {
    ms: 6000,
    action: { label: "Undo", run: () => app.tasks.restore(t.id) },
  });
}

/** A note out of a task: its steps become a checklist. */
async function toNote(app, t) {
  const first = (t.text || "Task").split("\n")[0].slice(0, 80);
  const rest = (t.text || "").split("\n").slice(1).join("\n").trim();
  const steps = (t.subtasks || []).map((s) => `- [${s.done ? "x" : " "}] ${s.text}`).join("\n");
  const body = [rest, steps].filter(Boolean).join("\n\n");
  await app.newNote({ name: first, content: body ? body + "\n" : "" });
}

/** The same task again: dates, priority, area and steps kept, steps unticked. Its id; the toast offers Undo. */
export function duplicateTask(app, t) {
  const store = app.tasks;
  const id = store.create(t.text || "", { priority: t.priority || "none", due_date: t.due_date || null, start_date: t.start_date || null, ...(t.focus_id ? { focus_id: t.focus_id } : {}) });
  const steps = (t.subtasks || []).map((s) => ({ ...s, done: false }));
  if (steps.length) store.setSubtasks(id, steps);
  app.toast(`Duplicated “${t.text}”`, { ms: 2600, action: { label: "Undo", run: () => store.trash(id) } });
  return id;
}

/**
 * The menu itself.
 * `textEl` (optional) is the element holding the task's words: given one,
 * "Rename" edits it in place instead of sending the user to the Tasks view.
 */
export function taskMenu(app, t, anchor, { textEl, onChange } = {}) {
  if (!t) return;
  const id = t.id;
  const after = () => { if (onChange) onChange(); };
  menu(0, 0, [
    { header: (t.text || "Task").split("\n")[0].slice(0, 48), plain: true },
    { label: t.done ? "Mark as not done" : "Mark as done", icon: "check", run: () => { app.tasks.toggle(id); after(); } },
    textEl
      ? { label: "Rename", icon: "edit", run: () => inlineEdit(textEl, t.text || "", { multiline: true, onCommit: (v) => { app.tasks.update(id, { text: v.trim() }); after(); }, onCancel: after }) }
      : { label: "Edit in Tasks", icon: "edit", run: () => app.openView("tasks") },
    { label: "Priority…", icon: "flag", run: () => priorityMenu(app, id, anchor) },
    { label: "Dates…", icon: "calendar", run: () => dateMenu(app, id, anchor) },
    app.areas && app.areas.all.length ? { label: "Focus area…", icon: "focus", run: () => areaMenu(app, id, anchor) } : null,
    "sep",
    { label: "Copy text", icon: "file", run: () => navigator.clipboard.writeText(t.text || "").then(() => app.toast("Copied", { ms: 1400 }), () => {}) },
    t.deleted ? null : { label: "Duplicate", icon: "layers", run: () => { duplicateTask(app, t); after(); } },
    { label: "Turn into a note", icon: "fileText", run: () => toNote(app, t) },
    // a task that names a note ([[Note]], as a workspace's questions and a selection made a task do): one click to it
    (() => { const m = /\[\[([^\]|#]+)/.exec(t.text || ""); const p = m && app.vault.resolve(m[1].trim(), null); return p ? { label: `Open “${m[1].trim().split("/").pop()}”`, icon: "fileText", run: () => app.openNote(p) } : null; })(),
    { label: "Open in Tasks", icon: "checkSquare", run: () => app.openView("tasks") },
    "sep",
    t.deleted
      ? { label: "Restore", icon: "undo", run: () => { app.tasks.restore(id); after(); } }
      : { label: "Move to trash", icon: "trash", danger: true, keys: "Del", run: () => { trashTask(app, t); after(); } },
  ].filter(Boolean), { anchor });
}
