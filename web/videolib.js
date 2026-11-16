// The video editor's library, on the left of the preview: the reusable media
// in <Videos>/VideoMedia (Video, Audio, GIFs, Images, Animations - one folder
// each), the project's own media pool, or every media file in the vault.
// Using something from here never copies it: the project points at the file,
// so a sound used in fifty videos is on the disk once.
import { h } from "./util.js";
import { icon } from "./icons.js";
import { srcUrl } from "./media.js";

/* Music free to use in a video: where to look (they open in a tab here; a downloaded song dropped on the
   timeline or the library comes in). */
const FREE_MUSIC = [
  ["YouTube Audio Library", "https://studio.youtube.com/channel/UC/music", "Free for YouTube videos"],
  ["Pixabay Music", "https://pixabay.com/music/", "No attribution needed"],
  ["Free Music Archive", "https://freemusicarchive.org/", "Check each song's licence"],
  ["Uppbeat", "https://uppbeat.io/", "Free for creators, credit asked"],
  ["Mixkit", "https://mixkit.co/free-stock-music/", "Free, no sign-up"],
  ["Incompetech", "https://incompetech.com/music/royalty-free/", "Kevin MacLeod, credit asked"],
];
const SONG = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i;

export const REUSE_DIRS = [["Video", /\.(mp4|webm|mov|m4v|mkv)$/i], ["Audio", /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i], ["GIFs", /\.gif$/i], ["Images", /\.(png|jpe?g|webp|bmp|avif|svg)$/i], ["Animations", /\.leostudio$/i]];
export const reuseRoot = (app) => `${app.workDir ? app.workDir("video") : "Workplace/Videos"}/VideoMedia`;
/** The reusable folder a file of this name belongs in, by its kind. */
export const reuseDirFor = (app, name) => { const d = REUSE_DIRS.find(([, re]) => re.test(name)); return d ? `${reuseRoot(app)}/${d[0]}` : null; };
/** A vault file with this name and size, wherever it is: a file dropped from Explorer that is in the vault already is used, not copied again. */
export function sameInVault(app, name, size) {
  const n = String(name).toLowerCase();
  return [...app.vault.files.values()].find((f) => f.size === size && (f.path.toLowerCase() === n || f.path.toLowerCase().endsWith("/" + n))) || null;
}

/**
 * The panel. `kindOf(path)`, `mediaRe`, `poolDir()` (the project's own media
 * folder), `onAdd(path)` (put it on the timeline), `importInto(file, dir)`
 * (a file from outside the vault copied into a folder; resolves to its path).
 */
