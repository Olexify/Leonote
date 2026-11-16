// The keys a web page hands back to Leonote (webwin.rs app_key) are the ones Leonote answers (main.js KEYMAP):
// a key added to one and not the other is lost inside pages, or taken from them for nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const rust = readFileSync(new URL("../../src-tauri/src/webwin.rs", import.meta.url), "utf8");
const keymap = /const KEYMAP = \{([\s\S]*?)\n  \};/.exec(main)[1];
const combos = [...keymap.matchAll(/"([A-Za-z+0-9]+)":/g)].map((m) => m[1]);
const list = /const KEYS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)[1];
const forwarded = new Set([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
// what the page can send at all: Ctrl or Alt held, a letter, digit, Tab, PageUp/Down, comma, period, backquote, backslash
const sendable = (c) => /^(Ctrl\+|Alt\+)/.test(c) && /(Key[A-Z]|Digit\d|Tab|PageUp|PageDown|Comma|Period|Backquote|Backslash)$/.test(c);

test("every key Leonote answers with Ctrl or Alt comes back out of a web page", () => {
  for (const c of combos.filter(sendable)) {
    if (/^(Ctrl|Alt)\+Digit\d$/.test(c)) continue; // all digits pass (tabs, views)
    // left to the page on purpose: Ctrl+P prints it, Ctrl+L and Ctrl+D are its own; Ctrl+Alt+T (a template) and
    // Ctrl+Shift+M (move a note) do nothing outside a note anyway
    if (["Ctrl+KeyL", "Ctrl+KeyD", "Ctrl+KeyP", "Ctrl+Alt+KeyT", "Ctrl+Shift+KeyM"].includes(c)) continue;
    assert.ok(forwarded.has(c), `${c} is in KEYMAP but a web page keeps it (webwin.rs app_key)`);
  }
});
test("a web page hands back no key Leonote does not answer", () => {
  for (const c of forwarded) assert.ok(combos.includes(c), `${c} is taken from web pages, but KEYMAP has no command for it`);
});
