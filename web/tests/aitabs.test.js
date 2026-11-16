import { test } from "node:test";
import assert from "node:assert/strict";
import { chatHit } from "../aitabs.js";
import { byLikeliest } from "../aihome.js";

test("chatHit: title, words said, nothing", () => {
  const t = { title: "Osaka trip", msgs: [{ role: "user", content: "plan it" }, { role: "assistant", content: [{ type: "text", text: "Day one: walk around Dotonbori at night" }] }] };
  assert.equal(chatHit(t, ""), "");
  assert.equal(chatHit(t, "osaka"), "");
  assert.match(chatHit(t, "dotonbori"), /Dotonbori at night/);
  assert.equal(chatHit(t, "kyoto"), null);
});

test("the quick box: a skill never allowed here does not sort above asking the chat", () => {
  const out = [{ id: "ask", p: 0.2 }, { id: "skill:new", p: 0.7 }, { id: "skill:ok", p: 0.5 }];
  const order = out.sort(byLikeliest(0.2, new Set(["skill:new"]))).map((x) => x.id);
  assert.deepEqual(order, ["skill:ok", "ask", "skill:new"]);
});
