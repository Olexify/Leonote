import { test } from "node:test";
import assert from "node:assert/strict";
import { slugTag, briefText, findProjects, membersOf, taskInProject, kindOf } from "../projectroom.js";

const note = (path, content = "", tags = []) => ({ path, content, tags });

test("findProjects: type: project at the top, one per folder, never the root", () => {
  const ps = findProjects([
    note("Thesis/Thesis.md", briefText("Thesis", slugTag("Thesis"))),
    note("Thesis/Other brief.md", "---\ntype: project\n---\n"),
    note("Root brief.md", "---\ntype: project\n---\n"),
    note("Trip/Plan.md", "---\ntype: Project\nname: Japan\ngoal: see Osaka\ntags: [japan, travel]\n---\n"),
    note("Ideas/a.md", "type: project"),
  ]);
  assert.deepEqual(ps.map((p) => [p.folder, p.name, p.tags.join(",")]), [["Trip", "Japan", "japan,travel"], ["Thesis", "Thesis", "thesis"]]);
});

test("membersOf: the folder, and notes elsewhere tagged like it (or under its tag)", () => {
  const p = { folder: "Thesis", tags: ["thesis"] };
  const m = membersOf(p, [note("Thesis/a.md"), note("Thesis/sub/b.md"), note("Thesis2/c.md"), note("Inbox/d.md", "", ["thesis/ch2"]), note("Inbox/e.md", "", ["thesisx"])], [{ path: "Thesis/x.pdf" }, { path: "Other/y.pdf" }]);
  assert.deepEqual(m.own.map((n) => n.path), ["Thesis/a.md", "Thesis/sub/b.md"]);
  assert.deepEqual(m.tagged.map((n) => n.path), ["Inbox/d.md"]);
  assert.deepEqual(m.files.map((f) => f.path), ["Thesis/x.pdf"]);
});

test("taskInProject: filed, tagged, or linking a project note", () => {
  const p = { folder: "Thesis", tags: ["thesis"] };
  const names = new Set(["walker 2017"]);
  assert.ok(taskInProject({ text: "x", project: "Thesis" }, p, names));
  assert.ok(taskInProject({ text: "read more #thesis" }, p, names));
  assert.ok(taskInProject({ text: "#thesis/ch2 outline" }, p, names));
  assert.ok(taskInProject({ text: "quote [[Walker 2017|Walker]]" }, p, names));
  assert.ok(!taskInProject({ text: "#thesisx" }, p, names));
  assert.ok(!taskInProject({ text: "#thesis", deleted: true }, p, names));
});

test("slugTag and kindOf", () => {
  assert.equal(slugTag("Sleep & Memory: Ch. 2"), "sleep-memory-ch-2");
  assert.equal(slugTag("Café"), "cafe");
  assert.equal(kindOf("a/b.canvas"), "boards");
  assert.equal(kindOf("a/b.PDF"), "sources");
  assert.equal(kindOf("a/b.mp3"), "media");
  assert.equal(kindOf("a/b.zip"), "other");
});

import { questionsIn, linkFacts, timelineOf } from "../projectroom.js";

test("questionsIn: ? lines and items under a Questions heading, not front matter, code, quotes or ticked", () => {
  const text = "---\ntitle: why?\n---\n# Brief\nDoes REM help recall?\n> quoted one?\n```\nnot this one?\n```\n## Open questions\n- How big was the sample\n- [x] Settled already\n- \n## Notes\n- plain item\nfine?";
  assert.deepEqual(questionsIn("a.md", text).map((q) => [q.line, q.text]), [[4, "Does REM help recall?"], [10, "How big was the sample"]]);
});

test("linkFacts: out, in, near and linked files", () => {
  const notes = [
    { path: "P/a.md", links: [{ target: "b" }, { target: "x.pdf" }] },
    { path: "P/b.md", links: [] },
    { path: "P/c.md", links: [] },
    { path: "O/o.md", links: [{ target: "c" }] },
    { path: "O/far.md", links: [] },
  ];
  const resolve = (t) => ({ b: "P/b.md", c: "P/c.md" })[t] || null;
  const f = linkFacts(notes, new Set(["P/a.md", "P/b.md", "P/c.md"]), resolve, (t) => (t === "x.pdf" ? { path: "P/x.pdf" } : null));
  assert.deepEqual([...f.out], ["P/a.md"]);
  assert.deepEqual([...f.in].sort(), ["P/b.md", "P/c.md"]);
  assert.deepEqual([...f.near], ["O/o.md"]);
  assert.deepEqual([...f.files], ["P/x.pdf"]);
});

