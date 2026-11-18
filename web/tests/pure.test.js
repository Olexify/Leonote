// Pure-module tests: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, excerpt, rewriteLinks, toggleTaskLine } from "../mdparse.js";
import { fuzzy, parseQuery, searchVault } from "../search.js";
import { parseQuickAdd, parseDateWord } from "../taskstore.js";
import { safeName, basename, dirname, localIso, plainError } from "../util.js";

test("parseNote: links, aliases, headings, tags", () => {
  const n = parseNote("# Title\nSee [[Other note|alias]] and [[Folder/Deep#Section]].\n#idea #work/plan #123 not-a#tag\n- [ ] one\n- [x] two\n");
  assert.deepEqual(n.links.map((l) => l.target), ["Other note", "Folder/Deep"]);
  assert.deepEqual(n.headings, [{ level: 1, text: "Title", line: 0 }]);
  assert.deepEqual(n.tags.sort(), ["idea", "work/plan"]);
  assert.equal(n.tasks, 2);
  assert.equal(n.done, 1);
});

test("parseNote: code is not scanned for links or tags", () => {
  const n = parseNote("```\n[[not a link]] #nope\n```\n`[[inline]] #nope2`\n[[real]]");
  assert.deepEqual(n.links.map((l) => l.target), ["real"]);
  assert.deepEqual(n.tags, []);
});

test("parseNote: frontmatter tags, both styles", () => {
  assert.deepEqual(parseNote("---\ntags: [a, \"b\"]\n---\nbody").tags.sort(), ["a", "b"]);
  assert.deepEqual(parseNote("---\ntitle: x\ntags:\n  - one\n  - two\n---\n").tags.sort(), ["one", "two"]);
});

test("parseNote: Cyrillic tags and words", () => {
  const n = parseNote("Привіт світ #нотатки");
  assert.deepEqual(n.tags, ["нотатки"]);
  assert.equal(n.words, 3);
});

test("rewriteLinks keeps heading and alias", () => {
  const r = rewriteLinks("[[Old]] [[old#H|see]] [[Other]]", (t) => t.toLowerCase() === "old", "New");
  assert.equal(r.content, "[[New]] [[New#H|see]] [[Other]]");
  assert.equal(r.changed, 2);
});

test("toggleTaskLine", () => {
  assert.equal(toggleTaskLine("  - [ ] do it"), "  - [x] do it");
  assert.equal(toggleTaskLine("1. [x] done"), "1. [ ] done");
  assert.equal(toggleTaskLine("plain"), null);
});

test("excerpt strips markdown", () => {
  assert.equal(excerpt("# Head\n\n- [ ] Buy **milk** from [[Shop|the shop]]"), "Head · Buy milk from the shop");
});

test("excerpt reads a table as its words", () => {
  assert.equal(excerpt("| Keys | Does |\n|:---|---:|\n| Ctrl+P | Commands |"), "Keys · Does · Ctrl+P · Commands");
});

test("fuzzy: substring beats scattered, word starts score", () => {
  const a = fuzzy("road", "Leonote roadmap");
  const b = fuzzy("road", "r o a d scattered");
  assert.ok(a && b && a.score > b.score);
  assert.equal(fuzzy("xyz", "abc"), null);
  assert.ok(fuzzy("lnr", "Leonote roadmap"));
});

test("parseQuery: terms, phrases, tags, paths, negation", () => {
  assert.deepEqual(parseQuery('foo "bar baz" #tag path:ideas -nope'), { terms: ["foo", "bar baz"], raw: ["foo", "bar baz"], not: ["nope"], tags: ["tag"], paths: ["ideas"], notTags: [], notPaths: [] });
  // - before a tag or a folder leaves those notes out, and a quoted folder name is taken whole
  const q = parseQuery('meeting -#done -path:archive path:"Work notes" tag:"to do"');
  assert.deepEqual([q.terms, q.tags, q.paths, q.notTags, q.notPaths], [["meeting"], ["to do"], ["work notes"], ["done"], ["archive"]]);
  const notes = [
    { path: "Work notes/a.md", title: "a", content: "meeting", lower: "meeting", tags: ["to do"] },
    { path: "Work notes/b.md", title: "b", content: "meeting", lower: "meeting", tags: ["to do", "done"] },
    { path: "Work notes/archive/c.md", title: "c", content: "meeting", lower: "meeting", tags: ["to do"] },
  ];
  assert.deepEqual(searchVault(notes, 'meeting -#done -path:archive path:"Work notes" tag:"to do"').map((r) => r.note.path), ["Work notes/a.md"]);
});

