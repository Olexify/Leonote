// The script window's edits go back to the note's own lines: the rest of the note stays as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
await import("../scriptmap.js");
const { blocks, apply } = globalThis.ScriptMap;

const NOTE = ["---", "ai: open", "---", "# Intro", "Hey **everyone**, look at [[Leonote|my app]].", "Same paragraph here.", "", "![[pic.png]]", "", "- first", "- [ ] second", "", "```js", "code();", "```", "", "> A quote."].join("\n");
const items = (bs, f = (b) => b.text) => bs.map((b, i) => ({ b: i, text: f(b, i), tag: b.tag }));

test("blocks: what is read, and the lines each came from", () => {
  const bs = blocks(NOTE);
  assert.deepEqual(bs.map((b) => [b.tag, b.text, b.start, b.end]), [
    ["h1", "Intro", 3, 3], ["p", "Hey everyone, look at my app. Same paragraph here.", 4, 5],
    ["li", "first", 9, 9], ["li", "second", 10, 10], ["p", "A quote.", 16, 16]]);
});

test("nothing changed: the note comes back exactly, markup and all", () => {
  const bs = blocks(NOTE);
  assert.equal(apply(NOTE, bs, items(bs)), NOTE);
  assert.equal(apply(NOTE.replace(/\n/g, "\r\n"), bs, items(bs)), NOTE.replace(/\n/g, "\r\n"));
});

test("one block edited: only its lines change, its prefix kept", () => {
  const bs = blocks(NOTE);
  const out = apply(NOTE, bs, items(bs, (b, i) => (i === 3 ? "second, changed" : i === 0 ? "Intro now" : b.text)));
  assert.ok(out.includes("# Intro now\n"));
  assert.ok(out.includes("- [ ] second, changed\n"));
  assert.ok(out.includes("Hey **everyone**, look at [[Leonote|my app]].\nSame paragraph here."), "untouched paragraph keeps its markup");
  assert.ok(out.startsWith("---\nai: open\n---\n") && out.includes("![[pic.png]]") && out.includes("```js\ncode();\n```") && out.includes("> A quote."));
});

test("a block deleted or emptied goes; added ones land after the block before them", () => {
  const bs = blocks(NOTE);
  const its = items(bs);
  its.splice(2, 1); // "first" gone
  its.splice(2, 0, { b: 3, text: "second", tag: "li" }, { b: null, text: "third", tag: "li" }); // a new list item after "second"
  its.push({ b: null, text: "Closing line.", tag: "p" });
  const out = apply(NOTE, bs, its);
  assert.ok(!out.includes("- first"));
  assert.ok(out.includes("- [ ] second\n- third"), out);
  assert.ok(out.endsWith("> A quote.\n\nClosing line."), out);
  // an emptied paragraph goes too
  const out2 = apply(NOTE, bs, items(bs, (b, i) => (i === 1 ? "   " : b.text)));
  assert.ok(!out2.includes("everyone"));
});

test("Enter in a paragraph: the second half (same block, again) is a new paragraph after it", () => {
  const bs = blocks(NOTE);
  const its = items(bs);
  its.splice(1, 1, { b: 1, text: "Hey everyone, look at my app.", tag: "p" }, { b: 1, text: "Same paragraph here.", tag: "p" });
  const out = apply(NOTE, bs, its);
  assert.ok(out.includes("# Intro\nHey everyone, look at my app.\n\nSame paragraph here.\n"), out);
});

