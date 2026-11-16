// Graph logic: node --test web/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  graphSettings, GRAPH_DEFAULTS, makeResolver, buildGraph, bfs, neighbourhood, shortestPath, shortestPaths,
  scoreNode, searchNodes, matchQuery, groupKey, assignGroups, createLayout, exactRepulsion, createHitGrid,
  boardPlacement, csr, components, folderCategory, mergeFolderRules, readGraphDoc, writeGraphDoc, frameAround, searchFrames, cleanFrame,
  classifyEdges, crossMask, poolExtent, homeCore, clusterPoints, adoptHome, CROSS_HOME, CROSS_GROUP, CORE_WEIGHT, BRIDGE_PULL,
  buildRelations, relatedNodes, mentionedNodes, addLinkLine, titleKey,
} from "../graphcore.js";
import { parseNote } from "../mdparse.js";
import { basename, dirname } from "../util.js";

// A tiny vault with the same resolution rules as vault.js
function vault(files, attachments = []) {
  const notes = new Map();
  for (const [path, content] of Object.entries(files)) {
    const m = parseNote(content);
    notes.set(path, { path, title: basename(path), folder: dirname(path), content, links: m.links, tags: m.tags });
  }
  const byName = (target, from) => {
    const t = target.trim().replace(/\.md$/i, "").toLowerCase();
    const hits = [...notes.keys()].filter((p) => basename(p).toLowerCase() === t);
    if (hits.length <= 1) return hits[0] || null;
    return hits.find((p) => dirname(p) === dirname(from || "")) || hits.sort((a, b) => a.length - b.length)[0];
  };
  const files2 = new Map(attachments.map((p) => [p, { path: p, kind: "image" }]));
  const resolveFile = (t) => files2.get(t) || [...files2.values()].find((f) => f.path.endsWith("/" + t)) || null;
  return { notes: [...notes.values()], resolve: makeResolver(notes.keys(), byName), resolveFile };
}

const V = vault({
  "A.md": "[[B]] [[C]] #alpha",
  "B.md": "[[A]] [[D]] ![[pic.png]] #alpha/sub",
  "C.md": "[[Deep/E]] [[Nowhere]] #beta",
  "D.md": "[[B]]",
  "Deep/E.md": "[[F]]",
  "Deep/F.md": "leaf #beta",
  "Lonely.md": "nothing links here",
}, ["img/pic.png"]);

const ids = (g) => g.nodes.map((n) => n.id).sort();

test("graphSettings: defaults, clamping, junk", () => {
  const s = graphSettings({ depth: 9, scope: "nope", repel: "x", rules: [{ q: "tag:a", color: "red" }, null], exclude: ["A", 3], open: { forces: true } });
  assert.equal(s.depth, 5);
  assert.equal(s.scope, "all");
  assert.equal(s.repel, GRAPH_DEFAULTS.repel);
  assert.deepEqual(s.rules, [{ q: "tag:a", color: "#5b9cf6" }]);
  assert.deepEqual(s.exclude, ["A"]);
  assert.equal(s.open.forces, true);
  assert.equal(s.open.scope, true);
  assert.deepEqual(graphSettings(null), { ...GRAPH_DEFAULTS, open: { ...GRAPH_DEFAULTS.open } });
});

test("makeResolver matches vault.resolve rules", () => {
  const r = makeResolver(["x/Deep/E.md", "Deep/E.md", "b/Note.md"], () => "byname");
  assert.equal(r("Deep/E"), "x/Deep/E.md"); // first in order wins, like the linear scan
  assert.equal(r("x/deep/e.md"), "x/Deep/E.md");
  assert.equal(r("/Deep/E"), "x/Deep/E.md");
  assert.equal(r("eep/E"), null); // suffixes only at a folder boundary
  assert.equal(r("Note", "b/x.md"), "byname");
  assert.equal(r("  "), null);
});

test("buildGraph: all notes, dedupe, both-way pairs, counts", () => {
  const g = buildGraph(V, {});
  assert.deepEqual(ids(g), ["A.md", "B.md", "C.md", "D.md", "Deep/E.md", "Deep/F.md", "Lonely.md"]);
  assert.equal(g.stats.links, 5); // A-B, A-C, B-D, C-E, E-F
  const ab = [...g.src].findIndex((s, e) => g.nodes[s].id === "A.md" && g.nodes[g.dst[e]].id === "B.md");
  assert.ok(ab >= 0);
  assert.equal(g.both[ab], 1);
  const B = g.nodes[g.index.get("B.md")];
  assert.equal(B.out, 2);
  assert.equal(B.inn, 2);
  assert.equal(B.deg, 2);
});

test("buildGraph: orphans, attachments, tags, unresolved", () => {
  assert.ok(!ids(buildGraph(V, { orphans: false })).includes("Lonely.md"));
  const g = buildGraph(V, { attachments: true, tagNodes: true, unresolved: true });
  const got = ids(g);
  for (const id of ["img/pic.png", "tag:alpha", "tag:alpha/sub", "tag:beta", "ghost:nowhere"]) assert.ok(got.includes(id), id);
  assert.equal(g.nodes[g.index.get("img/pic.png")].kind, "file");
  assert.equal(g.nodes[g.index.get("ghost:nowhere")].kind, "ghost");
  assert.equal(g.nodes[g.index.get("tag:beta")].deg, 2);
});

