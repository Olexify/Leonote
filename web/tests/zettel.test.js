// Templates and the Zettelkasten helpers: every rule that shapes a note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStamp, expandTemplate, templatesIn } from "../templates.js";
import {
  setupPlan, planSummary, buildIndex, relatedNotes, unresolvedLinks, orphansAndStubs,
  connectionInsert, fillKeyIdeas, titleFromText, noteFromSelection, replaceSelection,
  composeNote, parseSource, sourceValue, hhmmss, CORE_IDEA, MAP_OF_CONTENT,
} from "../zettel.js";
import { parseNote } from "../mdparse.js";

const D = new Date(2026, 8, 18, 7, 5, 9); // 18 Sep 2026, 07:05:09 local

/* ── placeholders ──────────────────────────────────────────────────────── */

test("date and time formats", () => {
  assert.equal(formatStamp(D, "YYYY-MM-DD"), "2026-09-18");
  assert.equal(formatStamp(D, "HH:mm"), "07:05");
  assert.equal(formatStamp(D, "HH:mm:ss"), "07:05:09");
  assert.equal(formatStamp(D, "DD.MM.YY"), "18.09.26");
  assert.equal(formatStamp(D, "YYYYMMDDHHmmss"), "20260918070509");
  assert.equal(formatStamp(D, "on DD at HH"), "on 18 at 07", "text around the tokens survives");
});

test("expandTemplate fills what it knows and leaves the rest alone", () => {
  const r = expandTemplate("# {{title}}\n{{date}} {{time}}\n{{date:DD/MM}} {{time:HH-mm-ss}}\n{{unknown}}", { title: "Atomic notes", date: D });
  assert.equal(r.text, "# Atomic notes\n2026-09-18 07:05\n18/09 07-05-09\n{{unknown}}");
  assert.equal(r.cursor, null);
  assert.equal(expandTemplate("{{ TITLE }}", { title: "X", date: D }).text, "X", "names are trimmed and case-insensitive");
  assert.equal(expandTemplate("{{missing}}", { values: { source: "u" }, date: D }).text, "{{missing}}");
  assert.equal(expandTemplate("- Source: {{source}}", { values: { source: "https://x/y" }, date: D }).text, "- Source: https://x/y");
  assert.equal(expandTemplate("a{{title}}b", { date: D }).text, "ab", "no title given is an empty one");
});

test("{{cursor}} says where the caret lands and leaves no trace", () => {
  const r = expandTemplate("## Idea\n\n{{cursor}}\n\n## Source", { date: D });
  assert.equal(r.text, "## Idea\n\n\n\n## Source");
  assert.equal(r.cursor, "## Idea\n\n".length);
  assert.equal(r.text.slice(0, r.cursor), "## Idea\n\n");
  const two = expandTemplate("{{cursor}}a{{cursor}}", { date: D });
  assert.equal(two.cursor, 0, "the first one wins");
  assert.equal(two.text, "a");
  assert.equal(expandTemplate("no caret here", { date: D }).cursor, null);
});

test("the templates put no made-up links into the graph", () => {
  for (const t of [CORE_IDEA, MAP_OF_CONTENT]) {
    const text = expandTemplate(t, { title: "T", date: D }).text;
    assert.deepEqual(parseNote(text).links, [], "a brand-new note links to nothing yet");
    assert.deepEqual(parseNote(text).tags, []);
  }
});

test("the shipped templates expand into valid, Obsidian-shaped notes", () => {
  const idea = expandTemplate(CORE_IDEA, { title: "Small habits compound", date: D });
  assert.match(idea.text, /^---\ncreated: 2026-09-18T07:05\ntype: idea\ntags: \[\]\n---\n/);
  assert.ok(idea.cursor > 0 && idea.text.slice(0, idea.cursor).endsWith("## Idea\n\n"));
  assert.ok(!idea.text.includes("{{"), "nothing is left unexpanded");
  const m = parseNote(idea.text);
  assert.deepEqual(m.headings.map((x) => x.text), ["Idea", "Connections", "Source"]);
  const moc = expandTemplate(MAP_OF_CONTENT, { title: "Learning", date: D });
  assert.match(moc.text, /type: moc/);
  assert.deepEqual(parseNote(moc.text).headings.map((x) => x.text), ["Overview", "Key ideas", "Related maps"]);
});

