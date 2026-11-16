// Studio's rulers, guides and measuring line.
//
// Rulers along the top and left edge (Ctrl+R) count in px, cm or in (the
// document's dpi says how big a cm is). A guide is dragged out of a ruler -
// the top one gives a level line, the left one an upright one - snaps to the
// centre and the edges, and goes back into a ruler to be removed. The Measure
// tool (I, after the colour picker) draws a line and says its length, angle
// and run; it snaps to guides, edges and the centre, and says when what it
// spans sits exactly in the middle. Guides are kept in the drawing.
import { h } from "./util.js";

export const RULER = 18;
const STEPS = [1, 2, 5];

/** A tick step (in units) that lands at least `minPx` screen pixels apart. */
export function niceStep(screenPerUnit, minPx = 56) {
  for (let p = 1e-3; p < 1e7; p *= 10) for (const s of STEPS) if (s * p * screenPerUnit >= minPx) return s * p;
  return 1e7;
}

/** A length in the unit shown: px, or cm and in by the document's dpi. */
export function inUnit(px, unit, dpi) {
  const d = dpi || 72;
  if (unit === "cm") return `${(px / d * 2.54).toFixed(2)} cm`;
  if (unit === "in") return `${(px / d).toFixed(2)} in`;
  return `${Math.round(px * 10) / 10} px`;
}

/** Where `v` lands near the snap points (within `tol`): the nearest one, else itself. */
export function snap(v, points, tol) {
  let best = v, bestD = tol;
  for (const s of points) { const d = Math.abs(v - s.at); if (d <= bestD) { best = s.at; bestD = d; } }
  return best;
}

