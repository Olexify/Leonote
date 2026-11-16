// Research board model tests: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../boardmodel.js";

const rect = (x, y, width, height) => ({ x, y, width, height });
const anyOverlap = (rs, gap = 0) => rs.some((a, i) => rs.some((b, j) => i < j && M.overlaps(a, b, gap)));

test("newId: 16 lowercase hex characters, unique", () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = M.newId();
    assert.match(id, /^[0-9a-f]{16}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 2000);
});

test("parseCanvas: empty text is a new board, not an error", () => {
  for (const t of ["", "   \n", null, undefined]) {
    const r = M.parseCanvas(t);
    assert.equal(r.error, null);
    assert.deepEqual(r.canvas, { nodes: [], edges: [] });
  }
});

test("parseCanvas: broken text is an empty board plus an error", () => {
  for (const t of ["{nope", "[1,2]", "42", '"text"', "null"]) {
    const r = M.parseCanvas(t);
    assert.ok(r.error, t);
    assert.deepEqual(r.canvas.nodes, []);
    assert.deepEqual(r.canvas.edges, []);
  }
  assert.equal(M.parseCanvas("\ufeff{\"nodes\":[]}").error, null);
});

test("parseCanvas + serializeCanvas keep unknown fields everywhere", () => {
  const src = JSON.stringify({
    nodes: [
      { id: "a1", type: "text", text: "hi", x: 1.4, y: -2.6, width: 250.5, height: 60, color: "1", styleAttributes: { shape: "pill" } },
      { id: "b2", type: "file", file: "Notes/One.md", subpath: "#Intro", x: 300, y: 0, width: 400, height: 400, future: [1, 2] },
      { id: "g3", type: "group", label: "Stuff", x: -50, y: -50, width: 900, height: 600, background: "bg.png", backgroundStyle: "ratio" },
      { id: "l4", type: "link", url: "https://example.com", x: 0, y: 500, width: 400, height: 100, color: "#aabbcc" },
    ],
    edges: [{ id: "e1", fromNode: "a1", fromSide: "right", toNode: "b2", toSide: "left", toEnd: "none", label: "why", pathfinder: "square" }],
    metadata: { version: "1.0-1.0", frontmatter: {} },
  });
  const { canvas, error } = M.parseCanvas(src);
  assert.equal(error, null);
  const out = M.serializeCanvas(canvas);
  const back = JSON.parse(out);
  assert.deepEqual(back.metadata, { version: "1.0-1.0", frontmatter: {} });
  assert.deepEqual(back.nodes[0].styleAttributes, { shape: "pill" });
  assert.deepEqual(back.nodes[1].future, [1, 2]);
  assert.equal(back.nodes[1].subpath, "#Intro");
  assert.equal(back.nodes[2].backgroundStyle, "ratio");
  assert.equal(back.nodes[3].color, "#aabbcc");
  assert.equal(back.edges[0].pathfinder, "square");
  assert.equal(back.edges[0].label, "why");
  // whole numbers on disk
  assert.deepEqual([back.nodes[0].x, back.nodes[0].y, back.nodes[0].width], [1, -3, 251]);
  // parsing again gives the same text: stable, diff friendly
  assert.equal(M.serializeCanvas(M.parseCanvas(out).canvas), out);
});

test("serializeCanvas: tab indented, one node per line, like Obsidian", () => {
  const out = M.serializeCanvas({ nodes: [{ id: "a", type: "text", text: "x", x: 0, y: 0, width: 10, height: 10 }], edges: [] });
  assert.equal(out, '{\n\t"nodes":[\n\t\t{"id":"a","type":"text","text":"x","x":0,"y":0,"width":10,"height":10}\n\t],\n\t"edges":[]\n}');
  assert.equal(M.serializeCanvas({ nodes: [], edges: [] }), '{\n\t"nodes":[],\n\t"edges":[]\n}');
});

