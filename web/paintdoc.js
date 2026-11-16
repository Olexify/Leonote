// The Draw document: canvas size, layers, blend modes — and the manifest that
// goes into a `.leostudio` file. Pure (no DOM, no canvas), so all of it runs
// under `node --test`.
//
// A `.leostudio` is a plain zip. Unzip one and you can read everything:
//
//   doc.json          the manifest below, pretty-printed
//   layers/<id>.png   one full-colour PNG per raster layer, bottom-first
//   thumb.png         a small preview of the flattened picture
//
// Nothing is obfuscated and nothing is packed into a private binary blob: a
// drawing you made in Leonote is still eight PNGs and a JSON file in five
// years, with or without Leonote. `layers` is ordered bottom-first, the same
// order they are composited in; the layers panel shows it reversed.

export const FORMAT = "leostudio";
const OLD_FORMAT = "leopaint"; // what the manifest said before the file became .leostudio
// Version 1 is raster layers only. Version 2 adds what Studio needs: layer
// kinds (adjustment, group, text), masks, clipping. A document that uses none
// of that is still written as version 1, so it opens in an older Leonote.
export const VERSION = 2;

/** Hard ceilings. A document bigger than this is a mistake, not a drawing. */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 24 * 1024 * 1024; // 24 MP — 4000×4000 fits with room
export const MAX_LAYERS = 64;

/* ── canvas presets ──────────────────────────────────────────────────────── */