test("templatesIn lists only the notes directly in the folder", () => {
  const notes = new Map(Object.entries({
    "Templates/Core Idea.md": { path: "Templates/Core Idea.md", title: "Core Idea", folder: "Templates" },
    "Templates/Map of Content.md": { path: "Templates/Map of Content.md", title: "Map of Content", folder: "Templates" },
    "Templates/old/Legacy.md": { path: "Templates/old/Legacy.md", title: "Legacy", folder: "Templates/old" },
    "Zettelkasten/Idea.md": { path: "Zettelkasten/Idea.md", title: "Idea", folder: "Zettelkasten" },
  }));
  assert.deepEqual(templatesIn(notes, "Templates").map((n) => n.title), ["Core Idea", "Map of Content"]);
  assert.deepEqual(templatesIn(notes, ""), []);
});

/* ── the setup plan ────────────────────────────────────────────────────── */

const emptyVault = { folders: [], notes: [], settings: { newNoteDir: "current", imageFolder: "" } };

test("the setup plan creates everything in an empty vault", () => {
  const p = setupPlan(emptyVault);
  assert.deepEqual(p.folders.create, ["Zettelkasten", "Reference Notes", "Files", "Templates"]);
  assert.deepEqual(p.folders.skip, []);
  assert.deepEqual(p.files.create.map((f) => f.path), ["Templates/Core Idea.md", "Templates/Map of Content.md"]);
  assert.deepEqual(p.settings, {
    templateFolder: "Templates", zettelFolder: "Zettelkasten", referenceFolder: "Reference Notes",
    newNoteDir: "folder", newNoteFolder: "Zettelkasten", imageFolder: "Files",
  });
  assert.equal(p.nothingToDo, false);
  assert.match(planSummary(p), /Created 4 folders, 2 templates, 6 settings/);
});

test("the setup plan never touches what is already there", () => {
  const after = setupPlan({
    folders: ["Zettelkasten", "Reference Notes", "Files", "Templates"],
    notes: ["Templates/Core Idea.md", "Templates/Map of Content.md"],
    settings: { templateFolder: "Templates", zettelFolder: "Zettelkasten", referenceFolder: "Reference Notes", newNoteDir: "folder", newNoteFolder: "Zettelkasten", imageFolder: "Files" },
  });
  assert.equal(after.nothingToDo, true);
  assert.deepEqual(after.folders.create, []);
  assert.deepEqual(after.files.create, []);
  assert.deepEqual(after.settings, {});
  assert.match(planSummary(after), /already set up/);
});

test("applying the plan twice is the same as applying it once", () => {
  const folders = new Set();
  const notes = new Map();
  let settings = { newNoteDir: "current", imageFolder: "" };
  const apply = (p) => {
    for (const d of p.folders.create) folders.add(d);
    for (const f of p.files.create) notes.set(f.path, f.content);
    settings = { ...settings, ...p.settings };
  };
  apply(setupPlan({ folders, notes: notes.keys(), settings }));
  const once = { folders: [...folders], notes: [...notes.keys()], contents: [...notes.values()], settings: { ...settings } };
  apply(setupPlan({ folders, notes: notes.keys(), settings }));
  assert.deepEqual([...folders], once.folders);
  assert.deepEqual([...notes.keys()], once.notes);
  assert.deepEqual([...notes.values()], once.contents, "an existing template is never rewritten");
  assert.deepEqual(settings, once.settings);
});

test("a template written by hand is kept, and said so", () => {
  const p = setupPlan({ folders: ["Templates"], notes: ["templates/core idea.md"], settings: {} });
  assert.deepEqual(p.folders.skip, ["Templates"], "folder names compare case-insensitively");
  assert.deepEqual(p.files.skip, ["Templates/Core Idea.md"]);
  assert.deepEqual(p.files.create.map((f) => f.path), ["Templates/Map of Content.md"]);
  assert.match(planSummary(p), /kept 2 things that already existed/);
});

test("the plan follows renamed folders", () => {
  const p = setupPlan({ ...emptyVault, settings: {} }, { folders: { zettel: "Slip box", templates: "_templates" } });
  assert.deepEqual(p.folders.create, ["Slip box", "Reference Notes", "Files", "_templates"]);
  assert.deepEqual(p.files.create.map((f) => f.path), ["_templates/Core Idea.md", "_templates/Map of Content.md"]);
  assert.equal(p.settings.newNoteFolder, "Slip box");
});

