import test from "node:test";
import assert from "node:assert/strict";
import { parseStatus } from "../projectview.js";

test("project: git status --porcelain -b, read", () => {
  const s = parseStatus("## main...origin/main [ahead 2, behind 1]\n M src/a.js\n?? new file.md\nR  old.js -> src/new.js\n");
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ["main", "origin/main", 2, 1]);
  assert.deepEqual(s.files.map((f) => f.path), ["src/a.js", "new file.md", "src/new.js"]);
  assert.equal(parseStatus("## No commits yet on trunk\n").branch, "trunk");
  assert.deepEqual(parseStatus("").files, []);
});
