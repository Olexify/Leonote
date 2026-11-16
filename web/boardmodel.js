// Research boards, the pure half: JSON Canvas reading and writing, geometry,
// layouts, link-graph questions and a small Markdown renderer that only ever
// emits escaped text inside a fixed set of tags. No DOM, so node can test it.
//
// JSON Canvas 1.0: https://jsoncanvas.org/spec/1.0/

import { WIKI_RE, TAG_RE, isTagName, isWebPicture, headingOf } from "./mdparse.js";

export const SIDES = ["top", "right", "bottom", "left"];
export const NORMAL = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
export const NODE_TYPES = ["text", "file", "link", "group"];
export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

// sizes new cards get, as [width, height]
export const SIZES = {
  note: [400, 400],
  image: [400, 300],
  file: [320, 120],
  text: [260, 130],
  link: [340, 112],
  group: [480, 320],
};

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(+v) ? +v : d);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/* ── ids ────────────────────────────────────────────────────────────────── */

/** 16 lowercase hex characters, the shape Obsidian writes. */
export function newId() {
  const b = new Uint8Array(8);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 8; i++) b[i] = (Math.random() * 256) | 0;
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16);
  return s;
}

/* ── reading and writing ────────────────────────────────────────────────── */

function normNode(raw, seen) {
  if (!isObj(raw)) return null;
  const n = { ...raw };
  if (typeof n.id === "number") n.id = String(n.id);
  if (typeof n.id !== "string" || !n.id || seen.has(n.id)) n.id = newId();
  seen.add(n.id);
  const kind = n.type === "file" ? (IMAGE_RE.test(String(n.file || "")) ? "image" : "note") : n.type;
  const def = SIZES[kind] || SIZES.text;
  n.x = num(n.x, 0);
  n.y = num(n.y, 0);
  n.width = Math.max(1, num(n.width, def[0]));
  n.height = Math.max(1, num(n.height, def[1]));
  if (n.type === "text" && typeof n.text !== "string") n.text = n.text == null ? "" : String(n.text);
  if (n.type === "file" && typeof n.file !== "string") n.file = n.file == null ? "" : String(n.file);
  if (n.type === "link" && typeof n.url !== "string") n.url = n.url == null ? "" : String(n.url);
  if (n.color != null && typeof n.color !== "string") n.color = String(n.color);
  return n;
}

function normEdge(raw, ids, seen) {
  if (!isObj(raw)) return null;
  if (!ids.has(raw.fromNode) || !ids.has(raw.toNode)) return null;
  const e = { ...raw };
  if (typeof e.id === "number") e.id = String(e.id);
  if (typeof e.id !== "string" || !e.id || seen.has(e.id)) e.id = newId();
  seen.add(e.id);
  if (e.color != null && typeof e.color !== "string") e.color = String(e.color);
  return e;
}

/**
 * Text -> { canvas, error, dropped }. Never throws: empty text is a new
 * board, broken text is an empty board plus an error message. Unknown fields
 * on the canvas, nodes and edges are kept as they are.
 */
export function parseCanvas(text) {
  const blank = { nodes: [], edges: [] };
  if (text == null || !String(text).trim()) return { canvas: blank, error: null, dropped: 0 };
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch (err) {
    return { canvas: blank, error: "the file is not valid JSON", dropped: 0 };
  }
  if (!isObj(data)) return { canvas: blank, error: "the file is not a canvas", dropped: 0 };
  // nodes and edges stay first; everything else keeps its place after them
  const canvas = { nodes: [], edges: [], ...data };
  let dropped = 0;
  const seen = new Set();
  const nodes = [];
  for (const raw of Array.isArray(data.nodes) ? data.nodes : []) {
    const n = normNode(raw, seen);
    if (n) nodes.push(n);
    else dropped++;
  }
  const ids = new Set(nodes.map((n) => n.id));
  const eseen = new Set();
  const edges = [];
  for (const raw of Array.isArray(data.edges) ? data.edges : []) {
    const e = normEdge(raw, ids, eseen);
    if (e) edges.push(e);
    else dropped++;
  }
  canvas.nodes = nodes;
  canvas.edges = edges;
  return { canvas, error: null, dropped };
}

const roundNode = (n) => {
  const o = { ...n };
  o.x = Math.round(num(n.x, 0));
  o.y = Math.round(num(n.y, 0));
  o.width = Math.max(1, Math.round(num(n.width, 1)));
  o.height = Math.max(1, Math.round(num(n.height, 1)));
  return o;
};

/**
 * Canvas -> text the way Obsidian writes it: tab indented, one node or edge
 * per line (diff friendly), whole-number coordinates.
 */
