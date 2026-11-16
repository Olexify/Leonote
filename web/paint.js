// Draw, Photo and Animate: Leonote's layered pixel editor (`.leostudio`).
//
// Sketch (sketch.js) is vector, fast and made for whiteboards and diagrams.
// This is pixels: layers, blend modes, a stamp-based brush engine and a
// document with a real size — and, since Studio, masks, groups, clipping,
// adjustment layers, live text and whole-document operations. Draw and
// Studio are two WORKSPACES of one editor, the way a photo editor has
// "personas": the same document and the same tools, with the panels arranged
// for painting or for working on a photograph. paintmode.js is the switch
// between this and Sketch; paintstudio.js holds Studio's panels and dialogs.
//
// Speed rules, the same ones Sketch lives by:
//   · one canvas on screen, repainted only when something changed
//   · while a stroke is live, only the rectangle it dirtied is repainted
//   · pointer handlers record and stamp; nothing else happens per event
//   · no allocation inside the stroke loop (see paintengine.js)
//   · rAF is scheduled only when there is something to draw — an idle
//     drawing costs nothing at all, and a hidden tab frees its bitmaps

import { createMeasure } from "./paintmeasure.js";
import { h, clamp, keyOf } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast, foldSections } from "./ui.js";
import * as D from "./paintdoc.js";
import * as B from "./paintbrush.js";
import * as S from "./paintstore.js";
import * as G from "./paintgeom.js";
import { ADJUST_BY_ID } from "./paintadjust.js";
import { alphaIsland, islandsTouching, colourSelect, hexLuma } from "./paintselect.js";
import { colourPop, noteColour } from "./colourpop.js";
import { Engine, parseHex, rgbToHex, hasFx } from "./paintengine.js";
import { History, pixelStep, metaStep, groupStep, fmtBytes } from "./painthistory.js";
import { mountStudio } from "./paintstudio.js";
import { mountAnim } from "./paintanim.js";
const BRUSH_MAX = 1000; // the biggest brush, in pixels of the drawing

export const I = {
  brush: '<path d="M4 20c2-1 3.5-4.5 6-6.5s5-1.5 6.5-3.5S18 5.5 20 4"/>',
  eraser: '<path d="M8.5 19.5L3.9 14.9a1.5 1.5 0 0 1 0-2.1l8.9-8.9a1.5 1.5 0 0 1 2.1 0l4.6 4.6a1.5 1.5 0 0 1 0 2.1L11 19.5zM20 19.5H11"/>',
  smudge: '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11M12 10V7.5a1.5 1.5 0 0 1 3 0V11M15 10.5a1.5 1.5 0 0 1 3 0V15c0 3-2 5.5-5.5 5.5-2.4 0-3.8-1-5-2.8L5.2 14a1.4 1.4 0 0 1 2.3-1.6L9 14"/><path d="M4 6.5c1.2-.8 2.2-.8 3.2 0M4 9.5c1.2-.8 2.2-.8 3.2 0"/>',
  bucket: '<path d="M7 4l9.5 9.5a1.5 1.5 0 0 1 0 2.1l-5 5a1.5 1.5 0 0 1-2.1 0L4 15.2a1.5 1.5 0 0 1 0-2.1z"/><path d="M19 15c1.3 2 2 3.2 2 4a2 2 0 0 1-4 0c0-.8.7-2 2-4z"/>',
  gradient: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 5v14M11.5 5v14" opacity=".75"/><path d="M15 5v14" opacity=".4"/>',
  shape: '<rect x="4" y="4.5" width="10" height="10" rx="1.5"/><circle cx="15.5" cy="15.5" r="4.5"/>',
  picker: '<path d="M18.5 3.5a2.1 2.1 0 0 1 3 3l-2 2-3-3zM16 5.5L18.5 8 8 18.5l-3.5 1 1-3.5z"/>',
  scissors: '<circle cx="6" cy="6.5" r="2.8"/><circle cx="6" cy="17.5" r="2.8"/><path d="M8.3 8.2L20 18M8.3 15.8L20 6"/>',
  marquee: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>',
  lasso: '<path d="M12 4.5c4.7 0 8 2.4 8 5.5s-3.3 5.5-8 5.5c-1.4 0-2.7-.2-3.8-.6-1.2.9-1.7 2-1.7 3.1M7 18.5a1.4 1.4 0 1 0 0 .1M8.2 14.9C5.7 13.9 4 12.1 4 10c0-3 3.3-5.5 8-5.5"/>',
  wand: '<path d="M5 19L15.5 8.5M14 7l3 3"/><path d="M17.5 3.5v3M16 5h3M20 10.5v2M19 11.5h2M9.5 3.5v2M8.5 4.5h2"/>',
  transform: '<path d="M5.5 3.5l13 7.2-5.6 1.7 3.4 6.4-2.6 1.4-3.4-6.5-4.1 4.1z"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.500 10h.01M7 14h10"/>',
  crop: '<path d="M7 3v13a1 1 0 0 0 1 1h13M3 7h13a1 1 0 0 1 1 1v13"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  hand: '<path d="M8 12.5V6.5a1.5 1.5 0 0 1 3 0V11M11 10.5v-6a1.5 1.5 0 0 1 3 0v6M14 10.5V6a1.5 1.5 0 0 1 3 0v7.5c0 4-2.5 6.5-6 6.5-2.6 0-4-1.2-5.3-3.2L3.6 13.3a1.5 1.5 0 0 1 2.5-1.6L8 14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  mergeDown: '<path d="M12 3.5v12M8 12l4 4 4-4M4.5 20.5h15"/>',
  measure: '<path d="M3.5 16.5L16.5 3.5l4 4-13 13z"/><path d="M7 13l2 2M10 10l1.5 1.5M13 7l2 2"/>',
  eyeOff: '<path d="M4 4l16 16M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7 0 1-.7 2.3-1.8 3.5M6.6 7.1C4.6 8.6 3 10.6 3 12c0 2.5 4 7 9 7 1.4 0 2.6-.3 3.7-.8M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  unlocked: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/>',
  locked: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  alphaLock: '<path d="M12 3.5l5.5 9.5a6.3 6.3 0 1 1-11 0z"/><path d="M6.5 13h11"/>',
  fit: '<path d="M9 4.5H5.5A1 1 0 0 0 4.5 5.5V9M15 4.5h3.5a1 1 0 0 1 1 1V9M19.5 15v3.5a1 1 0 0 1-1 1H15M9 19.5H5.5a1 1 0 0 1-1-1V15"/>',
  rotate: '<path d="M4.5 12a7.5 7.5 0 1 1 2.6 5.7"/><path d="M4 8v4.5h4.5"/>',
  mirror: '<path d="M12 3.5v17" stroke-dasharray="2.2 2.2"/><path d="M9 7.5L4 12l5 4.5zM15 7.5l5 4.5-5 4.5z"/>',
  save: '<path d="M5.5 4.5h10L19.5 8v11a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M8.5 4.5v5h7M8 16h8"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  layers: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M4 12.5l8 4.3 8-4.3M4 16.5l8 4.3 8-4.3"/>',
  trash: '<path d="M5 6.5h14M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12"/>',
  mask: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="12" cy="12" r="3.6"/>',
  folder: '<path d="M4 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h7A1.5 1.5 0 0 1 20 9.7v8.300a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 18z"/>',
  adjust: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 6.5a5.500 5.500 0 0 1 0 11z" fill="currentColor" stroke="none"/>',
  clip: '<path d="M8 5v8.500a2.500 2.500 0 0 0 2.500 2.500H17M14 13l3 3-3 3"/>',
  symmetry: '<path d="M12 3.5v17" stroke-dasharray="2.200 2.200"/><path d="M9 8c-3 1-4.500 3-4.500 4.500S6 16 9 17M15 8c3 1 4.500 3 4.500 4.500S18 16 15 17"/>',
  guide: '<path d="M4 18L18 4l2.500 2.500L6.500 20.500zM8 14l1.500 1.500M11 11l1.500 1.500M14 8l1.500 1.500"/>',
  library: '<rect x="4" y="4.500" width="7" height="7" rx="1.500"/><rect x="13" y="4.500" width="7" height="7" rx="1.500"/><rect x="4" y="13.500" width="7" height="6" rx="1.500"/><rect x="13" y="13.500" width="7" height="6" rx="1.500"/>',
  swap: '<path d="M7 4.500L4 7.500l3 3M4 7.500h9a4 4 0 0 1 4 4M17 19.500l3-3-3-3M20 16.500h-9a4 4 0 0 1-4-4"/>',
};

const TOOLS = [
  { id: "transform", name: "Select and move: click a piece of the drawing, drag it, Delete removes it. Ctrl borrows it from a brush", key: "V", icon: I.transform },
  "sep",
  { id: "brush", name: "Brush", key: "B", icon: I.brush },
  { id: "eraser", name: "Eraser", key: "E", icon: I.eraser },
  { id: "smudge", name: "Smudge", key: "S", icon: I.smudge },
  { id: "fill", name: "Fill", key: "G", icon: I.bucket },
  { id: "gradient", name: "Gradient (G again)", key: "G", icon: I.gradient },
  { id: "shape", name: "Line and shapes", key: "U", icon: I.shape },
  { id: "picker", name: "Pick a colour", key: "I", icon: I.picker },
  { id: "measure", name: "Measure: length, angle, and whether it sits in the middle (I again). Guides come out of the rulers (Ctrl+R)", key: "I", icon: I.measure },
  "sep",
  { id: "marquee", name: "Rectangle or ellipse select", key: "M", icon: I.marquee },
  { id: "piece", name: "Piece, as in Photoshop: drag a box (nothing changes), then drag from inside it to move that piece - Alt-drag moves a copy. Ctrl+C copies it, Ctrl+D lets go", key: "Q", icon: I.scissors },
  { id: "lasso", name: "Lasso select", key: "L", icon: I.lasso },
  { id: "wand", name: "Magic wand", key: "W", icon: I.wand },
  { id: "crop", name: "Crop", key: "C", icon: I.crop },
  { id: "text", name: "Text", key: "T", icon: I.text },
  { id: "hand", name: "Pan", key: "H", icon: I.hand },
];

const PAINTS = new Set(["brush", "eraser", "smudge"]);
const SELECTS = new Set(["marquee", "lasso", "wand"]);
const DEFAULT_COLOURS = ["#111318", "#ffffff", "#e03131", "#f08c00", "#f5c518", "#2f9e44", "#1971c2", "#6741d9", "#c2255c", "#846358"];
const SEL_MODES = [["replace", "New selection"], ["add", "Add to it (Shift)"], ["subtract", "Take away from it (Alt)"], ["intersect", "Keep only the overlap (Shift+Alt)"]];

/**
 * Mount the editor. Resolves to
 * `{ destroy, focus, save, dirty, sleep, wake, idleCost }`.
 */
export async function mountPaint(el, { app, path, onChange, readOnly = false } = {}) {
  const loading = h("div", { class: "pt-loading" }, h("div", { class: "pt-spin" }), h("span", { text: "Opening the drawing…" }));
  el.replaceChildren(loading);

  const { doc, engine } = await S.openDoc(app, path);
  return build(el, { app, path, onChange, readOnly, doc, engine, created: doc.created });
}

