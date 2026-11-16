// The parts of PDF editing that are just arithmetic: which page goes where,
// what a saved annotation looks like, how a form field maps to a control, and
// what the new file is called. No DOM, no pdf.js, no pdf-lib - so every rule
// below is pinned down by web/tests/pdf.test.js and the viewer can be trusted
// to be only a view.

// ── page order ──────────────────────────────────────────────────────────────

/** Degrees snapped to a quarter turn in [0, 360). */
export const normDeg = (d) => ((Math.round((Number(d) || 0) / 90) * 90) % 360 + 360) % 360;

/**
 * Move the pages at `picks` so they land in front of the page that is at
 * index `to` now. Picked pages keep their order among themselves.
 * `to === order.length` drops them at the end.
 */
export function movePages(order, picks, to) {
  const set = new Set(picks.filter((i) => i >= 0 && i < order.length));
  if (!set.size) return order.slice();
  const moved = [...set].sort((a, b) => a - b).map((i) => order[i]);
  const rest = order.filter((_, i) => !set.has(i));
  const before = [...set].filter((i) => i < to).length;
  const at = Math.max(0, Math.min(rest.length, to - before));
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

/** Drop the pages at `picks`. A document may not end up empty: that returns null. */
export function removePages(order, picks) {
  const set = new Set(picks.filter((i) => i >= 0 && i < order.length));
  const left = order.filter((_, i) => !set.has(i));
  return left.length ? left : null;
}

/** Turn the picked pages by `delta` degrees, leaving the rest alone. */
export function turnPages(rots, picks, delta) {
  const set = new Set(picks);
  return rots.map((r, i) => (set.has(i) ? normDeg(r + delta) : normDeg(r)));
}

/**
 * "1-3, 5, 9-" over `total` pages -> zero-based indices, in the order asked
 * for, without repeats. "-4" means from the start; a bare "7" is one page.
 * Anything out of range is clipped; nonsense returns [].
 */
export function parseRanges(spec, total) {
  const out = [];
  const seen = new Set();
  const push = (n) => { if (n >= 0 && n < total && !seen.has(n)) { seen.add(n); out.push(n); } };
  for (const raw of String(spec || "").split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d*)\s*(?:[-–—]\s*(\d*))?$/.exec(part);
    if (!m) continue;
    const hasDash = /[-–—]/.test(part);
    if (!hasDash) {
      if (!m[1]) continue;
      push(Number(m[1]) - 1);
      continue;
    }
    const a = m[1] ? Number(m[1]) - 1 : 0;
    const b = m[2] ? Number(m[2]) - 1 : total - 1;
    if (a <= b) for (let i = a; i <= b; i++) push(i);
    else for (let i = a; i >= b; i--) push(i);
  }
  return out;
}

