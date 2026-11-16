// Web panels: what counts as an address, and what a stored shortcut may be.
// Everything a bad settings file could do to the panel is decided here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, suggestName, makeShortcut, upsertShortcut, removeShortcut, cleanShortcuts, providerFrom, WEB_COLORS } from "../webpanel.js";
import { searchUrl } from "../sources.js";

test("a bare host becomes https", () => {
  assert.equal(normalizeUrl("pinterest.com"), "https://pinterest.com/");
  assert.equal(normalizeUrl("  open.spotify.com/collection  "), "https://open.spotify.com/collection");
  assert.equal(normalizeUrl("<https://example.com/a>"), "https://example.com/a");
  assert.equal(normalizeUrl("localhost:5173"), "https://localhost:5173/");
});

test("http and https are kept exactly as typed", () => {
  assert.equal(normalizeUrl("http://192.168.1.4:8080/x"), "http://192.168.1.4:8080/x");
  assert.equal(normalizeUrl("https://www.youtube.com/feed/subscriptions"), "https://www.youtube.com/feed/subscriptions");
});

test("anything that is not a web page is refused, not repaired", () => {
  for (const bad of ["javascript:alert(1)", "file:///C:/Windows", "data:text/html,<b>hi", "mailto:a@b.c", "chrome://settings", "", "   ", "just some words", "C:\\Users\\me\\notes.md"]) {
    assert.equal(normalizeUrl(bad), null, `${bad} must not become a shortcut`);
  }
});

test("a name is suggested from the host, without www", () => {
  assert.equal(suggestName("https://www.pinterest.com/leo/collage"), "Pinterest");
  assert.equal(suggestName("https://open.spotify.com/"), "Open");
  assert.equal(suggestName("nonsense"), "Web page");
});

test("a shortcut fills in what you left out", () => {
  const rec = makeShortcut({ url: "youtube.com" });
  assert.equal(rec.name, "Youtube");
  assert.equal(rec.url, "https://youtube.com/");
  assert.equal(rec.icon, "globe");
  assert.equal(rec.color, WEB_COLORS[0]);
  assert.equal(rec.onTop, false);
  assert.match(rec.id, /[0-9a-f-]{8,}/);
});

test("a shortcut with no address is an error, never a half-made record", () => {
  const bad = makeShortcut({ name: "Nope", url: "javascript:void 0" });
  assert.ok(bad.error);
  assert.equal(bad.id, undefined);
});

test("an unknown colour or icon falls back instead of reaching the DOM", () => {
  const rec = makeShortcut({ url: "a.com", color: "#bad", icon: "<script>" });
  assert.equal(rec.color, WEB_COLORS[0]);
  assert.equal(rec.icon, "globe");
});

test("a remembered window geometry survives, within reason", () => {
  const rec = makeShortcut({ url: "a.com", w: 1200, h: 800, x: 40, y: 60 });
  assert.deepEqual([rec.w, rec.h, rec.x, rec.y], [1200, 800, 40, 60]);
  const silly = makeShortcut({ url: "a.com", w: 99999, h: -5, x: "nope", y: 1e9 });
  assert.equal(silly.w, 6000);
  assert.equal(silly.h, 200);
  assert.equal(silly.x, undefined, "a non-number is simply not remembered");
  assert.equal(silly.y, 20000);
});

test("upsert replaces by id and keeps the position in the list", () => {
  const a = makeShortcut({ url: "a.com", name: "A" });
  const b = makeShortcut({ url: "b.com", name: "B" });
  let l = upsertShortcut(upsertShortcut([], a), b);
  l = upsertShortcut(l, { ...a, name: "A2" });
  assert.deepEqual(l.map((x) => x.name), ["A2", "B"]);
  assert.deepEqual(removeShortcut(l, a.id).map((x) => x.name), ["B"]);
});

test("upsert keeps a geometry the edit did not mention", () => {
  const a = makeShortcut({ url: "a.com", name: "A", w: 900, h: 700 });
  const l = upsertShortcut([a], { ...a, name: "Renamed" });
  assert.equal(l[0].w, 900);
  assert.equal(l[0].name, "Renamed");
});

test("junk in the settings file never reaches the panel", () => {
  const same = makeShortcut({ url: "a.com" });
  const list = [null, 7, { url: "javascript:x" }, { url: "a.com", name: "Fine" }, same, { ...same }];
  const clean = cleanShortcuts(list);
  assert.equal(clean.length, 2, "the duplicate id is dropped too");
  assert.equal(clean[0].name, "Fine");
  assert.deepEqual(cleanShortcuts(undefined), []);
  assert.deepEqual(cleanShortcuts("not a list"), []);
});

/* ── scouting: turning what the user typed into a provider ─────────────── */
test("a provider comes from a domain, a {q} address, or not at all", () => {
  const ddg = providerFrom("duckduckgo.com");
  assert.equal(ddg.name, "Duckduckgo");
  assert.equal(ddg.url, "https://duckduckgo.com/?q={q}");
  assert.equal(providerFrom("  https://www.wikipedia.org  ").url, "https://en.wikipedia.org/w/index.php?search={q}");
  // an unknown site still gets a usable starting point
  assert.equal(providerFrom("example.org").url, "https://example.org/search?q={q}");
  // a full template is taken as it is
  const m = providerFrom("https://search.marginalia.nu/search?query={q}");
  assert.equal(m.url, "https://search.marginalia.nu/search?query={q}");
  assert.equal(m.name, "Marginalia", "a leading 'search.' label is not the site's name");
  assert.match(providerFrom("").error, /site/i);
  assert.match(providerFrom("what is a monad").error, /site/i);
});

test("searchUrl fills a provider in, and escapes what it is given", () => {
  const p = providerFrom("duckduckgo.com");
  assert.equal(searchUrl(p, "tauri navigate"), "https://duckduckgo.com/?q=tauri%20navigate");
  assert.equal(searchUrl(p, " a&b=c "), "https://duckduckgo.com/?q=a%26b%3Dc");
  assert.equal(searchUrl(p, "   "), null);
});
