// One colour popup for everything that draws: the same shade square, hue
// strip and hex box the folder customiser has, plus a palette and the colours
// used lately. The picture editor and Draw both open this one, so choosing a
// colour feels the same everywhere and nobody meets the OS colour dialog.

import { h } from "./util.js";
import { FOLDER_COLORS, hexToHsv, hsvToHex, parseHex } from "./treestyle.js";

/** The palette: the app's own hues, then a run from white to black. */
export const DRAW_PALETTE = [
  ...FOLDER_COLORS.slice(0, 11),
  "#8b5a2b", "#f4c7a1", "#7a8794",
  "#ffffff", "#d4d4d8", "#a1a1aa", "#71717a", "#3f3f46", "#18181b", "#000000",
];

const RECENT_KEY = "leonote.recentColours";
const RECENT_MAX = 14;

export function recentColours() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

/** Put a colour at the front of the recents. Called when it is actually drawn with, not on every drag of the picker. */
export function noteColour(c) {
  if (!/^#[0-9a-f]{6}$/i.test(c || "")) return;
  const v = c.toLowerCase();
  const list = [v, ...recentColours().filter((x) => x.toLowerCase() !== v)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

/**
 * Open the popup beside `anchor`. `onPick(hex)` fires live while dragging.
 * `second`: `{ value, onSwap }` shows the second colour with a swap button.
 * Returns a function that closes it.
 */
export function colourPop(anchor, { value = "#e0a84a", onPick, onClose = null, title = "Colour", side = "right" } = {}) {
  document.querySelector(".colour-pop")?.remove();
  let current = parseHex(value) || "#e0a84a";
  let hsv = hexToHsv(current);

  const knob = h("span", { class: "fp-knob" });
  const sv = h("div", { class: "fp-sv" }, knob);
  const hueIn = h("input", { type: "range", class: "fp-hue", min: 0, max: 359, step: 1 });
  const chip = h("span", { class: "cp-chip" });
  const hex = h("input", { class: "fp-hex", spellcheck: false, maxLength: 9, title: "Hex colour, e.g. #3b9eff" });
  const paletteEl = h("div", { class: "cp-grid" });
  const recentEl = h("div", { class: "cp-grid" });
  const recentWrap = h("div", { class: "cp-sec" }, h("div", { class: "fp-label", text: "Used lately" }), recentEl);

  const swatch = (c) => h("button", {
    class: "fp-swatch" + (c.toLowerCase() === current.toLowerCase() ? " is-active" : ""), title: c, style: { background: c },
    onclick: () => { hsv = hexToHsv(c); apply(c); },
  });

  function paint() {
    sv.style.setProperty("--hue", hsv[0]);
    hueIn.value = Math.round(hsv[0]);
    knob.style.left = hsv[1] * 100 + "%";
    knob.style.top = (1 - hsv[2]) * 100 + "%";
    knob.style.background = current;
    chip.style.background = current;
    if (document.activeElement !== hex) { hex.value = current; hex.classList.remove("is-bad"); }
    paletteEl.replaceChildren(...DRAW_PALETTE.map(swatch));
    const rec = recentColours();
    recentWrap.hidden = !rec.length;
    recentEl.replaceChildren(...rec.map(swatch));
  }
  function apply(c) {
    current = c;
    paint();
    if (onPick) onPick(c);
  }

  hueIn.addEventListener("input", () => { hsv[0] = +hueIn.value; apply(hsvToHex(...hsv)); });
  sv.addEventListener("pointerdown", (e) => {
    const at = (ev) => {
      const r = sv.getBoundingClientRect();
      hsv[1] = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      hsv[2] = Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height));
      apply(hsvToHex(...hsv));
    };
    try { sv.setPointerCapture(e.pointerId); } catch {}
    at(e);
    const up = () => { sv.removeEventListener("pointermove", at); sv.removeEventListener("pointerup", up); sv.removeEventListener("pointercancel", up); };
    sv.addEventListener("pointermove", at);
    sv.addEventListener("pointerup", up);
    sv.addEventListener("pointercancel", up);
  });
  const takeHex = () => {
    const c = parseHex(hex.value);
    hex.classList.toggle("is-bad", !!hex.value.trim() && !c);
    if (c && c.toLowerCase() !== current.toLowerCase()) { hsv = hexToHsv(c); apply(c); }
  };
  hex.addEventListener("input", takeHex);
  hex.addEventListener("paste", () => setTimeout(takeHex));
  hex.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { takeHex(); close(); } if (e.key === "Escape") close(); });

  const pop = h("div", { class: "folder-pop colour-pop" },
    h("div", { class: "fp-body" },
      h("div", { class: "cp-head" }, chip, h("span", { class: "cp-title", text: title }), hex),
      h("div", { class: "fp-picker" }, sv, hueIn),
      h("div", { class: "cp-sec" }, h("div", { class: "fp-label", text: "Palette" }), paletteEl),
      recentWrap));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    pop.remove();
    document.removeEventListener("mousedown", off, true);
    document.removeEventListener("keydown", esc, true);
    if (onClose) onClose(current);
  }
  const off = (e) => { if (!pop.contains(e.target) && !anchor.contains?.(e.target)) close(); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };

  paint();
  document.getElementById("overlay-root").append(pop);
  const r = anchor.getBoundingClientRect();
  const left = side === "below" ? r.left : r.right + 8;
  const top = side === "below" ? r.bottom + 6 : r.top - 40;
  pop.style.left = Math.max(6, Math.min(left, innerWidth - pop.offsetWidth - 6)) + "px";
  pop.style.top = Math.max(6, Math.min(top, innerHeight - pop.offsetHeight - 6)) + "px";
  setTimeout(() => { if (!closed) { document.addEventListener("mousedown", off, true); document.addEventListener("keydown", esc, true); } });
  return close;
}
