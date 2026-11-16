// Pure helpers of the Word/Excel views: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spliceSegments, editSegments, needsPreserve, formatListNumber, colName,
  parseCellInput, formatNumber, formatCellValue, isDateFormat,
} from "../officeview.js";

const T = (...k) => k.map((x) => (x === "x" ? "x" : "t"));

test("editSegments: typing extends the preceding run", () => {
  const r = editSegments(["Hello ", "world"], T("t", "t"), "Hello big world");
  assert.deepEqual(r.texts, ["Hello big ", "world"]);
  assert.equal(r.target, 0);
});

test("editSegments: typing at the very start goes into the first run", () => {
  const r = editSegments(["bold", " plain"], T("t", "t"), "Xbold plain");
  assert.deepEqual(r.texts, ["Xbold", " plain"]);
});

test("editSegments: deletion across runs keeps both ends", () => {
  const r = editSegments(["abc", "def", "ghi"], T("t", "t", "t"), "abhi");
  assert.deepEqual(r.texts, ["ab", "", "hi"]);
  assert.equal(r.texts.join(""), "abhi");
});

test("editSegments: replace inside one run", () => {
  const r = editSegments(["one ", "two", " three"], T("t", "t", "t"), "one 2 three");
  assert.deepEqual(r.texts, ["one 2", "", " three"]);
});

test("spliceSegments: prefers a text run over a tab at a boundary", () => {
  const r = spliceSegments(["a", "\t", "b"], ["t", "x", "t"], 2, 2, "Z");
  assert.deepEqual(r.texts, ["a", "\t", "Zb"]);
  const r2 = spliceSegments(["\t"], ["x"], 1, 1, "Z");
  assert.deepEqual(r2.texts, ["\tZ"]);
});

test("spliceSegments: no segments → nowhere to insert", () => {
  assert.equal(spliceSegments([], [], 0, 0, "x").target, -1);
  assert.deepEqual(spliceSegments(["ab"], ["t"], 0, 2, "").texts, [""]);
});

test("editSegments: result always concatenates to the new text", () => {
  const cases = [["", "x"], ["abc", ""], ["aaa", "aa"], ["x\ty", "x\t\ty"], ["hello", "help"]];
  for (const [a, b] of cases) {
    const parts = a ? [a.slice(0, 1), a.slice(1)] : [""];
    const r = editSegments(parts, parts.map(() => "t"), b);
    assert.equal(r.texts.join(""), b, `${a} -> ${b}`);
  }
});

test("needsPreserve", () => {
  assert.equal(needsPreserve("a b"), false);
  assert.equal(needsPreserve(" a"), true);
  assert.equal(needsPreserve("a "), true);
  assert.equal(needsPreserve("a  b"), true);
});

test("formatListNumber", () => {
  assert.equal(formatListNumber(3, "decimal"), "3");
  assert.equal(formatListNumber(28, "lowerLetter"), "ab");
  assert.equal(formatListNumber(4, "upperRoman"), "IV");
  assert.equal(formatListNumber(1994, "lowerRoman"), "mcmxciv");
});

test("colName", () => {
  assert.equal(colName(1), "A");
  assert.equal(colName(26), "Z");
  assert.equal(colName(27), "AA");
  assert.equal(colName(16384), "XFD");
});

test("parseCellInput", () => {
  assert.deepEqual(parseCellInput("=SUM(A1:A3)"), { formula: "SUM(A1:A3)" });
  assert.equal(parseCellInput("42"), 42);
  assert.equal(parseCellInput("-1.5e3"), -1500);
  assert.equal(parseCellInput("12%"), 0.12);
  assert.equal(parseCellInput("true"), true);
  assert.equal(parseCellInput("FALSE"), false);
  assert.equal(parseCellInput("'42"), "42");
  assert.equal(parseCellInput(""), null);
  assert.equal(parseCellInput("="), "=");
  assert.equal(parseCellInput("hello"), "hello");
  assert.equal(parseCellInput("2024-03-05").toISOString(), "2024-03-05T00:00:00.000Z");
  assert.equal(parseCellInput("2024-02-30"), "2024-02-30");
});

