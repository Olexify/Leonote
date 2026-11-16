// Notes in folders left out of indexing: known by path only, so links to them still lead somewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVault } from "../vault.js";

test("a link to a not-indexed note finds it, by name or by path", () => {
  const v = createVault({});
  assert.equal(v.unindexedFor("Chat log"), null);
  v.setUnindexed(["Claude/Chats/Chat log.md", "Claude/Other/Chat log.md", "Claude/notes.md"]);
  assert.equal(v.unindexedFor("Chat log"), "Claude/Chats/Chat log.md");
  assert.equal(v.unindexedFor("Other/Chat log|alias"), "Claude/Other/Chat log.md");
  assert.equal(v.unindexedFor("notes.md#Heading"), "Claude/notes.md");
  assert.equal(v.unindexedFor("Nowhere"), null);
});

test("a unique path keeps the kind of file asked for: a .txt note moved stays .txt", () => {
  const v = createVault({});
  assert.equal(v.uniquePath("Inbox", "readme", ".txt"), "Inbox/readme.txt");
  assert.equal(v.uniquePath("Inbox", "readme"), "Inbox/readme.md");
  assert.equal(v.uniquePath("Inbox", "C# tips"), "Inbox/C# tips.md", "a moved note keeps its own name");
});
