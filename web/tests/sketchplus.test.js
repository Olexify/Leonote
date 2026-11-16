// Sketch additions: brushes, partial eraser, lasso, canvas look, research helpers
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../sketchmodel.js";
import * as B from "../sketchbrush.js";

const stroke = (pts, p = {}) => M.newElement("freedraw", { x: 0, y: 0, points: pts, pressures: [], simulatePressure: true, ...p });
const line = (n, len) => Array.from({ length: n + 1 }, (_, i) => [(len * i) / n, 0]);

test("brush presets resolve and store only what differs", () => {
  assert.equal(B.brushOf(stroke(line(3, 30))), null, "no customData: plain pen");
  const el = stroke(line(3, 30), { customData: { brush: { id: "pencil-hb" } } });
  const b = B.brushOf(el);
  assert.equal(b.texture, "grain");
  assert.equal(b.size, B.PRESET_BY_ID.get("pencil-hb").size);
  assert.equal(B.isPlain(b), false);
  // tweaks survive, untouched params stay out of the file
  const data = B.brushData({ ...b, size: 3 });
  assert.deepEqual(data, { id: "pencil-hb", size: 3 });
  assert.equal(B.brushOf(stroke(line(3, 30), { customData: { brush: data } })).size, 3);
  // the plain pen is Excalidraw's pen
  assert.equal(B.isPlain(B.brushOf({ customData: { brush: "pen" } })), true);
  assert.deepEqual(B.brushData(B.brushOf({ customData: { brush: "pen" } })), { id: "pen" });
  // unknown ids (saved custom brushes) keep all their params
  const mine = B.brushOf({ customData: { brush: { id: "mine-x", size: 7, texture: "chalk", grain: 0.4 } } });
  assert.equal(mine.size, 7);
  assert.equal(mine.texture, "chalk");
  // every family has presets, ids are unique
  for (const f of B.FAMILIES) if (f.id !== "custom") assert.ok(B.PRESETS.some((p) => p.family === f.id), f.id);
  assert.equal(new Set(B.PRESETS.map((p) => p.id)).size, B.PRESETS.length);
});

test("brush outlines are closed, finite and sized by the brush", () => {
  const pts = Array.from({ length: 30 }, (_, i) => [i * 5, Math.sin(i / 4) * 20]);
  for (const p of B.PRESETS) {
    const b = B.brushOf({ customData: { brush: p.id } });
    const o = B.brushOutline(pts, [], true, 2, b);
    assert.ok(o.length > 4, p.id);
    for (const q of o) assert.ok(Number.isFinite(q[0]) && Number.isFinite(q[1]), p.id);
    assert.ok(B.outlineToPath(o).endsWith("Z"), p.id);
  }
  // a flat nib is wide across its angle and thin along it
  const nib = B.brushOf({ customData: { brush: { id: "x", angle: 0, nib: 0.1, size: 10 } } });
  const across = B.nibOutline(line(20, 100).map((p) => [p[1], p[0], 0.5]), false, 20, nib); // vertical stroke
  const along = B.nibOutline(line(20, 100).map((p) => [p[0], p[1], 0.5]), false, 20, nib); // horizontal stroke
  const spanX = (o) => Math.max(...o.map((p) => p[0])) - Math.min(...o.map((p) => p[0]));
  const spanY = (o) => Math.max(...o.map((p) => p[1])) - Math.min(...o.map((p) => p[1]));
  assert.ok(spanX(across) > 12, "vertical stroke: the nib's width shows sideways");
  assert.ok(spanY(along) < 4, "horizontal stroke along the nib stays a hairline");
  assert.ok(spanY(along) > 0.5, "but never vanishes");
  // pressure curves stay in range
  for (const c of ["linear", "soft", "firm", "light"]) for (const p of [0, 0.3, 1]) { const v = B.curvePressure(p, c); assert.ok(v >= 0 && v <= 1, c); }
});

test("bristles and speckles are seeded, so strokes never shimmer", () => {
  const pts = line(20, 200);
  const b = B.brushOf({ customData: { brush: "brush-dry" } });
  assert.deepEqual(B.bristles(pts, 2, b, 42), B.bristles(pts, 2, b, 42));
  assert.notDeepEqual(B.bristles(pts, 2, b, 42), B.bristles(pts, 2, b, 43));
  assert.ok(B.speckles(pts, 2, B.brushOf({ customData: { brush: "brush-air" } }), 5).length > 0);
});

