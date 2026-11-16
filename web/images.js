// Images in notes. Pasted or dropped pictures are re-encoded as WebP in the
// webview (small files, the same thing Obsidian's Image Converter does), saved
// next to the vault's other attachments and embedded as ![[name.webp]].
// Also: finding every image in a note, editing an embed's width in the
// Obsidian syntax, and the full-screen viewer that walks them.

import { h, safeName, dirname, joinPath, refocus, keyOf } from "./util.js";
import { icon } from "./icons.js";
import { wheelSideways } from "./folderdrawer.js";
import { isWebPicture } from "./mdparse.js";

const KEEP_TYPES = new Set(["image/gif", "image/svg+xml"]); // animation / vectors lose everything in WebP
const EXT_OF = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp", "image/avif": "avif" };

/**
 * Re-encode an image. `quality` 0.1..1, `maxSide` in px (0 = no limit),
 * `format` "webp" or "original". Returns { bytes, ext, width, height, before }.
 * The original is kept when converting would not make it smaller.
 */
export async function compressImage(blob, { quality = 0.8, maxSide = 2400, format = "webp" } = {}) {
  const origExt = EXT_OF[blob.type] || "png";
  const keep = async () => ({ bytes: new Uint8Array(await blob.arrayBuffer()), ext: origExt, origExt, before: blob.size, kept: true });
  if (format !== "webp" || KEEP_TYPES.has(blob.type)) return keep();
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return keep(); }
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  let out;
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, hgt);
    c.getContext("2d").drawImage(bmp, 0, 0, w, hgt);
    out = await c.convertToBlob({ type: "image/webp", quality });
  } else {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    c.getContext("2d").drawImage(bmp, 0, 0, w, hgt);
    out = await new Promise((r) => c.toBlob(r, "image/webp", quality));
  }
  bmp.close?.();
  if (!out || out.type !== "image/webp" || (out.size >= blob.size && scale === 1)) return keep();
  return { bytes: new Uint8Array(await out.arrayBuffer()), ext: "webp", origExt, width: w, height: hgt, before: blob.size };
}

/**
 * Where a new attachment goes, with Obsidian's rules for its
 * "Default location for new attachments": "" or "/" is the vault root,
 * "./" the note's own folder, "./sub" a folder under it, anything else a
 * vault path.
 */
export function attachmentDir(folder, notePath) {
  const f = String(folder ?? "").trim().replace(/\\/g, "/");
  const here = notePath ? dirname(notePath) : "";
  if (!f || f === "/") return "";
  if (f === "." || f === "./") return here;
  if (f.startsWith("./")) return joinPath(here, f.slice(2).replace(/^\/+|\/+$/g, ""));
  return f.replace(/^\/+|\/+$/g, "");
}

/** `Note name-1789000000000.webp`, the pattern the vault already uses. */
export function imageName(notePath, ext, now = Date.now()) {
  const base = notePath ? notePath.slice(notePath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") : "Pasted image";
  return `${safeName(base)}-${now}.${ext}`;
}

const EMBED_WIKI = /!\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?((?:\|[^\[\]\n]*)?)\]\]/g;
const EMBED_MD = /!\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i;

