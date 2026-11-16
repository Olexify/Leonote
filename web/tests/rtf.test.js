// RTF preview: plain text out of Word's rich text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rtfToText, isRtf } from "../rtf.js";

test("rtf: paragraphs, escapes, code page and unicode", () => {
  const src = "{\\rtf1\\ansi\\ansicpg1251\\deff0{\\fonttbl{\\f0\\fnil Calibri;}}{\\*\\generator Riched20;}\\viewkind4\\uc1 \\pard\\b Title\\b0\\par Hello \\'cf\\'f0\\'e8\\'e2\\'b3\\'f2 and \\u8212? done\\par\\tab Tabbed\\par}";
  assert.equal(rtfToText(src), "Title\nHello Привіт and — done\n\tTabbed");
  assert.equal(isRtf(new TextEncoder().encode("{\\rtf1 x}")), true);
  assert.equal(isRtf(new Uint8Array([0x50, 0x4b, 3, 4, 0])), false);
});
