import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseNote, headingOf, isWebPicture, setOwnPictureRoots } from "../mdparse.js";
import { mdToHtml } from "../boardmodel.js";

test("the project chat cannot write its own ai: line", () => {
  assert.match(fs.readFileSync(new URL("../aiview.js", import.meta.url), "utf8"), /frontAccess\(next\) !== frontAccess\(n && n\.content\)\) throw[^\n]*\n\s*await app\.vault\.write\(path, next/);
});

test("a heading line of spaces is read at once, not after minutes", () => {
  const line = "# a" + " ".repeat(20000) + "x";
  const t = Date.now();
  parseNote("n.md", line + "\n");
  mdToHtml(line, {});
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
  assert.deepEqual(headingOf("## Title ##").slice(1), ["##", "Title"]);
  assert.deepEqual(headingOf("# C#").slice(1), ["#", "C"]);
  assert.equal(headingOf("#x"), null);
  assert.equal(headingOf("  # x"), null);
  assert.deepEqual(headingOf("   # x", 3).slice(1), ["#", "x"]);
});

test("an asset.localhost picture is Leonote's own only on a drive, never a network path", () => {
  assert.equal(isWebPicture("http://asset.localhost/E%3A%5CNotes%5Ca.png"), false);
  assert.equal(isWebPicture("http://asset.localhost/C%3A%2Fx%2Fa.png"), false);
  assert.equal(isWebPicture("http://asset.localhost/%5C%5Cevil.example%5Cshare%5Cx.png"), true);
  assert.equal(isWebPicture("http://asset.localhost/%2F%2Fevil.example%2Fshare%2Fx.png"), true);
  assert.equal(isWebPicture("http://asset.localhost/%E0"), true);
  assert.equal(isWebPicture("http://heic.localhost/?p=E%3A%5Ca.heic"), false);
});

test("a query's frame shows strings as text, and a link's target cannot leave its attribute", () => {
  const src = fs.readFileSync(new URL("../dvframe.js", import.meta.url), "utf8");
  assert.match(src, /if \(!asText && \/<\[a-z\]/);
  assert.match(src, /asText = m\.kind === "dql";/);
  assert.match(src, /\[&<>"\]/);
});

test("a link in an answer shows its address, and where it goes when the label hides it", async () => {
  class El { constructor(t) { this.tag = t; this.dataset = {}; this.style = {}; this.kids = []; this.attrs = {}; } setAttribute(k, v) { this.attrs[k] = v; } append(...k) { this.kids.push(...k); } addEventListener() {} }
  globalThis.document = { createElement: (t) => new El(t), createTextNode: (t) => t };
  const { webLink } = await import("../aiview.js");
  const [a, note] = webLink("https://evil.example/?d=x", "your summary");
  assert.equal(a.attrs.title, "https://evil.example/?d=x");
  assert.equal(a.dataset.url, "https://evil.example/?d=x");
  assert.match(note, /evil\.example/);
  assert.equal(webLink("https://example.org/a", "example.org docs").length, 1);
});

test("a vault on a network share still shows its own pictures, and only those", () => {
  const nas = "http://asset.localhost/" + encodeURIComponent(String.fromCharCode(92, 92) + "nas" + String.fromCharCode(92) + "notes" + String.fromCharCode(92) + "a.png");
  const other = "http://asset.localhost/" + encodeURIComponent(String.fromCharCode(92, 92) + "nas" + String.fromCharCode(92) + "other" + String.fromCharCode(92) + "a.png");
  assert.equal(isWebPicture(nas), true);
  setOwnPictureRoots([String.fromCharCode(92, 92) + "nas" + String.fromCharCode(92) + "notes"]);
  assert.equal(isWebPicture(nas), false);
  assert.equal(isWebPicture(other), true);
  setOwnPictureRoots([]);
});

test("related notes on a big note still find exactly the titles mentioned in it", async () => {
  const { buildIndex, relatedNotes } = await import("../zettel.js");
  const big = "lorem ipsum dolor ".repeat(5000) + " the forgetting curve shows up here, and spaced repetition too. " + "sit amet ".repeat(3000);
  const v = new Map([["big.md", big], ["Forgetting curve.md", "x"], ["Spaced repetition.md", "y"], ["Never named.md", "z"]]);
  const list = [...v.entries()].map(([path, content]) => {
    const m = parseNote(content);
    return { path, title: path.replace(/\.md$/, ""), folder: "", content, lower: content.toLowerCase(), mtime: 1, words: m.words, links: m.links, tags: m.tags };
  });
  const idx = buildIndex(list, () => null);
  const found = relatedNotes(idx, "big.md", { limit: 10 }).filter((r) => r.mention).map((r) => r.title).sort();
  assert.deepEqual(found, ["Forgetting curve", "Spaced repetition"]);
});

test("a closed video or Studio editor lets go of the listeners that kept it alive, and a PDF that cannot open does too", () => {
  const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
  assert.match(read("videoedit.js"), /removeEventListener\("fullscreenchange", onFullscreen\)/);
  assert.match(read("paint.js"), /removeEventListener\("blur", onLeave\)/);
  assert.match(read("pdfmode.js"), /try \{ await load\(null\); \}\s+catch \(e\)[^]*?annots\.destroy\(\);[^]*?throw e;/);
});
