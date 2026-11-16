// The drawing modes, and the switch between them.
//
// Two kinds of file, because vectors and pixels are genuinely different things:
//
//   .leopaint   Leopaint - shapes, arrows, text and pen lines on an endless board (sketch.js);
//               a file of its own, for sketching ideas out and prototyping.
//               The inside is the open Excalidraw layout, so a copy can go to
//               excalidraw.com or Obsidian; .excalidraw files open here too.
//   .leostudio  Leostudio - pixels, with three ways of working over the SAME file, switched
//               freely (paint.js): Studio (brushes), Filter (adjustments, masks,
//               retouching - paintstudio.js) and Animate (frames - paintanim.js).
//
// Nothing heavy is imported here. Both editors load on first use through
// `import()`, so a session that never opens a drawing never pays for one.

import { h, safeName, basename } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast } from "./ui.js";
import * as D from "./paintdoc.js";
import { SETTING_KEYS, customCanvasPresets, saveCustomCanvas, removeCustomCanvas, createDoc } from "./paintstore.js";

export const MODES = [
  {
    id: "sketch",
    name: "Paint",
    ext: ".leopaint",
    blurb: "Shapes, arrows, text and pen lines on an endless board - sharp at any zoom.",
    detail: "Small files. Best for diagrams, mind maps, quick sketches and notes you draw on. A copy can go to excalidraw.com or Obsidian.",
    icon: "brush",
    match: (p) => /\.(leocanvas|leopaint|leovector|excalidraw)$/i.test(p),
  },
  {
    id: "draw",
    name: "Studio",
    ext: ".leostudio",
    blurb: "Pixels on a canvas with a real size: brushes, layers, blend modes, adjustments and frames.",
    detail: "One file, three ways of working you switch between freely: Studio for brushes, Filter for adjustments and retouching, Animate for frames.",
    icon: "studio",
    match: (p) => /\.leostudio$/i.test(p),
  },
];

export const MODE_BY_ID = new Map(MODES.map((m) => [m.id, m]));
export const DRAWING_RE = /\.(leocanvas|leopaint|leovector|excalidraw|leostudio)$/i;
export const VECTOR_RE = /\.(leocanvas|leopaint|leovector|excalidraw)$/i;
const STUDIO_RE = /\.leostudio$/i;

/**
 * The four ways of working, as the switch shows them. Paint is its own file
 * (.leopaint); Studio, Filter and Animate are three workspaces over one
 * .leostudio, so moving between them is instant and loses nothing.
 */
export const PERSONAS = [
  { id: "vector", name: "Paint", icon: "brush", file: "sketch", blurb: "Shapes, arrows, text and pen lines on an endless board - its own file, for working ideas out.", best: "Prototypes, diagrams, mind maps, quick sketches" },
  { id: "paint", name: "Studio", icon: "studio", file: "draw", workspace: "draw", blurb: "Brushes on pixels: pressure, layers, blend modes, symmetry.", best: "Illustration, painting, lettering" },
  { id: "photo", name: "Filter", icon: "image", file: "draw", workspace: "studio", blurb: "Adjust and retouch: curves, levels, masks, cut-outs, export sizes.", best: "Photos, thumbnails, covers" },
  { id: "animate", name: "Animate", icon: "animate", file: "draw", workspace: "animate", blurb: "Frame by frame with onion skin, played at your speed, saved as a video.", best: "Instagram posts, stories and reels, loops" },
];
export const PERSONA_BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));
const personaOfWorkspace = (w) => PERSONAS.find((p) => p.workspace === w) || PERSONAS[1];

/** Which mode a path belongs to, or null when it is not a drawing at all. */
export function modeOf(path) {
  const p = String(path || "");
  return MODES.find((m) => m.match(p)) || null;
}

/**
 * Open a drawing of either mode into `el`. Each editor's code is fetched only
 * the first time that mode is used.
 *
 * Returns the editor handle: `{ destroy, focus, save?, getText? }`.
 */
export async function openDrawing(el, path, opts = {}) {
  const mode = modeOf(path);
  if (!mode) throw new Error(`${path} is not a drawing`);
  if (mode.id === "draw") {
    const mod = await import("./paint.js");
    return { mode, ...(await mod.mountPaint(el, { ...opts, path })) };
  }
  const mod = await import("./sketch.js");
  const text = await opts.app.host.readText(path);
  return { mode, ...(await mod.mountSketch(el, text, { ...opts, path })) };
}

/* ── the mode badge ──────────────────────────────────────────────────────── */

