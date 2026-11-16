// The page manager: a grid of pages you can pick up, turn, throw away, pull
// out or add to. Nothing is written while you arrange - the grid holds a plan
// (which source page goes where, and how far each is turned) and "Apply" hands
// that one plan to pdfdoc.applyOrder. Turning eight pages is one rewrite of
// the file, not eight.
//
// Thumbnails are drawn on demand as tiles come into view and thrown away when
// they leave, the same rule the reader uses.

import { h } from "./util.js";
import { icon } from "./icons.js";
import { menu } from "./ui.js";
import { movePages, removePages, turnPages, formatRanges, normDeg } from "./pdfcore.js";

/**
 * `el.replaceChildren(...)` is not `h(...)`: it turns a null into the text
 * "null" and refuses a nested array outright. Every toolbar here is built from
 * conditional pieces and mapped lists, so they all go through this instead.
 */
function fill(el, ...kids) {
  const flat = [];
  const walk = (k) => { if (k == null || k === false) return; Array.isArray(k) ? k.forEach(walk) : flat.push(k); };
  kids.forEach(walk);
  el.replaceChildren(...flat);
}


/** A page as a small canvas, at most `maxW` css pixels wide. */
export async function renderThumb(doc, i, maxW, spin = 0) {
  const page = await doc.getPage(i + 1);
  const base = page.getViewport({ scale: 1, rotation: normDeg(page.rotate + spin) });
  const scale = Math.min(maxW / base.width, 2);
  const vp = page.getViewport({ scale, rotation: normDeg(page.rotate + spin) });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width * dpr));
  canvas.height = Math.max(1, Math.round(vp.height * dpr));
  canvas.style.width = Math.round(vp.width) + "px";
  canvas.style.height = Math.round(vp.height) + "px";
  const task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: page.getViewport({ scale: scale * dpr, rotation: normDeg(page.rotate + spin) }), background: "#ffffff" });
  await task.promise;
  return canvas;
}

/**
 * A lazily drawn list of page tiles. `onTile(el, i)` decorates each one.
 * Returns { el, refresh, destroy }.
 */
export function thumbList(doc, count, { width = 108, spin = 0, onClick, className = "pdft" }) {
  const el = h("div", { class: className });
  const tiles = [];
  const drawn = new Map();
  let dead = false;
  for (let i = 0; i < count; i++) {
    const box = h("div", { class: "pdft-box" });
    const tile = h("div", { class: `${className}-tile`, dataset: { i: String(i) }, onclick: () => onClick && onClick(i) },
      box, h("div", { class: "pdft-num", text: String(i + 1) }));
    tiles.push(tile);
    el.append(tile);
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.i);
      if (e.isIntersecting) want(i);
      else if (drawn.size > 60) release(i);
    }
  }, { root: el, rootMargin: "300px" });
  tiles.forEach((t) => io.observe(t));

  async function want(i) {
    if (dead || drawn.has(i)) return;
    drawn.set(i, null);
    try {
      const c = await renderThumb(doc, i, width, spin);
      if (dead || !drawn.has(i)) return;
      drawn.set(i, c);
      const box = tiles[i] && tiles[i].querySelector(".pdft-box");
      if (box) box.replaceChildren(c);
    } catch { drawn.delete(i); }
  }
  function release(i) {
    const box = tiles[i] && tiles[i].querySelector(".pdft-box");
    if (box) box.replaceChildren();
    drawn.delete(i);
  }
  return {
    el,
    tiles,
    mark(i) {
      el.querySelectorAll(".is-here").forEach((n) => n.classList.remove("is-here"));
      const t = tiles[i];
      if (t) { t.classList.add("is-here"); t.scrollIntoView({ block: "nearest" }); }
    },
    destroy() { dead = true; io.disconnect(); el.replaceChildren(); },
  };
}

/**
 * @param {HTMLElement} host
 * @param {object} ctx { doc, count, page, onCommit(order, rots), onExtract(indices),
 *                       onInsertPdf(at), onInsertImage(at), onMerge, onSplit,
 *                       onToNote(i), onClose, busy(msg) }
 */
