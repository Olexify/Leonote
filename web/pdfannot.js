// Marking up a PDF, without touching the file until it is saved.
//
// Everything drawn lives in a plain record (pdfcore.packAnnot) in page points,
// and is painted over each page as SVG - so zooming, turning the view or
// reordering pages costs nothing and nothing is ever burnt into the page. On
// save, pdfdoc.writeAnnots turns the records into real PDF annotations.
//
// Coordinates: the model is always unrotated PDF user space, bottom-left
// origin. pdf.js's viewport does both conversions, so a view turned 90° needs
// no special case anywhere below.

import { h, keyOf } from "./util.js";
import { packAnnots, unpackAnnots, remapPages, rectsToQuads } from "./pdfcore.js";

const SVG = "http://www.w3.org/2000/svg";
const s = (tag, attrs) => {
  const el = document.createElementNS(SVG, tag);
  for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
  return el;
};
const MARKUP = new Set(["highlight", "underline", "strike"]);
const NOTE_PT = 22;

const id = () => (crypto.randomUUID ? crypto.randomUUID() : "a" + Math.random().toString(36).slice(2) + Date.now().toString(36));

/**
 * @param {object} view   the pdfview instance
 * @param {object} opts   { onChange, onSelect, author }
 */
export function createAnnots(view, opts = {}) {
  /** page index -> records */
  let byPage = new Map();
  let tool = null;
  let style = { color: "#e0a84a", width: 2, fontSize: 13, opacity: 1 };
  let stamp = null; // { image, w, h } - the signature, drawn once and reused
  let sel = null;   // { page, id }
  const undos = [];
  const redos = [];
  const changed = () => { opts.onChange && opts.onChange(); };

  const list = (i) => byPage.get(i) || [];
  const setList = (i, recs) => { recs.length ? byPage.set(i, recs) : byPage.delete(i); };

  // every step that changes a mark takes a snapshot first; going back puts
  // the state it left on the other stack, so Ctrl+Shift+Z brings it again
  function snap() {
    undos.push(JSON.stringify(packAnnots(byPage)));
    if (undos.length > 60) undos.shift();
    redos.length = 0;
  }

  function step(from, to) {
    if (!from.length) return false;
    to.push(JSON.stringify(packAnnots(byPage)));
    byPage = unpackAnnots(JSON.parse(from.pop()));
    sel = null;
    for (let i = 0; i < view.pageCount; i++) paint(i);
    changed();
    return true;
  }

  function add(i, rec) {
    snap();
    setList(i, [...list(i), { id: id(), author: opts.author || "", created: new Date().toISOString(), ...rec }]);
    paint(i);
    changed();
  }

  function remove(i, rid) {
    snap();
    setList(i, list(i).filter((a) => a.id !== rid));
    if (sel && sel.id === rid) sel = null;
    paint(i);
    changed();
  }

  function replace(i, rid, patch) {
    setList(i, list(i).map((a) => (a.id === rid ? { ...a, ...patch } : a)));
    paint(i);
    changed();
  }

  // ── painting ─────────────────────────────────────────────────────────────

  function paint(i) {
    const layer = view.annotLayer(i);
    const vp = view.viewportOf(i);
    if (!layer || !vp) return;
    const recs = list(i);
    layer.replaceChildren();
    if (!recs.length) return;
    const svg = s("svg", { class: "pdfa-svg", width: vp.width, height: vp.height, viewBox: `0 0 ${vp.width} ${vp.height}` });
    const html = [];
    for (const a of recs) {
      const node = shapeFor(a, vp);
      if (!node) continue;
      if (node.nodeType && node.namespaceURI === SVG) {
        node.setAttribute("data-id", a.id);
        node.classList.add("pdfa-shape");
        if (sel && sel.page === i && sel.id === a.id) node.classList.add("is-sel");
        svg.append(node);
      } else {
        node.dataset.id = a.id;
        node.classList.add("pdfa-shape", "pdfa-html");
        if (sel && sel.page === i && sel.id === a.id) node.classList.add("is-sel");
        if (editing && editing.page === i && editing.id === a.id && editing.node) {
          // the box being typed in: the node stays (with its focus and caret), only its place is refreshed
          for (const k of ["left", "top", "width", "minWidth", "minHeight", "fontSize", "lineHeight", "padding"]) if (node.style[k]) editing.node.style[k] = node.style[k];
          html.push(editing.node);
          continue;
        }
        html.push(node);
      }
    }
    layer.append(svg, ...html);
  }
  let editing = null; // { page, id, node } while a text box is being typed in

  /** The selection alone, as a class on the nodes already there - no rebuild, so a double-click still counts as one. */
  function paintSel() {
    for (const n of scroll.querySelectorAll(".pdfa-shape.is-sel")) n.classList.remove("is-sel");
    if (!sel) return;
    const layer = view.annotLayer(sel.page);
    if (!layer) return;
    for (const n of layer.querySelectorAll(".pdfa-shape")) if ((n.dataset.id || n.getAttribute("data-id")) === sel.id) n.classList.add("is-sel");
  }
  const paintAll = () => { for (let i = 0; i < view.pageCount; i++) if (byPage.has(i)) paint(i); };

  /** PDF rect -> a view-space box, whatever way the page is turned. */
  function box(vp, x, y, w, hh) {
    const [ax, ay] = vp.convertToViewportPoint(x, y);
    const [bx, by] = vp.convertToViewportPoint(x + w, y + hh);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }

  function shapeFor(a, vp) {
    const k = vp.scale;
    if (MARKUP.has(a.type)) {
      const g = s("g", { class: `pdfa-${a.type}`, fill: a.color, "fill-opacity": a.opacity });
      for (const q of a.quads) {
        const b = box(vp, q[0], q[1], q[2], q[3]);
        if (a.type === "highlight") g.append(s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 1 }));
        else {
          const t = Math.max(1, b.h * 0.07);
          const y = a.type === "underline" ? b.y + b.h * 0.92 : b.y + b.h * 0.52;
          g.append(s("rect", { x: b.x, y, width: b.w, height: t, rx: t / 2 }));
        }
      }
      return g;
    }
    if (a.type === "ink") {
      const g = s("g", { fill: "none", stroke: a.color, "stroke-opacity": a.opacity, "stroke-width": a.width * k, "stroke-linecap": "round", "stroke-linejoin": "round" });
      for (const st of a.strokes) {
        const pts = st.map((p) => vp.convertToViewportPoint(p[0], p[1]));
        if (pts.length === 1) g.append(s("circle", { cx: pts[0][0], cy: pts[0][1], r: (a.width * k) / 2, fill: a.color, stroke: "none" }));
        else g.append(s("polyline", { points: pts.map((p) => `${p[0]},${p[1]}`).join(" ") }));
      }
      return g;
    }
    if (a.type === "rect" || a.type === "ellipse") {
      const b = box(vp, ...a.rect);
      const common = { stroke: a.color, "stroke-opacity": a.opacity, "stroke-width": a.width * k, fill: a.fill || "none", "fill-opacity": a.fill ? a.opacity : 0 };
      return a.type === "rect"
        ? s("rect", { x: b.x, y: b.y, width: b.w, height: b.h, ...common })
        : s("ellipse", { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, ...common });
    }
    if (a.type === "arrow") {
      const [x, y, w, hh] = a.rect;
      const p0 = vp.convertToViewportPoint(x, y);
      const p1 = vp.convertToViewportPoint(x + w, y + hh);
      const g = s("g", { stroke: a.color, "stroke-opacity": a.opacity, "stroke-width": a.width * k, "stroke-linecap": "round", fill: a.color, "fill-opacity": a.opacity });
      g.append(s("line", { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] }));
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      const ux = (p1[0] - p0[0]) / len, uy = (p1[1] - p0[1]) / len;
      const head = Math.min(len * 0.4, (6 + a.width * 3) * k);
      const bx = p1[0] - ux * head, by = p1[1] - uy * head;
      const px = -uy * head * 0.42, py = ux * head * 0.42;
      g.append(s("polygon", { points: `${p1[0]},${p1[1]} ${bx + px},${by + py} ${bx - px},${by - py}`, stroke: "none" }));
      return g;
    }
    if (a.type === "stamp") {
      const b = box(vp, ...a.rect);
      return s("image", { x: b.x, y: b.y, width: b.w, height: b.h, opacity: a.opacity, href: a.image, preserveAspectRatio: "none" });
    }
    if (a.type === "note") {
      const b = box(vp, ...a.rect);
      const el = h("div", { class: "pdfa-note", style: { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px", background: a.color }, title: a.text || "Comment" });
      if (a.text) el.append(h("span", { class: "pdfa-note-dot" }));
      return el;
    }
    if (a.type === "text") {
      const b = box(vp, ...a.rect);
      return h("div", {
        class: "pdfa-text",
        style: a.burn
          ? { left: b.x + "px", top: b.y + "px", minWidth: b.w + "px", width: "auto", minHeight: b.h + "px", color: a.color, fontSize: (a.fontSize || 13) * k + "px", opacity: String(a.opacity), fontFamily: a.font || null, lineHeight: (a.fontSize || 13) * k + "px", padding: `${(3 + (a.fontSize || 13) * 0.15) * k}px ${4 * k}px 0`, whiteSpace: "pre" }
          : { left: b.x + "px", top: b.y + "px", width: b.w + "px", minHeight: b.h + "px", color: a.color, fontSize: (a.fontSize || 13) * k + "px", opacity: String(a.opacity), fontFamily: a.font || null },
        text: a.text || "",
      });
    }
    return null;
  }

  // ── pointer work ─────────────────────────────────────────────────────────

  const scroll = view.scrollEl;

  /** Which page a pointer event is over, and where in PDF points. */
  function hit(e) {
    const el = e.target.closest ? e.target.closest(".pdfv-page") : null;
    if (!el) return null;
    const i = Number(el.dataset.page) - 1;
    const vp = view.viewportOf(i);
    if (!vp) return null;
    const r = el.getBoundingClientRect();
    const [x, y] = vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
    return { i, vp, x, y, el };
  }

  let drag = null;

  function onDown(e) {
    if (e.button !== 0) return;
    const shape = e.target.closest && e.target.closest(".pdfa-shape");
    if (!tool) {
      if (!shape) { if (sel) { sel = null; paintSel(); } return; }
      const i = Number(shape.closest(".pdfv-page").dataset.page) - 1;
      const rid = shape.dataset.id;
      const was = sel;
      if (was && was.page === i && was.id === rid && shape.classList.contains("pdfa-text") && !shape.isContentEditable) {
        // a text box already selected: one more click opens it for typing
        const rec0 = list(i).find((a) => a.id === rid);
        if (rec0) { e.preventDefault(); editText(i, rec0, false, e); return; }
      }
      sel = { page: i, id: rid };
      paintSel();
      opts.onSelect && opts.onSelect(current());
      const rec = list(i).find((a) => a.id === rid);
      if (rec && rec.rect) {
        const at = hit(e);
        if (at) { drag = { kind: "move", i, rid, ox: at.x - rec.rect[0], oy: at.y - rec.rect[1] }; e.preventDefault(); }
      }
      if (rec && rec.type === "note") editNote(i, rec);
      return;
    }
    const at = hit(e);
    if (!at) return;
    e.preventDefault();
    if (tool === "note") { placeNote(at); return; }
    if (tool === "stamp") { placeStamp(at); return; }
    if (tool === "retype") { retype(e, at); return; }
    if (tool === "ink") {
      drag = { kind: "ink", i: at.i, pts: [[at.x, at.y]], vp: at.vp };
      preview(at.i, drag);
      return;
    }
    drag = { kind: "shape", i: at.i, x0: at.x, y0: at.y, x1: at.x, y1: at.y, vp: at.vp };
  }

  function onMove(e) {
    if (!drag) return;
    const at = hit(e);
    if (drag.kind === "move") {
      if (!at || at.i !== drag.i) return;
      const rec = list(drag.i).find((a) => a.id === drag.rid);
      if (!rec) return;
      if (!drag.snapped) { snap(); drag.snapped = true; }
      const r = rec.rect;
      replace(drag.i, drag.rid, { rect: [at.x - drag.ox, at.y - drag.oy, r[2], r[3]] });
      return;
    }
    if (!at || at.i !== drag.i) return;
    if (drag.kind === "ink") {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(at.x - last[0], at.y - last[1]) < 1.2) return;
      drag.pts.push([at.x, at.y]);
    } else {
      drag.x1 = at.x; drag.y1 = at.y;
    }
    preview(drag.i, drag);
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearPreview(d.i);
    if (d.kind === "move") { changed(); return; }
    if (d.kind === "ink") {
      if (d.pts.length < 1) return;
      add(d.i, { type: "ink", color: style.color, opacity: style.opacity, width: style.width, strokes: [d.pts] });
      return;
    }
    const w = d.x1 - d.x0, hh = d.y1 - d.y0;
    if (tool === "text") {
      const rect = Math.abs(w) < 20 || Math.abs(hh) < 12 ? [d.x0, d.y0 - 44, 220, 44] : norm(d.x0, d.y0, w, hh);
      const rec = { type: "text", color: style.color, opacity: 1, fontSize: style.fontSize, rect, text: "" };
      add(d.i, rec);
      const made = list(d.i)[list(d.i).length - 1];
      editText(d.i, made);
      return;
    }
    if (Math.abs(w) < 3 && Math.abs(hh) < 3) return;
    if (tool === "arrow") add(d.i, { type: "arrow", color: style.color, opacity: style.opacity, width: style.width, rect: [d.x0, d.y0, w, hh] });
    else add(d.i, { type: tool, color: style.color, opacity: style.opacity, width: style.width, fill: style.fill || null, rect: norm(d.x0, d.y0, w, hh) });
  }

  const norm = (x, y, w, hh) => [Math.min(x, x + w), Math.min(y, y + hh), Math.abs(w), Math.abs(hh)];

  function preview(i, d) {
    const layer = view.annotLayer(i);
    if (!layer) return;
    clearPreview(i);
    const vp = view.viewportOf(i);
    const rec = d.kind === "ink"
      ? { type: "ink", color: style.color, opacity: style.opacity, width: style.width, strokes: [d.pts] }
      : tool === "arrow"
        ? { type: "arrow", color: style.color, opacity: style.opacity, width: style.width, rect: [d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0] }
        : { type: tool === "text" ? "rect" : tool, color: style.color, opacity: style.opacity, width: tool === "text" ? 1 : style.width, rect: norm(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0) };
    const node = shapeFor(rec, vp);
    if (!node) return;
    const svg = s("svg", { class: "pdfa-svg pdfa-preview", width: vp.width, height: vp.height, viewBox: `0 0 ${vp.width} ${vp.height}` });
    svg.append(node);
    layer.append(svg);
  }

  const clearPreview = (i) => {
    const layer = view.annotLayer(i);
    if (layer) layer.querySelectorAll(".pdfa-preview").forEach((n) => n.remove());
  };

  // ── text selection -> highlight / underline / strike ──────────────────────

  function applyToSelection(kind) {
    const s0 = window.getSelection();
    if (!s0 || s0.isCollapsed || !s0.rangeCount) return 0;
    const range = s0.getRangeAt(0);
    if (!scroll.contains(range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode)) return 0;
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    // Which page a rectangle belongs to is worked out from the geometry, not
    // from elementFromPoint: text selected before the reader scrolled away is
    // off screen, and hit-testing an off-screen point answers nothing.
    const boxes = [...scroll.querySelectorAll(".pdfv-page")].map((el) => ({ el, i: Number(el.dataset.page) - 1, r: el.getBoundingClientRect() }));
    const per = new Map();
    for (const r of rects) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const box = boxes.find((b) => cx >= b.r.left && cx <= b.r.right && cy >= b.r.top && cy <= b.r.bottom);
      if (!box) continue;
      const { i, r: pr } = box;
      const vp = view.viewportOf(i);
      if (!vp) continue;
      const [ax, ay] = vp.convertToPdfPoint(r.left - pr.left, r.top - pr.top);
      const [bx, by] = vp.convertToPdfPoint(r.right - pr.left, r.bottom - pr.top);
      if (!per.has(i)) per.set(i, []);
      per.get(i).push({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
    }
    if (!per.size) return 0;
    snap();
    let n = 0;
    for (const [i, raw] of per) {
      // rectsToQuads throws away the hairlines a browser selection leaves at
      // line ends, which would otherwise become one-pixel marks in the file
      const quads = rectsToQuads(raw);
      if (!quads.length) continue;
      setList(i, [...list(i), { id: id(), type: kind, color: style.color, opacity: kind === "highlight" ? 0.42 : 1, quads, author: opts.author || "", created: new Date().toISOString() }]);
      paint(i);
      n += quads.length;
    }
    s0.removeAllRanges();
    changed();
    return n;
  }

  function onSelectionEnd() {
    if (!tool || !MARKUP.has(tool)) return;
    // let the browser finish the selection before reading it
    setTimeout(() => applyToSelection(tool), 0);
  }

  // ── notes and text boxes ─────────────────────────────────────────────────

  function placeNote(at) {
    add(at.i, { type: "note", color: style.color, opacity: 1, fontSize: style.fontSize, rect: [at.x - NOTE_PT / 2, at.y - NOTE_PT / 2, NOTE_PT, NOTE_PT], text: "" });
    const rec = list(at.i)[list(at.i).length - 1];
    editNote(at.i, rec);
  }

  function editNote(i, rec) {
    const layer = view.annotLayer(i);
    if (!layer) return;
    layer.querySelectorAll(".pdfa-pop").forEach((n) => n.remove());
    const vp = view.viewportOf(i);
    const b = box(vp, ...rec.rect);
    const area = h("textarea", { class: "pdfa-pop-text", value: rec.text || "", placeholder: "Comment…", rows: 3 });
    const pop = h("div", { class: "pdfa-pop", style: { left: Math.min(b.x, vp.width - 240) + "px", top: b.y + b.h + 6 + "px" } },
      area,
      h("div", { class: "pdfa-pop-row" },
        h("button", { class: "btn btn-sm", onclick: () => { remove(i, rec.id); } }, "Delete"),
        h("button", { class: "btn btn-sm btn-primary", onclick: () => { replace(i, rec.id, { text: area.value }); pop.remove(); } }, "Done")));
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { replace(i, rec.id, { text: area.value }); pop.remove(); }
    });
    layer.append(pop);
    area.focus();
  }

  function editText(i, rec, selectAll = false, at = null) {
    const layer = view.annotLayer(i);
    if (!layer) return;
    const node = layer.querySelector(`.pdfa-text[data-id="${rec.id}"]`);
    if (!node) return;
    node.contentEditable = "true";
    node.classList.add("is-editing");
    editing = { page: i, id: rec.id, node };
    node.focus();
    // the caret where the click was, not at the start
    if (at && !selectAll) { try { const rg = document.caretRangeFromPoint(at.clientX, at.clientY); if (rg && node.contains(rg.startContainer)) { const s0 = window.getSelection(); s0.removeAllRanges(); s0.addRange(rg); } } catch {} }
    if (selectAll) { try { const rg = document.createRange(); rg.selectNodeContents(node); const s0 = window.getSelection(); s0.removeAllRanges(); s0.addRange(rg); } catch {} }
    const stop = (e) => e.stopPropagation();
    node.addEventListener("keydown", (e) => { stop(e); if (e.key === "Escape") node.blur(); });
    const onBlur = () => {
      // a repaint moving the node re-fires focus a moment later: only a real leaving ends the typing
      if (!node.isConnected || document.activeElement === node) return;
      if (editing && editing.node === node) editing = null;
      const text = node.innerText.replace(/ /g, " ").replace(/\n+$/, "");
      node.contentEditable = "false";
      node.classList.remove("is-editing");
      if (text && rec.burn) replace(i, rec.id, { text, rect: [rec.rect[0], rec.rect[1], Math.max(rec.rect[2], burnWidth(text, rec.fontSize || 12, rec.font)), rec.rect[3]] });
      else if (text) replace(i, rec.id, { text });
      else remove(i, rec.id);
      node.removeEventListener("blur", onBlur);
    };
    node.addEventListener("blur", onBlur);
  }

  // The lightest text edit there is: the line under the click is covered with
  // white and typed again over it as a text box, in Helvetica at the same size.
  // The original bytes stay under the patch (a reader can peel it off), the
  // font is not the original, and a line is the unit - but it needs nothing
  // beyond what the annotations already have.
  /** The darkest and the lightest colour inside a box of the rendered page: the ink and the paper. */
  function inkAndPaper(pageEl, r) {
    const canvas = pageEl.querySelector("canvas");
    if (!canvas) return null;
    const pr = pageEl.getBoundingClientRect();
    const sx = canvas.width / pr.width, sy = canvas.height / pr.height;
    const x = Math.max(0, Math.floor((r.left - pr.left) * sx)), y = Math.max(0, Math.floor((r.top - pr.top) * sy));
    const w = Math.min(canvas.width - x, Math.ceil(r.width * sx)), hh = Math.min(canvas.height - y, Math.ceil(r.height * sy));
    if (w < 1 || hh < 1) return null;
    let d;
    try { d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(x, y, w, hh).data; } catch { return null; }
    let dark = null, light = null, lo = 999, hi = -1;
    const step = Math.max(1, Math.floor((w * hh) / 4000));
    for (let i = 0; i < d.length; i += 4 * step) {
      if (d[i + 3] < 200) continue;
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (l < lo) { lo = l; dark = [d[i], d[i + 1], d[i + 2]]; }
      if (l > hi) { hi = l; light = [d[i], d[i + 1], d[i + 2]]; }
    }
    const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
    return dark && light ? { ink: hex(dark), paper: hex(light) } : null;
  }

  /** The width a burnt text box needs for its words on one line, in points. */
  function burnWidth(text, size, font) {
    const c = burnWidth.c || (burnWidth.c = document.createElement("canvas").getContext("2d"));
    c.font = `${size}px ${font || "sans-serif"}`;
    let w = 0;
    for (const ln of String(text).split("\n")) w = Math.max(w, c.measureText(ln).width);
    return w + 8;
  }

  async function retype(e, at) {
    // the text items know their font, size and baseline exactly - but a line comes as
    // fragments (a word, a run of letters), so the whole line on that baseline is taken
    const { spans, styles } = await view.pageText(at.i);
    const items = [];
    for (const { it } of spans) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 0;
      if (!size || !it.width) continue;
      items.push({ it, x: it.transform[4], y: it.transform[5], w: it.width, size, font: it.fontName || "" });
    }
    let hitItem = items.find((m) => at.x >= m.x - 1 && at.x <= m.x + m.w + 1 && at.y >= m.y - m.size * 0.35 && at.y <= m.y + m.size * 1.05);
    if (!hitItem) {
      // the items' boxes missed (a font with an odd matrix): the text layer's span under the pointer says which item it is
      const spans = [...at.el.querySelectorAll(".pdfv-text span")];
      const sp = spans.find((n) => { const r = n.getBoundingClientRect(); return n.textContent.trim() && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
      const t = sp && sp.textContent;
      if (t) { const near = items.filter((m) => m.it.str === t); hitItem = near.sort((p, q) => Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y))[0] || null; }
      if (!hitItem) return;
    }
    const { y, size } = hitItem;
    // the same baseline, size and font: a Japanese word and the Ukrainian one after it share a baseline but not a font, and are two lines in two cells
    const line = items.filter((m) => Math.abs(m.y - y) < size * 0.3 && m.size > size * 0.7 && m.size < size * 1.4 && m.font === hitItem.font).sort((a, b) => a.x - b.x);
    // only the fragments joined to the clicked one (a gap wider than a couple of letters is another column)
    const k = line.indexOf(hitItem);
    let a = k, b = k;
    while (a > 0 && line[a].x - (line[a - 1].x + line[a - 1].w) < size * 1.5) a--;
    while (b < line.length - 1 && line[b + 1].x - (line[b].x + line[b].w) < size * 1.5) b++;
    const run = line.slice(a, b + 1);
    let text = "";
    for (let i = 0; i < run.length; i++) {
      const m = run[i];
      if (i) { const gap = m.x - (run[i - 1].x + run[i - 1].w); if (gap > size * 0.12 && !/\s$/.test(text) && !/^\s/.test(m.it.str)) text += " "; }
      text += m.it.str;
    }
    const x = run[0].x, w = run[run.length - 1].x + run[run.length - 1].w - x;
    const it = hitItem.it;
    const st = (styles && styles[it.fontName]) || {};
    // the glyph box from the font's own ascent and descent: a patch that tall covers the letters and nothing around them (a cell's frame, a line above)
    const asc = st.ascent > 0 && st.ascent < 2 ? st.ascent : 0.9;
    const desc = st.descent < 0 && st.descent > -1 ? -st.descent : 0.25;
    const pr = at.el.getBoundingClientRect();
    const sample = (px, pw) => { const bx = box(at.vp, px, y - desc * size, pw, (asc + desc) * size); return inkAndPaper(at.el, { left: pr.left + bx.x, top: pr.top + bx.y, width: bx.w, height: bx.h }); };
    const cols = sample(x, w) || { ink: "#000000", paper: "#ffffff" };
    const fallback = st.fontFamily || "sans-serif";
    const kept = it.fontName && view.keepFont ? await view.keepFont(at.i, it.fontName) : null;
    const font = [kept ? `"${kept}"` : null, it.fontName ? `"${it.fontName}"` : null, fallback].filter(Boolean).join(", ");
    // one patch per fragment, each in the paper it sits on: a word in a coloured cell keeps the cell's colour
    for (const m of run) {
      const c = sample(m.x, m.w) || cols;
      add(at.i, { type: "rect", color: c.paper, fill: c.paper, opacity: 1, width: 0.1, burn: true, rect: [m.x - 0.5, y - desc * size, m.w + 1, (asc + desc) * size] });
    }
    add(at.i, { type: "text", color: cols.ink, opacity: 1, fontSize: Math.max(4, Math.round(size * 10) / 10), font, burn: true, rect: [x - 4, y - desc * size, Math.max(w + 8, burnWidth(text, size, font)), size * (1 + desc) + 3], text });
    const made = list(at.i)[list(at.i).length - 1];
    editText(at.i, made, true);
  }

  function placeStamp(at) {
    if (!stamp) { opts.onNeedStamp && opts.onNeedStamp(); return; }
    const w = 150;
    const hh = (stamp.h / stamp.w) * w;
    add(at.i, { type: "stamp", color: style.color, opacity: 1, image: stamp.image, rect: [at.x - w / 2, at.y - hh / 2, w, hh] });
  }

  // ── keys ─────────────────────────────────────────────────────────────────

  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.target && e.target.isContentEditable) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); remove(sel.page, sel.id); return; }
    if (e.key === "Escape" && (tool || sel)) { e.preventDefault(); api.setTool(null); if (sel) { sel = null; paintSel(); } }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = keyOf(e).toLowerCase();
    if (k === "z" && !e.shiftKey) { if (undos.length) { e.preventDefault(); api.undo(); } return; }
    if ((k === "z" && e.shiftKey) || k === "y") { if (redos.length) { e.preventDefault(); api.redo(); } }
  }

  scroll.addEventListener("pointerdown", onDown);
  // a double-click on a line of text, whatever tool is up: retype it
  scroll.addEventListener("dblclick", (e) => {
    const box = e.target.closest && e.target.closest(".pdfa-text");
    if (box && !box.isContentEditable) {
      // a box already there: a double-click opens it for typing again
      const pg = box.closest(".pdfv-page"); const i = pg ? Number(pg.dataset.page) - 1 : -1;
      const rec = i >= 0 ? list(i).find((a) => a.id === box.dataset.id) : null;
      if (rec) { e.preventDefault(); editText(i, rec, false, e); }
      return;
    }
    if (e.target.closest && e.target.closest(".pdfa-text, .pdfa-note, .pdfv-annot-ui")) return;
    const at = hit(e);
    if (!at) return;
    e.preventDefault();
    window.getSelection && window.getSelection().removeAllRanges();
    retype(e, at);
  });
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  scroll.addEventListener("mouseup", onSelectionEnd);
  scroll.addEventListener("keydown", onKey);

  const current = () => {
    if (!sel) return null;
    return list(sel.page).find((a) => a.id === sel.id) || null;
  };

  const api = {
    get tool() { return tool; },
    get style() { return { ...style }; },
    get selected() { return current(); },
    get count() { let n = 0; for (const l of byPage.values()) n += l.length; return n; },
    get hasStamp() { return !!stamp; },
    setTool(t) {
      tool = t || null;
      scroll.classList.toggle("is-marking", !!tool && MARKUP.has(tool));
      scroll.classList.toggle("is-drawing", !!tool && !MARKUP.has(tool));
      if (tool) { if (sel) { sel = null; paintSel(); } }
      // Reading first and reaching for the pen second is the natural order:
      // words already selected when the tool is picked are marked at once.
      if (tool && MARKUP.has(tool)) {
        const s0 = window.getSelection();
        if (s0 && !s0.isCollapsed && s0.rangeCount) applyToSelection(tool);
      }
    },
    setStyle(patch) {
      style = { ...style, ...patch };
      const cur = current();
      if (cur && sel) {
        const p = {};
        if (patch.color != null && cur.type !== "stamp") p.color = patch.color;
        if (patch.width != null && cur.width != null) p.width = patch.width;
        if (patch.fontSize != null && cur.fontSize != null) p.fontSize = patch.fontSize;
        if (Object.keys(p).length) { snap(); replace(sel.page, sel.id, p); }
      }
    },
    setStamp(image, w, hh) { stamp = image ? { image, w: w || 300, h: hh || 120 } : null; },
    applyToSelection,
    deleteSelected() { if (sel) remove(sel.page, sel.id); },
    /** Pick a mark (a right-click, say); null clears the selection. */
    select(page, rid) {
      const was = sel;
      sel = page == null ? null : { page, id: rid };
      if (was) paint(was.page);
      if (sel) paint(sel.page);
      opts.onSelect && opts.onSelect(current());
      return current();
    },
    /** The mark under an event, as { page, rec }, or null. */
    at(e) {
      const shape = e.target && e.target.closest && e.target.closest(".pdfa-shape");
      if (!shape) return null;
      const page = shape.closest(".pdfv-page");
      if (!page) return null;
      const i = Number(page.dataset.page) - 1;
      const rec = list(i).find((a) => a.id === shape.dataset.id);
      return rec ? { page: i, rec } : null;
    },
    openComment(page, rid) {
      const rec = list(page).find((a) => a.id === rid);
      if (rec) editNote(page, rec);
    },
    undo() { return step(undos, redos); },
    redo() { return step(redos, undos); },
    get canUndo() { return undos.length > 0; },
    get canRedo() { return redos.length > 0; },
    /** The keys, for whoever owns the PDF view. True when it took the press. */
    handleKey: onKey,
    clear() { snap(); const was = [...byPage.keys()]; byPage = new Map(); for (const i of was) paint(i); changed(); },
    /** After a save: the marks are in the file now, so start from nothing. */
    reset() { const was = [...byPage.keys()]; byPage = new Map(); undos.length = 0; redos.length = 0; sel = null; for (const i of was) paint(i); },
    paint,
    paintAll,
    /** One list per page index, for pdfdoc.writeAnnots. */
    forPages(n) {
      const out = new Array(n).fill(null);
      for (const [i, recs] of byPage) if (i < n) out[i] = recs;
      return out;
    },
    /** After a page move: `order[newIndex] = oldIndex`. */
    remap(order) {
      byPage = remapPages(byPage, order);
      sel = null;
    },
    toJSON: () => packAnnots(byPage),
    destroy() {
      scroll.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      scroll.removeEventListener("mouseup", onSelectionEnd);
      scroll.removeEventListener("keydown", onKey);
    },
  };
  return api;
}