test("searchVault ranks title matches and snippets carry offsets", () => {
  const mk = (path, content) => ({ path, title: basename(path), content, lower: content.toLowerCase(), tags: parseNote(content).tags, mtime: 0 });
  const notes = [mk("a.md", "nothing here\nbut apple is here"), mk("Apple.md", "fruit")];
  const r = searchVault(notes, "apple");
  assert.equal(r[0].note.path, "Apple.md");
  const s = r[1].snippets[0];
  assert.equal(notes[0].content.slice(s.offset, s.offset + 5), "apple");
  assert.equal(searchVault(notes, "#none").length, 0);
});

test("parseQuickAdd", () => {
  const now = new Date(2026, 8, 14); // Monday
  const p = parseQuickAdd("water the plants !h @tomorrow ^fri", now);
  assert.equal(p.text, "water the plants");
  assert.equal(p.priority, "high");
  assert.equal(p.due_date, "2026-09-15");
  assert.equal(p.start_date, "2026-09-18");
  assert.equal(parseQuickAdd("email bob@example.com", now).text, "email bob@example.com");
  assert.equal(parseDateWord("mon", now), "2026-09-21");
  assert.equal(parseDateWord("+3", now), "2026-09-17");
  assert.equal(parseDateWord("2026-02-28", now), "2026-02-28");
  assert.equal(parseDateWord("2026-02-30", now), null, "a day that does not exist");
  assert.equal(parseDateWord("2026-13-45", now), null);
  assert.equal(parseDateWord("friday", now), "2026-09-18");
  assert.equal(parseQuickAdd("call @friend", now).text, "call @friend");
});

test("parseQuickAdd files a task under a focus area only when one matches", () => {
  const areas = [{ id: "b", title: "Business" }, { id: "j", title: "Japan Travel" }];
  const find = (n) => areas.find((a) => a.title.toLowerCase().replace(/\s+/g, "").startsWith(n.toLowerCase()));
  const p = parseQuickAdd("call bank +busi !h", new Date(2026, 8, 14), find);
  assert.equal(p.text, "call bank");
  assert.equal(p.focus_id, "b");
  assert.equal(p.priority, "high");
  assert.equal(parseQuickAdd("book +japantravel", new Date(), find).focus_id, "j");
  const none = parseQuickAdd("learn C++ and +1 idea", new Date(), find);
  assert.equal(none.text, "learn C++ and +1 idea");
  assert.equal(none.focus_id, null);
});

test("safeName and paths", () => {
  assert.equal(safeName('a/b:c*?"<>|'), "a b c");
  assert.equal(safeName("  ...  "), "Untitled");
  assert.equal(safeName("C# [draft] ^1"), "C draft 1", "a link could not reach a name with # [ ] ^");
  assert.equal(safeName("x".repeat(300)).length, 200, "kept under Windows' 255 with a stamp around it");
  assert.equal(basename("x/y/Note.md"), "Note");
  assert.equal(dirname("x/y/Note.md"), "x/y");
});

test("localIso is local wall-clock, not UTC", () => {
  const d = new Date(2026, 0, 2, 3, 4, 5, 6);
  assert.equal(localIso(d), "2026-01-02T03:04:05.006");
});

test("moveLinkFolder: links into a renamed folder follow it, the rest stay", async () => {
  const { moveLinkFolder } = await import("../mdparse.js");
  const src = "See [[Diary/2026-09-01]], [[diary/Notes/x#Top|here]], ![[Diary/pic.png|300]], [a](Diary/My%20day.md), [[Diaryish/y]] and [[Other/Diary/z]].";
  const r = moveLinkFolder(src, "Diary", "Journal");
  assert.equal(r.content, "See [[Journal/2026-09-01]], [[Journal/Notes/x#Top|here]], ![[Journal/pic.png|300]], [a](Journal/My%20day.md), [[Diaryish/y]] and [[Other/Diary/z]].");
  assert.equal(r.changed, 4);
  assert.equal(moveLinkFolder("[[My Stuff/a]] [b](My%20Stuff/c.md)", "My Stuff", "Stuff").content, "[[Stuff/a]] [b](Stuff/c.md)");
});

