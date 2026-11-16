import { test } from "node:test";
import assert from "node:assert/strict";
import { chatHead } from "../aipop.js";
import { frontAccess } from "../proposals.js";

test("a thread about a private note is kept private, others stay plain", () => {
  const app = { proposals: { noteAccess: (p) => (p === "Secret/k.md" ? "private" : "review") } };
  assert.equal(frontAccess(chatHead(app, { path: "Secret/k.md" }) + "# Title\n"), "private");
  assert.equal(chatHead(app, { path: "a.md" }), "");
  assert.equal(chatHead(app, { path: null }), "");
});

test("a kept thread stays private after its note is renamed, moved or trashed", () => {
  let access = "private";
  const app = { proposals: { noteAccess: () => access } };
  const t = { path: "k.md" };
  chatHead(app, t);
  access = "review"; // the old path no longer reads as private
  assert.equal(frontAccess(chatHead(app, t) + "# Title\n"), "private");
});

test("the assistant leaves an open note that is not UTF-8 alone, and writes one that is", async () => {
  const { writeAsAi } = await import("../aiview.js");
  const toasts = [];
  const app = { toast: (m) => toasts.push(m), vault: { notes: new Map([["Old.md", { content: "\uFFFD\uFFFD\n" }], ["Good.md", { content: "fine\n" }]]) } };
  let ran = 0;
  assert.equal(await writeAsAi(app, "Old.md", "x", "write", "me", "why", () => { ran++; }), "private");
  assert.equal(ran, 0);
  assert.match(toasts[0], /left alone/);
  assert.equal(await writeAsAi(app, "Good.md", "x", "write", "me", "why", () => { ran++; }), "written");
  assert.equal(ran, 1);
});
