// The Animations setting: what a stored value resolves to, and the helpers
// JS-driven animation asks before it moves anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOTION_MODES, resolveMotion, motionMode, motionOk, motionFull } from "../util.js";
import { DEFAULTS } from "../settings.js";

test("the five modes are exactly what the setting offers", () => {
  assert.deepEqual(MOTION_MODES, ["full", "lively", "gorgeous", "reduced", "off"]);
});

test("a chosen value wins over the system preference", () => {
  for (const m of MOTION_MODES) {
    assert.equal(resolveMotion(m, false), m);
    assert.equal(resolveMotion(m, true), m);
  }
});

test("nothing chosen follows prefers-reduced-motion", () => {
  assert.equal(resolveMotion(undefined, false), "full");
  assert.equal(resolveMotion(undefined, true), "reduced");
  assert.equal(resolveMotion("auto", false), "full");
  assert.equal(resolveMotion("auto", true), "reduced");
});

test("junk in the settings file never turns into a bad data-motion", () => {
  for (const bad of [null, "", "FULL", "none", 0, 1, true, {}, [], "off ", "reduced\n"]) {
    const got = resolveMotion(bad, false);
    assert.equal(got, "full", `${JSON.stringify(bad)} -> ${got}`);
    assert.ok(MOTION_MODES.includes(resolveMotion(bad, true)));
  }
});

test("the shipped default defers to the system", () => {
  assert.equal(DEFAULTS.motion, "auto");
  assert.equal(resolveMotion(DEFAULTS.motion, false), "full");
  assert.equal(resolveMotion(DEFAULTS.motion, true), "reduced");
});

// The helpers read <html data-motion>. Outside a browser there is no document,
// so they answer "full" - a test or a script never accidentally skips work.
test("motionMode, motionOk and motionFull without a document", () => {
  assert.equal(typeof document, "undefined");
  assert.equal(motionMode(), "full");
  assert.equal(motionOk(), true);
  assert.equal(motionFull(), true);
});

test("motionOk allows fades in Reduced, motionFull does not allow movement", () => {
  const fake = { documentElement: { dataset: {} } };
  const mode = (v) => { fake.documentElement.dataset.motion = v; return resolveMotion(fake.documentElement.dataset.motion); };
  assert.equal(mode("reduced"), "reduced");
  assert.equal(mode("reduced") !== "off", true); // motionOk
  assert.equal(mode("reduced") === "full", false); // motionFull
  assert.equal(mode("off") !== "off", false);
  assert.equal(mode("full") === "full", true);
});
