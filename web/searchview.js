// Search as a page: the same query syntax as the overlay, but with room for
// scopes, every match in context, and a replace that does nothing until you
// tick the boxes. Replacing is the dangerous half, so it is opt-in twice
// (tick, then confirm) and undoable from the toast.

import { h, debounce, dirname, relTime, naturalCompare, animateRows } from "./util.js";
import { pcRootsOf, outpostList } from "./outposts.js";
import { icon } from "./icons.js";
import { confirmDialog, kbd, menu } from "./ui.js";
import { parseQuery, fuzzy, highlight, markRanges } from "./search.js";
import { filterTasks } from "./taskstore.js";
import { openPalette } from "./palette.js";
import { fmtSize, KIND_ICON } from "./fileview.js";

const MAX_PER_FILE = 300; // matches kept per file
const MAX_MATCHES = 4000; // across the whole run
const MAX_READ = 400; // non-note text files read from disk per run
const MAX_CACHED_CHARS = 32_000_000; // texts kept for the next keystroke
const UNDO_MS = 5 * 60 * 1000;
// structured documents that happen to be text: the board/sketch editors own them
const OPAQUE = /\.(canvas|leovideo|leocanvas|leopaint|leovector|excalidraw)$/i;

/* ── pure logic (tested in tests/searchview.test.js) ───────────────────── */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// \b only works between word characters; fall back to lookarounds otherwise
const wordWrap = (body) => `(?<![\\w])(?:${body})(?![\\w])`;

/**
 * Turn the query box into { re, filters }. In regex mode the whole box is one
 * pattern; otherwise it is the overlay's syntax and the positive terms become
 * one alternation. Returns { error } instead of throwing on a bad pattern.
 */
/** Texts already read, by path, at most `max` characters in all: the oldest go first, the newest always stays. */
export function boundedTexts(max) {
  const m = new Map();
  let chars = 0;
  const del = (p) => { const c = m.get(p); if (c) { chars -= c.text.length; m.delete(p); } };
  return {
    get: (p) => m.get(p),
    delete: del,
    set(p, v) {
      del(p);
      m.set(p, v);
      chars += v.text.length;
      for (const q of m.keys()) { if (chars <= max || q === p) break; del(q); }
    },
  };
}

export function buildPattern(query, { regex = false, caseSensitive = false, wholeWord = false } = {}) {
  const flags = "g" + (caseSensitive ? "" : "i");
  const q = String(query || "").trim();
  if (!q) return { re: null, terms: [], not: [], tags: [], paths: [], error: null };
  if (regex) {
    try {
      const body = wholeWord ? wordWrap(q) : q;
      return { re: new RegExp(body, flags), terms: [q], not: [], tags: [], paths: [], error: null };
    } catch (e) {
      return { re: null, terms: [], not: [], tags: [], paths: [], error: String(e.message || e) };
    }
  }
  const pq = parseQuery(q);
  if (!pq.terms.length) return { ...pq, re: null, error: null };
  // longest first, so "foobar" wins over "foo" at the same spot
  const body = [...(caseSensitive ? pq.raw : pq.terms)].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const re = new RegExp(wholeWord ? wordWrap(body) : body, flags);
  return { ...pq, re, error: null };
}

/** #tag / path: / -word filters, evaluated against a note or file. */
export function passesFilters(meta, pq) {
  const path = meta.path.toLowerCase();
  if (pq.paths && pq.paths.length && !pq.paths.every((p) => path.includes(p))) return false;
  const tags = meta.tags || [];
  if (pq.tags && pq.tags.length && !pq.tags.every((t) => tags.some((nt) => nt === t || nt.startsWith(t + "/")))) return false;
  const lower = meta.lower != null ? meta.lower : String(meta.content || "").toLowerCase();
  if (pq.not && pq.not.some((t) => lower.includes(t) || path.includes(t))) return false;
  if (pq.notPaths && pq.notPaths.some((p) => path.includes(p))) return false;
  if (pq.notTags && pq.notTags.some((t) => tags.some((nt) => nt === t || nt.startsWith(t + "/")))) return false;
  return true;
}

/** Is this path inside the chosen scope? `scope` is { kind, folder, paths }. */
export function inScope(path, scope) {
  if (!scope || scope.kind === "vault") return true;
  if (scope.kind === "folder") return !scope.folder || path === scope.folder || path.startsWith(scope.folder + "/");
  return !!(scope.paths && scope.paths.has(path));
}

/**
 * Every match in `text`, with its line and the line's text. Zero-length
 * matches are skipped: a regex that matches nothing must never be "replaced".
 */
export function findMatches(text, re, cap = MAX_PER_FILE) {
  if (!re) return [];
  const out = [];
  re.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) { re.lastIndex++; if (++guard > 100000) break; continue; }
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1) });
    if (out.length >= cap) break;
  }
  if (!out.length) return out;
  // line numbers in one pass over the newlines we actually need
  let line = 0;
  let lineStart = 0;
  let at = 0;
  for (const x of out) {
    while (at < x.start) { if (text.charCodeAt(at) === 10) { line++; lineStart = at + 1; } at++; }
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    x.line = line;
    x.lineStart = lineStart;
    x.lineText = text.slice(lineStart, lineEnd);
  }
  return out;
}

/** What a match becomes. $1…$9, $& and $$ only when the regex toggle is on. */
export function replacementFor(match, template, useRegex) {
  const t = String(template == null ? "" : template);
  if (!useRegex) return t;
  return t.replace(/\$(\$|&|[1-9])/g, (_, k) => {
    if (k === "$") return "$";
    if (k === "&") return match.text;
    const g = (match.groups || [])[Number(k) - 1];
    return g == null ? "" : g;
  });
}

