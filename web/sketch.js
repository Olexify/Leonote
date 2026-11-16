// Sketch: Leonote's own whiteboard. Files are Excalidraw JSON (.excalidraw),
// so the same drawing opens on excalidraw.com and in Obsidian.
//
// Speed rules: two canvases. The static one holds every settled element and
// only repaints when something settles (or the view moves); whatever is being
// drawn, dragged or erased lives on the overlay, which repaints every frame.
// Pointer handlers only record positions; all work happens once per frame.
// Shapes are rough.js drawables cached per element version (sketchrender.js).

import { h, basename, dirname, debounce } from "./util.js";
import { icon } from "./icons.js";
import * as M from "./sketchmodel.js";
import * as R from "./sketchrender.js";
import * as B from "./sketchbrush.js";
import { mountMeasure } from "./sketchrulers.js";
import { hsvToHex, hexToHsv } from "./treestyle.js";

const MIN_K = 0.05;
const MAX_K = 30;
const HANDLE = 10; // px on screen
const ROTATE_GAP = 26;
const SNAP_PX = 6;
const IMAGE_MAX = 1600;
const LASER_MS = 1700;
const DRAG_PX = 3;
const CLICK_PX = 4; // a right press that moves less than this is a click
const HIT_PX = 8; // how close counts as touching, in screen px
const PEEK_MS = 280; // holding a tool key this long makes it temporary
const TOOLS_WITH_STYLE = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "sticky"]);

// per drawing path for this session
const lastViews = new Map();
let sketchClip = null;

// tool and panel icons, in the shared 24px, 1.7 stroke, round-cap style
const I = {
  select: '<path d="M6.5 4l11.5 7-5 1.3 3 5.4-2.3 1.3-3-5.4-3.8 3.6z"/>',
  hand: '<path d="M8 12.5V6.5a1.5 1.5 0 0 1 3 0V11M11 10.5v-6a1.5 1.5 0 0 1 3 0v6M14 10.5V6a1.5 1.5 0 0 1 3 0v7.5c0 4-2.5 6.5-6 6.5-2.6 0-4-1.2-5.3-3.2L3.6 13.3a1.5 1.5 0 0 1 2.5-1.6L8 14"/>',
  rectangle: '<rect x="4" y="5.5" width="16" height="13" rx="2.5"/>',
  diamond: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/>',
  ellipse: '<circle cx="12" cy="12" r="8"/>',
  arrow: '<path d="M4.5 19.5L19 5M11 5h8v8"/>',
  line: '<path d="M4.5 19.5L19.5 4.5"/>',
  pen: '<path d="M4 20c2-1 3.5-4.5 6-6.5s5-1.5 6.5-3.5S18 5.5 20 4"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5L6 19.5"/>',
  eraser: '<path d="M8.5 19.5L3.9 14.9a1.5 1.5 0 0 1 0-2.1l8.9-8.9a1.5 1.5 0 0 1 2.1 0l4.6 4.6a1.5 1.5 0 0 1 0 2.1L11 19.5zM20 19.5H11M7.5 9.5l7 7"/>',
  laser: '<path d="M12 12l8.5 8.5"/><circle cx="8" cy="8" r="2.2"/><path d="M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.2 4.2l1 1M10.8 10.8l1 1M4.2 11.8l1-1M10.8 5.2l1-1"/>',
  frame: '<path d="M7 3.5v17M17 3.5v17M3.5 7h17M3.5 17h17"/>',
  measure: '<path d="M3.5 15.5L15.5 3.5l5 5-12 12z"/><path d="M7.5 11.5l2 2M10.5 8.5l2.5 2.5M13.5 5.5l2 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/>',
  more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  map: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="11.5" y="11" width="6" height="5" rx="1"/>',
  // style panel
  swThin: '<path d="M5 12h14" stroke-width="1.2"/>',
  swBold: '<path d="M5 12h14" stroke-width="2.6"/>',
  swExtra: '<path d="M5 12h14" stroke-width="4.4"/>',
  ssSolid: '<path d="M4.5 12h15"/>',
  ssDashed: '<path d="M4.5 12h3.5M10.2 12h3.6M16 12h3.5"/>',
  ssDotted: '<path d="M5 12h.01M9 12h.01M13 12h.01M17 12h.01M20.5 12h.01" stroke-width="2.4"/>',
  fsHachure: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="M4.8 12.5l7.7-7.7M5.5 18.5L18.5 5.5M11.5 19.2l7.7-7.7"/>',
  fsCross: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="M5.5 18.5L18.5 5.5M5.5 5.5l13 13M4.8 12l7.2-7.2M12 19.2l7.2-7.2"/>',
  fsZigzag: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="M5 10l3-4 1.5 12 3-12 1.5 12 3-12 2 6"/>',
  fsSolid: '<rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="currentColor"/>',
  r0: '<path d="M4 16c5-8 11-8 16-8" />',
  r1: '<path d="M4 17c2-3 3-6 5.5-6.5S13 12 15 10s3-2.5 5-2.5"/>',
  r2: '<path d="M4 17c1-2 2.2-5 3.5-4.2s.8 3 2.4 2.2 1.1-5.2 2.8-5.5 1.3 3.8 3 2.9 1.4-4.9 4.3-4.9"/>',
  edgeSharp: '<path d="M5 19V5h14"/>',
  edgeRound: '<path d="M5 19V11a6 6 0 0 1 6-6h8"/>',
  arrowSharp: '<path d="M4.5 18.5L12 8l7.5 3"/>',
  arrowCurved: '<path d="M4.5 18.5C7 10 13 7 19.5 8"/>',
  ahNone: '<path d="M4 12h16"/>',
  ahArrow: '<path d="M4 12h16M14 7l6 5-6 5"/>',
  ahTriangle: '<path d="M4 12h10"/><path d="M13 6.5l7 5.5-7 5.5z" fill="currentColor"/>',
  ahDot: '<path d="M4 12h11"/><circle cx="16.5" cy="12" r="3.5" fill="currentColor"/>',
  ahBar: '<path d="M4 12h16M20 6.5v11"/>',
  ahTriangleOutline: '<path d="M4 12h9"/><path d="M13 6.5l7 5.5-7 5.5z"/>',
  ahDiamond: '<path d="M4 12h6"/><path d="M10 12l5-4.5 5 4.5-5 4.5z" fill="currentColor"/>',
  fontHand: '<path d="M6 18c1.5-4 3.5-11 5.5-12s2 5 2.5 7M8 14.5c2.5-.8 5-.6 7 .2M15.5 17c1-.5 2-2.5 3-2.3"/>',
  fontNormal: '<path d="M6 18.5L11.5 5h1L18 18.5M8 14h8"/>',
  fontCode: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  alignL: '<path d="M4.5 4v16M8 8h11M8 14h7"/>',
  alignCH: '<path d="M12 4v16M6 8h12M8 14h8"/>',
  alignR: '<path d="M19.5 4v16M5 8h11M9 14h7"/>',
  alignT: '<path d="M4 4.5h16M8 8v11M14 8v7"/>',
  alignCV: '<path d="M4 12h16M8 6v12M14 8v8"/>',
  alignB: '<path d="M4 19.5h16M8 5v11M14 9v7"/>',
  distH: '<path d="M4 4v16M20 4v16"/><rect x="9.5" y="8" width="5" height="8" rx="1"/>',
  distV: '<path d="M4 4h16M4 20h16"/><rect x="8" y="9.5" width="8" height="5" rx="1"/>',
  taLeft: '<path d="M4.5 6h15M4.5 10h9M4.5 14h15M4.5 18h9"/>',
  taCenter: '<path d="M4.5 6h15M7.5 10h9M4.5 14h15M7.5 18h9"/>',
  taRight: '<path d="M4.5 6h15M10.5 10h9M4.5 14h15M10.5 18h9"/>',
  toBack: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9" stroke-dasharray="2 2.2"/><path d="M12 12.5v4M10 14.5l2 2 2-2"/>',
  backward: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/><path d="M13.5 11v5M11.5 14l2 2 2-2"/>',
  forward: '<rect x="5" y="5" width="11" height="11" rx="2"/><path d="M19 9v9a1 1 0 0 1-1 1H9"/><path d="M10.5 13V8M8.5 10l2-2 2 2"/>',
  toFront: '<rect x="5" y="5" width="11" height="11" rx="2"/><path d="M19 9v9a1 1 0 0 1-1 1H9" stroke-dasharray="2 2.2"/><path d="M10.5 12.5v-4M8.5 10.5l2-2 2 2"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  group: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" stroke-dasharray="2.6 2.4"/><rect x="7" y="7" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/>',
  ungroup: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/><path d="M14 4h6v6M4 14v6h6" stroke-dasharray="2 2"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  custom: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>',
  sticky: '<path d="M5 4.5h14a.5.5 0 0 1 .5.5v9.5l-5 5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5z"/><path d="M19.5 14.5h-4.5a.5.5 0 0 0-.5.5v4.5M8 9h8M8 12.5h5"/>',
  card: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 5v14M7.5 9.5h6M7.5 13h9M7.5 16h5"/><path d="M4.5 5.5v13" stroke-width="2.6"/>',
  lasso: '<path d="M7.5 15.5C4.5 14.3 3 12.4 3 10.3 3 6.8 7 4 12 4s9 2.8 9 6.3-4 6.2-9 6.2c-1 0-2-.1-2.9-.3"/><path d="M9 15.5a1.8 1.8 0 1 1-2.4 1.7c0 1.6-.6 2.8-1.6 3.3"/>',
  picker: '<path d="M14.5 4.5l5 5M13 6l5 5-9.5 9.5H4.5v-4z"/><path d="M16.2 3.8a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L18.5 9.5l-4-4z" fill="currentColor"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  outline: '<path d="M4 6h2M9 6h11M6 12h2M11 12h9M6 18h2M11 18h9"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.2"/>',
  exportImg: '<path d="M12 14V4M8 8l4-4 4 4"/><path d="M4.5 13v4.5A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5V13"/>',
  send: '<path d="M4 12L20 4l-5 16-3.5-6.5z"/><path d="M11.5 13.5L20 4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  canvas: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="8.5" cy="8.5" r=".6"/><circle cx="12" cy="8.5" r=".6"/><circle cx="15.5" cy="8.5" r=".6"/><circle cx="8.5" cy="12" r=".6"/><circle cx="12" cy="12" r=".6"/><circle cx="15.5" cy="12" r=".6"/><circle cx="8.5" cy="15.5" r=".6"/><circle cx="12" cy="15.5" r=".6"/><circle cx="15.5" cy="15.5" r=".6"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  star: '<path d="M12 4l2.4 5 5.4.7-4 3.7 1 5.4L12 16.2l-4.8 2.6 1-5.4-4-3.7 5.4-.7z"/>',
  // brush families
  bPencil: '<path d="M15.5 4.5l4 4L9 19H5v-4z"/><path d="M13.5 6.5l4 4M5 15l4 4"/><path d="M5 19l1.6-1.6" stroke-width="2.4"/>',
  bPen: '<path d="M12 3.5l3.5 6-3.5 11-3.5-11z"/><path d="M12 9.5v3.5"/><circle cx="12" cy="13.5" r=".6"/>',
  bMarker: '<path d="M14 4l6 6-8 8H6v-6z"/><path d="M6 18l-2 2M11 7l6 6"/>',
  bBrush: '<path d="M20 4c-3 1.5-7.5 6-9.5 9l1.5 1.5c3-2 7.5-6.5 8-10.5z"/><path d="M10.5 13c-2 0-3.5 1.3-3.5 3.3 0 1.4-.9 2.5-2.5 3.2 3.3.8 7.7-.3 7.5-5z"/>',
  bHighlighter: '<path d="M15 4l5 5-8.5 8.5-5-5z"/><path d="M6.5 12.5L5 17l2 2 4.5-1.5M3.5 20.5h6"/>',
  bChalk: '<rect x="4" y="9" width="16" height="6" rx="1.5" transform="rotate(-35 12 12)"/><path d="M4 20.5c1.5-.3 2.3-.8 3.5-.4s2.5.4 3.5-.2" stroke-dasharray="1.5 1.4"/>',
  bCustom: '<path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/><circle cx="12" cy="12" r="4"/>',
};
const FAMILY_ICON = { pencil: "bPencil", pen: "bPen", marker: "bMarker", brush: "bBrush", highlighter: "bHighlighter", chalk: "bChalk", custom: "bCustom" };

function ic(name, cls) {
  if (!I[name]) return icon(name, cls);
  const s = document.createElement("span");
  s.className = "ico" + (cls ? " " + cls : "");
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;
  return s;
}

// the toolbar, in groups; `sep` draws a divider
const TOOLS = [
  { id: "hand", name: "Hand", keys: "H", hint: "or hold Space, or drag with the right mouse button", icon: "hand" },
  { id: "select", name: "Select", keys: "V", num: "1", hint: "Alt-drag on empty canvas draws a lasso", icon: "select" },
  "sep",
  { id: "freedraw", name: "Pen and brushes", keys: "B", num: "2-7", hint: "2 pencil, 3 pen, 4 marker, 5 brush, 6 highlighter, 7 chalk - each comes back with the one you used last. Click again or press B for all of them", icon: "pen" },
  { id: "eraser", name: "Eraser", keys: "E", num: "8", hint: "hold E to erase for a moment", icon: "eraser" },
  "sep",
  { id: "rectangle", name: "Rectangle", keys: "U", hint: "U again: ellipse, diamond, line, arrow - or R", icon: "rectangle" },
  { id: "diamond", name: "Diamond", keys: "D", icon: "diamond" },
  { id: "ellipse", name: "Ellipse", keys: "O", icon: "ellipse" },
  { id: "arrow", name: "Arrow", keys: "A", hint: "ends stick to shapes and cards", icon: "arrow" },
  { id: "line", name: "Line", keys: "U", hint: "the fourth press of U", icon: "line" },
  "sep",
  { id: "text", name: "Text", keys: "T", num: "9", icon: "text" },
  { id: "sticky", name: "Sticky note", keys: "S", icon: "sticky" },
  { id: "card", name: "Link a note", keys: "N", hint: "or drop notes from the file tree", icon: "card" },
  { id: "image", name: "Image", keys: "0", num: "0", icon: "image" },
  { id: "frame", name: "Frame", keys: "F", hint: "a titled section", icon: "frame" },
  { id: "piece", name: "Piece", keys: "J", hint: "drag a box (nothing changes), then drag from inside it: what is in it comes out and moves - pen strokes cut at the box, pictures cut too, shapes inside it whole. Alt leaves the original. Delete cuts the box out, Esc lets go", icon: "scissors" },
  "sep",
  { id: "measure", name: "Measure", keys: "I", hint: "I twice (after the eyedropper) - distances, paths and areas, angles - snaps to corners, in the drawing's own units. Shift R shows rulers", icon: "measure" },
];
// The number row follows the hand, not the toolbar's old order: drawing comes
// first. 1 select, 2-7 the six kinds of brush (KEY_BRUSHES), 8 eraser, 9 text,
// 0 image. Shapes keep their letters (R D O A L), which were always quicker.
const KEY_BRUSHES = { Digit2: "pencil", Digit3: "pen", Digit4: "marker", Digit5: "brush", Digit6: "highlighter", Digit7: "chalk" };
const KEY_TOOLS = {
  KeyV: "select", Digit1: "select", KeyH: "hand", KeyR: "rectangle", KeyD: "diamond",
  KeyO: "ellipse", KeyA: "arrow", KeyL: "lasso", KeyP: "freedraw", KeyX: "freedraw",
  KeyT: "text", Digit9: "text", Digit0: "image", KeyE: "eraser", Digit8: "eraser", KeyK: "laser", KeyF: "frame",
  KeyS: "sticky", KeyW: "lasso", KeyI: "picker", KeyJ: "piece",
};
// tools a held key only borrows
const PEEK_TOOLS = new Set(["eraser", "picker", "lasso", "laser", "hand"]);
const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
const HANDLE_ANGLE = { e: 0, se: 1, s: 2, sw: 3, w: 4, nw: 5, n: 6, ne: 7 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const typing = (el) => !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
const isLinear = (el) => el.type === "arrow" || el.type === "line";
const hasPoints = (el) => isLinear(el) || el.type === "freedraw";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const now = () => Date.now();

async function sha1(text) {
  try {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return M.randomId();
  }
}

function readAsDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("That picture could not be read"));
    img.src = src;
  });
}

/** Downscale to IMAGE_MAX and re-encode as WebP unless the original is already smaller. */
async function prepareImage(blob) {
  const original = await readAsDataUrl(blob);
  const img = await loadImage(original);
  const w = img.naturalWidth || 1;
  const hh = img.naturalHeight || 1;
  const k = Math.min(1, IMAGE_MAX / Math.max(w, hh));
  const small = k === 1 && blob.size < 180 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(blob.type);
  if (small) return { dataURL: original, mimeType: blob.type, width: w, height: hh };
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(hh * k));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const webp = c.toDataURL("image/webp", 0.88);
  const useWebp = webp.startsWith("data:image/webp") && (k < 1 || webp.length < original.length);
  return { dataURL: useWebp ? webp : original, mimeType: useWebp ? "image/webp" : blob.type || "image/png", width: c.width, height: c.height };
}

/**
 * Mount a drawing into `el`. `text` is the file's JSON ("" for a new one).
 * Resolves to { getText, destroy, dirty, focus }.
 */
