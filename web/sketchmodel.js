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

// Sketch model: pure logic for Excalidraw-format drawings. No DOM here, so
// every rule (file format, geometry, hit tests, bindings, layout helpers)
// runs under node --test.
//
// Elements are plain Excalidraw objects. Unknown fields are never dropped:
// normalizing only fills what is missing or broken, and serializing writes
// the same objects back.

export const BOUND_TEXT_PADDING = 5;
export const CARD_PADDING = 14;
export const DEFAULT_FONT_SIZE = 20;
export const FONT_HAND = 1;
export const FONT_NORMAL = 2;
export const FONT_CODE = 3;
export const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
export const LINEAR = new Set(["arrow", "line"]);
export const KNOWN_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow", "line", "freedraw", "text", "image", "frame", "magicframe", "embeddable", "iframe"]);
const BINDABLE = new Set(["rectangle", "ellipse", "diamond", "image", "text", "frame", "magicframe", "embeddable", "iframe"]);
const CONTAINERS = new Set(["rectangle", "ellipse", "diamond", "arrow"]);
const ROUND_PROPORTIONAL = 2;
const ROUND_ADAPTIVE = 3;

// Excalidraw's own palette: open-color shades 0, 2, 4, 6, 8 per hue
export const PALETTE = {
  gray: ["#f8f9fa", "#e9ecef", "#ced4da", "#868e96", "#343a40"],
  bronze: ["#f8f1ee", "#eaddd7", "#d2bab0", "#a18072", "#846358"],
  red: ["#fff5f5", "#ffc9c9", "#ff8787", "#fa5252", "#e03131"],
  pink: ["#fff0f6", "#fcc2d7", "#f783ac", "#e64980", "#c2255c"],
  grape: ["#f8f0fc", "#eebefa", "#da77f2", "#be4bdb", "#9c36b5"],
  violet: ["#f3f0ff", "#d0bfff", "#9775fa", "#7950f2", "#6741d9"],
  blue: ["#e7f5ff", "#a5d8ff", "#4dabf7", "#228be6", "#1971c2"],
  cyan: ["#e3fafc", "#99e9f2", "#3bc9db", "#15aabf", "#0c8599"],
  teal: ["#e6fcf5", "#96f2d7", "#38d9a9", "#12b886", "#099268"],
  green: ["#ebfbee", "#b2f2bb", "#69db7c", "#40c057", "#2f9e44"],
  yellow: ["#fff9db", "#ffec99", "#ffd43b", "#fab005", "#f08c00"],
  orange: ["#fff4e6", "#ffd8a8", "#ffa94d", "#fd7e14", "#e8590c"],
};
// Sketch's own palette: a soft pastel, a middle and a deep tone per hue,
// picked to sit together (and to survive the dark theme's inversion)
export const NEUTRALS = ["#1e1e1e", "#495057", "#868e96", "#dee2e6", "#ffffff"];
export const SWATCHES = [
  ["Rose", "#ffd6d9", "#f28b94", "#b8323f"],
  ["Coral", "#ffdcc8", "#f59e6b", "#b5541f"],
  ["Amber", "#ffeab0", "#f2c14e", "#a8741a"],
  ["Sage", "#e3edc8", "#a9c46c", "#5c7a2b"],
  ["Mint", "#cdeedd", "#6cc99a", "#1f7a55"],
  ["Teal", "#c9ecec", "#5bbdbf", "#1d6f73"],
  ["Sky", "#d4e8fa", "#6aa9e0", "#22598f"],
  ["Indigo", "#dcdcfa", "#8c8ee6", "#3d3f9c"],
  ["Lilac", "#eadcf7", "#b58ade", "#6a3a9a"],
  ["Berry", "#f7d7e8", "#df7fb0", "#8f2a5e"],
];
export const STROKE_PICKS = ["#1e1e1e", "#b8323f", "#22598f", "#1f7a55", "#a8741a"];
export const BACKGROUND_PICKS = ["transparent", "#ffd6d9", "#cdeedd", "#d4e8fa", "#ffeab0"];

/* ── canvas look ─────────────────────────────────────────────────────────── */

// null = the app's own background
export const CANVAS_LIGHT = [
  [null, "App"], ["#ffffff", "White"], ["#f7f3ea", "Warm paper"], ["#fbf6e4", "Cream"], ["#f1e6d2", "Sepia"],
  ["#eaf0e4", "Sage"], ["#fbefed", "Blush"], ["#eef2f6", "Mist"], ["#e9f1fa", "Sky"], ["#f1eefa", "Lavender"],
];
export const CANVAS_DARK = [
  [null, "App"], ["#1c1c1e", "Charcoal"], ["#1d232b", "Slate"], ["#111a2c", "Midnight"], ["#0e0f12", "Ink"],
  ["#231e18", "Sepia"], ["#172019", "Sage"], ["#1f2a25", "Chalkboard"], ["#241a26", "Plum"], ["#2a2622", "Espresso"],
];
export const PATTERNS = [["plain", "Plain"], ["dots", "Dots"], ["grid", "Grid"], ["lined", "Lined"], ["paper", "Paper"]];

/**
 * Leonote's canvas settings live in appState.leonoteCanvas, a key Excalidraw
 * ignores: { light, dark, pattern, density }. dark may be "app": the app's
 * own background even when the light pick is a colour.
 */
export function canvasOf(appState) {
  const c = appState && appState.leonoteCanvas && typeof appState.leonoteCanvas === "object" ? appState.leonoteCanvas : {};
  const ok = (v) => typeof v === "string" && !!parseColor(v);
  return {
    light: ok(c.light) ? c.light : null,
    dark: ok(c.dark) || c.dark === "app" ? c.dark : null,
    pattern: PATTERNS.some((p) => p[0] === c.pattern) ? c.pattern : "plain",
    density: Number.isFinite(c.density) ? Math.max(0.5, Math.min(3, c.density)) : 1,
  };
}

/** Change canvas settings; keeps viewBackgroundColor meaningful for Excalidraw. */
export function setCanvas(appState, patch) {
  const next = { ...canvasOf(appState), ...patch };
  const out = {};
  if (next.light) out.light = next.light;
  if (next.dark) out.dark = next.dark;
  if (next.pattern !== "plain") out.pattern = next.pattern;
  if (next.density !== 1) out.density = next.density;
  if (Object.keys(out).length) appState.leonoteCanvas = out;
  else delete appState.leonoteCanvas;
  if ("light" in patch) appState.viewBackgroundColor = next.light || "#ffffff";
  return appState;
}

/** The canvas colour to show, or null for the app's own background. */
export function canvasColor(appState, dark) {
  const c = canvasOf(appState);
  if (dark && c.dark) return c.dark === "app" ? null : c.dark;
  if (!dark && c.light) return c.light;
  const bg = appState && appState.viewBackgroundColor;
  // a colour, or nothing: the file's own text goes into a picture's markup, and could carry more than a colour
  if (typeof bg !== "string" || !parseColor(bg) || isDefaultBackground(bg)) return null;
  // a light pick with no dark one follows Excalidraw's dark maths
  return dark ? darkColor(bg) : bg;
}

export const DEFAULT_STYLE = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: "round",
  fontFamily: FONT_HAND,
  fontSize: DEFAULT_FONT_SIZE,
  textAlign: "left",
  startArrowhead: null,
  endArrowhead: "arrow",
  arrowType: "sharp",
};

/* ── ids, seeds, versions ───────────────────────────────────────────────── */

const ID_CHARS = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
export function randomId() {
  let s = "";
  for (let i = 0; i < 21; i++) s += ID_CHARS[(Math.random() * 64) | 0];
  return s;
}
export const randomInteger = () => Math.floor(Math.random() * 2 ** 31);

/** Record a change the way Excalidraw does, so collaborators and merges see it. */
export function bumpVersion(el, now = Date.now()) {
  el.version = (el.version || 0) + 1;
  el.versionNonce = randomInteger();
  el.updated = now;
  return el;
}

/** Apply updates in place and bump the version once. */
export function mutate(el, updates, now) {
  for (const k in updates) el[k] = updates[k];
  return bumpVersion(el, now);
}

/* ── colours ────────────────────────────────────────────────────────────── */

const colorCache = new Map();
const NAMED = { transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1], orange: [255, 165, 0, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1] };

export function parseColor(c) {
  if (typeof c !== "string") return null;
  const s = c.trim().toLowerCase();
  if (Object.hasOwn(NAMED, s)) return NAMED[s].slice(); // own names only: "constructor" is not a colour
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let hx = m[1];
    if (hx.length === 3 || hx.length === 4) hx = [...hx].map((ch) => ch + ch).join("");
    if (hx.length !== 6 && hx.length !== 8) return null;
    const n = (i) => parseInt(hx.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hx.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    let a = m[4] == null ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith("%")) a /= 100;
    return [+m[1], +m[2], +m[3], a];
  }
  return null;
}

export function isTransparent(c) {
  if (!c || c === "transparent") return true;
  const p = parseColor(c);
  return !!p && p[3] === 0;
}

const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
export const toHex = (r, g, b, a = 1) => "#" + hex2(r) + hex2(g) + hex2(b) + (a < 1 ? hex2(a * 255) : "");

/**
 * The colour a stored colour takes in the dark theme. Same maths as
 * Excalidraw's dark mode (invert 93%, then hue-rotate 180deg), so a drawing
 * looks the way people know it from excalidraw.com: near-black strokes turn
 * light, pastel fills turn deep, hues stay recognisable.
 */
export function darkColor(c) {
  if (typeof c !== "string") return c;
  let out = colorCache.get(c);
  if (out) return out;
  const p = parseColor(c);
  if (!p || p[3] === 0) out = c;
  else {
    const r = 0.93 - 0.86 * (p[0] / 255);
    const g = 0.93 - 0.86 * (p[1] / 255);
    const b = 0.93 - 0.86 * (p[2] / 255);
    const rr = -0.574 * r + 1.43 * g + 0.144 * b;
    const gg = 0.426 * r + 0.43 * g + 0.144 * b;
    const bb = 0.426 * r + 1.43 * g - 0.856 * b;
    out = toHex(rr * 255, gg * 255, bb * 255, p[3]);
  }
  if (colorCache.size > 2000) colorCache.clear();
  colorCache.set(c, out);
  return out;
}

