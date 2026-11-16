// Phone: what is on a phone plugged in by USB, quick to look through and to
// clear out - its photos and videos in a grid with the phone's own
// thumbnails, the biggest first when space is short, and a few clicks to
// move them to this computer (copied whole, then taken off the phone) or
// delete them there. The listing comes in as it is read, so a folder of
// thousands of photos shows its first ones at once (phone.rs).
import { h, pressable } from "./util.js";
import { icon } from "./icons.js";
import { confirmDialog, menu, foldSections } from "./ui.js";

const PHOTO = /\.(jpe?g|png|heic|heif|webp|gif|dng|bmp)$/i;
const VIDEO = /\.(mp4|mov|3gp|mkv|webm|m4v)$/i;
// what Search can narrow to, by the file's ending
const KINDS = [
  ["photo", "Photos", PHOTO], ["video", "Videos", VIDEO], ["audio", "Sound", /\.(mp3|m4a|aac|ogg|opus|wav|flac|amr|wma)$/i],
  ["doc", "Documents", /\.(pdf|docx?|xlsx?|pptx?|txt|md|odt|ods|csv|epub|rtf)$/i], ["app", "Apps", /\.(apk|xapk|apks)$/i],
  ["archive", "Archives", /\.(zip|rar|7z|tar|gz|tgz)$/i],
];
const kindName = (name) => (KINDS.find(([, , re]) => re.test(name)) || ["other"])[0];
const size = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + " GB" : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/** A name's family: its letters, each run of digits as its length (VID20261031121530.mp4 → "vid#14") - a camera's
   footage shares one. A name with under 6 digits (a meme's free text) has none: "". */
export const nameFamily = (name) => { const b = String(name).replace(/\.[^.]*$/, "").toLowerCase(); return (b.match(/\d/g) || []).length < 6 ? "" : b.replace(/\d+/g, (m) => "#" + m.length); };
/** A stable hue for a family, from a small hash. */
export const familyHue = (fam) => { let x = 0; for (const c of fam) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };
/** s under 10 MB, m up to 100 MB, l over. */
export const sizeClass = (n) => (n > 100 * 1048576 ? "l" : n >= 10 * 1048576 ? "m" : "s");
export const XFER_LABEL = { moving: "Moving…", copying: "Copying…", copied: "Copied", moved: "Moved", failed: "Failed" };
/** One `phone:copy` event onto the tiles' transfer tags (id → { state, to, why }). A file copied during a move stays
   "moving" until the end, when the phone deletes what was copied; what never came is "failed". */
export function xferApply(tags, d, remove) {
  const r = d.id && tags.get(d.id);
  if (r && d.to) Object.assign(r, { to: d.to, state: remove ? "moving" : "copied" });
  else if (r && d.why) Object.assign(r, { state: "failed", why: d.why });
  if (!d.finished) return;
  // `gone`: what the phone really deleted (a test backend without it: `copied`)
  const copied = new Set(d.copied || []), gone = new Set(remove ? d.gone || d.copied || [] : []);
  for (const [id, x] of tags) {
    if (x.state !== "moving" && x.state !== "copying") continue;
    if (gone.has(id)) Object.assign(x, { state: "moved", to: x.to || d.dir });
    else if (x.to || copied.has(id)) Object.assign(x, { state: "copied", to: x.to || d.dir }, remove ? { why: "copied, but still on the phone" } : null);
    else Object.assign(x, { state: "failed", why: x.why || d.error || "not copied" });
  }
}

