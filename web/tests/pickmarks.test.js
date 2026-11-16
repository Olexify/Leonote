// Picking things up again after they were drawn.
//
// The photo editor keeps every mark as its own object, so a click has to find
// the right one; Draw keeps pixels, so a click has to find the *piece* - what
// is joined to where you clicked. Both are plain geometry, and both decide
// what Delete removes, so they are pinned down here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { hitShape, moveShape, pickShape, restyleShape, shapeBounds, shapesInRect } from "../imageeditmodel.js";
import { alphaIsland } from "../paintselect.js";

const pen = { t: "pen", c: "#f00", w: 10, alpha: 1, pts: [0, 0, 100, 0, 100, 100] };
const rect = { t: "rect", c: "#0f0", w: 4, alpha: 1, x: 200, y: 200, rw: 100, rh: 60 };
const ring = { t: "ellipse", c: "#00f", w: 4, alpha: 1, x: 400, y: 400, rw: 200, rh: 100 };
const label = { t: "text", c: "#fff", size: 40, alpha: 1, x: 10, y: 300, text: "Hello\nthere" };
const rub = { t: "erase", w: 30, alpha: 1, pts: [0, 0, 50, 50] };

test("bounds include the ink, and an eraser stroke has none", () => {
  assert.deepEqual(shapeBounds(pen), { x0: -5, y0: -5, x1: 105, y1: 105 });
  assert.deepEqual(shapeBounds(rect), { x0: 198, y0: 198, x1: 302, y1: 262 });
  assert.equal(shapeBounds(rub), null);
  const b = shapeBounds(label, () => 123);
  assert.equal(b.x1 - b.x0, 123);
  assert.ok(Math.abs(b.y1 - b.y0 - 2 * 40 * 1.22) < 1e-9, "two lines tall");
  // a rectangle dragged up and to the left has negative sizes; the box is still the right way round
  assert.deepEqual(shapeBounds({ ...rect, x: 300, y: 260, rw: -100, rh: -60 }), shapeBounds(rect));
});

test("a stroke is hit on its ink, not in the box around it", () => {
  assert.ok(hitShape(pen, 50, 3));
  assert.ok(hitShape(pen, 103, 60));
  assert.ok(!hitShape(pen, 40, 60), "the empty corner of an L is not the L");
  assert.ok(hitShape(pen, 50, 8, 4), "slack lets a thin line be caught");
  assert.ok(!hitShape(rub, 10, 10, 50), "an eraser stroke cannot be picked");
});

test("outlines are hit on the line; their inside only counts on the second pass", () => {
  assert.ok(hitShape(rect, 200, 230));
  assert.ok(!hitShape(rect, 250, 230));
  assert.ok(hitShape(rect, 250, 230, 0, { inside: true }));
  assert.ok(hitShape({ ...rect, fill: "#123" }, 250, 230), "a filled one is solid");
  assert.ok(hitShape(ring, 400, 450), "the left end of the ellipse");
  assert.ok(!hitShape(ring, 500, 450), "its centre is empty");
  assert.ok(!hitShape(ring, 402, 402), "the corner of its box is outside it");
});

test("a click takes the topmost mark, skips hidden layers, and falls back to insides", () => {
  const layers = [
    { id: "a", hidden: false, opacity: 1, shapes: [rect, { ...rect, fill: "#000" }] },
    { id: "b", hidden: false, opacity: 1, shapes: [pen] },
    { id: "c", hidden: true, opacity: 1, shapes: [{ ...rect, fill: "#fff" }] },
  ];
  assert.deepEqual(pickShape(layers, 250, 230), { layer: 0, index: 1 }, "the hidden layer on top is ignored; the later shape wins");
  assert.deepEqual(pickShape(layers, 50, 0), { layer: 1, index: 0 });
  assert.equal(pickShape(layers, 900, 900), null);
  const outline = [{ id: "a", hidden: false, opacity: 1, shapes: [rect] }];
  assert.deepEqual(pickShape(outline, 250, 230), { layer: 0, index: 0 }, "nothing on the ink, so the inside counts");
});