export const themeColor = (c, dark) => (dark ? darkColor(c) : c);

/** A viewBackgroundColor that means "the app's own background". */
export function isDefaultBackground(c) {
  const p = parseColor(c);
  return !p || p[3] === 0 || (p[0] > 250 && p[1] > 250 && p[2] > 250);
}

/* ── file format ────────────────────────────────────────────────────────── */

const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v, d) => (typeof v === "string" ? v : d);

export function defaultLineHeight(fontFamily) {
  if (fontFamily === FONT_NORMAL || fontFamily === 6 || fontFamily === 9) return 1.15;
  if (fontFamily === FONT_CODE || fontFamily === 8) return 1.2;
  return 1.25;
}

function cleanPoints(points, fallbackW, fallbackH) {
  const out = [];
  if (Array.isArray(points)) {
    for (const p of points) {
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push(p.length === 2 ? p : [p[0], p[1]]);
    }
  }
  if (!out.length) out.push([0, 0], [fallbackW, fallbackH]);
  return out;
}

/**
 * Fill in what an element needs to be drawn and edited, keeping every field
 * we do not know about. Returns null for things that are not elements.
 */
export function normalizeElement(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return null;
  const el = { ...raw };
  const setIf = (k, ok, v) => { if (!ok(el[k])) el[k] = v; };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isStr = (v) => typeof v === "string";
  if (!isStr(el.id) || !el.id) el.id = randomId();
  el.x = num(el.x);
  el.y = num(el.y);
  el.width = num(el.width);
  el.height = num(el.height);
  el.angle = num(el.angle);
  // colours and styles go into the drawing's SVG as they are: only a real colour, only a known style - a
  // shared file's '"/><style>…' is not a colour (it would land in the page as markup)
  const isColor = (v) => isStr(v) && v.length < 64 && parseColor(v) !== null;
  setIf("strokeColor", isColor, "#1e1e1e");
  setIf("backgroundColor", isColor, "transparent");
  setIf("fillStyle", (v) => ["solid", "hachure", "cross-hatch", "zigzag", "dots", "dashed", "zigzag-line"].includes(v), "solid");
  setIf("strokeWidth", isNum, 2);
  setIf("strokeStyle", (v) => ["solid", "dashed", "dotted"].includes(v), "solid");
  setIf("roughness", isNum, 1);
  setIf("opacity", isNum, 100);
  setIf("groupIds", Array.isArray, []);
  if (el.frameId === undefined) el.frameId = null;
  if (el.roundness === undefined) {
    // files from before "roundness" said strokeSharpness instead
    if (el.strokeSharpness === "round") el.roundness = { type: el.type === "rectangle" ? ROUND_ADAPTIVE : ROUND_PROPORTIONAL };
    else el.roundness = null;
  }
  setIf("seed", isNum, randomInteger());
  setIf("version", isNum, 1);
  setIf("versionNonce", isNum, 0);
  el.isDeleted = !!el.isDeleted;
  if (el.boundElements === undefined) el.boundElements = null;
  setIf("updated", isNum, 1);
  if (el.link === undefined) el.link = null;
  el.locked = !!el.locked;
  switch (el.type) {
    case "text": {
      el.text = str(el.text, "");
      setIf("fontSize", (v) => isNum(v) && v > 0, DEFAULT_FONT_SIZE);
      setIf("fontFamily", isNum, FONT_HAND);
      setIf("textAlign", isStr, "left");
      setIf("verticalAlign", isStr, "top");
      if (el.containerId === undefined) el.containerId = null;
      setIf("originalText", isStr, el.text);
      setIf("lineHeight", (v) => isNum(v) && v > 0, defaultLineHeight(el.fontFamily));
      if (el.autoResize === undefined) el.autoResize = true;
      break;
    }
    case "arrow":
    case "line": {
      el.points = cleanPoints(el.points, el.width, el.height);
      if (el.lastCommittedPoint === undefined) el.lastCommittedPoint = null;
      if (el.startBinding === undefined) el.startBinding = null;
      if (el.endBinding === undefined) el.endBinding = null;
      if (el.startArrowhead === undefined) el.startArrowhead = null;
      if (el.endArrowhead === undefined) el.endArrowhead = el.type === "arrow" ? "arrow" : null;
      break;
    }
    case "freedraw": {
      el.points = cleanPoints(el.points, 0, 0);
      setIf("pressures", Array.isArray, []);
      if (typeof el.simulatePressure !== "boolean") el.simulatePressure = el.pressures.length === 0;
      if (el.lastCommittedPoint === undefined) el.lastCommittedPoint = null;
      break;
    }
    case "image": {
      if (el.fileId === undefined) el.fileId = null;
      setIf("status", isStr, "saved");
      if (!Array.isArray(el.scale) || el.scale.length !== 2) el.scale = [1, 1];
      if (el.crop === undefined) el.crop = null;
      break;
    }
    case "frame":
    case "magicframe": {
      if (el.name === undefined) el.name = null;
      break;
    }
  }
  return el;
}

