// The Calendar: a month of days and what falls on each - tasks by their due
// date, recurring rules by their dates, the daily notes that exist, and the
// events of the Google calendars ticked in Settings. The day picked lists
// its things beside the grid, where a task can be added on that day, ticked
// off or given its menu; a task dragged onto another day moves its due date.

import { h, dayKey, parseDay, addDays, fmtDay, debounce, motionFull, pressable } from "./util.js";
import { icon } from "./icons.js";
import { askDialog } from "./ui.js";
import * as R from "./recurring.js";
import { gridDays } from "./gcal.js";
import { taskMenu } from "./taskmenu.js";
import { parseQuickAdd } from "./taskstore.js";

const SOURCES = [["tasks", "Tasks", "checkSquare"], ["recurring", "Recurring", "repeat"], ["workout", "Workout", "dumbbell"], ["google", "Google", "globe"]];
const MAX_CHIPS = 4; // per cell before "+n more"
const monthKey = (d) => dayKey(d).slice(0, 7);
const DRAG = "application/x-leonote-task";
const DRAG_EV = "application/x-leonote-event";

export function mountCalendar(app, el) {
  let ym = monthKey(new Date());
  let sel = dayKey();
  const hidden = () => new Set(app.settings.calHide || []);
  const weekStart = () => (app.settings.calWeekStart === 0 ? 0 : 1);

  // the title is a button: a year and its months, to jump anywhere in two clicks
  const title = h("h1", { class: "cal-title", title: "Pick a month or a year", onclick: () => monthPicker() });
  // search: what is on the calendar, by its words, over the years around this one
  const find = h("input", { class: "input cal-find", type: "search", placeholder: "Search the calendar…", spellcheck: false });
  // Ctrl+F to the calendar's search, as in the board, the Player and the PDF reader
  el.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyF") { e.preventDefault(); e.stopPropagation(); find.focus(); find.select(); } });
  find.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { find.value = ""; renderAgenda(lastBy.get(sel) || []); find.blur(); } });
  find.addEventListener("input", debounce(() => (find.value.trim() ? renderFound() : renderAgenda(lastBy.get(sel) || [])), 150));
  const legend = h("div", { class: "cal-legend" });
  const dow = h("div", { class: "cal-dow" });
  const grid = h("div", { class: "cal-grid" });
  // the weeks run on, one long page: the wheel scrolls through them, the title follows the month in view
  const scroller = h("div", { class: "cal-scroll" }, grid);
  const agenda = h("aside", { class: "cal-agenda" });
  /* The bar beside the weeks: the page's own scrollbar would leap each time more weeks are drawn, so this one
     stands for two years either side of today instead - it glides from month to month, and a drag on it flies
     through them (a click jumps). */
  const SPAN = 24;
  const thumb = h("i", { class: "cal-thumb" });
  const rail = h("div", { class: "cal-rail", title: "Drag to go through the months - two years either side of today" }, thumb);
  const monthsFromNow = (k) => { const n = new Date(); return (+k.slice(0, 4) - n.getFullYear()) * 12 + (+k.slice(5, 7) - 1 - n.getMonth()); };
  // the month the bar is centred on (0: this month); near either end it moves there, so the bar never runs out
  let railMid = 0;
  const paintRail = () => {
    const at = monthsFromNow(ym);
    if (!rail.classList.contains("is-drag") && Math.abs(at - railMid) > SPAN - 4) railMid = at;
    const f = Math.min(1, Math.max(0, (at - railMid + SPAN) / (2 * SPAN)));
    thumb.style.top = `calc(${f} * (100% - 28px))`;
    thumb.title = title.textContent;
  };
  rail.title = "Drag to go through the months - let go near an end and it centres there, to go on";
  rail.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { rail.setPointerCapture(e.pointerId); } catch {}
    rail.classList.add("is-drag");
    const n = new Date();
    const go = (ev) => {
      const r = rail.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (ev.clientY - r.top - 14) / Math.max(1, r.height - 28)));
      const k = monthKey(new Date(n.getFullYear(), n.getMonth() + railMid + Math.round(f * 2 * SPAN) - SPAN, 1));
      if (k !== ym) show(k, false);
    };
    go(e);
    const up = () => { rail.classList.remove("is-drag"); paintRail(); /* let go near an end: it centres there, to go on */ rail.removeEventListener("pointermove", go); rail.removeEventListener("pointerup", up); };
    rail.addEventListener("pointermove", go);
    rail.addEventListener("pointerup", up);
  });
  const BEFORE = 20, WEEKS = 52; // weeks drawn before the month asked for, and in all (more come as it scrolls)
  let from = null; // the first day drawn (a week's start)
  const firstRow = (k) => gridDays(k, weekStart())[0];
  /** The month `k` in view (its first week at the top): drawn around it when it is not drawn yet. */
  const show = (k, smooth = true) => {
    const at = firstRow(k);
    const i = from ? Math.round((parseDay(at) - parseDay(from)) / 864e5 / 7) : -1;
    if (i < 8 || i > WEEKS - 18) {
      const dir = k > ym ? 1 : -1;
      from = dayKey(addDays(parseDay(at), -7 * BEFORE)); ym = k; render(); rowTo(BEFORE, false);
      if (smooth && motionFull() && scroller.animate) scroller.animate([{ transform: `translateY(${dir * 70}px)`, opacity: 0.25 }, { transform: "none", opacity: 1 }], { duration: 340, easing: "cubic-bezier(.2,.8,.2,1)" });
      return;
    }
    ym = k;
    paintMonth();
    rowTo(i, smooth);
  };
  const rowTo = (i, smooth) => {
    const c = grid.children[i * 7];
    if (!c) return;
    if (smooth) { aim = null; glideBy(c.offsetTop - scroller.scrollTop); } // the same glide as the wheel
    else { aim = null; scroller.scrollTop = c.offsetTop; }
  };
  const goto = (n) => { const [y, m] = ym.split("-").map(Number); show(monthKey(new Date(y, m - 1 + n, 1))); };
  const today = () => { sel = dayKey(); show(monthKey(new Date())); };
  // how far the month in view is from this one, said beside its name; Today stands out (and points the way back) when away
  const when = h("span", { class: "cal-when" });
  const todayBtn = h("button", { class: "btn cal-today", onclick: today }, "Today");
  el.append(h("div", { class: "view-inner cal" },
    h("header", { class: "cal-head" },
      h("div", { class: "cal-nav" },
        h("button", { class: "icon-btn", title: "Previous month", onclick: () => goto(-1) }, icon("back")),
        todayBtn,
        h("button", { class: "icon-btn", title: "Next month", onclick: () => goto(1) }, icon("forward")),
        title, when),
      h("div", { class: "cal-tools" }, find, legend)),
    h("div", { class: "cal-body" }, h("div", { class: "cal-month" }, dow, h("div", { class: "cal-scroll-wrap" }, scroller, rail)), agenda)));

  /** The month in view: the title, and its days bright, the others dim. */
  function paintMonth() {
    const [y, m] = ym.split("-").map(Number);
    title.textContent = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const at = monthsFromNow(ym), n = Math.abs(at), yrs = Math.floor(n / 12), mos = n % 12;
    const far = [yrs ? `${yrs} year${yrs > 1 ? "s" : ""}` : "", mos ? `${mos} month${mos > 1 ? "s" : ""}` : ""].filter(Boolean).join(" ");
    when.textContent = at === 0 ? "This month" : `${far} ${at > 0 ? "ahead" : "ago"}`;
    when.className = "cal-when " + (at === 0 ? "is-now" : at > 0 ? "is-future" : "is-past");
    const root = el.querySelector(".view-inner.cal");
    if (root) { root.dataset.when = at === 0 ? "now" : at > 0 ? "future" : "past"; root.style.setProperty("--far", String(Math.min(1, n / 12))); }
    // the further away, the stronger the mark (up to a year)
    when.style.setProperty("--far", String(Math.min(1, n / 12)));
    todayBtn.classList.toggle("btn-primary", at !== 0);
    todayBtn.textContent = at === 0 ? "Today" : at > 0 ? "← Back" : "Back →";
    todayBtn.title = at === 0 ? "This month - the selected day goes back to today" : "Back to this month, today selected";
    paintRail();
    for (const c of grid.children) c.classList.toggle("is-other", c.dataset.d.slice(0, 7) !== ym);
  }
  // scrolling: the month a third of the way down is the one in view; near either end, more weeks
  /* The wheel: each notch moves where it is going (about twice the page's own step) and the calendar glides
     there, a few frames per notch - quick notches add up instead of starting the glide over. */
  let aim = null, glideRaf = 0;
  const glide = () => {
    glideRaf = 0;
    if (aim == null) return;
    const d = aim - scroller.scrollTop;
    if (Math.abs(d) < 1) { scroller.scrollTop = aim; aim = null; return; }
    scroller.scrollTop += d * 0.3;
    glideRaf = requestAnimationFrame(glide);
  };
  const glideBy = (dy) => {
    aim = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, (aim ?? scroller.scrollTop) + dy));
    if (!glideRaf) glideRaf = requestAnimationFrame(glide);
  };
  scroller.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.shiftKey || !e.deltaY) return;
    e.preventDefault();
    glideBy((e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * scroller.clientHeight : e.deltaY) * 2);
  }, { passive: false });
  // a drag of the scrollbar is the user's own: the glide lets go
  scroller.addEventListener("pointerdown", () => { aim = null; scroller.focus({ preventScroll: true }); });
  // the keys: a week (↑ ↓), a month (Page Up / Down), today (Home)
  scroller.tabIndex = -1;
  const rowH = () => (grid.children[7] ? grid.children[7].offsetTop - grid.children[0].offsetTop : 104);
  scroller.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") glideBy(rowH() * (e.key === "ArrowDown" ? 1 : -1));
    else if (e.key === "PageDown" || e.key === "PageUp") goto(e.key === "PageDown" ? 1 : -1);
    else if (e.key === "Home") today();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  let ticking = false;
  scroller.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y0 = scroller.scrollTop + scroller.clientHeight / 3;
      let row = 0;
      for (let i = 0; i < WEEKS; i++) { const c = grid.children[i * 7]; if (!c || c.offsetTop > y0) break; row = i; }
      const mid = grid.children[row * 7 + 3];
      if (mid && mid.dataset.d.slice(0, 7) !== ym) { ym = mid.dataset.d.slice(0, 7); paintMonth(); }
      // near an end: drawn again around where it is, the same week kept at the same place
      if (row < 6 || row > WEEKS - 14) {
        const top = grid.children[row * 7], off = top ? top.offsetTop - scroller.scrollTop : 0;
        const day = top ? top.dataset.d : from;
        from = dayKey(addDays(parseDay(day), -7 * BEFORE));
        const was = scroller.scrollTop;
        render();
        const c = grid.children[BEFORE * 7];
        if (c) scroller.scrollTop = c.offsetTop - off;
        if (aim != null) aim += scroller.scrollTop - was;
      }
    });
  }, { passive: true }); // rAF-coalesced: at most one look per frame, and nothing while still

  // ── what is on each day ──
  function collect(days) {
    const by = new Map(days.map((d) => [d, []]));
    const add = (d, it) => { const l = by.get(d); if (l) l.push(it); };
    const off = hidden();
    const from = days[0], to = days[days.length - 1];
    const now = dayKey();
    if (!off.has("tasks")) for (const t of app.tasks.all) {
      if (t.deleted || !t.due_date || t.due_date < from || t.due_date > to) continue;
      add(t.due_date, { kind: "task", t, title: t.text, time: t.due_time || "", done: t.done, overdue: !t.done && t.due_date < now });
    }
    if (!off.has("recurring") && app.recurring) {
      const spawned = R.taskKeys(app.tasks.all); // an occurrence already a task is shown as that task
      for (const r of app.recurring.data.rules) {
        if (r.deleted || !r.active || !r.anchor) continue;
        const skip = new Set(r.skip || []);
        let cur = from < r.anchor ? r.anchor : from;
        for (let i = 0; i < days.length; i++) {
          let d;
          try { d = R.nextOccurrence(r.rule, cur, r.anchor, r.until); } catch { break; }
          if (!d || d > to) break;
          if (!skip.has(d) && !spawned.has(R.occKey(r.id, d))) add(d, { kind: "rule", r, title: r.title, time: r.time || "" });
          cur = dayKey(addDays(parseDay(d), 1));
        }
      }
    }
    if (!off.has("workout")) {
      const fit = fitData();
      if (fit) {
        const sets = new Map();
        for (const x of fit.sets || []) { const d = String(x.t || "").slice(0, 10); if (d >= from && d <= to) sets.set(d, (sets.get(d) || 0) + 1); }
        for (const [d, n] of sets) add(d, { kind: "workout", day: d, title: `Workout · ${n} set${n === 1 ? "" : "s"}`, time: "", done: true });
        for (const p of fit.programs || []) for (const sn of p.sessions || []) {
          const d = sn.done && !sn.on ? null : sn.on; // a done session with no day of its own is inside the sets above
          if (d && d >= from && d <= to) add(d, { kind: "workout", day: d, title: `${sn.name} · ${p.name}`, time: "", done: !!sn.done, overdue: !sn.done && d < now });
        }
      }
    }
    if (!off.has("google") && app.gcal) for (const it of app.gcal.events(from, dayKey(addDays(parseDay(to), 1)))) add(it.day, it);
    for (const l of by.values()) l.sort((a, b) => (a.kind === "daily") - (b.kind === "daily") || a.time.localeCompare(b.time));
    return by;
  }

  // ── the grid ──
  function chip(it) {
    const c = h("div", {
      class: "cal-item is-" + it.kind + (it.done ? " is-done" : "") + (it.overdue ? " is-overdue" : ""),
      title: it.title + (it.time ? " · " + it.time : ""), style: it.color ? { "--c": it.color } : null, draggable: it.kind === "task" || it.kind === "event",
    }, it.time ? h("span", { class: "cal-time", text: it.time }) : null, h("span", { class: "cal-text", text: it.title }));
    if (it.kind === "task") {
      c.addEventListener("dragstart", (e) => { e.dataTransfer.setData(DRAG, it.t.id); e.dataTransfer.effectAllowed = "move"; });
      c.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); taskMenu(app, it.t, c); });
    }
    if (it.kind === "event") c.addEventListener("dragstart", (e) => { e.dataTransfer.setData(DRAG_EV, JSON.stringify({ id: it.id, cal: it.cal, day: it.day, raw: it.raw })); e.dataTransfer.effectAllowed = "move"; });
    c.addEventListener("click", (e) => { e.stopPropagation(); open(it); });
    return c;
  }

  // the workout log, read once and then kept in step by the Workout view's saves
  let fit = null, fitAsked = false;
  function fitData() {
    if (!fitAsked) { fitAsked = true; app.host.fitLoad().then((d) => { fit = d && typeof d === "object" ? d : {}; soon(); }).catch(() => { fit = {}; }); }
    return fit;
  }
  app.bus.on("fit", (d) => { fit = d; soon(); });
  function open(it) {
    if (it.kind === "workout") { app.openView("fit"); app.showFit && app.showFit({ day: it.day }); return; }
    if (it.kind === "task" || it.kind === "rule") { sel = it.kind === "task" ? it.t.due_date : sel; render(); }
    else if (it.kind === "daily") app.openDaily(it.day);
    else if (it.kind === "event" && it.link) app.host.openUrl(it.link);
  }

  function cell(d, items, now) {
    const c = h("div", {
      class: "cal-cell" + (d.slice(0, 7) === ym ? "" : " is-other") + (d === now ? " is-today" : "") + (d === sel ? " is-sel" : ""), dataset: { d },
      onclick: () => { sel = d; paintSel(); }, ondblclick: () => { sel = d; paintSel(); quick.focus(); },
    }, h("div", { class: "cal-day" }, h("span", { class: "cal-num", text: String(+d.slice(8)) }), d.endsWith("-01") ? h("span", { class: "cal-mon", text: parseDay(d).toLocaleDateString(undefined, { month: "short" }) }) : null),
      h("div", { class: "cal-items" }, items.slice(0, MAX_CHIPS).map(chip), items.length > MAX_CHIPS ? h("div", { class: "cal-more", text: `+${items.length - MAX_CHIPS} more` }) : null));
    c.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes(DRAG) || e.dataTransfer.types.includes(DRAG_EV)) { e.preventDefault(); c.classList.add("is-over"); } });
    c.addEventListener("dragleave", () => c.classList.remove("is-over"));
    c.addEventListener("drop", (e) => {
      c.classList.remove("is-over");
      const id = e.dataTransfer.getData(DRAG);
      if (id) {
        e.preventDefault();
        // a drop by mistake can be taken back
        const was = (app.tasks.get(id) || {}).due_date || null;
        if (was === d) return;
        app.tasks.update(id, { due_date: d });
        app.toast(`Moved to ${fmtDay(parseDay(d), { day: "numeric", month: "short" })}`, { ms: 4000, action: { label: "Undo", run: () => app.tasks.update(id, { due_date: was }) } });
        return;
      }
      const ev = e.dataTransfer.getData(DRAG_EV);
      if (ev) {
        e.preventDefault();
        const it = JSON.parse(ev);
        if (it.day === d) return;
        // a drop by mistake can be taken back here too: the Undo moves it on Google back to its day
        app.gcal.moveEvent(it, d).then((raw) => {
          if (raw) app.toast(`Moved to ${fmtDay(parseDay(d), { day: "numeric", month: "short" })}`, { ms: 5000, action: { label: "Undo", run: () => app.gcal.moveEvent({ ...it, day: d, raw }, it.day).catch((err) => app.toast(String(err.message || err), { kind: "error" })) } });
        }).catch((err) => app.toast(String(err.message || err), { kind: "error" }));
      }
    });
    return c;
  }

  // ── the day's list ──
  const quick = h("input", { class: "cal-quick", placeholder: "Add a task on this day…   !h  ^tomorrow", spellcheck: false });
  quick.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") quick.blur();
    if (e.key !== "Enter" || !quick.value.trim()) return;
    const p = parseQuickAdd(quick.value, new Date(), (s) => app.areas.find(s));
    if (!p.text) return;
    app.tasks.create(p.text, { priority: p.priority || "none", due_date: p.due_date || sel, start_date: p.start_date, ...(p.focus_id ? { focus_id: p.focus_id } : {}) });
    quick.value = "";
  });

  async function newEvent() {
    const r = await askDialog("Event on " + fmtDay(parseDay(sel), { weekday: "long", day: "numeric", month: "long" }), [{ key: "title", label: "What", placeholder: "Dentist" }, { key: "time", label: "Time, or empty for the whole day", placeholder: "14:30" }], { ok: "Add" });
    if (!r || !r.title) return;
    try { await app.gcal.addEvent({ title: r.title, day: sel, time: r.time }); }
    catch (e) { app.toast(String(e.message || e), { kind: "error" }); }
  }

  function row(it) {
    if (it.kind === "task") {
      const t = it.t;
      const r = h("div", { class: "cal-row is-task" + (t.done ? " is-done" : "") },
        h("button", { class: "task-check", title: t.done ? "Reopen" : "Done", onclick: () => app.tasks.toggle(t.id) }, icon("check")),
        h("span", { class: "cal-row-text", text: t.text }),
        it.time ? h("span", { class: "chip is-quiet", text: it.time }) : null,
        t.priority && t.priority !== "none" ? h("span", { class: "chip is-quiet p-" + t.priority }, icon("flag")) : null,
        h("button", { class: "icon-btn", title: "Menu", onclick: (e) => taskMenu(app, t, e.currentTarget) }, icon("more")));
      r.addEventListener("contextmenu", (e) => { e.preventDefault(); taskMenu(app, t, r); });
      return r;
    }
    if (it.kind === "rule") return h("div", { class: "cal-row is-link", ...pressable(() => app.openView("habits")), onclick: () => app.openView("habits") }, icon("repeat"), h("span", { class: "cal-row-text", text: it.title }), it.time ? h("span", { class: "chip is-quiet", text: it.time }) : null, h("span", { class: "chip is-quiet", text: R.describe(it.r) }));
    if (it.kind === "daily") return h("div", { class: "cal-row is-link", ...pressable(() => app.openDaily(it.day)), onclick: () => app.openDaily(it.day) }, icon("fileText"), h("span", { class: "cal-row-text", text: "Daily note" }), h("span", { class: "chip is-quiet", text: "Open" }));
    if (it.kind === "workout") return h("div", { class: "cal-row is-link", ...pressable(() => open(it)), onclick: () => open(it) }, icon("dumbbell"), h("span", { class: "cal-row-text", text: it.title }), h("span", { class: "chip" + (it.done ? " is-today" : it.overdue ? " is-overdue" : " is-quiet"), text: it.done ? "done" : "planned" }));
    return h("div", { class: "cal-row is-link", title: it.link ? "Open in Google Calendar" : "", ...pressable(() => open(it)), onclick: () => open(it), style: it.color ? { "--c": it.color } : null },
      h("span", { class: "cal-dot" }), h("span", { class: "cal-row-text", text: it.title }),
      h("span", { class: "chip is-quiet", text: it.time ? it.time + (it.end ? "–" + it.end : "") : "all day" }));
  }

  /** A year at a time, its twelve months: one click goes there. */
  function monthPicker() {
    document.querySelector(".cal-pick")?.remove();
    let year = +ym.slice(0, 4);
    const box = h("div", { class: "folder-pop cal-pick" });
    const close = () => { box.remove(); document.removeEventListener("mousedown", away, true); document.removeEventListener("keydown", keys, true); };
    const away = (e) => { if (!box.contains(e.target) && e.target !== title) close(); };
    const keys = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } else if (e.key === "PageUp" || e.key === "ArrowLeft") { year--; paint(); } else if (e.key === "PageDown" || e.key === "ArrowRight") { year++; paint(); } };
    const paint = () => {
      const now = monthKey(new Date());
      box.replaceChildren(
        h("div", { class: "cal-pick-head" },
          h("button", { class: "icon-btn", title: "A year back (←)", onclick: () => { year--; paint(); } }, icon("back")),
          h("b", { text: String(year) }),
          h("button", { class: "icon-btn", title: "A year on (→)", onclick: () => { year++; paint(); } }, icon("forward"))),
        h("div", { class: "cal-pick-months" }, Array.from({ length: 12 }, (_, i) => {
          const k = `${year}-${String(i + 1).padStart(2, "0")}`;
          return h("button", { class: "cal-pick-m" + (k === ym ? " is-on" : "") + (k === now ? " is-now" : ""), onclick: () => { close(); show(k); } },
            new Date(year, i, 1).toLocaleDateString(undefined, { month: "short" }));
        })),
        h("button", { class: "link-btn", onclick: () => { close(); today(); } }, "Today"));
    };
    paint();
    document.body.append(box);
    const r = title.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + "px", top: r.bottom + 6 + "px" });
    setTimeout(() => { document.addEventListener("mousedown", away, true); document.addEventListener("keydown", keys, true); });
  }

  /* What the search finds, on any date: tasks, workouts and recurring tasks straight from where they are kept
     (no range to walk), Google events already fetched - and, a click away, Google's own search over every date. */
  let gFound = null; // { q, items } from Google's search
  function renderFound() {
    const q = find.value.trim().toLowerCase();
    const off = hidden();
    const now0 = dayKey();
    const hits = [];
    if (!off.has("tasks")) for (const t of app.tasks.all) {
      if (t.deleted || !t.due_date || !String(t.text || "").toLowerCase().includes(q)) continue;
      hits.push([t.due_date, { kind: "task", t, title: t.text, time: t.due_time || "", done: t.done, overdue: !t.done && t.due_date < now0 }]);
    }
    // workouts: only the days that have one are looked at
    const fit = !off.has("workout") && fitData();
    if (fit) {
      const days = new Set();
      for (const x of fit.sets || []) days.add(String(x.t || "").slice(0, 10));
      for (const p of fit.programs || []) for (const sn of p.sessions || []) if (sn.on) days.add(sn.on);
      const list = [...days].filter(Boolean).sort();
      if (list.length) for (const [d, items] of collect(list)) for (const it of items) if (it.kind === "workout" && it.title.toLowerCase().includes(q)) hits.push([d, it]);
    }
    const seenEv = new Set();
    const addEv = (it) => { const k = it.id + "|" + it.day; if (!seenEv.has(k)) { seenEv.add(k); hits.push([it.day, it]); } };
    if (app.gcal && !off.has("google")) {
      for (const it of app.gcal.cachedFind(q)) addEv(it);
      if (gFound && gFound.q === q) for (const it of gFound.items) addEv(it);
    }
    // a recurring rule once, at its next day
    if (app.recurring && !hidden().has("recurring")) for (const r of app.recurring.data.rules) {
      if (r.deleted || !r.active || !String(r.title || "").toLowerCase().includes(q)) continue;
      let d = null;
      try { d = R.nextOccurrence(r.rule, dayKey(), r.anchor, r.until); } catch {}
      if (d) hits.push([d, { kind: "rule", r, title: r.title, time: r.time || "" }]);
    }
    hits.sort((a, b) => a[0].localeCompare(b[0]));
    const now = dayKey();
    const firstAhead = hits.findIndex(([d]) => d >= now);
    const list = hits.slice(0, 200).map(([d, it], i) => h("div", { class: "cal-found" + (i === firstAhead ? " is-next" : "") },
      h("button", { class: "cal-found-day", title: "Go to this day", onclick: () => { sel = d; show(d.slice(0, 7)); paintSel(true); } }, fmtDay(parseDay(d), { day: "numeric", month: "short", year: d.slice(0, 4) === now.slice(0, 4) ? undefined : "numeric" })),
      row(it)));
    // Google's events not fetched yet: its own search, on every date, when asked for
    const g = app.gcal && !off.has("google") && app.gcal.connected();
    const more = g && !(gFound && gFound.q === q) ? h("button", { class: "link-btn cal-found-more", onclick: async (e) => {
      e.currentTarget.disabled = true; e.currentTarget.textContent = "Searching Google…";
      try { gFound = { q, items: await app.gcal.search(q) }; } catch (err) { app.toast(String(err.message || err), { kind: "error" }); gFound = { q, items: [] }; }
      if (find.value.trim().toLowerCase() === q) renderFound();
    } }, `Search Google Calendar for “${find.value.trim()}” too - every date`) : null;
    agenda.replaceChildren(
      h("div", { class: "cal-agenda-head" }, h("h2", { text: hits.length ? `${hits.length} found` : "Nothing found" }),
        h("button", { class: "link-btn", onclick: () => { find.value = ""; renderAgenda(lastBy.get(sel) || []); } }, "Clear")),
      hits.length ? h("div", { class: "cal-rows cal-found-list" }, list) : h("div", { class: "cal-empty", text: "Nothing with those words on the calendar." }),
      hits.length > 200 ? h("div", { class: "cal-empty", text: `The first 200 of ${hits.length} - a word more narrows it.` }) : null,
      more);
    // the next one coming up, in view
    requestAnimationFrame(() => agenda.querySelector(".cal-found.is-next")?.scrollIntoView({ block: "nearest" }));
  }

  function renderAgenda(items) {
    const d = parseDay(sel);
    const isToday = sel === dayKey();
    const g = app.gcal;
    agenda.replaceChildren(
      h("div", { class: "cal-agenda-head" },
        h("h2", { text: fmtDay(d, { weekday: "long", day: "numeric", month: "long" }) }),
        isToday ? h("span", { class: "chip is-today", text: "Today" }) : null),
      quick,
      items.length ? h("div", { class: "cal-rows" }, items.map(row)) : h("div", { class: "cal-empty", text: "Nothing on this day - type in the box above to add a task." }),
      h("button", { class: "link-btn cal-add-ev", onclick: () => app.openDaily(sel) }, "Open this day's note"),
      ...(g && g.connected() && !hidden().has("google") ? [h("button", { class: "link-btn cal-add-ev", onclick: newEvent }, "+ Google event")] : []));
  }

  function renderLegend() {
    const off = hidden();
    const g = app.gcal;
    legend.replaceChildren(...SOURCES.map(([id, name, ic]) => {
      const on = !off.has(id);
      const b = h("button", { class: "chip-btn" + (on ? " is-on" : " is-off"), title: on ? `Hide ${name.toLowerCase()}` : `Show ${name.toLowerCase()}` }, icon(ic), id === "google" && g && !g.connected() ? "Google · connect" : name);
      b.onclick = () => {
        if (id === "google" && g && !g.connected()) { app.openSettings("Calendar"); return; }
        const next = new Set(off);
        on ? next.add(id) : next.delete(id);
        app.setSetting("calHide", [...next]);
      };
      return b;
    }));
  }

  let drawnDay = "";
  function render() {
    if (el.hidden) { stale = true; return; }
    stale = false;
    drawnDay = dayKey();
    if (!from) from = dayKey(addDays(parseDay(firstRow(ym)), -7 * BEFORE));
    const days = Array.from({ length: WEEKS * 7 }, (_, i) => dayKey(addDays(parseDay(from), i)));
    dow.replaceChildren(...days.slice(0, 7).map((d) => h("div", { text: fmtDay(parseDay(d), { weekday: "short" }) })));
    const by = collect(days);
    lastBy = by;
    const now = dayKey();
    const keep = scroller.scrollTop;
    grid.replaceChildren(...days.map((d) => cell(d, by.get(d), now)));
    scroller.scrollTop = keep;
    paintMonth();
    renderLegend();
    if (find.value.trim()) renderFound(); else renderAgenda(by.get(sel) || []);
    if (!placed && scroller.clientHeight) { placed = true; rowTo(BEFORE, false); }
  }
  let lastBy = new Map(), placed = false;
  /** A day picked: its mark moves, its list shows - nothing else is drawn again. */
  function paintSel(keepFound = false) {
    for (const c of grid.children) c.classList.toggle("is-sel", c.dataset.d === sel);
    if (keepFound && find.value.trim()) return;
    renderAgenda(lastBy.get(sel) || (collect([sel]).get(sel)) || []);
  }

  let stale = true;
  const soon = debounce(() => { if (!el.hidden) render(); else stale = true; }, 40);
  app.tasks.bus.on("changed", soon);
  app.bus.on("recurring", soon);
  app.bus.on("gcal", soon);
  app.bus.on("settings", (k) => {
    // a new first day of the week: the grid is laid out again from it (it kept the old start until a restart)
    if (k === "calWeekStart") { from = null; placed = false; }
    if (k === "calHide" || k === "calWeekStart" || k === "gcal") soon();
  });

  return {
    show(opts = {}) {
      if (opts.day) { sel = opts.day; show(sel.slice(0, 7), false); paintSel(); return; }
      // every change already marks it stale; what is left to catch is a new day
      if (stale || drawnDay !== dayKey()) render();
    },
  };
}
