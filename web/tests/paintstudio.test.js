// Studio's pure half: the version-2 document (kinds, masks, clipping, groups),
// what every adjustment does to a colour, the geometry behind symmetry, guides,
// crop and export templates, and the selections that come from the picture.
//
// The GPU does the real work in the app — an adjustment is an SVG filter, a
// mask is a composite — but every one of those is defined here first, in
// numbers, so "curves at 128" means one thing and stays meaning it.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as D from "../paintdoc.js";
import * as A from "../paintadjust.js";
import * as G from "../paintgeom.js";
import * as S from "../paintselect.js";
import { History, groupStep, metaStep } from "../painthistory.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ── the document, version 2 ─────────────────────────────────────────────── */

test("a drawing that uses nothing new is still written as version 1", () => {
  const doc = D.newDoc({});
  doc.layers.push(D.newLayer({ name: "Ink", blend: "multiply" }));
  const m = D.toManifest(doc);
  assert.equal(m.version, 1, "an older Leonote must still be able to open it");
  assert.ok(m.layers.every((l) => l.kind === undefined && l.file), "and nothing in it that version 1 did not have");
});

test("kinds, masks, clipping and groups survive a round trip", () => {
  const doc = D.newDoc({ width: 800, height: 600 });
  const group = D.newLayer({ kind: "group", name: "Figure", passThrough: true, collapsed: true });
  const adj = D.newLayer({ kind: "adjust", name: "Curves", adjust: { type: "curves", rgb: [[0, 0], [128, 90], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] }, mask: true, maskOn: false });
  const text = D.newLayer({ kind: "text", name: "Title", text: { ...D.TEXT_DEFAULTS, text: "Hello\nthere", font: "Georgia", size: 72, bold: true, align: "center", x: 400, y: 80 } });
  doc.layers[0].parent = group.id;
  const shade = D.newLayer({ name: "Shade", clip: true, parent: group.id, blend: "luminosity" });
  doc.layers.push(shade, group, adj, text);
  const m = D.toManifest(doc);
  assert.equal(m.version, 2);
  const back = D.fromManifest(JSON.stringify(m));

  assert.deepEqual(back.layers.map((l) => l.kind), ["raster", "raster", "group", "adjust", "text"]);
  const g = back.layers[2];
  assert.ok(g.passThrough && g.collapsed);
  assert.equal(back.layers[0].parent, g.id);
  assert.equal(back.layers[1].parent, g.id);
  assert.ok(back.layers[1].clip);
  assert.equal(back.layers[1].blend, "luminosity");
  assert.equal(back.layers[2].file, null, "a group has no pixels");
  assert.equal(back.layers[3].file, null, "nor has an adjustment");
  assert.ok(back.layers[3].mask && back.layers[3].maskOn === false);
  assert.deepEqual(back.layers[3].adjust.rgb, [[0, 0], [128, 90], [255, 255]]);
  assert.equal(back.layers[4].text.text, "Hello\nthere");
  assert.equal(back.layers[4].text.font, "Georgia");
  assert.ok(back.layers[4].text.bold);
  assert.equal(back.layers[4].file, `layers/${back.layers[4].id}.png`, "text keeps a PNG, so any viewer can see it");
});

test("a mask travels as a second PNG beside its layer", () => {
  const doc = D.newDoc({});
  doc.layers[0].mask = true;
  const names = D.entryNames(doc);
  assert.deepEqual(names, ["doc.json", `layers/${doc.layers[0].id}.png`, `layers/${doc.layers[0].id}-mask.png`, "thumb.png"]);
  assert.equal(D.toManifest(doc).layers[0].mask, `layers/${doc.layers[0].id}-mask.png`);
  assert.ok(D.isMaskKey(D.maskKey("abc")));
  assert.equal(D.layerOfKey(D.maskKey("abc")), "abc");
});

test("an adjustment and a group carry no PNG in the container", () => {
  const doc = D.newDoc({});
  doc.layers.push(D.newLayer({ kind: "adjust", adjust: { type: "invert" } }), D.newLayer({ kind: "group" }));
  assert.equal(D.entryNames(doc).length, 3);
});

test("a parent that is not a group in the file is dropped, not trusted", () => {
  const back = D.fromManifest({ version: 2, width: 10, height: 10, layers: [{ id: "a", parent: "ghost" }, { id: "b", parent: "a" }] });
  assert.deepEqual(back.layers.map((l) => l.parent), [null, null]);
});

test("hand-written nonsense in a text layer is clamped", () => {
  const back = D.fromManifest({ version: 2, width: 10, height: 10, layers: [{ id: "t", kind: "text", text: { text: 5, size: 99999, colour: "red", align: "justify", lineHeight: -3 } }] });
  const t = back.layers[0].text;
  assert.equal(t.text, "");
  assert.equal(t.size, 2000);
  assert.equal(t.colour, D.TEXT_DEFAULTS.colour);
  assert.equal(t.align, "left");
  assert.equal(t.lineHeight, 0.5);
});

/* ── the layer tree ──────────────────────────────────────────────────────── */

const L = (id, over = {}) => ({ ...D.newLayer({ name: id, ...over }), id });

