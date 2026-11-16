// Graph logic with no DOM: building the displayed graph from the vault,
// neighbourhoods and shortest paths, search, colour groups, the force layout
// and a hit-test grid. Runs in node for tests. The layout and the grid work
// over flat typed arrays that are only reallocated when the graph grows, so a
// simulation step allocates nothing.

import { fuzzy } from "./search.js";

/* ── settings ───────────────────────────────────────────────────────────── */

export const GRAPH_DEFAULTS = {
  panel: true,
  open: { scope: true, filters: false, groups: false, comments: true, homes: true, lens: false, display: false, forces: false },
  scope: "all", // all | around | folder | tag
  layout: "free", // free (the forces) | timeline (by when each note last changed) | orbit (the graph turning in 3D)
  depth: 2,
  folder: "",
  tag: "",
  radial: false,
  orphans: true,
  attachments: false,
  tagNodes: false,
  unresolved: false,
  exclude: [],
  colorBy: "folder", // none | folder | tag | rules
  rules: [],
  hiddenGroups: [],
  folderDepth: 1, // folder colouring: how many levels make a category
  splitFolders: [], // folders whose subfolders are categories of their own
  ownFolders: [], // folders that are one category, subfolders included
  showLegend: true,
  sizeByLinks: true,
  nodeSize: 1,
  labelSize: 1,
  linkWidth: 1,
  arrows: false,
  textFade: 1,
  repel: 1,
  linkDistance: 60,
  gravity: 1,
  homePull: 0.25, // how firmly a home holds its notes
  dragPins: false, // off: a dragged note rejoins the live pool when dropped (P still pins)
  homeHalos: true,
  homeNames: true,
  fog: false, // notes not opened or changed in fogDays lie under fog
  fogDays: 90,
  routes: false, // links between two homes drawn as one route, with their count
  ships: true, // with a look: ships (or spaceships) moving between homes, or notes when there are none
  shipCount: 5,
  dblSide: false, // a double-click opens a note beside (in the side pane); off: in the main tabs (Alt+click: beside)
  dblSideV: 2,
  shipZoom: true, // ships grow and shrink with the zoom
  views: [], // saved views: [{ name, scope, folder, tag, depth, focusId, cam }]
  look: "plain", // plain | pirates (islands and ships) | space (planets and spaceships)
  // links that cross between homes (or a home and the pool) and/or colour groups
  crossLinks: true,
  crossBy: "homes", // homes | groups | both
  linkStyle: "line", // line | dashed | gradient | glow
  bridgeCurve: true, // bridges bow (a curve), or run straight
  hideInner: false, // hide the links inside a home / group, keep the bridges
  bridgesOnly: false, // show only bridges and the notes they join
  // reading lens (graphlens.js)
  lens: false, // the lens tool is armed
  lensCards: 4, // how many reading cards may sit open at once
  lensHints: true, // point at notes that might belong together
  lensKeep: false, // keep a card while its note is anywhere under the glass
  lensRadius: 48, // the glass, in screen pixels
  lensDelay: 250, // how long a card lingers once the pointer moves off
  lensGap: 28, // how far a reading card sits from its note, so the neighbours stay reachable
  // the plain hover card (lens off)
  tips: true,
  tipDelay: 130, // how long the pointer rests on a note before its card shows
  tipLinger: 650, // how long the card waits once the pointer moves off
  tipGap: 16, // how far the card sits from the note
  lensAlpha: 0.89, // how solid a card's glass is
  lensHintMin: 2, // weakest correlation score worth showing
  lensHintMax: 3, // how many suggestions a card lists
};

export const LINK_STYLES = ["line", "dashed", "gradient", "glow"];

const trimSlashes = (p) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
const num = (v, lo, hi, d) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, +v)) : d);

/** Stored settings merged over the defaults, with every value sanitised:
 *  the object lives in settings.json and may have been edited by hand. */
export function graphSettings(stored) {
  const s = { ...GRAPH_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  const D = GRAPH_DEFAULTS;
  s.open = { ...D.open, ...(s.open && typeof s.open === "object" ? s.open : {}) };
  if (!["all", "around", "folder", "tag"].includes(s.scope)) s.scope = D.scope;
  if (!["none", "folder", "tag", "rules"].includes(s.colorBy)) s.colorBy = D.colorBy;
  if (!["homes", "groups", "both"].includes(s.crossBy)) s.crossBy = D.crossBy;
  if (!["plain", "pirates", "space"].includes(s.look)) s.look = D.look;
  s.fogDays = num(s.fogDays, 7, 730, D.fogDays);
  s.shipCount = Math.round(num(s.shipCount, 0, 1000, D.shipCount));
  s.views = Array.isArray(s.views) ? s.views.filter((v) => v && typeof v === "object" && typeof v.name === "string").slice(0, 30).map((v) => ({
    name: v.name.slice(0, 60), scope: v.scope, folder: String(v.folder || ""), tag: String(v.tag || ""), depth: num(v.depth, 1, 5, 2),
    focusId: typeof v.focusId === "string" ? v.focusId : null,
    cam: v.cam && Number.isFinite(v.cam.x) && Number.isFinite(v.cam.y) && Number.isFinite(v.cam.k) && v.cam.k > 0 ? { x: v.cam.x, y: v.cam.y, k: v.cam.k } : null,
  })) : [];
  // a double-click opens in the main tabs again, for everyone (settings saved before carry no dblSideV)
  if (!(stored && typeof stored === "object" && stored.dblSideV === 2)) s.dblSide = false;
  if (s.linkStyle === "curve") { s.linkStyle = "line"; s.bridgeCurve = true; } // the old style was line + curve in one
  if (!LINK_STYLES.includes(s.linkStyle)) s.linkStyle = D.linkStyle;
  if (!["free", "timeline", "orbit"].includes(s.layout)) s.layout = D.layout;
  s.depth = Math.round(num(s.depth, 1, 5, D.depth));
  for (const k of ["folder", "tag"]) s[k] = typeof s[k] === "string" ? s[k] : "";
  for (const k of ["panel", "radial", "orphans", "attachments", "tagNodes", "unresolved", "sizeByLinks", "arrows", "showLegend", "homeHalos", "homeNames", "fog", "routes", "ships", "shipZoom", "dblSide", "bridgeCurve", "crossLinks", "hideInner", "bridgesOnly", "lens", "lensHints", "lensKeep"]) s[k] = !!s[k];
  s.tips = s.tips !== false;
  s.lensGap = Math.round(num(s.lensGap, 18, 320, D.lensGap));
  s.tipDelay = Math.round(num(s.tipDelay, 0, 2000, D.tipDelay));
  s.tipLinger = Math.round(num(s.tipLinger, 100, 5000, D.tipLinger));
  s.tipGap = Math.round(num(s.tipGap, 8, 320, D.tipGap));
  const strs = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === "string" && x))] : []);
  s.exclude = strs(s.exclude);
  s.hiddenGroups = Array.isArray(s.hiddenGroups) ? s.hiddenGroups.filter((x) => typeof x === "string") : [];
  s.splitFolders = strs(strs(s.splitFolders).map(trimSlashes));
  s.ownFolders = strs(strs(s.ownFolders).map(trimSlashes));
  s.folderDepth = Math.round(num(s.folderDepth, 1, 4, D.folderDepth));
  s.rules = Array.isArray(s.rules)
    ? s.rules.filter((r) => r && typeof r === "object").map((r) => ({ q: String(r.q || ""), color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : "#5b9cf6" }))
    : [];
  s.nodeSize = num(s.nodeSize, 0.4, 3, D.nodeSize);
  s.labelSize = num(s.labelSize, 0.6, 2.5, D.labelSize);
  s.linkWidth = num(s.linkWidth, 0.2, 4, D.linkWidth);
  s.textFade = num(s.textFade, 0.2, 3, D.textFade);
  s.repel = num(s.repel, 0.1, 4, D.repel);
  s.linkDistance = num(s.linkDistance, 15, 300, D.linkDistance);
  s.gravity = num(s.gravity, 0, 4, D.gravity);
  s.homePull = num(s.homePull, 0, 4, D.homePull);
  s.lensCards = Math.round(num(s.lensCards, 2, 12, D.lensCards));
  s.lensRadius = Math.round(num(s.lensRadius, 30, 200, D.lensRadius));
  s.lensDelay = Math.round(num(s.lensDelay, 80, 4000, D.lensDelay));
  s.lensAlpha = num(s.lensAlpha, 0.4, 1, D.lensAlpha);
  s.lensHintMin = num(s.lensHintMin, 1, 6, D.lensHintMin);
  s.lensHintMax = Math.round(num(s.lensHintMax, 1, 6, D.lensHintMax));
  return s;
}

