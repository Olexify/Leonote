// Portions of this file are ported from Excalidraw (https://github.com/excalidraw/excalidraw):
//   Copyright (c) 2020 Excalidraw
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
//   associated documentation files (the "Software"), to deal in the Software without restriction,
//   including without limitation the rights to use, copy, modify, merge, publish, distribute,
//   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions: The above copyright notice and this
//   permission notice shall be included in all copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
//   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
//   OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
//   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// The rest of the file is Leonote's own (see LICENSE).

// Sketch rendering: Excalidraw elements onto a canvas 2D context, or into an
// SVG string. Shapes come from rough.js with the element's seed, so they look
// exactly like excalidraw.com and never jitter; each element's drawable is
// built once per version and reused as Path2D objects.
//
// Colours are never baked into the cache: parts carry a role (stroke,
// background, canvas) and take their colour at draw time, so switching the
// theme costs nothing.

import rough from "roughjs/bundled/rough.esm.js";
import { getStroke } from "perfect-freehand";
import * as M from "./sketchmodel.js";
import * as B from "./sketchbrush.js";

const gen = rough.generator();

export const FONT_STACKS = {
  hand: '"Virgil", "Excalifont", "Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", cursive',
  sans: '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif',
  mono: '"Cascadia Code", "Cascadia Mono", "JetBrains Mono Variable", Consolas, monospace',
};

export function fontStack(family) {
  if (family === M.FONT_NORMAL || family === 6 || family === 7 || family === 9) return FONT_STACKS.sans;
  if (family === M.FONT_CODE) return FONT_STACKS.mono;
  if (family === 8) return FONT_STACKS.mono;
  return FONT_STACKS.hand;
}

export const fontString = (el) => `${el.fontSize}px ${fontStack(el.fontFamily)}`;

let measureCtx = null;
let lastFont = "";
/** Width of one line of text in the element's font. */
export function measureLine(line, el) {
  if (!measureCtx) {
    const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    measureCtx = c.getContext("2d");
  }
  const f = fontString(el);
  if (f !== lastFont) { measureCtx.font = f; lastFont = f; }
  return measureCtx.measureText(line).width;
}

/* ── drawables ──────────────────────────────────────────────────────────── */

