// Song facts for the player: tags, a small cover and the duration. Read once
// per file version (path + mtime) and kept in IndexedDB; the tag comes from
// the first bytes only (a Range request), never the whole file.

import { deadline } from "./util.js";
import { parseId3, id3Size, titleFromName } from "./id3.js";
import { isLib, libPath } from "./playqueue.js";

const DB = "leonote-media";
const STORE = "meta";
const VERSION = 3; // bump to re-read everything after a parser change (3: every audio format, and its Grouping tags)
const mem = new Map(); // key -> meta (with a live cover URL), the most recently used last
const MEM_MAX = 600; // songs' details kept at once; one pushed out lets its cover go (a picture on screen keeps showing)
const drop = (k) => { const m = mem.get(k); if (m && m.cover) URL.revokeObjectURL(m.cover); mem.delete(k); };
const remember = (k, v) => { if (mem.has(k)) drop(k); mem.set(k, v); while (mem.size > MEM_MAX) drop(mem.keys().next().value); };
const waiting = new Map(); // key -> promise
let dbP = null;

function db() {
  if (dbP) return dbP;
  dbP = new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbP;
}
async function idb(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

const keyOf = (f) => `${f.path}|${f.mtime || 0}|${VERSION}`;
const folderOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/** A file's details were rewritten: what was read of it goes, so the next look reads it again. */
export function forgetMeta(f) {
  if (!f) return;
  for (const k of [...mem.keys()]) if (k.startsWith(f.path + "|")) drop(k);
}
const AUDIO = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|aiff?|wma|ape|wv|mpc)$/i;
const fromB64 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

/** What we know right now, without waiting (null until read). */
export function peekMeta(f) {
  if (!f) return null;
  const k = keyOf(f), m = mem.get(k);
  if (m) { mem.delete(k); mem.set(k, m); } // used: to the back of the line
  return m || null;
}

/** A name-based guess, good enough to draw a row before the tags arrive. */
export function guessMeta(path) {
  const g = titleFromName(path);
  const folder = folderOf(path);
  return { title: g.title, artist: g.artist || "", album: folder.slice(folder.lastIndexOf("/") + 1), track: g.track, guess: true };
}

async function head(url, bytes) {
  // a Range request first; a server that ignores it still only gets read
  // as far as we need, then the rest of the body is dropped
  // a song by its web address is a request outside: it gets a deadline (a file of the vault answers at once)
  const r = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: deadline(15000) });
  if (!r.ok && r.status !== 206) throw new Error("HTTP " + r.status);
  if (!r.body) return new Uint8Array(await r.arrayBuffer()).subarray(0, bytes);
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  while (n < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, bytes));
  let o = 0;
  for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break; }
  return out;
}

// a cover shrunk to 320px webp: small in the database, quick to paint
async function shrink(blob, size = 320) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const hgt = Math.max(1, Math.round(bmp.height * k));
    const c = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, hgt) : Object.assign(document.createElement("canvas"), { width: w, height: hgt });
    c.getContext("2d").drawImage(bmp, 0, 0, w, hgt);
    bmp.close && bmp.close();
    return c.convertToBlob ? await c.convertToBlob({ type: "image/webp", quality: 0.82 }) : await new Promise((r) => c.toBlob(r, "image/webp", 0.82));
  } catch { return null; }
}

let probeChain = Promise.resolve();
/** Duration via a throwaway media element, one at a time. */
function probeDuration(url) {
  const run = () => new Promise((resolve) => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); el.removeAttribute("src"); el.load(); resolve(v); };
    const t = setTimeout(() => end(0), 8000);
    el.onloadedmetadata = () => end(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => end(0);
    el.src = url;
  });
  const p = probeChain.then(run);
  probeChain = p.catch(() => {});
  return p;
}

// a vault path, or a file in a library folder outside it
const nameOf = (key) => (isLib(key) ? libPath(key) : key);
const urlOf = (app, key) => {
  if (!isLib(key)) return app.host.assetUrl(key);
  const e = app.media && app.media.libraries.entry(key);
  return e ? app.host.assetAbs(e.abs) : "";
};

/**
 * Full metadata for a media file (vault or library): { title, artist, album, year, track,
 * duration, cover (object URL or ""), folderCover? }. Never rejects.
 */
export function loadMeta(app, f) {
  const key = keyOf(f);
  if (mem.has(key)) return Promise.resolve(mem.get(key));
  if (waiting.has(key)) return waiting.get(key);
  const p = (async () => {
    let rec = await idb("readonly", (s) => s.get(key));
    if (!rec) {
      const name = nameOf(f.path);
      rec = { ...guessMeta(name), guess: false };
      const url = urlOf(app, f.path);
      // the app reads every format (m4a, flac, ogg too) and the Grouping field the tags live in
      let read = false;
      if (app.host.musicTags && AUDIO.test(name)) {
        try {
          const t = await app.host.musicTags(f.path, true);
          for (const k of ["title", "artist", "album", "albumArtist", "year", "genre", "grouping"]) if (t[k]) rec[k] = t[k];
          if (t.track) rec.track = Number(t.track) || t.track;
          if (t.duration > 0) rec.duration = t.duration;
          if (t.cover && t.cover.data) rec.coverBlob = await shrink(new Blob([fromB64(t.cover.data)], { type: t.cover.mime || "image/jpeg" }));
          read = true;
        } catch { /* a file the app may not read (outside your folders): the page reads what it can */ }
      }
      if (!read && /\.mp3$/i.test(name) && url) {
        try {
          let b = await head(url, 256 * 1024);
          const need = id3Size(b);
          if (need > b.length && need < 8 * 1024 * 1024) b = await head(url, need);
          const t = parseId3(b);
          for (const k of ["title", "artist", "album", "albumArtist", "year", "track", "genre"]) if (t[k]) rec[k] = t[k];
          if (t.cover) rec.coverBlob = await shrink(new Blob([t.cover.data], { type: t.cover.mime }));
        } catch { /* keep the guess */ }
      }
      if (!rec.duration && url && /^(blob:|https?:|asset:)/.test(url)) rec.duration = await probeDuration(url);
      idb("readwrite", (s) => s.put(rec, key));
    }
    const out = { ...rec, cover: rec.coverBlob ? URL.createObjectURL(rec.coverBlob) : "" };
    delete out.coverBlob;
    remember(key, out);
    waiting.delete(key);
    return out;
  })().catch(() => {
    // a read that failed still counts as answered: callers repaint when the
    // metadata arrives, and a "still guessing" answer would ask again forever
    waiting.delete(key);
    const g = { ...guessMeta(nameOf(f.path)), guess: false };
    remember(key, g);
    return g;
  });
  waiting.set(key, p);
  return p;
}

const COVER_NAMES = /^(cover|folder|front|album|albumart|albumartsmall)\.(jpe?g|png|webp)$/i;
/** A cover picture sitting in the song's folder (cover.jpg, folder.png...), as a vault path. */
export function folderCover(app, path) {
  const dir = folderOf(path);
  let best = null;
  const files = isLib(path) ? (app.media ? app.media.libraries.files().values() : []) : app.vault.files.values();
  for (const f of files) {
    if (f.kind !== "image" || folderOf(f.path) !== dir) continue;
    const n = f.path.slice(dir ? dir.length + 1 : 0);
    if (COVER_NAMES.test(n)) { if (!best || /^cover/i.test(n)) best = f.path; }
  }
  return best;
}

/** The picture URL for a cover found by `folderCover` (vault or library). */
export const coverUrl = (app, key) => urlOf(app, key);