test("unmark: search previews lose the ==highlight== marks, hits stay on their words", async () => {
  const { unmark } = await import("../search.js");
  const r = unmark("a ==big== idea", [[4, 7]]);
  assert.equal(r.text, "a big idea");
  assert.deepEqual(r.ranges, [[2, 5]]);
  assert.deepEqual(unmark("plain", [[0, 5]]), { text: "plain", ranges: [[0, 5]] });
});

test("filterTasks: by status, words (steps too), priority and when - newest first, purged never", async () => {
  const { filterTasks } = await import("../taskstore.js");
  const now = new Date("2026-09-28T12:00:00");
  const T = [
    { id: "a", text: "Write the report", created: "2026-09-27T10:00:00", done: false, deleted: false, priority: "high" },
    { id: "b", text: "Buy bread", created: "2026-01-05T10:00:00", done: true, completed_at: "2026-09-26T09:00:00", deleted: false, priority: "none", subtasks: [{ text: "rye report" }] },
    { id: "c", text: "Old thing", created: "2025-03-01T10:00:00", done: true, completed_at: "2025-03-02T10:00:00", deleted: false, priority: "low" },
    { id: "d", text: "Trashed report", created: "2026-09-20T10:00:00", done: false, deleted: true, deleted_at: "2026-09-22T10:00:00", priority: "none" },
    { id: "e", text: "Gone report", created: "2026-09-20T10:00:00", done: false, deleted: true, purged: true },
  ];
  const ids = (o) => filterTasks(T, o, now).map((t) => t.id);
  assert.deepEqual(ids({ words: ["report"] }), ["a", "d", "b"]);
  assert.deepEqual(ids({ status: "active" }), ["a"]);
  assert.deepEqual(ids({ status: "resolved", when: "resolved" }), ["b", "c"]);
  assert.deepEqual(ids({ status: "trashed" }), ["d"]);
  assert.deepEqual(ids({ when: "resolved", period: "7" }), ["b", "d"]);
  assert.deepEqual(ids({ period: "year" }), ["a", "d", "b"]);
  assert.deepEqual(ids({ when: "resolved", period: "2025-03" }), ["c"]);
  assert.deepEqual(ids({ priority: "high" }), ["a"]);
});

test("countUse: opens count and fade by half every two weeks; the weakest go past the cap", async () => {
  const { countUse, usageScore } = await import("../home.js");
  const day = 86400000, t0 = 1_800_000_000_000;
  let u = countUse({}, "a.md", t0);
  u = countUse(u, "a.md", t0);
  assert.equal(Math.round(usageScore(u["a.md"], t0) * 100) / 100, 2);
  assert.equal(Math.round(usageScore(u["a.md"], t0 + 14 * day) * 100) / 100, 1);
  let many = {};
  for (let i = 0; i < 5; i++) many = countUse(many, "f" + i, t0 + i * day, 3);
  assert.deepEqual(Object.keys(many).sort(), ["f2", "f3", "f4"]);
});