/**
 * The little "Draw" / "Sketch" chip both editors show. It is not decoration:
 * it is where you find out what kind of document you are in, make the other
 * kind, and turn a sketch into a drawing.
 */
export function modeBadge(app, path, { compact = false } = {}) {
  const mode = modeOf(path) || MODES[0];
  return h("button", {
    class: "pt-mode-badge" + (compact ? " is-compact" : ""),
    title: `${mode.name} mode — ${mode.blurb}`,
    onclick: (e) => modeMenu(app, path, e.currentTarget),
  }, icon(mode.icon), h("span", { text: mode.name }), icon("chevronDown"));
}

export function modeMenu(app, path, anchor) {
  const mode = modeOf(path) || MODES[0];
  const items = [
    { header: `${mode.name} · ${mode.blurb}` },
    ...PERSONAS.map((p) => ({ label: `New ${p.name.toLowerCase()} drawing…`, icon: p.icon, run: () => newIn(app, p.id, { anchor }), sub: p.file === "draw" ? formatsSub(app, p.id, anchor) : null })),
  ];
  items.push("sep",
    { label: "Open a photo in Studio…", icon: "image", run: () => import("./paintexport.js").then((m) => m.libraryDialog(app, { tab: "photos", current: path })) },
    { label: "All drawings and photos…", icon: "grid", run: () => import("./paintexport.js").then((m) => m.libraryDialog(app, { current: path })) });
  if (mode.id === "sketch") items.push("sep", ...vectorCopies(app, path));
  menu(0, 0, items, { anchor });
}

/**
 * Leopaint's templates: on an empty board they fill it, otherwise each makes a
 * new board beside this one (or in the usual place) and starts it there.
 */
export async function templateMenu(app, path, anchor, { isEmpty = false, apply = null } = {}) {
  const { TEMPLATES } = await import("./sketchtemplates.js");
  const here = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
  const fill = isEmpty && apply;
  menu(0, 0, [
    { header: fill ? "Start this board from a template" : "A new board from a template" },
    ...TEMPLATES.map((t) => ({ label: t.name, tail: h("span", { class: "menu-hint", text: t.note }), icon: t.icon, run: () => (fill ? apply(t.id) : newFromTemplate(app, t.id, { dir: here, anchor })) })),
    "sep",
    { label: "A blank Leopaint board", icon: "plus", run: () => app.newSketch({ dir: here, anchor }) },
    { label: "New drawing of any kind…", icon: "brush", run: () => modeMenu(app, path, anchor) },
  ], { anchor });
}

/** A new Leopaint board that starts from a template (the editor puts it on when it opens). */
export async function newFromTemplate(app, id, { dir = null, anchor = null } = {}) {
  app._sketchTemplate = id;
  const made = await app.newSketch({ dir, anchor });
  if (!made) app._sketchTemplate = null;
  return made;
}

/** A vector drawing's ways out: a pixel copy, and the open Excalidraw layout for other apps. */
function vectorCopies(app, path) {
  const old = /\.(excalidraw|leovector|leocanvas)$/i.test(path);
  return [
    { label: "Make a Studio copy of this (pixels)", icon: "brush", run: () => sketchToDraw(app, path) },
    old ? { label: "Save a .leopaint copy", icon: "filePlus", run: () => copyAs(app, path, ".leopaint") }
      : { label: "Save a copy for excalidraw.com or Obsidian", icon: "outside", run: () => copyAs(app, path, ".excalidraw") },
  ];
}
async function copyAs(app, path, ext) {
  try {
    const text = await app.host.readText(path);
    const out = await freePath(app, path.replace(VECTOR_RE, ""), ext);
    const entry = await app.host.writeFile(out, new TextEncoder().encode(text));
    if (entry && entry.path) app.vault.setFiles([...[...app.vault.files.values()].filter((f) => f.path !== entry.path), entry]);
    toast(`Saved ${basename(out)}`, { ms: 3000, action: { label: "Open", run: () => app.openFile(out, { newTab: true }) } });
  } catch (e) { toast("Could not save the copy: " + (e && e.message ? e.message : e), { kind: "error" }); }
}

/* ── the formats you reach for ───────────────────────────────────────────── */

const useKey = (persona, id) => `${persona || "paint"}:${id}`;
/** Count a canvas size as used, for the "often used" lists. */
function countUse(app, persona, id) {
  if (!id || id === "custom") return;
  const m = { ...(app.settings.presetUse || {}) };
  const k = useKey(persona, id);
  m[k] = { n: ((m[k] && m[k].n) || 0) + 1, t: Date.now() };
  app.setSetting("presetUse", m);
}
const presetById = (app, id) => D.PRESET_BY_ID.get(id) || customCanvasPresets(app).find((m) => m.id === id) || null;
/**
 * The sizes to offer first for a way of working: the ones you use most (most
 * often, then most lately), then your own, then the ones made for it - `n` in all.
 */
