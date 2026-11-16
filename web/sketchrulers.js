// Sketch's measuring tools: rulers in real units, guides pulled out of them,
// the Measure tool, exact sizes for the selection, live readouts while
// drawing, and dimension lines that keep themselves up to date.
//
// sketch.js owns the canvas and the elements; this file gets what it needs
// through `ctx` and adds its own DOM (two ruler strips, two small bars). The
// numbers all come from sketchmeasure.js, which is pure and tested — nothing
// here does arithmetic a test cannot see.
//
// Everything stays an ordinary Excalidraw drawing. A dimension is an arrow
// with a text label and a `customData.leoDim` marker; the units, the scale and
// the guides live in `appState.leoMeasure`. Open the file in Excalidraw and
// you see arrows with numbers on them, and lose nothing by saving it there.

import * as MS from "./sketchmeasure.js";

const RULER = 22;
const INK = "#15aabf"; // measurement colour: reads on a dark canvas and a light one
const INK_SOFT = "rgba(21,170,191,0.14)";
const GUIDE = "#22b8cf";
const FONT = '600 11px "Inter Variable", "Segoe UI", system-ui, sans-serif';
const SMALL = '500 10px "Inter Variable", "Segoe UI", system-ui, sans-serif';
const TINY = '500 8.5px "Inter Variable", "Segoe UI", system-ui, sans-serif';