export function serializeCanvas(canvas) {
  const list = (arr, fix) =>
    arr.length ? "[\n" + arr.map((x) => "\t\t" + JSON.stringify(fix ? fix(x) : x)).join(",\n") + "\n\t]" : "[]";
  const parts = [];
  const keys = Object.keys(canvas);
  if (!keys.includes("nodes")) keys.unshift("nodes");
  if (!keys.includes("edges")) keys.splice(keys.indexOf("nodes") + 1, 0, "edges");
  for (const k of keys) {
    if (k === "nodes") parts.push('\t"nodes":' + list(canvas.nodes || [], roundNode));
    else if (k === "edges") parts.push('\t"edges":' + list(canvas.edges || []));
    else if (canvas[k] !== undefined) parts.push("\t" + JSON.stringify(k) + ":" + JSON.stringify(canvas[k]));
  }
  return "{\n" + parts.join(",\n") + "\n}";
}

/** A new node with the keys in the order Obsidian writes them. */
export function makeNode(type, fields, x, y, width, height) {
  const n = { id: newId(), type };
  if (type === "text") n.text = fields.text || "";
  if (type === "file") {
    n.file = fields.file;
    if (fields.subpath) n.subpath = fields.subpath;
  }
  if (type === "link") n.url = fields.url;
  n.x = Math.round(x);
  n.y = Math.round(y);
  n.width = Math.round(width);
  n.height = Math.round(height);
  if (type === "group" && fields.label) n.label = fields.label;
  if (fields.color) n.color = fields.color;
  return n;
}

export function makeEdge(fromNode, fromSide, toNode, toSide, extra = {}) {
  const e = { id: newId(), fromNode, fromSide, toNode, toSide, toEnd: "arrow" };
  return Object.assign(e, extra);
}

/** The kind of card a node shows as. */
export function kindOf(n) {
  if (!n) return "unknown";
  if (n.type === "text" || n.type === "link" || n.type === "group") return n.type;
  if (n.type === "file") {
    const f = String(n.file || "");
    if (/\.md$/i.test(f)) return "note";
    if (IMAGE_RE.test(f)) return "image";
    return "file";
  }
  return "unknown";
}

/** Preset "1".."6" or "#hex" -> a CSS colour, anything else -> "". */
export function colorVar(c) {
  if (typeof c !== "string") return "";
  if (/^[1-6]$/.test(c)) return `var(--bd-c${c})`;
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c;
  return "";
}

/* ── geometry ───────────────────────────────────────────────────────────── */

