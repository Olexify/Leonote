// Writing PDFs: page surgery, real annotations, filled forms.
//
// pdf-lib does the writing (MIT, ~330 KB, pure JS, no worker) and pdf.js only
// ever reads. Two libraries sounds like one too many, but pdf.js cannot write
// and pdf-lib cannot render, and nothing in the browser does both well.
//
// Page moves happen *in place* - the pages of the loaded document are taken
// out of the page tree and put back in the new order - rather than by copying
// into a fresh document. Copying is the usual pdf-lib recipe and it quietly
// loses the AcroForm, the outline and the page labels; keeping the original
// document and only rewriting its tree keeps every one of them. Pages coming
// from *another* file have to be copied, so only those lose their own fields.
//
// Everything here takes and returns bytes, so a failed edit can never leave a
// half-changed document behind: the caller swaps the whole buffer or nothing.

import { normDeg, packAnnot } from "./pdfcore.js";

let libP = null;
/** pdf-lib, loaded the first time something is written. */
export const lib = () => (libP ||= import("pdf-lib"));

const LOAD = { ignoreEncryption: false, updateMetadata: false };

/** A load that says plainly what is wrong rather than throwing pdf-lib's words. */
export async function load(bytes, opts) {
  const { PDFDocument } = await lib();
  try {
    return await PDFDocument.load(bytes, { ...LOAD, ...opts });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/encrypted/i.test(m)) throw Object.assign(new Error("This PDF is password-protected, so Leonote can't change it."), { code: "encrypted" });
    throw Object.assign(new Error("This PDF is damaged, or is not a PDF inside."), { code: "damaged", cause: e });
  }
}

const save = (doc) => doc.save({ useObjectStreams: false, addDefaultPage: false });

export async function pageCount(bytes) {
  return (await load(bytes)).getPageCount();
}

/**
 * Rebuild the page tree as `order` (source indices) says, turning each page by
 * the matching entry of `extraRot`. Deleting is leaving an index out;
 * extracting is passing only the ones wanted. A page may not appear twice.
 */
export async function applyOrder(bytes, order, extraRot) {
  const { degrees } = await lib();
  const doc = await load(bytes);
  const pages = doc.getPages();
  if (!order.length) throw new Error("a PDF needs at least one page");
  if (new Set(order).size !== order.length) throw new Error("a page cannot be used twice");
  const picked = order.map((i) => {
    const p = pages[i];
    if (!p) throw new Error(`page ${i + 1} is not in this document`);
    return p;
  });
  picked.forEach((p, k) => {
    const extra = extraRot ? extraRot[k] || 0 : 0;
    const now = normDeg(p.getRotation().angle);
    if (extra) p.setRotation(degrees(normDeg(now + extra)));
  });
  // A page tree may never be empty while it is being rebuilt, so a throwaway
  // page holds the door open and is removed at the end.
  doc.addPage([1, 1]);
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  picked.forEach((p, k) => doc.insertPage(k, p));
  doc.removePage(doc.getPageCount() - 1);
  return save(doc);
}

/** Pages `indices` of `srcBytes`, copied into `bytes` in front of page `at`. */
export async function insertPdfPages(bytes, at, srcBytes, indices) {
  const doc = await load(bytes);
  const src = await load(srcBytes);
  const want = (indices && indices.length ? indices : src.getPages().map((_, i) => i)).filter((i) => i >= 0 && i < src.getPageCount());
  if (!want.length) throw new Error("that file has no pages to add");
  const copied = await doc.copyPages(src, want);
  const where = Math.max(0, Math.min(doc.getPageCount(), at));
  copied.forEach((p, k) => doc.insertPage(where + k, p));
  return save(doc);
}

/** A picture becomes one page its own size (at 72 dpi), in front of page `at`. */
export async function insertImagePage(bytes, at, imgBytes, name = "") {
  const doc = await load(bytes);
  const png = /\.png$/i.test(name) || (imgBytes[0] === 0x89 && imgBytes[1] === 0x50);
  const img = png ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
  // keep it sane: nothing wider than A3, nothing smaller than a postcard
  const max = 1190;
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(72, img.width * s), hh = Math.max(72, img.height * s);
  const where = Math.max(0, Math.min(doc.getPageCount(), at));
  const page = doc.insertPage(where, [w, hh]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: hh });
  return save(doc);
}