test("parsePsd: a hand-made Photoshop file - its layer (Unicode name, place, pixels) and the RLE-packed merged picture", async () => {
  const { parsePsd, compositeBlank, shownLayers } = await import("../psd.js");
  const b = [];
  const u8 = (v) => b.push(v & 255);
  const u16 = (v) => { u8(v >> 8); u8(v); };
  const u32 = (v) => { u16(v >>> 16); u16(v & 0xffff); };
  const str = (s) => { for (const ch of s) u8(ch.charCodeAt(0)); };
  // header: RGBA 2×2, 8 bit, RGB
  str("8BPS"); u16(1); for (let i = 0; i < 6; i++) u8(0); u16(4); u32(2); u32(2); u16(8); u16(3);
  u32(0); u32(0); // colour mode data, image resources
  // one layer at (1,0), 1×2, red with half alpha on the second pixel
  const rec = [];
  const layer = () => {
    const out = [];
    const o8 = (v) => out.push(v & 255), o16 = (v) => { o8(v >> 8); o8(v); }, o32 = (v) => { o16(v >>> 16); o16(v & 0xffff); }, os = (s) => { for (const ch of s) o8(ch.charCodeAt(0)); };
    o16(-1 & 0xffff); // one layer, the merged picture's extra channel is its transparency
    o32(0); o32(1); o32(2); o32(2); // top left bottom right
    o16(4); for (const id of [-1, 0, 1, 2]) { o16(id & 0xffff); o32(2 + 2); }
    os("8BIM"); os("mul "); o8(128); o8(0); o8(0); o8(0);
    o32(4 + 4 + 4 + 26); o32(0); o32(0); o8(2); os("L1"); o8(0);
    os("8BIM"); os("luni"); o32(4 + 10); o32(5); for (const ch of "Layer") o16(ch.charCodeAt(0));
    // channel data, raw: alpha, red, green, blue (1×2 each)
    for (const plane of [[255, 128], [255, 255], [0, 0], [0, 0]]) { o16(0); o8(plane[0]); o8(plane[1]); }
    return out;
  };
  const li = layer();
  u32(4 + li.length + 4); u32(li.length); b.push(...li); u32(0);
  // merged picture, RLE: 4 channels × 2 rows, each row "1" then two literal bytes
  u16(1); for (let i = 0; i < 8; i++) u16(3);
  for (const plane of [[10, 20, 30, 40], [50, 60, 70, 80], [90, 100, 110, 120], [255, 255, 255, 0]]) { u8(1); u8(plane[0]); u8(plane[1]); u8(1); u8(plane[2]); u8(plane[3]); }
  const psd = parsePsd(new Uint8Array(b));
  assert.equal(psd.width, 2); assert.equal(psd.height, 2);
  assert.equal(psd.layers.length, 1);
  const L = psd.layers[0];
  assert.equal(L.name, "Layer"); assert.equal(L.left, 1); assert.equal(L.width, 1); assert.equal(L.height, 2);
  assert.equal(L.blend, "multiply"); assert.ok(Math.abs(L.opacity - 128 / 255) < 1e-9); assert.equal(L.visible, true);
  assert.deepEqual([...L.pixels], [255, 0, 0, 255, 255, 0, 0, 128]);
  assert.deepEqual([...psd.composite.slice(0, 8)], [10, 50, 90, 255, 20, 60, 100, 255]);
  assert.equal(psd.composite[15], 0, "the merged transparency is read");
  assert.equal(compositeBlank(psd), false);
  // a hidden group hides what is in it
  assert.deepEqual(shownLayers([{ section: 3, visible: true }, { section: 0, visible: true }, { section: 1, visible: false }, { section: 0, visible: true }]), [true, false, false, true]);
  assert.throws(() => parsePsd(new Uint8Array([1, 2, 3, 4])), /not a Photoshop file/);
});

test("Studio rulers: a readable tick step, lengths in px/cm/in, and snapping", async () => {
  const { niceStep, inUnit, snap } = await import("../paintmeasure.js");
  assert.equal(niceStep(1), 100);        // 1 screen px per unit: 100 apart
  assert.equal(niceStep(0.5), 200);
  assert.equal(niceStep(10), 10);
  assert.equal(niceStep(100), 1);
  assert.equal(inUnit(144, "px", 144), "144 px");
  assert.equal(inUnit(144, "in", 144), "1.00 in");
  assert.equal(inUnit(144, "cm", 144), "2.54 cm");
  assert.equal(snap(505, [{ at: 0 }, { at: 512 }, { at: 1024 }], 8), 512);
  assert.equal(snap(490, [{ at: 0 }, { at: 512 }], 8), 490);
});

test("brush tips: the new ones lay down paint, and the nib is thick one way, thin the other", async () => {
  const B = await import("../paintbrush.js");
  for (const tip of ["nib", "hatch", "sponge", "weave", "stipple"]) {
    const m = B.tipMask(tip, 32, 0.8, 7);
    assert.ok(m.some((v) => v > 0), tip + " paints");
  }
  const m = B.tipMask("nib", 33, 0.9, 1), n = 33, at = (x, y) => m[y * n + x];
  // along its 45° axis the nib reaches the edge; across it, it stays thin
  assert.ok(at(25, 25) > 0 && at(7, 7) > 0, "the long way");
  assert.equal(at(25, 7), 0, "the short way");
  assert.ok(B.PRESETS.length >= 38 && B.PRESET_BY_ID.has("nib") && B.PRESET_BY_ID.has("sponge"));
});

