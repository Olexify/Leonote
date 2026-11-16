// Measuring in Sketch: units, drawing scales, and the geometry behind the
// rulers, the measure tool and dimensions. Pure — no DOM, no canvas — so every
// number a professional is going to rely on is pinned by `node --test`.
//
// The one fact everything hangs from is `pxPerUnit`: how many world pixels
// make ONE real-world unit. At 1:1 in millimetres that is 96 / 25.4 (a CSS
// pixel is 1/96 inch). At 1:50 in metres it is 96 / 0.0254 / 50. Calibrating
// from a line of known length simply sets it directly.
//
// The settings live in the drawing itself (`appState.leoMeasure`), so a plan
// drawn at 1:50 is still at 1:50 when it is opened on another machine — and
// Excalidraw, which does not know the key, carries it along untouched.

export const UNITS = [
  { id: "px", name: "Pixels", short: "px", perInch: 96 },
  { id: "mm", name: "Millimetres", short: "mm", perInch: 25.4 },
  { id: "cm", name: "Centimetres", short: "cm", perInch: 2.54 },
  { id: "m", name: "Metres", short: "m", perInch: 0.0254 },
  { id: "in", name: "Inches", short: "in", perInch: 1 },
  { id: "ft", name: "Feet (decimal)", short: "ft", perInch: 1 / 12 },
  { id: "ft-in", name: "Feet and inches", short: "ft", perInch: 1 / 12 },
];
export const UNIT_BY_ID = new Map(UNITS.map((u) => [u.id, u]));

// [on paper, in the world]: 1:50 is one on paper for fifty real
export const SCALES = [
  [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 25], [1, 50], [1, 100], [1, 200], [1, 250], [1, 500], [1, 1000],
  [2, 1], [5, 1], [10, 1],
];
export const scaleLabel = (s) => `${s[0]}:${s[1]}`;

export const DEFAULTS = {
  on: false, // rulers, exact sizes and live readouts ("precision mode")
  unit: "px",
  scale: [1, 1],
  pxPerUnit: 1,
  calibrated: false, // pxPerUnit came from a known length, not from unit × scale
  precision: 1,
  guides: [], // [{ axis: "x" | "y", at: world }]
};

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

/** World pixels per one real unit, for a unit at a drawing scale. */
export function pxPerUnitFor(unit, scale = [1, 1]) {
  const u = UNIT_BY_ID.get(unit) || UNITS[0];
  if (u.id === "px") return 1;
  const s = Array.isArray(scale) && scale[0] > 0 && scale[1] > 0 ? scale[0] / scale[1] : 1;
  return (96 / u.perInch) * s;
}

/** The drawing's measuring settings, with anything odd put right. */
export function measureOf(appState) {
  const raw = appState && appState.leoMeasure && typeof appState.leoMeasure === "object" ? appState.leoMeasure : {};
  const unit = UNIT_BY_ID.has(raw.unit) ? raw.unit : DEFAULTS.unit;
  const scale = Array.isArray(raw.scale) && raw.scale[0] > 0 && raw.scale[1] > 0 ? [Number(raw.scale[0]), Number(raw.scale[1])] : [1, 1];
  const calibrated = !!raw.calibrated && Number(raw.pxPerUnit) > 0;
  return {
    on: !!raw.on,
    unit,
    scale,
    calibrated,
    pxPerUnit: calibrated ? num(raw.pxPerUnit, 1e-9, 1e9, 1) : pxPerUnitFor(unit, scale),
    precision: Math.round(num(raw.precision, 0, 4, unit === "px" ? 0 : unit === "m" || unit === "ft" ? 2 : 1)),
    guides: (Array.isArray(raw.guides) ? raw.guides : []).filter((g) => g && (g.axis === "x" || g.axis === "y") && Number.isFinite(Number(g.at))).slice(0, 200).map((g) => ({ axis: g.axis, at: Number(g.at) })),
  };
}

/** Write settings back. Changing the unit or the scale drops a calibration: it no longer describes them. */
export function setMeasure(appState, patch) {
  const cur = measureOf(appState);
  const next = { ...cur, ...patch };
  if ((patch.unit !== undefined && patch.unit !== cur.unit) || patch.scale !== undefined) {
    if (patch.pxPerUnit === undefined) next.calibrated = false;
  }
  if (!next.calibrated) next.pxPerUnit = pxPerUnitFor(next.unit, next.scale);
  if (patch.unit !== undefined && patch.unit !== cur.unit && patch.precision === undefined) next.precision = measureOf({ leoMeasure: { unit: next.unit } }).precision;
  appState.leoMeasure = {
    on: !!next.on, unit: next.unit, scale: [next.scale[0], next.scale[1]], pxPerUnit: next.pxPerUnit,
    calibrated: !!next.calibrated, precision: next.precision, guides: next.guides.map((g) => ({ axis: g.axis, at: Math.round(g.at * 1000) / 1000 })),
  };
  return measureOf(appState);
}

