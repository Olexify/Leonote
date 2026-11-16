// Draw mode's pure half: the document manifest, layer maths and blend
// formulas, the brush curves, the presets and where an export lands.
//
// None of this touches the DOM or a canvas, which is the point: the parts of
// a painting app that are easy to get quietly wrong — a blend that is a
// little off, spacing that drifts, an export that overwrites yesterday's —
// are exactly the parts that can be pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as D from "../paintdoc.js";
import * as B from "../paintbrush.js";
import { History, pixelStep, metaStep, dirtyRect, newBox, growBox, fmtBytes, DEFAULT_BUDGET } from "../painthistory.js";

/* ── the manifest ────────────────────────────────────────────────────────── */

test("a new document is one layer on a canvas of the size you asked for", () => {
  const doc = D.newDoc({ width: 1280, height: 720, dpi: 72 });
  assert.equal(doc.format, "leostudio");
  assert.equal(doc.width, 1280);
  assert.equal(doc.height, 720);
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.layers[0].blend, "normal");
  assert.equal(doc.layers[0].opacity, 1);
  assert.ok(doc.layers[0].visible);
});

test("the manifest round-trips every layer setting", () => {
  const doc = D.newDoc({ width: 2048, height: 1536, dpi: 144 });
  doc.layers.push(D.newLayer({ name: "Ink", blend: "multiply", opacity: 0.42, locked: true, alphaLock: true, visible: false }));
  doc.selected = doc.layers[1].id;
  const json = JSON.stringify(D.toManifest(doc, { created: "2026-01-01T00:00:00.000Z" }));
  const back = D.fromManifest(json);

  assert.equal(back.width, 2048);
  assert.equal(back.height, 1536);
  assert.equal(back.dpi, 144);
  assert.equal(back.layers.length, 2);
  assert.deepEqual(
    back.layers.map((l) => [l.name, l.blend, l.opacity, l.visible, l.locked, l.alphaLock]),
    [["Layer 1", "normal", 1, true, false, false], ["Ink", "multiply", 0.42, false, true, true]]);
  assert.equal(back.selected, back.layers[1].id, "the selected layer survives");
  assert.equal(back.layers[1].file, `layers/${back.layers[1].id}.png`);
});

test("layers stay bottom-first through a round trip", () => {
  const doc = D.newDoc({});
  doc.layers[0].name = "bottom";
  doc.layers.push(D.newLayer({ name: "middle" }), D.newLayer({ name: "top" }));
  const back = D.fromManifest(JSON.stringify(D.toManifest(doc)));
  assert.deepEqual(back.layers.map((l) => l.name), ["bottom", "middle", "top"]);
});

test("a hand-edited manifest still opens if it possibly can", () => {
  const back = D.fromManifest({ width: 800, height: 600, layers: [{ id: "a1", name: "Only" }, null, { nonsense: true }] });
  assert.equal(back.layers.length, 2, "the null is dropped, the odd one gets defaults");
  assert.equal(back.layers[0].name, "Only");
  assert.equal(back.layers[1].name, "Layer 2");
  assert.equal(back.layers[1].opacity, 1);
  assert.equal(back.dpi, 72, "a missing dpi falls back rather than failing");
});

test("a manifest with no layers at all still opens, with one", () => {
  const back = D.fromManifest({ width: 100, height: 100, layers: [] });
  assert.equal(back.layers.length, 1);
  assert.equal(back.selected, back.layers[0].id);
});

test("out-of-range layer settings are clamped, not trusted", () => {
  const back = D.fromManifest({ width: 10, height: 10, layers: [{ id: "a", opacity: 9 }, { id: "b", opacity: -4 }, { id: "c", blend: "evil" }] });
  assert.equal(back.layers[0].opacity, 1);
  assert.equal(back.layers[1].opacity, 0);
  assert.equal(back.layers[2].blend, "normal");
});

test("duplicate layer ids are made unique, so the zip cannot lose a layer", () => {
  const back = D.fromManifest({ width: 10, height: 10, layers: [{ id: "same" }, { id: "same" }, { id: "same" }] });
  assert.equal(new Set(back.layers.map((l) => l.id)).size, 3);
});

test("a manifest that cannot make a document says so", () => {
  assert.throws(() => D.fromManifest("not json"));
  assert.throws(() => D.fromManifest({ layers: [] }), /canvas size/);
  assert.throws(() => D.fromManifest({ format: "psd", width: 4, height: 4 }), /not a Leonote drawing/);
  assert.throws(() => D.fromManifest({ version: 99, width: 4, height: 4 }), /newer Leonote/);
  assert.throws(() => D.fromManifest({ width: 8000, height: 8000 }), /megapixels/);
});

test("the entry list is exactly what the container should hold", () => {
  const doc = D.newDoc({});
  doc.layers.push(D.newLayer({}));
  const names = D.entryNames(doc);
  assert.equal(names[0], "doc.json");
  assert.equal(names[names.length - 1], "thumb.png");
  assert.equal(names.length, 4);
});