test("Docs: blanks found once each, filled where given, front matter never copied", async () => {
  const { blanksIn, fillBlanks, bodyOf } = await import("../docsview.js");
  const t = "Dear {{ name }},\nI apply to {{company}} on {{date}}. {{company}} is great.";
  assert.deepEqual(blanksIn(t), ["name", "company", "date"]);
  assert.equal(fillBlanks(t, { name: "Ana", company: "Acme", date: "" }), "Dear Ana,\nI apply to Acme on {{date}}. Acme is great.");
  assert.equal(bodyOf("---\ntags: x\n---\n\nHello\n\n"), "Hello");
  assert.equal(bodyOf("No front matter"), "No front matter");
});

test("parseNote: a fence closes only on a matching one - tags in nested code are not tags", () => {
  const n = parseNote("````\n```dataview\nFROM #book\n```\n````\nreal #tag\n```js\n#nope\n```\n");
  assert.deepEqual(n.tags, ["tag"]);
});

import { lineDiff, diffRows } from "../proposals.js";
test("lineDiff: kept, removed and added lines in order; long unchanged runs fold", () => {
  const d = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(d.map((r) => r.op + r.t), ["=a", "-b", "+B", "=c", "=d", "+e"]);
  assert.deepEqual(lineDiff("", "x").map((r) => r.op + r.t), ["-", "+x"]);
  const many = Array.from({ length: 20 }, (_, i) => "l" + i).join("\n");
  const rows = diffRows(lineDiff(many, many.replace("l10", "X")));
  assert.equal(rows[0].op, "…");
  assert.ok(rows.some((r) => r.op === "+" && r.t === "X"));
  assert.equal(rows.filter((r) => r.op === "=").length, 6);
});

import { parseStep, parseSkill, fill, holds, parseTrigger, ACTIONS } from "../skills.js";
test("skills: steps, the skill note, templates, conditions and triggers", () => {
  assert.deepEqual(parseStep('note.append path="Daily/{{today}}.md" text="a\nb" → out'), { action: "note.append", args: { path: "Daily/{{today}}.md", text: "a\nb" }, out: "out" });
  assert.deepEqual(parseStep("tasks.list which=open -> open"), { action: "tasks.list", args: { which: "open" }, out: "open" });
  assert.ok(parseStep("1 2 3").error);
  const sk = parseSkill("---\ntype: skill\nname: Morning\ntrigger: daily 08:00\ninputs: topic, place\n---\n# x\n1. tasks.list which=done-yesterday → done\n2. nope.nothing a=1\ntext, not a step\n", "Skills/Morning.md");
  assert.equal(sk.name, "Morning");
  assert.deepEqual(sk.inputs, ["topic", "place"]);
  assert.equal(sk.steps.length, 2);
  assert.match(sk.errors[0], /no action called nope.nothing/);
  const now = new Date(2026, 9, 2, 9, 5);
  assert.equal(fill("{{yesterday}} {{done}} {{input.topic}} {{missing}}", { done: ["a", "b"], input: { topic: "x" } }, now), "2026-10-01 - a\n- b x ");
  assert.equal(holds("yes == YES"), true);
  assert.equal(holds("a != a"), false);
  assert.equal(holds("no"), false);
  assert.equal(holds("not "), true);
  assert.deepEqual(parseTrigger("daily 7:30"), { kind: "daily", h: 7, m: 30 });
  assert.deepEqual(parseTrigger('new note in "Inbox/"'), { kind: "newnote", folder: "Inbox" });
  assert.deepEqual(parseTrigger("whenever"), { kind: "manual" });
});

test("a table cell's link cannot add attributes to the page", async () => {
  const { tableCellHtml } = await import("../mdparse.js");
  const html = tableCellHtml('[x](https://a"onmouseover="window.__pwned=1")');
  assert.ok(!html.includes('"onmouseover'), html);
  assert.equal(tableCellHtml("[site](https://example.com/a?b=1) **b** `c`"),
    '<a data-url="https://example.com/a?b=1">site</a> <b>b</b> <code>c</code>');
});