/* ── building the graph ─────────────────────────────────────────────────── */

const dirOf = (p) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

/**
 * A link resolver with vault.resolve's exact answers, fast enough for 10k
 * links. Path-style targets ("Folder/Note") go through an index of every
 * segment suffix, first path wins (vault.resolve scans the notes in order);
 * bare names go to `byName` (vault.resolve itself, a map lookup), memoised
 * per folder since only an ambiguous name depends on where the link is.
 */
export function makeResolver(paths, byName) {
  const suffix = new Map();
  for (const p of paths) {
    const lp = p.toLowerCase();
    let k = 0;
    for (;;) {
      const s = k ? lp.slice(k) : lp;
      if (!suffix.has(s)) suffix.set(s, p);
      const nx = lp.indexOf("/", k);
      if (nx < 0) break;
      k = nx + 1;
    }
  }
  const memo = new Map();
  return (target, from) => {
    let t = String(target || "").trim().replace(/\\/g, "/");
    if (!t) return null;
    if (t.toLowerCase().endsWith(".md")) t = t.slice(0, -3);
    if (t.includes("/")) return suffix.get(t.toLowerCase().replace(/^\/+/, "") + ".md") || null;
    const key = t + "\n" + (from ? dirOf(from) : "");
    let r = memo.get(key);
    if (r === undefined) {
      r = byName ? byName(target, from) || null : null;
      memo.set(key, r);
    }
    return r;
  };
}

const MD_LINK_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

const inFolder = (folder, f) => folder === f || folder.startsWith(f + "/");
const hasTag = (tags, t) => tags.some((x) => x === t || x.startsWith(t + "/"));

/**
 * Build the graph to display.
 *
 * src: { notes: iterable of { path, title, folder, links:[{target}], tags, content },
 *        resolve(target, from) -> note path | null,
 *        resolveFile(target, from) -> { path, kind } | null }
 * opts: { scope, focus, depth, folder, tag, orphans, attachments, tagNodes,
 *         unresolved, exclude: [folder], hidden: Set<id>, only: Set<id> | null }
 *
 * Node ids: a note or file is its path; a tag is "tag:<name>"; an unresolved
 * link is "ghost:<lowercased target>" (no vault path can contain a colon).
 * Links are deduplicated per pair; `both` marks a pair linked both ways.
 * `out` / `inn` count distinct note links over the whole vault (before the
 * scope is applied), so a note's card is right in every scope.
 */
export function buildGraph(src, opts = {}) {
  const exclude = (opts.exclude || []).filter(Boolean);
  const hidden = opts.hidden || null;
  const only = opts.only || null;
  const resolve = src.resolve;
  const resolveFile = src.resolveFile || null;

  const all = [];
  const index = new Map();
  const add = (id, kind, label, extra) => {
    let i = index.get(id);
    if (i !== undefined) return i;
    i = all.length;
    index.set(id, i);
    all.push({ id, kind, label, path: kind === "note" || kind === "file" ? id : "", folder: "", tags: [], out: 0, inn: 0, refs: 0, deg: 0, dist: -1, ...extra });
    return i;
  };

  const notes = [];
  for (const n of src.notes) {
    const folder = n.folder != null ? n.folder : dirOf(n.path);
    if (exclude.length && exclude.some((f) => inFolder(folder, f))) continue;
    add(n.path, "note", n.title || n.path, { folder, tags: n.tags || [] });
    notes.push(n);
  }

  // undirected pairs, deduplicated; the key packs both indices in a double
  const pairs = new Map();
  const S = [];
  const T = [];
  const B = [];
  const link = (a, b) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * 67108864 + hi;
    const e = pairs.get(key);
    if (e === undefined) {
      pairs.set(key, S.length);
      S.push(a); T.push(b); B.push(0);
      return true;
    }
    if (S[e] === a) return false; // same direction again
    if (B[e]) return false;
    B[e] = 1;
    return true;
  };

  for (const n of notes) {
    const i = index.get(n.path);
    for (const l of n.links || []) {
      const to = resolve(l.target, n.path);
      if (to) {
        if (to === n.path) continue;
        const j = index.get(to);
        if (j === undefined || all[j].kind !== "note") continue;
        if (link(i, j)) { all[i].out++; all[j].inn++; }
        continue;
      }
      if (opts.attachments && resolveFile) {
        const f = resolveFile(l.target, n.path);
        if (f) {
          const folder = dirOf(f.path);
          if (exclude.length && exclude.some((x) => inFolder(folder, x))) continue;
          const j = add(f.path, "file", f.path.slice(f.path.lastIndexOf("/") + 1), { folder, fileKind: f.kind || "" });
          if (link(i, j)) all[j].refs++;
          continue;
        }
      }
      if (opts.unresolved) {
        const t = String(l.target).trim();
        if (!t) continue;
        // a file that is there is not "not created yet" - with attachments hidden it is simply left out
        if (resolveFile && resolveFile(l.target, n.path)) continue;
        const j = add("ghost:" + t.toLowerCase(), "ghost", t.replace(/\.md$/i, ""));
        if (link(i, j)) all[j].refs++;
      }
    }
    if (opts.attachments && resolveFile && n.content && n.content.indexOf("](") >= 0) {
      MD_LINK_RE.lastIndex = 0;
      for (const m of n.content.matchAll(MD_LINK_RE)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
        const f = resolveFile(target, n.path);
        if (!f) continue;
        const folder = dirOf(f.path);
        if (exclude.length && exclude.some((x) => inFolder(folder, x))) continue;
        const j = add(f.path, "file", f.path.slice(f.path.lastIndexOf("/") + 1), { folder, fileKind: f.kind || "" });
        if (link(i, j)) all[j].refs++;
      }
    }
    if (opts.tagNodes) {
      for (const t of n.tags || []) {
        const j = add("tag:" + t, "tag", "#" + t);
        if (link(i, j)) all[j].refs++;
      }
    }
  }

  const N = all.length;
  const full = csr(N, S, T);

  // scope
  const keep = new Uint8Array(N);
  const scope = opts.scope || "all";
  let focus = -1;
  if (scope === "around") {
    focus = opts.focus != null && index.has(opts.focus) ? index.get(opts.focus) : -1;
    if (focus >= 0) {
      const dist = bfs(full, focus, Math.max(1, opts.depth || 1), (k) => all[k].kind === "note");
      for (let k = 0; k < N; k++) if (dist[k] >= 0) { keep[k] = 1; all[k].dist = dist[k]; }
    }
  } else {
    const noteOk =
      scope === "folder" && opts.folder ? (n) => inFolder(n.folder, opts.folder)
      : scope === "tag" && opts.tag ? (n) => hasTag(n.tags, opts.tag)
      : null;
    for (let k = 0; k < N; k++) if (all[k].kind === "note" && (!noteOk || noteOk(all[k]))) keep[k] = 1;
    // a file, tag or unresolved link belongs with the notes that point at it
    for (let k = 0; k < N; k++) {
      if (all[k].kind === "note") continue;
      for (let a = full.start[k]; a < full.start[k + 1]; a++) if (keep[full.adj[a]] && all[full.adj[a]].kind === "note") { keep[k] = 1; break; }
    }
  }
  if (hidden && hidden.size) for (const id of hidden) { const k = index.get(id); if (k !== undefined && k !== focus) keep[k] = 0; }
  if (only) for (let k = 0; k < N; k++) if (!only.has(all[k].id)) keep[k] = 0;

  // degree inside what is kept; orphans (and anything left dangling) go
  const deg = new Int32Array(N);
  for (let e = 0; e < S.length; e++) if (keep[S[e]] && keep[T[e]]) { deg[S[e]]++; deg[T[e]]++; }
  for (let k = 0; k < N; k++) {
    if (!keep[k] || deg[k] || k === focus) continue;
    if (all[k].kind !== "note" || opts.orphans === false) keep[k] = 0;
  }

  const remap = new Int32Array(N).fill(-1);
  const nodes = [];
  const ids = new Map();
  for (let k = 0; k < N; k++) {
    if (!keep[k]) continue;
    remap[k] = nodes.length;
    ids.set(all[k].id, nodes.length);
    all[k].deg = deg[k];
    nodes.push(all[k]);
  }
  const src2 = [];
  const dst2 = [];
  const both = [];
  for (let e = 0; e < S.length; e++) {
    const a = remap[S[e]];
    const b = remap[T[e]];
    if (a < 0 || b < 0) continue;
    src2.push(a); dst2.push(b); both.push(B[e]);
  }
  const g = csr(nodes.length, src2, dst2);
  let notesShown = 0;
  for (const n of nodes) if (n.kind === "note") notesShown++;
  return {
    nodes,
    index: ids,
    src: g.src,
    dst: g.dst,
    both: Uint8Array.from(both),
    start: g.start,
    adj: g.adj,
    adjEdge: g.adjEdge,
    focus: focus >= 0 ? remap[focus] : -1,
    stats: { notes: notesShown, links: src2.length, total: notes.length },
  };
}

