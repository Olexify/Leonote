// A side pane that goes away (a tab with its own pane, a pane closed): what was
// typed in it is saved first, while its editor still holds it, and its editor goes.
import { test } from "node:test";
import assert from "node:assert/strict";

class El {
  style = {}; dataset = {}; hidden = false;
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  append() {} remove() {} replaceChildren() {} insertBefore() {} setAttribute() {}
  on = {};
  addEventListener(k, f) { (this.on[k] ||= []).push(f); }
  querySelector() { return null; }
  closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { width: 100, height: 100, left: 0, right: 100, top: 0 }; }
}
const made = [];
globalThis.document = { createElement: () => { const e = new El(); made.push(e); return e; }, getElementById: () => null };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: true }) };
globalThis.requestAnimationFrame = () => 0;

const { mountSplit } = await import("../split.js");

test("a pane loaded away saves its notes before its editor is destroyed", () => {
  const log = [];
  const split = mountSplit({ host: {}, settings: {}, positions: {}, vault: { get: () => ({ content: "" }) } }, new El(), {
    makeEditor: () => ({ open() {}, destroy: () => log.push("destroy") }),
    tabInfo: () => ({ icon: "x", title: "" }),
    exists: () => true,
    onSave: (p) => log.push("save " + p),
  });
  split.open({ kind: "note", path: "a.md" }, { focus: false });
  split.load(null);
  assert.deepEqual(log, ["save a.md", "destroy"]);
  assert.equal(split.panes.length, 0);
});

test("a note sent to the main pane is saved before its emptied pane takes the editor away", () => {
  const log = [];
  const split = mountSplit({ host: {}, settings: {}, positions: {}, vault: { get: () => ({ content: "" }) } }, new El(), {
    makeEditor: () => ({ open() {}, destroy: () => log.push("destroy") }),
    tabInfo: () => ({ icon: "x", title: "" }),
    exists: () => true,
    onSave: (p) => log.push("save " + p),
    onToMain: (t) => log.push("main " + t.path),
  });
  made.length = 0;
  split.open({ kind: "note", path: "a.md" }, { focus: false });
  const strip = made.find((e) => e.on.click && e.on.dblclick);
  strip.on.click[0]({ target: { closest: (s) => (s === "[data-main]" ? { dataset: { main: "0" } } : null) } });
  assert.deepEqual(log, ["save a.md", "destroy", "main a.md"]);
});
