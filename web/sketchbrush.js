// Sketch brushes: presets for the pen tool and the outlines they draw. Pure
// (no DOM), so the geometry runs under node --test.
//
// A stroke keeps its look through `customData.brush` ({ id, ...params }).
// Excalidraw ignores customData and draws a plain freehand line, so files
// still open there. "pen" with no params is Excalidraw's own pen, exactly: its freehand settings follow
// Excalidraw (MIT, Copyright (c) 2020 Excalidraw - see THIRD-PARTY-NOTICES.md).

import { getStroke } from "perfect-freehand";

export const FAMILIES = [
  { id: "pencil", name: "Pencils" },
  { id: "pen", name: "Pens" },
  { id: "marker", name: "Markers" },
  { id: "brush", name: "Brushes" },
  { id: "highlighter", name: "Highlighters", short: "Highlight" },
  { id: "chalk", name: "Chalk" },
  { id: "custom", name: "Mine" },
];

// size: diameter per unit of stroke width. thinning: how much pressure
// narrows it. taper: px at each end. grain: 0..1 texture strength.
// angle: a flat nib (degrees) with `nib` as its thinnest share.
// layers: soft stacked outlines [scale, alpha]. curve: pressure response.
export const BASE = {
  size: 4.25, thinning: 0.6, smoothing: 0.5, streamline: 0.5, taperStart: 0, taperEnd: 0, cap: true,
  opacity: 1, texture: "none", grain: 0, angle: null, nib: 0.15, layers: null, curve: "linear", blend: "normal", color: null,
};

