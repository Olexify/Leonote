// Word (.docx) and Excel (.xlsx) views. JSZip and ExcelJS are imported lazily
// inside the mount functions so nothing heavy loads until such a file opens.
//
// DOCX: only word/document.xml is rewritten; every other zip entry is kept
// byte-for-byte. Each paragraph is its own contenteditable block; edits are
// diffed against the paragraph's text runs so untouched runs keep their
// formatting and non-text children (drawings, bookmarks, fields) stay put.
//
// XLSX: ExcelJS workbook model behind a virtualized grid.

import { h, keyOf } from "./util.js";
import { menu } from "./ui.js";
import { icon } from "./icons.js";
import { evaluate, Unsupported, FN_HELP } from "./formula.js";

// ── pure helpers (tested in web/tests/office.test.js) ────────────────────────

/**
 * Replace [a, b) of the concatenated segment texts with `ins`. Segments of kind
 * "t" hold text; any other kind is an atomic tab/break. Inserted text goes into
 * the segment that ends at `a` (Word extends the preceding run), falling back to
 * one that starts there. Returns new texts (same length) and the target index,
 * or target -1 when there is nowhere to put inserted text.
 */
export function spliceSegments(texts, kinds, a, b, ins) {
  const out = [];
  const starts = [];
  let pos = 0;
  for (const t of texts) { starts.push(pos); pos += t.length; }
  let target = -1;
  if (ins) {
    const inside = texts.findIndex((t, i) => starts[i] < a && a < starts[i] + t.length);
    if (inside >= 0) target = inside;
    else {
      const endsAt = (i) => starts[i] + texts[i].length === a;
      const startsAt = (i) => starts[i] === a;
      const pick = (f, back) => {
        const idx = texts.map((_, i) => i).filter(f);
        return idx.length ? (back ? idx[idx.length - 1] : idx[0]) : -1;
      };
      target = pick((i) => endsAt(i) && kinds[i] === "t", true);
      if (target < 0) target = pick((i) => startsAt(i) && kinds[i] === "t", false);
      if (target < 0) target = pick(endsAt, true);
      if (target < 0) target = pick(startsAt, false);
    }
  }
  texts.forEach((t, i) => {
    const s = starts[i], e = s + t.length;
    const before = t.slice(0, Math.max(0, Math.min(t.length, a - s)));
    const after = b < e ? t.slice(Math.max(0, b - s)) : "";
    out.push(i === target ? before + ins + after : before + after);
  });
  return { texts: out, target };
}

/** Diff old segment texts against the paragraph's new full text. */
export function editSegments(texts, kinds, next) {
  const old = texts.join("");
  let p = 0;
  const max = Math.min(old.length, next.length);
  while (p < max && old[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  return spliceSegments(texts, kinds, p, old.length - s, next.slice(p, next.length - s));
}

/** Text needs xml:space="preserve" when XML parsers would otherwise trim it. */
export const needsPreserve = (s) => /^\s|\s$|\s\s/.test(s);

const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

/** List counter in a Word numFmt. */
export function formatListNumber(n, fmt) {
  const letters = () => {
    let s = "";
    for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(97 + ((x - 1) % 26)) + s;
    return s;
  };
  const roman = () => {
    let s = "", x = n;
    for (const [v, r] of ROMAN) while (x >= v) { s += r; x -= v; }
    return s;
  };
  switch (fmt) {
    case "lowerLetter": return letters();
    case "upperLetter": return letters().toUpperCase();
    case "lowerRoman": return roman();
    case "upperRoman": return roman().toUpperCase();
    case "decimalZero": return String(n).padStart(2, "0");
    case "none": return "";
    default: return String(n);
  }
}

/** 1 → A, 27 → AA */
export function colName(n) {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** What a typed cell entry means: formula, number, boolean, date or text. */
export function parseCellInput(str) {
  if (str === "") return null;
  if (str[0] === "'") return str.slice(1);
  if (str[0] === "=" && str.length > 1) return { formula: str.slice(1) };
  const t = str.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  const d = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (d) {
    const [, y, mo, da, hh = 0, mi = 0, ss = 0] = d;
    const date = new Date(Date.UTC(+y, +mo - 1, +da, +hh, +mi, +ss));
    if (date.getUTCMonth() === +mo - 1) return date;
  }
  return str;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n, w = 2) => String(n).padStart(w, "0");

function generalNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
  const a = Math.abs(n);
  if (a >= 1e11 || a < 1e-9) return n.toExponential(5).replace(/\.?0+e/, "e").replace("e", "E").replace(/E([+-])(\d)$/, "E$10$2");
  return String(parseFloat(n.toPrecision(10)));
}

function splitSections(fmt) {
  const out = [""];
  let q = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') q = !q;
    if (ch === "\\" && !q) { out[out.length - 1] += ch + (fmt[++i] ?? ""); continue; }
    if (ch === ";" && !q) out.push("");
    else out[out.length - 1] += ch;
  }
  return out;
}

// Format code → tokens: { lit } for literal text, { code } for one format char.
function tokenize(sec) {
  const toks = [];
  sec = sec.replace(/\[\$([^\]-]*)(?:-[^\]]*)?\]/g, (_, sym) => `"${sym}"`);
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === '"') {
      const j = sec.indexOf('"', i + 1);
      const end = j < 0 ? sec.length : j;
      toks.push({ lit: sec.slice(i + 1, end) });
      i = end;
    } else if (ch === "\\") toks.push({ lit: sec[++i] ?? "" });
    else if (ch === "_") { toks.push({ lit: " " }); i++; }
    else if (ch === "*") i++;
    else if (ch === "[") {
      const j = sec.indexOf("]", i);
      const inner = sec.slice(i + 1, j < 0 ? sec.length : j);
      if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ code: inner.toLowerCase(), elapsed: true });
      i = j < 0 ? sec.length : j;
    } else if (/^(AM\/PM|A\/P)/i.test(sec.slice(i))) {
      const m = /^(AM\/PM|A\/P)/i.exec(sec.slice(i))[0];
      toks.push({ code: "ampm", short: m.length === 3 });
      i += m.length - 1;
    } else if ("0#?.,%eE+-yYmMdDhHsS".includes(ch)) toks.push({ code: ch });
    else toks.push({ lit: ch });
  }
  return toks;
}

function formatDateTokens(serial, toks) {
  const epoch = serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86400);
  if (secs >= 86400) { days++; secs -= 86400; }
  const d = new Date(epoch + days * 864e5);
  const H = Math.floor(secs / 3600), M = Math.floor(secs / 60) % 60, S = secs % 60;
  // merge runs of the same letter: y y y y → yyyy
  const parts = [];
  for (const t of toks) {
    const last = parts[parts.length - 1];
    const c = t.code?.toLowerCase();
    if (c && /^[ymdhs]$/.test(c) && last?.code && last.code[0] === c && !last.elapsed) last.code += c;
    else parts.push(c && !t.elapsed && c.length === 1 ? { ...t, code: c } : t);
  }
  const hasAmPm = parts.some((p) => p.code === "ampm");
  const dateParts = parts.filter((p) => p.code && /^[ymdhs]/.test(p.code));
  let out = "";
  parts.forEach((p) => {
    if (p.lit != null) { out += p.lit; return; }
    const c = p.code;
    if (c === "ampm") { out += (H < 12 ? "AM" : "PM").slice(0, p.short ? 1 : 2); return; }
    if (p.elapsed) {
      const total = serial * 24;
      out += c[0] === "h" ? Math.floor(total) : c[0] === "m" ? Math.floor(total * 60) : Math.floor(total * 3600);
      return;
    }
    const k = dateParts.indexOf(p);
    switch (c[0]) {
      case "y": out += c.length <= 2 ? pad(d.getUTCFullYear() % 100) : d.getUTCFullYear(); break;
      case "d":
        out += c.length === 1 ? d.getUTCDate() : c.length === 2 ? pad(d.getUTCDate())
          : c.length === 3 ? DAYS[d.getUTCDay()].slice(0, 3) : DAYS[d.getUTCDay()];
        break;
      case "h": {
        const hh = hasAmPm ? (H % 12 || 12) : H;
        out += c.length >= 2 ? pad(hh) : hh;
        break;
      }
      case "s": out += c.length >= 2 ? pad(S) : S; break;
      case "m": {
        const prev = dateParts[k - 1]?.code[0], next = dateParts[k + 1]?.code[0];
        if (c.length <= 2 && (prev === "h" || next === "s")) out += c.length === 2 ? pad(M) : M;
        else if (c.length === 1) out += d.getUTCMonth() + 1;
        else if (c.length === 2) out += pad(d.getUTCMonth() + 1);
        else if (c.length === 3) out += MONTHS[d.getUTCMonth()].slice(0, 3);
        else if (c.length === 5) out += MONTHS[d.getUTCMonth()][0];
        else out += MONTHS[d.getUTCMonth()];
        break;
      }
      default: out += c;
    }
  });
  return out;
}

function formatNumberTokens(n, toks, neg) {
  const codes = toks.filter((t) => t.code).map((t) => t.code);
  const pct = codes.filter((c) => c === "%").length;
  const dot = codes.indexOf(".");
  const ph = (c) => c === "0" || c === "#" || c === "?";
  const intCodes = dot < 0 ? codes : codes.slice(0, dot);
  const decCodes = dot < 0 ? [] : codes.slice(dot + 1).filter(ph);
  const lastPh = intCodes.map(ph).lastIndexOf(true);
  const firstPh = intCodes.findIndex(ph);
  // commas after the last integer placeholder scale by 1000 each
  const scale = dot < 0 ? intCodes.slice(lastPh + 1).filter((c) => c === ",").length : 0;
  const group = intCodes.slice(firstPh, lastPh + 1).includes(",");
  const minInt = intCodes.filter((c) => c === "0").length;
  const maxDec = decCodes.length;
  const minDec = decCodes.filter((c) => c === "0").length;
  let x = Math.abs(n) * 100 ** pct / 1000 ** scale;
  const eIdx = codes.findIndex((c) => c === "E" || c === "e");
  let num;
  if (eIdx >= 0) {
    const decs = dot >= 0 && dot < eIdx ? codes.slice(dot + 1, eIdx).filter(ph).length : 0;
    const expDigits = codes.slice(eIdx + 1).filter(ph).length || 1;
    const [m, e] = x.toExponential(decs).split("e");
    num = `${m}E${e[0] === "-" ? "-" : "+"}${pad(e.replace(/^[+-]/, ""), expDigits)}`;
  } else {
    let s = x.toFixed(maxDec);
    let [ip, fp = ""] = s.split(".");
    while (fp.length > minDec && fp.endsWith("0")) fp = fp.slice(0, -1);
    if (ip === "0" && minInt === 0) ip = "";
    ip = ip.padStart(minInt, "0");
    if (group) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    num = ip + (fp ? "." + fp : "");
    if (!num) num = "0";
  }
  let out = "", placed = false;
  for (const t of toks) {
    if (t.lit != null) out += t.lit;
    else if (t.code === "%") out += "%";
    else if (!placed && (ph(t.code) || t.code === ".")) { out += num; placed = true; }
    else if (!ph(t.code) && !".,Ee".includes(t.code) && !(eIdx >= 0 && "+-".includes(t.code))) out += t.code;
  }
  if (!placed) out += num;
  return (neg ? "-" : "") + out;
}

