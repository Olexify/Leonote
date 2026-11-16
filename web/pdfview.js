// The reader: a continuous scroll of pages drawn by pdf.js.
//
// The rules that keep a 200-page file quick:
//   - only pages within a screen either side of the viewport are drawn, and a
//     page that scrolls away has its render task cancelled mid-flight;
//   - the layout is built from page one's size and corrected as real page
//     sizes arrive, so opening never waits on 200 `getPage` calls;
//   - rendered pixels are capped (pdfcore.evictCanvases) - the furthest
//     canvases are released first, and a page on screen is never released;
//   - text layers and thumbnails follow the same come-and-go rule.
//
// Everything pdf.js gives back is treated as a cancellable promise: `gen`
// guards each async step so a scroll or a reload cannot paint a stale page.

import { h } from "./util.js";
import { visibleRange, currentPage, evictCanvases, fitScale, clampScale, CANVAS_PIXEL_BUDGET, normDeg } from "./pdfcore.js";

let pdfjsP = null;
let PJ = null; // the loaded module, for the places that cannot await
/** pdf.js, and its worker, loaded the first time a PDF is opened. */
export async function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import("pdfjs-dist/build/pdf.min.mjs").then((mod) => {
      const base = document.baseURI || location.href;
      mod.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.mjs", base).href;
      PJ = mod;
      return mod;
    });
  }
  return pdfjsP;
}

const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const MAX_SIDE = 4096;

