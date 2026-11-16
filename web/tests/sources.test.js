// Search sources, the YouTube Data API shapes and the track
// matcher. No network: every answer here is a recorded shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSource, searchUrl, sourceHost, parseIsoDuration, mapSearch, mapDurations, mapPlaylistItems, apiErrorMessage, playlistId, decodeEntities } from "../sources.js";
import { norm, overlap, score, matchTracks } from "../matchtracks.js";

test("a source is only made when it can work", () => {
  assert.match(makeSource({ name: "", url: "https://x/?q={q}" }).error, /name/i);
  assert.match(makeSource({ name: "X", url: "example.com/{q}" }).error, /http/i);
  assert.match(makeSource({ name: "X", url: "https://example.com/search" }).error, /\{q\}/);
  assert.match(makeSource({ name: "Y", kind: "youtube-api" }).error, /key/i);
  const s = makeSource({ name: " Odysee ", url: "https://odysee.com/$/search?q={q}", color: "#c33" });
  assert.equal(s.name, "Odysee");
  assert.equal(s.kind, "link");
  assert.equal(s.color, "#c33");
  assert.ok(s.id && s.addedAt);
  const api = makeSource({ name: "YouTube", kind: "youtube-api", apiKey: " AIza-test " });
  assert.equal(api.apiKey, "AIza-test");
  assert.equal(api.url, "", "an API source has no link template");
});

test("searchUrl and sourceHost", () => {
  const s = makeSource({ name: "X", url: "https://ex.com/s?q={q}&safe=1" });
  assert.equal(searchUrl(s, "nils frahm"), "https://ex.com/s?q=nils%20frahm&safe=1");
  assert.equal(searchUrl(s, "  "), null);
  assert.equal(searchUrl(makeSource({ name: "Y", kind: "youtube-api", apiKey: "k" }), "x"), null);
  assert.equal(sourceHost(s), "ex.com");
});

test("ISO durations and API shapes", () => {
  assert.equal(parseIsoDuration("PT4M13S"), 253);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("rubbish"), 0);
  const found = mapSearch({ items: [
    { id: { videoId: "abc12345678" }, snippet: { title: "Say &quot;hi&quot; &amp; go", channelTitle: "A &amp; B", thumbnails: { medium: { url: "https://i/mq.jpg" } } } },
    { id: { videoId: "no-title" }, snippet: {} },
    { id: { channelId: "c" }, snippet: { title: "a channel" } },
  ] });
  assert.equal(found.length, 1);
  assert.equal(found[0].title, 'Say "hi" & go');
  assert.equal(found[0].channel, "A & B");
  assert.equal(found[0].thumb, "https://i/mq.jpg");
  assert.equal(mapDurations({ items: [{ id: "abc", contentDetails: { duration: "PT3M" } }] }).get("abc"), 180);
  const pl = mapPlaylistItems({ nextPageToken: "n2", items: [
    { snippet: { title: "One", resourceId: { videoId: "v1" }, videoOwnerChannelTitle: "Chan" } },
    { snippet: { title: "Deleted video", resourceId: { videoId: "v2" } } },
    { snippet: { title: "No id" } },
  ] });
  assert.equal(pl.next, "n2");
  assert.deepEqual(pl.items, [{ id: "v1", title: "One", artists: ["Chan"], url: "https://www.youtube.com/watch?v=v1" }]);
  assert.equal(decodeEntities("caf&#233; &lt;3"), "café <3");
});

test("API errors read like sentences", () => {
  assert.match(apiErrorMessage(403, { error: { errors: [{ reason: "quotaExceeded" }], message: "quota" } }), /quota/i);
  assert.match(apiErrorMessage(403, { error: { errors: [{ reason: "keyInvalid" }] } }), /key/i);
  assert.match(apiErrorMessage(404, {}), /nothing at that address/i);
  assert.match(apiErrorMessage(0, null), /offline/i);
});

test("playlist links", () => {
  assert.equal(playlistId("https://www.youtube.com/playlist?list=PLabcdefghijk"), "PLabcdefghijk");
  assert.equal(playlistId("https://www.youtube.com/watch?v=x&list=PLzzzzzzzzzzz"), "PLzzzzzzzzzzz");
  assert.equal(playlistId("PLabcdefghijk"), "PLabcdefghijk");
  assert.equal(playlistId("https://www.youtube.com/watch?v=x"), "");
});

test("matching: names survive remasters, features and punctuation", () => {
  assert.equal(norm("The Weight (2019 Remaster)"), "weight");
  assert.equal(norm("Beyoncé – Halo [feat. Someone]"), "beyonce halo");
  assert.equal(norm("Rock & Roll"), "rock and roll");
  assert.equal(overlap("blue hour", "Blue Hour"), 1);
  const cand = { key: "Music/Polar Nights/02 Northern Lights.mp3", title: "Northern Lights", artist: "Aurora Trio", album: "Polar Nights", duration: 253 };
  assert.ok(score({ title: "Northern Lights - 2021 Remaster", artists: ["Aurora Trio"], duration: 253 }, cand) > 0.9);
  assert.ok(score({ title: "Northern Lights", artists: ["Someone Else"], duration: 253 }, cand) < 0.75);
  assert.equal(score({ title: "A different song", artists: ["Aurora Trio"] }, cand), 0);
});