// Grouped so the "New drawing" sheet can show them as sections. `dpi` is what
// the manifest records; it only matters for print sizes and export metadata.
// `for`: a group shown only to one way of working (paint, photo, animate), and first there
export const PRESET_GROUPS = [
  {
    id: "anim", name: "Animation", for: "animate",
    items: [
      { id: "an-reel", name: "Reel · TikTok · Short", note: "1080 × 1920 · 12 fps", w: 1080, h: 1920, dpi: 72, fps: 12 },
      { id: "an-post", name: "Post loop", note: "1080 × 1350 · 12 fps", w: 1080, h: 1350, dpi: 72, fps: 12 },
      { id: "an-square", name: "Square loop", note: "1080 × 1080 · 12 fps", w: 1080, h: 1080, dpi: 72, fps: 12 },
      { id: "an-wide", name: "Wide 16:9", note: "1920 × 1080 · 24 fps", w: 1920, h: 1080, dpi: 72, fps: 24 },
      { id: "an-board", name: "Storyboard", note: "1280 × 720 · 6 fps, quick", w: 1280, h: 720, dpi: 72, fps: 6 },
      { id: "an-flip", name: "Flipbook", note: "1024 × 768 · 12 fps, light", w: 1024, h: 768, dpi: 72, fps: 12 },
      { id: "an-sticker", name: "Sticker · GIF", note: "512 × 512 · 15 fps", w: 512, h: 512, dpi: 72, fps: 15 },
      { id: "an-emote", name: "Emote", note: "112 × 112 · 12 fps", w: 112, h: 112, dpi: 72, fps: 12 },
      { id: "an-px64", name: "Pixel art 64", note: "64 × 64 · 8 fps", w: 64, h: 64, dpi: 72, fps: 8 },
      { id: "an-px128", name: "Pixel art 128", note: "128 × 128 · 8 fps", w: 128, h: 128, dpi: 72, fps: 8 },
    ],
  },
  {
    id: "photo", name: "Photo", for: "photo",
    items: [
      { id: "ph-32", name: "Photo 3:2", note: "3600 × 2400 · 300 dpi", w: 3600, h: 2400, dpi: 300 },
      { id: "ph-43", name: "Photo 4:3", note: "3200 × 2400 · 300 dpi", w: 3200, h: 2400, dpi: 300 },
      { id: "ph-10x15", name: "Print 10 × 15 cm", note: "4 × 6 in · 300 dpi", w: 1800, h: 1200, dpi: 300 },
      { id: "ph-13x18", name: "Print 13 × 18 cm", note: "5 × 7 in · 300 dpi", w: 2100, h: 1500, dpi: 300 },
      { id: "ph-passport", name: "Passport photo", note: "35 × 45 mm · 300 dpi", w: 413, h: 531, dpi: 300 },
      { id: "ph-desk", name: "Desktop wallpaper", note: "2560 × 1440", w: 2560, h: 1440, dpi: 72 },
      { id: "ph-phone", name: "Phone wallpaper", note: "1179 × 2556", w: 1179, h: 2556, dpi: 72 },
    ],
  },
  {
    id: "art", name: "Art", for: "paint",
    items: [
      { id: "art-comic", name: "Comic page", note: "B5-ish · 300 dpi", w: 2150, h: 3035, dpi: 300 },
      { id: "art-webtoon", name: "Webtoon panel", note: "800 × 1280", w: 800, h: 1280, dpi: 72 },
      { id: "art-card", name: "Trading card", note: "63 × 88 mm · 300 dpi", w: 744, h: 1039, dpi: 300 },
      { id: "art-cover", name: "Book cover", note: "6 × 9 in · 300 dpi", w: 1800, h: 2700, dpi: 300 },
      { id: "art-postcard", name: "Postcard", note: "A6 · 300 dpi", w: 1748, h: 1240, dpi: 300 },
      { id: "art-concept", name: "Concept sheet", note: "3000 × 2000 · wide", w: 3000, h: 2000, dpi: 144 },
      { id: "art-px", name: "Pixel art", note: "256 × 256", w: 256, h: 256, dpi: 72 },
    ],
  },
  {
    id: "print", name: "Print",
    items: [
      { id: "a4-300", name: "A4", note: "210 × 297 mm · 300 dpi", w: 2480, h: 3508, dpi: 300 },
      { id: "a4-300-l", name: "A4 landscape", note: "297 × 210 mm · 300 dpi", w: 3508, h: 2480, dpi: 300 },
      { id: "a5-300", name: "A5", note: "148 × 210 mm · 300 dpi", w: 1748, h: 2480, dpi: 300 },
      { id: "a3-300", name: "A3", note: "297 × 420 mm · 300 dpi", w: 3508, h: 4961, dpi: 300 },
      { id: "letter-300", name: "US Letter", note: '8.5 × 11 in · 300 dpi', w: 2550, h: 3300, dpi: 300 },
    ],
  },
  {
    id: "square", name: "Square",
    items: [
      { id: "sq-1080", name: "Square 1080", note: "1080 × 1080", w: 1080, h: 1080, dpi: 72 },
      { id: "sq-2048", name: "Square 2048", note: "1080 × 1080 with room to zoom", w: 2048, h: 2048, dpi: 144 },
      { id: "sq-4096", name: "Square 4096", note: "big canvas · heavy", w: 4096, h: 4096, dpi: 300 },
    ],
  },
  {
    id: "social", name: "Social",
    items: [
      { id: "ig-post", name: "Instagram post", note: "1080 × 1350 · portrait 4:5", w: 1080, h: 1350, dpi: 72 },
      { id: "ig-square", name: "Instagram square", note: "1080 × 1080", w: 1080, h: 1080, dpi: 72 },
      { id: "ig-story", name: "Instagram story", note: "1080 × 1920 · 9:16", w: 1080, h: 1920, dpi: 72 },
      { id: "yt-thumb", name: "YouTube thumbnail", note: "1280 × 720", w: 1280, h: 720, dpi: 72 },
      { id: "yt-banner", name: "YouTube banner", note: "2560 × 1440", w: 2560, h: 1440, dpi: 72 },
      { id: "pin", name: "Pinterest pin", note: "1000 × 1500 · 2:3", w: 1000, h: 1500, dpi: 72 },
      { id: "x-header", name: "X header", note: "1500 × 500", w: 1500, h: 500, dpi: 72 },
      { id: "li-banner", name: "LinkedIn banner", note: "1584 × 396", w: 1584, h: 396, dpi: 72 },
      { id: "fb-cover", name: "Facebook cover", note: "1640 × 624", w: 1640, h: 624, dpi: 72 },
    ],
  },
  {
    id: "screen", name: "Screen",
    items: [
      { id: "hd", name: "1080p", note: "1920 × 1080", w: 1920, h: 1080, dpi: 72 },
      { id: "uhd", name: "4K", note: "3840 × 2160", w: 3840, h: 2160, dpi: 144 },
      { id: "sketch-pad", name: "Sketch pad", note: "1600 × 1200 · light and quick", w: 1600, h: 1200, dpi: 72 },
    ],
  },
];

export const PRESETS = PRESET_GROUPS.flatMap((g) => g.items.map((p) => ({ ...p, group: g.id })));
export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
export const DEFAULT_PRESET = "sq-2048";