/** Compressed adjacency (both directions) for BFS and neighbour lookups. */
export function csr(n, S, T) {
  const m = S.length;
  const start = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) { start[S[e] + 1]++; start[T[e] + 1]++; }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const adj = new Int32Array(2 * m);
  const adjEdge = new Int32Array(2 * m);
  for (let e = 0; e < m; e++) {
    const a = S[e];
    const b = T[e];
    adj[fill[a]] = b; adjEdge[fill[a]++] = e;
    adj[fill[b]] = a; adjEdge[fill[b]++] = e;
  }
  return { n, src: Int32Array.from(S), dst: Int32Array.from(T), start, adj, adjEdge };
}

/* ── neighbourhoods and paths ───────────────────────────────────────────── */

const count = (g) => g.start.length - 1;

/**
 * Hop distance from `from` (-1 where unreachable), links taken both ways.
 * `through(i)` says whether a walk may continue past node i: tags and files
 * are destinations, never bridges between notes.
 */
export function bfs(g, from, maxDepth = Infinity, through = null) {
  const n = count(g);
  const dist = new Int32Array(n).fill(-1);
  if (from < 0 || from >= n) return dist;
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  dist[from] = 0;
  queue[tail++] = from;
  while (head < tail) {
    const u = queue[head++];
    if (dist[u] >= maxDepth) continue;
    if (u !== from && through && !through(u)) continue;
    for (let a = g.start[u]; a < g.start[u + 1]; a++) {
      const v = g.adj[a];
      if (dist[v] < 0) { dist[v] = dist[u] + 1; queue[tail++] = v; }
    }
  }
  return dist;
}

/** Connected components: { comp: Int32Array (id per node), size: sizes by id }. */
export function components(g) {
  const n = count(g);
  const comp = new Int32Array(n).fill(-1);
  const size = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const id = size.length;
    let sp = 0;
    let k = 0;
    stack[sp++] = s;
    comp[s] = id;
    while (sp) {
      const u = stack[--sp];
      k++;
      for (let a = g.start[u]; a < g.start[u + 1]; a++) {
        const v = g.adj[a];
        if (comp[v] < 0) { comp[v] = id; stack[sp++] = v; }
      }
    }
    size.push(k);
  }
  return { comp, size };
}

/** Every node within `depth` hops, as a Set of indices. */
export function neighbourhood(g, from, depth = 1, through = null) {
  const d = bfs(g, from, depth, through);
  const out = new Set();
  for (let i = 0; i < d.length; i++) if (d[i] >= 0) out.add(i);
  return out;
}

/** One shortest path from a to b as a list of node indices, or null. */
export function shortestPath(g, a, b, through = null) {
  const n = count(g);
  if (a < 0 || b < 0 || a >= n || b >= n) return null;
  if (a === b) return [a];
  const prev = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  prev[a] = a;
  queue[tail++] = a;
  while (head < tail) {
    const u = queue[head++];
    if (u !== a && through && !through(u)) continue;
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const v = g.adj[k];
      if (prev[v] >= 0) continue;
      prev[v] = u;
      if (v === b) {
        const path = [b];
        for (let x = u; x !== a; x = prev[x]) path.push(x);
        path.push(a);
        return path.reverse();
      }
      queue[tail++] = v;
    }
  }
  return null;
}

/**
 * Everything that lies on some shortest path between a and b: two BFS runs,
 * so it costs the same as one path. Returns { length, layers (node indices
 * per step), nodes / edges masks, paths (count, capped) } or null.
 */
export function shortestPaths(g, a, b, through = null) {
  const n = count(g);
  if (a < 0 || b < 0 || a >= n || b >= n) return null;
  const da = bfs(g, a, Infinity, through);
  const D = da[b];
  if (D < 0) return null;
  const db = bfs(g, b, Infinity, through);
  const nodes = new Uint8Array(n);
  const layers = Array.from({ length: D + 1 }, () => []);
  for (let i = 0; i < n; i++) {
    if (da[i] < 0 || db[i] < 0 || da[i] + db[i] !== D) continue;
    if (i !== a && i !== b && through && !through(i)) continue;
    nodes[i] = 1;
    layers[da[i]].push(i);
  }
  const edges = new Uint8Array(g.src.length);
  for (let e = 0; e < g.src.length; e++) {
    const u = g.src[e];
    const v = g.dst[e];
    if (nodes[u] && nodes[v] && Math.abs(da[u] - da[v]) === 1) edges[e] = 1;
  }
  // count paths layer by layer (capped: a dense vault has millions)
  const ways = new Float64Array(n);
  ways[a] = 1;
  for (let s = 1; s <= D; s++) {
    for (const v of layers[s]) {
      let w = 0;
      for (let k = g.start[v]; k < g.start[v + 1]; k++) {
        const u = g.adj[k];
        if (nodes[u] && da[u] === s - 1) w += ways[u];
      }
      ways[v] = Math.min(w, 1e9);
    }
  }
  return { length: D, layers, nodes, edges, paths: ways[b] };
}

/* ── search and queries ─────────────────────────────────────────────────── */

/** How well a node matches a search. null = no match. "#tag" matches tags. */
export function scoreNode(query, node) {
  const q = String(query || "").trim();
  if (!q) return null;
  if (q[0] === "#" && q.length > 1) {
    const t = q.slice(1).toLowerCase();
    if (node.kind === "tag") return node.label.slice(1).startsWith(t) ? 900 - node.label.length : null;
    let best = null;
    for (const x of node.tags) if (x.startsWith(t)) best = Math.max(best ?? -1e9, 800 - x.length + (x === t ? 100 : 0));
    return best;
  }
  let best = null;
  const a = fuzzy(q, node.label);
  if (a) best = a.score + 300;
  if (node.path && node.path !== node.label) {
    const b = fuzzy(q, node.path);
    if (b && (best === null || b.score > best)) best = b.score;
  }
  for (const x of node.tags) {
    const c = fuzzy(q, x);
    if (c && (best === null || c.score - 200 > best)) best = c.score - 200;
  }
  return best;
}

/** Matching node indices, best first. */
export function searchNodes(query, nodes, visible = null) {
  const hits = [];
  for (let i = 0; i < nodes.length; i++) {
    if (visible && !visible[i]) continue;
    const s = scoreNode(query, nodes[i]);
    if (s !== null) hits.push([s, i]);
  }
  hits.sort((x, y) => y[0] - x[0] || nodes[x[1]].label.localeCompare(nodes[y[1]].label));
  return hits.map((h) => h[1]);
}