export function oftenFormats(app, persona, n = 8) {
  const who = persona || "paint";
  const use = app.settings.presetUse || {};
  const used = Object.entries(use).filter(([k]) => k.startsWith(who + ":")).sort((a, b) => b[1].n - a[1].n || b[1].t - a[1].t).map(([k]) => k.slice(who.length + 1));
  const out = [];
  const add = (p, why) => { if (p && out.length < n && !out.some((x) => x.id === p.id)) out.push({ ...p, why }); };
  for (const id of used) add(presetById(app, id), "used");
  for (const p of customCanvasPresets(app)) add(p, "yours");
  const own = D.PRESET_GROUPS.find((g) => g.for === who);
  for (const p of (own || D.PRESET_GROUPS.find((g) => g.id === "square")).items) add(p, "");
  return out;
}

/** The often used sizes as a menu beside "New … drawing…": one click asks where, and makes it. */
export function formatsSub(app, persona, anchor) {
  const p = PERSONA_BY_ID.get(persona) || PERSONAS[1];
  const list = oftenFormats(app, p.id);
  return [
    { header: list.some((x) => x.why === "used") ? "Often used" : "Sizes to start from" },
    ...list.map((f) => ({ label: f.name, icon: f.why === "yours" ? "star" : f.why === "used" ? "clock" : "square", tail: h("span", { class: "menu-hint", text: `${f.w} × ${f.h}${f.fps ? ` · ${f.fps} fps` : ""}` }), run: () => quickDrawing(app, p.id, f.id, anchor) })),
    "sep",
    { label: `All sizes and your own…`, icon: "plus", run: () => newIn(app, p.id, { anchor }) },
  ];
}

const usualDirOf = (app, persona) => (app.workDir ? app.workDir(persona === "vector" ? "sketch" : persona === "animate" ? "animation" : "drawing") : "");

/** A drawing at a size picked from a list: where it goes (starred folders first), then straight in. */
export async function quickDrawing(app, persona, presetId, anchor) {
  const p = PERSONA_BY_ID.get(persona) || PERSONAS[1];
  const { pickFolder } = await import("./newtab.js");
  const size = presetById(app, presetId);
  const dir = await pickFolder(app, anchor, { title: `${size ? size.name : "New drawing"} in`, first: [usualDirOf(app, p.id), "the usual place"], stars: p.id });
  if (dir == null) return null;
  app.setSetting("drawPersona", p.id);
  if (p.workspace) app._paintNext = p.workspace;
  return newDrawing(app, { mode: "draw", persona: p.id, dir, preset: presetId, go: true });
}

/** Make a new drawing in a way of working: a vector board, or a .leostudio opened in Studio, Filter or Animate. */
export function newIn(app, persona, { dir = null, anchor = null } = {}) {
  const p = PERSONA_BY_ID.get(persona) || PERSONAS[1];
  app.setSetting("drawPersona", p.id);
  if (p.file === "sketch") return app.newSketch({ dir, anchor });
  app._paintNext = p.workspace;
  return newDrawing(app, { mode: "draw", dir, anchor, persona: p.id });
}

/**
 * Right-click on a way of working: what it is for, a new one, the recent files
 * of its kind, and the ways across from the file that is open.
 */
export function personaPanel(app, path, persona, e) {
  e.preventDefault();
  e.stopPropagation();
  const p = PERSONA_BY_ID.get(persona) || PERSONAS[1];
  const re = p.file === "sketch" ? VECTOR_RE : STUDIO_RE;
  const recent = [...app.vault.files.values()].filter((f) => re.test(f.path) && f.path !== path).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 6);
  const here = modeOf(path);
  menu(e.clientX, e.clientY, [
    { header: p.name },
    { header: p.blurb, plain: true },
    { header: "Best for: " + p.best, plain: true },
    "sep",
    { label: `New ${p.name.toLowerCase()} drawing…`, icon: p.icon, run: () => newIn(app, p.id), sub: p.file === "draw" ? formatsSub(app, p.id, null) : null },
    p.id === "photo" ? { label: "Open a photo in Filter…", icon: "image", run: () => import("./paintexport.js").then((m) => m.libraryDialog(app, { tab: "photos", current: path })) } : null,
    here && here.id === "sketch" && p.file === "draw" ? { label: `Continue this drawing in ${p.name}`, icon: "forward", run: () => sketchToDraw(app, path, { workspace: p.workspace }) } : null,
    ...(here && here.id === "sketch" && p.file === "sketch" ? vectorCopies(app, path) : []),
    recent.length ? "sep" : null,
    recent.length ? { header: "Recent" } : null,
    ...recent.map((f) => ({ label: basename(f.path).replace(DRAWING_RE, ""), icon: p.icon, run: () => { if (p.workspace) app._paintNext = p.workspace; app.openFile(f.path, { newTab: true }); } })),
  ]);
}

