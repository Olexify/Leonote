// PowerPoint (.pptx) preview: each slide drawn from its XML, in PowerPoint's
// own order (what is drawn later is on top), with what a slide inherits from
// its layout and master - placeholder positions, text sizes, colours, bullets,
// backgrounds, the template's own shapes - and the theme's colours and fonts.
// Text keeps each run's colour, weight, slant and font; paragraphs their
// alignment, indents, spacing and bullets; a box its vertical anchoring and
// PowerPoint's "shrink text to fit". Shapes with a fill or an outline are
// drawn; groups and tables too. Charts, SmartArt, effects and animations are
// left to PowerPoint. The words can be changed (onEdit); nothing else is.

import { h } from "./util.js";

const EMU = 914400; // per inch
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp" };

const xml = (t) => new DOMParser().parseFromString(t, "application/xml");
const kids = (el, ns, name) => (el ? [...el.getElementsByTagNameNS(ns, name)] : []);
const first = (el, ns, name) => (el ? el.getElementsByTagNameNS(ns, name)[0] || null : null);
/** A direct child by name (not a deeper one, as getElementsByTagNameNS would find). */
const child = (el, ns, name) => (el ? [...el.children].find((c) => c.namespaceURI === ns && c.localName === name) || null : null);
const childs = (el, ns, name) => (el ? [...el.children].filter((c) => c.namespaceURI === ns && c.localName === name) : []);

function relsOf(doc) {
  const m = new Map();
  for (const r of doc ? [...doc.getElementsByTagName("Relationship")] : []) m.set(r.getAttribute("Id"), r.getAttribute("Target"));
  return m;
}
const relOfType = (doc, kind) => { const r = doc ? [...doc.getElementsByTagName("Relationship")].find((x) => (x.getAttribute("Type") || "").endsWith("/" + kind)) : null; return r ? r.getAttribute("Target") : null; };
const join = (base, rel) => {
  const parts = base.split("/").slice(0, -1);
  for (const p of rel.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }
  return parts.join("/");
};
const relsPath = (path) => join(path, "_rels/" + path.split("/").pop() + ".rels");

/* ── colours (pure, tested) ─────────────────────────────────────────────── */

const PRESET = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500", navy: "000080" };

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let hh = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh, s, l];
}
function hslToRgb(hh, s, l) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

/**
 * A colour as CSS: hex `RRGGBB` and its modifiers, as PowerPoint applies them -
 * lumMod / lumOff (lighter, darker), tint (towards white), shade (towards
 * black), alpha. Values are in 1/1000 of a percent (100000 = 100%).
 */