function tokens(q) {
  const out = [];
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  for (const m of String(q).matchAll(re)) {
    const value = (m[3] ?? m[4] ?? "").toLowerCase();
    if (!value && !m[2]) continue;
    out.push({ not: !!m[1], field: m[2] ? m[2].toLowerCase() : "", value });
  }
  return out;
}

/**
 * Obsidian-style group query: `path:Projects`, `tag:ideas` or `#ideas`,
 * `file:roadmap`, `folder:Ideas`, plain words (title or path), `-` negates,
 * "quoted phrases". Every term must hold. An empty query matches nothing.
 */
export function matchQuery(q, node) {
  const list = tokens(q);
  if (!list.length) return false;
  const title = node.label.toLowerCase();
  const path = (node.path || node.id).toLowerCase();
  for (const t of list) {
    let v = t.value;
    let f = t.field;
    if (!f && v.startsWith("#") && v.length > 1) { f = "tag"; v = v.slice(1); }
    let ok;
    if (f === "path") ok = path.includes(v);
    else if (f === "folder") ok = (node.folder || "").toLowerCase().startsWith(v);
    else if (f === "file" || f === "title") ok = title.includes(v);
    else if (f === "tag") ok = node.kind === "tag" ? title.slice(1).startsWith(v) : hasTag(node.tags, v.replace(/^#/, ""));
    else if (f === "kind") ok = node.kind === v;
    else ok = title.includes(f ? f + ":" + v : v) || path.includes(f ? f + ":" + v : v);
    if (ok === t.not) return false;
  }
  return true;
}

/* ── colour groups ──────────────────────────────────────────────────────── */

export const PALETTE = {
  // no amber: that is the default accent, used for focus and selection
  dark: ["#5b9cf6", "#3fbfa8", "#ee6b8b", "#9b87f5", "#7cc36a", "#e98a4f", "#4fc1d9", "#d985d0", "#b9c95c"],
  light: ["#2f6fd6", "#16917d", "#cf3f63", "#6d56d8", "#4a9a3a", "#c7652a", "#1d93ad", "#b04fa6", "#7f9a1c"],
};

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const KIND_GROUPS = {
  file: { key: "kind:file", label: "Attachments" },
  tag: { key: "kind:tag", label: "Tags" },
  ghost: { key: "kind:ghost", label: "Unresolved" },
};

const segs = (p) => (p ? p.split("/").length : 0);

/**
 * The folder category of a note's folder. `depth` levels by default; a rule
 * on an enclosing folder overrides that, the longest (deepest) rule winning:
 * `own` F keeps F and everything under it as one category, `split` F makes
 * each direct subfolder of F a category (F's own notes stay F). A split and
 * an own rule on the same folder: the split wins.
 */
export function folderCategory(folder, { depth = 1, split = [], own = [] } = {}) {
  if (!folder) return "";
  const parts = folder.split("/");
  let cut = Math.min(depth, parts.length);
  let best = -1;
  for (const f of own) {
    if (!inFolder(folder, f)) continue;
    const l = segs(f);
    if (l > best) { best = l; cut = l; }
  }
  for (const f of split) {
    if (!inFolder(folder, f)) continue;
    const l = segs(f);
    if (l >= best) { best = l; cut = Math.min(parts.length, l + 1); }
  }
  return parts.slice(0, cut).join("/");
}

/**
 * Rules after "merge `cat` back into its parent": rules at or under `cat`
 * go, a split of the parent goes, and if the folder still would not land in
 * the parent (depth, a split further up) the parent becomes its own category.
 */
export function mergeFolderRules(cat, { depth = 1, split = [], own = [] } = {}) {
  const parent = dirOf(cat);
  const out = { split: split.filter((f) => !inFolder(f, cat) && f !== parent), own: own.filter((f) => !inFolder(f, cat)) };
  if (parent && folderCategory(cat, { depth, ...out }) !== parent) out.own.push(parent);
  return out;
}

/** The group a note belongs to (or null), for the chosen colouring.
 *  folders: { depth, split, own } for folder colouring. */
export function groupKey(node, colorBy, rules = [], folders = null) {
  if (KIND_GROUPS[node.kind]) return KIND_GROUPS[node.kind].key;
  if (colorBy === "folder") {
    const folder = node.folder != null && node.folder !== "" ? node.folder : dirOf(node.path || "");
    if (!folders) {
      const i = folder.indexOf("/");
      return "folder:" + (i < 0 ? folder : folder.slice(0, i));
    }
    return "folder:" + folderCategory(folder, folders);
  }
  if (colorBy === "tag") return node.tags.length ? "tag:" + node.tags[0] : "tag:";
  if (colorBy === "rules") {
    for (let r = 0; r < rules.length; r++) if (matchQuery(rules[r].q, node)) return "rule:" + r;
    return null;
  }
  return null;
}

/**
 * Colour groups for the legend. Note groups get palette colours by size,
 * each taking its hashed slot when free so a colour stays with its folder as
 * the vault changes. `color` null means the plain node colour.
 * Returns { groupOf: Int32Array (index into groups), groups }.
 */
export function assignGroups(nodes, { colorBy = "folder", rules = [], theme = "dark", folders = null } = {}) {
  const pal = PALETTE[theme] || PALETTE.dark;
  const map = new Map();
  const groupOf = new Int32Array(nodes.length);
  const keys = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const k = groupKey(nodes[i], colorBy, rules, folders) || "none";
    keys[i] = k;
    const g = map.get(k);
    if (g) g.count++;
    else map.set(k, { key: k, count: 1 });
  }
  const kindOrder = ["kind:file", "kind:tag", "kind:ghost"];
  const all = [...map.values()];
  const noteGroups = all.filter((g) => g.key !== "none" && !g.key.startsWith("kind:"));
  // named groups by size; the neutral "vault root" / "no tag" one goes last
  const blank = (g) => (g.key.endsWith(":") ? 1 : 0);
  noteGroups.sort((a, b) => (colorBy === "rules" ? +a.key.slice(5) - +b.key.slice(5) : blank(a) - blank(b) || b.count - a.count || a.key.localeCompare(b.key)));
  const used = new Set();
  for (const g of noteGroups) {
    const colon = g.key.indexOf(":");
    const name = g.key.slice(colon + 1);
    if (g.key.startsWith("rule:")) {
      const r = rules[+name];
      g.label = r ? r.q : name;
      g.color = r ? r.color : null;
      continue;
    }
    g.label = name || (g.key.startsWith("tag:") ? "No tag" : "Vault root");
    if (!name) { g.color = null; continue; }
    let slot = hash(g.key) % pal.length;
    if (used.size < pal.length) while (used.has(slot)) slot = (slot + 1) % pal.length;
    used.add(slot);
    g.color = pal[slot];
  }
  const none = map.get("none");
  if (none) { none.label = colorBy === "rules" ? "Other notes" : "Notes"; none.color = null; }
  const groups = [...noteGroups, ...(none ? [none] : []), ...kindOrder.filter((k) => map.has(k)).map((k) => {
    const g = map.get(k);
    g.label = Object.values(KIND_GROUPS).find((x) => x.key === k).label;
    g.color = null;
    g.kind = k.slice(5);
    return g;
  })];
  const at = new Map(groups.map((g, i) => [g.key, i]));
  for (let i = 0; i < nodes.length; i++) groupOf[i] = at.get(keys[i]);
  return { groupOf, groups };
}

/* ── force layout ───────────────────────────────────────────────────────── */

const MAX_DEPTH = 22;

/**
 * d3-force's model (many-body + link + gravity, velocity decay) with the
 * many-body term computed by Barnes-Hut over a flat quadtree. Arrays grow
 * only when the graph does; `step` itself allocates nothing.
 */
export function createLayout() {
  let cap = 0;
  let ecap = 0;
  let qcap = 0;
  const L = {
    n: 0,
    m: 0,
    x: new Float64Array(0),
    y: new Float64Array(0),
    vx: new Float64Array(0),
    vy: new Float64Array(0),
    charge: new Float64Array(0), // repulsion weight per node
    pull: new Float64Array(0), // gravity weight per node
    fixed: new Uint8Array(0),
    ring: new Float64Array(0), // target radius for the radial layout, -1 = free
    // homes: a node with home[i] >= 0 is drawn to (hx, hy)[home[i]] with
    // weight hw[i] instead of to the origin, and ignores far masses
    home: new Int32Array(0),
    hw: new Float64Array(0),
    hk: 0,
    hx: new Float64Array(0),
    hy: new Float64Array(0),
    src: new Int32Array(0),
    dst: new Int32Array(0),
    lstr: new Float64Array(0),
    lbias: new Float64Array(0),
    lrest: new Float64Array(0),
  };
  // quadtree
  let qcx = new Float64Array(0), qcy = new Float64Array(0), qhs = new Float64Array(0);
  let qm = new Float64Array(0), qx = new Float64Array(0), qy = new Float64Array(0);
  let qchild = new Int32Array(0), qbody = new Int32Array(0);
  let qn = 0;
  const stack = new Int32Array(4 * (MAX_DEPTH + 2) + 8);
  let seed = 1;
  const jiggle = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 4294967296 - 0.5) * 1e-3; };

  function growQ(need) {
    if (need <= qcap) return;
    const c = Math.max(need, qcap * 2, 256);
    const f = (a) => { const b = new Float64Array(c); b.set(a.subarray(0, qn)); return b; };
    const i = (a) => { const b = new Int32Array(c); b.set(a.subarray(0, qn)); return b; };
    qcx = f(qcx); qcy = f(qcy); qhs = f(qhs); qm = f(qm); qx = f(qx); qy = f(qy);
    qchild = i(qchild); qbody = i(qbody);
    qcap = c;
  }

  function cell(cx, cy, hs) {
    const k = qn++;
    qcx[k] = cx; qcy[k] = cy; qhs[k] = hs;
    qm[k] = 0; qx[k] = 0; qy[k] = 0;
    qchild[k] = -1; qbody[k] = -1;
    return k;
  }

  function build() {
    const { n, x, y, charge } = L;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < x0) x0 = x[i];
      if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i];
      if (y[i] > y1) y1 = y[i];
    }
    const hs = Math.max(x1 - x0, y1 - y0, 1) / 2 + 1;
    qn = 0;
    growQ(4 * n + 16);
    cell((x0 + x1) / 2, (y0 + y1) / 2, hs);
    for (let i = 0; i < n; i++) {
      const px = x[i], py = y[i], w = charge[i];
      let node = 0;
      let depth = 0;
      for (;;) {
        qm[node] += w; qx[node] += px * w; qy[node] += py * w;
        if (qchild[node] >= 0) {
          node = qchild[node] + (px >= qcx[node] ? 1 : 0) + (py >= qcy[node] ? 2 : 0);
          depth++;
          continue;
        }
        if (qbody[node] === -1) { qbody[node] = i; break; }
        if (depth >= MAX_DEPTH) break; // coincident bodies share the leaf
        // split: push the resident one level down, then keep descending
        if (qn + 4 > qcap) growQ(qn + 4);
        const h = qhs[node] / 2;
        const c = qn;
        const cx = qcx[node], cy = qcy[node];
        cell(cx - h, cy - h, h); cell(cx + h, cy - h, h); cell(cx - h, cy + h, h); cell(cx + h, cy + h, h);
        const j = qbody[node];
        qbody[node] = -2;
        qchild[node] = c;
        const cj = c + (x[j] >= cx ? 1 : 0) + (y[j] >= cy ? 2 : 0);
        const wj = charge[j];
        qm[cj] = wj; qx[cj] = x[j] * wj; qy[cj] = y[j] * wj; qbody[cj] = j;
        node = c + (px >= cx ? 1 : 0) + (py >= cy ? 2 : 0);
        depth++;
      }
    }
  }

  L.resize = (n, m) => {
    if (n > cap) {
      cap = Math.max(n, cap * 2, 64);
      const keep = (a, T) => { const b = new T(cap); b.set(a.subarray(0, Math.min(a.length, L.n))); return b; };
      L.x = keep(L.x, Float64Array); L.y = keep(L.y, Float64Array);
      L.vx = keep(L.vx, Float64Array); L.vy = keep(L.vy, Float64Array);
      L.charge = keep(L.charge, Float64Array); L.fixed = keep(L.fixed, Uint8Array); L.ring = keep(L.ring, Float64Array);
      const hb = L.home.length;
      L.home = keep(L.home, Int32Array);
      L.home.fill(-1, Math.min(hb, L.n));
      L.hw = keep(L.hw, Float64Array);
      const before = L.pull.length;
      L.pull = keep(L.pull, Float64Array);
      L.pull.fill(1, Math.min(before, L.n));
    }
    if (m > ecap) {
      ecap = Math.max(m, ecap * 2, 64);
      L.src = new Int32Array(ecap); L.dst = new Int32Array(ecap);
      L.lstr = new Float64Array(ecap); L.lbias = new Float64Array(ecap); L.lrest = new Float64Array(ecap);
    }
    L.n = n;
    L.m = m;
  };

  /** Room for k home anchors; every node starts homeless. */
  L.setHomes = (k) => {
    if (L.hx.length < k) { L.hx = new Float64Array(Math.max(k, 8)); L.hy = new Float64Array(Math.max(k, 8)); }
    L.hk = k;
    L.home.fill(-1, 0, L.n);
    L.hw.fill(1, 0, L.n);
  };

  /** Link strength and bias from degrees, as d3 does: hubs hold loosely. */
  L.setLinks = (src, dst, deg) => {
    for (let e = 0; e < L.m; e++) {
      const a = src[e], b = dst[e];
      L.src[e] = a; L.dst[e] = b;
      const da = Math.max(1, deg[a]), db = Math.max(1, deg[b]);
      L.lstr[e] = 1 / Math.min(da, db);
      L.lbias[e] = da / (da + db);
    }
  };

  /**
   * One tick. p: { repel, linkDistance, gravity, radial, theta, homePull, homeRange }.
   * Returns the largest squared velocity, for settle detection.
   */
  L.step = (alpha, p) => {
    const { n, m, x, y, vx, vy, charge, fixed, ring, home } = L;
    if (!n) return 0;
    const homes = L.hk > 0;
    const range2 = homes ? (p.homeRange ?? 420) ** 2 : 0;
    const repel = -30 * (p.repel ?? 1);
    const theta2 = (p.theta ?? 0.9) ** 2;
    const minD2 = 1;
    build();
    for (let i = 0; i < n; i++) {
      const px = x[i], py = y[i];
      let sp = 0;
      stack[sp++] = 0;
      let ax = 0, ay = 0;
      // a homed node does not feel far masses: the pool must not push it off
      const dm = homes && home[i] >= 0 ? range2 : 0;
      while (sp) {
        const q = stack[--sp];
        const mass = qm[q];
        if (mass === 0) continue;
        let dx = qx[q] / mass - px;
        let dy = qy[q] / mass - py;
        let l = dx * dx + dy * dy;
        const w = qhs[q] * 2;
        const leaf = qchild[q] < 0;
        if (leaf || (w * w) / theta2 < l) {
          if (leaf && qbody[q] === i) continue;
          if (dm && l > dm) continue;
          if (dx === 0) { dx = jiggle(); l += dx * dx; }
          if (dy === 0) { dy = jiggle(); l += dy * dy; }
          if (l < minD2) l = Math.sqrt(minD2 * l);
          const f = (mass * repel * alpha) / l;
          ax += dx * f;
          ay += dy * f;
          continue;
        }
        const c = qchild[q];
        stack[sp++] = c; stack[sp++] = c + 1; stack[sp++] = c + 2; stack[sp++] = c + 3;
      }
      vx[i] += ax;
      vy[i] += ay;
    }

    const rest = p.linkDistance ?? 60;
    const { src, dst, lstr, lbias } = L;
    for (let e = 0; e < m; e++) {
      const a = src[e], b = dst[e];
      let dx = x[b] + vx[b] - x[a] - vx[a];
      let dy = y[b] + vy[b] - y[a] - vy[a];
      if (dx === 0) dx = jiggle();
      if (dy === 0) dy = jiggle();
      let l = Math.sqrt(dx * dx + dy * dy);
      l = ((l - rest) / l) * alpha * lstr[e];
      dx *= l;
      dy *= l;
      const bias = lbias[e];
      vx[b] -= dx * bias;
      vy[b] -= dy * bias;
      vx[a] += dx * (1 - bias);
      vy[a] += dy * (1 - bias);
    }

    const g = (p.gravity ?? 1) * 0.04 * alpha;
    const { pull } = L;
    const radial = p.radial || 0;
    const hp = (p.homePull ?? 1) * 0.12 * alpha;
    const { hw, hx, hy } = L;
    let vmax = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) { vx[i] = 0; vy[i] = 0; continue; }
      let fx, fy;
      const hm = homes ? home[i] : -1;
      if (hm >= 0) {
        // local gravity toward the home; the core, heavier, sits nearest it
        const k = hp * hw[i];
        fx = (hx[hm] - x[i]) * k;
        fy = (hy[hm] - y[i]) * k;
      } else {
        fx = -x[i] * g * pull[i];
        fy = -y[i] * g * pull[i];
      }
      if (radial && ring[i] >= 0) {
        const r = Math.sqrt(x[i] * x[i] + y[i] * y[i]) || 1e-6;
        const k = ((ring[i] - r) * radial * alpha) / r;
        fx += x[i] * k;
        fy += y[i] * k;
      }
      vx[i] = (vx[i] + fx) * 0.6;
      vy[i] = (vy[i] + fy) * 0.6;
      x[i] += vx[i];
      y[i] += vy[i];
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      if (v2 > vmax) vmax = v2;
    }
    return vmax;
  };

  /** Tree cells in use after the last step (for tests and tuning). */
  L.cells = () => qn;
  return L;
}

