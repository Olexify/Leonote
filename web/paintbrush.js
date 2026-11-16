// Draw mode's brush engine — the maths half. Pure: no DOM, no canvas, so the
// pressure curves, spacing and tip masks all run under `node --test`.
//
// A raster brush is a *stamp* smeared along the stroke: a soft round tip laid
// down every `spacing` × diameter pixels, each stamp taking its size, opacity
// and offset from pressure, tilt, speed and a seeded jitter. That is how
// Procreate, Clip Studio and Photoshop all do it, and it is why a raster brush
// feels different from Sketch's vector outline (sketchbrush.js) — which stays
// exactly as it was, and which this file reuses rather than re-derives:
// `curvePressure` and `rng` come from there.

import { curvePressure, rng } from "./sketchbrush.js";

export { curvePressure, rng };

/* ── parameters ──────────────────────────────────────────────────────────── */

// size      diameter in document pixels at full pressure
// opacity   how dark a finished stroke gets (0..1)
// flow      how much each individual stamp lays down (0..1); low flow with
//           high opacity is what makes pencils and airbrushes build up
// hardness  0 = a soft cloud, 1 = a crisp disc
// spacing   distance between stamps, as a fraction of the diameter
// smoothing the stabiliser: 0 = raw pointer, 1 = a long, lazy leash
// jitter    random size/position wobble per stamp (0..1)
// scatter   how far stamps stray from the centre line, × diameter
// tip       "round" | "soft" | "chalk" | "spray" | "bristle" | "square" | "nib" (a flat pen held at 45°)
//           | "hatch" (parallel strokes) | "sponge" (open blotches) | "weave" (canvas grain) | "stipple" (dots)
// pressure  which inputs pressure drives: { size, opacity, flow }
// tilt      how much pen tilt widens and fades the stamp (0..1)
// blend     "normal" | "multiply" | "erase"
// curve     pressure response, shared with Sketch: linear/soft/firm/light
export const BASE = {
  size: 24,
  opacity: 1,
  flow: 1,
  hardness: 0.8,
  spacing: 0.08,
  smoothing: 0.4,
  jitter: 0,
  scatter: 0,
  angleJitter: 0,
  tip: "round",
  pressureSize: 1,
  pressureOpacity: 0,
  pressureFlow: 0,
  tilt: 0,
  blend: "normal",
  curve: "linear",
  wet: 0,
};

export const FAMILIES = [
  { id: "sketch", name: "Sketching" },
  { id: "ink", name: "Inking" },
  { id: "paint", name: "Painting" },
  { id: "air", name: "Airbrush" },
  { id: "texture", name: "Texture" },
  { id: "eraser", name: "Erasers" },
  { id: "custom", name: "Mine" },
];

const P = (id, family, name, o) => ({ id, family, name, ...o });

