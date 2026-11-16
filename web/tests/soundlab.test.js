import { test } from "node:test";
import assert from "node:assert/strict";
import { SOUND_PRESETS, DEFAULT_CHAIN, EQ_LABELS, presetChain } from "../audiograph.js";

test("built-in sound presets: known stages and settings only, sane values, unique names", () => {
  const names = new Set();
  for (const [group, name, stages] of SOUND_PRESETS) {
    assert.ok(group && name, "a group and a name");
    assert.ok(!names.has(name), `one "${name}"`);
    names.add(name);
    for (const [k, v] of Object.entries(stages)) {
      assert.ok(DEFAULT_CHAIN[k], `${name}: no stage "${k}"`);
      for (const key of Object.keys(v)) assert.ok(key in DEFAULT_CHAIN[k], `${name}: ${k} has no "${key}"`);
    }
    const c = presetChain(stages);
    assert.equal(c.eq.gains.length, EQ_LABELS.length);
    assert.ok(c.eq.gains.every((g) => g >= -12 && g <= 12), `${name}: EQ within ±12 dB`);
    for (const k of Object.keys(DEFAULT_CHAIN)) assert.equal(c[k].on, !!stages[k], `${name}: ${k} on only when named`);
  }
  assert.ok(SOUND_PRESETS.length >= 30, "dozens of them");
});
