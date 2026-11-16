// Pure Markdown indexing: title, links, tags, headings, checkboxes, words.
// No DOM, no editor - runs in node for tests and over the whole vault at boot.

// [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]]
export const WIKI_RE = /\[\[([^\[\]|#\n]+)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]/g;
// #tag, #nested/tag, #тег - must follow start/space/paren and not be all digits
export const TAG_RE = /(^|[\s(,])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * The text with the tag `from` (and the ones under it, from/x) called `to`: inline #tags outside code blocks, and the
 * entries of a front-matter tags: list. Everything else is left as it is.
 */
export function renameTagText(text, from, to) {
  // the index's rules: tags in any case, a # allowed in front matter, code (fenced or `inline`) left alone
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inline = new RegExp(`(^|[\\s(,])#${esc}(?=$|/|[^\\p{L}\\p{N}_\\-/])`, "giu");
  const entry = new RegExp(`(^|[\\s\\[,"'#])${esc}(?=$|/|[\\s\\],"'])`, "giu");
  const lines = String(text).split("\n");
  // a line's own \r (a Windows file) is put back as it was
  const each = (k, fn) => { const cr = lines[k].endsWith("\r"); const l = cr ? lines[k].slice(0, -1) : lines[k]; lines[k] = fn(l) + (cr ? "\r" : ""); };
  const bare = (l) => l.replace(/\r$/, "");
  let i = 0, fence = null;
  if (bare(lines[0] || "") === "---") {
    let inTags = false;
    for (i = 1; i < lines.length && !/^(---|\.\.\.)\s*$/.test(bare(lines[i])); i++) {
      each(i, (l) => {
        const key = /^([\w\- ]+?):(.*)$/.exec(l);
        if (key) { inTags = key[1].trim() === "tags"; return inTags ? `${key[1]}:${key[2].replace(entry, `$1${to}`)}` : l; }
        return inTags && /^\s*-\s/.test(l) ? l.replace(entry, `$1${to}`) : l;
      });
    }
    i++;
  }
  for (; i < lines.length; i++) {
    const f = FENCE_RE.exec(bare(lines[i]));
    if (f) {
      // a fence closes only on the same mark at least as long, with nothing after it (as the index reads it)
      if (!fence) { fence = f[1]; continue; }
      if (f[1][0] === fence[0] && f[1].length >= fence.length && !bare(lines[i]).trim().slice(f[1].length).trim()) { fence = null; continue; }
    }
    if (fence) continue;
    each(i, (l) => l.split(/(`[^`]*`)/).map((part, k) => (k % 2 ? part : part.replace(inline, `$1#${to}`))).join(""));
  }
  return lines.join("\n");
}
/** "# Title ##" -> [, "#", "Title"], or null. No backtracking regex: one over the text with trailing " #" stripped hung on a line of spaces. */
export function headingOf(line, indent = 0, empty = false) {
  const s = String(line);
  let at = 0;
  while (at < indent && s[at] === " ") at++;
  const m = /^(#{1,6})\s+([\s\S]*)$/.exec(at ? s.slice(at) : s);
  if (!m) return null;
  let t = m[2].trimEnd(), e = t.length;
  while (e > (empty ? 0 : 1) && t[e - 1] === "#") e--;
  t = t.slice(0, e).trimEnd();
  return t || empty ? [m[0], m[1], t] : null;
}
const TASK_RE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s?/;
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export function isTagName(name) {
  return !/^\d+$/.test(name);
}

/* ── highlights ──────────────────────────────────────────────────────────
   Two spellings, both of which Obsidian renders with no plugin installed:

     ==text==                        the Markdown highlight Obsidian ships
     <mark class="hl-blue">text</mark>   inline HTML, which every Markdown
                                        reader renders as a highlight

   Colour is not part of Markdown, so there is nothing to be compatible
   *with* - the only question is what a plain Obsidian shows for a coloured
   highlight. Inline HTML shows it highlighted (in Obsidian's own colour) and
   carries the colour in a class, which is the convention the Highlightr
   plugin and most published CSS snippets already use. A leading marker
   inside the == (==!blue text==) would instead leak "!blue" into the text
   everywhere else, so it loses on both counts.

   Yellow - the one people reach for - is written as plain ==text==, so the
   common case never touches HTML at all. */

export const HL_COLORS = ["yellow", "green", "blue", "pink", "purple", "grey"];

/** The stored spelling, forgiving about what comes out of a settings file. */
export function hlColor(name) {
  const n = String(name == null ? "" : name).trim().toLowerCase();
  if (!n) return "yellow";
  if (n === "gray") return "grey";
  return HL_COLORS.includes(n) ? n : "yellow";
}

const hlOpen = (c) => (c === "yellow" ? "==" : `<mark class="hl-${c}">`);
const hlClose = (c) => (c === "yellow" ? "==" : "</mark>");

// ==text==: no space just inside the marks (Obsidian's rule), and a lone "="
// is allowed in the middle so "a = b" style text still highlights.
const EQ_RE = /==(?!\s)((?:[^\n=]|=(?!=))*)(?<!\s)==/g;
const MARK_RE = /<mark(?:\s+class="hl-([a-z]+)")?\s*>([^\n]*?)<\/mark>/gi;

/**
 * Every highlight in one line of text, left to right.
 * { from, to } is the whole thing, { inner, innerTo } the text inside it.
 */
export function findHighlights(text) {
  const out = [];
  for (const m of text.matchAll(EQ_RE))
    out.push({ from: m.index, to: m.index + m[0].length, inner: m.index + 2, innerTo: m.index + 2 + m[1].length, color: "yellow" });
  for (const m of text.matchAll(MARK_RE)) {
    const inner = m.index + m[0].length - m[2].length - "</mark>".length;
    out.push({ from: m.index, to: m.index + m[0].length, inner, innerTo: inner + m[2].length, color: hlColor(m[1]) });
  }
  out.sort((a, b) => a.from - b.from);
  // ==a== inside <mark>…</mark> is one highlight, not two
  return out.filter((h, i) => !out.some((o, j) => j !== i && o.from <= h.from && o.to >= h.to && (o.to - o.from > h.to - h.from || j < i)));
}

/** The same text with every highlight's marks taken off. */
export function stripHighlights(text) {
  // taking marks off can leave two halves that read as one more highlight
  // ("==a" + "b==" once the <mark> between them goes), so go round again
  for (let pass = 0; pass < 4; pass++) {
    const hls = findHighlights(text);
    if (!hls.length) return text;
    let out = "";
    let at = 0;
    for (const h of hls) {
      if (h.from < at) continue;
      out += text.slice(at, h.from) + text.slice(h.inner, h.innerTo);
      at = h.to;
    }
    text = out + text.slice(at);
  }
  return text;
}

// What a highlight must not swallow: the marks that make a line a heading, a
// quote, a bullet or a checkbox. ==# Title== is not a heading any more.
const BLOCK_PREFIX = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?)?/;

/** One line's worth of work: the new line text, and the text to end up selected. */
function highlightLine(line, a, b, color, caret) {
  const open = color === null ? "" : hlOpen(color);
  const close = color === null ? "" : hlClose(color);
  const hls = findHighlights(line);

  if (caret) {
    const at = hls.find((h) => h.inner <= a && a <= h.innerTo);
    if (at) {
      const inner = line.slice(at.inner, at.innerTo);
      if (color === null || at.color === color)
        return { text: line.slice(0, at.from) + inner + line.slice(at.to), from: at.from + (a - at.inner), to: at.from + (a - at.inner) };
      const start = at.from + open.length + (a - at.inner);
      return { text: line.slice(0, at.from) + open + inner + close + line.slice(at.to), from: start, to: start };
    }
    if (color === null) return null;
    return { text: line.slice(0, a) + open + close + line.slice(a), from: a + open.length, to: a + open.length };
  }

  // A selection that cuts through a highlight takes the whole of it with it,
  // or we would wrap half a pair of marks inside another highlight.
  for (const h of hls) {
    if (h.from >= b || h.to <= a) continue;
    if (h.from < a) a = h.from;
    if (h.to > b) b = h.to;
  }

  // the selection sits inside one highlight, or is exactly one highlight
  let target = hls.find((h) => h.inner <= a && h.innerTo >= b);
  if (!target) {
    const inside = hls.filter((h) => h.from >= a && h.to <= b);
    if (inside.length === 1 && !line.slice(a, inside[0].from).trim() && !line.slice(inside[0].to, b).trim()) target = inside[0];
  }
  if (target) {
    const inner = line.slice(target.inner, target.innerTo);
    if (color === null || target.color === color)
      return { text: line.slice(0, target.from) + inner + line.slice(target.to), from: target.from, to: target.from + inner.length };
    const start = target.from + open.length;
    return { text: line.slice(0, target.from) + open + inner + close + line.slice(target.to), from: start, to: start + inner.length };
  }

  // otherwise: anything highlighted inside the selection loses its marks, and
  // the whole selection becomes one highlight
  const body = stripHighlights(line.slice(a, b));
  const start = a + open.length;
  return { text: line.slice(0, a) + open + body + close + line.slice(b), from: start, to: start + body.length };
}

/**
 * Toggle a highlight over text[from..to].
 *
 * `color` is one of HL_COLORS, or null to only ever remove. Toggling the
 * colour that is already there takes the highlight off; a different colour
 * recolours it. A selection spanning several lines highlights each line on
 * its own (== does not cross a line break), skipping blank ones and leaving
 * every line's heading / quote / bullet marks outside the highlight.
 *
 * Returns one change and the range to select afterwards - nothing else in
 * the document moves.
 */
export function highlightEdits(text, from, to, color = "yellow") {
  const c = color === null ? null : hlColor(color);
  if (to < from) [from, to] = [to, from];
  from = Math.max(0, Math.min(from, text.length));
  to = Math.max(0, Math.min(to, text.length));

  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const lineOf = (p) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= p) lo = mid; else hi = mid - 1; } return lo; };
  const endOf = (i) => (i + 1 < starts.length ? starts[i + 1] - 1 : text.length);

  const caret = from === to;
  const first = lineOf(from);
  let last = caret ? first : lineOf(to);
  // a selection ending exactly at a line start took only that line's newline
  if (last > first && starts[last] === to) last--;

  const spanFrom = starts[first];
  const spanTo = endOf(last);
  const out = [];
  let selFrom = -1;
  let selTo = -1;
  let grown = 0; // how much the lines before this one have changed length by

  for (let i = first; i <= last; i++) {
    const ls = starts[i];
    const line = text.slice(ls, endOf(i));
    let a = caret ? from - ls : Math.max(0, from - ls);
    let b = caret ? a : Math.min(line.length, to - ls);
    const pre = Math.min(BLOCK_PREFIX.exec(line)[0].length, line.length);
    if (a < pre) a = pre;
    if (b < a) b = a;
    if (!caret) {
      while (a < b && /\s/.test(line[a])) a++;
      while (b > a && /\s/.test(line[b - 1])) b--;
    }
    const done = a === b && !caret ? null : highlightLine(line, a, b, c, caret);
    if (!done) { out.push(line); continue; }
    out.push(done.text);
    if (selFrom < 0) selFrom = ls + grown + done.from;
    selTo = ls + grown + done.to;
    grown += done.text.length - line.length;
  }

  const insert = out.join("\n");
  if (insert === text.slice(spanFrom, spanTo)) return { changes: [], from, to };
  return { changes: [{ from: spanFrom, to: spanTo, insert }], from: selFrom < 0 ? from : selFrom, to: selTo < 0 ? to : selTo };
}

/** The same thing as plain text in, plain text out - what the tests read. */
export function toggleHighlight(text, from, to, color = "yellow") {
  const r = highlightEdits(text, from, to, color);
  let out = text;
  for (const ch of r.changes) out = out.slice(0, ch.from) + ch.insert + out.slice(ch.to);
  return { text: out, from: r.from, to: r.to };
}

export function parseNote(content) {
  let id = null; // the note's own id (`id:` in its front matter): how it is found again after a rename outside the app
  const links = [];
  const tags = new Set();
  const headings = [];
  let tasks = 0;
  let done = 0;
  let words = 0;

  const lines = content.split("\n");
  let i = 0;

  // YAML frontmatter: only `tags:` is understood; the rest is left alone.
  if (lines[0] === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === "---" || lines[j] === "...") {
        const fm = lines.slice(1, j).join("\n");
        const idm = /^id:[ \t]*["']?([^\s"']+)/m.exec(fm);
        if (idm) id = idm[1];
        const inline = /^tags:\s*\[(.*)\]\s*$/m.exec(fm);
        if (inline) {
          for (const t of inline[1].split(",")) {
            const n = t.trim().replace(/^["'#]+|["']+$/g, "");
            if (n && isTagName(n)) tags.add(n.toLowerCase());
          }
        } else {
          const block = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(fm + "\n");
          if (block) {
            for (const t of block[1].split("\n")) {
              const n = t.replace(/^\s*-\s*/, "").trim().replace(/^["'#]+|["']+$/g, "");
              if (n && isTagName(n)) tags.add(n.toLowerCase());
            }
          }
        }
        i = j + 1;
        break;
      }
    }
  }

  // a fence closes only on the same mark at least as long: ```` around ``` keeps the inner one as text
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_RE.exec(line);
    if (fm) {
      if (!fence) { fence = fm[1]; continue; }
      if (fm[1][0] === fence[0] && fm[1].length >= fence.length && !line.trim().slice(fm[1].length).trim()) { fence = null; continue; }
    }
    if (fence) continue;

    const hm = headingOf(line);
    if (hm) headings.push({ level: hm[1].length, text: hm[2], line: i });

    const tm = TASK_RE.exec(line);
    if (tm) { tasks++; if (tm[3] !== " ") done++; }

    const bare = line.indexOf("`") >= 0 ? line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)) : line;
    if (bare.indexOf("[[") >= 0) {
      WIKI_RE.lastIndex = 0;
      for (const m of bare.matchAll(WIKI_RE)) links.push({ target: m[1].trim(), line: i });
    }
    if (bare.indexOf("#") >= 0) {
      for (const m of bare.matchAll(TAG_RE)) {
        if (hm && m.index === 0) continue; // "# Heading" is not a tag (needs no space anyway)
        if (isTagName(m[2])) tags.add(m[2].replace(/\/+$/, "").toLowerCase());
      }
    }
    const w = line.match(WORD_RE);
    if (w) words += w.length;
  }

  return { links, tags: [...tags], headings, tasks, done, words, id };
}

/** First non-empty line, stripped of markdown, for previews. */
export function excerpt(content, max = 140) {
  let body = content;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end > 0) body = body.slice(end + 4);
  }
  const out = [];
  let len = 0;
  for (const raw of body.split("\n")) {
    // a table: its divider row says nothing; its cells read as "a · b · c"
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw)) continue;
    const cells = /^\s*\|.*\|\s*$/.test(raw) ? raw.trim().slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean).join(" · ") : raw;
    const l = stripHighlights(cells
      .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      .replace(WIKI_RE, (_, t, _h, a) => a || t)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`]/g, ""))
      .trim();
    if (!l || /^(```|~~~|---)/.test(raw.trim())) continue;
    out.push(l);
    len += l.length;
    if (len >= max) break;
  }
  const s = out.join(" · ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Rewrite every [[old]] link to point at `newTarget`, keeping heading and
 * alias. `matches(target)` decides which link targets refer to the renamed note.
 */
export function rewriteLinks(content, matches, newTarget) {
  let changed = 0;
  const out = content.replace(WIKI_RE, (whole, target, heading, alias) => {
    if (!matches(target.trim())) return whole;
    changed++;
    return `[[${newTarget}${heading || ""}${alias != null ? "|" + alias : ""}]]`;
  });
  return { content: out, changed };
}

/**
 * Links into a renamed folder follow it: [[from/x]], ![[from/x.png]] and
 * [text](from/x.md) (spaces written as %20 too) now point into `to`. The
 * folder is matched without case, as the vault finds it. { content, changed }
 */
export function moveLinkFolder(content, from, to) {
  const low = from.toLowerCase() + "/";
  let changed = 0;
  const swap = (t) => (t.toLowerCase().startsWith(low) ? (changed++, to + "/" + t.slice(low.length)) : null);
  let out = content.replace(WIKI_RE, (whole, target, heading, alias) => {
    const t = swap(target.trim());
    return t == null ? whole : `[[${t}${heading || ""}${alias != null ? "|" + alias : ""}]]`;
  });
  out = out.replace(/(\]\()([^)\s]+)(\))/g, (whole, a, target, b) => {
    let t = swap(target);
    if (t == null && target.includes("%20")) { t = swap(target.replace(/%20/g, " ")); if (t != null) t = t.replace(/ /g, "%20"); }
    return t == null ? whole : a + t + b;
  });
  return { content: out, changed };
}