export function bounds(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export const center = (r) => [r.x + r.width / 2, r.y + r.height / 2];

export function overlaps(a, b, gap = 0) {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/** Is `inner` entirely inside `outer`? */
export function contains(outer, inner, tol = 1) {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol &&
    inner.x + inner.width <= outer.x + outer.width + tol && inner.y + inner.height <= outer.y + outer.height + tol;
}

/** Ids of everything a group carries along when it moves (nested groups too). */
export function groupMembers(nodes, group) {
  const out = [];
  for (const n of nodes) if (n !== group && n.id !== group.id && contains(group, n)) out.push(n.id);
  return out;
}

export function sidePoint(r, side) {
  if (side === "top") return [r.x + r.width / 2, r.y];
  if (side === "bottom") return [r.x + r.width / 2, r.y + r.height];
  if (side === "left") return [r.x, r.y + r.height / 2];
  return [r.x + r.width, r.y + r.height / 2];
}

/** Which sides face each other, by the larger gap between the two boxes. */
export function autoSides(a, b) {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  const gx = Math.abs(bx - ax) - (a.width + b.width) / 2;
  const gy = Math.abs(by - ay) - (a.height + b.height) / 2;
  if (gx >= gy) return bx >= ax ? ["right", "left"] : ["left", "right"];
  return by >= ay ? ["bottom", "top"] : ["top", "bottom"];
}

/** The side of `r` closest to a point, relative to the box's proportions. */
export function nearestSide(r, px, py) {
  const [cx, cy] = center(r);
  const dx = (px - cx) / Math.max(1, r.width / 2);
  const dy = (py - cy) / Math.max(1, r.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

const f1 = (v) => Math.round(v * 10) / 10;
const pt = (p) => f1(p[0]) + " " + f1(p[1]);

function arrowHead(tip, n, size) {
  const bx = tip[0] + n[0] * size;
  const by = tip[1] + n[1] * size;
  const px = -n[1] * size * 0.52;
  const py = n[0] * size * 0.52;
  return `M${pt(tip)}L${pt([bx + px, by + py])}L${pt([bx - px, by - py])}Z`;
}

function cubicAt(p0, c1, c2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
}

/**
 * A smooth curve between two boxes leaving and entering along the sides'
 * normals. Missing or invalid sides are picked automatically. Arrow heads
 * are separate filled triangles so they stay sharp at any stroke width.
 */
export function edgeGeometry(a, b, fromSide, toSide, { fromEnd = "none", toEnd = "arrow", arrow = 12 } = {}) {
  let fs = SIDES.includes(fromSide) ? fromSide : null;
  let ts = SIDES.includes(toSide) ? toSide : null;
  if (!fs || !ts) {
    const auto = autoSides(a, b);
    fs = fs || auto[0];
    ts = ts || auto[1];
  }
  const p0 = sidePoint(a, fs);
  const p3 = sidePoint(b, ts);
  const n0 = NORMAL[fs];
  const n3 = NORMAL[ts];
  const s0 = fromEnd === "arrow" ? [p0[0] + n0[0] * arrow, p0[1] + n0[1] * arrow] : p0;
  const s3 = toEnd === "arrow" ? [p3[0] + n3[0] * arrow, p3[1] + n3[1] * arrow] : p3;
  const dist = Math.hypot(s3[0] - s0[0], s3[1] - s0[1]);
  const k = clampN(dist * 0.42, 24, 240);
  const c1 = [s0[0] + n0[0] * k, s0[1] + n0[1] * k];
  const c2 = [s3[0] + n3[0] * k, s3[1] + n3[1] * k];
  const arrows = [];
  if (toEnd === "arrow") arrows.push(arrowHead(p3, n3, arrow));
  if (fromEnd === "arrow") arrows.push(arrowHead(p0, n0, arrow));
  return {
    d: `M${pt(s0)}C${pt(c1)} ${pt(c2)} ${pt(s3)}`,
    mid: cubicAt(s0, c1, c2, s3, 0.5).map(f1),
    arrows,
    fromSide: fs,
    toSide: ts,
  };
}

/* ── layouts ────────────────────────────────────────────────────────────── */

/**
 * Tidy grid: items keep their order, columns take the widest item in them,
 * rows the tallest. Returns top-left positions.
 */
export function gridLayout(sizes, { x = 0, y = 0, gap = 40, cols } = {}) {
  const n = sizes.length;
  if (!n) return [];
  const c = Math.max(1, Math.min(n, cols || Math.ceil(Math.sqrt(n))));
  const colW = new Array(c).fill(0);
  const rowH = new Array(Math.ceil(n / c)).fill(0);
  sizes.forEach((s, i) => {
    colW[i % c] = Math.max(colW[i % c], s.width);
    rowH[Math.floor(i / c)] = Math.max(rowH[Math.floor(i / c)], s.height);
  });
  const xs = [x];
  for (let i = 1; i < c; i++) xs[i] = xs[i - 1] + colW[i - 1] + gap;
  const ys = [y];
  for (let i = 1; i < rowH.length; i++) ys[i] = ys[i - 1] + rowH[i - 1] + gap;
  return sizes.map((_, i) => ({ x: Math.round(xs[i % c]), y: Math.round(ys[Math.floor(i / c)]) }));
}

/**
 * The nearest spot to `rect` where it overlaps nothing, searching outward
 * in square rings. Returns a top-left position.
 */
export function findFreeSpot(rect, obstacles, { gap = 30, maxRings = 40 } = {}) {
  const fits = (r) => !obstacles.some((o) => overlaps(o, r, gap));
  if (fits(rect)) return { x: Math.round(rect.x), y: Math.round(rect.y) };
  const sx = Math.max(40, Math.round(rect.width / 2));
  const sy = Math.max(40, Math.round(rect.height / 2));
  for (let ring = 1; ring <= maxRings; ring++) {
    let best = null;
    let bestD = Infinity;
    for (let i = -ring; i <= ring; i++) {
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const r = { ...rect, x: rect.x + i * sx, y: rect.y + j * sy };
        const d = Math.hypot(i * sx, j * sy);
        if (d < bestD && fits(r)) { best = r; bestD = d; }
      }
    }
    if (best) return { x: Math.round(best.x), y: Math.round(best.y) };
  }
  return { x: Math.round(rect.x), y: Math.round(rect.y) };
}

/**
 * Cards on an arc around `c` (angles in radians, 0 = right, clockwise on
 * screen). Each card is pushed outward until it overlaps nothing.
 */
export function ringLayout(c, sizes, { from = 0, to = Math.PI * 2, gap = 60, obstacles = [] } = {}) {
  const n = sizes.length;
  if (!n) return [];
  const D = Math.max(...sizes.map((s) => Math.max(s.width, s.height)));
  const sweep = to - from;
  const full = Math.abs(sweep) >= Math.PI * 2 - 1e-6;
  const slots = full ? n : Math.max(1, n - 1);
  const cr = Math.hypot(c.width, c.height) / 2;
  let r = cr + D / 2 + gap;
  if (n > 1) r = Math.max(r, ((D * 0.8 + gap) * slots) / Math.abs(sweep));
  const [cx, cy] = center(c);
  const placed = [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const { width, height } = sizes[i];
    const a = n === 1 && !full ? (from + to) / 2 : from + (sweep * i) / slots;
    let rr = r;
    let rect = null;
    for (let tries = 0; tries < 16; tries++) {
      rect = { x: cx + Math.cos(a) * rr - width / 2, y: cy + Math.sin(a) * rr - height / 2, width, height };
      if (!obstacles.some((o) => overlaps(o, rect, gap / 3)) && !placed.some((o) => overlaps(o, rect, gap / 3))) break;
      rr += D * 0.45;
    }
    placed.push(rect);
    out.push({ x: Math.round(rect.x), y: Math.round(rect.y) });
  }
  return out;
}

/**
 * Force-directed arrangement of boxes: linked boxes pull together, all boxes
 * push apart, then overlaps are removed. Keeps the group's centre in place.
 * `links` are index pairs. Iterations shrink for large sets so it stays fast.
 */
export function forceLayout(rects, links, { iterations, gap = 40 } = {}) {
  const n = rects.length;
  if (n < 2) return rects.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) }));
  const iters = iterations || Math.max(30, Math.min(300, Math.floor(6e6 / (n * n))));
  const P = rects.map((r, i) => ({ x: r.x + r.width / 2 + ((i * 7) % 5) * 0.01, y: r.y + r.height / 2 + ((i * 13) % 7) * 0.01, w: r.width, h: r.height }));
  const cx0 = P.reduce((s, p) => s + p.x, 0) / n;
  const cy0 = P.reduce((s, p) => s + p.y, 0) / n;
  const size = P.reduce((s, p) => s + Math.max(p.w, p.h), 0) / n;
  const k = size + gap;
  let temp = k;
  for (let it = 0; it < iters; it++) {
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = P[i].x - P[j].x;
        let vy = P[i].y - P[j].y;
        let d2 = vx * vx + vy * vy;
        if (d2 < 1) { vx = 1; vy = 0; d2 = 1; }
        const f = (k * k) / d2;
        dx[i] += vx * f; dy[i] += vy * f;
        dx[j] -= vx * f; dy[j] -= vy * f;
      }
    }
    for (const [a, b] of links) {
      if (a === b || !P[a] || !P[b]) continue;
      const vx = P[a].x - P[b].x;
      const vy = P[a].y - P[b].y;
      const d = Math.max(1, Math.hypot(vx, vy));
      const f = d / k;
      dx[a] -= vx * f; dy[a] -= vy * f;
      dx[b] += vx * f; dy[b] += vy * f;
    }
    for (let i = 0; i < n; i++) {
      // gentle gravity keeps unlinked islands from drifting off
      dx[i] += (cx0 - P[i].x) * 0.02;
      dy[i] += (cy0 - P[i].y) * 0.02;
      const d = Math.hypot(dx[i], dy[i]);
      if (d > 0) {
        const m = Math.min(d, temp) / d;
        P[i].x += dx[i] * m;
        P[i].y += dy[i] * m;
      }
    }
    temp = Math.max(k * 0.02, temp * 0.97);
  }
  removeOverlaps(P, gap);
  const cx1 = P.reduce((s, p) => s + p.x, 0) / n;
  const cy1 = P.reduce((s, p) => s + p.y, 0) / n;
  return P.map((p) => ({ x: Math.round(p.x - p.w / 2 + cx0 - cx1), y: Math.round(p.y - p.h / 2 + cy0 - cy1) }));
}