test("a group's children are gathered directly under it", () => {
  const layers = [L("a", { parent: "g" }), L("x"), L("b", { parent: "g" }), L("g", { kind: "group" }), L("y")];
  const flat = D.normalizeLayers(layers);
  assert.deepEqual(flat.map((l) => l.id), ["x", "a", "b", "g", "y"], "top-level order is kept; the group brings its children with it");
  const gi = flat.findIndex((l) => l.id === "g");
  assert.deepEqual(flat.slice(gi - 2, gi).map((l) => l.id), ["a", "b"], "children sit right below their group, in order");
  assert.equal(flat.length, 5);
});

test("the tree nests, and comes back out the same", () => {
  const layers = [L("a", { parent: "inner" }), L("inner", { kind: "group", parent: "outer" }), L("b", { parent: "outer" }), L("outer", { kind: "group" }), L("top")];
  const tree = D.layerTree(layers);
  assert.deepEqual(tree.map((n) => n.layer.id), ["outer", "top"]);
  assert.deepEqual(tree[0].children.map((n) => n.layer.id), ["inner", "b"]);
  assert.deepEqual(tree[0].children[0].children.map((n) => n.layer.id), ["a"]);
  assert.deepEqual(D.flattenTree(tree).map((l) => l.id), ["a", "inner", "b", "outer", "top"]);
  assert.equal(D.depthOf(layers, layers[0]), 2);
  assert.deepEqual(D.descendants(layers, "outer").map((l) => l.id).sort(), ["a", "b", "inner"]);
});

test("a cycle of parents cannot hang the tree or lose a layer", () => {
  const layers = [L("g1", { kind: "group", parent: "g2" }), L("g2", { kind: "group", parent: "g1" }), L("x", { parent: "g1" })];
  const flat = D.normalizeLayers(layers);
  assert.equal(flat.length, 3);
  assert.deepEqual(flat.map((l) => l.id).sort(), ["g1", "g2", "x"]);
});

test("dropping a layer into a group, above a row and below a row", () => {
  const base = () => [L("a"), L("b"), L("g", { kind: "group" }), L("c")];
  const into = D.moveLayerTo(base(), "a", "g", { into: true });
  assert.equal(into.find((l) => l.id === "a").parent, "g");
  assert.ok(into.findIndex((l) => l.id === "a") < into.findIndex((l) => l.id === "g"));

  const above = D.moveLayerTo(base(), "a", "c");
  assert.deepEqual(above.map((l) => l.id), ["b", "g", "c", "a"]);

  const below = D.moveLayerTo(base(), "c", "a", { below: true });
  assert.deepEqual(below.map((l) => l.id), ["c", "a", "b", "g"]);
});

test("dragging a layer out of a group takes it out", () => {
  const layers = [L("a", { parent: "g" }), L("g", { kind: "group" }), L("top")];
  const out = D.moveLayerTo(layers, "a", "top");
  assert.equal(out.find((l) => l.id === "a").parent, null);
  assert.deepEqual(out.map((l) => l.id), ["g", "top", "a"]);
});

test("a group moves with everything in it, and cannot go inside itself", () => {
  const make = () => [L("a", { parent: "g" }), L("b", { parent: "g" }), L("g", { kind: "group" }), L("x")];
  const moved = D.moveLayerTo(make(), "g", "x");
  assert.deepEqual(moved.map((l) => l.id), ["x", "a", "b", "g"]);
  const same = D.moveLayerTo(make(), "g", "a", { into: true });
  assert.deepEqual(same.map((l) => l.id), ["a", "b", "g", "x"], "dropping a group on its own child does nothing");
});

test("a clipped layer clips to the nearest unclipped layer below it in the same group", () => {
  const layers = [L("base"), L("shade", { clip: true }), L("light", { clip: true }), L("other")];
  assert.equal(D.clipBase(layers, "light").id, "base");
  assert.equal(D.clipBase(layers, "shade").id, "base");
  assert.equal(D.clipBase(layers, "base"), null, "the bottom layer has nothing to clip to");
  const grouped = [L("outside"), L("in", { parent: "g", clip: true }), L("g", { kind: "group" })];
  assert.equal(D.clipBase(grouped, "in"), null, "a layer outside the group is not its base");
});

test("pixels merge down only onto pixels, inside the same group", () => {
  const doc = D.newDoc({});
  const adj = D.newLayer({ kind: "adjust", adjust: { type: "invert" } });
  const top = D.newLayer({ name: "top" });
  doc.layers.push(adj, top);
  assert.equal(D.mergeTarget(doc, top.id), null, "not onto an adjustment");
  assert.equal(D.mergeTarget(doc, adj.id), null, "and an adjustment has nothing to merge");
  const g = D.newLayer({ kind: "group" });
  const doc2 = D.newDoc({});
  doc2.layers[0].parent = g.id;
  const out = D.newLayer({});
  doc2.layers.push(g, out);
  assert.equal(D.mergeTarget(doc2, out.id), null, "not onto a group either");
});

/* ── the new blend modes ─────────────────────────────────────────────────── */

test("hard light is overlay with the layers swapped", () => {
  for (const [b, s] of [[0.2, 0.7], [0.8, 0.3], [0.5, 0.5], [0.1, 0.9]]) assert.ok(near(D.BLEND_FN["hard-light"](b, s), D.BLEND_FN.overlay(s, b)));
});

