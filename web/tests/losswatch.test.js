// Nothing in Leonote may lose text without saying so. These are the three
// places that decide that: which pane's copy of a note gets written, whether a
// write is throwing most of a note away, and whether a task op is emptying a
// task or dropping its steps.

import test from "node:test";
import assert from "node:assert/strict";

import { pickWriter } from "../savepick.js";
import { shrank, SHRINK_MIN, createVault } from "../vault.js";
import { createTaskStore, losses, lossText } from "../taskstore.js";

/* ── which pane wins ──────────────────────────────────────────────────── */

const pane = (path, { focus = false } = {}) => ({ path, hasFocus: () => focus });

test("the pane that last typed into a note wins over the focused one", () => {
  const main = pane("Note.md", { focus: true });
  const split = pane("Note.md");
  // typed in the split, then clicked into the main pane: the split's text is
  // the newer one and the click must not resurrect the main pane's copy
  assert.equal(pickWriter([main, split], "Note.md", split), split);
});

test("with nobody typing, the focused pane showing that note wins", () => {
  const main = pane("Other.md", { focus: true });
  const split = pane("Note.md", { focus: true });
  assert.equal(pickWriter([main, split], "Note.md", undefined), split);
});

test("a pane that no longer holds the note cannot write it", () => {
  const split = pane("Note.md");
  const stale = pane("Note.md"); // closed since: not in the list any more
  assert.equal(pickWriter([split], "Note.md", stale), split);
});

test("no pane holds it at all: nothing to write", () => {
  assert.equal(pickWriter([], "Note.md", undefined), undefined);
});

/* ── a note that shrank ───────────────────────────────────────────────── */

const long = "x".repeat(400);

test("an empty save over a real note counts as a shrink", () => {
  assert.equal(shrank(long, ""), true);
  assert.equal(shrank(long, "   \n "), true);
});

test("keeping under a third counts, keeping most of it does not", () => {
  assert.equal(shrank(long, "x".repeat(100)), true);
  assert.equal(shrank(long, "x".repeat(399)), false);
  assert.equal(shrank(long, long + "more"), false);
});

test("a short note is left alone - there is nothing to lose and the ratio is noise", () => {
  const tiny = "x".repeat(SHRINK_MIN - 1);
  assert.equal(shrank(tiny, ""), false);
});

/* ── a task that lost something ───────────────────────────────────────── */

const task = (over = {}) => ({ id: "t1", text: "Ring the bank", subtasks: [{ id: "a", text: "find the number", done: false }, { id: "b", text: "ring it", done: false }], ...over });

test("blanking a task's text is a loss, editing it is not", () => {
  assert.deepEqual(losses(task(), { text: "" }).text, "Ring the bank");
  assert.equal(losses(task(), { text: "Ring the bank tomorrow" }), null);
});

test("dropping a step is a loss, even when another arrives in the same write", () => {
  const before = task();
  // one step gone, one added: the count is the same but "a" is not coming back
  const next = [{ id: "b", text: "ring it", done: false }, { id: "c", text: "new", done: false }];
  const lost = losses(before, { subtasks: next });
  assert.equal(lost.subtasks.length, 2);
  assert.equal(lost.subtasks[0].id, "a");
});

test("adding a step, reordering and ticking one off lose nothing", () => {
  const before = task();
  const steps = before.subtasks;
  assert.equal(losses(before, { subtasks: [...steps, { id: "c", text: "new", done: false }] }), null);
  assert.equal(losses(before, { subtasks: [steps[1], steps[0]] }), null);
  assert.equal(losses(before, { subtasks: [{ ...steps[0], done: true }, steps[1]] }), null);
});

test("a task with no steps yet cannot lose any", () => {
  assert.equal(losses(task({ subtasks: [] }), { subtasks: [] }), null);
});

test("the words shown name the task", () => {
  assert.match(lossText(task(), losses(task(), { text: "" })), /Ring the bank/);
});

/* ── the store hands back a way to undo ───────────────────────────────── */

function store(tasks) {
  const seen = [];
  const risky = [];
  const host = { taskOps: async (ops) => { seen.push(...ops); return { patch: {} }; } };
  const s = createTaskStore(host, { risky: (r) => risky.push(r) });
  s.load(tasks);
  return { s, seen, risky };
}

const seed = () => [{ id: "t1", text: "Ring the bank", ord: 0, subtasks: [{ id: "a", text: "find the number", done: false }] }];

test("emptying a task's text offers the old text back", async () => {
  const { s, risky } = store(seed());
  s.update("t1", { text: "" });
  assert.equal(risky.length, 1);
  assert.match(risky[0].text, /Ring the bank/);
  assert.equal(s.get("t1").text, ""); // the write still went through
  await risky[0].restore();
  assert.equal(s.get("t1").text, "Ring the bank");
});

test("wiping a task's steps offers them back", async () => {
  const { s, risky } = store(seed());
  s.setSubtasks("t1", []);
  assert.equal(risky.length, 1);
  assert.equal(s.get("t1").subtasks.length, 0);
  await risky[0].restore();
  assert.deepEqual(s.get("t1").subtasks, [{ id: "a", text: "find the number", done: false }]);
});

