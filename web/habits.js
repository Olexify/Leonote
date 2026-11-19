// Habits: shares ~/.leonote_habits.json with the Python app. The shape is
// {habits:[{id,name,created}], log:{"YYYY-MM-DD":[ids]}} and any other key
// in the file is preserved untouched.

import { h, dayKey, addDays, parseDay, uuid, debounce } from "./util.js";
import { icon } from "./icons.js";
import { inlineEdit, menu } from "./ui.js";
import { mountQuits } from "./quits.js";

export function streakOf(data, id, today = dayKey()) {
  const log = data.log || {};
  let d = parseDay(today);
  if (!(log[today] || []).includes(id)) d = addDays(d, -1);
  let n = 0;
  while ((log[dayKey(d)] || []).includes(id)) { n++; d = addDays(d, -1); }
  return n;
}

/** Its record: the longest run of days in a row, and how many days it was done in all. */
export function bestOf(data, id) {
  const days = Object.keys(data.log || {}).filter((k) => (data.log[k] || []).includes(id)).sort();
  let best = 0, run = 0, prev = null;
  for (const k of days) {
    run = prev && dayKey(addDays(parseDay(prev), 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { best, total: days.length };
}

export function mountHabits(app, el) {
  let stale = true;
  const grid = h("div", { class: "habit-grid" });
  const heat = h("div", { class: "heat" });
  const add = h("input", { class: "qa-input", placeholder: "New habit…", spellcheck: false });
  const sub = h("div", { class: "vh-sub" });

  el.append(h("div", { class: "view-inner habits-view" },
    h("header", { class: "vh" }, h("div", {}, h("h1", { class: "vh-title", text: "Habits" }), sub)),
    h("div", { class: "qa" }, icon("plus"), add),
    grid,
    h("div", { class: "qt-slot" }),
    h("section", { class: "card heat-card" }, h("header", { class: "card-head" }, icon("flame"), h("h2", { text: "Last 20 weeks" })), heat)));

  if (app.recurring) app.recurring.mountInto(el.querySelector(".habits-view"));
  // breaking a habit: clocks that count clean time on their own
  mountQuits(app, el.querySelector(".qt-slot"));

  const data = () => {
    if (!app.habits || typeof app.habits !== "object") app.habits = { habits: [], log: {} };
    if (!Array.isArray(app.habits.habits)) app.habits.habits = [];
    if (!app.habits.log || typeof app.habits.log !== "object") app.habits.log = {};
    return app.habits;
  };

  add.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter" || !add.value.trim()) return;
    data().habits.push({ id: uuid(), name: add.value.trim(), created: dayKey() });
    add.value = "";
    app.saveHabits();
    render();
  });

  function dayCount() {
    const w = el.clientWidth || 900;
    return w > 1100 ? 21 : w > 820 ? 14 : 7;
  }

  function render() {
    if (el.hidden) { stale = true; return; }
    stale = false;
    const d = data();
    const today = dayKey();
    const N = dayCount();
    const days = [];
    for (let i = N - 1; i >= 0; i--) days.push(addDays(new Date(), -i));

    const doneToday = (d.log[today] || []).filter((id) => d.habits.some((x) => x.id === id)).length;
    sub.textContent = d.habits.length ? `${doneToday} of ${d.habits.length} done today` : "Build something small, every day";

    const head = h("div", { class: "hg-row hg-head" },
      h("div", { class: "hg-name" }),
      h("div", { class: "hg-streak" }),
      h("div", { class: "hg-days", style: { gridTemplateColumns: `repeat(${N}, 1fr)` } },
        days.map((x) => h("div", { class: "hg-day" + (dayKey(x) === today ? " is-today" : "") },
          h("span", { text: x.toLocaleDateString(undefined, { weekday: "narrow" }) }),
          h("b", { text: String(x.getDate()) })))));

    const rows = d.habits.map((hb) => {
      const streak = streakOf(d, hb.id, today);
      const part = { start: "at the start of the day", middle: "in the middle of the day", end: "at the end of the day", any: "any time" }[hb.inBreaks];
      const name = h("div", { class: "hg-name", title: "Double-click to rename" + (part ? ` · comes up in breaks ${part}` : "") }, h("span", { class: "hg-label", text: hb.name }), part ? icon("dumbbell") : null);
      name.addEventListener("dblclick", () => rename(hb, name.firstChild));
      const items = () => [
        (() => { const r = bestOf(d, hb.id); return { header: `Best: ${r.best} day${r.best === 1 ? "" : "s"} in a row · ${r.total} in all`, plain: true }; })(),
        { label: "Rename", icon: "edit", run: () => rename(hb, name.firstChild) },
        // it can come up in a break, with the exercise: at a part of the day, or any time (Timer › Breaks)
        { label: "In breaks", icon: "dumbbell", sub: [["", "Not in breaks"], ["start", "Start of the day (before noon)"], ["middle", "Middle of the day (noon to 5 pm)"], ["end", "End of the day (after 5 pm)"], ["any", "Any time"]]
          .map(([v, label]) => ({ label, checked: (hb.inBreaks || "") === v, run: () => { if (v) hb.inBreaks = v; else delete hb.inBreaks; app.saveHabits(); render(); } })) },
        d.habits.indexOf(hb) > 0 ? { label: "Move up", icon: "arrowUp", run: () => move(hb, -1) } : null,
        d.habits.indexOf(hb) < d.habits.length - 1 ? { label: "Move down", icon: "arrowDown", run: () => move(hb, 1) } : null,
        { label: "Delete habit", icon: "trash", danger: true, run: () => remove(hb) },
      ];
      return h("div", { class: "hg-row", dataset: { id: hb.id }, oncontextmenu: (e) => { if (e.target.closest("input")) return; e.preventDefault(); menu(e.clientX, e.clientY, items()); } },
        name,
        h("div", { class: "hg-streak" + (streak ? " is-on" : "") }, icon("flame"), String(streak)),
        h("div", { class: "hg-days", style: { gridTemplateColumns: `repeat(${N}, 1fr)` } },
          days.map((x) => {
            const k = dayKey(x);
            const on = (d.log[k] || []).includes(hb.id);
            return h("button", { class: "hg-cell" + (on ? " is-on" : "") + (k === today ? " is-today" : ""), title: k, onclick: () => app.toggleHabit(hb.id, k) }, icon("check"));
          })),
        h("button", { class: "icon-btn hg-more", title: "More (or right-click the row)", onclick: (e) => menu(0, 0, items(), { anchor: e.currentTarget }) }, icon("more")));
    });

    grid.replaceChildren(head, ...(rows.length ? rows : [h("div", { class: "empty-state" }, icon("flame"), h("h3", { text: "No habits yet" }), h("p", { text: "Add one above. Tick it off every day and watch the streak grow." }))]));
    renderHeat(d);
  }

  function renderHeat(d) {
    const total = d.habits.length || 1;
    const ids = new Set(d.habits.map((x) => x.id));
    const end = new Date();
    const start = addDays(end, -(20 * 7 - 1) - end.getDay());
    const cells = [];
    for (let x = new Date(start); x <= end; x = addDays(x, 1)) {
      const k = dayKey(x);
      const n = (d.log[k] || []).filter((id) => ids.has(id)).length;
      const lvl = n === 0 ? 0 : Math.min(4, Math.ceil((n / total) * 4));
      cells.push(h("div", { class: "heat-cell l" + lvl, title: `${k}: ${n}/${d.habits.length}` }));
    }
    heat.replaceChildren(...cells);
  }

  function rename(hb, labelEl) {
    inlineEdit(labelEl, hb.name, { onCommit: (v) => { hb.name = v.trim(); app.saveHabits(); render(); } });
  }

  function move(hb, by) {
    const a = data().habits, i = a.indexOf(hb), j = i + by;
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    app.saveHabits();
    render();
  }

  function remove(hb) {
    const d = data();
    const i = d.habits.indexOf(hb);
    if (i < 0) return;
    d.habits.splice(i, 1);
    app.saveHabits();
    render();
    app.toast(`Deleted “${hb.name}”`, { action: { label: "Undo", run: () => { d.habits.splice(i, 0, hb); app.saveHabits(); render(); } } });
  }

  app.bus.on("habits", () => render());
  window.addEventListener("resize", debounce(() => { if (!el.hidden) render(); }, 150));

  return { show() { if (stale) render(); else render(); } };
}