/* ── layer operations ────────────────────────────────────────────────────── */

test("reorder moves one layer and leaves the rest in order", () => {
  const ls = ["a", "b", "c", "d"].map((n) => D.newLayer({ name: n }));
  assert.deepEqual(D.reorder(ls, 0, 2).map((l) => l.name), ["b", "c", "a", "d"]);
  assert.deepEqual(D.reorder(ls, 3, 0).map((l) => l.name), ["d", "a", "b", "c"]);
  assert.deepEqual(D.reorder(ls, 1, 1).map((l) => l.name), ["a", "b", "c", "d"]);
});

test("reorder clamps rather than throwing, because it runs off a drag", () => {
  const ls = ["a", "b"].map((n) => D.newLayer({ name: n }));
  assert.deepEqual(D.reorder(ls, -5, 99).map((l) => l.name), ["b", "a"]);
  assert.deepEqual(D.reorder([], 0, 1), []);
});

test("merge down has nothing to merge into at the bottom of the stack", () => {
  const doc = D.newDoc({});
  doc.layers.push(D.newLayer({ name: "top" }));
  assert.equal(D.mergeTarget(doc, doc.layers[0].id), null);
  assert.equal(D.mergeTarget(doc, doc.layers[1].id).id, doc.layers[0].id);
});

test("copies are named the way people expect", () => {
  assert.equal(D.copyName("Ink"), "Ink copy");
  assert.equal(D.copyName("Ink copy"), "Ink copy 2");
  assert.equal(D.copyName("Ink copy 2"), "Ink copy 3");
  assert.equal(D.copyName("Ink copy 9"), "Ink copy 10");
});

test("a duplicate is the same layer with a new id and a new name", () => {
  const l = D.newLayer({ name: "Sky", blend: "screen", opacity: 0.3 });
  const d = D.duplicateMeta(l);
  assert.notEqual(d.id, l.id);
  assert.equal(d.name, "Sky copy");
  assert.equal(d.blend, "screen");
  assert.equal(d.opacity, 0.3);
});

test("a new layer's number skips the ones already used", () => {
  const ls = [D.newLayer({ name: "Layer 1" }), D.newLayer({ name: "Layer 2" }), D.newLayer({ name: "Sky" })];
  assert.equal(D.nextLayerName(ls), "Layer 4");
  assert.equal(D.nextLayerName([D.newLayer({ name: "Layer 4" })]), "Layer 2");
});

/* ── blend maths ─────────────────────────────────────────────────────────── */

test("every blend mode has a canvas operation and a formula", () => {
  for (const m of D.BLEND_MODES) {
    assert.equal(typeof m.op, "string", m.id);
    assert.equal(typeof D.BLEND_FN[m.id], "function", `${m.id} has no formula`);
  }
  assert.equal(D.blendOp("multiply"), "multiply");
  assert.equal(D.blendOp("add"), "lighter");
  assert.equal(D.blendOp("nonsense"), "source-over", "an unknown mode falls back to normal");
});

test("the blend formulas match the compositing spec at the edges", () => {
  const f = D.BLEND_FN;
  // multiply and screen are each other's mirror
  assert.equal(f.multiply(1, 0.3), 0.3);
  assert.equal(f.multiply(0, 0.3), 0);
  assert.equal(f.screen(0, 0.3), 0.3);
  assert.equal(f.screen(1, 0.3), 1);
  assert.equal(f.darken(0.2, 0.8), 0.2);
  assert.equal(f.lighten(0.2, 0.8), 0.8);
  assert.equal(f.add(0.7, 0.7), 1, "add clips rather than wrapping");
  // overlay on a mid-grey backdrop is the identity for a mid-grey source
  assert.ok(Math.abs(f.overlay(0.5, 0.5) - 0.5) < 1e-9);
  // soft light never moves a backdrop that is already black or white
  assert.equal(f["soft-light"](0, 0.9), 0);
  assert.ok(Math.abs(f["soft-light"](1, 0.1) - 1) < 1e-9);
  // a 50% source leaves soft light alone
  assert.ok(Math.abs(f["soft-light"](0.42, 0.5) - 0.42) < 1e-9);
});

test("a fully opaque normal layer simply replaces what is under it", () => {
  const out = D.blendPixel([0.1, 0.2, 0.3, 1], [0.8, 0.6, 0.4, 1], "normal", 1);
  assert.deepEqual(out.map((v) => Math.round(v * 100) / 100), [0.8, 0.6, 0.4, 1]);
});

test("a transparent source changes nothing", () => {
  const dst = [0.1, 0.2, 0.3, 1];
  const out = D.blendPixel(dst, [1, 1, 1, 0], "multiply", 1);
  assert.deepEqual(out.map((v) => Math.round(v * 1000) / 1000), [0.1, 0.2, 0.3, 1]);
});