/**
 * The side button's card: the four ways of working to pick from, then where the
 * new one goes, and the recent ones of that kind under it.
 */
export async function drawingPortal(app, anchor) {
  const { pickFolder } = await import("./newtab.js");
  let persona = PERSONA_BY_ID.has(app.settings.drawPersona) ? app.settings.drawPersona : "vector";
  const recentBox = h("div", { class: "nt-recent" });
  let finishRef = null;
  const paintRecent = () => {
    const p = PERSONA_BY_ID.get(persona);
    const re = p.file === "sketch" ? VECTOR_RE : STUDIO_RE;
    const list = [...app.vault.files.values()].filter((f) => re.test(f.path)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 40);
    recentBox.replaceChildren(...(list.length ? [h("div", { class: "nt-head", text: "Recent" }), h("div", { class: "nt-recent-list", style: { maxHeight: 6 * 30 + "px" } },
      ...list.map((f) => h("button", { class: "nt-item", onclick: () => { if (finishRef) finishRef(null); if (p.workspace) app._paintNext = p.workspace; app.openFile(f.path, { newTab: true }); } },
        icon(p.icon), h("span", { class: "nt-label", text: basename(f.path).replace(DRAWING_RE, "") }), h("span", { class: "nt-sub", text: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "vault root" }))))] : []));
  };
  // the usual place follows the way of working: vector drawings and pixel ones each have their own folder
  const usualOf = (id) => (app.workDir ? app.workDir(id === "vector" ? "sketch" : id === "animate" ? "animation" : "drawing") : "");
  const ctl = {};
  const paintUsual = () => ctl.refresh && ctl.refresh();
  const seg = h("div", { class: "segmented is-small nt-modes" });
  const paintSeg = () => { for (const b of seg.children) b.classList.toggle("is-active", b.dataset.v === persona); };
  const pick = (id) => { if (persona === id) return; persona = id; app.setSetting("drawPersona", persona); paintSeg(); paintRecent(); paintUsual(); };
  // a tab is picked by pointing at it, as well as by a click
  for (const p of PERSONAS) seg.append(h("button", { class: "seg", dataset: { v: p.id }, title: `${p.name}: ${p.blurb}`, onclick: () => pick(p.id), onmouseenter: () => pick(p.id) }, icon(p.icon), p.name));
  paintSeg();
  paintRecent();
  const dir = await pickFolder(app, anchor, {
    title: "New drawing in",
    first: () => [usualOf(persona), "the usual place"],
    stars: () => persona,
    ctl,
    head: seg,
    tail: (finish) => { finishRef = finish; return recentBox; },
  });
  if (dir == null) return null;
  return newIn(app, persona, { dir, anchor });
}

/**
 * The Sketch | Draw | Studio switch both editors carry. Draw and Studio are
 * two workspaces over one `.leostudio`; Paint is a different kind of file. So
 * crossing that line cannot simply flip a view - it says so, in one short
 * menu, and offers the ways across: the twin that already exists, a copy of
 * this one, or a blank one.
 */
