// Renumbering a selected list: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { renumberText } from "../mdcommands.js";

test("renumber: counted again from the first number, whatever stands before it", () => {
  const was = ["(1)plugins", "1)localization", "+-2)ai integration", "3)more animation", "4)settings", "5)lens"].join("\n");
  assert.equal(renumberText(was), ["(1)plugins", "2)localization", "+-3)ai integration", "4)more animation", "5)settings", "6)lens"].join("\n"));
  assert.equal(renumberText("3. a\ntext between\n3. b\n9. c"), "3. a\ntext between\n4. b\n5. c");
  assert.equal(renumberText("no numbers here"), "no numbers here");
});

test("a heading made on an empty line leaves the caret after its marks, ready for words", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { setHeading } = await import("../mdcommands.js");
  const run = (doc, caret, level) => {
    const v = { state: EditorState.create({ doc, selection: { anchor: caret } }), dispatch(spec) { this.state = this.state.update(spec).state; } };
    setHeading(level)(v);
    return [v.state.doc.toString(), v.state.selection.main.head];
  };
  assert.deepEqual(run("a\n\nb", 2, 3), ["a\n### \nb", 6]);
  assert.deepEqual(run("## Title", 5, 3), ["### Title", 6]);
  assert.deepEqual(run("## Title", 1, 1), ["# Title", 2]);
});