test("buildGraph: markdown links to attachments count too", () => {
  const v = vault({ "N.md": "see ![x](img/pic.png) and [site](https://x.y)" }, ["img/pic.png"]);
  const g = buildGraph(v, { attachments: true });
  assert.deepEqual(ids(g), ["N.md", "img/pic.png"]);
});

test("buildGraph: scopes", () => {
  const around1 = buildGraph(V, { scope: "around", focus: "A.md", depth: 1 });
  assert.deepEqual(ids(around1), ["A.md", "B.md", "C.md"]);
  assert.equal(around1.nodes[around1.focus].id, "A.md");
  const around2 = buildGraph(V, { scope: "around", focus: "A.md", depth: 2 });
  assert.deepEqual(ids(around2), ["A.md", "B.md", "C.md", "D.md", "Deep/E.md"]);
  assert.equal(around2.nodes[around2.index.get("Deep/E.md")].dist, 2);
  // tags are destinations, never bridges
  const viaTag = buildGraph(V, { scope: "around", focus: "D.md", depth: 2, tagNodes: true });
  assert.ok(!ids(viaTag).includes("Deep/F.md"));
  assert.ok(ids(viaTag).includes("tag:alpha/sub"));
  // a lonely focus is still shown even with orphans off
  assert.deepEqual(ids(buildGraph(V, { scope: "around", focus: "Lonely.md", depth: 3, orphans: false })), ["Lonely.md"]);
  assert.deepEqual(ids(buildGraph(V, { scope: "folder", folder: "Deep" })), ["Deep/E.md", "Deep/F.md"]);
  assert.deepEqual(ids(buildGraph(V, { scope: "tag", tag: "alpha" })), ["A.md", "B.md"]);
  assert.deepEqual(ids(buildGraph(V, { scope: "around", focus: "missing.md" })), []);
});

test("buildGraph: exclude, hidden, only", () => {
  assert.ok(!ids(buildGraph(V, { exclude: ["Deep"] })).some((x) => x.startsWith("Deep/")));
  const hid = buildGraph(V, { hidden: new Set(["B.md"]), orphans: false });
  assert.ok(!ids(hid).includes("B.md"));
  assert.ok(!ids(hid).includes("D.md")); // D only linked to B, and orphans are off
  assert.deepEqual(ids(buildGraph(V, { only: new Set(["A.md", "B.md", "Lonely.md"]) })), ["A.md", "B.md", "Lonely.md"]);
});

test("bfs, neighbourhood, shortest path", () => {
  // 0-1-2-3, 0-4-3 and a detached 5
  const g = csr(6, [0, 1, 2, 0, 4], [1, 2, 3, 4, 3]);
  assert.deepEqual([...bfs(g, 0)], [0, 1, 2, 2, 1, -1]);
  assert.deepEqual([...bfs(g, 0, 1)], [0, 1, -1, -1, 1, -1]);
  assert.deepEqual([...neighbourhood(g, 1, 1)].sort(), [0, 1, 2]);
  assert.deepEqual(shortestPath(g, 0, 3), [0, 4, 3]);
  assert.deepEqual(shortestPath(g, 3, 0), [3, 4, 0]); // links are undirected
  assert.equal(shortestPath(g, 0, 5), null);
  assert.deepEqual(shortestPath(g, 2, 2), [2]);
  // a blocked bridge forces the long way round
  assert.deepEqual(shortestPath(g, 0, 3, (i) => i !== 4), [0, 1, 2, 3]);
});

test("components: islands and their sizes", () => {
  const { comp, size } = components(csr(6, [0, 1, 3], [1, 2, 4]));
  assert.equal(comp[0], comp[2]);
  assert.equal(comp[3], comp[4]);
  assert.notEqual(comp[0], comp[3]);
  assert.deepEqual([size[comp[0]], size[comp[3]], size[comp[5]]], [3, 2, 1]);
  assert.equal(size.length, 3);
});

test("shortestPaths: every shortest route, layered, counted", () => {
  // diamond 0-{1,2}-3 plus a long way 0-4-5-3
  const g = csr(6, [0, 0, 1, 2, 0, 4, 5], [1, 2, 3, 3, 4, 5, 3]);
  const r = shortestPaths(g, 0, 3);
  assert.equal(r.length, 2);
  assert.equal(r.paths, 2);
  assert.deepEqual(r.layers.map((l) => l.sort()), [[0], [1, 2], [3]]);
  assert.deepEqual([...r.nodes], [1, 1, 1, 1, 0, 0]);
  assert.deepEqual([...r.edges], [1, 1, 1, 1, 0, 0, 0]);
  assert.equal(shortestPaths(csr(2, [], []), 0, 1), null);
});