export function mountLibrary(app, { kindOf, mediaRe, poolDir, onAdd, importInto, onFold, onPreview }) {
  // the vault's own media first: that is where things are before anything is set aside as reusable
  let tab = ["reuse", "project", "vault", "music"].includes(app.settings.veLibTab) ? app.settings.veLibTab : "vault";
  let cat = "";
  let q = "";
  const root = reuseRoot(app);
  const find = h("input", { class: "input ve-lib-find", placeholder: "Find…", spellcheck: false });
  find.addEventListener("input", () => { q = find.value.trim().toLowerCase(); paintList(); });
  find.addEventListener("keydown", (e) => e.stopPropagation());
  const tabs = h("div", { class: "segmented is-small ve-lib-tabs" });
  const chips = h("div", { class: "ve-lib-chips" });
  const list = h("div", { class: "ve-lib-list" });
  const foot = h("div", { class: "ve-lib-foot" });
  const fold = h("button", { class: "icon-btn ve-lib-fold", title: "Fold the library away (the Library button brings it back)", onclick: () => onFold && onFold() }, icon("sidebar"));

  /* The preview: a click on a song or a video plays it here, nothing goes on the timeline. Start and End
     (I, O) mark a piece of it; Add puts the piece (or all of it, nothing marked) at the playhead. */
  let pv = null; // { key, name }
  let mark = [null, null];
  const pvMedia = h("video", { class: "ve-pv-media", preload: "metadata", playsinline: true });
  const pvTitle = h("div", { class: "ve-pv-title" });
  const pvTime = h("span", { class: "ve-pv-time ve-dim" });
  const pvSeek = h("input", { type: "range", class: "ve-pv-seek", min: 0, max: 1, step: 0.01, value: 0 });
  const pvPiece = h("i", { class: "ve-pv-piece", hidden: true });
  // where the piece starts and ends, as ticks on the bar
  const pvMarkA = h("i", { class: "ve-pv-mark is-a", hidden: true, title: "The piece starts here" });
  const pvMarkB = h("i", { class: "ve-pv-mark is-b", hidden: true, title: "The piece ends here" });
  const pvStart = h("button", { class: "btn btn-sm", title: "The piece starts here (I)", onclick: () => setMark(0) }, "Start");
  const pvEnd = h("button", { class: "btn btn-sm", title: "The piece ends here (O)", onclick: () => setMark(1) }, "End");
  const pvClear = h("button", { class: "btn btn-sm", hidden: true, title: "No piece: Add puts all of it", onclick: () => { mark = [null, null]; paintPiece(); } }, icon("x"), "Clear marks");
  const pvPlay = h("button", { class: "icon-btn", title: "Play / pause (Space)", onclick: () => toggleTry() }, icon("play"));
  const mm = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
  const toggleTry = () => (pvMedia.paused ? pvMedia.play().catch(() => {}) : pvMedia.pause());
  const paintPiece = () => {
    const d = pvMedia.duration;
    pvStart.textContent = mark[0] != null ? `Start ${mm(mark[0])}` : "Start";
    pvEnd.textContent = mark[1] != null ? `End ${mm(mark[1])}` : "End";
    pvStart.classList.toggle("is-on", mark[0] != null);
    pvEnd.classList.toggle("is-on", mark[1] != null);
    pvClear.hidden = mark[0] == null && mark[1] == null;
    pvMarkA.hidden = !(d > 0) || mark[0] == null;
    pvMarkB.hidden = !(d > 0) || mark[1] == null;
    if (!pvMarkA.hidden) pvMarkA.style.left = `${(mark[0] / d) * 100}%`;
    if (!pvMarkB.hidden) pvMarkB.style.left = `${(mark[1] / d) * 100}%`;
    pvPiece.hidden = !(d > 0) || (mark[0] == null && mark[1] == null);
    if (pvPiece.hidden) return;
    const a = mark[0] ?? 0, b = mark[1] ?? d;
    Object.assign(pvPiece.style, { left: `${(a / d) * 100}%`, width: `${(Math.max(0, b - a) / d) * 100}%` });
    pvTime.textContent = `${mm(pvMedia.currentTime)} / ${mm(d)} · piece ${mm(a)}–${mm(b)}`;
  };
  const setMark = (i) => {
    mark[i] = pvMedia.currentTime;
    if (mark[0] != null && mark[1] != null && mark[1] < mark[0]) mark = [mark[1], mark[0]];
    paintPiece();
  };
  const stopPreview = () => { pvMedia.pause(); pvBox.hidden = true; pv = null; };
  function addPiece() {
    if (!pv) return;
    const d = pvMedia.duration;
    const piece = mark[0] != null || mark[1] != null ? { from: mark[0] ?? 0, to: mark[1] ?? d } : null;
    pvMedia.pause();
    useSong(pv.key, pv.name, piece && piece.to - piece.from > 0.05 ? piece : null);
  }
  const pvBox = h("div", { class: "ve-pv", hidden: true, tabindex: -1 },
    pvMedia, pvTitle, h("div", { class: "ve-pv-track" }, pvSeek, pvPiece, pvMarkA, pvMarkB),
    h("div", { class: "ve-pv-row" }, pvPlay, pvTime, h("span", { class: "ve-gap" }),
      pvStart, pvEnd, pvClear,
      h("button", { class: "btn btn-sm btn-primary", title: "Onto the timeline at the playhead: the piece marked, or all of it", onclick: addPiece }, icon("plus"), "Add"),
      h("button", { class: "icon-btn", title: "Close the preview", onclick: stopPreview }, icon("x"))));
  pvMedia.addEventListener("loadedmetadata", () => { pvSeek.max = String(pvMedia.duration || 1); paintPiece(); });
  pvMedia.addEventListener("timeupdate", () => { pvSeek.value = String(pvMedia.currentTime); if (pvPiece.hidden) pvTime.textContent = `${mm(pvMedia.currentTime)} / ${mm(pvMedia.duration)}`; else paintPiece(); });
  // one sound at a time: the preview playing pauses the timeline (and the timeline playing pauses this)
  pvMedia.addEventListener("play", () => { pvPlay.replaceChildren(icon("pause")); if (onPreview) onPreview(); });
  pvMedia.addEventListener("pause", () => pvPlay.replaceChildren(icon("play")));
  pvSeek.addEventListener("input", () => { pvMedia.currentTime = +pvSeek.value; });
  pvBox.addEventListener("keydown", (e) => {
    if (e.target.closest("input:not([type=range])")) return;
    if (e.code === "Space") { e.preventDefault(); toggleTry(); }
    else if (e.code === "KeyI") setMark(0);
    else if (e.code === "KeyO") setMark(1);
    else if (e.code === "Enter") addPiece();
    else if (e.code === "Escape") stopPreview();
    else return;
    e.stopPropagation();
  });
  function preview(key, name, video) {
    if (pv && pv.key === key) { toggleTry(); return; }
    pv = { key, name };
    mark = [null, null];
    pvMedia.classList.toggle("is-audio", !video);
    pvMedia.src = srcUrl(app, key);
    pvTitle.textContent = name.replace(SONG, "");
    pvBox.hidden = false;
    pvMedia.play().catch(() => {});
    pvBox.focus({ preventScroll: true });
    paintPiece();
  }
  const el = h("aside", { class: "ve-lib" }, tabs, chips, find, list, pvBox, foot);

  const all = () => [...app.vault.files.values()].filter((f) => mediaRe.test(f.path));
  const under = (dir) => all().filter((f) => f.path.startsWith(dir + "/"));
  const files = () => (tab === "reuse" ? under(cat ? `${root}/${cat}` : root) : tab === "project" ? under(poolDir()) : all().filter((f) => !cat || (REUSE_DIRS.find(([d]) => d === cat) || [, /./])[1].test(f.path)));
  const targetDir = (name) => (tab === "reuse" ? (cat ? `${root}/${cat}` : reuseDirFor(app, name) || `${root}/Images`) : tab === "project" ? poolDir() : reuseDirFor(app, name) || poolDir());

  function paintTabs() {
    tabs.replaceChildren(...[["reuse", "Reuse"], ["project", "Project"], ["vault", "Vault"], ["music", "Music"]].map(([id, name]) =>
      h("button", { class: "seg" + (tab === id ? " is-active" : ""), title: id === "reuse" ? `${root}: media every video can use` : id === "project" ? "This video's own: files that came in from outside the vault, beside this project" : id === "music" ? "The Player's songs, and where to find music free to use" : "Every media file in the vault", onclick: () => { tab = id; app.setSetting("veLibTab", id); paint(); } }, name)));
    chips.hidden = tab === "project" || tab === "music";
    chips.replaceChildren(h("button", { class: "ve-chip" + (cat ? "" : " is-on"), onclick: () => { cat = ""; paint(); } }, "All"),
      ...REUSE_DIRS.map(([d]) => h("button", { class: "ve-chip" + (cat === d ? " is-on" : ""), onclick: () => { cat = d; paint(); } }, d)));
  }
  /* Music: the Player's songs - in the vault, and in its libraries outside it (copied into the project's
     media the moment one is used) - and where to find more that is free to use. */
  /** A song as a vault path: as it is, or (from a library outside the vault) copied into the project's media. */
  async function songPath(key, name) {
    if (!key.startsWith("lib:")) return key;
    const blob = await (await fetch(srcUrl(app, key))).blob();
    return importInto(new File([blob], name, { type: blob.type }), null);
  }
  async function useSong(key, name, piece = null) {
    if (!key.startsWith("lib:")) return onAdd(key, piece);
    const close = app.toast(`Bringing ${name} in…`, { ms: 60000 });
    try {
      const blob = await (await fetch(srcUrl(app, key))).blob();
      const p = await importInto(new File([blob], name, { type: blob.type }), null);
      close();
      if (p) onAdd(p, piece);
    } catch (e) { close(); app.toast("Could not bring the song in: " + e, { kind: "error" }); }
  }
  /** The songs (and where to find more) into `box`, for the words `qq`; how many songs. */
  function musicInto(box, qq, after = () => {}) {
    const songs = [];
    for (const f of app.vault.files.values()) if (SONG.test(f.path)) songs.push({ key: f.path, name: f.path.slice(f.path.lastIndexOf("/") + 1) });
    if (app.media && app.media.libraries) for (const f of app.media.libraries.files().values()) {
      const p = String(f.path || "").slice(4);
      if (SONG.test(p)) songs.push({ key: f.path, name: p.slice(p.lastIndexOf("/") + 1), lib: true });
    }
    const hits = songs.filter((s) => !qq || s.name.toLowerCase().includes(qq)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300);
    box.classList.add("is-music");
    box.replaceChildren(...[
      ...hits.map((s) => h("div", { class: "ve-lib-item is-song", draggable: true, ondragstart: (e) => { e.dataTransfer.setData("application/x-leonote-song", JSON.stringify(s)); e.dataTransfer.effectAllowed = "copy"; }, title: `${s.name}${s.lib ? "\nFrom the Player's library - copied into this video's media when used" : ""}\n${box === list ? "Click: listen, and mark the piece you want. Double-click or drag: all of it onto the timeline" : "Click: onto the Music track at the playhead"}`,
          onclick: () => { if (box === list) preview(s.key, s.name, false); else { useSong(s.key, s.name); after(); } }, ondblclick: () => { if (box === list) { pvMedia.pause(); useSong(s.key, s.name); } } },
        h("span", { class: "ve-lib-thumb is-icon is-audio" }, icon("music")), h("span", { class: "ve-lib-name", text: s.name.replace(SONG, "") }))),
      hits.length ? null : h("div", { class: "ve-lib-none", text: qq ? "No song like that" : "No songs yet - the Player's Music is empty." }),
      h("div", { class: "ve-lib-free" }, h("div", { class: "fp-label", text: "Free to use in videos" }),
        h("div", { class: "ve-dim", text: "Check each site's current licence before you publish." }),
        ...FREE_MUSIC.map(([name, url, note]) => h("button", { class: "ve-free", title: url, onclick: () => (app.newWebTab ? app.newWebTab(url, { background: false }) : app.openUrl(url)) }, icon("globe"), h("b", { text: name }), h("span", { text: note })))),
    ].filter(Boolean));
    return hits.length;
  }
  function paintMusic() {
    const n = musicInto(list, q);
    foot.replaceChildren(fold, h("span", { class: "ve-dim", text: `${n} song${n === 1 ? "" : "s"}` }));
  }
  /** The same, in a popover by `anchor` (a sound track's button): find, click, it is on the timeline. */
  function musicPop(anchor) {
    document.querySelector(".folder-pop.ve-music-pop")?.remove();
    const box = h("div", { class: "ve-lib-list ve-music-list" });
    const f = h("input", { class: "input ve-lib-find", placeholder: "Find a song…", spellcheck: false });
    const pop = h("div", { class: "folder-pop ve-music-pop" }, h("div", { class: "fp-label", text: "Music" }), f, box);
    const close = () => { pop.remove(); document.removeEventListener("mousedown", off, true); };
    const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
    f.addEventListener("input", () => musicInto(box, f.value.trim().toLowerCase(), close));
    f.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });
    musicInto(box, "", close);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - 330, r.left)) + "px";
    pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + "px";
    f.focus();
    setTimeout(() => document.addEventListener("mousedown", off, true));
  }
  function paintList() {
    list.classList.remove("is-music");
    if (tab === "music") return paintMusic();
    const fs = files().filter((f) => !q || f.path.toLowerCase().includes(q)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 400);
    list.replaceChildren(...fs.map((f) => {
      const k = kindOf(f.path);
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      const thumb = k === "image" || k === "gif" ? h("img", { class: "ve-lib-thumb", src: app.host.assetUrl(f.path), loading: "lazy", alt: "", draggable: false })
        : h("span", { class: "ve-lib-thumb is-icon is-" + k }, icon(k === "video" ? "film" : k === "audio" ? "music" : k === "studio" ? "brush" : "image"));
      const plays = k === "video" || k === "audio";
      const it = h("div", { class: "ve-lib-item", draggable: true, title: `${f.path}\n${plays ? "Click: play it here, and mark the piece you want. Double-click: all of it at the playhead." : "Click: at the playhead."} Drag it onto the timeline where it should go.`,
        onclick: () => (plays ? preview(f.path, name, k === "video") : onAdd(f.path)),
        ondblclick: () => { if (plays) { pvMedia.pause(); onAdd(f.path); } },
        oncontextmenu: (e) => { e.preventDefault(); app.menu(e.clientX, e.clientY, [
          { label: "Put it at the playhead", icon: "plus", run: () => onAdd(f.path) },
          { label: "Open it", icon: "expand", run: () => app.openFile(f.path, { newTab: true }) },
          "sep",
          { label: "Show in the file tree", icon: "folder", run: () => app.revealInTree(f.path) },
          { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(f.path) },
          { label: "Copy its path", icon: "clipboard", run: () => navigator.clipboard.writeText(f.path) },
        ]); } }, thumb, h("span", { class: "ve-lib-name", text: name }));
      it.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-leonote-paths", JSON.stringify([f.path])); e.dataTransfer.effectAllowed = "copy"; });
      return it;
    }));
    if (!fs.length) list.append(h("div", { class: "ve-lib-none", text: q ? "Nothing like that here" : tab === "reuse" ? `Nothing here yet. Drop files onto this panel - they go into ${cat ? `${root}/${cat}` : root + " (a folder by kind)"} - and every video can use them without a copy.` : tab === "project" ? "Files dropped from outside the vault land here, beside the project." : "No media in the vault yet." }));
    foot.replaceChildren(
      fold,
      h("span", { class: "ve-dim", text: `${fs.length} file${fs.length === 1 ? "" : "s"}` }),
      h("span", { class: "ve-gap" }),
      tab === "reuse" ? h("button", { class: "link-btn", title: root, onclick: () => app.reveal(cat ? `${root}/${cat}` : root) }, "Open the folder") : null);
  }
  function paint() { paintTabs(); paintList(); }
  // the list's empty space: the folder it shows
  list.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".ve-lib-item")) return;
    e.preventDefault();
    const dir = tab === "reuse" ? (cat ? `${root}/${cat}` : root) : tab === "project" ? poolDir() : "";
    app.menu(e.clientX, e.clientY, [
      dir ? { label: "Show the folder in the file tree", icon: "folder", run: () => app.revealInTree(dir) } : null,
      { label: "Show the folder in Explorer", icon: "reveal", run: () => app.reveal(dir || ".") },
      "sep",
      ...[["reuse", "Reusable"], ["project", "This video"], ["vault", "Vault"]].map(([id, name]) => ({ label: name, checked: tab === id, run: () => { tab = id; app.setSetting("veLibTab", id); paint(); } })),
    ].filter(Boolean));
  });

  // files from outside the vault dropped on the panel: copied in, into the folder that fits
  el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); el.classList.add("is-drop"); } });
  el.addEventListener("dragleave", () => el.classList.remove("is-drop"));
  el.addEventListener("drop", async (e) => {
    el.classList.remove("is-drop");
    const fs = [...(e.dataTransfer.files || [])];
    if (!fs.length) return;
    e.preventDefault();
    let n = 0;
    for (const f of fs) { try { if (await importInto(f, targetDir(f.name))) n++; } catch (err) { app.toast("Could not add the file: " + err, { kind: "error" }); } }
    if (n) app.toast(`${n} added to ${tab === "project" ? "this video's media" : "the reusable media"}`, { ms: 2500 });
    paintList();
  });
  const off = app.vault.bus.on("structure", () => paintList());
  paint();
  return { el, paint, musicPop, songPath, stopPreview, pausePreview: () => pvMedia.pause(), destroy: () => { stopPreview(); pvMedia.removeAttribute("src"); if (typeof off === "function") off(); } };
}