function adjustRoughness(el) {
  const maxSize = Math.max(el.width, el.height);
  const minSize = Math.min(el.width, el.height);
  const linear = M.LINEAR.has(el.type);
  if ((minSize >= 20 && maxSize >= 50) || (minSize >= 15 && !!el.roundness && !linear) || (linear && maxSize >= 50)) return el.roughness;
  return Math.min(el.roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

const dashed = (sw) => [8, 8 + sw];
const dotted = (sw) => [1.5, 6 + sw];

// same options Excalidraw hands rough.js; colours are placeholders
function roughOptions(el, continuous = false) {
  const sw = el.strokeWidth;
  const o = {
    seed: el.seed,
    strokeLineDash: el.strokeStyle === "dashed" ? dashed(sw) : el.strokeStyle === "dotted" ? dotted(sw) : undefined,
    disableMultiStroke: el.strokeStyle !== "solid",
    strokeWidth: el.strokeStyle !== "solid" ? sw + 0.5 : sw,
    fillWeight: sw / 2,
    hachureGap: sw * 4,
    roughness: adjustRoughness(el),
    stroke: "#000",
    preserveVertices: continuous || el.roughness < 2,
  };
  if (M.SHAPES.has(el.type)) {
    o.fillStyle = el.fillStyle;
    o.fill = M.hasFill(el) ? "#000" : undefined;
    if (el.type === "ellipse") o.curveFitting = 1;
  } else if ((el.type === "line" || el.type === "freedraw") && M.isPathALoop(el.points)) {
    o.fillStyle = el.fillStyle;
    o.fill = M.hasFill(el) ? "#000" : undefined;
  }
  return o;
}

// rough.js opsets -> parts with a colour role; fill: role of fillPath/fillSketch
function addDrawable(parts, d, strokeRole = "stroke", fillRole = "bg") {
  const o = d.options;
  for (const set of d.sets) {
    if (set.type === "path") {
      if (o.stroke === "none") continue;
      parts.push({ kind: "stroke", role: strokeRole, width: o.strokeWidth, dash: o.strokeLineDash || null, ops: set.ops, path: null, d: null });
    } else if (set.type === "fillPath") {
      const evenodd = d.shape === "curve" || d.shape === "polygon" || d.shape === "path";
      parts.push({ kind: "fill", role: fillRole, rule: evenodd ? "evenodd" : "nonzero", ops: set.ops, path: null, d: null });
    } else if (set.type === "fillSketch") {
      const fw = o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight;
      parts.push({ kind: "stroke", role: fillRole, width: fw, dash: o.fillLineDash || null, ops: set.ops, path: null, d: null });
    }
  }
}

function roundedRectPath(w, h, r) {
  return `M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`;
}

function med(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** perfect-freehand outline as SVG path data (Excalidraw's settings). */
export function freedrawPath(el) {
  const pts = el.points;
  const input = el.simulatePressure
    ? pts
    : pts.length ? pts.map((p, i) => [p[0], p[1], el.pressures[i] ?? 0.5]) : [[0, 0, 0.5]];
  const outline = getStroke(input, {
    simulatePressure: el.simulatePressure,
    size: el.strokeWidth * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    last: !!el.lastCommittedPoint,
  });
  if (!outline.length) return "";
  const r2 = (v) => Math.round(v * 100) / 100;
  let d = `M ${r2(outline[0][0])} ${r2(outline[0][1])} Q`;
  const max = outline.length - 1;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const m = med(p, i === max ? outline[0] : outline[i + 1]);
    d += ` ${r2(p[0])} ${r2(p[1])} ${r2(m[0])} ${r2(m[1])}`;
    if (i === max) d += ` L ${r2(outline[0][0])} ${r2(outline[0][1])} Z`;
  }
  return d;
}

function simplifyPoints(points, tol) {
  // radial distance filter: enough to keep rough's fill of long scribbles cheap
  if (points.length < 4) return points;
  const out = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= tol) { out.push(p); last = p; }
  }
  out.push(points[points.length - 1]);
  return out;
}

// a brush stroke: stacked soft layers, or one outline (textured), plus bristles
function brushParts(parts, el, b) {
  const last = !!el.lastCommittedPoint;
  const sim = el.simulatePressure;
  const smooth = b.angle == null;
  if (b.layers) {
    for (const [scale, alpha] of b.layers) {
      const d = B.outlineToPath(B.brushOutline(el.points, el.pressures, sim, el.strokeWidth, b, scale, last), smooth);
      parts.push({ kind: "fill", role: "stroke", rule: "nonzero", ops: null, path: null, d, alpha });
    }
  } else {
    const d = B.outlineToPath(B.brushOutline(el.points, el.pressures, sim, el.strokeWidth, b, 1, last), smooth);
    const tex = b.texture === "grain" || b.texture === "chalk" ? b.texture : null;
    parts.push({ kind: "fill", role: "stroke", rule: "nonzero", ops: null, path: null, d, alpha: b.texture === "bristle" ? 0.4 : 1, tex, grain: b.grain });
  }
  const extra = b.texture === "bristle" ? B.bristles(el.points, el.strokeWidth, b, el.seed) : b.texture === "spray" ? B.speckles(el.points, el.strokeWidth, b, el.seed) : null;
  if (extra) for (const s of extra) parts.push({ kind: "stroke", role: "stroke", width: s.width, dash: s.dash, dashOffset: s.offset || 0, ops: null, path: null, d: s.d, alpha: s.alpha });
}

function buildParts(el) {
  const parts = [];
  const o = roughOptions(el);
  const w = el.width;
  const h = el.height;
  switch (el.type) {
    case "rectangle": {
      if (el.roundness) {
        const r = M.cornerRadius(Math.min(w, h), el);
        addDrawable(parts, gen.path(roundedRectPath(w, h, r), roughOptions(el, true)));
      } else {
        addDrawable(parts, gen.rectangle(0, 0, w, h, o));
      }
      break;
    }
    case "diamond": {
      const [tx, ty, rx, ry, bx, by, lx, ly] = [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2];
      if (el.roundness) {
        const vr = M.cornerRadius(Math.abs(lx - tx), el);
        const hr = M.cornerRadius(Math.abs(ry - ty), el);
        const d = `M ${tx + vr} ${ty + hr} L ${rx - vr} ${ry - hr} C ${rx} ${ry}, ${rx} ${ry}, ${rx - vr} ${ry + hr} L ${bx + vr} ${by - hr} C ${bx} ${by}, ${bx} ${by}, ${bx - vr} ${by - hr} L ${lx + vr} ${ly + hr} C ${lx} ${ly}, ${lx} ${ly}, ${lx + vr} ${ly - hr} L ${tx - vr} ${ty + hr} C ${tx} ${ty}, ${tx} ${ty}, ${tx + vr} ${ty + hr}`;
        addDrawable(parts, gen.path(d, roughOptions(el, true)));
      } else {
        addDrawable(parts, gen.polygon([[tx, ty], [rx, ry], [bx, by], [lx, ly]], o));
      }
      break;
    }
    case "ellipse":
      addDrawable(parts, gen.ellipse(w / 2, h / 2, w, h, o));
      break;
    case "line":
    case "arrow": {
      const pts = el.points.length > 1 ? el.points : [el.points[0], el.points[0]];
      const method = el.roundness && pts.length > 2 ? "curve" : o.fill ? "polygon" : "linearPath";
      addDrawable(parts, gen[method](pts, o));
      if (el.type === "arrow") {
        for (const pos of ["start", "end"]) {
          const head = pos === "start" ? el.startArrowhead : el.endArrowhead;
          if (!head) continue;
          const g = M.arrowheadPoints(el, pos, head);
          if (!g) continue;
          const ho = { ...o };
          delete ho.fill;
          if (g.kind === "circle") {
            const [x, y, d] = g.pts;
            if (g.outline) addDrawable(parts, gen.circle(x, y, d, { ...ho, fill: "#000", fillStyle: "solid", strokeLineDash: undefined }), "stroke", "canvas");
            else addDrawable(parts, gen.circle(x, y, d, { ...ho, fill: "#000", fillStyle: "solid", stroke: "none" }), "stroke", "stroke");
          } else if (g.kind === "polygon") {
            delete ho.strokeLineDash;
            addDrawable(parts, gen.polygon(g.pts, { ...ho, fill: "#000", fillStyle: "solid" }), "stroke", g.outline ? "canvas" : "stroke");
          } else {
            if (el.strokeStyle === "dotted") {
              const d = dotted(el.strokeWidth - 1);
              ho.strokeLineDash = [d[0], d[1] - 1];
            } else delete ho.strokeLineDash;
            for (const l of g.pts) addDrawable(parts, gen.line(l[0], l[1], l[2], l[3], ho));
          }
        }
      }
      break;
    }
    case "freedraw": {
      if (o.fill) addDrawable(parts, gen.curve(simplifyPoints(el.points, 0.75), { ...o, stroke: "none" }));
      const b = B.brushOf(el);
      if (B.isPlain(b)) {
        parts.push({ kind: "fill", role: "stroke", rule: "nonzero", ops: null, path: null, d: freedrawPath(el) });
        break;
      }
      brushParts(parts, el, b);
      break;
    }
    default:
      break;
  }
  return parts;
}

const cache = new WeakMap();
const lru = new Map();
const LRU_MAX = 4000;

/**
 * Drawable parts of an element, built once per version. `shared` also looks
 * in a small LRU by id and version, so a re-parsed drawing (note embeds)
 * reuses earlier work.
 */
export function shapeOf(el, shared = false) {
  let e = cache.get(el);
  if (e && e.v === el.version && e.w === el.width && e.h === el.height && e.p === el.points) return e;
  let key = null;
  if (shared) {
    key = `${el.id}|${el.version}|${el.versionNonce}|${el.type}|${el.width}|${el.height}|${el.points ? el.points.length : 0}`;
    const hit = lru.get(key);
    if (hit) {
      e = { v: el.version, w: el.width, h: el.height, p: el.points, parts: hit.parts };
      cache.set(el, e);
      return e;
    }
  }
  e = { v: el.version, w: el.width, h: el.height, p: el.points, parts: buildParts(el) };
  cache.set(el, e);
  if (key) {
    if (lru.size >= LRU_MAX) lru.delete(lru.keys().next().value);
    lru.set(key, e);
  }
  return e;
}

/** Drop cached drawables for an element (e.g. in-place point edits). */
export function forget(el) {
  cache.delete(el);
}

function partPath(part) {
  if (part.path) return part.path;
  if (part.ops) {
    const p = new Path2D();
    for (const op of part.ops) {
      const d = op.data;
      if (op.op === "move") p.moveTo(d[0], d[1]);
      else if (op.op === "bcurveTo") p.bezierCurveTo(d[0], d[1], d[2], d[3], d[4], d[5]);
      else p.lineTo(d[0], d[1]);
    }
    part.path = p;
  } else {
    part.path = new Path2D(part.d || "");
  }
  return part.path;
}

const r1 = (v) => Math.round(v * 10) / 10;

// SVG path data with one decimal: plenty for previews, a third of the size
function partD(part) {
  if (part.d != null) return part.d;
  let d = "";
  for (const op of part.ops) {
    const a = op.data;
    if (op.op === "move") d += "M" + r1(a[0]) + " " + r1(a[1]);
    else if (op.op === "bcurveTo") d += "C" + r1(a[0]) + " " + r1(a[1]) + " " + r1(a[2]) + " " + r1(a[3]) + " " + r1(a[4]) + " " + r1(a[5]);
    else d += "L" + r1(a[0]) + " " + r1(a[1]);
  }
  part.d = d;
  return d;
}

/* ── canvas ─────────────────────────────────────────────────────────────── */

/** How far a freehand stroke reaches past its points, per unit of width. */
export function brushReach(el, plain = 2.2) {
  const b = B.brushOf(el);
  if (!b) return plain;
  let s = 1;
  if (b.layers) for (const l of b.layers) s = Math.max(s, l[0]);
  return b.size * s * (b.texture === "spray" ? 1.3 : 0.6) + 0.5;
}

/* textures: a tinted noise tile per colour, built once, drawn as a pattern */
const texCache = new Map();
function textureTile(color, kind, grain) {
  const key = color + "|" + kind + "|" + grain;
  let t = texCache.get(key);
  if (t) return t;
  if (texCache.size > 48) texCache.clear();
  const size = kind === "chalk" ? 64 : 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const x = c.getContext("2d");
  const img = x.createImageData(size, size);
  const p = M.parseColor(color) || [0, 0, 0, 1];
  const rand = B.rng(0x9e3779b9 ^ (kind === "chalk" ? 7 : 3));
  const d = img.data;
  let prev = 1;
  for (let i = 0; i < size * size; i++) {
    const n = rand();
    let a;
    if (kind === "chalk") a = n < grain * 0.75 ? n * 0.4 : 0.72 + n * 0.28;
    else {
      // pencil: fibres run sideways, so each pixel leans on its neighbour
      const v = n < grain * 0.6 ? 0.35 + n * 0.6 : 0.88 + n * 0.12;
      a = i % size ? v * 0.6 + prev * 0.4 : v;
    }
    prev = a;
    d[i * 4] = p[0];
    d[i * 4 + 1] = p[1];
    d[i * 4 + 2] = p[2];
    d[i * 4 + 3] = Math.round(255 * a * p[3]);
  }
  x.putImageData(img, 0, 0);
  t = { canvas: c, scale: kind === "chalk" ? 1.6 : 1, pats: new WeakMap() };
  texCache.set(key, t);
  return t;
}

function texturePattern(ctx, color, kind, grain, zoom) {
  const t = textureTile(color, kind, grain);
  let pat = t.pats.get(ctx);
  if (!pat) {
    pat = { p: ctx.createPattern(t.canvas, "repeat"), k: 0 };
    t.pats.set(ctx, pat);
  }
  // grain stays the same size on screen at every zoom
  if (pat.k !== zoom && pat.p.setTransform) {
    const s = t.scale / zoom;
    pat.p.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
    pat.k = zoom;
  }
  return pat.p;
}

const boundsCache = new WeakMap();
/** Cached world bounds; cheap to call every frame. */
export function boundsOf(el) {
  let b = boundsCache.get(el);
  if (b && b.v === el.version && b.x === el.x && b.y === el.y && b.a === el.angle && b.w === el.width && b.h === el.height && b.p === el.points) return b.b;
  const r = M.elementBounds(el);
  if (!b) {
    b = { v: 0, x: 0, y: 0, a: 0, w: 0, h: 0, p: null, b: new Float64Array(4) };
    boundsCache.set(el, b);
  }
  b.v = el.version; b.x = el.x; b.y = el.y; b.a = el.angle; b.w = el.width; b.h = el.height; b.p = el.points;
  // room for rough wobble, stroke width and arrowhead wings
  const pad = el.strokeWidth * (el.type === "freedraw" ? brushReach(el) : 2) + (el.type === "arrow" ? 14 : 4) + el.roughness * 2 + (el.customData && (el.customData.sticky || el.customData.notePath) ? 6 : 0);
  b.b[0] = r[0] - pad; b.b[1] = r[1] - pad; b.b[2] = r[2] + pad; b.b[3] = r[3] + pad;
  return b.b;
}

function roleColor(role, el, o) {
  if (role === "stroke") return o.dark ? M.darkColor(el.strokeColor) : el.strokeColor;
  if (role === "bg") return o.dark ? M.darkColor(el.backgroundColor) : el.backgroundColor;
  return o.canvasBg;
}

const textEntries = new WeakMap();
function textLines(el, entry) {
  if (!entry.lines || entry.lt !== el.text) {
    entry.lines = String(el.text).replace(/\r\n?/g, "\n").split("\n");
    entry.lt = el.text;
  }
  return entry.lines;
}


/**
 * Draw one element. The context is in world coordinates already.
 * o: { dark, zoom, canvasBg, getImage(fileId), frames: Map, lod }
 */
const NO_DASH = [];

export function drawElement(ctx, el, o) {
  // centre inline: this runs for every visible element on every frame
  let cx;
  let cy;
  if (el.points && (el.type === "arrow" || el.type === "line" || el.type === "freedraw")) {
    const e = M.linearGeometry(el).ext;
    cx = el.x + (e[0] + e[2]) / 2;
    cy = el.y + (e[1] + e[3]) / 2;
  } else {
    cx = el.x + el.width / 2;
    cy = el.y + el.height / 2;
  }
  const alpha = Math.max(0, Math.min(1, (el.opacity ?? 100) / 100)) * (o.alpha ?? 1);
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (el.frameId && o.frames) {
    const f = o.frames.get(el.frameId);
    if (f && !f.isDeleted) {
      ctx.beginPath();
      ctx.rect(f.x, f.y, f.width, f.height);
      ctx.clip();
    }
  }
  ctx.translate(cx, cy);
  if (el.angle) ctx.rotate(el.angle);
  ctx.translate(el.x - cx, el.y - cy);
  const zoom = o.zoom || 1;
  const tiny = o.lod && Math.max(el.width, el.height) * zoom < 3;
  switch (el.type) {
    case "text": {
      if (el.fontSize * zoom < 2.5 && o.lod) {
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillStyle = roleColor("stroke", el, o);
        ctx.fillRect(0, 0, el.width, el.height);
        break;
      }
      let entry = textEntries.get(el);
      if (!entry) { entry = { lines: null, lt: null, font: "", fs: 0, ff: 0 }; textEntries.set(el, entry); }
      const lines = textLines(el, entry);
      if (entry.fs !== el.fontSize || entry.ff !== el.fontFamily) {
        entry.font = fontString(el);
        entry.bold = "650 " + entry.font;
        entry.fs = el.fontSize;
        entry.ff = el.fontFamily;
      }
      // a note card's first line is its title
      const titled = !!(el.customData && el.customData.titleLine);
      ctx.font = titled ? entry.bold : entry.font;
      ctx.fillStyle = roleColor("stroke", el, o);
      ctx.textAlign = el.textAlign === "center" ? "center" : el.textAlign === "right" ? "right" : "left";
      ctx.textBaseline = "middle";
      const lh = el.fontSize * el.lineHeight;
      const x = el.textAlign === "center" ? el.width / 2 : el.textAlign === "right" ? el.width : 0;
      // A label on an arrow sits ON the line. Excalidraw breaks the line there;
      // here the canvas colour is laid under the words, which reads the same and
      // is what makes a dimension's number legible.
      if (el.containerId && o.containerOf && o.maskLabels !== false) {
        const c = o.containerOf(el.containerId);
        if (c && c.type === "arrow" && !c.isDeleted) {
          const fill = ctx.fillStyle;
          ctx.fillStyle = o.canvasBg || (o.dark ? "#121212" : "#ffffff");
          ctx.fillRect(-4, -1, el.width + 8, el.height + 2);
          ctx.fillStyle = fill;
        }
      }
      for (let i = 0; i < lines.length; i++) {
        if (titled && i === 1) {
          ctx.font = entry.font;
          ctx.globalAlpha = alpha * 0.72;
        }
        ctx.fillText(lines[i], x, i * lh + lh / 2 + el.fontSize * 0.04);
      }
      break;
    }
    case "image": {
      const img = o.getImage ? o.getImage(el.fileId) : null;
      const sx = el.scale ? el.scale[0] : 1;
      const sy = el.scale ? el.scale[1] : 1;
      if (img) {
        ctx.save();
        if (el.roundness) {
          const r = M.cornerRadius(Math.min(el.width, el.height), el);
          ctx.beginPath();
          ctx.roundRect(0, 0, el.width, el.height, r);
          ctx.clip();
        }
        if (sx < 0 || sy < 0) {
          ctx.translate(sx < 0 ? el.width : 0, sy < 0 ? el.height : 0);
          ctx.scale(sx < 0 ? -1 : 1, sy < 0 ? -1 : 1);
        }
        ctx.drawImage(img, 0, 0, el.width, el.height);
        ctx.restore();
      } else {
        ctx.fillStyle = o.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
        ctx.fillRect(0, 0, el.width, el.height);
        ctx.strokeStyle = o.dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.15)";
        ctx.lineWidth = 1 / zoom;
        ctx.strokeRect(0, 0, el.width, el.height);
      }
      break;
    }
    case "frame":
    case "magicframe": {
      ctx.strokeStyle = o.dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.22)";
      ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();
      ctx.roundRect(0, 0, el.width, el.height, 8 / zoom);
      ctx.stroke();
      const name = el.name || (el.type === "magicframe" ? "AI Frame" : "Frame");
      ctx.font = `500 ${12 / zoom}px "Inter Variable", "Segoe UI", sans-serif`;
      ctx.fillStyle = o.dark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.45)";
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText(name, 0, -5 / zoom, Math.max(10, el.width));
      break;
    }
    case "rectangle":
    case "ellipse":
    case "diamond":
    case "line":
    case "arrow":
    case "freedraw": {
      if (tiny) {
        ctx.fillStyle = roleColor(M.hasFill(el) ? "bg" : "stroke", el, o);
        const e = el.points ? M.linearGeometry(el).ext : [0, 0, el.width, el.height];
        ctx.fillRect(e[0], e[1], Math.max(e[2] - e[0], 1 / zoom), Math.max(e[3] - e[1], 1 / zoom));
        break;
      }
      if (el.type === "rectangle" && el.customData && (el.customData.notePath || el.customData.sticky)) {
        drawPaper(ctx, el, o, zoom);
        break;
      }
      const noStroke = M.isTransparent(el.strokeColor);
      const shape = shapeOf(el);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      let glow = false;
      let base = alpha;
      if (el.type === "freedraw") {
        const b = B.brushOf(el);
        // highlighters darken in light mode and glow in dark mode (in their
        // true ink, softer), so what is under them stays readable
        if (b && b.blend === "multiply") {
          ctx.globalCompositeOperation = o.dark ? "screen" : "multiply";
          glow = o.dark;
          if (glow) ctx.globalAlpha = base = alpha * 0.85;
        }
        if (b && !b.cap) ctx.lineCap = "butt";
      }
      for (const part of shape.parts) {
        const color = glow && part.role === "stroke" ? el.strokeColor : roleColor(part.role, el, o);
        if (part.role === "stroke" && noStroke) continue;
        if (part.alpha !== undefined) ctx.globalAlpha = base * part.alpha;
        if (part.kind === "fill") {
          ctx.fillStyle = part.tex && !o.plainTex ? texturePattern(ctx, color, part.tex, part.grain, zoom) : color;
          ctx.fill(partPath(part), part.rule);
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = part.width;
          if (part.dash) {
            ctx.setLineDash(part.dash);
            if (part.dashOffset) ctx.lineDashOffset = part.dashOffset;
          }
          ctx.stroke(partPath(part));
          if (part.dash) {
            ctx.setLineDash(NO_DASH);
            if (part.dashOffset) ctx.lineDashOffset = 0;
          }
        }
      }
      break;
    }
    default: {
      // embeddables and anything newer: a labelled placeholder keeps the layout readable
      ctx.strokeStyle = o.dark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([4 / zoom, 4 / zoom]);
      ctx.strokeRect(0, 0, el.width, el.height);
      ctx.setLineDash(NO_DASH);
      ctx.font = `${12 / zoom}px sans-serif`;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(el.link || el.type, 6 / zoom, 16 / zoom, Math.max(10, el.width - 12 / zoom));
    }
  }
  ctx.restore();
}