export const PRESETS = [
  P("pencil", "sketch", "Pencil", { size: 8, hardness: 0.55, opacity: 0.9, flow: 0.55, spacing: 0.06, tip: "chalk", jitter: 0.2, pressureSize: 0.7, pressureFlow: 0.8, curve: "light", smoothing: 0.3 }),
  P("pencil-soft", "sketch", "Soft pencil", { size: 14, hardness: 0.35, opacity: 0.8, flow: 0.35, spacing: 0.05, tip: "chalk", jitter: 0.3, pressureSize: 0.6, pressureFlow: 0.9, curve: "soft", smoothing: 0.3 }),
  P("hatching", "sketch", "Hatching", { size: 30, hardness: 0.8, opacity: 0.85, flow: 0.6, spacing: 0.3, tip: "hatch", pressureSize: 0.4, pressureFlow: 0.6, smoothing: 0.4 }),
  P("graphite", "sketch", "Graphite block", { size: 40, hardness: 0.45, opacity: 0.75, flow: 0.28, spacing: 0.05, tip: "chalk", jitter: 0.35, pressureSize: 0.3, pressureFlow: 1, curve: "soft" }),
  P("pencil-mech", "sketch", "Mechanical", { size: 3, hardness: 0.9, opacity: 0.95, flow: 0.9, spacing: 0.05, tip: "round", pressureSize: 0.25, pressureFlow: 0.5, smoothing: 0.45 }),
  P("charcoal", "sketch", "Charcoal", { size: 34, hardness: 0.3, opacity: 0.95, flow: 0.3, spacing: 0.05, tip: "chalk", jitter: 0.5, scatter: 0.12, pressureSize: 0.5, pressureFlow: 0.9, curve: "soft" }),

  P("nib", "ink", "Calligraphy nib", { size: 18, hardness: 0.95, opacity: 1, flow: 1, spacing: 0.02, tip: "nib", pressureSize: 0.5, curve: "firm", smoothing: 0.55 }),
  P("tech-pen", "ink", "Technical pen", { size: 3, hardness: 1, opacity: 1, flow: 1, spacing: 0.03, tip: "round", pressureSize: 0, smoothing: 0.7 }),
  P("dry-ink", "ink", "Dry ink", { size: 16, hardness: 0.8, opacity: 1, flow: 0.8, spacing: 0.04, tip: "chalk", jitter: 0.15, pressureSize: 0.8, curve: "firm", smoothing: 0.5 }),
  P("felt", "ink", "Felt tip", { size: 12, hardness: 0.75, opacity: 0.9, flow: 0.9, spacing: 0.04, tip: "round", blend: "multiply", pressureSize: 0.25, smoothing: 0.5 }),
  P("inker", "ink", "Inker", { size: 10, hardness: 1, opacity: 1, flow: 1, spacing: 0.03, tip: "round", pressureSize: 0.9, curve: "firm", smoothing: 0.6 }),
  P("ink-fine", "ink", "Fineliner", { size: 4, hardness: 1, opacity: 1, flow: 1, spacing: 0.03, tip: "round", pressureSize: 0.2, smoothing: 0.62 }),
  P("ink-brush", "ink", "Brush pen", { size: 26, hardness: 0.92, opacity: 1, flow: 1, spacing: 0.03, tip: "round", pressureSize: 1, curve: "soft", smoothing: 0.55 }),
  P("marker", "ink", "Marker", { size: 30, hardness: 0.85, opacity: 0.7, flow: 1, spacing: 0.04, tip: "square", blend: "multiply", pressureSize: 0.15, smoothing: 0.5 }),

  P("round", "paint", "Round brush", { size: 40, hardness: 0.7, opacity: 1, flow: 0.9, spacing: 0.06, tip: "round", pressureSize: 0.8, pressureFlow: 0.4, curve: "soft", smoothing: 0.4 }),
  P("flat", "paint", "Flat brush", { size: 56, hardness: 0.8, opacity: 1, flow: 0.85, spacing: 0.05, tip: "square", angleJitter: 0.05, pressureSize: 0.6, smoothing: 0.4 }),
  P("oil", "paint", "Oil", { size: 48, hardness: 0.6, opacity: 1, flow: 0.7, spacing: 0.04, tip: "bristle", jitter: 0.25, pressureSize: 0.7, pressureFlow: 0.5, smoothing: 0.35 }),
  P("watercolour", "paint", "Watercolour", { size: 70, hardness: 0.12, opacity: 0.45, flow: 0.12, spacing: 0.05, tip: "soft", blend: "multiply", jitter: 0.2, pressureSize: 0.5, pressureFlow: 0.8, curve: "soft", wet: 0.5, smoothing: 0.5 }),
  P("acrylic", "paint", "Acrylic", { size: 42, hardness: 0.85, opacity: 1, flow: 0.95, spacing: 0.04, tip: "bristle", jitter: 0.12, pressureSize: 0.6, pressureFlow: 0.3, smoothing: 0.4 }),
  P("wet-round", "paint", "Wet round", { size: 50, hardness: 0.4, opacity: 0.8, flow: 0.35, spacing: 0.04, tip: "soft", wet: 0.75, pressureSize: 0.6, pressureFlow: 0.7, curve: "soft", smoothing: 0.45 }),
  P("sumi", "paint", "Sumi-e", { size: 36, hardness: 0.55, opacity: 0.95, flow: 0.6, spacing: 0.03, tip: "bristle", wet: 0.35, jitter: 0.1, pressureSize: 1, pressureFlow: 0.6, curve: "soft", smoothing: 0.5 }),
  P("impasto", "paint", "Impasto", { size: 52, hardness: 0.9, opacity: 1, flow: 1, spacing: 0.06, tip: "square", jitter: 0.1, angleJitter: 0.15, scatter: 0.02, pressureSize: 0.5, smoothing: 0.35 }),
  P("gouache", "paint", "Gouache", { size: 44, hardness: 0.75, opacity: 0.95, flow: 0.8, spacing: 0.05, tip: "bristle", jitter: 0.18, pressureSize: 0.55, smoothing: 0.4 }),

  P("airbrush", "air", "Airbrush", { size: 90, hardness: 0.02, opacity: 0.8, flow: 0.06, spacing: 0.02, tip: "soft", pressureFlow: 1, pressureSize: 0.2, curve: "soft", smoothing: 0.55 }),
  P("airbrush-hard", "air", "Hard airbrush", { size: 46, hardness: 0.22, opacity: 0.9, flow: 0.14, spacing: 0.02, tip: "soft", pressureFlow: 0.9, pressureSize: 0.3, smoothing: 0.5 }),
  P("stipple", "air", "Stipple", { size: 60, hardness: 0.9, opacity: 1, flow: 0.9, spacing: 0.35, tip: "stipple", jitter: 0.3, scatter: 0.15, pressureFlow: 0.5 }),
  P("spray", "air", "Spray can", { size: 70, hardness: 0.5, opacity: 0.85, flow: 0.3, spacing: 0.06, tip: "spray", scatter: 0.3, jitter: 0.4, pressureFlow: 0.6, smoothing: 0.45 }),

  P("crayon", "texture", "Crayon", { size: 22, hardness: 0.7, opacity: 1, flow: 0.55, spacing: 0.04, tip: "chalk", jitter: 0.2, scatter: 0.04, pressureSize: 0.35, pressureFlow: 0.7, smoothing: 0.35 }),
  P("pastel", "texture", "Soft pastel", { size: 46, hardness: 0.3, opacity: 0.9, flow: 0.3, spacing: 0.05, tip: "chalk", jitter: 0.35, scatter: 0.1, pressureSize: 0.4, pressureFlow: 0.9, curve: "soft" }),
  P("sponge", "texture", "Sponge", { size: 70, hardness: 0.5, opacity: 0.9, flow: 0.45, spacing: 0.22, tip: "sponge", angleJitter: 1, jitter: 0.3, scatter: 0.05, pressureFlow: 0.6 }),
  P("weave", "texture", "Canvas grain", { size: 64, hardness: 0.55, opacity: 0.85, flow: 0.35, spacing: 0.06, tip: "weave", pressureFlow: 0.8, curve: "soft" }),
  P("splatter", "texture", "Splatter", { size: 90, hardness: 0.8, opacity: 1, flow: 0.8, spacing: 0.45, tip: "stipple", scatter: 0.6, jitter: 0.8, angleJitter: 1, pressureSize: 0.4 }),
  P("chalk", "texture", "Chalk", { size: 40, hardness: 0.45, opacity: 0.95, flow: 0.4, spacing: 0.05, tip: "chalk", jitter: 0.45, scatter: 0.08, pressureSize: 0.4, pressureFlow: 0.8 }),
  P("grain", "texture", "Grain", { size: 50, hardness: 0.6, opacity: 0.9, flow: 0.3, spacing: 0.05, tip: "spray", jitter: 0.6, scatter: 0.18, pressureFlow: 0.8 }),
  P("bristle", "texture", "Dry bristle", { size: 60, hardness: 0.55, opacity: 1, flow: 0.4, spacing: 0.04, tip: "bristle", jitter: 0.4, pressureFlow: 0.7 }),

  P("eraser", "eraser", "Eraser", { size: 40, hardness: 0.9, opacity: 1, flow: 1, spacing: 0.04, tip: "round", blend: "erase", pressureSize: 0.4 }),
  P("eraser-soft", "eraser", "Soft eraser", { size: 70, hardness: 0.1, opacity: 1, flow: 0.25, spacing: 0.03, tip: "soft", blend: "erase", pressureFlow: 1, curve: "soft" }),
  P("eraser-grain", "eraser", "Grainy eraser", { size: 50, hardness: 0.5, opacity: 1, flow: 0.4, spacing: 0.05, tip: "chalk", jitter: 0.3, blend: "erase", pressureFlow: 0.9 }),
  P("eraser-hard", "eraser", "Hard eraser", { size: 24, hardness: 1, opacity: 1, flow: 1, spacing: 0.03, tip: "round", blend: "erase", pressureSize: 0 }),
];

