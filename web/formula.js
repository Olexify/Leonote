// Spreadsheet formulas: the everyday part of Excel's language, worked out in
// the table (Excel files and CSV). Numbers, text in "quotes", TRUE/FALSE,
// cells (A1, $B$2) and ranges (A1:C9), + - * / ^ & % and comparisons, and a
// short list of functions. Anything else - another sheet, a function not here -
// is "not mine": the caller keeps what Excel last worked out, so a workbook
// never gets worse for being opened here.

export class Unsupported extends Error {}
const err = (e) => ({ error: e });
const isErr = (v) => v && typeof v === "object" && "error" in v;

const colNum = (s) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; };

/* ── reading it ── */
function tokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let s = "";
      i++;
      while (i < src.length) { if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; } s += src[i++]; }
      out.push({ t: "str", v: s });
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const ref = /^(\$?[A-Za-z]{1,3}\$?\d+)(:\$?[A-Za-z]{1,3}\$?\d+)?(?![A-Za-z0-9_(])/.exec(src.slice(i));
    if (ref) { out.push({ t: "ref", v: ref[0].replace(/\$/g, "").toUpperCase() }); i += ref[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (word) {
      const w = word[0].toUpperCase();
      i += word[0].length;
      if (src[i] === "!") throw new Unsupported("another sheet"); // Sheet2!A1
      out.push(w === "TRUE" || w === "FALSE" ? { t: "bool", v: w === "TRUE" } : { t: "name", v: w });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>%(),;".includes(c)) { out.push({ t: c === "," || c === ";" ? "sep" : "op", v: c }); i++; continue; }
    if (c === "!" || c === "'" || c === "[" || c === "{") throw new Unsupported(c);
    throw new Unsupported("unexpected " + c);
  }
  return out;
}

function parse(src) {
  const tk = tokens(src);
  let p = 0;
  const peek = () => tk[p];
  const take = (v) => { const t = tk[p]; if (!t || (v && t.v !== v)) throw new Unsupported("syntax"); p++; return t; };
  const binary = (next, ops) => () => {
    let left = next();
    while (peek() && peek().t === "op" && ops.includes(peek().v)) { const op = take().v; left = { op, a: left, b: next() }; }
    return left;
  };
  const primary = () => {
    const t = peek();
    if (!t) throw new Unsupported("syntax");
    if (t.t === "op" && (t.v === "-" || t.v === "+")) { take(); const x = power(); return t.v === "-" ? { op: "neg", a: x } : x; }
    if (t.t === "op" && t.v === "(") { take(); const x = compare(); take(")"); return x; }
    take();
    if (t.t === "num" || t.t === "str" || t.t === "bool") return { lit: t.v };
    if (t.t === "ref") return { ref: t.v };
    if (t.t === "name") {
      if (!peek() || peek().v !== "(") throw new Unsupported("name " + t.v);
      take("(");
      const args = [];
      if (peek() && peek().v !== ")") { args.push(compare()); while (peek() && peek().t === "sep") { take(); args.push(compare()); } }
      take(")");
      return { fn: t.v, args };
    }
    throw new Unsupported("syntax");
  };
  const percent = () => { let x = primary(); while (peek() && peek().v === "%") { take(); x = { op: "%", a: x }; } return x; };
  const power = binary(percent, ["^"]);
  const product = binary(power, ["*", "/"]);
  const sum = binary(product, ["+", "-"]);
  const concat = binary(sum, ["&"]);
  const compare = binary(concat, ["=", "<>", "<", ">", "<=", ">="]);
  const tree = compare();
  if (p !== tk.length) throw new Unsupported("syntax");
  return tree;
}

/* ── working it out ── */
const num = (v) => {
  if (isErr(v)) throw v;
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime() / 864e5 + 25569; // Excel's day number
  const n = Number(String(v).trim());
  if (String(v).trim() !== "" && Number.isFinite(n)) return n;
  throw err("#VALUE!");
};
const text = (v) => { if (isErr(v)) throw v; return v == null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v); };
const truth = (v) => { if (isErr(v)) throw v; return typeof v === "string" ? v.toUpperCase() === "TRUE" : !!num(v); };
const flat = (vals) => vals.flat(Infinity);
// the numbers among a range's values (text and blanks skipped, as Excel does); a number typed straight in counts
const numbers = (args) => flat(args.map((a) => (Array.isArray(a) ? a.filter((x) => typeof x === "number" || isErr(x)) : [a]))).map(num);

/* ── criteria and tables, for the *IF(S) and lookup functions ── */
const asRange = (v) => { if (Array.isArray(v)) return v; const a = [v]; a.cols = 1; return a; };
const rowsOf = (v) => { const a = asRange(v), w = a.cols || 1, out = []; for (let i = 0; i < a.length; i += w) out.push(a.slice(i, i + w)); return out; };
const isNum = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
/** "app*" / "?at" against a text: * any run, ? one character. Linear (two pointers, back to the last *),
 *  never a RegExp - a criterion from a shared sheet like "*a*a*a*b" must not hang the app. */
function glob(s, p) {
  let i = 0, j = 0, star = -1, mark = 0;
  while (i < s.length) {
    if (j < p.length && (p[j] === "?" || p[j] === s[i])) { i++; j++; }
    else if (j < p.length && p[j] === "*") { star = j++; mark = i; }
    else if (star >= 0) { j = star + 1; i = ++mark; }
    else return false;
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}
/** Whether a cell meets a criterion as Excel writes them: 5, "apple", ">5", "<>0", "<=x", "app*", "?at". */
function meets(v, crit) {
  if (isErr(v)) return false;
  let op = "=", rhs = crit;
  if (typeof crit === "string") { const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(crit); op = m[1] || "="; rhs = m[2]; }
  if (isNum(rhs) && (op !== "=" && op !== "<>" ? true : isNum(v))) {
    if (!isNum(v)) return op === "<>";
    const a = Number(v), b = Number(rhs);
    return op === "=" ? a === b : op === "<>" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
  }
  const a = v == null ? "" : String(typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v).toLowerCase();
  const b = String(typeof rhs === "boolean" ? (rhs ? "TRUE" : "FALSE") : rhs ?? "").toLowerCase();
  if (op === "=" || op === "<>") {
    const same = /[*?]/.test(b) ? glob(a, b) : a === b;
    return op === "=" ? same : !same;
  }
  const c = a < b ? -1 : a > b ? 1 : 0;
  return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
}
/** The positions in each range that meet every (range, criterion) pair. */
function picked(pairs) {
  const ranges = pairs.map(([r]) => asRange(r));
  const n = ranges[0].length;
  if (ranges.some((r) => r.length !== n)) throw err("#VALUE!");
  const out = [];
  for (let i = 0; i < n; i++) if (pairs.every(([, c], k) => meets(ranges[k][i], c))) out.push(i);
  return out;
}
const pairsOf = (args) => { const out = []; for (let i = 0; i + 1 < args.length; i += 2) out.push([args[i], args[i + 1]]); if (!out.length || args.length % 2) throw err("#VALUE!"); return out; };
const sumAt = (range, idx) => idx.reduce((s, i) => s + (typeof range[i] === "number" ? range[i] : 0), 0);
const avgAt = (range, idx) => { const n = idx.filter((i) => typeof range[i] === "number"); if (!n.length) throw err("#DIV/0!"); return sumAt(range, n) / n.length; };
/** Where `v` is in a list: exact (0), the largest not above it in a sorted list (1), the smallest not below it (-1). */
function findIn(list, v, mode) {
  if (mode === 0) { const i = list.findIndex((x) => (typeof v === "string" && /[*?]/.test(v) ? meets(x, v) : x != null && x !== "" && cmp(x, v) === 0)); if (i < 0) throw err("#N/A"); return i; }
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    if (x == null || x === "") continue;
    const c = cmp(x, v);
    if (mode > 0 ? c <= 0 : c >= 0) best = i; else break;
  }
  if (best < 0) throw err("#N/A");
  return best;
}

const FN = {
  SUM: (a) => numbers(a).reduce((s, x) => s + x, 0),
  AVERAGE: (a) => { const n = numbers(a); if (!n.length) throw err("#DIV/0!"); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (a) => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => flat(a).filter((x) => typeof x === "number").length,
  COUNTA: (a) => flat(a).filter((x) => x != null && x !== "").length,
  COUNTBLANK: (a) => flat(a).filter((x) => x == null || x === "").length,
  PRODUCT: (a) => numbers(a).reduce((s, x) => s * x, 1),
  ROUND: ([x, d]) => { const k = 10 ** num(d ?? 0); return Math.round(num(x) * k) / k; },
  ROUNDUP: ([x, d]) => { const k = 10 ** num(d ?? 0); const v = num(x) * k; return (v < 0 ? -Math.ceil(-v) : Math.ceil(v)) / k; },
  ROUNDDOWN: ([x, d]) => { const k = 10 ** num(d ?? 0); return Math.trunc(num(x) * k) / k; },
  INT: ([x]) => Math.floor(num(x)),
  ABS: ([x]) => Math.abs(num(x)),
  SQRT: ([x]) => { const v = num(x); if (v < 0) throw err("#NUM!"); return Math.sqrt(v); },
  POWER: ([x, y]) => num(x) ** num(y),
  MOD: ([x, y]) => { const d = num(y); if (!d) throw err("#DIV/0!"); const v = num(x); return v - d * Math.floor(v / d); },
  IF: ([c, a, b]) => (truth(c) ? (a ?? true) : (b ?? false)),
  IFERROR: () => { throw new Unsupported("lazy"); }, // worked out in call(), before its arguments throw
  AND: (a) => flat(a).every(truth),
  OR: (a) => flat(a).some(truth),
  NOT: ([x]) => !truth(x),
  CONCAT: (a) => flat(a).map(text).join(""),
  CONCATENATE: (a) => flat(a).map(text).join(""),
  LEN: ([x]) => text(x).length,
  UPPER: ([x]) => text(x).toUpperCase(),
  LOWER: ([x]) => text(x).toLowerCase(),
  TRIM: ([x]) => text(x).trim().replace(/\s+/g, " "),
  LEFT: ([x, n]) => text(x).slice(0, num(n ?? 1)),
  RIGHT: ([x, n]) => { const s = text(x); return s.slice(Math.max(0, s.length - num(n ?? 1))); },
  SUMIF: ([range, crit, sum]) => sumAt(asRange(sum ?? range), picked([[range, crit]])),
  SUMIFS: ([sum, ...rest]) => sumAt(asRange(sum), picked(pairsOf(rest))),
  COUNTIF: ([range, crit]) => picked([[range, crit]]).length,
  COUNTIFS: (args) => picked(pairsOf(args)).length,
  AVERAGEIF: ([range, crit, avg]) => avgAt(asRange(avg ?? range), picked([[range, crit]])),
  AVERAGEIFS: ([avg, ...rest]) => avgAt(asRange(avg), picked(pairsOf(rest))),
  VLOOKUP: ([v, table, col, approx]) => {
    const rows = rowsOf(table), k = num(col);
    if (k < 1 || k > (rows[0] || []).length) throw err("#REF!");
    const i = findIn(rows.map((r) => r[0]), v, approx === undefined || truth(approx) ? 1 : 0);
    return rows[i][k - 1] ?? 0;
  },
  HLOOKUP: ([v, table, row, approx]) => {
    const rows = rowsOf(table), k = num(row);
    if (k < 1 || k > rows.length) throw err("#REF!");
    const i = findIn(rows[0], v, approx === undefined || truth(approx) ? 1 : 0);
    return rows[k - 1][i] ?? 0;
  },
  MATCH: ([v, range, type]) => findIn(asRange(range), v, type === undefined ? 1 : Math.sign(num(type))) + 1,
  INDEX: ([range, row, col]) => {
    const rows = rowsOf(range), wide = rows.length === 1;
    const r = wide && col === undefined ? 1 : num(row), c = wide && col === undefined ? num(row) : num(col ?? 1);
    if (r < 1 || c < 1 || r > rows.length || c > rows[0].length) throw err("#REF!");
    return rows[r - 1][c - 1] ?? 0;
  },
  XLOOKUP: ([v, look, ret, notFound]) => {
    const a = asRange(look), b = asRange(ret);
    try { return b[findIn(a, v, 0)] ?? 0; } catch (e) { if (isErr(e) && notFound !== undefined) return notFound; throw e; }
  },
  MEDIAN: (a) => { const n = numbers(a).sort((x, y) => x - y); if (!n.length) throw err("#NUM!"); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
};

const cmp = (a, b) => {
  if (typeof a === "string" || typeof b === "string") { const x = text(a).toLowerCase(), y = text(b).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return num(a) - num(b);
};

/** Each cell of a range "A1:C3", row by row: [row, col] pairs. */
export function cellsOf(range) {
  const [a, b = a] = range.split(":");
  const pa = /^([A-Z]+)(\d+)$/.exec(a), pb = /^([A-Z]+)(\d+)$/.exec(b);
  const r0 = Math.min(+pa[2], +pb[2]), r1 = Math.max(+pa[2], +pb[2]);
  const c0 = Math.min(colNum(pa[1]), colNum(pb[1])), c1 = Math.max(colNum(pa[1]), colNum(pb[1]));
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > 200000) throw new Unsupported("range too big");
  const out = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push([r, c]);
  return out;
}

/**
 * Work a formula out (without its "="). `get(row, col)` gives a cell's value
 * (a formula cell: its worked-out value). Returns a number, text, a boolean or
 * { error: "#DIV/0!" }; throws Unsupported for what it does not know.
 */
export function evaluate(src, get) {
  const tree = parse(src);
  const run = (n) => {
    if ("lit" in n) return n.lit;
    if (n.ref) {
      if (n.ref.includes(":")) {
        const cells = cellsOf(n.ref);
        const vals = cells.map(([r, c]) => get(r, c));
        vals.cols = cells.length ? cells[cells.length - 1][1] - cells[0][1] + 1 : 1; // its width: lookups read rows and columns
        return vals;
      }
      const m = /^([A-Z]+)(\d+)$/.exec(n.ref);
      const v = get(+m[2], colNum(m[1]));
      return v == null ? 0 : v; // an empty cell reads as 0 (and as "" when joined)
    }
    if (n.fn) {
      if (n.fn === "IFERROR") { try { const v = run(n.args[0]); if (isErr(v)) return n.args[1] ? run(n.args[1]) : ""; return v; } catch (e) { if (e instanceof Unsupported) throw e; return n.args[1] ? run(n.args[1]) : ""; } }
      const f = FN[n.fn];
      if (!f) throw new Unsupported(n.fn);
      return f(n.args.map(run));
    }
    const a = run(n.a);
    if (n.op === "neg") return -num(a);
    if (n.op === "%") return num(a) / 100;
    const b = run(n.b);
    switch (n.op) {
      case "+": return num(a) + num(b);
      case "-": return num(a) - num(b);
      case "*": return num(a) * num(b);
      case "/": { const d = num(b); if (!d) throw err("#DIV/0!"); return num(a) / d; }
      case "^": return num(a) ** num(b);
      case "&": return text(Array.isArray(a) ? a[0] : a) + text(Array.isArray(b) ? b[0] : b);
      case "=": return cmp(a, b) === 0;
      case "<>": return cmp(a, b) !== 0;
      case "<": return cmp(a, b) < 0;
      case ">": return cmp(a, b) > 0;
      case "<=": return cmp(a, b) <= 0;
      case ">=": return cmp(a, b) >= 0;
    }
    throw new Unsupported(n.op);
  };
  try {
    const v = run(tree);
    if (Array.isArray(v)) return v[0] ?? 0; // a bare range: its first cell
    if (typeof v === "number" && !Number.isFinite(v)) return err("#NUM!");
    return v;
  } catch (e) {
    if (isErr(e)) return e;
    throw e;
  }
}

/** The functions worked out here, each with how it is written and what it does - the spreadsheet's suggestions. */
export const FN_HELP = {
  SUM: ["SUM(number, …)", "Adds numbers and ranges"],
  AVERAGE: ["AVERAGE(number, …)", "The average of the numbers"],
  MIN: ["MIN(number, …)", "The smallest number"],
  MAX: ["MAX(number, …)", "The largest number"],
  COUNT: ["COUNT(range, …)", "How many cells hold numbers"],
  COUNTA: ["COUNTA(range, …)", "How many cells are not empty"],
  COUNTBLANK: ["COUNTBLANK(range)", "How many cells are empty"],
  PRODUCT: ["PRODUCT(number, …)", "Multiplies the numbers"],
  ROUND: ["ROUND(number, digits)", "Rounds to that many decimals"],
  ROUNDUP: ["ROUNDUP(number, digits)", "Rounds away from zero"],
  ROUNDDOWN: ["ROUNDDOWN(number, digits)", "Rounds toward zero"],
  INT: ["INT(number)", "Down to a whole number"],
  ABS: ["ABS(number)", "Without its sign"],
  SQRT: ["SQRT(number)", "The square root"],
  POWER: ["POWER(number, power)", "A number raised to a power"],
  MOD: ["MOD(number, divisor)", "What is left after dividing"],
  IF: ["IF(test, if true, if false)", "One value or another, by a test"],
  IFERROR: ["IFERROR(value, if error)", "A fallback when something fails"],
  AND: ["AND(test, …)", "TRUE when every test is"],
  OR: ["OR(test, …)", "TRUE when any test is"],
  NOT: ["NOT(test)", "The opposite of a test"],
  CONCAT: ["CONCAT(text, …)", "Joins texts together"],
  CONCATENATE: ["CONCATENATE(text, …)", "Joins texts together (the older name)"],
  LEN: ["LEN(text)", "How many characters"],
  UPPER: ["UPPER(text)", "In capitals"],
  LOWER: ["LOWER(text)", "In small letters"],
  TRIM: ["TRIM(text)", "Without the extra spaces"],
  LEFT: ["LEFT(text, count)", "The first characters"],
  RIGHT: ["RIGHT(text, count)", "The last characters"],
  SUMIF: ["SUMIF(range, criterion, sum range)", "Adds the cells that meet a test (\">5\", \"apple\", \"a*\")"],
  SUMIFS: ["SUMIFS(sum range, range, criterion, …)", "Adds where every test is met"],
  COUNTIF: ["COUNTIF(range, criterion)", "How many cells meet a test"],
  COUNTIFS: ["COUNTIFS(range, criterion, …)", "How many rows meet every test"],
  AVERAGEIF: ["AVERAGEIF(range, criterion, average range)", "The average where a test is met"],
  AVERAGEIFS: ["AVERAGEIFS(average range, range, criterion, …)", "The average where every test is met"],
  VLOOKUP: ["VLOOKUP(value, table, column, FALSE)", "Finds a value in a table's first column, gives that row's column"],
  HLOOKUP: ["HLOOKUP(value, table, row, FALSE)", "Finds a value in a table's first row, gives that column's row"],
  XLOOKUP: ["XLOOKUP(value, look in, give from, if not found)", "Finds a value in one range, gives the same place in another"],
  MATCH: ["MATCH(value, range, 0)", "Where a value is in a range (0: exactly)"],
  INDEX: ["INDEX(range, row, column)", "The cell at that row and column"],
  MEDIAN: ["MEDIAN(number, …)", "The middle number"],
};
