// The browser's history, kept like Firefox keeps it: every visit (a reload of
// the same page within half an hour folds into the last one), in a file of its
// own (~/.leonote/web-history.json, written at most every few seconds), for as
// long as you choose, with sites you never want remembered left out. Its window
// goes by time (today, yesterday, the last week, this month, each month before),
// finds by words or site:, groups by day or site or page, sorts by time, visits
// or title, and forgets a visit, a page, a site, a day or a selection.

import { h, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu, confirmDialog, askDialog, toast } from "./ui.js";
import { faviconOf } from "./favicons.js";

const FOLD_MS = 30 * 60000;
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const dayKey = (t) => { const d = new Date(t || 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const monthKey = (t) => dayKey(t).slice(0, 7);
const matchHost = (host, list) => (list || []).some((f) => host === f || host.endsWith("." + f));

/** Pages from visits (newest first): one per address, with its visit count and last visit. */
export function pagesOf(visits) {
  const by = new Map();
  for (const v of visits) {
    const p = by.get(v.url);
    if (p) { p.count++; if (!p.title && v.title) p.title = v.title; }
    else by.set(v.url, { url: v.url, title: v.title || "", at: v.at, count: 1 });
  }
  return [...by.values()];
}

/** A search over visits: plain words in title or address (all of them), and site:host. */
export function matches(v, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const host = hostOf(v.url);
  const hay = ((v.title || "") + " " + v.url).toLowerCase();
  return words.every((w) => (w.startsWith("site:") ? host === w.slice(5) || host.endsWith("." + w.slice(5)) : hay.includes(w)));
}

export function createHistory(app) {
  const S = app.settings;
  let visits = Array.isArray(S.webHistory) ? S.webHistory.slice() : [];
  let ready = false;
  const keepDays = () => (S.webHistoryDays == null ? 365 : Number(S.webHistoryDays) || 0); // 0: for ever
  const most = () => Math.max(1000, Number(S.webHistoryMax) || 20000);
  function prune() {
    const d = keepDays();
    if (d) { const since = Date.now() - d * 86400000; visits = visits.filter((v) => v.at >= since); }
    if (visits.length > most()) visits.length = most();
  }
  const save = () => { if (!ready || !app.host.webHistorySet) return; prune(); app.host.webHistorySet(JSON.stringify(visits)).catch(() => {}); };
  const saveSoon = debounce(save, 8000);
  // the file, once; what the settings held before it (the last 400 pages) moves into it
  const loaded = (async () => {
    if (!app.host.webHistoryGet) { ready = true; return; }
    try {
      const text = await app.host.webHistoryGet();
      const fromFile = text ? JSON.parse(text) : null;
      if (Array.isArray(fromFile)) {
        const seen = new Set(fromFile.map((v) => v.url + "|" + v.at));
        visits = [...visits.filter((v) => !seen.has(v.url + "|" + v.at)), ...fromFile].sort((a, b) => b.at - a.at);
      }
    } catch {}
    ready = true;
    if ((S.webHistory || []).length) { save(); app.setSetting("webHistory", []); }
    app.bus.emit("web-history");
  })();

  function visited(url, title) {
    if (S.webHistoryOn === false || !/^https?:/i.test(url)) return;
    const host = hostOf(url);
    if (matchHost(host, S.webHistoryNever)) return;
    const last = visits[0];
    if (last && last.url === url && Date.now() - last.at < FOLD_MS) { last.at = Date.now(); if (title) last.title = title; }
    else {
      // a site that keeps only its last visit: the earlier ones go
      if (matchHost(host, S.webHistoryFoldHosts)) visits = visits.filter((v) => hostOf(v.url) !== host);
      visits.unshift({ url, title: title || "", at: Date.now() });
    }
    saveSoon();
  }
  function setTitle(url, title) {
    const v = visits.find((x) => x.url === url);
    if (v && !v.title && title) { v.title = title; saveSoon(); }
  }
  // the last forgetting can be taken back from its toast
  // what went is handed back, so a toast's Undo brings back exactly what that toast was about
  function forget(test) { const gone = visits.filter(test); visits = visits.filter((v) => !test(v)); save(); app.bus.emit("web-history"); return gone; }
  function unforget(gone) {
    if (!gone || !gone.length) return;
    const have = new Set(visits.map((v) => v.url + "|" + v.at));
    visits = [...visits, ...gone.filter((v) => !have.has(v.url + "|" + v.at))].sort((a, b) => b.at - a.at);
    save(); app.bus.emit("web-history");
  }
  return { loaded, visited, setTitle, forget, unforget, visits: () => visits, pages: () => pagesOf(visits), flush: () => saveSoon.flush(), save };
}

/**
 * The history window. `ctx`: open(url), newTab(url), bookmark(url, title), isMarked(url), bookmarks() (to switch over).
 */
export function openHistory(app, H, ctx) {
  const S = app.settings;
  let range = "all", q = "", group = S.webHistoryGroup || "day", sort = S.webHistorySort || "new", limit = 600;
  const sel = new Set(); // keys of selected rows
  let anchor = null;
  const find = h("input", { class: "wt-lib-find wh-find", placeholder: "Search - words, or site:youtube.com", spellcheck: "false" });
  const side = h("div", { class: "wh-side" });
  const list = h("div", { class: "wh-list", tabIndex: 0 });
  const foot = h("div", { class: "wh-foot" });
  const groupSeg = h("div", { class: "segmented is-small" }, [["day", "By day"], ["site", "By site"], ["page", "Pages"]].map(([v, label]) => h("button", { class: "seg", dataset: { v }, onclick: () => { group = v; app.setSetting("webHistoryGroup", v); sel.clear(); draw(); } }, label)));
  const SORTS = [["new", "Newest first"], ["old", "Oldest first"], ["most", "Most visited"], ["title", "Title A-Z"]];
  const sortBtn = h("button", { class: "btn btn-sm", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, SORTS.map(([v, label]) => ({ label, checked: sort === v, run: () => { sort = v; app.setSetting("webHistorySort", v); draw(); } }))); } });
  const gear = h("button", { class: "icon-btn", title: "What history keeps", onclick: (e) => settingsMenu(e.currentTarget) }, icon("settings"));
  let offBus = null; // the window's listener goes with it
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); if (offBus) offBus(); };

  const now = () => Date.now();
  const RANGES = () => {
    const out = [["all", "Everything", () => true], ["today", "Today", (v) => dayKey(v.at) === dayKey(now())], ["yesterday", "Yesterday", (v) => dayKey(v.at) === dayKey(now() - 86400000)],
      ["week", "The last 7 days", (v) => v.at > now() - 7 * 86400000], ["month", "This month", (v) => monthKey(v.at) === monthKey(now())]];
    // each month before this one that has visits, then the rest
    const months = [...new Set(H.visits().map((v) => monthKey(v.at)))].filter((m) => m !== monthKey(now())).sort().reverse();
    for (const m of months.slice(0, 12)) out.push(["m:" + m, new Date(m + "-15T12:00").toLocaleDateString(undefined, { month: "long", year: "numeric" }), (v) => monthKey(v.at) === m]);
    if (months.length > 12) { const cut = months[11]; out.push(["older", "Older", (v) => monthKey(v.at) < cut]); }
    return out;
  };
  const inRange = () => (RANGES().find((r) => r[0] === range) || RANGES()[0])[2];
  const dayName = (k) => { if (k === dayKey(now())) return "Today"; if (k === dayKey(now() - 86400000)) return "Yesterday"; return new Date(k + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); };
  const when = (t) => (dayKey(t) === dayKey(now()) ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));

  function forgetSel() {
    if (!sel.size) return;
    const keys = new Set(sel);
    const gone = H.forget((v) => keys.has(group === "page" ? v.url : v.url + "|" + v.at)), n = gone.length;
    sel.clear();
    toast(`${n} visit${n === 1 ? "" : "s"} forgotten`, { ms: 6000, action: { label: "Undo", run: () => H.unforget(gone) } });
    draw();
  }
  function rowMenu(e, x) {
    e.preventDefault();
    const host = hostOf(x.url);
    const key = group === "page" ? x.url : x.url + "|" + x.at;
    if (!sel.has(key)) { sel.clear(); sel.add(key); paintSel(); }
    const folded = (S.webHistoryFoldHosts || []).includes(host);
    menu(e.clientX, e.clientY, [
      { header: host },
      { label: "Open", icon: "globe", run: () => { close(); ctx.open(x.url); } },
      { label: "Open in a new tab", icon: "plus", run: () => { close(); ctx.newTab(x.url); } },
      { label: "Copy the address", icon: "link", run: () => navigator.clipboard.writeText(x.url).then(() => toast("Address copied", { ms: 1600 })) },
      ctx.isMarked(x.url) ? null : { label: "Bookmark it", icon: "star", run: () => { ctx.bookmark(x.url, x.title || host); toast("Bookmarked", { ms: 1600 }); } },
      { label: `Only ${host}`, icon: "search", run: () => { find.value = q = `site:${host}`; draw(); } },
      "sep",
      sel.size > 1 ? { label: `Forget the ${sel.size} selected`, icon: "x", danger: true, run: forgetSel } : null,
      { label: "Forget every visit of this page…", icon: "x", run: () => askForget("Forget every visit of this page?", (v) => v.url === x.url) },
      { label: `Forget ${host}…`, icon: "x", run: () => askForget(`Forget every visit of ${host}?`, (v) => hostOf(v.url) === host) },
      { label: folded ? `${host}: every visit again` : `${host}: only its last visit`, icon: "clock", checked: folded, run: () => app.setSetting("webHistoryFoldHosts", folded ? (S.webHistoryFoldHosts || []).filter((f) => f !== host) : [...(S.webHistoryFoldHosts || []), host]) },
      { label: `Never remember ${host}`, icon: "eye", run: () => { app.setSetting("webHistoryNever", [...new Set([...(S.webHistoryNever || []), host])]); H.forget((v) => hostOf(v.url) === host); draw(); } },
    ].filter(Boolean));
  }
  async function askForget(title, match) {
    if (!(await confirmDialog(title, "Bookmarks stay. This cannot be taken back.", { ok: "Forget them", safe: true }))) return;
    H.forget(match); sel.clear(); draw();
  }
  function settingsMenu(at) {
    const r = at.getBoundingClientRect();
    const days = S.webHistoryDays == null ? 365 : Number(S.webHistoryDays) || 0;
    const editList = async (key, title, text) => {
      const v = await askDialog(title, [{ key: "list", label: "One site per line, without www.", type: "textarea", value: (S[key] || []).join("\n") }], { ok: "Keep", text });
      if (v) app.setSetting(key, String(v.list || "").split(/[\n,]/).map((x) => x.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean));
    };
    menu(r.right - 260, r.bottom + 4, [
      { header: "History" },
      { label: "Remember the pages I visit", checked: S.webHistoryOn !== false, run: () => app.setSetting("webHistoryOn", S.webHistoryOn === false) },
      { label: "Keep it for", icon: "clock", sub: [[30, "A month"], [90, "Three months"], [180, "Half a year"], [365, "A year"], [0, "For ever"]].map(([v, label]) => ({ label, checked: days === v, run: () => { app.setSetting("webHistoryDays", v); H.save(); draw(); } })) },
      { label: "At most", icon: "list", sub: [[5000, "5,000 visits"], [20000, "20,000 visits"], [50000, "50,000 visits"], [100000, "100,000 visits"]].map(([v, label]) => ({ label, checked: (Number(S.webHistoryMax) || 20000) === v, run: () => { app.setSetting("webHistoryMax", v); H.save(); draw(); } })) },
      "sep",
      { label: "Sites never remembered…", icon: "eye", run: () => editList("webHistoryNever", "Sites never remembered", "Visits to these sites are not written down at all.") },
      { label: "Sites that keep only their last visit…", icon: "clock", run: () => editList("webHistoryFoldHosts", "Only the last visit", "A dozen videos on one of these leaves one line.") },
    ]);
  }

  function rowsFor() {
    const test = inRange();
    let items = H.visits().filter((v) => test(v) && (!q || matches(v, q)));
    if (group === "page") items = pagesOf(items);
    const cmp = { new: (a, b) => b.at - a.at, old: (a, b) => a.at - b.at, most: (a, b) => (b.count || 0) - (a.count || 0) || b.at - a.at, title: (a, b) => (a.title || a.url).localeCompare(b.title || b.url) }[sort];
    if (sort === "most" && group !== "page") { const counts = new Map(); for (const v of items) counts.set(v.url, (counts.get(v.url) || 0) + 1); items = items.map((v) => ({ ...v, count: counts.get(v.url) })); }
    return items.sort(cmp);
  }
  const keyOf = (x) => (group === "page" ? x.url : x.url + "|" + x.at);
  function paintSel() { for (const r of list.querySelectorAll(".wh-row")) r.classList.toggle("is-sel", sel.has(r.dataset.key)); }
  function row(x, flat, i) {
    const host = hostOf(x.url);
    const fav = faviconOf(x.url);
    const key = keyOf(x);
    return h("div", { class: "wh-row" + (sel.has(key) ? " is-sel" : ""), dataset: { key, i: String(i) }, title: x.url,
      onclick: (e) => {
        if (e.shiftKey && anchor != null) { const a = Math.min(anchor, i), b = Math.max(anchor, i); if (!e.ctrlKey) sel.clear(); for (const k of flat.slice(a, b + 1)) sel.add(keyOf(k)); }
        else if (e.ctrlKey || e.metaKey) { sel.has(key) ? sel.delete(key) : sel.add(key); anchor = i; }
        else { sel.clear(); sel.add(key); anchor = i; }
        paintSel();
      },
      ondblclick: () => { close(); ctx.open(x.url); },
      onauxclick: (e) => { if (e.button === 1) ctx.newTab(x.url); },
      oncontextmenu: (e) => rowMenu(e, x) },
      fav ? h("img", { class: "wh-fav", src: fav, alt: "" }) : h("span", { class: "wh-fav is-letter", text: (host[0] || "?").toUpperCase() }),
      h("span", { class: "wh-title", text: x.title || x.url }),
      h("span", { class: "wh-site", text: host }),
      group === "page" || sort === "most" ? h("span", { class: "wh-count", text: `${x.count || 1}×` }) : h("span", { class: "wh-count" }),
      h("span", { class: "wh-when", text: when(x.at) }));
  }
  function draw() {
    for (const b of groupSeg.children) b.classList.toggle("is-active", b.dataset.v === group);
    sortBtn.replaceChildren(icon("list"), (SORTS.find((s) => s[0] === sort) || SORTS[0])[1], icon("chevronDown"));
    const all = H.visits();
    side.replaceChildren(...RANGES().map(([k, label, test]) => {
      const n = all.filter(test).length;
      return n || k === "all" || k === "today" ? h("button", { class: "wh-range" + (range === k ? " is-on" : ""), onclick: () => { range = k; sel.clear(); draw(); } }, h("span", { text: label }), h("small", { text: String(n) })) : null;
    }).filter(Boolean));
    const items = rowsFor();
    const flat = items.slice(0, limit);
    const out = [];
    if (!items.length) out.push(h("div", { class: "trash-none" }, icon("clock"), h("div", { text: q ? "Nothing matches" : all.length ? "No visits here" : S.webHistoryOn === false ? "History is off (⚙)" : "No history yet" })));
    else if (group === "page" || sort === "most" || sort === "title") flat.forEach((x, i) => out.push(row(x, flat, i)));
    else {
      // by day (in the chosen order) or by site (alphabetically, each one's visits in the chosen order):
      // a heading for each, with its count and a way to forget it
      const keyFor = group === "site" ? (v) => hostOf(v.url) : (v) => dayKey(v.at);
      const heads = new Map();
      for (const x of flat) { const k = keyFor(x); if (!heads.has(k)) heads.set(k, []); heads.get(k).push(x); }
      const order = group === "site" ? [...heads.keys()].sort((a, b) => a.localeCompare(b)) : [...heads.keys()];
      const flat2 = order.flatMap((k) => heads.get(k));
      let i = 0;
      // each heading's count from one pass, not one walk (and one address parse) per heading
      const counts = new Map();
      for (const v of items) { const c = keyFor(v); counts.set(c, (counts.get(c) || 0) + 1); }
      for (const k of order) {
        const test = (v) => keyFor(v) === k;
        out.push(h("div", { class: "wt-hist-day wh-head" }, h("span", { text: group === "site" ? k : dayName(k) }), h("span", { class: "wt-hist-n", text: String(counts.get(k) || 0) }),
          h("button", { class: "wt-link", onclick: () => { const gone = H.forget(test), n = gone.length; toast(`${n} visit${n === 1 ? "" : "s"} forgotten`, { ms: 6000, action: { label: "Undo", run: () => H.unforget(gone) } }); draw(); } }, group === "site" ? "Forget the site" : "Forget the day")));
        for (const x of heads.get(k)) out.push(row(x, flat2, i++));
      }
    }
    if (items.length > limit) out.push(h("button", { class: "btn btn-sm wh-more", onclick: () => { limit += 1000; draw(); } }, `Show more (${items.length - limit} left)`));
    list.replaceChildren(...out);
    const pages = pagesOf(all).length;
    const kb = Math.round(JSON.stringify(all).length / 1024);
    foot.replaceChildren(...[h("span", { text: `${all.length} visit${all.length === 1 ? "" : "s"} of ${pages} page${pages === 1 ? "" : "s"} · ${kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB"} · kept ${(S.webHistoryDays == null ? 365 : Number(S.webHistoryDays) || 0) ? `${S.webHistoryDays == null ? 365 : S.webHistoryDays} days` : "for ever"}` }),
      h("span", { class: "fit-fill" }),
      sel.size ? h("button", { class: "btn btn-sm", onclick: forgetSel }, icon("x"), `Forget ${sel.size} selected`) : null,
      h("button", { class: "btn btn-sm", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.top - 8, [
        { header: "Forget" },
        { label: "The last hour…", run: () => askForget("Forget the last hour's visits?", (x) => x.at > now() - 3600000) },
        { label: "The last 4 hours…", run: () => askForget("Forget the last 4 hours' visits?", (x) => x.at > now() - 4 * 3600000) },
        { label: "Today…", run: () => askForget("Forget today's visits?", (x) => dayKey(x.at) === dayKey(now())) },
        { label: "What is shown now…", run: () => { const shown = new Set(rowsFor().map(keyOf)); askForget(`Forget the ${shown.size} shown?`, (v) => shown.has(group === "page" ? v.url : v.url + "|" + v.at)); } },
        "sep",
        { label: "Everything…", icon: "trash", danger: true, run: async () => { if (await confirmDialog("Forget the whole history?", "Bookmarks stay.", { ok: "Forget it all", safe: true })) { H.forget(() => true); draw(); } } },
      ]); } }, icon("trash"), "Forget…")].filter(Boolean));
  }
  find.addEventListener("input", debounce(() => { q = find.value.trim(); sel.clear(); limit = 600; draw(); }, 120));
  find.addEventListener("keydown", (e) => e.stopPropagation());
  list.addEventListener("keydown", (e) => {
    if (e.key === "Delete") { e.preventDefault(); forgetSel(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); for (const x of rowsFor().slice(0, limit)) sel.add(keyOf(x)); paintSel(); draw(); }
    if (e.key === "Enter" && sel.size === 1) { const k = [...sel][0]; const url = k.split("|")[0]; close(); ctx.open(url); }
  });
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".menu") && document.querySelectorAll(".dlg-back").length === 1) { e.preventDefault(); e.stopPropagation(); close(); } };
  const box = h("div", { class: "dlg wt-lib wh", role: "dialog", "aria-modal": "true" },
    h("div", { class: "dlg-head" }, h("div", { class: "segmented is-small" }, h("button", { class: "seg", onclick: () => { close(); ctx.bookmarks(); } }, "Bookmarks"), h("button", { class: "seg is-active" }, "History")),
      h("span", { class: "fit-fill" }), gear, h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
    h("div", { class: "trash-bar" }, find, groupSeg, sortBtn),
    h("div", { class: "wh-body" }, side, list),
    foot);
  const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(back);
  requestAnimationFrame(() => { back.classList.add("is-in"); find.focus(); });
  offBus = app.bus.on("web-history", () => { if (back.isConnected) draw(); });
  H.loaded.then(draw);
  draw();
}
