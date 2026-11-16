// One overlay for everything you'd otherwise hunt for: quick switcher,
// commands, full-text search, move-to-folder, tags and quick capture.
// It never blocks: Escape or a click outside returns you exactly where you were.

import { h, relTime, clamp, safeName } from "./util.js";
import { pcRootsOf, outpostList } from "./outposts.js";
import { icon } from "./icons.js";
import { fuzzy, highlight, searchVault, markRanges } from "./search.js";
import { parseQuickAdd } from "./taskstore.js";
import { kbd, menu } from "./ui.js";
import { KIND_ICON } from "./fileview.js";

let current = null;

// Quick switcher filters by kind. They stay as you left them for the session.
const KINDS = [
  ["note", "Notes", "fileText"],
  ["image", "Pictures", "image"],
  ["pdf", "PDFs", "fileText"],
  ["office", "Office", "file"],
  ["code", "Code & text", "code"],
  ["board", "Boards", "grid"],
  ["sketch", "Sketches", "brush"],
  ["media", "Media", "play"],
];
let kindFilter = new Set();
// A link's search: note names, text inside notes, or both. Kept for the session.
const LOOKS = [["both", "Both", "search"], ["names", "Notes", "fileText"], ["text", "Text in notes", "textBox"]];
let linkLook = "both";

/** The switcher kind of a vault file (notes are "note"). */
export function kindOf(file) {
  const p = file.path.toLowerCase();
  if (p.endsWith(".canvas")) return "board";
  if (/\.(leocanvas|leopaint|leovector|excalidraw)$/.test(p)) return "sketch";
  if (file.kind === "text") return "code";
  return file.kind;
}

/**
 * Split "ext:pdf report" or ".pdf report" into { exts, rest }. Several
 * extensions can be given: "ext:png,jpg" or ".png .jpg cat".
 */
export function parseExt(q) {
  const exts = new Set();
  const rest = [];
  for (const w of q.trim().split(/\s+/)) {
    const m = /^(?:ext:|\.)([a-z0-9]+(?:,[a-z0-9]+)*)$/i.exec(w);
    if (m) for (const e of m[1].toLowerCase().split(",")) exts.add(e);
    else if (w) rest.push(w);
  }
  return { exts, rest: rest.join(" ") };
}

/* A colour for a result's icon, so kinds tell apart at a glance: web pages blue, pictures and sheets green,
   PDFs red; other file types a steady colour of their own from their extension; notes stay plain. */