/** Toggle the checkbox on a given 0-based line. Returns null if not a task. */
export function toggleTaskLine(line) {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const at = m[0].indexOf("[") + m.index;
  const next = m[3] === " " ? "x" : " ";
  return line.slice(0, at + 1) + next + line.slice(at + 2);
}

/** One Markdown table cell as HTML: code, bold, italic and web links; everything else as text. Quotes are
    escaped too - a link's address lands inside href="...", where a " would end it and let a note add attributes. */
export const tableCellHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\u0000/g, "|")
  .replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a data-url="$2">$1</a>'); // no href: a shift- or middle-click cannot open a window of its own

/**
 * A Windows path written in text, from `at` (where "X:\" starts): names may hold spaces, so it ends at a quote,
 * a bracket, a character no file name holds, punctuation followed by a space (the sentence goes on), or where
 * another "Y:\" begins. Trailing dots, commas and spaces are not part of it.
 */
export function writtenPath(text, at) {
  let i = at + 3;
  for (; i < text.length; i++) {
    const c = text[i], n = text[i + 1] || " ";
    if ('"<>|?*`()[]\n'.includes(c)) break;
    if (".,;:".includes(c) && /\s/.test(n)) break;
    if (/\s/.test(c) && /[A-Za-z]/.test(n) && text[i + 2] === ":" && text[i + 3] === "\\") break;
  }
  return text.slice(at, i).replace(/[\s.,;:]+$/, "");
}