/** [0,1,2,4,7,8] -> "1-3, 5, 8-9" (one-based, for a label). */
export function formatRanges(indices) {
  const list = [...new Set(indices)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  const runs = [];
  for (const n of list) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}-${b + 1}`)).join(", ");
}

/**
 * Cut `total` pages into parts. `marks` are one-based page numbers that each
 * start a new part; page 1 always starts the first one. Returns arrays of
 * zero-based indices, never empty, in reading order.
 */
export function splitAt(total, marks) {
  if (!(total > 0)) return [];
  const starts = [...new Set([1, ...(marks || []).map((n) => Math.round(Number(n)))])]
    .filter((n) => n >= 1 && n <= total)
    .sort((a, b) => a - b);
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : total;
    const part = [];
    for (let p = s; p <= end; p++) part.push(p - 1);
    return part;
  });
}

/** Cut into chunks of `per` pages: 10 pages by 4 -> [4, 4, 2]. */
export function splitEvery(total, per) {
  const n = Math.max(1, Math.round(Number(per) || 1));
  const marks = [];
  for (let p = 1 + n; p <= total; p += n) marks.push(p);
  return splitAt(total, marks);
}

// ── zoom and what is on screen ──────────────────────────────────────────────

/**
 * Scale for a fit mode. `gap` is the padding the viewer keeps around a page.
 * "width" fills the column, "page" shows a whole page, a number is literal.
 */
export function fitScale(mode, pageW, pageH, viewW, viewH, gap = 32) {
  const w = Math.max(1, viewW - gap), hh = Math.max(1, viewH - gap);
  if (mode === "width") return clampScale(w / pageW);
  if (mode === "page") return clampScale(Math.min(w / pageW, hh / pageH));
  const n = Number(mode);
  return clampScale(Number.isFinite(n) && n > 0 ? n : 1);
}

export const clampScale = (s) => Math.min(6, Math.max(0.1, s));

/**
 * Which pages to keep rendered. `tops` are page offsets, `heights` their laid
 * out heights; `over` is how many screens of slack to keep either side.
 * Returns [first, last] inclusive - always at least one page.
 */
export function visibleRange(tops, heights, scrollTop, viewH, over = 1) {
  const n = tops.length;
  if (!n) return [0, -1];
  const a = scrollTop - viewH * over;
  const b = scrollTop + viewH * (1 + over);
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    const t = tops[i], bt = t + heights[i];
    if (bt < a || t > b) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) {
    // scrolled past everything (a stale layout): pin to the nearest page
    const i = scrollTop <= tops[0] ? 0 : n - 1;
    return [i, i];
  }
  return [first, last];
}

/** The page the reader is actually looking at: the one covering the middle. */
export function currentPage(tops, heights, scrollTop, viewH) {
  const eye = scrollTop + viewH * 0.35;
  let best = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= eye) best = i;
    else break;
  }
  return best;
}

/**
 * Canvases to drop when rendered pixels pass the budget. `pages` are the page
 * indices holding a canvas with its pixel count; the ones furthest from
 * [first,last] go first. Returns the indices to release.
 */
export function evictCanvases(pixels, first, last, budget) {
  const live = [...pixels.keys()];
  let total = 0;
  for (const p of live) total += pixels.get(p) || 0;
  if (total <= budget) return [];
  const dist = (i) => (i < first ? first - i : i > last ? i - last : 0);
  const order = live.slice().sort((a, b) => dist(b) - dist(a) || b - a);
  const drop = [];
  for (const i of order) {
    if (total <= budget) break;
    if (dist(i) === 0) continue; // never throw away what is on screen
    total -= pixels.get(i) || 0;
    drop.push(i);
  }
  return drop;
}

// ── annotations ─────────────────────────────────────────────────────────────

export const ANNOT_TYPES = ["highlight", "underline", "strike", "ink", "note", "text", "rect", "ellipse", "arrow", "stamp"];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r3 = (v) => Math.round(num(v) * 1000) / 1000;
const hex = (c, d = "#e0a84a") => (/^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : d);

/**
 * An annotation as it is kept and saved: plain JSON, page-local PDF points
 * with the origin bottom-left, numbers rounded to a thousandth of a point.
 * `packAnnot(unpackAnnot(x))` is stable, which is what the round-trip test
 * checks - a record that survives a save and a reload unchanged.
 */
export function packAnnot(rec) {
  if (!rec || !ANNOT_TYPES.includes(rec.type)) return null;
  const out = {
    id: String(rec.id || ""),
    type: rec.type,
    page: Math.max(0, Math.round(num(rec.page))),
    color: hex(rec.color),
    opacity: Math.min(1, Math.max(0.05, num(rec.opacity, 1))),
  };
  if (!out.id) return null;
  if (rec.type === "highlight" || rec.type === "underline" || rec.type === "strike") {
    out.quads = (rec.quads || []).map((q) => q.slice(0, 4).map(r3)).filter((q) => q.length === 4 && q[2] > 0 && q[3] > 0);
    if (!out.quads.length) return null;
  } else if (rec.type === "ink") {
    out.width = Math.min(48, Math.max(0.5, num(rec.width, 2)));
    out.strokes = (rec.strokes || [])
      .map((s) => s.map((p) => [r3(p[0]), r3(p[1])]))
      .filter((s) => s.length >= 1);
    if (!out.strokes.length) return null;
  } else if (rec.type === "stamp") {
    out.rect = (rec.rect || []).slice(0, 4).map(r3);
    out.image = String(rec.image || "");
    if (out.rect.length !== 4 || !out.image) return null;
  } else {
    out.rect = (rec.rect || []).slice(0, 4).map(r3);
    if (out.rect.length !== 4) return null;
    if (rec.type === "rect" || rec.type === "ellipse" || rec.type === "arrow") out.width = Math.min(48, Math.max(0.5, num(rec.width, 2)));
    if (rec.type === "rect" || rec.type === "ellipse") out.fill = rec.fill ? hex(rec.fill) : null;
  }
  if (rec.type === "note" || rec.type === "text") out.fontSize = Math.min(96, Math.max(6, num(rec.fontSize, 12)));
  if (rec.text != null && rec.text !== "") out.text = String(rec.text);
  if (rec.font) out.font = String(rec.font).slice(0, 200); // a CSS family for the text box: the page's own (pdf.js loads it as a font face)
  if (rec.burn) out.burn = true; // drawn into the page itself on save, not left as an annotation
  if (rec.author) out.author = String(rec.author);
  if (rec.created) out.created = String(rec.created);
  for (const k of Object.keys(out)) if (out[k] === null && k !== "fill") delete out[k];
  return out;
}

/** The other half of the round trip: anything unrecognised becomes null. */
export function unpackAnnot(obj) {
  if (!obj || typeof obj !== "object") return null;
  return packAnnot(obj);
}

/** A whole sheet of annotations, keyed by the page's stable id. */
export function packAnnots(map) {
  const out = {};
  for (const [id, list] of map) {
    const recs = (list || []).map(packAnnot).filter(Boolean);
    if (recs.length) out[id] = recs;
  }
  return out;
}

export function unpackAnnots(obj) {
  const m = new Map();
  for (const id of Object.keys(obj || {})) {
    const recs = (obj[id] || []).map(unpackAnnot).filter(Boolean);
    // JSON keys are strings; page ids are numbers, and a Map tells them apart
    if (recs.length) m.set(/^\d+$/.test(id) ? Number(id) : id, recs);
  }
  return m;
}

/**
 * Follow per-page data through a page move. `order[newIndex] = oldIndex`, so a
 * page that was deleted simply takes its annotations with it and one that moved
 * keeps them. Works on any Map keyed by page index.
 */
export function remapPages(map, order) {
  const next = new Map();
  order.forEach((from, to) => { if (map.has(from)) next.set(to, map.get(from)); });
  return next;
}

/** Annotation quads for a run of client rects, in PDF points. */
export function rectsToQuads(rects) {
  return rects
    .map((r) => [r3(r.x), r3(r.y), r3(r.w), r3(r.h)])
    .filter((q) => q[2] > 0.5 && q[3] > 0.5);
}

// ── forms ───────────────────────────────────────────────────────────────────

const FIELD_KINDS = { PDFTextField: "text", PDFCheckBox: "check", PDFDropdown: "choice", PDFOptionList: "list", PDFRadioGroup: "radio", PDFButton: "button", PDFSignature: "signature" };

/**
 * pdf-lib's field objects -> the model the panel draws. `raw` entries are
 * `{ ctor, name, value, options, readOnly, multiline, maxLength }`, which is
 * everything the caller can get out of pdf-lib without a document here.
 */
export function fieldModel(raw) {
  return (raw || [])
    .map((f, i) => {
      const kind = FIELD_KINDS[f.ctor] || "text";
      if (kind === "button" || kind === "signature") return null;
      return {
        key: `f${i}`,
        name: String(f.name || `Field ${i + 1}`),
        label: fieldLabel(f.name, i),
        kind,
        value: coerceField(kind, f.value, f.options),
        options: kind === "choice" || kind === "list" || kind === "radio" || (kind === "check" && f.options) ? (f.options || []).map(String) : null,
        readOnly: !!f.readOnly,
        multiline: !!f.multiline,
        maxLength: Number.isFinite(f.maxLength) ? f.maxLength : null,
      };
    })
    .filter(Boolean);
}

/** "customer.address.city" reads better as "City". */
export function fieldLabel(name, i) {
  const s = String(name || "").split(".").pop().replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!s) return `Field ${i + 1}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Force a typed value into what the field can hold. */
export function coerceField(kind, value, options) {
  // A tick box with options is a pair answering differently (Yes/No): its value says which box, like a radio group.
  if (kind === "check" && !options) return value === true || value === "true" || value === "Yes" || value === "On";
  if (kind === "list") {
    const list = (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]).map(String);
    return options ? list.filter((v) => options.map(String).includes(v)) : list;
  }
  if (kind === "choice" || kind === "radio" || kind === "check") {
    const v = Array.isArray(value) ? value[0] : value;
    const s = v == null ? "" : String(v);
    if (options && options.length && !options.map(String).includes(s)) return "";
    return s;
  }
  return value == null ? "" : String(value);
}