export const STICKY_DEFAULT = "#ffeab0";
// white cards take the theme's paper; dark stickies are lifted a touch so they read as paper
const liftCache = new Map();
function lift(c) {
  let out = liftCache.get(c);
  if (out) return out;
  const p = M.parseColor(c) || [0, 0, 0, 1];
  out = M.toHex(p[0] + (255 - p[0]) * 0.1, p[1] + (255 - p[1]) * 0.1, p[2] + (255 - p[2]) * 0.1, p[3]);
  if (liftCache.size > 200) liftCache.clear();
  liftCache.set(c, out);
  return out;
}
function paperFill(el, o) {
  const sticky = !!el.customData.sticky;
  const bg = el.backgroundColor;
  if (!sticky && (M.isTransparent(bg) || /^#f{3}(f{3})?$/i.test(bg))) return o.dark ? "#26262b" : "#ffffff";
  const c = M.isTransparent(bg) ? STICKY_DEFAULT : bg;
  return o.dark ? (sticky ? lift(M.darkColor(c)) : M.darkColor(c)) : c;
}

// note cards and sticky notes: clean paper with a soft shadow, no rough.js
function drawPaper(ctx, el, o, zoom) {
  const w = el.width;
  const h = el.height;
  const sticky = !!el.customData.sticky;
  const r = Math.min(sticky ? 4 : 10, w / 4, h / 4);
  const a = ctx.globalAlpha;
  ctx.fillStyle = o.dark ? "rgba(0,0,0,0.4)" : "rgba(20,24,32,0.1)";
  ctx.beginPath();
  if (sticky) ctx.roundRect(w * 0.03, h * 0.05, w * 0.94, h * 0.97, r);
  else ctx.roundRect(0, 2.5, w, h, r);
  ctx.fill();
  ctx.fillStyle = paperFill(el, o);
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.fill();
  if (sticky) {
    // a hint of a lifted corner
    ctx.globalAlpha = a * (o.dark ? 0.22 : 0.07);
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.moveTo(w, h - Math.min(22, h * 0.14));
    ctx.lineTo(w - Math.min(22, w * 0.14), h);
    ctx.lineTo(w - r, h);
    ctx.quadraticCurveTo(w, h, w, h - r);
    ctx.fill();
    ctx.globalAlpha = a;
    if (!M.isTransparent(el.strokeColor) && el.strokeWidth > 0 && el.customData.outline) {
      ctx.strokeStyle = roleColor("stroke", el, o);
      ctx.lineWidth = el.strokeWidth;
      ctx.stroke();
    }
    return;
  }
  ctx.strokeStyle = o.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
  ctx.lineWidth = Math.max(1 / zoom, 0.6);
  ctx.stroke();
  // the accent stripe takes the stroke colour
  ctx.fillStyle = roleColor("stroke", el, o);
  ctx.beginPath();
  ctx.roundRect(0, 0, Math.min(4, w / 4), h, [r, 0, 0, r]);
  ctx.fill();
  // a folded-page mark in the corner
  const s = Math.min(14, w / 8);
  ctx.globalAlpha = a * 0.45;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const x0 = w - s - 10;
  const y0 = 10;
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + s * 0.62, y0);
  ctx.lineTo(x0 + s * 0.85, y0 + s * 0.25);
  ctx.lineTo(x0 + s * 0.85, y0 + s);
  ctx.lineTo(x0, y0 + s);
  ctx.closePath();
  ctx.stroke();
  ctx.globalAlpha = a;
}

/**
 * Draw a list of elements in order, skipping what is off screen.
 * o.viewport = [x1, y1, x2, y2] in world units; o.skip(el) hides elements
 * drawn elsewhere (the one being edited lives on the overlay).
 */
export function drawElements(ctx, list, o) {
  const vp = o.viewport;
  let drawn = 0;
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el.isDeleted) continue;
    if (o.skip && o.skip(el)) continue;
    if (vp) {
      const b = boundsOf(el);
      if (b[2] < vp[0] || b[0] > vp[2] || b[3] < vp[1] || b[1] > vp[3]) {
        // frame names sit above the frame
        if (!(el.type === "frame" && b[2] >= vp[0] && b[0] <= vp[2] && b[3] >= vp[1] - 40 && b[1] <= vp[3] + 40)) continue;
      }
    }
    drawElement(ctx, el, o);
    drawn++;
  }
  return drawn;
}