/** Print size of a document, in mm, for the "210 × 297 mm" line under the size. */
export function printSize(width, height, dpi) {
  const mm = (px) => Math.round((px / (dpi || 72)) * 25.4);
  return { w: mm(width), h: mm(height) };
}

/** Bytes one full-size RGBA layer costs. The UI warns above ~a few hundred MB. */
export const layerBytes = (width, height) => width * height * 4;

/**
 * What a document will cost in memory: every layer, plus the three working
 * buffers the engine keeps (stroke scratch, flatten cache, selection mask).
 * See paintengine.js — this is the number the New drawing sheet shows.
 */
export function memoryEstimate(width, height, layers = 1) {
  const one = layerBytes(width, height);
  return one * (layers + 2) + width * height; // mask is 8-bit
}

/* ── blend modes ─────────────────────────────────────────────────────────── */

// The canvas composite operation each one maps to. Kept to the eight that
// mean the same thing in Photoshop, Clip Studio and here, so a drawing looks
// the same after a round trip through any of them.
export const BLEND_MODES = [
  { id: "normal", name: "Normal", op: "source-over" },
  { id: "multiply", name: "Multiply", op: "multiply" },
  { id: "screen", name: "Screen", op: "screen" },
  { id: "overlay", name: "Overlay", op: "overlay" },
  { id: "soft-light", name: "Soft light", op: "soft-light" },
  { id: "add", name: "Add", op: "lighter" },
  { id: "darken", name: "Darken", op: "darken" },
  { id: "lighten", name: "Lighten", op: "lighten" },
  { id: "color-dodge", name: "Colour dodge", op: "color-dodge" },
  { id: "color-burn", name: "Colour burn", op: "color-burn" },
  { id: "hard-light", name: "Hard light", op: "hard-light" },
  { id: "difference", name: "Difference", op: "difference" },
  { id: "exclusion", name: "Exclusion", op: "exclusion" },
  { id: "hue", name: "Hue", op: "hue", whole: true },
  { id: "saturation", name: "Saturation", op: "saturation", whole: true },
  { id: "color", name: "Colour", op: "color", whole: true },
  { id: "luminosity", name: "Luminosity", op: "luminosity", whole: true },
];
/** The panel groups them the way every other editor does. */
export const BLEND_GROUPS = [
  ["normal"],
  ["darken", "multiply", "color-burn"],
  ["lighten", "screen", "color-dodge", "add"],
  ["overlay", "soft-light", "hard-light"],
  ["difference", "exclusion"],
  ["hue", "saturation", "color", "luminosity"],
];
export const BLEND_BY_ID = new Map(BLEND_MODES.map((b) => [b.id, b]));
export const blendOp = (id) => (BLEND_BY_ID.get(id) || BLEND_MODES[0]).op;

/* ── blend maths ─────────────────────────────────────────────────────────── */