test("difference and exclusion agree at the ends and differ in the middle", () => {
  const f = D.BLEND_FN;
  assert.equal(f.difference(0.8, 0.8), 0);
  assert.ok(near(f.difference(1, 0.25), 0.75));
  assert.ok(near(f.exclusion(1, 0.25), 0.75));
  assert.ok(near(f.exclusion(0.5, 0.5), 0.5), "exclusion is softer: mid grey on mid grey stays grey");
  assert.equal(f.difference(0.5, 0.5), 0);
});

test("dodge and burn never leave the range", () => {
  for (let b = 0; b <= 1; b += 0.25) for (let s = 0; s <= 1; s += 0.25) {
    for (const m of ["color-dodge", "color-burn"]) { const v = D.BLEND_FN[m](b, s); assert.ok(v >= 0 && v <= 1, `${m}(${b}, ${s}) = ${v}`); }
  }
  assert.equal(D.BLEND_FN["color-dodge"](0, 1), 0, "black stays black under dodge");
  assert.equal(D.BLEND_FN["color-burn"](1, 0), 1, "white stays white under burn");
});

test("luminosity takes the light from the top and the colour from underneath", () => {
  const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const backdrop = [0.8, 0.2, 0.2];
  const source = [0.5, 0.5, 0.5];
  const out = D.BLEND_WHOLE.luminosity(backdrop, source);
  assert.ok(near(lum(out), lum(source), 1e-9));
  assert.ok(out[0] > out[1] && near(out[1], out[2]), "still a red");
  const colour = D.BLEND_WHOLE.color(backdrop, [0.1, 0.4, 0.9]);
  assert.ok(near(lum(colour), lum(backdrop), 1e-9), "and `color` is the other way round");
  assert.ok(colour[2] > colour[0], "now a blue");
});

test("blendPixel uses the whole-colour modes too", () => {
  const out = D.blendPixel([0.8, 0.2, 0.2, 1], [0.5, 0.5, 0.5, 1], "saturation", 1);
  assert.ok(near(out[0], out[1], 1e-9) && near(out[1], out[2], 1e-9), "the saturation of a grey is none");
});

/* ── the view ────────────────────────────────────────────────────────────── */

test("a mirrored, turned view still maps a point there and back", () => {
  const view = { zoom: 0.37, angle: 0.6, flip: true, cx: 410, cy: 233, width: 1280, height: 720 };
  for (const [x, y] of [[0, 0], [1280, 720], [333.5, 12.25]]) {
    const s = D.toScreenPoint(view, x, y);
    const p = D.toDocPoint(view, s.x, s.y);
    assert.ok(near(p.x, x, 1e-7) && near(p.y, y, 1e-7));
  }
  const plain = D.toScreenPoint({ ...view, flip: false, angle: 0 }, 0, 360);
  const flipped = D.toScreenPoint({ ...view, angle: 0 }, 0, 360);
  assert.ok(plain.x < view.cx && flipped.x > view.cx, "the left edge is on the right when mirrored");
});

/* ── adjustments ─────────────────────────────────────────────────────────── */

test("every adjustment at its defaults does nothing, and says so", () => {
  for (const a of A.ADJUSTMENTS) {
    const adj = A.newAdjust(a.id);
    const stages = A.stagesOf(adj);
    // these have no "off": adding one is asking for what it does
    if (["invert", "posterize", "threshold", "gradientmap", "bw", "photofilter"].includes(a.id)) { assert.ok(stages.length, `${a.id} always does something`); continue; }
    assert.deepEqual(stages, [], `${a.id} at rest should cost the renderer nothing`);
    const px = new Uint8ClampedArray([10, 120, 240, 255, 0, 0, 0, 255, 255, 255, 255, 128]);
    const before = [...px];
    A.applyStages(stages, px);
    assert.deepEqual([...px], before, `${a.id} at rest changed a pixel`);
    assert.ok(A.isIdentity(adj), `${a.id} at rest should be skippable`);
  }
});

test("alpha is never touched by an adjustment", () => {
  const px = new Uint8ClampedArray([200, 100, 50, 77]);
  A.applyAdjust({ type: "invert" }, px);
  assert.deepEqual([...px], [55, 155, 205, 77]);
});

test("a curve goes through its points, never overshoots, and rests as a straight line", () => {
  const rest = A.curveTable([[0, 0], [255, 255]]);
  for (let i = 0; i < 256; i++) assert.equal(rest[i], i);
  const t = A.curveTable([[0, 0], [64, 30], [128, 140], [200, 190], [255, 255]]);
  assert.equal(t[64], 30);
  assert.equal(t[128], 140);
  assert.equal(t[200], 190);
  for (let i = 1; i < 256; i++) assert.ok(t[i] >= t[i - 1], `a rising set of points gave a falling curve at ${i}`);
  // a flat top stays flat: the spline must not bulge above it
  const flat = A.curveTable([[0, 0], [100, 200], [255, 200]]);
  for (let i = 100; i < 256; i++) assert.equal(flat[i], 200);
});

test("curve points in any order, doubled, or out of range still make a table", () => {
  const t = A.curveTable([[255, 255], [0, 0], [128, 64], [128, 70], [400, -20], ["x", 1]]);
  assert.equal(t.length, 256);
  assert.equal(t[128], 70, "the later of two points at one x wins");
  assert.equal(A.curveTable([])[77], 77);
  assert.equal(A.curveTable([[10, 99]])[200], 99);
});