const P = (id, family, name, o) => ({ id, family, name, ...o });
export const PRESETS = [
  P("pencil-hb", "pencil", "HB sketch", { size: 2.1, thinning: 0.3, smoothing: 0.55, streamline: 0.42, texture: "grain", grain: 0.5, opacity: 0.88, curve: "light" }),
  P("pencil-2b", "pencil", "2B soft", { size: 2.9, thinning: 0.42, smoothing: 0.6, streamline: 0.42, texture: "grain", grain: 0.38, opacity: 0.92, curve: "light" }),
  P("pencil-6b", "pencil", "6B dark", { size: 4, thinning: 0.5, smoothing: 0.6, streamline: 0.4, texture: "grain", grain: 0.26, curve: "soft" }),
  P("pencil-color", "pencil", "Coloured pencil", { size: 3.2, thinning: 0.28, smoothing: 0.55, streamline: 0.45, texture: "grain", grain: 0.55, opacity: 0.85, curve: "light" }),
  P("pencil-mech", "pencil", "Mechanical fine", { size: 1.35, thinning: 0.12, smoothing: 0.6, streamline: 0.55, texture: "grain", grain: 0.22, opacity: 0.9 }),
  P("pen", "pen", "Sketch pen", {}),
  P("pen-fineliner", "pen", "Fineliner", { size: 2.4, thinning: 0.05, smoothing: 0.62, streamline: 0.6 }),
  P("pen-ballpoint", "pen", "Ballpoint", { size: 2.6, thinning: 0.28, smoothing: 0.55, streamline: 0.5, texture: "grain", grain: 0.12, curve: "firm" }),
  P("pen-gel", "pen", "Gel pen", { size: 3.6, thinning: 0.15, smoothing: 0.7, streamline: 0.55, opacity: 0.96 }),
  P("pen-fountain", "pen", "Fountain", { size: 5, angle: 40, nib: 0.16, smoothing: 0.6, streamline: 0.55, taperEnd: 10 }),
  P("pen-technical", "pen", "Technical", { size: 2, thinning: 0, smoothing: 0.5, streamline: 0.7 }),
  P("marker-felt", "marker", "Felt tip", { size: 5, thinning: 0.1, smoothing: 0.6, streamline: 0.6, opacity: 0.9 }),
  P("marker-chisel", "marker", "Chisel", { size: 8, angle: 30, nib: 0.32, smoothing: 0.6, streamline: 0.6, opacity: 0.88 }),
  P("marker-brush", "marker", "Brush marker", { size: 6, thinning: 0.55, smoothing: 0.6, streamline: 0.55, taperStart: 20, taperEnd: 30, opacity: 0.95 }),
  P("marker-fat", "marker", "Fat marker", { size: 11, thinning: 0, smoothing: 0.65, streamline: 0.6, opacity: 0.85 }),
  P("marker-neon", "marker", "Neon", { size: 4.5, thinning: 0, smoothing: 0.65, streamline: 0.6, layers: [[3, 0.12], [1.8, 0.25], [1, 1]], color: "#12b886" }),
  P("brush-round", "brush", "Round ink", { size: 6, thinning: 0.8, smoothing: 0.55, streamline: 0.45, taperStart: 25, taperEnd: 45, curve: "soft" }),
  P("brush-sumi", "brush", "Sumi", { size: 9, angle: -35, nib: 0.08, smoothing: 0.6, streamline: 0.5, taperStart: 8, taperEnd: 30 }),
  P("brush-dry", "brush", "Dry brush", { size: 9, thinning: 0.4, smoothing: 0.6, streamline: 0.5, texture: "bristle", grain: 0.6, taperEnd: 20 }),
  P("brush-wash", "brush", "Watercolour", { size: 12, thinning: 0.3, smoothing: 0.7, streamline: 0.6, layers: [[1.18, 0.12], [1, 0.16], [0.72, 0.2]] }),
  P("brush-air", "brush", "Airbrush", { size: 14, thinning: 0, smoothing: 0.7, streamline: 0.65, layers: [[1.6, 0.05], [1.3, 0.07], [1, 0.09], [0.7, 0.12], [0.4, 0.18]], texture: "spray", grain: 0.5 }),
  P("hl-yellow", "highlighter", "Yellow", { size: 10, thinning: 0, cap: true, smoothing: 0.6, streamline: 0.65, opacity: 0.5, blend: "multiply", color: "#ffd43b" }),
  P("hl-pink", "highlighter", "Pink", { size: 10, thinning: 0, cap: true, smoothing: 0.6, streamline: 0.65, opacity: 0.45, blend: "multiply", color: "#f783ac" }),
  P("hl-green", "highlighter", "Green", { size: 10, thinning: 0, cap: true, smoothing: 0.6, streamline: 0.65, opacity: 0.45, blend: "multiply", color: "#69db7c" }),
  P("hl-pastel", "highlighter", "Pastel", { size: 12, thinning: 0, cap: true, smoothing: 0.6, streamline: 0.65, opacity: 0.4, blend: "multiply", color: "#b197fc" }),
  P("chalk-stick", "chalk", "Chalk", { size: 5, thinning: 0.15, smoothing: 0.5, streamline: 0.45, texture: "chalk", grain: 0.62, opacity: 0.95 }),
  P("chalk-crayon", "chalk", "Wax crayon", { size: 6, thinning: 0.1, smoothing: 0.5, streamline: 0.45, texture: "chalk", grain: 0.45 }),
  P("chalk-pastel", "chalk", "Oil pastel", { size: 8, thinning: 0.05, smoothing: 0.55, streamline: 0.5, texture: "chalk", grain: 0.32, opacity: 0.92 }),
];
export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

const PARAM_KEYS = Object.keys(BASE);