test("search scoring: title beats path beats tag; #tag queries", () => {
  const n = (label, path, tags = []) => ({ id: path, kind: "note", label, path, tags });
  const title = n("Roadmap", "x/Roadmap.md");
  const inPath = n("Plan", "roadmap/Plan.md");
  const tagged = n("Other", "Other.md", ["roadmap"]);
  assert.ok(scoreNode("roadmap", title) > scoreNode("roadmap", inPath));
  assert.ok(scoreNode("roadmap", inPath) > scoreNode("roadmap", tagged));
  assert.equal(scoreNode("zzz", title), null);
  assert.equal(scoreNode("", title), null);
  assert.ok(scoreNode("#road", tagged) !== null);
  assert.equal(scoreNode("#road", title), null);
  assert.ok(scoreNode("#ro", { id: "tag:roadmap", kind: "tag", label: "#roadmap", path: "", tags: [] }) !== null);
  assert.deepEqual(searchNodes("roadmap", [tagged, inPath, title]), [2, 1, 0]);
  assert.deepEqual(searchNodes("roadmap", [tagged, inPath, title], Uint8Array.of(1, 0, 1)), [2, 0]);
});

test("matchQuery: fields, negation, phrases", () => {
  const node = { id: "Projects/Big plan.md", kind: "note", label: "Big plan", path: "Projects/Big plan.md", folder: "Projects", tags: ["work/q3", "ideas"] };
  assert.ok(matchQuery("path:projects", node));
  assert.ok(matchQuery("folder:proj", node));
  assert.ok(matchQuery("tag:work", node));
  assert.ok(matchQuery("#ideas", node));
  assert.ok(!matchQuery("#wor", node)); // nested tags match by whole segment
  assert.ok(matchQuery("\"big plan\" -tag:archive", node));
  assert.ok(!matchQuery("-path:projects", node));
  assert.ok(matchQuery("file:big kind:note", node));
  assert.ok(!matchQuery("", node));
});

test("groups: folder / tag / rules, stable colours, kinds", () => {
  const mk = (path, tags = [], kind = "note") => ({ id: path, kind, label: basename(path), path: kind === "note" ? path : "", tags });
  const nodes = [mk("A/1.md", ["x"]), mk("A/2.md"), mk("B/3.md", ["y", "x"]), mk("root.md"), mk("tag:x", [], "tag")];
  assert.equal(groupKey(nodes[0], "folder"), "folder:A");
  assert.equal(groupKey(nodes[3], "folder"), "folder:");
  assert.equal(groupKey(nodes[2], "tag"), "tag:y");
  assert.equal(groupKey(nodes[4], "folder"), "kind:tag");
  const f = assignGroups(nodes, { colorBy: "folder" });
  assert.deepEqual(f.groups.map((g) => g.key), ["folder:A", "folder:B", "folder:", "kind:tag"]);
  assert.equal(f.groups[0].count, 2);
  assert.equal(f.groups[f.groupOf[0]].key, "folder:A");
  assert.ok(f.groups[0].color && f.groups[1].color && f.groups[0].color !== f.groups[1].color);
  assert.equal(f.groups[2].color, null); // vault root stays neutral
  // a folder keeps its colour when other folders come and go
  const again = assignGroups([nodes[0]], { colorBy: "folder" });
  assert.equal(again.groups[0].color, f.groups[0].color);
  const r = assignGroups(nodes, { colorBy: "rules", rules: [{ q: "tag:x", color: "#ff0000" }, { q: "path:B", color: "#00ff00" }] });
  assert.equal(r.groups[r.groupOf[2]].color, "#ff0000"); // the first matching rule wins
  assert.equal(r.groups[r.groupOf[1]].key, "none");
  assert.deepEqual(r.groups.map((g) => g.label), ["tag:x", "Other notes", "Tags"]);
});