// The same eight, as functions on one straight-alpha channel in 0..1. The
// canvas does the real compositing; these exist so merge-down, flatten and the
// tests agree with it, and so a future CPU/WebGL path has one definition to
// match. Separable channel blend, per the W3C compositing spec.
export const BLEND_FN = {
  normal: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  add: (b, s) => Math.min(1, b + s),
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  "soft-light": (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  "color-dodge": (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  "color-burn": (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  "hard-light": (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

// The four that look at the whole colour rather than one channel at a time
// (W3C compositing, "non-separable blend modes").
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function clipColour(c) {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return out;
}
const setLum = (c, l) => { const d = l - lum(c); return clipColour([c[0] + d, c[1] + d, c[2] + d]); };
function setSat(c, s) {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [lo, mid, hi] = idx;
  const out = [0, 0, 0];
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]);
    out[hi] = s;
  }
  return out;
}
export const BLEND_WHOLE = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};
for (const k of Object.keys(BLEND_WHOLE)) {
  // one-channel callers get the grey-axis answer
  BLEND_FN[k] = (b, s) => BLEND_WHOLE[k]([b, b, b], [s, s, s])[0];
}

/**
 * One pixel of `src` over `dst`, both straight (non-premultiplied) RGBA 0..1,
 * with a layer opacity. Returns straight RGBA. This is the general formula
 * from the compositing spec — with alpha 1 underneath it reduces to BLEND_FN.
 */
export function blendPixel(dst, src, mode = "normal", opacity = 1) {
  const f = BLEND_FN[mode] || BLEND_FN.normal;
  const whole = BLEND_WHOLE[mode] ? BLEND_WHOLE[mode](dst, src) : null;
  const sa = src[3] * opacity;
  const da = dst[3];
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  const out = [0, 0, 0, oa];
  for (let i = 0; i < 3; i++) {
    // the blended colour only applies where the backdrop is opaque
    const blended = da * (whole ? whole[i] : f(dst[i], src[i])) + (1 - da) * src[i];
    out[i] = (sa * blended + da * dst[i] * (1 - sa)) / oa;
  }
  return out;
}

/* ── layers ──────────────────────────────────────────────────────────────── */

let seq = 0;
/** Short, sortable, readable inside the zip: `l7k3a2`. */
export function layerId() {
  seq = (seq + 1) % 0xffff;
  return "l" + Date.now().toString(36).slice(-5) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0");
}

export const LAYER_DEFAULTS = {
  name: "Layer",
  kind: "raster",
  opacity: 1,
  visible: true,
  locked: false,
  alphaLock: false,
  blend: "normal",
  clip: false, // only shows where the layer under it has paint
  parent: null, // the group this layer is inside
  mask: false, // has a mask bitmap
  maskOn: true, // ...and it is switched on
};

/**
 * What a layer is.
 *   raster  pixels you paint on
 *   adjust  changes the look of everything under it, and has no pixels
 *   group   a folder of layers, blended as one
 *   text    live text; its pixels are redrawn from `text` whenever it changes
 */
export const LAYER_KINDS = ["raster", "adjust", "group", "text"];
export const hasPixels = (l) => !!l && (l.kind === "raster" || l.kind === "text" || !l.kind);
export const MAX_GROUP_DEPTH = 4;

export const TEXT_DEFAULTS = {
  text: "",
  font: "Inter",
  size: 96,
  colour: "#111318",
  align: "left",
  bold: false,
  italic: false,
  lineHeight: 1.2,
  tracking: 0,
  x: 0,
  y: 0,
};
export const TEXT_FONTS = ["Inter", "Georgia", "Times New Roman", "Arial", "Verdana", "Trebuchet MS", "Impact", "Courier New", "JetBrains Mono", "Comic Sans MS", "Segoe Script"];

/** The id a layer's mask travels under, in memory and inside the zip. */
export const maskKey = (id) => id + "-mask";
export const isMaskKey = (key) => /-mask$/.test(String(key));
export const layerOfKey = (key) => String(key).replace(/-mask$/, "");

export function newLayer(over = {}) {
  return { id: layerId(), ...LAYER_DEFAULTS, ...over };
}

/** "Layer 3" — the first number nothing else is already using. */
export function nextLayerName(layers, stem = "Layer") {
  const used = new Set(layers.map((l) => l.name));
  for (let i = layers.length + 1; ; i++) if (!used.has(`${stem} ${i}`)) return `${stem} ${i}`;
}

export function newDoc({ width = 2048, height = 2048, dpi = 144, background = "#ffffff", name = "" } = {}) {
  return {
    format: FORMAT,
    version: VERSION,
    name,
    width: Math.round(width),
    height: Math.round(height),
    dpi: Math.round(dpi) || 72,
    background,
    layers: [newLayer({ name: "Layer 1" })],
    selected: null,
  };
}

export const layerIndex = (doc, id) => doc.layers.findIndex((l) => l.id === id);

/* ── the layer tree ──────────────────────────────────────────────────────── */

// `doc.layers` stays one flat, bottom-first list: a group sits directly ABOVE
// its children, the way a PSD does it, so moving a group is moving one block
// and everything that only understands a flat list keeps working.

/** The flat list as a tree: `[{ layer, children }]`, bottom-first at every level. */
export function layerTree(layers) {
  const ids = new Set(layers.filter((l) => l.kind === "group").map((l) => l.id));
  const kids = new Map();
  const top = [];
  for (const l of layers) {
    const p = l.parent && ids.has(l.parent) && l.parent !== l.id ? l.parent : null;
    if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(l); } else top.push(l);
  }
  const seen = new Set();
  const build = (list, depth) => list.filter((l) => !seen.has(l.id)).map((l) => {
    seen.add(l.id);
    const node = { layer: l, children: [] };
    if (l.kind === "group" && depth < MAX_GROUP_DEPTH) node.children = build(kids.get(l.id) || [], depth + 1);
    return node;
  });
  const tree = build(top, 0);
  // anything a cycle or too deep a nest left behind comes back at the top
  for (const l of layers) if (!seen.has(l.id)) { seen.add(l.id); tree.push({ layer: l, children: [] }); }
  return tree;
}

