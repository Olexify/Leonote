// The play queue as plain data: items are keys ("path/to/song.mp3" or
// "yt:VIDEOID"). Pure, so shuffle / repeat / reorder rules are tested.

export const ytKey = (id) => "yt:" + id;
export const isYt = (key) => typeof key === "string" && key.startsWith("yt:");
export const ytIdOf = (key) => (isYt(key) ? key.slice(3) : "");

/**
 * A playlist brought up to date with YouTube's list (`fetched`, in YouTube's
 * order). Your order stays; a new video goes in where YouTube has it - before
 * the next video both lists share, else at the end. What YouTube no longer
 * lists stays unless it is in `drop`; what is in `skip` (taken out here) is
 * not brought back. Returns { items, added }.
 */
export function mergeYtList(items, fetched, drop = new Set(), skip = new Set()) {
  const out = items.filter((k) => !drop.has(k));
  const have = new Set(items);
  const added = [];
  for (let i = fetched.length - 1; i >= 0; i--) {
    const k = fetched[i];
    if (have.has(k) || skip.has(k)) continue;
    let at = out.length;
    for (let j = i + 1; j < fetched.length; j++) { const n = out.indexOf(fetched[j]); if (n >= 0) { at = n; break; } }
    out.splice(at, 0, k);
    have.add(k);
    added.unshift(k);
  }
  return { items: out, added };
}
// direct links to media files on the web ("url:https://…/song.mp3")
export const urlKey = (url) => "url:" + url;
export const isUrl = (key) => typeof key === "string" && key.startsWith("url:");
export const urlOf = (key) => (isUrl(key) ? key.slice(4) : "");
export const isOnline = (key) => isYt(key) || isUrl(key);
// files in a media library outside the vault ("lib:D:/Music/a.mp3"); the key
// always uses forward slashes, the entry keeps the real OS path
export const libKey = (abs) => "lib:" + String(abs).split("\\").join("/");
export const isLib = (key) => typeof key === "string" && key.startsWith("lib:");
export const libPath = (key) => (isLib(key) ? key.slice(4) : "");
/** A vault path or a library file: anything that lives on this computer. */
export const isLocal = (key) => !isOnline(key);

const MEDIA_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4v|webm|mov)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
/** { url, name, audio } for an http(s) link to an audio or video file, else null. */
export function parseDirect(input) {
  const s = String(input || "").trim();
  if (!/^https?:\/\//i.test(s) || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  const path = decodeURIComponent(u.pathname);
  if (!MEDIA_EXT.test(path)) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { url: u.href, name, audio: AUDIO_EXT.test(path) };
}
export const looksLikeUrl = (s) => /^(https?:\/\/|www\.|youtu\.?be)/i.test(String(s || "").trim()) && !/\s/.test(String(s).trim());

/* search: accent- and case-insensitive, every word must match */
const fold1 = (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const fold = (s) => fold1(String(s || ""));
export const terms = (q) => fold(q).split(/\s+/).filter(Boolean);
export function matchesAll(fields, words) {
  if (!words.length) return true;
  const hay = fold(fields.filter(Boolean).join("  "));
  return words.every((w) => hay.includes(w));
}
/** [from, to) ranges in `text` where any of `words` appear (folded). */
export function markRanges(text, words) {
  if (!text || !words.length) return [];
  // folded text with a map back to the original positions
  let folded = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold1(text[i]);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }
  map.push(text.length);
  const hits = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + 1)) hits.push([map[at], map[at + w.length - 1] + 1]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of hits) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r.slice());
  }
  return out;
}

export function createQueue(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  const q = {
    items: Array.isArray(s.items) ? s.items.filter((k) => typeof k === "string") : [],
    index: Number.isInteger(s.index) ? s.index : -1,
    shuffle: !!s.shuffle,
    repeat: ["off", "all", "one"].includes(s.repeat) ? s.repeat : "off",
    history: [], // indices played, for "previous" in shuffle
  };
  if (q.index >= q.items.length) q.index = q.items.length ? 0 : -1;
  return q;
}

export const current = (q) => (q.index >= 0 ? q.items[q.index] : null);
export const snapshot = (q) => ({ items: q.items, index: q.index, shuffle: q.shuffle, repeat: q.repeat });

/** Replace the queue with `keys`, starting at `start`. */
export function setItems(q, keys, start = 0) {
  q.items = [...new Set(keys)];
  q.index = q.items.length ? Math.max(0, Math.min(start, q.items.length - 1)) : -1;
  q.history = [];
}

/** Put keys right after the current item (or at the end); returns the first key's index. */
/** `before`: just ahead of what is current, which stays current - Next from the newcomer leads back to it. */
export function insert(q, keys, { next = false, before = false, at: where = -1 } = {}) {
  const add = keys.filter((k) => !q.items.includes(k));
  // `at`: a given place; whatever is current there or later moves along and stays current
  if (where >= 0 && where <= q.items.length) before = where <= q.index;
  const at = where >= 0 && where <= q.items.length ? where : before && q.index >= 0 ? q.index : next && q.index >= 0 ? q.index + 1 : q.items.length;
  q.items.splice(at, 0, ...add);
  if (before && q.index >= 0 && add.length) {
    q.index += add.length;
    q.history = q.history.map((h) => (h >= at ? h + add.length : h));
  }
  if (q.index < 0 && q.items.length) q.index = 0;
  return add.length ? at : q.items.indexOf(keys[0]);
}

