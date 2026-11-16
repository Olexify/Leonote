// Note ids and header tags: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { frontTags, setFrontTags, newId } from "../noteids.js";
import { parseNote } from "../mdparse.js";

test("frontTags: every way tags are written in a header", () => {
  assert.deepEqual(frontTags("---\ntags: [a, b]\n---\nx"), ["a", "b"]);
  assert.deepEqual(frontTags("---\ntags:\n  - a\n  - \"b\"\n---\nx"), ["a", "b"]);
  assert.deepEqual(frontTags("---\ntags: a, #b\n---\nx"), ["a", "b"]);
  assert.deepEqual(frontTags("no header #c"), []);
});

test("setFrontTags: one line, other keys kept, the header made or dropped as needed", () => {
  assert.equal(setFrontTags("Body", ["a"]), "---\ntags: [a]\n---\nBody");
  assert.equal(setFrontTags("---\nid: x1\ntags:\n  - a\n---\nBody", ["a", "b"]), "---\nid: x1\ntags: [a, b]\n---\nBody");
  assert.equal(setFrontTags("---\nid: x1\ntags: [a]\n---\nBody", []), "---\nid: x1\n---\nBody");
  assert.equal(setFrontTags("---\ntags: [a]\n---\nBody", []), "Body");
});

test("ids: read from the header; new ones differ", () => {
  assert.equal(parseNote("---\nid: abc123\n---\ntext").id, "abc123");
  assert.equal(parseNote("---\ntitle: x\n---\nid: nope").id, null);
  assert.notEqual(newId(), newId());
});