export function createMeasure({ root, canvas, view, doc, guides, changed, invalidate, pref, setPref }) {
  const top = h("canvas", { class: "pt-ruler is-top" });
  const left = h("canvas", { class: "pt-ruler is-left" });
  const corner = h("button", { class: "pt-ruler-corner", title: "Units - click to switch px, cm, in" });
  const label = h("div", { class: "pt-measure-label", hidden: true });
  const dragLabel = h("div", { class: "pt-measure-label is-drag", hidden: true });
  root.append(top, left, corner, label, dragLabel);
  let on = !!pref("paintRulers");
  let unit = ["px", "cm", "in"].includes(pref("paintRulerUnit")) ? pref("paintRulerUnit") : "px";
  let line = null; // { a, b } the measured line, document pixels
  let ghost = null; // { axis, at } a guide on its way out of a ruler

  const upright = () => Math.abs(Math.sin(view.angle)) < 1e-6 && Math.cos(view.angle) > 0;
  const toScreen = (x, y) => {
    const k = view.flip ? -1 : 1;
    const dx = (x - doc.width / 2) * view.zoom * k, dy = (y - doc.height / 2) * view.zoom;
    const c = Math.cos(view.angle), s = Math.sin(view.angle);
    return { x: view.cx + dx * c - dy * s, y: view.cy + dx * s + dy * c };
  };
  const toDoc = (sx, sy) => {
    const c = Math.cos(-view.angle), s = Math.sin(-view.angle);
    const dx = sx - view.cx, dy = sy - view.cy;
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    return { x: rx / view.zoom / (view.flip ? -1 : 1) + doc.width / 2, y: ry / view.zoom + doc.height / 2 };
  };
  const local = (e) => { const r = root.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const snapPoints = (axis) => {
    const size = axis === "x" ? doc.width : doc.height;
    return [{ at: 0 }, { at: size / 2, centre: true }, { at: size }, ...guides.filter((g) => g.axis === axis && g !== ghost)];
  };
  const unitPx = () => (unit === "cm" ? (doc.dpi || 72) / 2.54 : unit === "in" ? doc.dpi || 72 : 1);

  function paintRuler(cv, horizontal) {
    const dpr = window.devicePixelRatio || 1;
    const len = horizontal ? root.clientWidth : root.clientHeight;
    const w = horizontal ? len : RULER, hgt = horizontal ? RULER : len;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); cv.style.width = w + "px"; cv.style.height = hgt + "px"; }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(root);
    const ink = css.getPropertyValue("--text-3").trim() || "#999", faint = css.getPropertyValue("--text-4").trim() || "#666", accent = css.getPropertyValue("--accent").trim() || "#e8a33d";
    g.clearRect(0, 0, w, hgt);
    if (!upright()) {
      g.fillStyle = faint; g.font = "10px system-ui"; g.textBaseline = "middle";
      if (horizontal) g.fillText("turned - Shift+R to set upright", RULER + 8, RULER / 2);
      return;
    }
    const upx = unitPx();
    const spu = upx * view.zoom; // screen px per unit
    const step = niceStep(spu);
    // small ticks between the numbered ones: tenths when there is room, else fifths, else halves
    const minor = (step * spu) / 10 >= 5 ? step / 10 : (step * spu) / 5 >= 5 ? step / 5 : step / 2;
    // the units seen from one end of the ruler to the other
    const a = toDoc(0, 0), b = toDoc(horizontal ? len : 0, horizontal ? 0 : len);
    const lo = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y) / upx, hi = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y) / upx;
    const at = (u) => { const s = horizontal ? toScreen(u * upx, 0).x : toScreen(0, u * upx).y; return Math.round(s) + 0.5; };
    g.strokeStyle = faint; g.lineWidth = 1;
    g.beginPath();
    for (let u = Math.floor(lo / minor) * minor; u <= hi; u += minor) {
      const s = at(u), major = Math.abs(u / step - Math.round(u / step)) < 1e-6;
      const tl = major ? RULER : RULER * 0.3;
      if (horizontal) { g.moveTo(s, RULER); g.lineTo(s, RULER - tl); } else { g.moveTo(RULER, s); g.lineTo(RULER - tl, s); }
    }
    g.stroke();
    g.fillStyle = ink; g.font = "9.5px system-ui"; g.textBaseline = "top";
    for (let u = Math.floor(lo / step) * step; u <= hi; u += step) {
      const s = at(u), txt = String(Math.round(u * 1000) / 1000);
      if (horizontal) g.fillText(txt, s + 3, 2);
      else { g.save(); g.translate(3, s - 3); g.rotate(-Math.PI / 2); g.fillText(txt, 0, 0); g.restore(); }
    }
    // the centre, and each guide, marked on its ruler
    const mark = (pos, colour) => { g.fillStyle = colour; if (horizontal) { g.beginPath(); g.moveTo(pos - 4, RULER); g.lineTo(pos + 4, RULER); g.lineTo(pos, RULER - 5); g.fill(); } else { g.beginPath(); g.moveTo(RULER, pos - 4); g.lineTo(RULER, pos + 4); g.lineTo(RULER - 5, pos); g.fill(); } };
    mark(horizontal ? toScreen(doc.width / 2, 0).x : toScreen(0, doc.height / 2).y, faint);
    for (const gd of guides) if ((gd.axis === "x") === horizontal) mark(horizontal ? toScreen(gd.at, 0).x : toScreen(0, gd.at).y, accent);
  }

  function paintLabel() {
    if (!line) { label.hidden = true; return; }
    const { a, b } = line;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const ang = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const centred = [Math.abs(mid.x - doc.width / 2) <= 0.5 && Math.abs(dx) > 1 ? "centred left to right" : "", Math.abs(mid.y - doc.height / 2) <= 0.5 && Math.abs(dy) > 1 ? "centred top to bottom" : ""].filter(Boolean);
    const s = toScreen(mid.x, mid.y);
    label.hidden = false;
    label.replaceChildren(...[
      h("b", { text: inUnit(len, unit, doc.dpi) }),
      h("span", { text: ` · ${Math.round(ang * 10) / 10}° · ${inUnit(Math.abs(dx), unit, doc.dpi)} × ${inUnit(Math.abs(dy), unit, doc.dpi)}` }),
      centred.length ? h("span", { class: "is-ok", text: ` · ✓ ${centred.join(", ")}` }) : null].filter(Boolean));
    label.style.left = Math.round(s.x + 12) + "px";
    label.style.top = Math.round(s.y + 12) + "px";
  }

  function after() {
    root.classList.toggle("has-rulers", on);
    top.hidden = left.hidden = corner.hidden = !on;
    if (on) { paintRuler(top, true); paintRuler(left, false); corner.textContent = unit; }
    paintLabel();
  }

  /** In the drawing's own space: the guides, and the measured line. */
  function draw(c) {
    const z = view.zoom, far = Math.max(doc.width, doc.height) * 3;
    const accent = getComputedStyle(root).getPropertyValue("--accent").trim() || "#e8a33d";
    c.save();
    c.lineWidth = 1 / z;
    c.strokeStyle = "rgba(0, 190, 220, .9)";
    c.beginPath();
    for (const g of [...guides, ...(ghost ? [ghost] : [])]) {
      if (g.axis === "x") { c.moveTo(g.at, -far); c.lineTo(g.at, far); } else { c.moveTo(-far, g.at); c.lineTo(far, g.at); }
    }
    c.stroke();
    if (line) {
      const { a, b } = line;
      c.strokeStyle = accent;
      c.lineWidth = 1.5 / z;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      // a short tick across each end
      const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2, t = 6 / z;
      c.beginPath();
      for (const p of [a, b]) { c.moveTo(p.x - Math.cos(ang) * t, p.y - Math.sin(ang) * t); c.lineTo(p.x + Math.cos(ang) * t, p.y + Math.sin(ang) * t); }
      c.stroke();
    }
    c.restore();
  }

  // a point, pulled onto a guide, an edge or the centre when close (8 screen pixels)
  const pull = (p) => ({ x: snap(p.x, snapPoints("x"), 8 / view.zoom), y: snap(p.y, snapPoints("y"), 8 / view.zoom) });
  const nearGuide = (sp) => guides.find((g) => { const s = g.axis === "x" ? toScreen(g.at, 0).x : toScreen(0, g.at).y; return Math.abs((g.axis === "x" ? sp.x : sp.y) - s) <= 5; });

  /** A guide dragged: out of a ruler, or an existing one; back into a ruler removes it. */
  function dragGuide(e, g, isNew) {
    ghost = g;
    const move = (ev) => {
      const sp = local(ev);
      const d = toDoc(sp.x, sp.y);
      const raw = g.axis === "x" ? d.x : d.y;
      const points = snapPoints(g.axis);
      g.at = Math.round(snap(raw, points, 8 / view.zoom));
      const size = g.axis === "x" ? doc.width : doc.height;
      dragLabel.hidden = false;
      dragLabel.textContent = `${g.axis === "x" ? "x" : "y"} ${inUnit(g.at, unit, doc.dpi)}${g.at === size / 2 ? " · centre" : ""}`;
      dragLabel.style.left = sp.x + 14 + "px";
      dragLabel.style.top = sp.y + 14 + "px";
      invalidate();
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragLabel.hidden = true;
      ghost = null;
      const sp = local(ev);
      const gone = (g.axis === "x" ? sp.x : sp.y) < RULER;
      const i = guides.indexOf(g);
      if (gone) { if (i >= 0) guides.splice(i, 1); }
      else if (i < 0) guides.push(g);
      if (gone || isNew || i >= 0) changed();
      invalidate();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(e);
  }
  top.addEventListener("pointerdown", (e) => { e.preventDefault(); dragGuide(e, { type: "rule", axis: "y", at: 0 }, true); });
  left.addEventListener("pointerdown", (e) => { e.preventDefault(); dragGuide(e, { type: "rule", axis: "x", at: 0 }, true); });
  corner.addEventListener("click", () => { unit = { px: "cm", cm: "in", in: "px" }[unit]; setPref("paintRulerUnit", unit); after(); });

  /** The Measure tool's press: a guide under the pointer moves; anywhere else a new line starts. */
  function down(e, p, sp) {
    const g = nearGuide(sp);
    if (g) { dragGuide(e, g, false); return; }
    const a = pull(p);
    line = { a, b: a };
    const move = (ev) => {
      const s = local(ev);
      let q = pull(toDoc(s.x, s.y));
      if (ev.shiftKey) {
        // Shift: the angle in steps of 15°
        const dx = q.x - a.x, dy = q.y - a.y, len = Math.hypot(dx, dy);
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        q = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
      }
      line = { a, b: q };
      invalidate();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); if (line && Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) < 0.5) line = null; invalidate(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function toggleRulers() { on = !on; setPref("paintRulers", on); after(); invalidate(); }
  function clear() { if (!line) return false; line = null; invalidate(); return true; }
  function clearGuides() { if (!guides.length) return; guides.splice(0); changed(); invalidate(); }
  function destroy() { top.remove(); left.remove(); corner.remove(); label.remove(); dragLabel.remove(); }
  after();
  return { after, draw, down, toggleRulers, clear, clearGuides, destroy, get on() { return on; }, get unit() { return unit; } };
}
