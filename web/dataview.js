// dataviewjs blocks, run the way Obsidian's Dataview runs them - well enough for
// the dashboards people write: dv.pages(), dv.el(), dv.container, dv.table(),
// tasks with their completion dates, front matter as fields.
//
// The code a note carries is not ours, so it never runs in the app itself: each
// block gets a sandboxed frame (scripts only - no same origin, no network, no
// navigation, no popups) and the pages arrive in it as plain data by message.
// The frame can only ask two things back: its height, and to open a note that
// is in the vault.

import { h, dayKey } from "./util.js";
import { frontMatter, scalar } from "./frontmatter.js";

/* ── the pages, as Dataview sees them ───────────────────────────────────── */

const DAY_RE = /(\d{4})-(\d{2})-(\d{2})/;
const DATE = String.raw`(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)`;
const EMOJI_DATES = { completion: "✅", due: "📅", scheduled: "⏳", start: "🛫", created: "➕" };

/** Front matter: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. Enough for fields. */
export { frontMatter } from "./frontmatter.js";

/** One note as a Dataview page: its file facts, its tasks, its fields (dates as ISO strings - the frame makes them dates). */
export function pageOf(note) {
  const path = note.path;
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const fm = frontMatter(note.content);
  const fmTags = [].concat(fm.tags || fm.tag || []).map((t) => "#" + String(t).replace(/^#/, ""));
  const tags = [...new Set([...fmTags, ...(note.tags || []).map((t) => (t.startsWith("#") ? t : "#" + t))])];
  const dm = DAY_RE.exec(name);
  const tasks = [];
  const lines = String(note.content || "").split(/\r?\n/);
  const inline = {};
  lines.forEach((line, i) => {
    const t = /^(\s*)[-*+]\s+\[(.)\]\s?(.*)$/.exec(line);
    if (!t) {
      // Dataview's inline fields: "mood:: 7" on a line of its own, or [mood:: 7] inside one
      const f = /^\s*(?:[-*+]\s+)?([\p{L}_][\p{L}\p{N}_ -]*?)::\s*(.*)$/u.exec(line);
      if (f) inline[f[1].trim()] = scalar(f[2].trim());
      for (const b of line.matchAll(/\[([\p{L}_][\p{L}\p{N}_ -]*?)::\s*([^\]]*)\]/gu)) inline[b[1].trim()] = scalar(b[2].trim());
      return;
    }
    const text = t[3];
    const task = { text, status: t[2], completed: t[2] === "x" || t[2] === "X", checked: t[2] !== " ", fullyCompleted: t[2] === "x" || t[2] === "X", line: i, path, tags: (text.match(/#[\p{L}\p{N}_/-]+/gu) || []), section: null };
    for (const [k, e] of Object.entries(EMOJI_DATES)) { const d = new RegExp(e + "\\uFE0F?\\s*" + DATE).exec(text); if (d) task[k] = d[1]; }
    for (const f of text.matchAll(/\[([\w-]+)::\s*([^\]]+)\]/g)) task[f[1]] = f[2].trim();
    tasks.push(task);
  });
  const file = {
    path, name, folder, ext: "md", link: { path, display: name },
    ctime: note.ctime ? new Date(note.ctime).toISOString() : null,
    mtime: note.mtime ? new Date(note.mtime).toISOString() : null,
    // the day where the user is (an edit at 01:30 in Kyiv is that day, not the day before in UTC)
    cday: note.ctime ? dayKey(new Date(note.ctime)) : null,
    mday: note.mtime ? dayKey(new Date(note.mtime)) : null,
    size: (note.content || "").length, tags, etags: tags, aliases: [].concat(fm.aliases || []),
    day: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null,
    tasks, frontmatter: fm, outlinks: (note.links || []).map((l) => { const t = typeof l === "string" ? l : l.target || ""; return { path: t, display: t.split("/").pop() }; }),
  };
  for (const [k, v] of Object.entries(inline)) if (!(k in fm)) fm[k] = v;
  const plain = {};
  for (const [k, v] of Object.entries(fm)) { const s = k.toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, ""); if (s && !(s in fm)) plain[s] = v; }
  return { ...plain, ...fm, file };
}

/** Kept from a card's code, as from any AI: a private note's text, fields and tasks. */
const kept = (app, path) => !app.proposals || app.proposals.noteAccess(path) === "private";
/** What a frame is given: never a private note, a query (dql) included - it runs without asking. */
export function framePages(app) {
  return pagesOf(app.vault).filter((p) => !kept(app, p.file.path));
}
/** A note's whole text for dv.io.load: nothing for a private one. */
export function frameLoad(app, raw) {
  const hit = noteFor(app, raw);
  return hit && !kept(app, hit) ? app.vault.notes.get(hit).content : null;
}

let cache = { sig: "", pages: [] };
// a rename or a move keeps every note's count and times: counted here, so the pages are built again with the new paths
// (an old path would be judged by its old folder's AI access - a note moved into a private folder still handed out)
const moved = new WeakMap();
function movesOf(vault) {
  let c = moved.get(vault);
  if (!c) { c = { n: 0 }; moved.set(vault, c); if (vault.bus) for (const ev of ["structure", "renamed", "removed", "folderRenamed"]) vault.bus.on(ev, () => c.n++); }
  return c.n;
}
/** Every note as a page, built again only when a note changed, moved or went. */
export function pagesOf(vault) {
  let sig = vault.notes.size + ":" + movesOf(vault) + ":";
  let t = 0;
  for (const n of vault.notes.values()) t += n.mtime || 0;
  sig += t;
  if (sig !== cache.sig) cache = { sig, pages: [...vault.notes.values()].filter((n) => /\.md$/i.test(n.path)).map(pageOf) };
  return cache.pages;
}

/* ── the frame ──────────────────────────────────────────────────────────── */


/* The frame's own script is dvframe.js, a file of the app: the app's page allows no inline script and no eval
   (its policy carries over into the frame), so the block's code runs as a blob: script of the frame's own. */
function frameDoc(vars, dark) {
  const src = new URL("dvframe.js", location.href).href;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${src} blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'">
<style>
:root { ${vars} color-scheme: ${dark ? "dark" : "light"}; }
html, body { margin: 0; background: transparent; color: var(--text-normal); font: 14px/1.5 var(--font-text); overflow: hidden; }
#dv { padding: 2px 0; }
a.internal-link { color: var(--text-accent); text-decoration: none; cursor: pointer; }
a.internal-link:hover { text-decoration: underline; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--background-modifier-border); }
th { color: var(--text-muted); font-weight: 600; }
h1, h2, h3, h4 { margin: .6em 0 .3em; line-height: 1.25; }
.dv-error { padding: 8px 10px; border-radius: 6px; background: rgba(229, 72, 77, .12); color: #e5484d; font: 12px/1.4 var(--font-monospace); white-space: pre-wrap; }
.dv-note { color: var(--text-muted); font-size: 12px; }
ul.contains-task-list { list-style: none; padding-left: 4px; }
select, button, input { font: inherit; color: inherit; }
</style></head><body><div id="dv"></div><script src="${src}"></script></body></html>`;
}

/** The app's colours under Obsidian's names, so a dashboard written for Obsidian's theme looks at home. */
export function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => (cs.getPropertyValue(n) || "").trim() || d;
  const bg = v("--bg", "#111"), surface = v("--surface", "#1a1a1a"), s2 = v("--surface-2", "#222");
  const pairs = {
    "--background-primary": bg, "--background-primary-alt": surface, "--background-secondary": surface, "--background-secondary-alt": s2,
    "--background-modifier-border": v("--line", "#333"), "--background-modifier-hover": v("--hover", "#2a2a2a"),
    "--text-normal": v("--text", "#ddd"), "--text-muted": v("--text-2", "#aaa"), "--text-faint": v("--text-4", "#777"), "--text-accent": v("--accent", "#e0a33b"),
    "--interactive-accent": v("--accent", "#e0a33b"), "--font-text": v("--font-ui", "system-ui, sans-serif"), "--font-monospace": v("--font-mono", "ui-monospace, monospace"),
  };
  return Object.entries(pairs).map(([k, x]) => `${k}: ${x};`).join(" ");
}

export const isDark = () => document.documentElement.dataset.theme !== "light";

const frames = new Map(); // frame window -> { iframe, app }
/** A note of the vault by path or by name - the only thing a frame may ask for. */
function noteFor(app, raw) {
  const p = String(raw || "").replace(/\\/g, "/");
  if (!p) return null;
  if (app.vault.notes.has(p)) return p;
  if (app.vault.notes.has(p + ".md")) return p + ".md";
  const name = p.replace(/\.md$/i, "").split("/").pop();
  return [...app.vault.notes.keys()].find((k) => k.slice(k.lastIndexOf("/") + 1).replace(/\.md$/i, "") === name) || null;
}
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  addEventListener("message", (e) => {
    const f = frames.get(e.source);
    if (!f || !e.data || typeof e.data !== "object") return;
    if (e.data.type === "dv-size") f.iframe.style.height = Math.max(24, Math.min(20000, Number(e.data.h) || 0)) + "px";
    else if (e.data.type === "dv-ready") f.run();
    else if (e.data.type === "dv-error") { console.warn("Dataview block:", String(e.data.text).slice(0, 300)); (window.__dvErrors ||= []).push(String(e.data.text).slice(0, 300)); }
    else if (e.data.type === "dv-load") {
      e.source.postMessage({ type: "dv-loaded", id: e.data.id, text: frameLoad(f.app, e.data.path) }, "*");
    }
    else if (e.data.type === "dv-open") {
      // only a note that is in the vault
      const hit = noteFor(f.app, e.data.path);
      if (hit) f.app.openNote(hit, { newTab: true });
    }
  });
}

/**
 * Run every ```dataviewjs and ```dataview block shown in `el` (rendered Markdown with
 * `pre.md-pre[data-lang]`), in place. `current`: the note they belong to.
 */
export function runDataview(el, { app, current = "" }) {
  const blocks = el.querySelectorAll('pre[data-lang="dataviewjs"], pre[data-lang="dataview"]');
  if (!blocks.length) return;
  listen();
  for (const pre of blocks) {
    const code = pre.textContent;
    const kind = pre.dataset.lang === "dataview" ? "dql" : "js";
    // a query is not code; code runs once the user says so (see askFirst)
    if (kind === "js") askFirst(pre, code, app, () => mount(pre, code, kind, app, current));
    else mount(pre, code, kind, app, current);
  }
}

/**
 * Code in a card (dataviewjs) runs only once the user has said yes to that very code. Why: it can read every
 * note in the vault that is not private, and although its frame may not fetch, load pictures, send forms, open windows or move
 * the page, a browser lets WebRTC (the video-call connection) out regardless - so a board made by someone
 * else (a shared folder, a download) could carry code written to send those notes away. A yes is
 * remembered for that code (its SHA-256): changed code asks again.
 */
async function askFirst(pre, code, app, go) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const id = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if ((app.settings.dvTrusted || []).includes(id)) return go();
  const run = (keep) => {
    if (keep) app.setSetting("dvTrusted", [...(app.settings.dvTrusted || []), id].slice(-500));
    box.replaceWith(pre);
    go();
  };
  const box = h("div", { class: "dv-ask" },
    h("div", { class: "dv-ask-t", text: "Run the code in this card?" }),
    h("div", { class: "dv-ask-d", text: "This card has code (dataviewjs), and code like this can read every note in your vault except private ones. Run it if you wrote it or trust whoever did: a board from someone else - a shared folder, a download - could carry code made to send your notes away." }),
    h("details", { class: "dv-ask-code" }, h("summary", { text: "Show the code" }), h("pre", { text: code })),
    h("div", { class: "dv-ask-b" },
      h("button", { class: "btn btn-sm", onclick: () => run(false) }, "Run once"),
      h("button", { class: "btn btn-sm btn-primary", title: "It runs from now on without asking - until the code changes", onclick: () => run(true) }, "Always run this code")));
  pre.replaceWith(box);
}

function mount(pre, code, kind, app, current) {
  {
    // the name is how the app (lib.rs) knows this frame and keeps it from navigating anywhere
    const iframe = h("iframe", { class: "dv-frame", sandbox: "allow-scripts", title: "Dataview", name: "leonote-dataview" });
    // the frame's colour scheme matches the page's, or it would paint itself an opaque white
    iframe.style.colorScheme = isDark() ? "dark" : "light";
    iframe.srcdoc = frameDoc(themeVars(), isDark());
    const box = h("div", { class: "dv-block" }, iframe);
    pre.replaceWith(box);
    // the frame window exists once it is in the page
    const entry = { iframe, app, run: async () => { await (app.proposals && app.proposals.ready); if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: "dv-run", kind, code, pages: framePages(app), current, dark: isDark() }, "*"); } };
    const add = () => { if (iframe.contentWindow) frames.set(iframe.contentWindow, entry); };
    add();
    iframe.addEventListener("load", add);
  }
}

/** Forget the frames inside `el` that went away (a card redrawn, a board closed). */
export function forgetFrames() {
  for (const [w, f] of frames) if (!f.iframe.isConnected) frames.delete(w);
}