function build(el, { app, path, onChange, readOnly, doc, engine, created }) {
  /* ── state ──────────────────────────────────────────────────────────── */
  let destroyed = false;
  let asleep = false;
  let dirty = false;
  let tool = "brush";
  let lastTool = "brush";
  let peek = null; // a tool held temporarily with a key
  let colour = "#111318";
  let colour2 = "#ffffff";
  let selectedId = doc.selected || doc.layers[doc.layers.length - 1].id;
  let onMask = false; // strokes go to the selected layer's mask, not its pixels
  let colourBeforeMask = null;
  let brushId = app.settings[S.SETTING_KEYS.lastBrush] || B.DEFAULT_PRESET;
  const brushOverrides = new Map();
  let raf = 0;
  let dirtyScreen = null; // screen-space rect to repaint, or null for everything
  let frameTimes = [];
  let framesPainted = 0; // never reset: how many frames this editor has painted
  let statusRaf = 0;
  // Paint ("draw"), Photo ("studio") or Animate: three ways of working over this one file.
  // Animate opens a drawing that has no frames yet only when it was just made for it.
  const hasFrames0 = doc.layers.some((l) => l.kind === "group" && l.frame);
  // the way of working asked for (a new animation, a recent file picked under Filter), else the one this file was last in
  const WS = ["draw", "studio", "animate"];
  const asked = app._paintNext; app._paintNext = null;
  const wsOf = app.settings.paintWsOf || {};
  let workspace = WS.includes(asked) ? asked : WS.includes(wsOf[path]) ? wsOf[path] : hasFrames0 ? "animate" : "draw";
  if (workspace === "animate" && !hasFrames0 && app._animNext !== path) workspace = "draw";
  let anim = null;
  let onionCanvas = null; // the frames either side, faint, over the one being drawn
  let under = null; // Animate's video underneath: { source, alpha }, between the paper and the layers

  // tool options
  let selMode = "replace";
  let marqueeShape = "rect";
  let fillTolerance = 0.18;
  let fillSampleAll = true;
  let wandTolerance = 0.12;
  let wandContiguous = true;
  let wandSampleAll = true;
  let gradKind = "linear";
  let gradTo = "transparent";
  let gradOpacity = 1;
  let shapeKind = "line";
  let shapeFilled = false;
  let cropRatio = "free";
  let crop = null; // { rect } while the crop tool is up
  let textEdit = null; // { id, isNew, before, ta, orig }
  const textOpts = { font: "Inter", size: Math.max(24, Math.round(Math.min(doc.width, doc.height) / 14)), bold: false, italic: false, align: "left", lineHeight: 1.2, tracking: 0 };

  // drawing assists live in the document, so a mandala is still a mandala tomorrow
  const assist = (Array.isArray(doc.guides) ? doc.guides : []).reduce((a, g) => ({ ...a, [g.type]: g }), {});
  const symmetry = { type: "symmetry", mode: "none", count: 6, cx: doc.width / 2, cy: doc.height / 2, ...(assist.symmetry || {}) };
  const guide = { type: "guide", kind: "none", angle: 0, cx: doc.width / 2, cy: doc.height / 2, cx2: doc.width * 0.9, cy2: doc.height / 2, ...(assist.guide || {}) };
  let placing = null; // "symmetry" | "vanish" | "vanish2" | "angle": the next click sets a point
  // the guides pulled out of the rulers: kept in the drawing beside the assists
  let snapLines = []; // [axis, at]: the smart guides a moved piece caught
  const ruleGuides = (Array.isArray(doc.guides) ? doc.guides : []).filter((g) => g && g.type === "rule" && (g.axis === "x" || g.axis === "y") && Number.isFinite(g.at)).map((g) => ({ type: "rule", axis: g.axis, at: g.at }));
  const syncAssist = () => {
    engine.symmetry = symmetry.mode === "none" ? null : symmetry;
    doc.guides = [symmetry.mode !== "none" ? { ...symmetry } : null, guide.kind !== "none" ? { ...guide } : null, ...ruleGuides.map((g) => ({ ...g }))].filter(Boolean);
  };
  syncAssist();

  const view = { zoom: 1, angle: 0, flip: false, cx: 0, cy: 0, width: doc.width, height: doc.height };
  // every step bumps the engine's pixel version: a layer's styles are worked out again from what it is now
  const history = new History({ onChange: () => { engine.pixVer++; scheduleStatus(); } });

  const brushFor = (id) => B.resolve(id, brushOverrides.get(id) || null);
  let brush = brushFor(brushId);

  /* ── DOM ────────────────────────────────────────────────────────────── */
  const canvas = h("canvas", { class: "pt-canvas" });
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  // the brush at its real size, in place of the mouse pointer; the core shows how hard the edge is
  const cursorCore = h("i", { class: "pt-cursor-core" });
  const cursorLabel = h("b", { class: "pt-cursor-label" });
  const cursor = h("div", { class: "pt-cursor", hidden: true }, cursorCore, cursorLabel);

  const toolbar = h("div", { class: "pt-tools pt-glass" });
  const topbar = h("div", { class: "pt-top pt-glass" });
  const optsbar = h("div", { class: "pt-opts pt-glass", hidden: true });
  const optsWrap = h("div", { class: "pt-opts-wrap" }, optsbar);
  const adjustPanel = h("section", { class: "pt-adjust pt-glass", hidden: true });
  const layersPanel = h("aside", { class: "pt-layers pt-glass" });
  const rightCol = h("div", { class: "pt-right" }, adjustPanel, layersPanel);
  const brushPanel = h("aside", { class: "pt-brush pt-glass", hidden: true });
  const statusbar = h("div", { class: "pt-status pt-glass" });
  const root = h("div", { class: "pt", tabIndex: 0 }, canvas, cursor, topbar, optsWrap, toolbar, brushPanel, rightCol, statusbar);
  el.replaceChildren(root);
  // rulers, guides and the measuring line (paintmeasure.js)
  const measure = createMeasure({ root, canvas, view, doc, guides: ruleGuides,
    changed: () => { syncAssist(); changed(); }, invalidate: () => invalidate(),
    pref: (k) => app.settings[k], setPref: (k, v) => app.setSetting(k, v) });

  const changed = () => {
    if (dirty) return;
    dirty = true;
    if (onChange) onChange();
    scheduleStatus();
  };

  /* ── the view ───────────────────────────────────────────────────────── */

  let W = 0, H = 0, dpr = 1;

  function resize() {
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    if (!view.cx && !view.cy) fit();
    invalidate();
  }

  /**
   * Fit the canvas into the space the panels leave, not the whole viewport:
   * a drawing tucked behind the layers panel is not "fitted".
   */
  function fit() {
    const w = W || 800;
    const hh = H || 600;
    const left = 62; // the tool rail
    const right = 268;
    const top = 96; // the top bar and the options bar
    const bottom = workspace === "animate" ? 150 : 46; // the status bar, and the timeline in Animate
    view.zoom = D.fitZoom(doc, Math.max(120, w - left - right), Math.max(120, hh - top - bottom), 40);
    view.angle = 0;
    view.cx = left + (w - left - right) / 2;
    view.cy = top + (hh - top - bottom) / 2;
    invalidate();
    scheduleStatus();
  }

  function zoomTo(z, sx, sy) {
    const next = clamp(z, D.ZOOM_MIN, D.ZOOM_MAX);
    if (next === view.zoom) return;
    // keep the document point under the cursor exactly where it is
    const p = D.toDocPoint(view, sx, sy);
    view.zoom = next;
    const after = D.toScreenPoint(view, p.x, p.y);
    view.cx += sx - after.x;
    view.cy += sy - after.y;
    invalidate();
    scheduleStatus();
  }

  // `dirtyScreen`: undefined = nothing pending, null = repaint everything,
  // otherwise the screen rectangle to repaint. A stroke only ever dirties the
  // box it drew in, which is what keeps a 4000 × 4000 document at frame rate.
  const invalidate = (screenRect = null) => {
    if (destroyed || asleep) return;
    if (!screenRect) dirtyScreen = null;
    else if (dirtyScreen === undefined) dirtyScreen = screenRect;
    else if (dirtyScreen !== null) dirtyScreen = unionRect(dirtyScreen, screenRect);
    if (!raf) raf = requestAnimationFrame(frame);
  };
  dirtyScreen = undefined;

  function invalidateDoc(box, pad = 0) {
    if (!box) return invalidate();
    // overlays (the symmetry axis, a guide) are only drawn on a full repaint
    if (!Number.isFinite(box.x0) || !Number.isFinite(box.x1)) return invalidate();
    invalidate(screenBox(box, pad));
  }

  /** The document-space rectangle a screen rectangle covers, clamped to the canvas. */
  function docBoxOf(r) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]) {
      const p = D.toDocPoint(view, sx, sy);
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const x = Math.max(0, Math.floor(x0) - 1);
    const y = Math.max(0, Math.floor(y0) - 1);
    const w = Math.min(doc.width, Math.ceil(x1) + 1) - x;
    const hh = Math.min(doc.height, Math.ceil(y1) + 1) - y;
    if (w <= 0 || hh <= 0) return null;
    return { x, y, w, h: hh };
  }

  /** The screen-space bounding box of a document-space box, under rotation. */
  function screenBox(box, pad = 0) {
    const pts = [
      D.toScreenPoint(view, box.x0 - pad, box.y0 - pad),
      D.toScreenPoint(view, box.x1 + pad, box.y0 - pad),
      D.toScreenPoint(view, box.x1 + pad, box.y1 + pad),
      D.toScreenPoint(view, box.x0 - pad, box.y1 + pad),
    ];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return { x: Math.floor(x0) - 2, y: Math.floor(y0) - 2, w: Math.ceil(x1 - x0) + 4, h: Math.ceil(y1 - y0) + 4 };
  }

  function frame() {
    raf = 0;
    if (destroyed || asleep || !W) return;
    const t0 = performance.now();
    const clip = dirtyScreen;
    dirtyScreen = undefined;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
      ctx.clearRect(clip.x, clip.y, clip.w, clip.h);
    } else {
      ctx.clearRect(0, 0, W, H);
    }
    // the canvas, in place
    ctx.save();
    ctx.translate(view.cx, view.cy);
    ctx.rotate(view.angle);
    ctx.scale(view.zoom * (view.flip ? -1 : 1), view.zoom);
    ctx.translate(-doc.width / 2, -doc.height / 2);
    if (!clip) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.45)";
      ctx.shadowBlur = 24 / view.zoom;
      ctx.shadowOffsetY = 6 / view.zoom;
      // an opaque rectangle, because a canvas shadow takes its strength from
      // what casts it; the document is painted straight over it
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, doc.width, doc.height);
      ctx.restore();
    }
    // a transparent document shows the checkerboard behind it
    if (!doc.background) {
      ctx.save();
      ctx.fillStyle = checkerPattern(ctx);
      ctx.imageSmoothingEnabled = false;
      const k = 1 / view.zoom;
      ctx.scale(k, k);
      ctx.fillRect(0, 0, doc.width * view.zoom, doc.height * view.zoom);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = view.zoom < 1;
    ctx.imageSmoothingQuality = "medium";
    // a video underneath (Animate): the paper, the video's picture faint over it, then the layers
    const und = under && workspace === "animate" && under.source.videoWidth ? under : null;
    if (und) {
      if (doc.background) { ctx.fillStyle = doc.background; ctx.fillRect(0, 0, doc.width, doc.height); }
      const v = und.source, k = Math.min(doc.width / v.videoWidth, doc.height / v.videoHeight);
      ctx.globalAlpha = und.alpha;
      ctx.drawImage(v, (doc.width - v.videoWidth * k) / 2, (doc.height - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k);
      ctx.globalAlpha = 1;
    }
    if (engine.isPlain()) {
      // while a stroke is live, tell the engine which document rectangle is
      // actually being repainted, so its merge buffer is the size of the stroke
      // and not the size of the canvas
      engine.compositeInto(ctx, 0, 0, doc.width, doc.height, 1, { live: engine.stroke && clip ? docBoxOf(clip) : null, background: !und });
    } else {
      // masks, groups, adjustments: composited through buffers, but only the
      // part of the document that is on screen, at the resolution it is shown
      const region = docBoxOf(clip || { x: 0, y: 0, w: W, h: H });
      if (region) engine.paintRegion(ctx, region, Math.min(1, view.zoom * dpr), { background: !und });
    }
    if (onionCanvas && workspace === "animate") ctx.drawImage(onionCanvas, 0, 0, doc.width, doc.height);
    if (maskView !== "off") {
      const ml = layer();
      if (ml && ml.mask) engine.paintMaskView(ctx, ml.id, docBoxOf(clip || { x: 0, y: 0, w: W, h: H }), Math.min(1, view.zoom * dpr), maskView);
    }
    ctx.imageSmoothingEnabled = true;
    // canvas edge, only when asked for (the view menu)
    if (app.settings.paintEdge) {
      ctx.lineWidth = 1 / view.zoom;
      ctx.strokeStyle = "rgba(128,128,128,.55)";
      ctx.strokeRect(0.5 / view.zoom, 0.5 / view.zoom, doc.width, doc.height);
    }
    drawSelection(ctx);
    drawFloatHandles(ctx);
    if (!clip) drawOverlays(ctx);
    ctx.restore();
    ctx.restore();
    if (textEdit) placeTextarea();
    measure.after();
    const ms = performance.now() - t0;
    frameTimes.push(ms);
    if (frameTimes.length > 120) frameTimes.shift();
    framesPainted++;
  }

  let checker = null;
  function checkerPattern(c) {
    if (checker) return checker;
    const t = document.createElement("canvas");
    t.width = 16;
    t.height = 16;
    const tc = t.getContext("2d");
    tc.fillStyle = "#cfd2d6";
    tc.fillRect(0, 0, 16, 16);
    tc.fillStyle = "#eef0f2";
    tc.fillRect(0, 0, 8, 8);
    tc.fillRect(8, 8, 8, 8);
    checker = c.createPattern(t, "repeat");
    return checker;
  }

  function drawSelection(c) {
    // while a selection is lifted and being moved, its outline would sit at
    // the old place and read as a second, stale selection
    const sel = engine.floating ? null : engine.selection;
    if ((!sel || !sel.path) && !liveSelect) return;
    c.save();
    c.lineWidth = 1 / view.zoom;
    c.setLineDash([5 / view.zoom, 4 / view.zoom]);
    c.strokeStyle = "rgba(0,0,0,.8)";
    if (sel && sel.path) c.stroke(sel.path);
    if (liveSelect) c.stroke(liveSelect);
    c.strokeStyle = "rgba(255,255,255,.9)";
    c.lineDashOffset = 5 / view.zoom;
    if (sel && sel.path) c.stroke(sel.path);
    if (liveSelect) c.stroke(liveSelect);
    c.restore();
  }

  /** The box of what is picked, while the pointer is out and nothing is lifted yet - its handles show. */
  const selHandlesBox = () => {
    if (tool !== "transform" || engine.floating || readOnly || app.settings.paintSelHandles === false) return null;
    const b = engine.selection && engine.selection.box;
    return b && b.w > 0 && b.h > 0 ? b : null;
  };
  /** A corner or the turn knob of those handles under a document point, or null. */
  function selHandleHit(p) {
    const b = selHandlesBox();
    if (!b) return null;
    const hw = b.w / 2, hh = b.h / 2, lx = p.x - (b.x + hw), ly = p.y - (b.y + hh);
    const r = 10 / view.zoom;
    if (Math.hypot(lx, ly + hh + 26 / view.zoom) < r * 1.4) return "rotate";
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) if (Math.abs(lx - x) < r && Math.abs(ly - y) < r) return "scale";
    return null;
  }

  function drawFloatHandles(c) {
    const ghost = !engine.floating && !(drag && drag.kind === "pickbox") ? selHandlesBox() : null;
    // what is picked but not lifted: the same handles, quieter, until one is taken
    const f = engine.floating || (ghost && { cx: ghost.x + ghost.w / 2, cy: ghost.y + ghost.h / 2, w: ghost.w, h: ghost.h, sx: 1, sy: 1, angle: 0 });
    if (!f) return;
    if (ghost) c.globalAlpha = 0.75;
    const r = 6 / view.zoom;
    c.save();
    c.translate(f.cx, f.cy);
    c.rotate(f.angle);
    const hw = (f.w * f.sx) / 2;
    const hh = (f.h * f.sy) / 2;
    c.lineWidth = 1.5 / view.zoom;
    c.strokeStyle = accentColour();
    c.strokeRect(-hw, -hh, hw * 2, hh * 2);
    c.fillStyle = "#fff";
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      c.beginPath();
      c.rect(x - r, y - r, r * 2, r * 2);
      c.fill();
      c.stroke();
    }
    // the rotate handle, above the top edge
    c.beginPath();
    c.moveTo(0, -hh);
    c.lineTo(0, -hh - 26 / view.zoom);
    c.stroke();
    c.beginPath();
    c.arc(0, -hh - 26 / view.zoom, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.restore();
    c.globalAlpha = 1;
  }

  /** Everything drawn over the picture that is not the picture: guides, the crop, previews. */
  function drawOverlays(c) {
    const z = view.zoom;
    const far = Math.max(doc.width, doc.height) * 3;
    c.save();
    c.lineWidth = 1 / z;
    if (drag && drag.kind === "pickbox") {
      c.save();
      c.strokeStyle = "rgba(66,153,225,.95)";
      c.fillStyle = "rgba(66,153,225,.10)";
      c.setLineDash([6 / z, 4 / z]);
      const s = drag.start, q = drag.cur;
      c.fillRect(Math.min(s.x, q.x), Math.min(s.y, q.y), Math.abs(q.x - s.x), Math.abs(q.y - s.y));
      c.strokeRect(Math.min(s.x, q.x), Math.min(s.y, q.y), Math.abs(q.x - s.x), Math.abs(q.y - s.y));
      c.restore();
    }
    // what a moved piece has caught, while it is being moved
    if (snapLines.length && drag && drag.kind === "float") {
      c.save();
      c.strokeStyle = "#ff5ca8";
      c.lineWidth = 1.5 / z;
      c.beginPath();
      for (const [axis, at] of snapLines) { if (axis === "x") { c.moveTo(at, -far); c.lineTo(at, far); } else { c.moveTo(-far, at); c.lineTo(far, at); } }
      c.stroke();
      c.restore();
    }
    // symmetry axes
    if (symmetry.mode !== "none" && (PAINTS.has(tool) || tool === "shape")) {
      c.strokeStyle = "rgba(66,153,225,.85)";
      c.setLineDash([8 / z, 5 / z]);
      c.beginPath();
      const { cx, cy } = symmetry;
      if (symmetry.mode === "vertical" || symmetry.mode === "quad") { c.moveTo(cx, -far); c.lineTo(cx, far); }
      if (symmetry.mode === "horizontal" || symmetry.mode === "quad") { c.moveTo(-far, cy); c.lineTo(far, cy); }
      if (symmetry.mode === "radial" || symmetry.mode === "mandala") {
        const n = clamp(Math.round(symmetry.count), 2, 32);
        for (let i = 0; i < n; i++) { const a = (i * Math.PI * 2) / n - Math.PI / 2; c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * far, cy + Math.sin(a) * far); }
      }
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = "rgba(66,153,225,.95)";
      c.beginPath();
      c.arc(cx, cy, 4 / z, 0, Math.PI * 2);
      c.fill();
    }
    // the drawing guide
    if (guide.kind !== "none" && (PAINTS.has(tool) || tool === "shape")) {
      c.strokeStyle = "rgba(236,72,153,.7)";
      c.setLineDash([]);
      c.beginPath();
      const ray = (x, y, a) => { c.moveTo(x - Math.cos(a) * far, y - Math.sin(a) * far); c.lineTo(x + Math.cos(a) * far, y + Math.sin(a) * far); };
      const step = Math.max(40, Math.min(doc.width, doc.height) / 8);
      if (guide.kind === "parallel") {
        for (let i = -12; i <= 12; i++) ray(doc.width / 2 - Math.sin(guide.angle) * step * i, doc.height / 2 + Math.cos(guide.angle) * step * i, guide.angle);
      } else if (guide.kind === "grid") {
        for (let x = 0; x <= doc.width; x += step) { c.moveTo(x, 0); c.lineTo(x, doc.height); }
        for (let y = 0; y <= doc.height; y += step) { c.moveTo(0, y); c.lineTo(doc.width, y); }
      } else if (guide.kind === "iso") {
        for (let i = -14; i <= 14; i++) { ray(doc.width / 2 + i * step, doc.height / 2, Math.PI / 6); ray(doc.width / 2 + i * step, doc.height / 2, -Math.PI / 6); }
      } else if (guide.kind === "vanish" || guide.kind === "vanish2") {
        for (let i = 0; i < 24; i++) ray(guide.cx, guide.cy, (i * Math.PI) / 24);
        if (guide.kind === "vanish2") for (let i = 0; i < 24; i++) ray(guide.cx2, guide.cy2, (i * Math.PI) / 24);
        c.moveTo(-far, guide.cy); c.lineTo(far, guide.cy); // the horizon
      } else if (guide.kind === "circle") {
        for (let r = step; r < far / 2; r += step) { c.moveTo(guide.cx + r, guide.cy); c.arc(guide.cx, guide.cy, r, 0, Math.PI * 2); }
      }
      c.globalAlpha = 0.55;
      c.stroke();
      c.globalAlpha = 1;
      if (guide.kind === "vanish" || guide.kind === "vanish2" || guide.kind === "circle") {
        c.fillStyle = "rgba(236,72,153,.95)";
        c.beginPath();
        c.arc(guide.cx, guide.cy, 5 / z, 0, Math.PI * 2);
        if (guide.kind === "vanish2") { c.moveTo(guide.cx2, guide.cy2); c.arc(guide.cx2, guide.cy2, 5 / z, 0, Math.PI * 2); }
        c.fill();
      }
    }
    // a filled shape or a gradient being dragged
    if (drag && drag.kind === "shape" && drag.path && shapeFilled) {
      c.globalAlpha = brush.opacity * 0.9;
      c.fillStyle = colour;
      c.fill(drag.path);
      c.globalAlpha = 1;
    }
    if (drag && drag.kind === "gradient" && drag.end) {
      c.setLineDash([]);
      c.lineWidth = 3 / z;
      c.strokeStyle = "rgba(0,0,0,.55)";
      c.beginPath(); c.moveTo(drag.start.x, drag.start.y); c.lineTo(drag.end.x, drag.end.y); c.stroke();
      c.lineWidth = 1.5 / z;
      c.strokeStyle = "#fff";
      c.stroke();
      for (const [p, col] of [[drag.start, colour], [drag.end, gradTo === "secondary" ? colour2 : "#ffffff"]]) {
        c.beginPath(); c.arc(p.x, p.y, 6 / z, 0, Math.PI * 2); c.fillStyle = col; c.fill(); c.strokeStyle = "#000"; c.lineWidth = 1 / z; c.stroke();
      }
    }
    // the crop
    if (crop) {
      const r = crop.rect;
      c.setLineDash([]);
      c.fillStyle = "rgba(0,0,0,.55)";
      c.beginPath();
      c.rect(-far, -far, far * 2 + doc.width, far * 2 + doc.height);
      c.rect(r.x, r.y, r.w, r.h);
      c.fill("evenodd");
      c.lineWidth = 1.5 / z;
      c.strokeStyle = "#fff";
      c.strokeRect(r.x, r.y, r.w, r.h);
      c.lineWidth = 1 / z;
      c.strokeStyle = "rgba(255,255,255,.4)";
      c.beginPath();
      for (let i = 1; i < 3; i++) { c.moveTo(r.x + (r.w * i) / 3, r.y); c.lineTo(r.x + (r.w * i) / 3, r.y + r.h); c.moveTo(r.x, r.y + (r.h * i) / 3); c.lineTo(r.x + r.w, r.y + (r.h * i) / 3); }
      c.stroke();
      c.fillStyle = "#fff";
      c.strokeStyle = "rgba(0,0,0,.6)";
      const s = 5 / z;
      for (const [hx, hy] of cropHandles(r).map((q) => [q.x, q.y])) { c.beginPath(); c.rect(hx - s, hy - s, s * 2, s * 2); c.fill(); c.stroke(); }
    }
    // the box round a text layer, so you can see what the Text tool would pick up
    if (tool === "text" || textEdit) {
      const l = textEdit ? D.layerOf(doc, textEdit.id) : layer();
      if (l && l.kind === "text") {
        const b = engine.textBox(l);
        c.setLineDash([4 / z, 3 / z]);
        c.lineWidth = 1 / z;
        c.strokeStyle = accentColour();
        c.strokeRect(b.x - 4 / z, b.y - 2 / z, b.w + 8 / z, b.h + 4 / z);
      }
    }
    measure.draw(c);
    c.restore();
  }

  let accent = null;
  function accentColour() {
    if (accent) return accent;
    accent = getComputedStyle(root).getPropertyValue("--accent").trim() || "#f59f00";
    return accent;
  }

  /* ── pointer input ──────────────────────────────────────────────────── */

  let studio = null; // mounted at the bottom, once everything it needs exists
  let pickMode = ["piece", "layer", "off"].includes(app.settings.paintPick) ? app.settings.paintPick : "piece";
  let maskView = "off"; // "off" | "overlay" (red film where the mask hides) | "solo" (the mask alone)
  let pieceSel = null; // the selection the pointer tool made by picking a piece
  let lastSp = null; // where the pointer is over the canvas, in screen pixels
  let lastEnd = null; // where the last stroke ended: Shift+click draws a straight line from it
  let eatMenu = false; // an Alt+right-drag just resized the brush: no menu on release
  let drag = null;
  let liveSelect = null;
  let selectPts = null;

  const docPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    return D.toDocPoint(view, e.clientX - r.left, e.clientY - r.top);
  };
  const screenPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const activeTool = () => peek || tool;

  function layer() { return doc.layers.find((l) => l.id === selectedId) || doc.layers[doc.layers.length - 1]; }
  /** The surface strokes and fills land on: the layer's pixels, or its mask. */
  function targetKey() { const l = layer(); return !l ? null : onMask && l.mask ? D.maskKey(l.id) : l.id; }

  /** Can this layer be painted on right now? Says why not, and offers the way out. */
  function paintable(l) {
    if (readOnly) return false;
    if (!l) { toast("No layer selected", { ms: 1800 }); return false; }
    if (l.locked) { toast(`${l.name} is locked`, { ms: 1800 }); return false; }
    if (!l.visible) { toast(`${l.name} is hidden`, { ms: 1800 }); return false; }
    if (onMask && l.mask) return true;
    if (l.kind === "text") { toast("This is live text. Rasterise it to paint on it.", { ms: 5000, action: { label: "Rasterise", run: () => rasterise(l.id) } }); return false; }
    if (l.kind === "adjust" || l.kind === "group") {
      toast(`${l.kind === "group" ? "A group" : "An adjustment"} has no pixels of its own. Paint on its mask to say where it applies.`, { ms: 5200, action: { label: l.mask ? "Edit mask" : "Add a mask", run: () => (l.mask ? editMask(l.id, true) : addMask(l.id)) } });
      return false;
    }
    return true;
  }

  const selectModeOf = (e) => (e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : selMode);

  canvas.addEventListener("pointerdown", (e) => {
    if (destroyed || e.button === 1) { if (e.button === 1) startPan(e); return; }
    root.focus({ preventScroll: true });
    let t = activeTool();
    const sp = screenPoint(e);
    const p = docPoint(e);
    const brushy = PAINTS.has(tool) || tool === "shape";
    if (brushy && e.altKey && (e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey)))) return startBrushHud(e, sp);
    if (e.button === 2) return; // the context menu handles right-click
    if (spring) spring.used = true;
    // Ctrl with a brush in hand is the pointer for as long as it is held
    const borrowed = (e.ctrlKey || e.metaKey) && !e.altKey && PAINTS.has(tool) && !peek && !readOnly;
    if (borrowed) t = "transform";
    if (t === "hand") return startPan(e);
    if (t === "rotate") { canvas.setPointerCapture(e.pointerId); drag = { kind: "rotate", a0: Math.atan2(sp.y - view.cy, sp.x - view.cx), angle: view.angle }; return; }
    if (t === "measure") { e.preventDefault(); return measure.down(e, p, sp); }
    canvas.setPointerCapture(e.pointerId);
    if (placing) return placePoint(p);
    if (textEdit && t !== "text") commitText();
    if (t === "picker") { pickColour(p, e.altKey); return; }
    if (t === "transform") return startTransform(e, p, sp, borrowed);
    if (t === "marquee" || t === "lasso") return startSelect(e, p, t);
    if (t === "piece") {
      // a piece already lifted: moved where it is pressed, put down by a press outside it
      if (engine.floating) {
        if (floatHit(p).mode !== "outside") return startTransform(e, p, sp);
        commitFloat(); renderTop();
      }
      const l = layer();
      // inside the box: that piece comes along (Alt: a copy, the original stays) - nothing moves until the pointer does
      if (engine.selection && insideSelection(p) && l && !l.locked && D.hasPixels(l)) { drag = { kind: "lift", start: p, sp, layerId: l.id, borrowed: false, copy: e.altKey }; return; }
      // anywhere else: a new box
      drag = { kind: "select", mode: "marquee", start: p, how: "replace" };
      selectPts = null; liveSelect = null;
      return;
    }
    if (t === "wand") return doWand(p, selectModeOf(e));
    if (t === "crop") return startCrop(p);
    if (t === "text") return textDown(p);
    if (t === "fill") return doFill(p);
    const l = layer();
    if (!paintable(l)) return;
    if (t === "gradient") { drag = { kind: "gradient", start: p, end: null }; return; }
    if (t === "shape") return startShape(e, p, l);
    startStroke(e, p, l);
  });

  function startPan(e) {
    canvas.setPointerCapture(e.pointerId);
    const s = screenPoint(e);
    drag = { kind: "pan", x: s.x, y: s.y, cx: view.cx, cy: view.cy };
    root.classList.add("is-panning");
  }

  /** The brush a tool paints with: the eraser and the smudge are the brush with a different job. */
  function brushForTool(t) {
    if (t === "eraser" && brush.blend !== "erase") return { ...brush, blend: "erase" };
    if (t === "smudge") return { ...brush, blend: "smudge" };
    return brush;
  }

  function startStroke(e, p, l) {
    const b = brushForTool(activeTool());
    const pressure = e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5;
    const tilt = e.pointerType === "pen" ? tiltOf(e) : 0;
    // Shift, or the "straight lines" guide: the stroke is a rubber band from
    // where the pen went down to where it is now. Shift+click after a stroke
    // carries on from where that one ended, so click, Shift+click, Shift+click
    // draws a polygon.
    const rubber = b.blend !== "smudge" && (e.shiftKey || guide.kind === "line");
    const from = rubber && e.shiftKey && lastEnd && lastEnd.layerId === l.id ? lastEnd : p;
    engine.beginStroke(l.id, b, colour, from.x, from.y, pressure, tilt, { onMask: onMask && !!l.mask });
    drag = { kind: "stroke", simulate: e.pointerType !== "pen", layerId: l.id, brush: b, start: from, end: p, lock: null, rubber, pts: [p], hold: 0, last: p };
    if (from !== p) { engine.restartStroke(); engine.strokeLine(from.x, from.y, p.x, p.y, 0.75); }
    invalidateDoc(engine.box, b.size);
    armHold();
  }

  const tiltOf = (e) => Math.min(1, Math.hypot(e.tiltX || 0, e.tiltY || 0) / 60);

  /** "Hold to straighten": stop moving at the end of a stroke and a wobbly line becomes a clean one. */
  function armHold() {
    if (!drag || drag.kind !== "stroke") return;
    clearTimeout(drag.hold);
    if (drag.rubber || drag.brush.blend === "smudge" || drag.fixed) return;
    const mine = drag;
    drag.hold = setTimeout(() => {
      if (drag !== mine || !engine.stroke) return;
      const line = G.straightLine(mine.pts);
      const round = line ? null : G.cleanEllipse(mine.pts);
      if (!line && !round) return;
      const before = { ...engine.box };
      engine.restartStroke();
      if (line) {
        mine.rubber = true;
        mine.start = { x: line.x0, y: line.y0 };
        engine.strokeLine(line.x0, line.y0, line.x1, line.y1, 0.75);
      } else {
        mine.fixed = true; // an ellipse is finished; more movement does nothing
        strokePolyline(ellipsePoints(round.cx, round.cy, round.rx, round.ry));
      }
      invalidateDoc(unionDocBox(before, engine.box), mine.brush.size);
    }, 620);
  }

  function strokePolyline(pts, pressure = 0.75) {
    for (let i = 1; i < pts.length; i++) engine.strokeLine(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, pressure);
  }

  function ellipsePoints(cx, cy, rx, ry) {
    const n = clamp(Math.round((rx + ry) / 3), 24, 160);
    const out = [];
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry }); }
    return out;
  }

  canvas.addEventListener("pointermove", (e) => {
    if (destroyed) return;
    const sp = screenPoint(e);
    lastSp = sp;
    if (!drag) {
      moveCursor(sp, e);
      if (crop) hoverCrop(docPoint(e));
      else canvas.style.cursor = activeTool() === "transform" && engine.floating ? FLOAT_CURSORS[floatHit(docPoint(e)).mode] : activeTool() === "transform" && selHandleHit(docPoint(e)) ? FLOAT_CURSORS[selHandleHit(docPoint(e))] : "";
      return;
    }
    if (drag.kind === "brushhud") { brushHudMove(sp); return; }
    if (drag.kind === "lift") {
      if (Math.hypot(sp.x - drag.sp.x, sp.y - drag.sp.y) < 4) return;
      const lifted = engine.lift(drag.layerId, { wholeLayer: !engine.selection, copy: !!drag.copy });
      if (!lifted) { drag = null; return; }
      invalidate();
      renderTop();
      scheduleStatus();
      drag = { kind: "float", mode: "move", start: drag.start, ox: lifted.cx, oy: lifted.cy, borrowed: drag.borrowed };
    }
    if (drag.kind === "pan") {
      view.cx = drag.cx + (sp.x - drag.x);
      view.cy = drag.cy + (sp.y - drag.y);
      invalidate();
      return;
    }
    if (drag.kind === "rotate") {
      let a = drag.angle + (Math.atan2(sp.y - view.cy, sp.x - view.cx) - drag.a0);
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      view.angle = a;
      invalidate();
      scheduleStatus();
      return;
    }
    const p = docPoint(e);
    if (drag.kind === "stroke") { strokeMove(e, p, sp); return; }
    if (drag.kind === "shape") { shapeMove(e, p); return; }
    if (drag.kind === "gradient") { drag.end = e.shiftKey ? G.snapAngle(drag.start.x, drag.start.y, p.x, p.y) : p; invalidate(); return; }
    if (drag.kind === "select") { selectMove(p, e); return; }
    if (drag.kind === "pickbox") { drag.cur = p; invalidate(); return; }
    if (drag.kind === "float") { floatMove(p, e); return; }
    if (drag.kind === "crop") { cropMove(p); return; }
    if (drag.kind === "textmove") { textMove(p); return; }
  });

  function strokeMove(e, p, sp) {
    if (drag.fixed) return;
    const before = { x0: engine.box.x0, y0: engine.box.y0, x1: engine.box.x1, y1: engine.box.y1 };
    if (drag.rubber) {
      const end = e.shiftKey ? G.snapAngle(drag.start.x, drag.start.y, p.x, p.y) : p;
      drag.end = end;
      engine.restartStroke();
      engine.strokeLine(drag.start.x, drag.start.y, end.x, end.y, 0.75);
    } else {
      // coalesced events: every sample the OS collected since the last frame,
      // so a fast stroke is smooth instead of a polygon
      const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of pts.length ? pts : [e]) {
        let cp = docPoint(ce);
        if (guide.kind !== "none" && guide.kind !== "line") {
          if (!drag.lock) drag.lock = G.guideLock(guide, drag.start, cp, 8 / view.zoom);
          if (!drag.lock) continue; // not far enough yet to say which way this stroke goes
          cp = G.guideSnap(drag.lock, cp);
        }
        engine.strokeTo(cp.x, cp.y, ce.pointerType === "pen" ? (ce.pressure || 0.5) : 0.5, ce.pointerType === "pen" ? tiltOf(ce) : 0, drag.simulate);
        if (drag.pts.length < 4000) drag.pts.push(cp);
      }
    }
    invalidateDoc(unionDocBox(before, engine.box), drag.brush.size);
    moveCursor(sp, e);
    // only a real move re-arms the hold: a pen resting on glass still jitters
    if (Math.hypot(p.x - drag.last.x, p.y - drag.last.y) * view.zoom > 3) { drag.last = p; armHold(); }
  }

  const endPointer = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    root.classList.remove("is-panning");
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    if (d.kind === "brushhud") { endBrushHud(); return; }
    if (d.kind === "lift") { if (d.borrowed) deselect(); return; } // a click, not a drag: the piece stays picked
    if (d.kind === "stroke") {
      clearTimeout(d.hold);
      lastEnd = { ...(d.rubber ? d.end : d.pts[d.pts.length - 1] || d.start), layerId: d.layerId };
      const step = engine.endStroke();
      if (step) {
        pushPixels(d.brush.blend === "erase" ? "Erase" : d.brush.blend === "smudge" ? "Smudge" : onMask ? "Paint mask" : "Stroke", step);
        changed();
        thumbSoon();
      }
      invalidate();
      return;
    }
    if (d.kind === "shape") { shapeEnd(d); return; }
    if (d.kind === "gradient") { gradientEnd(d); return; }
    if (d.kind === "select") { selectEnd(d, e); return; }
    if (d.kind === "pickbox") { pickBoxEnd(d); return; }
    if (d.kind === "float") {
      d.mode = null;
      // borrowed with Ctrl from a brush: put it down and get out of the way
      if (d.borrowed) { commitFloat(); deselect(); renderTop(); }
      scheduleStatus();
      return;
    }
    if (d.kind === "crop") { crop.rect = G.normRect(crop.rect); renderOpts(); invalidate(); return; }
    if (d.kind === "textmove") { textMoveEnd(d); return; }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", () => {
    if (drag && (drag.kind === "stroke" || drag.kind === "shape")) { clearTimeout(drag.hold); engine.cancelStroke(); invalidate(); }
    drag = null;
    root.classList.remove("is-panning");
  });
  canvas.addEventListener("pointerleave", () => { lastSp = null; if (!cursor.classList.contains("is-hud")) cursor.hidden = true; });

  function moveCursor(sp, e) {
    const t = activeTool();
    const borrowing = e && (e.ctrlKey || e.metaKey) && !e.altKey;
    if (!PAINTS.has(t) || borrowing) { cursor.hidden = true; root.classList.toggle("is-borrowing", !!borrowing && PAINTS.has(t)); return; }
    root.classList.remove("is-borrowing");
    placeRing(sp);
  }

  function placeRing(sp) {
    const size = Math.max(6, brush.size * view.zoom);
    cursor.hidden = false;
    cursor.style.width = size + "px";
    cursor.style.height = size + "px";
    cursor.style.transform = `translate(${sp.x - size / 2}px, ${sp.y - size / 2}px)`;
    const core = Math.max(0, Math.min(1, brush.hardness)) * 100;
    cursorCore.style.width = cursorCore.style.height = core + "%";
  }

  /**
   * Show the brush ring with its numbers for a moment: after a key changed the
   * size or the hardness, so the change is seen where the eye already is. With
   * the pointer off the canvas the ring shows in the middle of it.
   */
  let ringTimer = 0;
  function flashRing(text, hold = false) {
    const at = (drag && drag.kind === "brushhud" && drag.sp) || lastSp || { x: W / 2, y: H / 2 };
    placeRing(at);
    cursorLabel.textContent = text;
    cursor.classList.add("is-hud");
    clearTimeout(ringTimer);
    if (!hold) ringTimer = setTimeout(() => { cursor.classList.remove("is-hud"); if (!lastSp || !PAINTS.has(activeTool())) cursor.hidden = true; }, 900);
  }

  /* Ctrl+Alt+drag, or Alt + right-drag: across for size, up and down for hardness */

  function startBrushHud(e, sp) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2) eatMenu = true;
    drag = { kind: "brushhud", sp, size: brush.size, hardness: brush.hardness };
    root.classList.add("is-hud");
    flashRing(`${Math.round(brush.size)} px · ${Math.round(brush.hardness * 100)}%`, true);
  }
  function brushHudMove(sp) {
    const dx = sp.x - drag.sp.x;
    const dy = sp.y - drag.sp.y;
    // a screen pixel of drag is a screen pixel of brush, within reason at extreme zooms
    const size = clamp(Math.round(drag.size + dx * clamp(1 / view.zoom, 0.25, 4)), 1, BRUSH_MAX);
    const hardness = clamp(Math.round((drag.hardness - dy / 220) * 100) / 100, 0, 1);
    if (size !== brush.size) setParam("size", size);
    if (hardness !== brush.hardness) setParam("hardness", hardness);
    flashRing(`${size} px · ${Math.round(hardness * 100)}%`, true);
  }
  function endBrushHud() {
    root.classList.remove("is-hud");
    flashRing(`${Math.round(brush.size)} px · ${Math.round(brush.hardness * 100)}%`);
    renderOpts();
  }

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const sp = screenPoint(e);
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      zoomTo(view.zoom * k, sp.x, sp.y);
    } else {
      view.cx -= e.deltaX;
      view.cy -= e.deltaY;
      invalidate();
    }
  }, { passive: false });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (eatMenu) { eatMenu = false; return; }
    const p = docPoint(e);
    if ((PAINTS.has(tool) || tool === "shape") && !e.shiftKey) return brushHud(e.clientX, e.clientY, p);
    viewMenu(e.clientX, e.clientY, p);
  });

  /**
   * Right-click with a brush in hand: its size, opacity, hardness and flow,
   * the brushes used lately and the palette, right under the pointer.
   */
  let hudEl = null;
  const recentBrushes = [];
  function noteBrush(id) {
    const at = recentBrushes.indexOf(id);
    if (at >= 0) recentBrushes.splice(at, 1);
    recentBrushes.unshift(id);
    recentBrushes.length = Math.min(recentBrushes.length, 6);
  }
  function brushHud(x, y, p) {
    if (hudEl && hudEl.__close) hudEl.__close();
    const all = [...B.PRESETS, ...S.customBrushes(app).map((b) => ({ ...B.resolve(b.from || B.DEFAULT_PRESET, b), id: b.id, name: b.name, family: "custom" }))];
    const byId = new Map(all.map((b) => [b.id, b]));
    const quick = [...new Set([brushId, ...recentBrushes, "inker", "pencil", "marker", "airbrush", "ink-brush", "charcoal"])].map((id) => byId.get(id)).filter(Boolean).slice(0, 6);
    const palette = (app.settings[S.SETTING_KEYS.palette] || DEFAULT_COLOURS).slice(0, 10);
    const body = h("div", { class: "pt-hud-body" });
    const paintBody = () => fill(body,
      slider("Size", brush.size, 1, BRUSH_MAX, 1, (v) => { setParam("size", v); flashRing(`${Math.round(v)} px`); }, (v) => `${Math.round(v)} px`),
      slider(tool === "smudge" ? "Strength" : "Opacity", brush.opacity * 100, 1, 100, 1, (v) => setParam("opacity", v / 100), (v) => `${Math.round(v)}%`),
      slider("Hardness", brush.hardness * 100, 0, 100, 1, (v) => { setParam("hardness", v / 100); flashRing(`${Math.round(v)}% hard`); }, (v) => `${Math.round(v)}%`),
      slider("Flow", brush.flow * 100, 1, 100, 1, (v) => setParam("flow", v / 100), (v) => `${Math.round(v)}%`),
      h("div", { class: "pt-hud-brushes" }, ...quick.map((b) => h("button", {
        class: "pt-hud-brush" + (b.id === brushId ? " is-on" : ""), title: b.name,
        onclick: () => { setBrush(b.id); paintBody(); },
      }, strokePreview(b), h("span", { text: b.name })))),
      h("div", { class: "pt-hud-colours" }, ...palette.map((c) => h("button", {
        class: "pt-hud-colour" + (c.toLowerCase() === colour.toLowerCase() ? " is-on" : ""), title: c, style: `background:${c}`,
        onclick: () => { setColour(c); paintBody(); },
      }))),
      h("div", { class: "pt-hud-foot" },
        h("button", { class: "pt-opt-btn", title: "The colour under where you right-clicked", onclick: () => { pickColour(p); paintBody(); } }, svg(I.picker), "Pick here"),
        h("button", { class: "pt-opt-btn", title: "Every brush and every setting (F1)", onclick: () => { hudEl.__close(); brushPanel.hidden = false; renderBrushPanel(); renderTools(); } }, svg(I.sliders), "Brushes"),
        h("button", { class: "pt-opt-btn", title: "Zoom, mirror, symmetry and selection commands (Shift + right-click goes straight here)", onclick: () => { hudEl.__close(); viewMenu(x, y, p); } }, "View…")));
    paintBody();
    hudEl = h("div", { class: "pt-pop pt-glass pt-hud", onkeydown: (e) => { if (e.key === "Escape") { e.stopPropagation(); hudEl.__close(); } } },
      h("div", { class: "pt-hud-head" }, svg(I.brush), h("span", { text: "Brush" }), h("kbd", { text: "[ ]  size" }), h("kbd", { text: "{ }  hardness" })),
      body);
    // under the pointer, a little up and left, so the first slider is a short move away
    const anchor = { getBoundingClientRect: () => ({ left: x - 24, right: x, top: y - 30, bottom: y - 30 }), contains: () => false };
    popover(hudEl, anchor, { onClose: () => { hudEl = null; root.focus({ preventScroll: true }); } });
  }

  function viewMenu(x, y, p) {
    menu(x, y, [
      { label: "Pick this colour", icon: "palette", run: () => pickColour(p) },
      "sep",
      { label: "Fit to window", icon: "expand", run: () => fit() },
      { label: "100%", icon: "actualSize", run: () => zoomTo(1, view.cx, view.cy) },
      { label: view.flip ? "Un-mirror the view" : "Mirror the view", icon: "flipH", run: () => flipView() },
      { label: "Canvas edge line", icon: "crop", checked: !!app.settings.paintEdge, run: () => { app.setSetting("paintEdge", !app.settings.paintEdge); invalidate(); } },
      // as Sketch has: the guides a moved piece snaps to, off for good (Alt frees one drag either way)
      { label: "Smart guides", icon: "grid", checked: app.settings.studioSmartGuides !== false, run: () => app.setSetting("studioSmartGuides", app.settings.studioSmartGuides === false) },
      view.angle ? { label: "Straighten the view", icon: "rotateLeft", run: () => { view.angle = 0; invalidate(); scheduleStatus(); } } : null,
      symmetry.mode !== "none" ? "sep" : null,
      symmetry.mode !== "none" ? { label: "Put the symmetry centre here", icon: "target", run: () => { symmetry.cx = Math.round(p.x); symmetry.cy = Math.round(p.y); syncAssist(); changed(); invalidate(); } } : null,
      "sep",
      // with something picked: a new layer of just that; without, the whole layer
      engine.selection && !engine.floating ? { label: "Duplicate layer - just what is picked", icon: "copy", keys: "Ctrl+J", run: () => layerViaCopy() }
        : { label: "Duplicate layer", icon: "copy", keys: "Ctrl+J", run: () => duplicateLayer(selectedId) },
      workspace === "animate" && anim && anim.hasFrames ? { label: engine.selection ? "Duplicate frame - just what is picked" : "Duplicate frame", icon: "layers", keys: "Ctrl+D", run: () => anim.duplicate({ only: engine.selection }) } : null,
      ...(engine.selection ? ["sep",
        { label: "Deselect", icon: "x", keys: workspace === "animate" && anim && anim.hasFrames ? null : "Ctrl+D", run: () => deselect() },
        { label: "Invert the selection", icon: "swap", keys: "Ctrl+Shift+I", run: () => { engine.invertSelection(); afterSelect(); } },
        { label: "Mask the layer with it", icon: "circleShape", run: () => addMask(selectedId, "selection") }] : []),
      "sep",
      { label: "Keyboard shortcuts", icon: "keyboard", keys: "?", run: () => shortcutSheet() },
    ]);
  }

  function flipView() {
    // mirror about the middle of what is on screen, not the middle of the picture
    const mid = D.toDocPoint(view, W / 2, H / 2);
    view.flip = !view.flip;
    view.angle = -view.angle;
    const after = D.toScreenPoint(view, mid.x, mid.y);
    view.cx += W / 2 - after.x;
    view.cy += H / 2 - after.y;
    invalidate();
    renderTop();
    scheduleStatus();
  }

  /* ── tools ──────────────────────────────────────────────────────────── */

  function pushPixels(label, step, keyOverride = null) {
    const key = keyOverride || step.key;
    history.push(pixelStep(label, key, step.rect.x, step.rect.y, step.rect.w, step.rect.h, step.before,
      (id, x, y, w, hh, data) => {
        const was = engine.swapRegion(id, x, y, w, hh, data);
        invalidate();
        thumbSoon();
        return was;
      }));
  }

  /** A pixel change as a step object, for the ones that travel with a layer-list change. */
  const pixelsOf = (label, step) => pixelStep(label, step.key, step.rect.x, step.rect.y, step.rect.w, step.rect.h, step.before,
    (id, x, y, w, hh, data) => { const was = engine.swapRegion(id, x, y, w, hh, data); invalidate(); thumbSoon(); return was; });

  function landed(label, step) {
    if (!step) return false;
    pushPixels(label, step);
    changed();
    invalidate();
    thumbSoon();
    return true;
  }

  function pickColour(p, second = false) {
    const hex = engine.pick(p.x, p.y);
    if (!hex) { toast("Nothing there to pick", { ms: 1500 }); return; }
    if (second) { colour2 = hex; renderTools(); } else setColour(hex);
    toast(`Picked ${hex}`, { ms: 1400 });
  }

  function doFill(p) {
    const l = layer();
    if (!paintable(l)) return;
    if (onMask && l.mask) {
      // on a mask a "fill" is a flood of show or hide over the selection
      const key = D.maskKey(l.id);
      return landed("Fill mask", hexLuma(colour) < 0.5 ? engine.clearArea(key) : engine.fillArea(key, "#000"));
    }
    landed("Fill", engine.fill(l.id, p.x, p.y, colour, { tolerance: fillTolerance, sampleAll: fillSampleAll }));
  }

  function gradientEnd(d) {
    const l = layer();
    if (!d.end || !l || Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) < 3) { invalidate(); return; }
    const mask = onMask && l.mask;
    let stops;
    if (mask) {
      // on a mask the gradient is a fade: from the colour's lightness to its opposite
      const a = hexLuma(colour);
      const b = gradTo === "secondary" ? hexLuma(colour2) : 1 - a;
      stops = [{ at: 0, colour: `rgba(0,0,0,${a})` }, { at: 1, colour: `rgba(0,0,0,${b})` }];
    } else {
      const [r, g, bl] = parseHex(colour);
      stops = [{ at: 0, colour }, { at: 1, colour: gradTo === "secondary" ? colour2 : `rgba(${r},${g},${bl},0)` }];
    }
    landed("Gradient", engine.gradient(targetKey(), d.start.x, d.start.y, d.end.x, d.end.y, stops, { radial: gradKind === "radial", opacity: gradOpacity, replace: !!mask }));
  }

  /* shapes */

  function shapePoints(a, b, e) {
    let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
    if (shapeKind === "line") {
      const end = e.shiftKey ? G.snapAngle(x0, y0, x1, y1) : b;
      return { pts: [a, end], closed: false, box: { x: Math.min(x0, end.x), y: Math.min(y0, end.y), w: Math.abs(end.x - x0), h: Math.abs(end.y - y0) } };
    }
    if (e.shiftKey) { const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s; }
    if (e.altKey) { x0 = a.x - (x1 - a.x); y0 = a.y - (y1 - a.y); }
    const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    if (shapeKind === "ellipse") return { pts: ellipsePoints(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2), closed: true, box };
    if (shapeKind === "triangle") return { pts: [{ x: box.x + box.w / 2, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }, { x: box.x + box.w / 2, y: box.y }], closed: true, box };
    return { pts: [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }, { x: box.x, y: box.y }], closed: true, box };
  }

  function startShape(e, p, l) {
    const b = brush.blend === "erase" ? brush : { ...brush, blend: brush.blend === "multiply" ? "multiply" : "normal" };
    if (!shapeFilled || shapeKind === "line") engine.beginStroke(l.id, b, colour, p.x, p.y, 0.75, 0, { onMask: onMask && !!l.mask });
    drag = { kind: "shape", start: p, layerId: l.id, brush: b, path: null, box: null, outline: !shapeFilled || shapeKind === "line" };
  }

  function shapeMove(e, p) {
    const s = shapePoints(drag.start, p, e);
    drag.box = s.box;
    if (drag.outline) {
      const before = { ...engine.box };
      engine.restartStroke();
      strokePolyline(s.pts, 1);
      invalidateDoc(unionDocBox(before, engine.box), drag.brush.size);
    } else {
      const path = new Path2D();
      path.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i = 1; i < s.pts.length; i++) path.lineTo(s.pts[i].x, s.pts[i].y);
      path.closePath();
      drag.path = path;
      invalidate();
    }
  }

  function shapeEnd(d) {
    if (d.outline) {
      // a click without a drag is not a shape
      if (!d.box || (d.box.w < 2 && d.box.h < 2)) { engine.cancelStroke(); invalidate(); return; }
      landed("Shape", engine.endStroke());
    } else if (d.path && d.box && d.box.w > 1 && d.box.h > 1) {
      landed("Shape", engine.fillPath(targetKey(), d.path, d.box, onMask ? "#000" : colour, brush.opacity));
    }
    invalidate();
  }

  /* selections */

  function startSelect(e, p, kind) {
    drag = { kind: "select", mode: kind, start: p, how: selectModeOf(e) };
    selectPts = kind === "lasso" ? [p] : null;
    liveSelect = null;
  }

  function selectMove(p, e) {
    if (drag.mode === "marquee") {
      const s = drag.start;
      let w = p.x - s.x;
      let hh = p.y - s.y;
      if (e && e.ctrlKey) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; } // Ctrl: a square or a circle
      const box = { x: Math.min(s.x, s.x + w), y: Math.min(s.y, s.y + hh), w: Math.abs(w), h: Math.abs(hh) };
      const path = new Path2D();
      if (marqueeShape === "ellipse") path.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
      else path.rect(box.x, box.y, box.w, box.h);
      liveSelect = path;
      drag.box = box;
    } else {
      const last = selectPts[selectPts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
      selectPts.push(p);
      const path = new Path2D();
      path.moveTo(selectPts[0].x, selectPts[0].y);
      for (let i = 1; i < selectPts.length; i++) path.lineTo(selectPts[i].x, selectPts[i].y);
      path.closePath();
      liveSelect = path;
    }
    invalidate();
  }

  /** `d` is the drag that just ended — `drag` itself is already cleared. */
  function selectEnd(d) {
    if (!liveSelect) { if (d.how === "replace") deselect(); return; }
    let box = d && d.box;
    if (!box && selectPts) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of selectPts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const path = liveSelect;
    liveSelect = null;
    selectPts = null;
    if (!box || box.w < 2 || box.h < 2) { if (d.how === "replace") deselect(); else invalidate(); return; }
    engine.selectPath(path, box, d.how);
    afterSelect();
  }

  function afterSelect() {
    liveSelect = null;
    invalidate();
    scheduleStatus();
    renderOpts();
  }

  function deselect() {
    engine.clearSelection();
    afterSelect();
  }

  /** Kept for callers from before selections were bitmaps: `{ path, box }` or null. */
  function setSelection(sel) {
    if (!sel) return deselect();
    engine.selectPath(sel.path, sel.box, "replace");
    afterSelect();
  }

  function selectAll() {
    engine.selectAll();
    afterSelect();
  }

  function doWand(p, how) {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) { if (how === "replace") deselect(); return; }
    root.classList.add("is-busy");
    // let the cursor change before a second of pixel work on a big canvas
    requestAnimationFrame(() => setTimeout(() => {
      try {
        const l = layer();
        const px = engine.readPixels({ layerId: wandSampleAll || !l || !D.hasPixels(l) ? null : l.id });
        const res = wandContiguous ? B.floodFill(px.data, px.width, px.height, x, y, wandTolerance) : colourSelect(px.data, px.width, px.height, x, y, wandTolerance);
        if (res.box.x1 < res.box.x0) { if (how === "replace") deselect(); return; }
        // one pixel wider, the way the bucket does it: the anti-aliased rim of a
        // shape belongs to the shape, and leaving it out leaves a fringe behind
        engine.selectBytes(wandContiguous ? B.growMask(res.mask, px.width, px.height, 1) : res.mask, px.width, px.height, how);
        afterSelect();
      } finally {
        root.classList.remove("is-busy");
      }
    }, 0));
  }

  /* move and transform */

  const FLOAT_CURSORS = { move: "move", scale: "nwse-resize", rotate: "grab", outside: "default" };

  /** The topmost layer with paint under a point: what a click on the picture means. */
  function layerAt(p) {
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) return null;
    const byId = new Map(doc.layers.map((l) => [l.id, l]));
    const shown = (l) => { for (let n = l, i = 0; n && i < 12; n = n.parent ? byId.get(n.parent) : null, i++) if (!n.visible || n.locked) return false; return true; };
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!D.hasPixels(l) || !shown(l)) continue;
      const bm = engine.layers.get(l.id);
      if (bm && bm.ctx.getImageData(px, py, 1, 1).data[3] > 10) return l;
    }
    return null;
  }

  const insideSelection = (p) => {
    const s = engine.selection;
    if (!s) return false;
    const px = Math.floor(p.x), py = Math.floor(p.y);
    if (px < s.box.x || py < s.box.y || px >= s.box.x + s.box.w || py >= s.box.y + s.box.h) return false;
    return s.mask.getContext("2d").getImageData(px, py, 1, 1).data[3] > 0;
  };

  /**
   * Select the piece of a layer under a point: the stroke, the doodle, the
   * pasted picture - whatever is joined to where you clicked. A piece that is
   * nearly the whole layer (a photo, a filled background) is just the layer.
   */
  function pickPiece(l, p, how = "replace") {
    const px = engine.readPixels({ layerId: l.id });
    const res = alphaIsland(px.data, px.width, px.height, p.x, p.y);
    if (res.box.x1 < res.box.x0) return false;
    if (res.box.count > 0.9 * px.width * px.height) { if (engine.selection && how === "replace") deselect(); return true; }
    engine.selectBytes(res.mask, px.width, px.height, how);
    pieceSel = engine.selection; // the pointer's own pick, not a selection you made to work inside
    afterSelect();
    return true;
  }

  /** The pieces a box touched, on the layer chosen (or the one with paint under its first corner). */
  function pickBoxEnd(d) {
    const r = { x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y) };
    invalidate();
    if (r.w < 3 && r.h < 3) return; // a plain click on nothing: it only let go
    // in Animate the box reaches every layer of the frame on screen; elsewhere, the layer chosen
    let px;
    if (workspace === "animate" && anim && anim.hasFrames) { const fc = anim.frameImage(); px = fc.getContext("2d").getImageData(0, 0, fc.width, fc.height); }
    else { const l = layer(); if (!l || !D.hasPixels(l)) return; px = engine.readPixels({ layerId: l.id }); }
    const res = islandsTouching(px.data, px.width, px.height, r);
    if (!res.count) { toast("No paint in that box on this layer", { ms: 1800 }); return; }
    engine.selectBytes(res.mask, px.width, px.height, d.how);
    pieceSel = null; // a selection made on purpose: it stays, to move, copy or make a frame from
    afterSelect();
  }

  /** The pointer's pick ends with the pointer: nobody wants to find their brush fenced in by it. */
  function dropPiece() {
    if (pieceSel && engine.selection === pieceSel && !engine.floating) deselect();
    pieceSel = null;
  }

  function chooseLayer(id) {
    if (selectedId === id && !onMask) return;
    if (textEdit) commitText();
    selectedId = id;
    doc.selected = id;
    setOnMask(false);
    renderLayers();
    studio.render();
    scheduleStatus();
  }

  function startTransform(e, p, sp, borrowed = false) {
    let f = engine.floating;
    // a click well outside what is being moved puts it down and picks again
    if (f && pickMode !== "off" && floatHit(p).mode === "outside") { commitFloat(); renderTop(); f = null; }
    if (!f) {
      if (readOnly) return;
      const adding0 = e.shiftKey || ((e.ctrlKey || e.metaKey) && !borrowed);
      // a corner or the knob round what is picked: lifted there and then, and that handle taken (a Shift or Ctrl click picks instead)
      if (!adding0 && selHandleHit(p)) {
        freeTransform();
        const g = engine.floating;
        if (g) {
          const hit = floatHit(p);
          drag = { kind: "float", mode: hit.mode === "outside" ? "move" : hit.mode, corner: hit.corner, start: p, ox: g.cx, oy: g.cy, sx: g.sx, sy: g.sy, angle: g.angle };
          return;
        }
      }
      // Shift or Ctrl on a piece already picked: it is let go of, the rest stays picked
      if (pickMode === "piece" && adding0 && engine.selection && insideSelection(p)) {
        const hit = layerAt(p);
        if (hit && hit.kind !== "text") { chooseLayer(hit.id); pickPiece(hit, p, "subtract"); renderOpts(); invalidate(); }
        return;
      }
      if (pickMode !== "off" && !insideSelection(p)) {
        const hit = layerAt(p);
        // Shift or Ctrl adds to what is picked (Ctrl with a brush in hand only borrows the pointer)
        const adding = e.shiftKey || ((e.ctrlKey || e.metaKey) && !borrowed);
        // a click on nothing lets go; a drag from there draws a box, and every piece it touches is picked whole
        if (!hit) { if (engine.selection && !adding) deselect(); drag = { kind: "pickbox", start: p, cur: p, how: adding ? "add" : e.altKey ? "subtract" : "replace" }; return; }
        chooseLayer(hit.id);
        if (pickMode === "piece" && hit.kind !== "text") pickPiece(hit, p, adding ? "add" : "replace");
        else if (engine.selection) deselect();
        renderOpts();
      }
      const l = layer();
      if (!l || l.locked) return;
      if (l.kind === "text") { drag = { kind: "textmove", start: p, before: layerSnapshot(), x: l.text.x, y: l.text.y, id: l.id }; return; }
      if (!D.hasPixels(l)) { toast("Only layers with pixels can be moved. Rasterise a group to move it as one.", { ms: 3600 }); return; }
      // nothing is lifted until the pointer actually moves: a click only picks
      // Alt held: a copy comes along, the original stays (as Photoshop's Alt-drag)
      drag = { kind: "lift", start: p, sp, layerId: l.id, borrowed, copy: e.altKey };
      return;
    }
    const hit = floatHit(p);
    if (hit.mode === "outside") hit.mode = "move";
    drag = { kind: "float", mode: hit.mode, corner: hit.corner, start: p, ox: f.cx, oy: f.cy, sx: f.sx, sy: f.sy, angle: f.angle };
  }

  /** Which handle a document point is on: a corner, the rotate knob, or the body. */
  function floatHit(p) {
    const f = engine.floating;
    const c = Math.cos(-f.angle);
    const s = Math.sin(-f.angle);
    const dx = p.x - f.cx;
    const dy = p.y - f.cy;
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const hw = (f.w * f.sx) / 2;
    const hh = (f.h * f.sy) / 2;
    const r = 10 / view.zoom;
    if (Math.hypot(lx, ly + hh + 26 / view.zoom) < r * 1.4) return { mode: "rotate" };
    const corners = [[-hw, -hh, "tl"], [hw, -hh, "tr"], [hw, hh, "br"], [-hw, hh, "bl"]];
    for (const [x, y, id] of corners) if (Math.abs(lx - x) < r && Math.abs(ly - y) < r) return { mode: "scale", corner: id };
    if (Math.abs(lx) > hw + r * 2 || Math.abs(ly) > hh + r * 2) return { mode: "outside" };
    return { mode: "move" };
  }

  /** Ctrl+T: pick up the selection (or the layer) with its handles showing, without dragging anything. */
  function freeTransform() {
    if (tool !== "transform") setTool("transform");
    if (engine.floating || readOnly) return;
    const l = layer();
    if (!l || l.locked || !D.hasPixels(l) || l.kind === "text") return;
    if (engine.lift(l.id, { wholeLayer: !engine.selection })) { invalidate(); renderTop(); renderOpts(); scheduleStatus(); }
  }

  /** Arrow keys with the pointer tool: a pixel at a time, ten with Shift. */
  function nudge(dx, dy) {
    if (readOnly) return;
    const l = layer();
    if (!l || l.locked) return;
    if (l.kind === "text" && !engine.floating) {
      const before = layerSnapshot();
      l.text.x += dx; l.text.y += dy;
      engine.renderText(l.id);
      pushMeta("Move text", before);
      changed(); invalidate(); thumbSoon();
      return;
    }
    if (!engine.floating) { if (!D.hasPixels(l) || !engine.lift(l.id, { wholeLayer: !engine.selection })) return; renderTop(); }
    engine.floating.cx += dx;
    engine.floating.cy += dy;
    invalidate();
  }

  function floatMove(p, e) {
    const f = engine.floating;
    if (!f) return;
    if (drag.mode === "move") {
      f.cx = drag.ox + (p.x - drag.start.x);
      f.cy = drag.oy + (p.y - drag.start.y);
      // smart guides: its middle or its edges catch the canvas's middle, edges and thirds, and the rulers' guides (Alt: free)
      snapLines = [];
      if (!e.altKey && app.settings.studioSmartGuides !== false) {
        const tol = 8 / view.zoom;
        const hw = (Math.abs(f.w * f.sx * Math.cos(f.angle)) + Math.abs(f.h * f.sy * Math.sin(f.angle))) / 2;
        const hh = (Math.abs(f.w * f.sx * Math.sin(f.angle)) + Math.abs(f.h * f.sy * Math.cos(f.angle))) / 2;
        const lines = (axis, size) => [0, size / 3, size / 2, (2 * size) / 3, size, ...ruleGuides.filter((g) => g.axis === axis).map((g) => g.at)];
        const catchAxis = (c0, half, axis, size) => {
          let best = null;
          for (const at of lines(axis, size)) for (const off of [0, -half, half]) { const d = Math.abs(c0 + off - at); if (d < tol && (!best || d < best.d)) best = { d, c: at - off, at }; }
          return best;
        };
        const bx = catchAxis(f.cx, hw, "x", doc.width), by = catchAxis(f.cy, hh, "y", doc.height);
        if (bx) { f.cx = bx.c; snapLines.push(["x", bx.at]); }
        if (by) { f.cy = by.c; snapLines.push(["y", by.at]); }
      }
    } else if (drag.mode === "rotate") {
      const a = Math.atan2(p.y - f.cy, p.x - f.cx) - Math.atan2(drag.start.y - f.cy, drag.start.x - f.cx);
      f.angle = drag.angle + (e.shiftKey ? Math.round((drag.angle + a) / (Math.PI / 12)) * (Math.PI / 12) - drag.angle : a);
    } else if (drag.mode === "scale") {
      const c = Math.cos(-f.angle);
      const s = Math.sin(-f.angle);
      const lx = (p.x - f.cx) * c - (p.y - f.cy) * s;
      const ly = (p.x - f.cx) * s + (p.y - f.cy) * c;
      const kx = Math.abs(lx) / (f.w / 2 || 1);
      const ky = Math.abs(ly) / (f.h / 2 || 1);
      // a photo keeps its shape unless Shift says otherwise; a drawn selection is free unless Shift holds it
      const keep = f.placed ? !e.shiftKey : e.shiftKey;
      const k = keep ? Math.max(kx, ky) : null;
      f.sx = Math.max(0.02, k ?? kx);
      f.sy = Math.max(0.02, k ?? ky);
    }
    invalidate();
  }

  function commitFloat() {
    const f = engine.floating;
    if (!f) return;
    const step = engine.commitFloat();
    // what was moved is down again; the outline of where it used to be means nothing now
    if (pieceSel && engine.selection === pieceSel) { engine.clearSelection(); pieceSel = null; liveSelect = null; }
    if (step) {
      pushPixels(f.placed ? "Place picture" : "Transform", step);
      changed();
      thumbSoon();
    }
    invalidate();
    scheduleStatus();
  }

  function cancelFloat() {
    engine.cancelFloat();
    invalidate();
    renderTop();
  }

  /* crop */

  const cropHandles = (r) => [
    { id: "nw", x: r.x, y: r.y }, { id: "n", x: r.x + r.w / 2, y: r.y }, { id: "ne", x: r.x + r.w, y: r.y },
    { id: "e", x: r.x + r.w, y: r.y + r.h / 2 }, { id: "se", x: r.x + r.w, y: r.y + r.h },
    { id: "s", x: r.x + r.w / 2, y: r.y + r.h }, { id: "sw", x: r.x, y: r.y + r.h }, { id: "w", x: r.x, y: r.y + r.h / 2 },
  ];

  const ratioValue = () => { const r = G.CROP_RATIOS.find((x) => x.id === cropRatio); return !r ? 0 : r.r < 0 ? doc.width / doc.height : r.r; };

  function beginCrop() {
    const sel = engine.selection;
    crop = { rect: sel ? { ...sel.box } : { x: 0, y: 0, w: doc.width, h: doc.height } };
    if (ratioValue()) crop.rect = G.fitRatio(doc.width, doc.height, ratioValue());
    invalidate();
    renderOpts();
  }

  function cropHit(p) {
    const r = crop.rect;
    const d = 12 / view.zoom;
    for (const hd of cropHandles(r)) if (Math.abs(p.x - hd.x) < d && Math.abs(p.y - hd.y) < d) return hd.id;
    if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return "move";
    return null;
  }

  const CROP_CURSORS = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", move: "move" };
  function hoverCrop(p) { canvas.style.cursor = (crop && CROP_CURSORS[cropHit(p)]) || ""; }

  function startCrop(p) {
    if (!crop) beginCrop();
    const hit = cropHit(p);
    if (hit) { drag = { kind: "crop", handle: hit, start: p, rect: { ...crop.rect } }; return; }
    // a drag on empty space draws a new crop
    crop.rect = { x: p.x, y: p.y, w: 1, h: 1 };
    drag = { kind: "crop", handle: "se", start: p, rect: { ...crop.rect } };
  }

  function cropMove(p) {
    crop.rect = G.dragCrop(drag.rect, drag.handle, p.x - drag.start.x, p.y - drag.start.y, { ratio: ratioValue(), min: 4 });
    invalidate();
    scheduleOpts();
  }

  function applyCrop() {
    if (!crop) return;
    const r = G.normRect(crop.rect);
    if (r.w > D.MAX_SIDE || r.h > D.MAX_SIDE || r.w * r.h > D.MAX_PIXELS) return toast(`That is bigger than a canvas can be (${D.MAX_SIDE} px a side, ${Math.round(D.MAX_PIXELS / 1e6)} MP)`, { kind: "error" });
    crop = null;
    canvas.style.cursor = "";
    docOp("Crop", () => engine.cropTo(r));
    setTool(lastTool === "crop" ? "brush" : lastTool);
  }

  function cancelCrop() {
    crop = null;
    canvas.style.cursor = "";
    invalidate();
    setTool(lastTool === "crop" ? "brush" : lastTool);
  }

  /* text */

  const TEXT_KEYS = ["font", "size", "bold", "italic", "align", "lineHeight", "tracking"];

  function textAt(p) {
    for (const l of [...doc.layers].reverse()) {
      if (l.kind !== "text" || !l.visible || l.locked) continue;
      const b = engine.textBox(l);
      if (p.x >= b.x - 8 && p.x <= b.x + b.w + 8 && p.y >= b.y - 8 && p.y <= b.y + b.h + 8) return l;
    }
    return null;
  }

  function textDown(p) {
    if (textEdit) { commitText(); return; }
    const hit = textAt(p);
    if (hit) return beginText(hit, false, layerSnapshot());
    if (readOnly) return;
    if (doc.layers.length >= D.MAX_LAYERS) return toast(`A drawing can have ${D.MAX_LAYERS} layers`, { kind: "error" });
    const before = layerSnapshot();
    const l = D.newLayer({
      kind: "text", name: "Text",
      text: { ...D.TEXT_DEFAULTS, ...textOpts, colour, text: "", x: Math.round(p.x), y: Math.round(p.y - (textOpts.size * textOpts.lineHeight) / 2) },
    });
    insertAbove(l);
    engine.addLayerBitmap(l.id);
    beginText(l, true, before);
  }

  function beginText(l, isNew, before) {
    selectedId = l.id;
    onMask = false;
    for (const k of TEXT_KEYS) if (l.text[k] !== undefined) textOpts[k] = l.text[k];
    const ta = h("textarea", { class: "pt-textedit", spellcheck: false, wrap: "off" });
    ta.value = l.text.text || "";
    root.append(ta);
    textEdit = { id: l.id, isNew, before, ta, orig: { ...l.text } };
    ta.addEventListener("input", () => setText({ text: ta.value }));
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); cancelText(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText(); }
    });
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    renderLayers();
    renderOpts();
    invalidate();
    requestAnimationFrame(() => { placeTextarea(); ta.focus(); ta.select(); });
  }

  /** Change the text being edited (its words or its style) and show it at once. */
  function setText(patch) {
    const l = textEdit && D.layerOf(doc, textEdit.id);
    if (!l) return;
    l.text = { ...l.text, ...patch };
    engine.renderText(l.id);
    // a font that was not loaded yet draws as the fallback; set it again when it arrives
    if (patch.font || patch.bold !== undefined || patch.italic !== undefined) {
      const id = l.id;
      document.fonts.load(engine.textFont(l.text)).then(() => { if (!destroyed && D.layerOf(doc, id)) { engine.renderText(id); invalidate(); } }).catch(() => {});
    }
    placeTextarea();
    invalidate();
    thumbSoon();
  }

  function placeTextarea() {
    const te = textEdit;
    const l = te && D.layerOf(doc, te.id);
    if (!l) return;
    const t = l.text;
    const b = engine.textBox(l);
    const sp = D.toScreenPoint(view, b.x, b.y);
    const z = view.zoom;
    const s = te.ta.style;
    s.left = sp.x + "px";
    s.top = sp.y + "px";
    s.width = Math.max(40, (b.w + t.size) * z) + "px";
    s.height = Math.max(10, b.h * z) + "px";
    s.font = engine.textFont({ ...t, size: t.size * z });
    s.lineHeight = String(t.lineHeight);
    s.letterSpacing = (t.tracking || 0) * z + "px";
    s.textAlign = t.align;
    // for centred and right-set text the box starts at the widest line, so the
    // caret sits where the glyphs are drawn
    s.marginLeft = t.align === "left" ? "0" : t.align === "center" ? -(t.size * z) / 2 + "px" : -(t.size * z) + "px";
    s.transform = `rotate(${view.angle}rad)${view.flip ? " scaleX(-1)" : ""}`;
  }

  function commitText() {
    const te = textEdit;
    if (!te) return;
    textEdit = null;
    te.ta.remove();
    const l = D.layerOf(doc, te.id);
    if (l) {
      if (!String(l.text.text || "").trim()) {
        if (te.isNew) restoreLayers(te.before);
        else { l.text = te.orig; engine.renderText(l.id); }
      } else if (te.isNew || JSON.stringify(l.text) !== JSON.stringify(te.orig)) {
        if (te.isNew || /^Text( \d+)?$/.test(l.name) || l.name === String(te.orig.text || "").split("\n")[0].slice(0, 28)) l.name = l.text.text.split("\n")[0].slice(0, 28) || "Text";
        pushMeta(te.isNew ? "Add text" : "Edit text", te.before);
      }
    }
    renderLayers();
    renderOpts();
    invalidate();
    thumbSoon();
    root.focus({ preventScroll: true });
  }

  function cancelText() {
    const te = textEdit;
    if (!te) return;
    textEdit = null;
    te.ta.remove();
    restoreLayers(te.before);
    renderOpts();
    root.focus({ preventScroll: true });
  }

  /** A style change from the options bar: the text being edited, or the selected text layer. */
  function textOption(patch) {
    Object.assign(textOpts, patch);
    if (textEdit) { setText(patch); renderOpts(); return; }
    const l = layer();
    if (l && l.kind === "text" && !l.locked && !readOnly) {
      const before = layerSnapshot();
      l.text = { ...l.text, ...patch };
      engine.renderText(l.id);
      document.fonts.load(engine.textFont(l.text)).then(() => { if (!destroyed) { engine.renderText(l.id); invalidate(); } }).catch(() => {});
      pushMeta("Text style", before);
      invalidate();
      thumbSoon();
    }
    renderOpts();
  }

  function textMove(p) {
    const l = D.layerOf(doc, drag.id);
    if (!l) return;
    l.text = { ...l.text, x: Math.round(drag.x + p.x - drag.start.x), y: Math.round(drag.y + p.y - drag.start.y) };
    engine.renderText(l.id);
    invalidate();
  }

  function textMoveEnd(d) {
    const l = D.layerOf(doc, d.id);
    if (l && (l.text.x !== d.x || l.text.y !== d.y)) { pushMeta("Move text", d.before); thumbSoon(); }
  }

  /* assists: where a symmetry centre or a vanishing point goes */

  function placePoint(p) {
    const what = placing;
    placing = null;
    root.classList.remove("is-placing");
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (what === "symmetry") { symmetry.cx = x; symmetry.cy = y; }
    if (what === "vanish") { guide.cx = x; guide.cy = y; }
    if (what === "vanish2") { guide.cx2 = x; guide.cy2 = y; }
    if (what === "angle") guide.angle = Math.atan2(y - doc.height / 2, x - doc.width / 2);
    syncAssist();
    changed();
    invalidate();
    renderOpts();
  }

  function askPoint(what, hint) {
    placing = what;
    root.classList.add("is-placing");
    toast(hint, { ms: 3200 });
  }

  /* ── layers ─────────────────────────────────────────────────────────── */

  const layerSnapshot = () => ({ layers: doc.layers.map((l) => ({ ...l })), selected: selectedId });

  function restoreLayers(snap) {
    doc.layers = snap.layers.map((l) => ({ ...l }));
    // bitmaps are never dropped on an undo, so a layer that comes back finds
    // its pixels; one that never had any gets them now
    for (const l of doc.layers) {
      if (D.hasPixels(l) && !engine.layers.has(l.id)) engine.addLayerBitmap(l.id);
      if (l.mask && !engine.mask(l.id)) engine.addMask(l.id);
      if (l.kind === "text") engine.renderText(l.id);
    }
    selectedId = doc.layers.some((l) => l.id === snap.selected) ? snap.selected : doc.layers[doc.layers.length - 1].id;
    const sel = layer();
    if (!sel || !sel.mask) setOnMask(false);
    engine.allDirty = true;
    invalidate();
    renderLayers();
    renderOpts();
    scheduleStatus();
    thumbSoon();
  }

  function structural(label, fn) {
    const before = layerSnapshot();
    fn();
    doc.layers = D.normalizeLayers(doc.layers);
    pushMeta(label, before);
  }

  /** Record a layer-list change that has already happened. */
  function pushMeta(label, before) {
    const after = layerSnapshot();
    history.push(metaStep(label, before, after, restoreLayers));
    changed();
    renderLayers();
    invalidate();
  }

  /** Put a new layer just above the selected one, in the same group. */
  function insertAbove(l) {
    const sel = layer();
    l.parent = sel ? sel.parent || null : null;
    const at = sel ? D.layerIndex(doc, sel.id) + 1 : doc.layers.length;
    doc.layers.splice(at, 0, l);
    doc.layers = D.normalizeLayers(doc.layers);
    selectedId = l.id;
    setOnMask(false);
  }

  const roomFor = (n = 1) => {
    if (doc.layers.length + n <= D.MAX_LAYERS) return true;
    toast(`A drawing can have ${D.MAX_LAYERS} layers`, { kind: "error" });
    return false;
  };

  function addLayer() {
    if (!roomFor()) return;
    structural("Add layer", () => {
      const l = D.newLayer({ name: D.nextLayerName(doc.layers) });
      insertAbove(l);
      engine.addLayerBitmap(l.id);
    });
  }

  function addGroup({ wrap = false } = {}) {
    if (!roomFor()) return;
    const sel = layer();
    structural(wrap ? "Group layer" : "New group", () => {
      const g = D.newLayer({ kind: "group", name: D.nextLayerName(doc.layers, "Group"), collapsed: false, passThrough: false });
      insertAbove(g);
      if (wrap && sel) { sel.parent = g.id; selectedId = g.id; }
    });
  }

  /** An adjustment layer above the selected one. With a selection up, it is masked to it. */
  function addAdjust(adjust) {
    if (!roomFor()) return null;
    const def = ADJUST_BY_ID.get(adjust.type);
    const before = layerSnapshot();
    const l = D.newLayer({ kind: "adjust", name: def ? def.name : "Adjustment", adjust });
    insertAbove(l);
    const steps = [];
    if (engine.selection) {
      engine.addMask(l.id);
      const px = engine.fillMask(l.id, "selection");
      l.mask = true;
      if (px) steps.push(pixelsOf("Mask", px));
      deselect();
    }
    const after = layerSnapshot();
    steps.push(metaStep("Add adjustment", before, after, restoreLayers));
    history.push(steps.length > 1 ? groupStep(`Add ${l.name.toLowerCase()}`, steps) : steps[0]);
    changed();
    renderLayers();
    invalidate();
    return l;
  }

  function duplicateLayer(id) {
    const src = D.layerOf(doc, id);
    if (!src) return;
    const block = [src, ...D.descendants(doc.layers, id)];
    if (!roomFor(block.length)) return;
    structural("Duplicate layer", () => {
      const ids = new Map(block.map((l) => [l.id, D.layerId()]));
      const copies = block.map((l) => ({
        ...l, id: ids.get(l.id), name: l.id === id ? D.copyName(l.name) : l.name,
        parent: l.id === id ? l.parent || null : ids.get(l.parent) || null,
      }));
      for (const l of block) {
        const nid = ids.get(l.id);
        const bm = engine.bitmap(l.id);
        if (D.hasPixels(l)) engine.addLayerBitmap(nid, bm ? bm.canvas : null);
        const m = l.mask ? engine.mask(l.id) : null;
        if (m) engine.addMask(nid, { from: m.canvas });
      }
      // children sit under their group in the flat list, so the block goes in whole, above the original
      const order = doc.layers.filter((l) => ids.has(l.id)).map((l) => copies.find((c) => c.id === ids.get(l.id)));
      doc.layers.splice(D.layerIndex(doc, id) + 1, 0, ...order);
      selectedId = ids.get(id);
    });
  }

  function deleteLayer(id) {
    const l = D.layerOf(doc, id);
    if (!l) return;
    const gone = new Set([id, ...D.descendants(doc.layers, id).map((x) => x.id)]);
    if (doc.layers.length - gone.size < 1) return toast("A drawing needs at least one layer", { ms: 2000 });
    if (textEdit && gone.has(textEdit.id)) cancelText();
    structural("Delete layer", () => {
      const i = D.layerIndex(doc, id);
      doc.layers = doc.layers.filter((x) => !gone.has(x.id));
      // the bitmaps stay in the engine so undo can bring the layers back
      if (gone.has(selectedId)) selectedId = doc.layers[clamp(i - gone.size, 0, doc.layers.length - 1)].id;
      setOnMask(false);
    });
    toast(`${l.name} deleted`, { ms: 2600, action: { label: "Undo", run: () => doUndo() } });
  }

  /**
   * Merge changes pixels AND the layer list, so it is one step that does both
   * — two separate steps would let undo take back half a merge.
   */
  function mergeDown(id) {
    const target = D.mergeTarget(doc, id);
    if (!target) return toast("Nothing under this layer that it can merge into", { ms: 2400 });
    const before = layerSnapshot();
    const pixels = engine.mergeDown(id);
    if (!pixels) return;
    doc.layers.splice(D.layerIndex(doc, id), 1);
    selectedId = target.id;
    setOnMask(false);
    const after = layerSnapshot();
    history.push(groupStep("Merge down", [pixelsOf("Merge down", pixels), metaStep("Merge down", before, after, restoreLayers)]));
    changed();
    renderLayers();
    invalidate();
    thumbSoon();
  }

  /** Text, or a whole group, becomes one ordinary layer of pixels. */
  function rasterise(id) {
    const l = D.layerOf(doc, id);
    if (!l) return;
    if (l.kind === "text") {
      if (textEdit && textEdit.id === id) commitText();
      return structural("Rasterise text", () => { const t = D.layerOf(doc, id); t.kind = "raster"; delete t.text; });
    }
    if (l.kind !== "group") return;
    const pixels = engine.rasterise(id);
    structural("Merge group", () => {
      const gone = new Set([id, ...D.descendants(doc.layers, id).map((x) => x.id)]);
      const flat = D.newLayer({ name: l.name, opacity: l.opacity, blend: l.passThrough ? "normal" : l.blend, visible: l.visible, parent: l.parent || null, clip: l.clip });
      engine.addLayerBitmap(flat.id, pixels);
      const at = D.layerIndex(doc, id);
      doc.layers.splice(at + 1, 0, flat);
      doc.layers = doc.layers.filter((x) => !gone.has(x.id));
      selectedId = flat.id;
    });
    pixels.width = 1;
    pixels.height = 1;
    thumbSoon();
  }

  /** Mirror one layer's pixels (inside the selection, if there is one). */
  function flipLayer(id, axis) {
    const l = D.layerOf(doc, id);
    if (!l || l.locked || readOnly) return;
    landed(axis === "h" ? "Flip layer" : "Flip layer", engine.filterSurface(id, (c, src, W, H) => {
      const r = engine.selection ? engine.selection.box : { x: 0, y: 0, w: W, h: H };
      c.drawImage(src, 0, 0);
      c.save();
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      c.clearRect(r.x, r.y, r.w, r.h);
      // about the middle of what is being flipped, so it stays where it is
      if (axis === "h") { c.translate(r.x * 2 + r.w, 0); c.scale(-1, 1); } else { c.translate(0, r.y * 2 + r.h); c.scale(1, -1); }
      c.drawImage(src, 0, 0);
      c.restore();
    }));
  }

  function flattenPicture() {
    docOp("Flatten picture", () => {
      const snap = engine.docSnapshot();
      const flat = engine.flatten(1, { background: false });
      const l = D.newLayer({ name: "Picture" });
      engine.layers = new Map();
      engine.addLayerBitmap(l.id, flat);
      flat.width = 1;
      flat.height = 1;
      doc.layers = [l];
      selectedId = l.id;
      return snap;
    });
  }

  let soloed = null; // { id, was: Map(id -> visible) }
  function soloLayer(id) {
    const before = layerSnapshot();
    if (soloed && soloed.id === id) {
      for (const l of doc.layers) if (soloed.was.has(l.id)) l.visible = soloed.was.get(l.id);
      soloed = null;
    } else {
      const was = soloed ? soloed.was : new Map(doc.layers.map((l) => [l.id, l.visible]));
      const keep = new Set([id]);
      const byId = new Map(doc.layers.map((l) => [l.id, l]));
      for (let n = byId.get(id); n && n.parent; n = byId.get(n.parent)) keep.add(n.parent); // its groups stay on
      for (const d of D.descendants(doc.layers, id) || []) keep.add(d.id || d);
      for (const l of doc.layers) l.visible = keep.has(l.id) ? true : false;
      soloed = { id, was };
    }
    pushMeta("Show only this layer", before);
    engine.allDirty = true;
    changed(); renderLayers(); invalidate(); thumbSoon();
  }

  function setLayerProp(id, key, value, label) {
    const l = D.layerOf(doc, id);
    if (!l || l[key] === value) return;
    structural(label || "Layer settings", () => { D.layerOf(doc, id)[key] = value; });
    engine.allDirty = true;
  }

  function moveLayer(from, to) {
    if (from === to) return;
    structural("Reorder layers", () => { doc.layers = D.reorder(doc.layers, from, to); });
    engine.allDirty = true;
  }

  /** Drag and drop in the panel: above a row, below it, or into a group. */
  function dropLayer(id, overId, where) {
    if (id === overId) return;
    const next = D.moveLayerTo(doc.layers.map((l) => ({ ...l })), id, overId, where);
    if (next.map((l) => l.id + (l.parent || "")).join() === doc.layers.map((l) => l.id + (l.parent || "")).join()) return;
    structural("Move layer", () => { doc.layers = next; });
    engine.allDirty = true;
  }

  /* masks */

  function setOnMask(on) {
    const l = layer();
    const next = !!(on && l && l.mask);
    if (next === onMask) return;
    onMask = next;
    // painting a mask is painting in black and white: start on white (show),
    // and give the colour back afterwards
    if (onMask) { colourBeforeMask = colour; setColour(hexLuma(colour) < 0.5 ? "#000000" : "#ffffff", false); }
    else if (colourBeforeMask) { setColour(colourBeforeMask, false); colourBeforeMask = null; }
    if (!onMask && maskView !== "off") { maskView = "off"; engine.allDirty = true; invalidate(); }
    root.classList.toggle("is-masking", onMask);
    renderTop();
  }

  /** See the mask while you work on it: as a red film over the picture, or on its own. */
  function setMaskView(mode, id = selectedId) {
    const l = D.layerOf(doc, id);
    if (!l || !l.mask) { toast("This layer has no mask yet", { ms: 2200, action: { label: "Add one", run: () => addMask(id) } }); return; }
    if (mode !== "off" && (selectedId !== id || !onMask)) editMask(id, true);
    maskView = mode;
    renderTop();
    engine.allDirty = true;
    invalidate();
  }

  function editMask(id, on) {
    selectedId = id;
    setOnMask(on);
    renderLayers();
  }

  /** `how`: reveal | hide | selection | selection-out */
  function addMask(id, how = null) {
    const l = D.layerOf(doc, id);
    if (!l || readOnly) return;
    if (l.mask) return editMask(id, true);
    const fillWith = how || (engine.selection ? "selection" : "reveal");
    const before = layerSnapshot();
    engine.addMask(id);
    const px = engine.fillMask(id, fillWith);
    D.layerOf(doc, id).mask = true;
    D.layerOf(doc, id).maskOn = true;
    selectedId = id;
    const after = layerSnapshot();
    history.push(groupStep("Add mask", [...(px ? [pixelsOf("Mask", px)] : []), metaStep("Add mask", before, after, restoreLayers)]));
    if (fillWith.startsWith("selection")) deselect();
    changed();
    setOnMask(true);
    renderLayers();
    invalidate();
    thumbSoon();
  }

  function deleteMask(id) {
    if (selectedId === id) setOnMask(false);
    setLayerProp(id, "mask", false, "Delete mask");
  }

  function applyMask(id) {
    const l = D.layerOf(doc, id);
    if (!l || !l.mask || !D.hasPixels(l) || l.kind === "text") return toast("Only a layer of pixels can have its mask applied", { ms: 2400 });
    const before = layerSnapshot();
    const px = engine.applyMask(id);
    D.layerOf(doc, id).mask = false;
    if (selectedId === id) setOnMask(false);
    const after = layerSnapshot();
    history.push(groupStep("Apply mask", [...(px ? [pixelsOf("Apply mask", px)] : []), metaStep("Apply mask", before, after, restoreLayers)]));
    changed();
    renderLayers();
    invalidate();
    thumbSoon();
  }

  function maskMenu(l, e) {
    menu(e.clientX, e.clientY, [
      { header: "Mask" },
      { label: onMask && selectedId === l.id ? "Stop painting" : "Paint", icon: "brush", run: () => editMask(l.id, !(onMask && selectedId === l.id)) },
      { label: "Overlay", icon: "layers", keys: "\\", checked: maskView === "overlay" && selectedId === l.id, run: () => setMaskView(maskView === "overlay" && selectedId === l.id ? "off" : "overlay", l.id) },
      { label: "Mask only", icon: "contrast", keys: "Alt+click", checked: maskView === "solo" && selectedId === l.id, run: () => setMaskView(maskView === "solo" && selectedId === l.id ? "off" : "solo", l.id) },
      { label: l.maskOn === false ? "Mask on" : "Mask off", icon: "eye", keys: "Shift+click", run: () => setLayerProp(l.id, "maskOn", l.maskOn === false, "Mask on/off") },
      { label: "Invert", icon: "swap", run: () => landed("Invert mask", engine.fillMask(l.id, "invert")) },
      { label: "Show all", icon: "sun", run: () => landed("Reveal all", engine.fillMask(l.id, "reveal")) },
      { label: "Hide all", icon: "moon", run: () => landed("Hide all", engine.fillMask(l.id, "hide")) },
      engine.selection ? { label: "From selection", icon: "circleShape", run: () => landed("Mask from selection", engine.fillMask(l.id, "selection")) } : null,
      { label: "Select it", icon: "target", run: () => { engine.selectSurface(D.maskKey(l.id)); afterSelect(); } },
      "sep",
      D.hasPixels(l) && l.kind !== "text" ? { label: "Apply", icon: "check", run: () => applyMask(l.id) } : null,
      { label: "Delete", icon: "trash", danger: true, run: () => deleteMask(l.id) },
    ]);
  }

  /* whole-document operations */

  /**
   * Crop, canvas size, image size, turn, flatten: everything changes size at
   * once, so the step keeps the old canvases themselves (not copies of their
   * bytes) and swaps the whole set back.
   */
  function docOp(label, fn) {
    if (readOnly) return;
    if (textEdit) commitText();
    if (engine.floating) commitFloat();
    let snap = fn();
    if (!snap) return;
    const afterDoc = () => {
      view.width = doc.width;
      view.height = doc.height;
      if (!doc.layers.some((l) => l.id === selectedId)) selectedId = doc.layers[doc.layers.length - 1].id;
      setOnMask(false);
      checker = null;
      symmetry.cx = clamp(symmetry.cx, 0, doc.width);
      symmetry.cy = clamp(symmetry.cy, 0, doc.height);
      fit();
      renderLayers();
      renderOpts();
      studio.render();
      scheduleStatus();
      thumbSoon();
    };
    history.push({
      kind: "doc",
      label,
      bytes: snap.bytes,
      run() { snap = engine.restoreDoc(snap); this.bytes = snap.bytes; afterDoc(); },
      dispose() { for (const bm of snap.surfaces.values()) if (![...engine.layers.values()].includes(bm)) { bm.canvas.width = 1; bm.canvas.height = 1; } },
    });
    afterDoc();
    changed();
  }

  /* ── layers panel ───────────────────────────────────────────────────── */

  const thumbEls = new Map(); // surface key -> canvas
  let thumbTimer = 0;
  const thumbSoon = () => {
    if (thumbTimer) return;
    thumbTimer = setTimeout(() => { thumbTimer = 0; paintThumbs(); }, 220);
  };

  function paintThumbs() {
    if (destroyed || asleep) return;
    for (const [key, el2] of thumbEls) {
      if (!engine.layers.has(key)) continue;
      const c = engine.layerThumb(key, 46, 46);
      const g = el2.getContext("2d");
      g.clearRect(0, 0, 46, 46);
      g.drawImage(c, 0, 0);
      c.width = 1;
      c.height = 1;
    }
  }

  const kindLine = (l) => {
    if (l.kind === "adjust") return (ADJUST_BY_ID.get(l.adjust && l.adjust.type) || { name: "Adjustment" }).name;
    if (l.kind === "group") return l.passThrough ? "Group · pass through" : "Group";
    if (l.kind === "text") return "Text";
    return null;
  };

  /** "Multiply · 60%" under a layer's name; the kind first when it is not plain pixels. */
  function layerSub(l) {
    // an adjustment is named after what it is until someone renames it: say it once
    const kind = kindLine(l) === l.name ? null : kindLine(l);
    const blend = D.BLEND_BY_ID.get(l.blend).name;
    const showBlend = !(l.kind === "group" && l.passThrough) && (blend !== "Normal" || (!kind && !kindLine(l)));
    return [kind, showBlend ? blend : null, l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : null, hasFx(l) ? "fx" : null].filter(Boolean).join(" · ");
  }

  function layerRow(l, depth) {
    const pix = D.hasPixels(l);
    let thumb;
    if (pix) {
      thumb = h("canvas", { class: "pt-lay-thumb", width: 46, height: 46 });
      thumbEls.set(l.id, thumb);
    }
    let maskThumb = null;
    if (l.mask) {
      maskThumb = h("canvas", { class: "pt-lay-thumb", width: 46, height: 46 });
      thumbEls.set(D.maskKey(l.id), maskThumb);
    }
    const isSel = l.id === selectedId;
    const dropZone = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const t = (e.clientY - r.top) / r.height;
      if (l.kind === "group" && t > 0.3 && t < 0.7) return "into";
      return t < 0.5 ? "above" : "below";
    };
    const clearDrop = (el2) => el2.classList.remove("is-drop-above", "is-drop-below", "is-drop-into");
    return h("div", {
      class: "pt-lay" + (isSel ? " is-on" : "") + (l.visible ? "" : " is-hidden") + (l.kind !== "raster" ? ` is-${l.kind}` : ""),
      style: depth ? `margin-left:${depth * 14}px` : null,
      dataset: { id: l.id },
      draggable: !readOnly,
      onclick: (e) => {
        if (e.ctrlKey || e.metaKey) { // Ctrl+click: select what the layer has paint on
          if (pix) { engine.selectSurface(l.id, selectModeOf(e) === "replace" ? "replace" : selectModeOf(e)); afterSelect(); }
          return;
        }
        if (selectedId !== l.id || onMask) { if (textEdit) commitText(); selectedId = l.id; doc.selected = l.id; setOnMask(false); renderLayers(); renderOpts(); studio.render(); scheduleStatus(); }
      },
      ondragstart: (e) => { e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; },
      ondragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; clearDrop(e.currentTarget); e.currentTarget.classList.add("is-drop-" + dropZone(e)); },
      ondragleave: (e) => clearDrop(e.currentTarget),
      ondrop: (e) => {
        e.preventDefault();
        const zone = dropZone(e);
        clearDrop(e.currentTarget);
        // the panel is top-first and the document bottom-first: "above" a row is after it in the list
        dropLayer(e.dataTransfer.getData("text/plain"), l.id, { into: zone === "into", below: zone === "below" });
      },
      oncontextmenu: (e) => { e.preventDefault(); layerMenu(l, e); },
    },
      h("button", {
        class: "pt-lay-eye" + (l.visible ? "" : " is-off"), title: l.visible ? "Hide this layer" : "Show this layer",
        onclick: (e) => {
          e.stopPropagation();
          if (e.altKey) return soloLayer(l.id); // Alt+click: only this one, and again to bring the rest back
          setLayerProp(l.id, "visible", !l.visible, l.visible ? "Hide layer" : "Show layer");
        },
      }, l.visible ? icon("eye") : svg(I.eyeOff)),
      l.clip ? h("span", { class: "pt-lay-clip", title: "Clipped to the layer below: it only shows where that layer has paint" }, svg(I.clip)) : null,
      l.kind === "group"
        ? h("button", { class: "pt-lay-fold" + (l.collapsed ? " is-shut" : ""), title: l.collapsed ? "Open the group" : "Close the group", onclick: (e) => { e.stopPropagation(); l.collapsed = !l.collapsed; changed(); renderLayers(); } }, icon("chevronDown"))
        : null,
      h("div", { class: "pt-lay-thumb-wrap" + (isSel && !onMask ? " is-target" : "") + (pix ? "" : " is-icon") },
        pix ? thumb : l.kind === "adjust" ? svg(I.adjust) : l.kind === "group" ? svg(I.folder) : svg(I.text)),
      l.mask ? h("div", {
        class: "pt-lay-thumb-wrap pt-lay-mask" + (isSel && onMask ? " is-target" : "") + (l.maskOn === false ? " is-off" : ""),
        title: "The mask · click to paint on it · Alt+click shows the mask alone · Shift+Alt+click shows it as a red film over the picture · Shift+click switches it off · right-click for more",
        onclick: (e) => { e.stopPropagation(); if (e.altKey) { const want = e.shiftKey ? "overlay" : "solo"; return setMaskView(maskView === want && selectedId === l.id ? "off" : want, l.id); } if (e.shiftKey) return setLayerProp(l.id, "maskOn", l.maskOn === false, "Mask on/off"); editMask(l.id, true); },
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); maskMenu(l, e); },
      }, maskThumb) : null,
      h("div", { class: "pt-lay-meta" },
        h("div", { class: "pt-lay-name", text: l.name, title: "Double-click to rename", ondblclick: (e) => { e.stopPropagation(); renameLayer(l, e.currentTarget); } }),
        h("div", { class: "pt-lay-sub", text: layerSub(l) })),
      h("div", { class: "pt-lay-flags" },
        l.alphaLock ? h("span", { class: "pt-flag", title: "Alpha locked: only what is already painted can change" }, svg(I.alphaLock)) : null,
        l.locked ? h("span", { class: "pt-flag", title: "Locked" }, icon("lock")) : null),
      h("button", { class: "pt-lay-more", title: "Layer options", onclick: (e) => { e.stopPropagation(); layerMenu(l, e); } }, icon("more")));
  }

  function rowsOf(nodes, depth) {
    const out = [];
    for (const n of [...nodes].reverse()) {
      out.push(layerRow(n.layer, depth));
      if (n.layer.kind === "group" && !n.layer.collapsed) out.push(...rowsOf(n.children, depth + 1));
    }
    return out;
  }

  function renderLayers() {
    thumbEls.clear();
    const rows = rowsOf(D.layerTree(doc.layers), 0);
    const sel = layer();
    const isGroup = sel.kind === "group";
    fill(layersPanel,
      h("div", { class: "pt-panel-head" },
        h("span", { class: "pt-panel-title" }, icon("layers"), "Layers"),
        h("button", { class: "pt-icon", title: "New layer (Ctrl+Shift+N)", onclick: addLayer, disabled: readOnly }, svg(I.plus))),
      h("div", { class: "pt-lay-props" },
        h("label", { class: "pt-field is-blend" },
          h("select", {
            class: "pt-select", disabled: readOnly || (isGroup && sel.passThrough),
            onchange: (e) => setLayerProp(sel.id, "blend", e.target.value, "Blend mode"),
          }, ...D.BLEND_GROUPS.map((g, i) => h("optgroup", { label: ["", "Darken", "Lighten", "Contrast", "Compare", "Colour"][i] || " " },
            ...g.map((id) => { const b = D.BLEND_BY_ID.get(id); return h("option", { value: b.id, text: b.name, selected: b.id === sel.blend }); }))))),
        opacityField(sel),
        h("div", { class: "pt-lay-toggles" },
          isGroup
            ? toggle("Pass through", sel.passThrough, () => setLayerProp(sel.id, "passThrough", !sel.passThrough, "Pass through"), "The layers inside blend with the picture as if the group were not there")
            : toggle("Alpha lock", sel.alphaLock, () => setLayerProp(sel.id, "alphaLock", !sel.alphaLock, "Alpha lock"), "Paint only where this layer already has paint"),
          toggle("Clip", sel.clip, () => setLayerProp(sel.id, "clip", !sel.clip, "Clip to layer below"), "Only show where the layer below has paint (a clipping mask)"),
          toggle("Lock", sel.locked, () => setLayerProp(sel.id, "locked", !sel.locked, "Lock layer"), "Stop this layer changing"))),
      h("div", { class: "pt-lay-list" }, ...rows),
      h("div", { class: "pt-lay-bar" },
        h("button", { class: "pt-icon", title: "New layer, group, text or adjustment", onclick: (e) => newLayerMenu(e.currentTarget), disabled: readOnly }, svg(I.plus)),
        h("button", { class: "pt-icon" + (sel.mask ? " is-on" : ""), title: sel.mask ? "Paint on this layer's mask" : engine.selection ? "Mask this layer to the selection" : "Add a mask: paint black to hide, white to show", onclick: () => addMask(selectedId), disabled: readOnly }, svg(I.mask)),
        h("button", { class: "pt-icon", title: "New group (Ctrl+G groups the selected layer)", onclick: () => addGroup(), disabled: readOnly }, svg(I.folder)),
        h("button", { class: "pt-icon", title: "Duplicate (Ctrl+J)", onclick: () => duplicateLayer(selectedId), disabled: readOnly }, svg(I.copy)),
        h("button", { class: "pt-icon", title: "Merge down (Ctrl+E)", onclick: () => mergeDown(selectedId), disabled: readOnly }, svg(I.mergeDown)),
        h("button", { class: "pt-icon pt-danger", title: "Delete", onclick: () => deleteLayer(selectedId), disabled: readOnly }, svg(I.trash))));
    paintThumbs();
    // Studio's panel shows the selected layer's adjustment, so it follows the list
    if (studio) studio.render();
  }

  function newLayerMenu(anchor) {
    menu(0, 0, [
      { label: "Layer", icon: "layers", keys: "Ctrl+Shift+N", run: addLayer },
      { label: "Group", icon: "folder", run: () => addGroup() },
      { label: "Text", icon: "caseText", keys: "T", run: () => setTool("text") },
      { label: "Picture from the vault…", icon: "image", run: () => studio.placePicture() },
      { header: "Adjustment" },
      ...studio.adjustItems(),
    ], { anchor });
  }

  /**
   * Opacity drags live and lands as one undo step: the value before the drag
   * is captured on pointerdown, so a slow drag is not fifty steps.
   */
  function opacityField(sel) {
    let from = sel.opacity;
    const out = h("span", { class: "pt-num", text: Math.round(sel.opacity * 100) + "%" });
    return h("label", { class: "pt-field" }, h("span", { text: "Opacity" }),
      h("input", {
        class: "pt-range", type: "range", min: 0, max: 100, step: 1, value: Math.round(sel.opacity * 100), disabled: readOnly,
        onpointerdown: () => { from = sel.opacity; },
        oninput: (e) => { sel.opacity = Number(e.target.value) / 100; out.textContent = e.target.value + "%"; engine.allDirty = true; invalidate(); },
        onchange: (e) => {
          const to = Number(e.target.value) / 100;
          sel.opacity = from;
          structural("Layer opacity", () => { D.layerOf(doc, sel.id).opacity = to; });
          engine.allDirty = true;
        },
      }), out);
  }

  const toggle = (label, on, run, title) =>
    h("button", { class: "pt-toggle" + (on ? " is-on" : ""), onclick: run, title: title || label, disabled: readOnly }, label);

  function renameLayer(l, target) {
    const input = h("input", { class: "pt-rename", value: l.name });
    target.replaceChildren(input);
    input.focus();
    input.select();
    const done = (ok) => {
      const v = input.value.trim();
      if (ok && v && v !== l.name) structural("Rename layer", () => { D.layerOf(doc, l.id).name = v.slice(0, 120); });
      else renderLayers();
    };
    input.addEventListener("blur", () => done(true));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
  }

  /** Drop shadow, stroke and outer glow, live on the canvas while the sliders move; one undo step when it closes. */
  function styleDialog(l) {
    const before = layerSnapshot();
    const fx = JSON.parse(JSON.stringify(l.fx || {}));
    fx.shadow = { on: false, color: "#000000", opacity: 0.6, blur: 14, dist: 12, angle: 120, ...(fx.shadow || {}) };
    fx.stroke = { on: false, color: "#000000", size: 4, opacity: 1, ...(fx.stroke || {}) };
    fx.glow = { on: false, color: "#ffd84a", size: 20, opacity: 0.8, ...(fx.glow || {}) };
    const apply = () => { D.layerOf(doc, l.id).fx = JSON.parse(JSON.stringify(fx)); engine.pixVer++; engine.allDirty = true; invalidate(); };
    const colourIn = (part) => { const i = h("input", { type: "color", class: "pt-fx-col", value: part.color }); i.addEventListener("input", () => { part.color = i.value; apply(); }); return i; };
    const section = (name, part, rows) => {
      const body = h("div", { class: "pt-fx-body" + (part.on ? "" : " is-off") }, ...rows);
      const tick = h("input", { type: "checkbox", checked: part.on });
      tick.addEventListener("change", () => { part.on = tick.checked; body.classList.toggle("is-off", !part.on); apply(); });
      return h("section", { class: "pt-fx-sec" }, h("label", { class: "pt-fx-head" }, tick, h("span", { text: name }), colourIn(part)), body);
    };
    const on = (part) => (fn) => (v) => { part.on = true; fn(v); apply(); };
    const box = h("div", { class: "pt-pop pt-glass pt-fx" },
      h("div", { class: "pt-hud-head" }, icon("sparkles"), h("span", { text: `Layer style · ${l.name}` })),
      section("Drop shadow", fx.shadow, [
        slider("Opacity", fx.shadow.opacity * 100, 0, 100, 1, on(fx.shadow)((v) => { fx.shadow.opacity = v / 100; }), (v) => `${Math.round(v)}%`),
        slider("Distance", fx.shadow.dist, 0, 200, 1, on(fx.shadow)((v) => { fx.shadow.dist = v; }), (v) => `${v} px`),
        slider("Blur", fx.shadow.blur, 0, 120, 1, on(fx.shadow)((v) => { fx.shadow.blur = v; }), (v) => `${v} px`),
        slider("Angle", fx.shadow.angle, 0, 360, 1, on(fx.shadow)((v) => { fx.shadow.angle = v; }), (v) => `${v}°`)]),
      section("Stroke", fx.stroke, [
        slider("Size", fx.stroke.size, 1, 60, 1, on(fx.stroke)((v) => { fx.stroke.size = v; }), (v) => `${v} px`),
        slider("Opacity", fx.stroke.opacity * 100, 0, 100, 1, on(fx.stroke)((v) => { fx.stroke.opacity = v / 100; }), (v) => `${Math.round(v)}%`)]),
      section("Outer glow", fx.glow, [
        slider("Size", fx.glow.size, 1, 150, 1, on(fx.glow)((v) => { fx.glow.size = v; }), (v) => `${v} px`),
        slider("Opacity", fx.glow.opacity * 100, 0, 100, 1, on(fx.glow)((v) => { fx.glow.opacity = v / 100; }), (v) => `${Math.round(v)}%`)]),
      h("div", { class: "pt-fx-foot" },
        h("button", { class: "btn btn-sm", onclick: () => { fx.shadow.on = fx.stroke.on = fx.glow.on = false; apply(); box.__close(); } }, "Clear styles"),
        h("button", { class: "btn btn-sm btn-primary", onclick: () => box.__close() }, "Done")));
    const row = layersPanel.querySelector(`.pt-lay[data-id="${l.id}"]`) || layersPanel;
    popover(box, row, { onClose: () => {
      const now = D.layerOf(doc, l.id);
      if (now && !hasFx(now)) delete now.fx;
      if (JSON.stringify(before.layers.find((x) => x.id === l.id)?.fx || null) !== JSON.stringify((now && now.fx) || null)) pushMeta("Layer style", before);
      renderLayers();
      root.focus({ preventScroll: true });
    } });
  }

  function layerMenu(l, e) {
    const pix = D.hasPixels(l) && l.kind !== "text";
    menu(e.clientX, e.clientY, [
      { label: "Rename", icon: "edit", run: () => { renderLayers(); const row = layersPanel.querySelector(`.pt-lay[data-id="${l.id}"] .pt-lay-name`); if (row) renameLayer(l, row); } },
      { label: "Duplicate", icon: "copy", keys: "Ctrl+J", run: () => duplicateLayer(l.id) },
      l.kind !== "group" ? { label: "Put in a new group", icon: "folder", keys: "Ctrl+G", run: () => { selectedId = l.id; addGroup({ wrap: true }); } } : null,
      D.mergeTarget(doc, l.id) ? { label: "Merge down", icon: "layers", keys: "Ctrl+E", run: () => mergeDown(l.id) } : null,
      l.kind === "text" ? { label: "Rasterise the text", icon: "brush", run: () => rasterise(l.id) } : null,
      l.kind === "group" ? { label: "Merge the group into one layer", icon: "layers", run: () => rasterise(l.id) } : null,
      "sep",
      { label: l.mask ? "Paint on the mask" : engine.selection ? "Mask to the selection" : "Add a mask", icon: "circleShape", run: () => addMask(l.id) },
      l.mask ? { label: l.maskOn === false ? "Mask on" : "Mask off", icon: "eye", checked: l.maskOn !== false, run: () => setLayerProp(l.id, "maskOn", l.maskOn === false, "Mask on/off") } : null,
      l.mask ? { label: "Mask…", icon: "more", run: () => maskMenu(l, e) } : null,
      l.kind !== "adjust" ? { label: "Layer style…", icon: "sparkles", keys: "fx", run: () => styleDialog(l) } : null,
      { label: l.clip ? "Release the clip" : "Clip to the layer below", icon: "arrowDown", checked: l.clip, run: () => setLayerProp(l.id, "clip", !l.clip, "Clip to layer below") },
      pix ? { label: l.alphaLock ? "Unlock alpha" : "Lock alpha", icon: "lock", run: () => setLayerProp(l.id, "alphaLock", !l.alphaLock, "Alpha lock") } : null,
      { label: l.locked ? "Unlock" : "Lock", icon: "lock", run: () => setLayerProp(l.id, "locked", !l.locked, "Lock layer") },
      pix ? { label: "Select its pixels", icon: "target", keys: "Ctrl+click", run: () => { engine.selectSurface(l.id); afterSelect(); } } : null,
      pix ? { label: "Flip left to right", icon: "flipH", run: () => flipLayer(l.id, "h") } : null,
      pix ? { label: "Flip top to bottom", icon: "flipV", run: () => flipLayer(l.id, "v") } : null,
      pix ? { label: "Clear", icon: "x", run: () => landed("Clear layer", engine.clearArea(l.id)) } : null,
      "sep",
      { label: "Flatten the whole picture", icon: "layers", run: flattenPicture },
      { label: "Delete", icon: "trash", danger: true, run: () => deleteLayer(l.id) },
    ]);
  }

  /* ── brushes ────────────────────────────────────────────────────────── */

  // The brush and the eraser remember their own settings, the way they do in
  // every drawing app: picking up the eraser must not resize your inker, and
  // going back to the brush must not hand you the eraser at 70 px.
  const brushByTool = { brush: brushId, eraser: "eraser", smudge: "airbrush-hard" };
  const toolBrushKey = (t) => (t === "eraser" ? "eraser" : t === "smudge" ? "smudge" : "brush");

  function setBrush(id) {
    noteBrush(id);
    brushId = id;
    brush = brushFor(id);
    brushByTool[toolBrushKey(tool)] = id;
    if (toolBrushKey(tool) === "brush") app.setSetting(S.SETTING_KEYS.lastBrush, id);
    renderBrushPanel();
    renderTools();
    renderOpts();
  }

  function setParam(key, value) {
    const over = brushOverrides.get(brushId) || {};
    over[key] = value;
    brushOverrides.set(brushId, over);
    brush = brushFor(brushId);
    renderBrushPanel();
    scheduleOpts();
    scheduleStatus();
  }

  function renderBrushPanel() {
    if (brushPanel.hidden) return;
    const all = [...B.PRESETS, ...S.customBrushes(app).map((b) => ({ ...B.resolve(b.from || B.DEFAULT_PRESET, b), id: b.id, name: b.name, family: "custom" }))];
    const fams = B.FAMILIES.filter((f) => all.some((b) => b.family === f.id));
    const FAM_ICON = { sketch: "pen", ink: "feather", paint: "brush", air: "cloud", texture: "grid", eraser: "drop", custom: "star" };
    const kept = brushPanel.querySelector(".pt-brush-scroll")?.scrollTop || 0;
    fill(brushPanel,
      h("div", { class: "pt-panel-head" },
        h("span", { class: "pt-panel-title" }, svg(I.brush), "Brushes"),
        h("button", { class: "pt-icon", title: "Close", onclick: () => { brushPanel.hidden = true; renderTools(); } }, icon("x"))),
      h("div", { class: "pt-brush-scroll" }, foldSections([...fams.map((f) => ({ title: f.name, icon: FAM_ICON[f.id], open: f.id === "sketch", body: [
        h("div", { class: "pt-fam-items" }, ...all.filter((b) => b.family === f.id).map((b) =>
          h("button", {
            class: "pt-brush-item" + (b.id === brushId ? " is-on" : ""),
            title: b.name,
            onclick: () => setBrush(b.id),
            oncontextmenu: (e) => { if (String(b.id).startsWith("custom:")) { e.preventDefault(); S.removeCustomBrush(app, b.id); renderBrushPanel(); } },
          }, strokePreview(b), h("span", { class: "pt-brush-name", text: b.name }))))] })),
      { title: "Brush settings", icon: "sliders", open: true, body: [h("div", { class: "pt-params" },
        slider("Size", brush.size, 1, BRUSH_MAX, 1, (v) => setParam("size", v), (v) => `${Math.round(v)} px`),
        slider("Opacity", brush.opacity * 100, 1, 100, 1, (v) => setParam("opacity", v / 100), (v) => `${Math.round(v)}%`),
        slider("Flow", brush.flow * 100, 1, 100, 1, (v) => setParam("flow", v / 100), (v) => `${Math.round(v)}%`),
        slider("Hardness", brush.hardness * 100, 0, 100, 1, (v) => setParam("hardness", v / 100), (v) => `${Math.round(v)}%`),
        slider("Spacing", brush.spacing * 100, 1, 100, 1, (v) => setParam("spacing", v / 100), (v) => `${Math.round(v)}%`),
        slider("Stabiliser", brush.smoothing * 100, 0, 100, 1, (v) => setParam("smoothing", v / 100), (v) => `${Math.round(v)}%`),
        slider("Jitter", brush.jitter * 100, 0, 100, 1, (v) => setParam("jitter", v / 100), (v) => `${Math.round(v)}%`),
        slider("Scatter", brush.scatter * 100, 0, 100, 1, (v) => setParam("scatter", v / 100), (v) => `${Math.round(v)}%`),
        slider("Pressure → size", brush.pressureSize * 100, 0, 100, 1, (v) => setParam("pressureSize", v / 100), (v) => `${Math.round(v)}%`),
        slider("Pressure → flow", brush.pressureFlow * 100, 0, 100, 1, (v) => setParam("pressureFlow", v / 100), (v) => `${Math.round(v)}%`),
        h("label", { class: "pt-field" }, h("span", { text: "Tip" }),
          h("select", { class: "pt-select", onchange: (e) => setParam("tip", e.target.value) },
            ...["round", "soft", "square", "chalk", "spray", "bristle"].map((t) => h("option", { value: t, text: t[0].toUpperCase() + t.slice(1), selected: t === brush.tip })))),
        h("div", { class: "pt-param-acts" },
          h("button", { class: "btn", onclick: () => { brushOverrides.delete(brushId); brush = brushFor(brushId); renderBrushPanel(); renderOpts(); } }, "Reset"),
          h("button", { class: "btn btn-primary", onclick: saveBrush }, "Save as mine")))] }], "leonote.studio.brush.sections")));
    brushPanel.querySelector(".pt-brush-scroll").scrollTop = kept;
  }

  function saveBrush() {
    const name = `${brush.name || B.PRESET_BY_ID.get(brushId)?.name || "Brush"} ${S.customBrushes(app).length + 1}`;
    const made = B.customPreset(brush, name);
    S.saveCustomBrush(app, made);
    toast(`Saved "${name}" to your brushes`, { ms: 2600 });
    renderBrushPanel();
  }

  /** A tiny stroke drawn with the brush's own tip, so the list looks like paint. */
  function strokePreview(b) {
    const c = h("canvas", { class: "pt-brush-prev", width: 96, height: 30 });
    const g = c.getContext("2d");
    const par = B.resolve(b.id, b);
    const mask = B.tipMask(par.tip, 24, par.hardness, 7);
    const tip = document.createElement("canvas");
    tip.width = tip.height = 24;
    const tg = tip.getContext("2d");
    const img = tg.createImageData(24, 24);
    // ink the preview in the theme's own text colour: a filter that inverts
    // the whole canvas turns a soft edge into a muddy one
    const ink = document.documentElement.dataset.theme === "light" ? 34 : 226;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) { img.data[p] = img.data[p + 1] = img.data[p + 2] = ink; img.data[p + 3] = mask[i]; }
    tg.putImageData(img, 0, 0);
    g.globalAlpha = par.flow;
    for (let x = 6; x < 90; x += Math.max(0.6, 12 * par.spacing)) {
      const t = (x - 6) / 84;
      const d = Math.max(2, Math.min(18, par.size / 3)) * (0.25 + Math.sin(t * Math.PI) * 0.85);
      g.drawImage(tip, x - d / 2, 15 - d / 2 + Math.sin(t * 5) * 3, d, d);
    }
    return c;
  }

  const slider = (label, value, min, max, step, onInput, fmt, onDone) => {
    const out = h("span", { class: "pt-num", text: fmt ? fmt(value) : String(value) });
    return h("label", { class: "pt-field" }, h("span", { text: label }),
      h("input", {
        class: "pt-range", type: "range", min, max, step, value,
        oninput: (e) => { const v = Number(e.target.value); out.textContent = fmt ? fmt(v) : String(v); onInput(v); },
        onchange: onDone ? (e) => onDone(Number(e.target.value)) : null,
      }), out);
  };

  /* ── colour ─────────────────────────────────────────────────────────── */

  let swatchEl = null;

  function setColour(hex, remember = true) {
    colour = hex;
    if (swatchEl) swatchEl.style.background = hex;
    if (remember && !onMask) S.rememberColour(app, hex);
    if (textEdit) setText({ colour: hex });
    scheduleStatus();
  }

  function swapColours() {
    const c = colour;
    setColour(colour2, false);
    colour2 = c;
    renderTools();
  }

  /** The colour popup the whole app shares (colourpop.js): shade square, hue, hex, palette, colours used lately. */
  let closeColours = null;
  function colourPopover(anchor) {
    if (closeColours) { closeColours(); return; }
    closeColours = colourPop(anchor, {
      value: colour,
      title: onMask ? "Mask: black hides, white shows" : "Colour",
      onPick: (c) => setColour(c, false),
      onClose: (c) => { closeColours = null; setColour(c); noteColour(c); root.focus({ preventScroll: true }); },
    });
  }

  /* ── toolbar, top bar, options bar ──────────────────────────────────── */

  function renderTools() {
    fill(toolbar, ...TOOLS.map((t) => (t === "sep" ? h("div", { class: "pt-tool-sep" }) :
      h("button", {
        class: "pt-tool" + (tool === t.id ? " is-on" : ""),
        title: `${t.name} (${t.key})`,
        dataset: { tool: t.id },
        onclick: () => setTool(t.id),
      }, svg(t.icon), h("i", { class: "pt-tool-key", text: t.key })))),
      h("div", { class: "pt-tool-sep" }),
      h("button", { class: "pt-tool" + (brushPanel.hidden ? "" : " is-on"), title: "Brush settings (F1)", onclick: () => { brushPanel.hidden = !brushPanel.hidden; renderBrushPanel(); renderTools(); } }, svg(I.sliders)),
      h("div", { class: "pt-swatch-pair" },
        h("button", { class: "pt-swatch-2", title: "Second colour · X swaps them · Alt+click with the picker sets it", style: `background:${colour2}`, onclick: () => swapColours() }),
        (swatchEl = h("button", { class: "pt-swatch-big", title: "Colour (K)", style: `background:${colour}`, onclick: (e) => colourPopover(e.currentTarget) }))));
  }

  function setTool(id) {
    if (engine.floating && id !== "transform") commitFloat();
    if (textEdit && id !== "text") commitText();
    if (crop && id !== "crop") { crop = null; canvas.style.cursor = ""; }
    if (placing) { placing = null; root.classList.remove("is-placing"); }
    if (id !== "transform") dropPiece();
    if (tool !== id) lastTool = tool;
    tool = id;
    // picking up the brush, the eraser or the smudge brings back the one that tool had
    if (PAINTS.has(id)) {
      const want = brushByTool[toolBrushKey(id)];
      if (want && want !== brushId) { brushId = want; brush = brushFor(want); renderBrushPanel(); }
    }
    if (id === "crop") beginCrop();
    renderTools();
    renderOpts();
    root.dataset.tool = id;
    cursor.hidden = !PAINTS.has(id);
    invalidate();
  }

  function setWorkspace(w) {
    const was = workspace;
    workspace = ["studio", "animate"].includes(w) ? w : "draw";
    doc.workspace = workspace;
    app.settings.drawPersona = { draw: "paint", studio: "photo", animate: "animate" }[workspace]; // the side button's card opens on it
    // remembered per file, the 400 most recent: a file opens again where it was left
    if (path) { const m = { ...(app.settings.paintWsOf || {}) }; delete m[path]; m[path] = workspace; const ks = Object.keys(m); for (const k of ks.slice(0, Math.max(0, ks.length - 400))) delete m[k]; app.setSetting("paintWsOf", m); }
    root.dataset.workspace = workspace;
    adjustPanel.hidden = workspace !== "studio";
    if (workspace === "studio") brushPanel.hidden = true;
    renderTop();
    renderTools();
    studio.render();
    if (anim) { if (workspace === "animate" && was !== "animate") anim.enter(); else if (was === "animate" && workspace !== "animate") anim.leave(); anim.render(); }
    invalidate();
  }

  const persona = (id) => (e) => { e.preventDefault(); import("./paintmode.js").then((m) => m.personaPanel(app, path, id, e)); };
  function renderTop() {
    const f = engine.floating;
    fill(topbar,
      h("div", { class: "pt-mode" },
        h("div", { class: "pt-persona" },
          h("button", { class: "pt-persona-btn", title: "Leopaint (.leopaint): shapes, arrows, text and pen lines on an endless board, for working ideas out. A file of its own, so this opens or makes one. Right-click for more", onclick: (e) => { const a = e.currentTarget; import("./paintmode.js").then((m) => m.switchMode(app, path, "sketch", a)); }, oncontextmenu: persona("vector") }, icon("brush"), h("span", { text: "Paint" })),
          h("span", { class: "pt-persona-sep", title: "Leostudio: Studio, Filter and Animate work together on this one file" }),
          h("button", { class: "pt-persona-btn" + (workspace === "draw" ? " is-on" : ""), title: "Studio: brushes on pixels. The same .leostudio as Filter and Animate. Right-click for more", onclick: () => setWorkspace("draw"), oncontextmenu: persona("paint") }, icon("studio"), h("span", { text: "Studio" })),
          h("button", { class: "pt-persona-btn" + (workspace === "studio" ? " is-on" : ""), title: "Filter: adjustments, masks and retouching. The same .leostudio as Studio and Animate. Right-click for more", onclick: () => setWorkspace("studio"), oncontextmenu: persona("photo") }, svg(I.adjust), h("span", { text: "Filter" })),
          h("button", { class: "pt-persona-btn" + (workspace === "animate" ? " is-on" : ""), title: "Animate: frame by frame, saved as a video for Instagram. The same .leostudio - switch to Studio or Filter to correct a frame. Right-click for more", onclick: () => setWorkspace("animate"), oncontextmenu: persona("animate") }, icon("animate"), h("span", { text: "Animate" }))),
        h("button", { class: "pt-link", title: "Paint, Studio, Filter and Animate: what each is for, and making a new one", onclick: (e) => { const a = e.currentTarget; import("./paintmode.js").then((m) => m.modeMenu(app, path, a)); } }, icon("chevronDown"))),
      h("div", { class: "pt-top-sep" }),
      h("button", { class: "pt-menu-btn", onclick: (e) => studio.imageMenu(e.currentTarget) }, "Image"),
      h("button", { class: "pt-menu-btn", onclick: (e) => studio.selectMenu(e.currentTarget) }, "Select"),
      h("button", { class: "pt-menu-btn", onclick: (e) => studio.filterMenu(e.currentTarget) }, "Filter"),
      h("div", { class: "pt-top-sep" }),
      h("button", { class: "pt-icon", title: `Undo${history.undoLabel ? " · " + history.undoLabel : ""} (Ctrl+Z)`, disabled: !history.canUndo, onclick: doUndo }, svg(I.undo)),
      h("button", { class: "pt-icon", title: `Redo${history.redoLabel ? " · " + history.redoLabel : ""} (Ctrl+Shift+Z)`, disabled: !history.canRedo, onclick: doRedo }, svg(I.redo)),
      h("div", { class: "pt-top-sep" }),
      h("button", { class: "pt-icon", title: "Fit to window (Shift+1)", onclick: () => fit() }, svg(I.fit)),
      h("button", { class: "pt-icon", title: "100% (Shift+0)", onclick: () => zoomTo(1, view.cx, view.cy) }, icon("actualSize")),
      h("button", { class: "pt-icon", title: "Turn the view 90° (Shift+R) · hold R and drag to turn it freely", onclick: () => { view.angle += Math.PI / 2; invalidate(); scheduleStatus(); } }, svg(I.rotate)),
      h("button", { class: "pt-icon" + (view.flip ? " is-on" : ""), title: "Mirror the view (F) — shows the drawing flipped without changing it, to catch what your eye has got used to", onclick: flipView }, svg(I.mirror)),
      h("div", { class: "pt-top-sep" }),
      onMask ? h("button", { class: "pt-chip is-mask", title: "Strokes go to the mask: black hides, white shows. Click to go back to the layer (Esc).", onclick: () => { setOnMask(false); renderLayers(); } }, svg(I.mask), "Editing mask") : null,
      onMask ? h("div", { class: "pt-seg pt-maskview", title: "What you look at while you paint the mask" },
        ...[["off", "Picture", "The picture as the mask leaves it"], ["overlay", "Overlay", "The picture, with a red film where the mask hides it (backslash)"], ["solo", "Mask", "The mask on its own: white shows, black hides (Alt+click its thumbnail)"]].map(([id, label, title]) =>
          h("button", { class: "pt-seg-btn" + (maskView === id ? " is-on" : ""), title, onclick: () => setMaskView(id) }, label))) : null,
      onMask && layer() ? h("button", { class: "pt-chip" + (layer().maskOn === false ? "" : " is-on"), title: layer().maskOn === false ? "The mask is switched off: the layer shows whole. Click to switch it on." : "The mask is on. Click to switch it off and see the layer whole (it stays for later).", onclick: () => { const l = layer(); setLayerProp(l.id, "maskOn", l.maskOn === false, "Mask on/off"); renderTop(); } }, icon("eye"), layer().maskOn === false ? "Mask off" : "Mask on") : null,
      f ? h("button", { class: "btn btn-primary pt-commit", onclick: commitFloat }, "Apply") : null,
      f ? h("button", { class: "btn", onclick: cancelFloat }, "Cancel") : null,
      h("button", { class: "pt-icon", title: "Keyboard shortcuts (?)", onclick: () => shortcutSheet() }, svg(I.keys)),
      h("button", { class: "pt-icon", title: "Your drawings and photos", onclick: () => studio.library() }, svg(I.library)),
      h("button", { class: "pt-icon", title: "Save now (Ctrl+S)", onclick: () => saveNow(true), disabled: readOnly }, svg(I.save)),
      h("button", { class: "pt-icon", title: "Export a picture (Ctrl+Shift+E)", onclick: () => studio.exportDialog() }, svg(I.download)));
  }

  // the bar is one row; in a narrow pane the wheel scrolls it sideways
  optsbar.addEventListener("wheel", (e) => { if (optsbar.scrollWidth > optsbar.clientWidth) { e.preventDefault(); optsbar.scrollLeft += e.deltaY || e.deltaX; } }, { passive: false });

  let optsRaf = 0;
  const scheduleOpts = () => { if (!optsRaf) optsRaf = requestAnimationFrame(() => { optsRaf = 0; renderOpts(); }); };

  const seg = (options, current, onPick) => h("div", { class: "pt-seg" }, ...options.map(([id, label, title]) =>
    h("button", { class: "pt-seg-btn" + (id === current ? " is-on" : ""), title: title || label, onclick: () => onPick(id) }, label)));

  const miniSlider = (label, value, min, max, step, onInput, fmt) => {
    const out = h("span", { class: "pt-opt-num", text: fmt(value) });
    return h("label", { class: "pt-opt" }, h("span", { class: "pt-opt-label", text: label }),
      h("input", { class: "pt-range", type: "range", min, max, step, value, oninput: (e) => { const v = Number(e.target.value); out.textContent = fmt(v); onInput(v); } }), out);
  };

  const check = (label, on, onPick, title) => h("button", { class: "pt-toggle" + (on ? " is-on" : ""), title: title || label, onclick: () => onPick(!on) }, label);

  function assistButtons() {
    const symName = (G.SYMMETRY_MODES.find((m) => m.id === symmetry.mode) || {}).name;
    const guideName = (G.GUIDE_KINDS.find((m) => m.id === guide.kind) || {}).name;
    return [
      h("div", { class: "pt-opt-sep" }),
      h("button", { class: "pt-opt-btn" + (symmetry.mode !== "none" ? " is-on" : ""), title: "Symmetry: every stroke is mirrored as you draw it", onclick: (e) => symmetryMenu(e.currentTarget) }, svg(I.symmetry), symmetry.mode === "none" ? "Symmetry" : symName),
      h("button", { class: "pt-opt-btn" + (guide.kind !== "none" ? " is-on" : ""), title: "Drawing guides: hold strokes to straight lines, a vanishing point, circles…", onclick: (e) => guideMenu(e.currentTarget) }, svg(I.guide), guide.kind === "none" ? "Guide" : guideName),
    ];
  }

  function symmetryMenu(anchor) {
    const set = (patch) => { Object.assign(symmetry, patch); syncAssist(); changed(); invalidate(); renderOpts(); };
    menu(0, 0, [
      ...G.SYMMETRY_MODES.map((m) => ({ label: m.name, checked: symmetry.mode === m.id, run: () => set({ mode: m.id }) })),
      "sep",
      ...[3, 4, 5, 6, 8, 10, 12, 16].map((n) => ({ label: `${n} segments`, checked: symmetry.count === n && (symmetry.mode === "radial" || symmetry.mode === "mandala"), run: () => set({ count: n, mode: symmetry.mode === "mandala" ? "mandala" : "radial" }) })),
      "sep",
      { label: "Centre it on the canvas", icon: "target", run: () => set({ cx: doc.width / 2, cy: doc.height / 2 }) },
      { label: "Click to place the centre…", icon: "target", run: () => askPoint("symmetry", "Click where the centre of the symmetry should be") },
    ], { anchor });
  }

  function guideMenu(anchor) {
    const set = (patch) => { Object.assign(guide, patch); syncAssist(); changed(); invalidate(); renderOpts(); };
    menu(0, 0, [
      ...G.GUIDE_KINDS.map((m) => ({ label: m.name, checked: guide.kind === m.id, run: () => set({ kind: m.id }) })),
      "sep",
      guide.kind === "parallel" ? { label: "Click to set the direction…", icon: "arrowLine", run: () => askPoint("angle", "Click to aim the parallel lines from the middle of the canvas") } : null,
      guide.kind === "vanish" || guide.kind === "vanish2" || guide.kind === "circle" ? { label: guide.kind === "circle" ? "Click to place the centre…" : "Click to place the vanishing point…", icon: "target", run: () => askPoint("vanish", "Click where the point should be") } : null,
      guide.kind === "vanish2" ? { label: "Click to place the second point…", icon: "target", run: () => askPoint("vanish2", "Click where the second vanishing point should be") } : null,
      { header: "Hold Shift while drawing for a straight line at any time", plain: true },
    ], { anchor });
  }

  function renderOpts() {
    const t = tool;
    const kids = [];
    if (PAINTS.has(t)) {
      kids.push(
        h("button", { class: "pt-opt-btn", title: "Choose a brush (F1)", onclick: () => { brushPanel.hidden = !brushPanel.hidden; renderBrushPanel(); renderTools(); } }, svg(I.brush), B.PRESET_BY_ID.get(brushId)?.name || brush.name || "Brush"),
        miniSlider("Size", brush.size, 1, BRUSH_MAX, 1, (v) => setParam("size", v), (v) => `${Math.round(v)}`),
        miniSlider(t === "smudge" ? "Strength" : "Opacity", brush.opacity * 100, 1, 100, 1, (v) => setParam("opacity", v / 100), (v) => `${Math.round(v)}%`),
        ...assistButtons());
    } else if (t === "fill") {
      kids.push(
        miniSlider("Tolerance", fillTolerance * 100, 0, 100, 1, (v) => { fillTolerance = v / 100; }, (v) => `${Math.round(v)}%`),
        check("All layers", fillSampleAll, (v) => { fillSampleAll = v; renderOpts(); }, "Stop at lines on any layer, not just this one"));
    } else if (t === "gradient") {
      kids.push(
        seg([["linear", "Linear"], ["radial", "Radial"]], gradKind, (v) => { gradKind = v; renderOpts(); }),
        seg([["transparent", "To clear", "From the colour to nothing"], ["secondary", "To second colour", "From the colour to the second colour"]], gradTo, (v) => { gradTo = v; renderOpts(); }),
        miniSlider("Opacity", gradOpacity * 100, 1, 100, 1, (v) => { gradOpacity = v / 100; }, (v) => `${Math.round(v)}%`),
        h("span", { class: "pt-opt-hint", text: "Drag across the picture · Shift snaps the angle" }));
    } else if (t === "shape") {
      kids.push(
        seg([["line", "Line"], ["rect", "Rectangle"], ["ellipse", "Ellipse"], ["triangle", "Triangle"]], shapeKind, (v) => { shapeKind = v; renderOpts(); }),
        seg([["o", "Outline", "Drawn with the brush you have picked"], ["f", "Filled"]], shapeFilled ? "f" : "o", (v) => { shapeFilled = v === "f"; renderOpts(); }),
        miniSlider("Size", brush.size, 1, BRUSH_MAX, 1, (v) => setParam("size", v), (v) => `${Math.round(v)}`),
        h("span", { class: "pt-opt-hint", text: "Shift keeps it regular · Alt draws from the centre" }),
        ...assistButtons());
    } else if (SELECTS.has(t)) {
      kids.push(h("div", { class: "pt-seg" }, ...SEL_MODES.map(([id, title], i) =>
        h("button", { class: "pt-seg-btn is-icon" + (selMode === id ? " is-on" : ""), title, onclick: () => { selMode = id; renderOpts(); } }, svg(SEL_ICONS[i])))));
      if (t === "marquee") kids.push(seg([["rect", "Rectangle"], ["ellipse", "Ellipse"]], marqueeShape, (v) => { marqueeShape = v; renderOpts(); }), h("span", { class: "pt-opt-hint", text: "Ctrl keeps it square" }));
      if (t === "wand") {
        kids.push(
          miniSlider("Tolerance", wandTolerance * 100, 0, 100, 1, (v) => { wandTolerance = v / 100; }, (v) => `${Math.round(v)}%`),
          check("Contiguous", wandContiguous, (v) => { wandContiguous = v; renderOpts(); }, "Only what touches the place you click. Off: that colour everywhere in the picture."),
          check("All layers", wandSampleAll, (v) => { wandSampleAll = v; renderOpts(); }, "Look at the whole picture rather than just this layer"));
      }
      if (engine.selection) {
        kids.push(h("div", { class: "pt-opt-sep" }),
          h("button", { class: "pt-opt-btn", onclick: () => studio.featherDialog() }, "Feather…"),
          h("button", { class: "pt-opt-btn", title: "Hide everything on this layer outside the selection, without deleting it", onclick: () => addMask(selectedId, "selection") }, svg(I.mask), "Mask"),
          h("button", { class: "pt-opt-btn", onclick: deselect }, "Deselect"));
      }
    } else if (t === "transform") {
      kids.push(
        h("span", { class: "pt-opt-label", text: "A click picks" }),
        seg([["piece", "The piece", "Whatever is joined to where you click: one stroke, one doodle, one pasted picture"], ["layer", "Its layer", "The whole layer that has paint there"], ["off", "Nothing", "Always move the layer chosen in the panel"]], pickMode, (v) => { pickMode = v; app.setSetting("paintPick", v); renderOpts(); }),
        engine.selection && !engine.floating ? h("button", { class: "pt-opt-btn is-danger", title: "Delete what is picked (Del)", onclick: () => deletePicked() }, icon("trash"), "Delete") : null,
        engine.selection && !engine.floating ? h("button", { class: "pt-opt-btn", title: "Lift it onto a layer of its own (Ctrl+J)", onclick: () => layerViaCopy() }, icon("layers"), "To its own layer") : null,
        !engine.floating ? h("button", { class: "pt-opt-btn", title: "Show the handles: scale, turn (Ctrl+T)", onclick: () => freeTransform() }, "Transform") : null,
        check("Handles", app.settings.paintSelHandles !== false, (on) => { app.setSetting("paintSelHandles", on); renderOpts(); invalidate(); }, "Scale and turn handles round what is picked, ready to take - as Photoshop's transform controls"),
        h("span", { class: "pt-opt-hint", text: engine.floating ? "Drag to move · corners scale (Shift keeps the shape) · the knob turns · Enter applies, Esc cancels" : "Click something, drag it, Delete it · arrows nudge · Shift+click adds" }));
    } else if (t === "crop" && crop) {
      const r = G.normRect(crop.rect);
      kids.push(
        h("button", { class: "btn btn-primary pt-commit", title: "Enter", onclick: applyCrop }, "Crop"),
        h("button", { class: "btn pt-commit", title: "Esc", onclick: cancelCrop }, "Cancel"),
        h("div", { class: "pt-opt-sep" }),
        h("select", { class: "pt-select", title: "Shape", onchange: (e) => { cropRatio = e.target.value; if (ratioValue()) { const c = crop.rect; const f = G.fitRatio(c.w, c.h, ratioValue()); crop.rect = { x: c.x + f.x, y: c.y + f.y, w: f.w, h: f.h }; } invalidate(); renderOpts(); } },
          ...G.CROP_RATIOS.map((x) => h("option", { value: x.id, text: x.name, selected: x.id === cropRatio }))),
        h("span", { class: "pt-opt-num is-wide", text: `${r.w} × ${r.h} px` }),
        h("button", { class: "pt-opt-btn", title: "Swap width and height", onclick: () => { const c = crop.rect; const cx = c.x + c.w / 2; const cy = c.y + c.h / 2; crop.rect = { x: cx - c.h / 2, y: cy - c.w / 2, w: c.h, h: c.w }; invalidate(); renderOpts(); } }, svg(I.swap)),
        h("button", { class: "pt-opt-btn", title: "Crop to what is actually drawn", onclick: () => { const b = engine.contentBox(); if (b) { crop.rect = b; invalidate(); renderOpts(); } } }, "Trim"),
        h("span", { class: "pt-opt-hint", text: "Drag past the edge to make the canvas bigger" }));
    } else if (t === "text") {
      const o = textOpts;
      kids.push(
        textEdit ? h("button", { class: "btn btn-primary pt-commit", title: "Ctrl+Enter · Esc throws it away", onclick: commitText }, "Done") : null,
        h("select", { class: "pt-select is-font", title: "Font", onchange: (e) => textOption({ font: e.target.value }) },
          ...D.TEXT_FONTS.map((f) => h("option", { value: f, text: f, selected: f === o.font, style: `font-family:"${f}"` }))),
        h("input", { class: "pt-input pt-opt-in", type: "number", min: 4, max: 2000, value: Math.round(o.size), title: "Size in pixels", onchange: (e) => textOption({ size: clamp(Number(e.target.value) || 96, 4, 2000) }), onkeydown: (e) => e.stopPropagation() }),
        h("div", { class: "pt-seg" },
          h("button", { class: "pt-seg-btn is-icon" + (o.bold ? " is-on" : ""), title: "Bold", onclick: () => textOption({ bold: !o.bold }) }, icon("bold")),
          h("button", { class: "pt-seg-btn is-icon" + (o.italic ? " is-on" : ""), title: "Italic", onclick: () => textOption({ italic: !o.italic }) }, icon("italic"))),
        seg([["left", "Left"], ["center", "Centre"], ["right", "Right"]], o.align, (v) => textOption({ align: v })),
        miniSlider("Line", o.lineHeight * 100, 70, 250, 5, (v) => textOption({ lineHeight: v / 100 }), (v) => (v / 100).toFixed(2)),
        miniSlider("Spacing", o.tracking, -20, 120, 1, (v) => textOption({ tracking: v }), (v) => `${Math.round(v)}`),
        textEdit ? null : h("span", { class: "pt-opt-hint", text: "Click to write · click text to edit it" }));
    }
    const shown = kids.filter(Boolean);
    optsbar.hidden = !shown.length;
    // a slider being dragged must not be replaced under the pointer
    if (optsbar.contains(document.activeElement) && document.activeElement.type === "range" && optsbar.dataset.tool === t) return;
    optsbar.dataset.tool = t;
    fill(optsbar, ...shown);
  }

  const SEL_ICONS = [
    '<rect x="5" y="5" width="14" height="14" rx="1.500" stroke-dasharray="3 2.500"/>',
    '<rect x="4" y="4" width="10" height="10" rx="1.500"/><rect x="10" y="10" width="10" height="10" rx="1.500"/>',
    '<rect x="4" y="4" width="11" height="11" rx="1.500"/><path d="M13 13h7v7h-7z" stroke-dasharray="2.500 2"/>',
    '<rect x="4" y="4" width="11" height="11" rx="1.500" opacity=".45"/><rect x="9" y="9" width="11" height="11" rx="1.500" opacity=".45"/><rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none"/>',
  ];

  /* ── undo / redo ────────────────────────────────────────────────────── */

  function doUndo() {
    if (textEdit) { cancelText(); return; }
    if (engine.floating) { cancelFloat(); return; }
    const s = history.undo();
    if (!s) return;
    changed();
    invalidate();
    renderTop();
    renderLayers();
  }

  function doRedo() {
    const s = history.redo();
    if (!s) return;
    changed();
    invalidate();
    renderTop();
    renderLayers();
  }

  /* ── status ─────────────────────────────────────────────────────────── */

  function scheduleStatus() {
    if (statusRaf || destroyed) return;
    statusRaf = requestAnimationFrame(() => { statusRaf = 0; renderStatus(); renderTop(); });
  }

  function renderStatus() {
    const mem = engine.memory();
    const hs = history.stats();
    const avg = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
    const mm = D.printSize(doc.width, doc.height, doc.dpi);
    const deg = Math.round((((view.angle * 180) / Math.PI) % 360 + 360) % 360);
    fill(statusbar,
      h("span", { class: "pt-stat", text: `${doc.width} × ${doc.height}`, title: `${mm.w} × ${mm.h} mm at ${doc.dpi} dpi` }),
      h("span", { class: "pt-stat", text: `${doc.dpi} dpi` }),
      h("span", { class: "pt-stat pt-zoom", text: `${Math.round(view.zoom * 100)}%`, title: "Click to fit", onclick: () => fit() }),
      deg ? h("span", { class: "pt-stat pt-zoom", text: `${deg}°`, title: "The view is turned. Click to straighten it.", onclick: () => { view.angle = 0; invalidate(); scheduleStatus(); } }) : null,
      view.flip ? h("span", { class: "pt-stat pt-sel", text: "mirrored", title: "The view is mirrored (F). The picture itself is not." }) : null,
      engine.selection ? h("span", { class: "pt-stat pt-sel", text: `selection ${Math.round(engine.selection.box.w)} × ${Math.round(engine.selection.box.h)}`, title: "Escape to deselect" }) : null,
      h("span", { class: "pt-spacer" }),
      h("span", { class: "pt-stat", title: `${brush.size | 0} px · flow ${Math.round(brush.flow * 100)}%`, text: `${B.PRESET_BY_ID.get(brushId)?.name || "Brush"} ${Math.round(brush.size)}px` }),
      h("span", { class: "pt-stat", title: `Undo holds ${hs.steps} step${hs.steps === 1 ? "" : "s"}, ${fmtBytes(hs.bytes)} of a ${fmtBytes(hs.budget)} budget${hs.dropped ? `; ${hs.dropped} older step${hs.dropped === 1 ? "" : "s"} dropped` : ""}`, text: `undo ${hs.steps} · ${fmtBytes(hs.bytes)}` }),
      h("span", { class: "pt-stat", title: `Layers and masks ${fmtBytes(mem.layers)} · working buffers ${fmtBytes(mem.scratch + mem.merge + mem.tips)}`, text: fmtBytes(mem.total) }),
      avg ? h("span", { class: "pt-stat pt-fps", title: "Average time to paint a frame", text: `${avg.toFixed(1)} ms` }) : null);
  }

  /* ── keyboard ───────────────────────────────────────────────────────── */

  let sizeKeyAt = 0;
  let sizeHeld = 0;
  let spring = null; // a tool key being held: { key, prev, at, used }
  let digit = null; // the first of two quick digits

  /** Delete: what is picked goes; with nothing picked, the layer is wiped. */
  function deletePicked() {
    if (engine.floating) { // what is being moved is thrown away instead of put down
      if (engine.floating.placed) { cancelFloat(); return; }
      pushPixels("Delete", engine.dropFloat());
      changed(); thumbSoon(); deselect(); renderTop(); renderOpts();
      return;
    }
    const l = layer();
    if (!l || l.locked || readOnly || !engine.surface(targetKey())) return;
    landed(engine.selection ? "Delete" : "Clear", engine.clearArea(targetKey()));
    if (engine.selection && tool === "transform") deselect();
    renderOpts();
  }

  /** Alt+Backspace fills with the colour, Ctrl+Backspace with the second one. */
  function fillPicked(c) {
    const l = layer();
    if (!paintable(l)) return;
    landed("Fill", engine.fillArea(targetKey(), c));
  }

  /** Ctrl+I: the layer's colours turned inside out, inside the selection if there is one. */
  function invertPixels() {
    const l = layer();
    if (l && !D.hasPixels(l)) return studio.quickAdjust("invert");
    if (!paintable(l)) return;
    if (l.kind === "text") return;
    landed("Invert", engine.filterSurface(targetKey(), (c, src) => { c.filter = "invert(1)"; c.drawImage(src, 0, 0); }));
  }

  /** Ctrl+J with a selection: what is selected, copied onto a new layer above. */
  /* Copy and paste inside Studio: what is selected (or the piece moved, or the whole layer), kept here
     with where it was, and pasted back in the same place - onto another frame, another layer - ready
     to move. It also goes onto Windows' clipboard as a picture; a picture copied elsewhere afterwards
     (the window left meanwhile) is what Ctrl+V then pastes instead. */
  let clip = null; // { canvas, cx, cy, at }
  let leftAt = 0;
  const onLeave = () => { leftAt = Date.now(); };
  window.addEventListener("blur", onLeave);
  function copyPieces({ cut = false } = {}) {
    const f = engine.floating;
    let c, cx, cy;
    if (f) {
      c = document.createElement("canvas"); c.width = f.w; c.height = f.h;
      c.getContext("2d").drawImage(f.canvas, 0, 0);
      cx = f.cx; cy = f.cy;
    } else {
      const l = layer();
      // in Animate what is copied is what the frame shows, all its layers together (a cut still takes it off the layer chosen)
      const frameSrc = workspace === "animate" && anim && anim.hasFrames && !cut ? anim.frameImage() : null;
      const bm = frameSrc ? { canvas: frameSrc } : l && engine.layers.get(l.id);
      if (!bm) return;
      const sel = engine.selection;
      const box = sel ? sel.box : { x: 0, y: 0, w: doc.width, h: doc.height };
      if (!box.w || !box.h) return;
      c = document.createElement("canvas"); c.width = box.w; c.height = box.h;
      const g = c.getContext("2d");
      g.drawImage(bm.canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      if (sel) { g.globalCompositeOperation = "destination-in"; g.drawImage(sel.mask, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h); }
      cx = box.x + box.w / 2; cy = box.y + box.h / 2;
      if (cut && !readOnly && l.kind === "raster") {
        const rect = { x: box.x, y: box.y, w: box.w, h: box.h };
        const before = bm.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
        bm.ctx.save();
        if (sel) { bm.ctx.globalCompositeOperation = "destination-out"; bm.ctx.drawImage(sel.mask, 0, 0); } else bm.ctx.clearRect(0, 0, doc.width, doc.height);
        bm.ctx.restore();
        engine.allDirty = true;
        pushPixels("Cut", { key: l.id, rect, before });
        changed(); invalidate();
      }
    }
    clip = { canvas: c, cx, cy, at: Date.now() };
    try { c.toBlob((b) => { if (b && navigator.clipboard && window.ClipboardItem) navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).catch(() => {}); }, "image/png"); } catch {}
    toast(cut ? "Cut - Ctrl+V puts it back where it was, on any frame or layer" : "Copied - Ctrl+V pastes it in the same place, on any frame or layer", { ms: 2200 });
  }
  /** Ctrl+V with something copied here (and nothing copied elsewhere since): in the same place, ready to move. */
  function pasteClip() {
    if (!clip || leftAt > clip.at || readOnly) return false;
    const l = layer();
    if (!l || !D.hasPixels(l) || l.kind !== "raster") return false;
    if (engine.floating) commitFloat();
    const f = engine.floatImage(l.id, clip.canvas, { x: clip.cx, y: clip.cy });
    if (!f) return false;
    f.placed = true;
    if (tool !== "transform") setTool("transform");
    invalidate(); renderTop && renderTop();
    toast("Pasted where it was - drag it, Enter puts it down", { ms: 2200 });
    return true;
  }

  /* Quick actions (/): type a few letters of what you want - "levels", "flip", "new layer", "subject",
     "brush" - and Enter does it. Every tool, the layer actions and every row of Image, Select and Filter. */
  function quickActions() {
    document.querySelector(".pt-quick")?.remove();
    const acts = [
      ...TOOLS.filter((t) => t && t.name && t.id).map((t) => ({ label: `Tool › ${t.name.split(":")[0]}`, keys: t.key, run: () => setTool(t.id) })),
      { label: "Layer › New layer", run: () => addLayer() },
      { label: "Layer › Duplicate layer", keys: "Ctrl+J", run: () => duplicateLayer(selectedId) },
      { label: "Layer › Merge down", keys: "Ctrl+E", run: () => mergeDown(selectedId) },
      { label: "Layer › Group", keys: "Ctrl+G", run: () => addGroup({ wrap: true }) },
      { label: "Workspace › Studio", run: () => setWorkspace("draw") }, { label: "Workspace › Filter", run: () => setWorkspace("studio") }, { label: "Workspace › Animate", run: () => setWorkspace("animate") },
      ...(workspace === "animate" && anim && anim.hasFrames ? [{ label: "Frame › Duplicate", keys: "Ctrl+D", run: () => anim.duplicate({ only: engine.selection }) }, { label: "Frame › New blank frame", keys: "N", run: () => anim.blank() }] : []),
      ...studio.allActions(),
    ];
    const box = h("div", { class: "pt-quick" });
    const input = h("input", { class: "pt-quick-in", placeholder: "What to do - levels, flip, subject, new layer, brush…", spellcheck: false });
    const list = h("div", { class: "pt-quick-list" });
    let sel = 0, shown = [];
    const close = () => { box.remove(); root.focus({ preventScroll: true }); };
    const paint = () => {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = acts.filter((a) => words.every((w) => a.label.toLowerCase().includes(w))).slice(0, 12);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((a, i) => h("button", { class: "pt-quick-row" + (i === sel ? " is-on" : ""), onmousedown: (e) => e.preventDefault(), onclick: () => { close(); a.run(); } }, h("span", { text: a.label }), a.keys ? h("kbd", { text: a.keys }) : null)));
    };
    input.addEventListener("input", () => { sel = 0; paint(); });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); paint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
      else if (e.key === "Enter") { e.preventDefault(); const a = shown[sel]; close(); if (a) a.run(); }
    });
    input.addEventListener("blur", () => setTimeout(() => { if (box.isConnected && !box.contains(document.activeElement)) close(); }, 120));
    box.append(input, list);
    root.append(box);
    paint();
    input.focus();
  }

  function layerViaCopy() {
    const l = layer();
    const sel = engine.selection;
    if (!l || !sel || readOnly || l.kind !== "raster") return duplicateLayer(selectedId);
    if (!roomFor()) return;
    const src = engine.layers.get(l.id);
    structural("Layer from selection", () => {
      const nl = D.newLayer({ name: `${l.name} piece` });
      if (l.parent) nl.parent = l.parent;
      insertAbove(nl);
      engine.addLayerBitmap(nl.id, src.canvas);
      const bm = engine.layers.get(nl.id);
      bm.ctx.globalCompositeOperation = "destination-in";
      bm.ctx.drawImage(sel.mask, 0, 0);
      bm.ctx.globalCompositeOperation = "source-over";
      selectedId = nl.id;
      doc.selected = nl.id;
    });
    deselect();
    engine.allDirty = true;
    renderLayers(); thumbSoon(); invalidate();
  }

  const SHORTCUTS = [
    ["Tools", [["V", "Select and move"], ["B  E  S", "Brush, eraser, smudge"], ["G", "Fill, then gradient"], ["U", "Line and shapes"], ["I", "Pick a colour, then measure"], ["M  L  W", "Marquee, lasso, wand"], ["C  T  H", "Crop, text, pan"], ["Hold a tool key", "Borrow that tool; let go to get yours back"]]],
    ["Brush", [["[  ]", "Smaller, bigger (hold to glide)"], ["{  }", "Softer, harder"], ["Ctrl+Alt+drag", "Across: size · up and down: hardness"], ["Alt+right-drag", "The same, Photoshop's way"], ["Right-click", "Size, opacity, hardness, flow, brushes, colours"], ["1 … 0", "Opacity 10% … 100% (4 then 5 is 45%)"], [",  .", "Previous, next brush"], ["F1", "All brushes and settings"], ["Shift+drag", "A straight line"], ["Shift+click", "A straight line from the last stroke"], ["Stop at the end of a stroke", "Straighten it, or round it"]]],
    ["Colour", [["Alt", "Pick a colour while painting"], ["X", "Swap the two colours"], ["D", "Black and white"], ["K", "The colour picker"], ["Alt+Backspace", "Fill with the colour"], ["Ctrl+Backspace", "Fill with the second colour"], ["Ctrl+I", "Invert the layer's colours"]]],
    ["Select and move", [["Click", "Pick a piece (or its layer)"], ["Ctrl + click", "The same, with a brush in hand"], ["Delete", "Remove what is picked"], ["Arrows", "Nudge 1 px · Shift 10 px"], ["Ctrl+T", "Scale and turn"], ["Enter  Esc", "Apply, cancel"], ["Ctrl+J", "Copy it to its own layer"], ["Ctrl+A  Ctrl+D", "Select all, deselect"], ["Ctrl+Shift+I", "Invert the selection"], ["Shift  Alt", "Add to, take from the selection"], ["Ctrl + click", "Add a piece; on a picked one, let it go"]]],
    ["Layers", [["Ctrl+Shift+N", "New layer"], ["Ctrl+J", "Duplicate"], ["Ctrl+E", "Merge down"], ["Ctrl+G", "Group"], ["Alt+[  Alt+]", "Layer below, above"], ["Ctrl+[  Ctrl+]", "Move the layer down, up"], ["Ctrl + click a layer", "Select what is on it"], ["Alt + click the eye", "Show only that layer"], ["\\", "Paint the mask, seen as a red film"], ["Alt + click a mask", "The mask alone"], ["Shift+Alt + click", "The red film"], ["Shift + click a mask", "Switch it off"]]],
    ["View", [["Space", "Pan"], ["Wheel", "Zoom"], ["Ctrl+0  Ctrl+1", "Fit, 100%"], ["Ctrl + =  Ctrl + -", "Zoom in, out"], ["R  Shift+R", "Turn the view freely, by 90°"], ["F", "Mirror the view"], ["Ctrl+R", "Rulers; drag a guide out, back in to remove it"], ["Tab", "Hide the panels"], ["Ctrl+L  M  U", "Levels, curves, hue"], ["Ctrl+Shift+E", "Export"]]],
  ];
  let sheetEl = null;
  function shortcutSheet() {
    if (sheetEl) { sheetEl.remove(); sheetEl = null; root.focus({ preventScroll: true }); return; }
    const close = () => { if (sheetEl) { sheetEl.remove(); sheetEl = null; root.focus({ preventScroll: true }); } };
    sheetEl = h("div", { class: "pt-keys-back", tabIndex: -1, onclick: (e) => { if (e.target === sheetEl) close(); }, onkeydown: (e) => { e.stopPropagation(); if (e.key === "Escape" || e.key === "?") { e.preventDefault(); close(); } } },
      h("div", { class: "pt-keys pt-glass" },
        h("div", { class: "pt-keys-head" }, svg(I.keys), h("span", { text: "Keyboard and mouse" }), h("button", { class: "pt-icon", title: "Close (Esc)", onclick: close }, icon("x"))),
        h("div", { class: "pt-keys-cols" }, ...SHORTCUTS.map(([name, rows]) => h("section", { class: "pt-keys-sec" },
          h("h4", { text: name }),
          ...rows.map(([keys, what]) => h("div", { class: "pt-keys-row" }, h("kbd", { text: keys }), h("span", { text: what }))))))));
    root.append(sheetEl);
    sheetEl.focus({ preventScroll: true });
  }

  const KEYS = { b: "brush", e: "eraser", s: "smudge", u: "shape", i: "picker", m: "marquee", l: "lasso", w: "wand", v: "transform", c: "crop", t: "text", h: "hand" };

  function onKey(e) {
    if (destroyed || !root.contains(document.activeElement)) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const ek = keyOf(e); // the key meant, whatever the keyboard layout
    const k = ek.toLowerCase();
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && k === "y") { e.preventDefault(); doRedo(); return; }
    if (mod && k === "s") { e.preventDefault(); saveNow(true); return; }
    if (mod && e.shiftKey && k === "n") { e.preventDefault(); addLayer(); return; }
    if (mod && e.shiftKey && k === "e") { e.preventDefault(); studio.exportDialog(); return; }
    if (mod && e.shiftKey && k === "i") { e.preventDefault(); engine.invertSelection(); afterSelect(); return; }
    // Animate: Ctrl+D makes the next frame from this one (only the picked pieces, when some are picked)
    if (mod && k === "d" && workspace === "animate" && anim && anim.hasFrames) { e.preventDefault(); anim.duplicate({ only: engine.selection }); return; }
    if (mod && k === "d") { e.preventDefault(); deselect(); return; }
    // a copy lets go of the selection (not of a lifted piece), so a drag after it starts fresh
    if (mod && k === "c" && !e.shiftKey) { e.preventDefault(); copyPieces(); if (engine.selection && !engine.floating) { deselect(); invalidate(); } return; }
    if (mod && k === "x") { e.preventDefault(); copyPieces({ cut: true }); return; }
    if (mod && k === "v" && !e.shiftKey && pasteClip()) { e.preventDefault(); return; }
    if (mod && k === "a") { e.preventDefault(); selectAll(); return; }
    if (mod && k === "e") { e.preventDefault(); mergeDown(selectedId); return; }
    if (mod && k === "j") { e.preventDefault(); engine.selection ? layerViaCopy() : duplicateLayer(selectedId); return; }
    if (mod && k === "t") { e.preventDefault(); freeTransform(); return; }
    if (mod && k === "r" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); measure.toggleRulers(); return; }
    if (mod && (ek === "0" || ek === "1" || ek === "=" || ek === "+" || ek === "-")) {
      e.preventDefault(); e.stopPropagation();
      if (ek === "0") fit(); else if (ek === "1") zoomTo(1, view.cx, view.cy); else zoomTo(view.zoom * (ek === "-" ? 1 / 1.25 : 1.25), (lastSp || { x: W / 2 }).x, (lastSp || { y: H / 2 }).y);
      return;
    }
    if ((mod || e.altKey) && ek === "Backspace") { e.preventDefault(); fillPicked(mod ? colour2 : colour); return; }
    if (mod && (ek === "[" || ek === "]")) { e.preventDefault(); const i = doc.layers.findIndex((l) => l.id === selectedId); const to = clamp(i + (ek === "]" ? 1 : -1), 0, doc.layers.length - 1); if (i >= 0 && to !== i) { moveLayer(i, to); renderLayers(); } return; }
    if (mod && k === "g") { e.preventDefault(); addGroup({ wrap: true }); return; }
    if (mod && k === "i") { e.preventDefault(); invertPixels(); return; }
    if (mod && k === "l") { e.preventDefault(); studio.quickAdjust("levels"); return; }
    if (mod && k === "m") { e.preventDefault(); studio.quickAdjust("curves"); return; }
    if (mod && k === "u") { e.preventDefault(); studio.quickAdjust("hsl"); return; }
    if (mod) return;
    // Animate: N makes a blank frame after this one (a setting: Animate's ⋯ › New frame on N)
    if (ek === "/") { e.preventDefault(); quickActions(); return; }
    if (k === "n" && workspace === "animate" && anim && anim.hasFrames && app.settings.animNewKey !== false && !e.altKey && !e.shiftKey) { e.preventDefault(); anim.blank(); return; }
    // Animate: Alt+← / Alt+→ move the frame on screen earlier or later
    if (e.altKey && (ek === "ArrowLeft" || ek === "ArrowRight") && workspace === "animate" && anim && anim.hasFrames) { e.preventDefault(); anim.shift(ek === "ArrowLeft" ? -1 : 1); return; }
    if (ek === "Escape") {
      e.preventDefault();
      if (tool === "measure" && measure.clear()) return;
      if (placing) { placing = null; root.classList.remove("is-placing"); }
      else if (crop) cancelCrop();
      else if (engine.floating) cancelFloat();
      else if (engine.selection) deselect();
      else if (onMask) { setOnMask(false); renderLayers(); }
      return;
    }
    if (ek === "Enter" && crop) { e.preventDefault(); applyCrop(); return; }
    if (ek === "Enter" && engine.floating) { e.preventDefault(); commitFloat(); renderTop(); renderOpts(); return; }
    if (ek === "Delete" || ek === "Backspace") { e.preventDefault(); deletePicked(); return; }
    if (e.altKey && (ek === "[" || ek === "]")) { // the layer below, the layer above
      e.preventDefault();
      const i = doc.layers.findIndex((l) => l.id === selectedId);
      const next = doc.layers[clamp(i + (ek === "]" ? 1 : -1), 0, doc.layers.length - 1)];
      if (next) { chooseLayer(next.id); renderOpts(); }
      return;
    }
    if (ek === "[" || ek === "]") {
      // one press is a real step; held down it glides, a little at a time
      e.preventDefault();
      const up = ek === "]";
      const now = performance.now();
      if (!e.repeat) sizeHeld = now;
      if (e.repeat && now - sizeKeyAt < 30) return; // held down it glides, never faster than you can stop it
      sizeKeyAt = now;
      // a press is a small step; held, it speeds up the longer the key is down
      const f = 1 + Math.min(0.15, 0.04 + (e.repeat ? ((now - sizeHeld) / 1000) * 0.06 : 0));
      let v = Math.round(brush.size * (up ? f : 1 / f));
      if (v === Math.round(brush.size)) v += up ? 1 : -1;
      setParam("size", clamp(v, 1, BRUSH_MAX));
      flashRing(`${Math.round(brush.size)} px`);
      return;
    }
    if (ek === "{" || ek === "}") {
      e.preventDefault();
      setParam("hardness", clamp(Math.round((brush.hardness + (ek === "}" ? 1 : -1) * (e.repeat ? 0.02 : 0.1)) * 100) / 100, 0, 1));
      flashRing(`${Math.round(brush.hardness * 100)}% hard`);
      return;
    }
    if (ek === "," || ek === ".") { // the brush before, the brush after
      e.preventDefault();
      const ids = B.PRESETS.map((b) => b.id);
      const i = ids.indexOf(brushId);
      setBrush(ids[(Math.max(0, i) + (ek === "." ? 1 : ids.length - 1)) % ids.length]);
      toast(B.PRESET_BY_ID.get(brushId)?.name || "Brush", { ms: 900 });
      return;
    }
    if (ek === "?") { e.preventDefault(); shortcutSheet(); return; }
    if (ek === "Tab") { e.preventDefault(); root.classList.toggle("is-bare"); requestAnimationFrame(resize); return; }
    if (ek.startsWith("Arrow") && activeTool() === "transform") {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      nudge(ek === "ArrowLeft" ? -d : ek === "ArrowRight" ? d : 0, ek === "ArrowUp" ? -d : ek === "ArrowDown" ? d : 0);
      return;
    }
    if (ek === "1" && e.shiftKey) { e.preventDefault(); fit(); return; }
    if (ek === ")" || (ek === "0" && e.shiftKey)) { e.preventDefault(); zoomTo(1, view.cx, view.cy); return; }
    if (ek === "R" && e.shiftKey) { e.preventDefault(); view.angle += Math.PI / 2; invalidate(); scheduleStatus(); return; }
    if (k === "r" && !peek) { e.preventDefault(); peek = "rotate"; root.classList.add("is-peek"); return; }
    if (k === "f") { e.preventDefault(); flipView(); return; }
    if (k === "k") { e.preventDefault(); colourPopover(swatchEl); return; }
    if (k === "x") { e.preventDefault(); swapColours(); return; }
    if (k === "d") { e.preventDefault(); colour2 = "#ffffff"; setColour("#000000", false); renderTools(); return; }
    if (k === "g") { e.preventDefault(); setTool(tool === "fill" ? "gradient" : "fill"); return; }
    // I is the colour picker, and I again the ruler - as in Photoshop
    if (k === "i" && !mod && !e.altKey && !e.repeat) { e.preventDefault(); setTool(tool === "picker" ? "measure" : "picker"); return; }
    if (ek === "\\") { // the mask as a red film over the picture, the way Photoshop's backslash does it
      e.preventDefault();
      const l = layer();
      if (l && l.mask) { if (e.altKey) setMaskView(maskView === "solo" ? "off" : "solo"); else setMaskView(maskView === "overlay" ? "off" : "overlay"); renderLayers(); }
      return;
    }
    if (ek === "F1") { e.preventDefault(); brushPanel.hidden = !brushPanel.hidden; renderBrushPanel(); renderTools(); return; }
    if (/^[0-9]$/.test(ek) && PAINTS.has(tool)) {
      // 4 is 40%, 0 is 100% - and two digits in quick succession are exact: 4 then 5 is 45%
      e.preventDefault();
      const now = performance.now();
      const d = Number(ek);
      const v = digit && now - digit.at < 500 ? (digit.d * 10 + d) / 100 : d === 0 ? 1 : d / 10;
      digit = digit && now - digit.at < 500 ? null : { d, at: now };
      setParam("opacity", clamp(v, 0.01, 1));
      flashRing(`${Math.round(brush.opacity * 100)}% opacity`);
      return;
    }
    const t = KEYS[k];
    if (t) {
      e.preventDefault();
      if (e.repeat) return;
      // held down, a tool key is a loan: let go and the tool you had comes back
      spring = t !== tool ? { key: k, prev: tool, at: performance.now(), used: false } : null;
      setTool(t);
      return;
    }
    if (ek === "Alt" && PAINTS.has(tool) && !peek) { e.preventDefault(); peek = "picker"; root.dataset.tool = "picker"; return; }
    if (ek === " " && !peek) { e.preventDefault(); peek = "hand"; root.classList.add("is-peek"); }
  }

  function onKeyUp(e) {
    const k = keyOf(e).toLowerCase();
    if (spring && spring.key === k) {
      const s = spring;
      spring = null;
      if (tool === KEYS[k] && (s.used || performance.now() - s.at > 450) && !drag && !textEdit && !crop) setTool(s.prev);
    }
    if (e.key === "Control" || e.key === "Meta") root.classList.remove("is-borrowing");
    if ((e.key === " " && peek === "hand") || (k === "r" && peek === "rotate")) { peek = null; root.classList.remove("is-peek"); }
    if (e.key === "Alt" && peek === "picker") { peek = null; root.dataset.tool = tool; }
  }

  root.addEventListener("keydown", onKey);
  root.addEventListener("keyup", onKeyUp);
  // A command chosen from a menu leaves focus on <body>: the menu's button had
  // it and is gone. Ctrl+Z straight afterwards then went nowhere, which read as
  // "this command cannot be undone". With nothing else focused, the keys are ours.
  const onDocKey = (e) => {
    if (destroyed || asleep || e.defaultPrevented) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement) return;
    if (document.querySelector("#overlay-root .menu, .dlg-back, .pal-back, .img-viewer, .ie")) return;
    root.focus({ preventScroll: true });
    onKey(e);
  };
  document.addEventListener("keydown", onDocKey);
  root.addEventListener("blur", () => { if (peek) { peek = null; root.classList.remove("is-peek"); root.dataset.tool = tool; } }, true);

  /* ── saving ─────────────────────────────────────────────────────────── */

  let saving = null;
  let savedAt = 0;
  let trailing = 0;
  let trailingPromise = null;
  let trailingDone = null; // settles a waiting autosave's promise when another save takes its place (or the tab goes)

  /**
   * A save re-encodes every layer as a PNG — a few hundred milliseconds on a
   * 4000 × 4000 canvas. The file view asks for one a moment after each
   * change, which is right for a text file and far too eager here, so an
   * automatic save waits until a few seconds have passed since the last one.
   *
   * It still *resolves* when the drawing is actually on disk rather than when
   * it decided to wait: the file view's "Saving…" has to mean something, and
   * closing the tab must not drop the last few strokes.
   */
  const AUTOSAVE_GAP = 5000;

  async function saveNow(explicit = false, { quiet = false } = {}) {
    if (readOnly) return null;
    // a save already under way: strokes drawn since are saved right after it (a close waits for both), not dropped
    if (saving) return dirty ? saving.catch(() => {}).then(() => saveNow(explicit, { quiet })) : saving;
    if (!dirty && !explicit) return null;
    if (!explicit) {
      const wait = AUTOSAVE_GAP - (Date.now() - savedAt);
      if (wait > 0) {
        if (!trailing) {
          trailingPromise = new Promise((done) => {
            trailingDone = done;
            trailing = setTimeout(() => { trailing = 0; trailingDone = null; saveNow(false).then(done, () => done(null)); }, wait + 20);
          });
        }
        return trailingPromise;
      }
    }
    if (trailing) { clearTimeout(trailing); trailing = 0; }
    if (textEdit && explicit) commitText();
    doc.selected = selectedId;
    const was = dirty;
    dirty = false;
    const run = (async () => {
      try {
        const entry = await S.saveDoc(app, path, doc, engine, { created });
        savedAt = Date.now();
        if (explicit && !quiet) toast("Drawing saved", { ms: 1600 });
        return entry;
      } catch (e) {
        dirty = was;
        toast("Could not save the drawing: " + (e && e.message ? e.message : e), { kind: "error" });
        throw e;
      }
    })();
    saving = run;
    // whoever waited on the autosave this replaces is told when this one is done (it waited forever before)
    if (trailingDone) { trailingDone(run.catch(() => null)); trailingDone = null; }
    try { return await run; } finally { if (saving === run) saving = null; scheduleStatus(); }
  }

  /* ── dormancy ───────────────────────────────────────────────────────── */

  /**
   * Hidden tab: stop the frame loop and hand back every big bitmap that can
   * be rebuilt. Layer bitmaps stay — they are the document — but the stroke
   * scratch, the buffer pool, the tip cache and the checkerboard all go.
   */
  function sleep() {
    if (asleep || destroyed) return;
    asleep = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (statusRaf) { cancelAnimationFrame(statusRaf); statusRaf = 0; }
    if (thumbTimer) { clearTimeout(thumbTimer); thumbTimer = 0; }
    engine.cancelStroke();
    engine.sleep();
    checker = null;
    frameTimes.length = 0;
    if (!deep && !deepTimer) deepTimer = setTimeout(deepSleep, DEEP_SLEEP_MS);
  }

  /**
   * A tab left in the background for a while gives up the layer bitmaps too —
   * on a 4000 × 4000 document that is 244 MB of the 366 MB this editor holds,
   * and a drawing nobody is looking at has no business keeping it.
   *
   * It is saved first, so the bitmaps can simply be read back from the file
   * on the way in. If the save fails, nothing is dropped.
   */
  const DEEP_SLEEP_MS = 20000;
  let deep = false;
  let deepTimer = 0;

  async function deepSleep() {
    deepTimer = 0;
    if (!asleep || destroyed || deep || engine.floating || textEdit || studio.busy()) return;
    if (dirty) {
      try { await saveNow(true, { quiet: true }); } catch { return; }
    }
    if (!asleep || destroyed || deep) return;
    deep = true;
    engine.clearSelection();
    for (const id of [...engine.layers.keys()]) engine.dropLayerBitmap(id);
  }

  async function wake() {
    if (destroyed) return;
    if (deepTimer) { clearTimeout(deepTimer); deepTimer = 0; }
    if (!asleep) return;
    if (deep) {
      // stay "asleep" until the pixels are back, so no frame paints a blank
      try { await S.loadBitmaps(engine, doc, await app.host.paintLoad(path)); } catch (e) { toast("Could not reload the drawing: " + e, { kind: "error" }); }
      if (destroyed) return;
      deep = false;
      // the history holds rectangles of bitmaps that no longer exist
      history.clear();
    }
    asleep = false;
    engine.allDirty = true;
    resize();
    paintThumbs();
    scheduleStatus();
  }

  const onVisibility = () => (document.hidden ? sleep() : wake());
  document.addEventListener("visibilitychange", onVisibility);

  // the tab going away in Leonote's own tab strip, not just the window
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) wake();
      else sleep();
    }
  }, { threshold: 0 });
  io.observe(root);

  const ro = new ResizeObserver(() => resize());
  ro.observe(root);

  /* ── Studio ─────────────────────────────────────────────────────────── */

  // everything Studio's panels and dialogs need from the editor, in one place
  const ed = {
    app, path, doc, engine, history, root, view, readOnly, adjustPanel,
    h, icon, svg, fill, popover, slider, I,
    invalidate, changed, structural, pushMeta, pushPixels, pixelsOf, landed, layerSnapshot, restoreLayers,
    renderLayers, renderTop, renderOpts, scheduleStatus, thumbSoon, fit, setTool, layer, targetKey,
    addAdjust, addMask, docOp, deselect, afterSelect, selectAll, insertAbove, roomFor, commitFloat,
    get selectedId() { return selectedId; },
    select: (id) => { selectedId = id; doc.selected = id; setOnMask(false); renderLayers(); studio.render(); },
    get colour() { return colour; },
    get colour2() { return colour2; },
    get workspace() { return workspace; },
    setWorkspace,
    startPlacing: () => { setTool("transform"); renderTop(); invalidate(); },
    duplicateLayer, deleteLayer,
    save: () => saveNow(false, { quiet: true }),
    setOnion: (c) => { onionCanvas = c; invalidate(); },
    setUnder: (u) => { under = u; invalidate(); },
  };
  studio = mountStudio(ed);
  anim = mountAnim(ed);
  // made just now for Animate: its first frame is there from the start
  if (app._animNext === path) { app._animNext = null; if (workspace === "animate") anim.enter(); }

  /* ── go ─────────────────────────────────────────────────────────────── */

  root.dataset.tool = tool;
  root.dataset.workspace = workspace;
  adjustPanel.hidden = workspace !== "studio";
  setColour(app.settings[S.SETTING_KEYS.palette]?.[0] || "#111318", false);
  renderTools();
  renderTop();
  renderOpts();
  renderLayers();
  studio.render();
  anim.render();
  renderStatus();
  resize();
  requestAnimationFrame(() => { resize(); fit(); });
  root.focus({ preventScroll: true });

  /**
   * Closing the tab must never lose the last few strokes: if there is
   * anything unsaved, the bitmaps stay alive until that save lands, and only
   * then is the engine torn down.
   */
  function destroy() {
    measure.destroy();
    if (destroyed) return;
    if (textEdit) commitText();
    if (raf) cancelAnimationFrame(raf);
    if (statusRaf) cancelAnimationFrame(statusRaf);
    if (optsRaf) cancelAnimationFrame(optsRaf);
    if (thumbTimer) clearTimeout(thumbTimer);
    document.removeEventListener("keydown", onDocKey);
    if (trailing) { clearTimeout(trailing); trailing = 0; }
    if (deepTimer) { clearTimeout(deepTimer); deepTimer = 0; }
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onLeave);
    io.disconnect();
    ro.disconnect();
    root.__leopaint = null;
    // a save still running is waited for too: the engine must not go while it reads the layers
    const last = !readOnly && (dirty || saving) ? saveNow(true, { quiet: true }).catch(() => {}) : null;
    if (trailingDone) { trailingDone(last); trailingDone = null; }
    destroyed = true;
    studio.destroy();
    anim.destroy();
    const finish = () => {
      history.clear();
      engine.destroy();
      thumbEls.clear();
      checker = null;
      el.replaceChildren();
    };
    if (last) last.then(finish, finish);
    else finish();
  }

  const api = {
    destroy,
    focus: () => { if (!destroyed) root.focus({ preventScroll: true }); },
    save: () => saveNow(false),
    saveNow: () => saveNow(true),
    get dirty() { return dirty; },
    sleep,
    wake,
    path,
    doc,
    engine,
    history,
    studio,
    /** For the performance report: average frame time and what is resident. */
    stats: () => ({
      frameMs: frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0,
      worstMs: frameTimes.length ? Math.max(...frameTimes) : 0,
      frames: frameTimes.length,
      framesPainted,
      memory: engine.memory(),
      history: history.stats(),
      rafScheduled: !!raf,
      asleep,
      deep,
    }),
    // everything the UI does, as plain calls: devtools, and the headless
    // drive script that checks a stroke really lands on the right layer
    resetFrames: () => { frameTimes.length = 0; },
    api: {
      setTool, setColour, setBrush, setParam, addLayer, addGroup, addAdjust, duplicateLayer, deleteLayer, mergeDown, rasterise, flattenPicture,
      setLayerProp, dropLayer, addMask, deleteMask, applyMask, editMask, doUndo, doRedo, fit, zoomTo, flipView, selectAll, setSelection, deselect,
      setWorkspace, docOp, setMaskView, applyCrop, cancelCrop, commitText, textOption, swapColours,
      doExport: (format, scale, quality) => studio.quickExport(format, scale, quality),
      setSymmetry: (patch) => { Object.assign(symmetry, patch); syncAssist(); invalidate(); renderOpts(); },
      setGuide: (patch) => { Object.assign(guide, patch); syncAssist(); invalidate(); renderOpts(); },
      setOption: (k, v) => {
        ({ selMode: () => { selMode = v; }, marqueeShape: () => { marqueeShape = v; }, wandTolerance: () => { wandTolerance = v; }, wandContiguous: () => { wandContiguous = v; },
          wandSampleAll: () => { wandSampleAll = v; }, gradKind: () => { gradKind = v; }, gradTo: () => { gradTo = v; }, shapeKind: () => { shapeKind = v; }, shapeFilled: () => { shapeFilled = v; },
          cropRatio: () => { cropRatio = v; }, fillTolerance: () => { fillTolerance = v; } }[k] || (() => {}))();
        renderOpts();
      },
      view,
      layerIdAt: (i) => doc.layers[i] && doc.layers[i].id,
      select: (id) => ed.select(id),
      get selectedId() { return selectedId; },
      get brush() { return brush; },
      get doc() { return doc; },
      get onMask() { return onMask; },
      get crop() { return crop; },
      get tool() { return tool; },
      get textEdit() { return textEdit; },
      get historyAt() { return history.at; },
    },
  };
  // a handle on the DOM node, so devtools (and the tests) can reach the
  // editor without the app having to hold a reference to it
  root.__leopaint = api;
  return api;
}