test("levels: black point, white point, gamma and output", () => {
  const t = A.levelsTable({ inBlack: 50, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 });
  assert.equal(t[0], 0);
  assert.equal(t[50], 0);
  assert.equal(t[200], 255);
  assert.equal(t[255], 255);
  assert.equal(t[125], 128);
  const bright = A.levelsTable({ gamma: 2 });
  assert.ok(bright[64] > 64 && bright[0] === 0 && bright[255] === 255, "gamma moves the middle and leaves the ends");
  const out = A.levelsTable({ outBlack: 40, outWhite: 215 });
  assert.equal(out[0], 40);
  assert.equal(out[255], 215);
  assert.equal(A.levelsTable({ inBlack: 200, inWhite: 100 })[255], 255, "a white point under the black point cannot divide by zero");
});

test("channel tables run before the master one", () => {
  const first = A.curveTable([[0, 0], [255, 128]]);
  const second = A.levelsTable({ inWhite: 128 });
  const both = A.chainTables(first, second);
  assert.equal(both[255], 255);
  assert.equal(both[0], 0);
});

test("saturation at minus a hundred is grey; hue at 180 swaps red for cyan", () => {
  const grey = new Uint8ClampedArray([200, 40, 40, 255]);
  A.applyAdjust({ type: "hsl", saturation: -100 }, grey);
  assert.ok(Math.abs(grey[0] - grey[1]) <= 1 && Math.abs(grey[1] - grey[2]) <= 1);
  const red = new Uint8ClampedArray([220, 40, 40, 255]);
  A.applyAdjust({ type: "hsl", hue: 180 }, red);
  assert.ok(red[1] > red[0] && red[2] > red[0], `got ${[...red]}`);
});

test("white balance warms and cools without changing how bright the picture is", () => {
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const base = [128, 128, 128, 255];
  const warm = new Uint8ClampedArray(base);
  A.applyAdjust({ type: "temperature", temperature: 60, tint: 0 }, warm);
  assert.ok(warm[0] > warm[2], "warmer is redder than it is blue");
  assert.ok(Math.abs(lum(warm) - lum(base)) < 2);
  const cool = new Uint8ClampedArray(base);
  A.applyAdjust({ type: "temperature", temperature: -60 }, cool);
  assert.ok(cool[2] > cool[0]);
});

test("threshold gives black and white and nothing else; posterise gives exactly n levels", () => {
  const px = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = i; px[i * 4 + 3] = 255; }
  const th = new Uint8ClampedArray(px);
  A.applyAdjust({ type: "threshold", level: 100 }, th);
  assert.deepEqual([...new Set(th.filter((_, i) => i % 4 === 0))].sort((a, b) => a - b), [0, 255]);
  assert.equal(th[99 * 4], 0);
  assert.equal(th[100 * 4], 255);
  const po = new Uint8ClampedArray(px);
  A.applyAdjust({ type: "posterize", levels: 5 }, po);
  assert.equal(new Set(po.filter((_, i) => i % 4 === 0)).size, 5);
});

test("a gradient map paints shadows with its first colour and highlights with its last", () => {
  const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  A.applyAdjust({ type: "gradientmap", stops: [{ at: 1, colour: "#ffee00" }, { at: 0, colour: "#102030" }] }, px);
  assert.deepEqual([...px.slice(0, 3)], [16, 32, 48]);
  assert.deepEqual([...px.slice(4, 7)], [255, 238, 0]);
});

test("the GPU filter is the same stages, spelled as SVG", () => {
  const stages = A.stagesOf({ type: "hsl", hue: 20, saturation: 30, lightness: 10 });
  assert.deepEqual(stages.map((s) => s.kind), ["matrix", "lut"]);
  const svg = A.filterMarkup(stages);
  assert.match(svg, /^<feColorMatrix type="matrix" values="[-\d. ]+"\/><feComponentTransfer>/);
  const table = /tableValues="([^"]+)"/.exec(svg)[1].split(" ");
  assert.equal(table.length, 256, "one entry per 8-bit value, so nothing is interpolated");
  assert.equal(A.filterMarkup([]), "");
});

test("the same numbers give the same filter key, whatever order they were written in", () => {
  const a = A.adjustKey({ type: "brightness", brightness: 10, contrast: 5 });
  const b = A.adjustKey({ contrast: 5, brightness: 10, type: "brightness", junk: 1 });
  assert.equal(a, b);
  assert.notEqual(a, A.adjustKey({ type: "brightness", brightness: 11, contrast: 5 }));
});

test("an adjustment from a broken file cannot do damage", () => {
  assert.deepEqual(A.stagesOf({ type: "mystery" }), []);
  assert.deepEqual(A.stagesOf(null), []);
  assert.doesNotThrow(() => A.stagesOf({ type: "curves", rgb: "nope" }));
  assert.doesNotThrow(() => A.stagesOf({ type: "gradientmap", stops: [{ at: "x" }] }));
});

test("a matrix after a matrix is one matrix", () => {
  const sat = A.saturationMatrix(0);
  const hue = A.hueMatrix(90);
  const px1 = new Uint8ClampedArray([200, 80, 30, 255]);
  A.applyStages([{ kind: "matrix", m: hue }, { kind: "matrix", m: sat }], px1);
  const px2 = new Uint8ClampedArray([200, 80, 30, 255]);
  A.applyStages([{ kind: "matrix", m: A.mulMatrix(hue, sat) }], px2);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(px1[i] - px2[i]) <= 1);
});

