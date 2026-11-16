// Studio's adjustments: what each one does to a colour, as numbers.
//
// Every adjustment boils down to a short list of STAGES, and there are only
// two kinds of stage:
//
//   lut     three 256-entry tables, one per channel (curves, levels, exposure,
//           brightness, posterise, threshold, invert, gradient map)
//   matrix  a 4 × 5 colour matrix (saturation, hue, white balance, black and
//           white, photo filter)
//
// That is deliberate. Both map one-to-one onto SVG filter primitives
// (`feComponentTransfer` with a table, `feColorMatrix`), which the canvas runs
// on the GPU: an adjustment layer over a 4000 × 4000 document costs a few
// milliseconds and never reads a pixel back. And both are trivial to run on
// the CPU, which is what `applyStages` does — for the histogram, for the tests
// and as the definition the GPU path has to agree with.
//
// Pure: no DOM, no canvas. `filterMarkup` only builds a string.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampB = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

/* ── the catalogue ───────────────────────────────────────────────────────── */

const LEVELS_ONE = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
const CURVE_ONE = [[0, 0], [255, 255]];

export const ADJUSTMENTS = [
  { id: "brightness", name: "Brightness / Contrast", short: "Brightness", icon: "sun", defaults: { brightness: 0, contrast: 0 } },
  { id: "exposure", name: "Exposure", icon: "aperture", defaults: { exposure: 0, offset: 0, gamma: 1 } },
  { id: "levels", name: "Levels", icon: "levels", defaults: { rgb: { ...LEVELS_ONE }, r: { ...LEVELS_ONE }, g: { ...LEVELS_ONE }, b: { ...LEVELS_ONE } } },
  { id: "curves", name: "Curves", icon: "curve", defaults: { rgb: CURVE_ONE, r: CURVE_ONE, g: CURVE_ONE, b: CURVE_ONE } },
  { id: "hsl", name: "Hue / Saturation", short: "Hue / Sat", icon: "palette", defaults: { hue: 0, saturation: 0, lightness: 0 } },
  { id: "vibrance", name: "Vibrance", icon: "palette", defaults: { vibrance: 0 } },
  { id: "temperature", name: "White balance", icon: "thermo", defaults: { temperature: 0, tint: 0 } },
  { id: "balance", name: "Colour balance", short: "Colour bal.", icon: "balance", defaults: { shadows: [0, 0, 0], mids: [0, 0, 0], highlights: [0, 0, 0] } },
  { id: "bw", name: "Black & white", icon: "contrast", defaults: { r: 30, g: 59, b: 11, tint: "#c8a27a", tintAmount: 0 } },
  { id: "photofilter", name: "Photo filter", icon: "filter", defaults: { colour: "#ec8a00", density: 25 } },
  { id: "gradientmap", name: "Gradient map", icon: "gradient", defaults: { stops: [{ at: 0, colour: "#0b1026" }, { at: 0.5, colour: "#c2255c" }, { at: 1, colour: "#ffe8a3" }] } },
  { id: "invert", name: "Invert", icon: "invert", defaults: {} },
  { id: "posterize", name: "Posterise", icon: "steps", defaults: { levels: 4 } },
  { id: "threshold", name: "Threshold", icon: "contrast", defaults: { level: 128 } },
];
export const ADJUST_BY_ID = new Map(ADJUSTMENTS.map((a) => [a.id, a]));

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A fresh adjustment of a type, every parameter at "changes nothing". */
export function newAdjust(type) {
  const a = ADJUST_BY_ID.get(type) || ADJUSTMENTS[0];
  return { type: a.id, ...clone(a.defaults) };
}

/** Whatever came out of a file, made safe to run. Unknown types become a no-op. */
export function cleanAdjust(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const def = ADJUST_BY_ID.get(a.type);
  if (!def) return { type: "brightness", brightness: 0, contrast: 0 };
  const out = { type: def.id, ...clone(def.defaults) };
  for (const k of Object.keys(def.defaults)) if (a[k] !== undefined) out[k] = clone(a[k]);
  return out;
}

/** True when the adjustment is still at its defaults, so it can be skipped. */
export function isIdentity(adj) {
  const def = ADJUST_BY_ID.get(adj && adj.type);
  if (!def) return true;
  if (adj.type === "invert" || adj.type === "posterize" || adj.type === "threshold" || adj.type === "gradientmap") return false;
  if (adj.type === "bw") return false;
  if (adj.type === "photofilter") return !(adj.density > 0);
  return Object.keys(def.defaults).every((k) => JSON.stringify(adj[k]) === JSON.stringify(def.defaults[k]));
}