test("removing a step on purpose says nothing", () => {
  const { s, risky } = store(seed());
  s.setSubtasks("t1", [], { expected: true });
  assert.equal(risky.length, 0);
});

test("an agent emptying a task the user is looking at still offers it back", async () => {
  const { s, risky } = store(seed());
  s.applyPatch({ t1: { text: "" } }, ["hermes"]);
  assert.equal(risky.length, 1);
  await risky[0].restore();
  assert.equal(s.get("t1").text, "Ring the bank");
});

test("our own writes are not second-guessed - only external ones are", () => {
  const { s, risky } = store(seed());
  s.applyPatch({ t1: { text: "" } }); // no writers: the fold echoing us back
  assert.equal(risky.length, 0);
});

test("the undo puts back the fields and nothing else", async () => {
  const { s, risky, seen } = store(seed());
  s.setSubtasks("t1", []);
  await risky[0].restore();
  const op = seen[seen.length - 1];
  assert.deepEqual(Object.keys(op).sort(), ["id", "subtasks"]);
});

test("losing one of three steps says so", () => {
  const before = { id: "t1", text: "x", subtasks: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  assert.match(lossText(before, losses(before, { subtasks: [{ id: "a" }] })), /lost 2 steps/);
  assert.match(lossText(before, losses(before, { subtasks: [{ id: "a" }, { id: "b" }] })), /lost a step/);
});

test("steps with no ids fall back to counting, so an append is still not a loss", () => {
  const before = { id: "t1", text: "x", subtasks: [{ text: "one" }, { text: "two" }] };
  assert.equal(losses(before, { subtasks: [{ text: "one" }, { text: "two" }, { text: "three" }] }), null);
  assert.ok(losses(before, { subtasks: [{ text: "one" }] }));
});

/* ── writes that fail, and text restored from outside ─────────────────── */

test("a failed write is written again when asked, though the text did not change", async () => {
  let fail = true;
  const disk = [];
  const v = createVault({ writeNote: async (p, c) => { if (fail) throw new Error("disk full"); disk.push(c); return 1; } });
  const errors = [];
  v.bus.on("error", (e) => errors.push(e));
  await v.write("n.md", "text");
  assert.equal(errors.length, 1);
  assert.equal(v.failed.has("n.md"), true);
  fail = false;
  await v.write("n.md", "text");
  assert.deepEqual(disk, ["text"]);
  assert.equal(v.failed.has("n.md"), false);
});

test("text saved a while ago and restored from outside is not taken for our echo", async (t) => {
  const v = createVault({ writeNote: async () => 1 });
  await v.write("n.md", "old");
  await v.write("n.md", "new");
  assert.equal(v.external([{ path: "n.md", content: "old", mtime: 2 }]).changed, 0, "just saved: an echo");
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 60000);
  assert.equal(v.external([{ path: "n.md", content: "old", mtime: 2 }]).changed, 1);
  assert.equal(v.get("n.md").content, "old");
});

test("a file list redraws only when a file came or went, also one first put in the map directly", () => {
  const v = createVault({});
  v.setFiles([{ path: "a.png", size: 1 }], true);
  let drawn = 0;
  v.bus.on("structure", () => drawn++);
  v.setFiles([{ path: "a.png", size: 2 }]);
  assert.equal(drawn, 0);
  v.files.set("new.png", { path: "new.png", size: 1 }); // as a save does, before the watcher's list
  v.setFiles([{ path: "a.png", size: 2 }, { path: "new.png", size: 1 }]);
  assert.equal(drawn, 1);
  v.setFiles([{ path: "a.png", size: 2 }]);
  assert.equal(drawn, 2);
});

test("a link with a folder finds the note by its name and no other", () => {
  const v = createVault({});
  v.load({ notes: [{ path: "x/Note.md", content: "" }, { path: "y/deep/Note.md", content: "" }] });
  assert.equal(v.resolve("deep/note"), "y/deep/Note.md");
  assert.equal(v.resolve("x/Note.md"), "x/Note.md");
  assert.equal(v.resolve("z/Note"), null);
});

test("a renamed folder takes its files along, even when the watcher's new list came first", async () => {
  const v = createVault({ renameFolder: async () => { v.setFiles([{ path: "New/b.pdf", size: 2 }, { path: "other.png", size: 3 }], true); } });
  v.setFiles([{ path: "Old/a.pdf", size: 1 }, { path: "Old/b.pdf", size: 2 }, { path: "other.png", size: 3 }], true);
  const moved = [];
  v.bus.on("fileRenamed", (e) => moved.push(e));
  await v.renameFolder("Old", "New");
  assert.deepEqual([...v.files.keys()].sort(), ["New/a.pdf", "New/b.pdf", "other.png"]);
  assert.deepEqual(moved, [{ from: "Old/a.pdf", to: "New/a.pdf" }, { from: "Old/b.pdf", to: "New/b.pdf" }]);
});