export const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
export const DEFAULT_PRESET = "round";
export const PARAM_KEYS = Object.keys(BASE);

/** The full parameter set for a preset id plus overrides. */
export function resolve(id, over = null) {
  const preset = PRESET_BY_ID.get(id);
  const out = { ...BASE, ...(preset || {}), id: id || "custom" };
  if (over) for (const k of PARAM_KEYS) if (over[k] !== undefined) out[k] = over[k];
  return out;
}

/** Only what differs from the preset, so saved settings stay small and legible. */
export function diff(b) {
  const preset = PRESET_BY_ID.get(b.id) || BASE;
  const out = { id: b.id };
  for (const k of PARAM_KEYS) {
    const base = preset[k] !== undefined ? preset[k] : BASE[k];
    if (b[k] !== base) out[k] = b[k];
  }
  return out;
}

/** A user's own brush, saved in settings: a preset id plus its changed params. */
export function customPreset(b, name) {
  return { ...diff(b), id: "custom:" + Math.random().toString(36).slice(2, 8), from: b.id, family: "custom", name };
}

/* ── the per-stamp maths ─────────────────────────────────────────────────── */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Diameter of one stamp, in document pixels.
 * `pressureSize` decides how much of the range pressure owns: at 1 a feather
 * touch is a hairline, at 0 the brush is a constant width.
 */