test("timelineOf: newest first, done tasks twice, old ones cut", () => {
  const now = Date.parse("2026-10-02T12:00:00");
  const ev = timelineOf({
    notes: [{ path: "P/a.md", mtime: now - 1000 }],
    files: [{ path: "P/old.pdf", mtime: now - 100 * 86400000 }],
    tasks: [{ id: "t", text: "do", created: "2026-10-01T09:00:00", done: true, completed_at: "2026-10-02T08:00:00" }],
    chats: [{ id: "c", title: "Ask", at: now - 500 }],
  }, { since: now - 90 * 86400000 });
  assert.deepEqual(ev.map((e) => e.kind), ["chat", "note", "done", "task"]);
  assert.equal(ev[3].day, "2026-10-01");
});

import { sourceName, extFor, summaryPrompt } from "../projectroom.js";

test("sourceName and extFor", () => {
  assert.equal(sourceName("https://ex.com/papers/walker%202017.pdf"), "walker 2017.pdf");
  assert.equal(sourceName("https://ex.com/", ""), "ex.com");
  assert.equal(sourceName("https://ex.com/a", "Sleep: a review | Site..."), "Sleep a review Site");
  assert.equal(extFor("paper", "application/pdf"), ".pdf");
  assert.equal(extFor("paper.pdf", "application/pdf"), "");
});

test("summaryPrompt names the project's notes and asks for questions", () => {
  const t = summaryPrompt({ name: "Thesis", goal: "" }, ["Walker 2017", "REM"], { title: 'A "quoted" title', url: "https://x", text: "body" });
  assert.match(t, /Walker 2017; REM/);
  assert.match(t, /\(not written yet\)/);
  assert.match(t, /<source title="A 'quoted' title" url="https:\/\/x">\nbody\n<\/source>/);
  assert.match(t, /ending in "\?"/);
});

import { setFrontField, projectSummary } from "../projects.js";

test("setFrontField: replaces, adds, or makes the block", () => {
  assert.equal(setFrontField("---\ntype: project\nstatus: active\n---\n# A", "status", "done"), "---\ntype: project\nstatus: done\n---\n# A");
  assert.equal(setFrontField("---\ntype: project\n---\n# A", "status", "paused"), "---\ntype: project\nstatus: paused\n---\n# A");
  assert.equal(setFrontField("# A", "status", "done"), "---\nstatus: done\n---\n# A");
});

test("projectSummary: counts, overdue, questions, the strip and the due date", () => {
  const now = Date.parse("2026-10-02T12:00:00");
  const p = { folder: "T", tags: ["t"], due: "2026-10-07" };
  const s = projectSummary(p, {
    notes: [{ path: "T/a.md", content: "Why does it work?", tags: [], mtime: now - 3600000 }, { path: "T/src.md", content: "---\ntype: source\n---\n", tags: [], mtime: now - 3 * 86400000 }, { path: "X/b.md", content: "", tags: ["t"], mtime: now - 40 * 86400000 }],
    files: [{ path: "T/p.pdf", mtime: now - 86400000 }],
    tasks: [{ id: "1", text: "x #t", done: true, completed_at: "2026-10-02T09:00:00" }, { id: "2", text: "y #t", due_date: "2026-09-30" }, { id: "3", text: "z" }],
    now,
  });
  assert.deepEqual([s.notes, s.sources, s.tasks, s.done, s.overdue, s.questions, s.due], [3, 2, 2, 1, 1, 1, 5]);
  assert.equal(s.strip.length, 14);
  assert.equal(s.strip[13], 2); // a.md edited, task 1 done today
  assert.equal(s.last, now - 3600000);
});