export function emptyScene() {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://leonote.app",
    elements: [],
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

/**
 * Parse file text. Never throws: a broken file comes back as an empty scene
 * plus the error, so the caller can refuse to overwrite it.
 */
export function parseScene(text) {
  if (!text || !String(text).trim()) return { scene: emptyScene(), error: null, empty: true };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { scene: emptyScene(), error: "Not valid JSON: " + e.message };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { scene: emptyScene(), error: "Not a sketch (Excalidraw-compatible) file" };
  if (data.type && data.type !== "excalidraw" && data.type !== "excalidraw/clipboard") {
    return { scene: emptyScene(), error: `Unexpected file type "${data.type}"` };
  }
  const scene = { ...data };
  scene.type = "excalidraw";
  if (!Number.isFinite(scene.version)) scene.version = 2;
  if (typeof scene.source !== "string") scene.source = "https://leonote.app";
  scene.elements = (Array.isArray(data.elements) ? data.elements : []).map(normalizeElement).filter(Boolean);
  scene.appState = data.appState && typeof data.appState === "object" ? { ...data.appState } : {};
  if (typeof scene.appState.viewBackgroundColor !== "string") scene.appState.viewBackgroundColor = "#ffffff";
  if (scene.appState.gridSize === undefined) scene.appState.gridSize = null;
  scene.files = data.files && typeof data.files === "object" && !Array.isArray(data.files) ? { ...data.files } : {};
  return { scene, error: null, empty: false };
}

/** Is the drawing's grid switched on? Handles both the old and new flags. */
export function gridEnabled(appState) {
  if (!appState) return false;
  if (typeof appState.gridModeEnabled === "boolean") return appState.gridModeEnabled;
  return Number.isFinite(appState.gridSize) && appState.gridSize > 0;
}

export function gridSizeOf(appState) {
  const g = appState && appState.gridSize;
  return Number.isFinite(g) && g > 1 ? g : 20;
}

/** Write the grid flag so old readers (gridSize null = off) and new ones agree. */
export function setGrid(appState, on) {
  const size = gridSizeOf(appState);
  // only newer Excalidraw writes gridStep; older readers take null as "off"
  const modern = appState.gridStep !== undefined;
  appState.gridModeEnabled = !!on;
  appState.gridSize = on || modern ? size : null;
  return appState;
}

/* fractional indices ("a0", "a1", ...) keep newer Excalidraw's ordering valid */
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function indexKey(i) {
  // head letter a..z carries how many integer digits follow (1..26)
  let digits = 1;
  let span = 62;
  let base = 0;
  while (i - base >= span) {
    base += span;
    digits++;
    span *= 62;
  }
  let n = i - base;
  let s = "";
  for (let d = 0; d < digits; d++) {
    s = B62[n % 62] + s;
    n = Math.floor(n / 62);
  }
  return String.fromCharCode(96 + digits) + s;
}

export function fixIndices(elements) {
  let ok = true;
  let prev = null;
  for (const el of elements) {
    if (typeof el.index !== "string" || !/^[a-zA-Z][0-9A-Za-z]+$/.test(el.index) || (prev !== null && !(prev < el.index))) { ok = false; break; }
    prev = el.index;
  }
  if (ok) return false;
  elements.forEach((el, i) => { el.index = indexKey(i); });
  return true;
}

// field order as Excalidraw writes it, so our files diff cleanly against theirs
const ORDER = ["id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds", "frameId", "index", "roundness", "seed", "version", "versionNonce", "isDeleted", "boundElements", "updated", "link", "locked"];

function ordered(el) {
  const out = {};
  for (const k of ORDER) if (k in el) out[k] = el[k];
  for (const k in el) if (!(k in out)) out[k] = el[k];
  return out;
}

/** Only the files that live elements still use. */
export function usedFiles(elements, files) {
  const out = {};
  for (const el of elements) {
    if (el.type === "image" && !el.isDeleted && el.fileId && files && files[el.fileId]) out[el.fileId] = files[el.fileId];
  }
  return out;
}

/** File text as Excalidraw writes it: 2-space JSON, deleted elements dropped. */
export function serializeScene(scene) {
  const live = scene.elements.filter((e) => !e.isDeleted);
  const els = live.map((e) => ({ ...e }));
  fixIndices(els);
  const out = { type: "excalidraw", version: scene.version || 2, source: scene.source || "https://leonote.app" };
  out.elements = els.map(ordered);
  out.appState = { ...scene.appState };
  out.files = usedFiles(live, scene.files);
  for (const k in scene) if (!(k in out)) out[k] = scene[k];
  return JSON.stringify(out, null, 2);
}

export function clipboardPayload(elements, files) {
  return {
    type: "excalidraw/clipboard",
    elements: elements.map((e) => ordered({ ...e })),
    files: usedFiles(elements, files),
  };
}

/** Elements from pasted text: our clipboard, Excalidraw's, or a whole file. */
export function parseClipboard(text) {
  if (!text || typeof text !== "string" || !/^\s*\{/.test(text)) return null;
  try {
    const data = JSON.parse(text);
    if (!data || (data.type !== "excalidraw/clipboard" && data.type !== "excalidraw")) return null;
    const elements = (Array.isArray(data.elements) ? data.elements : []).map(normalizeElement).filter((e) => e && !e.isDeleted);
    return { elements, files: data.files && typeof data.files === "object" ? data.files : {} };
  } catch {
    return null;
  }
}

/** A fresh element with Excalidraw's defaults and the current style. */
export function newElement(type, props = {}, style = DEFAULT_STYLE) {
  const s = { ...DEFAULT_STYLE, ...style };
  const round = s.roundness === "round";
  const el = {
    id: randomId(),
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: s.strokeColor,
    backgroundColor: type === "text" || type === "arrow" || type === "image" ? "transparent" : s.backgroundColor,
    fillStyle: s.fillStyle,
    strokeWidth: s.strokeWidth,
    strokeStyle: s.strokeStyle,
    roughness: s.roughness,
    opacity: s.opacity,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randomInteger(),
    version: 1,
    versionNonce: randomInteger(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
  if (type === "rectangle" && round) el.roundness = { type: ROUND_ADAPTIVE };
  if (type === "diamond" && round) el.roundness = { type: ROUND_PROPORTIONAL };
  if (type === "line" && round) el.roundness = null;
  if (type === "arrow") el.roundness = s.arrowType === "round" ? { type: ROUND_PROPORTIONAL } : null;
  if (type === "text") {
    Object.assign(el, {
      text: "",
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      textAlign: s.textAlign,
      verticalAlign: "top",
      containerId: null,
      originalText: "",
      autoResize: true,
      lineHeight: defaultLineHeight(s.fontFamily),
    });
  }
  if (type === "arrow" || type === "line") {
    Object.assign(el, {
      points: [[0, 0]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: type === "arrow" ? s.startArrowhead : null,
      endArrowhead: type === "arrow" ? s.endArrowhead : null,
    });
  }
  if (type === "freedraw") {
    el.backgroundColor = "transparent";
    Object.assign(el, { points: [[0, 0]], pressures: [], simulatePressure: true, lastCommittedPoint: null });
  }
  if (type === "image") Object.assign(el, { strokeColor: "transparent", fileId: null, status: "saved", scale: [1, 1], crop: null });
  if (type === "frame") Object.assign(el, { name: null, backgroundColor: "transparent", strokeColor: "#bbb", roughness: 0, strokeWidth: 2 });
  return Object.assign(el, props);
}

/* ── geometry ───────────────────────────────────────────────────────────── */

export function rotatePoint(x, y, cx, cy, angle) {
  if (!angle) return [x, y];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

/** Distance to a polyline given as a flat [x0, y0, x1, y1, ...] list. */
export function distToPolyline(px, py, flat, n = flat.length) {
  if (n < 2) return Infinity;
  if (n < 4) return Math.hypot(px - flat[0], py - flat[1]);
  let best = Infinity;
  for (let i = 0; i + 3 < n; i += 2) {
    const d = distToSegment(px, py, flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
    if (d < best) best = d;
  }
  return best;
}

/** Even-odd point in polygon; `flat` is [x0, y0, x1, y1, ...]. */
export function pointInPolygon(px, py, flat, n = flat.length) {
  let inside = false;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = flat[i];
    const yi = flat[i + 1];
    const xj = flat[j];
    const yj = flat[j + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isPathALoop(points, zoom = 1) {
  if (!points || points.length < 3) return false;
  const a = points[0];
  const b = points[points.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 8 / zoom;
}

export function pointsExtent(points) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of points) {
    if (p[0] < x1) x1 = p[0];
    if (p[1] < y1) y1 = p[1];
    if (p[0] > x2) x2 = p[0];
    if (p[1] > y2) y2 = p[1];
  }
  if (x1 === Infinity) return [0, 0, 0, 0];
  return [x1, y1, x2, y2];
}

// Catmull-Rom through every point, exactly how rough.js draws a "curve"
// (ends doubled, tightness 0), sampled into a flat list
export function sampleCurve(points, steps = 10) {
  const n = points.length;
  if (n < 3) {
    const out = [];
    for (const p of points) out.push(p[0], p[1]);
    return out;
  }
  const ext = [points[0], ...points, points[n - 1]];
  const out = [points[0][0], points[0][1]];
  for (let i = 1; i + 2 < ext.length; i++) {
    const p0 = ext[i - 1];
    const p1 = ext[i];
    const p2 = ext[i + 1];
    const p3 = ext[i + 2];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push(
        u * u * u * p1[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p2[0],
        u * u * u * p1[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p2[1]
      );
    }
  }
  return out;
}

// per element, by version: the local outline used for bounds and hit tests
const geomCache = new WeakMap();
export function linearGeometry(el) {
  let g = geomCache.get(el);
  if (g && g.v === el.version && g.p === el.points && g.r === !!el.roundness) return g;
  const curved = el.type !== "freedraw" && !!el.roundness && el.points.length > 2;
  const flat = curved ? sampleCurve(el.points) : el.points.flatMap((p) => [p[0], p[1]]);
  const [x1, y1, x2, y2] = pointsExtent(el.points);
  let cx1 = x1;
  let cy1 = y1;
  let cx2 = x2;
  let cy2 = y2;
  if (curved) {
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] < cx1) cx1 = flat[i];
      if (flat[i] > cx2) cx2 = flat[i];
      if (flat[i + 1] < cy1) cy1 = flat[i + 1];
      if (flat[i + 1] > cy2) cy2 = flat[i + 1];
    }
  }
  g = { v: el.version, p: el.points, r: !!el.roundness, flat, ext: [x1, y1, x2, y2], curveExt: [cx1, cy1, cx2, cy2] };
  geomCache.set(el, g);
  return g;
}

/** Rotation centre: the middle of the element's own (unrotated) box. */
export function elementCenter(el) {
  if (el.points && (LINEAR.has(el.type) || el.type === "freedraw")) {
    const e = linearGeometry(el).ext;
    return [el.x + (e[0] + e[2]) / 2, el.y + (e[1] + e[3]) / 2];
  }
  return [el.x + el.width / 2, el.y + el.height / 2];
}

/** The element's own box before rotation, [x1, y1, x2, y2]. */
export function elementRect(el) {
  if (el.points && (LINEAR.has(el.type) || el.type === "freedraw")) {
    const e = linearGeometry(el).ext;
    return [el.x + e[0], el.y + e[1], el.x + e[2], el.y + e[3]];
  }
  return [el.x, el.y, el.x + el.width, el.y + el.height];
}

/** Axis-aligned world bounds, rotation included. */
export function elementBounds(el) {
  const a = el.angle || 0;
  if (el.points && (LINEAR.has(el.type) || el.type === "freedraw")) {
    const g = linearGeometry(el);
    const [cx, cy] = elementCenter(el);
    if (!a) {
      const e = g.curveExt;
      return [el.x + e[0], el.y + e[1], el.x + e[2], el.y + e[3]];
    }
    const c = Math.cos(a);
    const s = Math.sin(a);
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    const f = g.flat;
    for (let i = 0; i < f.length; i += 2) {
      const dx = el.x + f[i] - cx;
      const dy = el.y + f[i + 1] - cy;
      const x = cx + dx * c - dy * s;
      const y = cy + dx * s + dy * c;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
    return [x1, y1, x2, y2];
  }
  const w = el.width;
  const h = el.height;
  const cx = el.x + w / 2;
  const cy = el.y + h / 2;
  if (!a) return [el.x, el.y, el.x + w, el.y + h];
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  let hw;
  let hh;
  if (el.type === "ellipse") {
    hw = Math.sqrt((w / 2) ** 2 * c * c + (h / 2) ** 2 * s * s);
    hh = Math.sqrt((w / 2) ** 2 * s * s + (h / 2) ** 2 * c * c);
  } else if (el.type === "diamond") {
    hw = Math.max((w / 2) * c, (h / 2) * s);
    hh = Math.max((w / 2) * s, (h / 2) * c);
  } else {
    hw = (w / 2) * c + (h / 2) * s;
    hh = (w / 2) * s + (h / 2) * c;
  }
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

export function commonBounds(elements) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const el of elements) {
    const b = elementBounds(el);
    if (b[0] < x1) x1 = b[0];
    if (b[1] < y1) y1 = b[1];
    if (b[2] > x2) x2 = b[2];
    if (b[3] > y2) y2 = b[3];
  }
  return x1 === Infinity ? null : [x1, y1, x2, y2];
}

/** A world point in the element's unrotated frame, relative to its centre. */
export function toLocal(el, px, py) {
  const [cx, cy] = elementCenter(el);
  const a = el.angle || 0;
  if (!a) return [px - cx, py - cy];
  const c = Math.cos(-a);
  const s = Math.sin(-a);
  const dx = px - cx;
  const dy = py - cy;
  return [dx * c - dy * s, dx * s + dy * c];
}

export function cornerRadius(size, el) {
  const r = el.roundness;
  if (!r) return 0;
  if (r.type === ROUND_ADAPTIVE) {
    const fixed = Number.isFinite(r.value) ? r.value : 32;
    return size <= fixed / 0.25 ? size * 0.25 : fixed;
  }
  return size * 0.25;
}

// signed distance to a (rounded) box centred on the origin
function sdBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Inigo Quilez's cheap ellipse distance: exact on the curve, close near it
function sdEllipse(px, py, a, b) {
  if (a < 0.5 || b < 0.5) return sdBox(px, py, a, b, 0);
  const k0 = Math.hypot(px / a, py / b);
  const k1 = Math.hypot(px / (a * a), py / (b * b));
  if (k1 === 0) return -Math.min(a, b);
  return (k0 * (k0 - 1)) / k1;
}

function sdDiamond(px, py, hw, hh) {
  const x = Math.abs(px);
  const y = Math.abs(py);
  const d = distToSegment(x, y, hw, 0, 0, hh);
  const inside = hw > 0 && hh > 0 && x / hw + y / hh <= 1;
  return inside ? -d : d;
}

/** Signed distance from a point to a closed shape's outline (negative inside). */
export function shapeDistance(el, px, py) {
  const [lx, ly] = toLocal(el, px, py);
  const hw = Math.abs(el.width) / 2;
  const hh = Math.abs(el.height) / 2;
  if (el.type === "ellipse") return sdEllipse(lx, ly, hw, hh);
  if (el.type === "diamond") return sdDiamond(lx, ly, hw, hh);
  const r = el.type === "rectangle" || el.type === "image" ? Math.min(cornerRadius(Math.min(hw, hh) * 2, el), hw, hh) : 0;
  return sdBox(lx, ly, hw, hh, r);
}

export const hasFill = (el) => !isTransparent(el.backgroundColor);

/**
 * Does a world point touch the element? Follows the drawn shape: hollow
 * shapes only count near their outline, filled ones inside too.
 * `tol` is in world units (callers divide their pixel slop by the zoom).
 */
export function hitTest(el, px, py, tol = 4, { inside = false } = {}) {
  if (el.isDeleted) return false;
  const sw = (el.strokeWidth || 1) / 2;
  switch (el.type) {
    case "rectangle":
    case "ellipse":
    case "diamond": {
      const d = shapeDistance(el, px, py);
      if (inside || hasFill(el) || (el.boundElements && el.boundElements.some((b) => b.type === "text"))) return d <= tol + sw;
      return Math.abs(d) <= tol + sw;
    }
    case "arrow":
    case "line":
    case "freedraw": {
      const g = linearGeometry(el);
      const [lx, ly] = toLocal(el, px, py);
      const [cx, cy] = elementCenter(el);
      const qx = lx + cx - el.x;
      const qy = ly + cy - el.y;
      const pad = el.type === "freedraw" ? Math.max(sw * 2.2, 2) : sw;
      if (distToPolyline(qx, qy, g.flat) <= tol + pad) return true;
      if ((hasFill(el) || inside) && el.type !== "arrow" && isPathALoop(el.points)) return pointInPolygon(qx, qy, g.flat);
      return false;
    }
    case "frame":
    case "magicframe": {
      const d = shapeDistance(el, px, py);
      if (inside) return d <= tol;
      if (Math.abs(d) <= tol + 2) return true;
      // the name label sits above the top-left corner
      const [lx, ly] = toLocal(el, px, py);
      const x = lx + el.width / 2;
      const y = ly + el.height / 2;
      return x >= -tol && x <= Math.min(el.width, 200) + tol && y >= -26 - tol && y <= tol;
    }
    default: {
      const [lx, ly] = toLocal(el, px, py);
      return Math.abs(lx) <= Math.abs(el.width) / 2 + tol && Math.abs(ly) <= Math.abs(el.height) / 2 + tol;
    }
  }
}

/** Is the element completely inside the box? */
export function inBox(el, x1, y1, x2, y2) {
  const b = elementBounds(el);
  return b[0] >= x1 && b[1] >= y1 && b[2] <= x2 && b[3] <= y2;
}

export function boxesIntersect(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/* ── linear elements ────────────────────────────────────────────────────── */

/** World coordinates of every point, rotation applied. */
export function absolutePoints(el) {
  const [cx, cy] = elementCenter(el);
  return el.points.map((p) => rotatePoint(el.x + p[0], el.y + p[1], cx, cy, el.angle || 0));
}

export function absolutePoint(el, i) {
  const [cx, cy] = elementCenter(el);
  const p = el.points[i < 0 ? el.points.length + i : i];
  return rotatePoint(el.x + p[0], el.y + p[1], cx, cy, el.angle || 0);
}

/**
 * Fields for a linear element whose points are given in world coordinates.
 * Keeps the angle; the first point becomes [0, 0] like Excalidraw does.
 */
export function linearFromAbsolute(el, abs) {
  const a = el.angle || 0;
  if (!a) {
    const [ox, oy] = abs[0];
    const points = abs.map((p) => [p[0] - ox, p[1] - oy]);
    const e = pointsExtent(points);
    return { x: ox, y: oy, points, width: e[2] - e[0], height: e[3] - e[1] };
  }
  // unrotate around the old centre, then keep the drawn shape where it is
  // even though the centre moves with the new extent
  const [cx, cy] = elementCenter(el);
  const local = abs.map((p) => rotatePoint(p[0], p[1], cx, cy, -a));
  const [ox, oy] = local[0];
  const points = local.map((p) => [p[0] - ox, p[1] - oy]);
  const e = pointsExtent(points);
  const ncx = ox + (e[0] + e[2]) / 2;
  const ncy = oy + (e[1] + e[3]) / 2;
  // where the new centre ends up after rotating around the old one
  const [rcx, rcy] = rotatePoint(ncx, ncy, cx, cy, a);
  return { x: ox + (rcx - ncx), y: oy + (rcy - ncy), points, width: e[2] - e[0], height: e[3] - e[1] };
}

/** Constrain a segment to 15 degree steps (Shift while drawing lines). */
export function snapAngle(ax, ay, bx, by, step = Math.PI / 12) {
  const len = Math.hypot(bx - ax, by - ay);
  const ang = Math.round(Math.atan2(by - ay, bx - ax) / step) * step;
  return [ax + Math.cos(ang) * len, ay + Math.sin(ang) * len];
}

export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return len;
}

/** Middle of a linear element along its length (arrow labels sit here). */
export function linearMidpoint(el) {
  const abs = absolutePoints(el);
  if (abs.length === 1) return abs[0];
  if (el.roundness && abs.length > 2) {
    const flat = sampleCurve(abs, 12);
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    return alongPolyline(pts, 0.5);
  }
  return alongPolyline(abs, 0.5);
}

function alongPolyline(pts, frac) {
  const total = polylineLength(pts);
  let want = total * frac;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (want <= seg && seg > 0) {
      const t = want / seg;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    want -= seg;
  }
  return pts[pts.length - 1];
}

/**
 * Arrowhead geometry in the element's local coordinates, the way Excalidraw
 * sizes them: [tipX, tipY, ...wing points] or a circle [x, y, diameter].
 */
export function arrowheadPoints(el, position, head) {
  const pts = el.points;
  if (pts.length < 2) return null;
  let x2;
  let y2;
  let x1;
  let y1;
  const end = position === "end";
  if (el.roundness && pts.length > 2) {
    const flat = sampleCurve(pts, 10);
    const n = flat.length;
    // 3 samples back along the last span is about t = 0.3, as Excalidraw uses
    if (end) { x2 = flat[n - 2]; y2 = flat[n - 1]; x1 = flat[n - 8]; y1 = flat[n - 7]; }
    else { x2 = flat[0]; y2 = flat[1]; x1 = flat[6]; y1 = flat[7]; }
  } else {
    const a = end ? pts[pts.length - 2] : pts[1];
    const b = end ? pts[pts.length - 1] : pts[0];
    x1 = a[0]; y1 = a[1]; x2 = b[0]; y2 = b[1];
  }
  const dist = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (x2 - x1) / dist;
  const ny = (y2 - y1) / dist;
  const size = { arrow: 30, bar: 15, dot: 15, circle: 15, circle_outline: 15, triangle: 15, triangle_outline: 15, diamond: 12, diamond_outline: 12 }[head] || 15;
  let length;
  if (head === "arrow") {
    const a = end ? pts[pts.length - 1] : pts[0];
    const b = end ? pts[pts.length - 2] : pts[1];
    length = Math.hypot(a[0] - b[0], a[1] - b[1]);
  } else {
    length = polylineLength(pts);
  }
  const minSize = Math.min(size, length / 2);
  const xs = x2 - nx * minSize;
  const ys = y2 - ny * minSize;
  if (head === "dot" || head === "circle" || head === "circle_outline") {
    return { kind: "circle", pts: [x2, y2, minSize + el.strokeWidth], outline: head === "circle_outline" };
  }
  if (head === "diamond" || head === "diamond_outline") {
    const bx = x2 - nx * minSize * 2;
    const by = y2 - ny * minSize * 2;
    const w = minSize * 0.6;
    return { kind: "polygon", pts: [[x2, y2], [xs - ny * w, ys + nx * w], [bx, by], [xs + ny * w, ys - nx * w]], outline: head === "diamond_outline" };
  }
  const angle = ({ arrow: 20, bar: 90, triangle: 25, triangle_outline: 25 }[head] || 20) * (Math.PI / 180);
  const [x3, y3] = rotatePoint(xs, ys, x2, y2, -angle);
  const [x4, y4] = rotatePoint(xs, ys, x2, y2, angle);
  if (head === "triangle" || head === "triangle_outline") return { kind: "polygon", pts: [[x2, y2], [x3, y3], [x4, y4]], outline: head === "triangle_outline" };
  if (head === "bar") return { kind: "lines", pts: [[x3, y3, x4, y4]] };
  return { kind: "lines", pts: [[x3, y3, x2, y2], [x4, y4, x2, y2]] };
}

/* ── bindings (ported from Excalidraw 0.17's collision.ts) ───────────────── */

export const isBindable = (el) => !!el && !el.isDeleted && BINDABLE.has(el.type) && !(el.type === "text" && el.containerId);
export const canContainText = (el) => !!el && CONTAINERS.has(el.type);

export function maxBindingGap(el, w = el.width, h = el.height) {
  const ratio = el.type === "diamond" ? 1 / Math.sqrt(2) : 1;
  const smaller = ratio * Math.min(w, h);
  return Math.max(16, Math.min(0.25 * smaller, 32));
}

/** Excalidraw's distance to a bindable outline (negative inside). */
export function bindDistance(el, px, py) {
  const [lx, ly] = toLocal(el, px, py);
  const x = Math.abs(lx);
  const y = Math.abs(ly);
  const hw = el.width / 2;
  const hh = el.height / 2;
  if (el.type === "diamond") {
    const n = Math.hypot(hh, hw) || 1;
    return (hh * x + hw * y - hh * hw) / n;
  }
  if (el.type === "ellipse") return sdEllipse(x, y, hw, hh);
  return Math.max(x - hw, y - hh);
}

/** The topmost shape an arrow end at (px, py) should attach to. */
export function bindingCandidate(elements, px, py, exclude, zoom = 1) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!isBindable(el) || (exclude && exclude.has(el.id))) continue;
    const b = elementBounds(el);
    const t = maxBindingGap(el) / Math.max(zoom, 0.5);
    if (px < b[0] - t || px > b[2] + t || py < b[1] - t || py > b[3] + t) continue;
    if (bindDistance(el, px, py) < t) return el;
  }
  return null;
}

// a line through a -> b as Excalidraw's normalised [c, a, b] (ax + by + c = 0)
function lineThrough(ax, ay, bx, by) {
  const la = ay - by;
  const lb = bx - ax;
  const lc = ax * by - bx * ay;
  const n = Math.hypot(la, lb) || 1;
  return [lc / n, la / n, lb / n];
}

function relToCenter(el, p) {
  return toLocal(el, p[0], p[1]);
}

function fromCenter(el, lx, ly) {
  const [cx, cy] = elementCenter(el);
  return rotatePoint(cx + lx, cy + ly, cx, cy, el.angle || 0);
}

/**
 * How far off-centre (-1..1) an arrow coming from `a` through `b` aims.
 * 0 points at the centre.
 */
export function focusDistance(el, a, b) {
  const [ax, ay] = relToCenter(el, a);
  const [bx, by] = relToCenter(el, b);
  if (ax === bx && ay === by) return 0;
  const [c, n, m] = lineThrough(ax, ay, bx, by);
  const q = el.height / (el.width || 1);
  const hw = el.width / 2 || 1;
  const hh = el.height / 2 || 1;
  const mabs = Math.abs(m);
  const nabs = Math.abs(n);
  let ret;
  if (el.type === "diamond") ret = mabs < nabs ? c / (nabs * hw) : c / (mabs * hh);
  else if (el.type === "ellipse") ret = c / (hw * Math.sqrt(n ** 2 + q ** 2 * m ** 2));
  else ret = c / (hw * (nabs + q * mabs));
  if (!Number.isFinite(ret)) return 0;
  return Math.max(-1, Math.min(1, ret));
}

function corners(el, scale = 1) {
  const hx = (scale * el.width) / 2;
  const hy = (scale * el.height) / 2;
  if (el.type === "diamond") return [[0, hy], [hx, 0], [0, -hy], [-hx, 0]];
  return [[hx, hy], [hx, -hy], [-hx, -hy], [-hx, hy]];
}

/** The point inside the shape an arrow from `adjacent` should aim at. */
export function focusPoint(el, focus, adjacent) {
  if (!focus) return elementCenter(el);
  const [px, pyo] = relToCenter(el, adjacent);
  const abs = Math.abs(focus);
  const orientation = Math.sign(focus);
  if (el.type === "ellipse") {
    const a = (el.width * abs) / 2;
    const b = (el.height * abs) / 2;
    const py = pyo === 0 ? 0.0001 : pyo;
    const squares = px ** 2 * b ** 2 + py ** 2 * a ** 2;
    const m = (-px * b ** 2 + orientation * py * Math.sqrt(Math.max(0, squares - a ** 2 * b ** 2))) / squares;
    let n = (-m * px - 1) / py;
    if (n === 0) n = (Object.is(n, -0) ? -1 : 1) * 0.01;
    const x = -(a ** 2 * m) / (n ** 2 * b ** 2 + m ** 2 * a ** 2);
    const y = (-m * x - 1) / n;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return elementCenter(el);
    return fromCenter(el, x, y);
  }
  let best = 0;
  let tangent = null;
  for (const c of corners(el, abs)) {
    const d = orientation * lineThrough(px, pyo, c[0], c[1])[0];
    if (d > best) { best = d; tangent = c; }
  }
  return tangent ? fromCenter(el, tangent[0], tangent[1]) : elementCenter(el);
}

function circleHits(cx, cy, r, line, out) {
  const [c, m, n] = line;
  const squares = m * m + n * n;
  const discr = r * r * squares - (m * cx + n * cy + c) ** 2;
  if (r === 0 || squares === 0 || discr <= 0) return;
  const root = Math.sqrt(discr);
  const xn = cx * n * n - cy * m * n - m * c;
  const yn = cy * m * m - cx * m * n - n * c;
  out.push([(xn + n * root) / squares, (yn - m * root) / squares], [(xn - n * root) / squares, (yn + m * root) / squares]);
}

/**
 * Where the line a -> b crosses the shape grown by `gap`, nearest to `a`
 * first. Empty when it misses.
 */
export function intersectElementWithLine(el, a, b, gap = 0) {
  const A = relToCenter(el, a);
  const B = relToCenter(el, b);
  const line = lineThrough(A[0], A[1], B[0], B[1]);
  const [c, la, lb] = line;
  const hits = [];
  if (el.type === "ellipse") {
    const ea = el.width / 2 + gap;
    const eb = el.height / 2 + gap;
    const m = la;
    const n = lb;
    const squares = ea * ea * m * m + eb * eb * n * n;
    const discr = squares - c * c;
    if (squares !== 0 && discr > 0) {
      const root = Math.sqrt(discr);
      const xn = -ea * ea * m * c;
      const yn = -eb * eb * n * c;
      hits.push([(xn + ea * eb * n * root) / squares, (yn - ea * eb * m * root) / squares], [(xn - ea * eb * n * root) / squares, (yn + ea * eb * m * root) / squares]);
    }
  } else {
    const cs = corners(el);
    for (let i = 0; i < 4; i++) {
      const p = cs[i];
      const q = cs[(i + 1) % 4];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      // push the edge outwards by the gap (its left normal in Excalidraw's frame)
      const ox = (-(q[1] - p[1]) / len) * gap;
      const oy = ((q[0] - p[0]) / len) * gap;
      const px = p[0] + ox;
      const py = p[1] + oy;
      const qx = q[0] + ox;
      const qy = q[1] + oy;
      const da = la * px + lb * py + c;
      const db = la * qx + lb * qy + c;
      // a line through a corner still counts (Excalidraw drops it, but its gap is never 0)
      if (da * db > 0 || (da === 0 && db === 0) || db === 0) continue;
      const t = da / (da - db);
      hits.push([px + (qx - px) * t, py + (qy - py) * t]);
    }
    for (const p of cs) circleHits(p[0], p[1], gap, line, hits);
  }
  if (hits.length < 2) return [];
  hits.sort((h1, h2) => Math.hypot(h1[0] - A[0], h1[1] - A[1]) - Math.hypot(h2[0] - A[0], h2[1] - A[1]));
  const first = hits[0];
  const last = hits[hits.length - 1];
  return [fromCenter(el, first[0], first[1]), fromCenter(el, last[0], last[1])];
}

/**
 * A binding for one end of an arrow. Aiming near the middle snaps to the
 * centre, which is what people mean nine times out of ten.
 */
export function calcBinding(arrow, target, which) {
  const n = arrow.points.length;
  const edge = absolutePoint(arrow, which === "start" ? 0 : n - 1);
  const adj = absolutePoint(arrow, which === "start" ? Math.min(1, n - 1) : Math.max(0, n - 2));
  let focus = focusDistance(target, adj, edge);
  const [lx, ly] = toLocal(target, edge[0], edge[1]);
  if (Math.abs(lx) < target.width * 0.25 && Math.abs(ly) < target.height * 0.25) focus = 0;
  const dist = bindDistance(target, edge[0], edge[1]);
  const gap = Math.max(1, Math.min(dist, maxBindingGap(target)));
  return { elementId: target.id, focus: Math.round(focus * 1e6) / 1e6, gap: dist > 0 ? Math.round(gap * 100) / 100 : 4 };
}

/** New world position for one end of an arrow bound to `target`. */
export function boundPointPosition(arrow, which, binding, target) {
  const n = arrow.points.length;
  const adj = absolutePoint(arrow, which === "start" ? Math.min(1, n - 1) : Math.max(0, n - 2));
  const fp = focusPoint(target, binding.focus || 0, adj);
  if (!binding.gap) return fp;
  const hits = intersectElementWithLine(target, adj, fp, binding.gap);
  return hits.length ? hits[0] : fp;
}

/**
 * Re-aim an arrow at the shapes it is bound to (after they moved). Mutates
 * the arrow in place and bumps its version; returns true if it changed.
 */
export function refreshArrow(arrow, byId, only) {
  if (!arrow.points || arrow.points.length < 2) return false;
  let changed = false;
  // both ends of a two-point arrow aim at each other; each pass quarters the
  // error, so a few passes settle it below a thousandth of a pixel
  const passes = arrow.points.length === 2 && arrow.startBinding && arrow.endBinding ? 8 : 1;
  for (let pass = 0; pass < passes; pass++) {
    if (!refreshPass(arrow, byId, only)) break;
    changed = true;
  }
  if (changed) bumpVersion(arrow);
  return changed;
}

function refreshPass(arrow, byId, only) {
  let changed = false;
  for (const which of ["start", "end"]) {
    const b = which === "start" ? arrow.startBinding : arrow.endBinding;
    if (!b) continue;
    const target = byId.get(b.elementId);
    if (!target || target.isDeleted) continue;
    // with 3+ points only the end attached to the moved shape follows
    if (only && b.elementId !== only && arrow.points.length > 2) continue;
    const p = boundPointPosition(arrow, which, b, target);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const abs = absolutePoints(arrow);
    const i = which === "start" ? 0 : abs.length - 1;
    if (Math.abs(abs[i][0] - p[0]) < 1e-3 && Math.abs(abs[i][1] - p[1]) < 1e-3) continue;
    abs[i] = p;
    Object.assign(arrow, linearFromAbsolute(arrow, abs));
    changed = true;
  }
  return changed;
}

/** Scale a binding's gap when its shape is resized (Excalidraw's rule). */
export function scaledGap(target, binding, newW, newH) {
  if (!binding) return binding;
  const ratio = newW < newH ? newW / (target.width || 1) : newH / (target.height || 1);
  const gap = Math.max(1, Math.min(maxBindingGap(target, newW, newH), binding.gap * ratio));
  return { ...binding, gap };
}

/* ── text ───────────────────────────────────────────────────────────────── */

export function wrapText(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (!para || measure(para) <= maxWidth) { out.push(para); continue; }
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const cand = line ? line + " " + word : word;
      if (measure(cand) <= maxWidth) { line = cand; continue; }
      if (line) { out.push(line); line = ""; }
      if (measure(word) <= maxWidth) { line = word; continue; }
      // a word wider than the box breaks between characters
      for (const ch of word) {
        if (line && measure(line + ch) > maxWidth) { out.push(line); line = ch; }
        else line += ch;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export function measureText(text, fontSize, lineHeight, measure) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let w = 0;
  for (const l of lines) w = Math.max(w, measure(l));
  return { width: w, height: lines.length * fontSize * lineHeight };
}

/** Cards and sticky notes give their text more room than plain shapes. */
export const padOf = (c) => (c && c.customData && (c.customData.notePath || c.customData.sticky) ? CARD_PADDING : BOUND_TEXT_PADDING);

export function boundTextMaxWidth(container, fontSize = DEFAULT_FONT_SIZE) {
  const w = container.width;
  const p = padOf(container);
  if (container.type === "arrow") return Math.max(0.7 * w, fontSize * 11);
  if (container.type === "ellipse") return Math.round((w / 2) * Math.SQRT2) - p * 2;
  if (container.type === "diamond") return Math.round(w / 2) - p * 2;
  return w - p * 2;
}

export function boundTextMaxHeight(container, textHeight = 0) {
  const h = container.height;
  const p = padOf(container);
  if (container.type === "arrow") return h - BOUND_TEXT_PADDING * 16 <= 0 ? textHeight : h;
  if (container.type === "ellipse") return Math.round((h / 2) * Math.SQRT2) - p * 2;
  if (container.type === "diamond") return Math.round(h / 2) - p * 2;
  return h - p * 2;
}

/** Container size that fits text of the given height (Excalidraw's rule). */
export function containerDimensionFor(dimension, type, padding = BOUND_TEXT_PADDING) {
  const d = Math.ceil(dimension);
  const pad = padding * 2;
  if (type === "ellipse") return Math.round(((d + pad) / Math.SQRT2) * 2);
  if (type === "arrow") return d + pad * 8;
  if (type === "diamond") return 2 * (d + pad);
  return d + pad;
}

/** Top-left of a container's text, given the text's measured size. */
export function boundTextPosition(container, text) {
  if (container.type === "arrow") {
    const [mx, my] = linearMidpoint(container);
    return { x: mx - text.width / 2, y: my - text.height / 2 };
  }
  let ox = padOf(container);
  let oy = ox;
  if (container.type === "ellipse") {
    ox += (container.width / 2) * (1 - Math.SQRT2 / 2);
    oy += (container.height / 2) * (1 - Math.SQRT2 / 2);
  }
  if (container.type === "diamond") {
    ox += container.width / 4;
    oy += container.height / 4;
  }
  const maxW = boundTextMaxWidth(container, text.fontSize);
  const maxH = boundTextMaxHeight(container, text.height);
  let x = container.x + ox;
  if (text.textAlign === "center") x += (maxW - text.width) / 2;
  else if (text.textAlign === "right") x += maxW - text.width;
  let y;
  if (text.verticalAlign === "top") y = container.y + oy;
  else if (text.verticalAlign === "bottom") y = container.y + oy + maxH - text.height;
  else y = container.y + container.height / 2 - text.height / 2;
  return { x, y };
}

export function boundTextOf(container, byId) {
  if (!container || !container.boundElements) return null;
  for (const b of container.boundElements) {
    if (b.type !== "text") continue;
    const t = byId.get(b.id);
    if (t && !t.isDeleted && t.containerId === container.id) return t;
  }
  return null;
}

/**
 * Re-wrap and re-place a container's text after the container or the text
 * changed. Grows the container when the text no longer fits. Needs a
 * measure(line, textEl) function from the caller.
 */
export function layoutBoundText(container, text, measure) {
  const m = (s) => measure(s, text);
  const maxW = Math.max(1, boundTextMaxWidth(container, text.fontSize));
  const wrapped = container.type === "arrow" ? text.originalText : wrapText(text.originalText, maxW, m);
  const size = measureText(wrapped, text.fontSize, text.lineHeight, m);
  const upd = {};
  if (wrapped !== text.text) upd.text = wrapped;
  if (Math.abs(size.width - text.width) > 0.01) upd.width = size.width;
  if (Math.abs(size.height - text.height) > 0.01) upd.height = size.height;
  const cupd = {};
  if (container.type !== "arrow") {
    const maxH = boundTextMaxHeight(container, size.height);
    // text that no longer fits grows the shape downwards, as Excalidraw does
    if (size.height > maxH) cupd.height = containerDimensionFor(size.height, container.type, padOf(container));
  }
  const box = { ...container, ...cupd };
  const pos = boundTextPosition(box, { ...text, width: size.width, height: size.height });
  if (Math.abs(pos.x - text.x) > 0.01) upd.x = pos.x;
  if (Math.abs(pos.y - text.y) > 0.01) upd.y = pos.y;
  if ((text.angle || 0) !== (container.type === "arrow" ? 0 : container.angle || 0)) upd.angle = container.type === "arrow" ? 0 : container.angle || 0;
  return { text: upd, container: cupd };
}

/* ── transforms ─────────────────────────────────────────────────────────── */

/**
 * Resize a (possibly rotated) box by one of its handles. The opposite side
 * stays put in world space (or the centre, with fromCenter).
 */
export function resizeBox(box, handle, px, py, { keepRatio = false, fromCenter = false } = {}) {
  const w = box.width;
  const h = box.height;
  const a = box.angle || 0;
  const cx = box.x + w / 2;
  const cy = box.y + h / 2;
  const [rx, ry] = rotatePoint(px, py, cx, cy, -a);
  const lx = rx - cx;
  const ly = ry - cy;
  const hasE = handle.includes("e");
  const hasW = handle.includes("w");
  const hasN = handle.includes("n");
  const hasS = handle.includes("s");
  let left = -w / 2;
  let right = w / 2;
  let top = -h / 2;
  let bottom = h / 2;
  if (hasE) { right = lx; if (fromCenter) left = -lx; }
  if (hasW) { left = lx; if (fromCenter) right = -lx; }
  if (hasS) { bottom = ly; if (fromCenter) top = -ly; }
  if (hasN) { top = ly; if (fromCenter) bottom = -ly; }
  if (keepRatio && w > 0 && h > 0) {
    const corner = (hasE || hasW) && (hasN || hasS);
    let nw = Math.abs(right - left);
    let nh = Math.abs(bottom - top);
    if (corner) {
      const s = Math.max(nw / w, nh / h);
      nw = w * s;
      nh = h * s;
    } else if (hasE || hasW) nh = (nw * h) / w;
    else nw = (nh * w) / h;
    const sx = right - left < 0 ? -1 : 1;
    const sy = bottom - top < 0 ? -1 : 1;
    if (fromCenter) {
      left = (-sx * nw) / 2; right = (sx * nw) / 2;
      top = (-sy * nh) / 2; bottom = (sy * nh) / 2;
    } else {
      if (hasE) right = left + sx * nw;
      else if (hasW) left = right - sx * nw;
      else { left = (-sx * nw) / 2; right = (sx * nw) / 2; }
      if (hasS) bottom = top + sy * nh;
      else if (hasN) top = bottom - sy * nh;
      else { top = (-sy * nh) / 2; bottom = (sy * nh) / 2; }
    }
  }
  const flipX = right < left;
  const flipY = bottom < top;
  const nl = Math.min(left, right);
  const nr = Math.max(left, right);
  const nt = Math.min(top, bottom);
  const nb = Math.max(top, bottom);
  const nw = nr - nl;
  const nh = nb - nt;
  const [wcx, wcy] = rotatePoint(cx + (nl + nr) / 2, cy + (nt + nb) / 2, cx, cy, a);
  return { x: wcx - nw / 2, y: wcy - nh / 2, width: nw, height: nh, flipX, flipY };
}

/**
 * Points of a linear/freehand element fitted into a new box size (flips
 * mirror them). Returns points with the first at [0, 0] and the offset of
 * that first point inside the box.
 */
export function fitPoints(points, ext, newW, newH, flipX, flipY) {
  const w = ext[2] - ext[0];
  const h = ext[3] - ext[1];
  const out = points.map((p) => {
    let u = w ? (p[0] - ext[0]) / w : 0;
    let v = h ? (p[1] - ext[1]) / h : 0;
    if (flipX) u = 1 - u;
    if (flipY) v = 1 - v;
    return [u * newW, v * newH];
  });
  const [ox, oy] = out[0];
  return { points: out.map((p) => [p[0] - ox, p[1] - oy]), offset: [ox, oy] };
}

export const snapToGrid = (v, size) => (size > 0 ? Math.round(v / size) * size : v);

/**
 * Snap a moving box to other boxes' edges and centres. Returns the nudge and
 * the guide lines to draw, all in world units.
 */
export function snapGuides(moving, others, threshold, { x = true, y = true } = {}) {
  const mx = [moving[0], (moving[0] + moving[2]) / 2, moving[2]];
  const my = [moving[1], (moving[1] + moving[3]) / 2, moving[3]];
  let bestX = threshold + 1e-9;
  let bestY = threshold + 1e-9;
  let dx = 0;
  let dy = 0;
  for (const o of others) {
    const ox0 = o[0];
    const ox1 = (o[0] + o[2]) / 2;
    const ox2 = o[2];
    const oy0 = o[1];
    const oy1 = (o[1] + o[3]) / 2;
    const oy2 = o[3];
    // a ruler guide is a candidate with an `axis`: a vertical one ("x") has
    // nothing to say about y, and the other way round
    const useX = x && o.axis !== "y";
    const useY = y && o.axis !== "x";
    for (let i = 0; i < 3; i++) {
      if (useX) {
        const m = mx[i];
        let d = ox0 - m; if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; }
        d = ox1 - m; if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; }
        d = ox2 - m; if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; }
      }
      if (useY) {
        const m = my[i];
        let d = oy0 - m; if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; }
        d = oy1 - m; if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; }
        d = oy2 - m; if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; }
      }
    }
  }
  const snappedX = bestX <= threshold;
  const snappedY = bestY <= threshold;
  if (!snappedX) dx = 0;
  if (!snappedY) dy = 0;
  const guides = [];
  if (snappedX || snappedY) {
    const b = [moving[0] + dx, moving[1] + dy, moving[2] + dx, moving[3] + dy];
    const bx = [b[0], (b[0] + b[2]) / 2, b[2]];
    const by = [b[1], (b[1] + b[3]) / 2, b[3]];
    const eps = 0.01;
    for (const o of others) {
      const ox = [o[0], (o[0] + o[2]) / 2, o[2]];
      const oy = [o[1], (o[1] + o[3]) / 2, o[3]];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (o.axis) continue; // the guide is already drawn, edge to edge
          if (snappedX && Math.abs(bx[i] - ox[j]) < eps) guides.push({ x1: bx[i], y1: Math.min(b[1], o[1]), x2: bx[i], y2: Math.max(b[3], o[3]) });
          if (snappedY && Math.abs(by[i] - oy[j]) < eps) guides.push({ x1: Math.min(b[0], o[0]), y1: by[i], x2: Math.max(b[2], o[2]), y2: by[i] });
        }
      }
    }
  }
  return { dx, dy, guides };
}

