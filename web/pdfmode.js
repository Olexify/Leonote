// PDFs in Leonote: read, mark up, rearrange, fill in, save.
//
// This is the glue - the toolbar, the side panel, find, and every command
// that turns one buffer of bytes into another. The pieces it drives:
//
//   pdfcore.js   the arithmetic (page order, records, names) - all tested
//   pdfview.js   pdf.js rendering, virtualized scroll, text layer
//   pdfannot.js  the mark-up overlay, in page points, non-destructive
//   pdfedit.js   the page manager grid and thumbnails
//   pdfforms.js  AcroForm widgets, typed into in place
//   pdfdoc.js    pdf-lib writing: page surgery, real annotations, filled forms
//
// Saving is always explicit. `Save` overwrites through host.writeFile, which
// copies the original into the vault's .trash the first time each session;
// `Save a copy…` never touches the original at all. Closing the tab with
// unsaved page changes does not write anything - it offers to.

import { h, dirname, basename, debounce, keyOf } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast, confirmDialog } from "./ui.js";
import { fuzzy } from "./search.js";
import { embedFor } from "./imageeditmodel.js";
import { mountPdfView, openDocument, matchesOnPage } from "./pdfview.js";
import { createAnnots } from "./pdfannot.js";
import { createForms } from "./pdfforms.js";
import { mountPageManager, thumbList, renderThumb } from "./pdfedit.js";
import { sizeVerdict, MAX_PDF_BYTES, formatRanges, splitAt, splitEvery, outputName, splitNames } from "./pdfcore.js";

const fileName = (p) => p.slice(p.lastIndexOf("/") + 1);

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


const COLORS = [
  ["#f6e05e", "Yellow"], ["#68d391", "Green"], ["#63b3ed", "Blue"],
  ["#f687b3", "Pink"], ["#fc8181", "Red"], ["#e0a84a", "Amber"], ["#1a202c", "Ink"],
];

// Grouped the way they are reached for: mark up what is written, draw on top
// of it, say something about it, sign it.
const TOOLS = [
  { id: "highlight", icon: "marker", label: "Highlight", hint: "select the words first, or as you go" },
  { id: "underline", icon: "underline", label: "Underline", hint: "select the words first, or as you go" },
  { id: "strike", icon: "strike", label: "Strike through", hint: "select the words first, or as you go" },
  { group: true },
  { id: "ink", icon: "edit", label: "Pen", hint: "draw freehand" },
  { id: "rect", icon: "square", label: "Rectangle", hint: "drag a box" },
  { id: "ellipse", icon: "circleShape", label: "Ellipse", hint: "drag an ellipse" },
  { id: "arrow", icon: "arrowLine", label: "Arrow", hint: "drag from the tail to the head" },
  { group: true },
  { id: "note", icon: "note", label: "Sticky note", hint: "click to leave a comment" },
  { id: "text", icon: "textBox", label: "Text box", hint: "drag a box and type" },
  { id: "retype", icon: "caseText", label: "Retype a line", hint: "click a line of text: it is covered and typed again over it, same size and colour - or just double-click a line at any time" },
  { group: true },
  { id: "stamp", icon: "signature", label: "Signature or stamp", hint: "draw it once, then drop it anywhere" },
];
const TOOL = (id) => TOOLS.find((t) => t.id === id) || {};

/**
 * @param {HTMLElement} host   an empty element that fills the file view
 * @param {string} path        vault-relative path of the PDF
 * @param {object} o           { app }
 */
// the page each PDF was left on, for the next time it opens (the last 300 read)
const PAGE_KEY = "leonote.pdfPage";
const readPages = () => { try { return new Map(JSON.parse(localStorage.getItem(PAGE_KEY)) || []); } catch { return new Map(); } };
const pageTimers = new Map(); // one per PDF: two open side by side both keep their page
function rememberPage(path, i) {
  clearTimeout(pageTimers.get(path));
  pageTimers.set(path, setTimeout(() => {
    pageTimers.delete(path);
    const m = readPages();
    m.delete(path);
    if (i > 0) m.set(path, i);
    try { localStorage.setItem(PAGE_KEY, JSON.stringify([...m].slice(-300))); } catch {}
  }, 1000));
}