test("folder categories: depth, split, own, longest rule wins", () => {
  assert.equal(folderCategory(""), "");
  assert.equal(folderCategory("A/B/C"), "A");
  assert.equal(folderCategory("A/B/C", { depth: 2 }), "A/B");
  assert.equal(folderCategory("A", { depth: 3 }), "A");
  // split: direct subfolders become categories, the folder's own notes stay
  const sp = { split: ["A"] };
  assert.equal(folderCategory("A", sp), "A");
  assert.equal(folderCategory("A/B", sp), "A/B");
  assert.equal(folderCategory("A/B/C", sp), "A/B");
  assert.equal(folderCategory("Ab/B", sp), "Ab"); // a prefix is not a parent
  // recursive splitting
  assert.equal(folderCategory("A/B/C/D", { split: ["A", "A/B"] }), "A/B/C");
  // own beats depth, a deeper split beats own, a deeper own beats a split
  assert.equal(folderCategory("A/B/C", { depth: 3, own: ["A"] }), "A");
  assert.equal(folderCategory("A/B/C", { own: ["A"], split: ["A/B"] }), "A/B/C");
  assert.equal(folderCategory("A/B/C/D", { split: ["A"], own: ["A/B/C"] }), "A/B/C");
  assert.equal(folderCategory("A/B/C", { split: ["A"], own: ["A"] }), "A/B"); // same folder: split wins
  // groupKey honours the rules; notes carry their folder
  const nd = { id: "A/B/n.md", kind: "note", label: "n", path: "A/B/n.md", folder: "A/B", tags: [] };
  assert.equal(groupKey(nd, "folder"), "folder:A");
  assert.equal(groupKey(nd, "folder", [], { depth: 1, split: ["A"], own: [] }), "folder:A/B");
  assert.equal(groupKey(nd, "folder", [], { depth: 2, split: [], own: [] }), "folder:A/B");
  const g = assignGroups([nd, { ...nd, id: "A/x.md", path: "A/x.md", folder: "A" }], { colorBy: "folder", folders: { depth: 1, split: ["A"], own: [] } });
  assert.deepEqual(g.groups.map((x) => x.key).sort(), ["folder:A", "folder:A/B"]);
  // settings sanitise the lists
  const s = graphSettings({ splitFolders: ["A/", 3, "", "A"], ownFolders: "x", folderDepth: 9, showLegend: 0 });
  assert.deepEqual(s.splitFolders, ["A"]);
  assert.deepEqual(s.ownFolders, []);
  assert.equal(s.folderDepth, 4);
  assert.equal(s.showLegend, false);
  assert.equal(graphSettings({}).showLegend, true);
});

test("folder categories: merging back into the parent", () => {
  // undo a split
  assert.deepEqual(mergeFolderRules("A/B", { split: ["A", "A/B"], own: ["A/B/C"] }), { split: [], own: [] });
  // depth put it there: the parent becomes one category
  assert.deepEqual(mergeFolderRules("A/B", { depth: 2, split: [], own: [] }), { split: [], own: ["A"] });
  // an own rule on it
  assert.deepEqual(mergeFolderRules("A/B", { own: ["A/B"], split: [] }), { split: [], own: [] });
  const r = mergeFolderRules("A/B/C", { split: ["A", "A/B"], own: [] });
  assert.equal(folderCategory("A/B/C", r), "A/B");
});

test("graph.json: read junk safely, write rounded, drop the dead, cap", () => {
  const d = readGraphDoc({ pos: { a: [1.4, 2.6], b: "x", c: [NaN, 1], d: [3, 4] }, pins: ["a", "zz", 5], frames: [{ id: "f1", x: 1.2, w: 5, c: 11, title: 7 }, null, { id: "f1" }], cam: { x: 1, y: 2, k: 0 } });
  assert.deepEqual([...d.pos.keys()], ["a", "d"]);
  assert.deepEqual(d.pins, ["a"]);
  assert.equal(d.frames.length, 1);
  assert.deepEqual(d.frames[0], { id: "f1", x: 1, y: 0, w: 80, h: 200, title: "7", note: "", c: 3 });
  assert.equal(d.cam, null);
  assert.deepEqual(readGraphDoc(null).frames, []);
  const out = writeGraphDoc({ pos: d.pos, pins: new Set(["a", "d"]), frames: d.frames, cam: { x: 1.26, y: 2, k: 0.123456 } }, (id) => id !== "d");
  assert.deepEqual(out.pos, { a: [1, 3] });
  assert.deepEqual(out.pins, ["a"]);
  assert.deepEqual(out.cam, { x: 1, y: 2, k: 0.1235 });
  // over the cap, the ids on screen come first
  const many = new Map(Array.from({ length: 10 }, (_, i) => ["n" + i, { x: i, y: i }]));
  const capped = writeGraphDoc({ pos: many, pins: [], frames: [] }, () => true, ["n9", "n8"], 3);
  assert.deepEqual(Object.keys(capped.pos), ["n9", "n8", "n0"]);
  // round trip
  assert.deepEqual([...readGraphDoc(JSON.parse(JSON.stringify(out))).pos], [["a", { x: 1, y: 3 }]]);
});

test("comment frames: fit round nodes, search by title", () => {
  const f = frameAround([{ x: 0, y: 0, r: 5 }, { x: 100, y: 50, r: 5 }], 20);
  assert.ok(f.x <= -25 && f.y < -25 && f.x + f.w >= 125 && f.y + f.h >= 75);
  assert.equal(frameAround([]), null);
  const frames = [cleanFrame({ id: "a", title: "Literature review" }), cleanFrame({ id: "b", title: "Ideas", note: "loose threads" })];
  assert.deepEqual(searchFrames("lit", frames).map((x) => x.id), ["a"]);
  assert.deepEqual(searchFrames("threads", frames).map((x) => x.id), ["b"]);
  assert.deepEqual(searchFrames("#x", frames), []);
});

