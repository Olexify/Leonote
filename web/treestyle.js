// Folder looks: a colour per folder (inherited by subfolders in fading
// steps), bold / dim / size, and text that stays readable on whatever colour
// it lands on. Styles live in settings.folderStyles keyed by folder path.

import { h } from "./util.js";
import { icon } from "./icons.js";

export const FOLDER_COLORS = ["#e5484d", "#f76b15", "#ffb224", "#f5d90a", "#46a758", "#12a594", "#3b9eff",
  "#3e63dd", "#6e56cf", "#ab4aba", "#d6409f", "#ecece7"];

/** Hue 0-360, saturation and value 0-1 -> "#rrggbb". */
export function hsvToHex(hue, s, v) {
  const f = (n) => {
    const k = (n + hue / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

/** "#rrggbb" -> [hue, saturation, value]. */
export function hexToHsv(hex) {
  const [r, g, b] = (hexRgb(hex) || [0, 0, 0]).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, max ? d / max : 0, max];
}

/** "#abc", "abc", "#aabbcc", "aabbcc" (any case, spaces ok) -> "#aabbcc", else null. */
export function parseHex(s) {
  const m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(String(s || ""));
  if (!m) return null;
  const x = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return "#" + x.toLowerCase();
}

const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const cssRgb = (s) => (String(s).match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
const toCss = ([r, g, b]) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));

// WCAG relative luminance and contrast ratio
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const DARK_TEXT = [17, 17, 19];
const LIGHT_TEXT = [250, 250, 250];

/** Whichever of near-black / near-white reads better on `bg`. */
export function textOn(bg) {
  return contrast(bg, DARK_TEXT) >= contrast(bg, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}

/** Pull a colour toward white or black until it reads on `bg` (text-only mode). */
function readable(rgb, bg) {
  const toward = lum(bg) < 0.4 ? [255, 255, 255] : [0, 0, 0];
  let c = rgb;
  for (let t = 0.9; contrast(c, bg) < 4 && t > 0.2; t -= 0.1) c = mix(rgb, toward, t);
  return c;
}

/**
 * The look of one folder row. `own` is the folder's own style, `inherited`
 * the nearest coloured ancestor's ({ style, depth }) when it passes colour
 * down. `ground` is the sidebar background as rgb.
 */
const SIZE_STEP = { xs: -3, s: -1.5, l: 2, xl: 4.5 };

export function folderLook(own, inherited, ground) {
  const out = {};
  const s = own || {};
  let color = s.color ? hexRgb(s.color) : null;
  let fill = s.fill !== false;
  let alpha = 0.85;
  if (!color && inherited) {
    color = hexRgb(inherited.style.color);
    fill = inherited.style.fill !== false;
    // each level down keeps ~62% of the tint, so deep folders stay calm
    alpha = 0.85 * 0.62 ** inherited.depth;
  }
  if (color) {
    if (fill) {
      const bg = mix(color, ground, Math.max(alpha, 0.14));
      out.background = toCss(bg);
      out.color = toCss(textOn(bg));
      out["--tree-muted"] = toCss(mix(textOn(bg), bg, 0.6));
    } else {
      const c = readable(mix(color, ground, Math.max(alpha / 0.85, 0.5)), ground);
      out.color = toCss(c);
      out["--tree-muted"] = toCss(mix(c, ground, 0.6));
    }
  }
  if (s.bold) out.fontWeight = "700";
  if (s.italic) out.fontStyle = "italic";
  if (s.dim) out.opacity = "0.55";
  if (s.size) out.fontSize = `calc(var(--tree-fs) + ${SIZE_STEP[s.size] || 0}px)`;
  return out;
}

// A colour per extension family, so the same kind of file always wears the
// same tag. Anything unknown gets a stable hue from its name.
const EXT_COLORS = {
  md: "#8d8d86", txt: "#8d8d86", canvas: "#12a594", excalidraw: "#6e56cf", leovector: "#6e56cf", leopaint: "#6e56cf", leocanvas: "#6e56cf", leostudio: "#c2298a", leovideo: "#e54666",
  pdf: "#e5484d", doc: "#3e63dd", docx: "#3e63dd", odt: "#3e63dd", rtf: "#3e63dd",
  xls: "#46a758", xlsx: "#46a758", csv: "#46a758", ods: "#46a758",
  ppt: "#f76b15", pptx: "#f76b15",
  png: "#ab4aba", jpg: "#ab4aba", jpeg: "#ab4aba", gif: "#ab4aba", webp: "#ab4aba", svg: "#ab4aba", bmp: "#ab4aba",
  mp3: "#d6409f", wav: "#d6409f", ogg: "#d6409f", m4a: "#d6409f", flac: "#d6409f",
  mp4: "#6e56cf", mov: "#6e56cf", mkv: "#6e56cf", webm: "#6e56cf",
  py: "#3e63dd", js: "#ffb224", mjs: "#ffb224", ts: "#05a2c2", tsx: "#05a2c2", jsx: "#ffb224",
  rs: "#f76b15", go: "#05a2c2", java: "#e5484d", c: "#8d8d86", cpp: "#3e63dd", cs: "#6e56cf",
  html: "#f76b15", css: "#3e63dd", json: "#ffb224", yaml: "#e5484d", yml: "#e5484d", toml: "#8d8d86",
  sh: "#46a758", ps1: "#3e63dd", bat: "#8d8d86", sql: "#f5d90a",
  zip: "#8d8d86", rar: "#8d8d86", "7z": "#8d8d86",
};

export function extColor(ext) {
  const e = String(ext).toLowerCase();
  if (EXT_COLORS[e]) return EXT_COLORS[e];
  let n = 0;
  for (const ch of e) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${n % 360} 55% 55%)`;
}

export const groundOf = (el) => {
  // the first painted background up the tree
  for (let n = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (c && !/rgba\(.*,\s*0\)$|transparent/.test(c)) return cssRgb(c);
  }
  return [18, 18, 20];
};

/**
 * The Customize popover for one folder. `get()` returns the current style,
 * `set(style|null)` saves it (null clears it).
 */
/**
 * The colour part of a Customize popup: swatches, and any colour by a shade
 * square, a hue strip or a hex code. get() -> hex or null, set(hex | null).
 * Returns { row, picker, paint() }.
 */
export function colorBlock({ get, set, fit = () => {} }) {
  const swatches = h("div", { class: "fp-swatches" },
    h("button", { class: "fp-swatch is-none", title: "No colour", onclick: () => set(null) }, icon("x")),
    ...FOLDER_COLORS.map((c) => h("button", { class: "fp-swatch", title: c, dataset: { c }, style: { background: c }, onclick: () => set(c) })));
  // Any colour: a shade square and a hue strip, reading and writing hex.
  let hsv = [210, 0.75, 1];
  const knob = h("span", { class: "fp-knob" });
  const sv = h("div", { class: "fp-sv" }, knob);
  const hueIn = h("input", { type: "range", class: "fp-hue", min: 0, max: 359, step: 1, value: 210 });
  const picker = h("div", { class: "fp-picker", hidden: true }, sv, hueIn);
  const custom = h("button", { class: "fp-custom", title: "Any colour", onclick: () => {
    picker.hidden = !picker.hidden;
    if (!picker.hidden) { const c = get(); if (c) hsv = hexToHsv(c); drawPicker(); }
    fit();
  } });
  function drawPicker() {
    sv.style.setProperty("--hue", hsv[0]);
    hueIn.value = Math.round(hsv[0]);
    knob.style.left = hsv[1] * 100 + "%";
    knob.style.top = (1 - hsv[2]) * 100 + "%";
    knob.style.background = hsvToHex(...hsv);
  }
  const choose = () => {
    const c = hsvToHex(...hsv);
    drawPicker();
    hex.value = c;
    set(c);
  };
  hueIn.addEventListener("input", () => { hsv[0] = +hueIn.value; choose(); });
  sv.addEventListener("pointerdown", (e) => {
    const at = (ev) => {
      const r = sv.getBoundingClientRect();
      hsv[1] = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      hsv[2] = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
      choose();
    };
    try { sv.setPointerCapture(e.pointerId); } catch {}
    at(e);
    const up = () => { sv.removeEventListener("pointermove", at); sv.removeEventListener("pointerup", up); };
    sv.addEventListener("pointermove", at);
    sv.addEventListener("pointerup", up);
  });
  // type or paste a hex code; applies as soon as it is a valid colour
  const hex = h("input", { class: "fp-hex", placeholder: "#3b9eff", spellcheck: false, maxLength: 9, title: "Hex colour, e.g. #3b9eff" });
  const takeHex = () => {
    const c = parseHex(hex.value);
    hex.classList.toggle("is-bad", !!hex.value.trim() && !c);
    if (c && c !== get()) set(c);
  };
  hex.addEventListener("input", takeHex);
  hex.addEventListener("paste", () => setTimeout(takeHex));
  hex.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { takeHex(); hex.blur(); } });

  function paint() {
    const c = get();
    for (const b of swatches.querySelectorAll("[data-c]")) b.classList.toggle("is-active", b.dataset.c === c);
    swatches.querySelector(".is-none").classList.toggle("is-active", !c);
    custom.style.background = c || "conic-gradient(#e5484d, #ffb224, #46a758, #3b9eff, #6e56cf, #d6409f, #e5484d)";
    if (document.activeElement !== hex) { hex.value = c || ""; hex.classList.remove("is-bad"); }
  }
  return { row: h("div", { class: "fp-colors" }, swatches, h("div", { class: "fp-own" }, custom, hex)), picker, paint };
}

export function customizeFolder(anchor, name, get, set, { defaults = {}, file = false } = {}) {
  // what an unset flag means: fill is on; subfolders take the colour only when asked
  const base = { fill: true, inherit: false, ...defaults };
  document.querySelector(".folder-pop")?.remove();
  const pop = h("div", { class: "folder-pop" });
  const close = () => { pop.remove(); document.removeEventListener("mousedown", off, true); document.removeEventListener("keydown", esc, true); };
  const off = (e) => { if (!pop.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const patch = (p) => {
    const next = { ...(get() || {}), ...p };
    for (const k in next) {
      // store only what differs from the defaults
      const dflt = k in base ? next[k] === base[k] : next[k] == null || next[k] === false;
      if (dflt) delete next[k];
    }
    set(Object.keys(next).length ? next : null);
    paint();
  };

  const cb = colorBlock({ get: () => (get() || {}).color, set: (c) => patch({ color: c }), fit: () => fit() });

  const seg = (key, opts) => h("div", { class: "segmented is-small" }, opts.map(([v, label]) =>
    h("button", { class: "seg", dataset: { k: key, v: String(v) }, onclick: () => patch({ [key]: v }) }, label)));
  const flag = (key, label) => h("label", { class: "fp-check" },
    h("input", { type: "checkbox", dataset: { k: key }, onchange: (e) => patch({ [key]: e.target.checked }) }), label);

  const body = h("div", { class: "fp-body" },
    h("div", { class: "fp-title" }, icon(file ? "fileText" : "folder"), h("span", { text: name })),
    h("div", { class: "fp-label", text: "Colour" }),
    cb.row,
    cb.picker,
    h("div", { class: "fp-label", text: "Colour shows as" }),
    seg("fill", [[true, "Highlight"], [false, "Text only"]]),
    h("div", { class: "fp-label", text: "Text size" }),
    seg("size", [["xs", "Tiny"], ["s", "Small"], [null, "Normal"], ["l", "Large"], ["xl", "Huge"]]),
    h("div", { class: "fp-flags" },
      flag("bold", "Bold"), flag("italic", "Italic"), flag("dim", "Dim"), file ? null : flag("inherit", "Subfolders take the colour")),
    h("button", { class: "btn fp-reset", onclick: () => { set(null); paint(); } }, icon("undo"), file ? "Reset this file" : "Reset this folder"));
  pop.append(body);

  function paint() {
    const s = get() || {};
    cb.paint();
    for (const b of body.querySelectorAll(".seg")) {
      const cur = s[b.dataset.k];
      const v = b.dataset.v;
      const on = b.dataset.k === "fill" ? String(cur ?? base.fill) === v : String(cur ?? null) === v;
      b.classList.toggle("is-active", on);
    }
    for (const c of body.querySelectorAll("input[type=checkbox]")) c.checked = !!(c.dataset.k in s ? s[c.dataset.k] : base[c.dataset.k]);
  }
  paint();

  document.getElementById("overlay-root").append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(6, Math.min(r.right + 6, innerWidth - pop.offsetWidth - 6)) + "px";
  // keep the whole popover on screen, also after the picker opens
  function fit() {
    pop.style.top = Math.max(6, Math.min(r.top, innerHeight - pop.offsetHeight - 6)) + "px";
  }
  fit();
  setTimeout(() => { document.addEventListener("mousedown", off, true); document.addEventListener("keydown", esc, true); });
  return close;
}
