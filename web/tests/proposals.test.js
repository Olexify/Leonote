import test from "node:test";
import assert from "node:assert/strict";

test("an agent's change goes in on top of what was written since, not over it", async () => {
  const { mergeLines } = await import("../proposals.js");
  const base = "# Ideas\n1) one\n2) two";
  // the agent fixed line two; the user since wrote a third line and a fourth
  const theirs = "# Ideas\n1) one\n2) two, fixed";
  const mine = "# Ideas\n1) one\n2) two\n3) three\n4) four";
  assert.equal(mergeLines(base, mine, theirs), "# Ideas\n1) one\n2) two, fixed\n3) three\n4) four");
  // the agent appended; the user had appended too: both stay
  assert.equal(mergeLines("a", "a\nmine", "a\ntheirs"), "a\nmine\ntheirs");
  // a line the user took out stays out
  assert.equal(mergeLines("a\nb\nc", "a\nc", "a\nb\nc\nd"), "a\nc\nd");
});

test("accepting all leaves the second proposal on a note for review, and counts what failed", async () => {
  const { acceptUnchanged } = await import("../proposals.js");
  let props = [{ id: "1", path: "a.md", content: "one" }, { id: "2", path: "a.md", content: "two" }, { id: "3", path: "b.md", content: "x" }];
  const on = new Map();
  const list = () => props.map((p) => ({ ...p, changed: on.has(p.path) }));
  const told = [];
  let flushed = false;
  const app = { flushAll: async () => { flushed = true; }, host: {
    proposalsList: async () => { assert.ok(flushed, "typing is saved before the note is compared"); return list(); },
    proposalAccept: async (id) => { if (id === "3") throw new Error("locked"); const p = props.find((x) => x.id === id); on.set(p.path, p.content); props = props.filter((x) => x.id !== id); },
  } };
  assert.equal(await acceptUnchanged(app, (path, content) => told.push([path, content])), 1);
  assert.deepEqual(told, [["a.md", "one"]]);
  assert.equal(on.get("a.md"), "one", "the first agent's edit stays");
  assert.deepEqual(props.map((p) => p.id), ["2", "3"]);
});

test("a note is found under any spelling of its path, and left-out folders follow a rename", async () => {
  const { noteIn, movedFolders } = await import("../proposals.js");
  const keys = { path: "Notes/Keys.md", content: "---\nai: private\n---\n" };
  const notes = new Map([[keys.path, keys]]);
  assert.equal(noteIn(notes, "notes/keys.md"), keys);
  assert.equal(noteIn(notes, "Notes/Other.md"), undefined);
  assert.deepEqual(movedFolders(["Logs", "logs/Old/", "Logsy"], "Logs", "Archive/Logs"), ["Archive/Logs", "Archive/Logs/Old", "Logsy"]);
});

test("the app reads a note's ai: line exactly as the agents do - and an unknown word keeps it out", async () => {
  const { frontAccess } = await import("../proposals.js");
  const { readFileSync } = await import("node:fs");
  const cases = JSON.parse(readFileSync(new URL("./ai_access_cases.json", import.meta.url), "utf8"));
  for (const [text, want] of cases) assert.equal(frontAccess(text), want, JSON.stringify(text));
});

test("AI access that could not be read comes back by itself when the file reads again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  class El { constructor() { this.classList = { add() {}, remove() {} }; this.style = {}; } setAttribute() {} append() {} addEventListener() {} querySelector() { return new El(); } get lastChild() { return new El(); } }
  globalThis.document ??= { createElement: () => new El(), createElementNS: () => new El(), createTextNode: (x) => x, addEventListener() {} };
  const { mountProposals } = await import("../proposals.js");
  const answers = [{ default: "private", folders: {}, unreadable: true }, { default: "private", folders: {}, unreadable: true }, { default: "review", folders: {} }];
  const told = [];
  const on = () => {};
  const p = mountProposals({ settings: {}, bus: { emit: (n) => { if (n === "aiaccess") told.push(n); }, on }, vault: { bus: { on }, notes: new Map() }, host: { on, proposalsCount: async () => 0, aiAccessGet: async () => answers.shift() } });
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  await settle();
  assert.equal(p.accessOf("Diary"), "private");
  assert.equal(p.tasksSplit(), true);
  t.mock.timers.tick(5000); await settle();
  assert.equal(p.accessOf("Diary"), "private");
  assert.equal(told.length, 1, "still unreadable: nothing repainted");
  t.mock.timers.tick(5000); await settle();
  assert.equal(p.accessOf("Diary"), "review");
  assert.equal(p.tasksSplit(), false);
  assert.equal(told.length, 2);
  assert.equal(answers.length, 0);
  t.mock.timers.tick(60000); await settle();
  assert.equal(told.length, 2, "read again: no more looking");
});