/** Brute-force repulsion, the reference the Barnes-Hut step is tested against. */
export function exactRepulsion(x, y, charge, n, alpha, repel = 1) {
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const s = -30 * repel;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      let l = dx * dx + dy * dy;
      if (l < 1) l = Math.sqrt(l);
      const f = (charge[j] * s * alpha) / l;
      ax[i] += dx * f;
      ay[i] += dy * f;
    }
  }
  return { ax, ay };
}

/* ── homes and bridges ──────────────────────────────────────────────────── */

export const CROSS_HOME = 1;
export const CROSS_GROUP = 2;
export const CORE_WEIGHT = 3;
// a link that leaves its home barely pulls: the home holds, the link stretches
export const BRIDGE_PULL = 0.004;

/**
 * What each link joins, into out[e]: 0 inside one home and group,
 * CROSS_HOME when its ends live in different homes (the pool, -1, counts as
 * one), | CROSS_GROUP when two notes sit in different colour groups. Tags,
 * files and unresolved names never cross groups: they have none of their own.
 * Returns how many links cross anything.
 */
export function classifyEdges(src, dst, m, homeIdx, groupOf, isNote, out) {
  let count = 0;
  for (let e = 0; e < m; e++) {
    const a = src[e], b = dst[e];
    let c = homeIdx[a] !== homeIdx[b] ? CROSS_HOME : 0;
    if (groupOf && groupOf[a] !== groupOf[b] && isNote[a] && isNote[b]) c |= CROSS_GROUP;
    out[e] = c;
    if (c) count++;
  }
  return count;
}

