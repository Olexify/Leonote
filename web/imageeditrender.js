// Drawing a non-destructive edit onto a canvas.
//
// One code path for all three places the result appears: the editor's live
// canvas, the thumbnail the viewer and the file view show, and the flattened
// copy written to a new file. Coordinates in the sidecar are picture pixels,
// so `scale` is the only thing that differs between them.

import { filterString, normalizeDoc, sharpenKernel, TEXT_FONTS } from "./imageeditmodel.js";

const HIGHLIGHT_ALPHA = 0.32;

/** A canvas, whether or not OffscreenCanvas is around (tests, old webviews). */
function surface(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** One stroke, rectangle, ellipse or label, in picture pixels × `scale`. */
// env: { src, filter } - the picture under the marks (and the colour adjustments on it), for pieces of it
export function drawShape(ctx, s, scale = 1, env = null) {
  if (s.ghost) return;
  const k = scale;
  ctx.save();
  ctx.globalAlpha = s.alpha == null ? 1 : s.alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.c || "#e0a84a";
  ctx.fillStyle = s.c || "#e0a84a";
  ctx.lineWidth = Math.max(0.4, (s.w || 4) * k);

  if (s.t === "group") {
    ctx.restore();
    const c = surface(ctx.canvas.width, ctx.canvas.height);
    const g = c.getContext("2d");
    drawShapes(g, s.shapes, k, env);
    ctx.save();
    ctx.globalAlpha = s.alpha == null ? 1 : s.alpha;
    ctx.drawImage(c, 0, 0);
    ctx.restore();
    return;
  }

  if (s.t === "erase") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    strokePath(ctx, s.pts, k);
    ctx.restore();
    return;
  }

  if (s.t === "marker") {
    // A highlighter: wide, soft-ended and see-through. Deliberately NOT a
    // `multiply` blend - a layer is drawn on its own transparent surface, so
    // there would be nothing under it to multiply with, and the stroke would
    // come out a flat grey. Plain translucent ink over the photo is both
    // what it should look like and what the flattened copy will contain.
    ctx.globalAlpha = (s.alpha == null ? 1 : s.alpha) * HIGHLIGHT_ALPHA;
    ctx.lineCap = "round"; // a square end turns every short dab into a spinning slab
    ctx.lineJoin = "round";
    strokePath(ctx, s.pts, k);
    ctx.restore();
    return;
  }

  if (s.t === "pen") {
    strokePath(ctx, s.pts, k);
    ctx.restore();
    return;
  }

  if (s.t === "line") {
    ctx.beginPath();
    ctx.moveTo(s.x1 * k, s.y1 * k);
    ctx.lineTo(s.x2 * k, s.y2 * k);
    ctx.stroke();
    if (s.arrow) arrowHead(ctx, s.x1 * k, s.y1 * k, s.x2 * k, s.y2 * k, Math.max(2, (s.w || 4) * k));
    ctx.restore();
    return;
  }

  if (s.t === "rect" || s.t === "ellipse") {
    const x = Math.min(s.x, s.x + s.rw) * k;
    const y = Math.min(s.y, s.y + s.rh) * k;
    const w = Math.abs(s.rw) * k;
    const h = Math.abs(s.rh) * k;
    ctx.beginPath();
    if (s.t === "rect") {
      const r = Math.min(w, h, Math.max(0, (s.w || 4) * k));
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
    } else {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    }
    if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
    if ((s.w || 0) > 0) ctx.stroke();
    ctx.restore();
    return;
  }

  if (s.t === "snip") {
    if (env && env.src) {
      if (s.hole) { ctx.fillStyle = s.fill || "#000"; ctx.fillRect(s.sx * k, s.sy * k, s.sw * k, s.sh * k); }
      if (env.filter) ctx.filter = env.filter;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(env.src, s.sx * k, s.sy * k, s.sw * k, s.sh * k, s.x * k, s.y * k, s.sw * s.z * k, s.sh * s.z * k);
    }
    ctx.restore();
    return;
  }

  if (s.t === "text") {
    const size = Math.max(1, (s.size || 32) * k);
    ctx.font = `600 ${size}px ${TEXT_FONTS[s.font] || TEXT_FONTS.sans}`;
    ctx.textBaseline = "top";
    const lines = String(s.text).split("\n");
    // a background behind the words, the width of the longest line
    if (s.bg) {
      const p = size * 0.3;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
      ctx.fillStyle = s.bg;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(s.x * k - p, s.y * k - p, w + p * 2, lines.length * size * 1.22 + p * 2 - size * 0.22, size * 0.25);
      else ctx.rect(s.x * k - p, s.y * k - p, w + p * 2, lines.length * size * 1.22 + p * 2 - size * 0.22);
      ctx.fill();
      ctx.fillStyle = s.c || "#e0a84a";
    }
    // a thin dark rim, so a label stays readable on any picture (not needed on a background, unless asked)
    const rim = s.rim === false ? false : !s.bg;
    ctx.lineWidth = Math.max(1, size * 0.14);
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.lineJoin = "round";
    lines.forEach((line, i) => {
      const y = s.y * k + i * size * 1.22;
      if (rim) ctx.strokeText(line, s.x * k, y);
      ctx.fillText(line, s.x * k, y);
    });
    ctx.restore();
    return;
  }
  ctx.restore();
}