function removeOverlaps(P, gap) {
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i], b = P[j];
        const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // push apart along the axis that needs the smaller move
        if (ox < oy) {
          const s = (a.x < b.x || (a.x === b.x && i < j) ? -1 : 1) * (ox / 2 + 0.5);
          a.x += s; b.x -= s;
        } else {
          const s = (a.y < b.y || (a.y === b.y && i < j) ? -1 : 1) * (oy / 2 + 0.5);
          a.y += s; b.y -= s;
        }
      }
    }
    if (!moved) return;
  }
}

/* ── the link graph ─────────────────────────────────────────────────────── */

/** notes: iterable of { path, links: [{target}] }. -> Map path -> Set(out paths) */
export function buildLinkMap(notes, resolve) {
  const map = new Map();
  for (const n of notes) {
    const out = new Set();
    for (const l of n.links || []) {
      const to = resolve(l.target, n.path);
      if (to && to !== n.path) out.add(to);
    }
    map.set(n.path, out);
  }
  return map;
}

function undirected(map) {
  const u = new Map();
  const add = (a, b) => {
    if (!u.has(a)) u.set(a, new Set());
    u.get(a).add(b);
  };
  for (const [a, outs] of map) for (const b of outs) { add(a, b); add(b, a); }
  return u;
}

/** Notes linked to or from `path`. */
export function neighbours(map, path) {
  const out = new Set(map.get(path) || []);
  for (const [a, outs] of map) if (outs.has(path)) out.add(a);
  out.delete(path);
  return out;
}