/** One document per part. Each keeps the original's form and outline. */
export async function splitPdf(bytes, parts) {
  const out = [];
  for (const pages of parts) out.push(await applyOrder(bytes, pages, null));
  return out;
}

// ── annotations ─────────────────────────────────────────────────────────────

const f = (n) => {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return Object.is(v, -0) ? "0" : String(v);
};
const rgb = (hex) => {
  const h = String(hex || "#e0a84a").replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const ops = (...a) => a.join(" ");
const pdfDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? "Z" : `${off > 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${zone}`;
};

/** Bounding box of an annotation record, in page points. */
export function annotRect(a) {
  if (a.quads) {
    const xs = a.quads.flatMap((q) => [q[0], q[0] + q[2]]);
    const ys = a.quads.flatMap((q) => [q[1], q[1] + q[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (a.strokes) {
    const pad = (a.width || 2) / 2 + 1;
    const pts = a.strokes.flat();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  }
  const [x, y, w, hh] = a.rect;
  const pad = a.type === "arrow" || a.type === "rect" || a.type === "ellipse" ? (a.width || 2) / 2 + 1 : 0;
  return [Math.min(x, x + w) - pad, Math.min(y, y + hh) - pad, Math.max(x, x + w) + pad, Math.max(y, y + hh) + pad];
}

const SUBTYPE = { highlight: "Highlight", underline: "Underline", strike: "StrikeOut", ink: "Ink", note: "Text", text: "FreeText", rect: "Square", ellipse: "Circle", arrow: "Line", stamp: "Stamp" };

/**
 * Write the records onto the document. `byPage` is an array, one list of
 * records per page index. Each becomes a genuine PDF annotation *with its own
 * appearance stream*, so Acrobat, Edge and Preview all show it without having
 * to guess - and it stays selectable and deletable there rather than being
 * burnt into the page.
 */
export async function writeAnnots(bytes, byPage, { author = "Leonote" } = {}) {
  const { PDFHexString, PDFName, StandardFonts, rgb: RGB } = await lib();
  const doc = await load(bytes);
  const pages = doc.getPages();
  const ctx = doc.context;
  const gsCache = new Map();
  const imgCache = new Map();
  let font = null;
  const helv = async () => (font ||= await doc.embedFont(StandardFonts.Helvetica));
  const gs = (alpha, blend) => {
    const key = `${alpha}|${blend}`;
    if (!gsCache.has(key)) gsCache.set(key, ctx.register(ctx.obj({ Type: "ExtGState", BM: PDFName.of(blend), ca: alpha, CA: alpha })));
    return gsCache.get(key);
  };
  const image = async (dataUrl) => {
    if (imgCache.has(dataUrl)) return imgCache.get(dataUrl);
    const raw = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bin = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const img = /^data:image\/jpe?g/i.test(dataUrl) ? await doc.embedJpg(bin) : await doc.embedPng(bin);
    imgCache.set(dataUrl, img);
    return img;
  };

  let written = 0;
  for (let pi = 0; pi < byPage.length; pi++) {
    const list = (byPage[pi] || []).map(packAnnot).filter(Boolean);
    const page = pages[pi];
    if (!page || !list.length) continue;
    for (const a of list) {
      const rect = annotRect(a);
      const [r, g, b] = rgb(a.color);
      const alpha = a.opacity == null ? 1 : a.opacity;
      if (a.burn && (a.type === "rect" || a.type === "text")) {
        // a retyped line is part of the page, not a comment: the patch and the
        // type go into the page's own content. The type is the browser's drawing
        // in the page's font (pdf.js loaded it as a font face); Latin words also
        // go in as invisible real text, so search and selection still find them.
        const [x, y, w, hh] = norm(a.rect);
        if (a.type === "rect") {
          const c = rgb(a.fill || a.color);
          page.drawRectangle({ x, y, width: w, height: hh, color: RGB(c[0], c[1], c[2]), borderWidth: 0 });
        } else {
          const size = a.fontSize || 12;
          const text = String(a.text || "");
          const img = await image(rasterText(text, size, w, hh, a.color, a.font, true));
          page.drawImage(img, { x, y, width: w, height: hh });
          const fo = await helv();
          let latin = true;
          try { fo.encodeText(text.replace(/\n/g, " ")); } catch { latin = false; }
          if (latin) page.drawText(text, { x: x + 4, y: y + hh - size - 3, size, font: fo, color: RGB(r, g, b), opacity: 0, lineHeight: size * 1.25 });
        }
        written++;
        continue;
      }
      const res = {};
      let body = "";
      let extra = {};

      if (a.type === "highlight") {
        res.ExtGState = { GS: gs(alpha, "Multiply") };
        body = "/GS gs " + ops(f(r), f(g), f(b), "rg") + " " + a.quads.map((q) => ops(f(q[0]), f(q[1]), f(q[2]), f(q[3]), "re")).join(" ") + " f";
        extra.QuadPoints = quadPoints(a.quads);
      } else if (a.type === "underline" || a.type === "strike") {
        res.ExtGState = { GS: gs(alpha, "Normal") };
        const bar = (q) => {
          const t = Math.max(0.6, q[3] * 0.06);
          const y = a.type === "underline" ? q[1] + q[3] * 0.06 : q[1] + q[3] * 0.42;
          return ops(f(q[0]), f(y), f(q[2]), f(t), "re");
        };
        body = "/GS gs " + ops(f(r), f(g), f(b), "rg") + " " + a.quads.map(bar).join(" ") + " f";
        extra.QuadPoints = quadPoints(a.quads);
      } else if (a.type === "ink") {
        res.ExtGState = { GS: gs(alpha, "Normal") };
        body = "/GS gs 1 J 1 j " + ops(f(a.width), "w", f(r), f(g), f(b), "RG") + " " +
          a.strokes.map((s) => s.map((p, i) => ops(f(p[0]), f(p[1]), i ? "l" : "m")).join(" ") + (s.length === 1 ? ` ${f(s[0][0])} ${f(s[0][1])} l` : "") + " S").join(" ");
        extra.InkList = a.strokes.map((s) => s.flat().map((n) => Math.round(n * 1000) / 1000));
        extra.BS = { W: a.width };
      } else if (a.type === "rect" || a.type === "ellipse") {
        res.ExtGState = { GS: gs(alpha, "Normal") };
        const [x, y, w, hh] = norm(a.rect);
        const inset = a.width / 2;
        const path = a.type === "rect"
          ? ops(f(x + inset), f(y + inset), f(w - a.width), f(hh - a.width), "re")
          : ellipsePath(x + inset, y + inset, w - a.width, hh - a.width);
        const paint = a.fill ? "B" : "S";
        const fillOp = a.fill ? ops(...rgb(a.fill).map(f), "rg") + " " : "";
        body = `/GS gs ${fillOp}` + ops(f(a.width), "w", f(r), f(g), f(b), "RG") + " " + path + " " + paint;
        extra.BS = { W: a.width };
        if (a.fill) extra.IC = rgb(a.fill);
      } else if (a.type === "arrow") {
        res.ExtGState = { GS: gs(alpha, "Normal") };
        const [x, y, w, hh] = a.rect;
        const x2 = x + w, y2 = y + hh;
        const len = Math.hypot(w, hh) || 1;
        const ux = w / len, uy = hh / len;
        const head = Math.min(len * 0.35, 6 + a.width * 3);
        const bx = x2 - ux * head, by = y2 - uy * head;
        const px = -uy * head * 0.42, py = ux * head * 0.42;
        body = "/GS gs 1 J 1 j " + ops(f(a.width), "w", f(r), f(g), f(b), "RG", f(r), f(g), f(b), "rg") + " " +
          ops(f(x), f(y), "m", f(bx), f(by), "l", "S") + " " +
          ops(f(x2), f(y2), "m", f(bx + px), f(by + py), "l", f(bx - px), f(by - py), "l", "f");
        extra.L = [x, y, x2, y2].map((n) => Math.round(n * 1000) / 1000);
        extra.LE = [PDFName.of("None"), PDFName.of("ClosedArrow")];
        extra.BS = { W: a.width };
      } else if (a.type === "note") {
        res.ExtGState = { GS: gs(alpha, "Normal") };
        const [x, y, w, hh] = norm(a.rect);
        body = "/GS gs " + ops(f(r), f(g), f(b), "rg", "0.25 0.25 0.25 RG", "0.5 w") + " " +
          ops(f(x + 1), f(y + 1), f(w - 2), f(hh - 2), "re", "B") + " " +
          ops("1 1 1 RG", f(Math.max(0.8, hh * 0.05)), "w") + " " +
          [0.62, 0.45, 0.28].map((t) => ops(f(x + w * 0.2), f(y + hh * t), "m", f(x + w * 0.8), f(y + hh * t), "l", "S")).join(" ");
        extra.Name = PDFName.of("Comment");
        extra.Open = false;
      } else if (a.type === "text") {
        const fo = await helv();
        res.Font = { Helv: fo.ref };
        res.ExtGState = { GS: gs(alpha, "Normal") };
        const [x, y, w, hh] = norm(a.rect);
        const size = a.fontSize || 12;
        const text = String(a.text || "");
        extra.DA = `${f(r)} ${f(g)} ${f(b)} rg /Helv ${f(size)} Tf`;
        extra.Q = 0;
        let latin = true;
        try { fo.encodeText(text.replace(/\n/g, " ")); } catch { latin = false; }
        if (latin) {
          const lines = wrapText(text, fo, size, w - 8);
          let t = `/GS gs BT /Helv ${f(size)} Tf ${f(r)} ${f(g)} ${f(b)} rg ${f(size * 1.25)} TL ${f(x + 4)} ${f(y + hh - size - 3)} Td`;
          lines.forEach((ln, i) => { t += ` ${i ? "T* " : ""}${fo.encodeText(ln).toString()} Tj`; });
          body = t + " ET";
        } else {
          // Letters Helvetica has no glyphs for (Japanese, Cyrillic, Greek…): the
          // browser draws the box with its own fonts and the picture goes in as
          // the appearance. The words still sit in /Contents, so a reader can
          // search them; embedding a font with those glyphs would cost megabytes.
          const img = await image(rasterText(text, size, w, hh, a.color, a.font));
          res.XObject = { Im: img.ref };
          body = `/GS gs q ${ops(f(w), "0 0", f(hh), f(x), f(y), "cm")} /Im Do Q`;
        }
      } else if (a.type === "stamp") {
        const img = await image(a.image);
        res.XObject = { Im: img.ref };
        res.ExtGState = { GS: gs(alpha, "Normal") };
        const [x, y, w, hh] = norm(a.rect);
        body = `/GS gs q ${ops(f(w), "0 0", f(hh), f(x), f(y), "cm")} /Im Do Q`;
        extra.Name = PDFName.of("LeoNoteStamp");
      }

      const apRef = ctx.register(ctx.flateStream(body, {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: rect, Resources: res,
      }));
      const dict = {
        Type: "Annot",
        Subtype: PDFName.of(SUBTYPE[a.type]),
        Rect: rect,
        F: 4, // print
        NM: PDFHexString.fromText(a.id),
        M: PDFHexString.fromText(pdfDate()),
        CreationDate: PDFHexString.fromText(a.created ? pdfDate(new Date(a.created)) : pdfDate()),
        T: PDFHexString.fromText(a.author || author),
        C: [r, g, b],
        CA: alpha,
        AP: { N: apRef },
        ...extra,
      };
      if (a.text) dict.Contents = PDFHexString.fromText(a.text);
      page.node.addAnnot(ctx.register(ctx.obj(dict)));
      written++;
    }
  }
  return { bytes: await save(doc), written };
}

const norm = ([x, y, w, hh]) => [Math.min(x, x + w), Math.min(y, y + hh), Math.abs(w), Math.abs(hh)];

/** PDF wants the corners upper-left, upper-right, lower-left, lower-right. */
function quadPoints(quads) {
  const out = [];
  for (const [x, y, w, hh] of quads) out.push(x, y + hh, x + w, y + hh, x, y, x + w, y);
  return out.map((n) => Math.round(n * 1000) / 1000);
}

const K = 0.5523;
function ellipsePath(x, y, w, hh) {
  const rx = w / 2, ry = hh / 2, cx = x + rx, cy = y + ry;
  return ops(
    f(cx + rx), f(cy), "m",
    f(cx + rx), f(cy + ry * K), f(cx + rx * K), f(cy + ry), f(cx), f(cy + ry), "c",
    f(cx - rx * K), f(cy + ry), f(cx - rx), f(cy + ry * K), f(cx - rx), f(cy), "c",
    f(cx - rx), f(cy - ry * K), f(cx - rx * K), f(cy - ry), f(cx), f(cy - ry), "c",
    f(cx + rx * K), f(cy - ry), f(cx + rx), f(cy - ry * K), f(cx + rx), f(cy), "c",
  );
}

/** Greedy wrap; a word longer than the box is left to overflow rather than cut. */
/** A text box drawn by the browser at 4 px per point, as a PNG data URL - the same box rule as the Helvetica path. */
function rasterText(text, size, w, hh, color, font, nowrap = false) {
  const S = 4;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w * S));
  c.height = Math.max(1, Math.ceil(hh * S));
  const g = c.getContext("2d");
  g.scale(S, S);
  const fam = (getComputedStyle(document.documentElement).getPropertyValue("--font") || "").trim() || "sans-serif";
  g.font = `${size}px ${font || fam}`;
  g.fillStyle = color || "#000";
  g.textBaseline = "alphabetic";
  const width = nowrap ? Infinity : w - 8;
  const lines = [];
  for (const para of String(text).split("\n")) {
    if (!para) { lines.push(""); continue; }
    let line = "";
    // scripts without spaces wrap letter by letter, the rest by words
    const parts = /\s/.test(para) ? para.split(/(\s+)/) : [...para];
    for (const part of parts) {
      const next = line + part;
      if (line && g.measureText(next).width > width) { lines.push(line.trimEnd()); line = part.trimStart(); }
      else line = next;
    }
    lines.push(line);
  }
  let yy = size + 3;
  for (const ln of lines.slice(0, 200)) { g.fillText(ln, 4, yy); yy += size * 1.25; if (yy > hh + size) break; }
  return c.toDataURL("image/png");
}

export function wrapText(text, font, size, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > width) { out.push(line); line = word; }
      else line = next;
    }
    out.push(line);
  }
  return out.slice(0, 200);
}