/** Make a known length true: `px` on the drawing IS `real` units. */
export function calibrate(appState, px, real) {
  if (!(px > 0) || !(real > 0)) return measureOf(appState);
  return setMeasure(appState, { pxPerUnit: px / real, calibrated: true });
}

export const toUnits = (px, cfg) => px / cfg.pxPerUnit;
export const fromUnits = (v, cfg) => v * cfg.pxPerUnit;

/* ── formatting ──────────────────────────────────────────────────────────── */

const trimZeros = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
const fixed = (v, p) => { const s = (Math.round(v * 10 ** p) / 10 ** p).toFixed(p); return s === "-" + (0).toFixed(p) ? (0).toFixed(p) : s; };

/** Feet and inches to the nearest sixteenth: 7' 10 1/2". */
export function feetInches(feet, denom = 16) {
  const sign = feet < 0 ? "-" : "";
  let total = Math.round(Math.abs(feet) * 12 * denom);
  const ft = Math.floor(total / (12 * denom));
  total -= ft * 12 * denom;
  const inch = Math.floor(total / denom);
  let n = total - inch * denom;
  let d = denom;
  while (n && n % 2 === 0) { n /= 2; d /= 2; }
  const frac = n ? `${n}/${d}` : "";
  const inches = inch ? `${inch}${frac ? " " + frac : ""}` : frac || "0";
  if (!ft) return `${sign}${inch || frac ? inches : "0"}"`;
  return `${sign}${ft}'${inch || frac ? " " + inches + '"' : ""}`;
}

export function formatLength(px, cfg, { unit = true } = {}) {
  const v = toUnits(px, cfg);
  if (cfg.unit === "ft-in") return feetInches(v);
  const u = UNIT_BY_ID.get(cfg.unit) || UNITS[0];
  return fixed(v, cfg.precision) + (unit ? " " + u.short : "");
}

export function formatArea(px2, cfg) {
  const v = px2 / (cfg.pxPerUnit * cfg.pxPerUnit);
  const u = UNIT_BY_ID.get(cfg.unit) || UNITS[0];
  // an area wants a digit more than a length, or small rooms all round to the same thing
  return `${fixed(v, Math.min(4, cfg.precision + (cfg.unit === "px" ? 0 : 1)))} ${u.short}²`;
}

export const formatAngle = (rad, precision = 1) => `${trimZeros(fixed((rad * 180) / Math.PI, precision))}°`;

/**
 * What someone typed into a length box, as world pixels. Takes a bare number
 * (in the drawing's unit), a number with any unit ("240 cm" in a drawing set
 * to metres), and feet-and-inches in the forms people write: 7' 10 1/2",
 * 7ft 10.5in, 10 1/2". Returns null when it is not a length.
 */