export async function openPdf(host, path, { app, onSaved }) {
  const name = fileName(path);
  const known = (app.vault.files.get(path) || {}).size || 0;
  if (sizeVerdict(known) === "refuse") {
    throw Object.assign(new Error(`${name} is ${Math.round(known / 1048576)} MB. Leonote edits PDFs in memory and will not load one over ${Math.round(MAX_PDF_BYTES / 1048576)} MB — it would take the whole app down with it.`), { code: "too-big" });
  }
  const res = await fetch(app.host.assetUrl(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`could not read the file (${res.status})`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  const verdict = sizeVerdict(bytes.length);
  if (verdict === "refuse") {
    throw Object.assign(new Error(`${name} is ${Math.round(bytes.length / 1048576)} MB. Leonote edits PDFs in memory and will not load one over ${Math.round(MAX_PDF_BYTES / 1048576)} MB.`), { code: "too-big" });
  }

  const root = h("div", { class: "pdfv" });
  const bar = h("div", { class: "pdfv-bar" });
  const styleBar = h("div", { class: "pdfv-stylebar", hidden: true });
  const findBar = h("div", { class: "pdfv-findbar", hidden: true });
  const side = h("aside", { class: "pdfv-side", hidden: true });
  // The marking tools live in a rail down the side rather than in the top bar.
  // Eleven of them plus page, zoom, find and save does not fit across a narrow
  // window, and a toolbar that silently drops half its buttons is worse than
  // no toolbar: the rail is the same height whatever the window does.
  const rail = h("div", { class: "pdfv-rail" });
  const stage = h("div", { class: "pdfv-stage" });
  const body = h("div", { class: "pdfv-body" }, side, rail, stage);
  root.append(bar, styleBar, findBar, body);
  host.append(root);

  let dirtyBytes = false;   // pages were rearranged, and only a save keeps it
  let doc = null;
  let mgr = null;
  let sideTab = "thumbs";
  let thumbs = null;
  let saving = false;
  let dead = false;

  const view = mountPdfView(stage, {
    onPage: (i) => { pageBox.value = String(i + 1); if (thumbs) thumbs.mark(i); rememberPage(path, i); },
    onZoom: () => drawBar(),
    onLayout: (i) => {
      if (i == null) { annots.paintAll(); forms.paintAll(); paintFinds(); }
      else { annots.paint(i); forms.paint(i); paintFind(i); }
    },
  });

  const annots = createAnnots(view, {
    author: "Leonote",
    onChange: () => { touch(); drawBar(); },
    onSelect: () => drawStyleBar(),
    onNeedStamp: () => signatureDialog(),
  });
  const forms = createForms(view, { onChange: () => { touch(); drawBar(); } });

  const touch = () => { drawBar(); };
  const changed = () => dirtyBytes || annots.count > 0 || forms.changes().length > 0;

  // ── opening ──────────────────────────────────────────────────────────────

  let opened = false;
  async function load(next, { keepPlace = false } = {}) {
    // reopened where it was left; a reload after a save keeps the page on screen
    const at = keepPlace ? view.page : opened ? 0 : readPages().get(path) || 0;
    opened = true;
    if (next) bytes = next;
    const d = await openDocument(bytes);
    if (dead) { try { d.loadingTask.destroy(); } catch {} return; }
    const old = doc;
    doc = d;
    await view.open(d);
    await forms.scan(d);
    view.setFormMode(forms.count > 0 && forms.active);
    buildSide();
    if (old) old.loadingTask.destroy().catch(() => {}); // its worker holds a whole copy of the file
    drawBar();
    if (at) view.goTo(at);
    if (findQuery) runFind(findQuery, { keepIndex: true });
  }

  // ── toolbar ──────────────────────────────────────────────────────────────

  const pageBox = h("input", { class: "pdfv-pagebox", value: "1", "aria-label": "Page number", onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") { const n = parseInt(pageBox.value, 10); if (n >= 1) view.goTo(n - 1); } } });

  function drawBar() {
    const n = view.pageCount || 0;
    fill(bar,
      h("button", { class: "icon-btn" + (side.hidden ? "" : " is-on"), title: "Thumbnails and bookmarks (F4)", onclick: toggleSide }, icon("sidebar")),
      h("div", { class: "pdfv-grp" },
        h("button", { class: "icon-btn", title: "Previous page (Page Up)", onclick: () => view.goTo(view.page - 1) }, icon("arrowUp")),
        pageBox,
        h("span", { class: "pdfv-of", text: `/ ${n}` }),
        h("button", { class: "icon-btn", title: "Next page (Page Down)", onclick: () => view.goTo(view.page + 1) }, icon("arrowDown"))),
      h("div", { class: "pdfv-grp" },
        h("button", { class: "icon-btn", title: "Zoom out (Ctrl -)", onclick: () => view.zoomBy(1 / 1.25) }, icon("minus")),
        h("button", { class: "btn btn-sm pdfv-zoom", title: "Zoom", onclick: (e) => zoomMenu(e.currentTarget) }, zoomLabel()),
        h("button", { class: "icon-btn", title: "Zoom in (Ctrl +)", onclick: () => view.zoomBy(1.25) }, icon("plus")),
        h("button", { class: "icon-btn", title: "Turn the view a quarter (R)", onclick: () => view.setSpin(view.spin + 90) }, icon("repeat"))),
      h("div", { class: "pdfv-right" },
        h("button", { class: "icon-btn", disabled: !annots.canUndo, title: "Undo (Ctrl Z)", onclick: () => { annots.undo(); drawBar(); } }, icon("undo")),
        annots.canRedo ? h("button", { class: "icon-btn", title: "Redo (Ctrl Shift Z)", onclick: () => { annots.redo(); drawBar(); } }, icon("rotateRight")) : null,
        h("button", { class: "icon-btn", title: "Find in this document (Ctrl F)", onclick: () => openFind() }, icon("search")),
        forms.count ? h("button", { class: "btn btn-sm" + (forms.active ? " is-on" : ""), title: `${forms.count} form field${forms.count === 1 ? "" : "s"} — click one on the page and type`, onclick: () => { forms.setActive(!forms.active); view.setFormMode(forms.active); drawBar(); } }, icon("checkSquare"), `Fields${forms.changes().length ? ` · ${forms.changes().length}` : ""}`) : null,
        h("button", { class: "btn btn-sm", title: "Reorder, turn, remove, extract, insert, merge and split pages", onclick: () => openPages() }, icon("layers"), "Pages"),
        h("span", { class: "pdfv-dirty", hidden: !changed(), text: dirtyBytes ? "Unsaved page changes" : "Unsaved marks" }),
        h("button", { class: "btn btn-sm btn-primary", disabled: saving || !changed(), onclick: () => save() }, icon("check"), saving ? "Saving…" : "Save"),
        h("button", { class: "icon-btn", title: "More", onclick: (e) => moreMenu(e.currentTarget) }, icon("more"))),
    );
    drawRail();
    drawStyleBar();
  }

  /** The marking tools, down the left edge of the page. */
  function drawRail() {
    const tool = annots.tool;
    fill(rail,
      h("button", { class: "pdfv-rail-btn" + (tool ? "" : " is-on"), title: "Select and move marks · Esc", onclick: () => setTool(null) }, icon("focus")),
      h("div", { class: "pdfv-rail-sep" }),
      TOOLS.map((t) => (t.group ? h("div", { class: "pdfv-rail-sep" }) : h("button", {
        class: "pdfv-rail-btn" + (tool === t.id ? " is-on" : ""),
        title: `${t.label} — ${t.hint}`,
        onclick: () => setTool(tool === t.id ? null : t.id),
      }, icon(t.icon)))),
      h("div", { class: "pdfv-rail-sep" }),
      h("button", {
        class: "pdfv-rail-btn pdfv-rail-color", title: `Colour — ${(COLORS.find(([c]) => c === annots.style.color) || [])[1] || "custom"}`,
        onclick: (e) => menu(0, 0, [
          { header: "Colour" },
          ...COLORS.map(([c, label]) => ({ label, swatch: c, checked: annots.style.color === c, run: () => { annots.setStyle({ color: c }); drawRail(); drawStyleBar(); } })),
          "sep",
          { label: "Any colour…", icon: "palette", run: () => pickCustom() },
        ], { anchor: e.currentTarget }),
      }, h("i", { class: "pdfv-rail-dot", style: { background: annots.style.color } })),
    );
  }

  const zoomLabel = () => (view.scaleMode === "width" ? "Fit width" : view.scaleMode === "page" ? "Whole page" : `${Math.round(view.scale * 100)}%`);

  function zoomMenu(anchor) {
    menu(0, 0, [
      { label: "Fit the width", icon: "expand", keys: "Ctrl 0", run: () => view.setScale("width") },
      { label: "Whole page", icon: "shrink", run: () => view.setScale("page") },
      "sep",
      ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((z) => ({ label: `${z * 100}%`, run: () => view.setScale(z) })),
    ], { anchor });
  }

  function setTool(t) {
    annots.setTool(t);
    drawBar();
    if (t && !["highlight", "underline", "strike"].includes(t)) window.getSelection()?.removeAllRanges();
    if (t === "stamp" && !annots.hasStamp) signatureDialog();
  }

  function drawStyleBar() {
    const tool = annots.tool;
    const sel = annots.selected;
    const show = !!tool && tool !== null;
    styleBar.hidden = !show && !sel;
    if (styleBar.hidden) return;
    const st = annots.style;
    const kind = sel ? sel.type : tool;
    fill(styleBar,
      h("span", { class: "pdfv-style-label", text: sel ? `${TOOL(sel.type).label || sel.type} selected` : `${TOOL(tool).label} — ${TOOL(tool).hint || ""}` }),
      kind === "stamp" ? null : h("div", { class: "pdfv-swatches" },
        COLORS.map(([c, title]) => h("button", {
          class: "pdfv-swatch" + ((sel ? sel.color : st.color) === c ? " is-on" : ""), title,
          style: { background: c }, onclick: () => { annots.setStyle({ color: c }); drawStyleBar(); },
        })),
        h("button", {
          class: "pdfv-swatch pdfv-swatch-any" + (COLORS.some(([c]) => c === (sel ? sel.color : st.color)) ? "" : " is-on"),
          title: "Any colour…",
          style: COLORS.some(([c]) => c === (sel ? sel.color : st.color)) ? {} : { background: sel ? sel.color : st.color, backgroundImage: "none" },
          onclick: () => pickCustom(),
        })),
      ["ink", "rect", "ellipse", "arrow"].includes(kind) ? h("label", { class: "pdfv-range" }, "Thickness",
        h("input", { type: "range", min: "0.5", max: "12", step: "0.5", value: String(sel ? sel.width : st.width), oninput: (e) => annots.setStyle({ width: Number(e.target.value) }) })) : null,
      ["text", "note"].includes(kind) ? h("label", { class: "pdfv-range" }, "Text size",
        h("input", { type: "range", min: "8", max: "36", step: "1", value: String((sel && sel.fontSize) || st.fontSize), oninput: (e) => annots.setStyle({ fontSize: Number(e.target.value) }) })) : null,
      kind === "stamp" ? h("button", { class: "btn btn-sm", onclick: () => signatureDialog() }, icon("edit"), annots.hasStamp ? "Redraw the signature" : "Draw a signature") : null,
      sel ? h("button", { class: "btn btn-sm", onclick: () => { annots.deleteSelected(); drawStyleBar(); } }, icon("trash"), "Delete") : null,
      annots.count ? h("button", { class: "btn btn-sm pdfv-style-end", onclick: clearMarks }, "Clear all marks") : null,
    );
  }

  async function clearMarks() {
    if (await confirmDialog("Clear every mark?", `The ${annots.count} mark${annots.count === 1 ? "" : "s"} you added here go away. Anything already saved into the file stays.`, { ok: "Clear" })) {
      annots.clear();
      drawBar();
    }
  }

  // ── side panel: thumbnails and bookmarks ─────────────────────────────────

  function toggleSide() {
    side.hidden = !side.hidden;
    if (!side.hidden) buildSide();
    drawBar();
  }

  async function buildSide() {
    if (side.hidden || !doc) return;
    const outline = await doc.getOutline().catch(() => null);
    const tabs = h("div", { class: "pdfv-side-tabs" },
      h("button", { class: "pdfv-side-tab" + (sideTab === "thumbs" ? " is-on" : ""), onclick: () => { sideTab = "thumbs"; buildSide(); } }, "Pages"),
      outline && outline.length ? h("button", { class: "pdfv-side-tab" + (sideTab === "outline" ? " is-on" : ""), onclick: () => { sideTab = "outline"; buildSide(); } }, "Bookmarks") : null);
    if (thumbs) { thumbs.destroy(); thumbs = null; }
    if (sideTab === "thumbs") {
      thumbs = thumbList(doc, view.pageCount, { width: 108, onClick: (i) => view.goTo(i) });
      fill(side, tabs, thumbs.el);
      thumbs.mark(view.page);
    } else {
      fill(side, tabs, await outlineTree(outline));
    }
  }

  async function outlineTree(items, depth = 0) {
    const box = h("div", { class: "pdfv-outline" });
    for (const it of items || []) {
      const row = h("button", { class: "pdfv-ol-row", style: { paddingLeft: 10 + depth * 13 + "px" }, onclick: () => jumpTo(it.dest) },
        h("span", { class: "pdfv-ol-title", text: it.title || "(untitled)" }));
      if (it.bold) row.style.fontWeight = "650";
      if (it.italic) row.style.fontStyle = "italic";
      box.append(row);
      if (it.items && it.items.length) box.append(await outlineTree(it.items, depth + 1));
    }
    return box;
  }

  async function jumpTo(dest) {
    try {
      const d = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(d)) return;
      const ref = d[0];
      const i = ref && typeof ref === "object" ? await doc.getPageIndex(ref) : typeof ref === "number" ? ref : -1;
      if (i >= 0) view.goTo(i);
    } catch { toast("That bookmark points nowhere", { ms: 2200 }); }
  }

  // ── find ─────────────────────────────────────────────────────────────────

  let findQuery = "";
  let hits = [];        // { page, rects }
  let hitAt = -1;
  let findGen = 0;
  const findInput = h("input", { class: "pdfv-find-in", placeholder: "Find in this document…", spellcheck: false });
  const findCount = h("span", { class: "pdfv-find-count" });

  findBar.append(
    icon("search"),
    findInput,
    findCount,
    h("button", { class: "icon-btn", title: "Previous (Shift Enter)", onclick: () => stepFind(-1) }, icon("arrowUp")),
    h("button", { class: "icon-btn", title: "Next (Enter)", onclick: () => stepFind(1) }, icon("arrowDown")),
    h("button", { class: "icon-btn", title: "Close (Esc)", onclick: closeFind }, icon("x")));

  findInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); if (findInput.value !== findQuery) runFind(findInput.value); else stepFind(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  findInput.addEventListener("input", debounce(() => runFind(findInput.value), 220));

  function openFind() { findBar.hidden = false; findInput.focus(); findInput.select(); }
  function closeFind() {
    findBar.hidden = true;
    findQuery = ""; hits = []; hitAt = -1; findGen++;
    for (let i = 0; i < view.pageCount; i++) paintFind(i);
    view.scrollEl.focus();
  }

  async function runFind(q, { keepIndex = false } = {}) {
    const mine = ++findGen;
    findQuery = q;
    hits = [];
    if (!keepIndex) hitAt = -1;
    for (let i = 0; i < view.pageCount; i++) paintFind(i);
    if (!q.trim()) { findCount.textContent = ""; return; }
    findCount.textContent = "searching…";
    for (let i = 0; i < view.pageCount; i++) {
      if (mine !== findGen) return;
      let t;
      try { t = await view.pageText(i); } catch { continue; }
      if (mine !== findGen) return;
      for (const m of matchesOnPage(t, q)) hits.push({ page: i, rects: m.rects });
      if (hits.length && hitAt < 0) { hitAt = 0; goToHit(); }
      if (i % 8 === 0 || i === view.pageCount - 1) {
        findCount.textContent = hits.length ? `${Math.max(1, hitAt + 1)} of ${hits.length}${i < view.pageCount - 1 ? "…" : ""}` : i < view.pageCount - 1 ? "searching…" : "no matches";
        paintFinds();
      }
    }
    findCount.textContent = hits.length ? `${Math.max(1, hitAt + 1)} of ${hits.length}` : "no matches";
    paintFinds();
  }

  function stepFind(d) {
    if (!hits.length) return;
    hitAt = (hitAt + d + hits.length) % hits.length;
    findCount.textContent = `${hitAt + 1} of ${hits.length}`;
    goToHit();
  }

  function goToHit() {
    const hit = hits[hitAt];
    if (!hit) return;
    view.goTo(hit.page);
    requestAnimationFrame(() => {
      paintFinds();
      const vp = view.viewportOf(hit.page);
      const el = view.slotOf(hit.page) && view.slotOf(hit.page).el;
      if (!vp || !el || !hit.rects.length) return;
      const [, vy] = vp.convertToViewportPoint(hit.rects[0].x, hit.rects[0].y);
      const target = el.offsetTop + vy - view.scrollEl.clientHeight * 0.35;
      view.scrollEl.scrollTop = Math.max(0, target);
    });
  }

  const paintFinds = () => { for (let i = 0; i < view.pageCount; i++) paintFind(i); };

  function paintFind(i) {
    const layer = view.findLayer(i);
    const vp = view.viewportOf(i);
    if (!layer) return;
    layer.replaceChildren();
    if (!vp || !findQuery) return;
    hits.forEach((hit, k) => {
      if (hit.page !== i) return;
      for (const r of hit.rects) {
        const [ax, ay] = vp.convertToViewportPoint(r.x, r.y);
        const [bx, by] = vp.convertToViewportPoint(r.x + r.w, r.y + r.h);
        layer.append(h("i", {
          class: "pdfv-hit" + (k === hitAt ? " is-now" : ""),
          style: { left: Math.min(ax, bx) + "px", top: Math.min(ay, by) + "px", width: Math.abs(bx - ax) + "px", height: Math.abs(by - ay) + "px" },
        }));
      }
    });
  }

  // ── the page manager ─────────────────────────────────────────────────────

  function openPages() {
    if (mgr) return closePages();
    findBar.hidden = true;
    body.hidden = true;
    styleBar.hidden = true;
    mgr = mountPageManager(root, {
      get doc() { return doc; }, // a save under the open grid replaces it
      count: view.pageCount, page: view.page,
      onClose: closePages,
      onCommit: commitPlan,
      onExtract: extractPages,
      onInsertPdf: (at) => insertFrom(at, "pdf"),
      onInsertImage: (at) => insertFrom(at, "image"),
      onMerge: () => insertFrom(view.pageCount, "pdf", { merge: true }),
      onSplit: splitDialog,
      onToNote: pageToNote,
    });
  }

  function closePages() {
    if (mgr) { mgr.destroy(); mgr = null; }
    body.hidden = false;
    drawBar();
    view.scrollEl.focus();
  }

  /** The one write the grid's whole session of dragging and turning adds up to. */
  async function commitPlan(order, rots) {
    const { applyOrder } = await import("./pdfdoc.js");
    await busy("Rearranging pages…", async () => {
      const next = await applyOrder(bytes, order, rots);
      annots.remap(order);
      dirtyBytes = true;
      await load(next); // rescans the form, keeping what has been typed

    });
    closePages();
    toast(`${order.length} page${order.length === 1 ? "" : "s"} rearranged — Save to write it to the file`, { ms: 4200 });
  }

  async function extractPages(indices) {
    if (!indices.length) return;
    const { applyOrder } = await import("./pdfdoc.js");
    await busy("Pulling the pages out…", async () => {
      const out = await applyOrder(bytes, indices, null);
      const target = outputName(app.vault.files, path, `pages ${formatRanges(indices)}`, "pdf");
      const made = await app.host.importFile(target, out);
      toast(`${fileName(made)} — ${indices.length} page${indices.length === 1 ? "" : "s"}`, { ms: 6000, action: { label: "Open", run: () => app.openFile(made) } });
    });
  }

  async function insertFrom(at, kind, { merge = false } = {}) {
    const pick = await pickVaultFile(app, kind === "pdf" ? /\.pdf$/i : /\.(png|jpe?g)$/i, kind === "pdf" ? "Which PDF?" : "Which picture?");
    if (!pick) return;
    const src = new Uint8Array(await (await fetch(app.host.assetUrl(pick), { cache: "no-store" })).arrayBuffer());
    const mod = await import("./pdfdoc.js");
    await busy(merge ? "Merging…" : "Adding pages…", async () => {
      const next = kind === "pdf"
        ? await mod.insertPdfPages(bytes, merge ? view.pageCount : at, src, null)
        : await mod.insertImagePage(bytes, at, src, pick);
      const added = (await mod.pageCount(next)) - view.pageCount;
      // marks on pages after the insert move down with them
      annots.remap(shiftOrder(view.pageCount, at, added));
      dirtyBytes = true;
      await load(next, { keepPlace: true });
      toast(`${added} page${added === 1 ? "" : "s"} added from ${fileName(pick)} — Save to keep it`, { ms: 4600 });
    });
    if (mgr) { closePages(); openPages(); }
  }

  const shiftOrder = (oldCount, at, added) => {
    const out = [];
    for (let i = 0; i < oldCount + added; i++) out.push(i < at ? i : i < at + added ? -1 : i - added);
    return out;
  };

  async function splitDialog() {
    const total = view.pageCount;
    const res = await smallDialog("Split this PDF", (close) => {
      const mode = h("select", { class: "text-input" },
        h("option", { value: "every", text: "Every N pages" }),
        h("option", { value: "at", text: "Starting at these pages" }));
      const num = h("input", { class: "text-input", value: "1", inputMode: "numeric" });
      const note = h("p", { class: "pdfm-note", text: `${total} pages. Each part becomes its own file beside this one; the original is not touched.` });
      const sync = () => { num.placeholder = mode.value === "every" ? "e.g. 10" : "e.g. 3, 7, 12"; };
      mode.addEventListener("change", sync); sync();
      return h("div", { class: "pdfm-form" }, note, mode, num,
        h("div", { class: "pdfm-btns" },
          h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
          h("button", { class: "btn btn-primary", onclick: () => close({ mode: mode.value, value: num.value }) }, "Split")));
    });
    if (!res) return;
    const parts = res.mode === "every"
      ? splitEvery(total, parseInt(res.value, 10) || 1)
      : splitAt(total, String(res.value).split(/[,;\s]+/).map(Number).filter((n) => n >= 1));
    if (parts.length < 2) return toast("That would make just one file — nothing to split", { ms: 3200 });
    const { splitPdf } = await import("./pdfdoc.js");
    await busy(`Making ${parts.length} files…`, async () => {
      const outs = await splitPdf(bytes, parts);
      const names = splitNames(app.vault.files, path, parts);
      const made = [];
      for (let i = 0; i < outs.length; i++) made.push(await app.host.importFile(names[i], outs[i]));
      toast(`Split into ${made.length} files beside ${name}`, { ms: 6000, action: { label: "Open the first", run: () => app.openFile(made[0]) } });
    });
    closePages();
  }

  // ── saving ───────────────────────────────────────────────────────────────

  /** The document as it would land on disk: page moves, marks and form answers. */
  async function compose({ flatten = false } = {}) {
    let out = bytes;
    // Read everything off the view *before* the first await: `destroy()` calls
    // this on its way out, and by the second tick the view is already gone.
    const pages = view.pageCount;
    const perPage = annots.forPages(pages);
    const changes = forms.changes();
    if (changes.length || flatten) {
      const mod = await import("./pdfdoc.js");
      const r = await mod.fillForm(out, changes, { flatten });
      out = r.bytes;
      if (r.missed.length) toast(`Could not fill ${r.missed.length} field${r.missed.length === 1 ? "" : "s"} (${r.missed.slice(0, 3).join(", ")})`, { kind: "error" });
    }
    if (perPage.some((l) => l && l.length)) {
      const mod = await import("./pdfdoc.js");
      out = (await mod.writeAnnots(out, perPage, { author: "Leonote" })).bytes;
    }
    return out;
  }

  async function save({ flatten = false } = {}) {
    if (saving || !changed()) return;
    saving = true; drawBar();
    try {
      const out = await compose({ flatten });
      const entry = await app.host.writeFile(path, out);
      if (entry && entry.path) app.vault.files.set(entry.path, entry);
      onSaved && onSaved(entry);
      // the marks are in the file now; the overlay starts empty again
      annots.reset();
      forms.reset();
      dirtyBytes = false;
      saving = false;
      await load(out);
      toast(`${name} saved · the version before this is in .trash`, { ms: 5200 });
    } catch (e) {
      saving = false;
      drawBar();
      toast(`Could not save ${name}: ${(e && e.message) || e}`, { kind: "error", ms: 7000 });
    }
  }

  async function saveCopy({ flatten = false } = {}) {
    try {
      const out = await compose({ flatten });
      const target = outputName(app.vault.files, path, flatten ? "filled" : "edited", "pdf");
      const made = await app.host.importFile(target, out);
      toast(`Saved as ${fileName(made)} — ${name} is untouched`, { ms: 6000, action: { label: "Open", run: () => app.openFile(made) } });
    } catch (e) {
      toast(`Could not save a copy: ${(e && e.message) || e}`, { kind: "error" });
    }
  }

  function moreMenu(anchor) {
    const filled = forms.changes().length;
    menu(0, 0, [
      { header: changed() ? "There are unsaved changes" : "This document" },
      { label: "Save a copy…", icon: "filePlus", run: () => saveCopy() },
      forms.count ? { label: "Save a filled copy, flattened", icon: "checkSquare", run: () => saveCopy({ flatten: true }), sub: filled ? `${filled} answer${filled === 1 ? "" : "s"}` : "no answers yet" } : null,
      "sep",
      { label: "Extract the text to a note", icon: "fileText", run: () => textToNote() },
      { label: `Send page ${view.page + 1} to a note`, icon: "image", run: () => pageToNote(view.page) },
      "sep",
      { label: "Open in the default app", icon: "reveal", run: () => app.host.openPath(path).catch((e) => toast(String(e), { kind: "error" })) },
      { label: "Show in Explorer", icon: "folder", run: () => app.reveal(path) },
    ].filter(Boolean), { anchor });
  }

  // ── out to notes ─────────────────────────────────────────────────────────

  async function textToNote() {
    await busy("Reading the text…", async () => {
      const parts = [];
      for (let i = 0; i < view.pageCount; i++) {
        const { text } = await view.pageText(i);
        const clean = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (clean) parts.push(`## Page ${i + 1}\n\n${clean}`);
      }
      if (!parts.length) return toast("This PDF has no text to take — it is probably scanned pictures.", { ms: 5200 });
      const body = [`From [[${basename(path)}]] · [${name}](${encodeURI(name)})`, "", parts.join("\n\n")].join("\n");
      await app.newNote({ dir: dirname(path), name: `${name.replace(/\.pdf$/i, "")} — text`, content: body });
    });
  }

  async function pageToNote(i) {
    await busy("Making a picture of the page…", async () => {
      const canvas = await renderThumb(doc, i, 1400);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const target = outputName(app.vault.files, path, `page ${i + 1}`, "png");
      const list = await app.host.saveImage(target, new Uint8Array(await blob.arrayBuffer()));
      if (Array.isArray(list)) app.vault.setFiles(list);
      const body = `From [[${basename(path)}]], page ${i + 1}\n\n${embedFor(target)}\n`;
      await app.newNote({ dir: dirname(path), name: `${name.replace(/\.pdf$/i, "")} — page ${i + 1}`, content: body });
    });
  }

  // ── the signature, drawn once ────────────────────────────────────────────

  function signatureDialog() {
    const W = 520, H = 190;
    return smallDialog("Draw your signature", (close) => {
      const canvas = h("canvas", { class: "pdfm-sign", width: String(W * 2), height: String(H * 2), style: { width: W + "px", height: H + "px" } });
      const ctx = canvas.getContext("2d");
      ctx.scale(2, 2);
      ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#101014";
      let down = false, empty = true;
      const at = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      canvas.addEventListener("pointerdown", (e) => {
        down = true; empty = false;
        try { canvas.setPointerCapture(e.pointerId); } catch {}
        const [x, y] = at(e); ctx.beginPath(); ctx.moveTo(x, y);
      });
      canvas.addEventListener("pointermove", (e) => { if (!down) return; const [x, y] = at(e); ctx.lineTo(x, y); ctx.stroke(); });
      canvas.addEventListener("pointerup", () => { down = false; });
      return h("div", { class: "pdfm-form" },
        h("p", { class: "pdfm-note", text: "Draw it once — it is kept for this vault and can be dropped on any page. It is saved into the PDF as a picture, not as a certificate." }),
        h("div", { class: "pdfm-sign-wrap" }, canvas),
        h("div", { class: "pdfm-btns" },
          h("button", { class: "btn", onclick: () => { ctx.clearRect(0, 0, W, H); empty = true; } }, "Clear"),
          h("span", { style: { flex: "1" } }),
          h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
          h("button", {
            class: "btn btn-primary", onclick: () => {
              if (empty) return close(null);
              const png = trimCanvas(canvas);
              annots.setStamp(png.url, png.w, png.h);
              try { localStorage.setItem("leonote.pdf.stamp", JSON.stringify(png)); } catch {}
              annots.setTool("stamp");
              drawBar();
              close(true);
            },
          }, "Use it")));
    });
  }

  /** Crop the blank border away so the signature lands where it is dropped. */
  function trimCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    const { width: w, height: hh } = canvas;
    const data = ctx.getImageData(0, 0, w, hh).data;
    let x0 = w, y0 = hh, x1 = 0, y1 = 0;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < x0) return { url: canvas.toDataURL("image/png"), w, h: hh };
    const pad = 8;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hh - 1, y1 + pad);
    const out = document.createElement("canvas");
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return { url: out.toDataURL("image/png"), w: out.width, h: out.height };
  }

  try {
    const kept = JSON.parse(localStorage.getItem("leonote.pdf.stamp") || "null");
    if (kept && kept.url) annots.setStamp(kept.url, kept.w, kept.h);
  } catch {}

  // ── keys ─────────────────────────────────────────────────────────────────

  function onKey(e) {
    if (e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    // undo and redo reach the marks from anywhere in the viewer: the press
    // rarely lands on the page itself, which is where they used to be heard
    if (ctrl && (keyOf(e).toLowerCase() === "z" || keyOf(e).toLowerCase() === "y")) {
      annots.handleKey(e);
      drawBar();
      return;
    }
    if (ctrl && keyOf(e).toLowerCase() === "f") { e.preventDefault(); openFind(); }
    else if (ctrl && keyOf(e).toLowerCase() === "s") { e.preventDefault(); save(); }
    else if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); view.zoomBy(1.25); }
    else if (ctrl && e.key === "-") { e.preventDefault(); view.zoomBy(1 / 1.25); }
    else if (ctrl && e.key === "0") { e.preventDefault(); view.setScale("width"); }
    else if (e.key === "F4") { e.preventDefault(); toggleSide(); }
    else if (!ctrl && (keyOf(e) === "r" || keyOf(e) === "R")) { e.preventDefault(); view.setSpin(view.spin + 90); }
    else if (e.key === "PageDown") { e.preventDefault(); view.goTo(view.page + 1); }
    else if (e.key === "PageUp") { e.preventDefault(); view.goTo(view.page - 1); }
    else if (e.key === "Home") { e.preventDefault(); view.goTo(0); }
    else if (e.key === "End") { e.preventDefault(); view.goTo(view.pageCount - 1); }
  }
  root.addEventListener("keydown", onKey);


  // ── right-click ──────────────────────────────────────────────────────────
  // What you want depends on what is under the pointer: a mark of your own,
  // some words you have selected, or the page itself.

  const colorInput = h("input", { type: "color", class: "pdfv-colorpick", value: "#e0a84a", oninput: (e) => { annots.setStyle({ color: e.target.value }); drawRail(); drawStyleBar(); } });
  root.append(colorInput);
  const pickCustom = () => { colorInput.value = annots.style.color || "#e0a84a"; colorInput.click(); };

  const colorItems = (now, run) => [
    ...COLORS.map(([c, label]) => ({ label, swatch: c, checked: now === c, run: () => run(c) })),
    { label: "Any colour…", icon: "palette", run: () => pickCustom() },
  ];

  function markMenu(x, y, page, rec) {
    annots.select(page, rec.id);
    drawStyleBar();
    const sized = ["ink", "rect", "ellipse", "arrow"].includes(rec.type);
    const texty = ["text", "note"].includes(rec.type);
    menu(x, y, [
      { header: TOOL(rec.type).label || rec.type },
      ...(rec.type === "stamp" ? [] : colorItems(rec.color, (c) => { annots.setStyle({ color: c }); drawStyleBar(); })),
      sized ? "sep" : null,
      ...(sized ? [["Fine", 1], ["Medium", 3], ["Thick", 6]].map(([label, w]) => ({
        label, icon: "minus", checked: Math.abs((rec.width || 2) - w) < 0.6, run: () => { annots.setStyle({ width: w }); drawStyleBar(); },
      })) : []),
      texty ? "sep" : null,
      ...(texty ? [["Small", 10], ["Normal", 13], ["Large", 20]].map(([label, fs]) => ({
        label: label + " text", icon: "edit", checked: (rec.fontSize || 13) === fs, run: () => { annots.setStyle({ fontSize: fs }); drawStyleBar(); },
      })) : []),
      rec.type === "note" ? { label: "Edit the comment", icon: "note", run: () => annots.openComment(page, rec.id) } : null,
      "sep",
      { label: "Delete this mark", icon: "trash", danger: true, keys: "Del", run: () => { annots.deleteSelected(); drawStyleBar(); drawBar(); } },
    ].filter(Boolean));
  }

  function selectionMenu(x, y, text) {
    const short = text.length > 42 ? text.slice(0, 40).trim() + "…" : text;
    menu(x, y, [
      { header: "\u201c" + short + "\u201d", plain: true },
      { label: "Copy", icon: "clipboard", keys: "Ctrl C", run: () => navigator.clipboard.writeText(text) },
      "sep",
      ...[["highlight", "Highlight", "marker"], ["underline", "Underline", "underline"], ["strike", "Strike through", "strike"]].map(([id, label, ic]) => ({
        label, icon: ic, run: () => { annots.applyToSelection(id); drawBar(); drawStyleBar(); },
      })),
      { label: "In another colour…", icon: "palette", run: () => pickCustom() },
      "sep",
      { label: "Find this in the document", icon: "search", run: () => { openFind(); runFind(text.slice(0, 80)); } },
      { label: "Copy it for a note", icon: "filePlus", run: () => navigator.clipboard.writeText(text).then(() => toast("Copied - paste it into a note", { ms: 2600 })).catch(() => {}) },
    ]);
  }

  function pageMenu(x, y) {
    menu(x, y, [
      { header: "Page " + (view.page + 1) + " of " + (view.pageCount || 1) },
      ...TOOLS.filter((t) => !t.group).slice(0, 3).map((t) => ({ label: t.label, icon: t.icon, checked: annots.tool === t.id, run: () => setTool(annots.tool === t.id ? null : t.id) })),
      { label: annots.tool ? "Put the tool down" : "Pen", icon: annots.tool ? "focus" : "edit", run: () => setTool(annots.tool ? null : "ink") },
      "sep",
      { label: "Fit the width", icon: "expand", keys: "Ctrl 0", run: () => view.setScale("width") },
      { label: "Whole page", icon: "shrink", run: () => view.setScale("page") },
      { label: "Turn the view a quarter", icon: "repeat", keys: "R", run: () => view.setSpin(view.spin + 90) },
      "sep",
      annots.canUndo ? { label: "Undo", icon: "undo", keys: "Ctrl Z", run: () => { annots.undo(); drawBar(); } } : null,
      annots.canRedo ? { label: "Redo", icon: "rotateRight", keys: "Ctrl Shift Z", run: () => { annots.redo(); drawBar(); } } : null,
      { label: "Find in this document", icon: "search", keys: "Ctrl F", run: () => openFind() },
      { label: "Pages…", icon: "layers", run: () => openPages() },
      { label: "Send page " + (view.page + 1) + " to a note", icon: "image", run: () => pageToNote(view.page) },
      changed() ? { label: "Save", icon: "check", keys: "Ctrl S", run: () => save() } : null,
    ].filter(Boolean));
  }

  root.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".pdfv-bar, .pdfv-side, .pdfv-stylebar, .pdfv-rail, .pdfa-pop, input, textarea, [contenteditable]")) return;
    e.preventDefault();
    e.stopPropagation();
    const at = annots.at(e);
    if (at) return markMenu(e.clientX, e.clientY, at.page, at.rec);
    const s0 = window.getSelection();
    const text = s0 && !s0.isCollapsed ? String(s0).trim() : "";
    if (text) return selectionMenu(e.clientX, e.clientY, text);
    pageMenu(e.clientX, e.clientY);
  });

  // ── small helpers ────────────────────────────────────────────────────────

  async function busy(msg, fn) {
    const chip = h("div", { class: "pdfv-busy", role: "status" }, h("i", { class: "pdfv-spin" }), h("span", { text: msg }));
    root.append(chip);
    try { return await fn(); }
    catch (e) { toast(`${msg.replace(/…$/, "")} failed: ${(e && e.message) || e}`, { kind: "error", ms: 7000 }); }
    finally { chip.remove(); drawBar(); }
  }

  // Everything above is declarations; the document itself opens last so the
  // first `drawBar()` already has the toolbar's pieces to hand.
  try { await load(null); }
  catch (e) { // nobody gets the destroy() below, and the annotation layer listens on the window
    dead = true;
    if (mgr) mgr.destroy();
    annots.destroy();
    if (thumbs) thumbs.destroy();
    view.destroy();
    throw e;
  }
  if (verdict === "heavy") {
    toast(`${name} is large (${Math.round(bytes.length / 1048576)} MB) — pages are drawn as you reach them, so a jump across the whole file may pause for a moment.`, { ms: 6500 });
  }
  requestAnimationFrame(() => view.scrollEl.focus({ preventScroll: true }));

  return {
    focus: () => view.scrollEl.focus({ preventScroll: true }),
    get dirty() { return changed(); },
    save,
    destroy() {
      dead = true;
      if (mgr) mgr.destroy();
      root.removeEventListener("keydown", onKey);
      annots.destroy();
      if (thumbs) thumbs.destroy();
      const lost = changed();
      const pending = lost ? compose() : null;
      view.destroy();
      host.replaceChildren();
      if (lost) {
        toast(`${name} has unsaved changes — they are not on disk yet`, {
          ms: 12000,
          action: {
            label: "Save now",
            run: async () => {
              try {
                const out = await pending;
                const entry = await app.host.writeFile(path, out);
                if (entry && entry.path) app.vault.files.set(entry.path, entry);
                onSaved && onSaved(entry);
                toast(`${name} saved · the version before this is in .trash`, { ms: 5000 });
              } catch (e) { toast(`Could not save ${name}: ${(e && e.message) || e}`, { kind: "error" }); }
            },
          },
        });
      }
    },
  };
}