/* ── small helpers ───────────────────────────────────────────────────────── */

/**
 * `replaceChildren` is the raw DOM call, and it turns a null into the word
 * "null" on screen — unlike `h()`, which drops them. Every panel here is
 * built with `a ? node : null` holes, so they all go through this.
 */
export function fill(el, ...kids) {
  // Rebuilding a bar throws away the button that was just clicked, and focus
  // falls to <body> — after which no shortcut reaches the editor until the
  // canvas is clicked again. If focus was in here, it goes back to the editor.
  const owner = el.closest(".pt");
  const had = !!owner && el.contains(document.activeElement);
  el.replaceChildren(...kids.flat(4).filter((k) => k != null && k !== false));
  if (had && !owner.contains(document.activeElement)) owner.focus({ preventScroll: true });
  return el;
}

export function svg(path) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("class", "ico");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.7");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.innerHTML = path;
  return el;
}

function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function unionDocBox(a, b) {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** A lightweight popover anchored under an element; closes on the next click away. */
export function popover(node, anchor, { onClose = null } = {}) {
  const r = anchor.getBoundingClientRect();
  node.style.position = "fixed";
  document.body.append(node);
  const w = node.offsetWidth || 240;
  node.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + "px";
  node.style.top = Math.max(8, Math.min(window.innerHeight - (node.offsetHeight || 40) - 8, r.bottom + 6)) + "px";
  const close = (e) => {
    if (e && (node.contains(e.target) || anchor.contains(e.target))) return;
    node.remove();
    document.removeEventListener("pointerdown", close, true);
    if (onClose) onClose();
  };
  setTimeout(() => document.addEventListener("pointerdown", close, true));
  node.__close = () => close(null);
  return node;
}