test("parseCanvas: repairs ids and sizes, drops dangling edges", () => {
  const { canvas, dropped } = M.parseCanvas(JSON.stringify({
    nodes: [
      { id: "same", type: "text", text: "one", x: 0, y: 0, width: 100, height: 50 },
      { id: "same", type: "text", text: "two", x: "10", y: null },
      { type: "file", file: "a.png" },
      "junk",
    ],
    edges: [
      { id: "e", fromNode: "same", toNode: "missing" },
      { fromNode: "same", toNode: "same" },
    ],
  }));
  assert.equal(canvas.nodes.length, 3);
  const ids = canvas.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(canvas.nodes[1].x, 10);
  assert.equal(canvas.nodes[1].y, 0);
  assert.equal(canvas.nodes[1].width, M.SIZES.text[0]);
  assert.deepEqual([canvas.nodes[2].width, canvas.nodes[2].height], M.SIZES.image);
  assert.equal(canvas.edges.length, 1);
  assert.match(canvas.edges[0].id, /^[0-9a-f]{16}$/);
  assert.equal(dropped, 2);
});

test("makeNode / makeEdge: Obsidian key order and an arrow to the target", () => {
  const n = M.makeNode("file", { file: "A.md", subpath: "#H" }, 1.2, 2.7, 400, 300);
  assert.deepEqual(Object.keys(n), ["id", "type", "file", "subpath", "x", "y", "width", "height"]);
  assert.deepEqual([n.x, n.y], [1, 3]);
  const e = M.makeEdge("a", "right", "b", "left");
  assert.equal(e.toEnd, "arrow");
  assert.equal(M.kindOf(n), "note");
  assert.equal(M.kindOf({ type: "file", file: "x/pic.JPG" }), "image");
  assert.equal(M.kindOf({ type: "file", file: "doc.pdf" }), "file");
  assert.equal(M.kindOf({ type: "banana" }), "unknown");
});

test("colorVar: presets, hex, and nothing else", () => {
  assert.equal(M.colorVar("3"), "var(--bd-c3)");
  assert.equal(M.colorVar("#A1b2C3"), "#A1b2C3");
  assert.equal(M.colorVar("#abc"), "#abc");
  for (const bad of ["7", "red", "#ggg", "url(x)", "#abc;background:red", null, 3]) assert.equal(M.colorVar(bad), "");
});

test("bounds, overlaps, contains, groupMembers", () => {
  assert.equal(M.bounds([]), null);
  assert.deepEqual(M.bounds([rect(0, 0, 10, 10), rect(-5, 20, 5, 5)]), rect(-5, 0, 15, 25));
  assert.ok(M.overlaps(rect(0, 0, 10, 10), rect(9, 9, 5, 5)));
  assert.ok(!M.overlaps(rect(0, 0, 10, 10), rect(10, 0, 5, 5)));
  assert.ok(M.overlaps(rect(0, 0, 10, 10), rect(12, 0, 5, 5), 3));
  const g = { id: "g", type: "group", ...rect(0, 0, 100, 100) };
  const nodes = [g, { id: "in", ...rect(10, 10, 20, 20) }, { id: "half", ...rect(90, 90, 20, 20) }, { id: "sub", type: "group", ...rect(5, 5, 50, 50) }];
  assert.deepEqual(M.groupMembers(nodes, g), ["in", "sub"]);
});

test("sides and edge geometry", () => {
  const a = rect(0, 0, 100, 50);
  const b = rect(300, 10, 100, 50);
  assert.deepEqual(M.autoSides(a, b), ["right", "left"]);
  assert.deepEqual(M.autoSides(a, rect(0, 300, 100, 50)), ["bottom", "top"]);
  assert.deepEqual(M.autoSides(b, a), ["left", "right"]);
  assert.equal(M.nearestSide(a, 50, -10), "top");
  assert.equal(M.nearestSide(a, 99, 25), "right");
  assert.deepEqual(M.sidePoint(a, "bottom"), [50, 50]);

  const geo = M.edgeGeometry(a, b, "right", "left", { arrow: 10 });
  assert.match(geo.d, /^M100 25C/);
  assert.ok(geo.d.endsWith("290 35"), geo.d); // the line stops at the arrow's base
  assert.equal(geo.arrows.length, 1);
  assert.match(geo.arrows[0], /^M300 35L/); // the tip touches the target
  assert.ok(geo.mid[0] > 100 && geo.mid[0] < 300);

  const both = M.edgeGeometry(a, b, "bogus", undefined, { fromEnd: "arrow", toEnd: "arrow" });
  assert.equal(both.fromSide, "right");
  assert.equal(both.toSide, "left");
  assert.equal(both.arrows.length, 2);
  assert.equal(M.edgeGeometry(a, b, "top", "top", { toEnd: "none" }).arrows.length, 0);
});