export function applyMods(hex, mods = []) {
  let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  let a = 1;
  for (const [name, v] of mods) {
    const f = v / 100000;
    if (name === "lumMod" || name === "lumOff") {
      const [hh, s, l] = rgbToHsl(r, g, b);
      [r, g, b] = hslToRgb(hh, s, Math.max(0, Math.min(1, name === "lumMod" ? l * f : l + f)));
    } else if (name === "tint") { r += (255 - r) * (1 - f); g += (255 - g) * (1 - f); b += (255 - b) * (1 - f); }
    else if (name === "shade") { r *= f; g *= f; b *= f; }
    else if (name === "alpha") a = f;
  }
  const c = (x) => Math.round(Math.max(0, Math.min(255, x)));
  return a < 1 ? `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(a * 1000) / 1000})` : "#" + [r, g, b].map((x) => c(x).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** The colour inside a fill-like element (solidFill, a gradient stop, buClr...), as CSS, or null. */
export function colorOf(el, theme) {
  if (!el) return null;
  const c = [...el.children].find((x) => /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr)$/.test(x.localName));
  if (!c) return null;
  let hex = null;
  if (c.localName === "srgbClr") hex = c.getAttribute("val");
  else if (c.localName === "sysClr") hex = c.getAttribute("lastClr") || (c.getAttribute("val") === "window" ? "FFFFFF" : "000000");
  else if (c.localName === "prstClr") hex = PRESET[c.getAttribute("val")] || "000000";
  else if (c.localName === "scrgbClr") hex = ["r", "g", "b"].map((k) => Math.round((+c.getAttribute(k) / 100000) * 255).toString(16).padStart(2, "0")).join("");
  else {
    const name = c.getAttribute("val");
    const mapped = (theme && theme.map[name]) || name;
    hex = theme && theme.colors[mapped];
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  return applyMods(hex, [...c.children].map((m) => [m.localName, +m.getAttribute("val")]));
}

/* ── the theme: colours and fonts ───────────────────────────────────────── */

function readTheme(doc, clrMapEl) {
  const colors = {};
  const scheme = first(doc, A, "clrScheme");
  for (const c of scheme ? [...scheme.children] : []) {
    const v = c.firstElementChild;
    if (!v) continue;
    colors[c.localName] = v.localName === "sysClr" ? v.getAttribute("lastClr") || (v.getAttribute("val") === "window" ? "FFFFFF" : "000000") : v.getAttribute("val");
  }
  const map = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  for (const at of clrMapEl ? [...clrMapEl.attributes] : []) map[at.name] = at.value;
  const font = (kind) => { const f = first(first(doc, A, kind), A, "latin"); return f ? f.getAttribute("typeface") : ""; };
  return { colors, map, major: font("majorFont"), minor: font("minorFont") };
}

/* ── shapes' positions ──────────────────────────────────────────────────── */

function xfrmOf(el) {
  // a shape's own spPr/xfrm, a picture's, a graphic frame's p:xfrm
  const sp = child(el, P, "spPr") || child(el, P, "grpSpPr");
  const x = (sp && child(sp, A, "xfrm")) || child(el, P, "xfrm");
  return x;
}
function boxOf(el) {
  const x = xfrmOf(el);
  const off = child(x, A, "off"), ext = child(x, A, "ext");
  if (!off || !ext) return null;
  return { x: +off.getAttribute("x"), y: +off.getAttribute("y"), w: +ext.getAttribute("cx"), h: +ext.getAttribute("cy"), rot: +(x.getAttribute("rot") || 0) / 60000, flipH: x.getAttribute("flipH") === "1", flipV: x.getAttribute("flipV") === "1" };
}
const phOf = (sp) => first(child(sp, P, "nvSpPr") || child(sp, P, "nvPicPr") || sp, P, "ph");
/** The placeholder in a layout or master that a slide's placeholder takes after: same idx, else same type. */
function phMatch(tree, ph) {
  if (!tree || !ph) return null;
  const type = ph.getAttribute("type") || "body", idx = ph.getAttribute("idx");
  const all = kids(tree, P, "sp").filter((s) => phOf(s));
  return (idx != null && all.find((s) => phOf(s).getAttribute("idx") === idx)) || all.find((s) => (phOf(s).getAttribute("type") || "body") === type) || (type === "ctrTitle" ? all.find((s) => phOf(s).getAttribute("type") === "title") : null) || (type === "subTitle" ? all.find((s) => (phOf(s).getAttribute("type") || "body") === "body") : null);
}

/** Smaller type, a step at a time, until the text fits its box (as PowerPoint shrinks it), never under 40%. */
function shrinkToFit(box) {
  if (!box.isConnected || !box.clientHeight) return;
  let total = 1;
  for (let k = 0; k < 8 && box.scrollHeight > box.clientHeight + 1 && total > 0.4; k++) {
    const f = Math.max(0.6, Math.min(0.97, (box.clientHeight / box.scrollHeight) * 0.99));
    total *= f;
    for (const e of box.querySelectorAll(".sl-p, .sl-p span")) {
      for (const prop of ["fontSize", "marginTop", "marginBottom"]) {
        const v = parseFloat(e.style[prop]);
        if (v) e.style[prop] = v * f + "px";
      }
      const lh = e.style.lineHeight;
      if (lh && lh.endsWith("px")) e.style.lineHeight = parseFloat(lh) * f + "px";
    }
  }
}

export async function mountSlides(el, bytes, { onEdit = null } = {}) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const read = (p) => (zip.file(p) ? zip.file(p).async("string") : null);
  const docs = new Map(); // parsed parts, shared by every slide that uses them
  const parse = async (p) => { if (!docs.has(p)) docs.set(p, xml((await read(p)) || "<x/>")); return docs.get(p); };
  const pres = await parse("ppt/presentation.xml");
  const sz = first(pres, P, "sldSz");
  const W = sz ? +sz.getAttribute("cx") : 12192000;
  const H = sz ? +sz.getAttribute("cy") : 6858000;
  const presRels = relsOf(await parse("ppt/_rels/presentation.xml.rels"));
  const order = kids(pres, P, "sldId").map((s) => presRels.get(s.getAttributeNS(R, "id"))).filter(Boolean).map((t) => join("ppt/presentation.xml", t));
  const defaultStyle = first(pres, P, "defaultTextStyle");
  const urls = [];
  const media = new Map(); // zip path -> object URL, once per picture
  const urlOf = async (path) => {
    if (media.has(path)) return media.get(path);
    const f = zip.file(path);
    const ext = path.split(".").pop().toLowerCase();
    const u = f && MIME[ext] ? URL.createObjectURL(new Blob([await f.async("uint8array")], { type: MIME[ext] })) : null;
    if (u) urls.push(u);
    media.set(path, u);
    return u;
  };

  const wrap = h("div", { class: "sl-deck" });
  const count = h("div", { class: "sl-count", text: `${order.length} slide${order.length === 1 ? "" : "s"}${onEdit ? " · click a text to change it - the words only; layout, fonts and pictures stay as they are" : " · preview"}` });
  const changed = new Map();
  el.replaceChildren(h("div", { class: "sl-wrap" }, count, wrap));
  const fit = () => {
    const k = Math.min(1, (el.clientWidth - 48) / (W / EMU * 96));
    wrap.style.setProperty("--k", String(Math.max(0.2, k)));
  };
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  const px = (v) => (v / EMU) * 96 + "px";

  for (const [n, path] of order.entries()) {
    // the slide, its layout, its master and the master's theme
    const doc = await parse(path);
    const relsDoc = await parse(relsPath(path));
    const rels = relsOf(relsDoc);
    const layoutPath = relOfType(relsDoc, "slideLayout") ? join(path, relOfType(relsDoc, "slideLayout")) : null;
    const layout = layoutPath ? await parse(layoutPath) : null;
    const layoutRelsDoc = layoutPath ? await parse(relsPath(layoutPath)) : null;
    const masterPath = layoutRelsDoc && relOfType(layoutRelsDoc, "slideMaster") ? join(layoutPath, relOfType(layoutRelsDoc, "slideMaster")) : null;
    const master = masterPath ? await parse(masterPath) : null;
    const masterRelsDoc = masterPath ? await parse(relsPath(masterPath)) : null;
    const themePath = masterRelsDoc && relOfType(masterRelsDoc, "theme") ? join(masterPath, relOfType(masterRelsDoc, "theme")) : null;
    const theme = readTheme(themePath ? await parse(themePath) : null, first(master, P, "clrMap"));
    const txStyles = first(master, P, "txStyles");
    const editable = !!onEdit;

    const slide = h("div", { class: "sl-slide", style: { width: px(W), height: px(H) } });

    // the background: the slide's, else its layout's, else its master's
    for (const d of [doc, layout, master]) {
      const bgPr = first(first(d, P, "bg"), P, "bgPr");
      if (!bgPr) continue;
      const solid = child(bgPr, A, "solidFill");
      const grad = child(bgPr, A, "gradFill");
      const blip = first(child(bgPr, A, "blipFill"), A, "blip");
      if (solid) slide.style.background = colorOf(solid, theme) || "";
      else if (grad) { const stops = kids(grad, A, "gs").map((g) => `${colorOf(g, theme) || "#fff"} ${+g.getAttribute("pos") / 1000}%`); if (stops.length) slide.style.background = `linear-gradient(180deg, ${stops.join(", ")})`; }
      else if (blip) {
        const dRels = d === doc ? rels : relsOf(d === layout ? layoutRelsDoc : masterRelsDoc);
        const base = d === doc ? path : d === layout ? layoutPath : masterPath;
        const t = dRels.get(blip.getAttributeNS(R, "embed"));
        const u = t ? await urlOf(join(base, t)) : null;
        if (u) slide.style.background = `center / cover no-repeat url("${u}")`;
      }
      break;
    }

    // a paragraph level's properties, nearest first: the paragraph, the shape's list style,
    // the layout's and master's placeholder, the master's text styles, the presentation's default
    const lvlEls = (lst, lvl) => (lst ? childs(lst, A, `lvl${lvl + 1}pPr`) : []);
    function chainFor(sp, ph, srcLayout, srcMaster, lvl, pPr) {
      const type = ph ? ph.getAttribute("type") || "body" : "";
      const style = !ph ? first(txStyles, P, "otherStyle") : type === "title" || type === "ctrTitle" ? first(txStyles, P, "titleStyle") : /^(body|subTitle|obj)$/.test(type) || ph.getAttribute("idx") ? first(txStyles, P, "bodyStyle") : first(txStyles, P, "otherStyle");
      return [
        pPr,
        ...lvlEls(first(first(sp, P, "txBody"), A, "lstStyle"), lvl),
        ...lvlEls(first(first(srcLayout, P, "txBody"), A, "lstStyle"), lvl),
        ...lvlEls(first(first(srcMaster, P, "txBody"), A, "lstStyle"), lvl),
        ...lvlEls(style, lvl),
        ...(ph ? [] : lvlEls(defaultStyle, lvl)),
      ].filter(Boolean);
    }
    const pick = (chain, get) => { for (const e of chain) { const v = get(e); if (v != null && v !== "") return v; } return null; };
    const bodyPrOf = (sp, srcLayout, srcMaster) => [sp, srcLayout, srcMaster].map((s) => first(first(s, P, "txBody"), A, "bodyPr")).filter(Boolean);

    function drawText(sp, b, ph, srcLayout, srcMaster, mine, z) {
      const body = first(sp, P, "txBody") || child(sp, A, "txBody");
      if (!body) return null;
      const type = ph ? ph.getAttribute("type") || "body" : "";
      const isTitle = type === "title" || type === "ctrTitle";
      const bodies = bodyPrOf(sp, srcLayout, srcMaster).concat(child(sp, A, "bodyPr") ? [child(sp, A, "bodyPr")] : []);
      const bAttr = (k, d) => { const v = pick(bodies, (e) => e.getAttribute(k)); return v == null ? d : v; };
      const auto = pick(bodies, (e) => child(e, A, "normAutofit"));
      const scale = auto && auto.getAttribute("fontScale") ? +auto.getAttribute("fontScale") / 100000 : 1;
      const lnRed = auto && auto.getAttribute("lnSpcReduction") ? +auto.getAttribute("lnSpcReduction") / 100000 : 0;
      const anchor = bAttr("anchor", isTitle ? "ctr" : "t");
      const ins = (k, d) => px(+bAttr(k, d));
      const numbers = new Map(); // level -> the next number of an auto-numbered list
      const paras = childs(body, A, "p");
      const out = [];
      let blank = true;
      for (const p of paras) {
        const pPr = child(p, A, "pPr");
        const lvl = +(pPr && pPr.getAttribute("lvl") || 0);
        const chain = chainFor(sp, ph, srcLayout, srcMaster, lvl, pPr);
        const defR = chain.map((e) => child(e, A, "defRPr")).filter(Boolean);
        const algn = pick(chain, (e) => e.getAttribute("algn")) || "l";
        const marL = +(pick(chain, (e) => e.getAttribute("marL")) || 0);
        const indent = +(pick(chain, (e) => e.getAttribute("indent")) || 0);
        const spc = (name) => { const s = pick(chain, (e) => child(e, A, name)); if (!s) return null; const pts = child(s, A, "spcPts"), pct = child(s, A, "spcPct"); return pts ? { pt: +pts.getAttribute("val") / 100 } : pct ? { pct: +pct.getAttribute("val") / 100000 } : null; };
        const lnSpc = spc("lnSpc"), spcBef = spc("spcBef"), spcAft = spc("spcAft");
        // the bullet: the nearest level that says anything about one
        const buEl = pick(chain, (e) => child(e, A, "buNone") || child(e, A, "buChar") || child(e, A, "buAutoNum") || child(e, A, "buBlip"));
        const runs = [...p.children].filter((c) => c.namespaceURI === A && (c.localName === "r" || c.localName === "br" || c.localName === "fld"));
        const endSz = +(child(p, A, "endParaRPr")?.getAttribute("sz") || 0);
        const firstSz = (() => { for (const r of runs) { const s = child(r, A, "rPr")?.getAttribute("sz"); if (s) return +s; } return 0; })();
        const baseSz = (firstSz || +(pick(defR, (e) => e.getAttribute("sz")) || 0) || endSz || (isTitle ? 4400 : 1800)) / 100;
        const text = runs.map((r) => (r.localName === "br" ? "\n" : first(r, A, "t")?.textContent || "")).join("");
        if (text.trim()) blank = false;
        const pe = h("p", { class: "sl-p" });
        const fs = baseSz * scale;
        pe.style.textAlign = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" }[algn] || "left";
        pe.style.fontSize = fs * 1.333 + "px";
        pe.style.paddingLeft = px(marL);
        pe.style.textIndent = px(indent);
        pe.style.lineHeight = lnSpc && lnSpc.pct ? String(Math.max(0.6, lnSpc.pct * 1.2 * (1 - lnRed))) : lnSpc && lnSpc.pt ? lnSpc.pt * 1.333 + "px" : String(1.2 * (1 - lnRed));
        if (spcBef) pe.style.marginTop = spcBef.pt ? spcBef.pt * 1.333 * scale + "px" : spcBef.pct * fs * 1.333 + "px";
        if (spcAft) pe.style.marginBottom = spcAft.pt ? spcAft.pt * 1.333 * scale + "px" : spcAft.pct * fs * 1.333 + "px";
        if (buEl && buEl.localName !== "buNone" && text.trim()) {
          const buClr = pick(chain, (e) => child(e, A, "buClr"));
          const buFont = pick(chain, (e) => child(e, A, "buFont"));
          const buSz = pick(chain, (e) => child(e, A, "buSzPct"));
          let mark = "•";
          if (buEl.localName === "buChar") mark = buEl.getAttribute("char") || "•";
          if (buEl.localName === "buAutoNum") {
            const start = +(buEl.getAttribute("startAt") || 1);
            const k = numbers.has(lvl) ? numbers.get(lvl) : start;
            numbers.set(lvl, k + 1);
            const t = buEl.getAttribute("type") || "arabicPeriod";
            const alpha = (x) => String.fromCharCode(96 + ((x - 1) % 26) + 1);
            const roman = (x) => [["m", 1000], ["cm", 900], ["d", 500], ["cd", 400], ["c", 100], ["xc", 90], ["l", 50], ["xl", 40], ["x", 10], ["ix", 9], ["v", 5], ["iv", 4], ["i", 1]].reduce((s, [r, v]) => { while (x >= v) { s += r; x -= v; } return s; }, "");
            const core = /alphaLc/.test(t) ? alpha(k) : /alphaUc/.test(t) ? alpha(k).toUpperCase() : /romanLc/.test(t) ? roman(k) : /romanUc/.test(t) ? roman(k).toUpperCase() : String(k);
            mark = /ParenBoth/.test(t) ? `(${core})` : /ParenR/.test(t) ? `${core})` : /Plain/.test(t) ? core : `${core}.`;
          }
          const bu = h("span", { class: "sl-bu", text: mark });
          if (buClr) bu.style.color = colorOf(buClr, theme) || "";
          if (buFont && buFont.getAttribute("typeface") && !/^(Wingdings|Symbol)/i.test(buFont.getAttribute("typeface"))) bu.style.fontFamily = `"${buFont.getAttribute("typeface")}"`;
          if (buSz) bu.style.fontSize = +buSz.getAttribute("val") / 1000 + "%";
          // Wingdings' bullets are glyphs of their own: the usual dot stands for them
          if (buFont && /^(Wingdings|Symbol)/i.test(buFont.getAttribute("typeface") || "")) bu.textContent = { "§": "■", "Ø": "➢", "ü": "✓", "q": "❑", "v": "❖", "l": "●", "n": "■", "Ü": "➤", "è": "➔" }[mark] || "•";
          pe.append(bu);
        } else if (!text.trim() && !runs.length) pe.style.minHeight = fs * 1.333 * 1.2 + "px";
        // each run with its own look; what it does not say comes from the level's defaults
        for (const r of runs) {
          if (r.localName === "br") { pe.append(h("br")); continue; }
          const rPr = child(r, A, "rPr");
          const rc = [rPr, ...defR].filter(Boolean);
          const span = h("span", { text: first(r, A, "t")?.textContent || "" });
          const sz2 = rPr && rPr.getAttribute("sz");
          if (sz2 && +sz2 / 100 !== baseSz) span.style.fontSize = (+sz2 / 100) * scale * 1.333 + "px";
          const bold = pick(rc, (e) => e.getAttribute("b"));
          if (bold === "1") span.style.fontWeight = "700";
          if (pick(rc, (e) => e.getAttribute("i")) === "1") span.style.fontStyle = "italic";
          const u = pick(rc, (e) => e.getAttribute("u"));
          const strike = pick(rc, (e) => e.getAttribute("strike"));
          span.style.textDecoration = [u && u !== "none" ? "underline" : "", strike && strike !== "noStrike" ? "line-through" : ""].filter(Boolean).join(" ");
          const fill = pick(rc, (e) => child(e, A, "solidFill"));
          span.style.color = (fill && colorOf(fill, theme)) || "";
          const hl = rPr && child(rPr, A, "highlight");
          if (hl) span.style.background = colorOf(hl, theme) || "";
          const latin = pick(rc, (e) => child(e, A, "latin")?.getAttribute("typeface"));
          const face = latin === "+mj-lt" ? theme.major : latin === "+mn-lt" ? theme.minor : latin;
          if (face) span.style.fontFamily = `"${face}", "Segoe UI", sans-serif`;
          const base = pick(rc, (e) => e.getAttribute("baseline"));
          if (base && +base) { span.style.verticalAlign = +base > 0 ? "super" : "sub"; span.style.fontSize = "0.7em"; }
          const cap = pick(rc, (e) => e.getAttribute("cap"));
          if (cap === "all") span.style.textTransform = "uppercase";
          if (cap === "small") span.style.fontVariant = "small-caps";
          pe.append(span);
        }
        // the default colour of the paragraph (an empty one, the bullet's when none is set)
        const pFill = pick(defR, (e) => child(e, A, "solidFill"));
        if (pFill) pe.style.color = colorOf(pFill, theme) || "";
        const pFace = pick(defR, (e) => child(e, A, "latin")?.getAttribute("typeface"));
        const face = pFace === "+mj-lt" ? theme.major : pFace === "+mn-lt" ? theme.minor : pFace || (isTitle ? theme.major : theme.minor);
        if (face) pe.style.fontFamily = `"${face}", "Segoe UI", sans-serif`;
        if (pick(defR, (e) => e.getAttribute("b")) === "1") pe.style.fontWeight = "700";
        if (pick(defR, (e) => e.getAttribute("i")) === "1") pe.style.fontStyle = "italic";
        if (mine && text.trim() && runs.some((r) => r.localName === "r")) {
          pe.contentEditable = "plaintext-only";
          pe.spellcheck = true;
          // Enter would split a paragraph PowerPoint keeps as one: it ends the edit instead
          pe.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pe.blur(); } });
          pe.addEventListener("input", () => put(p, pe.textContent.replace(/\n/g, " ")));
        }
        out.push(pe);
      }
      if (blank) return null;
      const box = h("div", { class: "sl-text", style: {
        left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), zIndex: String(z),
        paddingLeft: ins("lIns", 91440), paddingRight: ins("rIns", 91440), paddingTop: ins("tIns", 45720), paddingBottom: ins("bIns", 45720),
        justifyContent: anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start",
      } }, out);
      if (bAttr("vert", "horz") !== "horz") box.style.writingMode = "vertical-rl";
      // no wrapping: each line as long as it is, growing away from its alignment (right-aligned grows left)
      if (bAttr("wrap", "square") === "none") for (const pe of out) {
        pe.style.whiteSpace = "pre";
        pe.style.width = "max-content";
        pe.style.alignSelf = pe.style.textAlign === "right" ? "flex-end" : pe.style.textAlign === "center" ? "center" : "flex-start";
      }
      // text that may shrink to fit its box (PowerPoint's "shrink text on overflow", which it works
      // out again when a file is opened - older files do not even store how much)
      if (auto || (ph && !isTitle && !pick(bodies, (e) => child(e, A, "noAutofit") || child(e, A, "spAutoFit")))) box.dataset.fit = "1";
      return box;
    }

    // a shape's fill and outline, when it has either
    function shapeLook(sp, el2) {
      const spPr = child(sp, P, "spPr");
      if (!spPr) return false;
      let any = false;
      const solid = child(spPr, A, "solidFill"), grad = child(spPr, A, "gradFill");
      if (solid) { el2.style.background = colorOf(solid, theme) || ""; any = true; }
      else if (grad) { const stops = kids(grad, A, "gs").map((g) => `${colorOf(g, theme) || "transparent"} ${+g.getAttribute("pos") / 1000}%`); const lin = child(grad, A, "lin"); if (stops.length) { el2.style.background = `linear-gradient(${lin ? (+lin.getAttribute("ang") / 60000 + 90) : 180}deg, ${stops.join(", ")})`; any = true; } }
      else if (!child(spPr, A, "noFill")) {
        // the theme's fill by reference (a styled shape): its colour, as PowerPoint draws it
        const ref = first(first(sp, P, "style"), A, "fillRef");
        if (ref && +ref.getAttribute("idx") > 0) { el2.style.background = colorOf(ref, theme) || ""; any = !!el2.style.background; }
      }
      const ln = child(spPr, A, "ln");
      if (ln && !child(ln, A, "noFill")) {
        const c = colorOf(child(ln, A, "solidFill"), theme);
        const w = Math.max(1, (+(ln.getAttribute("w") || 12700) / EMU) * 96);
        if (c) { el2.style.border = `${w}px ${child(ln, A, "prstDash") && child(ln, A, "prstDash").getAttribute("val") !== "solid" ? "dashed" : "solid"} ${c}`; any = true; }
      } else if (!ln) {
        const ref = first(first(sp, P, "style"), A, "lnRef");
        if (ref && +ref.getAttribute("idx") > 0 && (solid || grad)) { const c = colorOf(ref, theme); if (c) { el2.style.border = `1px solid ${c}`; any = true; } }
      }
      const geom = child(spPr, A, "prstGeom");
      const g = geom ? geom.getAttribute("prst") : "rect";
      if (g === "ellipse") el2.style.borderRadius = "50%";
      else if (g === "roundRect") el2.style.borderRadius = "8%";
      el2.style.boxSizing = "border-box";
      return any;
    }

    // one tree of shapes, in order; `mine`: the slide's own (not its layout's or master's) - its words can be changed when editing is on
    async function drawTree(tree, base, dRels, mine, tf = (b) => b, layer = []) {
      let z = layer.length;
      for (const node of tree ? [...tree.children] : []) {
        const name = node.localName;
        if (name === "grpSp") {
          const x = xfrmOf(node);
          const off = child(x, A, "off"), ext = child(x, A, "ext"), cOff = child(x, A, "chOff"), cExt = child(x, A, "chExt");
          const inner = off && ext && cOff && cExt ? (b) => {
            const kx = +cExt.getAttribute("cx") ? +ext.getAttribute("cx") / +cExt.getAttribute("cx") : 1, ky = +cExt.getAttribute("cy") ? +ext.getAttribute("cy") / +cExt.getAttribute("cy") : 1;
            return tf({ ...b, x: +off.getAttribute("x") + (b.x - +cOff.getAttribute("x")) * kx, y: +off.getAttribute("y") + (b.y - +cOff.getAttribute("y")) * ky, w: b.w * kx, h: b.h * ky });
          } : tf;
          await drawTree(node, base, dRels, mine, inner, layer);
          z = layer.length;
          continue;
        }
        if (name === "pic") {
          const b0 = boxOf(node);
          const blip = first(node, A, "blip");
          const target = blip && dRels.get(blip.getAttributeNS(R, "embed"));
          if (!b0 || !target) continue;
          const u = await urlOf(join(base, target));
          if (!u) continue;
          const b = tf(b0);
          const img = h("img", { class: "sl-pic", src: u, alt: "", draggable: false, style: { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), zIndex: String(++z) } });
          // a cropped picture: what PowerPoint shows of it
          const src = first(node, A, "srcRect");
          if (src) {
            const c = (k) => +(src.getAttribute(k) || 0) / 100000;
            const l = c("l"), t = c("t"), r = c("r"), bt = c("b");
            const frame = h("div", { class: "sl-crop", style: { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), zIndex: String(z) } },
              h("img", { src: u, alt: "", draggable: false, style: { position: "absolute", left: `${(-l / (1 - l - r)) * 100}%`, top: `${(-t / (1 - t - bt)) * 100}%`, width: `${(1 / (1 - l - r)) * 100}%`, height: `${(1 / (1 - t - bt)) * 100}%` } }));
            layer.push(frame);
            continue;
          }
          img.style.objectFit = "fill";
          if (b.rot || b.flipH || b.flipV) img.style.transform = `rotate(${b.rot}deg) scale(${b.flipH ? -1 : 1}, ${b.flipV ? -1 : 1})`;
          layer.push(img);
          continue;
        }
        if (name === "graphicFrame") {
          const tbl = first(node, A, "tbl");
          const b0 = boxOf(node);
          if (!tbl || !b0) continue;
          const b = tf(b0);
          const cols = kids(first(tbl, A, "tblGrid"), A, "gridCol").map((c) => +c.getAttribute("w"));
          const t = h("table", { class: "sl-tbl", style: { left: px(b.x), top: px(b.y), width: px(cols.reduce((a, c) => a + c, 0) || b.w), zIndex: String(++z) } },
            h("colgroup", {}, cols.map((w) => h("col", { style: { width: px(w) } }))),
            childs(tbl, A, "tr").map((tr) => h("tr", { style: { height: px(+tr.getAttribute("h")) } }, childs(tr, A, "tc").filter((tc) => tc.getAttribute("hMerge") !== "1" && tc.getAttribute("vMerge") !== "1").map((tc) => {
              const td = h("td", { colSpan: +(tc.getAttribute("gridSpan") || 1), rowSpan: +(tc.getAttribute("rowSpan") || 1) });
              const tcPr = child(tc, A, "tcPr");
              const f = tcPr && child(tcPr, A, "solidFill");
              if (f) td.style.background = colorOf(f, theme) || "";
              for (const p of childs(child(tc, A, "txBody"), A, "p")) {
                const pe = h("p", { class: "sl-p" });
                for (const r of childs(p, A, "r")) {
                  const rPr = child(r, A, "rPr");
                  const s = h("span", { text: first(r, A, "t")?.textContent || "" });
                  if (rPr?.getAttribute("sz")) s.style.fontSize = (+rPr.getAttribute("sz") / 100) * 1.333 + "px";
                  if (rPr?.getAttribute("b") === "1") s.style.fontWeight = "700";
                  const fc = rPr && child(rPr, A, "solidFill");
                  if (fc) s.style.color = colorOf(fc, theme) || "";
                  pe.append(s);
                }
                td.append(pe);
              }
              return td;
            }))));
          layer.push(t);
          continue;
        }
        if (name !== "sp" && name !== "cxnSp") continue;
        const ph = phOf(node);
        // on a layout or the master, a placeholder is only a frame for the slide's own - not drawn
        if (!mine && ph) continue;
        const srcLayout = mine && ph ? phMatch(first(layout, P, "spTree"), ph) : null;
        const srcMaster = ph ? phMatch(first(master, P, "spTree"), ph) || (srcLayout ? phMatch(first(master, P, "spTree"), phOf(srcLayout)) : null) : null;
        const b0 = boxOf(node) || (srcLayout && boxOf(srcLayout)) || (srcMaster && boxOf(srcMaster));
        if (!b0) continue;
        const b = tf(b0);
        const shape = h("div", { class: "sl-shape", style: { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), zIndex: String(++z) } });
        if (name === "cxnSp") {
          const ln = child(child(node, P, "spPr"), A, "ln");
          const c = (ln && colorOf(child(ln, A, "solidFill"), theme)) || colorOf(first(first(node, P, "style"), A, "lnRef"), theme) || "#000";
          const w = Math.max(1, (+(ln?.getAttribute("w") || 12700) / EMU) * 96);
          const NS = "http://www.w3.org/2000/svg";
          const svg = document.createElementNS(NS, "svg");
          for (const [k, v] of Object.entries({ width: "100%", height: "100%", preserveAspectRatio: "none", viewBox: "0 0 100 100", style: "overflow:visible" })) svg.setAttribute(k, v);
          const line = document.createElementNS(NS, "line");
          for (const [k, v] of Object.entries({ x1: b.flipH ? 100 : 0, y1: b.flipV ? 100 : 0, x2: b.flipH ? 0 : 100, y2: b.flipV ? 0 : 100, stroke: c, "stroke-width": w, "vector-effect": "non-scaling-stroke" })) line.setAttribute(k, String(v));
          svg.append(line);
          shape.append(svg);
          layer.push(shape);
          continue;
        }
        if (shapeLook(node, shape)) {
          if (b.rot) shape.style.transform = `rotate(${b.rot}deg)`;
          layer.push(shape);
        }
        const text = drawText(node, b, ph, srcLayout, srcMaster, mine && editable, ++z);
        if (text) { if (b.rot) text.style.transform = `rotate(${b.rot}deg)`; layer.push(text); }
      }
      return layer;
    }

    // a paragraph's new words go into its first run, the others of that paragraph are dropped
    const put = (p, text) => {
      const runs = kids(p, A, "r");
      const t = first(runs[0], A, "t");
      if (!t) return;
      t.textContent = text;
      for (const r of runs.slice(1)) r.remove();
      for (const br of kids(p, A, "br")) br.remove();
      changed.set(path, doc);
      if (onEdit) onEdit();
    };

    // the master's own shapes, then the layout's, then the slide's - unless the slide or layout says not to
    const layer = [];
    const showMaster = (doc.documentElement.getAttribute("showMasterSp") !== "0") && (!layout || layout.documentElement.getAttribute("showMasterSp") !== "0");
    if (master && showMaster) await drawTree(first(master, P, "spTree"), masterPath, relsOf(masterRelsDoc), false, (b) => b, layer);
    if (layout) await drawTree(first(layout, P, "spTree"), layoutPath, relsOf(layoutRelsDoc), false, (b) => b, layer);
    await drawTree(first(doc, P, "spTree"), path, rels, true, (b) => b, layer);
    layer.forEach((x, i) => { x.style.zIndex = String(i + 1); });
    slide.append(...layer);
    wrap.append(h("div", { class: "sl-item" }, h("div", { class: "sl-num", text: String(n + 1) }), h("div", { class: "sl-frame", style: { width: `calc(${(W / EMU) * 96}px * var(--k, 1))`, height: `calc(${(H / EMU) * 96}px * var(--k, 1))` } }, slide)));
    for (const b of slide.querySelectorAll(".sl-text[data-fit]")) shrinkToFit(b);
  }
  fit();
  return {
    destroy() { ro.disconnect(); for (const u of urls) URL.revokeObjectURL(u); },
    /** The file with the changed slides written back; every other part of it as it was. */
    getBytes: onEdit ? async () => {
      const ser = new XMLSerializer();
      for (const [p, d] of changed) zip.file(p, ser.serializeToString(d));
      return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    } : null,
  };
}
