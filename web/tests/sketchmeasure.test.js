// Measuring in Sketch: units, drawing scales, what people type into a length
// box, ruler ticks, and the geometry the Measure tool and dimensions report.
//
// These are the numbers somebody is going to cut timber to. They are all
// pure, so every one of them is pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as MS from "../sketchmeasure.js";
import * as M from "../sketchmodel.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const cfgOf = (patch) => MS.measureOf({ leoMeasure: patch });

/* ── units and scale ─────────────────────────────────────────────────────── */

test("a drawing with no settings measures in pixels, one to one", () => {
  const c = MS.measureOf({});
  assert.deepEqual([c.unit, c.pxPerUnit, c.on, c.guides.length], ["px", 1, false, 0]);
  assert.equal(MS.formatLength(120.4, c), "120 px");
});

test("a CSS pixel is a ninety-sixth of an inch, so a millimetre is 3.78 of them", () => {
  assert.ok(near(MS.pxPerUnitFor("mm"), 96 / 25.4));
  assert.ok(near(MS.pxPerUnitFor("in"), 96));
  assert.ok(near(MS.pxPerUnitFor("cm"), 96 / 2.54));
});

test("at 1:50 a metre on the ground is two centimetres on the board", () => {
  const c = cfgOf({ unit: "m", scale: [1, 50] });
  assert.ok(near(c.pxPerUnit, (96 / 2.54) * 2));
  assert.equal(MS.formatLength(c.pxPerUnit * 4, c), "4.00 m");
  assert.ok(near(MS.fromUnits(MS.toUnits(333, c), c), 333));
});

test("an enlargement works the other way: 5:1 makes a millimetre five times bigger", () => {
  assert.ok(near(cfgOf({ unit: "mm", scale: [5, 1] }).pxPerUnit, (96 / 25.4) * 5));
});

test("settings written by hand, or by a newer version, are put right rather than trusted", () => {
  const c = cfgOf({ unit: "furlongs", scale: [0, -3], precision: 99, guides: [{ axis: "x", at: 10 }, { axis: "z", at: 1 }, { axis: "y", at: "no" }, null] });
  assert.equal(c.unit, "px");
  assert.deepEqual(c.scale, [1, 1]);
  assert.equal(c.precision, 4);
  assert.deepEqual(c.guides, [{ axis: "x", at: 10 }]);
});

test("calibrating from a known length overrides the scale, and changing the unit drops it", () => {
  const app = {};
  MS.setMeasure(app, { unit: "m", scale: [1, 100] });
  const c = MS.calibrate(app, 500, 2.5); // a 500 px line really is 2.5 m
  assert.ok(c.calibrated);
  assert.equal(c.pxPerUnit, 200);
  assert.equal(MS.formatLength(500, c), "2.50 m");
  const kept = MS.setMeasure(app, { on: true });
  assert.ok(kept.calibrated && kept.pxPerUnit === 200, "other settings leave a calibration alone");
  const next = MS.setMeasure(app, { unit: "cm" });
  assert.equal(next.calibrated, false, "a calibration described metres; it says nothing about centimetres");
  assert.ok(near(next.pxPerUnit, MS.pxPerUnitFor("cm", [1, 100])));
  assert.deepEqual(MS.calibrate(app, 0, 5).calibrated, false, "and nonsense is ignored");
});

test("the settings that go into the file are plain and complete", () => {
  const app = { other: 1 };
  MS.setMeasure(app, { unit: "mm", scale: [1, 20], guides: [{ axis: "y", at: 12.34567 }], on: true });
  assert.deepEqual(app.leoMeasure, { on: true, unit: "mm", scale: [1, 20], pxPerUnit: MS.pxPerUnitFor("mm", [1, 20]), calibrated: false, precision: 1, guides: [{ axis: "y", at: 12.346 }] });
  assert.equal(app.other, 1);
});

