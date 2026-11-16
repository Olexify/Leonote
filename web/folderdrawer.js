// The folder drawer: the other files of the folder the open file lies in, as a
// quiet strip along the bottom of a file tab. Pictures show themselves, the
// rest show an icon and a name. It is one element for as long as the tab stays
// in the same folder, so stepping through files does not make it blink or
// fall shut under the pointer.
import { h, dirname } from "./util.js";
import { icon } from "./icons.js";
import { menu } from "./ui.js";

const ICON = { image: "image", pdf: "fileText", office: "file", text: "fileText", media: "play", other: "file" };
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i;
const MAX = 600; // tiles at most, taken around the open file

/** "hover" (a grip at the edge brings it up), "open" (always there) or "off". */
export const drawerMode = (app) => (["hover", "open", "off"].includes(app.settings.fileDrawer) ? app.settings.fileDrawer : "hover");

/** A vertical wheel moves a horizontal strip - over the tiles too, not just the bar. */
export function wheelSideways(strip) {
  strip.addEventListener("wheel", (e) => {
    if (e.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    strip.scrollLeft += e.deltaMode === 1 ? d * 32 : d;
  }, { passive: false });
}

// what the type chips sort a file under
const TYPES = [["image", "Pictures", "image"], ["video", "Videos", "play"], ["audio", "Music", "music"], ["pdf", "PDFs", "fileText"], ["office", "Documents", "file"], ["text", "Text", "fileText"], ["other", "Other", "file"]];
export const typeOf = (f) => (f.kind === "media" ? (AUDIO.test(f.path) ? "audio" : "video") : TYPES.some(([t]) => t === f.kind) ? f.kind : "other");

const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);

export function folderFiles(app, path) {
  const dir = dirname(path);
  const all = [...app.vault.files.values()]
    .filter((f) => dirname(f.path) === dir && !/\.(edits|leoedit)\.json$/i.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return all;
}

function around(all, path) {
  if (all.length <= MAX) return all;
  const at = Math.max(0, all.findIndex((f) => f.path === path));
  const from = Math.max(0, Math.min(all.length - MAX, at - MAX / 2));
  return all.slice(from, from + MAX);
}

export function mountDrawer(app, { open }) {
  let key = null; // the folder's files as last drawn
  let current = null;
  let downT = 0;
  const strip = h("div", { class: "fd-strip" });
  const count = h("span", { class: "fd-count" });
  const types = h("div", { class: "fd-types" });
  // "auto": only files of the open file's type; "all"; or the types picked by hand
  let want = app.settings.fileDrawerTypes === "all" ? "all" : "auto";
  const grip = h("button", { class: "fd-grip", title: "The other files of this folder. Right-click to keep it open or switch it off", "aria-label": "Folder drawer" }, h("i"));
  const el = h("div", { class: "fd" }, grip, h("div", { class: "fd-tray" }, types, strip, count));
  wheelSideways(strip);

  const up = () => { clearTimeout(downT); el.classList.add("is-up"); };
  const down = () => { clearTimeout(downT); downT = setTimeout(() => el.classList.remove("is-up"), 420); };
  el.addEventListener("pointerenter", up);
  el.addEventListener("pointerleave", down);
  grip.addEventListener("click", () => el.classList.toggle("is-up"));

  const setMode = (m) => app.setSetting("fileDrawer", m);
  const modeMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const m = drawerMode(app);
    menu(e.clientX, e.clientY, [
      { header: "Folder drawer" },
      { label: "Comes up at the edge", icon: "chevronDown", checked: m === "hover", run: () => setMode("hover") },
      { label: "Always open", icon: "film", checked: m === "open", run: () => setMode("open") },
      { label: "Off", icon: "x", checked: m === "off", run: () => setMode("off") },
    ]);
  };
  el.addEventListener("contextmenu", modeMenu);

  function paintMode() {
    const m = drawerMode(app);
    el.dataset.mode = m;
    el.hidden = m === "off" || (strip.children.length < 2 && types.hidden);
  }

  function tile(f) {
    const name = nameOf(f.path);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 5) : "";
    const pic = f.kind === "image";
    const b = h("button", { class: "fd-tile" + (pic ? " is-pic" : ""), title: name, dataset: { path: f.path } },
      pic ? h("img", { src: app.host.assetUrl(f.path), loading: "lazy", decoding: "async", draggable: false, alt: "" })
        : [icon(f.kind === "media" && AUDIO.test(name) ? "music" : ICON[f.kind] || "file"), h("span", { class: "fd-ext", text: ext }), h("span", { class: "fd-name", text: dot > 0 ? name.slice(0, dot) : name })]);
    b.addEventListener("click", (e) => { e.stopPropagation(); if (f.path !== current) open(f.path); });
    return b;
  }

  function mark(smooth) {
    let at = -1;
    [...strip.children].forEach((t, k) => { const on = t.dataset.path === current; t.classList.toggle("is-current", on); if (on) at = k; });
    count.textContent = at >= 0 ? `${at + 1} / ${strip.children.length}` : "";
    const t = strip.children[at];
    if (t) strip.scrollTo({ left: t.offsetLeft - (strip.clientWidth - t.offsetWidth) / 2, behavior: smooth ? "smooth" : "auto" });
  }

  return {
    el,
    /** Show the folder of `path`; the tiles are rebuilt only when the folder changes. */
    show(path) {
      // an editor has its own bar along the bottom (the timeline): the drawer keeps to the top there
      el.classList.toggle("is-top", /\.(leovideo|leopaint|leocanvas|leostudio|leovector|excalidraw|canvas)$/i.test(path));
      const every = folderFiles(app, path);
      const mine = typeOf(every.find((f) => f.path === path) || { kind: "other", path });
      const on = (t) => (want === "all" ? true : want === "auto" ? t === mine : want.has(t) || t === mine);
      const list = around(every.filter((f) => on(typeOf(f))), path);
      // the chips: one for each type the folder holds
      const have = TYPES.filter(([t]) => every.some((f) => typeOf(f) === t));
      const pick = (t) => {
        if (t === "all") want = want === "all" ? "auto" : "all";
        else {
          const set = want === "all" ? new Set(have.map(([x]) => x)) : want === "auto" ? new Set([mine]) : new Set(want);
          set.has(t) ? set.delete(t) : set.add(t);
          set.delete(mine);
          want = set.size ? (set.add(mine), set) : "auto";
        }
        app.setSetting("fileDrawerTypes", want === "all" ? "all" : "auto");
        this.show(current);
      };
      types.hidden = have.length < 2;
      types.replaceChildren(
        h("button", { class: "fd-type" + (want === "all" ? " is-on" : ""), title: "Every file of the folder", onclick: (e) => { e.stopPropagation(); pick("all"); } }, "All"),
        ...have.map(([t, label, ic]) => h("button", { class: "fd-type" + (want !== "all" && on(t) ? " is-on" : ""), title: `${label} · ${every.filter((f) => typeOf(f) === t).length}${t === mine ? " - the type that is open" : ""}`, onclick: (e) => { e.stopPropagation(); pick(t); } }, icon(ic))));
      const k = list.map((f) => f.path).join("|");
      const same = k === key;
      current = path;
      if (!same) { key = k; strip.replaceChildren(...list.map(tile)); }
      paintMode();
      requestAnimationFrame(() => mark(same));
    },
    paintMode,
    modeMenu,
  };
}
