import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// app.openFromOutside lives inside main.js's closure: its source is run with the closure's names stubbed.
function harness({ inWork = [], vault = { notes: ["a.md"], files: [] } } = {}) {
  const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
  const from = main.indexOf("app.openFromOutside = (paths) => {");
  const code = main.slice(from, main.indexOf("\n  };", from) + 5);
  const body = `
    let space = spaces[0], tabs = space.tabs, active = -1;
    const spacesApi = { switchTo(id) { space = spaces.find((s) => s.id === id); tabs = space.tabs; } };
    const flushCur = () => {}, show = () => {}, saveSession = () => {}, refreshGuest = () => {}, toast = () => {}, setCompact = () => {};
    const spacesUi = { paint() {} };
    const same = (a, b) => a.kind === b.kind && a.path === b.path;
    const extKey = (p) => String(p).replace(/\\//g, "\\\\").toLowerCase();
    const findExt = () => null;
    const GUEST_RE = /\\.pdf$/i;
    const guests = new Map();
    const relInVault = (abs) => { const p = abs.replace(/\\\\/g, "/"); return p.startsWith("V:/") ? p.slice(3) : null; };
    const calls = [];
    app.openNote = (p, o) => calls.push(["note", space.id, p, !!o.newTab]);
    app.openFile = (p, o) => calls.push(["file", space.id, p, !!o.newTab]);
    app.openExternal = (p, o) => calls.push(["ext", space.id, p, !!o.newTab]);
    ${code}
    return { calls, get space() { return space.id; }, get active() { return active; } };`;
  const app = { settings: {}, media: null, isGuest: (p) => p.startsWith("@guest/"), vault: { notes: new Set(vault.notes), files: new Set(vault.files) } };
  const spaces = [{ id: "work", tabs: [...inWork] }];
  const h = new Function("app", "host", "spaces", body)(app, {}, spaces);
  h.app = app;
  return h;
}

test("a vault note opened from Windows goes to 'Opened files' in a new tab, not into the space you work in", () => {
  const h = harness({ inWork: [{ kind: "note", path: "other.md" }] });
  h.app.openFromOutside(["V:\\a.md"]);
  assert.equal(h.space, "outside");
  assert.deepEqual(h.calls, [["note", "outside", "a.md", true]]);
});

test("a vault note already open in a tab is that tab, in its space, and nothing new opens", () => {
  const h = harness({ inWork: [{ kind: "note", path: "x.md" }, { kind: "note", path: "a.md" }] });
  h.app.openFromOutside(["V:\\a.md"]);
  assert.equal(h.space, "work");
  assert.equal(h.active, 1);
  assert.deepEqual(h.calls, []);
});

test("an outside file goes to 'Opened files' in a new tab", () => {
  const h = harness();
  h.app.openFromOutside(["C:\\Downloads\\b.md"]);
  assert.equal(h.space, "outside");
  assert.deepEqual(h.calls, [["ext", "outside", "C:\\Downloads\\b.md", true]]);
});
