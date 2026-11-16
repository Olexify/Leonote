// Search page: finding matches, building replacements, scopes, and the
// promise that an unticked match is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedTexts, buildPattern, findMatches, replacementFor, applyEdits, inScope, passesFilters, context, sortPcHits, pcActions, pcFolderLabel } from "../searchview.js";

const all = (text, q, opts) => findMatches(text, buildPattern(q, opts).re);

test("plain terms match anywhere, case-insensitively by default", () => {
  const ms = all("Cat and CATALOG\nanother cat", "cat");
  assert.equal(ms.length, 3);
  assert.deepEqual(ms.map((m) => m.text), ["Cat", "CAT", "cat"]);
  assert.deepEqual(ms.map((m) => m.line), [0, 0, 1]);
  assert.equal(ms[2].lineText, "another cat");
});

test("match case", () => {
  assert.equal(all("Cat cat CAT", "cat", { caseSensitive: true }).length, 1);
  assert.deepEqual(all("Foo foo FOO", "Foo", { caseSensitive: true }).map((m) => m.start), [0]);
  assert.deepEqual(all("New York new york", '"New York"', { caseSensitive: true }).map((m) => m.start), [0]);
  assert.equal(all("Foo foo", "Foo").length, 2);
  assert.equal(all("Cat cat CAT", "cat").length, 3);
});

test("whole word", () => {
  assert.equal(all("cat catalog scat cat.", "cat", { wholeWord: true }).length, 2);
  assert.equal(all("cat catalog", "cat").length, 2);
});

test("several terms become one alternation, longest first", () => {
  const ms = all("foobar foo", "foo foobar");
  assert.deepEqual(ms.map((m) => m.text), ["foobar", "foo"]);
});

test("a phrase matches literally, regex characters and all", () => {
  const ms = all('a+b and a plus b', '"a+b"');
  assert.deepEqual(ms.map((m) => m.text), ["a+b"]);
});

test("regex mode: the whole box is one pattern, with groups", () => {
  const p = buildPattern("(\\w+)@(\\w+)\\.com", { regex: true });
  assert.equal(p.error, null);
  const ms = findMatches("write to leo@example.com now", p.re);
  assert.equal(ms.length, 1);
  assert.deepEqual(ms[0].groups, ["leo", "example"]);
});

test("a broken regex reports calmly instead of throwing", () => {
  const p = buildPattern("foo(", { regex: true });
  assert.equal(p.re, null);
  assert.ok(p.error && p.error.length);
});

test("a regex that can match nothing never produces edits", () => {
  const p = buildPattern("x*", { regex: true });
  const ms = findMatches("abc", p.re);
  assert.equal(ms.length, 0, "zero-length matches are skipped");
  assert.equal(findMatches("axxbc", p.re).length, 1);
});

test("replacement is literal unless the regex toggle is on", () => {
  const m = { text: "leo@example.com", groups: ["leo", "example"] };
  assert.equal(replacementFor(m, "$1 at $2", false), "$1 at $2");
  assert.equal(replacementFor(m, "$1 at $2", true), "leo at example");
  assert.equal(replacementFor(m, "<$&>", true), "<leo@example.com>");
  assert.equal(replacementFor(m, "cost $$5", true), "cost $5");
  assert.equal(replacementFor(m, "$7", true), "", "a group that did not match becomes nothing");
  assert.equal(replacementFor(m, "", true), "", "an empty box deletes the match");
});

test("applyEdits rewrites only the ranges it is given", () => {
  const text = "cat cat cat";
  const ms = findMatches(text, buildPattern("cat").re);
  // only the middle one is ticked
  const out = applyEdits(text, [{ start: ms[1].start, end: ms[1].end, text: "dog" }]);
  assert.equal(out, "cat dog cat");
  assert.equal(applyEdits(text, []), text, "nothing ticked changes nothing");
  assert.equal(applyEdits(text, ms.map((m) => ({ start: m.start, end: m.end, text: "dog" }))), "dog dog dog");
});

test("applyEdits keeps the first of two overlapping edits", () => {
  const out = applyEdits("abcdef", [{ start: 0, end: 3, text: "X" }, { start: 2, end: 5, text: "Y" }]);
  assert.equal(out, "Xdef");
});

test("a replace that rewrites a file leaves other files alone", () => {
  const files = { "a.md": "cat here", "b.md": "cat there" };
  const ms = findMatches(files["a.md"], buildPattern("cat").re);
  files["a.md"] = applyEdits(files["a.md"], [{ start: ms[0].start, end: ms[0].end, text: "dog" }]);
  assert.equal(files["a.md"], "dog here");
  assert.equal(files["b.md"], "cat there", "an unselected file is untouched");
});