test("auto levels finds where the tones really start and stop", () => {
  const data = new Uint8ClampedArray(1000 * 4);
  for (let i = 0; i < 1000; i++) { const v = 60 + Math.floor((i / 1000) * 120); data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
  data[3] = 0; // a transparent pixel has no tone
  const h = A.histogram(data);
  assert.equal(h.count, 999);
  const adj = A.autoLevels(h);
  assert.ok(adj.rgb.inBlack >= 60 && adj.rgb.inBlack <= 62);
  assert.ok(adj.rgb.inWhite >= 177 && adj.rgb.inWhite <= 179);
  assert.deepEqual(A.autoLevels(A.histogram(new Uint8ClampedArray(0))).rgb, A.newAdjust("levels").rgb, "an empty picture is left alone");
});

test("the unsharp mask adds back what a blur took away", () => {
  const svg = A.sharpenMarkup(150, 2);
  assert.match(svg, /stdDeviation="2"/);
  assert.match(svg, /k2="2\.5" k3="-1\.5"/);
});

/* ── symmetry ────────────────────────────────────────────────────────────── */

test("each symmetry lays down the number of copies it says", () => {
  const n = (mode, count) => G.symmetryPoints({ mode, count, cx: 100, cy: 100 }, 130, 90).length;
  assert.equal(n("none"), 1);
  assert.equal(n("vertical"), 2);
  assert.equal(n("horizontal"), 2);
  assert.equal(n("quad"), 4);
  assert.equal(n("radial", 6), 6);
  assert.equal(n("mandala", 6), 12);
  assert.equal(n("radial", 999), 32, "and never an absurd number");
});

test("mirrors land where a mirror would put them", () => {
  const v = G.symmetryPoints({ mode: "vertical", cx: 100, cy: 50 }, 130, 40);
  assert.deepEqual([v[1].x, v[1].y, v[1].flip], [70, 40, true]);
  const q = G.symmetryPoints({ mode: "quad", cx: 0, cy: 0 }, 3, 4).map((p) => [p.x, p.y]);
  assert.deepEqual(q, [[3, 4], [-3, 4], [3, -4], [-3, -4]]);
  const r = G.symmetryPoints({ mode: "radial", count: 4, cx: 0, cy: 0 }, 10, 0);
  assert.ok(near(r[1].x, 0, 1e-9) && near(r[1].y, 10, 1e-9));
  for (const p of G.symmetryPoints({ mode: "mandala", count: 8, cx: 5, cy: 5 }, 9, 8)) assert.ok(near(Math.hypot(p.x - 5, p.y - 5), 5, 1e-9), "every copy is as far from the centre");
});

/* ── guides ──────────────────────────────────────────────────────────────── */

test("a guide waits to see which way the stroke goes, then holds it there", () => {
  const start = { x: 100, y: 100 };
  assert.equal(G.guideLock({ kind: "grid" }, start, { x: 102, y: 101 }), null, "two pixels is not an intent");
  const lock = G.guideLock({ kind: "grid" }, start, { x: 140, y: 110 });
  assert.deepEqual(G.guideSnap(lock, { x: 190, y: 133 }), { x: 190, y: 100 }, "mostly sideways: held horizontal");
  const up = G.guideLock({ kind: "grid" }, start, { x: 104, y: 60 });
  const s = G.guideSnap(up, { x: 120, y: 20 });
  assert.ok(near(s.x, 100, 1e-9) && near(s.y, 20, 1e-9));
});

test("a vanishing point pulls strokes along the line to it", () => {
  const g = { kind: "vanish", cx: 500, cy: 100 };
  const lock = G.guideLock(g, { x: 100, y: 300 }, { x: 130, y: 286 });
  const p = G.guideSnap(lock, { x: 300, y: 250 });
  // on the line from the start to the vanishing point: the cross product is zero
  assert.ok(near((p.x - 100) * (100 - 300) - (p.y - 300) * (500 - 100), 0, 1e-6));
});

test("concentric circles keep the radius the stroke started on", () => {
  const lock = G.guideLock({ kind: "circle", cx: 0, cy: 0 }, { x: 30, y: 40 }, { x: 30, y: 40 });
  const p = G.guideSnap(lock, { x: 200, y: 0 });
  assert.ok(near(p.x, 50, 1e-9) && near(p.y, 0, 1e-9));
});

test("isometric guides offer thirty degrees either way, and upright", () => {
  const lock = G.guideLock({ kind: "iso" }, { x: 0, y: 0 }, { x: 40, y: 20 });
  assert.ok(near(Math.atan2(lock.uy, lock.ux), Math.PI / 6, 1e-9));
  const v = G.guideLock({ kind: "iso" }, { x: 0, y: 0 }, { x: 2, y: 50 });
  assert.ok(near(Math.abs(v.uy), 1, 1e-9));
});

test("Shift snaps an angle to fifteen degrees and keeps the length", () => {
  const p = G.snapAngle(0, 0, 100, 8);
  assert.ok(near(p.y, 0, 1e-9) && near(p.x, Math.hypot(100, 8), 1e-9));
  const q = G.snapAngle(0, 0, 70, 75);
  assert.ok(near(Math.atan2(q.y, q.x), Math.PI / 4, 1e-9));
});

test("hold to straighten: a wobbly line is a line, a curve is not", () => {
  const wobble = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: 100 + Math.sin(i) * 4 }));
  const line = G.straightLine(wobble);
  assert.ok(line && line.x0 === 0 && line.x1 === 390);
  const arc = Array.from({ length: 40 }, (_, i) => ({ x: Math.cos(i / 25) * 200, y: Math.sin(i / 25) * 200 }));
  assert.equal(G.straightLine(arc), null);
  const back = [...wobble, ...wobble.slice().reverse().slice(0, 30)];
  assert.equal(G.straightLine(back), null, "a line drawn there and back is not one straight line");
  assert.equal(G.straightLine([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 0 }]), null, "too short to mean it");
});