test("a rubber band takes what it touches", () => {
  const layers = [{ id: "a", hidden: false, opacity: 1, shapes: [pen, rect, rub, ring] }];
  assert.deepEqual(shapesInRect(layers, { x0: 320, y0: 280, x1: 150, y1: 150 }).map((r) => r.index), [1], "drawn backwards, still a rectangle");
  assert.deepEqual(shapesInRect(layers, { x0: -50, y0: -50, x1: 1000, y1: 1000 }).map((r) => r.index), [0, 1, 3], "never the eraser");
});

test("moving and restyling give new marks and leave the old ones alone", () => {
  const moved = moveShape(pen, 10, -5);
  assert.deepEqual(moved.pts, [10, -5, 110, -5, 110, 95]);
  assert.deepEqual(pen.pts, [0, 0, 100, 0, 100, 100]);
  assert.deepEqual(moveShape({ t: "line", x1: 0, y1: 0, x2: 5, y2: 5 }, 1, 2), { t: "line", x1: 1, y1: 2, x2: 6, y2: 7 });
  const group = { t: "group", alpha: 1, shapes: [pen, rub] };
  const g2 = moveShape(group, 1, 1);
  assert.deepEqual(g2.shapes[1].pts, [1, 1, 51, 51], "the eraser inside a merged group travels with it");
  assert.equal(restyleShape(pen, { c: "#abc" }).c, "#abc");
  assert.equal(restyleShape({ ...pen, t: "marker" }, { w: 10 }).w, 22, "a highlighter stays a highlighter's width");
  assert.equal(restyleShape(label, { w: 9 }).w, undefined);
});

/* ── Draw: the piece under a click ── */

function bitmap(w, h, blobs) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const [x0, y0, x1, y1, a = 255] of blobs) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d[(y * w + x) * 4 + 3] = a;
  return d;
}

test("a click picks the doodle it lands on and leaves the other alone", () => {
  const w = 120, h = 80;
  const d = bitmap(w, h, [[5, 5, 30, 20], [70, 40, 110, 70]]);
  const a = alphaIsland(d, w, h, 10, 10, { cell: 2 });
  assert.deepEqual([a.box.x0, a.box.y0, a.box.x1, a.box.y1], [5, 5, 30, 20]);
  assert.equal(a.box.count, 26 * 16);
  assert.equal(a.mask[50 * w + 90], 0, "the other doodle is not part of it");
  const b = alphaIsland(d, w, h, 90, 50, { cell: 2 });
  assert.equal(b.box.count, 41 * 31);
});

test("a click on nothing picks nothing", () => {
  const d = bitmap(60, 60, [[5, 5, 10, 10]]);
  const r = alphaIsland(d, 60, 60, 40, 40, { cell: 2 });
  assert.ok(r.box.x1 < r.box.x0);
  assert.ok(alphaIsland(d, 60, 60, -3, 5).box.x1 < 0);
});

test("grain and small gaps do not break a stroke apart, a real gap does", () => {
  // a dotted pencil line: 2 px dabs, 2 px holes
  const dabs = [];
  for (let x = 4; x < 60; x += 4) dabs.push([x, 10, x + 1, 11]);
  const d = bitmap(100, 40, [...dabs, [80, 10, 90, 12]]);
  const r = alphaIsland(d, 100, 40, 5, 10, { cell: 4 });
  assert.equal(r.box.x0, 4);
  assert.equal(r.box.x1, 57, "every dab of the dotted line came along");
  assert.equal(r.mask[10 * 100 + 85], 0, "the mark twenty pixels away did not");
  // a click that lands in one of the holes still finds the line
  assert.ok(alphaIsland(d, 100, 40, 7, 10, { cell: 4 }).box.count > 0);
});

test("faint haze below the threshold is not paint", () => {
  const d = bitmap(40, 40, [[0, 0, 39, 39, 4], [10, 10, 15, 15, 255]]);
  const r = alphaIsland(d, 40, 40, 12, 12, { cell: 2 });
  assert.ok(r.box.x1 - r.box.x0 < 12, "the haze did not join everything up");
});