/** On a website, or another program here: http(s) anywhere but Leonote's own picture addresses (the vault's are asset.localhost on Windows, HEIC photos heic.localhost). */
export function isWebPicture(u) {
  // read as the browser reads it, never by a pattern on the text: the browser drops leading spaces and control
  // characters, takes "\\" for "/", and "//site/a" means the web too
  const s = String(u).replace(/^[\u0000-\u0020]+/, "");
  if (/^[\\/]{2}/.test(s)) return true;
  let x; try { x = new URL(s, "leonote-local:/"); } catch { return false; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return false;
  const host = x.hostname.toLowerCase().replace(/\.$/, "");
  if (x.port) return true;
  if (host === "heic.localhost") return false;
  if (host !== "asset.localhost") return true;
  // Leonote's own only for a file on a drive (C:/...): a network path (\\server\share) logs in to that server when looked up
  let p; try { p = decodeURIComponent(x.pathname); } catch { return true; }
  if (/^\/[A-Za-z]:[\\/]/.test(p)) return false;
  // a vault or outpost that itself sits on another computer: its own pictures are still its own
  const k = pictureKey(p);
  return !ownPictureRoots.some((r) => k === r || k.startsWith(r + "/"));
}
const pictureKey = (p) => String(p).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
let ownPictureRoots = [];
/** The vault's and outposts' folders: a picture under one of them is Leonote's own even on a network path. */
export function setOwnPictureRoots(list) { ownPictureRoots = (list || []).filter(Boolean).map(pictureKey).filter((r) => r.includes("/")); }
