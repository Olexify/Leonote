// Geometry for Draw and Studio: symmetry, drawing guides, crop and canvas
// maths, export templates. Pure — no DOM, no canvas — so it runs under
// `node --test`, which matters because every one of these is a place where an
// off-by-one shows up as a picture that is one pixel wrong for ever.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ── symmetry ────────────────────────────────────────────────────────────── */

export const SYMMETRY_MODES = [
  { id: "none", name: "Off" },
  { id: "vertical", name: "Mirror left / right" },
  { id: "horizontal", name: "Mirror top / bottom" },
  { id: "quad", name: "Four-way" },
  { id: "radial", name: "Radial" },
  { id: "mandala", name: "Radial, mirrored" },
];

/**
 * Every place one stamp lands under a symmetry: `[{ x, y, flip, angle }]`,
 * the original first. `flip` says the copy is a mirror image (so a textured
 * tip is mirrored too) and `angle` how far it has been turned.
 */
export function symmetryPoints(sym, x, y, out = []) {
  out.length = 0;
  out.push({ x, y, flip: false, angle: 0 });
  if (!sym || sym.mode === "none" || !sym.mode) return out;
  const cx = sym.cx;
  const cy = sym.cy;
  if (sym.mode === "vertical") out.push({ x: 2 * cx - x, y, flip: true, angle: 0 });
  else if (sym.mode === "horizontal") out.push({ x, y: 2 * cy - y, flip: true, angle: Math.PI });
  else if (sym.mode === "quad") {
    out.push({ x: 2 * cx - x, y, flip: true, angle: 0 }, { x, y: 2 * cy - y, flip: true, angle: Math.PI }, { x: 2 * cx - x, y: 2 * cy - y, flip: false, angle: Math.PI });
  } else {
    const n = clamp(Math.round(sym.count || 6), 2, 32);
    const dx = x - cx;
    const dy = y - cy;
    for (let i = 0; i < n; i++) {
      const a = (i * Math.PI * 2) / n;
      const c = Math.cos(a);
      const s = Math.sin(a);
      if (i > 0) out.push({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c, flip: false, angle: a });
      if (sym.mode === "mandala") out.push({ x: cx + dx * c + dy * s, y: cy + dx * s - dy * c, flip: true, angle: a });
    }
  }
  return out;
}

/* ── drawing guides ──────────────────────────────────────────────────────── */

// Clip Studio calls these "special rulers": while one is on, a stroke is held
// to the direction the guide allows, decided by the way you first move.
export const GUIDE_KINDS = [
  { id: "none", name: "Free" },
  { id: "line", name: "Straight lines" },
  { id: "parallel", name: "Parallel lines" },
  { id: "grid", name: "Horizontal and vertical" },
  { id: "iso", name: "Isometric (30°)" },
  { id: "vanish", name: "Vanishing point" },
  { id: "vanish2", name: "Two-point perspective" },
  { id: "circle", name: "Concentric circles" },
];

const project = (px, py, ox, oy, ux, uy) => {
  const t = (px - ox) * ux + (py - oy) * uy;
  return { x: ox + ux * t, y: oy + uy * t };
};

/**
 * The direction a stroke is locked to: worked out once, when the pen has
 * moved far enough from where it went down to show an intent. Returns null
 * until then (the stroke is held at the start meanwhile).
 */
export function guideLock(guide, start, p, minDist = 6) {
  if (!guide || guide.kind === "none") return null;
  const dx = p.x - start.x;
  const dy = p.y - start.y;
  const d = Math.hypot(dx, dy);
  if (guide.kind === "circle") return { kind: "circle", cx: guide.cx, cy: guide.cy, r: Math.hypot(start.x - guide.cx, start.y - guide.cy) };
  if (d < minDist) return null;
  const dirs = [];
  if (guide.kind === "line") return { kind: "dir", ox: start.x, oy: start.y, ux: dx / d, uy: dy / d, free: true };
  if (guide.kind === "parallel") dirs.push(guide.angle || 0);
  if (guide.kind === "grid") dirs.push(0, Math.PI / 2);
  if (guide.kind === "iso") dirs.push(Math.PI / 6, -Math.PI / 6, Math.PI / 2);
  if (guide.kind === "vanish" || guide.kind === "vanish2") {
    dirs.push(Math.atan2(guide.cy - start.y, guide.cx - start.x));
    if (guide.kind === "vanish2") dirs.push(Math.atan2(guide.cy2 - start.y, guide.cx2 - start.x), Math.PI / 2);
    else dirs.push(0, Math.PI / 2);
  }
  let best = null;
  for (const a of dirs) {
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const along = Math.abs(dx * ux + dy * uy) / d; // 1 = exactly that way
    if (!best || along > best.along) best = { along, ux, uy };
  }
  return best ? { kind: "dir", ox: start.x, oy: start.y, ux: best.ux, uy: best.uy } : null;
}