/* ── curves ──────────────────────────────────────────────────────────────── */

/**
 * A 256-entry table through control points, by monotone cubic interpolation
 * (Fritsch–Carlson): smooth like a spline, but it never overshoots between
 * two points, so a curve cannot produce a tone that is not between its
 * neighbours. Points are `[x, y]` in 0..255.
 */
export function curveTable(points) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [clampB(p[0]), clampB(p[1])])
    .sort((a, b) => a[0] - b[0]);
  // two points at the same x would divide by zero; the later one wins
  const xs = [];
  const ys = [];
  for (const [x, y] of pts) {
    if (xs.length && x - xs[xs.length - 1] < 1e-6) ys[ys.length - 1] = y;
    else { xs.push(x); ys.push(y); }
  }
  const out = new Uint8Array(256);
  if (!xs.length) { for (let i = 0; i < 256; i++) out[i] = i; return out; }
  if (xs.length === 1) { out.fill(Math.round(ys[0])); return out; }
  const n = xs.length;
  const d = new Array(n - 1);
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let k = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { out[x] = Math.round(ys[0]); continue; }
    if (x >= xs[n - 1]) { out[x] = Math.round(ys[n - 1]); continue; }
    while (k < n - 2 && x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k];
    const t = (x - xs[k]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    out[x] = Math.round(clampB(y));
  }
  return out;
}

/** One levels block as a table. */
export function levelsTable(l) {
  const inB = num(l && l.inBlack, 0, 254, 0);
  const inW = Math.max(inB + 1, num(l && l.inWhite, 1, 255, 255));
  const g = num(l && l.gamma, 0.1, 9.99, 1);
  const oB = num(l && l.outBlack, 0, 255, 0);
  const oW = num(l && l.outWhite, 0, 255, 255);
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const t = clamp01((i - inB) / (inW - inB));
    out[i] = Math.round(clampB(oB + Math.pow(t, 1 / g) * (oW - oB)));
  }
  return out;
}

