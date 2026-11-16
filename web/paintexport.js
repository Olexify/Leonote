// Getting pictures out of Studio, and finding them again.
//
//   exportDialog   one picture, any size: the document as it is, or fitted to
//                  a template (an Instagram post, a YouTube thumbnail…) with
//                  the crop shown before anything is written
//   libraryDialog  every drawing and every photo in the vault, as thumbnails.
//                  Opens a drawing, opens a photo in Studio, or — in `pick`
//                  mode — just hands back the path of a picture
//
// Loaded on demand: neither is needed to draw.

import { h, basename } from "./util.js";
import { icon } from "./icons.js";
import { toast } from "./ui.js";
import * as D from "./paintdoc.js";
import * as G from "./paintgeom.js";
import * as S from "./paintstore.js";

const makeCanvas = (w, hh) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hh)); return c; };
const free = (c) => { if (c) { c.width = 1; c.height = 1; } };
const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function sheetShell(title, { wide = false } = {}) {
  const sheet = h("div", { class: "pt-sheet" + (wide ? " is-wide" : "") });
  let onClose = null;
  let closed = false;
  const close = (v) => {
    if (closed) return;
    closed = true;
    back.classList.remove("is-in");
    document.removeEventListener("keydown", onEsc, true);
    setTimeout(() => back.remove(), 160);
    if (onClose) onClose(v);
  };
  const back = h("div", { class: "pt-sheet-back", onclick: (e) => { if (e.target === back) close(null); } }, sheet);
  const onEsc = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); return; }
    // the editor underneath must not hear B, E, Delete… while a sheet is up
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) e.stopPropagation();
  };
  document.addEventListener("keydown", onEsc, true);
  const head = h("header", { class: "pt-sheet-head" }, h("h2", { text: title }), h("button", { class: "pt-icon", title: "Close", onclick: () => close(null) }, icon("x")));
  sheet.append(head);
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add("is-in"));
  return { sheet, head, close, set onClose(fn) { onClose = fn; } };
}

/* ── export ──────────────────────────────────────────────────────────────── */

export async function quickExport(ed, format = "png", scale = 1, quality = 0.92) {
  try {
    const out = await S.exportImage(ed.app, ed.path, ed.doc, ed.engine, { format, scale, quality });
    toast(`Exported ${basename(out.path)} · ${out.size.width}×${out.size.height} · ${kb(out.bytes)}`, { ms: 6000, action: { label: "Open", run: () => ed.app.openFile(out.path) } });
    return out;
  } catch (e) {
    toast("Could not export: " + (e && e.message ? e.message : e), { kind: "error" });
    return null;
  }
}