export function remove(q, i) {
  if (i < 0 || i >= q.items.length) return;
  q.items.splice(i, 1);
  q.history = q.history.filter((h) => h !== i).map((h) => (h > i ? h - 1 : h));
  if (i < q.index) q.index--;
  else if (i === q.index && q.index >= q.items.length) q.index = q.items.length - 1;
}

/** Drag from -> to (the index the item ends up at). */
export function move(q, from, to) {
  if (from === to || from < 0 || from >= q.items.length) return;
  to = Math.max(0, Math.min(to, q.items.length - 1));
  const [k] = q.items.splice(from, 1);
  q.items.splice(to, 0, k);
  const cur = q.index;
  if (cur === from) q.index = to;
  else if (from < cur && to >= cur) q.index--;
  else if (from > cur && to <= cur) q.index++;
  q.history = [];
}

/** Swap one key for another everywhere in the queue (an online item saved to the vault). */
export function replaceKey(q, from, to) {
  if (q.items.includes(to)) { const i = q.items.indexOf(from); if (i >= 0 && i !== q.index) remove(q, i); else if (i >= 0) q.items[i] = to; }
  else q.items = q.items.map((k) => (k === from ? to : k));
}

export function rename(q, from, to) {
  q.items = q.items.map((k) => (k === from ? to : k.startsWith(from + "/") ? to + k.slice(from.length) : k));
}

/**
 * The index to play after the current one, or -1 to stop.
 * `auto` is true when a track ended by itself (repeat-one only applies then).
 */
export function nextIndex(q, { auto = false, rand = Math.random } = {}) {
  const n = q.items.length;
  if (!n) return -1;
  if (auto && q.repeat === "one") return q.index;
  if (q.shuffle && n > 1) {
    const played = new Set(q.history);
    played.add(q.index);
    let left = [];
    for (let i = 0; i < n; i++) if (!played.has(i)) left.push(i);
    if (!left.length) {
      if (q.repeat === "off" && auto) return -1;
      q.history = [];
      left = [...Array(n).keys()].filter((i) => i !== q.index);
    }
    return left[Math.floor(rand() * left.length)];
  }
  if (q.index + 1 < n) return q.index + 1;
  return q.repeat === "off" && auto ? -1 : 0;
}

export function prevIndex(q) {
  const n = q.items.length;
  if (!n) return -1;
  if (q.shuffle && q.history.length) return q.history[q.history.length - 1];
  if (q.index > 0) return q.index - 1;
  return q.repeat === "off" ? 0 : n - 1;
}

/** Move to `i`, remembering where we were (for shuffle's "previous"). */
export function go(q, i, { back = false } = {}) {
  if (i < 0 || i >= q.items.length) return null;
  if (back) q.history.pop();
  else if (q.index >= 0 && q.index !== i) q.history.push(q.index);
  if (q.history.length > 500) q.history.shift();
  q.index = i;
  return q.items[i];
}

/** An extended M3U playlist. `titleOf(key)` -> { title, artist, duration }. */
export function toM3u8(name, keys, titleOf = () => ({})) {
  const lines = ["#EXTM3U", `#PLAYLIST:${name}`];
  for (const k of keys) {
    const m = titleOf(k) || {};
    const label = [m.artist, m.title].filter(Boolean).join(" - ");
    if (label) lines.push(`#EXTINF:${Math.round(m.duration || -1)},${label}`);
    lines.push(isYt(k) ? `https://www.youtube.com/watch?v=${ytIdOf(k)}` : isUrl(k) ? urlOf(k) : isLib(k) ? libPath(k) : k);
  }
  return lines.join("\n") + "\n";
}

/** Keys from M3U text; relative paths resolve against `dir`. */
export function fromM3u(text, dir = "") {
  const out = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(line);
    if (yt) { out.push(ytKey(yt[1])); continue; }
    if (parseDirect(line)) { out.push(urlKey(parseDirect(line).url)); continue; }
    if (/^[a-z]:[\\/]/i.test(line)) { out.push(libKey(line)); continue; }
    if (/^[a-z]+:/i.test(line)) continue;
    const p = line.replace(/\\/g, "/").replace(/^\.\//, "");
    out.push(dir && !p.startsWith("/") ? dir + "/" + p : p.replace(/^\//, ""));
  }
  return out;
}

/** A deterministic soft two-colour gradient for a name (cover placeholder). */
export function gradientFor(name) {
  let hsh = 2166136261;
  for (let i = 0; i < name.length; i++) hsh = Math.imul(hsh ^ name.charCodeAt(i), 16777619);
  const a = (hsh >>> 0) % 360;
  const b = (a + 40 + ((hsh >>> 9) % 80)) % 360;
  return `linear-gradient(135deg, hsl(${a} 55% 46%), hsl(${b} 60% 30%))`;
}