test("layer opacity scales a blend the whole way to nothing", () => {
  const dst = [1, 1, 1, 1];
  const full = D.blendPixel(dst, [0, 0, 0, 1], "multiply", 1);
  const half = D.blendPixel(dst, [0, 0, 0, 1], "multiply", 0.5);
  const none = D.blendPixel(dst, [0, 0, 0, 1], "multiply", 0);
  assert.equal(Math.round(full[0] * 100), 0);
  assert.equal(Math.round(half[0] * 100), 50);
  assert.equal(Math.round(none[0] * 100), 100);
});

test("blending onto nothing keeps the source's own colour", () => {
  const out = D.blendPixel([0, 0, 0, 0], [0.9, 0.1, 0.2, 1], "multiply", 1);
  assert.deepEqual(out.map((v) => Math.round(v * 100) / 100), [0.9, 0.1, 0.2, 1]);
});

/* ── canvas presets and memory ───────────────────────────────────────────── */

test("every canvas preset is a real, openable size", () => {
  assert.ok(D.PRESETS.length >= 12);
  for (const p of D.PRESETS) {
    assert.ok(p.w > 0 && p.h > 0, p.id);
    assert.ok(p.w <= D.MAX_SIDE && p.h <= D.MAX_SIDE, `${p.id} is wider than we allow`);
    assert.ok(p.w * p.h <= D.MAX_PIXELS, `${p.id} is over the pixel budget`);
    assert.equal(typeof p.name, "string");
  }
  assert.equal(new Set(D.PRESETS.map((p) => p.id)).size, D.PRESETS.length, "preset ids must be unique");
  assert.ok(D.PRESET_BY_ID.has(D.DEFAULT_PRESET));
});

test("the presets people actually asked for are there, at the right sizes", () => {
  const by = (id) => D.PRESET_BY_ID.get(id);
  assert.deepEqual([by("a4-300").w, by("a4-300").h], [2480, 3508]);
  assert.deepEqual([by("yt-thumb").w, by("yt-thumb").h], [1280, 720]);
  assert.deepEqual([by("ig-story").w, by("ig-story").h], [1080, 1920]);
  assert.deepEqual([by("ig-post").w, by("ig-post").h], [1080, 1350]);
  assert.deepEqual([by("uhd").w, by("uhd").h], [3840, 2160]);
});

test("A4 at 300 dpi really is A4", () => {
  const mm = D.printSize(2480, 3508, 300);
  assert.equal(mm.w, 210);
  assert.equal(mm.h, 297);
});

test("the memory estimate is the one the engine actually pays", () => {
  // layers + stroke scratch + flatten buffer, plus an 8-bit selection mask
  assert.equal(D.layerBytes(100, 100), 40000);
  assert.equal(D.memoryEstimate(100, 100, 1), 40000 * 3 + 10000);
  assert.equal(D.memoryEstimate(4000, 4000, 5), 4000 * 4000 * 4 * 7 + 16000000);
});

/* ── export naming ───────────────────────────────────────────────────────── */

test("an export lands beside the drawing, named after it", () => {
  assert.equal(D.exportPath("Art/Study.leopaint", { format: "png" }), "Art/Study.png");
  assert.equal(D.exportPath("Study.leopaint", { format: "jpeg" }), "Study.jpg");
  assert.equal(D.exportPath("Art/Study.leopaint", { format: "webp" }), "Art/Study.webp");
});

test("a scaled export says so in its name", () => {
  assert.equal(D.exportPath("Art/Study.leopaint", { format: "png", scale: 0.5 }), "Art/Study @half.png");
  assert.equal(D.exportPath("Art/Study.leopaint", { format: "png", scale: 2 }), "Art/Study @2x.png");
  assert.equal(D.exportPath("Art/Study.leopaint", { format: "png", scale: 0.25 }), "Art/Study @0.25x.png");
});

test("an export never writes over one that is already there", () => {
  const taken = new Map([["Art/Study.png", 1], ["Art/Study 2.png", 1]]);
  assert.equal(D.exportPath("Art/Study.leopaint", { format: "png", taken }), "Art/Study 3.png");
  assert.equal(D.exportPath("Art/Study.leopaint", { format: "webp", taken }), "Art/Study.webp");
});

test("an export's size is the document's, scaled and clamped", () => {
  const doc = D.newDoc({ width: 1000, height: 500 });
  assert.deepEqual(D.exportSize(doc, 1), { width: 1000, height: 500 });
  assert.deepEqual(D.exportSize(doc, 0.5), { width: 500, height: 250 });
  assert.deepEqual(D.exportSize(doc, 100), { width: D.MAX_SIDE, height: D.MAX_SIDE });
});

/* ── view maths ──────────────────────────────────────────────────────────── */