function strokePath(ctx, pts, k) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  if (pts.length === 2) {
    // a single tap still leaves a dot
    ctx.arc(pts[0] * k, pts[1] * k, Math.max(0.3, ctx.lineWidth / 2), 0, Math.PI * 2);
    const op = ctx.globalCompositeOperation;
    ctx.fillStyle = op === "destination-out" ? "#000" : ctx.strokeStyle;
    ctx.fill();
    return;
  }
  ctx.moveTo(pts[0] * k, pts[1] * k);
  // quadratic through the midpoints: the same smoothing the sketch tool uses
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2;
    const my = (pts[i + 1] + pts[i + 3]) / 2;
    ctx.quadraticCurveTo(pts[i] * k, pts[i + 1] * k, mx * k, my * k);
  }
  ctx.lineTo(pts[pts.length - 2] * k, pts[pts.length - 1] * k);
  ctx.stroke();
}

function arrowHead(ctx, x1, y1, x2, y2, w) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(w * 3.2, 8);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(a - 0.42), y2 - len * Math.sin(a - 0.42));
  ctx.lineTo(x2 - len * Math.cos(a + 0.42), y2 - len * Math.sin(a + 0.42));
  ctx.closePath();
  ctx.fill();
}

export function drawShapes(ctx, shapes, scale = 1, env = null) {
  for (const s of shapes || []) drawShape(ctx, s, scale, env);
}

/** One layer onto its own surface, then composited at its opacity. */
export function drawLayers(ctx, layers, scale = 1, { preview = null, env = null } = {}) {
  for (const l of layers || []) {
    if (l.hidden || !l.opacity) continue;
    const extra = preview && preview.layerId === l.id ? preview.shapes : null;
    const shapes = extra && extra.length ? [...l.shapes, ...extra] : l.shapes;
    if (!shapes.length) continue;
    const c = surface(ctx.canvas.width, ctx.canvas.height);
    const g = c.getContext("2d");
    drawShapes(g, shapes, scale, env);
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.drawImage(c, 0, 0);
    ctx.restore();
  }
  // a stroke in flight on a layer that holds nothing yet
  if (preview && preview.shapes && preview.shapes.length && !(layers || []).some((l) => l.id === preview.layerId && (l.shapes.length || l.hidden))) {
    const l = (layers || []).find((x) => x.id === preview.layerId);
    if (l && !l.hidden) {
      const c = surface(ctx.canvas.width, ctx.canvas.height);
      drawShapes(c.getContext("2d"), preview.shapes, scale, env);
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(c, 0, 0);
      ctx.restore();
    }
  }
}