export function sizeAt(b, pressure, tilt = 0) {
  const p = curvePressure(clamp01(pressure), b.curve);
  const k = 1 - b.pressureSize + b.pressureSize * p;
  // a pen laid flat spreads out, like the side of a pencil lead
  const spread = 1 + b.tilt * tilt * 1.6;
  return Math.max(0.5, b.size * k * spread);
}

/** How much one stamp lays down, before the tip mask fades its edges. */
export function flowAt(b, pressure, tilt = 0) {
  const p = curvePressure(clamp01(pressure), b.curve);
  const k = 1 - b.pressureFlow + b.pressureFlow * p;
  const lean = 1 - b.tilt * tilt * 0.5; // a flat pen is fainter as well as wider
  return clamp01(b.flow * k * lean);
}

/** The alpha a completed stroke reaches, for the stroke buffer's own opacity. */
export function opacityAt(b, pressure) {
  const p = curvePressure(clamp01(pressure), b.curve);
  return clamp01(b.opacity * (1 - b.pressureOpacity + b.pressureOpacity * p));
}

/** Distance between stamps in document pixels — never less than a third of a pixel. */
export const stepFor = (b, diameter) => Math.max(0.33, diameter * Math.max(0.01, b.spacing));

/**
 * Pressure from speed, for a mouse or a trackpad. Fast is light, slow is
 * heavy — and eased hard, because raw speed flickers and a flickering brush
 * looks broken. `state` carries the smoothed value between calls.
 */
export function simulatedPressure(state, dist, dt) {
  const speed = dist / Math.max(1, dt); // px per ms
  const want = clamp01(1 - speed / 2.6);
  state.p = state.p === undefined ? 0.55 : state.p + (want - state.p) * 0.18;
  return 0.35 + state.p * 0.55;
}

/**
 * The stabiliser. The brush follows the pointer on a spring: `smoothing` is
 * how much slack the leash has. 0 is the raw pointer, 1 lags a long way
 * behind and draws very clean curves.
 *
 * Returns the new anchor. Mutating `state` in place keeps the hot path free of
 * allocations — this runs on every pointermove.
 */
export function stabilise(state, x, y, smoothing) {
  if (state.x === undefined) { state.x = x; state.y = y; return state; }
  // 0.02 rather than 0 at full smoothing, so the brush always arrives
  const t = Math.max(0.02, 1 - smoothing * 0.97);
  state.x += (x - state.x) * t;
  state.y += (y - state.y) * t;
  return state;
}

