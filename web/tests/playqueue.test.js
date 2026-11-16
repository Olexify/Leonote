import test from "node:test";
import assert from "node:assert/strict";
import * as Q from "../playqueue.js";

test("insert before: the newcomer sits ahead of what is current, which stays current", () => {
  const q = Q.createQueue({ items: ["a", "b", "c"], index: 1 });
  assert.equal(Q.insert(q, ["x"], { before: true }), 1);
  assert.deepEqual(q.items, ["a", "x", "b", "c"]);
  assert.equal(Q.current(q), "b");
  Q.go(q, 1);
  assert.equal(q.items[Q.nextIndex(q)], "b");
});

test("insert at: picked songs line up ahead of the anchor, which stays current until gone to", () => {
  const q = Q.createQueue({ items: ["a", "b", "c"], index: 1 });
  Q.go(q, Q.insert(q, ["x1"], { at: q.items.indexOf("b") }));
  Q.go(q, Q.insert(q, ["x2"], { at: q.items.indexOf("b") }));
  assert.deepEqual(q.items, ["a", "x1", "x2", "b", "c"]);
  assert.equal(Q.current(q), "x2");
  assert.equal(q.items[Q.nextIndex(q)], "b");
});

test("a YouTube playlist brought up to date: new ones where YouTube has them, your order and the missing ones kept", () => {
  assert.deepEqual(Q.mergeYtList(["a", "b"], ["n", "a", "b"]), { items: ["n", "a", "b"], added: ["n"] });
  assert.deepEqual(Q.mergeYtList(["a", "b"], ["a", "b", "n", "m"]).items, ["a", "b", "n", "m"]);
  // your own order stays: the newcomer sits before the video that follows it on YouTube
  assert.deepEqual(Q.mergeYtList(["b", "a"], ["a", "n", "b"]).items, ["n", "b", "a"]);
  // gone from YouTube's list: kept, unless told to drop it
  assert.deepEqual(Q.mergeYtList(["a", "b", "c"], ["a", "c"]).items, ["a", "b", "c"]);
  assert.deepEqual(Q.mergeYtList(["a", "b", "c"], ["a", "c"], new Set(["b"])).items, ["a", "c"]);
  // taken out here: not brought back
  assert.deepEqual(Q.mergeYtList(["a"], ["a", "x"], new Set(), new Set(["x"])), { items: ["a"], added: [] });
  // twice in YouTube's list: once here
  assert.deepEqual(Q.mergeYtList(["a"], ["a", "n", "n"]).items, ["a", "n"]);
  // a newcomer before a skipped one lands before the next shared video
  assert.deepEqual(Q.mergeYtList(["a", "b"], ["a", "n", "x", "b"], new Set(), new Set(["x"])).items, ["a", "n", "b"]);
});
