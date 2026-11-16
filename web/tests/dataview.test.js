import { test } from "node:test";
import assert from "node:assert/strict";
import { frontMatter, pageOf, pagesOf } from "../dataview.js";

test("dataview: front matter fields, lists and numbers", () => {
  const fm = frontMatter("---\nmood: 70\ntags: [daily, log]\naliases:\n  - Day one\ndone: true\n---\n# Body");
  assert.deepEqual(fm, { mood: 70, tags: ["daily", "log"], aliases: ["Day one"], done: true });
  assert.deepEqual(frontMatter("# no front matter"), {});
});

test("dataview: a note as a page - file facts, day from the name, tasks with their dates", () => {
  const p = pageOf({ path: "Diary/Daily Notes/2026-04-16.md", content: "---\nmood: 40\n---\n- [x] ran #sport ✅ 2026-04-16\n- [ ] read [due:: 2026-04-20]\n", tags: ["#journal"], mtime: Date.UTC(2026, 3, 16), ctime: Date.UTC(2026, 3, 16) });
  assert.equal(p.mood, 40);
  assert.equal(p.file.name, "2026-04-16");
  assert.equal(p.file.folder, "Diary/Daily Notes");
  assert.equal(p.file.day, "2026-04-16");
  assert.deepEqual(p.file.tags, ["#journal"]);
  assert.equal(p.file.tasks.length, 2);
  assert.equal(p.file.tasks[0].completed, true);
  assert.equal(p.file.tasks[0].completion, "2026-04-16");
  assert.deepEqual(p.file.tasks[0].tags, ["#sport"]);
  assert.equal(p.file.tasks[1].completed, false);
  assert.equal(p.file.tasks[1].due, "2026-04-20");
});

test("dataview: inline fields, on their own line or in brackets, under their plain names too", () => {
  const p = pageOf({ path: "Daily/2026-10-01.md", content: "mood:: 7\nSlept well [energy:: high] today\n- [ ] not a field:: here\n" });
  assert.equal(p.mood, 7);
  assert.equal(p.energy, "high");
  assert.equal(p.file.tasks.length, 1);
});

test("dataview: a frame gets no private note - not in dv.pages, not by dv.io.load, not in a query", async () => {
  const { framePages, frameLoad } = await import("../dataview.js");
  const fs = await import("node:fs");
  const note = (path, content) => [path, { path, content, tags: [], links: [], mtime: 1 }];
  const app = { vault: { notes: new Map([note("Open/a.md", "fine"), note("Secret/k.md", "the key"), note("Open/own.md", "---\nai: private\n---\nmine")]) } };
  app.proposals = { noteAccess: (p) => (p.startsWith("Secret/") || /ai: private/.test(app.vault.notes.get(p).content) ? "private" : "review") };
  assert.deepEqual(framePages(app, "js").map((p) => p.file.path), ["Open/a.md"]);
  assert.deepEqual(framePages(app, "dql").map((p) => p.file.path), ["Open/a.md"]);
  assert.equal(frameLoad(app, "Open/a.md"), "fine");
  assert.equal(frameLoad(app, "Secret/k.md"), null);
  assert.equal(frameLoad(app, "k"), null); // by its name too
  assert.equal(frameLoad(app, "own"), null);
  // and that code cannot run itself in a query's frame, where private notes are on show
  assert.match(fs.readFileSync(new URL("../dvframe.js", import.meta.url), "utf8"), /m\.type !== "dv-run" \|\| e\.source !== parent/);
});

test("pages follow a move that keeps every note's time (a folder renamed), and days are local", () => {
  const handlers = {};
  const notes = new Map([["Health/log.md", { path: "Health/log.md", content: "x", mtime: 5, ctime: 5, links: [], tags: [] }]]);
  const vault = { notes, bus: { on: (ev, f) => { (handlers[ev] = handlers[ev] || []).push(f); } } };
  assert.equal(pagesOf(vault)[0].file.path, "Health/log.md");
  const n = notes.get("Health/log.md");
  notes.delete("Health/log.md");
  notes.set("Private/Health/log.md", { ...n, path: "Private/Health/log.md" });
  for (const f of handlers.renamed || []) f({});
  assert.equal(pagesOf(vault)[0].file.path, "Private/Health/log.md");
  const late = new Date(2026, 10, 13, 1, 30).getTime();
  assert.equal(pageOf({ path: "a.md", content: "", mtime: late, ctime: late, links: [], tags: [] }).file.mday, "2026-11-13");
});