test("gridLayout: order kept, aligned columns, no overlaps", () => {
  const sizes = [[100, 50], [200, 80], [100, 120], [50, 50], [300, 40]].map(([width, height]) => ({ width, height }));
  const pos = M.gridLayout(sizes, { x: 10, y: 20, gap: 30, cols: 2 });
  assert.deepEqual(pos[0], { x: 10, y: 20 });
  assert.deepEqual(pos[1], { x: 10 + 300 + 30, y: 20 });
  assert.equal(pos[2].x, 10);
  assert.equal(pos[2].y, 20 + 80 + 30);
  assert.equal(pos[3].x, pos[1].x);
  assert.ok(!anyOverlap(pos.map((p, i) => ({ ...p, ...sizes[i] }))));
  assert.deepEqual(M.gridLayout([]), []);
});

test("findFreeSpot: keeps a free spot, moves off a taken one", () => {
  const obstacles = [rect(0, 0, 200, 200), rect(220, 0, 200, 200)];
  assert.deepEqual(M.findFreeSpot(rect(0, 400, 100, 100), obstacles), { x: 0, y: 400 });
  const spot = M.findFreeSpot(rect(50, 50, 100, 100), obstacles, { gap: 20 });
  const r = rect(spot.x, spot.y, 100, 100);
  assert.ok(!obstacles.some((o) => M.overlaps(o, r, 20)));
  assert.ok(Math.hypot(spot.x - 50, spot.y - 50) < 400);
});

test("ringLayout: cards around a centre, clear of it and of each other", () => {
  const c = rect(0, 0, 400, 400);
  const sizes = Array.from({ length: 9 }, () => ({ width: 320, height: 280 }));
  const pos = M.ringLayout(c, sizes, { gap: 60, obstacles: [c] });
  const rs = pos.map((p, i) => ({ ...p, ...sizes[i] }));
  assert.equal(rs.length, 9);
  assert.ok(!rs.some((r) => M.overlaps(r, c)));
  assert.ok(!anyOverlap(rs));
  // a half ring on the right stays right of the centre
  const right = M.ringLayout(c, sizes.slice(0, 4), { from: -Math.PI * 0.42, to: Math.PI * 0.42, obstacles: [c] });
  assert.ok(right.every((p) => p.x + 160 > 200));
  assert.deepEqual(M.ringLayout(c, []), []);
});

test("forceLayout: linked cards end up closer, nothing overlaps", () => {
  const rects = Array.from({ length: 12 }, (_, i) => rect((i % 4) * 30, Math.floor(i / 4) * 30, 200, 150));
  const links = [[0, 11], [11, 5], [3, 8]];
  const pos = M.forceLayout(rects, links);
  const rs = pos.map((p, i) => ({ ...p, width: 200, height: 150 }));
  assert.ok(!anyOverlap(rs));
  const d = (i, j) => Math.hypot(rs[i].x - rs[j].x, rs[i].y - rs[j].y);
  const avg = rs.reduce((s, _, i) => s + rs.reduce((t, _2, j) => t + d(i, j), 0), 0) / (12 * 11);
  assert.ok(d(0, 11) < avg, `${d(0, 11)} < ${avg}`);
  assert.equal(M.forceLayout([rect(5, 5, 10, 10)], [])[0].x, 5);
});