test("screen and document coordinates are exact inverses, rotation included", () => {
  const doc = D.newDoc({ width: 1000, height: 800 });
  for (const angle of [0, 0.7, Math.PI / 2, -2.3]) {
    for (const zoom of [0.25, 1, 3.7]) {
      const view = { zoom, angle, cx: 410, cy: 260, width: doc.width, height: doc.height };
      for (const [x, y] of [[0, 0], [123, 456], [999.5, 799.5]]) {
        const s = D.toScreenPoint(view, x, y);
        const back = D.toDocPoint(view, s.x, s.y);
        assert.ok(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9, `${angle} ${zoom} ${x},${y}`);
      }
    }
  }
});

test("fit puts the whole canvas on screen and never runs off the ends", () => {
  const doc = D.newDoc({ width: 4000, height: 4000 });
  const z = D.fitZoom(doc, 800, 600);
  assert.ok(4000 * z <= 600);
  assert.ok(D.fitZoom(D.newDoc({ width: 8, height: 8 }), 4000, 4000) <= D.ZOOM_MAX);
  assert.ok(D.fitZoom(D.newDoc({ width: 8192, height: 8192 }), 10, 10) >= D.ZOOM_MIN);
});

/* ── brushes ─────────────────────────────────────────────────────────────── */

test("the brush library covers what a drawing app needs", () => {
  const ids = new Set(B.PRESETS.map((p) => p.id));
  for (const want of ["pencil", "inker", "round", "airbrush", "watercolour", "marker", "chalk", "eraser"]) {
    assert.ok(ids.has(want), `no ${want} brush`);
  }
  assert.equal(ids.size, B.PRESETS.length, "brush ids must be unique");
  for (const p of B.PRESETS) {
    assert.ok(B.FAMILIES.some((f) => f.id === p.family), `${p.id} is in no family`);
    const r = B.resolve(p.id);
    assert.ok(r.size > 0 && r.spacing > 0, p.id);
    assert.ok(r.opacity > 0 && r.opacity <= 1, p.id);
    assert.ok(r.flow > 0 && r.flow <= 1, p.id);
    assert.ok(r.hardness >= 0 && r.hardness <= 1, p.id);
  }
});

test("every eraser actually erases", () => {
  for (const p of B.PRESETS.filter((x) => x.family === "eraser")) {
    assert.equal(B.resolve(p.id).blend, "erase", p.id);
  }
});

test("resolving a brush layers overrides on top of its preset", () => {
  const base = B.resolve("inker");
  const over = B.resolve("inker", { size: 99, hardness: 0.1 });
  assert.equal(over.size, 99);
  assert.equal(over.hardness, 0.1);
  assert.equal(over.spacing, base.spacing, "untouched parameters keep the preset's value");
  assert.equal(B.resolve("no-such-brush").size, B.BASE.size, "an unknown brush falls back to the base");
});

test("a saved brush stores only what was changed", () => {
  const b = B.resolve("round", { size: 123 });
  const d = B.diff(b);
  assert.equal(d.id, "round");
  assert.equal(d.size, 123);
  assert.ok(!("hardness" in d), "an unchanged parameter is not written out");
});

test("pressure drives size by exactly as much as the brush says", () => {
  const hard = B.resolve("round", { pressureSize: 1, curve: "linear", size: 100, tilt: 0 });
  assert.equal(B.sizeAt(hard, 1), 100);
  assert.equal(B.sizeAt(hard, 0.5), 50);
  assert.ok(B.sizeAt(hard, 0) < 1);

  const flat = B.resolve("round", { pressureSize: 0, size: 100 });
  assert.equal(B.sizeAt(flat, 0), 100);
  assert.equal(B.sizeAt(flat, 1), 100);

  const half = B.resolve("round", { pressureSize: 0.5, curve: "linear", size: 100 });
  assert.equal(B.sizeAt(half, 0), 50);
  assert.equal(B.sizeAt(half, 1), 100);
});

test("the pressure curves bend the way their names say", () => {
  assert.equal(B.curvePressure(0.5, "linear"), 0.5);
  assert.ok(B.curvePressure(0.5, "soft") > 0.5, "soft reaches full width sooner");
  assert.ok(B.curvePressure(0.5, "firm") < 0.5, "firm needs more pressure");
  assert.equal(B.curvePressure(0.5, "light"), 0.5);
  assert.equal(B.curvePressure(0, "light"), 0.25, "light never goes to nothing");
  for (const c of ["linear", "soft", "firm", "light"]) {
    assert.ok(B.curvePressure(0.2, c) <= B.curvePressure(0.8, c), `${c} must not go backwards`);
  }
});

test("flow and opacity respond to pressure independently", () => {
  const b = B.resolve("round", { flow: 1, opacity: 1, pressureFlow: 1, pressureOpacity: 0, curve: "linear" });
  assert.equal(B.flowAt(b, 1), 1);
  assert.equal(B.flowAt(b, 0.25), 0.25);
  assert.equal(B.opacityAt(b, 0.25), 1, "opacity is not on pressure here");
  const o = B.resolve("round", { pressureOpacity: 1, opacity: 1, curve: "linear" });
  assert.equal(B.opacityAt(o, 0.4), 0.4);
});

