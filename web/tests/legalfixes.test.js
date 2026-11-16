// Legal fixes: the donation goal is asked for only when About is opened, About offers a way to report AI content,
// the crypto box carries the sanctions line, the side pane searches with the chosen engine, and a crate without
// a licence file still gets a standard text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { standardTexts } from "../notices.mjs";

class El {
  constructor(t) { this.tag = t; this.nodeType = 1; this.kids = []; this.on = {}; this.hidden = false; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {}, contains: () => false }; }
  get children() { return this.kids; }
  addEventListener(t, fn) { this.on[t] = fn; }
  setAttribute(k, v) { this[k] = v; }
  append(...k) { this.kids.push(...k); }
  set textContent(v) { if (v === "") this.kids = []; this.text = v; }
  get textContent() { return this.text; }
  all() { return this.kids.flatMap((k) => (k instanceof El ? [k, ...k.all()] : [])); }
  querySelector(t) { return this.all().find((k) => k.tag === t); }
}

test("About asks for the donation goal only once opened, links a report for AI content, and crypto names sanctions", async () => {
  let asked = 0;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.window = {};
  globalThis.fetch = () => { asked++; return Promise.reject(new Error("offline")); };
  globalThis.document = { createElement: (t) => new El(t), addEventListener() {}, removeEventListener() {}, documentElement: new El("html") };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  const { aboutSection, donateRow } = await import("../support.js");
  const about = aboutSection({ packaged: false, openUrl() {}, bootMs: 1, settings: {}, vault: { notes: new Map() }, tasks: { all: [] } });
  assert.equal(asked, 0, "building Settings sends nothing");
  about.opened();
  about.opened();
  assert.equal(asked, 1, "opening About asks once");
  assert.ok(about.all().some((e) => e.tag === "a" && /^mailto:olexifyyy@gmail\.com/.test(e.href) && e.kids.includes("Report a problem with AI content")));
  const els = donateRow({ openUrl() {} }).all();
  els.find((e) => e.className === "don-pick" && e.all().some((k) => k.text === "BTC")).on.click();
  assert.ok(els.find((e) => e.className === "don-box").all().some((e) => /subject to sanctions/.test(e.text)));
});

test("the side pane's browser has no search engine of its own", () => {
  assert.ok(!/duckduckgo/i.test(readFileSync(new URL("../split.js", import.meta.url), "utf8")));
});

test("a standard licence text: what most crates of that licence ship, without their copyright lines", () => {
  const mit = (who) => `MIT License\n\nCopyright (c) 2020 ${who}\n\nPermission is hereby granted.`;
  const crates = [
    { license: "MIT", t: [mit("A")] }, { license: "MIT", t: [mit("B")] }, { license: "MIT", t: ["odd text"] },
    { license: "MIT OR Apache-2.0", t: ["dual, not counted"] }, { license: "Apache-2.0", t: ["Apache License\nVersion 2.0"] },
  ];
  const std = standardTexts(crates, (p) => p.t);
  assert.equal(std.get("MIT"), "MIT License\n\nPermission is hereby granted.");
  assert.equal(std.get("Apache-2.0"), "Apache License\nVersion 2.0");
  assert.equal(std.size, 2);
});
