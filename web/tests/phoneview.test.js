// Another phone: the last one's object ids must not reach it, and a scan running then must not break the view.
import { test } from "node:test";
import assert from "node:assert/strict";

class El {
  constructor(tag) { this.nodeType = 1; this.tag = tag; this.kids = []; this.on = {}; this.style = { setProperty() {} }; this.dataset = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
  addEventListener(t, fn) { this.on[t] = fn; }
  setAttribute(k, v) { this[k] = v; }
  append(...k) { this.kids.push(...k); }
  appendChild(k) { this.kids.push(k); return k; }
  replaceChildren(...k) { this.kids = k; }
  before() {}
  remove() {}
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  all() { return this.kids.flatMap((k) => (k instanceof El ? [k, ...k.all()] : [])); }
}
globalThis.document = { createElement: (t) => new El(t), createTextNode: (t) => t, getElementById: () => new El("div"), addEventListener() {}, removeEventListener() {} };
globalThis.window = {};
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
const { mountPhone } = await import("../phoneview.js");

function mount(settings = { phoneMode: "largest" }, more = {}) {
  const heard = {}, calls = { stops: 0, scans: [] };
  const A = { id: "A", name: "Phone A" }, B = { id: "B", name: "Phone B" };
  const box = { devices: [A, B] };
  const host = {
    phoneDevices: async () => box.devices, phoneList: async () => {}, phoneScanStop: () => { calls.stops++; },
    phoneScan: async (dev, req) => { calls.scans.push(req); }, on: (ev, fn) => { heard[ev] = fn; return null; }, ...more,
  };
  const el = new El("div");
  mountPhone({ settings, host, setSetting() {}, toast() {} }, el).show();
  const button = (text) => el.all().find((k) => k.tag === "button" && k.kids.includes(text));
  return { heard, calls, box, button, B, el };
}
const tick = () => new Promise((r) => setTimeout(r));

test("a click on another phone during a scan stops it and leaves the view working", async () => {
  const { heard, calls, button } = mount();
  await tick();
  button("Scan the phone").on.click();
  button("Phone B").on.click();
  assert.equal(calls.stops, 1);
  heard["phone:scan"]({ req: calls.scans[0], items: [], folders: 1, done: true });
  assert.ok(button("Scan the phone"), "ready to scan the new phone");
});

test("picks do not survive a phone unplugged: Delete has nothing to send to the next one", async () => {
  const { heard, calls, box, button, B } = mount();
  await tick();
  button("Scan the phone").on.click();
  heard["phone:scan"]({ req: calls.scans[0], items: [{ id: "o1", name: "a.jpg", size: 9, mtime: 1 }], folders: 1, done: true });
  button("Pick all shown").on.click();
  assert.ok(!button("Delete").disabled);
  box.devices = [B];
  button("Refresh").on.click();
  await tick();
  assert.ok(button("Delete").disabled !== undefined);
  assert.ok(button("Scan the phone"), "the old list is gone");
});

test("a check made during a scan never reads Checked: files still to come have only a size in common", async () => {
  const fp = { phoneFingerprints: async (_, ids) => Object.fromEntries(ids.map((id) => [id, "same"])) };
  const { heard, calls, button } = mount({ phoneMode: "dupes" }, fp);
  await tick();
  button("Scan the phone").on.click();
  const file = (id) => ({ id, name: id + ".jpg", size: 60000, mtime: 1, path: "p" });
  heard["phone:scan"]({ req: calls.scans[0], items: [file("o1"), file("o2")], folders: 1 });
  button("Check they are really the same").on.click();
  await tick();
  assert.ok(!button("Checked ✓"));
  heard["phone:scan"]({ req: calls.scans[0], items: [file("o3"), file("o4")], folders: 2, done: true });
  assert.ok(!button("Checked ✓"));
  button("Check they are really the same").on.click();
  await tick();
  assert.ok(button("Checked ✓"), "once the scan is done");
});

const { nameFamily, familyHue, sizeClass, xferApply } = await import("../phoneview.js");

test("a camera's names share a family, a meme's free text has none", () => {
  assert.equal(nameFamily("VID20261031121530.mp4"), "vid#14");
  assert.equal(nameFamily("VID20261101090000.mp4"), nameFamily("vid20240101000001.MP4"));
  assert.equal(nameFamily("IMG_20240101_123456.jpg"), "img_#8_#6");
  assert.notEqual(nameFamily("IMG_20240101_123456.jpg"), nameFamily("VID_20240101_123456.mp4"));
  assert.equal(nameFamily("funny cat (2).mp4"), "");
  assert.equal(nameFamily("meme 2024.mp4"), "");
  assert.equal(familyHue("vid#14"), familyHue("vid#14"));
  assert.ok(familyHue("vid#14") >= 0 && familyHue("vid#14") < 360);
});

test("size classes: under 10 MB, up to 100 MB, over", () => {
  const MB = 1048576;
  assert.deepEqual([0, 9.9 * MB, 10 * MB, 100 * MB, 101 * MB].map(sizeClass), ["s", "s", "m", "m", "l"]);
});

test("transfer tags: copying → copied or failed; a move is Moved only once the phone deleted it", () => {
  const tags = new Map([["a", { state: "copying" }], ["b", { state: "copying" }], ["c", { state: "copying" }]]);
  xferApply(tags, { id: "a", to: "D:/x/a.mp4", done: 1 }, false);
  assert.deepEqual(tags.get("a"), { state: "copied", to: "D:/x/a.mp4" });
  xferApply(tags, { id: "b", why: "the phone stopped answering", failed: 1 }, false);
  assert.equal(tags.get("b").state, "failed");
  xferApply(tags, { finished: true, copied: ["a"], dir: "D:/x" }, false);
  assert.equal(tags.get("c").state, "failed", "never reported: not pretended done");
  assert.equal(tags.get("b").why, "the phone stopped answering");

  const mv = new Map([["a", { state: "moving" }], ["b", { state: "moving" }], ["c", { state: "moving" }]]);
  xferApply(mv, { id: "a", to: "D:/x/a.mp4" }, true);
  xferApply(mv, { id: "b", to: "D:/x/b.mp4" }, true);
  assert.equal(mv.get("a").state, "moving", "copied, not yet off the phone");
  xferApply(mv, { finished: true, gone: ["a"], copied: ["a", "b"], error: undefined, dir: "D:/x" }, true);
  assert.equal(mv.get("a").state, "moved");
  assert.equal(mv.get("b").state, "copied");
  assert.match(mv.get("b").why, /still on the phone/);
  assert.equal(mv.get("c").state, "failed");
});

test("a copy's tiles end tagged Copied, and a failed one says why", async () => {
  let job = 0;
  const { heard, calls, button, el } = mount({ phoneMode: "largest" }, { dialogOpen: async () => "D:/x", phoneCopy: async (d, items, dir, rm, j) => { job = j; } });
  await tick();
  button("Scan the phone").on.click();
  heard["phone:scan"]({ req: calls.scans[0], items: [{ id: "o1", name: "VID20261031121530.mp4", size: 9, mtime: 1 }, { id: "o2", name: "b.mp4", size: 8, mtime: 1 }], folders: 1, done: true });
  button("Pick all shown").on.click();
  button("Copy").on.click();
  await tick(); await tick();
  heard["phone:copy"]({ job, id: "o1", to: "D:/x/VID20261031121530.mp4", done: 1, total: 2, failed: 0 });
  heard["phone:copy"]({ job, id: "o2", why: "no room", done: 1, total: 2, failed: 1 });
  heard["phone:copy"]({ job, done: 1, total: 2, failed: 1, copied: ["o1"], finished: true, dir: "D:/x" });
  const tags = el.all().filter((k) => k.className && k.className.startsWith("ph-xfer")).map((k) => k.textContent).sort();
  assert.deepEqual(tags, ["Copied", "Failed · no room"]);
});
