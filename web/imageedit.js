// The picture editor: layers you draw on, colour adjustments, and a flatten
// step that writes a NEW file.
//
// The picture on disk is never touched. Everything here lives in a sidecar
// (imageeditmodel.js says where and in what shape); the only ways bytes are
// ever written are "Save as a new picture…" and the explicitly confirmed
// "Apply to the original", which goes through file_write and so keeps a copy
// of the old version in .trash first.
//
// Live preview is deliberately split in two:
//   · the photo is one canvas, drawn once, with the adjustments applied as a
//     CSS `filter` — dragging a slider is then a compositor job, not a redraw
//   · the drawn layers are a second canvas above it, so a red arrow does not
//     go grey when the picture does
// The flattened copy takes the same numbers through imageeditrender.js, so
// what you saw is what gets written.

import { clamp, debounce, h, refocus, keyOf } from "./util.js";
import { icon } from "./icons.js";
import { confirmDialog, inlineEdit, menu, toast } from "./ui.js";
import {
  ADJUST, DEFAULT_ADJUST, PRESETS, adjustFromPreset, countShapes, docChangesPicture, editedName,
  emptyDoc, filterString, flattenLayers, mergeDown, moveLayer, newLayer, nextLayerName,
  normalizeDoc, normalizeCrop, sharpenKernel, moveShape, pickShape, restyleShape, shapeBounds, shapesInRect, TEXT_FONTS,
} from "./imageeditmodel.js";
import { drawShapes, renderDoc } from "./imageeditrender.js";
import { loadDoc, loadImage, saveDoc, forget } from "./imageeditstore.js";
import { colourPop, noteColour, recentColours } from "./colourpop.js";

// the quick row in the rail, until colours you have actually used replace it
const COLOURS = ["#e5484d", "#ffb224", "#46a758", "#3b9eff", "#ffffff", "#000000"];
const SIZE_STEPS = [1, 2, 4, 8];
const TOOLS = [
  ["select", "cursor", "Select: click a mark, drag to move it, Delete removes it. Hold Ctrl to borrow it from any tool", "V"],
  ["snip", "scissors", "Select a piece: drag a box over the picture - nothing changes until you move it. Drag from inside to move that piece (Alt: a copy), Ctrl+C / Ctrl+V copy and paste it, Delete clears it to the colour round it, Ctrl+D lets go", "S"],
  ["pen", "pen", "Brush", "B"],
  ["marker", "marker", "Highlighter", "H"],
  ["line", "minus", "Line · U steps through the shapes", "L"],
  ["arrow", "arrowLine", "Arrow", "A"],
  ["rect", "square", "Rectangle", "R"],
  ["ellipse", "circleShape", "Ellipse", "O"],
  ["text", "caseText", "Text label · double-click one with Select to retype it", "T"],
  ["eraser", "eraser", "Eraser (this layer only)", "E"],
  ["crop", "crop", "Crop: drag the frame or its handles, Enter when done. Nothing is cut from the file - the crop is stored with the edits", "C"],
];

let openEditor = null;

/**
 * Open the editor over a vault picture.
 * `path` is vault-relative, `url` the asset URL the webview can load.
 * Resolves when the editor closes, with { changed, flattened }.
 */
