// Studio: the photo-editing half of the raster editor.
//
// paint.js owns the canvas, the tools and the layer list. This file is what
// makes it a photo editor: the Adjustments panel (curves, levels, the sliders),
// the Image / Select / Filter menus, the size dialogs, background removal and
// placing pictures. It gets everything it needs from the editor through `ed`
// and never reaches into the canvas itself.
//
// Adjustments are edited live and recorded once: a slider drag repaints on
// every step (a GPU filter, a few milliseconds) and lands as ONE undo step
// when the pointer lets go.

import { menu, toast } from "./ui.js";
import { subjectMask } from "./paintselect.js";
import { clamp } from "./util.js";
import * as D from "./paintdoc.js";
import * as A from "./paintadjust.js";
import * as G from "./paintgeom.js";
import * as S from "./paintstore.js";
import { removeBackground, dominantColours, borderSamples } from "./paintselect.js";
import { svgFilter, adjustFilter, releaseCanvas } from "./paintengine.js";
import { metaStep, groupStep, pixelStep } from "./painthistory.js";

const ADJ_ICONS = {
  sun: '<circle cx="12" cy="12" r="3.500"/><path d="M12 3.500v2M12 18.500v2M3.500 12h2M18.500 12h2M6 6l1.400 1.400M16.600 16.600L18 18M6 18l1.400-1.400M16.600 7.400L18 6"/>',
  aperture: '<circle cx="12" cy="12" r="8"/><path d="M12 4l3.500 6M19.500 9.500h-7M18 17l-3.500-6M12 20l-3.500-6M4.500 14.500h7M6 7l3.500 6"/>',
  levels: '<path d="M4 19.500h16M5.500 19.500V14M9 19.500V8M12.500 19.500V5M16 19.500v-8M19 19.500V15"/>',
  curve: '<path d="M4 4v16h16"/><path d="M4 20c6-1 6-12 16-15"/>',
  palette: '<path d="M12 4a8 8 0 1 0 0 16c1.200 0 1.800-.800 1.800-1.700 0-1.500-1.300-1.800-1.300-3 0-1 .800-1.800 2-1.800h1.700A3.800 3.800 0 0 0 20 9.700C20 6.500 16.400 4 12 4z"/><circle cx="8" cy="10" r="1"/><circle cx="11.500" cy="7.500" r="1"/><circle cx="15.500" cy="8.500" r="1"/>',
  thermo: '<path d="M10 14.500V6a2 2 0 0 1 4 0v8.500a4 4 0 1 1-4 0z"/><path d="M12 10v6"/>',
  balance: '<path d="M12 4v16M6 20h12M5 8h14M5 8l-2 6a3 3 0 0 0 6 0zM19 8l-2 6a3 3 0 0 0 6 0z" transform="scale(.9) translate(1.300 1.300)"/>',
  contrast: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  filter: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  gradient: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 6v12M12 6v12M16 6v12" opacity=".5"/>',
  invert: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 20L20 4v14a2 2 0 0 1-2 2z" fill="currentColor" stroke="none"/>',
  steps: '<path d="M4 19h4v-4h4v-4h4V7h4"/>',
};

const CHANNELS = [["rgb", "RGB", "#d0d4da"], ["r", "Red", "#ff6b6b"], ["g", "Green", "#51cf66"], ["b", "Blue", "#4dabf7"]];

const GRADIENT_PRESETS = [
  ["Dusk", [["#0b1026", 0], ["#c2255c", 0.5], ["#ffe8a3", 1]]],
  ["Black and white", [["#000000", 0], ["#ffffff", 1]]],
  ["Sepia", [["#1d1208", 0], ["#8a5a2b", 0.5], ["#f6e7c8", 1]]],
  ["Cyanotype", [["#04162b", 0], ["#1f6fb2", 0.55], ["#eaf6ff", 1]]],
  ["Infra", [["#12002e", 0], ["#d6006f", 0.45], ["#ffd23f", 1]]],
  ["Forest", [["#06130c", 0], ["#2f7d4f", 0.5], ["#f1f7c9", 1]]],
  ["Teal and orange", [["#062a33", 0], ["#1b8a8f", 0.4], ["#f08c3a", 0.75], ["#fff0d6", 1]]],
];

const makeCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