export function mountPhone(app, el) {
  const S = app.settings;
  const host = app.host;
  let devices = [];
  let dev = null; // { id, name }
  let trail = []; // [{ id, name }] - the folders opened, from the top
  let items = [];
  let reading = false;
  let req = 0;
  let kind = S.phoneKind || "all"; // all | photo | video | other
  let sort = S.phoneSort || "date"; // date | size | name
  const sel = new Set();
  let anchor = null;
  let busy = null; // { job, done, total, failed, remove }
  let picking = !!S.phonePicking; // Select mode: a click picks instead of opening
  // the drawer at the bottom: Folders, or a view over the whole phone (after a scan), or Compress
  let mode = ["folders", "all", "search", "photos", "videos", "largest", "dupes", "compress"].includes(S.phoneMode) ? S.phoneMode : "folders";
  // Search: words in the name or the folder, kinds, size, dates, sorting - over the whole phone
  const F = { q: "", kinds: new Set(), min: "", max: "", from: "", to: "", sort: S.phoneFindSort || "new", list: !!S.phoneFindList };
  let index = null; // every file on the phone (a scan), for Photos, Videos, Largest and Duplicates
  let scanning = false, scanReq = 0, scanFolders = 0, scanTrouble = "", scanPainted = 0;
  // tiles drawn so far: a phone can hold thousands and 2000 take over a second to draw, so more come as the page nears the end
  const TILES = 300;
  let tileLimit = TILES;
  // this view's own settings (the ⚙ in its header): how much is read off the phone just to look
  const opt = () => ({
    thumbs: S.phoneThumbs !== false, tile: Number(S.phoneTile) || 150, full: !!S.phoneFullPhoto,
    // seconds of a video to preview: 0 off, -1 all of it (an old "on" is 15)
    video: S.phoneVideoPreview === true ? 15 : Number(S.phoneVideoPreview) || 0,
    vthumb: S.phoneVideoThumbs === "made" ? "made" : "phone", skip: S.phoneSkipSystem !== false,
  });
  const setOpt = (k, v) => { app.setSetting(k, v); applyOpt(); };
  const applyOpt = () => { grid.style.setProperty("--ph-tile", opt().tile + "px"); };
  let job = 0;

  const title = h("h1", { class: "vh-title", text: "Phone" });
  const sub = h("div", { class: "vh-sub" });
  const devRow = h("div", { class: "ph-devs" });
  const crumbs = h("div", { class: "ph-crumbs" });
  const bar = h("div", { class: "ph-bar" });
  const grid = h("div", { class: "ph-grid" });
  const note = h("div", { class: "ph-note" });
  const progress = h("div", { class: "ph-progress", hidden: true });
  const inner = h("div", { class: "view-inner ph-view", tabIndex: -1 },
    h("div", { class: "vh" }, h("div", {}, title, sub), h("div", { class: "ph-head-acts" },
      h("button", { class: "btn", title: "Look for phones again", onclick: () => findDevices() }, icon("rotateRight"), "Refresh"),
      h("button", { class: "icon-btn", title: "Phone settings: previews, tile size, what opening shows", onclick: (e) => settingsPop(e.currentTarget) }, icon("settings")))),
    devRow, crumbs, bar, note, grid);
  const findIn = h("input", { class: "ph-find-q", type: "search", placeholder: "Search the whole phone - names and folders (whatsapp, 2024, IMG_ screenshot…)", spellcheck: false });
  const finder = h("div", { class: "ph-finder", hidden: true });
  let findT = 0;
  findIn.addEventListener("input", () => { F.q = findIn.value; clearTimeout(findT); findT = setTimeout(() => { paintFinder(); paint(); }, 120); });
  findIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape" && findIn.value) { findIn.value = ""; F.q = ""; paintFinder(); paint(); } });
  const finderOpts = h("div", { class: "ph-find-opts" });
  finder.append(h("div", { class: "ph-find-row" }, icon("search"), findIn), finderOpts);
  grid.before(finder);
  function paintFinder() {
    const chip = (on, label, run, title) => h("button", { class: "ve-chip" + (on ? " is-on" : ""), title: title || "", onclick: run }, label);
    const num = (key, ph) => { const i = h("input", { class: "ph-find-n", type: "number", min: 0, step: 1, value: F[key], placeholder: ph }); i.addEventListener("input", () => { F[key] = i.value; clearTimeout(findT); findT = setTimeout(paint, 120); }); i.addEventListener("keydown", (e) => e.stopPropagation()); return i; };
    const date = (key) => { const i = h("input", { class: "ph-find-d", type: "date", value: F[key] }); i.addEventListener("change", () => { F[key] = i.value; paint(); }); return i; };
    const res = found();
    finderOpts.replaceChildren(
      h("div", { class: "ph-find-line" }, h("span", { class: "ph-find-lab", text: "Kind" }),
        chip(!F.kinds.size, "Everything", () => { F.kinds.clear(); paintFinder(); paint(); }),
        ...[...KINDS.map(([k, n]) => [k, n]), ["other", "Other"]].map(([k, n]) => chip(F.kinds.has(k), n, () => { F.kinds.has(k) ? F.kinds.delete(k) : F.kinds.add(k); paintFinder(); paint(); }, "Click to add or take away"))),
      h("div", { class: "ph-find-line" }, h("span", { class: "ph-find-lab", text: "Size, MB" }), num("min", "from"), h("span", { class: "ph-dim", text: "–" }), num("max", "to"),
        h("span", { class: "ph-find-lab", text: "Date" }), date("from"), h("span", { class: "ph-dim", text: "–" }), date("to"),
        (F.min || F.max || F.from || F.to || F.kinds.size || F.q) ? h("button", { class: "link-btn", onclick: () => { Object.assign(F, { q: "", min: "", max: "", from: "", to: "" }); F.kinds.clear(); findIn.value = ""; paintFinder(); paint(); } }, "Clear the search") : null),
      h("div", { class: "ph-find-line" }, h("span", { class: "ph-find-lab", text: "Sort" }),
        ...[["new", "Newest"], ["old", "Oldest"], ["big", "Biggest"], ["small", "Smallest"], ["name", "Name"], ["folder", "Folder"], ["kind", "Kind"]].map(([v, n]) => chip(F.sort === v, n, () => { F.sort = v; app.setSetting("phoneFindSort", v); paintFinder(); paint(); })),
        h("span", { class: "ph-gap" }),
        chip(!F.list, "Tiles", () => { F.list = false; app.setSetting("phoneFindList", false); paintFinder(); paint(); }),
        chip(F.list, "List", () => { F.list = true; app.setSetting("phoneFindList", true); paintFinder(); paint(); }),
        h("span", { class: "ph-count", text: index ? `${res.length.toLocaleString()} found · ${size(res.reduce((s, x) => s + x.size, 0))}` : "" })));
  }
  /** The whole phone, through the search's words and filters, sorted as asked. */
  // one redraw asks for it several times: the same search over the same index is worked out once
  let foundMemo = null;
  function found() {
    if (!index) return [];
    const key = [F.q, F.min, F.max, F.from, F.to, F.sort, [...F.kinds].sort().join(","), index.length].join("|");
    if (foundMemo && foundMemo.index === index && foundMemo.key === key) return foundMemo.list;
    const list = foundNow();
    foundMemo = { index, key, list };
    return list;
  }
  function foundNow() {
    const words = F.q.toLowerCase().split(/\s+/).filter(Boolean);
    const min = F.min !== "" ? Number(F.min) * 1048576 : -1, max = F.max !== "" ? Number(F.max) * 1048576 : Infinity;
    const from = F.from ? new Date(F.from + "T00:00").getTime() : -Infinity, to = F.to ? new Date(F.to + "T23:59:59").getTime() : Infinity;
    const out = index.filter((x) => {
      if (x.size < min || x.size > max || x.mtime < from || x.mtime > to) return false;
      if (F.kinds.size && !F.kinds.has(kindName(x.name))) return false;
      if (!words.length) return true;
      const hay = (x.name + " " + (x.path || "")).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const cmp = {
      new: (a, b) => b.mtime - a.mtime, old: (a, b) => a.mtime - b.mtime, big: (a, b) => b.size - a.size, small: (a, b) => a.size - b.size,
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      folder: (a, b) => (a.path || "").localeCompare(b.path || "") || a.name.localeCompare(b.name, undefined, { numeric: true }),
      kind: (a, b) => kindName(a.name).localeCompare(kindName(b.name)) || b.size - a.size,
    }[F.sort] || ((a, b) => b.mtime - a.mtime);
    return out.sort(cmp);
  }
  const panel = h("div", { class: "ph-panel", hidden: true });
  const drawer = h("nav", { class: "ph-drawer" });
  inner.append(panel, drawer);
  el.replaceChildren(inner);
  applyOpt();
  function settingsPop(anchor) {
    document.querySelector(".ph-set")?.remove();
    const o = opt();
    const seg = (key, now, opts) => h("div", { class: "segmented is-small" }, ...opts.map(([v, n]) => h("button", { class: "seg" + (now === v ? " is-active" : ""), onclick: async (e) => {
      const b0 = e.currentTarget;
      // made previews and frames need ffmpeg: offered here, once
      if ((key === "phoneVideoPreview" && v) || (key === "phoneVideoThumbs" && v === "made")) { const ff = await (await import("./tools.js")).ensureTool(app, "ffmpeg", "Video previews"); if (!ff) return; }
      setOpt(key, v); for (const b of b0.parentElement.children) b.classList.toggle("is-active", b === b0); if (key === "phoneThumbs" || key === "phoneVideoThumbs") paint();
    } }, n)));
    const row = (label, hint, ctl) => h("div", { class: "ph-set-row" }, h("div", {}, h("div", { class: "ph-set-lab", text: label }), hint ? h("div", { class: "ph-dim", text: hint }) : null), ctl);
    const range = h("input", { type: "range", min: 90, max: 280, step: 10, value: o.tile, oninput: (e) => setOpt("phoneTile", +e.target.value) });
    const pop = h("div", { class: "ph-set" },
      h("b", { text: "Phone" }),
      foldSections([{ title: "Pictures", icon: "image", open: true, body: [
      row("Thumbnails", "The phone's own tiny copies - a few KB each, only for what is in sight", seg("phoneThumbs", o.thumbs, [[true, "Tiny"], [false, "Off - names only"]])),
      row("Tile size", "", range),
      row("Opening a photo", "Tiny shows its thumbnail large - nothing more is read. Full reads the whole photo (a few MB) into memory", seg("phoneFullPhoto", o.full, [[false, "Tiny"], [true, "Full photo"]])),
      ] }, { title: "Videos", icon: "film", body: [
      row("Video thumbnails", "The phone's own (some phones have none for videos), or a frame made from each video with ffmpeg - read from its start and end only, a few MB each", seg("phoneVideoThumbs", o.vthumb, [["phone", "The phone's"], ["made", "Made from the video"]])),
      row("Video previews", "A double-clicked video is made small and watchable (any phone format) with ffmpeg - from its first seconds, or all of it. The video is read for that into a temporary file, removed at once", seg("phoneVideoPreview", o.video, [[0, "Off"], [5, "5 s"], [15, "15 s"], [60, "1 min"], [-1, "All"]])),
      ] }, { title: "The list", icon: "list", body: [
      row("Deleted files", "After deleting, the files stay where they were, marked deleted (a duplicates group still shows what it held), or go from the list", seg("phoneHideDeleted", !!S.phoneHideDeleted, [[false, "Stay, marked"], [true, "Go from the list"]])),
      row("Scanning the phone", "For Photos, Videos, Largest and Duplicates", seg("phoneSkipSystem", o.skip, [[true, "Skip Android's own and hidden folders"], [false, "Everything"]]))] }], "leonote.phone.sections"));
    const r = anchor.getBoundingClientRect();
    document.getElementById("overlay-root").append(pop);
    pop.style.left = Math.max(8, Math.min(r.right - 340, innerWidth - 348)) + "px";
    pop.style.top = r.bottom + 6 + "px";
    const off2 = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", off2, true); } };
    setTimeout(() => document.addEventListener("mousedown", off2, true));
  }

  const thumbUrl = (it) => { const T = window.__TAURI__; const base = T && T.core ? T.core.convertFileSrc("", "phone") : ""; return base ? `${base}thumb?d=${encodeURIComponent(dev.id)}&o=${encodeURIComponent(it.id)}&n=${encodeURIComponent(it.name)}&s=360` : host.phoneThumb ? host.phoneThumb(it) : ""; };
  const fileUrl = (it) => { const T = window.__TAURI__; const base = T && T.core ? T.core.convertFileSrc("", "phone") : ""; return base ? `${base}file?d=${encodeURIComponent(dev.id)}&o=${encodeURIComponent(it.id)}&n=${encodeURIComponent(it.name)}&s=2400` : thumbUrl(it); };
  const phoneBase = () => { const T = window.__TAURI__; return T && T.core ? T.core.convertFileSrc("", "phone") : ""; };
  const vthumbUrl = (it, quick) => (phoneBase() ? `${phoneBase()}vthumb?d=${encodeURIComponent(dev.id)}&o=${encodeURIComponent(it.id)}&n=${encodeURIComponent(it.name)}&z=${it.size || 0}${quick ? "&quick=1" : ""}` : thumbUrl(it));
  const previewUrl = (it, secs) => (phoneBase() ? `${phoneBase()}preview?d=${encodeURIComponent(dev.id)}&o=${encodeURIComponent(it.id)}&n=${encodeURIComponent(it.name)}&secs=${secs < 0 ? 0 : secs}` : "");
  const kindOf = (it) => (it.dir ? "dir" : PHOTO.test(it.name) ? "photo" : VIDEO.test(it.name) ? "video" : "other");

  // thumbnails only for the tiles in sight: the phone answers one at a time - and none during a scan, which
  // needs every answer it can get (its end paints the tiles anew, so those in sight ask then)
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting || scanning) continue;
      io.unobserve(e.target);
      const img = e.target.querySelector("img[data-src]");
      if (img) { img.src = img.dataset.src; img.removeAttribute("data-src"); }
    }
  }, { root: null, rootMargin: "300px" });

  async function findDevices() {
    if (!host.phoneDevices) { note.textContent = "Phones are read in the Leonote app on Windows."; return; }
    note.textContent = "Looking for phones…";
    try { devices = await host.phoneDevices(); } catch (e) { devices = []; note.textContent = String(e); return; }
    if (dev && !devices.some((d) => d.id === dev.id)) { dev = null; trail = []; items = []; forgetPhone(); }
    if (!dev && devices.length) { dev = devices.find((d) => d.id === S.phoneLast) || devices[0]; trail = []; }
    paintDevs();
    if (dev) open(trail.length ? trail[trail.length - 1] : null, true);
    else { note.replaceChildren(h("p", { text: "No phone is plugged in." }), h("p", { class: "ph-dim", text: "Plug it in by USB, unlock it, and when it asks what the USB is for, choose \"File transfer\" (Android) or \"Allow\" (iPhone). Then Refresh." })); grid.replaceChildren(); bar.replaceChildren(); crumbs.replaceChildren(); }
  }
  /** Another phone: the last one's ids would mean other files on this one, so nothing of it stays - its list, its
     picks, a scan still running. A compress job already made stays, tied to its own phone (cx.dev). */
  function forgetPhone() {
    if (scanning && host.phoneScanStop) host.phoneScanStop();
    scanReq++;
    scanning = false;
    index = null;
    scanTrouble = "";
    sel.clear();
    anchor = null;
    dupesChecked = false;
    if (!busy) xfer.clear();
    if (cx && !cx.job) cx.files = [];
    paintDrawer();
    if (mode === "compress") paintCompress();
  }
  function paintDevs() {
    devRow.replaceChildren(...devices.map((d) => h("button", { class: "ve-chip" + (dev && d.id === dev.id ? " is-on" : ""), onclick: () => { if (!dev || d.id !== dev.id) forgetPhone(); dev = d; app.setSetting("phoneLast", d.id); trail = []; paintDevs(); open(null); } }, icon("phone"), d.name)));
    sub.textContent = devices.length ? `${devices.length === 1 ? "One device" : devices.length + " devices"} plugged in` : "";
  }

  /** Open a folder (null: the phone's top, its storages) - its items come in as they are read. */
  function open(folder, keep = false) {
    tileLimit = TILES;
    if (!dev) return;
    if (!keep) { sel.clear(); anchor = null; }
    if (folder === null) trail = [];
    else { const i = trail.findIndex((f) => f.id === folder.id); trail = i >= 0 ? trail.slice(0, i + 1) : [...trail, folder]; }
    items = [];
    reading = true;
    const r = ++req;
    paintCrumbs();
    paint();
    host.phoneList(dev.id, folder ? folder.id : "", r).catch((e) => { if (r === req) { reading = false; note.textContent = String(e); paint(); } });
  }
  const off = host.on ? host.on("phone:list", (p) => {
    const d = p && (p.payload || p);
    if (!d || d.req !== req) return;
    const parent = trail.length ? trail[trail.length - 1].id : "";
    for (const x of d.items || []) x.parent = parent;
    items.push(...(d.items || []));
    if (d.done) reading = false;
    paintSoon();
  }) : null;
  const offCopy = host.on ? host.on("phone:copy", (p) => {
    const d = p && (p.payload || p);
    if (!d || !busy || d.job !== busy.job) return;
    Object.assign(busy, d);
    xferApply(xfer, d, busy.remove);
    if (d.error && !d.finished) app.toast(d.error, { kind: "error", ms: 6000 });
    if (d.finished) {
      const b = busy;
      busy = null;
      // what the phone really deleted (`copied` from a test backend without it), and only off this phone's lists:
      // those tiles stay, marked Moved, their phone actions gone - until the next scan
      const off = b.remove ? d.gone || d.copied || [] : [];
      const stay = b.remove ? d.done - off.length : 0;
      const gone = new Set(dev && b.dev === dev.id ? off : []);
      if (gone.size) { for (const it of [...items, ...(index || [])]) if (gone.has(it.id)) it.deleted = true; for (const id of gone) sel.delete(id); }
      const show = { label: "Show", run: () => host.externalReveal && host.externalReveal(d.dir) };
      if (d.done) app.toast(`${b.remove ? "Moved" : "Copied"} ${d.done - stay} of ${d.total} to ${d.dir}${stay ? ` · ${stay} copied, but still on the phone` : ""}`, { ms: 7000, action: show });
      if (d.failed || d.error) app.toast(`${d.failed || d.total} of ${d.total} could not be ${b.remove ? "moved" : "copied"}${d.error ? ": " + d.error : " - each says why on its tile"}`, { kind: "error", ms: 9000 });
      else if (app.sound) app.sound("done");
      paint();
    } else if (d.id) retag(d.id);
    paintProgress();
  }) : null;
  // the transfer's tags on the tiles (id → { state, to, why }), kept until the next scan
  const xfer = new Map();
  function xferTag(x) {
    const label = XFER_LABEL[x.state] + (x.state === "failed" && x.why ? " · " + x.why : "");
    return h("span", { class: "ph-xfer is-" + x.state, text: label,
      title: x.to ? `${XFER_LABEL[x.state]} to ${x.to}${x.why ? ` (${x.why})` : ""}\nClick to show it in Explorer` : x.why || label,
      onclick: (e) => { e.stopPropagation(); if (x.to && host.externalReveal) host.externalReveal(x.to).catch((err) => app.toast(String(err), { kind: "error" })); } });
  }
  function retag(id) {
    const x = xfer.get(id);
    for (const t of grid.querySelectorAll(".ph-tile[data-id]")) if (t.dataset.id === id) { t.querySelector(".ph-xfer")?.remove(); if (x) t.append(xferTag(x)); }
  }
  /* Away from this view while a transfer runs: a pill in the status bar with its percent, a click comes back here.
     Painted by the transfer's own events and on a change of view - nothing polls. */
  const pill = h("button", { class: "ph-pill", hidden: true, title: "Phone transfer · click to open the Phone view", onclick: () => app.openView && app.openView("phone") });
  document.getElementById("statusbar")?.querySelector(".sb-spacer")?.before(pill);
  function paintPill() {
    pill.hidden = !busy || (!el.hidden && el.isConnected !== false);
    if (!pill.hidden) pill.replaceChildren(icon("phone"), `${busy.remove ? "Moving" : "Copying"} ${busy.total ? Math.round((busy.done / busy.total) * 100) : 0}%`);
  }
  if (app.bus) app.bus.on("view", paintPill);
  let soon = 0;
  const paintSoon = () => { if (!soon) soon = requestAnimationFrame(() => { soon = 0; paint(); }); };

  const MODES = [["folders", "Folders", "folder"], ["all", "Everything", "list"], ["search", "Search", "search"], ["photos", "Photos", "image"], ["videos", "Videos", "film"], ["largest", "Largest", "chart"], ["dupes", "Duplicates", "layers"], ["compress", "Compress", "shrink"]];
  function paintDrawer() {
    const count = (m) => (!index ? "" : m === "photos" ? index.filter((x) => kindOf(x) === "photo").length : m === "videos" ? index.filter((x) => kindOf(x) === "video").length : m === "dupes" ? dupes().length : "");
    drawer.replaceChildren(...MODES.map(([m, n, ic]) => h("button", { class: "ph-dtab" + (mode === m ? " is-on" : ""), onclick: () => setMode(m) }, icon(ic), h("span", { text: n }), count(m) !== "" ? h("span", { class: "ph-dcount", text: String(count(m)) }) : null)));
  }
  function setMode(m) {
    mode = m;
    tileLimit = TILES;
    app.setSetting("phoneMode", m);
    sel.clear();
    if (m !== "folders" && m !== "compress" && !index && !scanning) { paint(); return; }
    paint();
  }
  /** Every file on the phone, read folder by folder (shown as it comes). */
  function scan() {
    if (!dev || !host.phoneScan) return;
    index = [];
    scanning = true;
    scanFolders = 0;
    scanTrouble = "";
    scanPainted = 0;
    dupesChecked = false;
    if (!busy) xfer.clear();
    const r = ++scanReq;
    paint();
    host.phoneScan(dev.id, r, opt().skip).catch((e) => { if (r === scanReq) { scanning = false; app.toast(String(e), { kind: "error" }); paint(); } });
  }
  const offScan = host.on ? host.on("phone:scan", (ev) => {
    const d = ev && (ev.payload || ev);
    if (!d || d.req !== scanReq || !index) return;
    index.push(...(d.items || []));
    scanFolders = d.folders || scanFolders;
    if (d.done) {
      scanning = false;
      scanTrouble = d.gone ? `The phone stopped answering after ${d.folders} folders, so this list is only part of it. Keep it plugged in and unlocked, then Scan again.`
        : d.stopped ? `Stopped after ${d.folders} folders, so this list is only part of the phone.`
        : d.unread ? `${d.unread} ${d.unread === 1 ? "folder" : "folders"} could not be read, so this list may miss some files. Scan again to try once more.` : "";
    }
    // all the tiles anew each time: every moment or so is enough while it reads
    if (d.done || Date.now() - scanPainted > 2500) { scanPainted = Date.now(); paintSoon(); }
  }) : null;
  /** Files of the same size and kind (50 KB and up), the likely copies - biggest waste first. */
  // worked out once per change of the list (a new batch, a fingerprint found), not at every repaint
  let dupesMemo = null, dupesGen = 0;
  function dupes() {
    if (!index) return [];
    if (dupesMemo && dupesMemo.index === index && dupesMemo.n === index.length && dupesMemo.gen === dupesGen) return dupesMemo.out;
    const by = new Map();
    // once checked, the content's fingerprint splits a group: only true copies stay together
    for (const x of index) { if (x.size < 50 * 1024) continue; const k = x.size + "|" + (x.name.split(".").pop() || "").toLowerCase() + (x.fp ? "|" + x.fp : ""); (by.get(k) || by.set(k, []).get(k)).push(x); }
    const out = [...by.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.mtime - b.mtime)).sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));
    dupesMemo = { index, n: index.length, gen: dupesGen, out };
    return out;
  }

  let dupesChecked = false;
  const LATER = "The scan is still finding files, so those are not checked. Check again once the scan is done.";
  async function checkDupes() {
    const gs = dupes();
    const all = gs.flat().filter((x) => !x.fp && !x.deleted);
    if (!all.length) { dupesChecked = !scanning; if (scanning) app.toast(LATER, { ms: 6000 }); paint(); return; }
    const phone = dev.id, r = scanReq; // another scan or phone meanwhile: these are not its files
    let done = 0;
    let close = app.toast(`Comparing ${all.length} files…`, { ms: 600000 });
    try {
      for (let i = 0; i < all.length && r === scanReq; i += 8) {
        const part = all.slice(i, i + 8);
        const fps = await host.phoneFingerprints(phone, part.map((x) => x.id));
        for (const x of part) if (fps[x.id]) x.fp = fps[x.id];
        dupesGen++;
        done += part.length;
        if (close) close();
        close = app.toast(`Comparing… ${done} of ${all.length}`, { ms: 600000 });
      }
      if (r !== scanReq) return;
      // a file that could not be read stays only same-size: never called a true copy
      const left = all.filter((x) => !x.fp).length;
      // nor one the scan brought after this began, or still will
      const more = scanning || dupes().flat().some((x) => !x.fp && !x.deleted);
      dupesChecked = !left && !more;
      app.toast(left ? `${left} of ${all.length} could not be read, so those are not checked. Check again to try once more.` : more ? LATER : `${dupes().length} groups are true copies`, { ms: dupesChecked ? 4000 : 8000 });
    } catch (e) { app.toast("Could not compare: " + e, { kind: "error" }); }
    finally { if (close) close(); }
    paint();
  }

  /* Everything: every folder of the phone one under another, each with its files - folded by a click on its
     name, the first 60 shown and the rest on "Show all". */
  const allFolded = new Set(), allShown = new Map();
  function byFolder() {
    const m = new Map();
    for (const x of index || []) { const d = x.path || "(top)"; (m.get(d) || m.set(d, []).get(d)).push(x); }
    const by = sort === "size" ? (a, b) => b.size - a.size : sort === "name" ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) : (a, b) => b.mtime - a.mtime;
    return [...m.entries()].map(([d, fs]) => [d, fs.sort(by)]).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }

  function paintCrumbs() {
    crumbs.replaceChildren(
      h("button", { class: "ph-crumb", onclick: () => open(null) }, icon("phone"), dev ? dev.name : "Phone"),
      ...trail.flatMap((f) => [h("span", { class: "ph-sep", text: "›" }), h("button", { class: "ph-crumb", onclick: () => open(f) }, f.name)]));
  }
  const source = () => (mode === "folders" ? items : index || []);
  const shown = () => {
    if (mode === "photos" || mode === "videos") {
      const k = mode === "photos" ? "photo" : "video";
      const by = sort === "size" ? (a, b) => b.size - a.size : sort === "name" ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) : (a, b) => b.mtime - a.mtime;
      return (index || []).filter((x) => kindOf(x) === k).sort(by);
    }
    if (mode === "largest") return (index || []).slice().sort((a, b) => b.size - a.size).slice(0, 2000);
    if (mode === "search") return found().slice(0, 3000);
    if (mode === "all") return byFolder().flatMap(([d, fs]) => (allFolded.has(d) ? [] : fs.slice(0, allShown.get(d) || 60)));
    if (mode === "dupes") return dupes().flat();
    if (mode === "compress") return [];
    const list = items.filter((it) => kind === "all" || it.dir || kindOf(it) === kind);
    const by = sort === "size" ? (a, b) => b.size - a.size : sort === "name" ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) : (a, b) => b.mtime - a.mtime;
    return [...list.filter((x) => x.dir).sort((a, b) => a.name.localeCompare(b.name)), ...list.filter((x) => !x.dir).sort(by)];
  };
  const picked = () => { const seen = new Set(); return [...items, ...(index || [])].filter((it) => !it.deleted && sel.has(it.id) && !seen.has(it.id) && seen.add(it.id)); };

  function paintBar() {
    const p = picked();
    const bytes = p.reduce((s, it) => s + (it.size || 0), 0);
    const chip = (v, n, set, now) => h("button", { class: "ve-chip" + (now === v ? " is-on" : ""), onclick: () => set(v) }, n);
    const files = shown().filter((x) => !x.dir);
    // the transfer's progress rides in this bar, which stays at the top while the tiles scroll
    if (mode === "compress") { bar.hidden = !busy; bar.replaceChildren(progress); return; }
    bar.hidden = false;
    bar.replaceChildren(
      h("div", { class: "ph-chips" },
        ...(mode === "folders" ? [["all", "All"], ["photo", "Photos"], ["video", "Videos"], ["other", "Other"]].map(([v, n]) => chip(v, n, (x) => { kind = x; app.setSetting("phoneKind", x); paint(); }, kind)) : []),
        mode === "all" && index ? h("button", { class: "link-btn", onclick: () => { const ds = byFolder().map(([d]) => d); const all = ds.every((d) => allFolded.has(d)); for (const d of ds) all ? allFolded.delete(d) : allFolded.add(d); paint(); } }, "Fold or unfold every folder") : null,
        mode === "search" ? h("span", { class: "ph-dim", text: found().length > 3000 ? "The first 3,000 shown - narrow the search for the rest" : "" }) :
        mode === "largest" ? h("span", { class: "ph-dim", text: "The biggest files anywhere on the phone" }) : mode === "dupes" ? h("span", { class: "ph-dim", text: "Same size and kind - most likely the same file twice. Look before deleting." }) : null,
        mode === "dupes" && index ? h("button", { class: "link-btn", title: "Pick every copy but the oldest of each - only in groups checked to be the same inside", onclick: () => {
          // same size and kind is not the same file (two raw photos, two equal recordings): only groups whose content
          // was compared are picked, so Delete never takes a look-alike
          sel.clear();
          let unchecked = 0;
          for (const g of dupes()) { if (g.some((x) => !x.fp)) { unchecked++; continue; } const live = g.filter((x) => !x.deleted); for (const x of live.slice(1)) sel.add(x.id); }
          paintSel();
          if (unchecked) app.toast(`${unchecked} group${unchecked === 1 ? " was" : "s were"} left out: press "Check they are really the same" first - same size is not always the same file`, { ms: 7000 });
        } }, "Pick the extra copies") : null,
        mode === "dupes" && index ? h("button", { class: "link-btn", title: "Every file of every group, the originals too", onclick: () => { for (const g of dupes()) for (const x of g) if (!x.deleted) sel.add(x.id); paintSel(); } }, "Pick all") : null,
        mode === "dupes" && index && sel.size ? h("button", { class: "link-btn", onclick: () => { sel.clear(); paintSel(); } }, "Unpick all") : null,
        mode === "dupes" && index && host.phoneFingerprints ? h("button", { class: "link-btn", title: "Read each one and compare what is inside - true copies stay grouped, look-alikes of the same size go. Reads every file of the groups (nothing is kept)", onclick: checkDupes }, dupesChecked ? "Checked ✓" : "Check they are really the same") : null,
        mode !== "folders" && index ? h("button", { class: "link-btn", onclick: () => (scanning ? host.phoneScanStop() : scan()) }, scanning ? "Stop scanning" : "Scan again") : null,
        h("span", { class: "ph-gap" }),
        ...(mode === "folders" || mode === "all" || mode === "photos" || mode === "videos" ? [["date", "Newest"], ["size", "Biggest"], ["name", "Name"]].map(([v, n]) => chip(v, n, (x) => { sort = x; tileLimit = TILES; app.setSetting("phoneSort", x); paint(); }, sort)) : [])),
      h("div", { class: "ph-acts" },
        h("button", { class: "ve-chip" + (picking ? " is-on" : ""), title: "Select mode: a click adds a file to the picked ones, another click takes it back. Without it: a click picks one file, Ctrl/Shift+click adds, a box dragged over them picks them all; a double-click opens", onclick: () => { picking = !picking; app.setSetting("phonePicking", picking); paintBar(); } }, icon("check"), "Select"),
        h("button", { class: "icon-btn", title: "Tile colours: by name family, big files marked", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, [
          { label: "Colour by name", icon: "palette", checked: S.phoneTintNames !== false, keep: true, run: () => { app.setSetting("phoneTintNames", S.phoneTintNames === false); paint(); } },
          { label: "Mark big files", icon: "chart", checked: !!S.phoneMarkBig, keep: true, run: () => { app.setSetting("phoneMarkBig", !S.phoneMarkBig); paint(); } }]); } }, icon("palette")),
        h("span", { class: "ph-count", text: p.length ? `${p.length} picked · ${size(bytes)}` : files.length ? `${files.length} files · ${size(files.reduce((s, it) => s + it.size, 0))}${reading ? " so far…" : ""}` : reading ? "Reading…" : "" }),
        h("span", { class: "ph-gap" }),
        files.length ? h("button", { class: "link-btn", title: "Ctrl+A", onclick: pickAll }, "Pick all shown") : null,
        p.length ? h("button", { class: "link-btn", title: "Esc", onclick: () => { sel.clear(); paintSel(); } }, "Clear") : null,
        h("button", { class: "btn btn-primary", disabled: !p.length || !!busy, title: "Copy them to a folder on this computer, then take them off the phone - each one only once it is safely here (Ctrl+X)", onclick: () => transfer(true) }, icon("download"), "Move to computer"),
        h("button", { class: "btn", disabled: !p.length || !!busy, title: "Copy them to a folder on this computer; the phone keeps them (Ctrl+C)", onclick: () => transfer(false) }, "Copy"),
        h("button", { class: "btn", disabled: !p.some((x) => kindOf(x) === "photo" || kindOf(x) === "video") || !!busy, title: "Make photos and videos smaller on the phone - you see each result and its size before anything on the phone changes", onclick: () => compress() }, icon("shrink"), "Compress…"),
        h("button", { class: "btn btn-danger", disabled: !p.length || !!busy, title: "Delete them from the phone - a phone has no recycle bin", onclick: remove }, icon("trash"), "Delete")),
      progress);
  }

  // how many files of each name family the list holds: 3 or more get a tint
  let famCount = new Map();
  function countFamilies() {
    famCount = new Map();
    if (S.phoneTintNames === false) return;
    for (const it of source()) { if (it.dir) continue; if (it.fam === undefined) it.fam = nameFamily(it.name); if (it.fam) famCount.set(it.fam, (famCount.get(it.fam) || 0) + 1); }
    for (const [f, n] of famCount) if (n < 3) famCount.delete(f);
  }
  function paint() {
    countFamilies();
    paintDrawer();
    crumbs.hidden = mode !== "folders";
    finder.hidden = mode !== "search" || !index;
    if (!finder.hidden) paintFinder();
    panel.hidden = mode !== "compress";
    grid.hidden = mode === "compress";
    paintBar();
    if (mode === "compress") { note.textContent = ""; paintCompress(); return; }
    if (mode !== "folders" && (!index || (scanning && !index.length))) {
      grid.replaceChildren();
      note.replaceChildren(scanning
        ? h("div", { class: "ph-scan" }, h("b", { text: "Reading the whole phone…" }), h("div", { class: "ph-dim", text: `${scanFolders} folders · ${index.length} files so far` }), h("button", { class: "btn", onclick: () => host.phoneScanStop && host.phoneScanStop() }, "Stop"))
        : h("div", { class: "ph-scan" }, h("b", { text: "Scan the phone first" }), h("div", { class: "ph-dim", text: "Every folder is read once - names and sizes only, nothing is copied - so Everything, Search, Photos, Videos, Largest and Duplicates can show what is anywhere on it. A phone with many thousands of files takes a minute or two." }), h("button", { class: "btn btn-primary", disabled: !dev, onclick: scan }, icon("search"), "Scan the phone")));
      return;
    }
    const storages = mode === "folders" && !trail.length;
    note.textContent = !dev ? note.textContent : mode === "folders" ? (reading && !items.length ? "Reading the phone…" : !items.length ? "Nothing here." : "") : scanning ? `Still scanning… ${scanFolders} folders, ${index.length} files so far` : scanTrouble || (!shown().length ? "Nothing here." : "");
    note.classList.toggle("is-warn", mode !== "folders" && !scanning && !!scanTrouble);
    grid.classList.toggle("is-top", storages);
    grid.classList.toggle("is-list", mode === "largest" || (mode === "search" && F.list));
    if (mode === "all") {
      paintGroups(byFolder().map(([d, fs]) => {
        const folded = allFolded.has(d);
        const n = allShown.get(d) || 60;
        const depth = d.split("/").length - 1;
        return { tiles: folded ? 1 : Math.min(n, fs.length), make: () => h("div", { class: "ph-dgroup ph-afold" + (folded ? " is-folded" : ""), style: { "--depth": depth } },
          h("div", { class: "ph-dhead ph-ahead", onclick: () => { folded ? allFolded.delete(d) : allFolded.add(d); paint(); } },
            icon(folded ? "chevron" : "chevronDown"), h("b", { text: d }), h("span", { text: `${fs.length} file${fs.length === 1 ? "" : "s"} · ${size(fs.reduce((s, x) => s + x.size, 0))}` }),
            h("span", { class: "ph-gap" }),
            h("button", { class: "link-btn", title: "Pick every file of this folder", onclick: (e) => { e.stopPropagation(); for (const x of fs) if (!x.deleted) sel.add(x.id); paintSel(); } }, "Pick all")),
          folded ? null : h("div", { class: "ph-dtiles" + (F.list ? " is-list" : "") }, ...fs.slice(0, n).map((it) => tile(it, false))),
          !folded && fs.length > n ? h("button", { class: "link-btn ph-more", onclick: () => { allShown.set(d, fs.length); paint(); } }, `Show all ${fs.length}`) : null) };
      }));
      return;
    }
    if (mode === "dupes") {
      paintGroups(dupes().slice(0, 300).map((g) => ({ tiles: g.length, make: () => h("div", { class: "ph-dgroup" },
        h("div", { class: "ph-dhead" }, h("span", { text: `${g.length} × ${size(g[0].size)} · ${size(g[0].size * (g.length - 1))} to free` }),
          h("button", { class: "link-btn", title: "Pick all but the oldest of this group", onclick: () => { const live = g.filter((x) => !x.deleted); for (const x of live.slice(1)) sel.add(x.id); if (live[0]) sel.delete(live[0].id); paintSel(); } }, "Pick the copies"),
          h("button", { class: "link-btn", onclick: () => { for (const x of g) sel.delete(x.id); paintSel(); } }, "Unpick")),
        h("div", { class: "ph-dtiles" }, ...g.map((it) => tile(it, false)))) })));
      return;
    }
    const list = shown();
    grid.replaceChildren(...list.slice(0, tileLimit).map((it) => tile(it, storages)));
    if (list.length > tileLimit) { const end = h("div", { class: "ph-end" }); grid.append(end); moreIo.observe(end); }
  }
  // Everything and Duplicates: whole groups until the tiles drawn reach the limit, the next ones as the page nears the end.
  // The last group can go over: the limit follows, so a repaint draws all that was on screen
  let groupsLeft = [], groupTiles = 0;
  function paintGroups(groups) { groupsLeft = groups; groupTiles = 0; grid.replaceChildren(); moreGroups(); }
  function moreGroups() {
    while (groupsLeft.length && groupTiles < tileLimit) { const g = groupsLeft.shift(); groupTiles += g.tiles; grid.append(g.make()); }
    tileLimit = Math.max(tileLimit, groupTiles);
    if (groupsLeft.length) { const end = h("div", { class: "ph-end" }); grid.append(end); moreIo.observe(end); }
  }
  const moreIo = new IntersectionObserver((ents) => {
    const e = ents.find((x) => x.isIntersecting);
    if (!e) return;
    moreIo.unobserve(e.target);
    if (mode === "all" || mode === "dupes") { e.target.remove(); tileLimit += TILES; moreGroups(); return; }
    const list = shown();
    e.target.before(...list.slice(tileLimit, tileLimit + TILES).map((it) => tile(it, false)));
    tileLimit += TILES;
    if (list.length > tileLimit) moreIo.observe(e.target); else e.target.remove(); // observed anew: it answers again if still in sight
  }, { rootMargin: "800px" });
  function tile(it, top) {
    const k = kindOf(it);
    if (it.dir) {
      const cap = it.cap ? h("div", { class: "ph-cap" }, h("div", { class: "ph-capbar" }, h("i", { style: { width: Math.round((1 - (it.free || 0) / it.cap) * 100) + "%" } })), h("div", { class: "ph-dim", text: `${size(it.free || 0)} free of ${size(it.cap)}` })) : null;
      return h("div", { class: "ph-tile is-dir" + (top ? " is-storage" : ""), title: it.name, ...pressable(() => open(it)), ondblclick: () => open(it), onclick: () => open(it) },
        h("div", { class: "ph-thumb" }, icon(top ? "phone" : "folder")), h("div", { class: "ph-name", text: it.name }), cap);
    }
    const t = h("div", { class: "ph-tile" + (sel.has(it.id) ? " is-sel" : "") + (it.deleted ? " is-deleted" : ""), dataset: { id: it.id }, title: `${it.name}\n${size(it.size)} · ${day(it.mtime)}`, ...(it.deleted ? null : pressable((e) => (e.key === " " ? pick(it, e) : preview(it)))) },
      h("div", { class: "ph-thumb" }, (k === "photo" || k === "video") && opt().thumbs ? h("img", { "data-src": k === "video" && opt().vthumb === "made" ? vthumbUrl(it) : thumbUrl(it), alt: "", loading: "lazy", draggable: false, onerror: (e) => {
          // a phone without its own video thumbnails: one frame from the video's two ends (a few MB, with ffmpeg if it is here)
          if (k === "video" && !e.target.dataset.quick && opt().vthumb !== "made") { e.target.dataset.quick = "1"; e.target.src = vthumbUrl(it, true); return; }
          e.target.replaceWith(icon(k === "video" ? "film" : "image"));
        } }) : icon(k === "video" ? "film" : k === "photo" ? "image" : kindName(it.name) === "audio" ? "music" : kindName(it.name) === "doc" ? "fileText" : "file"),
        k === "video" ? h("span", { class: "ph-badge" }, icon("play")) : null, h("span", { class: "ph-check" }, icon("check"))),
      h("div", { class: "ph-name", text: it.name }), h("div", { class: "ph-meta", text: `${size(it.size)} · ${day(it.mtime)}` }),
      mode !== "folders" && it.path ? h("div", { class: "ph-meta ph-path", text: it.path, title: it.path }) : null);
    // a click picks it alone, as Explorer does (in Select mode, or with Ctrl/Shift, it is added to the others); a double-click opens it;
    // a box dragged over tiles picks them all
    // a tint shared by a family of names (a camera's footage), a glow growing with the size (the bar's palette menu)
    const fam = S.phoneTintNames !== false && famCount.get(it.fam);
    if (fam) { t.classList.add("has-fam"); t.style.setProperty("--fam-h", familyHue(it.fam)); }
    if (S.phoneMarkBig) t.classList.add("sz-" + sizeClass(it.size || 0));
    const x = xfer.get(it.id);
    if (it.deleted) {
      t.title = `${it.name} - ${x && x.state === "moved" ? "moved to this computer, no longer on the phone" : "deleted from the phone"}`;
      if (x && x.state === "moved") t.classList.add("is-moved");
      t.append(x && x.state === "moved" ? xferTag(x) : h("span", { class: "ph-gone", text: "Deleted" }));
      return t;
    }
    if (x) t.append(xferTag(x));
    t.addEventListener("click", (e) => {
      if (boxed) return;
      if (picking || e.ctrlKey || e.metaKey || e.shiftKey) return pick(it, e);
      sel.clear(); sel.add(it.id); anchor = it.id; paintSel();
    });
    t.addEventListener("dblclick", (e) => { if (boxed || picking || e.ctrlKey || e.metaKey || e.shiftKey) return; preview(it); });
    // a right-click keeps what is picked: the file under it joins them
    t.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!sel.has(it.id)) { sel.add(it.id); anchor = it.id; paintSel(); } itemMenu(it, e.clientX, e.clientY); });
    io.observe(t);
    return t;
  }
  function pick(it, e) {
    if (it.deleted) return;
    const list = shown().filter((x) => !x.dir);
    if (e.shiftKey && anchor) {
      const a = list.findIndex((x) => x.id === anchor), b = list.findIndex((x) => x.id === it.id);
      if (a >= 0 && b >= 0) for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) sel.add(x.id);
    } else sel.has(it.id) ? sel.delete(it.id) : sel.add(it.id);
    anchor = it.id;
    paintSel();
  }
  function paintTiles() { for (const t of grid.querySelectorAll(".ph-tile[data-id]")) t.classList.toggle("is-sel", sel.has(t.dataset.id)); }
  function paintSel() { paintTiles(); paintBar(); }
  function pickAll() { const vis = shown().filter((x) => !x.dir && !x.deleted); const all = vis.every((x) => sel.has(x.id)); for (const x of vis) all ? sel.delete(x.id) : sel.add(x.id); paintSel(); }

  /* A box dragged with the left button picks what it touches (Ctrl keeps what was picked); near the
     top or bottom edge the page scrolls along. */
  let boxed = false;
  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".ph-tile.is-dir")) return;
    const x0 = e.clientX, y0 = e.clientY;
    const scroller = (() => { let s = grid.parentElement; while (s && !(s.scrollHeight > s.clientHeight && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement; return s || document.scrollingElement; })();
    const top0 = scroller.scrollTop;
    const keep = e.ctrlKey || e.metaKey ? new Set(sel) : new Set();
    let box = null, last = e;
    boxed = false;
    const update = () => {
      const dy = scroller.scrollTop - top0;
      const l = Math.min(x0, last.clientX), r = Math.max(x0, last.clientX), t = Math.min(y0 - dy, last.clientY), b = Math.max(y0 - dy, last.clientY);
      Object.assign(box.style, { left: l + "px", top: t + "px", width: r - l + "px", height: b - t + "px" });
      sel.clear();
      for (const id of keep) sel.add(id);
      for (const tl of grid.querySelectorAll(".ph-tile[data-id]:not(.is-deleted)")) { const q = tl.getBoundingClientRect(); if (q.right > l && q.left < r && q.bottom > t && q.top < b) sel.add(tl.dataset.id); }
      // only the tiles and the count while dragging: the whole bar goes through every file on the phone, so it waits for the drop
      paintTiles();
      const count = bar.querySelector(".ph-count");
      if (count) count.textContent = `${sel.size} picked`;
    };
    let edgeDir = 0, edgeRaf = 0;
    const edgeTick = () => { edgeRaf = 0; if (!edgeDir) return; scroller.scrollTop += edgeDir * 18; update(); edgeRaf = requestAnimationFrame(edgeTick); };
    const move = (m) => {
      last = m;
      if (!box) { if (Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return; box = h("div", { class: "ph-box" }); document.body.append(box); boxed = true; }
      update();
      const sr = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      edgeDir = m.clientY < Math.max(sr.top, 0) + 40 ? -1 : m.clientY > Math.min(sr.bottom, innerHeight) - 40 ? 1 : 0;
      // held at the edge: it scrolls with the screen's own frames, and stops when the pointer leaves the edge
      if (edgeDir && !edgeRaf) edgeRaf = requestAnimationFrame(edgeTick);
    };
    const up = () => {
      edgeDir = 0;
      cancelAnimationFrame(edgeRaf); edgeRaf = 0;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (box) { box.remove(); paintBar(); }
      setTimeout(() => { boxed = false; }, 0);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });

  function itemMenu(it, x, y) {
    const p = picked();
    const many = p.length > 1;
    const k = kindOf(it);
    menu(x, y, [
      !many && (k === "photo" || k === "video") ? { label: k === "video" ? "Play a preview" : "Open", icon: k === "video" ? "play" : "image", run: () => preview(it) } : null,
      { label: many ? `Move ${p.length} to computer…` : "Move to computer…", icon: "download", keys: "Ctrl X", run: () => transfer(true) },
      { label: many ? `Copy ${p.length} to computer…` : "Copy to computer…", icon: "clipboard", keys: "Ctrl C", run: () => transfer(false) },
      "sep",
      { label: sel.has(it.id) && many ? "Unpick this one" : "Pick it too", icon: "check", run: () => { if (many && sel.has(it.id)) sel.delete(it.id); else sel.add(it.id); paintSel(); } },
      { label: "Pick all from that day", icon: "calendar", run: () => { const d = day(it.mtime); for (const x of shown()) if (!x.dir && day(x.mtime) === d) sel.add(x.id); paintSel(); } },
      { label: "Pick all shown", icon: "check", keys: "Ctrl A", run: pickAll },
      { header: `${many ? p.length + " files · " + size(p.reduce((s, x) => s + x.size, 0)) : size(it.size) + " · " + day(it.mtime)}` },
      p.some((x) => kindOf(x) === "photo" || kindOf(x) === "video") ? { label: many ? `Compress ${p.length}…` : "Compress…", icon: "shrink", run: () => compress() } : null,
      "sep",
      { label: many ? `Delete ${p.length} from the phone` : "Delete from the phone", icon: "trash", keys: "Del", danger: true, run: remove },
    ]);
  }

  // the keys: Delete as the button, Ctrl+A, Esc, Enter opens
  inner.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "Delete") { e.preventDefault(); if (picked().length && !busy) remove(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); pickAll(); }
    // Ctrl+X moves the picked files to a folder on the computer (off the phone once each is safely there), Ctrl+C copies them
    else if ((e.ctrlKey || e.metaKey) && (e.code === "KeyX" || e.code === "KeyC") && picked().length && !busy) { e.preventDefault(); transfer(e.code === "KeyX"); }
    else if (e.key === "Escape" && sel.size) { e.preventDefault(); sel.clear(); paintSel(); }
    else if (e.key === "Enter") { const f = picked()[0]; if (f) { e.preventDefault(); preview(f); } }
  });
  grid.addEventListener("pointerdown", () => inner.focus({ preventScroll: true }));
  /* Large, over everything: a photo, or a video played from the phone (read into memory, never onto
     the disk; up to 400 MB). The arrows step through what is shown, Delete deletes this one. */
  // what can be looked at or listened to right here, read off the phone into memory
  const LOOK = (x) => !x.dir && !x.deleted && (kindOf(x) === "photo" || kindOf(x) === "video" || /\.(mp3|m4a|aac|ogg|opus|wav|flac|pdf|txt|md|csv|json|log|srt)$/i.test(x.name));
  function preview(it) {
    const media = shown().filter(LOOK);
    if (!media.some((x) => x.id === it.id)) return app.toast("This kind of file opens after copying it to the computer", { ms: 2600 });
    let cur = it;
    const stage = h("div", { class: "ph-preview-stage" });
    const name = h("div", { class: "ph-preview-name" });
    const back = h("div", { class: "ph-preview" }, stage, name);
    const show = () => {
      const k = kindOf(cur);
      const o = opt();
      const playing = k === "video" && !!o.video;
      name.textContent = `${cur.name} · ${size(cur.size)} · ${day(cur.mtime)}${playing ? ` · making a preview of ${o.video < 0 ? "all of it" : "the first " + o.video + " s"}…` : k === "video" ? " · its thumbnail (video previews are off - ⚙)" : !o.full ? " · its thumbnail" : ""}  ·  ← → next  ·  Del deletes  ·  Esc closes`;
      const ext = (cur.name.split(".").pop() || "").toLowerCase();
      if (/^(mp3|m4a|aac|ogg|opus|wav|flac)$/.test(ext)) {
        name.textContent = `${cur.name} · ${size(cur.size)} · ${day(cur.mtime)}  ·  ← → next  ·  Del deletes  ·  Esc closes`;
        stage.replaceChildren(h("div", { class: "ph-audio" }, icon("music"), h("div", { class: "ph-audio-name", text: cur.name.replace(/\.[^.]+$/, "") }),
          h("audio", { src: fileUrl(cur), controls: true, autoplay: true, onerror: () => { name.textContent = `${cur.name} · this sound does not play here`; } })));
        return;
      }
      if (ext === "pdf") { stage.replaceChildren(h("iframe", { class: "ph-doc", src: fileUrl(cur), title: cur.name })); name.textContent = `${cur.name} · ${size(cur.size)}  ·  ← → next  ·  Esc closes`; return; }
      if (/^(txt|md|csv|json|log|srt)$/.test(ext)) {
        const pre = h("pre", { class: "ph-text", text: "Reading…" });
        stage.replaceChildren(pre);
        name.textContent = `${cur.name} · ${size(cur.size)}  ·  ← → next  ·  Esc closes`;
        // the phone hands over the whole file before a line shows: a big log stays on the phone
        if (cur.size > 4 << 20) { pre.textContent = `Too big to show here (${size(cur.size)}) - copy it to the computer to read it`; return; }
        fetch(fileUrl(cur)).then((rq) => rq.text()).then((txt) => { pre.textContent = txt.length > 400000 ? txt.slice(0, 400000) + "\n…" : txt; }).catch(() => { pre.textContent = "Could not read it"; });
        return;
      }
      const el2 = k === "video" && playing ? h("video", { src: previewUrl(cur, o.video), controls: true, autoplay: true, playsInline: true, onloadeddata: () => { name.textContent = name.textContent.replace(/ · making a preview of [^·]+…/, ""); }, onerror: () => { name.textContent = `${cur.name} · no preview (is ffmpeg installed? ⚙ Video previews offers it)`; } })
        : k === "video" ? h("img", { src: o.vthumb === "made" ? vthumbUrl(cur) : thumbUrl(cur), alt: cur.name, class: "is-tiny" })
        : k === "photo" && !o.full ? h("img", { src: thumbUrl(cur), alt: cur.name, class: "is-tiny" })
        : k === "video"
        ? h("video", { src: fileUrl(cur), controls: true, autoplay: true, playsInline: true, onloadeddata: () => { name.textContent = name.textContent.replace(" · reading it from the phone…", ""); }, onerror: () => { name.textContent = `${cur.name} · this video does not play here (too big, or a format Windows cannot show) - copy it to the computer`; } })
        : h("img", { src: fileUrl(cur), alt: cur.name });
      stage.replaceChildren(el2);
    };
    const close = () => { const v = stage.querySelector("video, audio"); if (v) { v.pause(); v.removeAttribute("src"); v.load(); } back.remove(); document.removeEventListener("keydown", keys, true); inner.focus({ preventScroll: true }); };
    const step = (d) => { const i = media.findIndex((x) => x.id === cur.id); const n = media[i + d]; if (n) { const v = stage.querySelector("video, audio"); if (v) { v.pause(); v.removeAttribute("src"); v.load(); } cur = n; show(); } };
    const keys = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "Delete") { e.preventDefault(); e.stopPropagation(); sel.clear(); sel.add(cur.id); paintSel(); close(); remove(); }
    };
    back.addEventListener("click", (e) => { if (e.target === back || e.target === stage) close(); });
    document.getElementById("overlay-root").append(back);
    document.addEventListener("keydown", keys, true);
    show();
  }

  async function transfer(removeAfter) {
    const p = picked();
    if (!p.length || busy) return;
    const phone = dev.id;
    let dir = S.phoneDest || "";
    const chosen = await host.dialogOpen({ directory: true, title: removeAfter ? "Move them into which folder?" : "Copy them into which folder?", defaultPath: dir || undefined });
    if (!chosen) return;
    dir = String(chosen);
    app.setSetting("phoneDest", dir);
    if (removeAfter && !(await confirmDialog(`Move ${p.length} to this computer?`, `Each is copied to ${dir}, checked, and only then deleted from the phone.`, { ok: "Move", danger: false }))) return;
    busy = { job: ++job, dev: phone, done: 0, total: p.length, failed: 0, remove: removeAfter };
    // each picked tile says so at once: a failure shows where it happened, nothing looks done before it is
    for (const x of p) { xfer.set(x.id, { state: removeAfter ? "moving" : "copying" }); retag(x.id); }
    paintProgress();
    paintBar();
    try { await host.phoneCopy(phone, p.map((x) => ({ id: x.id, name: x.name, size: x.size, mtime: x.mtime })), dir, removeAfter, busy.job); }
    catch (e) {
      busy = null;
      for (const x of p) { Object.assign(xfer.get(x.id), { state: "failed", why: String(e) }); retag(x.id); }
      paintProgress(); paintBar(); app.toast(String(e), { kind: "error" });
    }
  }
  async function remove() {
    const p = picked();
    if (!p.length) return;
    const phone = dev.id;
    const bytes = p.reduce((s, it) => s + (it.size || 0), 0);
    if (!(await confirmDialog(`Delete ${p.length} file${p.length === 1 ? "" : "s"} from the phone?`, `${size(bytes)} is freed. A phone has no recycle bin: they are gone for good. "Move to computer" keeps a copy instead.`, { ok: "Delete", safe: true }))) return;
    try {
      const ids = p.map((x) => x.id);
      // with each file's name and size: one renumbered since (the phone plugged in again) is left alone, not another deleted
      const said = await host.phoneDelete(phone, ids, p.map((x) => ({ name: x.name, size: x.size || 0 })));
      // only what the phone says it deleted (a test backend answers with a count)
      const gone = new Set(Array.isArray(said) ? said : ids);
      // by default they stay where they were, marked deleted - a duplicates group still shows what it held
      // (another phone opened meanwhile: these ids are not its files)
      if (dev && dev.id === phone) {
        if (S.phoneHideDeleted) { items = items.filter((x) => !gone.has(x.id)); if (index) index = index.filter((x) => !gone.has(x.id)); }
        else for (const x of [...items, ...(index || [])]) if (gone.has(x.id)) x.deleted = true;
        for (const id of gone) sel.delete(id);
      }
      const freed = p.reduce((s, it) => s + (gone.has(it.id) ? it.size || 0 : 0), 0);
      app.toast(`Deleted ${gone.size} from the phone · ${size(freed)} freed${gone.size < p.length ? ` · ${p.length - gone.size} left alone - changed on the phone since, or it kept them; scan it again` : ""}`, { ms: gone.size < p.length ? 8000 : 4000 });
      paint();
    } catch (e) { app.toast("Could not delete: " + e, { kind: "error", ms: 6000 }); }
  }
  /* ── compressing on the phone ───────────────────────────────────────────
     Asked how (videos: H.264 or H.265, gentle or strong; photos: a JPEG
     quality); each file is fetched, a smaller copy made beside it on this
     computer, and the results listed - before and after, side by side on a
     click. Only Apply changes the phone: each copy goes in its original's
     place, same folder, same name, same kind of file, its dates and details
     kept, so the gallery shows it where it was. */
  // the Compress panel: what to make smaller (what was picked, or the biggest videos and photos
  // once the phone is scanned), how, the results before and after, and Apply
  let cx = null; // { files, codec, level, photo, job, rows: Map, running, finished, applying, open }
  function compress() {
    const p = picked().filter((x) => kindOf(x) === "photo" || kindOf(x) === "video");
    const last = S.phoneCompress || {};
    if (cx && cx.applying) return setMode("compress");
    if (cx && cx.job && host.phoneCompressDiscard) host.phoneCompressDiscard(cx.job).catch(() => {});
    if (!cx || cx.job) cx = { files: [], codec: last.codec || "h264", level: last.level || "gentle", photo: last.photo || 0.88, job: 0, rows: new Map() };
    if (p.length) cx.files = p;
    setMode("compress");
  }
  const workUrl = (f) => (phoneBase() ? `${phoneBase()}work?f=${encodeURIComponent(f)}` : "");
  function paintCompress() {
    if (!cx) { const last = S.phoneCompress || {}; cx = { files: [], codec: last.codec || "h264", level: last.level || "gentle", photo: last.photo || 0.88, job: 0, rows: new Map() }; }
    const seg = (opts, now, set) => { const w = h("div", { class: "segmented is-small" }); for (const [v, n] of opts) w.append(h("button", { class: "seg" + (now === v ? " is-active" : ""), onclick: () => { set(v); paintCompress(); } }, n)); return w; };
    const files = cx.files;
    const nv = files.filter((x) => kindOf(x) === "video").length, np = files.length - nv;
    const suggest = index ? index.filter((x) => (kindOf(x) === "video" || /\.jpe?g$/i.test(x.name)) && x.size > 3 << 20).sort((a, b) => b.size - a.size).slice(0, 40) : [];
    const left = h("div", { class: "ph-cx-side-l" });
    if (!cx.job) {
      left.append(...[
        h("div", { class: "ph-cx-h", text: files.length ? `${files.length} to make smaller · ${size(files.reduce((s, x) => s + x.size, 0))}` : "Nothing picked yet" }),
        files.length ? h("div", { class: "ph-cx-list" }, ...files.map((x) => h("div", { class: "ph-cx-row" }, h("span", { class: "ph-cx-name", text: x.name }), h("span", { class: "ph-cx-size", text: size(x.size) }), h("button", { class: "icon-btn", title: "Leave it out", onclick: () => { cx.files = cx.files.filter((y) => y !== x); paintCompress(); } }, icon("x")))))
          : h("div", { class: "ph-dim", text: "Pick photos and videos in Folders, Photos, Videos or Largest and press Compress… - or take the biggest ones below." }),
        !files.length && suggest.length ? h("button", { class: "btn", onclick: () => { cx.files = suggest; paintCompress(); } }, icon("chart"), `The ${suggest.length} biggest videos and photos`) : null,
        !files.length && !index ? h("button", { class: "btn", onclick: () => { setMode("largest"); if (!scanning) scan(); } }, icon("search"), "Scan the phone to find them") : null].filter(Boolean));
    }
    const settings = h("div", { class: "ph-cx-set" },
      h("div", { class: "ph-set-lab", text: "Videos" }),
      seg([["h264", "H.264 - plays everywhere"], ["h265", "H.265 - about half the size"]], cx.codec, (v) => { cx.codec = v; }),
      seg([["gentle", "Gentle - you cannot tell"], ["strong", "Strong - smaller"]], cx.level, (v) => { cx.level = v; }),
      h("div", { class: "ph-set-lab", text: "Photos (JPEG; a HEIC is already small and left alone)" }),
      seg([[0.92, "Best (92%)"], [0.88, "High (88%)"], [0.82, "Smaller (82%)"]], cx.photo, (v) => { cx.photo = v; }),
      h("p", { class: "ph-dim", text: "Each is fetched to this computer, made smaller and shown before and after. Nothing on the phone changes until Apply, which puts each ticked copy in its original's place - same folder, same name, same kind of file, its date and details kept - so the gallery shows it where it was. The copies kept here meanwhile are removed afterwards." }),
      !cx.job ? h("button", { class: "btn btn-primary", disabled: !files.length, onclick: runCompress }, icon("shrink"), `Make the copies${files.length ? ` (${files.length})` : ""}`) : null);
    if (cx.job) {
      const all = [...cx.rows.values()];
      const ready = all.filter((r) => r.state === "ready");
      const on = ready.filter((r) => r.on !== false);
      const saved = on.reduce((s, r) => s + (r.before - r.after), 0);
      const here = dev && dev.id === cx.dev;
      left.append(
        h("div", { class: "ph-cx-h", text: cx.finished ? `${ready.length} of ${all.length} can be smaller${on.length ? ` · ${size(saved)} saved on the ${on.length} ticked` : ""}` : `Working on ${all.filter((r) => r.state !== "waiting").length} of ${all.length}… the phone has not changed` }),
        h("div", { class: "ph-cx-list" }, ...all.map((r) => {
          const pct = r.after && r.before ? Math.round((1 - r.after / r.before) * 100) : 0;
          const row = h("div", { class: "ph-cx-row is-" + r.state + (cx.open === r.it.id ? " is-open" : "") },
            r.state === "ready" ? h("input", { type: "checkbox", checked: r.on !== false, onclick: (e) => { e.stopPropagation(); r.on = e.target.checked; paintCompress(); } }) : h("span", { class: "ph-cx-dot" }),
            h("span", { class: "ph-cx-name", text: r.it.name }),
            h("span", { class: "ph-cx-size", text: r.state === "ready" ? `${size(r.before)} → ${size(r.after)} (−${pct}%)` : r.state === "skipped" || r.state === "failed" ? r.why || r.state : r.state === "reading" ? "reading off the phone…" : r.state === "compressing" ? "compressing…" : r.state === "applied" ? `on the phone · ${size(r.after)}` : "waiting" }));
          if (r.state === "ready") row.addEventListener("click", () => { cx.open = r.it.id; paintCompress(); });
          return row;
        })),
        h("div", { class: "ph-cx-foot" },
          h("button", { class: "btn", disabled: !!cx.applying, onclick: discardCompress }, cx.finished ? "Discard and start over" : "Stop and discard"),
          h("span", { class: "ph-gap" }),
          h("button", { class: "btn btn-primary", disabled: !cx.finished || !on.length || cx.applying || !here, onclick: applyCompress }, cx.applying ? "Putting them on the phone…" : !here ? "Apply needs the phone these came from" : `Apply to the phone (${on.length})`)));
    }
    // before and after, side by side
    const open = cx.job && cx.open && cx.rows.get(cx.open);
    const cmp = h("div", { class: "ph-cx-cmp" });
    if (open && open.state === "ready") {
      const k = kindOf(open.it);
      const one = (label, url) => h("div", { class: "ph-cx-sideb" }, h("div", { class: "ph-dim", text: label }),
        k === "video" ? h("video", { src: url, controls: true, muted: true, playsInline: true, class: "ph-cx-media" }) : h("img", { src: url, class: "ph-cx-media", alt: "" }));
      cmp.append(one(`Now · ${size(open.before)}`, workUrl(open.orig)), one(`Compressed · ${size(open.after)} (−${Math.round((1 - open.after / open.before) * 100)}%)`, workUrl(open.out)));
      const vs = cmp.querySelectorAll("video");
      if (vs.length === 2) { vs[0].addEventListener("play", () => { vs[1].currentTime = vs[0].currentTime; vs[1].play(); }); vs[0].addEventListener("pause", () => vs[1].pause()); vs[0].addEventListener("seeked", () => { vs[1].currentTime = vs[0].currentTime; }); }
    } else if (cx.job) cmp.append(h("div", { class: "ph-dim ph-cx-hint", text: cx.finished ? "Click a file on the left to see it before and after, side by side." : "The results come in one by one." }));
    panel.replaceChildren(h("div", { class: "ph-cx-grid" }, h("div", { class: "ph-cx-colL" }, left), h("div", { class: "ph-cx-colR" }, cx.job ? cmp : settings)));
  }
  let offCx = null;
  async function runCompress() {
    const files = cx.files;
    if (!files.length) return;
    if (files.some((x) => kindOf(x) === "video")) {
      const ff = await (await import("./tools.js")).ensureTool(app, "ffmpeg", "Compressing videos");
      if (!ff && !files.some((x) => kindOf(x) === "photo")) return;
    }
    app.setSetting("phoneCompress", { codec: cx.codec, level: cx.level, photo: cx.photo });
    cx.job = Date.now();
    cx.dev = dev.id;
    cx.rows = new Map(files.map((x) => [x.id, { it: x, state: "waiting" }]));
    cx.finished = false;
    if (!offCx && host.on) offCx = host.on("phone:compress", (ev) => {
      const d = ev && (ev.payload || ev);
      if (!d || !cx || d.job !== cx.job) return;
      if (d.finished) cx.finished = true;
      else { const r = cx.rows.get(d.id); if (r) Object.assign(r, d); }
      if (mode === "compress") paintCompress();
    });
    paintCompress();
    try { await host.phoneCompress(cx.dev, files.map((x) => ({ id: x.id, name: x.name, size: x.size })), cx.codec, cx.level, cx.photo, cx.job); }
    catch (e) { app.toast("Could not start: " + e, { kind: "error", ms: 8000 }); cx.job = 0; paintCompress(); }
  }
  function discardCompress() {
    if (cx && cx.job && host.phoneCompressDiscard) host.phoneCompressDiscard(cx.job).catch(() => {});
    cx = { files: [], codec: cx.codec, level: cx.level, photo: cx.photo, job: 0, rows: new Map() };
    paintCompress();
  }
  async function applyCompress() {
    const on = [...cx.rows.values()].filter((r) => r.state === "ready" && r.on !== false);
    if (!on.length) return;
    if (!(await confirmDialog(`Replace ${on.length} on the phone?`, "Each original goes and its compressed copy takes its place - same folder, same name, its date kept. The full-quality originals go to this computer's Recycle Bin. If the phone refuses a copy, the original is put back.", { ok: "Replace", danger: false, safe: true }))) return;
    cx.applying = true;
    paintCompress();
    // one call per folder: each copy goes where its original was
    const byParent = new Map();
    for (const r of on) { const pr = r.it.parent != null ? r.it.parent : (trail.length ? trail[trail.length - 1].id : ""); (byParent.get(pr) || byParent.set(pr, []).get(pr)).push(r); }
    let done = 0, freed = 0;
    const errs = [];
    for (const [parent, rs] of byParent) {
      try {
        const res = await host.phoneCompressApply(cx.dev, parent, rs.map((r) => ({ id: r.it.id, name: r.it.name })), cx.job);
        for (const r of rs) {
          const n = res.ids && res.ids[r.it.id];
          if (!n) continue;
          r.state = "applied"; done++; freed += r.before - r.after;
          if (dev && dev.id === cx.dev) for (const list of [items, index || []]) { const it = list.find((x) => x.id === r.it.id); if (it) { it.id = n.id; it.size = n.size; } }
          foundMemo = null; // sizes changed in place: Largest and the size filters work it out again
          dupesGen++; // and the copies: a compressed file is no longer a copy of the ones it matched
        }
        errs.push(...(res.errors || []));
      } catch (e) { errs.push(String(e)); }
    }
    cx.applying = false;
    // nothing left to apply: the copies kept on this computer go (a failed row stays "ready", its files with it)
    if (host.phoneCompressDiscard && ![...cx.rows.values()].some((r) => r.state === "ready")) host.phoneCompressDiscard(cx.job).catch(() => {});
    if (errs.length) app.toast(errs.join(" · "), { kind: "error", ms: 12000 });
    app.toast(`${done} made smaller on the phone · ${size(freed)} freed`, { ms: 5000 });
    paintCompress();
  }

  function paintProgress() {
    paintPill();
    progress.hidden = !busy;
    if (!busy) return;
    const pct = busy.total ? Math.round((busy.done / busy.total) * 100) : 0;
    progress.replaceChildren(h("div", { class: "ph-dim", text: `${busy.remove ? "Moving" : "Copying"} ${busy.done} of ${busy.total}${busy.name ? ` · ${busy.name}` : ""}${busy.failed ? ` · ${busy.failed} could not` : ""}` }),
      h("div", { class: "ph-capbar" }, h("i", { style: { width: pct + "%" } })));
  }

  let started = false;
  return {
    show() { paintPill(); if (!started) { started = true; findDevices(); } },
    destroy() { io.disconnect(); moreIo.disconnect(); pill.remove(); for (const f of [off, offCopy, offScan, offCx]) if (f && typeof f.then === "function") f.then((u) => typeof u === "function" && u()).catch(() => {}); },
  };
}