/**
 * Apply only the edits given. Anything not listed is copied through
 * untouched — this is the whole safety promise of the replace panel.
 */
export function applyEdits(text, edits) {
  const list = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const e of list) {
    if (e.start < at) continue; // overlapping: keep the first, never double-write
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/** A line windowed around the match, with the hit's range inside the window. */
export function context(lineText, start, end, lineStart, width = 120) {
  const a = start - lineStart;
  const b = end - lineStart;
  let from = Math.max(0, a - 40);
  let to = Math.min(lineText.length, from + width);
  if (to - from < width) from = Math.max(0, to - width);
  const pre = from > 0 ? "…" : "";
  return { text: pre + lineText.slice(from, to) + (to < lineText.length ? "…" : ""), a: a - from + pre.length, b: Math.min(b, to) - from + pre.length };
}

/* ── "This PC" (pure parts tested in tests/searchview.test.js) ──────────── */

/** How many of the backend's hits ever reach the page. */
export const PC_LIMIT = 300;

/**
 * Best first, then newest. The backend already sorts, but a growing index
 * hands back batches that have to end up in one order, and the palette shows
 * the same list shorter — so the rule lives here, once.
 */
export function sortPcHits(hits) {
  return [...hits].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.mtime || 0) - (a.mtime || 0) || naturalCompare(a.path, b.path));
}

/**
 * What clicking a row does, and what the menu offers. Leonote only opens the
 * kinds it can actually show; everything else goes to the program Windows
 * would use, which is what the user expects from a file they searched for.
 */
export function pcActions(hit) {
  if (!hit || hit.isDir) return { primary: "reveal", inApp: false, canImport: false };
  return { primary: hit.canOpen ? "leonote" : "app", inApp: !!hit.canOpen, canImport: true };
}

/** "Desktop\\2026" — the tail of the folder, since the head is always home. */
export function pcFolderLabel(dir, roots = []) {
  const d = String(dir || "");
  let best = "";
  for (const r of roots) {
    const rr = String(r || "").replace(/[\\/]+$/, "");
    if (rr && d.toLowerCase().startsWith(rr.toLowerCase()) && rr.length > best.length) best = rr;
  }
  if (!best) return d;
  const parent = best.slice(0, Math.max(best.lastIndexOf("\\"), best.lastIndexOf("/")) + 1);
  return d.slice(parent.length) || d;
}

/* ── the view ──────────────────────────────────────────────────────────── */

const FTYPES = [["notes", "Notes", "fileText"], ["text", "Code & text", "code"]];
const SCOPES = [["vault", "Whole vault", "folder"], ["folder", "A folder", "folder"], ["picked", "Selected files", "check"], ["tabs", "Open tabs", "columns"], ["tasks", "Tasks", "checkSquare"], ["pc", "This PC", "monitor"]];