test("formatNumber: general and fixed", () => {
  assert.equal(formatNumber(3, "General"), "3");
  assert.equal(formatNumber(0.1 + 0.2, "General"), "0.3");
  assert.equal(formatNumber(1234.5, "#,##0.00"), "1,234.50");
  assert.equal(formatNumber(-1234.5, "#,##0"), "-1,235");
  assert.equal(formatNumber(0.256, "0.0%"), "25.6%");
  assert.equal(formatNumber(5, "0.00"), "5.00");
  assert.equal(formatNumber(0.5, "#.##"), ".5");
  assert.equal(formatNumber(12345, "0.00E+00"), "1.23E+04");
  assert.equal(formatNumber(1500000, '#,##0,,"M"'), "2M");
});

test("formatNumber: sections, currency and literals", () => {
  assert.equal(formatNumber(-5, "#,##0;(#,##0)"), "(5)");
  assert.equal(formatNumber(0, '0;-0;"zero"'), "zero");
  assert.equal(formatNumber(9.5, '"$"#,##0.00'), "$9.50");
  assert.equal(formatNumber(9.5, "[$€-407] #,##0.00"), "€ 9.50");
  assert.equal(formatNumber(-9.5, '"$"#,##0.00'), "-$9.50");
  assert.equal(formatNumber(3, "[Red]0"), "3");
  assert.equal(formatNumber(1, '_(* #,##0_)'), " 1 ");
});

test("formatNumber: dates and times", () => {
  // 45356 = 2024-03-05
  assert.equal(formatNumber(45356, "yyyy-mm-dd"), "2024-03-05");
  assert.equal(formatNumber(45356, "m/d/yy"), "3/5/24");
  assert.equal(formatNumber(45356, "dd.mm.yyyy"), "05.03.2024");
  assert.equal(formatNumber(45356, "d mmm yyyy"), "5 Mar 2024");
  assert.equal(formatNumber(45356, "dddd, mmmm d"), "Tuesday, March 5");
  assert.equal(formatNumber(45356.75, "h:mm AM/PM"), "6:00 PM");
  assert.equal(formatNumber(45356.5104166667, "hh:mm:ss"), "12:15:00");
  assert.equal(formatNumber(1.5, "[h]:mm"), "36:00");
  assert.ok(isDateFormat("dd/mm/yyyy"));
  assert.ok(!isDateFormat("#,##0.00"));
  assert.ok(!isDateFormat("General"));
});

test("formatCellValue", () => {
  assert.equal(formatCellValue(new Date(Date.UTC(2024, 2, 5)), undefined), "2024-03-05");
  assert.equal(formatCellValue(new Date(Date.UTC(2024, 2, 5, 9, 30)), undefined), "2024-03-05 09:30");
  assert.equal(formatCellValue({ richText: [{ text: "a" }, { text: "b" }] }), "ab");
  assert.equal(formatCellValue({ text: "site", hyperlink: "http://x" }), "site");
  assert.equal(formatCellValue({ error: "#DIV/0!" }), "#DIV/0!");
  assert.equal(formatCellValue(true), "TRUE");
  assert.equal(formatCellValue(null), "");
});

import { parseCsv, toCsv, csvSeparator } from "../officeview.js";
test("CSV: quotes, separators, line breaks inside a field; written back the same", () => {
  const t = 'name,note\n"Smith, J","said ""hi""\nthen left"\nplain,1\n';
  const rows = parseCsv(t, ",");
  assert.deepEqual(rows, [["name", "note"], ["Smith, J", 'said "hi"\nthen left'], ["plain", "1"]]);
  assert.equal(toCsv(rows, ",") + "\n", t);
  assert.equal(csvSeparator("a;b;c\n1;2;3"), ";");
  assert.equal(csvSeparator("a,b\n"), ",");
  assert.equal(csvSeparator("a b", "x.tsv"), "\t");
  assert.deepEqual(parseCsv("a,b\r\n1,2", ","), [["a", "b"], ["1", "2"]]);
});