/** A soft dark corner-fade, the part of an adjustment CSS cannot express. */
export function drawVignette(ctx, w, h, amount) {
  const a = Math.max(0, Math.min(100, amount || 0)) / 100;
  if (!a) return;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(cx, cy);
  const g = ctx.createRadialGradient(cx, cy, r * 0.42, cx, cy, r);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${(a * 0.78).toFixed(3)})`);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** An unsharp pass over what is already on the canvas. */
export function applySharpen(ctx, w, h, amount) {
  const a = Math.max(0, Math.min(100, amount || 0));
  if (!a || w < 3 || h < 3) return;
  const k = sharpenKernel(a);
  let img;
  try { img = ctx.getImageData(0, 0, w, h); } catch { return; } // a tainted canvas: skip it
  const src = img.data;
  const out = new Uint8ClampedArray(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const kv = k[(ky + 1) * 3 + (kx + 1)];
            if (!kv) continue;
            sum += kv * src[((y + ky) * w + (x + kx)) * 4 + ch];
          }
        }
        out[i + ch] = sum;
      }
    }
  }
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
}

/**
 * The whole picture as edited: the photo with its adjustments, then the
 * layers on top. `ctx.canvas` must already be the right size.
 *
 * Layers are drawn after the adjustments on purpose — a drawn arrow should
 * not go grey when the picture does.
 */
export function drawDoc(ctx, image, doc, { scale = 1, adjust = true, layers = true, preview = null, sharpen = true } = {}) {
  const d = normalizeDoc(doc);
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const on = adjust && d.adjustOn;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.filter = on ? filterString(d.adjust) || "none" : "none";
  if (image) ctx.drawImage(image, 0, 0, w, h);
  ctx.restore();
  if (on && sharpen && d.adjust.sharpen) applySharpen(ctx, w, h, d.adjust.sharpen);
  if (on) drawVignette(ctx, w, h, d.adjust.vignette);
  // pieces of the picture copy from it as it is now, adjustments and all
  let env = null;
  if (layers && d.layers.some((l) => l.shapes.some((s) => s.t === "snip"))) {
    const src = surface(w, h);
    src.getContext("2d").drawImage(ctx.canvas, 0, 0);
    env = { src };
  }
  if (layers) drawLayers(ctx, d.layers, scale, { preview, env });
}

/**
 * The edited picture as a canvas at its own size (or `maxSide` at most).
 * Used for the flattened copy and for the preview the viewer shows.
 */
export function renderDoc(image, doc, { maxSide = 0, full = false } = {}) {
  const d = normalizeDoc(doc);
  const iw = image.naturalWidth || image.width || d.w;
  const ih = image.naturalHeight || image.height || d.h;
  const k = maxSide > 0 ? Math.min(1, maxSide / Math.max(iw, ih)) : 1;
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  // strokes were drawn in the picture's own pixels; d.w is what the editor saw
  const shapeScale = (d.w ? w / d.w : k) || 1;
  drawDoc(c.getContext("2d", { willReadFrequently: true }), image, d, { scale: shapeScale });
  if (!d.crop || full) return c;
  // the crop comes last: everything was drawn on the whole picture, as in the editor
  const cx = Math.round(d.crop.x * w);
  const cy = Math.round(d.crop.y * h);
  const cw = Math.max(1, Math.min(w - cx, Math.round(d.crop.w * w)));
  const ch = Math.max(1, Math.min(h - cy, Math.round(d.crop.h * h)));
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(c, cx, cy, cw, ch, 0, 0, cw, ch);
  return out;
}

/** `renderDoc` as an object URL, or null when there is nothing to show. */
export async function renderDocUrl(image, doc, { maxSide = 0, type = "image/png", quality = 0.92 } = {}) {
  const c = renderDoc(image, doc, { maxSide });
  const blob = await new Promise((r) => c.toBlob(r, type, quality));
  return blob ? URL.createObjectURL(blob) : null;
}
