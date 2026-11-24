// Everything in the vault that is not a note. Code and text files open in a
// code editor, .docx and .xlsx in their own editors, pictures in the viewer,
// PDFs and media in place; anything else gets a card that opens it in its
// own app. Edits save by themselves a moment after you stop typing.

import { h, relTime, debounce, dirname } from "./util.js";
import { icon } from "./icons.js";
import { mountCode } from "./codeview.js";
import { openViewer } from "./images.js";
import { menu, inlineEdit, confirmRenameExt } from "./ui.js";
import { shareMenuItems } from "./imageshare.js";
import { mountDrawer, drawerMode } from "./folderdrawer.js";

// one video re-encode at a time, whatever tab is showing
let videoJob = null;

export const KIND_ICON = { image: "image", pdf: "fileText", office: "file", text: "fileText", media: "play", archive: "archive", other: "file" };

export function fmtSize(n) {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 2 : 1)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

const OFFICE_EDIT = /\.(docx|xlsx)$/i;
// Draw documents (.leopaint) save themselves through their own Rust command,
// so they hand the file view an `ed.save()` instead of `ed.getBytes()`.
const PAINT_EDIT = /\.leostudio$/i;

export function mountFileView(app, el) {
  let current = null;
  const off = new AbortController(); // ended when the view goes for good: what it listens to outside itself
  // the viewer's edits switch moved: the picture shown here follows it
  let refreshEdits = null;
  off.signal.addEventListener("abort", app.bus.on("image-edits", (p) => { if (refreshEdits) refreshEdits(p); }));
  let ed = null; // { getBytes(), destroy(), focus?() } for an editable file
  let wantLine = 0; // a line to go to once a text file has loaded (a search hit)
  let dirty = false;
  let saving = null;
  let knownMtime = 0; // the mtime of what the editor holds, to spot outside edits
  let stateEl = null;
  let subEl = null;
  let fv = null; // the frame that is up now: head, body, drawer
  let drawerBtn = null;

  // The other files of the folder, along the bottom. Stepping through them
  // keeps a video in full screen if it was there.
  const drawer = mountDrawer(app, {
    open: (p) => {
      const wasFs = !!document.fullscreenElement && el.contains(document.fullscreenElement);
      app.openFile(p);
      if (wasFs) requestAnimationFrame(() => { const u = el.querySelector(".mp-unit:not(.is-audio)"); if (u && u.requestFullscreen) u.requestFullscreen().catch(() => {}); });
    },
  });
  const paintDrawerBtn = () => { if (drawerBtn) drawerBtn.classList.toggle("is-on", drawerMode(app) === "open"); };
  off.signal.addEventListener("abort", app.bus.on("settings", (k) => { if (k === "fileDrawer") { drawer.paintMode(); paintDrawerBtn(); } }));
  // a video in full screen takes the drawer along, at the top edge: the
  // bottom one belongs to the controls
  document.addEventListener("fullscreenchange", () => {
    const u = document.fullscreenElement;
    if (u && el.contains(u) && u.classList.contains("mp-unit")) { drawer.el.classList.add("is-fs"); drawer.el.classList.remove("is-up"); u.append(drawer.el); }
    else if (drawer.el.classList.contains("is-fs")) { drawer.el.classList.remove("is-fs", "is-up"); if (fv && fv.isConnected) fv.append(drawer.el); }
  }, { signal: off.signal });

  const setState = (s) => {
    if (!stateEl) return;
    stateEl.textContent = s === "dirty" ? "Edited" : s === "saving" ? "Saving…" : s === "error" ? "Not saved" : "Saved";
    stateEl.dataset.state = s;
  };

  async function save() {
    if (!dirty || !ed || !current) return saving;
    const path = current;
    const it = ed;
    dirty = false;
    setState("saving");
    const run = (async () => {
      try {
        // an editor that writes its own file (a Draw document) says so
        const entry = it.save ? await it.save() : await app.host.writeFile(path, await it.getBytes());
        if (entry && entry.path) {
          knownMtime = entry.mtime;
          keepEntry(entry);
          if (subEl && current === path) subEl.textContent = subText(path, entry);
        }
        if (current === path && !dirty) setState("saved");
      } catch (e) {
        dirty = true;
        setState("error");
        // held by another program: said once, and tried again in a while and when Leonote is back in front
        const held = /os error (5|32|33)\b|denied|being used/i.test(String(e));
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (!held || !retrying) app.toast(held ? `“${name}” is held by another program - Leonote keeps trying, and saves it as soon as it is let go` : `Could not save ${name}: ${e}`, { kind: "error", ms: held ? 6000 : 4000 });
        if (held) { retrying = true; clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (dirty && current === path) save(); }, 5000); }
        return;
      }
      retrying = false;
    })();
    saving = run;
    await run;
    if (saving === run) saving = null;
    if (leaving) letGo();
  }
  let leaving = false;
  let retrying = false, retryTimer = 0;
  window.addEventListener("focus", () => { if (dirty && retrying && current) save(); }, { signal: off.signal });
  const saveSoon = debounce(save, 700);
  const edited = () => { dirty = true; setState("dirty"); saveSoon(); };

  const guestDir = (path) => { const a = app.guestAbs ? app.guestAbs(path) : ""; return a.slice(0, Math.max(a.lastIndexOf("\\"), a.lastIndexOf("/"))); };
  const subText = (path, f) => [app.isGuest && app.isGuest(path) ? guestDir(path) : path.includes("/") ? dirname(path) : "vault root", fmtSize(f.size), f.mtime ? relTime(f.mtime) : ""].filter(Boolean).join(" · ");
  const keepEntry = (entry) => { if (app.isGuest && app.isGuest(entry.path)) app.guestFile(entry.path, entry); else app.vault.files.set(entry.path, entry); };

  let psdUrl = null; // a Photoshop file's flattened picture: tens of MB, given back when the file is left
  function close() {
    if (psdUrl) { URL.revokeObjectURL(psdUrl); psdUrl = null; }
    if (dirty) { saveSoon.cancel?.(); save(); }
    if (ed) { try { ed.destroy(); } catch {} }
    ed = null;
    dirty = false;
  }

  // Gone from the screen for good. A save under way, or one waiting for a held file to be let go, keeps the view until it lands.
  function letGo() {
    if (saving || (dirty && retrying)) return;
    leaving = false;
    off.abort();
    dirty = false; // a save that failed for good was said in its toast; nothing here can bring the pane back
    close(); // no parking: a player here goes out of the document with the pane or window and stops, and a late call may find a newer view's in a shared host
    current = null;
  }

  /** All pictures in the file's folder, for stepping through them. */
  function folderImages(path) {
    const dir = dirname(path);
    return [...app.vault.files.values()]
      .filter((f) => f.kind === "image" && dirname(f.path) === dir)
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
      .map((f) => ({ url: app.host.assetUrl(f.path), path: f.path, name: f.path.slice(f.path.lastIndexOf("/") + 1), target: f.path }));
  }

  async function bytesOf(path) {
    const res = await fetch(app.host.assetUrl(path), { cache: "no-store" });
    if (!res.ok) throw new Error(`read failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // "Replace the original" - off unless ticked; the original goes to .trash
  const replaceTick = (reopen) => ({ label: "Replace the original", icon: "undo", checked: !!app.settings.compressReplace, run: () => { app.setSetting("compressReplace", !app.settings.compressReplace); reopen(); } });

  // Put a compressed copy in place: keep both, or swap it in for the original
  // (notes that embed the original are pointed at the new file).
  async function settle(path, bytes, ext) {
    const dir = dirname(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    const base = name.slice(0, name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length);
    const at = (n) => (dir ? dir + "/" : "") + n;
    let out = at(`${base} (compressed).${ext}`);
    for (let i = 2; app.vault.files.has(out); i++) out = at(`${base} (compressed ${i}).${ext}`);
    const list = await app.host.saveImage(out, bytes);
    if (Array.isArray(list)) app.vault.setFiles(list);
    if (!app.settings.compressReplace) return out;
    const same = at(`${base}.${ext}`);
    const takeName = same === path || !app.vault.files.has(same);
    const links = await app.vault.relinkFile(path, takeName ? same : out);
    await app.vault.trashFile(path);
    if (takeName) { await app.vault.renameFile(out, same); out = same; }
    if (links) app.toast(`Updated ${links} note${links === 1 ? "" : "s"} to the new file`, { ms: 2600 });
    return out;
  }

  async function imageMenu(path, anchor) {
    const replace = !!app.settings.compressReplace;
    const P = [["Small · WebP 60%, 1920px", 0.6, 1920], ["Balanced · WebP 80%, 2560px", 0.8, 2560], ["High · WebP 92%, full size", 0.92, 0]];
    menu(0, 0, [
      { header: replace ? "Compress and replace the original" : "Compressed copy (the original stays)" },
      ...P.map(([label, q, side]) => ({ label, icon: "shrink", run: () => packImageFile(path, q, side) })),
      "sep",
      replaceTick(() => imageMenu(path, anchor)),
    ], { anchor });
  }

  async function packImageFile(path, quality, maxSide) {
    try {
      const { compressImage } = await import("./images.js");
      const src = await bytesOf(path);
      const ext = path.split(".").pop().toLowerCase();
      const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" }[ext] || "image/png";
      const c = await compressImage(new Blob([src], { type }), { quality, maxSide, format: "webp" });
      if (c.kept || c.bytes.length >= src.length * 0.97) return app.toast("This picture is already compact - a copy wouldn't be smaller", { ms: 3500 });
      const out = await settle(path, c.bytes, "webp");
      app.toast(`Saved ${fmtSize(src.length - c.bytes.length)} (−${Math.round((1 - c.bytes.length / src.length) * 100)}%) · ${out.slice(out.lastIndexOf("/") + 1)}`, { ms: 6000, action: { label: "Open", run: () => app.openFile(out) } });
      if (app.settings.compressReplace) app.openFile(out);
    } catch (e) {
      app.toast("Could not compress the picture: " + (e && e.message ? e.message : e), { kind: "error" });
    }
  }

  async function videoMenu(path, anchor) {
    const mod = await import("./videopack.js");
    if (!mod.canPackVideo()) return app.toast("This system can't re-encode video here", { kind: "error" });
    if (videoJob) return app.toast(`Already compressing ${videoJob.name}`);
    const replace = !!app.settings.compressReplace;
    menu(0, 0, [
      { header: replace ? "Compress and replace the original" : "Compressed copy (the original stays)" },
      ...Object.entries(mod.VIDEO_PRESETS).map(([k, p]) => ({ label: p.label, icon: "shrink", run: () => packVideoFile(mod, path, k) })),
      "sep",
      replaceTick(() => videoMenu(path, anchor)),
      { header: "Takes about as long as the video plays", plain: true },
    ], { anchor });
  }

  async function packVideoFile(mod, path, preset) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const ctl = new AbortController();
    const bar = h("i", { class: "vp-fill" });
    const label = h("span", { text: `Compressing ${name}…` });
    const chip = h("div", { class: "saved-chip vp-chip", role: "status" }, icon("shrink"), label, h("span", { class: "vp-bar" }, bar),
      h("button", { class: "saved-undo", onclick: () => ctl.abort() }, "Cancel"));
    document.body.append(chip);
    requestAnimationFrame(() => chip.classList.add("is-in"));
    videoJob = { name };
    const done = () => { videoJob = null; chip.classList.remove("is-in"); setTimeout(() => chip.remove(), 250); };
    try {
      const blob = await mod.packVideo(app.host.assetUrl(path), {
        preset, signal: ctl.signal,
        onProgress: (p) => { bar.style.width = (p * 100).toFixed(1) + "%"; label.textContent = `Compressing ${name} · ${Math.round(p * 100)}%`; },
      });
      const before = (app.vault.files.get(path) || {}).size || 0;
      if (before && blob.size >= before * 0.95) { done(); return app.toast(`${name} is already compact - the copy wasn't smaller, so nothing was saved`, { ms: 5000 }); }
      if (app.media) app.media.dispose(path);
      const out = await settle(path, new Uint8Array(await blob.arrayBuffer()), "webm");
      if (app.settings.compressReplace) app.openFile(out);
      done();
      const pct = before ? ` (−${Math.round((1 - blob.size / before) * 100)}%)` : "";
      app.toast(`Saved ${fmtSize(Math.max(0, before - blob.size))}${pct} · ${out.slice(out.lastIndexOf("/") + 1)}`, {
        ms: 9000,
        action: { label: "Open", run: () => app.openFile(out) },
      });
    } catch (e) {
      done();
      if (!ctl.signal.aborted) app.toast("Could not compress the video: " + (e && e.message ? e.message : e), { kind: "error" });
      else app.toast("Compression cancelled", { ms: 1800 });
    }
  }

  function render(path) {
    close();
    if (app.media) app.media.park(el); // a playing video or song keeps going
    const f = app.vault.files.get(path) || (app.guestFile && app.guestFile(path));
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!f) {
      el.replaceChildren(h("div", { class: "empty-state" }, icon("file"), h("h3", { text: "File not found" }), h("p", { text: path })));
      return;
    }
    knownMtime = f.mtime;
    const editable = f.kind === "text" || OFFICE_EDIT.test(path) || PAINT_EDIT.test(path);
    stateEl = editable ? h("span", { class: "fv-state", dataset: { state: "saved" }, text: "Saved" }) : null;
    subEl = h("div", { class: "fv-sub", text: subText(path, f) });
    const head = h("header", { class: "fv-head" },
      icon(KIND_ICON[f.kind] || "file"),
      h("div", { class: "fv-meta" }, h("div", { class: "fv-title", text: name, title: `${path}\nDouble-click to rename`, ondblclick: (e) => inlineEdit(e.currentTarget, name, { selectBase: true, className: "fv-title-edit", onCommit: async (v) => { const n = v.trim(); if (n && n !== name && (await confirmRenameExt(name, n))) app.renameFile(path, n); } }) }), subEl),
      h("div", { class: "fv-acts" },
        stateEl,
        f.kind === "media" && !/\.(mp3|wav|ogg|m4a)$/i.test(path) ? h("button", { class: "btn", title: "Make a smaller copy of this video", onclick: (e) => videoMenu(path, e.currentTarget) }, icon("shrink"), "Compress") : null,
        f.kind === "image" ? h("button", { class: "btn", title: "Use this picture in a note or on a board - one file, as many places as you like", onclick: (e) => menu(0, 0, [{ header: "One file on disk, wherever you use it" }, ...shareMenuItems(app, path, e.currentTarget)], { anchor: e.currentTarget }) }, icon("send"), "Use elsewhere") : null,
        (() => { const n = app.vault.usedIn ? app.vault.usedIn(path).length : 0; return h("button", { class: "btn" + (n ? "" : " is-quiet"), title: n ? "The notes that show or link this file" : "No note shows or links this file", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); app.showUsedIn(path, r.left, r.bottom + 4); } }, icon("link"), n ? `Used in ${n}` : "Not used"); })(),
        f.kind === "image" && !/\.svg$/i.test(path) ? h("button", { class: "btn", title: "Draw on it, add layers and filters - the file itself is never changed (E)", onclick: () => app.editImage(path) }, icon("pen"), "Edit") : null,
        f.kind === "image" && !/\.svg$/i.test(path) ? h("button", { class: "btn", title: "Open it in Filter: adjustment layers, curves, masks, cut-outs, text and export sizes. It becomes a .leostudio in your Drawings folder; the photo itself is never changed.", onclick: () => import("./paintmode.js").then((m) => m.openPhotoInStudio(app, path)) }, icon("palette"), "Filter") : null,
        f.kind === "image" && !/\.(gif|svg)$/i.test(path) ? h("button", { class: "btn", title: "Make a smaller copy of this picture", onclick: (e) => imageMenu(path, e.currentTarget) }, icon("shrink"), "Compress") : null,
        /\.psd$/i.test(path) ? h("button", { class: "btn", title: "Its layers as Studio layers - names, places, opacity, blend, groups - in a new .leostudio; the .psd is never changed", onclick: () => import("./paintmode.js").then((m) => m.openPsdInStudio(app, path)) }, icon("palette"), "Open in Studio") : null,
        /\.x?html?$/i.test(path) && app.viewAsPage ? h("button", { class: "btn", title: "Show it as the page it makes, the way a browser does - the text is a click away again", onclick: () => app.viewAsPage(path) }, icon("globe"), "View as page") : null,
        h("button", { class: "btn", onclick: () => app.host.openPath(path).catch((e) => app.toast(String(e), { kind: "error" })) }, icon("reveal"), "Open in app"),
        h("button", { class: "icon-btn", title: "Show in Explorer", onclick: () => app.reveal(path) }, icon("folder")),
        drawerBtn = h("button", { class: "icon-btn fd-btn", title: "Folder drawer: the other files of this folder along the bottom. Click to keep it open, right-click for more",
          onclick: () => app.setSetting("fileDrawer", drawerMode(app) === "open" ? "hover" : "open"), oncontextmenu: drawer.modeMenu }, icon("film"))));
    paintDrawerBtn();

    const url = app.host.assetUrl(path);
    let body;
    if (PAINT_EDIT.test(path)) {
      // The drawing's own thumbnail comes back from `paint_inspect` in a few
      // milliseconds without decoding a single layer, so a big document shows
      // its picture immediately and then turns into the editor.
      const card = h("div", { class: "fv-paint" }, h("div", { class: "fv-loading", text: "Opening drawing…" }));
      const host = h("div", { class: "fv-board-host" });
      body = h("div", { class: "fv-body fv-board" }, host, card);
      app.host.paintInspect(path).then((info) => {
        if (current !== path || !info) return;
        card.replaceChildren(
          info.thumb ? h("img", { class: "fv-paint-thumb", src: `data:image/png;base64,${info.thumb}`, alt: name }) : "",
          h("div", { class: "fv-paint-meta", text: `${info.width} × ${info.height} · ${info.layers} layer${info.layers === 1 ? "" : "s"} · ${fmtSize(info.bytes)}` }),
          h("div", { class: "fv-loading", text: "Opening…" }));
      }).catch(() => {});
      import("./paintmode.js").then(async (mode) => {
        if (current !== path) return;
        const pt = await mode.openDrawing(host, path, { app, onChange: edited });
        if (current !== path) { pt.destroy(); return; }
        card.remove();
        // the quiet save: the file view already shows "Saved" in its header,
        // and a toast on every autosave would be noise
        ed = { save: () => pt.save(), destroy: pt.destroy, focus: pt.focus, paint: pt };
        pt.focus();
      }).catch((e) => {
        if (current === path) body.replaceChildren(h("div", { class: "fv-loading", text: `Could not open the drawing: ${e && e.message ? e.message : e}` }));
      });
    } else if (/\.psd$/i.test(path)) {
      // a Photoshop file: its picture, read here (no Photoshop needed)
      body = h("div", { class: "fv-body fv-image" }, h("div", { class: "fv-loading", text: "Reading the Photoshop file…" }));
      Promise.all([import("./psd.js"), bytesOf(path)]).then(([P, bytes]) => {
        if (current !== path) return;
        const psd = P.parsePsd(bytes);
        const c = P.psdCanvas(psd);
        c.toBlob((blob) => {
          if (current !== path || !blob) return;
          const src = URL.createObjectURL(blob);
          if (psdUrl) URL.revokeObjectURL(psdUrl);
          psdUrl = src;
          const img = h("img", { class: "fv-img", src, alt: name, draggable: false });
          img.addEventListener("click", () => openViewer([{ url: src, name, path: null }], 0, {}));
          const layers = psd.layers.filter((l) => l.pixels && !l.section).length;
          subEl.textContent = `${psd.width} × ${psd.height} · ${psd.depth}-bit ${psd.mode === 1 ? "greyscale" : "RGB"} · ${layers ? `${layers} layer${layers === 1 ? "" : "s"}` : "no layers"} · Photoshop`;
          body.replaceChildren(img);
        }, "image/png");
      }).catch((e) => { if (current === path) body.replaceChildren(h("div", { class: "fv-loading", text: "Could not read it: " + (e && e.message ? e.message : e) })); });
    } else switch (f.kind) {
      case "image": {
        const img = h("img", { class: "fv-img", src: url, alt: name, draggable: false });
        img.addEventListener("click", () => {
          const list = folderImages(path);
          openViewer(list, Math.max(0, list.findIndex((x) => x.path === path)), { ...app.imageActions(), remove: (it) => app.removePictureFile(it) });
        });
        const tag = h("div", { class: "fv-edited", hidden: true }, icon("layers"), h("span", { text: "Showing your edits · the file is untouched" }));
        // edits live in a sidecar beside the picture: show them here, but keep
        // the file itself exactly as it is on disk
        const showEdits = () => import("./imageeditstore.js").then(async (store) => {
          if (current !== path || !img.isConnected) return;
          const edited = await store.editedUrl(app, path, url);
          if (current !== path) return;
          if (!edited) { tag.hidden = true; if (img.src !== url) img.src = url; return; }
          // switched off in the viewer: the file as it is, with a word about why
          const off = await store.editsOff(app, path);
          tag.lastChild.textContent = off ? "Edits off · switch them on in the viewer (O)" : "Showing your edits · the file is untouched";
          img.src = off ? url : edited;
          tag.hidden = false;
        }).catch(() => {});
        showEdits();
        refreshEdits = (p) => { if (p === path) showEdits(); };
        body = h("div", { class: "fv-body fv-center", title: "Click for the viewer · ↑↓ turn it · Ctrl+C copies it", tabIndex: -1 }, img, tag);
        // up / down turn the picture a quarter (just the view; the viewer can save it)
        let spin = 0;
        img.style.transition = "transform .16s cubic-bezier(.3,.7,.4,1)";
        body.addEventListener("keydown", (e) => {
          if ((e.key === "e" || e.key === "E") && !e.ctrlKey && !e.altKey && !e.metaKey && !/\.svg$/i.test(path)) { e.preventDefault(); app.editImage(path); return; }
          // Ctrl+C: the picture itself goes on the clipboard
          if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); app.copyPicture(path); return; }
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          spin += e.key === "ArrowUp" ? -90 : 90;
          img.style.transform = `rotate(${spin}deg)`;
        });
        requestAnimationFrame(() => body.focus({ preventScroll: true }));
        break;
      }
      case "pdf": {
        // Leonote draws PDFs itself (pdf.js) so they can be marked up,
        // rearranged and filled in. The whole thing is one lazy chunk: nothing
        // of it loads until a PDF is actually opened.
        body = h("div", { class: "fv-body fv-board" }, h("div", { class: "fv-loading", text: "Opening PDF…" }));
        const fallback = (msg, why) => {
          if (current !== path) return;
          body.replaceChildren(h("div", { class: "fv-center fv-fill" }, h("div", { class: "fv-card" },
            icon("fileText"), h("h3", { text: name }), h("p", { text: msg }),
            h("div", { class: "xv-card-acts" },
              h("button", { class: "btn btn-primary", onclick: () => app.host.openPath(path).catch((e) => app.toast(String(e), { kind: "error" })) }, "Open in the default app"),
              why === "encrypted" ? null : h("button", { class: "btn", onclick: () => render(path) }, "Try again")))));
        };
        import("./pdfmode.js").then(async (mode) => {
          if (current !== path) return;
          const host = h("div", { class: "fv-board-host" });
          body.replaceChildren(host);
          const pdf = await mode.openPdf(host, path, {
            app,
            // our own write must not look like somebody else's: without this
            // the file watcher would reopen the viewer after every save
            onSaved: (entry) => {
              if (!entry || current !== path) return;
              knownMtime = entry.mtime;
              keepEntry(entry);
              if (subEl) subEl.textContent = subText(entry.path, entry);
            },
          });
          if (current !== path) { pdf.destroy(); return; }
          // no autosave: a PDF is only ever written when the reader asks
          ed = { destroy: pdf.destroy, focus: pdf.focus, getBytes: null, readOnly: true, pdf };
          pdf.focus();
        }).catch((e) => {
          const why = e && e.code;
          fallback(why === "encrypted" ? "This PDF is password-protected, so Leonote can't open it here."
            : why === "damaged" ? "This file is damaged, or is not a PDF inside."
            : why === "too-big" ? (e.message || "This PDF is too large to edit here.")
            : `Could not open it here (${(e && e.message) || e}).`, why);
        });
        break;
      }
      case "media": {
        const audio = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i.test(path);
        body = app.media ? app.media.view(path) : h("div", { class: "fv-body fv-center" }, h(audio ? "audio" : "video", { class: audio ? "fv-audio" : "fv-video", src: url, controls: true }));
        // the keys are the player's as soon as it is up - unless the sidebar is being walked
        requestAnimationFrame(() => { if (current === path && body.isConnected && !document.activeElement?.closest?.("#sidebar, .sb-scroll, input, textarea")) body.focus({ preventScroll: true }); });
        break;
      }
      case "text": {
        if (/\.leovideo$/i.test(path)) {
          // a video project: the timeline editor, saved as the JSON it is
          body = h("div", { class: "fv-body fv-board" }, h("div", { class: "fv-loading", text: "Opening the video…" }));
          Promise.all([import("./videoedit.js"), app.host.readText(path)]).then(async ([mod, t]) => {
            if (current !== path) return;
            const host = h("div", { class: "fv-board-host" });
            body.replaceChildren(host);
            const ve = await mod.mountVideo(host, t, { app, path, onChange: edited });
            if (current !== path) { ve.destroy(); return; }
            ed = { getBytes: async () => new TextEncoder().encode(ve.getText()), destroy: ve.destroy, focus: ve.focus, setText: ve.setText };
            ve.focus();
          }).catch((e) => { if (current === path) body.replaceChildren(h("div", { class: "fv-loading", text: `Could not open the video: ${e}` })); });
          break;
        }
        if (/\.(leocanvas|leopaint|leovector|excalidraw)$/i.test(path)) {
          body = h("div", { class: "fv-body fv-board" }, h("div", { class: "fv-loading", text: "Opening drawing…" }));
          Promise.all([import("./sketch.js"), app.host.readText(path).catch(() => "PK")]).then(async ([mod, t]) => {
            if (current !== path) return;
            // a Studio drawing from before the rename, still called .leopaint (a zip, not JSON): one click puts its name right
            if (/\.leopaint$/i.test(path) && String(t).startsWith("PK")) {
              body.replaceChildren(h("div", { class: "fv-loading" }, h("p", { text: "This is a Studio drawing with its old name. Studio drawings are .leostudio now." }),
                h("button", { class: "btn btn-primary", onclick: () => app.renameFile(path, name.replace(/\.leopaint$/i, ".leostudio")) }, "Rename it to .leostudio")));
              return;
            }
            const host = h("div", { class: "fv-board-host" });
            body.replaceChildren(host);
            const sk = await mod.mountSketch(host, t, { app, path, onChange: edited });
            if (current !== path) { sk.destroy(); return; }
            ed = { getBytes: async () => new TextEncoder().encode(sk.getText()), destroy: sk.destroy, focus: sk.focus, sketch: sk };
            sk.focus();
          }).catch((e) => { if (current === path) body.replaceChildren(h("div", { class: "fv-loading", text: `Could not open the drawing: ${e}` })); });
          break;
        }
        if (/\.canvas$/i.test(path)) {
          body = h("div", { class: "fv-body fv-board" }, h("div", { class: "fv-loading", text: "Opening board…" }));
          Promise.all([import("./board.js"), app.host.readText(path)]).then(async ([mod, t]) => {
            if (current !== path) return;
            const host = h("div", { class: "fv-board-host" });
            body.replaceChildren(host);
            const board = await mod.mountBoard(host, t, { app, path, onChange: edited });
            if (current !== path) { board.destroy(); return; }
            ed = { getBytes: async () => new TextEncoder().encode(board.getText()), destroy: board.destroy, focus: board.focus, board };
            board.focus();
          }).catch((e) => { if (current === path) body.replaceChildren(h("div", { class: "fv-loading", text: `Could not open the board: ${e}` })); });
          break;
        }
        // a CSV opens as a table to edit, written back as CSV (Settings › Files › CSV opens as text: the raw text)
        if (/\.(csv|tsv)$/i.test(path) && app.settings.csvAsText !== true) {
          body = h("div", { class: "fv-body fv-office" }, h("div", { class: "fv-loading", text: "Opening the table…" }));
          Promise.all([import("./officeview.js"), app.host.readText(path)]).then(async ([mod, t]) => {
            if (current !== path) return;
            const host = h("div", { class: "fv-office-host" });
            body.replaceChildren(host);
            const view = await mod.mountXlsx(host, null, { onEdit: edited, csv: t, name });
            if (current !== path) { view.destroy(); return; }
            ed = view;
          }).catch((e) => { if (current === path) body.replaceChildren(h("div", { class: "fv-loading", text: `Could not open the table: ${e}` })); });
          break;
        }
        body = h("div", { class: "fv-body fv-code" }, h("div", { class: "fv-loading", text: "Loading…" }));
        app.host.readText(path).then((t) => {
          if (current !== path) return;
          const code = mountCode(body, t, name, { onChange: edited, onSave: () => { saveSoon.cancel?.(); save(); } });
          ed = { getBytes: async () => new TextEncoder().encode(code.getText()), destroy: code.destroy, focus: code.focus, code };
          if (wantLine) { code.goLine(wantLine); wantLine = 0; } else code.focus();
        }).catch((e) => { body.replaceChildren(h("div", { class: "fv-loading", text: String(e) })); });
        break;
      }
      case "archive": {
        // an archive: what is in it, and any of it taken out to a folder of your choice
        const root = String(app.vault.root || "").replace(/[\\/]+$/, "");
        const sep = root.includes("\\") ? "\\" : "/";
        // a file from outside (an outpost, a hidden folder) is read where it lies, not under the vault
        body = archivePanel(app, app.isGuest && app.isGuest(path) ? app.guestAbs(path) : root + sep + path.split("/").join(sep), { name, here: dirname(path), openInApp: () => app.host.openPath(path), alive: () => current === path });
        break;
      }
      default:
        if (OFFICE_EDIT.test(path) || /\.(pptx|ppt|rtf|doc|xls)$/i.test(path)) {
          body = h("div", { class: "fv-body fv-office" }, h("div", { class: "fv-loading", text: "Opening…" }));
          const docx = /\.docx$/i.test(path);
          const failed = (msg) => {
            if (current === path) body.replaceChildren(h("div", { class: "fv-center fv-fill" }, h("div", { class: "fv-card" },
              icon("file"), h("h3", { text: name }), h("p", { text: msg }),
              h("button", { class: "btn btn-primary", onclick: () => app.host.openPath(path).catch((e) => app.toast(String(e), { kind: "error" })) }, "Open in app"))));
          };
          const zipped = (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b;
          // an older Office file in its newer form, made by LibreOffice or Office itself (cached; the file untouched) -
          // or null, with why, when neither is on the computer
          let convWhy = "";
          const converted = async () => {
            if (!app.host.officeConvert) return null;
            try { const b64 = await app.host.officeConvert(path); return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
            catch (e) { convWhy = String(e && e.message ? e.message : e); return null; }
          };
          Promise.all([import("./officeview.js"), bytesOf(path), import("./rtf.js")]).then(async ([mod, bytes, rtf]) => {
            if (current !== path) return;
            // Word also saves RTF (and old .doc) under other names: show its text
            if (rtf.isRtf(bytes)) {
              // editable as plain text; saving writes simple RTF (the first save
              // keeps the original in the vault's .trash)
              const text = rtf.rtfToText(bytes);
              const writable = !/\.doc$/i.test(path); // Leonote never writes the old .doc name
              const area = h("textarea", { class: "fv-rtf-text", spellcheck: "true", value: text, readOnly: !writable });
              const grow = () => { area.style.height = "auto"; area.style.height = area.scrollHeight + "px"; };
              area.addEventListener("input", () => { grow(); edited(); });
              body.replaceChildren(h("div", { class: "fv-rtf" },
                h("div", { class: "fv-rtf-note", text: "Rich text (RTF) · edit the text here; saving keeps the words and paragraphs but not bold, colours or fonts. The first save keeps the original in .trash." }),
                area));
              requestAnimationFrame(grow);
              if (writable) ed = { getBytes: async () => new TextEncoder().encode(rtf.textToRtf(area.value)), destroy() {}, focus: () => area.focus() };
              return;
            }
            if (/\.pptx?$/i.test(path) && !zipped(bytes)) {
              // the older binary PowerPoint format: turned into a .pptx by LibreOffice or PowerPoint when one is
              // here (cached, the file itself untouched) and drawn like any .pptx; else its text and pictures
              const host = h("div", { class: "fv-office-host" });
              body.replaceChildren(host, h("div", { class: "fv-loading", text: "Reading the older PowerPoint file…" }));
              const conv = await converted();
              if (current !== path) return;
              if (conv) {
                body.replaceChildren(host);
                const sl = await (await import("./slides.js")).mountSlides(host, conv, {});
                if (current !== path) { sl.destroy(); return; }
                ed = { destroy: sl.destroy, getBytes: null, readOnly: true };
                return;
              }
              const why = convWhy;
              const old = await import("./ppt.js");
              if (!old.isCfb(bytes)) return failed("This presentation can't be read here.");
              body.replaceChildren(host);
              if (why) host.append(h("div", { class: "fv-loading", text: `Shown as text and pictures only - ${why}. With LibreOffice (free) or PowerPoint installed, it opens as designed.` }));
              const v = await old.mountPpt(host, bytes, { h });
              if (current !== path) { v.destroy(); return; }
              ed = { destroy: v.destroy, getBytes: null, readOnly: true };
              return;
            }
            if (/\.pptx?$/i.test(path)) {
              const host = h("div", { class: "fv-office-host" });
              body.replaceChildren(host);
              const sl = await (await import("./slides.js")).mountSlides(host, bytes, { onEdit: /\.pptx$/i.test(path) ? edited : null });
              if (current !== path) { sl.destroy(); return; }
              ed = { destroy: sl.destroy, getBytes: sl.getBytes, readOnly: !sl.getBytes };
              return;
            }
            if (/\.(doc|xls)$/i.test(path) && !zipped(bytes)) {
              // the older binary Word and Excel formats: as designed when they can be converted, read-only
              const word = /\.doc$/i.test(path);
              body.replaceChildren(h("div", { class: "fv-loading", text: `Reading the older ${word ? "Word" : "Excel"} file…` }));
              const conv = await converted();
              if (current !== path) return;
              if (conv) {
                const host = h("div", { class: "fv-office-host" });
                body.replaceChildren(host);
                const view = await (word ? mod.mountDocx : mod.mountXlsx)(host, conv, { readOnly: true });
                if (current !== path) { view.destroy(); return; }
                ed = { destroy: view.destroy, getBytes: null, readOnly: true };
                return;
              }
              if (!word) return failed(`Older Excel files (.xls) open in their own app here - ${convWhy || "they can't be converted"}. With LibreOffice (free) or Excel installed, they open in Leonote.`);
              // the older binary Word format: its text, read-only
              const old = await import("./doc.js");
              if (!old.isCfb(bytes)) return failed("This file isn't a Word document inside, even though its name says so.");
              let text;
              try { text = old.docText(bytes); } catch (e) { return failed(`This Word file can't be read here (${e && e.message ? e.message : e}).`); }
              body.replaceChildren(h("div", { class: "fv-rtf" },
                h("div", { class: "fv-rtf-note", text: `Older Word format (.doc) · the text only, read-only${convWhy ? ` - ${convWhy}` : ""}. With LibreOffice (free) or Word installed it opens with its layout; saved as .docx it can be edited.` }),
                h("div", { class: "fv-rtf-text fv-doc-text", text })));
              ed = { destroy() {}, getBytes: null, readOnly: true };
              return;
            }
            if (/\.o(dt|ds)$/i.test(path)) return failed("OpenDocument files open in their own app. Saved as .docx or .xlsx, they open and edit here.");
            if (!zipped(bytes)) return failed("This file isn't a Word or Excel document inside, even though its name says so.");
            const host = h("div", { class: "fv-office-host" });
            body.replaceChildren(host);
            const view = await (docx ? mod.mountDocx : mod.mountXlsx)(host, bytes, { onEdit: edited });
            if (current !== path) { view.destroy(); return; }
            ed = view;
          }).catch((e) => failed(`Could not open it here (${e && e.message ? e.message : e}).`));
          break;
        }
        body = h("div", { class: "fv-body fv-center" }, h("div", { class: "fv-card" },
          icon(KIND_ICON[f.kind] || "file"),
          h("h3", { text: name }),
          h("p", { text: f.kind === "office" ? (/\.ppt$/i.test(path) ? "Older PowerPoint files (.ppt) open in their own app. Saved as .pptx, Leonote can preview them." : "This older Office format opens in its own app.") : "Leonote can't show this file type." }),
          h("button", { class: "btn btn-primary", onclick: () => app.host.openPath(path).catch((e) => app.toast(String(e), { kind: "error" })) }, "Open in app")));
    }
    // the same frame and the same drawer while the tab stays a file tab
    drawer.el.classList.remove("is-fs");
    if (fv && fv.isConnected && fv.parentNode === el && fv.children.length === 3) { fv.children[0].replaceWith(head); fv.children[1].replaceWith(body); if (fv.lastChild !== drawer.el) fv.append(drawer.el); }
    else { fv = h("div", { class: "fv" }, head, body, drawer.el); el.replaceChildren(fv); }
    drawer.show(path);
  }

  // Another program changed the open file: take its version, unless there
  // are unsaved edits here (then ours wins on the next save).
  async function external() {
    if (!current || !ed || dirty || saving) return;
    const f = app.vault.files.get(current) || (app.guestFile && app.guestFile(current));
    if (!f || !f.mtime || f.mtime === knownMtime) return;
    knownMtime = f.mtime;
    const path = current;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (ed.code) {
      const t = await app.host.readText(path).catch(() => null);
      if (t != null && current === path && !dirty) { ed.code.setText(t); app.toast(`${name} changed on disk - reloaded`, { ms: 2200 }); }
      return;
    }
    // a video project takes the new version as one edit: Ctrl+Z puts it back (an agent's cuts, say)
    if (ed.setText) {
      const t = await app.host.readText(path).catch(() => null);
      if (t != null && current === path && !dirty) { ed.setText(t); app.toast(`${name} changed - Ctrl+Z puts it back as it was`, { ms: 4000 }); }
      return;
    }
    // A board or a drawing holds live state - the view, the selection, a card
    // half-dragged. Rebuilding it from disk behind the user's back makes the
    // whole thing blink and throws that state away, so it is offered instead.
    if (ed.board || ed.sketch || ed.paint) {
      app.toast(`${name} changed on disk`, { ms: 8000, action: { label: "Reload it", run: () => { if (current === path) render(path); } } });
      return;
    }
    render(path);
  }

  return {
    show(path) {
      if (path === current && el.firstChild) return;
      if (current && current !== path) close();
      current = path;
      render(path);
    },
    refresh() { if (current && !ed) render(current); },
    /** A text or code file at line `n` (1-based) - now, or once it has loaded. */
    goLine(n) { if (ed && ed.code) ed.code.goLine(n); else wantLine = n; },
    external,
    /** Write pending edits now (tab switch, quit). */
    flush: () => { saveSoon.cancel?.(); return save(); },
    /** The view has left the screen for good: pending edits are saved, then it lets go of everything. */
    destroy() {
      saveSoon.cancel?.();
      leaving = true;
      if (dirty) save();
      letGo();
    },
    get dirty() { return dirty; },
    /** the open research board, if the current file is one */
    get board() { return ed && ed.board ? ed.board : null; },
    get path() { return current; },
  };
}

