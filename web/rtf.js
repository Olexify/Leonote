// Plain text out of an RTF document (also for .doc/.docx files that are
// really RTF inside, which Word happily saves). Paragraphs, tabs, Unicode
// escapes and the document's code page; formatting, pictures and tables'
// structure are dropped. Read-only preview, nothing is written back.

const SKIP_DEST = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer", "headerl", "headerr", "footerl", "footerr", "listtable", "listoverridetable", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "rsidtbl", "generator", "mmathPr", "fldinst"]);

export const isRtf = (bytes) => bytes.length > 5 && String.fromCharCode(...bytes.slice(0, 5)) === "{\\rtf";

export function rtfToText(src) {
  const s = typeof src === "string" ? src : new TextDecoder("latin1").decode(src);
  let codepage = 1252;
  const cp = /\\ansicpg(\d+)/.exec(s.slice(0, 400));
  if (cp) codepage = +cp[1];
  // each font can carry its own character set (charset204 = Cyrillic...)
  const CHARSET = { 0: 0, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 128: 932, 129: 949, 134: 936, 136: 950 };
  const fontCp = new Map();
  const ft = s.indexOf("\\fonttbl");
  if (ft >= 0) {
    const end = s.indexOf("}}", ft);
    for (const m of s.slice(ft, end > 0 ? end : ft + 20000).matchAll(/\\f(\d+)[^;{}]*?\\fcharset(\d+)/g)) {
      const c = CHARSET[+m[2]];
      if (c) fontCp.set(+m[1], c);
    }
  }
  const decoders = new Map();
  const decoderFor = (c) => {
    if (!decoders.has(c)) { let d; try { d = new TextDecoder("windows-" + c); } catch { d = new TextDecoder("windows-1252"); } decoders.set(c, d); }
    return decoders.get(c);
  };
  let font = -1;
  let dec = decoderFor(codepage);
  const out = [];
  let bytes = []; // pending \'hh bytes, decoded together (multi-byte code pages)
  const flush = () => { if (bytes.length) { out.push(dec.decode(new Uint8Array(bytes))); bytes = []; } };
  const stack = [];
  let skip = false;
  let uc = 1; // chars to skip after \uN
  let pendingSkip = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "{") { stack.push({ skip, uc, font }); i++; if (s.startsWith("\\*", i)) { skip = true; } continue; }
    if (ch === "}") { flush(); const t = stack.pop(); if (t) { skip = t.skip; uc = t.uc; if (t.font !== font) { font = t.font; dec = decoderFor(fontCp.get(font) || codepage); } } i++; continue; }
    if (ch === "\\") {
      const n = s[i + 1];
      if (n === "'") {
        const hex = s.substr(i + 2, 2);
        i += 4;
        if (pendingSkip > 0) { pendingSkip--; continue; }
        if (!skip) bytes.push(parseInt(hex, 16));
        continue;
      }
      if (n === "\\" || n === "{" || n === "}") { flush(); if (!skip) out.push(n); i += 2; continue; }
      if (n === "~") { flush(); if (!skip) out.push(" "); i += 2; continue; }
      if (n === "-" || n === "_") { i += 2; continue; }
      if (n === "\n" || n === "\r") { flush(); if (!skip) out.push("\n"); i += 2; continue; }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i + 1, i + 40));
      if (!m) { i += 2; continue; }
      i += 1 + m[0].length;
      const word = m[1];
      const arg = m[2] != null ? +m[2] : null;
      flush();
      if (SKIP_DEST.has(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === "f" && arg != null) { font = arg; dec = decoderFor(fontCp.get(font) || codepage); }
      else if (word === "par" || word === "line" || word === "row") out.push("\n");
      else if (word === "tab" || word === "cell") out.push("\t");
      else if (word === "uc") uc = arg ?? 1;
      else if (word === "u" && arg != null) { out.push(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); pendingSkip = uc; }
      else if (word === "emdash") out.push("—");
      else if (word === "endash") out.push("–");
      else if (word === "bullet") out.push("•");
      else if (word === "lquote") out.push("‘");
      else if (word === "rquote") out.push("’");
      else if (word === "ldblquote") out.push("“");
      else if (word === "rdblquote") out.push("”");
      continue;
    }
    if (ch === "\r" || ch === "\n") { i++; continue; }
    if (pendingSkip > 0) { pendingSkip--; i++; continue; }
    flush();
    if (!skip) out.push(ch);
    i++;
  }
  flush();
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain text back to RTF: paragraphs, tabs and any Unicode character, no formatting. */
export function textToRtf(text) {
  const bs = String.fromCharCode(92);
  let out = `{${bs}rtf1${bs}ansi${bs}ansicpg1252${bs}deff0${bs}uc1{${bs}fonttbl{${bs}f0${bs}fnil Calibri;}}${bs}f0${bs}fs22 `;
  const u = (n) => `${bs}u${n > 32767 ? n - 65536 : n}?`;
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const TAB = String.fromCharCode(9);
  for (const ch of String(text).split(CR + NL).join(NL).split(CR).join(NL)) {
    const c = ch.codePointAt(0);
    if (ch === bs || ch === "{" || ch === "}") out += bs + ch;
    else if (ch === NL) out += bs + "par" + NL;
    else if (ch === TAB) out += bs + "tab ";
    else if (c < 128) out += ch;
    else for (let k = 0; k < ch.length; k++) out += u(ch.charCodeAt(k));
  }
  return out + "}";
}
