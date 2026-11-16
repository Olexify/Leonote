// A file view that goes away for good (a side pane closing) stops listening to
// the app - but not while a save it owes is still waiting for a held file.
import { test } from "node:test";
import assert from "node:assert/strict";

class El {
  style = {}; dataset = {}; hidden = false; children = [];
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  append(...c) { this.children.push(...c); } remove() {} prepend() {}
  replaceChildren(...c) { this.children = c; }
  setAttribute() {} removeAttribute() {} focus() {} querySelector() { return null; } querySelectorAll() { return []; }
  closest() { return null; } contains() { return false; }
  on = {};
  addEventListener(k, f) { (this.on[k] ||= []).push(f); }
  get firstChild() { return this.children[0] || null; }
}
const made = [];
// add/remove by signal, the way a browser does
const target = () => {
  const on = new Map();
  return { on, addEventListener(k, f, o) { on.set(f, k); o?.signal?.addEventListener("abort", () => on.delete(f)); }, removeEventListener() {} };
};
const doc = target(), win = target();
globalThis.document = { ...doc, createElement: () => { const e = new El(); made.push(e); return e; }, createElementNS: () => new El(), createTextNode: () => new El(), getElementById: () => null, documentElement: new El(), body: new El(), head: new El() };
globalThis.window = { ...win, matchMedia: () => ({ matches: true }) };
globalThis.requestAnimationFrame = () => 0;
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(Buffer.from(String.raw`{\rtf1 hello}`)).buffer });

const { emitter } = await import("../util.js");
const { mountFileView } = await import("../fileview.js");

const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn()); };

test("a view with a held save keeps listening until the save lands, then lets go", async () => {
  const bus = emitter();
  let held = true, written = 0, parks = 0;
  const app = {
    bus, settings: {}, toast() {}, media: { park() { parks++; } },
    vault: { files: new Map([["a.rtf", { path: "a.rtf", kind: "other", size: 1, mtime: 1 }]]), usedIn: () => [] },
    host: { assetUrl: (p) => p, writeFile: async (p) => { if (held) throw new Error("os error 32"); written++; return { path: p, mtime: 2, size: 1 }; } },
  };
  const before = [doc.on.size, win.on.size];
  const fv = mountFileView(app, new El());
  assert.ok(doc.on.size > before[0] && win.on.size > before[1]);
  fv.show("a.rtf");
  let area;
  await until(() => (area = made.find((e) => e.on.input)));
  await new Promise((r) => setTimeout(r, 20)); // its editor is set just after the box goes up
  area.value = "typed";
  area.on.input[0]();
  const focus = [...win.on.keys()].at(-1);

  const parked = parks;
  fv.destroy();
  await until(() => fv.dirty); // the write failed: the file is held
  assert.equal(win.on.has(focus), true, "still listening: the edit is not on disk yet");
  held = false;
  focus(); // Leonote back in front: tried again
  await until(() => written === 1);
  await until(() => !win.on.has(focus));
  assert.equal(doc.on.size, before[0]);
  assert.equal(parks, parked, "leaving parks nothing: the host may show a newer view's player by now, and a closed view's player stops");
});