/** Everything a stroke needs to be drawn, from customData.brush (string or object). */
const resolved = new WeakMap();
export function brushOf(el) {
  const raw = el && el.customData ? el.customData.brush : null;
  if (!raw) return null;
  if (typeof raw === "object") {
    const hit = resolved.get(raw);
    if (hit) return hit;
  }
  const id = typeof raw === "string" ? raw : raw.id;
  const preset = PRESET_BY_ID.get(id);
  const out = { ...BASE, ...(preset || {}), id: id || "custom" };
  if (typeof raw === "object") for (const k of PARAM_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
  if (typeof raw === "object") resolved.set(raw, out);
  return out;
}

/** The plain Excalidraw pen: nothing custom to draw. */
export const isPlain = (b) => !b || (b.id === "pen" && b.size === BASE.size && b.thinning === BASE.thinning && !b.layers && b.texture === "none" && b.angle == null && !b.taperStart && !b.taperEnd && b.smoothing === BASE.smoothing && b.streamline === BASE.streamline && b.curve === "linear");

/** What goes into customData.brush: the id plus only what differs from the preset. */
export function brushData(b) {
  const preset = PRESET_BY_ID.get(b.id) || BASE;
  const out = { id: b.id };
  for (const k of PARAM_KEYS) {
    if (k === "color") continue;
    const base = preset[k] !== undefined ? preset[k] : BASE[k];
    if (JSON.stringify(b[k]) !== JSON.stringify(base)) out[k] = b[k];
  }
  return out;
}

export function curvePressure(p, curve) {
  if (curve === "soft") return Math.sqrt(p);
  if (curve === "firm") return p * p;
  if (curve === "light") return 0.25 + p * 0.5;
  return p;
}

const easeSin = (t) => Math.sin((t * Math.PI) / 2);

/** perfect-freehand outline for a brush, as [[x, y], ...]. */
export function brushOutline(points, pressures, simulate, width, b, scale = 1, last = true) {
  const n = points.length;
  const input = new Array(n || 1);
  if (!n) input[0] = [0, 0, 0.5];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const pr = simulate ? 0.5 : curvePressure(pressures[i] ?? 0.5, b.curve);
    input[i] = [p[0], p[1], pr];
  }
  if (b.angle != null) return nibOutline(input, simulate, width * b.size * scale, b);
  return getStroke(input, {
    simulatePressure: simulate,
    size: width * b.size * scale,
    thinning: b.thinning,
    smoothing: b.smoothing,
    streamline: b.streamline,
    easing: easeSin,
    start: { cap: b.cap, taper: b.taperStart || 0 },
    end: { cap: b.cap, taper: b.taperEnd || 0 },
    last,
  });
}

// streamlined centre line, like perfect-freehand's input filter
export function smoothLine(input, streamline) {
  const out = [];
  const t = 0.15 + (1 - streamline) * 0.85;
  let px = input[0][0];
  let py = input[0][1];
  for (let i = 0; i < input.length; i++) {
    const p = input[i];
    px += (p[0] - px) * t;
    py += (p[1] - py) * t;
    const last = out[out.length - 1];
    if (!last || Math.abs(px - last[0]) + Math.abs(py - last[1]) > 0.3 || i === input.length - 1) out.push([px, py, p[2] ?? 0.5]);
  }
  if (input.length > 1) {
    const e = input[input.length - 1];
    out.push([e[0], e[1], e[2] ?? 0.5]);
  }
  return out;
}

/**
 * A flat nib held at a fixed angle: wide across the nib, thin along it.
 * The ribbon never collapses to nothing: a hairline across the direction of
 * travel keeps `nib` of the width.
 */
export function nibOutline(input, simulate, size, b) {
  const pts = smoothLine(input, b.streamline);
  const n = pts.length;
  if (n < 2) {
    const p = pts[0] || [0, 0];
    const r = size / 2;
    return [[p[0] - r, p[1] - r * 0.3], [p[0] + r, p[1] + r * 0.3], [p[0] + r * 0.9, p[1] + r * 0.5], [p[0] - r * 0.9, p[1] - r * 0.1]];
  }
  const a = (b.angle * Math.PI) / 180;
  const vx = Math.cos(a);
  const vy = Math.sin(a);
  // total length, for tapers
  const run = new Float64Array(n);
  for (let i = 1; i < n; i++) run[i] = run[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const total = run[n - 1] || 1;
  const left = [];
  const right = [];
  let prevSpeed = 0;
  for (let i = 0; i < n; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(n - 1, i + 1)];
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    let pr = pts[i][2];
    if (simulate) {
      // faster is thinner, eased so it never flickers
      const sp = Math.min(1, (i ? run[i] - run[i - 1] : 0) / 14);
      prevSpeed += (sp - prevSpeed) * 0.3;
      pr = 0.75 - prevSpeed * 0.35;
    }
    let half = (size / 2) * (0.55 + 0.45 * pr);
    if (b.taperStart && run[i] < b.taperStart) half *= 0.25 + 0.75 * easeSin(run[i] / b.taperStart);
    if (b.taperEnd && total - run[i] < b.taperEnd) half *= 0.1 + 0.9 * easeSin((total - run[i]) / b.taperEnd);
    // across the travel direction, on the nib's side
    let qx = -dy;
    let qy = dx;
    if (qx * -vy + qy * vx < 0) { qx = -qx; qy = -qy; }
    const ox = vx * half + qx * half * b.nib;
    const oy = vy * half + qy * half * b.nib;
    left.push([pts[i][0] + ox, pts[i][1] + oy]);
    right.push([pts[i][0] - ox, pts[i][1] - oy]);
  }
  right.reverse();
  return left.concat(right);
}