test("a closed, roundish stroke is an ellipse; an open one is not", () => {
  const ring = Array.from({ length: 60 }, (_, i) => { const a = (i / 59) * Math.PI * 2; return { x: 300 + Math.cos(a) * 120 + Math.sin(i) * 3, y: 200 + Math.sin(a) * 70 + Math.cos(i) * 3 }; });
  const e = G.cleanEllipse(ring);
  assert.ok(e && Math.abs(e.cx - 300) < 4 && Math.abs(e.rx - 120) < 6 && Math.abs(e.ry - 70) < 6);
  assert.equal(G.cleanEllipse(ring.slice(0, 35)), null);
});

/* ── crop and canvas ─────────────────────────────────────────────────────── */

test("dragging a crop handle moves only the sides that handle owns", () => {
  const r = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(G.dragCrop(r, "e", 50, 999), { x: 100, y: 100, w: 450, h: 300 });
  assert.deepEqual(G.dragCrop(r, "nw", 20, 10), { x: 120, y: 110, w: 380, h: 290 });
  assert.deepEqual(G.dragCrop(r, "move", -30, 5), { x: 70, y: 105, w: 400, h: 300 });
});

test("a crop cannot be turned inside out", () => {
  const r = G.dragCrop({ x: 0, y: 0, w: 100, h: 100 }, "e", -500, 0, { min: 8 });
  assert.deepEqual(r, { x: 0, y: 0, w: 8, h: 100 });
  const l = G.dragCrop({ x: 0, y: 0, w: 100, h: 100 }, "w", 500, 0, { min: 8 });
  assert.deepEqual(l, { x: 92, y: 0, w: 8, h: 100 });
});

test("a fixed shape holds while a corner or an edge is dragged", () => {
  const sq = G.dragCrop({ x: 0, y: 0, w: 200, h: 200 }, "se", 100, 20, { ratio: 1 });
  assert.ok(near(sq.w / sq.h, 1, 1e-9));
  assert.deepEqual([sq.x, sq.y], [0, 0], "the opposite corner stays put");
  const wide = G.dragCrop({ x: 0, y: 0, w: 160, h: 90 }, "e", 160, 0, { ratio: 16 / 9 });
  assert.ok(near(wide.w / wide.h, 16 / 9, 1e-9));
  assert.ok(near(wide.y + wide.h / 2, 45, 1e-9), "an edge drag grows about the middle of the other axis");
  const nw = G.dragCrop({ x: 100, y: 100, w: 200, h: 200 }, "nw", -50, -10, { ratio: 1 });
  assert.ok(near(nw.x + nw.w, 300, 1e-9) && near(nw.y + nw.h, 300, 1e-9));
});

test("the biggest rectangle of a shape that fits, centred", () => {
  assert.deepEqual(G.fitRatio(1000, 500, 1), { x: 250, y: 0, w: 500, h: 500 });
  assert.deepEqual(G.fitRatio(500, 1000, 2), { x: 0, y: 375, w: 500, h: 250 });
  assert.deepEqual(G.fitRatio(640, 480, 0), { x: 0, y: 0, w: 640, h: 480 });
});

test("the anchor says where the old picture sits on the new canvas", () => {
  assert.deepEqual(G.anchorOffset(100, 100, 300, 200, "nw"), { x: 0, y: 0 });
  assert.deepEqual(G.anchorOffset(100, 100, 300, 200, "c"), { x: 100, y: 50 });
  assert.deepEqual(G.anchorOffset(100, 100, 300, 200, "se"), { x: 200, y: 100 });
  assert.deepEqual(G.anchorOffset(100, 100, 300, 200, "n"), { x: 100, y: 0 });
  assert.deepEqual(G.anchorOffset(300, 200, 100, 100, "c"), { x: -100, y: -50 }, "shrinking cuts evenly from both sides");
});

test("a rectangle dragged backwards is still a rectangle of whole pixels", () => {
  assert.deepEqual(G.normRect({ x: 100.4, y: 50.6, w: -40.2, h: -10 }), { x: 60, y: 41, w: 40, h: 10 });
  assert.deepEqual(G.normRect({ x: 0, y: 0, w: 0.2, h: 0 }), { x: 0, y: 0, w: 1, h: 1 });
});

test("units: an A4 at 300 dpi is 2480 pixels wide, either way round", () => {
  assert.equal(G.unitToPx(210, "mm", 300), 2480);
  assert.ok(near(G.pxToUnit(2480, "mm", 300), 209.97, 0.01));
  assert.equal(G.unitToPx(8.5, "in", 300), 2550);
  assert.equal(G.unitToPx(640.4, "px", 300), 640);
  assert.deepEqual(G.keepAspect(1600, 900, { width: 800 }), { width: 800, height: 450 });
  assert.deepEqual(G.keepAspect(1600, 900, { height: 300 }), { width: 533, height: 300 });
});