export function parseLength(text, cfg) {
  const s = String(text == null ? "" : text).trim().toLowerCase().replace(/,/g, ".").replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  if (!s) return null;
  const numRe = "(-?\\d+(?:\\.\\d+)?(?:\\s+\\d+\\s*/\\s*\\d+)?|-?\\d+\\s*/\\s*\\d+)";
  const value = (t) => {
    const m = /^(-?)(\d+(?:\.\d+)?)?(?:\s*(\d+)\s*\/\s*(\d+))?$/.exec(t.trim());
    if (!m || (m[2] === undefined && m[3] === undefined)) return NaN;
    const frac = m[3] !== undefined ? Number(m[3]) / Number(m[4]) : 0;
    return (m[1] ? -1 : 1) * ((m[2] !== undefined ? Number(m[2]) : 0) + frac);
  };
  // feet and inches, either or both
  const fi = new RegExp(`^(?:${numRe}\\s*(?:'|ft|feet|foot))?\\s*(?:${numRe}\\s*(?:"|in|inch|inches))?$`).exec(s);
  if (fi && (fi[1] !== undefined || fi[2] !== undefined) && /['"]|ft|in|feet|foot/.test(s)) {
    const feet = fi[1] !== undefined ? value(fi[1]) : 0;
    const inches = fi[2] !== undefined ? value(fi[2]) : 0;
    if (Number.isNaN(feet) || Number.isNaN(inches)) return null;
    const totalInches = feet * 12 + (feet < 0 ? -inches : inches);
    return lengthInUnit(totalInches, "in", cfg);
  }
  const m = new RegExp(`^${numRe}\\s*(px|mm|cm|m|km)?$`).exec(s);
  if (!m) return null;
  const v = value(m[1]);
  if (Number.isNaN(v)) return null;
  if (!m[2]) return fromUnits(v, cfg);
  if (m[2] === "km") return lengthInUnit(v * 1000, "m", cfg);
  return lengthInUnit(v, m[2], cfg);
}

/** A length given in some other unit, as world pixels in this drawing. */
function lengthInUnit(v, unit, cfg) {
  if (unit === "px") return v;
  const mine = UNIT_BY_ID.get(cfg.unit) || UNITS[0];
  const theirs = UNIT_BY_ID.get(unit);
  if (mine.id === "px") return v * (96 / theirs.perInch); // no scale to speak of: physical size on screen
  // the same real length, said in the drawing's own unit
  return fromUnits(v * (mine.perInch / theirs.perInch), cfg);
}

/* ── rulers ──────────────────────────────────────────────────────────────── */

/**
 * The spacing between labelled ruler ticks, in real units, so labels sit at
 * least `minPx` apart on screen. 1-2-5 for decimal units; for feet and inches
 * the steps a tape measure has.
 */
export function niceStep(cfg, zoom, minPx = 64) {
  const perUnit = cfg.pxPerUnit * zoom; // screen px per unit
  const want = minPx / perUnit; // units
  if (cfg.unit === "ft-in") {
    const steps = [1 / 192, 1 / 96, 1 / 48, 1 / 24, 1 / 12, 1 / 4, 1 / 2, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000];
    return steps.find((s) => s >= want) || steps[steps.length - 1];
  }
  const pow = Math.pow(10, Math.floor(Math.log10(want)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= want - 1e-12) return m * pow;
  return 10 * pow;
}

/** How many small ticks go between two labelled ones. */
export function subdivisions(step, cfg) {
  if (cfg.unit === "ft-in") return step >= 1 ? (step === 1 ? 12 : step === 2 ? 4 : 5) : step === 1 / 2 ? 6 : step === 1 / 4 ? 3 : 4;
  const lead = Math.round(step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9)));
  return lead === 2 ? 4 : lead === 5 ? 5 : 10;
}

/**
 * Ticks for one ruler between two world coordinates:
 * `[{ at: world px, label: string | null, major }]`.
 */
export function rulerTicks(cfg, from, to, zoom, minPx = 64) {
  const step = niceStep(cfg, zoom, minPx);
  const sub = subdivisions(step, cfg);
  const small = step / sub;
  const u0 = Math.floor(toUnits(from, cfg) / small) * small;
  const u1 = toUnits(to, cfg);
  const out = [];
  const count = Math.min(4000, Math.ceil((u1 - u0) / small) + 1);
  const i0 = Math.round(u0 / small);
  for (let i = 0; i < count; i++) {
    const k = i0 + i;
    const v = k * small;
    const major = k % sub === 0;
    out.push({ at: fromUnits(v, cfg), major, label: major ? tickLabel(v, step, cfg) : null });
  }
  return out;
}

function tickLabel(v, step, cfg) {
  if (cfg.unit === "ft-in") return feetInches(v);
  const p = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return fixed(v, p);
}

/* ── geometry ────────────────────────────────────────────────────────────── */

/** A straight measurement between two points. The angle is 0 to the right, anticlockwise positive, the way a drawing board reads. */
export function segment(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let angle = Math.atan2(-dy, dx);
  if (angle < 0) angle += Math.PI * 2;
  return { length: Math.hypot(dx, dy), dx, dy: -dy, angle };
}

/** Length of a path, and the area it encloses when it is closed (shoelace). */
export function pathMetrics(points, closed = false) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  if (!closed || points.length < 3) return { length, area: 0, closed: false };
  const last = points[points.length - 1];
  const open = Math.hypot(last[0] - points[0][0], last[1] - points[0][1]) > 1e-9;
  if (open) length += Math.hypot(last[0] - points[0][0], last[1] - points[0][1]);
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return { length, area: Math.abs(twice) / 2, closed: true };
}