test("layout: Barnes-Hut repulsion matches the exact sum", () => {
  const L = createLayout();
  const n = 300;
  L.resize(n, 0);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) { L.x[i] = rnd() * 800 - 400; L.y[i] = rnd() * 800 - 400; L.charge[i] = 1 + (i % 3); L.vx[i] = 0; L.vy[i] = 0; L.ring[i] = -1; }
  const x = L.x.slice(0, n), y = L.y.slice(0, n);
  const ref = exactRepulsion(x, y, L.charge, n, 1, 1);
  L.step(1, { repel: 1, linkDistance: 60, gravity: 0, theta: 0.5 });
  let err = 0, mag = 0;
  for (let i = 0; i < n; i++) {
    // the step damps velocity by 0.6 and moves each node by it
    err += Math.hypot(L.vx[i] / 0.6 - ref.ax[i], L.vy[i] / 0.6 - ref.ay[i]);
    mag += Math.hypot(ref.ax[i], ref.ay[i]);
    assert.ok(Math.abs(L.x[i] - x[i] - L.vx[i]) < 1e-9);
  }
  assert.ok(err / mag < 0.03, `relative error ${err / mag}`);
  assert.ok(L.cells() > n);
});

test("layout: springs pull to rest length, fixed nodes stay, coincident nodes separate", () => {
  const L = createLayout();
  L.resize(3, 1);
  L.x.set([0, 300, 0]); L.y.set([0, 0, 0]);
  L.vx.fill(0); L.vy.fill(0); L.charge.fill(1); L.ring.fill(-1);
  L.fixed.set([1, 0, 0]);
  L.setLinks([0], [1], [1, 1, 0]);
  let alpha = 1;
  for (let i = 0; i < 400; i++) { L.step(alpha, { repel: 0.2, linkDistance: 80, gravity: 0 }); alpha *= 0.98; }
  assert.equal(L.x[0], 0);
  assert.equal(L.y[0], 0);
  const d = Math.hypot(L.x[1], L.y[1]);
  assert.ok(d > 60 && d < 140, `rest ${d}`);
  // node 2 started on top of node 0 and was pushed off
  assert.ok(Math.hypot(L.x[2], L.y[2]) > 5);
  for (let i = 0; i < 3; i++) assert.ok(Number.isFinite(L.x[i]) && Number.isFinite(L.y[i]));
});

test("layout: radial rings and growth keep positions", () => {
  const L = createLayout();
  L.resize(2, 0);
  L.x.set([0, 10]); L.y.set([0, 0]); L.vx.fill(0); L.vy.fill(0); L.charge.fill(1);
  L.fixed.set([1, 0]); L.ring.set([-1, 200]);
  let alpha = 1;
  for (let i = 0; i < 300; i++) { L.step(alpha, { repel: 0.01, gravity: 0, radial: 0.8 }); alpha *= 0.985; }
  assert.ok(Math.abs(Math.hypot(L.x[1], L.y[1]) - 200) < 20);
  const before = L.x[1];
  L.resize(500, 10);
  assert.equal(L.x[1], before);
});

test("hit grid: nearest disc and rectangle", () => {
  const G = createHitGrid();
  const x = Float64Array.of(0, 100, 105, -300);
  const y = Float64Array.of(0, 0, 0, 50);
  const r = Float64Array.of(5, 4, 4, 20);
  G.build(x, y, 4, 40);
  assert.equal(G.nearest(1, 1, r, 20, 2), 0);
  assert.equal(G.nearest(104, 0, r, 20, 0), 2);
  assert.equal(G.nearest(50, 0, r, 20, 2), -1);
  assert.equal(G.nearest(-315, 50, r, 20, 0), 3);
  assert.equal(G.nearest(104, 0, r, 20, 0, Uint8Array.of(1, 1, 0, 1)), 1);
  assert.deepEqual(G.rect(-10, -10, 101, 10), [0, 1]);
  assert.deepEqual(G.rect(101, 10, -10, -10), [0, 1]);
});

test("boardPlacement: scaled round the centre, cards never overlap", () => {
  const out = boardPlacement([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 10, y: 10 }, { x: 200, y: 200 }]);
  assert.equal(out.length, 4);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      assert.ok(Math.abs(a.x - b.x) >= 439 || Math.abs(a.y - b.y) >= 339, `${i}/${j} overlap`);
    }
  }
  // far-apart points just scale
  assert.deepEqual(boardPlacement([{ x: -500, y: 0 }, { x: 500, y: 0 }]), [{ x: -1500, y: 0 }, { x: 1500, y: 0 }]);
  assert.deepEqual(boardPlacement([]), []);
});

test("buildGraph handles 3,000 notes / 10,000 links (no timing: machines differ)", () => {
  const files = {};
  let s = 3;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 3000; i++) {
    const links = [];
    for (let k = 0; k < 3; k++) links.push(`[[${i % 4 ? "" : "F" + (i % 7) + "/"}N${Math.floor(rnd() * 3000)}]]`);
    files[`F${i % 7}/N${i}.md`] = links.join(" ") + (i % 5 ? "" : " #t" + (i % 11));
  }
  const v = vault(files);
  const g = buildGraph(v, { tagNodes: true, unresolved: true });
  assert.ok(g.nodes.length >= 3000);
  assert.ok(g.stats.links > 8000);
  const L = createLayout();
  L.resize(g.nodes.length, g.src.length);
  for (let i = 0; i < g.nodes.length; i++) { L.x[i] = Math.cos(i) * 10 * Math.sqrt(i); L.y[i] = Math.sin(i) * 10 * Math.sqrt(i); L.charge[i] = 1; L.ring[i] = -1; }
  L.setLinks(g.src, g.dst, g.nodes.map((n) => n.deg));
  for (let i = 0; i < 10; i++) L.step(0.5, { repel: 1, linkDistance: 60, gravity: 1 });
  assert.ok(Number.isFinite(L.x[0]) && Number.isFinite(L.y[g.nodes.length - 1]), "every node has a place");
});