// a file in an archive: its kind, the icon and the colour it shows with
const ARCH_KINDS = [
  ["image", /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|ico)$/i, "image", "#e86aa6"],
  ["video", /\.(mp4|webm|mkv|mov|avi|m4v|leovideo)$/i, "film", "#9b7bf0"],
  ["sound", /\.(mp3|wav|ogg|m4a|flac|opus|aac)$/i, "music", "#3fb4a0"],
  ["pdf", /\.pdf$/i, "fileText", "#e5534b"],
  ["office", /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv)$/i, "file", "#4c8dff"],
  ["note", /\.(md|txt)$/i, "fileText", "var(--accent)"],
  ["board", /\.(canvas|leopaint|leostudio|excalidraw)$/i, "grid", "#46a758"],
  ["code", /\.(js|mjs|ts|tsx|jsx|py|rs|go|java|c|cpp|h|cs|css|scss|html?|json|jsonl|xml|ya?ml|toml|sh|ps1|bat|sql|lua)$/i, "code", "#e8a33d"],
  ["archive", /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|cab|iso)$/i, "archive", "#b07a4f"],
];
const archKind = (n) => ARCH_KINDS.find((k) => k[1].test(n)) || ["other", null, "file", "var(--text-4)"];

/**
 * What is in an archive (zip, 7z; the rest through 7-Zip or WinRAR), wherever it lies. A file is
 * looked at beside the list (or in a tab of its own - the switch at the top), the arrows walk the
 * list, a drag takes a file onto a folder of the tree, Extract takes it into the vault or a PC folder.
 * Nothing is unpacked into the vault by itself. abs: the archive's full path; here: its vault folder.
 */