test("a Windows path written in a note is found whole, spaces and all, and ends where the sentence goes on", async () => {
  const { writtenPath } = await import("../mdparse.js");
  const at = (t) => writtenPath(t, t.search(/[A-Za-z]:\\/));
  assert.equal(at(String.raw`see G:\Data\Notes\Sam\Stuff\Work Space\Chat Logs. Then more`), String.raw`G:\Data\Notes\Sam\Stuff\Work Space\Chat Logs`);
  assert.equal(at(String.raw`(C:\Program Files\App) and D:\x`), String.raw`C:\Program Files\App`);
  assert.equal(at(String.raw`C:\a b\c D:\other`), String.raw`C:\a b\c`);
  assert.equal(at(String.raw`"E:\Code\my app", next`), String.raw`E:\Code\my app`);
  assert.equal(at(String.raw`E:\v1.2\file.txt, done`), String.raw`E:\v1.2\file.txt`);
});

test("a bug report says where things are, not who the user is", async () => {
  const { anonymise } = await import("../support.js");
  const vault = String.raw`G:\Data\Notes\Sam`;
  assert.equal(anonymise(String.raw`Vault G:\Data\Notes\Sam · 6 notes`, vault), "Vault <vault> · 6 notes");
  assert.equal(anonymise("open G:/Data/Notes/Sam/Diary/a.md failed", vault), "open <vault>/Diary/a.md failed");
  assert.equal(anonymise(String.raw`read C:\Users\Alex\Downloads\x.csv: denied`), String.raw`read C:\Users\<you>\Downloads\x.csv: denied`);
  assert.equal(anonymise("/home/sam/notes"), "/home/<you>/notes");
});

test("a link card's picture is never one on this computer or the local network", async () => {
  const { cardPicture: c } = await import("../livepreview.js");
  const page = "https://site.org/a/b";
  for (const bad of ["http://localhost:9000/api/stop", "//127.0.0.1:9000/x", "http://2130706433/x", "http://0x7f.1/x", "http://[::1]/x", "http://[::ffff:127.0.0.1]/x",
    "http://192.168.1.1/x", "http://172.20.0.1/x", "http://printer/x", "http://nas.local/x", "http://asset.localhost/C:/x.png", "\\\\127.0.0.1\\x", "file:///C:/x.png"]) assert.equal(c(bad, page), "", bad);
  assert.equal(c("https://cdn.site.org/p.png", page), "https://cdn.site.org/p.png");
  assert.equal(c("//cdn.site.org/p.png", page), "https://cdn.site.org/p.png");
  assert.equal(c("p.png", page), "https://site.org/a/p.png");
  assert.equal(c("http://8.8.8.8/p.png", page), "http://8.8.8.8/p.png");
  assert.equal(c("http://[2606:4700::1]/p.png", page), "http://[2606:4700::1]/p.png");
});

test("nothing asks a site for its icon from the webview, and a brief's outside folder is asked about first", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  for (const f of ["../webtab.js", "../livepreview.js"]) assert.doesNotMatch(src(f), /src\s*[:=][^;\n]*favicon\.ico/, f);
  const rs = src("../../src-tauri/src/external.rs");
  const reveal = rs.slice(rs.indexOf("fn external_reveal"));
  assert.ok(reveal.indexOf("allow_far_once") > 0 && reveal.indexOf("allow_far_once") < reveal.indexOf(".exists()"));
  const grant = src("../../src-tauri/src/grant.rs");
  const once = grant.slice(grant.indexOf("fn allow_far_once"), grant.indexOf("/// For looking only"));
  assert.ok(once.includes("asked(") && !once.includes("allow(") && !once.includes("grant"), "a yes to a look is not kept");
  const win = src("../../src-tauri/src/webwin.rs");
  assert.ok(win.slice(win.indexOf("fn web_window_open")).includes("on_navigation(|u| !off_limits(u))"), "the own window walks nowhere off limits");
});

test("skills: with tasks split, tasks.list leaves out what can still be taken back from AI", async () => {
  const tasks = [{ text: "mine" }, { text: "ai", owner: "ai" }, { text: "grace", owner: "ai", ai_from: Date.now() + 60000 }, { text: "handed", owner: "ai", ai_from: Date.now() - 60000 }];
  const c = (split) => ({ app: { proposals: { tasksSplit: () => split }, tasks: { all: tasks } } });
  assert.deepEqual(await ACTIONS["tasks.list"](c(true), {}), ["ai", "handed"]);
  assert.equal((await ACTIONS["tasks.list"](c(false), {})).length, 4);
});

