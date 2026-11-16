// What typed into the address box becomes: a page, a local file, or a search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toUrl, downloadAllowed } from "../webtab.js";
import { storeCrx } from "../webaddons.js";

const ID = "ciiembegoahhehnfdkbanhioobokjdkd";
test("an add-on's store page is the store's own host, not its name in the address", () => {
  for (const ok of [`https://chromewebstore.google.com/detail/kitsumi/${ID}?hl=en`, `chromewebstore.google.com/detail/${ID}`, `https://chrome.google.com/webstore/detail/x/${ID}`, `https://microsoftedge.microsoft.com/addons/detail/x/${ID}`, ID]) assert.equal(storeCrx(ok)?.id, ID, ok);
  for (const bad of [`https://evil.example/?chromewebstore.google.com/detail/${ID}`, `https://evil.example/chromewebstore.google.com/detail/${ID}`, `https://chromewebstore.google.com.evil.example/detail/${ID}`, `https://chromewebstore.google.com@evil.example/detail/${ID}`, `ftp://chromewebstore.google.com/detail/${ID}`]) assert.equal(storeCrx(bad), null, bad);
});

test("'always allow downloads' goes by the page that asked, not where the file is kept", () => {
  const url = "https://files.example/a.exe";
  assert.equal(downloadAllowed({ url, page: "https://evil.example/" }, ["files.example"]), false);
  assert.equal(downloadAllowed({ url, page: "https://www.files.example/x" }, ["files.example"]), true);
  assert.equal(downloadAllowed({ url, page: "about:blank" }, ["files.example"]), false);
  assert.equal(downloadAllowed({ url, page: "https://wwwxfiles.example/" }, ["files.example"]), false);
});

test("local pages open as file addresses", () => {
  assert.equal(toUrl("file:///D:/Sites/demo/index.html#chaos"), "file:///D:/Sites/demo/index.html#chaos");
  assert.equal(toUrl("D:\\Sites\\demo\\index.html"), "file:///D:/Sites/demo/index.html");
  assert.equal(toUrl("e:/site/index.html"), "file:///e:/site/index.html");
  assert.equal(toUrl("\\\\nas\\share\\page.html"), "file://nas/share/page.html");
  assert.equal(toUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(toUrl("example.com"), "https://example.com");
  assert.ok(/^https?:\/\//.test(toUrl("cats and dogs")));
});
