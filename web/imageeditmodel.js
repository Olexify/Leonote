// Non-destructive picture edits, as plain data.
//
// Nothing here touches the DOM or a canvas: this module is the shape of the
// sidecar file, the layer arithmetic and the filter strings. The editor
// (imageedit.js), the renderer (imageeditrender.js) and the tests all agree
// through it.
//
// The picture itself is never written. Every edit lives in a sidecar next to
// it, in the folder's hidden `.leonote` directory:
//
//   Ideas/moodboard.png  ->  Ideas/.leonote/moodboard.png.leoedit.json
//
// Hidden, because the vault scanner skips dot-directories: the sidecars never
// appear in the file tree, in search, in the graph or in a board, and they
// travel with the pictures when a folder is moved or synced.

export const SIDECAR_VERSION = 1;
export const SIDECAR_DIR = ".leonote";
export const SIDECAR_EXT = ".leoedit.json";

/** `Ideas/moodboard.png` -> `Ideas/.leonote/moodboard.png.leoedit.json`. */
export function sidecarPath(imagePath) {
  const p = String(imagePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p) return "";
  const cut = p.lastIndexOf("/");
  const dir = cut < 0 ? "" : p.slice(0, cut);
  const name = p.slice(cut + 1);
  if (!name) return "";
  return `${dir ? dir + "/" : ""}${SIDECAR_DIR}/${name}${SIDECAR_EXT}`;
}

/* ── adjustments ─────────────────────────────────────────────────────────── */

/** Every slider, in the order the panel shows them. */
export const ADJUST = [
  { key: "exposure", label: "Exposure", min: -100, max: 100, def: 0, step: 1 },
  { key: "brightness", label: "Brightness", min: -100, max: 100, def: 0, step: 1 },
  { key: "contrast", label: "Contrast", min: -100, max: 100, def: 0, step: 1 },
  { key: "saturation", label: "Saturation", min: -100, max: 100, def: 0, step: 1 },
  { key: "warmth", label: "Warmth", min: -100, max: 100, def: 0, step: 1 },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100, def: 0, step: 1 },
  { key: "blur", label: "Blur", min: 0, max: 20, def: 0, step: 0.5, unit: "px" },
  { key: "vignette", label: "Vignette", min: 0, max: 100, def: 0, step: 1 },
  { key: "grayscale", label: "Greyscale", min: 0, max: 100, def: 0, step: 1 },
  { key: "invert", label: "Invert", min: 0, max: 100, def: 0, step: 1 },
];

export const DEFAULT_ADJUST = Object.freeze(Object.fromEntries(ADJUST.map((a) => [a.key, a.def])));

/** A few looks worth one click. Each one is a complete set of values. */
export const PRESETS = [
  { id: "none", name: "Original", adjust: {} },
  { id: "vivid", name: "Vivid", adjust: { contrast: 14, saturation: 30, exposure: 4, sharpen: 12 } },
  { id: "warmfilm", name: "Warm film", adjust: { warmth: 42, contrast: 8, saturation: -6, exposure: 4, vignette: 18 } },
  { id: "cool", name: "Cool", adjust: { warmth: -38, contrast: 8, saturation: 8 } },
  { id: "faded", name: "Faded", adjust: { contrast: -18, saturation: -24, exposure: 10, warmth: 14 } },
  { id: "noir", name: "Noir", adjust: { grayscale: 100, contrast: 28, exposure: -4, vignette: 36 } },
  { id: "mono", name: "Soft mono", adjust: { grayscale: 100, contrast: -8, exposure: 6 } },
  { id: "negative", name: "Negative", adjust: { invert: 100 } },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, def) => (Number.isFinite(+v) ? +v : def);
const r3 = (x) => String(Math.round(x * 1000) / 1000);

/** Every value back inside its slider's range, unknown keys dropped. */
export function normalizeAdjust(raw) {
  const out = {};
  for (const a of ADJUST) out[a.key] = clamp(num(raw && raw[a.key], a.def), a.min, a.max);
  return out;
}

/** True when nothing would change the pixels. */
export function isNeutralAdjust(raw) {
  const a = normalizeAdjust(raw);
  return ADJUST.every((d) => a[d.key] === d.def);
}

