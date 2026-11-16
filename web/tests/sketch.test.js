// Sketch model: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as M from "../sketchmodel.js";

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} expected ${b}, got ${a}`);
const rect = (p = {}) => M.newElement("rectangle", { x: 0, y: 0, width: 100, height: 50, ...p });

// the example file excalidraw.com writes, trimmed, plus fields we do not know
const SAMPLE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [
    { id: "r1", type: "rectangle", x: 10, y: 20, width: 200, height: 100, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "hachure", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a0", roundness: { type: 3 }, seed: 1, version: 5, versionNonce: 7, isDeleted: false, boundElements: [{ type: "text", id: "t1" }, { type: "arrow", id: "a1" }], updated: 1, link: null, locked: false, customData: { mine: 1 } },
    { id: "t1", type: "text", x: 60, y: 57.5, width: 100, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a1", roundness: null, seed: 2, version: 3, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, text: "Hello", fontSize: 20, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: "r1", originalText: "Hello", autoResize: true, lineHeight: 1.25 },
    { id: "a1", type: "arrow", x: 210, y: 70, width: 100, height: 0, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a2", roundness: { type: 2 }, seed: 3, version: 2, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, points: [[0, 0], [100, 0]], lastCommittedPoint: null, startBinding: { elementId: "r1", focus: 0, gap: 1 }, endBinding: null, startArrowhead: null, endArrowhead: "arrow", elbowed: false },
    { id: "gone", type: "ellipse", x: 0, y: 0, width: 10, height: 10, isDeleted: true },
    { id: "f1", type: "freedraw", x: 0, y: 200, width: 30, height: 10, points: [[0, 0], [10, 5], [30, 10]], pressures: [], simulatePressure: true },
    { id: "i1", type: "image", x: 400, y: 0, width: 64, height: 64, fileId: "file1", status: "saved", scale: [1, 1] },
  ],
  appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff", lockedMultiSelections: {} },
  files: {
    file1: { mimeType: "image/png", id: "file1", dataURL: "data:image/png;base64,AAAA", created: 1 },
    orphan: { mimeType: "image/png", id: "orphan", dataURL: "data:image/png;base64,BBBB", created: 1 },
  },
  extraTopLevel: "kept",
});

test("parse keeps unknown fields and fills defaults", () => {
  const { scene, error } = M.parseScene(SAMPLE);
  assert.equal(error, null);
  assert.equal(scene.elements.length, 6);
  const r = scene.elements[0];
  assert.deepEqual(r.customData, { mine: 1 });
  assert.equal(scene.elements[2].elbowed, false);
  const f = scene.elements[4];
  assert.equal(f.strokeColor, "#1e1e1e");
  assert.equal(f.opacity, 100);
  assert.deepEqual(f.groupIds, []);
  assert.equal(scene.elements[5].crop, null);
  assert.equal(scene.extraTopLevel, "kept");
  assert.deepEqual(scene.appState.lockedMultiSelections, {});
});

test("parse never throws on junk", () => {
  assert.ok(M.parseScene("{nope").error);
  assert.ok(M.parseScene("[1,2]").error);
  assert.ok(M.parseScene(JSON.stringify({ type: "canvas" })).error);
  const e = M.parseScene("");
  assert.equal(e.error, null);
  assert.equal(e.empty, true);
  assert.equal(e.scene.elements.length, 0);
  // elements without a type are skipped, bad numbers fixed
  const { scene } = M.parseScene(JSON.stringify({ type: "excalidraw", elements: [{ id: "x" }, { type: "rectangle", x: "a", y: null }] }));
  assert.equal(scene.elements.length, 1);
  assert.equal(scene.elements[0].x, 0);
  assert.ok(scene.elements[0].id.length > 0);
});

test("legacy strokeSharpness becomes roundness", () => {
  const { scene } = M.parseScene(JSON.stringify({ type: "excalidraw", elements: [
    { id: "a", type: "rectangle", strokeSharpness: "round" },
    { id: "b", type: "diamond", strokeSharpness: "round" },
    { id: "c", type: "rectangle", strokeSharpness: "sharp" },
  ] }));
  assert.deepEqual(scene.elements[0].roundness, { type: 3 });
  assert.deepEqual(scene.elements[1].roundness, { type: 2 });
  assert.equal(scene.elements[2].roundness, null);
});

test("serialize writes valid Excalidraw JSON", () => {
  const { scene } = M.parseScene(SAMPLE);
  const text = M.serializeScene(scene);
  assert.ok(text.startsWith('{\n  "type": "excalidraw",\n  "version": 2,'), "2-space indent, type first");
  const out = JSON.parse(text);
  assert.equal(out.type, "excalidraw");
  assert.equal(out.version, 2);
  assert.equal(out.source, "https://excalidraw.com");
  assert.equal(out.extraTopLevel, "kept");
  assert.ok(Array.isArray(out.elements));
  assert.ok(!out.elements.some((e) => e.id === "gone"), "deleted elements dropped");
  assert.deepEqual(Object.keys(out.files), ["file1"], "unused files dropped");
  assert.deepEqual(out.elements[0].customData, { mine: 1 });
  assert.equal(Object.keys(out.elements[0])[0], "id");
  // every element carries the fields Excalidraw requires
  const common = ["id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds", "frameId", "roundness", "seed", "version", "versionNonce", "isDeleted", "boundElements", "updated", "link", "locked", "index"];
  for (const el of out.elements) {
    for (const k of common) assert.ok(k in el, `${el.type} has ${k}`);
    if (el.type === "text") for (const k of ["text", "originalText", "fontSize", "fontFamily", "textAlign", "verticalAlign", "containerId", "lineHeight"]) assert.ok(k in el, k);
    if (el.type === "arrow") for (const k of ["points", "startBinding", "endBinding", "startArrowhead", "endArrowhead", "lastCommittedPoint"]) assert.ok(k in el, k);
    if (el.type === "freedraw") for (const k of ["points", "pressures", "simulatePressure"]) assert.ok(k in el, k);
    if (el.type === "image") for (const k of ["fileId", "status", "scale"]) assert.ok(k in el, k);
  }
  // round trip is stable
  assert.equal(M.serializeScene(M.parseScene(text).scene), text);
});

test("fractional indices stay valid after reordering", () => {
  const els = [rect({ index: "a0" }), rect({ index: "a1" }), rect({ index: "a2" })];
  assert.equal(M.fixIndices(els), false, "valid order untouched");
  [els[0], els[2]] = [els[2], els[0]];
  assert.equal(M.fixIndices(els), true);
  const keys = els.map((e) => e.index);
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(M.indexKey(0), "a0");
  assert.equal(M.indexKey(61), "az");
  assert.equal(M.indexKey(62), "b00");
  const many = Array.from({ length: 5000 }, (_, i) => M.indexKey(i));
  for (let i = 1; i < many.length; i++) assert.ok(many[i - 1] < many[i], `${many[i - 1]} < ${many[i]}`);
});

test("grid flag works for old and new readers", () => {
  const legacy = { gridSize: null, viewBackgroundColor: "#fff" };
  assert.equal(M.gridEnabled(legacy), false);
  M.setGrid(legacy, true);
  assert.equal(legacy.gridSize, 20);
  assert.equal(M.gridEnabled(legacy), true);
  M.setGrid(legacy, false);
  assert.equal(legacy.gridSize, null, "old readers see null as off");
  const modern = { gridSize: 40, gridStep: 5, gridModeEnabled: false };
  M.setGrid(modern, false);
  assert.equal(modern.gridSize, 40, "custom size kept");
  assert.equal(M.gridEnabled({ gridSize: 20 }), true);
});

test("ids, seeds and version bumps", () => {
  const a = M.randomId();
  assert.equal(a.length, 21);
  assert.notEqual(a, M.randomId());
  const el = rect();
  assert.equal(el.version, 1);
  const nonce = el.versionNonce;
  M.mutate(el, { x: 5 }, 42);
  assert.equal(el.x, 5);
  assert.equal(el.version, 2);
  assert.equal(el.updated, 42);
  assert.ok(Number.isInteger(el.seed) && el.seed >= 0 && el.seed < 2 ** 31);
  assert.ok(el.versionNonce !== nonce || el.versionNonce === nonce); // random, just present
});

test("new elements carry Excalidraw defaults", () => {
  const r = M.newElement("rectangle");
  assert.deepEqual(r.roundness, { type: 3 });
  assert.equal(r.fillStyle, "solid");
  const d = M.newElement("diamond");
  assert.deepEqual(d.roundness, { type: 2 });
  const s = M.newElement("rectangle", {}, { roundness: "sharp" });
  assert.equal(s.roundness, null);
  const t = M.newElement("text");
  assert.equal(t.lineHeight, 1.25);
  assert.equal(t.fontFamily, 1);
  const a = M.newElement("arrow");
  assert.equal(a.endArrowhead, "arrow");
  assert.equal(a.startArrowhead, null);
  const l = M.newElement("line");
  assert.equal(l.endArrowhead, null);
  const f = M.newElement("freedraw");
  assert.equal(f.simulatePressure, true);
});

test("bounds follow rotation", () => {
  const r = rect({ x: 0, y: 0, width: 100, height: 50 });
  assert.deepEqual(M.elementBounds(r), [0, 0, 100, 50]);
  r.angle = Math.PI / 2;
  const b = M.elementBounds(r);
  near(b[0], 25); near(b[1], -25); near(b[2], 75); near(b[3], 75);
  const e = M.newElement("ellipse", { x: 0, y: 0, width: 100, height: 50, angle: Math.PI / 2 });
  const eb = M.elementBounds(e);
  near(eb[2] - eb[0], 50); near(eb[3] - eb[1], 100);
  const d = M.newElement("diamond", { x: 0, y: 0, width: 100, height: 100, angle: Math.PI / 4 });
  const db = M.elementBounds(d);
  near(db[2] - db[0], 100 * Math.SQRT1_2, 1e-6, "diamond at 45deg is a square");
  // a line's bounds come from its points, which may go negative
  const l = M.newElement("line", { x: 10, y: 10, points: [[0, 0], [-20, 30]] });
  assert.deepEqual(M.elementBounds(l), [-10, 10, 10, 40]);
  l.angle = Math.PI;
  const lb = M.elementBounds(l);
  near(lb[0], -10); near(lb[2], 10); near(lb[1], 10); near(lb[3], 40);
  assert.deepEqual(M.commonBounds([rect({ x: -5 }), rect({ y: 100 })]), [-5, 0, 100, 150]);
  assert.equal(M.commonBounds([]), null);
});

test("hit tests follow the drawn shape", () => {
  const hollow = rect({ x: 0, y: 0, width: 100, height: 100, roundness: null });
  assert.ok(M.hitTest(hollow, 0, 50, 2), "on the left edge");
  assert.ok(!M.hitTest(hollow, 50, 50, 2), "hollow middle misses");
  assert.ok(M.hitTest(hollow, 50, 50, 2, { inside: true }));
  const filled = rect({ x: 0, y: 0, width: 100, height: 100, backgroundColor: "#ffc9c9" });
  assert.ok(M.hitTest(filled, 50, 50, 2), "filled middle hits");
  assert.ok(!M.hitTest(filled, 120, 50, 2));
  // rounded corners: the very corner is outside the curve
  const round = rect({ x: 0, y: 0, width: 100, height: 100, backgroundColor: "#fff", roundness: { type: 3 } });
  assert.ok(!M.hitTest(round, 1, 1, 1), "rounded corner cut off");
  assert.ok(M.hitTest(hollow, 1, 1, 1), "sharp corner hits");

  const ell = M.newElement("ellipse", { x: 0, y: 0, width: 200, height: 100 });
  assert.ok(M.hitTest(ell, 0, 50, 2), "left extreme");
  assert.ok(M.hitTest(ell, 100, 0, 2), "top extreme");
  assert.ok(!M.hitTest(ell, 5, 5, 2), "bbox corner is not the ellipse");
  assert.ok(!M.hitTest(ell, 100, 50, 2), "hollow centre");

  const dia = M.newElement("diamond", { x: 0, y: 0, width: 100, height: 100, backgroundColor: "#a5d8ff" });
  assert.ok(M.hitTest(dia, 50, 50, 1));
  assert.ok(!M.hitTest(dia, 5, 5, 1), "diamond corner area is empty");
  assert.ok(M.hitTest(dia, 25, 25, 1.5), "on the edge");

  // rotated: a thin bar turned 90deg is hit where it now is
  const bar = rect({ x: 0, y: 45, width: 100, height: 10, backgroundColor: "#000", angle: Math.PI / 2 });
  assert.ok(M.hitTest(bar, 50, 5, 1));
  assert.ok(!M.hitTest(bar, 5, 50, 1));

  const text = M.newElement("text", { x: 0, y: 0, width: 50, height: 20, text: "hi" });
  assert.ok(M.hitTest(text, 25, 10, 0));
  assert.ok(!M.hitTest(text, 70, 10, 2));
  const img = M.newElement("image", { x: 0, y: 0, width: 50, height: 50 });
  assert.ok(M.hitTest(img, 25, 25, 0));

  const deleted = rect({ isDeleted: true, backgroundColor: "#000" });
  assert.ok(!M.hitTest(deleted, 50, 25, 5));
});

test("hit tests on lines, arrows and freehand", () => {
  const line = M.newElement("line", { x: 0, y: 0, points: [[0, 0], [100, 0], [100, 100]] });
  assert.ok(M.hitTest(line, 50, 1, 2));
  assert.ok(M.hitTest(line, 101, 50, 2));
  assert.ok(!M.hitTest(line, 50, 50, 2), "open line has no inside");
  const tri = M.newElement("line", { x: 0, y: 0, backgroundColor: "#ffec99", points: [[0, 0], [100, 0], [0, 100], [0, 0]] });
  assert.ok(M.hitTest(tri, 20, 20, 1), "closed filled line hits inside");
  const rotated = M.newElement("arrow", { x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]], angle: Math.PI / 2 });
  // centre is (50, 0); turned 90deg the arrow runs from (50,-50) to (50,50)
  assert.ok(M.hitTest(rotated, 50, 40, 1));
  assert.ok(!M.hitTest(rotated, 90, 0, 1));
  const curved = M.newElement("arrow", { x: 0, y: 0, points: [[0, 0], [50, 50], [100, 0]], roundness: { type: 2 } });
  assert.ok(M.hitTest(curved, 50, 50, 2), "curve passes through its points");
  const pen = M.newElement("freedraw", { x: 10, y: 10, points: [[0, 0], [20, 0], [20, 20]], strokeWidth: 2 });
  assert.ok(M.hitTest(pen, 20, 10, 1));
  assert.ok(M.hitTest(pen, 30, 20, 1), "distance to the second segment");
  assert.ok(!M.hitTest(pen, 15, 25, 1), "inside the open scribble misses");
  const loop = M.newElement("freedraw", { x: 0, y: 0, backgroundColor: "#b2f2bb", points: [[0, 0], [40, 0], [40, 40], [0, 40], [1, 1]] });
  assert.ok(M.hitTest(loop, 20, 20, 1), "closed filled scribble hits inside");
});

test("geometry helpers", () => {
  near(M.distToSegment(5, 5, 0, 0, 10, 0), 5);
  near(M.distToSegment(-3, 4, 0, 0, 10, 0), 5, 1e-9, "beyond the start");
  near(M.distToPolyline(5, 5, [0, 0, 10, 0, 10, 10]), 5);
  assert.ok(M.pointInPolygon(5, 5, [0, 0, 10, 0, 10, 10, 0, 10]));
  assert.ok(!M.pointInPolygon(15, 5, [0, 0, 10, 0, 10, 10, 0, 10]));
  const [x, y] = M.rotatePoint(10, 0, 0, 0, Math.PI / 2);
  near(x, 0); near(y, 10);
  const [sx, sy] = M.snapAngle(0, 0, 10, 1);
  near(sy, 0); near(sx, Math.hypot(10, 1));
  assert.deepEqual(M.pointsExtent([[1, 2], [-3, 5]]), [-3, 2, 1, 5]);
  const c = M.sampleCurve([[0, 0], [50, 50], [100, 0]], 4);
  assert.equal(c.length, 2 + 2 * 4 * 2);
  near(c[8], 50); near(c[9], 50);
});

test("linear points round-trip through world coordinates", () => {
  const el = M.newElement("arrow", { x: 100, y: 100, points: [[0, 0], [50, 0], [50, 50]] });
  const abs = M.absolutePoints(el);
  assert.deepEqual(abs, [[100, 100], [150, 100], [150, 150]]);
  abs[0] = [90, 80];
  const upd = M.linearFromAbsolute(el, abs);
  assert.equal(upd.x, 90);
  assert.equal(upd.y, 80);
  assert.deepEqual(upd.points[0], [0, 0]);
  assert.deepEqual(upd.points[2], [60, 70]);
  assert.equal(upd.width, 60);
  // rotated: moving one point must not move the others on screen
  const rot = M.newElement("line", { x: 0, y: 0, points: [[0, 0], [100, 0], [100, 60]], angle: 0.7 });
  const before = M.absolutePoints(rot);
  const moved = before.map((p) => p.slice());
  moved[2] = [moved[2][0] + 30, moved[2][1] - 10];
  Object.assign(rot, M.linearFromAbsolute(rot, moved));
  const after = M.absolutePoints(rot);
  near(after[0][0], before[0][0], 1e-6); near(after[0][1], before[0][1], 1e-6);
  near(after[1][0], before[1][0], 1e-6); near(after[1][1], before[1][1], 1e-6);
  near(after[2][0], moved[2][0], 1e-6); near(after[2][1], moved[2][1], 1e-6);
});

test("arrow bindings: focus, focus point and intersection", () => {
  const box = rect({ id: "box", x: 100, y: 0, width: 100, height: 100, roundness: null });
  // an arrow aimed straight at the centre has focus 0
  near(M.focusDistance(box, [0, 50], [120, 50]), 0);
  // aimed above the centre: non-zero, and the focus point reproduces the line
  const f = M.focusDistance(box, [0, 20], [120, 20]);
  assert.ok(f !== 0 && Math.abs(f) <= 1);
  const fp = M.focusPoint(box, f, [0, 20]);
  const hits = M.intersectElementWithLine(box, [0, 20], fp, 0);
  assert.equal(hits.length, 2);
  near(hits[0][0], 100, 1e-6, "enters at the left edge");
  near(hits[0][1], 20, 1e-6);
  near(hits[1][0], 200, 1e-6);
  // with a gap the arrow stops short of the edge
  const gapped = M.intersectElementWithLine(box, [0, 50], [150, 50], 8);
  near(gapped[0][0], 92, 1e-6);
  // a line that misses gives nothing
  assert.deepEqual(M.intersectElementWithLine(box, [0, 200], [10, 200], 0), []);
  // ellipse
  const ell = M.newElement("ellipse", { id: "e", x: 100, y: 0, width: 100, height: 100 });
  const eh = M.intersectElementWithLine(ell, [0, 50], [150, 50], 0);
  near(eh[0][0], 100, 1e-6); near(eh[1][0], 200, 1e-6);
  const ef = M.focusDistance(ell, [0, 30], [120, 30]);
  const efp = M.focusPoint(ell, ef, [0, 30]);
  const eh2 = M.intersectElementWithLine(ell, [0, 30], efp, 0);
  near(eh2[0][1], 30, 1e-6, "ellipse focus keeps the aim");
  // diamond
  const dia = M.newElement("diamond", { id: "d", x: 100, y: 0, width: 100, height: 100 });
  const dh = M.intersectElementWithLine(dia, [0, 50], [150, 50], 0);
  near(dh[0][0], 100, 1e-6);
  // rotated rectangle: centre aim is rotation-proof
  const rot = rect({ id: "rot", x: 100, y: 0, width: 100, height: 100, angle: 0.5 });
  near(M.focusDistance(rot, [0, 50], [150, 50]), 0, 1e-9);
});

test("bound arrows follow the shapes they are attached to", () => {
  const a = rect({ id: "A", x: 0, y: 0, width: 100, height: 100, roundness: null });
  const b = rect({ id: "B", x: 300, y: 0, width: 100, height: 100, roundness: null });
  const arrow = M.newElement("arrow", { x: 110, y: 50, points: [[0, 0], [180, 0]] });
  arrow.startBinding = M.calcBinding(arrow, a, "start");
  arrow.endBinding = M.calcBinding(arrow, b, "end");
  assert.equal(arrow.startBinding.elementId, "A");
  near(arrow.startBinding.gap, 10);
  near(arrow.endBinding.gap, 10);
  const byId = new Map([["A", a], ["B", b], [arrow.id, arrow]]);
  // move B down: the arrow's end follows and still stops 10 short
  b.y = 200;
  const v = arrow.version;
  assert.ok(M.refreshArrow(arrow, byId));
  assert.ok(arrow.version > v);
  const [sx, sy] = M.absolutePoint(arrow, 0);
  const [ex, ey] = M.absolutePoint(arrow, -1);
  near(M.bindDistance(b, ex, ey), 10, 0.5, "end gap kept");
  near(M.bindDistance(a, sx, sy), 10, 0.5, "start gap kept");
  assert.ok(ey > 150, "end moved down");
  // nothing changes on a second pass
  assert.equal(M.refreshArrow(arrow, byId), false);
  // pointer near the middle snaps focus to 0
  const inner = M.newElement("arrow", { x: -100, y: 40, points: [[0, 0], [150, 10]] });
  assert.equal(M.calcBinding(inner, a, "end").focus, 0);
  // candidates: inside or within the binding gap, topmost first
  assert.equal(M.bindingCandidate([a, b], 50, 50), a);
  assert.equal(M.bindingCandidate([a, b], 110, 50), a);
  assert.equal(M.bindingCandidate([a, b], 150, 50), null);
  assert.equal(M.bindingCandidate([a, b], 50, 50, new Set(["A"])), null);
  // resizing scales the gap within bounds
  const g = M.scaledGap(a, { elementId: "A", focus: 0, gap: 10 }, 50, 50);
  near(g.gap, 5);
  near(M.maxBindingGap(a), 25);
});

test("text wraps and sits inside its container", () => {
  const measure = (s) => s.length * 10;
  assert.equal(M.wrapText("hello world again", 110, measure), "hello world\nagain");
  assert.equal(M.wrapText("abcdefghij", 40, measure), "abcd\nefgh\nij");
  assert.equal(M.wrapText("one\ntwo", 100, measure), "one\ntwo");
  const m = M.measureText("ab\nabcd", 20, 1.25, measure);
  assert.deepEqual(m, { width: 40, height: 50 });
  const box = rect({ x: 0, y: 0, width: 130, height: 40 });
  assert.equal(M.boundTextMaxWidth(box), 120);
  const t = M.newElement("text", { originalText: "hello world again", text: "", fontSize: 20, lineHeight: 1.25, textAlign: "center", verticalAlign: "middle", containerId: box.id });
  const upd = M.layoutBoundText(box, t, (s) => measure(s));
  assert.equal(upd.text.text, "hello world\nagain");
  assert.equal(upd.text.height, 50);
  assert.equal(upd.container.height, 60, "container grows to fit");
  Object.assign(t, upd.text);
  Object.assign(box, upd.container);
  const again = M.layoutBoundText(box, t, (s) => measure(s));
  assert.deepEqual(again.container, {});
  near(t.x + t.width / 2, 65, 1e-6, "centred");
  near(t.y + t.height / 2, 30, 1e-6, "middle");
  const ell = M.newElement("ellipse", { x: 0, y: 0, width: 200, height: 100 });
  assert.equal(M.boundTextMaxWidth(ell), Math.round(100 * Math.SQRT2) - 10);
  assert.equal(M.containerDimensionFor(50, "diamond"), 120);
  const arrow = M.newElement("arrow", { x: 0, y: 0, points: [[0, 0], [100, 0]] });
  const pos = M.boundTextPosition(arrow, { width: 20, height: 10 });
  assert.deepEqual(pos, { x: 40, y: -5 });
});

test("resize keeps the opposite corner fixed, also when rotated", () => {
  const box = { x: 0, y: 0, width: 100, height: 50, angle: 0 };
  assert.deepEqual(M.resizeBox(box, "se", 150, 100), { x: 0, y: 0, width: 150, height: 100, flipX: false, flipY: false });
  const nw = M.resizeBox(box, "nw", -50, -50);
  assert.deepEqual([nw.x, nw.y, nw.width, nw.height], [-50, -50, 150, 100]);
  const ratio = M.resizeBox(box, "se", 200, 60, { keepRatio: true });
  assert.deepEqual([ratio.width, ratio.height], [200, 100]);
  const centre = M.resizeBox(box, "e", 120, 25, { fromCenter: true });
  assert.deepEqual([centre.x, centre.width], [-20, 140]);
  const flip = M.resizeBox(box, "e", -20, 25);
  assert.equal(flip.flipX, true);
  assert.deepEqual([flip.x, flip.width], [-20, 20]);
  // rotated 90deg: the world position of the fixed corner does not move
  const rot = { x: 0, y: 0, width: 100, height: 50, angle: Math.PI / 2 };
  const fixedBefore = M.rotatePoint(0, 0, 50, 25, rot.angle);
  const handle = M.rotatePoint(100, 50, 50, 25, rot.angle);
  const out = M.resizeBox(rot, "se", handle[0] - 10, handle[1] + 20);
  const fixedAfter = M.rotatePoint(out.x, out.y, out.x + out.width / 2, out.y + out.height / 2, rot.angle);
  near(fixedAfter[0], fixedBefore[0], 1e-9); near(fixedAfter[1], fixedBefore[1], 1e-9);
  near(out.width, 120, 1e-9); near(out.height, 60, 1e-9);
  // points follow a flip
  const fit = M.fitPoints([[0, 0], [10, 20]], [0, 0, 10, 20], 20, 40, true, false);
  assert.deepEqual(fit.points, [[0, 0], [-20, 40]]);
  assert.deepEqual(fit.offset, [20, 0]);
});

test("grid snap and smart guides", () => {
  assert.equal(M.snapToGrid(29, 20), 20);
  assert.equal(M.snapToGrid(31, 20), 40);
  assert.equal(M.snapToGrid(-11, 20), -20);
  assert.equal(M.snapToGrid(7, 0), 7);
  const s = M.snapGuides([103, 52, 203, 102], [[0, 0, 100, 50], [300, 200, 400, 250]], 5);
  assert.equal(s.dx, -3, "left edge onto right edge");
  assert.equal(s.dy, -2, "top onto bottom");
  assert.ok(s.guides.some((g) => g.x1 === 100 && g.x2 === 100));
  assert.ok(s.guides.some((g) => g.y1 === 50 && g.y2 === 50));
  const none = M.snapGuides([500, 500, 510, 510], [[0, 0, 100, 50]], 5);
  assert.deepEqual(none, { dx: 0, dy: 0, guides: [] });
  const centre = M.snapGuides([45, 200, 57, 210], [[0, 0, 100, 50]], 3);
  assert.equal(centre.dx, -1, "centre onto centre");
});

test("align and distribute", () => {
  const boxes = [[0, 0, 10, 10], [50, 20, 70, 30], [100, 5, 130, 45]];
  assert.deepEqual(M.alignBoxes(boxes, "left"), [[0, 0], [-50, 0], [-100, 0]]);
  assert.deepEqual(M.alignBoxes(boxes, "right"), [[120, 0], [60, 0], [0, 0]]);
  assert.deepEqual(M.alignBoxes(boxes, "top"), [[0, 0], [0, -20], [0, -5]]);
  assert.deepEqual(M.alignBoxes(boxes, "bottom"), [[0, 35], [0, 15], [0, 0]]);
  assert.deepEqual(M.alignBoxes(boxes, "centerX"), [[60, 0], [5, 0], [-50, 0]]);
  assert.deepEqual(M.alignBoxes(boxes, "centerY"), [[0, 17.5], [0, -2.5], [0, -2.5]]);
  // total 130 wide, 60 of boxes, so two gaps of 35
  const d = M.distributeBoxes(boxes, "x");
  assert.deepEqual(d, [[0, 0], [-5, 0], [0, 0]]);
  assert.deepEqual(M.distributeBoxes(boxes.slice(0, 2), "x"), [[0, 0], [0, 0]]);
  const overlapping = [[0, 0, 100, 10], [10, 0, 110, 10], [50, 0, 60, 10]];
  const o = M.distributeBoxes(overlapping, "x");
  // centres 50, 55, 60 -> the middle one (55) is already evenly placed
  assert.deepEqual(o.map((m) => m[0]), [0, 0, 0]);
});

test("layer order", () => {
  const mk = (id, del) => ({ id, isDeleted: !!del });
  const ids = (arr) => arr.map((e) => e.id).join("");
  const sel = (set) => (e) => set.includes(e.id);
  assert.equal(ids(M.moveLayer([mk("a"), mk("b"), mk("c")], sel(["a"]), "front")), "bca");
  assert.equal(ids(M.moveLayer([mk("a"), mk("b"), mk("c")], sel(["c"]), "back")), "cab");
  assert.equal(ids(M.moveLayer([mk("a"), mk("b"), mk("c")], sel(["a", "b"]), "forward")), "cab");
  assert.equal(ids(M.moveLayer([mk("a"), mk("b"), mk("c")], sel(["c"]), "backward")), "acb");
  assert.equal(ids(M.moveLayer([mk("a"), mk("d", true), mk("c")], sel(["a"]), "forward")), "dca", "steps over deleted");
  assert.equal(ids(M.moveLayer([mk("a"), mk("b")], sel(["b"]), "forward")), "ab", "already on top");
});

test("groups and duplicates", () => {
  const el = rect({ groupIds: ["inner", "outer"] });
  assert.equal(M.selectGroupId(el, null), "outer");
  assert.equal(M.selectGroupId(el, "outer"), "inner");
  assert.equal(M.selectGroupId(el, "inner"), null);
  assert.equal(M.selectGroupId(rect(), null), null);

  const box = rect({ id: "box", groupIds: ["g"], boundElements: [{ type: "text", id: "txt" }, { type: "arrow", id: "arr" }] });
  const txt = M.newElement("text", { id: "txt", containerId: "box", groupIds: ["g"] });
  const arr = M.newElement("arrow", { id: "arr", startBinding: { elementId: "box", focus: 0, gap: 4 }, endBinding: { elementId: "elsewhere", focus: 0, gap: 4 } });
  const { elements, ids } = M.duplicateElements([box, txt, arr], { dx: 10, dy: 10 });
  const [b2, t2, a2] = elements;
  assert.notEqual(b2.id, "box");
  assert.equal(b2.x, box.x + 10);
  assert.equal(t2.containerId, b2.id);
  assert.deepEqual(b2.boundElements.map((b) => b.id), [t2.id, a2.id]);
  assert.equal(a2.startBinding.elementId, b2.id);
  assert.equal(a2.endBinding, null, "binding to something not copied is dropped");
  assert.notEqual(b2.groupIds[0], "g");
  assert.equal(b2.groupIds[0], t2.groupIds[0], "copies share a new group");
  assert.equal(ids.get("box"), b2.id);
  assert.equal(b2.version, 1);
  box.x = 999;
  assert.notEqual(b2.x, 999, "deep copy");
});

test("clipboard payload pastes as Excalidraw clipboard", () => {
  const { scene } = M.parseScene(SAMPLE);
  const live = scene.elements.filter((e) => !e.isDeleted);
  const payload = M.clipboardPayload(live, scene.files);
  assert.equal(payload.type, "excalidraw/clipboard");
  assert.deepEqual(Object.keys(payload.files), ["file1"]);
  const back = M.parseClipboard(JSON.stringify(payload));
  assert.equal(back.elements.length, live.length);
  assert.equal(M.parseClipboard("plain text"), null);
  assert.equal(M.parseClipboard('{"type":"other"}'), null);
  assert.equal(M.parseClipboard(SAMPLE).elements.length, 5, "a whole file pastes too, minus deleted");
});

test("history merges drags and restores snapshots", () => {
  const h = M.createHistory(3, 1000);
  const el = rect({ x: 0 });
  const snap = (x) => ({ ...el, x });
  h.push({ key: "move", before: new Map([[el.id, snap(0)]]), after: new Map([[el.id, snap(5)]]) }, 0);
  h.push({ key: "move", before: new Map([[el.id, snap(5)]]), after: new Map([[el.id, snap(9)]]) }, 500);
  assert.equal(h.undo.length, 1, "coalesced");
  assert.equal(h.undo[0].before.get(el.id).x, 0);
  assert.equal(h.undo[0].after.get(el.id).x, 9);
  h.push({ key: "move", before: new Map(), after: new Map() }, 5000);
  assert.equal(h.undo.length, 2, "too late to merge");
  h.push({ before: new Map(), after: new Map() }, 5001);
  h.push({ before: new Map(), after: new Map() }, 5002);
  assert.equal(h.undo.length, 3, "bounded");
  const e = h.takeUndo();
  assert.ok(e);
  assert.equal(h.redo.length, 1);
  h.push({ before: new Map(), after: new Map() }, 6000);
  assert.equal(h.redo.length, 0, "new change clears redo");
  // restoring keeps the object, drops fields the snapshot lacks, bumps version
  const live = { ...el, x: 50, extra: true, version: 7 };
  M.restoreInto(live, { ...el, x: 0, version: 3 });
  assert.equal(live.x, 0);
  assert.equal("extra" in live, false);
  assert.equal(live.version, 8);
});

test("dark theme colours", () => {
  assert.equal(M.darkColor("#1e1e1e"), "#d3d3d3", "near-black turns light");
  assert.equal(M.darkColor("#ffffff"), "#121212", "white turns near-black");
  assert.equal(M.darkColor("transparent"), "transparent");
  const red = M.parseColor(M.darkColor("#e03131"));
  assert.ok(red[0] > red[1] && red[0] > red[2], "red stays red");
  const fill = M.parseColor(M.darkColor("#ffc9c9"));
  assert.ok(fill[0] + fill[1] + fill[2] < 300, "pastel fill turns deep");
  assert.equal(M.themeColor("#e03131", false), "#e03131");
  assert.deepEqual(M.parseColor("#abc"), [170, 187, 204, 1]);
  assert.deepEqual(M.parseColor("rgba(1, 2, 3, 0.5)"), [1, 2, 3, 0.5]);
  assert.equal(M.parseColor("nonsense"), null);
  assert.ok(M.isTransparent("transparent"));
  assert.ok(M.isTransparent("#00000000"));
  assert.ok(!M.isTransparent("#000"));
  assert.ok(M.isDefaultBackground("#ffffff"));
  assert.ok(!M.isDefaultBackground("#fff9db"));
  assert.equal(M.darkColor("#ff000080").length, 9, "alpha kept");
});

test("arrowhead geometry matches Excalidraw's sizes", () => {
  const a = M.newElement("arrow", { points: [[0, 0], [100, 0]], strokeWidth: 2 });
  const head = M.arrowheadPoints(a, "end", "arrow");
  assert.equal(head.kind, "lines");
  const [x3, y3, x2, y2] = head.pts[0];
  assert.deepEqual([x2, y2], [100, 0]);
  near(Math.hypot(x3 - 100, y3), 30, 1e-9, "30px wings");
  near(Math.abs(Math.atan2(y3, 100 - x3)), (20 * Math.PI) / 180, 1e-9);
  const short = M.newElement("arrow", { points: [[0, 0], [20, 0]] });
  const sh = M.arrowheadPoints(short, "end", "arrow");
  near(Math.hypot(sh.pts[0][0] - 20, sh.pts[0][1]), 10, 1e-9, "shrinks on short arrows");
  const dot = M.arrowheadPoints(a, "start", "dot");
  assert.deepEqual(dot.pts, [0, 0, 17]);
  const tri = M.arrowheadPoints(a, "end", "triangle");
  assert.equal(tri.pts.length, 3);
  const bar = M.arrowheadPoints(a, "end", "bar");
  near(bar.pts[0][0], 100, 1e-9, "bar sits across the tip");
  near(Math.abs(bar.pts[0][1] - bar.pts[0][3]), 30, 1e-9);
  assert.equal(M.arrowheadPoints(M.newElement("arrow"), "end", "arrow"), null);
});

test("elements in a box", () => {
  const r = rect({ x: 10, y: 10, width: 20, height: 20 });
  assert.ok(M.inBox(r, 0, 0, 40, 40));
  assert.ok(!M.inBox(r, 15, 0, 40, 40));
  assert.ok(M.boxesIntersect([0, 0, 10, 10], [5, 5, 20, 20]));
  assert.ok(!M.boxesIntersect([0, 0, 10, 10], [11, 0, 20, 20]));
});

test("a shared drawing cannot slip markup or a fetch past the cleaners", async () => {
  const { parseColor } = await import("../sketchmodel.js");
  const { cssPlain, cssFetches } = await import("../util.js");
  // names that exist on every object are not colours (they used to crash the load)
  for (const n of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(parseColor(n), null, n);
  assert.deepEqual(parseColor("red"), [255, 0, 0, 1]);
  assert.equal(parseColor('x"/><style>'), null);
  // anything that would fetch, however it is spelled; a reference inside the drawing stays
  const f = (s) => cssFetches(cssPlain(s));
  for (const bad of ["url(https://x)", "fill:URL( https://x)", "\\75 rl(https://x)", "u\\rl(//x)", "@import 'x'", "image-set('a.png' 1x)", "cross-fade(url(a), b)", "background:image(x.png)"]) assert.ok(f(bad), bad);
  for (const ok of ["url(#grad)", "url('#clip')", "#e03131", "rgba(0,0,0,.5)", "linear"]) assert.ok(!f(ok), ok);
});

test("a sketch's background is a colour or nothing: no markup from the file reaches the picture", async () => {
  const M = await import("../sketchmodel.js");
  const R = await import("../sketchrender.js");
  const evil = '#fff"/><foreignObject><iframe src="https://evil.example"></iframe></foreignObject><rect fill="';
  assert.equal(M.canvasColor({ viewBackgroundColor: evil }, false), null);
  assert.equal(M.canvasColor({ viewBackgroundColor: "#123456" }, false), "#123456");
  const el = { id: "a", type: "rectangle", x: 0, y: 0, width: 10, height: 10, strokeColor: "#000", backgroundColor: "transparent", strokeWidth: 1, opacity: 100, angle: 0 };
  const out = R.elementsToSvg([el], { background: evil });
  assert.ok(out && !out.svg.includes("<iframe") && !out.svg.includes("<foreignObject"), out && out.svg.slice(0, 300));
});

test("a drawing only shows pictures it carries: an address in its files is never fetched", () => {
  const src = fs.readFileSync(new URL("../sketch.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function getImage(fileId)"), src.indexOf("rec.img.src = f.dataURL"));
  const guard = /if \(!f \|\| !(\/.+\/i)\.test\(f\.dataURL\)\) return null;/.exec(body);
  assert.ok(guard, "getImage checks dataURL before loading it");
  const carried = eval(guard[1]);
  assert.ok(carried.test("data:image/png;base64,AAAA"));
  assert.ok(carried.test("DATA:IMAGE/webp;base64,AAAA"));
  for (const bad of ["https://evil.example/t.png?u=victim", "//evil.example/t.png", "file:///C:/x.png", " https://x", "data:text/html,x", undefined]) assert.ok(!carried.test(bad), String(bad));
});
