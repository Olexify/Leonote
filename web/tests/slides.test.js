import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMods } from "../slides.js";

test("applyMods: PowerPoint's lighter, darker, tint, shade and alpha", () => {
  assert.equal(applyMods("FF0000"), "#FF0000");
  assert.equal(applyMods("FF0000", [["lumMod", 50000]]), "#800000"); // half as light
  assert.equal(applyMods("000000", [["lumMod", 75000], ["lumOff", 25000]]), "#404040");
  assert.equal(applyMods("4472C4", [["lumMod", 20000], ["lumOff", 80000]]), "#DAE3F3"); // Office's "accent 1, lighter 80%"
  assert.equal(applyMods("FFFFFF", [["shade", 50000]]), "#808080");
  assert.equal(applyMods("000000", [["tint", 50000]]), "#808080");
  assert.equal(applyMods("FF0000", [["alpha", 50000]]), "rgba(255, 0, 0, 0.5)");
});
