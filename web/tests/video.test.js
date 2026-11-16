import test from "node:test";
import assert from "node:assert/strict";
import { parseVideo, TRANSITIONS, volAt } from "../videoedit.js";
import { sameInVault, reuseDirFor } from "../videolib.js";

test("a private project or clip is named, so its words stay away from the model", async () => {
  const { privateSourceOf } = await import("../videoedit.js");
  const app = { proposals: { noteAccess: (p) => (p.startsWith("Private/") ? "private" : "review") } };
  const proj = (...src) => ({ clips: src.map((s) => ({ src: s })) });
  assert.equal(privateSourceOf(app, "V/a.leovideo", proj("V/a.mp4", null)), undefined);
  assert.equal(privateSourceOf(app, "V/a.leovideo", proj("V/a.mp4", "Private/Call.m4a")), "Private/Call.m4a");
  assert.equal(privateSourceOf(app, "Private/a.leovideo", proj()), "Private/a.leovideo");
  assert.equal(privateSourceOf({}, "Private/a.leovideo", proj()), undefined, "no access rules loaded in this window");
});

test("parseVideo keeps a transition it knows and drops the rest", () => {
  const p = parseVideo(JSON.stringify({ tracks: [{ id: "v1", kind: "visual" }], clips: [
    { id: "a", track: "v1", type: "image", src: "a.png", start: 0, dur: 2, transition: { kind: "fade", len: 9 } },
    { id: "b", track: "v1", type: "image", src: "b.png", start: 2, dur: 2, transition: { kind: "none" } },
    { id: "c", track: "v1", type: "image", src: "c.png", start: 4, dur: 2, transition: { kind: "warp" } },
  ] }));
  assert.deepEqual(p.clips[0].transition, { kind: "fade", len: 3 });
  assert.equal(p.clips[1].transition, null);
  assert.equal(p.clips[2].transition, null);
  assert.ok(TRANSITIONS.length > 5);
});

test("reusable media: a file already in the vault is found by name and size; the folder by kind", () => {
  const app = { vault: { files: new Map([["Workplace/Videos/VideoMedia/Audio/Beat.mp3", { path: "Workplace/Videos/VideoMedia/Audio/Beat.mp3", size: 100 }]]) }, workDir: () => "Workplace/Videos" };
  assert.equal(sameInVault(app, "beat.MP3", 100).path, "Workplace/Videos/VideoMedia/Audio/Beat.mp3");
  assert.equal(sameInVault(app, "beat.mp3", 101), null);
  assert.equal(reuseDirFor(app, "x.gif"), "Workplace/Videos/VideoMedia/GIFs");
  assert.equal(reuseDirFor(app, "x.txt"), null);
});

test("a speed ramp: where in the file a clip is, the speeds added up", async () => {
  const { srcAt, speedAt, srcSpan } = await import("../videoedit.js");
  const even = { in: 2, dur: 4, speed: 2, speedTo: null };
  assert.equal(srcAt(even, 1), 4);
  assert.equal(srcSpan(even), 8);
  const ramp = { in: 0, dur: 4, speed: 1, speedTo: 3 }; // 1x up to 3x: on average 2x
  assert.equal(speedAt(ramp, 2), 2);
  assert.equal(srcSpan(ramp), 8);
  assert.equal(srcAt(ramp, 2), 2 + 1); // 1*2 + (2*4)/(2*4)
});

test("a loudness curve: 20 → 100 → 80 → 40 → 100, straight between the points, held past the ends", () => {
  const p = parseVideo(JSON.stringify({ tracks: [{ id: "a1", kind: "audio" }], clips: [
    { id: "m", track: "a1", type: "audio", src: "m.mp3", start: 0, in: 10, dur: 8, vol: [{ t: 10, v: 0.2 }, { t: 12, v: 1 }, { t: 14, v: 0.8 }, { t: 16, v: 0.4 }, { t: 18, v: 1 }] },
  ] }));
  const c = p.clips[0];
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(volAt(c, 0), 0.2);
  near(volAt(c, 1), 0.6);
  near(volAt(c, 3), 0.9);
  near(volAt(c, 5), 0.6);
  near(volAt(c, 7), 0.7);
  near(volAt(c, 8), 1);
  // trimmed from the left: the curve stays on the sound, not on the clip
  near(volAt({ ...c, in: 12, start: 2, dur: 6 }, 0), 1);
  near(volAt({ ...c, vol: [] }, 3), c.volume);
});

test("Disk space's map: blocks fill the area, each in proportion to its size", async () => {
  const { squarify } = await import("../sizes.js");
  const b = squarify([{ size: 60 }, { size: 30 }, { size: 10 }], 200, 100);
  assert.equal(b.length, 3);
  const area = (x) => x.w * x.h;
  assert.ok(Math.abs(b.reduce((s, x) => s + area(x), 0) - 20000) < 1e-6);
  assert.ok(Math.abs(area(b[0]) - 12000) < 1e-6 && Math.abs(area(b[2]) - 2000) < 1e-6);
  assert.ok(b.every((x) => x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= 200 + 1e-6 && x.y + x.h <= 100 + 1e-6));
});

test("a clip's sound: a real failure is told apart from a video that may have none", async () => {
  const { readSound } = await import("../videoedit.js");
  const real = globalThis.fetch;
  const ok = { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  const bad = (name) => ({ decodeAudioData: async () => { throw Object.assign(new Error("x"), { name }); } });
  try {
    globalThis.fetch = async () => ({ ok: false }); // decoding the error page would look like "no sound"
    assert.deepEqual(await readSound("u", bad("EncodingError")), { failed: true });
    globalThis.fetch = async () => { throw new TypeError("moved"); };
    assert.deepEqual(await readSound("u", {}), { failed: true });
    globalThis.fetch = async () => ok;
    assert.deepEqual(await readSound("u", bad("EncodingError")), { unsure: true });
    assert.deepEqual(await readSound("u", bad("RangeError")), { failed: true });
    assert.deepEqual(await readSound("u", { decodeAudioData: async () => "buf" }), { buf: "buf" });
  } finally { globalThis.fetch = real; }
});

test("the real-time recorder says which clips it could not hear", async () => {
  const { playedGaps } = await import("../videoedit.js");
  const els = {
    moved: { error: { code: 4 } },
    quiet: { error: null, webkitAudioDecodedByteCount: 0 },
    fine: { error: null, webkitAudioDecodedByteCount: 900 },
    other: { error: null }, // a browser without the count: nothing to say
  };
  const clips = [
    { id: "moved", type: "audio", src: "a/moved.mp3" }, { id: "moved", type: "audio", src: "a/moved.mp3" },
    { id: "quiet", type: "video", src: "b/quiet.mp4" }, { id: "quiet", type: "audio", src: "b/dead.wav" },
    { id: "fine", type: "video", src: "fine.mp4" }, { id: "other", type: "video", src: "other.mp4" }, { id: "never", type: "video", src: "never.mp4" },
  ];
  assert.deepEqual(playedGaps(clips, (c) => els[c.id]), { failed: ["moved.mp3", "dead.wav"], unsure: ["quiet.mp4"] });
});
