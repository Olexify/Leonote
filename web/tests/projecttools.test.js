import { test } from "node:test";
import assert from "node:assert/strict";
import { projectPath, replaceOnce } from "../aiview.js";

test("projectPath: inside the folder, a note, no way out", () => {
  assert.equal(projectPath("Thesis", "Thesis/ch2.md"), "Thesis/ch2.md");
  assert.equal(projectPath("Thesis", "ch2"), "Thesis/ch2.md");
  assert.equal(projectPath("Thesis", "/Thesis/sub/a"), "Thesis/sub/a.md");
  assert.equal(projectPath("Thesis", "Other/x.md"), "Thesis/Other/x.md");
  for (const bad of ["../x.md", "Thesis/../x.md", "C:/x.md", "Thesis/.trash/x.md", ".leonote/x", ""]) assert.throws(() => projectPath("Thesis", bad), bad);
});

test("replaceOnce: exactly one place", () => {
  assert.equal(replaceOnce("a b c", "b", "B"), "a B c");
  assert.throws(() => replaceOnce("a b c", "x", "y"), /not in the note/);
  assert.throws(() => replaceOnce("b a b", "b", "y"), /more than once/);
  assert.throws(() => replaceOnce("abc", "", "y"), /empty/);
});

import { runVaultTool } from "../aiview.js";

test("the chat's read tools skip private notes", () => {
  const notes = new Map([["a.md", { path: "a.md", content: "apple pie", mtime: 2 }], ["Secret/k.md", { path: "Secret/k.md", content: "apple key 123", mtime: 3 }], ["b.md", { path: "b.md", content: "---\nai: private\n---\napple", mtime: 1 }]]);
  const app = {
    vault: { notes, get: (p) => notes.get(p), resolve: () => null },
    tasks: { all: [] },
    proposals: { noteAccess: (p, c) => (p.startsWith("Secret/") || /ai: private/.test(c || "") ? "private" : "review") },
  };
  assert.match(runVaultTool(app, "search_notes", { query: "apple" }).text, /^1 note matches/);
  assert.doesNotMatch(runVaultTool(app, "list_notes", {}).text, /Secret|b\.md/);
  assert.throws(() => runVaultTool(app, "read_note", { path: "Secret/k.md" }), /private/);
  assert.equal(runVaultTool(app, "read_note", { path: "a.md" }).text, "apple pie");
});

test("with the tasks split, the chat sees only AI's tasks", () => {
  const app = { vault: { notes: new Map() }, tasks: { all: [{ text: "call mum" }, { text: "tidy inbox", owner: "ai" }, { text: "old", owner: "ai", done: true }] }, proposals: { noteAccess: () => "review", tasksSplit: () => true } };
  const seen = runVaultTool(app, "list_tasks", {}).text;
  assert.match(seen, /tidy inbox/);
  assert.doesNotMatch(seen, /call mum|old/);
  app.proposals.tasksSplit = () => false;
  assert.match(runVaultTool(app, "list_tasks", {}).text, /call mum/);
});

test("projectPath with full access: anywhere in the vault, still no way out", () => {
  assert.equal(projectPath("", "Ideas/x"), "Ideas/x.md");
  assert.equal(projectPath("", "/a.md"), "a.md");
  for (const bad of ["../x.md", ".trash/x.md", "C:/x.md"]) assert.throws(() => projectPath("", bad), bad);
});