/* ── export templates ────────────────────────────────────────────────────── */

test("the export sizes are the ones the sites ask for", () => {
  const t = (id) => G.EXPORT_TEMPLATE_BY_ID.get(id);
  assert.deepEqual([t("ig-portrait").w, t("ig-portrait").h], [1080, 1350]);
  assert.deepEqual([t("ig-story").w, t("ig-story").h], [1080, 1920]);
  assert.deepEqual([t("yt-thumb").w, t("yt-thumb").h], [1280, 720]);
  assert.equal(t("yt-thumb").maxBytes, 2 * 1024 * 1024, "YouTube refuses a thumbnail over 2 MB");
  assert.deepEqual([t("yt-banner").w, t("yt-banner").h], [2560, 1440]);
  assert.deepEqual([t("x-header").w, t("x-header").h], [1500, 500]);
  const all = G.EXPORT_TEMPLATES.flatMap((g) => g.items);
  assert.equal(new Set(all.map((x) => x.id)).size, all.length, "no two templates share an id");
  for (const x of all) assert.ok(x.w >= 64 && x.h >= 64 && x.w <= 8192 && x.h <= 8192, x.id);
});

test("fill covers the frame, fit shows everything, stretch does as it is told", () => {
  const cover = G.fitInto(4000, 3000, 1080, 1080, "cover");
  assert.ok(near(cover.h, 1080) && near(cover.w, 1440) && near(cover.x, -180) && near(cover.y, 0));
  const contain = G.fitInto(4000, 3000, 1080, 1080, "contain");
  assert.ok(near(contain.w, 1080) && near(contain.h, 810) && near(contain.y, 135));
  assert.deepEqual(G.fitInto(4000, 3000, 1080, 1080, "stretch"), { x: 0, y: 0, w: 1080, h: 1080 });
});

test("the focus point moves a fill's crop, and never shows an empty edge", () => {
  const left = G.fitInto(4000, 3000, 1080, 1080, "cover", { x: 0, y: 0.5 });
  assert.ok(near(left.x, 0), "focus on the left keeps the left");
  const right = G.fitInto(4000, 3000, 1080, 1080, "cover", { x: 1, y: 0.5 });
  assert.ok(near(right.x, -360));
  const wild = G.fitInto(4000, 3000, 1080, 1080, "cover", { x: 7, y: -3 });
  assert.ok(wild.x <= 0 && wild.x + wild.w >= 1080 && wild.y <= 0 && wild.y + wild.h >= 1080);
});