/** A tree back to the flat list, children first then their group. */
export function flattenTree(tree, parent = null, out = []) {
  for (const n of tree) {
    if (n.layer.kind === "group") flattenTree(n.children, n.layer.id, out);
    if ((n.layer.parent || null) !== parent) n.layer.parent = parent;
    out.push(n.layer);
  }
  return out;
}

/** The flat list with every group's children gathered directly under it. */
export const normalizeLayers = (layers) => flattenTree(layerTree(layers));

/** Every layer inside a group, however deep. */
export function descendants(layers, id) {
  const out = [];
  const walk = (pid, d) => { if (d > 8) return; for (const l of layers) if (l.parent === pid) { out.push(l); if (l.kind === "group") walk(l.id, d + 1); } };
  walk(id, 0);
  return out;
}

export function depthOf(layers, l) {
  let d = 0;
  const byId = new Map(layers.map((x) => [x.id, x]));
  for (let p = l.parent; p && byId.has(p) && d < 8; p = byId.get(p).parent) d++;
  return d;
}

/**
 * Move a layer (a group takes its children) so it lands just above `overId`,
 * below it, or inside it when `into` and `overId` is a group. Returns the new
 * flat list; the layer objects are the same ones, re-parented in place.
 */
export function moveLayerTo(layers, id, overId, { into = false, below = false } = {}) {
  const moving = layers.find((l) => l.id === id);
  const over = layers.find((l) => l.id === overId);
  if (!moving || !over || id === overId) return layers.slice();
  const block = new Set([id, ...descendants(layers, id).map((l) => l.id)]);
  if (block.has(overId)) return layers.slice(); // a group cannot go inside itself
  const parent = into && over.kind === "group" ? over.id : over.parent || null;
  if (moving.kind === "group" && parent) {
    const byId = new Map(layers.map((x) => [x.id, x]));
    let d = 1;
    for (let p = parent; p && byId.has(p) && d < 9; p = byId.get(p).parent) d++;
    if (d >= MAX_GROUP_DEPTH) return layers.slice();
  }
  const rest = layers.filter((l) => !block.has(l.id));
  const moved = layers.filter((l) => block.has(l.id));
  let at;
  if (into && over.kind === "group") {
    at = rest.findIndex((l) => l.id === overId); // just under the group row: the top of its children
  } else if (below) {
    const first = over.kind === "group" ? descendants(rest, overId)[0] : null;
    at = rest.findIndex((l) => l.id === (first ? first.id : overId));
  } else {
    at = rest.findIndex((l) => l.id === overId) + 1;
  }
  moving.parent = parent;
  rest.splice(Math.max(0, at), 0, ...moved);
  return normalizeLayers(rest);
}

/** The layer a clipped layer is clipped to: the nearest unclipped sibling below. */
export function clipBase(layers, id) {
  const i = layers.findIndex((l) => l.id === id);
  if (i < 0) return null;
  const me = layers[i];
  const inside = me.kind === "group" ? new Set(descendants(layers, me.id).map((l) => l.id)) : null;
  for (let j = i - 1; j >= 0; j--) {
    const l = layers[j];
    if (inside && inside.has(l.id)) continue;
    if ((l.parent || null) !== (me.parent || null)) continue;
    if (!l.clip) return l;
  }
  return null;
}

/** True when the document needs nothing version 1 could not say. */
export function isPlain(doc) {
  return doc.layers.every((l) => (!l.kind || l.kind === "raster") && !l.mask && !l.clip && !l.parent && !l.fx);
}
export const layerOf = (doc, id) => doc.layers.find((l) => l.id === id) || null;

/**
 * Move the layer at `from` so it lands at `to`, both in bottom-first indices.
 * Returns a new array; out-of-range indices are clamped rather than throwing,
 * because this runs off drag-and-drop.
 */
export function reorder(layers, from, to) {
  const n = layers.length;
  if (!n) return layers.slice();
  const f = Math.max(0, Math.min(n - 1, from | 0));
  const t = Math.max(0, Math.min(n - 1, to | 0));
  if (f === t) return layers.slice();
  const out = layers.slice();
  out.splice(t, 0, out.splice(f, 1)[0]);
  return out;
}