const notes = [
  { path: "A.md", links: [{ target: "B" }] },
  { path: "B.md", links: [{ target: "C" }, { target: "Nowhere" }] },
  { path: "C.md", links: [] },
  { path: "D.md", links: [{ target: "C" }, { target: "A" }] },
  { path: "E.md", links: [{ target: "E" }] },
  { path: "F.md", links: [{ target: "G" }] },
  { path: "G.md", links: [{ target: "H" }] },
  { path: "H.md", links: [{ target: "I" }] },
  { path: "I.md", links: [{ target: "J" }] },
  { path: "J.md", links: [{ target: "K" }] },
  { path: "K.md", links: [{ target: "L" }] },
  { path: "L.md", links: [{ target: "M" }] },
  { path: "M.md", links: [] },
];
const resolve = (t) => (notes.some((n) => n.path === t + ".md") ? t + ".md" : null);

test("buildLinkMap: resolved, deduplicated, no self links", () => {
  const map = M.buildLinkMap(notes, resolve);
  assert.deepEqual([...map.get("B.md")], ["C.md"]);
  assert.deepEqual([...map.get("E.md")], []);
  assert.ok(M.linksTo(map, "A.md", "B.md"));
  assert.ok(!M.linksTo(map, "B.md", "A.md"));
  assert.deepEqual([...M.neighbours(map, "C.md")].sort(), ["B.md", "D.md"]);
});

test("shortestPath: either direction, depth limit, unreachable", () => {
  const map = M.buildLinkMap(notes, resolve);
  const p = M.shortestPath(map, "A.md", "C.md");
  assert.equal(p.length, 3);
  assert.equal(p[0], "A.md");
  assert.equal(p[2], "C.md");
  assert.deepEqual(M.shortestPath(map, "C.md", "A.md").length, 3); // against link direction
  assert.deepEqual(M.shortestPath(map, "A.md", "B.md"), ["A.md", "B.md"]);
  assert.deepEqual(M.shortestPath(map, "A.md", "A.md"), ["A.md"]);
  assert.equal(M.shortestPath(map, "A.md", "E.md"), null);
  // F to M is 7 steps: past the default limit of 6
  assert.equal(M.shortestPath(map, "F.md", "M.md"), null);
  assert.equal(M.shortestPath(map, "F.md", "M.md", 7).length, 8);
  assert.equal(M.shortestPath(map, "F.md", "L.md").length, 7);
});

test("sharedNeighbours: linked to or from both", () => {
  const map = M.buildLinkMap(notes, resolve);
  assert.deepEqual(M.sharedNeighbours(map, "A.md", "C.md"), ["B.md", "D.md"]);
  assert.deepEqual(M.sharedNeighbours(map, "A.md", "E.md"), []);
});

test("mentioning and rankNotes", () => {
  const vaultNotes = [
    { path: "x.md", title: "Quantum notes", content: "About Entropy and more", mtime: 1 },
    { path: "y.md", title: "Entropy", content: "heat death", mtime: 2 },
    { path: "z.md", title: "Other", content: "nothing", lower: "mentions entropy here", mtime: 3 },
  ];
  assert.deepEqual(M.mentioning(vaultNotes, "entropy", ["y.md"]), ["x.md", "z.md"]);
  assert.deepEqual(M.mentioning(vaultNotes, "ab"), []);
  const ranked = M.rankNotes(vaultNotes, "entropy");
  assert.deepEqual(ranked.map((n) => n.path), ["y.md", "z.md", "x.md"]);
  assert.deepEqual(M.rankNotes(vaultNotes, "entropy", { exclude: new Set(["y.md"]), limit: 1 }).map((n) => n.path), ["z.md"]);
  assert.deepEqual(M.rankNotes(vaultNotes, "  "), []);
});

