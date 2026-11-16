// Animate: frame-by-frame animation over the same .leostudio as Draw and Photo.
//
// A frame is a layer group marked `frame`; the order of those groups in the
// layer list is the order of the frames. Only the current frame's group is
// shown, in every workspace - so Paint's brushes and Photo's adjustments work
// on the frame on screen, and switching to them to correct a frame is just a
// click. Layers outside every frame (a background, a logo) show on all of
// them. Undo, redo and the file itself need nothing new: frames are layers.
//
// The timeline: play at a chosen speed, step, add a blank frame or a copy,
// reorder by dragging, onion skin (the frame before in red, after in green).
// "Save video" renders every frame and records it through the browser's own
// MediaRecorder - MP4 where the engine can (Instagram takes it as it is),
// WebM otherwise - looped to Instagram's three seconds at the least.

import * as D from "./paintdoc.js";
import { menu, toast, sortable, confirmDialog, askDialog } from "./ui.js";

const FPS = [6, 8, 12, 15, 24, 30];

/**
 * The frames in the order they play: a frame held for 3 beats appears 3 times,
 * and ping-pong runs back without repeating either end. Shared by playback,
 * the video export and the video editor, so they all keep the same timing.
 */
export function frameSequence(frames, anim = {}) {
  const seq = [];
  frames.forEach((f, i) => { for (let k = 0; k < Math.max(1, Math.min(12, f.hold || 1)); k++) seq.push(i); });
  if (anim.pingpong && frames.length > 2) {
    const back = [];
    for (let i = frames.length - 2; i >= 1; i--) for (let k = 0; k < Math.max(1, Math.min(12, frames[i].hold || 1)); k++) back.push(i);
    seq.push(...back);
  }
  return seq;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function mountAnim(ed) {
  const { app, doc, engine, h, icon, root } = ed;
  const panel = h("section", { class: "pt-anim pt-glass", hidden: true });
  root.append(panel);
  let timer = 0;
  let destroyed = false;

  const frames = () => doc.layers.filter((l) => l.kind === "group" && l.frame);
  const conf = () => (doc.anim ||= { fps: 12, cur: 0, onion: true, minSec: 3 });
  const seq = () => frameSequence(frames(), conf());
  const cur = () => clamp(conf().cur | 0, 0, Math.max(0, frames().length - 1));
  const hasFrames = () => frames().length > 0;
  const on = () => ed.workspace === "animate";

  /* ── which frame is up ───────────────────────────────────────────────── */

  function show(i, { quiet = false } = {}) {
    const fs = frames();
    if (!fs.length) return;
    const a = conf();
    a.cur = ((i % fs.length) + fs.length) % fs.length;
    fs.forEach((f, k) => { f.visible = k === a.cur; });
    engine.allDirty = true;
    ed.invalidate();
    syncRef();
    if (quiet) return tick(); // while playing only the count and the lit thumbnail move: a header rebuilt every frame ate the Stop click
    // brushes go into the frame on screen
    const inside = D.descendants(doc.layers, fs[a.cur].id);
    if (!inside.some((l) => l.id === ed.selectedId)) {
      const pick = inside.filter((l) => D.hasPixels(l)).pop();
      if (pick) ed.select(pick.id);
    }
    ed.renderLayers();
    onion();
    paint();
  }

  /* ── a video underneath: draw over real footage, frame by frame (rotoscoping) ──
     Kept in the drawing (doc.anim.ref: the vault path, how strong, where it starts); it is only ever
     seen while drawing - the saved video, the GIF and the frames leave it out. */
  let refVid = null;
  let refWant = 0, refAsked = -1; // the moment the frame on screen wants, and the one last asked of the video
  // (a video lands a hair off the moment asked, so it is never compared with where it landed)
  const refConf = () => conf().ref || null;
  // where a frame falls in the video: its start in beats (holds count) at the frame rate, from the chosen start
  function refTime(i) {
    const fs = frames();
    let beats = 0;
    for (let k = 0; k < i && k < fs.length; k++) beats += Math.max(1, Math.min(12, fs[k].hold || 1));
    return (refConf()?.from || 0) + beats / (conf().fps || 12);
  }
  function syncRef() {
    const r = refConf();
    if (!r || !on() || destroyed) { ed.setUnder(null); return; }
    if (!refVid || refVid.dataset.path !== r.path) {
      if (refVid) refVid.removeAttribute("src");
      refVid = document.createElement("video");
      refAsked = -1;
      refVid.dataset.path = r.path;
      refVid.muted = true;
      refVid.preload = "auto";
      refVid.addEventListener("seeked", () => {
        if (!refConf() || !on()) return;
        if (refWant !== refAsked) { refAsked = refWant; refVid.currentTime = refWant; } // the frame moved on while it sought
        else ed.setUnder({ source: refVid, alpha: refConf().alpha ?? 0.5 });
      });
      refVid.addEventListener("loadeddata", () => syncRef(), { once: true });
      refVid.addEventListener("error", () => toast(`Could not play ${r.path.slice(r.path.lastIndexOf("/") + 1)} here`, { kind: "error", ms: 4000 }), { once: true });
      refVid.src = app.fileUrl(r.path);
      return;
    }
    refWant = clamp(refTime(cur()), 0, Math.max(0, (refVid.duration || 0) - 0.02));
    if (refVid.readyState < 1 || refVid.seeking) return;
    if (refWant !== refAsked) { refAsked = refWant; refVid.currentTime = refWant; }
    else if (refVid.readyState >= 2) ed.setUnder({ source: refVid, alpha: r.alpha ?? 0.5 });
  }
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;
  function refMenuItems(redo) {
    const a = conf();
    const r = refConf();
    const vids = [...app.vault.files.values()].filter((f) => VIDEO_EXT.test(f.path)).sort((x, y) => (y.mtime || 0) - (x.mtime || 0)).slice(0, 40);
    const pickList = vids.length ? vids.map((f) => ({ label: f.path.slice(f.path.lastIndexOf("/") + 1), checked: r && r.path === f.path, run: () => { a.ref = { path: f.path, alpha: r ? r.alpha : 0.5, from: 0 }; redo(); syncRef(); } }))
      : [{ header: "No videos in the vault yet - drop one in first", plain: true }];
    return [
      { header: "Video underneath" },
      { label: r ? "Another video" : "Put a video underneath", icon: "film", sub: pickList },
      ...(r ? [
        { label: "How strong", icon: "contrast", sub: [[0.25, "Faint"], [0.5, "Half"], [0.75, "Strong"], [1, "Full"]].map(([v, n]) => ({ label: n, checked: (r.alpha ?? 0.5) === v, run: () => { r.alpha = v; redo(); syncRef(); } })) },
        { label: `Starts at ${(r.from || 0).toFixed(1)} s…`, icon: "clock", run: async () => {
          const got = await askDialog("Where the video starts", [{ key: "s", label: "Seconds into the video, for frame 1", value: String(r.from || 0) }], { ok: "Set" });
          if (got && Number.isFinite(+got.s)) { r.from = Math.max(0, +got.s); redo(); syncRef(); }
        } },
        { label: "Take it away", icon: "x", run: () => { delete a.ref; if (refVid) { refVid.removeAttribute("src"); refVid = null; } redo(); syncRef(); } },
      ] : []),
    ];
  }

  /** A frame (or all non-frame layers too) drawn alone into a new canvas. */
  function solo(i, scale, { background = false, shared = false, tint = null } = {}) {
    const fs = frames();
    const was = doc.layers.map((l) => l.visible);
    doc.layers.forEach((l) => {
      if (l.kind === "group" && l.frame) l.visible = fs.indexOf(l) === i;
      else if (!shared && !l.parent) l.visible = false;
    });
    engine.allDirty = true;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(doc.width * scale));
    c.height = Math.max(1, Math.round(doc.height * scale));
    const g = c.getContext("2d");
    try { engine.compositeInto(g, 0, 0, doc.width, doc.height, scale, { background }); } finally {
      doc.layers.forEach((l, k) => { l.visible = was[k]; });
      engine.allDirty = true;
    }
    if (tint) { g.globalCompositeOperation = "source-atop"; g.fillStyle = tint; g.fillRect(0, 0, c.width, c.height); }
    return c;
  }

  /** The frames either side, faint and tinted, over the one being drawn. */
  function onion() {
    const fs = frames();
    if (!on() || !conf().onion || timer || fs.length < 2) return ed.setOnion(null);
    const i = cur();
    const k = Math.min(1, 900 / Math.max(doc.width, doc.height));
    const out = document.createElement("canvas");
    out.width = Math.round(doc.width * k);
    out.height = Math.round(doc.height * k);
    const g = out.getContext("2d");
    const wrap = fs.length > 2;
    const reach = Math.max(1, Math.min(3, conf().onionReach || 1));
    const strength = conf().onionStrength ?? 0.3;
    const seen = new Set([i]);
    // the farther a frame, the fainter
    for (let d = reach; d >= 1; d--) {
      const prev = i - d >= 0 ? i - d : wrap ? (i - d + fs.length * 3) % fs.length : -1;
      const next = i + d < fs.length ? i + d : wrap ? (i + d) % fs.length : -1;
      const fade = strength * (1 - (d - 1) / (reach + 0.5));
      if (prev >= 0 && !seen.has(prev)) { seen.add(prev); g.globalAlpha = fade; g.drawImage(solo(prev, k, { tint: "rgba(229,72,77,.75)" }), 0, 0); }
      if (next >= 0 && !seen.has(next)) { seen.add(next); g.globalAlpha = fade * 0.7; g.drawImage(solo(next, k, { tint: "rgba(48,164,108,.75)" }), 0, 0); }
    }
    ed.setOnion(out);
  }

  /* ── making frames ───────────────────────────────────────────────────── */

  const FRAME_NAME = /^Frame \d+( copy( \d+)?)?$/;
  function renumber() {
    frames().forEach((f, k) => { if (FRAME_NAME.test(f.name)) f.name = `Frame ${k + 1}`; });
  }

  /** A drawing becomes an animation: everything it has is frame 1. */
  function makeFrames() {
    if (hasFrames() || !ed.roomFor(1)) return;
    ed.structural("Make frames", () => {
      const g = D.newLayer({ kind: "group", name: "Frame 1", frame: true, collapsed: false, passThrough: false });
      for (const l of doc.layers) if (!l.parent) l.parent = g.id;
      doc.layers.push(g);
    });
    conf().cur = 0;
  }

  function addFrame({ copy = false } = {}) {
    const fs = frames();
    const src = fs[cur()];
    if (!src) return makeFrames();
    if (copy) {
      if (!ed.roomFor(1 + D.descendants(doc.layers, src.id).length)) return;
      ed.duplicateLayer(src.id); // the copy lands just above, selected
    } else {
      if (!ed.roomFor(2)) return;
      ed.structural("Add frame", () => {
        const g = D.newLayer({ kind: "group", name: "Frame", frame: true, collapsed: false, passThrough: false });
        const l = D.newLayer({ name: "Drawing", parent: g.id });
        engine.addLayerBitmap(l.id);
        const at = D.layerIndex(doc, src.id) + 1;
        doc.layers.splice(at, 0, l, g);
      });
    }
    renumber();
    const now = frames();
    const made = now.findIndex((f) => f !== src && !fs.includes(f));
    show(made >= 0 ? made : cur() + 1);
  }

  function deleteFrame(i = cur()) {
    const fs = frames();
    if (fs.length < 2) return toast("An animation needs at least one frame", { ms: 2000 });
    ed.deleteLayer(fs[i].id);
    renumber();
    show(Math.min(i, frames().length - 1));
  }

  function moveFrame(from, to) {
    const fs = frames();
    if (from === to || !fs[from] || !fs[to]) return;
    const before = ed.layerSnapshot();
    doc.layers = D.moveLayerTo(doc.layers, fs[from].id, fs[to].id, { below: to < from });
    renumber();
    ed.pushMeta("Move frame", before);
    show(to);
  }

  /* ── playing ─────────────────────────────────────────────────────────── */

  function play() {
    if (timer) return stop();
    if (frames().length < 2) return toast("Add a second frame to play", { ms: 1800 });
    ed.setOnion(null);
    const fps = conf().fps || 12;
    const order = seq();
    let p = Math.max(0, order.indexOf(cur()));
    let last = performance.now(), acc = 0;
    const step = (now) => {
      if (!timer) return;
      acc += now - last; last = now;
      if (acc >= 1000 / fps) { acc %= 1000 / fps; p = (p + 1) % order.length; if (order[p] !== cur()) show(order[p], { quiet: true }); }
      timer = requestAnimationFrame(step);
    };
    timer = requestAnimationFrame(step);
    paint();
  }
  function stop() {
    if (!timer) return;
    cancelAnimationFrame(timer);
    timer = 0;
    show(cur());
  }

  /* ── the video ───────────────────────────────────────────────────────── */

  async function saveVideo() {
    const fs = frames();
    if (!fs.length) return;
    if (typeof MediaRecorder === "undefined") return toast("This window cannot record video", { kind: "error" });
    stop();
    const a = conf();
    const fps = a.fps || 12;
    // Instagram wants 1080 wide (or the drawing's own size, if asked); H.264 wants even sides
    const k = a.size === "full" ? 1 : Math.min(1, 1080 / doc.width);
    const w = Math.round(doc.width * k / 2) * 2, hh = Math.round(doc.height * k / 2) * 2;
    const order = seq();
    const loops = Math.max(1, Math.ceil(((a.minSec ?? 3) * fps) / order.length));
    const mime = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1.42E01F", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return toast("This window cannot record video", { kind: "error" });
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const note = toast(`Rendering ${fs.length} frame${fs.length === 1 ? "" : "s"}…`, { ms: 60000 });
    // every frame drawn once up front, so the recording runs at an even pace
    const shots = fs.map((_, i) => solo(i, k, { background: true, shared: true }));
    const c = document.createElement("canvas");
    c.width = w; c.height = hh;
    const g = c.getContext("2d");
    const paintShot = (s) => { g.fillStyle = doc.background || "#ffffff"; g.fillRect(0, 0, w, hh); g.drawImage(s, 0, 0, w, hh); };
    paintShot(shots[0]);
    const stream = c.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = performance.now();
    let n = 0;
    for (let l = 0; l < loops; l++) {
      for (const fi of order) {
        paintShot(shots[fi]);
        if (track.requestFrame) track.requestFrame();
        n++;
        await wait(Math.max(0, t0 + (n * 1000) / fps - performance.now()));
      }
    }
    rec.stop();
    await done;
    track.stop();
    if (note) note();
    const bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
    const stem = (ed.path.startsWith("@guest/") ? `${app.workDir ? app.workDir("drawing") : "Workplace/Drawings"}/${ed.path.split("/").pop()}` : ed.path).replace(/\.(leostudio|leopaint)$/i, "");
    let out = `${stem}.${ext}`;
    for (let i = 2; app.vault.files.has(out); i++) out = `${stem} ${i}.${ext}`;
    try {
      const entry = await app.host.writeFile(out, bytes);
      if (entry && entry.path) app.vault.setFiles([...[...app.vault.files.values()].filter((f) => f.path !== entry.path), entry]);
      const secs = (loops * order.length) / fps;
      toast(`Saved ${out.slice(out.lastIndexOf("/") + 1)} · ${w} × ${hh} · ${secs.toFixed(1)} s${ext === "webm" ? " (WebM - this window could not make MP4)" : ""}`, { ms: 6000, action: { label: "Show", run: () => app.reveal && app.reveal(out) } });
    } catch (e) {
      toast("Could not save the video: " + (e && e.message ? e.message : e), { kind: "error" });
    }
  }

  /* In-betweens: frames made between this one and the next, each a blend of the two - a softer, slower
     change for the cost of a click. They are ordinary frames: draw over them to make the motion yours. */
  function inBetween(n) {
    const fs = frames();
    const i = cur();
    if (i >= fs.length - 1) return toast("There is no next frame to go towards", { ms: 2200 });
    if (!ed.roomFor(2 * n)) return;
    stop();
    const A = solo(i, 1), B = solo(i + 1, 1);
    ed.structural("In-betweens", () => {
      const at = D.layerIndex(doc, fs[i].id) + 1;
      for (let k = n; k >= 1; k--) {
        const t = k / (n + 1);
        const c = document.createElement("canvas");
        c.width = doc.width; c.height = doc.height;
        const g = c.getContext("2d");
        g.globalAlpha = 1 - t; g.drawImage(A, 0, 0);
        g.globalAlpha = t; g.drawImage(B, 0, 0);
        const grp = D.newLayer({ kind: "group", name: "In-between", frame: true, collapsed: true, passThrough: false });
        const l = D.newLayer({ name: "Blend", parent: grp.id });
        engine.addLayerBitmap(l.id, c);
        doc.layers.splice(at, 0, l, grp);
      }
    });
    renumber();
    show(i + 1);
    toast(`${n} in-between${n === 1 ? "" : "s"} made - draw over them to shape the motion`, { ms: 3200 });
  }

  /** A GIF that loops forever, through ffmpeg: every frame in its timing, its colours its own. */
  async function saveGif() {
    const fs = frames();
    if (!fs.length || !app.host.videoExportBegin) return;
    const ff = await (await import("./tools.js")).ensureTool(app, "ffmpeg", "Saving a GIF");
    if (!ff) return;
    stop();
    const a = conf();
    const fps = a.fps || 12;
    const k = Math.min(1, (a.gifSide || 640) / Math.max(doc.width, doc.height));
    const w = Math.round(doc.width * k / 2) * 2, hh = Math.round(doc.height * k / 2) * 2;
    const stem = (ed.path.startsWith("@guest/") ? `${app.workDir ? app.workDir("drawing") : "Workplace/Drawings"}/${ed.path.split("/").pop()}` : ed.path).replace(/\.(leostudio|leopaint)$/i, "");
    let out = `${stem}.gif`;
    for (let i = 2; app.vault.files.has(out); i++) out = `${stem} ${i}.gif`;
    const note = toast(`Making the GIF…`, { ms: 120000 });
    let id = 0;
    try {
      const shots = fs.map((_, i) => solo(i, k, { background: true, shared: true }));
      const c = document.createElement("canvas");
      c.width = w; c.height = hh;
      const g = c.getContext("2d");
      ({ id } = await app.host.videoExportBegin(out, fps, 0, false));
      await app.host.videoExportStart(id);
      for (const fi of seq()) {
        g.fillStyle = doc.background || "#ffffff"; g.fillRect(0, 0, w, hh); g.drawImage(shots[fi], 0, 0, w, hh);
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
        await app.host.videoExportFrame(id, new Uint8Array(await blob.arrayBuffer()));
      }
      const rel = await app.host.videoExportEnd(id, out);
      app.vault.setFiles([...[...app.vault.files.values()].filter((f) => f.path !== rel), { path: rel, size: 0, mtime: Date.now(), kind: "image" }]);
      toast(`Saved ${rel.slice(rel.lastIndexOf("/") + 1)} · ${w} × ${hh}`, { ms: 6000, action: { label: "Open", run: () => app.openFile(rel, { newTab: true }) } });
    } catch (e) {
      if (id) app.host.videoExportCancel(id).catch(() => {});
      toast("Could not make the GIF: " + (e && e.message ? e.message : e), { kind: "error" });
    } finally { if (note) note(); }
  }

  /** The next frame made from this one - all of it, or only the pieces picked - and drawing goes on there. */
  function duplicate({ only = null } = {}) {
    if (!only) return addFrame({ copy: true });
    const fs = frames();
    const i = cur();
    if (!fs[i] || !ed.roomFor(2)) return;
    stop();
    const pic = solo(i, 1);
    const g = pic.getContext("2d");
    g.globalCompositeOperation = "destination-in";
    g.drawImage(only.mask, 0, 0);
    ed.structural("Duplicate the pieces", () => {
      const grp = D.newLayer({ kind: "group", name: "Frame", frame: true, collapsed: false, passThrough: false });
      const l = D.newLayer({ name: "Pieces", parent: grp.id });
      engine.addLayerBitmap(l.id, pic);
      doc.layers.splice(D.layerIndex(doc, fs[i].id) + 1, 0, l, grp);
    });
    renumber();
    show(i + 1);
    toast("The next frame holds only the pieces picked - go on drawing there", { ms: 2600 });
  }

  function setHold(i, n) {
    const f = frames()[i];
    if (!f) return;
    const before = ed.layerSnapshot();
    f.hold = n > 1 ? n : undefined;
    if (!f.hold) delete f.hold;
    ed.pushMeta("Frame hold", before);
    paint();
  }
  function reverseFrames() {
    const fs = frames();
    if (fs.length < 2) return;
    const before = ed.layerSnapshot();
    // each frame's block (the group and what is inside) put back in the other order, in the same places
    const blocks = fs.map((f) => [...D.descendants(doc.layers, f.id), f]);
    const at = fs.map((f) => D.layerIndex(doc, D.descendants(doc.layers, f.id)[0]?.id || f.id));
    const rest = doc.layers.filter((l) => !blocks.some((b) => b.includes(l)));
    const firstAt = Math.min(...at);
    const lead = doc.layers.slice(0, firstAt).filter((l) => rest.includes(l));
    const tail = rest.filter((l) => !lead.includes(l));
    doc.layers = D.normalizeLayers([...lead, ...blocks.reverse().flat(), ...tail]);
    renumber();
    ed.pushMeta("Reverse frames", before);
    show(frames().length - 1 - cur());
  }
  function insertBefore() {
    const fs = frames();
    const src = fs[cur()];
    if (!src || !ed.roomFor(2)) return;
    ed.structural("Add frame", () => {
      const g = D.newLayer({ kind: "group", name: "Frame", frame: true, collapsed: false, passThrough: false });
      const l = D.newLayer({ name: "Drawing", parent: g.id });
      engine.addLayerBitmap(l.id);
      const first = D.descendants(doc.layers, src.id)[0] || src;
      doc.layers.splice(D.layerIndex(doc, first.id), 0, l, g);
    });
    renumber();
    show(cur());
  }
  async function exportFrames() {
    const fs = frames();
    if (!fs.length) return;
    stop();
    const stem = (ed.path.startsWith("@guest/") ? `${app.workDir ? app.workDir("drawing") : "Workplace/Drawings"}/${ed.path.split("/").pop()}` : ed.path).replace(/\.(leostudio|leopaint)$/i, "");
    const name = stem.slice(stem.lastIndexOf("/") + 1);
    const dir = `${stem} frames`;
    const note = toast(`Saving ${fs.length} frames…`, { ms: 60000 });
    try {
      for (let i = 0; i < fs.length; i++) {
        const c = solo(i, 1, { background: true, shared: true });
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        const entry = await app.host.writeFile(`${dir}/${name} ${String(i + 1).padStart(3, "0")}.png`, new Uint8Array(await blob.arrayBuffer()));
        if (entry && entry.path) app.vault.setFiles([...[...app.vault.files.values()].filter((f) => f.path !== entry.path), entry]);
      }
      if (note) note();
      toast(`${fs.length} frames saved in ${dir.slice(dir.lastIndexOf("/") + 1)}`, { ms: 4000 });
    } catch (e) { if (note) note(); toast("Could not save the frames: " + (e && e.message ? e.message : e), { kind: "error" }); }
  }
  function moreMenu(anchor) {
    const a = conf();
    const redo = () => { ed.changed(); onion(); paintHead(); };
    menu(0, 0, [
      { header: "Onion skin" },
      ...[1, 2, 3].map((n) => ({ label: n === 1 ? "The frame either side" : `${n} frames either side`, checked: (a.onionReach || 1) === n, run: () => { a.onionReach = n; redo(); } })),
      ...[[0.15, "Faint"], [0.3, "Medium"], [0.5, "Strong"]].map(([v, name]) => ({ label: `${name} ghosts`, checked: (a.onionStrength ?? 0.3) === v, run: () => { a.onionStrength = v; redo(); } })),
      "sep",
      ...refMenuItems(redo),
      "sep",
      { header: "Playing" },
      { label: "Loop", checked: !a.pingpong, run: () => { a.pingpong = false; redo(); } },
      { label: "Ping-pong - forward, then back", checked: !!a.pingpong, run: () => { a.pingpong = true; redo(); } },
      "sep",
      { header: "Frames" },
      { label: "Blank frame before this one", icon: "plus", run: insertBefore },
      { label: "Reverse the order", icon: "swap", run: reverseFrames },
      { label: "New frame on N", checked: app.settings.animNewKey !== false, run: () => { app.setSetting("animNewKey", app.settings.animNewKey === false); } },
      { label: "In-betweens to the next frame…", icon: "layers", sub: [1, 2, 3, 5].map((n) => ({ label: `${n} frame${n === 1 ? "" : "s"}`, run: () => inBetween(n) })) },
      { label: "Hold this frame…", icon: "clock", sub: [1, 2, 3, 4, 6, 8].map((n) => ({ label: n === 1 ? "One beat (no hold)" : `${n} beats`, checked: (frames()[cur()]?.hold || 1) === n, run: () => setHold(cur(), n) })) },
      "sep",
      { header: "Saving" },
      { label: "Video at 1080 wide (Instagram)", checked: a.size !== "full", run: () => { a.size = "ig"; redo(); } },
      { label: `Video at full size (${doc.width} × ${doc.height})`, checked: a.size === "full", run: () => { a.size = "full"; redo(); } },
      { label: "Save every frame as a PNG", icon: "download", run: exportFrames },
      { label: "Save as a GIF", icon: "download", run: saveGif },
      { label: "GIF size…", icon: "settings", sub: [[320, "Small - 320"], [480, "480"], [640, "640"], [1080, "Big - 1080"]].map(([v, n]) => ({ label: n, checked: (a.gifSide || 640) === v, run: () => { a.gifSide = v; redo(); } })) },
    ], { anchor });
  }

  /** A new video project with this animation on it, linked - not a copy. */
  async function toVideo() {
    stop();
    await ed.save?.();
    const n = Math.max(1, frames().length);
    const fps = conf().fps || 12;
    const r = doc.width / doc.height;
    const format = r < 0.7 ? "reel" : r < 0.9 ? "post" : r < 1.2 ? "square" : "wide";
    const dur = Math.max(n / fps, Math.min(15, Math.max(3, (conf().minSec ?? 3))));
    const m = await import("./videoedit.js");
    m.newVideo(app, { name: ed.path.slice(ed.path.lastIndexOf("/") + 1).replace(/\.(leostudio|leopaint)$/i, ""), format, clips: [{ track: "v1", type: "studio", src: ed.path, dur, fit: "contain" }] });
  }

  /* ── the timeline ────────────────────────────────────────────────────── */

  const strip = h("div", { class: "pt-anim-strip" });
  // the rows: each layer a row, each frame a column - a character's arm, its body, the background
  const rowsEl = h("div", { class: "pt-anim-rows", hidden: true });
  const head = h("div", { class: "pt-anim-head" });
  panel.append(head, strip, rowsEl);

  function tick() {
    const c = head.querySelector(".pt-anim-count");
    if (c) c.textContent = `${cur() + 1} / ${frames().length}`;
    strip.querySelectorAll(".pt-anim-thumb").forEach((b, k) => b.classList.toggle("is-on", k === cur()));
  }
  function paintHead() {
    const fs = frames();
    const a = conf();
    const count = h("span", { class: "pt-anim-count", text: fs.length ? `${cur() + 1} / ${fs.length}` : "no frames" });
    head.replaceChildren(
      h("button", { class: "pt-icon", title: "Previous frame (,)", onclick: () => show(cur() - 1) }, icon("back")),
      h("button", { class: "pt-icon pt-anim-play" + (timer ? " is-on" : ""), title: timer ? "Stop (P)" : "Play (P)", onclick: play }, icon(timer ? "pause" : "play")),
      h("button", { class: "pt-icon", title: "Next frame (.)", onclick: () => show(cur() + 1) }, icon("forward")),
      count,
      h("span", { class: "pt-anim-sep" }),
      h("button", { class: "pt-anim-btn", title: "Frames a second", onclick: (e) => menu(0, 0, FPS.map((f) => ({ label: `${f} frames a second`, checked: (a.fps || 12) === f, run: () => { a.fps = f; ed.changed(); paintHead(); if (timer) { stop(); play(); } } })), { anchor: e.currentTarget }) }, `${a.fps || 12} fps`),
      h("button", { class: "pt-anim-btn" + (a.onion !== false ? " is-on" : ""), title: "Onion skin (O): the frame before (red) and after (green), faint", onclick: () => { a.onion = a.onion === false; ed.changed(); onion(); paintHead(); } }, "Onion"),
      h("span", { class: "pt-anim-sep" }),
      h("button", { class: "pt-icon", title: "New blank frame after this one", onclick: () => addFrame() }, icon("plus")),
      h("button", { class: "pt-icon", title: "Duplicate this frame and go on drawing on the copy (Ctrl+D) - with pieces picked, the new frame holds only them", onclick: () => duplicate({ only: engine.selection }) }, icon("layers")),
      h("button", { class: "pt-icon", title: "Delete this frame", onclick: () => deleteFrame() }, icon("trash")),
      h("button", { class: "pt-anim-btn" + (a.rows ? " is-on" : ""), title: "Rows: each layer a row and each frame a column - see what every part does across the frames, click a cell to draw there", onclick: () => { a.rows = !a.rows; ed.changed(); paintHead(); paintRows(); } }, "Rows"),
      h("button", { class: "pt-icon", title: "More: onion skin reach, ping-pong, holding a frame, reversing, video size, frames as PNGs", onclick: (e) => moreMenu(e.currentTarget) }, icon("more")),
      h("span", { class: "pt-anim-gap" }),
      // the length and the two ways out stay together: in a narrow window they go to a second row as one
      h("span", { class: "pt-anim-end" },
      h("button", { class: "pt-anim-btn", title: "At least this long: the loop repeats to fill it (Instagram wants 3 s or more)", onclick: (e) => menu(0, 0, [0, 3, 5, 10, 15].map((s) => ({ label: s ? `Loop to ${s} s at least` : "Play it once", checked: (a.minSec ?? 3) === s, run: () => { a.minSec = s; ed.changed(); paintHead(); } })), { anchor: e.currentTarget }) }, (a.minSec ?? 3) ? `≥ ${a.minSec ?? 3} s` : "once"),
      h("button", { class: "btn btn-sm", title: "Put this animation in a video project, with music, GIFs and captions around it. It stays linked: change the animation here and the video shows it", onclick: toVideo }, icon("film"), "Put in a video"),
      h("button", { class: "btn btn-sm btn-primary", title: "Save the animation as a video beside the drawing - MP4, ready for Instagram", onclick: saveVideo }, icon("download"), "Save video")));
  }

  const thumbs = new Map(); // frame id -> [canvas, when]
  function paintStrip() {
    const fs = frames();
    const k = Math.min(1, 72 / Math.max(doc.width, doc.height));
    strip.replaceChildren(...fs.map((f, i) => {
      const c = solo(i, k, { background: true, shared: true });
      c.className = "pt-anim-thumb-img";
      const b = h("button", { class: "pt-anim-thumb" + (i === cur() ? " is-on" : ""), dataset: { i: String(i) }, title: f.name, onclick: () => { stop(); show(i); },
        oncontextmenu: (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
          { header: f.name },
          { label: "Duplicate", icon: "layers", keys: "Ctrl D", run: () => { show(i); addFrame({ copy: true }); } },
          { label: "Blank frame after it", icon: "plus", run: () => { show(i); addFrame(); } },
          { label: "Hold it…", icon: "clock", sub: [1, 2, 3, 4, 6, 8].map((n) => ({ label: n === 1 ? "One beat (no hold)" : `${n} beats`, checked: (f.hold || 1) === n, run: () => setHold(i, n) })) },
          { label: "Edit it in Studio", icon: "brush", run: () => { show(i); ed.setWorkspace("draw"); } },
          { label: "Edit it in Filter", icon: "image", run: () => { show(i); ed.setWorkspace("studio"); } },
          "sep",
          { label: "Delete frame", icon: "trash", danger: true, run: () => deleteFrame(i) },
        ]); } }, c, h("span", { class: "pt-anim-n", text: String(i + 1) }), f.hold > 1 ? h("span", { class: "pt-anim-hold", text: `×${f.hold}` }) : null);
      return b;
    }), h("button", { class: "pt-anim-add", title: "New blank frame at the end", onclick: () => { show(frames().length - 1); addFrame(); } }, icon("plus")));
    thumbs.clear();
    const on2 = strip.querySelector(".is-on");
    if (on2) on2.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  sortable(strip, { item: ".pt-anim-thumb", axis: "x", onMove: (from, to) => moveFrame(from, to) });
  // a frame picked in the strip: Delete (or Backspace) asks, then deletes it; the arrows step along
  strip.addEventListener("keydown", async (e) => {
    const b = e.target.closest && e.target.closest(".pt-anim-thumb");
    if (!b || e.ctrlKey || e.metaKey || e.altKey) return;
    const i = Number(b.dataset.i);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); stop(); show(i + (e.key === "ArrowLeft" ? -1 : 1)); const on2 = strip.querySelector(".is-on"); if (on2) on2.focus(); return; }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    e.stopPropagation();
    if (frames().length < 2) { toast("An animation needs at least one frame", { ms: 2000 }); return; }
    if (!(await confirmDialog(`Delete frame ${i + 1}?`, "Its drawing goes with it. Ctrl+Z brings it back.", { ok: "Delete frame" }))) return;
    deleteFrame(i);
    const on2 = strip.querySelector(".is-on");
    if (on2) on2.focus();
  });

  /* The rows view: a frame's layers matched by name across the frames (the "Arm" of every frame on one
     row), layers outside the frames on rows of their own (shown in every frame). A cell is that layer in
     that frame, small; a click goes there and picks the layer to draw on; an empty cell makes the layer. */
  function paintRows() {
    rowsEl.hidden = !conf().rows;
    if (rowsEl.hidden) return;
    const fs = frames();
    const kids = (f) => doc.layers.filter((l) => l.parent === f.id && D.hasPixels(l));
    const names = [];
    for (const f of fs) for (const l of kids(f)) if (!names.includes(l.name)) names.push(l.name);
    const shared = doc.layers.filter((l) => !l.parent && !(l.kind === "group" && l.frame) && D.hasPixels(l));
    const W = 46, k = W / Math.max(doc.width, doc.height);
    const thumb = (l) => {
      const bm = engine.layers.get(l.id);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(doc.width * k)); c.height = Math.max(1, Math.round(doc.height * k));
      if (bm) c.getContext("2d").drawImage(bm.canvas, 0, 0, c.width, c.height);
      c.className = "pt-anim-cellimg";
      return c;
    };
    const selId = ed.selectedId;
    const head = h("div", { class: "pt-anim-row is-head" }, h("span", { class: "pt-anim-rowname" }), ...fs.map((f, i) => h("button", { class: "pt-anim-colhead" + (i === cur() ? " is-on" : ""), onclick: () => { stop(); show(i); paintRows(); } }, String(i + 1))));
    const rows = names.map((name) => h("div", { class: "pt-anim-row" }, h("span", { class: "pt-anim-rowname", text: name, title: name }),
      ...fs.map((f, i) => {
        const l = kids(f).find((x) => x.name === name);
        return h("button", { class: "pt-anim-cell" + (l ? "" : " is-empty") + (i === cur() ? " is-cur" : "") + (l && l.id === selId ? " is-sel" : ""), title: l ? `${name} in frame ${i + 1}` : `Make “${name}” in frame ${i + 1}`,
          onclick: () => {
            stop();
            show(i);
            if (l) { ed.select(l.id); paintRows(); return; }
            if (!ed.roomFor(1)) return;
            ed.structural(`Add “${name}”`, () => {
              const nl = D.newLayer({ name, parent: f.id });
              engine.addLayerBitmap(nl.id);
              doc.layers.splice(D.layerIndex(doc, f.id), 0, nl);
            });
            const made = kids(f).find((x) => x.name === name);
            if (made) ed.select(made.id);
            paintRows();
          } }, l ? thumb(l) : icon("plus"));
      })));
    const sharedRows = shared.map((l) => h("div", { class: "pt-anim-row is-shared" }, h("span", { class: "pt-anim-rowname", text: l.name, title: `${l.name} - outside the frames, shown in every one` }),
      h("button", { class: "pt-anim-cell is-span" + (l.id === selId ? " is-sel" : ""), title: "In every frame - click to draw on it", onclick: () => { ed.select(l.id); paintRows(); } }, thumb(l), h("span", { class: "pt-anim-spanlab", text: "every frame" }))));
    rowsEl.replaceChildren(head, ...rows, ...sharedRows);
    const c0 = rowsEl.querySelector(".pt-anim-colhead.is-on");
    if (c0) c0.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function paint() {
    panel.hidden = !on();
    if (panel.hidden) return;
    paintHead();
    if (!timer) { paintStrip(); paintRows(); }
  }

  // thumbnails and the onion catch up with what was just drawn
  let soon = 0;
  const refresh = () => { clearTimeout(soon); soon = setTimeout(() => { if (!destroyed && on() && !timer) { onion(); paintStrip(); paintRows(); } }, 350); };
  root.addEventListener("pointerup", refresh);

  root.addEventListener("keydown", (e) => {
    if (!on() || e.target.closest("input, textarea, [contenteditable]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ",") { e.preventDefault(); stop(); show(cur() - 1); }
    else if (e.key === ".") { e.preventDefault(); stop(); show(cur() + 1); }
    else if ((e.key === "p" || e.key === "P") && !e.repeat && hasFrames()) { e.preventDefault(); e.stopPropagation(); play(); }
    else if ((e.key === "o" || e.key === "O") && hasFrames()) { e.preventDefault(); e.stopPropagation(); const a = conf(); a.onion = a.onion === false; onion(); paintHead(); }
  }, true);

  // what a document that already has frames looks like on opening: one frame up
  if (hasFrames()) show(cur(), { quiet: true });

  return {
    /** Going into Animate: a drawing with no frames yet gets its first one. */
    enter() {
      if (!hasFrames()) { makeFrames(); toast("Frame 1 holds your drawing. Ctrl+D duplicates it into the next frame; N makes a blank one.", { ms: 4200 }); }
      show(cur());
    },
    leave() { stop(); ed.setOnion(null); ed.setUnder(null); paint(); },
    render: paint,
    duplicate,
    blank: () => addFrame(),
    /** What the frame on screen shows, its layers together, at full size and see-through. */
    frameImage: () => solo(cur(), 1),
    /** The frame on screen moved one place earlier or later. */
    shift: (d) => { const i = cur(), j = i + d; if (j < 0 || j >= frames().length) return; moveFrame(i, j); show(j); },
    get hasFrames() { return hasFrames(); },
    destroy() { destroyed = true; stop(); clearTimeout(soon); if (refVid) { refVid.removeAttribute("src"); refVid = null; } },
  };
}

/**
 * Every frame of a .leostudio as canvases no bigger than `maxSide` (a drawing
 * with no frames gives its one picture): how the video editor shows an
 * animation it links to. Read fresh from the file each time it is asked.
 */
export async function renderStudio(app, path, maxSide = 1080) {
  const store = await import("./paintstore.js");
  const { doc, engine } = await store.openDoc(app, path);
  try {
    const fs = doc.layers.filter((l) => l.kind === "group" && l.frame);
    const k = Math.min(1, maxSide / Math.max(doc.width, doc.height));
    const shot = () => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(doc.width * k));
      c.height = Math.max(1, Math.round(doc.height * k));
      engine.allDirty = true;
      engine.compositeInto(c.getContext("2d"), 0, 0, doc.width, doc.height, k, { background: true });
      return c;
    };
    const frames = [];
    if (!fs.length) frames.push(shot());
    else for (let i = 0; i < fs.length; i++) { fs.forEach((f, j) => { f.visible = j === i; }); frames.push(shot()); }
    const order = fs.length ? frameSequence(fs, doc.anim || {}) : [0];
    return { frames: order.map((i) => frames[i]), fps: (doc.anim && doc.anim.fps) || 12, w: frames[0].width, h: frames[0].height };
  } finally {
    engine.destroy();
  }
}