/** The layer a merge-down would land on, or null at the bottom of the stack. */
export function mergeTarget(doc, id) {
  const i = layerIndex(doc, id);
  if (i <= 0) return null;
  const me = doc.layers[i];
  const under = doc.layers[i - 1];
  // pixels can only land on pixels, and only inside the same group
  if (me.kind && me.kind !== "raster" && me.kind !== "text") return null;
  if (under.kind && under.kind !== "raster") return null;
  if ((under.parent || null) !== (me.parent || null)) return null;
  return under;
}

/** A copy of a layer's settings under a "… copy" name, ready for a new bitmap. */
export function duplicateMeta(layer) {
  return { ...layer, id: layerId(), name: copyName(layer.name) };
}

export function copyName(name) {
  const m = /^(.*) copy(?: (\d+))?$/.exec(name);
  if (!m) return name + " copy";
  return `${m[1]} copy ${m[2] ? Number(m[2]) + 1 : 2}`;
}

/* ── the manifest ────────────────────────────────────────────────────────── */

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

/** `doc.json`, exactly as it is written into the zip. */
export function toManifest(doc, extra = {}) {
  const plain = isPlain(doc);
  return {
    format: FORMAT,
    version: plain ? 1 : VERSION,
    app: extra.app || "Leonote",
    created: extra.created || new Date().toISOString(),
    modified: new Date().toISOString(),
    width: doc.width,
    height: doc.height,
    dpi: doc.dpi,
    background: doc.background || null,
    selected: doc.selected || (doc.layers.length ? doc.layers[doc.layers.length - 1].id : null),
    guides: Array.isArray(doc.guides) && doc.guides.length ? doc.guides : undefined,
    anim: doc.anim ? { fps: doc.anim.fps, cur: doc.anim.cur, onion: doc.anim.onion !== false, minSec: doc.anim.minSec, onionReach: doc.anim.onionReach, onionStrength: doc.anim.onionStrength, pingpong: !!doc.anim.pingpong, size: doc.anim.size, rows: !!doc.anim.rows } : undefined,
    layers: doc.layers.map((l) => {
      const kind = LAYER_KINDS.includes(l.kind) ? l.kind : "raster";
      const out = {
        id: l.id,
        name: l.name,
        file: hasPixels(l) ? `layers/${l.id}.png` : null,
        opacity: Math.round(l.opacity * 1000) / 1000,
        visible: !!l.visible,
        locked: !!l.locked,
        alphaLock: !!l.alphaLock,
        blend: BLEND_BY_ID.has(l.blend) ? l.blend : "normal",
      };
      if (plain) return out;
      out.kind = kind;
      if (l.clip) out.clip = true;
      if (l.parent) out.parent = l.parent;
      if (l.mask) { out.mask = `layers/${maskKey(l.id)}.png`; out.maskOn = l.maskOn !== false; }
      if (kind === "adjust") out.adjust = l.adjust || { type: "brightness" };
      if (kind === "text") out.text = { ...TEXT_DEFAULTS, ...(l.text || {}) };
      if (kind === "group") { out.collapsed = !!l.collapsed; out.passThrough = !!l.passThrough; if (l.frame) out.frame = true; if (l.hold > 1) out.hold = l.hold; }
      if (l.fx) out.fx = l.fx;
      return out;
    }),
  };
}

/**
 * Read a manifest back. Deliberately forgiving about everything except the
 * things that would make the document nonsense (no size, no layers): a file
 * hand-edited in a text editor should still open.
 *
 * Throws only when it cannot produce a usable document.
 */