export function archivePanel(app, abs, { name, here = null, openInApp, alive = () => true }) {
  const S = app.settings;
  const inline = () => S.archivePreviewHere !== false;
  const list = h("div", { class: "fv-arch-list", tabIndex: 0 }, h("div", { class: "fv-loading", text: "Reading the archive…" }));
  // out to a folder somewhere on the PC (the system's folder dialog) - for when the vault is not the place
  const extractToPc = async (entries) => {
    let picked = null;
    try { picked = await app.host.dialogOpen({ directory: true, multiple: false, title: entries.length ? "Extract into" : "Extract everything into" }); } catch {}
    const into = Array.isArray(picked) ? picked[0] : picked;
    if (!into) return;
    try { const n = await app.host.archiveExtract(abs, entries, into); app.toast(`${n} file${n === 1 ? "" : "s"} extracted`, { ms: 4000, action: { label: "Show", run: () => app.host.externalReveal(into).catch(() => {}) } }); }
    catch (e) { app.toast(String(e), { kind: "error", ms: 8000 }); }
  };
  // into a folder of the vault, picked the way new files are (starred folders first)
  const askVaultDir = async (anchor, title) => { const { pickFolder } = await import("./newtab.js"); return pickFolder(app, anchor, { title, first: here != null ? [here, "where the archive is"] : undefined }); };
  const extract = async (entries, anchor) => {
    const dir = await askVaultDir(anchor, entries.length ? "Take it out into" : "Take everything out into");
    if (dir == null) return;
    if (entries.length) for (const en of entries) await app.archiveTake({ abs, entry: en }, dir);
    else await app.archiveTakeAll(abs, dir);
  };
  const where = h("div", { class: "segmented is-small fv-arch-where", title: "Where a file you pick opens: beside the list (the split view, as a tab shows it) or in a tab" });
  const paintWhere = () => where.replaceChildren(...[["here", "Preview beside", true], ["tab", "Open in a tab", false]].map(([v, label, on]) =>
    h("button", { class: "seg" + (inline() === on ? " is-active" : ""), onclick: () => { app.setSetting("archivePreviewHere", on); paintWhere(); } }, label)));
  paintWhere();
  const head = h("div", { class: "fv-arch-head" }, icon("archive"), h("h3", { text: name }), h("span", { class: "trash-gap" }), where,
    h("button", { class: "btn btn-primary", title: "Into a folder of the vault - or drag single files onto a folder in the tree", onclick: (e) => extract([], e.currentTarget) }, icon("download"), "Extract everything…"),
    h("button", { class: "btn", title: "Into a folder anywhere on this PC", onclick: () => extractToPc([]) }, icon("folder"), "To a PC folder…"),
    h("button", { class: "icon-btn", title: "Open the archive in its own app", onclick: () => openInApp().catch((e) => app.toast(String(e), { kind: "error" })) }, icon("outside")));
  const root = h("div", { class: "fv-body fv-archive" }, head, h("div", { class: "fv-arch-main" }, list));

  // the preview: the file read out to the temp folder once, then shown beside the list by the split
  // view - the same viewer a tab uses (pictures, video, notes, Leopaint and the rest), as a preview tab
  // the next pick replaces
  const temp = new Map(); // entry -> its temp path
  let picked = -1, rows = [], files = [], token = 0;
  async function preview(e) {
    const my = ++token;
    let path = temp.get(e.name);
    if (!path) {
      try { path = await app.host.archivePreview(abs, e.name); temp.set(e.name, path); }
      catch (err) { console.warn("archive preview", e.name, err); if (my === token) app.toast(`Could not take it out: ${err && err.message ? err.message : err}`, { kind: "error", ms: 5000 }); return; }
    }
    if (my !== token || !alive()) return;
    const keep = document.activeElement === list;
    app.previewBeside({ kind: "ext", path });
    // the viewer may take the keys as it opens: they stay with the list, for the arrows
    if (keep) for (const ms of [0, 200, 600]) setTimeout(() => { if (document.activeElement !== list && !document.activeElement?.closest?.(".fv-archive")) list.focus({ preventScroll: true }); }, ms);
  }
  const previewSoon = debounce((e) => preview(e), 140);
  function pick(i, { open = false, quiet = false } = {}) {
    if (!rows.length) return;
    picked = Math.max(0, Math.min(rows.length - 1, i));
    for (const [k, r] of rows.entries()) r.classList.toggle("is-picked", k === picked);
    rows[picked].scrollIntoView({ block: "nearest" });
    if (quiet) return;
    if (inline() && !open) previewSoon(files[picked]);
    else app.archiveOpen({ abs, entry: files[picked].name });
  }
  list.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); pick(picked + (ev.key === "ArrowDown" ? 1 : -1)); }
    else if (ev.key === "Home" || ev.key === "End") { ev.preventDefault(); pick(ev.key === "Home" ? 0 : rows.length - 1); }
    else if (ev.key === "Enter" && picked >= 0) { ev.preventDefault(); pick(picked, { open: true }); }
  });

  // the list: found by words, narrowed to a kind, sorted - all in memory, as fast as typing
  let all = [], words = "", only = "", sortBy = S.archiveSort || "path";
  const find = h("input", { class: "input fv-arch-find", placeholder: "Find in the archive", spellcheck: false });
  const kinds = h("div", { class: "fv-arch-kinds" });
  const sortBtn = h("button", { class: "btn btn-sm", title: "Sort the list", onclick: (ev) => menu(0, 0,
    [["path", "Folder and name"], ["name", "Name"], ["type", "Kind"], ["size", "Size, largest first"], ["date", "Newest first"]].map(([v, label]) => ({ label, checked: sortBy === v, run: () => { sortBy = v; app.setSetting("archiveSort", v); draw(); } })), { anchor: ev.currentTarget }) }, icon("list"), "Sort");
  const tools = h("div", { class: "fv-arch-tools" }, find, kinds, h("span", { class: "trash-gap" }), sortBtn);
  find.addEventListener("input", debounce(() => { words = find.value.trim().toLowerCase(); draw(); }, 120));
  find.addEventListener("keydown", (ev) => { if (ev.key === "ArrowDown") { ev.preventDefault(); list.focus({ preventScroll: true }); pick(0); } });
  const leafOf = (n) => n.slice(n.lastIndexOf("/") + 1);
  const ORDER = {
    path: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    name: (a, b) => leafOf(a.name).localeCompare(leafOf(b.name), undefined, { numeric: true }),
    type: (a, b) => archKind(a.name)[0].localeCompare(archKind(b.name)[0]) || leafOf(a.name).localeCompare(leafOf(b.name), undefined, { numeric: true }),
    size: (a, b) => b.size - a.size,
    date: (a, b) => String(b.modified).localeCompare(String(a.modified)),
  };
  function row(e, i) {
    const [, , ic, col] = archKind(e.name);
    const slash = e.name.lastIndexOf("/");
    // a click looks at it; a drag takes it onto a folder of the tree, or onto the tabs to look at it
    const r = h("div", { class: "trash-row fv-arch-row", draggable: true, title: "Click to look at it · Enter or double-click: in a tab · drag it onto a folder in the tree to take it out there",
      onclick: (ev) => { if (!ev.target.closest("button")) { list.focus({ preventScroll: true }); pick(i); } },
      ondblclick: (ev) => { if (!ev.target.closest("button")) pick(i, { open: true }); } },
      h("span", { class: "fv-arch-ico", style: { color: col } }, icon(ic)),
      h("div", { class: "trash-main" },
        h("div", { class: "trash-name" }, slash > 0 ? h("span", { class: "fv-arch-dir", text: e.name.slice(0, slash + 1) }) : null, h("span", { text: e.name.slice(slash + 1) })),
        h("div", { class: "trash-meta", text: `${fmtSize(e.size)}${e.modified ? " · " + e.modified : ""}` })),
      h("button", { class: "icon-btn fv-arch-tab", title: "Open in a tab", onclick: () => app.archiveOpen({ abs, entry: e.name }) }, icon("expand")),
      h("button", { class: "btn btn-sm fv-arch-x", title: "Into a folder of the vault", onclick: (ev) => extract([e.name], ev.currentTarget) }, "Extract…"),
      h("button", { class: "icon-btn", title: "More", onclick: (ev) => more(ev, ev.currentTarget) }, icon("more")));
    // the same menu from the "…" and from a right-click on the row
    function more(ev, anchor) {
      menu(ev.clientX, ev.clientY, [
        { label: "Look at it beside", icon: "eye", run: () => { app.setSetting("archivePreviewHere", true); paintWhere(); pick(i); } },
        { label: "Open in a tab", icon: "expand", run: () => app.archiveOpen({ abs, entry: e.name }) },
        { label: "Keep it beside", icon: "columns", run: () => app.archiveBeside({ abs, entry: e.name }) },
        "sep",
        { label: "Into a folder of the vault…", icon: "folder", run: () => extract([e.name], anchor) },
        { label: "Into a folder on this PC…", icon: "outside", run: () => extractToPc([e.name]) },
      ], anchor ? { anchor } : {});
    }
    r.addEventListener("contextmenu", (ev) => { ev.preventDefault(); list.focus({ preventScroll: true }); pick(i, { quiet: true }); more(ev, null); });
    r.addEventListener("dragstart", (ev) => { ev.dataTransfer.setData("application/x-leonote-archive", JSON.stringify({ abs, entry: e.name })); ev.dataTransfer.effectAllowed = "copy"; });
    return r;
  }
  function draw() {
    const counts = new Map();
    for (const e of all) { const k = archKind(e.name)[0]; counts.set(k, (counts.get(k) || 0) + 1); }
    kinds.replaceChildren(...[["", "All", all.length], ...[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, k[0].toUpperCase() + k.slice(1), n])].map(([k, label, n]) =>
      h("button", { class: "fv-arch-kind" + (only === k ? " is-on" : ""), onclick: () => { only = only === k ? "" : k; draw(); } }, label, h("small", { text: String(n) }))));
    files = all.filter((e) => (!only || archKind(e.name)[0] === only) && (!words || e.name.toLowerCase().includes(words))).sort(ORDER[sortBy] || ORDER.path);
    picked = -1;
    // a long list draws its first 600; the words narrow it
    rows = files.slice(0, 600).map(row);
    list.replaceChildren(...(rows.length ? rows : [h("div", { class: "trash-none", text: all.length ? "Nothing of that name or kind" : "The archive is empty" })]),
      files.length > 600 ? h("div", { class: "trash-none", text: `and ${files.length - 600} more - find them by name` }) : "");
  }
  app.host.archiveList(abs).then((entries) => {
    if (!alive()) return;
    all = entries.filter((e) => !e.dir);
    const total = all.reduce((n, e) => n + e.size, 0);
    const packed = all.reduce((n, e) => n + e.packed, 0);
    head.querySelector("h3").after(h("span", { class: "fv-arch-sum", text: `${all.length} file${all.length === 1 ? "" : "s"} · ${fmtSize(total)} inside · ${fmtSize(packed)} packed` }));
    head.after(tools);
    draw();
  }).catch((e) => { if (alive()) list.replaceChildren(h("div", { class: "trash-none", text: `Could not read it: ${e}` })); });
  return root;
}