test("tilt widens the tip and fades it, and only when the brush uses tilt", () => {
  const flat = B.resolve("round", { tilt: 0, size: 50, pressureSize: 0 });
  assert.equal(B.sizeAt(flat, 1, 1), 50);
  const leans = B.resolve("round", { tilt: 1, size: 50, pressureSize: 0, flow: 1, pressureFlow: 0 });
  assert.ok(B.sizeAt(leans, 1, 1) > 50 * 2, "a pen laid flat spreads");
  assert.ok(B.flowAt(leans, 1, 1) < B.flowAt(leans, 1, 0), "and is fainter");
});

test("spacing never collapses to zero, however small the brush", () => {
  const b = B.resolve("round", { spacing: 0.0001 });
  assert.ok(B.stepFor(b, 0.5) >= 0.33);
  assert.equal(B.stepFor(B.resolve("round", { spacing: 0.1 }), 100), 10);
});

test("stamps are laid down evenly, and spacing carries across segments", () => {
  const got = [];
  // one 10-long segment at step 2, starting fresh: stamps at 2,4,6,8,10
  let carry = B.walkSegment(0, 0, 10, 0, 2, 0, (x) => got.push(x));
  assert.deepEqual(got.map(Math.round), [2, 4, 6, 8, 10]);
  assert.equal(carry, 0);

  // continuing, the next segment starts where the spacing left off
  const next = [];
  carry = B.walkSegment(0, 0, 3, 0, 2, 1, (x) => next.push(x));
  assert.deepEqual(next.map((n) => Math.round(n * 10) / 10), [1, 3]);
  assert.equal(carry, 0);
});

test("a segment shorter than the spacing lays nothing down but remembers it", () => {
  const got = [];
  const carry = B.walkSegment(0, 0, 0.5, 0, 2, 0, (x) => got.push(x));
  assert.equal(got.length, 0);
  assert.equal(carry, 0.5, "the half-step is carried into the next segment");
});

test("walking a segment of no length does nothing at all", () => {
  let n = 0;
  assert.equal(B.walkSegment(5, 5, 5, 5, 1, 0.4, () => n++), 0.4);
  assert.equal(n, 0);
});

test("the stabiliser lags towards the pointer and always arrives", () => {
  const raw = { x: 0, y: 0 };
  B.stabilise(raw, 100, 0, 0);
  assert.equal(raw.x, 100, "no smoothing means the raw pointer");

  const lazy = { x: 0, y: 0 };
  for (let i = 0; i < 400; i++) B.stabilise(lazy, 100, 0, 1);
  assert.ok(lazy.x > 99.9, "even at full smoothing the brush catches up");

  const mid = { x: 0, y: 0 };
  B.stabilise(mid, 100, 0, 0.5);
  assert.ok(mid.x > 0 && mid.x < 100);
});

test("the stabiliser starts where the pen went down", () => {
  const s = {};
  B.stabilise(s, 42, 24, 0.9);
  assert.equal(s.x, 42);
  assert.equal(s.y, 24);
});

test("simulated pressure is heavier when you draw slowly", () => {
  const slow = {};
  let sp = 0;
  for (let i = 0; i < 40; i++) sp = B.simulatedPressure(slow, 0.5, 16);
  const fast = {};
  let fp = 0;
  for (let i = 0; i < 40; i++) fp = B.simulatedPressure(fast, 40, 16);
  assert.ok(sp > fp, "slow strokes are heavier");
  assert.ok(fp >= 0.35 && sp <= 0.9, "and it stays inside a sane range");
});

/* ── tips ────────────────────────────────────────────────────────────────── */

test("the tip falloff is 1 in the middle and 0 at the rim", () => {
  for (const hardness of [0, 0.3, 0.8, 1]) {
    assert.equal(B.tipFalloff(0, hardness), 1, `centre at hardness ${hardness}`);
    assert.equal(B.tipFalloff(1, hardness), 0, `rim at hardness ${hardness}`);
    assert.equal(B.tipFalloff(1.5, hardness), 0, "outside the rim is nothing");
    let prev = 1;
    for (let r = 0; r <= 1; r += 0.05) {
      const v = B.tipFalloff(r, hardness);
      assert.ok(v <= prev + 1e-9, `falloff went back up at r=${r}`);
      prev = v;
    }
  }
});

test("a hard tip has a sharp edge and a soft one does not", () => {
  assert.equal(B.tipFalloff(0.5, 1), 1, "a hard tip is flat most of the way out");
  assert.ok(B.tipFalloff(0.5, 0) < 0.5, "a soft tip has faded by halfway");
});

test("a tip mask is square, opaque in the middle and clear at the corners", () => {
  const n = 32;
  const m = B.tipMask("round", n, 0.9, 1);
  assert.equal(m.length, n * n);
  const centre = m[(n / 2) * n + n / 2];
  assert.ok(centre > 240, `centre was ${centre}`);
  assert.equal(m[0], 0, "the corner is outside the circle");
  assert.equal(m[n - 1], 0);
});