const tableFrom = (fn) => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = Math.round(clampB(fn(i / 255) * 255)); return t; };
/** `second[first[i]]`: run one table, then another. */
export const chainTables = (first, second) => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = second[first[i]]; return t; };

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function parseHex(hex) {
  const s = String(hex || "#000").replace("#", "");
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s.slice(0, 6).padEnd(6, "0");
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ── matrices ────────────────────────────────────────────────────────────── */

// Row-major 4 × 5, the shape feColorMatrix takes: each output channel is
// r·m0 + g·m1 + b·m2 + a·m3 + m4, with colours and the offset in 0..1.
const LR = 0.2126, LG = 0.7152, LB = 0.0722;

export const identityMatrix = () => [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

export function saturationMatrix(s) {
  return [
    LR + (1 - LR) * s, LG - LG * s, LB - LB * s, 0, 0,
    LR - LR * s, LG + (1 - LG) * s, LB - LB * s, 0, 0,
    LR - LR * s, LG - LG * s, LB + (1 - LB) * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

export function hueMatrix(deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    LR + c * (1 - LR) + s * -LR, LG + c * -LG + s * -LG, LB + c * -LB + s * (1 - LB), 0, 0,
    LR + c * -LR + s * 0.143, LG + c * (1 - LG) + s * 0.14, LB + c * -LB + s * -0.283, 0, 0,
    LR + c * -LR + s * -(1 - LR), LG + c * -LG + s * LG, LB + c * (1 - LB) + s * LB, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** `b` after `a`, as one matrix. */
export function mulMatrix(a, b) {
  const out = new Array(20).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += b[r * 5 + k] * a[k * 5 + c];
      if (c === 4) v += b[r * 5 + 4];
      out[r * 5 + c] = v;
    }
  }
  return out;
}

/* ── stages ──────────────────────────────────────────────────────────────── */

const lut = (r, g = r, b = r) => ({ kind: "lut", r, g, b });
const matrix = (m) => ({ kind: "matrix", m });

/** A table that maps every value to itself is no stage at all: the renderer skips the layer. */
const isRest = (t) => { for (let i = 0; i < 256; i++) if (t[i] !== i) return false; return true; };
const restOrLut = (st) => (isRest(st.r) && isRest(st.g) && isRest(st.b) ? [] : [st]);

/** The stages an adjustment runs, in order. An adjustment at rest gives []. */
export function stagesOf(adjRaw) {
  const adj = cleanAdjust(adjRaw);
  switch (adj.type) {
    case "brightness": {
      const b = num(adj.brightness, -100, 100, 0) / 100;
      const c = num(adj.contrast, -100, 100, 0) * 1.28;
      if (!b && !c) return [];
      const f = (259 * (c + 255)) / (255 * (259 - c));
      return [lut(tableFrom((v) => f * (v + b * 0.5 - 0.5) + 0.5))];
    }
    case "exposure": {
      const ev = num(adj.exposure, -5, 5, 0);
      const off = num(adj.offset, -0.5, 0.5, 0);
      const g = num(adj.gamma, 0.1, 9.99, 1);
      if (!ev && !off && g === 1) return [];
      const k = Math.pow(2, ev);
      return [lut(tableFrom((v) => toSrgb(Math.pow(clamp01(toLinear(v) * k + off), 1 / g))))];
    }
    case "levels": {
      const m = levelsTable(adj.rgb);
      return restOrLut(lut(chainTables(levelsTable(adj.r), m), chainTables(levelsTable(adj.g), m), chainTables(levelsTable(adj.b), m)));
    }
    case "curves": {
      const m = curveTable(adj.rgb);
      return restOrLut(lut(chainTables(curveTable(adj.r), m), chainTables(curveTable(adj.g), m), chainTables(curveTable(adj.b), m)));
    }
    case "hsl": {
      const hue = num(adj.hue, -180, 180, 0);
      const s = num(adj.saturation, -100, 100, 0) / 100;
      const l = num(adj.lightness, -100, 100, 0) / 100;
      if (!hue && !s && !l) return [];
      // saturation: -100 is grey, +100 is twice as strong
      let m = saturationMatrix(s < 0 ? 1 + s : 1 + s * 1.5);
      if (hue) m = mulMatrix(hueMatrix(hue), m);
      const out = [matrix(m)];
      // lightness the way the old dialog does it: towards white, or towards black
      if (l) out.push(lut(tableFrom((v) => (l > 0 ? v + (1 - v) * l : v * (1 + l)))));
      return out;
    }
    case "vibrance": {
      // A saturation lift that is gentler than Saturation: a matrix cannot see
      // how saturated a pixel already is, so this is the honest linear half of
      // vibrance — half the strength, and it never goes to grey.
      const v = num(adj.vibrance, -100, 100, 0) / 100;
      if (!v) return [];
      return [matrix(saturationMatrix(1 + v * 0.6))];
    }
    case "temperature": {
      const t = num(adj.temperature, -100, 100, 0) / 100;
      const ti = num(adj.tint, -100, 100, 0) / 100;
      if (!t && !ti) return [];
      let r = 1 + 0.3 * t + 0.1 * ti;
      let g = 1 - 0.2 * ti;
      let b = 1 - 0.3 * t + 0.1 * ti;
      // keep the picture as bright as it was: only the colour should move
      const k = 1 / (LR * r + LG * g + LB * b);
      r *= k; g *= k; b *= k;
      return [matrix([r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0])];
    }
    case "balance": {
      const sh = adj.shadows || [0, 0, 0];
      const mi = adj.mids || [0, 0, 0];
      const hi = adj.highlights || [0, 0, 0];
      if (![...sh, ...mi, ...hi].some((v) => Number(v))) return [];
      const one = (c) => tableFrom((v) => {
        const ws = Math.pow(1 - v, 2);
        const wh = v * v;
        const wm = 1 - ws - wh;
        return v + 0.4 * ((num(sh[c], -100, 100, 0) / 100) * ws + (num(mi[c], -100, 100, 0) / 100) * wm + (num(hi[c], -100, 100, 0) / 100) * wh);
      });
      return [lut(one(0), one(1), one(2))];
    }
    case "bw": {
      const r = num(adj.r, -200, 300, 30) / 100;
      const g = num(adj.g, -200, 300, 59) / 100;
      const b = num(adj.b, -200, 300, 11) / 100;
      let m = [r, g, b, 0, 0, r, g, b, 0, 0, r, g, b, 0, 0, 0, 0, 0, 1, 0];
      const amt = num(adj.tintAmount, 0, 100, 0) / 100;
      if (amt > 0) {
        const [tr, tg, tb] = parseHex(adj.tint).map((v) => v / 255);
        const l = Math.max(0.05, LR * tr + LG * tg + LB * tb);
        const gain = (c) => 1 - amt + (amt * c) / l;
        m = mulMatrix(m, [gain(tr), 0, 0, 0, 0, 0, gain(tg), 0, 0, 0, 0, 0, gain(tb), 0, 0, 0, 0, 0, 1, 0]);
      }
      return [matrix(m)];
    }
    case "photofilter": {
      const d = num(adj.density, 0, 100, 25) / 100;
      if (!d) return [];
      const [r, g, b] = parseHex(adj.colour).map((v) => v / 255);
      let gr = 1 - d + d * r;
      let gg = 1 - d + d * g;
      let gb = 1 - d + d * b;
      const k = 1 / Math.max(0.2, LR * gr + LG * gg + LB * gb); // "preserve luminosity"
      gr *= k; gg *= k; gb *= k;
      return [matrix([gr, 0, 0, 0, 0, 0, gg, 0, 0, 0, 0, 0, gb, 0, 0, 0, 0, 0, 1, 0])];
    }
    case "gradientmap": {
      const stops = (Array.isArray(adj.stops) ? adj.stops : [])
        .filter((s) => s && Number.isFinite(Number(s.at)))
        .map((s) => ({ at: clamp01(Number(s.at)), rgb: parseHex(s.colour) }))
        .sort((a, b) => a.at - b.at);
      if (stops.length < 2) return [];
      const at = (v, c) => {
        if (v <= stops[0].at) return stops[0].rgb[c] / 255;
        for (let i = 1; i < stops.length; i++) {
          if (v <= stops[i].at) {
            const a = stops[i - 1];
            const b = stops[i];
            const t = b.at === a.at ? 1 : (v - a.at) / (b.at - a.at);
            return (a.rgb[c] + (b.rgb[c] - a.rgb[c]) * t) / 255;
          }
        }
        return stops[stops.length - 1].rgb[c] / 255;
      };
      return [matrix(saturationMatrix(0)), lut(tableFrom((v) => at(v, 0)), tableFrom((v) => at(v, 1)), tableFrom((v) => at(v, 2)))];
    }
    case "invert":
      return [lut(tableFrom((v) => 1 - v))];
    case "posterize": {
      const n = Math.round(num(adj.levels, 2, 64, 4));
      return [lut(tableFrom((v) => Math.min(n - 1, Math.floor(v * n)) / (n - 1)))];
    }
    case "threshold": {
      const lv = num(adj.level, 1, 255, 128);
      return [matrix(saturationMatrix(0)), lut(tableFrom((v) => (v * 255 >= lv ? 1 : 0)))];
    }
    default:
      return [];
  }
}

/* ── the CPU path ────────────────────────────────────────────────────────── */

/** Run stages over straight RGBA bytes, in place. Alpha is never touched. */
export function applyStages(stages, data) {
  for (const st of stages) {
    if (st.kind === "lut") {
      const { r, g, b } = st;
      for (let p = 0; p < data.length; p += 4) { data[p] = r[data[p]]; data[p + 1] = g[data[p + 1]]; data[p + 2] = b[data[p + 2]]; }
    } else {
      const m = st.m;
      for (let p = 0; p < data.length; p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        data[p] = clampB(Math.round(r * m[0] + g * m[1] + b * m[2] + 255 * m[4]));
        data[p + 1] = clampB(Math.round(r * m[5] + g * m[6] + b * m[7] + 255 * m[9]));
        data[p + 2] = clampB(Math.round(r * m[10] + g * m[11] + b * m[12] + 255 * m[14]));
      }
    }
  }
  return data;
}

export const applyAdjust = (adj, data) => applyStages(stagesOf(adj), data);

/* ── the GPU path ────────────────────────────────────────────────────────── */

const f4 = (v) => (Math.round(v * 10000) / 10000).toString();
const tableValues = (t) => { let s = ""; for (let i = 0; i < 256; i++) s += (i ? " " : "") + f4(t[i] / 255); return s; };

/**
 * The inside of an SVG `<filter>` that runs these stages. sRGB throughout:
 * the default for SVG filters is linear light, which is not what a curves
 * dialog means by "128".
 */
export function filterMarkup(stages) {
  let out = "";
  for (const st of stages) {
    if (st.kind === "lut") {
      out += `<feComponentTransfer><feFuncR type="table" tableValues="${tableValues(st.r)}"/><feFuncG type="table" tableValues="${tableValues(st.g)}"/><feFuncB type="table" tableValues="${tableValues(st.b)}"/></feComponentTransfer>`;
    } else {
      out += `<feColorMatrix type="matrix" values="${st.m.map(f4).join(" ")}"/>`;
    }
  }
  return out;
}

/** A short, stable key for a set of parameters, for caching built filters. */
export function adjustKey(adj) {
  const s = JSON.stringify(cleanAdjust(adj));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* ── pixel filters (the destructive kind) ────────────────────────────────── */

// These change a layer's own pixels and look at a pixel's neighbours, so they
// cannot be adjustment layers — they are in the Filter menu instead.
export const FILTERS = [
  { id: "blur", name: "Gaussian blur", defaults: { radius: 8 }, params: [["radius", "Radius", 0, 200, 0.5, "px"]] },
  { id: "sharpen", name: "Sharpen (unsharp mask)", defaults: { amount: 80, radius: 2 }, params: [["amount", "Amount", 0, 300, 1, "%"], ["radius", "Radius", 0.3, 20, 0.1, "px"]] },
  { id: "clarity", name: "Clarity", defaults: { amount: 40 }, params: [["amount", "Amount", -100, 100, 1, "%"]] },
  { id: "noise", name: "Add grain", defaults: { amount: 12, mono: 1 }, params: [["amount", "Amount", 0, 100, 1, "%"], ["mono", "Monochrome", 0, 1, 1, ""]] },
  { id: "pixelate", name: "Pixelate", defaults: { size: 12 }, params: [["size", "Block size", 2, 200, 1, "px"]] },
  { id: "vignette", name: "Vignette", defaults: { amount: 45, size: 60 }, params: [["amount", "Amount", -100, 100, 1, "%"], ["size", "Size", 10, 100, 1, "%"]] },
  { id: "glow", name: "Soft glow", defaults: { amount: 40, radius: 18 }, params: [["amount", "Amount", 0, 100, 1, "%"], ["radius", "Radius", 1, 120, 1, "px"]] },
];
export const FILTER_BY_ID = new Map(FILTERS.map((f) => [f.id, f]));

/** Unsharp mask as SVG: the picture, plus `amount` of what a blur took away. */
export function sharpenMarkup(amount, radius) {
  const a = Math.max(0, amount) / 100;
  return `<feGaussianBlur stdDeviation="${f4(Math.max(0.1, radius))}" result="soft"/><feComposite in="SourceGraphic" in2="soft" operator="arithmetic" k1="0" k2="${f4(1 + a)}" k3="${f4(-a)}" k4="0"/>`;
}

/* ── histogram and the automatic fixes ───────────────────────────────────── */

export function histogram(data, step = 1) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  let n = 0;
  for (let p = 0; p < data.length; p += 4 * step) {
    if (data[p + 3] < 8) continue; // transparent pixels have no tone
    r[data[p]]++; g[data[p + 1]]++; b[data[p + 2]]++;
    l[Math.round(LR * data[p] + LG * data[p + 1] + LB * data[p + 2])]++;
    n++;
  }
  return { r, g, b, l, count: n };
}

/** Where a channel's tones really start and stop, ignoring `clip` of each end. */
export function tonalRange(hist, count, clip = 0.002) {
  const cut = count * clip;
  let lo = 0, hi = 255, acc = 0;
  for (lo = 0; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
  acc = 0;
  for (hi = 255; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
  if (hi <= lo) return { lo: 0, hi: 255 };
  return { lo, hi };
}

/** Auto contrast: one levels adjustment that stretches the tones to fill the range. */
export function autoLevels(h, { perChannel = false } = {}) {
  const adj = newAdjust("levels");
  if (!h.count) return adj;
  if (perChannel) {
    for (const c of ["r", "g", "b"]) { const t = tonalRange(h[c], h.count); adj[c].inBlack = t.lo; adj[c].inWhite = t.hi; }
  } else {
    const t = tonalRange(h.l, h.count);
    adj.rgb.inBlack = t.lo;
    adj.rgb.inWhite = t.hi;
  }
  return adj;
}