/* ── SVG ────────────────────────────────────────────────────────────────── */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n2 = (v) => Math.round(v * 100) / 100;

function elementSvg(el, o) {
  const [cx, cy] = M.elementCenter(el);
  const deg = ((el.angle || 0) * 180) / Math.PI;
  let tf = `translate(${n2(el.x)} ${n2(el.y)})`;
  if (deg) tf = `rotate(${n2(deg)} ${n2(cx)} ${n2(cy)}) ` + tf;
  const op = (el.opacity ?? 100) / 100;
  let body = "";
  switch (el.type) {
    case "text": {
      const lines = String(el.text).replace(/\r\n?/g, "\n").split("\n");
      const lh = el.fontSize * el.lineHeight;
      const anchor = el.textAlign === "center" ? "middle" : el.textAlign === "right" ? "end" : "start";
      const x = el.textAlign === "center" ? el.width / 2 : el.textAlign === "right" ? el.width : 0;
      const fill = roleColor("stroke", el, o);
      const fam = esc(fontStack(el.fontFamily));
      const titled = !!(el.customData && el.customData.titleLine);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        const extra = titled ? (i === 0 ? ' font-weight="650"' : ' fill-opacity="0.72"') : "";
        body += `<text x="${n2(x)}" y="${n2(i * lh + lh / 2 + el.fontSize * 0.04)}" font-family="${fam}" font-size="${el.fontSize}px" fill="${fill}"${extra} text-anchor="${anchor}" dominant-baseline="central" style="white-space: pre;">${esc(lines[i])}</text>`;
      }
      break;
    }
    case "image": {
      const f = o.files && el.fileId ? o.files[el.fileId] : null;
      if (f && f.dataURL) {
        const sx = el.scale ? el.scale[0] : 1;
        const sy = el.scale ? el.scale[1] : 1;
        const flip = sx < 0 || sy < 0 ? ` transform="translate(${sx < 0 ? n2(el.width) : 0} ${sy < 0 ? n2(el.height) : 0}) scale(${sx < 0 ? -1 : 1} ${sy < 0 ? -1 : 1})"` : "";
        body = `<image href="${esc(f.dataURL)}" width="${n2(el.width)}" height="${n2(el.height)}" preserveAspectRatio="none"${flip}/>`;
      } else {
        body = `<rect width="${n2(el.width)}" height="${n2(el.height)}" fill="${o.dark ? "#ffffff10" : "#0000000d"}"/>`;
      }
      break;
    }
    case "frame":
    case "magicframe": {
      const c = o.dark ? "#ffffff48" : "#00000038";
      body = `<rect width="${n2(el.width)}" height="${n2(el.height)}" rx="8" fill="none" stroke="${c}" stroke-width="1.5"/>`;
      body += `<text x="0" y="-6" font-family="${esc(FONT_STACKS.sans)}" font-size="12px" fill="${c}">${esc(el.name || "Frame")}</text>`;
      break;
    }
    case "rectangle":
    case "ellipse":
    case "diamond":
    case "line":
    case "arrow":
    case "freedraw": {
      if (el.type === "rectangle" && el.customData && (el.customData.notePath || el.customData.sticky)) {
        const w = n2(el.width);
        const hh = n2(el.height);
        const sticky = !!el.customData.sticky;
        const r = n2(Math.min(sticky ? 4 : 10, el.width / 4, el.height / 4));
        body = `<rect x="0" y="${sticky ? n2(el.height * 0.05) : 2.5}" width="${w}" height="${hh}" rx="${r}" fill="${o.dark ? "#000" : "#141820"}" fill-opacity="${o.dark ? 0.4 : 0.1}"/>`
          + `<rect width="${w}" height="${hh}" rx="${r}" fill="${paperFill(el, o)}"${sticky ? "" : ` stroke="${o.dark ? "#ffffff1a" : "#0000001a"}"`}/>`;
        if (!sticky) body += `<rect width="${n2(Math.min(4, el.width / 4))}" height="${hh}" rx="2" fill="${roleColor("stroke", el, o)}"/>`;
        break;
      }
      const noStroke = M.isTransparent(el.strokeColor);
      const hb = el.type === "freedraw" ? B.brushOf(el) : null;
      // neighbouring parts drawn the same way share one path element
      let key = "";
      let d = "";
      let head = "";
      const flush = () => { if (d) body += `<path d="${d}"${head}/>`; d = ""; };
      for (const part of shapeOf(el, o.shared).parts) {
        if (part.role === "stroke" && noStroke) continue;
        const pd = partD(part);
        if (!pd) continue;
        const k = `${part.kind}|${part.role}|${part.width}|${part.dash}|${part.rule}|${part.alpha}|${part.dashOffset}`;
        if (k !== key) {
          flush();
          key = k;
          const color = hb && hb.blend === "multiply" && o.dark && part.role === "stroke" ? el.strokeColor : roleColor(part.role, el, o);
          const op = part.alpha !== undefined && part.alpha < 1 ? ` ${part.kind === "fill" ? "fill" : "stroke"}-opacity="${n2(part.alpha * (part.tex ? 0.9 : 1))}"` : part.tex ? ` fill-opacity="0.9"` : "";
          head = part.kind === "fill"
            ? ` fill="${color}"${part.rule === "evenodd" ? ' fill-rule="evenodd"' : ""} stroke="none"${op}`
            : ` fill="none" stroke="${color}" stroke-width="${n2(part.width)}"${part.dash ? ` stroke-dasharray="${part.dash.map(n2).join(" ")}"${part.dashOffset ? ` stroke-dashoffset="${n2(part.dashOffset)}"` : ""}` : ""} stroke-linecap="round" stroke-linejoin="round"${op}`;
        }
        d += pd;
      }
      flush();
      break;
    }
    default:
      body = `<rect width="${n2(el.width)}" height="${n2(el.height)}" fill="none" stroke="${o.dark ? "#ffffff50" : "#00000040"}" stroke-dasharray="4 4"/>`;
  }
  if (!body) return "";
  const hl = el.type === "freedraw" && (B.brushOf(el) || {}).blend === "multiply";
  const blend = hl ? ` style="mix-blend-mode:${o.dark ? "screen" : "multiply"}"` : "";
  const gop = hl && o.dark ? op * 0.85 : op;
  let g = `<g transform="${tf}"${gop < 1 ? ` opacity="${n2(gop)}"` : ""}${blend}>${body}</g>`;
  if (el.frameId && o.frameClips && o.frameClips.has(el.frameId)) g = `<g clip-path="url(#${o.frameClips.get(el.frameId)})">${g}</g>`;
  return g;
}

