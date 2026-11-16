// Code editor helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIndent } from "../codeview.js";

test("detectIndent reads tabs and space widths from the file", () => {
  assert.deepEqual(detectIndent("def a():\n    if x:\n        pass\n"), { unit: "    ", label: "Spaces: 4" });
  assert.deepEqual(detectIndent("{\n  \"a\": {\n    \"b\": 1\n  }\n}\n"), { unit: "  ", label: "Spaces: 2" });
  assert.deepEqual(detectIndent("fn main() {\n\tlet x = 1;\n\tif x {\n\t\ty();\n\t}\n}\n"), { unit: "\t", label: "Tabs" });
  assert.deepEqual(detectIndent("no indentation at all\n"), { unit: "    ", label: "Spaces: 4" });
});