export function mountSearch(app, el) {
  const state = {
    query: "", regex: false, caseSensitive: false, wholeWord: false,
    scope: "vault", folder: "", paths: new Set(), // paths: for "picked"
    types: new Set(["notes", "text"]),
    sort: "mtime", replaceOpen: false, replacement: "",
    // Tasks: which ones, and by which date
    taskStatus: "all", taskWhen: "created", taskPeriod: "all",
  };
  let results = []; // [{ path, kind, mtime, content, matches }]
  let picks = new Map(); // path -> Set(match index)
  let run = 0; // cancels a search in flight
  const renderSoon = debounce(() => render(), 150); // results found while files are read, drawn in steps
  let undoSnap = null;
  const textCache = boundedTexts(MAX_CACHED_CHARS); // path -> { mtime, text }
  // "This PC": the backend owns the index, this is only the last answer
  let pc = { hits: [], index: null, ms: 0, matched: 0, partial: false, err: "" };
  let pcStarted = false;

  /* head */
  const input = h("input", { class: "qa-input", spellcheck: false, autocomplete: "off", placeholder: "Search every file — words, \"a phrase\", -not, #tag, path:folder" });
  const clearBtn = h("button", { class: "sv-clear", title: "Clear", hidden: true, onclick: () => { input.value = ""; state.query = ""; clearBtn.hidden = true; schedule.cancel(); search(); input.focus(); } }, icon("x"));
  const tgl = (label, key, title) =>
    h("button", { class: "chip-btn sv-tgl", dataset: { k: key }, title, onclick: () => { state[key] = !state[key]; paintToggles(); search(); input.focus(); } }, label);
  const toggles = h("div", { class: "sv-tgls" },
    tgl("Aa", "caseSensitive", "Match case"),
    tgl("Word", "wholeWord", "Whole word only"),
    tgl(".*", "regex", "Regular expression — the whole box is one pattern"));
  const box = h("div", { class: "qa sv-qa" }, icon("search"), input, clearBtn, toggles);
  const err = h("div", { class: "sv-err", hidden: true });

  /* scope + filters */
  const folderBtn = h("button", { class: "chip-btn sv-folder", hidden: true, onclick: pickFolder }, icon("folder"), h("span", { class: "sv-folder-name", text: "Pick a folder…" }));
  const scopeEls = new Map();
  const scopeBar = h("div", { class: "segmented is-small" }, SCOPES.map(([id, label, ic]) => {
    const b = h("button", { class: "seg", dataset: { s: id }, onclick: () => setScope(id) }, icon(ic), h("span", { text: label }), h("span", { class: "seg-count" }));
    scopeEls.set(id, b);
    return b;
  }));
  const typeBar = h("div", { class: "segmented is-small" }, FTYPES.map(([id, label, ic]) =>
    h("button", { class: "seg", dataset: { t: id }, title: `Include ${label.toLowerCase()} (only text files can be searched)`, onclick: () => {
      state.types.has(id) ? state.types.delete(id) : state.types.add(id);
      if (!state.types.size) state.types.add(id); // never search nothing
      paintToggles();
      search();
    } }, icon(ic), h("span", { text: label }))));
  const sortBtn = h("button", { class: "chip-btn", onclick: () => { state.sort = state.sort === "mtime" ? "path" : "mtime"; paintToggles(); render(); } });
  const bar = h("div", { class: "sv-bar" }, scopeBar, folderBtn, h("div", { class: "sv-right" }, typeBar, sortBtn));

  /* This PC: one line saying what the index is and what it is not */
  const pcCount = h("span", { class: "sv-pc-count" });
  const pcBar = h("div", { class: "sv-pcbar", hidden: true },
    icon("monitor"),
    h("span", { class: "sv-pc-note" }, h("strong", { text: "Names, not contents." }), " File and folder names in your own folders — add more in Settings."),
    pcCount,
    h("button", { class: "chip-btn", title: "Walk the folders again and rebuild the index", onclick: () => rescan() }, icon("undo"), "Rescan"),
    h("button", { class: "chip-btn", title: "Choose which folders are searched", onclick: () => app.openView("settings") }, icon("settings"), "Folders"));

  /* Tasks: active or resolved, created or resolved when */
  const segOf = (key, opts) => h("div", { class: "segmented is-small" }, opts.map(([id, label]) =>
    h("button", { class: "seg", dataset: { v: id }, onclick: () => { state[key] = id; paintToggles(); search(); } }, label)));
  const taskStatusBar = segOf("taskStatus", [["active", "Active"], ["resolved", "Resolved"], ["trashed", "Trashed"], ["all", "All"]]);
  const taskWhenBar = segOf("taskWhen", [["created", "Created"], ["resolved", "Resolved"]]);
  const taskPeriodBar = segOf("taskPeriod", [["all", "Any time"], ["7", "7 days"], ["30", "30 days"], ["year", "This year"]]);
  const taskBar = h("div", { class: "sv-taskbar", hidden: true }, taskStatusBar, taskWhenBar, taskPeriodBar);

  /* replace */
  const replBtn = h("button", { class: "chip-btn sv-repl-open", onclick: () => { state.replaceOpen = !state.replaceOpen; paintReplace(); if (state.replaceOpen) replInput.focus(); } }, icon("swap"), h("span", { text: "Replace…" }));
  const replInput = h("input", { class: "qa-input", spellcheck: false, autocomplete: "off", placeholder: "Replace with…" });
  const replHint = h("span", { class: "sv-repl-hint" });
  const selAllBtn = h("button", { class: "chip-btn", onclick: () => { toggleAll(!allPicked()); } });
  const doBtn = h("button", { class: "btn btn-primary sv-do", disabled: true, onclick: doReplace }, "Replace");
  const replRow = h("div", { class: "sv-repl", hidden: true },
    h("div", { class: "qa sv-qa" }, icon("swap"), replInput, replHint),
    h("div", { class: "sv-repl-acts" }, selAllBtn, doBtn));

  const status = h("div", { class: "sv-status" });
  const list = h("div", { class: "sv-results" });

  const replRowWrap = h("div", { class: "sv-replrow" }, replBtn, replRow);
  const subEl = h("div", { class: "vh-sub", text: "Every note and text file in the vault. Nothing is changed until you tick it." });

  el.replaceChildren(h("div", { class: "view-inner search-view" },
    h("div", { class: "vh" },
      h("div", {}, h("h1", { class: "vh-title", text: "Search" }), subEl),
      h("button", { class: "chip-btn", title: "Search in the overlay instead (Ctrl+Shift+F)", onclick: () => openPalette(app, "search", { query: state.query, force: true }) }, icon("command"), "Overlay")),
    box, err, bar, pcBar, taskBar, replRowWrap, status, list));

  /* ── scope helpers ───────────────────────────────────────────────────── */
  const isPc = () => state.scope === "pc";
  const isTasks = () => state.scope === "tasks";

  function setScope(id) {
    state.scope = id;
    folderBtn.hidden = id !== "folder";
    if (id === "pc") startIndex(false);
    if (id === "folder" && !state.folder) { paintToggles(); return pickFolder(); }
    paintToggles();
    search();
  }
  function pickFolder() {
    openPalette(app, "move", { onPick: (f) => { state.folder = f; state.scope = "folder"; folderBtn.hidden = false; paintToggles(); search(); } });
  }
  const scopeObj = () => ({ kind: state.scope, folder: state.folder, paths: state.scope === "picked" ? state.paths : state.scope === "tabs" ? openPaths() : null });
  function openPaths() {
    const s = new Set();
    for (const t of app.tabList ? app.tabList() : []) if (t.path) s.add(t.path);
    return s;
  }
  function scopeCount(id) {
    if (id === "picked") return state.paths.size || "";
    if (id === "tabs") return openPaths().size || "";
    return "";
  }

  /* ── painting the controls ───────────────────────────────────────────── */
  function paintToggles() {
    const pcOn = isPc();
    const tasksOn = isTasks();
    pcBar.hidden = !pcOn;
    taskBar.hidden = !tasksOn;
    typeBar.hidden = pcOn || tasksOn;
    sortBtn.hidden = pcOn || tasksOn;
    replRowWrap.hidden = pcOn || tasksOn; // nothing on the PC, and no task, is rewritten from here
    for (const [bar2, key] of [[taskStatusBar, "taskStatus"], [taskWhenBar, "taskWhen"], [taskPeriodBar, "taskPeriod"]]) for (const b of bar2.children) b.classList.toggle("is-active", b.dataset.v === state[key]);
    folderBtn.hidden = state.scope !== "folder";
    input.placeholder = pcOn
      ? "Find a file or folder by name, anywhere in your folders"
      : 'Search every file — words, "a phrase", -not, #tag, path:folder';
    subEl.textContent = pcOn
      ? "File and folder names across your computer. Nothing is opened or changed until you ask."
      : "Every note and text file in the vault. Nothing is changed until you tick it.";
    for (const b of toggles.children) b.classList.toggle("is-on", !!state[b.dataset.k]);
    for (const [id, b] of scopeEls) {
      b.classList.toggle("is-active", state.scope === id);
      b.lastChild.textContent = String(scopeCount(id));
    }
    for (const b of typeBar.children) b.classList.toggle("is-active", state.types.has(b.dataset.t));
    const name = state.folder || "Vault root";
    folderBtn.querySelector(".sv-folder-name").textContent = name;
    folderBtn.title = `Searching ${name} — click to change`;
    sortBtn.replaceChildren(icon(state.sort === "mtime" ? "clock" : "list"), state.sort === "mtime" ? "Newest first" : "By path");
    sortBtn.title = "Sort the files: " + (state.sort === "mtime" ? "newest changed first" : "by path");
  }
  function paintReplace() {
    replRow.hidden = !state.replaceOpen;
    replBtn.classList.toggle("is-on", state.replaceOpen);
    replBtn.lastChild.textContent = state.replaceOpen ? "Hide replace" : "Replace…";
    replHint.textContent = state.regex ? "$1…$9 insert regex groups" : "";
    render();
  }

  /* ── tasks ───────────────────────────────────────────────────────────── */
  function taskSearch() {
    ++run;
    const store = app.tasks;
    if (!store) { list.replaceChildren(); status.textContent = "Tasks are not loaded"; return; }
    const words = state.query.trim().split(/\s+/).filter((w) => w.length >= 1);
    const found = filterTasks(store.all, { words, status: state.taskStatus, when: state.taskWhen, period: state.taskPeriod });
    status.textContent = found.length ? `${found.length} task${found.length === 1 ? "" : "s"}${found.length > 300 ? " · the first 300 shown" : ""}` : "No tasks match";
    const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric" }) : "");
    list.replaceChildren(...found.slice(0, 300).map((t) => {
      const where = t.deleted ? "Trashed" : t.done ? "Resolved" : "Active";
      const text = t.text || "(no text)";
      const low = text.toLowerCase();
      const ranges = [];
      for (const w of words) { const i = low.indexOf(w.toLowerCase()); if (i >= 0) ranges.push([i, i + w.length]); }
      const steps = (t.subtasks || []).length;
      return h("button", { class: "sv-task" + (t.done ? " is-done" : "") + (t.deleted ? " is-trashed" : ""), title: "Show it in Tasks", onclick: () => app.showTask && app.showTask(t.id) },
        icon(t.deleted ? "trash" : t.done ? "check" : "checkSquare"),
        h("span", { class: "sv-task-text" }, ranges.length ? markRanges(text, ranges.sort((a, b) => a[0] - b[0])) : text),
        steps ? h("span", { class: "chip is-quiet", text: `${steps} step${steps === 1 ? "" : "s"}` }) : null,
        t.priority && t.priority !== "none" ? h("span", { class: "chip is-quiet p-" + t.priority, text: t.priority }) : null,
        h("span", { class: "sv-task-when", text: `${where} · ${state.taskWhen === "resolved" && (t.completed_at || t.deleted_at) ? "resolved " + day(t.completed_at || t.deleted_at) : "created " + day(t.created)}` }));
    }));
  }

  /* ── searching ───────────────────────────────────────────────────────── */
  const schedule = debounce(() => search(), 180);
  input.addEventListener("input", () => { state.query = input.value; clearBtn.hidden = !input.value; schedule(); });
  replInput.addEventListener("input", () => { state.replacement = replInput.value; renderPreviews(); paintDo(); });

  const isNoteScope = () => state.types.has("notes");
  const wantText = () => state.types.has("text");

  async function search() {
    if (isPc()) return pcSearch();
    if (isTasks()) return taskSearch();
    const token = ++run;
    renderSoon.cancel();
    picks = new Map();
    const pat = buildPattern(state.query, state);
    err.hidden = !pat.error;
    err.textContent = pat.error ? "That regular expression is not valid yet — " + pat.error : "";
    if (!pat.re) {
      results = [];
      status.replaceChildren(state.query.trim() && !pat.error ? "Type a word to search for." : "");
      render();
      return;
    }
    const t0 = performance.now();
    const scope = scopeObj();
    const out = [];
    let total = 0;

    if (isNoteScope()) {
      for (const n of app.vault.notes.values()) {
        if (!inScope(n.path, scope) || !passesFilters(n, pat)) continue;
        const ms = findMatches(n.content, pat.re);
        if (!ms.length) continue;
        out.push({ path: n.path, kind: "note", mtime: n.mtime, content: n.content, matches: ms });
        total += ms.length;
        if (total >= MAX_MATCHES) break;
      }
    }

    results = out;
    render();
    status.replaceChildren(summary(total, out.length, performance.now() - t0, wantText() ? " · reading text files…" : ""));

    if (wantText() && total < MAX_MATCHES) {
      const files = [...app.vault.files.values()]
        .filter((f) => f.kind === "text" && !OPAQUE.test(f.path) && inScope(f.path, scope))
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
        .slice(0, MAX_READ);
      let read = 0;
      for (const f of files) {
        if (token !== run) return; // the query moved on
        let text = null;
        const c = textCache.get(f.path);
        if (c && c.mtime === f.mtime) text = c.text;
        else {
          try { text = await app.host.readText(f.path); } catch { text = null; }
          if (token !== run) return;
          if (text != null) textCache.set(f.path, { mtime: f.mtime, text });
        }
        read++;
        if (text == null) continue;
        if (!passesFilters({ path: f.path, content: text, tags: [] }, pat)) continue;
        const ms = findMatches(text, pat.re);
        if (ms.length) {
          out.push({ path: f.path, kind: "text", mtime: f.mtime, content: text, matches: ms });
          total += ms.length;
          renderSoon(); // the whole list is drawn again: once things settle, not per file
        }
        if (read % 12 === 0 || ms.length) status.replaceChildren(summary(total, out.length, performance.now() - t0, ` · ${read}/${files.length} text files`));
        if (total >= MAX_MATCHES) break;
      }
      if (token !== run) return;
      status.replaceChildren(summary(total, out.length, performance.now() - t0, files.length >= MAX_READ ? ` · first ${MAX_READ} text files` : ""));
      renderSoon.cancel(); render();
    }

    // The outposts, when the whole vault is asked for: their notes and text
    // files are read where they lie. Found, opened - never replaced in.
    if (state.scope === "vault" && outpostList(app).length && total < MAX_MATCHES && (isNoteScope() || wantText())) {
      const listed = await app.host.outpostTexts(MAX_READ).catch(() => null);
      if (token !== run || !listed) return;
      const files = (listed.files || []).filter((f) => (/\.md$/i.test(f.name) ? isNoteScope() : wantText()));
      let read = 0;
      for (const f of files) {
        if (token !== run) return;
        let text = null;
        const c = textCache.get(f.path);
        if (c && c.mtime === f.mtime) text = c.text;
        else {
          try { text = (await app.host.externalRead(f.path)).text; } catch { text = null; }
          if (token !== run) return;
          if (text != null) textCache.set(f.path, { mtime: f.mtime, text });
        }
        read++;
        if (text == null) continue;
        const ms = findMatches(text, pat.re);
        if (ms.length) {
          const root = outpostList(app).find((o) => o.path === f.root);
          out.push({ path: f.path, kind: "ext", where: (root && root.name) || f.root, mtime: f.mtime, content: text, matches: ms });
          total += ms.length;
          renderSoon(); // the whole list is drawn again: once things settle, not per file
        }
        if (read % 12 === 0 || ms.length) status.replaceChildren(summary(total, out.length, performance.now() - t0, ` · ${read}/${files.length} in the outposts`));
        if (total >= MAX_MATCHES) break;
      }
      if (token !== run) return;
      status.replaceChildren(summary(total, out.length, performance.now() - t0, listed.partial ? " · the outposts were only partly read" : ""));
      renderSoon.cancel(); render();
    }
  }

  function summary(total, files, ms, extra) {
    if (!total) return h("span", { text: "No matches" + (extra || "") });
    return h("span", {},
      h("strong", { text: `${total}${total >= MAX_MATCHES ? "+" : ""} ${total === 1 ? "match" : "matches"}` }),
      ` in ${files} ${files === 1 ? "file" : "files"} · ${ms.toFixed(0)} ms${extra || ""}`);
  }

  /* ── selection ───────────────────────────────────────────────────────── */
  const pickedIn = (p) => picks.get(p) || new Set();
  const totalMatches = () => results.reduce((s, r) => s + (r.kind === "ext" ? 0 : r.matches.length), 0);
  const pickedCount = () => [...picks.values()].reduce((s, x) => s + x.size, 0);
  const pickedFiles = () => [...picks.values()].filter((x) => x.size).length;
  const allPicked = () => totalMatches() > 0 && pickedCount() === totalMatches();

  const isExt = (path) => (results.find((x) => x.path === path) || {}).kind === "ext";
  function setPick(path, i, on) {
    if (isExt(path)) return;
    const s = new Set(pickedIn(path));
    on ? s.add(i) : s.delete(i);
    s.size ? picks.set(path, s) : picks.delete(path);
    paintPicks();
  }
  function setFilePick(path, on) {
    const r = results.find((x) => x.path === path);
    if (!r || r.kind === "ext") return;
    on ? picks.set(path, new Set(r.matches.map((_, i) => i))) : picks.delete(path);
    paintPicks();
  }
  function toggleAll(on) {
    picks = new Map();
    if (on) for (const r of results) if (r.kind !== "ext") picks.set(r.path, new Set(r.matches.map((_, i) => i)));
    paintPicks();
  }

  function paintPicks() {
    for (const row of list.querySelectorAll(".sv-row")) {
      const on = pickedIn(row.dataset.path).has(Number(row.dataset.i));
      row.classList.toggle("is-picked", on);
      const cb = row.querySelector("input");
      if (cb) cb.checked = on;
    }
    for (const fh of list.querySelectorAll(".sv-fhead")) {
      const r = results.find((x) => x.path === fh.dataset.path);
      const n = pickedIn(fh.dataset.path).size;
      const cb = fh.querySelector("input");
      if (cb) { cb.checked = !!r && n === r.matches.length && n > 0; cb.indeterminate = n > 0 && !!r && n < r.matches.length; }
    }
    paintDo();
  }

  function paintDo() {
    const n = pickedCount();
    const f = pickedFiles();
    doBtn.disabled = !n;
    doBtn.textContent = n ? `Replace ${n} ${n === 1 ? "match" : "matches"} in ${f} ${f === 1 ? "file" : "files"}` : "Replace";
    selAllBtn.replaceChildren(icon(allPicked() ? "square" : "checkSquare"), allPicked() ? "Clear selection" : `Select all ${totalMatches() || ""}`.trim());
  }

  /* ── rendering results ───────────────────────────────────────────────── */
  let rows = []; // flat, for the keyboard
  let cursor = -1;

  function sorted() {
    const r = [...results];
    return state.sort === "path" ? r.sort((a, b) => naturalCompare(a.path, b.path)) : r.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }

  function render() {
    if (isPc()) return renderPc();
    rows = [];
    if (!results.length) {
      list.replaceChildren(state.query.trim()
        ? h("div", { class: "empty-state" }, icon("search"), h("h3", { text: "Nothing found" }), h("p", { text: "Try fewer words, or widen the scope." }))
        : h("div", { class: "empty-state" }, icon("search"), h("h3", { text: "Search the whole vault" }), h("p", {}, "Words match anywhere. ", kbd("Shift Enter"), " in the overlay opens this page.")));
      paintDo();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of sorted()) {
      const ext = r.kind === "ext";
      const name = ext ? r.path.slice(Math.max(r.path.lastIndexOf("/"), r.path.lastIndexOf("\\")) + 1) : r.path.slice(r.path.lastIndexOf("/") + 1);
      const cb = h("input", { type: "checkbox", disabled: ext, title: ext ? "In an outpost: found and opened, never replaced in" : "", onclick: (e) => { e.stopPropagation(); setFilePick(r.path, e.target.checked); } });
      const head = h("div", { class: "sv-fhead", dataset: { path: r.path }, onclick: () => openAt(r, 0) },
        h("label", { class: "sv-cb", onclick: (e) => e.stopPropagation() }, cb),
        icon(ext ? "outside" : r.kind === "note" ? "fileText" : "code"),
        h("span", { class: "sv-fname", text: name }),
        ext ? h("span", { class: "sv-outpost", title: "Outside the vault, in an outpost", text: r.where }) : null,
        h("span", { class: "sv-fpath", text: ext ? r.path.slice(0, r.path.length - name.length - 1) : dirname(r.path) }),
        h("span", { class: "sv-fcount", text: String(r.matches.length) }),
        h("span", { class: "sv-ftime", text: r.mtime ? relTime(r.mtime) : "" }),
        h("button", { class: "sv-fall", onclick: (e) => { e.stopPropagation(); setFilePick(r.path, pickedIn(r.path).size !== r.matches.length); } }, "Select all in this file"));
      const body = h("div", { class: "sv-rows" });
      for (let i = 0; i < r.matches.length; i++) body.append(matchRow(r, i));
      frag.append(h("section", { class: "sv-file" }, head, body));
    }
    list.replaceChildren(frag);
    animateRows(list); // the first few files rise in; the rest just appear
    rows = [...list.querySelectorAll(".sv-row")];
    cursor = -1;
    paintPicks();
  }

  function matchRow(r, i) {
    const m = r.matches[i];
    const c = context(m.lineText, m.start, m.end, m.lineStart);
    const hit = h("mark", { text: c.text.slice(c.a, c.b) });
    const line = h("span", { class: "sv-text" }, c.text.slice(0, c.a), hit, c.text.slice(c.b));
    const cb = h("input", { type: "checkbox", onclick: (e) => { e.stopPropagation(); setPick(r.path, i, e.target.checked); } });
    const prev = h("span", { class: "sv-prev", hidden: true });
    const row = h("div", { class: "sv-row", dataset: { path: r.path, i: String(i) }, onclick: () => openAt(r, i) },
      h("label", { class: "sv-cb", onclick: (e) => e.stopPropagation() }, cb),
      h("span", { class: "sv-ln", text: String(m.line + 1) }),
      h("span", { class: "sv-lines" }, line, prev));
    fillPreview(row, r, i);
    return row;
  }

  function fillPreview(row, r, i) {
    const prev = row.querySelector(".sv-prev");
    if (!prev) return;
    if (!state.replaceOpen) { prev.hidden = true; return; }
    const m = r.matches[i];
    const c = context(m.lineText, m.start, m.end, m.lineStart);
    const to = replacementFor(m, state.replacement, state.regex);
    prev.hidden = false;
    prev.replaceChildren(icon("forward"), c.text.slice(0, c.a), to ? h("ins", { text: to }) : h("del", { class: "sv-gone", text: c.text.slice(c.a, c.b) }), c.text.slice(c.b));
  }

  function renderPreviews() {
    for (const row of list.querySelectorAll(".sv-row")) {
      const r = results.find((x) => x.path === row.dataset.path);
      if (r) fillPreview(row, r, Number(row.dataset.i));
    }
  }

  function openAt(r, i) {
    const m = r.matches[i];
    if (r.kind === "note") {
      app.openNote(r.path, { offset: m.start });
      if (app.editor && app.editor.select) app.editor.select(m.start, m.end);
    } else if (r.kind === "ext") {
      app.openExternal(r.path, { line: m.line + 1 });
    } else {
      // a text or code file opens at the hit's line
      app.openFile(r.path, { line: m.line + 1 });
    }
  }

  /* ── This PC ─────────────────────────────────────────────────────────────
     The Rust side keeps the index; this asks it and draws the answer. A walk
     in flight tells us about every batch, so the list fills in rather than
     waiting for the whole computer to be read. */

  const extraRoots = () => pcRootsOf(app);

  async function startIndex(force) {
    pcStarted = true;
    try {
      pc.index = await app.host.pcIndexStart(extraRoots(), force);
      pc.err = "";
    } catch (e) {
      pc.err = String(e);
    }
    paintPcBar();
  }

  function rescan() {
    pc.hits = [];
    startIndex(true).then(() => search());
  }

  // batches arrive while the walk runs: refresh what is on screen, gently
  const onBatch = debounce(() => { if (isPc()) pcSearch(); else paintPcBar(); }, 220);
  app.host.on("pc:index", (p) => { pc.index = p || pc.index; paintPcBar(); onBatch(); }).catch(() => {});

  async function pcSearch() {
    const token = ++run;
    results = [];
    picks = new Map();
    if (!pcStarted) startIndex(false);
    const q = state.query.trim();
    err.hidden = true;
    if (!q) {
      pc = { ...pc, hits: [], matched: 0, ms: 0, partial: false };
      status.replaceChildren("");
      render();
      paintPcBar();
      return;
    }
    let res;
    try {
      res = await app.host.pcSearch(q, PC_LIMIT);
    } catch (e) {
      if (token !== run) return;
      pc.err = String(e);
      status.replaceChildren(h("span", { text: "Could not search this PC: " + pc.err }));
      render();
      return;
    }
    if (token !== run) return;
    pc = { hits: sortPcHits(res.hits || []), index: res.index || pc.index, ms: res.ms || 0, matched: res.matched || 0, partial: !!res.partial, err: "" };
    paintPcBar();
    render();
    const building = pc.index && pc.index.status === "building";
    status.replaceChildren(pc.matched
      ? h("span", {}, h("strong", { text: `${pc.matched} ${pc.matched === 1 ? "name" : "names"}` }),
          ` · ${pc.ms} ms${pc.hits.length < pc.matched ? ` · showing the best ${pc.hits.length}` : ""}${building ? " · still reading folders…" : ""}`)
      : h("span", { text: building ? "Nothing yet — still reading folders…" : "No file or folder of that name" }));
  }

  function paintPcBar() {
    const ix = pc.index;
    if (!ix) { pcCount.textContent = ""; return; }
    const n = (ix.entries || 0).toLocaleString();
    pcCount.textContent = ix.status === "building"
      ? `indexing… ${n}`
      : ix.status === "ready" ? `${n} names · built in ${ix.ms} ms · ${fmtSize(ix.bytes || 0)}${ix.capped ? " · capped" : ""}`
      : ix.status === "stopped" ? `${n} names (stopped)` : "not indexed yet";
    pcCount.title = (ix.roots || []).join("\n") || "";
  }

  function pcOpen(hit) {
    const act = pcActions(hit);
    if (act.primary === "leonote") return app.openExternal(hit.path, { newTab: true });
    if (act.primary === "app") {
      return app.host.externalOpenInApp(hit.path).catch((e) => app.toast(String(e), { kind: "error" }));
    }
    return app.host.externalReveal(hit.path).catch((e) => app.toast(String(e), { kind: "error" }));
  }

  function pcMenu(hit, anchor) {
    const act = pcActions(hit);
    menu(0, 0, [
      { header: hit.name, plain: true },
      act.inApp ? { label: "Open in Leonote", icon: "outside", run: () => app.openExternal(hit.path, { newTab: true }) } : null,
      hit.isDir ? null : { label: "Open in the default app", icon: "play", run: () => app.host.externalOpenInApp(hit.path).catch((e) => app.toast(String(e), { kind: "error" })) },
      { label: "Show in Explorer", icon: "reveal", run: () => app.host.externalReveal(hit.path).catch((e) => app.toast(String(e), { kind: "error" })) },
      { label: "Copy path", icon: "clipboard", run: () => { navigator.clipboard.writeText(hit.path); app.toast("Path copied"); } },
      act.canImport ? { label: "Copy into vault…", icon: "filePlus", run: () => app.importExternal(hit.path, { anchor }) } : null,
    ], { anchor });
  }

  function renderPc() {
    rows = [];
    if (!pc.hits.length) {
      const building = pc.index && pc.index.status === "building";
      list.replaceChildren(state.query.trim()
        ? h("div", { class: "empty-state" }, icon("monitor"), h("h3", { text: building ? "Still reading your folders" : "Nothing by that name" }),
            h("p", { text: building ? "Results appear as the index fills in." : "Only names are matched — not what is inside the files." }))
        : h("div", { class: "empty-state" }, icon("monitor"), h("h3", { text: "Find anything on this PC" }),
            h("p", {}, "Type a file or folder name. Your Desktop, Documents, Downloads, Pictures, Videos, Music and vault are indexed — add more folders in Settings.")));
      paintDo();
      return;
    }
    const q = state.query.trim();
    const roots = (pc.index && pc.index.roots) || [];
    const frag = document.createDocumentFragment();
    for (const hit of pc.hits) {
      const f = fuzzy(q, hit.name);
      const more = h("button", { class: "sv-pc-more", title: "More…", onclick: (e) => { e.stopPropagation(); pcMenu(hit, e.currentTarget); } }, icon("more"));
      frag.append(h("div", {
        class: "sv-pc-row", dataset: { path: hit.path },
        title: hit.path,
        onclick: () => pcOpen(hit),
        oncontextmenu: (e) => { e.preventDefault(); pcMenu(hit, e.currentTarget); },
      },
        icon(hit.isDir ? "folder" : KIND_ICON[hit.kind] || "file"),
        h("div", { class: "sv-pc-main" },
          h("div", { class: "sv-pc-name" }, f ? highlight(hit.name, f.hits) : hit.name),
          h("div", { class: "sv-pc-dir", text: pcFolderLabel(hit.dir, roots) })),
        h("span", { class: "sv-pc-size", text: hit.isDir ? "" : fmtSize(hit.size) }),
        h("span", { class: "sv-pc-time", text: hit.mtime ? relTime(hit.mtime) : "" }),
        more));
    }
    list.replaceChildren(frag);
    animateRows(list);
    rows = [...list.querySelectorAll(".sv-pc-row")];
    cursor = -1;
    paintDo();
  }

  /* ── keyboard ────────────────────────────────────────────────────────── */
  function moveCursor(d) {
    if (!rows.length) return;
    cursor = Math.max(0, Math.min(rows.length - 1, cursor + d));
    for (const x of rows) x.classList.remove("is-cursor");
    rows[cursor].classList.add("is-cursor");
    rows[cursor].scrollIntoView({ block: "nearest" });
  }
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(cursor < 0 ? 0 : 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (cursor <= 0) { cursor = -1; for (const x of rows) x.classList.remove("is-cursor"); input.focus(); input.select(); } else moveCursor(-1); }
    else if (e.key === "Escape") { e.preventDefault(); cursor = -1; for (const x of rows) x.classList.remove("is-cursor"); input.focus(); input.select(); }
    else if (e.key === "Enter" && cursor >= 0 && document.activeElement !== replInput) {
      e.preventDefault();
      const row = rows[cursor];
      if (isPc()) {
        const hit = pc.hits.find((x) => x.path === row.dataset.path);
        if (hit) pcOpen(hit);
        return;
      }
      const r = results.find((x) => x.path === row.dataset.path);
      if (r) openAt(r, Number(row.dataset.i));
    }
    else if (e.key === " " && cursor >= 0 && !isPc() && !isTypingHere()) {
      e.preventDefault();
      const row = rows[cursor];
      setPick(row.dataset.path, Number(row.dataset.i), !row.classList.contains("is-picked"));
    }
  });
  const isTypingHere = () => document.activeElement === input || document.activeElement === replInput;

  /* ── replacing ───────────────────────────────────────────────────────── */
  async function doReplace() {
    const jobs = [];
    for (const r of results) {
      const idx = pickedIn(r.path);
      if (!idx.size || r.kind === "ext") continue;
      const edits = [...idx].sort((a, b) => a - b).map((i) => {
        const m = r.matches[i];
        return { start: m.start, end: m.end, text: replacementFor(m, state.replacement, state.regex) };
      });
      jobs.push({ r, edits });
    }
    if (!jobs.length) return;
    const n = jobs.reduce((s, j) => s + j.edits.length, 0);
    const names = jobs.slice(0, 3).map((j) => j.r.path.slice(j.r.path.lastIndexOf("/") + 1));
    const more = jobs.length - names.length;
    const ok = await confirmDialog(
      `Replace ${n} ${n === 1 ? "match" : "matches"} in ${jobs.length} ${jobs.length === 1 ? "file" : "files"}?`,
      `In ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Unticked matches stay as they are, and you can undo straight afterwards.`,
      { ok: "Replace", danger: n > 50 });
    if (!ok) return;

    const before = [];
    const skipped = [];
    for (const { r, edits } of jobs) {
      // refuse if the file moved under us between the search and now
      const live = r.kind === "note" ? (app.vault.get(r.path) || {}).content : await fresh(r.path);
      if (live == null) { skipped.push(r.path + " (gone)"); continue; }
      if (live !== r.content) { skipped.push(r.path + " (changed on disk)"); continue; }
      const next = applyEdits(r.content, edits);
      if (next === r.content) continue;
      before.push({ path: r.path, kind: r.kind, content: r.content });
      try {
        if (r.kind === "note") await app.vault.write(r.path, next, { expected: true });
        else await app.host.writeFile(r.path, new TextEncoder().encode(next));
        if (r.kind === "text") textCache.delete(r.path);
      } catch (e) {
        before.pop();
        skipped.push(`${r.path} (${e})`);
      }
    }
    if (skipped.length) {
      app.toast(`Left alone: ${skipped.slice(0, 2).join(", ")}${skipped.length > 2 ? ` and ${skipped.length - 2} more` : ""}`, { kind: "error", ms: 7000 });
    }
    if (!before.length) return;
    const done = before.reduce((s, b) => s + (jobs.find((j) => j.r.path === b.path)?.edits.length || 0), 0);
    undoSnap = { at: Date.now(), files: before };
    app.toast(`Replaced ${done} ${done === 1 ? "match" : "matches"} in ${before.length} ${before.length === 1 ? "file" : "files"}`, {
      ms: 8000,
      action: { label: "Undo", run: () => undoReplace(undoSnap) },
    });
    picks = new Map();
    search();
  }

  async function fresh(path) {
    try { return await app.host.readText(path); } catch { return null; }
  }

  async function undoReplace(snap) {
    if (!snap || snap !== undoSnap || Date.now() - snap.at > UNDO_MS) return app.toast("That undo has expired", { kind: "error" });
    undoSnap = null;
    let n = 0;
    for (const f of snap.files) {
      try {
        if (f.kind === "note") await app.vault.write(f.path, f.content, { expected: true });
        else { await app.host.writeFile(f.path, new TextEncoder().encode(f.content)); textCache.delete(f.path); }
        n++;
      } catch (e) { app.toast(`Could not restore ${f.path}: ${e}`, { kind: "error" }); }
    }
    app.toast(`Restored ${n} ${n === 1 ? "file" : "files"}`);
    search();
  }

  paintToggles();
  paintReplace();

  return {
    show() {
      requestAnimationFrame(() => input.focus());
    },
    /** Other parts of the app open the page pre-filled (overlay, tree menus). */
    open(opts = {}) {
      if (opts.query != null) { state.query = opts.query; input.value = opts.query; clearBtn.hidden = !opts.query; }
      if (opts.paths) { state.paths = new Set(opts.paths); state.scope = "picked"; folderBtn.hidden = true; }
      if (opts.folder != null) { state.folder = opts.folder; state.scope = "folder"; folderBtn.hidden = false; }
      if (opts.scope === "pc") { state.scope = "pc"; startIndex(false); }
      paintToggles();
      search();
      requestAnimationFrame(() => { input.focus(); input.select(); });
    },
  };
}
