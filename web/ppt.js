// Old PowerPoint (.ppt, 97-2003) preview: the file is a Compound File (a
// little FAT file system); inside, the "PowerPoint Document" stream holds the
// slides as records and "Pictures" holds the images. We read each slide's
// text and list the pictures - enough to find what a lecture says without
// leaving Leonote. Read-only.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ENDCHAIN = 0xfffffffe;

export const isCfb = (b) => b.length > 512 && u32(b, 0) === 0xe011cfd0 && u32(b, 4) === 0xe11ab1a1;

/** Streams of a Compound File by name: Map(name -> Uint8Array). */
export function readCfb(b) {
  if (!isCfb(b)) throw new Error("not an old Office file");
  const shift = u16(b, 0x1e);
  const size = 1 << shift;
  const miniShift = u16(b, 0x20);
  const cutoff = u32(b, 0x38);
  const sect = (s) => 512 + s * size;
  // the FAT's own sectors: 109 in the header, the rest in a DIFAT chain
  const fatSecs = [];
  for (let i = 0; i < 109; i++) { const s = u32(b, 0x4c + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
  let dif = u32(b, 0x44);
  for (let guard = 0; dif < 0xfffffffa && guard < 50000; guard++) {
    const o = sect(dif);
    for (let i = 0; i < size / 4 - 1; i++) { const s = u32(b, o + i * 4); if (s < 0xfffffffa) fatSecs.push(s); }
    dif = u32(b, o + size - 4);
  }
  const fat = new Uint32Array(fatSecs.length * (size / 4));
  fatSecs.forEach((s, k) => { const o = sect(s); for (let i = 0; i < size / 4; i++) fat[k * (size / 4) + i] = u32(b, o + i * 4); });
  const chain = (start, len, secSize, read) => {
    const out = new Uint8Array(len);
    let at = 0;
    for (let s = start, guard = 0; s !== ENDCHAIN && s < 0xfffffffa && at < len && guard < 1e7; guard++) {
      const part = read(s);
      out.set(part.subarray(0, Math.min(secSize, len - at)), at);
      at += secSize;
      s = secSize === size ? fat[s] : mini[s];
    }
    return out;
  };
  const big = (s) => b.subarray(sect(s), sect(s) + size);
  // directory
  const dirStart = u32(b, 0x30);
  const dirBytes = [];
  for (let s = dirStart, guard = 0; s < 0xfffffffa && guard < 100000; guard++) { dirBytes.push(big(s)); s = fat[s]; }
  const entries = [];
  for (const d of dirBytes) for (let o = 0; o + 128 <= d.length; o += 128) {
    const nlen = u16(d, o + 0x40);
    const type = d[o + 0x42];
    if (!type) continue;
    let name = "";
    for (let i = 0; i + 2 < nlen; i += 2) name += String.fromCharCode(u16(d, o + i));
    entries.push({ name, type, start: u32(d, o + 0x74), size: u32(d, o + 0x78) });
  }
  const root = entries.find((e) => e.type === 5);
  // the mini stream (small streams live inside it) and its own FAT
  let mini = new Uint32Array(0);
  const miniFatStart = u32(b, 0x3c);
  if (miniFatStart < 0xfffffffa) {
    const parts = [];
    for (let s = miniFatStart, guard = 0; s < 0xfffffffa && guard < 1e6; guard++) { parts.push(big(s)); s = fat[s]; }
    mini = new Uint32Array(parts.length * (size / 4));
    parts.forEach((p, k) => { for (let i = 0; i < size / 4; i++) mini[k * (size / 4) + i] = u32(p, i * 4); });
  }
  const miniStream = root ? chain(root.start, root.size, size, big) : new Uint8Array(0);
  const miniSize = 1 << miniShift;
  const small = (s) => miniStream.subarray(s * miniSize, (s + 1) * miniSize);
  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;
    streams.set(e.name, e.size < cutoff ? chain(e.start, e.size, miniSize, small) : chain(e.start, e.size, size, big));
  }
  return streams;
}

const SLIDE = 0x03ee;
const SLWT = 0x0ff0;
const PERSIST = 0x03f3;
const CHARS = 0x0fa0;
const BYTES = 0x0fa8;

// walk records; `visit(type, instance, start, end, depth)` returns true to go inside
function walk(b, from, to, visit, depth = 0) {
  let o = from;
  while (o + 8 <= to) {
    const vi = u16(b, o);
    const type = u16(b, o + 2);
    const len = u32(b, o + 4);
    const s = o + 8;
    const e = Math.min(to, s + len);
    if (len > to - s + 8) break;
    if ((vi & 0xf) === 0xf) { if (visit(type, vi >> 4, s, e, depth, true) !== false) walk(b, s, e, visit, depth + 1); }
    else visit(type, vi >> 4, s, e, depth, false);
    o = s + len;
  }
}

const textOf = (b, type, s, e) => {
  if (type === CHARS) { let t = ""; for (let i = s; i + 1 < e; i += 2) t += String.fromCharCode(u16(b, i)); return t; }
  let t = "";
  for (let i = s; i < e; i++) t += String.fromCharCode(b[i]); // Latin-1
  return t;
};
const clean = (t) => t.replace(/\r/g, "\n").replace(/\v/g, "\n").replace(/[\u0000--]/g, "").trim();

/** { slides: [[paragraph...]], pictures: [{ type, bytes }] } */
export function parsePpt(bytes) {
  const streams = readCfb(bytes);
  const doc = streams.get("PowerPoint Document");
  if (!doc) throw new Error("no slides inside");
  // text drawn on each slide (inside its drawing's text boxes)
  let slides = [];
  walk(doc, 0, doc.length, (type, inst, s, e) => {
    if (type !== SLIDE) return true;
    const parts = [];
    walk(doc, s, e, (t, i, a, z) => { if (t === CHARS || t === BYTES) { const x = clean(textOf(doc, t, a, z)); if (x) parts.push(x); } return true; });
    slides.push(parts);
    return false;
  });
  // older files keep the text in one list instead
  if (!slides.some((p) => p.length)) {
    slides = [];
    walk(doc, 0, doc.length, (type, inst, s, e) => {
      if (type !== SLWT) return true;
      if (inst !== 0) return false;
      let cur = null;
      walk(doc, s, e, (t, i, a, z) => {
        if (t === PERSIST) slides.push((cur = []));
        else if ((t === CHARS || t === BYTES) && cur) { const x = clean(textOf(doc, t, a, z)); if (x) cur.push(x); }
        return false;
      });
      return false;
    });
  }
  // incremental saves repeat slides; keep the first of identical neighbours
  slides = slides.filter((p, i) => i === 0 || p.join("\n") !== slides[i - 1].join("\n"));

  const pictures = [];
  const pics = streams.get("Pictures");
  if (pics) {
    let o = 0;
    while (o + 8 <= pics.length && pictures.length < 300) {
      const vi = u16(pics, o);
      const type = u16(pics, o + 2);
      const len = u32(pics, o + 4);
      const inst = vi >> 4;
      const s = o + 8;
      const two = inst & 1 ? 16 : 0;
      if (type === 0xf01d || type === 0xf02a) pictures.push({ type: "image/jpeg", bytes: pics.subarray(s + 17 + two, s + len) });
      else if (type === 0xf01e) pictures.push({ type: "image/png", bytes: pics.subarray(s + 17 + two, s + len) });
      if (!len) break;
      o = s + len;
    }
  }
  return { slides, pictures };
}

export async function mountPpt(el, bytes, { h }) {
  const { slides, pictures } = parsePpt(bytes);
  const urls = pictures.map((p) => URL.createObjectURL(new Blob([p.bytes], { type: p.type })));
  el.replaceChildren(h("div", { class: "sl-wrap ppt-old" },
    h("div", { class: "sl-count", text: `${slides.length} slide${slides.length === 1 ? "" : "s"} · older PowerPoint format - text and pictures only` }),
    h("div", { class: "ppt-slides" }, slides.map((paras, i) => h("div", { class: "ppt-slide" },
      h("div", { class: "sl-num", text: String(i + 1) }),
      h("div", { class: "ppt-card" }, paras.length
        ? paras.map((p, k) => h(k === 0 ? "h3" : "p", { text: p }))
        : h("p", { class: "ppt-empty", text: "(no text on this slide)" }))))),
    urls.length ? h("div", { class: "ppt-pics-head", text: `Pictures (${urls.length})` }) : null,
    urls.length ? h("div", { class: "ppt-pics" }, urls.map((u) => h("img", { src: u, loading: "lazy", alt: "" }))) : null));
  return { destroy() { for (const u of urls) URL.revokeObjectURL(u); } };
}
