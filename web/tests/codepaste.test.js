import { test } from "node:test";
import assert from "node:assert/strict";
import { isCode, guessLang } from "../htmlmd.js";

test("code pasted from an editor is told from a document, and its language is guessed", () => {
  assert.ok(isCode('<pre style="font-family:JetBrains Mono">a:<br>b</pre>'));
  assert.ok(isCode('<div style="white-space: pre;"><span>x</span></div>'));
  assert.ok(!isCode("<h1>Title</h1><pre>x</pre>"), "a document with a heading is not just code");
  assert.ok(!isCode("<p>words</p>"));
  assert.ok(!isCode('<p>Call <code style="font-family: ui-monospace, Consolas">fetch()</code> first</p><p>then wait</p>'), "paragraphs with a bit of inline code are text");
  assert.equal(guessLang("threads:\n  virtual:\n    enabled: true\ncloud:\n  aws:"), "yaml");
  assert.equal(guessLang('{ "a": 1 }'), "json");
  assert.equal(guessLang("def f(x):\n    return x"), "python");
  assert.equal(guessLang("pub fn main() {}"), "rust");
  assert.equal(guessLang("const a = () => 1;"), "js");
  assert.equal(guessLang("SELECT * FROM t"), "sql");
  assert.equal(guessLang("just some words"), "");
});