export function mountMeasure(ctx) {
  const { root, h, ic, M, scene, els, byId, view, ptr } = ctx;
  let cfg = MS.measureOf(scene.appState);
  let destroyed = false;
  let mode = ctx.setting("sketchMeasureMode", "distance");
  if (!["distance", "path", "angle"].includes(mode)) mode = "distance";
  /** The measurement on screen: { pts, done, closed } in world coordinates. */
  let m = null;
  let snapHit = null; // the key point the pointer is locked to
  let snapNear = []; // the key points around the pointer, shown while measuring
  let edgeHint = null; // { x, y, ex, ey }: edges of a picture found near the pointer (world)
  const edgeCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  edgeCtx.canvas.width = edgeCtx.canvas.height = 48;

  /**
   * A visible edge in a picture near the pointer: the picture around it is
   * sampled 48x48 and the column and the row where the brightness jumps most
   * are taken as edges, when the jump is clear. Cheap enough per pointer move.
   * ponytail: axis-aligned pictures only; a rotated picture gets no edges.
   */
  function pictureEdges(wx, wy) {
    if (!ctx.getImage) return null;
    let e = null;
    for (let i = els.length - 1; i >= 0; i--) { const x = els[i]; if (!x.isDeleted && x.type === "image" && !x.angle && wx >= x.x && wx <= x.x + x.width && wy >= x.y && wy <= x.y + x.height) { e = x; break; } }
    if (!e) return null;
    const img = ctx.getImage(e.fileId);
    if (!img) return null;
    const half = 24 / view.k; // world px each side: the same on screen at any zoom
    const kx = img.naturalWidth / e.width;
    const ky = img.naturalHeight / e.height;
    try {
      edgeCtx.clearRect(0, 0, 48, 48);
      edgeCtx.drawImage(img, (wx - half - e.x) * kx, (wy - half - e.y) * ky, half * 2 * kx, half * 2 * ky, 0, 0, 48, 48);
      const d = edgeCtx.getImageData(0, 0, 48, 48).data;
      const L = new Float32Array(48 * 48);
      for (let i = 0; i < 48 * 48; i++) L[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) * (d[i * 4 + 3] / 255);
      const col = new Float32Array(47);
      const row = new Float32Array(47);
      for (let y = 0; y < 48; y++) for (let x = 0; x < 47; x++) { col[x] += Math.abs(L[y * 48 + x + 1] - L[y * 48 + x]); row[x] += Math.abs(L[(x + 1) * 48 + y] - L[x * 48 + y]); }
      const best = (arr) => { let bi = -1, bv = 0, sum = 0; for (let i = 0; i < 47; i++) { sum += arr[i]; if (arr[i] > bv) { bv = arr[i]; bi = i; } } return bv > 48 * 18 && bv > (sum / 47) * 4 ? bi + 1 : -1; };
      const cx = best(col);
      const cy = best(row);
      if (cx < 0 && cy < 0) return null;
      return { x: cx < 0 ? null : wx - half + (cx / 48) * half * 2, y: cy < 0 ? null : wy - half + (cy / 48) * half * 2, half };
    } catch { return null; }
  }
  let lastDistance = 0; // px, for "set the scale from this"
  let guideDrag = null; // { index, axis, isNew }
  let paintRaf = 0;
  let theme = null;

  /* ── DOM ────────────────────────────────────────────────────────────── */
  const topRuler = h("canvas", { class: "sk-ruler sk-ruler-top", title: "Drag down from here for a horizontal guide" });
  const leftRuler = h("canvas", { class: "sk-ruler sk-ruler-left", title: "Drag right from here for a vertical guide" });
  const corner = h("button", { class: "sk-ruler-corner", tabindex: "-1", title: "Units and drawing scale", onclick: (e) => openUnits(e.currentTarget) });
  const bar = h("div", { class: "sk-measurebar sk-glass", hidden: true });
  const geo = h("div", { class: "sk-geo sk-glass", hidden: true });
  root.append(topRuler, leftRuler, corner, bar, geo);

  // replaceChildren prints a missing piece as the word "null"; every bar here has optional pieces
  const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

  const save = (patch) => { cfg = MS.setMeasure(scene.appState, patch); ctx.markChanged(); };

  function readTheme() {
    const cs = getComputedStyle(root);
    const g = (n, d) => cs.getPropertyValue(n).trim() || d;
    theme = { bg: g("--surface", "#1b1b1f"), ink: g("--text-3", "#9a9aa2"), faint: g("--text-4", "#6d6d75"), line: g("--line-strong", "rgba(128,128,128,.4)"), accent: g("--accent", "#e0a84a") };
  }

  /* ── precision mode ─────────────────────────────────────────────────── */

  function applyOn() {
    root.classList.toggle("has-rulers", cfg.on);
    for (const el of [topRuler, leftRuler, corner]) el.hidden = !cfg.on;
    corner.textContent = cfg.unit === "ft-in" ? "ft" : (MS.UNIT_BY_ID.get(cfg.unit) || MS.UNITS[0]).short;
    paintSoon();
    renderBars();
    ctx.invalidate(false);
  }

  function toggle(force) {
    const on = force === undefined ? !cfg.on : !!force;
    save({ on });
    applyOn();
    ctx.invalidate(true); // the kept dimensions change hands between the renderer and this overlay
    ctx.toast(on ? "Rulers and exact sizes on (Shift R). Drag a guide out of a ruler; U measures." : "Rulers off", { ms: 2600 });
  }

  /* ── rulers ─────────────────────────────────────────────────────────── */

  const paintSoon = () => { if (!paintRaf && !destroyed) paintRaf = requestAnimationFrame(() => { paintRaf = 0; paintRulers(); }); };

  function sizeCanvas(c, w, hh) {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(hh * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; c.style.width = w + "px"; c.style.height = hh + "px"; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  function paintRulers() {
    if (destroyed || !cfg.on) return;
    if (!theme) readTheme();
    const { W, H } = ctx.size();
    if (W < 40 || H < 40) return;
    const k = view.k;
    const sel = ctx.selectedEls();
    const sb = sel.length ? M.commonBounds(sel) : null;

    // across the top
    let g = sizeCanvas(topRuler, W - RULER, RULER);
    g.clearRect(0, 0, W, RULER);
    g.fillStyle = theme.bg;
    g.fillRect(0, 0, W, RULER);
    if (sb) { g.fillStyle = INK_SOFT; g.fillRect(ctx.toScreenX(sb[0]) - RULER, 0, (sb[2] - sb[0]) * k, RULER); }
    g.strokeStyle = theme.line;
    g.fillStyle = theme.ink;
    g.font = SMALL;
    g.textBaseline = "top";
    g.beginPath();
    for (const t of MS.rulerTicks(cfg, ctx.toWorldX(RULER), ctx.toWorldX(W), k)) {
      const x = Math.round(ctx.toScreenX(t.at) - RULER) + 0.5;
      g.moveTo(x, RULER);
      g.lineTo(x, t.major ? 8 : RULER - 5);
      if (t.label !== null) g.fillText(t.label, x + 3, 2);
    }
    g.moveTo(0, RULER - 0.5);
    g.lineTo(W, RULER - 0.5);
    g.stroke();
    for (const gd of cfg.guides) if (gd.axis === "x") marker(g, ctx.toScreenX(gd.at) - RULER, RULER, "down");
    if (ptr.inside) { g.fillStyle = theme.accent; g.fillRect(Math.round(ptr.sx - RULER), 0, 1, RULER); }

    // down the side
    g = sizeCanvas(leftRuler, RULER, H - RULER);
    g.clearRect(0, 0, RULER, H);
    g.fillStyle = theme.bg;
    g.fillRect(0, 0, RULER, H);
    if (sb) { g.fillStyle = INK_SOFT; g.fillRect(0, ctx.toScreenY(sb[1]) - RULER, RULER, (sb[3] - sb[1]) * k); }
    g.strokeStyle = theme.line;
    g.fillStyle = theme.ink;
    g.font = SMALL;
    g.textBaseline = "top";
    g.beginPath();
    for (const t of MS.rulerTicks(cfg, ctx.toWorldY(RULER), ctx.toWorldY(H), k)) {
      const y = Math.round(ctx.toScreenY(t.at) - RULER) + 0.5;
      g.moveTo(RULER, y);
      g.lineTo(t.major ? 8 : RULER - 5, y);
      if (t.label !== null) { g.save(); g.translate(2, y - 3); g.rotate(-Math.PI / 2); g.fillText(t.label, 0, 0); g.restore(); }
    }
    g.moveTo(RULER - 0.5, 0);
    g.lineTo(RULER - 0.5, H);
    g.stroke();
    for (const gd of cfg.guides) if (gd.axis === "y") marker(g, RULER, ctx.toScreenY(gd.at) - RULER, "right");
    if (ptr.inside) { g.fillStyle = theme.accent; g.fillRect(0, Math.round(ptr.sy - RULER), RULER, 1); }
  }

  function marker(g, x, y, dir) {
    g.save();
    g.fillStyle = GUIDE;
    g.beginPath();
    if (dir === "down") { g.moveTo(x - 4.5, y - 8); g.lineTo(x + 4.5, y - 8); g.lineTo(x, y - 1); } else { g.moveTo(x - 8, y - 4.5); g.lineTo(x - 8, y + 4.5); g.lineTo(x - 1, y); }
    g.closePath();
    g.fill();
    g.restore();
  }

  /* guides, pulled out of the rulers */

  const smallTick = () => { const step = MS.niceStep(cfg, view.k); return MS.fromUnits(step / MS.subdivisions(step, cfg), cfg); };

  /** A guide lands on a clean ruler mark unless Ctrl says otherwise. */
  function guidePosition(world, free) {
    if (free) return world;
    const t = smallTick();
    return Math.round(world / t) * t;
  }

  function rulerDown(e, which) {
    if (ctx.readOnly) return;
    e.preventDefault();
    const canvas = e.currentTarget;
    const r = root.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    // the top ruler shows vertical guides: grab one that is there, or pull a new horizontal one down
    const own = which === "top" ? "x" : "y";
    const pos = which === "top" ? sx : sy;
    let index = cfg.guides.findIndex((g) => g.axis === own && Math.abs((own === "x" ? ctx.toScreenX(g.at) : ctx.toScreenY(g.at)) - pos) <= 6);
    let isNew = false;
    const guides = cfg.guides.slice();
    if (index < 0) {
      isNew = true;
      guides.push({ axis: which === "top" ? "y" : "x", at: which === "top" ? ctx.toWorldY(sy) : ctx.toWorldX(sx) });
      index = guides.length - 1;
      cfg = { ...cfg, guides };
    }
    guideDrag = { index, axis: cfg.guides[index].axis, isNew };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const move = (ev) => {
      const rr = root.getBoundingClientRect();
      const x = ev.clientX - rr.left;
      const y = ev.clientY - rr.top;
      const gd = cfg.guides[guideDrag.index];
      gd.at = guidePosition(gd.axis === "x" ? ctx.toWorldX(x) : ctx.toWorldY(y), ev.ctrlKey || ev.metaKey);
      guideDrag.out = gd.axis === "x" ? x < RULER : y < RULER;
      ctx.showHint(guideDrag.out ? "Let go here to remove the guide" : `${gd.axis === "x" ? "X" : "Y"} ${MS.formatLength(gd.at, cfg)}`);
      paintSoon();
      ctx.invalidate(false);
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      const gd = guideDrag;
      guideDrag = null;
      ctx.hideHint();
      const list = cfg.guides.slice();
      // dropped back on a ruler: a new one never was, an old one is removed
      if (gd.out) list.splice(gd.index, 1);
      save({ guides: list });
      paintSoon();
      ctx.invalidate(false);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    move(e);
  }

  function rulerDouble(e, which) {
    const r = root.getBoundingClientRect();
    const own = which === "top" ? "x" : "y";
    const pos = which === "top" ? e.clientX - r.left : e.clientY - r.top;
    const index = cfg.guides.findIndex((g) => g.axis === own && Math.abs((own === "x" ? ctx.toScreenX(g.at) : ctx.toScreenY(g.at)) - pos) <= 6);
    if (index < 0) return;
    const input = h("input", { class: "sk-geo-in is-wide", value: MS.formatLength(cfg.guides[index].at, cfg, { unit: false }), spellcheck: false });
    const apply = () => {
      const px = MS.parseLength(input.value, cfg);
      if (px === null) return ctx.toast("That is not a length", { ms: 1600 });
      const list = cfg.guides.slice();
      list[index] = { ...list[index], at: px };
      save({ guides: list });
      ctx.closePop();
      paintSoon();
      ctx.invalidate(false);
    };
    input.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") apply(); if (ev.key === "Escape") ctx.closePop(); });
    ctx.openPop(null, [h("div", { class: "sk-sec-label", text: `Guide at ${own.toUpperCase()} =` }), h("div", { class: "sk-row" }, input,
      h("button", { class: "sk-textbtn", onclick: apply }, "Set"),
      h("button", { class: "sk-textbtn", onclick: () => { save({ guides: cfg.guides.filter((_, i) => i !== index) }); ctx.closePop(); paintSoon(); ctx.invalidate(false); } }, "Remove"))],
    "sk-pop-keep", { x: e.clientX - r.left + 8, y: e.clientY - r.top + 8 });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  topRuler.addEventListener("pointerdown", (e) => rulerDown(e, "top"));
  leftRuler.addEventListener("pointerdown", (e) => rulerDown(e, "left"));
  topRuler.addEventListener("dblclick", (e) => rulerDouble(e, "top"));
  leftRuler.addEventListener("dblclick", (e) => rulerDouble(e, "left"));

  /** Guides as things shapes snap to: a box with no thickness, good on one axis only. */
  function guideCandidates(viewport) {
    const out = [];
    for (const g of cfg.guides) {
      const c = g.axis === "x" ? [g.at, viewport[1], g.at, viewport[3]] : [viewport[0], g.at, viewport[2], g.at];
      c.axis = g.axis;
      out.push(c);
    }
    return out;
  }

  /** A point pulled onto any guide it is within a few pixels of. */
  function snapToGuides(x, y) {
    if (!cfg.guides.length) return [x, y];
    const t = 6 / view.k;
    let bx = t;
    let by = t;
    let nx = x;
    let ny = y;
    for (const g of cfg.guides) {
      if (g.axis === "x" && Math.abs(g.at - x) <= bx) { bx = Math.abs(g.at - x); nx = g.at; }
      if (g.axis === "y" && Math.abs(g.at - y) <= by) { by = Math.abs(g.at - y); ny = g.at; }
    }
    return [nx, ny];
  }

  /* ── snapping a measurement to the drawing ──────────────────────────── */

  function snapAt(wx, wy) {
    snapHit = null;
    if (ptr.ctrl) return [wx, wy];
    const vp = ctx.viewport();
    const t = 10 / view.k;
    const cands = [];
    let n = 0;
    for (let i = els.length - 1; i >= 0 && n < 500; i--) {
      const e = els[i];
      if (e.isDeleted || (e.type === "text" && e.containerId)) continue;
      const b = M.elementBounds(e);
      if (b[2] < vp[0] - t || b[0] > vp[2] + t || b[3] < vp[1] - t || b[1] > vp[3] + t) continue;
      if (wx < b[0] - t || wx > b[2] + t || wy < b[1] - t || wy > b[3] + t) continue;
      n++;
      for (const p of MS.keyPoints(e)) cands.push(p);
    }
    // where two guides cross, and the guides themselves
    for (const gx of cfg.guides) if (gx.axis === "x") for (const gy of cfg.guides) if (gy.axis === "y") cands.push({ x: gx.at, y: gy.at, kind: "guide" });
    const near = 90 / view.k;
    snapNear = cands.filter((p) => Math.abs(p.x - wx) < near && Math.abs(p.y - wy) < near).slice(0, 80);
    const hit = MS.snapPoint(wx, wy, cands, t);
    edgeHint = hit ? null : pictureEdges(wx, wy);
    if (hit) { snapHit = hit; return [hit.x, hit.y]; }
    let x = wx;
    let y = wy;
    // an edge in a picture: lines of a screenshot, the side of a button
    if (edgeHint) {
      if (edgeHint.x != null && Math.abs(edgeHint.x - wx) <= t) x = edgeHint.x;
      if (edgeHint.y != null && Math.abs(edgeHint.y - wy) <= t) y = edgeHint.y;
      if (x !== wx || y !== wy) { snapHit = { x, y, kind: "edge" }; return [x, y]; }
    }
    for (const g of cfg.guides) {
      if (g.axis === "x" && Math.abs(g.at - wx) <= t) x = g.at;
      if (g.axis === "y" && Math.abs(g.at - wy) <= t) y = g.at;
    }
    if (x === wx && y === wy && ctx.gridOn()) { x = M.snapToGrid(wx, ctx.gridSize()); y = M.snapToGrid(wy, ctx.gridSize()); }
    return [x, y];
  }

  /** Where the pointer is for the measurement in progress: snapped, and held to 15° with Shift. */
  function livePoint() {
    let p = snapAt(ptr.wx, ptr.wy);
    if (ptr.shift && m && m.pts.length) {
      const a = m.pts[m.pts.length - 1];
      p = M.snapAngle(a[0], a[1], ptr.wx, ptr.wy);
      snapHit = null;
    }
    return p;
  }

  /* ── the Measure tool ───────────────────────────────────────────────── */

  function setMode(next) {
    mode = next;
    ctx.saveSetting("sketchMeasureMode", mode);
    m = null;
    renderBars();
    ctx.invalidate(false);
  }

  function finish(closed = false) {
    if (!m) return;
    m.done = true;
    m.closed = closed;
    m.live = null;
    if (mode === "distance" && m.pts.length === 2) lastDistance = MS.segment(m.pts[0], m.pts[1]).length;
    ctx.hideHint();
    renderBars();
    ctx.invalidate(false);
  }

  /** The kept dimension under the pointer: { e, end } with end 0 or 1 at one of its dots, -1 along its body. */
  function dimUnder() {
    const slop = 11 / view.k;
    const t = 7 / view.k;
    for (const e of [...els].reverse()) {
      if (!isDim(e) || !e.points || e.points.length !== 2 || e.locked) continue;
      const a = M.absolutePoints(e);
      for (const i of [0, 1]) if (Math.hypot(a[i][0] - ptr.wx, a[i][1] - ptr.wy) <= slop) return { e, end: i };
      if (M.distToSegment(ptr.wx, ptr.wy, a[0][0], a[0][1], a[1][0], a[1][1]) <= t) return { e, end: -1 };
    }
    return null;
  }
  /** A dimension's end being dragged: onto a key point, a picture's edge or a guide, unless the toggle is off or Ctrl is held. */
  function snapEnd(wx, wy) {
    if (cfg.snapEnds === false) { snapHit = null; return null; }
    const p = snapAt(wx, wy);
    ctx.invalidate(false);
    return p;
  }
  const endDone = () => { snapHit = null; snapNear = []; edgeHint = null; ctx.invalidate(false); };
  const hoverCursor = () => { if (m && !m.done) return null; const d = dimUnder(); return d ? (d.end >= 0 ? "pointer" : "move") : null; };

  function down() {
    const p = livePoint();
    // a press on a kept dimension takes hold of it: an end is dragged, the body moved - not measured again
    if (!m || m.done) {
      const hit = dimUnder();
      if (hit) {
        const label = M.boundTextOf(hit.e, byId);
        ctx.setSelection(label ? [hit.e.id, label.id] : [hit.e.id]);
        if (hit.end >= 0) ctx.startPointDrag(hit.e, hit.end); else ctx.startMove();
        return;
      }
    }
    if (!m || m.done) {
      m = { pts: [p], done: false, closed: false, live: p };
      const sx = ptr.sx;
      const sy = ptr.sy;
      if (mode === "distance") {
        // drag for a quick measurement; a plain click waits for the second click
        ctx.setGesture({
          type: "measure",
          hideHandles: true,
          frame() { if (m && !m.done) m.live = livePoint(); },
          up() {
            if (!m || m.done) return;
            if (Math.hypot(ptr.sx - sx, ptr.sy - sy) >= 6) { m.pts.push(livePoint()); finish(); } else ctx.showHint("Click the other end. Shift holds the angle, Ctrl ignores snapping");
          },
          cancel() { m = null; },
        });
      } else {
        ctx.showHint(mode === "path" ? "Click along the path. Click the first point to close it and get an area; Enter to finish" : "Click the corner of the angle, then the other side");
      }
      renderBars();
      ctx.invalidate(false);
      return;
    }
    if (mode === "distance") { m.pts.push(p); return finish(); }
    if (mode === "angle") { m.pts.push(p); if (m.pts.length === 3) finish(); else ctx.invalidate(false); return; }
    // a path: the first point closes it, the last point ends it
    const first = m.pts[0];
    const last = m.pts[m.pts.length - 1];
    const near = (q) => Math.hypot(q[0] - p[0], q[1] - p[1]) * view.k < 9;
    if (m.pts.length >= 3 && near(first)) return finish(true);
    if (near(last)) return finish(false);
    m.pts.push(p);
    renderBars();
    ctx.invalidate(false);
  }

  function pointerMoved() {
    if (cfg.on) paintSoon();
    if (ctx.tool() !== "measure") return;
    if (m && !m.done) m.live = livePoint(); else snapAt(ptr.wx, ptr.wy);
    ctx.invalidate(false);
    if (m && !m.done) renderReadout();
  }

  function enter() {
    if (ctx.tool() !== "measure" || !m) return false;
    if (m.done) { keepAsDimension(); return true; }
    if (mode === "path" && m.pts.length >= 2) { finish(false); return true; }
    return false;
  }

  function escape() {
    if (ctx.tool() !== "measure") return false;
    if (m) { m = null; snapHit = null; ctx.hideHint(); renderBars(); ctx.invalidate(false); return true; }
    return false;
  }

  /** Along a line on screen: ticks every step of the drawing's unit (major ones taller), ½ in the middle, ¼ and ¾ when there is room. nx, ny: 6 px across the line. */
  function rulerMarks(c, a, b, nx, ny, { colour = INK, quiet = false, labels = false } = {}) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const stepU = MS.niceStep(cfg, view.k, 48);
    const step = MS.fromUnits(stepU, cfg);
    const sub = MS.subdivisions(stepU, cfg);
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    // the labelled ticks carry their count in the drawing's unit, so nobody counts centimetres in their head
    const lx = -nx / 6; const ly = -ny / 6; // across the line, away from the ticks, per px
    for (let i = 1, d = (step / sub) * view.k; i * d < len - 2; i++) {
      const t = i % sub === 0 ? 0.75 : 0.4;
      const p = [a[0] + ux * i * d, a[1] + uy * i * d];
      strokeLine(c, [[p[0], p[1]], [p[0] + nx * t, p[1] + ny * t]], { width: 1, colour });
      if (labels && i % sub === 0 && i * d < len - 14) {
        const text = MS.formatLength((i / sub) * step, cfg, { unit: false }).replace(/([.,]\d*?)0+$/, "$1").replace(/[.,]$/, "");
        c.save();
        c.font = TINY;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillStyle = colour;
        c.globalAlpha = 0.9;
        c.fillText(text, p[0] + lx * 17, p[1] + ly * 17); // well clear of the line
        c.restore();
      }
    }
    for (const [f, l, w] of [[0.5, "½", 1.2], [0.25, "¼", 0.9], [0.75, "¾", 0.9]]) {
      if (f !== 0.5 && len <= 120) continue;
      const q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      strokeLine(c, [[q[0] - nx * w, q[1] - ny * w], [q[0] + nx * w, q[1] + ny * w]], { width: f === 0.5 ? 1.5 : 1, colour });
      if (!quiet || f === 0.5) pill(c, l, q[0] - nx * 2.6, q[1] - ny * 2.6, { bg: f === 0.5 ? "rgba(20,24,28,0.78)" : "rgba(20,24,28,0.6)", font: SMALL });
    }
  }
  /** The picture (or frame) both ends of a line are inside - the topmost one. */
  function pictureUnder(p, q) {
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.isDeleted || (e.type !== "image" && e.type !== "frame" && e.type !== "rectangle")) continue;
      const inside = (pt) => pt[0] >= e.x && pt[0] <= e.x + e.width && pt[1] >= e.y && pt[1] <= e.y + e.height;
      if (inside(p) && inside(q)) return { x: e.x, y: e.y, w: e.width, h: e.height };
    }
    return null;
  }
  /** The numbers for what is on screen, live or finished. */
  function result() {
    if (!m) return null;
    const pts = m.done || !m.live ? m.pts : [...m.pts, m.live];
    if (mode === "distance") {
      if (pts.length < 2) return null;
      const s = MS.segment(pts[0], pts[1]);
      return { kind: "distance", ...s, text: [["Length", MS.formatLength(s.length, cfg)], ["ΔX", MS.formatLength(Math.abs(s.dx), cfg)], ["ΔY", MS.formatLength(Math.abs(s.dy), cfg)], ["Angle", MS.formatAngle(s.angle)]] };
    }
    if (mode === "angle") {
      if (pts.length < 3) return pts.length === 2 ? { kind: "angle", text: [["First side", MS.formatLength(MS.segment(pts[0], pts[1]).length, cfg)]] } : null;
      // the corner is the second click
      const a = MS.angleAt(pts[0], pts[1], pts[2]);
      return { kind: "angle", angle: a, text: [["Angle", MS.formatAngle(a)], ["The other way round", MS.formatAngle(Math.PI * 2 - a)]] };
    }
    if (pts.length < 2) return null;
    const pm = MS.pathMetrics(pts, m.closed);
    const text = [[m.closed ? "Perimeter" : "Length", MS.formatLength(pm.length, cfg)]];
    if (m.closed) text.push(["Area", MS.formatArea(pm.area, cfg)]);
    text.push([m.closed ? "Corners" : "Segments", String(m.closed ? pts.length : pts.length - 1)]);
    return { kind: "path", ...pm, text };
  }

  /* ── drawing the measurement ────────────────────────────────────────── */

  function pill(c, text, x, y, { bg = INK, fg = "#fff", font = FONT, align = "center" } = {}) {
    c.save();
    c.font = font;
    const w = c.measureText(text).width + 12;
    const hh = 18;
    const left = align === "center" ? x - w / 2 : x;
    c.fillStyle = bg;
    c.beginPath();
    c.roundRect(Math.round(left), Math.round(y - hh / 2), Math.round(w), hh, 6);
    c.fill();
    c.fillStyle = fg;
    c.textBaseline = "middle";
    c.textAlign = "left";
    c.fillText(text, Math.round(left) + 6, Math.round(y) + 0.5);
    c.restore();
    return w;
  }

  const S = (p) => [ctx.toScreenX(p[0]), ctx.toScreenY(p[1])];

  function strokeLine(c, pts, { dash = null, width = 2, colour = INK, closed = false } = {}) {
    if (pts.length < 2) return;
    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    if (closed) c.closePath();
    // a pale under-stroke, so the line reads over any picture
    c.strokeStyle = "rgba(255,255,255,0.55)";
    c.lineWidth = width + 2;
    if (!dash) c.stroke();
    c.strokeStyle = colour;
    c.lineWidth = width;
    if (dash) c.setLineDash(dash);
    c.stroke();
    c.restore();
  }

  function dot(c, p, r = 3.5) {
    c.save();
    c.beginPath();
    c.arc(p[0], p[1], r, 0, Math.PI * 2);
    c.fillStyle = "#fff";
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 1.6;
    c.stroke();
    c.restore();
  }

  /** Screen-space drawing, called from the overlay once it is back in pixels. */
  function drawScreen(c) {
    const { W, H } = ctx.size();
    // guides
    if (cfg.guides.length && (cfg.on || ctx.tool() === "measure")) {
      c.save();
      c.strokeStyle = GUIDE;
      c.globalAlpha = 0.85;
      c.lineWidth = 1;
      c.beginPath();
      for (const g of cfg.guides) {
        if (g.axis === "x") { const x = Math.round(ctx.toScreenX(g.at)) + 0.5; c.moveTo(x, 0); c.lineTo(x, H); } else { const y = Math.round(ctx.toScreenY(g.at)) + 0.5; c.moveTo(0, y); c.lineTo(W, y); }
      }
      c.stroke();
      c.restore();
    }
    if (ctx.tool() === "measure") drawMeasurement(c);
    // kept dimensions carry the same marks as a live measurement
    // Kept dimensions: while rulers are on or the tool is Measure, the
    // renderer leaves them out and they are drawn here exactly like a live
    // measurement - a hairline, bar ends, unit ticks, a pill with the number.
    if (drawsDims()) for (const e of els) {
      if (!isDim(e) || !e.points || e.points.length !== 2) continue;
      const wa = [e.x + e.points[0][0], e.y + e.points[0][1]];
      const wb = [e.x + e.points[1][0], e.y + e.points[1][1]];
      const a = S(wa);
      const b = S(wb);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 4) continue;
      const colour = M.themeColor(e.strokeColor, ctx.dark ? ctx.dark() : true);
      const nx = (-(b[1] - a[1]) / len) * 6;
      const ny = ((b[0] - a[0]) / len) * 6;
      const picked = ctx.selected.has(e.id);
      c.save();
      c.globalAlpha = picked ? 1 : 0.85;
      strokeLine(c, [a, b], { width: picked ? 2 : 1.25, colour });
      strokeLine(c, [[a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny]], { width: 1.5, colour });
      strokeLine(c, [[b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny]], { width: 1.5, colour });
      const marks = cfg.tickLabels || "sel";
      if (len > 40) rulerMarks(c, a, b, nx * 0.8, ny * 0.8, { colour, quiet: true, labels: marks === "all" || (marks === "sel" && picked) });
      pill(c, MS.formatLength(MS.segment(wa, wb).length, cfg), (a[0] + b[0]) / 2 + nx * 2.4, (a[1] + b[1]) / 2 + ny * 2.4, { bg: colour, fg: "#fff" });
      c.restore();
    }
    else if (cfg.on) drawGestureReadout(c);
  }

  function drawMeasurement(c) {
    // the points nearby a measurement could lock to
    if (snapNear.length) {
      c.save();
      c.fillStyle = INK;
      c.globalAlpha = 0.45;
      for (const p of snapNear) {
        if (snapHit && p.x === snapHit.x && p.y === snapHit.y) continue;
        const [x, y] = S([p.x, p.y]);
        c.beginPath();
        c.arc(x, y, p.kind === "quarter" ? 1.8 : 2.6, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
    // edges found in the picture under the pointer: two faint lines
    if (edgeHint) {
      const r = edgeHint.half * view.k;
      c.save();
      c.strokeStyle = INK;
      c.globalAlpha = 0.5;
      c.setLineDash([3, 3]);
      c.lineWidth = 1;
      c.beginPath();
      if (edgeHint.x != null) { const x = ctx.toScreenX(edgeHint.x); const y = ctx.toScreenY(ptr.wy); c.moveTo(x, y - r); c.lineTo(x, y + r); }
      if (edgeHint.y != null) { const y = ctx.toScreenY(edgeHint.y); const x = ctx.toScreenX(ptr.wx); c.moveTo(x - r, y); c.lineTo(x + r, y); }
      c.stroke();
      c.restore();
    }
    // what the pointer is locked to
    if (snapHit) {
      const [x, y] = S([snapHit.x, snapHit.y]);
      c.save();
      c.strokeStyle = INK;
      c.lineWidth = 1.5;
      c.beginPath();
      if (snapHit.kind === "midpoint") { c.moveTo(x, y - 6); c.lineTo(x + 6, y + 5); c.lineTo(x - 6, y + 5); c.closePath(); }
      else if (snapHit.kind === "quarter") { c.moveTo(x, y - 5); c.lineTo(x + 5, y); c.lineTo(x, y + 5); c.lineTo(x - 5, y); c.closePath(); }
      else if (snapHit.kind === "edge") { c.moveTo(x - 7, y); c.lineTo(x + 7, y); c.moveTo(x, y - 7); c.lineTo(x, y + 7); } else if (snapHit.kind === "centre" || snapHit.kind === "quadrant") c.arc(x, y, 6, 0, Math.PI * 2);
      else c.rect(x - 5.5, y - 5.5, 11, 11);
      c.stroke();
      c.restore();
      pill(c, snapHit.kind, x + 12, y - 14, { bg: "rgba(20,24,28,0.82)", font: SMALL, align: "left" });
    }
    if (!m) return;
    const world = m.done || !m.live ? m.pts : [...m.pts, m.live];
    const pts = world.map(S);
    if (mode === "distance") {
      if (pts.length < 2) { dot(c, pts[0]); return; }
      const [a, b] = pts;
      const s = MS.segment(world[0], world[1]);
      const slanted = Math.abs(s.dx) * view.k > 14 && Math.abs(s.dy) * view.k > 14;
      if (slanted) {
        // the right triangle under the line: how far across, how far up
        const k = [b[0], a[1]];
        strokeLine(c, [a, k, b], { dash: [4, 4], width: 1 });
        pill(c, MS.formatLength(Math.abs(s.dx), cfg), (a[0] + k[0]) / 2, a[1] + (b[1] > a[1] ? -13 : 13), { bg: "rgba(20,24,28,0.78)", font: SMALL });
        pill(c, MS.formatLength(Math.abs(s.dy), cfg), k[0] + (b[0] > a[0] ? 8 : -8), (a[1] + b[1]) / 2, { bg: "rgba(20,24,28,0.78)", font: SMALL, align: b[0] > a[0] ? "left" : "center" });
        const r = Math.min(34, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.4);
        c.save();
        c.strokeStyle = INK;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(a[0], a[1], r, 0, -s.angle, s.angle <= Math.PI);
        c.stroke();
        c.restore();
      }
      strokeLine(c, [a, b]);
      // end ticks, square to the line
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = (-(b[1] - a[1]) / len) * 6;
      const ny = ((b[0] - a[0]) / len) * 6;
      strokeLine(c, [[a[0] - nx, a[1] - ny], [a[0] + nx, a[1] + ny]]);
      strokeLine(c, [[b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny]]);
      pill(c, `${MS.formatLength(s.length, cfg)}${slanted ? "  ·  " + MS.formatAngle(s.angle) : ""}`, (a[0] + b[0]) / 2 + nx * 2.4, (a[1] + b[1]) / 2 + ny * 2.4);
      rulerMarks(c, a, b, nx, ny, { labels: (cfg.tickLabels || "sel") !== "off" });
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // and - when it lies along a picture - the room left on either side of it
      const box = pictureUnder(world[0], world[1]);
      if (box && !slanted) {
        const horiz = Math.abs(s.dx) >= Math.abs(s.dy);
        const lo = horiz ? Math.min(world[0][0], world[1][0]) - box.x : Math.min(world[0][1], world[1][1]) - box.y;
        const hi = horiz ? box.x + box.w - Math.max(world[0][0], world[1][0]) : box.y + box.h - Math.max(world[0][1], world[1][1]);
        const same = Math.abs(lo - hi) <= Math.max(0.5, (horiz ? box.w : box.h) * 0.004);
        const text = `${horiz ? "◀" : "▲"} ${MS.formatLength(lo, cfg)}   ${same ? "centred" : ""}   ${MS.formatLength(hi, cfg)} ${horiz ? "▶" : "▼"}`;
        pill(c, text.replace(/\s{2,}/g, "  "), mid[0] - nx * 5.2, mid[1] - ny * 5.2, { bg: same ? "rgba(21,170,191,0.9)" : "rgba(20,24,28,0.78)", font: SMALL });
      }
      return;
    }
    if (mode === "angle") {
      if (pts.length >= 2) strokeLine(c, [pts[0], pts[1]]);
      if (pts.length >= 3) {
        strokeLine(c, [pts[1], pts[2]]);
        const v = pts[1];
        const a0 = Math.atan2(pts[0][1] - v[1], pts[0][0] - v[0]);
        const a1 = Math.atan2(pts[2][1] - v[1], pts[2][0] - v[0]);
        let d = a1 - a0;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const r = Math.max(18, Math.min(46, Math.min(Math.hypot(pts[0][0] - v[0], pts[0][1] - v[1]), Math.hypot(pts[2][0] - v[0], pts[2][1] - v[1])) * 0.5));
        c.save();
        c.beginPath();
        c.moveTo(v[0], v[1]);
        c.arc(v[0], v[1], r, a0, a0 + d, d < 0);
        c.closePath();
        c.fillStyle = INK_SOFT;
        c.fill();
        c.strokeStyle = INK;
        c.lineWidth = 1.5;
        c.stroke();
        c.restore();
        const mid = a0 + d / 2;
        pill(c, MS.formatAngle(MS.angleAt(world[0], world[1], world[2])), v[0] + Math.cos(mid) * (r + 22), v[1] + Math.sin(mid) * (r + 22));
      }
      for (const p of pts) dot(c, p);
      return;
    }
    // a path
    if (m.closed && pts.length >= 3) {
      c.save();
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
      c.closePath();
      c.fillStyle = INK_SOFT;
      c.fill();
      c.restore();
    }
    strokeLine(c, pts, { closed: m.closed });
    const n = m.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 46) continue;
      pill(c, MS.formatLength(Math.hypot(world[(i + 1) % world.length][0] - world[i][0], world[(i + 1) % world.length][1] - world[i][1]), cfg), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { bg: "rgba(20,24,28,0.78)", font: SMALL });
    }
    for (const p of pts) dot(c, p);
    const pm = MS.pathMetrics(world, m.closed);
    if (m.closed) {
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      pill(c, MS.formatArea(pm.area, cfg), cx, cy);
    } else if (pts.length > 2) {
      const last = pts[pts.length - 1];
      pill(c, "Σ " + MS.formatLength(pm.length, cfg), last[0] + 14, last[1] - 16, { align: "left" });
    }
  }

  /** While something is being drawn, resized or moved: its size, by the pointer. */
  function drawGestureReadout(c) {
    const g = ctx.gesture();
    const draft = ctx.draft();
    if (!g && !draft) return;
    let text = null;
    if (draft || (g && g.type === "linear")) {
      const e = draft ? draft.el : ctx.liveElements()[0];
      if (!e || !e.points || e.points.length < 2) return;
      const abs = M.absolutePoints(e);
      const s = MS.segment(abs[abs.length - 2], abs[abs.length - 1]);
      text = `${MS.formatLength(s.length, cfg)}  ·  ${MS.formatAngle(s.angle)}`;
      if (abs.length > 2) text += `  ·  Σ ${MS.formatLength(M.polylineLength(abs), cfg)}`;
    } else if (g.type === "create" || g.type === "resize") {
      const list = ctx.liveElements().filter((e) => !(e.type === "text" && e.containerId));
      if (!list.length) return;
      const b = list.length === 1 && g.type === "create" ? null : M.commonBounds(list);
      const w = b ? b[2] - b[0] : list[0].width;
      const hh = b ? b[3] - b[1] : list[0].height;
      text = `${MS.formatLength(w, cfg, { unit: false })} × ${MS.formatLength(hh, cfg)}`;
    } else if (g.type === "move") {
      const list = ctx.liveElements().filter((e) => !(e.type === "text" && e.containerId));
      if (!list.length) return;
      const b = M.commonBounds(list);
      text = `X ${MS.formatLength(b[0], cfg, { unit: false })}   Y ${MS.formatLength(b[1], cfg)}`;
    } else if (g.type === "rotate") {
      const e = ctx.liveElements()[0];
      if (e) text = MS.formatAngle(((e.angle || 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2));
    }
    if (text) pill(c, text, ptr.sx + 16, ptr.sy + 22, { bg: "rgba(20,24,28,0.86)", align: "left" });
  }

  /* ── the bars ───────────────────────────────────────────────────────── */

  const scaleText = () => (cfg.unit === "px" ? "pixels" : `${cfg.unit === "ft-in" ? "ft / in" : cfg.unit} · ${cfg.calibrated ? "calibrated" : MS.scaleLabel(cfg.scale)}`);
  const textBtn = (label, title, run, cls = "") => h("button", { class: "sk-textbtn " + cls, title, tabindex: "-1", onclick: run }, label);
  let readoutEl = null;

  function renderReadout() {
    if (!readoutEl) return;
    const r = result();
    readoutEl.replaceChildren(...(r ? r.text.map(([k, v]) => h("span", { class: "sk-mb-item" }, h("i", { text: k }), h("b", { text: v }))) : [h("span", { class: "sk-mb-hint", text: mode === "distance" ? "Drag, or click two points" : mode === "path" ? "Click along a path or round a room" : "Click a side, the corner, the other side" })]));
  }

  function renderBars() {
    if (destroyed) return;
    const measuring = ctx.tool() === "measure";
    bar.hidden = !measuring;
    root.classList.toggle("is-measuring", measuring);
    if (measuring) {
      const r = result();
      readoutEl = h("div", { class: "sk-mb-read" });
      bar.replaceChildren(...[
        h("div", { class: "sk-mb-modes" }, ...[["distance", "Distance"], ["path", "Path and area"], ["angle", "Angle"]].map(([id, label]) =>
          textBtn(label, "", () => setMode(id), mode === id ? "is-on" : ""))),
        readoutEl,
        m && m.done && r ? textBtn("Copy", "Copy these numbers", () => { navigator.clipboard.writeText(r.text.map(([k, v]) => `${k}: ${v}`).join("\n")).catch(() => {}); ctx.toast("Copied", { ms: 1200 }); }) : null,
        m && m.done && mode !== "angle" && !ctx.readOnly ? textBtn("Keep as a dimension", "Leave this on the drawing as a dimension line that updates itself", keepAsDimension) : null,
        m && m.done && mode === "distance" && !ctx.readOnly ? textBtn("Set scale…", "You know how long this really is: make the whole drawing agree", (e) => openCalibrate(e.currentTarget, lastDistance)) : null,
        textBtn("Snap ends", "A dimension's ends snap to corners, centres, picture edges and guides while you drag them (Ctrl skips it)", () => { save({ snapEnds: cfg.snapEnds === false }); renderBars(); }, cfg.snapEnds === false ? "" : "is-on"),
        h("div", { class: "sk-mb-modes", title: "Numbers on the ruler's ticks: never, on the picked dimension only, or on every dimension" }, ...[["off", "Off"], ["sel", "Picked"], ["all", "All"]].map(([id, label]) =>
          textBtn(label, "", () => { save({ tickLabels: id }); renderBars(); ctx.invalidate(); }, (cfg.tickLabels || "sel") === id ? "is-on" : ""))),
        textBtn(scaleText(), "Units and drawing scale", (e) => openUnits(e.currentTarget), "is-units")].filter(Boolean));
      renderReadout();
    }
    renderGeo();
  }

  /* exact sizes for the selection */

  function renderGeo() {
    const sel = ctx.selectedEls().filter((e) => !(e.type === "text" && e.containerId));
    const show = cfg.on && !ctx.readOnly && sel.length > 0 && ctx.tool() === "select" && !ctx.gesture();
    geo.hidden = !show;
    if (!show) return;
    // typing in a box must not be interrupted by a re-render
    if (geo.contains(document.activeElement)) return;
    const f = ctx.selectionFrame();
    if (!f) { geo.hidden = true; return; }
    const kids = [];
    const field = (label, value, title, apply, wide = false) => {
      const input = h("input", { class: "sk-geo-in" + (wide ? " is-wide" : ""), value, title, spellcheck: false, tabindex: "-1" });
      const go = () => { if (input.value !== value) apply(input.value); };
      input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); go(); input.blur(); ctx.focus(); } if (e.key === "Escape") { input.value = value; input.blur(); ctx.focus(); } });
      input.addEventListener("change", go);
      input.addEventListener("focus", () => input.select());
      return h("label", { class: "sk-geo-field" }, h("span", { text: label }), input);
    };
    const len = (px) => MS.formatLength(px, cfg, { unit: false });
    const asLen = (fn) => (text) => { const px = MS.parseLength(text, cfg); if (px === null) return ctx.toast(`"${text}" is not a length. Try 120, 12.5 cm or 7' 6"`, { ms: 2600 }); fn(px); };
    const single = sel.length === 1 ? sel[0] : null;
    if (single && (single.type === "line" || single.type === "arrow") && single.points.length === 2 && !(single.angle)) {
      const abs = M.absolutePoints(single);
      const s = MS.segment(abs[0], abs[1]);
      kids.push(
        field("X", len(abs[0][0]), "Where the line starts", asLen((px) => setLine(single, { x: px }))),
        field("Y", len(abs[0][1]), "Where the line starts", asLen((px) => setLine(single, { y: px }))),
        field("Length", len(s.length), "Type the exact length. The start stays where it is.", asLen((px) => setLine(single, { length: px })), true),
        field("Angle", MS.formatAngle(s.angle).replace("°", ""), "Degrees, anticlockwise from the right", (t) => { const d = Number(String(t).replace(/[°\s]/g, "").replace(",", ".")); if (Number.isFinite(d)) setLine(single, { angle: (d * Math.PI) / 180 }); }));
    } else {
      const w = f.points ? M.commonBounds(sel)[2] - M.commonBounds(sel)[0] : f.x2 - f.x1;
      const hh = f.points ? M.commonBounds(sel)[3] - M.commonBounds(sel)[1] : f.y2 - f.y1;
      const x = f.points ? M.commonBounds(sel)[0] : f.x1;
      const y = f.points ? M.commonBounds(sel)[1] : f.y1;
      kids.push(
        field("X", len(x), "Left edge", asLen((px) => setBox({ x: px }))),
        field("Y", len(y), "Top edge", asLen((px) => setBox({ y: px }))),
        field("W", len(w), "Width. Type a number, or one with a unit: 12.5 cm", asLen((px) => setBox({ w: px }))),
        field("H", len(hh), "Height", asLen((px) => setBox({ h: px }))));
      if (single && !single.points && single.type !== "frame") kids.push(field("∠", MS.formatAngle(((single.angle || 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)).replace("°", ""), "Rotation in degrees, clockwise", (t) => { const d = Number(String(t).replace(/[°\s]/g, "").replace(",", ".")); if (Number.isFinite(d)) setAngle(single, (d * Math.PI) / 180); }));
    }
    const unitChip = textBtn(scaleText(), "Units and drawing scale", (e) => openUnits(e.currentTarget), "is-units");
    const met = single ? MS.elementMetrics(single) : null;
    const facts = [];
    if (met && met.area > 0) facts.push(`Area ${MS.formatArea(met.area, cfg)}`, `Perimeter ${MS.formatLength(met.perimeter, cfg)}`);
    else if (met && met.length > 0 && single.points.length > 2) facts.push(`Length ${MS.formatLength(met.length, cfg)}`);
    geo.classList.toggle("is-imperial", cfg.unit === "ft-in");
    geo.replaceChildren(...[...kids,
      facts.length ? h("span", { class: "sk-geo-facts", text: facts.join("  ·  ") }) : null,
      textBtn("Dimension", "Put dimension lines beside this. Each one re-measures itself whenever its ends are moved.", () => dimensionSelection()),
      unitChip].filter(Boolean));
  }

  function withUndo(list, fn) {
    const all = ctx.withBound(list);
    const ids = new Set(all.map((e) => e.id));
    const arrows = ctx.arrowsBoundTo(ids).filter((a) => !ids.has(a.id));
    const before = ctx.snap([...all, ...ctx.withBound(arrows)]);
    fn(all, before, ids);
    ctx.refreshArrows(ids, ids);
    ctx.assignFrames(all);
    ctx.commit(before);
    ctx.invalidate();
    ctx.schedulePanel();
    paintSoon();
  }

  function setBox(patch) {
    const list = ctx.selectedEls().filter((e) => !e.locked);
    const f = ctx.selectionFrame();
    if (!list.length || !f) return;
    const b = f.points ? (() => { const c = M.commonBounds(list); return { x1: c[0], y1: c[1], x2: c[2], y2: c[3], angle: 0 }; })() : f;
    const box0 = { x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, angle: b.angle || 0 };
    withUndo(list, (all, before) => {
      if (patch.x !== undefined || patch.y !== undefined) {
        const dx = patch.x !== undefined ? patch.x - box0.x : 0;
        const dy = patch.y !== undefined ? patch.y - box0.y : 0;
        ctx.moveBy(all, dx, dy);
        for (const e of all) M.bumpVersion(e);
        return;
      }
      const w = Math.max(1e-3, patch.w !== undefined ? patch.w : box0.width);
      const hh = Math.max(1e-3, patch.h !== undefined ? patch.h : box0.height);
      // a turned shape grows about its middle, so it stays where it is; a straight one keeps its top-left corner
      const nb = box0.angle
        ? { x: box0.x + (box0.width - w) / 2, y: box0.y + (box0.height - hh) / 2, width: w, height: hh, flipX: false, flipY: false }
        : { x: box0.x, y: box0.y, width: w, height: hh, flipX: false, flipY: false };
      if (list.length === 1 && !f.points) ctx.resizeOne(list[0], before.get(list[0].id), nb, box0);
      else ctx.resizeMany(all, before, box0, nb);
    });
  }

  function setAngle(e, rad) {
    if (e.locked) return;
    withUndo([e], () => { e.angle = rad; M.bumpVersion(e); const t = M.boundTextOf(e, byId); if (t) { t.angle = rad; M.bumpVersion(t); } ctx.relayout(e); });
  }

  function setLine(e, patch) {
    if (e.locked) return;
    withUndo([e], () => {
      const abs = M.absolutePoints(e);
      let [a, b] = abs;
      if (patch.x !== undefined || patch.y !== undefined) {
        const dx = patch.x !== undefined ? patch.x - a[0] : 0;
        const dy = patch.y !== undefined ? patch.y - a[1] : 0;
        a = [a[0] + dx, a[1] + dy];
        b = [b[0] + dx, b[1] + dy];
      } else {
        const s = MS.segment(a, b);
        const L = patch.length !== undefined ? Math.max(1e-3, patch.length) : s.length;
        const th = patch.angle !== undefined ? patch.angle : s.angle;
        b = [a[0] + Math.cos(th) * L, a[1] - Math.sin(th) * L];
      }
      Object.assign(e, M.linearFromAbsolute(e, [a, b]));
      // a line somebody has sized by hand is no longer held to a shape
      if (patch.x === undefined && patch.y === undefined) e.endBinding = null;
      M.bumpVersion(e);
      if (e.boundElements) ctx.relayout(e);
    });
  }

  /* ── dimensions ─────────────────────────────────────────────────────── */

  const isDim = (e) => !!(e && !e.isDeleted && e.type === "arrow" && e.customData && e.customData.leoDim);

  /** Whether the overlay draws the kept dimensions itself (the renderer then leaves them out). */
  // always: the same elegant line whether rulers are on or not (the file still holds a plain arrow for Excalidraw)
  const drawsDims = () => true;
  /** One dimension line from a to b (world). Returns the arrow; the caller commits. */
  function makeDimension(a, b, before, { heads = "bar" } = {}) {
    const style = ctx.style();
    const e = M.newElement("arrow", {
      x: a[0], y: a[1], points: [[0, 0], [b[0] - a[0], b[1] - a[1]]],
      startArrowhead: heads, endArrowhead: heads, roughness: 0, strokeWidth: 1, strokeStyle: "solid", roundness: null,
      customData: { leoDim: { auto: true } },
    }, style);
    Object.assign(e, M.linearFromAbsolute(e, [a, b]));
    const text = MS.dimensionText([a, b], cfg);
    const t = M.newElement("text", {
      containerId: e.id, textAlign: "center", verticalAlign: "middle", fontSize: 14, fontFamily: M.FONT_NORMAL,
      strokeColor: e.strokeColor, text, originalText: text, lineHeight: M.defaultLineHeight(M.FONT_NORMAL),
    }, style);
    ctx.addElement(e);
    ctx.addElement(t, e);
    ctx.addBoundRef(e, t.id, "text");
    ctx.relayout(e);
    before.set(e.id, { ...e, isDeleted: true });
    before.set(t.id, { ...t, isDeleted: true });
    return e;
  }

  function keepAsDimension() {
    if (!m || !m.done || ctx.readOnly) return;
    const before = new Map();
    const made = [];
    const pts = m.pts;
    if (mode === "distance") made.push(makeDimension(pts[0], pts[1], before));
    else {
      const n = m.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) made.push(makeDimension(pts[i], pts[(i + 1) % pts.length], before));
    }
    const selBefore = [...ctx.selected];
    m = null;
    snapHit = null;
    ctx.commit(before, { selBefore });
    ctx.invalidate();
    renderBars();
    ctx.toast(made.length === 1 ? "Kept. Measure the next one, or Esc to leave the tool; with Select, move its ends and the number follows." : `${made.length} dimension lines kept`, { ms: 3200 });
  }

  /** Width and height for a shape, or a parallel line for a line, set a little way off it. */
  function dimensionSelection() {
    const list = ctx.selectedEls().filter((e) => !(e.type === "text" && e.containerId) && !isDim(e));
    if (!list.length || ctx.readOnly) return;
    const before = new Map();
    const made = [];
    const off = 26 / Math.max(0.35, Math.min(1.5, view.k));
    for (const e of list.slice(0, 40)) {
      if (e.type === "line" || e.type === "arrow") {
        const abs = M.absolutePoints(e);
        for (let i = 1; i < abs.length && i < 12; i++) {
          const a = abs[i - 1];
          const b = abs[i];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const nx = ((b[1] - a[1]) / L) * off;
          const ny = (-(b[0] - a[0]) / L) * off;
          made.push(makeDimension([a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], before));
        }
        continue;
      }
      if (e.type === "freedraw" || e.type === "text") continue;
      // along the top edge and down the left one, following the shape if it is turned
      const c = MS.keyPoints({ ...e, type: "rectangle" }).filter((p) => p.kind === "corner");
      if (c.length < 4) continue;
      const out = (p, q, away) => { const L = Math.hypot(q.x - p.x, q.y - p.y) || 1; const nx = (-(q.y - p.y) / L) * off * away; const ny = ((q.x - p.x) / L) * off * away; return [[p.x + nx, p.y + ny], [q.x + nx, q.y + ny]]; };
      made.push(makeDimension(...out(c[0], c[1], -1), before));
      made.push(makeDimension(...out(c[0], c[3], 1), before));
    }
    if (!made.length) return ctx.toast("Nothing here that has a size to dimension", { ms: 2000 });
    const selBefore = [...ctx.selected];
    ctx.setSelection(made.map((e) => e.id));
    ctx.commit(before, { selBefore });
    ctx.invalidate();
  }

  /**
   * Called at the top of every commit: any dimension whose line changed gets
   * its number rewritten, inside the same undo step. A number somebody typed
   * over by hand is theirs from then on.
   */
  function syncDimensions(before) {
    for (const [id] of [...before]) {
      let e = byId.get(id);
      if (e && e.type === "text" && e.containerId) e = byId.get(e.containerId);
      if (!isDim(e) || e.customData.leoDim.auto === false) continue;
      const t = M.boundTextOf(e, byId);
      if (!t) continue;
      const want = MS.dimensionText(M.absolutePoints(e), cfg);
      if (t.originalText === want) continue;
      const was = before.get(t.id);
      const lineWas = before.get(e.id);
      const lineMoved = !lineWas || JSON.stringify(lineWas.points) !== JSON.stringify(e.points) || lineWas.isDeleted;
      if (was && !was.isDeleted && was.originalText !== t.originalText && !lineMoved) {
        if (!before.has(e.id)) before.set(e.id, M.snapshot(e));
        M.mutate(e, { customData: { ...e.customData, leoDim: { ...e.customData.leoDim, auto: false } } });
        continue;
      }
      if (!before.has(t.id)) before.set(t.id, M.snapshot(t));
      M.mutate(t, { text: want, originalText: want });
      ctx.relayout(e);
    }
  }

  /** New units or a new scale: every live dimension says the new number. */
  function relabelAll() {
    const dims = els.filter((e) => isDim(e) && e.customData.leoDim.auto !== false);
    if (!dims.length || ctx.readOnly) return;
    const before = ctx.snap(dims.flatMap((e) => [e, M.boundTextOf(e, byId)]).filter(Boolean));
    ctx.commit(before); // syncDimensions does the rewriting
    ctx.invalidate();
  }

  function insertScaleBar() {
    if (ctx.readOnly) return;
    const sb = MS.scaleBar(cfg, view.k);
    const { H } = ctx.size();
    const x = ctx.toWorldX(cfg.on ? 60 : 40);
    const y = ctx.toWorldY(H - 90);
    const before = new Map();
    const e = makeDimension([x, y], [x + sb.px, y], before, { heads: "bar" });
    const selBefore = [...ctx.selected];
    ctx.setTool("select");
    ctx.setSelection([e.id]);
    ctx.commit(before, { selBefore });
    ctx.invalidate();
  }

  /* ── units and scale ────────────────────────────────────────────────── */

  function changed() {
    applyOn();
    relabelAll();
    ctx.paintGrid();
    ctx.schedulePanel();
  }

  function openCalibrate(anchor, px) {
    if (!(px > 0)) {
      const one = ctx.selectedEls().find((e) => (e.type === "line" || e.type === "arrow") && e.points.length >= 2);
      if (one) px = M.polylineLength(M.absolutePoints(one));
    }
    if (!(px > 0)) return ctx.toast("Measure something whose real length you know (U), or select a line, then set the scale from it", { ms: 4200 });
    let unit = cfg.unit === "px" ? "mm" : cfg.unit;
    const input = h("input", { class: "sk-geo-in is-wide", placeholder: "its real length", spellcheck: false });
    const unitSel = h("select", { class: "sk-select", onchange: (e) => { unit = e.target.value; } }, ...MS.UNITS.filter((u) => u.id !== "px").map((u) => h("option", { value: u.id, text: u.name, selected: u.id === unit })));
    const apply = () => {
      const tmp = { ...cfg, unit, pxPerUnit: 1, calibrated: true };
      const real = MS.parseLength(input.value, tmp); // pxPerUnit 1: comes back as a number of units
      if (!(real > 0)) return ctx.toast("Type the real length, for example 2.4 or 7' 10\"", { ms: 2400 });
      cfg = MS.setMeasure(scene.appState, { unit, pxPerUnit: px / real, calibrated: true, on: true });
      ctx.markChanged();
      ctx.closePop();
      changed();
      renderBars();
      ctx.toast(`Scale set: that length is ${MS.formatLength(px, cfg)}. Everything in this drawing now measures to match.`, { ms: 4200 });
    };
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") apply(); if (e.key === "Escape") ctx.closePop(); });
    ctx.openPop(anchor, [
      h("div", { class: "sk-sec-label", text: "How long is this really?" }),
      h("div", { class: "sk-row" }, input, unitSel),
      h("div", { class: "sk-note", text: "Scanned plans and photos have no known scale. Tell Leonote one real length and the rest follows." }),
      h("div", { class: "sk-row" }, h("button", { class: "sk-textbtn is-primary", onclick: apply }, "Set the scale"))], "sk-pop-keep sk-units");
    requestAnimationFrame(() => input.focus());
  }

  function openUnits(anchor) {
    const body = h("div");
    const draw = () => {
      const gridUnits = MS.toUnits(ctx.gridSize(), cfg);
      const gridIn = h("input", { class: "sk-geo-in is-wide", value: MS.formatLength(ctx.gridSize(), cfg, { unit: false }), spellcheck: false });
      gridIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") gridIn.blur(); });
      const diagIn = h("input", { class: "sk-geo-in is-wide", value: ctx.setting("screenDiagonalIn", "") || "", placeholder: "diagonal, inches", spellcheck: false });
      diagIn.addEventListener("keydown", (e) => e.stopPropagation());
      gridIn.addEventListener("change", () => { const px = MS.parseLength(gridIn.value, cfg); if (px > 1) { ctx.setGridSize(px); draw(); } else ctx.toast("The grid needs to be more than a pixel", { ms: 1800 }); });
      put(body,
        h("label", { class: "sk-units-row" }, h("span", { text: "Units" }),
          h("select", { class: "sk-select", onchange: (e) => { save({ unit: e.target.value }); changed(); draw(); } }, ...MS.UNITS.map((u) => h("option", { value: u.id, text: u.name, selected: u.id === cfg.unit })))),
        cfg.unit === "px" ? null : h("label", { class: "sk-units-row" }, h("span", { text: "Scale" }),
          h("select", { class: "sk-select", onchange: (e) => { const [a, b] = e.target.value.split(":").map(Number); save({ scale: [a, b], calibrated: false }); changed(); draw(); } },
            cfg.calibrated ? h("option", { value: "1:1", text: "Calibrated from a length", selected: true }) : null,
            ...MS.SCALES.map((s) => h("option", { value: MS.scaleLabel(s), text: `${MS.scaleLabel(s)}${s[0] === 1 && s[1] === 1 ? "  (actual size)" : ""}`, selected: !cfg.calibrated && s[0] === cfg.scale[0] && s[1] === cfg.scale[1] })))),
        cfg.unit === "ft-in" || cfg.unit === "px" ? null : h("div", { class: "sk-units-row" }, h("span", { text: "Decimals" }),
          h("div", { class: "sk-mb-modes" }, ...[0, 1, 2, 3].map((p) => textBtn(String(p), "", () => { save({ precision: p }); changed(); draw(); }, cfg.precision === p ? "is-on" : "")))),
        h("label", { class: "sk-units-row" }, h("span", { text: "Snap grid" }), gridIn,
          h("button", { class: "sk-textbtn" + (ctx.gridOn() ? " is-on" : ""), title: "Snap to the grid (G)", onclick: () => { ctx.toggleGrid(); draw(); } }, ctx.gridOn() ? "On" : "Off")),
        h("div", { class: "sk-note", text: cfg.unit === "px" ? "Pixels measure the drawing itself. Pick a real unit to draw to scale." : `One ${MS.UNIT_BY_ID.get(cfg.unit).short} is ${Math.round(cfg.pxPerUnit * 1000) / 1000} px on the board. A grid square is ${MS.formatLength(MS.fromUnits(gridUnits, cfg), cfg)}.` }),
        // true size: a centimetre on the drawing is a centimetre on the glass.
        // The browser cannot know the monitor's real size, so it is asked once.
        h("label", { class: "sk-units-row" }, h("span", { text: "Screen" }), diagIn,
          textBtn("True size", "Zoom so a centimetre on the drawing is a centimetre on this screen (at 1:1)", () => {
            const inches = Number(diagIn.value);
            if (!(inches > 5)) return ctx.toast("Type your monitor's diagonal in inches first", { ms: 3000 });
            ctx.saveSetting("screenDiagonalIn", inches);
            // the window's own zoom (Ctrl+scroll) is folded into devicePixelRatio: take it back out to reach the monitor's real pixels
            const uiZoom = Number(document.documentElement.dataset.uiZoom) || 1;
            const dpi = Math.hypot(screen.width, screen.height) * (devicePixelRatio / uiZoom) / inches;
            ctx.zoomTo(dpi / (96 * devicePixelRatio));
            ctx.toast("True size: hold a ruler to the screen - one centimetre is one centimetre", { ms: 3200 });
          })),
        h("div", { class: "sk-row" },
          textBtn(cfg.on ? "Hide rulers" : "Show rulers", "Rulers, exact sizes and live readouts (Shift R)", () => { toggle(); draw(); }),
          textBtn("Set scale from a length…", "For a scanned plan or a photo", () => openCalibrate(anchor, lastDistance)),
          ctx.readOnly ? null : textBtn("Scale bar", "Put a scale bar on the drawing", () => { ctx.closePop(); insertScaleBar(); }),
          cfg.guides.length ? textBtn(`Clear ${cfg.guides.length} guide${cfg.guides.length === 1 ? "" : "s"}`, "", () => { save({ guides: [] }); paintSoon(); ctx.invalidate(false); draw(); }) : null));
    };
    draw();
    ctx.openPop(anchor, [h("div", { class: "sk-sec-label", text: "Units and drawing scale" }), body], "sk-pop-keep sk-units");
  }

  const moreMenuItems = (anchor) => [
    { label: "Measure", keys: "U", icon: "focus", run: () => ctx.setTool("measure") },
    { label: "Rulers and exact sizes", keys: "Shift R", icon: "grid", checked: cfg.on, run: () => toggle() },
    { label: "Units and drawing scale…", icon: "sliders", run: () => openUnits(anchor) },
  ];

  /* ── go ─────────────────────────────────────────────────────────────── */
  const themeWatch = new MutationObserver(() => { theme = null; paintSoon(); });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
  applyOn();

  return {
    cfg: () => cfg,
    isOn: () => cfg.on,
    toggle, down, enter, escape, pointerMoved, hoverCursor, snapEnd, endDone, drawScreen, renderBars, syncDimensions, guideCandidates, snapToGuides, moreMenuItems, openUnits, drawsDims, isDim,
    viewChanged: paintSoon,
    selectionChanged: () => { paintSoon(); renderBars(); },
    toolChanged: () => { if (ctx.tool() !== "measure") { m = null; snapHit = null; } renderBars(); ctx.invalidate(false); },
    // for tests and devtools
    api: { setMode, result, keepAsDimension, dimensionSelection, insertScaleBar, setBox, setLine, setAngle, state: () => m, set: (patch) => { save(patch); changed(); }, calibrate: (px, real) => { cfg = MS.calibrate(scene.appState, px, real); ctx.markChanged(); changed(); } },
    destroy() { destroyed = true; themeWatch.disconnect(); if (paintRaf) cancelAnimationFrame(paintRaf); },
  };
}
