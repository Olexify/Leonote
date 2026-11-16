// Quick switcher filters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExt, kindOf } from "../palette.js";

test("parseExt pulls file types out of the query", () => {
  assert.deepEqual([...parseExt("ext:pdf report").exts], ["pdf"]);
  assert.equal(parseExt("ext:pdf report").rest, "report");
  assert.deepEqual([...parseExt(".png .JPG cat").exts], ["png", "jpg"]);
  assert.equal(parseExt(".png .JPG cat").rest, "cat");
  assert.deepEqual([...parseExt("ext:png,webp").exts], ["png", "webp"]);
  assert.equal(parseExt("plain words").exts.size, 0);
  assert.equal(parseExt("v1.2 notes").exts.size, 0, "a dot inside a word is not a filter");
});

test("kindOf sorts files into switcher kinds", () => {
  assert.equal(kindOf({ path: "Boards/Plan.canvas", kind: "text" }), "board");
  assert.equal(kindOf({ path: "a/Draw.excalidraw", kind: "text" }), "sketch");
  assert.equal(kindOf({ path: "x.py", kind: "text" }), "code");
  assert.equal(kindOf({ path: "p.webp", kind: "image" }), "image");
  assert.equal(kindOf({ path: "d.pdf", kind: "pdf" }), "pdf");
});