test("each unit starts with a sensible number of decimals", () => {
  assert.equal(cfgOf({ unit: "mm" }).precision, 1);
  assert.equal(cfgOf({ unit: "m" }).precision, 2);
  assert.equal(cfgOf({ unit: "px" }).precision, 0);
  const app = {};
  MS.setMeasure(app, { unit: "mm", precision: 3 });
  assert.equal(MS.setMeasure(app, { unit: "m" }).precision, 2, "switching unit resets them");
});

/* ── formatting ──────────────────────────────────────────────────────────── */

test("lengths round to the drawing's decimals, and never print a minus zero", () => {
  const c = cfgOf({ unit: "mm", precision: 1 });
  assert.equal(MS.formatLength(MS.fromUnits(12.34, c), c), "12.3 mm");
  assert.equal(MS.formatLength(MS.fromUnits(12.35, c), c, { unit: false }), "12.4");
  assert.equal(MS.formatLength(-0.0001, c), "0.0 mm");
});

test("feet and inches, to the nearest sixteenth, the way a tape reads", () => {
  assert.equal(MS.feetInches(7 + 10.5 / 12), "7' 10 1/2\"");
  assert.equal(MS.feetInches(5), "5'");
  assert.equal(MS.feetInches(0.5), "6\"");
  assert.equal(MS.feetInches(1 / 12 / 16), "1/16\"");
  assert.equal(MS.feetInches(3 + 0.25 / 12), "3' 1/4\"");
  assert.equal(MS.feetInches(0), "0\"");
  assert.equal(MS.feetInches(1.9999), "2'", "just under two feet rounds to two feet, not to 1' 12\"");
  assert.equal(MS.feetInches(-2.25), "-2' 3\"");
});

test("an area carries a digit more than a length, and its unit squared", () => {
  const c = cfgOf({ unit: "m", scale: [1, 50] });
  assert.equal(MS.formatArea(c.pxPerUnit * 4 * c.pxPerUnit * 3, c), "12.000 m²");
  assert.equal(MS.formatArea(2500, cfgOf({})), "2500 px²");
});

test("angles drop the zeros nobody needs", () => {
  assert.equal(MS.formatAngle(Math.PI / 2), "90°");
  assert.equal(MS.formatAngle(Math.PI / 7), "25.7°");
  assert.equal(MS.formatAngle(0.5, 2), "28.65°");
});

/* ── what people type ────────────────────────────────────────────────────── */

test("a bare number is in the drawing's unit", () => {
  const c = cfgOf({ unit: "m", scale: [1, 50] });
  assert.ok(near(MS.parseLength("4", c), c.pxPerUnit * 4));
  assert.ok(near(MS.parseLength(" 2,5 ", c), c.pxPerUnit * 2.5), "a decimal comma is a decimal point");
  assert.ok(near(MS.parseLength("-1.5", c), c.pxPerUnit * -1.5));
});

test("any unit can be typed into any drawing", () => {
  const c = cfgOf({ unit: "m", scale: [1, 50] });
  assert.ok(near(MS.parseLength("240 cm", c), c.pxPerUnit * 2.4));
  assert.ok(near(MS.parseLength("2400mm", c), c.pxPerUnit * 2.4));
  assert.ok(near(MS.parseLength("0.003 km", c), c.pxPerUnit * 3));
  assert.ok(near(MS.parseLength("12 px", c), 12), "pixels are pixels whatever the scale");
  assert.ok(near(MS.parseLength("10 ft", c), c.pxPerUnit * 3.048));
});

test("feet and inches in the forms people actually write", () => {
  const c = cfgOf({ unit: "ft-in" });
  const ft = (v) => c.pxPerUnit * v;
  assert.ok(near(MS.parseLength("7' 10 1/2\"", c), ft(7 + 10.5 / 12)));
  assert.ok(near(MS.parseLength("7ft 10.5in", c), ft(7 + 10.5 / 12)));
  assert.ok(near(MS.parseLength("10 1/2\"", c), ft(10.5 / 12)));
  assert.ok(near(MS.parseLength("3/4 in", c), ft(0.75 / 12)));
  assert.ok(near(MS.parseLength("5'", c), ft(5)));
  assert.ok(near(MS.parseLength("5’ 3”", c), ft(5.25)), "curly quotes from a phone keyboard");
  assert.ok(near(MS.parseLength("6", c), ft(6)), "a bare number is feet");
  assert.ok(near(MS.parseLength("-2' 3\"", c), ft(-2.25)), "the inches go the same way as the feet");
});