/** Outline as SVG path data, with quadratic smoothing through the outline points. */
export function outlineToPath(outline, smooth = true) {
  const len = outline.length;
  if (!len) return "";
  const r2 = (v) => Math.round(v * 100) / 100;
  if (!smooth) {
    let d = `M ${r2(outline[0][0])} ${r2(outline[0][1])}`;
    for (let i = 1; i < len; i++) d += ` L ${r2(outline[i][0])} ${r2(outline[i][1])}`;
    return d + " Z";
  }
  let d = `M ${r2(outline[0][0])} ${r2(outline[0][1])} Q`;
  const max = len - 1;
  for (let i = 0; i < len; i++) {
    const p = outline[i];
    const q = i === max ? outline[0] : outline[i + 1];
    d += ` ${r2(p[0])} ${r2(p[1])} ${r2((p[0] + q[0]) / 2)} ${r2((p[1] + q[1]) / 2)}`;
  }
  return d + ` L ${r2(outline[0][0])} ${r2(outline[0][1])} Z`;
}

// a tiny seeded generator so textures never jitter between frames
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Dry-brush bristles: thin broken lines alongside the centre line.
 * Returns [{ d, width, dash }] in local coordinates.
 */
export function bristles(points, width, b, seed) {
  const pts = smoothLine(points.map((p) => [p[0], p[1], 0.5]), b.streamline);
  const n = pts.length;
  if (n < 2) return [];
  const w = width * b.size;
  const rand = rng(seed);
  const count = Math.max(4, Math.min(11, Math.round(w / 1.6)));
  const out = [];
  for (let k = 0; k < count; k++) {
    const off = (k / (count - 1) - 0.5) * w * 0.9 + (rand() - 0.5) * w * 0.08;
    const edge = Math.abs(k / (count - 1) - 0.5) * 2;
    let d = "";
    for (let i = 0; i < n; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[Math.min(n - 1, i + 1)];
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy) || 1;
      const x = pts[i][0] - (dy / len) * off;
      const y = pts[i][1] + (dx / len) * off;
      d += (i ? "L" : "M") + Math.round(x * 10) / 10 + " " + Math.round(y * 10) / 10;
    }
    // the middle stays loaded with paint, the edges run dry
    const gap = (3 + rand() * 16) * (0.15 + edge * 1.1) * b.grain;
    const dash = gap > 0.8 ? [14 + rand() * 46 * (1.2 - edge), gap] : null;
    out.push({ d, width: Math.max(0.6, (w / count) * (0.8 + rand() * 0.6)), dash, offset: rand() * 60, alpha: 0.55 + rand() * 0.4 * (1 - edge * 0.6) });
  }
  return out;
}

/** Airbrush speckles: dotted lines spread around the centre. */
export function speckles(points, width, b, seed) {
  const pts = smoothLine(points.map((p) => [p[0], p[1], 0.5]), b.streamline);
  if (pts.length < 2) return [];
  const w = width * b.size;
  const rand = rng(seed ^ 0x5bd1e995);
  const out = [];
  for (let k = 0; k < 6; k++) {
    const off = (rand() - 0.5) * w * 1.5;
    let d = "";
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[Math.min(pts.length - 1, i + 1)];
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy) || 1;
      d += (i ? "L" : "M") + Math.round((pts[i][0] - (dy / len) * off) * 10) / 10 + " " + Math.round((pts[i][1] + (dx / len) * off) * 10) / 10;
    }
    out.push({ d, width: 0.8 + rand() * 1.2, dash: [0.01, 3 + rand() * 7 / Math.max(0.2, b.grain)], alpha: 0.25 + rand() * 0.3 });
  }
  return out;
}