/** The class bits that make a bridge for the crossBy setting. */
export const crossMask = (by) => (by === "groups" ? CROSS_GROUP : by === "both" ? CROSS_HOME | CROSS_GROUP : CROSS_HOME);

/**
 * The main pool's centre and edge: the mean position, and a radius that
 * holds about 90% of it (a uniform disc has r90 = 0.95 R), so a few strays
 * do not stretch it. skip[i] = 1 leaves a node out (homed, dragged, hidden).
 */
export function poolExtent(x, y, n, skip) {
  let cx = 0, cy = 0, c = 0;
  for (let i = 0; i < n; i++) if (!skip || !skip[i]) { cx += x[i]; cy += y[i]; c++; }
  if (!c) return { cx: 0, cy: 0, r: 0, count: 0 };
  cx /= c; cy /= c;
  const d = new Float64Array(c);
  let k = 0;
  for (let i = 0; i < n; i++) if (!skip || !skip[i]) d[k++] = Math.hypot(x[i] - cx, y[i] - cy);
  d.sort();
  return { cx, cy, r: d[Math.min(c - 1, Math.floor(c * 0.9))] / Math.sqrt(0.9), count: c };
}

/** The member a home centres on: the most links, the first on a tie. */
export function homeCore(list, deg) {
  let best = -1;
  for (const i of list) if (best < 0 || deg[i] > deg[best]) best = i;
  return best;
}

/**
 * Points grouped by nearness (single link: within `gap` of any member of
 * the group), over a grid. Returns a label per point, 0..k-1 in order.
 */
export function clusterPoints(xs, ys, gap) {
  const n = xs.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const cells = new Map();
  const key = (cx, cy) => cx * 1048576 + cy;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[i] / gap), cy = Math.floor(ys[i] / gap);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = cells.get(key(cx + dx, cy + dy));
        if (!list) continue;
        for (const j of list) {
          if (Math.hypot(xs[i] - xs[j], ys[i] - ys[j]) > gap) continue;
          const a = find(i), b = find(j);
          if (a !== b) parent[a] = b;
        }
      }
    }
    const own = cells.get(key(cx, cy));
    if (own) own.push(i);
    else cells.set(key(cx, cy), [i]);
  }
  const label = new Int32Array(n);
  const ids = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    label[i] = ids.get(r);
  }
  return label;
}

/**
 * The home a new note moves into: only when it has links and every one of
 * them leads into the same home. homeOf(j) is a neighbour's home id or null.
 */
export function adoptHome(neighbours, homeOf) {
  let hm = null;
  for (const j of neighbours) {
    const x = homeOf(j);
    if (!x || (hm && x !== hm)) return null;
    hm = x;
  }
  return hm;
}

/* ── hit testing ────────────────────────────────────────────────────────── */

/**
 * A hashed uniform grid over node positions. Rebuilt only when positions
 * changed since the last query, in O(n) with no allocation once sized.
 */
export function createHitGrid() {
  let head = new Int32Array(0);
  let next = new Int32Array(0);
  let mask = 0;
  let size = 40;
  let n = 0;
  let xs = null, ys = null;
  const slot = (cx, cy) => (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & mask;
  return {
    build(x, y, count, cellSize) {
      n = count;
      xs = x; ys = y;
      size = Math.max(4, cellSize);
      const want = Math.max(16, 1 << Math.ceil(Math.log2(count * 2 + 1)));
      if (head.length !== want) head = new Int32Array(want);
      if (next.length < count) next = new Int32Array(Math.max(count, next.length * 2));
      mask = want - 1;
      head.fill(-1);
      for (let i = 0; i < count; i++) {
        const h = slot(Math.floor(x[i] / size), Math.floor(y[i] / size));
        next[i] = head[h];
        head[h] = i;
      }
    },
    /** The node whose disc (radius r[i] + slop) holds the point, nearest centre first. */
    nearest(px, py, r, maxR, slop, ok) {
      let best = -1;
      let bd = Infinity;
      const reach = maxR + slop;
      const cx0 = Math.floor((px - reach) / size), cx1 = Math.floor((px + reach) / size);
      const cy0 = Math.floor((py - reach) / size), cy1 = Math.floor((py + reach) / size);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 64) {
        for (let i = 0; i < n; i++) test(i);
        return best;
      }
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let i = head[slot(cx, cy)]; i >= 0; i = next[i]) test(i);
        }
      }
      return best;
      function test(i) {
        if (ok && !ok[i]) return;
        const dx = xs[i] - px, dy = ys[i] - py;
        const d2 = dx * dx + dy * dy;
        const rr = r[i] + slop;
        if (d2 <= rr * rr && d2 - r[i] * r[i] < bd) { bd = d2 - r[i] * r[i]; best = i; }
      }
    },
    /** Indices whose centre lies in the rectangle. */
    rect(x0, y0, x1, y1, ok) {
      const out = [];
      const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
      for (let i = 0; i < n; i++) {
        if (ok && !ok[i]) continue;
        if (xs[i] >= ax && xs[i] <= bx && ys[i] >= ay && ys[i] <= by) out.push(i);
      }
      return out;
    },
  };
}