export async function openImageEditor(app, { path, url, onFlatten } = {}) {
  if (openEditor) openEditor.close();
  let img;
  try {
    img = await loadImage(url);
  } catch {
    toast("Could not open that picture for editing", { kind: "error" });
    return { changed: false };
  }
  const IW = img.naturalWidth || img.width;
  const IH = img.naturalHeight || img.height;
  let doc = normalizeDoc(await loadDoc(app, path, { width: IW, height: IH }), { width: IW, height: IH });
  // the picture's edits written the same way whatever order or empty fields they gathered (undo back = the same)
  const canon = (d) => JSON.stringify(d, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().filter((y) => x[y] != null && x[y] !== "" && y !== "modified" && y !== "updated").map((y) => [y, x[y]])) : x));
  // an empty layer changes nothing in the picture: it does not count as a change
  const state = () => canon({ layers: doc.layers.filter((l) => l.shapes && l.shapes.length), adjust: doc.adjust, adjustOn: doc.adjustOn, preset: doc.preset, crop: doc.crop });
  const atOpen = JSON.stringify(doc); // what Cancel goes back to
  const stateAtOpen = state();
  let editedSinceOpen = false; // Done asks for a change first
  let marq = null; // the selection: { x, y, w, h } in the picture's pixels
  let clip = null; // what Ctrl+C kept: the same box
  doc.w = IW;
  doc.h = IH;
  if (!doc.layers.length) doc.layers = [newLayer("Layer 1")];

  const name = path.slice(path.lastIndexOf("/") + 1);
  const unit = Math.max(1, Math.round(Math.min(IW, IH) / 260));
  let tool = ["select", "snip", "pen", "marker", "line", "arrow", "rect", "ellipse", "eraser"].includes(app.settings.ieTool) ? app.settings.ieTool : "pen";
  let colour = COLOURS[0];
  let sizeStep = 1;
  let sizePx = 0; // the brush in picture pixels; the four buttons are only presets of it
  let active = doc.layers.length - 1; // the top layer, the one you draw on
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dirty = false;
  let flattened = null;
  const undoStack = [];
  const redoStack = [];
  let root = null;
  let spaceDown = false; // Space held: the hand, whatever the tool
  const presetPx = (i) => SIZE_STEPS[i] * unit * 2;
  const SIZE_MIN = Math.max(1, unit * 0.5);
  const SIZE_MAX = unit * 80;
  const brush = () => sizePx || presetPx(sizeStep);

  /* ── the two canvases ─────────────────────────────────────────────────── */

  // the photo at its own pixels (capped, so a 6000px panorama is still smooth)
  const BACK_MAX = 2600;
  const bk = Math.min(1, BACK_MAX / Math.max(IW, IH));
  const CW = Math.max(1, Math.round(IW * bk));
  const CH = Math.max(1, Math.round(IH * bk));
  const photo = h("canvas", { class: "ie-photo", width: CW, height: CH });
  photo.getContext("2d").drawImage(img, 0, 0, CW, CH);
  const ink = h("canvas", { class: "ie-ink", width: CW, height: CH });
  const inkCtx = ink.getContext("2d");
  const vignette = h("div", { class: "ie-vignette" });
  // CSS has no sharpen, so the live preview borrows one from SVG. The
  // flattened copy runs the same kernel over the pixels (imageeditrender.js).
  const sharpenSvg = h("div", { class: "ie-defs", "aria-hidden": "true" });
  sharpenSvg.innerHTML = '<svg width="0" height="0"><filter id="ie-sharpen" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 0 0 0 1 0 0 0 0"/></filter></svg>';
  const sharpenMatrix = sharpenSvg.querySelector("feConvolveMatrix");
  const selLayer = h("div", { class: "ie-sel" }); // boxes round the picked marks, and the rubber band
  // the crop: four shades over what is cut away, and a frame with handles while the crop tool is up
  const cropFrame = h("div", { class: "ie-crop-frame" }, ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((d) => h("i", { class: "ie-crop-h is-" + d, dataset: { d } })),
    h("span", { class: "ie-crop-size" }));
  const cropLayer = h("div", { class: "ie-crop" }, h("b"), h("b"), h("b"), h("b"), cropFrame);
  const paper = h("div", { class: "ie-paper" }, photo, vignette, ink, selLayer, cropLayer);
  // the brush itself, drawn at its real size, in place of the mouse pointer
  const ringLabel = h("b", { class: "ie-ring-label" });
  const ring = h("div", { class: "ie-ring", hidden: true }, ringLabel);
  const stage = h("div", { class: "ie-stage", tabIndex: -1 }, paper, ring);

  const layerCache = new Map(); // layer id -> canvas of its shapes
  let preview = null; // the shape being dragged right now

  const scale = () => CW / IW; // picture pixels -> backing pixels
  // what pieces of the picture copy from: the picture, with the adjustments the view shows
  const env = () => ({ src: photo, filter: doc.adjustOn ? filterString(doc.adjust) : "" });
  const hasPieces = () => doc.layers.some((l) => l.shapes.some((s) => s.t === "snip"));

  function cacheFor(layer) {
    let c = layerCache.get(layer.id);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = CW;
    c.height = CH;
    drawShapes(c.getContext("2d"), layer.shapes, scale(), env());
    layerCache.set(layer.id, c);
    return c;
  }
  const invalidate = (id) => { if (id) layerCache.delete(id); else layerCache.clear(); };

  const scratch = document.createElement("canvas");
  scratch.width = CW;
  scratch.height = CH;

  function paintInk() {
    inkCtx.clearRect(0, 0, CW, CH);
    for (const l of doc.layers) {
      if (l.hidden || !l.opacity) continue;
      let src = cacheFor(l);
      if (preview && preview.layerId === l.id && preview.shapes.length) {
        const g = scratch.getContext("2d");
        g.clearRect(0, 0, CW, CH);
        g.drawImage(src, 0, 0);
        drawShapes(g, preview.shapes, scale(), env());
        src = scratch;
      }
      inkCtx.globalAlpha = l.opacity;
      inkCtx.drawImage(src, 0, 0);
    }
    inkCtx.globalAlpha = 1;
  }

  function paintPhoto() {
    const on = doc.adjustOn;
    const a = doc.adjust;
    const css = on ? filterString(a) : "";
    const sharp = on && a.sharpen > 0;
    if (sharp) sharpenMatrix.setAttribute("kernelMatrix", sharpenKernel(a.sharpen).join(" "));
    photo.style.filter = [css, sharp ? "url(#ie-sharpen)" : ""].filter(Boolean).join(" ") || "none";
    vignette.style.opacity = on ? String(clamp((a.vignette || 0) / 100, 0, 1) * 0.78) : "0";
    // pieces of the picture follow its colours
    if (doc && hasPieces()) { invalidate(); paintInk(); }
  }

  /* ── view ─────────────────────────────────────────────────────────────── */

  function layout() {
    const r = stage.getBoundingClientRect();
    const pad = 28;
    const fit = Math.min((r.width - pad * 2) / IW, (r.height - pad * 2) / IH, 4) || 1;
    const w = Math.max(20, IW * fit * zoom);
    paper.style.width = w + "px";
    paper.style.height = (IH * fit * zoom) + "px";
    paper.style.transform = `translate(${panX}px, ${panY}px)`;
    paintCrop();
  }

  /* ── history ──────────────────────────────────────────────────────────── */

  const snapshot = () => JSON.stringify({ layers: doc.layers, adjust: doc.adjust, adjustOn: doc.adjustOn, preset: doc.preset, crop: doc.crop || null });
  function push() {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(json) {
    const s = JSON.parse(json);
    doc.layers = normalizeDoc({ ...doc, layers: s.layers }).layers;
    doc.adjust = s.adjust;
    doc.adjustOn = s.adjustOn;
    doc.preset = s.preset || "";
    doc.crop = normalizeCrop(s.crop);
    active = clamp(active, 0, Math.max(0, doc.layers.length - 1));
    picked.clear(); // the marks were rebuilt: the old objects are gone
    invalidate();
    changed();
    renderLayers();
    renderAdjust();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }

  /* ── saving the sidecar ───────────────────────────────────────────────── */

  const persist = async () => {
    try {
      doc.off = false; // working on the edits switches them back on
      await saveDoc(app, path, doc);
      dirty = false;
      setState("saved");
    } catch (e) {
      setState("error");
      toast("Could not store the edits: " + (e && e.message ? e.message : e), { kind: "error" });
    }
  };
  const persistSoon = debounce(persist, 500);
  function changed() {
    dirty = true;
    editedSinceOpen = true;
    setState("dirty");
    paintPhoto();
    paintInk();
    paintPicked();
    paintCrop();
    updateChrome();
    persistSoon();
  }

  /* ── crop ─────────────────────────────────────────────────────────────── */

  let cropDraft = null; // the frame while it is being dragged
  function paintCrop() {
    const c = cropDraft || doc.crop;
    const on = tool === "crop";
    cropLayer.hidden = !c && !on;
    cropLayer.classList.toggle("is-live", on);
    const r = c || { x: 0, y: 0, w: 1, h: 1 };
    const pc = (v) => (v * 100).toFixed(3) + "%";
    const [top, right, bottom, left] = cropLayer.querySelectorAll("b");
    Object.assign(top.style, { left: 0, top: 0, width: "100%", height: pc(r.y) });
    Object.assign(bottom.style, { left: 0, top: pc(r.y + r.h), width: "100%", height: pc(1 - r.y - r.h) });
    Object.assign(left.style, { left: 0, top: pc(r.y), width: pc(r.x), height: pc(r.h) });
    Object.assign(right.style, { left: pc(r.x + r.w), top: pc(r.y), width: pc(1 - r.x - r.w), height: pc(r.h) });
    Object.assign(cropFrame.style, { left: pc(r.x), top: pc(r.y), width: pc(r.w), height: pc(r.h) });
    cropFrame.querySelector(".ie-crop-size").textContent = `${Math.round(r.w * IW)} × ${Math.round(r.h * IH)}`;
  }
  cropLayer.addEventListener("pointerdown", (e) => {
    if (tool !== "crop" || e.button !== 0 || spaceDown) return;
    e.preventDefault();
    e.stopPropagation();
    const box = paper.getBoundingClientRect();
    const at = (ev) => [clamp((ev.clientX - box.left) / box.width, 0, 1), clamp((ev.clientY - box.top) / box.height, 0, 1)];
    const [x0, y0] = at(e);
    const start = doc.crop ? { ...doc.crop } : { x: 0, y: 0, w: 1, h: 1 };
    const dir = e.target.dataset && e.target.dataset.d;
    const inside = !dir && e.target.closest(".ie-crop-frame");
    try { cropLayer.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const [x, y] = at(ev);
      let { x: l, y: t } = start;
      let r = start.x + start.w;
      let b = start.y + start.h;
      if (dir) {
        if (dir.includes("w")) l = Math.min(x, r - 0.02);
        if (dir.includes("e")) r = Math.max(x, l + 0.02);
        if (dir.includes("n")) t = Math.min(y, b - 0.02);
        if (dir.includes("s")) b = Math.max(y, t + 0.02);
      } else if (inside) {
        const dx = clamp(x - x0, -start.x, 1 - start.x - start.w);
        const dy = clamp(y - y0, -start.y, 1 - start.y - start.h);
        l += dx; r += dx; t += dy; b += dy;
      } else { l = Math.min(x0, x); r = Math.max(x0, x); t = Math.min(y0, y); b = Math.max(y0, y); }
      if (ev.shiftKey && (dir ? dir.length === 2 : !inside)) { // Shift keeps the picture's own shape
        const want = (start.w * IW) / (start.h * IH) || IW / IH;
        const hh = ((r - l) * IW) / want / IH;
        if (!dir || dir.includes("s")) b = Math.min(1, t + hh); else t = Math.max(0, b - hh);
      }
      cropDraft = { x: l, y: t, w: r - l, h: b - t };
      paintCrop();
    };
    const up = () => {
      cropLayer.removeEventListener("pointermove", move);
      cropLayer.removeEventListener("pointerup", up);
      cropLayer.removeEventListener("pointercancel", up);
      const next = cropDraft ? normalizeCrop(cropDraft) : doc.crop;
      cropDraft = null;
      if (JSON.stringify(next) !== JSON.stringify(doc.crop || null)) { push(); doc.crop = next; changed(); } else paintCrop();
    };
    cropLayer.addEventListener("pointermove", move);
    cropLayer.addEventListener("pointerup", up);
    cropLayer.addEventListener("pointercancel", up);
  });
  cropLayer.addEventListener("dblclick", () => { if (tool === "crop") setTool("select"); });
  function clearCrop() { if (!doc.crop) return; push(); doc.crop = null; changed(); }

  const stateEl = h("span", { class: "ie-state", dataset: { state: "saved" }, text: "Stored beside the picture" });
  function setState(s) {
    stateEl.dataset.state = s;
    stateEl.textContent = s === "dirty" ? "Storing…" : s === "error" ? "Not stored" : docChangesPicture(doc) ? "Stored beside the picture" : "No edits";
  }

  /* ── drawing ──────────────────────────────────────────────────────────── */

  const activeLayer = () => doc.layers[active] || null;

  function toImage(e) {
    const r = ink.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * IW, ((e.clientY - r.top) / r.height) * IH];
  }

  function commit(shape) {
    const l = activeLayer();
    if (!l || !shape) return;
    if (shape.c) { noteColour(shape.c); paintSwatches(); }
    push();
    l.shapes.push(shape);
    invalidate(l.id);
    changed();
    renderLayers();
  }

  let textBox = null;
  function closeText(commitIt) {
    if (!textBox) return;
    const { el, x, y, size, editing, recoloured } = textBox;
    const value = el.value;
    textBox = null;
    el.remove();
    if (editing) {
      // an existing label: it was hidden while the box stood in for it
      const { layer: l, shape } = editing;
      const at = l.shapes.indexOf(shape);
      delete shape.ghost;
      if (at >= 0 && commitIt && (value !== shape.text || recoloured)) {
        push();
        if (value.trim()) { l.shapes[at] = { ...shape, text: value, c: recoloured ? colour : shape.c }; picked.clear(); picked.add(l.shapes[at]); }
        else { l.shapes.splice(at, 1); picked.clear(); }
        invalidate(l.id);
        changed();
        renderLayers();
      } else { invalidate(l.id); paintInk(); paintPicked(); }
      return;
    }
    if (commitIt && value.trim()) commit({ t: "text", c: colour, x, y, size, text: value, alpha: 1, ...textLook() });
  }
  function placeText(ix, iy, editing = null) {
    closeText(true);
    const l = editing ? editing.layer : activeLayer();
    if (!l || l.hidden) return toast("That layer is hidden — show it first");
    const size = editing ? editing.shape.size : Math.max(10, brush() * 3);
    const r = ink.getBoundingClientRect();
    const k = r.width / IW;
    const el = h("textarea", {
      class: "ie-textbox", rows: 1, spellcheck: false,
      style: { left: `${ix * k}px`, top: `${iy * k}px`, fontSize: `${size * k}px`, color: colour },
    });
    const grow = () => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; el.style.width = Math.max(60, el.scrollWidth + 8) + "px"; };
    el.addEventListener("input", grow);
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); closeText(false); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); closeText(true); }
    });
    el.addEventListener("blur", () => closeText(true));
    paper.append(el);
    textBox = { el, x: ix, y: iy, size, editing };
    if (editing) {
      el.value = editing.shape.text;
      el.style.color = editing.shape.c;
      editing.shape.ghost = true;
      invalidate(l.id);
      paintInk();
      paintPicked();
    }
    requestAnimationFrame(() => { el.focus(); if (editing) el.select(); grow(); });
  }

  /* ── picking marks: select, move, delete ──────────────────────────────── */

  // Every mark is its own object in the sidecar, so it can be picked up again.
  // The set holds the objects themselves; anything that rebuilds them clears it.
  const picked = new Set();
  const measureCtx = document.createElement("canvas").getContext("2d");
  const measure = (text, size, font) => {
    measureCtx.font = `600 ${size}px ${TEXT_FONTS[font] || TEXT_FONTS.sans}`;
    return Math.max(...String(text).split("\n").map((line) => measureCtx.measureText(line).width));
  };
  /** Slack for a click, in picture pixels: about five screen pixels at any zoom. */
  const slack = () => { const r = ink.getBoundingClientRect(); return 5 * (IW / Math.max(1, r.width)); };

  const where = (shape) => {
    for (let li = 0; li < doc.layers.length; li++) { const si = doc.layers[li].shapes.indexOf(shape); if (si >= 0) return { li, si }; }
    return null;
  };

  function paintPicked(band = null) {
    const kids = [];
    for (const s of picked) {
      if (s.ghost || !where(s)) continue;
      const b = shapeBounds(s, measure);
      if (!b) continue;
      kids.push(h("i", { class: "ie-selbox", style: { left: `${(b.x0 / IW) * 100}%`, top: `${(b.y0 / IH) * 100}%`, width: `${((b.x1 - b.x0) / IW) * 100}%`, height: `${((b.y1 - b.y0) / IH) * 100}%` } }));
    }
    if (marq) kids.push(h("i", { class: "ie-marq", style: { left: `${(marq.x / IW) * 100}%`, top: `${(marq.y / IH) * 100}%`, width: `${(marq.w / IW) * 100}%`, height: `${(marq.h / IH) * 100}%` } }));
    if (band) kids.push(h("i", { class: "ie-band", style: { left: `${(Math.min(band.x0, band.x1) / IW) * 100}%`, top: `${(Math.min(band.y0, band.y1) / IH) * 100}%`, width: `${(Math.abs(band.x1 - band.x0) / IW) * 100}%`, height: `${(Math.abs(band.y1 - band.y0) / IH) * 100}%` } }));
    selLayer.replaceChildren(...kids);
    root?.classList.toggle("has-picked", picked.size > 0);
  }

  function pick(shapes, { add = false } = {}) {
    // a piece of the picture picked comes up over the others on its layer, so what you work on is in front
    for (const sh of shapes) {
      if (!sh || sh.t !== "snip") continue;
      const at = where(sh);
      if (!at) continue;
      const l = doc.layers[at.li];
      if (at.si !== l.shapes.length - 1) { l.shapes.splice(at.si, 1); l.shapes.push(sh); invalidate(l.id); paintInk(); }
    }
    if (!add) picked.clear();
    for (const s of shapes) picked.add(s);
    if (typeof paintOpts === "function") paintOpts();
    // the layer of what you picked becomes the one you work on
    const first = [...picked].map(where).find(Boolean);
    if (first && first.li !== active) { active = first.li; renderLayers(); }
    paintPicked();
    updateChrome();
  }

  /** Swap every picked mark for `fn(mark)` (null removes it) as one undo step. */
  function editPicked(fn) {
    const list = [...picked].filter(where);
    if (!list.length) return false;
    push();
    picked.clear();
    for (const s of list) {
      const at = where(s);
      const l = doc.layers[at.li];
      const next = fn(s);
      if (next) { l.shapes[at.si] = next; picked.add(next); }
      else l.shapes.splice(at.si, 1);
      invalidate(l.id);
    }
    changed();
    renderLayers();
    return true;
  }

  const deletePicked = () => { const n = picked.size; if (editPicked(() => null)) toast(n === 1 ? "Removed · Ctrl Z brings it back" : `${n} marks removed · Ctrl Z brings them back`, { ms: 1800 }); };
  const nudgePicked = (dx, dy) => editPicked((s) => moveShape(s, dx, dy));
  function duplicatePicked() {
    const list = [...picked].filter(where);
    if (!list.length) return;
    push();
    picked.clear();
    const off = Math.max(8, unit * 6);
    for (const s of list) {
      const l = doc.layers[where(s).li];
      const copy = moveShape(structuredClone(s), off, off);
      l.shapes.push(copy);
      picked.add(copy);
      invalidate(l.id);
    }
    changed();
    renderLayers();
  }
  /** To the front or the back of its own layer. */
  function restack(front) {
    const list = [...picked].filter(where);
    if (!list.length) return;
    push();
    for (const l of doc.layers) {
      const mine = l.shapes.filter((s) => list.includes(s));
      if (!mine.length) continue;
      const rest = l.shapes.filter((s) => !list.includes(s));
      l.shapes = front ? [...rest, ...mine] : [...mine, ...rest];
      invalidate(l.id);
    }
    changed();
  }
  function selectAllMarks() {
    const all = [];
    for (const l of doc.layers) if (!l.hidden && l.opacity) for (const s of l.shapes) if (shapeBounds(s, measure)) all.push(s);
    setTool("select");
    pick(all);
  }

  function pickedMenu(x, y) {
    const n = picked.size;
    menu(x, y, [
      { header: n === 1 ? "This mark" : `${n} marks` },
      { label: "Duplicate", icon: "clipboard", keys: "Ctrl J", run: duplicatePicked },
      { label: "Bring to the front", icon: "arrowUp", run: () => restack(true) },
      { label: "Send to the back", icon: "arrowDown", run: () => restack(false) },
      "sep",
      { label: "Delete", icon: "trash", keys: "Del", danger: true, run: deletePicked },
    ]);
  }

  function selectDown(e, x0, y0) {
    const hit = pickShape(doc.layers, x0, y0, slack(), measure);
    const shape = hit ? doc.layers[hit.layer].shapes[hit.index] : null;
    const toggle = e.shiftKey;
    if (shape) {
      if (toggle && picked.has(shape)) { picked.delete(shape); paintPicked(); updateChrome(); return; }
      if (!picked.has(shape)) pick([shape], { add: toggle });
    } else if (!toggle) pick([]);
    e.preventDefault();
    try { ink.setPointerCapture(e.pointerId); } catch {}
    // dragging a mark moves everything picked; dragging empty picture rubber-bands
    const moving = shape ? [...picked].map((s) => ({ s, at: where(s) })).filter((m) => m.at) : null;
    const keep = shape ? null : new Set(picked);
    let started = false;
    const move = (ev) => {
      const [x, y] = toImage(ev);
      if (moving) {
        if (!started && Math.hypot(x - x0, y - y0) < slack() * 0.6) return;
        if (!started) { started = true; push(); root.classList.add("is-moving"); }
        let dx = x - x0;
        let dy = y - y0;
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } // Shift keeps it level
        picked.clear();
        for (const m of moving) {
          const l = doc.layers[m.at.li];
          const next = moveShape(m.s, dx, dy);
          l.shapes[m.at.si] = next;
          picked.add(next);
          invalidate(l.id);
        }
        paintInk();
        paintPicked();
      } else {
        const band = { x0, y0, x1: x, y1: y };
        picked.clear();
        for (const s of keep) picked.add(s);
        for (const r of shapesInRect(doc.layers, band, measure)) picked.add(doc.layers[r.layer].shapes[r.index]);
        paintPicked(band);
      }
    };
    const up = () => {
      ink.removeEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.removeEventListener(t, up);
      root.classList.remove("is-moving");
      if (started) { changed(); renderLayers(); }
      else { pick([...picked], { add: true }); }
    };
    ink.addEventListener("pointermove", move);
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.addEventListener(t, up);
  }

  ink.addEventListener("dblclick", (e) => {
    if (tool !== "select" && !e.ctrlKey) return;
    const [x, y] = toImage(e);
    const hit = pickShape(doc.layers, x, y, slack(), measure);
    const s = hit && doc.layers[hit.layer].shapes[hit.index];
    if (s && s.t === "text") { e.preventDefault(); placeText(s.x, s.y, { layer: doc.layers[hit.layer], shape: s }); }
  });
  ink.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (eatMenu) { eatMenu = false; return; }
    const [x, y] = toImage(e);
    const hit = pickShape(doc.layers, x, y, slack(), measure);
    if (!hit) return;
    const s = doc.layers[hit.layer].shapes[hit.index];
    if (!picked.has(s)) pick([s]);
    pickedMenu(e.clientX, e.clientY);
  });

  /* ── the brush as the pointer ─────────────────────────────────────────── */

  const FREEHAND = new Set(["pen", "marker", "eraser"]);
  let ringAt = null;
  let hudAt = null; // where a Ctrl+Alt+drag started: the ring stays there while it is resized

  /** Ctrl+Alt+drag (or Alt + right-drag): the brush resized where you are looking, as in Photoshop and Affinity. */
  function startSizeDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    try { ink.setPointerCapture(e.pointerId); } catch {}
    const x0 = e.clientX;
    const start = brush();
    const k = IW / Math.max(1, ink.getBoundingClientRect().width); // screen pixels -> picture pixels
    hudAt = { x: e.clientX, y: e.clientY };
    if (e.button === 2) eatMenu = true;
    const move = (ev) => setSizePx(start + (ev.clientX - x0) * k / (tool === "marker" ? 2.2 : 1));
    const up = () => {
      ink.removeEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.removeEventListener(t, up);
      hudAt = null;
      paintRing(true);
    };
    ink.addEventListener("pointermove", move);
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.addEventListener(t, up);
    paintRing(true);
  }
  let eatMenu = false;

  /** Alt+click: the colour under the pointer, drawing included. */
  function pickColourAt(e) {
    const [x, y] = toImage(e);
    const px = Math.floor(x * scale());
    const py = Math.floor(y * scale());
    if (px < 0 || py < 0 || px >= CW || py >= CH) return;
    const one = document.createElement("canvas");
    one.width = one.height = 1;
    const g = one.getContext("2d");
    g.drawImage(photo, px, py, 1, 1, 0, 0, 1, 1);
    g.drawImage(ink, px, py, 1, 1, 0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    const c = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    setColour(c, { restyle: false });
    noteColour(c);
    paintSwatches();
  }
  let ringFlash = 0;
  function paintRing(flash = false) {
    const r = ink.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    if (flash) { // the size just changed: say it, and show the ring even with the pointer elsewhere
      ringLabel.textContent = `${Math.round(brush() * (tool === "marker" ? 2.2 : 1))} px`;
      ring.classList.add("is-flash");
      clearTimeout(ringFlash);
      ringFlash = setTimeout(() => { ring.classList.remove("is-flash"); paintRing(); }, 900);
    }
    const flashing = ring.classList.contains("is-flash");
    const at = hudAt || ringAt || (flashing ? { x: s.left + s.width / 2, y: s.top + s.height / 2 } : null);
    const show = at && (flashing || (FREEHAND.has(tool) && !spaceDown && !at.ctrl));
    ring.hidden = !show;
    if (!show) return;
    const d = Math.max(4, brush() * (tool === "marker" ? 2.2 : 1) * (r.width / IW));
    ring.style.width = ring.style.height = d + "px";
    ring.style.transform = `translate(${at.x - s.left - d / 2}px, ${at.y - s.top - d / 2}px)`;
    ring.dataset.tool = tool;
    ring.style.setProperty("--ring", tool === "eraser" ? "#fff" : colour);
  }
  ink.addEventListener("pointermove", (e) => { ringAt = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey }; paintRing(); });
  ink.addEventListener("pointerenter", (e) => { ringAt = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey }; paintRing(); });
  ink.addEventListener("pointerleave", () => { ringAt = null; paintRing(); });

  ink.addEventListener("pointerdown", (e) => {
    if (e.altKey && (e.button === 2 || (e.button === 0 && e.ctrlKey))) return startSizeDrag(e);
    if (e.button === 1 || e.button === 2 || spaceDown) return; // pan / menu
    if (e.altKey && e.button === 0 && tool !== "select") { e.preventDefault(); return pickColourAt(e); }
    const [x0, y0] = toImage(e);
    if (tool === "select" || e.ctrlKey) { closeText(true); return selectDown(e, x0, y0); }
    if (tool === "snip" && !e.shiftKey && e.button === 0) { closeText(true); return marqDown(e, x0, y0); }
    if (e.shiftKey) return; // Shift-drag pans, as it always has
    const l = activeLayer();
    if (!l) return;
    if (l.hidden) return toast("That layer is hidden — show it first");
    if (picked.size) pick([]);
    if (tool === "text") { e.preventDefault(); placeText(x0, y0); return; }
    closeText(true);
    e.preventDefault();
    try { ink.setPointerCapture(e.pointerId); } catch {}
    const w = brush();
    const freehand = tool === "pen" || tool === "marker" || tool === "eraser";
    const base = freehand
      ? { t: tool === "eraser" ? "erase" : tool, w: tool === "marker" ? w * 2.2 : w, pts: [x0, y0], alpha: 1 }
      : null;
    if (tool !== "eraser" && base) base.c = colour;
    let shape = base;
    let last = [x0, y0];
    preview = { layerId: l.id, shapes: shape ? [shape] : [] };
    let raf = 0;
    const frame = () => { raf = 0; paintInk(); };
    const nudge = () => { if (!raf) raf = requestAnimationFrame(frame); };

    const move = (ev) => {
      const [x, y] = toImage(ev);
      if (freehand) {
        if (Math.hypot(x - last[0], y - last[1]) < Math.max(0.6, w * 0.12)) return;
        last = [x, y];
        shape.pts.push(x, y);
      } else {
        shape = shapeFor(tool, x0, y0, x, y, w, colour);
        preview.shapes = [shape];
      }
      nudge();
    };
    const up = (ev) => {
      ink.removeEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.removeEventListener(t, up);
      if (raf) cancelAnimationFrame(raf);
      const done = preview;
      preview = null;
      if (!freehand && ev && ev.type === "pointerup") {
        const [x, y] = toImage(ev);
        if (Math.hypot(x - x0, y - y0) < w) { paintInk(); return; } // a click, not a drag
        shape = shapeFor(tool, x0, y0, x, y, w, colour);
      }
      if (tool === "snip") { paintInk(); return; }
      if (done && shape) commit(shape);
      else paintInk();
    };
    ink.addEventListener("pointermove", move);
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) ink.addEventListener(t, up);
    paintInk();
  });

  /* A piece of the picture, lifted: the dragged rectangle becomes a mark of its own that moves like any other.
     Its old place is filled with the colour round it (the average of its edge), unless the original stays. */
  let keepOriginal = !!app.settings.iePieceCopy;
  function liftPiece(r0, { copy = keepOriginal, gone = false, dx = 0, dy = 0 } = {}) {
    const rw0 = r0.rw ?? r0.w, rh0 = r0.rh ?? r0.h;
    const x1 = clamp(r0.x, 0, IW), y1 = clamp(r0.y, 0, IH), x2 = clamp(r0.x + rw0, 0, IW), y2 = clamp(r0.y + rh0, 0, IH);
    const r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    const sx = clamp(Math.round(r.x), 0, IW - 1), sy = clamp(Math.round(r.y), 0, IH - 1);
    const sw = clamp(Math.round(r.w), 1, IW - sx), sh = clamp(Math.round(r.h), 1, IH - sy);
    if (sw < 3 || sh < 3) return null;
    const s = { t: "snip", sx, sy, sw, sh, x: sx + dx, y: sy + dy, z: 1, alpha: gone ? 0 : 1 };
    if (!copy) { s.hole = true; s.fill = edgeColour(sx, sy, sw, sh); }
    commit(s);
    pick(gone ? [] : [s]);
    return s;
  }

  /* The selection, as Photoshop's marquee: a box over the picture that changes nothing by itself. Drag
     from inside it and the piece under it comes along (Alt: a copy, the original stays); Ctrl+C keeps it
     (and puts the pixels on the clipboard), Ctrl+V lays a copy down; Delete clears it; Ctrl+D lets go. */
  const inMarq = (x, y) => marq && x >= marq.x && x <= marq.x + marq.w && y >= marq.y && y <= marq.y + marq.h;
  function marqDown(e, x0, y0) {
    e.preventDefault();
    // a piece already lifted (or pasted) moves where it is pressed
    const hit = pickShape(doc.layers, x0, y0, slack(), measure);
    const hitShape = hit ? doc.layers[hit.layer].shapes[hit.index] : null;
    if (hitShape && hitShape.t === "snip" && !inMarq(x0, y0)) { marq = null; return selectDown(e, x0, y0); }
    if (inMarq(x0, y0)) {
      let s = liftPiece(marq, { copy: e.altKey || keepOriginal });
      marq = null;
      if (!s) return;
      // the piece follows the pointer (on the window: lifting it redraws, and the canvas lets go of the pointer)
      const l = activeLayer();
      const from = s;
      const move = (ev) => {
        const [x, y] = toImage(ev);
        let dx = x - x0, dy = y - y0;
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const i = l.shapes.indexOf(s);
        if (i < 0) return;
        s = moveShape(from, dx, dy);
        l.shapes[i] = s;
        picked.clear(); picked.add(s);
        invalidate(l.id);
        paintInk();
        paintPicked();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        changed();
        renderLayers();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    if (picked.size) pick([]);
    try { ink.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const [x, y] = toImage(ev);
      const ax = Math.min(x0, x), ay = Math.min(y0, y), bx = Math.max(x0, x), by = Math.max(y0, y);
      marq = { x: ax, y: ay, w: bx - ax, h: by - ay };
      paintPicked();
    };
    const up = () => {
      ink.removeEventListener("pointermove", move);
      ink.removeEventListener("pointerup", up);
      if (marq && (marq.w < 3 || marq.h < 3)) marq = null; // a click lets go
      paintPicked();
      updateChrome();
    };
    marq = null;
    paintPicked();
    ink.addEventListener("pointermove", move);
    ink.addEventListener("pointerup", up);
  }
  /** The selection's pixels, as the picture looks now, as a PNG blob. */
  async function marqBlob(r) {
    const k = scale();
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(r.w * k)); c.height = Math.max(1, Math.round(r.h * k));
    const g = c.getContext("2d");
    g.filter = env().filter || "none";
    g.drawImage(photo, -r.x * k, -r.y * k);
    return new Promise((ok) => c.toBlob(ok, "image/png"));
  }
  function copyMarq() {
    clip = { ...marq };
    marq = null; // copied: the box lets go, so a drag after it is a new selection, not the original moving
    paintPicked();
    marqBlob(marq).then((b) => b && navigator.clipboard.write([new ClipboardItem({ "image/png": b })])).catch(() => {});
    toast("Copied - Ctrl+V lays it down", { ms: 1600 });
  }
  function pasteClip() {
    const off = Math.max(8, unit * 6);
    const s = liftPiece(clip, { copy: true, dx: off, dy: off });
    if (s) toast("Pasted - drag it where it goes", { ms: 1600 });
  }
  // the average colour just outside a rectangle of the picture (as it looks now)
  function edgeColour(sx, sy, sw, sh) {
    const k = scale();
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(CW)); c.height = Math.max(1, Math.round(CH));
    const g = c.getContext("2d", { willReadFrequently: true });
    g.filter = env().filter || "none";
    g.drawImage(photo, 0, 0);
    const x0 = Math.max(0, Math.floor((sx - 1) * k)), y0 = Math.max(0, Math.floor((sy - 1) * k));
    const x1 = Math.min(CW - 1, Math.ceil((sx + sw + 1) * k)), y1 = Math.min(CH - 1, Math.ceil((sy + sh + 1) * k));
    let r = 0, gr = 0, b = 0, n = 0;
    const take = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; r += d[0]; gr += d[1]; b += d[2]; n++; };
    const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 40));
    for (let x = x0; x <= x1; x += step) { take(x, y0); take(x, y1); }
    for (let y = y0; y <= y1; y += step) { take(x0, y); take(x1, y); }
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, "0");
    return n ? "#" + hex(r) + hex(gr) + hex(b) : "#000000";
  }

  function shapeFor(t, x0, y0, x, y, w, c) {
    if (t === "snip") return { t: "rect", c: "#ffffff", w: Math.max(1, 1.5 / scale()), x: Math.min(x0, x), y: Math.min(y0, y), rw: Math.abs(x - x0), rh: Math.abs(y - y0), alpha: 0.9 };
    if (t === "line" || t === "arrow") return { t: "line", c, w, x1: x0, y1: y0, x2: x, y2: y, alpha: 1, ...(t === "arrow" ? { arrow: true } : {}) };
    return { t, c, w, x: Math.min(x0, x), y: Math.min(y0, y), rw: Math.abs(x - x0), rh: Math.abs(y - y0), alpha: 1 };
  }

  /* ── pan and zoom ─────────────────────────────────────────────────────── */

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const z = clamp(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.25, 8);
    if (z === zoom) return;
    // towards the pointer, the way every picture editor zooms
    const r = paper.getBoundingClientRect();
    const fx = (e.clientX - (r.left + r.width / 2)) / r.width;
    const fy = (e.clientY - (r.top + r.height / 2)) / r.height;
    const grow = z / zoom - 1;
    panX -= fx * r.width * grow;
    panY -= fy * r.height * grow;
    zoom = z;
    layout();
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
    paintRing();
  }, { passive: false });
  stage.addEventListener("pointerdown", (e) => {
    const onInk = e.target === ink;
    if (tool === "snip" && !onInk && e.button === 0 && !spaceDown && !e.shiftKey && (e.target === stage || e.target === paper)) { const [x, y] = toImage(e); return marqDown(e, x, y); }
    const wants = e.button === 1 || (e.button === 0 && (spaceDown || (e.shiftKey && !(onInk && (tool === "select" || e.ctrlKey)))));
    if (!wants) { if (e.button === 0 && !onInk && e.target === stage && picked.size) pick([]); return; }
    e.preventDefault();
    const sx = e.clientX - panX;
    const sy = e.clientY - panY;
    stage.classList.add("is-panning");
    const move = (ev) => { panX = ev.clientX - sx; panY = ev.clientY - sy; layout(); };
    const up = () => {
      stage.removeEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel"]) stage.removeEventListener(t, up);
      stage.classList.remove("is-panning");
    };
    stage.addEventListener("pointermove", move);
    for (const t of ["pointerup", "pointercancel"]) stage.addEventListener(t, up);
  });
  stage.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });

  /* ── left rail: tools, colours, sizes ─────────────────────────────────── */

  const toolBtns = new Map();
  const rail = h("div", { class: "ie-rail" },
    h("div", { class: "ie-tools" }, TOOLS.map(([id, ic, label, key]) => {
      const b = h("button", { class: "ie-tool", title: `${label} · ${key}`, "aria-label": label, dataset: { key }, onclick: () => setTool(id) }, icon(ic));
      toolBtns.set(id, b);
      return b;
    })),
    h("div", { class: "ie-rail-sep" }),
    h("button", { class: "ie-colour", title: "Colour · K · Alt+click the picture to take a colour from it", onclick: (e) => openColours(e.currentTarget) }, h("i")),
    h("div", { class: "ie-swatches" }),
    h("div", { class: "ie-rail-sep" }),
    h("div", { class: "ie-sizes" }, SIZE_STEPS.map((s, i) =>
      h("button", { class: "ie-size", dataset: { i: String(i) }, title: `Brush size ${i + 1} · [ and ] change it gradually · Ctrl+Alt+drag on the picture sets it by hand`, onclick: () => setSize(i) }, h("i", { style: { width: `${4 + i * 5}px`, height: `${4 + i * 5}px` } })))),
    h("div", { class: "ie-opts" }));

  /* The text's look - a background behind it, the dark outline, the font - for new labels and the picked ones;
     and for the Piece tool, whether the original stays. Shown under the sizes when they apply. */
  const BGS = [["", "No background"], ["rgba(0,0,0,.72)", "Dark background"], ["rgba(255,255,255,.88)", "Light background"]];
  const FONTS = [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]];
  let textBg = typeof app.settings.ieTextBg === "string" ? app.settings.ieTextBg : "";
  let textRim = app.settings.ieTextRim !== false;
  let textFont = FONTS.some(([f]) => f === app.settings.ieTextFont) ? app.settings.ieTextFont : "sans";
  const textLook = () => ({ ...(textBg ? { bg: textBg } : {}), ...(textRim ? {} : { rim: false }), ...(textFont !== "sans" ? { font: textFont } : {}) });
  const pickedTexts = () => [...picked].filter((s) => s.t === "text");
  function setTextLook(change) {
    if (change.bg !== undefined) { textBg = change.bg; app.setSetting("ieTextBg", textBg); }
    if (change.rim !== undefined) { textRim = change.rim; app.setSetting("ieTextRim", textRim); }
    if (change.font !== undefined) { textFont = change.font; app.setSetting("ieTextFont", textFont); }
    if (pickedTexts().length) editPicked((s) => (s.t === "text" ? normalizeTextLook({ ...s, ...change }) : s));
    if (textBox) textBox.el.style.fontFamily = TEXT_FONTS[textFont];
    paintOpts();
  }
  const normalizeTextLook = (s) => { const o = { ...s }; if (!o.bg) delete o.bg; if (o.rim !== false) delete o.rim; if (!o.font || o.font === "sans") delete o.font; return o; };
  function paintOpts() {
    const box = rail.querySelector(".ie-opts");
    const texts = pickedTexts();
    const showText = tool === "text" || texts.length;
    const kids = [];
    if (showText) {
      const t0 = texts[0];
      const bg = t0 ? t0.bg || "" : textBg, rim = t0 ? t0.rim !== false : textRim, font = t0 ? t0.font || "sans" : textFont;
      const bi = Math.max(0, BGS.findIndex(([v]) => v === bg));
      const fi = Math.max(0, FONTS.findIndex(([f]) => f === font));
      kids.push(h("div", { class: "ie-rail-sep" }),
        h("button", { class: "ie-tool ie-opt" + (bg ? " is-on" : ""), title: `${BGS[bi][1]} - click for the next`, onclick: () => setTextLook({ bg: BGS[(bi + 1) % BGS.length][0] }) },
          h("span", { class: "ie-opt-bg", style: { background: bg || "transparent" } }, "A")),
        h("button", { class: "ie-tool ie-opt" + (rim ? " is-on" : ""), title: rim ? "Outline round the letters: on" : "Outline round the letters: off", onclick: () => setTextLook({ rim: !rim }) }, icon("contrast")),
        h("button", { class: "ie-tool ie-opt", title: `Font: ${FONTS[fi][1]} - click for the next`, onclick: () => setTextLook({ font: FONTS[(fi + 1) % FONTS.length][0] }) },
          h("span", { class: "ie-opt-font", style: { fontFamily: TEXT_FONTS[font] } }, "Aa")));
    }
    if (tool === "snip") {
      kids.push(h("div", { class: "ie-rail-sep" }),
        h("button", { class: "ie-tool ie-opt" + (keepOriginal ? " is-on" : ""), title: keepOriginal ? "The original stays - a copy is lifted" : "The original's place fills with the colour round it - click to keep the original",
          onclick: () => { keepOriginal = !keepOriginal; app.setSetting("iePieceCopy", keepOriginal); paintOpts(); } }, icon("layers")));
    }
    box.replaceChildren(...kids);
  }

  function setTool(t) {
    closeText(true);
    if (t !== "select" && tool === "select" && picked.size) pick([]);
    tool = t;
    if (t !== "crop" && t !== "text") app.setSetting("ieTool", t); // the next picture opens with it
    for (const [id, b] of toolBtns) b.classList.toggle("is-on", id === t);
    paintOpts();
    ink.dataset.tool = t;
    paintRing();
    paintCrop();
  }
  function setColour(c, { restyle = true } = {}) {
    colour = c;
    // with marks picked, a swatch recolours them
    if (restyle && picked.size) editPicked((s) => restyleShape(s, { c }));
    paintRing();
    paintSwatches();
    if (textBox) { textBox.el.style.color = c; textBox.recoloured = true; }
  }
  function paintSwatches() {
    const quick = [...new Set([...recentColours(), ...COLOURS].map((c) => c.toLowerCase()))].slice(0, 6);
    rail.querySelector(".ie-swatches").replaceChildren(...quick.map((c) =>
      h("button", { class: "ie-swatch" + (c === colour.toLowerCase() ? " is-on" : ""), dataset: { c }, title: c, style: { "--sw": c }, onclick: () => setColour(c) })));
    rail.querySelector(".ie-colour i").style.background = colour;
  }
  let closeColours = null;
  function openColours(anchor) {
    if (closeColours) { closeColours(); return; }
    const before = colour;
    closeColours = colourPop(anchor, {
      value: colour, title: picked.size ? "Colour of what is picked" : "Colour",
      onPick: (c) => setColour(c, { restyle: false }),
      // dragging through the picker is not forty undo steps: what is picked is recoloured once, at the end
      onClose: (c) => { closeColours = null; noteColour(c); if (picked.size && c.toLowerCase() !== before.toLowerCase()) editPicked((s) => restyleShape(s, { c })); paintSwatches(); root.focus(); },
    });
  }

  function setSize(i) {
    sizeStep = clamp(i, 0, SIZE_STEPS.length - 1);
    setSizePx(presetPx(sizeStep), { restyle: true });
  }
  /** Any size, not just the four: what [ and ] and Ctrl+Alt+drag move. */
  function setSizePx(px, { restyle = false, quiet = false } = {}) {
    const was = brush();
    sizePx = clamp(px, SIZE_MIN, SIZE_MAX);
    for (const b of rail.querySelectorAll(".ie-size")) b.classList.toggle("is-on", Math.abs(presetPx(+b.dataset.i) - sizePx) < 0.01);
    if (restyle && was !== sizePx && picked.size && tool === "select") editPicked((s) => restyleShape(s, { w: brush() }));
    paintRing(!quiet);
  }
  let stepAt = 0;
  function stepSize(dir, repeat) {
    // one press is a small, even step; held down it glides, and never faster than the eye can stop it
    const now = performance.now();
    if (repeat && now - stepAt < 30) return;
    stepAt = now;
    const by = Math.max(unit * 0.5, brush() * (repeat ? 0.08 : 0.1));
    setSizePx(brush() + dir * by);
  }

  /* ── right panel: layers ──────────────────────────────────────────────── */

  const layerList = h("div", { class: "ie-layers" });
  const layerHint = h("p", { class: "ie-hint", text: "The picture itself is the bottom layer and is never written to. Everything you draw goes above it." });

  function renderLayers() {
    const rows = [];
    // top of the list is the top of the picture, the way a drawing app stacks
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      const n = countShapes(l.shapes);
      const nameEl = h("span", { class: "ie-ln-name", text: l.name });
      const row = h("div", {
        class: "ie-ln" + (i === active ? " is-active" : "") + (l.hidden ? " is-hidden" : ""),
        onclick: () => { active = i; renderLayers(); },
        oncontextmenu: (e) => { e.preventDefault(); active = i; renderLayers(); layerMenu(i, e.clientX, e.clientY); },
      },
        h("button", {
          class: "ie-ln-eye", title: l.hidden ? "Show this layer" : "Hide this layer",
          onclick: (e) => { e.stopPropagation(); push(); l.hidden = !l.hidden; changed(); renderLayers(); },
        }, icon(l.hidden ? "square" : "eye")),
        h("div", { class: "ie-ln-body" },
          h("div", { class: "ie-ln-top" },
            nameEl,
            h("span", { class: "ie-ln-count", text: n ? `${n}` : "" })),
          h("input", {
            class: "ie-ln-op", type: "range", min: "0", max: "100", step: "1", value: String(Math.round(l.opacity * 100)),
            title: "Layer opacity",
            onpointerdown: (e) => e.stopPropagation(),
            oninput: (e) => { l.opacity = +e.target.value / 100; paintInk(); dirty = true; setState("dirty"); persistSoon(); },
            onchange: () => { push(); changed(); },
          })),
        h("button", {
          class: "ie-ln-more", title: "More", "aria-label": "Layer actions",
          // renderLayers() rebuilds the rows, so the button that was clicked no longer
          // exists: the menu has to hang from its replacement
          onclick: (e) => { e.stopPropagation(); active = i; renderLayers(); layerMenu(i, 0, 0, layerList.querySelector(".ie-ln.is-active .ie-ln-more")); },
        }, icon("more")));
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        inlineEdit(nameEl, l.name, { className: "ie-ln-edit", onCommit: (v) => { push(); l.name = v.trim() || l.name; changed(); renderLayers(); }, onCancel: () => renderLayers() });
      });
      rows.push(row);
    }
    layerList.replaceChildren(...rows);
    updateChrome();
  }

  function layerMenu(i, x, y, anchor) {
    const l = doc.layers[i];
    if (!l) return;
    menu(x, y, [
      { label: "Rename…", icon: "edit", run: () => { const el = layerList.querySelector(".ie-ln.is-active .ie-ln-name"); if (el) el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); } },
      { label: "Duplicate", icon: "clipboard", run: () => { push(); doc.layers.splice(i + 1, 0, { ...newLayer(l.name + " copy"), hidden: l.hidden, opacity: l.opacity, shapes: structuredClone(l.shapes) }); active = i + 1; changed(); renderLayers(); } },
      "sep",
      { label: "Move up", icon: "arrowUp", run: () => reorder(i, i + 1) },
      { label: "Move down", icon: "arrowDown", run: () => reorder(i, i - 1) },
      { label: "Merge down", icon: "layers", run: () => doMerge(i) },
      { label: "Merge all layers", icon: "layers", run: () => doFlattenLayers() },
      "sep",
      { label: "Select everything on it", icon: "cursor", run: () => { setTool("select"); pick(l.shapes.filter((s) => shapeBounds(s, measure))); } },
      { label: "Clear this layer", icon: "undo", run: () => { push(); l.shapes = []; picked.clear(); invalidate(l.id); changed(); renderLayers(); } },
      { label: "Delete layer", icon: "trash", danger: true, run: () => removeLayer(i) },
    ], anchor ? { anchor } : {});
  }

  function reorder(from, to) {
    if (to < 0 || to >= doc.layers.length) return;
    push();
    doc.layers = moveLayer(doc.layers, from, to);
    active = to;
    changed();
    renderLayers();
  }
  function doMerge(i) {
    if (i <= 0) return toast("This is the bottom layer — there is nothing under it");
    push();
    doc.layers = mergeDown(doc.layers, i);
    active = clamp(i - 1, 0, doc.layers.length - 1);
    invalidate();
    changed();
    renderLayers();
    toast("Layers merged", { ms: 1600 });
  }
  function doFlattenLayers() {
    if (doc.layers.length < 2) return;
    push();
    doc.layers = flattenLayers(doc.layers, "Drawing");
    active = 0;
    invalidate();
    changed();
    renderLayers();
    toast("Every layer merged into one", { ms: 1800 });
  }
  function removeLayer(i) {
    push();
    doc.layers.splice(i, 1);
    if (!doc.layers.length) doc.layers = [newLayer("Layer 1")];
    active = clamp(i - 1, 0, doc.layers.length - 1);
    invalidate();
    changed();
    renderLayers();
  }
  function addLayer() {
    push();
    doc.layers.push(newLayer(nextLayerName(doc.layers)));
    active = doc.layers.length - 1;
    changed();
    renderLayers();
  }

  /* ── right panel: adjustments ─────────────────────────────────────────── */

  const sliders = new Map();
  const adjustOnBtn = h("button", { class: "ie-toggle", title: "Turn every adjustment off, without losing the values", onclick: () => { push(); doc.adjustOn = !doc.adjustOn; changed(); renderAdjust(); } });
  // the preset thumbnails are this picture, not a stand-in swatch: the point
  // of a look is what it does to *your* photo
  const chipThumb = (() => {
    try {
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 86;
      c.getContext("2d").drawImage(img, 0, 0, 128, 86);
      return c.toDataURL("image/png");
    } catch { return ""; }
  })();
  const presetRow = h("div", { class: "ie-presets" }, PRESETS.map((p) => {
    const a = adjustFromPreset(p.id);
    return h("button", { class: "ie-preset", dataset: { p: p.id }, title: p.name, onclick: () => usePreset(p.id) },
      h("i", { class: "ie-preset-chip" + (chipThumb ? " has-thumb" : ""), style: { filter: filterString(a) || "none", ...(chipThumb ? { backgroundImage: `url("${chipThumb}")` } : {}) } },
        a.vignette ? h("i", { class: "ie-preset-vig", style: { opacity: String((a.vignette / 100) * 0.78) } }) : null),
      h("span", { text: p.name }));
  }));
  const adjustBody = h("div", { class: "ie-sliders" }, ADJUST.map((a) => {
    const val = h("span", { class: "ie-sl-val" });
    const input = h("input", {
      class: "ie-sl-input", type: "range", min: String(a.min), max: String(a.max), step: String(a.step), value: String(a.def),
      oninput: (e) => {
        doc.adjust[a.key] = +e.target.value;
        doc.preset = "";
        val.textContent = fmtAdjust(a, doc.adjust[a.key]);
        if (!doc.adjustOn) { doc.adjustOn = true; renderAdjust(); }
        paintPhoto();
        dirty = true;
        setState("dirty");
        persistSoon();
        markPresets();
      },
      onpointerdown: () => push(),
      ondblclick: () => { push(); doc.adjust[a.key] = a.def; changed(); renderAdjust(); },
    });
    sliders.set(a.key, { input, val });
    return h("div", { class: "ie-sl" },
      h("div", { class: "ie-sl-head" }, h("span", { class: "ie-sl-name", text: a.label }), val),
      input);
  }));

  const fmtAdjust = (a, v) => (v === a.def ? "—" : `${v > 0 && a.min < 0 ? "+" : ""}${v}${a.unit || ""}`);

  function usePreset(id) {
    push();
    doc.adjust = adjustFromPreset(id);
    doc.preset = id === "none" ? "" : id;
    doc.adjustOn = true;
    changed();
    renderAdjust();
  }
  function markPresets() {
    for (const b of presetRow.querySelectorAll(".ie-preset")) b.classList.toggle("is-on", b.dataset.p === (doc.preset || "none"));
  }
  function renderAdjust() {
    for (const a of ADJUST) {
      const s = sliders.get(a.key);
      s.input.value = String(doc.adjust[a.key]);
      s.val.textContent = fmtAdjust(a, doc.adjust[a.key]);
    }
    adjustOnBtn.replaceChildren(icon(doc.adjustOn ? "eye" : "square"), h("span", { text: doc.adjustOn ? "Adjustments on" : "Adjustments off" }));
    adjustOnBtn.classList.toggle("is-on", doc.adjustOn);
    adjustBody.classList.toggle("is-off", !doc.adjustOn);
    markPresets();
    paintPhoto();
    updateChrome();
  }

  // a section folds to its heading on a click there (not on its button); remembered on this computer
  const foldKey = (k) => "leonote.imageedit.fold." + k;
  const folded = (k) => { try { return !!localStorage.getItem(foldKey(k)); } catch { return false; } };
  const fold = (k) => (e) => {
    if (e.target.closest("button")) return;
    const on = e.currentTarget.parentElement.classList.toggle("is-folded");
    try { on ? localStorage.setItem(foldKey(k), "1") : localStorage.removeItem(foldKey(k)); } catch { /* fine */ }
  };
  const panel = h("div", { class: "ie-panel" },
    h("section", { class: "ie-sec" + (folded("layers") ? " is-folded" : "") },
      h("header", { class: "ie-sec-head", title: "Click to fold", onclick: fold("layers") },
        icon("layers"), h("h3", { text: "Layers" }), icon("chevronDown", "ie-sec-caret"),
        h("button", { class: "ie-mini", title: "New layer", onclick: addLayer }, icon("plus"))),
      layerList, layerHint),
    h("section", { class: "ie-sec ie-sec-adjust" + (folded("adjust") ? " is-folded" : "") },
      h("header", { class: "ie-sec-head", title: "Click to fold", onclick: fold("adjust") },
        icon("contrast"), h("h3", { text: "Colour & filters" }), icon("chevronDown", "ie-sec-caret"),
        h("button", { class: "ie-mini", title: "Back to the untouched picture", onclick: () => { push(); doc.adjust = { ...DEFAULT_ADJUST }; doc.preset = ""; changed(); renderAdjust(); } }, icon("undo"))),
      presetRow, adjustOnBtn, adjustBody));

  /* ── header ───────────────────────────────────────────────────────────── */

  const undoBtn = h("button", { class: "ie-btn", title: "Undo · Ctrl Z", onclick: undo }, icon("undo"));
  const redoBtn = h("button", { class: "ie-btn", title: "Redo · Ctrl Shift Z", onclick: redo }, icon("redo"));
  const deleteBtn = h("button", { class: "ie-btn ie-danger", title: "Delete what is selected · Del", hidden: true, onclick: () => deletePicked() }, icon("trash"), "Delete");
  const zoomLabel = h("span", { class: "ie-zoom", text: "100%" });
  const flattenBtn = h("button", { class: "ie-btn ie-outline", title: "Turn the picture plus your edits into a real image file", onclick: (e) => flattenMenu(e.currentTarget) }, icon("download"), "Save as picture…");
  const doneBtn = h("button", { class: "ie-btn ie-primary ie-done", title: "Keep your edits and go back · Esc", onclick: () => close() }, icon("check"), "Done");
  const revertBtn = h("button", { class: "ie-btn", title: "Close without the changes made since it opened", onclick: () => cancelEdits() }, icon("x"), "Cancel");
  const head = h("header", { class: "ie-head" },
    icon("image", "ie-head-ico"),
    h("div", { class: "ie-title" },
      h("div", { class: "ie-name", text: name, title: path }),
      h("div", { class: "ie-sub" }, stateEl, h("span", { class: "ie-dot" }), h("span", { text: `${IW} × ${IH}` }))),
    h("div", { class: "ie-spacer" }),
    deleteBtn,
    h("div", { class: "ie-group" }, undoBtn, redoBtn),
    h("div", { class: "ie-group" },
      h("button", { class: "ie-btn", title: "Fit to the window · 0", onclick: () => { zoom = 1; panX = 0; panY = 0; layout(); zoomLabel.textContent = "100%"; } }, icon("expand")),
      zoomLabel),
    flattenBtn,
    h("div", { class: "ie-endbtns" }, revertBtn, doneBtn));

  function updateChrome() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    flattenBtn.disabled = !docChangesPicture(doc);
    // Done once the picture differs from how it opened (undone back to it: nothing to keep)
    doneBtn.disabled = !editedSinceOpen || state() === stateAtOpen;
    deleteBtn.hidden = !picked.size;
  }

  /* ── flatten ──────────────────────────────────────────────────────────── */

  const EXPORT_TYPE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  function exportFormat() {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return EXPORT_TYPE[ext] ? { ext, type: EXPORT_TYPE[ext] } : { ext: "webp", type: "image/webp" };
  }

  async function renderBytes() {
    const { type } = exportFormat();
    const canvas = renderDoc(img, doc, {});
    const blob = await new Promise((r) => canvas.toBlob(r, type, 0.92));
    if (!blob) throw new Error("the picture could not be rendered");
    return new Uint8Array(await blob.arrayBuffer());
  }

  function flattenMenu(anchor) {
    if (!docChangesPicture(doc)) return toast("Nothing to flatten yet — draw something or move a slider");
    menu(0, 0, [
      { header: "The picture on disk has not changed" },
      { label: "Save as a new picture, next to the original", icon: "filePlus", run: () => flattenToNew() },
      { label: "Save as a new picture in another folder…", icon: "folder", run: () => app.palette("move", { onPick: (dir) => flattenToNew(dir) }) },
      { label: "Apply to the original…", icon: "image", danger: true, run: () => flattenToOriginal() },
    ], { anchor });
  }

  /** The edits flattened into a new picture: beside the original, or in `dir` ("" the vault root) under the same name. */
  async function flattenToNew(dir) {
    const { ext } = exportFormat();
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const out = editedName(dir == null ? path : (dir ? dir + "/" : "") + leaf, (p) => app.vault.files.has(p) || app.vault.notes.has(p), ext);
    try {
      const bytes = await renderBytes();
      const list = await app.host.saveImage(out, bytes);
      if (Array.isArray(list)) app.vault.setFiles(list);
      flattened = out;
      toast(`Saved ${out.slice(out.lastIndexOf("/") + 1)} · the original is untouched`, {
        ms: 8000,
        action: { label: "Use it in this note", run: () => relink(out) },
      });
      if (onFlatten) onFlatten(out);
    } catch (e) {
      toast("Could not save the flattened picture: " + (e && e.message ? e.message : e), { kind: "error" });
    }
  }

  async function relink(out) {
    try {
      const n = await app.vault.relinkFile(path, out);
      toast(n ? `Pointed ${n} note${n === 1 ? "" : "s"} at the new picture` : "No note embeds this picture yet", { ms: 3000 });
    } catch (e) {
      toast("Could not relink: " + e, { kind: "error" });
    }
  }

  async function flattenToOriginal() {
    const ok = await confirmDialog(
      `Write these edits into ${name}?`,
      "This is the one thing Leonote will not undo for you. The old version is copied to the vault's .trash first, and the edits stay stored so you can keep working on them.",
      { ok: "Write into the picture", danger: true });
    if (!ok) return;
    try {
      const bytes = await renderBytes();
      const entry = await app.host.writeFile(path, bytes);
      if (entry && entry.path) app.vault.files.set(entry.path, entry);
      const cropped = !!doc.crop;
      // the file has the cropped size now: a stored crop would cut it a second time
      if (cropped) { doc.crop = null; persistSoon.cancel?.(); await saveDoc(app, path, doc); }
      forget(path);
      toast(`${name} rewritten · the old version is in .trash`, { ms: 6000 });
      if (onFlatten) onFlatten(path);
      if (cropped) close(); // this editor still holds the old, larger picture
    } catch (e) {
      toast("Could not write the picture: " + (e && e.message ? e.message : e), { kind: "error" });
    }
  }

  async function cancelEdits() {
    if (state() === stateAtOpen) return close();
    const ok = await confirmDialog("Close without your changes?", `What you did to ${name} since you opened it is thrown away. The picture itself was never changed.`, { ok: "Close without them", danger: true, safe: true });
    if (!ok) return;
    doc = normalizeDoc(JSON.parse(atOpen), { width: IW, height: IH });
    dirty = true;
    close();
  }
  async function resetAll() {
    if (!docChangesPicture(doc) && !doc.layers.some((l) => l.shapes.length)) return;
    const ok = await confirmDialog("Throw every edit away?", `${name} goes back to how it looks on disk. The picture itself was never changed.`, { ok: "Throw away", danger: true, safe: true });
    if (!ok) return;
    push();
    picked.clear();
    doc = normalizeDoc(emptyDoc(IW, IH));
    doc.layers = [newLayer("Layer 1")];
    active = 0;
    invalidate();
    changed();
    renderLayers();
    renderAdjust();
  }

  /* ── keys, mounting, closing ──────────────────────────────────────────── */

  function onKey(e) {
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) {
      if (e.key === "Escape" && e.target.tagName === "INPUT") e.target.blur();
      return;
    }
    const k = keyOf(e);
    // the colour popup is ours: Escape closes it, not the editor under it
    if (closeColours) { if (k === "Escape") { e.preventDefault(); e.stopPropagation(); closeColours(); } return; }
    if (e.ctrlKey || e.metaKey) {
      if (k.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); e.shiftKey ? redo() : undo(); }
      else if (k.toLowerCase() === "y") { e.preventDefault(); e.stopPropagation(); redo(); }
      else if (k.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); persistSoon.cancel?.(); persist(); }
      else if (k.toLowerCase() === "a") { e.preventDefault(); e.stopPropagation(); selectAllMarks(); }
      else if (k.toLowerCase() === "d" && (marq || picked.size)) { e.preventDefault(); e.stopPropagation(); marq = null; pick([]); }
      else if (k.toLowerCase() === "j" && picked.size) { e.preventDefault(); e.stopPropagation(); duplicatePicked(); }
      else if (k.toLowerCase() === "c" && marq) { e.preventDefault(); e.stopPropagation(); copyMarq(); }
      else if (k.toLowerCase() === "v" && clip) { e.preventDefault(); e.stopPropagation(); pasteClip(); }
      else if (k === "Control" && ringAt) { ringAt.ctrl = true; paintRing(); ink.dataset.borrow = "select"; }
      return;
    }
    if (e.altKey) return;
    const SHAPES = ["line", "arrow", "rect", "ellipse"];
    const ALIAS = { p: "pen", n: "pen", m: "marker" }; // the old keys still work
    const hit = TOOLS.find(([, , , key]) => key.toLowerCase() === k.toLowerCase());
    if (hit) { setTool(hit[0]); }
    else if (ALIAS[k.toLowerCase()]) setTool(ALIAS[k.toLowerCase()]);
    else if (k.toLowerCase() === "u") setTool(SHAPES[(SHAPES.indexOf(tool) + 1) % SHAPES.length]);
    else if (k.toLowerCase() === "k") openColours(rail.querySelector(".ie-colour"));
    else if (k === " ") { if (!spaceDown) { spaceDown = true; stage.classList.add("is-grab"); paintRing(); } }
    else if ((k === "Delete" || k === "Backspace") && marq) { liftPiece(marq, { copy: false, gone: true }); marq = null; paintPicked(); }
    else if (k === "Escape" && marq) { marq = null; paintPicked(); }
    else if ((k === "Delete" || k === "Backspace") && picked.size) deletePicked();
    else if (k.startsWith("Arrow") && picked.size) {
      const d = (e.shiftKey ? 10 : 1) * Math.max(1, unit);
      nudgePicked(k === "ArrowLeft" ? -d : k === "ArrowRight" ? d : 0, k === "ArrowUp" ? -d : k === "ArrowDown" ? d : 0);
    }
    else if (k === "Enter" && tool === "crop") setTool("select");
    else if ((k === "Delete" || k === "Backspace") && tool === "crop") clearCrop();
    else if (k === "Escape" && tool === "crop") setTool("select");
    else if (k === "Escape" && picked.size) pick([]);
    else if (k === "Escape") close();
    else if (k === "[") stepSize(-1, e.repeat);
    else if (k === "]") stepSize(1, e.repeat);
    else if (k === "0") { zoom = 1; panX = 0; panY = 0; layout(); zoomLabel.textContent = "100%"; }
    // arrows with nothing picked stay here: the viewer under the editor would step to another picture
    else if (k.startsWith("Arrow")) { /* nothing to move */ }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKeyUp(e) {
    if (e.key === " ") { spaceDown = false; stage.classList.remove("is-grab"); paintRing(); }
    if (e.key === "Control") { if (ringAt) ringAt.ctrl = false; delete ink.dataset.borrow; paintRing(); }
  }

  root = h("div", { class: "ie", tabIndex: -1 }, sharpenSvg, head, h("div", { class: "ie-main" }, rail, stage, panel));
  let done;
  const finished = new Promise((r) => { done = r; });

  function close() {
    if (openEditor !== api) return;
    openEditor = null;
    closeText(true);
    persistSoon.cancel?.();
    const wait = dirty ? persist() : Promise.resolve();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keyup", onKeyUp, true);
    ro.disconnect();
    root.remove();
    refocus(prevFocus);
    wait.then(() => done({ changed: docChangesPicture(doc), flattened }));
  }

  const api = { close, get path() { return path; } };
  openEditor = api;

  const ro = new ResizeObserver(() => layout());
  const prevFocus = document.activeElement;
  document.getElementById("overlay-root").append(root);
  ro.observe(stage);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKeyUp, true);
  setTool(tool);
  setColour(colour, { restyle: false });
  setSizePx(presetPx(sizeStep), { quiet: true });
  renderLayers();
  renderAdjust();
  paintInk();
  layout();
  setState("saved");
  root.focus();
  return finished;
}
