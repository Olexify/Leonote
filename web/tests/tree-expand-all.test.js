// Expand all folders: the ones open before Collapse all, or every folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldersToExpand } from "../sidebar.js";

const ALL = new Set(["A", "A/b", "C", "D", "D/e"]);

test("by default it reopens the folders open before the collapse", () => {
  assert.deepEqual(foldersToExpand(["A", "D"], "previous", ALL), ["A", "D"]);
  assert.deepEqual(foldersToExpand(["A", "D"], undefined, ALL), ["A", "D"]);
});

test("one or none remembered: every folder", () => {
  assert.deepEqual(foldersToExpand(["A"], "previous", ALL), [...ALL]);
  assert.deepEqual(foldersToExpand([], "previous", ALL), [...ALL]);
  assert.deepEqual(foldersToExpand(undefined, "previous", ALL), [...ALL]);
});

test("folders gone since are dropped, and if that leaves one, every folder", () => {
  assert.deepEqual(foldersToExpand(["A", "Gone", "C"], "previous", ALL), ["A", "C"]);
  assert.deepEqual(foldersToExpand(["A", "Gone"], "previous", ALL), [...ALL]);
});

test("set to every folder: every folder whatever is remembered", () => {
  assert.deepEqual(foldersToExpand(["A", "D"], "all", ALL), [...ALL]);
  assert.deepEqual(foldersToExpand(["A", "D"], "all", [...ALL]), [...ALL]);
});
