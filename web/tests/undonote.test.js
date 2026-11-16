import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { describeStep } from "../undonote.js";

const step = (doc, changes) => EditorState.create({ doc }).update({ changes });

test("undo notes: says what came back, what went, and where", () => {
  assert.equal(describeStep(step("one\ntwo\n", { from: 4, insert: "hello " }), "undo").text, "Undo · brought back “hello”");
  assert.equal(describeStep(step("one\ntwo\n", { from: 4, insert: "hello " }), "undo").where, "line 2");
  assert.equal(describeStep(step("one\ntwo\n", { from: 0, to: 3 }), "redo").text, "Redo · removed “one”");
});

test("undo notes: a replacement names only the part that differs", () => {
  const d = describeStep(step("![[a.png|left|260]]", { from: 0, to: 19, insert: "![[a.png|260]]" }), "undo");
  assert.equal(d.text, "Undo · took out “left|”");
});

test("undo notes: several places, line breaks", () => {
  const d = describeStep(step("a\nb\nc", [{ from: 0, insert: "x" }, { from: 4, insert: "y" }]), "redo");
  assert.equal(d.where, "2 places, from line 1");
  assert.equal(describeStep(step("ab", { from: 1, insert: "\n" }), "undo").text, "Undo · brought back a line break");
});