/**
 * Shortest chain of notes from `a` to `b`, following links in either
 * direction. Returns [a, ..., b] or null when nothing within `maxDepth` steps.
 */
export function shortestPath(map, a, b, maxDepth = 6) {
  if (a === b) return [a];
  const u = undirected(map);
  const prev = new Map([[a, null]]);
  let frontier = [a];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const p of frontier) {
      for (const q of u.get(p) || []) {
        if (prev.has(q)) continue;
        prev.set(q, p);
        if (q === b) {
          const path = [b];
          for (let x = p; x != null; x = prev.get(x)) path.push(x);
          return path.reverse();
        }
        next.push(q);
      }
    }
    // a stable order keeps results the same between runs
    frontier = next.sort();
  }
  return null;
}

/** Notes that link to or from both `a` and `b`. */
export function sharedNeighbours(map, a, b) {
  const na = neighbours(map, a);
  const nb = neighbours(map, b);
  return [...na].filter((p) => p !== a && p !== b && nb.has(p)).sort();
}

/** Does `from` link to `to` (directly)? */
export const linksTo = (map, from, to) => !!(map.get(from) && map.get(from).has(to));

/** Paths of notes whose text mentions `title` (case-insensitive). */
export function mentioning(notes, title, except = []) {
  const t = String(title || "").toLowerCase();
  if (t.length < 3) return [];
  const skip = new Set(except);
  const out = [];
  for (const n of notes) {
    if (skip.has(n.path)) continue;
    const low = n.lower != null ? n.lower : String(n.content || "").toLowerCase();
    if (low.includes(t)) out.push(n.path);
  }
  return out;
}

/** Quick title-first ranking for the board's vault search. */
export function rankNotes(notes, query, { limit = 8, exclude } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const n of notes) {
    if (exclude && exclude.has(n.path)) continue;
    const t = String(n.title || "").toLowerCase();
    let s = 0;
    if (t === q) s = 4;
    else if (t.startsWith(q)) s = 3;
    else if (t.includes(q)) s = 2;
    else if ((n.lower != null ? n.lower : String(n.content || "").toLowerCase()).includes(q)) s = 1;
    if (s) out.push({ n, s });
  }
  out.sort((a, b) => b.s - a.s || (b.n.mtime || 0) - (a.n.mtime || 0) || String(a.n.title).localeCompare(String(b.n.title)));
  return out.slice(0, limit).map((x) => x.n);
}

/* ── clipboard and drops ────────────────────────────────────────────────── */

export function copyPayload(canvas, ids) {
  const set = new Set(ids);
  return {
    type: "leonote-board",
    nodes: canvas.nodes.filter((n) => set.has(n.id)).map((n) => JSON.parse(JSON.stringify(n))),
    edges: canvas.edges.filter((e) => set.has(e.fromNode) && set.has(e.toNode)).map((e) => JSON.parse(JSON.stringify(e))),
  };
}

