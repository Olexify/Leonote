// The older binary Word format (.doc): the main text, nothing else.
//
// Word 97-2003 keeps the text in the WordDocument stream, in pieces that the
// piece table (in the Table stream, pointed to by the FIB) lays end to end;
// each piece is either 8-bit (CP1252, marked by a flag in its offset) or
// UTF-16LE. Fields, footnotes and headers live past the main text and are
// left out; formatting is not read at all.

import { isCfb, readCfb } from "./ppt.js";
export { isCfb };

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The main document text of a .doc, paragraphs on their own lines. */
export function docText(bytes) {
  const streams = readCfb(bytes);
  const wd = streams.get("WordDocument");
  if (!wd || u16(wd, 0) !== 0xa5ec) throw new Error("not a Word document");
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) throw new Error("the document is encrypted");
  const table = streams.get(flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new Error("the document's table is missing");
  const ccpText = u32(wd, 0x4c);
  const fcClx = u32(wd, 0x01a2);
  const lcbClx = u32(wd, 0x01a6);
  if (!lcbClx || fcClx + lcbClx > table.length) throw new Error("the document's text map is missing");
  // Clx: any number of Prc (0x01, size, bytes) then the Pcdt (0x02, size, PlcPcd)
  let o = fcClx;
  const end = fcClx + lcbClx;
  while (o < end && table[o] === 0x01) o += 3 + u16(table, o + 1);
  if (table[o] !== 0x02) throw new Error("the document's text map is odd");
  const lcb = u32(table, o + 1);
  o += 5;
  const n = Math.floor((lcb - 4) / 12);
  const cps = [];
  for (let i = 0; i <= n; i++) cps.push(u32(table, o + i * 4));
  const pcd = o + (n + 1) * 4;
  const dec = new TextDecoder("windows-1252");
  let out = "";
  let taken = 0;
  for (let i = 0; i < n && taken < ccpText; i++) {
    const len = Math.min(cps[i + 1] - cps[i], ccpText - taken);
    let fc = u32(table, pcd + i * 8 + 2);
    const compressed = (fc & 0x40000000) !== 0;
    fc = compressed ? (fc & 0x3fffffff) >>> 1 : fc;
    if (compressed) out += dec.decode(wd.subarray(fc, fc + len));
    else { let s = ""; for (let k = 0; k < len; k++) s += String.fromCharCode(u16(wd, fc + k * 2)); out += s; }
    taken += len;
  }
  // \r ends a paragraph, \x07 a table cell, \x0b a line break; field codes and other control bytes go
  return out.replace(/\r/g, "\n").replace(/\x07/g, "\t").replace(/\x0b/g, "\n").replace(/[\x00-\x08\x0c-\x1f\x13\x14\x15]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