test("graphSettings: link and home keys", () => {
  const s = graphSettings({ linkStyle: "zigzag", crossBy: "x", homePull: 99, crossLinks: 0, hideInner: "yes", open: { homes: false } });
  assert.equal(s.linkStyle, "line");
  // the old "curve" style is a line, bowed
  assert.deepEqual([graphSettings({ linkStyle: "curve", bridgeCurve: false }).linkStyle, graphSettings({ linkStyle: "curve", bridgeCurve: false }).bridgeCurve], ["line", true]);
  assert.equal(s.crossBy, "homes");
  assert.equal(s.homePull, 4);
  assert.equal(s.crossLinks, false);
  assert.equal(s.hideInner, true);
  assert.equal(s.open.homes, false);
  assert.equal(graphSettings({ linkStyle: "gradient", crossBy: "both" }).linkStyle, "gradient");
  assert.equal(graphSettings({}).bridgesOnly, false);
});

test("bridges: links classified by home and by group", () => {
  // 0,1 in home 0; 2 in the pool; 3 in home 1; 4 a tag node in the pool
  const home = Int32Array.from([0, 0, -1, 1, -1]);
  const group = Int32Array.from([0, 1, 0, 0, 2]);
  const isNote = Uint8Array.from([1, 1, 1, 1, 0]);
  const src = [0, 0, 1, 2, 2];
  const dst = [1, 2, 3, 3, 4];
  const out = new Uint8Array(5);
  assert.equal(classifyEdges(src, dst, 5, home, group, isNote, out), 4);
  assert.deepEqual([...out], [CROSS_GROUP, CROSS_HOME, CROSS_HOME | CROSS_GROUP, CROSS_HOME, 0]);
  // no groups: only homes count
  classifyEdges(src, dst, 5, home, null, isNote, out);
  assert.deepEqual([...out], [0, 1, 1, 1, 0]);
  assert.equal(crossMask("homes"), CROSS_HOME);
  assert.equal(crossMask("groups"), CROSS_GROUP);
  assert.equal(crossMask("both"), CROSS_HOME | CROSS_GROUP);
});

test("homes: pool extent ignores strays, core, clusters, adoption", () => {
  const n = 400;
  const x = new Float64Array(n + 5), y = new Float64Array(n + 5);
  for (let i = 0; i < n; i++) { const r = 300 * Math.sqrt((i + 0.5) / n), a = i * 2.399963; x[i] = 50 + Math.cos(a) * r; y[i] = Math.sin(a) * r; }
  for (let i = n; i < n + 5; i++) { x[i] = 5000; y[i] = 5000; }
  const p = poolExtent(x, y, n + 5, null);
  assert.ok(Math.abs(p.r - 300) < 60, `r ${p.r}`);
  const skip = new Uint8Array(n + 5).fill(1, n);
  const q = poolExtent(x, y, n + 5, skip);
  assert.ok(Math.abs(q.cx - 50) < 5 && Math.abs(q.cy) < 5 && Math.abs(q.r - 300) < 20, JSON.stringify(q));
  assert.equal(poolExtent(x, y, 0, null).count, 0);
  assert.equal(homeCore([3, 1, 2], [0, 5, 5, 1]), 1);
  assert.equal(homeCore([], []), -1);
  const lab = clusterPoints([0, 10, 20, 500, 510, 2000], [0, 0, 0, 0, 5, 0], 30);
  assert.deepEqual([...lab], [0, 0, 0, 1, 1, 2]);
  const hm = { a: "h1", b: "h1", c: "h2" };
  assert.equal(adoptHome(["a", "b"], (j) => hm[j] || null), "h1");
  assert.equal(adoptHome(["a", "c"], (j) => hm[j] || null), null);
  assert.equal(adoptHome(["a", "z"], (j) => hm[j] || null), null);
  assert.equal(adoptHome([], (j) => hm[j] || null), null);
});