export function exportDialog(ed) {
  const { app, doc, engine } = ed;
  const st = {
    tpl: "original", scale: 1, w: doc.width, h: doc.height, lock: true,
    fit: "cover", focus: { x: 0.5, y: 0.5 },
    bg: "doc", bgColour: "#ffffff",
    format: app.settings.paintExportFormat || "png", quality: 0.9,
  };
  // one flattened copy for the whole dialog, without the paper: the paper is a choice here
  const flat = engine.flatten(1, { background: false });
  const small = makeCanvas(...(() => { const k = Math.min(1, 720 / Math.max(doc.width, doc.height)); return [doc.width * k, doc.height * k]; })());
  const sg = small.getContext("2d");
  sg.imageSmoothingQuality = "high";
  sg.drawImage(flat, 0, 0, small.width, small.height);

  const shell = sheetShell("Export a picture", { wide: true });
  shell.onClose = () => { free(flat); free(small); clearTimeout(sizeTimer); };

  const templates = () => [...G.EXPORT_TEMPLATES, ...(S.customTemplates(app).length ? [{ group: "Yours", items: S.customTemplates(app) }] : [])];
  const tplOf = (id) => templates().flatMap((g) => g.items.map((t) => ({ ...t, group: g.group }))).find((t) => t.id === id) || null;
  const target = () => {
    if (st.tpl === "original") return D.exportSize(doc, st.scale);
    return { width: Math.max(1, Math.min(D.MAX_SIDE, Math.round(st.w))), height: Math.max(1, Math.min(D.MAX_SIDE, Math.round(st.h))) };
  };
  const paper = () => {
    if (st.bg === "transparent") return st.format === "jpeg" ? "#ffffff" : null;
    if (st.bg === "colour") return st.bgColour;
    return doc.background || (st.format === "jpeg" ? "#ffffff" : null);
  };

  /** The picture as it will be written, from `src`, at `tw × th`. */
  function compose(src, tw, th) {
    const c = makeCanvas(tw, th);
    const g = c.getContext("2d");
    const p = paper();
    if (p) { g.fillStyle = p; g.fillRect(0, 0, tw, th); }
    g.imageSmoothingQuality = "high";
    const r = st.tpl === "original" ? { x: 0, y: 0, w: tw, h: th } : G.fitInto(src.width, src.height, tw, th, st.fit, st.focus);
    g.drawImage(src, r.x, r.y, r.w, r.h);
    return c;
  }

  const preview = h("canvas", { class: "pt-exp-preview" });
  const sizeLine = h("div", { class: "pt-exp-size" });
  const note = h("div", { class: "pt-exp-note" });
  const side = h("div", { class: "pt-exp-side" });
  const list = h("div", { class: "pt-exp-list" });
  shell.sheet.append(h("div", { class: "pt-exp" }, list, h("div", { class: "pt-exp-mid" }, h("div", { class: "pt-exp-stage" }, preview), sizeLine, note), side));

  let sizeTimer = 0;
  function paintPreview() {
    const t = target();
    const k = Math.min(380 / t.width, 300 / t.height, 1);
    const pw = Math.max(1, Math.round(t.width * k));
    const ph = Math.max(1, Math.round(t.height * k));
    const c = compose(small, pw, ph);
    preview.width = pw;
    preview.height = ph;
    preview.getContext("2d").drawImage(c, 0, 0);
    free(c);
    preview.classList.toggle("is-focusable", st.tpl !== "original" && st.fit === "cover");
    sizeLine.textContent = `${t.width} × ${t.height} px`;
    note.textContent = "working out the file size…";
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(measure, 320);
  }

  async function measure() {
    const t = target();
    if (t.width * t.height > 10e6) { note.textContent = "A big one: the file size shows once it is written."; return; }
    const c = compose(flat, t.width, t.height);
    try {
      const fmt = D.EXPORT_BY_ID.get(st.format);
      const blob = await S.canvasBlob(c, fmt.mime, fmt.quality ? st.quality : undefined);
      const tpl = tplOf(st.tpl);
      const over = tpl && tpl.maxBytes && blob.size > tpl.maxBytes;
      note.textContent = `about ${kb(blob.size)}${over ? ` — over the ${kb(tpl.maxBytes)} this site accepts. Try JPEG, or a lower quality.` : ""}`;
      note.classList.toggle("pt-warn", !!over);
    } catch { note.textContent = ""; }
    free(c);
  }

  // in "Fill" the part that is kept can be moved: click or drag the preview
  const setFocus = (e) => {
    if (st.tpl === "original" || st.fit !== "cover") return;
    const r = preview.getBoundingClientRect();
    st.focus = { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    paintPreview();
  };
  preview.addEventListener("pointerdown", (e) => { preview.setPointerCapture(e.pointerId); setFocus(e); });
  preview.addEventListener("pointermove", (e) => { if (preview.hasPointerCapture(e.pointerId)) setFocus(e); });

  function drawList() {
    const btn = (id, name, sub, extra = {}) => h("button", { class: "pt-exp-tpl" + (st.tpl === id ? " is-on" : ""), onclick: () => pick(id), ...extra }, h("span", { class: "pt-exp-tpl-name", text: name }), h("span", { class: "pt-exp-tpl-sub", text: sub }));
    list.replaceChildren(
      btn("original", "The picture as it is", `${doc.width} × ${doc.height}`),
      btn("custom", "A size of your own", "any width and height"),
      ...templates().flatMap((g) => [h("div", { class: "pt-exp-group", text: g.group }), ...g.items.map((t) => btn(t.id, t.name, `${t.w} × ${t.h}`, g.group === "Yours" ? { title: "Right-click to forget this size", oncontextmenu: (e) => { e.preventDefault(); S.removeCustomTemplate(app, t.id); if (st.tpl === t.id) st.tpl = "custom"; drawList(); } } : {}))]));
  }

  function pick(id) {
    st.tpl = id;
    const t = tplOf(id);
    if (t) { st.w = t.w; st.h = t.h; }
    st.focus = { x: 0.5, y: 0.5 };
    drawList();
    drawSide();
    paintPreview();
  }

  const seg = (options, current, onPick) => h("div", { class: "pt-seg" }, ...options.map(([id, label, title]) =>
    h("button", { class: "pt-seg-btn" + (id === current ? " is-on" : ""), title: title || "", onclick: () => onPick(id) }, label)));

  function drawSide() {
    const fmt = D.EXPORT_BY_ID.get(st.format);
    const isTpl = st.tpl !== "original";
    const wIn = h("input", { class: "pt-input pt-num-in", type: "number", min: 1, max: D.MAX_SIDE, value: Math.round(st.w) });
    const hIn = h("input", { class: "pt-input pt-num-in", type: "number", min: 1, max: D.MAX_SIDE, value: Math.round(st.h) });
    const ratio = st.w / st.h;
    wIn.addEventListener("input", () => { st.w = Number(wIn.value) || 1; if (st.lock) { st.h = Math.round(st.w / ratio); hIn.value = st.h; } paintPreview(); });
    hIn.addEventListener("input", () => { st.h = Number(hIn.value) || 1; if (st.lock) { st.w = Math.round(st.h * ratio); wIn.value = st.w; } paintPreview(); });
    const qOut = h("span", { class: "pt-num", text: `${Math.round(st.quality * 100)}%` });
    // replaceChildren would print a missing piece as the word "null"
    const put = (...kids) => side.replaceChildren(...kids.filter(Boolean));
    put(
      h("div", { class: "pt-adj-sub", text: "Size" }),
      st.tpl === "original"
        ? seg(D.EXPORT_SCALES.map((s) => [s.id, s.name, `${Math.round(doc.width * s.scale)} × ${Math.round(doc.height * s.scale)}`]), String(st.scale), (v) => { st.scale = Number(v); drawSide(); paintPreview(); })
        : h("div", { class: "pt-exp-wh" }, wIn, h("span", { text: "×" }), hIn,
            st.tpl === "custom" ? h("button", { class: "pt-icon" + (st.lock ? " is-on" : ""), title: "Keep the proportions", onclick: () => { st.lock = !st.lock; drawSide(); } }, icon("lock")) : null),
      st.tpl === "custom" ? h("button", { class: "btn pt-exp-keep", onclick: () => { S.saveCustomTemplate(app, { id: "u" + Date.now().toString(36), name: `${Math.round(st.w)} × ${Math.round(st.h)}`, w: Math.round(st.w), h: Math.round(st.h) }); drawList(); toast("Kept under Yours", { ms: 1800 }); } }, "Keep this size") : null,
      isTpl ? h("div", { class: "pt-adj-sub", text: "How the picture fills it" }) : null,
      isTpl ? seg(G.FIT_MODES.map((m) => [m.id, m.name, m.note]), st.fit, (v) => { st.fit = v; drawSide(); paintPreview(); }) : null,
      isTpl && st.fit === "cover" ? h("p", { class: "pt-adj-note", text: "Drag the preview to choose what is kept." }) : null,
      h("div", { class: "pt-adj-sub", text: "Paper" }),
      seg([["doc", doc.background ? "As drawn" : "As drawn (clear)"], ["transparent", "Clear"], ["colour", "Colour"]], st.bg, (v) => { st.bg = v; drawSide(); paintPreview(); }),
      st.bg === "colour" ? h("label", { class: "pt-field" }, h("span", { text: "Colour" }), h("input", { class: "pt-colour-in", type: "color", value: st.bgColour, oninput: (e) => { st.bgColour = e.target.value; paintPreview(); } })) : null,
      h("div", { class: "pt-adj-sub", text: "Format" }),
      seg(D.EXPORT_FORMATS.map((f) => [f.id, f.name, f.note]), st.format, (v) => { st.format = v; app.setSetting("paintExportFormat", v); drawSide(); paintPreview(); }),
      h("p", { class: "pt-adj-note", text: fmt.note + (st.format === "jpeg" && st.bg === "transparent" ? " — JPEG cannot be clear, so it gets white." : "") }),
      fmt.quality ? h("label", { class: "pt-field" }, h("span", { text: "Quality" }),
        h("input", { class: "pt-range", type: "range", min: 30, max: 100, step: 1, value: Math.round(st.quality * 100), oninput: (e) => { st.quality = Number(e.target.value) / 100; qOut.textContent = `${e.target.value}%`; clearTimeout(sizeTimer); sizeTimer = setTimeout(measure, 320); } }), qOut) : null,
      h("div", { class: "pt-exp-foot" },
        h("p", { class: "pt-adj-note", text: "Saved beside the drawing. The drawing itself is not changed." }),
        h("button", { class: "btn btn-primary", onclick: run }, "Export")));
  }

  async function run() {
    const t = target();
    const c = compose(flat, t.width, t.height);
    try {
      const tpl = tplOf(st.tpl);
      const out = await S.exportCanvas(app, ed.path, c, { format: st.format, quality: st.quality, scale: st.tpl === "original" ? st.scale : 1, label: tpl ? `${tpl.group && tpl.group !== "Yours" && tpl.group !== "Other" ? tpl.group.split(" ")[0] + " " : ""}${tpl.name}`.replace(/·/g, "") : st.tpl === "custom" ? `${t.width}x${t.height}` : "" });
      toast(`Exported ${basename(out.path)} · ${out.size.width}×${out.size.height} · ${kb(out.bytes)}`, { ms: 6000, action: { label: "Open", run: () => app.openFile(out.path) } });
      shell.close(out.path);
    } catch (e) {
      toast("Could not export: " + (e && e.message ? e.message : e), { kind: "error" });
    } finally {
      free(c);
    }
  }

  drawList();
  drawSide();
  paintPreview();
}

/* ── the library ─────────────────────────────────────────────────────────── */

const when = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

/**
 * Every drawing and photo in the vault. Resolves to a path in `pick` mode
 * (a photo to place), otherwise to whatever was opened, or null.
 */
export function libraryDialog(app, { pick = false, current = null, tab: startTab = null } = {}) {
  return new Promise((resolve) => {
    const shell = sheetShell(pick ? "Place a picture" : "Drawings and photos", { wide: true });
    shell.onClose = (v) => { io.disconnect(); resolve(v || null); };
    let tab = pick ? "photos" : startTab || "drawings";
    let query = "";
    let sort = "new";

    const files = () => [...app.vault.files.values()];
    const drawings = () => files().filter((f) => /\.(leostudio|leocanvas|leopaint|leovector|excalidraw)$/i.test(f.path));
    const photos = () => files().filter((f) => S.PHOTO_RE.test(f.path) && !/(^|\/)\./.test(f.path));

    const grid = h("div", { class: "pt-lib-grid" });
    const count = h("span", { class: "pt-lib-count" });
    const search = h("input", { class: "pt-input pt-lib-search", placeholder: "Find by name…", spellcheck: false, oninput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); } });
    const tabs = h("div", { class: "pt-seg" });
    const bar = h("div", { class: "pt-lib-bar" }, pick ? null : tabs, search,
      h("select", { class: "pt-select", onchange: (e) => { sort = e.target.value; draw(); } }, h("option", { value: "new", text: "Newest first" }), h("option", { value: "name", text: "By name" }), h("option", { value: "big", text: "Biggest first" })),
      count,
      pick ? null : h("button", { class: "btn btn-primary", onclick: () => { shell.close(null); import("./paintmode.js").then((m) => m.newDrawing(app, {})); } }, "New drawing"));
    shell.sheet.append(bar, grid);

    // thumbnails of drawings come out of the file (one small read each), so
    // only the cards that are actually on screen ask for theirs
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const card = en.target;
        app.host.paintInspect(card.dataset.path).then((info) => {
          const img = card.querySelector(".pt-lib-thumb");
          if (info.thumb && img) img.style.backgroundImage = `url(data:image/png;base64,${info.thumb})`;
          const sub = card.querySelector(".pt-lib-sub");
          if (sub) sub.textContent = `${info.width} × ${info.height} · ${info.layers} layer${info.layers === 1 ? "" : "s"} · ${sub.dataset.when}`;
        }).catch(() => {});
      }
    }, { root: grid, rootMargin: "200px" });

    function card(f) {
      const name = basename(f.path);
      const isPaint = /\.leostudio$/i.test(f.path);
      const isSketch = /\.(leocanvas|leopaint|leovector|excalidraw)$/i.test(f.path);
      const thumb = h("div", { class: "pt-lib-thumb" + (isSketch ? " is-sketch" : "") }, isSketch ? icon("pen") : null);
      if (!isPaint && !isSketch) {
        const url = app.host.assetUrl(f.path);
        if (url) thumb.append(h("img", { src: url, loading: "lazy", decoding: "async", draggable: false, alt: "" }));
      }
      const el = h("button", {
        class: "pt-lib-card" + (f.path === current ? " is-current" : ""), dataset: { path: f.path }, title: f.path,
        onclick: () => open(f),
      }, thumb,
        h("span", { class: "pt-lib-name", text: name.replace(/\.(leostudio|leocanvas|leopaint|leovector|excalidraw)$/i, "") }),
        h("span", { class: "pt-lib-sub", dataset: { when: when(f.mtime) }, text: `${isSketch ? "Sketch" : isPaint ? "Drawing" : kb(f.size || 0)} · ${when(f.mtime)}` }));
      if (isPaint) io.observe(el);
      return el;
    }

    async function open(f) {
      if (pick) return shell.close(f.path);
      if (!S.PHOTO_RE.test(f.path)) { shell.close(f.path); app.openFile(f.path, { newTab: true }); return; }
      const mode = await import("./paintmode.js");
      const out = await mode.openPhotoInStudio(app, f.path);
      if (out) shell.close(out);
    }

    function draw() {
      tabs.replaceChildren(...[["drawings", `Drawings · ${drawings().length}`], ["photos", `Photos · ${photos().length}`]].map(([id, label]) =>
        h("button", { class: "pt-seg-btn" + (tab === id ? " is-on" : ""), onclick: () => { tab = id; draw(); } }, label)));
      let list = (tab === "photos" ? photos() : drawings()).filter((f) => !query || f.path.toLowerCase().includes(query));
      list = list.sort((a, b) => (sort === "name" ? basename(a.path).localeCompare(basename(b.path)) : sort === "big" ? (b.size || 0) - (a.size || 0) : (b.mtime || 0) - (a.mtime || 0)));
      count.textContent = list.length > 400 ? `showing 400 of ${list.length}` : "";
      grid.replaceChildren(...(list.length
        ? list.slice(0, 400).map(card)
        : [h("div", { class: "pt-lib-empty", text: query ? "Nothing by that name." : tab === "photos" ? "No pictures in this vault yet. Drop one into the sidebar and it shows up here." : "No drawings yet." })]));
      if (tab === "photos" && !pick) grid.prepend(h("p", { class: "pt-lib-hint", text: "Pick a photo to open it in Studio. It becomes a new drawing beside the photo; the photo itself is never changed." }));
    }

    draw();
    requestAnimationFrame(() => search.focus());
  });
}
