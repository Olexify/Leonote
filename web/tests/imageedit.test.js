// Non-destructive picture edits: where the sidecar lives, what it holds,
// the layer arithmetic, the filter strings, and the text change that puts one
// picture into another note.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADJUST, DEFAULT_ADJUST, PRESETS, adjustFromPreset, bakeLayer, countShapes, docChangesPicture,
  editedName, embedFor, emptyDoc, filterString, flattenLayers, insertEmbed, isEmptyDoc,
  isNeutralAdjust, mergeDown, moveLayer, newLayer, nextLayerName, normalizeAdjust, normalizeDoc,
  serializeDoc, sharpenKernel, sidecarPath,
} from "../imageeditmodel.js";

/* ── where the edits are kept ───────────────────────────────────────────── */

test("the sidecar hides beside the picture, never inside it", () => {
  assert.equal(sidecarPath("Ideas/moodboard.png"), "Ideas/.leonote/moodboard.png.leoedit.json");
  assert.equal(sidecarPath("photo.webp"), ".leonote/photo.webp.leoedit.json");
  assert.equal(sidecarPath("a/b/c/deep shot.jpg"), "a/b/c/.leonote/deep shot.jpg.leoedit.json");
  // backslashes and a leading slash are the same path
  assert.equal(sidecarPath("\\Ideas\\pic.png"), "Ideas/.leonote/pic.png.leoedit.json");
  assert.equal(sidecarPath(""), "");
  // the picture's own name is kept whole, extension and all: photo.png and
  // photo.webp in one folder keep separate edits
  assert.notEqual(sidecarPath("a/photo.png"), sidecarPath("a/photo.webp"));
});

/* ── the sidecar's shape, and the round trip ────────────────────────────── */

test("an empty document is neutral and counts as no edits at all", () => {
  const d = emptyDoc(800, 600);
  assert.equal(d.w, 800);
  assert.equal(d.h, 600);
  assert.deepEqual(d.adjust, DEFAULT_ADJUST);
  assert.equal(d.layers.length, 0);
  assert.ok(isEmptyDoc(d));
  assert.ok(!docChangesPicture(d));
});

test("a document round-trips through the sidecar text unchanged", () => {
  const doc = normalizeDoc(emptyDoc(1200, 800));
  doc.adjust.contrast = 18;
  doc.adjust.warmth = -30;
  doc.preset = "cool";
  doc.layers = [
    { ...newLayer("Arrows"), id: "L1", opacity: 0.7, shapes: [{ t: "line", c: "#ef6461", w: 6, x1: 10, y1: 20, x2: 300, y2: 210, arrow: true, alpha: 1 }] },
    { ...newLayer("Notes"), id: "L2", hidden: true, shapes: [{ t: "text", c: "#fff", x: 40, y: 50, size: 44, text: "look here", alpha: 1 }] },
  ];
  const text = serializeDoc(doc, { image: "shot.webp" });
  const back = normalizeDoc(text);
  assert.equal(back.w, 1200);
  assert.equal(back.h, 800);
  assert.equal(back.preset, "cool");
  assert.deepEqual(back.adjust, doc.adjust);
  assert.deepEqual(back.layers, doc.layers);
  // and again, so nothing drifts on the second save
  assert.equal(serializeDoc(back, { image: "shot.webp" }), text);
  assert.equal(JSON.parse(text).image, "shot.webp");
  assert.equal(JSON.parse(text).leoedit, 1);
});

test("a damaged sidecar degrades to no edits instead of blocking the picture", () => {
  for (const bad of ["not json", "", null, undefined, "[]", '{"layers":"nope"}', 42]) {
    const d = normalizeDoc(bad, { width: 10, height: 10 });
    assert.deepEqual(d.adjust, DEFAULT_ADJUST);
    assert.deepEqual(d.layers, []);
  }
  // junk shapes are dropped, good ones beside them survive
  const d = normalizeDoc({ layers: [{ name: "x", shapes: [{ t: "nope" }, { t: "pen", pts: [1, 2, 3, 4] }, { t: "pen", pts: [] }, null] }] });
  assert.equal(d.layers[0].shapes.length, 1);
  assert.equal(d.layers[0].shapes[0].t, "pen");
});