/** Moves [dx, dy] that align boxes to their common bounds. */
export function alignBoxes(boxes, mode) {
  const minX = Math.min(...boxes.map((b) => b[0]));
  const minY = Math.min(...boxes.map((b) => b[1]));
  const maxX = Math.max(...boxes.map((b) => b[2]));
  const maxY = Math.max(...boxes.map((b) => b[3]));
  return boxes.map((b) => {
    switch (mode) {
      case "left": return [minX - b[0], 0];
      case "right": return [maxX - b[2], 0];
      case "centerX": return [(minX + maxX) / 2 - (b[0] + b[2]) / 2, 0];
      case "top": return [0, minY - b[1]];
      case "bottom": return [0, maxY - b[3]];
      case "centerY": return [0, (minY + maxY) / 2 - (b[1] + b[3]) / 2];
      default: return [0, 0];
    }
  });
}

/** Moves that give boxes equal gaps along an axis ("x" or "y"). */
export function distributeBoxes(boxes, axis) {
  const i0 = axis === "x" ? 0 : 1;
  const i1 = axis === "x" ? 2 : 3;
  const order = boxes.map((b, i) => i).sort((a, b) => (boxes[a][i0] + boxes[a][i1]) - (boxes[b][i0] + boxes[b][i1]));
  const moves = boxes.map(() => [0, 0]);
  if (boxes.length < 3) return moves;
  const start = Math.min(...boxes.map((b) => b[i0]));
  const end = Math.max(...boxes.map((b) => b[i1]));
  const sizes = boxes.reduce((s, b) => s + (b[i1] - b[i0]), 0);
  const gap = (end - start - sizes) / (boxes.length - 1);
  const first = boxes[order[0]];
  const last = boxes[order[order.length - 1]];
  if (gap < 0) {
    // overlapping boxes: spread their centres evenly instead
    const c0 = (first[i0] + first[i1]) / 2;
    const c1 = (last[i0] + last[i1]) / 2;
    const step = (c1 - c0) / (boxes.length - 1);
    order.forEach((idx, k) => {
      const b = boxes[idx];
      const d = c0 + step * k - (b[i0] + b[i1]) / 2;
      moves[idx] = axis === "x" ? [d, 0] : [0, d];
    });
    return moves;
  }
  let pos = start;
  for (const idx of order) {
    const b = boxes[idx];
    const d = pos - b[i0];
    moves[idx] = axis === "x" ? [d, 0] : [0, d];
    pos += b[i1] - b[i0] + gap;
  }
  return moves;
}

