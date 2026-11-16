// Folder looks: readable text on any colour, fading inheritance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { textOn, folderLook } from "../treestyle.js";

const DARK_GROUND = [18, 18, 20];
const LIGHT_GROUND = [250, 250, 250];
const rgb = (s) => s.match(/\d+/g).map(Number);
const bright = ([r, g, b]) => (r + g + b) / 3 > 128;

test("textOn picks dark text on light colours and light text on dark ones", () => {
  assert.ok(!bright(textOn([245, 217, 10])), "yellow gets dark text");
  assert.ok(!bright(textOn([255, 255, 255])), "white gets dark text");
  assert.ok(bright(textOn([20, 30, 90])), "navy gets light text");
  assert.ok(bright(textOn([0, 0, 0])), "black gets light text");
});

test("a highlighted folder gets a background and readable text", () => {
  const l = folderLook({ color: "#f5d90a" }, null, DARK_GROUND);
  assert.ok(l.background, "has a background");
  assert.ok(!bright(rgb(l.color)), "yellow highlight uses dark text");
  const n = folderLook({ color: "#1e2a78" }, null, LIGHT_GROUND);
  assert.ok(bright(rgb(n.color)), "deep indigo uses light text");
});

test("subfolders fade toward the sidebar ground, level by level", () => {
  const parent = { color: "#e5484d" };
  const dist = (a) => Math.hypot(...rgb(a).map((v, i) => v - DARK_GROUND[i]));
  const own = folderLook(parent, null, DARK_GROUND).background;
  const d1 = folderLook(null, { style: parent, depth: 1 }, DARK_GROUND).background;
  const d3 = folderLook(null, { style: parent, depth: 3 }, DARK_GROUND).background;
  assert.ok(dist(own) > dist(d1) && dist(d1) > dist(d3), "each level is closer to the ground");
});

test("text-only mode colours the text and keeps it readable on the ground", () => {
  const l = folderLook({ color: "#111133", fill: false }, null, DARK_GROUND);
  assert.equal(l.background, undefined);
  assert.ok(bright(rgb(l.color)), "a very dark colour is lifted so it reads on a dark sidebar");
});

test("bold, dim and size need no colour", () => {
  const l = folderLook({ bold: true, dim: true, size: "l" }, null, DARK_GROUND);
  assert.equal(l.fontWeight, "700");
  assert.equal(l.opacity, "0.55");
  assert.match(l.fontSize, /\+ 2px/);
  assert.equal(l.background, undefined);
});

test("parseHex accepts pasted hex colours in the usual shapes", async () => {
  const { parseHex } = await import("../treestyle.js");
  assert.equal(parseHex("#3B9EFF"), "#3b9eff");
  assert.equal(parseHex("3b9eff"), "#3b9eff");
  assert.equal(parseHex(" #abc "), "#aabbcc");
  assert.equal(parseHex("fff"), "#ffffff");
  assert.equal(parseHex("#12345"), null);
  assert.equal(parseHex("rgb(1,2,3)"), null);
  assert.equal(parseHex(""), null);
});

test("italic is part of a folder's look", () => {
  assert.equal(folderLook({ italic: true }, null, [18, 18, 20]).fontStyle, "italic");
});

test("hsv and hex convert both ways", async () => {
  const { hsvToHex, hexToHsv } = await import("../treestyle.js");
  assert.equal(hsvToHex(0, 1, 1), "#ff0000");
  assert.equal(hsvToHex(120, 1, 1), "#00ff00");
  assert.equal(hsvToHex(0, 0, 1), "#ffffff");
  assert.equal(hsvToHex(0, 0, 0), "#000000");
  for (const c of ["#3b9eff", "#e5484d", "#46a758", "#ecece7", "#6e56cf"]) assert.equal(hsvToHex(...hexToHsv(c)), c);
});