test("a skill leaves an open note that is not UTF-8 alone, instead of writing its broken letters back", async () => {
  class El { constructor() { this.classList = { add() {}, remove() {} }; this.style = {}; } setAttribute() {} append() {} addEventListener() {} querySelector() { return new El(); } get lastChild() { return new El(); } }
  globalThis.document ??= { createElement: () => new El(), createElementNS: () => new El(), createTextNode: (x) => x, addEventListener() {} };
  const { mountProposals } = await import("../proposals.js");
  const on = () => {};
  const written = [];
  const notes = new Map([["Old.md", { path: "Old.md", content: "\uFFFD\uFFFD\uFFFD\n" }], ["Good.md", { path: "Good.md", content: "fine\n" }]]);
  const p = mountProposals({ settings: {}, bus: { emit() {}, on }, vault: { bus: { on }, notes, write: async (path) => { written.push(path); } }, host: { on, proposalsCount: async () => 0, aiAccessGet: async () => ({ default: "open", folders: {} }) } });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await assert.rejects(p.writeFor("Old.md", "\uFFFD\uFFFD\uFFFD\n\nmore\n", "append", "skill: x", "x"), /left alone/);
  assert.equal(await p.writeFor("Good.md", "fine\n\nmore\n", "append", "skill: x", "x"), "written");
  assert.equal(await p.writeFor("New.md", "new\n", "write", "skill: x", "x"), "written");
  assert.deepEqual(written, ["Good.md", "New.md"]);
});

test("a Windows short name does not get a write past a private folder or a note's own ai: private", async () => {
  class El { constructor() { this.classList = { add() {}, remove() {} }; this.style = {}; } setAttribute() {} append() {} addEventListener() {} querySelector() { return new El(); } get lastChild() { return new El(); } }
  globalThis.document ??= { createElement: () => new El(), createElementNS: () => new El(), createTextNode: (x) => x, addEventListener() {} };
  const { mountProposals } = await import("../proposals.js");
  const on = () => {};
  const notes = new Map([["Open/Keys.md", { path: "Open/Keys.md", content: "---\nai: private\n---\n" }], ["Open/a~1.md", { path: "Open/a~1.md", content: "real" }]]);
  const p = mountProposals({ settings: {}, bus: { emit() {}, on }, vault: { bus: { on }, notes, files: new Map([["Open/IMG~1.JPG", {}]]), folders: new Set(["Open", "Real~1"]) }, host: { on, proposalsCount: async () => 0, aiAccessGet: async () => ({ default: "open", folders: { Private: "private" } }) } });
  await p.ready;
  assert.equal(p.noteAccess("Private/x.md"), "private");
  assert.equal(p.noteAccess("PRIVAT~1/x.md"), "private");
  assert.equal(p.noteAccess("Open/KEYS~1.MD"), "private");
  // real names that merely look short are themselves, and ordinary new notes stay open
  assert.equal(p.noteAccess("Open/a~1.md"), "open");
  assert.equal(p.noteAccess("Open/IMG~1.JPG"), "open");
  assert.equal(p.noteAccess("Real~1/new.md"), "open");
  assert.equal(p.noteAccess("Open/new.md"), "open");
  assert.equal(p.noteAccess("Open/my notes~1 long name.md"), "open");
});

test("a skill or plugin cannot write a note's ai: line itself, on a note it may write at once", async () => {
  class El { constructor() { this.classList = { add() {}, remove() {} }; this.style = {}; } setAttribute() {} append() {} addEventListener() {} querySelector() { return new El(); } get lastChild() { return new El(); } }
  globalThis.document ??= { createElement: () => new El(), createElementNS: () => new El(), createTextNode: (x) => x, addEventListener() {} };
  const { mountProposals } = await import("../proposals.js");
  const on = () => {};
  const written = [];
  const notes = new Map([["Plain.md", { path: "Plain.md", content: "words\n" }], ["Own.md", { path: "Own.md", content: "---\nai: open\n---\nwords\n" }]]);
  const p = mountProposals({ settings: {}, bus: { emit() {}, on }, vault: { bus: { on }, notes, write: async (path) => { written.push(path); } }, host: { on, proposalsCount: async () => 0, aiAccessGet: async () => ({ default: "open", folders: {} }) } });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await assert.rejects(p.writeFor("Plain.md", "---\nai: open\n---\nwords\n", "write", "skill: x", "x"), /ai: line/);
  await assert.rejects(p.writeFor("Own.md", "no header now\n", "write", "skill: x", "x"), /ai: line/);
  assert.equal(await p.writeFor("Own.md", "---\nai: open\n---\nmore words\n", "write", "skill: x", "x"), "written");
  assert.deepEqual(written, ["Own.md"]);
});

test("a note too big to hold (listed as a file) is kept from skills and plugins: its own ai: line is unknown", async () => {
  class El { constructor() { this.classList = { add() {}, remove() {} }; this.style = {}; } setAttribute() {} append() {} addEventListener() {} querySelector() { return new El(); } get lastChild() { return new El(); } }
  globalThis.document ??= { createElement: () => new El(), createElementNS: () => new El(), createTextNode: (x) => x, addEventListener() {} };
  const { mountProposals } = await import("../proposals.js");
  const on = () => {};
  const p = mountProposals({ settings: {}, bus: { emit() {}, on }, vault: { bus: { on }, notes: new Map(), files: new Map([["Open/Huge.md", {}], ["Open/clip.mp4", {}]]), folders: new Set(["Open"]) }, host: { on, proposalsCount: async () => 0, aiAccessGet: async () => ({ default: "open", folders: {} }) } });
  await p.ready;
  assert.equal(p.noteAccess("Open/Huge.md"), "private");
  assert.equal(p.noteAccess("Open/clip.mp4"), "open");
});