/* ── layers & groups ────────────────────────────────────────────────────── */

/**
 * Reorder in place. `how` is front | back | forward | backward. Deleted
 * elements are stepped over so a single step always passes a visible one.
 */
export function moveLayer(arr, isSel, how) {
  if (how === "front" || how === "back") {
    const sel = arr.filter(isSel);
    const rest = arr.filter((e) => !isSel(e));
    const out = how === "front" ? [...rest, ...sel] : [...sel, ...rest];
    arr.splice(0, arr.length, ...out);
    return arr;
  }
  if (how === "forward") {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (!isSel(arr[i])) continue;
      let j = i + 1;
      while (j < arr.length && arr[j].isDeleted && !isSel(arr[j])) j++;
      if (j >= arr.length || isSel(arr[j])) continue;
      const [el] = arr.splice(i, 1);
      arr.splice(j, 0, el);
    }
  } else if (how === "backward") {
    for (let i = 1; i < arr.length; i++) {
      if (!isSel(arr[i])) continue;
      let j = i - 1;
      while (j >= 0 && arr[j].isDeleted && !isSel(arr[j])) j--;
      if (j < 0 || isSel(arr[j])) continue;
      const [el] = arr.splice(i, 1);
      arr.splice(j, 0, el);
    }
  }
  return arr;
}