/** Every image embed in `text`, in order: { from, to, target }. */
export function imagesIn(text) {
  const out = [];
  for (const m of text.matchAll(EMBED_WIKI)) {
    const t = m[1].trim();
    if (IMG_EXT.test(t)) out.push({ from: m.index, to: m.index + m[0].length, target: t });
  }
  for (const m of text.matchAll(EMBED_MD)) {
    let t = m[2];
    try { t = decodeURI(t); } catch {} // a stray % is just text
    if (IMG_EXT.test(t.split(/[?#]/)[0]) || /^data:image\//.test(t)) out.push({ from: m.index, to: m.index + m[0].length, target: t });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The embed that starts at `pos` in a CodeMirror doc, if any. */
export function embedAt(doc, pos) {
  const line = doc.lineAt(pos);
  const rest = doc.sliceString(pos, line.to);
  const m = /^!\[\[[^\[\]\n]*\]\]/.exec(rest) || /^!\[[^\]\n]*\]\([^)\n]*\)/.exec(rest);
  return m ? { from: pos, to: pos + m[0].length, text: m[0] } : null;
}

/** Put the picture at `url` on the clipboard as PNG (the clipboard takes nothing else). */
export async function copyImageUrl(url) {
  // the write starts at once with the picture still on its way (a big one takes a moment to become a PNG):
  // what is pasted meanwhile is never the clipboard's old text by surprise - the caller says "Copying..."
  if (typeof ClipboardItem === "function" && ClipboardItem.supports?.("image/png") !== false) {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(url) })]); return; } catch { /* the older way below */ }
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": await pngOf(url) })]);
}
/** The picture at `url` (or a promise of it) as a PNG blob: a PNG file as it is, anything else drawn once and encoded. */
async function pngOf(url) {
  url = await url; // an address, or one still being decided
  try {
    const r = await fetch(url);
    const b = r.ok ? await r.blob() : null;
    if (b && b.type === "image/png") return b;
    if (b && typeof createImageBitmap === "function") {
      const bm = await createImageBitmap(b);
      const c = document.createElement("canvas");
      c.width = bm.width; c.height = bm.height;
      c.getContext("2d").drawImage(bm, 0, 0);
      const out = await new Promise((ok) => c.toBlob(ok, "image/png"));
      if (out) return out;
    }
  } catch { /* not fetchable here: through an <img> */ }
  const img = new Image();
  // the vault's asset protocol and the web both need this, or the canvas is tainted
  if (!/^data:/i.test(url)) img.crossOrigin = "anonymous";
  await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error("it did not load")); img.src = url; });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("it could not be read");
  return blob;
}

/** The width an embed asks for: ![[x.png|300]], ![[x.png|300|640x480]], ![alt|300](x.png). */
export function embedWidth(text) {
  const wiki = /^!\[\[[^|\]]*\|([^\]]*)\]\]$/.exec(text);
  const md = /^!\[[^\]|]*\|([^\]]*)\]\(/.exec(text);
  const params = (wiki || md)?.[1];
  if (!params) return 0;
  const n = params.split("|").map((p) => p.trim()).find((p) => /^\d+$/.test(p));
  return n ? +n : 0;
}

/** The same embed with its width set (0 removes it). Other parameters stay. */
export function setEmbedWidth(text, width) {
  const edit = (params) => {
    const parts = params ? params.split("|") : [];
    const i = parts.findIndex((p) => /^\s*\d+\s*$/.test(p));
    if (width > 0) { if (i >= 0) parts[i] = String(width); else parts.push(String(width)); }
    else if (i >= 0) parts.splice(i, 1);
    return parts.length ? "|" + parts.join("|") : "";
  };
  let m = /^!\[\[([^|\]]*)((?:\|[^\]]*)?)\]\]$/.exec(text);
  if (m) return `![[${m[1]}${edit(m[2].slice(1))}]]`;
  m = /^!\[([^\]|]*)((?:\|[^\]]*)?)\](\(.*\))$/.exec(text);
  if (m) return `![${m[1]}${edit(m[2].slice(1))}]${m[3]}`;
  return text;
}

const SIDE = /^\s*(left|right)\s*$/i;
const paramsOf = (text) => ((/^!\[\[[^|\]]*\|([^\]]*)\]\]$/.exec(text) || /^!\[[^\]|]*\|([^\]]*)\]\(/.exec(text))?.[1] || "");

/** "left" / "right" when the embed floats beside the text (![[pic.png|right|300]]), else "". */
export function embedSide(text) {
  const p = paramsOf(text).split("|").find((x) => SIDE.test(x));
  return p ? p.trim().toLowerCase() : "";
}

/** The address a picture links to: `![[pic.png|link:https://…]]`. */
export function embedLink(text) {
  const p = paramsOf(text).split("|").find((x) => /^\s*link:/i.test(x));
  return p ? p.trim().slice(5) : "";
}
/** The same embed linking to `url` ("" takes the link away). Other parameters stay. */
export function setEmbedLink(text, url) {
  const edit = (params) => {
    const parts = (params ? params.split("|") : []).filter((x) => !/^\s*link:/i.test(x));
    if (url) parts.push("link:" + url);
    return parts.length ? "|" + parts.join("|") : "";
  };
  const m = /^!\[\[([^|\]]*)((?:\|[^\]]*)?)\]\]$/.exec(text);
  return m ? `![[${m[1]}${edit(m[2].slice(1))}]]` : text;
}
/** The same embed floating on `side` ("left", "right", or "" for none). Other parameters stay. */
export function setEmbedSide(text, side) {
  const edit = (params) => {
    const parts = (params ? params.split("|") : []).filter((x) => !SIDE.test(x));
    if (side) parts.unshift(side);
    return parts.length ? "|" + parts.join("|") : "";
  };
  let m = /^!\[\[([^|\]]*)((?:\|[^\]]*)?)\]\]$/.exec(text);
  if (m) return `![[${m[1]}${edit(m[2].slice(1))}]]`;
  m = /^!\[([^\]|]*)((?:\|[^\]]*)?)\](\(.*\))$/.exec(text);
  if (m) return `![${m[1]}${edit(m[2].slice(1))}]${m[3]}`;
  return text;
}

