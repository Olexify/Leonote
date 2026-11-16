// The pure half of PDF editing: which page ends up where, what an annotation
// looks like once it has been written down and read back, how a form field
// becomes a control, and what the file that comes out is called.
//
// These are the parts that are easy to get quietly wrong and impossible to
// spot by eye — a reorder that drops a page, a "1-3,5" that is off by one, a
// split whose parts overlap, a rounded coordinate that drifts a little every
// save, an extract that overwrites yesterday's extract.
//
// The last block runs the real pdf-lib page surgery from pdfdoc.js's recipe
// over a document built here, because "the maths is right" and "the PDF that
// comes out has those pages" are two different claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  normDeg, movePages, removePages, turnPages, parseRanges, formatRanges,
  splitAt, splitEvery, remapPages, fitScale, clampScale, visibleRange,
  currentPage, evictCanvases, packAnnot, unpackAnnot, packAnnots, unpackAnnots,
  rectsToQuads, fieldModel, fieldLabel, coerceField, changedFields,
  outputName, splitNames, sizeVerdict, MAX_PDF_BYTES, HEAVY_PDF_BYTES,
} from "../pdfcore.js";

const require = createRequire(import.meta.url);

// ── page order ──────────────────────────────────────────────────────────────

test("normDeg snaps to a quarter turn inside [0, 360)", () => {
  assert.equal(normDeg(0), 0);
  assert.equal(normDeg(-90), 270);
  assert.equal(normDeg(450), 90);
  assert.equal(normDeg(-450), 270);
  assert.equal(normDeg(89), 90);
  assert.equal(normDeg("180"), 180);
  assert.equal(normDeg(undefined), 0);
});

test("movePages: one page forward lands in front of the target", () => {
  const p = [0, 1, 2, 3, 4];
  assert.deepEqual(movePages(p, [0], 3), [1, 2, 0, 3, 4]);
  assert.deepEqual(movePages(p, [0], 5), [1, 2, 3, 4, 0]);
  assert.deepEqual(movePages(p, [4], 0), [4, 0, 1, 2, 3]);
});

test("movePages: a block keeps its own order and nothing is lost", () => {
  const p = [0, 1, 2, 3, 4, 5];
  const out = movePages(p, [1, 2], 5);
  assert.deepEqual(out, [0, 3, 4, 1, 2, 5]);
  assert.equal(out.length, p.length);
  assert.deepEqual([...out].sort((a, b) => a - b), p);
});

test("movePages: a scattered pick is gathered where it is dropped", () => {
  assert.deepEqual(movePages([0, 1, 2, 3, 4], [0, 4], 2), [1, 0, 4, 2, 3]);
});

test("movePages: dropping on itself changes nothing", () => {
  const p = [0, 1, 2, 3];
  assert.deepEqual(movePages(p, [2], 2), p);
  assert.deepEqual(movePages(p, [2], 3), p);
  assert.deepEqual(movePages(p, [], 1), p);
  assert.deepEqual(movePages(p, [9], 1), p, "an index that is not there is ignored");
});

test("movePages works on any parallel array, so rotations follow their pages", () => {
  const pages = ["a", "b", "c"];
  const rots = [0, 90, 180];
  const picks = [2];
  assert.deepEqual(movePages(pages, picks, 0), ["c", "a", "b"]);
  assert.deepEqual(movePages(rots, picks, 0), [180, 0, 90]);
});

test("removePages refuses to empty the document", () => {
  assert.deepEqual(removePages([0, 1, 2], [1]), [0, 2]);
  assert.deepEqual(removePages([0, 1, 2], [0, 2]), [1]);
  assert.equal(removePages([0, 1], [0, 1]), null);
  assert.equal(removePages([0], [0]), null);
});

test("turnPages only turns what was picked", () => {
  assert.deepEqual(turnPages([0, 0, 0], [1], 90), [0, 90, 0]);
  assert.deepEqual(turnPages([270, 0], [0], 90), [0, 0], "270 + 90 comes back round to 0");
  assert.deepEqual(turnPages([0, 0], [0, 1], -90), [270, 270]);
});

// ── ranges ──────────────────────────────────────────────────────────────────

