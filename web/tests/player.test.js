// Player: ID3 parsing, YouTube links, queue rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseId3, id3Size, titleFromName } from "../id3.js";
import { parseYouTube } from "../youtube.js";
import * as Q from "../playqueue.js";

const ss = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
function frame(ver, id, body) {
  const size = ver >= 4 ? ss(body.length) : be(body.length);
  return [...Buffer.from(id), ...size, 0, 0, ...body];
}
const txt = (s, enc = 3) => [enc, ...(enc === 1 ? [0xff, 0xfe, ...Buffer.from(s, "utf16le")] : Buffer.from(s, enc === 0 ? "latin1" : "utf8"))];
function tag(ver, frames, pad = 32) {
  const body = [...frames.flat(), ...new Array(pad).fill(0)];
  return new Uint8Array([0x49, 0x44, 0x33, ver, 0, 0, ...ss(body.length), ...body, 0xff, 0xfb]);
}

test("id3 v2.4: text frames and cover", () => {
  const pic = [...Array(40).keys()];
  const b = tag(4, [
    frame(4, "TIT2", txt("Привіт")), frame(4, "TPE1", txt("Artist")), frame(4, "TALB", txt("Album")),
    frame(4, "TDRC", txt("2021-05-01")), frame(4, "TRCK", txt("3/12")),
    frame(4, "APIC", [0, ...Buffer.from("image/png"), 0, 3, ...Buffer.from("desc"), 0, ...pic]),
  ]);
  const t = parseId3(b);
  assert.equal(t.title, "Привіт");
  assert.equal(t.artist, "Artist");
  assert.equal(t.album, "Album");
  assert.equal(t.year, "2021");
  assert.equal(t.track, 3);
  assert.equal(t.cover.mime, "image/png");
  assert.deepEqual([...t.cover.data], pic);
  assert.equal(id3Size(b), b.length - 2);
});

test("id3 v2.3: UTF-16 and latin1", () => {
  const t = parseId3(tag(3, [frame(3, "TIT2", txt("Été", 1)), frame(3, "TPE1", txt("Café", 0))]));
  assert.equal(t.title, "Été");
  assert.equal(t.artist, "Café");
});

test("id3: no tag, truncated tag", () => {
  assert.deepEqual(parseId3(new Uint8Array([1, 2, 3])), {});
  const b = tag(4, [frame(4, "TIT2", txt("Whole")), frame(4, "TALB", txt("Cut off here"))]);
  const t = parseId3(b.subarray(0, 30));
  assert.equal(t.title, "Whole");
});

test("titleFromName", () => {
  assert.deepEqual(titleFromName("Music/01 - Artist - Song.mp3"), { artist: "Artist", title: "Song", track: 1 });
  assert.deepEqual(titleFromName("a/Just a song.mp3"), { title: "Just a song", track: undefined });
});

test("parseYouTube", () => {
  assert.deepEqual(parseYouTube("https://www.youtube.com/watch?v=abcdefghijk&t=1m5s"), { id: "abcdefghijk", start: 65 });
  assert.deepEqual(parseYouTube("youtu.be/abcdefghijk"), { id: "abcdefghijk" });
  assert.deepEqual(parseYouTube("https://youtube.com/shorts/abcdefghijk?feature=share"), { id: "abcdefghijk" });
  assert.deepEqual(parseYouTube("https://www.youtube.com/playlist?list=PL123"), { list: "PL123" });
  assert.deepEqual(parseYouTube("https://music.youtube.com/watch?v=abcdefghijk&list=RD1"), { id: "abcdefghijk", list: "RD1" });
  assert.equal(parseYouTube("https://example.com/watch?v=abcdefghijk"), null);
  assert.equal(parseYouTube("https://www.youtube.com/@channel"), null);
  assert.equal(parseYouTube("not a link"), null);
});

test("queue: order, repeat, remove, move", () => {
  const q = Q.createQueue();
  Q.setItems(q, ["a", "b", "c"], 0);
  assert.equal(Q.nextIndex(q, { auto: true }), 1);
  Q.go(q, 2);
  assert.equal(Q.nextIndex(q, { auto: true }), -1);
  assert.equal(Q.nextIndex(q), 0); // pressing next wraps
  q.repeat = "all";
  assert.equal(Q.nextIndex(q, { auto: true }), 0);
  q.repeat = "one";
  assert.equal(Q.nextIndex(q, { auto: true }), 2);
  assert.equal(Q.nextIndex(q), 0);
  Q.remove(q, 0);
  assert.deepEqual(q.items, ["b", "c"]);
  assert.equal(Q.current(q), "c");
  Q.insert(q, ["x", "b"], { next: true });
  assert.deepEqual(q.items, ["b", "c", "x"]);
  Q.move(q, 1, 0);
  assert.deepEqual(q.items, ["c", "b", "x"]);
  assert.equal(Q.current(q), "c");
  Q.move(q, 2, 0);
  assert.equal(Q.current(q), "c");
  assert.equal(q.index, 1);
  Q.rename(q, "x", "y");
  assert.deepEqual(q.items, ["y", "c", "b"]);
});