test("what it writes, it reads back", () => {
  for (const unit of ["mm", "cm", "m", "in", "ft", "ft-in"]) {
    const c = cfgOf({ unit, scale: [1, 20], precision: 3 });
    const px = c.pxPerUnit * (unit === "ft-in" ? 7 + 10.5 / 12 : 12.375);
    assert.ok(near(MS.parseLength(MS.formatLength(px, c), c), px, 1e-6), unit);
  }
});

test("things that are not lengths are refused, not guessed at", () => {
  const c = cfgOf({ unit: "mm" });
  for (const bad of ["", "abc", "12 parsecs", "1/0x", "5 m 3", "'", "--4"]) assert.equal(MS.parseLength(bad, c), null, JSON.stringify(bad));
  assert.equal(MS.parseLength(null, c), null);
});

test("in a pixel drawing a typed millimetre is its size on screen", () => {
  assert.ok(near(MS.parseLength("25.4 mm", cfgOf({})), 96));
});

/* ── rulers ──────────────────────────────────────────────────────────────── */

test("labelled ticks land on 1, 2 or 5 times a power of ten, far enough apart to read", () => {
  const c = cfgOf({ unit: "mm" });
  for (const zoom of [0.05, 0.2, 0.5, 1, 2.3, 7, 30]) {
    const step = MS.niceStep(c, zoom);
    const lead = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    assert.ok([1, 2, 5, 10].some((m) => near(lead, m, 1e-9)), `zoom ${zoom}: step ${step}`);
    assert.ok(step * c.pxPerUnit * zoom >= 64 - 1e-6, "no closer than the minimum");
    assert.ok(step * c.pxPerUnit * zoom < 64 * 5.0001, "and no sparser than it has to be");
  }
});

test("a feet-and-inches ruler steps like a tape: sixteenths, inches, feet", () => {
  const c = cfgOf({ unit: "ft-in" });
  assert.equal(MS.niceStep(c, 20, 64), 1 / 192, "zoomed right in, a sixteenth of an inch is 120 px wide");
  assert.equal(MS.niceStep(c, 1, 64), 1 / 12, "at actual size an inch is 96 px: label the inches");
  assert.equal(MS.niceStep(c, 0.05, 64), 2, "zoomed out, every other foot");
  assert.equal(MS.subdivisions(1, c), 12, "a foot is cut into inches");
  assert.equal(MS.subdivisions(1 / 12, c), 4, "an inch into quarters");
});

test("ticks cover the span, the labelled ones fall on whole steps, zero is zero", () => {
  const c = cfgOf({ unit: "cm" });
  const ticks = MS.rulerTicks(c, -120, 400, 1);
  assert.ok(ticks[0].at <= -120 && ticks[ticks.length - 1].at >= 400 - c.pxPerUnit);
  const majors = ticks.filter((t) => t.major);
  assert.ok(majors.some((t) => t.label === "0" && near(t.at, 0)));
  assert.ok(majors.every((t) => t.label !== null) && ticks.filter((t) => !t.major).every((t) => t.label === null));
  const step = MS.niceStep(c, 1);
  for (const t of majors) assert.ok(near(MS.toUnits(t.at, c) / step, Math.round(MS.toUnits(t.at, c) / step), 1e-6));
  assert.ok(!majors.some((t) => t.label === "-0"));
});

test("a ruler never makes an unbounded number of ticks", () => {
  assert.ok(MS.rulerTicks(cfgOf({ unit: "mm" }), -1e7, 1e7, 1).length <= 4000);
});

