// Fuzzy matching for the switcher/palette and full-text search over the vault.
// Everything is in memory: at vault sizes people actually have, a linear scan
// is faster than maintaining an index, and it can never be stale.

/**
 * Subsequence fuzzy match. Returns { score, hits } or null.
 * Rewards: contiguous runs, matches at word starts, a prefix match, and
 * shorter candidates. The same shape as every good quick-open.
 */
export function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // exact substring beats any scattered match
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const hits = [];
    for (let i = 0; i < q.length; i++) hits.push(sub + i);
    const atWord = sub === 0 || /[\s/_\-.]/.test(t[sub - 1]);
    return { score: 1000 - sub * 2 + (atWord ? 200 : 0) + (sub === 0 ? 150 : 0) - t.length * 0.5, hits };
  }

  let score = 0;
  let ti = 0;
  let run = 0;
  const hits = [];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === " ") continue;
    let found = -1;
    // prefer the next occurrence at a word boundary within a short window
    for (let j = ti; j < t.length; j++) {
      if (t[j] === c) {
        if (found < 0) found = j;
        if (j === 0 || /[\s/_\-.]/.test(t[j - 1])) { found = j; break; }
        if (j - ti > 12) break;
      }
    }
    if (found < 0) return null;
    const boundary = found === 0 || /[\s/_\-.]/.test(t[found - 1]);
    run = hits.length && hits[hits.length - 1] === found - 1 ? run + 1 : 0;
    score += 10 + run * 15 + (boundary ? 25 : 0) - Math.min(found - ti, 10);
    hits.push(found);
    ti = found + 1;
  }
  return { score: score - t.length * 0.5, hits };
}

/** Wrap matched character positions in <mark>, as DOM nodes. */
export function highlight(text, hits) {
  const frag = document.createDocumentFragment();
  if (!hits || !hits.length) { frag.append(text); return frag; }
  const set = new Set(hits);
  let buf = "";
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) { const m = document.createElement("mark"); m.textContent = buf; frag.append(m); }
    else frag.append(buf);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const on = set.has(i);
    if (on !== inMark) { flush(); inMark = on; }
    buf += text[i];
  }
  flush();
  return frag;
}

/**
 * Parse a search query: plain terms (AND), "quoted phrases", #tag filters,
 * path:folder filters, -negated terms. Everything comes back lowercased except
 * `raw`: the plain terms as typed, for Match case.
 */
export function parseQuery(q) {
  const terms = [];
  const raw = [];
  const not = [];
  const tags = [];
  const paths = [];
  const notTags = [];
  const notPaths = [];
  // path:"Work notes" and tag:"..." take the quoted words whole; a leading - leaves those notes out
  const re = /(-?)(?:(path:|tag:)?"([^"]+)"|(\S+))/gi;
  let m;
  while ((m = re.exec(q))) {
    const neg = m[1] === "-";
    const quoted = m[3] != null;
    const v = (quoted ? m[3] : m[4]).toLowerCase();
    const kind = m[2] ? m[2].toLowerCase() : quoted ? "" : v.startsWith("path:") ? "path:" : v.startsWith("tag:") ? "tag:" : v.startsWith("#") && v.length > 1 ? "#" : "";
    if (kind) {
      const val = m[2] ? v : v.slice(kind.length);
      const name = kind === "path:" ? val : val.replace(/^#/, "");
      if (!name) continue;
      (kind === "path:" ? (neg ? notPaths : paths) : (neg ? notTags : tags)).push(name);
      continue;
    }
    if (!v) continue;
    if (neg) { not.push(v); continue; }
    terms.push(v);
    raw.push(quoted ? m[3] : m[4]);
  }
  return { terms, raw, not, tags, paths, notTags, notPaths };
}

/**
 * Full-text search. `notes` is an iterable of { path, title, content, lower, tags }.
 * Returns results sorted by relevance with up to 3 snippets each.
 */
export function searchVault(notes, query, limit = 80) {
  const pq = parseQuery(query);
  if (!pq.terms.length && !pq.tags.length && !pq.paths.length) return [];
  const results = [];

  for (const n of notes) {
    const lower = n.lower;
    const titleLower = n.title.toLowerCase();
    if (pq.paths.length && !pq.paths.every((p) => n.path.toLowerCase().includes(p))) continue;
    if (pq.tags.length && !pq.tags.every((t) => n.tags.some((nt) => nt === t || nt.startsWith(t + "/")))) continue;
    if (pq.not.some((t) => lower.includes(t) || titleLower.includes(t))) continue;
    if (pq.notPaths.some((p) => n.path.toLowerCase().includes(p))) continue;
    if (pq.notTags.some((t) => n.tags.some((nt) => nt === t || nt.startsWith(t + "/")))) continue;

    let score = 0;
    let ok = true;
    for (const term of pq.terms) {
      const inTitle = titleLower.includes(term);
      const inBody = lower.includes(term);
      if (!inTitle && !inBody) { ok = false; break; }
      if (inTitle) score += titleLower === term ? 120 : titleLower.startsWith(term) ? 80 : 50;
      if (inBody) {
        let c = 0;
        let i = lower.indexOf(term);
        while (i >= 0 && c < 50) { c++; i = lower.indexOf(term, i + term.length); }
        score += 10 + Math.log2(1 + c) * 6;
      }
    }
    if (!ok) continue;
    if (!pq.terms.length) score = 1;
    results.push({ note: n, score });
  }

  results.sort((a, b) => b.score - a.score || b.note.mtime - a.note.mtime);
  // snippets for the kept results only: they are the costly part on a large vault
  return results.slice(0, limit).map((r) => ({ ...r, snippets: pq.terms.length ? snippets(r.note.content, pq.terms) : [] }));
}

function snippets(content, terms, max = 3) {
  const out = [];
  const lines = content.split("\n");
  for (let li = 0; li < lines.length && out.length < max; li++) {
    const line = lines[li];
    const low = line.toLowerCase();
    const ranges = [];
    for (const t of terms) {
      let i = low.indexOf(t);
      while (i >= 0) { ranges.push([i, i + t.length]); i = low.indexOf(t, i + t.length); }
    }
    if (!ranges.length) continue;
    ranges.sort((a, b) => a[0] - b[0]);
    // window the line around the first hit
    const first = ranges[0][0];
    const start = Math.max(0, first - 40);
    const end = Math.min(line.length, start + 160);
    const shown = unmark((start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : ""), ranges
      .filter((r) => r[0] >= start && r[1] <= end)
      .map((r) => [r[0] - start + (start > 0 ? 1 : 0), r[1] - start + (start > 0 ? 1 : 0)]));
    out.push({
      line: li,
      text: shown.text,
      ranges: shown.ranges,
      offset: lines.slice(0, li).reduce((s, l) => s + l.length + 1, 0) + first,
    });
  }
  return out;
}

/** A preview line without the ==highlight== marks, the hits' places moved to match. */
export function unmark(text, ranges) {
  const cut = [];
  const re = /==/g;
  for (let m; (m = re.exec(text)); ) cut.push(m.index);
  if (!cut.length) return { text, ranges };
  const shift = (i) => i - cut.filter((c) => c < i).length * 2;
  return { text: text.replace(/==/g, ""), ranges: ranges.map(([a, b]) => [shift(a), shift(b)]).filter(([a, b]) => b > a) };
}

export function markRanges(text, ranges) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    frag.append(text.slice(at, a));
    const m = document.createElement("mark");
    m.textContent = text.slice(a, b);
    frag.append(m);
    at = b;
  }
  frag.append(text.slice(at));
  return frag;
}
