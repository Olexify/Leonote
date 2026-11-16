// Quick add: "you did something like this before".
import { test } from "node:test";
import assert from "node:assert/strict";
import { similarTasks } from "../taskstore.js";

const tasks = [
  { id: "1", text: "Set up dev profile", subtasks: [{ text: "install", done: true }], done: true },
  { id: "2", text: "Set up dev machine at home", subtasks: [] },
  { id: "3", text: "Buy milk" },
  { id: "4", text: "old profile notes", deleted: true },
];

test("similar tasks: word overlap, steps win ties, deleted skipped", () => {
  const hits = similarTasks("set up dev profile for laptop", tasks);
  assert.equal(hits[0].id, "1");
  assert.ok(hits.some((t) => t.id === "2"));
  assert.ok(!hits.some((t) => t.id === "4"));
  assert.deepEqual(similarTasks("xyzzy", tasks), []);
  assert.deepEqual(similarTasks("a", tasks), []);
  assert.equal(similarTasks("buy milk", tasks, { limit: 1 })[0].id, "3");
  assert.deepEqual(similarTasks("set up dev profile", tasks, { self: "1" }).map((t) => t.id), ["2"]);
});
