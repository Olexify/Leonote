// A small ID3v2 reader: title, artist, album, year, track and the embedded
// cover. Pure (bytes in, object out), so it runs in tests and never throws on
// a broken tag: whatever it could read comes back.

/** Bytes an ID3v2 tag at the start of `b` occupies (0 when there is none). */
export function id3Size(b) {
  if (!b || b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = syncsafe(b, 6);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

// undo "unsynchronisation": every FF 00 was written for a bare FF
function unsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return out.subarray(0, n);
}

function decoderFor(enc) {
  const label = enc === 0 ? "latin1" : enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : "utf-8";
  try { return new TextDecoder(label); } catch { return new TextDecoder(); }
}
// where a string ends: one zero byte, or two aligned ones for UTF-16
function strEnd(b, from, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, from);
  return i < 0 ? b.length : i;
}
const clean = (s) => s.replace(/\0+$/, "").replace(/^﻿/, "").trim();
function text(b, enc, from = 0) {
  return clean(decoderFor(enc).decode(b.subarray(from, strEnd(b, from, enc))));
}

const NAMES = { TIT2: "title", TT2: "title", TPE1: "artist", TP1: "artist", TALB: "album", TAL: "album", TPE2: "albumArtist", TP2: "albumArtist",
  TYER: "year", TYE: "year", TDRC: "year", TRCK: "track", TRK: "track", TCON: "genre", TCO: "genre" };

/**
 * parseId3(bytes) -> { title?, artist?, album?, albumArtist?, year?, track?, genre?,
 *   cover?: { mime, data: Uint8Array } }   ({} for no tag)
 */
export function parseId3(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = {};
  const total = id3Size(b);
  if (!total) return out;
  const ver = b[3];
  const flags = b[5];
  let body = b.subarray(10, Math.min(b.length, 10 + syncsafe(b, 6)));
  if (flags & 0x80 && ver < 4) body = unsync(body);
  let i = 0;
  if (flags & 0x40) {
    // extended header: v2.3 size excludes itself, v2.4 includes it
    i = ver >= 4 ? syncsafe(body, 0) : u32(body, 0) + 4;
  }
  const idLen = ver === 2 ? 3 : 4;
  const head = ver === 2 ? 6 : 10;
  while (i + head <= body.length) {
    const id = String.fromCharCode(...body.subarray(i, i + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // padding
    const size = ver === 2 ? (body[i + 3] << 16) | (body[i + 4] << 8) | body[i + 5] : ver >= 4 ? syncsafe(body, i + 4) : u32(body, i + 4);
    const fflags = ver === 2 ? 0 : body[i + 9];
    let f = body.subarray(i + head, i + head + size);
    i += head + size;
    if (size <= 0) continue;
    try {
      if (ver >= 4) {
        if (fflags & 0x0c) continue; // compressed or encrypted: skip
        if (fflags & 0x01) f = f.subarray(4); // data length indicator
        if (fflags & 0x02) f = unsync(f);
      } else if (ver === 3 && fflags & 0xc0) continue;
      const key = NAMES[id];
      if (key) {
        if (out[key]) continue;
        const v = text(f, f[0], 1).split("\0")[0];
        if (v) out[key] = key === "year" ? v.slice(0, 4) : v;
      } else if ((id === "APIC" || id === "PIC") && !out.cover) {
        const enc = f[0];
        let p = 1;
        let mime;
        if (id === "PIC") { const fmt = String.fromCharCode(f[1], f[2], f[3]).toLowerCase(); mime = fmt === "png" ? "image/png" : "image/jpeg"; p = 4; }
        else { const e = f.indexOf(0, 1); mime = new TextDecoder("latin1").decode(f.subarray(1, e)) || "image/jpeg"; p = e + 1; }
        p += 1; // picture type
        p = strEnd(f, p, enc) + (enc === 1 || enc === 2 ? 2 : 1); // description
        const data = f.subarray(p);
        if (data.length > 16) out.cover = { mime: /^image\//.test(mime) ? mime : sniff(data), data };
      }
    } catch { /* one bad frame never loses the rest */ }
  }
  if (out.track) out.track = parseInt(out.track, 10) || undefined;
  if (out.genre) out.genre = out.genre.replace(/^\((\d+)\)$/, "").trim() || undefined;
  for (const k in out) if (out[k] === undefined) delete out[k];
  return out;
}

const sniff = (d) => (d[0] === 0x89 && d[1] === 0x50 ? "image/png" : "image/jpeg");

/** "Artist - Title" or "01. Title" from a file name, when a file has no tags. */
export function titleFromName(path) {
  let n = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const track = /^(\d{1,3})\s*[-.)]?\s+(.+)$/.exec(n);
  let num;
  if (track) { num = +track[1]; n = track[2]; }
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(n);
  return m ? { artist: m[1].trim(), title: m[2].trim(), track: num } : { title: n, track: num };
}
