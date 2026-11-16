// Photoshop files read without Photoshop: the merged picture every .psd
// carries, and its layers - their pixels, names, places, opacity, blend,
// visibility and groups. 8 and 16 bit RGB or greyscale, raw or RLE packed
// (what Photoshop writes). Effects, masks and adjustment layers are left
// out: what shows is each layer's own pixels. No library; this file is all.
// ponytail: .psb (files over 2 GB), CMYK, Lab and 32-bit come back as an error.

const BLEND = {
  norm: "normal", mul: "multiply", scrn: "screen", over: "overlay", sLit: "soft-light", lddg: "add", dark: "darken", lite: "lighten",
  "div": "color-dodge", idiv: "color-burn", hLit: "hard-light", diff: "difference", smud: "exclusion", hue: "hue", sat: "saturation", colr: "color", lum: "luminosity", pass: "normal",
};

function reader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n) => { if (at + n > bytes.length) throw new Error("the file ends too early"); };
  return {
    get at() { return at; }, set at(v) { at = v; },
    u8() { need(1); return dv.getUint8(at++); },
    u16() { need(2); const v = dv.getUint16(at); at += 2; return v; },
    i16() { need(2); const v = dv.getInt16(at); at += 2; return v; },
    u32() { need(4); const v = dv.getUint32(at); at += 4; return v; },
    i32() { need(4); const v = dv.getInt32(at); at += 4; return v; },
    str(n) { need(n); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[at + i]); at += n; return s; },
    bytes(n) { need(n); const b = bytes.subarray(at, at + n); at += n; return b; },
    skip(n) { need(n); at += n; },
  };
}

/** PackBits rows into `out` (length bytes), from `src` starting at `i`; returns where it stopped. */
function unpack(src, i, out) {
  let o = 0;
  while (o < out.length && i < src.length) {
    const n = src[i++];
    if (n < 128) { const len = n + 1; out.set(src.subarray(i, i + len), o); o += len; i += len; }
    else if (n > 128) { const len = 257 - n; out.fill(src[i++], o, o + len); o += len; }
  }
  return i;
}

/** One plane per channel, `count` channels of `w`×`h`, read at the reader's place (compression first unless `comp` is given). */
function planes(r, count, w, h, depth, comp = null) {
  const bpp = depth === 16 ? 2 : 1;
  const rowBytes = w * bpp;
  const kind = comp == null ? r.u16() : comp;
  const out = [];
  if (kind === 0) {
    for (let c = 0; c < count; c++) out.push(r.bytes(rowBytes * h));
  } else if (kind === 1) {
    const lens = [];
    for (let k = 0; k < count * h; k++) lens.push(r.u16());
    for (let c = 0; c < count; c++) {
      const plane = new Uint8Array(rowBytes * h);
      for (let y = 0; y < h; y++) {
        const len = lens[c * h + y];
        const src = r.bytes(len);
        unpack(src, 0, plane.subarray(y * rowBytes, (y + 1) * rowBytes));
      }
      out.push(plane);
    }
  } else throw new Error("zip-packed channels are not read here");
  // 16 bit: the high byte of each sample is plenty for the screen
  return bpp === 2 ? out.map((p) => { const q = new Uint8Array(p.length / 2); for (let i = 0; i < q.length; i++) q[i] = p[i * 2]; return q; }) : out;
}

/** RGBA pixels out of planes: 3 colour planes (or 1 grey), and alpha if there is one. */
function rgba(w, h, color, alpha, grey) {
  const n = w * h;
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const r = color[0] ? color[0][i] : 0;
    px[i * 4] = r;
    px[i * 4 + 1] = grey ? r : color[1] ? color[1][i] : 0;
    px[i * 4 + 2] = grey ? r : color[2] ? color[2][i] : 0;
    px[i * 4 + 3] = alpha ? alpha[i] : 255;
  }
  return px;
}

/**
 * { width, height, depth, mode, composite: Uint8ClampedArray (RGBA) | null,
 *   layers: [{ name, left, top, width, height, opacity, visible, blend, clip, section, pixels }] }
 * Layers bottom first, as Photoshop keeps them. `section`: 0 a plain layer,
 * 1/2 the head of an open/closed group (it comes after its children), 3 the
 * hidden marker where a group starts.
 */