/** The group a click selects: the outermost one, or one level inside the group being edited. */
export function selectGroupId(el, editingGroupId) {
  const g = el.groupIds || [];
  if (!g.length) return null;
  if (!editingGroupId) return g[g.length - 1];
  const at = g.indexOf(editingGroupId);
  if (at < 0) return g[g.length - 1];
  return at > 0 ? g[at - 1] : null;
}

/** Deep copies with fresh ids; groups, bindings and labels are re-linked. */
export function duplicateElements(list, { dx = 0, dy = 0, now = Date.now() } = {}) {
  const ids = new Map(list.map((e) => [e.id, randomId()]));
  const groups = new Map();
  const gid = (g) => {
    if (!groups.has(g)) groups.set(g, randomId());
    return groups.get(g);
  };
  const out = list.map((src) => {
    const el = JSON.parse(JSON.stringify(src));
    el.id = ids.get(src.id);
    el.x += dx;
    el.y += dy;
    el.seed = randomInteger();
    el.version = 1;
    el.versionNonce = randomInteger();
    el.updated = now;
    el.isDeleted = false;
    delete el.index;
    el.groupIds = (el.groupIds || []).map(gid);
    if (Array.isArray(el.boundElements)) {
      const kept = el.boundElements.filter((b) => ids.has(b.id)).map((b) => ({ ...b, id: ids.get(b.id) }));
      el.boundElements = kept.length ? kept : null;
    }
    if (el.containerId) el.containerId = ids.get(el.containerId) || null;
    for (const k of ["startBinding", "endBinding"]) {
      if (el[k]) el[k] = ids.has(el[k].elementId) ? { ...el[k], elementId: ids.get(el[k].elementId) } : null;
    }
    if (el.frameId && ids.has(el.frameId)) el.frameId = ids.get(el.frameId);
    return el;
  });
  return { elements: out, ids };
}