/* ── geometry ────────────────────────────────────────────────────────────── */

test("a distance: length, run, rise, and the angle a drawing board would give", () => {
  const s = MS.segment([0, 0], [300, -400]); // up and to the right on screen
  assert.equal(s.length, 500);
  assert.equal(s.dx, 300);
  assert.equal(s.dy, 400, "up is positive, though y runs down the screen");
  assert.ok(near(s.angle, Math.atan2(400, 300)));
  assert.ok(near(MS.segment([0, 0], [10, 10]).angle, (Math.PI * 7) / 4), "down-right is 315 degrees, never negative");
});

test("a closed path has an area; an open one only a length", () => {
  const room = [[0, 0], [400, 0], [400, 300], [0, 300]];
  assert.deepEqual(MS.pathMetrics(room, true), { length: 1400, area: 120000, closed: true });
  assert.deepEqual(MS.pathMetrics(room, false), { length: 1100, area: 0, closed: false });
  // an L-shaped room, wound the other way: area is still positive
  const ell = [[0, 0], [0, 300], [200, 300], [200, 150], [400, 150], [400, 0]];
  assert.equal(MS.pathMetrics(ell, true).area, 400 * 150 + 200 * 150);
  assert.equal(MS.pathMetrics([[0, 0], [5, 5]], true).closed, false, "two points enclose nothing");
});

test("the angle at a corner, whichever way round it is clicked", () => {
  assert.ok(near(MS.angleAt([10, 0], [0, 0], [0, 10]), Math.PI / 2));
  assert.ok(near(MS.angleAt([0, 10], [0, 0], [10, 0]), Math.PI / 2));
  assert.ok(near(MS.angleAt([10, 0], [0, 0], [-10, 0]), Math.PI));
  assert.ok(near(MS.angleAt([10, 0], [0, 0], [10, 10]), Math.PI / 4));
  assert.equal(MS.angleAt([0, 0], [0, 0], [5, 5]), 0, "a side of no length has no angle");
});

test("area and perimeter of each shape", () => {
  assert.deepEqual(MS.elementMetrics({ type: "rectangle", width: 40, height: 30 }), { area: 1200, perimeter: 140 });
  assert.deepEqual(MS.elementMetrics({ type: "diamond", width: 60, height: 80 }), { area: 2400, perimeter: 200 });
  const circle = MS.elementMetrics({ type: "ellipse", width: 100, height: 100 });
  assert.ok(near(circle.area, Math.PI * 2500, 1e-6) && near(circle.perimeter, Math.PI * 100, 1e-6));
  const oval = MS.elementMetrics({ type: "ellipse", width: 200, height: 100 });
  assert.ok(near(oval.perimeter, 484.4224, 1e-3), "Ramanujan is good to the fourth decimal here");
  const closed = MS.elementMetrics({ type: "line", points: [[0, 0], [30, 0], [30, 40], [0, 0]] });
  assert.deepEqual(closed, { area: 600, perimeter: 120 });
  assert.equal(MS.elementMetrics({ type: "line", points: [[0, 0], [30, 40]] }).length, 50);
  assert.equal(MS.elementMetrics({ type: "text" }), null);
  assert.equal(MS.ellipsePerimeter(10, 0), 40, "a squashed-flat ellipse is its long axis, there and back");
});

test("the points a measurement can land on: corners, middles, the centre", () => {
  const kp = MS.keyPoints({ type: "rectangle", x: 100, y: 50, width: 200, height: 100 });
  const at = (kind) => kp.filter((p) => p.kind === kind).map((p) => [p.x, p.y]);
  assert.deepEqual(at("corner"), [[100, 50], [300, 50], [300, 150], [100, 150]]);
  assert.deepEqual(at("centre"), [[200, 100]]);
  assert.equal(at("midpoint").length, 4);
  assert.deepEqual(MS.keyPoints({ type: "ellipse", x: 0, y: 0, width: 10, height: 10 }).map((p) => p.kind), ["quadrant", "quadrant", "quadrant", "quadrant", "centre"]);
  assert.deepEqual(MS.keyPoints({ type: "text", x: 0, y: 0, width: 50, height: 20 }), []);
  assert.deepEqual(MS.keyPoints({ type: "rectangle", isDeleted: true, x: 0, y: 0, width: 5, height: 5 }), []);
});

