// Spreadsheet formulas: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, Unsupported, FN_HELP } from "../formula.js";

// A1=1 A2=2 A3=3, B1="x", B2 empty
const grid = { "1,1": 1, "2,1": 2, "3,1": 3, "1,2": "x" };
const get = (r, c) => grid[`${r},${c}`] ?? null;
const ev = (f) => evaluate(f, get);

test("formulas: arithmetic, cells, ranges, functions", () => {
  assert.equal(ev("1+2*3"), 7);
  assert.equal(ev("(1+2)*3"), 9);
  assert.equal(ev("2^3"), 8);
  assert.equal(ev("-A1+A3"), 2);
  assert.equal(ev("50%"), 0.5);
  assert.equal(ev("SUM(A1:A3)"), 6);
  assert.equal(ev("sum($A$1:A3, 4)"), 10);
  assert.equal(ev("AVERAGE(A1:A3)"), 2);
  assert.equal(ev("MAX(A1:A3)-MIN(A1:A3)"), 2);
  assert.equal(ev("COUNT(A1:B3)"), 3);
  assert.equal(ev("COUNTA(A1:B3)"), 4);
  assert.equal(ev("ROUND(2/3, 2)"), 0.67);
  assert.equal(ev('IF(A3>A1, "up", "down")'), "up");
  assert.equal(ev('B1&"-"&A2'), "x-2");
  assert.equal(ev("A1=1"), true);
  assert.equal(ev("B2+1"), 1); // empty counts as 0
});

test("formulas: errors as Excel shows them; the unknown is not ours", () => {
  assert.deepEqual(ev("A1/0"), { error: "#DIV/0!" });
  assert.deepEqual(ev("B1+1"), { error: "#VALUE!" });
  assert.equal(ev("IFERROR(A1/0, 0)"), 0);
  assert.throws(() => ev("OFFSET(A1, 1, 1)"), Unsupported);
  assert.throws(() => ev("Sheet2!A1"), Unsupported);
});

test("every suggested function is one this works out", () => {
  for (const name of Object.keys(FN_HELP)) {
    try { evaluate(`${name}(1, 1)`, () => 0); } catch (e) { assert.ok(!(e instanceof Unsupported), name); }
  }
});

test("lookups and conditional sums", () => {
  // A: fruit, B: amount, C: price  (rows 1-4)
  const t = { "1,1": "apple", "1,2": 3, "1,3": 1.5, "2,1": "pear", "2,2": 5, "2,3": 2, "3,1": "plum", "3,2": 2, "3,3": 4, "4,1": "apricot", "4,2": 7, "4,3": 1 };
  const e = (f) => evaluate(f, (r, c) => t[`${r},${c}`] ?? null);
  assert.equal(e('VLOOKUP("pear", A1:C4, 3, FALSE)'), 2);
  assert.deepEqual(e('VLOOKUP("kiwi", A1:C4, 2, FALSE)'), { error: "#N/A" });
  assert.deepEqual(e('VLOOKUP("pear", A1:C4, 4, FALSE)'), { error: "#REF!" });
  assert.equal(e("VLOOKUP(4, B1:C4, 2)"), 1.5); // approximate: the last one not above 4 in a list read as sorted
  assert.equal(e('SUMIF(A1:A4, "ap*", B1:B4)'), 10);
  assert.equal(e('SUMIF(B1:B4, ">2")'), 15);
  assert.equal(e('COUNTIF(B1:B4, "<>5")'), 3);
  assert.equal(e('COUNTIFS(A1:A4, "a*", B1:B4, ">3")'), 1);
  assert.equal(e('SUMIFS(C1:C4, A1:A4, "p*", B1:B4, ">=2")'), 6);
  assert.equal(e('AVERAGEIF(A1:A4, "apple", B1:B4)'), 3);
  assert.equal(e('MATCH("plum", A1:A4, 0)'), 3);
  assert.equal(e("INDEX(A1:C4, 2, 3)"), 2);
  assert.equal(e('INDEX(A1:C4, MATCH("plum", A1:A4, 0), 2)'), 2);
  assert.equal(e('XLOOKUP("apricot", A1:A4, C1:C4)'), 1);
  assert.equal(e('XLOOKUP("kiwi", A1:A4, C1:C4, "none")'), "none");
  assert.equal(e("HLOOKUP(3, B1:C2, 2, FALSE)"), 5);
  assert.equal(e("MEDIAN(B1:B4)"), 4);
});

test("wildcard criteria stay fast on a criterion built to backtrack", () => {
  const long = "a".repeat(5000);
  const t0 = Date.now();
  assert.equal(evaluate(`COUNTIF(A1, "${"*a".repeat(30)}*b")`, () => long), 0);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(evaluate('COUNTIF(A1, "a?c*")', () => "abcdef"), 1);
});