test("values out of range come back inside it", () => {
  const a = normalizeAdjust({ contrast: 9000, blur: -5, grayscale: "77", nonsense: 1 });
  assert.equal(a.contrast, 100);
  assert.equal(a.blur, 0);
  assert.equal(a.grayscale, 77);
  assert.equal(a.nonsense, undefined);
  assert.equal(Object.keys(a).length, ADJUST.length);
  // an odd trailing coordinate cannot make a stroke with half a point in it
  const d = normalizeDoc({ layers: [{ shapes: [{ t: "pen", pts: [1, 2, 3, 4, 5] }] }] });
  assert.deepEqual(d.layers[0].shapes[0].pts, [1, 2, 3, 4]);
});

test("a drawing or a moved slider counts as an edit; a hidden layer does not", () => {
  const drawn = normalizeDoc({ layers: [{ name: "a", shapes: [{ t: "pen", pts: [0, 0, 5, 5] }] }] });
  assert.ok(docChangesPicture(drawn));
  assert.ok(!isEmptyDoc(drawn));
  const hidden = normalizeDoc({ layers: [{ name: "a", hidden: true, shapes: [{ t: "pen", pts: [0, 0, 5, 5] }] }] });
  assert.ok(!docChangesPicture(hidden));
  const adjusted = normalizeDoc({ adjust: { contrast: 12 } });
  assert.ok(docChangesPicture(adjusted));
  // "adjustments off" is the one-click switch: the values stay, the picture doesn't change
  const off = normalizeDoc({ adjust: { contrast: 12 }, adjustOn: false });
  assert.ok(!docChangesPicture(off));
  assert.equal(off.adjust.contrast, 12);
});

/* ── layer ordering and merge maths ─────────────────────────────────────── */

const L = (name, opacity = 1, shapes = [], extra = {}) => ({ ...newLayer(name), opacity, shapes, ...extra });
const pen = (c = "#fff", alpha = 1) => ({ t: "pen", c, w: 4, pts: [0, 0, 10, 10], alpha });

test("moveLayer reorders without losing or duplicating a layer", () => {
  const ls = [L("a"), L("b"), L("c"), L("d")];
  assert.deepEqual(moveLayer(ls, 0, 2).map((l) => l.name), ["b", "c", "a", "d"]);
  assert.deepEqual(moveLayer(ls, 3, 0).map((l) => l.name), ["d", "a", "b", "c"]);
  // out of range is clamped, not an error
  assert.deepEqual(moveLayer(ls, 1, 99).map((l) => l.name), ["a", "c", "d", "b"]);
  assert.deepEqual(moveLayer(ls, 9, 0).map((l) => l.name), ["a", "b", "c", "d"]);
  assert.deepEqual(ls.map((l) => l.name), ["a", "b", "c", "d"], "the input list is left alone");
});

test("merging bakes each layer's opacity into its own marks", () => {
  const ls = [L("bottom", 0.5, [pen("#f00")]), L("top", 0.4, [pen("#0f0")])];
  const out = mergeDown(ls, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "bottom", "the lower layer keeps its name");
  assert.equal(out[0].opacity, 1);
  assert.deepEqual(out[0].shapes.map((s) => [s.c, s.alpha]), [["#f00", 0.5], ["#0f0", 0.4]]);
  // order is preserved: what was on top is still drawn last
  assert.equal(out[0].shapes[1].c, "#0f0");
});

test("merging a half-transparent mark multiplies, it does not replace", () => {
  const out = mergeDown([L("a", 1, [pen("#f00")]), L("b", 0.5, [pen("#0f0", 0.5)])], 1);
  assert.equal(out[0].shapes[1].alpha, 0.25);
});

test("a hidden layer contributes nothing but is still consumed by the merge", () => {
  const out = mergeDown([L("a", 1, [pen("#f00")]), L("b", 1, [pen("#0f0")], { hidden: true })], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].shapes.length, 1);
  assert.equal(out[0].shapes[0].c, "#f00");
});

test("a layer that erases is wrapped, so its eraser never cuts the layer below", () => {
  const erasing = L("top", 0.8, [pen("#0f0"), { t: "erase", w: 20, pts: [0, 0, 5, 5], alpha: 1 }]);
  const out = mergeDown([L("bottom", 1, [pen("#f00")]), erasing], 1);
  assert.equal(out[0].shapes.length, 2);
  assert.equal(out[0].shapes[0].c, "#f00", "the lower layer's mark stays a plain mark");
  const grp = out[0].shapes[1];
  assert.equal(grp.t, "group");
  assert.equal(grp.alpha, 0.8, "the layer's opacity moved onto the group");
  assert.equal(grp.shapes.length, 2);
  assert.equal(grp.shapes[1].t, "erase");
  assert.equal(countShapes(out[0].shapes), 3, "the marks are still all there");
});

