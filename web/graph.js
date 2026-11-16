// Graph view: notes and the links between them on a canvas, built for
// research. Layout, paths, search and grouping live in graphcore.js; this is
// the view. The simulation runs only while the view is visible and the layout
// is still moving; hover, selection and search changes redraw one frame.

import { h, debounce, basename, dirname, isTyping, naturalCompare, motionFull } from "./util.js";
import { icon } from "./icons.js";
import { excerpt } from "./mdparse.js";
import { fuzzy, highlight } from "./search.js";
import { host } from "./host.js";
import {
  graphSettings, makeResolver, buildGraph, components, shortestPath, shortestPaths, searchNodes, assignGroups,
  createLayout, createHitGrid, boardPlacement, boardName, mergeFolderRules, groupKey,
  readGraphDoc, writeGraphDoc, frameAround, searchFrames, cleanFrame, PALETTE, FRAME_COLORS, FRAME_HEAD,
  classifyEdges, crossMask, poolExtent, homeCore, clusterPoints, adoptHome, cleanHome, CORE_WEIGHT, BRIDGE_PULL,
  buildRelations, timelineLayout,
} from "./graphcore.js";
import { createLens } from "./graphlens.js";

const FONT = '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const TAU = Math.PI * 2;
const ALPHA_MIN = 0.004;
const ALPHA_DECAY = 0.0228;
const MAX_TABS = 12;
const MAX_LABELS = 450;
const K_MIN = 0.02;
const K_MAX = 8;
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const noteOnly = (nodes) => (k) => nodes[k].kind === "note";
const FRAME_NAMES = ["Blue", "Teal", "Rose", "Violet", "Green", "Orange", "Cyan", "Pink"];
const DIM_IN = 180;
const DIM_OUT = 250;
const UNDIM_DELAY = 70;
const NODE_ORDER = [0, 2, 1, 3];
const smooth = (t) => t * t * (3 - 2 * t);
const BIG_TITLE = 15; // below this header height on screen, comment titles go big
const CHUNK_MAX = 60; // a dragged note takes its island along up to this size
const GRAD_MAX = 160; // true per-link gradients up to this many bridges on screen

