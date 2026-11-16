// Matching an imported track list against the music this computer already
// has. Nothing is fetched or streamed from the service the list came from:
// the list is names, and names are all we compare.
//
// Pure on purpose - the scoring is the part that decides whether a row plays
// or stays grey, so it is the part worth testing.

const STRIP = [
  /\((?:feat|ft|featuring|with)\.?[^)]*\)/gi,
  /\[(?:feat|ft|featuring|with)\.?[^\]]*\]/gi,
  /\((?:\d{4}\s*)?(?:remaster(?:ed)?|remix|mono|stereo|deluxe|bonus|live|edit|version|radio edit|album version|single version)[^)]*\)/gi,
  /\[(?:\d{4}\s*)?(?:remaster(?:ed)?|remix|mono|stereo|deluxe|bonus|live|edit|version)[^\]]*\]/gi,
  /\s[-–—]\s(?:\d{4}\s*)?(?:remaster(?:ed)?(?:\s*\d{4})?|mono|stereo|live|radio edit|single version|album version)\b.*$/gi,
  /\b(?:feat|ft|featuring)\.?\s+.*$/gi,
];

/** Case, accents, punctuation and "(2019 Remaster)" all stop mattering. */
export function norm(s) {
  let t = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const re of STRIP) t = t.replace(re, " ");
  return t
    .replace(/&/g, " and ")
    .replace(/[_'’`"“”]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A file name like "03 - Artist - Title" keeps only what is comparable. */
export const normArtist = (s) => norm(String(s || "").replace(/\s*(?:,|&|and|feat\.?|ft\.?|x)\s*/gi, " "));

const words = (s) => new Set(norm(s).split(" ").filter(Boolean));

/** How much of `a`'s words `b` also has (0..1). */
export function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size);
}

/**
 * 0..1 for "is this local file that track?". Title carries most of it,
 * the artist confirms it, a matching length nudges, a clash pulls down.
 */
export function score(track, cand) {
  const t = norm(track.title);
  const c = norm(cand.title);
  if (!t || !c) return 0;
  let s = t === c ? 1 : c.includes(t) || t.includes(c) ? 0.86 : overlap(t, c) * 0.82;
  if (s < 0.3) return 0;
  const ta = (track.artists || []).join(" ");
  if (ta && cand.artist) {
    const a = overlap(normArtist(ta), normArtist(cand.artist));
    s = s * 0.72 + a * 0.28;
    if (a === 0) s -= 0.12; // a different artist with the same song title
  } else if (ta && cand.album && overlap(normArtist(ta), norm(cand.album)) > 0.5) {
    s += 0.04; // the folder is named after the artist
  }
  if (track.duration && cand.duration) {
    const d = Math.abs(track.duration - cand.duration);
    if (d <= 3) s += 0.06;
    else if (d > 25) s -= 0.18; // a different recording, or the wrong song
  }
  return Math.max(0, Math.min(1, s));
}

/**
 * Best local file per track. `candidates` are { key, title, artist, album,
 * duration }. Returns the tracks with `key` and `score` filled in where a
 * match was good enough, plus a count.
 */
export function matchTracks(tracks, candidates, { min = 0.62 } = {}) {
  // a small index on the first title word keeps this linear-ish for big libraries
  const byWord = new Map();
  for (const c of candidates) {
    for (const w of words(c.title)) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(c);
    }
  }
  let matched = 0;
  const out = tracks.map((t) => {
    const seen = new Set();
    let best = null;
    let bestScore = 0;
    for (const w of words(t.title)) {
      for (const c of byWord.get(w) || []) {
        if (seen.has(c)) continue;
        seen.add(c);
        const s = score(t, c);
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    if (best && bestScore >= min) { matched++; return { ...t, key: best.key, score: Math.round(bestScore * 100) / 100 }; }
    return { ...t, key: "", score: Math.round(bestScore * 100) / 100 };
  });
  return { tracks: out, matched, total: tracks.length };
}

/**
 * Songs from Shazam: the CSV shazam.com (My Shazam) downloads - a "Shazam Library" line, then
 * Index, TagTime, Title, Artist, URL, TrackKey - or any list of "Artist - Title" lines. `rows` is the
 * CSV parsed (officeview's parseCsv). Each song once, newest first as Shazam lists them.
 */
export function shazamTracks(text, rows) {
  const out = [];
  const seen = new Set();
  const put = (title, artist, url) => {
    title = String(title || "").trim();
    artist = String(artist || "").trim();
    const k = (title + "|" + artist).toLowerCase();
    if (!title || seen.has(k)) return;
    seen.add(k);
    out.push({ title, artists: artist ? [artist] : [], url: /^https?:/i.test(url || "") ? url : "" });
  };
  const head = rows.findIndex((r) => r.some((c) => /^title$/i.test(c.trim())) && r.some((c) => /^artist$/i.test(c.trim())));
  if (head >= 0) {
    const col = (name) => rows[head].findIndex((c) => c.trim().toLowerCase() === name);
    const [t, a, u] = [col("title"), col("artist"), col("url")];
    for (const r of rows.slice(head + 1)) put(r[t], r[a], u >= 0 ? r[u] : "");
    return out;
  }
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:\d+[.)]\s*)?(.+?)\s+[-–—]\s+(.+?)\s*$/.exec(line);
    if (m) put(m[2], m[1]);
  }
  return out;
}