test("parseRanges reads what people actually type", () => {
  assert.deepEqual(parseRanges("1-3", 10), [0, 1, 2]);
  assert.deepEqual(parseRanges("1-3, 5", 10), [0, 1, 2, 4]);
  assert.deepEqual(parseRanges("8-", 10), [7, 8, 9]);
  assert.deepEqual(parseRanges("-3", 10), [0, 1, 2]);
  assert.deepEqual(parseRanges("7", 10), [6]);
  assert.deepEqual(parseRanges("2;4", 10), [1, 3]);
  assert.deepEqual(parseRanges("3-1", 10), [2, 1, 0], "backwards is a deliberate reverse");
});

test("parseRanges never repeats a page and never leaves the document", () => {
  assert.deepEqual(parseRanges("1-3, 2, 3", 10), [0, 1, 2]);
  assert.deepEqual(parseRanges("8-20", 10), [7, 8, 9]);
  assert.deepEqual(parseRanges("0", 10), [], "there is no page zero");
  assert.deepEqual(parseRanges("", 10), []);
  assert.deepEqual(parseRanges("pages 1-2", 10), []);
  assert.deepEqual(parseRanges(null, 10), []);
});

test("formatRanges is parseRanges read back out", () => {
  assert.equal(formatRanges([0, 1, 2, 4, 7, 8]), "1-3, 5, 8-9");
  assert.equal(formatRanges([3]), "4");
  assert.equal(formatRanges([]), "");
  assert.equal(formatRanges([2, 0, 1]), "1-3", "order does not matter to a label");
  const spec = formatRanges([0, 1, 2, 4]);
  assert.deepEqual(parseRanges(spec, 10), [0, 1, 2, 4], "round trip");
});

// ── splitting ───────────────────────────────────────────────────────────────