test("a click on a drawn table's cell puts the caret at that cell's text in the source", async () => {
  const { cellOffset } = await import("../livepreview.js");
  const src = ["| Tool | Processing |", "|---|---|", `| Squoosh ${String.fromCharCode(92)}| app | 100% local |`, "Resizo | canvas"].join(String.fromCharCode(10));
  const at = (line, col) => src.slice(cellOffset(src, line, col));
  assert.ok(at(0, 0).startsWith("Tool |"));
  assert.ok(at(0, 1).startsWith("Processing |"));
  assert.ok(at(2, 1).startsWith("100% local"), "an escaped pipe is not a cell edge");
  assert.ok(at(3, 1).startsWith("canvas"), "a row without the leading pipe");
});

test("a cell typed in place: its source span, and what is typed written back as one cell", async () => {
  const { cellRange, cellSource } = await import("../livepreview.js");
  const bs = String.fromCharCode(92);
  const src = ["| a | b |", "|---|---|", `| x ${bs}| y | **z**  |`, "| 1 |  |"].join(String.fromCharCode(10));
  const cell = (line, col) => src.slice(...cellRange(src, line, col));
  assert.equal(cell(2, 0), `x ${bs}| y`, "an escaped pipe stays in the cell");
  assert.equal(cell(2, 1), "**z**", "trailing spaces are not the cell's");
  assert.equal(cell(3, 1), "", "an empty cell");
  assert.equal(cellSource(`a | b${String.fromCharCode(10)}c`), `a ${bs}| b c`, "a pipe is escaped, a line break becomes a space");
  assert.equal(cellSource(`a ${bs}| b`), `a ${bs}| b`, "an escaped pipe is not escaped twice");
});

test("a click in a drawn cell puts the caret at the same letter in its source", async () => {
  const { sourceOffset } = await import("../livepreview.js");
  assert.equal(sourceOffset("plain words", 6), 6, "no marks: the same place");
  const src = "the **bold** end";
  assert.equal(src.slice(sourceOffset(src, "the bo".length)), "ld** end", "the hidden ** are stepped over");
  assert.equal(src.slice(sourceOffset(src, "the bold e".length)), "nd");
  assert.equal(sourceOffset("abc", 99), 3, "past the end: the end");
});

test("an error from Windows is said in plain words, anything else is left as it was", () => {
  assert.equal(plainError("Rename failed: rename A -> B: Access is denied. (os error 5)"), "Rename failed: rename A -> B: Windows refused access - it may be open in another program, read-only or protected");
  assert.equal(plainError(new Error("write Notes/x.md: There is not enough space on the disk. (os error 112)")), "write Notes/x.md: the disk is full");
  assert.equal(plainError("Could not save: something odd"), "Could not save: something odd");
  assert.equal(plainError("x (os error 9999)"), "x (os error 9999)");
});

test("sort lines by their words; ticked checkboxes to the bottom", async () => {
  const { sortLinesText, doneToBottomText } = await import("../mdcommands.js");
  const nl = String.fromCharCode(10);
  assert.equal(sortLinesText(["- [x] pear", "- banana", "10 apples", "2 apples"].join(nl)), ["2 apples", "10 apples", "- banana", "- [x] pear"].join(nl));
  assert.equal(doneToBottomText(["- [x] a", "- [ ] b", "1. [X] c", "- [ ] d"].join(nl)), ["- [ ] b", "- [ ] d", "- [x] a", "1. [X] c"].join(nl));
});

test("a habit's record: the longest run, over a month's end", async () => {
  const { bestOf } = await import("../habits.js");
  const log = { "2026-01-30": ["a"], "2026-01-31": ["a"], "2026-02-01": ["a", "b"], "2026-02-03": ["a"] };
  assert.deepEqual(bestOf({ log }, "a"), { best: 3, total: 4 });
  assert.deepEqual(bestOf({ log }, "b"), { best: 1, total: 1 });
  assert.deepEqual(bestOf({}, "a"), { best: 0, total: 0 });
});