export function mountStudio(ed) {
  const { app, doc, engine, h, icon, svg, fill, slider, root } = ed;
  let chan = "rgb";
  let tone = "mids";
  let pending = null; // the layer list as it was when a live edit began
  let modal = null; // an open dialog that owns a surface (a filter preview, the background remover)
  let destroyed = false;

  const adjIcon = (name) => svg(ADJ_ICONS[name] || ADJ_ICONS.sun);

  /* ── live editing of an adjustment ──────────────────────────────────── */

  const current = () => { const l = ed.layer(); return l && l.kind === "adjust" ? l : null; };

  function live(mutate) {
    const l = current();
    if (!l || ed.readOnly) return;
    if (!pending) pending = ed.layerSnapshot();
    // a new object every time: the undo snapshots hold the old one by reference
    l.adjust = mutate(JSON.parse(JSON.stringify(l.adjust)));
    engine.allDirty = true;
    ed.invalidate();
  }

  function commit(label = "Adjust") {
    if (!pending) return;
    const before = pending;
    pending = null;
    ed.pushMeta(label, before);
  }

  /** A slider bound to one parameter of the selected adjustment. */
  const param = (label, key, min, max, step, fmt = (v) => String(Math.round(v))) => {
    const l = current();
    return slider(label, Number(l.adjust[key]) || 0, min, max, step, (v) => live((a) => ({ ...a, [key]: v })), fmt, () => commit(label));
  };

  const colourParam = (label, key) => {
    const l = current();
    return h("label", { class: "pt-field" }, h("span", { text: label }),
      h("input", { class: "pt-colour-in", type: "color", value: l.adjust[key] || "#ffffff", oninput: (e) => live((a) => ({ ...a, [key]: e.target.value })), onchange: () => commit(label) }));
  };

  /* ── the histogram ──────────────────────────────────────────────────── */

  /** The tones of the picture as it is WITHOUT this adjustment — what its controls act on. */
  function histogramUnder(layerId) {
    const l = D.layerOf(doc, layerId);
    const was = l ? l.visible : true;
    if (l) l.visible = false;
    try {
      const px = engine.readPixels({ scale: Math.min(1, 256 / Math.max(doc.width, doc.height)) });
      return A.histogram(px.data);
    } finally {
      if (l) l.visible = was;
    }
  }

  function drawHistogram(canvas, hist, which = "rgb") {
    const w = canvas.width;
    const hh = canvas.height;
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, w, hh);
    if (!hist || !hist.count) return;
    const draw = (arr, colour, alpha) => {
      // the tallest spike (often pure black or white) must not flatten the rest
      const sorted = Array.from(arr).sort((a, b) => a - b);
      const top = Math.max(1, sorted[250] * 1.15);
      g.beginPath();
      g.moveTo(0, hh);
      for (let i = 0; i < 256; i++) g.lineTo((i / 255) * w, hh - Math.min(1, arr[i] / top) * hh);
      g.lineTo(w, hh);
      g.closePath();
      g.globalAlpha = alpha;
      g.fillStyle = colour;
      g.fill();
    };
    if (which === "rgb") {
      g.globalCompositeOperation = "lighter";
      draw(hist.r, "#ff5a5a", 0.5);
      draw(hist.g, "#4cd964", 0.5);
      draw(hist.b, "#4aa3ff", 0.5);
      g.globalCompositeOperation = "source-over";
    } else {
      const ch = CHANNELS.find((c) => c[0] === which); // "l", the lightness, has no colour of its own
      draw(hist[which], ch ? ch[2] : "#d0d4da", 0.7);
    }
    g.globalAlpha = 1;
  }

  const channelTabs = (onPick) => h("div", { class: "pt-seg pt-chan" }, ...CHANNELS.map(([id, name, col]) =>
    h("button", { class: "pt-seg-btn" + (chan === id ? " is-on" : ""), style: `--chan:${col}`, onclick: () => { chan = id; onPick(); } }, name)));

  /* ── the editors ────────────────────────────────────────────────────── */

  function levelsEditor(l) {
    const hist = histogramUnder(l.id);
    const canvas = h("canvas", { class: "pt-hist", width: 232, height: 84 });
    drawHistogram(canvas, hist, chan === "rgb" ? "rgb" : chan);
    const lv = l.adjust[chan] || {};
    const set = (key) => (v) => live((a) => ({ ...a, [chan]: { ...a[chan], [key]: v } }));
    const done = () => commit("Levels");
    return [
      channelTabs(render),
      canvas,
      slider("Black", lv.inBlack ?? 0, 0, 253, 1, set("inBlack"), (v) => String(Math.round(v)), done),
      slider("Midtones", (lv.gamma ?? 1) * 100, 10, 500, 1, (v) => set("gamma")(v / 100), (v) => (v / 100).toFixed(2), done),
      slider("White", lv.inWhite ?? 255, 2, 255, 1, set("inWhite"), (v) => String(Math.round(v)), done),
      h("div", { class: "pt-adj-sub", text: "Output" }),
      slider("Darkest", lv.outBlack ?? 0, 0, 255, 1, set("outBlack"), (v) => String(Math.round(v)), done),
      slider("Lightest", lv.outWhite ?? 255, 0, 255, 1, set("outWhite"), (v) => String(Math.round(v)), done),
      h("div", { class: "pt-param-acts" },
        h("button", { class: "btn", title: "Stretch the tones to fill the range", onclick: () => { const auto = A.autoLevels(hist); live((a) => ({ ...a, rgb: auto.rgb })); commit("Auto levels"); } }, "Auto"),
        h("button", { class: "btn", title: "Stretch each colour on its own — also takes out a colour cast", onclick: () => { const auto = A.autoLevels(hist, { perChannel: true }); live((a) => ({ ...a, r: auto.r, g: auto.g, b: auto.b })); commit("Auto colour"); } }, "Auto colour")),
    ];
  }

  function curvesEditor(l) {
    const SIZE = 232;
    const hist = histogramUnder(l.id);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = h("canvas", { class: "pt-curve", width: SIZE * dpr, height: SIZE * dpr, style: `width:${SIZE}px;height:${SIZE}px` });
    const back = makeCanvas(SIZE, 96);
    drawHistogram(back, hist, chan === "rgb" ? "l" : chan);
    const readout = h("span", { class: "pt-adj-read", text: "Click the line to add a point · drag one off the box to remove it" });
    const pts = () => (current() ? current().adjust[chan] : [[0, 0], [255, 255]]);

    const paint = () => {
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, SIZE, SIZE);
      g.globalAlpha = 0.35;
      g.drawImage(back, 0, SIZE - 96, SIZE, 96);
      g.globalAlpha = 1;
      g.strokeStyle = "rgba(128,128,128,.28)";
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 1; i < 4; i++) { const p = Math.round((SIZE * i) / 4) + 0.5; g.moveTo(p, 0); g.lineTo(p, SIZE); g.moveTo(0, p); g.lineTo(SIZE, p); }
      g.moveTo(0, SIZE); g.lineTo(SIZE, 0);
      g.stroke();
      const a = current() ? current().adjust : null;
      if (!a) return;
      for (const [id, , col] of CHANNELS) {
        if (id === chan) continue;
        if (JSON.stringify(a[id]) === "[[0,0],[255,255]]") continue;
        line(g, A.curveTable(a[id]), col, 0.4, 1);
      }
      line(g, A.curveTable(a[chan]), CHANNELS.find((c) => c[0] === chan)[2], 1, 1.8);
      for (const [x, y] of a[chan]) {
        g.beginPath();
        g.arc((x / 255) * SIZE, SIZE - (y / 255) * SIZE, 4.5, 0, Math.PI * 2);
        g.fillStyle = "#fff";
        g.fill();
        g.strokeStyle = "rgba(0,0,0,.7)";
        g.lineWidth = 1.2;
        g.stroke();
      }
    };
    const line = (g, table, colour, alpha, width) => {
      g.beginPath();
      for (let i = 0; i < 256; i++) { const x = (i / 255) * SIZE; const y = SIZE - (table[i] / 255) * SIZE; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.globalAlpha = alpha;
      g.strokeStyle = colour;
      g.lineWidth = width;
      g.stroke();
      g.globalAlpha = 1;
    };

    let grab = -1;
    const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * 255, y: (1 - (e.clientY - r.top) / r.height) * 255, out: e.clientX < r.left - 28 || e.clientX > r.right + 28 || e.clientY < r.top - 28 || e.clientY > r.bottom + 28 }; };
    canvas.addEventListener("pointerdown", (e) => {
      if (ed.readOnly) return;
      canvas.setPointerCapture(e.pointerId);
      const p = at(e);
      const list = pts();
      grab = list.findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) < 14);
      if (grab < 0) {
        live((a) => { const next = [...a[chan], [Math.round(clamp(p.x, 0, 255)), Math.round(clamp(p.y, 0, 255))]].sort((m, n) => m[0] - n[0]); return { ...a, [chan]: next }; });
        grab = pts().findIndex(([x]) => x === Math.round(clamp(p.x, 0, 255)));
      }
      paint();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (grab < 0) return;
      const p = at(e);
      const list = pts();
      if (p.out && list.length > 2) {
        live((a) => ({ ...a, [chan]: a[chan].filter((_, i) => i !== grab) }));
        grab = -1;
        paint();
        return;
      }
      const lo = grab > 0 ? list[grab - 1][0] + 1 : 0;
      const hi = grab < list.length - 1 ? list[grab + 1][0] - 1 : 255;
      const nx = Math.round(clamp(p.x, lo, hi));
      const ny = Math.round(clamp(p.y, 0, 255));
      live((a) => ({ ...a, [chan]: a[chan].map((q, i) => (i === grab ? [nx, ny] : q)) }));
      readout.textContent = `in ${nx} → out ${ny}`;
      paint();
    });
    const up = () => { if (grab >= 0 || pending) { grab = -1; commit("Curves"); } };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("dblclick", (e) => {
      const p = at(e);
      const list = pts();
      const i = list.findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) < 14);
      if (i >= 0 && list.length > 2) { live((a) => ({ ...a, [chan]: a[chan].filter((_, k) => k !== i) })); commit("Curves"); }
    });
    paint();

    const shape = (points) => () => { live((a) => ({ ...a, [chan]: points })); commit("Curves"); };
    return [
      channelTabs(render),
      canvas,
      readout,
      h("div", { class: "pt-param-acts is-wrap" },
        h("button", { class: "btn", onclick: shape([[0, 0], [64, 48], [192, 208], [255, 255]]) }, "Contrast"),
        h("button", { class: "btn", onclick: shape([[0, 0], [64, 78], [192, 180], [255, 255]]) }, "Soften"),
        h("button", { class: "btn", onclick: shape([[0, 0], [128, 152], [255, 255]]) }, "Lighter"),
        h("button", { class: "btn", onclick: shape([[0, 0], [128, 104], [255, 255]]) }, "Darker"),
        h("button", { class: "btn", title: "Lifted blacks, like film", onclick: shape([[0, 28], [70, 72], [255, 250]]) }, "Matte"),
        h("button", { class: "btn", onclick: shape([[0, 0], [255, 255]]) }, "Reset line")),
    ];
  }

  function balanceEditor(l) {
    const names = { shadows: "Shadows", mids: "Midtones", highlights: "Highlights" };
    const v = l.adjust[tone] || [0, 0, 0];
    const set = (i) => (val) => live((a) => { const next = [...(a[tone] || [0, 0, 0])]; next[i] = val; return { ...a, [tone]: next }; });
    const done = () => commit("Colour balance");
    const f = (x) => String(Math.round(x));
    return [
      h("div", { class: "pt-seg pt-chan" }, ...Object.entries(names).map(([id, name]) => h("button", { class: "pt-seg-btn" + (tone === id ? " is-on" : ""), onclick: () => { tone = id; render(); } }, name))),
      slider("Cyan – Red", v[0], -100, 100, 1, set(0), f, done),
      slider("Magenta – Green", v[1], -100, 100, 1, set(1), f, done),
      slider("Yellow – Blue", v[2], -100, 100, 1, set(2), f, done),
    ];
  }

  function gradientEditor(l) {
    const stops = l.adjust.stops || [];
    const css = () => `linear-gradient(90deg, ${[...(current() ? current().adjust.stops : stops)].sort((a, b) => a.at - b.at).map((s) => `${s.colour} ${Math.round(s.at * 100)}%`).join(", ")})`;
    const bar = h("div", { class: "pt-grad-bar", style: `background:${css()}` });
    const setStop = (i, patch) => { live((a) => ({ ...a, stops: a.stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) })); bar.style.background = css(); };
    return [
      bar,
      ...stops.map((s, i) => h("div", { class: "pt-grad-stop" },
        h("input", { class: "pt-colour-in", type: "color", value: s.colour, oninput: (e) => setStop(i, { colour: e.target.value }), onchange: () => commit("Gradient map") }),
        h("input", { class: "pt-range", type: "range", min: 0, max: 100, step: 1, value: Math.round(s.at * 100), oninput: (e) => setStop(i, { at: Number(e.target.value) / 100 }), onchange: () => commit("Gradient map") }),
        h("button", { class: "pt-icon", title: "Remove this colour", disabled: stops.length <= 2, onclick: () => { live((a) => ({ ...a, stops: a.stops.filter((_, k) => k !== i) })); commit("Gradient map"); } }, icon("x")))),
      h("div", { class: "pt-param-acts is-wrap" },
        h("button", { class: "btn", disabled: stops.length >= 8, onclick: () => { live((a) => ({ ...a, stops: [...a.stops, { at: 0.5, colour: "#888888" }] })); commit("Gradient map"); } }, "Add a colour"),
        h("button", { class: "btn", onclick: () => { live((a) => ({ ...a, stops: a.stops.map((s) => ({ ...s, at: 1 - s.at })) })); commit("Gradient map"); } }, "Reverse")),
      h("div", { class: "pt-adj-sub", text: "Looks" }),
      h("div", { class: "pt-grad-presets" }, ...GRADIENT_PRESETS.map(([name, list]) =>
        h("button", { class: "pt-grad-preset", title: name, style: `background:linear-gradient(90deg, ${list.map(([c, at]) => `${c} ${at * 100}%`).join(", ")})`, onclick: () => { live((a) => ({ ...a, stops: list.map(([colour, at]) => ({ at, colour })) })); commit("Gradient map"); } }))),
    ];
  }

  function editorFor(l) {
    const pct = (v) => `${Math.round(v)}`;
    switch (l.adjust.type) {
      case "brightness": return [param("Brightness", "brightness", -100, 100, 1, pct), param("Contrast", "contrast", -100, 100, 1, pct)];
      case "exposure": return [param("Exposure", "exposure", -5, 5, 0.05, (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV`), param("Offset", "offset", -0.5, 0.5, 0.005, (v) => v.toFixed(3)), param("Gamma", "gamma", 0.2, 5, 0.01, (v) => v.toFixed(2))];
      case "levels": return levelsEditor(l);
      case "curves": return curvesEditor(l);
      case "hsl": return [param("Hue", "hue", -180, 180, 1, (v) => `${Math.round(v)}°`), param("Saturation", "saturation", -100, 100, 1, pct), param("Lightness", "lightness", -100, 100, 1, pct)];
      case "vibrance": return [param("Vibrance", "vibrance", -100, 100, 1, pct)];
      case "temperature": return [param("Temperature", "temperature", -100, 100, 1, pct), param("Tint", "tint", -100, 100, 1, pct), h("p", { class: "pt-adj-note", text: "Right is warmer; tint runs from green to magenta." })];
      case "balance": return balanceEditor(l);
      case "bw": return [param("Reds", "r", -100, 200, 1, pct), param("Greens", "g", -100, 200, 1, pct), param("Blues", "b", -100, 200, 1, pct), colourParam("Tint", "tint"), param("Tint amount", "tintAmount", 0, 100, 1, (v) => `${Math.round(v)}%`)];
      case "photofilter": return [colourParam("Colour", "colour"), param("Density", "density", 0, 100, 1, (v) => `${Math.round(v)}%`)];
      case "gradientmap": return gradientEditor(l);
      case "posterize": return [param("Levels", "levels", 2, 32, 1, pct)];
      case "threshold": return [param("Level", "level", 1, 255, 1, pct)];
      default: return [h("p", { class: "pt-adj-note", text: "Nothing to set: this one simply inverts every colour under it." })];
    }
  }

  /* ── the panel ──────────────────────────────────────────────────────── */

  let renderRaf = 0;
  function render() {
    if (destroyed || renderRaf) return;
    renderRaf = requestAnimationFrame(() => { renderRaf = 0; renderNow(); });
  }

  function renderNow() {
    if (destroyed || ed.workspace !== "studio") return;
    // a control being dragged must not be rebuilt under the pointer
    if (pending) return;
    const l = current();
    renderList();
    if (!l) return;
    // the chosen adjustment's settings under the list, which stays: the panel scrolls when it all does not fit
    const def = A.ADJUST_BY_ID.get(l.adjust.type) || A.ADJUSTMENTS[0];
    const sec = h("div", { class: "pt-adj-sec" },
      h("div", { class: "pt-panel-head" },
        h("span", { class: "pt-panel-title" }, adjIcon(def.icon), def.name),
        h("span", { class: "pt-head-acts" },
          h("button", { class: "pt-icon", title: "Back to its defaults", disabled: ed.readOnly, onclick: () => { live(() => A.newAdjust(l.adjust.type)); commit("Reset adjustment"); } }, icon("undo")),
          h("button", { class: "pt-icon", title: "Close its settings (the layer stays)", onclick: () => { const under = doc.layers[Math.max(0, D.layerIndex(doc, l.id) - 1)]; ed.select((under || l).id === l.id ? l.id : under.id); renderList(); } }, icon("x")))),
      h("div", { class: "pt-adj-body" }, ...editorFor(l),
        h("p", { class: "pt-adj-note", text: l.mask ? "Masked: it only applies where its mask is white." : "Applies to everything under it. Add a mask (the circle under the layer list) to paint where it applies." })));
    ed.adjustPanel.append(sec);
    if (shownAdj !== l.id) { shownAdj = l.id; requestAnimationFrame(() => sec.scrollIntoView({ block: "nearest" })); }
  }
  let shownAdj = null;

  function renderList() {
    const hist = makeHistogramCard();
    fill(ed.adjustPanel,
      h("div", { class: "pt-panel-head" },
        h("span", { class: "pt-panel-title" }, adjIcon("sun"), "Adjustments"),
        h("span", { class: "pt-head-acts" },
          h("button", { class: "pt-mini-btn", title: "One click: a Levels layer that stretches the tones to fill the range", disabled: ed.readOnly, onclick: () => autoFix(false) }, "Auto"),
          h("button", { class: "pt-mini-btn", title: "Cut the subject out: hides the background with a mask you can paint back", disabled: ed.readOnly, onclick: backgroundDialog }, "Cut out"))),
      hist,
      h("div", { class: "pt-adj-grid" }, ...A.ADJUSTMENTS.map((a) =>
        h("button", { class: "pt-adj-add", title: `${a.name}: a layer above this one. It changes nothing underneath for good — hide or delete it any time.`, disabled: ed.readOnly, onclick: () => ed.addAdjust(A.newAdjust(a.id)) }, adjIcon(a.icon), h("span", { text: a.short || a.name })))));
  }

  function makeHistogramCard() {
    const canvas = h("canvas", { class: "pt-hist", width: 232, height: 64 });
    try { drawHistogram(canvas, A.histogram(engine.readPixels({ scale: Math.min(1, 256 / Math.max(doc.width, doc.height)) }).data), "rgb"); } catch { /* an empty histogram is fine */ }
    return canvas;
  }

  function autoFix(perChannel) {
    const px = engine.readPixels({ scale: Math.min(1, 512 / Math.max(doc.width, doc.height)) });
    const adj = A.autoLevels(A.histogram(px.data), { perChannel });
    // on top of everything, because it was measured from everything
    ed.select(doc.layers[doc.layers.length - 1].id);
    const l = ed.addAdjust(adj);
    if (l) toast("Added a Levels layer. Nothing underneath was changed — delete the layer to take it back.", { ms: 4200 });
  }

  const adjustItems = () => A.ADJUSTMENTS.map((a) => ({ label: a.name, icon: "sliders", run: () => { if (ed.workspace !== "studio") ed.setWorkspace("studio"); ed.addAdjust(A.newAdjust(a.id)); } }));

  /** Ctrl+L / Ctrl+M / Ctrl+U: the adjustment, as a layer, with its editor open. */
  function quickAdjust(type) {
    if (ed.readOnly) return;
    if (ed.workspace !== "studio") ed.setWorkspace("studio");
    ed.addAdjust(A.newAdjust(type));
  }

  /* ── dialogs ────────────────────────────────────────────────────────── */

  /**
   * A small modal. `blocking` keeps the editor behind it from being touched,
   * which matters while a dialog is previewing on a real layer.
   */
  function dialog(title, body, { ok = "Apply", onOk, onCancel = null, wide = false, blocking = true, side = false } = {}) {
    let closed = false;
    const close = (accepted) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      if (!accepted && onCancel) onCancel();
      root.focus({ preventScroll: true });
    };
    const okBtn = h("button", { class: "btn btn-primary", onclick: async () => { const r = await onOk(); if (r !== false) close(true); } }, ok);
    const box = h("div", { class: "dlg pt-dlg" + (wide ? " is-wide" : ""), role: "dialog", "aria-modal": "true" },
      h("h3", { class: "dlg-title", text: title }),
      h("div", { class: "pt-dlg-body" }, body),
      h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => close(false) }, "Cancel"), okBtn));
    const back = h("div", { class: "dlg-back pt-dlg-back" + (side ? " is-side" : "") + (blocking ? "" : " is-clear"), onmousedown: (e) => { if (e.target === back && !side) close(false); } }, box);
    if (side) {
      // beside the picture it is previewing on, not over it: just right of the tool rail
      const r = root.getBoundingClientRect();
      back.style.padding = `${Math.round(r.top + 96)}px 0 0 ${Math.round(r.left + 64)}px`;
    }
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON") { e.preventDefault(); e.stopPropagation(); okBtn.click(); }
      else if (!/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    (document.getElementById("overlay-root") || document.body).append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
    return { close, box, okBtn };
  }

  const numField = (label, value, { min = 1, max = D.MAX_SIDE, step = 1, oninput } = {}) => {
    const input = h("input", { class: "pt-input pt-num-in", type: "number", min, max, step, value });
    input.addEventListener("input", () => oninput && oninput(Number(input.value)));
    return { el: h("label", { class: "pt-field" }, h("span", { text: label }), input), input };
  };

  const tooBig = (w, hh) => {
    if (w < 1 || hh < 1) return "A canvas needs at least one pixel each way.";
    if (w > D.MAX_SIDE || hh > D.MAX_SIDE) return `A side can be at most ${D.MAX_SIDE} px.`;
    if (w * hh > D.MAX_PIXELS) return `That is ${(w * hh / 1e6).toFixed(1)} megapixels; the most a drawing can be is ${Math.round(D.MAX_PIXELS / 1e6)}.`;
    return null;
  };

  function canvasSizeDialog() {
    let unit = "px";
    let anchor = "c";
    const w = numField("Width", doc.width, { max: 99999, step: "any" });
    const hh = numField("Height", doc.height, { max: 99999, step: "any" });
    const info = h("p", { class: "pt-dlg-info" });
    const px = () => ({ w: G.unitToPx(Number(w.input.value) || 0, unit, doc.dpi), h: G.unitToPx(Number(hh.input.value) || 0, unit, doc.dpi) });
    const refresh = () => {
      const p = px();
      const bad = tooBig(p.w, p.h);
      info.textContent = bad || `${p.w} × ${p.h} px · was ${doc.width} × ${doc.height}. ${p.w < doc.width || p.h < doc.height ? "What falls outside is cut off every layer." : "The new space is empty."}`;
      info.classList.toggle("pt-warn", !!bad);
      for (const b of grid.children) b.classList.toggle("is-on", b.dataset.a === anchor);
    };
    const unitSel = h("select", { class: "pt-select", onchange: (e) => {
      const p = px();
      unit = e.target.value;
      w.input.value = round3(G.pxToUnit(p.w, unit, doc.dpi));
      hh.input.value = round3(G.pxToUnit(p.h, unit, doc.dpi));
      refresh();
    } }, ...G.UNITS.map((u) => h("option", { value: u.id, text: u.name })));
    const grid = h("div", { class: "pt-anchor", title: "Where the picture stays when the canvas changes size" },
      ...["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"].map((a) => h("button", { dataset: { a }, onclick: () => { anchor = a; refresh(); } })));
    w.input.addEventListener("input", refresh);
    hh.input.addEventListener("input", refresh);
    refresh();
    dialog("Canvas size", [h("div", { class: "pt-dlg-cols" }, h("div", null, w.el, hh.el, h("label", { class: "pt-field" }, h("span", { text: "Units" }), unitSel)), h("div", { class: "pt-anchor-wrap" }, h("span", { class: "pt-adj-sub", text: "Keep the picture" }), grid)), info], {
      ok: "Resize the canvas",
      onOk: () => {
        const p = px();
        const bad = tooBig(p.w, p.h);
        if (bad) { toast(bad, { kind: "error" }); return false; }
        if (p.w === doc.width && p.h === doc.height) return true;
        ed.docOp("Canvas size", () => engine.resizeCanvas(p.w, p.h, anchor));
        return true;
      },
    });
  }

  const round3 = (v) => Math.round(v * 1000) / 1000;

  function imageSizeDialog() {
    let unit = "px";
    let lock = true;
    let resample = true;
    const ratio = doc.width / doc.height;
    const w = numField("Width", doc.width, { max: 99999, step: "any" });
    const hh = numField("Height", doc.height, { max: 99999, step: "any" });
    const dpi = numField("Resolution", doc.dpi, { min: 1, max: 2400 });
    const info = h("p", { class: "pt-dlg-info" });
    const curDpi = () => clamp(Number(dpi.input.value) || doc.dpi, 1, 2400);
    const px = () => (resample
      ? { w: G.unitToPx(Number(w.input.value) || 0, unit, curDpi()), h: G.unitToPx(Number(hh.input.value) || 0, unit, curDpi()) }
      : { w: doc.width, h: doc.height });
    const refresh = () => {
      const p = px();
      const bad = tooBig(p.w, p.h);
      const mm = D.printSize(p.w, p.h, curDpi());
      info.textContent = bad || `${p.w} × ${p.h} px · prints at ${mm.w} × ${mm.h} mm · was ${doc.width} × ${doc.height}${p.w > doc.width ? ". Bigger than the original: it will be softer, not sharper." : ""}`;
      info.classList.toggle("pt-warn", !!bad);
    };
    w.input.addEventListener("input", () => { if (lock) hh.input.value = round3((Number(w.input.value) || 0) / ratio); refresh(); });
    hh.input.addEventListener("input", () => { if (lock) w.input.value = round3((Number(hh.input.value) || 0) * ratio); refresh(); });
    dpi.input.addEventListener("input", () => {
      // without resampling the pixels stay and the print size moves; with it, the units keep their size and the pixels follow
      if (!resample && unit !== "px") { w.input.value = round3(G.pxToUnit(doc.width, unit, curDpi())); hh.input.value = round3(G.pxToUnit(doc.height, unit, curDpi())); }
      refresh();
    });
    const unitSel = h("select", { class: "pt-select", onchange: (e) => {
      const p = px();
      unit = e.target.value;
      w.input.value = round3(G.pxToUnit(p.w, unit, curDpi()));
      hh.input.value = round3(G.pxToUnit(p.h, unit, curDpi()));
      refresh();
    } }, ...G.UNITS.map((u) => h("option", { value: u.id, text: u.name })));
    const half = (k) => h("button", { class: "btn", onclick: () => { w.input.value = round3(Number(w.input.value) * k); hh.input.value = round3(Number(hh.input.value) * k); refresh(); } }, k < 1 ? "Half" : "Double");
    refresh();
    dialog("Image size", [
      w.el, hh.el,
      h("label", { class: "pt-field" }, h("span", { text: "Units" }), unitSel),
      h("label", { class: "pt-field" }, h("span", { text: "Resolution" }), dpi.input, h("span", { class: "pt-num", text: "dpi" })),
      h("label", { class: "pt-check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { lock = e.target.checked; } }), h("span", { text: "Keep the proportions" })),
      h("label", { class: "pt-check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { resample = e.target.checked; w.input.disabled = hh.input.disabled = !resample && unit === "px"; refresh(); } }), h("span", { text: "Resample (change the number of pixels)" })),
      h("div", { class: "pt-param-acts" }, half(0.5), half(2)),
      info,
    ], {
      ok: "Resize the image",
      onOk: () => {
        const p = px();
        const bad = tooBig(p.w, p.h);
        if (bad) { toast(bad, { kind: "error" }); return false; }
        const d = curDpi();
        if (p.w === doc.width && p.h === doc.height) {
          if (d !== doc.dpi) { const was = doc.dpi; doc.dpi = d; ed.history.push({ kind: "meta", label: "Resolution", bytes: 64, run() { const t = doc.dpi; doc.dpi = this.other; this.other = t; ed.scheduleStatus(); }, other: was }); ed.changed(); ed.scheduleStatus(); }
          return true;
        }
        ed.docOp("Image size", () => engine.resample(p.w, p.h, { dpi: d }));
        return true;
      },
    });
  }

  function amountDialog(title, label, value, max, run, unit = "px") {
    let v = value;
    const out = h("span", { class: "pt-num", text: `${v} ${unit}` });
    const range = h("input", { class: "pt-range", type: "range", min: 1, max, step: 1, value: v, oninput: (e) => { v = Number(e.target.value); out.textContent = `${v} ${unit}`; } });
    dialog(title, [h("label", { class: "pt-field" }, h("span", { text: label }), range, out)], { ok: title.replace(/…$/, ""), onOk: () => { run(v); ed.afterSelect(); return true; } });
  }

  const featherDialog = () => {
    if (!engine.selection) return toast("Select something first", { ms: 1800 });
    amountDialog("Feather", "Softness", 12, 250, (v) => engine.featherSelection(v));
  };

  function setBackground(value) {
    if (doc.background === value) return;
    const step = { kind: "meta", label: "Background", bytes: 64, other: doc.background, run() { const t = doc.background; doc.background = this.other; this.other = t; engine.allDirty = true; ed.invalidate(); } };
    doc.background = value;
    ed.history.push(step);
    engine.allDirty = true;
    ed.changed();
    ed.invalidate();
  }

  /* ── menus ──────────────────────────────────────────────────────────── */

  // a menu shown - or, while the quick actions gather them, its rows only
  let collecting = null;
  const showMenu = (items, opts) => (collecting ? collecting.push(...items) : menu(0, 0, items, opts));
  /** Every row of the Image, Select and Filter menus, for the quick actions: { label, run, group }. */
  function allActions() {
    // every adjustment layer, by its name: "levels", "curves", "hue"…
    const out = A.ADJUSTMENTS.filter((x) => x && x.id && x.name).map((x) => ({ label: `Adjustment › ${x.name}`, run: () => quickAdjust(x.id), group: "Adjust" }));
    for (const [group, fn] of [["Image", imageMenu], ["Select", selectMenu], ["Filter", filterMenu]]) {
      collecting = [];
      try { fn(null); } catch {}
      const flat = (list, pre) => { for (const it of list) { if (!it || typeof it !== "object" || it.header || it.el) continue; if (it.sub) flat(it.sub, (pre ? pre + " › " : "") + it.label.replace(/…$/, "")); else if (it.run && !it.disabled) out.push({ label: (pre ? pre + " › " : "") + it.label, run: it.run, group, keys: it.keys }); } };
      flat(collecting, "");
      collecting = null;
    }
    return out;
  }
  /** Select › Subject: the background found from the picture's edges, and the rest selected. */
  function selectSubject() {
    const px = engine.readPixels();
    const res = subjectMask(px.data, px.width, px.height);
    if (!res.count || res.count > px.width * px.height * 0.97) return toast("No subject stood out from the background - try the wand or the lasso", { ms: 3200 });
    engine.selectBytes(res.mask, px.width, px.height, "replace");
    ed.afterSelect();
    toast("Subject selected - from the background around it; refine with Shift / Alt and the wand or lasso", { ms: 3000 });
  }

  function imageMenu(anchor) {
    const ro = ed.readOnly;
    showMenu([
      { label: "Image size…", icon: "expand", run: imageSizeDialog },
      { label: "Canvas size…", icon: "square", run: canvasSizeDialog },
      { label: "Crop", icon: "scissors", keys: "C", run: () => ed.setTool("crop") },
      engine.selection ? { label: "Crop to the selection", icon: "scissors", run: () => { const b = engine.selection.box; ed.docOp("Crop", () => engine.cropTo(b)); } } : null,
      { label: "Trim to what is drawn", icon: "shrink", run: () => { const b = engine.contentBox(); if (!b) return toast("There is nothing drawn to trim to", { ms: 2200 }); ed.docOp("Trim", () => engine.cropTo(b)); } },
      "sep",
      { label: "Turn 90° clockwise", icon: "rotateRight", run: () => ed.docOp("Turn", () => engine.turn(1)) },
      { label: "Turn 90° anticlockwise", icon: "rotateLeft", run: () => ed.docOp("Turn", () => engine.turn(3)) },
      { label: "Turn 180°", icon: "rotateRight", run: () => ed.docOp("Turn", () => engine.turn(2)) },
      { label: "Flip left to right", icon: "flipH", run: () => ed.docOp("Flip", () => engine.turn(0, "h")) },
      { label: "Flip top to bottom", icon: "flipV", run: () => ed.docOp("Flip", () => engine.turn(0, "v")) },
      "sep",
      { label: "Place a picture from the vault…", icon: "image", run: placePicture },
      { label: "Cut out the subject (remove the background)…", icon: "sparkles", run: backgroundDialog },
      "sep",
      { header: "Paper" },
      { label: "Transparent", checked: !doc.background, run: () => setBackground(null) },
      { label: "White", swatch: "#ffffff", checked: doc.background === "#ffffff", run: () => setBackground("#ffffff") },
      { label: "Black", swatch: "#000000", checked: doc.background === "#000000", run: () => setBackground("#000000") },
      { label: "The current colour", swatch: ed.colour, run: () => setBackground(ed.colour) },
    ].filter((it) => it && !(ro && it.run && !it.header)), { anchor });
  }

  function selectMenu(anchor) {
    const sel = !!engine.selection;
    const l = ed.layer();
    showMenu([
      { label: "All", keys: "Ctrl+A", run: ed.selectAll },
      { label: "Subject", run: selectSubject },
      { label: "Deselect", keys: "Ctrl+D", run: ed.deselect },
      { label: "Invert", keys: "Ctrl+Shift+I", run: () => { engine.invertSelection(); ed.afterSelect(); } },
      "sep",
      l && D.hasPixels(l) ? { label: "What this layer has paint on", icon: "target", keys: "Ctrl+click", run: () => { engine.selectSurface(l.id); ed.afterSelect(); } } : null,
      l && l.mask ? { label: "What this layer's mask shows", icon: "circleShape", run: () => { engine.selectSurface(D.maskKey(l.id)); ed.afterSelect(); } } : null,
      { label: "A colour, everywhere in the picture…", icon: "palette", run: () => { ed.setTool("wand"); root.__leopaint.api.setOption("wandContiguous", false); toast("Click a colour: every pixel like it is selected. Tolerance is in the bar above.", { ms: 4200 }); } },
      "sep",
      sel ? { label: "Feather…", run: featherDialog } : null,
      sel ? { label: "Grow…", run: () => amountDialog("Grow", "By", 4, 200, (v) => engine.growSelection(v)) } : null,
      sel ? { label: "Shrink…", run: () => amountDialog("Shrink", "By", 4, 200, (v) => engine.growSelection(-v)) } : null,
      sel ? "sep" : null,
      sel ? { label: "Fill with the colour", icon: "palette", run: () => ed.landed("Fill selection", engine.fillArea(ed.targetKey(), ed.colour)) } : null,
      sel ? { label: "Clear what is inside", icon: "x", keys: "Delete", run: () => ed.landed("Clear", engine.clearArea(ed.targetKey())) } : null,
      sel ? { label: "Mask this layer to it", icon: "circleShape", run: () => ed.addMask(ed.selectedId, "selection") } : null,
      sel ? { label: "Mask this layer to everything else", icon: "circleShape", run: () => ed.addMask(ed.selectedId, "selection-out") } : null,
    ], { anchor });
  }

  function filterMenu(anchor) {
    showMenu([
      ...A.FILTERS.map((f) => ({ label: f.name + "…", run: () => filterDialog(f) })),
      { header: "Straight onto this layer's pixels" },
      { label: "Auto contrast", run: () => bake("Auto contrast", (px) => A.autoLevels(A.histogram(px))) },
      { label: "Auto colour", run: () => bake("Auto colour", (px) => A.autoLevels(A.histogram(px), { perChannel: true })) },
      { label: "Desaturate", run: () => bake("Desaturate", () => ({ type: "hsl", hue: 0, saturation: -100, lightness: 0 })) },
      { label: "Invert", run: () => bake("Invert", () => ({ type: "invert" })) },
      { header: "For something you can change later, add an adjustment layer instead", plain: true },
    ], { anchor });
  }

  /** The surface a filter can run on, or null (with the reason said). */
  function filterTarget() {
    const l = ed.layer();
    if (ed.readOnly || !l) return null;
    if (l.locked) { toast(`${l.name} is locked`, { ms: 1800 }); return null; }
    const key = ed.targetKey();
    if (!engine.surface(key) || (key === l.id && l.kind !== "raster")) {
      toast(l.kind === "text" ? "Rasterise the text first: a filter needs pixels." : "Filters work on a layer of pixels. Pick one in the layer list.", { ms: 3600 });
      return null;
    }
    return key;
  }

  /** An adjustment baked into a layer's own pixels, for good. */
  function bake(label, makeAdjust) {
    const key = filterTarget();
    if (!key) return;
    const bm = engine.surface(key);
    const small = makeCanvas(Math.min(512, doc.width), Math.min(512, doc.height));
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(bm.canvas, 0, 0, small.width, small.height);
    const adj = makeAdjust(sctx.getImageData(0, 0, small.width, small.height).data);
    releaseCanvas(small);
    const f = adjustFilter(adj);
    if (!f) return toast("Nothing to change: it is already there", { ms: 2000 });
    ed.landed(label, engine.filterSurface(key, (ctx, src) => { ctx.filter = f; ctx.drawImage(src, 0, 0); }));
  }

  /* ── pixel filters ──────────────────────────────────────────────────── */

  /** A copy with its edges repeated outwards, so a blur does not fade to nothing at the border. */
  function padded(src, pad) {
    const W = src.width;
    const H = src.height;
    const c = makeCanvas(W + pad * 2, H + pad * 2);
    const g = c.getContext("2d");
    g.drawImage(src, pad, pad);
    g.drawImage(src, 0, 0, W, 1, pad, 0, W, pad);
    g.drawImage(src, 0, H - 1, W, 1, pad, H + pad, W, pad);
    g.drawImage(src, 0, 0, 1, H, 0, pad, pad, H);
    g.drawImage(src, W - 1, 0, 1, H, W + pad, pad, pad, H);
    g.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
    g.drawImage(src, W - 1, 0, 1, 1, W + pad, 0, pad, pad);
    g.drawImage(src, 0, H - 1, 1, 1, 0, H + pad, pad, pad);
    g.drawImage(src, W - 1, H - 1, 1, 1, W + pad, H + pad, pad, pad);
    return c;
  }

  let noiseTile = null;
  function noise(mono) {
    const key = mono ? "m" : "c";
    if (noiseTile && noiseTile.key === key) return noiseTile.canvas;
    const c = makeCanvas(256, 256);
    const g = c.getContext("2d");
    const img = g.createImageData(256, 256);
    const r = () => (Math.random() + Math.random() + Math.random()) / 3; // bell-shaped round mid grey
    for (let p = 0; p < img.data.length; p += 4) {
      const v = Math.round(r() * 255);
      img.data[p] = v;
      img.data[p + 1] = mono ? v : Math.round(r() * 255);
      img.data[p + 2] = mono ? v : Math.round(r() * 255);
      img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    noiseTile = { key, canvas: c };
    return c;
  }

  /** Something drawn over the layer, but only where the layer has paint. */
  function overlay(ctx, src, W, H, op, alpha, paint) {
    const t = makeCanvas(W, H);
    const g = t.getContext("2d");
    paint(g);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha = alpha;
    ctx.drawImage(t, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    releaseCanvas(t);
  }

  const FILTER_DRAW = {
    blur(ctx, src, W, H, p) {
      if (!(p.radius > 0)) return ctx.drawImage(src, 0, 0);
      const pad = Math.ceil(p.radius * 3);
      const big = padded(src, pad);
      ctx.filter = `blur(${p.radius}px)`;
      ctx.drawImage(big, -pad, -pad);
      ctx.filter = "none";
      releaseCanvas(big);
    },
    sharpen(ctx, src, W, H, p) {
      const pad = Math.ceil(p.radius * 3) + 2;
      const big = padded(src, pad);
      ctx.filter = svgFilter(`sharpen:${p.amount}:${p.radius}`, A.sharpenMarkup(p.amount, p.radius), { pad: true });
      ctx.drawImage(big, -pad, -pad);
      ctx.filter = "none";
      releaseCanvas(big);
    },
    clarity(ctx, src, W, H, p) {
      const radius = clamp(Math.max(W, H) * 0.012, 6, 60);
      if (p.amount >= 0) return FILTER_DRAW.sharpen(ctx, src, W, H, { amount: p.amount * 0.7, radius });
      const pad = Math.ceil(radius * 3);
      const big = padded(src, pad);
      ctx.drawImage(src, 0, 0);
      ctx.globalAlpha = (-p.amount / 100) * 0.7;
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(big, -pad, -pad);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      releaseCanvas(big);
    },
    noise(ctx, src, W, H, p) {
      ctx.drawImage(src, 0, 0);
      if (!(p.amount > 0)) return;
      overlay(ctx, src, W, H, "overlay", p.amount / 100, (g) => { g.fillStyle = g.createPattern(noise(p.mono >= 0.5), "repeat"); g.fillRect(0, 0, W, H); });
    },
    pixelate(ctx, src, W, H, p) {
      const size = Math.max(2, Math.round(p.size));
      const small = makeCanvas(Math.ceil(W / size), Math.ceil(H / size));
      const g = small.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(src, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width * size, small.height * size);
      ctx.imageSmoothingEnabled = true;
      releaseCanvas(small);
    },
    vignette(ctx, src, W, H, p) {
      ctx.drawImage(src, 0, 0);
      if (!p.amount) return;
      const dark = p.amount > 0;
      overlay(ctx, src, W, H, dark ? "multiply" : "screen", Math.abs(p.amount) / 100, (g) => {
        const r = Math.hypot(W, H) / 2;
        const grad = g.createRadialGradient(W / 2, H / 2, r * (p.size / 100) * 0.55, W / 2, H / 2, r);
        const c = dark ? "0,0,0" : "255,255,255";
        grad.addColorStop(0, `rgba(${c},0)`);
        grad.addColorStop(1, `rgba(${c},1)`);
        // multiply needs white where nothing should change, screen needs black
        g.fillStyle = dark ? "#fff" : "#000";
        g.fillRect(0, 0, W, H);
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      });
    },
    glow(ctx, src, W, H, p) {
      ctx.drawImage(src, 0, 0);
      if (!(p.amount > 0)) return;
      const pad = Math.ceil(p.radius * 3);
      const big = padded(src, pad);
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = p.amount / 100;
      ctx.filter = `blur(${p.radius}px)`;
      ctx.drawImage(big, -pad, -pad);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      releaseCanvas(big);
    },
  };

  function filterDialog(f) {
    const key = filterTarget();
    if (!key) return;
    if (engine.floating) ed.commitFloat();
    const bm = engine.surface(key);
    const orig = makeCanvas(doc.width, doc.height);
    orig.getContext("2d").drawImage(bm.canvas, 0, 0);
    const params = { ...f.defaults };
    let show = true;
    let raf = 0;
    const draw = (ctx, src, W, H) => FILTER_DRAW[f.id](ctx, src, W, H, params);
    const restore = () => { bm.ctx.save(); bm.ctx.globalCompositeOperation = "copy"; bm.ctx.drawImage(orig, 0, 0); bm.ctx.restore(); engine.allDirty = true; ed.invalidate(); };
    const preview = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!show) return restore();
        engine.filterSurface(key, draw, { from: orig, record: false });
        ed.invalidate();
      });
    };
    modal = "filter";
    const done = () => { modal = null; if (raf) cancelAnimationFrame(raf); releaseCanvas(orig); ed.thumbSoon(); };
    dialog(f.name, [
      ...f.params.map(([k, label, min, max, step, unit]) => (max === 1 && step === 1
        ? h("label", { class: "pt-check" }, h("input", { type: "checkbox", checked: params[k] >= 0.5, onchange: (e) => { params[k] = e.target.checked ? 1 : 0; preview(); } }), h("span", { text: label }))
        : slider(label, params[k], min, max, step, (v) => { params[k] = v; preview(); }, (v) => `${Math.round(v * 10) / 10}${unit ? " " + unit : ""}`))),
      h("label", { class: "pt-check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { show = e.target.checked; preview(); } }), h("span", { text: "Preview" })),
      engine.selection ? h("p", { class: "pt-dlg-info", text: "Only inside the selection." }) : null,
    ], {
      side: true,
      onOk: () => { ed.landed(f.name, engine.filterSurface(key, draw, { from: orig, record: true })); done(); return true; },
      onCancel: () => { restore(); done(); },
    });
    preview();
  }

  /* ── background removal ─────────────────────────────────────────────── */

  function backgroundDialog() {
    const l = ed.layer();
    if (ed.readOnly || !l) return;
    if (!D.hasPixels(l) || l.kind === "text") return toast("Pick the layer with the photo on it first", { ms: 2600 });
    if (engine.floating) ed.commitFloat();
    const id = l.id;
    const before = ed.layerSnapshot();
    const hadMask = !!l.mask;
    const maskBefore = hadMask ? engine.snapshotLayer(D.maskKey(id)) : null;
    if (!hadMask) { engine.addMask(id); engine.fillMask(id, "reveal"); l.mask = true; l.maskOn = true; }
    const px = engine.readPixels({ layerId: id, scale: Math.min(1, 1600 / Math.max(doc.width, doc.height)) });
    const found = dominantColours(borderSamples(px.data, px.width, px.height), 4).filter((c) => c.share > 0.04);
    let colours = found.slice(0, 3).map((c) => c.rgb);
    const opt = { tolerance: 0.12, softness: 0.05, holes: true };
    let raf = 0;
    let last = null;
    modal = "background";

    const info = h("p", { class: "pt-dlg-info" });
    const chips = h("div", { class: "pt-bg-chips" });
    const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const run = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        last = removeBackground(px.data, px.width, px.height, { ...opt, colours });
        engine.setMaskFromBytes(id, last.mask, px.width, px.height, { record: false });
        info.textContent = colours.length
          ? `${Math.round((last.removed / (px.width * px.height)) * 100)}% of the layer is hidden. It is a mask: nothing is deleted, and you can paint any of it back.`
          : "Add a colour to remove.";
        ed.invalidate();
      });
    };
    const drawChips = () => {
      fill(chips, ...colours.map((c, i) => h("button", { class: "pt-bg-chip", style: `background:${hex(c)}`, title: `${hex(c)} · click to stop removing this colour`, onclick: () => { colours = colours.filter((_, k) => k !== i); drawChips(); run(); } }, icon("x"))),
        h("label", { class: "pt-bg-chip is-add", title: "Remove another colour" }, icon("plus"),
          h("input", { type: "color", value: "#00ff00", onchange: (e) => { const n = parseInt(e.target.value.slice(1), 16); colours = [...colours, [(n >> 16) & 255, (n >> 8) & 255, n & 255]]; drawChips(); run(); } })));
    };
    const finish = () => { modal = null; if (raf) cancelAnimationFrame(raf); ed.thumbSoon(); };
    drawChips();
    dialog("Cut out the subject", [
      h("p", { class: "pt-dlg-lede", text: "Takes out whatever reaches in from the edges in these colours. Best on plain backgrounds — a studio wall, a product shot, a screenshot, line art. For a busy background, select the subject with the lasso and use Mask instead." }),
      h("div", { class: "pt-field" }, h("span", { text: "Background" }), chips),
      slider("Tolerance", opt.tolerance * 100, 1, 60, 1, (v) => { opt.tolerance = v / 100; run(); }, (v) => `${Math.round(v)}%`),
      slider("Soft edge", opt.softness * 100, 0, 30, 1, (v) => { opt.softness = v / 100; run(); }, (v) => `${Math.round(v)}%`),
      h("label", { class: "pt-check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { opt.holes = e.target.checked; run(); } }), h("span", { text: "Also take out enclosed gaps (between an arm and a body)" })),
      info,
    ], {
      side: true,
      ok: "Keep this cut-out",
      onOk: () => {
        const steps = [];
        if (maskBefore) steps.push(pixelStep("Cut out", D.maskKey(id), 0, 0, doc.width, doc.height, maskBefore.before, (k, x, y, w, hh, data) => { const was = engine.swapRegion(k, x, y, w, hh, data); ed.invalidate(); ed.thumbSoon(); return was; }));
        steps.push(metaStep("Cut out", before, ed.layerSnapshot(), ed.restoreLayers));
        ed.history.push(steps.length > 1 ? groupStep("Cut out the subject", steps) : steps[0]);
        ed.changed();
        ed.renderLayers();
        finish();
        toast("Cut out. Click the mask next to the layer to paint any of it back (white shows, black hides).", { ms: 5200 });
        return true;
      },
      onCancel: () => {
        if (maskBefore) engine.swapRegion(D.maskKey(id), 0, 0, doc.width, doc.height, maskBefore.before);
        else { const cur = D.layerOf(doc, id); if (cur) cur.mask = false; engine.dropMask(id); }
        engine.allDirty = true;
        ed.renderLayers();
        ed.invalidate();
        finish();
      },
    });
    ed.renderLayers();
    run();
  }

  /* ── placing pictures ───────────────────────────────────────────────── */

  async function placeImage(img, name) {
    if (ed.readOnly || !ed.roomFor()) return;
    if (engine.floating) ed.commitFloat();
    const w = img.naturalWidth || img.width;
    const hh = img.naturalHeight || img.height;
    if (!w || !hh) return toast("That picture has no size", { kind: "error" });
    ed.structural("Add picture", () => {
      const l = D.newLayer({ name: String(name || "Picture").slice(0, 80) });
      ed.insertAbove(l);
      engine.addLayerBitmap(l.id);
    });
    // no bigger than the canvas to begin with; the handles take it from there
    const scale = Math.min(1, doc.width / w, doc.height / hh);
    const f = engine.floatImage(ed.selectedId, img, { scale });
    if (f) f.placed = true;
    ed.startPlacing();
    toast("Drag to place it · corners resize · Enter when it is right", { ms: 3600 });
  }

  async function placePicture() {
    const { libraryDialog } = await import("./paintexport.js");
    const path = await libraryDialog(app, { pick: true });
    if (!path) return;
    try {
      const img = await S.loadVaultImage(app, path);
      await placeImage(img, path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""));
    } catch (e) {
      toast(String(e && e.message ? e.message : e), { kind: "error" });
    }
  }

  // Ctrl+V with a picture on the clipboard drops it in as a new layer
  const onPaste = (e) => {
    if (destroyed || ed.readOnly || /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || "")) return;
    const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((it) => it.kind === "file" && /^image\//.test(it.type));
    if (!item) return;
    e.preventDefault();
    const url = URL.createObjectURL(item.getAsFile());
    const img = new Image();
    img.onload = () => { placeImage(img, "Pasted").finally(() => URL.revokeObjectURL(url)); };
    img.onerror = () => { URL.revokeObjectURL(url); toast("That could not be pasted as a picture", { kind: "error" }); };
    img.src = url;
  };
  root.addEventListener("paste", onPaste);

  /* ── export and the library ─────────────────────────────────────────── */

  const exportDialog = () => import("./paintexport.js").then((m) => m.exportDialog(ed));
  const quickExport = (format, scale, quality) => import("./paintexport.js").then((m) => m.quickExport(ed, format, scale, quality));
  const library = () => import("./paintexport.js").then((m) => m.libraryDialog(app, { current: ed.path }));

  return {
    allActions,
    selectSubject,
    render, adjustItems, quickAdjust, imageMenu, selectMenu, filterMenu, featherDialog,
    canvasSizeDialog, imageSizeDialog, backgroundDialog, filterDialog, placePicture, placeImage, autoFix,
    exportDialog, quickExport, library,
    busy: () => !!modal || !!pending,
    destroy() { destroyed = true; if (renderRaf) cancelAnimationFrame(renderRaf); root.removeEventListener("paste", onPaste); },
  };
}