test("the cut eraser splits a stroke and keeps its brush", () => {
  const el = stroke(line(10, 100), { customData: { brush: { id: "marker-felt" } }, x: 10, y: 20 });
  const runs = M.cutFreedraw(el, 60, 20, 5);
  assert.equal(runs.length, 2);
  assert.ok(Math.abs(runs[0].points[runs[0].points.length - 1][0] - 55) < 1e-6, "left piece ends at the circle");
  assert.ok(Math.abs(runs[1].points[0][0] - 65) < 1e-6, "right piece starts after it");
  const piece = M.freedrawPiece(el, runs[1]);
  assert.notEqual(piece.id, el.id);
  assert.deepEqual(piece.points[0], [0, 0]);
  assert.equal(piece.x, 65);
  assert.deepEqual(piece.customData, { brush: { id: "marker-felt" } });
  assert.equal(piece.width, 45);
  // untouched and wholly erased
  assert.equal(M.cutFreedraw(el, 60, 200, 5), null);
  assert.deepEqual(M.cutFreedraw(el, 60, 20, 500), []);
  // an end cut leaves one piece; pressures follow the points
  const pen = stroke(line(4, 40), { simulatePressure: false, pressures: [0.1, 0.2, 0.3, 0.4, 0.5] });
  const one = M.cutFreedraw(pen, 40, 0, 5);
  assert.equal(one.length, 1);
  assert.equal(one[0].points.length, one[0].pressures.length);
  assert.ok(Math.abs(one[0].pressures[one[0].pressures.length - 1] - 0.45) < 1e-9);
  // a long segment through the circle is cut in the middle, not dropped
  const two = M.cutFreedraw(stroke([[0, 0], [100, 0]]), 50, 0, 10);
  assert.equal(two.length, 2);
});

test("lasso takes what it wholly encloses", () => {
  const r = M.newElement("rectangle", { x: 10, y: 10, width: 40, height: 20 });
  const loop = [0, 0, 60, 0, 60, 40, 0, 40];
  assert.equal(M.inLasso(r, loop), true);
  assert.equal(M.inLasso({ ...r, x: 40 }, loop), false);
  const s = stroke([[0, 0], [10, 5], [20, 0]], { x: 5, y: 5 });
  assert.equal(M.inLasso(s, loop), true);
  // a concave lasso leaves out a shape sitting in its notch
  const ushape = [0, 0, 20, 0, 20, 30, 40, 30, 40, 0, 60, 0, 60, 60, 0, 60];
  assert.equal(M.inLasso(M.newElement("ellipse", { x: 25, y: 5, width: 10, height: 10 }), ushape), false);
  assert.equal(M.inLasso(M.newElement("ellipse", { x: 25, y: 40, width: 10, height: 10 }), ushape), true);
});

test("canvas look lives in a key Excalidraw ignores", () => {
  const as = { viewBackgroundColor: "#ffffff" };
  assert.deepEqual(M.canvasOf(as), { light: null, dark: null, pattern: "plain", density: 1 });
  assert.equal(M.canvasColor(as, false), null, "default: the app's own background");
  M.setCanvas(as, { light: "#f7f3ea", pattern: "dots" });
  assert.equal(as.viewBackgroundColor, "#f7f3ea", "Excalidraw still sees the light colour");
  assert.equal(M.canvasColor(as, false), "#f7f3ea");
  assert.equal(M.canvasColor(as, true), M.darkColor("#f7f3ea"), "no dark pick: the usual dark maths");
  M.setCanvas(as, { dark: "#1d232b" });
  assert.equal(M.canvasColor(as, true), "#1d232b");
  M.setCanvas(as, { dark: "app" });
  assert.equal(M.canvasColor(as, true), null);
  M.setCanvas(as, { light: null, dark: null, pattern: "plain" });
  assert.equal(as.leonoteCanvas, undefined, "defaults leave nothing behind");
  assert.equal(as.viewBackgroundColor, "#ffffff");
  // junk is ignored
  assert.deepEqual(M.canvasOf({ leonoteCanvas: { light: "nope", pattern: "stripes", density: 99 } }), { light: null, dark: null, pattern: "plain", density: 3 });
  // round trip through the file
  const scene = M.emptyScene();
  M.setCanvas(scene.appState, { dark: "#111a2c", pattern: "lined", density: 1.5 });
  const back = M.parseScene(M.serializeScene(scene)).scene;
  assert.deepEqual(M.canvasOf(back.appState), { light: null, dark: "#111a2c", pattern: "lined", density: 1.5 });
});