test("merging the bottom layer, or an index nobody has, changes nothing", () => {
  const ls = [L("a"), L("b")];
  assert.equal(mergeDown(ls, 0).length, 2);
  assert.equal(mergeDown(ls, 5).length, 2);
  assert.equal(mergeDown(ls, -1).length, 2);
});

test("flatten keeps every visible layer in order and drops the hidden ones", () => {
  const ls = [L("a", 1, [pen("#100")]), L("b", 0.5, [pen("#200")], { hidden: true }), L("c", 0.25, [pen("#300")])];
  const out = flattenLayers(ls, "Drawing");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Drawing");
  assert.deepEqual(out[0].shapes.map((s) => [s.c, s.alpha]), [["#100", 1], ["#300", 0.25]]);
  // flattening twice is the same as flattening once
  assert.deepEqual(flattenLayers(out, "Drawing")[0].shapes, out[0].shapes);
});

test("bakeLayer leaves the layer it was given alone", () => {
  const l = L("a", 0.5, [pen("#f00")]);
  bakeLayer(l);
  assert.equal(l.shapes[0].alpha, 1);
  assert.equal(l.opacity, 0.5);
});

test("a new layer gets a name nobody is using", () => {
  assert.equal(nextLayerName([]), "Layer 1");
  assert.equal(nextLayerName([L("Layer 1")]), "Layer 2");
  assert.equal(nextLayerName([L("Layer 1"), L("Layer 2")]), "Layer 3");
  assert.equal(nextLayerName([L("Arrows"), L("Layer 3")]), "Layer 4");
});

/* ── filters ────────────────────────────────────────────────────────────── */

test("a neutral set of adjustments builds no filter at all", () => {
  assert.equal(filterString(DEFAULT_ADJUST), "");
  assert.equal(filterString({}), "");
  assert.equal(filterString(undefined), "");
  assert.ok(isNeutralAdjust({}));
  assert.ok(!isNeutralAdjust({ contrast: 1 }));
});

test("each slider contributes exactly one kind of CSS filter", () => {
  assert.equal(filterString({ brightness: 50 }), "brightness(1.5)");
  assert.equal(filterString({ contrast: 50 }), "contrast(1.5)");
  assert.equal(filterString({ saturation: 50 }), "saturate(1.5)");
  assert.equal(filterString({ grayscale: 100 }), "grayscale(1)");
  assert.equal(filterString({ invert: 50 }), "invert(0.5)");
  assert.equal(filterString({ blur: 3.5 }), "blur(3.5px)");
  // exposure doubles the light at the top of its travel
  assert.equal(filterString({ exposure: 100 }), "brightness(2)");
  assert.equal(filterString({ brightness: -100 }), "brightness(0)");
  // sharpen and vignette are drawn, not filtered
  assert.equal(filterString({ sharpen: 80, vignette: 90 }), "");
});

test("warmth goes sepia one way and cool the other", () => {
  const warm = filterString({ warmth: 100 });
  assert.match(warm, /^sepia\(0\.55\) saturate\(1\.4\)$/);
  const cool = filterString({ warmth: -100 });
  assert.match(cool, /^hue-rotate\(-20deg\) saturate\(1\.22\)$/);
  assert.equal(filterString({ warmth: 0 }), "");
});

test("the filter list is in a fixed order, with blur last", () => {
  const s = filterString({ exposure: 20, brightness: 10, contrast: 10, saturation: 10, warmth: 20, grayscale: 10, invert: 10, blur: 2 });
  const names = s.split(" ").map((f) => f.slice(0, f.indexOf("(")));
  assert.deepEqual(names, ["brightness", "brightness", "contrast", "saturate", "sepia", "saturate", "grayscale", "invert", "blur"]);
});

test("a preset is a complete set of values, so switching never leaves a leftover", () => {
  for (const p of PRESETS) {
    const a = adjustFromPreset(p.id);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(DEFAULT_ADJUST).sort(), p.id);
  }
  assert.deepEqual(adjustFromPreset("none"), DEFAULT_ADJUST);
  assert.deepEqual(adjustFromPreset("nothing like this"), DEFAULT_ADJUST);
  assert.equal(adjustFromPreset("noir").grayscale, 100);
  assert.notEqual(filterString(adjustFromPreset("vivid")), "");
});