test("a template export is named for what it is for", () => {
  const p = D.exportPath("Art/Poster.leopaint", { format: "jpeg", label: "YouTube Thumbnail" });
  assert.equal(p, "Art/Poster - YouTube Thumbnail.jpg");
  const odd = D.exportPath("Poster.leopaint", { format: "png", label: 'a/b:c*"d' });
  assert.ok(!/[/:*"]/.test(odd.replace(/^Poster/, "")), "and whatever is in the label cannot make a path");
  assert.equal(D.exportPath("Poster.leopaint", { scale: 0.5 }), "Poster @half.png", "scaled exports are named as before");
});

/* ── selections from the picture ─────────────────────────────────────────── */

/** A `w × h` picture filled by `fn(x, y) -> [r, g, b, a]`. */
function picture(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return data;
}

test("select a colour everywhere, not only where it touches", () => {
  const data = picture(20, 10, (x) => (x < 5 || x >= 15 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const { mask, box } = S.colourSelect(data, 20, 10, 1, 1, 0.1);
  assert.equal(box.count, 100, "both red bands, though they do not touch");
  assert.equal(mask[0], 255);
  assert.equal(mask[10], 0);
  assert.deepEqual(S.maskBox(mask, 20, 10), { x: 0, y: 0, w: 20, h: 10 });
  assert.equal(S.colourSelect(data, 20, 10, -1, 0).box.count, 0, "a click off the picture selects nothing");
});

test("the edge of a colour selection is soft, not a staircase", () => {
  const data = picture(30, 1, (x) => [x * 8, 0, 0, 255]);
  const { mask } = S.colourSelect(data, 30, 1, 0, 0, 0.4);
  assert.equal(mask[0], 255);
  const partial = [...mask].filter((v) => v > 0 && v < 255);
  assert.ok(partial.length >= 2, "some pixels are only partly selected");
  assert.equal(mask[29], 0);
});

test("outlines: a square, a hole wound the other way, and diagonal neighbours kept apart", () => {
  const sq = new Uint8Array(36);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 5; x++) sq[y * 6 + x] = 255;
  assert.deepEqual(S.traceContours(sq, 6, 6), [[[1, 1], [5, 1], [5, 4], [1, 4]]]);

  const ring = new Uint8Array(25).fill(255);
  ring[12] = 0;
  const loops = S.traceContours(ring, 5, 5);
  assert.equal(loops.length, 2);
  const area = (p) => p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0) / 2;
  assert.ok(area(loops[0]) * area(loops[1]) < 0, "the hole runs the opposite way, so one fill rule draws both");

  const diag = new Uint8Array(16);
  diag[0] = 255;
  diag[5] = 255;
  assert.equal(S.traceContours(diag, 4, 4).length, 2);
  assert.deepEqual(S.traceContours(new Uint8Array(16), 4, 4), []);
});

test("a noisy mask cannot make tracing run away", () => {
  const w = 200, h = 200;
  const noise = new Uint8Array(w * h);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 7 < 3 ? 255 : 0;
  const t0 = Date.now();
  const loops = S.traceContours(noise, w, h, 128, 5000);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(Array.isArray(loops));
});

test("the colours round the rim are what the background is taken to be", () => {
  const data = picture(40, 40, (x, y) => (x > 10 && x < 30 && y > 10 && y < 30 ? [200, 30, 30, 255] : [250, 250, 250, 255]));
  const cols = S.dominantColours(S.borderSamples(data, 40, 40), 3);
  assert.ok(cols[0].share > 0.9);
  assert.ok(cols[0].rgb.every((v) => v >= 249));
});

test("cutting out: the rim's colour goes, the subject stays, and the mask says how much", () => {
  const data = picture(60, 60, (x, y) => {
    if (x >= 28 && x < 32 && y >= 28 && y < 32) return [250, 250, 250, 255]; // a gap inside the subject
    if (x >= 15 && x < 45 && y >= 15 && y < 45) return [200, 30, 30, 255];
    return [250, 250, 250, 255];
  });
  const open = S.removeBackground(data, 60, 60, { tolerance: 0.1, holes: true });
  const at = (m, x, y) => m[y * 60 + x];
  assert.equal(at(open.mask, 2, 2), 0, "the wall is gone");
  assert.equal(at(open.mask, 20, 20), 255, "the subject is kept");
  assert.equal(at(open.mask, 30, 30), 0, "with `holes`, the gap inside it goes too");
  const shut = S.removeBackground(data, 60, 60, { tolerance: 0.1, holes: false });
  assert.equal(at(shut.mask, 30, 30), 255, "without it, only what reaches in from the edge is taken");
  assert.ok(open.removed > shut.removed);
  assert.equal(open.colours.length >= 1, true);
});

test("a subject the colour of the wall survives if an edge separates them", () => {
  // a white shape with a dark outline, on a white wall
  const data = picture(40, 40, (x, y) => {
    const inside = x >= 10 && x < 30 && y >= 10 && y < 30;
    const border = inside && (x === 10 || x === 29 || y === 10 || y === 29);
    return border ? [20, 20, 20, 255] : [255, 255, 255, 255];
  });
  const { mask } = S.removeBackground(data, 40, 40, { tolerance: 0.08, holes: false });
  assert.equal(mask[20 * 40 + 20], 255, "the flood cannot get past the outline");
  assert.equal(mask[0], 0);
});

test("a picture with nothing round its rim is left whole", () => {
  const clear = picture(10, 10, () => [0, 0, 0, 0]);
  const { mask, colours } = S.removeBackground(clear, 10, 10);
  assert.deepEqual(colours, []);
  assert.ok(mask.every((v) => v === 255));
});

test("decontamination takes the wall's colour back out of a half-covered edge", () => {
  // half subject (200, 0, 0), half wall (0, 255, 0): what the camera saw
  const data = new Uint8ClampedArray([100, 128, 0, 255]);
  S.decontaminate(data, new Uint8Array([128]), [[0, 255, 0]]);
  assert.ok(data[0] > 190 && data[1] < 12, `got ${[...data]}`);
  const solid = new Uint8ClampedArray([9, 9, 9, 255]);
  S.decontaminate(solid, new Uint8Array([255]), [[0, 255, 0]]);
  assert.deepEqual([...solid], [9, 9, 9, 255], "a fully covered pixel is nobody's edge");
});

test("on a mask, a colour means its lightness", () => {
  assert.equal(S.hexLuma("#000000"), 0);
  assert.equal(S.hexLuma("#ffffff"), 1);
  assert.equal(S.hexLuma("#fff"), 1);
  assert.ok(S.hexLuma("#ff0000") < S.hexLuma("#00ff00"), "green is lighter than red to the eye");
});

/* ── history ─────────────────────────────────────────────────────────────── */

test("a grouped step undoes last-first and redoes first-last", () => {
  const log = [];
  const mk = (name) => ({ label: name, bytes: 10, run() { log.push(name); } });
  const h = new History();
  h.push(groupStep("Add mask", [mk("pixels"), mk("layers")]));
  h.undo();
  assert.deepEqual(log, ["layers", "pixels"]);
  h.redo();
  assert.deepEqual(log, ["layers", "pixels", "pixels", "layers"]);
  assert.equal(h.stats().bytes, 20);
});

test("a step that holds canvases lets go of them when it is forgotten", () => {
  let freed = 0;
  const big = (label) => ({ label, bytes: 100, run() {}, dispose() { freed++; } });
  const h = new History({ budget: 250 });
  h.push(big("a"));
  h.push(big("b"));
  h.push(big("c")); // over budget: "a" is dropped
  assert.equal(freed, 1);
  h.undo();
  h.push(metaStep("rename", { a: 1 }, { a: 2 }, () => {})); // "c" can no longer be redone
  assert.equal(freed, 2);
  h.clear();
  assert.equal(freed, 3);
});