test("a turned shape's corners turn with it", () => {
  const kp = MS.keyPoints({ type: "rectangle", x: -50, y: -50, width: 100, height: 100, angle: Math.PI / 4 });
  const c = kp.filter((p) => p.kind === "corner");
  assert.ok(near(c[0].x, 0, 1e-9) && near(c[0].y, -Math.SQRT2 * 50, 1e-9));
  for (const p of c) assert.ok(near(Math.hypot(p.x, p.y), Math.SQRT2 * 50, 1e-9));
});

test("a line offers its ends, its corners and the middle of each run — where the model says they are", () => {
  const el = M.newElement("line", { x: 10, y: 20, points: [[0, 0], [100, 0], [100, 60]] });
  const kp = MS.keyPoints(el);
  assert.deepEqual(kp.filter((p) => p.kind === "end").map((p) => [p.x, p.y]), [[10, 20], [110, 80]]);
  assert.deepEqual(kp.filter((p) => p.kind === "vertex").map((p) => [p.x, p.y]), [[110, 20]]);
  assert.deepEqual(kp.filter((p) => p.kind === "midpoint").map((p) => [p.x, p.y]), [[60, 20], [110, 50]]);
  // agrees with the model's own idea of where a line's points are
  assert.deepEqual(M.absolutePoints(el), [[10, 20], [110, 20], [110, 80]]);
});

test("snapping takes the nearest point, and a corner over a midpoint when they tie", () => {
  const c = [{ x: 0, y: 0, kind: "midpoint" }, { x: 10, y: 0, kind: "corner" }, { x: 100, y: 100, kind: "corner" }];
  assert.equal(MS.snapPoint(6, 0, c, 8).kind, "corner");
  assert.equal(MS.snapPoint(5, 0, c, 8).kind, "corner", "a tie goes to the corner");
  assert.equal(MS.snapPoint(2, 0, c, 8).kind, "midpoint");
  assert.equal(MS.snapPoint(50, 50, c, 8), null);
});

test("a dimension says the length of the line it runs along", () => {
  const c = cfgOf({ unit: "m", scale: [1, 50] });
  assert.equal(MS.dimensionText([[0, 0], [c.pxPerUnit * 3, c.pxPerUnit * 4]], c), "5.00 m");
  assert.equal(MS.dimensionText([[0, 0], [100, 0], [100, 50]], cfgOf({})), "150 px");
});

test("a scale bar is a round number of units, about as wide as asked", () => {
  const c = cfgOf({ unit: "m", scale: [1, 100] });
  const sb = MS.scaleBar(c, 1, 140);
  assert.ok([1, 2, 5].some((m) => near(sb.units / Math.pow(10, Math.floor(Math.log10(sb.units) + 1e-9)), m)));
  assert.ok(sb.px >= 110 && sb.px <= 600);
  assert.match(sb.label, /^\d+(\.\d+)? m$/);
  assert.ok(near(sb.px, sb.units * c.pxPerUnit));
});

/* ── guides as things to snap to ─────────────────────────────────────────── */

test("a ruler guide snaps one axis and leaves the other alone", () => {
  const vertical = [500, -1000, 500, 1000];
  vertical.axis = "x";
  // a box whose left edge is 3 px from the guide, and whose top is 2 px from the guide's own end
  const r = M.snapGuides([503, -998, 603, -900], [vertical], 6);
  assert.equal(r.dx, -3);
  assert.equal(r.dy, 0, "the ends of a guide are not things to line up with");
  const plain = M.snapGuides([503, -998, 603, -900], [[500, -1000, 500, 1000]], 6);
  assert.equal(plain.dy, -2, "an ordinary box still offers all its edges");
});
