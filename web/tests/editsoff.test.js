import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDoc, serializeDoc, emptyDoc } from "../imageeditmodel.js";

test("edits off: remembered in the sidecar, absent when on", () => {
  const d = { ...emptyDoc(10, 10), off: true };
  const text = serializeDoc(d, { image: "a.png" });
  assert.equal(JSON.parse(text).off, true);
  assert.equal(normalizeDoc(text).off, true);
  assert.equal("off" in JSON.parse(serializeDoc(emptyDoc(10, 10))), false);
  assert.equal(normalizeDoc("{}").off, false);
});