export function switchMode(app, path, target, anchor) {
  const here = modeOf(path) || MODES[0];
  const stem = String(path).replace(DRAWING_RE, "");
  const toSketch = target === "sketch" || target === "vector";
  if ((here.id === "sketch") === toSketch) return;
  const p = toSketch ? PERSONAS[0] : target === "draw" ? PERSONAS[1] : PERSONA_BY_ID.get(target) || personaOfWorkspace(target);
  const other = inFolderOf(app, toSketch ? "sketch" : "drawing", stem);
  const twins = toSketch ? [stem + ".leopaint", stem + ".excalidraw", other + ".leopaint"] : [stem + ".leostudio", other + ".leostudio"];
  const twin = twins.find((t) => app.vault.files.has(t));
  const go = (f) => { if (p.workspace) app._paintNext = p.workspace; app.openFile(f, { newTab: true }); };
  menu(0, 0, [
    { header: toSketch ? "Leopaint is a file of its own (.leopaint)" : `${p.name} is part of Leostudio - pixels, in a .leostudio file` },
    twin ? { label: `Open ${basename(twin)}`, icon: p.icon, run: () => go(twin) } : null,
    !toSketch ? { label: twin ? "Bring this drawing over again, as a new copy" : `Continue this drawing in ${p.name}`, icon: "forward", run: () => sketchToDraw(app, path, { workspace: p.workspace }) } : null,
    { label: `New ${p.name.toLowerCase()} drawing…`, icon: "plus", run: () => newIn(app, p.id, { anchor }), sub: toSketch ? null : formatsSub(app, p.id, anchor) },
    toSketch ? { label: "From a template…", icon: "grid", run: () => templateMenu(app, null, anchor) } : null,
    p.id === "photo" ? { label: "Open a photo in Filter…", icon: "image", run: () => import("./paintexport.js").then((m) => m.libraryDialog(app, { tab: "photos", current: path })) } : null,
    ...recentOf(app, toSketch ? VECTOR_RE : STUDIO_RE, twin, 6, (f) => ({ label: basename(f.path).replace(DRAWING_RE, ""), icon: p.icon, run: () => go(f.path) })),
  ], { anchor });
}

/** The newest drawings of a kind, as menu rows under a "Continue" header (none: nothing). */
function recentOf(app, re, skip, n, row) {
  const list = [...app.vault.files.values()].filter((f) => re.test(f.path) && f.path !== skip).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, n);
  return list.length ? ["sep", { header: "Continue" }, ...list.map(row)] : [];
}

/**
 * Rasterise a sketch into a new `.leostudio`, on one layer, at the sketch's own
 * size × 2 so there is room to paint over it. The sketch is left alone.
 */
export async function sketchToDraw(app, path, { workspace = null } = {}) {
  try {
    const [sk, store] = await Promise.all([import("./sketch.js"), import("./paintstore.js")]);
    const text = await app.host.readText(path);
    const svg = await sk.renderSketchSvg(text, { theme: "light" });
    if (!svg) return toast("This sketch is empty - nothing to turn into a drawing", { ms: 3000 });
    const w = Math.max(64, Math.round(Number(svg.getAttribute("width")) || 1200));
    const hh = Math.max(64, Math.round(Number(svg.getAttribute("height")) || 900));
    const scale = Math.min(2, Math.max(1, 2400 / Math.max(w, hh)));
    const width = Math.round(w * scale);
    const height = Math.round(hh * scale);
    const img = await svgImage(svg, width, height);
    // a new kind of file goes where that kind lives, not beside the one it came from
    const out = await freePath(app, inFolderOf(app, "drawing", path.replace(VECTOR_RE, "")), ".leostudio");
    // an empty document first, then the sketch painted onto its one layer
    await store.createDoc(app, out, { width, height, dpi: 144, background: "#ffffff", name: basename(out) });
    const { doc, engine } = await store.openDoc(app, out);
    const bm = engine.bitmap(doc.layers[0].id);
    if (bm) bm.ctx.drawImage(img, 0, 0, width, height);
    doc.layers[0].name = "Sketch";
    await store.saveDoc(app, out, doc, engine, { created: new Date().toISOString() });
    engine.destroy();
    if (workspace) app._paintNext = workspace;
    app.openFile(out, { newTab: true });
    toast(`Made ${basename(out)} · the sketch is untouched`, { ms: 4000 });
  } catch (e) {
    toast("Could not make a Studio copy: " + (e && e.message ? e.message : e), { kind: "error" });
  }
}

function svgImage(svg, width, height) {
  const src = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([src], { type: "image/svg+xml" }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("the sketch could not be drawn")); };
    img.width = width;
    img.height = height;
    img.src = url;
  });
}

/**
 * A photograph, opened in Studio: a new `.leostudio` beside it with the photo
 * on one layer, at its own size. The photo itself is never written to.
 */
export async function openPhotoInStudio(app, photoPath) {
  try {
    const store = await import("./paintstore.js");
    const out = await freePath(app, inFolderOf(app, "drawing", photoPath.replace(/\.[^./]+$/, "")), ".leostudio");
    toast("Opening it in Studio…", { ms: 1600 });
    const res = await store.photoToDoc(app, photoPath, out);
    app._paintNext = "studio";
    app.openFile(out, { newTab: true });
    toast(`${basename(out)} · ${res.width} × ${res.height}${res.scaled ? " (scaled down to fit)" : ""} · the photo itself is untouched`, { ms: 5200 });
    return out;
  } catch (e) {
    toast("Could not open that photo: " + (e && e.message ? e.message : e), { kind: "error" });
    return null;
  }
}