// ── a vault file picker, in the style of the note picker ────────────────────

function pickVaultFile(app, re, title) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; cleanup(); resolve(v); };
    const input = h("input", { class: "np-input", placeholder: "Search files…", spellcheck: false });
    const list = h("div", { class: "np-list", role: "listbox" });
    const el = h("div", { class: "np-pop", role: "dialog" },
      h("div", { class: "np-title-bar", text: title }),
      h("div", { class: "np-head" }, icon("search"), input),
      list,
      h("div", { class: "np-foot", text: "↑↓ Enter · Esc to cancel" }));
    const all = [...app.vault.files.values()].filter((f) => re.test(f.path));
    let rows = [], sel = 0;
    function render() {
      const q = input.value.trim();
      rows = (q ? all.map((f) => [fuzzy(q, f.path), f]).filter(([s]) => s).sort((a, b) => b[0].score - a[0].score).map(([, f]) => f) : all.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0))).slice(0, 40);
      sel = 0;
      list.replaceChildren(...rows.map((f, i) =>
        h("button", { class: "np-row" + (i === 0 ? " is-sel" : ""), onclick: () => finish(f.path) },
          icon(f.kind === "image" ? "image" : "fileText"),
          h("span", { class: "np-title", text: fileName(f.path) }),
          h("span", { class: "np-sub", text: f.path.includes("/") ? dirname(f.path) : "vault root" }))));
      if (!rows.length) list.replaceChildren(h("div", { class: "np-empty", text: "Nothing in the vault matches" }));
    }
    const step = (d) => {
      if (!rows.length) return;
      list.children[sel]?.classList.remove("is-sel");
      sel = (sel + d + rows.length) % rows.length;
      list.children[sel].classList.add("is-sel");
      list.children[sel].scrollIntoView({ block: "nearest" });
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); step(-1); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (rows[sel]) finish(rows[sel].path); }
    };
    const onDown = (e) => { if (!el.contains(e.target)) finish(null); };
    const cleanup = () => {
      el.remove();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
    input.addEventListener("input", render);
    render();
    document.getElementById("overlay-root").append(el);
    el.style.left = Math.max(8, innerWidth / 2 - 190) + "px";
    el.style.top = "14vh";
    requestAnimationFrame(() => { el.classList.add("is-in"); input.focus(); });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
  });
}

/** A small modal; `body(close)` builds the contents and calls close(value). */
function smallDialog(title, body) {
  return new Promise((resolve) => {
    const back = h("div", { class: "pdfm-back" });
    const prev = document.activeElement; // focus goes back there when it closes
    const close = (v) => { back.remove(); document.removeEventListener("keydown", esc, true); if (prev && prev.isConnected && prev.focus) prev.focus(); resolve(v); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
    back.append(h("div", { class: "pdfm", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h3", { text: title }), body(close)));
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(null); });
    document.getElementById("overlay-root").append(back);
    document.addEventListener("keydown", esc, true);
    requestAnimationFrame(() => back.classList.add("is-in"));
  });
}