test("queue: shuffle visits everything once, previous goes back", () => {
  const q = Q.createQueue({ items: ["a", "b", "c", "d"], index: 0, shuffle: true });
  const seen = new Set(["a"]);
  for (let i = 0; i < 3; i++) { const n = Q.nextIndex(q, { auto: true }); seen.add(Q.go(q, n)); }
  assert.equal(seen.size, 4);
  assert.equal(Q.nextIndex(q, { auto: true }), -1);
  const before = q.history[q.history.length - 1];
  assert.equal(Q.prevIndex(q), before);
  Q.go(q, Q.prevIndex(q), { back: true });
  assert.equal(q.index, before);
});

test("m3u8 round trip", () => {
  const text = Q.toM3u8("Mix", ["Music/a.mp3", "yt:abcdefghijk"], (k) => (k === "Music/a.mp3" ? { title: "A", artist: "X", duration: 61.2 } : {}));
  assert.match(text, /#EXTINF:61,X - A\nMusic\/a\.mp3/);
  assert.deepEqual(Q.fromM3u(text), ["Music/a.mp3", "yt:abcdefghijk"]);
  assert.deepEqual(Q.fromM3u("song.mp3\r\n.\\sub\\b.mp3", "Music"), ["Music/song.mp3", "Music/sub/b.mp3"]);
});

test("direct media links", () => {
  assert.deepEqual(Q.parseDirect("https://cdn.example.org/a%20song.MP3?sig=1"), { url: "https://cdn.example.org/a%20song.MP3?sig=1", name: "a song.MP3", audio: true });
  assert.equal(Q.parseDirect("https://example.org/clip.webm").audio, false);
  assert.equal(Q.parseDirect("https://example.org/page.html"), null);
  assert.equal(Q.parseDirect("ftp://example.org/a.mp3"), null);
  assert.ok(Q.looksLikeUrl("youtu.be/abcdefghijk") && Q.looksLikeUrl("https://x.org") && !Q.looksLikeUrl("rain on glass"));
  const k = Q.urlKey("https://x.org/a.mp3");
  assert.ok(Q.isUrl(k) && Q.isOnline(k) && !Q.isYt(k) && Q.urlOf(k) === "https://x.org/a.mp3");
  const text = Q.toM3u8("Mix", [k, "Music/b.mp3"]);
  assert.match(text, /\nhttps:\/\/x\.org\/a\.mp3\n/);
  assert.deepEqual(Q.fromM3u(text), [k, "Music/b.mp3"]);
});

test("search: every word, accents and case ignored, marks", () => {
  const w = Q.terms("  cafe  MAR ");
  assert.deepEqual(w, ["cafe", "mar"]);
  assert.ok(Q.matchesAll(["Café del Mar", "Chill"], w));
  assert.ok(!Q.matchesAll(["Café del Sol"], w));
  assert.ok(Q.matchesAll(["x"], []));
  assert.deepEqual(Q.markRanges("Café del Mar", w), [[0, 4], [9, 12]]);
  assert.deepEqual(Q.markRanges("Ééé", ["ee"]), [[0, 3]]);
  assert.deepEqual(Q.markRanges("abc", []), []);
});

test("replaceKey: an online item becomes a vault file", () => {
  const q = Q.createQueue({ items: ["a", "url:u", "b"], index: 1 });
  Q.replaceKey(q, "url:u", "Music/u.mp3");
  assert.deepEqual(q.items, ["a", "Music/u.mp3", "b"]);
  assert.equal(Q.current(q), "Music/u.mp3");
  const q2 = Q.createQueue({ items: ["x", "url:u", "Music/u.mp3"], index: 0 });
  Q.replaceKey(q2, "url:u", "Music/u.mp3");
  assert.deepEqual(q2.items, ["x", "Music/u.mp3"]);
});

test("library keys: files outside the vault", () => {
  const win = "D:" + String.fromCharCode(92) + "Music" + String.fromCharCode(92) + "a.mp3";
  const k = Q.libKey(win);
  assert.equal(k, "lib:D:/Music/a.mp3");
  assert.ok(Q.isLib(k) && Q.isLocal(k) && !Q.isOnline(k));
  assert.equal(Q.libPath(k), "D:/Music/a.mp3");
  assert.equal(Q.libKey("/mnt/music/b.mp3"), "lib:/mnt/music/b.mp3");
  // an .m3u8 with absolute Windows paths comes back as library items
  assert.deepEqual(Q.fromM3u(win + "\nMusic/in-vault.mp3"), [k, "Music/in-vault.mp3"]);
  const text = Q.toM3u8("Mix", [k], () => ({ title: "A" }));
  assert.match(text, /\nD:\/Music\/a\.mp3\n/);
});
