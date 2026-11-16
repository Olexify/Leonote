// Security guardrails: what must stay true however the code changes. Each test names the protection it keeps;
// a new risky spot fails here until it has been looked at and put on the list on purpose (with the reason it
// is safe). Run with the other tests, so a change that undoes a protection cannot slip through a build.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const caps = fs.readdirSync(path.join(root, "src-tauri/capabilities")).filter((f) => f.endsWith(".json")).map((f) => [f, JSON.parse(read("src-tauri/capabilities/" + f))]);

test("the page's policy: no script from outside, no inline script, no plugins, no forms, no base tag", () => {
  const csp = conf.app.security.csp;
  assert.match(csp, /script-src 'self' blob:(;|$)/);
  for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp.split("script-src")[1].split(";")[0]), "script-src stays strict");
  assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ["style-src"], "only styles are left to the pages");
  assert.deepEqual(conf.app.security.assetProtocol.scope.allow, [], "the asset scope is the vault's, granted at run time - never a fixed path");
});

test("no website can call Leonote's commands, and no window holds broad powers", () => {
  const banned = /^(fs|shell|http|opener|dialog|process|updater|sql|store|clipboard-manager):/;
  for (const [f, c] of caps) {
    assert.ok(!c.remote, `${f}: no remote URLs - a website must never reach the commands`);
    for (const p of c.permissions) assert.ok(!banned.test(typeof p === "string" ? p : p.identifier), `${f}: ${JSON.stringify(p)} is a broad power - go through Leonote's own checked commands`);
  }
  // the small windows: exactly what they need, nothing more
  const exact = {
    "mini.json": ["core:default", "core:window:allow-start-dragging", "core:window:allow-start-resize-dragging", "core:window:allow-set-size", "core:window:allow-close", "core:window:allow-destroy", "window-state:default"],
    "script.json": ["core:default", "core:window:allow-set-always-on-top", "core:window:allow-set-position", "core:window:allow-set-size", "core:window:allow-hide", "core:window:allow-close", "core:window:allow-destroy", "window-state:default"],
  };
  for (const [f, want] of Object.entries(exact)) assert.deepEqual([...caps.find(([n]) => n === f)[1].permissions].sort(), [...want].sort(), f);
});

