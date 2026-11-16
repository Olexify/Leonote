// The donation picker: Ko-fi cannot pay out, so no active link to it may remain anywhere a user sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { DONATE_METHODS, LINKS } from "../support.js";

const repo = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), "utf8");
const files = (d) => readdirSync(new URL(d, repo)).map((f) => d + f).filter((f) => statSync(new URL(f, repo)).isFile());

test("no active Ko-fi link remains", () => {
  assert.ok(!LINKS.some((l) => /ko-?fi/i.test(l.name + l.url)));
  const kofi = DONATE_METHODS.filter((m) => m.name === "Ko-fi");
  assert.equal(kofi.length, 1);
  assert.ok(kofi[0].off && !kofi[0].url);
  for (const f of [...files("web/"), "README.md", ...files("docs/store/"), ...files("docs/site/")])
    assert.ok(!/ko-fi\.com/i.test(read(f)), f);
  assert.ok(!/Ko-fi/.test(read("docs/store/privacy-policy.md")));
});

test("every way can be used: a link, or an address with its QR, which the build copies", () => {
  for (const m of DONATE_METHODS.filter((x) => !x.off)) {
    assert.ok(m.url || (m.addr && m.net), m.name);
    if (m.addr) assert.ok(existsSync(new URL(`web/pay/qr-${m.qr}.svg`, repo)), m.name);
  }
  assert.match(read("web/build.mjs"), /"pay"/);
});

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

test("the donate button on a crypto way shows the address it copies, also after the box was folded", async () => {
  let copied = null;
  globalThis.localStorage = { getItem: () => null };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.document = { createElement: (t) => new El(t), addEventListener() {}, removeEventListener() {}, documentElement: new El("html") };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (t) => { copied = t; } } } });
  const { donateRow } = await import("../support.js");
  const els = donateRow({ openUrl() {} }).all();
  const box = els.find((e) => e.className === "don-box");
  const btc = DONATE_METHODS.find((m) => m.name === "BTC");
  els.find((e) => e.className === "don-pick" && e.all().some((k) => k.text === "BTC")).on.click();
  assert.equal(box.hidden, false);
  els.find((e) => /don-more/.test(e.className)).on.click(); // folded
  assert.equal(box.hidden, true);
  els.find((e) => /don-go/.test(e.className)).on.click();
  assert.equal(copied, btc.addr);
  assert.equal(box.hidden, false);
});

test("the Store package offers one button to the website, and nothing else to donate through", async () => {
  globalThis.localStorage = { getItem: () => null };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.window = {};
  globalThis.fetch = () => { throw new Error("the Store package asks for no donation goal"); };
  globalThis.document = { createElement: (t) => new El(t), addEventListener() {}, removeEventListener() {}, documentElement: new El("html") };
  const { donateRow, supportCommands, aboutSection, maybeAskSupport } = await import("../support.js");
  const opened = [];
  const app = { packaged: true, openUrl: (u) => opened.push(u), bootMs: 1, settings: {}, vault: { notes: new Map() }, tasks: { all: [] } };
  const row = donateRow(app).all();
  const buttons = row.filter((e) => e.tag === "button");
  assert.equal(buttons.length, 1);
  assert.ok(buttons[0].kids.includes("Support Leonote"));
  assert.ok(!row.some((e) => e.tag === "img" || e.tag === "code"));
  buttons[0].on.click();
  assert.deepEqual(opened, ["https://olexify.dev"]);
  assert.ok(!supportCommands(app).some((c) => /patreon/i.test(c.id + c.name)));
  assert.ok(!aboutSection(app).all().some((e) => /patreon/i.test(e.text + e.title) || /^don-(wrap|go|more|list|box)/.test(e.className)));
  // the now-and-then question says the same, with no goal bar
  const overlay = new El("div");
  globalThis.document.querySelector = () => null;
  globalThis.document.getElementById = () => overlay;
  maybeAskSupport({ ...app, setSetting() {}, settings: { donate: { first: 1, next: 0 } } });
  const asked = overlay.all();
  assert.ok(asked.some((e) => e.tag === "button" && e.kids.includes("Support Leonote")));
  assert.ok(!asked.some((e) => /^don-(wrap|goal|bar|pick$|go|more|list|box)/.test(e.className)));
  // the download builds keep the whole picker
  assert.ok(supportCommands({}).some((c) => c.id === "open-patreon"));
  assert.ok(donateRow({ openUrl() {} }).all().some((e) => e.className === "don-pick"));
});