/** Excel number format → display text. Covers the common codes, not all. */
export function formatNumber(n, fmt) {
  if (!Number.isFinite(n)) return String(n);
  if (!fmt || /^general$/i.test(fmt) || fmt === "@") return generalNumber(n);
  const secs = splitSections(fmt);
  let sec = secs[0], neg = n < 0, x = n;
  if (n < 0 && secs[1] != null && secs[1] !== "") { sec = secs[1]; neg = false; x = -n; }
  else if (n === 0 && secs[2] != null && secs[2] !== "") sec = secs[2];
  if (/^\s*\[[<>=]/.test(sec)) return generalNumber(n);
  sec = sec.replace(/\[(black|white|red|green|blue|yellow|magenta|cyan|color\s*\d+)\]/gi, "");
  if (/^general$/i.test(sec.trim())) return (neg ? "-" : "") + generalNumber(Math.abs(x));
  const toks = tokenize(sec);
  const code = toks.filter((t) => t.code).map((t) => t.code).join("");
  if (/[ymdhs]|ampm/i.test(code)) return formatDateTokens(n, toks);
  if (!/[0#?]/.test(code)) return toks.map((t) => t.lit ?? (t.code === "%" ? "" : t.code)).join("");
  if (code.includes("/")) return generalNumber(n);
  return formatNumberTokens(Math.abs(x), toks, neg);
}

export const isDateFormat = (fmt) =>
  !!fmt && !/^general$/i.test(fmt) &&
  /[ymdhs]|ampm/i.test(tokenize(splitSections(fmt)[0]).filter((t) => t.code).map((t) => t.code).join(""));

const toSerial = (d) => d.getTime() / 864e5 + 25569;

/** Any ExcelJS cell value (not formula) → display text. */
export function formatCellValue(v, fmt) {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatNumber(v, fmt);
  if (v instanceof Date) {
    if (isNaN(v)) return "";
    const s = toSerial(v);
    return formatNumber(s, isDateFormat(fmt) ? fmt : s % 1 ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd");
  }
  if (v.error) return String(v.error);
  if (v.richText) return v.richText.map((r) => r.text).join("");
  if (v.text != null) return typeof v.text === "string" ? v.text : formatCellValue(v.text, fmt);
  return String(v);
}

// ── shared chrome ────────────────────────────────────────────────────────────

function hostSetup(el, kind, note) {
  el.classList.add("office-host", kind);
  el.replaceChildren();
  const head = h("div", { class: "office-note" }, note);
  el.append(head);
  return head;
}

function versioned(onEdit) {
  let version = 0, saved = 0;
  return {
    bump() { version++; onEdit?.(); },
    snapshot() { return version; },
    saved(v) { saved = Math.max(saved, v); },
    dirty: () => version !== saved,
    pristine: () => version === 0,
  };
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const META = new Set(["pPr", "rPr", "sdtPr", "sdtEndPr", "customXmlPr", "smartTagPr"]);
const CONTAINERS = new Set(["hyperlink", "ins", "moveTo", "smartTag", "fldSimple", "customXml", "dir", "bdo"]);
const IMAGES = new Set(["drawing", "pict", "object", "AlternateContent"]);

const isW = (n, name) => n && n.nodeType === 1 && n.namespaceURI === W && (!name || n.localName === name);
const kids = (n, name) => [...n.children].filter((c) => isW(c, name));
const kid = (n, name) => [...n.children].find((c) => isW(c, name)) || null;
const wattr = (n, name) => n?.getAttributeNS(W, name) ?? n?.getAttribute("w:" + name) ?? null;
const onOff = (n) => {
  if (!n) return false;
  const v = wattr(n, "val");
  return v == null || !/^(false|0|off|none)$/i.test(v);
};

/** Paragraph → ordered items: text segments and non-text "things" with offsets. */
function scanPara(p) {
  const segs = [], things = [], items = [];
  let off = 0, link = 0;
  const thing = (el, run) => {
    const t = { el, run, off, img: IMAGES.has(el.localName) };
    things.push(t);
    items.push(t);
  };
  const walkRun = (r) => {
    for (const ch of [...r.children]) {
      if (isW(ch, "rPr")) continue;
      let text = null, kind = "x";
      if (isW(ch, "t")) { text = ch.textContent; kind = "t"; }
      else if (isW(ch, "tab")) text = "\t";
      else if (isW(ch, "br") || isW(ch, "cr")) text = "\n";
      else if (isW(ch, "noBreakHyphen")) text = "-";
      if (text == null) { thing(ch, r); continue; }
      const s = { el: ch, run: r, text, kind, off, link: link > 0 };
      segs.push(s);
      items.push(s);
      off += text.length;
    }
  };
  const walk = (node) => {
    for (const ch of [...node.children]) {
      if (ch.namespaceURI !== W) { thing(ch, null); continue; }
      const n = ch.localName;
      if (META.has(n)) continue;
      if (n === "r") walkRun(ch);
      else if (CONTAINERS.has(n)) {
        if (n === "hyperlink") link++;
        walk(ch);
        if (n === "hyperlink") link--;
      } else if (n === "sdt") {
        const c = kid(ch, "sdtContent");
        if (c) walk(c);
      } else thing(ch, null);
    }
  };
  walk(p);
  return { segs, things, items, text: segs.map((s) => s.text).join("") };
}

function runClass(run) {
  const rPr = run && kid(run, "rPr");
  if (!rPr) return "";
  const c = [];
  if (onOff(kid(rPr, "b"))) c.push("b");
  if (onOff(kid(rPr, "i"))) c.push("i");
  if (onOff(kid(rPr, "u"))) c.push("u");
  if (onOff(kid(rPr, "strike")) || onOff(kid(rPr, "dstrike"))) c.push("s");
  const va = wattr(kid(rPr, "vertAlign"), "val");
  if (va === "superscript") c.push("sup");
  if (va === "subscript") c.push("sub");
  if (onOff(kid(rPr, "caps"))) c.push("caps");
  if (onOff(kid(rPr, "vanish"))) c.push("hid");
  return c.join(" ");
}

function loadStyles(doc) {
  const map = new Map();
  if (!doc) return map;
  for (const s of doc.getElementsByTagNameNS(W, "style")) {
    const pPr = kid(s, "pPr");
    const numPr = pPr && kid(pPr, "numPr");
    map.set(wattr(s, "styleId"), {
      name: (wattr(kid(s, "name"), "val") || "").toLowerCase(),
      basedOn: wattr(kid(s, "basedOn"), "val"),
      numId: numPr ? wattr(kid(numPr, "numId"), "val") : null,
      ilvl: numPr ? wattr(kid(numPr, "ilvl"), "val") : null,
      outline: pPr ? wattr(kid(pPr, "outlineLvl"), "val") : null,
      jc: pPr ? wattr(kid(pPr, "jc"), "val") : null,
    });
  }
  return map;
}

function loadNumbering(doc) {
  const abstract = new Map(), nums = new Map();
  if (!doc) return { abstract, nums };
  for (const a of doc.getElementsByTagNameNS(W, "abstractNum")) {
    const lvls = [];
    for (const l of kids(a, "lvl")) {
      lvls[+wattr(l, "ilvl")] = {
        fmt: wattr(kid(l, "numFmt"), "val") || "decimal",
        text: wattr(kid(l, "lvlText"), "val") ?? "",
        start: +(wattr(kid(l, "start"), "val") ?? 1),
      };
    }
    abstract.set(wattr(a, "abstractNumId"), lvls);
  }
  for (const n of doc.getElementsByTagNameNS(W, "num")) {
    const starts = {};
    for (const o of kids(n, "lvlOverride")) {
      const so = kid(o, "startOverride");
      if (so) starts[+wattr(o, "ilvl")] = +wattr(so, "val");
    }
    nums.set(wattr(n, "numId"), { abs: wattr(kid(n, "abstractNumId"), "val"), starts });
  }
  return { abstract, nums };
}

const BULLETS = ["•", "◦", "▪"];
const PLAIN_BULLETS = new Set(["-", "–", "—", "•", "◦", "▪", "*", "·", "○", "■", "→", "✓"]);

export async function mountDocx(el, bytes, { onEdit, readOnly = false } = {}) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Not a Word document (word/document.xml is missing)");
  const parser = new DOMParser();
  const parse = (s) => {
    const d = parser.parseFromString(s, "application/xml");
    if (d.getElementsByTagName("parsererror").length) throw new Error("Could not read the document XML");
    return d;
  };
  const readOpt = async (path) => {
    const f = zip.file(path);
    try { return f ? parse(await f.async("string")) : null; } catch { return null; }
  };
  let doc = parse(await entry.async("string"));
  const styles = loadStyles(await readOpt("word/styles.xml"));
  const numbering = loadNumbering(await readOpt("word/numbering.xml"));
  const ver = versioned(onEdit);
  const editable = !readOnly;

  hostSetup(el, "is-docx", readOnly ? "Word document · read only"
    : "Word document · text edits keep each paragraph's formatting");
  const scroller = h("div", { class: "ox-scroll" });
  const page = h("div", { class: "ox-page" });
  scroller.append(page);
  el.append(scroller);

  const xmlOf = new WeakMap();

  // style chain lookups
  const styleInfo = (id) => {
    const out = { heading: 0, title: "", numId: null, ilvl: null, jc: null };
    for (let i = 0, s = styles.get(id); s && i < 8; i++, s = styles.get(s.basedOn)) {
      if (!out.heading && !out.title) {
        const m = /^heading (\d)$/.exec(s.name);
        if (m) out.heading = +m[1];
        else if (s.name === "title" || s.name === "subtitle") out.title = s.name;
        else if (s.outline != null && +s.outline < 6) out.heading = +s.outline + 1;
      }
      if (out.numId == null && s.numId != null) { out.numId = s.numId; out.ilvl = s.ilvl; }
      if (out.jc == null && s.jc) out.jc = s.jc;
    }
    if (!out.heading && !out.title && /^(heading|title|subtitle)\d?$/i.test(id || "")) {
      const m = /^heading(\d)$/i.exec(id);
      if (m) out.heading = +m[1]; else out.title = id.toLowerCase();
    }
    return out;
  };
  const paraInfo = (p) => {
    const pPr = kid(p, "pPr");
    const info = styleInfo(pPr && wattr(kid(pPr, "pStyle"), "val"));
    const numPr = pPr && kid(pPr, "numPr");
    if (numPr) {
      const id = wattr(kid(numPr, "numId"), "val");
      if (id != null) info.numId = id;
      const lv = wattr(kid(numPr, "ilvl"), "val");
      if (lv != null) info.ilvl = lv;
    }
    const jc = pPr && wattr(kid(pPr, "jc"), "val");
    if (jc) info.jc = jc;
    info.directNum = !!(numPr && kid(numPr, "numId"));
    return info;
  };

  // ── rendering
  function renderPara(p) {
    const scan = scanPara(p);
    const info = paraInfo(p);
    const cls = ["ox-p"];
    if (info.heading) cls.push("ox-h" + Math.min(info.heading, 6));
    if (info.title) cls.push("ox-" + info.title);
    const block = h("div", {
      class: cls.join(" "),
      contenteditable: editable ? "true" : null,
      style: info.jc === "center" ? { textAlign: "center" } : info.jc === "right" || info.jc === "end" ? { textAlign: "right" }
        : info.jc === "both" ? { textAlign: "justify" } : null,
    });
    let span = null, spanCls = null;
    for (const it of scan.items) {
      if (it.text != null) {
        const c = runClass(it.run) + (it.link ? " ln" : "");
        if (span && c === spanCls) span.textContent += it.text;
        else {
          span = h("span", { class: c || null, text: it.text });
          spanCls = c;
          block.append(span);
        }
      } else if (it.img) {
        block.append(h("span", { class: "ox-img", contenteditable: editable ? "false" : null, dataset: { ph: "1" }, text: "image" }));
        span = null;
      }
    }
    // a trailing line break needs something after it to take up a line
    if (scan.text.endsWith("\n")) block.append(h("br", { dataset: { ph: "1" } }));
    xmlOf.set(block, p);
    return block;
  }

  function renderTable(tbl) {
    const table = h("table", { class: "ox-table" });
    const owners = [];
    for (const tr of rowsOf(tbl)) {
      const row = h("tr");
      let col = 0;
      const trPr = kid(tr, "trPr");
      const before = +(wattr(trPr && kid(trPr, "gridBefore"), "val") || 0);
      if (before) { row.append(h("td", { class: "ox-gap", colSpan: before })); col += before; }
      for (const tc of cellsOf(tr)) {
        const tcPr = kid(tc, "tcPr");
        const span = +(wattr(tcPr && kid(tcPr, "gridSpan"), "val") || 1);
        const vm = tcPr && kid(tcPr, "vMerge");
        if (vm && wattr(vm, "val") !== "restart" && owners[col]) {
          owners[col].rowSpan++;
          col += span;
          continue;
        }
        const td = h("td", { colSpan: span > 1 ? span : null }, renderBlocks(tc));
        for (let i = 0; i < span; i++) owners[col + i] = vm ? td : null;
        row.append(td);
        col += span;
      }
      table.append(row);
    }
    return h("div", { class: "ox-table-wrap" }, table);
  }
  const unwrap = (node, name) => {
    const out = [];
    for (const c of node.children) {
      if (isW(c, name)) out.push(c);
      else if (isW(c, "sdt")) { const s = kid(c, "sdtContent"); if (s) out.push(...unwrap(s, name)); }
      else if (isW(c, "customXml")) out.push(...unwrap(c, name));
    }
    return out;
  };
  const rowsOf = (tbl) => unwrap(tbl, "tr");
  const cellsOf = (tr) => unwrap(tr, "tc");

  function renderBlocks(node) {
    const out = [];
    for (const c of node.children) {
      if (isW(c, "p")) out.push(renderPara(c));
      else if (isW(c, "tbl")) out.push(renderTable(c));
      else if (isW(c, "sdt")) { const s = kid(c, "sdtContent"); if (s) out.push(...renderBlocks(s)); }
      else if (isW(c, "customXml")) out.push(...renderBlocks(c));
    }
    return out;
  }

  const blocks = () => [...page.querySelectorAll(".ox-p")];

  function renumber() {
    const counters = new Map();
    for (const b of blocks()) {
      const info = paraInfo(xmlOf.get(b));
      const num = info.numId && info.numId !== "0" && numbering.nums.get(info.numId);
      const lvls = num && numbering.abstract.get(num.abs);
      if (!lvls) {
        if (b.dataset.marker != null) { delete b.dataset.marker; b.classList.remove("ox-li"); b.style.removeProperty("--lvl"); }
        continue;
      }
      const ilvl = Math.max(0, Math.min(8, +(info.ilvl ?? 0)));
      const lvl = lvls[ilvl] || { fmt: "bullet", text: "•", start: 1 };
      const c = counters.get(info.numId) || [];
      counters.set(info.numId, c);
      const startOf = (i) => num.starts[i] ?? lvls[i]?.start ?? 1;
      c[ilvl] = c[ilvl] == null ? startOf(ilvl) : c[ilvl] + 1;
      c.length = ilvl + 1;
      let marker;
      if (lvl.fmt === "bullet") marker = PLAIN_BULLETS.has(lvl.text) ? lvl.text : BULLETS[ilvl % 3];
      else {
        marker = lvl.text.replace(/%(\d)/g, (_, d) => {
          const i = +d - 1;
          return formatListNumber(c[i] ?? startOf(i), i === ilvl ? lvl.fmt : lvls[i]?.fmt || "decimal");
        });
      }
      b.classList.add("ox-li");
      b.dataset.marker = marker;
      b.style.setProperty("--lvl", ilvl);
    }
  }

  function renderAll() {
    const body = kid(doc.documentElement, "body");
    page.replaceChildren(...(body ? renderBlocks(body) : []));
    if (!page.querySelector(".ox-p")) page.append(h("div", { class: "ox-empty", text: "This document has no text" }));
    renumber();
  }
  renderAll();

  if (!editable) {
    return {
      getBytes: async () => new Uint8Array(bytes),
      destroy: () => { el.replaceChildren(); el.classList.remove("office-host", "is-docx"); },
      dirty: () => false,
    };
  }

  // ── DOM text <-> caret helpers
  const isPh = (n) => n.nodeType === 1 && n.dataset?.ph;
  function textOf(node) {
    let s = "";
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1 && !isPh(c)) s += c.nodeName === "BR" ? "\n" : textOf(c);
    }
    return s;
  }
  function lastLeaf(node) {
    let n = node.lastChild;
    while (n) {
      if (n.nodeType === 3 && !n.data) { n = n.previousSibling || (n.parentNode !== node ? n.parentNode.previousSibling : null); continue; }
      if (n.nodeType === 1 && n.nodeName !== "BR" && !isPh(n) && n.lastChild) { n = n.lastChild; continue; }
      return n;
    }
    return null;
  }
  function blockText(b) {
    const t = textOf(b);
    // Chrome keeps a bogus <br> at the end of editable blocks
    const leaf = lastLeaf(b);
    return leaf && leaf.nodeName === "BR" && !isPh(leaf) && t.endsWith("\n") ? t.slice(0, -1) : t;
  }
  function offsetIn(b, container, offset) {
    const r = document.createRange();
    r.selectNodeContents(b);
    r.setEnd(container, offset);
    return textOf(r.cloneContents()).length;
  }
  function selectionIn(b) {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!b.contains(r.startContainer) || !b.contains(r.endContainer)) return null;
    const a = offsetIn(b, r.startContainer, r.startOffset);
    return { a, b: r.collapsed ? a : offsetIn(b, r.endContainer, r.endOffset), range: r };
  }
  function setCaret(b, off) {
    b.focus({ preventScroll: true });
    const sel = getSelection();
    const r = document.createRange();
    let left = off, done = false;
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (done) return;
        if (c.nodeType === 3) {
          if (left <= c.data.length) { r.setStart(c, left); done = true; return; }
          left -= c.data.length;
        } else if (c.nodeType === 1 && !isPh(c)) {
          if (c.nodeName === "BR") {
            if (left === 0) { r.setStartBefore(c); done = true; return; }
            left -= 1;
            if (left === 0) { r.setStartAfter(c); done = true; return; }
          } else walk(c);
        }
      }
    };
    walk(b);
    if (!done) { r.selectNodeContents(b); r.collapse(false); }
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ── undo: whole-document snapshots taken at the start of each edit burst
  const undo = [], redo = [];
  let lastEdit = 0;
  const caretState = () => {
    const b = document.activeElement?.closest?.(".ox-p");
    const s = b && page.contains(b) && selectionIn(b);
    return { idx: b ? blocks().indexOf(b) : -1, off: s ? s.a : 0 };
  };
  const ser = new XMLSerializer();
  function checkpoint(force) {
    const now = Date.now();
    if (force || now - lastEdit > 1200) {
      undo.push({ xml: ser.serializeToString(doc), caret: caretState() });
      if (undo.length > 60) undo.shift();
      redo.length = 0;
    }
    lastEdit = force ? 0 : now;
  }
  function restore(from, to) {
    const snap = from.pop();
    if (!snap) return;
    to.push({ xml: ser.serializeToString(doc), caret: caretState() });
    doc = parse(snap.xml);
    renderAll();
    lastEdit = 0;
    const b = blocks()[snap.caret.idx];
    if (b) setCaret(b, snap.caret.off);
    ver.bump();
  }

  // ── model edits
  const mk = (name) => doc.createElementNS(W, "w:" + name);
  function textNodes(str) {
    return str.split(/(\t|\n)/).filter((s) => s !== "").map((s) => {
      if (s === "\t") return mk("tab");
      if (s === "\n") return mk("br");
      const t = mk("t");
      t.textContent = s;
      if (needsPreserve(s)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
      return t;
    });
  }
  function cleanRuns(runs) {
    for (const r of runs) {
      if (!r.parentNode || [...r.children].some((c) => !isW(c, "rPr"))) continue;
      const parent = r.parentNode;
      r.remove();
      if (isW(parent, "hyperlink") || isW(parent, "smartTag") || isW(parent, "ins")) {
        if (!parent.children.length) parent.remove();
      }
    }
  }
  function markRPr(p) {
    const pPr = kid(p, "pPr");
    const src = pPr && kid(pPr, "rPr");
    if (!src) return null;
    const rPr = src.cloneNode(true);
    for (const c of [...rPr.children]) if (isW(c, "ins") || isW(c, "del") || isW(c, "rPrChange")) c.remove();
    return rPr;
  }
  function applyTexts(p, scan, next, target) {
    const touched = new Set();
    const total = next.join("");
    let keptEmpty = false;
    scan.segs.forEach((s, i) => {
      const str = next[i];
      if (str === s.text) return;
      touched.add(s.run);
      if (s.kind === "t") {
        if (str === "" && total === "" && !keptEmpty) { s.el.textContent = ""; keptEmpty = true; return; }
        if (!/[\t\n]/.test(str)) {
          if (str === "") { s.el.remove(); return; }
          s.el.textContent = str;
          if (needsPreserve(str)) s.el.setAttributeNS(XML_NS, "xml:space", "preserve");
          else s.el.removeAttributeNS(XML_NS, "space");
          return;
        }
        s.el.replaceWith(...textNodes(str));
        return;
      }
      // atomic tab/break: keep the element itself when it survives
      if (str.startsWith(s.text)) s.el.after(...textNodes(str.slice(s.text.length)));
      else if (str.endsWith(s.text)) s.el.before(...textNodes(str.slice(0, -s.text.length)));
      else s.el.replaceWith(...textNodes(str));
    });
    cleanRuns(touched);
    return target;
  }
  function spliceModel(p, a, b, ins) {
    const scan = scanPara(p);
    const texts = scan.segs.map((s) => s.text), kinds = scan.segs.map((s) => s.kind);
    const res = spliceSegments(texts, kinds, a, b, ins);
    if (ins && res.target < 0) {
      const r = mk("r");
      const rPr = markRPr(p);
      if (rPr) r.append(rPr);
      r.append(...textNodes(ins));
      p.append(r);
    }
    applyTexts(p, scan, res.texts, res.target);
  }

  function rerender(block) {
    const p = xmlOf.get(block);
    const fresh = renderPara(p);
    block.replaceWith(fresh);
    return fresh;
  }

  function syncFromDom(block) {
    const p = xmlOf.get(block);
    const scan = scanPara(p);
    const next = blockText(block);
    const imgs = block.querySelectorAll(".ox-img").length;
    if (next === scan.text && imgs === scan.things.filter((t) => t.img).length) return;
    checkpoint(false);
    if (next !== scan.text) {
      const texts = scan.segs.map((s) => s.text), kinds = scan.segs.map((s) => s.kind);
      const res = editSegments(texts, kinds, next);
      if (res.target < 0 && next) spliceModel(p, 0, scan.text.length, next);
      else applyTexts(p, scan, res.texts, res.target);
    }
    // pictures cannot be deleted from here; put the placeholder back
    if (imgs !== scan.things.filter((t) => t.img).length) {
      const sel = selectionIn(block);
      const fresh = rerender(block);
      setCaret(fresh, sel ? sel.a : 0);
    }
    ver.bump();
  }

  function replaceSelection(block, text) {
    const sel = selectionIn(block);
    if (!sel) return;
    checkpoint(true);
    spliceModel(xmlOf.get(block), sel.a, sel.b, text);
    const fresh = rerender(block);
    setCaret(fresh, sel.a + text.length);
    ver.bump();
    return fresh;
  }

  function splitBlock(block) {
    const sel = selectionIn(block);
    if (!sel) return;
    checkpoint(true);
    const p = xmlOf.get(block);
    if (sel.b > sel.a) spliceModel(p, sel.a, sel.b, "");
    const k = sel.a;
    const scan = scanPara(p);
    const len = scan.text.length;
    const q = p.cloneNode(true);
    const qScan = scanPara(q);
    const second = (t) => (k < len ? t.off >= k : false);
    // things move, never duplicate (bookmarks, comments, drawings)
    const tRuns = new Set(), qRuns = new Set();
    scan.things.forEach((t, i) => {
      const qt = qScan.things[i];
      if (second(t)) { t.el.remove(); if (t.run) tRuns.add(t.run); }
      else { qt.el.remove(); if (qt.run) qRuns.add(qt.run); }
    });
    cleanRuns(tRuns);
    cleanRuns(qRuns);
    spliceModel(p, k, len, "");
    spliceModel(q, 0, k, "");
    // the section break belongs to the last paragraph of the section
    const pPr = kid(p, "pPr");
    const sect = pPr && kid(pPr, "sectPr");
    if (sect) sect.remove();
    else { const qp = kid(q, "pPr"); const qs = qp && kid(qp, "sectPr"); if (qs) qs.remove(); }
    for (const a of [...q.attributes]) if (/^(paraId|textId)$/.test(a.localName)) q.removeAttributeNode(a);
    p.after(q);
    const first = rerender(block);
    const nb = renderPara(q);
    first.after(nb);
    renumber();
    setCaret(nb, 0);
    nb.scrollIntoView({ block: "nearest" });
    ver.bump();
  }

  const prevPara = (p) => { const s = p.previousElementSibling; return isW(s, "p") ? s : null; };
  const nextPara = (p) => { const s = p.nextElementSibling; return isW(s, "p") ? s : null; };
  const blockFor = (p) => blocks().find((b) => xmlOf.get(b) === p);

  function mergeInto(into, from) {
    checkpoint(true);
    const at = scanPara(into).text.length;
    for (const c of [...from.children]) if (!isW(c, "pPr")) into.append(c);
    const fp = kid(from, "pPr");
    const fs = fp && kid(fp, "sectPr");
    if (fs) {
      let ip = kid(into, "pPr");
      if (!ip) { ip = mk("pPr"); into.prepend(ip); }
      const old = kid(ip, "sectPr");
      if (old) old.remove();
      ip.append(fs);
    }
    from.remove();
    const fb = blockFor(from);
    if (fb) fb.remove();
    const ib = blockFor(into);
    const fresh = rerender(ib);
    renumber();
    setCaret(fresh, at);
    ver.bump();
  }

  function dropNumbering(block) {
    checkpoint(true);
    const p = xmlOf.get(block);
    const pPr = kid(p, "pPr");
    const numPr = kid(pPr, "numPr");
    numPr.remove();
    const fresh = rerender(block);
    renumber();
    setCaret(fresh, 0);
    ver.bump();
  }

  // caret line detection for moving between blocks
  function caretEdge(block) {
    const sel = getSelection();
    if (!sel.rangeCount) return { first: true, last: true, x: 0 };
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    let rect = r.getClientRects()[0];
    if (!rect) {
      // empty lines have no client rects; measure a zero-width probe instead
      const probe = document.createTextNode("​");
      r.insertNode(probe);
      const pr = document.createRange();
      pr.selectNodeContents(probe);
      rect = pr.getBoundingClientRect();
      const parent = probe.parentNode;
      probe.remove();
      parent?.normalize();
    }
    const br = block.getBoundingClientRect();
    const cs = getComputedStyle(block);
    const lh = parseFloat(cs.lineHeight) || 24;
    if (!rect || !rect.height) return { first: true, last: true, x: br.left };
    return {
      first: rect.top - br.top - parseFloat(cs.paddingTop) < lh * 0.7,
      last: br.bottom - parseFloat(cs.paddingBottom) - rect.bottom < lh * 0.7,
      x: rect.left,
    };
  }
  function placeByX(target, x, atEnd) {
    target.scrollIntoView({ block: "nearest" });
    const r = target.getBoundingClientRect();
    const cs = getComputedStyle(target);
    const lh = parseFloat(cs.lineHeight) || 24;
    const y = atEnd ? r.bottom - parseFloat(cs.paddingBottom) - lh / 2 : r.top + parseFloat(cs.paddingTop) + lh / 2;
    const pos = document.caretRangeFromPoint?.(Math.max(r.left + 1, Math.min(x, r.right - 1)), y);
    if (pos && target.contains(pos.startContainer)) {
      target.focus({ preventScroll: true });
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(pos);
    } else setCaret(target, atEnd ? blockText(target).length : 0);
  }

  function onKeyDown(e) {
    const block = e.target.closest?.(".ox-p");
    if (!block || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const lk = keyOf(e).toLowerCase(); // the key, not the letter: Ctrl+Z on a Ukrainian layout types "я"
    if (mod && !e.altKey && (lk === "z" || lk === "y")) {
      e.preventDefault();
      if (lk === "y" || e.shiftKey) restore(redo, undo); else restore(undo, redo);
      return;
    }
    if (mod && /^[biu]$/i.test(e.key)) { e.preventDefault(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) replaceSelection(block, "\n");
      else splitBlock(block);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (block.closest(".ox-table")) {
        const all = blocks(), i = all.indexOf(block);
        const cell = block.closest("td");
        const step = e.shiftKey ? -1 : 1;
        let j = i + step;
        while (all[j] && all[j].closest("td") === cell) j += step;
        if (all[j]) setCaret(all[j], 0);
      } else if (!e.shiftKey) replaceSelection(block, "\t");
      return;
    }
    const sel = selectionIn(block);
    if (!sel) return;
    const collapsed = sel.a === sel.b;
    const len = blockText(block).length;
    const p = xmlOf.get(block);
    if (e.key === "Backspace" && collapsed && sel.a === 0 && !mod) {
      e.preventDefault();
      if (paraInfo(p).directNum) dropNumbering(block);
      else { const prev = prevPara(p); if (prev) mergeInto(prev, p); }
      return;
    }
    if (e.key === "Delete" && collapsed && sel.a === len && !mod) {
      e.preventDefault();
      const next = nextPara(p);
      if (next) mergeInto(p, next);
      return;
    }
    if (e.shiftKey || e.altKey) return;
    const all = blocks();
    const i = all.indexOf(block);
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !mod) {
      const edge = caretEdge(block);
      const up = e.key === "ArrowUp";
      const target = all[i + (up ? -1 : 1)];
      if (target && (up ? edge.first : edge.last)) { e.preventDefault(); placeByX(target, edge.x, up); }
    } else if (e.key === "ArrowLeft" && collapsed && sel.a === 0 && all[i - 1]) {
      e.preventDefault();
      setCaret(all[i - 1], blockText(all[i - 1]).length);
    } else if (e.key === "ArrowRight" && collapsed && sel.a === len && all[i + 1]) {
      e.preventDefault();
      setCaret(all[i + 1], 0);
    }
  }

  function onBeforeInput(e) {
    const t = e.inputType;
    if (t.startsWith("format") || t === "insertFromDrop" || t === "deleteByDrag" || t === "historyUndo" || t === "historyRedo") {
      e.preventDefault();
      return;
    }
    if (t === "insertParagraph" || t === "insertLineBreak") {
      e.preventDefault();
      const block = e.target.closest?.(".ox-p");
      if (block) t === "insertParagraph" ? splitBlock(block) : replaceSelection(block, "\n");
    }
  }

  function onInput(e) {
    const block = e.target.closest?.(".ox-p");
    if (block && !e.isComposing) syncFromDom(block);
  }
  function onCompositionEnd(e) {
    const block = e.target.closest?.(".ox-p");
    if (block) syncFromDom(block);
  }

  function onPaste(e) {
    let block = e.target.closest?.(".ox-p");
    if (!block) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
    if (!text) return;
    const lines = text.split("\n");
    block = replaceSelection(block, lines[0]);
    for (const line of lines.slice(1)) {
      if (!block) break;
      splitBlock(block);
      const cur = document.activeElement?.closest?.(".ox-p");
      block = cur ? replaceSelection(cur, line) : null;
    }
  }

  // copying a range must not carry our spans into other apps as rich text
  function onCopy(e) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    e.preventDefault();
    const frag = sel.getRangeAt(0).cloneContents();
    e.clipboardData.setData("text/plain", textOf(frag));
    if (e.type === "cut") {
      const block = e.target.closest?.(".ox-p");
      if (block) replaceSelection(block, "");
    }
  }

  const listeners = [
    ["keydown", onKeyDown], ["beforeinput", onBeforeInput], ["input", onInput],
    ["compositionend", onCompositionEnd], ["paste", onPaste], ["copy", onCopy], ["cut", onCopy],
    ["drop", (e) => e.preventDefault()],
  ];
  for (const [t, f] of listeners) page.addEventListener(t, f);

  return {
    async getBytes() {
      const v = ver.snapshot();
      if (ver.pristine()) return new Uint8Array(bytes);
      let xml = ser.serializeToString(doc);
      if (!xml.startsWith("<?xml")) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + xml;
      zip.file("word/document.xml", xml);
      const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      ver.saved(v);
      return out;
    },
    destroy() {
      for (const [t, f] of listeners) page.removeEventListener(t, f);
      el.replaceChildren();
      el.classList.remove("office-host", "is-docx");
    },
    dirty: ver.dirty,
  };
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

const MAX_ROWS = 1048576, MAX_COLS = 16384;
const HEAD_H = 24;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function bisect(pos, y) {
  // largest i with pos[i] <= y, clamped to a valid index
  let lo = 0, hi = pos.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pos[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function argbCss(argb) {
  if (!argb || typeof argb !== "string") return null;
  const hex = argb.length === 8 ? argb.slice(2) : argb.length === 6 ? argb : null;
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? "#" + hex : null;
}
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

const isFormula = (v) => v && typeof v === "object" && ("formula" in v || "sharedFormula" in v);

/* CSV: rows of fields; a field in quotes may hold the separator, quotes ("" for one) and line breaks. */
export function parseCsv(text, sep = ",") {
  const rows = [];
  let row = [], cur = "", q = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
      continue;
    }
    if (c === '"' && cur === "") { q = true; any = true; continue; }
    if (c === sep) { row.push(cur); cur = ""; any = true; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = ""; any = false;
      continue;
    }
    cur += c; any = true;
  }
  if (any || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
/** The separator a CSV uses: a tab, a semicolon (Excel in much of Europe) or a comma - the most common on its first line. */
export function csvSeparator(text, name = "") {
  if (/\.tsv$/i.test(name)) return "\t";
  const first = text.slice(0, text.search(/\r?\n|$/));
  const count = (ch) => first.split(ch).length - 1;
  const best = [["\t", count("\t")], [";", count(";")], [",", count(",")]].sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}
export function toCsv(rows, sep = ",", eol = "\n") {
  return rows.map((r) => r.map((v) => { const s = v == null ? "" : String(v); return s.includes(sep) || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(sep)).join(eol);
}
// a field that is plainly a number becomes one (sorting, sums); "007" or "1,5" stay as written; "=…" is a formula
const csvCell = (s) => (s.length > 1 && s[0] === "=" ? { formula: s.slice(1) } : /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.length < 16 ? Number(s) : s);

export async function mountXlsx(el, bytes, { onEdit, readOnly = false, csv = null, name = "" } = {}) {
  const mod = await import("exceljs");
  const ExcelJS = mod.default?.Workbook ? mod.default : mod;
  const wb = new ExcelJS.Workbook();
  // a CSV: its rows on one sheet, written back as CSV - the same separator, the same line ends
  const sep = csv != null ? csvSeparator(csv, name) : ",";
  const eol = csv != null && csv.includes("\r\n") ? "\r\n" : "\n";
  if (csv != null) {
    const ws = wb.addWorksheet("Sheet1");
    for (const r of parseCsv(csv, sep)) ws.addRow(r.map(csvCell));
  } else await wb.xlsx.load(bytes);
  const ver = versioned(onEdit);
  const editable = !readOnly;

  hostSetup(el, "is-xlsx", csv != null ? `CSV table (${sep === "\t" ? "tabs" : sep === ";" ? "semicolons" : "commas"}) · formulas (=SUM(B2:B9)…) are worked out here and kept as written; styles are not kept in a CSV`
    : readOnly ? "Excel workbook · read only"
    : "Excel workbook · values and formulas are editable; charts and macros may not survive a save");

  const sheets = wb.worksheets.filter((ws) => ws.state !== "hidden" && ws.state !== "veryHidden");
  if (!sheets.length && wb.worksheets.length) sheets.push(wb.worksheets[0]);
  if (!sheets.length) sheets.push(wb.addWorksheet("Sheet1"));

  /* Formulas worked out here - the everyday ones (formula.js). One this table can't work out (another
     sheet, a function not known here) keeps the answer Excel last saved. Run after every change; on
     opening, for a CSV, and in a workbook only for formulas that came without an answer. */
  function recalc(ws, { onlyMissing = false } = {}) {
    const memo = new Map(), busy = new Set();
    let left = 20000;
    const plain = (v) => (v && typeof v === "object" && !(v instanceof Date) && !("error" in v) ? (v.richText ? v.richText.map((x) => x.text).join("") : v.text ?? v.result ?? null) : v);
    const valueAt = (r, c) => {
      const key = r * 100000 + c;
      if (memo.has(key)) return memo.get(key);
      const cell = ws.findCell(r, c);
      const v = cell ? cell.value : null;
      if (!isFormula(v)) { const out = plain(v); memo.set(key, out); return out; }
      if (busy.has(key)) return { error: "#REF!" }; // a cell that leads back to itself
      busy.add(key);
      let res;
      try { res = left-- > 0 ? evaluate(cell.formula, valueAt) : v.result; }
      catch (e) { if (!(e instanceof Unsupported)) throw e; res = v.result ?? null; }
      busy.delete(key);
      memo.set(key, res);
      return res;
    };
    ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      if (!isFormula(v) || (onlyMissing && v.result != null)) return;
      const res = valueAt(cell.row, cell.col);
      if (res !== v.result) cell.value = { ...v, result: res };
    }));
  }
  for (const ws of sheets) recalc(ws, { onlyMissing: csv == null });

  // the table as CSV: a formula as written ("=…"), everything else as shown
  function csvText() {
    const ws = sheets[0];
    const rows = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const out = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = ws.getRow(r).getCell(c);
        const val = cell.value;
        out.push(val == null ? "" : isFormula(val) ? "=" + (cell.formula || "") : typeof val === "object" ? (val.text ?? (val.richText ? val.richText.map((x) => x.text).join("") : val instanceof Date ? val.toISOString().slice(0, 10) : "")) : val);
      }
      while (out.length && out[out.length - 1] === "") out.pop();
      rows.push(out);
    }
    return toCsv(rows, sep, eol) + (/\r?\n$/.test(csv) ? eol : "");
  }

  // ── DOM
  const nameBox = h("div", { class: "xl-name" });
  const fx = h("input", { class: "xl-fx", spellcheck: false, readOnly: !editable, "aria-label": "Cell contents" });
  const bar = h("div", { class: "xl-bar" }, nameBox, h("span", { class: "xl-fx-label", text: "fx" }), fx);
  const cmds = h("div", { class: "xl-cmds" });
  // what the picked cells add up to, as Excel's status bar says it
  const sumEl = h("span", { class: "xl-sum" });
  // find in the sheet: Enter the next cell that has it, Shift+Enter the one before (Ctrl+F)
  const findIn = h("input", { class: "input xl-find", placeholder: "Find in sheet", spellcheck: false });
  const corner = h("div", { class: "xl-corner" });
  const colLabels = h("div", { class: "xl-collabels" });
  const colHead = h("div", { class: "xl-colhead" }, corner, colLabels);
  const rowHead = h("div", { class: "xl-rowhead" });
  const lines = h("div", { class: "xl-lines" });
  const cells = h("div", { class: "xl-cells" });
  const selBox = h("div", { class: "xl-sel" });
  const cursor = h("div", { class: "xl-cursor" });
  const editor = h("input", { class: "xl-edit", spellcheck: false, hidden: true });
  const refBoxes = h("div", { class: "xl-refs" }); // the cells a formula reads, each range in its own colour
  const layer = h("div", { class: "xl-layer" }, lines, cells, refBoxes, selBox, cursor, editor);
  const body = h("div", { class: "xl-body" }, rowHead, layer);
  const canvas = h("div", { class: "xl-canvas" }, colHead, body);
  const scroller = h("div", { class: "xl-scroll", tabIndex: 0 }, canvas);
  /* The sheet's own zoom (Ctrl+wheel over it), apart from the app's: the grid is drawn at CSS zoom Z, so every
     size inside it scales as one; only what reads the pointer or the scroll (in screen pixels) divides by Z. */
  const ZOOM_KEY = "leonote.sheetZoom";
  let Z = (() => { try { return Math.min(3, Math.max(0.5, Number(localStorage.getItem(ZOOM_KEY)) || 1)); } catch { return 1; } })();
  canvas.style.zoom = String(Z);
  const tabs = h("div", { class: "xl-tabs" });
  el.append(cmds, bar, scroller, tabs);

  // ── per-sheet state
  const states = new Map();
  let st = null;

  function stateFor(ws) {
    if (states.has(ws)) return states.get(ws);
    const dim = ws.dimensions;
    const s = {
      ws,
      rows: Math.min(MAX_ROWS, Math.max(100, (ws.rowCount || 0) + 20, dim?.bottom || 0)),
      cols: Math.min(MAX_COLS, Math.max(26, (ws.columnCount || 0) + 5, dim?.right || 0)),
      r: 1, c: 1, er: 1, ec: 1, // active cell, and the far corner of the selection
      top: 0, left: 0,
      rowPos: null, colPos: null,
      merges: null, mergeAt: new Map(),
    };
    loadMerges(s);
    states.set(ws, s);
    return s;
  }

  function loadMerges(s) {
    s.merges = [];
    s.mergeAt.clear();
    for (const m of Object.values(s.ws._merges || {})) {
      const mm = m?.model || m;
      if (!mm || mm.top == null) continue;
      const box = { top: mm.top, left: mm.left, bottom: mm.bottom, right: mm.right };
      s.merges.push(box);
      if ((box.bottom - box.top + 1) * (box.right - box.left + 1) > 200000) continue;
      for (let r = box.top; r <= box.bottom; r++)
        for (let c = box.left; c <= box.right; c++) s.mergeAt.set(r * MAX_COLS + c, box);
    }
  }
  const mergeOf = (r, c) => st.mergeAt.get(r * MAX_COLS + c);

  const defRowPx = () => Math.round((st.ws.properties?.defaultRowHeight || 15) * 4 / 3);
  const defColPx = () => Math.round((st.ws.properties?.defaultColWidth || 8.43) * 7 + 5);
  function rowPx(r) {
    const row = st.ws.findRow(r);
    if (row?.hidden) return 0;
    return row?.height ? Math.max(4, Math.round(row.height * 4 / 3)) : defRowPx();
  }
  function colPx(c) {
    const col = st.ws.columns?.[c - 1];
    if (col?.hidden) return 0;
    return col?.width ? Math.max(4, Math.round(col.width * 7 + 5)) : defColPx();
  }
  function layout() {
    const rp = new Float64Array(st.rows + 1);
    for (let r = 1; r <= st.rows; r++) rp[r] = rp[r - 1] + rowPx(r);
    const cp = new Float64Array(st.cols + 1);
    for (let c = 1; c <= st.cols; c++) cp[c] = cp[c - 1] + colPx(c);
    st.rowPos = rp;
    st.colPos = cp;
    st.rowW = Math.max(40, 16 + String(st.rows).length * 8);
    canvas.style.width = st.rowW + cp[st.cols] + "px";
    body.style.height = rp[st.rows] + "px";
    el.style.setProperty("--xl-roww", st.rowW + "px");
    lastKey = "";
  }

  // ── cell display
  function display(cell) {
    const v = cell.value;
    const fmt = cell.numFmt;
    if (isFormula(v)) {
      const res = v.result;
      if (res === undefined || res === null) return { text: "=" + (cell.formula || ""), kind: "f" };
      return { text: formatCellValue(res, fmt), kind: kindOf(res) };
    }
    return { text: formatCellValue(v, fmt), kind: kindOf(v) };
  }
  function kindOf(v) {
    if (typeof v === "number" || v instanceof Date) return "n";
    if (typeof v === "boolean" || v?.error) return "b";
    return "s";
  }
  function rawOf(cell) {
    const v = cell.value;
    if (v == null) return "";
    if (isFormula(v)) return "=" + (cell.formula || "");
    if (v instanceof Date) {
      const iso = v.toISOString();
      return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
    }
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "string") {
      const p = parseCellInput(v);
      return typeof p === "string" || v === "" ? v : "'" + v;
    }
    return formatCellValue(v, "");
  }

  function styleOf(cell, kind) {
    const out = [];
    const cls = [];
    const f = cell.font;
    if (f) {
      if (f.bold) cls.push("b");
      if (f.italic) cls.push("i");
      if (f.underline) cls.push("u");
      if (f.strike) cls.push("s");
      if (f.size && f.size !== 11) out.push(`font-size:${(f.size / 11 * 12.5).toFixed(1)}px`);
    }
    const fill = cell.fill;
    const bg = fill?.type === "pattern" && fill.pattern === "solid" ? argbCss(fill.fgColor?.argb) : null;
    if (bg) {
      const fc = argbCss(f?.color?.argb);
      out.push(`background:${bg}`, `color:${fc || (luminance(bg) > 0.55 ? "#1b1b1f" : "#f3f3f5")}`);
      cls.push("fill");
    }
    const al = cell.alignment;
    let ha = al?.horizontal;
    if (!ha || ha === "general") ha = kind === "n" ? "right" : kind === "b" ? "center" : "left";
    if (ha === "centerContinuous" || ha === "distributed") ha = "center";
    if (ha === "fill" || ha === "justify") ha = "left";
    // the file says what it likes here (ExcelJS checks it only when writing): a word we know, else left
    if (ha !== "left" && ha !== "center" && ha !== "right") ha = "left";
    cls.push("h-" + ha);
    if (al?.vertical === "top") cls.push("v-top");
    else if (al?.vertical === "middle") cls.push("v-mid");
    if (al?.wrapText) cls.push("wrap");
    if (al?.indent) out.push(`padding-left:${4 + al.indent * 9}px`);
    return { cls, css: out.join(";"), bg, ha, bold: !!f?.bold, size: f?.size ? f.size / 11 * 12.5 : 12.5 };
  }
  // numbers that do not fit show as #### like Excel, instead of being cut off
  const ctx = document.createElement("canvas").getContext("2d");
  let family = "";
  function textWidth(text, bold, size) {
    family ||= getComputedStyle(scroller).fontFamily;
    ctx.font = `${bold ? 650 : 400} ${size}px ${family}`;
    return ctx.measureText(text).width;
  }
  const emptyCell = (cell) => !cell || ((cell.value == null || cell.value === "") && cell.fill?.pattern !== "solid");

  // ── painting
  let lastKey = "";
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };

  function paint(force) {
    const top = scroller.scrollTop / Z, left = scroller.scrollLeft / Z;
    const vh = scroller.clientHeight / Z - HEAD_H, vw = scroller.clientWidth / Z - st.rowW;
    // grow the sheet when the user scrolls near its end
    let grew = false;
    if (top + vh > st.rowPos[st.rows] - 400 && st.rows < MAX_ROWS) { st.rows = Math.min(MAX_ROWS, st.rows + 200); grew = true; }
    if (left + vw > st.colPos[st.cols] - 300 && st.cols < MAX_COLS) { st.cols = Math.min(MAX_COLS, st.cols + 10); grew = true; }
    if (grew) layout();
    const r0 = Math.max(1, bisect(st.rowPos, top) + 1 - 3);
    const r1 = Math.min(st.rows, bisect(st.rowPos, top + vh) + 1 + 3);
    const c0 = Math.max(1, bisect(st.colPos, left) + 1 - 2);
    const c1 = Math.min(st.cols, bisect(st.colPos, left + vw) + 1 + 2);
    const key = `${r0},${r1},${c0},${c1}`;
    if (key !== lastKey || force) {
      lastKey = key;
      paintHeaders(r0, r1, c0, c1);
      paintCells(r0, r1, c0, c1);
    }
    paintSelection();
  }

  function selRange() {
    return {
      top: Math.min(st.r, st.er), bottom: Math.max(st.r, st.er),
      left: Math.min(st.c, st.ec), right: Math.max(st.c, st.ec),
    };
  }

  function paintHeaders(r0, r1, c0, c1) {
    const { rowPos: rp, colPos: cp } = st;
    const s = selRange();
    let html = "";
    for (let c = c0; c <= c1; c++) {
      const w = cp[c] - cp[c - 1];
      if (!w) continue;
      const on = c >= s.left && c <= s.right ? " on" : "";
      html += `<div class="xl-ch${on}" data-c="${c}" style="left:${cp[c - 1]}px;width:${w}px">${colName(c)}<i class="xl-grip"></i></div>`;
    }
    colLabels.innerHTML = html;
    html = "";
    for (let r = r0; r <= r1; r++) {
      const hgt = rp[r] - rp[r - 1];
      if (!hgt) continue;
      const on = r >= s.top && r <= s.bottom ? " on" : "";
      html += `<div class="xl-rh${on}" style="top:${rp[r - 1]}px;height:${hgt}px">${r}</div>`;
    }
    rowHead.innerHTML = html;
  }

  function paintCells(r0, r1, c0, c1) {
    const { rowPos: rp, colPos: cp, ws } = st;
    const x0 = cp[c0 - 1], x1 = cp[c1], y0 = rp[r0 - 1], y1 = rp[r1];
    let grid = "";
    for (let r = r0; r <= r1; r++) if (rp[r] > rp[r - 1]) grid += `<div class="xl-hl" style="top:${rp[r] - 1}px;left:${x0}px;width:${x1 - x0}px"></div>`;
    for (let c = c0; c <= c1; c++) if (cp[c] > cp[c - 1]) grid += `<div class="xl-vl" style="left:${cp[c] - 1}px;top:${y0}px;height:${y1 - y0}px"></div>`;
    lines.innerHTML = grid;

    let html = "";
    const drawn = new Set();
    const cellHtml = (cell, x, y, w, hgt, spillTo) => {
      const d = display(cell);
      const sty = styleOf(cell, d.kind);
      if (!d.text && !sty.bg) return "";
      let width = w;
      if (spillTo) width = spillTo - x;
      let text = d.text;
      if (d.kind === "n" && !sty.cls.includes("wrap") && textWidth(text, sty.bold, sty.size) > width - 9) {
        text = "#".repeat(Math.max(1, Math.floor((width - 9) / textWidth("#", sty.bold, sty.size))));
      }
      const cls = ["xl-c", ...sty.cls, width > w ? "sp" : "", d.kind === "f" ? "fx" : ""].filter(Boolean).join(" ");
      return `<div class="${esc(String(cls))}" style="left:${x}px;top:${y}px;width:${width - 1}px;height:${hgt - 1}px;${sty.css}">${esc(text)}</div>`;
    };
    // merged areas first, drawn from their master cell
    for (const m of st.merges) {
      if (m.bottom < r0 || m.top > r1 || m.right < c0 || m.left > c1) continue;
      const cell = ws.findCell(m.top, m.left);
      const x = cp[m.left - 1], y = rp[m.top - 1];
      const w = cp[Math.min(m.right, st.cols)] - x, hgt = rp[Math.min(m.bottom, st.rows)] - y;
      drawn.add(m);
      if (!w || !hgt) continue;
      html += `<div class="xl-m" style="left:${x}px;top:${y}px;width:${w - 1}px;height:${hgt - 1}px"></div>`;
      if (cell) html += cellHtml(cell, x, y, w, hgt);
    }
    for (let r = r0; r <= r1; r++) {
      const row = ws.findRow(r);
      if (!row || row.hidden) continue;
      const y = rp[r - 1], hgt = rp[r] - y;
      // start a little left so text spilling in from off-screen still shows
      for (let c = Math.max(1, c0 - 8); c <= c1; c++) {
        const cell = row.findCell(c);
        if (emptyCell(cell)) continue;
        if (st.mergeAt.size && mergeOf(r, c)) continue;
        const w = cp[c] - cp[c - 1];
        if (!w) continue;
        let spillTo = 0;
        const d = cell.value;
        const wraps = cell.alignment?.wrapText;
        const filled = cell.fill?.pattern === "solid";
        if (!wraps && !filled && d != null && (typeof d === "string" || d.richText) && (!cell.alignment?.horizontal || cell.alignment.horizontal === "left" || cell.alignment.horizontal === "general")) {
          let cc = c + 1;
          while (cc <= Math.min(st.cols, c + 30) && emptyCell(row.findCell(cc)) && !(st.mergeAt.size && mergeOf(r, cc))) cc++;
          if (cc > c + 1) spillTo = cp[cc - 1];
        }
        if (c < c0 && !spillTo) continue;
        html += cellHtml(cell, cp[c - 1], y, w, hgt, spillTo);
      }
    }
    cells.innerHTML = html;
  }

  function boxOf(top, left, bottom, right) {
    const { rowPos: rp, colPos: cp } = st;
    // widen to cover merged cells touching the edges
    for (const m of st.merges) {
      if (m.bottom < top || m.top > bottom || m.right < left || m.left > right) continue;
      top = Math.min(top, m.top); left = Math.min(left, m.left);
      bottom = Math.max(bottom, m.bottom); right = Math.max(right, m.right);
    }
    bottom = Math.min(bottom, st.rows);
    right = Math.min(right, st.cols);
    return { x: cp[left - 1], y: rp[top - 1], w: cp[right] - cp[left - 1], h: rp[bottom] - rp[top - 1] };
  }

  /* The cells a formula reads, outlined (each range its own colour) - while it is typed, and while its
     cell is the one selected. Refs in "quotes" are text, not cells. */
  const REF_COLORS = ["#4c8dff", "#e5534b", "#9b6bdf", "#3fb27f", "#e0a84a", "#d2589a"];
  function paintRefs(text) {
    const src = String(text || "");
    if (src[0] !== "=") { if (refBoxes.firstChild) refBoxes.replaceChildren(); return; }
    const bare = src.replace(/"[^"]*"?/g, (m) => " ".repeat(m.length));
    const boxes = [];
    const colIdx = (s) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
    let k = 0;
    for (const m of bare.matchAll(/(?<![A-Za-z0-9_!])\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?(?![A-Za-z0-9_(])/g)) {
      const c0 = colIdx(m[1]), r0 = +m[2], c1 = m[3] ? colIdx(m[3]) : c0, r1 = m[4] ? +m[4] : r0;
      const top = Math.min(r0, r1), bottom = Math.max(r0, r1), left = Math.min(c0, c1), right = Math.max(c0, c1);
      if (top < 1 || left < 1 || top > st.rows || left > st.cols) continue;
      const b = boxOf(top, left, bottom, right);
      const color = REF_COLORS[k++ % REF_COLORS.length];
      boxes.push(h("div", { class: "xl-ref", style: { left: b.x - 1 + "px", top: b.y - 1 + "px", width: b.w + 1 + "px", height: b.h + 1 + "px", "--rc": color } }));
    }
    refBoxes.replaceChildren(...boxes);
  }

  function paintSelection() {
    const s = selRange();
    const b = boxOf(s.top, s.left, s.bottom, s.right);
    Object.assign(selBox.style, { left: b.x - 1 + "px", top: b.y - 1 + "px", width: b.w + 1 + "px", height: b.h + 1 + "px" });
    selBox.classList.toggle("multi", s.top !== s.bottom || s.left !== s.right);
    const a = boxOf(st.r, st.c, st.r, st.c);
    Object.assign(cursor.style, { left: a.x - 1 + "px", top: a.y - 1 + "px", width: a.w + 1 + "px", height: a.h + 1 + "px" });
    const multi = s.top !== s.bottom || s.left !== s.right;
    nameBox.textContent = multi ? `${colName(s.left)}${s.top}:${colName(s.right)}${s.bottom}` : colName(st.c) + st.r;
    paintSum();
    if (!barEditing && !editing) {
      const cell = st.ws.findCell(...master(st.r, st.c));
      fx.value = cell ? rawOf(cell) : "";
    }
    paintRefs(editing ? editor.value : fx.value);
    for (const n of colLabels.children) {
      const c = +n.dataset.c;
      n.classList.toggle("on", c >= s.left && c <= s.right);
    }
    for (const n of rowHead.children) {
      const r = +n.textContent;
      n.classList.toggle("on", r >= s.top && r <= s.bottom);
    }
  }

  function selectAll() {
    st.r = st.c = 1;
    st.er = st.rows;
    st.ec = st.cols;
    paint(true);
  }

  function master(r, c) {
    const m = st.mergeAt.size && mergeOf(r, c);
    return m ? [m.top, m.left] : [r, c];
  }

  function reveal(r, c) {
    const b = boxOf(r, c, r, c);
    const vh = scroller.clientHeight / Z - HEAD_H, vw = scroller.clientWidth / Z - st.rowW;
    const top = scroller.scrollTop / Z, left = scroller.scrollLeft / Z;
    if (b.y < top) scroller.scrollTop = b.y * Z;
    else if (b.y + b.h > top + vh) scroller.scrollTop = (b.y + b.h - vh) * Z;
    if (b.x < left) scroller.scrollLeft = b.x * Z;
    else if (b.x + b.w > left + vw) scroller.scrollLeft = Math.max(0, b.x + b.w - vw) * Z;
  }

  function select(r, c, extend) {
    r = Math.max(1, Math.min(MAX_ROWS, r));
    c = Math.max(1, Math.min(MAX_COLS, c));
    if (r > st.rows || c > st.cols) {
      st.rows = Math.max(st.rows, Math.min(MAX_ROWS, r + 20));
      st.cols = Math.max(st.cols, Math.min(MAX_COLS, c + 5));
      layout();
    }
    if (extend) { st.er = r; st.ec = c; }
    else { st.r = st.er = r; st.c = st.ec = c; }
    reveal(r, c);
    paint(true);
  }

  // ── editing
  const undo = [], redo = [];
  function writeCell(r, c, value) {
    const [mr, mc] = master(r, c);
    const cell = st.ws.getCell(mr, mc);
    const v = cell.value;
    // a shared-formula master is about to change: pin its dependents first
    if (isFormula(v) && v.shareType === "shared") {
      const addr = cell.address;
      st.ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (x) => {
        const xv = x.value;
        if (isFormula(xv) && xv.sharedFormula === addr) x.value = { formula: x.formula, result: xv.result };
      }));
      cell.value = { formula: v.formula, result: v.result };
    }
    if (value instanceof Date && !cell.numFmt) cell.numFmt = value.getUTCHours() || value.getUTCMinutes() ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd";
    cell.value = value;
    if (isFormula(value)) wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
    return { r: mr, c: mc, before: v };
  }
  function commitChanges(list) {
    const changes = list.map(([r, c, v]) => writeCell(r, c, v));
    recalc(st.ws);
    undo.push({ ws: st.ws, changes });
    if (undo.length > 200) undo.shift();
    redo.length = 0;
    ver.bump();
    paint(true);
  }
  function applyHistory(from, to) {
    const step = from.pop();
    if (!step) return;
    if (st.ws !== step.ws) showSheet(step.ws);
    const back = [];
    for (const ch of [...step.changes].reverse()) {
      const cell = st.ws.getCell(ch.r, ch.c);
      back.push({ r: ch.r, c: ch.c, before: cell.value });
      cell.value = ch.before;
    }
    to.push({ ws: step.ws, changes: back.reverse() });
    recalc(st.ws);
    const first = step.changes[0];
    if (first) select(first.r, first.c);
    ver.bump();
    paint(true);
  }

  let editing = null; // { r, c, mode: "enter" | "edit", original }
  let barEditing = false;

  /* Writing a formula by pointing, as in Excel: while the text starts with "=" and the caret sits where a
     reference can go (after "=", "(", ",", an operator or a space), a click on a cell writes its address
     there, a drag makes it a range, and another click swaps the one just written. */
  const REF_SLOT = /(^=|[=(,+\-*/^&<>:;\s])$/;
  let pointRef = null; // { input, from, to } - the address written by the last click
  const pointInput = () => (editing ? editor : barEditing ? fx : null);
  const freshPoint = (inp) => !!pointRef && pointRef.input === inp && inp.selectionStart === pointRef.to && inp.selectionEnd === pointRef.to;
  function canPoint(inp) {
    if (!inp || inp.value[0] !== "=") return false;
    if (freshPoint(inp)) return true;
    return inp.selectionStart === inp.selectionEnd && REF_SLOT.test(inp.value.slice(0, inp.selectionStart));
  }
  function writeRef(inp, r0, c0, r1, c1) {
    const t = Math.min(r0, r1), b = Math.max(r0, r1), l = Math.min(c0, c1), rt = Math.max(c0, c1);
    const ref = colName(l) + t + (t !== b || l !== rt ? ":" + colName(rt) + b : "");
    const fresh = freshPoint(inp);
    const from = fresh ? pointRef.from : inp.selectionStart, to = fresh ? pointRef.to : inp.selectionEnd;
    inp.setRangeText(ref, from, to, "end");
    pointRef = { input: inp, from, to: from + ref.length };
    inp.dispatchEvent(new Event("input"));
  }

  /* Function suggestions: typing a name after "=" (or an operator) lists the functions this sheet works out,
     each with how it is written and what it does; inside one, its own line says what goes where.
     Up / Down pick, Tab (or Enter on a picked one, or a click) puts it in with its "(". */
  const suggest = h("div", { class: "xl-suggest", hidden: true });
  let sugList = [], sugAt = -1, sugFrom = 0;
  const COMMON = ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "IF", "ROUND", "CONCAT"];
  function paintSuggest(inp) {
    const v = inp && inp.value, at = inp ? inp.selectionStart : 0;
    if (!inp || !v || v[0] !== "=" || inp.selectionStart !== inp.selectionEnd) return hideSuggest();
    const before = v.slice(0, at);
    const m = /[A-Za-z][A-Za-z0-9.]*$/.exec(before);
    let rows = [];
    sugList = [];
    if (m && REF_SLOT.test(before.slice(0, m.index))) {
      const q = m[0].toUpperCase();
      sugList = Object.keys(FN_HELP).filter((n) => n.startsWith(q) && n !== q);
      sugFrom = m.index;
    } else if (before === "=") { sugList = COMMON; sugFrom = 1; }
    if (sugList.length) {
      sugAt = Math.min(sugAt, sugList.length - 1);
      rows = sugList.slice(0, 8).map((n, i) => h("div", { class: "xl-sug" + (i === sugAt ? " is-on" : ""), onmousedown: (e) => { e.preventDefault(); takeSuggest(inp, n); } },
        h("b", { text: FN_HELP[n][0] }), h("span", { text: FN_HELP[n][1] })));
    } else {
      // inside a function: what it takes, as a line of its own
      let depth = 0, k = before.length - 1;
      for (; k >= 0; k--) { const ch = before[k]; if (ch === ")") depth++; else if (ch === "(") { if (!depth) break; depth--; } }
      const fn = k > 0 ? /[A-Za-z][A-Za-z0-9.]*$/.exec(before.slice(0, k)) : null;
      const help = fn && FN_HELP[fn[0].toUpperCase()];
      if (help) rows = [h("div", { class: "xl-sug is-hint" }, h("b", { text: help[0] }), h("span", { text: help[1] }))];
    }
    if (!rows.length) return hideSuggest();
    suggest.replaceChildren(...rows);
    if (!suggest.isConnected) document.body.append(suggest);
    suggest.hidden = false;
    const r = inp.getBoundingClientRect();
    suggest.style.left = Math.max(8, Math.min(innerWidth - suggest.offsetWidth - 8, r.left)) + "px";
    const below = r.bottom + 4;
    suggest.style.top = (below + suggest.offsetHeight < innerHeight - 8 ? below : Math.max(8, r.top - suggest.offsetHeight - 4)) + "px";
  }
  function hideSuggest() { suggest.hidden = true; sugList = []; sugAt = -1; }
  function takeSuggest(inp, name) {
    inp.setRangeText(name + "(", sugFrom, inp.selectionStart, "end");
    hideSuggest();
    inp.dispatchEvent(new Event("input"));
  }
  /** The suggestion keys, before the input's own: true when one was used. */
  function suggestKey(e, inp) {
    if (suggest.hidden) return false;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideSuggest(); return true; }
    if (!sugList.length) return false;
    const n = Math.min(8, sugList.length);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); sugAt = e.key === "ArrowDown" ? (sugAt + 1) % n : (sugAt <= 0 ? n - 1 : sugAt - 1); paintSuggest(inp); return true; }
    if (e.key === "Tab" || (e.key === "Enter" && sugAt >= 0)) { e.preventDefault(); e.stopPropagation(); takeSuggest(inp, sugList[Math.max(0, sugAt)]); return true; }
    return false;
  }

  function startEdit(initial, mode) {
    if (!editable) return;
    const [r, c] = master(st.r, st.c);
    const cell = st.ws.findCell(r, c);
    const original = cell ? rawOf(cell) : "";
    editing = { r, c, mode, original };
    const b = boxOf(r, c, r, c);
    const sty = cell ? styleOf(cell, display(cell).kind) : { cls: [] };
    Object.assign(editor.style, {
      left: b.x - 1 + "px", top: b.y - 1 + "px",
      minWidth: b.w + 1 + "px", height: Math.max(b.h + 1, 22) + "px",
    });
    editor.className = "xl-edit " + sty.cls.filter((x) => /^[bius]$/.test(x)).join(" ");
    editor.hidden = false;
    editor.value = initial ?? original;
    fx.value = editor.value;
    editor.focus({ preventScroll: true });
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
  }
  // keep: the keys went somewhere else on purpose (the formula bar was clicked) - leave them there
  function endEdit(commit, keep = false) {
    if (!editing) return;
    hideSuggest();
    pointRef = null;
    const e = editing;
    editing = null;
    editor.hidden = true;
    if (commit && editor.value !== e.original) {
      commitChanges([[e.r, e.c, parseCellInput(editor.value)]]);
    }
    paint(true);
    if (!keep) scroller.focus({ preventScroll: true });
  }

  /** A block of cells moved (with `copy`, copied) by dr rows and dc columns, as one undo step.
      ponytail: values only, formulas keep their references as written. */
  function moveRange(f, dr, dc, copy) {
    const at = new Map();
    if (!copy) for (let r = f.top; r <= f.bottom; r++) for (let c = f.left; c <= f.right; c++) if (valueAt(r, c) != null) at.set(r * MAX_COLS + c, [r, c, null]);
    for (let r = f.top; r <= f.bottom; r++) for (let c = f.left; c <= f.right; c++) at.set((r + dr) * MAX_COLS + c + dc, [r + dr, c + dc, valueAt(r, c)]);
    commitChanges([...at.values()]);
  }
  /* Rows (or columns) in and out: from `at` on, everything moves `n` along (n < 0: rows at..at-n-1 go),
     values only, one undo step - the same way moveRange does it. */
  /** A formula's relative references moved along by dr rows, dc columns ($ keeps a part fixed), as a copy in Excel does.
      ponytail: plain A1 references and ranges; sheet-qualified names keep their place too. */
  const shiftRefs = (f, dr, dc) => f.replace(/("[^"]*")|(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g, (m, str, cd, col, rd, row, at, all) => {
    if (str) return str;
    if (at > 0 && /[A-Za-z0-9_.]/.test(all[at - 1])) return m;
    let n = 0;
    for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
    const c = cd ? n : n + dc, r = rd ? +row : +row + dr;
    return c < 1 || r < 1 ? "#REF!" : `${cd}${colName(c)}${rd}${r}`;
  });
  /** Fill down (or right): the first row (column) of the selection into the rest of it. */
  function fill(down) {
    const s = selRange();
    if (down ? s.bottom === s.top : s.right === s.left) return;
    const list = [];
    for (let r = s.top; r <= s.bottom; r++) for (let c = s.left; c <= s.right; c++) {
      if (down ? r === s.top : c === s.left) continue;
      const v = down ? valueAt(s.top, c) : valueAt(r, s.left);
      list.push([r, c, isFormula(v) ? { formula: shiftRefs(v.formula, down ? r - s.top : 0, down ? 0 : c - s.left) } : v]);
    }
    commitChanges(list);
  }
  /** The next cell (after the cursor, row by row; `back` before it) whose shown text has `q`. */
  function findNext(q, back) {
    q = q.trim().toLowerCase();
    if (!q) return;
    const R = lastDataRow(), C = lastDataCol(), n = R * C;
    let i = (st.r - 1) * C + (st.c - 1);
    for (let k = 0; k < n; k++) {
      i = (i + (back ? -1 : 1) + n) % n;
      const r = Math.floor(i / C) + 1, c = (i % C) + 1;
      const cell = st.ws.findCell(r, c);
      if (cell && cell.value != null && display(cell).text.toLowerCase().includes(q)) { select(r, c); return; }
    }
    findIn.classList.add("is-none");
    setTimeout(() => findIn.classList.remove("is-none"), 600);
  }
  findIn.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); findNext(findIn.value, e.shiftKey); }
    else if (e.key === "Escape") { e.preventDefault(); findIn.value = ""; scroller.focus({ preventScroll: true }); }
  });
  /** Count, sum and average of the picked cells, while more than one is picked. */
  let sumKey = "";
  function paintSum() {
    const s = selRange();
    const key = `${s.top},${s.left},${s.bottom},${s.right},${undo.length},${redo.length}`;
    if (key === sumKey) return;
    sumKey = key;
    if (s.top === s.bottom && s.left === s.right) { sumEl.textContent = ""; return; }
    let count = 0, nums = 0, sum = 0;
    const bottom = Math.min(s.bottom, lastDataRow()), right = Math.min(s.right, lastDataCol());
    if ((bottom - s.top + 1) * (right - s.left + 1) > 400000) { sumEl.textContent = ""; return; }
    for (let r = s.top; r <= bottom; r++) for (let c = s.left; c <= right; c++) {
      let v = valueAt(r, c);
      if (v == null || v === "") continue;
      count++;
      if (isFormula(v)) v = v.result;
      if (typeof v === "number" && isFinite(v)) { nums++; sum += v; }
    }
    const f = (x) => (Math.round(x * 1000) / 1000).toLocaleString();
    sumEl.textContent = !count ? "" : nums ? `Count ${count} · Sum ${f(sum)} · Average ${f(sum / nums)}` : `Count ${count}`;
  }
  /** A column made as wide as its widest shown text (a double-click on its edge in the header). */
  function autofit(c) {
    const g = document.createElement("canvas").getContext("2d");
    g.font = getComputedStyle(cells).font || "13px sans-serif";
    let w = g.measureText(colName(c)).width;
    const R = Math.min(lastDataRow(), 5000);
    for (let r = 1; r <= R; r++) { const cell = st.ws.findCell(r, c); if (cell && cell.value != null) w = Math.max(w, g.measureText(display(cell).text).width); }
    st.ws.getColumn(c).width = Math.max(2, Math.round(((w + 14) / 7) * 100) / 100);
    ver.bump();
    layout();
    paint(true);
  }
  function shiftAxis(rows, at, n) {
    const last = rows ? lastDataRow() : lastDataCol(), across = rows ? lastDataCol() : lastDataRow();
    if (n > 0 && at > last) return;
    const from = n > 0 ? at : at - n, end = Math.max(last, from + Math.abs(n) - 1);
    if (rows && end + n > st.rows) { st.rows = end + n + 20; layout(); }
    if (!rows && end + n > st.cols) { st.cols = end + n + 5; layout(); }
    moveRange(rows ? { top: from, bottom: end, left: 1, right: across } : { top: 1, bottom: across, left: from, right: end }, rows ? n : 0, rows ? 0 : n);
  }
  /** The picked rows sorted by the column the cursor is in; one cell picked: the whole table under its first row. */
  function sortRows(desc) {
    const s = selRange();
    const one = s.top === s.bottom && s.left === s.right;
    const top = one ? 2 : s.top, bottom = one ? lastDataRow() : s.bottom, left = one ? 1 : s.left, right = one ? lastDataCol() : s.right;
    if (bottom <= top || st.c < left || st.c > right) return;
    const rows = [];
    for (let r = top; r <= bottom; r++) { const row = []; for (let c = left; c <= right; c++) row.push(valueAt(r, c)); rows.push(row); }
    const key = (v) => (v == null ? null : v instanceof Date ? v.getTime() : typeof v === "object" ? (v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join("") : null)) : v);
    const k = st.c - left;
    rows.sort((a, b) => {
      const x = key(a[k]), y = key(b[k]);
      if (x == null || x === "") return y == null || y === "" ? 0 : 1; // empty cells last, either way
      if (y == null || y === "") return -1;
      const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return desc ? -d : d;
    });
    const list = [];
    rows.forEach((row, i) => row.forEach((v, j) => list.push([top + i, left + j, v])));
    commitChanges(list);
  }
  /** What can be done to the cells picked: the clipboard, rows and columns in and out, sorting - for the
      right-click menu and the bar of commands above the sheet alike. */
  function commands() {
    const s = selRange();
    const nr = s.bottom - s.top + 1, nc = s.right - s.left + 1;
    const R = nr > 1 ? `${nr} rows` : "a row", C = nc > 1 ? `${nc} columns` : "a column";
    const copy = () => navigator.clipboard.writeText(rangeTsv()).catch(() => {});
    return [
      editable ? { id: "cut", label: "Cut", icon: "scissors", keys: "Ctrl X", run: () => { copy(); clearRange(); } } : null,
      { id: "copy", label: "Copy", icon: "clipboard", keys: "Ctrl C", run: copy },
      editable ? { id: "paste", label: "Paste", icon: "clipboard", keys: "Ctrl V", run: () => navigator.clipboard.readText().then((t) => { if (t) pasteTsv(t); }).catch(() => {}) } : null,
      editable ? { id: "clear", label: "Clear", icon: "x", keys: "Del", run: clearRange } : null,
      ...(editable ? [
        "sep",
        { id: "rowUp", label: `Insert ${R} above`, icon: "arrowUp", run: () => shiftAxis(true, s.top, nr) },
        { id: "rowDown", label: `Insert ${R} below`, icon: "arrowDown", run: () => shiftAxis(true, s.bottom + 1, nr) },
        { id: "colLeft", label: `Insert ${C} left`, icon: "columns", run: () => shiftAxis(false, s.left, nc) },
        { id: "colRight", label: `Insert ${C} right`, icon: "columns", run: () => shiftAxis(false, s.right + 1, nc) },
        { id: "rowDel", label: `Delete ${nr > 1 ? "these rows" : "this row"}`, icon: "trash", run: () => shiftAxis(true, s.top, -nr) },
        { id: "colDel", label: `Delete ${nc > 1 ? "these columns" : "this column"}`, icon: "trash", run: () => shiftAxis(false, s.left, -nc) },
        "sep",
        { id: "fillDown", label: "Fill down", icon: "arrowDown", keys: "Ctrl D", run: () => fill(true) },
        { id: "fillRight", label: "Fill right", icon: "arrowRight", keys: "Ctrl R", run: () => fill(false) },
        "sep",
        { id: "sortUp", label: `Sort A → Z by column ${colName(st.c)}`, icon: "arrowDown", run: () => sortRows(false) },
        { id: "sortDown", label: "Sort Z → A", icon: "arrowUp", run: () => sortRows(true) },
        { header: "To move cells, drag the edge of a selection (Ctrl: copy, Shift: make room)", plain: true },
      ] : []),
    ].filter(Boolean);
  }
  /** Right-click on the cells: the same commands, for what is under the pointer. */
  function onBodyMenu(e) {
    e.preventDefault();
    if (editing) endEdit(true);
    const p = hit(e);
    const s = selRange();
    if (p.r < s.top || p.r > s.bottom || p.c < s.left || p.c > s.right) select(p.r, p.c);
    menu(e.clientX, e.clientY, commands());
  }
  // the bar of commands above the sheet: each button runs what the menu's row of the same id would
  const runCmd = (id) => {
    if (editing) endEdit(true);
    const c = id === "undo" ? { run: () => applyHistory(undo, redo) } : id === "redo" ? { run: () => applyHistory(redo, undo) } : commands().find((x) => x.id === id);
    if (c) c.run();
    scroller.focus({ preventScroll: true });
  };
  const cmdBtn = (id, ic, label, title) => h("button", { class: "xl-cmd", type: "button", title, onmousedown: (e) => e.preventDefault(), onclick: () => runCmd(id) }, icon(ic), label ? h("span", { text: label }) : null);
  const cmdSep = () => h("span", { class: "xl-cmd-sep" });
  cmds.append(...(editable ? [
    cmdBtn("undo", "undo", "", "Undo (Ctrl+Z)"), cmdBtn("redo", "redo", "", "Redo (Ctrl+Y)"), cmdSep(),
    cmdBtn("cut", "scissors", "", "Cut (Ctrl+X)"), cmdBtn("copy", "clipboard", "", "Copy (Ctrl+C)"), cmdBtn("paste", "clipboard", "Paste", "Paste (Ctrl+V) - more than the selection holds makes room"), cmdBtn("clear", "x", "", "Clear (Del)"), cmdSep(),
    cmdBtn("rowUp", "arrowUp", "Row above", "Insert rows above the selection"), cmdBtn("rowDown", "arrowDown", "Row below", "Insert rows below the selection"),
    cmdBtn("colLeft", "columns", "Column left", "Insert columns left of the selection"), cmdBtn("colRight", "columns", "Column right", "Insert columns right of the selection"),
    cmdBtn("rowDel", "trash", "Delete rows", "Delete the selected rows"), cmdBtn("colDel", "trash", "Delete columns", "Delete the selected columns"), cmdSep(),
    cmdBtn("sortUp", "arrowDown", "A → Z", "Sort by the cursor's column, A to Z (one cell picked: the whole table under its first row)"), cmdBtn("sortDown", "arrowUp", "Z → A", "Sort by the cursor's column, Z to A"),
    cmdSep(), cmdBtn("fillDown", "arrowDown", "Fill down", "The first row of the selection copied into the rest (Ctrl+D) - formulas follow, as in Excel"),
    cmdBtn("fillRight", "arrowRight", "Fill right", "The first column of the selection copied into the rest (Ctrl+R)"), cmdSep(),
  ] : [cmdBtn("copy", "clipboard", "Copy", "Copy (Ctrl+C)")]), findIn, sumEl);
  /** Shift-drag: the block goes `dr` rows (or `dc` columns) along and the cells it passes slide over into its
      old place - nothing is written over. Within the block's own columns (rows), values only, one undo step. */
  function slideRange(f, dr, dc) {
    const rows = dr !== 0, n = rows ? dr : dc;
    const lo = rows ? f.top : f.left, hi = rows ? f.bottom : f.right;
    const a = Math.min(lo, lo + n), b = Math.max(hi, hi + n);
    const order = [];
    for (let k = a; k <= b; k++) if (k < lo || k > hi) order.push(k);
    order.splice(lo + n - a, 0, ...Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
    const x0 = rows ? f.left : f.top, x1 = rows ? f.right : f.bottom;
    const list = [];
    order.forEach((old, i) => {
      const k = a + i;
      if (old !== k) for (let x = x0; x <= x1; x++) list.push(rows ? [k, x, valueAt(old, x)] : [x, k, valueAt(x, old)]);
    });
    if (list.length) commitChanges(list);
  }
  function clearRange() {
    const s = selRange();
    const list = [];
    const done = new Set();
    for (let r = s.top; r <= s.bottom; r++) {
      const row = st.ws.findRow(r);
      if (!row) continue;
      for (let c = s.left; c <= s.right; c++) {
        const cell = row.findCell(c);
        if (!cell || cell.value == null) continue;
        const [mr, mc] = master(r, c);
        const k = mr * MAX_COLS + mc;
        if (done.has(k)) continue;
        done.add(k);
        list.push([mr, mc, null]);
      }
    }
    if (list.length) commitChanges(list);
  }

  function rangeTsv() {
    const s = selRange();
    const out = [];
    for (let r = s.top; r <= s.bottom; r++) {
      const row = [];
      for (let c = s.left; c <= s.right; c++) {
        const cell = st.ws.findCell(r, c);
        row.push(cell ? display(cell).text.replace(/[\t\n]/g, " ") : "");
      }
      out.push(row.join("\t"));
    }
    return out.join("\n");
  }

  const valueAt = (r, c) => { const cell = st.ws.findCell(r, c); return cell ? cell.value : null; };
  /* Cells pushed along to make room: below `from` (in columns a0..a1) they move `n` rows down, or right
     of `from` (in rows a0..a1) `n` columns right. Values only - formats stay where they are. */
  function makeRoom(at, { down, from, n, a0, a1 }) {
    const end = down ? lastDataRow() : lastDataCol();
    for (let k = from + 1; k <= end; k++) for (let a = a0; a <= a1; a++) {
      const v = down ? valueAt(k, a) : valueAt(a, k);
      const [r, c] = down ? [k, a] : [a, k];
      if (v != null && !at.has(r * MAX_COLS + c)) at.set(r * MAX_COLS + c, [r, c, null]);
    }
    for (let k = from + 1; k <= end; k++) for (let a = a0; a <= a1; a++) {
      const v = down ? valueAt(k, a) : valueAt(a, k);
      const [r, c] = down ? [k + n, a] : [a, k + n];
      if (v != null) at.set(r * MAX_COLS + c, [r, c, v]);
    }
  }
  function pasteTsv(text) {
    const rows = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    const width = Math.max(...rows.map((r) => r.length));
    // a range picked: the paste starts at its corner, and when more comes than the range holds, the
    // cells after it move along to make room instead of being written over
    const sel = selRange();
    const picked = sel.top !== sel.bottom || sel.left !== sel.right;
    const r0 = picked ? sel.top : st.r, c0 = picked ? sel.left : st.c;
    const selH = sel.bottom - sel.top + 1, selW = sel.right - sel.left + 1;
    const at = new Map();
    if (picked && rows.length > selH) makeRoom(at, { down: true, from: sel.bottom, n: rows.length - selH, a0: c0, a1: c0 + width - 1 });
    else if (picked && width > selW) makeRoom(at, { down: false, from: sel.right, n: width - selW, a0: r0, a1: r0 + rows.length - 1 });
    rows.forEach((row, i) => row.forEach((v, j) => {
      const r = r0 + i, c = c0 + j;
      if (r <= MAX_ROWS && c <= MAX_COLS) at.set(r * MAX_COLS + c, [r, c, parseCellInput(v)]);
    }));
    const list = [...at.values()].filter(([r, c]) => r <= MAX_ROWS && c <= MAX_COLS);
    if (!list.length) return;
    st.r = r0; st.c = c0;
    const lastR = Math.min(MAX_ROWS, Math.max(r0 + rows.length - 1, ...list.map((x) => x[0])));
    const lastC = Math.min(MAX_COLS, Math.max(c0 + width - 1, ...list.map((x) => x[1])));
    if (lastR > st.rows || lastC > st.cols) {
      st.rows = Math.max(st.rows, lastR + 20);
      st.cols = Math.max(st.cols, lastC + 5);
      layout();
    }
    commitChanges(list);
    st.er = r0 + rows.length - 1; st.ec = c0 + width - 1;
    paint(true);
  }

  // ── navigation
  function lastDataRow() {
    let last = 0;
    st.ws.eachRow({ includeEmpty: false }, (_, n) => { last = n; });
    return Math.max(1, last);
  }
  function lastDataCol() {
    return Math.max(1, st.ws.actualColumnCount || st.ws.columnCount || 1);
  }
  function move(dr, dc, extend) {
    let r = extend ? st.er : st.r, c = extend ? st.ec : st.c;
    // step out of a merged area from its edge
    const m = !extend && st.mergeAt.size && mergeOf(r, c);
    if (m) {
      if (dr > 0) r = m.bottom; if (dr < 0) r = m.top;
      if (dc > 0) c = m.right; if (dc < 0) c = m.left;
    }
    r += dr; c += dc;
    // skip hidden rows/columns
    while (dr && r >= 1 && r <= st.rows && rowPx(r) === 0) r += dr;
    while (dc && c >= 1 && c <= st.cols && colPx(c) === 0) c += dc;
    if (r < 1 || c < 1) { r = Math.max(1, r); c = Math.max(1, c); }
    select(r, c, extend);
  }
  const pageRows = () => Math.max(1, Math.floor((scroller.clientHeight / Z - HEAD_H) / defRowPx()) - 1);

  function onGridKey(e) {
    if (e.target !== scroller) return;
    const mod = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const k = e.key;
    if (mod && e.code === "KeyZ") { e.preventDefault(); shift ? applyHistory(redo, undo) : applyHistory(undo, redo); return; }
    if (mod && e.code === "KeyY") { e.preventDefault(); applyHistory(redo, undo); return; }
    if (mod && e.code === "KeyA") { e.preventDefault(); selectAll(); return; }
    if (mod && !shift && e.code === "KeyF") { e.preventDefault(); e.stopPropagation(); findIn.focus(); findIn.select(); return; }
    if (editable && mod && !shift && (e.code === "KeyD" || e.code === "KeyR")) { e.preventDefault(); e.stopPropagation(); fill(e.code === "KeyD"); return; }
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) {
      e.preventDefault();
      const [dr, dc] = arrows[k];
      if (mod) {
        const r = dr < 0 ? 1 : dr > 0 ? lastDataRow() : shift ? st.er : st.r;
        const c = dc < 0 ? 1 : dc > 0 ? lastDataCol() : shift ? st.ec : st.c;
        select(r, c, shift);
      } else move(dr, dc, shift);
      return;
    }
    switch (k) {
      case "Tab": e.preventDefault(); move(0, shift ? -1 : 1); return;
      case "PageDown": e.preventDefault(); move(pageRows(), 0, shift); return;
      case "PageUp": e.preventDefault(); move(-pageRows(), 0, shift); return;
      case "Home": e.preventDefault(); select(mod ? 1 : shift ? st.er : st.r, 1, shift); return;
      case "End": e.preventDefault(); select(mod ? lastDataRow() : shift ? st.er : st.r, lastDataCol(), shift); return;
    }
    if (!editable) return;
    if (k === "Enter" || k === "F2") { e.preventDefault(); startEdit(null, "edit"); return; }
    if (k === "Delete") { e.preventDefault(); clearRange(); return; }
    if (k === "Backspace") { e.preventDefault(); startEdit("", "enter"); return; }
    if (!mod && !e.altKey && k.length === 1) { e.preventDefault(); startEdit(k, "enter"); return; }
    if (k === "Process" || k === "Dead") startEdit("", "enter");
  }

  function onEditorKey(e) {
    if (e.isComposing) return;
    if (suggestKey(e, editor)) return;
    const k = e.key;
    const done = (dr, dc) => { e.preventDefault(); endEdit(true); if (dr || dc) move(dr, dc); };
    if (k === "Enter") return done(e.shiftKey ? -1 : 1, 0);
    if (k === "Tab") return done(0, e.shiftKey ? -1 : 1);
    if (k === "Escape") { e.preventDefault(); endEdit(false); return; }
    // nothing typed yet (a click opens the editor): Ctrl+Z / Ctrl+Y are the sheet's, not the empty box's
    if ((e.ctrlKey || e.metaKey) && (e.code === "KeyZ" || e.code === "KeyY") && editing && editor.value === editing.original) {
      e.preventDefault();
      endEdit(false);
      e.code === "KeyY" || e.shiftKey ? applyHistory(redo, undo) : applyHistory(undo, redo);
      return;
    }
    if (editing?.mode === "enter") {
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (arrows[k]) return done(...arrows[k]);
    }
    e.stopPropagation();
  }

  function onBarKey(e) {
    if (e.isComposing) return;
    if (suggestKey(e, fx)) return;
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const [r, c] = master(st.r, st.c);
      const cell = st.ws.findCell(r, c);
      if (fx.value !== (cell ? rawOf(cell) : "")) {
        commitChanges([[r, c, parseCellInput(fx.value)]]);
      }
      barEditing = false;
      scroller.focus({ preventScroll: true });
      if (e.key === "Enter") move(e.shiftKey ? -1 : 1, 0); else move(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      barEditing = false;
      scroller.focus({ preventScroll: true });
      paint(true);
    }
  }

  // ── mouse
  function hit(e) {
    const rect = layer.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Z, y = (e.clientY - rect.top) / Z;
    return {
      r: Math.min(st.rows, bisect(st.rowPos, Math.max(0, y)) + 1),
      c: Math.min(st.cols, bisect(st.colPos, Math.max(0, x)) + 1),
      x, y,
    };
  }
  let drag = null;
  function onBodyDown(e) {
    if (e.button !== 0) return;
    if (editing && e.target === editor) return;
    // a formula being written: the click points at a cell instead of leaving the edit
    const inp = pointInput();
    if (inp && !e.target.closest(".xl-rowhead") && canPoint(inp)) {
      e.preventDefault();
      const p = hit(e);
      writeRef(inp, p.r, p.c, p.r, p.c);
      drag = { kind: "point", input: inp, r: p.r, c: p.c };
      inp.focus({ preventScroll: true });
      return;
    }
    if (editing) endEdit(true);
    e.preventDefault();
    scroller.focus({ preventScroll: true });
    const onRowHead = e.target.closest(".xl-rowhead");
    const p = hit(e);
    if (onRowHead) {
      if (!e.shiftKey) { st.r = p.r; st.c = 1; }
      st.er = p.r; st.ec = st.cols;
      drag = { kind: "row" };
      paint(true);
    } else if (editable && !e.shiftKey && onSelEdge(p)) {
      drag = { kind: "move", from: selRange(), r: p.r, c: p.c, dr: 0, dc: 0 };
    } else {
      if (e.shiftKey) { st.er = p.r; st.ec = p.c; paint(true); }
      else select(p.r, p.c);
      // a plain click that ends on the same cell opens the editor on mouseup
      const plain = editable && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
      drag = { kind: "cell", r: p.r, c: p.c, plain, x: e.clientX };
    }
  }
  function onHeadDown(e) {
    if (e.button !== 0) return;
    if (editing) endEdit(true);
    e.preventDefault();
    scroller.focus({ preventScroll: true });
    if (e.target === corner) { selectAll(); return; }
    const grip = e.target.closest(".xl-grip");
    if (grip && editable && e.detail === 2) { autofit(+grip.parentNode.dataset.c); return; }
    if (grip && editable) {
      const c = +grip.parentNode.dataset.c;
      drag = { kind: "resize", c, x0: e.clientX, w0: st.colPos[c] - st.colPos[c - 1] };
      document.body.classList.add("xl-resizing");
      return;
    }
    const p = hit(e);
    if (!e.shiftKey) { st.c = p.c; st.r = 1; }
    st.ec = p.c; st.er = st.rows;
    drag = { kind: "col" };
    paint(true);
  }
  // within a few pixels of the selection's outline: there it is picked up and moved
  function onSelEdge(p) {
    const s = selRange(), b = boxOf(s.top, s.left, s.bottom, s.right), m = 4;
    const inX = p.x > b.x - m && p.x < b.x + b.w + m, inY = p.y > b.y - m && p.y < b.y + b.h + m;
    return inX && inY && (Math.abs(p.x - b.x) < m || Math.abs(p.x - b.x - b.w) < m || Math.abs(p.y - b.y) < m || Math.abs(p.y - b.y - b.h) < m);
  }
  function onMove(e) {
    if (!drag && editable) body.style.cursor = body.contains(e.target) && onSelEdge(hit(e)) ? "move" : "";
    if (!drag) return;
    if (drag.kind === "move") {
      const p = hit(e), f = drag.from;
      drag.dr = Math.max(1 - f.top, p.r - drag.r); drag.dc = Math.max(1 - f.left, p.c - drag.c);
      drag.copy = e.ctrlKey;
      // Shift held: it goes in between, along one way only, and what was there makes room
      drag.slide = e.shiftKey && !e.ctrlKey;
      if (drag.slide) { if (Math.abs(drag.dr) >= Math.abs(drag.dc)) drag.dc = 0; else drag.dr = 0; }
      body.style.cursor = drag.copy ? "copy" : drag.slide ? (drag.dr ? "ns-resize" : "ew-resize") : "move";
      st.r = f.top + drag.dr; st.c = f.left + drag.dc; st.er = f.bottom + drag.dr; st.ec = f.right + drag.dc;
      paint(true);
      return;
    }
    if (drag.kind === "resize") {
      const w = Math.max(12, drag.w0 + (e.clientX - drag.x0) / Z);
      const d = w - (st.colPos[drag.c] - st.colPos[drag.c - 1]);
      for (let c = drag.c; c <= st.cols; c++) st.colPos[c] += d;
      canvas.style.width = st.rowW + st.colPos[st.cols] + "px";
      drag.w = w;
      paint(true);
      return;
    }
    const p = hit(e);
    if (drag.kind === "point") { writeRef(drag.input, drag.r, drag.c, p.r, p.c); return; }
    if (drag.kind === "cell") {
      if (p.r !== drag.r || p.c !== drag.c) drag.plain = false;
      st.er = p.r; st.ec = p.c;
    }
    else if (drag.kind === "row") st.er = p.r;
    else if (drag.kind === "col") st.ec = p.c;
    paint(true);
  }
  function onUp() {
    if (drag?.kind === "resize") {
      document.body.classList.remove("xl-resizing");
      if (drag.w != null) {
        st.ws.getColumn(drag.c).width = Math.max(0.5, Math.round((drag.w - 5) / 7 * 100) / 100);
        ver.bump();
        layout();
        paint(true);
      }
    }
    const d = drag;
    drag = null;
    if (d?.kind === "move" && (d.dr || d.dc)) (d.slide ? slideRange : moveRange)(d.from, d.dr, d.dc, d.copy);
    if (d?.kind === "cell" && d.plain && st.r === st.er && st.c === st.ec) {
      startEdit(null, "edit");
      caretFromX(d.x);
    }
  }
  // put the caret at the clicked character when the editor shows the same text as the cell
  function caretFromX(clientX) {
    if (!editing) return;
    const cell = st.ws.findCell(editing.r, editing.c);
    if (!cell) return;
    const d = display(cell);
    if (d.text !== editor.value || styleOf(cell, d.kind).ha !== "left") return;
    const cs = getComputedStyle(editor);
    const x = (clientX - editor.getBoundingClientRect().left) / Z - parseFloat(cs.borderLeftWidth) - parseFloat(cs.paddingLeft);
    const bold = /b/.test(editor.className);
    const size = parseFloat(cs.fontSize);
    const text = editor.value;
    let i = 0;
    while (i < text.length && textWidth(text.slice(0, i + 1), bold, size) - textWidth(text[i], bold, size) / 2 < x) i++;
    editor.setSelectionRange(i, i);
  }
  function onDbl(e) {
    // the first click already opened the editor; let the input handle word selection
    if (!editable || e.target.closest(".xl-rowhead") || e.target === editor || editing) return;
    const p = hit(e);
    select(p.r, p.c);
    startEdit(null, "edit");
  }

  // ── clipboard
  function onCopy(e) {
    if (e.target !== scroller) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", rangeTsv());
    if (e.type === "cut" && editable) clearRange();
  }
  function onPaste(e) {
    if (e.target !== scroller || !editable) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain");
    if (text) pasteTsv(text);
  }

  // ── sheets
  function renderTabs() {
    tabs.replaceChildren(...sheets.map((ws) => h("button", {
      class: "xl-tab" + (st?.ws === ws ? " on" : ""),
      type: "button",
      title: ws.name,
      text: ws.name,
      onclick: () => showSheet(ws),
    })));
  }
  function showSheet(ws) {
    if (editing) endEdit(true);
    if (st) { st.top = scroller.scrollTop; st.left = scroller.scrollLeft; }
    st = stateFor(ws);
    layout();
    scroller.scrollTop = st.top;
    scroller.scrollLeft = st.left;
    renderTabs();
    paint(true);
  }

  const onScroll = () => schedule();
  const ro = new ResizeObserver(() => schedule());
  const on = [
    [scroller, "scroll", onScroll], [scroller, "keydown", onGridKey], [scroller, "copy", onCopy],
    [scroller, "cut", onCopy], [scroller, "paste", onPaste],
    [body, "mousedown", onBodyDown], [body, "dblclick", onDbl], [body, "contextmenu", onBodyMenu], [colHead, "mousedown", onHeadDown],
    [window, "mousemove", onMove], [window, "mouseup", onUp],
    [editor, "keydown", onEditorKey], [editor, "input", () => { fx.value = editor.value; paintRefs(editor.value); paintSuggest(editor); }],
    [editor, "click", () => paintSuggest(editor)], [fx, "click", () => paintSuggest(fx)],
    [editor, "blur", (e) => {
      if (!editing) return;
      if (e.relatedTarget === scroller && editor.value[0] === "=") { const a = editor.selectionStart, b = editor.selectionEnd; setTimeout(() => { if (editing) { editor.focus({ preventScroll: true }); editor.setSelectionRange(a, b); } }); return; }
      endEdit(true, e.relatedTarget === fx);
    }],
    [fx, "keydown", onBarKey], [fx, "input", () => { barEditing = true; paintRefs(fx.value); paintSuggest(fx); }],
    [fx, "blur", () => { hideSuggest(); pointRef = null; if (barEditing) { barEditing = false; paint(true); } }],
  ];
  for (const [t, ev, f] of on) t.addEventListener(ev, f);
  scroller.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const was = Z;
    Z = Math.round(Math.min(3, Math.max(0.5, Z * Math.exp(-(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * 0.0015))) * 100) / 100;
    if (Z === was) return;
    const r = scroller.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const ax = (scroller.scrollLeft + px) / was, ay = (scroller.scrollTop + py) / was;
    canvas.style.zoom = String(Z);
    scroller.scrollLeft = ax * Z - px;
    scroller.scrollTop = ay * Z - py;
    try { localStorage.setItem(ZOOM_KEY, String(Z)); } catch {}
    paint(true);
  }, { passive: false });
  ro.observe(scroller);

  showSheet(sheets[0]);

  return {
    async getBytes() {
      // autosave can land while the user is typing: save the value, keep the editor open
      if (editing && editor.value !== editing.original) {
        commitChanges([[editing.r, editing.c, parseCellInput(editor.value)]]);
        editing.original = editor.value;
      }
      const v = ver.snapshot();
      if (ver.pristine()) return csv != null ? new TextEncoder().encode(csv) : new Uint8Array(bytes);
      if (csv != null) { ver.saved(v); return new TextEncoder().encode(csvText()); }
      const buf = await wb.xlsx.writeBuffer();
      ver.saved(v);
      return new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
    },
    destroy() {
      for (const [t, ev, f] of on) t.removeEventListener(ev, f);
      ro.disconnect();
      cancelAnimationFrame(raf);
      document.body.classList.remove("xl-resizing");
      el.replaceChildren();
      el.classList.remove("office-host", "is-xlsx");
      el.style.removeProperty("--xl-roww");
    },
    dirty: () => ver.dirty() || !!(editing && editor.value !== editing.original),
  };
}