/** A Photoshop file in Studio: a new .leostudio made from its layers, beside your drawings. */
export async function openPsdInStudio(app, psdPath) {
  try {
    const store = await import("./paintstore.js");
    const out = await freePath(app, inFolderOf(app, "drawing", psdPath.replace(/\.[^./]+$/, "")), ".leostudio");
    toast("Reading the Photoshop layers…", { ms: 1600 });
    const res = await store.psdToDoc(app, psdPath, out);
    app._paintNext = "draw";
    app.openFile(out, { newTab: true });
    toast(`${basename(out)} · ${res.width} × ${res.height} · ${res.flat ? "the merged picture on one layer" : `${res.layers} layer${res.layers === 1 ? "" : "s"}`}${res.scaled ? " (scaled down to fit)" : ""} · the .psd itself is untouched`, { ms: 5200 });
    return out;
  } catch (e) {
    toast("Could not open that Photoshop file: " + (e && e.message ? e.message : e), { kind: "error", ms: 6000 });
    return null;
  }
}

/* ── making a new one ────────────────────────────────────────────────────── */

/** `stem`'s name in the usual folder for a kind of drawing ("sketch" or "drawing"). */
function inFolderOf(app, kind, stem) {
  const dir = app.workDir ? app.workDir(kind) : "";
  const name = stem.slice(stem.lastIndexOf("/") + 1);
  return (dir ? dir + "/" : "") + name;
}

async function freePath(app, stem, ext) {
  let out = stem + ext;
  for (let i = 2; app.vault.files.has(out) || app.vault.notes.has(out); i++) out = `${stem} ${i}${ext}`;
  return out;
}

/**
 * The New drawing sheet: pick a mode, and for Draw a canvas size. Sketch has
 * no size to pick, so choosing it just makes one.
 *
 * `app.newSketch` still does the whole Sketch path (including embedding the
 * link in a note), so this defers to it rather than repeating it.
 */