export function adjustFromPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  return { ...DEFAULT_ADJUST, ...(p ? p.adjust : {}) };
}

/**
 * The CSS `filter` value for these adjustments — the same string drives the
 * live preview (an element's style) and the flattened copy (`ctx.filter`).
 * Empty when nothing changes, so callers can write "none".
 *
 * Sharpen and vignette are NOT here: CSS has no sharpen, and a vignette is a
 * shape rather than a filter. imageeditrender.js draws both.
 */
export function filterString(raw) {
  const v = normalizeAdjust(raw);
  const out = [];
  if (v.exposure) out.push(`brightness(${r3(Math.pow(2, v.exposure / 100))})`);
  if (v.brightness) out.push(`brightness(${r3(1 + v.brightness / 100)})`);
  if (v.contrast) out.push(`contrast(${r3(1 + v.contrast / 100)})`);
  if (v.saturation) out.push(`saturate(${r3(1 + v.saturation / 100)})`);
  if (v.warmth > 0) out.push(`sepia(${r3((v.warmth / 100) * 0.55)})`, `saturate(${r3(1 + (v.warmth / 100) * 0.4)})`);
  else if (v.warmth < 0) out.push(`hue-rotate(${r3(v.warmth * 0.2)}deg)`, `saturate(${r3(1 + (-v.warmth / 100) * 0.22)})`);
  if (v.grayscale) out.push(`grayscale(${r3(v.grayscale / 100)})`);
  if (v.invert) out.push(`invert(${r3(v.invert / 100)})`);
  if (v.blur) out.push(`blur(${r3(v.blur)}px)`);
  return out.join(" ");
}

/**
 * A 3×3 unsharp kernel. Sums to 1, so an even area keeps its brightness
 * whatever the amount is.
 */
export function sharpenKernel(amount) {
  const a = clamp(num(amount, 0), 0, 100) / 100;
  const c = 1 + 4 * a;
  const e = -a;
  return [0, e, 0, e, c, e, 0, e, 0];
}

/* ── layers ──────────────────────────────────────────────────────────────── */