// Every place page code becomes markup or code, file by file - each looked at: built from Leonote's own
// constants or escaped text (icons, generated SVG, sanitised Markdown), or a sandboxed frame. A new one: look
// at it - where does the text come from, can a note, a file or a website put markup in it? - then count it here.
const SINKS = {
  innerHTML: { "board.js": 4, "dvframe.js": 2, "focus.js": 1, "graph.js": 1, "icons.js": 1, "imageedit.js": 1, "livepreview.js": 3, "mini.js": 2, "musicview.js": 1, "officeview.js": 4, "paint.js": 1, "script.js": 1, "sketch.js": 2, "videoedit.js": 1, "viewer.js": 2, "webtab.js": 1 },
  insertAdjacentHTML: { "paintengine.js": 1 },
  outerHTML: {},
  eval: { "dataview.js": 1 }, // a comment there ("...no eval" and a bracket after it) - no eval runs anywhere
  newFunction: {},
  docWrite: {},
  // main.js: the print frame - mdToHtml's escaped drawing (as boards), sandboxed with no scripts
  srcdoc: { "dataview.js": 1, "plugins.js": 1, "main.js": 1 },
  windowOpen: { "mock.js": 2, "sketch.js": 1 },
};
const PATTERNS = { innerHTML: /\.innerHTML\s*[+]?=/g, insertAdjacentHTML: /insertAdjacentHTML\s*\(/g, outerHTML: /\.outerHTML\s*=/g, eval: /(^|[^.\w])eval\s*\(/g, newFunction: /new Function\s*\(/g, docWrite: /document\.write\s*\(/g, srcdoc: /\.srcdoc\s*=|srcdoc:/g, windowOpen: /window\.open\s*\(/g };

test("no new place where page text becomes markup or code, unlooked-at", () => {
  for (const f of fs.readdirSync(path.join(root, "web")).filter((x) => x.endsWith(".js"))) {
    const s = read("web/" + f);
    for (const [k, re] of Object.entries(PATTERNS)) {
      const n = (s.match(re) || []).length;
      assert.ok(n <= (SINKS[k][f] || 0), `web/${f}: ${n} × ${k}, ${SINKS[k][f] || 0} looked at - check the new one (can a note, a file or a website put markup in it?), then count it in guardrails.test.js`);
    }
  }
});

// Where Rust starts another program, file by file: each with its arguments kept apart (no shell line built
// from text), the program named by Leonote or allowed by the user (grant.rs).
const RUNS = { "ai.rs": 1, "backup.rs": 2, "external.rs": 7, "jev.rs": 2, "officeconv.rs": 2, "phone.rs": 7, "project.rs": 1, "trashbin.rs": 1, "videoai.rs": 1, "videoexport.rs": 8 };

test("no new place that starts a program, unlooked-at; certificates are always checked", () => {
  for (const f of fs.readdirSync(path.join(root, "src-tauri/src")).filter((x) => x.endsWith(".rs") && !x.endsWith("_tests.rs"))) {
    const s = read("src-tauri/src/" + f);
    const n = (s.match(/Command::new\(/g) || []).length;
    assert.ok(n <= (RUNS[f] || 0), `src-tauri/src/${f}: ${n} programs started, ${RUNS[f] || 0} looked at - check the new one (who chooses the program and its arguments?), then count it here`);
    assert.ok(!/danger_accept_invalid|accept_invalid_certs|accept_invalid_hostnames|NoCertificateVerification/.test(s), `${f}: certificate checks are never switched off`);
  }
});

test("a command that makes a window is async (a sync one deadlocks Windows: a black window, a frozen app)", () => {
  for (const f of fs.readdirSync(path.join(root, "src-tauri/src")).filter((x) => x.endsWith(".rs"))) {
    const s = read("src-tauri/src/" + f);
    const re = /#\[tauri::command\]\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)/g;
    let m;
    while ((m = re.exec(s))) {
      // the command's body: up to the next command or the end of the file
      const next = s.indexOf("#[tauri::command]", m.index + 1);
      const body = s.slice(m.index, next < 0 ? undefined : next);
      if (/WebviewWindowBuilder::new|WebviewBuilder::new/.test(body)) assert.ok(m[3], `${f}: ${m[4]} makes a window and must be async`);
    }
  }
});

test("self-merging updates: only patch and non-Rust minor, only Dependabot's, only after the tests, which hold no write access", { skip: !fs.existsSync(path.join(root, ".github/workflows/dependabot-merge.yml")) }, () => {
  const w = read(".github/workflows/dependabot-merge.yml");
  const merge = w.slice(w.indexOf("  merge:"));
  const tests = w.slice(w.indexOf("  test:"), w.indexOf("  merge:"));
  assert.match(merge, /needs: test/);
  assert.match(merge, /user\.login == 'dependabot\[bot\]'/);
  assert.match(merge, /--match-head-commit/);
  assert.match(merge, /semver-minor' && steps.meta.outputs.package-ecosystem != 'cargo'/);
  assert.deepEqual([...merge.matchAll(/semver-(\w+)/g)].map((m) => m[1]).sort(), ["minor", "patch"]);
  assert.doesNotMatch(tests, /: write/);
  assert.doesNotMatch(w, /pull_request_target/);
  for (const m of w.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]} is pinned by commit`);
});

test("what lies next to Leonote or where it was started cannot run as part of it", () => {
  assert.match(read("src-tauri/build.rs"), /DEPENDENTLOADFLAG:0x800/, "DLLs from System32 only");
  assert.equal(read("src-tauri/src/lib.rs").match(/set_current_dir\(home_dir\(\)\)/g).length, 2, "the start folder is left, app and --mcp");
});