test("the same tip is the same every time, so a stroke never shimmers", () => {
  const a = B.tipMask("chalk", 24, 0.5, 42);
  const b = B.tipMask("chalk", 24, 0.5, 42);
  assert.deepEqual([...a], [...b]);
  const c = B.tipMask("chalk", 24, 0.5, 43);
  assert.notDeepEqual([...a], [...c], "a different seed gives different grain");
});

test("textured tips are patchy and plain ones are not", () => {
  const n = 28;
  const solid = B.tipMask("round", n, 0.95, 5);
  const chalky = B.tipMask("chalk", n, 0.95, 5);
  const holes = (m) => [...m].filter((v, i) => solid[i] > 200 && v < 120).length;
  assert.equal(holes(solid), 0);
  assert.ok(holes(chalky) > 10, "chalk should be full of gaps");
  assert.ok(holes(B.tipMask("spray", n, 0.95, 5)) > 20, "spray is mostly gaps");
});

test("tip cache sizes are powers of two, so there are only a handful", () => {
  assert.equal(B.tipCacheSize(3), 4);
  assert.equal(B.tipCacheSize(17), 32);
  assert.equal(B.tipCacheSize(64), 64);
  assert.equal(B.tipCacheSize(5000), 1024, "and they stop growing somewhere sensible");
});

test("jitter is deterministic for a seed and stays inside its bounds", () => {
  const b = B.resolve("chalk", { jitter: 1, scatter: 0.5, angleJitter: 0 });
  const out = { dx: 0, dy: 0, scale: 1, angle: 0 };
  const r1 = B.rng(9);
  const r2 = B.rng(9);
  const a = { ...B.jitterStamp(b, r1, 100, out) };
  const c = { ...B.jitterStamp(b, r2, 100, { dx: 0, dy: 0, scale: 1, angle: 0 }) };
  assert.deepEqual(a, c);
  assert.ok(a.scale > 0.4 && a.scale <= 1);
  assert.ok(Math.hypot(a.dx, a.dy) <= 50.001, "scatter stays inside half a diameter");
});

test("a brush with no jitter stamps exactly on the line", () => {
  const b = B.resolve("inker");
  const out = B.jitterStamp(b, B.rng(1), 40, { dx: 9, dy: 9, scale: 9, angle: 9 });
  assert.deepEqual(out, { dx: 0, dy: 0, scale: 1, angle: 0 });
});

/* ── the bucket ──────────────────────────────────────────────────────────── */

function grid(w, h, paint) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
    }
  }
  return d;
}