/** A point, held to a lock from `guideLock`. */
export function guideSnap(lock, p) {
  if (!lock) return p;
  if (lock.kind === "circle") {
    const dx = p.x - lock.cx;
    const dy = p.y - lock.cy;
    const d = Math.hypot(dx, dy) || 1;
    return { x: lock.cx + (dx / d) * lock.r, y: lock.cy + (dy / d) * lock.r };
  }
  if (lock.free) {
    // a straight-line guide follows the pen's angle until the stroke ends
    const dx = p.x - lock.ox;
    const dy = p.y - lock.oy;
    const d = Math.hypot(dx, dy) || 1;
    return project(p.x, p.y, lock.ox, lock.oy, dx / d, dy / d);
  }
  return project(p.x, p.y, lock.ox, lock.oy, lock.ux, lock.uy);
}

/** Angles snap to 15° while Shift is held, the way every shape tool does it. */
export function snapAngle(x0, y0, x1, y1, step = Math.PI / 12) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const a = Math.round(Math.atan2(y1 - y0, x1 - x0) / step) * step;
  return { x: x0 + Math.cos(a) * d, y: y0 + Math.sin(a) * d };
}

/**
 * "Hold to straighten": if the points of a finished stroke lie close to the
 * line between its ends, that line; otherwise null. `tolerance` is a fraction
 * of the stroke's length.
 */
export function straightLine(points, tolerance = 0.06) {
  if (!points || points.length < 3) return null;
  const a = points[0];
  const b = points[points.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 24) return null;
  let worst = 0;
  let path = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    path += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
    const d = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x) / len;
    if (d > worst) worst = d;
  }
  if (worst > len * tolerance || path > len * 1.25) return null;
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

/** The same idea for an ellipse: a closed, roundish stroke becomes a clean one. */
export function cleanEllipse(points, tolerance = 0.14) {
  if (!points || points.length < 12) return null;
  const a = points[0];
  const b = points[points.length - 1];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  if (rx < 12 || ry < 12) return null;
  if (Math.hypot(b.x - a.x, b.y - a.y) > Math.max(rx, ry) * 0.5) return null; // not closed
  const cx = x0 + rx;
  const cy = y0 + ry;
  let err = 0;
  for (const p of points) err += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
  if (err / points.length > tolerance) return null;
  return { cx, cy, rx, ry };
}

/* ── crop and canvas size ────────────────────────────────────────────────── */

export const CROP_RATIOS = [
  { id: "free", name: "Free", r: 0 },
  { id: "orig", name: "Original", r: -1 },
  { id: "1:1", name: "1 : 1", r: 1 },
  { id: "4:5", name: "4 : 5", r: 4 / 5 },
  { id: "5:4", name: "5 : 4", r: 5 / 4 },
  { id: "3:2", name: "3 : 2", r: 3 / 2 },
  { id: "2:3", name: "2 : 3", r: 2 / 3 },
  { id: "4:3", name: "4 : 3", r: 4 / 3 },
  { id: "3:4", name: "3 : 4", r: 3 / 4 },
  { id: "16:9", name: "16 : 9", r: 16 / 9 },
  { id: "9:16", name: "9 : 16", r: 9 / 16 },
  { id: "2:1", name: "2 : 1", r: 2 },
  { id: "3:1", name: "3 : 1", r: 3 },
];

/** A rectangle with positive size, whole pixels, inside (or partly outside) a canvas. */
export function normRect(r) {
  const x = Math.round(Math.min(r.x, r.x + r.w));
  const y = Math.round(Math.min(r.y, r.y + r.h));
  return { x, y, w: Math.max(1, Math.round(Math.abs(r.w))), h: Math.max(1, Math.round(Math.abs(r.h))) };
}