/* ── saved layout and comment frames (graph.json) ───────────────────────── */

export const FRAME_COLORS = 8;
export const FRAME_HEAD = 28; // header height, world units
export const MAX_SAVED = 20000;

const fin = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== "" ? +v : d);

/** A comment frame, sanitised: the file may have been edited by hand. */
export function cleanFrame(f, i = 0) {
  if (!f || typeof f !== "object") return null;
  return {
    id: typeof f.id === "string" && f.id ? f.id.slice(0, 40) : "f" + Date.now().toString(36) + i,
    x: Math.round(fin(f.x)),
    y: Math.round(fin(f.y)),
    w: Math.round(Math.min(1e6, Math.max(80, fin(f.w, 320)))),
    h: Math.round(Math.min(1e6, Math.max(FRAME_HEAD + 20, fin(f.h, 200)))),
    title: String(f.title ?? "Comment").slice(0, 200),
    note: String(f.note ?? "").slice(0, 1000),
    c: Math.abs(Math.round(fin(f.c))) % FRAME_COLORS,
  };
}

/**
 * graph.json as stored: { v, pos: { id: [x, y] }, pins: [id], frames, cam,
 * homes: [{ id, x, y, name }], home: { node id: home id } }.
 * Anything malformed is dropped rather than failing the view.
 */
export function readGraphDoc(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const pos = new Map();
  if (d.pos && typeof d.pos === "object") {
    for (const id in d.pos) {
      const p = d.pos[id];
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) pos.set(id, { x: p[0], y: p[1] });
      if (pos.size >= MAX_SAVED) break;
    }
  }
  const pins = Array.isArray(d.pins) ? d.pins.filter((x) => typeof x === "string" && pos.has(x)) : [];
  const frames = Array.isArray(d.frames) ? d.frames.slice(0, 500).map(cleanFrame).filter(Boolean) : [];
  const seen = new Set();
  const uniq = frames.filter((f) => !seen.has(f.id) && seen.add(f.id));
  const c = d.cam;
  const cam = c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.k) && c.k > 0 ? { x: c.x, y: c.y, k: c.k } : null;
  const homes = new Map();
  if (Array.isArray(d.homes)) {
    d.homes.slice(0, 2000).forEach((raw, i) => {
      const hm = cleanHome(raw, i);
      if (hm && !homes.has(hm.id)) homes.set(hm.id, hm);
    });
  }
  const homeOf = new Map();
  if (d.home && typeof d.home === "object") {
    for (const id in d.home) {
      if (homeOf.size >= MAX_SAVED) break;
      if (homes.has(d.home[id])) homeOf.set(id, d.home[id]);
    }
  }
  // a home nobody lives in is gone
  const used = new Set(homeOf.values());
  for (const id of [...homes.keys()]) if (!used.has(id)) homes.delete(id);
  return { pos, pins, frames: uniq, cam, homes, homeOf };
}

/**
 * The object to store. `alive(id)` drops what no longer exists; ids in
 * `first` (the graph on screen) are kept before the rest when over `cap`.
 */
export function writeGraphDoc({ pos, pins, frames, cam, homes = null, homeOf = null }, alive, first = [], cap = MAX_SAVED) {
  const out = {};
  let k = 0;
  const put = (id) => {
    if (k >= cap || id in out || !alive(id)) return;
    const p = pos.get(id);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    out[id] = [Math.round(p.x), Math.round(p.y)];
    k++;
  };
  for (const id of first) put(id);
  for (const id of pos.keys()) put(id);
  // homes: members that are still saved, homes that still have one
  const home = {};
  const used = new Set();
  if (homes && homeOf) {
    for (const [id, hid] of homeOf) {
      if (!(id in out) || !homes.has(hid)) continue;
      home[id] = hid;
      used.add(hid);
    }
  }
  return {
    v: 1,
    pos: out,
    pins: [...pins].filter((id) => id in out),
    frames: frames.map(cleanFrame),
    homes: homes ? [...homes.values()].filter((hm) => used.has(hm.id)).map(cleanHome) : [],
    home,
    cam: cam ? { x: Math.round(cam.x), y: Math.round(cam.y), k: Math.round(cam.k * 1e4) / 1e4 } : null,
  };
}

/** A home anchor, sanitised. */
export function cleanHome(hm, i = 0) {
  if (!hm || typeof hm !== "object") return null;
  return {
    id: typeof hm.id === "string" && hm.id ? hm.id.slice(0, 40) : "h" + Date.now().toString(36) + i,
    x: Math.round(fin(hm.x)),
    y: Math.round(fin(hm.y)),
    name: String(hm.name ?? "").slice(0, 120),
    // the note it centres on, when the user picked one (else the one with the most links)
    ...(typeof hm.core === "string" && hm.core ? { core: hm.core.slice(0, 400) } : {}),
  };
}

/** A frame round a set of points ({ x, y, r }), with room for labels. */
export function frameAround(points, pad = 36) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    const r = p.r || 0;
    x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r);
    y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
  }
  if (x0 === Infinity) return null;
  const x = x0 - pad;
  const y = y0 - pad - FRAME_HEAD;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(160, x1 + pad - x)), h: Math.round(Math.max(90, y1 + pad + 14 - y)) };
}

/** Frames whose title or note matches, best first. */
export function searchFrames(query, frames) {
  const q = String(query || "").trim();
  if (!q || q[0] === "#") return [];
  const hits = [];
  for (const f of frames) {
    const a = fuzzy(q, f.title);
    const b = f.note ? fuzzy(q, f.note) : null;
    const s = a ? a.score + 300 : b ? b.score : null;
    if (s !== null) hits.push([s, f]);
  }
  hits.sort((x, y) => y[0] - x[0]);
  return hits.map((x) => x[1]);
}

/* ── research boards ────────────────────────────────────────────────────── */

/**
 * Graph positions to board positions: scaled around their centre so the
 * layout carries over, then nudged apart so cards (w x h, centred on each
 * point) never cover each other.
 */
export function boardPlacement(points, { scale = 3, w = 400, h = 300, gap = 40 } = {}) {
  const k = points.length;
  if (!k) return [];
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= k; cy /= k;
  const out = points.map((p) => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale }));
  const W = w + gap, H = h + gap;
  if (k <= 400) {
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          const a = out[i], b = out[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const ox = W - Math.abs(dx), oy = H - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (dx === 0 && dy === 0) dx = j - i;
          // push along the axis that needs the smaller move
          if (ox * H < oy * W) { const s = (Math.sign(dx) || 1) * ox / 2; a.x -= s; b.x += s; }
          else { const s = (Math.sign(dy) || 1) * oy / 2; a.y -= s; b.y += s; }
        }
      }
      if (!moved) break;
    }
  }
  return out.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

/** Short board name from the notes on it. */
export function boardName(titles, focusTitle) {
  const base = focusTitle || titles[0] || "Graph";
  return `${base} research`;
}

/* ── correlation hints for the reading lens ─────────────────────────────── */

// Titles this short, or this common, would match half the vault.
const TITLE_STOP = new Set(["note", "notes", "index", "home", "readme", "todo", "inbox", "log", "new note", "untitled"]);
const WORDS_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const TITLE_WORDS = 6; // longest title, in words, worth looking for in a text

/** Title normalised the way a text is tokenised, so both sides match. */
export function titleKey(s) {
  const w = String(s || "").toLowerCase().match(WORDS_RE);
  return w ? w.slice(0, TITLE_WORDS).join(" ") : "";
}

/**
 * One cheap index per graph build: tag -> notes, and title -> note. Linear in
 * the nodes; every hint afterwards only walks a note's own tags and 2 hops.
 */