export async function mountSketch(el, text, opts = {}) {
  const app = opts.app || {};
  const path = opts.path || "";
  const notify = typeof opts.onChange === "function" ? opts.onChange : () => {};
  const S = app.settings || {};
  const setting = (k, d) => (S[k] === undefined ? d : S[k]);
  const saveSetting = (k, v) => { if (app.setSetting) app.setSetting(k, v); else S[k] = v; };
  const toast = (msg, o) => (app.toast ? app.toast(msg, o) : null);
  const menu = (x, y, items) => {
    // no separators at the ends or twice in a row
    const list = [];
    for (const it of items) {
      if (!it) continue;
      if (it === "sep" && (!list.length || list[list.length - 1] === "sep")) continue;
      list.push(it);
    }
    while (list[list.length - 1] === "sep") list.pop();
    if (app.menu) app.menu(x, y, list);
  };

  const parsed = M.parseScene(text);
  const scene = parsed.scene;
  const readOnly = !!parsed.error;
  const originalText = text;
  const els = scene.elements;
  const byId = new Map(els.map((e) => [e.id, e]));
  const files = scene.files;
  const images = new Map();

  /* ── state ────────────────────────────────────────────────────────────── */
  const view = { x: 0, y: 0, k: 1 };
  let W = 0;
  let H = 0;
  let dpr = 1;
  let tool = "select";
  let toolLocked = !!setting("sketchToolLock", true); // on unless turned off: the tool stays after a shape
  const selected = new Set();
  let editingGroup = null;
  const style = { ...M.DEFAULT_STYLE, ...(setting("sketchStyle", null) || {}) };
  // the pen's brush: a preset id plus any tweaks
  if (!style.brush || typeof style.brush !== "object" || typeof style.brush.id !== "string") style.brush = { id: "pen" };
  let recentColors = (setting("sketchRecentColors", null) || []).filter((c) => typeof c === "string" && M.parseColor(c)).slice(0, 8);
  let customBrushes = (setting("sketchBrushes", null) || []).filter((b) => b && typeof b.id === "string" && typeof b.name === "string");
  const lastPerFamily = { ...(setting("sketchBrushFamilies", null) || {}) };
  let eraseMode = setting("sketchEraseMode", "whole") === "cut" ? "cut" : "whole";
  let eraseSize = clamp(Number(setting("sketchEraseSize", 14)) || 14, 4, 80);
  let panelPinned = !!setting("sketchPanelPinned", false);
  let prevTool = null; // a tool borrowed by a held key returns here
  let peek = null; // { code, at, used }
  let gridOn = M.gridEnabled(scene.appState);
  let guidesOn = setting("sketchGuides", true) !== false;
  let mapOn = !!setting("sketchMinimap", false);
  const history = M.createHistory(150);
  let changes = 0;
  let savedChanges = 0;
  let destroyed = false;
  let dark = true;
  let accent = "#e0a84a";
  let canvasBg = "#121214";
  let spaceDown = false;
  let gesture = null;
  let hover = null;
  let bindTarget = null;
  let guides = [];
  let box = null; // box select, world units
  let lasso = null; // flat [x0, y0, ...] world polygon while lassoing
  let found = []; // search hits (ids) to outline
  let foundAt = -1;
  let draft = null; // multi-point line/arrow being placed
  let pointEdit = null; // { id, sel: Set(index) } editing a line's points
  let editing = null; // the text editor
  const erasing = new Set();
  let measure = null; // rulers, the Measure tool, exact sizes (sketchrulers.js); mounted further down
  let eraserTrail = [];
  let laser = [];
  let penSeen = 0;
  let lastStaticMs = 0;
  const staticView = { x: 0, y: 0, k: 1 };
  let fullRenderAt = 0;
  let liveIds = new Set();
  let dirtyStatic = true;
  let dirtyOver = true;
  let dirtyMap = true;
  let dirtyMapView = true;
  let raf = 0;
  let panelRaf = 0;
  const ptr = { sx: 0, sy: 0, wx: 0, wy: 0, inside: false, type: "mouse", pressure: 0.5, shift: false, alt: false, ctrl: false, down: false };
  const touches = new Map();
  const viewport = new Float64Array(4);

  /* ── DOM ──────────────────────────────────────────────────────────────── */
  const cStatic = h("canvas", { class: "sk-canvas" });
  const cOver = h("canvas", { class: "sk-canvas sk-over" });
  const ctx = cStatic.getContext("2d");
  const octx = cOver.getContext("2d");
  const toolbar = h("div", { class: "sk-toolbar sk-glass", role: "toolbar" });
  const hint = h("div", { class: "sk-hint", hidden: true });
  const panel = h("div", { class: "sk-panel sk-glass", hidden: true });
  const zoomLabel = h("button", { class: "sk-zoom-label", title: "Zoom options", tabindex: "-1" });
  const undoBtn = h("button", { class: "sk-btn", title: "Undo (Ctrl+Z)", tabindex: "-1", onclick: () => doUndo() }, ic("undo"));
  const redoBtn = h("button", { class: "sk-btn", title: "Redo (Ctrl+Shift+Z)", tabindex: "-1", onclick: () => doRedo() }, ic("redo"));
  const outlineBtn = h("button", { class: "sk-btn", title: "Outline: frames and note cards (Shift+O)", tabindex: "-1", onclick: () => toggleOutline() }, ic("outline"));
  const exportBtn = h("button", { class: "sk-btn", title: "Export and share", tabindex: "-1" }, ic("exportImg"));
  const foot = h("div", { class: "sk-foot" },
    h("div", { class: "sk-group sk-glass" },
      h("button", { class: "sk-btn", title: "Zoom out (-)", tabindex: "-1", onclick: () => zoomBy(1 / 1.2) }, ic("minus")),
      zoomLabel,
      h("button", { class: "sk-btn", title: "Zoom in (=). The mouse wheel zooms at the pointer", tabindex: "-1", onclick: () => zoomBy(1.2) }, ic("plus")),
      h("button", { class: "sk-btn", title: "Zoom to fit (Shift+1)", tabindex: "-1", onclick: () => fitAll() }, ic("fit"))),
    h("div", { class: "sk-group sk-glass" }, undoBtn, redoBtn),
    h("div", { class: "sk-group sk-glass" },
      h("button", { class: "sk-btn", title: "Find in this sketch (Ctrl+F)", tabindex: "-1", onclick: () => openSearch() }, ic("search")),
      outlineBtn, exportBtn));
  const ctxBar = h("div", { class: "sk-ctx sk-glass", hidden: true, role: "toolbar" });
  const outlineEl = h("div", { class: "sk-outline sk-glass", hidden: true });
  const searchEl = h("div", { class: "sk-search sk-glass", hidden: true });
  const mapCanvas = h("canvas", { class: "sk-map-canvas" });
  const mapBox = h("div", { class: "sk-map sk-glass", hidden: !mapOn }, mapCanvas);
  const mapBtn = h("button", { class: "sk-btn sk-map-btn sk-glass" + (mapOn ? " is-on" : ""), title: "Minimap (M)", tabindex: "-1", onclick: () => toggleMap() }, ic("map"));
  const empty = h("div", { class: "sk-empty", hidden: true },
    h("div", { class: "sk-empty-title", text: "A blank page" }),
    h("div", { class: "sk-empty-sub", text: "Draw with B, shapes with U (press again for the next one), text with T, a sticky note with S. Drop notes from the file tree to link them. Right-click for tools and canvas options, drag with the right button to pan, ? for every shortcut." }));
  const banner = parsed.error ? h("div", { class: "sk-banner", text: `This file could not be read, so it opens read-only: ${parsed.error}` }) : null;
  const fileInput = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, tabindex: "-1" });
  const root = h("div", { class: "sk", tabindex: "0" }, cStatic, cOver, toolbar, hint, panel, ctxBar, outlineEl, searchEl, foot, mapBox, mapBtn, empty, banner, fileInput);
  el.replaceChildren(root);

  /* ── theme ────────────────────────────────────────────────────────────── */
  function readTheme() {
    dark = document.documentElement.dataset.theme !== "light";
    const cs = getComputedStyle(root);
    accent = cs.getPropertyValue("--accent").trim() || "#e0a84a";
    const appBg = cs.getPropertyValue("--bg").trim() || (dark ? "#121214" : "#ffffff");
    canvasBg = M.canvasColor(scene.appState, dark) || appBg;
    root.style.setProperty("--sk-canvas", canvasBg);
    root.classList.toggle("is-dark", dark);
    // patterns have to read on whatever colour the canvas is
    const p = M.parseColor(canvasBg) || [18, 18, 20, 1];
    const lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
    const ink = lum < 0.5 ? "255,255,255" : "40,30,20";
    root.style.setProperty("--sk-dot", `rgba(${ink},${lum < 0.5 ? 0.15 : 0.2})`);
    root.style.setProperty("--sk-rule", `rgba(${ink},${lum < 0.5 ? 0.07 : 0.085})`);
    root.style.setProperty("--sk-rule-strong", `rgba(${ink},${lum < 0.5 ? 0.12 : 0.14})`);
    root.style.setProperty("--sk-margin", lum < 0.5 ? "rgba(240,110,110,0.22)" : "rgba(220,80,80,0.28)");
    root.classList.toggle("is-lowlum", lum < 0.5);
    paintGrid();
  }
  const themeObserver = new MutationObserver(() => {
    readTheme();
    dirtyMap = true;
    invalidate();
    schedulePanel();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });

  /* ── view ─────────────────────────────────────────────────────────────── */
  const toWorldX = (sx) => (sx - view.x) / view.k;
  const toWorldY = (sy) => (sy - view.y) / view.k;
  const toScreenX = (wx) => wx * view.k + view.x;
  const toScreenY = (wy) => wy * view.k + view.y;

  function setView(x, y, k) {
    view.k = clamp(k, MIN_K, MAX_K);
    view.x = x;
    view.y = y;
    if (path) {
      // one record per drawing, updated in place while panning
      let v = lastViews.get(path);
      if (!v) lastViews.set(path, (v = { x: 0, y: 0, k: 1 }));
      v.x = view.x;
      v.y = view.y;
      v.k = view.k;
    }
    viewChanged();
  }

  function viewChanged() {
    zoomLabel.textContent = Math.round(view.k * 100) + "%";
    ptr.wx = toWorldX(ptr.sx);
    ptr.wy = toWorldY(ptr.sy);
    paintGrid();
    dirtyStatic = true;
    dirtyOver = true;
    dirtyMapView = true;
    if (editing) placeEditor();
    if (measure) measure.viewChanged();
    schedule();
  }

  function zoomAt(k, sx, sy) {
    const nk = clamp(k, MIN_K, MAX_K);
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    setView(sx - wx * nk, sy - wy * nk, nk);
  }
  const zoomBy = (f) => zoomAt(view.k * f, W / 2, H / 2);
  const zoomTo = (k) => zoomAt(k, W / 2, H / 2);

  /** Fit a world box into the viewport, never past `maxK`. */
  function fitBox(b, maxK = 1, pad = 72) {
    if (!b || !W || !H) return;
    const top = 56; // the toolbar
    const bw = Math.max(1, b[2] - b[0]);
    const bh = Math.max(1, b[3] - b[1]);
    const k = clamp(Math.min((W - pad * 2) / bw, (H - top - pad * 2) / bh, maxK), MIN_K, MAX_K);
    setView(W / 2 - ((b[0] + b[2]) / 2) * k, top / 2 + H / 2 - ((b[1] + b[3]) / 2) * k, k);
  }
  const visible = () => els.filter((e) => !e.isDeleted);
  function fitAll() {
    const b = M.commonBounds(visible());
    if (b) fitBox(b, 1);
    else setView(W / 2, H / 2, 1);
  }
  function fitSelection() {
    const list = selectedEls();
    if (list.length) fitBox(M.commonBounds(list), 4);
    else fitAll();
  }

  // the canvas pattern is CSS on the root: free to pan, nothing to redraw
  let paperUrl = null;
  function paperTexture() {
    if (paperUrl) return paperUrl;
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    const x = c.getContext("2d");
    const img = x.createImageData(160, 160);
    const rand = B.rng(1234567);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = rand();
      const v = n < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.round(Math.abs(n - 0.5) * 34);
    }
    x.putImageData(img, 0, 0);
    // soft fibres
    x.globalAlpha = 0.05;
    for (let i = 0; i < 40; i++) {
      x.strokeStyle = rand() < 0.5 ? "#000" : "#fff";
      x.beginPath();
      const px = rand() * 160;
      const py = rand() * 160;
      x.moveTo(px, py);
      x.quadraticCurveTo(px + rand() * 30 - 15, py + rand() * 30 - 15, px + rand() * 50 - 25, py + rand() * 50 - 25);
      x.stroke();
    }
    paperUrl = `url(${c.toDataURL("image/png")})`;
    return paperUrl;
  }

  function paintGrid() {
    const cv = M.canvasOf(scene.appState);
    let pattern = cv.pattern;
    if (pattern === "plain" && gridOn) pattern = "dots";
    const s = root.style;
    if (pattern === "plain") { s.backgroundImage = "none"; return; }
    if (pattern === "paper") {
      s.backgroundImage = paperTexture();
      s.backgroundSize = "160px 160px";
      s.backgroundPosition = `${view.x}px ${view.y}px`;
      s.backgroundRepeat = "repeat";
      return;
    }
    const base = (gridOn ? M.gridSizeOf(scene.appState) : 20) * (pattern === "lined" ? 1.5 : 1) * cv.density;
    let step = base * view.k;
    while (step < (pattern === "dots" ? 12 : 9)) step *= 5;
    const ox = view.x;
    const oy = view.y;
    if (pattern === "dots") {
      const r = step > 40 ? 1.3 : 1;
      s.backgroundImage = `radial-gradient(circle, var(--sk-dot) ${r}px, transparent ${r + 0.4}px)`;
      s.backgroundSize = `${step}px ${step}px`;
      s.backgroundPosition = `${ox - step / 2}px ${oy - step / 2}px`;
    } else if (pattern === "grid") {
      // a fine grid with every fifth line stronger
      const big = step * 5;
      s.backgroundImage = "linear-gradient(var(--sk-rule-strong) 1px, transparent 1px), linear-gradient(90deg, var(--sk-rule-strong) 1px, transparent 1px), linear-gradient(var(--sk-rule) 1px, transparent 1px), linear-gradient(90deg, var(--sk-rule) 1px, transparent 1px)";
      s.backgroundSize = `${big}px ${big}px, ${big}px ${big}px, ${step}px ${step}px, ${step}px ${step}px`;
      s.backgroundPosition = `${ox}px ${oy}px, ${ox}px ${oy}px, ${ox}px ${oy}px, ${ox}px ${oy}px`;
    } else {
      // ruled paper with a margin line at world x = -60
      const mx = view.x - 60 * view.k;
      s.backgroundImage = `linear-gradient(90deg, transparent ${mx - 1}px, var(--sk-margin) ${mx - 1}px, var(--sk-margin) ${mx + 1}px, transparent ${mx + 1}px), linear-gradient(var(--sk-rule-strong) 1px, transparent 1px)`;
      s.backgroundSize = `100% 100%, 100% ${step}px`;
      s.backgroundPosition = `0 0, 0 ${oy}px`;
      s.backgroundRepeat = "no-repeat, repeat";
      return;
    }
    s.backgroundRepeat = "repeat";
  }

  function resize() {
    // where the canvas is on screen, also when only that moved (the sidebar opened): the brush ring follows the pointer
    updateRect();
    const r = root.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width));
    const nh = Math.max(1, Math.round(r.height));
    const nd = window.devicePixelRatio || 1;
    if (nw === W && nh === H && nd === dpr) return;
    W = nw;
    H = nh;
    dpr = nd;
    for (const c of [cStatic, cOver]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = W + "px";
      c.style.height = H + "px";
    }
    mapCanvas.width = Math.round(196 * dpr);
    mapCanvas.height = Math.round(128 * dpr);
    dirtyStatic = true;
    dirtyOver = true;
    dirtyMap = true;
    schedule();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(root);

  /* ── images ───────────────────────────────────────────────────────────── */
  function getImage(fileId) {
    if (!fileId) return null;
    let rec = images.get(fileId);
    if (!rec) {
      const f = files[fileId];
      // only a picture the drawing carries: an address in a shared file would be fetched just by opening it
      if (!f || !/^data:image\//i.test(f.dataURL)) return null;
      rec = { img: new Image(), ok: false };
      rec.img.onload = () => {
        rec.ok = true;
        if (!destroyed) { dirtyMap = true; invalidate(); }
      };
      rec.img.src = f.dataURL;
      images.set(fileId, rec);
    }
    return rec.ok ? rec.img : null;
  }

  /* ── rendering ────────────────────────────────────────────────────────── */
  const frames = new Map();
  function refreshFrames() {
    frames.clear();
    for (const e of els) if (!e.isDeleted && (e.type === "frame" || e.type === "magicframe")) frames.set(e.id, e);
  }
  const drawOpts = { dark: true, zoom: 1, canvasBg: "#000", getImage, frames, viewport: null, skip: null, lod: true, alpha: 1, containerOf: (id) => byId.get(id) };
  // kept dimensions are the measuring overlay's to draw while it is up
  // a dimension line never follows a shape: one bound in an earlier build is cut loose here, so it cannot collapse onto the shape's edge
  const refreshArrow = (a, by) => { if (a.customData && a.customData.leoDim) { a.startBinding = null; a.endBinding = null; return; } M.refreshArrow(a, by); };
  const dimOfOverlay = (e) => !!measure && measure.drawsDims() && (measure.isDim(e) || (e.type === "text" && e.containerId && measure.isDim(byId.get(e.containerId))));
  const skipLive = (e) => liveIds.has(e.id) || erasing.has(e.id) || (editing && editing.el === e) || dimOfOverlay(e);

  function invalidate(staticToo = true) {
    if (staticToo) dirtyStatic = true;
    dirtyOver = true;
    schedule();
  }
  function schedule() {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (destroyed || !W) return;
    if (gesture) {
      // work only when the pointer (or a modifier) changed since last frame
      if (gesture.frame && ptr.moved) { ptr.moved = false; gesture.frame(); }
      dirtyOver = true;
    } else {
      if (draft && ptr.moved) { ptr.moved = false; moveLastPoint(draft.el); }
      if (needHover) updateHover();
    }
    if (dirtyStatic) renderStatic();
    if (dirtyOver) renderOverlay();
    if (mapOn && (dirtyMap || dirtyMapView)) renderMap();
    // the laser fades by itself
    if (laser.length || eraserTrail.length) { dirtyOver = true; schedule(); }
  }

  function setViewport() {
    viewport[0] = toWorldX(0);
    viewport[1] = toWorldY(0);
    viewport[2] = toWorldX(W);
    viewport[3] = toWorldY(H);
  }

  function renderStatic() {
    // a slow scene pans as a moved bitmap and catches up a few times a second
    const panning = gesture && (gesture.type === "pan" || gesture.type === "pinch") || wheelActive;
    const t = performance.now();
    if (panning && lastStaticMs > 12 && t - fullRenderAt < 180 && staticView.k > 0) {
      const s = view.k / staticView.k;
      cStatic.style.transform = `translate(${view.x - staticView.x * s}px, ${view.y - staticView.y * s}px) scale(${s})`;
      dirtyStatic = true;
      schedule();
      return;
    }
    dirtyStatic = false;
    cStatic.style.transform = "";
    staticView.x = view.x;
    staticView.y = view.y;
    staticView.k = view.k;
    fullRenderAt = t;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cStatic.width, cStatic.height);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    setViewport();
    drawOpts.dark = dark;
    drawOpts.zoom = view.k;
    drawOpts.canvasBg = canvasBg;
    drawOpts.viewport = viewport;
    drawOpts.skip = skipLive;
    drawOpts.alpha = 1;
    R.drawElements(ctx, els, drawOpts);
    lastStaticMs = performance.now() - t;
    empty.hidden = readOnly || els.some((e) => !e.isDeleted) || !!gesture;
  }

  /* ── selection geometry ───────────────────────────────────────────────── */
  const selectedEls = () => {
    const out = [];
    for (const e of els) if (selected.has(e.id) && !e.isDeleted) out.push(e);
    return out;
  };

  /** The box the handles hang off: the element's own (rotated) box, or the selection's. */
  function selectionFrame() {
    if (editing || readOnly || tool === "laser") return null;
    let list = selectedEls();
    if (!list.length) return null;
    // a line with its label: the line's own two dots, never a box that would scale the pair
    if (list.length === 2) { const line = list.find((e) => isLinear(e) && e.points.length === 2); const label = list.find((e) => e.type === "text" && line && e.containerId === line.id); if (line && label) list = [line]; }
    if (list.length === 1) {
      const e = list[0];
      if (isLinear(e) && (e.points.length === 2 || (pointEdit && pointEdit.id === e.id))) return { el: e, points: true, single: true, locked: e.locked };
      const r = M.elementRect(e);
      const [cx, cy] = M.elementCenter(e);
      return { el: e, x1: r[0], y1: r[1], x2: r[2], y2: r[3], cx, cy, angle: e.angle || 0, single: true, locked: e.locked, text: e.type === "text" };
    }
    const b = M.commonBounds(list);
    const hasText = list.some((e) => e.type === "text" || (e.boundElements && e.boundElements.some((x) => x.type === "text")));
    return { el: null, x1: b[0], y1: b[1], x2: b[2], y2: b[3], cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, angle: 0, single: false, locked: list.every((e) => e.locked), text: hasText, list };
  }

  function frameCorner(f, u, v) {
    // u, v in -1..1 across the padded box; returns screen coords
    const pad = 5 / view.k;
    const hw = (f.x2 - f.x1) / 2 + pad;
    const hh = (f.y2 - f.y1) / 2 + pad;
    const [x, y] = M.rotatePoint(f.cx + u * hw, f.cy + v * hh, f.cx, f.cy, f.angle);
    return [toScreenX(x), toScreenY(y)];
  }

  function handlesOf(f) {
    if (!f || f.points || f.locked) return [];
    const [ax, ay] = frameCorner(f, -1, -1);
    const [bx, by] = frameCorner(f, 1, 1);
    const [cx2, cy2] = frameCorner(f, 1, -1);
    const sw = Math.hypot(cx2 - ax, cy2 - ay);
    const sh = Math.hypot(bx - cx2, by - cy2);
    const out = [];
    const add = (name, u, v) => { const [x, y] = frameCorner(f, u, v); out.push({ name, x, y }); };
    add("nw", -1, -1); add("ne", 1, -1); add("se", 1, 1); add("sw", -1, 1);
    const sides = !(f.single && f.text);
    if (sides && sw > 34) { add("n", 0, -1); add("s", 0, 1); }
    if (sides && sh > 34) { add("e", 1, 0); add("w", -1, 0); }
    const frameOnly = f.single && (f.el.type === "frame" || f.el.type === "magicframe");
    if (!frameOnly && !(f.list && f.list.some((e) => e.type === "frame"))) {
      const [tx, ty] = frameCorner(f, 0, -1);
      const up = M.rotatePoint(0, -ROTATE_GAP, 0, 0, f.angle);
      out.push({ name: "rotate", x: tx + up[0], y: ty + up[1] });
    }
    return out;
  }

  function hitHandle(sx, sy) {
    const f = selectionFrame();
    if (!f) return null;
    const slop = ptr.type === "touch" ? 16 : 11;
    if (f.points) {
      const e = f.el;
      const abs = M.absolutePoints(e);
      for (let i = abs.length - 1; i >= 0; i--) {
        if (Math.hypot(toScreenX(abs[i][0]) - sx, toScreenY(abs[i][1]) - sy) <= slop) return { kind: "point", el: e, index: i };
      }
      if (pointEdit && pointEdit.id === e.id) {
        for (let i = 0; i + 1 < abs.length; i++) {
          const mx = toScreenX((abs[i][0] + abs[i + 1][0]) / 2);
          const my = toScreenY((abs[i][1] + abs[i + 1][1]) / 2);
          if (Math.hypot(mx - sx, my - sy) <= slop) return { kind: "mid", el: e, index: i + 1 };
        }
      }
      return null;
    }
    // the nearest handle wins, so crowded corners still pick the right one
    let best = null;
    let bestD = Infinity;
    for (const hd of handlesOf(f)) {
      const d = Math.hypot(hd.x - sx, hd.y - sy);
      if (d <= slop + (hd.name === "rotate" ? 3 : 0) && d < bestD) { best = hd; bestD = d; }
    }
    if (best) return { kind: best.name === "rotate" ? "rotate" : "resize", handle: best.name, frame: f };
    // a little way outside the box: by a corner it turns the selection, by a side it slants it
    const hs = handlesOf(f);
    if (!hs.length) return null;
    const [lx, ly] = M.rotatePoint(toWorldX(sx), toWorldY(sy), f.cx, f.cy, -f.angle);
    const pad = 5 / view.k;
    if (lx >= f.x1 - pad && lx <= f.x2 + pad && ly >= f.y1 - pad && ly <= f.y2 + pad) return null;
    const canTurn = hs.some((x) => x.name === "rotate");
    const canSlant = (f.single ? hasPoints(f.el) : f.list.some((x) => hasPoints(x))) && !f.text;
    for (const hd of hs) {
      if (hd.name === "rotate") continue;
      const corner = hd.name.length === 2;
      if (corner ? !canTurn : !canSlant) continue;
      const d = Math.hypot(hd.x - sx, hd.y - sy);
      if (d <= slop + (corner ? 22 : 18) && d < bestD) { best = hd; bestD = d; }
    }
    return best ? { kind: best.name.length === 2 ? "rotate" : "skew", handle: best.name, frame: f } : null;
  }

  function cursorFor(handle, angle) {
    const steps = Math.round((angle || 0) / (Math.PI / 4));
    const i = ((((HANDLE_ANGLE[handle] + steps) % 8) + 8) % 8) % 4;
    return CURSORS[i];
  }

  /* ── overlay ──────────────────────────────────────────────────────────── */
  function outlinePath(c, e, pad) {
    c.beginPath();
    const [cx, cy] = M.elementCenter(e);
    const a = e.angle || 0;
    if (hasPoints(e)) {
      const g = M.linearGeometry(e);
      const f = g.flat;
      for (let i = 0; i < f.length; i += 2) {
        const [x, y] = M.rotatePoint(e.x + f[i], e.y + f[i + 1], cx, cy, a);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      return;
    }
    const hw = e.width / 2 + pad;
    const hh = e.height / 2 + pad;
    if (e.type === "ellipse") {
      c.ellipse(cx, cy, Math.max(0.5, hw), Math.max(0.5, hh), a, 0, Math.PI * 2);
      return;
    }
    const pts = e.type === "diamond" ? [[0, -hh], [hw, 0], [0, hh], [-hw, 0]] : [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    pts.forEach((p, i) => {
      const [x, y] = M.rotatePoint(cx + p[0], cy + p[1], cx, cy, a);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    c.closePath();
  }

  function renderOverlay() {
    dirtyOver = false;
    const c = octx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cOver.width, cOver.height);
    c.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    drawOpts.dark = dark;
    drawOpts.zoom = view.k;
    drawOpts.canvasBg = canvasBg;
    drawOpts.lod = false;
    if (liveIds.size || erasing.size) {
      for (const e of els) {
        if (e.isDeleted || (editing && editing.el === e)) continue;
        if (cutPieces.has(e.id)) continue;
        if (liveIds.has(e.id)) {
          drawOpts.alpha = erasing.has(e.id) ? 0.22 : 1;
          R.drawElement(c, e, drawOpts);
        } else if (erasing.has(e.id)) {
          drawOpts.alpha = 0.22;
          R.drawElement(c, e, drawOpts);
        }
      }
    }
    drawOpts.alpha = 1;
    if (gesture && gesture.draw) gesture.draw(c);
    drawOpts.lod = true;
    const k = view.k;
    // shape an arrow is about to attach to
    if (bindTarget && !bindTarget.isDeleted) {
      c.save();
      c.globalAlpha = 0.28;
      c.strokeStyle = accent;
      c.lineWidth = 7 / k;
      c.lineJoin = "round";
      outlinePath(c, bindTarget, Math.min(M.maxBindingGap(bindTarget), 12) / 2);
      c.stroke();
      c.restore();
    }
    // hover: a soft halo, so it is clear what a click will take
    if (hover && !hover.isDeleted && !selected.has(hover.id) && !gesture && (tool === "select" || tool === "eraser" || tool === "picker")) {
      c.save();
      c.lineJoin = "round";
      c.lineCap = "round";
      c.strokeStyle = tool === "eraser" ? (dark ? "#ff8a8a" : "#e5484d") : accent;
      const thick = hasPoints(hover) ? Math.max(hover.strokeWidth * (hover.type === "freedraw" ? 2.4 : 1), 1) : 0;
      outlinePath(c, hover, hasPoints(hover) ? 0 : 4 / k);
      c.globalAlpha = dark ? 0.2 : 0.26;
      c.lineWidth = thick + 10 / k;
      c.stroke();
      c.globalAlpha = 0.75;
      c.lineWidth = hasPoints(hover) ? Math.max(1.2 / k, thick * 0.2) : 1.3 / k;
      if (!hasPoints(hover)) c.stroke();
      c.restore();
    }
    // search hits
    if (found.length) {
      c.save();
      c.strokeStyle = accent;
      c.lineJoin = "round";
      for (let i = 0; i < found.length; i++) {
        const e = byId.get(found[i]);
        if (!e || e.isDeleted) continue;
        c.globalAlpha = i === foundAt ? 0.9 : 0.35;
        c.lineWidth = (i === foundAt ? 2.5 : 1.5) / k;
        outlinePath(c, e, 6 / k);
        c.stroke();
      }
      c.restore();
    }
    // the piece's box: marching ants over the picture
    if (marq) {
      c.save();
      c.lineWidth = 1.2 / k;
      c.strokeStyle = "#ffffff";
      c.strokeRect(marq[0], marq[1], marq[2] - marq[0], marq[3] - marq[1]);
      c.strokeStyle = "#000000";
      c.setLineDash([5 / k, 5 / k]);
      c.lineDashOffset = -((performance.now() / 60) % 10) / k;
      c.strokeRect(marq[0], marq[1], marq[2] - marq[0], marq[3] - marq[1]);
      c.restore();
    }
    // the lasso being drawn
    if (lasso && lasso.length > 3) {
      c.save();
      c.beginPath();
      c.moveTo(lasso[0], lasso[1]);
      for (let i = 2; i < lasso.length; i += 2) c.lineTo(lasso[i], lasso[i + 1]);
      c.closePath();
      c.fillStyle = accent;
      c.globalAlpha = 0.07;
      c.fill();
      c.globalAlpha = 0.85;
      c.strokeStyle = accent;
      c.lineWidth = 1.2 / k;
      c.setLineDash([5 / k, 4 / k]);
      c.stroke();
      c.restore();
    }
    // members of a multi-selection get a thin outline each
    const f = gesture && gesture.hideHandles ? null : selectionFrame();
    if (f && !f.single) {
      c.save();
      c.strokeStyle = accent;
      c.globalAlpha = 0.6;
      c.lineWidth = 1 / k;
      for (const e of f.list) {
        if (e.type === "text" && e.containerId) continue;
        outlinePath(c, e, hasPoints(e) ? 0 : 2 / k);
        c.stroke();
      }
      c.restore();
    }
    // everything below is in screen pixels
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (f) drawSelection(c, f);
    if (guides.length) {
      c.save();
      c.strokeStyle = "#ff6b8b";
      c.lineWidth = 1;
      c.setLineDash([4, 3]);
      c.beginPath();
      for (const g of guides) {
        c.moveTo(Math.round(toScreenX(g.x1)) + 0.5, Math.round(toScreenY(g.y1)) + 0.5);
        c.lineTo(Math.round(toScreenX(g.x2)) + 0.5, Math.round(toScreenY(g.y2)) + 0.5);
      }
      c.stroke();
      c.restore();
    }
    if (box) {
      const x = toScreenX(Math.min(box[0], box[2]));
      const y = toScreenY(Math.min(box[1], box[3]));
      const w = Math.abs(box[2] - box[0]) * k;
      const hh = Math.abs(box[3] - box[1]) * k;
      c.save();
      c.fillStyle = accent;
      c.globalAlpha = 0.08;
      c.fillRect(x, y, w, hh);
      c.globalAlpha = 0.7;
      c.strokeStyle = accent;
      c.lineWidth = 1;
      c.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(hh));
      c.restore();
    }
    drawLinks(c);
    drawLaser(c);
    drawEraser(c);
    drawPenCursor(c);
    if (measure) measure.drawScreen(c);
    placeCtx();
  }

  function drawSelection(c, f) {
    c.save();
    c.strokeStyle = accent;
    c.lineWidth = 1.25;
    if (f.points) {
      const e = f.el;
      const abs = M.absolutePoints(e);
      const editingPts = pointEdit && pointEdit.id === e.id;
      if (editingPts) {
        c.globalAlpha = 0.5;
        c.fillStyle = canvasBg;
        for (let i = 0; i + 1 < abs.length; i++) {
          c.beginPath();
          c.arc(toScreenX((abs[i][0] + abs[i + 1][0]) / 2), toScreenY((abs[i][1] + abs[i + 1][1]) / 2), 3.5, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        }
        c.globalAlpha = 1;
      }
      abs.forEach((p, i) => {
        const on = editingPts && pointEdit.sel.has(i);
        c.beginPath();
        c.arc(toScreenX(p[0]), toScreenY(p[1]), on ? 5.5 : 5, 0, Math.PI * 2);
        c.fillStyle = on ? accent : canvasBg;
        c.fill();
        c.stroke();
      });
      c.restore();
      return;
    }
    const corners = [frameCorner(f, -1, -1), frameCorner(f, 1, -1), frameCorner(f, 1, 1), frameCorner(f, -1, 1)];
    const grouped = !f.single && f.list && isOneGroup(f.list);
    if (grouped || f.locked) c.setLineDash([5, 4]);
    c.beginPath();
    corners.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    c.closePath();
    c.stroke();
    c.setLineDash([]);
    const hs = handlesOf(f);
    for (const hd of hs) {
      c.beginPath();
      if (hd.name === "rotate") {
        c.arc(hd.x, hd.y, 6, 0, Math.PI * 2);
      } else {
        const s = HANDLE;
        c.save();
        c.translate(hd.x, hd.y);
        c.rotate(f.angle);
        c.roundRect(-s / 2, -s / 2, s, s, 2);
        c.restore();
      }
      c.fillStyle = hd.name === "rotate" ? accent : canvasBg;
      c.fill();
      c.stroke();
    }
    if (f.locked) {
      const [x, y] = corners[1];
      c.fillStyle = accent;
      c.font = '600 10px "Inter Variable", sans-serif';
      c.fillText("Locked", x + 6, y + 4);
    }
    c.restore();
  }

  // a small chip at an element's corner opens its link
  const linkChips = [];
  function drawLinks(c) {
    linkChips.length = 0;
    if (view.k < 0.25 || gesture) return;
    for (const e of els) {
      if (e.isDeleted || !e.link || M.isNoteCard(e)) continue;
      const b = R.boundsOf(e);
      if (b[2] < viewport[0] || b[0] > viewport[2] || b[3] < viewport[1] || b[1] > viewport[3]) continue;
      const r = M.elementBounds(e);
      const x = toScreenX(r[2]) + 4;
      const y = toScreenY(r[1]) - 22;
      linkChips.push({ x, y, w: 18, h: 18, el: e });
      c.save();
      c.fillStyle = dark ? "#2a2a30" : "#ffffff";
      c.strokeStyle = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.14)";
      c.beginPath();
      c.roundRect(x, y, 18, 18, 5);
      c.fill();
      c.stroke();
      c.strokeStyle = accent;
      c.lineWidth = 1.4;
      c.lineCap = "round";
      c.translate(x + 3, y + 3);
      c.scale(0.5, 0.5);
      c.stroke(new Path2D("M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"));
      c.restore();
    }
  }

  function drawLaser(c) {
    const t = performance.now();
    if (laser.length) {
      laser = laser.filter((s) => s.active || t - s.pts[s.pts.length - 1].t < LASER_MS);
      c.save();
      c.lineCap = "round";
      c.lineJoin = "round";
      c.shadowColor = "rgba(255, 60, 60, 0.9)";
      c.shadowBlur = 10;
      c.strokeStyle = "#ff4545";
      for (const s of laser) {
        const pts = s.pts;
        for (let i = 1; i < pts.length; i++) {
          const age = (t - pts[i].t) / LASER_MS;
          if (age >= 1) continue;
          // eases out, so the tail lingers and then melts away
          const a = 1 - age * age * (3 - 2 * age);
          c.globalAlpha = a;
          c.lineWidth = 1.5 + 3.5 * a;
          c.beginPath();
          c.moveTo(toScreenX(pts[i - 1].x), toScreenY(pts[i - 1].y));
          c.lineTo(toScreenX(pts[i].x), toScreenY(pts[i].y));
          c.stroke();
        }
      }
      c.restore();
    }
    // the laser dot is the pointer
    if (tool === "laser" && ptr.inside && !spaceDown) {
      c.save();
      c.shadowColor = "rgba(255, 50, 50, 0.95)";
      c.shadowBlur = ptr.down ? 16 : 11;
      c.fillStyle = "#ff4545";
      c.beginPath();
      c.arc(ptr.sx, ptr.sy, ptr.down ? 5 : 4.2, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      c.fillStyle = "#ffd9d9";
      c.beginPath();
      c.arc(ptr.sx, ptr.sy, 1.6, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  function drawEraser(c) {
    if (!eraserTrail.length) return;
    const t = performance.now();
    eraserTrail = eraserTrail.filter((p) => t - p.t < 260);
    if (eraserTrail.length < 2) return;
    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = dark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.25)";
    for (let i = 1; i < eraserTrail.length; i++) {
      const a = 1 - (t - eraserTrail[i].t) / 260;
      c.lineWidth = 2 + 6 * a;
      c.beginPath();
      c.moveTo(eraserTrail[i - 1].x, eraserTrail[i - 1].y);
      c.lineTo(eraserTrail[i].x, eraserTrail[i].y);
      c.stroke();
    }
    c.restore();
  }

  function drawPenCursor(c) {
    if (!ptr.inside || ptr.type === "touch" || spaceDown || rightDown) return;
    if (tool === "picker") {
      const col = sampleColor(ptr.wx, ptr.wy);
      c.save();
      c.lineWidth = 5;
      c.strokeStyle = col ? M.themeColor(col, dark) : "transparent";
      c.beginPath();
      c.arc(ptr.sx + 14, ptr.sy - 14, 9, 0, Math.PI * 2);
      c.fillStyle = col ? M.themeColor(col, dark) : canvasBg;
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = dark ? "#fff" : "#222";
      c.stroke();
      c.restore();
      return;
    }
    if (tool !== "freedraw" && tool !== "eraser") return;
    c.save();
    if (tool === "eraser") {
      const r = eraseMode === "cut" ? Math.max(4, eraseSize / 2 * view.k) : 7;
      c.strokeStyle = dark ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.6)";
      c.fillStyle = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
      c.lineWidth = 1;
      c.beginPath();
      c.arc(ptr.sx, ptr.sy, r, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      if (eraseMode === "cut") {
        c.setLineDash([2, 2]);
        c.beginPath();
        c.moveTo(ptr.sx - 3, ptr.sy);
        c.lineTo(ptr.sx + 3, ptr.sy);
        c.stroke();
      }
      c.restore();
      return;
    }
    // the dot previews the brush's width, and its pressure while a pen touches
    const p = ptr.type === "pen" && ptr.down ? ptr.pressure : 0.5;
    const size = penWidth() * currentBrush().size;
    const r = Math.max(1.5, size * Math.sin(((0.5 - 0.6 * (0.5 - p)) * Math.PI) / 2) * 0.5 * view.k);
    const color = M.themeColor(style.strokeColor, dark);
    c.fillStyle = color;
    c.globalAlpha = (ptr.down ? 0.9 : 0.75) * Math.max(0.35, currentBrush().opacity);
    c.beginPath();
    c.arc(ptr.sx, ptr.sy, r, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 0.5;
    c.strokeStyle = dark ? "#000" : "#fff";
    c.lineWidth = 1;
    c.stroke();
    c.restore();
  }

  /* ── minimap ──────────────────────────────────────────────────────────── */
  const mapT = { s: 1, ox: 0, oy: 0 };
  function renderMap() {
    dirtyMap = false;
    dirtyMapView = false;
    const mw = 196;
    const mh = 128;
    const c = mapCanvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, mw, mh);
    setViewport();
    let b = null;
    for (const e of els) {
      if (e.isDeleted) continue;
      const r = R.boundsOf(e);
      if (!b) b = [r[0], r[1], r[2], r[3]];
      else { b[0] = Math.min(b[0], r[0]); b[1] = Math.min(b[1], r[1]); b[2] = Math.max(b[2], r[2]); b[3] = Math.max(b[3], r[3]); }
    }
    const vb = [viewport[0], viewport[1], viewport[2], viewport[3]];
    const u = b ? [Math.min(b[0], vb[0]), Math.min(b[1], vb[1]), Math.max(b[2], vb[2]), Math.max(b[3], vb[3])] : vb;
    const pad = 10;
    const s = Math.min((mw - pad * 2) / Math.max(1, u[2] - u[0]), (mh - pad * 2) / Math.max(1, u[3] - u[1]));
    mapT.s = s;
    mapT.ox = pad + (mw - pad * 2 - (u[2] - u[0]) * s) / 2 - u[0] * s;
    mapT.oy = pad + (mh - pad * 2 - (u[3] - u[1]) * s) / 2 - u[1] * s;
    c.globalAlpha = 0.75;
    for (const e of els) {
      if (e.isDeleted || (e.type === "text" && e.containerId)) continue;
      const r = R.boundsOf(e);
      const filled = M.hasFill(e);
      c.fillStyle = M.themeColor(filled ? e.backgroundColor : e.type === "image" ? "#868e96" : e.strokeColor, dark);
      const x = r[0] * s + mapT.ox;
      const y = r[1] * s + mapT.oy;
      const w = Math.max(1, (r[2] - r[0]) * s);
      const hh = Math.max(1, (r[3] - r[1]) * s);
      if (filled || e.type === "image") c.fillRect(x, y, w, hh);
      else if (e.type === "text") {
        c.globalAlpha = 0.3;
        c.fillRect(x, y, w, hh);
        c.globalAlpha = 0.75;
      } else {
        c.globalAlpha = 0.45;
        c.fillRect(x, y, w, hh);
        c.globalAlpha = 0.75;
      }
    }
    c.globalAlpha = 1;
    const x = vb[0] * s + mapT.ox;
    const y = vb[1] * s + mapT.oy;
    c.fillStyle = accent;
    c.globalAlpha = 0.1;
    c.fillRect(x, y, (vb[2] - vb[0]) * s, (vb[3] - vb[1]) * s);
    c.globalAlpha = 0.9;
    c.strokeStyle = accent;
    c.lineWidth = 1.2;
    c.strokeRect(x, y, (vb[2] - vb[0]) * s, (vb[3] - vb[1]) * s);
  }

  function mapNavigate(e) {
    const r = mapCanvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - mapT.ox) / mapT.s;
    const wy = (e.clientY - r.top - mapT.oy) / mapT.s;
    setView(W / 2 - wx * view.k, H / 2 - wy * view.k, view.k);
  }
  mapCanvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    mapCanvas.setPointerCapture(e.pointerId);
    mapNavigate(e);
    const move = (ev) => mapNavigate(ev);
    const up = () => {
      mapCanvas.removeEventListener("pointermove", move);
      mapCanvas.removeEventListener("pointerup", up);
      mapCanvas.removeEventListener("pointercancel", up);
      root.focus({ preventScroll: true });
    };
    mapCanvas.addEventListener("pointermove", move);
    mapCanvas.addEventListener("pointerup", up);
    mapCanvas.addEventListener("pointercancel", up);
  });

  function toggleMap(on = !mapOn) {
    mapOn = on;
    mapBox.hidden = !on;
    mapBtn.classList.toggle("is-on", on);
    saveSetting("sketchMinimap", on);
    dirtyMap = true;
    schedule();
  }

  /* ── history ──────────────────────────────────────────────────────────── */
  const IGNORE = new Set(["version", "versionNonce", "updated"]);
  function sameSnap(a, b) {
    for (const k in a) if (!IGNORE.has(k) && a[k] !== b[k]) return false;
    for (const k in b) if (!IGNORE.has(k) && !(k in a)) return false;
    return true;
  }

  function snap(list) {
    const m = new Map();
    for (const x of list) {
      const e = typeof x === "string" ? byId.get(x) : x;
      if (e && !m.has(e.id)) m.set(e.id, M.snapshot(e));
    }
    return m;
  }

  /** Record what changed since `before` as one undo step. */
  function commit(before, { key = null, order = null, selBefore = null, extra = null } = {}) {
    if (readOnly) return false;
    if (extra) for (const [id, s] of extra) if (!before.has(id)) before.set(id, s);
    if (measure) measure.syncDimensions(before);
    const after = new Map();
    let same = true;
    for (const [id, s] of before) {
      const e = byId.get(id);
      if (!e) continue;
      const a = M.snapshot(e);
      after.set(id, a);
      if (same && !sameSnap(s, a)) same = false;
    }
    if (same && !order) return false;
    history.push({ key, before, after, order, selBefore: selBefore || [...selected], selAfter: [...selected] });
    markChanged();
    return true;
  }

  function markChanged() {
    if (readOnly) return;
    changes++;
    dirtyMap = true;
    if (outlineOpen) outlineDirty = true;
    paintUndo();
    notify();
  }

  function paintUndo() {
    undoBtn.disabled = !history.undo.length;
    redoBtn.disabled = !history.redo.length;
  }

  function reorder(ids) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    els.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
  }

  function applyEntry(entry, undoing) {
    const snaps = undoing ? entry.before : entry.after;
    for (const [id, s] of snaps) {
      let e = byId.get(id);
      if (!e) {
        e = { ...s };
        els.push(e);
        byId.set(id, e);
      }
      M.restoreInto(e, s);
      R.forget(e);
    }
    if (entry.order) reorder(undoing ? entry.order.before : entry.order.after);
    selected.clear();
    for (const id of (undoing ? entry.selBefore : entry.selAfter) || []) {
      const e = byId.get(id);
      if (e && !e.isDeleted) selected.add(id);
    }
    pointEdit = null;
    refreshFrames();
    markChanged();
    invalidate();
    schedulePanel();
  }

  function doUndo() {
    if (editing) finishText();
    if (draft) finishDraft();
    const e = history.takeUndo();
    if (e) applyEntry(e, true);
    else toast("Nothing to undo", { ms: 1400 });
    paintUndo();
  }
  function doRedo() {
    if (editing) finishText();
    const e = history.takeRedo();
    if (e) applyEntry(e, false);
    paintUndo();
  }

  /* ── selection helpers ────────────────────────────────────────────────── */
  const boundTextOf = (e) => M.boundTextOf(e, byId);
  const alive = (id) => { const e = byId.get(id); return e && !e.isDeleted ? e : null; };

  function unitOf(e) {
    if (e.type === "text" && e.containerId) {
      const c = alive(e.containerId);
      if (c) e = c;
    }
    const gid = M.selectGroupId(e, editingGroup);
    if (!gid) return [e];
    return els.filter((x) => !x.isDeleted && x.groupIds && x.groupIds.includes(gid) && !(x.type === "text" && x.containerId && alive(x.containerId)));
  }

  function isOneGroup(list) {
    const g = list[0] && list[0].groupIds;
    if (!g || !g.length) return false;
    const top = g[g.length - 1];
    return list.every((e) => e.groupIds && e.groupIds.includes(top));
  }

  function setSelection(ids) {
    selected.clear();
    for (const id of ids) if (alive(id)) selected.add(id);
    if (pointEdit && !selected.has(pointEdit.id)) pointEdit = null;
    invalidate(false);
    schedulePanel();
  }

  /** The list plus bound labels and, for frames, what they hold. */
  function withBound(list) {
    const ids = new Set(list.map((e) => e.id));
    for (const e of list) {
      if (e.type === "frame" || e.type === "magicframe") for (const x of els) if (!x.isDeleted && x.frameId === e.id) ids.add(x.id);
    }
    for (const e of els) {
      if (e.isDeleted || e.type !== "text" || !e.containerId) continue;
      if (ids.has(e.containerId)) ids.add(e.id);
    }
    return els.filter((e) => ids.has(e.id) && !e.isDeleted);
  }

  function arrowsBoundTo(ids) {
    const out = [];
    for (const e of els) {
      if (e.isDeleted || e.type !== "arrow") continue;
      if ((e.startBinding && ids.has(e.startBinding.elementId)) || (e.endBinding && ids.has(e.endBinding.elementId))) out.push(e);
    }
    return out;
  }

  function addElement(e, after) {
    if (after) {
      const i = els.indexOf(after);
      els.splice(i < 0 ? els.length : i + 1, 0, e);
    } else els.push(e);
    byId.set(e.id, e);
    if (e.type === "frame") refreshFrames();
    return e;
  }

  function measureStandalone(t) {
    const m = M.measureText(t.text, t.fontSize, t.lineHeight, (s) => R.measureLine(s, t));
    const dw = m.width - t.width;
    if (t.textAlign === "center") t.x -= dw / 2;
    else if (t.textAlign === "right") t.x -= dw;
    t.width = m.width;
    t.height = m.height;
  }

  /** Re-wrap a container's label after the container changed. */
  function relayout(container) {
    const t = boundTextOf(container);
    if (!t) return;
    const upd = M.layoutBoundText(container, t, R.measureLine);
    if (Object.keys(upd.text).length) M.mutate(t, upd.text);
    if (Object.keys(upd.container).length) {
      M.mutate(container, upd.container);
      if (container.boundElements) refreshArrows(new Set([container.id]));
    }
  }

  /** Re-aim arrows attached to the given shapes (skipping ones being moved themselves). */
  function refreshArrows(ids, skip) {
    for (const a of arrowsBoundTo(ids)) {
      if (skip && skip.has(a.id)) continue;
      if (refreshArrow(a, byId)) {
        R.forget(a);
        if (a.boundElements) relayout(a);
      }
    }
  }

  function bindingIdsOf(list) {
    const ids = new Set();
    for (const e of list) if (e.boundElements && e.boundElements.some((b) => b.type === "arrow")) ids.add(e.id);
    return ids;
  }

  function addBoundRef(target, id, type) {
    const list = target.boundElements ? target.boundElements.filter((b) => b.id !== id) : [];
    list.push({ id, type });
    target.boundElements = list;
    M.bumpVersion(target);
  }
  function dropBoundRef(target, id) {
    if (!target || !target.boundElements) return;
    const list = target.boundElements.filter((b) => b.id !== id);
    target.boundElements = list.length ? list : null;
    M.bumpVersion(target);
  }

  /** Attach or detach one end of an arrow; records affected shapes in `before`. */
  function setBinding(arrow, which, target, before) {
    const key = which === "start" ? "startBinding" : "endBinding";
    const old = arrow[key];
    const other = which === "start" ? arrow.endBinding : arrow.startBinding;
    if (old && (!target || old.elementId !== target.id)) {
      const t = byId.get(old.elementId);
      if (t) {
        if (before && !before.has(t.id)) before.set(t.id, M.snapshot(t));
        // keep the reference if the other end still points at the same shape
        if (!other || other.elementId !== t.id) dropBoundRef(t, arrow.id);
      }
    }
    if (target) {
      if (before && !before.has(target.id)) before.set(target.id, M.snapshot(target));
      arrow[key] = M.calcBinding(arrow, target, which);
      addBoundRef(target, arrow.id, "arrow");
    } else arrow[key] = null;
  }

  /** After an arrow moved on its own: attach its ends to whatever they now touch. */
  function rebindEnds(arrow, before, exclude) {
    if (arrow.type !== "arrow") return;
    for (const which of ["start", "end"]) {
      const [x, y] = M.absolutePoint(arrow, which === "start" ? 0 : -1);
      const ex = new Set(exclude || []);
      ex.add(arrow.id);
      const t = M.bindingCandidate(els, x, y, ex, view.k);
      setBinding(arrow, which, t, before);
    }
    refreshArrow(arrow, byId);
    M.bumpVersion(arrow);
  }

  function assignFrames(list) {
    if (!frames.size) return;
    for (const e of list) {
      if (e.type === "frame" || e.type === "magicframe" || (e.type === "text" && e.containerId)) continue;
      const b = M.elementBounds(e);
      let target = null;
      for (const f of frames.values()) {
        if (f.isDeleted) continue;
        if (b[0] >= f.x && b[1] >= f.y && b[2] <= f.x + f.width && b[3] <= f.y + f.height) target = f;
      }
      const id = target ? target.id : null;
      if ((e.frameId || null) !== id) {
        e.frameId = id;
        M.bumpVersion(e);
        const t = boundTextOf(e);
        if (t) { t.frameId = id; M.bumpVersion(t); }
      }
    }
  }

  /* ── operations ───────────────────────────────────────────────────────── */
  function deleteElements(list) {
    if (!list.length || readOnly) return;
    const targets = withBound(list);
    const ids = new Set(targets.map((e) => e.id));
    const affected = [...targets, ...arrowsBoundTo(ids)];
    for (const e of targets) {
      if (e.containerId) { const c = byId.get(e.containerId); if (c) affected.push(c); }
      for (const k of ["startBinding", "endBinding"]) if (e[k]) { const t = byId.get(e[k].elementId); if (t) affected.push(t); }
    }
    const before = snap(affected);
    for (const e of targets) {
      e.isDeleted = true;
      M.bumpVersion(e);
    }
    for (const a of arrowsBoundTo(ids)) {
      if (ids.has(a.id)) continue;
      if (a.startBinding && ids.has(a.startBinding.elementId)) a.startBinding = null;
      if (a.endBinding && ids.has(a.endBinding.elementId)) a.endBinding = null;
      M.bumpVersion(a);
    }
    for (const e of targets) {
      if (e.containerId && !ids.has(e.containerId)) dropBoundRef(byId.get(e.containerId), e.id);
      for (const k of ["startBinding", "endBinding"]) if (e[k] && !ids.has(e[k].elementId)) dropBoundRef(byId.get(e[k].elementId), e.id);
    }
    for (const id of ids) selected.delete(id);
    if (pointEdit && ids.has(pointEdit.id)) pointEdit = null;
    refreshFrames();
    commit(before);
    invalidate();
    schedulePanel();
  }

  /** Take the frame away and leave what it held where it is. */
  function unframe(frames) {
    if (readOnly) return;
    const kids = els.filter((x) => !x.isDeleted && frames.some((f) => f.id === x.frameId));
    const before = snap([...frames, ...kids]);
    for (const x of kids) { x.frameId = null; M.bumpVersion(x); }
    for (const f of frames) { f.isDeleted = true; selected.delete(f.id); M.bumpVersion(f); }
    refreshFrames();
    commit(before);
    invalidate();
    schedulePanel();
  }

  function deleteSelection() {
    if (pointEdit && pointEdit.sel.size) return deletePoints();
    deleteElements(selectedEls());
  }

  function insertCopies(list, dx, dy, filesIn) {
    const { elements } = M.duplicateElements(list, { dx, dy });
    if (filesIn) for (const id in filesIn) if (!files[id]) files[id] = filesIn[id];
    const before = new Map();
    for (const e of elements) {
      before.set(e.id, { ...e, isDeleted: true });
      addElement(e);
    }
    refreshFrames();
    const tops = elements.filter((e) => !(e.type === "text" && e.containerId && elements.some((c) => c.id === e.containerId)));
    return { before, elements, tops };
  }

  function duplicateSelection(offset = 12) {
    const list = withBound(selectedEls());
    if (!list.length || readOnly) return;
    const selBefore = [...selected];
    const { before, tops } = insertCopies(list, offset, offset);
    setSelection(tops.map((e) => e.id));
    commit(before, { selBefore });
    invalidate();
  }

  function groupSelection() {
    const list = withBound(selectedEls());
    if (list.length < 2 || readOnly) return;
    const before = snap(list);
    const gid = M.randomId();
    for (const e of list) {
      e.groupIds = [...(e.groupIds || []), gid];
      M.bumpVersion(e);
    }
    editingGroup = null;
    commit(before);
    invalidate(false);
    schedulePanel();
  }

  function ungroupSelection() {
    const list = withBound(selectedEls());
    if (!list.length || readOnly) return;
    const before = snap(list);
    const tops = new Set(list.map((e) => (e.groupIds || [])[e.groupIds.length - 1]).filter(Boolean));
    for (const e of list) {
      if (!e.groupIds || !e.groupIds.length) continue;
      const g = e.groupIds.filter((x) => !tops.has(x) || x === editingGroup);
      if (g.length !== e.groupIds.length) { e.groupIds = g; M.bumpVersion(e); }
    }
    editingGroup = null;
    commit(before);
    invalidate(false);
    schedulePanel();
  }

  function setLocked(list, on) {
    const all = withBound(list);
    if (!all.length || readOnly) return;
    const before = snap(all);
    for (const e of all) { e.locked = on; M.bumpVersion(e); }
    if (on) setSelection([]);
    commit(before);
    invalidate();
    if (on) toast(`${plural(list.length, "element")} locked. Right-click to unlock`, { ms: 2200 });
  }

  function toggleLock() {
    const list = selectedEls();
    if (!list.length) return;
    setLocked(list, !list.every((e) => e.locked));
  }

  function unlockAll() {
    setLocked(els.filter((e) => !e.isDeleted && e.locked), false);
  }

  function layer(how) {
    const list = withBound(selectedEls());
    if (!list.length || readOnly) return;
    const ids = new Set(list.map((e) => e.id));
    const orderBefore = els.map((e) => e.id);
    M.moveLayer(els, (e) => ids.has(e.id), how);
    const orderAfter = els.map((e) => e.id);
    if (orderBefore.join() === orderAfter.join()) return;
    commit(new Map(), { order: { before: orderBefore, after: orderAfter } });
    invalidate();
  }

  /** Selected things as movable units (groups move together). */
  function units() {
    const seen = new Set();
    const out = [];
    for (const e of selectedEls()) {
      if (seen.has(e.id)) continue;
      const gid = M.selectGroupId(e, editingGroup);
      const members = gid ? selectedEls().filter((x) => x.groupIds && x.groupIds.includes(gid)) : [e];
      for (const m of members) seen.add(m.id);
      out.push(members);
    }
    return out;
  }

  function moveBy(list, dx, dy) {
    for (const e of list) {
      e.x += dx;
      e.y += dy;
    }
  }

  function arrange(fn) {
    const us = units();
    if (us.length < 2 || readOnly) return;
    const all = withBound(us.flat());
    const ids = new Set(all.map((e) => e.id));
    const before = snap([...all, ...arrowsBoundTo(ids)]);
    const boxes = us.map((u) => M.commonBounds(u));
    const moves = fn(boxes);
    us.forEach((u, i) => {
      const [dx, dy] = moves[i];
      if (!dx && !dy) return;
      const list = withBound(u);
      moveBy(list, dx, dy);
      for (const e of list) M.bumpVersion(e);
    });
    refreshArrows(ids, ids);
    commit(before);
    invalidate();
  }
  const align = (mode) => arrange((boxes) => M.alignBoxes(boxes, mode));
  const distribute = (axis) => {
    if (units().length < 3) return toast("Select three or more to distribute", { ms: 1800 });
    arrange((boxes) => M.distributeBoxes(boxes, axis));
  };

  function morph(type) {
    const list = selectedEls().filter((e) => M.SHAPES.has(e.type) && e.type !== type);
    if (!list.length || readOnly) return;
    const before = snap(withBound(list));
    for (const e of list) {
      const round = !!e.roundness || (e.type === "ellipse" && style.roundness === "round");
      e.type = type;
      e.roundness = type === "ellipse" || !round ? null : { type: type === "rectangle" ? 3 : 2 };
      M.bumpVersion(e);
      R.forget(e);
      relayout(e);
    }
    const ids = new Set(list.map((e) => e.id));
    for (const a of arrowsBoundTo(ids)) if (!before.has(a.id)) before.set(a.id, M.snapshot(a));
    refreshArrows(ids);
    commit(before);
    invalidate();
    schedulePanel();
  }

  function flip(axis) {
    const list = withBound(selectedEls()).filter((e) => !e.locked);
    if (!list.length || readOnly) return;
    const ids = new Set(list.map((e) => e.id));
    const before = snap([...list, ...arrowsBoundTo(ids)]);
    const b = M.commonBounds(list);
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const mirror = (p) => (axis === "x" ? [2 * cx - p[0], p[1]] : [p[0], 2 * cy - p[1]]);
    for (const e of list) {
      if (e.type === "text" && e.containerId && ids.has(e.containerId)) continue;
      if (hasPoints(e)) {
        const abs = M.absolutePoints(e).map(mirror);
        e.angle = 0;
        Object.assign(e, M.linearFromAbsolute(e, abs));
      } else {
        const [ecx, ecy] = M.elementCenter(e);
        const [nx, ny] = mirror([ecx, ecy]);
        e.x = nx - e.width / 2;
        e.y = ny - e.height / 2;
        if (e.angle) e.angle = (Math.PI * 2 - e.angle) % (Math.PI * 2);
        if (e.type === "image") e.scale = axis === "x" ? [-(e.scale ? e.scale[0] : 1), e.scale ? e.scale[1] : 1] : [e.scale ? e.scale[0] : 1, -(e.scale ? e.scale[1] : 1)];
      }
      M.bumpVersion(e);
      R.forget(e);
    }
    for (const e of list) if (boundTextOf(e)) relayout(e);
    for (const a of list) {
      if (a.type !== "arrow") continue;
      for (const which of ["start", "end"]) {
        const bnd = which === "start" ? a.startBinding : a.endBinding;
        const t = bnd && byId.get(bnd.elementId);
        if (t && ids.has(t.id)) a[which === "start" ? "startBinding" : "endBinding"] = M.calcBinding(a, t, which);
      }
    }
    refreshArrows(ids, ids);
    commit(before);
    invalidate();
  }

  const penWidth = () => (Number.isFinite(style.penWidth) ? style.penWidth : 1);
  let brushKey = "";
  let brushNow = null;
  /** The pen's brush, resolved (cached until style.brush changes). */
  function currentBrush() {
    const key = JSON.stringify(style.brush);
    if (key !== brushKey || !brushNow) {
      brushKey = key;
      const custom = customBrushes.find((x) => x.id === style.brush.id);
      brushNow = B.brushOf({ customData: { brush: custom ? { ...custom, ...style.brush } : style.brush } }) || B.brushOf({ customData: { brush: "pen" } });
      if (custom) brushNow.name = custom.name;
    }
    return brushNow;
  }
  const brushName = (b) => b.name || (B.PRESET_BY_ID.get(b.id) || {}).name || "Custom";
  const brushFamily = (b) => (customBrushes.some((x) => x.id === b.id) ? "custom" : (B.PRESET_BY_ID.get(b.id) || {}).family || "pen");
  const canBg = (e) => M.SHAPES.has(e.type) || e.type === "line" || e.type === "freedraw";
  const hasStroke = (e) => M.SHAPES.has(e.type) || hasPoints(e);

  let saveStyleSoon = 0;
  let lendingInk = false;
  function rememberStyle() {
    clearTimeout(saveStyleSoon);
    saveStyleSoon = setTimeout(() => saveSetting("sketchStyle", { ...style }), 400);
  }

  function applyStyle(key, value) {
    const list = withBound(selectedEls());
    const penOnly = key === "strokeWidth" && (list.length ? list.every((e) => e.type === "freedraw") : tool === "freedraw");
    if (key === "strokeColor" || key === "backgroundColor") pushRecent(value);
    // choosing a colour yourself keeps it, even after a highlighter
    if (key === "strokeColor" && !lendingInk) delete style.inkBefore;
    if (penOnly) style.penWidth = value;
    else if (key === "backgroundColor" && (list.length ? list.every(M.isSticky) : tool === "sticky")) style.stickyColor = value;
    else style[key] = value;
    rememberStyle();
    if (!list.length || readOnly) { schedulePanel(); invalidate(false); return; }
    const before = snap(list);
    const containers = new Set();
    for (const e of list) {
      let ok = false;
      switch (key) {
        case "strokeColor": ok = e.type !== "image" && e.type !== "frame"; break;
        case "backgroundColor": ok = canBg(e); break;
        case "fillStyle": ok = canBg(e); break;
        case "strokeWidth":
        case "strokeStyle":
        case "roughness": ok = hasStroke(e) && !(key !== "strokeWidth" && e.type === "freedraw"); break;
        case "opacity": ok = true; break;
        case "roundness":
          if (e.type === "rectangle" || e.type === "diamond" || e.type === "line") {
            e.roundness = value === "round" ? { type: e.type === "rectangle" ? 3 : 2 } : null;
            M.bumpVersion(e);
            R.forget(e);
          }
          continue;
        case "arrowType":
          if (e.type === "arrow") {
            e.roundness = value === "round" ? { type: 2 } : null;
            M.bumpVersion(e);
            R.forget(e);
          }
          continue;
        case "startArrowhead":
        case "endArrowhead": ok = e.type === "arrow"; break;
        case "fontFamily":
        case "fontSize":
        case "textAlign":
          if (e.type === "text") {
            e[key] = value;
            if (key === "fontFamily") e.lineHeight = M.defaultLineHeight(value);
            M.bumpVersion(e);
            if (e.containerId && alive(e.containerId)) containers.add(e.containerId);
            else if (key !== "textAlign") measureStandalone(e);
          }
          continue;
        default: break;
      }
      if (ok) {
        e[key] = value;
        M.bumpVersion(e);
        R.forget(e);
      }
    }
    for (const id of containers) relayout(byId.get(id));
    if (containers.size) {
      for (const a of arrowsBoundTo(containers)) if (!before.has(a.id)) before.set(a.id, M.snapshot(a));
      refreshArrows(containers);
    }
    commit(before, { key: "style:" + key });
    invalidate();
    schedulePanel();
  }

  /** Style of the first selected element, for copy/paste style. */
  let copiedStyle = null;
  function copyStyle() {
    const e = selectedEls()[0];
    if (!e) return;
    const t = boundTextOf(e) || (e.type === "text" ? e : null);
    copiedStyle = { strokeColor: e.strokeColor, backgroundColor: e.backgroundColor, fillStyle: e.fillStyle, strokeWidth: e.strokeWidth, strokeStyle: e.strokeStyle, roughness: e.roughness, opacity: e.opacity };
    if (t) Object.assign(copiedStyle, { fontFamily: t.fontFamily, fontSize: t.fontSize, textAlign: t.textAlign });
    toast("Style copied", { ms: 1200 });
  }
  function pasteStyle() {
    if (!copiedStyle) return;
    const list = withBound(selectedEls());
    if (!list.length) return;
    const before = snap(list);
    for (const e of list) {
      for (const k of ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity"]) {
        if (k === "backgroundColor" && !canBg(e)) continue;
        if (e.type === "text" && k !== "strokeColor" && k !== "opacity") continue;
        e[k] = copiedStyle[k];
      }
      if (e.type === "text" && copiedStyle.fontFamily) {
        e.fontFamily = copiedStyle.fontFamily;
        e.fontSize = copiedStyle.fontSize;
        e.textAlign = copiedStyle.textAlign;
        e.lineHeight = M.defaultLineHeight(e.fontFamily);
        if (!e.containerId) measureStandalone(e);
      }
      M.bumpVersion(e);
      R.forget(e);
    }
    for (const e of list) if (boundTextOf(e)) relayout(e);
    commit(before);
    invalidate();
    schedulePanel();
  }

  function toggleGrid(on = !gridOn) {
    gridOn = on;
    if (!readOnly) {
      M.setGrid(scene.appState, on);
      markChanged();
    }
    paintGrid();
    toast(on ? "Grid on: shapes snap to it" : "Grid off", { ms: 1200 });
  }

  function toggleGuides(on = !guidesOn) {
    guidesOn = on;
    saveSetting("sketchGuides", on);
    toast(on ? "Smart guides on" : "Smart guides off", { ms: 1200 });
  }

  function editLink() {
    const e = selectedEls()[0];
    if (!e || readOnly) return;
    const input = h("input", { class: "sk-link-input", placeholder: "Paste a link and press Enter", value: e.link || "", spellcheck: false });
    const r = M.elementBounds(e);
    const pop = h("div", { class: "sk-pop sk-link-pop", style: { left: clamp(toScreenX(r[0]), 8, W - 300) + "px", top: clamp(toScreenY(r[3]) + 10, 60, H - 60) + "px" } }, ic("link"), input);
    root.append(pop);
    input.focus();
    input.select();
    let done = false;
    const close = (save) => {
      if (done) return;
      done = true;
      pop.remove();
      if (save) {
        const v = input.value.trim() || null;
        if (v !== (e.link || null)) {
          const before = snap([e]);
          e.link = v;
          M.bumpVersion(e);
          commit(before);
          invalidate();
        }
      }
      root.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") close(true);
      if (ev.key === "Escape") close(false);
    });
    input.addEventListener("blur", () => close(true));
  }

  function openLink(e) {
    if (!e || !e.link) return;
    if (M.linkedNote(e)) { openCardNote(e, false); return; }
    if (app.openUrl) app.openUrl(e.link);
    else window.open(e.link, "_blank");
  }

  /* ── pointer input ────────────────────────────────────────────────────── */
  let rect = { left: 0, top: 0 };
  let needHover = false;
  let wheelActive = false;
  let wheelTimer = 0;
  let lastCursor = "";
  const gridSize = () => M.gridSizeOf(scene.appState);
  const snapG = (v) => M.snapToGrid(v, gridSize());
  const normAngle = (a) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  // two arrows going opposite ways along an edge: slant it
  const SKEW_SVG = (deg) => `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(${deg} 12 12)"><path d="M4 9h13l-3-3M20 15H7l3 3" stroke="#fff" stroke-width="4"/><path d="M4 9h13l-3-3M20 15H7l3 3" stroke="#111" stroke-width="1.8"/></g></svg>`;
  const skewCursor = (handle, angle) => `url("data:image/svg+xml,${encodeURIComponent(SKEW_SVG(Math.round((((handle === "e" || handle === "w") ? 90 : 0) + ((angle || 0) * 180) / Math.PI))))}") 11 11, move`;
  const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 4.5v5h-5M19.7 13.5A8 8 0 1 1 18 6.6l2.5 2.9" stroke="#fff" stroke-width="4"/><path d="M20.5 4.5v5h-5M19.7 13.5A8 8 0 1 1 18 6.6l2.5 2.9" stroke="#111" stroke-width="1.8"/></svg>')}") 10 10, grab`;

  function updateRect() {
    const r = root.getBoundingClientRect();
    rect = { left: r.left, top: r.top };
  }

  function updatePtr(e) {
    ptr.sx = e.clientX - rect.left;
    ptr.sy = e.clientY - rect.top;
    ptr.wx = toWorldX(ptr.sx);
    ptr.wy = toWorldY(ptr.sy);
    ptr.shift = e.shiftKey;
    ptr.alt = e.altKey;
    ptr.ctrl = e.ctrlKey || e.metaKey;
    if (e.pointerType) ptr.type = e.pointerType;
    if (e.pressure > 0) ptr.pressure = e.pressure;
    ptr.moved = true;
  }

  /** Topmost element under a world point; labels resolve to their shape. */
  function hitAt(wx, wy, { locked = false, raw = false } = {}) {
    // generous slop, in screen pixels: thin lines are as easy to take as boxes
    const t = (ptr.type === "touch" ? 16 : HIT_PX) / view.k;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.isDeleted || (!locked && e.locked) || (editing && editing.el === e)) continue;
      const b = R.boundsOf(e);
      const tt = hasPoints(e) ? t * 1.3 + (e.type === "freedraw" ? e.strokeWidth * Math.max(0, R.brushReach(e) - 2.2) : 0) : t;
      if (wx < b[0] - tt || wx > b[2] + tt || wy < b[1] - tt || wy > b[3] + tt) continue;
      if (!M.hitTest(e, wx, wy, tt)) continue;
      if (!raw && e.type === "text" && e.containerId) {
        const c = alive(e.containerId);
        if (c) return c;
      }
      return e;
    }
    return null;
  }

  /** The topmost shape whose inside holds the point (hollow ones too). */
  function containerAt(wx, wy) {
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.isDeleted || e.locked || !M.SHAPES.has(e.type)) continue;
      if (M.hitTest(e, wx, wy, 0, { inside: true })) return e;
    }
    return null;
  }

  function hitSelected(wx, wy) {
    const list = selectedEls().filter((e) => !e.locked);
    if (!list.length) return null;
    const t = 6 / view.k;
    for (const e of list) if (M.hitTest(e, wx, wy, t, { inside: !hasPoints(e) })) return e;
    if (list.length > 1) {
      const b = M.commonBounds(list);
      if (wx >= b[0] && wx <= b[2] && wy >= b[1] && wy <= b[3]) return list[0];
    }
    return null;
  }

  function snapCandidates(ids) {
    setViewport();
    const out = [];
    const m = 200 / view.k;
    for (const e of els) {
      if (e.isDeleted || ids.has(e.id) || (e.type === "text" && e.containerId)) continue;
      const b = R.boundsOf(e);
      if (b[2] < viewport[0] - m || b[0] > viewport[2] + m || b[3] < viewport[1] - m || b[1] > viewport[3] + m) continue;
      out.push(M.elementBounds(e));
      if (out.length > 800) break;
    }
    if (measure) out.push(...measure.guideCandidates(viewport));
    return out;
  }

  function setCursor(c) {
    if (c !== lastCursor) {
      cOver.style.cursor = c;
      lastCursor = c;
    }
  }

  function toolCursor() {
    if (spaceDown || tool === "hand") return gesture && gesture.type === "pan" ? "grabbing" : "grab";
    switch (tool) {
      case "text": return "text";
      case "freedraw":
      case "eraser":
      case "laser":
      case "picker": return ptr.type === "touch" ? "crosshair" : "none";
      case "select": return "default";
      default: return "crosshair";
    }
  }

  function updateHover() {
    needHover = false;
    let next = null;
    let cursor = toolCursor();
    if (ptr.inside && (tool === "eraser" || tool === "picker") && !spaceDown && !rightDown) {
      next = hitAt(ptr.wx, ptr.wy);
      if (tool === "eraser" && eraseMode === "cut" && next && next.type !== "freedraw") next = null;
    }
    if (ptr.inside && tool === "select" && !spaceDown && !rightDown) {
      const hd = hitHandle(ptr.sx, ptr.sy);
      const chip = linkChips.find((c) => ptr.sx >= c.x && ptr.sx <= c.x + c.w && ptr.sy >= c.y && ptr.sy <= c.y + c.h);
      if (hd) cursor = hd.kind === "rotate" ? ROTATE_CURSOR : hd.kind === "skew" ? skewCursor(hd.handle, hd.frame.angle) : hd.kind === "resize" ? cursorFor(hd.handle, hd.frame.angle) : "pointer";
      else if (chip) cursor = "pointer";
      else {
        next = hitAt(ptr.wx, ptr.wy);
        if (next || hitSelected(ptr.wx, ptr.wy)) cursor = ptr.ctrl && next && next.link ? "pointer" : "move";
      }
    }
    if (ptr.inside && tool === "measure" && measure && !gesture) cursor = measure.hoverCursor() || cursor;
    setCursor(cursor);
    if (next !== hover) {
      hover = next;
      dirtyOver = true;
    }
  }

  function onPointerDown(e) {
    if (destroyed) return;
    updateRect();
    updatePtr(e);
    ptr.inside = true;
    if (e.pointerType === "pen") penSeen = performance.now();
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: ptr.sx, y: ptr.sy });
      if (touches.size >= 2) {
        cancelGesture();
        startPinch();
        return;
      }
      // palm rejection: once a pen has been used, fingers only pan and zoom
      if (penSeen) {
        startPan(e);
        return;
      }
    }
    if (editing) finishText();
    root.focus({ preventScroll: true });
    if (popEl && !popEl.classList.contains("sk-pop-keep")) closePop();
    if (gesture) return;
    // right button: drag pans, a still click opens the menu
    if (e.button === 2) {
      e.preventDefault();
      if (tool === "measure" && measure && measure.escape()) return;
      if (draft) finishDraft(true);
      startRightPress(e);
      return;
    }
    if (e.button === 1 || (e.button === 0 && (spaceDown || tool === "hand"))) {
      e.preventDefault();
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    try { cOver.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    ptr.down = true;
    if (peek) peek.used = true;
    const chip = linkChips.find((c) => ptr.sx >= c.x && ptr.sx <= c.x + c.w && ptr.sy >= c.y && ptr.sy <= c.y + c.h);
    if (chip && tool === "select") { openLink(chip.el); return; }
    if (tool === "laser") return startLaser();
    if (tool === "picker") return pickColor(e);
    if (tool === "measure") return measure.down(); // measuring changes nothing, so a read-only drawing can be measured too
    if (readOnly) return startPan(e);
    switch (tool) {
      case "select": return selectDown(e);
      case "lasso": return startLasso(e.shiftKey);
      case "piece": return pieceDown(e);
      case "rectangle":
      case "diamond":
      case "ellipse":
      case "sticky":
      case "frame": return startShape(tool);
      case "arrow":
      case "line": return linearDown(tool);
      case "measure": return measure.down();
      case "freedraw": return startFreedraw(e);
      case "text": return textDown();
      case "eraser": return startEraser();
      default: return selectDown(e);
    }
  }

  let rightDown = false;
  let rightUpAt = 0;
  function startRightPress(e) {
    const sx = ptr.sx;
    const sy = ptr.sy;
    const vx = view.x;
    const vy = view.y;
    const cx = e.clientX;
    const cy = e.clientY;
    let panning = false;
    rightDown = true;
    hover = null;
    try { cOver.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    gesture = {
      type: "rpan",
      frame() {
        if (!panning) {
          if (Math.hypot(ptr.sx - sx, ptr.sy - sy) < CLICK_PX) return;
          panning = true;
          gesture.type = "pan";
          setCursor("grabbing");
        }
        setView(vx + ptr.sx - sx, vy + ptr.sy - sy, view.k);
      },
      up() {
        rightDown = false;
        rightUpAt = performance.now();
        setCursor(toolCursor());
        if (!panning) openContextAt(cx, cy);
      },
      cancel() { rightDown = false; setCursor(toolCursor()); },
    };
  }

  function onPointerMove(e) {
    if (destroyed) return;
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (gesture && gesture.type === "pinch") { ptr.moved = true; schedule(); return; }
    }
    updatePtr(e);
    ptr.inside = true;
    if (gesture) {
      if (gesture.move) gesture.move(e);
      dirtyOver = true;
    } else {
      needHover = true;
      if (draft || tool === "freedraw" || tool === "eraser" || tool === "laser" || tool === "picker") dirtyOver = true;
    }
    if (measure) measure.pointerMoved();
    schedule();
  }

  function onPointerUp(e) {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (gesture && gesture.type === "pinch") {
        if (touches.size < 2) endGesture();
        return;
      }
    }
    updatePtr(e);
    ptr.down = false;
    if (!gesture) return;
    if (gesture.frame && ptr.moved) {
      ptr.moved = false;
      gesture.frame();
    }
    endGesture();
  }

  function endGesture() {
    const g = gesture;
    gesture = null;
    guides = [];
    bindTarget = null;
    box = null;
    liveIds = new Set();
    if (g && g.up) g.up();
    if (peek && peek.released) endPeek();
    needHover = true;
    dirtyStatic = true;
    invalidate();
    schedulePanel();
  }

  function cancelGesture() {
    const g = gesture;
    if (!g) return;
    gesture = null;
    guides = [];
    bindTarget = null;
    box = null;
    liveIds = new Set();
    if (g.cancel) g.cancel();
    else if (g.up) g.up();
    invalidate();
  }

  function onWheel(e) {
    if (destroyed) return;
    e.preventDefault();
    updateRect();
    updatePtr(e);
    wheelActive = true;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelActive = false;
      dirtyStatic = true;
      schedule();
    }, 140);
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    if (e.deltaMode === 2) { dx *= H; dy *= H; }
    // the wheel zooms at the pointer (pinches arrive as ctrl+wheel); Shift+wheel
    // and sideways swipes pan, Alt+wheel pans up and down
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && !e.altKey && !dx)) {
      zoomAt(view.k * Math.exp(-clamp(dy, -80, 80) * (e.ctrlKey || e.metaKey ? 0.0085 : 0.0022)), ptr.sx, ptr.sy);
    } else {
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      setView(view.x - dx, view.y - dy, view.k);
    }
    if (editing) placeEditor();
  }

  /* ── gestures ─────────────────────────────────────────────────────────── */
  function startPan(e) {
    const sx = ptr.sx;
    const sy = ptr.sy;
    const vx = view.x;
    const vy = view.y;
    try { cOver.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    gesture = {
      type: "pan",
      frame() { setView(vx + ptr.sx - sx, vy + ptr.sy - sy, view.k); },
      up() { setCursor(toolCursor()); },
    };
    setCursor("grabbing");
  }

  function startPinch() {
    const pts = [...touches.values()];
    const d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const mx = (pts[0].x + pts[1].x) / 2;
    const my = (pts[0].y + pts[1].y) / 2;
    const k0 = view.k;
    const wx = toWorldX(mx);
    const wy = toWorldY(my);
    gesture = {
      type: "pinch",
      frame() {
        const p = [...touches.values()];
        if (p.length < 2) return;
        const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const k = clamp((k0 * d) / d0, MIN_K, MAX_K);
        const cx = (p[0].x + p[1].x) / 2;
        const cy = (p[0].y + p[1].y) / 2;
        setView(cx - wx * k, cy - wy * k, k);
      },
    };
  }

  function selectDown(e) {
    const hd = hitHandle(ptr.sx, ptr.sy);
    if (hd) {
      if (hd.kind === "point") return startPointDrag(hd.el, hd.index, e, snap([hd.el]));
      if (hd.kind === "mid") {
        const before = snap([hd.el]);
        return startPointDrag(hd.el, insertPoint(hd.el, hd.index), e, before);
      }
      if (hd.kind === "rotate") return startRotate(hd.frame);
      if (hd.kind === "skew") return startSkew(hd.frame, hd.handle);
      return startResize(hd.frame, hd.handle);
    }
    if (pointEdit) {
      const pe = byId.get(pointEdit.id);
      if (pe && M.hitTest(pe, ptr.wx, ptr.wy, 8 / view.k)) {
        pointEdit.sel.clear();
        return startMove(e);
      }
      pointEdit = null;
      hideHint();
    }
    const hit = hitAt(ptr.wx, ptr.wy);
    if (hit && ptr.ctrl && hit.link) { openLink(hit); return; }
    if (!e.shiftKey && hitSelected(ptr.wx, ptr.wy) && (!hit || selected.has(hit.id))) return startMove(e);
    if (hit) {
      if (editingGroup && !(hit.groupIds || []).includes(editingGroup)) editingGroup = null;
      const unit = unitOf(hit);
      if (e.shiftKey) {
        const all = unit.every((u) => selected.has(u.id));
        for (const u of unit) all ? selected.delete(u.id) : selected.add(u.id);
        setSelection([...selected]);
        if (all) return;
      } else if (!selected.has(hit.id)) {
        setSelection(unit.map((u) => u.id));
      }
      return startMove(e);
    }
    if (!e.shiftKey) {
      editingGroup = null;
      setSelection([]);
    }
    if (e.altKey) startLasso(e.shiftKey);
    else startBox(e.shiftKey);
  }

  /** Free-form selection: whatever the loop wholly encloses. */
  function startLasso(additive) {
    const base = additive ? new Set(selected) : new Set();
    if (!additive && selected.size) setSelection([]);
    const pts = [ptr.wx, ptr.wy];
    lasso = pts;
    const cands = [];
    for (const e of els) {
      if (e.isDeleted || e.locked || (e.type === "text" && e.containerId && alive(e.containerId))) continue;
      cands.push([e, M.elementBounds(e)]);
    }
    let lastCheck = 0;
    const pick = () => {
      const lb = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] < lb[0]) lb[0] = pts[i];
        if (pts[i + 1] < lb[1]) lb[1] = pts[i + 1];
        if (pts[i] > lb[2]) lb[2] = pts[i];
        if (pts[i + 1] > lb[3]) lb[3] = pts[i + 1];
      }
      const ids = new Set(base);
      const groups = new Set();
      for (const [e, b] of cands) {
        if (b[0] < lb[0] || b[1] < lb[1] || b[2] > lb[2] || b[3] > lb[3]) continue;
        if (!M.inLasso(e, pts)) continue;
        ids.add(e.id);
        const g = M.selectGroupId(e, editingGroup);
        if (g) groups.add(g);
      }
      if (groups.size) for (const [e] of cands) if (e.groupIds && e.groupIds.some((g) => groups.has(g))) ids.add(e.id);
      selected.clear();
      for (const id of ids) selected.add(id);
    };
    gesture = {
      type: "lasso",
      hideHandles: true,
      frame() {
        const n = pts.length;
        if (Math.hypot(ptr.wx - pts[n - 2], ptr.wy - pts[n - 1]) * view.k < 3) return;
        pts.push(ptr.wx, ptr.wy);
        // testing every element on every point is wasteful; a few times a second is plenty
        const t = performance.now();
        if (t - lastCheck > 70) { lastCheck = t; pick(); }
      },
      up() {
        pick();
        lasso = null;
        if (tool === "lasso" && !toolLocked && selected.size) setTool("select");
        schedulePanel();
      },
      cancel() { lasso = null; },
    };
  }

  /* The piece tool, as in the picture editor: a box over a picture that changes nothing by itself; a drag
     from inside it lifts that part of the picture out as a picture of its own (the hole stays transparent;
     Alt leaves the picture whole). Delete cuts the box out of the picture; Esc lets go. */
  let marq = null; // [x0, y0, x1, y1] in the drawing's units
  const inMarq = (x, y) => marq && x >= marq[0] && x <= marq[2] && y >= marq[1] && y <= marq[3];
  function pieceDown(e) {
    if (marq && inMarq(ptr.wx, ptr.wy)) {
      const n = cutPiece(!e.altKey, true);
      marq = null;
      if (n) startMove({ altKey: false });
      invalidate();
      return;
    }
    const x0 = ptr.wx, y0 = ptr.wy;
    marq = null;
    if (selected.size) setSelection([]);
    gesture = {
      type: "piece",
      hideHandles: true,
      frame() { marq = [Math.min(x0, ptr.wx), Math.min(y0, ptr.wy), Math.max(x0, ptr.wx), Math.max(y0, ptr.wy)]; dirtyOver = true; invalidate(); },
      up() { if (marq && (marq[2] - marq[0]) * view.k < 4 && (marq[3] - marq[1]) * view.k < 4) marq = null; dirtyOver = true; invalidate(); },
      cancel() { marq = null; },
    };
  }
  /** What is in the box comes out of the drawing: pen strokes cut at its edges, pictures cut at it (the hole
      left see-through), anything wholly inside it taken whole. `lift`: the pieces stay, selected, to be
      moved; without it they are thrown away (Delete). `hole`: false keeps the original as it was (Alt: a
      copy). Gives how many pieces came out. */
  function cutPiece(hole, lift) {
    const box = marq;
    const before = new Map();
    const selBefore = [...selected];
    const lifted = [], whole = [];
    const touch = (e) => { if (!before.has(e.id)) before.set(e.id, M.snapshot(e)); };
    const gone = (e) => { touch(e); e.isDeleted = true; M.bumpVersion(e); };
    const add = (e) => { addElement(e); before.set(e.id, { ...e, isDeleted: true }); return e; };
    const putFile = (cv) => {
      const dataURL = cv.toDataURL("image/png");
      const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      files[id] = { mimeType: "image/png", id, dataURL, created: now(), lastRetrieved: now() };
      return id;
    };
    let skipped = 0;
    for (const e of [...els]) {
      if (e.isDeleted || e.locked || (e.type === "text" && e.containerId)) continue;
      const b = R.boundsOf(e);
      if (b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]) continue;
      if (b[0] >= box[0] && b[2] <= box[2] && b[1] >= box[1] && b[3] <= box[3]) { whole.push(e); continue; }
      const straight = Math.abs(e.angle || 0) < 1e-3 && !(e.scale && (e.scale[0] !== 1 || e.scale[1] !== 1));
      if (e.type === "image" && straight) {
        const img = getImage(e.fileId);
        if (!img) { skipped++; continue; }
        const bx0 = Math.max(box[0], e.x), by0 = Math.max(box[1], e.y), bx1 = Math.min(box[2], e.x + e.width), by1 = Math.min(box[3], e.y + e.height);
        const kx = img.naturalWidth / e.width, ky = img.naturalHeight / e.height;
        const sx = Math.round((bx0 - e.x) * kx), sy = Math.round((by0 - e.y) * ky), sw = Math.max(1, Math.round((bx1 - bx0) * kx)), sh = Math.max(1, Math.round((by1 - by0) * ky));
        if (lift) {
          const cv = document.createElement("canvas"); cv.width = sw; cv.height = sh;
          cv.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          lifted.push(add(M.newElement("image", { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0, fileId: putFile(cv) }, style)));
        }
        if (hole) {
          const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          const g2 = cv.getContext("2d"); g2.drawImage(img, 0, 0); g2.clearRect(sx, sy, sw, sh);
          touch(e);
          e.fileId = putFile(cv);
          M.bumpVersion(e);
        }
        continue;
      }
      if (e.type === "freedraw" && !(e.groupIds && e.groupIds.length)) {
        const res = M.splitFreedrawByBox(e, box);
        if (!res) continue;
        if (lift) for (const run of res.inside) lifted.push(add(M.freedrawPiece(e, run)));
        // the pieces left behind, made before the stroke goes (they are copies of it)
        if (hole) { const outs = res.outside.map((run) => M.freedrawPiece(e, run)); gone(e); for (const o of outs) add(o); }
        continue;
      }
      // a shape only partly in the box: its outline is cut like a pen line, the pieces become lines of
      // the same colour and width (a fill does not survive the cut). One with words in it stays whole.
      const outline = e.type === "rectangle" ? [[0, 0], [e.width, 0], [e.width, e.height], [0, e.height], [0, 0]]
        : e.type === "diamond" ? [[e.width / 2, 0], [e.width, e.height / 2], [e.width / 2, e.height], [0, e.height / 2], [e.width / 2, 0]]
        : e.type === "ellipse" ? Array.from({ length: 73 }, (_, i) => [e.width / 2 + (Math.cos((i / 72) * Math.PI * 2) * e.width) / 2, e.height / 2 + (Math.sin((i / 72) * Math.PI * 2) * e.height) / 2])
        : e.type === "line" || e.type === "arrow" ? e.points : null;
      const hasWords = (e.boundElements || []).some((b) => b.type === "text");
      if (!outline || hasWords || (e.groupIds && e.groupIds.length)) { skipped++; continue; }
      const res = M.splitFreedrawByBox({ ...e, points: outline, pressures: [], simulatePressure: true }, box);
      if (!res) continue;
      const asLine = { ...e, type: "line", points: outline, backgroundColor: "transparent", roundness: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, boundElements: null, pressures: [], simulatePressure: true };
      const piece = (run) => { const n = M.freedrawPiece(asLine, run); delete n.pressures; delete n.simulatePressure; return n; };
      if (lift) for (const run of res.inside) lifted.push(add(piece(run)));
      if (hole) { const outs = res.outside.map(piece); gone(e); for (const o of outs) add(o); }
    }
    // wholly inside: moved as they are, copied (Alt), or thrown away (Delete)
    if (whole.length) {
      const all = withBound(whole);
      if (!lift) for (const e of all) gone(e);
      else if (!hole) { const cp = insertCopies(all, 0, 0); for (const [id, sn] of cp.before) before.set(id, sn); lifted.push(...cp.tops); }
      else lifted.push(...whole);
    }
    if (!lifted.length && !before.size) { toast(skipped ? "Only things it cannot cut here: a turned picture, a shape with words in it, or a group" : "Nothing in the box", { ms: 2600 }); return 0; }
    setSelection(lift ? lifted.map((e) => e.id) : []);
    commit(before, { selBefore });
    dirtyMap = true;
    dirtyStatic = true;
    invalidate();
    return lift ? lifted.length : 1;
  }

  function startMove(e) {
    let list = selectedEls().filter((x) => !x.locked);
    if (!list.length) return;
    const selBefore = [...selected];
    let before = new Map();
    let copies = null;
    if (e.altKey) {
      // Alt+drag leaves the original where it was and drags a copy
      copies = insertCopies(withBound(list), 0, 0);
      before = copies.before;
      setSelection(copies.tops.map((x) => x.id));
      list = copies.tops;
    }
    const moving = withBound(list);
    const ids = new Set(moving.map((x) => x.id));
    const arrows = arrowsBoundTo(ids).filter((a) => !ids.has(a.id));
    const arrowLabels = withBound(arrows);
    for (const x of [...moving, ...arrowLabels]) if (!before.has(x.id)) before.set(x.id, M.snapshot(x));
    const ox = Float64Array.from(moving, (x) => x.x);
    const oy = Float64Array.from(moving, (x) => x.y);
    const b0 = M.commonBounds(moving);
    const x0 = ptr.wx;
    const y0 = ptr.wy;
    const sx0 = ptr.sx;
    const sy0 = ptr.sy;
    const bound = bindingIdsOf(moving);
    let others = null;
    let started = false;
    gesture = {
      type: "move",
      hideHandles: false,
      frame() {
        if (!started) {
          if (Math.hypot(ptr.sx - sx0, ptr.sy - sy0) < DRAG_PX) return;
          started = true;
          gesture.hideHandles = true;
          liveIds = new Set([...ids, ...arrowLabels.map((a) => a.id)]);
          dirtyStatic = true;
        }
        let dx = ptr.wx - x0;
        let dy = ptr.wy - y0;
        if (ptr.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        guides = [];
        // Ctrl (or Alt, unless Alt started a copy) moves freely
        const free = ptr.ctrl || (ptr.alt && !copies);
        if (gridOn && !free) {
          if (!ptr.shift || dx) dx = snapG(b0[0] + dx) - b0[0];
          if (!ptr.shift || dy) dy = snapG(b0[1] + dy) - b0[1];
        } else if (guidesOn && !free) {
          if (!others) others = snapCandidates(ids);
          const r = M.snapGuides([b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy], others, SNAP_PX / view.k, { x: !ptr.shift || dx !== 0, y: !ptr.shift || dy !== 0 });
          dx += r.dx;
          dy += r.dy;
          guides = r.guides;
        }
        for (let i = 0; i < moving.length; i++) {
          moving[i].x = ox[i] + dx;
          moving[i].y = oy[i] + dy;
        }
        if (bound.size) {
          for (const a of arrows) {
            if (refreshArrow(a, byId) && a.boundElements) relayout(a);
          }
        }
      },
      up() {
        if (!started) {
          if (copies) for (const x of copies.elements) x.isDeleted = true;
          if (copies) setSelection(selBefore);
          return;
        }
        for (const x of moving) M.bumpVersion(x);
        for (const x of moving) {
          if (x.type !== "arrow") continue;
          const keep = (b) => !b || ids.has(b.elementId);
          if (!(keep(x.startBinding) && keep(x.endBinding)) || (!x.startBinding && !x.endBinding && list.length === 1)) rebindEnds(x, before, null);
        }
        assignFrames(moving);
        commit(before, { selBefore });
      },
    };
  }

  function startBox(additive) {
    const base = additive ? new Set(selected) : new Set();
    const x0 = ptr.wx;
    const y0 = ptr.wy;
    const cands = [];
    for (const e of els) {
      if (e.isDeleted || e.locked || (e.type === "text" && e.containerId && alive(e.containerId))) continue;
      cands.push([e, M.elementBounds(e)]);
    }
    gesture = {
      type: "box",
      hideHandles: true,
      frame() {
        box = [x0, y0, ptr.wx, ptr.wy];
        const x1 = Math.min(x0, ptr.wx);
        const x2 = Math.max(x0, ptr.wx);
        const y1 = Math.min(y0, ptr.wy);
        const y2 = Math.max(y0, ptr.wy);
        const ids = new Set(base);
        const groups = new Set();
        for (const [e, b] of cands) {
          if (b[0] < x1 || b[1] < y1 || b[2] > x2 || b[3] > y2) continue;
          ids.add(e.id);
          const g = M.selectGroupId(e, editingGroup);
          if (g) groups.add(g);
        }
        if (groups.size) for (const [e] of cands) if (e.groupIds && e.groupIds.some((g) => groups.has(g))) ids.add(e.id);
        selected.clear();
        for (const id of ids) selected.add(id);
      },
      up() { schedulePanel(); },
    };
  }

  function handleWorld(f, handle) {
    const u = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
    const v = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
    const hw = (f.x2 - f.x1) / 2;
    const hh = (f.y2 - f.y1) / 2;
    return M.rotatePoint(f.cx + u * hw, f.cy + v * hh, f.cx, f.cy, f.angle);
  }

  function resizeOne(e, o, nb, box0) {
    if (e.type === "text") {
      const s = Math.max(0.05, nb.height / (box0.height || 1));
      e.fontSize = Math.max(1, Math.round(o.fontSize * s * 100) / 100);
      e.width = o.width * s;
      e.height = o.height * s;
      e.x = nb.x;
      e.y = nb.y;
    } else if (hasPoints(e)) {
      const ext = M.pointsExtent(o.points);
      const fit = M.fitPoints(o.points, ext, nb.width, nb.height, nb.flipX, nb.flipY);
      e.points = fit.points;
      e.x = nb.x + fit.offset[0];
      e.y = nb.y + fit.offset[1];
      e.width = nb.width;
      e.height = nb.height;
    } else {
      e.x = nb.x;
      e.y = nb.y;
      e.width = Math.max(1, nb.width);
      e.height = Math.max(1, nb.height);
      if (e.type === "image") {
        const sc = o.scale || [1, 1];
        e.scale = [sc[0] * (nb.flipX ? -1 : 1), sc[1] * (nb.flipY ? -1 : 1)];
      }
    }
    M.bumpVersion(e);
    if (M.canContainText(e) && e.boundElements) relayout(e);
  }

  function resizeMany(list, orig, box0, nb) {
    const sx = nb.width / (box0.width || 1);
    const sy = nb.height / (box0.height || 1);
    const s = Math.min(sx, sy);
    for (const e of list) {
      if (e.type === "text" && e.containerId && list.some((c) => c.id === e.containerId)) continue;
      const o = orig.get(e.id);
      const [ocx, ocy] = M.elementCenter(o);
      const ncx = nb.flipX ? nb.x + nb.width - (ocx - box0.x) * sx : nb.x + (ocx - box0.x) * sx;
      const ncy = nb.flipY ? nb.y + nb.height - (ocy - box0.y) * sy : nb.y + (ocy - box0.y) * sy;
      if (e.type === "text") {
        e.fontSize = Math.max(1, o.fontSize * s);
        e.width = o.width * s;
        e.height = o.height * s;
      } else if (hasPoints(e)) {
        const ext = M.pointsExtent(o.points);
        const w = (ext[2] - ext[0]) * sx;
        const hh = (ext[3] - ext[1]) * sy;
        const fit = M.fitPoints(o.points, ext, w, hh, nb.flipX, nb.flipY);
        e.points = fit.points;
        e.width = w;
        e.height = hh;
        e.x = ncx - w / 2 + fit.offset[0];
        e.y = ncy - hh / 2 + fit.offset[1];
        M.bumpVersion(e);
        continue;
      } else {
        e.width = Math.max(1, o.width * sx);
        e.height = Math.max(1, o.height * sy);
      }
      e.x = ncx - e.width / 2;
      e.y = ncy - e.height / 2;
      M.bumpVersion(e);
    }
    for (const e of list) if (M.canContainText(e) && e.boundElements) relayout(e);
  }

  function startResize(f, handle) {
    const list = f.single ? [f.el] : f.list.filter((x) => !x.locked);
    const all = withBound(list);
    const ids = new Set(all.map((x) => x.id));
    const arrows = arrowsBoundTo(ids).filter((a) => !ids.has(a.id));
    const before = snap([...all, ...withBound(arrows)]);
    const box0 = { x: f.x1, y: f.y1, width: f.x2 - f.x1, height: f.y2 - f.y1, angle: f.angle };
    const [hx, hy] = handleWorld(f, handle);
    const offX = hx - ptr.wx;
    const offY = hy - ptr.wy;
    const single = f.single ? f.el : null;
    let others = null;
    liveIds = new Set([...ids, ...withBound(arrows).map((a) => a.id)]);
    dirtyStatic = true;
    gesture = {
      type: "resize",
      hideHandles: true,
      frame() {
        let px = ptr.wx + offX;
        let py = ptr.wy + offY;
        guides = [];
        const moveX = handle.includes("e") || handle.includes("w");
        const moveY = handle.includes("n") || handle.includes("s");
        if (!f.angle && !ptr.ctrl) {
          if (gridOn) {
            if (moveX) px = snapG(px);
            if (moveY) py = snapG(py);
          } else if (guidesOn) {
            if (!others) others = snapCandidates(ids);
            const t = SNAP_PX / view.k;
            let bx = t + 1e-9;
            let by = t + 1e-9;
            let gx = null;
            let gy = null;
            for (const o of others) {
              for (const v of [o[0], (o[0] + o[2]) / 2, o[2]]) if (moveX && Math.abs(v - px) < bx) { bx = Math.abs(v - px); gx = [v, o]; }
              for (const v of [o[1], (o[1] + o[3]) / 2, o[3]]) if (moveY && Math.abs(v - py) < by) { by = Math.abs(v - py); gy = [v, o]; }
            }
            if (gx) { px = gx[0]; guides.push({ x1: px, y1: Math.min(gx[1][1], box0.y, py), x2: px, y2: Math.max(gx[1][3], box0.y + box0.height, py) }); }
            if (gy) { py = gy[0]; guides.push({ x1: Math.min(gy[1][0], box0.x, px), y1: py, x2: Math.max(gy[1][2], box0.x + box0.width, px), y2: py }); }
          }
        }
        let keep = ptr.shift;
        if (single && single.type === "image") keep = !ptr.shift;
        if ((single && single.type === "text") || (!single && f.text)) keep = true;
        const nb = M.resizeBox(box0, handle, px, py, { keepRatio: keep, fromCenter: ptr.alt });
        if (single) resizeOne(single, before.get(single.id), nb, box0);
        else resizeMany(all, before, box0, nb);
        for (const a of all) if (a.type === "arrow" && (a.startBinding || a.endBinding)) refreshArrow(a, byId);
        for (const a of arrows) if (refreshArrow(a, byId) && a.boundElements) relayout(a);
      },
      up() {
        assignFrames(all);
        commit(before);
      },
    };
  }

  function startRotate(f) {
    const list = f.single ? [f.el] : f.list.filter((x) => !x.locked && x.type !== "frame");
    const all = withBound(list);
    const ids = new Set(all.map((x) => x.id));
    const arrows = arrowsBoundTo(ids).filter((a) => !ids.has(a.id));
    const before = snap([...all, ...withBound(arrows)]);
    const cx = f.cx;
    const cy = f.cy;
    const a0 = Math.atan2(ptr.wy - cy, ptr.wx - cx);
    const step = Math.PI / 12;
    liveIds = new Set([...ids, ...withBound(arrows).map((a) => a.id)]);
    dirtyStatic = true;
    const centers = new Map(all.map((e) => [e.id, M.elementCenter(e)]));
    gesture = {
      type: "rotate",
      hideHandles: false,
      frame() {
        let d = Math.atan2(ptr.wy - cy, ptr.wx - cx) - a0;
        if (ptr.shift) {
          if (f.single) {
            const o = before.get(f.el.id).angle || 0;
            d = Math.round((o + d) / step) * step - o;
          } else d = Math.round(d / step) * step;
        }
        for (const e of all) {
          if (e.type === "text" && e.containerId && ids.has(e.containerId)) continue;
          const o = before.get(e.id);
          const [ocx, ocy] = centers.get(e.id);
          const [ncx, ncy] = M.rotatePoint(ocx, ocy, cx, cy, d);
          e.x = o.x + (ncx - ocx);
          e.y = o.y + (ncy - ocy);
          e.angle = normAngle((o.angle || 0) + d);
        }
        for (const e of all) if (e.boundElements && e.type !== "arrow") relayout(e);
        for (const a of arrows) if (refreshArrow(a, byId) && a.boundElements) relayout(a);
      },
      up() {
        for (const e of all) M.bumpVersion(e);
        commit(before);
      },
    };
  }

  /**
   * Slant the selection from a side: the dragged edge slides along itself and the
   * opposite one stays (Alt: the middle stays). Lines, arrows and pen strokes are
   * slanted point by point; shapes, text and pictures cannot slant, so they move
   * with it, staying upright.
   */
  function startSkew(f, handle) {
    const list = f.single ? [f.el] : f.list.filter((x) => !x.locked && x.type !== "frame");
    const all = withBound(list);
    const ids = new Set(all.map((x) => x.id));
    const arrows = arrowsBoundTo(ids).filter((a) => !ids.has(a.id));
    const before = snap([...all, ...withBound(arrows)]);
    const { cx, cy, angle } = f;
    const horiz = handle === "n" || handle === "s";
    const sign = handle === "s" || handle === "e" ? 1 : -1;
    const half = horiz ? (f.y2 - f.y1) / 2 : (f.x2 - f.x1) / 2;
    const local = (x, y) => { const [a, b] = M.rotatePoint(x, y, cx, cy, -angle); return [a - cx, b - cy]; };
    const [lx0, ly0] = local(ptr.wx, ptr.wy);
    const pts0 = new Map(all.filter(hasPoints).map((e) => [e.id, M.absolutePoints(e)]));
    const centers = new Map(all.map((e) => [e.id, M.elementCenter(e)]));
    liveIds = new Set([...ids, ...withBound(arrows).map((a) => a.id)]);
    dirtyStatic = true;
    gesture = {
      type: "skew",
      hideHandles: true,
      frame() {
        const [lx, ly] = local(ptr.wx, ptr.wy);
        let d = horiz ? lx - lx0 : ly - ly0;
        const anchor = ptr.alt ? 0 : -sign * half;
        const span = sign * half - anchor || 1;
        // Shift: in steps of 15°
        if (ptr.shift) { const st = Math.tan(Math.PI / 12); d = Math.round(d / span / st) * st * span; }
        const k = d / span;
        const slant = (x, y) => {
          const [rx, ry] = local(x, y);
          const nx = horiz ? rx + k * (ry - anchor) : rx;
          const ny = horiz ? ry : ry + k * (rx - anchor);
          return M.rotatePoint(nx + cx, ny + cy, cx, cy, angle);
        };
        for (const e of all) {
          if (e.type === "text" && e.containerId && ids.has(e.containerId)) continue;
          const o = before.get(e.id);
          if (pts0.has(e.id)) {
            Object.assign(e, { x: o.x, y: o.y, points: o.points, width: o.width, height: o.height });
            Object.assign(e, M.linearFromAbsolute(e, pts0.get(e.id).map((p) => slant(p[0], p[1]))));
          } else {
            const [ocx, ocy] = centers.get(e.id);
            const [ncx, ncy] = slant(ocx, ocy);
            e.x = o.x + (ncx - ocx);
            e.y = o.y + (ncy - ocy);
          }
          M.bumpVersion(e);
          R.forget(e);
        }
        for (const e of all) if (e.boundElements && e.type !== "arrow") relayout(e);
        for (const a of arrows) if (refreshArrow(a, byId) && a.boundElements) relayout(a);
      },
      up() {
        assignFrames(all);
        commit(before);
      },
    };
  }

  function insertPoint(e, index) {
    const abs = M.absolutePoints(e);
    const a = abs[index - 1];
    const b = abs[index];
    abs.splice(index, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    Object.assign(e, M.linearFromAbsolute(e, abs));
    M.bumpVersion(e);
    if (pointEdit && pointEdit.id === e.id) pointEdit.sel = new Set([index]);
    return index;
  }

  function startPointDrag(e, index, ev, before) {
    if (e.locked) return;
    const editingPts = pointEdit && pointEdit.id === e.id;
    if (editingPts) {
      if (ev.shiftKey) {
        if (pointEdit.sel.has(index)) pointEdit.sel.delete(index);
        else pointEdit.sel.add(index);
      } else if (!pointEdit.sel.has(index)) pointEdit.sel = new Set([index]);
    }
    const idxs = editingPts ? [...pointEdit.sel] : [index];
    if (!idxs.length) return;
    for (const x of withBound([e])) if (!before.has(x.id)) before.set(x.id, M.snapshot(x));
    const abs0 = M.absolutePoints(e);
    const n = abs0.length;
    const x0 = ptr.wx;
    const y0 = ptr.wy;
    const ends = idxs.filter((i) => i === 0 || i === n - 1);
    liveIds = new Set(withBound([e]).map((x) => x.id));
    dirtyStatic = true;
    let moved = false;
    gesture = {
      type: "point",
      frame() {
        moved = true;
        const dx = ptr.wx - x0;
        const dy = ptr.wy - y0;
        const abs = abs0.map((p) => p.slice());
        bindTarget = null;
        for (const i of idxs) {
          let nx = abs0[i][0] + dx;
          let ny = abs0[i][1] + dy;
          if (idxs.length === 1) {
            if (ptr.shift && n > 1) {
              const nb = abs0[i === 0 ? 1 : i - 1];
              [nx, ny] = M.snapAngle(nb[0], nb[1], nx, ny);
            } else if (e.type === "arrow" && ends.length && !ptr.ctrl && !dimOfOverlay(e)) {
              bindTarget = M.bindingCandidate(els, nx, ny, new Set([e.id]), view.k);
            }
            if (!bindTarget && gridOn && !ptr.shift) { nx = snapG(nx); ny = snapG(ny); }
            // a dimension's end: onto the drawing's key points and a picture's edges
            if (measure && dimOfOverlay(e) && !ptr.shift) { const sp = measure.snapEnd(abs0[i][0] + dx, abs0[i][1] + dy); if (sp) [nx, ny] = sp; }
            // a line's last point snaps onto its first to close the shape
            if (e.type === "line" && n > 2 && (i === 0 || i === n - 1)) {
              const other = abs0[i === 0 ? n - 1 : 0];
              if (Math.hypot(other[0] - nx, other[1] - ny) * view.k < 10) { nx = other[0]; ny = other[1]; }
            }
          }
          abs[i] = [nx, ny];
        }
        Object.assign(e, M.linearFromAbsolute(e, abs));
        M.bumpVersion(e);
        if (e.boundElements) relayout(e);
      },
      up() {
        if (measure && dimOfOverlay(e)) measure.endDone();
        if (!moved) return;
        if (e.type === "arrow" && !dimOfOverlay(e)) {
          for (const i of ends) {
            const which = i === 0 ? "start" : "end";
            const [px, py] = M.absolutePoint(e, i);
            const t = ptr.ctrl ? null : M.bindingCandidate(els, px, py, new Set([e.id]), view.k);
            setBinding(e, which, t, before);
          }
          if (ends.length) refreshArrow(e, byId);
        }
        M.bumpVersion(e);
        if (e.boundElements) relayout(e);
        commit(before);
      },
    };
  }

  function deletePoints() {
    const e = byId.get(pointEdit.id);
    if (!e) return;
    const n = e.points.length;
    const drop = pointEdit.sel;
    if (n - drop.size < 2) {
      deleteElements([e]);
      pointEdit = null;
      hideHint();
      return;
    }
    const before = snap([e]);
    const abs = M.absolutePoints(e).filter((p, i) => !drop.has(i));
    if (drop.has(0) && e.startBinding) setBinding(e, "start", null, before);
    if (drop.has(n - 1) && e.endBinding) setBinding(e, "end", null, before);
    Object.assign(e, M.linearFromAbsolute(e, abs));
    M.bumpVersion(e);
    pointEdit.sel = new Set();
    commit(before);
    invalidate();
  }

  function afterCreate() {
    if (!toolLocked) setTool("select");
  }

  function startShape(type) {
    let x0 = ptr.wx;
    let y0 = ptr.wy;
    if (gridOn) { x0 = snapG(x0); y0 = snapG(y0); }
    else if (!ptr.ctrl) [x0, y0] = measure.snapToGuides(x0, y0); // a shape begun on a guide begins ON the guide
    const sticky = type === "sticky";
    const e = M.newElement(sticky ? "rectangle" : type, { x: x0, y: y0 }, style);
    if (type === "frame") e.name = `Frame ${frames.size + 1}`;
    if (sticky) {
      // paper, not ink: no outline, no wobble
      Object.assign(e, { backgroundColor: style.stickyColor || R.STICKY_DEFAULT, fillStyle: "solid", strokeColor: "transparent", strokeWidth: 1, roughness: 0, roundness: null, customData: { sticky: true } });
    }
    addElement(e);
    const before = new Map([[e.id, { ...e, isDeleted: true }]]);
    const selBefore = [...selected];
    liveIds = new Set([e.id]);
    dirtyStatic = true;
    const sx = ptr.sx;
    const sy = ptr.sy;
    let others = null;
    gesture = {
      type: "create",
      hideHandles: true,
      frame() {
        let px = ptr.wx;
        let py = ptr.wy;
        guides = [];
        if (gridOn && !ptr.ctrl) { px = snapG(px); py = snapG(py); }
        else if (guidesOn && !ptr.ctrl) {
          if (!others) others = snapCandidates(new Set([e.id]));
          const r = M.snapGuides([px, py, px, py], others, SNAP_PX / view.k);
          px += r.dx;
          py += r.dy;
          guides = r.guides;
        }
        let w = px - x0;
        let hh = py - y0;
        if (ptr.shift) {
          const s = Math.max(Math.abs(w), Math.abs(hh));
          w = (w < 0 ? -1 : 1) * s;
          hh = (hh < 0 ? -1 : 1) * s;
        }
        let aw = Math.abs(w);
        let ah = Math.abs(hh);
        let x = w < 0 ? x0 + w : x0;
        let y = hh < 0 ? y0 + hh : y0;
        if (ptr.alt) { x = x0 - aw; y = y0 - ah; aw *= 2; ah *= 2; }
        e.x = x;
        e.y = y;
        e.width = aw;
        e.height = ah;
        M.bumpVersion(e);
      },
      up() {
        if (Math.hypot(ptr.sx - sx, ptr.sy - sy) < DRAG_PX * 2 || e.width * view.k < 2 || e.height * view.k < 2) {
          // a click places a comfortable default size
          const dw = type === "frame" ? 480 : sticky ? 200 : type === "rectangle" ? 160 : 120;
          const dh = type === "frame" ? 320 : sticky ? 200 : type === "rectangle" ? 100 : 120;
          e.x = x0 - dw / 2;
          e.y = y0 - dh / 2;
          e.width = dw;
          e.height = dh;
          M.bumpVersion(e);
        }
        if (type === "frame") {
          refreshFrames();
          for (const x of els) {
            if (x.isDeleted || x === e || x.type === "frame" || x.frameId) continue;
            const b = M.elementBounds(x);
            if (b[0] >= e.x && b[1] >= e.y && b[2] <= e.x + e.width && b[3] <= e.y + e.height) {
              before.set(x.id, M.snapshot(x));
              x.frameId = e.id;
              M.bumpVersion(x);
            }
          }
          // frames sit under what they hold
          const orderBefore = els.map((x) => x.id);
          els.splice(els.indexOf(e), 1);
          els.unshift(e);
          setSelection([e.id]);
          commit(before, { selBefore, order: { before: orderBefore, after: els.map((x) => x.id) } });
        } else {
          assignFrames([e]);
          setSelection([e.id]);
          commit(before, { selBefore });
        }
        afterCreate();
        // a new sticky note is for writing on
        if (sticky) editContainer(e);
      },
    };
  }

  function moveLastPoint(e) {
    const abs = M.absolutePoints(e);
    const n = abs.length;
    let px = ptr.wx;
    let py = ptr.wy;
    const prev = abs[n - 2];
    bindTarget = null;
    if (ptr.shift) [px, py] = M.snapAngle(prev[0], prev[1], px, py);
    else if (e.type === "arrow" && !ptr.ctrl) bindTarget = M.bindingCandidate(els, px, py, new Set([e.id]), view.k);
    if (!bindTarget && gridOn && !ptr.shift && !ptr.ctrl) { px = snapG(px); py = snapG(py); }
    else if (!bindTarget && !ptr.shift && !ptr.ctrl) [px, py] = measure.snapToGuides(px, py);
    if (e.type === "line" && n > 3 && Math.hypot(abs[0][0] - px, abs[0][1] - py) * view.k < 10) { px = abs[0][0]; py = abs[0][1]; }
    abs[n - 1] = [px, py];
    Object.assign(e, M.linearFromAbsolute(e, abs));
    M.bumpVersion(e);
    dirtyOver = true;
  }

  function linearDown(type) {
    if (draft) return draftClick();
    let x0 = ptr.wx;
    let y0 = ptr.wy;
    const startTarget = type === "arrow" && !ptr.ctrl ? M.bindingCandidate(els, x0, y0, null, view.k) : null;
    if (gridOn && !startTarget) { x0 = snapG(x0); y0 = snapG(y0); }
    else if (!startTarget && !ptr.ctrl) [x0, y0] = measure.snapToGuides(x0, y0);
    const e = M.newElement(type, { x: x0, y: y0, points: [[0, 0], [0, 0]] }, style);
    addElement(e);
    const before = new Map([[e.id, { ...e, isDeleted: true }]]);
    const selBefore = [...selected];
    setSelection([]);
    liveIds = new Set([e.id]);
    dirtyStatic = true;
    const sx = ptr.sx;
    const sy = ptr.sy;
    gesture = {
      type: "linear",
      hideHandles: true,
      frame() { moveLastPoint(e); },
      up() {
        if (Math.hypot(ptr.sx - sx, ptr.sy - sy) < DRAG_PX * 2) {
          // click, click, click: keep adding points until Enter or a double click
          draft = { el: e, before, startTarget, selBefore };
          liveIds = new Set([e.id]);
          showHint(type === "line" ? "Click to add points. Click the first point to close, Enter or double-click to finish" : "Click to add points. Enter or double-click to finish");
          return;
        }
        finishLinear(e, before, startTarget, selBefore, false);
      },
    };
  }

  function draftClick() {
    const e = draft.el;
    moveLastPoint(e);
    const abs = M.absolutePoints(e);
    const n = abs.length;
    const last = abs[n - 1];
    const prev = abs[n - 2];
    const closed = e.type === "line" && n > 3 && last[0] === abs[0][0] && last[1] === abs[0][1];
    const same = Math.hypot(last[0] - prev[0], last[1] - prev[1]) * view.k < 6;
    if (closed) return finishDraft(false);
    if (same) return finishDraft(true);
    if (e.type === "arrow" && bindTarget) return finishDraft(false);
    abs.push([last[0], last[1]]);
    Object.assign(e, M.linearFromAbsolute(e, abs));
    M.bumpVersion(e);
    invalidate(false);
  }

  function finishDraft(dropLast = true) {
    if (!draft) return;
    const d = draft;
    finishLinear(d.el, d.before, d.startTarget, d.selBefore, dropLast);
  }

  function finishLinear(e, before, startTarget, selBefore, dropLast) {
    draft = null;
    hideHint();
    liveIds = new Set();
    bindTarget = null;
    if (dropLast && e.points.length > 2) {
      const abs = M.absolutePoints(e);
      abs.pop();
      Object.assign(e, M.linearFromAbsolute(e, abs));
    }
    if (M.polylineLength(e.points) * view.k < 4) {
      e.isDeleted = true;
      invalidate();
      if (!toolLocked) setTool("select");
      return;
    }
    if (e.type === "arrow") {
      if (startTarget && !startTarget.isDeleted) setBinding(e, "start", startTarget, before);
      const [ex, ey] = M.absolutePoint(e, -1);
      const endT = ptr.ctrl ? null : M.bindingCandidate(els, ex, ey, new Set([e.id]), view.k);
      if (endT) setBinding(e, "end", endT, before);
      if (e.startBinding || e.endBinding) refreshArrow(e, byId);
    }
    M.bumpVersion(e);
    assignFrames([e]);
    setSelection([e.id]);
    commit(before, { selBefore });
    invalidate();
    afterCreate();
  }

  function startFreedraw(ev) {
    const pen = ev.pointerType === "pen";
    const b = currentBrush();
    const e = M.newElement("freedraw", { x: ptr.wx, y: ptr.wy, points: [[0, 0]], pressures: pen ? [ev.pressure || 0.5] : [], simulatePressure: !pen, strokeWidth: penWidth() }, style);
    // the brush travels with the stroke; the plain pen stays plain Excalidraw
    if (!B.isPlain(b)) e.customData = { brush: B.brushData(b) };
    e.opacity = Math.round((style.opacity ?? 100) * b.opacity);
    addElement(e);
    const before = new Map([[e.id, { ...e, isDeleted: true, points: [[0, 0]] }]]);
    liveIds = new Set([e.id]);
    dirtyStatic = true;
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    let lx = ptr.wx;
    let ly = ptr.wy;
    const add = (cx, cy, p) => {
      const wx = toWorldX(cx - rect.left);
      const wy = toWorldY(cy - rect.top);
      if (Math.hypot(wx - lx, wy - ly) * view.k < 0.7) return;
      lx = wx;
      ly = wy;
      const px = Math.round((wx - e.x) * 100) / 100;
      const py = Math.round((wy - e.y) * 100) / 100;
      e.points.push([px, py]);
      if (pen) e.pressures.push(p > 0 ? Math.round(p * 1000) / 1000 : 0.5);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    };
    gesture = {
      type: "freedraw",
      hideHandles: true,
      move(me) {
        const list = me.getCoalescedEvents ? me.getCoalescedEvents() : null;
        if (list && list.length) for (const c of list) add(c.clientX, c.clientY, c.pressure);
        else add(me.clientX, me.clientY, me.pressure);
        e.width = maxX - minX;
        e.height = maxY - minY;
        M.bumpVersion(e);
      },
      up() {
        e.points = e.points.slice();
        if (pen) e.pressures = e.pressures.slice();
        e.lastCommittedPoint = e.points[e.points.length - 1];
        M.bumpVersion(e);
        assignFrames([e]);
        commit(before);
      },
    };
  }

  function eraseAt(x, y) {
    const t = HIT_PX / view.k;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.isDeleted || e.locked || erasing.has(e.id)) continue;
      const b = R.boundsOf(e);
      if (x < b[0] - t || x > b[2] + t || y < b[1] - t || y > b[3] + t) continue;
      const tt = e.type === "freedraw" ? t + e.strokeWidth * Math.max(0, R.brushReach(e) - 2.2) : t;
      if (!M.hitTest(e, x, y, tt)) continue;
      for (const u of withBound(unitOf(e))) erasing.add(u.id);
      dirtyStatic = true;
    }
  }

  // cut mode: freehand strokes lose what the eraser passes over; the pieces
  // replace the stroke when the eraser lifts
  const cutPieces = new Map(); // original id -> [pieces] (live, not yet in els)
  function cutAt(x, y) {
    const r = eraseSize / 2 / view.k;
    const reach = (e) => r + e.strokeWidth * R.brushReach(e) * 0.35;
    const test = (e) => {
      const b = R.boundsOf(e);
      const rr = reach(e);
      return !(x < b[0] - rr || x > b[2] + rr || y < b[1] - rr || y > b[3] + rr);
    };
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.isDeleted || e.locked || e.type !== "freedraw" || erasing.has(e.id) || (e.groupIds && e.groupIds.length)) continue;
      if (!test(e)) continue;
      const runs = M.cutFreedraw(e, x, y, reach(e));
      if (!runs) continue;
      erasing.add(e.id);
      cutPieces.set(e.id, runs.map((run) => M.freedrawPiece(e, run)));
      dirtyStatic = true;
    }
    // pieces already cut can be cut again
    for (const [id, pieces] of cutPieces) {
      let changed = false;
      const next = [];
      for (const p of pieces) {
        if (!test(p)) { next.push(p); continue; }
        const runs = M.cutFreedraw(p, x, y, reach(p));
        if (!runs) { next.push(p); continue; }
        changed = true;
        for (const run of runs) next.push(M.freedrawPiece(p, run));
      }
      if (changed) cutPieces.set(id, next);
    }
  }

  function startEraser() {
    erasing.clear();
    cutPieces.clear();
    const cut = eraseMode === "cut" !== ptr.alt; // Alt flips the mode for one stroke
    const at = cut ? cutAt : eraseAt;
    let lx = ptr.wx;
    let ly = ptr.wy;
    at(lx, ly);
    eraserTrail.push({ x: ptr.sx, y: ptr.sy, t: performance.now() });
    gesture = {
      type: "eraser",
      hideHandles: true,
      move() { eraserTrail.push({ x: ptr.sx, y: ptr.sy, t: performance.now() }); },
      frame() {
        const d = Math.hypot(ptr.wx - lx, ptr.wy - ly) * view.k;
        const steps = Math.max(1, Math.ceil(d / (cut ? Math.max(2, eraseSize / 4) : 4)));
        for (let s = 1; s <= steps; s++) at(lx + ((ptr.wx - lx) * s) / steps, ly + ((ptr.wy - ly) * s) / steps);
        lx = ptr.wx;
        ly = ptr.wy;
      },
      draw(c) {
        // cut pieces preview on the overlay
        for (const pieces of cutPieces.values()) for (const p of pieces) R.drawElement(c, p, drawOpts);
      },
      up() {
        const list = [...erasing].map((id) => byId.get(id)).filter(Boolean);
        erasing.clear();
        if (!cut) return deleteElements(list);
        applyCut(list);
      },
      cancel() { erasing.clear(); cutPieces.clear(); },
    };
  }

  function applyCut(list) {
    if (!list.length) return;
    const before = snap(list);
    const selBefore = [...selected];
    for (const e of list) {
      const pieces = cutPieces.get(e.id) || [];
      let after = e;
      for (const p of pieces) {
        addElement(p, after);
        before.set(p.id, { ...p, isDeleted: true });
        after = p;
      }
      e.isDeleted = true;
      M.bumpVersion(e);
      selected.delete(e.id);
    }
    cutPieces.clear();
    commit(before, { selBefore });
    invalidate();
    schedulePanel();
  }

  /** The stored colour under a point: what the element was drawn with. */
  function sampleColor(wx, wy) {
    const e = hitAt(wx, wy, { raw: true, locked: true });
    if (!e || e.type === "image" || e.type === "frame") return null;
    if (e.type === "text") return e.strokeColor;
    if ((M.SHAPES.has(e.type) || M.isSticky(e)) && M.hasFill(e)) {
      if (M.isTransparent(e.strokeColor) || M.shapeDistance(e, wx, wy) < -(e.strokeWidth + 3 / view.k)) return e.backgroundColor;
    }
    return M.isTransparent(e.strokeColor) ? e.backgroundColor : e.strokeColor;
  }

  function pickColor(ev) {
    let col = sampleColor(ptr.wx, ptr.wy);
    if (!col) {
      // pictures: read the pixel as it shows
      const hit = hitAt(ptr.wx, ptr.wy, { locked: true });
      if (hit && hit.type === "image") {
        try {
          const d = ctx.getImageData(Math.round(ptr.sx * dpr), Math.round(ptr.sy * dpr), 1, 1).data;
          if (d[3]) col = M.toHex(d[0], d[1], d[2]);
        } catch { /* tainted */ }
      }
    }
    if (!col || M.isTransparent(col)) {
      toast("No colour there. Click a stroke, a fill or a picture", { ms: 1600 });
      return;
    }
    const key = ev.altKey ? "backgroundColor" : "strokeColor";
    applyStyle(key, col);
    toast(`${key === "strokeColor" ? "Stroke" : "Fill"} colour ${col}${ev.altKey ? "" : " (Alt-click picks a fill)"}`, { ms: 1500 });
    if (!peek) setTool(pickerReturn || "select");
  }

  function pushRecent(c) {
    if (!c || M.isTransparent(c)) return;
    const v = c.toLowerCase();
    const next = [v, ...recentColors.filter((x) => x !== v)].slice(0, 8);
    if (next.join() === recentColors.join()) return;
    recentColors = next;
    saveSetting("sketchRecentColors", recentColors);
  }

  function startLaser() {
    const stroke = { pts: [{ x: ptr.wx, y: ptr.wy, t: performance.now() }], active: true };
    laser.push(stroke);
    gesture = {
      type: "laser",
      move() {
        stroke.pts.push({ x: ptr.wx, y: ptr.wy, t: performance.now() });
        if (stroke.pts.length > 600) stroke.pts.shift();
      },
      up() { stroke.active = false; },
    };
  }

  function textDown() {
    const raw = hitAt(ptr.wx, ptr.wy, { raw: true });
    if (raw && raw.type === "text") return editText(raw);
    const hit = hitAt(ptr.wx, ptr.wy) || containerAt(ptr.wx, ptr.wy);
    if (hit && M.canContainText(hit)) return editContainer(hit);
    createText(ptr.wx, ptr.wy);
  }

  function onDblClick(e) {
    if (readOnly || draft || destroyed) return;
    updatePtr(e);
    if (tool !== "select") return;
    // a note card opens its note (Shift: to the side)
    const top = hitAt(ptr.wx, ptr.wy);
    if (top && M.isNoteCard(top) && !(selectedEls().length > 1 && selected.has(top.id))) {
      openCardNote(top, e.shiftKey);
      return;
    }
    const raw = hitAt(ptr.wx, ptr.wy, { raw: true });
    if (raw && raw.type === "text") {
      const c = raw.containerId && alive(raw.containerId);
      if (c && c.type !== "arrow") return editContainer(c);
      return editText(raw);
    }
    const hit = hitAt(ptr.wx, ptr.wy) || containerAt(ptr.wx, ptr.wy);
    if (!hit) return createText(ptr.wx, ptr.wy);
    // inside a selected group, a double click picks one member
    const gid = M.selectGroupId(hit, editingGroup);
    if (gid && selectedEls().length > 1 && selected.has(hit.id)) {
      editingGroup = gid;
      setSelection([hit.id]);
      return;
    }
    if (isLinear(hit)) {
      pointEdit = { id: hit.id, sel: new Set() };
      setSelection([hit.id]);
      showHint("Drag points to reshape. Click a midpoint to add one, Delete removes, Esc when done");
      return;
    }
    if (M.canContainText(hit)) return editContainer(hit);
  }

  /* ── text editing ─────────────────────────────────────────────────────── */
  function createText(wx, wy) {
    if (readOnly) return;
    const t = M.newElement("text", { x: gridOn ? snapG(wx) : wx, y: wy }, style);
    t.height = t.fontSize * t.lineHeight;
    t.y = wy - t.height / 2;
    addElement(t);
    openEditor(t, { isNew: true, before: new Map([[t.id, { ...t, isDeleted: true }]]) });
  }

  function editText(t) {
    if (t.locked || readOnly) return;
    if (t.containerId) {
      const c = alive(t.containerId);
      if (c) return editContainer(c);
    }
    openEditor(t, { isNew: false, before: snap([t]) });
  }

  function editContainer(c) {
    if (c.locked || readOnly) return;
    let t = boundTextOf(c);
    const before = snap([c, ...arrowsBoundTo(new Set([c.id]))]);
    const isNew = !t;
    if (!t) {
      t = M.newElement("text", {
        containerId: c.id,
        textAlign: "center",
        verticalAlign: "middle",
        strokeColor: c.type === "arrow" || M.isTransparent(c.strokeColor) ? style.strokeColor : c.strokeColor,
        opacity: c.opacity,
        groupIds: (c.groupIds || []).slice(),
        frameId: c.frameId || null,
        angle: c.type === "arrow" ? 0 : c.angle || 0,
      }, style);
      before.set(t.id, { ...t, isDeleted: true });
      addElement(t, c);
      addBoundRef(c, t.id, "text");
      relayout(c);
    } else before.set(t.id, M.snapshot(t));
    openEditor(t, { isNew, before, container: c });
  }

  function openEditor(t, o) {
    if (editing) finishText();
    const ta = h("textarea", { class: "sk-text-editor", spellcheck: false, autocomplete: "off" });
    ta.value = t.originalText != null ? t.originalText : t.text;
    root.append(ta);
    editing = { el: t, ta, isNew: o.isNew, before: o.before, container: o.container || (t.containerId ? alive(t.containerId) : null), selBefore: [...selected] };
    selected.clear();
    placeEditor();
    // opened from a press: the browser still moves focus to the canvas after
    // this handler, so take focus once that has happened
    const takeFocus = () => {
      if (!editing || editing.ta !== ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
      if (!o.isNew && ta.value) ta.select();
      ta.addEventListener("blur", () => { if (editing && editing.ta === ta) finishText(); });
    };
    if (ptr.down) setTimeout(takeFocus);
    else takeFocus();
    ta.addEventListener("input", onEditorInput);
    ta.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape" || (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey))) {
        ev.preventDefault();
        finishText();
        root.focus({ preventScroll: true });
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText("    ", s, ta.selectionEnd, "end");
        onEditorInput();
      }
    });
    ta.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    ta.addEventListener("wheel", (ev) => { ev.preventDefault(); onWheel(ev); }, { passive: false });
    showHint("Esc or click outside when done. Ctrl+Enter works too");
    invalidate();
    schedulePanel();
  }

  function onEditorInput() {
    if (!editing) return;
    const t = editing.el;
    t.originalText = editing.ta.value;
    if (editing.container) relayout(editing.container);
    else {
      t.text = t.originalText;
      measureStandalone(t);
    }
    M.bumpVersion(t);
    placeEditor();
    invalidate();
    // said at once: a drawing closed (Ctrl+W, Alt+F4) while a text is still being typed is saved with it
    changes++;
    notify();
  }

  function placeEditor() {
    if (!editing) return;
    const { el: t, ta, container } = editing;
    const k = view.k;
    let w = t.width;
    let x = t.x;
    let wrap = false;
    if (container && container.type !== "arrow") {
      const maxW = Math.max(1, M.boundTextMaxWidth(container, t.fontSize));
      const f = t.textAlign === "center" ? 0.5 : t.textAlign === "right" ? 1 : 0;
      x = t.x - (maxW - t.width) * f;
      w = maxW;
      wrap = true;
    }
    const lh = t.fontSize * t.lineHeight;
    const s = ta.style;
    s.left = toScreenX(x) + "px";
    s.top = toScreenY(t.y) + "px";
    s.width = Math.max(w * k, 2) + (wrap ? 0 : t.fontSize * k) + "px";
    s.height = Math.max(t.height, lh) * k + "px";
    s.font = `${t.fontSize * k}px ${R.fontStack(t.fontFamily)}`;
    s.lineHeight = String(t.lineHeight);
    s.textAlign = t.textAlign;
    s.color = M.themeColor(t.strokeColor, dark);
    s.opacity = String((t.opacity ?? 100) / 100);
    s.whiteSpace = wrap ? "pre-wrap" : "pre";
    s.transform = t.angle ? `rotate(${t.angle}rad)` : "";
    // unwrapped text grows from its anchor; keep the caret end in view
    if (!wrap && t.textAlign !== "left") s.marginLeft = (t.textAlign === "center" ? -t.fontSize * k / 2 : -t.fontSize * k) + "px";
    else s.marginLeft = "0px";
  }

  function finishText() {
    const ed = editing;
    if (!ed) return;
    editing = null;
    ed.ta.remove();
    hideHint();
    const t = ed.el;
    const blank = !String(t.originalText || "").trim();
    if (blank) {
      t.isDeleted = true;
      M.bumpVersion(t);
      if (ed.container) {
        dropBoundRef(ed.container, t.id);
        relayout(ed.container);
      }
      if (ed.isNew && !ed.container) {
        setSelection(ed.selBefore.filter((id) => id !== t.id));
        invalidate();
        // typed, saved meanwhile, then emptied: that save holds it, so the drawing saves again without it
        changes++;
        notify();
        return;
      }
    } else M.bumpVersion(t);
    if (!blank) setSelection([ed.container ? ed.container.id : t.id]);
    commit(ed.before, { selBefore: ed.selBefore });
    invalidate();
    schedulePanel();
    if (tool === "text" && !toolLocked) setTool("select");
  }

  /* ── pictures ─────────────────────────────────────────────────────────── */
  function ensureImage(fileId) {
    return new Promise((res) => {
      const img = getImage(fileId);
      if (img) return res(img);
      const rec = images.get(fileId);
      if (!rec) return res(null);
      rec.img.addEventListener("load", () => res(rec.img), { once: true });
      rec.img.addEventListener("error", () => res(null), { once: true });
    });
  }

  async function insertImages(list, at) {
    if (readOnly) return false;
    const pics = [...list].filter((f) => f && f.type && f.type.startsWith("image/"));
    if (!pics.length) return false;
    let x = at ? at[0] : toWorldX(W / 2);
    let y = at ? at[1] : toWorldY(H / 2);
    const created = [];
    const before = new Map();
    const selBefore = [...selected];
    for (const f of pics) {
      try {
        const p = await prepareImage(f);
        if (destroyed) return true;
        const id = await sha1(p.dataURL);
        if (!files[id]) files[id] = { mimeType: p.mimeType, id, dataURL: p.dataURL, created: now(), lastRetrieved: now() };
        // placed at a size that sits comfortably in view
        const maxW = Math.min(560, (W * 0.55) / view.k);
        const maxH = (H * 0.55) / view.k;
        const s = Math.min(1, maxW / p.width, maxH / p.height);
        const w = Math.round(p.width * s);
        const hh = Math.round(p.height * s);
        const e = M.newElement("image", { x: x - w / 2, y: y - hh / 2, width: w, height: hh, fileId: id }, style);
        addElement(e);
        before.set(e.id, { ...e, isDeleted: true });
        created.push(e);
        x += 24;
        y += 24;
      } catch (err) {
        toast("Could not add the picture: " + (err && err.message ? err.message : err), { kind: "error" });
      }
    }
    if (!created.length) return true;
    assignFrames(created);
    if (tool !== "select") setTool("select");
    setSelection(created.map((e) => e.id));
    commit(before, { selBefore });
    dirtyMap = true;
    invalidate();
    return true;
  }

  fileInput.addEventListener("change", () => {
    const list = [...fileInput.files];
    fileInput.value = "";
    if (list.length) insertImages(list, null);
    root.focus({ preventScroll: true });
  });

  function onDragOver(e) {
    if (!e.dataTransfer || readOnly) return;
    const types = [...e.dataTransfer.types];
    if (types.includes("application/x-leonote-paths")) {
      // notes from the file tree become cards; keep the drop here
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      root.classList.add("is-drop");
      return;
    }
    if (types.includes("Files") || types.includes("text/plain")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  function onDragLeave(e) {
    if (!e.relatedTarget || !root.contains(e.relatedTarget)) root.classList.remove("is-drop");
  }

  async function onDrop(e) {
    if (!e.dataTransfer || readOnly) return;
    updateRect();
    const at = [toWorldX(e.clientX - rect.left), toWorldY(e.clientY - rect.top)];
    root.classList.remove("is-drop");
    const raw = e.dataTransfer.getData("application/x-leonote-paths");
    if (raw) {
      e.preventDefault();
      e.stopPropagation();
      let paths = [];
      try { paths = JSON.parse(raw); } catch { /* not ours */ }
      if (Array.isArray(paths) && paths.length) {
        root.focus({ preventScroll: true });
        addNoteCards(paths.filter((p) => typeof p === "string"), at);
      }
      return;
    }
    const list = [...e.dataTransfer.files];
    if (list.length) {
      e.preventDefault();
      e.stopPropagation();
      const drawings = list.filter((f) => /\.(leocanvas|leopaint|leovector|excalidraw|json)$/i.test(f.name));
      for (const f of drawings) {
        const data = M.parseClipboard(await f.text());
        if (data) pasteData(data, at);
      }
      await insertImages(list, at);
      return;
    }
    const txt = e.dataTransfer.getData("text/plain");
    if (txt) {
      e.preventDefault();
      e.stopPropagation();
      const data = M.parseClipboard(txt);
      if (data) pasteData(data, at);
      else pasteText(txt, at);
    }
  }

  /* ── clipboard ────────────────────────────────────────────────────────── */
  const ownsKeys = () => !destroyed && !editing && document.activeElement === root;
  let pastePending = false;

  function copyPayload() {
    const list = withBound(selectedEls());
    if (!list.length) return null;
    sketchClip = M.clipboardPayload(list, files);
    return sketchClip;
  }

  function onCopy(e) {
    if (!ownsKeys()) return;
    const p = copyPayload();
    if (!p) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", JSON.stringify(p));
  }

  function onCut(e) {
    if (!ownsKeys() || readOnly) return;
    const p = copyPayload();
    if (!p) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", JSON.stringify(p));
    deleteSelection();
  }

  const pasteAt = () => (ptr.inside ? [ptr.wx, ptr.wy] : [toWorldX(W / 2), toWorldY(H / 2)]);

  async function onPaste(e) {
    if (!ownsKeys() || readOnly) return;
    pastePending = false;
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    const at = pasteAt();
    const text = cd.getData("text/plain");
    const data = M.parseClipboard(text);
    if (data) return pasteData(data, at);
    const pics = [...cd.files].filter((f) => f.type.startsWith("image/"));
    if (pics.length) return insertImages(pics, at);
    if (text && text.trim()) return pasteText(text, at);
    const html = cd.getData("text/html");
    const m = /<img[^>]+src="(data:image\/[^"]+)"/i.exec(html || "");
    if (m) {
      const blob = await (await fetch(m[1])).blob();
      insertImages([blob], at);
    }
  }

  async function pasteFallback() {
    const at = pasteAt();
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find((t) => t.startsWith("image/"));
          if (type) return insertImages([await it.getType(type)], at);
        }
      }
      const text = navigator.clipboard ? await navigator.clipboard.readText() : "";
      const data = M.parseClipboard(text);
      if (data) return pasteData(data, at);
      if (text && text.trim()) return pasteText(text, at);
    } catch {
      /* no clipboard permission: use our own */
    }
    if (sketchClip) pasteData(sketchClip, at);
  }

  function pasteData(data, at) {
    const list = data.elements.filter((e) => !e.isDeleted);
    if (!list.length || readOnly) return;
    const b = M.commonBounds(list);
    let dx = at[0] - (b[0] + b[2]) / 2;
    let dy = at[1] - (b[1] + b[3]) / 2;
    if (gridOn) {
      dx = snapG(b[0] + dx) - b[0];
      dy = snapG(b[1] + dy) - b[1];
    }
    const selBefore = [...selected];
    if (tool !== "select") setTool("select");
    const { before, tops } = insertCopies(list, dx, dy, data.files);
    assignFrames(tops);
    setSelection(tops.map((e) => e.id));
    commit(before, { selBefore });
    dirtyMap = true;
    invalidate();
  }

  /** A template from sketchtemplates.js, put on the board like a paste (one undo takes it away) and shown whole. */
  async function applyTemplate(id) {
    if (readOnly) return;
    const { TEMPLATE_BY_ID } = await import("./sketchtemplates.js");
    const t = TEMPLATE_BY_ID.get(id);
    if (!t || destroyed) return;
    const k = {
      el: (type, props) => M.newElement(type, { backgroundColor: "transparent", roughness: 0, ...props }, style),
      text: (words, cx, cy, size = 20) => {
        const e = M.newElement("text", { text: words, originalText: words, fontSize: size, textAlign: "center" }, style);
        measureStandalone(e);
        e.x = cx - e.width / 2;
        e.y = cy - e.height / 2;
        return e;
      },
    };
    if (t.pattern) setCanvasLook({ pattern: t.pattern });
    const list = t.build(k);
    if (!list.length) return;
    pasteData({ elements: list, files: {} }, pasteAt());
    fitAll();
  }

  function pasteText(text, at) {
    const v = String(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/\s+$/, "");
    if (!v.trim() || readOnly) return;
    const t = M.newElement("text", { text: v, originalText: v }, style);
    t.textAlign = "left";
    measureStandalone(t);
    t.x = at[0] - t.width / 2;
    t.y = at[1] - t.height / 2;
    if (/^https?:\/\/\S+$/.test(v.trim())) t.link = v.trim();
    addElement(t);
    if (tool !== "select") setTool("select");
    const selBefore = [...selected];
    setSelection([t.id]);
    commit(new Map([[t.id, { ...t, isDeleted: true }]]), { selBefore });
    invalidate();
  }

  async function menuCopy(cut) {
    const p = copyPayload();
    if (!p) return;
    try { await navigator.clipboard.writeText(JSON.stringify(p)); } catch { /* kept in sketchClip */ }
    if (cut) deleteSelection();
  }

  /* ── export ───────────────────────────────────────────────────────────── */
  const exportList = (all) => (all ? visible() : withBound(selectedEls()));

  async function copyPng(all) {
    const list = exportList(all);
    if (!list.length) return toast("Nothing to copy yet", { ms: 1400 });
    await Promise.all(list.filter((e) => e.type === "image").map((e) => ensureImage(e.fileId)));
    const c = R.elementsToCanvas(list, { dark, scale: 2, background: canvasBg, getImage, padding: 20 });
    if (!c) return;
    try {
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast(all ? "Drawing copied as PNG" : "Selection copied as PNG", { ms: 1800 });
    } catch (err) {
      toast("Could not copy the picture: " + (err && err.message ? err.message : err), { kind: "error" });
    }
  }

  async function copySvg(all) {
    const list = exportList(all);
    if (!list.length) return toast("Nothing to copy yet", { ms: 1400 });
    const out = R.elementsToSvg(list, { dark, files, background: canvasBg, padding: 20, canvasBg });
    try {
      await navigator.clipboard.writeText(out.svg);
      toast(all ? "Drawing copied as SVG" : "Selection copied as SVG", { ms: 1800 });
    } catch (err) {
      toast("Could not copy: " + (err && err.message ? err.message : err), { kind: "error" });
    }
  }

  /* ── tools & keys ─────────────────────────────────────────────────────── */
  let pickerReturn = null;
  function setTool(t) {
    if (editing) finishText();
    if (draft) finishDraft(true);
    if (t === "image") {
      if (readOnly) return;
      fileInput.click();
      return;
    }
    if (t === "card") {
      if (!readOnly) openNotePicker(null);
      return;
    }
    // clicking the pen while it is on opens the brushes
    if (t === "freedraw" && tool === "freedraw" && !peek) {
      const b = toolButtons.get("freedraw");
      if (b) openBrushPicker(b);
      return;
    }
    if (t === "picker" && tool !== "picker") pickerReturn = tool;
    if (measure && (t === "measure") !== (tool === "measure")) dirtyStatic = true; // the kept dimensions change hands
    tool = t;
    if (pointEdit) { pointEdit = null; hideHint(); }
    if (t !== "select" && t !== "hand" && t !== "laser" && t !== "picker" && t !== "lasso") {
      editingGroup = null;
      if (selected.size) setSelection([]);
    }
    hover = null;
    setCursor(toolCursor());
    paintToolbar();
    schedulePanel();
    if (measure) measure.toolChanged();
    invalidate(false);
  }

  function toggleToolLock() {
    toolLocked = !toolLocked;
    saveSetting("sketchToolLock", toolLocked);
    paintToolbar();
    toast(toolLocked ? "Tool lock on: tools stay active after drawing (Q)" : "Tool lock off", { ms: 1500 });
  }

  function selectAll() {
    if (tool !== "select") setTool("select");
    editingGroup = null;
    setSelection(els.filter((e) => !e.isDeleted && !e.locked && !(e.type === "text" && e.containerId && alive(e.containerId))).map((e) => e.id));
  }

  function nudge(key, step) {
    const list = withBound(selectedEls().filter((e) => !e.locked));
    const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
    const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
    if (!list.length) {
      setView(view.x - dx * 4, view.y - dy * 4, view.k);
      return;
    }
    if (readOnly) return;
    const ids = new Set(list.map((e) => e.id));
    const arrows = arrowsBoundTo(ids).filter((a) => !ids.has(a.id));
    const before = snap([...list, ...withBound(arrows)]);
    moveBy(list, dx, dy);
    for (const e of list) M.bumpVersion(e);
    refreshArrows(ids, ids);
    commit(before, { key: "nudge" });
    invalidate();
  }

  function escape() {
    if (marq) { marq = null; dirtyOver = true; invalidate(); return; }
    if (helpEl) return toggleHelp(false);
    if (popEl) return closePop();
    if (!searchEl.hidden) return closeSearch();
    if (editing) { finishText(); return; }
    if (draft) return finishDraft(true);
    if (gesture) return cancelGesture();
    if (measure && measure.escape()) return;
    if (pointEdit) {
      pointEdit = null;
      hideHint();
      invalidate(false);
      return;
    }
    if (tool !== "select") return setTool("select");
    if (editingGroup) editingGroup = null;
    if (selected.size) setSelection([]);
  }

  function enter() {
    if (measure && measure.enter()) return;
    const list = selectedEls();
    if (list.length !== 1 || readOnly) return;
    const e = list[0];
    if (e.type === "text") editText(e);
    else if (isLinear(e)) {
      pointEdit = pointEdit && pointEdit.id === e.id ? null : { id: e.id, sel: new Set() };
      if (pointEdit) showHint("Drag points to reshape. Click a midpoint to add one, Delete removes, Esc when done");
      else hideHint();
      invalidate(false);
    } else if (M.canContainText(e)) editContainer(e);
  }

  function onKey(e) {
    if (destroyed || e.defaultPrevented) return;
    if (e.target !== root && typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const code = e.code;
    ptr.shift = e.shiftKey;
    ptr.alt = e.altKey;
    ptr.ctrl = mod;
    if (gesture || draft) { ptr.moved = true; schedule(); }
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (code === "Space" && !mod) {
      stop();
      if (!spaceDown) { spaceDown = true; setCursor(toolCursor()); }
      return;
    }
    if (e.key === "Escape") { stop(); escape(); return; }
    if (mod) {
      switch (code) {
        case "KeyF": if (!e.shiftKey && !e.altKey) { stop(); openSearch(); } return;
        case "KeyZ": stop(); return e.shiftKey ? doRedo() : doUndo();
        case "KeyY": stop(); return doRedo();
        case "KeyA": stop(); return selectAll();
        case "KeyD": stop(); return duplicateSelection();
        case "KeyG": stop(); return e.shiftKey ? ungroupSelection() : groupSelection();
        case "KeyL": if (e.shiftKey) { stop(); toggleLock(); } return;
        case "KeyK": if (selected.size) { stop(); editLink(); } return;
        case "Digit0":
        case "Numpad0": stop(); return fitAll();
        case "Digit1":
        case "Numpad1": stop(); return zoomTo(1);
        case "KeyJ": stop(); return duplicateSelection();
        case "Equal":
        case "NumpadAdd": stop(); return zoomBy(1.2);
        case "Minus":
        case "NumpadSubtract": stop(); return zoomBy(1 / 1.2);
        case "BracketRight": stop(); return layer(e.shiftKey ? "front" : "forward");
        case "BracketLeft": stop(); return layer(e.shiftKey ? "back" : "backward");
        case "KeyC": if (e.altKey) { stop(); copyStyle(); } return;
        case "KeyV":
          if (e.altKey) { stop(); pasteStyle(); return; }
          // some WebViews never send a paste event; fall back after a moment
          pastePending = true;
          setTimeout(() => { if (pastePending && !destroyed) { pastePending = false; pasteFallback(); } }, 80);
          return;
        case "ArrowLeft": if (e.shiftKey) { stop(); align("left"); } return;
        case "ArrowRight": if (e.shiftKey) { stop(); align("right"); } return;
        case "ArrowUp": if (e.shiftKey) { stop(); align("top"); } return;
        case "ArrowDown": if (e.shiftKey) { stop(); align("bottom"); } return;
        default: return;
      }
    }
    if (e.altKey) {
      if (code === "KeyS") { stop(); toggleGuides(); }
      else if (code === "KeyC" && e.shiftKey) { stop(); copyPng(!selected.size); }
      return;
    }
    if (e.key === "?") { stop(); toggleHelp(); return; }
    if (e.shiftKey) {
      switch (code) {
        case "Digit1": stop(); return fitAll();
        case "Digit2": stop(); return fitSelection();
        case "Digit0": stop(); return zoomTo(1);
        case "KeyH": stop(); return flip("x");
        case "KeyV": stop(); return flip("y");
        case "KeyO": stop(); return toggleOutline();
        case "KeyR": stop(); return measure.toggle();
        default: break;
      }
    }
    if ((e.key === "Delete" || e.key === "Backspace") && marq) { stop(); cutPiece(true, false); marq = null; invalidate(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { stop(); deleteSelection(); return; }
    if (e.key === "Enter") {
      stop();
      if (draft) finishDraft(true);
      else enter();
      return;
    }
    if (e.key.startsWith("Arrow")) {
      stop();
      nudge(e.key, e.shiftKey ? (gridOn ? gridSize() : 10) : 1);
      return;
    }
    if (e.shiftKey) return;
    if (code === "KeyQ") { stop(); toggleToolLock(); return; }
    // Photoshop's [ and ]: the pen (or the lines picked) thinner, thicker
    if ((code === "BracketLeft" || code === "BracketRight") && !readOnly) {
      stop();
      const lines = selectedEls().filter(hasStroke);
      const now = lines.length ? lines[0].strokeWidth : tool === "freedraw" ? penWidth() : style.strokeWidth || 1;
      const up = code === "BracketRight";
      let v = Math.round(now * (up ? 1.25 : 0.8) * 2) / 2;
      if (v === now) v = now + (up ? 0.5 : -0.5);
      v = Math.max(0.5, Math.min(12, v));
      applyStyle("strokeWidth", v);
      showHint(`Size ${v}`);
      clearTimeout(sizeHintT);
      sizeHintT = setTimeout(hideHint, 900);
      return;
    }
    if (code === "KeyG") { stop(); toggleGrid(); return; }
    if (code === "KeyM") { stop(); toggleMap(); return; }
    if (code === "Equal" || code === "NumpadAdd") { stop(); zoomBy(1.2); return; }
    if (code === "Minus" || code === "NumpadSubtract") { stop(); zoomBy(1 / 1.2); return; }
    if (code === "KeyN") { stop(); if (!readOnly) openNotePicker(null); return; }
    // Photoshop's letters: B the brush (again: which brush), U the shapes (again: the next one), I the eyedropper (again: the ruler)
    if (code === "KeyB") { stop(); if (tool === "freedraw") openBrushPicker(toolButtons.get("freedraw")); else setTool("freedraw"); return; }
    if (code === "KeyU" && !readOnly) { stop(); const shapes = ["rectangle", "ellipse", "diamond", "line", "arrow"]; const i = shapes.indexOf(tool); setTool(shapes[(i + 1) % shapes.length]); return; }
    if (code === "KeyI" && tool === "picker") { stop(); setTool("measure"); return; }
    if (KEY_BRUSHES[code] && !readOnly) { stop(); if (!e.repeat) useFamily(KEY_BRUSHES[code]); return; }
    const t = KEY_TOOLS[code];
    if (!t) return;
    stop();
    if (e.repeat) return;
    // a held key only borrows the tool: let go and the old one is back
    if (PEEK_TOOLS.has(t) && tool !== t && !gesture) {
      prevTool = tool;
      peek = { code, at: performance.now(), used: false, released: false };
      setTool(t);
      return;
    }
    setTool(t);
  }

  let sizeHintT = 0;
  function endPeek() {
    const back = prevTool;
    peek = null;
    prevTool = null;
    if (back && back !== tool) setTool(back);
  }

  function onKeyUp(e) {
    if (e.code === "Space") {
      spaceDown = false;
      setCursor(toolCursor());
    }
    if (peek && e.code === peek.code) {
      const held = performance.now() - peek.at > PEEK_MS || peek.used;
      if (!held) { peek = null; prevTool = null; }
      else if (gesture) peek.released = true;
      else endPeek();
    }
    ptr.shift = e.shiftKey;
    ptr.alt = e.altKey;
    ptr.ctrl = e.ctrlKey || e.metaKey;
    if (gesture || draft) { ptr.moved = true; schedule(); }
  }

  function onBlur() {
    spaceDown = false;
    if (peek) { if (gesture) peek.released = true; else endPeek(); }
    if (gesture && gesture.type !== "freedraw") endGesture();
  }

  /* ── hint, help, popovers ─────────────────────────────────────────────── */
  function showHint(text) {
    hint.textContent = text;
    hint.hidden = false;
  }
  function hideHint() {
    hint.hidden = true;
  }

  let helpEl = null;
  function toggleHelp(force) {
    const open = force === undefined ? !helpEl : force;
    if (!open) {
      if (helpEl) helpEl.remove();
      helpEl = null;
      root.focus({ preventScroll: true });
      return;
    }
    if (helpEl) return;
    const groups = [
      ["Tools", [["Select (Alt-drag: lasso)", "V  1"], ["Lasso", "W"], ["Hand", "H"], ["Pen and brushes", "P  7"], ["Brush presets", "B"], ["Eraser (hold to borrow)", "E  0"], ["Rectangle", "R  2"], ["Diamond", "D  3"], ["Ellipse", "O  4"], ["Arrow", "A  5"], ["Line", "L  6"], ["Text", "T  8"], ["Sticky note", "S"], ["Link a note", "N"], ["Image", "9"], ["Frame (a titled section)", "F"], ["Laser pointer", "K"], ["Eyedropper (Alt-click: fill)", "I"], ["Keep tool active", "Q"]]],
      ["Mouse", [["Zoom at the pointer", "Wheel"], ["Pan sideways", "Shift wheel"], ["Pan up and down", "Alt wheel"], ["Pan", "Right drag  Middle drag  Space drag"], ["Tools and canvas menu", "Right-click"], ["Open a linked note", "Double-click"], ["Open it to the side", "Shift double-click"]]],
      ["Drawing", [["Square, circle, 15 degree steps", "Shift"], ["Draw from the centre", "Alt"], ["Move without snapping", "Ctrl  Alt"], ["Skip arrow binding", "Ctrl"], ["Eraser: cut or whole, once", "Alt"], ["Finish a line", "Enter  Esc"], ["Edit points / text", "Enter"], ["Write inside a shape", "Double-click"], ["Leave a copy while dragging", "Alt drag"]]],
      ["Editing", [["Undo / redo", "Ctrl Z  Ctrl Shift Z"], ["Copy, cut, paste", "Ctrl C  X  V"], ["Duplicate", "Ctrl D  Ctrl J"], ["Pen thinner / thicker", "[  ]"], ["Delete", "Del"], ["Group / ungroup", "Ctrl G  Ctrl Shift G"], ["Lock", "Ctrl Shift L"], ["Link", "Ctrl K"], ["Forward / to front", "Ctrl ]  Ctrl Shift ]"], ["Backward / to back", "Ctrl [  Ctrl Shift ["], ["Flip", "Shift H  Shift V"], ["Align", "Ctrl Shift Arrows"], ["Copy / paste style", "Ctrl Alt C  Ctrl Alt V"], ["Nudge", "Arrows  Shift Arrows"]]],
      ["Measuring", [["Measure: distance, path and area, angle", "U"], ["Rulers, exact sizes, live readouts", "Shift R"], ["A guide", "Drag out of a ruler"], ["Move a guide exactly", "Double-click its marker"], ["Remove a guide", "Drag it back to the ruler"], ["Hold the angle to 15 degrees", "Shift"], ["Ignore snapping", "Ctrl"], ["Finish a path", "Enter"]]],
      ["View and research", [["Zoom in / out", "=  -"], ["Zoom to fit", "Ctrl 0  Shift 1"], ["Zoom to selection", "Shift 2"], ["Actual size", "Ctrl 1  Shift 0"], ["Find in sketch", "Ctrl F"], ["Outline of frames and notes", "Shift O"], ["Snap to grid", "G"], ["Alignment guides", "Alt S"], ["Minimap", "M"], ["Copy as PNG", "Shift Alt C"], ["This help", "?"]]],
    ];
    helpEl = h("div", { class: "sk-help", onpointerdown: (e) => { if (e.target === helpEl) toggleHelp(false); } },
      h("div", { class: "sk-help-card" },
        h("div", { class: "sk-help-head" },
          h("span", { class: "sk-help-title", text: "Sketch shortcuts" }),
          h("button", { class: "sk-btn", title: "Close (Esc)", onclick: () => toggleHelp(false) }, icon("x"))),
        h("div", { class: "sk-help-grid" }, groups.map(([title, rows]) => h("div", { class: "sk-help-col" },
          h("div", { class: "sk-help-group", text: title }),
          rows.map(([label, keys]) => h("div", { class: "sk-help-row" },
            h("span", { text: label }),
            h("span", { class: "sk-keys" }, keys.split("  ").map((k) => h("kbd", { text: k }))))))))));
    root.append(helpEl);
  }

  let popEl = null;
  let popAnchor = null;
  function closePop() {
    if (popEl) popEl.remove();
    popEl = null;
    popAnchor = null;
    document.removeEventListener("pointerdown", popOutside, true);
  }
  function popOutside(e) {
    if (popEl && !popEl.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) closePop();
  }
  /**
   * One popover at a time. Placed beside the style panel, under (or over) a
   * floating button, or at `at` = { x, y } in root pixels.
   */
  function openPop(anchor, content, cls, at) {
    const again = !!anchor && popAnchor === anchor;
    closePop();
    if (again) return null;
    popEl = h("div", { class: "sk-pop " + (cls || "") }, content);
    popAnchor = anchor;
    root.append(popEl);
    updateRect();
    const r = popEl.getBoundingClientRect();
    let left;
    let top;
    if (at) {
      left = at.x;
      top = at.y;
    } else {
      const ar = anchor.getBoundingClientRect();
      if (panel.contains(anchor)) {
        left = panel.getBoundingClientRect().right - rect.left + 8;
        top = ar.top - rect.top - 8;
      } else {
        left = ar.left - rect.left + ar.width / 2 - r.width / 2;
        top = ar.bottom - rect.top + 8;
        if (top + r.height > H - 8) top = ar.top - rect.top - r.height - 8;
      }
    }
    popEl.style.left = clamp(left, 8, Math.max(8, W - r.width - 8)) + "px";
    popEl.style.top = clamp(top, 8, Math.max(8, H - r.height - 8)) + "px";
    setTimeout(() => document.addEventListener("pointerdown", popOutside, true));
    return popEl;
  }
  const keepKeys = (el) => el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { closePop(); root.focus({ preventScroll: true }); }
  });

  /* ── style panel ──────────────────────────────────────────────────────── */
  let outlineOpen = false;
  let outlineDirty = true;
  function schedulePanel() {
    if (!panelRaf && !destroyed) {
      panelRaf = requestAnimationFrame(() => {
        panelRaf = 0;
        renderPanel();
        renderCtx();
        paintToolbar();
        if (measure) measure.selectionChanged();
        if (outlineOpen && outlineDirty) renderOutline();
      });
    }
  }

  const toolAsElement = () => {
    if (tool === "sticky") return M.newElement("rectangle", { backgroundColor: style.stickyColor || R.STICKY_DEFAULT, strokeColor: "transparent", customData: { sticky: true } }, style);
    return M.newElement(tool, tool === "freedraw" ? { strokeWidth: penWidth(), customData: { brush: style.brush } } : {}, style);
  };

  function common(list, get) {
    let v;
    let first = true;
    for (const e of list) {
      const x = get(e);
      if (first) { v = x; first = false; }
      else if (x !== v) return undefined;
    }
    return v;
  }

  const hex6 = (c) => {
    const p = M.parseColor(c);
    return p ? M.toHex(p[0], p[1], p[2]) : "#1e1e1e";
  };
  const swatchBtn = (color, on, run, title) => h("button", {
    class: "sk-sw" + (on ? " is-on" : "") + (M.isTransparent(color) ? " is-none" : ""),
    title: title || color,
    tabindex: "-1",
    style: { "--c": M.isTransparent(color) ? "transparent" : M.themeColor(color, dark) },
    onclick: run,
  });
  const optBtn = (name, title, on, run, cls) => h("button", { class: "sk-opt" + (on ? " is-on" : "") + (cls ? " " + cls : ""), title, tabindex: "-1", onclick: run }, ic(name));
  const textBtn = (label, title, on, run) => h("button", { class: "sk-opt sk-opt-text" + (on ? " is-on" : ""), title, tabindex: "-1", onclick: run, text: label });
  const section = (label, ...rows) => h("div", { class: "sk-sec" }, h("div", { class: "sk-sec-label", text: label }), rows);
  const row = (...kids) => h("div", { class: "sk-row" }, kids);

  /** A labelled slider; `fmt` shows the value, `run(v, done)` applies it. */
  function slider(min, max, step, value, fmt, run) {
    const range = h("input", { type: "range", class: "sk-range", min, max, step, value: value ?? min, tabindex: "-1" });
    const val = h("span", { class: "sk-range-val", text: value === undefined ? "Mixed" : fmt(value) });
    range.addEventListener("input", () => { val.textContent = fmt(Number(range.value)); run(Number(range.value), false); });
    range.addEventListener("change", () => run(Number(range.value), true));
    range.addEventListener("pointerup", () => { if (!popEl) root.focus({ preventScroll: true }); });
    // The drag is followed here, by the pointer itself, instead of being left
    // to the browser's own range handling: that one let go after the first
    // step for some pointers (pens above all), so the slider moved by clicks only.
    let dragId = -1;
    const follow = (e) => {
      const r = range.getBoundingClientRect();
      const pad = 8; // half the thumb: the value runs between the thumb's two end stops
      const f = clamp((e.clientX - r.left - pad) / Math.max(1, r.width - pad * 2), 0, 1);
      const v = clamp(Number((Math.round((min + f * (max - min)) / step) * step).toFixed(4)), min, max);
      if (Number(range.value) === v) return;
      range.value = String(v);
      val.textContent = fmt(v);
      run(v, false);
    };
    range.addEventListener("mousedown", (e) => { if (e.button === 0) e.preventDefault(); });
    range.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragId = e.pointerId;
      try { range.setPointerCapture(e.pointerId); } catch {}
      follow(e);
    });
    range.addEventListener("pointermove", (e) => { if (e.pointerId === dragId) follow(e); });
    const endDrag = (e) => {
      if (e.pointerId !== dragId) return;
      dragId = -1;
      run(Number(range.value), true);
    };
    range.addEventListener("pointerup", endDrag);
    range.addEventListener("pointercancel", endDrag);
    return h("div", { class: "sk-range-row" }, range, val);
  }

  const STICKY_PICKS = ["#ffeab0", "#ffd6d9", "#cdeedd", "#d4e8fa", "#eadcf7"];
  function colorRow(key, current, picks) {
    const custom = current !== undefined && !picks.includes(current);
    const more = h("button", {
      class: "sk-sw sk-sw-more" + (custom ? " is-on" : "") + (current === undefined ? " is-mixed" : "") + (current && M.isTransparent(current) ? " is-none" : ""),
      title: "All colours, recent ones and any colour",
      tabindex: "-1",
      style: { "--c": current && !M.isTransparent(current) ? M.themeColor(current, dark) : "transparent" },
    });
    more.addEventListener("click", () => openColorPicker(more, key, current));
    const rows = [row(...picks.map((c) => swatchBtn(c, c === current, () => applyStyle(key, c), c === "transparent" ? "No fill" : c)), h("span", { class: "sk-row-sep" }), more)];
    const recent = recentColors.filter((c) => !picks.includes(c)).slice(0, 6);
    if (recent.length) rows.push(h("div", { class: "sk-row sk-recent", title: "Recent colours" }, recent.map((c) => swatchBtn(c, c === current, () => applyStyle(key, c), `Recent: ${c}`))));
    return rows;
  }

  /** Shade square and hue strip. onChange(hex, done). */
  function hsvPicker(initial, onChange) {
    let hsv = hexToHsv(/^#[0-9a-f]{6}/i.test(initial || "") ? initial.slice(0, 7) : "#6aa9e0");
    const knob = h("span", { class: "sk-sv-knob" });
    const sv = h("div", { class: "sk-sv" }, knob);
    const hue = h("input", { type: "range", class: "sk-hue", min: 0, max: 359, step: 1, tabindex: "-1" });
    const draw = () => {
      sv.style.setProperty("--hue", String(Math.round(hsv[0])));
      hue.value = String(Math.round(hsv[0]));
      knob.style.left = hsv[1] * 100 + "%";
      knob.style.top = (1 - hsv[2]) * 100 + "%";
      knob.style.background = hsvToHex(...hsv);
    };
    const emit = (done) => { draw(); onChange(hsvToHex(...hsv), done); };
    hue.addEventListener("input", () => { hsv[0] = +hue.value; emit(false); });
    hue.addEventListener("change", () => emit(true));
    sv.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const at = (ev) => {
        const r = sv.getBoundingClientRect();
        hsv[1] = clamp((ev.clientX - r.left) / r.width, 0, 1);
        hsv[2] = clamp(1 - (ev.clientY - r.top) / r.height, 0, 1);
        emit(false);
      };
      try { sv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      at(e);
      const up = () => {
        sv.removeEventListener("pointermove", at);
        sv.removeEventListener("pointerup", up);
        emit(true);
      };
      sv.addEventListener("pointermove", at);
      sv.addEventListener("pointerup", up);
    });
    draw();
    return { el: h("div", { class: "sk-hsv" }, sv, hue), set(c) { hsv = hexToHsv(hex6(c)); draw(); } };
  }

  function openColorPicker(anchor, key, current) {
    const isBg = key === "backgroundColor";
    const grid = h("div", { class: "sk-pal" });
    let wheel = null;
    const mark = (c) => { for (const b of popEl ? popEl.querySelectorAll(".sk-sw[data-c]") : []) b.classList.toggle("is-on", b.dataset.c === c); };
    const pick = (c, done = true) => {
      applyStyle(key, c);
      if (!done) return;
      hex.value = M.isTransparent(c) ? "" : c;
      mark(c);
      if (!M.isTransparent(c) && wheel) wheel.set(c);
    };
    const add = (parent, c, title) => {
      const b = swatchBtn(c, c === current, () => pick(c), title || c);
      b.dataset.c = c;
      parent.append(b);
    };
    const tops = isBg ? ["transparent", "#ffffff", ...M.NEUTRALS.slice(0, 4).reverse()] : [...M.NEUTRALS];
    for (const c of tops) add(grid, c, c === "transparent" ? "No fill" : c);
    for (let i = tops.length; i < 10; i++) grid.append(h("span"));
    for (let tone = 1; tone <= 3; tone++) for (const sw of M.SWATCHES) add(grid, sw[tone], `${sw[0]} ${["", "soft", "middle", "deep"][tone]}`);
    const recent = h("div", { class: "sk-pal-recent" });
    for (const c of recentColors) add(recent, c, `Recent: ${c}`);
    const hex = h("input", { class: "sk-hex", value: current && !M.isTransparent(current) ? current : "", spellcheck: false, maxlength: 11, placeholder: "#1e1e1e" });
    const applyHex = () => {
      let v = hex.value.trim();
      if (/^[0-9a-f]{3,8}$/i.test(v)) v = "#" + v;
      if (M.parseColor(v)) pick(v.toLowerCase());
      else hex.classList.add("is-bad");
    };
    hex.addEventListener("input", () => hex.classList.remove("is-bad"));
    hex.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") applyHex();
      if (e.key === "Escape") closePop();
    });
    hex.addEventListener("change", applyHex);
    wheel = hsvPicker(current && !M.isTransparent(current) ? hex6(current) : "#6aa9e0", (c, done) => {
      pick(c, done);
      if (!done) hex.value = c;
    });
    const dropper = h("button", { class: "sk-opt", title: "Pick a colour from the canvas (I)", tabindex: "-1", onclick: () => { closePop(); setTool("picker"); } }, ic("picker"));
    openPop(anchor, [
      h("div", { class: "sk-pop-title", text: key === "strokeColor" ? "Colour" : "Fill" }),
      grid,
      recentColors.length ? h("div", { class: "sk-pop-sub", text: "Recent" }) : null,
      recentColors.length ? recent : null,
      h("div", { class: "sk-pop-sub", text: "Any colour" }),
      wheel.el,
      h("div", { class: "sk-hex-row" }, hex, dropper),
    ], "sk-color-pop");
  }

  function arrowheadPicker(anchor, which, current) {
    const opts = [[null, "ahNone", "None"], ["arrow", "ahArrow", "Arrow"], ["triangle", "ahTriangle", "Triangle"], ["triangle_outline", "ahTriangleOutline", "Outlined triangle"], ["dot", "ahDot", "Dot"], ["diamond", "ahDiamond", "Diamond"], ["bar", "ahBar", "Bar"]];
    const key = which === "start" ? "startArrowhead" : "endArrowhead";
    openPop(anchor, [
      h("div", { class: "sk-pop-title", text: which === "start" ? "Start" : "End" }),
      h("div", { class: "sk-row" }, opts.map(([v, name, title]) => optBtn(name, title, (current ?? null) === v, () => { applyStyle(key, v); closePop(); }, which === "start" ? "is-flip" : ""))),
    ], "sk-head-pop");
  }

  const HEAD_ICON = { arrow: "ahArrow", triangle: "ahTriangle", triangle_outline: "ahTriangleOutline", dot: "ahDot", circle: "ahDot", circle_outline: "ahDot", diamond: "ahDiamond", diamond_outline: "ahDiamond", bar: "ahBar" };
  const ROUGH_NAMES = ["Clean", "Neat", "Artist", "Loose", "Cartoon", "Wild", "Wilder"];
  const roughName = (v) => ROUGH_NAMES[Math.round(v * 2)] || String(v);
  const isPaper = (e) => M.isSticky(e) || M.isNoteCard(e);

  function renderPanel() {
    if (gesture) return;
    const sel = selectedEls();
    const drawing = TOOLS_WITH_STYLE.has(tool) || tool === "eraser";
    const show = !readOnly && (sel.length ? panelPinned && !editing : drawing);
    if (!show) {
      panel.hidden = true;
      if (popEl && popAnchor && panel.contains(popAnchor)) closePop();
      return;
    }
    const kids = [];
    if (!sel.length && tool === "eraser") {
      kids.push(section("Eraser", row(
        textBtn("Whole", "Erase whole elements", eraseMode === "whole", () => setEraseMode("whole")),
        textBtn("Cut", "Cut through pen strokes, leave the rest", eraseMode === "cut", () => setEraseMode("cut")))));
      if (eraseMode === "cut") kids.push(section("Eraser size", slider(4, 80, 1, eraseSize, (v) => `${v}px`, (v, done) => { eraseSize = v; if (done) saveSetting("sketchEraseSize", v); invalidate(false); })));
      kids.push(h("div", { class: "sk-note", text: "Hold Alt to switch mode for one stroke. Hold E to erase for a moment." }));
      panel.replaceChildren(...kids);
      panel.hidden = false;
      return;
    }
    const targets = sel.length ? withBound(sel) : [toolAsElement()];
    const texts = targets.filter((e) => e.type === "text");
    const shapes = targets.filter((e) => e.type !== "text" || !e.containerId);
    const strokeT = targets.filter((e) => e.type !== "image" && e.type !== "frame" && e.type !== "magicframe" && !M.isSticky(e));
    // a pen stroke only takes a fill once it closes on itself
    const bgT = shapes.filter((e) => canBg(e) && (e.type !== "freedraw" || (sel.length && M.isPathALoop(e.points))));
    const lineT = shapes.filter((e) => hasStroke(e) && !isPaper(e));
    const pens = lineT.filter((e) => e.type === "freedraw");
    const styleT = lineT.filter((e) => e.type !== "freedraw");
    const edgeT = shapes.filter((e) => (e.type === "rectangle" || e.type === "diamond") && !isPaper(e));
    const arrowT = shapes.filter((e) => e.type === "arrow");
    if (strokeT.length) kids.push(section(strokeT.every((e) => e.type === "text") ? "Text colour" : M.isNoteCard(strokeT[0]) && strokeT.length === 1 ? "Accent" : "Colour", ...colorRow("strokeColor", common(strokeT, (e) => e.strokeColor), M.STROKE_PICKS)));
    if (bgT.length) {
      const bg = common(bgT, (e) => e.backgroundColor);
      const papers = bgT.every(M.isSticky);
      kids.push(section(papers ? "Paper" : "Fill", ...colorRow("backgroundColor", bg, papers ? STICKY_PICKS : M.BACKGROUND_PICKS)));
      if (!papers && bgT.some((e) => M.hasFill(e) && !isPaper(e))) {
        const fs = common(bgT, (e) => e.fillStyle);
        kids.push(section("Fill style", row(
          optBtn("fsHachure", "Hachure", fs === "hachure", () => applyStyle("fillStyle", "hachure")),
          optBtn("fsCross", "Cross-hatch", fs === "cross-hatch", () => applyStyle("fillStyle", "cross-hatch")),
          optBtn("fsZigzag", "Zigzag", fs === "zigzag", () => applyStyle("fillStyle", "zigzag")),
          optBtn("fsSolid", "Solid", fs === "solid", () => applyStyle("fillStyle", "solid")))));
      }
    }
    if (pens.length) {
      const b = sel.length ? B.brushOf(pens[0]) || currentBrush() : currentBrush();
      const btn = h("button", { class: "sk-brush-btn", title: "Brushes (B)", tabindex: "-1" },
        ic(FAMILY_ICON[brushFamily(b)] || "bPen"), h("span", { class: "sk-brush-name", text: brushName(b) }), icon("chevronDown"));
      btn.addEventListener("click", () => openBrushPicker(btn));
      kids.push(section("Brush", btn));
      const sw = common(pens, (e) => e.strokeWidth);
      kids.push(section("Size", slider(0.5, 12, 0.5, sw, (v) => `${v}`, (v) => applyStyle("strokeWidth", v))));
    }
    if (styleT.length) {
      const sw = common(styleT, (e) => e.strokeWidth);
      kids.push(section("Stroke width", row(
        optBtn("swThin", "Thin", sw === 1, () => applyStyle("strokeWidth", 1)),
        optBtn("swBold", "Bold", sw === 2, () => applyStyle("strokeWidth", 2)),
        optBtn("swExtra", "Extra bold", sw === 4, () => applyStyle("strokeWidth", 4)))));
      const ss = common(styleT, (e) => e.strokeStyle);
      kids.push(section("Stroke style", row(
        optBtn("ssSolid", "Solid", ss === "solid", () => applyStyle("strokeStyle", "solid")),
        optBtn("ssDashed", "Dashed", ss === "dashed", () => applyStyle("strokeStyle", "dashed")),
        optBtn("ssDotted", "Dotted", ss === "dotted", () => applyStyle("strokeStyle", "dotted")))));
      const r = common(styleT, (e) => e.roughness);
      kids.push(section("Hand-drawn", slider(0, 3, 0.5, r, roughName, (v) => applyStyle("roughness", v))));
    }
    if (edgeT.length) {
      const round = common(edgeT, (e) => !!e.roundness);
      kids.push(section("Edges", row(
        optBtn("edgeSharp", "Sharp", round === false, () => applyStyle("roundness", "sharp")),
        optBtn("edgeRound", "Round", round === true, () => applyStyle("roundness", "round")))));
    }
    if (arrowT.length) {
      const curved = common(arrowT, (e) => !!e.roundness);
      const sh = common(arrowT, (e) => e.startArrowhead ?? null);
      const eh = common(arrowT, (e) => e.endArrowhead ?? null);
      const startBtn = optBtn(sh ? HEAD_ICON[sh] || "ahArrow" : "ahNone", "Start arrowhead", false, () => arrowheadPicker(startBtn, "start", sh), "is-flip sk-opt-drop");
      const endBtn = optBtn(eh ? HEAD_ICON[eh] || "ahArrow" : "ahNone", "End arrowhead", false, () => arrowheadPicker(endBtn, "end", eh), "sk-opt-drop");
      kids.push(section("Arrow", row(
        optBtn("arrowSharp", "Straight", curved === false, () => applyStyle("arrowType", "sharp")),
        optBtn("arrowCurved", "Curved", curved === true, () => applyStyle("arrowType", "round")),
        h("span", { class: "sk-row-sep" }),
        startBtn,
        endBtn)));
    }
    if (texts.length || tool === "sticky") {
      const tt = texts.length ? texts : [M.newElement("text", {}, style)];
      const ff = common(tt, (e) => e.fontFamily);
      const fz = common(tt, (e) => e.fontSize);
      const ta = common(tt, (e) => e.textAlign);
      kids.push(section("Font", row(
        optBtn("fontHand", "Hand-drawn", ff === 1 || ff === 5, () => applyStyle("fontFamily", 1)),
        optBtn("fontNormal", "Normal", ff === 2 || ff === 6 || ff === 9, () => applyStyle("fontFamily", 2)),
        optBtn("fontCode", "Code", ff === 3 || ff === 8, () => applyStyle("fontFamily", 3)))));
      kids.push(section("Size", row(
        textBtn("S", "Small", fz === 16, () => applyStyle("fontSize", 16)),
        textBtn("M", "Medium", fz === 20, () => applyStyle("fontSize", 20)),
        textBtn("L", "Large", fz === 28, () => applyStyle("fontSize", 28)),
        textBtn("XL", "Extra large", fz === 36, () => applyStyle("fontSize", 36)))));
      if (texts.length) {
        kids.push(section("Text align", row(
          optBtn("taLeft", "Left", ta === "left", () => applyStyle("textAlign", "left")),
          optBtn("taCenter", "Centre", ta === "center", () => applyStyle("textAlign", "center")),
          optBtn("taRight", "Right", ta === "right", () => applyStyle("textAlign", "right")))));
      }
    }
    const op = common(targets.filter((e) => e.type !== "text" || !e.containerId), (e) => e.opacity);
    kids.push(section("Opacity", slider(0, 100, 5, op, (v) => `${v}%`, (v) => applyStyle("opacity", v))));

    if (sel.length) {
      // shape, layers, align and actions fold together under Arrange, remembered on this computer
      const style = kids.length;
      const shapeSel = sel.filter((e) => M.SHAPES.has(e.type) && !isPaper(e));
      if (shapeSel.length && shapeSel.length === sel.length) {
        const t = common(shapeSel, (e) => e.type);
        kids.push(section("Shape", row(
          optBtn("rectangle", "Rectangle", t === "rectangle", () => morph("rectangle")),
          optBtn("diamond", "Diamond", t === "diamond", () => morph("diamond")),
          optBtn("ellipse", "Ellipse", t === "ellipse", () => morph("ellipse")))));
      }
      kids.push(section("Layers", row(
        optBtn("toBack", "Send to back (Ctrl+Shift+[)", false, () => layer("back")),
        optBtn("backward", "Send backward (Ctrl+[)", false, () => layer("backward")),
        optBtn("forward", "Bring forward (Ctrl+])", false, () => layer("forward")),
        optBtn("toFront", "Bring to front (Ctrl+Shift+])", false, () => layer("front")))));
      const unitCount = units().length;
      if (unitCount >= 2) {
        kids.push(section("Align", row(
          optBtn("alignL", "Align left (Ctrl+Shift+Left)", false, () => align("left")),
          optBtn("alignCH", "Centre horizontally", false, () => align("centerX")),
          optBtn("alignR", "Align right (Ctrl+Shift+Right)", false, () => align("right")),
          optBtn("alignT", "Align top (Ctrl+Shift+Up)", false, () => align("top")),
          optBtn("alignCV", "Centre vertically", false, () => align("centerY")),
          optBtn("alignB", "Align bottom (Ctrl+Shift+Down)", false, () => align("bottom"))),
        unitCount >= 3 ? row(
          optBtn("distH", "Distribute horizontally", false, () => distribute("x")),
          optBtn("distV", "Distribute vertically", false, () => distribute("y"))) : null));
      }
      const grouped = sel.some((e) => e.groupIds && e.groupIds.length);
      kids.push(section("Actions", row(
        sel.length > 1 && !isOneGroup(sel) ? optBtn("group", "Group (Ctrl+G)", false, () => groupSelection()) : null,
        grouped ? optBtn("ungroup", "Ungroup (Ctrl+Shift+G)", false, () => ungroupSelection()) : null,
        sel.length === 1 ? optBtn("link", sel[0].link ? "Edit link (Ctrl+K)" : "Add link (Ctrl+K)", !!sel[0].link, () => editLink()) : null,
        optBtn("send", "Send to your last note", false, () => sendToNote(false)))));
      let shut = false;
      try { shut = !!localStorage.getItem("leonote.sketch.arrangeFolded"); } catch { /* fine */ }
      const fold = h("div", { class: "sk-fold" + (shut ? "" : " is-open") });
      fold.append(h("button", { class: "sk-fold-head", type: "button", onclick: () => {
        const open = fold.classList.toggle("is-open");
        try { open ? localStorage.removeItem("leonote.sketch.arrangeFolded") : localStorage.setItem("leonote.sketch.arrangeFolded", "1"); } catch { /* fine */ }
      } }, h("span", { text: "Arrange" }), icon("chevronDown", "sk-fold-caret")), h("div", { class: "sk-fold-body" }, ...kids.splice(style)));
      kids.push(fold);
    }
    panel.replaceChildren(...kids);
    panel.hidden = false;
  }

  function setEraseMode(m) {
    eraseMode = m;
    saveSetting("sketchEraseMode", m);
    schedulePanel();
    invalidate(false);
  }

  /* ── floating bar by the selection ────────────────────────────────────── */
  let ctxW = 0;
  let ctxH = 0;
  let ctxPos = "";
  function hideCtx() {
    if (!ctxBar.hidden) ctxBar.hidden = true;
    if (popEl && popAnchor && ctxBar.contains(popAnchor)) closePop();
  }

  function renderCtx() {
    const sel = selectedEls();
    if (readOnly || !sel.length || editing || gesture || tool === "laser" || (pointEdit && pointEdit.sel.size)) return hideCtx();
    const all = withBound(sel);
    const locked = sel.every((e) => e.locked);
    const kids = [];
    const btn = (name, title, run, cls) => {
      const b = h("button", { class: "sk-cbtn" + (cls ? " " + cls : ""), title, tabindex: "-1" }, ic(name));
      b.addEventListener("click", () => run(b));
      return b;
    };
    const sep = () => h("span", { class: "sk-csep" });
    if (!locked) {
      const papers = sel.every(M.isSticky);
      const strokeT = all.filter((e) => e.type !== "image" && e.type !== "frame" && e.type !== "magicframe" && !M.isSticky(e));
      const colorT = papers ? sel : strokeT;
      const key = papers ? "backgroundColor" : "strokeColor";
      if (colorT.length) {
        const cur = common(colorT, (e) => e[key]);
        const b = h("button", { class: "sk-cbtn sk-cswatch" + (cur === undefined ? " is-mixed" : ""), title: papers ? "Paper colour" : "Colour", tabindex: "-1", style: { "--c": cur && !M.isTransparent(cur) ? M.themeColor(cur, dark) : "transparent" } });
        b.addEventListener("click", () => openColorPicker(b, key, cur));
        kids.push(b);
      }
      const bgT = all.filter((e) => canBg(e) && !M.isSticky(e) && e.type !== "freedraw");
      if (!papers && bgT.length) {
        const cur = common(bgT, (e) => e.backgroundColor);
        const b = h("button", { class: "sk-cbtn sk-cswatch is-fill" + (cur === undefined ? " is-mixed" : "") + (cur && M.isTransparent(cur) ? " is-none" : ""), title: "Fill", tabindex: "-1", style: { "--c": cur && !M.isTransparent(cur) ? M.themeColor(cur, dark) : "transparent" } });
        b.addEventListener("click", () => openColorPicker(b, "backgroundColor", cur));
        kids.push(b);
      }
      const pens = all.filter((e) => e.type === "freedraw");
      const lines = all.filter((e) => hasStroke(e) && !isPaper(e));
      if (kids.length) kids.push(sep());
      if (pens.length) kids.push(btn(FAMILY_ICON[brushFamily(B.brushOf(pens[0]) || { id: "pen" })] || "bPen", "Brush (B)", (b) => openBrushPicker(b)));
      if (lines.length) {
        kids.push(btn("swBold", "Stroke width", (b) => {
          const sw = common(lines, (e) => e.strokeWidth);
          rangePop(b, "Stroke width", 0.5, 12, 0.5, sw, (v) => `${v}`, (v) => applyStyle("strokeWidth", v));
        }));
      }
      kids.push(btn("contrast", "Opacity", (b) => {
        const op = common(all.filter((e) => e.type !== "text" || !e.containerId), (e) => e.opacity);
        rangePop(b, "Opacity", 0, 100, 5, op, (v) => `${v}%`, (v) => applyStyle("opacity", v));
      }));
      kids.push(sep());
      kids.push(btn("duplicate", "Duplicate (Ctrl+D)", () => duplicateSelection()));
      kids.push(btn("toFront", "Bring to front (Ctrl+Shift+])", () => layer("front")));
      kids.push(btn("toBack", "Send to back (Ctrl+Shift+[)", () => layer("back")));
    }
    kids.push(btn(locked ? "lock" : "unlock", locked ? "Unlock (Ctrl+Shift+L)" : "Lock (Ctrl+Shift+L)", () => toggleLock(), locked ? "is-on" : ""));
    if (!locked) kids.push(btn("trash", "Delete (Del)", () => deleteSelection(), "is-danger"));
    const single = sel.length === 1 ? sel[0] : null;
    if (single && M.linkedNote(single)) {
      kids.push(sep());
      kids.push(btn("card", "Open the note (double-click)", () => openCardNote(single, false)));
    }
    kids.push(sep());
    kids.push(btn("sliders", panelPinned ? "Hide the style panel" : "All style options", () => {
      panelPinned = !panelPinned;
      saveSetting("sketchPanelPinned", panelPinned);
      schedulePanel();
    }, panelPinned ? "is-on" : ""));
    ctxBar.replaceChildren(...kids);
    ctxBar.hidden = false;
    ctxW = ctxBar.offsetWidth;
    ctxH = ctxBar.offsetHeight;
    ctxPos = "";
    placeCtx();
  }

  function placeCtx() {
    if (ctxBar.hidden) return;
    const list = gesture ? null : selectedEls();
    let pos = "hide";
    if (list && list.length) {
      const b = M.commonBounds(list);
      const x1 = toScreenX(b[0]);
      const x2 = toScreenX(b[2]);
      const y1 = toScreenY(b[1]);
      const y2 = toScreenY(b[3]);
      if (x2 > 0 && x1 < W && y2 > 0 && y1 < H) {
        // above the rotate handle, else below, else pinned under the toolbar
        let top = y1 - ctxH - ROTATE_GAP - 22;
        if (top < 58) top = y2 + 18;
        if (top + ctxH > H - 56) top = 58;
        const left = clamp((x1 + x2) / 2 - ctxW / 2, 8, Math.max(8, W - ctxW - 8));
        pos = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      }
    }
    if (pos === ctxPos) return;
    ctxPos = pos;
    if (pos === "hide") ctxBar.style.visibility = "hidden";
    else {
      ctxBar.style.visibility = "";
      ctxBar.style.transform = pos;
    }
  }

  function rangePop(anchor, title, min, max, step, value, fmt, run) {
    const pop = openPop(anchor, [h("div", { class: "sk-pop-title", text: title }), slider(min, max, step, value, fmt, run)], "sk-range-pop");
    if (pop) keepKeys(pop);
  }

  /* ── brushes ──────────────────────────────────────────────────────────── */
  const PREVIEW = (() => {
    const pts = [];
    const pr = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      pts.push([8 + t * 104, 19 + Math.sin(t * Math.PI * 2) * 8]);
      pr.push(0.3 + 0.65 * Math.sin(t * Math.PI));
    }
    return { pts, pr };
  })();

  function drawBrushPreview(cv, brush, color) {
    const c = cv.getContext("2d");
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = B.brushOf({ customData: { brush } }) || B.brushOf({ customData: { brush: "pen" } });
    const el = {
      id: "preview", type: "freedraw", x: 0, y: 0, width: 104, height: 16, angle: 0, strokeColor: color, backgroundColor: "transparent",
      fillStyle: "solid", strokeWidth: Math.min(1.7, 13 / b.size), strokeStyle: "solid", roughness: 0, opacity: Math.round(100 * b.opacity),
      points: PREVIEW.pts, pressures: PREVIEW.pr, simulatePressure: false, lastCommittedPoint: [1, 1], seed: 11, version: 1, customData: { brush },
    };
    R.drawElement(c, el, { dark, zoom: 1, canvasBg, lod: false, alpha: 1 });
  }

  function applyBrushToSelection() {
    const pens = withBound(selectedEls()).filter((e) => e.type === "freedraw" && !e.locked);
    if (!pens.length || readOnly) return;
    const b = currentBrush();
    const before = snap(pens);
    for (const e of pens) {
      const cd = { ...(e.customData || {}) };
      if (B.isPlain(b)) delete cd.brush;
      else cd.brush = B.brushData(b);
      if (Object.keys(cd).length) e.customData = cd;
      else delete e.customData;
      M.bumpVersion(e);
      R.forget(e);
    }
    commit(before, { key: "brush" });
    invalidate();
  }

  /** Take up a brush: what the picker's tiles do, and the number keys. */
  function usePreset(p, fam) {
    const had = B.PRESET_BY_ID.get(currentBrush().id);
    style.brush = { id: p.id };
    lastPerFamily[fam] = p.id;
    saveSetting("sketchBrushFamilies", { ...lastPerFamily });
    // a preset with its own ink (highlighters, neon) lends it; the next plain one gives yours back
    lendingInk = true;
    if (p.color) {
      if (!(had && had.color) && !selected.size) style.inkBefore = style.strokeColor;
      applyStyle("strokeColor", p.color);
    } else if (had && had.color && style.inkBefore && !selected.size) {
      applyStyle("strokeColor", style.inkBefore);
      delete style.inkBefore;
    }
    lendingInk = false;
    rememberStyle();
    applyBrushToSelection();
    if (tool !== "freedraw" && !selected.size) setTool("freedraw");
  }
  /** 2-7: a kind of brush, with the one of that kind you used last. Again on the same key walks through the kind. */
  function useFamily(fam) {
    const list = B.PRESETS.filter((p) => p.family === fam);
    if (!list.length) return;
    const cur = currentBrush();
    const at = list.findIndex((p) => p.id === cur.id);
    const p = tool === "freedraw" && at >= 0 ? list[(at + 1) % list.length] : list.find((x) => x.id === lastPerFamily[fam]) || list[0];
    usePreset(p, fam);
    schedulePanel();
    brushNote(p.name);
  }
  /** The pens laid out under the pen button: each kind with its number key, then every brush. */
  function openPenFlyout(anchor) {
    const keyOfFam = Object.fromEntries(Object.entries(KEY_BRUSHES).map(([code, fam]) => [fam, code.replace("Digit", "")]));
    const cur = currentBrush();
    const curFam = brushFamily(cur);
    const fams = B.FAMILIES.filter((f) => f.id !== "custom" || customBrushes.length);
    const cells = fams.map((f) => {
      const list = f.id === "custom" ? customBrushes : B.PRESETS.filter((p) => p.family === f.id);
      const last = list.find((x) => x.id === lastPerFamily[f.id]) || list[0];
      const b = h("button", { class: "sk-pen-cell" + (tool === "freedraw" && curFam === f.id ? " is-on" : ""), tabindex: "-1", title: `${f.name} (${list.length})` + (last ? ` - ${last.name}` : "") },
        ic(FAMILY_ICON[f.id]), h("span", { class: "sk-pen-name", text: f.short || f.name }),
        keyOfFam[f.id] ? h("span", { class: "sk-pen-key", text: keyOfFam[f.id] }) : null);
      b.addEventListener("click", () => {
        closePop();
        if (last) { usePreset(last, f.id); schedulePanel(); brushNote(last.name); }
      });
      return b;
    });
    const all = h("button", { class: "sk-pen-all", tabindex: "-1" }, ic("grid"), h("span", { text: "Every brush, with settings…" }), h("span", { class: "sk-pen-key", text: "B" }));
    all.addEventListener("click", () => { closePop(); openBrushPicker(anchor, "all"); });
    const pop = openPop(anchor, [h("div", { class: "sk-pen-row" }, cells), all], "sk-pen-pop");
    if (pop) keepKeys(pop);
  }
  let brushNoteEl = null;
  let brushNoteTimer = 0;
  function brushNote(text) {
    if (!brushNoteEl) { brushNoteEl = h("div", { class: "sk-brush-note" }); root.append(brushNoteEl); }
    brushNoteEl.textContent = text;
    brushNoteEl.classList.add("is-in");
    clearTimeout(brushNoteTimer);
    brushNoteTimer = setTimeout(() => brushNoteEl.classList.remove("is-in"), 1100);
  }

  function openBrushPicker(anchor, startFam) {
    if (!anchor) return;
    let fam = startFam || brushFamily(currentBrush());
    const tabs = h("div", { class: "sk-bt-tabs", role: "tablist" });
    const grid = h("div", { class: "sk-bt-grid" });
    const adjust = h("div", { class: "sk-bt-adjust" });
    const bigPreview = h("canvas", { class: "sk-bt-big", width: Math.round(120 * dpr), height: Math.round(38 * dpr) });
    const color = () => style.strokeColor;
    const presetsOf = (f) => (f === "custom" ? customBrushes : B.PRESETS.filter((p) => p.family === f));
    const selPens = () => selectedEls().filter((e) => e.type === "freedraw");
    function paintTabs() {
      // "All" lays every brush out at once, family by family, so nothing hides behind a tab
      const total = B.FAMILIES.reduce((n, f) => n + presetsOf(f.id).length, 0);
      const all = h("button", { class: "sk-bt-tab sk-bt-all" + (fam === "all" ? " is-on" : ""), title: `Every brush at once (${total})`, tabindex: "-1", role: "tab" }, ic("grid"), h("span", { text: `All ${total}` }));
      all.addEventListener("click", () => { fam = fam === "all" ? brushFamily(currentBrush()) : "all"; paintTabs(); paintGrid(); });
      tabs.replaceChildren(all, ...B.FAMILIES.map((f) => {
        const b = h("button", { class: "sk-bt-tab" + (f.id === fam ? " is-on" : ""), title: `${f.name} (${presetsOf(f.id).length})`, tabindex: "-1", role: "tab" }, ic(FAMILY_ICON[f.id]), h("span", { text: f.short || f.name }));
        b.addEventListener("click", () => { fam = f.id; paintTabs(); paintGrid(); });
        return b;
      }));
    }
    function paintGrid() {
      grid.classList.toggle("is-all", fam === "all");
      if (fam === "all") {
        grid.replaceChildren(...B.FAMILIES.flatMap((f) => {
          const list = presetsOf(f.id);
          return list.length ? [h("div", { class: "sk-bt-fam" }, ic(FAMILY_ICON[f.id]), h("span", { text: f.name }), h("span", { class: "sk-bt-fam-n", text: String(list.length) })), ...list.map((p) => brushCell(p, f.id))] : [];
        }));
        return;
      }
      const list = presetsOf(fam);
      grid.replaceChildren(...list.map((p) => brushCell(p, fam)));
      if (!list.length) grid.append(h("div", { class: "sk-bt-empty", text: "Tune any brush below, then save it here." }));
    }
    function brushCell(p, fam) {
      const cur = currentBrush();
      {
        const cv = h("canvas", { class: "sk-bt-prev", width: Math.round(120 * dpr), height: Math.round(38 * dpr) });
        drawBrushPreview(cv, fam === "custom" ? p : { id: p.id }, p.color || color());
        // the family's last pick stays marked while another family is in use
        const last = p.id !== cur.id && brushFamily(cur) !== fam && lastPerFamily[fam] === p.id;
        const b = h("button", { class: "sk-bt" + (p.id === cur.id ? " is-on" : last ? " is-last" : ""), title: last ? `${p.name} (last used)` : p.name, tabindex: "-1" }, cv, h("span", { class: "sk-bt-name", text: p.name }));
        b.addEventListener("click", () => choose(p, fam));
        if (fam === "custom") {
          const x = h("span", { class: "sk-bt-del", title: "Remove this brush" }, icon("x"));
          x.addEventListener("click", (e) => {
            e.stopPropagation();
            const was = customBrushes;
            customBrushes = customBrushes.filter((c) => c.id !== p.id);
            saveSetting("sketchBrushes", customBrushes);
            paintGrid();
            // a tuned brush is work: it can come back
            toast(`Removed “${p.name}”`, { ms: 5000, action: { label: "Undo", run: () => {
              // back in its place; brushes removed or made since stay so
              const now = customBrushes;
              customBrushes = [...was.filter((c) => c.id === p.id || now.some((k) => k.id === c.id)), ...now.filter((k) => !was.some((c) => c.id === k.id))];
              saveSetting("sketchBrushes", customBrushes); paintGrid();
            } } });
          });
          b.append(x);
        }
        return b;
      }
    }
    function choose(p, fam) {
      usePreset(p, fam);
      paintGrid();
      paintAdjust();
      schedulePanel();
    }
    function tweak(k, v, done) {
      style.brush = { ...style.brush, [k]: v };
      rememberStyle();
      drawBrushPreview(bigPreview, currentBrushData(), color());
      if (done || selPens().length) applyBrushToSelection();
      if (done) paintGrid();
    }
    function paintAdjust() {
      const b = currentBrush();
      const rows = [
        ["Tip size", "size", 0.5, 16, 0.25, (v) => v.toFixed(2).replace(/\.?0+$/, "")],
        ["Pressure", "thinning", -0.2, 0.95, 0.05, (v) => `${Math.round(v * 100)}%`],
        ["Steadiness", "streamline", 0, 0.95, 0.05, (v) => `${Math.round(v * 100)}%`],
        ["Taper", "taperEnd", 0, 120, 5, (v) => `${v}px`],
      ];
      if (b.texture !== "none") rows.push(["Texture", "grain", 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`]);
      if (b.angle != null) rows.push(["Nib angle", "angle", -90, 90, 5, (v) => `${v}°`]);
      rows.push(["Ink", "opacity", 0.1, 1, 0.05, (v) => `${Math.round(v * 100)}%`]);
      const save = h("button", { class: "sk-bt-save", tabindex: "-1" }, ic("star"), "Save as my brush");
      save.addEventListener("click", () => saveBrush(save));
      const reset = h("button", { class: "sk-bt-reset", title: "Back to the preset", tabindex: "-1", text: "Reset" });
      reset.addEventListener("click", () => {
        style.brush = { id: style.brush.id };
        rememberStyle();
        applyBrushToSelection();
        paintAdjust();
        paintGrid();
      });
      adjust.replaceChildren(
        h("div", { class: "sk-bt-head" }, bigPreview, h("div", { class: "sk-bt-cur" }, h("span", { class: "sk-bt-curname", text: brushName(b) }), h("span", { class: "sk-bt-hint", text: "Pen pressure is used when there is a pen" }))),
        ...rows.map(([label, k, min, max, step, fmt]) => h("div", { class: "sk-bt-row" }, h("span", { class: "sk-bt-label", text: label }), slider(min, max, step, b[k], fmt, (v, done) => tweak(k, v, done)))),
        h("div", { class: "sk-bt-actions" }, reset, save));
      drawBrushPreview(bigPreview, currentBrushData(), color());
    }
    function saveBrush(btn) {
      const input = h("input", { class: "sk-hex sk-bt-input", placeholder: "Name this brush", value: brushName(currentBrush()) + " (mine)", spellcheck: false });
      btn.replaceWith(input);
      input.focus();
      input.select();
      const done = (ok) => {
        if (!input.isConnected) return;
        const name = input.value.trim();
        if (ok && name) {
          const b = currentBrush();
          const rec = { id: "mine-" + M.randomId().slice(0, 10), name, family: "custom" };
          for (const k of Object.keys(B.BASE)) if (k !== "color") rec[k] = b[k];
          customBrushes = [...customBrushes, rec].slice(-40);
          saveSetting("sketchBrushes", customBrushes);
          style.brush = { id: rec.id };
          lastPerFamily.custom = rec.id;
          rememberStyle();
          fam = "custom";
          paintTabs();
          paintGrid();
          toast(`Saved “${name}” to your brushes`, { ms: 1600 });
        }
        paintAdjust();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      });
      input.addEventListener("blur", () => done(true));
    }
    paintTabs();
    paintGrid();
    paintAdjust();
    const pop = openPop(anchor, [tabs, grid, adjust], "sk-brush-pop");
    if (pop) keepKeys(pop);
  }

  /** The current brush as element data (custom brushes carry all their params). */
  function currentBrushData() {
    const custom = customBrushes.find((x) => x.id === style.brush.id);
    return custom ? { ...custom, ...style.brush } : style.brush;
  }

  /* ── canvas look ──────────────────────────────────────────────────────── */
  function setCanvasLook(patch) {
    if (readOnly) return;
    M.setCanvas(scene.appState, patch);
    readTheme();
    dirtyMap = true;
    markChanged();
    invalidate();
  }

  function setCanvasColor(c) {
    if (dark) {
      const legacy = !M.canvasOf(scene.appState).light && !M.isDefaultBackground(scene.appState.viewBackgroundColor);
      setCanvasLook({ dark: c || (legacy ? "app" : null) });
    } else setCanvasLook({ light: c });
  }

  function canvasControls() {
    const cv = M.canvasOf(scene.appState);
    const list = dark ? M.CANVAS_DARK : M.CANVAS_LIGHT;
    const shown = M.canvasColor(scene.appState, dark);
    const appBg = getComputedStyle(root).getPropertyValue("--bg").trim() || (dark ? "#121214" : "#ffffff");
    const swatches = h("div", { class: "sk-canvas-sws" });
    const paint = () => {
      const now = M.canvasColor(scene.appState, dark);
      for (const b of swatches.querySelectorAll("[data-c]")) b.classList.toggle("is-on", (b.dataset.c || null) === (now ? now.toLowerCase() : null) || (!now && !b.dataset.c));
    };
    for (const [c, name] of list) {
      const b = h("button", { class: "sk-sw sk-canvas-sw" + (c ? "" : " is-app"), title: c ? name : "The app's own background", tabindex: "-1", dataset: { c: c || "" }, style: { "--c": c || appBg } });
      b.addEventListener("click", () => { setCanvasColor(c); paint(); });
      swatches.append(b);
    }
    const custom = !!shown && !list.some(([c]) => c === shown);
    const more = h("button", { class: "sk-sw sk-sw-more" + (custom ? " is-on" : ""), title: "Any colour", tabindex: "-1", style: { "--c": shown || appBg } });
    swatches.append(more);
    const hex = h("input", { class: "sk-hex", placeholder: dark ? "#1d232b" : "#f7f3ea", value: shown || "", spellcheck: false, maxlength: 9 });
    const wheel = hsvPicker(shown || (dark ? "#1d232b" : "#f7f3ea"), (c, done) => {
      hex.value = c;
      more.style.setProperty("--c", c);
      setCanvasColor(c);
      if (done) paint();
    });
    const own = h("div", { class: "sk-canvas-own", hidden: true }, wheel.el, h("div", { class: "sk-hex-row" }, hex));
    more.addEventListener("click", () => { own.hidden = !own.hidden; });
    hex.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      let v = hex.value.trim();
      if (/^[0-9a-f]{3,6}$/i.test(v)) v = "#" + v;
      if (M.parseColor(v)) { setCanvasColor(hex6(v)); wheel.set(v); paint(); } else hex.classList.add("is-bad");
    });
    hex.addEventListener("input", () => hex.classList.remove("is-bad"));
    const pats = h("div", { class: "sk-seg" }, M.PATTERNS.map(([id, name]) => {
      const b = h("button", { class: "sk-seg-btn" + (cv.pattern === id ? " is-on" : ""), tabindex: "-1", text: name });
      b.addEventListener("click", () => {
        setCanvasLook({ pattern: id });
        for (const x of pats.children) x.classList.toggle("is-on", x === b);
      });
      return b;
    }));
    return h("div", { class: "sk-canvas-ctl" },
      h("div", { class: "sk-pop-sub", text: dark ? "Background (dark theme)" : "Background (light theme)" }),
      swatches, own,
      h("div", { class: "sk-pop-sub", text: "Pattern" }), pats,
      h("div", { class: "sk-pop-sub", text: "Pattern spacing" }),
      slider(0.5, 3, 0.25, cv.density, (v) => `${v}x`, (v) => setCanvasLook({ density: v })),
      h("div", { class: "sk-pop-sub", text: "Hand-drawn look for new shapes" }),
      slider(0, 3, 0.5, style.roughness, roughName, (v) => { style.roughness = v; rememberStyle(); schedulePanel(); }));
  }

  function openCanvasPop(anchor, at) {
    const pop = openPop(anchor, [h("div", { class: "sk-pop-title", text: "Canvas" }), canvasControls()], "sk-canvas-pop", at);
    if (pop) keepKeys(pop);
  }

  /* ── quick menu (right-click on empty canvas) ─────────────────────────── */
  const QUICK_TOOLS = ["select", "hand", "freedraw", "eraser", "lasso", "piece", "rectangle", "ellipse", "diamond", "arrow", "line", "text", "sticky", "card", "frame", "laser", "image", "picker"];
  function toolLabel(id) {
    const t = TOOLS.find((x) => x && x.id === id);
    if (t) return `${t.name} (${t.keys}${t.num && t.num !== t.keys ? " or " + t.num : ""})`;
    return { lasso: "Lasso (W, or Alt-drag)", laser: "Laser pointer (K)", picker: "Eyedropper (I)" }[id] || id;
  }
  const TOOL_ICON = { freedraw: "pen", laser: "laser", picker: "picker", lasso: "lasso" };

  function openQuick(clientX, clientY) {
    updateRect();
    const wx = toWorldX(clientX - rect.left);
    const wy = toWorldY(clientY - rect.top);
    const grid = h("div", { class: "sk-q-tools" }, QUICK_TOOLS.filter((id) => !readOnly || id === "hand" || id === "laser" || id === "select").map((id) => {
      const t = TOOLS.find((x) => x && x.id === id);
      const b = h("button", { class: "sk-q-tool" + (tool === id ? " is-on" : ""), title: toolLabel(id), tabindex: "-1" }, ic(t ? t.icon : TOOL_ICON[id] || id));
      b.addEventListener("click", () => {
        closePop();
        if (id === "card") openNotePicker([wx, wy]);
        else setTool(id);
      });
      return b;
    }));
    const item = (name, label, keys, run) => h("button", { class: "sk-q-item", tabindex: "-1", onclick: () => { closePop(); run(); } }, ic(name), h("span", { text: label }), keys ? h("kbd", { text: keys }) : null);
    const anyLocked = els.some((el) => !el.isDeleted && el.locked);
    const list = h("div", { class: "sk-q-list" },
      readOnly ? null : item("clipboard", "Paste here", "Ctrl V", () => { ptr.wx = wx; ptr.wy = wy; pasteFallback(); }),
      readOnly ? null : item("card", "Link a note here", "N", () => openNotePicker([wx, wy])),
      item("checkSquare", "Select all", "Ctrl A", selectAll),
      item("search", "Find in sketch", "Ctrl F", openSearch),
      item("outline", "Outline", "Shift O", () => toggleOutline(true)),
      anyLocked ? item("lock", "Unlock everything", null, unlockAll) : null);
    const icons = h("div", { class: "sk-q-row" },
      h("button", { class: "sk-cbtn", title: "Zoom to fit (Shift+1)", tabindex: "-1", onclick: () => { closePop(); fitAll(); } }, ic("fit")),
      h("button", { class: "sk-cbtn", title: "Copy the sketch as PNG (Shift+Alt+C)", tabindex: "-1", onclick: () => { closePop(); copyPng(true); } }, ic("image")),
      h("button", { class: "sk-cbtn", title: "Copy the sketch as SVG", tabindex: "-1", onclick: () => { closePop(); copySvg(true); } }, icon("fileText")),
      h("button", { class: "sk-cbtn" + (gridOn ? " is-on" : ""), title: "Snap to grid (G)", tabindex: "-1", onclick: () => { closePop(); toggleGrid(); } }, icon("grid")),
      h("button", { class: "sk-cbtn" + (guidesOn ? " is-on" : ""), title: "Alignment guides (Alt+S)", tabindex: "-1", onclick: () => { closePop(); toggleGuides(); } }, icon("focus")),
      h("button", { class: "sk-cbtn" + (mapOn ? " is-on" : ""), title: "Minimap (M)", tabindex: "-1", onclick: () => { closePop(); toggleMap(); } }, ic("map")),
      h("button", { class: "sk-cbtn", title: "Keyboard shortcuts (?)", tabindex: "-1", onclick: () => { closePop(); toggleHelp(true); } }, icon("keyboard")));
    const pop = openPop(null, [grid, list, readOnly ? null : h("div", { class: "sk-q-canvas" }, h("div", { class: "sk-pop-title", text: "Canvas" }), canvasControls()), icons], "sk-quick", { x: clientX - rect.left + 4, y: clientY - rect.top + 4 });
    if (pop) keepKeys(pop);
  }

  /* ── search & outline ─────────────────────────────────────────────────── */
  let flyRaf = 0;
  /** Glide the view so the world box is in sight. */
  function flyTo(b, maxK = Math.max(view.k, 1)) {
    if (!b || !W) return;
    const top = 56;
    const pad = 90;
    const bw = Math.max(1, b[2] - b[0]);
    const bh = Math.max(1, b[3] - b[1]);
    const tk = clamp(Math.min((W - pad * 2) / bw, (H - top - pad * 2) / bh, maxK), MIN_K, MAX_K);
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const sy = top / 2 + H / 2;
    const k0 = view.k;
    const fx = toWorldX(W / 2);
    const fy = toWorldY(sy);
    const t0 = performance.now();
    cancelAnimationFrame(flyRaf);
    const step = (t) => {
      if (destroyed) return;
      const u = Math.min(1, (t - t0) / 320);
      const e = 1 - Math.pow(1 - u, 3);
      const k = k0 * Math.pow(tk / k0, e);
      const x = fx + (cx - fx) * e;
      const y = fy + (cy - fy) * e;
      setView(W / 2 - x * k, sy - y * k, k);
      if (u < 1) flyRaf = requestAnimationFrame(step);
    };
    flyRaf = requestAnimationFrame(step);
  }
  const flyToId = (id) => {
    const e = alive(id);
    if (e) flyTo(M.elementBounds(e));
  };

  let searchInput = null;
  function openSearch() {
    if (!searchEl.hidden && searchInput) {
      searchInput.focus();
      searchInput.select();
      return;
    }
    const input = h("input", { class: "sk-search-input", placeholder: "Find text, cards and frames", spellcheck: false });
    searchInput = input;
    const count = h("span", { class: "sk-search-count" });
    const list = h("div", { class: "sk-search-list" });
    let hits = [];
    const KIND_ICON = { frame: "frame", note: "card", sticky: "sticky", text: "text", link: "link" };
    const paint = () => {
      count.textContent = !input.value.trim() ? "" : hits.length ? `${foundAt + 1} of ${hits.length}` : "No matches";
      list.replaceChildren(...hits.slice(0, 8).map((x, i) => {
        const b = h("button", { class: "sk-search-row" + (i === foundAt ? " is-on" : ""), tabindex: "-1" }, ic(KIND_ICON[x.kind] || "text"), h("span", { text: x.label }));
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => { foundAt = i; paint(); flyToId(found[i]); invalidate(false); });
        return b;
      }));
      list.hidden = hits.length < 2;
    };
    const run = () => {
      hits = M.searchScene(els, input.value);
      found = hits.map((x) => x.id);
      foundAt = hits.length ? 0 : -1;
      paint();
      if (hits.length) flyToId(found[0]);
      invalidate(false);
    };
    const go = (d) => {
      if (!hits.length) return;
      foundAt = (foundAt + d + hits.length) % hits.length;
      paint();
      flyToId(found[foundAt]);
      invalidate(false);
    };
    let t = 0;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 120); });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(t); if (!hits.length || foundAt < 0) run(); else go(e.shiftKey ? -1 : 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); go(-1); }
      else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
      else if ((e.ctrlKey || e.metaKey) && e.code === "KeyF") { e.preventDefault(); input.select(); }
    });
    const btn = (name, title, run) => h("button", { class: "sk-btn", title, tabindex: "-1", onmousedown: (e) => e.preventDefault(), onclick: run }, typeof name === "string" && I[name] ? ic(name) : icon(name));
    searchEl.replaceChildren(
      h("div", { class: "sk-search-bar" }, ic("search", "sk-search-ico"), input, count,
        btn("arrowUp", "Previous (Shift+Enter)", () => go(-1)),
        btn("arrowDown", "Next (Enter)", () => go(1)),
        btn("x", "Close (Esc)", () => closeSearch())),
      list);
    list.hidden = true;
    searchEl.hidden = false;
    root.classList.add("has-search");
    input.focus();
  }

  function closeSearch() {
    if (searchEl.hidden) return;
    searchEl.hidden = true;
    root.classList.remove("has-search");
    found = [];
    foundAt = -1;
    searchInput = null;
    invalidate(false);
    root.focus({ preventScroll: true });
  }

  function toggleOutline(on = !outlineOpen) {
    outlineOpen = on;
    outlineEl.hidden = !on;
    outlineBtn.classList.toggle("is-on", on);
    if (on) renderOutline();
  }

  function renderOutline() {
    outlineDirty = false;
    const items = M.outlineOf(els);
    const frameCount = items.filter((x) => x.kind === "frame").length;
    const rowFor = (x) => {
      const b = h("button", { class: "sk-ol-row", title: x.kind === "note" ? "Click to go there, double-click to open the note" : "Click to go there", tabindex: "-1" }, ic(x.kind === "frame" ? "frame" : "card"), h("span", { text: x.label }));
      b.addEventListener("click", () => { flyToId(x.id); setSelection([x.id]); });
      if (x.kind === "note") b.addEventListener("dblclick", () => { const e = alive(x.id); if (e) openCardNote(e, false); });
      return b;
    };
    outlineEl.replaceChildren(...[
      h("div", { class: "sk-ol-head" }, h("span", { class: "sk-ol-title", text: "Outline" }),
        h("button", { class: "sk-btn", title: "Close (Shift+O)", tabindex: "-1", onclick: () => toggleOutline(false) }, icon("x"))),
      items.length ? null : h("div", { class: "sk-ol-empty", text: "Frames (F) and linked notes (N) show up here, so you can jump between them." }),
      frameCount ? h("div", { class: "sk-ol-group", text: "Frames" }) : null,
      ...items.filter((x) => x.kind === "frame").map(rowFor),
      items.length > frameCount ? h("div", { class: "sk-ol-group", text: "Notes" }) : null,
      ...items.filter((x) => x.kind === "note").map(rowFor)].filter(Boolean));
  }

  /* ── note cards ───────────────────────────────────────────────────────── */
  const vault = () => app.vault || null;
  function notePathFor(p) {
    const v = vault();
    if (!v || !p) return null;
    if (v.notes && v.notes.has(p)) return p;
    if (v.notes && v.notes.has(p + ".md")) return p + ".md";
    try {
      const r = v.resolve ? v.resolve(p, path) : null;
      if (r && v.notes.has(r)) return r;
    } catch { /* not a link */ }
    return null;
  }

  function openCardNote(e, side) {
    const target = M.linkedNote(e);
    if (!target) return false;
    const v = vault();
    const p = notePathFor(target);
    if (p) {
      if (side && app.openSplit) app.openSplit(p);
      else if (app.openNote) app.openNote(p, { newTab: true });
      return true;
    }
    if (v && v.files && v.files.has(target) && app.openFile) {
      app.openFile(target, { newTab: true });
      return true;
    }
    toast("That note is not in the vault any more", { ms: 2000 });
    return true;
  }

  function cardText(p) {
    const v = vault();
    const n = v && v.get ? v.get(p) : null;
    const title = n ? n.title : basename(p).replace(/\.md$/i, "");
    return M.noteCardText(title, n ? M.excerptOf(n.content, 150) : "");
  }

  /** Cards for vault paths, laid out in a loose grid around `at`. */
  function addNoteCards(paths, at) {
    const list = [...new Set(paths)].filter((p) => typeof p === "string" && p).slice(0, 40);
    if (!list.length || readOnly) return;
    const cols = Math.ceil(Math.sqrt(list.length));
    const created = [];
    const before = new Map();
    const selBefore = [...selected];
    // other cards already there push new ones down, so none hide another
    const taken = els.filter((e) => !e.isDeleted && M.isNoteCard(e)).map((e) => M.elementBounds(e));
    list.forEach((p, i) => {
      const x = at[0] - 130 + (i % cols) * 290 - ((Math.min(cols, list.length) - 1) * 290) / 2;
      let y = at[1] - 50 + Math.floor(i / cols) * 190;
      for (let k = 0; k < 40 && taken.some((b) => M.boxesIntersect(b, [x - 8, y - 8, x + 268, y + 108])); k++) y += 24;
      const card = M.newElement("rectangle", {
        x, y, width: 260, height: 100, strokeColor: "#22598f", backgroundColor: "#ffffff", fillStyle: "solid", strokeWidth: 1, roughness: 0,
        roundness: { type: 3 }, link: M.wikiLinkFor(p), customData: { notePath: p },
      }, style);
      const t = M.newElement("text", {
        containerId: card.id, text: "", originalText: cardText(p), fontSize: 16, fontFamily: M.FONT_NORMAL, textAlign: "left", verticalAlign: "top",
        strokeColor: "#1e1e1e", lineHeight: M.defaultLineHeight(M.FONT_NORMAL), customData: { titleLine: true },
      }, style);
      addElement(card);
      addElement(t, card);
      addBoundRef(card, t.id, "text");
      relayout(card);
      // hug the text
      card.height = Math.max(64, t.height + M.CARD_PADDING * 2);
      relayout(card);
      before.set(card.id, { ...card, isDeleted: true });
      before.set(t.id, { ...t, isDeleted: true });
      created.push(card);
      taken.push(M.elementBounds(card));
    });
    assignFrames(created);
    if (tool !== "select") setTool("select");
    setSelection(created.map((e) => e.id));
    commit(before, { selBefore });
    dirtyMap = true;
    invalidate();
    toast(created.length === 1 ? "Note linked. Double-click the card to open it" : `${created.length} notes linked`, { ms: 1800 });
  }

  function refreshCard(card) {
    const t = boundTextOf(card);
    if (!t || !M.isNoteCard(card)) return;
    const before = snap([card, t]);
    t.originalText = cardText(card.customData.notePath);
    M.bumpVersion(t);
    relayout(card);
    commit(before);
    invalidate();
  }

  // A note card follows its note: once the note is saved (a moment after
  // typing pauses), the card's words are brought up to date - only when they
  // really differ, and as one undoable step like the menu's Refresh.
  const cardsDue = new Set();
  const refreshDue = debounce(() => {
    if (destroyed) return;
    for (const card of scene.elements) {
      if (card.isDeleted || !M.isNoteCard(card) || !cardsDue.has(card.customData.notePath)) continue;
      const t = boundTextOf(card);
      if (t && t.originalText !== cardText(card.customData.notePath)) refreshCard(card);
    }
    cardsDue.clear();
  }, 800);
  const offCards = app.vault && app.vault.bus ? app.vault.bus.on("changed", ({ path }) => { cardsDue.add(path); refreshDue(); }) : null;

  function openNotePicker(atWorld) {
    const v = vault();
    if (!v || !v.notes || !v.notes.size) {
      toast("There are no notes to link yet", { ms: 1600 });
      return;
    }
    const recent = (app.recentPaths ? app.recentPaths() : []).filter((p) => v.notes.has(p));
    const all = [...v.notes.values()];
    const input = h("input", { class: "sk-np-input", placeholder: "Link a note: type to find it", spellcheck: false });
    const listEl = h("div", { class: "sk-np-list" });
    let items = [];
    let sel = 0;
    let placed = 0;
    const score = (n, q) => {
      const t = n.title.toLowerCase();
      if (t.startsWith(q)) return 4;
      if (t.includes(q)) return 3;
      return n.path.toLowerCase().includes(q) ? 1 : 0;
    };
    const add = (n, keep) => {
      const base = atWorld || [toWorldX(W / 2), toWorldY(H / 2)];
      addNoteCards([n.path], [base[0] + placed * 28, base[1] + placed * 28]);
      placed++;
      if (!keep) { closePop(); root.focus({ preventScroll: true }); }
      else input.focus();
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        const rs = new Set(recent);
        items = [...recent.map((p) => v.notes.get(p)), ...all.filter((n) => !rs.has(n.path)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0))].slice(0, 40);
      } else {
        items = all.map((n) => [n, score(n, q)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1] || a[0].title.localeCompare(b[0].title)).slice(0, 40).map((x) => x[0]);
      }
      sel = clamp(sel, 0, Math.max(0, items.length - 1));
      listEl.replaceChildren(...items.map((n, i) => {
        const b = h("button", { class: "sk-np-row" + (i === sel ? " is-on" : ""), tabindex: "-1" }, icon("fileText"), h("span", { class: "sk-np-title", text: n.title }), n.folder ? h("span", { class: "sk-np-sub", text: n.folder }) : null);
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", (e) => add(n, e.ctrlKey || e.metaKey || e.shiftKey));
        return b;
      }));
      if (!items.length) listEl.append(h("div", { class: "sk-np-empty", text: "No notes match" }));
    };
    input.addEventListener("input", () => { sel = 0; render(); });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = clamp(sel + (e.key === "ArrowDown" ? 1 : -1), 0, Math.max(0, items.length - 1));
        render();
        listEl.children[sel]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[sel]) add(items[sel], e.ctrlKey || e.metaKey);
      } else if (e.key === "Escape") {
        closePop();
        root.focus({ preventScroll: true });
      }
    });
    render();
    openPop(null, [
      h("div", { class: "sk-np-head" }, ic("card"), input),
      listEl,
      h("div", { class: "sk-np-foot", text: "Enter links it. Ctrl+Enter links it and stays open. You can also drop notes from the file tree." }),
    ], "sk-np-pop", { x: W / 2 - 180, y: 62 });
    input.focus();
  }

  /* ── export & send ────────────────────────────────────────────────────── */
  const sketchBase = () => (path ? basename(path).replace(/\.(leocanvas|leopaint|leovector|excalidraw)$/i, "") : "Sketch");
  const stamp = () => {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  };

  async function pngBlob(list) {
    await Promise.all(list.filter((e) => e.type === "image").map((e) => ensureImage(e.fileId)));
    const c = R.elementsToCanvas(list, { dark: false, scale: 2, background: M.canvasColor(scene.appState, false) || "#ffffff", getImage, padding: 24 });
    if (!c) return null;
    return new Promise((res) => c.toBlob(res, "image/png"));
  }

  /** Write a file next to the drawing (inside the vault), else download it. */
  async function saveBeside(name, bytes, mime) {
    const dir = path ? dirname(path) : "";
    const host = app.host;
    if (host && host.writeFile) {
      let p = (dir ? dir + "/" : "") + name;
      const files = vault() && vault().files;
      const dot = name.lastIndexOf(".");
      for (let i = 2; files && files.has(p); i++) p = (dir ? dir + "/" : "") + `${name.slice(0, dot)} ${i}${name.slice(dot)}`;
      const entry = await host.writeFile(p, bytes);
      const v = vault();
      if (entry && entry.path && v && v.setFiles && v.files) v.setFiles([...[...v.files.values()].filter((f) => f.path !== entry.path), entry]);
      return (entry && entry.path) || p;
    }
    const a = h("a", { href: URL.createObjectURL(new Blob([bytes], { type: mime })), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return null;
  }

  async function saveExport(kind, all) {
    const list = exportList(all);
    if (!list.length) return toast("Nothing to export yet", { ms: 1400 });
    try {
      let bytes;
      if (kind === "png") bytes = new Uint8Array(await (await pngBlob(list)).arrayBuffer());
      else bytes = new TextEncoder().encode(R.elementsToSvg(list, { dark: false, files, background: M.canvasColor(scene.appState, false) || "#ffffff", padding: 24 }).svg);
      const p = await saveBeside(`${sketchBase()}${all ? "" : " selection"} ${stamp()}.${kind}`, bytes, kind === "png" ? "image/png" : "image/svg+xml");
      toast(p ? `Saved ${basename(p)}` : `Exported as ${kind.toUpperCase()}`, { ms: 2000 });
    } catch (err) {
      toast("Could not export: " + (err && err.message ? err.message : err), { kind: "error" });
    }
  }

  const lastNote = () => {
    const v = vault();
    if (!v || !v.notes) return null;
    const p = app.lastNotePath ? app.lastNotePath() : null;
    if (p && v.notes.has(p)) return p;
    return (app.recentPaths ? app.recentPaths() : []).find((x) => v.notes.has(x)) || null;
  };

  /**
   * Put the drawing (or a picture of the selection) at the end of the note
   * you were last in. Without a note to send to, it goes to the clipboard.
   */
  async function sendToNote(all) {
    const target = lastNote();
    const v = vault();
    const list = exportList(all);
    if (!list.length) return toast("Nothing to send yet", { ms: 1400 });
    if (!target || !v || !v.write || !path) {
      await copyPng(all);
      return;
    }
    try {
      let embed;
      const whole = all || list.length === visible().length;
      if (whole) embed = `![[${basename(path)}]]`;
      else {
        const blob = await pngBlob(list);
        const p = await saveBeside(`${sketchBase()} ${stamp()}.png`, new Uint8Array(await blob.arrayBuffer()), "image/png");
        if (!p) return;
        embed = `![[${basename(p)}]]`;
      }
      if (app.flushAll) await app.flushAll();
      const ed = app.editor;
      const cur = (ed && ed.content ? ed.content(target) : null) ?? (v.get(target) || {}).content ?? "";
      const next = cur.replace(/\s*$/, "") + `\n\n${embed}\n`;
      await v.write(target, next);
      if (ed && ed.applyExternal) ed.applyExternal(target, next);
      toast(`${whole ? "Sketch" : "Picture"} added to ${(v.get(target) || {}).title || basename(target)}`, { ms: 2200 });
    } catch (err) {
      toast("Could not send it: " + (err && err.message ? err.message : err), { kind: "error" });
    }
  }

  function openExportMenu(x, y) {
    const hasSel = selected.size > 0;
    const target = lastNote();
    const tname = target ? ((vault().get(target) || {}).title || basename(target)) : null;
    menu(x, y, [
      { header: hasSel ? "Selection" : "Whole sketch" },
      { label: "Copy as PNG", keys: "Shift Alt C", icon: "image", run: () => copyPng(!hasSel) },
      { label: "Copy as SVG", icon: "fileText", run: () => copySvg(!hasSel) },
      path ? { label: "Save PNG next to the sketch", icon: "save", run: () => saveExport("png", !hasSel) } : null,
      path ? { label: "Save SVG next to the sketch", icon: "save", run: () => saveExport("svg", !hasSel) } : null,
      "sep",
      tname && path ? { label: hasSel ? `Send a picture to “${tname}”` : `Embed in “${tname}”`, icon: "arrowUp", run: () => sendToNote(!hasSel) } : null,
    ]);
  }

  /* ── toolbar & menus ──────────────────────────────────────────────────── */
  const toolButtons = new Map();
  let lockBtn = null;
  let laserBtn = null;
  const toolTitle = (t) => `${t.name} (${t.keys}${t.num && t.num !== t.keys ? " or " + t.num : ""})${t.hint ? ": " + t.hint : ""}`;
  function buildToolbar() {
    // Which of the two drawing modes this is, and the way to the other one.
    // paintmode.js loads only when the badge is clicked.
    // The same three-way switch the Draw editor carries, so the way across is
    // where the eye already looks for it.
    const cross = (target) => (e) => { const a = e.currentTarget; import("./paintmode.js").then((m) => m.switchMode(app, path, target, a)); };
    const panel = (id) => (e) => import("./paintmode.js").then((m) => m.personaPanel(app, path, id, e));
    const modeBadge = h("div", { class: "sk-modes", role: "group", "aria-label": "Way of working" },
      h("button", { class: "sk-mode is-on", tabindex: "-1", title: "Leopaint (.leopaint): shapes, arrows, text and pen lines on an endless board, for working ideas out. Click to start from a template; right-click for more", onclick: (e) => { const a = e.currentTarget; import("./paintmode.js").then((m) => m.templateMenu(app, path, a, { isEmpty: !readOnly && !visible().length, apply: applyTemplate })); }, oncontextmenu: panel("vector") }, ic("brush"), h("span", { text: "Paint" })),
      h("span", { class: "sk-modes-sep", title: "Leostudio - Studio, Filter and Animate - is another kind of file, on pixels" }),
      h("button", { class: "sk-mode", tabindex: "-1", title: "Studio (.leostudio): brushes on pixels, with layers and blend modes. Right-click for more", onclick: cross("draw"), oncontextmenu: panel("paint") }, ic("compass"), h("span", { text: "Studio" })),
      h("button", { class: "sk-mode", tabindex: "-1", title: "Filter (.leostudio): adjust and retouch - curves, masks, cut-outs, export sizes. Right-click for more", onclick: cross("studio"), oncontextmenu: panel("photo") }, ic("image"), h("span", { text: "Filter" })),
      h("button", { class: "sk-mode", tabindex: "-1", title: "Animate (.leostudio): frame by frame, saved as a video for Instagram. Right-click for more", onclick: cross("animate"), oncontextmenu: panel("animate") }, ic("animate"), h("span", { text: "Animate" })));
    lockBtn = h("button", { class: "sk-tool sk-lock", title: "Lock the tool (Q). Unlocked, a shape, line or text you draw sends you back to Select; locked, the tool stays - draw several rectangles (or arrows, notes...) one after another", tabindex: "-1", onclick: () => toggleToolLock() }, ic("unlock"));
    toolbar.append(modeBadge, h("span", { class: "sk-tool-sep" }), lockBtn, h("span", { class: "sk-tool-sep" }));
    for (const t of TOOLS) {
      if (t === "sep") { toolbar.append(h("span", { class: "sk-tool-sep" })); continue; }
      const b = h("button", {
        class: "sk-tool",
        title: toolTitle(t),
        tabindex: "-1",
        dataset: { tool: t.id },
        onclick: () => setTool(t.id),
      }, ic(t.icon), t.num ? h("span", { class: "sk-tool-num", text: t.num }) : null);
      toolButtons.set(t.id, b);
      // a right click on a tool opens what there is to set about it
      if (t.id !== "freedraw") b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (t.id === "measure") { setTool("measure"); if (measure) measure.openUnits(b); return; }
        setTool(t.id);
        if (!panelPinned) { panelPinned = true; saveSetting("sketchPanelPinned", true); }
        schedulePanel();
      });
      if (t.id === "freedraw") {
        // the pen is six kinds of pen: a right click, or the corner mark, lays them all out
        b.classList.add("has-more");
        b.append(h("span", { class: "sk-tool-more", title: "Every kind of pen" }));
        b.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openPenFlyout(b); });
        b.addEventListener("click", (e) => { if (e.target.closest(".sk-tool-more")) { e.stopImmediatePropagation(); openPenFlyout(b); } }, true);
      }
      toolbar.append(b);
    }
    toolbar.append(h("span", { class: "sk-tool-sep" }));
    laserBtn = h("button", { class: "sk-tool", title: "Laser pointer (K): a fading trail for presenting", tabindex: "-1", onclick: () => setTool("laser") }, ic("laser"));
    const more = h("button", { class: "sk-tool", title: "More", tabindex: "-1" }, ic("more"));
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      openMoreMenu(r.left, r.bottom + 6, more);
    });
    toolbar.append(laserBtn, more);
    zoomLabel.addEventListener("click", () => {
      const r = zoomLabel.getBoundingClientRect();
      menu(r.left, r.top - 8, [
        { label: "Zoom to fit", keys: "Shift 1", icon: "expand", run: fitAll },
        { label: "Zoom to selection", keys: "Shift 2", icon: "focus", run: fitSelection },
        "sep",
        { label: "50%", checked: Math.abs(view.k - 0.5) < 0.005, run: () => zoomTo(0.5) },
        { label: "100%", keys: "Shift 0", checked: Math.abs(view.k - 1) < 0.005, run: () => zoomTo(1) },
        { label: "200%", checked: Math.abs(view.k - 2) < 0.005, run: () => zoomTo(2) },
      ]);
    });
    exportBtn.addEventListener("click", () => {
      const r = exportBtn.getBoundingClientRect();
      openExportMenu(r.left, r.top - 8);
    });
  }

  let paintedBrush = "";
  function paintToolbar() {
    for (const [id, b] of toolButtons) b.classList.toggle("is-on", tool === id || (id === "select" && tool === "lasso"));
    laserBtn.classList.toggle("is-on", tool === "laser");
    lockBtn.classList.toggle("is-on", toolLocked);
    lockBtn.replaceChildren(ic(toolLocked ? "lock" : "unlock"));
    toolbar.classList.toggle("is-readonly", readOnly);
    // the pen button shows the brush family and colour it will draw with
    const pen = toolButtons.get("freedraw");
    const b = currentBrush();
    const key = b.id + "|" + style.strokeColor + "|" + dark;
    if (pen && key !== paintedBrush) {
      paintedBrush = key;
      const fam = brushFamily(b);
      pen.replaceChildren(ic(fam === "pen" && b.id === "pen" ? "pen" : FAMILY_ICON[fam] || "pen"), h("span", { class: "sk-tool-num", text: String({ pencil: 2, pen: 3, marker: 4, brush: 5, highlighter: 6, chalk: 7 }[fam] || "2-7") }), h("span", { class: "sk-tool-dot", style: { background: M.themeColor(style.strokeColor, dark) } }));
      pen.title = `${brushName(b)}: pen and brushes (P or 7). Click again or press B for brushes`;
    }
  }

  function openMoreMenu(x, y, anchor) {
    const hasSel = selected.size > 0;
    menu(x, y, [
      { label: "Lasso select", keys: "W", icon: "focus", run: () => setTool("lasso") },
      { label: "Eyedropper", keys: "I", icon: "palette", run: () => setTool("picker") },
      { label: "Brushes", keys: "B", icon: "brush", run: () => openBrushPicker(toolButtons.get("freedraw")) },
      "sep",
      { label: "Canvas background and pattern", icon: "palette", run: () => openCanvasPop(anchor) },
      { label: "Snap to grid", keys: "G", icon: "grid", checked: gridOn, run: () => toggleGrid() },
      { label: "Alignment guides", keys: "Alt S", icon: "focus", checked: guidesOn, run: () => toggleGuides() },
      { label: "Minimap", keys: "M", icon: "graph", checked: mapOn, run: () => toggleMap() },
      "sep",
      ...measure.moreMenuItems(anchor),
      "sep",
      { label: "Find in sketch", keys: "Ctrl F", icon: "search", run: openSearch },
      { label: "Outline", keys: "Shift O", icon: "list", checked: outlineOpen, run: () => toggleOutline() },
      { label: hasSel ? "Copy selection as PNG" : "Copy as PNG", keys: "Shift Alt C", icon: "image", run: () => copyPng(!hasSel) },
      { label: hasSel ? "Copy selection as SVG" : "Copy as SVG", icon: "fileText", run: () => copySvg(!hasSel) },
      path ? { label: "Export and send…", icon: "arrowUp", run: () => { const r = exportBtn.getBoundingClientRect(); openExportMenu(r.left, r.top - 8); } } : null,
      "sep",
      els.some((e) => !e.isDeleted && e.locked) ? { label: "Unlock everything", icon: "lock", run: unlockAll } : null,
      { label: "Zoom to fit", keys: "Shift 1", icon: "expand", run: fitAll },
      { label: "Keyboard shortcuts", keys: "?", icon: "keyboard", run: () => toggleHelp(true) },
    ]);
  }

  /** A right click: the element's menu, or the quick menu on empty canvas. */
  function openContextAt(clientX, clientY) {
    if (destroyed) return;
    updateRect();
    ptr.sx = clientX - rect.left;
    ptr.sy = clientY - rect.top;
    ptr.wx = toWorldX(ptr.sx);
    ptr.wy = toWorldY(ptr.sy);
    if (editing) finishText();
    if (draft) finishDraft(true);
    const hit = hitAt(ptr.wx, ptr.wy, { locked: true });
    if (hit && !selected.has(hit.id)) setSelection(hit.locked ? [hit.id] : unitOf(hit).map((x) => x.id));
    const list = hit ? selectedEls() : [];
    if (!list.length) {
      if (selected.size) setSelection([]);
      openQuick(clientX, clientY);
      return;
    }
    const x = clientX;
    const y = clientY;
    const allLocked = list.every((el) => el.locked);
    const single = list.length === 1 ? list[0] : null;
    const shapes = list.filter((el) => M.SHAPES.has(el.type) && !isPaper(el));
    const grouped = list.some((el) => el.groupIds && el.groupIds.length);
    if (allLocked) {
      menu(x, y, [
        { label: "Unlock", keys: "Ctrl Shift L", icon: "lock", run: () => setLocked(list, false) },
        { label: "Copy", keys: "Ctrl C", icon: "clipboard", run: () => menuCopy(false) },
      ]);
      return;
    }
    const note = single ? M.linkedNote(single) : null;
    menu(x, y, [
      note ? { label: "Open note", keys: "Double-click", icon: "fileText", run: () => openCardNote(single, false) } : null,
      note && app.openSplit ? { label: "Open note to the side", icon: "columns", run: () => openCardNote(single, true) } : null,
      single && M.isNoteCard(single) ? { label: "Refresh from the note", icon: "repeat", run: () => refreshCard(single) } : null,
      note ? "sep" : null,
      { label: "Cut", keys: "Ctrl X", icon: "scissors", run: () => menuCopy(true) },
      { label: "Copy", keys: "Ctrl C", icon: "clipboard", run: () => menuCopy(false) },
      { label: "Paste", keys: "Ctrl V", run: () => pasteFallback() },
      { label: "Duplicate", keys: "Ctrl D", icon: "plus", run: () => duplicateSelection() },
      "sep",
      { label: "Copy as PNG", keys: "Shift Alt C", icon: "image", run: () => copyPng(false) },
      { label: "Copy as SVG", icon: "fileText", run: () => copySvg(false) },
      path && lastNote() ? { label: `Send a picture to “${(vault().get(lastNote()) || {}).title || basename(lastNote())}”`, icon: "arrowUp", run: () => sendToNote(false) } : null,
      { label: "Copy style", keys: "Ctrl Alt C", icon: "palette", run: copyStyle },
      copiedStyle ? { label: "Paste style", keys: "Ctrl Alt V", icon: "brush", run: pasteStyle } : null,
      "sep",
      shapes.length ? { header: "Change shape" } : null,
      ...(shapes.length ? [["rectangle", "Rectangle", "square"], ["ellipse", "Ellipse", "focus"], ["diamond", "Diamond", "gem"]]
        .map(([t, label, ico]) => ({ label, icon: ico, checked: shapes.every((s) => s.type === t), run: () => morph(t) })) : []),
      shapes.length ? "sep" : null,
      single && isLinear(single) ? { label: "Edit points", keys: "Enter", icon: "edit", run: () => { pointEdit = { id: single.id, sel: new Set() }; showHint("Drag points to reshape. Click a midpoint to add one, Delete removes, Esc when done"); invalidate(false); } } : null,
      single && single.type === "arrow" ? { label: boundTextOf(single) ? "Edit label" : "Add label", icon: "edit", run: () => editContainer(single) } : null,
      single && (M.SHAPES.has(single.type) || single.type === "text") ? { label: "Edit text", keys: "Enter", icon: "edit", run: () => enter() } : null,
      single ? { label: single.link ? "Edit link" : "Add link", keys: "Ctrl K", icon: "link", run: editLink } : null,
      single && single.link && !note ? { label: "Open link", icon: "globe", run: () => openLink(single) } : null,
      "sep",
      { label: "Bring forward", keys: "Ctrl ]", icon: "arrowUp", run: () => layer("forward") },
      { label: "Bring to front", keys: "Ctrl Shift ]", icon: "arrowUp", run: () => layer("front") },
      { label: "Send backward", keys: "Ctrl [", icon: "arrowDown", run: () => layer("backward") },
      { label: "Send to back", keys: "Ctrl Shift [", icon: "arrowDown", run: () => layer("back") },
      "sep",
      list.length > 1 && !isOneGroup(list) ? { label: "Group", keys: "Ctrl G", icon: "box", run: groupSelection } : null,
      grouped ? { label: "Ungroup", keys: "Ctrl Shift G", icon: "grid", run: ungroupSelection } : null,
      { label: "Flip horizontal", keys: "Shift H", icon: "flipH", run: () => flip("x") },
      { label: "Flip vertical", keys: "Shift V", icon: "flipV", run: () => flip("y") },
      { label: "Lock", keys: "Ctrl Shift L", icon: "lock", run: () => setLocked(list, true) },
      "sep",
      list.some((e) => e.type === "frame" || e.type === "magicframe") ? { label: "Remove frame, keep what is inside", icon: "grid", run: () => unframe(list.filter((e) => e.type === "frame" || e.type === "magicframe")) } : null,
      { label: "Delete", keys: "Del", icon: "trash", danger: true, run: deleteSelection },
    ]);
  }

  function onContextMenu(e) {
    // the right button is handled on press and release; this only covers
    // the keyboard's menu key
    e.preventDefault();
    if (destroyed || rightDown || performance.now() - rightUpAt < 600) return;
    const r = root.getBoundingClientRect();
    const x = e.clientX || r.left + W / 2;
    const y = e.clientY || r.top + H / 2;
    openContextAt(x, y);
  }

  /* ── lifecycle ────────────────────────────────────────────────────────── */
  const onPointerLeave = () => {
    ptr.inside = false;
    if (hover) hover = null;
    dirtyOver = true;
    schedule();
  };
  const onPointerEnter = () => {
    updateRect();
    ptr.inside = true;
    needHover = true;
    schedule();
  };
  const onRootPointerDown = (e) => {
    // clicks on the panel or toolbar still leave keys with the drawing
    if (e.target !== cOver && !typing(e.target) && !e.target.closest(".sk-pop, .sk-help")) setTimeout(() => { if (!editing && !popEl && !destroyed && !typing(document.activeElement)) root.focus({ preventScroll: true }); });
  };

  measure = mountMeasure({
    root, h, ic, M, scene, els, byId, view, ptr, selected, readOnly,
    setting, saveSetting, toast, showHint, hideHint, openPop, closePop,
    toWorldX, toWorldY, toScreenX, toScreenY,
    size: () => ({ W, H }),
    viewport: () => { setViewport(); return viewport; },
    invalidate, schedulePanel, markChanged, paintGrid,
    selectedEls, selectionFrame, setSelection, withBound, arrowsBoundTo, snap, commit, refreshArrows, assignFrames, moveBy,
    resizeOne, resizeMany, relayout, addElement, addBoundRef,
    tool: () => tool, setTool,
    dark: () => dark, getImage, startMove: () => startMove({ altKey: false }), startPointDrag: (e, i) => startPointDrag(e, i, { shiftKey: false }, snap([e])),
    gesture: () => gesture,
    setGesture: (g) => { gesture = g; },
    draft: () => draft,
    liveElements: () => [...liveIds].map((id) => byId.get(id)).filter((e) => e && !e.isDeleted),
    style: () => style,
    gridOn: () => gridOn,
    gridSize,
    zoomTo,
    setGridSize: (px) => { if (readOnly) return; scene.appState.gridSize = Math.max(2, Math.round(px * 1000) / 1000); if (!gridOn) toggleGrid(true); else { paintGrid(); markChanged(); } },
    toggleGrid: () => toggleGrid(),
    focus: () => root.focus({ preventScroll: true }),
  });

  readTheme();
  buildToolbar();
  refreshFrames();
  resize();
  const saved = path && lastViews.get(path);
  let needFit = !saved;
  if (saved) setView(saved.x, saved.y, saved.k);
  else if (W > 50 && H > 50) { needFit = false; fitAll(); }
  const fitWhenSized = new ResizeObserver(() => {
    if (needFit && W > 50 && H > 50) { needFit = false; fitAll(); }
  });
  fitWhenSized.observe(root);
  paintUndo();
  paintGrid();
  paintToolbar();
  zoomLabel.textContent = Math.round(view.k * 100) + "%";
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!destroyed) invalidate(); });

  cOver.addEventListener("pointerdown", onPointerDown);
  cOver.addEventListener("pointermove", onPointerMove);
  cOver.addEventListener("pointerup", onPointerUp);
  cOver.addEventListener("pointercancel", onPointerUp);
  cOver.addEventListener("pointerleave", onPointerLeave);
  cOver.addEventListener("pointerenter", onPointerEnter);
  cOver.addEventListener("dblclick", onDblClick);
  cOver.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("keydown", onKey);
  root.addEventListener("pointerdown", onRootPointerDown);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);
  root.addEventListener("dragleave", onDragLeave);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCut);
  document.addEventListener("paste", onPaste);
  schedule();
  schedulePanel();

  function destroy() {
    if (destroyed) return;
    if (offCards) offCards();
    if (editing) finishText();
    if (draft) finishDraft(true);
    if (gesture) endGesture();
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    if (panelRaf) cancelAnimationFrame(panelRaf);
    cancelAnimationFrame(flyRaf);
    clearTimeout(wheelTimer);
    if (saveStyleSoon) { clearTimeout(saveStyleSoon); saveSetting("sketchStyle", { ...style }); }
    ro.disconnect();
    fitWhenSized.disconnect();
    themeObserver.disconnect();
    closePop();
    measure.destroy();
    if (helpEl) helpEl.remove();
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCut);
    document.removeEventListener("paste", onPaste);
    root.remove();
  }

  // a handle on the node, for devtools and the headless checks
  root.__leosketch = { scene, els, byId, view, measure, setTool, setSelection, selectedEls, doUndo, doRedo, get tool() { return tool; } };

  // a new board made from a template: the template goes on once it is on screen
  if (app._sketchTemplate && !readOnly && !visible().length) {
    const id = app._sketchTemplate;
    app._sketchTemplate = null;
    requestAnimationFrame(() => requestAnimationFrame(() => applyTemplate(id)));
  }

  return {
    getText() {
      savedChanges = changes;
      if (readOnly) return originalText;
      return M.serializeScene(scene);
    },
    destroy,
    dirty: () => changes !== savedChanges,
    focus() {
      if (!destroyed) root.focus({ preventScroll: true });
    },
  };
}

/**
 * A static SVG of a drawing for embeds in notes. No listeners, no canvas;
 * rough.js work is shared with earlier renders of the same elements.
 */
export async function renderSketchSvg(text, opts = {}) {
  const { scene, error } = M.parseScene(text);
  if (error) return null;
  const live = scene.elements.filter((e) => !e.isDeleted);
  if (!live.length) return null;
  const dark = opts.theme ? opts.theme === "dark" : document.documentElement.dataset.theme !== "light";
  const fill = M.canvasColor(scene.appState, dark);
  const out = R.elementsToSvg(live, { dark, files: scene.files, padding: 12, background: fill, shared: true, canvasBg: fill || (dark ? "#121214" : "#ffffff") });
  if (!out) return null;
  const tpl = document.createElement("template");
  tpl.innerHTML = out.svg;
  const svg = tpl.content.firstElementChild;
  svg.classList.add("sk-embed");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Drawing");
  const maxW = opts.maxWidth;
  if (maxW && out.width > maxW) {
    svg.setAttribute("width", String(Math.round(maxW)));
    svg.setAttribute("height", String(Math.round((out.height * maxW) / out.width)));
  }
  return svg;
}