test("a fill stops at a line and reports what it touched", () => {
  const w = 9, hh = 9;
  // a vertical wall down the middle
  const data = grid(w, hh, (x) => (x === 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const { mask, box } = B.floodFill(data, w, hh, 0, 0, 0.1);
  assert.equal(mask[0], 255);
  assert.equal(mask[4], 0, "the wall is not filled");
  assert.equal(mask[5], 0, "and nothing past it is either");
  assert.deepEqual([box.x0, box.y0, box.x1, box.y1], [0, 0, 3, 8]);
  assert.equal(box.count, 4 * 9);
});

test("a fill with enough tolerance goes straight through a soft line", () => {
  const w = 5, hh = 3;
  const data = grid(w, hh, (x) => (x === 2 ? [200, 200, 200, 255] : [255, 255, 255, 255]));
  assert.equal(B.floodFill(data, w, hh, 0, 0, 0.1).box.count, 6, "a tight tolerance stops at the line");
  assert.equal(B.floodFill(data, w, hh, 0, 0, 0.5).box.count, 15, "a loose one carries on");
});

test("a fill on transparency fills the transparent part", () => {
  const w = 4, hh = 2;
  const data = grid(w, hh, (x) => (x < 2 ? [0, 0, 0, 0] : [10, 20, 30, 255]));
  const { box } = B.floodFill(data, w, hh, 0, 0, 0.05);
  assert.equal(box.count, 4);
});

test("a fill started outside the canvas does nothing", () => {
  const data = grid(3, 3, () => [1, 2, 3, 255]);
  assert.equal(B.floodFill(data, 3, 3, -1, 0).box.count, 0);
  assert.equal(B.floodFill(data, 3, 3, 0, 99).box.count, 0);
});

test("a fill over a whole big canvas does not blow the stack", () => {
  const w = 700, hh = 700;
  const data = grid(w, hh, () => [255, 255, 255, 255]);
  const { box } = B.floodFill(data, w, hh, 350, 350, 0.05);
  assert.equal(box.count, w * hh);
});

test("growing a mask closes the gap an anti-aliased edge leaves", () => {
  const w = 5, hh = 5;
  const mask = new Uint8Array(w * hh);
  mask[2 * w + 2] = 255;
  const grown = B.growMask(mask, w, hh, 1);
  assert.equal(grown[2 * w + 1], 255);
  assert.equal(grown[1 * w + 2], 255);
  assert.equal(grown[0], 0, "and only by one pixel");
});

/* ── undo ────────────────────────────────────────────────────────────────── */

/** A pretend layer store: one array of bytes per layer, swapped by rectangle. */
function store(initial) {
  const layers = new Map(Object.entries(initial));
  return {
    layers,
    swap(id, x, y, w, h, data) {
      const was = layers.get(id);
      layers.set(id, data);
      return was;
    },
  };
}

test("undo swaps the rectangle back, and redo swaps it forward again", () => {
  const st = store({ a: "before" });
  const hist = new History();
  st.layers.set("a", "after");
  hist.push(pixelStep("Stroke", "a", 0, 0, 10, 10, "before", st.swap.bind(st)));

  assert.equal(st.layers.get("a"), "after");
  hist.undo();
  assert.equal(st.layers.get("a"), "before");
  hist.redo();
  assert.equal(st.layers.get("a"), "after");
  hist.undo();
  assert.equal(st.layers.get("a"), "before");
});

test("a new step throws away anything that was redoable", () => {
  const st = store({ a: "0" });
  const hist = new History();
  const step = (from, to) => { st.layers.set("a", to); hist.push(pixelStep("s", "a", 0, 0, 2, 2, from, st.swap.bind(st))); };
  step("0", "1");
  step("1", "2");
  hist.undo();
  assert.equal(hist.canRedo, true);
  step("1", "9");
  assert.equal(hist.canRedo, false);
  assert.equal(hist.depth, 2);
});

test("undo and redo stop cleanly at the ends", () => {
  const hist = new History();
  assert.equal(hist.undo(), null);
  assert.equal(hist.redo(), null);
  assert.equal(hist.canUndo, false);
  assert.equal(hist.canRedo, false);
});

test("a step's memory cost is the rectangle it snapshotted", () => {
  const hist = new History();
  const data = { byteLength: 300 * 300 * 4 };
  hist.push(pixelStep("Stroke", "a", 0, 0, 300, 300, data, () => data));
  assert.equal(hist.bytes, 360000);
  assert.equal(fmtBytes(360000), "352 KB");
});

test("the stack drops its oldest steps to stay inside the budget", () => {
  const hist = new History({ budget: 1000 });
  const st = store({ a: "x" });
  for (let i = 0; i < 10; i++) hist.push(pixelStep(`s${i}`, "a", 0, 0, 10, 10, { byteLength: 400 }, st.swap.bind(st)));
  assert.ok(hist.bytes <= 1000, `held ${hist.bytes}`);
  assert.equal(hist.depth, 2);
  assert.equal(hist.dropped, 8);
  assert.equal(hist.canUndo, true, "you can always still undo");
});

test("one step bigger than the whole budget is still kept", () => {
  const hist = new History({ budget: 100 });
  hist.push(pixelStep("huge", "a", 0, 0, 4000, 4000, { byteLength: 64000000 }, () => null));
  assert.equal(hist.depth, 1);
  assert.equal(hist.canUndo, true);
});

test("the default budget is a number you can hold in your head", () => {
  assert.equal(DEFAULT_BUDGET, 256 * 1024 * 1024);
  // one full-canvas fill on a 4000 x 4000 document
  assert.equal(D.layerBytes(4000, 4000), 64000000);
  assert.equal(fmtBytes(D.layerBytes(4000, 4000)), "61 MB");
  assert.equal(Math.floor(DEFAULT_BUDGET / D.layerBytes(4000, 4000)), 4, "four whole-canvas steps, or many more small ones");
});

test("a structural step puts the layer list back and forward again", () => {
  const before = { layers: ["a"], selected: "a" };
  const after = { layers: ["a", "b"], selected: "b" };
  let now = after;
  const hist = new History();
  hist.push(metaStep("Add layer", before, after, (s) => { now = s; }));
  hist.undo();
  assert.equal(now, before);
  hist.redo();
  assert.equal(now, after);
  assert.ok(hist.bytes < 500, "a layer-list step costs almost nothing");
});

test("labels say what undo is about to do", () => {
  const hist = new History();
  hist.push(metaStep("Add layer", {}, {}, () => {}));
  assert.equal(hist.undoLabel, "Add layer");
  assert.equal(hist.redoLabel, null);
  hist.undo();
  assert.equal(hist.undoLabel, null);
  assert.equal(hist.redoLabel, "Add layer");
});

test("a dirty rectangle is clamped to the canvas and padded for soft edges", () => {
  assert.deepEqual(dirtyRect({ x0: 10, y0: 10, x1: 20, y1: 20 }, 100, 100, 2), { x: 8, y: 8, w: 15, h: 15 });
  assert.deepEqual(dirtyRect({ x0: -50, y0: -50, x1: 5, y1: 5 }, 100, 100, 2), { x: 0, y: 0, w: 8, h: 8 });
  assert.deepEqual(dirtyRect({ x0: 95, y0: 95, x1: 500, y1: 500 }, 100, 100, 2), { x: 93, y: 93, w: 7, h: 7 });
});

test("a stroke that touched nothing makes no undo step", () => {
  assert.equal(dirtyRect(null, 100, 100), null);
  assert.equal(dirtyRect({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, 100, 100), null);
  assert.equal(dirtyRect({ x0: -100, y0: -100, x1: -90, y1: -90 }, 100, 100), null, "entirely off-canvas");
});

test("the stroke's bounding box grows by the brush radius", () => {
  const box = newBox();
  growBox(box, 50, 50, 10);
  growBox(box, 70, 40, 5);
  assert.deepEqual([box.x0, box.y0, box.x1, box.y1], [40, 35, 75, 60]);
});

test("bytes are printed the way the status bar shows them", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2 KB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(fmtBytes(320 * 1024 * 1024), "320 MB");
});

/* ── the mode framework ──────────────────────────────────────────────────── */

const M = await import("../paintmode.js");

test("a path belongs to exactly one drawing mode", () => {
  assert.equal(M.modeOf("Art/Study.excalidraw").id, "sketch");
  assert.equal(M.modeOf("Art/Study.leostudio").id, "draw");
  assert.equal(M.modeOf("Art/STUDY.LEOSTUDIO").id, "draw", "extensions are case-insensitive");
  assert.equal(M.modeOf("Art/Study.leopaint").id, "sketch", ".leopaint is the vector board");
  assert.equal(M.modeOf("Art/Old.leocanvas").id, "sketch", "an old .leocanvas still opens");
  assert.equal(M.modeOf("notes.md"), null);
  assert.equal(M.modeOf("photo.png"), null);
  assert.equal(M.modeOf(""), null);
  assert.equal(M.modeOf(null), null);
});

test("each mode declares everything the UI needs to show it", () => {
  assert.equal(M.MODES.length, 2, "Studio is stage 2 - add it here when it lands");
  for (const m of M.MODES) {
    for (const k of ["id", "name", "ext", "blurb", "detail", "icon"]) {
      assert.equal(typeof m[k], "string", `${m.id} has no ${k}`);
      assert.ok(m[k].length, `${m.id}'s ${k} is empty`);
    }
    assert.ok(m.ext.startsWith("."), m.id);
    assert.equal(typeof m.match, "function", m.id);
    assert.ok(m.match(`x${m.ext}`), `${m.id} does not match its own extension`);
  }
  assert.equal(new Set(M.MODES.map((m) => m.ext)).size, M.MODES.length, "two modes cannot share an extension");
});

test("the extension test matches exactly the two modes", () => {
  assert.ok(M.DRAWING_RE.test("a.excalidraw"));
  assert.ok(M.DRAWING_RE.test("a.leovector"));
  assert.equal(M.modeOf("Art/Study.leovector").id, "sketch");
  assert.ok(M.DRAWING_RE.test("a.leopaint"));
  assert.ok(!M.DRAWING_RE.test("a.leopaint.png"));
  assert.ok(M.DRAWING_RE.test("a.leostudio"));
  assert.ok(!M.DRAWING_RE.test("a.canvas"));
});

test("a box picks every piece it touches, whole", async () => {
  const { islandsTouching } = await import("../paintselect.js");
  const w = 64, hgt = 32, data = new Uint8ClampedArray(w * hgt * 4);
  const dot = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[(y * w + x) * 4 + 3] = 255; };
  dot(2, 20, 2, 6);   // a long stroke on the left
  dot(40, 60, 20, 30); // a blob on the right
  const r = islandsTouching(data, w, hgt, { x: 0, y: 0, w: 5, h: 5 }, { cell: 1 });
  assert.equal(r.count, 18 * 4); // the whole stroke, though the box only reached its end
  assert.equal(r.mask[3 * w + 19], 255);
  assert.equal(r.mask[25 * w + 50], 0); // not the blob
});

test("select subject: a plain background found from the edges, the rest is the subject", async () => {
  const { subjectMask } = await import("../paintselect.js");
  const w = 40, hgt = 30, data = new Uint8ClampedArray(w * hgt * 4);
  for (let i = 0; i < w * hgt; i++) { data[i * 4] = 245; data[i * 4 + 1] = 245; data[i * 4 + 2] = 240; data[i * 4 + 3] = 255; }
  for (let y = 10; y < 20; y++) for (let x = 15; x < 25; x++) { const i = (y * w + x) * 4; data[i] = 200; data[i + 1] = 30; data[i + 2] = 40; }
  const r = subjectMask(data, w, hgt);
  assert.equal(r.count, 100);
  assert.equal(r.mask[15 * w + 20], 255);
  assert.equal(r.mask[2 * w + 2], 0);
});