/**
 * Walk a segment laying stamps down every `step` pixels, carrying the leftover
 * distance into the next segment so spacing never restarts mid-stroke.
 *
 * `emit(x, y, t)` is called per stamp; `t` is 0..1 along the segment, for
 * interpolating pressure. Returns the new leftover.
 *
 * No allocation: the caller owns everything.
 */
export function walkSegment(x0, y0, x1, y1, step, carry, emit) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return carry;
  const ux = dx / len;
  const uy = dy / len;
  let d = step - carry;
  while (d <= len) {
    emit(x0 + ux * d, y0 + uy * d, d / len);
    d += step;
  }
  return len - (d - step);
}

/** Per-stamp wobble. Deterministic for a seed, so a stroke redraws identically. */
export function jitterStamp(b, rand, diameter, out) {
  out.dx = 0; out.dy = 0; out.scale = 1; out.angle = 0;
  if (b.jitter) out.scale = 1 - b.jitter * 0.5 * rand();
  if (b.scatter) {
    const a = rand() * Math.PI * 2;
    const r = rand() * b.scatter * diameter;
    out.dx = Math.cos(a) * r;
    out.dy = Math.sin(a) * r;
  }
  if (b.angleJitter) out.angle = (rand() - 0.5) * b.angleJitter * Math.PI * 2;
  return out;
}

/* ── tip masks ───────────────────────────────────────────────────────────── */

/**
 * The alpha profile across a tip, from the centre (r = 0) to the rim (r = 1).
 * `hardness` is where the falloff starts: 1 is a flat disc with a one-pixel
 * edge, 0 is a gaussian-ish cloud with no edge at all.
 */
export function tipFalloff(r, hardness) {
  if (r >= 1) return 0;
  const h = clamp01(hardness);
  const inner = h * h; // squared, so the slider's middle still feels soft
  if (r <= inner) return 1;
  const t = (r - inner) / (1 - inner || 1);
  // smoothstep out, then squared again: no hard ring at the edge of a soft tip
  const s = 1 - t * t * (3 - 2 * t);
  return s * s;
}

/**
 * A tip as an alpha map, `size` × `size`, values 0..255. Built once per brush
 * size and cached by the renderer — never in the per-stamp path.
 *
 * `tip`: round (plain falloff), soft (the same, but the falloff does the work),
 * square (a rounded rectangle), chalk (falloff × coarse noise),
 * spray (sparse dots), bristle (radial streaks).
 */
export function tipMask(tip, size, hardness, seed = 1) {
  const n = Math.max(2, Math.round(size));
  const out = new Uint8ClampedArray(n * n);
  const c = (n - 1) / 2;
  const rand = rng(seed);
  // pre-roll the noise so the same tip is the same every time
  const noise = tip === "chalk" || tip === "spray" || tip === "stipple" ? new Float32Array(n * n) : null;
  // the sponge: a few soft blobs in the disc, the same every time
  const blobs = tip === "sponge" ? Array.from({ length: 9 }, () => ({ x: rand() * 1.6 - 0.8, y: rand() * 1.6 - 0.8, r: 0.18 + rand() * 0.3 })) : null;
  if (noise) for (let i = 0; i < noise.length; i++) noise[i] = rand();
  const streaks = tip === "bristle" ? Array.from({ length: 14 }, () => ({ a: rand() * Math.PI * 2, w: 0.04 + rand() * 0.1, g: 0.4 + rand() * 0.6 })) : null;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x - c) / (c || 1);
      const dy = (y - c) / (c || 1);
      let a;
      if (tip === "square") {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        a = tipFalloff(Math.min(1, m * 1.02), Math.max(hardness, 0.5));
      } else if (tip === "nib") {
        // a flat nib at 45°: thick one way, a hair the other - calligraphy's thick and thin
        const u = (dx + dy) * Math.SQRT1_2, v = (dx - dy) * Math.SQRT1_2;
        a = tipFalloff(Math.sqrt(u * u + (v / 0.22) * (v / 0.22)), Math.max(hardness, 0.6));
      } else {
        a = tipFalloff(Math.sqrt(dx * dx + dy * dy), hardness);
      }
      if (a > 0) {
        const i = y * n + x;
        if (tip === "chalk") a *= 0.35 + noise[i] * 0.85;
        else if (tip === "spray") a *= noise[i] > 0.72 ? 1 : noise[i] * 0.22;
        else if (tip === "stipple") a *= noise[i] > 0.9 ? 1 : 0;
        else if (tip === "hatch") { const t = ((dx - dy) * 3.2 + 8) % 1; a *= t < 0.32 ? 1 : 0.06; }
        else if (tip === "weave") { const gx = Math.abs(Math.sin(dx * 9.5)), gy = Math.abs(Math.sin(dy * 9.5)); a *= 0.45 + 0.55 * Math.max(gx, gy) * (0.8 + (((x * 7 + y * 13) % 5) / 25)); }
        else if (tip === "sponge") { let k = 0.08; for (const s of blobs) { const d = Math.hypot(dx - s.x, dy - s.y) / s.r; if (d < 1) k = Math.max(k, 1 - d * d); } a *= k; }
        else if (tip === "bristle") {
          let k = 0.25;
          const ang = Math.atan2(dy, dx);
          for (const s of streaks) {
            let d = Math.abs(((ang - s.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            if (d < s.w) k = Math.max(k, s.g * (1 - d / s.w));
          }
          a *= k;
        }
      }
      out[y * n + x] = Math.round(Math.min(1, a) * 255);
    }
  }
  return out;
}