test("Delete for good erases the words, also of what it left readable before", async () => {
  const seen = [], erased = [];
  const s = createTaskStore({ taskOps: async (ops) => { seen.push(...ops); return { patch: {} }; }, tasksErase: async (ids) => erased.push(...ids) });
  s.load([{ id: "t1", text: "my key", deleted: true }, { id: "t2", text: "my pin", deleted: true, purged: true }]);
  s.purge(["t1"]);
  s.sweepTrash();
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(seen.map((o) => [o.id, o.purged, o.text]), [["t1", true, ""], ["t2", true, ""]]);
  assert.deepEqual(erased, ["t1", "t2"]);
});

/* ── a note not in UTF-8: what is in memory has lost its letters ───────── */

test("moving a note leaves a linking note that is not UTF-8 unwritten, and says so", async () => {
  const written = [];
  const v = createVault({ renameNote: async () => {}, writeNote: async (p) => { written.push(p); return 1; } });
  const left = [];
  v.bus.on("relinkLeftOut", (e) => left.push(e.path));
  v.load({ notes: [{ path: "Inbox/A.md", content: "a", mtime: 1 }, { path: "B.md", content: "\uFFFD\uFFFD [[Inbox/A]]", mtime: 1 }, { path: "C.md", content: "fine [[Inbox/A]]", mtime: 1 }] });
  const r = await v.rename("Inbox/A.md", "Archive/A.md");
  await new Promise((f) => setTimeout(f));
  assert.equal(r.relinked, 1);
  assert.deepEqual(written, ["C.md"]);
  assert.deepEqual(left, ["B.md"]);
  assert.equal(v.notes.get("B.md").content, "\uFFFD\uFFFD [[Inbox/A]]");
});

test("a folder moved outside the app walks the links once, not once per note, and its links still follow", async () => {
  const v = createVault({ writeNote: async () => 1 });
  await v.write("By.md", "[[Aaa]] [[Old/Bbb.md]]");
  await v.write("Other.md", "[[Elsewhere]]");
  await v.write("Old/Aaa.md", "one");
  await v.write("Old/Bbb.md", "two");
  let walks = 0;
  const other = v.notes.get("Other.md"), links = other.links;
  Object.defineProperty(other, "links", { get() { walks++; return links; } });
  v.external([{ path: "Old/Aaa.md", content: null }, { path: "Old/Bbb.md", content: null }, { path: "New/Ccc.md", content: "one", mtime: 2 }, { path: "New/Ddd.md", content: "two", mtime: 2 }]);
  const a = v.relinkMoved("Old/Aaa.md", "New/Ccc.md"), b = v.relinkMoved("Old/Bbb.md", "New/Ddd.md");
  assert.equal(walks, 1);
  assert.deepEqual([await a, await b], [1, 1]);
  assert.match(v.notes.get("By.md").content, /\[\[Ccc\]\] \[\[Ddd\]\]/);
});

/* ── a save made while the note is moving ─────────────────────────────── */

test("a save made during a rename, folder move or trashing lands where the note went, never at the old path", async () => {
  const wrote = [];
  let go;
  const host = { writeNote: async (p, c) => { wrote.push([p, c]); return 1; }, renameNote: () => new Promise((r) => (go = r)), renameFolder: () => new Promise((r) => (go = r)), trashNote: () => new Promise((r) => (go = r)) };
  const v = createVault(host);
  v.load({ notes: [{ path: "A/n.md", content: "one", mtime: 1 }] });
  const r = v.rename("A/n.md", "A/m.md");
  await new Promise((r) => setTimeout(r, 0));
  v.write("A/n.md", "one two");
  go(); await r; await v.idle();
  assert.deepEqual(wrote, [["A/m.md", "one two"]]);
  assert.equal(v.notes.get("A/m.md").content, "one two");

  const f = v.renameFolder("A", "B");
  await new Promise((r) => setTimeout(r, 0));
  v.write("A/m.md", "one two three");
  go(); await f; await v.idle();
  assert.deepEqual(wrote.at(-1), ["B/m.md", "one two three"]);

  const t = v.trash("B/m.md");
  await new Promise((r) => setTimeout(r, 0));
  v.write("B/m.md", "gone anyway");
  go(); await t; await v.idle();
  assert.equal(wrote.length, 2, "nothing written back into the trashed note's place");
});

test("sorting tasks once keeps the others in their places", async () => {
  const seen = [];
  const s = createTaskStore({ taskOps: async (ops) => { seen.push(...ops); return { patch: {} }; } });
  s.load([{ id: "a", text: "a", ord: 10 }, { id: "x", text: "other", ord: 20 }, { id: "b", text: "b", ord: 30 }, { id: "c", text: "c", ord: 40 }]);
  s.reorder(["c", "a", "b"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen.map((o) => [o.id, o.ord]), [["c", 10], ["a", 30], ["b", 40]]);
  assert.deepEqual(s.all.map((t) => t.id), ["c", "x", "a", "b"]);
});