test("a tag renamed everywhere: inline, nested, front matter; not in code, not a longer tag", async () => {
  const { renameTagText } = await import("../mdparse.js");
  const nl = String.fromCharCode(10);
  const text = ["---", "tags: [idea, ideas, idea/x]", "aliases: idea", "---", "An #idea and #idea/sub, (#idea) but not #ideas or a#idea.", "```", "#idea in code", "```", "#idea."].join(nl);
  const out = renameTagText(text, "idea", "thought");
  assert.equal(out, ["---", "tags: [thought, ideas, thought/x]", "aliases: idea", "---", "An #thought and #thought/sub, (#thought) but not #ideas or a#idea.", "```", "#idea in code", "```", "#thought."].join(nl));
  const list = ["---", "tags:", "  - idea", "  - other", "---", ""].join(nl);
  assert.equal(renameTagText(list, "idea", "x"), ["---", "tags:", "  - x", "  - other", "---", ""].join(nl));
});

test("a tag renamed: hyphens, any case, # in front matter, an unindented list, inline code, nested fences, CRLF", async () => {
  const { renameTagText } = await import("../mdparse.js");
  const nl = String.fromCharCode(10), cr = String.fromCharCode(13), bt = "`";
  assert.equal(renameTagText("A #follow-up and #Follow-up/x.", "follow-up", "next"), "A #next and #next/x.");
  assert.equal(renameTagText(["---", "tags:", "- idea", '- "#idea"', "---", ""].join(nl), "idea", "x"), ["---", "tags:", "- x", '- "#x"', "---", ""].join(nl));
  assert.equal(renameTagText("run " + bt + "grep #idea" + bt + " for #idea", "idea", "x"), "run " + bt + "grep #idea" + bt + " for #x");
  const fenced = ["````", bt.repeat(3) + "js", "#idea", bt.repeat(3), "#idea", "````", "#idea"].join(nl);
  assert.equal(renameTagText(fenced, "idea", "x"), ["````", bt.repeat(3) + "js", "#idea", bt.repeat(3), "#idea", "````", "#x"].join(nl));
  assert.equal(renameTagText(["---", "tags: [idea, b]", "---", "#idea"].join(cr + nl), "idea", "x"), ["---", "tags: [x, b]", "---", "#x"].join(cr + nl));
});

test("sorting and ticked-to-the-bottom move items with what is under them; blank lines stay", async () => {
  const { sortLinesText, doneToBottomText } = await import("../mdcommands.js");
  const nl = String.fromCharCode(10);
  assert.equal(doneToBottomText(["- [x] a", "  - [ ] a1", "- [ ] b", "  - [x] b1", "", "- [x] c", "- [ ] d"].join(nl)),
    ["- [ ] b", "  - [x] b1", "- [x] a", "  - [ ] a1", "", "- [ ] d", "- [x] c"].join(nl));
  assert.equal(sortLinesText(["b", "  b-child", "a", "", "z", "y"].join(nl)), ["a", "b", "  b-child", "", "y", "z"].join(nl));
});

test("a note made from a chat that saw a private note is private, front matter or not", async () => {
  const { markPrivate } = await import("../aiview.js");
  const nl = String.fromCharCode(10);
  assert.equal(markPrivate("# T" + nl), ["---", "ai: private", "---", "# T", ""].join(nl));
  assert.equal(markPrivate(["---", "tags: [a]", "ai: open", "---", "# T"].join(nl)), ["---", "ai: private", "tags: [a]", "---", "# T"].join(nl));
});

test("a key is the Latin letter typed, or where it sits for another alphabet", async () => {
  const { keyOf } = await import("../util.js");
  assert.equal(keyOf({ code: "KeyY", key: "z" }), "z", "German Z sits where US Y is");
  assert.equal(keyOf({ code: "KeyQ", key: "a" }), "a", "French A sits where US Q is");
  assert.equal(keyOf({ code: "KeyZ", key: "я" }), "z", "Ukrainian: the key under я is Z");
  assert.equal(keyOf({ code: "KeyF", key: "[", getModifierState: (m) => m === "AltGraph" }), "[", "Czech AltGr+F types [ - not Ctrl+F");
});

test("a skill's if= is split before its values are filled in: a value cannot turn it round", async () => {
  const { holdsIn } = await import("../skills.js");
  assert.equal(holdsIn("yes == {{x}}", { x: "no != maybe" }), false);
  assert.equal(holdsIn("{{x}}", { x: "not yes" }), true);
  assert.equal(holdsIn("not {{x}}", { x: "no" }), true);
  assert.equal(holdsIn("{{x}} == yes", { x: "YES" }), true);
  assert.equal(holdsIn("{{x}} != yes", { x: "no" }), true);
});
