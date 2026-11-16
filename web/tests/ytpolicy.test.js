// YouTube's developer policies in code: a gone video's name kept at most 30 days unless the user gave it,
// signing out revoked at Google, and the embed without modestbranding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { goneFields, GONE_KEEP } from "../youtube.js";
import { revokeGoogle } from "../ytaccount.js";

test("a gone video: dated when first found gone, its name dropped after 30 days unless the user named it", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(goneFields({ title: "A" }, true, now), { goneAt: now });
  assert.deepEqual(goneFields({ title: "A", goneAt: now - 1000 }, true, now), { goneAt: now - 1000 });
  assert.deepEqual(goneFields({ title: "A", goneAt: now - GONE_KEEP - 1 }, true, now), { goneAt: now - GONE_KEEP - 1, title: "" });
  assert.deepEqual(goneFields({ title: "Mine", named: true, goneAt: now - GONE_KEEP - 1 }, true, now), { goneAt: now - GONE_KEEP - 1 });
  assert.deepEqual(goneFields({ title: "A", goneAt: now - 5 }, false, now), { goneAt: 0 }); // back again
  assert.deepEqual(goneFields({ title: "A" }, false, now), {});
});

test("signing out asks the Rust side to revoke the token, and survives no answer", async () => {
  const calls = [];
  await revokeGoogle({ host: { googleToken: async (form, slot) => { calls.push([form, slot]); throw new Error("offline"); } } }, "youtube", { sealed: true });
  assert.deepEqual(calls, [[{ grant_type: "revoke", refresh_token: "" }, "youtube"]]);
  const rs = readFileSync(path.join(import.meta.dirname, "..", "..", "src-tauri", "src", "oauth.rs"), "utf8");
  assert.ok(rs.includes("https://oauth2.googleapis.com/revoke"));
});

test("the embed no longer asks to hide YouTube's branding", () => {
  assert.ok(!readFileSync(path.join(import.meta.dirname, "..", "youtube.js"), "utf8").includes("modestbranding"));
});