/** Only the fields the reader actually changed, ready to write back. */
export function changedFields(model, edits) {
  const out = [];
  for (const f of model) {
    if (f.readOnly || !(f.key in edits)) continue;
    const v = coerceField(f.kind, edits[f.key], f.options);
    if (same(v, f.value)) continue;
    out.push({ name: f.name, kind: f.kind, value: v });
  }
  return out;
}

const same = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);

// ── naming the file that comes out ──────────────────────────────────────────

const splitExt = (p) => {
  const slash = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  return dot > slash ? [p.slice(0, dot), p.slice(dot + 1)] : [p, ""];
};

/**
 * A free path beside the original: "Projects/brief.pdf" + "pages 1-3" ->
 * "Projects/brief (pages 1-3).pdf", and " 2", " 3"… if that is taken.
 * `taken` is anything with `.has(path)` (the vault's file map).
 */
export function outputName(taken, path, suffix, ext) {
  const [base, oldExt] = splitExt(String(path || "untitled.pdf"));
  const e = (ext || oldExt || "pdf").replace(/^\./, "");
  const tag = String(suffix || "").trim();
  const stem = tag ? `${base} (${tag})` : base;
  const has = (p) => (taken && typeof taken.has === "function" ? taken.has(p) : false);
  let out = `${stem}.${e}`;
  for (let i = 2; has(out); i++) out = `${stem} ${i}.${e}`;
  return out;
}

/** What each part of a split is called: "brief (part 1).pdf" and so on. */
export function splitNames(taken, path, parts) {
  const used = new Set();
  const guard = { has: (p) => used.has(p) || (taken && taken.has ? taken.has(p) : false) };
  return parts.map((pages, i) => {
    const name = outputName(guard, path, `part ${i + 1} · pages ${formatRanges(pages)}`, "pdf");
    used.add(name);
    return name;
  });
}

// ── limits ──────────────────────────────────────────────────────────────────

/**
 * Leonote will not try to hold a PDF bigger than this in memory. It is set
 * below the backend's 100 MB write ceiling on purpose: a document that opens
 * must also be one that can be saved, and saving usually adds a little.
 */
export const MAX_PDF_BYTES = 80 * 1024 * 1024;
/** Above this it still opens, but says that pages will arrive as you reach them. */
export const HEAVY_PDF_BYTES = 25 * 1024 * 1024;
/** Rendered pixels kept at once, roughly 260 MB of RGBA. */
export const CANVAS_PIXEL_BUDGET = 65_000_000;

export function sizeVerdict(bytes) {
  if (bytes > MAX_PDF_BYTES) return "refuse";
  if (bytes > HEAVY_PDF_BYTES) return "heavy";
  return "ok";
}
