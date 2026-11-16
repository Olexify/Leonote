// Image helpers: attachment folders, names, finding embeds, width edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentDir, imageName, imagesIn, embedWidth, setEmbedWidth, withoutHeldPictures } from "../images.js";

test("attachmentDir follows Obsidian's attachment folder rules", () => {
  assert.equal(attachmentDir("Utilities/Cache", "Diary/Day.md"), "Utilities/Cache");
  assert.equal(attachmentDir("/Utilities/Cache/", "Day.md"), "Utilities/Cache");
  assert.equal(attachmentDir("", "Diary/Day.md"), "");
  assert.equal(attachmentDir("/", "Diary/Day.md"), "");
  assert.equal(attachmentDir("./", "Diary/Day.md"), "Diary");
  assert.equal(attachmentDir(".", "Day.md"), "");
  assert.equal(attachmentDir("./assets", "Diary/Day.md"), "Diary/assets");
  assert.equal(attachmentDir("Utilities\\Cache", "Day.md"), "Utilities/Cache");
});

test("imageName uses the note name and a timestamp, like the vault", () => {
  assert.equal(imageName("Diary/Local Run.md", "webp", 1784711741992), "Local Run-1784711741992.webp");
  assert.equal(imageName("", "png", 5), "Pasted image-5.png");
  assert.equal(imageName("a/Why: this?.md", "webp", 1), "Why this-1.webp");
});

test("imagesIn finds wiki and markdown image embeds in order", () => {
  const t = "x ![[a.webp|300]] y [[not-image]] ![[doc.pdf]] ![alt](b.png) ![](https://e.com/c.jpg?x=1) ![[Note]]";
  assert.deepEqual(imagesIn(t).map((e) => e.target), ["a.webp", "b.png", "https://e.com/c.jpg?x=1"]);
  const [first] = imagesIn(t);
  assert.equal(t.slice(first.from, first.to), "![[a.webp|300]]");
});

test("embedWidth reads the width in both syntaxes", () => {
  assert.equal(embedWidth("![[a.webp]]"), 0);
  assert.equal(embedWidth("![[a.webp|300]]"), 300);
  assert.equal(embedWidth("![[a.webp|258|417x740]]"), 258);
  assert.equal(embedWidth("![alt|120](a.png)"), 120);
  assert.equal(embedWidth("![alt](a.png)"), 0);
});

test("setEmbedWidth changes only the width and keeps other parameters", () => {
  assert.equal(setEmbedWidth("![[a.webp]]", 320), "![[a.webp|320]]");
  assert.equal(setEmbedWidth("![[a.webp|258|417x740]]", 400), "![[a.webp|400|417x740]]");
  assert.equal(setEmbedWidth("![[a.webp|300]]", 0), "![[a.webp]]");
  assert.equal(setEmbedWidth("![[a.webp|caption]]", 200), "![[a.webp|caption|200]]");
  assert.equal(setEmbedWidth("![alt](a.png)", 150), "![alt|150](a.png)");
  assert.equal(setEmbedWidth("![alt|150](a.png)", 0), "![alt](a.png)");
});

test("embed side: read and set left/right, keeping other params", async () => {
  const { embedSide, setEmbedSide } = await import("../images.js");
  assert.equal(embedSide("![[a.png|right|300]]"), "right");
  assert.equal(embedSide("![[a.png|300]]"), "");
  assert.equal(setEmbedSide("![[a.png|300]]", "left"), "![[a.png|left|300]]");
  assert.equal(setEmbedSide("![[a.png|left|300]]", "right"), "![[a.png|right|300]]");
  assert.equal(setEmbedSide("![[a.png|left]]", ""), "![[a.png]]");
  assert.equal(setEmbedSide("![cat|300](a.png)", "right"), "![cat|right|300](a.png)");
});

test("the viewer leaves out web pictures still held back, but for the one clicked or already shown", () => {
  const web = (from, url) => ({ from, url });
  const list = [web(0, "http://asset.localhost/E%3A%5Ca.png"), web(10, "https://evil.example/t.png"), web(20, "https://ok.example/s.png"), web(30, "https://evil.example/v.mp4")];
  list[3].video = true;
  const shown = new Set(["https://ok.example/s.png"]);
  assert.deepEqual(withoutHeldPictures(list, 0, false, shown).map((x) => x.from), [0, 20, 30]);
  assert.deepEqual(withoutHeldPictures(list, 10, false, shown).map((x) => x.from), [0, 10, 20, 30]);
  assert.equal(withoutHeldPictures(list, -1, true, shown).length, 4);
});
