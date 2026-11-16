// Research boards: an infinite canvas of notes, stickies, web links, pictures
// and groups, saved as JSON Canvas (.canvas) so Obsidian opens the same file.
//
// Speed rules: every card lives in one transformed "world" layer and every
// edge in one SVG, so panning and zooming only rewrite one transform. Card
// bodies render when they come near the viewport, edge geometry is batched
// into animation frames, and nothing runs while the board sits idle.

import { h, basename, dirname } from "./util.js";
import { icon } from "./icons.js";
import { toggleTaskLine, isWebPicture } from "./mdparse.js";
import * as M from "./boardmodel.js";
import { attachmentDir, imageName } from "./images.js";

const SVGNS = "http://www.w3.org/2000/svg";

/** A picture drawn with no button to load it (group background, picture card): one on the web stays out unless the setting is "always" (loading it tells its site who opened the board). */
export const allowedPicture = (url, setting) => (url && isWebPicture(url) && setting !== "always" ? null : url);
/** A CSS url() that reads the address as allowedPicture did. JSON.stringify will not do: its \f is a CSS hex escape, so a broken address could turn into a working one after the check. */
export const cssUrl = (url) => `url("${String(url).replace(/[\\"\u0000-\u001f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;
const MIN_K = 0.08;
const MAX_K = 2.5;
const LOD_K = 0.18; // below this, bodies are unreadable anyway: show titles only
const PAD = 40; // around a group's contents
const MIN_W = 120;
const MIN_H = 60;
const TOP = 56; // room the toolbar takes when framing things
const PRESETS = [["1", "Red"], ["2", "Orange"], ["3", "Yellow"], ["4", "Green"], ["5", "Cyan"], ["6", "Purple"]];
const OPENABLE = new Set(["note", "image", "file", "link"]);

// per board path for this session, and a board clipboard that also works
// between boards when the system clipboard is not available
const lastViews = new Map();
let boardClip = null;

// icons the shared set lacks, in the same 24px stroke style
const LOCAL_ICONS = {
  open: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  sticky: '<path d="M5 5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v9l-6 6H6a1 1 0 0 1-1-1z"/><path d="M13 20v-5a1 1 0 0 1 1-1h5"/>',
  group: '<rect x="3.5" y="6" width="17" height="13.5" rx="2.5" stroke-dasharray="3 2.6"/><path d="M4 3.5h6"/>',
  hand: '<path d="M8 12.5V6.5a1.5 1.5 0 0 1 3 0V11M11 10.5v-6a1.5 1.5 0 0 1 3 0v6M14 10.5V6a1.5 1.5 0 0 1 3 0v7.5c0 4-2.5 6.5-6 6.5-2.6 0-4-1.2-5.3-3.2L3.6 13.3a1.5 1.5 0 0 1 2.5-1.6L8 14"/>',
  pointer: '<path d="M6.5 4l11.5 7-5 1.3 3 5.4-2.3 1.3-3-5.4-3.8 3.6z"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.2"/>',
  map: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><rect x="11.5" y="11" width="6" height="5" rx="1"/>',
  minus: '<path d="M5 12h14"/>',
  noteLinks: '<path d="M7.6 16.4l8.8-8.8" stroke-dasharray="2.2 2.6"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/>',
  arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
};

function ic(name, cls) {
  if (!LOCAL_ICONS[name]) return icon(name, cls);
  const s = document.createElement("span");
  s.className = "ico" + (cls ? " " + cls : "");
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LOCAL_ICONS[name]}</svg>`;
  return s;
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mod = (a, b) => ((a % b) + b) % b;
const typing = (el) => !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
const isNoteNode = (n) => !!n && n.type === "file" && /\.md$/i.test(n.file || "");
const nextTask = () => new Promise((r) => setTimeout(r, 0));
const canScroll = (el, dx, dy) =>
  (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (dy < 0 && el.scrollTop > 0) ||
  (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) || (dx < 0 && el.scrollLeft > 0);
// a sticky's first line as plain words, for far-out titles
const firstLine = (t) => (String(t || "").split("\n").find((l) => l.trim()) || "")
  .replace(/^[#>\-*+\s]+/, "")
  .replace(/^\d+[.)]\s+/, "")
  .replace(/^\[[ xX/-]\]\s*/, "")
  .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, a, b) => b || a)
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/[*_~=`]/g, "")
  .trim()
  .slice(0, 80);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Mount a board into `el`. Resolves once every card exists (built in small
 * slices so a big board never blocks a frame).
 */
export async function mountBoard(el, text, opts = {}) {
  const app = opts.app;
  const vault = app.vault;
  const boardPath = opts.path || "";
  const notify = typeof opts.onChange === "function" ? opts.onChange : () => {};
  const S = app.settings || {};
  const setting = (k, d) => (S[k] === undefined ? d : S[k]);
  const saveSetting = (k, v) => { if (app.setSetting) app.setSetting(k, v); else S[k] = v; };
  const toast = (msg, o) => (app.toast ? app.toast(msg, o) : null);
  const menu = (x, y, items) => app.menu && app.menu(x, y, items.filter((it, i, arr) => it && !(it === "sep" && (i === 0 || arr[i - 1] === "sep" || !arr[i - 1]))));
  const imageUrl = (t, from) => {
    try { return app.imageUrl ? app.imageUrl(t, from) : null; } catch { return null; }
  };

  const parsed = M.parseCanvas(text);
  const canvas = parsed.canvas;
  const original = parsed.error ? null : text;

  /* ── state ────────────────────────────────────────────────────────────── */
  let byId = new Map();
  let edgeById = new Map();
  let edgesOf = new Map(); // node id -> Set(edge ids)
  const cards = new Map(); // node id -> card record
  const lines = new Map(); // edge id -> drawn edge
  const sel = new Set();
  const selEdges = new Set();
  const expanded = new Map(); // node id -> size before "expand"
  const fitOnLoad = new Set(); // new picture cards that take the picture's shape
  let view = { x: 0, y: 0, k: 1 };
  let W = 0;
  let H = 0;
  let lod = false;
  let kk = 1; // zoom compensation for strokes and handles, set when zoom settles
  let undo = [];
  let redo = [];
  let changes = 0;
  let savedAt = 0;
  let tool = setting("boardTool", "hand") === "select" ? "select" : "hand";
  let focusId = null;
  let active = null; // the card being read (text selection, scrolling)
  let showNoteLinks = setting("boardNoteLinks", true) !== false;
  let showMap = !!setting("boardMinimap", false);
  let destroyed = false;
  let needFit = false;
  const search = { q: "", hits: [], at: -1, results: [], pick: -1 };

  /* ── DOM ──────────────────────────────────────────────────────────────── */
  const world = h("div", { class: "bd-world" });
  const groupLayer = h("div", { class: "bd-layer bd-groups" });
  const edgeSvg = svg("svg", { class: "bd-edges", width: "1", height: "1" });
  const noteLinkG = svg("g", { class: "bd-notelinks" });
  const edgeG = svg("g", { class: "bd-edgeg" });
  const preview = svg("path", { class: "bd-preview" });
  const previewHead = svg("path", { class: "bd-preview-head" });
  edgeSvg.append(noteLinkG, edgeG, preview, previewHead);
  const labelLayer = h("div", { class: "bd-layer bd-labels" });
  const cardLayer = h("div", { class: "bd-layer bd-cards" });
  world.append(groupLayer, edgeSvg, labelLayer, cardLayer);

  const grid = h("div", { class: "bd-grid" });
  const band = h("div", { class: "bd-band" });
  band.hidden = true;
  const stage = h("div", { class: "bd-stage" }, grid, world, band);

  const tbtn = (name, title, run) => h("button", { class: "bd-btn", title, onclick: run }, ic(name));
  const selectBtn = tbtn("pointer", "Select (V): drag empty space to select", () => setTool("select"));
  const handBtn = tbtn("hand", "Hand (H): drag empty space to move around", () => setTool("hand"));
  const searchInput = h("input", { class: "bd-search-in", type: "text", placeholder: "Search board, add notes" });
  searchInput.spellcheck = false;
  const searchCount = h("span", { class: "bd-search-count" });
  const searchBox = h("label", { class: "bd-search" }, ic("search"), searchInput, searchCount, h("kbd", { class: "bd-search-kbd", text: "Ctrl F" }));
  const results = h("div", { class: "bd-results" });
  results.hidden = true;
  const searchWrap = h("div", { class: "bd-search-wrap" }, searchBox, results);
  const linksBtn = tbtn("noteLinks", "Show links between notes as dashed lines", () => toggleNoteLinks());
  // cards read as rendered Markdown (preview) or as the text written (source), like a note
  let source = S.boardSource === true;
  const srcBtn = tbtn("code", "Source or preview: the cards' text as written, or rendered (Ctrl+E)", () => toggleSource());
  srcBtn.classList.toggle("is-on", source);
  // how big the cards' text is, so a board reads without zooming in
  let textScale = Number(S.boardTextScale) || 1;
  const focusChip = h("button", { class: "bd-focus-chip", title: "Leave focus (Esc)", onclick: () => setFocus(null) });
  focusChip.hidden = true;
  const toolbar = h("div", { class: "bd-toolbar" },
    h("div", { class: "bd-seg" }, selectBtn, handBtn),
    h("span", { class: "bd-sep" }),
    tbtn("sticky", "Sticky note (N, or double-click empty space)", () => addSticky()),
    tbtn("group", "Group the selection (Ctrl+G)", () => groupSelection(true)),
    tbtn("grid", "Arrange", (e) => arrangeMenu(e.currentTarget)),
    h("span", { class: "bd-sep" }),
    searchWrap,
    srcBtn,
    linksBtn,
    tbtn("more", "More", (e) => moreMenu(e.currentTarget)),
    focusChip);

  const zoomLabel = h("button", { class: "bd-zoom-pct", title: "Back to 100% (0)", onclick: () => zoomTo(1) }, "100%");
  const mapBtn = tbtn("map", "Minimap", () => toggleMap());
  const zoombar = h("div", { class: "bd-zoombar" },
    tbtn("minus", "Zoom out (-)", () => zoomBy(0.8)), zoomLabel, tbtn("plus", "Zoom in (+)", () => zoomBy(1.25)),
    h("span", { class: "bd-sep" }), tbtn("fit", "Zoom to fit (Shift+1)", () => fitAll()), mapBtn);

  const mapCanvas = h("canvas", { class: "bd-map-canvas" });
  const mapView = h("div", { class: "bd-map-view" });
  const minimap = h("div", { class: "bd-map" }, mapCanvas, mapView);
  minimap.hidden = !showMap;

  const selbar = h("div", { class: "bd-selbar" });
  selbar.hidden = true;
  const notice = h("div", { class: "bd-notice" });
  notice.hidden = true;
  const empty = h("div", { class: "bd-empty" },
    h("div", { class: "bd-empty-title", text: "A blank research board" }),
    h("div", { class: "bd-empty-sub", text: "Drag notes in from the sidebar, search above to add them, or double-click anywhere to write a sticky." }));
  empty.hidden = true;
  const colorInput = h("input", { type: "color", class: "bd-color-in", tabindex: "-1" });
  const root = h("div", { class: "board", tabindex: "0" }, stage, toolbar, zoombar, minimap, selbar, notice, empty, colorInput);
  root.style.setProperty("--bc-text", String(textScale));
  root.classList.toggle("lod-titles", S.boardLodTitles === true);
  root.classList.toggle("is-source", source);
  el.replaceChildren(root);

  /* ── model index ──────────────────────────────────────────────────────── */
  function reindex() {
    byId = new Map(canvas.nodes.map((n) => [n.id, n]));
    edgeById = new Map();
    edgesOf = new Map();
    for (const e of canvas.edges) {
      edgeById.set(e.id, e);
      for (const id of [e.fromNode, e.toNode]) {
        if (!edgesOf.has(id)) edgesOf.set(id, new Set());
        edgesOf.get(id).add(e.id);
      }
    }
  }

  const snapshot = () => JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges });

  function changed() {
    changes++;
    schedule("map");
    notify();
  }

  /** Record `before` as an undo step if anything actually changed. */
  function commit(before) {
    if (snapshot() === before) return false;
    undo.push(before);
    if (undo.length > 150) undo.shift();
    redo = [];
    changed();
    return true;
  }

  // overlapping cards: the picked ones drawn above the rest, or under them (as in Sketch); groups keep their place
  function restack(front) {
    const ids = new Set(selectedNodes().filter((n) => n.type !== "group").map((n) => n.id));
    if (!ids.size) return;
    edit(() => {
      const moving = canvas.nodes.filter((n) => ids.has(n.id)), rest = canvas.nodes.filter((n) => !ids.has(n.id));
      // to the back, but still after the groups: in the file the first is drawn lowest (Obsidian draws it so)
      canvas.nodes = front ? [...rest, ...moving] : [...rest.filter((n) => n.type === "group"), ...moving, ...rest.filter((n) => n.type !== "group")];
    });
  }

  /** Run a model change as one undo step and bring the DOM up to date. */
  function edit(fn) {
    const before = snapshot();
    const r = fn();
    syncAll();
    commit(before);
    return r;
  }

  function restore(s) {
    const d = JSON.parse(s);
    canvas.nodes = d.nodes;
    canvas.edges = d.edges;
    syncAll();
    changed();
  }

  function undoStep() {
    if (editing()) return;
    const s = undo.pop();
    if (!s) return;
    redo.push(snapshot());
    restore(s);
  }

  function redoStep() {
    if (editing()) return;
    const s = redo.pop();
    if (!s) return;
    undo.push(snapshot());
    restore(s);
  }

  // a note or picture renamed elsewhere: follow it, in history too
  function renamePath(from, to) {
    let hit = false;
    for (const n of canvas.nodes) if (n.type === "file" && n.file === from) { n.file = to; hit = true; }
    const a = JSON.stringify(from);
    const b = JSON.stringify(to);
    const fix = (s) => (s.includes(a) ? s.split(a).join(b) : s);
    undo = undo.map(fix);
    redo = redo.map(fix);
    if (hit) { syncAll(); changed(); }
  }

  let resolveCache = new Map();
  function resolveLink(target, from) {
    const key = from + "\n" + target;
    let r = resolveCache.get(key);
    if (r === undefined) {
      if (resolveCache.size > 100000) resolveCache = new Map();
      r = vault.resolve(target, from) || null;
      resolveCache.set(key, r);
    }
    return r;
  }

  /* ── frame scheduler: all DOM work coalesces into one rAF ───────────────── */
  const jobs = new Set();
  let raf = 0;
  function schedule(job) {
    if (destroyed) return;
    jobs.add(job);
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    if (destroyed) return;
    const j = new Set(jobs);
    jobs.clear();
    if (j.has("notelinks")) rebuildNoteLinks();
    if (j.has("edges") || j.has("notelinks")) flushEdges();
    if (j.has("visible")) updateVisible();
    if (j.has("render")) renderQueue();
    if (j.has("map")) drawMap();
    if (j.has("selbar")) placeSelBar();
  }

  /* ── view ─────────────────────────────────────────────────────────────── */
  let settleTimer = 0;
  let zoomed = false;
  let anim = 0;
  let rootRect = null;
  const rect = () => rootRect || (rootRect = root.getBoundingClientRect());
  const toWorld = (cx, cy) => {
    const r = rect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  const viewCentre = () => ({ x: (W / 2 - view.x) / view.k, y: ((H + TOP) / 2 - view.y) / view.k });
  let lastPointer = null;
  function pointerWorld() {
    const r = rect();
    if (lastPointer && lastPointer.x >= r.left && lastPointer.x <= r.right && lastPointer.y >= r.top && lastPointer.y <= r.bottom) {
      return toWorld(lastPointer.x, lastPointer.y);
    }
    return viewCentre();
  }

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    let s = 24 * view.k;
    while (s < 14) s *= 2;
    while (s > 48) s /= 2;
    grid.style.backgroundSize = `${s}px ${s}px`;
    grid.style.backgroundPosition = `${mod(view.x, s)}px ${mod(view.y, s)}px`;
    const pct = Math.round(view.k * 100) + "%";
    if (zoomLabel.textContent !== pct) zoomLabel.textContent = pct;
    // a little hysteresis: hovering exactly on the threshold (a trackpad
    // pinch does) must not flip bodies and titles back and forth
    const nl = lod ? view.k < LOD_K * 1.12 : view.k < LOD_K;
    if (nl !== lod) {
      lod = nl;
      root.classList.toggle("is-lod", lod);
      root.style.setProperty("--lk", String(clamp(view.k, 0.12, LOD_K)));
    }
    if (boardPath) lastViews.set(boardPath, { ...view });
    schedule("visible");
    if (showMap) schedule("map");
    if (!selbar.hidden) selbar.hidden = true;
    root.classList.add("is-moving");
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 140);
  }

  function settle() {
    settleTimer = 0;
    if (destroyed) return;
    root.classList.remove("is-moving");
    const nk = Math.round(clamp(view.k, 0.3, 1.6) * 100) / 100;
    if (nk !== kk) {
      kk = nk;
      root.style.setProperty("--kk", String(kk));
      for (const id of lines.keys()) dirtyEdges.add(id);
      for (const pr of nlPairs) pr.dirty = true;
      schedule("edges");
    }
    if (lod) root.style.setProperty("--lk", String(clamp(view.k, 0.12, LOD_K)));
    if (zoomed) {
      // a composited layer keeps the raster scale it started with; drop the
      // hint for a frame so text comes back crisp at the new zoom
      zoomed = false;
      world.classList.add("is-crisp");
      requestAnimationFrame(() => requestAnimationFrame(() => world.classList.remove("is-crisp")));
    }
    schedule("selbar");
  }

  function setView(v) {
    view = { x: v.x, y: v.y, k: clamp(v.k, MIN_K, MAX_K) };
    zoomed = true;
    applyView();
  }

  function zoomAt(sx, sy, factor) {
    const k = clamp(view.k * factor, MIN_K, MAX_K);
    if (k === view.k) return;
    const wx = (sx - view.x) / view.k;
    const wy = (sy - view.y) / view.k;
    view = { x: sx - wx * k, y: sy - wy * k, k };
    zoomed = true;
    applyView();
  }

  function animateTo(to, ms = 260) {
    cancelAnimationFrame(anim);
    const from = { ...view };
    to = { ...to, k: clamp(to.k, MIN_K, MAX_K) };
    const cx = W / 2;
    const cy = H / 2;
    const c0 = [(cx - from.x) / from.k, (cy - from.y) / from.k];
    const c1 = [(cx - to.x) / to.k, (cy - to.y) / to.k];
    const t0 = performance.now();
    if (to.k !== from.k) zoomed = true;
    const step = (now) => {
      if (destroyed) return;
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      // zoom moves in log space, the centre in a straight line: feels even
      const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
      const wx = c0[0] + (c1[0] - c0[0]) * e;
      const wy = c0[1] + (c1[1] - c0[1]) * e;
      view = { k, x: cx - wx * k, y: cy - wy * k };
      applyView();
      anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    anim = requestAnimationFrame(step);
  }

  function viewFor(r, maxK = 1) {
    const pad = 56;
    const aw = Math.max(80, W - pad * 2);
    const ah = Math.max(80, H - pad * 2 - TOP);
    const k = clamp(Math.min(aw / Math.max(1, r.width), ah / Math.max(1, r.height), maxK), MIN_K, MAX_K);
    return { k, x: W / 2 - (r.x + r.width / 2) * k, y: TOP + (H - TOP) / 2 - (r.y + r.height / 2) * k };
  }

  function fitAll(animate = true) {
    if (!W || !H) { needFit = true; return; }
    const b = M.bounds(canvas.nodes);
    const v = b ? viewFor(b) : { k: 1, x: W / 2, y: H / 2 };
    if (animate) animateTo(v);
    else setView(v);
  }

  function fitSelection() {
    const b = M.bounds([...sel].map((id) => byId.get(id)));
    if (b) animateTo(viewFor(b, 1.5));
  }

  /** Bring a card into view, keeping the zoom unless it cannot fit. */
  function reveal(r, force = false) {
    if (!r || !W) return;
    const sx = r.x * view.k + view.x;
    const sy = r.y * view.k + view.y;
    const inside = sx >= 0 && sy >= TOP && sx + r.width * view.k <= W && sy + r.height * view.k <= H;
    if (inside && !force) return;
    const fits = r.width * view.k <= W - 80 && r.height * view.k <= H - TOP - 40;
    const k = fits ? Math.max(view.k, 0.35) : viewFor(r).k;
    animateTo({ k, x: W / 2 - (r.x + r.width / 2) * k, y: TOP + (H - TOP) / 2 - (r.y + r.height / 2) * k });
  }

  const zoomBy = (f) => {
    const k = clamp(view.k * f, MIN_K, MAX_K);
    const c = [(W / 2 - view.x) / view.k, (H / 2 - view.y) / view.k];
    animateTo({ k, x: W / 2 - c[0] * k, y: H / 2 - c[1] * k }, 180);
  };
  const zoomTo = (k) => zoomBy(k / view.k);

  /* ── visibility and lazy bodies ───────────────────────────────────────── */
  const renderQ = new Set();
  let lastVisibleAt = 0;

  function updateVisible() {
    if (!W || !H) return;
    // A generous skirt around the viewport: cards are awake well before they
    // scroll in, so an ordinary pan never shows an empty frame.
    const mx = W * 0.6;
    const my = H * 0.6;
    const x0 = (-view.x - mx) / view.k;
    const y0 = (-view.y - my) / view.k;
    const x1 = (W + mx - view.x) / view.k;
    const y1 = (H + my - view.y) / view.k;
    // Waking a card costs layout and paint, so a huge reveal is spread over
    // frames - but nearest first, so the holes fill from the middle outwards
    // instead of at random, which is what made cards seem to blink in and out.
    const now = performance.now();
    const gap = now - lastVisibleAt;
    lastVisibleAt = now;
    let budget = anim || gap > 30 ? 24 : 120;
    const cx = (W / 2 - view.x) / view.k;
    const cy = ((H + TOP) / 2 - view.y) / view.k;
    let wake = null;
    for (const c of cards.values()) {
      const n = c.node;
      const vis = c.editing || (n.x < x1 && n.x + n.width > x0 && n.y < y1 && n.y + n.height > y0);
      if (vis === c.vis) continue;
      if (!vis) { // going to sleep is free
        c.vis = false;
        c.el.classList.add("is-off");
        continue;
      }
      (wake || (wake = [])).push(c);
    }
    if (!wake) return;
    if (wake.length > budget) {
      const near = (c) => Math.hypot(c.node.x + c.node.width / 2 - cx, c.node.y + c.node.height / 2 - cy);
      wake.sort((a, b) => near(a) - near(b));
    }
    for (const c of wake) {
      if (budget-- <= 0) break;
      c.vis = true;
      c.el.classList.remove("is-off");
      if (c.stale) queueRender(c);
    }
    if (budget < 0) schedule("visible");
  }

  function queueRender(c) {
    renderQ.add(c);
    schedule("render");
  }

  function renderQueue() {
    const t0 = performance.now();
    for (const c of renderQ) {
      renderQ.delete(c);
      if (!c.vis || !cards.has(c.id) || !c.stale) continue;
      renderBody(c);
      if (performance.now() - t0 > 8) break;
    }
    if (renderQ.size) schedule("render");
  }

  // dataviewjs, run in a sandboxed frame (dataview.js), loaded the first time a card has some
  function runDv(el, current) {
    import("./dataview.js").then((m) => { m.forgetFrames(); m.runDataview(el, { app, current }); }).catch(() => {});
  }

  function markStale(c) {
    c.stale = true;
    if (c.vis) queueRender(c);
  }

  function toggleSource() {
    source = !source;
    saveSetting("boardSource", source);
    srcBtn.classList.toggle("is-on", source);
    root.classList.toggle("is-source", source);
    for (const c of cards.values()) if (c.kind === "note" || c.kind === "text") markStale(c);
  }
  function setTextScale(v) {
    textScale = v;
    saveSetting("boardTextScale", v);
    root.style.setProperty("--bc-text", String(v));
  }

  /* ── cards ────────────────────────────────────────────────────────────── */
  const TPL = {};
  const ACTS = {
    note: [["open", "open", "Open in a tab (double-click)"], ["links", "graph", "Add linked notes around it (L)"], ["focus", "focus", "Focus on its connections (F)"], ["expand", "", "Expand to read"], ["more", "more", "More"], ["remove", "x", "Remove from board"]],
    image: [["open", "open", "Open"], ["more", "more", "More"], ["remove", "x", "Remove from board"]],
    file: [["open", "open", "Open"], ["more", "more", "More"], ["remove", "x", "Remove from board"]],
    link: [["more", "more", "More"], ["remove", "x", "Remove from board"]],
    text: [["more", "more", "More"]],
    unknown: [["more", "more", "More"]],
  };

  function template(kind) {
    if (TPL[kind]) return TPL[kind];
    const tail = () => [h("div", { class: "bc-resize" }), ["top", "right", "bottom", "left"].map((side) => h("div", { class: "bc-h", dataset: { side } }))];
    let el;
    if (kind === "group") {
      el = h("div", { class: "bc k-group is-off" }, h("div", { class: "bg-label" }, h("span", { class: "bg-name" })), tail());
    } else if (kind === "note" || kind === "image" || kind === "file") {
      el = h("div", { class: `bc k-${kind} is-off` },
        h("div", { class: "bc-head" },
          ic(kind === "note" ? "fileText" : kind === "image" ? "image" : "file", "bc-ico"),
          h("div", { class: "bc-titles" }, h("span", { class: "bc-title" }), h("span", { class: "bc-sub" }))),
        h("div", { class: "bc-body" + (kind === "note" ? " bc-md" : "") }),
        tail());
    } else {
      el = h("div", { class: `bc k-${kind} is-off` }, h("div", { class: "bc-body" + (kind === "link" ? "" : " bc-md") }), tail());
    }
    return (TPL[kind] = el);
  }

  // hover actions are most of a card's elements: built on first hover or
  // selection, so hundreds of cards stay light
  function ensureActs(c) {
    if (c.acts || !ACTS[c.kind]) return;
    const key = "acts-" + c.kind;
    if (!TPL[key]) {
      TPL[key] = h("div", { class: "bc-acts" },
        ACTS[c.kind].map(([act, name, title]) => h("button", { class: "bc-act", dataset: { act }, title, tabindex: "-1" },
          act === "expand" ? [ic("expand", "if-small"), ic("shrink", "if-big")] : ic(name))));
    }
    c.acts = TPL[key].cloneNode(true);
    (c.el.querySelector(".bc-head") || c.el).append(c.acts);
  }

  function makeCard(n) {
    const kind = M.kindOf(n);
    const el = template(kind).cloneNode(true);
    el.dataset.id = n.id;
    const c = {
      id: n.id, node: n, kind, el,
      body: el.querySelector(".bc-body"),
      title: el.querySelector(".bc-title"),
      sub: el.querySelector(".bc-sub"),
      label: el.querySelector(".bg-name"),
      vis: false, stale: true, editing: false, p: {},
    };
    cards.set(n.id, c);
    paint(c);
    return c;
  }

  function dropCard(c) {
    c.el.remove();
    cards.delete(c.id);
    renderQ.delete(c);
    painted.delete(c.id);
    if (active === c.id) active = null;
  }

  const contentSig = (n) => [n.type, n.text, n.file, n.subpath, n.url, n.label, n.background, n.backgroundStyle].join("\u0001");

  function paintPos(c) {
    const n = c.node;
    if (c.p.x !== n.x || c.p.y !== n.y) {
      c.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      c.p.x = n.x;
      c.p.y = n.y;
    }
  }

  function paintSize(c) {
    const n = c.node;
    if (c.p.w !== n.width) { c.el.style.width = n.width + "px"; c.p.w = n.width; }
    if (c.p.h !== n.height) { c.el.style.height = n.height + "px"; c.p.h = n.height; }
  }

  function paint(c) {
    const n = c.node;
    paintPos(c);
    paintSize(c);
    if (c.p.color !== n.color) {
      const v = M.colorVar(n.color);
      if (v) c.el.style.setProperty("--c", v);
      else c.el.style.removeProperty("--c");
      c.el.classList.toggle("has-c", !!v);
      c.p.color = n.color;
    }
    const sig = contentSig(n);
    if (c.p.sig !== sig) {
      c.p.sig = sig;
      fillStatic(c);
      markStale(c);
    }
  }

  function noteTitle(n) {
    const note = vault.get(n.file);
    return (note ? note.title : basename(n.file || "")) || "Untitled";
  }

  // the cheap parts of a card: titles, labels, chips. Bodies wait for view.
  function fillStatic(c) {
    const n = c.node;
    const el = c.el;
    switch (c.kind) {
      case "note": {
        const note = vault.get(n.file);
        const title = noteTitle(n);
        const sub = n.subpath ? n.subpath.replace(/^#\^?/, "").replace(/#/g, " › ") : "";
        c.title.textContent = title;
        c.sub.textContent = [dirname(n.file), sub].filter(Boolean).join(" › ");
        el.classList.toggle("is-missing", !note);
        el.dataset.title = title + (sub ? " › " + sub : "");
        el.classList.toggle("is-expanded", expanded.has(c.id));
        break;
      }
      case "image":
      case "file": {
        const name = n.file.slice(n.file.lastIndexOf("/") + 1) || "File";
        c.title.textContent = name;
        c.sub.textContent = dirname(n.file);
        el.classList.toggle("is-missing", !vault.files.has(n.file));
        el.dataset.title = name;
        if (c.kind === "file") {
          const f = vault.files.get(n.file);
          const ext = (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "file").toUpperCase().slice(0, 4);
          const what = !f ? "Not in the vault" : f.kind === "pdf" ? "PDF document" : f.kind === "office" ? "Office document" : f.kind === "media" ? "Audio or video" : f.kind === "text" ? "Text file" : /\.canvas$/i.test(name) ? "Board" : "File";
          c.body.replaceChildren(h("div", { class: "bf" },
            h("div", { class: "bf-ext", text: ext }),
            h("div", { class: "bf-text" }, h("div", { class: "bf-name", text: name }), h("div", { class: "bf-kind", text: what })),
            f ? h("button", { class: "bf-open", dataset: { act: "open" }, tabindex: "-1" }, "Open") : null));
        }
        break;
      }
      case "link": {
        let host = n.url || "";
        let rest = "";
        try {
          const u = new URL(n.url);
          host = u.hostname.replace(/^www\./, "");
          rest = (u.pathname + u.search).replace(/^\/$/, "");
        } catch {}
        c.body.replaceChildren(
          h("div", { class: "bl-ico" }, ic("link")),
          h("div", { class: "bl-text" }, h("div", { class: "bl-host", text: host || "Web link" }), h("div", { class: "bl-url", text: rest || n.url || "" })),
          h("button", { class: "bl-open", dataset: { act: "open" }, title: "Open in the browser", tabindex: "-1" }, ic("open")));
        el.dataset.title = host;
        break;
      }
      case "group": {
        c.label.textContent = n.label || "";
        el.classList.toggle("has-label", !!n.label);
        el.dataset.title = n.label || "";
        const url = n.background ? allowedPicture(imageUrl(n.background, boardPath), S.webPictures) : null;
        if (url) {
          el.style.setProperty("--bg-img", cssUrl(url));
          el.dataset.bgStyle = n.backgroundStyle || "cover";
        } else {
          el.style.removeProperty("--bg-img");
          delete el.dataset.bgStyle;
        }
        break;
      }
      case "text":
        el.dataset.title = firstLine(n.text);
        break;
      default:
        c.body.replaceChildren(h("p", { class: "bc-placeholder", text: `A "${n.type}" card Leonote cannot show. It is kept as it is.` }));
    }
  }

  // the expensive part, only for cards near the viewport
  function renderBody(c) {
    c.stale = false;
    const n = c.node;
    if (c.kind === "note") {
      const note = vault.get(n.file);
      if (!note) {
        // moved while the board was closed: a note of that name elsewhere is offered, one click points the card there
        const name = basename(String(n.file || "")).replace(/\.md$/i, "");
        const found = name && resolveLink(name, boardPath);
        c.body.replaceChildren(h("p", { class: "bc-placeholder", text: "This note is not in the vault. It may have been moved or deleted." }),
          found && found !== n.file ? h("button", { class: "chip-btn", title: found, onclick: (e) => { e.stopPropagation(); edit(() => { const cur = byId.get(n.id); if (cur) cur.file = found; }); fillStatic(c); markStale(c); } }, `Found at ${found.replace(/\.md$/i, "")} - point the card there`) : null);
        return;
      }
      const sec = M.sectionOf(note.content, n.subpath);
      if (source) { c.body.replaceChildren(h("pre", { class: "bc-src", text: sec.text || "" })); return; }
      const html = M.mdToHtml(sec.text, { resolve: (t) => resolveLink(t, n.file), image: (t) => imageUrl(t, n.file), offset: sec.offset, webPictures: S.webPictures === "always" });
      c.body.innerHTML = html || '<p class="bc-placeholder">Empty note</p>';
      if (html.includes('data-lang="dataview')) runDv(c.body, n.file);
      if (sec.missing) c.body.prepend(h("p", { class: "bc-placeholder", text: `No "${n.subpath}" in this note, showing all of it.` }));
    } else if (c.kind === "text") {
      if (c.editing) return;
      const t = n.text || "";
      if (!t.trim()) c.body.innerHTML = '<p class="bc-placeholder">Empty sticky. Double-click to write.</p>';
      else if (source) c.body.replaceChildren(h("pre", { class: "bc-src", text: t }));
      else {
        c.body.innerHTML = M.mdToHtml(t, { resolve: (x) => resolveLink(x, boardPath), image: (x) => imageUrl(x, boardPath), webPictures: S.webPictures === "always" });
        if (/```\s*dataview/i.test(t)) runDv(c.body, boardPath);
      }
    } else if (c.kind === "image") {
      const url = vault.files.has(n.file) || !vault.files.size ? allowedPicture(imageUrl(n.file, boardPath), S.webPictures) : null;
      if (!url) {
        c.body.replaceChildren(h("p", { class: "bc-placeholder", text: "Picture not found in the vault" }));
        return;
      }
      let img = c.body.querySelector("img");
      if (!img) {
        img = h("img", { class: "bc-img", alt: "", decoding: "async" });
        img.draggable = false;
        img.addEventListener("load", () => fitImage(c, img));
        c.body.replaceChildren(img);
      }
      if (img.getAttribute("src") !== url) img.src = url;
    }
  }

  // a freshly added picture takes the picture's proportions
  function fitImage(c, img) {
    if (!fitOnLoad.has(c.id) || !img.naturalWidth) return;
    fitOnLoad.delete(c.id);
    const n = byId.get(c.id);
    if (!n) return;
    const head = c.el.querySelector(".bc-head");
    const hh = head ? head.offsetHeight : 0;
    n.height = Math.round(n.width * (img.naturalHeight / img.naturalWidth) + hh);
    paintSize(c);
    dirtyNode(c.id);
    schedule("edges");
    changed();
  }

  function orderGroups() {
    const groups = canvas.nodes.filter((n) => n.type === "group").sort((a, b) => b.width * b.height - a.width * a.height);
    let prev = null;
    for (const g of groups) {
      const c = cards.get(g.id);
      if (!c) continue;
      const want = prev ? prev.nextSibling : groupLayer.firstChild;
      if (want !== c.el) groupLayer.insertBefore(c.el, want);
      prev = c.el;
    }
  }

  /** Bring the DOM in line with the model after any discrete change. */
  function syncAll() {
    reindex();
    for (const c of [...cards.values()]) {
      const n = byId.get(c.id);
      if (!n || M.kindOf(n) !== c.kind) dropCard(c);
    }
    let prev = null;
    for (const n of canvas.nodes) {
      let c = cards.get(n.id);
      if (!c) c = makeCard(n);
      else if (c.node !== n) { c.node = n; paint(c); }
      else paint(c);
      if (c.kind === "group") {
        if (!c.el.parentNode) groupLayer.append(c.el);
        continue;
      }
      const want = prev ? prev.nextSibling : cardLayer.firstChild;
      if (want !== c.el) cardLayer.insertBefore(c.el, want);
      prev = c.el;
    }
    orderGroups();
    for (const [id, l] of [...lines]) {
      if (!edgeById.has(id)) {
        l.g.remove();
        if (l.label) l.label.remove();
        lines.delete(id);
        paintedEdges.delete(id);
      }
    }
    for (const e of canvas.edges) {
      if (!lines.has(e.id)) makeLine(e);
      dirtyEdges.add(e.id);
    }
    for (const id of [...sel]) if (!byId.has(id)) sel.delete(id);
    for (const id of [...selEdges]) if (!edgeById.has(id)) selEdges.delete(id);
    for (const id of [...expanded.keys()]) if (!byId.has(id)) expanded.delete(id);
    if (focusId && !byId.has(focusId)) setFocus(null);
    paintSelection();
    empty.hidden = canvas.nodes.length > 0;
    schedule("notelinks");
    schedule("edges");
    schedule("visible");
    schedule("selbar");
    if (focusId) setFocus(focusId, false);
    if (search.q) runSearch(true);
  }

  /* ── edges ────────────────────────────────────────────────────────────── */
  const dirtyNodes = new Set();
  const dirtyEdges = new Set();
  const dirtyNode = (id) => dirtyNodes.add(id);
  const arrowSize = () => Math.round((11 / kk) * 10) / 10;
  let svgKey = "";

  function makeLine(e) {
    const g = svg("g", { class: "bd-edge" });
    g.dataset.id = e.id;
    const hit = svg("path", { class: "bd-hit" });
    const path = svg("path", { class: "bd-line" });
    g.append(hit, path);
    edgeG.append(g);
    const l = { id: e.id, g, hit, path, heads: [], label: null, mid: [0, 0], p: {} };
    lines.set(e.id, l);
    return l;
  }

  function drawLine(l) {
    const e = edgeById.get(l.id);
    const a = e && byId.get(e.fromNode);
    const b = e && byId.get(e.toNode);
    if (!a || !b) { l.g.style.display = "none"; return; }
    l.g.style.display = "";
    const geo = M.edgeGeometry(a, b, e.fromSide, e.toSide, { fromEnd: e.fromEnd || "none", toEnd: e.toEnd || "arrow", arrow: arrowSize() });
    l.path.setAttribute("d", geo.d);
    l.hit.setAttribute("d", geo.d);
    while (l.heads.length < geo.arrows.length) {
      const p = svg("path", { class: "bd-head" });
      l.g.append(p);
      l.heads.push(p);
    }
    while (l.heads.length > geo.arrows.length) l.heads.pop().remove();
    geo.arrows.forEach((d, i) => l.heads[i].setAttribute("d", d));
    l.mid = geo.mid;
    if (l.p.color !== e.color) {
      const v = M.colorVar(e.color);
      for (const x of [l.g, l.label]) if (x) v ? x.style.setProperty("--c", v) : x.style.removeProperty("--c");
      l.g.classList.toggle("has-c", !!v);
      l.p.color = e.color;
    }
    if (e.label) {
      if (!l.label) {
        l.label = h("div", { class: "bd-label", dataset: { id: e.id } });
        const v = M.colorVar(e.color);
        if (v) l.label.style.setProperty("--c", v);
        l.label.classList.toggle("is-sel", selEdges.has(e.id));
        labelLayer.append(l.label);
        l.p.label = null;
      }
      if (l.p.label !== e.label) { l.label.textContent = e.label; l.p.label = e.label; }
      l.label.style.transform = `translate(${geo.mid[0]}px, ${geo.mid[1]}px) translate(-50%, -50%)`;
    } else if (l.label) {
      l.label.remove();
      l.label = null;
    }
  }

  function flushEdges() {
    for (const id of dirtyNodes) {
      const es = edgesOf.get(id);
      if (es) for (const eid of es) dirtyEdges.add(eid);
      const prs = nlOf.get(id);
      if (prs) for (const pr of prs) pr.dirty = true;
    }
    dirtyNodes.clear();
    for (const eid of dirtyEdges) {
      const l = lines.get(eid);
      if (l) drawLine(l);
    }
    dirtyEdges.clear();
    for (const pr of nlPairs) if (pr.dirty) drawPair(pr);
    fitSvg();
  }

  // the SVG covers all cards (plus room for curves), in coarse steps so its
  // box rarely changes
  function fitSvg() {
    const b = M.bounds(canvas.nodes) || { x: 0, y: 0, width: 0, height: 0 };
    const q = 512;
    const x0 = Math.floor((b.x - 400) / q) * q;
    const y0 = Math.floor((b.y - 400) / q) * q;
    const x1 = Math.ceil((b.x + b.width + 400) / q) * q;
    const y1 = Math.ceil((b.y + b.height + 400) / q) * q;
    const key = `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
    if (key === svgKey) return;
    svgKey = key;
    edgeSvg.setAttribute("viewBox", key);
    edgeSvg.setAttribute("width", String(x1 - x0));
    edgeSvg.setAttribute("height", String(y1 - y0));
    edgeSvg.style.transform = `translate(${x0}px, ${y0}px)`;
  }

  const connected = (a, b) => {
    const es = edgesOf.get(a);
    if (!es) return false;
    for (const id of es) {
      const e = edgeById.get(id);
      if ((e.fromNode === a && e.toNode === b) || (e.fromNode === b && e.toNode === a)) return true;
    }
    return false;
  };

  /* ── note links: real [[links]] between note cards, drawn faint ───────── */
  let nlPairs = [];
  let nlOf = new Map();
  let nlSig = "";

  function rebuildNoteLinks() {
    const onBoard = new Map();
    if (showNoteLinks) {
      for (const n of canvas.nodes) {
        if (!isNoteNode(n) || !vault.get(n.file)) continue;
        if (!onBoard.has(n.file)) onBoard.set(n.file, []);
        onBoard.get(n.file).push(n);
      }
    }
    let sig = showNoteLinks ? "1" : "0";
    for (const [p, list] of onBoard) sig += "|" + p + ":" + list.map((n) => n.id).join(",");
    sig += "#" + canvas.edges.map((e) => e.fromNode + e.toNode).join(",");
    if (sig === nlSig) return;
    nlSig = sig;
    noteLinkG.replaceChildren();
    nlPairs = [];
    nlOf = new Map();
    if (onBoard.size < 2) return;
    const frag = document.createDocumentFragment();
    const dist = (a, b) => Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
    outer: for (const [p, list] of onBoard) {
      const seen = new Set();
      for (const l of vault.get(p).links) {
        const to = resolveLink(l.target, p);
        if (!to || to === p || seen.has(to) || !onBoard.has(to)) continue;
        seen.add(to);
        // one line per linked pair of notes, between their closest cards,
        // however many copies of each the board holds
        let best = null;
        let joined = false;
        for (const a of list) {
          for (const b of onBoard.get(to)) {
            if (connected(a.id, b.id)) { joined = true; break; }
            const d = dist(a, b);
            if (!best || d < best.d) best = { a, b, d };
          }
          if (joined) break;
        }
        if (joined || !best) continue;
        const pr = { a: best.a.id, b: best.b.id, path: svg("path", { class: "bd-nl" }), head: svg("path", { class: "bd-nl-head" }), dirty: true };
        frag.append(pr.path, pr.head);
        nlPairs.push(pr);
        for (const id of [pr.a, pr.b]) {
          if (!nlOf.has(id)) nlOf.set(id, []);
          nlOf.get(id).push(pr);
        }
        if (nlPairs.length >= 1500) break outer;
      }
    }
    noteLinkG.append(frag);
    // dashes are costly to paint; past a few hundred lines draw them solid
    noteLinkG.classList.toggle("is-many", nlPairs.length > 300);
    if (focusId) setFocus(focusId, false);
  }

  function drawPair(pr) {
    pr.dirty = false;
    const a = byId.get(pr.a);
    const b = byId.get(pr.b);
    if (!a || !b) return;
    const geo = M.edgeGeometry(a, b, null, null, { arrow: arrowSize() * 0.75 });
    pr.path.setAttribute("d", geo.d);
    pr.head.setAttribute("d", geo.arrows[0]);
  }

  function toggleNoteLinks() {
    showNoteLinks = !showNoteLinks;
    saveSetting("boardNoteLinks", showNoteLinks);
    linksBtn.classList.toggle("is-on", showNoteLinks);
    schedule("notelinks");
  }

  /* ── selection ────────────────────────────────────────────────────────── */
  const painted = new Set();
  const paintedEdges = new Set();

  function paintSelection() {
    for (const id of [...painted]) {
      if (sel.has(id)) continue;
      const c = cards.get(id);
      if (c) c.el.classList.remove("is-sel");
      painted.delete(id);
    }
    for (const id of sel) {
      if (painted.has(id)) continue;
      const c = cards.get(id);
      if (c) { ensureActs(c); c.el.classList.add("is-sel"); painted.add(id); }
    }
    for (const id of [...paintedEdges]) {
      if (selEdges.has(id)) continue;
      const l = lines.get(id);
      if (l) { l.g.classList.remove("is-sel"); if (l.label) l.label.classList.remove("is-sel"); }
      paintedEdges.delete(id);
    }
    for (const id of selEdges) {
      if (paintedEdges.has(id)) continue;
      const l = lines.get(id);
      if (l) {
        l.g.classList.add("is-sel");
        if (l.label) l.label.classList.add("is-sel");
        // selected edges draw on top of the rest
        edgeG.append(l.g);
        paintedEdges.add(id);
      }
    }
    if (active && !(sel.size === 1 && sel.has(active))) setActive(null);
    schedule("selbar");
  }

  function setSelection(ids, edgeIds = []) {
    sel.clear();
    for (const id of ids) if (byId.has(id)) sel.add(id);
    selEdges.clear();
    for (const id of edgeIds) if (edgeById.has(id)) selEdges.add(id);
    paintSelection();
  }
  const clearSelection = () => setSelection([]);
  const selectAll = () => setSelection(canvas.nodes.map((n) => n.id));
  const selectedNodes = () => [...sel].map((id) => byId.get(id)).filter(Boolean);

  /** The selection plus whatever sits inside selected groups. */
  function selectionWithMembers() {
    const ids = new Set(sel);
    for (const id of sel) {
      const n = byId.get(id);
      if (n && n.type === "group") for (const m of M.groupMembers(canvas.nodes, n)) ids.add(m);
    }
    return [...ids];
  }

  function setActive(id) {
    if (active === id) return;
    const prev = active && cards.get(active);
    if (prev) prev.el.classList.remove("is-active");
    active = id;
    const c = id && cards.get(id);
    if (c) c.el.classList.add("is-active");
  }

  // an editor that left the page without a blur no longer counts
  const editing = () => [...cards.values()].some((c) => (c.editing || c.renaming) && c.el.isConnected && c.el.querySelector(".bc-edit, .bg-edit")) || !!(labelEditor && labelEditor.isConnected);

  function setTool(t) {
    tool = t;
    selectBtn.classList.toggle("is-on", t === "select");
    handBtn.classList.toggle("is-on", t === "hand");
    root.classList.toggle("tool-select", t === "select");
    saveSetting("boardTool", t);
  }

  /* ── selection bar ────────────────────────────────────────────────────── */
  let selbarKey = "";

  function placeSelBar() {
    const nodes = selectedNodes();
    const edges = [...selEdges].map((id) => edgeById.get(id)).filter(Boolean);
    if (gesture || root.classList.contains("is-moving") || editing() || (!nodes.length && !edges.length) || !W) {
      selbar.hidden = true;
      return;
    }
    const key = nodes.map((n) => n.id + (n.color || "")).join() + "|" + edges.map((e) => e.id + (e.color || "") + (e.fromEnd || "") + (e.toEnd || "")).join() + "|" + focusId + [...expanded.keys()].join();
    if (key !== selbarKey) {
      selbarKey = key;
      buildSelBar(nodes, edges);
    }
    let b;
    if (nodes.length) b = M.bounds(nodes);
    else {
      const l = lines.get(edges[0].id);
      b = { x: l.mid[0], y: l.mid[1], width: 0, height: 0 };
    }
    const sx = b.x * view.k + view.x;
    const sy = b.y * view.k + view.y;
    const sw = b.width * view.k;
    const sh = b.height * view.k;
    selbar.hidden = false;
    const bw = selbar.offsetWidth;
    const bh = selbar.offsetHeight;
    // group labels sit above groups: stay clear of any just above the selection
    let top = sy;
    for (const g of canvas.nodes) {
      if (g.type !== "group" || !g.label || g.x > b.x + b.width || g.x + g.width < b.x) continue;
      const gy = g.y * view.k + view.y;
      if (gy <= sy + 1 && gy > sy - bh - 40) top = Math.min(top, gy - 26);
    }
    let y = top - bh - 10;
    if (y < TOP) y = sy + sh + 12;
    // no room above or below: sit just under the toolbar
    if (y + bh > H - 8) y = TOP;
    const x = clamp(sx + sw / 2 - bw / 2, 8, Math.max(8, W - bw - 8));
    selbar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function buildSelBar(nodes, edges) {
    const items = [];
    const things = [...nodes, ...edges];
    const colors = new Set(things.map((x) => x.color || ""));
    const cur = colors.size === 1 ? [...colors][0] : null;
    const btn = (name, title, run, on) => h("button", { class: "bd-btn" + (on ? " is-on" : ""), title, onclick: run, tabindex: "-1" }, ic(name));
    for (const [c, name] of PRESETS) {
      items.push(h("button", { class: "bd-sw" + (cur === c ? " is-on" : ""), title: name, style: { "--c": `var(--bd-c${c})` }, onclick: () => setColor(c), tabindex: "-1" }));
    }
    const custom = cur && cur.startsWith("#") ? cur : "";
    items.push(h("button", { class: "bd-sw is-custom" + (custom ? " is-on" : ""), title: "Custom colour", style: custom ? { "--c": custom } : null, onclick: () => pickColor(), tabindex: "-1" }));
    items.push(h("button", { class: "bd-sw is-none" + (cur === "" ? " is-on" : ""), title: "No colour", onclick: () => setColor(""), tabindex: "-1" }));
    items.push(h("span", { class: "bd-sep" }));
    const one = nodes.length === 1 && !edges.length ? nodes[0] : null;
    const kind = one && M.kindOf(one);
    if (one) {
      if (OPENABLE.has(kind)) items.push(btn("open", kind === "link" ? "Open link" : "Open in a tab (Enter)", () => openNode(one)));
      if (kind === "note") {
        items.push(btn("graph", "Add linked notes around it (L)", () => expandLinks(one.id)));
        items.push(btn(expanded.has(one.id) ? "shrink" : "expand", expanded.has(one.id) ? "Back to its size" : "Expand to read", () => toggleExpand(one.id)));
      }
      if (kind === "text") items.push(btn("edit", "Edit (Enter)", () => editText(one.id)));
      if (kind === "group") {
        items.push(btn("edit", "Rename (Enter)", () => renameGroup(one.id)));
        items.push(btn("grid", "Tidy the cards inside", () => arrange("grid")));
      }
      items.push(btn("focus", focusId === one.id ? "Leave focus (F)" : "Focus on its connections (F)", () => toggleFocus(one.id), focusId === one.id));
    }
    if (nodes.length === 2 && !edges.length && nodes.every(isNoteNode)) {
      items.push(btn("compass", "What connects these?", (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        whatConnects(r.left, r.bottom + 6);
      }));
    }
    if (nodes.length > 1) {
      items.push(btn("group", "Group (Ctrl+G)", () => groupSelection(true)));
      items.push(btn("grid", "Arrange", (e) => arrangeMenu(e.currentTarget)));
    }
    if (edges.length && !nodes.length) {
      const e = edges[0];
      items.push(btn("arrow", "Arrows", (ev) => {
        const r = ev.currentTarget.getBoundingClientRect();
        edgeMenu(r.left, r.bottom + 6, e.id);
      }));
      if (edges.length === 1) items.push(btn("edit", "Label (Enter)", () => editEdgeLabel(e.id)));
      const a = byId.get(e.fromNode);
      const b = byId.get(e.toNode);
      if (edges.length === 1 && isNoteNode(a) && isNoteNode(b)) {
        items.push(btn("link", `Write [[${noteTitle(b)}]] into ${noteTitle(a)}`, () => writeLink(a.file, b.file)));
      }
    }
    items.push(btn("trash", "Remove (Delete)", () => removeSelection()));
    selbar.replaceChildren(...items);
  }

  /* ── colours ──────────────────────────────────────────────────────────── */
  function selectedThings() {
    return [...selectedNodes(), ...[...selEdges].map((id) => edgeById.get(id)).filter(Boolean)];
  }

  function setColor(color) {
    const things = selectedThings();
    if (!things.length) return;
    edit(() => {
      for (const x of things) {
        if (color) x.color = color;
        else delete x.color;
      }
    });
  }

  function pickColor() {
    const things = selectedThings();
    if (!things.length) return;
    const before = snapshot();
    const hex = things.map((x) => x.color).find((c) => c && c.startsWith("#"));
    colorInput.value = hex && hex.length === 7 ? hex : "#e0a84a";
    const r = selbar.getBoundingClientRect();
    const rr = rect();
    colorInput.style.transform = `translate(${r.left - rr.left}px, ${r.bottom - rr.top}px)`;
    colorInput.oninput = () => {
      for (const x of things) x.color = colorInput.value;
      syncAll();
      changed();
    };
    colorInput.onchange = () => commit(before);
    try { colorInput.showPicker ? colorInput.showPicker() : colorInput.click(); } catch { colorInput.click(); }
  }

  /* ── minimap ──────────────────────────────────────────────────────────── */
  let mapColors = null;
  let mapState = null;

  function readMapColors() {
    const cs = getComputedStyle(root);
    const v = (k) => cs.getPropertyValue(k).trim();
    // plain theme colours: canvas does not understand color-mix()
    mapColors = { card: v("--text-3") || "#888", group: v("--line-strong") || "#444" };
    for (const [c] of PRESETS) mapColors[c] = v(`--bd-c${c}`);
  }

  function drawMap() {
    if (!showMap || !W) return;
    if (!mapColors) readMapColors();
    const cw = 196;
    const ch = 128;
    const dpr = window.devicePixelRatio || 1;
    if (mapCanvas.width !== Math.round(cw * dpr)) {
      mapCanvas.width = Math.round(cw * dpr);
      mapCanvas.height = Math.round(ch * dpr);
    }
    const ctx = mapCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const vr = { x: -view.x / view.k, y: -view.y / view.k, width: W / view.k, height: H / view.k };
    const b = M.bounds([...canvas.nodes, vr]);
    const pad = 8;
    const s = Math.min((cw - pad * 2) / b.width, (ch - pad * 2) / b.height);
    const ox = pad + (cw - pad * 2 - b.width * s) / 2 - b.x * s;
    const oy = pad + (ch - pad * 2 - b.height * s) / 2 - b.y * s;
    mapState = { s, ox, oy };
    const colorOf = (c) => (!c ? null : mapColors[c] || (c.startsWith("#") ? c : null));
    for (const n of canvas.nodes) {
      const x = ox + n.x * s;
      const y = oy + n.y * s;
      const w = Math.max(1.5, n.width * s);
      const hh = Math.max(1.5, n.height * s);
      const col = colorOf(n.color);
      if (n.type === "group") {
        ctx.globalAlpha = col ? 0.7 : 1;
        ctx.strokeStyle = col || mapColors.group;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w, hh);
      } else {
        ctx.globalAlpha = col ? 0.85 : 0.5;
        ctx.fillStyle = col || mapColors.card;
        ctx.fillRect(x, y, w, hh);
      }
    }
    ctx.globalAlpha = 1;
    mapView.style.transform = `translate(${ox + vr.x * s}px, ${oy + vr.y * s}px)`;
    mapView.style.width = Math.max(4, vr.width * s) + "px";
    mapView.style.height = Math.max(4, vr.height * s) + "px";
  }

  function toggleMap() {
    showMap = !showMap;
    minimap.hidden = !showMap;
    mapBtn.classList.toggle("is-on", showMap);
    saveSetting("boardMinimap", showMap);
    schedule("map");
  }

  function mapJump(e) {
    if (!mapState) return;
    const r = mapCanvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - mapState.ox) / mapState.s;
    const wy = (e.clientY - r.top - mapState.oy) / mapState.s;
    cancelAnimationFrame(anim);
    view = { k: view.k, x: W / 2 - wx * view.k, y: H / 2 - wy * view.k };
    applyView();
  }
  minimap.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    minimap.setPointerCapture(e.pointerId);
    mapJump(e);
    const move = (ev) => mapJump(ev);
    const up = () => {
      minimap.removeEventListener("pointermove", move);
      minimap.removeEventListener("pointerup", up);
      minimap.removeEventListener("pointercancel", up);
    };
    minimap.addEventListener("pointermove", move);
    minimap.addEventListener("pointerup", up);
    minimap.addEventListener("pointercancel", up);
  });

  /* ── pointer gestures ──────────────────────────────────────────────────── */
  let gesture = null;
  let spaceDown = false;
  const touches = new Map();

  function onPointerDown(e) {
    cancelAnimationFrame(anim);
    const t = e.target;
    if (t.closest(".bc-edit, .bg-edit, .bd-label-edit")) return;
    if (document.activeElement !== root) root.focus({ preventScroll: true });
    rootRect = root.getBoundingClientRect();
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) return startPinch();
    }
    if (gesture) return;
    if (t.closest("button, a, input, textarea, select, .md-wl, .md-a, .md-cb, .md-tag")) {
      // controls act on click; keep the middle button from autoscrolling
      if (e.button === 1) e.preventDefault();
      return;
    }
    const cardEl = t.closest(".bc");
    const edgeEl = t.closest(".bd-edge, .bd-label");
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      return startPan(e, false);
    }
    if (e.button === 2) {
      // a right-click on something unselected selects it first
      if (cardEl && !sel.has(cardEl.dataset.id)) setSelection([cardEl.dataset.id]);
      else if (edgeEl && !selEdges.has(edgeEl.dataset.id)) setSelection([], [edgeEl.dataset.id]);
      return;
    }
    if (e.button !== 0) return;
    const handle = t.closest(".bc-h");
    if (handle && cardEl) return startConnect(e, cardEl.dataset.id, handle.dataset.side);
    if (cardEl && t.closest(".bc-resize")) return startResize(e, cardEl.dataset.id);
    if (edgeEl) return pressEdge(e, edgeEl.dataset.id);
    if (cardEl) return pressCard(e, cardEl.dataset.id, t);
    if (tool === "select" || e.shiftKey || e.ctrlKey || e.metaKey) return startBand(e);
    startPan(e, true);
  }

  function onPointerMove(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture && gesture.type === "pinch") return pinchMove();
    }
    const g = gesture;
    if (!g || g.pid !== e.pointerId) return;
    if (e.buttons === 0 && e.pointerType === "mouse") return onPointerUp(e);
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    switch (g.type) {
      case "pan":
        g.moved = true;
        cancelAnimationFrame(anim);
        view = { ...view, x: g.vx + dx, y: g.vy + dy };
        applyView();
        break;
      case "card":
        if (!g.moved) {
          beginMove(g);
          try { stage.setPointerCapture(e.pointerId); } catch {}
        }
        moveBy(g, dx / view.k, dy / view.k);
        break;
      case "resize":
        g.moved = true;
        resizeTo(g, dx / view.k, dy / view.k, (g.c.kind === "image") !== e.shiftKey);
        break;
      case "connect":
        g.moved = true;
        connectMove(g, e);
        break;
      case "band":
        g.moved = true;
        bandMove(g, e);
        break;
    }
  }

  function onPointerUp(e) {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (gesture && gesture.type === "pinch") {
        if (touches.size < 2) gesture = null;
        return;
      }
    }
    const g = gesture;
    if (!g || g.pid !== e.pointerId) return;
    gesture = null;
    try { stage.releasePointerCapture(e.pointerId); } catch {}
    root.classList.remove("is-panning", "is-resizing", "is-connecting");
    if (g.type === "pan") { if (!g.moved && g.pick) { setSelection([g.pick]); schedule("selbar"); } else if (!g.moved && g.clear) clearSelection(); }
    else if (g.type === "card") endCardPress(g);
    else if (g.type === "resize") endResize(g);
    else if (g.type === "connect") endConnect(g, e);
    else if (g.type === "band") endBand(g);
    schedule("selbar");
  }

  function startPan(e, clearOnClick) {
    gesture = { type: "pan", pid: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, clear: clearOnClick };
    try { stage.setPointerCapture(e.pointerId); } catch {}
    root.classList.add("is-panning");
  }

  function startPinch() {
    if (gesture && gesture.type === "card" && gesture.moved) return;
    const [a, b] = [...touches.values()];
    gesture = { type: "pinch", d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...view } };
  }

  function pinchMove() {
    const [a, b] = [...touches.values()];
    if (!a || !b) return;
    const g = gesture;
    const r = rect();
    const k = clamp((g.view.k * Math.hypot(a.x - b.x, a.y - b.y)) / g.d, MIN_K, MAX_K);
    const wx = (g.cx - r.left - g.view.x) / g.view.k;
    const wy = (g.cy - r.top - g.view.y) / g.view.k;
    view = { k, x: (a.x + b.x) / 2 - r.left - wx * k, y: (a.y + b.y) / 2 - r.top - wy * k };
    zoomed = true;
    applyView();
  }

  function pressCard(e, id, t) {
    const c = cards.get(id);
    if (!c) return;
    // a card being read keeps native text selection and scrolling
    if (active === id && t.closest(".bc-body")) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const wasSel = sel.has(id);
    if (!wasSel && !additive && S.boardDragPicked !== false && !t.closest(".bg-label, .bc-head")) {
      gesture = { type: "pan", pid: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, pick: id };
      return;
    }
    if (additive) {
      if (wasSel) sel.delete(id);
      else sel.add(id);
      paintSelection();
      if (wasSel) return;
    } else if (!wasSel || selEdges.size) {
      setSelection(wasSel ? [...sel] : [id]);
    }
    gesture = {
      type: "card", id, pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false,
      again: wasSel && !additive, onBody: !!t.closest(".bc-body"), onLabel: !!t.closest(".bg-label"),
    };
  }

  function beginMove(g) {
    g.moved = true;
    g.before = snapshot();
    const ids = selectionWithMembers();
    g.items = ids.map((id) => byId.get(id)).filter(Boolean).map((n) => ({ n, x: n.x, y: n.y, c: cards.get(n.id) }));
    for (const it of g.items) if (it.c) it.c.el.classList.add("is-dragging");
    root.classList.add("is-dragging");
    selbar.hidden = true;
    setActive(null);
  }

  function moveBy(g, dx, dy) {
    for (const it of g.items) {
      it.n.x = Math.round(it.x + dx);
      it.n.y = Math.round(it.y + dy);
      if (it.c) paintPos(it.c);
      dirtyNode(it.n.id);
    }
    schedule("edges");
  }

  function endCardPress(g) {
    if (g.moved) {
      for (const it of g.items) if (it.c) it.c.el.classList.remove("is-dragging");
      root.classList.remove("is-dragging");
      commit(g.before);
      orderGroups();
      schedule("visible");
      return;
    }
    // an unhurried second click on a selected card starts working inside it
    const c = cards.get(g.id);
    if (!g.again || sel.size !== 1 || !c) return;
    if (c.kind === "text") editText(c.id);
    else if (c.kind === "group" && g.onLabel) renameGroup(c.id);
    else if (c.kind === "note" && g.onBody) setActive(c.id);
  }

  function startResize(e, id) {
    const n = byId.get(id);
    const c = cards.get(id);
    if (!n || !c) return;
    if (!sel.has(id)) setSelection([id]);
    gesture = { type: "resize", id, n, c, pid: e.pointerId, sx: e.clientX, sy: e.clientY, w: n.width, h: n.height, before: snapshot(), moved: false };
    try { stage.setPointerCapture(e.pointerId); } catch {}
    root.classList.add("is-resizing");
    e.preventDefault();
  }

  function resizeTo(g, dx, dy, keepRatio) {
    const minW = g.n.type === "group" ? 100 : MIN_W;
    let w = Math.max(minW, g.w + dx);
    let hh = Math.max(MIN_H, g.h + dy);
    if (keepRatio && g.h > 0) {
      const r = g.w / g.h;
      if (w / hh > r) hh = w / r;
      else w = hh * r;
    }
    g.n.width = Math.round(w);
    g.n.height = Math.round(hh);
    paintSize(g.c);
    dirtyNode(g.id);
    schedule("edges");
  }

  function endResize(g) {
    if (!g.moved) return;
    if (expanded.has(g.id)) {
      expanded.delete(g.id);
      g.c.el.classList.remove("is-expanded");
    }
    commit(g.before);
    orderGroups();
    schedule("visible");
  }

  function hitTest(x, y, exclude) {
    let group = null;
    for (let i = canvas.nodes.length - 1; i >= 0; i--) {
      const n = canvas.nodes[i];
      if (n.id === exclude || x < n.x || y < n.y || x > n.x + n.width || y > n.y + n.height) continue;
      if (n.type !== "group") return n.id;
      if (!group || n.width * n.height < group.width * group.height) group = n;
    }
    return group ? group.id : null;
  }

  function startConnect(e, id, side) {
    gesture = { type: "connect", id, side, pid: e.pointerId, sx: e.clientX, sy: e.clientY, target: null, moved: false };
    try { stage.setPointerCapture(e.pointerId); } catch {}
    root.classList.add("is-connecting");
    e.preventDefault();
  }

  function markTarget(g, id) {
    if (g.target === id) return;
    const old = g.target && cards.get(g.target);
    if (old) old.el.classList.remove("is-target");
    g.target = id;
    const c = id && cards.get(id);
    if (c) c.el.classList.add("is-target");
  }

  function connectMove(g, e) {
    const a = byId.get(g.id);
    if (!a) return;
    const p = toWorld(e.clientX, e.clientY);
    const hit = hitTest(p.x, p.y, g.id);
    markTarget(g, hit);
    let geo;
    if (hit) {
      const b = byId.get(hit);
      geo = M.edgeGeometry(a, b, g.side, M.nearestSide(b, p.x, p.y), { arrow: arrowSize() });
    } else {
      const pr = { x: p.x, y: p.y, width: 0, height: 0 };
      const [cx, cy] = M.center(a);
      geo = M.edgeGeometry(a, pr, g.side, M.nearestSide(pr, cx, cy), { arrow: arrowSize() });
    }
    preview.setAttribute("d", geo.d);
    previewHead.setAttribute("d", geo.arrows[0] || "");
  }

  function endConnect(g, e) {
    preview.setAttribute("d", "");
    previewHead.setAttribute("d", "");
    const target = g.target;
    markTarget(g, null);
    if (!g.moved) return;
    const a = byId.get(g.id);
    if (!a) return;
    const p = toWorld(e.clientX, e.clientY);
    if (target) {
      const b = byId.get(target);
      const edge = M.makeEdge(g.id, g.side, target, M.nearestSide(b, p.x, p.y));
      edit(() => canvas.edges.push(edge));
      setSelection([], [edge.id]);
      return;
    }
    if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 30) return;
    // let go on empty space: a new sticky there, already connected
    const [w, hh] = M.SIZES.text;
    const [cx, cy] = M.center(a);
    const side = M.nearestSide({ x: p.x, y: p.y, width: 0, height: 0 }, cx, cy);
    const x = side === "left" ? p.x : side === "right" ? p.x - w : p.x - w / 2;
    const y = side === "top" ? p.y : side === "bottom" ? p.y - hh : p.y - hh / 2;
    const before = snapshot();
    const n = M.makeNode("text", { text: "" }, x, y, w, hh);
    canvas.nodes.push(n);
    canvas.edges.push(M.makeEdge(g.id, g.side, n.id, side));
    syncAll();
    setSelection([n.id]);
    editText(n.id, { before, fresh: true });
  }

  function pressEdge(e, id) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (selEdges.has(id)) selEdges.delete(id);
      else selEdges.add(id);
      paintSelection();
    } else {
      setSelection([], [id]);
    }
    e.preventDefault();
  }

  function startBand(e) {
    const base = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(sel) : new Set();
    gesture = { type: "band", pid: e.pointerId, sx: e.clientX, sy: e.clientY, base, moved: false };
    try { stage.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  }

  function bandMove(g, e) {
    const r = rect();
    const x0 = Math.min(g.sx, e.clientX);
    const y0 = Math.min(g.sy, e.clientY);
    const x1 = Math.max(g.sx, e.clientX);
    const y1 = Math.max(g.sy, e.clientY);
    band.hidden = false;
    band.style.transform = `translate(${x0 - r.left}px, ${y0 - r.top}px)`;
    band.style.width = x1 - x0 + "px";
    band.style.height = y1 - y0 + "px";
    const a = toWorld(x0, y0);
    const b = toWorld(x1, y1);
    const box = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    const next = new Set(g.base);
    // cards count when touched, groups only when fully inside
    for (const n of canvas.nodes) if (n.type === "group" ? M.contains(box, n, 0) : M.overlaps(box, n)) next.add(n.id);
    const same = next.size === sel.size && [...next].every((id) => sel.has(id));
    if (!same) setSelection([...next]);
  }

  function endBand(g) {
    band.hidden = true;
    if (!g.moved && !g.base.size) clearSelection();
  }

  function onWheel(e) {
    if (e.target.closest("textarea, input, .bd-results")) return;
    const body = e.target.closest(".bc-body");
    if (body && !e.ctrlKey && !e.metaKey) {
      const c = cards.get(body.closest(".bc").dataset.id);
      // a selected card's own content scrolls; everything else moves the board
      if (c && (sel.has(c.id) || c.editing) && canScroll(body, e.deltaX, e.deltaY)) return;
    }
    e.preventDefault();
    cancelAnimationFrame(anim);
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= H; dy *= H; }
    const r = root.getBoundingClientRect();
    rootRect = r;
    // the wheel zooms at the pointer (pinches arrive as ctrl+wheel); Shift+wheel
    // and sideways swipes move the board, Alt+wheel moves it up and down
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && !e.altKey && !dx)) {
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (Math.abs(dy) < 40 ? 0.012 : 0.0022)));
      return;
    }
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    view = { ...view, x: view.x - dx, y: view.y - dy };
    applyView();
  }

  function onDblClick(e) {
    const t = e.target;
    if (t.closest("button, input, textarea, .bc-h, .bc-resize, .md-wl, .md-a, .md-cb")) return;
    const edgeEl = t.closest(".bd-edge, .bd-label");
    if (edgeEl) return editEdgeLabel(edgeEl.dataset.id);
    const cardEl = t.closest(".bc");
    const p = toWorld(e.clientX, e.clientY);
    if (!cardEl) return addSticky(p);
    const c = cards.get(cardEl.dataset.id);
    if (!c) return;
    if (c.kind === "text") return editText(c.id);
    if (c.kind === "group") return t.closest(".bg-label") ? renameGroup(c.id) : addSticky(p);
    if (OPENABLE.has(c.kind)) openNode(c.node);
  }

  function onContextMenu(e) {
    if (e.target.closest("textarea, input")) return;
    e.preventDefault();
    const edgeEl = e.target.closest(".bd-edge, .bd-label");
    const cardEl = e.target.closest(".bc");
    if (edgeEl) {
      if (!selEdges.has(edgeEl.dataset.id)) setSelection([], [edgeEl.dataset.id]);
      edgeMenu(e.clientX, e.clientY, edgeEl.dataset.id);
    } else if (cardEl) {
      if (!sel.has(cardEl.dataset.id)) setSelection([cardEl.dataset.id]);
      nodeMenu(e.clientX, e.clientY);
    } else {
      canvasMenu(e.clientX, e.clientY, toWorld(e.clientX, e.clientY));
    }
  }

  function onCardClick(e) {
    const cardEl = e.target.closest(".bc");
    if (!cardEl) return;
    const id = cardEl.dataset.id;
    const act = e.target.closest("[data-act]");
    if (act) {
      e.stopPropagation();
      return cardAction(act.dataset.act, id, act);
    }
    const pic = e.target.closest(".md-img-load");
    if (pic) { e.stopPropagation(); return pic.replaceWith(h("img", { class: "md-img", src: pic.dataset.src, alt: pic.dataset.alt || "", draggable: false })); }
    const wl = e.target.closest(".md-wl");
    if (wl) return followLink(id, wl.dataset.target, wl.dataset.sub, e.ctrlKey || e.metaKey);
    const a = e.target.closest(".md-a");
    if (a) return openHref(a.dataset.href, id, e.ctrlKey || e.metaKey);
    const cb = e.target.closest(".md-cb");
    if (cb) return toggleTask(id, Number(cb.dataset.line));
    const tag = e.target.closest(".md-tag");
    if (tag) {
      searchInput.value = "#" + tag.dataset.tag;
      runSearch();
    }
  }

  function onAuxClick(e) {
    if (e.button !== 1) return;
    const cardEl = e.target.closest(".bc");
    const wl = e.target.closest(".md-wl");
    const a = e.target.closest(".md-a");
    if (!cardEl || (!wl && !a)) return;
    e.preventDefault();
    if (wl) followLink(cardEl.dataset.id, wl.dataset.target, wl.dataset.sub, true);
    else openHref(a.dataset.href, cardEl.dataset.id, true);
  }

  function cardAction(act, id, btn) {
    const n = byId.get(id);
    if (!n) return;
    if (act === "open") openNode(n);
    else if (act === "links") expandLinks(id);
    else if (act === "focus") toggleFocus(id);
    else if (act === "expand") toggleExpand(id);
    else if (act === "remove") removeNodes([id]);
    else if (act === "more") {
      if (!sel.has(id)) setSelection([id]);
      const r = btn.getBoundingClientRect();
      nodeMenu(r.left, r.bottom + 4);
    }
  }

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("dblclick", onDblClick);
  stage.addEventListener("contextmenu", onContextMenu);
  stage.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  cardLayer.addEventListener("pointerover", (e) => {
    const el = e.target.closest && e.target.closest(".bc");
    const c = el && cards.get(el.dataset.id);
    if (c && !c.acts) ensureActs(c);
  });
  cardLayer.addEventListener("click", onCardClick);
  cardLayer.addEventListener("auxclick", onAuxClick);
  root.addEventListener("contextmenu", (e) => { if (!stage.contains(e.target) && !e.target.closest("input")) e.preventDefault(); });

  /* ── keyboard ─────────────────────────────────────────────────────────── */
  let nudgeAt = 0;
  let nudgeBase = null;

  function onKey(e) {
    if (e.defaultPrevented || destroyed) return;
    if (e.target !== root && typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const code = e.code;
    const one = sel.size === 1 && !selEdges.size ? byId.get([...sel][0]) : null;
    let handled = true;
    if (code === "Space" && !mod) {
      if (!spaceDown) { spaceDown = true; root.classList.add("is-space"); }
    } else if (mod && code === "KeyZ") e.shiftKey ? redoStep() : undoStep();
    else if (mod && code === "KeyY") redoStep();
    else if (mod && code === "KeyA") selectAll();
    else if (mod && code === "KeyD") duplicate();
    else if (mod && code === "BracketRight") restack(true);
    else if (mod && code === "BracketLeft") restack(false);
    else if (mod && code === "KeyG") e.shiftKey ? ungroup() : groupSelection(true);
    else if (mod && code === "KeyF") focusSearch();
    else if (mod && code === "KeyE") { e.preventDefault(); toggleSource(); }
    else if (mod && (code === "KeyC" || code === "KeyX")) { rememberCopy(); handled = false; }
    else if (mod && code === "KeyV") { expectPaste(); handled = false; }
    else if (mod || e.altKey) handled = false;
    else if (code === "Delete" || code === "Backspace") removeSelection();
    else if (code === "Escape") escape();
    else if (code === "Enter" || code === "NumpadEnter") handled = enterOn(one);
    else if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-" || e.key === "_") zoomBy(0.8);
    else if (e.key === "0") zoomTo(1);
    else if (e.shiftKey && code === "Digit1") fitAll();
    else if (e.shiftKey && code === "Digit2") fitSelection();
    else if (code.startsWith("Arrow")) nudge(code, e.shiftKey ? 10 : 1);
    else if (code === "KeyV") setTool("select");
    else if (code === "KeyH") setTool("hand");
    else if (code === "KeyN") addSticky(pointerWorld());
    else if (code === "KeyF" && one) toggleFocus(one.id);
    else if (code === "KeyL" && isNoteNode(one)) expandLinks(one.id);
    else if (e.key === "/") focusSearch();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onKeyUp(e) {
    if (e.code === "Space" && spaceDown) {
      spaceDown = false;
      root.classList.remove("is-space");
    }
  }

  function onBlur() {
    spaceDown = false;
    root.classList.remove("is-space");
  }

  function escape() {
    if (gesture && gesture.type === "connect") {
      preview.setAttribute("d", "");
      previewHead.setAttribute("d", "");
      markTarget(gesture, null);
      gesture = null;
      root.classList.remove("is-connecting");
    } else if (active) setActive(null);
    else if (focusId) setFocus(null);
    else if (search.q) { searchInput.value = ""; runSearch(); }
    else clearSelection();
  }

  function enterOn(n) {
    if (!n) {
      if (selEdges.size === 1) { editEdgeLabel([...selEdges][0]); return true; }
      return false;
    }
    const k = M.kindOf(n);
    if (k === "text") editText(n.id);
    else if (k === "group") renameGroup(n.id);
    else if (OPENABLE.has(k)) openNode(n);
    else return false;
    return true;
  }

  function nudge(code, step) {
    const dx = code === "ArrowLeft" ? -step : code === "ArrowRight" ? step : 0;
    const dy = code === "ArrowUp" ? -step : code === "ArrowDown" ? step : 0;
    const ids = selectionWithMembers();
    if (!ids.length) {
      // nothing selected: the arrows move around the board instead
      view = { ...view, x: view.x - dx * 8, y: view.y - dy * 8 };
      applyView();
      return;
    }
    const before = snapshot();
    for (const id of ids) {
      const n = byId.get(id);
      n.x += dx;
      n.y += dy;
      const c = cards.get(id);
      if (c) paintPos(c);
      dirtyNode(id);
    }
    schedule("edges");
    schedule("selbar");
    const now = performance.now();
    // a burst of nudges is one undo step
    if (now - nudgeAt < 800 && undo.length && undo[undo.length - 1] === nudgeBase) changed();
    else if (commit(before)) nudgeBase = before;
    nudgeAt = now;
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  root.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  /* ── editing in place ─────────────────────────────────────────────────── */
  const refocus = () => {
    const a = document.activeElement;
    if (!destroyed && (!a || a === document.body || !a.isConnected)) root.focus({ preventScroll: true });
  };

  function editText(id, { before = snapshot(), fresh = false } = {}) {
    const c = cards.get(id);
    if (!c || c.kind !== "text" || c.editing) return;
    const n = c.node;
    const was = n.text || "";
    c.editing = true;
    c.vis = true;
    c.el.classList.remove("is-off");
    c.el.classList.add("is-editing");
    selbar.hidden = true;
    const ta = h("textarea", { class: "bc-edit", placeholder: "Write something. Markdown and [[links]] work." });
    ta.value = was;
    c.body.replaceChildren(ta);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const grow = () => {
      // the sticky grows with its text instead of scrolling
      const over = ta.scrollHeight - ta.clientHeight;
      if (over > 0 && n.height < 900) {
        n.height = Math.min(900, n.height + over);
        paintSize(c);
        dirtyNode(id);
        schedule("edges");
      }
    };
    ta.addEventListener("input", () => {
      n.text = ta.value;
      grow();
      changes++;
      notify();
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      c.editing = false;
      c.el.classList.remove("is-editing");
      const cur = byId.get(id);
      if (cur) {
        const t = (cur.text || "").trim();
        const url = M.urlOf(t);
        if (fresh && !t) {
          // an untouched new sticky leaves no trace, not even an undo step
          restore(before);
          refocus();
          return;
        }
        if (url) {
          // a sticky that holds only a web address becomes a link card
          delete cur.text;
          cur.type = "link";
          cur.url = url;
          cur.width = Math.max(cur.width, M.SIZES.link[0]);
          cur.height = M.SIZES.link[1];
        }
      }
      c.stale = true;
      syncAll();
      commit(before);
      markStale(cards.get(id) || c);
      refocus();
    };
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        ta.blur();
      } else if (e.key === "Tab") {
        e.preventDefault();
        ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      }
    });
    ta.addEventListener("blur", finish);
    ta.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  }

  function renameGroup(id, before = snapshot()) {
    const c = cards.get(id);
    if (!c || c.kind !== "group" || c.renaming) return;
    c.renaming = true;
    c.el.classList.add("is-renaming");
    selbar.hidden = true;
    const holder = c.el.querySelector(".bg-label");
    const inp = h("input", { class: "bg-edit", type: "text", placeholder: "Group name" });
    inp.value = c.node.label || "";
    const oldLabel = c.node.label;
    // written as typed (as a text card is): a board closed or the app quit mid-typing keeps it
    inp.addEventListener("input", () => { const cur = byId.get(id); if (!cur) return; const v = inp.value.trim(); if (v) cur.label = v; else delete cur.label; changes++; notify(); });
    c.label.hidden = true;
    holder.append(inp);
    inp.focus({ preventScroll: true });
    inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      inp.remove();
      c.label.hidden = false;
      c.renaming = false;
      c.el.classList.remove("is-renaming");
      const cur = byId.get(id);
      if (cur && ok) {
        if (v) cur.label = v;
        else delete cur.label;
      } else if (cur) { if (oldLabel) cur.label = oldLabel; else delete cur.label; changes++; notify(); } // Esc: the name it had, saved again
      syncAll();
      commit(before);
      refocus();
    };
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
  }

  let labelEditor = null;
  function editEdgeLabel(id) {
    const e = edgeById.get(id);
    const l = lines.get(id);
    if (!e || !l || labelEditor) return;
    flushEdges();
    const before = snapshot();
    const inp = h("input", { class: "bd-label-edit", type: "text", placeholder: "Label" });
    inp.value = e.label || "";
    const oldLabel = e.label;
    inp.addEventListener("input", () => { const cur = edgeById.get(id); if (!cur) return; const v = inp.value.trim(); if (v) cur.label = v; else delete cur.label; changes++; notify(); });
    inp.style.transform = `translate(${l.mid[0]}px, ${l.mid[1]}px) translate(-50%, -50%)`;
    labelLayer.append(inp);
    labelEditor = inp;
    if (l.label) l.label.hidden = true;
    selbar.hidden = true;
    inp.focus({ preventScroll: true });
    inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      labelEditor = null;
      const v = inp.value.trim();
      inp.remove();
      const line = lines.get(id);
      if (line && line.label) line.label.hidden = false;
      const cur = edgeById.get(id);
      if (cur && ok) {
        if (v) cur.label = v;
        else delete cur.label;
        syncAll();
        commit(before);
      } else if (cur) { if (oldLabel) cur.label = oldLabel; else delete cur.label; syncAll(); changes++; notify(); } // Esc: the label it had, saved again
      schedule("selbar");
      refocus();
    };
    inp.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
    inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  function toggleExpand(id) {
    const n = byId.get(id);
    const c = cards.get(id);
    if (!n || !c) return;
    const before = snapshot();
    if (expanded.has(id)) {
      const s = expanded.get(id);
      expanded.delete(id);
      n.width = s.w;
      n.height = s.h;
    } else {
      expanded.set(id, { w: n.width, h: n.height });
      // widen into free space on the right only, then take the height the text needs
      let room = 640;
      for (const o of canvas.nodes) {
        if (o === n || o.type === "group" || o.x < n.x + n.width - 1) continue;
        if (o.y < n.y + Math.max(n.height, 600) && o.y + o.height > n.y) room = Math.min(room, o.x - n.x - 32);
      }
      n.width = Math.max(n.width, Math.round(room));
      paintSize(c);
      c.vis = true;
      c.el.classList.remove("is-off");
      if (c.stale) renderBody(c);
      // measure the text at the new width, then take the height it needs
      const head = c.el.querySelector(".bc-head");
      const need = c.body.scrollHeight + (head ? head.offsetHeight : 0) + 4;
      n.height = Math.round(Math.max(n.height, Math.min(need, 1100)));
    }
    c.el.classList.toggle("is-expanded", expanded.has(id));
    syncAll();
    commit(before);
    reveal(n);
  }

  /* ── adding cards ─────────────────────────────────────────────────────── */
  const obstacles = () => canvas.nodes.filter((n) => n.type !== "group");
  const pathsOnBoard = () => new Set(canvas.nodes.filter((n) => n.type === "file").map((n) => n.file));
  const nodeFor = (path) => canvas.nodes.find((n) => n.type === "file" && n.file === path && !n.subpath) || canvas.nodes.find((n) => n.type === "file" && n.file === path);

  function sizeFor(path) {
    if (/\.md$/i.test(path)) return { width: M.SIZES.note[0], height: M.SIZES.note[1] };
    if (M.IMAGE_RE.test(path)) return { width: M.SIZES.image[0], height: M.SIZES.image[1] };
    return { width: M.SIZES.file[0], height: M.SIZES.file[1] };
  }

  function placeAt(size, at, free) {
    const want = { x: at.x - size.width / 2, y: at.y - size.height / 2, ...size };
    return free ? M.findFreeSpot(want, obstacles()) : { x: Math.round(want.x), y: Math.round(want.y) };
  }

  function addSticky(at) {
    const [w, hh] = M.SIZES.text;
    const pos = placeAt({ width: w, height: hh }, at || viewCentre(), !at);
    const before = snapshot();
    const n = M.makeNode("text", { text: "" }, pos.x, pos.y, w, hh);
    canvas.nodes.push(n);
    syncAll();
    setSelection([n.id]);
    if (!at) reveal(n);
    editText(n.id, { before, fresh: true });
  }

  function addText(text, at) {
    const t = String(text || "").slice(0, 20000);
    const rows = t.split("\n").length + Math.floor(t.length / 34);
    const size = { width: t.length > 160 ? 340 : 260, height: clamp(40 + rows * 22, 80, 480) };
    const pos = placeAt(size, at || viewCentre(), !at);
    const n = M.makeNode("text", { text: t }, pos.x, pos.y, size.width, size.height);
    edit(() => canvas.nodes.push(n));
    setSelection([n.id]);
  }

  function addLink(url, at) {
    const [w, hh] = M.SIZES.link;
    const pos = placeAt({ width: w, height: hh }, at || viewCentre(), !at);
    const n = M.makeNode("link", { url }, pos.x, pos.y, w, hh);
    edit(() => canvas.nodes.push(n));
    setSelection([n.id]);
  }

  function addGroupAt(at) {
    const [w, hh] = M.SIZES.group;
    const g = M.makeNode("group", { label: "Group" }, at.x - w / 2, at.y - hh / 2, w, hh);
    const before = snapshot();
    canvas.nodes.unshift(g);
    syncAll();
    setSelection([g.id]);
    changed();
    renameGroup(g.id, before);
  }

  const known = (p) => typeof p === "string" && !!(vault.get(p) || vault.files.has(p));

  /** Note and file cards in a tidy grid at `at` (world) or the view centre. */
  function addNotes(paths, at) {
    if (!Array.isArray(paths)) return;
    const present = pathsOnBoard();
    const wanted = [...new Set(paths)].filter(known);
    const list = wanted.filter((p) => !present.has(p));
    if (!list.length) {
      // everything is here already: show it instead
      const here = wanted.map(nodeFor).filter(Boolean);
      if (here.length) {
        setSelection(here.map((n) => n.id));
        reveal(M.bounds(here));
        toast(here.length === 1 ? "That note is already on this board" : "Those are already on this board");
      }
      return;
    }
    const sizes = list.map(sizeFor);
    const cols = Math.min(list.length, Math.max(1, Math.round(Math.sqrt(list.length * 1.6))));
    const rel = M.gridLayout(sizes, { gap: 40, cols });
    const block = M.bounds(rel.map((p, i) => ({ ...p, ...sizes[i] })));
    let origin;
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      // one card centres under the pointer; a batch starts there
      origin = list.length === 1 ? { x: at.x - sizes[0].width / 2, y: at.y - 20 } : { x: at.x, y: at.y };
    } else {
      const c = viewCentre();
      origin = M.findFreeSpot({ x: c.x - block.width / 2, y: c.y - block.height / 2, width: block.width, height: block.height }, obstacles(), { gap: 40 });
    }
    const made = list.map((p, i) => {
      const n = M.makeNode("file", { file: p }, origin.x + rel[i].x, origin.y + rel[i].y, sizes[i].width, sizes[i].height);
      if (M.IMAGE_RE.test(p)) fitOnLoad.add(n.id);
      return n;
    });
    edit(() => canvas.nodes.push(...made));
    setSelection(made.map((n) => n.id));
    if (!at) reveal(M.bounds(made));
    if (list.length < wanted.length) toast(`${plural(wanted.length - list.length, "note")} already here, skipped`);
  }

  function linkEdge(from, to, map) {
    if (!from || !to || from.id === to.id || connected(from.id, to.id)) return null;
    // follow the real link direction when the vault has one
    if (map && isNoteNode(from) && isNoteNode(to) && !M.linksTo(map, from.file, to.file) && M.linksTo(map, to.file, from.file)) [from, to] = [to, from];
    const [fs, ts] = M.autoSides(from, to);
    const e = M.makeEdge(from.id, fs, to.id, ts);
    canvas.edges.push(e);
    reindex();
    return e;
  }

  /** A note a [[link]] points at, next to the card it was clicked in. */
  function followLink(fromId, target, sub, newTab) {
    const from = byId.get(fromId);
    if (!from) return;
    const base = isNoteNode(from) ? from.file : boardPath;
    let p = resolveLink(target, base);
    if (!p) {
      const f = findFile(target);
      if (f) p = f;
    }
    if (!p) { toast(`"${target}" is not in the vault yet`); return; }
    if (newTab) {
      if (vault.get(p)) app.openNote(p, { newTab: true });
      else app.openFile(p, { newTab: true });
      return;
    }
    const there = nodeFor(p);
    if (there) {
      setSelection([there.id]);
      reveal(there);
      flash(there.id);
      return;
    }
    const size = vault.get(p) ? { width: 360, height: 340 } : sizeFor(p);
    const want = { x: from.x + from.width + 90, y: from.y, ...size };
    const pos = M.findFreeSpot(want, obstacles(), { gap: 36 });
    const n = M.makeNode("file", { file: p, subpath: sub && vault.get(p) ? sub : "" }, pos.x, pos.y, size.width, size.height);
    if (M.IMAGE_RE.test(p)) fitOnLoad.add(n.id);
    edit(() => {
      canvas.nodes.push(n);
      reindex();
      linkEdge(from, n, null);
    });
    setSelection([n.id]);
    reveal(n);
  }

  function findFile(target) {
    const t = String(target || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!t) return null;
    if (vault.files.has(t)) return t;
    const low = "/" + t.toLowerCase();
    for (const p of vault.files.keys()) if (("/" + p.toLowerCase()).endsWith(low)) return p;
    return null;
  }

  function flash(id) {
    const c = cards.get(id);
    if (!c) return;
    c.el.classList.remove("is-flash");
    void c.el.offsetWidth;
    c.el.classList.add("is-flash");
    c.el.addEventListener("animationend", () => c.el.classList.remove("is-flash"), { once: true });
  }

  function openUrl(u) {
    if (/^(https?:|mailto:)/i.test(u)) app.openUrl(u);
    else if (/^www\./i.test(u)) app.openUrl("https://" + u);
    else toast("Only web links open from a board");
  }

  function openNode(n) {
    const k = M.kindOf(n);
    if (k === "note") {
      if (vault.get(n.file)) app.openNote(n.file, { newTab: true });
      else toast("This note is not in the vault");
    } else if (k === "image" || k === "file") {
      if (vault.files.has(n.file)) app.openFile(n.file, { newTab: true });
      else if (vault.get(n.file)) app.openNote(n.file, { newTab: true });
      else toast("This file is not in the vault");
    } else if (k === "link") openUrl(n.url || "");
  }

  function openHref(href, id, newTab) {
    const u = String(href || "");
    if (/^(https?:|mailto:|www\.)/i.test(u)) return openUrl(u);
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) { toast("That kind of link does not open from a board"); return; }
    let t = u;
    try { t = decodeURIComponent(u); } catch {}
    const hash = t.indexOf("#");
    const sub = hash >= 0 ? t.slice(hash) : "";
    t = (hash >= 0 ? t.slice(0, hash) : t).replace(/\.md$/i, "");
    if (t) followLink(id, t, sub, newTab);
  }

  function toggleTask(id, line) {
    const n = byId.get(id);
    if (!n || !Number.isInteger(line)) return;
    if (n.type === "text") {
      const ls = (n.text || "").split("\n");
      const next = ls[line] != null ? toggleTaskLine(ls[line]) : null;
      if (next == null) return;
      ls[line] = next;
      edit(() => { n.text = ls.join("\n"); });
    } else if (isNoteNode(n)) {
      const note = vault.get(n.file);
      if (!note) return;
      const ls = note.content.split("\n");
      const next = ls[line] != null ? toggleTaskLine(ls[line]) : null;
      if (next == null) return;
      ls[line] = next;
      vault.write(n.file, ls.join("\n"));
    }
  }

  /** Append [[to]] to the note at `from`. Only ever on an explicit request. */
  function writeLink(from, to) {
    const note = vault.get(from);
    const target = vault.get(to);
    if (!note || !target) { toast("Both notes need to be in the vault"); return; }
    if (note.links.some((l) => resolveLink(l.target, from) === to)) {
      toast(`${note.title} already links to ${target.title}`);
      return;
    }
    const text = vault.resolve(target.title, from) === to ? target.title : to.replace(/\.md$/i, "");
    const before = note.content;
    const next = before + (before && !before.endsWith("\n") ? "\n" : "") + `[[${text}]]\n`;
    vault.write(from, next);
    schedule("notelinks");
    toast(`Added [[${target.title}]] to the end of ${note.title}`, {
      action: {
        label: "Undo",
        run: () => {
          const cur = vault.get(from);
          if (cur && cur.content === next) vault.write(from, before);
        },
      },
    });
  }

  /* ── removing, duplicating, grouping ──────────────────────────────────── */
  function removeNodes(ids, edgeIds = []) {
    const set = new Set(ids);
    const eset = new Set(edgeIds);
    if (!set.size && !eset.size) return;
    const before = snapshot();
    const nodes = canvas.nodes.filter((n) => set.has(n.id));
    canvas.nodes = canvas.nodes.filter((n) => !set.has(n.id));
    canvas.edges = canvas.edges.filter((e) => !set.has(e.fromNode) && !set.has(e.toNode) && !eset.has(e.id));
    syncAll();
    if (!commit(before)) return;
    const after = undo[undo.length - 1];
    const what = nodes.length
      ? nodes.length === 1 ? `Removed "${cardName(nodes[0])}" from the board` : `Removed ${plural(nodes.length, "card")}`
      : `Removed ${plural(eset.size, "connection")}`;
    toast(what, { action: { label: "Undo", run: () => { if (undo[undo.length - 1] === after) undoStep(); } } });
  }

  const cardName = (n) => {
    const k = M.kindOf(n);
    if (k === "note") return noteTitle(n);
    if (k === "image" || k === "file") return n.file.slice(n.file.lastIndexOf("/") + 1);
    if (k === "link") return n.url;
    if (k === "group") return n.label || "Group";
    return firstLine(n.text) || "Sticky";
  };

  const removeSelection = () => removeNodes([...sel], [...selEdges]);

  function duplicate() {
    const ids = selectionWithMembers();
    if (ids.length) pasteData(M.copyPayload(canvas, ids), { dx: 30, dy: 30 });
  }

  function pasteData(p, { at, dx = 0, dy = 0 } = {}) {
    if (!p || !p.nodes || !p.nodes.length) return;
    if (at) {
      const b = M.bounds(p.nodes);
      dx = at.x - (b.x + b.width / 2);
      dy = at.y - (b.y + b.height / 2);
    }
    const r = M.remapPayload(p, dx, dy);
    edit(() => {
      // groups first, so they stay behind the cards they hold
      canvas.nodes.unshift(...r.nodes.filter((n) => n.type === "group"));
      canvas.nodes.push(...r.nodes.filter((n) => n.type !== "group"));
      canvas.edges.push(...r.edges);
    });
    setSelection(r.nodes.map((n) => n.id));
  }

  function groupSelection(rename) {
    const nodes = selectedNodes();
    if (!nodes.length) { toast("Select the cards to group first"); return; }
    const b = M.bounds(nodes);
    const before = snapshot();
    const g = M.makeNode("group", { label: "Group" }, b.x - PAD, b.y - PAD, b.width + PAD * 2, b.height + PAD * 2);
    canvas.nodes.unshift(g);
    syncAll();
    setSelection([g.id]);
    // naming commits the whole step, so one undo takes the group away
    if (rename) {
      changed();
      renameGroup(g.id, before);
    } else commit(before);
  }

  function ungroup() {
    const groups = selectedNodes().filter((n) => n.type === "group");
    if (!groups.length) return;
    const inside = new Set(groups.flatMap((g) => M.groupMembers(canvas.nodes, g)));
    removeNodes(groups.map((g) => g.id));
    setSelection([...inside].filter((id) => byId.has(id)));
  }

  /* ── clipboard and drops ──────────────────────────────────────────────── */
  let pastePending = false;

  function selectionPayload() {
    const ids = selectionWithMembers();
    return ids.length ? M.copyPayload(canvas, ids) : null;
  }

  function rememberCopy() {
    const p = selectionPayload();
    if (p) boardClip = p;
  }

  // if the WebView sends no paste event, fall back to the board clipboard
  function expectPaste() {
    pastePending = true;
    setTimeout(() => {
      if (pastePending && boardClip && !destroyed) pasteData(boardClip, { at: pointerWorld() });
      pastePending = false;
    }, 0);
  }

  const ownsKeys = () => !destroyed && document.activeElement === root;

  function onCopy(e) {
    if (!ownsKeys()) return;
    if (String(window.getSelection ? window.getSelection() : "")) return; // copying text out of a card
    const p = selectionPayload();
    if (!p || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", JSON.stringify(p));
    boardClip = p;
    if (e.type === "cut") removeSelection();
  }

  function onPaste(e) {
    if (!ownsKeys()) return;
    pastePending = false;
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    const at = pointerWorld();
    const txt = dt.getData("text/plain");
    const payload = M.readPayload(txt);
    if (payload) return pasteData(payload, { at });
    if (dt.files && dt.files.length) return dropFiles([...dt.files], at);
    placeText(txt, at, false);
  }

  function resolveAny(t) {
    return resolveLink(t, boardPath) || findFile(t);
  }

  /** Text from a paste or drop: a link, note cards, or a sticky. */
  function placeText(txt, at, fromDrop) {
    const t = String(txt || "").trim();
    if (!t) return;
    const url = M.urlOf(t);
    if (url) return addLink(url, at);
    if (known(t)) return addNotes([t], at);
    const targets = M.wikiTargets(t);
    const onlyLinks = !t.replace(/!?\[\[[^\]]*\]\]/g, "").replace(/[\s,;·\-*]+/g, "");
    if (targets.length && (fromDrop || onlyLinks)) {
      const paths = targets.map(resolveAny).filter(Boolean);
      if (paths.length) return addNotes(paths, at);
      if (onlyLinks) { toast("Those notes are not in the vault"); return; }
    }
    addText(t, at);
  }

  async function dropFiles(files, at) {
    const paths = [];
    for (const f of files) {
      let hit = findFile(f.name) || resolveLink(f.name.replace(/\.md$/i, ""), boardPath);
      // a file of the same name elsewhere in the vault is not this one unless its size is the same too
      if (hit && vault.files.has(hit) && typeof f.size === "number" && (vault.files.get(hit).size ?? f.size) !== f.size) hit = null;
      // a picture from outside (a screenshot pasted, a photo dropped): saved with the vault's pictures, then put on
      if (!hit && /^image\//.test(f.type || "") && app.host && app.host.saveImage) {
        const dir = attachmentDir(app.mediaDir ? app.mediaDir("imageFolder") : "", boardPath);
        const name = imageName(boardPath, (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*/, ""));
        const p = dir ? dir + "/" + name : name;
        try {
          const list = await app.host.saveImage(p, new Uint8Array(await f.arrayBuffer()));
          if (Array.isArray(list) && vault.setFiles) vault.setFiles(list);
          hit = p;
        } catch (e) { toast("Could not save the picture: " + e, { kind: "error" }); }
      }
      if (hit) paths.push(hit);
    }
    if (destroyed) return; // closed while a picture was being saved: it is in the vault, the board is gone
    if (paths.length) addNotes(paths, at);
    else toast("Only pictures and files already in the vault can go on a board");
  }

  const DROP_TYPES = ["application/x-leonote-paths", "text/plain", "text/uri-list", "Files"];
  function dropEffect(dt) {
    const a = dt.effectAllowed || "all";
    if (a === "all" || a === "uninitialized" || a.toLowerCase().includes("copy")) return "copy";
    if (a.toLowerCase().includes("link")) return "link";
    return "move";
  }

  stage.addEventListener("dragover", (e) => {
    const types = [...(e.dataTransfer ? e.dataTransfer.types : [])];
    if (!types.some((t) => DROP_TYPES.includes(t))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dropEffect(e.dataTransfer);
    root.classList.add("is-drop");
  });
  stage.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget || !stage.contains(e.relatedTarget)) root.classList.remove("is-drop");
  });
  stage.addEventListener("drop", (e) => {
    root.classList.remove("is-drop");
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    e.stopPropagation();
    rootRect = root.getBoundingClientRect();
    const at = toWorld(e.clientX, e.clientY);
    root.focus({ preventScroll: true });
    const raw = dt.getData("application/x-leonote-paths");
    if (raw) {
      try {
        const paths = JSON.parse(raw);
        if (Array.isArray(paths)) return addNotes(paths.filter((p) => typeof p === "string"), at);
      } catch {}
    }
    if (dt.files && dt.files.length) return dropFiles([...dt.files], at);
    const uri = M.urlOf(dt.getData("text/uri-list"), true);
    const txt = dt.getData("text/plain");
    if (uri && (!txt || M.urlOf(txt) || !M.wikiTargets(txt).length)) return addLink(uri, at);
    placeText(txt, at, true);
  });

  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCopy);
  document.addEventListener("paste", onPaste);

  /* ── research tools ───────────────────────────────────────────────────── */
  const titleOf = (p) => (vault.get(p) ? vault.get(p).title : basename(p));
  const linkMap = () => M.buildLinkMap(vault.notes.values(), resolveLink);

  /** Outgoing links to the right, backlinks to the left, each on an arc. */
  function expandLinks(id) {
    const c = byId.get(id);
    if (!isNoteNode(c)) return;
    const note = vault.get(c.file);
    if (!note) { toast("This note is not in the vault"); return; }
    const uniq = (arr) => [...new Set(arr)].filter((p) => p && p !== c.file);
    const out = uniq(note.links.map((l) => resolveLink(l.target, c.file)));
    const back = uniq((vault.backlinks(c.file) || []).map((b) => (b.note ? b.note.path : b.path)));
    const inn = back.filter((p) => !out.includes(p));
    if (!out.length && !inn.length) { toast(`${note.title} has no links yet`); return; }
    const present = pathsOnBoard();
    const addOut = out.filter((p) => !present.has(p)).slice(0, 16);
    const addIn = inn.filter((p) => !present.has(p)).slice(0, 16);
    const size = { width: 340, height: 300 };
    const before = snapshot();
    const obs = obstacles();
    const made = [];
    const place = (list, from, to) => {
      const pos = M.ringLayout(c, list.map(() => size), { from, to, gap: 70, obstacles: obs });
      return list.map((p, i) => {
        const n = M.makeNode("file", { file: p }, pos[i].x, pos[i].y, size.width, size.height);
        canvas.nodes.push(n);
        obs.push(n);
        made.push(n);
        return n;
      });
    };
    const outNodes = place(addOut, -Math.PI * 0.42, Math.PI * 0.42);
    const inNodes = place(addIn, Math.PI * 0.58, Math.PI * 1.42);
    reindex();
    let linked = 0;
    // new cards and ones already on the board both get their edge
    for (const p of out) {
      const n = outNodes.find((x) => x.file === p) || nodeFor(p);
      if (n && linkEdge(c, n, null)) linked++;
    }
    for (const p of inn) {
      const n = inNodes.find((x) => x.file === p) || nodeFor(p);
      if (n && linkEdge(n, c, null)) linked++;
    }
    syncAll();
    commit(before);
    if (made.length) {
      setSelection([id, ...made.map((n) => n.id)]);
      reveal(M.bounds([c, ...made]), true);
    }
    const here = [...out, ...inn].filter((p) => present.has(p)).length;
    const over = out.length + inn.length - here - made.length;
    const notes = [here ? `${here} already on the board` : "", over > 0 ? `${over} more not shown` : ""].filter(Boolean).join(", ");
    toast(made.length
      ? `Added ${plural(made.length, "linked note")}` + (notes ? ` (${notes})` : "")
      : linked ? `Connected ${plural(linked, "card")} already on the board` : "Everything it links to is already here");
  }

  function whatConnects(x, y) {
    const ns = selectedNodes().filter(isNoteNode);
    if (ns.length !== 2) { toast("Select two note cards to see what connects them"); return; }
    const [A, B] = ns;
    const pa = A.file;
    const pb = B.file;
    if (!vault.get(pa) || !vault.get(pb)) { toast("Both notes need to be in the vault"); return; }
    if (pa === pb) { toast("Those two cards show the same note"); return; }
    const map = linkMap();
    const path = M.shortestPath(map, pa, pb, 6);
    const shared = M.sharedNeighbours(map, pa, pb);
    const present = pathsOnBoard();
    const items = [];
    if (path && path.length === 2) {
      const [f, t] = M.linksTo(map, pa, pb) ? [pa, pb] : [pb, pa];
      items.push({ header: `${titleOf(f)} links to ${titleOf(t)}`, plain: true });
      if (!connected(A.id, B.id)) items.push({ label: "Connect them on the board", icon: "link", run: () => edit(() => linkEdge(A, B, map)) });
    } else if (path) {
      items.push({ header: `Linked in ${path.length - 1} steps` });
      items.push({ header: path.map(titleOf).join("  →  "), plain: true });
      items.push({ label: `Add the path (${plural(path.length - 2, "note")} between)`, icon: "plus", run: () => addPath(path, A, B, map) });
    }
    if (shared.length) {
      items.push("sep", { header: `Both link with ${plural(shared.length, "note")}` });
      for (const p of shared.slice(0, 8)) {
        items.push({ label: titleOf(p), icon: present.has(p) ? "check" : "fileText", run: () => addBetween([p], A, B, map) });
      }
      if (shared.length > 1) items.push({ label: `Add all ${Math.min(shared.length, 24)}`, icon: "plus", run: () => addBetween(shared.slice(0, 24), A, B, map) });
    }
    if (!path && !shared.length) {
      // no links at all: point at plain-text mentions instead
      const ta = titleOf(pa);
      const tb = titleOf(pb);
      const low = (p) => { const n = vault.get(p); return n.lower != null ? n.lower : n.content.toLowerCase(); };
      const aMentions = tb.length >= 3 && low(pa).includes(tb.toLowerCase());
      const bMentions = ta.length >= 3 && low(pb).includes(ta.toLowerCase());
      const notes = [...vault.notes.values()];
      const withA = new Set(M.mentioning(notes, ta, [pa, pb]));
      const both = M.mentioning(notes, tb, [pa, pb]).filter((p) => withA.has(p));
      items.push({ header: "No link path within 6 steps", plain: true });
      if (aMentions) items.push({ label: `${ta} mentions "${tb}": link it`, icon: "link", run: () => writeLink(pa, pb) });
      if (bMentions) items.push({ label: `${tb} mentions "${ta}": link it`, icon: "link", run: () => writeLink(pb, pa) });
      if (both.length) {
        items.push("sep", { header: "Notes that mention both" });
        for (const p of both.slice(0, 6)) items.push({ label: titleOf(p), icon: present.has(p) ? "check" : "fileText", run: () => addBetween([p], A, B, null) });
      }
      if (!aMentions && !bMentions && !both.length) items.push({ header: "Neither mentions the other by name, and no note mentions both.", plain: true });
    }
    menu(x, y, items);
  }

  function addPath(path, A, B, map) {
    const [ax, ay] = M.center(A);
    const [bx, by] = M.center(B);
    const mids = path.slice(1, -1);
    const size = { width: 320, height: 260 };
    const chain = [A];
    const made = [];
    edit(() => {
      const obs = obstacles();
      mids.forEach((p, i) => {
        let n = nodeFor(p);
        if (!n) {
          const t = (i + 1) / (mids.length + 1);
          const pos = M.findFreeSpot({ x: ax + (bx - ax) * t - size.width / 2, y: ay + (by - ay) * t - size.height / 2, ...size }, obs, { gap: 40 });
          n = M.makeNode("file", { file: p }, pos.x, pos.y, size.width, size.height);
          canvas.nodes.push(n);
          obs.push(n);
          made.push(n);
        }
        chain.push(n);
      });
      chain.push(B);
      reindex();
      for (let i = 0; i + 1 < chain.length; i++) linkEdge(chain[i], chain[i + 1], map);
    });
    setSelection(chain.map((n) => n.id));
    reveal(M.bounds(chain), true);
  }

  function addBetween(paths, A, B, map) {
    const mid = { x: (A.x + A.width / 2 + B.x + B.width / 2) / 2, y: (A.y + A.height / 2 + B.y + B.height / 2) / 2 };
    const size = { width: 320, height: 260 };
    const touched = [];
    edit(() => {
      const obs = obstacles();
      for (const p of paths) {
        let n = nodeFor(p);
        if (!n) {
          const pos = M.findFreeSpot({ x: mid.x - size.width / 2, y: mid.y - size.height / 2, ...size }, obs, { gap: 40 });
          n = M.makeNode("file", { file: p }, pos.x, pos.y, size.width, size.height);
          canvas.nodes.push(n);
          obs.push(n);
        }
        touched.push(n);
        reindex();
        // for mentions (no map) the note that mentions points at both
        if (map) { linkEdge(A, n, map); linkEdge(n, B, map); }
        else { linkEdge(n, A, null); linkEdge(n, B, null); }
      }
    });
    setSelection([A.id, B.id, ...touched.map((n) => n.id)]);
    reveal(M.bounds([A, B, ...touched]), true);
  }

  function arrange(mode) {
    let group = null;
    let nodes = selectedNodes();
    if (nodes.length === 1 && nodes[0].type === "group") {
      group = nodes[0];
      nodes = M.groupMembers(canvas.nodes, group).map((id) => byId.get(id)).filter((n) => n.type !== "group");
    } else {
      if (!nodes.length) nodes = [...canvas.nodes];
      nodes = nodes.filter((n) => n.type !== "group");
    }
    if (nodes.length < 2) { toast("Select two or more cards to arrange"); return; }
    let targets;
    if (mode === "links") {
      const index = new Map(nodes.map((n, i) => [n.id, i]));
      const links = [];
      for (const e of canvas.edges) if (index.has(e.fromNode) && index.has(e.toNode)) links.push([index.get(e.fromNode), index.get(e.toNode)]);
      for (const pr of nlPairs) if (index.has(pr.a) && index.has(pr.b)) links.push([index.get(pr.a), index.get(pr.b)]);
      targets = M.forceLayout(nodes, links);
    } else {
      const b = M.bounds(nodes);
      // reading order: rows by rough height, then left to right
      nodes = [...nodes].sort((p, q) => Math.round(p.y / 120) - Math.round(q.y / 120) || p.x - q.x);
      const origin = group ? { x: group.x + PAD, y: group.y + PAD } : { x: b.x, y: b.y };
      const cols = Math.min(nodes.length, Math.max(1, Math.round(Math.sqrt(nodes.length * 1.6))));
      targets = M.gridLayout(nodes, { ...origin, gap: 40, cols });
    }
    animateNodes(nodes, targets, () => {
      if (!group) return;
      const b = M.bounds(nodes);
      group.width = Math.max(group.width, Math.round(b.x + b.width + PAD - group.x));
      group.height = Math.max(group.height, Math.round(b.y + b.height + PAD - group.y));
    });
  }

  function animateNodes(nodes, targets, done) {
    const before = snapshot();
    const from = nodes.map((n) => ({ x: n.x, y: n.y }));
    const t0 = performance.now();
    const ms = 340;
    root.classList.add("is-dragging");
    const step = (now) => {
      if (destroyed) return;
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      nodes.forEach((n, i) => {
        n.x = Math.round(from[i].x + (targets[i].x - from[i].x) * e);
        n.y = Math.round(from[i].y + (targets[i].y - from[i].y) * e);
        const c = cards.get(n.id);
        if (c) paintPos(c);
        dirtyNode(n.id);
      });
      flushEdges();
      if (t < 1) return requestAnimationFrame(step);
      root.classList.remove("is-dragging");
      if (done) done();
      syncAll();
      commit(before);
    };
    requestAnimationFrame(step);
  }

  function toggleFocus(id) {
    setFocus(focusId === id ? null : id);
  }

  /** Dim everything not connected to one card (board edges and note links). */
  function setFocus(id, frame = true) {
    focusId = id && byId.has(id) ? id : null;
    root.classList.toggle("is-focusing", !!focusId);
    const near = new Set();
    if (focusId) {
      near.add(focusId);
      for (const eid of edgesOf.get(focusId) || []) {
        const e = edgeById.get(eid);
        near.add(e.fromNode);
        near.add(e.toNode);
      }
      if (showNoteLinks) for (const pr of nlOf.get(focusId) || []) { near.add(pr.a); near.add(pr.b); }
    }
    for (const c of cards.values()) c.el.classList.toggle("is-near", near.has(c.id));
    for (const l of lines.values()) {
      const e = edgeById.get(l.id);
      const touching = !!focusId && !!e && (e.fromNode === focusId || e.toNode === focusId);
      l.g.classList.toggle("is-near", touching);
      if (l.label) l.label.classList.toggle("is-near", touching);
    }
    for (const pr of nlPairs) {
      const on = !!focusId && (pr.a === focusId || pr.b === focusId);
      pr.path.classList.toggle("is-near", on);
      pr.head.classList.toggle("is-near", on);
    }
    focusChip.hidden = !focusId;
    if (focusId) {
      const n = byId.get(focusId);
      focusChip.replaceChildren(ic("focus"), h("span", { text: `Focus: ${cardName(n)}` }), ic("x"));
      if (frame) animateTo(viewFor(M.bounds([...near].map((x) => byId.get(x))), 1));
    }
    selbarKey = "";
    schedule("selbar");
  }

  /* ── search ───────────────────────────────────────────────────────────── */
  let searchTimer = 0;

  function nodeMatches(n, q) {
    const tag = q.startsWith("#") ? q.slice(1) : "";
    const has = (s) => String(s || "").toLowerCase().includes(q);
    if (n.type === "text") return has(n.text);
    if (n.type === "link") return has(n.url);
    if (n.type === "group") return has(n.label);
    if (n.type === "file") {
      if (has(n.file)) return true;
      const note = vault.get(n.file);
      if (!note) return false;
      if (tag && note.tags.some((t) => t === tag || t.startsWith(tag + "/"))) return true;
      return (note.lower != null ? note.lower : note.content.toLowerCase()).includes(q);
    }
    return false;
  }

  function runSearch(quiet = false) {
    const q = searchInput.value.trim().toLowerCase();
    const same = q === search.q;
    search.q = q;
    const hits = q ? canvas.nodes.filter((n) => nodeMatches(n, q)) : [];
    hits.sort((a, b) => a.y - b.y || a.x - b.x);
    search.hits = hits.map((n) => n.id);
    if (!same) search.at = -1;
    root.classList.toggle("is-searching", !!q);
    const set = new Set(search.hits);
    for (const c of cards.values()) c.el.classList.toggle("is-hit", set.has(c.id));
    searchCount.textContent = !q ? "" : search.at >= 0 ? `${search.at + 1}/${hits.length}` : String(hits.length);
    if (!quiet) renderResults();
  }

  function renderResults() {
    const q = search.q;
    search.results = [];
    search.pick = -1;
    if (!q || document.activeElement !== searchInput) { results.hidden = true; return; }
    const present = pathsOnBoard();
    const notes = M.rankNotes(vault.notes.values(), q.replace(/^#/, ""), { limit: 7, exclude: present });
    const files = [...vault.files.values()]
      .filter((f) => !present.has(f.path) && f.path.toLowerCase().slice(f.path.lastIndexOf("/") + 1).includes(q))
      .slice(0, 3);
    search.results = [...notes.map((n) => ({ path: n.path, title: n.title, sub: n.folder, icon: "fileText" })),
      ...files.map((f) => ({ path: f.path, title: f.path.slice(f.path.lastIndexOf("/") + 1), sub: dirname(f.path), icon: f.kind === "image" ? "image" : "file" }))];
    const rows = [h("div", { class: "bd-res-head", text: search.hits.length ? `${plural(search.hits.length, "card")} on this board · Enter steps through` : "Nothing on this board matches" })];
    if (search.results.length) rows.push(h("div", { class: "bd-res-head", text: "Add from the vault · click or drag onto the board" }));
    search.results.forEach((r, i) => {
      const row = h("button", {
        class: "bd-res", draggable: "true", tabindex: "-1", dataset: { i: String(i) },
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => addResult(i),
        ondragstart: (e) => {
          e.dataTransfer.setData("application/x-leonote-paths", JSON.stringify([r.path]));
          e.dataTransfer.setData("text/plain", `[[${r.title}]]`);
          e.dataTransfer.effectAllowed = "copy";
        },
      }, ic(r.icon), h("span", { class: "bd-res-title", text: r.title }), h("span", { class: "bd-res-sub", text: r.sub || "" }), ic("plus", "bd-res-add"));
      rows.push(row);
    });
    results.replaceChildren(...rows);
    results.hidden = false;
  }

  function addResult(i) {
    const r = search.results[i];
    if (!r) return;
    addNotes([r.path]);
    runSearch();
  }

  function pickResult(dir) {
    const n = search.results.length;
    if (!n) return;
    // -1 is "no pick": Enter then steps through the board's own matches
    let p = search.pick + dir;
    if (p >= n) p = -1;
    if (p < -1) p = n - 1;
    search.pick = p;
    for (const row of results.querySelectorAll(".bd-res")) row.classList.toggle("is-pick", Number(row.dataset.i) === search.pick);
  }

  function stepSearch(dir) {
    const n = search.hits.length;
    if (!n) {
      if (search.results.length) addResult(0);
      return;
    }
    search.at = (search.at + dir + n) % n;
    const id = search.hits[search.at];
    setSelection([id]);
    reveal(byId.get(id), true);
    searchCount.textContent = `${search.at + 1}/${n}`;
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(), 80);
  });
  searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimer);
      if (searchInput.value.trim().toLowerCase() !== search.q) runSearch();
      if (search.pick >= 0) addResult(search.pick);
      else stepSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (searchInput.value) { searchInput.value = ""; runSearch(); }
      else root.focus({ preventScroll: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      pickResult(e.key === "ArrowDown" ? 1 : -1);
    }
  });
  searchInput.addEventListener("focus", () => renderResults());
  searchInput.addEventListener("blur", () => { results.hidden = true; });

  /* ── menus ────────────────────────────────────────────────────────────── */
  function canvasMenu(x, y, p) {
    menu(x, y, [
      { label: "Sticky note here", icon: "edit", keys: "N", run: () => addSticky(p) },
      { label: "Add notes", icon: "search", keys: "Ctrl F", run: () => focusSearch() },
      { label: "Group here", icon: "plus", run: () => addGroupAt(p) },
      boardClip ? { label: "Paste", icon: "list", keys: "Ctrl V", run: () => pasteData(boardClip, { at: p }) } : null,
      "sep",
      { label: "Select all", keys: "Ctrl A", run: selectAll },
      { label: "Zoom to fit", icon: "expand", keys: "Shift 1", run: () => fitAll() },
      { label: "Arrange everything by connections", icon: "graph", run: () => { clearSelection(); arrange("links"); } },
      "sep",
      { label: "Show links between notes", checked: showNoteLinks, run: toggleNoteLinks },
      { label: "Show minimap", checked: showMap, run: toggleMap },
    ]);
  }

  function nodeMenu(x, y) {
    const ns = selectedNodes();
    if (!ns.length) return;
    const one = ns.length === 1 ? ns[0] : null;
    const kind = one && M.kindOf(one);
    const groups = ns.filter((n) => n.type === "group");
    menu(x, y, [
      one && OPENABLE.has(kind) ? { label: kind === "link" ? "Open link" : "Open in a new tab", icon: "reveal", keys: "Enter", run: () => openNode(one) } : null,
      kind === "note" ? { label: "Add linked notes around it", icon: "graph", keys: "L", run: () => expandLinks(one.id) } : null,
      kind === "note" ? { label: expanded.has(one.id) ? "Back to its size" : "Expand to read", icon: expanded.has(one.id) ? "shrink" : "expand", run: () => toggleExpand(one.id) } : null,
      one ? { label: focusId === one.id ? "Leave focus" : "Focus on its connections", icon: "focus", keys: "F", run: () => toggleFocus(one.id) } : null,
      kind === "text" ? { label: "Edit", icon: "edit", keys: "Enter", run: () => editText(one.id) } : null,
      kind === "group" ? { label: "Rename", icon: "edit", keys: "Enter", run: () => renameGroup(one.id) } : null,
      ns.length === 2 && ns.every(isNoteNode) ? { label: "What connects these?", icon: "compass", run: () => whatConnects(x, y) } : null,
      "sep",
      ns.length > 1 ? { label: "Group", icon: "plus", keys: "Ctrl G", run: () => groupSelection(true) } : null,
      groups.length ? { label: "Ungroup", keys: "Ctrl Shift G", run: ungroup } : null,
      ns.length > 1 || kind === "group" ? { label: "Arrange in a grid", icon: "grid", run: () => arrange("grid") } : null,
      ns.length > 2 ? { label: "Arrange by connections", icon: "graph", run: () => arrange("links") } : null,
      { label: "Duplicate", keys: "Ctrl D", run: duplicate },
      groups.length < ns.length ? { label: "Bring to front", keys: "Ctrl ]", run: () => restack(true) } : null,
      groups.length < ns.length ? { label: "Send to back", keys: "Ctrl [", run: () => restack(false) } : null,
      { label: "Copy", keys: "Ctrl C", run: copyToClipboard },
      "sep",
      { label: ns.length > 1 ? `Remove ${ns.length} cards` : "Remove from board", icon: "trash", danger: true, keys: "Del", run: removeSelection },
    ]);
  }

  function copyToClipboard() {
    const p = selectionPayload();
    if (!p) return;
    boardClip = p;
    try { navigator.clipboard.writeText(JSON.stringify(p)).catch(() => {}); } catch {}
  }

  function setEnds(ids, fromEnd, toEnd) {
    edit(() => {
      for (const id of ids) {
        const e = edgeById.get(id);
        if (!e) continue;
        if (fromEnd === "none") delete e.fromEnd;
        else e.fromEnd = fromEnd;
        e.toEnd = toEnd;
      }
    });
  }

  function reverseEdges(ids) {
    edit(() => {
      for (const id of ids) {
        const e = edgeById.get(id);
        if (!e) continue;
        [e.fromNode, e.toNode] = [e.toNode, e.fromNode];
        const fs = e.fromSide;
        const ts = e.toSide;
        if (ts === undefined) delete e.fromSide;
        else e.fromSide = ts;
        if (fs === undefined) delete e.toSide;
        else e.toSide = fs;
      }
    });
  }

  function edgeMenu(x, y, id) {
    const e = edgeById.get(id);
    if (!e) return;
    const ids = selEdges.has(id) ? [...selEdges] : [id];
    const a = byId.get(e.fromNode);
    const b = byId.get(e.toNode);
    const to = e.toEnd || "arrow";
    const from = e.fromEnd || "none";
    menu(x, y, [
      ids.length === 1 ? { label: e.label ? "Edit label" : "Add a label", icon: "edit", keys: "Enter", run: () => editEdgeLabel(id) } : null,
      "sep",
      { label: "Arrow to the target", checked: from === "none" && to === "arrow", run: () => setEnds(ids, "none", "arrow") },
      { label: "Arrows both ways", checked: from === "arrow" && to === "arrow", run: () => setEnds(ids, "arrow", "arrow") },
      { label: "Plain line", checked: from === "none" && to === "none", run: () => setEnds(ids, "none", "none") },
      { label: "Reverse direction", icon: "undo", run: () => reverseEdges(ids) },
      ids.length === 1 && isNoteNode(a) && isNoteNode(b) ? "sep" : null,
      ids.length === 1 && isNoteNode(a) && isNoteNode(b) ? { label: `Write link into "${noteTitle(a)}"`, icon: "link", run: () => writeLink(a.file, b.file) } : null,
      "sep",
      { label: ids.length > 1 ? `Delete ${ids.length} connections` : "Delete connection", icon: "trash", danger: true, keys: "Del", run: () => removeNodes([], ids) },
    ]);
  }

  function anchorXY(btn) {
    const r = btn.getBoundingClientRect();
    return [r.left, r.bottom + 6];
  }

  function arrangeMenu(btn) {
    const [x, y] = anchorXY(btn);
    const scope = sel.size ? "selection" : "everything";
    menu(x, y, [
      { header: `Arrange ${scope}` },
      { label: "Tidy grid", icon: "grid", run: () => arrange("grid") },
      { label: "By connections", icon: "graph", run: () => arrange("links") },
    ]);
  }

  function moreMenu(btn) {
    const [x, y] = anchorXY(btn);
    menu(x, y, [
      { label: "Undo", icon: "undo", keys: "Ctrl Z", run: undoStep },
      { label: "Redo", keys: "Ctrl Y", run: redoStep },
      "sep",
      { label: "Zoom to fit", icon: "expand", keys: "Shift 1", run: () => fitAll() },
      { label: "Zoom to selection", keys: "Shift 2", run: fitSelection },
      { label: "Select all", keys: "Ctrl A", run: selectAll },
      "sep",
      { label: "Show links between notes", checked: showNoteLinks, run: toggleNoteLinks },
      { label: "Show minimap", checked: showMap, run: toggleMap },
      { label: "Show the text as written (source)", keys: "Ctrl E", checked: source, run: toggleSource },
      { label: "Far out, show only the titles", checked: S.boardLodTitles === true, run: () => { saveSetting("boardLodTitles", S.boardLodTitles !== true); root.classList.toggle("lod-titles", S.boardLodTitles === true); } },
      { label: "A card moves only once it is picked", checked: S.boardDragPicked !== false, run: () => saveSetting("boardDragPicked", S.boardDragPicked === false) },
      "sep",
      { header: "Text on the cards" },
      ...[[1, "Normal"], [1.25, "Bigger"], [1.5, "Big"], [2, "Biggest"]].map(([v, name]) => ({ label: `${name} · ${Math.round(v * 100)}%`, checked: textScale === v, run: () => setTextScale(v) })),
      "sep",
      { header: "Wheel zooms · Shift+wheel, Space+drag or middle-drag pans · drag a card's side dot to connect", plain: true },
    ]);
  }

  /* ── vault events and lifecycle ───────────────────────────────────────── */
  const offs = [];
  const on = (ev, fn) => {
    const off = vault.bus && vault.bus.on ? vault.bus.on(ev, fn) : null;
    if (typeof off === "function") offs.push(off);
  };
  on("changed", ({ path, linksChanged }) => {
    let hit = false;
    for (const c of cards.values()) {
      if (c.kind === "note" && c.node.file === path) {
        hit = true;
        fillStatic(c);
        markStale(c);
      }
    }
    if (hit && linksChanged) { nlSig = ""; schedule("notelinks"); }
    if (search.q && hit) runSearch(true);
  });
  const structural = () => {
    resolveCache = new Map();
    nlSig = "";
    for (const c of cards.values()) if (c.kind !== "group") { fillStatic(c); markStale(c); }
    schedule("notelinks");
  };
  on("structure", structural);
  on("removed", structural);
  // a folder moved sends one rename per note: the board is drawn again once, at the next frame, not once each
  let structuralQueued = false;
  const structuralSoon = () => { if (structuralQueued) return; structuralQueued = true; requestAnimationFrame(() => { structuralQueued = false; if (!destroyed) structural(); }); };
  on("renamed", ({ from, to }) => { resolveCache = new Map(); renamePath(from, to); structuralSoon(); });
  on("fileRenamed", ({ from, to }) => { renamePath(from, to); structuralSoon(); });

  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    const had = W > 0 && H > 0;
    W = r.width;
    H = r.height;
    rootRect = null;
    if (!W || !H) return;
    if (!had && needFit) { needFit = false; fitAll(false); }
    schedule("visible");
    schedule("selbar");
    schedule("map");
  });
  ro.observe(root);

  // the minimap reads theme colours; refresh them when the theme flips
  const mo = new MutationObserver(() => { mapColors = null; schedule("map"); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });

  function destroy() {
    if (destroyed) return;
    // an open editor commits first, so closing the tab keeps what was typed
    const a = document.activeElement;
    if (a && a !== root && root.contains(a) && typing(a)) a.blur();
    destroyed = true;
    for (const off of offs) off();
    ro.disconnect();
    mo.disconnect();
    cancelAnimationFrame(raf);
    cancelAnimationFrame(anim);
    clearTimeout(settleTimer);
    clearTimeout(searchTimer);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCopy);
    document.removeEventListener("paste", onPaste);
    if (boardPath) lastViews.set(boardPath, { ...view });
    root.remove();
  }

  /* ── first build ──────────────────────────────────────────────────────── */
  setTool(tool);
  linksBtn.classList.toggle("is-on", showNoteLinks);
  mapBtn.classList.toggle("is-on", showMap);
  if (parsed.error) {
    notice.replaceChildren(
      h("span", { text: `This board could not be read: ${parsed.error}. It opened empty, and changes you make will replace the file.` }),
      h("button", { class: "bd-btn", title: "Dismiss", onclick: () => { notice.hidden = true; } }, ic("x")));
    notice.hidden = false;
  } else if (parsed.dropped) {
    notice.replaceChildren(
      h("span", { text: `${parsed.dropped} broken ${parsed.dropped === 1 ? "entry" : "entries"} in this file could not be shown and will be left out when it is saved.` }),
      h("button", { class: "bd-btn", title: "Dismiss", onclick: () => { notice.hidden = true; } }, ic("x")));
    notice.hidden = false;
  }

  W = root.clientWidth;
  H = root.clientHeight;
  root.style.setProperty("--kk", "1");
  const saved = boardPath && lastViews.get(boardPath);
  if (saved) setView(saved);
  else if (W && H) fitAll(false);
  else { needFit = true; applyView(); }

  reindex();
  let t0 = performance.now();
  let fragG = document.createDocumentFragment();
  let fragC = document.createDocumentFragment();
  for (const n of canvas.nodes) {
    if (destroyed) break;
    const c = makeCard(n);
    (c.kind === "group" ? fragG : fragC).append(c.el);
    if (performance.now() - t0 > 10) {
      // hand the frame back; cards so far go in now
      groupLayer.append(fragG);
      cardLayer.append(fragC);
      schedule("visible");
      await nextTask();
      t0 = performance.now();
      fragG = document.createDocumentFragment();
      fragC = document.createDocumentFragment();
    }
  }
  groupLayer.append(fragG);
  cardLayer.append(fragC);
  if (!destroyed) syncAll();

  return {
    getText() {
      savedAt = changes;
      return changes === 0 && original != null ? original : M.serializeCanvas(canvas);
    },
    destroy,
    addNotes(paths, at) {
      addNotes(paths, at);
    },
    dirty: () => changes !== savedAt,
    focus: () => { if (!destroyed) root.focus({ preventScroll: true }); },
  };
}