/**
 * An SVG document for elements. o: { dark, files, padding, background
 * (colour or null for transparent), scale }. Returns { svg, width, height }
 * or null when there is nothing to draw.
 */
/** Bounds that include how far strokes, pen outlines and arrowheads reach. */
export function exportBounds(list) {
  let b = null;
  for (const e of list) {
    const r = M.elementBounds(e);
    const pad = e.type === "freedraw" ? e.strokeWidth * brushReach(e, 3) + 1 : e.customData && (e.customData.sticky || e.customData.notePath) ? 4 :e.type === "text" || e.type === "image" ? 0 : e.strokeWidth / 2 + e.roughness * 1.5 + (e.type === "arrow" ? 4 : 0);
    if (!b) b = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
    else {
      b[0] = Math.min(b[0], r[0] - pad);
      b[1] = Math.min(b[1], r[1] - pad);
      b[2] = Math.max(b[2], r[2] + pad);
      b[3] = Math.max(b[3], r[3] + pad);
    }
  }
  return b;
}

export function elementsToSvg(elements, o = {}) {
  const live = elements.filter((e) => !e.isDeleted);
  const b = exportBounds(live);
  if (!b) return null;
  const pad = o.padding ?? 10;
  const x = b[0] - pad;
  const y = b[1] - pad;
  const w = Math.max(1, b[2] - b[0] + pad * 2);
  const h = Math.max(1, b[3] - b[1] + pad * 2);
  const scale = o.scale || 1;
  const uid = "sk" + Math.random().toString(36).slice(2, 8);
  const frames = new Map(live.filter((e) => e.type === "frame" || e.type === "magicframe").map((f) => [f.id, f]));
  const frameClips = new Map();
  let defs = "";
  for (const f of frames.values()) {
    const id = `${uid}-${frameClips.size}`;
    frameClips.set(f.id, id);
    defs += `<clipPath id="${id}"><rect x="${n2(f.x)}" y="${n2(f.y)}" width="${n2(f.width)}" height="${n2(f.height)}"/></clipPath>`;
  }
  const opts = { dark: !!o.dark, files: o.files || {}, canvasBg: o.canvasBg || (o.dark ? "#121212" : "#ffffff"), frameClips, shared: !!o.shared };
  let body = "";
  for (const el of live) body += elementSvg(el, opts);
  const bg = o.background ? `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${esc(o.background)}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)}" width="${n2(w * scale)}" height="${n2(h * scale)}">`
    + (defs ? `<defs>${defs}</defs>` : "") + bg + body + "</svg>";
  return { svg, width: w * scale, height: h * scale, bounds: [x, y, x + w, y + h] };
}