/**
 * Drag a crop handle. `handle` is one of n s e w ne nw se sw or "move";
 * `ratio` (w / h) holds the shape when it is set. The rectangle never turns
 * inside out and never gets smaller than `min`.
 */
export function dragCrop(rect, handle, dx, dy, { ratio = 0, min = 8, bounds = null } = {}) {
  let { x, y, w, h } = rect;
  if (handle === "move") {
    x += dx; y += dy;
    if (bounds) { x = clamp(x, bounds.x, bounds.x + bounds.w - w); y = clamp(y, bounds.y, bounds.y + bounds.h - h); }
    return { x, y, w, h };
  }
  let x1 = x + w;
  let y1 = y + h;
  if (handle.includes("w")) x = Math.min(x + dx, x1 - min);
  if (handle.includes("e")) x1 = Math.max(x1 + dx, x + min);
  if (handle.includes("n")) y = Math.min(y + dy, y1 - min);
  if (handle.includes("s")) y1 = Math.max(y1 + dy, y + min);
  if (bounds) {
    x = Math.max(bounds.x, x); y = Math.max(bounds.y, y);
    x1 = Math.min(bounds.x + bounds.w, x1); y1 = Math.min(bounds.y + bounds.h, y1);
  }
  w = x1 - x;
  h = y1 - y;
  if (ratio > 0) {
    // the side being dragged decides; the other follows, anchored at the
    // opposite corner or the middle of the opposite edge
    const horizontal = handle === "e" || handle === "w";
    const vertical = handle === "n" || handle === "s";
    let nw = w;
    let nh = h;
    if (horizontal) nh = w / ratio;
    else if (vertical) nw = h * ratio;
    else if (w / h > ratio) nw = h * ratio;
    else nh = w / ratio;
    if (bounds) {
      const k = Math.min(1, bounds.w / nw, bounds.h / nh);
      nw *= k; nh *= k;
    }
    if (horizontal) y = y + (h - nh) / 2;
    else if (handle.includes("n")) y = y1 - nh;
    if (vertical) x = x + (w - nw) / 2;
    else if (handle.includes("w")) x = x1 - nw;
    w = nw;
    h = nh;
    if (bounds) { x = clamp(x, bounds.x, bounds.x + bounds.w - w); y = clamp(y, bounds.y, bounds.y + bounds.h - h); }
  }
  return { x, y, w, h };
}

/** The biggest rectangle of a given shape that fits a canvas, centred. */
export function fitRatio(width, height, ratio) {
  if (!(ratio > 0)) return { x: 0, y: 0, w: width, h: height };
  let w = width;
  let h = w / ratio;
  if (h > height) { h = height; w = h * ratio; }
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/**
 * Where the old picture goes when the canvas changes size, for a 3 × 3 anchor
 * ("nw", "n", … "c" … "se"). Returns the offset to draw the old bitmap at.
 */
export function anchorOffset(oldW, oldH, newW, newH, anchor = "c") {
  const a = String(anchor);
  const fx = a.includes("w") ? 0 : a.includes("e") ? 1 : 0.5;
  const fy = a.includes("n") ? 0 : a.includes("s") ? 1 : 0.5;
  return { x: Math.round((newW - oldW) * fx), y: Math.round((newH - oldH) * fy) };
}

/** Width and height that keep a shape, given one of them. */
export function keepAspect(w, h, { width = null, height = null } = {}) {
  if (width != null) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round((width * h) / w)) };
  if (height != null) return { width: Math.max(1, Math.round((height * w) / h)), height: Math.max(1, Math.round(height)) };
  return { width: w, height: h };
}

/** Pixels to a physical length and back, for the size dialogs. */
export const UNITS = [
  { id: "px", name: "px", perInch: null },
  { id: "mm", name: "mm", perInch: 25.4 },
  { id: "cm", name: "cm", perInch: 2.54 },
  { id: "in", name: "in", perInch: 1 },
];
export function pxToUnit(px, unit, dpi) {
  const u = UNITS.find((x) => x.id === unit);
  if (!u || !u.perInch) return px;
  return (px / (dpi || 72)) * u.perInch;
}
export function unitToPx(v, unit, dpi) {
  const u = UNITS.find((x) => x.id === unit);
  if (!u || !u.perInch) return Math.round(v);
  return Math.round((v / u.perInch) * (dpi || 72));
}