test("an outside folder's workspace keeps the folder in its brief", () => {
  const [p] = findProjects([note("Workspaces/Films/Films.md", briefText("Films", "films", "E:\Media\Films"))]);
  assert.equal(p.folder, "Workspaces/Films");
  assert.equal(p.outside, "E:\Media\Films");
  assert.equal(findProjects([note("A/A.md", briefText("A", "a"))])[0].outside, "");
});

test("a room window's note editor is one flushSave finds, and its view is really destroyed", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  assert.ok(!/w\.doc\.loadingTask/.test(read("projectroom.js")), "w.doc comes from app.mountDoc and has only destroy()");
  const main = read("main.js");
  assert.match(main.slice(main.indexOf("function flushSave(p)"), main.indexOf("const flushAll")), /\.\.\.roomEds\]/);
  assert.match(main.slice(main.indexOf("app.mountDoc = "), main.indexOf("const routed = ")), /roomEds\.add\(ed\)/);
});

test("the workspace room sends no private note to the model: not a source, not a fellow note's name, not a private brief's goal or a question", async () => {
  const { askSummary, missingText } = await import("../projectroom.js");
  const sent = [];
  const app = {
    settings: { aiProviders: [{ id: "x", kind: "openai", model: "m" }], aiProvider: "x" },
    proposals: { noteAccess: (p) => (p.startsWith("Secret/") ? "private" : "review") },
    host: {
      handler: null,
      on(_, f) { this.handler = f; return Promise.resolve(); },
      aiChat(r) { sent.push(JSON.stringify(r)); this.handler({ id: r.id, type: "done" }); return Promise.resolve(); },
    },
  };
  const src = { title: "S", url: "", text: "source words" };
  await assert.rejects(askSummary(app, { name: "W", goal: "g", brief: "W/W.md" }, "Secret/S.md", [], src), /private/);
  assert.equal(sent.length, 0);
  await askSummary(app, { name: "Acme takeover", goal: "hidden goal", brief: "Secret/W.md" }, "W/S.md", [{ path: "W/Fine.md" }, { path: "Secret/Hidden name.md" }], src);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Fine/);
  assert.match(sent[0], /source words/);
  assert.doesNotMatch(sent[0], /Hidden name|hidden goal|Acme takeover/);
  const { missingPrompt, fitPrompt } = await import("../projectroom.js");
  const { scopeForAi } = await import("../aiview.js");
  const hidden = { name: "Acme takeover", folder: "W", brief: "Secret/W.md" };
  assert.doesNotMatch(missingPrompt(app, hidden, "x") + fitPrompt(app, hidden, "W/N.md"), /Acme takeover|brief is attached/);
  assert.match(missingPrompt(app, { ...hidden, brief: "W/W.md" }, "x"), /"Acme takeover" \(its brief is attached/);
  assert.match(fitPrompt(app, { ...hidden, brief: "W/W.md" }, "W/N.md"), /"Acme takeover"/);
  // the chat's system prompt names the project from this scope: a private folder is not named, a private brief's name is not used
  const chat = { ...app, projectAt: (f) => (f === "Work/Acme folder" ? { brief: "Secret/W.md" } : null), proposals: { noteAccess: (p, c) => (p.startsWith("Secret/") ? "private" : "review") } };
  assert.equal(scopeForAi(chat, { folder: "Secret/Acme", name: "Acme takeover" }), null);
  assert.deepEqual(scopeForAi(chat, { folder: "Work/Acme folder", name: "Acme takeover" }), { folder: "Work/Acme folder", name: "Acme folder" });
  assert.deepEqual(scopeForAi(chat, { folder: "Open", name: "Fine" }), { folder: "Open", name: "Fine" });
  const kept = (p) => p.startsWith("Secret/");
  const text = missingText([{ path: "Secret/Q.md", text: "the secret question?" }, { path: "W/Q.md", text: "plain?" }], [{ path: "Secret/Lone.md" }], [{ path: "Secret/f.pdf" }, { path: "W/g.pdf" }], kept);
  assert.match(text, /plain\?/);
  assert.match(text, /g\.pdf/);
  assert.doesNotMatch(text, /secret question|Lone|f\.pdf/);
});