/**
 * Draw elements into a new canvas for PNG export. o: { dark, scale,
 * background, getImage, padding }.
 */
export function elementsToCanvas(elements, o = {}) {
  const live = elements.filter((e) => !e.isDeleted);
  const b = exportBounds(live);
  if (!b) return null;
  const pad = o.padding ?? 16;
  const scale = o.scale || 2;
  const w = b[2] - b[0] + pad * 2;
  const h = b[3] - b[1] + pad * 2;
  // browsers refuse canvases past ~16k px a side
  const k = Math.min(scale, 16000 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w * k));
  c.height = Math.max(1, Math.ceil(h * k));
  const ctx = c.getContext("2d");
  if (o.background) {
    ctx.fillStyle = o.background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.scale(k, k);
  ctx.translate(pad - b[0], pad - b[1]);
  const frames = new Map(live.filter((e) => e.type === "frame").map((f) => [f.id, f]));
  const byId = new Map(live.map((e) => [e.id, e]));
  // with no background the picture is transparent, and there is no colour to put under a label
  drawElements(ctx, live, { dark: !!o.dark, zoom: k, canvasBg: o.background || (o.dark ? "#121212" : "#ffffff"), getImage: o.getImage, frames, containerOf: (id) => byId.get(id), maskLabels: !!o.background });
  return c;
}