/* ── export templates ────────────────────────────────────────────────────── */

export const EXPORT_TEMPLATES = [
  { group: "Instagram", items: [
    { id: "ig-square", name: "Post · square", w: 1080, h: 1080 },
    { id: "ig-portrait", name: "Post · portrait 4:5", w: 1080, h: 1350 },
    { id: "ig-landscape", name: "Post · landscape", w: 1080, h: 566 },
    { id: "ig-story", name: "Story / Reel", w: 1080, h: 1920 },
    { id: "ig-avatar", name: "Profile picture", w: 320, h: 320 },
  ] },
  { group: "YouTube", items: [
    { id: "yt-thumb", name: "Thumbnail", w: 1280, h: 720, maxBytes: 2 * 1024 * 1024 },
    { id: "yt-banner", name: "Channel banner", w: 2560, h: 1440, maxBytes: 6 * 1024 * 1024 },
    { id: "yt-avatar", name: "Channel picture", w: 800, h: 800 },
  ] },
  { group: "X / Twitter", items: [
    { id: "x-post", name: "Post image", w: 1600, h: 900 },
    { id: "x-header", name: "Header", w: 1500, h: 500 },
    { id: "x-avatar", name: "Profile picture", w: 400, h: 400 },
  ] },
  { group: "Facebook / LinkedIn", items: [
    { id: "fb-post", name: "Facebook post", w: 1200, h: 630 },
    { id: "fb-cover", name: "Facebook cover", w: 1640, h: 924 },
    { id: "li-post", name: "LinkedIn post", w: 1200, h: 627 },
    { id: "li-banner", name: "LinkedIn banner", w: 1584, h: 396 },
  ] },
  { group: "Other", items: [
    { id: "tiktok", name: "TikTok cover", w: 1080, h: 1920 },
    { id: "pin", name: "Pinterest pin", w: 1000, h: 1500 },
    { id: "twitch-panel", name: "Twitch panel", w: 320, h: 160 },
    { id: "discord-emoji", name: "Discord emoji", w: 128, h: 128, maxBytes: 256 * 1024 },
    { id: "og", name: "Link preview (Open Graph)", w: 1200, h: 630 },
    { id: "wallpaper-hd", name: "Wallpaper 1080p", w: 1920, h: 1080 },
    { id: "wallpaper-4k", name: "Wallpaper 4K", w: 3840, h: 2160 },
    { id: "favicon", name: "Icon 512", w: 512, h: 512 },
  ] },
];
export const EXPORT_TEMPLATE_BY_ID = new Map(EXPORT_TEMPLATES.flatMap((g) => g.items.map((t) => [t.id, { ...t, group: g.group }])));

export const FIT_MODES = [
  { id: "cover", name: "Fill", note: "covers the whole frame; the overflow is cropped" },
  { id: "contain", name: "Fit", note: "the whole picture, with bars of the background colour" },
  { id: "stretch", name: "Stretch", note: "squashed to the frame" },
];

/**
 * Where a `sw × sh` picture is drawn inside a `tw × th` frame: the destination
 * rectangle for drawImage. `focus` (0..1 each way) moves a "cover" crop off
 * centre, so a face at the top of a portrait is not cut off.
 */
export function fitInto(sw, sh, tw, th, mode = "cover", focus = { x: 0.5, y: 0.5 }) {
  if (mode === "stretch") return { x: 0, y: 0, w: tw, h: th };
  const k = mode === "contain" ? Math.min(tw / sw, th / sh) : Math.max(tw / sw, th / sh);
  const w = sw * k;
  const h = sh * k;
  const fx = mode === "contain" ? 0.5 : clamp(focus && Number.isFinite(focus.x) ? focus.x : 0.5, 0, 1);
  const fy = mode === "contain" ? 0.5 : clamp(focus && Number.isFinite(focus.y) ? focus.y : 0.5, 0, 1);
  return { x: (tw - w) * fx, y: (th - h) * fy, w, h };
}
