// Draw and Studio's renderer: layer bitmaps, the brush's hot path, masks,
// selections and compositing.
//
// Why 2D canvas and not WebGL2
// ----------------------------
// Measured on a 4000 × 4000 document in this app's own WebView2 (and in
// headless Chrome): a stamp is one `drawImage` of a pre-tinted tip, which the
// compositor already runs on the GPU, and a frame only ever touches the
// rectangle the stroke dirtied — so the per-frame cost is set by the dirty
// area, not the document size, and sits around 1–3 ms at any canvas size.
//
// Studio's adjustment layers looked like the thing that would force a second
// renderer. They did not: every adjustment is a lookup table or a colour
// matrix (paintadjust.js), both of which are SVG filter primitives, and a 2D
// canvas runs an SVG filter on the GPU (`ctx.filter = "url(#…)"`) — 7 ms for a
// whole 4000 × 4000 canvas, with no pixel ever read back. So there is still
// one renderer, no context to lose, and no second copy of every layer in
// texture memory.
//
// Two ways to composite
// ---------------------
//   plain    every layer is ordinary pixels with a blend mode. Drawn straight
//            into the target, no buffers — exactly what Draw always did.
//   studio   anything with a mask, a clip, a group or an adjustment. Rendered
//            through pooled buffers the size of the REGION being painted (the
//            visible part of the document at screen resolution, or one tile of
//            an export), so the cost follows what is on screen, not the size
//            of the document.
//
// Memory
// ------
//   layers   width × height × 4 bytes each; a mask costs the same as a layer
//   scratch  width × height × 4 — the live stroke, allocated on the first
//            stroke and released when the tab is hidden
//   pool     a handful of region-sized buffers, released when the tab is hidden
//   select   width × height × 4 while there is a selection
//
// The hot path (`stamp`) allocates nothing: tips are cached per
// tip/size/hardness/colour, and the stroke's bounding box is a reused object.

import * as D from "./paintdoc.js";
import * as B from "./paintbrush.js";
import * as A from "./paintadjust.js";
import * as G from "./paintgeom.js";
import { traceContours, hexLuma } from "./paintselect.js";
import { newBox, growBox, resetBox, boxEmpty, dirtyRect } from "./painthistory.js";

/**
 * How big one studio region is allowed to get before an export is cut into
 * tiles. Eight megapixels keeps the five buffers a region needs near 160 MB.
 */
const REGION_MAX_PX = 8 * 1024 * 1024;
const TILE = 2048;
/** The live stroke is merged through a buffer only up to this size (see compositePlain). */
const MERGE_MAX_PX = 4 * 1024 * 1024;
/** The marching ants are traced from a copy of the selection no bigger than this. */
const OUTLINE_MAX = 1024;

const makeCanvas = (w, h) => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

/** Free a canvas for real: on Windows/WebView2 a 64 MB bitmap lingers otherwise. */
export function releaseCanvas(c) {
  if (!c) return;
  c.width = 1;
  c.height = 1;
}

/* ── SVG filters for adjustments ─────────────────────────────────────────── */

// One hidden <svg> holds a <filter> per distinct set of parameters. A canvas
// resolves `url(#id)` against the document, so the filters have to live in it.
let filterHost = null;
const filterIds = new Map(); // key -> id
const filterOrder = [];
let filterSeq = 0;

function hostSvg() {
  if (filterHost && filterHost.isConnected) return filterHost;
  filterHost = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  filterHost.setAttribute("width", "0");
  filterHost.setAttribute("height", "0");
  filterHost.setAttribute("aria-hidden", "true");
  filterHost.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
  document.body.append(filterHost);
  filterIds.clear();
  filterOrder.length = 0;
  return filterHost;
}

/** The `ctx.filter` string for some SVG filter primitives, built once per key. */
export function svgFilter(key, markup, { pad = false } = {}) {
  const host = hostSvg();
  let id = filterIds.get(key);
  if (id) return `url(#${id})`;
  id = `ptf${(++filterSeq).toString(36)}`;
  const region = pad ? 'x="-10%" y="-10%" width="120%" height="120%"' : 'x="0" y="0" width="100%" height="100%"';
  host.insertAdjacentHTML("beforeend", `<filter id="${id}" color-interpolation-filters="sRGB" ${region}>${markup}</filter>`);
  filterIds.set(key, id);
  filterOrder.push(key);
  // a slider drag makes a new filter per step; only the recent ones matter
  while (filterOrder.length > 48) {
    const old = filterOrder.shift();
    const oid = filterIds.get(old);
    filterIds.delete(old);
    const el = oid && host.querySelector("#" + oid);
    if (el) el.remove();
  }
  return `url(#${id})`;
}

/** The filter for an adjustment, or null when it changes nothing. */
export function adjustFilter(adj) {
  const stages = A.stagesOf(adj);
  if (!stages.length) return null;
  return svgFilter("adj:" + A.adjustKey(adj), A.filterMarkup(stages));
}

/* ── the buffer pool ─────────────────────────────────────────────────────── */

class Pool {
  constructor() { this.free = []; this.out = 0; }

  /** A cleared buffer at least `w × h`, clipped to exactly that. */
  take(w, h) {
    w = Math.max(1, Math.ceil(w));
    h = Math.max(1, Math.ceil(h));
    let best = -1;
    for (let i = 0; i < this.free.length; i++) {
      const c = this.free[i].canvas;
      if (c.width >= w && c.height >= h && (best < 0 || c.width * c.height < this.free[best].canvas.width * this.free[best].canvas.height)) best = i;
    }
    let b;
    if (best >= 0) b = this.free.splice(best, 1)[0];
    else {
      // round up, so a region that grows by a pixel does not mean a new canvas
      const canvas = makeCanvas(Math.ceil(w / 256) * 256, Math.ceil(h / 256) * 256);
      b = { canvas, ctx: canvas.getContext("2d") };
    }
    b.w = w;
    b.h = h;
    const ctx = b.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.clearRect(0, 0, w, h);
    this.out++;
    return b;
  }

  give(b) {
    if (!b) return;
    b.ctx.restore();
    this.out--;
    this.free.push(b);
    while (this.free.length > 8) releaseCanvas(this.free.shift().canvas);
  }

  bytes() { return this.free.reduce((n, b) => n + b.canvas.width * b.canvas.height * 4, 0); }

  clear() {
    for (const b of this.free) releaseCanvas(b.canvas);
    this.free.length = 0;
  }
}

export class Engine {
  constructor(doc) {
    this.doc = doc;
    this.layers = new Map(); // id (or mask key) -> { canvas, ctx }
    for (const l of doc.layers) {
      if (D.hasPixels(l)) this.addLayerBitmap(l.id);
      if (l.mask) this.addMask(l.id);
    }
    this.scratch = null;
    this.scratchCtx = null;
    this.pool = new Pool();
    this.tips = new Map();
    this.tipOrder = [];
    this.view = { zoom: 1, angle: 0, cx: 0, cy: 0, width: doc.width, height: doc.height };
    this.selection = null; // { mask: canvas, box, path: Path2D (the outline) }
    this.box = newBox(); // the live stroke's dirty box, in document pixels
    this.allDirty = true;
    this.stroke = null;
    this.floating = null; // a lifted selection being moved/scaled/rotated
    this.symmetry = null; // { mode, cx, cy, count }
    this.symPts = [];
    this.preview = null; // { id, adjust } — an adjustment being edited, shown before it is kept
    this.quality = "medium";
    this.fxCache = new Map(); // layer id -> its styles drawn over the whole document (see fxImage)
    this.pixVer = 0; // bumped by the editor on every step, so a style knows its layer changed
  }

  /* ── surfaces: layer bitmaps and masks ────────────────────────────────── */

  addLayerBitmap(id, from = null) {
    const c = makeCanvas(this.doc.width, this.doc.height);
    const ctx = c.getContext("2d", { willReadFrequently: false });
    if (from) ctx.drawImage(from, 0, 0);
    this.layers.set(id, { canvas: c, ctx });
    return c;
  }

  dropLayerBitmap(id) {
    const l = this.layers.get(id);
    if (l) releaseCanvas(l.canvas);
    this.layers.delete(id);
  }

  bitmap(id) { return this.layers.get(id) || null; }
  /** A layer's pixels or, for a mask key, its mask. */
  surface(key) { return this.layers.get(key) || null; }
  mask(id) { return this.layers.get(D.maskKey(id)) || null; }

  /**
   * A mask is a bitmap whose ALPHA says how much of the layer shows: opaque
   * shows, clear hides. `reveal` starts it showing everything.
   */
  addMask(id, { reveal = true, from = null } = {}) {
    const key = D.maskKey(id);
    if (this.layers.has(key)) return this.layers.get(key).canvas;
    const c = this.addLayerBitmap(key, from);
    if (!from && reveal) {
      const ctx = this.layers.get(key).ctx;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }
    return c;
  }

  dropMask(id) { this.dropLayerBitmap(D.maskKey(id)); }

  /** Bytes this document currently holds. Shown in the status line. */
  memory() {
    const px = this.doc.width * this.doc.height;
    const layers = this.layers.size * px * 4;
    const scratch = this.scratch ? px * 4 : 0;
    const merge = this.pool.bytes() + (this.selection ? px * 4 : 0);
    let tips = 0;
    for (const t of this.tips.values()) tips += t.width * t.height * 4;
    return { layers, scratch, merge, tips, total: layers + scratch + merge + tips };
  }

  /** Everything big, gone. The editor calls this when the tab is hidden. */
  sleep() {
    releaseCanvas(this.scratch); this.scratch = null; this.scratchCtx = null;
    this.pool.clear();
    for (const c of this.tips.values()) releaseCanvas(c);
    this.tips.clear();
    this.tipOrder.length = 0;
    this.allDirty = true;
  }

  destroy() {
    this.sleep();
    for (const id of [...this.layers.keys()]) this.dropLayerBitmap(id);
    this.layers.clear();
    if (this.floating) { releaseCanvas(this.floating.canvas); this.floating = null; }
    if (this.selection) { releaseCanvas(this.selection.mask); this.selection = null; }
  }