/* ── a note out of the selection ───────────────────────────────────────── */

test("titles come from the first line, stripped of markdown", () => {
  assert.equal(titleFromText("## Small habits compound over time"), "Small habits compound over time");
  assert.equal(titleFromText("- [ ] **Retrieval** strengthens `memory`."), "Retrieval strengthens memory");
  assert.equal(titleFromText("\n\n> Quoting [[Spaced repetition|the idea]] here"), "Quoting the idea here");
  assert.equal(titleFromText("See [the paper](https://x/y)"), "See the paper");
  assert.equal(titleFromText("   \n  "), "", "nothing usable means we have to ask");
  assert.equal(titleFromText("Type `/` at the start of a line. Type `[[` to link"), "Type / at the start of a line. Type to link", "a half-typed link leaves no brackets");
  assert.equal(titleFromText("---\n***\n| --- | --- |\nThe real first line"), "The real first line", "rules and table borders are not titles");
  assert.equal(titleFromText("---\ntype: idea\n---"), "type: idea", "frontmatter dashes alone name nothing");
  assert.equal(titleFromText("***"), "");
  const long = titleFromText("one two three four five six seven eight nine ten eleven twelve thirteen", 30);
  assert.ok(long.length <= 30 && !long.endsWith(" ") && long === "one two three four five six");
});

test("noteFromSelection splits a heading off, keeps a paragraph whole", () => {
  const a = noteFromSelection("# Repeated retrieval strengthens memory\n\nTesting yourself beats rereading.\n");
  assert.equal(a.title, "Repeated retrieval strengthens memory");
  assert.equal(a.body, "Testing yourself beats rereading.");
  const b = noteFromSelection("Testing yourself beats rereading, because effortful recall re-encodes.");
  assert.equal(b.title, "Testing yourself beats rereading, because effortful recall re-encodes");
  assert.equal(b.body, "Testing yourself beats rereading, because effortful recall re-encodes.", "a plain paragraph stays in the note");
  const c = noteFromSelection("");
  assert.deepEqual(c, { title: "", body: "" });
});

test("the selection becomes a link in the note it came from", () => {
  const doc = "Before. Testing beats rereading. After.";
  const r = replaceSelection(doc, 8, 32, "Testing beats rereading");
  assert.equal(r.text, "Before. [[Testing beats rereading]] After.");
  assert.equal(r.cursor, 8 + "[[Testing beats rereading]]".length);
  assert.equal(r.text.slice(0, r.cursor).endsWith("]]"), true);
});