export function mountPageManager(host, ctx) {
  let order = Array.from({ length: ctx.count }, (_, i) => i); // plan: source index per slot
  let rots = new Array(ctx.count).fill(0);                    // extra turn per slot
  let picked = new Set();
  let dead = false;
  // arranging pages is a plan, so a step back is only a plan back: every
  // turn, delete, drag and "start over" keeps the one before it
  const undos = [];
  const redos = [];
  const snapshot = () => ({ order: order.slice(), rots: rots.slice() });
  function snap() {
    undos.push(snapshot());
    if (undos.length > 80) undos.shift();
    redos.length = 0;
  }
  function stepPlan(from, to) {
    if (!from.length) return false;
    to.push(snapshot());
    const s = from.pop();
    order = s.order;
    rots = s.rots;
    picked = new Set();
    draw();
    return true;
  }

  const grid = h("div", { class: "pdfp-grid" });
  const countEl = h("span", { class: "pdfp-count" });
  const bar = h("div", { class: "pdfp-bar" });
  const root = h("div", { class: "pdfp" }, bar, grid);
  host.append(root);

  const dirty = () => order.length !== ctx.count || order.some((v, i) => v !== i) || rots.some((r) => r !== 0);

  const thumbs = new Map(); // source index -> canvas promise
  function thumbFor(src) {
    if (!thumbs.has(src)) thumbs.set(src, renderThumb(ctx.doc, src, 150).catch(() => null));
    return thumbs.get(src);
  }

  function drawBar() {
    const n = picked.size;
    countEl.textContent = n
      ? `${n} page${n === 1 ? "" : "s"} chosen · ${formatRanges([...picked])}`
      : `${order.length} page${order.length === 1 ? "" : "s"} · click to choose, drag to reorder`;
    fill(bar,
      h("button", { class: "icon-btn", title: "Back to reading (Esc)", onclick: () => ctx.onClose() }, icon("back")),
      h("div", { class: "pdfp-title" }, h("strong", { text: "Pages" }), countEl),
      h("div", { class: "pdfp-acts" },
        h("button", { class: "btn", disabled: !n, title: "Turn left (Ctrl+[)", onclick: () => turn(-90) }, icon("undo"), "Left"),
        h("button", { class: "btn", disabled: !n, title: "Turn right (Ctrl+])", onclick: () => turn(90) }, icon("repeat"), "Right"),
        h("button", { class: "btn", disabled: !n || n >= order.length, title: "Remove the chosen pages", onclick: () => del() }, icon("trash"), "Delete"),
        h("button", { class: "btn", disabled: !n, title: "Save the chosen pages as their own PDF", onclick: () => ctx.onExtract(sources()) }, icon("expand"), "Extract…"),
        h("button", { class: "btn", onclick: (e) => addMenu(e.currentTarget) }, icon("plus"), "Insert…"),
        h("button", { class: "btn", title: "More", onclick: (e) => moreMenu(e.currentTarget) }, icon("more")),
        h("button", { class: "icon-btn", disabled: !undos.length, title: "Undo (Ctrl Z)", onclick: () => stepPlan(undos, redos) }, icon("undo")),
        redos.length ? h("button", { class: "icon-btn", title: "Redo (Ctrl Shift Z)", onclick: () => stepPlan(redos, undos) }, icon("rotateRight")) : null,
        dirty() ? h("button", { class: "btn", onclick: reset }, "Start over") : null,
        h("button", { class: "btn btn-primary", disabled: !dirty(), onclick: commit }, icon("check"), "Apply")));
  }

  const sources = () => [...picked].sort((a, b) => a - b).map((i) => order[i]);

  function addMenu(anchor) {
    const at = picked.size ? Math.max(...picked) + 1 : order.length;
    menu(0, 0, [
      { header: `Insert in front of page ${Math.min(at + 1, order.length + 1)}` },
      { label: "Pages from another PDF…", icon: "file", run: () => ctx.onInsertPdf(at) },
      { label: "A picture as a page…", icon: "image", run: () => ctx.onInsertImage(at) },
    ], { anchor });
  }

  function moreMenu(anchor) {
    menu(0, 0, [
      { label: "Merge another PDF onto the end…", icon: "link", run: () => ctx.onMerge() },
      { label: "Split into several files…", icon: "list", run: () => ctx.onSplit() },
      "sep",
      { label: picked.size === order.length ? "Choose none" : "Choose every page", icon: "checkSquare", run: () => { picked = picked.size === order.length ? new Set() : new Set(order.map((_, i) => i)); draw(); } },
      picked.size === 1 ? { label: "Send this page to a note", icon: "filePlus", run: () => ctx.onToNote(order[[...picked][0]]) } : null,
    ].filter(Boolean), { anchor });
  }

  function turn(d) {
    snap();
    rots = turnPages(rots, [...picked], d);
    draw();
  }

  function del() {
    const left = removePages(order, [...picked]);
    if (!left) return;
    snap();
    const keep = order.map((_, i) => i).filter((i) => !picked.has(i));
    rots = keep.map((i) => rots[i]);
    order = left;
    picked = new Set();
    draw();
  }

  function reset() {
    if (dirty()) snap();
    order = Array.from({ length: ctx.count }, (_, i) => i);
    rots = new Array(ctx.count).fill(0);
    picked = new Set();
    draw();
  }

  async function commit() {
    if (!dirty() || dead) return;
    await ctx.onCommit(order.slice(), rots.slice());
  }

  // ── the grid ─────────────────────────────────────────────────────────────

  function draw() {
    const tiles = order.map((src, i) => {
      const box = h("div", { class: "pdfp-box" });
      thumbFor(src).then((c) => { if (!dead && c) box.replaceChildren(copyCanvas(c)); });
      const tile = h("div", {
        class: "pdfp-tile" + (picked.has(i) ? " is-picked" : "") + (rots[i] ? " is-turned" : ""),
        dataset: { slot: String(i) },
        style: { "--turn": `${rots[i]}deg` },
        title: `Page ${src + 1}${rots[i] ? ` · turned ${normDeg(rots[i])}°` : ""}`,
      }, box, h("div", { class: "pdfp-num" }, h("span", { text: String(i + 1) }), src !== i ? h("em", { text: `was ${src + 1}` }) : null));
      tile.addEventListener("pointerdown", (e) => onTileDown(e, i));
      return tile;
    });
    grid.replaceChildren(...tiles);
    drawBar();
  }

  const copyCanvas = (c) => {
    const n = document.createElement("canvas");
    n.width = c.width; n.height = c.height;
    n.style.width = c.style.width; n.style.height = c.style.height;
    n.getContext("2d").drawImage(c, 0, 0);
    return n;
  };

  let drag = null;
  let anchorSlot = 0;

  function onTileDown(e, i) {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      const a = Math.min(anchorSlot, i), b = Math.max(anchorSlot, i);
      picked = new Set();
      for (let k = a; k <= b; k++) picked.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      picked.has(i) ? picked.delete(i) : picked.add(i);
      anchorSlot = i;
    } else {
      if (!picked.has(i)) picked = new Set([i]);
      anchorSlot = i;
    }
    draw();
    drag = { from: i, x: e.clientX, y: e.clientY, live: false };
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag) return;
    if (!drag.live) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.live = true;
      grid.classList.add("is-dragging");
    }
    const to = slotAt(e.clientX, e.clientY);
    grid.querySelectorAll(".is-drop").forEach((n) => n.classList.remove("is-drop", "is-drop-after"));
    if (to == null) return;
    const tile = grid.children[Math.min(to, grid.children.length - 1)];
    if (!tile) return;
    tile.classList.add("is-drop");
    if (to >= grid.children.length) tile.classList.add("is-drop-after");
    drag.to = to;
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    grid.classList.remove("is-dragging");
    grid.querySelectorAll(".is-drop").forEach((n) => n.classList.remove("is-drop", "is-drop-after"));
    if (!d.live || d.to == null) return;
    const picks = [...picked].sort((a, b) => a - b);
    const next = movePages(order, picks, d.to);
    const nextRots = movePages(rots, picks, d.to);
    snap();
    order = next; rots = nextRots;
    // the moved pages keep the selection
    const before = picks.filter((i) => i < d.to).length;
    const start = Math.max(0, Math.min(order.length - picks.length, d.to - before));
    picked = new Set(picks.map((_, k) => start + k));
    draw();
  }

  /** The gap the pointer is nearest, as an insert-before slot. */
  function slotAt(x, y) {
    const kids = [...grid.children];
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      return x < r.left + r.width / 2 ? i : i + 1;
    }
    // below every row
    const last = kids[kids.length - 1];
    if (last && y > last.getBoundingClientRect().bottom) return kids.length;
    return null;
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); ctx.onClose(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); picked = new Set(order.map((_, i) => i)); draw(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); stepPlan(undos, redos); }
    else if ((e.ctrlKey || e.metaKey) && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")) { e.preventDefault(); stepPlan(redos, undos); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "[" || e.key === "]")) { e.preventDefault(); turn(e.key === "[" ? -90 : 90); }
    else if (e.key === "Delete" && picked.size) { e.preventDefault(); del(); }
    else if (e.key === "Enter" && dirty()) { e.preventDefault(); commit(); }
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  root.addEventListener("keydown", onKey);
  root.tabIndex = -1;
  draw();
  requestAnimationFrame(() => root.focus({ preventScroll: true }));

  return {
    el: root,
    get plan() { return { order: order.slice(), rots: rots.slice() }; },
    destroy() {
      dead = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      root.remove();
    },
  };
}
