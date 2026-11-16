// The Zettelkasten helpers: four folders, two templates, and a few quiet
// suggestions. Everything here is a pure function over plain Markdown - the
// app applies the result. Nothing runs by itself, nothing rewrites a note the
// user did not ask for, and every file stays readable in Obsidian: YAML
// properties, [[wiki links]], no fields only Leonote understands.

import { expandTemplate } from "./templates.js";

export const FOLDERS = { zettel: "Zettelkasten", reference: "Reference Notes", files: "Files", templates: "Templates" };

// The shapes from Artem Kirsanov's setup, in Leonote's placeholders. {{cursor}}
// is where the caret lands, and Obsidian simply leaves it as text if it ever
// inserts one of these itself. There is no `# {{title}}` line: in Leonote the
// file name IS the title, shown above the text and edited there, and Obsidian
// shows it the same way - a second H1 would only be a copy to keep in sync.
export const CORE_IDEA = `---
created: {{date:YYYY-MM-DD}}T{{time:HH:mm}}
type: idea
tags: []
---

## Idea

{{cursor}}

## Connections

- Related idea — how it relates

## Source

- Where this idea came from
`;

export const MAP_OF_CONTENT = `---
created: {{date:YYYY-MM-DD}}T{{time:HH:mm}}
type: moc
tags: []
---

## Overview

{{cursor}}

## Key ideas

- The notes that belong here

## Related maps

- Another map next to this one
`;

// Not written to disk by the setup: the method asks for two templates, so a
// reference note uses this shape unless you make a "Reference Note" template
// of your own, which then wins.
export const REFERENCE = `---
created: {{date:YYYY-MM-DD}}T{{time:HH:mm}}
type: reference
tags: []
---

- Source: {{source}}

## Notes

{{cursor}}

## Extracted ideas

- An idea from it, worth its own note
`;

export const TEMPLATE_FILES = [["Core Idea", CORE_IDEA], ["Map of Content", MAP_OF_CONTENT]];

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
const lower = (p) => norm(p).toLowerCase();

/* ── setup ─────────────────────────────────────────────────────────────── */

/**
 * What "Set up the Zettelkasten" would do, without doing any of it. Idempotent
 * by construction: anything that already exists lands in `skip`.
 *
 * state: { folders, notes, settings } - folder paths, note paths, settings now.
 */