/** The size a cached tip is rasterised at: powers of two, so there are few of them. */
export function tipCacheSize(diameter) {
  const d = Math.max(4, Math.min(1024, diameter));
  return 1 << Math.ceil(Math.log2(d));
}

/* ── the bucket fill ─────────────────────────────────────────────────────── */

/**
 * Scanline flood fill over RGBA pixels. Returns a Uint8 mask (255 inside) and
 * the bounding box of what it touched, so the caller only repaints that.
 *
 * `tolerance` is 0..1 over the largest channel difference, alpha included, so
 * filling into transparency behaves the way people expect.
 *
 * Iterative and scanline-based: a 4000×4000 fill is ~16 M pixels and a
 * per-pixel recursive fill would blow the stack long before that.
 */
export function floodFill(data, width, height, sx, sy, tolerance = 0.15) {
  const mask = new Uint8Array(width * height);
  const box = { x0: width, y0: height, x1: -1, y1: -1, count: 0 };
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return { mask, box };
  const si = (sy * width + sx) * 4;
  const sr = data[si], sg = data[si + 1], sb = data[si + 2], sa = data[si + 3];
  const tol = tolerance * 255;
  const match = (i) => {
    const d = Math.max(
      Math.abs(data[i] - sr), Math.abs(data[i + 1] - sg),
      Math.abs(data[i + 2] - sb), Math.abs(data[i + 3] - sa));
    return d <= tol;
  };
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    if (mask[y * width + x]) continue;
    // run left, then right, filling the whole scanline at once
    while (x > 0 && !mask[y * width + x - 1] && match(((y * width) + x - 1) * 4)) x--;
    let spanUp = false;
    let spanDown = false;
    for (; x < width; x++) {
      const p = y * width + x;
      if (mask[p] || !match(p * 4)) break;
      mask[p] = 255;
      box.count++;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      if (y > 0) {
        const up = !mask[p - width] && match((p - width) * 4);
        if (up && !spanUp) { stack.push(x, y - 1); spanUp = true; }
        else if (!up) spanUp = false;
      }
      if (y < height - 1) {
        const dn = !mask[p + width] && match((p + width) * 4);
        if (dn && !spanDown) { stack.push(x, y + 1); spanDown = true; }
        else if (!dn) spanDown = false;
      }
    }
  }
  if (box.x1 < 0) return { mask, box: { x0: 0, y0: 0, x1: -1, y1: -1, count: 0 } };
  return { mask, box };
}

/** Grow a fill mask by `n` pixels, so an anti-aliased edge has no light halo. */
export function growMask(mask, width, height, n = 1) {
  let cur = mask;
  for (let pass = 0; pass < n; pass++) {
    const next = cur.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < width - 1 && cur[i + 1]) ||
            (y > 0 && cur[i - width]) || (y < height - 1 && cur[i + width])) next[i] = 255;
      }
    }
    cur = next;
  }
  return cur;
}