export function parsePsd(bytes) {
  const r = reader(bytes);
  if (r.str(4) !== "8BPS") throw new Error("not a Photoshop file");
  const version = r.u16();
  if (version !== 1) throw new Error(version === 2 ? "a .psb (large document) - save it as .psd to open it here" : "an unknown Photoshop version");
  r.skip(6);
  const channels = r.u16(), height = r.u32(), width = r.u32(), depth = r.u16(), mode = r.u16();
  if (depth !== 8 && depth !== 16) throw new Error(`${depth}-bit colour is not read here - 8 and 16 bit are`);
  if (mode !== 3 && mode !== 1) throw new Error("only RGB and greyscale are read here (not CMYK, Lab or indexed)");
  const grey = mode === 1;
  r.skip(r.u32()); // colour mode data
  r.skip(r.u32()); // image resources

  const layers = [];
  let mergedAlpha = false; // a negative layer count: the merged picture's extra channel is its transparency
  const lmLen = r.u32();
  const lmEnd = r.at + lmLen;
  if (lmLen > 0) {
    const liLen = r.u32();
    const liEnd = r.at + liLen;
    if (liLen > 0) {
      const signed = r.i16();
      mergedAlpha = signed < 0;
      const count = Math.abs(signed);
      const recs = [];
      for (let k = 0; k < count; k++) {
        const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
        const nch = r.u16();
        const chans = [];
        for (let c = 0; c < nch; c++) chans.push({ id: r.i16(), len: r.u32() });
        r.skip(4); // "8BIM"
        const key = r.str(4).trim();
        const opacity = r.u8() / 255;
        const clip = r.u8() === 1;
        const flags = r.u8();
        r.skip(1);
        const extraLen = r.u32();
        const extraEnd = r.at + extraLen;
        const maskLen = r.u32(); r.skip(maskLen);
        const rangesLen = r.u32(); r.skip(rangesLen);
        const nameLen = r.u8();
        let name = r.str(nameLen);
        r.skip((4 - ((nameLen + 1) % 4)) % 4);
        let section = 0;
        // the tagged blocks: a Unicode name, and the group markers
        while (r.at + 12 <= extraEnd) {
          const sig = r.str(4);
          if (sig !== "8BIM" && sig !== "8B64") break;
          const tag = r.str(4);
          const len = r.u32();
          const end = r.at + len;
          if (tag === "luni" && len >= 4) {
            const n = r.u32();
            let s = "";
            for (let i = 0; i < n && r.at + 2 <= end; i++) s += String.fromCharCode(r.u16());
            name = s.replace(/\u0000+$/, "") || name;
          } else if ((tag === "lsct" || tag === "lsdk") && len >= 4) section = r.u32();
          r.at = end + (len % 2);
        }
        r.at = extraEnd;
        recs.push({ name, top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top), chans, blend: BLEND[key] || "normal", pass: key === "pass", opacity, clip, visible: !(flags & 2), section });
      }
      // each layer's channels, in the same order
      for (const rec of recs) {
        const color = [], alphaPlane = { v: null };
        for (const ch of rec.chans) {
          const start = r.at;
          const isMask = ch.id < -1;
          const w = rec.width, h = rec.height;
          if (isMask || !w || !h) { r.at = start + ch.len; continue; }
          const [plane] = planes(r, 1, w, h, depth);
          if (ch.id === -1) alphaPlane.v = plane; else color[ch.id] = plane;
          r.at = start + ch.len;
        }
        layers.push({
          name: rec.name, left: rec.left, top: rec.top, width: rec.width, height: rec.height,
          opacity: rec.opacity, visible: rec.visible, blend: rec.blend, pass: rec.pass, clip: rec.clip, section: rec.section,
          pixels: rec.width && rec.height ? rgba(rec.width, rec.height, color, alphaPlane.v, grey) : null,
        });
      }
    }
    r.at = liEnd;
  }
  r.at = lmEnd;

  // the merged picture
  let composite = null;
  try {
    const colorCount = grey ? 1 : 3;
    // every channel is stored (saved selections too); the colour ones make the picture
    const ps = planes(r, channels, width, height, depth);
    composite = rgba(width, height, ps.slice(0, colorCount), mergedAlpha && channels > colorCount ? ps[colorCount] : null, grey);
  } catch { composite = null; }
  return { width, height, depth, mode, composite, layers };
}

/** Is the merged picture a real one? Without "Maximize compatibility" Photoshop leaves it one flat colour. */
export function compositeBlank(psd) {
  const p = psd.composite;
  if (!p) return true;
  if (!psd.layers.some((l) => l.pixels)) return false;
  for (let i = 4; i < p.length; i += 4 * 97) if (p[i] !== p[0] || p[i + 1] !== p[1] || p[i + 2] !== p[2] || p[i + 3] !== p[3]) return false;
  return true;
}

/** Which layers show: their own switch, and every group around them switched on too. */
export function shownLayers(layers) {
  const out = layers.map((l) => l.visible);
  const stack = [];
  layers.forEach((l, i) => {
    if (l.section === 3) { stack.push([]); return; }
    if (l.section === 1 || l.section === 2) {
      const kids = stack.pop() || [];
      if (!l.visible) for (const k of kids) out[k] = false;
      if (stack.length) stack[stack.length - 1].push(...kids, i);
      return;
    }
    if (stack.length) stack[stack.length - 1].push(i);
  });
  return out;
}

const CANVAS_OP = { normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay", "soft-light": "soft-light", add: "lighter", darken: "darken", lighten: "lighten",
  "color-dodge": "color-dodge", "color-burn": "color-burn", "hard-light": "hard-light", difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity" };

/** The picture as a canvas: the merged one, or - when Photoshop left that blank - the layers put together here. */
export function psdCanvas(psd) {
  const c = document.createElement("canvas");
  c.width = psd.width;
  c.height = psd.height;
  const g = c.getContext("2d");
  if (!compositeBlank(psd)) { g.putImageData(new ImageData(psd.composite, psd.width, psd.height), 0, 0); return c; }
  const show = shownLayers(psd.layers);
  psd.layers.forEach((l, i) => {
    if (!l.pixels || !show[i] || l.section) return;
    const t = document.createElement("canvas");
    t.width = l.width;
    t.height = l.height;
    t.getContext("2d").putImageData(new ImageData(l.pixels, l.width, l.height), 0, 0);
    g.globalAlpha = l.opacity;
    g.globalCompositeOperation = CANVAS_OP[l.blend] || "source-over";
    g.drawImage(t, l.left, l.top);
  });
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
  return c;
}