test("matchTracks: counts what it found and leaves the rest alone", () => {
  const candidates = [
    { key: "a.mp3", title: "Blue Hour", artist: "Aurora Trio", duration: 190 },
    { key: "b.mp3", title: "Northern Lights", artist: "Aurora Trio", duration: 253 },
    { key: "c.mp3", title: "Paper Boats", artist: "Mira Sol", duration: 140 },
  ];
  const wanted = [
    { title: "Blue Hour (Remastered)", artists: ["Aurora Trio"], duration: 190 },
    { title: "Northern Lights", artists: ["Aurora Trio"] },
    { title: "Something we do not own", artists: ["Nobody"] },
  ];
  const r = matchTracks(wanted, candidates);
  assert.equal(r.matched, 2);
  assert.equal(r.total, 3);
  assert.equal(r.tracks[0].key, "a.mp3");
  assert.equal(r.tracks[1].key, "b.mp3");
  assert.equal(r.tracks[2].key, "");
  assert.ok(r.tracks[2].score < 0.62);
});

test("a pasted site becomes an offer, not a source", async () => {
  const { bareDomain, guessTemplate } = await import("../sources.js");
  assert.deepEqual(bareDomain("odysee.com"), { host: "odysee.com", base: "odysee.com", youtube: false });
  assert.equal(bareDomain("https://www.odysee.com/").host, "odysee.com");
  assert.equal(bareDomain("WWW.Bandcamp.COM").host, "bandcamp.com");
  assert.ok(bareDomain("youtube.com").youtube);
  assert.ok(bareDomain("https://music.youtube.com").youtube);
  assert.equal(bareDomain("https://www.youtube.com/watch?v=abcdefghijk"), null, "a video link is not a site");
  assert.equal(bareDomain("two words"), null);
  assert.equal(bareDomain("just-a-name"), null);
  assert.equal(guessTemplate("odysee.com"), "https://odysee.com/$/search?q={q}");
  assert.equal(guessTemplate("www.youtube.com"), "https://www.youtube.com/results?search_query={q}");
  assert.equal(guessTemplate("example.org"), "https://example.org/search?q={q}");
});

test("YouTube is read only through the Data API", async () => {
  const { readYtList, findYtVideo } = await import("../sources.js");
  const host = {};
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    const url = new URL(u);
    const items = url.pathname.endsWith("/playlistItems") ? [{ snippet: { title: "One", resourceId: { videoId: "abcdefghijk" } } }]
      : url.pathname.endsWith("/search") ? [{ id: { videoId: "abcdefghijk" }, snippet: { title: "One" } }]
      : url.pathname.endsWith("/videos") ? [{ id: "abcdefghijk", contentDetails: { duration: "PT3M" } }] : [];
    return { ok: true, status: 200, json: async () => ({ items }) };
  };
  try {
    // nothing set up: a plain message, and nothing reaches the network
    const bare = { host, settings: {} };
    await assert.rejects(readYtList(bare, "PLabcdefghijklmnop"), /sign-in or key/);
    await assert.rejects(findYtVideo(bare, "a song"), /sign-in or key/);
    assert.equal(seen.length, 0);
    // the user's own key
    const keyed = { host, settings: { ytApiKey: " k " } };
    const r = await readYtList(keyed, "https://www.youtube.com/watch?v=x&list=PLabcdefghijklmnop");
    assert.deepEqual(r.items.map((x) => x.id), ["abcdefghijk"]);
    assert.equal(r.items[0].secs, 180); // what Show › Short and Long go by
    assert.equal((await findYtVideo(keyed, "a song")).id, "abcdefghijk");
    assert.ok(seen.length && seen.every((u) => u.startsWith("https://www.googleapis.com/youtube/v3/")));
    // signed in: through the sign-in, no key
    const asked = [];
    const signed = { host, settings: {}, ytPush: { connected: () => true, api: async (m, p) => { asked.push(p); return { items: [] }; } } };
    await readYtList(signed, "PLabcdefghijklmnop");
    assert.ok(asked.includes("/playlistItems"));
  } finally { globalThis.fetch = realFetch; }
});

test("a video made private is not taken out of a playlist", async () => {
  const { syncYtList } = await import("../ytsync.js");
  const [realFetch, realImage] = [globalThis.fetch, globalThis.Image];
  // oEmbed says 401 and the old picture is still there: private, or plays only on YouTube
  globalThis.fetch = async (u) => (String(u).includes("/oembed") ? { ok: false, status: 401 }
    : { ok: true, status: 200, json: async () => ({ items: [{ snippet: { title: "One", resourceId: { videoId: "aaaaaaaaaaa" } } }] }) });
  globalThis.Image = class { naturalWidth = 320; set src(_) { this.onload(); } };
  const run = async (app) => {
    const pl = { id: "p", name: "P", ytList: "PLabcdefghijklmnop", ytPrune: true, items: ["yt:aaaaaaaaaaa", "yt:bbbbbbbbbbb"] };
    let items = null;
    const removed = [];
    const M = { playlists: { all: () => [pl], set: (_, it) => { items = it; }, patch: () => {} }, online: { addMany: () => {}, mark: () => {}, entry: () => null, remove: (k) => removed.push(...k) } };
    return { s: await syncYtList(app, M, pl), items, removed };
  };
  try {
    const store = await run({ settings: { ytApiKey: "k" }, host: {} });
    assert.equal(store.s.dropped, 0);
    assert.deepEqual(store.removed, []);
  } finally { globalThis.fetch = realFetch; globalThis.Image = realImage; }
});