const TINTS = [
  [/^https?:/i, "#5b9cf5"],
  [/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?|heic)$/i, "#4fbf73"],
  [/\.(xlsx?|xlsm|ods|csv|tsv|numbers)$/i, "#2fa866"],
  [/\.pdf$/i, "#e5534b"],
  [/\.(docx?|odt|rtf|pages)$/i, "#7c8cf0"],
  [/\.(pptx?|odp|key)$/i, "#e08a3c"],
  [/\.(mp4|mkv|webm|mov|avi|mp3|wav|flac|ogg|m4a|opus)$/i, "#b07ce8"],
];
export function tintOf(path) {
  if (!path || /\.md$/i.test(path)) return null;
  for (const [re, c] of TINTS) if (re.test(path)) return c;
  const ext = /\.([a-z0-9]+)$/i.exec(path);
  if (!ext) return null;
  let n = 0;
  for (const ch of ext[1].toLowerCase()) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${n} 55% 62%)`;
}

export function closePalette() {
  if (current) current.close();
}
export const paletteOpen = () => !!current;

const HINTS = {
  switcher: [["Tab", "search in text"], ["↑↓", "navigate"], ["Enter", "open"], ["Ctrl Enter", "new tab"], ["Shift Enter", "create"], ["ext:pdf", "file type"], [">", "commands"]],
  commands: [["Tab", "back to files"], ["↑↓", "navigate"], ["Enter", "run"], ["Esc", "close"]],
  search: [["Tab", "commands"], ["Enter", "open"], ["Shift Enter", "open as a page"], ["#tag", ""], ["path:", ""], ['"phrase"', ""], ["-word", ""]],
  pc: [["Enter", "open"], ["Shift Enter", "open as a page"], ["Tab", "back to files"], ["", "names, not contents"]],
  move: [["Enter", "move here"], ["Esc", "cancel"]],
  prompt: [["Enter", "confirm"], ["Esc", "cancel"]],
  pick: [["↑↓", "navigate"], ["Enter", "choose"], ["Esc", "cancel"]],
  tags: [["Enter", "show notes"]],
  capture: [["Enter", "save"], ["Tab", "task ⇄ daily note"], ["!h @tomorrow ^fri", ""]],
};

// The three ways of looking: names, words inside notes, commands. They share
// one box so nobody has to remember which shortcut they pressed.
const MODES = [
  ["switcher", "Files", "fileText", "Ctrl O"],
  ["search", "In text", "search", "Ctrl Shift F"],
  ["commands", "Commands", "command", "Ctrl P"],
  // the same index the Search page's This PC tab uses (src-tauri/pcsearch.rs)
  ["pc", "On this PC", "monitor", ""],
];

const PLACEHOLDER = {
  switcher: "Jump to a note, type a new name, or > for commands…",
  commands: "Run a command…",
  search: "Search every note…",
  pc: "Find a file on this computer by name…",
  move: "Move to folder…",
  prompt: "Type a name…",
  pick: "Find a note…",
  tags: "Filter tags…",
  capture: "Capture a thought…",
};

export function openPalette(app, mode = "switcher", opts = {}) {
  if (current) {
    const same = current.mode === mode;
    current.close(false);
    if (same && !opts.query && !opts.force) { app.focusMain(); return; }
  }

  let m = mode;
  let items = [];
  let sel = 0;
  let captureKind = opts.captureKind || "task";

  const input = h("input", { class: "pal-input", spellcheck: false, autocomplete: "off" });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const foot = h("div", { class: "pal-foot" });
  const chip = h("span", { class: "pal-chip" });
  // switching keeps what you typed, so a name search becomes a text search
  const switchTo = (id) => {
    if (m === id) return;
    m = id;
    sel = 0;
    render();
    input.focus();
  };
  const tabs = h("div", { class: "pal-modes", role: "tablist" }, MODES.map(([id, label, ic, keys]) =>
    h("button", { class: "pal-mode", dataset: { m: id }, role: "tab", title: `${label}${keys ? " · " + keys : ""} · Tab switches`, onmousedown: (e) => e.preventDefault(), onclick: () => switchTo(id) }, icon(ic), h("span", { text: label }))));
  const head = h("div", { class: "pal-head" }, icon(m === "capture" ? "bolt" : m === "commands" ? "command" : "search"), input, chip);
  const panel = h("div", { class: "pal" }, head, tabs, list, foot);
  const filters = h("div", { class: "pal-filters" }, KINDS.map(([k, label, ic]) =>
    h("button", { class: "pal-filter", dataset: { k }, title: `Show ${label.toLowerCase()} only (click several to combine)`, onmousedown: (e) => e.preventDefault(), onclick: () => {
      kindFilter.has(k) ? kindFilter.delete(k) : kindFilter.add(k);
      sel = 0;
      render();
      input.focus();
    } }, icon(ic), label)));
  panel.insertBefore(filters, list);
  const looks = h("div", { class: "pal-filters" }, LOOKS.map(([k, label, ic]) =>
    h("button", { class: "pal-filter", dataset: { k }, title: k === "both" ? "Note names and the text inside notes" : k === "names" ? "Note names only" : "A place in any note: the lines with these words", onmousedown: (e) => e.preventDefault(), onclick: () => { linkLook = k; sel = 0; render(); input.focus(); } }, icon(ic), label)));
  panel.insertBefore(looks, list);
  const back = h("div", { class: "pal-back", onmousedown: (e) => { if (e.target === back) close(); } }, panel);
  document.getElementById("overlay-root").append(back);

  function close(restore = true) {
    back.classList.add("is-out");
    setTimeout(() => back.remove(), 120);
    current = null;
    if (restore) app.focusMain();
  }
  current = { mode, close };

  /* The Player's online library (kept in .leonote/online.json, not as files): a plain scan of the titles
     already in memory - a few thousand short strings, well under a millisecond. */
  function onlineHits(query) {
    const out = [];
    if (query.length > 1 && Array.isArray(app.settings.youtubeLibrary) && app.media && app.media.playKey) {
      const ql = query.toLowerCase(), hits = [];
      for (const x of app.settings.youtubeLibrary) { if (x && x.title && x.title.toLowerCase().includes(ql)) { hits.push(x); if (hits.length >= 6) break; } }
      hits.forEach((x, k) => {
        const at = x.title.toLowerCase().indexOf(ql);
        out.push({ section: k === 0 ? "Online music · from the Player, not files" : null, secIcon: "globe", cls: "is-online", icon: x.audio ? "music" : "play", title: highlight(x.title, [...Array(query.length)].map((_, i) => at + i)),
          sub: x.url ? x.url.replace(/^https?:\/\/(www\.)?/i, "").slice(0, 60) : "YouTube", right: h("span", { class: "pal-pill" }, "Online"), run: () => app.media.playKey(x.url ? "url:" + x.url : "yt:" + x.id) });
      });
    }
    return out;
  }

  /* The folders kept out of the index (Settings › Files): looked into only when asked - the last row of the
     results offers it, and their notes come in below it, read from the disk then (Rust: unindexed_find). */
  let unFor = null, unHits = [], unBusy = false;
  function unindexedItems(query) {
    const q = query.trim();
    const folders = Array.isArray(app.settings.noIndex) ? app.settings.noIndex : [];
    if (!folders.length || q.length < 2 || !app.host.unindexedFind) return [];
    if (unFor !== q) {
      const ask = () => {
        if (unBusy) return;
        unBusy = true; render();
        app.host.unindexedFind(q).then((r) => { unHits = r || []; unFor = q; }).catch(() => { unHits = []; unFor = q; }).finally(() => { unBusy = false; render(); });
      };
      return [{ section: "Not indexed", secIcon: "eye", icon: unBusy ? "rotateRight" : "search", keep: true, title: unBusy ? "Looking in the not-indexed folders…" : "Search the not-indexed folders too", sub: folders.join(" · "), run: ask }];
    }
    if (!unHits.length) return [{ section: "Not indexed", secIcon: "eye", icon: "search", keep: true, title: "Nothing in the not-indexed folders", sub: folders.join(" · "), run: () => {} }];
    return unHits.map((x, k) => ({ section: k === 0 ? "Not indexed · read from the disk" : null, secIcon: "eye", icon: "fileText", title: x.name.replace(/\.md$/i, ""), sub: x.snippet || x.path,
      right: h("span", { class: "pal-pill" }, "Not indexed"), run: (o) => app.openExternal(x.abs, { newTab: !!(o && o.newTab) }) }));
  }

  /* ── "On this PC" ────────────────────────────────────────────────────── */
  let pcHits = [];
  let pcFor = null; // the query pcHits answers
  let pcBusy = false;
  let pcIdx = null; // last index state from the backend
  let pcSeq = 0;

  const pcIdxText = () => {
    if (!pcIdx) return "";
    if (pcIdx.status === "building") return `indexing ${(pcIdx.entries || 0).toLocaleString()}…`;
    return pcIdx.status === "ready" ? `${(pcIdx.entries || 0).toLocaleString()} names` : "";
  };

  /** Build the index once per session; the page and the overlay share it. */
  function pcStart() {
    app.host.pcIndexStart(pcRootsOf(app), false).then((s) => { pcIdx = s; if (m === "pc") render(); }).catch(() => {});
  }

  /** Ask once per query. `render` calls this again with the same words when
      the answer lands, and that call is the one that stops the loop. */
  function pcAsk(query) {
    if (pcFor === query) return;
    pcBusy = true;
    const seq = ++pcSeq;
    const done = (hits, idx) => {
      if (seq !== pcSeq) return; // a later query already answered
      pcHits = hits;
      pcFor = query;
      pcIdx = idx || pcIdx;
      pcBusy = false;
      if (m === "pc" && back.isConnected) render();
    };
    app.host.pcSearch(query, 30).then((r) => done(r.hits || [], r.index)).catch(() => done([], null));
  }

  /* Names in the outposts, for the file switcher. A short walk on the Rust
     side, asked for once the typing pauses; the list is drawn with the last
     answer and again when a newer one lands. */
  let opHits = [];
  let opFor = "";
  let opSeq = 0;
  let opT = 0;
  function opAsk(query) {
    if (opFor === query || !outpostList(app).length) return;
    const seq = ++opSeq;
    clearTimeout(opT);
    opT = setTimeout(() => {
      app.host.outpostFind(query, 8).then((r) => r.hits || []).catch(() => []).then((hits) => {
        if (seq !== opSeq) return;
        opHits = hits;
        opFor = query;
        if ((m === "switcher" || (m === "pick" && opts.places)) && back.isConnected) render();
      });
    }, 260);
  }
  const opItems = (query) => (opFor === query ? opHits : []).map((hit, k) => {
    const f = fuzzy(query, hit.name);
    const root = outpostList(app).find((o) => o.path === hit.root);
    return {
      section: k === 0 ? "Outposts" : null,
      icon: hit.isDir ? "folder" : KIND_ICON[hit.kind] || "file",
      title: f ? highlight(hit.name, f.hits) : hit.name,
      sub: (root && root.name ? root.name + " · " : "") + hit.dir,
      right: hit.mtime ? relTime(hit.mtime) : null,
      run: ({ newTab } = {}) => (hit.isDir ? app.host.externalReveal(hit.path).catch((e) => app.toast(String(e), { kind: "error" })) : app.openExternal(hit.path, { newTab })),
      pc: hit, tint: hit.isDir ? null : tintOf(hit.path),
    };
  });

  /* A link's places: the note itself, its headings, and its paragraphs (a paragraph gets a ^id). */
  function placesIn(name, find) {
    const want = name.toLowerCase();
    const all = [...app.vault.notes.values()];
    const n = all.find((x) => x.title.toLowerCase() === want) || all.map((x) => [fuzzy(name, x.title), x]).filter(([f]) => f).sort((a, b) => b[0].score - a[0].score).map((x) => x[1])[0];
    if (!n) return [];
    return [{ icon: "fileText", title: n.title, sub: "The whole note", run: () => opts.onPick && opts.onPick(n.path) }, ...linesIn(n, find.toLowerCase(), 80)];
  }
  /* The headings and paragraphs of a note that hold `f` (all of them for ""), as places to link. */
  function linesIn(n, f, max, withNote = false) {
    const out = [];
    let fence = false;
    let front = /^---\r?\n/.test(n.content);
    n.content.split("\n").forEach((raw, i) => {
      const line = raw.replace(/\r$/, "");
      if (front) { if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) front = false; return; }
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
      const t = line.trim();
      if (fence || !t || /^(-{3,}|\*{3,})$/.test(t) || out.length >= max) return;
      const head = /^(#{1,6})\s+(.+?)\s*#*$/.exec(t);
      const shown = (head ? head[2] : t).replace(/\s\^[A-Za-z0-9-]+$/, "");
      const at = f ? shown.toLowerCase().indexOf(f) : 0;
      if (at < 0) return;
      // a long line is shown around the words found
      const from = at > 60 ? at - 40 : 0, cut = shown.slice(from, from + 110);
      const title = (from ? "…" : "") + cut + (from + 110 < shown.length ? "…" : "");
      out.push({ icon: head ? "heading" : "textBox", title: f ? highlight(title, [...Array(f.length)].map((_, k) => at - from + (from ? 1 : 0) + k)) : title,
        sub: withNote ? `${n.title}${head ? " · heading" : ""}` : head ? "Heading" : `Line ${i + 1}`,
        run: () => opts.onPick && opts.onPick(n.path, head ? { heading: head[2] } : { line: i }) });
    });
    return out;
  }
  /* Text in any note: the lines holding the words, the note's name under each. */
  function textHits(query) {
    const f = query.toLowerCase();
    if (f.length < 3) return [];
    const out = [];
    for (const n of app.vault.notes.values()) {
      if (out.length >= 40) break;
      if (!n.lower || !n.lower.includes(f)) continue; // the vault keeps each note lowercased already
      out.push(...linesIn(n, f, 40 - out.length, true));
    }
    if (out.length) out[0].section = "Text in notes";
    return out;
  }
  /* For a link: files in the outposts, and any file on this computer. */
  function outside(query) {
    if (query) opAsk(query);
    const files = (query && opFor === query ? opHits : []).filter((x) => !x.isDir);
    return [
      ...files.map((hit, k) => {
        const f = fuzzy(query, hit.name);
        return { section: k === 0 ? "Outposts" : null, icon: KIND_ICON[hit.kind] || "file", title: f ? highlight(hit.name, f.hits) : hit.name, sub: hit.dir,
          run: () => opts.onPick && opts.onPick(null, { abs: hit.path, name: hit.name }) };
      }),
      { section: files.length ? null : "Outside the vault", icon: "monitor", title: "A file on this computer…", sub: "Linked by its place on disk; it opens in Leonote",
        run: async () => { const abs = await app.host.dialogOpen({ multiple: false }).catch(() => null); if (abs && opts.onPick) opts.onPick(null, { abs: String(abs), name: String(abs).split(/[\\/]/).pop() }); } },
    ];
  }

  /* ── providers ──────────────────────────────────────────────────────── */
  const noteItem = (n, r) => ({
    icon: "fileText",
    title: r && r.onTitle ? highlight(n.title, r.hits) : n.title,
    sub: n.folder || null,
    right: relTime(n.mtime),
    run: ({ newTab }) => app.openNote(n.path, { newTab }),
    loc: { kind: "note", path: n.path },
  });

  const FILE_ICON = { board: "grid", sketch: "brush", code: "code" };
  const fileItem = (file, title) => ({
    icon: FILE_ICON[kindOf(file)] || KIND_ICON[file.kind] || "file",
    title,
    sub: file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : null,
    right: file.mtime ? relTime(file.mtime) : null,
    run: ({ newTab }) => app.openFile(file.path, { newTab }),
    loc: { kind: "file", path: file.path },
    tint: tintOf(file.path),
  });

  const P = {
    switcher(q) {
      const { exts, rest } = parseExt(q);
      const filtered = kindFilter.size > 0 || exts.size > 0;
      const extOf = (p) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();
      const wantNotes = (!kindFilter.size || kindFilter.has("note")) && (!exts.size || [...exts].some((e) => e === "md" || e === "txt"));
      const fileOk = (f) => (!kindFilter.size || kindFilter.has(kindOf(f))) && (!exts.size || exts.has(extOf(f.path)));
      const notes = wantNotes ? [...app.vault.notes.values()].filter((n) => !exts.size || exts.has(extOf(n.path))) : [];
      const query = rest.trim();
      if (!query && filtered) {
        // a filter with no words: everything of that kind, newest first
        const all = [
          ...notes.map((n) => ({ t: n.mtime || 0, item: noteItem(n) })),
          ...[...app.vault.files.values()].filter(fileOk).map((f) => ({ t: f.mtime || 0, item: fileItem(f, f.path.slice(f.path.lastIndexOf("/") + 1)) })),
        ];
        return all.sort((a, b) => b.t - a.t).slice(0, 80).map((x) => x.item);
      }
      if (!query) {
        const seen = new Set();
        const out = [];
        for (const p of app.recentPaths()) {
          const n = app.vault.get(p);
          if (n && !seen.has(p)) { seen.add(p); out.push(n); }
        }
        for (const n of notes.sort((a, b) => b.mtime - a.mtime)) if (!seen.has(n.path)) out.push(n);
        return out.slice(0, 60).map((n) => noteItem(n));
      }
      // opened lately: a match there comes up first among its like (the list of recent opens, nothing counted)
      const rec = new Map(app.recentPaths().map((p, i) => [p, i]));
      const lately = (p) => { const i = rec.get(p); return i == null ? 0 : Math.max(15, 60 - i * 3); };
      const scored = [];
      for (const n of notes) {
        const a = fuzzy(query, n.title);
        if (a) { scored.push([a.score + 60 + lately(n.path), n, { onTitle: true, hits: a.hits }]); continue; }
        const b = fuzzy(query, n.path.slice(0, -3));
        if (b) scored.push([b.score + lately(n.path), n, null]);
      }
      scored.sort((x, y) => y[0] - x[0]);
      // open tabs that match come first, in their own section
      const tabHits = [];
      if (!filtered && app.tabList) {
        for (const t of app.tabList()) {
          const web = /^https?:\/\//i.test(t.path || "");
          const addr = web ? t.path.replace(/^https?:\/\/(www\.)?/i, "") : "";
          const f = fuzzy(query, t.title) || (t.path && fuzzy(query, web ? addr : t.path));
          if (!f) continue;
          // a page whose site is what you typed comes before notes that merely sit in a folder of that name
          const site = web && addr.split("/")[0].toLowerCase().includes(query.toLowerCase()) ? 300 : 0;
          tabHits.push([f.score + (t.where ? 0 : 5) + site + lately(t.path), t, fuzzy(query, t.title)]);
        }
        tabHits.sort((a, b) => b[0] - a[0]);
      }
      const out = tabHits.slice(0, 16).map(([, t, f], k) => ({
        section: k === 0 ? "Open tabs" : null, icon: t.icon, title: f ? highlight(t.title, f.hits) : t.title,
        sub: [t.where, /^https?:\/\//i.test(t.path || "") ? t.path.replace(/^https?:\/\/(www\.)?/i, "").slice(0, 80) : t.path && t.path.includes("/") ? t.path.slice(0, t.path.lastIndexOf("/")) : ""].filter(Boolean).join(" · ") || null,
        right: t.here ? "You are here" : "Switch to tab", run: () => t.go(), loc: t.loc, spaceId: t.spaceId, isTab: true, here: !!t.here, tint: tintOf(t.path),
      }));
      const firstRest = out.length;
      out.push(...scored.slice(0, 50).map(([, n, r]) => noteItem(n, r)));
      for (const v of filtered ? [] : app.views) {
        const f = fuzzy(query, v.name);
        if (f && f.score > 0) out.push({ icon: v.icon, title: highlight(v.name, f.hits), sub: "View", run: ({ newTab }) => app.openView(v.id, { newTab }), loc: { kind: "view", view: v.id } });
      }
      // images, PDFs and other files in the vault
      const found = [];
      for (const file of app.vault.files.values()) {
        if (!fileOk(file)) continue;
        const nm = file.path.slice(file.path.lastIndexOf("/") + 1);
        const r = fuzzy(query, nm);
        if (r) found.push([r.score + lately(file.path), file, nm, r.hits]);
      }
      found.sort((a, b) => b[0] - a[0]);
      for (const [, file, nm, hits] of found.slice(0, filtered ? 60 : 12)) out.push(fileItem(file, highlight(nm, hits)));
      if (firstRest && out[firstRest]) out[firstRest] = { ...out[firstRest], section: "Files and views" };
      // and what is hooked up outside the vault
      if (!kindFilter.size && query.length > 1) { opAsk(query); out.push(...opItems(query)); }
      if (!filtered) out.push(...onlineHits(query), ...unindexedItems(query));
      if (!filtered && !notes.some((n) => n.title.toLowerCase() === query.toLowerCase())) {
        out.push({ icon: "filePlus", title: `Create “${query}”`, right: kbd("Shift Enter"), create: true, run: ({ newTab }) => app.newNote({ name: query, newTab }) });
      }
      return out;
    },

    commands(q) {
      // the palette itself is not a command to pick from inside it
      const cmds = app.commands.filter((c) => c.id !== "commands" && (!c.when || c.when()));
      // a command run from here is remembered: with nothing typed, the last six come first
      const go = (c) => () => { app.setSetting("recentCommands", [c.id, ...(app.settings.recentCommands || []).filter((x) => x !== c.id)].slice(0, 6)); app.run(c.id); };
      if (!q.trim()) {
        const recent = (app.settings.recentCommands || []).map((id) => cmds.find((c) => c.id === id)).filter(Boolean);
        return [...recent, ...cmds.filter((c) => !recent.includes(c))].map((c, i) => ({ icon: c.icon || "command", title: c.name, sub: i < recent.length ? "recently used" : null, right: c.keys ? kbd(c.keys) : null, run: go(c) }));
      }
      // what is not a command may be a setting: the last row opens Settings already searched for it
      const inSettings = { icon: "settings", title: `Find “${q.trim()}” in Settings`, run: () => {
        app.openView("settings");
        setTimeout(() => { const s = document.querySelector(".set-search"); if (s) { s.readOnly = false; s.value = q.trim(); s.dispatchEvent(new Event("input")); s.focus(); } }, 50);
      } };
      return [...cmds
        .map((c) => [fuzzy(q, c.name), c])
        .filter(([f]) => f)
        .sort((a, b) => b[0].score - a[0].score)
        .map(([f, c]) => ({ icon: c.icon || "command", title: highlight(c.name, f.hits), right: c.keys ? kbd(c.keys) : null, run: go(c) })), inSettings];
    },

    search(q) {
      if (!q.trim()) {
        return [
          { icon: "hash", title: "#tag", sub: "notes with a tag", run: () => setQuery("#") },
          { icon: "folder", title: "path:folder", sub: "limit to a folder", run: () => setQuery("path:") },
          { icon: "search", title: '"exact phrase"', sub: "quotes match a phrase, -word excludes", run: () => setQuery('"') },
        ];
      }
      const t0 = performance.now();
      const res = searchVault(app.vault.notes.values(), q);
      chip.textContent = `${res.length}${res.length === 80 ? "+" : ""} · ${(performance.now() - t0).toFixed(1)} ms`;
      return [...res.map((r) => {
        const s = r.snippets[0];
        return {
          icon: "fileText",
          title: r.note.title,
          sub: s ? markRanges(s.text, s.ranges) : r.note.folder || null,
          right: r.snippets.length > 1 ? `+${r.snippets.length - 1}` : null,
          loc: { kind: "note", path: r.note.path }, // the same right-click menu as in Files
          run: ({ newTab }) => app.openNote(r.note.path, { newTab, offset: s ? s.offset : undefined }),
        };
      }), ...onlineHits(q.trim()), ...unindexedItems(q)];
    },

    // Names on the disk, from the same index the Search page uses. The
    // backend answers asynchronously, so the provider draws the last answer
    // and asks for a newer one; `ask` re-renders when it arrives.
    pc(q) {
      const query = q.trim();
      chip.textContent = pcIdxText();
      if (!query) {
        return [
          { icon: "monitor", title: "Type a file or folder name", sub: "Names only — nothing inside the files is read", run: () => app.openSearch({ scope: "pc" }) },
          { icon: "settings", title: "Choose which folders are searched", sub: "Settings › Search on this PC", run: () => app.openSettings("Search on this PC") },
        ];
      }
      pcAsk(query);
      const out = pcHits.map((hit) => {
        const f = fuzzy(query, hit.name);
        return {
          icon: hit.isDir ? "folder" : KIND_ICON[hit.kind] || "file",
          title: f ? highlight(hit.name, f.hits) : hit.name,
          sub: hit.dir,
          right: hit.mtime ? relTime(hit.mtime) : null,
          run: () => (hit.isDir || !hit.canOpen
            ? app.host[hit.isDir ? "externalReveal" : "externalOpenInApp"](hit.path).catch((e) => app.toast(String(e), { kind: "error" }))
            : app.openExternal(hit.path, { newTab: true })),
          pc: hit, tint: hit.isDir ? null : tintOf(hit.path),
        };
      });
      if (!out.length) return [{ icon: pcBusy ? "clock" : "monitor", title: pcBusy ? "Looking…" : "No file or folder of that name", sub: "Names, not contents" }];
      out.push({ icon: "search", title: "See every match on the Search page", right: kbd("Shift Enter"), run: () => app.openSearch({ query, scope: "pc" }) });
      return out;
    },

    move(q) {
      const all = ["", ...[...app.vault.folders].sort()];
      const scored = q.trim()
        ? all.map((f) => [fuzzy(q, f || "/"), f]).filter(([x]) => x).sort((a, b) => b[0].score - a[0].score)
        : all.map((f) => [null, f]);
      const out = scored.map(([x, f]) => ({
        icon: "folder",
        title: f ? (x ? highlight(f, x.hits) : f) : "/ (vault root)",
        run: () => (opts.onPick ? opts.onPick(f) : app.moveNote(opts.path, f)),
      }));
      // typed names may hold what a folder name cannot (a colon, a question mark): made safe and shown so; a part with
      // nothing usable in it ("..", "?") offers no folder rather than an "Untitled" one
      const parts = q.trim().split("/").filter(Boolean), dir = parts.map(safeName).join("/");
      if (dir && !all.includes(dir) && !parts.some((p) => safeName(p) === "Untitled" && p.trim() !== "Untitled")) out.push({ icon: "folderPlus", title: `New folder “${dir}”`, run: async () => {
        try { await app.vault.createFolder(dir); } catch (e) { app.toast("Could not make the folder: " + e, { kind: "error" }); return; }
        opts.onPick ? opts.onPick(dir) : app.moveNote(opts.path, dir);
      } });
      if (opts.outside) out.push({ icon: "outside", title: "A folder outside the vault…", sub: "It stays where it is", run: opts.outside });
      return out;
    },

    // A note chosen for something (a link to write, a missing note found): names and paths, fuzzy
    pick(q) {
      const query = q.trim();
      // "Note#": the note's headings and paragraphs, to link to that very place
      const hash = opts.places ? query.indexOf("#") : -1;
      if (hash > 0) return placesIn(query.slice(0, hash).trim(), query.slice(hash + 1).trim());
      if (opts.places && linkLook === "text") return query.length < 3 ? [{ icon: "textBox", title: "Type a few words", sub: "Lines in any note that hold them" }] : textHits(query);
      const list = [...app.vault.notes.values()];
      const scored = query
        ? list.map((n) => [fuzzy(query, n.title) || fuzzy(query, n.path.slice(0, -3)), n]).filter(([f]) => f).sort((a, b) => b[0].score - a[0].score)
        : list.sort((a, b) => b.mtime - a.mtime).map((n) => [null, n]);
      return scored.slice(0, 60).map(([f, n]) => ({
        icon: "fileText",
        title: f && fuzzy(query, n.title) ? highlight(n.title, fuzzy(query, n.title).hits) : n.title,
        sub: n.folder || null,
        note: n,
        run: () => opts.onPick && opts.onPick(n.path),
      })).concat(opts.places && linkLook === "both" ? textHits(query) : [], opts.places ? outside(query) : []);
    },

    // A name, typed. Leonote has no modal dialogs, so the palette is the prompt.
    prompt(q) {
      const t = q.trim();
      return [{
        icon: opts.icon || "filePlus",
        title: t || opts.empty || "Type a name",
        sub: t ? opts.verb || null : opts.hint || null,
        run: () => { if (t && opts.onPick) opts.onPick(t); },
      }];
    },

    tags(q) {
      const tags = [...app.vault.tagCounts().entries()].sort((a, b) => b[1] - a[1]);
      return tags
        .map(([t, c]) => [q.trim() ? fuzzy(q, t) : { hits: [] }, t, c])
        .filter(([f]) => f)
        .map(([f, t, c]) => ({ icon: "hash", title: highlight(t, f.hits), right: String(c), run: () => openPalette(app, "search", { query: "#" + t }) }));
    },

    capture(q) {
      if (captureKind === "task") {
        const p = parseQuickAdd(q, new Date(), (s) => app.areas.find(s));
        const bits = [];
        if (p.area) bits.push(`in ${p.area}`);
        if (p.priority) bits.push(`!${p.priority}`);
        if (p.due_date) bits.push(`due ${p.due_date}`);
        if (p.start_date) bits.push(`starts ${p.start_date}`);
        return [{
          icon: "checkSquare",
          title: p.text || "New task",
          sub: bits.length ? bits.join(" · ") : "Add to Inbox",
          run: () => {
            if (!p.text) return;
            if (app.sound) app.sound("add");
            app.tasks.create(p.text, { priority: p.priority || "none", due_date: p.due_date, start_date: p.start_date, ...(p.focus_id ? { focus_id: p.focus_id } : {}) });
            app.toast("Task added", { action: { label: "View", run: () => app.openView("tasks") } });
          },
        }];
      }
      return [{
        icon: "calendar",
        title: q.trim() || "Append to today's note",
        sub: "Append to today's daily note",
        run: () => { if (q.trim()) app.appendToDaily(q.trim()); },
      }];
    },
  };

  /* A result's right-click: where it goes - a space, at its start or end, or into one of its groups -
     and the usual ways to open or find it. A tab open somewhere moves; anything else is put there. */
  // a file or folder outside the vault (an outpost, this PC): where it is, and its path
  function pcMenu(hit, x, y) {
    const fail = (e) => app.toast(String(e), { kind: "error" });
    menu(x, y, [
      { header: hit.path },
      hit.isDir ? null : { label: "Open", icon: "play", run: () => { close(false); app.openExternal(hit.path, { newTab: true }); } },
      hit.isDir ? null : { label: "Open in its own app", icon: "outside", run: () => { close(false); app.host.externalOpenInApp(hit.path).catch(fail); } },
      { label: "Show in Explorer", icon: "reveal", run: () => { close(false); app.host.externalReveal(hit.path).catch(fail); } },
      { label: "Copy the path", icon: "link", run: () => navigator.clipboard.writeText(hit.path).then(() => app.toast("Copied", { ms: 1200 })) },
    ].filter(Boolean));
  }

  function itemMenu(it, x, y) {
    const l = it.loc;
    const places = app.spacePlaces ? app.spacePlaces() : [];
    const moving = !!it.isTab;
    const done = (fn) => () => { close(false); fn(); };
    const spot = (s, go) => [
      { label: "At the start", icon: "back", run: done(() => app.placeInSpace(l, s.id, { at: "start", from: moving ? it.spaceId : null, go })) },
      { label: "At the end", icon: "forward", run: done(() => app.placeInSpace(l, s.id, { at: "end", from: moving ? it.spaceId : null, go })) },
      ...(s.groups.length ? [{ header: "Into a group" }, ...s.groups.map((g) => ({ label: g.label, swatch: g.swatch, run: done(() => app.placeInSpace(l, s.id, { group: g.id, from: moving ? it.spaceId : null, go })) }))] : []),
    ];
    const spaces = (go) => places.filter((s) => !(moving && s.id === it.spaceId && !go)).map((s) => ({ label: s.label + (s.current ? " (this one)" : ""), sub: spot(s, go) }));
    const path = l.path || "";
    menu(x, y, [
      { label: moving ? "Switch to the tab" : "Open", icon: "play", run: done(() => it.run({ newTab: false })) },
      !moving && l.kind !== "view" ? { label: "Open in a new tab", icon: "plus", run: done(() => it.run({ newTab: true })) } : null,
      places.length > 1 || !moving ? { label: moving ? "Move to space and go there" : "Open in space", icon: "layers", sub: spaces(true) } : null,
      places.length > 1 || !moving ? { label: moving ? "Move to space" : "Put in space (stay here)", icon: "layers", sub: spaces(false) } : null,
      "sep",
      (l.kind === "note" || l.kind === "file") && app.openSplit ? { label: "Open beside (split)", icon: "columns", run: done(() => app.openSplit(path)) } : null,
      (l.kind === "note" || l.kind === "file") ? { label: "Show in the file tree", icon: "folder", run: done(() => app.revealInTree(path)) } : null,
      (l.kind === "note" || l.kind === "file") ? { label: "Show in Explorer", icon: "outside", run: done(() => app.reveal(path)) } : null,
      l.kind === "ext" ? { label: "Show in Explorer", icon: "outside", run: done(() => app.host.externalReveal(path).catch((e) => app.toast(String(e), { kind: "error" }))) } : null,
      path ? { label: l.kind === "web" ? "Copy the address" : "Copy the path", icon: "link", run: () => navigator.clipboard.writeText(path).then(() => app.toast("Copied", { ms: 1200 })) } : null,
    ]);
  }

  /* ── rendering ──────────────────────────────────────────────────────── */
  function renderItem(it, i) {
    const row = h(
      "div",
      { class: "pal-item" + (i === sel ? " is-sel" : "") + (it.create ? " is-create" : "") + (it.here ? " is-here" : "") + (it.cls ? " " + it.cls : "") + (it.tint ? " is-tinted" : ""), style: it.tint ? `--pal-tint:${it.tint}` : null, role: "option", onmousemove: () => setSel(i), onmousedown: (e) => e.preventDefault(), onclick: (e) => choose(i, e),
        oncontextmenu: (e) => { if (!it.loc && !it.pc) return; e.preventDefault(); setSel(i); if (it.pc) pcMenu(it.pc, e.clientX, e.clientY); else itemMenu(it, e.clientX, e.clientY); } },
      it.icon ? Object.assign(icon(it.icon), it.tint ? { style: `color:${it.tint}` } : {}) : null,
      h("div", { class: "pal-main" }, h("div", { class: "pal-title" }, it.title), it.sub ? h("div", { class: "pal-sub" }, it.sub) : null),
      it.right ? h("span", { class: "pal-right" }, it.right) : null
    );
    return it.section ? [h("div", { class: "pal-sec" + (it.cls ? " " + it.cls : "") }, it.secIcon ? icon(it.secIcon) : null, it.section), row] : row;
  }

  function render() {
    if (m === "pc" && !pcIdx) pcStart();
    if (m !== "search" && m !== "pc") chip.textContent = m === "capture" ? (captureKind === "task" ? "Task" : "Daily note") : "";
    input.placeholder = opts.placeholder || PLACEHOLDER[m];
    panel.className = "pal pal-" + m;
    filters.hidden = m !== "switcher";
    looks.hidden = !(m === "pick" && opts.places);
    for (const b of looks.children) b.classList.toggle("is-on", b.dataset.k === linkLook);
    // the mode strip is for looking things up, not for capture or move
    tabs.hidden = !MODES.some(([id]) => id === m);
    for (const b of tabs.children) b.classList.toggle("is-on", b.dataset.m === m);
    const ic = head.querySelector(".ico");
    if (ic) ic.replaceWith(icon(m === "capture" ? "bolt" : m === "commands" ? "command" : m === "pc" ? "monitor" : m === "search" ? "search" : "fileText"));
    for (const b of filters.children) b.classList.toggle("is-on", kindFilter.has(b.dataset.k));
    items = P[m](input.value);
    sel = clamp(sel, 0, Math.max(0, items.length - 1));
    if (!items.length) {
      list.replaceChildren(h("div", { class: "pal-empty", text: "No matches" }));
    } else {
      list.replaceChildren(...items.slice(0, 80).flatMap(renderItem));
    }
    foot.replaceChildren(...(m === "pick" && opts.places ? [...HINTS.pick, ["Tab", "a place in the note"]] : HINTS[m]).map(([k, v]) => h("span", { class: "pal-hint" }, k ? kbd(k) : null, v ? (k ? " " : "") + v : "")));
  }

  function setSel(i) {
    if (i === sel) return;
    const kids = list.querySelectorAll(".pal-item");
    if (kids[sel]) kids[sel].classList.remove("is-sel");
    sel = i;
    if (kids[sel]) { kids[sel].classList.add("is-sel"); kids[sel].scrollIntoView({ block: "nearest" }); }
  }

  function setQuery(v) {
    input.value = v;
    input.focus();
    render();
  }

  function choose(i, e) {
    const it = items[i];
    if (!it) return;
    // a row that does its work here (looking in the not-indexed folders): the search stays open
    if (it.keep) { it.run(); input.focus(); return; }
    close(false);
    Promise.resolve(it.run({ newTab: !!(e && (e.ctrlKey || e.metaKey)) || !!opts.newTab })).finally(() => {
      if (!document.querySelector(".pal-back:not(.is-out)")) app.focusMain();
    });
  }

  // searching the text of every note: once a frame however fast the typing; a key that acts (Enter, arrows)
  // first brings the list up to what is typed
  let frame = 0;
  const renderNow = () => { if (!frame) return; cancelAnimationFrame(frame); frame = 0; render(); };
  input.addEventListener("input", () => {
    if (m === "switcher" && input.value.startsWith(">")) { m = "commands"; input.value = input.value.slice(1); }
    sel = 0;
    if (m === "search") { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = 0; render(); }); }
    else { renderNow(); render(); }
  });

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    renderNow();
    // Tab on a note: its places (Note#), to link to one of them
    if (e.key === "Tab" && m === "pick" && opts.places && !input.value.includes("#") && items[sel] && items[sel].note) { e.preventDefault(); setQuery(items[sel].note.title + "#"); return; }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.code === "KeyJ")) { e.preventDefault(); setSel(Math.min(items.length - 1, sel + 1)); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.code === "KeyK")) { e.preventDefault(); setSel(Math.max(0, sel - 1)); }
    else if (e.key === "PageDown") { e.preventDefault(); setSel(Math.min(items.length - 1, sel + 8)); }
    else if (e.key === "PageUp") { e.preventDefault(); setSel(Math.max(0, sel - 8)); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab" && m === "capture") { e.preventDefault(); captureKind = captureKind === "task" ? "note" : "task"; render(); }
    else if (e.key === "Tab" && MODES.some(([id]) => id === m)) {
      e.preventDefault();
      const i = MODES.findIndex(([id]) => id === m);
      switchTo(MODES[(i + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length][0]);
    }
    else if (e.key === "Backspace" && !input.value && m === "commands" && mode === "switcher") { e.preventDefault(); m = "switcher"; render(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // the overlay is for a quick look; the page is for working through hits
      if (e.shiftKey && (m === "search" || m === "pc") && app.openSearch) {
        close(false);
        return app.openSearch({ query: input.value, ...(m === "pc" ? { scope: "pc" } : {}) });
      }
      if (e.shiftKey && m === "switcher") {
        const c = items.findIndex((x) => x.create);
        if (c >= 0) return choose(c, e);
      }
      choose(sel, e);
    }
  });

  input.value = opts.query || "";
  render();
  input.focus();
  if (opts.query) input.setSelectionRange(input.value.length, input.value.length);
  requestAnimationFrame(() => back.classList.add("is-in"));
}