export function setupPlan(state = {}, opts = {}) {
  const f = { ...FOLDERS, ...(opts.folders || {}) };
  const have = new Set([...(state.folders || [])].map(lower));
  const files = new Set([...(state.notes || [])].map(lower));
  const S = state.settings || {};

  const folders = { create: [], skip: [] };
  for (const dir of [f.zettel, f.reference, f.files, f.templates]) {
    const d = norm(dir);
    if (!d) continue;
    (have.has(lower(d)) ? folders.skip : folders.create).push(d);
  }

  const out = { create: [], skip: [] };
  for (const [name, body] of TEMPLATE_FILES) {
    const path = norm(f.templates) + "/" + name + ".md";
    if (files.has(lower(path))) out.skip.push(path);
    else out.create.push({ path, name, content: body });
  }

  // only the settings that would actually change, so re-running says nothing
  const want = {
    templateFolder: norm(f.templates),
    zettelFolder: norm(f.zettel),
    referenceFolder: norm(f.reference),
    newNoteDir: "folder",
    newNoteFolder: norm(f.zettel),
    imageFolder: norm(f.files),
  };
  const settings = {};
  for (const k in want) if (String(S[k] ?? "") !== String(want[k])) settings[k] = want[k];

  return { folders, files: out, settings, nothingToDo: !folders.create.length && !out.create.length && !Object.keys(settings).length };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One sentence for the toast: what happened, and what was left alone. */
export function planSummary(plan) {
  if (plan.nothingToDo) return "The Zettelkasten was already set up — nothing changed.";
  const did = [];
  if (plan.folders.create.length) did.push(plural(plan.folders.create.length, "folder", "folders"));
  if (plan.files.create.length) did.push(plural(plan.files.create.length, "template", "templates"));
  const n = Object.keys(plan.settings).length;
  if (n) did.push(plural(n, "setting", "settings"));
  const kept = plan.folders.skip.length + plan.files.skip.length;
  const head = did.length ? "Created " + did.join(", ") : "Nothing to create";
  return kept ? `${head} · kept ${plural(kept, "thing", "things")} that already existed` : head;
}

/* ── the index the suggestions read ────────────────────────────────────── */

/**
 * A small graph of the vault: who links to whom, tags, titles, sizes.
 * `resolve(target, from)` is vault.resolve. Built once per change, not per row.
 */
export function buildIndex(notes, resolve, { ignore = [] } = {}) {
  const skip = ignore.map(lower).filter(Boolean);
  const hidden = (p) => skip.some((d) => lower(p) === d || lower(p).startsWith(d + "/"));
  const all = [...notes]; // two passes, and callers hand us Map iterators
  const nodes = new Map();
  for (const n of all) {
    if (hidden(n.path)) continue;
    nodes.set(n.path, {
      path: n.path, title: n.title, titleLower: n.title.toLowerCase(), folder: n.folder,
      tags: new Set(n.tags), out: new Set(), in: new Set(), wrote: n.links.length, words: n.words, mtime: n.mtime,
      lower: n.lower || String(n.content || "").toLowerCase(),
    });
  }
  for (const n of all) {
    const from = nodes.get(n.path);
    if (!from) continue;
    for (const l of n.links) {
      const p = resolve(l.target, n.path);
      const to = p && nodes.get(p);
      if (!to || to === from) continue;
      from.out.add(p);
      to.in.add(n.path);
    }
  }
  return nodes;
}

const neighbours = (node) => new Set([...node.out, ...node.in]);

/**
 * Notes worth connecting to the open one, and why. Never suggests a note that
 * is already linked either way - that is what Backlinks is for.
 */
export function relatedNotes(nodes, path, { limit = 6 } = {}) {
  const me = nodes.get(path);
  if (!me) return [];
  const mine = neighbours(me);
  const out = [];
  // a big note: its three-letter pieces, once, so most titles are ruled out without scanning the whole text
  const grams = me.lower.length > 2048 ? new Set() : null;
  if (grams) for (let i = 0; i + 3 <= me.lower.length; i++) grams.add(me.lower.slice(i, i + 3));
  const mayHold = (t) => !grams || (grams.has(t.slice(0, 3)) && grams.has(t.slice(-3)) && grams.has(t.slice((t.length - 3) >> 1, ((t.length - 3) >> 1) + 3)));
  for (const other of nodes.values()) {
    if (other === me || mine.has(other.path)) continue;
    const why = [];
    let score = 0;

    let shared = 0, firstTag = "";
    for (const t of other.tags) if (me.tags.has(t) && !shared++) firstTag = t;
    if (shared) { score += 3 * shared; why.push(shared === 1 ? `#${firstTag}` : `${shared} shared tags`); }

    let common = 0;
    // the other note's own links, each once: no set built per note, and an open hub note costs no more
    for (const p of other.out) if (p !== path && mine.has(p)) common++;
    for (const p of other.in) if (p !== path && mine.has(p) && !other.out.has(p)) common++;
    if (common) { score += 2 * Math.min(common, 4); why.push(common === 1 ? "1 link in common" : `${common} links in common`); }

    // its title is written here, as words, with no link around it
    const mention = other.titleLower.length >= 4 && mayHold(other.titleLower) && me.lower.includes(other.titleLower) && !isLinked(me.lower, other.titleLower);
    if (mention) { score += 4; why.push("mentioned, not linked"); }

    if (score > 0) out.push({ path: other.path, title: other.title, folder: other.folder, score, why, mention, mtime: other.mtime });
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime || a.title.localeCompare(b.title));
  return out.slice(0, limit);
}

// cheap: is every occurrence of the title already inside [[ ]]?
function isLinked(text, title) {
  let i = text.indexOf(title);
  while (i >= 0) {
    const open = text.lastIndexOf("[[", i);
    const close = text.lastIndexOf("]]", i);
    if (open < 0 || close > open) return false; // this one is bare
    i = text.indexOf(title, i + title.length);
  }
  return true;
}

/** Links pointing at notes that do not exist, grouped - a topic asking to be made. */
export function unresolvedLinks(notes, resolve, { min = 2, limit = 8, ignore = [] } = {}) {
  const skip = ignore.map(lower).filter(Boolean);
  const hidden = (p) => skip.some((d) => lower(p) === d || lower(p).startsWith(d + "/"));
  const groups = new Map();
  for (const n of [...notes]) {
    if (hidden(n.path)) continue;
    const seen = new Set();
    for (const l of n.links) {
      const t = String(l.target || "").trim().replace(/\.md$/i, "");
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k) || resolve(l.target, n.path)) continue;
      seen.add(k);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { target: t, display: t.slice(t.lastIndexOf("/") + 1), count: 0, notes: [] }));
      g.count++;
      g.notes.push(n.path);
    }
  }
  return [...groups.values()]
    .filter((g) => g.count >= min)
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .slice(0, limit);
}