export function buildRelations(G) {
  const n = G.nodes.length;
  const tags = new Array(n);
  const byTag = new Map();
  const byTitle = new Map();
  let maxWords = 1;
  for (let i = 0; i < n; i++) {
    const nd = G.nodes[i];
    if (nd.kind !== "note") { tags[i] = null; continue; }
    tags[i] = nd.tags && nd.tags.length ? nd.tags : null;
    for (const t of tags[i] || []) {
      let list = byTag.get(t);
      if (!list) byTag.set(t, (list = []));
      list.push(i);
    }
    const key = titleKey(nd.label);
    if (key.length < 3 || TITLE_STOP.has(key)) continue;
    if (!byTitle.has(key)) byTitle.set(key, i);
    const w = key.split(" ").length;
    if (w > maxWords) maxWords = w;
  }
  return { n, nodes: G.nodes, tags, byTag, byTitle, maxWords, start: G.start, adj: G.adj };
}

/** Node indices whose title is named in `text`. One pass over the words. */
export function mentionedNodes(text, rel, cap = 40000) {
  const out = new Set();
  if (!text || !rel.byTitle.size) return out;
  const words = String(text).slice(0, cap).toLowerCase().match(WORDS_RE);
  if (!words) return out;
  for (let a = 0; a < words.length; a++) {
    let s = "";
    for (let w = 0; w < rel.maxWords && a + w < words.length; w++) {
      s = w ? s + " " + words[a + w] : words[a];
      const j = rel.byTitle.get(s);
      if (j !== undefined) out.add(j);
    }
  }
  return out;
}

// A name in the text is the strongest signal, a shared tag the weakest.
export const HINT_WEIGHT = { mention: 3, tags: 2, hops: 1.5 };

/**
 * Notes that look related to `i` but are not linked to it yet, best first.
 * `text` is the note's own content, for titles named inside it.
 */
export function relatedNodes(rel, i, { text = "", limit = 4, min = 2 } = {}) {
  const nd = rel.nodes[i];
  if (!nd || nd.kind !== "note") return [];
  const { start, adj, n } = rel;
  const linked = new Uint8Array(n);
  linked[i] = 1;
  for (let k = start[i]; k < start[i + 1]; k++) linked[adj[k]] = 1;
  const hits = new Map();
  const bump = (j, key, by) => {
    if (j === i || linked[j] || rel.nodes[j].kind !== "note") return;
    let e = hits.get(j);
    if (!e) hits.set(j, (e = { i: j, mention: 0, tags: 0, hops: 0, score: 0 }));
    e[key] += by;
  };
  // common neighbours, through the links of the links
  for (let k = start[i]; k < start[i + 1]; k++) {
    const a = adj[k];
    if (rel.nodes[a].kind !== "note") continue;
    for (let q = start[a]; q < start[a + 1]; q++) bump(adj[q], "hops", 1);
  }
  for (const t of rel.tags[i] || []) for (const j of rel.byTag.get(t) || []) bump(j, "tags", 1);
  for (const j of mentionedNodes(text, rel)) bump(j, "mention", 1);

  const out = [];
  for (const e of hits.values()) {
    e.score = e.mention * HINT_WEIGHT.mention + e.tags * HINT_WEIGHT.tags + e.hops * HINT_WEIGHT.hops;
    if (e.score >= min) out.push(e);
  }
  out.sort((a, b) => b.score - a.score || String(rel.nodes[a.i].label).localeCompare(String(rel.nodes[b.i].label)));
  const top = out.slice(0, limit);
  for (const e of top) e.why = hintWhy(e);
  return top;
}

/** One short sentence for why two notes might belong together. */
export function hintWhy(e) {
  const bits = [];
  if (e.mention) bits.push("named in the text");
  if (e.tags) bits.push(e.tags === 1 ? "a shared tag" : `${e.tags} shared tags`);
  if (e.hops) bits.push(e.hops === 1 ? "1 note links to both" : `${e.hops} notes link to both`);
  return bits.join(" · ");
}

/* ── writing a link into a note ─────────────────────────────────────────── */

export const CONNECTIONS_RE = /^[ \t]*#{2,6}[ \t]+connections[ \t]*#*[ \t]*$/im;
const RELATED_RE = /^\s*(related|see also)\s*:/i;
const BULLET_RE = /^\s*([-*+]|\d+[.)])\s/;

/**
 * Append `- [[target]]` under a "## Connections" heading when the note has
 * one, otherwise a short "Related:" line at the end (extending one if it is
 * already there). Pure, so the undo path is just the old string back.
 */
export function addLinkLine(content, target) {
  const link = `[[${target}]]`;
  const body = String(content == null ? "" : content);
  const lines = (body.endsWith("\n") ? body.slice(0, -1) : body).split("\n");
  const m = CONNECTIONS_RE.exec(body);
  if (m) {
    const at = body.slice(0, m.index).split("\n").length - 1;
    let ins = at + 1;
    for (let k = at + 1; k < lines.length; k++) {
      if (!lines[k].trim()) continue;
      if (BULLET_RE.test(lines[k])) { ins = k + 1; continue; }
      break;
    }
    lines.splice(ins, 0, "- " + link);
  } else {
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    // the first Related line, wherever it is (written text may have followed it): the link joins it
    const rel = lines.findIndex((l) => RELATED_RE.test(l));
    if (rel >= 0) lines[rel] = lines[rel].replace(/\s+$/, "") + " · " + link;
    else {
      lines.length = last + 1;
      if (lines.length) lines.push("");
      lines.push("Related: " + link);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * The timeline: each note (or attachment) left to right by when it last changed, in a lane of its top folder;
 * what has no time of its own (a tag, an unresolved link) sits under them, at the middle of what it links to.
 * timeOf(node) -> ms since 1970, or 0. The oldest 2% are drawn at the left edge, so one ancient note does not
 * squeeze all the rest into a corner. -> { x, y, lanes: [{ name, y }], t0, t1, width, lane }
 */
export function timelineLayout(G, timeOf, { width = 0, lane = 90 } = {}) {
  const n = G.nodes.length;
  // as wide as the notes need: a few notes make a short line, not tiny dots on a long one
  if (!width) width = Math.min(2400, Math.max(360, n * 14));
  const x = new Float64Array(n), y = new Float64Array(n);
  const t = G.nodes.map((nd) => Number(timeOf(nd)) || 0);
  const known = t.filter((v) => v > 0).sort((a, b) => a - b);
  const t0 = known.length ? known[Math.floor(known.length * 0.02)] : 0;
  const t1 = known.length ? known[known.length - 1] : 1;
  const span = Math.max(1, t1 - t0);
  const laneOf = (nd) => { const p = nd.path || ""; const i = p.indexOf("/"); return i > 0 ? p.slice(0, i) : "Top level"; };
  const names = [...new Set(G.nodes.filter((_, i) => t[i] > 0).map(laneOf))].sort((a, b) => a.localeCompare(b));
  const untimed = t.some((v) => !(v > 0));
  const rows = names.length + (untimed ? 1 : 0);
  const rowY = (k) => (k - (rows - 1) / 2) * lane;
  const idx = new Map(names.map((nm, k) => [nm, k]));
  // a dot keeps its place inside its lane: a small spread from its id, so the same note is always at the same height
  const spread = (id) => { let hsh = 0; for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) | 0; return ((Math.abs(hsh) % 1000) / 1000 - 0.5) * lane * 0.62; };
  for (let i = 0; i < n; i++) {
    if (!(t[i] > 0)) continue;
    x[i] = ((Math.max(t[i], t0) - t0) / span) * width - width / 2;
    y[i] = rowY(idx.get(laneOf(G.nodes[i]))) + spread(G.nodes[i].id);
  }
  for (let i = 0; i < n; i++) {
    if (t[i] > 0) continue;
    let sum = 0, c = 0;
    for (let k = G.start[i]; k < G.start[i + 1]; k++) { const j = G.adj[k]; if (t[j] > 0) { sum += x[j]; c++; } }
    x[i] = c ? sum / c : 0;
    y[i] = rowY(names.length) + spread(G.nodes[i].id);
  }
  const lanes = names.map((name, k) => ({ name, y: rowY(k) }));
  if (untimed) lanes.push({ name: "Tags and links", y: rowY(names.length) });
  return { x, y, lanes, t0, t1, width, lane };
}