test("copy, read and remap clipboard payloads", () => {
  const canvas = {
    nodes: [
      { id: "a", type: "text", text: "one", x: 0, y: 0, width: 10, height: 10, extra: { k: 1 } },
      { id: "b", type: "text", text: "two", x: 50, y: 0, width: 10, height: 10 },
      { id: "c", type: "text", text: "three", x: 99, y: 0, width: 10, height: 10 },
    ],
    edges: [{ id: "e1", fromNode: "a", toNode: "b", label: "keep" }, { id: "e2", fromNode: "b", toNode: "c" }],
  };
  const p = M.copyPayload(canvas, ["a", "b"]);
  assert.equal(p.nodes.length, 2);
  assert.deepEqual(p.edges.map((e) => e.id), ["e1"]);
  p.nodes[0].text = "changed";
  assert.equal(canvas.nodes[0].text, "one"); // a deep copy

  const read = M.readPayload(JSON.stringify(p));
  const r = M.remapPayload(read, 5, -5);
  assert.equal(r.nodes.length, 2);
  assert.ok(r.nodes.every((n) => !["a", "b"].includes(n.id) && /^[0-9a-f]{16}$/.test(n.id)));
  assert.deepEqual([r.nodes[1].x, r.nodes[1].y], [55, -5]);
  assert.deepEqual(r.nodes[0].extra, { k: 1 });
  assert.equal(r.edges[0].fromNode, r.nodes[0].id);
  assert.equal(r.edges[0].toNode, r.nodes[1].id);
  assert.equal(r.edges[0].label, "keep");

  for (const junk of ["", "plain text", "{}", '{"nodes":[]}', "{broken", '{"nodes":["x"]}', null]) assert.equal(M.readPayload(junk), null, String(junk));
});

test("wikiTargets and urlOf for drops and pastes", () => {
  assert.deepEqual(M.wikiTargets("see [[One]], [[Two|alias]] and [[One#h]] ![[pic.png]]"), ["One", "Two", "pic.png"]);
  assert.deepEqual(M.wikiTargets("nothing"), []);
  assert.equal(M.urlOf("  https://example.com/a?b=1 "), "https://example.com/a?b=1");
  assert.equal(M.urlOf("www.example.com"), "https://www.example.com");
  assert.equal(M.urlOf("see https://example.com"), null);
  assert.equal(M.urlOf("javascript:alert(1)"), null);
  assert.equal(M.urlOf("https://a.com\nhttps://b.com"), null);
  assert.equal(M.urlOf("# comment\nhttps://a.com", true), "https://a.com");
});

test("sectionOf: headings and block ids", () => {
  const doc = "---\ntags: x\n---\n# Top\nintro\n## Part A\na1\n### Deep\na2\n## Part B\nb1 ^blk\n\npara one\npara two ^p2";
  const a = M.sectionOf(doc, "#Part A");
  assert.equal(a.text, "## Part A\na1\n### Deep\na2");
  assert.equal(a.offset, 5);
  assert.equal(M.sectionOf(doc, "#Top#Part B").text, "## Part B\nb1 ^blk\n\npara one\npara two ^p2");
  const b = M.sectionOf(doc, "#^p2");
  assert.equal(b.text, "para one\npara two");
  assert.equal(b.offset, 12);
  assert.equal(M.sectionOf(doc, "#^blk").text, "b1"); // a block never reaches past a heading
  assert.ok(M.sectionOf(doc, "#Nope").missing);
  assert.equal(M.sectionOf(doc, "").text, doc);
});

