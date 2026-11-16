// The app's pages run no inline script and no eval (tauri.conf.json's policy): a note that slips HTML
// through can then not run anything. These keep it so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const web = new URL("../", import.meta.url);
const read = (f) => readFileSync(new URL(f, web), "utf8");

test("the app's policy allows scripts only from the app, blob: and YouTube's player", () => {
  const csp = JSON.parse(read("../src-tauri/tauri.conf.json")).app.security.csp;
  const script = /script-src([^;]*)/.exec(csp || "");
  assert.ok(script, "a script-src");
  // no script from outside: YouTube's player is its embed in a frame, spoken to by messages (youtube.js)
  assert.equal(script[1].trim(), "'self' blob:");
});

test("no page has an inline script, and no app code evals", () => {
  for (const f of readdirSync(web).filter((f) => f.endsWith(".html"))) assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(read(f)), f + " has an inline script");
  for (const f of readdirSync(web).filter((f) => f.endsWith(".js"))) assert.ok(!/new Function\(|[^.\w]eval\(/.test(read(f)), f + " evals");
});