/** script.js in a bare stand-in for its window: open with `first`, then `note()` is what the main window sends. */
async function scriptWindow(first) {
  const el = (tag = "div") => {
    const e = { tagName: tag.toUpperCase(), dataset: {}, children: [], style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, focus() {}, remove() {}, scrollTo() {},
      getBoundingClientRect: () => ({ top: 0, height: 0 }), append: (...k) => e.children.push(...k.filter((x) => typeof x === "object")), replaceChildren: (...k) => { e.children = k; },
      get isContentEditable() { return e.contentEditable === "true"; } };
    return e;
  };
  const byId = {}, sent = [], on = {};
  let onNote;
  const T = { core: { invoke: async () => first }, event: { emit: (_, p) => sent.push(p), listen: (_, f) => { onNote = f; } } };
  const body = el();
  const ctx = vm.createContext({ window: { __TAURI__: T }, addEventListener: (k, f) => { on[k] = f; }, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: (id) => (byId[id] ||= el()), createElement: el, body, documentElement: el(), querySelector: () => null } });
  for (const f of ["../scriptmap.js", "../script.js"]) vm.runInContext(readFileSync(new URL(f, import.meta.url), "utf8"), ctx);
  await 0; await 0;
  return { page: byId.page, edit: () => byId.editBtn.onclick(), note: (n) => onNote({ payload: n }), sent, blur: () => on.blur(), said: () => body.children.map((c) => c.textContent) };
}

test("Edit on and the note changes under it: typing never lands on the wrong lines", async () => {
  const A = { path: "a.md", title: "A", text: "one\n\ntwo" };
  // another note opened: A's words stay out of B
  let w = await scriptWindow(A);
  w.edit();
  w.note({ path: "b.md", title: "B", text: "b1\n\nb2" });
  w.edit(); w.edit();
  assert.deepEqual(w.sent, []);
  assert.equal(w.page.children[0].textContent, "b1");
  // a paragraph added above: the words typed are not sent over the neighbour
  w = await scriptWindow(A);
  w.edit();
  w.page.children[0].textContent = "one!";
  w.note({ ...A, text: "new\n\none\n\ntwo" });
  w.edit(); w.edit();
  assert.deepEqual(w.sent, []);
  assert.equal(w.page.children[0].textContent, "new");
  // only an id added to the front matter: typing goes on, on the right lines
  w = await scriptWindow(A);
  w.edit();
  w.page.children[0].textContent = "one!";
  w.note({ ...A, text: "---\nid: x\n---\none\n\ntwo" });
  w.edit();
  assert.deepEqual(w.sent.map((s) => s.text), ["---\nid: x\n---\none!\n\ntwo"]);
});

test("A save the main window refused, the note having moved: the window says so", async () => {
  const A = { path: "a.md", title: "A", text: "one\n\ntwo" };
  const w = await scriptWindow(A);
  w.edit();
  w.page.children[0].textContent = "one!";
  w.blur();
  assert.deepEqual({ ...w.sent[0] }, { path: "a.md", text: "one!\n\ntwo", base: "one\n\ntwo" });
  w.note({ ...A, text: "one!\n\ntwo" }); // its own save coming back: nothing to say
  assert.deepEqual([...w.said()], []);
  w.page.children[0].textContent = "one!!";
  w.blur();
  assert.equal(w.sent[1].base, "one!\n\ntwo");
  w.note({ ...A, text: "one!\n\ntwo\n\noutside" }); // the note as it is: the words sent are not in it
  assert.equal(w.said().length, 1);
});

test("main window: a script edit typed over a text the note has moved on from is not written", () => {
  const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
  const from = main.indexOf('host.on("script:edit"');
  const code = main.slice(from, main.indexOf("\n  });", from) + 6);
  const written = [], told = [], toasts = [];
  let on;
  const n = { title: "A", content: "one\n\nnew from sync" };
  const app = { vault: { get: () => n, write: async (path, text) => { written.push(text); n.content = text; } } };
  const host = { on: (_, f) => { on = f; }, scriptOpen: async (...a) => { told.push(a); } };
  new Function("host", "app", "scriptNote", "toast", "basename", code)(host, app, "a.md", (m) => toasts.push(m), (x) => x);
  on({ path: "a.md", text: "one!", base: "one" }); // the window has not heard yet
  assert.deepEqual(written, []);
  assert.deepEqual(told, [["a.md", "A", "one\n\nnew from sync", true]]);
  assert.equal(toasts.length, 1); // the window may be hidden by now (closing it sends the last words): the main window says so
  // saves one after another: each is typed over the one before, and lands
  on({ path: "a.md", text: "two", base: n.content });
  on({ path: "a.md", text: "three", base: "two" });
  assert.deepEqual(written, ["two", "three"]);
});
