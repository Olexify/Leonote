// The list and checkbox commands over a selection: blank lines between paragraphs stay blank.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { toggleBullets, toggleNumbers, toggleTask, toggleQuote } from "../mdcommands.js";

const run = (cmd, doc) => {
  let state = EditorState.create({ doc, selection: EditorSelection.single(0, doc.length) });
  const view = { get state() { return state; }, dispatch(tr) { state = state.update(tr).state; } };
  cmd(view);
  return state.doc.toString();
};
const nl = String.fromCharCode(10);
const two = "a" + nl + nl + "b";

test("bullets, numbers and checkboxes leave the blank line between paragraphs alone", () => {
  assert.equal(run(toggleBullets, two), "- a" + nl + nl + "- b");
  assert.equal(run(toggleNumbers, two), "1. a" + nl + nl + "2. b");
  assert.equal(run(toggleTask, two), "- [ ] a" + nl + nl + "- [ ] b");
});

test("a cursor on a blank line of its own keeps its mark beside a cursor on text", () => {
  const doc = "x" + nl + nl + "y";
  let state = EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]), extensions: EditorState.allowMultipleSelections.of(true) });
  const view = { get state() { return state; }, dispatch(tr) { state = state.update(tr).state; } };
  toggleBullets(view);
  assert.equal(state.doc.toString(), "- x" + nl + "- " + nl + "y");
});

test("a quote keeps its blank lines, so its paragraphs stay one quote", () => {
  assert.equal(run(toggleQuote, two), "> a" + nl + "> " + nl + "> b");
});
