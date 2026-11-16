// On the preview itself: click a clip to select it, drag it about, pull a
// corner to resize it, the knob above it to turn it. It snaps to the centre,
// the edges and the thirds of the frame, with a guide line showing what it
// caught (hold Alt to move freely; Shift turns without the right angles).
import { h } from "./util.js";

/**
 * `ctx`: proj(), selected() -> clip | null, select(id), bboxOf(c) -> { cx, cy, w, h, rot } in project px,
 * hitAt(px, py) -> clip | null (topmost), begin() -> before, commit(before), draw(), editText().
 */
export function mountCanvasTools(stage, canvas, ctx) {
  const dims = h("span", { class: "ve-dims" });
  const box = h("div", { class: "ve-sel", hidden: true }, dims,
    ...["nw", "ne", "sw", "se"].map((k) => h("span", { class: "ve-hd is-" + k, dataset: { hd: k } })),
    h("span", { class: "ve-rot", dataset: { hd: "rot" }, title: "Turn" }));
  const guides = h("div", { class: "ve-guides" });
  const frame = h("div", { class: "ve-frame-guides" }); // the frame's edge, thirds, centre, safe areas (for the editor only)
  const layer = h("div", { class: "ve-stage-layer" }, frame, guides, box);
  stage.append(layer);

  const geom = () => { const r = canvas.getBoundingClientRect(); return { r, k: r.width / ctx.proj().width }; };
  const toProj = (e) => { const { r, k } = geom(); return { px: (e.clientX - r.left) / k, py: (e.clientY - r.top) / k }; };

  function paint() {
    const { r, k } = geom();
    const sr = stage.getBoundingClientRect();
    Object.assign(layer.style, { left: r.left - sr.left + "px", top: r.top - sr.top + "px", width: r.width + "px", height: r.height + "px" });
    const c = ctx.selected();
    const b = c && c.type !== "audio" ? ctx.bboxOf(c) : null;
    if (ctx.paintExtra) ctx.paintExtra(k, b);
    box.hidden = !b;
    if (!b) return;
    Object.assign(box.style, { left: b.cx * k + "px", top: b.cy * k + "px", width: Math.max(8, b.w * k) + "px", height: Math.max(8, b.h * k) + "px", transform: `translate(-50%, -50%) rotate(${b.rot}deg)` });
    // measurements: where it sits and how big it is, in the video's own pixels
    dims.hidden = !(ctx.measure && ctx.measure());
    if (!dims.hidden) dims.textContent = `${Math.round(b.cx - b.w / 2)}, ${Math.round(b.cy - b.h / 2)} · ${Math.round(b.w)}×${Math.round(b.h)}${b.rot ? ` · ${Math.round(b.rot)}°` : ""}`;
  }
  function showGuides(lines) {
    const { k } = geom();
    guides.replaceChildren(...lines.map(([axis, v]) => h("span", { class: "ve-guide is-" + axis, style: axis === "x" ? { left: v * k + "px" } : { top: v * k + "px" } })));
  }

  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const hd = e.target.dataset && e.target.dataset.hd;
    const p0 = toProj(e);
    let c = ctx.selected();
    if (!hd) {
      const hit = ctx.hitAt(p0.px, p0.py);
      if (!hit) { if (c) { ctx.select(null); paint(); } return; }
      if (!c || hit.id !== c.id) { ctx.select(hit.id); c = hit; paint(); }
    }
    if (!c) return;
    e.preventDefault();
    const P = ctx.proj();
    const W = P.width, H = P.height;
    const b0 = ctx.bboxOf(c);
    const from = { x: c.x, y: c.y, scale: c.scale, rotate: c.rotate };
    const d0 = Math.max(4, Math.hypot(p0.px - b0.cx, p0.py - b0.cy));
    const a0 = (Math.atan2(p0.py - b0.cy, p0.px - b0.cx) * 180) / Math.PI;
    let moved = false;
    const before = ctx.begin();
    try { layer.setPointerCapture(e.pointerId); } catch {}
    const snapPx = () => 8 / geom().k;
    const mv = (m) => {
      const p = toProj(m);
      if (!moved && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 3) return;
      moved = true;
      if (hd === "rot") {
        let a = from.rotate + ((Math.atan2(p.py - b0.cy, p.px - b0.cx) * 180) / Math.PI - a0);
        a = ((a + 180) % 360 + 360) % 360 - 180;
        if (!m.shiftKey) { const q = Math.round(a / 90) * 90; if (Math.abs(a - q) < 4) a = q === 180 ? -180 : q; }
        c.rotate = Math.round(a * 10) / 10;
      } else if (hd) {
        c.scale = Math.max(0.05, Math.min(8, from.scale * (Math.hypot(p.px - b0.cx, p.py - b0.cy) / d0)));
      } else {
        let cx = from.x * W + (p.px - p0.px), cy = from.y * H + (p.py - p0.py);
        const lines = [];
        if (!m.altKey) {
          const tol = snapPx();
          const hw = b0.w / 2, hh = b0.h / 2;
          // what can catch: the centre line, the thirds, the frame's edges against the clip's centre or edges
          const xs = [[W / 2, 0], [W / 3, 0], [(2 * W) / 3, 0], [0, hw], [W, -hw], [0, -hw], [W, hw]];
          const ys = [[H / 2, 0], [H / 3, 0], [(2 * H) / 3, 0], [0, hh], [H, -hh], [0, -hh], [H, hh]];
          // the grid's lines, when it shows: a clip's centre or edges catch on them
          const n = ctx.grid ? ctx.grid() : 0;
          for (let i = 1; i < n; i++) for (const off of [0, hw, -hw]) xs.push([(i * W) / n, off]);
          for (let i = 1; i < n; i++) for (const off of [0, hh, -hh]) ys.push([(i * H) / n, off]);
          let best = null;
          for (const [tx, off] of xs) { const d = Math.abs(cx + (-off) - tx); if (d < tol && (!best || d < best.d)) best = { d, at: tx + off, line: tx }; }
          if (best) { cx = best.at; lines.push(["x", best.line]); }
          best = null;
          for (const [ty, off] of ys) { const d = Math.abs(cy + (-off) - ty); if (d < tol && (!best || d < best.d)) best = { d, at: ty + off, line: ty }; }
          if (best) { cy = best.at; lines.push(["y", best.line]); }
        }
        c.x = Math.round((cx / W) * 1000) / 1000;
        c.y = Math.round((cy / H) * 1000) / 1000;
        showGuides(lines);
      }
      ctx.draw();
      paint();
    };
    const up = () => {
      layer.removeEventListener("pointermove", mv);
      layer.removeEventListener("pointerup", up);
      showGuides([]);
      if (moved) ctx.commit(before);
    };
    layer.addEventListener("pointermove", mv);
    layer.addEventListener("pointerup", up);
  });
  // a double click on a clip opens it for editing (a text: its words, right on the frame)
  layer.addEventListener("dblclick", (e) => { if (e.target.dataset.hd || e.target.closest(".ve-intext")) return; const c = ctx.selected(); if (c && c.type === "text") ctx.editText(); else if (c && ctx.openPanel) ctx.openPanel(); });

  const ro = new ResizeObserver(paint);
  ro.observe(stage);
  return { paint, frame, layer, toProj, destroy: () => ro.disconnect() };
}