// ── forms ───────────────────────────────────────────────────────────────────


/**
 * Put the answers in. `changes` is what `changedFields()` produced. A field
 * that has gone missing is skipped rather than failing the whole save.
 */
export async function fillForm(bytes, changes, { flatten = false } = {}) {
  const { PDFName } = await lib();
  const doc = await load(bytes);
  const form = doc.getForm();
  const missed = [];
  for (const c of changes) {
    try {
      if (c.kind === "check") {
        const fd = form.getCheckBox(c.name);
        if (typeof c.value === "string") {
          // A pair answering differently: check() and setValue() know only the first box's answer.
          const off = PDFName.of("Off"), on = c.value ? PDFName.of(c.value) : off, boxes = fd.acroField.getWidgets();
          if (on !== off && !boxes.some((w) => w.getOnValue() === on)) throw new Error("no such box");
          fd.acroField.dict.set(PDFName.of("V"), on);
          for (const w of boxes) w.setAppearanceState(w.getOnValue() === on ? on : off);
          fd.markAsDirty();
        } else c.value ? fd.check() : fd.uncheck();
      } else if (c.kind === "choice") {
        const fd = form.getDropdown(c.name);
        c.value ? fd.select(c.value) : fd.clear();
      } else if (c.kind === "list") {
        const fd = form.getOptionList(c.name);
        c.value.length ? fd.select(c.value) : fd.clear();
      } else if (c.kind === "radio") {
        const fd = form.getRadioGroup(c.name);
        c.value ? fd.select(c.value) : fd.clear();
      } else {
        form.getTextField(c.name).setText(String(c.value ?? ""));
      }
    } catch { missed.push(c.name); }
  }
  try { form.updateFieldAppearances(); } catch {}
  if (flatten) { try { form.flatten(); } catch {} }
  return { bytes: await save(doc), missed };
}