export function newDrawing(app, { mode = null, dir = null, name = "", view = null, at = null, anchor = null, persona = null, preset = null, go = false } = {}) {
  return new Promise((resolve) => {
    let chosen = mode;
    let presetId = preset || (persona === "animate" ? app.settings.animCanvas || "an-post" : app.settings[SETTING_KEYS.lastCanvas] || D.DEFAULT_PRESET);
    // where it goes: given, or the usual place of its way of working - changeable at the foot of the sheet
    let dirNow = dir;
    let custom = { w: 2048, h: 2048, dpi: 144 };
    let background = app.settings[SETTING_KEYS.background] !== "transparent";

    const sheet = h("div", { class: "pt-sheet" });
    // only a click on the dimmed backdrop itself closes it; a click on a card
    // inside the sheet bubbles up here too, and must not
    const back = h("div", { class: "pt-sheet-back", onclick: (e) => { if (e.target === back) close(null); } }, sheet);
    let closed = false;
    const close = (v) => {
      if (closed) return;
      closed = true;
      back.classList.remove("is-in");
      document.removeEventListener("keydown", onEsc, true);
      setTimeout(() => back.remove(), 160);
      if (v == null) app._paintNext = null;
      resolve(v);
    };
    const onEsc = (e) => { if (e.key === "Escape" && !document.querySelector(".nt-pop")) { e.preventDefault(); e.stopPropagation(); close(null); } };
    document.addEventListener("keydown", onEsc, true);

    function pickMode() {
      sheet.replaceChildren(
        h("header", { class: "pt-sheet-head" },
          h("h2", { text: "New drawing" }),
          h("button", { class: "pt-icon", title: "Close", onclick: () => close(null) }, icon("x"))),
        h("p", { class: "pt-sheet-lede", text: "Leopaint is a file of its own (.leopaint), for sketching ideas out. Leostudio is Studio, Filter and Animate working together on one .leostudio file - move between them any time." }),
        h("div", { class: "pt-modes" }, ...PERSONAS.map((p) =>
          h("button", { class: "pt-mode-card", onclick: () => { chosen = p.file; persona = p.id; if (p.workspace) app._paintNext = p.workspace; if (p.file === "sketch") makeSketch(); else { if (p.id === "animate") presetId = app.settings.animCanvas || "an-post"; pickCanvas(); } } },
            h("div", { class: "pt-mode-ico" }, icon(p.icon)),
            h("div", null,
              h("h3", { text: p.name }),
              h("p", { text: p.blurb }),
              h("p", { class: "pt-dim", text: "Best for: " + p.best }),
              h("code", { class: "pt-ext", text: p.file === "sketch" ? "Leopaint · *.leopaint" : "Leostudio · *.leostudio" }))))));
    }

    async function makeSketch() {
      close(await app.newSketch({ dir, name, view, at, anchor }));
    }

    function pickCanvas() {
      const mine = customCanvasPresets(app);
      // the groups made for this way of working first, the ones made for another left out
      const who = persona || "paint";
      const groups = [...D.PRESET_GROUPS.filter((g) => g.for === who), ...D.PRESET_GROUPS.filter((g) => !g.for)];
      const often = oftenFormats(app, who, 8).filter((f) => f.why === "used");
      const all = [...(often.length ? [{ id: "often", name: "Often used", items: often }] : []), ...groups.map((g) => ({ ...g })), ...(mine.length ? [{ id: "mine", name: "Yours", items: mine }] : [])];
      const info = h("p", { class: "pt-sheet-info" });
      const nameInput = h("input", { class: "pt-input", placeholder: "Name (optional)", value: name, spellcheck: "false" });
      const usualHere = () => (view ? (app.mediaDir ? app.mediaDir("imageFolder") : "Attachments") : usualDirOf(app, persona === "animate" ? "animate" : persona || "paint"));
      const folderBtn = h("button", { class: "btn pt-folder-btn", title: "Where it is saved - click for another folder" });
      const paintFolder = () => { const d = dirNow != null ? dirNow : usualHere(); folderBtn.replaceChildren(icon("folder"), h("span", { text: d || "Vault root" })); };
      folderBtn.onclick = async () => {
        const { pickFolder } = await import("./newtab.js");
        const d = await pickFolder(app, folderBtn, { title: "Save it in", first: [usualHere(), "the usual place"], stars: persona === "animate" ? "animate" : persona || "paint" });
        if (d != null) { dirNow = d; paintFolder(); }
      };
      paintFolder();

      const wIn = h("input", { class: "pt-input pt-num-in", type: "number", min: 1, max: D.MAX_SIDE, value: custom.w });
      const hIn = h("input", { class: "pt-input pt-num-in", type: "number", min: 1, max: D.MAX_SIDE, value: custom.h });
      const dIn = h("input", { class: "pt-input pt-num-in", type: "number", min: 1, max: 1200, value: custom.dpi });

      const current = () => {
        if (presetId === "custom") return { w: clampN(wIn.value, 1, D.MAX_SIDE), h: clampN(hIn.value, 1, D.MAX_SIDE), dpi: clampN(dIn.value, 1, 1200), name: "Custom" };
        const p = D.PRESET_BY_ID.get(presetId) || mine.find((m) => m.id === presetId);
        return p ? { w: p.w, h: p.h, dpi: p.dpi || 72, name: p.name, fps: p.fps || 0 } : { w: 2048, h: 2048, dpi: 144, name: "Square" };
      };

      const refresh = () => {
        const c = current();
        const px = c.w * c.h;
        const mem = D.memoryEstimate(c.w, c.h, 1);
        const mm = D.printSize(c.w, c.h, c.dpi);
        info.replaceChildren(
          h("b", { text: `${c.w} × ${c.h} px` }),
          h("span", { text: ` · ${(px / 1e6).toFixed(1)} MP · ${mm.w} × ${mm.h} mm at ${c.dpi} dpi` }),
          h("span", { class: px > D.MAX_PIXELS ? "pt-warn" : "pt-dim", text: px > D.MAX_PIXELS ? ` · too big (max ${Math.round(D.MAX_PIXELS / 1e6)} MP)` : ` · about ${Math.round(mem / 1048576)} MB in memory to start` }));
        for (const b of sheet.querySelectorAll(".pt-preset")) b.classList.toggle("is-on", b.dataset.id === presetId);
        sheet.querySelector(".pt-custom")?.toggleAttribute("hidden", presetId !== "custom");
      };

      for (const el2 of [wIn, hIn, dIn]) el2.addEventListener("input", refresh);

      sheet.replaceChildren(
        h("header", { class: "pt-sheet-head" },
          h("button", { class: "pt-icon", title: "Back", onclick: pickMode }, icon("back")),
          h("h2", { text: "New drawing" }),
          h("button", { class: "pt-icon", title: "Close", onclick: () => close(null) }, icon("x"))),
        h("div", { class: "pt-presets" }, ...all.map((g) => h("div", { class: "pt-pgroup" },
          h("div", { class: "pt-pgroup-name", text: g.name }),
          h("div", { class: "pt-pgrid" }, ...g.items.map((p) =>
            h("button", {
              class: "pt-preset", dataset: { id: p.id },
              onclick: () => { presetId = p.id; refresh(); },
              oncontextmenu: g.id === "mine" ? (e) => { e.preventDefault(); removeCustomCanvas(app, p.id); pickCanvas(); } : null,
            },
              h("i", { class: "pt-preset-shape", style: shapeStyle(p.w, p.h) }),
              h("span", { class: "pt-preset-name", text: p.name }),
              h("span", { class: "pt-preset-note", text: p.note || `${p.w} × ${p.h}` }))))))),
        h("div", { class: "pt-pgroup" },
          h("div", { class: "pt-pgroup-name", text: "Custom" }),
          h("div", { class: "pt-pgrid" },
            h("button", { class: "pt-preset", dataset: { id: "custom" }, onclick: () => { presetId = "custom"; refresh(); } },
              h("i", { class: "pt-preset-shape", style: "width:26px;height:20px" }),
              h("span", { class: "pt-preset-name", text: "Custom size" }),
              h("span", { class: "pt-preset-note", text: "your own" })))),
        h("div", { class: "pt-custom", hidden: true },
          h("label", { class: "pt-field" }, h("span", { text: "Width" }), wIn),
          h("label", { class: "pt-field" }, h("span", { text: "Height" }), hIn),
          h("label", { class: "pt-field" }, h("span", { text: "DPI" }), dIn),
          h("button", { class: "btn", onclick: () => { const c = current(); saveCustomCanvas(app, { id: "u" + Date.now().toString(36), name: `${c.w} × ${c.h}`, note: `${c.dpi} dpi`, w: c.w, h: c.h, dpi: c.dpi }); pickCanvas(); } }, "Keep this size")),
        info,
        h("div", { class: "pt-sheet-foot" },
          folderBtn,
          nameInput,
          h("label", { class: "pt-check" },
            h("input", { type: "checkbox", checked: background, onchange: (e) => { background = e.target.checked; app.setSetting(SETTING_KEYS.background, background ? "white" : "transparent"); } }),
            h("span", { text: "White background" })),
          h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
          h("button", { class: "btn btn-primary", onclick: () => make(current(), nameInput.value) }, "Create")));
      refresh();
    }

    async function make(size, givenName) {
      if (size.w * size.h > D.MAX_PIXELS) return toast(`That canvas is bigger than ${Math.round(D.MAX_PIXELS / 1e6)} megapixels`, { kind: "error" });
      try {
        app.setSetting(persona === "animate" ? "animCanvas" : SETTING_KEYS.lastCanvas, presetId);
        countUse(app, persona, presetId);
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, "0");
        const base = safeName(givenName.trim() || `Drawing ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`);
        // a drawing made on its own goes to the Workplace; one made from inside a note stays with the note's pictures
        const folder = dirNow != null ? dirNow : view ? (app.mediaDir ? app.mediaDir("imageFolder") : "Attachments") : (app.workDir ? app.workDir(persona === "animate" ? "animation" : "drawing") : "Workplace/Studio/Designs");
        const out = await freePath(app, (folder ? folder + "/" : "") + base, ".leostudio");
        await createDoc(app, out, { width: size.w, height: size.h, dpi: size.dpi, background: background ? "#ffffff" : null, name: base, fps: persona === "animate" ? size.fps || 0 : 0 });
        // a new animation starts with its first frame made
        if (persona === "animate") app._animNext = out;
        if (view && at != null) {
          const text = `![[${out.slice(out.lastIndexOf("/") + 1)}]]`;
          const pos = Math.min(at, view.state.doc.length);
          view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: "input" });
        }
        close(out);
        app.openFile(out, { newTab: true });
      } catch (e) {
        toast("Could not create the drawing: " + (e && e.message ? e.message : e), { kind: "error" });
        close(null);
      }
    }

    // a size picked already (from the often used list): no sheet, straight in
    if (go && chosen === "draw") {
      const s = presetById(app, presetId);
      if (s) { make({ w: s.w, h: s.h, dpi: s.dpi || 72, name: s.name, fps: s.fps || 0 }, name); return; }
    }
    (chosen === "draw" ? pickCanvas : chosen === "sketch" ? makeSketch : pickMode)();
    document.body.append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
  });
}

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));

/** A little proportional rectangle, so the presets read as shapes not numbers. */
function shapeStyle(w, hh) {
  const k = 26 / Math.max(w, hh);
  return `width:${Math.max(6, Math.round(w * k))}px;height:${Math.max(6, Math.round(hh * k))}px`;
}