/** Clipboard text -> { nodes, edges } when it is board (or JSON Canvas) data. */
export function readPayload(text) {
  if (!text || typeof text !== "string" || !/^\s*\{/.test(text)) return null;
  try {
    const d = JSON.parse(text);
    if (!isObj(d) || !Array.isArray(d.nodes) || !d.nodes.length) return null;
    const seen = new Set();
    const nodes = d.nodes.map((n) => normNode(n, seen)).filter((n) => n && typeof n.type === "string");
    if (!nodes.length) return null;
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (Array.isArray(d.edges) ? d.edges : []).filter((e) => isObj(e) && ids.has(e.fromNode) && ids.has(e.toNode));
    return { nodes, edges };
  } catch {
    return null;
  }
}

/** Fresh ids for pasted cards, moved by (dx, dy); edges follow their ends. */
export function remapPayload(p, dx = 0, dy = 0) {
  const map = new Map();
  const nodes = p.nodes.map((n) => {
    const id = newId();
    map.set(n.id, id);
    return { ...JSON.parse(JSON.stringify(n)), id, x: Math.round(num(n.x, 0) + dx), y: Math.round(num(n.y, 0) + dy) };
  });
  const edges = p.edges
    .filter((e) => map.has(e.fromNode) && map.has(e.toNode))
    .map((e) => ({ ...JSON.parse(JSON.stringify(e)), id: newId(), fromNode: map.get(e.fromNode), toNode: map.get(e.toNode) }));
  return { nodes, edges, map };
}

/** [[wikilink]] targets in dropped or pasted text. */
export function wikiTargets(text) {
  const out = [];
  if (!text) return out;
  WIKI_RE.lastIndex = 0;
  for (const m of String(text).matchAll(WIKI_RE)) {
    const t = m[1].trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The URL when the text is nothing but one web address. `uriList` skips
 *  the comment lines text/uri-list may carry. */
export function urlOf(text, uriList = false) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !(uriList && l.startsWith("#")));
  if (lines.length !== 1) return null;
  const u = lines[0];
  if (/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(u)) return u;
  if (/^www\.[^\s.]+\.[^\s]+$/i.test(u)) return "https://" + u;
  return null;
}

/* ── Markdown ───────────────────────────────────────────────────────────── */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const esc = escapeHtml;

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEAD = { exec: (l) => headingOf(l, 3, true), test: (l) => !!headingOf(l, 3, true) };
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
// a delimiter row needs at least one pipe, so a plain "---" stays a rule
const TABLE_SEP = /^(?=[^|]*\|)\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const normHead = (s) => s.toLowerCase().replace(/[#*_`[\]]/g, "").replace(/\s+/g, " ").trim();

/**
 * Just the part of a note a subpath points at: "#Heading" (to the next
 * heading of the same or higher level) or "#^block-id" (its paragraph).
 * Returns { text, offset, missing } where offset is the first line's index.
 */
export function sectionOf(content, subpath) {
  const all = String(content || "");
  if (!subpath) return { text: all, offset: 0 };
  const sp = String(subpath).replace(/^#/, "");
  const lines = all.split("\n");
  if (sp.startsWith("^")) {
    const id = sp.slice(1).toLowerCase();
    const i = lines.findIndex((l) => {
      const m = /\s\^([\w-]+)\s*$/.exec(l);
      return m && m[1].toLowerCase() === id;
    });
    if (i < 0) return { text: all, offset: 0, missing: true };
    // the block is its paragraph; a list item or heading is a block alone
    let s = i;
    if (!LIST.test(lines[i]) && !HEAD.test(lines[i])) {
      while (s > 0 && lines[s - 1].trim() && !HEAD.test(lines[s - 1]) && !FENCE.test(lines[s - 1]) && !LIST.test(lines[s - 1])) s--;
    }
    const part = lines.slice(s, i + 1);
    part[part.length - 1] = part[part.length - 1].replace(/\s\^[\w-]+\s*$/, "");
    return { text: part.join("\n"), offset: s };
  }
  const want = normHead(sp.split("#").pop());
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = HEAD.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= level) return { text: lines.slice(start, i).join("\n"), offset: start };
    if (start < 0 && normHead(m[2]) === want) { start = i; level = m[1].length; }
  }
  if (start >= 0) return { text: lines.slice(start).join("\n"), offset: start };
  return { text: all, offset: 0, missing: true };
}

function isBlockStart(line, next) {
  return FENCE.test(line) || HEAD.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line) ||
    line.trim() === "$$" || (next != null && line.includes("|") && TABLE_SEP.test(next));
}

const CALLOUT_ALIAS = {
  info: "note", todo: "note", abstract: "summary", tldr: "summary", hint: "tip", important: "tip",
  check: "success", done: "success", help: "question", faq: "question", caution: "warning", attention: "warning",
  fail: "danger", failure: "danger", missing: "danger", error: "danger", bug: "danger", cite: "quote",
};

/**
 * Markdown -> HTML string. Every piece of note text is escaped and only a
 * fixed set of tags and attributes is produced; links carry their target in
 * data attributes (never href), so nothing in a note can run or navigate.
 *
 * opts.resolve(target) -> path|null   marks [[links]] that go nowhere
 * opts.image(target) -> url|null      pictures for ![[x.png]] and ![](x)
 * opts.offset                         source line of the first line (tasks)
 */
export function mdToHtml(src, opts = {}) {
  const max = opts.maxChars || 60000;
  let text = String(src == null ? "" : src).replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  // Obsidian comments vanish, but keep their newlines so line numbers hold
  text = text.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, ""));
  let clipped = false;
  if (text.length > max) {
    const cut = text.lastIndexOf("\n", max);
    text = text.slice(0, cut > 0 ? cut : max);
    clipped = true;
  }
  const lines = text.split("\n");
  const offset = opts.offset || 0;
  let from = 0;
  if (!offset && lines[0] === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === "---" || lines[j] === "...") { from = j + 1; break; }
    }
  }
  const ctx = { resolve: opts.resolve, image: opts.image, webPictures: opts.webPictures };
  let html = blocks(lines.slice(from), offset + from, ctx, 0);
  if (clipped) html += '<p class="md-more">Open the note to read the rest.</p>';
  return html;
}