test("graph.json: homes round trip, junk and empty homes dropped", () => {
  const d = readGraphDoc({
    pos: { a: [0, 0], b: [1, 1], c: [2, 2] },
    homes: [{ id: "h1", x: 10.4, y: "x", name: 5 }, { id: "h1" }, { id: "h2", x: 1, y: 1 }, null],
    home: { a: "h1", b: "nope", c: "h1", z: "h1" },
  });
  assert.deepEqual([...d.homes.values()], [{ id: "h1", x: 10, y: 0, name: "5" }]);
  assert.deepEqual([...d.homeOf], [["a", "h1"], ["c", "h1"], ["z", "h1"]]);
  const out = writeGraphDoc({ pos: d.pos, pins: [], frames: [], cam: null, homes: d.homes, homeOf: d.homeOf }, (id) => id !== "c");
  assert.deepEqual(out.home, { a: "h1" });
  assert.deepEqual(out.homes, [{ id: "h1", x: 10, y: 0, name: "5" }]);
  // the last member gone takes the home with it
  const gone = writeGraphDoc({ pos: d.pos, pins: [], frames: [], homes: d.homes, homeOf: d.homeOf }, (id) => id === "b");
  assert.deepEqual(gone.homes, []);
  const back = readGraphDoc(JSON.parse(JSON.stringify(out)));
  assert.equal(back.homeOf.get("a"), "h1");
  assert.deepEqual(readGraphDoc({}).homes.size, 0);
});

test("layout: a home holds its cluster round its core, away from the pool", () => {
  // a pool of 300 loose notes round the origin, a 12-note star far off with
  // one link back into the pool
  const P = 300, C = 12, n = P + C;
  const L = createLayout();
  const src = [], dst = [];
  for (let k = 1; k < C; k++) { src.push(P); dst.push(P + k); }
  src.push(P + 3); dst.push(0);
  L.resize(n, src.length);
  for (let i = 0; i < P; i++) { const r = 12 * Math.sqrt(i + 0.5), a = i * 2.399963; L.x[i] = Math.cos(a) * r; L.y[i] = Math.sin(a) * r; }
  for (let k = 0; k < C; k++) { L.x[P + k] = 250 + k * 7; L.y[P + k] = 30 - k * 5; }
  L.vx.fill(0); L.vy.fill(0); L.charge.fill(1); L.ring.fill(-1); L.fixed.fill(0); L.pull.fill(1);
  const deg = new Int32Array(n);
  for (let e = 0; e < src.length; e++) { deg[src[e]]++; deg[dst[e]]++; }
  L.setLinks(src, dst, deg);
  L.setHomes(1);
  L.hx[0] = 900; L.hy[0] = -600;
  for (let k = 0; k < C; k++) L.home[P + k] = 0;
  L.hw[P] = CORE_WEIGHT;
  L.lstr[src.length - 1] *= BRIDGE_PULL;
  let alpha = 1;
  for (let t = 0; t < 500; t++) { L.step(alpha, { repel: 1, linkDistance: 60, gravity: 1, homeRange: 420 }); alpha += (0 - alpha) * 0.0228; }
  let cx = 0, cy = 0, far = 0;
  for (let k = 0; k < C; k++) { cx += L.x[P + k]; cy += L.y[P + k]; }
  cx /= C; cy /= C;
  assert.ok(Math.hypot(cx - 900, cy + 600) < 40, `centroid ${cx},${cy}`);
  const dCore = Math.hypot(L.x[P] - 900, L.y[P] + 600);
  for (let k = 1; k < C; k++) far = Math.max(far, Math.hypot(L.x[P + k] - 900, L.y[P + k] + 600));
  assert.ok(dCore < 25, `core ${dCore}`);
  assert.ok(far > dCore && far < 200, `spread ${far}`);
  // the pool stays round the origin, its linked note not dragged out
  const pe = poolExtent(L.x, L.y, P, null);
  assert.ok(Math.hypot(pe.cx, pe.cy) < 60, `pool ${pe.cx},${pe.cy}`);
  assert.ok(Math.hypot(L.x[0], L.y[0]) < pe.r * 1.3, `bridge end ${L.x[0]},${L.y[0]}`);
  // with no homes set the step ignores the home arrays
  L.setHomes(0);
  assert.equal(L.hk, 0);
});

/* ── reading lens: correlation and the link it writes ───────────────────── */

test("graphSettings: lens values are sanitised", () => {
  const s = graphSettings({ lens: 1, lensCards: 99, lensHints: 0 });
  assert.equal(s.lens, true);
  assert.equal(s.lensCards, 12);
  assert.equal(s.lensHints, false);
  assert.equal(graphSettings({ lensCards: "x" }).lensCards, GRAPH_DEFAULTS.lensCards);
  assert.equal(graphSettings({ lensCards: 0.2 }).lensCards, 2);
});

const LV = vault({
  "Sleep.md": "# Sleep\n[[Caffeine]]\n#health #research",
  "Caffeine.md": "About coffee #health",
  "Naps.md": "Short rest #health #research",
  "Melatonin.md": "[[Caffeine]] and light",
  "Dreams.md": "A long note that talks about Melatonin at some length.",
  "Unrelated.md": "nothing to do with any of it",
});

