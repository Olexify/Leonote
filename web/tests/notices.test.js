// The notices that travel with the app: what they must hold, and that a build stops without the Rust list.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeNotices } from "../notices.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = (t) => { const d = mkdtempSync(path.join(tmpdir(), "notices-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test("the notices name the crates, the PDF viewer's fonts and Excalidraw, each with its licence text", (t) => {
  const dist = temp(t);
  writeNotices({ metafile: { inputs: {} }, repo, dist });
  const text = readFileSync(path.join(dist, "licenses.txt"), "utf8");
  for (const want of ["Rust crates in the desktop app", "tauri ", "Foxit fonts", "PDFium Authors", "LIBERATION FONT SOFTWARE", "Adobe Systems Incorporated", "OpenJPEG decoder", "## Excalidraw (MIT)", "Copyright (c) 2020 Excalidraw"]) assert.ok(text.includes(want), want);
  assert.ok(readFileSync(path.join(dist, "agents.txt"), "utf8").includes("agent contract"));
});

test("no Rust list, no build: nothing is written", (t) => {
  const dist = temp(t);
  assert.throws(() => writeNotices({ metafile: { inputs: {} }, repo: temp(t), dist }));
  assert.ok(!existsSync(path.join(dist, "licenses.txt")));
});