/**
 * Notes nothing points at and that point nowhere, and notes barely started.
 * A link that does not resolve yet still counts as reaching out: that note is
 * mid-thought, not forgotten, and Emerging topics already speaks for it.
 */
export function orphansAndStubs(nodes, { stubWords = 25, limit = 8 } = {}) {
  const orphans = [];
  const stubs = [];
  for (const n of nodes.values()) {
    const alone = !n.out.size && !n.in.size && !n.wrote;
    if (alone) orphans.push(n);
    else if (n.words < stubWords) stubs.push(n);
  }
  const trim = (a) => a.sort((x, y) => y.mtime - x.mtime).slice(0, limit).map((n) => ({ path: n.path, title: n.title, words: n.words }));
  return { orphans: trim(orphans), stubs: trim(stubs), orphanCount: orphans.length, stubCount: stubs.length };
}

/* ── editing notes ─────────────────────────────────────────────────────── */

const lineOffsets = (lines) => {
  const off = [];
  let at = 0;
  for (const l of lines) { off.push(at); at += l.length + 1; }
  return off;
};

const headingAt = (line, name) => new RegExp(`^#{1,6}\\s+${name}\\s*$`, "i").test(line.trim());
const isHeading = (line) => /^#{1,6}\s+/.test(line);
const isItem = (line) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
// The example lines our own templates ship with, so the first real entry
// replaces them. They are plain text on purpose: a template must never put a
// made-up [[link]] into the graph.
const EXAMPLES = ["related idea — how it relates", "where this idea came from", "the notes that belong here", "another map next to this one"];
function isPlaceholder(line) {
  const m = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (!m) return false;
  const t = m[1].trim().toLowerCase();
  return EXAMPLES.includes(t) || /^\[\[(related idea|idea note|related moc|source title)\]\]/.test(t);
}

/**
 * Where a `- [[Note]] — ` line belongs under a `## Connections` heading, as one
 * edit. The heading is created at the end of the note when it is missing.
 * Returns { from, to, insert, cursor } - cursor is where to type the relationship.
 */
export function connectionInsert(content, link, { heading = "Connections", level = 2 } = {}) {
  const item = `- [[${link}]] — `;
  const lines = String(content).split("\n");
  const off = lineOffsets(lines);
  const at = lines.findIndex((l) => headingAt(l, heading));

  if (at < 0) {
    const pad = content ? "\n".repeat(Math.max(0, 2 - /\n*$/.exec(content)[0].length)) : "";
    const insert = `${pad}${"#".repeat(level)} ${heading}\n\n${item}`;
    return { from: content.length, to: content.length, insert, cursor: content.length + insert.length };
  }

  let end = at + 1;
  while (end < lines.length && !isHeading(lines[end])) end++;
  let last = at; // insert after this line
  for (let i = at + 1; i < end; i++) {
    if (isPlaceholder(lines[i])) return { from: off[i], to: off[i] + lines[i].length, insert: item, cursor: off[i] + item.length };
    if (isItem(lines[i]) || lines[i].trim()) last = i;
  }
  const from = off[last] + lines[last].length;
  const insert = (last === at ? "\n\n" : "\n") + item;
  return { from, to: from, insert, cursor: from + insert.length };
}