test("mdToHtml: escapes everything a note could smuggle in", () => {
  const evil = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "[click](javascript:alert(1))",
    '[[a" onmouseover="alert(1)]]',
    "![x](javascript:alert(1))",
    "```\n</code></pre><script>x()</script>\n```",
    "`<b>code</b>`",
    "> <iframe src=//evil>",
    "| <svg onload=x> | b |\n|---|---|\n| <a href=x> | c |",
    "**<em onclick=x>bold</em>**",
    "#<script>",
    "https://x.com/\"><script>",
  ].join("\n\n");
  const html = M.mdToHtml(evil, { resolve: () => null, image: (t) => (t.startsWith("javascript") ? "javascript:alert(1)" : null) });
  assert.ok(!/<(script|iframe|svg)/i.test(html), html);
  assert.ok(!/<img/i.test(html), html);
  assert.ok(!/<[^>]+\shref=/i.test(html), "never an href");
  assert.ok(!/<em onclick/i.test(html));
  assert.ok(html.includes("&lt;script&gt;"));
  // every tag that comes out is one we chose
  const allowed = new Set(["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "mark", "code", "pre", "ul", "ol", "li", "span", "a", "blockquote", "div", "table", "thead", "tbody", "tr", "th", "td", "hr", "img"]);
  for (const m of html.matchAll(/<\/?([a-z0-9]+)/gi)) assert.ok(allowed.has(m[1].toLowerCase()), m[1]);
  // attributes only ever sit inside quotes we wrote
  for (const m of html.matchAll(/<[a-z0-9]+([^>]*)>/gi)) {
    const rest = m[1].replace(/\s[a-z-]+="[^"<>]*"/gi, "").replace(/\s(start|width)="\d+"/g, "").trim();
    assert.equal(rest, "", m[0]);
  }
});

test("mdToHtml: headings, emphasis, lists, tasks with source lines", () => {
  const html = M.mdToHtml("---\ntitle: x\n---\n# Title\nSome **bold**, *it*, _it2_, ~~gone~~, ==hi== and `x`.\n\n- [ ] todo\n  - [x] done\n- plain\n1. first", {});
  assert.ok(html.includes('<h1 class="md-h">Title</h1>'));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>it</em>"));
  assert.ok(html.includes("<em>it2</em>"));
  assert.ok(html.includes("<del>gone</del>"));
  assert.ok(html.includes('<mark class="md-mark">hi</mark>'));
  assert.ok(html.includes('<code class="md-code">x</code>'));
  assert.ok(html.includes('data-line="6"'), html); // lines count from the top of the file
  assert.ok(html.includes('class="md-task is-done"><span class="md-cb" role="checkbox" aria-checked="true" data-line="7"'));
  assert.ok(html.includes('<ol class="md-list"><li>first</li></ol>'));
  assert.ok(!html.includes("title: x"), "frontmatter hidden");
  assert.equal(M.mdToHtml("snake_case_name and 2*3*4"), "<p>snake_case_name and 2*3*4</p>");
  assert.ok(M.mdToHtml("- [ ] a", { offset: 10 }).includes('data-line="10"'));
});

test("mdToHtml: links, tags, pictures, callouts, tables, code", () => {
  const html = M.mdToHtml(
    "See [[Known|the note]], [[Gone]], [[Known#Part]] and [site](https://a.com) or https://b.org/x.\n#topic/sub\n![[pic.png|200]] ![[nope.png]] ![alt](img/cat.jpg)\n\n> [!tip] Nice\n> inside **it**\n\n> plain quote\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n```js\nlet a = [[x]] #no\n```\n---\n%% hidden %%",
    { resolve: (t) => (t === "Known" ? "Known.md" : null), image: (t) => (t === "nope.png" ? null : "asset://" + t) }
  );
  assert.ok(html.includes('<a class="md-wl" data-target="Known">the note</a>'));
  assert.ok(html.includes('<a class="md-wl is-missing" data-target="Gone">Gone</a>'));
  assert.ok(html.includes('data-target="Known" data-sub="#Part">Known › Part</a>'));
  assert.ok(html.includes('<a class="md-a" data-href="https://a.com">site</a>'));
  assert.ok(html.includes('data-href="https://b.org/x">https://b.org/x</a>.'));
  assert.ok(html.includes('<span class="md-tag" data-tag="topic/sub">#topic/sub</span>'));
  assert.ok(html.includes('src="asset://pic.png" alt="pic.png" width="200"'));
  assert.ok(html.includes('<span class="md-img-missing">nope.png</span>'));
  assert.ok(html.includes('src="asset://img/cat.jpg" alt="alt"'));
  assert.ok(html.includes('<div class="md-callout" data-kind="tip"><div class="md-callout-t">Nice</div><p>inside <strong>it</strong></p></div>'));
  assert.ok(html.includes('<blockquote class="md-q"><p>plain quote</p></blockquote>'));
  assert.ok(html.includes('<th style="text-align:left">a</th><th style="text-align:right">b</th>'));
  assert.ok(html.includes('<td style="text-align:left">1</td>'));
  assert.ok(html.includes('<pre class="md-pre" data-lang="js"><code>let a = [[x]] #no</code></pre>'));
  assert.ok(html.includes('<hr class="md-hr">'));
  assert.ok(!html.includes("hidden"));
  // callout aliases fold into the kinds the stylesheet knows
  assert.ok(M.mdToHtml("> [!faq]- Why\n> because").includes('data-kind="question"><div class="md-callout-t">Why</div>'));
});

test("mdToHtml: huge notes are clipped", () => {
  const big = "word ".repeat(30000);
  const html = M.mdToHtml(big + "\n" + big, { maxChars: 1000 });
  assert.ok(html.length < 5000);
  assert.ok(html.includes("md-more"));
});

test("mdToHtml: a picture on the web waits for a click unless allowed", () => {
  const md = "![a](https://track.example/p.gif) and ![[https://x.org/i.png]]";
  const opts = { resolve: () => null, image: (t) => t };
  const held = M.mdToHtml(md, opts);
  assert.ok(!held.includes("<img"), held);
  assert.ok(held.includes('<button class="md-img-load" data-src="https://track.example/p.gif"'), held);
  assert.ok(held.includes("Load picture from track.example"), held);
  assert.ok(M.mdToHtml(md, { ...opts, webPictures: true }).includes('<img class="md-img" src="https://track.example/p.gif"'));
});

test("mdToHtml: the vault's own pictures (asset.localhost) are never held as web pictures", () => {
  const html = M.mdToHtml("![a](http://asset.localhost/E%3A/v/pic.webp)", { resolve: () => null, image: (t) => t });
  assert.ok(html.includes('<img class="md-img" src="http://asset.localhost/'), html);
});

test("allowedPicture: a group's web background waits for the setting, the vault's own loads", async () => {
  const { allowedPicture: p } = await import("../board.js");
  assert.equal(p("https://evil.example/b.png", "click"), null);
  assert.equal(p("https://evil.example/b.png", undefined), null);
  assert.equal(p("https://evil.example/b.png", "always"), "https://evil.example/b.png");
  assert.equal(p("http://asset.localhost/E%3A/v/a.webp", "click"), "http://asset.localhost/E%3A/v/a.webp");
  assert.equal(p(null, "click"), null);
});

test("cssUrl: control characters stay themselves, so a broken address cannot turn into a working one", async () => {
  const { cssUrl } = await import("../board.js");
  assert.equal(cssUrl("https://evil\ff0ecom/b.png"), 'url("https://evil\\c f0ecom/b.png")');
  assert.equal(cssUrl('http://asset.localhost/a"\\b.png'), 'url("http://asset.localhost/a\\22 \\5c b.png")');
  assert.equal(cssUrl("http://asset.localhost/a.png"), 'url("http://asset.localhost/a.png")');
});

test("isWebPicture reads addresses as the browser does", async () => {
  const { isWebPicture: w } = await import("../mdparse.js");
  for (const u of ["https://x.org/a.png", " https://x.org/a.png", "https:\\\\x.org\\a.png", "HTTP://X.ORG/a", "https://localhost.evil.com/a", "http://localhost:5194/a", "http://localhost/a", "http://other.localhost/a", "http://asset.localhost:9000/a", "https://a@x.org/", "//x.org/a.png", "\\\\x.org\\a.png", "\u0001https://x.org/a"]) assert.ok(w(u), u);
  for (const u of ["http://asset.localhost/E%3A/v/a.webp", "http://heic.localhost/?p=a.heic", "http://asset.localhost./E%3A/a", "pic.png", "img/a.png", "data:image/png;base64,AA", "asset://localhost/a"]) assert.ok(!w(u), u);
});
