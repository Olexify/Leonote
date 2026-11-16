import { test } from "node:test";
import assert from "node:assert/strict";
import { pagesOf, matches } from "../webhistory.js";

const v = (url, title, at) => ({ url, title, at });

test("pagesOf: one per address, newest first, counted", () => {
  const p = pagesOf([v("https://a.com/x", "", 3), v("https://b.com", "B", 2), v("https://a.com/x", "A x", 1)]);
  assert.deepEqual(p.map((x) => [x.url, x.title, x.count, x.at]), [["https://a.com/x", "A x", 2, 3], ["https://b.com", "B", 1, 2]]);
});

test("matches: every word, in title or address, and site:", () => {
  const x = v("https://www.youtube.com/watch?v=1", "Jazz piano live", 1);
  assert.ok(matches(x, "jazz live"));
  assert.ok(matches(x, "site:youtube.com piano"));
  assert.ok(!matches(x, "site:tube.com"));
  assert.ok(matches(v("https://music.youtube.com/", "", 1), "site:youtube.com"));
  assert.ok(!matches(x, "jazz rock"));
  assert.ok(matches(x, ""));
});
