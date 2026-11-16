// Highlights: what the two spellings parse to, and what toggling one over a
// selection does to the text. All of it is pure - text and a selection in,
// text and a selection out - so none of it needs an editor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HL_COLORS, hlColor, findHighlights, stripHighlights, toggleHighlight, highlightEdits, excerpt } from "../mdparse.js";
import { DEFAULTS, HEADING_STYLES, HEADING_SIZES, resolveHeadingStyle, resolveHeadingSize } from "../settings.js";

const tog = (text, from, to, color) => toggleHighlight(text, from, to, color);
const sel = (r) => r.text.slice(r.from, r.to);

/* ── parsing ───────────────────────────────────────────────────────────── */

test("both spellings are found, with their colour", () => {
  const hs = findHighlights('a ==bee== c <mark class="hl-pink">dee</mark>');
  assert.equal(hs.length, 2);
  assert.deepEqual(hs.map((h) => h.color), ["yellow", "pink"]);
  assert.equal("a ==bee== c".slice(hs[0].inner, hs[0].innerTo), "bee");
});

test("a bare <mark> is a yellow highlight, an unknown class falls back to yellow", () => {
  assert.equal(findHighlights("<mark>hi</mark>")[0].color, "yellow");
  assert.equal(findHighlights('<mark class="hl-chartreuse">hi</mark>')[0].color, "yellow");
  assert.equal(hlColor("gray"), "grey");
  for (const c of HL_COLORS) assert.equal(hlColor(c), c);
  for (const junk of [null, undefined, "", " ", 7, {}, "HL-BLUE", "\n"]) assert.equal(hlColor(junk), "yellow");
});

test("== needs to hug its text, the way Obsidian's does", () => {
  assert.equal(findHighlights("== spaced ==").length, 0);
  assert.equal(findHighlights("==tight==").length, 1);
  assert.equal(findHighlights("====").length, 1); // empty, but real: the caret sits in it
});

test("a single = inside is fine, so ==a = b== still highlights", () => {
  const hs = findHighlights("==a = b==");
  assert.equal(hs.length, 1);
  assert.equal("==a = b==".slice(hs[0].inner, hs[0].innerTo), "a = b");
});

test("two highlights on a line do not merge into one", () => {
  const hs = findHighlights("==one== and ==two==");
  assert.deepEqual(hs.map((h) => "==one== and ==two==".slice(h.inner, h.innerTo)), ["one", "two"]);
});

test("stripping leaves the words and takes only the marks", () => {
  assert.equal(stripHighlights('==a== b <mark class="hl-blue">c</mark>'), "a b c");
  assert.equal(stripHighlights("nothing here"), "nothing here");
});

test("previews show the words, not the marks", () => {
  assert.equal(excerpt('# ==Title==\n<mark class="hl-green">green</mark> text'), "Title · green text");
});

/* ── toggling ──────────────────────────────────────────────────────────── */

test("a plain selection becomes ==yellow==, and the words stay selected", () => {
  const r = tog("hello world", 0, 5);
  assert.equal(r.text, "==hello== world");
  assert.equal(sel(r), "hello");
});

test("the same colour again takes the highlight off", () => {
  const r = tog("==hello== world", 2, 7);
  assert.equal(r.text, "hello world");
  assert.equal(sel(r), "hello");
});

test("selecting the marks as well still toggles it off", () => {
  assert.equal(tog("==hello== world", 0, 9).text, "hello world");
});

test("part of a highlight toggles the whole highlight, never half of one", () => {
  assert.equal(tog("==hello there== you", 4, 7).text, "hello there you");
});

test("a colour writes the inline HTML Obsidian renders", () => {
  const r = tog("hello world", 6, 11, "blue");
  assert.equal(r.text, 'hello <mark class="hl-blue">world</mark>');
  assert.equal(sel(r), "world");
});

test("a different colour recolours instead of nesting", () => {
  const r = tog('<mark class="hl-blue">hi</mark> there', 22, 24, "green");
  assert.equal(r.text, '<mark class="hl-green">hi</mark> there');
  assert.equal(sel(r), "hi");
  assert.equal(findHighlights(r.text).length, 1);
});

test("yellow over a coloured one brings it back to plain ==", () => {
  assert.equal(tog('<mark class="hl-blue">hi</mark> there', 22, 24, "yellow").text, "==hi== there");
});

test("null removes whatever is there and never adds", () => {
  assert.equal(tog("==a== plain", 2, 3, null).text, "a plain");
  assert.equal(tog('<mark class="hl-pink">a</mark>', 22, 23, null).text, "a");
  assert.equal(tog("plain text", 0, 5, null).text, "plain text");
  assert.deepEqual(highlightEdits("plain text", 3, 3, null).changes, []);
});

test("highlights caught inside a bigger selection are swallowed, not nested", () => {
  const r = tog("a ==b== c ==d== e", 0, 17);
  assert.equal(r.text, "==a b c d e==");
  assert.equal(findHighlights(r.text).length, 1);
});

