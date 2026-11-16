// Tempo, key and loudness read from synthetic sound: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { bpmOf, keyOf, loudnessOf, monoDown, peaksOf, moodOf, keyName, transpose, analyzeChannels, densityOf } from "../soundanalysis.js";

const RATE = 11025;

/** A drum-like click every beat, with a softer one between: `bpm` for `secs`. */
function clicks(bpm, secs, rate = RATE) {
  const x = new Float32Array(Math.round(secs * rate));
  const beat = (60 / bpm) * rate;
  for (let b = 0; b * beat < x.length; b++) {
    const at = Math.round(b * beat);
    for (let i = 0; i < 400 && at + i < x.length; i++) x[at + i] += Math.sin(i * 0.9) * Math.exp(-i / 60) * (b % 4 === 0 ? 1 : 0.7);
  }
  for (let i = 0; i < x.length; i++) x[i] += (Math.random() - 0.5) * 0.01;
  return x;
}

/** Chords of sine tones, each for `each` seconds. */
function chords(list, each, rate = RATE) {
  const n = Math.round(each * rate);
  const x = new Float32Array(n * list.length);
  list.forEach((notes, c) => {
    for (const midi of notes) {
      const f = 440 * 2 ** ((midi - 69) / 12);
      for (let i = 0; i < n; i++) x[c * n + i] += 0.2 * Math.sin((2 * Math.PI * f * i) / rate);
    }
  });
  return x;
}

test("tempo is read from the beat", () => {
  for (const bpm of [84, 100, 120, 137, 160]) {
    const got = bpmOf(clicks(bpm, 30), RATE);
    assert.ok(Math.abs(got - bpm) <= 1.5, `${bpm} BPM read as ${got}`);
  }
});

test("a held chord under the beat does not make beats of its own", () => {
  // a drone makes short energy frames wobble; the tempo must still be the clicks'
  const rate = 44100, n = rate * 20, x = new Float32Array(n);
  const beat = Math.round((60 / 128) * rate);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const hz of [220, 261.63, 329.63]) v += 0.08 * Math.sin((2 * Math.PI * hz * i) / rate);
    const into = i % beat;
    if (into < 1500) v += Math.sin(into * 0.25) * Math.exp(-into / 250) * 0.6;
    x[i] = v;
  }
  const r = analyzeChannels([x, x], rate);
  assert.ok(Math.abs(r.bpm - 128) <= 1.5, `read ${r.bpm}`);
  assert.equal(keyName(r.key), "Am");
});

test("a very slow or very fast pulse is folded to where it is felt", () => {
  const got = bpmOf(clicks(62, 30), RATE);
  assert.ok(Math.abs(got - 124) <= 2 || Math.abs(got - 62) <= 1.5 || Math.abs(got - 93) <= 2, `62 BPM read as ${got}`);
});

test("the key is read from the notes", () => {
  // A minor: Am, Dm, E, Am (the E chord with its G sharp)
  const am = chords([[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64], [45, 57, 60, 64]], 2);
  assert.equal(keyName(keyOf(am, RATE)), "Am");
  // C major: C, F, G, C
  const c = chords([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67], [48, 60, 64, 67]], 2);
  assert.equal(keyName(keyOf(c, RATE)), "C");
});

test("keys move with the pitch", () => {
  assert.equal(keyName(transpose({ tonic: 11, minor: true }, 2)), "C♯m");
  assert.equal(keyName(transpose({ tonic: 0, minor: false }, -1)), "B");
  assert.equal(keyName(null), "—");
});

test("loudness is in dB and ignores the silences", () => {
  const x = new Float32Array(RATE * 10);
  for (let i = 0; i < RATE * 6; i++) x[i] = 0.5 * Math.sin(i * 0.1);
  const db = loudnessOf(x, RATE);
  assert.ok(Math.abs(db - -9.0) < 1, `a 0.5 sine is about -9 dB RMS, got ${db}`);
});

test("samples are brought down to one channel and a lower rate", () => {
  const l = new Float32Array(44100).fill(0.5), r = new Float32Array(44100).fill(-0.5);
  const { samples, rate } = monoDown([l, r], 44100);
  assert.equal(rate, 11025);
  assert.equal(samples.length, 11025);
  assert.equal(samples[100], 0);
  const p = peaksOf(clicks(120, 10), 50);
  assert.equal(p.length, 50);
  assert.ok(Math.max(...p) === 255);
});

test("a mood from tempo, loudness and how busy it is", () => {
  assert.equal(moodOf({ bpm: 70, loudness: -22, density: 0.5 }), "calm");
  assert.equal(moodOf({ bpm: 80, loudness: -12, density: 1 }), "slow");
  assert.equal(moodOf({ bpm: 105, loudness: -12, density: 1 }), "medium");
  assert.equal(moodOf({ bpm: 135, loudness: -14, density: 2 }), "fast");
  assert.equal(moodOf({ bpm: 135, loudness: -8, density: 2 }), "energetic");
  assert.equal(moodOf({ bpm: 170, loudness: -6, density: 4 }), "chaotic");
});

test("the whole reading at once", () => {
  const x = clicks(128, 20, 44100);
  const r = analyzeChannels([x, x], 44100);
  assert.ok(Math.abs(r.bpm - 128) <= 1.5, `read ${r.bpm}`);
  assert.equal(r.peaks.length, 240);
  assert.ok(r.duration > 19.9 && r.duration < 20.1);
  assert.ok(densityOf(monoDown([x], 44100).samples, 11025) > 1);
});