export function fromManifest(raw) {
  const m = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!m || typeof m !== "object") throw new Error("not a drawing: the manifest is not an object");
  if (m.format && m.format !== FORMAT && m.format !== OLD_FORMAT) throw new Error(`not a Leonote drawing (format "${m.format}")`);
  if (m.version > VERSION) throw new Error(`this drawing was made by a newer Leonote (version ${m.version})`);
  const width = num(m.width, 1, MAX_SIDE, 0);
  const height = num(m.height, 1, MAX_SIDE, 0);
  if (!width || !height) throw new Error("the drawing has no canvas size");
  if (width * height > MAX_PIXELS) throw new Error(`the canvas is larger than ${Math.round(MAX_PIXELS / 1e6)} megapixels`);
  const src = Array.isArray(m.layers) ? m.layers.slice(0, MAX_LAYERS) : [];
  const seen = new Set();
  const layers = [];
  for (const l of src) {
    if (!l || typeof l !== "object") continue;
    let id = typeof l.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(l.id) ? l.id : layerId();
    while (seen.has(id)) id = layerId();
    seen.add(id);
    const kind = LAYER_KINDS.includes(l.kind) ? l.kind : "raster";
    const one = {
      id,
      name: typeof l.name === "string" && l.name ? l.name.slice(0, 120) : `Layer ${layers.length + 1}`,
      kind,
      file: typeof l.file === "string" ? l.file : kind === "raster" || kind === "text" ? `layers/${id}.png` : null,
      opacity: num(l.opacity, 0, 1, 1),
      visible: l.visible !== false,
      locked: !!l.locked,
      alphaLock: !!l.alphaLock,
      blend: BLEND_BY_ID.has(l.blend) ? l.blend : "normal",
      clip: !!l.clip,
      parent: typeof l.parent === "string" ? l.parent : null,
      mask: !!l.mask,
      maskOn: l.maskOn !== false,
    };
    if (kind === "adjust") one.adjust = l.adjust && typeof l.adjust === "object" ? l.adjust : { type: "brightness" };
    if (kind === "text") {
      const t = l.text && typeof l.text === "object" ? l.text : {};
      one.text = {
        ...TEXT_DEFAULTS,
        text: typeof t.text === "string" ? t.text.slice(0, 20000) : "",
        font: typeof t.font === "string" ? t.font.slice(0, 80) : TEXT_DEFAULTS.font,
        size: num(t.size, 4, 2000, TEXT_DEFAULTS.size),
        colour: /^#[0-9a-f]{6}$/i.test(t.colour) ? t.colour : TEXT_DEFAULTS.colour,
        align: ["left", "center", "right"].includes(t.align) ? t.align : "left",
        bold: !!t.bold,
        italic: !!t.italic,
        lineHeight: num(t.lineHeight, 0.5, 4, 1.2),
        tracking: num(t.tracking, -50, 400, 0),
        x: num(t.x, -MAX_SIDE, MAX_SIDE * 2, 0),
        y: num(t.y, -MAX_SIDE, MAX_SIDE * 2, 0),
      };
    }
    if (kind === "group") { one.collapsed = !!l.collapsed; one.passThrough = !!l.passThrough; if (l.frame) one.frame = true; if (l.hold > 1) one.hold = Math.min(12, Math.round(l.hold)); }
    if (l.fx && typeof l.fx === "object") {
      const part = (p, keys) => (p && typeof p === "object" ? Object.fromEntries(Object.entries(p).filter(([k2, v]) => keys.includes(k2) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v))))) : undefined);
      one.fx = { shadow: part(l.fx.shadow, ["on", "color", "opacity", "blur", "dist", "angle"]), stroke: part(l.fx.stroke, ["on", "color", "size", "opacity"]), glow: part(l.fx.glow, ["on", "color", "size", "opacity"]) };
    }
    layers.push(one);
  }
  if (!layers.length) layers.push(newLayer({ name: "Layer 1" }));
  // a parent that is not a group in this file is no parent at all
  const groups = new Set(layers.filter((l) => l.kind === "group").map((l) => l.id));
  for (const l of layers) if (l.parent && !groups.has(l.parent)) l.parent = null;
  const ordered = normalizeLayers(layers);
  layers.length = 0;
  layers.push(...ordered);
  const selected = layers.some((l) => l.id === m.selected) ? m.selected : layers[layers.length - 1].id;
  return {
    format: FORMAT,
    version: VERSION,
    name: typeof m.name === "string" ? m.name : "",
    width, height,
    dpi: num(m.dpi, 1, 2400, 72),
    background: typeof m.background === "string" ? m.background : null,
    created: typeof m.created === "string" ? m.created : null,
    guides: Array.isArray(m.guides) ? m.guides.filter((g) => g && typeof g === "object").slice(0, 40) : [],
    anim: m.anim && typeof m.anim === "object" ? { fps: num(m.anim.fps, 1, 60, 12), cur: Math.round(num(m.anim.cur, 0, 9999, 0)), onion: m.anim.onion !== false, minSec: num(m.anim.minSec, 0, 90, 3), onionReach: Math.round(num(m.anim.onionReach, 1, 3, 1)), onionStrength: num(m.anim.onionStrength, 0.05, 0.9, 0.3), pingpong: !!m.anim.pingpong, size: m.anim.size === "full" ? "full" : "ig", rows: !!m.anim.rows } : null,
    layers,
    selected,
  };
}