function blocks(L, base, ctx, depth) {
  let out = "";
  let i = 0;
  const n = L.length;
  while (i < n) {
    const line = L[i];
    if (!line.trim()) { i++; continue; }

    let m = FENCE.exec(line);
    if (m) {
      const close = new RegExp(`^\\s{0,3}${m[1][0] === "`" ? "`" : "~"}{${m[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < n && !close.test(L[i])) body.push(L[i++]);
      i++;
      const lang = m[2] ? ` data-lang="${esc(m[2].toLowerCase())}"` : "";
      out += `<pre class="md-pre"${lang}><code>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }

    if (line.trim() === "$$") {
      const body = [];
      i++;
      while (i < n && L[i].trim() !== "$$") body.push(L[i++]);
      i++;
      out += `<pre class="md-pre md-math"><code>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }

    m = HEAD.exec(line);
    if (m) {
      const lv = m[1].length;
      out += `<h${lv} class="md-h">${inline(m[2], ctx)}</h${lv}>`;
      i++;
      continue;
    }

    if (HR.test(line)) { out += '<hr class="md-hr">'; i++; continue; }

    if (QUOTE.test(line)) {
      const start = i;
      const seg = [];
      while (i < n && QUOTE.test(L[i])) seg.push(L[i++].replace(/^\s{0,3}> ?/, ""));
      const cm = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(seg[0]);
      if (cm && depth < 8) {
        const raw = cm[1].toLowerCase();
        const kind = CALLOUT_ALIAS[raw] || raw;
        const title = cm[3].trim() || raw.charAt(0).toUpperCase() + raw.slice(1);
        out += `<div class="md-callout" data-kind="${esc(kind)}"><div class="md-callout-t">${inline(title, ctx)}</div>` +
          blocks(seg.slice(1), base + start + 1, ctx, depth + 1) + "</div>";
      } else {
        out += `<blockquote class="md-q">${depth < 8 ? blocks(seg, base + start, ctx, depth + 1) : esc(seg.join(" "))}</blockquote>`;
      }
      continue;
    }

    if (line.includes("|") && i + 1 < n && TABLE_SEP.test(L[i + 1])) {
      const cells = (row) => {
        let r = row.trim();
        if (r.startsWith("|")) r = r.slice(1);
        if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
        return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      };
      const head = cells(line);
      const align = cells(L[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
      const al = (j) => (align[j] ? ` style="text-align:${align[j]}"` : "");
      let t = '<div class="md-table"><table><thead><tr>' + head.map((c, j) => `<th${al(j)}>${inline(c, ctx)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < n && L[i].trim() && L[i].includes("|")) {
        const row = cells(L[i++]);
        t += "<tr>" + head.map((_, j) => `<td${al(j)}>${inline(row[j] || "", ctx)}</td>`).join("") + "</tr>";
      }
      out += t + "</tbody></table></div>";
      continue;
    }

    if (LIST.test(line)) {
      const r = list(L, i, base, ctx);
      out += r.html;
      i = r.end;
      continue;
    }

    const para = [L[i++]];
    while (i < n && L[i].trim() && !isBlockStart(L[i], L[i + 1])) para.push(L[i++]);
    out += "<p>" + para.map((l) => inline(l.trim(), ctx)).join("<br>") + "</p>";
  }
  return out;
}

function list(L, i, base, ctx) {
  const items = [];
  const n = L.length;
  while (i < n) {
    const line = L[i];
    const m = LIST.exec(line);
    if (m) {
      let text = m[3];
      let task = null;
      const tm = /^\[([ xX/\-])\](?:\s+|$)(.*)$/.exec(text);
      if (tm) { task = tm[1]; text = tm[2]; }
      items.push({
        indent: m[1].replace(/\t/g, "    ").length,
        ordered: /\d/.test(m[2][0]),
        start: parseInt(m[2], 10) || 1,
        task,
        text,
        line: base + i,
        more: [],
      });
      i++;
      continue;
    }
    if (!line.trim()) {
      let j = i + 1;
      while (j < n && !L[j].trim()) j++;
      if (j < n && LIST.test(L[j])) { i = j; continue; }
      break;
    }
    if (items.length && !isBlockStart(line, L[i + 1])) {
      items[items.length - 1].more.push(line.trim());
      i++;
      continue;
    }
    break;
  }

  let html = "";
  const stack = [];
  for (const it of items) {
    const tag = it.ordered ? "ol" : "ul";
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      html += `<${tag} class="md-list"${it.ordered && it.start !== 1 ? ` start="${it.start}"` : ""}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      html += "</li>";
      if (top.tag !== tag) {
        html += `</${stack.pop().tag}><${tag} class="md-list">`;
        stack.push({ indent: it.indent, tag });
      }
    }
    if (it.task != null) {
      const done = it.task !== " ";
      html += `<li class="md-task${done ? " is-done" : ""}"><span class="md-cb" role="checkbox" aria-checked="${done}" data-line="${it.line}"></span>`;
    } else {
      html += "<li>";
    }
    html += inline(it.text, ctx) + it.more.map((x) => "<br>" + inline(x, ctx)).join("");
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return { html, end: i };
}

const EMBED_RE = /!\[\[([^\[\]\n]+?)\]\]/g;
const MD_IMG_RE = /!\[([^\]\n]*)\]\(\s*<?([^()\s<>\u0000]+(?:\([^()\s\u0000]*\))?)>?(?:\s+"[^"\n]*")?\s*\)/g;
const MD_LINK_RE = /\[([^\]\n]+)\]\(\s*<?([^()\s<>\u0000]+(?:\([^()\s\u0000]*\))?)>?(?:\s+"[^"\n]*")?\s*\)/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"\u0000]*[^\s<>"\u0000.,;:!?'")\]]/g;

/** A picture: one on the web waits for a click (loading it tells its site who opened the note), unless ctx.webPictures. */
function imgHtml(src, alt, ctx, w = 0) {
  if (isWebPicture(src) && !ctx.webPictures) {
    let host = ""; try { host = new URL(src).host; } catch {}
    return `<button class="md-img-load" data-src="${esc(src)}" data-alt="${esc(alt)}" title="A picture on the web - loading it lets ${esc(host)} see that this was opened">Load picture from ${esc(host)}</button>`;
  }
  return `<img class="md-img" src="${esc(src)}" alt="${esc(alt)}"${w ? ` width="${w}"` : ""} loading="lazy" decoding="async" draggable="false">`;
}

function safeSrc(url) {
  const u = String(url || "").trim();
  return u && !/^\s*(javascript|vbscript):/i.test(u) ? u : "";
}

function wikiHtml(target, heading, alias, ctx, embed) {
  const t = target.trim();
  const path = ctx.resolve ? ctx.resolve(t) : null;
  const sub = heading && heading.length > 1 ? heading : "";
  const label = alias != null && alias.trim() ? alias.trim() : t + (sub ? " › " + sub.slice(1) : "");
  return `<a class="md-wl${path ? "" : " is-missing"}${embed ? " is-embed" : ""}" data-target="${esc(t)}"${sub ? ` data-sub="${esc(sub)}"` : ""}>${esc(label)}</a>`;
}

function embedHtml(inner, ctx) {
  const [rawTarget, alias] = inner.split("|");
  const hash = rawTarget.indexOf("#");
  const target = (hash >= 0 ? rawTarget.slice(0, hash) : rawTarget).trim();
  if (IMAGE_RE.test(target)) {
    const url = ctx.image ? safeSrc(ctx.image(target)) : "";
    const w = alias && /^\d+(x\d+)?$/.test(alias.trim()) ? parseInt(alias, 10) : 0;
    if (url) return imgHtml(url, target, ctx, w);
    return `<span class="md-img-missing">${esc(target)}</span>`;
  }
  return wikiHtml(target, hash >= 0 ? rawTarget.slice(hash) : "", alias, ctx, true);
}

/** Inline Markdown on one line of raw text. */
export function inline(s, ctx = {}) {
  const slots = [];
  const put = (html) => "\u0000" + (slots.push(html) - 1) + "\u0000";
  // a trailing ^block-id is an anchor, not text (Obsidian hides it too)
  s = String(s).replace(/\s\^[\w-]+\s*$/, "");
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => put(`<code class="md-code">${esc(code.trim() || code)}</code>`));
  s = s.replace(EMBED_RE, (_, inner) => put(embedHtml(inner, ctx)));
  WIKI_RE.lastIndex = 0;
  s = s.replace(WIKI_RE, (_, target, heading, alias) => put(wikiHtml(target, heading, alias, ctx, false)));
  s = s.replace(MD_IMG_RE, (_, alt, url) => {
    let target = url;
    try { target = decodeURIComponent(url); } catch {}
    const src = ctx.image ? safeSrc(ctx.image(target)) : "";
    return put(src
      ? imgHtml(src, alt, ctx)
      : `<span class="md-img-missing">${esc(alt || target)}</span>`);
  });
  s = s.replace(MD_LINK_RE, (_, label, url) => put(`<a class="md-a" data-href="${esc(url)}">${inline(label, ctx)}</a>`));
  s = s.replace(BARE_URL_RE, (url) => put(`<a class="md-a" data-href="${esc(url)}">${esc(url)}</a>`));
  TAG_RE.lastIndex = 0;
  s = s.replace(TAG_RE, (whole, pre, name) => (isTagName(name) ? pre + put(`<span class="md-tag" data-tag="${esc(name)}">#${esc(name)}</span>`) : whole));
  s = esc(s)
    .replace(/\*\*(?=\S)([^<>]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w_])__(?=\S)([^<>]*?\S)__(?![\w_])/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*<>]*?[^\s*<>])\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_(?=[^\s_])([^_<>]*?[^\s_<>])_(?![\w_])/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([^<>]*?\S)~~/g, "<del>$1</del>")
    .replace(/==(?=\S)([^<>]*?\S)==/g, '<mark class="md-mark">$1</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => slots[+k]);
}
