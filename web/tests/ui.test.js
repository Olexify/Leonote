// The keys in the small dialogs: Enter must not say yes from the Cancel button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.kids = []; this.on = {}; this.classList = { add() {} }; this.style = {}; this.value = ""; }
  addEventListener(t, fn) { this.on[t] = fn; }
  setAttribute(k, v) { this[k] = v; }
  append(...k) { this.kids.push(...k); }
  remove() {}
  focus() { document.activeElement = this; }
  select() {}
  contains() { return true; }
  find(f) { for (const k of this.kids) { if (!(k instanceof El)) continue; if (f(k)) return k; const r = k.find(f); if (r) return r; } return null; }
}
const keys = [];
const root = new El("div");
globalThis.document = { activeElement: null, body: new El("body"), createElement: (t) => new El(t), createTextNode: (t) => t, getElementById: () => root, addEventListener: (_, fn) => keys.push(fn), removeEventListener: () => {}, querySelectorAll: () => backs };
let backs = [];
globalThis.MutationObserver = class { observe() {} };
globalThis.requestAnimationFrame = (fn) => fn();
const { confirmDialog, askDialog } = await import("../ui.js");
const press = (target) => { const e = { key: "Enter", target, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} }; keys.at(-1)(e); return e; };
const cancelOf = () => root.kids.at(-1).find((k) => k.tagName === "BUTTON");

test("confirmDialog: Enter says no from Cancel and yes from OK", async () => {
  const no = confirmDialog("Delete?", "");
  const cancel = cancelOf();
  cancel.focus();
  press(cancel);
  assert.equal(await no, false);
  const yes = confirmDialog("Delete?", "");
  press(document.activeElement);
  assert.equal(await yes, true);
});

test("askDialog: Enter on a button is left to that button, in a field it submits", async () => {
  const asked = askDialog("Name", [{ key: "a", label: "A", value: "x" }]);
  const e = press(cancelOf());
  assert.equal(e.prevented, false, "the button's own click must run");
  cancelOf().on.click();
  assert.equal(await asked, null);
  const sent = askDialog("Name", [{ key: "a", label: "A", value: "x" }]);
  press(document.activeElement);
  assert.deepEqual(await sent, { a: "x" });
});

test("any dialog's own Enter handler is kept from a focused button, so its click decides", () => {
  const guard = keys[1], box = new El("div"), btn = new El("button");
  backs = [{ querySelector: () => box }];
  btn.focus();
  let stopped = 0;
  const key = (extra) => guard({ key: "Enter", stopImmediatePropagation() { stopped++; }, ...extra });
  key();
  assert.equal(stopped, 1);
  key({ ctrlKey: true }); // Ctrl+Enter stays the dialog's own
  new El("div").focus();
  key(); // on the box or in a field, Enter is the dialog's too
  backs = [];
  assert.equal(stopped, 1);
});

test("a dialog about a loss that nothing brings back starts on Cancel", () => {
  // without safe it must say what saves the thing, or be on the short list of those that lose nothing or offer Undo after
  const saved = /trash|Recycle Bin|Ctrl\+Z|undo|\bstays?\b|\bkeeps?\b|kept|brings? |nothing else|nothing on|no file/i;
  const lost = /for good|taken back|be undone|no longer be brought|cannot|gone|are lost|erased/i;
  const known = /straight from its makers|Write into the file|Remove the original|Sign in to YouTube|Set up speech|Accept anyway|Its clock and its history/;
  const dir = new URL("../", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "ui.js")) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/confirmDialog\(/g)) {
      let i = m.index + m[0].length;
      for (let depth = 1; depth && i < src.length; i++) depth += (src[i] === "(") - (src[i] === ")");
      const call = src.slice(m.index, i);
      if (/\bsafe: |danger: false/.test(call) || known.test(call)) continue;
      assert.ok(saved.test(call) && !lost.test(call), `${f}: ${call}`);
    }
  }
});

test("deleting picked tasks for good asks first, on Cancel", () => {
  const src = readFileSync(new URL("../tasksview.js", import.meta.url), "utf8");
  assert.match(src, /confirmDialog\([^\n]*safe: true[^\n]*\n\s*store\.purge\(ids\)/);
});