/** The angle at `vertex` between the rays to `a` and `b`, 0..π. */
export function angleAt(a, vertex, b) {
  const ux = a[0] - vertex[0], uy = a[1] - vertex[1];
  const vx = b[0] - vertex[0], vy = b[1] - vertex[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (!lu || !lv) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
}

/** Perimeter of an ellipse (Ramanujan's second approximation: good to parts per million). */
export function ellipsePerimeter(a, b) {
  if (!(a > 0) || !(b > 0)) return 2 * Math.abs(a + b) * 2 > 0 ? 4 * Math.max(a, b) : 0;
  const hh = ((a - b) * (a - b)) / ((a + b) * (a + b));
  return Math.PI * (a + b) * (1 + (3 * hh) / (10 + Math.sqrt(4 - 3 * hh)));
}

/**
 * Area and perimeter of an element, in world pixels, or null when it has
 * none (text, an open line, a picture of unknown content).
 */
export function elementMetrics(el) {
  if (!el) return null;
  const w = Math.abs(el.width || 0);
  const hh = Math.abs(el.height || 0);
  switch (el.type) {
    case "rectangle":
    case "frame":
    case "image":
      return { area: w * hh, perimeter: 2 * (w + hh) };
    case "diamond":
      return { area: (w * hh) / 2, perimeter: 2 * Math.hypot(w, hh) };
    case "ellipse":
      return { area: (Math.PI * w * hh) / 4, perimeter: ellipsePerimeter(w / 2, hh / 2) };
    case "line":
    case "arrow":
    case "freedraw": {
      const pts = el.points || [];
      if (pts.length < 2) return null;
      const first = pts[0];
      const last = pts[pts.length - 1];
      const closed = pts.length > 3 && Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-6;
      const m = pathMetrics(closed ? pts.slice(0, -1) : pts, closed);
      return closed ? { area: m.area, perimeter: m.length } : { area: 0, perimeter: 0, length: m.length };
    }
    default:
      return null;
  }
}

const rot = (x, y, cx, cy, a) => {
  if (!a) return [x, y];
  const c = Math.cos(a), s = Math.sin(a);
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
};

/**
 * The points on an element a measurement should be able to land on exactly:
 * corners, the middles of its sides, its centre, and every vertex of a line.
 */
export function keyPoints(el) {
  if (!el || el.isDeleted) return [];
  const a = el.angle || 0;
  const pts = el.points;
  if (Array.isArray(pts) && (el.type === "line" || el.type === "arrow")) {
    // a line's angle turns it about the middle of its own box
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const cx = el.x + (x0 + x1) / 2;
    const cy = el.y + (y0 + y1) / 2;
    const out = pts.map((p, i) => { const [x, y] = rot(el.x + p[0], el.y + p[1], cx, cy, a); return { x, y, kind: i === 0 || i === pts.length - 1 ? "end" : "vertex" }; });
    for (let i = 1; i < pts.length; i++) {
      for (const [f, kind] of [[0.5, "midpoint"], [0.25, "quarter"], [0.75, "quarter"]]) {
        const [x, y] = rot(el.x + pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, el.y + pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f, cx, cy, a);
        out.push({ x, y, kind });
      }
    }
    return out;
  }
  if (el.type === "freedraw" || el.type === "text") return [];
  const w = el.width || 0;
  const hh = el.height || 0;
  const cx = el.x + w / 2;
  const cy = el.y + hh / 2;
  const at = (u, v, kind) => { const [x, y] = rot(el.x + u * w, el.y + v * hh, cx, cy, a); return { x, y, kind }; };
  const mids = [at(0.5, 0, "midpoint"), at(1, 0.5, "midpoint"), at(0.5, 1, "midpoint"), at(0, 0.5, "midpoint")];
  if (el.type === "ellipse") return [...mids.map((p) => ({ ...p, kind: "quadrant" })), at(0.5, 0.5, "centre")];
  if (el.type === "diamond") return [...mids.map((p) => ({ ...p, kind: "corner" })), at(0.5, 0.5, "centre")];
  // and the quarters of each side, between a corner and its midpoint
  const quarters = [];
  for (const f of [0.25, 0.75]) quarters.push(at(f, 0, "quarter"), at(f, 1, "quarter"), at(0, f, "quarter"), at(1, f, "quarter"));
  return [at(0, 0, "corner"), at(1, 0, "corner"), at(1, 1, "corner"), at(0, 1, "corner"), ...mids, at(0.5, 0.5, "centre"), ...quarters];
}

/** The nearest of some candidate points within `threshold`, or null. Corners and ends win ties over midpoints. */
export function snapPoint(x, y, candidates, threshold) {
  const rank = { corner: 0, end: 0, vertex: 0, centre: 1, quadrant: 1, midpoint: 2, guide: 3, grid: 4 };
  let best = null;
  let bd = threshold;
  for (const c of candidates) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d > threshold) continue;
    if (!best || d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && (rank[c.kind] ?? 9) < (rank[best.kind] ?? 9))) { best = c; bd = d; }
  }
  return best;
}

/** What a dimension line says: the length of the path it runs along. */
export function dimensionText(points, cfg) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return formatLength(len, cfg);
}

/** A round length for a scale bar that comes out near `targetPx` wide: { units, px, label }. */
export function scaleBar(cfg, zoom, targetPx = 140) {
  const step = niceStep(cfg, zoom, targetPx * 0.8);
  return { units: step, px: fromUnits(step, cfg), label: formatLength(fromUnits(step, cfg), { ...cfg, precision: Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9))) }) };
}