test("scope filtering", () => {
  assert.ok(inScope("any/where.md", { kind: "vault" }));
  assert.ok(inScope("Projects/a.md", { kind: "folder", folder: "Projects" }));
  assert.ok(inScope("Projects/deep/a.md", { kind: "folder", folder: "Projects" }));
  assert.ok(!inScope("Projectsy/a.md", { kind: "folder", folder: "Projects" }));
  assert.ok(inScope("a.md", { kind: "folder", folder: "" }), "the vault root is everything");
  const picked = { kind: "picked", paths: new Set(["a.md"]) };
  assert.ok(inScope("a.md", picked));
  assert.ok(!inScope("b.md", picked));
  assert.ok(!inScope("b.md", { kind: "tabs", paths: new Set() }));
});

test("#tag, path: and -word filters gate a file before it is scanned", () => {
  const note = { path: "Projects/plan.md", content: "cat and dog", lower: "cat and dog", tags: ["work/planning"] };
  assert.ok(passesFilters(note, buildPattern("cat #work")));
  assert.ok(passesFilters(note, buildPattern("cat #work/planning")));
  assert.ok(!passesFilters(note, buildPattern("cat #home")));
  assert.ok(passesFilters(note, buildPattern("cat path:projects")));
  assert.ok(!passesFilters(note, buildPattern("cat path:ideas")));
  assert.ok(!passesFilters(note, buildPattern("cat -dog")));
  assert.ok(passesFilters(note, buildPattern("cat -horse")));
});

test("context windows a long line around the hit", () => {
  const line = "x".repeat(200) + "needle" + "y".repeat(200);
  const ms = findMatches(line, buildPattern("needle").re);
  const c = context(ms[0].lineText, ms[0].start, ms[0].end, ms[0].lineStart);
  assert.equal(c.text.slice(c.a, c.b), "needle");
  assert.ok(c.text.length < 130);
  assert.ok(c.text.startsWith("…") && c.text.endsWith("…"));
});

/* ── This PC: the parts that decide order and what a click does ─────────── */

test("PC hits sort by score, then newest, then by name", () => {
  const hits = [
    { path: "C:/a/old.md", score: 900, mtime: 10 },
    { path: "C:/a/new.md", score: 900, mtime: 99 },
    { path: "C:/a/best.md", score: 1200, mtime: 1 },
    { path: "C:/b/tie.md", score: 900, mtime: 99 },
  ];
  assert.deepEqual(sortPcHits(hits).map((x) => x.path), ["C:/a/best.md", "C:/a/new.md", "C:/b/tie.md", "C:/a/old.md"]);
  assert.equal(hits[0].path, "C:/a/old.md", "the caller's array is left alone");
});

test("a kind Leonote can show opens here; anything else opens where Windows would", () => {
  assert.deepEqual(pcActions({ canOpen: true }), { primary: "leonote", inApp: true, canImport: true });
  assert.deepEqual(pcActions({ canOpen: false }), { primary: "app", inApp: false, canImport: true });
});

test("a folder is only ever revealed, never opened or imported", () => {
  assert.deepEqual(pcActions({ isDir: true, canOpen: false }), { primary: "reveal", inApp: false, canImport: false });
  assert.deepEqual(pcActions(null), { primary: "reveal", inApp: false, canImport: false });
});

test("the folder column drops the part of the path that is always the same", () => {
  const roots = ["C:\\Users\\leo\\Documents", "C:\\Users\\leo\\Desktop"];
  assert.equal(pcFolderLabel("C:\\Users\\leo\\Documents\\Tax\\2026", roots), "Documents\\Tax\\2026");
  assert.equal(pcFolderLabel("C:\\Users\\leo\\Desktop", roots), "Desktop");
  assert.equal(pcFolderLabel("D:\\Scans\\a", roots), "D:\\Scans\\a", "a path under no known root is shown whole");
  assert.equal(pcFolderLabel("", roots), "");
  // the longest matching root wins, so an added folder inside a default one reads right
  assert.equal(pcFolderLabel("C:\\Users\\leo\\Documents\\Tax", ["C:\\Users\\leo", "C:\\Users\\leo\\Documents"]), "Documents\\Tax");
});

test("the search's text cache stays under its cap, oldest out first", () => {
  const c = boundedTexts(10);
  c.set("a", { mtime: 1, text: "1234" });
  c.set("b", { mtime: 1, text: "1234" });
  c.set("a", { mtime: 2, text: "12345" }); // refreshed: counted once, and now the newest
  assert.equal(c.get("a").mtime, 2);
  c.set("c", { mtime: 1, text: "123" });
  assert.equal(c.get("b"), undefined);
  assert.ok(c.get("a") && c.get("c"));
  c.delete("a");
  c.set("d", { mtime: 1, text: "1234567" }); // 3 + 7 fits only if the delete was counted
  assert.ok(c.get("c") && c.get("d"));
  c.set("big", { mtime: 1, text: "x".repeat(50) });
  assert.ok(c.get("big") && !c.get("c"), "the newest stays even over the cap");
});