export const TOOLS = ["pen", "marker", "line", "arrow", "rect", "ellipse", "text", "eraser"];
const SHAPE_TYPES = new Set(["pen", "marker", "line", "rect", "ellipse", "text", "erase", "group", "snip"]);
export const TEXT_FONTS = { sans: '"Inter Variable", "Segoe UI", system-ui, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: '"JetBrains Mono", Consolas, monospace' };

let seq = 0;
/** Short id. Unique inside one document, which is all a layer needs. */
export function rid(prefix = "l") {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function newLayer(name = "Layer", extra = {}) {
  return { id: rid(), name: String(name), hidden: false, opacity: 1, shapes: [], ...extra };
}

/** The next free "Layer N" for a list that may already hold some. */
export function nextLayerName(layers) {
  let n = (layers || []).length + 1;
  const taken = new Set((layers || []).map((l) => String(l && l.name)));
  while (taken.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

function normalizeShape(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = String(raw.t || "");
  if (!SHAPE_TYPES.has(t)) return null;
  const s = { t };
  if (t === "group") {
    s.alpha = clamp(num(raw.alpha, 1), 0, 1);
    s.shapes = (Array.isArray(raw.shapes) ? raw.shapes : []).map(normalizeShape).filter(Boolean);
    return s;
  }
  s.w = clamp(num(raw.w, 4), 0.5, 400);
  s.alpha = clamp(num(raw.alpha, 1), 0, 1);
  if (t !== "erase") s.c = typeof raw.c === "string" ? raw.c : "#e0a84a";
  if (t === "pen" || t === "marker" || t === "erase") {
    const pts = Array.isArray(raw.pts) ? raw.pts.map((n) => num(n, 0)) : [];
    s.pts = pts.slice(0, pts.length - (pts.length % 2));
    if (s.pts.length < 2) return null;
    return s;
  }
  if (t === "line") {
    s.x1 = num(raw.x1, 0); s.y1 = num(raw.y1, 0); s.x2 = num(raw.x2, 0); s.y2 = num(raw.y2, 0);
    if (raw.arrow) s.arrow = true;
    return s;
  }
  if (t === "rect" || t === "ellipse") {
    s.x = num(raw.x, 0); s.y = num(raw.y, 0); s.rw = num(raw.rw, 0); s.rh = num(raw.rh, 0);
    if (raw.fill) s.fill = String(raw.fill);
    return s;
  }
  if (t === "snip") {
    // a piece of the picture (sx, sy, sw, sh) shown at x, y, z times its size; `hole`: its old place filled with `fill`
    s.sx = num(raw.sx, 0); s.sy = num(raw.sy, 0); s.sw = Math.max(1, num(raw.sw, 1)); s.sh = Math.max(1, num(raw.sh, 1));
    s.x = num(raw.x, s.sx); s.y = num(raw.y, s.sy); s.z = clamp(num(raw.z, 1), 0.05, 20);
    if (raw.hole) { s.hole = true; s.fill = typeof raw.fill === "string" ? raw.fill : "#000000"; }
    delete s.w; delete s.c;
    return s;
  }
  // text
  s.x = num(raw.x, 0); s.y = num(raw.y, 0);
  s.size = clamp(num(raw.size, 32), 4, 2000);
  s.text = String(raw.text ?? "");
  if (!s.text) return null;
  if (typeof raw.bg === "string" && raw.bg) s.bg = raw.bg;
  if (raw.rim === false) s.rim = false;
  if (raw.font && TEXT_FONTS[raw.font] && raw.font !== "sans") s.font = raw.font;
  delete s.w;
  return s;
}

export function normalizeLayer(raw, i = 0) {
  const l = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof l.id === "string" && l.id ? l.id : rid(),
    name: typeof l.name === "string" && l.name.trim() ? l.name : `Layer ${i + 1}`,
    hidden: !!l.hidden,
    opacity: clamp(num(l.opacity, 1), 0, 1),
    shapes: (Array.isArray(l.shapes) ? l.shapes : []).map(normalizeShape).filter(Boolean),
  };
}

export function emptyDoc(width = 0, height = 0) {
  return { v: SIDECAR_VERSION, w: Math.max(0, Math.round(num(width, 0))), h: Math.max(0, Math.round(num(height, 0))), adjust: { ...DEFAULT_ADJUST }, adjustOn: true, preset: "", layers: [], off: false, crop: null };
}

/**
 * A crop, as shares of the picture (0..1) so it means the same at any
 * resolution: { x, y, w, h }. Null for none, or for one that keeps everything.
 */
export function normalizeCrop(c) {
  if (!c || typeof c !== "object") return null;
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  let x = Math.max(0, Math.min(1, n(c.x, 0)));
  let y = Math.max(0, Math.min(1, n(c.y, 0)));
  let w = Math.max(0, Math.min(1 - x, n(c.w, 1)));
  let h = Math.max(0, Math.min(1 - y, n(c.h, 1)));
  if (w < 0.01 || h < 0.01) return null;
  if (x < 0.002 && y < 0.002 && w > 0.996 && h > 0.996) return null;
  const r = (v) => Math.round(v * 10000) / 10000;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

/**
 * Whatever was on disk (or nothing at all) turned into a document this code
 * can rely on. Never throws: a damaged sidecar degrades to an empty one
 * rather than blocking the picture.
 */
export function normalizeDoc(raw, { width = 0, height = 0 } = {}) {
  let d = raw;
  if (typeof d === "string") {
    try { d = JSON.parse(d); } catch { d = null; }
  }
  if (!d || typeof d !== "object") return emptyDoc(width, height);
  const out = emptyDoc(num(d.w, width), num(d.h, height));
  if (!out.w) out.w = Math.max(0, Math.round(num(width, 0)));
  if (!out.h) out.h = Math.max(0, Math.round(num(height, 0)));
  out.adjust = normalizeAdjust(d.adjust);
  out.adjustOn = d.adjustOn === undefined ? true : !!d.adjustOn;
  out.preset = typeof d.preset === "string" && PRESETS.some((p) => p.id === d.preset) ? d.preset : "";
  out.layers = (Array.isArray(d.layers) ? d.layers : []).map(normalizeLayer);
  // "edits off": the viewer's switch, kept with the edits so it stays as left
  out.off = !!d.off;
  out.crop = normalizeCrop(d.crop);
  return out;
}

/** The sidecar's text. Keys in a fixed order, so a no-op edit is a no-op diff. */
export function serializeDoc(doc, { image = "" } = {}) {
  const d = normalizeDoc(doc);
  return JSON.stringify({
    leoedit: SIDECAR_VERSION,
    image: String(image || ""),
    w: d.w,
    h: d.h,
    adjustOn: d.adjustOn,
    ...(d.off ? { off: true } : {}),
    ...(d.crop ? { crop: d.crop } : {}),
    preset: d.preset,
    adjust: Object.fromEntries(ADJUST.map((a) => [a.key, d.adjust[a.key]])),
    layers: d.layers.map((l) => ({ id: l.id, name: l.name, hidden: l.hidden, opacity: l.opacity, shapes: l.shapes })),
  }, null, 1);
}

/** Nothing drawn and nothing adjusted: the sidecar may as well not exist. */
export function isEmptyDoc(doc) {
  const d = normalizeDoc(doc);
  return isNeutralAdjust(d.adjust) && d.layers.every((l) => !l.shapes.length) && !d.crop;
}

/** True when the document would change what the picture looks like. */
export function docChangesPicture(doc) {
  const d = normalizeDoc(doc);
  if (d.crop) return true;
  const drawn = d.layers.some((l) => !l.hidden && l.opacity > 0 && l.shapes.length);
  return drawn || (d.adjustOn && !isNeutralAdjust(d.adjust));
}

/** Layers in render order (bottom first) with `from` moved to index `to`. */
export function moveLayer(layers, from, to) {
  const out = (layers || []).slice();
  if (from < 0 || from >= out.length) return out;
  const t = clamp(Math.round(num(to, from)), 0, out.length - 1);
  const [it] = out.splice(from, 1);
  out.splice(t, 0, it);
  return out;
}

/**
 * A layer's shapes with its opacity baked in, ready to live in another layer.
 *
 * A layer that erases is wrapped in a group instead: its eraser strokes must
 * keep cutting only what that layer painted, never the layer underneath it.
 */
export function bakeLayer(layer) {
  const l = normalizeLayer(layer);
  const op = l.opacity;
  if (l.shapes.some((s) => s.t === "erase")) return l.shapes.length ? [{ t: "group", alpha: op, shapes: l.shapes }] : [];
  return l.shapes.map((s) => ({ ...s, alpha: clamp((s.alpha ?? 1) * op, 0, 1) }));
}

/**
 * Merge `layers[i]` down into `layers[i - 1]`. The lower layer keeps its name
 * and id; both opacities are baked into the shapes, so what you saw is what
 * you get. A hidden layer contributes nothing but is still consumed.
 */
export function mergeDown(layers, i) {
  const src = (layers || []).map(normalizeLayer);
  if (i <= 0 || i >= src.length) return src;
  const lower = src[i - 1];
  const upper = src[i];
  const merged = {
    ...lower,
    hidden: false,
    opacity: 1,
    shapes: [...(lower.hidden ? [] : bakeLayer(lower)), ...(upper.hidden ? [] : bakeLayer(upper))],
  };
  const out = src.slice();
  out.splice(i - 1, 2, merged);
  return out;
}

/** Every visible layer into one. Hidden layers are dropped. */
export function flattenLayers(layers, name = "Drawing") {
  const src = (layers || []).map(normalizeLayer);
  const shapes = [];
  for (const l of src) if (!l.hidden && l.opacity > 0) shapes.push(...bakeLayer(l));
  return [{ id: src[0] ? src[0].id : rid(), name, hidden: false, opacity: 1, shapes }];
}

/** How many marks a layer holds, counting inside merged groups. */
export function countShapes(shapes) {
  let n = 0;
  for (const s of shapes || []) n += s.t === "group" ? countShapes(s.shapes) : 1;
  return n;
}

/* ── embeds ──────────────────────────────────────────────────────────────── */

/** `Ideas/moodboard.png` -> `![[moodboard.png]]`, the link the vault uses. */
export function embedFor(path) {
  const p = String(path || "").replace(/\\/g, "/");
  return `![[${p.slice(p.lastIndexOf("/") + 1)}]]`;
}

/**
 * The same note with `embed` at the end — one blank line between it and
 * whatever was there, and the file left newline-terminated. A note that
 * already shows this picture is handed back untouched, so "Insert into a
 * note…" can say so instead of embedding it twice.
 */
export function insertEmbed(text, embed) {
  const src = String(text ?? "");
  const e = String(embed || "");
  if (!e) return { text: src, added: false };
  if (src.includes(e)) return { text: src, added: false };
  const body = src.replace(/\s+$/, "");
  return { text: body ? `${body}\n\n${e}\n` : `${e}\n`, added: true };
}

/**
 * A free name for the flattened copy: `photo (edited).webp`, then
 * `photo (edited 2).webp`… `taken(path)` says whether one is in use.
 */
export function editedName(path, taken = () => false, ext) {
  const p = String(path || "").replace(/\\/g, "/");
  const cut = p.lastIndexOf("/");
  const dir = cut < 0 ? "" : p.slice(0, cut);
  const name = p.slice(cut + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const e = ext || (dot > 0 ? name.slice(dot + 1) : "webp");
  const at = (suffix) => `${dir ? dir + "/" : ""}${base} (${suffix}).${e}`;
  let out = at("edited");
  for (let i = 2; taken(out) && i < 500; i++) out = at(`edited ${i}`);
  return out;
}

/* ── picking marks: bounds, hit-testing, moving ──────────────────────────── */

/** Rough width of a label when nothing better can measure it. */
const roughText = (text, size) => Math.max(...String(text).split("\n").map((l) => l.length)) * size * 0.58;

/**
 * The box a mark covers, in picture pixels, ink included. `measure(text, size)`
 * may give a label's real width; without it the width is estimated.
 * An eraser stroke has no box of its own: there is nothing of it to grab.
 */
export function shapeBounds(s, measure = null) {
  if (!s) return null;
  if (s.t === "group") {
    let box = null;
    for (const k of s.shapes || []) {
      const b = shapeBounds(k, measure);
      if (!b) continue;
      box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
    }
    return box;
  }
  if (s.t === "erase") return null;
  const half = (s.t === "text" ? 0 : s.w || 0) / 2;
  if (s.t === "pen" || s.t === "marker") {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < s.pts.length; i += 2) {
      x0 = Math.min(x0, s.pts[i]); x1 = Math.max(x1, s.pts[i]);
      y0 = Math.min(y0, s.pts[i + 1]); y1 = Math.max(y1, s.pts[i + 1]);
    }
    return { x0: x0 - half, y0: y0 - half, x1: x1 + half, y1: y1 + half };
  }
  if (s.t === "line") {
    const pad = s.arrow ? Math.max(half, Math.max((s.w || 4) * 3.2, 8) * 0.5) : half;
    return { x0: Math.min(s.x1, s.x2) - pad, y0: Math.min(s.y1, s.y2) - pad, x1: Math.max(s.x1, s.x2) + pad, y1: Math.max(s.y1, s.y2) + pad };
  }
  if (s.t === "rect" || s.t === "ellipse") {
    return { x0: Math.min(s.x, s.x + s.rw) - half, y0: Math.min(s.y, s.y + s.rh) - half, x1: Math.max(s.x, s.x + s.rw) + half, y1: Math.max(s.y, s.y + s.rh) + half };
  }
  if (s.t === "text") {
    const lines = String(s.text).split("\n");
    const w = measure ? measure(s.text, s.size, s.font) : roughText(s.text, s.size);
    const p = s.bg ? s.size * 0.3 : 0;
    return { x0: s.x - p, y0: s.y - p, x1: s.x + w + p, y1: s.y + lines.length * s.size * 1.22 + p };
  }
  if (s.t === "snip") return { x0: s.x, y0: s.y, x1: s.x + s.sw * s.z, y1: s.y + s.sh * s.z };
  return null;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Is the point on the mark's ink? `tol` is slack in picture pixels, so a thin
 * line can still be caught. With `inside`, the empty middle of an outline
 * counts too - the second pass of a click that caught nothing the first time.
 */
export function hitShape(s, x, y, tol = 0, { inside = false, measure = null } = {}) {
  if (!s || s.t === "erase") return false;
  if (s.t === "group") return (s.shapes || []).some((k) => hitShape(k, x, y, tol, { inside, measure }));
  const b = shapeBounds(s, measure);
  if (!b || x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) return false;
  const reach = (s.w || 0) / 2 + tol;
  if (s.t === "pen" || s.t === "marker") {
    const p = s.pts;
    if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach;
    for (let i = 0; i + 3 < p.length; i += 2) if (segDist(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true;
    return false;
  }
  if (s.t === "line") return segDist(x, y, s.x1, s.y1, s.x2, s.y2) <= Math.max(reach, s.arrow ? reach * 1.6 : 0);
  if (s.t === "text" || s.t === "snip") return true;
  const x0 = Math.min(s.x, s.x + s.rw), y0 = Math.min(s.y, s.y + s.rh);
  const w = Math.abs(s.rw), hgt = Math.abs(s.rh);
  if (s.t === "rect") {
    const within = x >= x0 - reach && x <= x0 + w + reach && y >= y0 - reach && y <= y0 + hgt + reach;
    if (!within) return false;
    if (s.fill || inside) return true;
    return !(x > x0 + reach && x < x0 + w - reach && y > y0 + reach && y < y0 + hgt - reach);
  }
  // ellipse: how far along the ray from the centre the point is, 1 = on the line
  const rx = w / 2 || 0.5, ry = hgt / 2 || 0.5;
  const d = Math.hypot((x - (x0 + rx)) / rx, (y - (y0 + ry)) / ry);
  const slack = reach / Math.min(rx, ry);
  if (s.fill || inside) return d <= 1 + slack;
  return Math.abs(d - 1) <= slack;
}

/**
 * The topmost mark under a point: `{ layer, index }` (indices into `layers`
 * and its `shapes`) or null. Hidden layers cannot be picked. Ink first; only
 * if nothing was hit does the inside of an outline count.
 */
export function pickShape(layers, x, y, tol = 0, measure = null) {
  for (const inside of [false, true]) {
    for (let li = (layers || []).length - 1; li >= 0; li--) {
      const l = layers[li];
      if (!l || l.hidden || !l.opacity) continue;
      for (let si = l.shapes.length - 1; si >= 0; si--) {
        if (hitShape(l.shapes[si], x, y, tol, { inside, measure })) return { layer: li, index: si };
      }
    }
  }
  return null;
}

/** Every mark whose box touches the rectangle, as `{ layer, index }`. */
export function shapesInRect(layers, rect, measure = null) {
  const out = [];
  const rx0 = Math.min(rect.x0, rect.x1), rx1 = Math.max(rect.x0, rect.x1);
  const ry0 = Math.min(rect.y0, rect.y1), ry1 = Math.max(rect.y0, rect.y1);
  (layers || []).forEach((l, li) => {
    if (!l || l.hidden || !l.opacity) return;
    l.shapes.forEach((s, si) => {
      const b = shapeBounds(s, measure);
      if (b && b.x0 <= rx1 && b.x1 >= rx0 && b.y0 <= ry1 && b.y1 >= ry0) out.push({ layer: li, index: si });
    });
  });
  return out;
}

/** The same mark, `dx, dy` picture pixels away. A new object; the old one is untouched. */
export function moveShape(s, dx, dy) {
  if (!s) return s;
  if (s.t === "group") return { ...s, shapes: (s.shapes || []).map((k) => moveShape(k, dx, dy)) };
  if (s.pts) return { ...s, pts: s.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
  if (s.t === "line") return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
  return { ...s, x: s.x + dx, y: s.y + dy };
}

/** The same mark in another colour or weight. Groups pass it down; erasers have no colour. */
export function restyleShape(s, { c, w } = {}) {
  if (!s) return s;
  if (s.t === "group") return { ...s, shapes: (s.shapes || []).map((k) => restyleShape(k, { c, w })) };
  const out = { ...s };
  if (c && s.t !== "erase") out.c = c;
  if (w && s.t !== "text" && s.t !== "erase") out.w = s.t === "marker" ? w * 2.2 : w;
  return out;
}