/**
 * Full-screen viewer. `items`: [{ url, name, target, path? }].
 * Navigate: click the picture, arrows / space / PageUp-Down, Home / End, or
 * the thumbnail strip (T). Look: wheel zooms at the pointer, drag pans,
 * F toggles actual size, R / Shift+R rotate, H / V flip, I inverts the
 * colours, G makes it grey. Invert and grey stay on while you step through
 * (handy for reading white screenshots at night); rotation and flips are per
 * picture and can be written back to the file (S) when `actions.save` is given.
 * A picture with non-destructive edits beside it (imageedit.js) is shown as
 * edited, with a badge; O flips back to the untouched file, E opens the
 * editor. The file on disk is the same either way.
 * `actions`: { open(item), reveal(item), jump(item), save(item, blob) -> url,
 *              edit(item), editedUrl(item) -> url|null, share(item) -> menu rows }.
 */
/** A note's list for the viewer, without the web pictures still held back: its preloading and thumbnails would fetch them. The one clicked stays. */
export const withoutHeldPictures = (list, from, always, shown) => (always ? list : list.filter((x) => x.video || x.from === from || !isWebPicture(x.url) || shown.has(x.url)));

export function openViewer(items, index = 0, actions = {}) {
  if (!items.length) return;
  document.querySelector(".img-viewer")?.remove();
  let i = Math.max(0, Math.min(items.length - 1, index));
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  let rot = 0;
  let spin = 0; // the angle as drawn: keeps counting past 360 so turning never runs backwards
  let flipX = 1;
  let flipY = 1;
  let actual = false;
  let invert = false;
  let gray = false;
  let thumbsOn = items.length > 1;
  let barAt = actions.barPos ? actions.barPos() : "top";
  let edited = null; // the rendered edit for the picture on screen, if any
  let showOriginal = false;
  let editToken = 0;

  const img = h("img", { class: "iv-img", draggable: false, alt: "" });
  // a video of the note is one of the steps too: played here, with its own controls
  const vid = h("video", { class: "iv-video", controls: true, hidden: true, playsInline: true, preload: "metadata" });
  const isVid = () => !!(items[i] && items[i].video);
  const stopVideo = () => { if (vid.dataset.src) { vid.pause(); vid.removeAttribute("src"); delete vid.dataset.src; vid.load(); } vid.hidden = true; };
  const name = h("div", { class: "iv-name" });
  const count = h("div", { class: "iv-count" });
  const size = h("div", { class: "iv-size" });
  const btn = (ic, title, run, cls = "") => h("button", { class: "iv-btn " + cls, title, onclick: (e) => { e.stopPropagation(); run(); } }, icon(ic));
  const invertBtn = btn("contrast", "Invert colours (I)", () => { invert = !invert; apply(); }, "iv-pic");
  const grayBtn = btn("grayscale", "Greyscale (G)", () => { gray = !gray; apply(); }, "iv-pic");
  const actualBtn = btn("actualSize", "Actual size (F)", () => setActual(!actual), "iv-pic");
  const thumbBtn = btn("grid", "Thumbnails (T)", () => { thumbsOn = !thumbsOn; paintThumbs(); });
  const saveBtn = actions.save ? h("button", { class: "iv-save", title: "Write the rotation, flip and colours into the file (S)", onclick: (e) => { e.stopPropagation(); saveToFile(); } }, icon("save"), "Save to file") : null;
  const editBtn = actions.edit ? btn("pen", "Draw on it, add layers and filters (E)", () => openEditor()) : null;
  // a real switch, not a label: your edits on, or the file as it is on disk
  const editedTag = h("button", { class: "iv-edited", hidden: true, title: "Show the picture with or without your edits (O)", onclick: (e) => { e.stopPropagation(); toggleOriginal(); } },
    icon("layers"), h("span", { class: "iv-edited-text", text: "Edits on" }), h("i", { class: "iv-switch" }));
  const bar = h("div", { class: "iv-bar" },
    count, h("div", { class: "iv-title" }, name, size), h("div", { class: "iv-spacer" }),
    saveBtn,
    h("div", { class: "iv-group iv-pic" },
      btn("rotateLeft", "Rotate left (Shift+R or ↑)", () => turn(-90)),
      btn("rotateRight", "Rotate right (R or ↓)", () => turn(90)),
      btn("flipH", "Flip horizontally (H)", () => { flipX *= -1; apply(); }),
      btn("flipV", "Flip vertically (V)", () => { flipY *= -1; apply(); })),
    h("div", { class: "iv-group" }, invertBtn, grayBtn, actualBtn, items.length > 1 ? thumbBtn : null),
    editBtn ? h("div", { class: "iv-group iv-pic" }, editBtn) : null,
    h("div", { class: "iv-group" },
      actions.jump ? btn("fileText", "Show in the note", () => { close(); actions.jump(items[i]); }) : null,
      actions.reveal ? btn("folder", "Show in the file tree", () => { const x = items[i]; close(); actions.reveal(x); }) : null,
      actions.open ? btn("reveal", "Open in the default app", () => actions.open(items[i])) : null,
      btn(barAt === "bottom" ? "arrowUp" : "arrowDown", "Move the toolbar", () => moveBar()),
      btn("x", "Close (Esc)", () => close())));
  const stage = h("div", { class: "iv-stage" }, img, vid);
  const prev = h("button", { class: "iv-nav is-prev", title: "Previous (Left)", onclick: (e) => { e.stopPropagation(); go(-1); } }, icon("back"));
  const next = h("button", { class: "iv-nav is-next", title: "Next (Right)", onclick: (e) => { e.stopPropagation(); go(1); } }, icon("forward"));
  const thumbs = h("div", { class: "iv-thumbs" }, items.map((it, k) =>
    h("button", { class: "iv-thumb", title: it.name || it.target || "", onclick: (e) => { e.stopPropagation(); i = items.indexOf(it); if (i < 0) i = k; show(); } },
      it.video ? h("span", { class: "iv-thumb-vid" }, icon("film")) : h("img", { src: it.url, loading: "lazy", draggable: false, alt: "" }))));
  const root = h("div", { class: "img-viewer" + (barAt === "bottom" ? " bar-bottom" : ""), tabIndex: -1 }, stage, bar, editedTag, items.length > 1 ? prev : null, items.length > 1 ? next : null, items.length > 1 ? thumbs : null);

  wheelSideways(thumbs);
  // the strip stays out of the way: it shows for a moment on each step, and
  // whenever the pointer comes down to it
  let peekT = 0;
  const peek = () => { thumbs.classList.add("is-peek"); clearTimeout(peekT); peekT = setTimeout(() => thumbs.classList.remove("is-peek"), 1500); };

  const changed = () => rot !== 0 || flipX !== 1 || flipY !== 1 || invert || gray;
  function apply() {
    img.style.transform = `translate(${tx}px, ${ty}px) rotate(${spin}deg) scale(${zoom * flipX}, ${zoom * flipY})`;
    img.style.filter = [invert ? "invert(1)" : "", gray ? "grayscale(1)" : ""].filter(Boolean).join(" ") || "none";
    root.classList.toggle("is-zoomed", zoom > 1.01 || actual);
    root.classList.toggle("is-sideways", rot % 180 !== 0);
    root.classList.toggle("is-actual", actual);
    invertBtn.classList.toggle("is-on", invert);
    grayBtn.classList.toggle("is-on", gray);
    actualBtn.classList.toggle("is-on", actual);
    editedTag.hidden = !edited;
    editedTag.classList.toggle("is-off", showOriginal);
    editedTag.querySelector(".iv-edited-text").textContent = showOriginal ? "Edits off" : "Edits on";
    // baking a rotation into the file must never quietly bake the layers too
    if (saveBtn) saveBtn.hidden = !(changed() && items[i].path) || (!!edited && !showOriginal);
  }
  const resetView = () => { zoom = 1; tx = 0; ty = 0; };
  function turn(d) { if (isVid()) return; rot = (rot + d + 360) % 360; spin += d; resetView(); apply(); }
  function setActual(on) { actual = on; resetView(); apply(); }
  function paintThumbs() {
    thumbs.hidden = !thumbsOn;
    root.classList.toggle("has-thumbs", thumbsOn && items.length > 1);
    thumbBtn.classList.toggle("is-on", thumbsOn);
    [...thumbs.children].forEach((t, k) => t.classList.toggle("is-current", k === i));
    const t = thumbs.children[i];
    if (t) thumbs.scrollTo({ left: t.offsetLeft - (thumbs.clientWidth - t.offsetWidth) / 2, behavior: "smooth" });
    if (thumbsOn) peek();
  }
  function show() {
    const it = items[i];
    root.classList.toggle("is-video", !!it.video);
    if (it.video) {
      img.hidden = true;
      img.removeAttribute("src");
      edited = null;
      vid.hidden = false;
      if (vid.dataset.src !== it.url) { vid.dataset.src = it.url; vid.src = it.url; }
      // opened from the note's own player: it goes on from the same moment
      if (it.startAt) { const t = it.startAt; it.startAt = 0; if (vid.readyState >= 1) vid.currentTime = t; else vid.addEventListener("loadedmetadata", () => { vid.currentTime = t; }, { once: true }); }
      vid.play().catch(() => {});
      name.textContent = it.name || it.target || "";
      size.textContent = "";
      count.textContent = items.length > 1 ? `${i + 1} / ${items.length}` : "";
      apply();
      paintThumbs();
      return;
    }
    stopVideo();
    img.hidden = false;
    resetView();
    rot = 0; spin = 0; flipX = 1; flipY = 1;
    img.classList.add("no-anim");
    requestAnimationFrame(() => img.classList.remove("no-anim"));
    apply();
    // local pictures load CORS-clean so a transformed copy can be saved;
    // web pictures would fail to load that way, so they stay view-only
    if (/^(blob:|data:)|asset\.localhost|^asset:/i.test(it.url)) img.crossOrigin = "anonymous";
    else img.removeAttribute("crossorigin");
    img.src = it.url;
    name.textContent = it.name || it.target || "";
    size.textContent = "";
    count.textContent = items.length > 1 ? `${i + 1} / ${items.length}` : "";
    paintThumbs();
    // warm the neighbours so stepping through is instant
    for (const d of [1, -1]) { const n = items[(i + d + items.length) % items.length]; if (n && !n.video) new Image().src = n.url; }
    loadEdited(it);
  }

  /**
   * The picture has edits stored beside it: show those instead. The file is
   * not touched either way - this is a render, made here and thrown away.
   */
  async function loadEdited(it) {
    edited = null;
    showOriginal = false;
    apply();
    if (!actions.editedUrl || !it.path) return;
    const token = ++editToken;
    let url = null;
    try { url = await actions.editedUrl(it); } catch {}
    let off = false;
    try { off = !!(url && actions.editsOff && (await actions.editsOff(it))); } catch {}
    if (!url || token !== editToken || items[i] !== it) return;
    edited = url;
    // switched off last time: it stays off until you switch it back
    showOriginal = off;
    if (!off) img.src = url;
    apply();
  }
  function toggleOriginal() {
    if (!edited) return;
    showOriginal = !showOriginal;
    img.src = showOriginal ? items[i].url : edited;
    apply();
    if (actions.setEditsOff) Promise.resolve(actions.setEditsOff(items[i], showOriginal)).catch(() => {});
    flash(showOriginal ? "Edits off - they are kept, and stay off until you switch them on" : "Showing your edits");
  }
  async function openEditor() {
    const it = items[i];
    if (it.video || !actions.edit || !it.path) return;
    await actions.edit(it);
    if (items[i] === it) loadEdited(it);
  }
  img.addEventListener("load", () => { size.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; });
  vid.addEventListener("loadedmetadata", () => { size.textContent = `${vid.videoWidth} × ${vid.videoHeight}`; });
  function go(d) { if (items.length > 1) { i = (i + d + items.length) % items.length; show(); } }
  function close() {
    closeMenu();
    stopVideo();
    root.remove();
    document.removeEventListener("keydown", onKey, true);
    refocus(prevFocus);
  }

  // Bake rotation, flips and colour filters into the picture and hand it to
  // the host to write. Same format as the file; WebP stays WebP.
  function moveBar() {
    barAt = barAt === "bottom" ? "top" : "bottom";
    root.classList.toggle("bar-bottom", barAt === "bottom");
    const b = bar.querySelector('[title="Move the toolbar"]');
    if (b) b.replaceChildren(icon(barAt === "bottom" ? "arrowUp" : "arrowDown"));
    if (actions.setBarPos) actions.setBarPos(barAt);
  }

  // the picture as shown (rotation, flips, colours) drawn into a canvas
  function rendered() {
    const w = img.naturalWidth;
    const hgt = img.naturalHeight;
    const side = rot % 180 !== 0;
    const c = document.createElement("canvas");
    c.width = side ? hgt : w;
    c.height = side ? w : hgt;
    const g = c.getContext("2d");
    g.filter = img.style.filter === "none" ? "none" : img.style.filter;
    g.translate(c.width / 2, c.height / 2);
    g.rotate((rot * Math.PI) / 180);
    g.scale(flipX, flipY);
    g.drawImage(img, -w / 2, -hgt / 2);
    return c;
  }

  // Ctrl+C: the picture (as shown) goes to the clipboard as PNG
  async function copyImage() {
    if (isVid() || !img.naturalWidth) return;
    try {
      const blob = await new Promise((r) => rendered().toBlob(r, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash("Picture copied");
    } catch {
      flash("Could not copy this picture");
    }
  }
  function copyText(t, what) {
    navigator.clipboard.writeText(t).then(() => flash(what + " copied"), () => {});
  }
  const note = h("div", { class: "iv-flash", hidden: true });
  let flashTimer = 0;
  function flash(text) {
    note.textContent = text;
    note.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { note.hidden = true; }, 1400);
  }

  // right-click: everything the viewer can do, in one place
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(x, y) {
    closeMenu();
    const it = items[i];
    // one line each, and a label never appears twice: the share actions
    // offer "Copy embed link" too, which used to show up beside our own
    const seen = new Set();
    const row = (ic, label, keys, run, on) => {
      if (seen.has(label)) return null;
      seen.add(label);
      return h("button", { class: "iv-mi" + (on ? " is-on" : ""), title: label, onclick: (e) => { e.stopPropagation(); closeMenu(); run(); } },
        icon(ic), h("span", { text: label }), keys ? h("kbd", { text: keys }) : null);
    };
    const sep = () => h("div", { class: "iv-msep" });
    menuEl = h("div", { class: "iv-menu", onpointerdown: (e) => e.stopPropagation(), oncontextmenu: (e) => e.preventDefault() },
      it.video ? row(vid.paused ? "play" : "pause", vid.paused ? "Play" : "Pause", "Space", () => { if (vid.paused) vid.play().catch(() => {}); else vid.pause(); }) : null,
      it.video ? row("repeat", "Loop", "", () => { vid.loop = !vid.loop; }, vid.loop) : null,
      it.video && actions.playMedia && it.path ? row("music", "Play in the Player", "", () => { const x = items[i]; const t = vid.currentTime; close(); actions.playMedia(x, t); }) : null,
      it.video ? sep() : null,
      !it.video && actions.edit && it.path ? row("pen", edited ? "Edit layers and filters" : "Draw, layers and filters", "E", openEditor) : null,
      edited ? row("eye", showOriginal ? "Show my edits" : "Show the file on disk", "O", toggleOriginal, !showOriginal) : null,
      edited && actions.removeEdits ? row("trash", "Remove my edits", "", () => { const x = items[i]; actions.removeEdits(x, () => { if (items[i] !== x) return; img.src = x.url; loadEdited(x); }); }) : null,
      !it.video && actions.edit && it.path ? sep() : null,
      it.video ? null : row("clipboard", edited ? (showOriginal ? "Copy picture as on disk" : "Copy picture with my edits") : "Copy picture", "Ctrl C", copyImage),
      edited ? row("layers", showOriginal ? "Copy it with my edits" : "Copy it without my edits", "", () => copyImageUrl(showOriginal ? edited : items[i].url).then(() => flash("Picture copied"), () => flash("Could not copy this picture"))) : null,
      it.path ? row("link", "Copy embed link", "", () => copyText(`![[${it.path.slice(it.path.lastIndexOf("/") + 1)}]]`, "Link")) : null,
      ...(!it.video && it.path && actions.share ? actions.share(it).map((r) => row(r.icon, r.label, "", r.run)) : []),
      row("file", "Copy path", "", () => copyText(it.path || it.url, "Path")),
      actions.save && it.path && changed() && !(edited && !showOriginal) ? row("save", "Save changes to file", "S", saveToFile) : null,
      ...(it.video ? [] : [
        sep(),
        row("rotateRight", "Rotate right", "R", () => turn(90)),
        row("rotateLeft", "Rotate left", "Shift R", () => turn(-90)),
        row("flipH", "Flip horizontally", "H", () => { flipX *= -1; apply(); }),
        row("flipV", "Flip vertically", "V", () => { flipY *= -1; apply(); }),
        row("contrast", "Invert colours", "I", () => { invert = !invert; apply(); }, invert),
        row("grayscale", "Greyscale", "G", () => { gray = !gray; apply(); }, gray),
        row("actualSize", "Actual size", "F", () => setActual(!actual), actual),
        row("expand", "Fit to window", "0", () => { resetView(); apply(); }),
      ]),
      items.length > 1 ? row("grid", "Thumbnails", "T", () => { thumbsOn = !thumbsOn; paintThumbs(); }, thumbsOn) : null,
      sep(),
      actions.jump ? row("fileText", "Show in the note", "", () => { close(); actions.jump(items[i]); }) : null,
      actions.reveal && it.path ? row("folder", "Show in the file tree", "", () => { const x = items[i]; close(); actions.reveal(x); }) : null,
      actions.explorer && it.path ? row("reveal", "Show in Explorer", "", () => actions.explorer(items[i])) : null,
      actions.usedIn && it.path ? row("link", "Where it is used…", "", () => actions.usedIn(items[i], innerWidth / 2 - 120, 120)) : null,
      actions.open ? row("reveal", "Open in the default app", "", () => actions.open(items[i])) : null,
      row(barAt === "bottom" ? "arrowUp" : "arrowDown", barAt === "bottom" ? "Toolbar at the top" : "Toolbar at the bottom", "", moveBar),
      row("x", "Close", "Esc", close));
    root.append(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + "px";
    menuEl.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + "px";
  }
  root.addEventListener("contextmenu", (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); });
  root.addEventListener("pointerdown", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  // clicking the dark space anywhere (not only around the picture) closes
  root.addEventListener("click", (e) => {
    if (e.target === root || e.target === bar || e.target.classList.contains("iv-spacer") || e.target === thumbs) close();
  });

  async function saveToFile() {
    const it = items[i];
    if (it.video || !actions.save || !it.path || !changed() || !img.naturalWidth) return;
    // what is on screen is a render of the sidecar, not the file: writing it
    // back would bake the layers in behind the user's back
    if (edited && !showOriginal) return flash("Press O for the file on disk first");
    if (actions.confirm) {
      const what = [invert ? "inverted colours" : "", gray ? "greyscale" : ""].filter(Boolean).join(" and ") || "this rotation or flip";
      if (!(await actions.confirm(`Write ${what} into the file?`, `${it.path.slice(it.path.lastIndexOf("/") + 1)} itself is changed - every note that shows it shows it like this. The version before goes to the trash first.`))) return;
    }
    const c = rendered();
    const ext = (it.path.split(".").pop() || "").toLowerCase();
    const type = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/webp";
    const blob = await new Promise((r) => c.toBlob(r, type, 0.92));
    if (!blob) return;
    try {
      const url = await actions.save(it, blob);
      if (url) it.url = url;
      invert = false;
      gray = false;
      thumbs.children[i]?.querySelector("img")?.setAttribute("src", it.url);
      show();
    } catch {}
  }

  /* Delete: out of the note it came from (or, for a folder's pictures, to the trash); Shift+Delete:
     its file to the trash as well. Both ask first; the caller does the work and says if it did. */
  let removing = false;
  async function removeCurrent(withFile) {
    const it = items[i];
    if (!it || !actions.remove || removing) return;
    removing = true;
    let done = false;
    try { done = await actions.remove(it, withFile); } finally { removing = false; }
    root.focus();
    if (!done) return;
    const at = items.indexOf(it);
    if (at < 0) return;
    items.splice(at, 1);
    if (thumbs.children[at]) thumbs.children[at].remove();
    if (!items.length) { close(); return; }
    i = Math.min(at, items.length - 1);
    show();
  }

  function onKey(e) {
    const k = keyOf(e); // the key, not the letter: these work on a Ukrainian layout too
    if (removing) return; // the question is up: its keys are its own
    if (menuEl && k === "Escape") { closeMenu(); e.preventDefault(); e.stopPropagation(); return; }
    if (isVid() && !e.ctrlKey && !e.altKey && !e.metaKey && (k === " " || k === "k" || k === "K")) {
      if (vid.paused) vid.play().catch(() => {}); else vid.pause();
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.ctrlKey && (e.code === "KeyC" || k.toLowerCase() === "c") && !getSelection().toString()) copyImage();
    else if (e.ctrlKey && k.toLowerCase() === "s") saveToFile();
    else if (e.ctrlKey || e.altKey || e.metaKey) return;
    else if (k === "Escape") close();
    else if (k === "ArrowRight" || k === " " || k === "PageDown") go(1);
    else if (k === "ArrowLeft" || k === "PageUp") go(-1);
    else if (k === "Home") { i = 0; show(); }
    else if (k === "End") { i = items.length - 1; show(); }
    else if (k === "+" || k === "=") { zoom = Math.min(8, zoom * 1.25); apply(); }
    else if (k === "-") { zoom = Math.max(1, zoom / 1.25); if (zoom === 1) { tx = 0; ty = 0; } apply(); }
    else if (k === "0") { resetView(); apply(); }
    // up / down turn by a quarter; held down, the picture keeps spinning
    else if (k === "ArrowUp") turn(-90);
    else if (k === "ArrowDown") turn(90);
    else if (k === "r") turn(90);
    else if (k === "R") turn(-90);
    else if (k === "h" || k === "H") { flipX *= -1; apply(); }
    else if (k === "v" || k === "V") { flipY *= -1; apply(); }
    else if (k === "i" || k === "I") { invert = !invert; apply(); }
    else if (k === "g" || k === "G") { gray = !gray; apply(); }
    else if (k === "f" || k === "F") setActual(!actual);
    else if ((k === "t" || k === "T") && items.length > 1) { thumbsOn = !thumbsOn; paintThumbs(); }
    else if ((k === "e" || k === "E") && actions.edit) openEditor();
    else if ((k === "o" || k === "O") && edited) toggleOriginal();
    else if (k === "s" || k === "S") saveToFile();
    else if (k === "Delete" && actions.remove) removeCurrent(e.shiftKey);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // click the picture: next one (unless it was the end of a pan); backdrop: close
  let moved = false;
  stage.addEventListener("click", (e) => {
    if (e.target === vid) return;
    if (moved) { moved = false; return; }
    if (e.target === img) go(1);
    else close();
  });
  stage.addEventListener("dblclick", (e) => {
    if (e.target !== img) return;
    // double-click: 2x at the pointer, or back to fit
    if (zoom > 1.01) resetView();
    else {
      const r = img.getBoundingClientRect();
      tx = -(e.clientX - (r.left + r.width / 2));
      ty = -(e.clientY - (r.top + r.height / 2));
      zoom = 2;
    }
    moved = false;
    apply();
  });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = img.getBoundingClientRect();
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nz = Math.max(actual ? 0.1 : 1, Math.min(8, zoom * f));
    // keep the point under the pointer still
    const cx = e.clientX - (r.left + r.width / 2);
    const cy = e.clientY - (r.top + r.height / 2);
    tx -= cx * (nz / zoom - 1);
    ty -= cy * (nz / zoom - 1);
    zoom = nz;
    if (zoom === 1 && !actual) { tx = 0; ty = 0; }
    apply();
  }, { passive: false });
  // Drag moves the picture (any zoom), left or middle button, only while held.
  // A picture moved at fit size springs back when let go.
  let panning = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    moved = false;
    if (e.target !== img && e.button === 0) return; // backdrop: a click closes
    e.preventDefault();
    const sx = e.clientX - tx;
    const sy = e.clientY - ty;
    const x0 = e.clientX;
    const y0 = e.clientY;
    try { stage.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      if (!ev.buttons) return end(); // the button came up somewhere we didn't hear
      if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) <= 4) return;
      moved = true;
      root.classList.add("is-panning");
      tx = ev.clientX - sx;
      ty = ev.clientY - sy;
      apply();
    };
    const end = () => {
      if (!panning) return;
      panning = null;
      stage.removeEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) stage.removeEventListener(t, end);
      window.removeEventListener("blur", end);
      root.classList.remove("is-panning");
      try { stage.releasePointerCapture(e.pointerId); } catch {}
      if (zoom <= 1.01 && !actual && (tx || ty)) { tx = 0; ty = 0; apply(); }
    };
    panning = end;
    stage.addEventListener("pointermove", move);
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) stage.addEventListener(t, end);
    window.addEventListener("blur", end);
  });
  stage.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });

  root.append(note);
  const prevFocus = document.activeElement;
  document.getElementById("overlay-root").append(root);
  document.addEventListener("keydown", onKey, true);
  root.focus();
  show();
  return { close, go };
}
