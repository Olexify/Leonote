// Templates: plain Markdown files in a folder you choose, inserted with the
// placeholders Obsidian's own Templates plugin understands. Nothing is stored
// about a template - it is a note like any other, so Obsidian reads the same
// files and the same syntax.
//
//   {{title}}  {{date}}  {{time}}  {{date:FORMAT}}  {{time:FORMAT}}  {{cursor}}
//
// FORMAT understands YYYY YY MM DD HH mm ss. Anything else in it is literal,
// and an unknown {{placeholder}} is left exactly as it was typed.

const PAD = (n) => String(n).padStart(2, "0");
const STAMP_RE = /YYYY|YY|MM|DD|HH|mm|ss/g;

/** Format a Date the Obsidian way: YYYY MM DD HH mm ss, the rest literal. */
export function formatStamp(d, fmt) {
  const map = {
    YYYY: String(d.getFullYear()),
    YY: PAD(d.getFullYear() % 100),
    MM: PAD(d.getMonth() + 1),
    DD: PAD(d.getDate()),
    HH: PAD(d.getHours()),
    mm: PAD(d.getMinutes()),
    ss: PAD(d.getSeconds()),
  };
  return String(fmt).replace(STAMP_RE, (t) => map[t]);
}

const TOKEN_RE = /\{\{([^{}\n]*)\}\}/g;

/**
 * Expand a template's placeholders.
 * ctx: { title, date, values } - `values` fills extra names like {{source}}.
 * Returns { text, cursor }: cursor is where {{cursor}} was, or null.
 */
export function expandTemplate(text, ctx = {}) {
  const d = ctx.date instanceof Date ? ctx.date : new Date();
  const values = ctx.values || {};
  let cursor = null;
  let out = "";
  let last = 0;
  for (const m of String(text).matchAll(TOKEN_RE)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const raw = m[1].trim();
    const cut = raw.indexOf(":");
    const name = (cut < 0 ? raw : raw.slice(0, cut)).trim().toLowerCase();
    const fmt = cut < 0 ? "" : raw.slice(cut + 1).trim();
    if (name === "cursor") { if (cursor == null) cursor = out.length; continue; }
    if (name === "title") { out += ctx.title == null ? "" : String(ctx.title); continue; }
    if (name === "date") { out += formatStamp(d, fmt || "YYYY-MM-DD"); continue; }
    if (name === "time") { out += formatStamp(d, fmt || "HH:mm"); continue; }
    if (Object.prototype.hasOwnProperty.call(values, name)) { out += values[name] == null ? "" : String(values[name]); continue; }
    out += m[0]; // unknown: leave it alone rather than eat the user's text
  }
  out += text.slice(last);
  return { text: out, cursor };
}

/** Does this template want to say where the caret goes? */
export const hasCursor = (text) => /\{\{\s*cursor\s*\}\}/i.test(String(text));

/** The .md notes directly inside `folder`, by title. `notes` is vault.notes. */
export function templatesIn(notes, folder) {
  const dir = String(folder || "").replace(/^\/+|\/+$/g, "");
  if (!dir) return [];
  const out = [];
  for (const n of notes.values()) if (n.folder === dir) out.push(n);
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