/** Every zip entry a saved document should contain, in write order. */
export function entryNames(doc) {
  const out = ["doc.json"];
  for (const l of doc.layers) {
    if (hasPixels(l)) out.push(`layers/${l.id}.png`);
    if (l.mask) out.push(`layers/${maskKey(l.id)}.png`);
  }
  out.push("thumb.png");
  return out;
}

/* ── export ──────────────────────────────────────────────────────────────── */

export const EXPORT_FORMATS = [
  { id: "png", name: "PNG", ext: "png", mime: "image/png", quality: false, note: "lossless, keeps transparency" },
  { id: "jpeg", name: "JPEG", ext: "jpg", mime: "image/jpeg", quality: true, note: "small, no transparency" },
  { id: "webp", name: "WebP", ext: "webp", mime: "image/webp", quality: true, note: "small and modern" },
];
export const EXPORT_BY_ID = new Map(EXPORT_FORMATS.map((f) => [f.id, f]));

export const EXPORT_SCALES = [
  { id: "1", name: "Full size", scale: 1 },
  { id: "0.5", name: "Half", scale: 0.5 },
  { id: "0.25", name: "Quarter", scale: 0.25 },
  { id: "2", name: "Double", scale: 2 },
];

/**
 * Where an export lands: beside the drawing, named after it, with the scale in
 * the name when it is not full size, and a number when something is already
 * there. `taken` is anything that answers `has(path)` (the vault map).
 */
export function exportPath(docPath, { format = "png", scale = 1, taken = null, label = "" } = {}) {
  const f = EXPORT_BY_ID.get(format) || EXPORT_FORMATS[0];
  const slash = docPath.lastIndexOf("/");
  const dir = slash < 0 ? "" : docPath.slice(0, slash);
  const name = docPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  // a template export says what it is for: "Poster - YouTube thumbnail.jpg"
  const tag = String(label || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  const suffix = tag ? ` - ${tag}` : scale === 1 ? "" : scale === 0.5 ? " @half" : scale === 2 ? " @2x" : ` @${scale}x`;
  const at = (n) => (dir ? dir + "/" : "") + n;
  let out = at(`${stem}${suffix}.${f.ext}`);
  if (taken) for (let i = 2; taken.has(out); i++) out = at(`${stem}${suffix} ${i}.${f.ext}`);
  return out;
}

/** The pixel size an export comes out at, clamped to something a canvas can hold. */
export function exportSize(doc, scale = 1) {
  const w = Math.max(1, Math.min(MAX_SIDE, Math.round(doc.width * scale)));
  const h = Math.max(1, Math.min(MAX_SIDE, Math.round(doc.height * scale)));
  return { width: w, height: h };
}

/* ── view maths ──────────────────────────────────────────────────────────── */

export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 32;

/** The zoom that fits the whole canvas in a viewport, with a little margin. */
export function fitZoom(doc, vw, vh, margin = 48) {
  const w = Math.max(1, vw - margin);
  const h = Math.max(1, vh - margin);
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(w / doc.width, h / doc.height)));
}

/** Screen point -> document point, undoing pan, zoom and canvas rotation. */
export function toDocPoint(view, x, y) {
  const dx = x - view.cx;
  const dy = y - view.cy;
  const a = -(view.angle || 0);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const f = view.flip ? -1 : 1; // a mirrored view: the picture is not changed, only how it is shown
  return {
    x: (f * (dx * c - dy * s)) / view.zoom + view.width / 2,
    y: (dx * s + dy * c) / view.zoom + view.height / 2,
  };
}

/** Document point -> screen point. The exact inverse of toDocPoint. */
export function toScreenPoint(view, x, y) {
  const dx = (x - view.width / 2) * view.zoom * (view.flip ? -1 : 1);
  const dy = (y - view.height / 2) * view.zoom;
  const a = view.angle || 0;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: view.cx + dx * c - dy * s, y: view.cy + dx * s + dy * c };
}