/* ── history ────────────────────────────────────────────────────────────── */

export const snapshot = (el) => ({ ...el });

/**
 * Undo stack of element snapshots. An entry is { before: Map, after: Map,
 * order? } keyed by id. Entries with the same `key` inside `window` ms merge,
 * so a drag or a run of nudges is one step.
 */
export function createHistory(limit = 150, window = 900) {
  const undo = [];
  const redo = [];
  return {
    undo,
    redo,
    push(entry, now = Date.now()) {
      redo.length = 0;
      const top = undo[undo.length - 1];
      if (entry.key && top && top.key === entry.key && now - top.time < window) {
        for (const [id, snap] of entry.before) if (!top.before.has(id)) top.before.set(id, snap);
        for (const [id, snap] of entry.after) top.after.set(id, snap);
        if (entry.order) top.order = { before: top.order ? top.order.before : entry.order.before, after: entry.order.after };
        top.time = now;
        return top;
      }
      entry.time = now;
      undo.push(entry);
      if (undo.length > limit) undo.shift();
      return entry;
    },
    takeUndo() {
      const e = undo.pop();
      if (e) redo.push(e);
      return e || null;
    },
    takeRedo() {
      const e = redo.pop();
      if (e) undo.push(e);
      return e || null;
    },
    /** Stop the top entry from merging with the next change. */
    seal() {
      const top = undo[undo.length - 1];
      if (top) top.key = null;
    },
    clear() { undo.length = 0; redo.length = 0; },
  };
}

/** Put a snapshot's fields back onto the live element, version bumped. */
export function restoreInto(live, snap, now = Date.now()) {
  const version = Math.max(live.version || 0, snap.version || 0);
  for (const k of Object.keys(live)) if (!(k in snap)) delete live[k];
  Object.assign(live, snap);
  live.version = version;
  return bumpVersion(live, now);
}

/* ── partial eraser ─────────────────────────────────────────────────────── */

// where segment a -> b is inside the circle, as [t0, t1], or null
function segmentInCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - r * r;
  if (a < 1e-12) return c <= 0 ? [0, 1] : null;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - sq) / (2 * a));
  const t1 = Math.min(1, (-b + sq) / (2 * a));
  return t0 < t1 ? [t0, t1] : null;
}

/**
 * Cut a circle out of a freehand stroke. Returns null when the stroke is
 * untouched, else the pieces left as world-space runs
 * [{ points: [[x, y]...], pressures: [...] }].
 */