test("splitAt cuts where asked and covers every page exactly once", () => {
  const parts = splitAt(9, [4, 7]);
  assert.deepEqual(parts, [[0, 1, 2], [3, 4, 5], [6, 7, 8]]);
  assert.deepEqual(parts.flat(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("splitAt: page 1 always starts the first part", () => {
  assert.deepEqual(splitAt(4, [1]), [[0, 1, 2, 3]]);
  assert.deepEqual(splitAt(4, []), [[0, 1, 2, 3]]);
  assert.deepEqual(splitAt(4, [3, 3]), [[0, 1], [2, 3]], "a repeated mark is one cut");
  assert.deepEqual(splitAt(4, [9]), [[0, 1, 2, 3]], "a mark past the end is ignored");
  assert.deepEqual(splitAt(0, [2]), []);
});

test("splitEvery leaves the short part at the end", () => {
  assert.deepEqual(splitEvery(10, 4), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
  assert.deepEqual(splitEvery(6, 3), [[0, 1, 2], [3, 4, 5]]);
  assert.deepEqual(splitEvery(3, 1), [[0], [1], [2]]);
  assert.deepEqual(splitEvery(3, 0), [[0], [1], [2]], "0 would never finish; treat it as 1");
  assert.deepEqual(splitEvery(3, 99), [[0, 1, 2]]);
});

test("remapPages carries per-page data through a move or a delete", () => {
  const m = new Map([[0, "a"], [1, "b"], [2, "c"]]);
  assert.deepEqual([...remapPages(m, [2, 0, 1])], [[0, "c"], [1, "a"], [2, "b"]]);
  assert.deepEqual([...remapPages(m, [0, 2])], [[0, "a"], [1, "c"]], "page 2's marks go with it");
  assert.deepEqual([...remapPages(m, [1])], [[0, "b"]]);
  assert.deepEqual([...remapPages(m, [-1, 0])], [[1, "a"]], "an inserted page starts blank");
});

// ── zoom and virtualization ─────────────────────────────────────────────────

test("fitScale fits the width, the whole page, or a plain number", () => {
  assert.equal(fitScale("width", 600, 800, 640, 900, 40), 1);
  assert.equal(fitScale("page", 600, 800, 640, 900, 40), 1, "width is the tighter of the two here");
  assert.equal(fitScale("page", 600, 900, 640, 500, 40), 460 / 900, "a short window fits the height instead");
  assert.equal(fitScale(2, 600, 800, 640, 900), 2);
  assert.equal(fitScale("nonsense", 600, 800, 640, 900), 1);
  assert.equal(clampScale(99), 6);
  assert.equal(clampScale(0), 0.1);
});

test("visibleRange keeps a screen of slack and never returns nothing", () => {
  const tops = [0, 100, 200, 300, 400];
  const hs = [100, 100, 100, 100, 100];
  assert.deepEqual(visibleRange(tops, hs, 0, 100, 0), [0, 1]);
  assert.deepEqual(visibleRange(tops, hs, 210, 100, 0), [2, 3]);
  assert.deepEqual(visibleRange(tops, hs, 210, 100, 1), [1, 4], "a screen of slack either side");
  assert.deepEqual(visibleRange(tops, hs, 99999, 100, 0), [4, 4], "past the end still draws a page");
  assert.deepEqual(visibleRange([], [], 0, 100), [0, -1]);
});

test("currentPage is the page under the reader's eye, not the top edge", () => {
  const tops = [0, 100, 200];
  const hs = [100, 100, 100];
  assert.equal(currentPage(tops, hs, 0, 100), 0);
  assert.equal(currentPage(tops, hs, 80, 100), 1, "page two already fills most of the view");
  assert.equal(currentPage(tops, hs, 200, 100), 2);
});

test("evictCanvases drops the furthest first and never what is on screen", () => {
  const px = new Map([[0, 10], [1, 10], [2, 10], [3, 10], [4, 10], [9, 10]]);
  assert.deepEqual(evictCanvases(px, 3, 4, 100), [], "under budget, keep everything");
  const drop = evictCanvases(px, 3, 4, 30);
  assert.deepEqual(drop, [9, 0, 1], "9 is furthest, then 0, then 1");
  assert.ok(!drop.includes(3) && !drop.includes(4));
  const tight = evictCanvases(px, 3, 4, 1);
  assert.deepEqual(tight.sort((a, b) => a - b), [0, 1, 2, 9], "even over budget, on-screen pages stay");
});

// ── annotation records ──────────────────────────────────────────────────────

const HL = { id: "a1", type: "highlight", page: 2, color: "#F6E05E", opacity: 0.42, quads: [[10.1234, 20.5, 80, 12]], text: "look here", author: "me", created: "2026-09-18T10:00:00" };

test("packAnnot rounds, lowercases and keeps only what it knows", () => {
  const p = packAnnot({ ...HL, junk: "no", quads: [[10.12345, 20.5, 80, 12]] });
  assert.equal(p.color, "#f6e05e");
  assert.deepEqual(p.quads, [[10.123, 20.5, 80, 12]]);
  assert.equal(p.junk, undefined);
  assert.equal(p.page, 2);
});

test("an annotation record survives a save and a reload unchanged", () => {
  const once = packAnnot(HL);
  const twice = packAnnot(unpackAnnot(JSON.parse(JSON.stringify(once))));
  assert.deepEqual(twice, once);
  // and a third pass still does not drift
  assert.deepEqual(packAnnot(unpackAnnot(twice)), once);
});

test("every kind of mark round-trips", () => {
  const kinds = [
    { id: "i", type: "ink", color: "#ff0000", width: 3, strokes: [[[1, 2], [3.00049, 4]]] },
    { id: "n", type: "note", color: "#68d391", rect: [10, 10, 22, 22], text: "why?", fontSize: 12 },
    { id: "t", type: "text", color: "#1a202c", rect: [10, 10, 200, 40], text: "a caption", fontSize: 14 },
    { id: "r", type: "rect", color: "#63b3ed", width: 2, rect: [1, 2, 30, 40], fill: "#FFFFFF" },
    { id: "e", type: "ellipse", color: "#63b3ed", width: 2, rect: [1, 2, 30, 40] },
    { id: "w", type: "arrow", color: "#fc8181", width: 2, rect: [1, 2, 30, -40] },
    { id: "s", type: "stamp", rect: [1, 2, 120, 40], image: "data:image/png;base64,AAA" },
    { id: "u", type: "underline", color: "#000000", quads: [[1, 2, 30, 8]] },
    { id: "k", type: "strike", color: "#000000", quads: [[1, 2, 30, 8]] },
  ];
  for (const k of kinds) {
    const once = packAnnot(k);
    assert.ok(once, `${k.type} should pack`);
    assert.deepEqual(packAnnot(unpackAnnot(once)), once, `${k.type} should round-trip`);
  }
});

test("a record that cannot be drawn is refused rather than half-saved", () => {
  assert.equal(packAnnot(null), null);
  assert.equal(packAnnot({ id: "x", type: "wat", page: 0 }), null);
  assert.equal(packAnnot({ type: "highlight", quads: [[1, 2, 3, 4]] }), null, "no id");
  assert.equal(packAnnot({ id: "x", type: "highlight", quads: [] }), null, "no quads");
  assert.equal(packAnnot({ id: "x", type: "highlight", quads: [[1, 2, 0, 5]] }), null, "a quad with no width");
  assert.equal(packAnnot({ id: "x", type: "ink", strokes: [] }), null);
  assert.equal(packAnnot({ id: "x", type: "rect", rect: [1, 2] }), null);
  assert.equal(packAnnot({ id: "x", type: "stamp", rect: [1, 2, 3, 4] }), null, "a stamp needs a picture");
  assert.equal(unpackAnnot("nope"), null);
});

test("out-of-range numbers are clamped, not trusted", () => {
  assert.equal(packAnnot({ ...HL, opacity: 9 }).opacity, 1);
  assert.equal(packAnnot({ ...HL, opacity: -1 }).opacity, 0.05);
  assert.equal(packAnnot({ id: "i", type: "ink", width: 900, strokes: [[[0, 0]]] }).width, 48);
  assert.equal(packAnnot({ id: "i", type: "ink", width: 0, strokes: [[[0, 0]]] }).width, 0.5);
  assert.equal(packAnnot({ ...HL, color: "red" }).color, "#e0a84a", "a colour we cannot write becomes the default");
  assert.equal(packAnnot({ ...HL, page: -4 }).page, 0);
});

test("a whole sheet of marks round-trips, and empty pages disappear", () => {
  const m = new Map([[0, [HL]], [1, []], [3, [{ id: "b", type: "underline", color: "#000000", quads: [[1, 2, 3, 4]] }]]]);
  const json = packAnnots(m);
  assert.deepEqual(Object.keys(json), ["0", "3"]);
  const back = unpackAnnots(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(packAnnots(back), json);
  assert.equal(back.get(0)[0].text, "look here");
});

test("rectsToQuads drops the hairlines a text selection leaves behind", () => {
  const q = rectsToQuads([{ x: 1, y: 2, w: 30, h: 9 }, { x: 5, y: 5, w: 0.2, h: 9 }, { x: 5, y: 5, w: 9, h: 0.1 }]);
  assert.deepEqual(q, [[1, 2, 30, 9]]);
});

// ── forms ───────────────────────────────────────────────────────────────────

const RAW = [
  { ctor: "PDFTextField", name: "customer.full_name", value: "Ada", multiline: false, maxLength: 40 },
  { ctor: "PDFTextField", name: "notes", value: "", multiline: true },
  { ctor: "PDFCheckBox", name: "agreeTerms", value: true },
  { ctor: "PDFDropdown", name: "country", value: "UK", options: ["UK", "DE", "FR"] },
  { ctor: "PDFOptionList", name: "langs", value: ["en"], options: ["en", "de"] },
  { ctor: "PDFRadioGroup", name: "plan", value: "pro", options: ["free", "pro"] },
  { ctor: "PDFButton", name: "submit" },
  { ctor: "PDFSignature", name: "sig" },
  { ctor: "PDFTextField", name: "ref", value: "R-1", readOnly: true },
];

test("fieldModel keeps what can be filled and drops what cannot", () => {
  const m = fieldModel(RAW);
  assert.deepEqual(m.map((f) => f.kind), ["text", "text", "check", "choice", "list", "radio", "text"]);
  assert.ok(!m.some((f) => f.name === "submit" || f.name === "sig"), "a button and a signature are not fields to type in");
  assert.deepEqual(m.map((f) => f.key), ["f0", "f1", "f2", "f3", "f4", "f5", "f8"], "keys follow the document, not the list");
  assert.equal(m[0].maxLength, 40);
  assert.equal(m[1].multiline, true);
  assert.equal(m[6].readOnly, true);
  assert.deepEqual(m[3].options, ["UK", "DE", "FR"]);
  assert.equal(fieldModel(null).length, 0);
});

test("a field's label is the human end of its name", () => {
  assert.equal(fieldLabel("customer.full_name", 0), "Full name");
  assert.equal(fieldLabel("dateOfBirth", 0), "Date Of Birth");
  assert.equal(fieldLabel("shipping-address", 0), "Shipping address");
  assert.equal(fieldLabel("", 4), "Field 5");
  assert.equal(fieldLabel(undefined, 0), "Field 1");
});

test("coerceField forces a value into what the field can hold", () => {
  assert.equal(coerceField("check", "Yes"), true);
  assert.equal(coerceField("check", "off"), false);
  assert.equal(coerceField("text", 42), "42");
  assert.equal(coerceField("text", null), "");
  assert.deepEqual(coerceField("list", "en", ["en", "de"]), ["en"]);
  assert.deepEqual(coerceField("list", ["en", "xx"], ["en", "de"]), ["en"], "an option the PDF does not offer is dropped");
  assert.equal(coerceField("choice", "ZZ", ["UK", "DE"]), "", "so is an impossible choice");
  assert.equal(coerceField("choice", "UK", ["UK", "DE"]), "UK");
});

test("changedFields reports only what the reader really changed", () => {
  const m = fieldModel(RAW);
  assert.deepEqual(changedFields(m, {}), []);
  assert.deepEqual(changedFields(m, { f0: "Ada" }), [], "typing the same thing back is not a change");
  assert.deepEqual(changedFields(m, { f0: "Grace" }), [{ name: "customer.full_name", kind: "text", value: "Grace" }]);
  assert.deepEqual(changedFields(m, { f2: false }), [{ name: "agreeTerms", kind: "check", value: false }]);
  assert.deepEqual(changedFields(m, { f4: ["en"] }), [], "same list, same order");
  assert.deepEqual(changedFields(m, { f4: ["en", "de"] }).length, 1);
  assert.deepEqual(changedFields(m, { f8: "anything" }), [], "a read-only field is never written");
});

// ── naming what comes out ───────────────────────────────────────────────────

const taken = (...paths) => new Set(paths);

test("outputName puts the new file beside the old one", () => {
  assert.equal(outputName(taken(), "Projects/brief.pdf", "pages 1-3"), "Projects/brief (pages 1-3).pdf");
  assert.equal(outputName(taken(), "brief.pdf", "edited"), "brief (edited).pdf");
  assert.equal(outputName(taken(), "Projects/brief.pdf", "page 2", "png"), "Projects/brief (page 2).png");
  assert.equal(outputName(taken(), "Projects/brief.pdf", ""), "Projects/brief.pdf");
});

test("outputName never overwrites yesterday's extract", () => {
  const t = taken("brief (edited).pdf", "brief (edited) 2.pdf");
  assert.equal(outputName(t, "brief.pdf", "edited"), "brief (edited) 3.pdf");
});

test("outputName copes with a name that has no extension or a dotted folder", () => {
  assert.equal(outputName(taken(), "notes", "edited"), "notes (edited).pdf");
  assert.equal(outputName(taken(), "my.docs/brief", "edited"), "my.docs/brief (edited).pdf");
});

test("splitNames are unique among themselves, not just against the vault", () => {
  const parts = splitAt(6, [3, 5]);
  const names = splitNames(taken(), "Docs/report.pdf", parts);
  assert.deepEqual(names, [
    "Docs/report (part 1 · pages 1-2).pdf",
    "Docs/report (part 2 · pages 3-4).pdf",
    "Docs/report (part 3 · pages 5-6).pdf",
  ]);
  assert.equal(new Set(names).size, names.length);
  const clash = splitNames(taken("a (part 1 · pages 1).pdf"), "a.pdf", [[0], [1]]);
  assert.equal(clash[0], "a (part 1 · pages 1) 2.pdf");
});

test("sizeVerdict draws the line below what the backend will write", () => {
  assert.equal(sizeVerdict(1024), "ok");
  assert.equal(sizeVerdict(HEAVY_PDF_BYTES + 1), "heavy");
  assert.equal(sizeVerdict(MAX_PDF_BYTES + 1), "refuse");
  assert.ok(MAX_PDF_BYTES < 100 * 1024 * 1024, "a file that opens must also be one that can be saved");
});

// ── the maths against real PDFs ─────────────────────────────────────────────
//
// pdfdoc.js cannot be imported here (it is browser ESM and pulls in pdf-lib's
// bundler build), so these run the same recipe through pdf-lib's CommonJS
// build: pick pages with `movePages`/`parseRanges`, then rebuild the page tree
// in place exactly as `applyOrder` does.

const pdfLib = () => require("pdf-lib");

async function makeDoc(pages, { form = false } = {}) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([300, 400]);
    p.drawText(`Page ${i + 1}`, { x: 24, y: 340, size: 22, font, color: rgb(0.1, 0.1, 0.12) });
  }
  if (form) {
    const f = doc.getForm();
    const t = f.createTextField("customer.full_name");
    t.setText("Ada");
    t.addToPage(doc.getPage(0), { x: 24, y: 60, width: 200, height: 22 });
  }
  return doc.save();
}

/** The body of pdfdoc.applyOrder, run under node. */
async function applyOrder(bytes, order, extraRot) {
  const { PDFDocument, degrees } = pdfLib();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  const pages = doc.getPages();
  const picked = order.map((i) => pages[i]);
  picked.forEach((p, k) => {
    const extra = extraRot ? extraRot[k] || 0 : 0;
    if (extra) p.setRotation(degrees(normDeg(p.getRotation().angle + extra)));
  });
  doc.addPage([1, 1]);
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  picked.forEach((p, k) => doc.insertPage(k, p));
  doc.removePage(doc.getPageCount() - 1);
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

const textOfPages = async (bytes) => {
  const { PDFDocument } = pdfLib();
  const doc = await PDFDocument.load(bytes);
  return { count: doc.getPageCount(), rots: doc.getPages().map((p) => p.getRotation().angle) };
};

test("a reorder plan produces a PDF with exactly those pages", async () => {
  const base = await makeDoc(5);
  const order = movePages([0, 1, 2, 3, 4], [0], 3);
  assert.deepEqual(order, [1, 2, 0, 3, 4]);
  const out = await applyOrder(base, order, null);
  const got = await textOfPages(out);
  assert.equal(got.count, 5);
});

test("deleting pages and turning the survivors comes out as one document", async () => {
  const base = await makeDoc(5);
  const left = removePages([0, 1, 2, 3, 4], [1, 3]);
  assert.deepEqual(left, [0, 2, 4]);
  const out = await applyOrder(base, left, [90, 0, 180]);
  const got = await textOfPages(out);
  assert.equal(got.count, 3);
  assert.deepEqual(got.rots, [90, 0, 180]);
});

test("extracting '2-3,5' gives three pages in that order", async () => {
  const base = await makeDoc(6);
  const picks = parseRanges("2-3, 5", 6);
  assert.deepEqual(picks, [1, 2, 4]);
  const out = await applyOrder(base, picks, null);
  assert.equal((await textOfPages(out)).count, 3);
});

test("a split covers the whole document and nothing twice", async () => {
  const base = await makeDoc(7);
  const parts = splitEvery(7, 3);
  assert.deepEqual(parts, [[0, 1, 2], [3, 4, 5], [6]]);
  let total = 0;
  for (const part of parts) total += (await textOfPages(await applyOrder(base, part, null))).count;
  assert.equal(total, 7);
});

test("rebuilding the page tree in place keeps the form fields", async () => {
  const base = await makeDoc(4, { form: true });
  const { PDFDocument } = pdfLib();
  const out = await applyOrder(base, [3, 0, 2], [90, 0, 0]);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 3);
  assert.deepEqual(doc.getForm().getFields().map((f) => f.getName()), ["customer.full_name"]);
  assert.equal(doc.getPage(0).getRotation().angle, 90);
});

test("filling a field writes the value, and only that field", async () => {
  const base = await makeDoc(2, { form: true });
  const { PDFDocument } = pdfLib();
  const doc = await PDFDocument.load(base);
  const model = fieldModel([{ ctor: "PDFTextField", name: "customer.full_name", value: "Ada" }]);
  const changes = changedFields(model, { f0: "Grace Hopper" });
  assert.equal(changes.length, 1);
  for (const c of changes) doc.getForm().getTextField(c.name).setText(String(c.value));
  const out = await doc.save();
  const back = await PDFDocument.load(out);
  assert.equal(back.getForm().getTextField("customer.full_name").getText(), "Grace Hopper");
});