  ensureScratch() {
    if (this.scratch && this.scratch.width === this.doc.width && this.scratch.height === this.doc.height) return this.scratchCtx;
    releaseCanvas(this.scratch);
    this.scratch = makeCanvas(this.doc.width, this.doc.height);
    this.scratchCtx = this.scratch.getContext("2d");
    return this.scratchCtx;
  }

  /* ── tips ─────────────────────────────────────────────────────────────── */

  /**
   * A tip, already tinted, at a power-of-two size. Cached: building one is a
   * per-pixel loop and must never happen inside a stroke.
   */
  tip(brush, colour) {
    const size = B.tipCacheSize(brush.size);
    const key = `${brush.tip}|${size}|${brush.hardness.toFixed(2)}|${colour}`;
    let c = this.tips.get(key);
    if (c) return c;
    const mask = B.tipMask(brush.tip, size, brush.hardness, hashSeed(key));
    c = makeCanvas(size, size);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(size, size);
    const [r, g, b] = parseHex(colour);
    const d = img.data;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = mask[i];
    }
    ctx.putImageData(img, 0, 0);
    this.tips.set(key, c);
    this.tipOrder.push(key);
    // a handful of tips is all anyone uses at once; anything older is a
    // colour or a size they have moved on from
    while (this.tipOrder.length > 12) {
      const old = this.tipOrder.shift();
      const gone = this.tips.get(old);
      if (gone) { releaseCanvas(gone); this.tips.delete(old); }
    }
    return c;
  }

  /* ── strokes ──────────────────────────────────────────────────────────── */

  /**
   * Start a stroke. Everything lands on the scratch canvas first, so opacity
   * applies to the stroke as a whole rather than piling up where it crosses
   * itself. `onMask` paints the layer's mask instead of its pixels: there the
   * colour's lightness is what counts — black hides, white shows.
   */
  beginStroke(layerId, brush, colour, x, y, pressure, tilt, { onMask = false } = {}) {
    const ctx = this.ensureScratch();
    ctx.globalCompositeOperation = "source-over";
    resetBox(this.box);
    const smudge = brush.blend === "smudge" && !onMask;
    this.stroke = {
      layerId, brush, colour,
      key: onMask ? D.maskKey(layerId) : layerId,
      onMask,
      luma: onMask ? (brush.blend === "erase" ? 0 : hexLuma(colour)) : 1,
      smudge,
      tipCanvas: this.tip(brush, brush.blend === "erase" || onMask || smudge ? "#000000" : colour),
      carry: 0,
      lastX: x, lastY: y,
      pressure, tilt,
      opacity: B.opacityAt(brush, pressure),
      rand: B.rng(((x * 7919) ^ (y * 104729) ^ Date.now()) >>> 0),
      jit: { dx: 0, dy: 0, scale: 1, angle: 0 },
      sim: {},
      stab: {},
      time: performance.now(),
      stamps: 0,
      backup: null,
    };
    // the stabiliser starts exactly where the pen went down: a brush that
    // lags on the very first dab feels broken
    this.stroke.stab.x = x;
    this.stroke.stab.y = y;
    this.stroke.smx = x;
    this.stroke.smy = y;
    if (smudge) {
      // smudging moves the layer's own pixels, so there is no scratch to
      // throw away: keep a copy to undo from (a GPU copy, not a readback)
      const bm = this.layers.get(layerId);
      if (bm) { this.stroke.backup = makeCanvas(this.doc.width, this.doc.height); this.stroke.backup.getContext("2d").drawImage(bm.canvas, 0, 0); }
      this.stroke.pick = makeCanvas(1, 1);
    } else {
      this.stampAt(x, y, pressure, tilt);
    }
    return this.stroke;
  }

  /** One pointer sample. Returns the document-space box dirtied this call. */
  strokeTo(x, y, pressure, tilt, simulate) {
    const s = this.stroke;
    if (!s) return null;
    const b = s.brush;
    const stab = B.stabilise(s.stab, x, y, b.smoothing);
    const nx = stab.x;
    const ny = stab.y;
    const dx = nx - s.lastX;
    const dy = ny - s.lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.01) return null;
    const now = performance.now();
    let p = pressure;
    if (simulate) p = B.simulatedPressure(s.sim, dist, now - s.time);
    s.time = now;
    const p0 = s.pressure;
    const diameter = B.sizeAt(b, (p0 + p) / 2, tilt);
    const step = s.smudge ? Math.max(1, diameter * 0.12) : B.stepFor(b, diameter);
    const self = this;
    s.carry = B.walkSegment(s.lastX, s.lastY, nx, ny, step, s.carry, (sx, sy, t) => {
      // a smudge carries paint from where the LAST dab landed, not from where
      // the pointer's last sample happened to be: otherwise the paint lags
      // further behind the brush with every sample
      if (s.smudge) { self.smudgeAt(s.smx, s.smy, sx, sy, p0 + (p - p0) * t, tilt); s.smx = sx; s.smy = sy; }
      else self.stampAt(sx, sy, p0 + (p - p0) * t, tilt);
    });
    s.lastX = nx;
    s.lastY = ny;
    s.pressure = p;
    s.tilt = tilt;
    return this.box;
  }

  /** One stamp. The hot path: no allocation, one drawImage (per mirror). */
  stampAt(x, y, pressure, tilt) {
    const s = this.stroke;
    const b = s.brush;
    const ctx = this.scratchCtx;
    const d = B.sizeAt(b, pressure, tilt);
    const jit = B.jitterStamp(b, s.rand, d, s.jit);
    const size = d * jit.scale;
    const r = size / 2;
    ctx.globalAlpha = B.flowAt(b, pressure, tilt);
    const sym = this.symmetry && this.symmetry.mode !== "none" ? this.symmetry : null;
    if (!sym) {
      const px = x + jit.dx;
      const py = y + jit.dy;
      if (jit.angle) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(jit.angle);
        ctx.drawImage(s.tipCanvas, -r, -r, size, size);
        ctx.restore();
      } else {
        ctx.drawImage(s.tipCanvas, px - r, py - r, size, size);
      }
      growBox(this.box, px, py, r + 1);
    } else {
      const pts = G.symmetryPoints(sym, x + jit.dx, y + jit.dy, this.symPts);
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i];
        if (jit.angle || q.flip || q.angle) {
          ctx.save();
          ctx.translate(q.x, q.y);
          ctx.rotate(q.angle + (q.flip ? -jit.angle : jit.angle));
          if (q.flip) ctx.scale(-1, 1);
          ctx.drawImage(s.tipCanvas, -r, -r, size, size);
          ctx.restore();
        } else {
          ctx.drawImage(s.tipCanvas, q.x - r, q.y - r, size, size);
        }
        growBox(this.box, q.x, q.y, r + 1);
      }
    }
    s.stamps++;
  }

  /**
   * One step of a smudge: pick up what is under the tip where it was, and lay
   * it down where it is now, shaped by the tip and thinned by the strength.
   */
  smudgeAt(fx, fy, tx, ty, pressure, tilt) {
    const s = this.stroke;
    const bm = this.layers.get(s.layerId);
    if (!bm) return;
    const b = s.brush;
    const d = Math.max(2, B.sizeAt(b, pressure, tilt));
    const size = Math.ceil(d);
    const r = size / 2;
    const pick = s.pick;
    if (pick.width !== size) { pick.width = size; pick.height = size; }
    const pc = pick.getContext("2d");
    pc.globalCompositeOperation = "copy";
    pc.globalAlpha = 1;
    pc.drawImage(bm.canvas, Math.round(fx - r), Math.round(fy - r), size, size, 0, 0, size, size);
    pc.globalCompositeOperation = "destination-in";
    pc.drawImage(s.tipCanvas, 0, 0, size, size);
    const layer = this.doc.layers.find((l) => l.id === s.layerId);
    bm.ctx.save();
    // a smudge has one strength, the brush's opacity; flow is for laying paint down, and
    // an airbrush's 6% flow would make a smudge that does nothing
    bm.ctx.globalAlpha = Math.min(1, s.opacity);
    bm.ctx.globalCompositeOperation = layer && layer.alphaLock ? "source-atop" : "source-over";
    bm.ctx.drawImage(pick, Math.round(tx - r), Math.round(ty - r));
    bm.ctx.restore();
    growBox(this.box, tx, ty, r + 2);
    s.stamps++;
  }

  /** A straight run of stamps, for the line and shape tools and "hold to straighten". */
  strokeLine(x0, y0, x1, y1, pressure = 0.7) {
    const s = this.stroke;
    if (!s) return;
    const b = s.brush;
    const step = B.stepFor(b, B.sizeAt(b, pressure, 0));
    const self = this;
    s.carry = B.walkSegment(x0, y0, x1, y1, step, s.carry, (sx, sy) => self.stampAt(sx, sy, pressure, 0));
    s.lastX = x1;
    s.lastY = y1;
  }

  /** Wipe the live stroke but keep it going — a shape being dragged redraws every move. */
  restartStroke() {
    const s = this.stroke;
    if (!s || !this.scratchCtx) return;
    const rect = dirtyRect({ x0: this.box.x0, y0: this.box.y0, x1: this.box.x1, y1: this.box.y1 }, this.doc.width, this.doc.height);
    if (rect) this.scratchCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
    resetBox(this.box);
    s.carry = 0;
    s.stamps = 0;
    return rect;
  }

  /** The stroke's pixels over a rectangle, cut to the selection: a pooled buffer. */
  strokePatch(rect) {
    const patch = this.pool.take(rect.w, rect.h);
    patch.ctx.drawImage(this.scratch, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    if (this.selection) {
      patch.ctx.globalCompositeOperation = "destination-in";
      patch.ctx.drawImage(this.selection.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      patch.ctx.globalCompositeOperation = "source-over";
    }
    return patch;
  }

  /** Put a patch onto a surface the way this stroke means it. */
  landStroke(ctx, s, layer, patch, x, y, w, h) {
    ctx.save();
    if (s.onMask) {
      // mask = mask·(1 − a) + luma·a, with `a` the stroke's coverage
      ctx.globalAlpha = s.opacity;
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(patch.canvas, 0, 0, w, h, x, y, w, h);
      if (s.luma > 0.004) {
        ctx.globalAlpha = s.opacity * s.luma;
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(patch.canvas, 0, 0, w, h, x, y, w, h);
      }
    } else {
      ctx.globalAlpha = s.opacity;
      ctx.globalCompositeOperation = compositeFor(s.brush, layer);
      ctx.drawImage(patch.canvas, 0, 0, w, h, x, y, w, h);
    }
    ctx.restore();
  }

  /**
   * Put the finished stroke onto its layer and clear the scratch.
   * Returns { key, rect, before } — the surface, the rectangle that changed
   * and the pixels that were there, ready for the undo stack — or null if
   * nothing was drawn.
   */
  endStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (!s || boxEmpty(this.box)) { if (s && s.backup) releaseCanvas(s.backup); return null; }
    const rect = dirtyRect({ x0: this.box.x0, y0: this.box.y0, x1: this.box.x1, y1: this.box.y1 }, this.doc.width, this.doc.height);
    if (!rect) return null;
    const layer = this.doc.layers.find((l) => l.id === s.layerId);
    const bm = this.layers.get(s.key);
    if (!bm) return null;
    if (s.smudge) {
      // the layer already changed; the "before" comes from the copy
      const before = s.backup ? s.backup.getContext("2d").getImageData(rect.x, rect.y, rect.w, rect.h) : null;
      if (this.selection && s.backup) {
        // outside the selection nothing may move: put those pixels back
        const keep = this.pool.take(rect.w, rect.h);
        keep.ctx.drawImage(s.backup, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        keep.ctx.globalCompositeOperation = "destination-out";
        keep.ctx.drawImage(this.selection.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        bm.ctx.save();
        bm.ctx.globalCompositeOperation = "destination-in";
        bm.ctx.beginPath();
        bm.ctx.rect(rect.x, rect.y, rect.w, rect.h);
        bm.ctx.clip();
        bm.ctx.drawImage(this.selection.mask, 0, 0);
        bm.ctx.globalCompositeOperation = "source-over";
        bm.ctx.drawImage(keep.canvas, 0, 0, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
        bm.ctx.restore();
        this.pool.give(keep);
      }
      releaseCanvas(s.backup);
      releaseCanvas(s.pick);
      this.markDirtyDoc(rect);
      return before ? { key: s.key, rect, before, stamps: s.stamps } : null;
    }
    const before = bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const patch = this.strokePatch(rect);
    this.landStroke(bm.ctx, s, layer, patch, rect.x, rect.y, rect.w, rect.h);
    this.pool.give(patch);
    this.scratchCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
    this.markDirtyDoc(rect);
    return { key: s.key, rect, before, stamps: s.stamps };
  }

  /** Throw the live stroke away (Escape, or the pointer left the window). */
  cancelStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    if (s.smudge && s.backup) {
      const bm = this.layers.get(s.layerId);
      if (bm) { bm.ctx.save(); bm.ctx.globalCompositeOperation = "copy"; bm.ctx.drawImage(s.backup, 0, 0); bm.ctx.restore(); }
      releaseCanvas(s.backup);
      releaseCanvas(s.pick);
      this.allDirty = true;
      return;
    }
    if (boxEmpty(this.box) || !this.scratchCtx) return;
    const rect = dirtyRect({ x0: this.box.x0, y0: this.box.y0, x1: this.box.x1, y1: this.box.y1 }, this.doc.width, this.doc.height);
    if (rect) { this.scratchCtx.clearRect(rect.x, rect.y, rect.w, rect.h); this.markDirtyDoc(rect); }
  }

  /* ── pixel operations ─────────────────────────────────────────────────── */

  /** Swap a rectangle of a surface with stored pixels — the undo primitive. */
  swapRegion(key, x, y, w, h, data) {
    const bm = this.layers.get(key);
    if (!bm) return data;
    const was = bm.ctx.getImageData(x, y, w, h);
    bm.ctx.putImageData(data, x, y);
    this.markDirtyDoc({ x, y, w, h });
    return was;
  }

  /** A whole-surface snapshot, for steps that can touch anything (filters, transforms). */
  snapshotLayer(key) {
    const bm = this.layers.get(key);
    if (!bm) return null;
    return { key, rect: { x: 0, y: 0, w: this.doc.width, h: this.doc.height }, before: bm.ctx.getImageData(0, 0, this.doc.width, this.doc.height) };
  }

  /** The colour under a point, composited — what the eyedropper should give you. */
  pick(x, y, layerOnly = null) {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.doc.width || py >= this.doc.height) return null;
    if (layerOnly) {
      const bm = this.layers.get(layerOnly);
      if (!bm) return null;
      const d = bm.ctx.getImageData(px, py, 1, 1).data;
      return d[3] === 0 ? null : rgbToHex(d[0], d[1], d[2]);
    }
    const one = makeCanvas(1, 1);
    const ctx = one.getContext("2d", { willReadFrequently: true });
    this.compositeInto(ctx, px, py, 1, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    releaseCanvas(one);
    return d[3] === 0 ? null : rgbToHex(d[0], d[1], d[2]);
  }

  /** The whole picture (or one layer) as bytes — for the wand, the bucket and the histogram. */
  readPixels({ layerId = null, scale = 1 } = {}) {
    const w = Math.max(1, Math.round(this.doc.width * scale));
    const h = Math.max(1, Math.round(this.doc.height * scale));
    const flat = makeCanvas(w, h);
    const fctx = flat.getContext("2d", { willReadFrequently: true });
    fctx.imageSmoothingQuality = "high";
    if (layerId) {
      const bm = this.layers.get(layerId);
      if (bm) fctx.drawImage(bm.canvas, 0, 0, w, h);
    } else {
      this.compositeInto(fctx, 0, 0, this.doc.width, this.doc.height, w / this.doc.width);
    }
    const data = fctx.getImageData(0, 0, w, h).data;
    releaseCanvas(flat);
    return { data, width: w, height: h };
  }

  /** Paint a coverage mask (bytes, one per pixel) through a colour onto a surface. */
  paintMask(key, mask, rect, colour, { alphaLock = false } = {}) {
    const bm = this.layers.get(key);
    if (!bm) return null;
    const w = this.doc.width;
    const before = bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const patch = this.pool.take(rect.w, rect.h);
    const img = patch.ctx.createImageData(rect.w, rect.h);
    const [r, g, b] = parseHex(colour);
    for (let yy = 0; yy < rect.h; yy++) {
      for (let xx = 0; xx < rect.w; xx++) {
        const m = mask[(yy + rect.y) * w + xx + rect.x];
        if (!m) continue;
        const p = (yy * rect.w + xx) * 4;
        img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = m;
      }
    }
    // putImageData ignores the clip and the selection, so it goes through a
    // second buffer and is composited from there
    const raw = makeCanvas(rect.w, rect.h);
    raw.getContext("2d").putImageData(img, 0, 0);
    patch.ctx.drawImage(raw, 0, 0);
    releaseCanvas(raw);
    if (this.selection) {
      patch.ctx.globalCompositeOperation = "destination-in";
      patch.ctx.drawImage(this.selection.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    }
    bm.ctx.save();
    if (alphaLock) bm.ctx.globalCompositeOperation = "source-atop";
    bm.ctx.drawImage(patch.canvas, 0, 0, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    bm.ctx.restore();
    this.pool.give(patch);
    this.markDirtyDoc(rect);
    return { key, rect, before };
  }

  /**
   * Bucket fill from a document point. Samples the composite (what you see) but
   * paints on one layer, which is what every other painting app does and what
   * makes filling line art on its own layer work at all.
   */
  fill(layerId, x, y, colour, { tolerance = 0.15, sampleAll = true, grow = 1 } = {}) {
    const w = this.doc.width;
    const h = this.doc.height;
    const bm = this.layers.get(layerId);
    if (!bm) return null;
    const src = sampleAll ? this.readPixels().data : bm.ctx.getImageData(0, 0, w, h).data;
    const { mask, box } = B.floodFill(src, w, h, Math.floor(x), Math.floor(y), tolerance);
    if (box.x1 < box.x0) return null;
    const grown = grow > 0 ? B.growMask(mask, w, h, grow) : mask;
    const x0 = Math.max(0, box.x0 - grow);
    const y0 = Math.max(0, box.y0 - grow);
    const rect = { x: x0, y: y0, w: Math.min(w, box.x1 + grow + 1) - x0, h: Math.min(h, box.y1 + grow + 1) - y0 };
    const layer = this.doc.layers.find((l) => l.id === layerId);
    const step = this.paintMask(layerId, grown, rect, colour, { alphaLock: !!(layer && layer.alphaLock) });
    return step ? { ...step, pixels: box.count } : null;
  }

  /** The rectangle an "everything selected, or everything" operation covers. */
  areaRect() {
    return this.selection ? clampRect(this.selection.box, this.doc) : { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
  }

  /** Flood the selection (or the whole surface) with one colour. */
  fillArea(key, colour) {
    const bm = this.layers.get(key);
    if (!bm) return null;
    const rect = this.areaRect();
    if (!rect) return null;
    const before = bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const layer = this.doc.layers.find((l) => l.id === key);
    bm.ctx.save();
    if (layer && layer.alphaLock) bm.ctx.globalCompositeOperation = "source-atop";
    if (this.selection) {
      const patch = this.pool.take(rect.w, rect.h);
      patch.ctx.drawImage(this.selection.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      patch.ctx.globalCompositeOperation = "source-in";
      patch.ctx.fillStyle = colour;
      patch.ctx.fillRect(0, 0, rect.w, rect.h);
      bm.ctx.drawImage(patch.canvas, 0, 0, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
      this.pool.give(patch);
    } else {
      bm.ctx.fillStyle = colour;
      bm.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    bm.ctx.restore();
    this.markDirtyDoc(rect);
    return { key, rect, before };
  }

  /** Clear the selection (or the whole surface). */
  clearArea(key) {
    const bm = this.layers.get(key);
    if (!bm) return null;
    const rect = this.areaRect();
    if (!rect) return null;
    const before = bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    if (this.selection) {
      bm.ctx.save();
      bm.ctx.globalCompositeOperation = "destination-out";
      bm.ctx.drawImage(this.selection.mask, 0, 0);
      bm.ctx.restore();
    } else {
      bm.ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    }
    this.markDirtyDoc(rect);
    return { key, rect, before };
  }

  /** A gradient between two document points, through the selection, onto a surface. */
  gradient(key, x0, y0, x1, y1, stops, { radial = false, opacity = 1, replace = false } = {}) {
    const bm = this.layers.get(key);
    if (!bm) return null;
    const rect = this.areaRect();
    if (!rect) return null;
    const before = bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const patch = this.pool.take(rect.w, rect.h);
    const pc = patch.ctx;
    const g = radial
      ? pc.createRadialGradient(x0 - rect.x, y0 - rect.y, 0, x0 - rect.x, y0 - rect.y, Math.max(1, Math.hypot(x1 - x0, y1 - y0)))
      : pc.createLinearGradient(x0 - rect.x, y0 - rect.y, x1 - rect.x, y1 - rect.y);
    for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.at)), s.colour);
    pc.fillStyle = g;
    pc.fillRect(0, 0, rect.w, rect.h);
    if (this.selection) {
      pc.globalCompositeOperation = "destination-in";
      pc.drawImage(this.selection.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    }
    const layer = this.doc.layers.find((l) => l.id === key);
    bm.ctx.save();
    if (replace) {
      // a mask is not painted over, it is set: clear what is there first
      bm.ctx.globalCompositeOperation = "destination-out";
      if (this.selection) bm.ctx.drawImage(this.selection.mask, 0, 0);
      else { bm.ctx.fillStyle = "#000"; bm.ctx.fillRect(rect.x, rect.y, rect.w, rect.h); }
      bm.ctx.globalCompositeOperation = "source-over";
    }
    bm.ctx.globalAlpha = opacity;
    if (layer && layer.alphaLock) bm.ctx.globalCompositeOperation = "source-atop";
    bm.ctx.drawImage(patch.canvas, 0, 0, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    bm.ctx.restore();
    this.pool.give(patch);
    this.markDirtyDoc(rect);
    return { key, rect, before };
  }

  /**
   * Run something over a surface's own pixels — a blur, a sharpen, an
   * adjustment applied for good. `draw(ctx, source)` paints the result;
   * the selection limits where it lands.
   */
  filterSurface(key, draw, { from = null, record = true } = {}) {
    const bm = this.layers.get(key);
    if (!bm) return null;
    const W = this.doc.width;
    const H = this.doc.height;
    const rect = this.areaRect();
    if (!rect) return null;
    // `from`: the untouched original, while a dialog previews one setting after
    // another. `record: false` skips the readback that an undo step needs.
    if (from && record) { bm.ctx.save(); bm.ctx.globalCompositeOperation = "copy"; bm.ctx.drawImage(from, 0, 0); bm.ctx.restore(); }
    const before = record ? bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h) : null;
    const src = makeCanvas(W, H);
    src.getContext("2d").drawImage(from || bm.canvas, 0, 0);
    const out = makeCanvas(W, H);
    const octx = out.getContext("2d");
    draw(octx, src, W, H);
    octx.filter = "none";
    octx.globalAlpha = 1;
    if (this.selection) {
      // result inside the selection, the original outside it: an exact blend
      octx.globalCompositeOperation = "destination-in";
      octx.drawImage(this.selection.mask, 0, 0);
      const sctx = src.getContext("2d");
      sctx.globalCompositeOperation = "destination-out";
      sctx.drawImage(this.selection.mask, 0, 0);
      octx.globalCompositeOperation = "lighter";
      octx.drawImage(src, 0, 0);
    }
    bm.ctx.save();
    bm.ctx.globalCompositeOperation = "copy";
    bm.ctx.drawImage(out, 0, 0);
    bm.ctx.restore();
    releaseCanvas(src);
    releaseCanvas(out);
    this.markDirtyDoc(rect);
    return { key, rect, before };
  }

  /** Merge a layer down onto the one below it, honouring blend, opacity and its mask. */
  mergeDown(id) {
    const top = D.layerOf(this.doc, id);
    const under = D.mergeTarget(this.doc, id);
    if (!top || !under) return null;
    const a = this.layers.get(top.id);
    const b = this.layers.get(under.id);
    if (!a || !b) return null;
    const W = this.doc.width;
    const H = this.doc.height;
    const before = b.ctx.getImageData(0, 0, W, H);
    let src = a.canvas;
    let tmp = null;
    const m = top.mask && top.maskOn !== false ? this.mask(top.id) : null;
    if (m) {
      tmp = makeCanvas(W, H);
      const t = tmp.getContext("2d");
      t.drawImage(a.canvas, 0, 0);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(m.canvas, 0, 0);
      src = tmp;
    }
    b.ctx.save();
    b.ctx.globalAlpha = top.opacity;
    b.ctx.globalCompositeOperation = D.blendOp(top.blend);
    b.ctx.drawImage(src, 0, 0);
    b.ctx.restore();
    releaseCanvas(tmp);
    this.allDirty = true;
    return { key: under.id, rect: { x: 0, y: 0, w: W, h: H }, before };
  }

  /* ── masks ────────────────────────────────────────────────────────────── */

  /** Fill a mask: everything shows, nothing shows, or exactly the selection shows. */
  fillMask(id, how = "reveal") {
    const m = this.mask(id);
    if (!m) return null;
    const W = this.doc.width;
    const H = this.doc.height;
    const before = m.ctx.getImageData(0, 0, W, H);
    m.ctx.save();
    m.ctx.globalCompositeOperation = "copy";
    if (how === "hide") {
      m.ctx.clearRect(0, 0, W, H);
    } else if (how === "selection" && this.selection) {
      m.ctx.drawImage(this.selection.mask, 0, 0);
    } else if (how === "selection-out" && this.selection) {
      m.ctx.fillStyle = "#000";
      m.ctx.fillRect(0, 0, W, H);
      m.ctx.globalCompositeOperation = "destination-out";
      m.ctx.drawImage(this.selection.mask, 0, 0);
    } else if (how === "invert") {
      const copy = makeCanvas(W, H);
      copy.getContext("2d").drawImage(m.canvas, 0, 0);
      m.ctx.fillStyle = "#000";
      m.ctx.fillRect(0, 0, W, H);
      m.ctx.globalCompositeOperation = "destination-out";
      m.ctx.drawImage(copy, 0, 0);
      releaseCanvas(copy);
    } else {
      m.ctx.fillStyle = "#000";
      m.ctx.fillRect(0, 0, W, H);
    }
    m.ctx.restore();
    this.allDirty = true;
    return { key: D.maskKey(id), rect: { x: 0, y: 0, w: W, h: H }, before };
  }

  /** Coverage bytes straight into a mask (background removal lands here). */
  setMaskFromBytes(id, bytes, width, height, { record = true } = {}) {
    const m = this.mask(id);
    if (!m) return null;
    const W = this.doc.width;
    const H = this.doc.height;
    const before = record ? m.ctx.getImageData(0, 0, W, H) : null;
    const small = bytesToCanvas(bytes, width, height);
    m.ctx.save();
    m.ctx.globalCompositeOperation = "copy";
    m.ctx.imageSmoothingQuality = "high";
    m.ctx.drawImage(small, 0, 0, W, H);
    m.ctx.restore();
    releaseCanvas(small);
    this.allDirty = true;
    return { key: D.maskKey(id), rect: { x: 0, y: 0, w: W, h: H }, before };
  }

  /** Bake a mask into its layer's pixels. The caller drops the mask afterwards. */
  applyMask(id) {
    const bm = this.layers.get(id);
    const m = this.mask(id);
    if (!bm || !m) return null;
    const W = this.doc.width;
    const H = this.doc.height;
    const before = bm.ctx.getImageData(0, 0, W, H);
    bm.ctx.save();
    bm.ctx.globalCompositeOperation = "destination-in";
    bm.ctx.drawImage(m.canvas, 0, 0);
    bm.ctx.restore();
    this.allDirty = true;
    return { key: id, rect: { x: 0, y: 0, w: W, h: H }, before };
  }

  /* ── the selection ────────────────────────────────────────────────────── */

  // A selection is a bitmap, not a shape: its alpha is how selected a pixel
  // is. That is what lets a wand, a feather and "add to selection" all be the
  // same thing, and everything that paints is cut to it with one composite.

  newSelectionCanvas() {
    const c = makeCanvas(this.doc.width, this.doc.height);
    return { canvas: c, ctx: c.getContext("2d") };
  }

  /**
   * Combine something drawn by `draw(ctx)` into the selection.
   * `mode`: replace | add | subtract | intersect.
   */
  combineSelection(draw, mode = "replace", { box = null, path = null } = {}) {
    const W = this.doc.width;
    const H = this.doc.height;
    const old = this.selection;
    const plain = mode === "replace" || !old;
    if (plain && mode !== "subtract" && mode !== "intersect") {
      const next = this.newSelectionCanvas();
      draw(next.ctx);
      if (old) releaseCanvas(old.mask);
      this.selection = { mask: next.canvas, box: box || { x: 0, y: 0, w: W, h: H }, path };
      if (!box || !path) this.retraceSelection();
      return this.selection;
    }
    if (!old) return null; // subtracting from nothing, or intersecting with it, is nothing
    const shape = this.newSelectionCanvas();
    draw(shape.ctx);
    const ctx = old.mask.getContext("2d");
    ctx.save();
    ctx.globalCompositeOperation = mode === "add" ? "source-over" : mode === "subtract" ? "destination-out" : "destination-in";
    ctx.drawImage(shape.canvas, 0, 0);
    ctx.restore();
    releaseCanvas(shape.canvas);
    this.retraceSelection();
    return this.selection;
  }

  /** Select a shape. `path` is a Path2D in document pixels. */
  selectPath(path, box, mode = "replace") {
    return this.combineSelection((ctx) => { ctx.fillStyle = "#000"; ctx.fill(path); }, mode, mode === "replace" ? { box, path } : {});
  }

  /** Select from coverage bytes (the wand, colour range). */
  selectBytes(bytes, width, height, mode = "replace") {
    const small = bytesToCanvas(bytes, width, height);
    const W = this.doc.width;
    const H = this.doc.height;
    const out = this.combineSelection((ctx) => { ctx.imageSmoothingEnabled = width !== W; ctx.drawImage(small, 0, 0, W, H); }, mode);
    releaseCanvas(small);
    return out;
  }

  /** Select whatever a surface has paint on (Ctrl+click a layer's thumbnail). */
  selectSurface(key, mode = "replace") {
    const bm = this.layers.get(key);
    if (!bm) return null;
    return this.combineSelection((ctx) => ctx.drawImage(bm.canvas, 0, 0), mode);
  }

  selectAll() {
    const p = new Path2D();
    p.rect(0, 0, this.doc.width, this.doc.height);
    return this.selectPath(p, { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
  }

  clearSelection() {
    if (this.selection) releaseCanvas(this.selection.mask);
    this.selection = null;
  }

  invertSelection() {
    if (!this.selection) return this.selectAll();
    const old = this.selection.mask;
    const next = this.newSelectionCanvas();
    next.ctx.fillStyle = "#000";
    next.ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    next.ctx.globalCompositeOperation = "destination-out";
    next.ctx.drawImage(old, 0, 0);
    releaseCanvas(old);
    this.selection = { mask: next.canvas, box: null, path: null };
    return this.retraceSelection();
  }

  /** Soften the edge of the selection by `radius` pixels. */
  featherSelection(radius) {
    if (!this.selection || !(radius > 0)) return this.selection;
    const old = this.selection.mask;
    const next = this.newSelectionCanvas();
    next.ctx.filter = `blur(${radius}px)`;
    next.ctx.drawImage(old, 0, 0);
    next.ctx.filter = "none";
    releaseCanvas(old);
    this.selection = { mask: next.canvas, box: null, path: null };
    return this.retraceSelection();
  }

  /** Grow (positive) or shrink (negative) the selection by about `n` pixels. */
  growSelection(n) {
    if (!this.selection || !n) return this.selection;
    const old = this.selection.mask;
    const next = this.newSelectionCanvas();
    const r = Math.abs(n);
    // blur, then cut the soft edge back to a hard one: low down the ramp to
    // grow, high up it to shrink
    const cut = n > 0 ? 0.04 : 0.96;
    const table = [];
    for (let i = 0; i < 64; i++) table.push(i / 63 >= cut ? 1 : 0);
    const f = svgFilter(`grow:${n > 0 ? "g" : "s"}`, `<feComponentTransfer><feFuncA type="discrete" tableValues="${table.join(" ")}"/></feComponentTransfer>`);
    const soft = makeCanvas(this.doc.width, this.doc.height);
    const sctx = soft.getContext("2d");
    // a hard edge blurred by sigma crosses 4.7% at 1.67 sigma from the edge,
    // so this sigma moves the cut by just about `r` pixels
    sctx.filter = `blur(${r / 1.67}px)`;
    sctx.drawImage(old, 0, 0);
    next.ctx.filter = f;
    next.ctx.drawImage(soft, 0, 0);
    next.ctx.filter = "none";
    releaseCanvas(soft);
    releaseCanvas(old);
    this.selection = { mask: next.canvas, box: null, path: null };
    return this.retraceSelection();
  }

  /**
   * Work the bounding box and the marching-ants outline back out of the
   * bitmap. Traced from a copy no bigger than OUTLINE_MAX a side, so it costs
   * the same on a 24-megapixel document as on a small one.
   */
  retraceSelection() {
    const sel = this.selection;
    if (!sel) return null;
    const W = this.doc.width;
    const H = this.doc.height;
    const k = Math.min(1, OUTLINE_MAX / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k));
    const h = Math.max(1, Math.round(H * k));
    const small = makeCanvas(w, h);
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(sel.mask, 0, 0, w, h);
    const data = sctx.getImageData(0, 0, w, h).data;
    releaseCanvas(small);
    const bytes = new Uint8Array(w * h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const a = data[p * 4 + 3];
        bytes[p] = a;
        if (a < 4) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) { this.clearSelection(); return null; }
    const sx = W / w;
    const sy = H / h;
    sel.box = clampRect({ x: x0 * sx - 1, y: y0 * sy - 1, w: (x1 - x0 + 1) * sx + 2, h: (y1 - y0 + 1) * sy + 2 }, this.doc);
    const path = new Path2D();
    for (const loop of traceContours(bytes, w, h, 128)) {
      path.moveTo(loop[0][0] * sx, loop[0][1] * sy);
      for (let i = 1; i < loop.length; i++) path.lineTo(loop[i][0] * sx, loop[i][1] * sy);
      path.closePath();
    }
    sel.path = path;
    return sel;
  }

  /* ── floating selection: move / scale / rotate ────────────────────────── */

  /**
   * Lift the selection (or the whole layer) off its layer into a floating
   * bitmap that can be dragged, scaled and turned before it is put back.
   */
  lift(layerId, { wholeLayer = false, copy = false } = {}) {
    const bm = this.layers.get(layerId);
    if (!bm || this.floating) return null;
    const useSel = !wholeLayer && this.selection;
    const rect = useSel ? clampRect(this.selection.box, this.doc) : { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    if (!rect) return null;
    const before = bm.ctx.getImageData(0, 0, this.doc.width, this.doc.height);
    const c = makeCanvas(rect.w, rect.h);
    const ctx = c.getContext("2d");
    ctx.drawImage(bm.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    if (useSel) {
      // keep only what is inside the selection, and take it off the layer (a copy leaves it there)
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(this.selection.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      if (copy) { /* the original stays */ } else {
      bm.ctx.save();
      bm.ctx.globalCompositeOperation = "destination-out";
      bm.ctx.drawImage(this.selection.mask, 0, 0);
      bm.ctx.restore();
      }
    } else if (!copy) {
      bm.ctx.clearRect(0, 0, this.doc.width, this.doc.height);
    }
    this.floating = {
      layerId, canvas: c, before,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      sx: 1, sy: 1, angle: 0,
      cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2,
    };
    this.allDirty = true;
    return this.floating;
  }

  /** Float a picture over a layer without taking anything off it (paste, place). */
  floatImage(layerId, image, { x = null, y = null, scale = 1 } = {}) {
    const bm = this.layers.get(layerId);
    if (!bm || this.floating) return null;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    const c = makeCanvas(w, h);
    c.getContext("2d").drawImage(image, 0, 0);
    const before = bm.ctx.getImageData(0, 0, this.doc.width, this.doc.height);
    this.floating = {
      layerId, canvas: c, before, x: 0, y: 0, w, h, sx: scale, sy: scale, angle: 0,
      cx: x == null ? this.doc.width / 2 : x, cy: y == null ? this.doc.height / 2 : y,
    };
    this.allDirty = true;
    return this.floating;
  }

  /** Put a floating selection back down. Returns an undo step's worth of state. */
  commitFloat() {
    const f = this.floating;
    if (!f) return null;
    const bm = this.layers.get(f.layerId);
    this.floating = null;
    if (!bm) return null;
    bm.ctx.save();
    bm.ctx.translate(f.cx, f.cy);
    bm.ctx.rotate(f.angle);
    bm.ctx.scale(f.sx, f.sy);
    bm.ctx.imageSmoothingQuality = "high";
    bm.ctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);
    bm.ctx.restore();
    releaseCanvas(f.canvas);
    this.allDirty = true;
    return { key: f.layerId, rect: { x: 0, y: 0, w: this.doc.width, h: this.doc.height }, before: f.before };
  }

  /** Throw away what is floating instead of putting it down: how Delete removes a piece that was picked up. */
  dropFloat() {
    const f = this.floating;
    if (!f) return null;
    this.floating = null;
    releaseCanvas(f.canvas);
    this.allDirty = true;
    return { key: f.layerId, rect: { x: 0, y: 0, w: this.doc.width, h: this.doc.height }, before: f.before };
  }

  cancelFloat() {
    const f = this.floating;
    if (!f) return;
    const bm = this.layers.get(f.layerId);
    this.floating = null;
    if (bm) bm.ctx.putImageData(f.before, 0, 0);
    releaseCanvas(f.canvas);
    this.allDirty = true;
  }

  drawFloating(ctx) {
    const f = this.floating;
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);
    ctx.scale(f.sx, f.sy);
    ctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);
    ctx.restore();
  }

  /* ── text layers ──────────────────────────────────────────────────────── */

  textFont(t) {
    // the app ships Inter and JetBrains Mono as variable fonts, under those names
    const bundled = { Inter: '"Inter Variable", "Inter"', "JetBrains Mono": '"JetBrains Mono Variable", "JetBrains Mono"' };
    const name = String(t.font || "Inter").replace(/"/g, "");
    return `${t.italic ? "italic " : ""}${t.bold ? "700 " : "400 "}${Math.max(1, t.size)}px ${bundled[name] || `"${name}"`}, "Inter Variable", system-ui, sans-serif`;
  }

  /** The box a text layer's words occupy, in document pixels. */
  textBox(layer) {
    const t = { ...D.TEXT_DEFAULTS, ...(layer.text || {}) };
    const probe = this.pool.take(4, 4);
    const ctx = probe.ctx;
    ctx.font = this.textFont(t);
    try { ctx.letterSpacing = `${t.tracking || 0}px`; } catch { /* older engines: no tracking */ }
    const lines = String(t.text || "").split("\n");
    let w = 0;
    for (const line of lines) w = Math.max(w, ctx.measureText(line || " ").width);
    try { ctx.letterSpacing = "0px"; } catch { /* as above */ }
    this.pool.give(probe);
    const lh = t.size * t.lineHeight;
    const h = Math.max(lh, lines.length * lh);
    const x = t.align === "center" ? t.x - w / 2 : t.align === "right" ? t.x - w : t.x;
    return { x, y: t.y, w: Math.max(t.size * 0.5, w), h };
  }

  /** Redraw a text layer's pixels from its words. */
  renderText(id) {
    const layer = D.layerOf(this.doc, id);
    const bm = this.layers.get(id);
    if (!layer || !bm || layer.kind !== "text") return;
    const t = { ...D.TEXT_DEFAULTS, ...(layer.text || {}) };
    const ctx = bm.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.doc.width, this.doc.height);
    ctx.font = this.textFont(t);
    ctx.fillStyle = t.colour;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = t.align;
    try { ctx.letterSpacing = `${t.tracking || 0}px`; } catch { /* no tracking */ }
    const lh = t.size * t.lineHeight;
    // the first baseline sits where a line box would put it: the font's own
    // ascent and descent, centred in the line height
    const fm = ctx.measureText("Hg");
    const fa = fm.fontBoundingBoxAscent || t.size * 0.8;
    const fd = fm.fontBoundingBoxDescent || t.size * 0.2;
    const ascent = (lh - (fa + fd)) / 2 + fa;
    String(t.text || "").split("\n").forEach((line, i) => ctx.fillText(line, t.x, t.y + ascent + i * lh));
    try { ctx.letterSpacing = "0px"; } catch { /* as above */ }
    ctx.restore();
    this.allDirty = true;
  }

  /* ── whole-document operations ────────────────────────────────────────── */

  /** Everything that a crop, a resize or a turn replaces — for undo. */
  docSnapshot() {
    return {
      width: this.doc.width,
      height: this.doc.height,
      dpi: this.doc.dpi,
      layers: this.doc.layers.map((l) => ({ ...l, text: l.text ? { ...l.text } : undefined })),
      surfaces: new Map(this.layers),
      bytes: this.layers.size * this.doc.width * this.doc.height * 4,
    };
  }

  /** Swap the whole document for a snapshot; hands back the one it replaced. */
  restoreDoc(snap) {
    const was = this.docSnapshot();
    this.doc.width = snap.width;
    this.doc.height = snap.height;
    this.doc.dpi = snap.dpi;
    this.doc.layers = snap.layers.map((l) => ({ ...l, text: l.text ? { ...l.text } : undefined }));
    this.layers = new Map(snap.surfaces);
    this.afterResize();
    return was;
  }

  afterResize() {
    releaseCanvas(this.scratch); this.scratch = null; this.scratchCtx = null;
    this.clearSelection();
    if (this.floating) { releaseCanvas(this.floating.canvas); this.floating = null; }
    this.view.width = this.doc.width;
    this.view.height = this.doc.height;
    this.allDirty = true;
  }

  /**
   * Rebuild every surface at a new size. `place(ctx, old, isMask)` draws the
   * old bitmap into the new one. Returns the snapshot of what was replaced;
   * the old canvases stay alive inside it until the undo step is dropped.
   */
  rebuild(width, height, place, { dpi = null, text = null, layer = null } = {}) {
    width = Math.max(1, Math.min(D.MAX_SIDE, Math.round(width)));
    height = Math.max(1, Math.min(D.MAX_SIDE, Math.round(height)));
    const was = this.docSnapshot();
    const next = new Map();
    for (const [key, bm] of this.layers) {
      const c = makeCanvas(width, height);
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      const isMask = D.isMaskKey(key);
      if (isMask) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height); ctx.globalCompositeOperation = "copy"; }
      place(ctx, bm.canvas, isMask, width, height);
      ctx.globalCompositeOperation = "source-over";
      next.set(key, { canvas: c, ctx });
    }
    this.layers = next;
    this.doc.width = width;
    this.doc.height = height;
    if (dpi) this.doc.dpi = dpi;
    this.doc.layers = this.doc.layers.map((l) => {
      const one = l.kind === "text" && text ? { ...l, text: text({ ...l.text }) } : { ...l };
      return layer ? layer(one) : one;
    });
    this.afterResize();
    return was;
  }

  /** Crop to a rectangle, or grow the canvas: the rectangle may reach outside it. */
  cropTo(rect) {
    const r = G.normRect(rect);
    return this.rebuild(r.w, r.h, (ctx, old, isMask) => {
      if (isMask) {
        // outside the old canvas a mask shows everything (there is nothing there to hide)
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(-r.x, -r.y, old.width, old.height);
      }
      ctx.drawImage(old, -r.x, -r.y);
    }, { text: (t) => ({ ...t, x: t.x - r.x, y: t.y - r.y }) });
  }

  /** Change the canvas size around an anchor, leaving the picture its size. */
  resizeCanvas(width, height, anchor = "c") {
    const o = G.anchorOffset(this.doc.width, this.doc.height, width, height, anchor);
    return this.cropTo({ x: -o.x, y: -o.y, w: width, h: height });
  }

  /** Resample the whole document to a new pixel size. */
  resample(width, height, { dpi = null } = {}) {
    const kx = width / this.doc.width;
    const ky = height / this.doc.height;
    return this.rebuild(width, height, (ctx, old, _m, w, h) => ctx.drawImage(old, 0, 0, w, h), {
      dpi, text: (t) => ({ ...t, x: t.x * kx, y: t.y * ky, size: Math.max(4, t.size * Math.min(kx, ky)) }),
    });
  }

  /** Turn the document by quarter turns (1 = 90° clockwise), or flip it. */
  turn(quarters = 1, flip = null) {
    const q = ((quarters % 4) + 4) % 4;
    const W = this.doc.width;
    const H = this.doc.height;
    const swap = q % 2 === 1;
    return this.rebuild(swap ? H : W, swap ? W : H, (ctx, old, _m, w, h) => {
      ctx.translate(w / 2, h / 2);
      ctx.rotate((q * Math.PI) / 2);
      if (flip === "h") ctx.scale(-1, 1);
      if (flip === "v") ctx.scale(1, -1);
      ctx.drawImage(old, -W / 2, -H / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }, {
      // live text cannot lie on its side: turning a document sets it in pixels
      layer: (l) => { if (l.kind !== "text") return l; const { text: _t, ...rest } = l; return { ...rest, kind: "raster" }; },
    });
  }

  /** The box that holds every visible pixel, for "trim to content". */
  contentBox() {
    const { data, width, height } = this.readPixels({ scale: Math.min(1, 1024 / Math.max(this.doc.width, this.doc.height)) });
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    const bg = this.doc.background ? parseHex(this.doc.background) : null;
    for (let y = 0, p = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p += 4) {
        const empty = data[p + 3] < 8 || (bg && Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2]) < 12);
        if (empty) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const k = this.doc.width / width;
    return clampRect({ x: x0 * k - 1, y: y0 * k - 1, w: (x1 - x0 + 1) * k + 2, h: (y1 - y0 + 1) * k + 2 }, this.doc);
  }

  /* ── compositing ──────────────────────────────────────────────────────── */

  /** True when every layer is plain pixels and the direct path is enough. */
  isPlain() {
    if (this.preview) return false;
    for (const l of this.doc.layers) if ((l.kind && l.kind !== "raster" && l.kind !== "text") || l.mask || l.clip || l.parent || hasFx(l)) return false;
    return true;
  }

  /**
   * Draw a document-space rectangle into a context, scaled by `scale`, with
   * every visible layer's blend mode and opacity. Used for export, the
   * thumbnail, the eyedropper and the bucket's colour sample — everything that
   * needs to see the picture as a whole.
   */
  compositeInto(ctx, x, y, w, h, scale = 1, { background = true, live = null } = {}) {
    if (this.isPlain()) return this.compositePlain(ctx, x, y, w, h, scale, { background, live });
    const rect = clampRect({ x, y, w, h }, this.doc);
    if (!rect) return;
    const rs = Math.min(1, scale);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-x, -y);
    ctx.imageSmoothingQuality = "high";
    if (rect.w * rect.h * rs * rs <= REGION_MAX_PX) {
      const buf = this.renderRegion(rect, rs, { background });
      ctx.drawImage(buf.canvas, 0, 0, buf.dw, buf.dh, rect.x, rect.y, rect.w, rect.h);
      this.pool.give(buf);
    } else {
      // too big for one region: tiles at full size (exact, because nothing in
      // the studio path looks at a pixel's neighbours), gathered and scaled once
      const full = scale === 1 ? null : makeCanvas(rect.w, rect.h);
      const fctx = full ? full.getContext("2d") : null;
      for (let ty = rect.y; ty < rect.y + rect.h; ty += TILE) {
        for (let tx = rect.x; tx < rect.x + rect.w; tx += TILE) {
          const tile = { x: tx, y: ty, w: Math.min(TILE, rect.x + rect.w - tx), h: Math.min(TILE, rect.y + rect.h - ty) };
          const buf = this.renderRegion(tile, 1, { background });
          if (fctx) fctx.drawImage(buf.canvas, 0, 0, buf.w, buf.h, tile.x - rect.x, tile.y - rect.y, tile.w, tile.h);
          else ctx.drawImage(buf.canvas, 0, 0, buf.w, buf.h, tile.x, tile.y, tile.w, tile.h);
          this.pool.give(buf);
        }
      }
      if (full) { ctx.drawImage(full, rect.x, rect.y); releaseCanvas(full); }
    }
    ctx.restore();
  }

  /** The direct path: layers drawn straight into the target, no buffers. */
  compositePlain(ctx, x, y, w, h, scale, { background = true, live = null } = {}) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-x, -y);
    if (background && this.doc.background) {
      ctx.fillStyle = this.doc.background;
      ctx.fillRect(x, y, w, h);
    }
    for (const l of this.doc.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      const bm = this.layers.get(l.id);
      if (!bm) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = D.blendOp(l.blend);
      if (this.floating && this.floating.layerId === l.id) {
        ctx.drawImage(bm.canvas, 0, 0);
        this.drawFloating(ctx);
      } else if (this.stroke && this.stroke.key === l.id && this.scratch && !this.stroke.smudge) {
        // The live stroke has to blend with its own layer before that layer
        // blends with the picture, or a multiply brush multiplies twice.
        // `live` is the document rectangle actually being repainted, which is
        // what keeps the merge buffer the size of the stroke rather than the
        // size of the canvas.
        const r = clampRect(live || { x, y, w, h }, this.doc);
        const m = r && r.w * r.h <= MERGE_MAX_PX ? this.liveSurface(l.id, regionOf(r, 1)) : null;
        if (m) {
          // the merge holds the layer AND the stroke over `r`; outside `r` the
          // caller's clip hides everything, so this is the whole layer's draw
          ctx.drawImage(m.canvas, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
          this.pool.give(m);
        } else {
          // too big to merge through a buffer — which only happens on a full
          // repaint while a stroke is in flight (a pan mid-stroke). Draw the
          // stroke straight over for this one frame; it settles correctly the
          // moment the stroke ends.
          ctx.drawImage(bm.canvas, 0, 0);
          ctx.save();
          ctx.globalAlpha = l.opacity * this.stroke.opacity;
          ctx.globalCompositeOperation = compositeFor(this.stroke.brush, l);
          ctx.drawImage(this.scratch, 0, 0);
          ctx.restore();
        }
      } else {
        ctx.drawImage(bm.canvas, 0, 0);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  /** Paint a region of the document into the current transform (document coordinates). */
  /**
   * The mask made visible, over the picture that was just painted.
   *   "solo"     the mask alone: white shows, black hides
   *   "overlay"  the picture, with a red film wherever the mask hides it
   * A stroke in progress on the mask is included, so you see what you paint.
   */
  paintMaskView(ctx, id, region, scale, mode) {
    const key = D.maskKey(id);
    const bm = this.layers.get(key);
    if (!bm || !region) return;
    const R = regionOf(region, scale);
    let src = this.surfaceNow(key, R);
    if (!src) { src = this.pool.take(R.pw, R.ph); this.blit(src.ctx, bm.canvas, R); }
    const out = this.pool.take(R.pw, R.ph);
    const o = out.ctx;
    o.fillStyle = mode === "solo" ? "#000" : "rgba(255, 45, 70, 0.58)";
    o.fillRect(0, 0, R.pw, R.ph);
    if (mode === "solo") {
      o.filter = "brightness(0) invert(1)"; // whatever colour the mask holds, its alpha drawn as white
      o.drawImage(src.canvas, 0, 0);
      o.filter = "none";
    } else {
      o.globalCompositeOperation = "destination-out";
      o.drawImage(src.canvas, 0, 0);
      o.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(out.canvas, 0, 0, R.dw, R.dh, region.x, region.y, region.w, region.h);
    this.pool.give(src);
    this.pool.give(out);
  }

  paintRegion(ctx, region, scale, opts) {
    const buf = this.renderRegion(region, scale, opts);
    ctx.drawImage(buf.canvas, 0, 0, buf.dw, buf.dh, region.x, region.y, region.w, region.h);
    this.pool.give(buf);
  }

  /** Fill a shape (a Path2D in document pixels) with a colour, through the selection. */
  fillPath(key, path, box, colour, opacity = 1) {
    const bm = this.layers.get(key);
    const rect = clampRect({ x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 }, this.doc);
    if (!bm || !rect) return null;
    const before = bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const patch = this.pool.take(rect.w, rect.h);
    patch.ctx.translate(-rect.x, -rect.y);
    patch.ctx.fillStyle = colour;
    patch.ctx.fill(path);
    patch.ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.selection) {
      patch.ctx.globalCompositeOperation = "destination-in";
      patch.ctx.drawImage(this.selection.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    }
    const layer = this.doc.layers.find((l) => l.id === key);
    bm.ctx.save();
    bm.ctx.globalAlpha = opacity;
    if (layer && layer.alphaLock) bm.ctx.globalCompositeOperation = "source-atop";
    bm.ctx.drawImage(patch.canvas, 0, 0, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    bm.ctx.restore();
    this.pool.give(patch);
    this.markDirtyDoc(rect);
    return { key, rect, before };
  }

  /**
   * One layer's own content — a group with everything in it, a layer with its
   * mask applied — as a full-size canvas. What "rasterise" and "merge group"
   * put on a new layer.
   */
  rasterise(id) {
    const find = (nodes) => { for (const n of nodes) { if (n.layer.id === id) return n; const f = find(n.children); if (f) return f; } return null; };
    const node = find(D.layerTree(this.doc.layers));
    const out = makeCanvas(this.doc.width, this.doc.height);
    if (!node) return out;
    const octx = out.getContext("2d");
    for (let ty = 0; ty < this.doc.height; ty += TILE) {
      for (let tx = 0; tx < this.doc.width; tx += TILE) {
        const R = regionOf({ x: tx, y: ty, w: Math.min(TILE, this.doc.width - tx), h: Math.min(TILE, this.doc.height - ty) }, 1);
        const buf = this.contentOf(node, R);
        octx.drawImage(buf.canvas, 0, 0, R.pw, R.ph, tx, ty, R.pw, R.ph);
        this.pool.give(buf);
      }
    }
    return out;
  }

  /**
   * The studio path: one region of the document, composited through buffers.
   * Returns a pooled buffer — hand it back with `pool.give`.
   */
  renderRegion(region, scale = 1, { background = true } = {}) {
    const R = regionOf(region, scale);
    const acc = this.pool.take(R.pw, R.ph);
    acc.dw = R.dw;
    acc.dh = R.dh;
    if (background && this.doc.background) {
      acc.ctx.fillStyle = this.doc.background;
      acc.ctx.fillRect(0, 0, R.pw, R.ph);
    }
    this.renderNodes(D.layerTree(this.doc.layers), acc, R);
    return acc;
  }

  /** A surface's pixels over the region, at the region's scale. */
  blit(ctx, canvas, R) {
    ctx.imageSmoothingEnabled = R.scale !== 1;
    ctx.imageSmoothingQuality = this.quality;
    ctx.drawImage(canvas, R.x, R.y, R.w, R.h, 0, 0, R.dw, R.dh);
  }

  /** What is drawn for a surface right now: its bitmap, or the bitmap with the live stroke on it. */
  surfaceNow(key, R) {
    if (this.stroke && this.stroke.key === key && this.scratch && !this.stroke.smudge) return this.liveSurface(key, R);
    return null;
  }

  /**
   * A surface with the live stroke already landed on it, over a region. The
   * stroke has to blend with its own layer before that layer blends with the
   * picture, or a multiply brush multiplies twice.
   */
  liveSurface(key, R) {
    const bm = this.layers.get(key);
    if (!bm) return null;
    const s = this.stroke;
    const buf = this.pool.take(R.pw, R.ph);
    this.blit(buf.ctx, bm.canvas, R);
    const patch = this.pool.take(R.pw, R.ph);
    this.blit(patch.ctx, this.scratch, R);
    if (this.selection) {
      patch.ctx.globalCompositeOperation = "destination-in";
      this.blit(patch.ctx, this.selection.mask, R);
    }
    const layer = this.doc.layers.find((l) => l.id === s.layerId);
    this.landStroke(buf.ctx, s, layer, patch, 0, 0, R.pw, R.ph);
    this.pool.give(patch);
    return buf;
  }

  /** A layer's own content over the region — pixels, mask and all — unblended. */
  contentOf(node, R) {
    const l = node.layer;
    const buf = this.pool.take(R.pw, R.ph);
    if (l.kind === "group") {
      this.renderNodes(node.children, buf, R);
    } else {
      const bm = this.layers.get(l.id);
      if (!bm) return buf;
      const live = this.surfaceNow(l.id, R);
      if (live) { buf.ctx.drawImage(live.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph); this.pool.give(live); }
      else this.blit(buf.ctx, bm.canvas, R);
      if (this.floating && this.floating.layerId === l.id) {
        buf.ctx.save();
        buf.ctx.setTransform(R.scale, 0, 0, R.scale, -R.x * R.scale, -R.y * R.scale);
        this.drawFloating(buf.ctx);
        buf.ctx.restore();
      }
    }
    this.cutToMask(buf, l, R);
    return buf;
  }

  /**
   * A layer's styles - drop shadow, outer glow, stroke - drawn under it. They
   * are worked out from the WHOLE layer once per change and kept, so a region
   * repaint never cuts a shadow off at its edge; mid-stroke the last ones stay.
   */
  drawFx(acc, node, R) {
    const img = this.fxImage(node);
    if (!img) return;
    const k = img._k;
    const a = acc.ctx;
    const op = a.globalCompositeOperation;
    a.globalCompositeOperation = "source-over";
    a.imageSmoothingEnabled = true;
    a.drawImage(img, R.x * k, R.y * k, R.w * k, R.h * k, 0, 0, R.dw, R.dh);
    a.globalCompositeOperation = op;
  }

  fxImage(node) {
    const l = node.layer;
    const fx = l.fx || {};
    const key = JSON.stringify(fx) + "|" + this.pixVer + "|" + (l.mask && l.maskOn !== false ? 1 : 0);
    const had = this.fxCache.get(l.id);
    if (had && (had.key === key || this.stroke)) return had.canvas;
    const W = this.doc.width, H = this.doc.height;
    const k = Math.min(1, 2048 / Math.max(W, H));
    const R0 = regionOf({ x: 0, y: 0, w: W, h: H }, k);
    const sil = this.contentOf(node, R0);
    const pw = R0.pw, ph = R0.ph;
    const tint = (colour) => {
      const t = makeCanvas(pw, ph);
      const g = t.getContext("2d");
      g.drawImage(sil.canvas, 0, 0, pw, ph, 0, 0, pw, ph);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = colour;
      g.fillRect(0, 0, pw, ph);
      return t;
    };
    const out = had && had.canvas.width === pw && had.canvas.height === ph ? had.canvas : makeCanvas(pw, ph);
    const o = out.getContext("2d");
    o.clearRect(0, 0, pw, ph);
    if (fx.shadow && fx.shadow.on) {
      const sh = fx.shadow;
      const t = tint(sh.color || "#000000");
      const ang = ((sh.angle ?? 120) * Math.PI) / 180;
      const d = (sh.dist ?? 12) * k;
      o.save();
      o.globalAlpha = sh.opacity ?? 0.6;
      o.filter = `blur(${Math.max(0, (sh.blur ?? 14) * k)}px)`;
      o.drawImage(t, -Math.cos(ang) * d, Math.sin(ang) * d);
      o.restore();
      releaseCanvas(t);
    }
    if (fx.glow && fx.glow.on) {
      const gl = fx.glow;
      const t = tint(gl.color || "#ffd84a");
      o.save();
      o.globalAlpha = gl.opacity ?? 0.8;
      o.filter = `blur(${Math.max(0, (gl.size ?? 20) * k)}px)`;
      o.drawImage(t, 0, 0);
      o.drawImage(t, 0, 0);
      o.restore();
      releaseCanvas(t);
    }
    if (fx.stroke && fx.stroke.on) {
      const st = fx.stroke;
      const t = tint(st.color || "#000000");
      const ring = makeCanvas(pw, ph);
      const g = ring.getContext("2d");
      const r = Math.max(0.5, (st.size ?? 4) * k);
      // the silhouette stamped around a circle (and a smaller one for thick strokes): an outline that follows every shape
      for (const rr of r > 3 ? [r, r / 2] : [r]) for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.drawImage(t, Math.cos(a) * rr, Math.sin(a) * rr); }
      g.globalCompositeOperation = "destination-out";
      g.drawImage(sil.canvas, 0, 0, pw, ph, 0, 0, pw, ph);
      o.save();
      o.globalAlpha = st.opacity ?? 1;
      o.drawImage(ring, 0, 0);
      o.restore();
      releaseCanvas(t);
      releaseCanvas(ring);
    }
    this.pool.give(sil);
    out._k = pw / W;
    this.fxCache.set(l.id, { key, canvas: out });
    return out;
  }

  /** Cut a buffer down to a layer's mask, if it has one switched on. */
  cutToMask(buf, l, R) {
    if (!l.mask || l.maskOn === false) return;
    const m = this.mask(l.id);
    if (!m) return;
    const live = this.surfaceNow(D.maskKey(l.id), R);
    buf.ctx.globalCompositeOperation = "destination-in";
    if (live) { buf.ctx.drawImage(live.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph); this.pool.give(live); }
    else this.blit(buf.ctx, m.canvas, R);
    buf.ctx.globalCompositeOperation = "source-over";
  }

  renderNodes(nodes, acc, R) {
    // what the clipped layers above are clipped to: null (nothing — the clip
    // flag is ignored), "hidden" (their base is switched off, so are they),
    // or a buffer holding the base's content
    let base = null;
    const dropBase = () => { if (base && base !== "hidden") this.pool.give(base); base = null; };
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const l = node.layer;
      const nextClipped = !!(nodes[i + 1] && nodes[i + 1].layer.clip);
      const adjust = this.preview && this.preview.id === l.id ? this.preview.adjust : l.adjust;
      if (!l.clip) dropBase();
      if (l.clip && base === "hidden") continue;
      const shown = l.visible && l.opacity > 0;
      if (!shown) { if (!l.clip && nextClipped) base = "hidden"; continue; }
      const clipTo = l.clip && base && base !== "hidden" ? base : null;

      if (l.kind === "adjust") {
        this.renderAdjust(l, adjust, acc, R, clipTo);
        continue;
      }
      const isGroup = l.kind === "group";
      const masked = l.mask && l.maskOn !== false;
      if (isGroup && l.passThrough && l.opacity === 1 && !masked && !clipTo && !nextClipped) {
        this.renderNodes(node.children, acc, R);
        continue;
      }
      const bm = isGroup ? null : this.layers.get(l.id);
      if (!isGroup && !bm) continue;
      const styled = hasFx(l);
      const needsBuffer = styled || isGroup || masked || clipTo || (nextClipped && !l.clip) || (this.floating && this.floating.layerId === l.id) || (this.stroke && (this.stroke.key === l.id || this.stroke.key === D.maskKey(l.id)));
      acc.ctx.globalAlpha = l.opacity;
      acc.ctx.globalCompositeOperation = isGroup && l.passThrough ? "source-over" : D.blendOp(l.blend);
      if (!needsBuffer) {
        this.blit(acc.ctx, bm.canvas, R);
      } else {
        const content = this.contentOf(node, R);
        if (clipTo) {
          content.ctx.globalCompositeOperation = "destination-in";
          content.ctx.drawImage(clipTo.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
          content.ctx.globalCompositeOperation = "source-over";
        }
        if (styled) this.drawFx(acc, node, R);
        acc.ctx.drawImage(content.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
        if (nextClipped && !l.clip) base = content; // kept for the layers clipped to it
        else this.pool.give(content);
      }
      acc.ctx.globalAlpha = 1;
      acc.ctx.globalCompositeOperation = "source-over";
    }
    dropBase();
  }

  /**
   * An adjustment layer: everything composited so far, run through the
   * filter, and blended back in through the mask (and the clip) at the
   * layer's opacity. The blend is an exact cross-fade — `acc·(1 − c) + adj·c`
   * — done with two composites and an add, so a half-masked adjustment never
   * thickens a soft edge.
   */
  renderAdjust(l, adjust, acc, R, clipTo) {
    const filter = adjustFilter(adjust);
    if (!filter) return;
    const masked = l.mask && l.maskOn !== false && this.mask(l.id);
    const adj = this.pool.take(R.pw, R.ph);
    adj.ctx.filter = filter;
    adj.ctx.drawImage(acc.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
    adj.ctx.filter = "none";
    const a = acc.ctx;
    if (!masked && !clipTo && l.opacity === 1 && l.blend === "normal") {
      a.globalCompositeOperation = "copy";
      a.drawImage(adj.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
      a.globalCompositeOperation = "source-over";
      this.pool.give(adj);
      return;
    }
    // where, and how strongly, the adjustment applies
    const cover = this.pool.take(R.pw, R.ph);
    cover.ctx.fillStyle = "#000";
    cover.ctx.fillRect(0, 0, R.pw, R.ph);
    this.cutToMask(cover, l, R);
    if (clipTo) {
      cover.ctx.globalCompositeOperation = "destination-in";
      cover.ctx.drawImage(clipTo.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
      cover.ctx.globalCompositeOperation = "source-over";
    }
    adj.ctx.globalCompositeOperation = "destination-in";
    adj.ctx.globalAlpha = l.opacity;
    adj.ctx.drawImage(cover.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
    adj.ctx.globalAlpha = 1;
    if (l.blend === "normal") {
      a.globalCompositeOperation = "destination-out";
      a.globalAlpha = l.opacity;
      a.drawImage(cover.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
      a.globalAlpha = 1;
      a.globalCompositeOperation = "lighter";
      a.drawImage(adj.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
    } else {
      a.globalCompositeOperation = D.blendOp(l.blend);
      a.drawImage(adj.canvas, 0, 0, R.pw, R.ph, 0, 0, R.pw, R.ph);
    }
    a.globalCompositeOperation = "source-over";
    this.pool.give(cover);
    this.pool.give(adj);
  }

  /* ── the on-screen view ───────────────────────────────────────────────── */

  markDirtyDoc(rect) {
    // document-space rectangles become whole-view repaints: working out the
    // screen box under rotation for every little rect is not worth the code
    this.allDirty = true;
  }

  /** A flattened copy at a scale, for export and thumbnails. */
  flatten(scale = 1, { background = true } = {}) {
    const w = Math.max(1, Math.round(this.doc.width * scale));
    const h = Math.max(1, Math.round(this.doc.height * scale));
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    const q = this.quality;
    this.quality = "high";
    this.compositeInto(ctx, 0, 0, this.doc.width, this.doc.height, w / this.doc.width, { background });
    this.quality = q;
    return c;
  }

  /** A surface on its own, at a scale — the layers panel's thumbnails. */
  layerThumb(key, w, h) {
    const bm = this.layers.get(key);
    const c = makeCanvas(w, h);
    if (!bm) return c;
    const ctx = c.getContext("2d");
    const s = Math.min(w / this.doc.width, h / this.doc.height);
    const dw = this.doc.width * s;
    const dh = this.doc.height * s;
    ctx.imageSmoothingQuality = "medium";
    if (D.isMaskKey(key)) {
      // a mask reads as it does everywhere: white shows, black hides
      ctx.fillStyle = "#000";
      ctx.fillRect((w - dw) / 2, (h - dh) / 2, dw, dh);
      const t = makeCanvas(w, h);
      const tc = t.getContext("2d");
      tc.drawImage(bm.canvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
      tc.globalCompositeOperation = "source-in";
      tc.fillStyle = "#fff";
      tc.fillRect(0, 0, w, h);
      ctx.drawImage(t, 0, 0);
      releaseCanvas(t);
    } else {
      ctx.drawImage(bm.canvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    return c;
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** The canvas composite operation a brush uses on a layer. */
export function compositeFor(brush, layer) {
  if (brush.blend === "erase") return "destination-out";
  if (layer && layer.alphaLock) return "source-atop";
  if (brush.blend === "multiply") return "multiply";
  return "source-over";
}

export function parseHex(hex) {
  const s = String(hex || "#000").replace("#", "");
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s.slice(0, 6).padEnd(6, "0");
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (r, g, b) => "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);

/** Coverage bytes as a canvas whose alpha is the coverage. */
export function bytesToCanvas(bytes, width, height) {
  const c = makeCanvas(width, height);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let i = 0, p = 3; i < bytes.length; i++, p += 4) d[p] = bytes[i];
  ctx.putImageData(img, 0, 0);
  return c;
}

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * A document rectangle and the buffer it is rendered into. `dw × dh` is the
 * exact size it is drawn at (fractional when zoomed out); `pw × ph` the whole
 * pixels that holds. Drawing at the exact size is what makes a repaint of one
 * corner land on the same pixels as a repaint of everything.
 */
/** Whether a layer has a style switched on. */
export const hasFx = (l) => !!(l && l.fx && ((l.fx.shadow && l.fx.shadow.on) || (l.fx.stroke && l.fx.stroke.on) || (l.fx.glow && l.fx.glow.on)));

export function regionOf(rect, scale = 1) {
  const dw = rect.w * scale;
  const dh = rect.h * scale;
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h, scale, dw, dh, pw: Math.max(1, Math.ceil(dw)), ph: Math.max(1, Math.ceil(dh)) };
}

export function clampRect(r, doc) {
  if (!r) return null;
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(doc.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(doc.height, Math.ceil(r.y + r.h));
  if (x1 <= x || y1 <= y) return null;
  return { x, y, w: x1 - x, h: y1 - y };
}
