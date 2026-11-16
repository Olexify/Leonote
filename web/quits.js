// Breaking a habit: trackers that count clean time by themselves. No daily
// ticking - the clock runs from the start, "Relapse" (now, or a time you give)
// starts it again, and what was already won stays on the card: the last
// streak, the best one, and the days of this year kept clean.
//
// Kept in Leonote's own settings ("quitTrackers"), not in the habits file the
// older Python app shares, so neither program can drop the other's data.

import { h, uuid } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast, askDialog, confirmDialog, inlineEdit } from "./ui.js";
import { quitStats, clock, span } from "./quitstats.js";

const list = (app) => (Array.isArray(app.settings.quitTrackers) ? app.settings.quitTrackers : []);
const save = (app, next) => app.setSetting("quitTrackers", next);
const localInput = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export function mountQuits(app, into) {
  const cards = h("div", { class: "qt-list" });
  const add = h("input", { class: "qa-input", placeholder: "What are you quitting? (sugar, smoking, doomscrolling…)", spellcheck: false });
  const sec = h("section", { class: "card qt-card-wrap" },
    h("header", { class: "card-head" }, icon("shield"), h("h2", { text: "Breaking free" }), h("span", { class: "qt-sub", text: "The clock runs on its own - every clean day counts itself" })),
    h("div", { class: "qa qt-add" }, icon("plus"), add),
    cards);
  into.append(sec);

  add.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter" || !add.value.trim()) return;
    save(app, [...list(app), { id: uuid(), name: add.value.trim(), start: new Date().toISOString(), relapses: [] }]);
    add.value = "";
    paint();
  });

  const update = (id, fn) => save(app, list(app).map((q) => (q.id === id ? fn({ ...q, relapses: [...(q.relapses || [])] }) : q)));

  function relapse(q, at) {
    const before = list(app);
    const t = at ? new Date(at) : new Date();
    if (!Number.isFinite(t.getTime())) return;
    update(q.id, (x) => ({ ...x, relapses: [...x.relapses, t.toISOString()].sort() }));
    const s = quitStats(list(app).find((x) => x.id === q.id));
    toast(`A slip, not a loss: ${s.yearClean} clean day${s.yearClean === 1 ? "" : "s"} this year still count. The clock starts again.`, { ms: 7000, action: { label: "Undo", run: () => { save(app, before); paint(); } } });
    paint();
  }
  async function relapseEarlier(q) {
    const r = await askDialog("When did it happen?", [{ key: "at", label: "Date and time", type: "datetime-local", value: localInput(Date.now()) }], { ok: "Relapse at that time" });
    if (r && r.at) relapse(q, r.at);
  }
  async function editStart(q) {
    const r = await askDialog("Clean since", [{ key: "at", label: "Date and time", type: "datetime-local", value: localInput(Date.parse(q.start)) }], { ok: "Set", text: "When you stopped - earlier than today if you had already started." });
    if (!r || !r.at) return;
    const t = new Date(r.at);
    if (!Number.isFinite(t.getTime()) || t.getTime() > Date.now()) return toast("That time has not come yet", { ms: 2000 });
    update(q.id, (x) => ({ ...x, start: t.toISOString() }));
    paint();
  }
  async function remove(q) {
    if (!(await confirmDialog(`Delete “${q.name}”?`, "Its clock and its history go with it.", { ok: "Delete" }))) return;
    const before = list(app);
    save(app, before.filter((x) => x.id !== q.id));
    toast(`Deleted “${q.name}”`, { action: { label: "Undo", run: () => { save(app, before); paint(); } } });
    paint();
  }
  function history(q, anchor) {
    const rel = [...(q.relapses || [])].sort().reverse();
    menu(0, 0, [
      { header: `Clean since ${new Date(q.start).toLocaleDateString()}` },
      ...(rel.length ? rel.slice(0, 20).map((r) => ({ label: new Date(r).toLocaleString(), icon: "clock", run: () => {} })) : [{ header: "No relapses - not one", plain: true }]),
      rel.length ? "sep" : null,
      rel.length ? { label: "Take back the last relapse", icon: "undo", run: () => { update(q.id, (x) => ({ ...x, relapses: x.relapses.sort().slice(0, -1) })); paint(); } } : null,
    ], { anchor });
  }

  // the live parts of each card, updated every second without rebuilding it
  let live = [];
  function paint() {
    const now = Date.now();
    live = [];
    cards.replaceChildren(...list(app).map((q) => {
      const s = quitStats(q, now);
      const timer = h("div", { class: "qt-timer", text: clock(s.current) });
      const nextDay = h("span", { class: "qt-next", text: `Day ${s.days + 1} is won in ${clock(s.nextDayIn)}` });
      const bar = h("i", { style: { width: `${Math.round(s.progress * 100)}%` } });
      const barLabel = h("span", { class: "qt-bar-label", text: `Next: ${s.next} day${s.next === 1 ? "" : "s"}` });
      live.push({ q, timer, nextDay, bar, barLabel });
      const name = h("span", { class: "qt-name", text: q.name, title: "Double-click to rename" });
      name.addEventListener("dblclick", () => inlineEdit(name, q.name, { onCommit: (v) => { if (v.trim()) update(q.id, (x) => ({ ...x, name: v.trim() })); paint(); } }));
      const stat = (label, value, title) => h("div", { class: "qt-stat", title: title || "" }, h("b", { text: value }), h("span", { text: label }));
      return h("article", { class: "qt-card", dataset: { id: q.id } },
        h("div", { class: "qt-head" }, name,
          h("button", { class: "icon-btn", title: "More", onclick: (e) => menu(0, 0, [
            { label: "Relapse at an earlier time…", icon: "clock", run: () => relapseEarlier(q) },
            { label: "The history", icon: "list", run: () => history(q, e.target) },
            { label: "Clean since…", icon: "calendar", run: () => editStart(q) },
            "sep",
            { label: "Delete", icon: "trash", danger: true, run: () => remove(q) },
          ], { anchor: e.currentTarget }) }, icon("more"))),
        timer, nextDay,
        h("div", { class: "qt-bar", title: "To the next milestone" }, bar, barLabel),
        h("div", { class: "qt-stats" },
          stat("this year clean", `${s.yearClean} / ${s.yearTracked}`, `${Math.round((s.yearClean / Math.max(1, s.yearTracked)) * 100)}% of the days you tracked this year had no relapse`),
          stat("best streak", span(s.best)),
          stat("last streak", span(s.previous)),
          stat("relapses", String(s.relapses))),
        h("div", { class: "qt-acts" },
          h("button", { class: "btn btn-sm", title: "It happened just now. The clock starts again; nothing already won is lost.", onclick: () => relapse(q) }, "Relapse"),
          h("button", { class: "link-btn", onclick: () => relapseEarlier(q) }, "…or earlier")));
    }));
    sec.classList.toggle("is-empty", !list(app).length);
    run(); // the clock starts with the first card, stops with the last
  }

  // a second's tick, only while the cards are on screen and the window shows: an observer says when they
  // come into view or leave it, the page when the window hides - nothing wakes otherwise
  function step() {
    const now = Date.now();
    for (const x of live) {
      const s = quitStats(x.q, now);
      // a new day won: the whole card, its numbers too
      if (x.days != null && s.days !== x.days) return paint();
      x.days = s.days;
      x.timer.textContent = clock(s.current);
      x.nextDay.textContent = `Day ${s.days + 1} is won in ${clock(s.nextDayIn)}`;
      x.bar.style.width = `${Math.round(s.progress * 100)}%`;
      x.barLabel.textContent = `Next: ${s.next} day${s.next === 1 ? "" : "s"}`;
    }
  }
  let tick = 0, inView = false;
  const run = () => {
    const want = inView && !document.hidden && live.length > 0;
    if (want && !tick) { tick = setInterval(step, 1000); step(); }
    else if (!want && tick) { clearInterval(tick); tick = 0; }
  };
  const io = new IntersectionObserver((es) => { inView = es[es.length - 1].isIntersecting; run(); });
  io.observe(sec);
  document.addEventListener("visibilitychange", run);
  app.bus.on("settings", (k) => { if (k === "quitTrackers") paint(); });
  paint();
  return { paint, destroy: () => { clearInterval(tick); io.disconnect(); document.removeEventListener("visibilitychange", run); } };
}