/** Fill a "## Key ideas" list with the notes that asked for this map. */
export function fillKeyIdeas(content, links, { heading = "Key ideas" } = {}) {
  const items = links.map((l) => `- [[${l}]] — `);
  if (!items.length) return content;
  const lines = String(content).split("\n");
  const at = lines.findIndex((l) => headingAt(l, heading));
  if (at < 0) return content.replace(/\n*$/, "\n\n## " + heading + "\n\n" + items.join("\n") + "\n");
  let end = at + 1;
  while (end < lines.length && !isHeading(lines[end])) end++;
  const kept = [];
  for (let i = at + 1; i < end; i++) if (!isPlaceholder(lines[i]) && lines[i].trim()) kept.push(lines[i]);
  const body = [...items, ...kept];
  return [...lines.slice(0, at + 1), "", ...body, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/* ── a note out of what you selected ───────────────────────────────────── */

const STRIP = (s) =>
  s
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*(#{1,6})\s+/, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
    .replace(/\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]/g, (_, t, a) => a || t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[|\]\]/g, "") // a half-typed link leaves no brackets behind
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** A claim-like title out of the first line, cut at a word. */
export function titleFromText(text, max = 80) {
  for (const raw of String(text).split("\n")) {
    const l = STRIP(raw).replace(/[.,;:]+$/, "").trim();
    // a rule, a table border or a row of stars is not a title
    if (!l || !/[\p{L}\p{N}]/u.test(l)) continue;
    if (l.length <= max) return l;
    const cut = l.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim();
  }
  return "";
}

/**
 * The selected text as an atomic note: a title, and the body without the
 * heading line the title came from.
 */
export function noteFromSelection(text) {
  const src = String(text).replace(/\r/g, "");
  const title = titleFromText(src);
  const lines = src.split("\n");
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  const drop = first < lines.length && isHeading(lines[first]);
  const body = (drop ? lines.slice(first + 1) : lines.slice(first)).join("\n").trim();
  return { title, body };
}

/** Put the link where the selection was. Returns the whole new text. */
export function replaceSelection(doc, from, to, link) {
  const text = `[[${link}]]`;
  return { text: String(doc).slice(0, from) + text + String(doc).slice(to), cursor: from + text.length };
}

/** Expand a template, then drop `body` where its {{cursor}} was. */
export function composeNote(template, { title, date, values, body } = {}) {
  const ex = expandTemplate(template, { title, date, values });
  if (!body) return ex;
  const at = ex.cursor == null ? ex.text.length : ex.cursor;
  return { text: ex.text.slice(0, at) + body + ex.text.slice(at), cursor: at + body.length };
}

/* ── sources ───────────────────────────────────────────────────────────── */

const YT_RE = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch|live|shorts|embed)|youtu\.be\/)/i;

function seconds(v) {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(v);
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

export const hhmmss = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + String(sec).padStart(2, "0");
};

/** A URL on the clipboard, with a YouTube timestamp kept as it was. */
export function parseSource(raw) {
  const url = String(raw || "").trim();
  if (!/^https?:\/\/\S+$/i.test(url) || /\s/.test(url)) return null;
  const youtube = YT_RE.test(url);
  let at = 0;
  if (youtube) {
    const m = /[?&](?:t|start)=([0-9hms]+)/i.exec(url);
    at = m ? seconds(m[1]) : 0;
  }
  return { url, youtube, seconds: at, stamp: at ? hhmmss(at) : "" };
}

/** The text after "- Source: " in a reference note. */
export function sourceValue(raw) {
  const s = parseSource(raw);
  if (!s) return "";
  return s.stamp ? `${s.url} (${s.stamp})` : s.url;
}