test("composeNote drops the body where the caret would have gone", () => {
  const r = composeNote(CORE_IDEA, { title: "T", date: D, body: "Because recall is effortful." });
  assert.match(r.text, /## Idea\n\nBecause recall is effortful\.\n\n## Connections/);
  assert.equal(r.text.slice(0, r.cursor).endsWith("effortful."), true);
  assert.equal(composeNote("no cursor", { date: D, body: "x" }).text, "no cursorx");
});

/* ── connections ───────────────────────────────────────────────────────── */

const notes = (map) => [...map.entries()].map(([path, content]) => {
  const m = parseNote(content);
  const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return { path, title, folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", content, lower: content.toLowerCase(), mtime: 1, words: m.words, links: m.links, tags: m.tags };
});

// a tiny vault: A and B share a tag and a neighbour; C is only mentioned by name
const VAULT = new Map([
  ["Z/A.md", "#memory\nAbout [[Hub]] and spaced practice. Forgetting curve matters.\n"],
  ["Z/B.md", "#memory\nAlso about [[Hub]].\n"],
  ["Z/Hub.md", "The hub.\n"],
  ["Z/Forgetting curve.md", "How memory fades.\n"],
  ["Z/Unrelated.md", "Nothing to do with it. #cooking\n"],
  ["Z/Lonely.md", "No links at all here, and barely any words.\n"],
]);

const resolve = (target, from) => {
  const t = String(target).replace(/\.md$/i, "").toLowerCase();
  for (const p of VAULT.keys()) if (p.toLowerCase() === t + ".md" || p.toLowerCase().endsWith("/" + t + ".md")) return p;
  return null;
};

test("related notes are scored by tags, shared links and bare mentions", () => {
  const idx = buildIndex(notes(VAULT), resolve);
  const r = relatedNotes(idx, "Z/A.md");
  const by = Object.fromEntries(r.map((x) => [x.title, x]));
  assert.ok(!r.some((x) => x.title === "Hub"), "already linked, so not suggested");
  assert.ok(by["B"], "a shared tag and a shared neighbour");
  assert.deepEqual(by["B"].why, ["#memory", "1 link in common"]);
  assert.equal(by["B"].score, 5);
  assert.ok(by["Forgetting curve"].mention, "its title is written in A but not linked");
  assert.equal(by["Forgetting curve"].score, 4);
  assert.ok(!by["Unrelated"], "nothing in common scores nothing");
  assert.equal(relatedNotes(idx, "Z/A.md", { limit: 1 }).length, 1);
  assert.deepEqual(relatedNotes(idx, "nope.md"), []);
});

test("a short title is still found in a long note", () => {
  const v = new Map([["Big.md", "cats and dogs. " + "filler words here ".repeat(4000)], ["cats.md", "x\n"], ["dogs.md", "x\n"], ["and dogs.md", "x\n"]]);
  const r = relatedNotes(buildIndex(notes(v), () => null), "Big.md");
  assert.deepEqual(r.map((x) => x.title).sort(), ["and dogs", "cats", "dogs"]);
});

test("links in common count each shared note once, whichever way it links", () => {
  const v = new Map([["a.md", "[[Hub]] [[Two]]\n"], ["b.md", "[[Hub]]\n"], ["Hub.md", "[[b]]\n"], ["Two.md", "x\n"]]);
  const res = (t) => ([...v.keys()].find((p) => p.toLowerCase() === String(t).toLowerCase() + ".md") || null);
  const b = relatedNotes(buildIndex(notes(v), res), "a.md").find((x) => x.title === "b");
  assert.deepEqual(b.why, ["1 link in common"]);
});

test("a title already inside [[ ]] is not an unlinked mention", () => {
  const v = new Map([["a.md", "See [[Forgetting curve]] only.\n"], ["Forgetting curve.md", "x\n"]]);
  const res = (t) => ([...v.keys()].find((p) => p.toLowerCase() === String(t).toLowerCase() + ".md") || null);
  const r = relatedNotes(buildIndex(notes(v), res), "a.md");
  assert.deepEqual(r, [], "linked notes belong in Backlinks, not here");
});

test("buildIndex reads an iterator, not only an array", () => {
  const map = new Map(notes(VAULT).map((n) => [n.path, n]));
  const idx = buildIndex(map.values(), resolve);
  assert.equal(idx.size, 6);
  assert.deepEqual([...idx.get("Z/Hub.md").in].sort(), ["Z/A.md", "Z/B.md"], "the second pass still sees every note");
  assert.deepEqual(unresolvedLinks(map.values(), resolve, { min: 1 }), []);
});

test("buildIndex skips the folders that are not ideas", () => {
  const idx = buildIndex(notes(VAULT), resolve, { ignore: ["Z"] });
  assert.equal(idx.size, 0);
});

test("unresolved links are counted and ranked", () => {
  const v = new Map([
    ["a.md", "[[Habit Formation]] and [[Habit Formation]] again, plus [[Real]].\n"],
    ["b.md", "[[habit formation]] once more.\n"],
    ["c.md", "[[Habit formation]] and [[Seen once]].\n"],
    ["Real.md", "I exist.\n"],
    ["Templates/T.md", "[[Habit Formation]] [[Seen once]] [[Seen once]]\n"],
  ]);
  const res = (t) => ([...v.keys()].find((p) => p.toLowerCase() === String(t).toLowerCase() + ".md") || null);
  const out = unresolvedLinks(notes(v), res, { ignore: ["Templates"] });
  assert.equal(out.length, 1, "only links pointing nowhere, and only from real notes");
  assert.equal(out[0].display, "Habit Formation");
  assert.equal(out[0].count, 3, "counted once per note, whatever the spelling");
  assert.deepEqual(out[0].notes, ["a.md", "b.md", "c.md"]);
  assert.equal(unresolvedLinks(notes(v), res, { min: 1, ignore: ["Templates"] }).length, 2);
  assert.equal(unresolvedLinks(notes(v), res, { min: 1, limit: 1, ignore: ["Templates"] }).length, 1);
});

test("orphans have no links either way; stubs are short but connected", () => {
  const { orphans, stubs, orphanCount, stubCount } = orphansAndStubs(buildIndex(notes(VAULT), resolve), { stubWords: 5 });
  assert.deepEqual(orphans.map((n) => n.title).sort(), ["Forgetting curve", "Lonely", "Unrelated"]);
  assert.equal(orphanCount, 3);
  assert.deepEqual(stubs.map((n) => n.title), ["B", "Hub"]);
  assert.equal(stubCount, 2);
});

test("a connection goes under ## Connections, or makes the heading", () => {
  const withHeading = "## Idea\n\nText.\n\n## Connections\n\n- [[One]] — first\n\n## Source\n\n- x\n";
  const e = connectionInsert(withHeading, "Two");
  const after = withHeading.slice(0, e.from) + e.insert + withHeading.slice(e.to);
  assert.equal(after, "## Idea\n\nText.\n\n## Connections\n\n- [[One]] — first\n- [[Two]] — \n\n## Source\n\n- x\n");
  assert.equal(after.slice(0, e.cursor).endsWith("- [[Two]] — "), true, "the caret waits for the relationship");

  const bare = "Just a thought.";
  const b = connectionInsert(bare, "Two");
  assert.equal(bare.slice(0, b.from) + b.insert + bare.slice(b.to), "Just a thought.\n\n## Connections\n\n- [[Two]] — ");

  const empty = connectionInsert("", "Two");
  assert.equal(empty.insert, "## Connections\n\n- [[Two]] — ");

  const emptySection = "## Connections\n\n## Source\n";
  const s = connectionInsert(emptySection, "Two");
  assert.equal(emptySection.slice(0, s.from) + s.insert + emptySection.slice(s.to), "## Connections\n\n- [[Two]] — \n\n## Source\n");
});

test("the template's example line is replaced, not kept", () => {
  const t = expandTemplate(CORE_IDEA, { title: "T", date: D }).text;
  const e = connectionInsert(t, "Two");
  const after = t.slice(0, e.from) + e.insert + t.slice(e.to);
  assert.ok(!/Related idea/.test(after), "the example line makes way for the first real link");
  assert.match(after, /## Connections\n\n- \[\[Two\]\] — \n/);
});

test("a map of content starts from the notes that asked for it", () => {
  const t = expandTemplate(MAP_OF_CONTENT, { title: "Habit Formation", date: D }).text;
  const filled = fillKeyIdeas(t, ["A", "B"]);
  assert.match(filled, /## Key ideas\n\n- \[\[A\]\] — \n- \[\[B\]\] — \n\n## Related maps/);
  assert.ok(!/The notes that belong here/.test(filled));
  assert.equal(fillKeyIdeas(t, []), t, "no notes, no changes");
  assert.match(fillKeyIdeas("# Bare\n", ["A"]), /## Key ideas\n\n- \[\[A\]\] — \n/);
  assert.match(fillKeyIdeas("## Key ideas\n\n- [[Kept]] — mine\n", ["A"]), /- \[\[A\]\] — \n- \[\[Kept\]\] — mine/);
});

/* ── sources ───────────────────────────────────────────────────────────── */

test("a YouTube link keeps its timestamp", () => {
  assert.equal(hhmmss(754), "12:34");
  assert.equal(hhmmss(3723), "1:02:03");
  assert.equal(hhmmss(9), "0:09");
  const a = parseSource("https://www.youtube.com/watch?v=E6ySG7xYgjY&t=754s");
  assert.equal(a.youtube, true);
  assert.equal(a.seconds, 754);
  assert.equal(a.stamp, "12:34");
  assert.equal(parseSource("https://youtu.be/E6ySG7xYgjY?t=1h2m3s").stamp, "1:02:03");
  assert.equal(parseSource("https://youtu.be/E6ySG7xYgjY?t=90").seconds, 90);
  assert.equal(parseSource("https://youtu.be/E6ySG7xYgjY").stamp, "");
  assert.equal(parseSource("https://example.com/paper?t=12s").stamp, "", "only YouTube counts timestamps");
  assert.equal(parseSource("not a link"), null);
  assert.equal(parseSource("https://x.com/a b"), null);
  assert.equal(sourceValue("https://youtu.be/ID?t=754s"), "https://youtu.be/ID?t=754s (12:34)");
  assert.equal(sourceValue("https://example.com/paper"), "https://example.com/paper");
  assert.equal(sourceValue("just some text"), "");
});
