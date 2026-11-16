// Draw documents on disk: create, open, save, export.
//
// The container itself is Rust's (src-tauri/src/paint.rs) — this side only
// turns canvases into PNGs and back. Layers cross the IPC boundary as base64
// because that is the only shape a canvas bitmap and a Rust `Vec<u8>` agree
// on; `paint_inspect` exists so the common case (showing a thumbnail in the
// file view) never pays for it.

import * as D from "./paintdoc.js";
import { Engine } from "./paintengine.js";

export const APP_TAG = "Leonote 1.0.0";
export const EXT = ".leostudio";

/** Where a file's exports go: beside it in the vault; an outside file's in the vault's Drawings folder. */
export const homeOf = (app, p) => (String(p).startsWith("@guest/") ? `${app.workDir ? app.workDir("drawing") : "Workplace/Drawings"}/${String(p).split("/").pop()}` : p);
export const isPaintFile = (p) => /\.leostudio$/i.test(String(p || ""));

/* ── encoding ────────────────────────────────────────────────────────────── */

export function canvasBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the canvas could not be encoded"))), type, quality);
  });
}

/** A blob as bare base64 — no `data:` prefix. */
export function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read the image data"));
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf(",");
      resolve(i < 0 ? s : s.slice(i + 1));
    };
    r.readAsDataURL(blob);
  });
}

export const canvasBase64 = async (canvas, type = "image/png", quality) => blobBase64(await canvasBlob(canvas, type, quality));

/** base64 PNG -> a drawable image. */
export function imageFromBase64(b64, mime = "image/png") {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("a layer's image could not be decoded"));
    img.src = `data:${mime};base64,${b64}`;
  });
}

/* ── open ────────────────────────────────────────────────────────────────── */

/**
 * Open a `.leopaint`. Returns a live engine with every layer's bitmap in it.
 * A layer whose PNG is missing opens empty rather than failing the file.
 */
export async function openDoc(app, path) {
  const res = await app.host.paintLoad(path);
  const doc = D.fromManifest(res.manifest);
  const engine = new Engine(doc);
  await loadBitmaps(engine, doc, res);
  return { doc, engine, bytes: res.bytes || 0 };
}

/**
 * Put what came out of the file onto the engine's surfaces: every layer's
 * pixels and every mask. Also how a drawing comes back from a deep sleep.
 */
export async function loadBitmaps(engine, doc, res) {
  const byId = new Map((res.layers || []).map((l) => [l.id, l.png]));
  const put = async (key, { mask = false } = {}) => {
    const png = byId.get(key);
    const bm = engine.surface(key);
    if (!bm) return;
    if (!png) return; // a missing PNG opens empty (a missing mask: showing everything)
    try {
      const img = await imageFromBase64(png);
      bm.ctx.save();
      if (mask) bm.ctx.globalCompositeOperation = "copy";
      bm.ctx.drawImage(img, 0, 0);
      bm.ctx.restore();
    } catch { /* an unreadable layer stays empty; the rest of the drawing opens */ }
  };
  await Promise.all(doc.layers.flatMap((l) => {
    const jobs = [];
    if (D.hasPixels(l)) { if (!engine.bitmap(l.id)) engine.addLayerBitmap(l.id); jobs.push(put(l.id)); }
    if (l.mask) { engine.addMask(l.id); jobs.push(put(D.maskKey(l.id), { mask: true })); }
    return jobs;
  }));
  // a text layer whose PNG went missing can simply be set again
  for (const l of doc.layers) if (l.kind === "text" && !byId.get(l.id)) engine.renderText(l.id);
}

/* ── save ────────────────────────────────────────────────────────────────── */

export const THUMB_MAX = 320;

/** The scale that fits a document inside THUMB_MAX on its longest side. */
export const thumbScale = (doc) => Math.min(1, THUMB_MAX / Math.max(doc.width, doc.height));

/**
 * Write the whole document. Every layer is re-encoded, so a save costs one
 * PNG encode per layer — a few hundred milliseconds for a big canvas, which
 * is why saves are explicit (Ctrl+S, closing the tab) and not per stroke.
 */