export async function openDocument(bytes, { password } = {}) {
  const pj = await pdfjs();
  const base = document.baseURI || location.href;
  const task = pj.getDocument({
    // pdf.js takes the buffer over to its worker, so it must get its own copy
    data: bytes.slice(),
    cMapUrl: new URL("cmaps/", base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", base).href,
    wasmUrl: new URL("pdfdecoders/", base).href,
    useWasm: false,
    password,
    isEvalSupported: false,
    enableXfa: false,
    fontExtraProperties: true, // the fonts' own data stays at hand: a retyped line keeps the page's font
  });
  try {
    return await task.promise;
  } catch (e) {
    const name = e && e.name;
    if (name === "PasswordException") throw Object.assign(new Error("This PDF is password-protected."), { code: "encrypted" });
    if (name === "InvalidPDFException") throw Object.assign(new Error("This file is damaged, or is not a PDF inside."), { code: "damaged" });
    throw e;
  }
}

/**
 * @param {HTMLElement} host
 * @param {object} opts  { onPage, onLayout, onZoom, onReady }
 */
export function mountPdfView(host, opts = {}) {
  const scroll = h("div", { class: "pdfv-scroll", tabIndex: 0 });
  const stack = h("div", { class: "pdfv-pages" });
  scroll.append(stack);
  host.append(scroll);

  let doc = null;
  let gen = 0;               // bumped on every reload: stale work checks it
  let slots = [];            // { el, canvas, text, annot, find, vp, w, h, task, textTask, size }
  let scaleMode = "width";
  let scale = 1;            // the current page's scale, for the zoom readout
  let formMode = false;     // leave widgets off the canvas; we draw them live
  let spin = 0;              // view-only turn, on top of each page's own
  let tops = [], heights = [];
  let pixels = new Map();
  let raf = 0;
  let at = 0;
  const textCache = new Map();
  const GAP = 16;

  const count = () => slots.length;

  function clearSlots() {
    for (const s of slots) {
      try { s.task && s.task.cancel(); } catch {}
      try { s.textTask && s.textTask.cancel(); } catch {}
    }
    slots = [];
    pixels.clear();
    stack.replaceChildren();
  }

  /** Lay a fresh document out from page one's size, then correct as we learn. */
  async function build(d) {
    const mine = ++gen;
    clearSlots();
    textCache.clear();
    doc = d;
    const first = await d.getPage(1);
    if (mine !== gen) return;
    const base = first.getViewport({ scale: 1, rotation: normDeg(first.rotate + spin) });
    slots = Array.from({ length: d.numPages }, (_, i) => {
      const el = h("div", { class: "pdfv-page", dataset: { page: String(i + 1) } },
        h("div", { class: "pdfv-num", text: String(i + 1) }));
      const s = { i, el, canvas: null, text: null, annot: null, find: null, vp: null, task: null, textTask: null, w: base.width, h: base.height, sized: i === 0, page: null };
      stack.append(el);
      return s;
    });
    slots[0].w = base.width; slots[0].h = base.height;
    slots[0].page = first;
    relayout();
    opts.onReady && opts.onReady(d);
    schedule();
    // fill in the true sizes in the background; most documents never move
    measure(mine);
  }

  const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 60 }) : setTimeout(r, 1)));

  async function measure(mine) {
    for (let i = 1; i < slots.length; i++) {
      if (mine !== gen) return;
      if (slots[i].sized) continue;
      // a page the reader is nowhere near can wait for an idle moment
      if (i > at + 40) await idle();
      if (mine !== gen) return;
      try {
        const p = await doc.getPage(i + 1);
        if (mine !== gen) return;
        const vp = p.getViewport({ scale: 1, rotation: normDeg(p.rotate + spin) });
        const s = slots[i];
        s.page = p;
        s.sized = true;
        if (Math.abs(vp.width - s.w) > 0.5 || Math.abs(vp.height - s.h) > 0.5) {
          s.w = vp.width; s.h = vp.height;
          relayout(i);
        }
      } catch { slots[i] && (slots[i].sized = true); }
    }
  }

  /**
   * Size every page box, keeping the reader's place. "Fit width" and "Whole
   * page" are worked out per page rather than once for the document: one
   * landscape page in a portrait report must not shrink the other 199.
   */
  function relayout(changedFrom = -1) {
    if (!slots.length) return;
    const keepTop = scroll.scrollTop;
    const anchor = changedFrom >= 0 ? tops[changedFrom] : null;
    tops = []; heights = [];
    let y = GAP;
    for (const s of slots) {
      s.scale = fitScale(scaleMode, s.w, s.h, scroll.clientWidth, scroll.clientHeight, 40);
      const w = Math.round(s.w * s.scale), hh = Math.round(s.h * s.scale);
      s.el.style.width = w + "px";
      s.el.style.height = hh + "px";
      s.el.style.setProperty("--total-scale-factor", String(s.scale));
      tops.push(y); heights.push(hh);
      y += hh + GAP;
      if (s.page) s.vp = s.page.getViewport({ scale: s.scale, rotation: normDeg(s.page.rotate + spin) });
      if (s.canvas && (s.cw !== w || s.ch !== hh)) drop(s);
    }
    scale = slots[Math.min(at, slots.length - 1)].scale;
    if (anchor != null && tops[changedFrom] != null && tops[changedFrom] < keepTop) {
      scroll.scrollTop = keepTop + (tops[changedFrom] - anchor);
    }
    opts.onLayout && opts.onLayout();
  }

  function drop(s) {
    try { s.task && s.task.cancel(); } catch {}
    s.task = null;
    if (s.canvas) { s.canvas.remove(); s.canvas = null; }
    if (s.text) { try { s.textTask && s.textTask.cancel(); } catch {} s.text.remove(); s.text = null; s.textTask = null; }
    pixels.delete(s.i);
    s.el.classList.remove("is-drawn");
  }

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; update(); });
  };

  function update() {
    if (!slots.length) return;
    const [a, b] = visibleRange(tops, heights, scroll.scrollTop, scroll.clientHeight, 0.6);
    const now = currentPage(tops, heights, scroll.scrollTop, scroll.clientHeight);
    if (now !== at) { at = now; opts.onPage && opts.onPage(now); }
    for (let i = a; i <= b; i++) draw(slots[i]);
    // scrolled well away: its decoded pictures and fonts go too (pdf.js keeps them until told), so a long scanned PDF
    // does not pile up - any page drawn since, whatever took its canvas (the budget, a zoom); not the pages on screen
    for (const s of slots) if ((s.i < a - 2 || s.i > b + 2) && (s.canvas || s.used)) { drop(s); s.used = false; try { s.page && s.page.cleanup(); } catch {} }
    for (const i of evictCanvases(pixels, a, b, CANVAS_PIXEL_BUDGET)) drop(slots[i]);
  }

  async function draw(s) {
    if (!s || s.task || s.canvas) return;
    s.used = true;
    const mine = gen;
    const dpr = DPR();
    const k = s.scale || scale;
    const w = Math.round(s.w * k), hh = Math.round(s.h * k);
    const px = Math.min(dpr, MAX_SIDE / Math.max(w, hh, 1));
    const canvas = h("canvas", { class: "pdfv-canvas" });
    canvas.width = Math.max(1, Math.round(w * px));
    canvas.height = Math.max(1, Math.round(hh * px));
    canvas.style.width = w + "px";
    canvas.style.height = hh + "px";
    s.canvas = canvas; s.cw = w; s.ch = hh;
    s.el.prepend(canvas);
    pixels.set(s.i, canvas.width * canvas.height);
    try {
      const page = s.page || (s.page = await doc.getPage(s.i + 1));
      if (mine !== gen || s.canvas !== canvas) return;
      const vp = page.getViewport({ scale: k * px, rotation: normDeg(page.rotate + spin) });
      s.vp = page.getViewport({ scale: k, rotation: normDeg(page.rotate + spin) });
      const task = page.render({
        canvasContext: canvas.getContext("2d", { alpha: false }),
        viewport: vp,
        background: "#ffffff",
        // With live form controls over the page, the widgets must NOT also be
        // painted into the canvas - otherwise every filled field shows its
        // value twice, once from the PDF and once from the input on top.
        annotationMode: formMode && PJ ? PJ.AnnotationMode.ENABLE_FORMS : undefined,
      });
      s.task = task;
      await task.promise;
      if (mine !== gen || s.canvas !== canvas) return;
      s.task = null;
      s.el.classList.add("is-drawn");
      layers(s, page);
      opts.onLayout && opts.onLayout(s.i);
    } catch (e) {
      s.task = null;
      if (e && e.name === "RenderingCancelledException") return;
      if (mine === gen) s.el.classList.add("is-broken");
    }
  }

  /** Text for selection, plus the two empty layers the editors draw into. */
  async function layers(s, page) {
    if (!s.annot) {
      s.annot = h("div", { class: "pdfv-annot" });
      s.find = h("div", { class: "pdfv-find" });
      s.form = h("div", { class: "pdfv-form" });
      s.el.append(s.find, s.form, s.annot);
    }
    if (s.text) return;
    const mine = gen;
    const pj = await pdfjs();
    if (mine !== gen || !s.canvas) return;
    const div = h("div", { class: "textLayer pdfv-text" });
    s.el.insertBefore(div, s.find);
    s.text = div;
    try {
      const tl = new pj.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: false, disableNormalization: true }), container: div, viewport: s.vp });
      s.textTask = tl;
      await tl.render();
    } catch { /* a page with no text, or a cancelled layer */ }
  }

  scroll.addEventListener("scroll", schedule, { passive: true });
  const ro = new ResizeObserver(() => { relayout(); schedule(); });
  ro.observe(scroll);

  // ── text, for search and for "extract to a note" ──────────────────────────
  async function pageText(i) {
    if (textCache.has(i)) return textCache.get(i);
    const p = (async () => {
      const page = await doc.getPage(i + 1);
      const tc = await page.getTextContent({ disableNormalization: false });
      const items = tc.items.filter((it) => typeof it.str === "string");
      let text = "";
      const spans = [];
      for (const it of items) {
        spans.push({ at: text.length, len: it.str.length, it });
        text += it.str;
        if (it.hasEOL) text += "\n";
      }
      return { text, spans, styles: tc.styles || {} };
    })();
    textCache.set(i, p);
    return p;
  }

  return {
    get doc() { return doc; },
    get pageCount() { return count(); },
    get page() { return at; },
    get scale() { return scale; },
    get scaleMode() { return scaleMode; },
    get spin() { return spin; },
    get scrollEl() { return scroll; },
    slotOf: (i) => slots[i],
    /** The overlay an annotation editor draws into, once the page is drawn. */
    annotLayer: (i) => slots[i] && slots[i].annot,
    findLayer: (i) => slots[i] && slots[i].find,
    formLayer: (i) => slots[i] && slots[i].form,
    viewportOf: (i) => slots[i] && slots[i].vp,
    pageText,
    /** A font of page i as a family of its own that outlives this copy of the document (null when it cannot be had). */
    async keepFont(i, name) {
      try {
        const page = await doc.getPage(i + 1);
        const f = page.commonObjs.get(name);
        if (!f || !f.data) return null;
        const d = f.data;
        let hsh = d.length;
        for (let k = 0; k < d.length; k += 97) hsh = (hsh * 31 + d[k]) | 0;
        const fam = "leo-pdf-" + (hsh >>> 0).toString(36);
        if (![...document.fonts].some((x) => x.family === fam)) {
          const face = new FontFace(fam, d.slice().buffer);
          await face.load();
          document.fonts.add(face);
        }
        return fam;
      } catch { return null; }
    },
    async open(d) { await build(d); },
    setScale(mode) {
      scaleMode = typeof mode === "number" ? clampScale(mode) : mode;
      const keep = at;
      for (const s of slots) drop(s);
      relayout();
      goTo(keep);
      schedule();
      opts.onZoom && opts.onZoom();
    },
    zoomBy(mul) { this.setScale(clampScale(scale * mul)); },
    /** Hand the form widgets over to the live overlay (or take them back). */
    setFormMode(on) {
      const v = !!on;
      if (v === formMode) return;
      formMode = v;
      for (const s of slots) drop(s);
      schedule();
    },
    setSpin(deg) {
      spin = normDeg(deg);
      for (const s of slots) { drop(s); s.sized = false; const p = s.page; if (p) { const vp = p.getViewport({ scale: 1, rotation: normDeg(p.rotate + spin) }); s.w = vp.width; s.h = vp.height; s.sized = true; } }
      relayout();
      schedule();
      opts.onZoom && opts.onZoom();
    },
    goTo,
    refresh: () => { for (const s of slots) drop(s); relayout(); schedule(); },
    invalidate: (i) => { const s = slots[i]; if (s) { drop(s); schedule(); } },
    destroy() {
      gen++;
      clearSlots();
      ro.disconnect();
      cancelAnimationFrame(raf);
      try { doc && doc.loadingTask.destroy(); } catch {}
      doc = null;
      host.replaceChildren();
    },
  };

  function goTo(i, { top = true } = {}) {
    const n = Math.max(0, Math.min(count() - 1, i));
    if (!tops.length) return;
    scroll.scrollTop = Math.max(0, tops[n] - (top ? GAP : 0));
    // `at` is deliberately left alone: the next update() works it out from the
    // new scroll position and tells the toolbar, which is the only place the
    // page number is kept. Setting it here made goTo look like a no-op.
    schedule();
  }
}