test("the sharpen kernel always sums to 1, so flat areas keep their brightness", () => {
  for (const a of [0, 1, 25, 60, 100, -5, 500]) {
    const k = sharpenKernel(a);
    assert.equal(k.length, 9);
    assert.ok(Math.abs(k.reduce((s, x) => s + x, 0) - 1) < 1e-9, `sum at ${a}`);
  }
  assert.deepEqual(sharpenKernel(0), [0, -0, 0, -0, 1, -0, 0, -0, 0]);
  assert.equal(sharpenKernel(100)[4], 5);
  assert.equal(sharpenKernel(100)[1], -1);
});

/* ── one picture, several notes ─────────────────────────────────────────── */

test("the embed is the picture's bare name, whatever folder it sits in", () => {
  assert.equal(embedFor("Utilities/Cache/moodboard.webp"), "![[moodboard.webp]]");
  assert.equal(embedFor("pic.png"), "![[pic.png]]");
  assert.equal(embedFor("a\\b\\c.jpg"), "![[c.jpg]]");
});

test("inserting an embed leaves one blank line and ends the file with a newline", () => {
  assert.deepEqual(insertEmbed("# Title\n\nSome words.\n", "![[a.png]]"), { text: "# Title\n\nSome words.\n\n![[a.png]]\n", added: true });
  assert.deepEqual(insertEmbed("", "![[a.png]]"), { text: "![[a.png]]\n", added: true });
  assert.deepEqual(insertEmbed("   \n\n ", "![[a.png]]"), { text: "![[a.png]]\n", added: true });
  // trailing blank lines are tidied rather than piled on
  assert.equal(insertEmbed("words\n\n\n\n", "![[a.png]]").text, "words\n\n![[a.png]]\n");
});

test("a note that already shows the picture is handed back untouched", () => {
  const src = "Look: ![[a.png]] and more\n";
  assert.deepEqual(insertEmbed(src, "![[a.png]]"), { text: src, added: false });
  // a different picture still goes in
  assert.equal(insertEmbed(src, "![[b.png]]").added, true);
  assert.deepEqual(insertEmbed(src, ""), { text: src, added: false });
});

test("the flattened copy never takes a name that is already taken", () => {
  assert.equal(editedName("Ideas/photo.webp"), "Ideas/photo (edited).webp");
  assert.equal(editedName("photo.png"), "photo (edited).png");
  const used = new Set(["Ideas/photo (edited).webp", "Ideas/photo (edited 2).webp"]);
  assert.equal(editedName("Ideas/photo.webp", (p) => used.has(p)), "Ideas/photo (edited 3).webp");
  // a format that cannot hold the result is asked to become WebP
  assert.equal(editedName("Ideas/anim.gif", () => false, "webp"), "Ideas/anim (edited).webp");
  assert.equal(editedName("no-extension", () => false), "no-extension (edited).webp");
});

import { normalizeDoc as nd2, shapeBounds as sb2, moveShape as ms2 } from "../imageeditmodel.js";
test("pieces of the picture and labels with a look survive the sidecar", () => {
  const d = nd2({ layers: [{ shapes: [
    { t: "snip", sx: 10, sy: 20, sw: 30, sh: 40, x: 100, y: 5, hole: true, fill: "#123456", z: 2 },
    { t: "text", x: 1, y: 1, size: 20, text: "Hi", bg: "rgba(0,0,0,.7)", rim: false, font: "mono" },
    { t: "text", x: 1, y: 1, size: 20, text: "Plain", font: "sans" },
  ] }] }, { width: 200, height: 200 });
  const [snip, label, plain] = d.layers[0].shapes;
  assert.deepEqual([snip.sx, snip.sy, snip.sw, snip.sh, snip.x, snip.y, snip.z, snip.hole, snip.fill], [10, 20, 30, 40, 100, 5, 2, true, "#123456"]);
  assert.deepEqual(sb2(snip), { x0: 100, y0: 5, x1: 160, y1: 85 });
  assert.deepEqual([ms2(snip, 5, 5).x, ms2(snip, 5, 5).sx], [105, 10]); // the piece moves; where it came from stays
  assert.deepEqual([label.bg, label.rim, label.font], ["rgba(0,0,0,.7)", false, "mono"]);
  assert.equal(plain.font, undefined);
});