export async function saveDoc(app, path, doc, engine, { created = null } = {}) {
  const manifest = JSON.stringify(D.toManifest(doc, { app: APP_TAG, created }), null, 2);
  const layers = [];
  for (const l of doc.layers) {
    const bm = D.hasPixels(l) ? engine.bitmap(l.id) : null;
    if (bm) layers.push({ id: l.id, png: await canvasBase64(bm.canvas) });
    const m = l.mask ? engine.mask(l.id) : null;
    if (m) layers.push({ id: D.maskKey(l.id), png: await canvasBase64(m.canvas) });
  }
  const thumbCanvas = engine.flatten(thumbScale(doc));
  const thumb = await canvasBase64(thumbCanvas, "image/png");
  thumbCanvas.width = 1;
  thumbCanvas.height = 1;
  const entry = await app.host.paintSave(path, manifest, layers, thumb);
  if (entry && entry.path && app.vault && app.vault.files) app.vault.files.set(entry.path, entry);
  return entry;
}

/** A brand-new empty drawing on disk, ready to open. */
export async function createDoc(app, path, { width, height, dpi, background, name = "", fps = 0 }) {
  const doc = D.newDoc({ width, height, dpi, background, name });
  if (fps) doc.anim = { fps, cur: 0, onion: true, minSec: 3 };
  const engine = new Engine(doc);
  const entry = await saveDoc(app, path, doc, engine, { created: new Date().toISOString() });
  engine.destroy();
  return entry;
}

/* ── photos ──────────────────────────────────────────────────────────────── */

export const PHOTO_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