test("a selection that cuts through a highlight takes the whole of it", () => {
  // half a pair of == wrapped inside a <mark> would be nonsense in any reader
  const a = tog("Pick out ==the impo==rtant words", 9, 17, "blue");
  assert.equal(a.text, 'Pick out <mark class="hl-blue">the impo</mark>rtant words');
  const b = tog("Pick out ==the impo==rtant words", 14, 25, "blue");
  assert.equal(b.text, 'Pick out <mark class="hl-blue">the importan</mark>t words');
  const c = tog('x <mark class="hl-blue">y</mark> z', 4, 25, "pink");
  assert.equal(c.text, 'x <mark class="hl-pink">y</mark> z');
});

test("stripping goes round again when the halves it leaves read as a pair", () => {
  assert.equal(stripHighlights('<mark class="hl-blue">==the im</mark>po==rtant'), "the important");
});

test("spaces at the edge of the selection stay outside the marks", () => {
  assert.equal(tog("one two three", 3, 8).text, "one ==two== three");
});

/* ── the awkward ones ──────────────────────────────────────────────────── */

test("a heading keeps its #, a task keeps its box", () => {
  assert.equal(tog("# Title here", 0, 12).text, "# ==Title here==");
  assert.equal(tog("- [ ] do a thing", 0, 16).text, "- [ ] ==do a thing==");
  assert.equal(tog("> quoted line", 0, 13).text, "> ==quoted line==");
  assert.equal(tog("  - nested item", 0, 15).text, "  - ==nested item==");
});

test("a selection over several lines highlights each line on its own", () => {
  const r = tog("one\ntwo\n\nthree", 0, 14);
  assert.equal(r.text, "==one==\n==two==\n\n==three==");
  assert.equal(sel(r), "one==\n==two==\n\n==three");  // first word to last, marks and all
  assert.equal(findHighlights("==one==").length, 1);
});

test("blank lines in a multi-line selection are left alone", () => {
  assert.equal(tog("a\n\n\nb", 0, 5).text, "==a==\n\n\n==b==");
});

test("a selection that ends at the start of the next line does not highlight it", () => {
  assert.equal(tog("one\ntwo", 0, 4).text, "==one==\ntwo");
});

test("with no selection the caret gets an empty highlight to type into", () => {
  const r = tog("ab", 1, 1);
  assert.equal(r.text, "a====b");
  assert.equal(r.from, 3);
  assert.equal(r.to, 3);
});

test("with the caret inside a highlight it comes off, caret where it was", () => {
  const r = tog("==word==", 4, 4);
  assert.equal(r.text, "word");
  assert.equal(r.from, 2);
});

test("only the lines the selection touches are rewritten", () => {
  const doc = "keep me\nchange me\nkeep me too";
  const e = highlightEdits(doc, 8, 17);
  assert.equal(e.changes.length, 1);
  assert.equal(e.changes[0].from, 8);
  assert.equal(e.changes[0].to, 17);
  assert.equal(e.changes[0].insert, "==change me==");
});

test("nothing to do means no change at all", () => {
  assert.deepEqual(highlightEdits("hello", 2, 2, null).changes, []);
  assert.deepEqual(highlightEdits("hello", 5, 5, null).changes, []);
});

test("a backwards or out-of-range selection is taken as read, not as a crash", () => {
  assert.equal(tog("hello", 5, 0).text, "==hello==");
  assert.equal(tog("hello", -4, 99).text, "==hello==");
});

test("toggling twice is the text you started with", () => {
  for (const [doc, a, b, c] of [["hello world", 0, 5, "yellow"], ["a b c", 2, 3, "purple"], ["# H\ntext", 5, 9, "green"]]) {
    const once = tog(doc, a, b, c);
    const twice = tog(once.text, once.from, once.to, c);
    assert.equal(twice.text, doc, `${doc} / ${c}`);
  }
});

/* ── settings ──────────────────────────────────────────────────────────── */

test("the heading styles are the ten the picker offers, Accent first", () => {
  assert.deepEqual(HEADING_STYLES.map(([k]) => k), ["accent", "plain", "underline", "number", "boxed", "serif", "tinted", "caps", "hash", "rule"]);
  assert.ok(HEADING_STYLES.every(([, label, hint]) => label && hint));
});

test("junk in the settings file never turns into a bad data-headings", () => {
  for (const bad of [null, undefined, "", "PLAIN", "fancy", 0, 1, true, {}, [], "serif ", "boxed\n"]) {
    assert.equal(resolveHeadingStyle(bad), "plain", JSON.stringify(bad));
    assert.equal(resolveHeadingSize(bad), "normal", JSON.stringify(bad));
  }
});

test("every offered value survives the sanitiser unchanged", () => {
  for (const [k] of HEADING_STYLES) assert.equal(resolveHeadingStyle(k), k);
  for (const k of HEADING_SIZES) assert.equal(resolveHeadingSize(k), k);
});

test("the shipped defaults are Accent headings at the normal size, and they are valid", () => {
  assert.equal(DEFAULTS.headingStyle, "accent");
  assert.equal(DEFAULTS.headingSize, "normal");
  assert.equal(resolveHeadingStyle(DEFAULTS.headingStyle), DEFAULTS.headingStyle);
  assert.equal(resolveHeadingSize(DEFAULTS.headingSize), DEFAULTS.headingSize);
});