export function cutFreedraw(el, cx, cy, r) {
  const abs = absolutePoints(el);
  const pr = !el.simulatePressure && el.pressures && el.pressures.length === abs.length ? el.pressures : null;
  const n = abs.length;
  if (n === 1) return Math.hypot(abs[0][0] - cx, abs[0][1] - cy) <= r ? [] : null;
  const runs = [];
  let cur = null;
  let touched = false;
  const push = (x, y, p) => {
    if (!cur) { cur = { points: [], pressures: [] }; runs.push(cur); }
    const last = cur.points[cur.points.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return;
    cur.points.push([x, y]);
    cur.pressures.push(p);
  };
  if (Math.hypot(abs[0][0] - cx, abs[0][1] - cy) > r) push(abs[0][0], abs[0][1], pr ? pr[0] : 0.5);
  for (let i = 0; i + 1 < n; i++) {
    const [ax, ay] = abs[i];
    const [bx, by] = abs[i + 1];
    const pa = pr ? pr[i] : 0.5;
    const pb = pr ? pr[i + 1] : 0.5;
    const hit = segmentInCircle(ax, ay, bx, by, cx, cy, r);
    if (!hit) { push(bx, by, pb); continue; }
    touched = true;
    const [t0, t1] = hit;
    if (t0 > 0) push(ax + (bx - ax) * t0, ay + (by - ay) * t0, pa + (pb - pa) * t0);
    cur = null;
    if (t1 < 1) {
      push(ax + (bx - ax) * t1, ay + (by - ay) * t1, pa + (pb - pa) * t1);
      push(bx, by, pb);
    }
  }
  if (!touched) return null;
  return runs.filter((run) => run.points.length >= 2 && polylineLength(run.points) > 0.5);
}

/**
 * A freehand stroke cut by a box: the runs inside it and the runs outside it (world-space, as
 * cutFreedraw gives them). Null when the stroke does not cross the box at all.
 */
export function splitFreedrawByBox(el, box) {
  const [x0, y0, x1, y1] = box;
  const abs = absolutePoints(el);
  const pr = !el.simulatePressure && el.pressures && el.pressures.length === abs.length ? el.pressures : null;
  const inside = [], outside = [];
  let cur = null, curIn = null;
  const isIn = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const push = (x, y, p, inn) => {
    if (!cur || curIn !== inn) {
      // a new run starts where the last one ended, so the two halves meet
      const last = cur && cur.points[cur.points.length - 1], lp = cur && cur.pressures[cur.pressures.length - 1];
      cur = { points: last ? [last] : [], pressures: last ? [lp] : [] };
      curIn = inn;
      (inn ? inside : outside).push(cur);
    }
    const last = cur.points[cur.points.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return;
    cur.points.push([x, y]);
    cur.pressures.push(p);
  };
  if (!abs.length) return null;
  push(abs[0][0], abs[0][1], pr ? pr[0] : 0.5, isIn(abs[0][0], abs[0][1]));
  for (let i = 0; i + 1 < abs.length; i++) {
    const [ax, ay] = abs[i], [bx, by] = abs[i + 1];
    const pa = pr ? pr[i] : 0.5, pb = pr ? pr[i + 1] : 0.5;
    // where the segment crosses the box's sides
    const ts = [];
    const cross = (a, b, v) => { if ((a - v) * (b - v) < 0) ts.push((v - a) / (b - a)); };
    cross(ax, bx, x0); cross(ax, bx, x1); cross(ay, by, y0); cross(ay, by, y1);
    ts.sort((p, q) => p - q);
    let t0 = 0;
    for (const t of [...ts, 1]) {
      const tm = (t0 + t) / 2;
      const inn = isIn(ax + (bx - ax) * tm, ay + (by - ay) * tm);
      push(ax + (bx - ax) * t, ay + (by - ay) * t, pa + (pb - pa) * t, inn);
      t0 = t;
    }
  }
  const keep = (runs) => runs.filter((run) => run.points.length >= 2 && polylineLength(run.points) > 0.5);
  const res = { inside: keep(inside), outside: keep(outside) };
  return res.inside.length ? res : null;
}

/** A new freehand element for one piece of a cut stroke (style and brush kept). */
export function freedrawPiece(src, run, now = Date.now()) {
  const el = JSON.parse(JSON.stringify(src));
  el.id = randomId();
  el.seed = randomInteger();
  el.version = 1;
  el.versionNonce = randomInteger();
  el.updated = now;
  el.angle = 0;
  el.boundElements = null;
  el.link = null;
  delete el.index;
  const [ox, oy] = run.points[0];
  el.x = ox;
  el.y = oy;
  el.points = run.points.map((p) => [Math.round((p[0] - ox) * 100) / 100, Math.round((p[1] - oy) * 100) / 100]);
  el.pressures = src.simulatePressure ? [] : run.pressures.map((p) => Math.round(p * 1000) / 1000);
  const e = pointsExtent(el.points);
  el.width = e[2] - e[0];
  el.height = e[3] - e[1];
  el.lastCommittedPoint = el.points[el.points.length - 1];
  return el;
}

/* ── lasso ──────────────────────────────────────────────────────────────── */

/** Points along an element's outline, in world space. */
export function outlineSamples(el) {
  const [cx, cy] = elementCenter(el);
  const a = el.angle || 0;
  const out = [];
  if (el.points && (LINEAR.has(el.type) || el.type === "freedraw")) {
    const f = linearGeometry(el).flat;
    const step = 2 * Math.max(1, Math.floor(f.length / 64));
    for (let i = 0; i < f.length; i += step) out.push(rotatePoint(el.x + f[i], el.y + f[i + 1], cx, cy, a));
    out.push(rotatePoint(el.x + f[f.length - 2], el.y + f[f.length - 1], cx, cy, a));
    return out;
  }
  const hw = el.width / 2;
  const hh = el.height / 2;
  if (el.type === "ellipse") {
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2;
      out.push(rotatePoint(cx + Math.cos(t) * hw, cy + Math.sin(t) * hh, cx, cy, a));
    }
    return out;
  }
  const pts = el.type === "diamond" ? [[0, -hh], [hw, 0], [0, hh], [-hw, 0]] : [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  for (const p of pts) out.push(rotatePoint(cx + p[0], cy + p[1], cx, cy, a));
  return out;
}

/** Is the element wholly inside the lasso (a flat [x0, y0, ...] world polygon)? */
export function inLasso(el, flat) {
  if (flat.length < 6) return false;
  for (const p of outlineSamples(el)) if (!pointInPolygon(p[0], p[1], flat)) return false;
  return true;
}

/* ── research: note cards, sticky notes, search ─────────────────────────── */

export const isNoteCard = (el) => !!(el && el.customData && typeof el.customData.notePath === "string");
export const isSticky = (el) => !!(el && el.customData && el.customData.sticky);

/** A short plain-text excerpt of a Markdown note. */
export function excerptOf(md, max = 140) {
  let s = String(md || "").replace(/\r\n?/g, "\n");
  s = s.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const lines = [];
  let fence = false;
  for (let line of s.split("\n")) {
    line = line.trim();
    if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence || !line || /^#{1,6}\s/.test(line) || /^(>\s*\[!|\||<!--|---+$)/.test(line)) continue;
    line = line
      .replace(/!\[\[[^\]]*\]\]/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
      .replace(/^([-*+]|\d+[.)])\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/(\*\*|__|\*|_|`|~~|==)/g, "")
      .trim();
    if (line) lines.push(line);
    if (lines.join(" ").length > max) break;
  }
  const out = lines.join(" ").replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : out;
}

/** The text a note card shows: its title on the first line, then the excerpt. */
export const noteCardText = (title, excerpt) => (excerpt ? `${title}\n${excerpt}` : title);

/** A wiki link for a vault path, as Obsidian's Excalidraw plugin reads it. */
export const wikiLinkFor = (path) => `[[${String(path).replace(/\.md$/i, "")}]]`;

/** The note an element points at: a card's path, or a [[wiki link]]. */
export function linkedNote(el) {
  if (isNoteCard(el)) return el.customData.notePath;
  const m = el && typeof el.link === "string" ? /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(el.link.trim()) : null;
  return m ? m[1] : null;
}

const readingOrder = (a, b) => (Math.abs(a.y - b.y) > 30 ? a.y - b.y : a.x - b.x);

/**
 * Search a drawing: text, card titles and frame names. Returns
 * [{ id, label, kind }] in reading order; labels resolve to their container.
 */
export function searchScene(elements, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = [];
  const seen = new Set();
  for (const e of elements) {
    if (e.isDeleted) continue;
    let label = null;
    let kind = null;
    let target = e;
    if (e.type === "frame" || e.type === "magicframe") {
      label = e.name || "Frame";
      kind = "frame";
    } else if (e.type === "text") {
      label = e.originalText || e.text || "";
      kind = "text";
      const c = e.containerId && byId.get(e.containerId);
      if (c && !c.isDeleted) {
        target = c;
        if (isNoteCard(c)) kind = "note";
        else if (isSticky(c)) kind = "sticky";
      }
    } else if (isNoteCard(e)) {
      label = e.customData.notePath;
      kind = "note";
    } else if (e.link) {
      label = e.link;
      kind = "link";
    }
    if (label == null || !label.toLowerCase().includes(q) || seen.has(target.id)) continue;
    seen.add(target.id);
    out.push({ id: target.id, label: label.replace(/\s+/g, " ").trim().slice(0, 80), kind, x: target.x, y: target.y });
  }
  out.sort(readingOrder);
  return out.map(({ id, label, kind }) => ({ id, label, kind }));
}

/** Frames and note cards, for the outline panel: frames first. */
export function outlineOf(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = [];
  for (const e of elements) {
    if (e.isDeleted) continue;
    if (e.type === "frame" || e.type === "magicframe") out.push({ id: e.id, kind: "frame", label: e.name || "Frame", x: e.x, y: e.y });
    else if (isNoteCard(e)) {
      const t = boundTextOf(e, byId);
      const label = t ? String(t.originalText || t.text).split("\n")[0] : e.customData.notePath;
      out.push({ id: e.id, kind: "note", label, x: e.x, y: e.y });
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? readingOrder(a, b) : a.kind === "frame" ? -1 : 1));
  return out;
}