/** A picture from the vault as something drawable. */
export async function loadVaultImage(app, path) {
  const url = app.host.assetUrl(path);
  if (!url) throw new Error(`${path} cannot be read here`);
  return new Promise((resolve, reject) => {
    const img = new Image();
    // local pictures load CORS-clean, so the canvas they land on can be saved
    if (/^(blob:|data:)|asset\.localhost|^asset:/i.test(url)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${path} could not be opened as a picture`));
    img.src = url;
  });
}

/**
 * Open a photo in Studio: a new `.leopaint` beside it, the photo on one layer
 * at its own size, nothing resampled. The photo itself is never touched.
 * A photo bigger than the engine's ceiling is scaled down to fit it, and the
 * result says so.
 */
export async function photoToDoc(app, photoPath, outPath) {
  const img = await loadVaultImage(app, photoPath);
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (!w || !h) throw new Error("the picture has no size");
  const k = Math.min(1, D.MAX_SIDE / Math.max(w, h), Math.sqrt(D.MAX_PIXELS / (w * h)));
  w = Math.max(1, Math.floor(w * k));
  h = Math.max(1, Math.floor(h * k));
  const name = photoPath.slice(photoPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const doc = D.newDoc({ width: w, height: h, dpi: 72, background: null, name });
  doc.layers[0].name = "Photo";
  const engine = new Engine(doc);
  const bm = engine.bitmap(doc.layers[0].id);
  bm.ctx.imageSmoothingQuality = "high";
  bm.ctx.drawImage(img, 0, 0, w, h);
  const entry = await saveDoc(app, outPath, doc, engine, { created: new Date().toISOString() });
  engine.destroy();
  return { entry, width: w, height: h, scaled: k < 1 };
}

/**
 * A Photoshop file opened in Studio: its layers as Studio layers - names,
 * places, opacity, blend, visibility, clipping and groups - in a new
 * .leostudio; the .psd itself is never touched. More layers than Studio holds,
 * or none with pixels, and it comes in as the one merged picture.
 */
export async function psdToDoc(app, psdPath, outPath) {
  const P = await import("./psd.js");
  const res = await fetch(app.host.assetUrl(psdPath));
  const psd = P.parsePsd(new Uint8Array(await res.arrayBuffer()));
  const k = Math.min(1, D.MAX_SIDE / Math.max(psd.width, psd.height), Math.sqrt(D.MAX_PIXELS / (psd.width * psd.height)));
  const w = Math.max(1, Math.floor(psd.width * k)), hgt = Math.max(1, Math.floor(psd.height * k));
  const name = psdPath.slice(psdPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const doc = D.newDoc({ width: w, height: hgt, dpi: 72, background: null, name });
  const pixelCount = psd.layers.filter((l) => l.pixels && !l.section).length;
  const flat = !pixelCount || psd.layers.length > D.MAX_LAYERS;
  const pending = []; // [studio layer, psd layer or the merged canvas]
  if (flat) {
    doc.layers[0].name = "Photoshop picture";
    pending.push([doc.layers[0], null]);
  } else {
    doc.layers = [];
    const stack = []; // the layers waiting for the group they sit in (Photoshop names the group after its children)
    for (const L of psd.layers) {
      if (L.section === 3) { stack.push([]); continue; }
      if (L.section === 1 || L.section === 2) {
        const kids = stack.pop() || [];
        if (stack.length >= D.MAX_GROUP_DEPTH) { if (stack.length) stack[stack.length - 1].push(...kids); continue; }
        const g = D.newLayer({ kind: "group", name: L.name || "Group", collapsed: L.section === 2, passThrough: !!L.pass, opacity: L.opacity, visible: L.visible, blend: L.pass ? "normal" : L.blend });
        for (const kid of kids) if (!kid.parent) kid.parent = g.id;
        doc.layers.push(g);
        if (stack.length) stack[stack.length - 1].push(g);
        continue;
      }
      if (!L.pixels) continue;
      const layer = D.newLayer({ name: L.name || "Layer", opacity: L.opacity, visible: L.visible, blend: L.blend, clip: L.clip });
      doc.layers.push(layer);
      if (stack.length) stack[stack.length - 1].push(layer);
      pending.push([layer, L]);
    }
    if (!doc.layers.length) { doc.layers = [D.newLayer({ name: "Photoshop picture" })]; pending.push([doc.layers[0], null]); }
  }
  const engine = new Engine(doc);
  for (const [layer, L] of pending) {
    const bm = engine.bitmap(layer.id);
    bm.ctx.imageSmoothingQuality = "high";
    let src;
    if (L) {
      src = document.createElement("canvas");
      src.width = L.width;
      src.height = L.height;
      src.getContext("2d").putImageData(new ImageData(L.pixels, L.width, L.height), 0, 0);
      bm.ctx.drawImage(src, L.left * k, L.top * k, L.width * k, L.height * k);
    } else {
      src = P.psdCanvas(psd);
      bm.ctx.drawImage(src, 0, 0, w, hgt);
    }
    src.width = 1;
    src.height = 1;
  }
  const entry = await saveDoc(app, outPath, doc, engine, { created: new Date().toISOString() });
  engine.destroy();
  return { entry, width: w, height: hgt, scaled: k < 1, layers: pending.length, flat };
}

/* ── export ──────────────────────────────────────────────────────────────── */

/**
 * Flatten to a picture in the vault, beside the drawing. JPEG gets the
 * document's background painted in first — it has no transparency, and a
 * silently black export is the kind of thing people only notice after
 * uploading it somewhere.
 */
export async function exportImage(app, docPath, doc, engine, { format = "png", scale = 1, quality = 0.92 } = {}) {
  const fmt = D.EXPORT_BY_ID.get(format) || D.EXPORT_FORMATS[0];
  const { width, height } = D.exportSize(doc, scale);
  const canvas = engine.flatten(width / doc.width, { background: true });
  if (fmt.id === "jpeg" && !doc.background) {
    // no background set, but JPEG needs one: white, like every other app
    const ctx = canvas.getContext("2d");
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
  }
  const blob = await canvasBlob(canvas, fmt.mime, fmt.quality ? quality : undefined);
  canvas.width = 1;
  canvas.height = 1;
  const out = D.exportPath(homeOf(app, docPath), { format: fmt.id, scale, taken: app.vault.files });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const list = await app.host.saveImage(out, bytes);
  if (Array.isArray(list) && app.vault.setFiles) app.vault.setFiles(list);
  return { path: out, bytes: bytes.length, width: canvas.width, height: canvas.height, size: { width, height } };
}

/** Encode a finished canvas and put it in the vault beside the drawing. */
export async function exportCanvas(app, docPath, canvas, { format = "png", quality = 0.92, label = "", scale = 1 } = {}) {
  const fmt = D.EXPORT_BY_ID.get(format) || D.EXPORT_FORMATS[0];
  const blob = await canvasBlob(canvas, fmt.mime, fmt.quality ? quality : undefined);
  const out = D.exportPath(homeOf(app, docPath), { format: fmt.id, scale, label, taken: app.vault.files });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const list = await app.host.saveImage(out, bytes);
  if (Array.isArray(list) && app.vault.setFiles) app.vault.setFiles(list);
  return { path: out, bytes: bytes.length, size: { width: canvas.width, height: canvas.height } };
}

/** Export templates the user made, kept with the other drawing preferences. */
export function customTemplates(app) {
  const list = app.settings.paintExportTemplates;
  return Array.isArray(list) ? list.filter((t) => t && t.w > 0 && t.h > 0).slice(0, 40) : [];
}

export function saveCustomTemplate(app, t) {
  const list = customTemplates(app).filter((x) => x.id !== t.id);
  list.unshift(t);
  app.setSetting("paintExportTemplates", list.slice(0, 40));
}

export function removeCustomTemplate(app, id) {
  app.setSetting("paintExportTemplates", customTemplates(app).filter((t) => t.id !== id));
}

/* ── presets in settings ─────────────────────────────────────────────────── */

/**
 * Canvas and brush presets follow the user, because they are the part of a
 * drawing app people set up once. Stored in app settings, not in the vault:
 * they are preferences, not documents.
 */
export const SETTING_KEYS = {
  canvas: "paintCanvasPresets", // [{ id, name, w, h, dpi }] the user made
  lastCanvas: "paintLastCanvas", // the preset id the New drawing sheet opens on
  brushes: "paintBrushes", // [{ id, name, from, ...params }]
  lastBrush: "paintLastBrush",
  palette: "paintPalette", // recent colours
  background: "paintBackground",
};

export function customCanvasPresets(app) {
  const list = app.settings[SETTING_KEYS.canvas];
  return Array.isArray(list) ? list.filter((p) => p && p.w > 0 && p.h > 0).slice(0, 40) : [];
}

export function saveCustomCanvas(app, preset) {
  const list = customCanvasPresets(app).filter((p) => p.id !== preset.id);
  list.unshift(preset);
  app.setSetting(SETTING_KEYS.canvas, list.slice(0, 40));
  return list;
}

export function removeCustomCanvas(app, id) {
  app.setSetting(SETTING_KEYS.canvas, customCanvasPresets(app).filter((p) => p.id !== id));
}

export function customBrushes(app) {
  const list = app.settings[SETTING_KEYS.brushes];
  return Array.isArray(list) ? list.filter((b) => b && typeof b.id === "string").slice(0, 60) : [];
}

export function saveCustomBrush(app, brush) {
  const list = customBrushes(app).filter((b) => b.id !== brush.id);
  list.unshift(brush);
  app.setSetting(SETTING_KEYS.brushes, list.slice(0, 60));
  return list;
}

export function removeCustomBrush(app, id) {
  app.setSetting(SETTING_KEYS.brushes, customBrushes(app).filter((b) => b.id !== id));
}

/** Recent colours, most recent first, no duplicates. */
export function rememberColour(app, hex) {
  const cur = Array.isArray(app.settings[SETTING_KEYS.palette]) ? app.settings[SETTING_KEYS.palette] : [];
  const next = [hex, ...cur.filter((c) => c !== hex)].slice(0, 24);
  app.setSetting(SETTING_KEYS.palette, next);
  return next;
}