test("note cards: excerpts, links and roomier text", () => {
  const md = "---\ntags: [a]\n---\n# Title\n\nSome **bold** text with a [[Other note|link]] and [site](http://x).\n\n```js\nconst code = 1;\n```\n- [ ] a task\n> quoted";
  assert.equal(M.excerptOf(md), "Some bold text with a link and site. a task quoted");
  assert.ok(M.excerptOf("word ".repeat(100), 40).length <= 40);
  assert.ok(M.excerptOf("word ".repeat(100), 40).endsWith("…"));
  assert.equal(M.wikiLinkFor("Ideas/Agent swarm.md"), "[[Ideas/Agent swarm]]");
  const card = M.newElement("rectangle", { width: 260, height: 100, customData: { notePath: "Ideas/Agent swarm.md" }, link: "[[Ideas/Agent swarm]]" });
  assert.equal(M.linkedNote(card), "Ideas/Agent swarm.md");
  assert.equal(M.linkedNote({ link: "[[Welcome#Start|hi]]" }), "Welcome");
  assert.equal(M.linkedNote({ link: "https://x.org" }), null);
  assert.equal(M.padOf(card), M.CARD_PADDING);
  assert.equal(M.boundTextMaxWidth(card), 260 - M.CARD_PADDING * 2);
  assert.equal(M.boundTextMaxWidth(M.newElement("rectangle", { width: 260 })), 260 - M.BOUND_TEXT_PADDING * 2);
  // the sticky flag also pads
  assert.equal(M.padOf({ customData: { sticky: true } }), M.CARD_PADDING);
  assert.equal(M.containerDimensionFor(50, "rectangle", M.CARD_PADDING), 50 + M.CARD_PADDING * 2);
});

test("search and outline find text, cards and frames in reading order", () => {
  const frame = M.newElement("frame", { x: 0, y: 0, width: 500, height: 300, name: "Sources" });
  const card = M.newElement("rectangle", { id: "c1", x: 20, y: 400, width: 260, height: 90, customData: { notePath: "Welcome.md" }, boundElements: [{ id: "t1", type: "text" }] });
  const label = M.newElement("text", { id: "t1", x: 34, y: 414, text: "Welcome\nYour notes", originalText: "Welcome\nYour notes", containerId: "c1" });
  const sticky = M.newElement("rectangle", { id: "s1", x: 600, y: 10, width: 200, height: 200, customData: { sticky: true }, boundElements: [{ id: "t2", type: "text" }] });
  const note = M.newElement("text", { id: "t2", x: 610, y: 20, text: "welcome party", originalText: "welcome party", containerId: "s1" });
  const gone = M.newElement("text", { x: 0, y: 0, text: "welcome", originalText: "welcome", isDeleted: true });
  const els = [frame, card, label, sticky, note, gone];
  const hits = M.searchScene(els, "WELCOME");
  assert.deepEqual(hits.map((x) => [x.id, x.kind]), [["s1", "sticky"], ["c1", "note"]]);
  assert.deepEqual(M.searchScene(els, "sources").map((x) => x.kind), ["frame"]);
  assert.deepEqual(M.searchScene(els, "  "), []);
  const byId = new Map(els.map((e) => [e.id, e]));
  assert.ok(M.boundTextOf(card, byId));
  assert.deepEqual(M.outlineOf(els).map((x) => [x.kind, x.label]), [["frame", "Sources"], ["note", "Welcome"]]);
});

test("the curated palette is complete and valid", () => {
  for (const sw of M.SWATCHES) {
    assert.equal(sw.length, 4);
    for (const c of sw.slice(1)) assert.ok(M.parseColor(c), c);
  }
  for (const [c] of [...M.CANVAS_LIGHT, ...M.CANVAS_DARK]) assert.ok(c === null || M.parseColor(c), c);
  for (const c of [...M.STROKE_PICKS, ...M.BACKGROUND_PICKS, ...M.NEUTRALS]) assert.ok(M.parseColor(c), c);
});

test("a box cuts a stroke: the part in it, the parts on either side", () => {
  const r = M.splitFreedrawByBox(stroke(line(10, 100)), [30, -5, 60, 5]);
  assert.equal(r.inside.length, 1);
  assert.equal(r.outside.length, 2);
  assert.deepEqual(r.inside[0].points[0], [30, 0]);
  assert.deepEqual(r.inside[0].points.at(-1), [60, 0]);
  assert.deepEqual(r.outside[0].points.at(-1), [30, 0]); // the halves meet
  assert.equal(M.splitFreedrawByBox(stroke(line(10, 100)), [200, 0, 300, 10]), null);
});