test("buildRelations + relatedNodes: tags, common neighbours, names in the text", () => {
  const g = buildGraph(LV, { orphans: true });
  const rel = buildRelations(g);
  const at = (id) => g.index.get(id);
  const names = (list) => list.map((e) => g.nodes[e.i].id);

  // Sleep shares two tags with Naps and one with Caffeine (already linked)
  const s = relatedNodes(rel, at("Sleep.md"), { text: LV.notes.find((x) => x.path === "Sleep.md").content });
  assert.ok(names(s).includes("Naps.md"));
  assert.ok(!names(s).includes("Caffeine.md"), "already linked notes never show up");
  assert.ok(!names(s).includes("Sleep.md"), "never itself");
  assert.ok(!names(s).includes("Unrelated.md"));

  // Sleep and Melatonin both link Caffeine: one common neighbour, which on
  // its own scores under the default bar and only shows with a lower one
  assert.ok(!names(s).includes("Melatonin.md"), "a single common neighbour is too weak by default");
  const m = relatedNodes(rel, at("Sleep.md"), { text: "", min: 1 }).find((e) => g.nodes[e.i].id === "Melatonin.md");
  assert.ok(m && m.hops === 1, "common neighbour counted");
  const naps = s.find((e) => g.nodes[e.i].id === "Naps.md");
  assert.equal(naps.tags, 2);
  assert.ok(naps.score > m.score, "two shared tags beat one common neighbour");
  assert.match(naps.why, /2 shared tags/);

  // a title named in the text is the strongest signal of the three
  const d = relatedNodes(rel, at("Dreams.md"), { text: "A long note that talks about Melatonin at some length." });
  assert.equal(g.nodes[d[0].i].id, "Melatonin.md");
  assert.equal(d[0].mention, 1);
  assert.equal(d[0].score, 3);
  assert.match(d[0].why, /named in the text/);

  // titles are matched on words, so punctuation and case do not matter
  assert.deepEqual([...mentionedNodes("see (melatonin)!", rel)].map((i) => g.nodes[i].id), ["Melatonin.md"]);
  assert.equal(mentionedNodes("", rel).size, 0);
  // the limit is honoured and weak hits are dropped
  assert.ok(relatedNodes(rel, at("Unrelated.md"), { text: "" }).length === 0);
  assert.ok(relatedNodes(rel, at("Sleep.md"), { text: "", limit: 1 }).length <= 1);
});

test("addLinkLine: Connections heading, else a Related line", () => {
  assert.equal(addLinkLine("# A\n\n## Connections\n- [[X]]\n\nTail\n", "Y"), "# A\n\n## Connections\n- [[X]]\n- [[Y]]\n\nTail\n");
  assert.equal(addLinkLine("## connections\n", "Y"), "## connections\n- [[Y]]\n");
  // a heading with nothing under it still takes the link
  assert.equal(addLinkLine("Body\n\n### Connections", "Y"), "Body\n\n### Connections\n- [[Y]]\n");
  // no heading: a Related line at the end, extended rather than repeated
  assert.equal(addLinkLine("Body text", "Y"), "Body text\n\nRelated: [[Y]]\n");
  assert.equal(addLinkLine("Body text\n\nRelated: [[Y]]\n", "Z"), "Body text\n\nRelated: [[Y]] · [[Z]]\n");
  assert.equal(addLinkLine("Body\n\n\n", "Y"), "Body\n\nRelated: [[Y]]\n");
  // text written after the Related line: the next link still joins that line
  assert.equal(addLinkLine("Body\n\nRelated: [[Y]]\n\nMore text\n", "Z"), "Body\n\nRelated: [[Y]] · [[Z]]\n\nMore text\n");
  assert.equal(addLinkLine("", "Y"), "Related: [[Y]]\n");
  // a fenced "## Connections" inside code is still a heading match we accept,
  // but a plain paragraph mentioning connections is not
  assert.equal(addLinkLine("I like connections\n", "Y"), "I like connections\n\nRelated: [[Y]]\n");
});

test("timeline: notes by when they changed, a lane per top folder, a tag under what it links to", async () => {
  const { timelineLayout } = await import("../graphcore.js");
  // a -- tag -- b  (adjacency: start/adj, as buildGraph makes it)
  const G = {
    nodes: [{ id: "Work/a.md", path: "Work/a.md" }, { id: "Home/b.md", path: "Home/b.md" }, { id: "#t", path: "" }, { id: "Work/c.md", path: "Work/c.md" }],
    start: Int32Array.from([0, 1, 2, 4, 4]),
    adj: Int32Array.from([2, 2, 0, 1]),
  };
  const T = { "Work/a.md": 1000, "Home/b.md": 3000, "Work/c.md": 2000 };
  const L = timelineLayout(G, (nd) => T[nd.id] || 0, { width: 100, lane: 10 });
  assert.ok(L.x[0] < L.x[3] && L.x[3] < L.x[1], "older to the left");
  assert.deepEqual(L.lanes.map((l) => l.name), ["Home", "Work", "Tags and links"]);
  assert.ok(Math.abs(L.y[0] - L.lanes[1].y) < 10 && Math.abs(L.y[1] - L.lanes[0].y) < 10, "each in its folder's lane");
  assert.equal(L.x[2], (L.x[0] + L.x[1]) / 2, "the tag at the middle of what it links to");
  // the same note keeps its place
  assert.equal(timelineLayout(G, (nd) => T[nd.id] || 0, { width: 100, lane: 10 }).y[0], L.y[0]);
});