// opts (an embedded graph, e.g. a workspace's map): key - the setting its
// look is kept under; members() - the ids it may show (null = all); saved:
// false - no graph.json, so the main graph's layout is never touched;
// defaults - its look until it has one of its own
export function mountGraph(app, el, opts = {}) {
  const { vault } = app;
  const key = opts.key || "graph";
  const saved = opts.saved !== false;
  let S = graphSettings({ ...(opts.defaults || {}), ...(app.settings[key] || {}) });
  const persist = debounce(() => app.setSetting(key, structuredClone(S)), 250);
  const VIEW_KEYS = ["scope", "folder", "tag", "depth"];
  const linksTo = (from, to) => {
    const note = vault.notes.get(from);
    return !!note && note.links.some((l) => vault.resolve(l.target, from) === to);
  };
  const set = (k, v) => { if (VIEW_KEYS.includes(k) && S[k] !== v) remember(); S[k] = v; persist(); };
  /* The views the graph has shown (scope, focus, folder, tag, a selection focused on): Back returns to
     the one before - a note focused on by accident, and the rest of the graph gone, is one click away. */
  const past = [], ahead = [];
  let walking = false;
  const viewNow = () => ({ scope: S.scope, folder: S.folder, tag: S.tag, depth: S.depth, focusId, only: only ? [...only] : null });
  function remember() {
    if (walking) return;
    const v = viewNow(), last = past[past.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(v)) return;
    past.push(v);
    if (past.length > 40) past.shift();
    ahead.length = 0;
    paintWalk();
  }
  function walk(from, to) {
    if (!from.length) return;
    to.push(viewNow());
    const v = from.pop();
    walking = true;
    for (const k of VIEW_KEYS) set(k, v[k]);
    walking = false;
    focusId = v.focusId && vault.notes.has(v.focusId) ? v.focusId : null;
    only = v.only ? new Set(v.only) : null;
    autoFit = true;
    rebuild();
    renderPanel();
    paintWalk();
  }
  const goBack = () => walk(past, ahead), goAhead = () => walk(ahead, past);
  // the main graph narrowed from elsewhere (a workspace's "Open in the graph"): the view it showed is remembered, so Back returns to it
  if (key === "graph") app.graphScope = (scope, folder) => {
    remember();
    walking = true;
    set("scope", scope);
    set("folder", folder || "");
    walking = false;
    focusId = null;
    only = null;
    autoFit = true;
    rebuild();
    renderPanel();
    paintWalk();
  };
  async function saveView() {
    const auto = S.scope === "around" && (focusId || focusShown) ? basename(focusId || focusShown).replace(/\.md$/i, "") : S.scope === "folder" ? S.folder || "Folder" : S.scope === "tag" ? "#" + S.tag : "Whole graph";
    const { askDialog } = await import("./ui.js");
    const r = await askDialog("Save this view", [{ key: "name", label: "Name", value: auto }], { ok: "Save" });
    if (!r || !r.name) return;
    const v = { name: r.name, scope: S.scope, folder: S.folder, tag: S.tag, depth: S.depth, focusId, cam: { x: Math.round(cam.x), y: Math.round(cam.y), k: Math.round(cam.k * 1e4) / 1e4 } };
    set("views", [...S.views.filter((x) => x.name !== v.name), v].slice(-30));
    renderPanel();
    app.toast(`Saved “${v.name}” - in the panel, under Scope`, { ms: 2400 });
  }
  function goView(v) {
    remember();
    walking = true;
    for (const key of VIEW_KEYS) if (v[key] != null) set(key, v[key]);
    walking = false;
    focusId = v.focusId && vault.notes.has(v.focusId) ? v.focusId : null;
    only = null;
    autoFit = !v.cam;
    rebuild();
    if (v.cam) animateTo({ ...v.cam });
    renderPanel();
    paintWalk();
  }
  let backBtn = null, aheadBtn = null;
  function paintWalk() { if (backBtn) { backBtn.disabled = !past.length; aheadBtn.disabled = !ahead.length; } }
  // out of sight: hidden itself, or inside a hidden view (an embedded graph)
  const off = () => !el.isConnected || !!el.closest("[hidden]");
  // Alt+arrows (its Back and Forward buttons say so) go through the app's Back and Forward, which ask here first while
  // the graph is on screen and has a view to step to - the graph's own handler never saw them
  const prevStep = app.localStep;
  app.localStep = (dir) => {
    if (!off() && (dir < 0 ? past : ahead).length) { if (dir < 0) goBack(); else goAhead(); return true; }
    return prevStep ? prevStep(dir) : false;
  };

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  const canvas = h("canvas", { class: "graph-canvas" });
  canvas.addEventListener("pointerenter", () => { orbHold = true; });
  canvas.addEventListener("pointerleave", () => { orbHold = false; if (orb) kick(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && orb) kick(); });
  const ctx = canvas.getContext("2d");
  const tip = h("div", { class: "gx-tip", hidden: true });
  const boxEl = h("div", { class: "gx-box", hidden: true });
  const proxy = h("div", { class: "gx-proxy", draggable: "true", hidden: true, title: "Drag the selection out" });
  const dragChip = h("div", { class: "gx-dragchip" });
  const emptyEl = h("div", { class: "gx-empty", hidden: true });
  const panel = h("aside", { class: "gx-panel" });
  const hud = h("div", { class: "gx-hud" });
  const legendEl = h("div", { class: "gx-legend", hidden: true });
  const legendList = h("div", { class: "gx-leg-list" });
  const legendAll = h("button", { class: "gx-link", hidden: true, onclick: () => setHiddenGroups([]) }, "Show all");
  // the legend folds to its title, it never goes away
  const legendHide = h("button", { class: "gx-icon-btn is-tiny gx-leg-toggle", title: "Fold the legend", onclick: (e) => { e.stopPropagation(); setLegend(!S.showLegend); } }, icon("chevronDown"));
  legendEl.append(h("div", { class: "gx-leg-head", onclick: (e) => { if (!e.target.closest(".gx-link")) setLegend(!S.showLegend); } },
    h("span", { text: "Legend" }), h("span", { class: "gx-leg-acts" }, legendAll, legendHide)), legendList);
  const selbar = h("div", { class: "gx-selbar", hidden: true });
  const pathEl = h("div", { class: "gx-pathbox", hidden: true });
  const banner = h("div", { class: "gx-banner", hidden: true });
  const helpEl = h("div", { class: "gx-help", hidden: true });
  const bridgeEl = h("div", { class: "gx-pathbox gx-bridgebox", hidden: true });
  const wrap = h("div", { class: "graph-wrap gx", tabindex: "-1" }, canvas, boxEl, proxy, emptyEl, panel, hud, helpEl, pathEl, bridgeEl, banner, selbar, tip, dragChip);
  canvas.addEventListener("pointerleave", () => homeCardSoon(-1));
  el.append(wrap);

  /* ── reading lens (graphlens.js) ─────────────────────────────────────── */
  // Everything the lens needs from the view, and nothing more: it never
  // touches the layout, the camera or the selection.
  let rel = null; // correlation index, rebuilt with the graph
  const lens = createLens({
    wrap,
    app,
    vault,
    settings: () => S,
    set: (k, v) => set(k, v),
    refreshPanel: () => renderPanel(),
    toggleLens: (v) => toggleLens(v),
    kick: () => kick(),
    indexOf: (p) => { const i = G && p ? G.index.get(p) : undefined; return i === undefined ? -1 : i; },
    node: (i) => (G && i >= 0 && i < n ? G.nodes[i] : null),
    // lw: half the node's own label, so a card never lands on top of it
    screen: (i) => (G && i >= 0 && i < n
      ? { x: L.x[i] * cam.k + W / 2 + cam.x, y: L.y[i] * cam.k + H / 2 + cam.y, r: rad[i] * cam.k,
          lw: strongWidths[i] > 0 ? strongWidths[i] / 2 : Math.min(70, (labels[i] || "").length * 3.4) }
      : null),
    toScreen: (wx, wy) => ({ x: wx * cam.k + W / 2 + cam.x, y: wy * cam.k + H / 2 + cam.y }),
    toWorld: (sx, sy) => ({ x: (sx - W / 2 - cam.x) / cam.k, y: (sy - H / 2 - cam.y) / cam.k }),
    pickScreen: (cx, cy) => {
      const r = canvas.getBoundingClientRect();
      return pickAt((cx - r.left - W / 2 - cam.x) / cam.k, (cy - r.top - H / 2 - cam.y) / cam.k);
    },
    // every visible note within `r` screen pixels of a point, nearest first
    nodesWithin: (sx, sy, r) => {
      if (!G || !n) return [];
      if (gridStale) { grid.build(L.x, L.y, n, Math.max(24, maxR * 2.5)); gridStale = false; }
      const wx = (sx - W / 2 - cam.x) / cam.k;
      const wy = (sy - H / 2 - cam.y) / cam.k;
      const rw = (r + maxR * cam.k) / cam.k;
      const out = [];
      for (const i of grid.rect(wx - rw, wy - rw, wx + rw, wy + rw, vis)) {
        if (G.nodes[i].kind !== "note") continue;
        const d = Math.hypot(L.x[i] - wx, L.y[i] - wy) * cam.k;
        if (d <= r + rad[i] * cam.k) out.push({ i, d });
      }
      out.sort((a, b) => a.d - b.d);
      return out;
    },
    relations: () => (G ? (rel || (rel = buildRelations(G))) : null),
    resolve: (t, from) => vault.resolve(t, from) || "",
    linkText: (p) => vault.linkText(p),
    linksTo: (from, to) => linksTo(from, to),
    openNote: (i, newTab) => openNode(i, newTab),
    openSide: (i) => openSide(i),
    colors: () => colors,
  });
  // Pin or free every open reading card. With the lens off, the keys arm it
  // first, so the shortcut always does something visible.
  function pinAllCards(v) {
    if (!lens.on) {
      if (!v) return;
      toggleLens(true);
      app.toast("Reading lens on — hover a cluster, then Ctrl+Shift+P keeps its cards", { ms: 3000 });
      return;
    }
    lens.pinAll(v);
    renderPanel();
  }

  function toggleLens(v) {
    lens.setOn(v === undefined ? !lens.on : v);
    set("lens", lens.on);
    paintReadMode();
    wrap.classList.toggle("is-lens", lens.on);
    lens.showMode(lens.on ? "lens" : "tip");
    if (lens.on) tip.hidden = true;
    renderPanel();
  }

  /* ── state ───────────────────────────────────────────────────────────── */
  let G = null; // the built graph (graphcore.buildGraph)
  const L = createLayout();
  const grid = createHitGrid();
  let n = 0;
  let m = 0;
  let rad = new Float64Array(0); // node radius, world units
  let vis = new Uint8Array(0); // 0 = in a group hidden from the legend
  let emph = new Uint8Array(0); // emphasised by hover / path / search
  let eEmph = new Uint8Array(0);
  // Emphasis fades: dimT eases the dimming in and out, and when it moves from
  // one set to another the previous set (emphPrev) fades out while the new
  // one fades in over swapT, so hopping between nodes never flashes.
  let emphPrev = new Uint8Array(0);
  let eEmphPrev = new Uint8Array(0);
  let dimT = 0;
  let dimGoal = 0;
  let swapT = 1;
  let fadeAt = 0;
  let emphHover = -1; // the hover the emphasis shows; lags a moment on leave
  let undimTimer = 0;
  let selMask = new Uint8Array(0);
  let selIdx = [];
  let pinIdx = [];
  let labels = [];
  let byDeg = new Int32Array(0);
  let groups = [];
  let groupOf = new Int32Array(0);
  let members = [];
  let gColor = [];
  let maxR = 8;
  let alpha = 0;
  let alphaTarget = 0;
  let raf = 0;
  const cam = { x: 0, y: 0, k: 1 };
  const fitT = { x: 0, y: 0, k: 1 };
  let tween = null;
  let autoFit = true;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let insetL = 0;
  let colors = {};
  let theme = "dark";
  let hover = -1;
  let dirty = true;
  let gridStale = true;
  let drag = null;
  let tipTimer = 0;
  const memo = new Map(); // id -> { x, y }: positions survive rebuilds and scope changes
  // the timeline layout while it is on: every dot placed by its time and folder, nothing simulated - and the
  // free layout in memo left as it was, so switching back finds the graph where it was left
  let tl = null;
  // the orbit while it is on: the free layout as it stands, each top folder at a depth of its own, turned slowly
  // round its middle (drawn into L each frame; memo, the free layout, is never written meanwhile). Stops while
  // the pointer is over the graph, so a dot can be hovered and clicked
  let orb = null, orbHold = false;
  const TILT = 0.38;
  const pins = new Set();
  const selected = new Set();
  const hidden = new Set();
  let only = null; // Set of ids while focused on a selection
  let focusId = null; // a picked focus; null follows the current note
  let focusShown = null;
  const crumbs = [];
  let query = "";
  let matches = [];
  let matchAt = -1;
  let path = null; // { from, to, res, one, all }
  let picking = null; // { from: id } while choosing where a path ends
  const forces = { repel: 1, linkDistance: 60, gravity: 1, radial: 0, theta: 0.9 };
  const perf = { frames: 0, steps: 0, stepMs: 0, drawMs: 0, maxDraw: 0, builds: 0, buildMs: 0, searchMs: 0 };
  // comment frames: world rectangles behind everything; array order is z-order
  let frames = [];
  let frameSel = null; // id of the highlighted frame
  let frameHover = null;
  let frameHits = [];
  let editing = null; // { f, field, input } while a title or note is edited
  let mouseW = null; // last pointer position in world units
  let cursor = "";
  let menuAt = 0; // a right-click menu just opened: ignore the contextmenu event behind it
  const legFold = new Set(); // folder categories folded in the legend
  // Homes: a cluster dragged out of the pool settles round an anchor of its
  // own (a soft local gravity in the layout) instead of being pinned.
  const homes = new Map(); // home id -> { id, x, y, name }
  const homeOf = new Map(); // node id -> home id
  let hList = []; // homes on screen; homeIdx and L.home index into it
  let hMembers = [];
  let hCore = [];
  let homeIdx = new Int32Array(0); // per node, -1 = the pool
  let hcx = new Float64Array(0); // halo centre and radius, measured per frame
  let hcy = new Float64Array(0);
  let hr = new Float64Array(0);
  let hHover = -1;
  let homeSeq = 0;
  let renaming = null; // home id being renamed in the panel
  let degArr = new Int32Array(0);
  let pullBase = new Float64Array(0);
  // bridges: links between homes / colour groups
  let eCls = new Uint8Array(0);
  let bridgeN = 0;
  let onB = new Uint8Array(0);
  let bBuf = new Int32Array(0);
  let bridgeSel = null; // { kind, key, label, src, edges, other } for "Show bridges from here"
  let held = new Uint8Array(0); // under the pointer right now: halos leave them out

  /* ── saved layout (graph.json) ───────────────────────────────────────── */
  // Positions, pins, frames and the camera, loaded once on mount. Nothing is
  // written before the load answers, so a slow disk never wipes the file.
  let loaded = false;
  let restoring = false; // the first build after loading keeps the saved shape
  let restoreCam = null;
  let saveDirty = false;
  const alive = (id) => vault.notes.has(id) || !!(vault.files && vault.files.has(id)) || id.startsWith("tag:");
  function saveNow() {
    saveGraphSoon.cancel();
    if (!saved || !loaded || !saveDirty) return;
    saveDirty = false;
    saveMemo();
    const data = writeGraphDoc({ pos: memo, pins, frames, cam, homes, homeOf }, alive, G ? G.nodes.map((nd) => nd.id) : []);
    Promise.resolve().then(() => host.saveGraph(data)).catch(() => {});
  }
  const saveGraphSoon = debounce(saveNow, 1500);
  const touch = () => { saveDirty = true; saveGraphSoon(); };
  let waiting = false; // show() came before the file
  let waited = false;
  let waitTimer = 0;
  function applyLoaded(raw) {
    clearTimeout(waitTimer);
    const d = readGraphDoc(raw);
    for (const [id, p] of d.pos) memo.set(id, p);
    for (const id of d.pins) pins.add(id);
    for (const [id, hm] of d.homes) if (!homes.has(id)) homes.set(id, hm);
    for (const [id, hid] of d.homeOf) if (!homeOf.has(id)) homeOf.set(id, hid);
    frames = [...d.frames, ...frames];
    restoreCam = d.cam;
    restoring = d.pos.size > 0;
    loaded = true;
    if (!G) {
      if (waiting && !off()) show();
      return;
    }
    // built before the file came back: rebuild from the saved layout
    G = null;
    dirty = true;
    alpha = 0;
    autoFit = true;
    if (!off()) { rebuild(); renderPanel(); }
  }
  if (saved) Promise.resolve().then(() => host.loadGraph()).then(applyLoaded, () => applyLoaded(null));
  else applyLoaded(null);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });
  window.addEventListener("pagehide", saveNow);
  new MutationObserver(() => { if (el.hidden) { saveNow(); closeEdit(true); helpEl.hidden = true; lens.closeAll(); } }).observe(el, { attributes: true, attributeFilter: ["hidden"] });

  /* ── building ────────────────────────────────────────────────────────── */
  function saveMemo() {
    if (!G || tl || orb) return;
    for (let i = 0; i < n; i++) {
      const id = G.nodes[i].id;
      const p = memo.get(id);
      if (p) { p.x = L.x[i]; p.y = L.y[i]; }
      else memo.set(id, { x: L.x[i], y: L.y[i] });
    }
  }

  function pushCrumb(id) {
    if (crumbs[crumbs.length - 1] === id) return;
    const at = crumbs.indexOf(id);
    if (at >= 0) crumbs.splice(at, 1);
    crumbs.push(id);
    if (crumbs.length > 8) crumbs.shift();
  }

  let hoverEdge = -1; // the link under the pointer
  // a bridge drawn as a curve: its control point (the lower index first, so a pair always bows the same way)
  const bowed = (e) => S.crossLinks && S.bridgeCurve && bridgeN > 0 && !!(eCls[e] & crossMask(S.crossBy));
  function bowOf(e) {
    let a = G.src[e], b = G.dst[e];
    if (a > b) { const t = a; a = b; b = t; }
    const dx = L.x[b] - L.x[a], dy = L.y[b] - L.y[a];
    return { a, b, cx: (L.x[a] + L.x[b]) / 2 - dy * 0.2, cy: (L.y[a] + L.y[b]) / 2 + dx * 0.2 };
  }
  function rebuild() {
    hoverEdge = -1;
    const t0 = performance.now();
    dirty = false;
    unwash(); // the ships' wash belongs to the old layout
    saveMemo();
    const around = S.scope === "around";
    const current = app.lastNotePath ? app.lastNotePath() : null;
    if (focusId && !vault.notes.has(focusId)) focusId = null;
    const focus = around ? focusId || current : null;
    focusShown = focus;
    if (around && focus) pushCrumb(focus);
    const resolve = makeResolver(vault.notes.keys(), (t, from) => vault.resolve(t, from));
    G = buildGraph(
      { notes: vault.notes.values(), resolve, resolveFile: vault.resolveFile ? (t, from) => vault.resolveFile(t, from) : null },
      {
        scope: S.scope, focus, depth: S.depth, folder: S.folder, tag: S.tag, orphans: S.orphans,
        attachments: S.attachments, tagNodes: S.tagNodes, unresolved: S.unresolved, exclude: S.exclude, hidden, only: only || (opts.members ? opts.members() : null),
      }
    );
    n = G.nodes.length;
    m = G.src.length;
    L.resize(n, m);
    if (rad.length < n) {
      const c = Math.max(n, rad.length * 2);
      rad = new Float64Array(c); vis = new Uint8Array(c); emph = new Uint8Array(c); emphPrev = new Uint8Array(c); selMask = new Uint8Array(c);
    }
    if (eEmph.length < m) { eEmph = new Uint8Array(Math.max(m, eEmph.length * 2)); eEmphPrev = new Uint8Array(eEmph.length); }
    const deg = new Int32Array(n);
    if (pullBase.length < n) pullBase = new Float64Array(Math.max(n, rad.length));
    labels = new Array(n);
    for (let i = 0; i < n; i++) {
      const nd = G.nodes[i];
      deg[i] = nd.deg;
      labels[i] = nd.label.length > 42 ? nd.label.slice(0, 40) + "…" : nd.label;
    }
    byDeg = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => deg[b] - deg[a]);
    widths.fill(-1);
    strongWidths.fill(-1);

    degArr = deg;
    // positions: remembered, else next to a placed neighbour, else a spiral
    const placed = new Uint8Array(n);
    const isNew = new Uint8Array(n);
    let fresh = 0;
    for (let i = 0; i < n; i++) {
      const p = memo.get(G.nodes[i].id);
      L.vx[i] = 0; L.vy[i] = 0;
      if (p) { L.x[i] = p.x; L.y[i] = p.y; placed[i] = 1; }
    }
    for (const i of byDeg) {
      if (placed[i]) continue;
      fresh++;
      isNew[i] = 1;
      let a = -1;
      for (let k = G.start[i]; k < G.start[i + 1]; k++) if (placed[G.adj[k]]) { a = G.adj[k]; break; }
      const ang = i * 2.399963;
      if (a >= 0) {
        L.x[i] = L.x[a] + Math.cos(ang) * S.linkDistance * 0.7;
        L.y[i] = L.y[a] + Math.sin(ang) * S.linkDistance * 0.7;
      } else {
        const r = 12 * Math.sqrt(fresh + 0.5);
        L.x[i] = Math.cos(ang) * r;
        L.y[i] = Math.sin(ang) * r;
      }
      placed[i] = 1;
    }
    // around a note, the focus sits at the centre and the rest keeps its shape
    if (around && G.focus >= 0 && !pins.has(G.nodes[G.focus].id)) {
      const fx = L.x[G.focus];
      const fy = L.y[G.focus];
      for (let i = 0; i < n; i++) if (!pins.has(G.nodes[i].id)) { L.x[i] -= fx; L.y[i] -= fy; }
    }
    // A new note moves into a home only when all its links lead into that
    // one home; anything else starts in the pool.
    if (homes.size && fresh && !around) {
      const hOf = (j) => homeOf.get(G.nodes[j].id) || null;
      for (let i = 0; i < n; i++) {
        if (!isNew[i] || G.nodes[i].kind !== "note" || homeOf.has(G.nodes[i].id)) continue;
        const hid = adoptHome(G.adj.subarray(G.start[i], G.start[i + 1]), hOf);
        if (hid && homes.has(hid)) homeOf.set(G.nodes[i].id, hid);
      }
    }
    const radial = around && S.radial && G.focus >= 0;
    const gap = S.linkDistance * 2.1;
    // small islands would drift far off the main mass: pull them in harder
    const cc = components(G);
    const small = Math.max(3, n * 0.04);
    maxR = 1;
    for (let i = 0; i < n; i++) {
      const nd = G.nodes[i];
      L.pull[i] = cc.size[cc.comp[i]] < small ? 3.5 : 1;
      pullBase[i] = L.pull[i];
      L.fixed[i] = pins.has(nd.id) || (around && i === G.focus) ? 1 : 0;
      L.charge[i] = nd.kind === "note" ? 1 + Math.sqrt(nd.deg) * 0.3 : 0.6;
      L.ring[i] = radial && nd.dist > 0 ? nd.dist * gap : -1;
    }
    const key = radial ? [focus, S.depth, S.linkDistance].join("|") : "";
    if (radial && key !== ringKey) seedRings(gap);
    ringKey = key;
    ringGap = radial ? gap : 0;
    ringMax = 0;
    if (radial) for (let i = 0; i < n; i++) ringMax = Math.max(ringMax, G.nodes[i].dist);
    sizeNodes();
    syncHomes(false);

    // selection, path and search follow the ids into the new indices
    for (const id of [...selected]) if (!G.index.has(id)) selected.delete(id);
    hover = -1;
    emphHover = -1;
    clearTimeout(undimTimer);
    tip.hidden = true;
    if (path) {
      const a = G.index.get(path.from);
      const b = G.index.get(path.to);
      path = a !== undefined && b !== undefined ? makePath(a, b, path.all) : null;
    }
    if (picking && !G.index.has(picking.from)) picking = null;
    regroup();
    if (bridgeSel) bridgeSel = makeBridgeSel(bridgeSel.kind, bridgeSel.key);
    syncSelection();
    syncPins();
    syncForces();
    runSearch(false);
    updateEmphasis(false);
    paintChrome();
    gridStale = true;
    rel = null; // the lens rebuilds its tag / neighbour index lazily
    if (lens.on) lens.rebuilt();
    tl = S.layout === "timeline" && n ? timelineLayout(G, (nd) => (nd.kind === "note" ? (app.vault.get(nd.path) || {}).mtime : nd.kind === "file" ? (app.vault.files.get(nd.path) || {}).mtime : 0) || 0) : null;
    if (tl) { for (let i = 0; i < n; i++) { L.x[i] = tl.x[i]; L.y[i] = tl.y[i]; L.vx[i] = 0; L.vy[i] = 0; } autoFit = true; gridStale = true; }
    orb = S.layout === "orbit" && n ? makeOrbit(fresh, orb) : null;
    if (orb) { projectOrbit(); autoFit = true; }
    perf.builds++;
    perf.buildMs = performance.now() - t0;
    // opening on a saved layout: it is already settled, so barely stir it
    const restored = restoring && fresh <= n * 0.1;
    if (loaded) restoring = false;
    if (restored && restoreCam && !around) { Object.assign(cam, restoreCam); autoFit = false; }
    if (loaded) restoreCam = null;
    heat(restored ? Math.max(0.02, fresh / Math.max(1, n)) : fresh > n * 0.3 ? 1 : Math.max(0.35, fresh / Math.max(1, n)));
  }
  const rebuildSoon = debounce(() => { if (!off()) rebuild(); }, 120);

  // Rings: the first ring keeps the order its nodes already had round the
  // focus but spreads over the whole circle; each outer node starts next to
  // its parents, then that ring is spread the same way.
  let ringKey = "";
  let ringGap = 0;
  let ringMax = 0;
  const dash = [4, 6];
  const noDash = [];
  function seedRings(gap) {
    const ang = new Float64Array(n);
    const rings = [];
    for (let i = 0; i < n; i++) {
      const d = G.nodes[i].dist;
      if (d <= 0) continue;
      (rings[d] || (rings[d] = [])).push(i);
    }
    for (let d = 1; d < rings.length; d++) {
      const list = rings[d];
      if (!list) continue;
      for (const i of list) {
        if (d === 1) { ang[i] = Math.atan2(L.y[i], L.x[i]); continue; }
        let sx = 0, sy = 0;
        for (let k = G.start[i]; k < G.start[i + 1]; k++) {
          const j = G.adj[k];
          if (G.nodes[j].dist === d - 1) { sx += Math.cos(ang[j]); sy += Math.sin(ang[j]); }
        }
        ang[i] = sx || sy ? Math.atan2(sy, sx) : Math.atan2(L.y[i], L.x[i]);
      }
      list.sort((a, b) => ang[a] - ang[b]);
      const off = ang[list[0]];
      list.forEach((i, t) => {
        ang[i] = off + (t / list.length) * TAU;
        if (pins.has(G.nodes[i].id)) return;
        L.x[i] = Math.cos(ang[i]) * d * gap;
        L.y[i] = Math.sin(ang[i]) * d * gap;
      });
    }
  }

  function sizeNodes() {
    maxR = 1;
    for (let i = 0; i < n; i++) {
      const nd = G.nodes[i];
      const base = S.nodeSize * (nd.kind === "note" ? 4 : 3.2);
      let r = S.sizeByLinks ? base * Math.min(7, 1 + Math.sqrt(nd.kind === "note" ? nd.deg : nd.refs) * 0.42) : base;
      if (i === G.focus) r = Math.max(r * 1.35, base * 2.6);
      rad[i] = r;
      if (r > maxR) maxR = r;
    }
    gridStale = true;
  }

  const folderRules = () => ({ depth: S.folderDepth, split: S.splitFolders, own: S.ownFolders });
  function regroup() {
    const r = assignGroups(G.nodes, { colorBy: S.colorBy, rules: S.rules, theme, folders: folderRules() });
    groups = r.groups;
    groupOf = r.groupOf;
    const lists = groups.map(() => []);
    for (let i = 0; i < n; i++) lists[groupOf[i]].push(i);
    members = lists.map((l) => Int32Array.from(l));
    paintGroupColors();
    reclassify();
    renderLegend();
  }

  /* ── homes ───────────────────────────────────────────────────────────── */
  const homesOn = () => S.scope !== "around";

  // homes on screen, their members and cores, into the layout
  function syncHomes(classify = true) {
    if (homeIdx.length < n) homeIdx = new Int32Array(Math.max(n, rad.length));
    homeIdx.fill(-1, 0, n);
    const at = new Map();
    const lists = [];
    hList = [];
    if (homesOn() && homes.size) {
      for (let i = 0; i < n; i++) {
        const hid = homeOf.get(G.nodes[i].id);
        if (!hid) continue;
        let k = at.get(hid);
        if (k === undefined) {
          const hm = homes.get(hid);
          if (!hm) continue;
          k = hList.length;
          at.set(hid, k);
          hList.push(hm);
          lists.push([]);
        }
        homeIdx[i] = k;
        lists[k].push(i);
      }
    }
    hMembers = lists.map((l) => Int32Array.from(l));
    hCore = lists.map((l, k) => { const want = hList[k].core; const j = want ? l.find((i) => G.nodes[i].id === want) : undefined; return j !== undefined ? j : homeCore(l, degArr); });
    const hk = hList.length;
    L.setHomes(hk);
    for (let k = 0; k < hk; k++) { L.hx[k] = hList[k].x; L.hy[k] = hList[k].y; }
    for (let i = 0; i < n; i++) L.home[i] = homeIdx[i];
    countRoutes();
    fogAt = 0;
    for (const c of hCore) if (c >= 0) L.hw[c] = CORE_WEIGHT;
    if (hcx.length < hk) { const c = Math.max(hk, hcx.length * 2, 8); hcx = new Float64Array(c); hcy = new Float64Array(c); hr = new Float64Array(c); }
    if (hHover >= hk) hHover = -1;
    applyLinks();
    syncForces();
    if (classify) reclassify();
  }

  // spring strengths: d3's, softened along rings and across homes
  function applyLinks() {
    L.setLinks(G.src, G.dst, degArr);
    const { src, dst } = G;
    if (S.scope === "around" && S.radial && G.focus >= 0) {
      // links along a ring would drag the whole ring round to one side
      for (let e = 0; e < m; e++) if (G.nodes[src[e]].dist === G.nodes[dst[e]].dist) L.lstr[e] *= 0.04;
    }
    for (let i = 0; i < n; i++) L.pull[i] = pullBase[i];
    if (!hList.length) return;
    for (let e = 0; e < m; e++) {
      const a = src[e], b = dst[e];
      if (homeIdx[a] === homeIdx[b]) continue;
      L.lstr[e] *= BRIDGE_PULL;
      // a pool note linked out was likely dragged along: it heads home faster
      if (homeIdx[a] < 0 && L.pull[a] < 2.5) L.pull[a] = 2.5;
      if (homeIdx[b] < 0 && L.pull[b] < 2.5) L.pull[b] = 2.5;
    }
  }

  let isNoteArr = new Uint8Array(0);
  function reclassify() {
    if (!G) return;
    if (eCls.length < m) eCls = new Uint8Array(Math.max(m, eCls.length * 2));
    if (isNoteArr.length < n) isNoteArr = new Uint8Array(Math.max(n, rad.length));
    for (let i = 0; i < n; i++) isNoteArr[i] = G.nodes[i].kind === "note" ? 1 : 0;
    classifyEdges(G.src, G.dst, m, homeIdx, S.colorBy === "none" ? null : groupOf, isNoteArr, eCls);
    countBridges();
    applyHiddenGroups();
  }

  function countBridges() {
    const mask = crossMask(S.crossBy);
    bridgeN = 0;
    for (let e = 0; e < m; e++) if (eCls[e] & mask) bridgeN++;
  }

  const homeName = (k) => hList[k].name || (hCore[k] >= 0 ? G.nodes[hCore[k]].label : "Home");
  const homeColor = (k) => {
    const c = hCore[k];
    return c >= 0 && groups[groupOf[c]] && groups[groupOf[c]].color ? gColor[groupOf[c]] : colors.strong;
  };
  const refix = (i) => { L.fixed[i] = pins.has(G.nodes[i].id) || (S.scope === "around" && i === G.focus) ? 1 : 0; };

  function centroid(list) {
    let x = 0, y = 0;
    for (const i of list) { x += L.x[i]; y += L.y[i]; }
    return { x: x / list.length, y: y / list.length };
  }

  function pruneHomes() {
    const used = new Set(homeOf.values());
    for (const id of [...homes.keys()]) if (!used.has(id)) homes.delete(id);
    if (bridgeSel && bridgeSel.kind === "home" && !homes.has(bridgeSel.key)) bridgeSel = null;
  }

  function homesChanged(a = 0.3) {
    pruneHomes();
    syncPins();
    syncHomes();
    if (bridgeSel) bridgeSel = makeBridgeSel(bridgeSel.kind, bridgeSel.key);
    renderBridges();
    updateEmphasis();
    touch();
    alphaTarget = 0;
    heat(a);
    renderPanel();
  }

  // a note's island, if small: linked notes outside any home and, when
  // colours mark categories, in the same one (a bridge into the pool must
  // not drag pool notes along)
  function chunkOf(i) {
    const seen = new Set([i]);
    const queue = [i];
    const g = groups[groupOf[i]] && groups[groupOf[i]].color ? groupOf[i] : -1;
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      for (let a = G.start[u]; a < G.start[u + 1]; a++) {
        const v = G.adj[a];
        if (seen.has(v) || homeIdx[v] >= 0 || G.nodes[v].kind !== "note" || (g >= 0 && groupOf[v] !== g)) continue;
        seen.add(v);
        queue.push(v);
        if (seen.size > CHUNK_MAX) return [i];
      }
    }
    return queue;
  }

  const homeSnap = (list) => ({ hs: [...homes.values()].map((hm) => ({ ...hm })), was: list.map((j) => [G.nodes[j].id, homeOf.get(G.nodes[j].id), pins.has(G.nodes[j].id)]) });
  function homeRestore(s) {
    for (const hm of s.hs) { const now = homes.get(hm.id); if (!now) homes.set(hm.id, hm); else now.core = hm.core; }
    for (const [id, hid, pinned] of s.was) { if (hid) homeOf.set(id, hid); else homeOf.delete(id); if (pinned) pins.add(id); }
    homesChanged(0.2);
  }
  // a home made from a menu or a button, with its way back
  function homeWithUndo(list, at, text) {
    const snap = homeSnap(list);
    const hm = makeHome(list, at);
    if (hm) undoable(text || `${list.length === 1 ? "This note has" : `${list.length} notes have`} a home of their own`, () => homeRestore(snap));
    return hm;
  }
  // one whole home let go on another: its notes move in, and it is gone
  function mergeHome(from, into) {
    const list = Array.from(hMembers[from]);
    const snap = homeSnap(list);
    const name = homeName(into);
    for (const j of list) { homeOf.set(G.nodes[j].id, hList[into].id); pins.delete(G.nodes[j].id); refix(j); }
    homesChanged(0.25);
    undoable(`${list.length === 1 ? "The note joined" : `${list.length} notes joined`} “${name}”`, () => homeRestore(snap));
  }

  function makeHome(list, at = null, name = "", sync = true) {
    if (!G || !list.length) return null;
    if (!homesOn()) { app.toast("Homes work in the All, Folder and Tag scopes"); return null; }
    const c = at || centroid(list);
    const hm = cleanHome({ id: "h" + Date.now().toString(36) + (homeSeq++).toString(36), x: c.x, y: c.y, name });
    homes.set(hm.id, hm);
    for (const i of list) {
      const id = G.nodes[i].id;
      homeOf.set(id, hm.id);
      pins.delete(id);
      refix(i);
    }
    if (sync) homesChanged();
    return hm;
  }

  // Back in the pool means back in the simulation: a note that lost its home
  // must also lose the pin and the fixed flag it may have picked up on the
  // way there, or it sits still while everything around it moves. The pin is
  // dropped from the saved layout too (graph.json keeps pins and homes).
  function freeToPool(list) {
    for (const i of list) {
      if (i < 0 || i >= n) continue;
      pins.delete(G.nodes[i].id);
      L.vx[i] = 0;
      L.vy[i] = 0;
      if (held.length > i) held[i] = 0;
      refix(i);
    }
  }

  function sendToPool(list, sync = true) {
    for (const i of list) homeOf.delete(G.nodes[i].id);
    freeToPool(list);
    if (sync) homesChanged(0.5);
  }

  function dissolveHome(id) {
    const list = [];
    for (let i = 0; i < n; i++) if (homeOf.get(G.nodes[i].id) === id) list.push(i);
    for (const [nid, hid] of [...homeOf]) if (hid === id) homeOf.delete(nid);
    freeToPool(list);
    homesChanged(0.5);
  }

  function moveHomeTo(k, x, y) {
    const hm = hList[k];
    hm.x = Math.round(x);
    hm.y = Math.round(y);
    L.hx[k] = hm.x;
    L.hy[k] = hm.y;
  }

  // the home whose halo holds a world point
  function homeAt(wx, wy, slop = 0, skip = -1) {
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < hList.length; k++) {
      if (hr[k] <= 0 || k === skip) continue;
      const d = Math.hypot(wx - hcx[k], wy - hcy[k]);
      if (d < hr[k] + slop && d / hr[k] < bd) { bd = d / hr[k]; best = k; }
    }
    return best;
  }

  const outMargin = () => Math.max(140, S.linkDistance * 2.5);
  function poolNow(extraSkip) {
    const skip = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (homeIdx[i] >= 0 || !vis[i] || L.fixed[i] || pins.has(G.nodes[i].id)) skip[i] = 1;
    if (extraSkip) for (const j of extraSkip) skip[j] = 1;
    return poolExtent(L.x, L.y, n, skip);
  }

  // A dragged note or selection was let go: into a home, out to a new one,
  // or back into the pool (where it stays pinned, as before).
  function dropHome(grp, c0) {
    if (!homesOn()) return false;
    const c = centroid(grp);
    const k0 = homeIdx[grp[0]];
    const same = k0 >= 0 && grp.every((j) => homeIdx[j] === k0);
    // the whole of one home carried at once: the home moves with it
    if (same && hMembers[k0].length === grp.length) {
      const into = homeAt(c.x, c.y, 20 / cam.k, k0);
      if (into >= 0) { mergeHome(k0, into); return true; }
      moveHomeTo(k0, hList[k0].x + c.x - c0.x, hList[k0].y + c.y - c0.y);
      for (const j of grp) refix(j);
      homesChanged(0.12);
      return true;
    }
    const hit = homeAt(c.x, c.y, 20 / cam.k);
    if (hit >= 0) {
      // rearranged inside its own home: let go, it settles back in
      if (same && hit === k0) { for (const j of grp) refix(j); alphaTarget = 0; heat(0.15); return true; } // the drag's warmth ends here, or it never settles
      const snap = homeSnap(grp);
      const name = homeName(hit);
      for (const j of grp) { homeOf.set(G.nodes[j].id, hList[hit].id); pins.delete(G.nodes[j].id); refix(j); }
      homesChanged(0.2);
      undoable(`${grp.length === 1 ? "Moved into" : `${grp.length} notes moved into`} “${name}”`, () => homeRestore(snap));
      return true;
    }
    const pe = poolNow(grp);
    if (pe.count >= 8 && Math.hypot(c.x - pe.cx, c.y - pe.cy) > pe.r + outMargin()) {
      const list = grp.length === 1 && homeIdx[grp[0]] < 0 ? chunkOf(grp[0]) : grp;
      const snap = homeSnap(list);
      const hm = makeHome(list, c, "", false);
      homesChanged(0.3);
      // pool notes it dragged along glide back to the pool's edge
      const kk = hList.indexOf(hm);
      if (kk >= 0) {
        for (const j of hMembers[kk]) {
          for (let a = G.start[j]; a < G.start[j + 1]; a++) {
            const v = G.adj[a];
            if (homeIdx[v] >= 0 || L.fixed[v]) continue;
            const dx = L.x[v] - pe.cx, dy = L.y[v] - pe.cy;
            const d = Math.hypot(dx, dy);
            if (d <= pe.r) continue;
            const f = (pe.r * 0.92) / d;
            L.vx[v] = (pe.cx + dx * f - L.x[v]) * 0.4;
            L.vy[v] = (pe.cy + dy * f - L.y[v]) * 0.4;
          }
        }
      }
      undoable(`${list.length === 1 ? "This note has" : `${list.length} notes have`} a home here`, () => homeRestore(snap));
      return kk >= 0;
    }
    // dragged out of its home and let go in the pool: it rejoins the pool for
    // real, loose and unpinned, instead of being dropped there and frozen
    if (grp.some((j) => homeIdx[j] >= 0)) { sendToPool(grp); return true; }
    return false;
  }

  // pinned clusters left outside the pool (dragged there before homes
  // existed) become homes
  function pinnedOutliers() {
    if (!G || !homesOn()) return [];
    const pe = poolNow(null);
    if (pe.count < 8) return [];
    const lim = pe.r + outMargin();
    const out = [];
    for (const i of pinIdx) if (vis[i] && homeIdx[i] < 0 && Math.hypot(L.x[i] - pe.cx, L.y[i] - pe.cy) > lim) out.push(i);
    return out;
  }

  function homesForPinned() {
    const list = pinnedOutliers();
    if (!list.length) return app.toast("No pinned notes outside the pool");
    const lab = clusterPoints(list.map((i) => L.x[i]), list.map((i) => L.y[i]), S.linkDistance * 2.5);
    const byLab = [];
    list.forEach((i, t) => (byLab[lab[t]] || (byLab[lab[t]] = [])).push(i));
    for (const l of byLab) makeHome(l, null, "", false);
    homesChanged(0.3);
    app.toast(`Gave ${plural(byLab.length, "cluster")} a home`);
  }

  function flyToHome(k) {
    const t = {};
    const r = hr[k] > 0 ? hr[k] : 120;
    const x = hr[k] > 0 ? hcx[k] : hList[k].x;
    const y = hr[k] > 0 ? hcy[k] : hList[k].y;
    if (fitBox(x - r, y - r, x + r, y + r, 1.6, t)) animateTo(t);
  }

  /* A home's card: hovering its halo (away from its notes) shows its notes, when one was last
     changed, its open tasks and its centre, with a way to fly there or select them. */
  const homeCard = h("div", { class: "gx-homecard", hidden: true });
  let cardK = -1, cardTimer = 0, overCard = false;
  homeCard.addEventListener("mouseenter", () => { overCard = true; });
  homeCard.addEventListener("mouseleave", () => { overCard = false; homeCardSoon(-1); });
  function homeCardSoon(k) {
    // leaving before the card came up: the card on its way is called off too (it used to come up anyway)
    if (k === cardK && (k < 0 || !homeCard.hidden)) { if (k < 0) clearTimeout(cardTimer); return; }
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => { if (k < 0 && overCard) return; showHomeCard(k); }, k >= 0 ? 450 : 250);
  }
  function showHomeCard(k) {
    cardK = k;
    if (k < 0 || k >= hList.length || hr[k] <= 0) { homeCard.hidden = true; return; }
    if (!homeCard.isConnected) wrap.append(homeCard);
    const ids = Array.from(hMembers[k]).map((i) => G.nodes[i]).filter((nd) => nd.kind === "note");
    const last = Math.max(0, ...ids.map((nd) => (vault.notes.get(nd.id) || {}).mtime || 0));
    const names = new Set(ids.map((nd) => basename(nd.id).replace(/\.md$/i, "").toLowerCase()));
    const open = (app.tasks && app.tasks.all ? app.tasks.all : []).filter((t) => !t.done && !t.deleted && /\[\[/.test(t.text || "") &&
      [...String(t.text).matchAll(/\[\[([^\]|#]+)/g)].some((m2) => names.has(basename(m2[1].trim()).toLowerCase()))).length;
    const core = hCore[k] >= 0 ? G.nodes[hCore[k]] : null;
    const ago = (t) => { const d = Math.round((Date.now() - t) / 864e5); return d < 1 ? "today" : d === 1 ? "yesterday" : d < 60 ? `${d} days ago` : new Date(t).toLocaleDateString(); };
    homeCard.replaceChildren(
      h("div", { class: "gx-hc-title" }, icon("home"), h("span", { text: homeName(k) })),
      h("div", { class: "gx-hc-row", text: `${plural(ids.length, "note")}${last ? ` · changed ${ago(last)}` : ""}` }),
      h("div", { class: "gx-hc-row", text: open ? plural(open, "open task") : "No open tasks" }),
      core ? h("button", { class: "gx-hc-core", title: "Open the note it centres on", onclick: () => app.openNote(core.id) }, icon("target"), h("span", { text: core.label })) : null,
      h("div", { class: "gx-btnrow" },
        h("button", { class: "gx-chip", onclick: () => { flyToHome(k); homeCard.hidden = true; } }, icon("expand"), "Fly there"),
        h("button", { class: "gx-chip", onclick: () => { selectHome(k); homeCard.hidden = true; } }, icon("check"), "Select its notes")));
    const sx = hcx[k] * cam.k + W / 2 + cam.x, sy = (hcy[k] - hr[k]) * cam.k + H / 2 + cam.y;
    homeCard.hidden = false;
    homeCard.style.left = Math.max(8, Math.min(W - homeCard.offsetWidth - 8, sx - homeCard.offsetWidth / 2)) + "px";
    homeCard.style.top = Math.max(8, sy - homeCard.offsetHeight - 30) + "px";
  }

  function selectHome(k) {
    selected.clear();
    for (const i of hMembers[k]) if (vis[i]) selected.add(G.nodes[i].id);
    syncSelection();
    kick();
  }

  function renameHome(id) {
    renaming = id;
    if (!S.open.homes) { S.open = { ...S.open, homes: true }; persist(); }
    if (!S.panel) setPanel(true);
    renderPanel();
  }

  function homeMenu(k, x, y) {
    const hm = hList[k];
    hHover = k;
    kick();
    const notesIn = Array.from(hMembers[k]).filter((i) => G.nodes[i].kind === "note");
    app.menu(x, y, [
      { header: `${homeName(k)} · ${plural(hMembers[k].length, "note")}`, plain: true },
      { label: "Rename home…", icon: "edit", run: () => renameHome(hm.id) },
      { label: "Show bridges from here", icon: "link", run: () => showBridges("home", hm.id) },
      { label: "Select its notes", icon: "check", run: () => selectHome(k) },
      { label: "Zoom to home", icon: "expand", run: () => flyToHome(k) },
      notesIn.length ? { label: "Make research board", icon: "sparkles", run: () => openAsBoard(notesIn, false, hm.name) } : null,
      { label: "Comment around it", icon: "square", run: () => commentAround(Array.from(hMembers[k])) },
      "sep",
      { label: "Send all back to the pool", icon: "undo", danger: true, run: () => { const snap = homeSnap(Array.from(hMembers[k])), nm = homeName(k); dissolveHome(hm.id); undoable(`“${nm}” is back in the pool`, () => homeRestore(snap)); } },
    ]);
  }

  /* ── bridges from a home or group ────────────────────────────────────── */
  function makeBridgeSel(kind, key) {
    if (!G) return null;
    const src = new Uint8Array(n);
    let label = "";
    let any = false;
    if (kind === "home") {
      const k = hList.findIndex((hm) => hm.id === key);
      if (k < 0) return null;
      label = homeName(k);
      for (const i of hMembers[k]) { src[i] = 1; any = true; }
    } else {
      const gi = groups.findIndex((g) => g.key === key);
      if (gi < 0) return null;
      label = groups[gi].label;
      for (const i of members[gi]) { src[i] = 1; any = true; }
    }
    if (!any) return null;
    const edges = [];
    const other = new Map(); // far end -> links
    for (let e = 0; e < m; e++) {
      const a = G.src[e], b = G.dst[e];
      if (src[a] === src[b] || !vis[a] || !vis[b]) continue;
      if (kind === "group" && !(isNoteArr[a] && isNoteArr[b])) continue;
      edges.push(e);
      const far = src[a] ? b : a;
      other.set(far, (other.get(far) || 0) + 1);
    }
    return { kind, key, label, src, edges, other };
  }

  function showBridges(kind, key) {
    const b = makeBridgeSel(kind, key);
    if (!b) return app.toast("Nothing to show here");
    bridgeSel = b;
    path = null;
    if (query) setQuery("");
    updateEmphasis();
    paintChrome();
    renderBridges();
    const list = [];
    for (let i = 0; i < n; i++) if (b.src[i]) list.push(i);
    for (const i of b.other.keys()) list.push(i);
    fit(list);
    if (!b.edges.length) app.toast(`No links leave ‘${b.label}’`);
  }

  function clearBridges() {
    bridgeSel = null;
    renderBridges();
    updateEmphasis();
    kick();
  }

  // the other side, grouped by where it lives
  function renderBridges() {
    bridgeEl.hidden = !bridgeSel || !!path;
    if (bridgeEl.hidden) return;
    const b = bridgeSel;
    const sides = new Map();
    for (const [i, c] of b.other) {
      const k = b.kind === "home" || S.crossBy === "homes" ? homeIdx[i] : -2;
      const key = k >= 0 ? "h" + k : k === -1 ? "pool" : "g" + groupOf[i];
      let s = sides.get(key);
      if (!s) {
        s = {
          label: k >= 0 ? homeName(k) : k === -1 ? "Main pool" : groups[groupOf[i]].label,
          color: k >= 0 ? homeColor(k) : k === -1 ? colors.node : gColor[groupOf[i]],
          list: [],
        };
        sides.set(key, s);
      }
      s.list.push([i, c]);
    }
    const list = h("div", { class: "gx-steps" });
    const order = [...sides.values()].sort((x, y) => y.list.length - x.list.length);
    for (const s of order) {
      s.list.sort((x, y) => y[1] - x[1] || G.nodes[y[0]].deg - G.nodes[x[0]].deg);
      const col = h("div", { class: "gx-layer" });
      col.append(h("div", { class: "gx-bside" }, h("span", { class: "gx-fdot", style: { "--c": s.color } }), h("span", { class: "gx-bside-t", text: s.label }), h("span", { class: "gx-leg-n", text: s.list.length.toLocaleString() })));
      for (const [i, c] of s.list.slice(0, 12)) {
        col.append(h("button", {
          class: "gx-step is-bridge",
          title: G.nodes[i].id + "\nClick to go there, Ctrl+click to open",
          onclick: (e) => (e.ctrlKey || e.metaKey ? openNode(i, true) : chooseResult(i)),
          onmouseenter: () => setHover(i),
          onmouseleave: () => setHover(-1),
        }, h("span", { class: "gx-step-t", text: G.nodes[i].label }), c > 1 ? h("span", { class: "gx-leg-n", text: "×" + c }) : null));
      }
      if (s.list.length > 12) col.append(h("div", { class: "gx-more", text: `+${s.list.length - 12} more` }));
      list.append(col);
    }
    if (!order.length) list.append(h("div", { class: "gx-hint", text: "No links leave here." }));
    bridgeEl.replaceChildren(
      h("div", { class: "gx-pathhead" },
        icon("link"),
        h("span", { class: "gx-pathtitle", text: `Bridges from ${b.label}` }),
        h("span", { class: "gx-leg-n", text: plural(b.edges.length, "link") }),
        h("button", { class: "gx-icon-btn", title: "Close (Esc)", onclick: clearBridges }, icon("x"))),
      list,
      h("div", { class: "gx-pathfoot" },
        h("button", { class: "gx-chip", onclick: () => {
          selected.clear();
          for (const i of b.other.keys()) selected.add(G.nodes[i].id);
          syncSelection();
          kick();
        } }, icon("check"), "Select the other side"))
    );
  }


  function paintGroupColors() {
    gColor = groups.map((g) => g.color || (g.kind === "file" ? colors.file : g.kind === "tag" ? colors.tag : g.kind === "ghost" ? colors.ghost : colors.node));
  }

  function applyHiddenGroups() {
    const off = new Set(S.hiddenGroups);
    for (let gi = 0; gi < groups.length; gi++) {
      const v = off.has(groups[gi].key) ? 0 : 1;
      for (const i of members[gi]) vis[i] = v;
    }
    // only bridges: a note stays if a visible bridge touches it
    if (S.bridgesOnly && G && eCls.length >= m) {
      if (onB.length < n) onB = new Uint8Array(Math.max(n, rad.length));
      onB.fill(0, 0, n);
      const mask = crossMask(S.crossBy);
      for (let e = 0; e < m; e++) {
        const a = G.src[e], b = G.dst[e];
        if (eCls[e] & mask && vis[a] && vis[b]) { onB[a] = 1; onB[b] = 1; }
      }
      for (let i = 0; i < n; i++) if (!onB[i] && i !== G.focus) vis[i] = 0;
    }
    gridStale = true;
  }

  function syncSelection() {
    selMask.fill(0);
    selIdx = [];
    for (const id of selected) {
      const i = G ? G.index.get(id) : undefined;
      if (i !== undefined) { selMask[i] = 1; selIdx.push(i); }
    }
    paintSelbar();
  }

  function syncPins() {
    pinIdx = [];
    for (const id of pins) {
      const i = G ? G.index.get(id) : undefined;
      if (i !== undefined) pinIdx.push(i);
    }
  }

  function syncForces() {
    const radial = S.scope === "around" && S.radial && G && G.focus >= 0;
    forces.repel = S.repel;
    forces.linkDistance = S.linkDistance;
    forces.gravity = S.gravity * (radial ? 0.15 : 1);
    forces.radial = radial ? 0.55 : 0;
    forces.theta = n > 2000 ? 1 : 0.9;
    forces.homePull = S.homePull;
    forces.homeRange = Math.max(420, S.linkDistance * 7);
  }

  // fade: false after a rebuild, when indices changed and nothing can fade
  function updateEmphasis(fade = true) {
    if (!G) return;
    const running = dimT !== dimGoal || swapT < 1;
    if (fade && dimT > 0) {
      emphPrev.set(emph.subarray(0, n));
      eEmphPrev.set(eEmph.subarray(0, m));
      swapT = 0;
    } else swapT = 1;
    emph.fill(0, 0, n);
    eEmph.fill(0, 0, m);
    let base = false;
    const bs = path ? null : bridgeSel;
    if (bs) {
      base = true;
      for (let i = 0; i < n; i++) emph[i] = bs.src[i];
      for (const i of bs.other.keys()) emph[i] = 1;
      for (const e of bs.edges) eEmph[e] = 1;
    } else if (path) {
      base = true;
      if (path.all) {
        for (let i = 0; i < n; i++) emph[i] = path.res.nodes[i];
        for (let e = 0; e < m; e++) eEmph[e] = path.res.edges[e];
      } else {
        for (const i of path.one) emph[i] = 1;
        for (let t = 1; t < path.one.length; t++) {
          const a = path.one[t - 1];
          const b = path.one[t];
          for (let k = G.start[a]; k < G.start[a + 1]; k++) if (G.adj[k] === b) eEmph[G.adjEdge[k]] = 1;
        }
      }
    } else if (query) {
      base = true;
      for (const i of matches) emph[i] = 1;
      for (let e = 0; e < m; e++) if (emph[G.src[e]] && emph[G.dst[e]]) eEmph[e] = 1;
    }
    const hv = emphHover < n ? emphHover : -1;
    if (hv >= 0) {
      emph[hv] = 1;
      for (let k = G.start[hv]; k < G.start[hv + 1]; k++) {
        if (!base) emph[G.adj[k]] = 1;
        eEmph[G.adjEdge[k]] = 1;
      }
    }
    dimGoal = base || hv >= 0 ? 1 : 0;
    if (!fade) dimT = dimGoal;
    if (!running) fadeAt = performance.now();
    if (dimT !== dimGoal || swapT < 1) kick();
  }

  function stepFade(now) {
    const dt = Math.min(64, Math.max(0, now - fadeAt));
    fadeAt = now;
    if (dimT < dimGoal) dimT = Math.min(dimGoal, dimT + dt / DIM_IN);
    else if (dimT > dimGoal) dimT = Math.max(dimGoal, dimT - dt / DIM_OUT);
    if (swapT < 1) swapT = Math.min(1, swapT + dt / DIM_IN);
    return dimT !== dimGoal || swapT < 1;
  }

  /* ── camera ──────────────────────────────────────────────────────────── */
  function computeFit(list, out) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const count = list ? list.length : n;
    for (let t = 0; t < count; t++) {
      const i = list ? list[t] : t;
      if (!list && !vis[i]) continue;
      const r = rad[i];
      if (L.x[i] - r < x0) x0 = L.x[i] - r;
      if (L.x[i] + r > x1) x1 = L.x[i] + r;
      if (L.y[i] - r < y0) y0 = L.y[i] - r;
      if (L.y[i] + r > y1) y1 = L.y[i] + r;
    }
    if (x0 === Infinity || !W) return false;
    // big graphs: frame the mass, not the odd straggler far outside it
    // (homes are placed on purpose: they always count)
    if (!list && n > 40) {
      const homed = hList.length > 0;
      let c = 0, mx = 0, my = 0, vx = 0, vy = 0;
      for (let i = 0; i < n; i++) {
        if (!vis[i] || (homed && homeIdx[i] >= 0)) continue;
        c++;
        mx += L.x[i];
        my += L.y[i];
      }
      if (c > 40) {
        mx /= c;
        my /= c;
        for (let i = 0; i < n; i++) {
          if (!vis[i] || (homed && homeIdx[i] >= 0)) continue;
          vx += (L.x[i] - mx) ** 2;
          vy += (L.y[i] - my) ** 2;
        }
        const sx = 2.6 * Math.sqrt(vx / c) + maxR;
        const sy = 2.6 * Math.sqrt(vy / c) + maxR;
        x0 = Math.max(x0, mx - sx);
        x1 = Math.min(x1, mx + sx);
        y0 = Math.max(y0, my - sy);
        y1 = Math.min(y1, my + sy);
        if (homed) {
          for (let i = 0; i < n; i++) {
            if (!vis[i] || homeIdx[i] < 0) continue;
            const r = rad[i];
            if (L.x[i] - r < x0) x0 = L.x[i] - r;
            if (L.x[i] + r > x1) x1 = L.x[i] + r;
            if (L.y[i] - r - 30 < y0) y0 = L.y[i] - r - 30; // room for the name
            if (L.y[i] + r > y1) y1 = L.y[i] + r;
          }
        }
      }
    }
    return fitBox(x0, y0, x1, y1, count === 1 ? 2 : 1.7, out);
  }

  function fitBox(x0, y0, x1, y1, maxK, out) {
    if (!W) return false;
    const bottom = selbar.hidden ? 0 : 60;
    // keep clear of the floating panels on either side
    const side = !pathEl.hidden ? pathEl : !bridgeEl.hidden ? bridgeEl : null;
    const insetR = !side || W - insetL - side.offsetWidth < 440 ? 0 : side.offsetWidth + 12;
    const aw = Math.max(80, W - insetL - insetR - 90);
    const ah = Math.max(80, H - bottom - 90);
    const k = clampNum(Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0)), K_MIN, maxK);
    out.k = k;
    out.x = insetL + (W - insetL - insetR) / 2 - W / 2 - ((x0 + x1) / 2) * k;
    out.y = (H - bottom) / 2 - H / 2 - ((y0 + y1) / 2) * k;
    return true;
  }

  function animateTo(t, dur = 420) {
    autoFit = false;
    tween = { t0: performance.now(), dur, x0: cam.x, y0: cam.y, k0: cam.k, x1: t.x, y1: t.y, k1: t.k };
    kick();
  }

  function stepTween(now) {
    const tw = tween;
    const p = Math.min(1, (now - tw.t0) / tw.dur);
    const e = 1 - Math.pow(1 - p, 3);
    const k = Math.exp(Math.log(tw.k0) + (Math.log(tw.k1) - Math.log(tw.k0)) * e);
    // the world point under the view centre travels in a straight line
    const cx = -tw.x0 / tw.k0 + (-tw.x1 / tw.k1 + tw.x0 / tw.k0) * e;
    const cy = -tw.y0 / tw.k0 + (-tw.y1 / tw.k1 + tw.y0 / tw.k0) * e;
    cam.k = k;
    cam.x = -cx * k;
    cam.y = -cy * k;
    if (p >= 1) { tween = null; return false; }
    return true;
  }

  function fit(list) {
    const t = {};
    if (computeFit(list && list.length ? list : null, t)) animateTo(t);
  }

  function centreOn(i, minK = 1.25) {
    const k = Math.max(cam.k, minK);
    animateTo({ k, x: insetL / 2 - L.x[i] * k, y: -L.y[i] * k }, 380);
  }

  function zoomAt(f, mx, my, out) {
    const k = clampNum(cam.k * f, K_MIN, K_MAX);
    out.x = mx - ((mx - cam.x) * k) / cam.k;
    out.y = my - ((my - cam.y) * k) / cam.k;
    out.k = k;
    return out;
  }

  function zoomButton(f) {
    const base = tween ? { x: tween.x1, y: tween.y1, k: tween.k1 } : cam;
    const k = clampNum(base.k * f, K_MIN, K_MAX);
    animateTo({ k, x: (base.x * k) / base.k, y: (base.y * k) / base.k }, 220);
  }

  function pan(dx, dy) {
    autoFit = false;
    tween = null;
    cam.x += dx;
    cam.y += dy;
    saveDirty = true;
    kick();
  }

  /* ── loop ────────────────────────────────────────────────────────────── */
  function kick() {
    if (S.look !== "plain") sailUntil = performance.now() + SAIL_MS;
    if (!raf && !off()) raf = requestAnimationFrame(frame);
  }
  function heat(a) {
    alpha = Math.max(alpha, a);
    kick();
  }

  function frame() {
    raf = 0;
    if (off()) return;
    let more = false;
    if (tl || orb) alpha = 0; // the timeline and the orbit place every dot themselves: nothing to simulate
    // the orbit turns a little each frame, about thirty a second (it is a slow turn), unless held or animations are off
    let spin = false;
    // not while Leonote is minimized or hidden: it goes on when it is back (visibilitychange below)
    if (orb && !orbHold && !document.hidden && motionFull()) { orb.a += 0.012; projectOrbit(); spin = true; }
    if (alpha > 0 || alphaTarget > 0) {
      alpha += (alphaTarget - alpha) * ALPHA_DECAY;
      if (alpha < ALPHA_MIN && alphaTarget === 0) {
        alpha = 0;
        saveMemo();
        touch();
      } else if (n) {
        const t = performance.now();
        L.step(alpha, forces);
        perf.stepMs += performance.now() - t;
        perf.steps++;
        gridStale = true;
        more = true;
      }
    }
    if (dimT !== dimGoal || swapT < 1) more = stepFade(performance.now()) || more;
    if (tween) more = stepTween(performance.now()) || more;
    else if (autoFit && n && computeFit(null, fitT)) {
      // follow the layout as it unfolds, then settle on the exact frame
      const t = more ? 0.18 : 1;
      cam.k = Math.exp(Math.log(cam.k) + (Math.log(fitT.k) - Math.log(cam.k)) * t);
      cam.x += (fitT.x - cam.x) * t;
      cam.y += (fitT.y - cam.y) * t;
      if (!more) autoFit = false;
    }
    if (lens.on) lens.follow(); // cards keep up with their nodes and the camera
    const sail = sailing();
    const t = performance.now();
    draw();
    const d = performance.now() - t;
    perf.drawMs += d;
    if (d > perf.maxDraw) perf.maxDraw = d;
    perf.frames++;
    if (more && !tip.hidden) placeTip();
    if (more) raf = requestAnimationFrame(frame);
    else if (spin) raf = setTimeout(() => { raf = requestAnimationFrame(frame); }, 33);
    // only the ships move: a frame now and then is enough for them
    else if (sail) raf = setTimeout(() => { raf = requestAnimationFrame(frame); }, 45);
  }

  /* ── Pirates: homes are islands in a sea, ships sail between them ──────
     Drawn on the same canvas, no images. Ships move for a while after the
     graph last changed or was touched, then lie at anchor: the look costs
     nothing while the graph sits still. A ship that makes port lights its
     island up for a moment. */
  /* Fog of war: a note neither opened nor changed for a while (Fog after, in days) lies under a
     cloud; opening it clears it. Worked out when the graph is shown, not every frame. */
  let fogged = new Uint8Array(0), fogAt = 0, fogN = 0;
  function fogNow() {
    if (fogAt && fogged.length >= n) return;
    fogAt = Date.now();
    fogged = new Uint8Array(Math.max(n, 1));
    fogN = 0;
    const since = fogAt - S.fogDays * 864e5, pos = app.positions || {};
    for (let i = 0; i < n; i++) {
      const nd = G.nodes[i];
      if (nd.kind !== "note") continue;
      const v = vault.notes.get(nd.id);
      const seen = Math.max(v ? v.mtime || 0 : 0, pos[nd.id] ? pos[nd.id].at || 0 : 0);
      if (seen && seen < since) { fogged[i] = 1; fogN++; }
    }
  }
  // a glow in any colour: the colour, cut to a soft round fade; one per colour, kept
  const glowSprites = new Map();
  function glowSprite(color) {
    let c = glowSprites.get(color);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = color;
    g.fillRect(0, 0, 64, 64);
    const fade = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    fade.addColorStop(0, "rgba(0,0,0,0.55)");
    fade.addColorStop(0.5, "rgba(0,0,0,0.2)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = fade;
    g.fillRect(0, 0, 64, 64);
    if (glowSprites.size > 64) glowSprites.clear();
    glowSprites.set(color, c);
    return c;
  }
  // the fog's sphere: a soft glow, lighter at the heart, made once per look and theme
  let fogImg = null, fogKey = "";
  function fogSprite() {
    const key = S.look + theme;
    if (fogImg && fogKey === key) return fogImg;
    const c = document.createElement("canvas");
    c.width = c.height = 96;
    const g = c.getContext("2d");
    const light = theme === "light";
    const tint = light ? "255,255,255" : S.look === "space" ? "170,180,230" : S.look === "pirates" ? "190,215,230" : "205,210,220";
    const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    grad.addColorStop(0, `rgba(${tint},${light ? 0.9 : 0.42})`);
    grad.addColorStop(0.45, `rgba(${tint},${light ? 0.55 : 0.2})`);
    grad.addColorStop(1, `rgba(${tint},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 96, 96);
    fogImg = c; fogKey = key;
    return c;
  }
  function drawFog(k, ox, oy) {
    if (!S.fog || !G) return;
    fogNow();
    if (!fogN) return;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    const { x, y } = L;
    const vx0 = -ox / k - 40, vx1 = (W - ox) / k + 40, vy0 = -oy / k - 40, vy1 = (H - oy) / k + 40;
    const sprite = fogSprite();
    ctx.globalAlpha = 1;
    for (let i = 0; i < n; i++) {
      if (!fogged[i] || !vis[i] || x[i] < vx0 || x[i] > vx1 || y[i] < vy0 || y[i] > vy1) continue;
      const r = rad[i] * 2.6 + 6;
      ctx.drawImage(sprite, x[i] - r, y[i] - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Trade routes: the links between two homes, drawn as one road between them - thicker the more
     there are, with their count - instead of one by one. Counted when the homes change. */
  let routes = []; // [ka, kb, count]
  function countRoutes() {
    const by = new Map();
    for (let e = 0; e < m; e++) {
      const a = homeIdx[G.src[e]], b = homeIdx[G.dst[e]];
      if (a < 0 || b < 0 || a === b) continue;
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      by.set(key, (by.get(key) || 0) + 1);
    }
    routes = [...by].map(([key, c]) => [Math.floor(key / 65536), key % 65536, c]);
  }
  const routed = (a, b) => S.routes && homeIdx[a] >= 0 && homeIdx[b] >= 0 && homeIdx[a] !== homeIdx[b];
  function drawRoutes(k, ox, oy) {
    if (!S.routes || !routes.length) return;
    const light = theme === "light";
    const look = S.look;
    ctx.lineCap = "round";
    for (const [a, b, c] of routes) {
      if (a >= hList.length || b >= hList.length || hr[a] <= 0 || hr[b] <= 0) continue;
      const dx = hcx[b] - hcx[a], dy = hcy[b] - hcy[a], d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const x0 = hcx[a] + ux * hr[a], y0 = hcy[a] + uy * hr[a], x1 = hcx[b] - ux * hr[b], y1 = hcy[b] - uy * hr[b];
      if (d <= hr[a] + hr[b]) continue;
      ctx.lineWidth = (2 + Math.log2(c + 1) * 2.2) / k;
      ctx.strokeStyle = look === "pirates" ? (light ? "#8a6a3f" : "#d9c38f") : look === "space" ? (light ? "#5b62a0" : "#b9c1ff") : colors.accent;
      ctx.globalAlpha = light ? 0.5 : 0.4;
      // a sea lane is dashed, a space lane dotted, a road solid
      if (look !== "plain") { dash[0] = (look === "space" ? 1 : 10) / k; dash[1] = (look === "space" ? 9 : 8) / k; ctx.setLineDash(dash); }
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.setLineDash(noDash);
      // the count, in the middle
      const mx = ((x0 + x1) / 2) * k + ox, my = ((y0 + y1) / 2) * k + oy;
      if (mx < 0 || mx > W || my < 0 || my > H) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 0.92;
      ctx.font = `600 11px ${FONT}`;
      const t = String(c), tw = ctx.measureText(t).width + 10;
      ctx.fillStyle = colors.bg;
      ctx.beginPath(); ctx.roundRect(mx - tw / 2, my - 9, tw, 18, 9); ctx.fill();
      ctx.fillStyle = colors.strong;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(t, mx, my + 0.5);
      ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    }
    ctx.globalAlpha = 1;
  }

  const SAIL_MS = 25000;
  let sailUntil = 0, sailLast = 0;
  /* A ship: from one port to another (a home "h:id", or a note "n:id"), then it docks a few seconds
     - at a note it now and then shows the note's name over it - and sets off again. */
  const ships = []; // { from, to, t (0..1), wait (docked until), bubble }
  const glow = new Map(); // port -> when a ship made port there
  const hidHash = (id) => { let x = 0; for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) | 0; return x; };
  let homeK = new Map();
  const portAt = (p) => {
    if (p[0] === "p") { const c = p.slice(2).split(","); return { x: +c[0], y: +c[1], r: 0 }; }
    if (p[0] === "h") { const k = homeK.get(p.slice(2)); return k === undefined || hr[k] <= 0 ? null : { x: hcx[k], y: hcy[k], r: hr[k] * 1.15 }; }
    const i = G.index.get(p.slice(2));
    return i === undefined || !vis[i] ? null : { x: L.x[i], y: L.y[i], r: rad[i] + 10, i };
  };
  const byHomes = () => hList.length >= 2;
  function pickPort(not) {
    if (byHomes()) { let k; for (let t = 0; t < 8; t++) { k = (Math.random() * hList.length) | 0; if ("h:" + hList[k].id !== not) break; } return "h:" + hList[k].id; }
    for (let t = 0; t < 24; t++) {
      const i = (Math.random() * n) | 0;
      if (vis[i] && G.nodes[i].kind === "note" && homeIdx[i] < 0 && "n:" + G.nodes[i].id !== not) return "n:" + G.nodes[i].id;
    }
    return null;
  }
  let wash = new Float32Array(0); // per note, how far a ship's wash has moved it (x, y)
  let washed = false;
  function unwash() {
    if (!washed) return;
    for (let i = 0; i < n && 2 * i + 1 < wash.length; i++) { L.x[i] -= wash[2 * i]; L.y[i] -= wash[2 * i + 1]; }
    wash.fill(0);
    washed = false;
    gridStale = true;
  }
  function washAround() {
    // while the layout itself moves, the wash would fight it (notes shiver): it waits
    if (alpha > 0) { unwash(); return; }
    if (wash.length < 2 * n) { unwash(); wash = new Float32Array(2 * Math.max(n, rad.length)); }
    const R = 34, R2 = R * R;
    const near = [];
    for (const sh of ships) { if (near.length >= 24) break; if (!sh.wait) { const p = shipAt(sh); if (p) near.push(p); } }
    let any = false;
    for (let i = 0; i < n; i++) {
      let wx = wash[2 * i] * 0.9, wy = wash[2 * i + 1] * 0.9; // drifting back
      if (!L.fixed[i] && homeIdx[i] < 0) { // notes on an island are ashore: the wash does not reach them
        for (const p of near) {
          const ddx = L.x[i] - wash[2 * i] - p.x, ddy = L.y[i] - wash[2 * i + 1] - p.y, d2 = ddx * ddx + ddy * ddy;
          if (d2 > R2 || d2 < 1e-6) continue;
          const f = (1 - Math.sqrt(d2) / R) * 9 / Math.sqrt(d2);
          wx += (ddx * f - wx) * 0.12; wy += (ddy * f - wy) * 0.12;
        }
      }
      if (Math.abs(wx) < 0.01 && Math.abs(wy) < 0.01) { wx = 0; wy = 0; }
      L.x[i] += wx - wash[2 * i]; L.y[i] += wy - wash[2 * i + 1];
      wash[2 * i] = wx; wash[2 * i + 1] = wy;
      if (wx || wy) any = true;
    }
    washed = any;
    if (any) gridStale = true;
  }
  // where the ships lay when they last stopped: the next ones set off from there (kept per computer)
  const REST_KEY = "leonote.graph.ships";
  let rest = null;
  const restSpots = () => { if (!rest) { try { rest = JSON.parse(localStorage.getItem(REST_KEY) || "[]").filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])); } catch { rest = []; } } return rest; };
  function keepRest() {
    const spots = ships.map((sh) => { const p = shipAt(sh); return p ? [Math.round(p.x), Math.round(p.y)] : null; }).filter(Boolean);
    rest = spots.slice();
    try { localStorage.setItem(REST_KEY, JSON.stringify(spots)); } catch {}
  }
  function sailing() {
    if (S.look === "plain" || S.ships === false || !G || n < 2 || off()) { ships.length = 0; unwash(); return false; }
    const now = performance.now();
    if (now > sailUntil) { if (sailLast) keepRest(); sailLast = 0; unwash(); return false; }
    const dt = sailLast ? Math.min(100, now - sailLast) : 0;
    sailLast = now;
    homeK = new Map(hList.map((hm, k) => [hm.id, k]));
    const homesNow = byHomes();
    // a home made or gone changes the kind of port: those ships sail on to the new kind
    // a ship whose port went sets off again from where it was
    for (let i = ships.length - 1; i >= 0; i--) {
      const sh = ships[i];
      if (sh.held || ((sh.to[0] === "p" || (sh.to[0] === "h") === homesNow) && portAt(sh.from) && portAt(sh.to))) continue;
      if (Number.isFinite(sh.lx)) restSpots().push([sh.lx, sh.ly]);
      ships.splice(i, 1);
    }
    const want = S.shipCount;
    while (ships.length < want) {
      const spot = restSpots().shift();
      const from = spot ? `p:${spot[0]},${spot[1]}` : pickPort(""), to = from && pickPort(from);
      if (!to) break;
      ships.push({ from, to, t: spot ? 0 : Math.random(), wait: 0, bubble: false, ox: 0, oy: 0 });
    }
    if (ships.length > want) ships.length = want;
    for (const sh of ships) {
      // a bump from the pointer wears off
      if (sh.ox || sh.oy) { sh.ox *= 0.9; sh.oy *= 0.9; if (Math.abs(sh.ox) + Math.abs(sh.oy) < 0.05) sh.ox = sh.oy = 0; }
      const here = shipAt(sh);
      if (here) { sh.lx = Math.round(here.x); sh.ly = Math.round(here.y); }
      if (sh.held) continue;
      if (sh.wait) {
        if (now < sh.wait) continue;
        const to = pickPort(sh.to);
        if (!to) continue;
        sh.from = sh.to; sh.to = to; sh.t = 0; sh.wait = 0; sh.bubble = false;
        continue;
      }
      const a = portAt(sh.from), b = portAt(sh.to);
      if (!a || !b) continue; // a home not measured yet
      const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r);
      sh.t += (dt * 0.06) / d; // world units a millisecond, whatever the distance
      if (sh.t >= 1) {
        sh.t = 1;
        sh.wait = now + 2500 + Math.random() * 6000;
        sh.bubble = sh.to[0] === "n" && Math.random() < 0.5;
        glow.set(sh.to, now);
      }
    }
    washAround();
    return true;
  }
  const SEA = { dark: "#0c2b42", light: "#c6e3f0" };
  // the sea follows the hour: night, dawn, day, dusk (looked up once an hour)
  const SEA_HOURS = { dark: { night: "#061522", dawn: "#1a2a44", day: "#0c2b42", dusk: "#22223e" }, light: { night: "#a7bbd0", dawn: "#e4d3cc", day: "#c6e3f0", dusk: "#e8cfc0" } };
  let seaAt = -1, seaC = null;
  function seaColor() {
    const hr2 = new Date().getHours();
    if (hr2 !== seaAt || !seaC || seaC.theme !== theme) {
      const part = hr2 < 5 || hr2 >= 21 ? "night" : hr2 < 8 ? "dawn" : hr2 < 18 ? "day" : "dusk";
      seaAt = hr2; seaC = { theme, c: SEA_HOURS[theme][part] };
    }
    return seaC.c;
  }
  const SKY = { dark: "#070a18", light: "#e4e6f3" };
  let stars = null; // [x 0..1, y 0..1, size] - made once
  let vignette = null, vigKey = "";
  function drawVignette() {
    const key = W + "x" + H + theme;
    if (vigKey !== key) {
      vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, theme === "light" ? "rgba(40,60,90,0.12)" : "rgba(0,0,0,0.38)");
      vigKey = key;
    }
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
  }
  function drawBackdrop() {
    ctx.fillStyle = S.look === "space" ? SKY[theme] : seaColor();
    ctx.fillRect(0, 0, W, H);
    drawVignette();
    if (!stars) { let q = 7; const rnd = () => ((q = (q * 16807) % 2147483647) / 2147483647); stars = Array.from({ length: 160 }, () => [rnd(), rnd(), rnd() < 0.1 ? 1.6 : rnd() < 0.4 ? 1.1 : 0.7]); }
    const px = cam.x * 0.04, py = cam.y * 0.04;
    if (S.look === "pirates") {
      // waves: little crests, one stroke for them all, drifting with the camera like the stars
      ctx.strokeStyle = theme === "light" ? "#ffffff" : "#5d93b5";
      ctx.globalAlpha = theme === "light" ? 0.7 : 0.28;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let w = 0; w < 70; w++) {
        const [x, y, z] = stars[w];
        const wx = ((x * W + px * z) % W + W) % W, wy = ((y * H + py * z) % H + H) % H, r = 3 + z * 3;
        ctx.moveTo(wx - r, wy); ctx.quadraticCurveTo(wx - r / 2, wy - r * 0.6, wx, wy); ctx.quadraticCurveTo(wx + r / 2, wy - r * 0.6, wx + r, wy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = theme === "light" ? "#7d83ad" : "#dfe4ff";
    for (const [x, y, z] of stars) {
      ctx.globalAlpha = 0.25 + z * 0.35;
      ctx.fillRect(((x * W + px * z) % W + W) % W, ((y * H + py * z) % H + H) % H, z, z);
    }
    ctx.globalAlpha = 1;
  }
  // a planet: its own colour from the home's id, the night side, now and then a ring
  const PLANETS = [["#c9785a", "#e2a37f"], ["#5a8fc9", "#8fb9e8"], ["#9a7bc9", "#c0a6ea"], ["#5fae8f", "#93d1b5"], ["#c9a85a", "#e6cd8a"], ["#c95a7b", "#e88fa7"]];
  function drawPlanet(h2, k) {
    const r = hr[h2] * 0.95, cx = hcx[h2], cy = hcy[h2];
    const seed = Math.abs(hidHash(hList[h2].id));
    const light = theme === "light";
    const [base, lit2] = PLANETS[seed % PLANETS.length];
    const lit = glow.has("h:" + hList[h2].id) ? Math.max(0, 1 - (performance.now() - glow.get("h:" + hList[h2].id)) / 1800) : 0;
    // its shadow, cast down and to the right
    ctx.globalAlpha = light ? 0.12 : 0.35;
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.arc(cx + r * 0.08, cy + r * 0.11, r * 1.02, 0, TAU); ctx.fill();
    const ringed = seed % 3 === 0;
    const ring = (from, to, a) => {
      ctx.globalAlpha = a;
      ctx.strokeStyle = lit2;
      ctx.lineWidth = Math.max(1 / k, r * 0.05);
      ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.45, r * 0.32, -0.35, from, to); ctx.stroke();
    };
    if (ringed) ring(Math.PI, TAU, light ? 0.22 : 0.14);
    // the air round it
    ctx.globalAlpha = (light ? 0.3 : 0.16) + 0.25 * lit;
    ctx.fillStyle = lit2;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.08, 0, TAU); ctx.fill();
    ctx.globalAlpha = light ? 0.5 : 0.3;
    ctx.fillStyle = base;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    // the night side
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = light ? 0.18 : 0.35;
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.arc(cx + r * 0.45, cy + r * 0.3, r * 1.05, 0, TAU); ctx.fill();
    ctx.restore();
    if (ringed) ring(0, Math.PI, light ? 0.55 : 0.4);
    if (lit > 0) {
      ctx.globalAlpha = lit * 0.8;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2 / k;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.12, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // an island: a wobbly shore (the same each time for the same home), shallows, sand, green
  function drawIsland(h2, k) {
    const r = hr[h2], cx = hcx[h2], cy = hcy[h2];
    const seed = hidHash(hList[h2].id);
    const light = theme === "light";
    const shore = (f, sx = 0, sy = 0) => {
      ctx.beginPath();
      for (let p = 0; p <= 14; p++) {
        const a = (p % 14) / 14 * TAU;
        const w = 1 + 0.09 * Math.sin(a * 3 + seed) + 0.05 * Math.sin(a * 5 + seed * 0.7);
        const px = cx + sx + Math.cos(a) * r * f * w, py = cy + sy + Math.sin(a) * r * f * w;
        if (p) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
    };
    const lit = glow.has("h:" + hList[h2].id) ? Math.max(0, 1 - (performance.now() - glow.get("h:" + hList[h2].id)) / 1800) : 0;
    // its shadow on the water, down and to the right
    ctx.globalAlpha = light ? 0.14 : 0.3;
    ctx.fillStyle = light ? "#2b4a5c" : "#03111c";
    shore(1.02, r * 0.07, r * 0.1); ctx.fill();
    ctx.globalAlpha = (light ? 0.5 : 0.22) + 0.25 * lit;
    ctx.fillStyle = light ? "#a9d6e5" : "#2c5d73";
    shore(1.12); ctx.fill();
    ctx.globalAlpha = light ? 0.75 : 0.3;
    ctx.fillStyle = light ? "#ecdcae" : "#c9b27a";
    shore(0.98); ctx.fill();
    ctx.globalAlpha = light ? 0.45 : 0.2;
    ctx.fillStyle = light ? "#8fbf7a" : "#5f8f4e";
    shore(0.78); ctx.fill();
    if (lit > 0) {
      ctx.globalAlpha = lit * 0.8;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2 / k;
      shore(1.14); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // the ships, in screen pixels so they stay ship-sized at any zoom
  /* How far the course bows out: a gentle curve, or wide enough to pass round any island in the way
     (on the side away from its middle). */
  function bowAround(A, B, ux, uy, run, d) {
    let amp = Math.min(120, run * 0.18);
    for (let k2 = 0; k2 < hList.length; k2++) {
      const R = hr[k2] * 1.2;
      if (R <= 0) continue;
      const cx = hcx[k2] - A.x, cy = hcy[k2] - A.y;
      if (Math.hypot(cx, cy) < R || Math.hypot(hcx[k2] - B.x, hcy[k2] - B.y) < R) continue; // its own port's island
      const along = cx * ux + cy * uy, side = -cx * uy + cy * ux;
      if (along <= 0 || along >= d || Math.abs(side) >= R) continue;
      const tc = Math.max(0.15, Math.min(0.85, along / d));
      const need = (side > 0 ? side - R : side + R) / Math.sin(Math.PI * tc);
      if (Math.abs(need) > Math.abs(amp) || Math.sign(need) !== Math.sign(amp)) amp = Math.max(-d, Math.min(d, need));
    }
    return amp;
  }
  // from shore to shore, on a gentle curve
  function shipAt(sh) {
    if (sh.held) { const P = { x: sh.held.x, y: sh.held.y, r: 0 }; return { A: P, B: P, dx: 1, ux: 1, uy: 0, t: 0, run: 0, amp: 0, x: P.x, y: P.y }; }
    const A = portAt(sh.from), B = portAt(sh.to);
    if (!A || !B) return null;
    const dx = B.x - A.x, dy = B.y - A.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const t = sh.t, run = Math.max(0, d - A.r - B.r);
    const amp = bowAround(A, B, ux, uy, run, d);
    const bow = Math.sin(Math.PI * t) * amp;
    return { A, B, dx, ux, uy, t, run, amp, x: A.x + ux * (A.r + run * t) - uy * bow + (sh.ox || 0), y: A.y + uy * (A.r + run * t) + ux * bow + (sh.oy || 0) };
  }
  function shipUnder(w) {
    if (S.look === "plain" || !ships.length || !G) return null;
    const R = 16 / cam.k;
    let best = null, bd = R * R;
    for (const sh of ships) { const p = shipAt(sh); if (!p) continue; const d2 = (p.x - w.x) ** 2 + (p.y - w.y) ** 2; if (d2 < bd) { bd = d2; best = sh; } }
    return best;
  }
  // the pointer brushing past a ship pushes it aside
  function bumpShips(w) {
    if (S.look === "plain" || !ships.length || !G) return;
    const R = 22 / cam.k;
    let any = false;
    for (const sh of ships) {
      if (sh.held) continue;
      const p = shipAt(sh);
      if (!p) continue;
      const ddx = p.x - w.x, ddy = p.y - w.y, d = Math.hypot(ddx, ddy);
      if (d > R || d < 1e-6) continue;
      const f = ((R - d) / d) * 0.8;
      sh.ox = (sh.ox || 0) + ddx * f; sh.oy = (sh.oy || 0) + ddy * f;
      any = true;
    }
    if (any) kick();
  }
  function drawShips(k, ox, oy) {
    if (S.look === "plain" || !ships.length || !G) return;
    homeK = new Map(hList.map((hm, kk) => [hm.id, kk]));
    const space = S.look === "space";
    const light = theme === "light";
    const s = S.shipZoom ? clampNum(3 + k * 8, 4, 22) : 15; // with the zoom: small far out, bigger up close
    const now = performance.now();
    for (const sh of ships) {
      const at = shipAt(sh);
      if (!at) continue;
      const { A, B, dx, ux, uy, t, run } = at;
      const px = at.x * k + ox, py = at.y * k + oy;
      // docked at a note: it glows, and now and then its name shows over it
      if (sh.wait && B.i !== undefined) {
        const lit = Math.max(0, 1 - (now - glow.get(sh.to)) / 2200);
        const nx = B.x * k + ox, ny = B.y * k + oy;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (lit > 0) {
          ctx.globalAlpha = lit * 0.8;
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(nx, ny, rad[B.i] * k + 6 + (1 - lit) * 18, 0, TAU); ctx.stroke();
        }
        if (sh.bubble && nx > 0 && nx < W && ny > 0 && ny < H) {
          const label = G.nodes[B.i].label;
          ctx.font = `600 11.5px ${FONT}`;
          const tw = Math.min(220, ctx.measureText(label).width) + 16;
          const bx = nx - tw / 2, by = ny - rad[B.i] * k - 34;
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = colors.bg;
          ctx.strokeStyle = colors.accent;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.roundRect(bx, by, tw, 22, 8); ctx.moveTo(nx - 5, by + 22); ctx.lineTo(nx, by + 28); ctx.lineTo(nx + 5, by + 22); ctx.fill(); ctx.stroke();
          ctx.fillStyle = colors.strong;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(label, nx, by + 11.5, tw - 12);
          ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
        }
      }
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      if (space) {
        // heading: along the curve
        const db = Math.cos(Math.PI * t) * Math.PI * at.amp;
        const tx = ux * run - uy * db, ty = uy * run + ux * db;
        let ang = Math.atan2(ty, tx);
        const away = (P) => (Math.hypot(at.x - P.x, at.y - P.y) > 0.5 ? Math.atan2(at.y - P.y, at.x - P.x) : ang);
        const turn = (from, to, f) => { let d = to - from; d = Math.atan2(Math.sin(d), Math.cos(d)); return from + d * f; };
        const parked = sh.wait || sh.held;
        if (parked) ang = away(B);
        else if (t > 0.8) ang = turn(ang, away(B), (t - 0.8) / 0.2);
        else if (t < 0.2) ang = turn(away(A), ang, t / 0.2);
        const c = Math.cos(ang), sn = Math.sin(ang);
        ctx.setTransform(dpr * c, dpr * sn, -dpr * sn, dpr * c, dpr * px, dpr * py);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = "#ff9d3b";
        const fl = parked ? s * 0.45 : s * (1.1 + Math.random() * 0.5);
        if (!parked) { ctx.beginPath(); ctx.moveTo(-s * 0.4, -s * 0.2); ctx.lineTo(-fl, 0); ctx.lineTo(-s * 0.4, s * 0.2); ctx.closePath(); ctx.fill(); }
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = light ? "#4b5070" : "#d9ddf0";
        ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * 0.6, s * 0.5); ctx.lineTo(-s * 0.35, 0); ctx.lineTo(-s * 0.6, -s * 0.5); ctx.closePath(); ctx.fill();
        ctx.fillStyle = colors.accent;
        ctx.beginPath(); ctx.arc(s * 0.25, 0, s * 0.14, 0, TAU); ctx.fill();
        continue;
      }
      ctx.setTransform(dpr * (dx < 0 ? -1 : 1), 0, 0, dpr, dpr * px, dpr * py);
      if (!sh.wait && !sh.held) {
        ctx.strokeStyle = light ? "#ffffff" : "#a9d3ea";
        ctx.lineWidth = Math.max(1, s * 0.1);
        for (let q = 0; q < 3; q++) {
          ctx.globalAlpha = 0.32 - q * 0.09;
          const x0 = -s * (0.9 + q * 0.9), x1 = x0 - s * 0.9, sp = s * (0.18 + q * 0.16);
          ctx.beginPath(); ctx.moveTo(x0, s * 0.42 - sp * 0.4); ctx.lineTo(x1, s * 0.42 - sp); ctx.moveTo(x0, s * 0.42 + sp * 0.4); ctx.lineTo(x1, s * 0.42 + sp); ctx.stroke();
        }
      }
      ctx.globalAlpha = 0.95;
      // hull
      ctx.fillStyle = light ? "#6b4a2b" : "#8a6440";
      ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.lineTo(s * 0.6, s * 0.45); ctx.lineTo(-s * 0.75, s * 0.45); ctx.closePath(); ctx.fill();
      // mast and sail
      ctx.fillStyle = light ? "#3a3a3a" : "#e8e2d0";
      ctx.beginPath(); ctx.moveTo(0, -s * 1.25); ctx.lineTo(s * 0.75, -s * 0.15); ctx.lineTo(0, -s * 0.15); ctx.closePath(); ctx.fill();
      ctx.fillStyle = light ? "#4a4a4a" : "#d8d2c0";
      ctx.beginPath(); ctx.moveTo(-s * 0.08, -s * 1.1); ctx.lineTo(-s * 0.7, -s * 0.15); ctx.lineTo(-s * 0.08, -s * 0.15); ctx.closePath(); ctx.fill();
      ctx.fillStyle = colors.accent; // the flag, streaming back from the masthead
      ctx.beginPath(); ctx.moveTo(-s * 0.04, -s * 1.5); ctx.lineTo(-s * 0.5, -s * 1.4); ctx.lineTo(-s * 0.04, -s * 1.28); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resize() {
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    dpr = window.devicePixelRatio || 1;
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    measureInset();
    return true;
  }

  function measureInset() {
    insetL = panel.classList.contains("is-collapsed") || panel.classList.contains("is-moved") || W < 700 ? 0 : panel.offsetWidth + 12;
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k, d) => cs.getPropertyValue(k).trim() || d;
    theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const light = theme === "light";
    colors = {
      node: light ? "#8a8a94" : "#9a9aa4",
      edge: light ? "#6b6b75" : "#a6a6b0",
      edgeAlpha: light ? 0.3 : 0.2,
      dimAlpha: light ? 0.14 : 0.12,
      text: v("--text-2", "#b8b8bf"),
      strong: v("--text", "#ececef"),
      bg: v("--bg", "#121214"),
      accent: v("--accent", "#e0a84a"),
      file: light ? "#a3a3ad" : "#6f6f79",
      tag: light ? "#3d8a5c" : "#6fbf8e",
      bridge: light ? "#3b3558" : "#e6e1ff",

      ghost: light ? "#a1a1aa" : "#6a6a74",
    };
    if (G) regroup();
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */
  function nodePath(shape, px, py, r, tiny) {
    if (tiny) { ctx.rect(px - r, py - r, r * 2, r * 2); return; }
    if (shape === "file") { const s = r * 0.9; ctx.rect(px - s, py - s, s * 2, s * 2); return; }
    if (shape === "tag") {
      const s = r * 1.15;
      ctx.moveTo(px, py - s); ctx.lineTo(px + s, py); ctx.lineTo(px, py + s); ctx.lineTo(px - s, py); ctx.closePath();
      return;
    }
    ctx.moveTo(px + r, py);
    ctx.arc(px, py, r, 0, TAU);
  }

  /** The orbit from the free layout: centred, each top folder at a depth of its own (a little spread inside it).
   *  A layout that has not settled yet (a first open) settles here first, so the orbit turns a real graph. */
  function makeOrbit(fresh, was) {
    if (fresh > n * 0.3) for (let t = 0; t < 300; t++) L.step(Math.max(0.02, 1 - t / 300), forces);
    const bx = Float64Array.from(L.x.subarray(0, n)), by = Float64Array.from(L.y.subarray(0, n)), bz = new Float64Array(n);
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += bx[i]; cy += by[i]; }
    cx /= n; cy /= n;
    let ext = 1;
    for (let i = 0; i < n; i++) { bx[i] -= cx; by[i] -= cy; ext = Math.max(ext, Math.hypot(bx[i], by[i])); }
    const top = (nd) => { const p = nd.path || ""; const i = p.indexOf("/"); return i > 0 ? p.slice(0, i) : ""; };
    const tops = [...new Set(G.nodes.map(top))].sort();
    const at = new Map(tops.map((t, k) => [t, k]));
    const gap = (ext * 1.1) / Math.max(1, tops.length - 1);
    for (let i = 0; i < n; i++) {
      const id = G.nodes[i].id;
      let hsh = 0; for (let c = 0; c < id.length; c++) hsh = (hsh * 31 + id.charCodeAt(c)) | 0;
      bz[i] = (at.get(top(G.nodes[i])) - (tops.length - 1) / 2) * gap + ((Math.abs(hsh) % 1000) / 1000 - 0.5) * gap * 0.5;
    }
    return { bx, by, bz, ext, a: was ? was.a : 0.6 };
  }
  /** The orbit at its angle, into the layout: turned round the upright axis, tipped towards the viewer, in perspective. */
  function projectOrbit() {
    const { bx, by, bz, ext, a } = orb;
    const ca = Math.cos(a), sa = Math.sin(a), ct = Math.cos(TILT), st = Math.sin(TILT), D = ext * 3.2;
    for (let i = 0; i < n; i++) {
      const x1 = bx[i] * ca + bz[i] * sa, z1 = -bx[i] * sa + bz[i] * ca;
      const y2 = by[i] * ct - z1 * st, z2 = by[i] * st + z1 * ct;
      const s = D / (D + z2);
      L.x[i] = x1 * s; L.y[i] = y2 * s;
    }
    gridStale = true;
  }
  /** Faint rings in the orbit's plane, turning with it. */
  function drawOrbit(k) {
    const { ext, a } = orb;
    const ct = Math.cos(TILT), st = Math.sin(TILT), D = ext * 3.2;
    ctx.lineWidth = 1 / k;
    ctx.strokeStyle = colors.edge;
    ctx.globalAlpha = colors.edgeAlpha * 0.6;
    dash[0] = 2 / k; dash[1] = 6 / k;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (const r of [ext * 0.45, ext * 0.8, ext * 1.15]) {
      for (let j = 0; j <= 72; j++) {
        const th = (j / 72) * TAU + a;
        const x1 = r * Math.cos(th), z1 = r * Math.sin(th);
        const z2 = z1 * ct, s = D / (D + z2);
        if (j === 0) ctx.moveTo(x1 * s, -z1 * st * s); else ctx.lineTo(x1 * s, -z1 * st * s);
      }
    }
    ctx.stroke();
    ctx.setLineDash(noDash);
    ctx.globalAlpha = 1;
  }

  /** The timeline's guides: a line along each folder's lane with its name, and the months (or years) above. */
  function drawTimeline(k, ox, oy) {
    const { lanes, t0, t1, width, lane } = tl;
    if (!lanes.length) return;
    const x0 = -width / 2, x1 = width / 2;
    const top = lanes[0].y - lane / 2, bottom = lanes[lanes.length - 1].y + lane / 2;
    const span = Math.max(1, t1 - t0);
    const xOf = (t) => x0 + ((t - t0) / span) * width;
    // days over a few weeks, months, or years over a span of three years and more
    const yearly = span > 3 * 365 * 864e5;
    const daily = span < 45 * 864e5;
    const every = Math.max(1, Math.ceil(span / 864e5 / 12)); // a dozen day marks at most
    const ticks = [];
    const d = new Date(t0); if (!daily) d.setDate(1); d.setHours(0, 0, 0, 0);
    if (yearly) d.setMonth(0);
    for (let guard = 0; guard < 400; guard++) {
      if (daily) { d.setDate(d.getDate() + every); if (+d > t1) break; ticks.push({ x: xOf(+d), label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) }); continue; }
      if (yearly) d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1);
      if (+d > t1) break;
      ticks.push({ x: xOf(+d), label: yearly ? String(d.getFullYear()) : d.toLocaleDateString(undefined, d.getMonth() === 0 ? { month: "short", year: "numeric" } : { month: "short" }) });
    }
    ctx.lineWidth = 1 / k;
    ctx.strokeStyle = colors.edge;
    ctx.globalAlpha = colors.edgeAlpha * 0.7;
    dash[0] = 2 / k; dash[1] = 6 / k;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (const t of ticks) { ctx.moveTo(t.x, top); ctx.lineTo(t.x, bottom); }
    ctx.stroke();
    ctx.setLineDash(noDash);
    ctx.globalAlpha = colors.edgeAlpha * 0.5;
    ctx.beginPath();
    for (const l of lanes) { ctx.moveTo(x0, l.y); ctx.lineTo(x1, l.y); }
    ctx.stroke();
    // the words at a size of their own, whatever the zoom
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = colors.text;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (const l of lanes) ctx.fillText(l.name, x0 * k + ox, (l.y - lane * 0.36) * k + oy); // inside its lane, at the left end
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const t of ticks) ctx.fillText(t.label, t.x * k + ox, top * k + oy - 6);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
  }

  function draw() {
    if (!W) return;
    if ((window.devicePixelRatio || 1) !== dpr) resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (S.look !== "plain") drawBackdrop();
    const k = cam.k;
    const ox = W / 2 + cam.x;
    const oy = H / 2 + cam.y;
    if (frames.length) {
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
      drawFrames(k, ox, oy);
      if (!n) drawFrameText(k, ox, oy);
    }
    if (!n) return;
    if (hList.length) measureHomes();
    const pad = maxR + 2;
    const vx0 = -ox / k - pad;
    const vx1 = (W - ox) / k + pad;
    const vy0 = -oy / k - pad;
    const vy1 = (H - oy) / k + pad;
    const { x, y } = L;
    const src = G.src;
    const dst = G.dst;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    ctx.lineCap = "round";
    if (hList.length && (S.homeHalos || S.look !== "plain")) drawHalos(k, ox, oy);
    if (hList.length) drawRoutes(k, ox, oy);

    if (tl) drawTimeline(k, ox, oy);
    if (orb) drawOrbit(k);
    // ring guides round the focus of a radial layout
    if (ringGap && G.focus >= 0) {
      const fx = x[G.focus];
      const fy = y[G.focus];
      dash[0] = 3 / k;
      dash[1] = 5 / k;
      ctx.setLineDash(dash);
      ctx.strokeStyle = colors.edge;
      ctx.globalAlpha = colors.edgeAlpha * 0.9;
      ctx.lineWidth = 1 / k;
      ctx.beginPath();
      for (let d = 1; d <= ringMax; d++) {
        ctx.moveTo(fx + d * ringGap, fy);
        ctx.arc(fx, fy, d * ringGap, 0, TAU);
      }
      ctx.stroke();
      ctx.setLineDash(noDash);
    }

    // Links: one path for the ordinary ones, then one per emphasis class
    // (1 new, 2 fading out, 3 both) while a crossfade runs, else just 1.
    const dimK = smooth(dimT);
    const dimOn = dimK > 0.001;
    const fading = swapT < 1;
    const sw = smooth(swapT);
    const full = fading ? 3 : 1;
    const lw = (S.linkWidth * clampNum(k, 0.5, 1.7)) / k;
    const epass = !dimOn ? 1 : fading ? 4 : 2;
    // bridges get their own pass and style; plain links may step aside
    const mask = crossMask(S.crossBy);
    const bridgeOn = S.crossLinks && bridgeN > 0;
    const hideInner = (S.hideInner || S.bridgesOnly) && bridgeN > 0;
    for (let pass = 0; pass < epass; pass++) {
      ctx.beginPath();
      let any = false;
      for (let e = 0; e < m; e++) {
        if (dimOn) {
          const cls = fading ? eEmph[e] | (eEmphPrev[e] << 1) : eEmph[e];
          if (pass === 0 ? cls === full : cls !== pass) continue;
        }
        if (pass === 0 && (eCls[e] & mask ? bridgeOn : hideInner)) continue;
        const a = src[e];
        const b = dst[e];
        if (!vis[a] || !vis[b] || routed(a, b)) continue;
        const ax = x[a], ay = y[a], bx = x[b], by = y[b];
        if ((ax < vx0 && bx < vx0) || (ax > vx1 && bx > vx1) || (ay < vy0 && by < vy0) || (ay > vy1 && by > vy1)) continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        any = true;
      }
      if (pass === 0 && bridgeOn) {
        if (any) {
          ctx.strokeStyle = colors.edge;
          ctx.globalAlpha = colors.edgeAlpha * (1 - 0.55 * dimK);
          ctx.lineWidth = lw;
          ctx.stroke();
        }
        drawBridges(k, lw, dimK, dimOn, fading, full, mask, vx0, vx1, vy0, vy1);
        continue;
      }
      if (!any) continue;
      if (pass === 0) {
        ctx.strokeStyle = colors.edge;
        ctx.globalAlpha = colors.edgeAlpha * (1 - 0.55 * dimK);
        ctx.lineWidth = lw;
      } else {
        ctx.strokeStyle = colors.accent;
        ctx.globalAlpha = 0.85 * dimK * (pass === full ? 1 : pass === 1 ? sw : 1 - sw);
        ctx.lineWidth = lw * (path ? 2.4 : 1.5);
      }
      ctx.stroke();
    }

    if (S.arrows && k > 0.3) drawArrows(k, vx0, vx1, vy0, vy1, dimK > 0.5);

    // the link under the pointer
    if (hoverEdge >= 0 && hoverEdge < m) {
      const a = G.src[hoverEdge], b = G.dst[hoverEdge];
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = Math.max(2.4 / k, lw * 2.2);
      ctx.beginPath();
      if (bowed(hoverEdge)) { const q = bowOf(hoverEdge); ctx.moveTo(x[q.a], y[q.a]); ctx.quadraticCurveTo(q.cx, q.cy, x[q.b], y[q.b]); }
      else { ctx.moveTo(x[a], y[a]); ctx.lineTo(x[b], y[b]); }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // a soft glow under the hovered and selected notes, in their own colour
    if (hover >= 0 || selIdx.length) {
      const glowAt = (i) => {
        if (i < 0 || !vis[i]) return;
        const r = rad[i] * 3.4 + 6 / k;
        ctx.drawImage(glowSprite(gColor[groupOf[i]] || colors.accent), x[i] - r, y[i] - r, r * 2, r * 2);
      };
      ctx.globalAlpha = 0.9;
      glowAt(hover);
      for (let t = 0; t < selIdx.length && t < 60; t++) if (selIdx[t] !== hover) glowAt(selIdx[t]);
      ctx.globalAlpha = 1;
    }
    // nodes, batched per colour; dimmed ones first so the rest sits on top
    const tinyR = 1.1 / k;
    const a0 = 1 + (colors.dimAlpha - 1) * dimK;
    for (let q = 0; q < epass; q++) {
      // classes in drawing order: dim, fading out, fading in, full
      const pass = !dimOn ? -1 : fading ? NODE_ORDER[q] : q;
      ctx.globalAlpha = pass <= 0 ? (pass < 0 ? 1 : a0) : pass === full ? 1 : a0 + (1 - a0) * (pass === 1 ? sw : 1 - sw);
      for (let gi = 0; gi < groups.length; gi++) {
        const list = members[gi];
        const shape = groups[gi].kind || "note";
        ctx.beginPath();
        let any = false;
        for (let t = 0; t < list.length; t++) {
          const i = list[t];
          if (!vis[i]) continue;
          if (pass >= 0 && (fading ? emph[i] | (emphPrev[i] << 1) : emph[i]) !== pass) continue;
          const px = x[i];
          const py = y[i];
          if (px < vx0 || px > vx1 || py < vy0 || py > vy1) continue;
          const r = rad[i];
          nodePath(shape, px, py, r, r < tinyR);
          any = true;
        }
        if (!any) continue;
        if (shape === "ghost") {
          ctx.strokeStyle = gColor[gi];
          ctx.lineWidth = Math.max(1.2 / k, 0.9);
          ctx.stroke();
        } else {
          ctx.fillStyle = gColor[gi];
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    drawMarks(k);
    if (frames.length) drawFrameText(k, ox, oy);
    drawLabels(k, ox, oy);
    if (lens.on) lens.paint(ctx, dpr, W, H);
  }

  /* ── homes and bridges: drawing ──────────────────────────────────────── */
  // halo centre and size per home, from the members on screen
  function measureHomes() {
    const { x, y } = L;
    for (let k = 0; k < hList.length; k++) {
      const list = hMembers[k];
      let sx = 0, sy = 0, c = 0;
      for (let t = 0; t < list.length; t++) {
        const i = list[t];
        if (!vis[i] || held[i]) continue;
        sx += x[i]; sy += y[i]; c++;
      }
      if (!c) { hr[k] = 0; continue; }
      sx /= c; sy /= c;
      let s2 = 0, far = 0;
      for (let t = 0; t < list.length; t++) {
        const i = list[t];
        if (!vis[i] || held[i]) continue;
        const d2 = (x[i] - sx) ** 2 + (y[i] - sy) ** 2;
        s2 += d2;
        if (d2 > far) far = d2;
      }
      hcx[k] = sx;
      hcy[k] = sy;
      // strays do not blow the halo up
      hr[k] = Math.min(Math.sqrt(far), Math.sqrt(s2 / c) * 1.9) + maxR + 18;
    }
  }

  // soft discs under everything, stacked for a gentle falloff
  function drawHalos(k, ox, oy) {
    const light = theme === "light";
    const a = 0.034;
    for (let h2 = 0; h2 < hList.length; h2++) {
      const r = hr[h2];
      if (r <= 0) continue;
      const cx = hcx[h2], cy = hcy[h2];
      const sx = cx * k + ox, sy = cy * k + oy, sr = r * k;
      if (sx + sr * 1.2 < 0 || sx - sr * 1.2 > W || sy + sr * 1.2 < 0 || sy - sr * 1.2 > H) continue;
      if (S.look === "pirates") { drawIsland(h2, k); continue; }
      if (S.look === "space") { drawPlanet(h2, k); continue; }
      ctx.fillStyle = homeColor(h2);
      ctx.globalAlpha = a * (1 - 0.5 * smooth(dimT));
      for (let s = 0; s < 4; s++) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1 - s * 0.2), 0, TAU);
        ctx.fill();
      }
      if (h2 === hHover || (bridgeSel && bridgeSel.kind === "home" && bridgeSel.key === hList[h2].id)) {
        ctx.globalAlpha = light ? 0.35 : 0.3;
        ctx.strokeStyle = homeColor(h2);
        ctx.lineWidth = 1.2 / k;
        dash[0] = 4 / k;
        dash[1] = 5 / k;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.stroke();
        ctx.setLineDash(noDash);
      }
    }
    ctx.globalAlpha = 1;
  }

  // home names above their halos, big when zoomed out so the map reads
  const homeFonts = new Map();
  function drawHomeLabels(k, ox, oy) {
    if (!S.homeNames) return;
    const dim = 1 - 0.6 * smooth(dimT);
    ctx.lineJoin = "round";
    for (let h2 = 0; h2 < hList.length; h2++) {
      const r = hr[h2];
      if (r <= 0) continue;
      const sr = r * k;
      const sx = hcx[h2] * k + ox;
      const came = glow.get("h:" + hList[h2].id);
      const pop = came ? Math.max(0, 1 - (performance.now() - came) / 700) : 0;
      const px = Math.round(clampNum(9 + sr * 0.07, 11, 20) * (1 + 0.35 * Math.sin(Math.PI * pop)));
      const sy = (hcy[h2] - r) * k + oy - px - 2;
      if (sx < -300 || sx > W + 300 || sy < -40 || sy > H) continue;
      let font = homeFonts.get(px);
      if (!font) { font = `650 ${px}px ${FONT}`; homeFonts.set(px, font); }
      ctx.font = font;
      const t = fitText(hList[h2], "_lt", homeName(h2), Math.max(160, sr * 2.2));
      if (!t) continue;
      const tw = ctx.measureText(t).width;
      if (!placeLabel(sx, sy, tw + 6, px + 2, -1)) continue;
      // faint up close, where the core's own label says it
      ctx.globalAlpha = clampNum(1.15 - k * 0.5, 0.45, 0.9) * dim;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = colors.bg;
      ctx.strokeText(t, sx, sy);
      ctx.fillStyle = pop > 0.15 ? colors.accent : homeColor(h2);
      ctx.fillText(t, sx, sy);
    }
    ctx.globalAlpha = 1;
  }

  // Bridges: the links between homes / groups, in the chosen style.
  // Collected once into bBuf (no allocation), then stroked in one or a few
  // paths; only gradients cost a stroke each, and only up to GRAD_MAX.
  function drawBridges(k, lw, dimK, dimOn, fading, full, mask, vx0, vx1, vy0, vy1) {
    const t0 = performance.now();
    const { x, y } = L;
    const src = G.src, dst = G.dst;
    if (bBuf.length < m) bBuf = new Int32Array(Math.max(m, bBuf.length * 2));
    let nb = 0;
    for (let e = 0; e < m; e++) {
      if (!(eCls[e] & mask)) continue;
      if (dimOn && (fading ? (eEmph[e] | (eEmphPrev[e] << 1)) === full : eEmph[e])) continue;
      const a = src[e], b = dst[e];
      if (!vis[a] || !vis[b] || routed(a, b)) continue;
      const ax = x[a], ay = y[a], bx = x[b], by = y[b];
      if ((ax < vx0 && bx < vx0) || (ax > vx1 && bx > vx1) || (ay < vy0 && by < vy0) || (ay > vy1 && by > vy1)) continue;
      bBuf[nb++] = e;
    }
    perf.bridges = nb;
    if (!nb) return;
    const style = S.linkStyle;
    const fade = 1 - 0.7 * dimK;
    const light = theme === "light";
    const w = lw * 1.3;
    if (style === "gradient") {
      ctx.lineWidth = w * 1.15;
      ctx.globalAlpha = (light ? 0.75 : 0.7) * fade;
      if (nb <= GRAD_MAX) {
        for (let t = 0; t < nb; t++) {
          const e = bBuf[t];
          const a = src[e], b = dst[e];
          const g = ctx.createLinearGradient(x[a], y[a], x[b], y[b]);
          g.addColorStop(0, gColor[groupOf[a]]);
          g.addColorStop(1, gColor[groupOf[b]]);
          ctx.strokeStyle = g;
          ctx.beginPath();
          if (S.bridgeCurve) { const q = bowOf(e); ctx.moveTo(x[q.a], y[q.a]); ctx.quadraticCurveTo(q.cx, q.cy, x[q.b], y[q.b]); }
          else { ctx.moveTo(x[a], y[a]); ctx.lineTo(x[b], y[b]); }
          ctx.stroke();
        }
      } else {
        // many: each half in its end's colour, one path per colour
        for (let gi = 0; gi < groups.length; gi++) {
          ctx.beginPath();
          let any = false;
          for (let t = 0; t < nb; t++) {
            const e = bBuf[t];
            const a = src[e], b = dst[e];
            const ga = groupOf[a] === gi, gb = groupOf[b] === gi;
            if (!ga && !gb) continue;
            if (S.bridgeCurve) {
              // the bow split at its middle: two smaller bows
              const q = bowOf(e), A = q.a, B = q.b;
              const mx = (x[A] + 2 * q.cx + x[B]) / 4, my = (y[A] + 2 * q.cy + y[B]) / 4;
              if (groupOf[A] === gi) { ctx.moveTo(x[A], y[A]); ctx.quadraticCurveTo((x[A] + q.cx) / 2, (y[A] + q.cy) / 2, mx, my); }
              if (groupOf[B] === gi) { ctx.moveTo(mx, my); ctx.quadraticCurveTo((q.cx + x[B]) / 2, (q.cy + y[B]) / 2, x[B], y[B]); }
              any = true;
              continue;
            }
            const mx = (x[a] + x[b]) / 2, my = (y[a] + y[b]) / 2;
            if (ga) { ctx.moveTo(x[a], y[a]); ctx.lineTo(mx, my); }
            if (gb) { ctx.moveTo(mx, my); ctx.lineTo(x[b], y[b]); }
            any = true;
          }
          if (!any) continue;
          ctx.strokeStyle = gColor[gi];
          ctx.stroke();
        }
      }
      perf.bridgeMs = performance.now() - t0;
      return;
    }
    ctx.beginPath();
    const curve = S.bridgeCurve;
    for (let t = 0; t < nb; t++) {
      const e = bBuf[t];
      if (curve) { const q = bowOf(e); ctx.moveTo(x[q.a], y[q.a]); ctx.quadraticCurveTo(q.cx, q.cy, x[q.b], y[q.b]); }
      else { ctx.moveTo(x[src[e]], y[src[e]]); ctx.lineTo(x[dst[e]], y[dst[e]]); }
    }
    ctx.strokeStyle = colors.bridge;
    if (style === "glow") {
      ctx.lineWidth = w * 4;
      ctx.globalAlpha = (light ? 0.16 : 0.14) * fade;
      ctx.stroke();
    }
    if (style === "dashed") {
      dash[0] = 5 / k;
      dash[1] = 4 / k;
      ctx.setLineDash(dash);
    }
    ctx.lineWidth = w;
    ctx.globalAlpha = (light ? 0.55 : 0.5) * fade;
    ctx.stroke();
    if (style === "dashed") ctx.setLineDash(noDash);
    perf.bridgeMs = performance.now() - t0;
  }

  /* ── comment frames: drawing ─────────────────────────────────────────── */
  const frameColor = (c) => (PALETTE[theme] || PALETTE.dark)[c % FRAME_COLORS];
  const inView = (f, k, ox, oy) => f.x * k + ox < W && f.y * k + oy < H && (f.x + f.w) * k + ox > 0 && (f.y + f.h) * k + oy > 0;

  function frameShape(f, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(f.x, f.y, f.w, f.h, r);
    else ctx.rect(f.x, f.y, f.w, f.h);
  }

  // world transform is set: body, header band, border, resize grip
  function drawFrames(k, ox, oy) {
    const light = theme === "light";
    const r = Math.min(8, 6 / Math.sqrt(k));
    for (const f of frames) {
      if (!inView(f, k, ox, oy)) continue;
      const c = frameColor(f.c);
      const on = f.id === frameSel || f.id === frameHover || (editing && editing.f === f);
      const head = Math.min(FRAME_HEAD, f.h);
      ctx.fillStyle = c;
      frameShape(f, r);
      ctx.globalAlpha = light ? 0.075 : 0.07;
      ctx.fill();
      if (FRAME_HEAD * k >= BIG_TITLE) {
        ctx.save();
        ctx.clip();
        ctx.globalAlpha = light ? 0.3 : 0.28;
        ctx.fillRect(f.x, f.y, f.w, head);
        ctx.restore();
      }
      ctx.globalAlpha = on ? 0.95 : light ? 0.6 : 0.5;
      ctx.strokeStyle = c;
      ctx.lineWidth = (on ? 2 : 1.25) / k;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // text that fits a width, cut with an ellipsis; cached per frame
  function fitText(f, slot, text, maxW) {
    const key = ctx.font + "|" + Math.round(maxW / 6) + "|" + text;
    const c = f[slot];
    if (c && c.key === key) return c.text;
    let t = text;
    if (ctx.measureText(t).width > maxW) {
      let lo = 0, hi = t.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
        else hi = mid - 1;
      }
      t = lo ? text.slice(0, lo) + "…" : "";
    }
    f[slot] = { key, text: t };
    return t;
  }

  // screen transform: titles in the header, or big across the frame when
  // zoomed out so the map still reads
  function drawFrameText(k, ox, oy) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = "middle";
    const headPx = FRAME_HEAD * k;
    const big = headPx < BIG_TITLE;
    for (const f of frames) {
      f._tb = null;
      if (!inView(f, k, ox, oy)) continue;
      const sx = f.x * k + ox;
      const sy = f.y * k + oy;
      const sw = f.w * k;
      const sh = f.h * k;
      const title = f.title || "Comment";
      if (!big) {
        if (editing && editing.f === f && editing.field === "title") continue;
        const px = Math.min(22, Math.max(11, headPx * 0.46));
        ctx.textAlign = "left";
        ctx.font = `600 ${px}px ${FONT}`;
        ctx.fillStyle = colors.strong;
        ctx.globalAlpha = 1;
        const padX = Math.max(8, px * 0.7);
        ctx.fillText(fitText(f, "_ft", title, sw - padX * 2), sx + padX, sy + Math.min(headPx, sh) / 2 + 0.5);
        if (f.note && sh > headPx + px * 2 && !(editing && editing.f === f)) {
          ctx.font = `450 ${Math.max(10.5, px * 0.8)}px ${FONT}`;
          ctx.fillStyle = colors.text;
          ctx.globalAlpha = 0.9;
          ctx.fillText(fitText(f, "_fn", f.note, sw - padX * 2), sx + padX, sy + headPx + px);
        }
        continue;
      }
      if (sw < 6 || sh < 6) continue;
      const px = Math.round(clampNum(Math.min((sw * 1.5) / Math.max(4, title.length), sh * 0.4), 11, 42));
      ctx.textAlign = "center";
      ctx.font = `700 ${px}px ${FONT}`;
      const t = fitText(f, "_fb", title, Math.max(sw - 8, 150));
      const cx = sx + sw / 2;
      const cy = sw < 150 ? sy + sh / 2 : sy + Math.min(sh / 2, px * 0.9 + 6);
      ctx.globalAlpha = 1;
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = colors.bg;
      ctx.strokeText(t, cx, cy);
      ctx.fillStyle = frameColor(f.c);
      ctx.fillText(t, cx, cy);
      // the big title works as the header for dragging
      const tw = ctx.measureText(t).width + 12;
      const tb = f._tbuf || (f._tbuf = [0, 0, 0, 0]);
      tb[0] = (cx - tw / 2 - ox) / k;
      tb[1] = (cy - px * 0.7 - oy) / k;
      tb[2] = (cx + tw / 2 - ox) / k;
      tb[3] = (cy + px * 0.7 - oy) / k;
      f._tb = tb;
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = "top";
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
  }

  function drawArrows(k, vx0, vx1, vy0, vy1, dimming) {
    const al = (5.5 * Math.max(0.8, Math.sqrt(S.linkWidth))) / Math.sqrt(Math.max(k, 0.5));
    const { x, y } = L;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1 && !dimming) break;
      ctx.beginPath();
      for (let e = 0; e < m; e++) {
        if (dimming && (pass === 0) === (eEmph[e] === 1)) continue;
        const a = G.src[e];
        const b = G.dst[e];
        if (!vis[a] || !vis[b]) continue;
        const bx = x[b], by = y[b];
        if (bx < vx0 || bx > vx1 || by < vy0 || by > vy1) continue;
        // a bowed bridge arrives along its curve: the tangent at either end points away from the bend's control point
        const q = bowed(e) ? bowOf(e) : null;
        arrowHead(q ? q.cx : x[a], q ? q.cy : y[a], bx, by, rad[b], al);
        if (G.both[e]) arrowHead(q ? q.cx : bx, q ? q.cy : by, x[a], y[a], rad[a], al);
      }
      ctx.fillStyle = pass === 0 ? colors.edge : colors.accent;
      ctx.globalAlpha = pass === 0 ? (dimming ? colors.edgeAlpha * 0.6 : Math.min(1, colors.edgeAlpha * 2.4)) : 0.9;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function arrowHead(ax, ay, bx, by, rb, al) {
    const dx = bx - ax;
    const dy = by - ay;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < rb + al * 1.6) return;
    const ux = dx / d;
    const uy = dy / d;
    const tx = bx - ux * (rb + 0.8);
    const ty = by - uy * (rb + 0.8);
    const sx = tx - ux * al;
    const sy = ty - uy * al;
    const w = al * 0.42;
    ctx.moveTo(tx, ty);
    ctx.lineTo(sx - uy * w, sy + ux * w);
    ctx.lineTo(sx + uy * w, sy - ux * w);
    ctx.closePath();
  }

  function ring(i, gapPx, widthPx, color, k) {
    ctx.beginPath();
    ctx.arc(L.x[i], L.y[i], rad[i] + gapPx / k, 0, TAU);
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx / k;
    ctx.stroke();
  }

  function drawMarks(k) {
    const { x, y } = L;
    // the focus of a local graph: accent, with a soft halo
    if (G.focus >= 0 && vis[G.focus]) {
      const f = G.focus;
      ctx.fillStyle = colors.accent;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(x[f], y[f], rad[f] + 10 / k, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x[f], y[f], rad[f], 0, TAU);
      ctx.fill();
    }
    if (pinIdx.length && k > 0.4) {
      // a small, quiet dot: frames pin everything inside them
      const dimPins = dimT >= 0.5;
      ctx.fillStyle = colors.strong;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (let t = 0; t < pinIdx.length; t++) {
        const i = pinIdx[t];
        const r = rad[i];
        if (!vis[i] || r * k < 3.5 || (dimPins && !emph[i])) continue;
        const s = Math.max(1.3 / k, r * 0.22);
        const cx = x[i] + r * 0.75;
        const cy = y[i] - r * 0.75;
        ctx.moveTo(cx + s, cy);
        ctx.arc(cx, cy, s, 0, TAU);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // selection rings in one path: a select-all must not cost a stroke each
    if (selIdx.length) {
      ctx.beginPath();
      const gap = 2.5 / k;
      for (let t = 0; t < selIdx.length; t++) {
        const i = selIdx[t];
        if (!vis[i]) continue;
        const r = rad[i] + gap;
        ctx.moveTo(x[i] + r, y[i]);
        ctx.arc(x[i], y[i], r, 0, TAU);
      }
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.8 / k;
      ctx.stroke();
    }
    if (path) {
      ring(path.one[0], 3.5, 2, colors.accent, k);
      ring(path.one[path.one.length - 1], 3.5, 2, colors.accent, k);
    }
    const cur = matchAt >= 0 ? matches[matchAt] : undefined;
    if (cur !== undefined && vis[cur]) ring(cur, 4.5, 1.6, colors.strong, k);
    let wired = false;
    if (picking) {
      const a = G.index.get(picking.from);
      if (a !== undefined) ring(a, 3.5, 2, colors.accent, k);
      // the link being made, stretching from its note to the pointer - it
      // snaps onto whatever note is under it
      if (a !== undefined && picking.link && linkPtr) {
        const to = hover >= 0 && hover !== a ? hover : -1;
        const tx = to >= 0 ? L.x[to] : linkPtr.x;
        const ty = to >= 0 ? L.y[to] : linkPtr.y;
        const dx = tx - L.x[a];
        const dy = ty - L.y[a];
        const len = Math.hypot(dx, dy);
        if (len > rad[a] + 2 / k) {
          const ux = dx / len;
          const uy = dy / len;
          const sx = L.x[a] + ux * (rad[a] + 3.5 / k);
          const sy = L.y[a] + uy * (rad[a] + 3.5 / k);
          const stop = to >= 0 ? rad[to] + 4 / k : 0;
          const ex = tx - ux * stop;
          const ey = ty - uy * stop;
          // the very line the lens draws: an SVG path over the canvas, its dashes
          // moved by CSS, so nothing here repaints the graph to animate it
          const scr = (x, y) => [x * cam.k + W / 2 + cam.x, y * cam.k + H / 2 + cam.y];
          const [ax, ay] = scr(sx, sy);
          const [bx, by] = scr(ex, ey);
          const bow = Math.min(40, Math.hypot(bx - ax, by - ay) * 0.18);
          linkWirePath.setAttribute("d", `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${((ax + bx) / 2).toFixed(1)} ${((ay + by) / 2 - bow).toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`);
          linkWirePath.setAttribute("marker-end", "url(#gx-wire-head)");
          if (picking.both) linkWirePath.setAttribute("marker-start", "url(#gx-wire-head)");
          else linkWirePath.removeAttribute("marker-start");
          wired = true;
          if (to >= 0) ring(to, 3.5, 2, colors.accent, k);
        }
      }
    }
    if (!wired && linkWirePath.hasAttribute("d")) linkWirePath.removeAttribute("d");
    if (hover >= 0) ring(hover, 2, 1.4, colors.strong, k);
  }

  let fontCache = { key: "", normal: "", bold: "" };
  function fonts(px, strongPx) {
    const key = px + "/" + strongPx;
    if (fontCache.key !== key) {
      fontCache = { key, normal: `450 ${px}px ${FONT}`, bold: `600 ${strongPx}px ${FONT}` };
      widths.fill(-1);
      strongWidths.fill(-1);
    }
    return fontCache;
  }

  // Label placement: a coarse screen grid of taken cells, cleared per frame,
  // so labels never pile on each other. Widths are measured once per font.
  const CELL_W = 8;
  const CELL_H = 7;
  let taken = new Uint8Array(0);
  let owner = new Int32Array(0); // node index + 1 whose disc covers the cell
  let cols = 0;
  let rows = 0;
  let widths = new Float32Array(0);
  let strongWidths = new Float32Array(0);

  // self >= 0: the label may cover only its own node
  function placeLabel(sx, sy, w, hgt, self) {
    const c0 = Math.max(0, Math.floor((sx - w / 2) / CELL_W));
    const c1 = Math.min(cols - 1, Math.floor((sx + w / 2) / CELL_W));
    const r0 = Math.max(0, Math.floor(sy / CELL_H));
    const r1 = Math.min(rows - 1, Math.floor((sy + hgt) / CELL_H));
    if (c0 > c1 || r0 > r1) return false;
    for (let r = r0; r <= r1; r++) {
      const o = r * cols;
      for (let c = c0; c <= c1; c++) {
        if (taken[o + c]) return false;
        if (self >= 0 && owner[o + c] && owner[o + c] !== self + 1) return false;
      }
    }
    for (let r = r0; r <= r1; r++) {
      const o = r * cols;
      for (let c = c0; c <= c1; c++) taken[o + c] = 1;
    }
    return true;
  }

  function markNodes(k, ox, oy) {
    owner.fill(0);
    for (let i = 0; i < n; i++) {
      if (!vis[i]) continue;
      const r = rad[i] * k - 1;
      if (r < 1.5) continue;
      const sx = L.x[i] * k + ox;
      const sy = L.y[i] * k + oy;
      if (sx < -r || sx > W + r || sy < -r || sy > H + r) continue;
      const c0 = Math.max(0, Math.floor((sx - r) / CELL_W));
      const c1 = Math.min(cols - 1, Math.floor((sx + r) / CELL_W));
      const r0 = Math.max(0, Math.floor((sy - r) / CELL_H));
      const r1 = Math.min(rows - 1, Math.floor((sy + r) / CELL_H));
      for (let rr = r0; rr <= r1; rr++) {
        const o = rr * cols;
        for (let c = c0; c <= c1; c++) owner[o + c] = i + 1;
      }
    }
  }

  // a label that always shows, with a halo so it reads over links
  function strongLabel(i, k, ox, oy, px) {
    if (!vis[i] || drawnLabel[i]) return 0;
    const sx = L.x[i] * k + ox;
    const sy = L.y[i] * k + oy + rad[i] * k + 4;
    if (sx < -200 || sx > W + 200 || sy < -20 || sy > H + 4) return 0;
    if (strongWidths[i] < 0) strongWidths[i] = ctx.measureText(labels[i]).width;
    if (!placeLabel(sx, sy, strongWidths[i] + 4, px, -1)) return 0;
    drawnLabel[i] = 1;
    ctx.strokeText(labels[i], sx, sy);
    ctx.fillText(labels[i], sx, sy);
    return 1;
  }
  let drawnLabel = new Uint8Array(0);

  function drawLabels(k, ox, oy) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const { x, y } = L;
    if (widths.length < n) {
      widths = new Float32Array(rad.length).fill(-1);
      strongWidths = new Float32Array(rad.length).fill(-1);
      drawnLabel = new Uint8Array(rad.length);
    }
    const c = Math.ceil(W / CELL_W);
    const r = Math.ceil(H / CELL_H);
    if (c !== cols || r !== rows) { cols = c; rows = r; taken = new Uint8Array(c * r); owner = new Int32Array(c * r); }
    else taken.fill(0);
    drawnLabel.fill(0, 0, n);
    const base = 11.5 * S.labelSize;
    const px = Math.round(base * clampNum(Math.sqrt(k), 0.85, 1.2) * 2) / 2;
    const strongPx = Math.round(Math.max(px, base) * 2) / 2;
    const f = fonts(px, strongPx);
    const fade = S.textFade;
    drawFog(k, ox, oy);
    drawShips(k, ox, oy);
    if (hList.length) drawHomeLabels(k, ox, oy);

    // the labels that must show are placed first, most important first
    ctx.font = f.bold;
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = colors.bg;
    ctx.fillStyle = colors.strong;
    ctx.globalAlpha = 1;
    if (hover >= 0) strongLabel(hover, k, ox, oy, strongPx);
    if (G.focus >= 0) strongLabel(G.focus, k, ox, oy, strongPx);
    for (let t = 0; t < selIdx.length && t < 80; t++) strongLabel(selIdx[t], k, ox, oy, strongPx);
    if (dimT >= 0.5) {
      let drawn = 0;
      for (let t = 0; t < n && drawn < 160; t++) {
        const i = byDeg[t];
        if (emph[i]) drawn += strongLabel(i, k, ox, oy, strongPx);
      }
      ctx.globalAlpha = 1;
      return;
    }

    // ordinary labels fade in with zoom, hubs first; byDeg is sorted by
    // degree, so the first node too faint to show ends the pass
    if (!n || (k * (1 + Math.sqrt(G.nodes[byDeg[0]].deg) * 0.14) - fade) / (fade * 0.35) <= 0.02) return;
    markNodes(k, ox, oy);
    ctx.font = f.normal;
    ctx.fillStyle = colors.text;
    let drawn = 0;
    for (let t = 0; t < n && drawn < MAX_LABELS; t++) {
      const i = byDeg[t];
      const a = (k * (1 + Math.sqrt(G.nodes[i].deg) * 0.14) - fade) / (fade * 0.35);
      if (a <= 0.02) break;
      if (!vis[i] || drawnLabel[i]) continue;
      const sx = x[i] * k + ox;
      const sy = y[i] * k + oy + rad[i] * k + 3;
      if (sx < -200 || sx > W + 200 || sy < -20 || sy > H + 4) continue;
      if (widths[i] < 0) widths[i] = ctx.measureText(labels[i]).width;
      if (!placeLabel(sx, sy, widths[i] + 2, px, i)) continue;
      ctx.globalAlpha = a > 1 ? 0.92 : a * 0.92;
      ctx.fillText(labels[i], sx, sy);
      drawn++;
    }
    ctx.globalAlpha = 1;
  }

  /* ── hit testing & pointer ───────────────────────────────────────────── */
  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - W / 2 - cam.x) / cam.k, y: (e.clientY - r.top - H / 2 - cam.y) / cam.k, sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  function pickAt(wx, wy) {
    if (!n) return -1;
    if (gridStale) {
      grid.build(L.x, L.y, n, Math.max(24, maxR * 2.5));
      gridStale = false;
    }
    return grid.nearest(wx, wy, rad, maxR, 5 / cam.k, vis);
  }

  function setEmphHover(i) {
    clearTimeout(undimTimer);
    if (i !== emphHover) { emphHover = i; updateEmphasis(); }
  }

  function setHover(i) {
    if (i !== hover) {
      hover = i;
      setCursor(i >= 0 ? "pointer" : picking ? "crosshair" : "");
      if (i >= 0) setEmphHover(i);
      else { clearTimeout(undimTimer); undimTimer = setTimeout(() => { if (hover < 0) setEmphHover(-1); }, UNDIM_DELAY); }
      clearTimeout(tipTimer);
      // with the lens on the reading cards replace the hover tooltip
      if (lens.on) tip.hidden = true;
      // leaving a note does not snatch its card away: it waits long enough to
      // be reached, and stays for as long as the pointer is on it
      else if (i < 0) tipTimer = setTimeout(() => { if (hover < 0 && !tipHeld) hideTip(); }, S.tipLinger || TIP_LINGER);
      else if (S.tips === false) hideTip();
      else if (tip.hidden) tipTimer = setTimeout(() => { if (hover === i) showTip(i); }, S.tipDelay ?? 130);
      else showTip(i);
      kick();
    }
  }

  let tipW = 0;
  let tipH = 0;
  const TIP_LINGER = 650;
  let tipNode = -1; // the note the card is about - it outlives the hover
  let tipHeld = false;
  const hideTip = () => { tip.hidden = true; tipNode = -1; tipHeld = false; };
  tip.addEventListener("pointerenter", () => { tipHeld = true; clearTimeout(tipTimer); });
  tip.addEventListener("pointerleave", () => { tipHeld = false; clearTimeout(tipTimer); tipTimer = setTimeout(() => { if (hover < 0 && !tipHeld) hideTip(); }, 350); });
  tip.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  // the title opens the note the other way from a double-click: in a tab when that opens beside, and beside when it opens in a tab
  // the title opens the note beside (a double-click on the node opens it in a tab); Ctrl+click: in a tab
  tip.addEventListener("click", (e) => { if (e.target.closest(".gx-tip-title") && tipNode >= 0) { const i = tipNode; hideTip(); if (e.ctrlKey || e.metaKey) openNode(i, true); else openSide(i); } });
  // its text can be selected; a double-click on it opens the note in a tab
  tip.addEventListener("dblclick", (e) => { if (e.target.closest(".gx-tip-body") && tipNode >= 0) { const i = tipNode; hideTip(); openNode(i, true); } });
  function showTip(i) {
    tipNode = i;
    tipHeld = false;
    fillTip(i);
    tip.hidden = false;
    // measured once per card, so following a moving node never forces layout
    tipW = tip.offsetWidth;
    tipH = tip.offsetHeight;
    placeTip();
  }

  // the card sits beside the node, clear of the node's own label
  function placeTip() {
    const at = hover >= 0 ? hover : tipNode;
    if (at < 0 || tipHeld) return; // a card under the pointer holds still
    const tw = tipW;
    const th = tipH;
    const nx = L.x[at] * cam.k + W / 2 + cam.x;
    const ny = L.y[at] * cam.k + H / 2 + cam.y;
    const half = strongWidths[at] > 0 ? strongWidths[at] / 2 : 30;
    const gap = Math.max(rad[at] * cam.k + (S.tipGap || 16), half + 12);
    let left = nx + gap;
    if (left + tw > W - 10) left = nx - gap - tw;
    const top = clampNum(ny - 22, 10, H - th - 10);
    tip.style.transform = `translate(${Math.round(Math.max(10, left))}px, ${Math.round(top)}px)`;
  }

  function fillTip(i) {
    const nd = G.nodes[i];
    const kids = [];
    const kindIcon = nd.kind === "note" ? "fileText" : nd.kind === "file" ? "image" : nd.kind === "tag" ? "hash" : "link";
    kids.push(h("div", { class: "gx-tip-title", title: "Click: open beside · Ctrl+click: in a tab" }, icon(kindIcon), h("span", { text: nd.label }), h("kbd", { class: "gx-tip-alt", title: "Alt+click a node on the graph opens it beside, the graph staying where it is", text: "Alt+click: beside" })));
    if (nd.folder) kids.push(h("div", { class: "gx-tip-path" }, icon("folder"), h("span", { text: nd.folder })));
    if (nd.kind === "note") {
      const note = vault.get(nd.id);
      kids.push(h("div", { class: "gx-tip-tags" }, nd.tags.slice(0, 6).map((t) => h("span", { class: "gx-tag", text: "#" + t })), nd.tags.length > 6 ? h("span", { class: "gx-tag is-more", text: `+${nd.tags.length - 6}` }) : null,
        h("button", { class: "gx-tag is-add", title: "Add a tag - tags that suit the note show first", onclick: (e) => {
          if (!app.noteIds) return;
          const field = app.noteIds.tagField(nd.id, { autofocus: true, onAdded: (r) => { undoable(`Tagged #${r.tag}`, () => { const n2 = vault.notes.get(nd.id); if (n2 && n2.content === r.next) vault.write(nd.id, r.prev, { expected: true }); }); hideTip(); } });
          e.currentTarget.replaceWith(field);
          setTimeout(() => { tipH = tip.offsetHeight; });
        } }, "+ tag")));
      const ex = note ? excerpt(note.content, tip.classList.contains("is-full") ? 20000 : 900) : "";
      kids.push(h("div", { class: "gx-tip-body" + (ex ? "" : " is-empty"), title: "Double-click to open it in a tab", text: ex || "Empty note" }));
      const list = h("div", { class: "gx-tip-links", hidden: true });
      const show = (dir) => {
        if (!list.hidden && list.dataset.dir === dir) { list.hidden = true; tipH = tip.offsetHeight; return; }
        list.dataset.dir = dir;
        paintTipLinks(i, dir, list);
        list.hidden = false;
        tipH = tip.offsetHeight;
      };
      kids.push(h("div", { class: "gx-tip-meta" },
        h("button", { class: "gx-tip-lk", title: "Show its links - add or remove one", onclick: () => show("out") }, icon("arrowUp"), plural(nd.out, "link")),
        h("button", { class: "gx-tip-lk", title: "Show the notes that link here", onclick: () => show("in") }, icon("arrowDown"), plural(nd.inn, "backlink")),
        pins.has(nd.id) ? h("span", {}, icon("pin"), "Pinned") : null,
        h("span", { class: "fit-fill" }),
        h("button", { class: "gx-tip-lk", title: "All of the note's text in the card, or the start of it again", onclick: () => { tip.classList.toggle("is-full"); fillTip(i); tipW = tip.offsetWidth; tipH = tip.offsetHeight; placeTip(); } }, tip.classList.contains("is-full") ? "Less" : "All")),
        list);
    } else if (nd.kind === "file") {
      kids.push(h("div", { class: "gx-tip-body", text: `${nd.fileKind ? nd.fileKind[0].toUpperCase() + nd.fileKind.slice(1) : "File"} attachment` }));
      kids.push(h("div", { class: "gx-tip-meta" }, h("span", {}, icon("link"), `Used in ${plural(nd.refs, "note")}`)));
    } else if (nd.kind === "tag") {
      kids.push(h("div", { class: "gx-tip-meta" }, h("span", {}, icon("fileText"), plural(nd.refs, "note"))));
    } else {
      kids.push(h("div", { class: "gx-tip-body", text: "Not created yet. Right-click to create it." }));
      kids.push(h("div", { class: "gx-tip-meta" }, h("span", {}, icon("link"), `Linked from ${plural(nd.refs, "note")}`)));
    }
    tip.replaceChildren(...kids);
  }

  /* comment frames under the pointer: resize edges, header, body */
  function frameAt(wx, wy) {
    const k = cam.k;
    const edge = 6 / k;
    const big = FRAME_HEAD * k < BIG_TITLE;
    for (let t = frames.length - 1; t >= 0; t--) {
      const f = frames[t];
      const r = f.x + f.w;
      const b = f.y + f.h;
      if (wx < f.x - edge || wx > r + edge || wy < f.y - edge || wy > b + edge) continue;
      // the four corners resize both ways, the four edges between them one way
      const g = Math.min(14 / k, f.w / 3, f.h / 3);
      const onL = Math.abs(wx - f.x) <= edge, onR = Math.abs(wx - r) <= edge, onT = Math.abs(wy - f.y) <= edge, onB = Math.abs(wy - b) <= edge;
      const nearL = wx < f.x + g, nearR = wx > r - g, nearT = wy < f.y + g, nearB = wy > b - g;
      if (((onT || onB) && (nearL || nearR)) || ((onL || onR) && (nearT || nearB))) return { f, part: (onT || nearT ? "n" : "s") + (onL || nearL ? "w" : "e") };
      if (onR) return { f, part: "e" };
      if (onB) return { f, part: "s" };
      if (onL) return { f, part: "w" };
      if (onT) return { f, part: "n" };
      const tb = f._tb;
      if (big ? tb && wx >= tb[0] && wx <= tb[2] && wy >= tb[1] && wy <= tb[3] : wy <= f.y + Math.min(f.h, Math.max(FRAME_HEAD, 16 / k))) return { f, part: "head" };
      if (wx >= f.x && wx <= r && wy >= f.y && wy <= b) return { f, part: "body" };
    }
    return null;
  }

  const CURSORS = { head: "move", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", e: "ew-resize", w: "ew-resize", n: "ns-resize", s: "ns-resize" };
  function setCursor(c) {
    if (c !== cursor) { cursor = c; canvas.style.cursor = c; }
  }
  // the link being made, drawn as the lens draws its own: see drawMarks
  const SVGNS = "http://www.w3.org/2000/svg";
  const linkWire = document.createElementNS(SVGNS, "svg");
  linkWire.setAttribute("class", "gx-link-wire");
  linkWire.innerHTML = '<defs><marker id="gx-wire-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"><path d="M0 0.8L9.5 5L0 9.2z" fill="var(--accent)"/></marker></defs><path/>';
  const linkWirePath = linkWire.lastElementChild;
  wrap.append(linkWire);
  let linkPtr = null; // where the pointer is, in the graph's own space, while a link is being made
  function hoverAt(w) {
    if (picking && picking.link) { linkPtr = { x: w.x, y: w.y }; kick(); } else linkPtr = null;
    const i = pickAt(w.x, w.y);
    setHover(i);
    const hit = i < 0 && frames.length ? frameAt(w.x, w.y) : null;
    const fid = hit && hit.part !== "body" ? hit.f.id : null;
    if (fid !== frameHover) { frameHover = fid; kick(); }
    const he = i < 0 && !fid && n ? edgeAt(w) : -1;
    if (he !== hoverEdge) { hoverEdge = he; kick(); }
    const hk = hList.length && !fid ? homeAt(w.x, w.y) : -1;
    if (hk !== hHover) { hHover = hk; kick(); }
    bumpShips(w);
    homeCardSoon(i < 0 && !drag ? hk : -1);
    setCursor(i >= 0 ? "pointer" : hit && CURSORS[hit.part] ? CURSORS[hit.part] : picking ? "crosshair" : "");
  }

  function nodesIn(f, visibleOnly) {
    const out = [];
    const x1 = f.x + f.w;
    const y1 = f.y + f.h;
    for (let i = 0; i < n; i++) {
      if (visibleOnly && !vis[i]) continue;
      const x = L.x[i];
      const y = L.y[i];
      if (x >= f.x && x <= x1 && y >= f.y && y <= y1) out.push(i);
    }
    return out;
  }

  // Dragging a header carries every node whose centre is inside, and any
  // frame wholly inside, the way Unreal's comment boxes do.
  function startFrameDrag(hit, w, e) {
    const f = hit.f;
    frameSel = f.id;
    const d = { kind: "frame", f, part: hit.part, sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y, fx: f.x, fy: f.y, fw: f.w, fh: f.h, moved: false };
    if (hit.part === "head") {
      d.nodes = nodesIn(f, false);
      d.nx = Float64Array.from(d.nodes, (i) => L.x[i]);
      d.ny = Float64Array.from(d.nodes, (i) => L.y[i]);
      d.kids = frames.filter((g) => g !== f && g.x >= f.x && g.y >= f.y && g.x + g.w <= f.x + f.w && g.y + g.h <= f.y + f.h).map((g) => [g, g.x, g.y]);
      // homes anchored inside travel along
      d.homes = hList.map((hm, k) => [k, hm.x, hm.y]).filter(([, x, y]) => inFrame(f, x, y));
    }
    drag = d;
    kick();
  }

  function moveFrame(d, w) {
    const f = d.f;
    const dx = w.x - d.wx;
    const dy = w.y - d.wy;
    if (d.part === "head") {
      f.x = Math.round(d.fx + dx);
      f.y = Math.round(d.fy + dy);
      const mx = f.x - d.fx;
      const my = f.y - d.fy;
      for (let t = 0; t < d.nodes.length; t++) {
        const j = d.nodes[t];
        L.x[j] = d.nx[t] + mx;
        L.y[j] = d.ny[t] + my;
        L.vx[j] = 0;
        L.vy[j] = 0;
      }
      for (const [g, gx, gy] of d.kids) { g.x = gx + mx; g.y = gy + my; }
      for (const [k, hx, hy] of d.homes) moveHomeTo(k, hx + mx, hy + my);
      if (d.nodes.length) gridStale = true;
      return;
    }
    const minW = 120;
    const minH = FRAME_HEAD + 32;
    // the sides the grabbed part names (n, s, e, w; a corner two of them) move; the others stay
    const side = (c) => d.part.length <= 2 && d.part.includes(c);
    if (side("e")) f.w = Math.max(minW, Math.round(d.fw + dx));
    if (side("s")) f.h = Math.max(minH, Math.round(d.fh + dy));
    if (side("w")) { const nw = Math.max(minW, Math.round(d.fw - dx)); f.x = d.fx + d.fw - nw; f.w = nw; }
    if (side("n")) { const nh = Math.max(minH, Math.round(d.fh - dy)); f.y = d.fy + d.fh - nh; f.h = nh; }
  }

  function endFrameDrag(d) {
    if (!d.moved) return;
    // what sits inside stays put: pinned, so the layout cannot pull it out;
    // a home anchored inside holds its own notes softly instead
    const list = d.part === "head" ? d.nodes : nodesIn(d.f, false);
    for (const j of list) {
      if (homedIn(d.f, j)) { refix(j); continue; }
      pins.add(G.nodes[j].id);
      L.fixed[j] = 1;
    }
    syncPins();
    if (d.part === "head" && list.length) { alphaTarget = 0; heat(0.12); }
    touch();
    renderPanel();
  }

  const inFrame = (f, x, y) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h;
  const homedIn = (f, j) => homeIdx[j] >= 0 && inFrame(f, hList[homeIdx[j]].x, hList[homeIdx[j]].y);

  function contextMenuAt(e) {
    menuAt = performance.now();
    const w = toWorld(e);
    mouseW = w;
    const i = pickAt(w.x, w.y);
    tip.hidden = true;
    if (i >= 0) return nodeMenu(i, e.clientX, e.clientY);
    const ed = edgeAt(w);
    if (ed >= 0) return edgeMenu(ed, e.clientX, e.clientY);
    const hit = frames.length ? frameAt(w.x, w.y) : null;
    if (hit && hit.part !== "body") return frameMenu(hit.f, e.clientX, e.clientY);
    const hk = hList.length ? homeAt(w.x, w.y) : -1;
    if (hk >= 0) return homeMenu(hk, e.clientX, e.clientY);
    if (hit) return frameMenu(hit.f, e.clientX, e.clientY);
    backgroundMenu(e.clientX, e.clientY, w);
  }

  // Left: a node moves it, a frame header moves the frame, empty canvas draws
  // a selection box. Right or middle: pan; a right click that did not move
  // opens the menu for whatever is under it.
  canvas.addEventListener("pointerdown", (e) => {
    if (!G) return;
    wrap.focus({ preventScroll: true });
    helpEl.hidden = true;
    const w = toWorld(e);
    mouseW = w;
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    tip.hidden = true;
    if (e.button === 1 || e.button === 2) {
      if (e.button === 1) e.preventDefault(); // no autoscroll
      // right-dragging a home's ground (not a note) carries the home; a right-click alone still opens the menu
      const hk = e.button === 2 && hList.length && pickAt(w.x, w.y) < 0 ? homeAt(w.x, w.y) : -1;
      drag = { kind: "pan", button: e.button, sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false, homeK: hk, w0: w };
      return;
    }
    if (e.button !== 0) return;
    const grab = shipUnder(w);
    if (grab) { drag = { kind: "ship", sh: grab, sx: e.clientX, sy: e.clientY, moved: false }; return; }
    const i = pickAt(w.x, w.y);
    if (picking && i >= 0) { picking.link ? finishLink(i, e) : finishPick(i); return; }
    // in link mode a click on nothing means "never mind"
    if (picking && picking.link) { cancelPick(); return; }
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
    if (i >= 0) {
      // Alt-drag a homed note, or drag a core on its own: the home moves
      const hk = homeIdx[i];
      if (e.altKey) { drag = { kind: "side", i, sx: e.clientX, sy: e.clientY, moved: false, homeK: hk, w0: w }; return; }
      const group = selMask[i] && !toggle ? selIdx.slice() : [i];
      const core = hk >= 0 && group.length === 1 && hCore[hk] === i ? hk : -1;
      drag = { kind: "node", i, group, off: group.map((j) => [L.x[j] - w.x, L.y[j] - w.y]), sx: e.clientX, sy: e.clientY, moved: false, toggle, homeK: core, w0: w, c0: centroid(group) };
      return;
    }
    const hit = frames.length ? frameAt(w.x, w.y) : null;
    if (hit && hit.part !== "body") { startFrameDrag(hit, w, e); return; }
    drag = { kind: "box", sx: e.clientX, sy: e.clientY, x0: w.x, y0: w.y, px: w.sx, py: w.sy, base: new Set(toggle ? selected : []), moved: false, toggle, less: e.ctrlKey || e.metaKey, frame: hit ? hit.f.id : null };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!G) return;
    const w = toWorld(e);
    mouseW = w;
    if (lens.on) lens.moved(w.sx, w.sy); // the ring follows even while panning
    if (!drag) {
      hoverAt(w);
      syncProxy(e);
      return;
    }
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      autoFit = false;
      if (drag.homeK >= 0 && (drag.kind === "node" || drag.kind === "side" || drag.kind === "pan")) drag = homeDrag(drag);
      if (held.length < n) held = new Uint8Array(Math.max(n, rad.length));
      if (drag.kind === "node") {
        for (const j of drag.group) { L.fixed[j] = 1; held[j] = 1; }
        alphaTarget = 0.12;
        heat(0.12);
        setHover(-1);
      } else if (drag.kind === "home") {
        for (const j of drag.list) L.fixed[j] = 1;
        alphaTarget = 0.06;
        heat(0.06);
        setHover(-1);
      } else if (drag.kind === "frame" && drag.part === "head" && drag.nodes.length) {
        for (const j of drag.nodes) L.fixed[j] = 1;
        alphaTarget = 0.08;
        heat(0.08);
        setHover(-1);
      } else if (drag.kind === "pan") {
        canvas.classList.add("is-panning");
        setCursor("");
      }
    }
    if (drag.kind === "node") {
      for (let t = 0; t < drag.group.length; t++) {
        const j = drag.group[t];
        L.x[j] = w.x + drag.off[t][0];
        L.y[j] = w.y + drag.off[t][1];
        L.vx[j] = 0;
        L.vy[j] = 0;
      }
      gridStale = true;
      kick();
    } else if (drag.kind === "ship") {
      drag.sh.held = { x: w.x, y: w.y };
      kick();
    } else if (drag.kind === "home") {
      const mx = w.x - drag.w0.x;
      const my = w.y - drag.w0.y;
      moveHomeTo(drag.k, drag.hx + mx, drag.hy + my);
      for (let t = 0; t < drag.list.length; t++) {
        const j = drag.list[t];
        L.x[j] = drag.nx[t] + mx;
        L.y[j] = drag.ny[t] + my;
        L.vx[j] = 0;
        L.vy[j] = 0;
      }
      gridStale = true;
      kick();
    } else if (drag.kind === "frame") {
      moveFrame(drag, w);
      kick();
    } else if (drag.kind === "pan") {
      autoFit = false;
      tween = null;
      cam.x = drag.cx + dx;
      cam.y = drag.cy + dy;
      kick();
    } else if (drag.kind === "box") {
      boxEl.hidden = false;
      boxEl.style.left = Math.min(drag.px, w.sx) + "px";
      boxEl.style.top = Math.min(drag.py, w.sy) + "px";
      boxEl.style.width = Math.abs(w.sx - drag.px) + "px";
      boxEl.style.height = Math.abs(w.sy - drag.py) + "px";
      if (gridStale) pickAt(0, 0);
      selected.clear();
      for (const id of drag.base) selected.add(id);
      // Shift adds what the box holds, Ctrl takes it away
      for (const i of grid.rect(drag.x0, drag.y0, w.x, w.y, vis)) { if (drag.less) selected.delete(G.nodes[i].id); else selected.add(G.nodes[i].id); }
      syncSelection();
      kick();
    }
  });

  // the whole home follows the pointer, shape and all
  function homeDrag(d) {
    const k = d.homeK;
    const list = Array.from(hMembers[k]);
    return {
      kind: "home", k, list, w0: d.w0, sx: d.sx, sy: d.sy, moved: true, button: d.button,
      hx: hList[k].x, hy: hList[k].y,
      nx: Float64Array.from(list, (j) => L.x[j]), ny: Float64Array.from(list, (j) => L.y[j]),
    };
  }

  function endDrag(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove("is-panning");
    boxEl.hidden = true;
    if (held.length) held.fill(0);
    if (d.button === 2 && d.moved) menuAt = performance.now(); // a right-drag is not a right-click
    if (d.kind === "ship") {
      const sh = d.sh, p = sh.held;
      sh.held = null;
      if (p) { sh.to = `p:${Math.round(p.x)},${Math.round(p.y)}`; sh.t = 1; sh.ox = sh.oy = 0; sh.wait = performance.now() + 1200; sh.bubble = false; }
      kick();
      return;
    }
    if (d.kind === "home") {
      const c = centroid(d.list);
      const into = homeAt(c.x, c.y, 20 / cam.k, d.k);
      if (into >= 0 && d.k < hList.length) { mergeHome(d.k, into); return; }
      for (const j of d.list) refix(j);
      alphaTarget = 0;
      heat(0.08);
      touch();
      kick();
      return;
    }
    if (e.type === "pointercancel") {
      if (d.kind === "node" || d.kind === "frame") alphaTarget = 0;
      if (d.kind === "node" && d.moved) for (const j of d.group) refix(j);
      if (d.kind === "frame") endFrameDrag(d);
      kick();
      return;
    }
    if (d.kind === "node") {
      if (d.moved) {
        if (!dropHome(d.group, d.c0)) {
          // a dropped note goes back to the live pool unless dragging is set to
          // pin; one that was pinned already stays pinned where it lands
          for (const j of d.group) { if (S.dragPins) pins.add(G.nodes[j].id); refix(j); }
          syncPins();
          alphaTarget = 0;
          heat(0.2);
          touch();
        }
        hoverAt(toWorld(e));
      } else if (d.toggle) {
        const id = G.nodes[d.i].id;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        syncSelection();
      } else {
        selected.clear();
        selected.add(G.nodes[d.i].id);
        frameSel = null;
        syncSelection();
      }
    } else if (d.kind === "side") {
      if (!d.moved) openSide(d.i);
    } else if (d.kind === "frame") {
      endFrameDrag(d);
    } else if (d.kind === "pan") {
      if (d.moved) saveDirty = true;
      else if (d.button === 2) contextMenuAt(e);
    } else if (d.kind === "box" && !d.moved) {
      // a click on the canvas clears the selection and picks a frame's body
      if (!d.toggle && selected.size) { selected.clear(); syncSelection(); }
      if (frameSel !== d.frame) { frameSel = d.frame; renderFrameList(); }
    }
    kick();
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", (e) => {
    if (drag || e.relatedTarget === proxy) return;
    // the lens keeps its own watch on the whole view, cards included
    setHover(-1);
    if (frameHover) { frameHover = null; kick(); }
  });
  // the middle button would start autoscroll or paste on some systems
  canvas.addEventListener("auxclick", (e) => e.preventDefault());

  // the card's links (dir "out") or backlinks ("in"): each opens where it is, and can be taken out
  function paintTipLinks(i, dir, list) {
    const rows = [];
    for (let e = 0; e < m; e++) {
      const a = G.src[e], b = G.dst[e];
      const other = dir === "out" ? (a === i ? b : -1) : (b === i ? a : -1);
      if (other < 0) continue;
      const on = G.nodes[other];
      const from = dir === "out" ? G.nodes[i].id : on.id, to = dir === "out" ? on.id : G.nodes[i].id;
      rows.push(h("div", { class: "gx-tip-lrow" },
        h("button", { class: "gx-tip-lname", title: "Go to it in the graph", onclick: () => { hideTip(); selected.clear(); selected.add(on.id); syncSelection(); centreOn(other); kick(); } }, icon(on.kind === "note" ? "fileText" : on.kind === "tag" ? "hash" : "link"), h("span", { text: on.label })),
        on.kind === "tag" ? null : h("button", { class: "gx-tip-lx", title: "Remove this link", onclick: () => unlinkAsk(from, to) }, icon("x"))));
    }
    if (!rows.length) rows.push(h("div", { class: "gx-hint", text: dir === "out" ? "No links yet." : "Nothing links here yet." }));
    if (dir === "out") rows.push(h("button", { class: "gx-chip", onclick: () => { hideTip(); startLink(i, false); } }, icon("plus"), "Link to another note…"));
    list.replaceChildren(...rows);
  }
  // a link taken out of the note that writes it: [[Target]] becomes its words; undoable. `both`: the link back goes too
  async function unlinkAsk(from, to, both = false) {
    const { confirmDialog } = await import("./ui.js");
    const A = basename(from).replace(/\.md$/i, ""), B = basename(to).replace(/\.md$/i, "");
    if (!(await confirmDialog(both ? "Remove both links?" : "Remove the link?", both ? `‘${A}’ and ‘${B}’ stop linking to each other. The words stay; only the links go.` : `‘${A}’ stops linking to ‘${B}’. The words stay; only the link goes.`, { ok: "Remove" }))) return;
    await unlink(from, to);
    if (both) await unlink(to, from);
  }
  async function unlink(from, to) {
    const note = vault.notes.get(from);
    if (!note) return;
    const prev = note.content;
    const isTo = (t) => vault.resolve(t.trim(), from) === to;
    const out = [];
    for (const line of prev.split("\n")) {
      const only = /^\s*(?:[-*+]|\d+[.)])\s+\[\[([^\]|#]+)[^\]]*\]\]\s*$/.exec(line);
      if (only && isTo(only[1])) continue; // a list entry that was just the link (Connections)
      const rel = /^(\s*(?:related|see also)\s*:\s*)(.*)$/i.exec(line);
      if (rel) {
        const keep = rel[2].split("·").map((x) => x.trim()).filter((x) => { const m2 = /^\[\[([^\]|#]+)/.exec(x); return x && !(m2 && isTo(m2[1])); });
        if (keep.length) out.push(rel[1] + keep.join(" · "));
        continue;
      }
      out.push(line.replace(/(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (all, bang, t, _h, alias) => !bang && isTo(t) ? (alias || basename(t.trim())) : all));
    }
    const next = out.join("\n");
    if (next === prev) return app.toast("That link is not written as [[…]] in the note - open it to change it", { ms: 4000 });
    try { await vault.write(from, next, { expected: true }); } catch (err) { return app.toast("Could not change the note: " + err, { kind: "error" }); }
    undoable(`Unlinked ‘${basename(from).replace(/\.md$/i, "")}’ → ‘${basename(to).replace(/\.md$/i, "")}’`, () => { const n2 = vault.notes.get(from); if (n2 && n2.content === next) vault.write(from, prev, { expected: true }); });
  }
  const segD2 = (x0, y0, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x0 - ax) * dx + (y0 - ay) * dy) / l2));
    const px = ax + t * dx - x0, py = ay + t * dy - y0;
    return px * px + py * py;
  };
  // the link under the pointer (within a few pixels), for its own menu
  function edgeAt(w) {
    const tol = 6 / cam.k;
    let best = -1, bd = tol * tol;
    for (let e = 0; e < m; e++) {
      const a = G.src[e], b = G.dst[e];
      if (!vis[a] || !vis[b]) continue;
      if (bowed(e)) {
        // a bowed bridge: the curve in a dozen straight pieces
        const q = bowOf(e);
        let px = L.x[q.a], py = L.y[q.a];
        for (let s2 = 1; s2 <= 12; s2++) {
          const t = s2 / 12, u = 1 - t;
          const nx = u * u * L.x[q.a] + 2 * u * t * q.cx + t * t * L.x[q.b], ny = u * u * L.y[q.a] + 2 * u * t * q.cy + t * t * L.y[q.b];
          const d2 = segD2(w.x, w.y, px, py, nx, ny);
          if (d2 < bd) { bd = d2; best = e; }
          px = nx; py = ny;
        }
        continue;
      }
      const d2 = segD2(w.x, w.y, L.x[a], L.y[a], L.x[b], L.y[b]);
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  }
  function edgeMenu(e, x, y) {
    const a = G.src[e], b = G.dst[e], na = G.nodes[a], nb = G.nodes[b];
    const ab = linksTo(na.id, nb.id), ba = linksTo(nb.id, na.id);
    const [from, to] = ab || !ba ? [na, nb] : [nb, na];
    const notes = na.kind === "note" && nb.kind === "note";
    app.menu(x, y, [
      { header: `${from.label} ${ab && ba ? "↔" : "→"} ${to.label}`, plain: true },
      { label: `Open ‘${from.label}’ beside`, icon: "columns", run: () => openSide(from === na ? a : b) },
      { label: `Open ‘${to.label}’ beside`, icon: "columns", run: () => openSide(to === na ? a : b) },
      { label: "Select both", icon: "check", run: () => { selected.clear(); selected.add(na.id); selected.add(nb.id); syncSelection(); kick(); } },
      notes && !(ab && ba) ? { label: `Link back too (‘${to.label}’ → ‘${from.label}’)`, icon: "link", run: () => lens.linkTo(to.id, from.id, false) } : null,
      "sep",
      linksTo(from.id, to.id) ? { label: `Remove the link from ‘${from.label}’…`, icon: "x", danger: true, run: () => unlinkAsk(from.id, to.id) } : null,
      ab && ba ? { label: `Remove the link from ‘${to.label}’…`, icon: "x", danger: true, run: () => unlinkAsk(to.id, from.id) } : null,
      ab && ba ? { label: "Remove both links…", icon: "x", danger: true, run: () => unlinkAsk(from.id, to.id, true) } : null,
    ]);
  }
  canvas.addEventListener("dblclick", (e) => {
    const w = toWorld(e);
    const i = pickAt(w.x, w.y);
    if (i >= 0) return e.ctrlKey || e.metaKey ? openNode(i, true) : S.dblSide ? openSide(i) : openNode(i, false);
    const hit = frames.length ? frameAt(w.x, w.y) : null;
    if (hit && hit.part === "head") editFrame(hit.f, "title");
    else if (hit) flyToFrame(hit.f);
    else fit();
  });

  // Wheel zooms at the cursor; Shift+wheel, or a sideways trackpad swipe, pans.
  canvas.addEventListener("wheel", (e) => {
    // Ctrl+wheel too: the graph zooms, never the whole window
    e.preventDefault();
    if (editing) editing.input.blur();
    autoFit = false;
    tween = null;
    tip.hidden = true;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.shiftKey) pan(-(dx || dy), 0);
    else if (Math.abs(dx) > Math.abs(dy)) pan(-dx, 0);
    else {
      const r = canvas.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      zoomAt(f, e.clientX - r.left - W / 2, e.clientY - r.top - H / 2, cam);
      saveDirty = true;
    }
    kick();
  }, { passive: false });

  // the menu opens on release (see endDrag), so a right-drag can pan; this
  // catches the keyboard menu key and systems that fire it on press
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!G || drag || performance.now() - menuAt < 500) return;
    contextMenuAt(e);
  });

  /* ── dragging a selection out (to a board, a note, anywhere) ─────────── */
  // A canvas drag is not a DOM drag, so with Alt held a draggable proxy sits
  // under the cursor over a selected node; the selection bar has a handle too.
  function syncProxy(e) {
    const on = e.altKey && hover >= 0 && selMask[hover] && selected.size > 0;
    if (!on) { proxy.hidden = true; return; }
    const s = Math.max(22, rad[hover] * cam.k * 2 + 8);
    proxy.hidden = false;
    proxy.style.width = proxy.style.height = s + "px";
    proxy.style.transform = `translate(${Math.round(L.x[hover] * cam.k + W / 2 + cam.x - s / 2)}px, ${Math.round(L.y[hover] * cam.k + H / 2 + cam.y - s / 2)}px)`;
  }
  proxy.addEventListener("pointerleave", () => { proxy.hidden = true; });
  proxy.addEventListener("wheel", () => { proxy.hidden = true; });
  window.addEventListener("keyup", (e) => { if (e.key === "Alt") proxy.hidden = true; });
  // pressing Alt over a selected node, without moving, arms the drag too
  window.addEventListener("keydown", (e) => { if (e.key === "Alt" && !off() && !drag && hover >= 0) syncProxy(e); });

  function dragPaths() {
    return selIdx.filter((i) => G.nodes[i].kind === "note" || G.nodes[i].kind === "file").map((i) => G.nodes[i].id);
  }

  function startDragOut(e) {
    const paths = dragPaths();
    if (!paths.length) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = "copyLink";
    e.dataTransfer.setData("application/x-leonote-paths", JSON.stringify(paths));
    e.dataTransfer.setData("text/plain", paths.map((p) => (vault.notes.has(p) ? `[[${vault.linkText(p)}]]` : p)).join("\n"));
    dragChip.textContent = paths.length === 1 ? basename(paths[0]) : `${paths.length} notes`;
    e.dataTransfer.setDragImage(dragChip, -12, -8);
    tip.hidden = true;
  }
  proxy.addEventListener("dragstart", startDragOut);
  proxy.addEventListener("dragend", () => { proxy.hidden = true; });
  proxy.addEventListener("click", () => { proxy.hidden = true; if (hover >= 0) openSide(hover); });

  /* ── actions ─────────────────────────────────────────────────────────── */
  async function openNode(i, newTab) {
    const nd = G.nodes[i];
    if (nd.kind === "note") app.openNote(nd.id, { newTab });
    else if (nd.kind === "file") { if (app.openFile) app.openFile(nd.id, { newTab }); }
    else if (nd.kind === "tag") setQuery(nd.label);
    else if (nd.kind === "ghost") createGhost(nd, newTab);
  }

  async function createGhost(nd, newTab) {
    const t = nd.label;
    const dir = t.includes("/") ? dirname(t) : "";
    try {
      if (dir && !vault.folders.has(dir)) await vault.createFolder(dir).catch(() => {});
      const p = await vault.create(dir, basename(t), "");
      app.openNote(p, { newTab });
    } catch (err) {
      app.toast("Could not create the note: " + err, { kind: "error" });
    }
  }

  function selectedNotes() {
    return selIdx.filter((i) => G.nodes[i].kind === "note");
  }

  function boardNotes(list) {
    const pts = boardPlacement(list.map((i) => ({ x: L.x[i], y: L.y[i] })));
    return list.map((i, t) => ({ path: G.nodes[i].id, x: pts[t].x, y: pts[t].y }));
  }

  function boardTitle(list) {
    const focus = S.scope === "around" && G.focus >= 0 && list.includes(G.focus) ? G.nodes[G.focus].label : null;
    const top = list.slice().sort((a, b) => G.nodes[b].deg - G.nodes[a].deg).map((i) => G.nodes[i].label);
    return boardName(top, focus);
  }

  const BOARD_ASK = 80;

  async function openAsBoard(list = selectedNotes(), sure = false, name = "") {
    if (!app.newBoard) return app.toast("Research boards are not available in this version yet");
    if (!list.length) return app.toast("Select some notes first");
    // a board is for reading side by side: a huge one is rarely meant
    if (list.length > BOARD_ASK && !sure) {
      return app.toast(`Put ${list.length.toLocaleString()} notes on one board?`, { action: { label: "Create board", run: () => openAsBoard(list, true, name) }, ms: 8000 });
    }
    await app.newBoard({ name: name && name !== "Comment" ? name : boardTitle(list), notes: boardNotes(list) });
  }

  function boardMenu(x, y, list = selectedNotes()) {
    if (!app.newBoard || !app.addToBoard || !app.boards) return app.toast("Research boards are not available in this version yet");
    if (!list.length) return app.toast("Select some notes first");
    const boards = app.boards() || [];
    const name = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.canvas$/i, "");
    app.menu(x, y, [
      { header: `Add ${plural(list.length, "note")} to` },
      ...boards.slice(0, 24).map((p) => ({ label: name(p), icon: "grid", run: () => app.addToBoard(p, boardNotes(list)) })),
      boards.length ? "sep" : null,
      { label: "New board", icon: "plus", run: () => openAsBoard(list) },
    ]);
  }

  function openInTabs(list = selectedNotes()) {
    const paths = list.map((i) => G.nodes[i].id);
    const go = (ps) => { for (const p of ps) app.openNote(p, { newTab: true, focus: false }); };
    if (!paths.length) return;
    if (paths.length > MAX_TABS) {
      app.toast(`${paths.length} notes selected. Open the first ${MAX_TABS} in tabs?`, { action: { label: `Open ${MAX_TABS}`, run: () => go(paths.slice(0, MAX_TABS)) }, ms: 8000 });
      return;
    }
    go(paths);
  }

  function openSelection(newTab) {
    const list = selectedNotes();
    if (list.length === 1) return app.openNote(G.nodes[list[0]].id, { newTab });
    if (list.length > 1) return openInTabs(list);
    if (selIdx.length === 1) return openNode(selIdx[0], newTab);
    if (matchAt >= 0 && matches[matchAt] !== undefined) return openNode(matches[matchAt], newTab);
  }

  function expandSelection() {
    for (const i of selIdx.slice()) for (let k = G.start[i]; k < G.start[i + 1]; k++) if (vis[G.adj[k]]) selected.add(G.nodes[G.adj[k]].id);
    syncSelection();
    kick();
  }

  function selectNeighbours(i) {
    selected.add(G.nodes[i].id);
    for (let k = G.start[i]; k < G.start[i + 1]; k++) if (vis[G.adj[k]]) selected.add(G.nodes[G.adj[k]].id);
    syncSelection();
    kick();
  }

  function selectAll() {
    for (let i = 0; i < n; i++) if (vis[i]) selected.add(G.nodes[i].id);
    syncSelection();
    kick();
  }

  function clearSelection() {
    selected.clear();
    syncSelection();
    kick();
  }

  function focusSelection() {
    if (!selected.size) return;
    remember();
    only = new Set(selected);
    autoFit = true;
    rebuild();
  }

  function exitFocusSelection() {
    remember();
    only = null;
    autoFit = true;
    rebuild();
  }

  function focusOn(id) {
    if (focusId !== id) remember();
    focusId = id;
    if (S.scope !== "around") set("scope", "around");
    autoFit = true;
    rebuild();
    renderPanel();
  }

  function stepBack() {
    if (crumbs.length < 2) return;
    crumbs.pop();
    focusOn(crumbs[crumbs.length - 1]);
  }

  function togglePin(i) {
    const id = G.nodes[i].id;
    if (pins.has(id)) {
      pins.delete(id);
      L.fixed[i] = S.scope === "around" && i === G.focus ? 1 : 0;
      heat(0.25);
    } else {
      pins.add(id);
      L.fixed[i] = 1;
    }
    syncPins();
    kick();
  }

  function unpinAll() {
    const was = [...pins];
    if (was.length) undoable(`${plural(was.length, "note")} unpinned`, () => { for (const id of was) pins.add(id); for (let i = 0; i < n; i++) refix(i); syncPins(); heat(0.2); renderPanel(); });
    pins.clear();
    for (let i = 0; i < n; i++) L.fixed[i] = S.scope === "around" && i === G.focus ? 1 : 0;
    syncPins();
    heat(0.4);
    renderPanel();
  }

  function hideNode(i) {
    const id = G.nodes[i].id;
    hidden.add(id);
    selected.delete(id);
    rebuild();
    renderPanel();
  }

  function reheat() {
    heat(1);
  }

  /* ── research: opening to the side ───────────────────────────────────── */
  // app.openSplit shows a note or file next to the current view where the
  // split view exists; otherwise a background tab does
  function openSidePath(p, kind) {
    if (app.openSplit) return app.openSplit(p);
    if (kind === "note") app.openNote(p, { newTab: true });
    else if (app.openFile) app.openFile(p, { newTab: true });
  }

  function openSide(i) {
    const nd = G.nodes[i];
    if (nd.kind === "note" || nd.kind === "file") openSidePath(nd.id, nd.kind);
    else openNode(i, true);
  }

  function openSideBySide(list = selIdx.filter((i) => G.nodes[i].kind === "note" || G.nodes[i].kind === "file")) {
    if (!list.length) return app.toast("Select some notes first");
    if (list.length === 1) return openSide(list[0]);
    if (!app.openSplit) return openInTabs(list);
    // the split view takes several paths at once
    const paths = list.slice(0, MAX_TABS).map((i) => G.nodes[i].id);
    app.openSplit(paths);
    if (list.length > MAX_TABS) app.toast(`Opened the first ${MAX_TABS} of ${list.length.toLocaleString()} to the side`);
  }

  /* ── comment frames: actions ─────────────────────────────────────────── */
  let frameSeq = 0;
  const frameById = (id) => frames.find((f) => f.id === id) || null;

  function addFrame(box, { title = "Comment", edit = true } = {}) {
    const f = cleanFrame({ id: "f" + Date.now().toString(36) + (frameSeq++).toString(36), title, c: frames.length % FRAME_COLORS, ...box });
    frames.push(f);
    frameSel = f.id;
    // the frame holds its notes where they are (a home inside holds its own)
    if (G) {
      for (const i of nodesIn(f, false)) {
        if (homedIn(f, i)) continue;
        pins.add(G.nodes[i].id);
        L.fixed[i] = 1;
      }
      syncPins();
    }
    touch();
    if (!S.open.comments) S.open = { ...S.open, comments: true };
    renderPanel();
    kick();
    if (edit) editFrame(f, "title");
    return f;
  }

  // a title from what the selection shares: its folder, else "Comment"
  function guessTitle(list) {
    let folder = null;
    for (const i of list) {
      const f = G.nodes[i].folder || "";
      if (folder === null) folder = f;
      else if (folder !== f) return "Comment";
    }
    return folder ? folder.slice(folder.lastIndexOf("/") + 1) : "Comment";
  }

  function commentAround(list = selIdx) {
    if (!list.length) return commentAt(mouseW);
    const box = frameAround(list.map((i) => ({ x: L.x[i], y: L.y[i], r: rad[i] })));
    addFrame(box, { title: guessTitle(list) });
  }

  function commentAt(w) {
    const at = w || { x: (W / 2 - (W / 2 + cam.x)) / cam.k, y: (H / 2 - (H / 2 + cam.y)) / cam.k };
    const k = Math.max(cam.k, 0.3);
    addFrame({ x: at.x - 20 / k, y: at.y - 14 / k, w: 320 / k, h: 200 / k });
  }

  function flyToFrame(f) {
    const t = {};
    frameSel = f.id;
    if (fitBox(f.x, f.y, f.x + f.w, f.y + f.h, 1.6, t)) animateTo(t);
    renderFrameList();
    kick();
  }

  function selectIn(f) {
    selected.clear();
    for (const i of nodesIn(f, true)) selected.add(G.nodes[i].id);
    syncSelection();
    kick();
  }

  function fitFrame(f) {
    const list = nodesIn(f, true);
    if (!list.length) return app.toast("Nothing inside this comment to fit");
    Object.assign(f, frameAround(list.map((i) => ({ x: L.x[i], y: L.y[i], r: rad[i] }))));
    touch();
    renderPanel();
    kick();
  }

  function zOrder(f, dir) {
    const at = frames.indexOf(f);
    if (at < 0) return;
    frames.splice(at, 1);
    if (dir > 0) frames.push(f);
    else frames.unshift(f);
    touch();
    renderPanel();
    kick();
  }

  function deleteFrame(f) {
    const at = frames.indexOf(f);
    if (at < 0) return;
    closeEdit(false);
    frames.splice(at, 1);
    if (frameSel === f.id) frameSel = null;
    if (frameHover === f.id) frameHover = null;
    touch();
    renderPanel();
    if (query) runSearch(true);
    kick();
    undoable(`Deleted “${f.title || "Comment"}”. Its notes stay.`, () => {
      if (frames.includes(f)) return;
      frames.splice(Math.min(at, frames.length), 0, f);
      touch();
      renderPanel();
      kick();
    });
  }

  function setFrameColor(f, c) {
    f.c = c;
    touch();
    renderFrameList();
    kick();
  }

  function colourMenu(f, x, y) {
    app.menu(x, y, [
      { header: "Colour" },
      ...FRAME_NAMES.map((name, c) => ({ label: name, swatch: frameColor(c), checked: f.c === c, run: () => setFrameColor(f, c) })),
    ]);
  }

  // an input laid over the frame header (or under it for the description)
  function editFrame(f, field = "title", again = false) {
    closeEdit(true);
    if (!frames.includes(f) || off()) return;
    if (tween) { setTimeout(() => editFrame(f, field, again), Math.max(40, tween.dur - (performance.now() - tween.t0) + 30)); return; }
    const k = cam.k;
    let sx = f.x * k + W / 2 + cam.x;
    let sy = f.y * k + H / 2 + cam.y;
    const small = FRAME_HEAD * k < BIG_TITLE;
    if (!again && (small || sx < insetL - 20 || sy < 0 || sx > W - 80 || sy > H - 40)) {
      flyToFrame(f);
      editFrame(f, field, true);
      return;
    }
    const note = field === "note";
    const headPx = Math.max(26, FRAME_HEAD * k);
    const px = clampNum(headPx * 0.46, 12, 22);
    sx = clampNum(sx, 4, W - 190);
    sy = clampNum(note ? sy + headPx : sy, 4, H - (note ? 70 : headPx + 4));
    const input = h(note ? "textarea" : "input", {
      class: "gx-fedit" + (note ? " is-note" : ""),
      placeholder: note ? "Description (optional)" : "Comment title",
      spellcheck: false,
      autocomplete: "off",
      style: {
        left: sx + "px", top: sy + "px", width: clampNum(f.w * k, 190, W - sx - 8) + "px",
        height: note ? "" : headPx + "px", fontSize: (note ? Math.max(12, px * 0.85) : px) + "px", "--c": frameColor(f.c),
      },
    });
    input.value = note ? f.note : f.title;
    wrap.append(input);
    editing = { f, field, input };
    const done = (ok) => {
      if (!editing || editing.input !== input) return;
      editing = null;
      const v = input.value.replace(/\s+/g, " ").trim();
      input.remove();
      if (ok && frames.includes(f)) {
        if (note) f.note = v.slice(0, 1000);
        else f.title = v.slice(0, 200) || "Comment";
        touch();
        renderFrameList();
        if (query) runSearch(true);
      }
      if (!off() && document.activeElement === document.body) wrap.focus({ preventScroll: true });
      kick();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !(note && e.shiftKey)) { e.preventDefault(); done(true); }
      else if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Tab" && !note) { e.preventDefault(); done(true); editFrame(f, "note"); }
    });
    input.addEventListener("blur", () => done(true));
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    editing.done = done;
    input.focus({ preventScroll: true });
    input.select();
    kick();
  }

  function closeEdit(ok) {
    if (editing) editing.done(ok);
  }

  function frameMenu(f, x, y) {
    frameSel = f.id;
    kick();
    const inside = nodesIn(f, true);
    const notesIn = inside.filter((i) => G.nodes[i].kind === "note");
    const at = frames.indexOf(f);
    app.menu(x, y, [
      { header: `${f.title || "Comment"} · ${plural(inside.length, "node")}`, plain: true },
      { label: "Rename", icon: "edit", keys: "F2", run: () => editFrame(f, "title") },
      { label: f.note ? "Edit description" : "Add description", icon: "list", run: () => editFrame(f, "note") },
      { label: `Colour: ${FRAME_NAMES[f.c]}…`, swatch: frameColor(f.c), run: () => colourMenu(f, x, y) },
      "sep",
      { label: "Select nodes inside", icon: "check", run: () => selectIn(f) },
      notesIn.length ? { label: `Open ${plural(notesIn.length, "note")} in tabs`, icon: "fileText", run: () => openInTabs(notesIn) } : null,
      notesIn.length && app.openSplit ? { label: "Open side by side", icon: "panelRight", run: () => openSideBySide(notesIn) } : null,
      notesIn.length ? { label: "Make research board", icon: "sparkles", run: () => openAsBoard(notesIn, false, f.title) } : null,
      notesIn.length ? { label: "Add to board…", icon: "grid", run: () => boardMenu(x, y, notesIn) } : null,
      inside.length && homesOn() ? { label: "Give these a home here", icon: "home", run: () => makeHome(inside, { x: f.x + f.w / 2, y: f.y + FRAME_HEAD / 2 + f.h / 2 }, f.title === "Comment" ? "" : f.title) } : null,
      "sep",
      { label: "Zoom to comment", icon: "expand", run: () => flyToFrame(f) },
      inside.length ? { label: "Fit frame to contents", icon: "shrink", run: () => fitFrame(f) } : null,
      at < frames.length - 1 ? { label: "Bring to front", icon: "arrowUp", run: () => zOrder(f, 1) } : null,
      at > 0 ? { label: "Send to back", icon: "arrowDown", run: () => zOrder(f, -1) } : null,
      "sep",
      { label: "Delete comment", icon: "trash", keys: "Del", danger: true, run: () => deleteFrame(f) },
    ]);
  }

  /* ── folder categories ───────────────────────────────────────────────── */
  const inFolderOf = (f, p) => f === p || f.startsWith(p + "/");

  // quiet: putting the rules back (an undo) is not itself undoable
  function setFolderRules({ split, own }, quiet = false) {
    if (!quiet) { const was = { split: S.splitFolders.slice(), own: S.ownFolders.slice() }; undoable("Groups changed", () => setFolderRules(was, true)); }
    set("splitFolders", [...new Set(split)]);
    set("ownFolders", [...new Set(own)]);
    regroup();
    updateEmphasis();
    renderPanel();
    kick();
  }

  function splitFolder(p) {
    setFolderRules({ split: [...S.splitFolders, p], own: S.ownFolders });
  }

  // every subfolder of p back into p
  function joinFolder(p) {
    const split = S.splitFolders.filter((f) => !inFolderOf(f, p));
    const own = S.ownFolders.filter((f) => !inFolderOf(f, p));
    if (S.folderDepth > segCount(p)) own.push(p);
    setFolderRules({ split, own });
  }
  const segCount = (p) => p.split("/").length;

  function mergeFolder(p) {
    setFolderRules(mergeFolderRules(p, folderRules()));
  }

  function makeOwnFolder(p) {
    setFolderRules({ split: S.splitFolders.filter((f) => f !== p), own: [...S.ownFolders, p] });
  }

  function subfoldersOf(p) {
    for (const note of vault.notes.values()) if (note.folder && note.folder.startsWith(p + "/")) return true;
    return false;
  }

  /* ── paths ───────────────────────────────────────────────────────────── */
  function makePath(a, b, all) {
    const through = noteOnly(G.nodes);
    const res = shortestPaths(G, a, b, through);
    if (!res) return null;
    return { from: G.nodes[a].id, to: G.nodes[b].id, res, one: shortestPath(G, a, b, through), all: !!all };
  }

  function startPick(i) {
    picking = { from: G.nodes[i].id };
    path = null;
    updateEmphasis();
    paintChrome();
    search.focus();
    canvas.style.cursor = "crosshair";
    kick();
  }

  /* ── linking by clicking ─────────────────────────────────────────────
     The lens links by dragging a handle; here the same thing happens with
     two clicks, which is easier on a big graph: pick "Link to…", then click
     the note it should point at. Anywhere else, or Escape, stops. */
  function startLink(i, both) {
    picking = { from: G.nodes[i].id, link: true, both: !!both };
    path = null;
    updateEmphasis();
    paintChrome();
    canvas.style.cursor = "crosshair";
    kick();
  }

  function finishLink(b, e) {
    const from = picking.from;
    const a = G.index.get(from);
    const both = picking.both || !!(e && e.shiftKey);
    const more = !!(e && (e.ctrlKey || e.metaKey)); // keep going: link several at once
    const stop = () => { picking = null; canvas.style.cursor = ""; paintChrome(); kick(); };
    if (a === undefined) return stop();
    if (a === b) { app.toast("A note cannot link to itself"); if (!more) stop(); return; }
    if (G.nodes[b].kind !== "note") { app.toast("Links can only point at a note"); if (!more) stop(); return; }
    lens.linkTo(from, G.nodes[b].id, both);
    if (more) { paintChrome(); kick(); } else stop();
  }

  function cancelPick() {
    picking = null;
    paintChrome();
    canvas.style.cursor = "";
    kick();
  }

  function finishPick(b) {
    const a = G.index.get(picking.from);
    picking = null;
    canvas.style.cursor = "";
    if (a === undefined) return paintChrome();
    if (a === b) { paintChrome(); return app.toast("Pick a different note for the other end"); }
    const p = makePath(a, b, false);
    if (!p) {
      paintChrome();
      const where = S.scope === "all" && !only ? "" : " in this view. Try All notes";
      return app.toast(`No link path between “${G.nodes[a].label}” and “${G.nodes[b].label}”${where}`);
    }
    path = p;
    if (query) setQuery("");
    updateEmphasis();
    paintChrome();
    fit(Array.from(p.one));
  }

  function clearPath() {
    path = null;
    updateEmphasis();
    paintChrome();
    kick();
  }

  function renderPath() {
    pathEl.hidden = !path;
    if (!path) return;
    const { res, one } = path;
    const row = (i, step) => h("button", {
      class: "gx-step" + (G.nodes[i].kind !== "note" ? " is-other" : ""),
      title: G.nodes[i].id,
      onclick: (e) => openNode(i, e.ctrlKey || e.metaKey),
      onmouseenter: () => setHover(i),
      onmouseleave: () => setHover(-1),
    }, h("span", { class: "gx-step-n", text: String(step) }), h("span", { class: "gx-step-t", text: G.nodes[i].label }));
    const list = h("div", { class: "gx-steps" });
    if (path.all) {
      res.layers.forEach((layer, s) => {
        const col = h("div", { class: "gx-layer" });
        for (const i of layer.slice(0, 8)) col.append(row(i, s));
        if (layer.length > 8) col.append(h("div", { class: "gx-more", text: `+${layer.length - 8} more` }));
        list.append(col);
      });
    } else {
      one.forEach((i, s) => list.append(row(i, s)));
    }
    const count = res.paths >= 1e9 ? "many" : res.paths > 9999 ? "9999+" : String(res.paths);
    pathEl.replaceChildren(
      h("div", { class: "gx-pathhead" },
        icon("compass"),
        h("span", { class: "gx-pathtitle", text: res.length === 1 ? "Linked directly" : `Path · ${res.length} steps` }),
        h("button", { class: "gx-icon-btn", title: "Close (Esc)", onclick: clearPath }, icon("x"))),
      list,
      h("div", { class: "gx-pathfoot" },
        res.paths > 1 ? segmented([[false, "One path"], [true, `All ${count}`]], path.all, (v) => { path.all = v; updateEmphasis(); renderPath(); kick(); }) : null,
        h("button", { class: "gx-chip", onclick: () => {
          const ids = path.all ? [...res.nodes.keys()].filter((i) => res.nodes[i]) : one;
          for (const i of ids) selected.add(G.nodes[i].id);
          syncSelection();
          kick();
        } }, icon("check"), "Select"))
    );
  }

  /* ── search ──────────────────────────────────────────────────────────── */
  const search = h("input", { class: "gx-search-input", type: "text", placeholder: "Search the graph", spellcheck: false, autocomplete: "off" });
  const searchCount = h("span", { class: "gx-search-count" });
  const results = h("div", { class: "gx-results", hidden: true });
  let resultAt = 0;
  let resultMoved = false;

  let inText = new Set(); // matches found in the text of notes, not their names
  function runSearch(render = true) {
    const t0 = performance.now();
    matches = query && G ? searchNodes(query, G.nodes, vis) : [];
    // the words found inside notes, after the names: plain words of three letters or more
    inText = new Set();
    const q = query.trim().toLowerCase();
    if (G && q.length >= 3 && !/^[#-]|\w:/.test(q)) {
      const named = new Set(matches);
      for (let i = 0; i < n && inText.size < 300; i++) {
        if (named.has(i) || !vis[i] || G.nodes[i].kind !== "note") continue;
        const note = vault.notes.get(G.nodes[i].id);
        if (note && note.lower.includes(q)) { inText.add(i); matches.push(i); }
      }
    }
    frameHits = query ? searchFrames(query, frames) : [];
    perf.searchMs = performance.now() - t0;
    if (matchAt >= matches.length) matchAt = -1;
    resultAt = 0;
    resultMoved = false;
    if (render) { updateEmphasis(); paintSearch(); kick(); }
    else paintSearch();
  }
  const runSearchSoon = debounce(() => runSearch(true), 60);

  function setQuery(q) {
    query = q;
    search.value = q;
    matchAt = -1;
    runSearch(true);
  }

  // result rows: matching comments first (a few), then nodes
  let items = [];
  // why a node matched: the letters in its name, a tag, its folder, or a line of its text
  function whyRow(i) {
    const nd = G.nodes[i];
    const q = query.trim();
    if (inText.has(i)) {
      const note = vault.notes.get(nd.id);
      const at = note ? note.lower.indexOf(q.toLowerCase()) : -1;
      if (at < 0) return [h("span", { class: "gx-result-t", text: nd.label }), null];
      const from = Math.max(0, at - 24), to = Math.min(note.content.length, at + q.length + 40);
      const snip = (from ? "…" : "") + note.content.slice(from, to).replace(/\s+/g, " ") + (to < note.content.length ? "…" : "");
      const s0 = snip.toLowerCase().indexOf(q.toLowerCase());
      return [h("span", { class: "gx-result-t", text: nd.label }), h("span", { class: "gx-result-why" }, s0 >= 0 ? highlight(snip, Array.from({ length: q.length }, (_, k) => s0 + k)) : snip)];
    }
    const tq = q[0] === "#" ? q.slice(1).toLowerCase() : q.toLowerCase();
    const title = fuzzy(q[0] === "#" ? "" : q, nd.label);
    if (title && title.hits.length && q[0] !== "#") return [h("span", { class: "gx-result-t" }, highlight(nd.label, title.hits)), nd.folder ? h("span", { class: "gx-result-f", text: nd.folder }) : null];
    // a tag of it
    const tag = (nd.tags || []).find((x) => (q[0] === "#" ? x.startsWith(tq) : fuzzy(q, x)));
    if (tag) {
      const f = fuzzy(tq, tag);
      return [h("span", { class: "gx-result-t", text: nd.label }), h("span", { class: "gx-result-tag" }, "#", f ? highlight(tag, f.hits) : tag)];
    }
    // its folder or path
    const pf = nd.path ? fuzzy(q, nd.path) : null;
    if (pf) return [h("span", { class: "gx-result-t", text: nd.label }), h("span", { class: "gx-result-f is-why" }, highlight(nd.path, pf.hits))];
    return [h("span", { class: "gx-result-t", text: nd.label }), nd.folder ? h("span", { class: "gx-result-f", text: nd.folder }) : null];
  }
  function paintSearch() {
    searchCount.textContent = query ? (matches.length ? (matchAt >= 0 ? `${matchAt + 1}/${matches.length}` : String(matches.length)) : frameHits.length ? "" : "0") : "";
    searchCount.classList.toggle("is-none", !!query && !matches.length && !frameHits.length);
    const fh = frameHits.slice(0, picking ? 0 : 3);
    items = [...fh.map((f) => ({ f })), ...matches.slice(0, 8 - fh.length).map((i) => ({ i }))];
    if (resultAt >= items.length) resultAt = 0;
    const show = document.activeElement === search && query && items.length;
    results.hidden = !show;
    if (!show) return;
    results.replaceChildren(...items.map((it, t) => {
      const props = {
        class: "gx-result" + (t === resultAt ? " is-active" : "") + (it.f ? " is-frame" : ""),
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => chooseItem(it, e),
        onmouseenter: () => { resultAt = t; for (const [k, b] of [...results.children].entries()) b.classList.toggle("is-active", k === t); },
      };
      if (it.f) {
        return h("button", props, h("span", { class: "gx-fdot", style: { "--c": frameColor(it.f.c) } }),
          h("span", { class: "gx-result-t", text: it.f.title || "Comment" }), h("span", { class: "gx-result-f", text: "comment" }));
      }
      const nd = G.nodes[it.i];
      return h("button", props, icon(nd.kind === "note" ? "fileText" : nd.kind === "tag" ? "hash" : nd.kind === "file" ? "image" : "link"),
        ...whyRow(it.i));
    }));
  }

  function chooseItem(it, e) {
    if (!it) return;
    if (it.i !== undefined) return chooseResult(it.i, e);
    results.hidden = true;
    flyToFrame(it.f);
    if (e && (e.ctrlKey || e.metaKey)) selectIn(it.f);
  }

  function chooseResult(i, e) {
    if (picking) { picking.link ? finishLink(i, e) : finishPick(i); return; }
    matchAt = matches.indexOf(i);
    if (e && (e.ctrlKey || e.metaKey)) return openNode(i, true);
    selected.clear();
    selected.add(G.nodes[i].id);
    syncSelection();
    centreOn(i, 2);
    paintSearch();
    kick();
  }

  function nextMatch(dir) {
    if (!matches.length) return;
    matchAt = matchAt < 0 ? (dir > 0 ? 0 : matches.length - 1) : (matchAt + dir + matches.length) % matches.length;
    centreOn(matches[matchAt], 2);
    paintSearch();
    kick();
  }

  search.addEventListener("input", () => {
    query = search.value.trim();
    matchAt = -1;
    if (n > 1500) runSearchSoon();
    else runSearch(true);
  });
  search.addEventListener("focus", () => paintSearch());
  search.addEventListener("blur", () => { results.hidden = true; });
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (picking) cancelPick();
      else if (search.value) setQuery("");
      else search.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSearchSoon.flush();
      const it = items[resultAt];
      if (picking) { const j = it && it.i !== undefined ? it.i : matches[0]; if (matches.length) { picking.link ? finishLink(j, e) : finishPick(j); } return; }
      // a result picked with the arrow keys wins over stepping through matches
      if (resultMoved && !results.hidden && it) { chooseItem(it, e); return; }
      if (!matches.length) { if (frameHits.length) chooseItem({ f: frameHits[0] }, null); return; }
      if (e.ctrlKey || e.metaKey) { openNode(matchAt >= 0 ? matches[matchAt] : it && it.i !== undefined ? it.i : matches[0], true); return; }
      results.hidden = true;
      nextMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const len = items.length;
      if (!len) return;
      resultAt = (resultAt + (e.key === "ArrowDown" ? 1 : -1) + len) % len;
      resultMoved = true;
      paintSearch();
    }
  });

  /* ── keyboard ────────────────────────────────────────────────────────── */
  const overlayOpen = () => {
    // only something actually on screen counts: the ribbon parks a hidden tip
    // card in here, and counting it killed every shortcut in the graph
    const o = document.getElementById("overlay-root");
    return !!o && [...o.children].some((n) => !n.hidden && n.offsetParent !== null);
  };

  function escape() {
    if (lens.settingsOpen()) lens.closeSettings();
    else if (!helpEl.hidden) helpEl.hidden = true;
    else if (lens.linking()) lens.cancelLink();
    else if (lens.on && lens.count()) lens.closeAll();
    else if (lens.on) toggleLens(false);
    else if (picking) cancelPick();
    else if (path) clearPath();
    else if (bridgeSel) clearBridges();
    else if (query) setQuery("");
    else if (selected.size) clearSelection();
    else if (only) exitFocusSelection();
    else if (frameSel) { frameSel = null; renderFrameList(); kick(); }
    else return false;
    return true;
  }

  document.addEventListener("keydown", (e) => {
    if (off() || e.defaultPrevented || !G || overlayOpen()) return;
    if (isTyping() || e.altKey) return;
    // keys belong to the graph only while nothing else has focus
    const a = document.activeElement;
    if (a && a !== document.body && !wrap.contains(a)) return;
    if ((e.key === "Enter" || e.key === " ") && a && a.tagName === "BUTTON") return;
    // the lens popover owns its own arrows and sliders while it has focus
    if (a && a.closest && a.closest(".gx-lenspop")) {
      if (e.key !== "Escape") return;
      lens.closeSettings();
      e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const step = e.shiftKey ? 240 : 70;
    let done = true;
    if (e.key === "Escape") done = escape();
    else if (e.key === "/" && !mod) { search.focus(); search.select(); }
    else if (e.code === "KeyF" && !mod) fit(e.shiftKey ? selIdx : null);
    else if (e.code === "KeyA" && mod) selectAll();
    else if (e.key === "Enter") openSelection(mod);
    // the lens owns undo here: the graph has no editor to fight with
    else if (mod && e.code === "KeyZ" && !e.shiftKey) { if (!undoLast()) lens.undoLink(); }
    else if (mod && (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey))) lens.redoLink();
    else if (mod && e.shiftKey && e.code === "KeyP") pinAllCards(true);
    else if (mod && e.shiftKey && e.code === "KeyU") pinAllCards(false);
    else if (mod) done = false;
    else if (e.altKey && e.key === "ArrowLeft") goBack();
    else if (e.altKey && e.key === "ArrowRight") goAhead();
    else if (e.key === "ArrowLeft") pan(step, 0);
    else if (e.key === "ArrowRight") pan(-step, 0);
    else if (e.key === "ArrowUp") pan(0, step);
    else if (e.key === "ArrowDown") pan(0, -step);
    else if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") zoomButton(1.35);
    else if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") zoomButton(1 / 1.35);
    else if (e.code === "KeyP" && selIdx.length) { for (const i of selIdx) togglePin(i); }
    else if (e.code === "KeyH" && selIdx.length === 1) hideNode(selIdx[0]);
    else if (e.code === "KeyE" && selIdx.length) expandSelection();
    else if (e.code === "KeyC") commentAround();
    else if (e.code === "KeyM") toggleLens();
    else if (e.key === "F2" && frameById(frameSel)) editFrame(frameById(frameSel), "title");
    else if (e.key === "Delete" && frameById(frameSel) && !selIdx.length) deleteFrame(frameById(frameSel));
    else if (e.key === "Backspace" && S.scope === "around") stepBack();
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  });

  /* ── menus ───────────────────────────────────────────────────────────── */
  function nodeMenu(i, x, y) {
    const nd = G.nodes[i];
    const inSel = selMask[i] && selIdx.length > 1;
    const pinned = pins.has(nd.id);
    const items = [{ header: nd.label, plain: true }];
    if (nd.kind === "note") {
      items.push(
        { label: "Open", icon: "fileText", keys: "Enter", run: () => openNode(i, false) },
        { label: "Open in new tab", icon: "plus", keys: "Ctrl Enter", run: () => openNode(i, true) },
        { label: "Open to the side", icon: "panelRight", keys: "Alt click", run: () => openSide(i) },
        { label: "Show in sidebar", icon: "sidebar", run: () => app.revealInTree && app.revealInTree(nd.id) },
        { label: "Show in Explorer", icon: "reveal", run: () => app.reveal && app.reveal(nd.id) },
        { label: "Copy link", icon: "link", run: () => { navigator.clipboard.writeText(`[[${app.vault.linkText(nd.id)}]]`); app.toast("Link copied", { ms: 1600 }); } },
        "sep",
        { label: "Focus graph here", icon: "target", run: () => focusOn(nd.id) },
        { label: "Link to another note…", icon: "link", run: () => startLink(i, false) },
        { label: "Link both ways…", icon: "link", run: () => startLink(i, true) },
        { label: "Find path from here…", icon: "compass", run: () => startPick(i) },
        { label: inSel ? `Add ${selectedNotes().length} selected to board…` : "Add to board…", icon: "grid", run: () => boardMenu(x, y, inSel ? selectedNotes() : [i]) },
        inSel ? { label: `Open ${selectedNotes().length} as research board`, icon: "sparkles", run: () => openAsBoard() } : null,
      );
      const cat = S.colorBy === "folder" && nd.folder ? groupKey(nd, "folder", [], folderRules()) : "";
      if (cat && cat !== "folder:" + nd.folder) {
        items.push({ label: `Make ‘${nd.folder.slice(nd.folder.lastIndexOf("/") + 1)}’ its own group`, icon: "folder", run: () => makeOwnFolder(nd.folder) });
      }
    } else if (nd.kind === "file") {
      items.push(
        { label: "Open", icon: "image", keys: "Enter", run: () => openNode(i, false) },
        { label: "Open in new tab", icon: "plus", run: () => openNode(i, true) },
        { label: "Open to the side", icon: "panelRight", keys: "Alt click", run: () => openSide(i) },
        { label: "Show in sidebar", icon: "sidebar", run: () => app.revealInTree && app.revealInTree(nd.id) },
        { label: "Show in Explorer", icon: "reveal", run: () => app.reveal && app.reveal(nd.id) },
        { label: "Find path from here…", icon: "compass", run: () => startPick(i) },
      );
    } else if (nd.kind === "tag") {
      items.push(
        { label: `Highlight ${nd.label}`, icon: "search", run: () => setQuery(nd.label) },
        { label: "Show only this tag", icon: "hash", run: () => { set("tag", nd.label.slice(1)); set("scope", "tag"); autoFit = true; rebuild(); renderPanel(); } },
      );
    } else {
      items.push({ label: `Create “${nd.label}”`, icon: "plus", run: () => createGhost(nd, false) });
    }
    // homes and bridges
    const hk = homeIdx[i];
    const list = inSel ? selIdx.slice() : [i];
    if (homesOn()) {
      const chunk = inSel || hk >= 0 ? list : chunkOf(i);
      items.push("sep", {
        label: inSel ? `Give ${list.length} selected a home here` : hk >= 0 ? "Move to a home of its own" : chunk.length > 1 ? `Give this cluster a home (${chunk.length})` : "Give this a home here",
        icon: "home",
        run: () => homeWithUndo(chunk, null, hk >= 0 ? `“${nd.label}” has a home of its own` : ""),
      });
      if (hk >= 0 && hCore[hk] !== i) items.push({ label: `Make it the centre of ${homeName(hk)}`, icon: "target", run: () => {
        const snap = homeSnap([]);
        hList[hk].core = nd.id;
        homesChanged(0.3);
        undoable(`“${nd.label}” is the centre now`, () => homeRestore(snap));
      } });
      if (list.some((j) => homeIdx[j] >= 0)) items.push({ label: "Send back to the pool", icon: "undo", run: () => { const snap = homeSnap(list); sendToPool(list); undoable("Back in the pool", () => homeRestore(snap)); } });
      if (hk >= 0) items.push({ label: `Home: ${homeName(hk)}…`, icon: "more", run: () => homeMenu(hk, x, y) });
    }
    if (hk >= 0) items.push({ label: `Show bridges from ‘${homeName(hk)}’`, icon: "link", run: () => showBridges("home", hList[hk].id) });
    const g = groups[groupOf[i]];
    if (g && g.color && nd.kind === "note") items.push({ label: `Show bridges from ‘${g.label}’`, icon: "link", run: () => showBridges("group", g.key) });
    items.push(
      "sep",
      { label: inSel ? `Comment around ${selIdx.length} selected` : "Comment around this", icon: "square", keys: "C", run: () => commentAround(inSel ? selIdx : [i]) },
      { label: "Select neighbours", icon: "graph", run: () => selectNeighbours(i) },
      { label: pinned ? "Unpin" : "Pin in place", icon: "pin", keys: "P", run: () => togglePin(i) },
      { label: "Hide this node", icon: "eye", keys: "H", run: () => hideNode(i) },
    );
    app.menu(x, y, items);
  }

  function backgroundMenu(x, y, w) {
    const outliers = pins.size ? pinnedOutliers().length : 0;
    app.menu(x, y, [
      // with the lens armed its own settings come first: right-clicking the
      // glass is the obvious place to look for them
      lens.on ? { label: "Reading lens…", icon: "search", keys: "M", run: () => lens.settings(x, y) } : null,
      !lens.on ? { label: "Hover cards…", icon: "settings", run: () => lens.settings(x, y, "tip") } : null,
      "sep",
      selIdx.length && homesOn() ? { label: `Give ${plural(selIdx.length, "selected node")} a home`, icon: "home", run: () => homeWithUndo(selIdx.slice(), w) } : null,
      outliers ? { label: `Give pinned clusters a home (${outliers})`, icon: "home", run: homesForPinned } : null,
      selIdx.length ? { label: `Comment around ${plural(selIdx.length, "selected node")}`, icon: "square", keys: "C", run: () => commentAround() } : null,
      { label: "New comment here", icon: "plus", run: () => commentAt(w) },
      "sep",
      { label: "Zoom to fit", icon: "expand", keys: "F", run: () => fit() },
      selIdx.length ? { label: "Zoom to selection", icon: "shrink", keys: "Shift F", run: () => fit(selIdx) } : null,
      { label: "Select all", icon: "check", keys: "Ctrl A", run: selectAll },
      "sep",
      { label: "Reheat layout", icon: "sparkles", run: reheat },
      S.scope === "around" ? { label: "Rings around the focus", icon: "target", checked: S.radial, run: () => { set("radial", !S.radial); rebuild(); renderPanel(); } } : null,
      pins.size ? { label: `Unpin all (${pins.size})`, icon: "pin", run: unpinAll } : null,
      hidden.size ? { label: `Show hidden nodes (${hidden.size})`, icon: "eye", run: showHidden } : null,
      only ? { label: "Show everything", icon: "graph", run: exitFocusSelection } : null,
    ]);
  }

  function showHidden() {
    const was = [...hidden];
    hidden.clear();
    rebuild();
    renderPanel();
    if (was.length) undoable(`Showing ${was.length} hidden`, () => { for (const id of was) hidden.add(id); rebuild(); renderPanel(); });
  }

  /* What the graph offers to undo (a home made, a comment deleted): the message's Undo, or Ctrl+Z -
     the newest first; each runs once. */
  const undos = [];
  function undoable(text, run) {
    const u = { run, done: false };
    const go = () => { if (u.done) return; u.done = true; const i = undos.indexOf(u); if (i >= 0) undos.splice(i, 1); run(); };
    undos.push(u);
    if (undos.length > 30) undos.shift();
    app.toast(text + " · Ctrl+Z undoes it", { action: { label: "Undo", run: go } });
    u.go = go;
    // done from a menu or a button, the keys are elsewhere: they come back to the graph, so Ctrl+Z reaches it
    if (!off()) wrap.focus({ preventScroll: true });
  }
  const undoLast = () => { const u = undos.pop(); if (!u) return false; u.done = true; u.run(); app.toast("Undone", { ms: 1400 }); return true; };

  /* ── panel ───────────────────────────────────────────────────────────── */
  const stats = h("span", { class: "gx-stats" });
  const collapseBtn = h("button", { class: "gx-icon-btn", title: "Graph settings", onclick: () => setPanel(!S.panel) }, icon("settings"));
  const head = h("div", { class: "gx-head", title: "Click to fold or unfold · drag to move the panel · double-click to put it back" }, icon("graph", "gx-logo"), h("span", { class: "gx-title", text: "Graph" }), stats, collapseBtn);
  const placePanel = () => {
    const at = S.panelAt;
    panel.style.left = at ? Math.max(0, Math.min(wrap.clientWidth - 120, at.x)) + "px" : "";
    panel.style.top = at ? Math.max(0, Math.min(wrap.clientHeight - 40, at.y)) + "px" : "";
    panel.classList.toggle("is-moved", !!at);
  };
  head.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    const x0 = e.clientX, y0 = e.clientY;
    const r = panel.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    let moved = false;
    head.setPointerCapture(e.pointerId);
    const move = (m) => {
      if (!moved && Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < 4) return;
      moved = true;
      S.panelAt = { x: Math.round(r.left - w.left + m.clientX - x0), y: Math.round(r.top - w.top + m.clientY - y0) };
      placePanel();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      if (moved) { set("panelAt", S.panelAt); measureInset(); }
      else setPanel(!S.panel); // a click: fold or unfold
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });
  head.addEventListener("dblclick", (e) => { if (e.target.closest("button")) return; set("panelAt", null); placePanel(); measureInset(); });
  setTimeout(placePanel);
  const sections = h("div", { class: "gx-sections" });
  sections.replaceChildren = (...xs) => Element.prototype.replaceChildren.call(sections, ...xs, legendEl);
  panel.append(
    head,
    h("div", { class: "gx-search" }, icon("search"), search, searchCount, results),
    sections
  );

  function setPanel(open) {
    set("panel", open);
    panel.classList.toggle("is-collapsed", !open);
    collapseBtn.classList.toggle("is-on", open);
    if (open) renderPanel();
    measureInset();
    kick();
  }

  function toggleRow(label, key, after, ico) {
    const sw = h("span", { class: "switch" + (S[key] ? " is-on" : "") });
    return h("button", {
      class: "gx-row",
      role: "switch",
      "aria-checked": String(S[key]),
      onclick: (e) => {
        set(key, !S[key]);
        sw.classList.toggle("is-on", S[key]);
        e.currentTarget.setAttribute("aria-checked", String(S[key]));
        after();
      },
    }, ico ? icon(ico) : null, h("span", { class: "gx-row-label", text: label }), sw);
  }

  // typeMax: the value is also a field, and may be typed past the slider's end (up to typeMax)
  function sliderRow(label, key, min, max, stepV, fmt, after, typeMax = 0) {
    const out = typeMax ? h("input", { type: "number", class: "gx-val gx-num", min, max: typeMax, step: stepV }) : h("span", { class: "gx-val" });
    if (typeMax) out.addEventListener("change", () => { S[key] = Math.max(min, Math.min(typeMax, Math.round(Number(out.value) || 0))); input.value = Math.min(max, S[key]); persist(); paint(); after(); });
    const input = h("input", { type: "range", class: "gx-range", min, max, step: stepV });
    input.value = S[key];
    const paint = () => {
      if (typeMax) out.value = S[key]; else out.textContent = fmt(S[key]);
      input.style.setProperty("--p", (Math.min(max, S[key]) - min) / (max - min) * 100 + "%");
    };
    input.addEventListener("input", () => { S[key] = Number(input.value); persist(); paint(); after(); });
    input.addEventListener("dblclick", () => {
      const d = graphSettings({})[key];
      S[key] = d;
      input.value = d;
      persist();
      paint();
      after();
    });
    paint();
    return h("label", { class: "gx-slider", title: "Double-click to reset" }, h("span", { class: "gx-row-label", text: label }), out, input);
  }

  function segmented(options, value, pick) {
    const wrapSeg = h("div", { class: "gx-seg" });
    for (const [v, label, ico] of options) {
      wrapSeg.append(h("button", { class: "gx-seg-btn" + (v === value ? " is-active" : ""), onclick: () => pick(v) }, ico ? icon(ico) : null, h("span", { text: label })));
    }
    return wrapSeg;
  }

  function section(key, title, build, badge) {
    const open = !!S.open[key];
    const body = h("div", { class: "gx-sec-body" });
    // a row left out (null) is left out, not written as "null"
    body.append = (...xs) => Element.prototype.append.apply(body, xs.filter((x) => x != null));
    if (open) build(body);
    return h("section", { class: "gx-sec" + (open ? " is-open" : "") },
      h("button", {
        class: "gx-sec-head",
        onclick: () => {
          S.open = { ...S.open, [key]: !S.open[key] };
          persist();
          renderPanel();
        },
      }, icon("chevron", "gx-chev"), h("span", { text: title }), badge ? h("span", { class: "gx-badge", text: badge }) : null),
      body);
  }

  function noteFolders() {
    const set2 = new Set();
    for (const note of vault.notes.values()) {
      let f = note.folder;
      while (f && !set2.has(f)) { set2.add(f); f = dirname(f); }
    }
    return [...set2].sort(naturalCompare);
  }

  function focusPicker(body) {
    const cur = focusShown && vault.notes.has(focusShown) ? basename(focusShown) : null;
    const input = h("input", { class: "gx-input", type: "text", placeholder: cur ? `Focus: ${cur}` : "Pick a note to focus on", spellcheck: false, autocomplete: "off" });
    const list = h("div", { class: "gx-results is-inline", hidden: true });
    let hits = [];
    let at = 0;
    const paint = () => {
      list.hidden = !hits.length;
      list.replaceChildren(...hits.map((p, t) => h("button", {
        class: "gx-result" + (t === at ? " is-active" : ""),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => { input.value = ""; focusOn(p); },
      }, icon("fileText"), h("span", { class: "gx-result-t", text: basename(p) }), dirname(p) ? h("span", { class: "gx-result-f", text: dirname(p) }) : null)));
    };
    input.addEventListener("input", () => {
      const q = input.value.trim();
      at = 0;
      if (!q) { hits = []; return paint(); }
      const scored = [];
      for (const p of vault.notes.keys()) {
        const a = fuzzy(q, basename(p));
        const b = a ? null : fuzzy(q, p);
        if (a || b) scored.push([(a ? a.score + 300 : b.score), p]);
      }
      scored.sort((x, y) => y[0] - x[0]);
      hits = scored.slice(0, 7).map((s) => s[1]);
      paint();
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (hits.length) { at = (at + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length; paint(); } }
      else if (e.key === "Enter" && hits[at]) { e.preventDefault(); input.value = ""; focusOn(hits[at]); }
      else if (e.key === "Escape") { e.preventDefault(); input.value = ""; hits = []; paint(); input.blur(); }
    });
    input.addEventListener("blur", () => { list.hidden = true; });
    const follow = h("button", {
      class: "gx-icon-btn" + (focusId ? "" : " is-on"),
      title: focusId ? "Follow the current note" : "Following the current note",
      onclick: () => { remember(); focusId = null; autoFit = true; rebuild(); renderPanel(); },
    }, icon("target"));
    body.append(h("div", { class: "gx-picker" }, icon("focus"), input, follow, list));
    if (!cur) body.append(h("div", { class: "gx-hint", text: "Open a note, or pick one here, to see what surrounds it." }));
    if (crumbs.length > 1) {
      body.append(h("div", { class: "gx-crumbs" },
        h("button", { class: "gx-icon-btn", title: "Back to the previous focus (Backspace)", onclick: stepBack }, icon("back")),
        crumbs.slice(0, -1).reverse().map((id) => h("button", { class: "gx-crumb", title: id, onclick: () => focusOn(id) }, basename(id)))));
    }
  }

  function renderPanel() {
    panel.classList.toggle("is-collapsed", !S.panel);
    collapseBtn.classList.toggle("is-on", S.panel);
    if (!S.panel) { sections.replaceChildren(); return; }
    const scopeBadge = { all: "", around: `depth ${S.depth}`, folder: S.folder || "", tag: S.tag ? "#" + S.tag : "" }[S.scope];
    const filterCount = [!S.orphans, S.attachments, S.tagNodes, S.unresolved].filter(Boolean).length + S.exclude.length + hidden.size;
    sections.replaceChildren(
      section("scope", "Scope", (b) => {
        b.append(segmented([["all", "All"], ["around", "Around"], ["folder", "Folder"], ["tag", "Tag"]], S.scope, (v) => {
          set("scope", v);
          autoFit = true;
          rebuild();
          renderPanel();
        }));
        // how the dots are laid out: by their links (free), or by when each note last changed
        b.append(segmented([["free", "Free"], ["timeline", "Timeline"], ["orbit", "Orbit"]], S.layout, (v) => {
          set("layout", v);
          autoFit = true;
          rebuild();
          renderPanel();
        }));
        // saved views: a click goes there, right-click to rename or forget
        b.append(h("div", { class: "gx-views" },
          ...S.views.map((v) => h("button", { class: "gx-chip", title: `${v.name} - right-click to rename or forget`, onclick: () => goView(v),
            oncontextmenu: (e) => { e.preventDefault(); app.menu(e.clientX, e.clientY, [
              { label: "Rename…", icon: "edit", run: async () => { const { askDialog } = await import("./ui.js"); const r = await askDialog("Rename the view", [{ key: "name", label: "Name", value: v.name }], { ok: "Rename" }); if (r && r.name) { set("views", S.views.map((x) => (x === v ? { ...x, name: r.name } : x))); renderPanel(); } } },
              { label: "Save the view here instead", icon: "save", run: () => { set("views", S.views.map((x) => (x === v ? { ...x, scope: S.scope, folder: S.folder, tag: S.tag, depth: S.depth, focusId, cam: { ...cam } } : x))); renderPanel(); } },
              { label: "Forget it", icon: "x", danger: true, run: () => { set("views", S.views.filter((x) => x !== v)); renderPanel(); } },
            ]); } }, icon("eye"), h("span", { text: v.name }))),
          h("button", { class: "gx-chip", title: "Keep what is shown now - scope, focus and where you are - to come back to with a click", onclick: saveView }, icon("plus"), "Save view")));
        if (S.scope === "around") {
          focusPicker(b);
          b.append(sliderRow("Depth", "depth", 1, 5, 1, (v) => String(v), () => {
            autoFit = true;
            rebuildSoon();
            const badge = b.parentElement && b.parentElement.querySelector(".gx-badge");
            if (badge) badge.textContent = `depth ${S.depth}`;
          }));
          b.append(toggleRow("Rings by distance", "radial", () => rebuild(), "target"));
        } else if (S.scope === "folder") {
          const sel = h("select", { class: "gx-select" }, h("option", { value: "", text: "Every folder" }), noteFolders().map((f) => h("option", { value: f, text: f })));
          sel.value = S.folder;
          sel.addEventListener("change", () => { set("folder", sel.value); autoFit = true; rebuild(); });
          b.append(h("label", { class: "gx-field" }, icon("folder"), sel));
        } else if (S.scope === "tag") {
          const tags = [...vault.tagCounts()].sort((a, c) => c[1] - a[1] || naturalCompare(a[0], c[0]));
          const sel = h("select", { class: "gx-select" }, h("option", { value: "", text: "Any tag" }), tags.map(([t, c]) => h("option", { value: t, text: `#${t}  (${c})` })));
          sel.value = S.tag;
          sel.addEventListener("change", () => { set("tag", sel.value); autoFit = true; rebuild(); });
          b.append(h("label", { class: "gx-field" }, icon("hash"), sel));
        }
      }, scopeBadge),
      section("filters", "Filters", (b) => {
        b.append(
          toggleRow("Orphans", "orphans", () => rebuild()),
          toggleRow("Attachments", "attachments", () => rebuild()),
          toggleRow("Tags as nodes", "tagNodes", () => rebuild()),
          toggleRow("Unresolved links", "unresolved", () => rebuild()),
        );
        const folders = noteFolders();
        if (folders.length) {
          const ex = new Set(S.exclude);
          const list = h("div", { class: "gx-folders" });
          const filter = folders.length > 12 ? h("input", { class: "gx-input is-small", type: "text", placeholder: "Filter folders", spellcheck: false }) : null;
          const paint = () => {
            const q = filter ? filter.value.trim().toLowerCase() : "";
            list.replaceChildren(...folders.filter((f) => !q || f.toLowerCase().includes(q)).map((f) => {
              const depth = f.split("/").length - 1;
              const parentOff = S.exclude.some((x) => x !== f && f.startsWith(x + "/"));
              const box = h("input", { type: "checkbox", checked: ex.has(f) || parentOff, disabled: parentOff });
              box.addEventListener("change", () => {
                if (box.checked) ex.add(f);
                else ex.delete(f);
                set("exclude", [...ex]);
                rebuild();
                paint();
              });
              return h("label", { class: "gx-folder" + (parentOff ? " is-inherited" : ""), style: { paddingLeft: 6 + depth * 12 + "px" } }, box, h("span", { text: f.slice(f.lastIndexOf("/") + 1) }));
            }));
          };
          if (filter) filter.addEventListener("input", paint);
          paint();
          b.append(h("div", { class: "gx-subhead" }, h("span", { text: "Exclude folders" }), S.exclude.length ? h("button", { class: "gx-link", onclick: () => { set("exclude", []); rebuild(); renderPanel(); } }, "Clear") : null), filter, list);
        }
        if (hidden.size) b.append(h("button", { class: "gx-chip is-wide", onclick: showHidden }, icon("eye"), `Show ${plural(hidden.size, "hidden node")}`));
      }, filterCount ? String(filterCount) : ""),
      section("groups", "Groups", (b) => {
        b.append(segmented([["none", "None"], ["folder", "Folder"], ["tag", "Tag"], ["rules", "Custom"]], S.colorBy, (v) => {
          set("colorBy", v);
          set("hiddenGroups", []);
          regroup();
          updateEmphasis();
          renderPanel();
          kick();
        }));
        if (S.colorBy === "rules") {
          const regroupSoon = debounce(() => { regroup(); runSearch(true); kick(); }, 180);
          S.rules.forEach((r, idx) => {
            const color = h("input", { type: "color", class: "gx-color", value: r.color });
            color.addEventListener("input", () => { r.color = color.value; persist(); regroup(); kick(); });
            const q = h("input", { class: "gx-input", type: "text", value: r.q, placeholder: "path:Projects  #idea  words", spellcheck: false });
            q.addEventListener("input", () => { r.q = q.value; persist(); regroupSoon(); });
            q.addEventListener("keydown", (e) => e.stopPropagation());
            b.append(h("div", { class: "gx-rule" }, color, q, h("button", {
              class: "gx-icon-btn", title: "Remove group",
              onclick: () => { S.rules.splice(idx, 1); persist(); regroup(); renderPanel(); kick(); },
            }, icon("x"))));
          });
          b.append(h("button", {
            class: "gx-chip is-wide",
            onclick: () => {
              const palette = ["#5b9cf6", "#3fbfa8", "#ee6b8b", "#9b87f5", "#7cc36a", "#e98a4f"];
              S.rules.push({ q: "", color: palette[S.rules.length % palette.length] });
              persist();
              renderPanel();
              const inputs = sections.querySelectorAll(".gx-rule .gx-input");
              if (inputs.length) inputs[inputs.length - 1].focus();
            },
          }, icon("plus"), "Add group"));
          b.append(h("div", { class: "gx-hint", text: "The first matching group colours a note. path:, tag:, file:, -word to exclude." }));
        } else if (S.colorBy === "folder") {
          b.append(sliderRow("Folder depth", "folderDepth", 1, 4, 1, (v) => (v === 1 ? "Top folders" : `${v} levels`), () => { regroup(); updateEmphasis(); kick(); }));
          const chips = [
            ...S.splitFolders.map((f) => ["Split", f, () => setFolderRules({ split: S.splitFolders.filter((x) => x !== f), own: S.ownFolders })]),
            ...S.ownFolders.map((f) => ["One group", f, () => setFolderRules({ split: S.splitFolders, own: S.ownFolders.filter((x) => x !== f) })]),
          ];
          if (chips.length) {
            b.append(h("div", { class: "gx-subhead" }, h("span", { text: "Folder rules" }), h("button", { class: "gx-link", onclick: () => setFolderRules({ split: [], own: [] }) }, "Clear")),
              h("div", { class: "gx-rulechips" }, chips.map(([kind, f, drop]) => h("span", { class: "gx-rulechip", title: `${kind}: ${f}` },
                h("span", { class: "gx-rulechip-k", text: kind }), h("span", { class: "gx-rulechip-t", text: f }),
                h("button", { class: "gx-icon-btn is-tiny", title: "Remove rule", onclick: drop }, icon("x"))))));
          }
          b.append(h("div", { class: "gx-hint", text: "Click a group to hide it. Right-click it to split a folder into its subfolders or merge one back." }));
        } else if (S.colorBy !== "none") {
          b.append(h("div", { class: "gx-hint", text: "Click a group in the legend to hide it." }));
        }
      }, S.colorBy === "rules" && S.rules.length ? String(S.rules.length) : ""),
      section("comments", "Comments", (b) => {
        frameListEl = h("div", { class: "gx-frames" });
        paintFrameList();
        b.append(frameListEl, h("div", { class: "gx-btnrow" },
          h("button", { class: "gx-chip", title: "Frame the selection in a comment (C)", onclick: () => commentAround() }, icon("square"), "Add comment")));
      }, frames.length ? String(frames.length) : ""),
      section("homes", "Homes", (b) => {
        homeListEl = h("div", { class: "gx-frames gx-homes" });
        paintHomeList();
        const outliers = pins.size ? pinnedOutliers().length : 0;
        b.append(homeListEl, h("div", { class: "gx-pair" }, toggleRow("Halos", "homeHalos", () => kick()), toggleRow("Names", "homeNames", () => kick())),
          h("div", { class: "gx-btnrow" },
            h("button", { class: "gx-chip", disabled: !selIdx.length || !homesOn(), title: "Give the selected notes a home where they are", onclick: () => homeWithUndo(selIdx.slice(), null, "The selection has a home") }, icon("home"), "Home for selection"),
            outliers ? h("button", { class: "gx-chip", title: "Pinned notes outside the pool become homes, one per cluster", onclick: homesForPinned }, icon("pin"), `Pinned (${outliers})`) : null));
      }, homes.size ? String(homes.size) : ""),
      section("lens", "Reading lens", (b) => {
        b.append(
          h("button", {
            class: "gx-row", role: "switch", "aria-checked": String(lens.on),
            onclick: () => toggleLens(),
          }, icon("search"), h("span", { class: "gx-row-label", text: "Lens (M)" }), h("span", { class: "switch" + (lens.on ? " is-on" : "") })),
          toggleRow("Might belong together", "lensHints", () => { lens.refreshHints(); kick(); }, "sparkles"),
          h("div", { class: "gx-btnrow" },
            h("button", { class: "gx-chip", disabled: !lens.pinnable(), title: "Pin every open card (Ctrl+Shift+P, or Shift-click a card's pin)", onclick: () => pinAllCards(true) }, icon("pin"), "Pin all"),
            h("button", { class: "gx-chip", disabled: !lens.unpinnable(), title: "Let every card go (Ctrl+Shift+U, or Alt-click a card's pin)", onclick: () => pinAllCards(false) }, icon("x"), "Unpin all")),
          h("button", {
            class: "gx-chip is-wide", title: "Size, how many cards, how long they linger — also on a right-click in the graph",
            onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); lens.settings(r.right, r.top); },
          }, icon("settings"), "Lens settings…"),
          h("div", { class: "gx-hint", text: "Hover a note to read it. Drag the link handle onto another card or note to write a link; hold Shift to link both ways, and Ctrl+Z takes the last link back." }),
        );
      }, lens.on ? "On" : ""),
      // Display was one long section; it is three now, each folding on its own
      section("display", "Display", (b) => {
        b.append(
          h("div", { class: "gx-seglabel", text: "Look" }),
          segmented([["plain", "Plain"], ["pirates", "Pirates", "ship"], ["space", "Space", "rocket"]], S.look, (v) => { set("look", v); ships.length = 0; kick(); renderPanel(); }),
          S.look !== "plain" ? toggleRow(S.look === "space" ? "Spaceships" : "Ships", "ships", () => { ships.length = 0; kick(); renderPanel(); }) : null,
          S.look !== "plain" && S.ships ? sliderRow("How many", "shipCount", 0, 100, 1, (v) => String(v), () => kick(), 1000) : null,
          S.look !== "plain" && S.ships ? toggleRow("Size by zoom", "shipZoom", () => kick()) : null,
          toggleRow("Double-click opens beside", "dblSide", () => {}, "columns"),
          toggleRow("Fog of war", "fog", () => { fogAt = 0; kick(); renderPanel(); }, "cloud"),
          S.fog ? sliderRow("Fog after", "fogDays", 7, 365, 1, (v) => `${v} days`, () => { fogAt = 0; kick(); }) : null,
        );
      }),
      section("displayNodes", "Nodes and labels", (b) => {
        const resize2 = () => { sizeNodes(); kick(); };
        b.append(
          toggleRow("Size by links", "sizeByLinks", resize2),
          toggleRow("Arrows", "arrows", () => kick()),
          sliderRow("Node size", "nodeSize", 0.4, 3, 0.05, (v) => v.toFixed(2) + "×", resize2),
          sliderRow("Label size", "labelSize", 0.6, 2.5, 0.05, (v) => v.toFixed(2) + "×", () => kick()),
          sliderRow("Link thickness", "linkWidth", 0.2, 4, 0.05, (v) => v.toFixed(2) + "×", () => kick()),
          sliderRow("Labels from zoom", "textFade", 0.2, 3, 0.05, (v) => Math.round(v * 100) + "%", () => kick()),
        );
      }),
      section("displayLinks", "Links and bridges", (b) => {
        const vis2 = () => { setHiddenGroups(S.hiddenGroups); if (bridgeSel) { bridgeSel = makeBridgeSel(bridgeSel.kind, bridgeSel.key); renderBridges(); updateEmphasis(); } };
        b.append(
          h("div", { class: "gx-seglabel", text: "Bridges run between" }),
          segmented([["homes", "Homes"], ["groups", "Groups"], ["both", "Both"]], S.crossBy, (v) => {
            set("crossBy", v);
            countBridges();
            vis2();
            renderPanel();
          }),
          toggleRow("Highlight bridges", "crossLinks", () => { kick(); renderPanel(); }, "link"),
          S.crossLinks ? segmented([["line", "Line"], ["dashed", "Dash"], ["gradient", "Colour"], ["glow", "Glow"]], S.linkStyle, (v) => { set("linkStyle", v); kick(); renderPanel(); }) : null,
          S.crossLinks ? segmented([["curve", "Curved"], ["straight", "Straight"]], S.bridgeCurve ? "curve" : "straight", (v) => { set("bridgeCurve", v === "curve"); kick(); renderPanel(); }) : null,
          toggleRow("Trade routes between homes", "routes", () => kick(), "link"),
          toggleRow("Hide links inside", "hideInner", () => kick()),
          toggleRow("Only show bridges", "bridgesOnly", () => { vis2(); kick(); }),
          !bridgeN ? h("div", { class: "gx-hint", text: S.crossBy === "homes" ? (homes.size ? "No links between homes and the pool." : "No homes yet. Drag a cluster out of the pool to give it one.") : "No links between colour groups." }) : null,
        );
      }, bridgeN ? plural(bridgeN, "bridge") : ""),
      section("forces", "Forces", (b) => {
        const again = () => { syncForces(); heat(0.5); };
        b.append(
          sliderRow("Repel", "repel", 0.1, 4, 0.05, (v) => v.toFixed(2), again),
          sliderRow("Link distance", "linkDistance", 15, 300, 1, (v) => String(Math.round(v)), again),
          sliderRow("Gravity", "gravity", 0, 4, 0.05, (v) => v.toFixed(2), again),
          sliderRow("Home pull", "homePull", 0, 4, 0.05, (v) => v.toFixed(2), again),
          toggleRow("Dragging pins a note", "dragPins", () => {}, "pin"),
          h("div", { class: "gx-btnrow" },
            h("button", { class: "gx-chip", onclick: reheat }, icon("sparkles"), "Reheat"),
            h("button", { class: "gx-chip", disabled: !pins.size, onclick: unpinAll }, icon("pin"), pins.size ? `Unpin all (${pins.size})` : "Unpin all")),
        );
      }),
    );
  }

  /* ── chrome: hud, legend, selection bar, banner, empty state ─────────── */
  backBtn = h("button", { class: "gx-hud-btn", title: "Back to the view before (Alt+Left, or the mouse's back button)", disabled: true, onclick: goBack }, icon("back"));
  aheadBtn = h("button", { class: "gx-hud-btn", title: "Forward again (Alt+Right)", disabled: true, onclick: goAhead }, icon("forward"));
  wrap.addEventListener("mouseup", (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } else if (e.button === 4) { e.preventDefault(); goAhead(); } });
  hud.append(backBtn, aheadBtn, h("span", { class: "gx-hud-sep" }),
    h("button", { class: "gx-hud-btn", title: "Zoom out (-)", onclick: () => zoomButton(1 / 1.35) }, icon("minus")),
    h("button", { class: "gx-hud-btn", title: "Zoom in (+)", onclick: () => zoomButton(1.35) }, icon("plus")),
    h("span", { class: "gx-hud-sep" }),
    h("button", { class: "gx-hud-btn", title: "Zoom to fit (F)", onclick: () => fit() }, icon("expand")),
  );
  const fitSelBtn = h("button", { class: "gx-hud-btn", title: "Zoom to selection (Shift+F)", onclick: () => fit(selIdx) }, icon("shrink"));
  // how a note is read from the graph: a card on hover, or the reading lens
  const modeBtn = (mode, ico, label, title) => h("button", { class: "gx-mode-btn", dataset: { mode }, title, onclick: () => toggleLens(mode === "lens"),
    oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); lens.settings(e.clientX, e.clientY, mode); } }, icon(ico), h("span", { text: label }));
  const lensBtn = h("div", { class: "gx-mode gx-lens-btn", role: "group", "aria-label": "How notes are read" },
    modeBtn("tip", "fileText", "Cards", "Hover cards: a small card for the note you point at. Right-click for its settings"),
    modeBtn("lens", "search", "Lens", "Reading lens (M): read everything under the glass. Right-click for its settings"));
  function paintReadMode() { for (const b of lensBtn.children) b.classList.toggle("is-on", (b.dataset.mode === "lens") === !!lens.on); }
  // the gear is for whichever view is up: the lens's cards, or the plain hover cards
  const viewSetBtn = h("button", {
    class: "gx-hud-btn",
    title: "Settings for the cards: the hover cards, or the reading lens while it is on",
    onclick: (e) => { if (lens.settingsOpen()) { lens.closeSettings(); return; } const r = e.currentTarget.getBoundingClientRect(); lens.settings(r.left, r.top - 8, lens.on ? "lens" : "tip"); },
  }, icon("settings"));
  const helpBtn = h("button", { class: "gx-hud-btn", title: "Mouse and keys", onclick: () => { helpEl.hidden = !helpEl.hidden; helpBtn.classList.toggle("is-on", !helpEl.hidden); } }, icon("keyboard"));
  hud.append(fitSelBtn, h("span", { class: "gx-hud-sep" }), lensBtn, viewSetBtn, helpBtn);
  helpEl.append(h("div", { class: "gx-help-title", text: "Mouse and keys" }), ...[
    ["Drag", "Select with a box (Shift adds, Ctrl takes away)"],
    ["Drag a note", "Move it; P pins it where it is"],
    ["Right / middle drag", "Pan"],
    ["Wheel", "Zoom at the pointer"],
    ["Shift + wheel", "Pan sideways"],
    ["Right-click", "Menu for a note, comment or the canvas"],
    ["Alt + click", "Open a note to the side"],
    ["Double-click", "Open a note · rename a comment · fit"],
    ["C", "Comment around the selection"],
    ["M", "Switch between hover cards and the reading lens"],
    ["Lens · hover", "Read the note under the pointer on a card"],
    ["Lens · right-click", "Its own settings: size, cards, hints"],
    ["Lens · drag the link", "Drop on a card or note to link them"],
    ["Lens · Shift drop", "Link both notes to each other"],
    ["Ctrl Z  ·  Ctrl Shift Z", "Undo the last link · redo it"],
    ["Ctrl Shift P  ·  U", "Pin every card · let them all go"],
    ["Drag a comment title", "Move it with everything inside"],
    ["Drag a cluster out", "It gets a home and settles round its core"],
    ["Alt + drag a homed note", "Move its whole home (or drag the core)"],
    ["Drag its edge or corner", "Resize"],
    ["F  ·  Shift F", "Fit all · fit the selection"],
    ["/  ·  Esc", "Search · clear"],
  ].map(([k, v]) => h("div", { class: "gx-help-row" }, h("kbd", { text: k }), h("span", { text: v }))));

  function setHiddenGroups(keys) {
    set("hiddenGroups", keys);
    applyHiddenGroups();
    for (const id of [...selected]) {
      const i = G.index.get(id);
      if (i !== undefined && !vis[i]) selected.delete(id);
    }
    syncSelection();
    if (hover >= 0 && !vis[hover]) setHover(-1);
    runSearch(false);
    updateEmphasis();
    renderLegend();
    kick();
  }

  function setLegend(v) {
    set("showLegend", v);
    renderLegend();
  }

  // Legend rows. Folder categories form a tree: a subfolder category sits
  // under its parent folder (a plain header row when the parent is not a
  // category itself) and a parent can be folded.
  function legendRows() {
    const rows = groups.map((g, gi) => ({ g, gi, path: g.key.startsWith("folder:") && g.key.length > 7 ? g.key.slice(7) : null, count: g.count, depth: 0, kids: null }));
    if (S.colorBy !== "folder") return rows;
    const byPath = new Map();
    for (const r of rows) if (r.path) byPath.set(r.path, r);
    if (![...byPath.keys()].some((p) => p.includes("/"))) return rows;
    for (const r of [...byPath.values()]) {
      for (let p = dirname(r.path); p; p = dirname(p)) {
        let a = byPath.get(p);
        if (!a) { a = { g: null, gi: -1, path: p, count: 0, depth: 0, kids: null }; byPath.set(p, a); }
        if (!a.g) a.count += r.g ? r.g.count : 0;
        a.tot = (a.tot || 0) + (r.g ? r.g.count : 0);
      }
    }
    const tops = [];
    for (const r of byPath.values()) {
      r.depth = r.path.split("/").length - 1;
      const par = byPath.get(dirname(r.path));
      if (par) (par.kids || (par.kids = [])).push(r);
      else tops.push(r);
    }
    const out = [];
    const emit = (list) => {
      const size = (r) => (r.g ? r.g.count : 0) + (r.tot || 0);
      list.sort((a, b) => size(b) - size(a) || naturalCompare(a.path, b.path));
      for (const r of list) {
        out.push(r);
        if (r.kids && !legFold.has(r.path)) emit(r.kids);
      }
    };
    emit(tops);
    return out.concat(rows.filter((r) => !r.path));
  }

  // the group keys a row stands for: a header row, every category under it
  const rowKeys = (r) => (r.g ? [r.g.key] : groups.filter((g) => g.key.startsWith("folder:" + r.path + "/")).map((g) => g.key));

  function legendRow(r, off) {
    const keys = rowKeys(r);
    const isOff = keys.length > 0 && keys.every((k) => off.has(k));
    const short = r.path ? r.path.slice(r.path.lastIndexOf("/") + 1) : r.g.label;
    const parent = r.path ? dirname(r.path) : "";
    const label = r.g && !r.path ? r.g.label : short;
    const folded = r.kids && legFold.has(r.path);
    const fold = r.kids
      ? h("span", { class: "gx-leg-fold" + (folded ? "" : " is-open"), title: folded ? "Show subfolders" : "Fold subfolders", onclick: (e) => {
        e.stopPropagation();
        if (folded) legFold.delete(r.path);
        else legFold.add(r.path);
        renderLegend();
      } }, icon("chevron"))
      : r.depth ? h("span", { class: "gx-leg-fold is-leaf" }) : null;
    return h("button", {
      class: "gx-leg" + (isOff ? " is-off" : "") + (r.g ? "" : " is-parent"),
      style: r.depth ? { paddingLeft: 6 + r.depth * 12 + "px" } : null,
      title: `${r.path || label}${parent ? `\nin ${parent}` : ""}\n${plural(r.count, "node")}. ${isOff ? "Click to show" : "Click to hide"}, Alt+click to show only this, right-click for more`,
      onclick: (e) => {
        if (e.altKey) return setHiddenGroups(groups.filter((x) => !keys.includes(x.key)).map((x) => x.key));
        const next = new Set(S.hiddenGroups);
        for (const k of keys) { if (isOff) next.delete(k); else next.add(k); }
        setHiddenGroups([...next]);
      },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); legendMenu(r, keys, isOff, e.clientX, e.clientY); },
    }, fold,
    r.g ? h("span", { class: "gx-sw is-" + (r.g.kind || "note"), style: { "--c": gColor[r.gi] } }) : icon("folder", "gx-leg-ico"),
    h("span", { class: "gx-leg-t", text: label }), h("span", { class: "gx-leg-n", text: r.count.toLocaleString() }));
  }

  function legendMenu(r, keys, isOff, x, y) {
    const p = r.path;
    const items = [{ header: p || r.g.label, plain: true }];
    if (p && S.colorBy === "folder") {
      const parent = dirname(p);
      if (r.g && !S.splitFolders.includes(p) && subfoldersOf(p)) items.push({ label: "Split into subfolders", icon: "grid", run: () => splitFolder(p) });
      if (r.kids) items.push({ label: "Join subfolders into this", icon: "shrink", run: () => joinFolder(p) });
      if (parent) items.push({ label: `Merge back into ‘${parent.slice(parent.lastIndexOf("/") + 1)}’`, icon: "undo", run: () => mergeFolder(p) });
      if (r.kids) items.push({ label: legFold.has(p) ? "Unfold" : "Fold", icon: "chevronDown", run: () => { if (legFold.has(p)) legFold.delete(p); else legFold.add(p); renderLegend(); renderPanel(); } });
      items.push("sep");
    }
    items.push(
      { label: isOff ? "Show" : "Hide", icon: "eye", run: () => { const next = new Set(S.hiddenGroups); for (const k of keys) { if (isOff) next.delete(k); else next.add(k); } setHiddenGroups([...next]); } },
      { label: "Show only this", icon: "focus", run: () => setHiddenGroups(groups.filter((g) => !keys.includes(g.key)).map((g) => g.key)) },
      keys.length === 1 && r.g && r.g.color ? { label: "Show bridges from here", icon: "link", run: () => showBridges("group", keys[0]) } : null,
      { label: "Select its nodes", icon: "check", run: () => {
        const want = new Set(keys);
        selected.clear();
        for (let i = 0; i < n; i++) if (vis[i] && want.has(groups[groupOf[i]].key)) selected.add(G.nodes[i].id);
        syncSelection();
        kick();
      } },
      S.hiddenGroups.length ? { label: "Show all", icon: "eye", run: () => setHiddenGroups([]) } : null,
    );
    app.menu(x, y, items);
  }

  function fillLegend(list) {
    const off = new Set(S.hiddenGroups);
    const rows = legendRows();
    const tree = rows.some((r) => r.depth > 0 || r.kids);
    list.classList.toggle("is-two", !tree && rows.length > 5);
    list.replaceChildren(...rows.map((r) => legendRow(r, off)));
  }

  function renderLegend() {
    const shown = groups.length > 1 || S.hiddenGroups.length > 0;
    legendEl.hidden = !shown;
    if (!shown) return;
    const open = !!S.showLegend;
    legendEl.classList.toggle("is-folded", !open);
    legendHide.title = open ? "Fold the legend" : "Unfold the legend";
    legendList.hidden = !open;
    legendAll.hidden = !S.hiddenGroups.length;
    if (!open) return;
    fillLegend(legendList);
  }

  /* the home list in the panel */
  let homeListEl = null;
  function paintHomeList() {
    if (!homeListEl) return;
    if (!homes.size) {
      homeListEl.replaceChildren(h("div", { class: "gx-hint", text: homesOn()
        ? "Drag a cluster out of the pool and it keeps a home there, centred on its core. Drag the core, or Alt-drag any of its notes, to move it."
        : "Homes rest while the graph is focused around a note." }));
      return;
    }
    const at = new Map(hList.map((hm, k) => [hm.id, k]));
    const counts = new Map();
    for (const hid of homeOf.values()) counts.set(hid, (counts.get(hid) || 0) + 1);
    homeListEl.replaceChildren(...[...homes.values()].map((hm) => {
      const k = at.has(hm.id) ? at.get(hm.id) : -1;
      const name = k >= 0 ? homeName(k) : hm.name || "Home";
      const dot = h("span", { class: "gx-fdot is-home", style: { "--c": k >= 0 ? homeColor(k) : colors.node } });
      const count = h("span", { class: "gx-leg-n", text: (k >= 0 ? hMembers[k].length : counts.get(hm.id) || 0).toLocaleString() });
      if (renaming === hm.id) {
        const input = h("input", { class: "gx-input is-small", type: "text", value: hm.name, placeholder: k >= 0 && hCore[k] >= 0 ? G.nodes[hCore[k]].label : "Home name", spellcheck: false });
        const done = (ok) => {
          if (renaming !== hm.id) return;
          renaming = null;
          if (ok) { hm.name = input.value.replace(/\s+/g, " ").trim().slice(0, 120); hm._lt = null; touch(); kick(); }
          paintHomeList();
          if (bridgeSel) renderBridges();
        };
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); done(true); }
          else if (e.key === "Escape") { e.preventDefault(); done(false); }
        });
        input.addEventListener("blur", () => done(true));
        requestAnimationFrame(() => { input.focus(); input.select(); });
        return h("div", { class: "gx-frame is-active" }, dot, input, count);
      }
      return h("button", {
        class: "gx-frame" + (k >= 0 && k === hHover ? " is-active" : "") + (k < 0 ? " is-away" : ""),
        title: k >= 0 ? "Click to go there, double-click to rename, right-click for more" : "Not in this view",
        onclick: () => { if (k >= 0) flyToHome(k); },
        ondblclick: () => renameHome(hm.id),
        onmouseenter: () => { if (k >= 0 && hHover !== k) { hHover = k; kick(); } },
        onmouseleave: () => { if (hHover >= 0) { hHover = -1; kick(); } },
        oncontextmenu: (e) => { e.preventDefault(); if (k >= 0) homeMenu(k, e.clientX, e.clientY); },
      }, dot, h("span", { class: "gx-frame-t", text: name }), count);
    }));
  }

  /* the comment list in the panel */
  let frameListEl = null;
  function paintFrameList() {
    if (!frameListEl) return;
    if (!frames.length) {
      frameListEl.replaceChildren(h("div", { class: "gx-hint", text: "Select notes and press C to frame them in a comment. Right-click the canvas for an empty one." }));
      return;
    }
    const counts = frames.map((f) => (G ? nodesIn(f, true).length : 0));
    frameListEl.replaceChildren(...frames.map((f, t) => h("button", {
      class: "gx-frame" + (f.id === frameSel ? " is-active" : ""),
      title: (f.note ? f.note + "\n" : "") + "Click to go there, double-click to rename, right-click for more",
      onclick: () => flyToFrame(f),
      ondblclick: () => editFrame(f, "title"),
      oncontextmenu: (e) => { e.preventDefault(); frameMenu(f, e.clientX, e.clientY); },
    }, h("span", { class: "gx-fdot", style: { "--c": frameColor(f.c) } }), h("span", { class: "gx-frame-t", text: f.title || "Comment" }), h("span", { class: "gx-leg-n", text: counts[t].toLocaleString() }))).reverse());
  }
  function renderFrameList() {
    if (frameListEl && frameListEl.isConnected) paintFrameList();
  }

  // a box being dragged changes the selection at every pointer move: the bar is built again only when what it says
  // would change
  let selbarKey = "";
  function paintSelbar() {
    const k = selIdx.length;
    selbar.hidden = k === 0;
    fitSelBtn.disabled = k === 0;
    if (!k) { selbarKey = ""; return; }
    const notesN = selectedNotes().length;
    const key = k + "|" + notesN + "|" + homesOn();
    if (key === selbarKey) return;
    selbarKey = key;
    const grip = h("div", { class: "gx-grip", draggable: "true", title: "Drag to a board or a note" }, icon("drag"));
    grip.addEventListener("dragstart", startDragOut);
    const btn = (ico, label, run, title, primary) => h("button", { class: "gx-sel-btn" + (primary ? " is-primary" : ""), title: title || label, onclick: run }, icon(ico), h("span", { text: label }));
    selbar.replaceChildren(
      grip,
      h("span", { class: "gx-sel-count" }, h("b", { text: k.toLocaleString() }), " selected"),
      h("span", { class: "gx-sel-sep" }),
      btn("sparkles", "Research board", () => openAsBoard(), "Open the selected notes as a research board, laid out as here", true),
      btn("grid", "Add to board", (e) => { const r = e.currentTarget.getBoundingClientRect(); boardMenu(r.left, r.top - 8); }),
      btn("fileText", "Open", () => openInTabs(), notesN > MAX_TABS ? `Open in tabs (first ${MAX_TABS})` : "Open in tabs"),
      btn("panelRight", "Side by side", () => openSideBySide(), app.openSplit ? "Open in the split view, next to the graph" : "Open to the side"),
      btn("square", "Comment", () => commentAround(), "Frame the selection in a comment (C)"),
      homesOn() ? btn("home", "Home", () => makeHome(selIdx.slice()), "Give the selection a home where it is") : null,
      btn("expand", "Expand", expandSelection, "Add their neighbours (E)"),
      btn("focus", "Focus", focusSelection, "Show only the selection"),
      h("span", { class: "gx-sel-sep" }),
      h("button", { class: "gx-icon-btn", title: "Clear selection (Esc)", onclick: clearSelection }, icon("x")),
    );
  }

  function paintChrome() {
    stats.textContent = G ? `${plural(G.stats.notes, "note")} · ${plural(G.stats.links, "link")}` : "";
    stats.title = G ? `${plural(G.stats.notes, "note")} and ${plural(G.stats.links, "link")} shown` : "";
    search.placeholder = picking ? (picking.link ? "Search for the note to link to" : "Search for where the path ends") : "Search the graph";
    // one banner at a time: picking a path end, or a focused selection
    if (picking) {
      const a = G.index.get(picking.from);
      banner.hidden = false;
      const who = h("b", { text: a !== undefined ? G.nodes[a].label : "" });
      banner.replaceChildren(...(picking.link
        ? [icon("link"), h("span", {}, "Link ", who, picking.both ? " both ways to" : " to", ": click a note. Shift links both ways, Ctrl keeps linking, Ctrl+Z takes it back.")]
        : [icon("compass"), h("span", {}, "Path from ", who, ": click the note where it ends, or search")]),
        h("button", { class: "gx-chip", onclick: cancelPick }, "Cancel"));
    } else if (only) {
      banner.hidden = false;
      banner.replaceChildren(icon("focus"), h("span", { text: `Showing ${plural(only.size, "selected note")}` }), h("button", { class: "gx-chip", onclick: exitFocusSelection }, "Show everything"));
    } else banner.hidden = true;
    renderPath();
    renderBridges();
    const none = !G || !G.nodes.length;
    emptyEl.hidden = !none;
    if (none) {
      let msg = "No notes to show";
      let sub = "Create a few notes and link them with [[double brackets]].";
      if (S.scope === "around" && !focusShown) { msg = "No note in focus"; sub = "Open a note, or pick one in Scope, to see what surrounds it."; }
      else if (vault.notes.size) { msg = "Nothing matches these filters"; sub = "Loosen the scope or filters in the panel."; }
      emptyEl.replaceChildren(icon("graph", "gx-empty-ico"), h("div", { class: "gx-empty-t", text: msg }), h("div", { class: "gx-empty-s", text: sub }));
    }
  }

  /* ── vault & app events ──────────────────────────────────────────────── */
  const markDirty = () => {
    dirty = true;
    if (!off()) rebuildSoon();
  };
  const moveId = (from, to) => {
    if (memo.has(from)) { memo.set(to, memo.get(from)); memo.delete(from); }
    if (homeOf.has(from)) { homeOf.set(to, homeOf.get(from)); homeOf.delete(from); }
    for (const s of [pins, selected, hidden]) if (s.has(from)) { s.delete(from); s.add(to); }
    if (only && only.has(from)) { only.delete(from); only.add(to); }
    for (let t = 0; t < crumbs.length; t++) if (crumbs[t] === from) crumbs[t] = to;
    if (focusId === from) focusId = to;
    if (path && path.from === from) path.from = to;
    if (path && path.to === from) path.to = to;
    if (picking && picking.from === from) picking.from = to;
  };
  vault.bus.on("structure", markDirty);
  vault.bus.on("changed", (e) => { if (lens.on && e && e.path) lens.refresh(e.path); if (!e || e.linksChanged) markDirty(); });
  vault.bus.on("renamed", ({ from, to }) => { moveId(from, to); markDirty(); });
  vault.bus.on("fileRenamed", ({ from, to }) => { moveId(from, to); markDirty(); });
  app.bus.on("settings", (k) => {
    if (k === "theme" || k === "accent") { readColors(); if (!off()) kick(); }
  });
  // the system theme can flip without a settings event
  new MutationObserver(() => { readColors(); if (!off()) kick(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const ro = new ResizeObserver(debounce(() => {
    if (off()) return;
    if (resize()) kick();
  }, 40));
  ro.observe(wrap);

  // debug & test handle: document.querySelector(".graph-canvas").graph
  canvas.graph = {
    perf,
    undoable,
    state: () => ({ n, m, alpha, cam: { ...cam }, selected: [...selected], hover, query, matches: matches.length, path: path && { one: path.one.map((i) => G.nodes[i].id), length: path.res.length, paths: path.res.paths }, picking, pins: [...pins], hidden: [...hidden], groups: groups.map((g) => g.label), settings: S, crumbs: [...crumbs], focus: focusShown }),
    screen: (id) => {
      const i = G ? G.index.get(id) : undefined;
      if (i === undefined) return null;
      const r = canvas.getBoundingClientRect();
      return { x: r.left + L.x[i] * cam.k + W / 2 + cam.x, y: r.top + L.y[i] * cam.k + H / 2 + cam.y, r: rad[i] * cam.k };
    },
    ids: () => (G ? G.nodes.map((nd) => nd.id) : []),
    select: (ids) => { selected.clear(); for (const id of ids) selected.add(id); syncSelection(); kick(); },
    path: (a, b) => { startPick(G.index.get(a)); finishPick(G.index.get(b)); },
    frames: () => frames.map((f) => ({ ...cleanFrame(f), nodes: G ? nodesIn(f, false).map((i) => G.nodes[i].id) : [] })),
    comment: (ids, title) => { const list = ids.map((id) => G.index.get(id)).filter((i) => i !== undefined); const f = list.length ? addFrame(frameAround(list.map((i) => ({ x: L.x[i], y: L.y[i], r: rad[i] }))), { title, edit: false }) : null; return f && f.id; },
    frameScreen: (id) => { const f = frameById(id); if (!f) return null; const r = canvas.getBoundingClientRect(); return { x: r.left + f.x * cam.k + W / 2 + cam.x, y: r.top + f.y * cam.k + H / 2 + cam.y, w: f.w * cam.k, h: f.h * cam.k }; },
    world: (id) => { const i = G ? G.index.get(id) : undefined; return i === undefined ? null : { x: L.x[i], y: L.y[i] }; },
    fade: () => ({ dimT, dimGoal, swapT, emphHover }),
    save: () => { saveDirty = true; saveNow(); return writeGraphDoc({ pos: memo, pins, frames, cam, homes, homeOf }, alive, []); },
    homes: () => hList.map((hm, k) => ({ ...cleanHome(hm), core: hCore[k] >= 0 ? G.nodes[hCore[k]].id : null, size: hMembers[k].length, halo: { x: hcx[k], y: hcy[k], r: hr[k] } })),
    homeOf: (id) => homeOf.get(id) || null,
    ships: () => { const r = canvas.getBoundingClientRect(); return ships.map((sh) => { const p = shipAt(sh); return p && { x: r.left + p.x * cam.k + W / 2 + cam.x, y: r.top + p.y * cam.k + H / 2 + cam.y, to: sh.to, wait: !!sh.wait }; }); },
    makeHome: (ids, name) => { const list = ids.map((id) => G.index.get(id)).filter((i) => i !== undefined); const hm = makeHome(list, null, name || ""); return hm && hm.id; },
    toPool: (ids) => sendToPool(ids.map((id) => G.index.get(id)).filter((i) => i !== undefined)),
    pool: () => (G ? poolNow(null) : null),
    bridges: (kind, key) => { showBridges(kind, key); return bridgeSel && { edges: bridgeSel.edges.length, other: bridgeSel.other.size }; },
    bridgeCount: () => bridgeN,
    node: (id) => { const i = G ? G.index.get(id) : undefined; return i === undefined ? null : { x: L.x[i], y: L.y[i], pull: L.pull[i], fixed: L.fixed[i], home: L.home[i], hw: L.hw[i] }; },
    homeScreen: (id) => { const k = hList.findIndex((hm) => hm.id === id); if (k < 0) return null; const r = canvas.getBoundingClientRect(); return { x: r.left + hcx[k] * cam.k + W / 2 + cam.x, y: r.top + hcy[k] * cam.k + H / 2 + cam.y, r: hr[k] * cam.k, ax: r.left + hList[k].x * cam.k + W / 2 + cam.x, ay: r.top + hList[k].y * cam.k + H / 2 + cam.y }; },

    lens: {
      on: () => lens.on,
      toggle: (v) => toggleLens(v),
      cards: () => lens.state(),
      hover: (id) => {
        const i = G ? G.index.get(id) : undefined;
        if (i === undefined) return;
        setHover(i);
        lens.moved(L.x[i] * cam.k + W / 2 + cam.x, L.y[i] * cam.k + H / 2 + cam.y);
      },
      at: (sx, sy) => lens.moved(sx, sy),
      linking: () => lens.linking(),
      settings: (x, y) => lens.settings(x, y),
      settingsOpen: () => lens.settingsOpen(),
      pinAll: (v) => pinAllCards(v),
      stacks: () => lens.stacks(),
      undo: () => lens.undoLink(),
      redo: () => lens.redoLink(),
      pin: (id) => lens.pin(id),
      close: () => lens.closeAll(),
      link: (a, b, both) => lens.linkTo(a, b, both),
      handle: (id) => { const el2 = lens.cardEl(id); const q = el2 && el2.querySelector(".gx-lc-link"); if (!q) return null; const r = q.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
      body: (id) => { const el2 = lens.cardEl(id); const q = el2 && el2.querySelector(".gx-lc-body"); return q ? { top: q.scrollTop, room: q.scrollHeight - q.clientHeight, rect: q.getBoundingClientRect().toJSON() } : null; },
    },
    loaded: () => loaded,
    settle: () => { for (let t = 0; t < 400 && alpha > 0; t++) { alpha += (alphaTarget - alpha) * ALPHA_DECAY; if (alpha < ALPHA_MIN) alpha = 0; L.step(alpha || ALPHA_MIN, forces); } gridStale = true; saveMemo(); if (!tween) autoFit = true; kick(); },
  };

  // the lens survives a restart, so pick it up from the saved settings
  if (S.lens) { lens.setOn(true); wrap.classList.add("is-lens"); }
  paintReadMode();

  readColors();
  renderPanel();
  paintSelbar();
  paintSearch();

  function show() {
    // the first build waits (briefly) for the saved layout
    if (!loaded && !G) {
      waiting = true;
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => { if (waiting && !off()) { waited = true; show(); } }, 600);
      if (!waited) return;
    }
    waiting = false;
    fogAt = 0;
    if (S.look !== "plain") { sailUntil = performance.now() + SAIL_MS; kick(); } // shown again: the ships set off
    readColors();
    resize();
    const current = app.lastNotePath ? app.lastNotePath() : null;
    const follow = S.scope === "around" && !focusId && current !== focusShown;
    if (follow) autoFit = true;
    if (dirty || !G || follow) {
      rebuild();
      renderPanel();
    } else {
      gridStale = true;
      kick();
    }
  }

  // the members changed (another workspace): build afresh and fit
  function rescope(fit = true) { dirty = true; if (fit) autoFit = true; if (!off()) show(); }
  return { show, rescope };
}
