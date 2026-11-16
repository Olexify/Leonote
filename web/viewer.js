// The picture and video viewer (viewer.html): one file at a time, the folder's other pictures and videos a key
// away in the order Explorer shows them. Its own window, borderless: drag anywhere to move it, edges resize.
// A plain script, not a module: the app's page allows no inline script (tauri.conf.json's policy).
(() => {
  const T = window.__TAURI__;
  const $ = (id) => document.getElementById(id);
  const win = T.window.getCurrentWindow();
  const invoke = (cmd, args) => T.core.invoke(cmd, args);
  const pic = $("pic"), vid = $("vid"), stage = $("stage");
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  };
  const VIDEO = /\.(mp4|webm|mkv|mov|m4v|ogv)$/i;
  const nameOf = (p) => p.split(/[\\/]/).pop();
  const srcOf = (p) => (/\.(heic|heif)$/i.test(p) ? T.core.convertFileSrc("", "heic") + "?p=" + encodeURIComponent(p) : T.core.convertFileSrc(p));
  // Explorer's own order: names compared as Windows does, numbers as numbers (Ep 2 before Ep 10)
  const order = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  let list = [], at = 0, cur = "";

  /* ── showing one file ── */
  let z = 1, fitZ = 1, x = 0, y = 0, rot = 0, fitted = true;
  const note = (title, text) => {
    clearNote();
    const n = document.createElement("div");
    n.className = "note"; n.id = "note";
    const box = document.createElement("div");
    const b = document.createElement("b"); b.textContent = title;
    const t = document.createElement("div"); t.textContent = text;
    const show = document.createElement("button"); show.textContent = "Show in Explorer";
    show.onclick = () => invoke("external_reveal", { path: cur }).catch(() => {});
    box.append(b, t, show); n.append(box); stage.append(n);
  };
  const clearNote = () => { const n = $("note"); if (n) n.remove(); };
  async function show(path) {
    cur = path;
    clearNote();
    $("name").textContent = nameOf(path);
    $("count").textContent = list.length > 1 ? `${at + 1} / ${list.length}` : "";
    win.setTitle(nameOf(path)).catch(() => {});
    await invoke("external_allow", { path }).catch(() => {});
    if (cur !== path) return;
    const video = VIDEO.test(path);
    $("bottom").hidden = !video;
    $("rot").hidden = $("fit").hidden = video;
    if (video) {
      pic.hidden = true; pic.removeAttribute("src");
      vid.hidden = false; vid.loop = loopOn; vid.src = srcOf(path); vid.play().catch(() => {});
    } else {
      vid.pause(); vid.hidden = true; vid.removeAttribute("src"); vid.load();
      pic.hidden = false; rot = 0; fitted = true; pic.src = srcOf(path);
    }
  }
  pic.addEventListener("load", () => { if (fitted) fit(); else place(); });
  pic.addEventListener("error", () => { if (pic.getAttribute("src")) note("This picture can't be shown here", nameOf(cur)); });
  vid.addEventListener("error", () => { if (vid.getAttribute("src")) note("Leonote can't play this video", "Its format isn't one the built-in player knows. Open it with another player."); });

  /* ── pictures: fit, actual size, zoom at the pointer, pan, turn ── */
  const turned = () => rot % 180 !== 0;
  const natural = () => (turned() ? [pic.naturalHeight, pic.naturalWidth] : [pic.naturalWidth, pic.naturalHeight]);
  function place() {
    const [w, h] = natural();
    // keep the picture on screen: centred when smaller than the window, edges held when larger
    const W = innerWidth, H = innerHeight;
    x = w * z <= W ? (W - w * z) / 2 : Math.min(0, Math.max(W - w * z, x));
    y = h * z <= H ? (H - h * z) / 2 : Math.min(0, Math.max(H - h * z, y));
    // turned about its own middle: the box the turned picture fills starts at x, y
    const dx = turned() ? (pic.naturalHeight - pic.naturalWidth) / 2 : 0, dy = turned() ? (pic.naturalWidth - pic.naturalHeight) / 2 : 0;
    pic.style.transform = `translate(${x + dx * z}px, ${y + dy * z}px) scale(${z}) rotate(${rot}deg)`;
    pic.style.transformOrigin = `${pic.naturalWidth / 2}px ${pic.naturalHeight / 2}px`;
    pic.style.left = pic.style.top = "0";
    stage.classList.toggle("can-pan", w * z > W || h * z > H);
  }
  function fit() {
    const [w, h] = natural();
    if (!w || !h) return;
    // smaller pictures stay their size; bigger ones fit the window
    fitZ = Math.min(1, innerWidth / w, innerHeight / h);
    z = fitZ; fitted = true; place();
  }
  let zoomT = 0;
  function zoomTo(nz, cx = innerWidth / 2, cy = innerHeight / 2) {
    nz = Math.max(Math.min(fitZ, 0.05), Math.min(32, nz));
    x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z);
    z = nz; fitted = Math.abs(z - fitZ) < 1e-3; place();
    const zl = $("zoom"); zl.textContent = Math.round(z * 100) + "%"; zl.classList.add("on");
    clearTimeout(zoomT); zoomT = setTimeout(() => zl.classList.remove("on"), 900);
  }
  addEventListener("resize", () => { if (pic.hidden) return; if (fitted) fit(); else place(); });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!pic.hidden) zoomTo(z * Math.exp(-(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * 0.0015), e.clientX, e.clientY);
    else if (!vid.hidden) setVol(vid.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: false });
  $("rot").onclick = () => { rot = (rot + 90) % 360; fit(); };
  $("fit").onclick = () => (fitted ? zoomTo(1) : fit());

  /* ── moving: drag pans a picture bigger than the window, else moves the window; a click pauses a video ── */
  let down = null;
  stage.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".note")) return;
    const pan = !pic.hidden && stage.classList.contains("can-pan");
    down = { x: e.clientX, y: e.clientY, ox: x, oy: y, pan, moved: false };
    if (pan) stage.classList.add("is-panning");
  });
  addEventListener("mousemove", (e) => {
    wake();
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 4) return;
    down.moved = true;
    if (down.pan) { x = down.ox + dx; y = down.oy + dy; place(); }
    else { down = null; win.startDragging().catch(() => {}); }
  });
  addEventListener("mouseup", () => {
    if (down && !down.moved && !vid.hidden) togglePlay();
    down = null; stage.classList.remove("is-panning");
  });
  stage.addEventListener("dblclick", () => toggleFull());
  $("top").addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest("button")) win.startDragging().catch(() => {}); });
  $("top").addEventListener("dblclick", (e) => { if (!e.target.closest("button")) win.toggleMaximize().catch(() => {}); });

  /* ── video ── */
  let loopOn = false;
  try { loopOn = localStorage.getItem("leonote.viewer.loop") === "1"; } catch {}
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
  const paintTime = () => {
    const d = vid.duration || 0;
    $("fill").style.width = (d ? (vid.currentTime / d) * 100 : 0) + "%";
    $("time").textContent = `${fmt(vid.currentTime)} / ${d && isFinite(d) ? fmt(d) : "--:--"}`;
  };
  const paintPlay = () => { $("play").innerHTML = vid.paused ? ICON.play : ICON.pause; };
  const paintSound = () => { $("mute").innerHTML = vid.muted || vid.volume === 0 ? ICON.muted : ICON.sound; $("vol").value = String(vid.muted ? 0 : vid.volume); };
  function togglePlay() { if (vid.paused) vid.play().catch(() => {}); else vid.pause(); }
  function setVol(v) { vid.volume = Math.max(0, Math.min(1, v)); vid.muted = vid.volume === 0; try { localStorage.setItem("leonote.viewer.vol", String(vid.volume)); } catch {} paintSound(); }
  try { const v = Number(localStorage.getItem("leonote.viewer.vol")); if (v >= 0 && v <= 1 && localStorage.getItem("leonote.viewer.vol") != null) vid.volume = v; } catch {}
  for (const ev of ["timeupdate", "durationchange", "seeked"]) vid.addEventListener(ev, paintTime);
  for (const ev of ["play", "pause"]) vid.addEventListener(ev, paintPlay);
  vid.addEventListener("volumechange", paintSound);
  $("play").onclick = togglePlay;
  $("mute").onclick = () => { vid.muted = !vid.muted; };
  $("vol").oninput = (e) => setVol(Number(e.target.value));
  const paintLoop = () => $("loop").classList.toggle("is-on", loopOn);
  $("loop").onclick = () => { loopOn = !loopOn; vid.loop = loopOn; try { localStorage.setItem("leonote.viewer.loop", loopOn ? "1" : "0"); } catch {} paintLoop(); };
  const seek = $("seek");
  const seekAt = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (vid.duration || 0); };
  let seeking = false;
  seek.addEventListener("pointerdown", (e) => { if (!vid.duration) return; seeking = true; seek.setPointerCapture(e.pointerId); vid.currentTime = seekAt(e); });
  seek.addEventListener("pointermove", (e) => { if (seeking) vid.currentTime = seekAt(e); });
  for (const ev of ["pointerup", "pointercancel"]) seek.addEventListener(ev, () => { seeking = false; });
  paintPlay(); paintSound(); paintLoop();

  /* ── the folder: next and previous, hold to run through it ── */
  function go(by) {
    if (list.length < 2) return;
    at = (at + by + list.length) % list.length;
    show(list[at]);
  }
  async function loadFolder(path) {
    list = [path]; at = 0;
    try {
      const all = await invoke("viewer_siblings", { path });
      if (cur !== path) return;
      list = all.sort((a, b) => order.compare(nameOf(a), nameOf(b)));
      at = Math.max(0, list.findIndex((p) => p.toLowerCase() === path.toLowerCase()));
      $("count").textContent = list.length > 1 ? `${at + 1} / ${list.length}` : "";
    } catch {}
  }
  async function open(path) { await show(path); await loadFolder(path); }

  /* ── to the Recycle Bin, asked first ── */
  let asking = null;
  function askTrash() {
    if (asking || !cur) return;
    asking = document.createElement("div");
    asking.className = "ask";
    const p = document.createElement("p"); p.textContent = `Move “${nameOf(cur)}” to the Recycle Bin?`;
    const s = document.createElement("small"); s.textContent = "Enter: yes · Esc: no";
    asking.append(p, s); document.body.append(asking);
    if (!vid.hidden) vid.pause();
  }
  async function answer(yes) {
    if (!asking) return;
    asking.remove(); asking = null;
    if (!yes) return;
    const gone = cur;
    try { await invoke("viewer_trash", { path: gone }); } catch (e) { note("Could not move it to the Recycle Bin", String(e)); return; }
    list = list.filter((p) => p !== gone);
    if (!list.length) return win.close();
    at = Math.min(at, list.length - 1);
    show(list[at]);
  }
  $("del").onclick = askTrash;

  /* ── window ── */
  async function toggleFull() { const f = await win.isFullscreen().catch(() => false); win.setFullscreen(!f).catch(() => {}); }
  $("full").onclick = toggleFull;
  $("min").onclick = () => win.minimize().catch(() => {});
  $("max").onclick = () => win.toggleMaximize().catch(() => {});
  $("close").onclick = () => win.close().catch(() => {});
  // the bars step aside while nothing moves (a picture or a video in full view), back with the pointer
  let idleT = 0;
  function wake() { document.body.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(() => { if (!document.querySelector(".bar:hover")) document.body.classList.add("idle"); }, 2200); }
  wake();

  addEventListener("keydown", async (e) => {
    if (asking) { if (e.key === "Enter") answer(true); else if (e.key === "Escape") answer(false); e.preventDefault(); return; }
    const k = e.key;
    if (k === "Escape") { if (await win.isFullscreen().catch(() => false)) win.setFullscreen(false).catch(() => {}); else win.close().catch(() => {}); }
    else if (k === "ArrowDown" || k === "PageDown" || (k === "ArrowRight" && vid.hidden)) go(1);
    else if (k === "ArrowUp" || k === "PageUp" || (k === "ArrowLeft" && vid.hidden)) go(-1);
    else if (k === "ArrowRight") vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + (e.shiftKey ? 30 : 5));
    else if (k === "ArrowLeft") vid.currentTime = Math.max(0, vid.currentTime - (e.shiftKey ? 30 : 5));
    else if (k === "Home") { at = -1; go(1); }
    else if (k === "End") { at = list.length; go(-1); }
    else if (k === " ") { if (!vid.hidden) togglePlay(); else go(1); }
    else if (k === "f" || k === "F" || k === "Enter") toggleFull();
    else if (k === "Delete") askTrash();
    else if (k === "r" || k === "R") { if (!pic.hidden) $("rot").click(); }
    else if (k === "0") { if (!pic.hidden) fit(); }
    else if (k === "1") { if (!pic.hidden) zoomTo(1); }
    else if (k === "+" || k === "=") { if (!pic.hidden) zoomTo(z * 1.25); else setVol(vid.volume + 0.05); }
    else if (k === "-") { if (!pic.hidden) zoomTo(z / 1.25); else setVol(vid.volume - 0.05); }
    else if (k === "l" || k === "L") $("loop").click();
    else if (k === "m" || k === "M") vid.muted = !vid.muted;
    else return;
    e.preventDefault();
    wake();
  });

  // the one viewer window takes the next file handed to Leonote
  T.event.listen("viewer:open", (e) => { if (e.payload) open(String(e.payload)); });
  invoke("viewer_start").then((p) => { if (p) open(p); else win.close(); });
})();