// ── search ──────────────────────────────────────────────────────────────────

const fold = (s) => s.toLowerCase().replace(/­/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");

/**
 * Every hit on one page, as rectangles in PDF points. Matching is done on the
 * page's text rather than on the DOM, so a page that is not drawn still
 * reports its hits and the count is right the moment the file opens.
 */
export function matchesOnPage({ text, spans }, query) {
  const q = fold(query);
  if (!q.trim()) return [];
  const hay = fold(text);
  const out = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(q, from);
    if (i < 0) break;
    out.push({ start: i, end: i + q.length, rects: rectsFor(spans, i, i + q.length) });
    from = i + Math.max(1, q.length);
    if (out.length > 500) break;
  }
  return out;
}

function rectsFor(spans, a, b) {
  const rects = [];
  for (const s of spans) {
    const sa = s.at, sb = s.at + s.len;
    if (sb <= a || sa >= b) continue;
    const it = s.it;
    const t = it.transform;
    if (!t) continue;
    const x = t[4], y = t[5];
    const w = it.width || 0, hh = it.height || Math.abs(t[3]) || 10;
    const from = Math.max(0, a - sa) / Math.max(1, s.len);
    const to = Math.min(s.len, b - sa) / Math.max(1, s.len);
    rects.push({ x: x + w * from, y: y - hh * 0.2, w: Math.max(1, w * (to - from)), h: hh * 1.2 });
  }
  return rects;
}
