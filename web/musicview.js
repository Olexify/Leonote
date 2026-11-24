// The Player: every song and video in the vault plus online media, one
// queue, playlists, and a now-playing panel. The engine is app.media; this
// view only draws it, and does no work while hidden (updates are marked and
// painted on the next show).

import { tagsDialog, detailsDialog, tagsOf, tagCounts, taggable, AUDIO_FILE } from "./songtags.js";
import { syncYtList, syncSaid } from "./ytsync.js";
import { soundEngine, mountSoundLab } from "./soundlab.js";
import { MOODS } from "./soundanalysis.js";
import { h, debounce, isTyping, naturalCompare, relTime, safeName, animateRows, pressable, keyOf } from "./util.js";
import { icon } from "./icons.js";
import { sortable, inlineEdit, confirmDialog, askDialog, menu } from "./ui.js";
import { AUDIO, SPEEDS, fmtTime, togglePip } from "./media.js";
import { peekMeta, guessMeta, loadMeta, folderCover, coverUrl } from "./mediameta.js";
import { gradientFor, isYt, isUrl, isOnline, isLib, libPath, libKey, urlOf, ytIdOf, ytKey, urlKey, parseDirect, looksLikeUrl, terms, matchesAll, markRanges, fromM3u } from "./playqueue.js";
import { parseYouTube, ytTitle } from "./youtube.js";
import { bareDomain, readYtList, findYtVideo } from "./sources.js";
import { mountWebTab, searchUrl as webSearchUrl, toUrl } from "./webtab.js";
import { addonButtons } from "./webaddons.js";
import { matchTracks, shazamTracks } from "./matchtracks.js";
import { pickFolder } from "./newtab.js";

// a few glyphs icons.js does not have, drawn the same way (24px, 1.7 stroke)
const G = {
  shuffle: '<path d="M16 4h4v4M4 20L20 4M20 16v4h-4M14.5 14.5L20 20M4 4l5 5"/>',
  prev: '<path d="M6 5v14"/><path d="M19 5.5v13L9 12z" fill="currentColor"/>',
  next: '<path d="M18 5v14"/><path d="M5 5.5v13L15 12z" fill="currentColor"/>',
  play: '<path d="M7.5 4.8v14.4a.6.6 0 0 0 .9.5l11.4-7.2a.6.6 0 0 0 0-1L8.4 4.3a.6.6 0 0 0-.9.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  repeatOne: '<path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-1a5 5 0 0 1 5-5h11M7 21.5l-3-3 3-3"/><path d="M20 12.5v1a5 5 0 0 1-5 5H4"/><path d="M11.5 10.5l1.2-.8v4.8" stroke-width="1.5"/>',
  vol: '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  volLow: '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor"/>',
  eq: '<path d="M6 4v5M6 13v7M12 4v10M12 18v2M18 4v2M18 10v10"/><path d="M4 11h4M10 16h4M16 8h4"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>',
  audioOnly: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  queue: '<path d="M4 6h12M4 12h12M4 18h8M17 15v6l4-3z"/>',
  playlist: '<path d="M4 6h11M4 11h11M4 16h7"/><circle cx="17.5" cy="17" r="2.5"/><path d="M20 17V8l2-1"/>',
  theater: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6 9v6M18 9v6"/>',
  size: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11" width="8" height="6.5" rx="1.5"/>',
  drive: '<rect x="3" y="5" width="18" height="6" rx="2"/><rect x="3" y="13" width="18" height="6" rx="2"/><path d="M7 8h.01M7 16h.01"/>',
  full: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  unfull: '<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"/>',
};
const gi = (name, cls) => {
  const s = h("span", { class: "ico" + (cls ? " " + cls : "") });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[name]}</svg>`;
  return s;
};
const PAGE = Infinity; // every row drawn at once: a list of thousands shows whole
// how a list can be ordered; "folder" and "track" are what an album wants,
// "random" keeps one shuffled order until it is picked again
// orders where folder groups still read well; the others show a flat list
const GROUPABLE = new Set(["name", "folder", "track", "album", "artist"]);
const SORTS = [
  ["custom", "Your order"], ["random", "Random"], ["recent", "Date added"], ["duration", "Duration"],
  ["name", "Name"], ["artist", "Artist"], ["album", "Album"], ["track", "Track number"], ["size", "Size"], ["folder", "Folder"],
  ["bpm", "BPM (tempo)"], ["loudness", "Loudness"], ["energy", "Energy (tempo × loudness × busyness)"],
];
const folderOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
/** A path as the user knows it: library keys drop their "lib:" prefix. */
const showPath = (p) => (isLib(p) ? libPath(p) : p);
const leaf = (p) => p.slice(p.lastIndexOf("/") + 1) || "Vault";

export function mountMusic(app, el) {
  const M = app.media;
  const S = app.settings;
  const pref = (k, d) => (S[k] === undefined ? d : S[k]);
  let tab = pref("playerTab", "music"); // music | videos | youtube | playlists
  let sort = pref("playerSort", "name"); // see SORTS
  // Online media has its own choice, and starts free: the order the tiles are dragged into
  let onlineSort = pref("playerSortOnline", "custom");
  const curSort = () => (tab === "youtube" ? onlineSort : sort);
  let desc = !!pref("playerSortDesc", false);
  let seed = 1; // the shuffled order in "random" sorting, kept until re-picked
  let source = pref("playerSource", "all"); // "all" | "vault" | a library folder
  let showLibs = false; // the Libraries panel above the list
  let lastWords = ""; // the last plain words typed, kept while a site is offered
  let apiRun = null; // the search in flight, so a new one replaces it
  let grouped = pref("playerGroup", true);
  let query = "";
  let draft = null; // a link typed or pasted into the box: { text, key?, yt?, direct?, bad? }
  let openList = null; // a playlist being viewed
  // playing from inside a playlist names the queue after it
  const listName = () => { const pl = openList && M.playlists.all().find((p) => p.id === openList); return pl ? pl.name : null; };
  const playL = (keys, start = 0, from) => { playingPl = null; return M.playList(keys, start, from === undefined ? listName() : from); };
  /* A playlist played again goes on from the song it was left at (when that one is still in it). */
  let playingPl = null; // the playlist the queue came from, while it plays
  const playPl = (p) => {
    if (!p.items.length) return;
    const last = (S.plLast || {})[p.id];
    const at = last ? p.items.indexOf(last) : -1;
    M.playList(p.items, Math.max(0, at), p.name);
    playingPl = p.id;
    if (at > 0) app.toast(`“${p.name}” goes on where you left it`, { ms: 2200, action: { label: "From the start", run: () => { M.playList(p.items, 0, p.name); playingPl = p.id; } } });
  };
  M.bus.addEventListener("change", () => {
    if (!playingPl) return;
    const k = M.current && M.current();
    const p = k && M.playlists.all().find((x) => x.id === playingPl);
    if (!p || !p.items.includes(k) || (S.plLast || {})[p.id] === k) return;
    app.setSetting("plLast", { ...(S.plLast || {}), [p.id]: k });
  });
  let limit = PAGE;
  const sel = new Set();
  let anchorKey = null;
  let visible = false;
  const dirty = { list: true, queue: true, now: true };

  /* ── layout ──────────────────────────────────────────────────────────── */
  const tabsEl = h("div", { class: "segmented pv-tabs", role: "tablist" });
  const search = h("input", { class: "pv-search", type: "search", placeholder: "Search, or paste a link", spellcheck: false, "aria-label": "Search, or paste a link" });
  const sortBtn = h("button", { class: "chip-btn pv-sort", title: "Sort", onclick: (e) => sortMenu(e.currentTarget) });
  const dirBtn = h("button", { class: "chip-btn pv-sortdir", onclick: () => { desc = !desc; app.setSetting("playerSortDesc", desc); paintTabs(); renderList(); } });
  const groupBtn = h("button", { class: "chip-btn pv-groupby", title: "Group by folder (albums)", onclick: () => { grouped = !grouped; app.setSetting("playerGroup", grouped); renderList(); } }, "Albums");
  const foldBtn = h("button", { class: "chip-btn pv-foldall", onclick: () => foldAll(!allFolded()) });
  const sourceBtn = h("button", { class: "chip-btn pv-source", title: "Where the music comes from", onclick: (e) => sourceMenu(e.currentTarget) });
  const listBtn = h("button", { class: "icon-btn pv-listmore", title: "List options", onclick: (e) => listMenu(e.currentTarget) }, icon("more"));
  // how big the tiles draw: a slider under a small button, kept
  const TILE = () => Math.max(60, Math.min(1200, Number(S.playerTileSize) || 210));
  const sizeBtn = h("button", { class: "icon-btn pv-tilesize", title: "Tile size", onclick: (e) => tileSize(e.currentTarget) }, icon("grid"));
  // Online as tiles or as a list of rows
  const ONLINE_LIST = () => !!S.playerOnlineList;
  const viewBtn = h("button", { class: "icon-btn pv-viewbtn", onclick: () => { app.setSetting("playerOnlineList", !ONLINE_LIST()); renderList(); } });
  // your tags: a filter over the list ("" all, "#untagged" the ones still to sort, "#sfx" short sounds)
  let tagFilter = S.playerTagFilter || "";
  const tagBtn = h("button", { class: "chip-btn pv-tagbtn", title: "Show one of your tags, the songs still untagged, or short sound effects", onclick: (e) => tagMenu(e.currentTarget) });
  function tileSize(anchor) {
    document.querySelector(".pv-sizepop")?.remove();
    const r = anchor.getBoundingClientRect();
    // a number to type too: any size from 60 px up; the slider covers the usual ones
    const out = h("input", { class: "pv-sizeval pv-sizenum", type: "number", min: 60, max: 1200, step: 10, value: TILE(), title: "Any size, in pixels",
      onchange: (e) => { app.setSetting("playerTileSize", +e.target.value || 210); setTile(); e.target.value = TILE(); range.value = TILE(); },
      onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); } });
    const range = h("input", { type: "range", class: "pv-range", min: 60, max: 600, step: 10, value: TILE(), oninput: (e) => { app.setSetting("playerTileSize", +e.target.value); setTile(); out.value = TILE(); } });
    const pop = h("div", { class: "pv-sizepop" }, h("span", { class: "pv-sizelab", text: "Tiles" }), range, out,
      h("button", { class: "link-btn", onclick: () => { app.setSetting("playerTileSize", 210); range.value = 210; setTile(); out.value = 210; } }, "Reset"));
    const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener("mousedown", off, true); } };
    document.getElementById("overlay-root").append(pop);
    pop.style.left = Math.max(8, Math.min(r.right - 280, innerWidth - 288)) + "px";
    pop.style.top = r.bottom + 6 + "px";
    setTimeout(() => document.addEventListener("mousedown", off, true));
  }
  // the browser's own controls, in the same row as the box: shown while the browser is up in the Online tab
  const wantSound = () => !!S.playerBrowserSound;
  const bGo = (action) => () => { const t = bTab(); if (t) app.host.tabWebGo(t.wid, action).catch(() => {}); };
  const bToggle = h("button", { class: "chip-btn pv-btoggle", hidden: true, title: "A browser right here: any site you like. Right-click for its choices.", onclick: () => setBrowserOn(!browserOn()), oncontextmenu: (e) => browserMenu(e) }, icon("globe"), "Browser");
  const bNav = h("span", { class: "pv-bnav", hidden: true },
    h("button", { class: "icon-btn", title: "Back", onclick: bGo("back") }, icon("back")),
    h("button", { class: "icon-btn", title: "Forward", onclick: bGo("forward") }, icon("forward")),
    h("button", { class: "icon-btn", title: "Reload", onclick: bGo("reload") }, icon("rotateRight")),
    h("button", { class: "icon-btn", title: "Start page", onclick: () => browserGo("") }, icon("home")),
    h("span", { class: "pv-bsep" }),
    h("button", { class: "icon-btn", title: "Smaller (Ctrl+wheel in the page does the same)", onclick: () => bZoom(-10) }, icon("minus")),
    h("button", { class: "icon-btn", title: "Larger", onclick: () => bZoom(10) }, icon("plus")),
    h("span", { class: "pv-bsep" }),
    // the add-ons' buttons, as on the main browser's bar: the pages here are the same browser, with the same add-ons
    app.host.real ? addonButtons(app, () => (bTab() || {}).path || "") : null);
  // the zoom a page draws at: the site's own remembered one, else the setting
  const zoomHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const zoomFor = (url) => { const hosts = S.playerBrowserZoomHosts || {}; const hst = zoomHost(url); return Number(hst && hosts[hst]) || Number(S.playerBrowserZoom) || 40; };
  // Ctrl+wheel inside a page: WebView2 says where the zoom landed, and the site keeps it
  app.host.on("tabweb:zoom", (p) => {
    const t = p && bTabs.find((x) => x.wid === p.id);
    if (!t) return;
    const z = Math.round(p.zoom * 100), hst = zoomHost(t.path);
    if (hst) app.setSetting("playerBrowserZoomHosts", { ...(S.playerBrowserZoomHosts || {}), [hst]: z }); else app.setSetting("playerBrowserZoom", z);
  });
  const applyZoom = (t) => { if (t) app.host.tabWebZoom(t.wid, zoomFor(t.path) / 100).catch(() => {}); };
  const bZoom = (d) => {
    const t = bTab();
    const z = Math.max(30, Math.min(150, zoomFor(t ? t.path : "") + d));
    const hst = t ? zoomHost(t.path) : "";
    if (hst) app.setSetting("playerBrowserZoomHosts", { ...(S.playerBrowserZoomHosts || {}), [hst]: z }); else app.setSetting("playerBrowserZoom", z);
    applyZoom(t);
    app.toast(`${hst || "Browser"} ${z}%`, { ms: 900 });
  };
  /** The browser's choices, from the sound button or the Browser chip on a right-click. */
  function browserMenu(e) {
    e.preventDefault();
    menu(e.clientX, e.clientY, [
      { header: "Sound in the browser" },
      { label: "Silent", icon: "volumeOff", checked: !wantSound(), run: () => { app.setSetting("playerBrowserSound", false); applySound(); } },
      { label: "The page sounds too", icon: "volume", checked: wantSound(), run: () => { app.setSetting("playerBrowserSound", true); applySound(); } },
      "sep",
      { header: "A video opened in the browser" },
      { label: "Goes into Online media only", icon: "plus", checked: S.playerBrowserTake === "add" || S.playerBrowserTake === "play", run: () => app.setSetting("playerBrowserTake", "add") },
      { label: "Is left alone", icon: "x", checked: S.playerBrowserTake === "none", run: () => app.setSetting("playerBrowserTake", "none") },
      "sep",
      { label: "Stop the page's video when the Player plays", icon: "pause", checked: S.playerBrowserPause !== false, run: () => app.setSetting("playerBrowserPause", S.playerBrowserPause === false) },
      { label: "Keep the page in step with the Player", icon: "rotateRight", checked: false, run: () => app.toast("Not offered: the page and the Player are two players, and driving a site's own player by script is not something Leonote can do for every site.", { ms: 6000 }) },
    ].filter(Boolean));
  }
  const bSound = h("button", { class: "icon-btn pv-bsound", hidden: true, onclick: () => { app.setSetting("playerBrowserSound", !wantSound()); applySound(); }, oncontextmenu: browserMenu }, icon("volumeOff"));
  const paintSoundBtn = () => { bSound.replaceChildren(icon(wantSound() ? "volume" : "volumeOff")); bSound.classList.toggle("is-on", wantSound()); bSound.title = wantSound() ? "The page sounds too - click for silence (right-click for the choice)" : "Silent - click to let the page sound (right-click for the choice)"; };
  paintSoundBtn();
  const bStripEl = h("span", { class: "pv-bstrip", hidden: true });
  bStripEl.addEventListener("wheel", (e) => { if (e.deltaY && !e.shiftKey) { e.preventDefault(); bStripEl.scrollLeft += e.deltaY; } }, { passive: false });
  /** The address, short while nobody is in the box (the site alone), whole once it is. */
  const paintAddress = () => {
    const t = bTab(); const u = t ? t.path : "";
    const focused = document.activeElement === search;
    search.value = focused ? u : (u ? hostOfUrl(u) || u : "");
    if (!focused) { try { search.setSelectionRange(0, 0); } catch {} } // no greyed selection left behind once the box has folded
  };
  const bClose = h("button", { class: "icon-btn pv-bclose", hidden: true, title: "Close the browser (the Browser chip brings it back)", onclick: () => setBrowserOn(false) }, icon("x"));
  search.addEventListener("blur", () => { if (browserMode()) setTimeout(paintAddress, 80); });
  search.addEventListener("mouseenter", () => { if (browserMode() && document.activeElement !== search) { const t = bTab(); if (t && t.path) search.value = t.path; } });
  search.addEventListener("mouseleave", () => { if (browserMode() && document.activeElement !== search) paintAddress(); });
  // the page took the focus (the child view does not blur a DOM input by itself): fold the box
  app.bus.on("extpop:blur", () => { if (browserMode() && document.activeElement === search) search.blur(); });
  const browserMode = () => tab === "youtube" && browserOn();
  const toolsGap = h("span", { class: "trash-gap" });
  // in browser mode the big box is the address bar, so the list keeps a small one of its own beside the tabs
  const mini = h("input", { class: "pv-minisearch", type: "search", placeholder: "Filter the list", spellcheck: false, "aria-label": "Filter the list" });
  mini.addEventListener("input", debounce(() => { if (query === mini.value) return; query = mini.value; draft = null; limit = PAGE; renderList(); }, 120));
  mini.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { mini.value = ""; query = ""; renderList(); mini.blur(); } });
  // what was removed this session comes back with Ctrl+Z, last first
  const undos = [];
  function paintToolsMode() {
    const bm = browserMode();
    root.classList.toggle("is-bmode", bm);
    bToggle.hidden = tab !== "youtube";
    bToggle.classList.toggle("is-on", browserOn());
    bNav.hidden = bStripEl.hidden = bClose.hidden = bSound.hidden = !bm;
    const tabsRow = tabsEl.parentElement;
    if (bm && tabsRow && !tabsRow.contains(sortBtn)) { mini.value = query; tabsRow.append(mini, toolsGap, sourceBtn, tagBtn, sortBtn, dirBtn, viewBtn, sizeBtn, groupBtn, foldBtn, listBtn); }
    else if (!bm && tabsRow && tabsRow.contains(sortBtn)) { mini.remove(); toolsGap.remove(); bClose.parentElement.append(sourceBtn, tagBtn, sortBtn, dirBtn, viewBtn, sizeBtn, groupBtn, foldBtn, listBtn); }
    search.placeholder = bm ? "Address, or words to search" : "Search, or paste a link";
    if (bm) { ensureBrowser(); paintBStrip(); if (document.activeElement !== search) paintAddress(); }
    else if (search.value !== query) search.value = query;
  }
  /** The browser and the theater take turns: one opening puts the other away. */
  function setBrowserOn(on) {
    app.setSetting("playerBrowser", !!on);
    if (on && fullscreen) setFullscreen(false);
    if (on && vsize() === "large") setVideoSize("small");
    renderList();
    syncBrowser();
  }
  const selBar = h("div", { class: "pv-selbar", hidden: true });
  const listEl = h("div", { class: "pv-list", tabIndex: -1 });
  const lib = h("section", { class: "pv-lib" },
    h("header", { class: "pv-head" },
      h("div", { class: "pv-titlerow" }, h("h1", { class: "vh-title", text: "Player" }), h("span", { class: "pv-count" })),
      h("div", { class: "pv-tools" }, tabsEl),
      h("div", { class: "pv-tools pv-tools-main" }, bToggle, bNav, h("label", { class: "pv-searchbox" }, icon("search"), search), bStripEl, bSound, bClose, sourceBtn, tagBtn, sortBtn, dirBtn, viewBtn, sizeBtn, groupBtn, foldBtn, listBtn),
      selBar),
    listEl);

  // now playing
  const stage = h("div", { class: "pv-stage" });
  const ytAnchor = h("div", { class: "pv-yt-anchor" });
  const nTitle = h("div", { class: "pv-n-title" });
  const nSub = h("div", { class: "pv-n-sub" });
  const tNow = h("span", { class: "pv-t" });
  const tDur = h("span", { class: "pv-t is-dur", title: "Click: time left / whole length", onclick: () => { showLeft = !showLeft; paintTime(); } });
  const seekFill = h("div", { class: "pv-seek-fill" });
  const seekBuf = h("div", { class: "pv-seek-buf" }); // how much has arrived
  const seekKnob = h("div", { class: "pv-seek-knob" });
  const seekHover = h("div", { class: "pv-seek-tip" });
  const seek = h("div", { class: "pv-seek", role: "slider", "aria-label": "Seek", tabIndex: 0 }, h("div", { class: "pv-seek-track" }, seekBuf, seekFill), seekKnob, seekHover);
  // a big play / pause that pops in the middle of the picture for a moment, as players do
  const flash = h("div", { class: "pv-flash", hidden: true });
  let flashTimer = 0;
  function flashState() {
    if (!theater && !fullscreen) return;
    flash.replaceChildren(gi(M.playing() ? "play" : "pause"));
    flash.hidden = false;
    flash.classList.remove("is-go"); void flash.offsetWidth; flash.classList.add("is-go");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; }, 600);
  }
  // the end time shows what is left when clicked
  let showLeft = false;
  const tb = (g, title, run, cls = "") => h("button", { class: "pv-tb " + cls, title, onclick: run }, gi(g));
  const shuffleBtn = tb("shuffle", "Shuffle (S)", () => M.setShuffle(!M.queue.shuffle));
  const prevBtn = tb("prev", "Previous (Shift+← or ↑)", () => M.prev());
  const playBtn = h("button", { class: "pv-play", title: "Play / pause (Space)", onclick: () => M.toggle() }, gi("play"));
  const nextBtn = tb("next", "Next (Shift+→ or ↓)", () => M.next());
  const repeatBtn = h("button", { class: "pv-tb", title: "Repeat (R)", onclick: () => M.cycleRepeat() }, icon("repeat"));
  const muteBtn = h("button", { class: "pv-tb is-sm", title: "Mute (M)", onclick: () => M.toggleMute() }, gi("vol"));
  const vol = h("input", { class: "pv-range pv-vol", type: "range", min: 0, max: 1, step: 0.01, "aria-label": "Volume", title: "Volume (Shift+↑/↓)", oninput: (e) => M.setVolume(+e.target.value) });
  const speedBtn = h("button", { class: "chip-btn pv-chip", title: "Playback speed", onclick: (e) => speedMenu(e.currentTarget) });
  const sleepBtn = h("button", { class: "chip-btn pv-chip", title: "Sleep timer", onclick: (e) => sleepMenu(e.currentTarget) }, icon("moon"));
  const eqBtn = h("button", { class: "pv-tb is-sm", title: "Sound: tempo, pitch, BPM and key, loop, equalizer, effects", onclick: () => toggleEq() }, gi("eq"));
  const vizBtn = h("button", { class: "pv-tb is-sm", title: "Visualizer", onclick: () => toggleViz() }, gi("wave"));
  // A video is ONE picture and can be in one place at a time: docked, in the
  // theater, in the popup player or in picture in picture. The two that leave
  // the page take turns - starting one puts the other away.
  const pipBtn = h("button", { class: "pv-tb is-sm", title: "Picture in picture", onclick: () => { if (vsize() === "float" && !document.pictureInPictureElement) pickSize("float"); togglePip(M.videoEl()); } }, gi("pip"));
  document.addEventListener("enterpictureinpicture", () => { if (vsize() === "float") pickSize("float"); paintModes(); }, true);
  document.addEventListener("leavepictureinpicture", () => paintModes(), true);
  // Where the picture is: three places and full screen, a button each. Theater
  // or the popup pressed again falls back to the docked player.
  // Docked is simply what the player is when neither Theater nor full screen is
  // on - it needs no button. The popup is its own switch: turned off, the
  // picture goes back to where it was before (docked, or the theater).
  // Popup player, Theater and Full screen take turns: turning one on turns the
  // others off, and the one that is on, pressed again, leaves the docked player.
  const pickSize = (id) => {
    const wasFull = fullscreen;
    if (fullscreen) setFullscreen(false);
    if (id === "float" && document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    setVideoSize(vsize() === id && !wasFull ? "small" : id);
  };
  const popBtn = h("button", { class: "pv-tb is-sm", title: "Popup player: a small player you can drag anywhere (P)", onclick: () => pickSize("float") }, icon("layers"));
  const theaterBtn = h("button", { class: "pv-tb is-sm", title: "Theater: the video leads, the list follows below (T)", onclick: () => pickSize("large") }, gi("theater"));
  const fullBtn = h("button", { class: "pv-tb is-sm", title: "Full screen (F)", onclick: () => { if (!fullscreen && vsize() !== "small") setVideoSize("small"); setFullscreen(!fullscreen); } }, gi("full"));
  const exitBtn = h("button", { class: "pv-tb is-sm pv-exit", title: "Leave full screen (Esc)", onclick: () => setFullscreen(false) }, icon("x"));
  // the mini player: a small window of Leonote's own that stays on top of other programs
  const miniBtn = h("button", { class: "pv-tb is-sm", title: "Mini player on top of other windows - resizable down to a small button", onclick: () => M.miniPlayer && M.miniPlayer() }, icon("outside"));
  // "Audio only" is gone (it opened YouTube's own small player inside the popup): a setting left on goes off
  if (S.playerYtAudio) app.setSetting("playerYtAudio", false);
  const eqPanel = h("div", { class: "pv-eq", hidden: true });
  const viz = h("canvas", { class: "pv-viz", hidden: true });
  const qList = h("div", { class: "pv-q-list" });
  const qCount = h("span", { class: "pv-q-count" });
  const qFrom = h("span", { class: "pv-q-from" });
  // a search through the queue (a long playlist): only what matches is listed, a click plays it there
  const qFindIn = h("input", { class: "pv-q-find-in", type: "search", placeholder: "Find in the queue", spellcheck: "false" });
  const qFind = h("label", { class: "pv-q-find" }, icon("search"), qFindIn);
  qFindIn.addEventListener("input", debounce(() => renderQueue(), 120)); // a long queue is drawn once typing pauses, like the list filter
  qFindIn.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && qFindIn.value) { e.stopPropagation(); qFindIn.value = ""; renderQueue(); }
    else if (e.key === "Enter") { const r = qList.querySelector(".pv-qrow"); if (r) r.click(); }
  });
  /* The player's controls out of sight: a slim strip at the top of the panel - what plays, previous / play /
     next, and ↑ back to the player. It takes no room, so showing it moves nothing. */
  const peekPlay = h("button", { class: "pv-tb is-sm", title: "Play / pause", onclick: () => M.toggle() }, gi("play"));
  const peekTitle = h("span", { class: "pv-peek-title" });
  const peekArt = h("span", { class: "pv-peek-art" });
  // where the song is: a thin line along the strip, thicker under the pointer - click or drag it to move
  const peekFill = h("span", { class: "pv-peek-fill" });
  const peekBar = h("span", { class: "pv-peek-bar", title: "Click or drag to move in the song" }, peekFill);
  const peekAt = (e) => { const r = peekBar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const paintPeekTime = (f) => { const d = M.duration(); peekFill.style.width = (f != null ? f : d > 0 ? Math.min(1, M.time() / d) : 0) * 100 + "%"; };
  let peekDrag = false;
  peekBar.addEventListener("pointerdown", (e) => { if (e.button !== 0 || !(M.duration() > 0)) return; e.preventDefault(); e.stopPropagation(); peekDrag = true; peekBar.setPointerCapture(e.pointerId); paintPeekTime(peekAt(e)); });
  peekBar.addEventListener("pointermove", (e) => { if (peekDrag) paintPeekTime(peekAt(e)); });
  for (const ev of ["pointerup", "pointercancel"]) peekBar.addEventListener(ev, (e) => { if (!peekDrag) return; peekDrag = false; if (ev === "pointerup") M.seek(peekAt(e) * M.duration()); paintPeekTime(); });
  peekBar.addEventListener("click", (e) => e.stopPropagation());
  // the strip itself (not its buttons): back up to the player - a slide when it is near, at once from far down
  const toPlayer = () => (now.scrollTop > 2500 ? (now.scrollTop = 0) : now.scrollTo({ top: 0, behavior: "smooth" }));
  const peek = h("div", { class: "pv-peek", "aria-hidden": "true", title: "Back to the player", onclick: (e) => { if (!e.target.closest("button")) toPlayer(); } },
    peekArt, peekTitle,
    h("button", { class: "pv-tb is-sm", title: "Show it in the queue", onclick: () => showCurrent() }, icon("target")),
    h("button", { class: "pv-tb is-sm", title: "Previous", onclick: () => M.prev() }, gi("prev")), peekPlay,
    h("button", { class: "pv-tb is-sm", title: "Next", onclick: () => M.next() }, gi("next")),
    h("button", { class: "pv-tb is-sm", title: "Back to the player", onclick: toPlayer }, icon("arrowUp")),
    peekBar);
  /** The song playing, brought into view in the queue (a queue of thousands is a long way to scroll). */
  const showCurrent = () => {
    if (qFindIn.value) { qFindIn.value = ""; renderQueue(); }
    const c = qList.querySelector(".pv-qrow.is-current");
    if (c) c.scrollIntoView({ block: "center" });
  };
  const paintPeek = () => {
    const k = M.current();
    const m = k ? metaFor(k) : null;
    peekTitle.textContent = m ? m.title || leaf(k) : "";
    peekArt.replaceChildren(k ? art(k, "is-xs") : "");
    peekPlay.replaceChildren(gi(M.playing() ? "pause" : "play"));
    paintPeekTime();
  };
  const now = h("aside", { class: "pv-now" },
    peek,
    stage,
    h("div", { class: "pv-n-meta", oncontextmenu: (e) => { const k = M.current(); if (!k) return; e.preventDefault(); rowMenu(k, [k], null, e, { queueAt: M.queue.index }); } }, nTitle, nSub, exitBtn),
    h("div", { class: "pv-ctrls" },
      h("div", { class: "pv-seekrow" }, tNow, seek, tDur),
      h("div", { class: "pv-transport" }, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn),
      h("div", { class: "pv-extras" }, muteBtn, vol, h("span", { class: "pv-gap" }), speedBtn, sleepBtn, eqBtn, vizBtn, pipBtn,
        h("button", { class: "pv-tb is-sm", title: "Show the song playing in the queue", onclick: () => showCurrent() }, icon("target")), miniBtn, popBtn, theaterBtn, fullBtn)),
    eqPanel, viz,
    h("div", { class: "pv-q" },
      h("div", { class: "pv-q-head" }, h("span", { class: "pv-q-title", text: "Queue" }), qFrom, qCount, h("span", { class: "pv-gap" }), qFind,
        h("button", { class: "icon-btn", title: "Queue actions", onclick: (e) => queueMenu(e.currentTarget) }, icon("more"))),
      qList));
  new IntersectionObserver(([e]) => {
    const away = !e.isIntersecting && e.boundingClientRect.bottom < (e.rootBounds ? e.rootBounds.top : 0) + 1;
    if (away) paintPeek();
    peek.classList.toggle("is-on", away);
  }, { root: now }).observe(now.querySelector(".pv-ctrls"));
  M.bus.addEventListener("change", () => { if (peek.classList.contains("is-on")) paintPeek(); });
  // only while the strip shows: the line follows the song
  M.bus.addEventListener("time", () => { if (!peekDrag && peek.classList.contains("is-on")) paintPeekTime(); });
  M.bus.addEventListener("state", () => { if (peek.classList.contains("is-on")) peekPlay.replaceChildren(gi(M.playing() ? "pause" : "play")); });
  const dockGrip = h("div", { class: "pv-dock-grip", title: "Drag to resize the player - double-click for the usual width" });
  const root = h("div", { class: "pv", tabIndex: -1 }, lib, now, dockGrip);
  // the tile size, and under 120 px the small-tile look (the title keeps the width)
  function setTile() { root.style.setProperty("--pv-tile", TILE() + "px"); root.classList.toggle("is-small-tiles", TILE() < 120); }
  setTile();
  const paintDock = () => { const w = Number(S.playerDockW) || 0; root.classList.toggle("has-dockw", w > 0); if (w > 0) root.style.setProperty("--pv-dock-w", w + "px"); else root.style.removeProperty("--pv-dock-w"); };
  paintDock();
  dockGrip.addEventListener("dblclick", () => { app.setSetting("playerDockW", 0); paintDock(); const y = M.yt(); if (y) y.place(); });
  dockGrip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = root.getBoundingClientRect();
    let w = now.getBoundingClientRect().width;
    document.body.classList.add("is-pv-moving");
    dockGrip.classList.add("is-on");
    try { dockGrip.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      w = Math.round(Math.max(240, Math.min(box.right - ev.clientX, box.width * 0.72)));
      root.classList.add("has-dockw");
      root.style.setProperty("--pv-dock-w", w + "px");
      const y = M.yt();
      if (y) y.place();
    };
    const up = () => {
      document.body.classList.remove("is-pv-moving");
      dockGrip.classList.remove("is-on");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      app.setSetting("playerDockW", w); // written once, when the pull ends
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  el.classList.add("view-player");
  el.replaceChildren(root);

  /* ── library ─────────────────────────────────────────────────────────── */
  function files() {
    const out = [];
    if (source === "all" || source === "vault") for (const f of app.vault.files.values()) if (f.kind === "media" || AUDIO.test(f.path)) out.push(f);
    for (const f of M.libraries.files().values()) {
      if (f.kind !== "media") continue;
      if (source === "all" || source === f.lib) out.push(f);
    }
    return out;
  }
  const libOf = (key) => (isLib(key) ? (M.libraries.entry(key) || {}).lib : null);
  const metaFor = (key) => {
    // songs of a library outside the vault are known to the engine, tags and cover picture included
    if (isOnline(key) || isLib(key)) return M.metaOf(key) || guessMeta(isLib(key) ? libPath(key) : key);
    const f = app.vault.files.get(key);
    return (f && peekMeta(f)) || guessMeta(key);
  };
  function counts() {
    let music = 0, videos = 0;
    for (const f of files()) AUDIO.test(isLib(f.path) ? libPath(f.path) : f.path) ? music++ : videos++;
    return { music, videos, youtube: M.online.list().length, playlists: M.playlists.all().length };
  }
  function paintTabs() {
    const c = counts();
    tabsEl.replaceChildren(...[["music", "Music", icon("music")], ["videos", "Videos", icon("film")], ["youtube", "Online", icon("globe")], ["playlists", "Playlists", gi("playlist")]].map(([id, label, ic]) =>
      h("button", { class: "seg" + (tab === id ? " is-active" : ""), role: "tab", onclick: () => setTab(id) }, ic, label, c[id] ? h("span", { class: "seg-count", text: String(c[id]) }) : null)));
    sortBtn.replaceChildren(icon("list"), (SORTS.find(([id]) => id === curSort()) || SORTS[0])[1] + (tab === "youtube" && onlineShow !== "all" ? ` · ${SHOWS.find(([id]) => id === onlineShow)[1]}` : "") + (tab === "youtube" && onlyPl().length ? ` · ${onlyPl().length} playlist${onlyPl().length > 1 ? "s" : ""}` : ""));
    sortBtn.title = `Sort: ${(SORTS.find(([id]) => id === curSort()) || SORTS[0])[1]}`;
    dirBtn.hidden = curSort() === "random" || curSort() === "custom" || sortBtn.hidden;
    // dates run newest first unless turned round: there "desc" off is the newest at the top
    const byDate = curSort() === "recent";
    const down = byDate ? !desc : desc;
    dirBtn.replaceChildren(icon(down ? "sortDown" : "sortUp"));
    dirBtn.title = byDate ? (down ? "Newest first - click for oldest first" : "Oldest first - click for newest first") : down ? "Descending - click for ascending" : "Ascending - click for descending";
    const libs = M.libraries.list();
    sourceBtn.hidden = !libs.length;
    const here = libs.find((l) => l.path === source);
    sourceBtn.replaceChildren(icon(source === "vault" ? "folder" : here ? "hardDrive" : "layers"), source === "all" ? "All music" : here ? here.name : "Vault only");
    const listTab = tab !== "youtube" && tab !== "playlists";
    groupBtn.classList.toggle("is-on", groupsOn());
    groupBtn.title = GROUPABLE.has(sort) ? "Fold music into its folders" : `Folders come back with a folder-like order: ${[...GROUPABLE].join(", ")}`;
    groupBtn.hidden = !listTab;
    groupBtn.disabled = !GROUPABLE.has(sort);
    foldBtn.hidden = !listTab || !groupsOn();
    const shut = allFolded();
    foldBtn.replaceChildren(icon(shut ? "expand" : "shrink"), shut ? "Open all" : "Fold all"); // shown as its icon alone in the toolbar
    foldBtn.title = shut ? "Open every folder" : "Fold every folder";
    sortBtn.hidden = tab === "playlists" && !openList;
    sizeBtn.hidden = tab !== "youtube" || ONLINE_LIST();
    viewBtn.hidden = tab !== "youtube";
    viewBtn.replaceChildren(icon(ONLINE_LIST() ? "grid" : "list"));
    viewBtn.title = ONLINE_LIST() ? "Show as tiles" : "Show as a list";
    tagBtn.hidden = tab === "playlists" && !openList;
    tagBtn.classList.toggle("is-on", !!tagFilter);
    tagBtn.replaceChildren(icon("hash"), tagFilter === "#untagged" ? "Untagged" : tagFilter === "#sfx" ? "Sound effects" : tagFilter || "Tags");
  }
  function setTab(t) {
    tab = t;
    openList = null;
    limit = PAGE;
    sel.clear();
    app.setSetting("playerTab", t);
    renderList();
    listEl.scrollTop = 0;
    syncBrowser();
  }

  /* ── your tags ──────────────────────────────────────────────────────── */
  const SFX_SECONDS = 30;
  function tagOk(k) {
    if (tagFilter === "#untagged") return taggable(app, k) && !tagsOf(app, M, k).length;
    if (tagFilter === "#sfx") { const d = metaFor(k).duration; return !!d && d < SFX_SECONDS; }
    const low = tagFilter.toLowerCase();
    return tagsOf(app, M, k).some((t) => t.toLowerCase() === low);
  }
  const tabKeys = () => (tab === "youtube" ? M.online.list().map(M.online.keyOf) : tab === "playlists" ? [] : files().filter((f) => (tab === "music") === AUDIO.test(f.path)).map((f) => f.path));
  const everyKey = () => [...M.online.list().map(M.online.keyOf), ...files().map((f) => f.path)];
  const knownTags = () => tagCounts(app, M, everyKey()).map((x) => x.tag);
  // a song's tags are in the file: the ones not read yet are read, four at a time, before a filter can be right
  let reading = null;
  function readAllMeta(keys) {
    if (reading) return reading;
    const todo = keys.filter((k) => !isOnline(k)).map((k) => (isLib(k) ? M.libraries.entry(k) : app.vault.files.get(k))).filter((f) => f && !peekMeta(f));
    if (!todo.length) return Promise.resolve();
    if (todo.length > 30) app.toast(`Reading the tags of ${todo.length} songs - once; after that they are remembered`, { ms: 3500 });
    let i = 0;
    const worker = async () => { while (i < todo.length) { const f = todo[i++]; await loadMeta(app, f).catch(() => {}); } };
    reading = Promise.all([worker(), worker(), worker(), worker()]).then(() => { reading = null; renderList(); });
    return reading;
  }
  function setTagFilter(v) {
    tagFilter = v;
    app.setSetting("playerTagFilter", v);
    if (v) readAllMeta(tabKeys());
    limit = PAGE;
    renderList();
  }
  function tagMenu(anchor) {
    readAllMeta(tabKeys());
    const counts = tagCounts(app, M, tabKeys());
    const r = anchor.getBoundingClientRect();
    app.menu(r.left, r.bottom + 4, [
      { header: "Show" },
      { label: "Everything", checked: !tagFilter, run: () => setTagFilter("") },
      { label: "Untagged - still to sort", icon: "inbox", checked: tagFilter === "#untagged", run: () => setTagFilter("#untagged") },
      tab !== "youtube" ? { label: `Sound effects (under ${SFX_SECONDS} s)`, icon: "bolt", checked: tagFilter === "#sfx", run: () => setTagFilter("#sfx") } : null,
      counts.length ? "sep" : null,
      ...counts.slice(0, 30).map((c) => ({ label: `${c.tag} · ${c.n}`, icon: "hash", checked: tagFilter.toLowerCase() === c.tag.toLowerCase(), run: () => setTagFilter(c.tag) })),
      tagFilter && !tagFilter.startsWith("#") ? "sep" : null,
      tagFilter && !tagFilter.startsWith("#") ? { label: `A playlist of “${tagFilter}”`, icon: "list", run: () => { const ks = visibleKeys(); if (!ks.length) return; const pl = M.playlists.create(tagFilter, ks); app.toast(`Made “${pl.name}” · ${ks.length}`, { ms: 2600 }); } } : null,
      !counts.length ? { header: "No tags yet - right-click a song › Tags…" } : null,
    ].filter(Boolean));
  }

  // every word must appear somewhere: title, artist, album, folder, link
  let words = [];
  function matches(key) {
    if (!words.length) return true;
    const m = metaFor(key);
    return matchesAll([m.title, m.artist, m.albumArtist, m.album, isYt(key) ? "" : isUrl(key) ? urlOf(key) : key], words);
  }
  // text with the searched words marked
  function marked(text) {
    const r = markRanges(text || "", words);
    if (!r.length) return [text || ""];
    const out = [];
    let at = 0;
    for (const [a, b] of r) { if (a > at) out.push(text.slice(at, a)); out.push(h("mark", { class: "pv-hit", text: text.slice(a, b) })); at = b; }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  const setText = (el, text) => el.replaceChildren(...marked(text));
  const entryOf = (k) => (isLib(k) ? M.libraries.entry(k) : app.vault.files.get(k)) || {};
  const addedAt = (k) => (isOnline(k) ? (M.online.entry(k) || {}).addedAt || 0 : entryOf(k).mtime || 0);
  const titleOf = (k) => metaFor(k).title || k;
  // a stable shuffled order: the same list keeps it until "Random" is picked again
  function chaos(k) {
    let hsh = seed >>> 0;
    for (let i = 0; i < k.length; i++) hsh = Math.imul(hsh ^ k.charCodeAt(i), 2654435761);
    return hsh >>> 0;
  }
  // what the Sound panel's reading found for a song; not read yet sorts to the end whichever way
  const SE = soundEngine(app, M);
  function soundOf(k, what) {
    const a = SE.analysisOf(k);
    const far = desc ? -1e9 : 1e9;
    if (!a) return far;
    if (what === "energy") return (a.bpm || 0) / 120 + ((a.loudness || -30) + 30) / 20 + (a.density || 0) / 3;
    return a[what] ?? far;
  }
  const goneKey = (k) => isYt(k) && !!(M.online.entry(k) || {}).gone;
  const webOnlyKey = (k) => isYt(k) && !goneKey(k) && !!(M.online.entry(k) || {}).webOnly;
  /* What Online shows, apart from the sort: everything, the web-only videos, the gone ones - or the ones you
     removed (kept as a short list, to bring back). A separate choice, remembered. */
  const SHOWS = [["all", "Everything"], ["ok", "Available"], ["loose", "Not in any playlist"], ["web", "Web only"], ["gone", "Gone from Online"], ["removed", "Removed from Online media"], ["short", "Short - under 10 min"], ["long", "Long - 10 min and more"]];
  let onlineShow = SHOWS.some(([id]) => id === S.playerOnlineShow) ? S.playerOnlineShow : "all";
  if (onlineSort === "gone") { onlineSort = "custom"; onlineShow = "gone"; } // the old "Gone first" sort
  // what any playlist holds, worked out once per drawing (Show › Not in any playlist)
  let listedSet = null, listedAt = 0;
  const looseKey = (k) => { if (!listedSet || Date.now() - listedAt > 500) { listedSet = new Set(M.playlists.all().flatMap((p) => p.items)); listedAt = Date.now(); } return !listedSet.has(k); };
  // a video's length: kept from its playlist's page, or from playing it (none yet: in neither)
  const secsOf = (k) => (M.online.entry(k) || {}).secs || 0;
  const SHOW_TEST = { ok: (k) => !goneKey(k) && !webOnlyKey(k), loose: looseKey, web: webOnlyKey, gone: goneKey,
    short: (k) => secsOf(k) > 0 && secsOf(k) < 600, long: (k) => secsOf(k) >= 600 };
  // Show › Only in playlists: the list (and its search) kept to the playlists ticked
  const onlyPl = () => (Array.isArray(S.playerOnlyPl) ? S.playerOnlyPl : []);
  let inPlSet = null, inPlAt = 0;
  const inPls = (k) => {
    const ids = onlyPl();
    if (!ids.length) return true;
    if (!inPlSet || Date.now() - inPlAt > 500) { inPlSet = new Set(M.playlists.all().filter((p) => ids.includes(p.id)).flatMap((p) => p.items)); inPlAt = Date.now(); }
    return inPlSet.has(k);
  };
  const showOk = (k) => (SHOW_TEST[onlineShow] ? SHOW_TEST[onlineShow](k) : true) && inPls(k);
  const removedList = () => (Array.isArray(S.onlineRemoved) ? S.onlineRemoved : []);
  // a video's name searched for on a site, in the Player's own browser
  const SEARCH_SITES = [["YouTube", (q) => `https://www.youtube.com/results?search_query=${q}`], ["YouTube Music", (q) => `https://music.youtube.com/search?q=${q}`],
    ["SoundCloud", (q) => `https://soundcloud.com/search?q=${q}`], ["Google", (q) => `https://www.google.com/search?q=${q}`], ["Bing videos", (q) => `https://www.bing.com/videos/search?q=${q}`]];
  const searchFor = (title, site = SEARCH_SITES[0]) => { app.setSetting("playerBrowser", true); openHere(site[1](encodeURIComponent(title))); };
  /** A video that is gone, replaced by another: the new one takes its place in every playlist and in the queue. */
  async function replaceGone(key) {
    const was = (M.online.entry(key) || {}).title || "";
    const r = await askDialog(`Replace “${was || "the video"}”`, [{ key: "url", label: "Link to the video to use instead", value: "" }],
      { ok: "Replace", text: "It takes the old one's place in every playlist and in the queue; the old one goes. Find one with “Search for it”, then copy its link here." });
    const d = r && readLink(String(r.url || "").trim());
    if (!d || d.bad || d.list || d.site) { if (r) app.toast("That is not a video link", { kind: "error" }); return; }
    const to = await M.online.add(d.yt || d.direct);
    if (!to || to === key) return;
    M.online.replaceKey(key, to);
    M.online.remove([key]);
    renderList();
    app.toast(`Replaced${was ? ` “${was}”` : ""}`, { ms: 2600 });
  }
  /** The list's order as a comparison: the sort chosen, its direction. */
  function order() {
    const dir = desc ? -1 : 1;
    const num = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
    const byFolder = (a, b) => naturalCompare(folderOf(a), folderOf(b)) || num(metaFor(a).track || 999, metaFor(b).track || 999) || naturalCompare(titleOf(a), titleOf(b));
    const cmp = {
      name: (a, b) => naturalCompare(titleOf(a), titleOf(b)),
      artist: (a, b) => naturalCompare(metaFor(a).artist || "~", metaFor(b).artist || "~") || byFolder(a, b),
      album: (a, b) => naturalCompare(metaFor(a).album || leaf(folderOf(a)), metaFor(b).album || leaf(folderOf(b))) || num(metaFor(a).track || 999, metaFor(b).track || 999),
      track: (a, b) => num(metaFor(a).track || 999, metaFor(b).track || 999) || naturalCompare(titleOf(a), titleOf(b)),
      duration: (a, b) => num(metaFor(a).duration || 0, metaFor(b).duration || 0),
      size: (a, b) => num(entryOf(a).size || 0, entryOf(b).size || 0),
      // newest first unless turned round (the direction was applied twice here, so it never turned)
      recent: (a, b) => num(addedAt(b), addedAt(a)),
      folder: byFolder,
      random: (a, b) => num(chaos(a), chaos(b)),
      custom: () => 0, // as given: the order the tiles were dragged into
      bpm: (a, b) => num(soundOf(a, "bpm"), soundOf(b, "bpm")),
      loudness: (a, b) => num(soundOf(a, "loudness"), soundOf(b, "loudness")),
      energy: (a, b) => num(soundOf(a, "energy"), soundOf(b, "energy")),
    }[curSort()] || ((a, b) => naturalCompare(titleOf(a), titleOf(b)));
    // inside an album the track order wins; a flat list follows the choice
    const base = groupsOn() ? byFolder : cmp;
    return (a, b) => base(a, b) * (base === cmp ? dir : 1);
  }
  function sorted(keys) {
    // Online, shown in part: only the web-only, or only the gone (to find and replace them)
    if (tab === "youtube" && (onlineShow !== "all" || onlyPl().length)) keys = keys.filter(showOk);
    return keys.sort(order());
  }
  /** The first of `keys` in the list's order that `ok` takes - one pass, no sorting (a playlist's picture). */
  function firstInOrder(keys, ok) {
    if (onlineSort === "custom") return keys.find(ok);
    const cmp = order();
    let best;
    for (const k of keys) if (ok(k) && (best === undefined || cmp(k, best) < 0)) best = k;
    return best;
  }
  // the keys the list shows, in order (what "play all" plays)
  function visibleKeys() {
    words = draft ? [] : terms(query);
    if (tab === "playlists") {
      if (!openList) return [];
      const pl = M.playlists.all().find((p) => p.id === openList);
      return pl ? pl.items.filter((k) => matches(k)) : [];
    }
    let keys;
    if (tab === "youtube") keys = M.online.list().map(M.online.keyOf);
    else keys = files().filter((f) => (tab === "music") === AUDIO.test(f.path)).map((f) => f.path);
    keys = keys.filter((k) => matches(k));
    if (tagFilter) keys = keys.filter(tagOk);
    return sorted(keys);
  }

  /** The library a key belongs to, as a folder prefix ("" for the vault). */
  const baseOf = (key) => {
    if (!isLib(key)) return "";
    const e = M.libraries.entry(key);
    return e ? "lib:" + String(e.lib).split("\\").join("/") : "";
  };
  const libNameOf = (dir) => {
    const l = M.libraries.list().find((x) => "lib:" + String(x.path).split("\\").join("/") === dir);
    return l ? l.name : leaf(showPath(dir));
  };
  /**
   * The folders these keys live in, nested. A folder that holds other
   * folders is a node with children, so folding it folds everything under
   * it - which is the whole point of a folder.
   */
  function folderTree(keys) {
    const node = (dir, name) => ({ dir, name, keys: [], kids: new Map() });
    const roots = [];
    const seen = new Map();
    const get = (dir, name, parent) => {
      let n = seen.get(dir);
      if (n) return n;
      n = node(dir, name);
      seen.set(dir, n);
      if (parent) parent.kids.set(dir, n);
      else roots.push(n);
      return n;
    };
    for (const k of keys) {
      const base = baseOf(k);
      const rel = base ? k.slice(base.length + 1) : k;
      const parts = rel.split("/");
      parts.pop(); // the file itself
      let cur = base ? get(base, libNameOf(base), null) : null;
      let path = base;
      for (const part of parts) {
        path = path ? path + "/" + part : part;
        cur = get(path, part, cur);
      }
      if (!cur) cur = get("", "Vault", null); // files loose in the vault root
      cur.keys.push(k);
    }
    return roots;
  }
  /** Every key under a node, in the order the list is sorted. */
  function underKeys(n, out = []) {
    out.push(...n.keys);
    for (const kid of n.kids.values()) underKeys(kid, out);
    return out;
  }
  const kidsOf = (n) => [...n.kids.values()].sort((a, b) => naturalCompare(a.name, b.name));

  /** Are folder groups drawn right now? (Only album-ish orders keep them.) */
  const groupsOn = () => grouped && GROUPABLE.has(sort) && tab !== "youtube" && tab !== "playlists";
  const folded = () => (Array.isArray(S.playerFolded) ? S.playerFolded : []);
  const isFolded = (dir) => folded().includes(dir);
  function setFolded(dirs) { app.setSetting("playerFolded", dirs.slice(0, 500)); }
  function toggleFold(dir, groupEl) {
    const on = !isFolded(dir);
    setFolded(on ? [...folded(), dir] : folded().filter((d) => d !== dir));
    if (groupEl) {
      groupEl.classList.toggle("is-folded", on);
      const c = groupEl.querySelector(":scope > .pv-album .pv-fold");
      if (c) { c.setAttribute("aria-expanded", String(!on)); c.title = on ? "Open this folder" : "Fold this folder"; }
    }
    return on;
  }

  /* A long list draws its next rows as its end comes near - added under the ones there, so nothing
     moves: a list of thousands scrolls on as if it were all there. */
  let more = null;
  function moreOnScroll(btn, all) {
    if (!more) more = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && more.next) more.next(); }, { root: listEl, rootMargin: "900px 0px" });
    more.disconnect();
    more.next = () => {
      if (!btn.isConnected) return;
      const flat = !groupsOn() && btn.previousElementSibling && btn.previousElementSibling.matches(".pv-rows.is-flat") ? btn.previousElementSibling : null;
      if (!flat) { const top = listEl.scrollTop; limit += PAGE; renderList(); listEl.scrollTop = top; return; }
      flat.append(...all.slice(limit, limit + PAGE).map((k, j) => row(k, limit + j, all)));
      limit += PAGE;
      paintPlaying();
      paintSel();
      if (all.length <= limit) { more.disconnect(); btn.remove(); return; }
      // looked at again: still in reach (a short list, a fast scroll) draws the next ones too
      more.unobserve(btn);
      more.observe(btn);
    };
    more.observe(btn);
  }

  const rows = new Map(); // key -> row element
  let io = null;
  function watchMeta(row, key) {
    if (isOnline(key)) return;
    const f = app.vault.files.get(key);
    if (!f || peekMeta(f)) return;
    if (!io) io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const k = e.target.dataset.key;
        const file = app.vault.files.get(k);
        if (file) loadMeta(app, file).then(() => metaArrived(k));
      }
    }, { root: listEl, rootMargin: "300px 0px" });
    io.observe(row);
  }
  const metaArrived = debounce(() => {
    // re-sorting on every tag would make the list jump: patch rows in place
    for (const [k, row] of rows) if (row.dataset.guess && peekMeta(app.vault.files.get(k))) patchRow(row, k);
    for (const head of listEl.querySelectorAll(".pv-album[data-dir]")) paintAlbumArt(head.querySelector(".pv-album-art"), head.dataset.dir, head.dataset.first);
    if (M.current() && !isYt(M.current())) paintNow();
  }, 120);

  function coverStyle(m, key) {
    const fc = !m.cover && !isOnline(key) ? folderCover(app, key) : null;
    const url = m.cover || (fc ? coverUrl(app, fc) : "");
    return url ? { backgroundImage: `url("${url}")` } : { backgroundImage: gradientFor(m.album || folderOf(key) || m.title || key) };
  }
  function art(key, cls) {
    const m = metaFor(key);
    const a = h("span", { class: "pv-art " + (cls || ""), style: coverStyle(m, key) });
    if (!m.cover && !(!isOnline(key) && folderCover(app, key))) a.append(icon(isYt(key) ? "globe" : (isUrl(key) ? m.audio : AUDIO.test(key)) ? "music" : "film"));
    return a;
  }
  function patchRow(row, key) {
    const m = metaFor(key);
    setText(row.querySelector(".pv-r-title"), m.title || leaf(key));
    setText(row.querySelector(".pv-r-sub"), subOf(key, m));
    const d = row.querySelector(".pv-r-dur");
    if (d) d.textContent = m.duration ? fmtTime(m.duration) : "";
    const old = row.querySelector(".pv-art");
    if (old) old.replaceWith(art(key, old.className.replace("pv-art", "").trim()));
    if (!m.guess) delete row.dataset.guess;
  }
  function subOf(key, m) {
    if (isOnline(key)) {
      const it = M.online.entry(key);
      if (it && it.gone) return "No longer on YouTube - find it again from the menu";
      return ["Online", isUrl(key) ? m.artist : "", it && it.addedAt ? `added ${relTime(it.addedAt)}` : ""].filter(Boolean).join(" · ");
    }
    const inAlbum = groupsOn() && tab !== "playlists";
    const tags = tagsOf(app, M, key).map((t) => "#" + t).join(" ");
    return [inAlbum ? m.artist || "" : [m.artist, m.album || leaf(folderOf(key))].filter(Boolean).join(" · "), tags].filter(Boolean).join(" · ");
  }

  function row(key, i, all) {
    const m = metaFor(key);
    const missing = !isOnline(key) && !(isLib(key) ? M.libraries.entry(key) : app.vault.files.has(key));
    const r = h("div", { class: "pv-row" + (tab === "playlists" && openList && !words.length ? " pv-plrow" : "") + (missing ? " is-missing" : ""), dataset: { key, i: String(i) }, draggable: true, role: "button" },
      h("span", { class: "pv-r-num" }, h("span", { class: "pv-r-n", text: m.track && groupsOn() ? String(m.track) : String(i + 1) }), h("span", { class: "pv-bars" }, h("i"), h("i"), h("i"))),
      h("span", { class: "pv-art-wrap" }, art(key, "is-sm"), h("span", { class: "pv-art-state" }, gi("play", "is-play"), gi("pause", "is-pause"))),
      h("span", { class: "pv-r-main" }, h("span", { class: "pv-r-title" }, marked(m.title || leaf(key))), h("span", { class: "pv-r-sub" }, marked(subOf(key, m)))),
      h("span", { class: "pv-r-dur", text: m.duration ? fmtTime(m.duration) : "" }),
      h("span", { class: "pv-pill pv-r-pill" },
        h("button", { class: "icon-btn", title: "Play (or pause, when it is the one playing)", onclick: (e) => { e.stopPropagation(); M.current() === key ? M.toggle() : playFrom(all, key); } }, icon("play")),
        h("button", { class: "icon-btn pv-r-more", title: "More", onclick: (e) => { e.stopPropagation(); rowMenu(key, all, e.currentTarget); } }, icon("more"))));
    if (m.guess) r.dataset.guess = "1";
    r.addEventListener("click", (e) => pick(key, e, all));
    r.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!sel.has(key)) { sel.clear(); sel.add(key); paintSel(); } rowMenu(key, all, null, e); });
    r.addEventListener("dragstart", (e) => {
      const keys = sel.has(key) ? all.filter((k) => sel.has(k)) : [key];
      e.dataTransfer.setData("application/x-leonote-play", JSON.stringify(keys));
      e.dataTransfer.effectAllowed = "copy";
    });
    rows.set(key, r);
    watchMeta(r, key);
    return r;
  }

  function albumHead(node, keys, all, depth = 0) {
    const dir = node.dir;
    const first = keys[0];
    const kidCount = node.kids.size;
    const a = h("span", { class: "pv-art pv-album-art" });
    paintAlbumArt(a, dir, first);
    const m = metaFor(first);
    // one artist only when every track agrees
    const artists = new Set(keys.map((k) => metaFor(k).albumArtist || metaFor(k).artist || ""));
    const artist = artists.size === 1 ? [...artists][0] : artists.size > 1 ? "Various artists" : "";
    const total = keys.reduce((s, k) => s + (metaFor(k).duration || 0), 0);
    const albumName = kidCount || !node.keys.length ? node.name : (!m.guess && m.album) || node.name;
    // on the cover, as on the Online tiles: play, then more (the art itself is repainted, so the pill sits beside it)
    const cover = h("span", { class: "pv-album-cover" }, a, h("span", { class: "pv-pill" },
      h("button", { class: "icon-btn", title: "Play", onclick: (e) => { e.stopPropagation(); playL(keys, 0, albumName); } }, icon("play")),
      h("button", { class: "icon-btn", title: "More", onclick: (e) => { e.stopPropagation(); groupMenu(keys, dir, e.currentTarget); } }, icon("more"))));
    const count = `${keys.length} ${tab === "videos" ? "video" : "song"}${keys.length === 1 ? "" : "s"}`
      + (kidCount ? ` in ${kidCount + 1} folder${kidCount ? "s" : ""}` : "");
    const head = h("div", { class: "pv-album" + (depth ? " is-nested" : "") + (kidCount ? " has-kids" : ""), dataset: { dir, first }, title: "Click to fold this folder" },
      h("button", { class: "pv-fold", title: isFolded(dir) ? "Open this folder" : "Fold this folder", "aria-expanded": String(!isFolded(dir)), onclick: (e) => { e.stopPropagation(); fold(); } }, icon("chevronDown")),
      cover,
      h("div", { class: "pv-album-meta" },
        h("div", { class: "pv-album-name", text: kidCount || !node.keys.length ? node.name : (!m.guess && m.album) || node.name }),
        h("div", { class: "pv-album-sub", text: [artist, m.year, count, total ? fmtTime(total) : "", depth === 0 && dir && dir !== node.name ? showPath(dir) : ""].filter(Boolean).join(" · ") }),
        h("div", { class: "pv-album-acts" },
          h("button", { class: "btn btn-primary pv-btn-sm", onclick: () => playL(keys, 0, kidCount || !node.keys.length ? node.name : (!m.guess && m.album) || node.name) }, gi("play"), "Play"),
          h("button", { class: "btn pv-btn-sm", onclick: () => { playL(keys, Math.floor(Math.random() * keys.length), kidCount || !node.keys.length ? node.name : (!m.guess && m.album) || node.name); M.setShuffle(true); } }, gi("shuffle"), "Shuffle"),
          h("button", { class: "icon-btn", title: "Add to queue", onclick: () => { M.enqueue(keys); app.toast(`Added ${keys.length} to the queue`, { ms: 1800 }); } }, gi("queue")),
          h("button", { class: "icon-btn", title: "More", onclick: (e) => groupMenu(keys, dir, e.currentTarget) }, icon("more")))),
      h("span", { class: "pv-album-count", text: total ? `${count} · ${fmtTime(total)}` : count }));
    const fold = () => {
      const g = head.closest(".pv-group");
      // An open folder past the first page of rows is drawn empty until asked
      // for: the first click fills it, rather than folding what looks shut.
      const body = g && g.querySelector(":scope > .pv-groupbody");
      if (g && !isFolded(dir) && body && !body.dataset.filled && g._fill) { g._fill(); paintPlaying(); return; }
      const nowFolded = toggleFold(dir, g);
      // everything under a folder is built the first time it opens
      if (g && !nowFolded && g._fill) g._fill();
      paintTabs();
      paintPlaying();
    };
    head.addEventListener("click", (e) => { if (!e.target.closest("button")) fold(); });
    return head;
  }
  function paintAlbumArt(a, dir, first) {
    if (!a) return;
    const m = metaFor(first);
    const fc = folderCover(app, first);
    const url = m.cover || (fc ? coverUrl(app, fc) : "");
    a.style.backgroundImage = url ? `url("${url}")` : gradientFor(dir || "vault");
    a.replaceChildren(url ? "" : icon(AUDIO.test(first) ? "music" : "film"));
  }

  function renderList() {
    dirty.list = !visible;
    if (!visible) return;
    if (fromSearch && !query.trim()) backFromSearch();
    paintTabs();
    rows.clear();
    if (io) io.disconnect();
    if (thumbIo) thumbIo.disconnect();
    const count = root.querySelector(".pv-count");
    search.placeholder = tab === "playlists" && !openList ? "Search playlists, or paste a link" : "Search, or paste a link";
    const hint = draft ? suggestion(draft) : null;
    const libsPanel = showLibs ? libraryPanel() : null;
    // the browser's bar: back, forward, reload, where it is, and the switch - the search box above is its address bar
    paintToolsMode();
    const onlineBar = null;
    if (tab === "playlists" && !openList) { count.textContent = ""; listEl.replaceChildren(...[hint, libsPanel, playlistCards()].filter(Boolean)); paintSel(); return; }
    const all = visibleKeys();
    const out = [hint, onlineBar, tab === "youtube" && browserOn() ? browserPanel() : null, libsPanel];
    const imported = tab === "playlists" && openList ? M.playlists.all().find((p) => p.id === openList && p.tracks) : null;
    if (tab === "playlists") out.push(playlistHead(all));
    if (imported) {
      const q = words.length ? (t) => matchesAll([t.title, (t.artists || []).join(" "), t.album], words) : () => true;
      const shown = imported.tracks.filter(q);
      out.push(h("div", { class: "pv-rows is-flat" }, shown.map((t, i) => (t.key && M.metaOf(t.key) ? row(t.key, i, all) : missingRow(t, imported, i)))));
      count.textContent = `${shown.length}`;
      listEl.replaceChildren(...out.filter(Boolean));
      paintPlaying();
      paintSel();
      return;
    }
    if (grouped && !GROUPABLE.has(sort) && tab !== "youtube" && tab !== "playlists" && all.length) {
      out.push(h("div", { class: "pv-note" },
        h("span", { text: `Folders can't fold while this list is sorted by ${(SORTS.find(([id]) => id === sort) || [])[1]}.` }),
        h("button", { class: "link-btn", onclick: () => { sort = "folder"; app.setSetting("playerSort", sort); renderList(); } }, "Sort by folder instead")));
    }
    if (!all.length) { if (tab === "youtube" && !words.length) out.push(foldsHead(), mainGrid([])); out.push(emptyState()); }
    else if (tab === "youtube" && onlineShow === "removed") out.push(removedGrid());
    else if (tab === "youtube" && !words.length) { out.push(foldsHead(), mainGrid(all)); M.youtube.fillTitles(); }
    else if (groupsOn()) {
      let n = 0;
      const draw = (node, depth) => {
        const keys = underKeys(node);
        const fold = isFolded(node.dir);
        const body = h("div", { class: "pv-groupbody" });
        const g = h("div", { class: "pv-group" + (fold ? " is-folded" : ""), dataset: { dir: node.dir, depth: String(depth) } },
          albumHead(node, keys, all, depth), body);
        // a folded folder builds nothing until it is opened
        const fill = () => {
          if (body.dataset.filled) return;
          body.dataset.filled = "1";
          g.classList.remove("is-unfilled");
          const kids = kidsOf(node).map((kid) => draw(kid, depth + 1));
          body.replaceChildren(...node.keys.map((k) => row(k, n++, all)), ...kids);
        };
        g._fill = fill;
        if (!fold && n <= limit) fill();
        else { n += keys.length; if (!fold) g.classList.add("is-unfilled"); }
        return g;
      };
      for (const node of folderTree(all)) out.push(draw(node, 0));
    } else {
      out.push(h("div", { class: "pv-rows is-flat" }, all.slice(0, limit).map((k, i) => row(k, i, all))));
    }
    const moreBtn = all.length > limit ? h("button", { class: "btn pv-more", title: "Draw every row and open every folder", onclick: () => { limit = Infinity; if (groupsOn() && folded().length) setFolded([]); renderList(); } }, `Show all ${all.length}`) : null;
    if (moreBtn) out.push(moreBtn);
    // words in the box: the web is a click away, in the Player's own browser
    if (!draft && query.trim()) out.push(h("div", { class: "pv-srcs" },
      h("button", { class: "pv-srcchip", onclick: () => { app.setSetting("playerBrowser", true); browserGo(webSearchUrl(S.webSearch, query)); if (tab !== "youtube") setTab("youtube"); else { renderList(); syncBrowser(); } } },
        icon("globe"), `Search the web for “${query.trim()}”`)));
    if (tab === "playlists" && openList) out.push(takenOut());
    count.textContent = all.length ? `${all.length}` : "";
    listEl.replaceChildren(...out.filter(Boolean));
    if (moreBtn) moreOnScroll(moreBtn, all);
    paintPlaying();
    paintSel();
  }

  function emptyState() {
    const q = draft ? "" : query.trim();
    if (q) return h("div", { class: "pv-empty" }, h("p", { text: `Nothing matches “${q}”` }), tab !== "music" ? h("button", { class: "link-btn", onclick: () => setTab("music") }, "Search in Music") : null);
    if (draft) return null;
    if (tab === "youtube") return h("div", { class: "pv-empty" }, icon("globe", "pv-empty-ico"), h("h3", { text: "Online media, right here" }),
      h("p", { text: (S.playerBrowserTake === "none" ? "Paste a video link," : "Open any site in the browser above and play a video there: it lands here. Or paste a video link,") + " or a link to an audio or video file, into the box (or anywhere in the Player). It mixes into the queue with your own music and can go into playlists." }));
    if (tab === "playlists") return h("div", { class: "pv-empty" }, h("p", { text: "This playlist is empty. Drag songs here, or use “Add to playlist” from any song's menu." }));
    return h("div", { class: "pv-empty" }, icon(tab === "videos" ? "film" : "music", "pv-empty-ico"), h("h3", { text: tab === "videos" ? "No videos in the vault yet" : "No music in the vault yet" }),
      h("p", { text: "Drop .mp3, .m4a, .wav, .ogg, .mp4 or .webm files into any vault folder (drag them onto a folder in the sidebar). Folders become albums; a cover.jpg in a folder becomes its cover." }),
      // music kept elsewhere on the computer is played where it is, not copied in
      h("button", { class: "btn", onclick: () => addLibrary() }, "Add a music folder from your computer…"));
  }

  /** The card's trash: asks once, with a tick to stop asking; the row menu brings the question back. */
  async function quickRemove(k) {
    if (S.onlineRemoveAsk === false) return removeOnline([k]);
    const m = metaFor(k);
    const tick = h("input", { type: "checkbox" });
    const ok = await new Promise((resolve) => {
      const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
      const okBtn = h("button", { class: "btn btn-danger", onclick: () => done(true) }, "Remove");
      const box = h("div", { class: "dlg", role: "alertdialog", "aria-modal": "true" },
        h("h3", { class: "dlg-title", text: `Remove “${m.title}” from Online media?` }),
        h("p", { class: "dlg-text", text: "The link goes from the list. Undo on the message brings it back." }),
        h("label", { class: "dlg-tick" }, tick, h("span", { text: "Don't ask again - the trash removes at once (the card's menu can bring the question back)" })),
        h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), okBtn));
      const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } }, box);
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); } };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("overlay-root").append(back);
      requestAnimationFrame(() => { back.classList.add("is-in"); okBtn.focus(); });
    });
    if (!ok) return;
    if (tick.checked) app.setSetting("onlineRemoveAsk", false);
    removeOnline([k]);
  }
  /** The line above the tiles: a new playlist, or one brought in from YouTube. */
  function foldsHead() {
    const pls = M.playlists.all();
    const shown = pls.filter(onlineShown);
    return h("div", { class: "pv-folds-head" }, h("span", { class: "pv-folds-title", text: "Playlists" }), h("span", { class: "pv-fold-n", text: `${shown.length} of ${pls.length}` }),
      h("button", { class: "link-btn", title: "Which of your playlists sit among the tiles - the others stay under Playlists", onclick: (e) => menu(0, 0, [
        { header: pls.length ? "Among the Online tiles" : "No playlists yet" },
        ...pls.map((p) => ({ label: `${p.name} · ${p.items.length}`, icon: onlineShown(p) ? "check" : "eye", checked: onlineShown(p), run: () => setOnlineShown(p, !onlineShown(p)) })),
      ], { anchor: e.currentTarget }) }, "Include…"),
      h("button", { class: "link-btn", onclick: () => { const pl = M.playlists.create(`Playlist ${pls.length + 1}`, [], { showOnline: true }); app.setSetting("playerPlOpen", [...(S.playerPlOpen || []), pl.id]); renderList(); } }, "+ New"),
      // an inline field rather than a dialog: the browser's native view would sit on top of one
      (() => {
        const field = h("input", { class: "pv-import-in", placeholder: "Paste a playlist link, then Enter", spellcheck: false, hidden: true });
        field.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { field.hidden = true; } if (e.key === "Enter" && field.value.trim()) { const v = field.value.trim(); field.value = ""; field.hidden = true; importYtList(v); } });
        const open = (bTab() || {}).path || "";
        return [
          h("button", { class: "link-btn", title: "Paste a playlist link", onclick: () => { field.hidden = !field.hidden; if (!field.hidden) field.focus(); } }, "Import playlist"),
          /[?&]list=/.test(open) ? h("button", { class: "link-btn", title: open, onclick: () => importYtList(open) }, "Import the one open in the browser") : null,
          field,
        ];
      })(),
      h("span", { class: "pv-hint", text: "A playlist is a tile like any video: click it to unfold what it holds, drag it where you like, drop tiles on it to fill it." }));
  }
  /** The Online tiles with the playlists among them - each one tile folded, a full row of its own tiles unfolded - in the order they were dragged into. */
  function mainGrid(keys) {
    const pls = M.playlists.all();
    // a video that came in with an imported YouTube playlist lives in that playlist, not loose among the tiles too -
    // unless it was also added on its own
    const inLists = new Set(pls.filter((p) => p.ytList).flatMap((p) => p.items));
    keys = keys.filter((k) => !inLists.has(k) || (M.online.entry(k) || {}).loose);
    const ids = [...pls.filter(onlineShown).filter((p) => (onlineShow === "all" && !onlyPl().length) || p.items.some(showOk)).map((p) => "pl:" + p.id), ...keys];
    if (curSort() === "custom") {
      const rank = new Map((S.playerGridOrder || []).map((k, i) => [k, i]));
      const nat = new Map(ids.map((k, i) => [k, i]));
      const pos = (k) => (rank.has(k) ? rank.get(k) : (k.startsWith("pl:") ? -1e6 : 1e6) + nat.get(k));
      ids.sort((x, y) => pos(x) - pos(y));
    }
    if (ONLINE_LIST()) return h("div", { class: "pv-ytlist" }, ids.map((k) => (k.startsWith("pl:") ? plLine(pls.find((p) => "pl:" + p.id === k)) : row(k, keys.indexOf(k), keys))));
    const grid = onlineGrid(keys);
    const cards = new Map([...grid.children].map((c) => [c.dataset.key, c]));
    grid.replaceChildren(...ids.map((k) => (k.startsWith("pl:") ? plTile(pls.find((p) => "pl:" + p.id === k)) : cards.get(k))));
    return grid;
  }
  /** A playlist in the Online list: a row of its own that unfolds its videos under it, as its tile does. */
  function plLine(p) {
    const open = (S.playerPlOpen || []).includes(p.id);
    const toggle = () => { const set = new Set(S.playerPlOpen || []); open ? set.delete(p.id) : set.add(p.id); app.setSetting("playerPlOpen", [...set]); renderList(); };
    const cover = firstInOrder(p.items, (k) => metaFor(k).cover || isYt(k));
    const items = onlineSort === "custom" ? p.items : sorted([...p.items]);
    const line = h("div", { class: "pv-row pv-plline" + (open ? " is-open" : ""), ...pressable(toggle), draggable: true, onclick: (e) => { if (!e.target.closest("button")) toggle(); } },
      h("span", { class: "pv-r-num" }, icon("chevronDown", "pv-fold-caret")),
      h("span", { class: "pv-art-wrap" }, h("span", { class: "pv-art is-sm", style: cover ? coverStyle(metaFor(cover), cover) : { backgroundImage: gradientFor(p.name) } }, cover ? null : gi("playlist"))),
      h("span", { class: "pv-r-main" }, h("span", { class: "pv-r-title", text: p.name }), h("span", { class: "pv-r-sub", text: `Playlist · ${p.items.length} item${p.items.length === 1 ? "" : "s"}${p.ytList ? " · Imported" : ""}` })),
      h("span", { class: "pv-pill pv-r-pill" },
        h("button", { class: "icon-btn", title: "Play", onclick: (e) => { e.stopPropagation(); playPl(p); } }, icon("play")),
        h("button", { class: "icon-btn", title: "More", onclick: (e) => { e.stopPropagation(); playlistMenu(p, e.currentTarget); } }, icon("more"))));
    line.addEventListener("contextmenu", (e) => { e.preventDefault(); playlistMenu(p, null, e); });
    line.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-leonote-play")) { e.preventDefault(); line.classList.add("is-drop"); } });
    line.addEventListener("dragleave", () => line.classList.remove("is-drop"));
    line.addEventListener("drop", (e) => { line.classList.remove("is-drop"); const keys = dropKeys(e); if (keys && !keys.some((k) => p.items.includes(k))) { e.preventDefault(); e.stopPropagation(); M.playlists.add(p.id, keys); app.toast(`Added to ${p.name}`, { ms: 1600 }); } });
    return h("div", { class: "pv-plline-wrap", dataset: { pl: p.id }, style: plStyle(p) }, line, open ? h("div", { class: "pv-plline-body" }, items.length ? items.map((k, i) => row(k, i, items)) : h("div", { class: "pv-fold-empty", text: "Empty - drop videos here, or pick some and “Add to playlist”." })) : null);
  }
  /**
   * A playlist's colour: its own (picked, or drawn at random when it was made), else one
   * of the hues worked out from its id, so each keeps the same colour. "plain": none.
   */
  const PL_HUES = [[4, "Red"], [28, "Orange"], [48, "Yellow"], [140, "Green"], [178, "Teal"], [205, "Blue"], [255, "Indigo"], [285, "Purple"], [325, "Pink"]];
  function plColor(p) {
    if (p.color === "plain") return "var(--text-3)";
    if (typeof p.color === "string" && /^#[0-9a-f]{3,8}$/i.test(p.color)) return p.color;
    let hue = Number.isFinite(p.color) ? p.color : null;
    if (hue == null) { let x = 0; for (const ch of String(p.id)) x = (x * 31 + ch.charCodeAt(0)) | 0; hue = PL_HUES[Math.abs(x) % PL_HUES.length][0]; }
    return `hsl(${hue} 72% 62%)`;
  }
  const plStyle = (p) => ({ "--plc": plColor(p) });
  function plTile(p) {
    const open = (S.playerPlOpen || []).includes(p.id);
    const toggle = () => { const set = new Set(S.playerPlOpen || []); open ? set.delete(p.id) : set.add(p.id); app.setSetting("playerPlOpen", [...set]); renderList(); };
    const cover = firstInOrder(p.items, (k) => metaFor(k).cover || isYt(k));
    const name = h("span", { class: "pv-pltile-name", text: p.name, title: "Double-click to rename", ondblclick: (e) => { e.stopPropagation(); inlineEdit(e.currentTarget, p.name, { onCommit: (v) => M.playlists.rename(p.id, v.trim()) }); } });
    const more = h("button", { class: "icon-btn", title: "More", onclick: (e) => { e.stopPropagation(); playlistMenu(p, e.currentTarget); } }, icon("more"));
    const play = h("button", { class: "icon-btn", title: "Play", onclick: (e) => { e.stopPropagation(); playPl(p); } }, icon("play"));
    const head = open
      ? h("div", { class: "pv-pltile-head", draggable: true, onclick: toggle }, icon("chevronDown", "pv-fold-caret"), gi("playlist"), name, h("span", { class: "pv-fold-n", text: `${p.items.length}` }), p.ytList ? h("span", { class: "chip is-quiet", title: "Imported - kept up with its link" }, icon("globe")) : null, h("span", { class: "fit-fill" }), play, more)
      : h("div", { class: "pv-pltile-face", draggable: true, onclick: toggle },
        h("div", { class: "pv-ytthumb pv-pltile-art", style: cover ? coverStyle(metaFor(cover), cover) : { backgroundImage: gradientFor(p.name) } }, h("span", { class: "pv-pltile-badge" }, gi("playlist"), String(p.items.length)),
          // a click here unfolds the playlist (its ▶ plays): said on hover, so nobody expects it to start
          h("span", { class: "pv-pltile-open" }, icon("chevronDown"), "Open")),
        h("div", { class: "pv-ytmeta" }, h("div", { class: "pv-ytinfo" }, h("div", { class: "pv-yttitle" }, name), h("div", { class: "pv-ytsub", text: `Playlist · ${p.items.length} item${p.items.length === 1 ? "" : "s"}${p.ytList ? " · Imported" : ""}` })), play, more));
    const tile = h("div", { class: "pv-pltile" + (open ? " is-open" : ""), dataset: { pl: p.id }, style: plStyle(p) }, head,
      open ? (p.items.length ? onlineGrid(onlineSort === "custom" ? p.items : sorted([...p.items]), true) : h("div", { class: "pv-fold-empty", text: "Empty - drop tiles here, or pick some and “Add to playlist”." })) : null);
    head.addEventListener("dragstart", (e) => { e.stopPropagation(); e.dataTransfer.setData("application/x-leonote-pltile", p.id); e.dataTransfer.effectAllowed = "move"; });
    tile.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-leonote-play") && !e.dataTransfer.types.includes("application/x-leonote-pltile")) { e.preventDefault(); e.stopPropagation(); tile.classList.add("is-drop"); } });
    tile.addEventListener("dragleave", () => tile.classList.remove("is-drop"));
    tile.addEventListener("drop", (e) => { tile.classList.remove("is-drop"); if (e.target.closest("[data-pl] .pv-ytcard")) return; const keys = dropKeys(e); if (keys && !keys.some((k) => p.items.includes(k))) { e.stopPropagation(); M.playlists.add(p.id, keys); app.toast(`Added to ${p.name}`, { ms: 1600 }); } });
    tile.addEventListener("contextmenu", (e) => { if (e.target.closest(".pv-ytcard")) return; e.preventDefault(); playlistMenu(p, null, e); });
    return tile;
  }
  // a tile's picture is asked for when it comes near the screen: a thousand tiles load a few pictures, not a thousand
  let thumbIo = null;
  function lazyThumb(el, id) {
    if (!thumbIo) thumbIo = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbIo.unobserve(e.target);
        e.target.style.backgroundImage = `url("${M.online.thumb(e.target.dataset.yt, true)}")`;
      }
    }, { root: listEl, rootMargin: "400px 0px" });
    el.dataset.yt = id;
    thumbIo.observe(el);
    return el;
  }
  /** The videos and links removed from Online media, newest first: a click puts one back, as it was. */
  function removedGrid() {
    const list = removedList().filter((x) => !words.length || words.every((w) => String(x.title || "").toLowerCase().includes(w)));
    if (!list.length) return h("div", { class: "pv-fold-empty", text: "Nothing removed lately. What you remove from Online media waits here, to bring back." });
    const back = (x) => {
      const lib = M.online.list();
      if (!lib.some((y) => (y.id && y.id === x.id) || (y.url && y.url === x.url))) { const { removedAt, ...e } = x; void removedAt; app.setSetting("youtubeLibrary", [e, ...lib]); }
      app.setSetting("onlineRemoved", removedList().filter((y) => y !== x));
      renderList();
      app.toast(`“${x.title || "It"}” is back in Online media`, { ms: 2000 });
    };
    return h("div", { class: "pv-ytgrid" }, list.map((x) => {
      const thumbEl = h("div", { class: "pv-ytthumb", style: x.id ? null : { backgroundImage: gradientFor(x.title || x.url || "") } },
        h("button", { class: "pv-ytgone is-back", title: "Back into Online media, as it was", onclick: (e) => { e.stopPropagation(); back(x); } }, icon("undo"), "Bring back"));
      if (x.id) lazyThumb(thumbEl, x.id);
      // a click plays it, as it is - it stays removed until brought back
      return h("div", { class: "pv-ytcard is-removed", title: `${x.title || ""}
Click to play · Bring back puts it in Online media again`, onclick: () => M.playKey(x.id ? ytKey(x.id) : urlKey(x.url)) }, thumbEl,
        h("div", { class: "pv-ytmeta" }, h("div", { class: "pv-ytinfo" }, h("div", { class: "pv-yttitle", text: x.title || x.url || x.id }), h("div", { class: "pv-ytsub", text: x.removedAt ? `Removed ${new Date(x.removedAt).toLocaleDateString()}` : "Removed" }))));
    }));
  }
  function onlineGrid(keys, gradual = false) {
    const FIRST = 240, STEP = 600;
    if (gradual && keys.length > FIRST) {
      const grid = h("div", { class: "pv-ytgrid" }, keys.slice(0, FIRST).map((k) => cardOf(k, keys)));
      // the rest comes a frame at a time: the Player answers at once, and every tile is there a moment later
      let i = FIRST;
      const more = () => {
        if (!grid.isConnected && i > FIRST) return; // drawn over since
        grid.append(...keys.slice(i, i + STEP).map((k) => cardOf(k, keys)));
        i += STEP;
        if (i < keys.length) requestAnimationFrame(more);
      };
      requestAnimationFrame(more);
      return grid;
    }
    return h("div", { class: "pv-ytgrid" }, keys.map((k) => cardOf(k, keys)));
  }
  function cardOf(k, keys) {
    {
      const m = metaFor(k);
      const thumb = isYt(k) ? null : { backgroundImage: gradientFor(m.artist + m.title) };
      const gone = isYt(k) && !!(M.online.entry(k) || {}).gone;
      const webOnly = !gone && isYt(k) && !!(M.online.entry(k) || {}).webOnly;
      const thumbEl = h("div", { class: "pv-ytthumb", style: thumb },
          webOnly ? h("span", { class: "pv-ytgone is-web", title: "Its owner lets it play only on YouTube - it opens in the Player's browser (right-click › Open in the browser here)" }, icon("globe"), "Web only") : null,
          isUrl(k) ? h("span", { class: "pv-ytkind" }, icon(m.audio ? "music" : "film")) : null,
          gone ? h("span", { class: "pv-ytgone" + ((M.online.entry(k) || {}).private ? " is-private" : ""), title: (M.online.entry(k) || {}).private ? "Its owner made it private - only people they let in can watch it, signed in on YouTube (Watch on YouTube, in the Player's browser)." : "No longer available on YouTube. You can look for it again from the menu." }, icon("alert"), (M.online.entry(k) || {}).private ? "Private" : "Gone") : null,
          h("span", { class: "pv-ytplay pv-art-state" }, gi("play", "is-play"), gi("pause", "is-pause")), h("span", { class: "pv-bars" }, h("i"), h("i"), h("i")));
      if (isYt(k)) lazyThumb(thumbEl, ytIdOf(k));
      const card = h("div", { class: "pv-ytcard" + (gone ? " is-gone" : ""), dataset: { key: k }, draggable: true },
        thumbEl,
        h("div", { class: "pv-ytmeta" }, h("div", { class: "pv-ytinfo" }, h("div", { class: "pv-yttitle", text: m.title, title: m.title }), h("div", { class: "pv-ytsub", text: subOf(k, m) })),
          // YouTube named as the source on each of its tiles, a link to the video there
          isYt(k) ? h("button", { class: "link-btn pv-ytsrc", title: "From YouTube - open it on youtube.com", onclick: (e) => { e.stopPropagation(); app.openUrl(`https://www.youtube.com/watch?v=${ytIdOf(k)}`); } }, "YouTube") : null,
          h("button", { class: "icon-btn pv-yttrash", title: "Remove from Online media", onclick: (e) => { e.stopPropagation(); quickRemove(k); } }, icon("trash")),
          h("button", { class: "icon-btn", title: "More", onclick: (e) => { e.stopPropagation(); rowMenu(k, keys, e.currentTarget); } }, icon("more"))));
      card.addEventListener("click", () => {
        M.current() === k ? M.toggle() : playFrom(keys, k);
      });
      card.addEventListener("contextmenu", (e) => { e.preventDefault(); rowMenu(k, keys, null, e); });
      card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-leonote-play", JSON.stringify([k])); dragKey = k; });
      card.addEventListener("dragend", () => { dragKey = null; });
      // held over the middle of another tile for a moment - not a mere pass, like tabs making a group - and dropped there: a playlist of the two
      let dwell = null;
      const mergeOff = () => { clearTimeout(dwell); dwell = null; card.classList.remove("is-merge", "is-merging"); };
      card.addEventListener("dragover", (e) => {
        if (!dragKey || dragKey === k || tab !== "youtube" || card.closest("[data-pl]")) return;
        const r = card.getBoundingClientRect();
        const inMiddle = Math.abs(e.clientX - (r.left + r.width / 2)) < r.width * 0.3 && Math.abs(e.clientY - (r.top + r.height / 2)) < r.height * 0.3;
        if (!inMiddle) { mergeOff(); return; }
        e.preventDefault();
        if (card.classList.contains("is-merge")) { e.stopPropagation(); return; }
        card.classList.add("is-merging");
        if (!dwell) dwell = setTimeout(() => { card.classList.add("is-merge"); }, 600);
      });
      card.addEventListener("dragleave", mergeOff);
      card.addEventListener("drop", (e) => {
        const merge = card.classList.contains("is-merge");
        mergeOff();
        if (!merge) return;
        e.preventDefault(); e.stopPropagation();
        const dropped = (dropKeys(e) || []).filter((x) => x !== k);
        if (!dropped.length) return;
        const pl = M.playlists.create(`Playlist ${M.playlists.all().length + 1}`, [k, ...dropped], { showOnline: true });
        app.setSetting("playerPlOpen", [...(S.playerPlOpen || []), pl.id]);
        app.toast(`Playlist made from ${dropped.length + 1} - double-click its name to rename`, { ms: 3000 });
      });
      rows.set(k, card);
      return card;
    }
  }

  /* playlists */
  function playlistCards() {
    const pls = M.playlists.all();
    const q = query.trim().toLowerCase();
    const acts = h("div", { class: "pv-placts" },
      h("button", { class: "btn pv-btn-sm", onclick: () => newPlaylist([]) }, icon("plus"), "New playlist"),
      h("button", { class: "btn pv-btn-sm", disabled: !M.queue.items.length, title: "Keep the current queue as a playlist", onclick: () => newPlaylist(M.queue.items) }, gi("queue"), "Save the queue"),
      h("button", { class: "btn pv-btn-sm", title: "A playlist saved by another player (.m3u8 or .m3u)", onclick: importM3u }, icon("download"), "Import .m3u8…"),
      h("button", { class: "btn pv-btn-sm", title: "The songs you Shazamed: shazam.com › My Shazam › Download gives a CSV - or a list of “Artist - Title” lines", onclick: importShazam }, icon("music"), "Import from Shazam…"));
    if (!pls.length) return h("div", {}, acts, h("div", { class: "pv-empty" }, gi("playlist", "pv-empty-ico"), h("h3", { text: "No playlists yet" }),
      h("p", { text: "Mix songs, videos and online media into one playlist: pick a few and choose “Add to playlist”, or save the queue." })));
    const grid = h("div", { class: "pv-plgrid" },
      pls.filter((p) => !q || p.name.toLowerCase().includes(q)).map((p) => {
        const cover = firstInOrder(p.items, (k) => metaFor(k).cover || isYt(k));
        const openIt = () => { openList = p.id; limit = PAGE; renderList(); };
        const card = h("div", { class: "pv-plcard", ...pressable(openIt), dataset: { pl: p.id }, style: plStyle(p), onclick: openIt },
          h("span", { class: "pv-plart", style: cover ? coverStyle(metaFor(cover), cover) : { backgroundImage: gradientFor(p.name) } },
            h("span", { class: "pv-pill" },
              h("button", { class: "icon-btn", title: "Play", onclick: (e) => { e.stopPropagation(); playPl(p); } }, icon("play")),
              h("button", { class: "icon-btn", title: "More", onclick: (e) => { e.stopPropagation(); playlistMenu(p, e.currentTarget); } }, icon("more")))),
          h("span", { class: "pv-plname", text: p.name }),
          h("span", { class: "pv-plsub", text: `${p.items.length} item${p.items.length === 1 ? "" : "s"}` }));
        card.addEventListener("contextmenu", (e) => { e.preventDefault(); playlistMenu(p, null, e); });
        // songs dropped on a card join that playlist
        card.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-leonote-play")) { e.preventDefault(); card.classList.add("is-drop"); } });
        card.addEventListener("dragleave", () => card.classList.remove("is-drop"));
        card.addEventListener("drop", (e) => { card.classList.remove("is-drop"); const keys = dropKeys(e); if (keys) { M.playlists.add(p.id, keys); app.toast(`Added to ${p.name}`, { ms: 1600 }); } });
        return card;
      }));
    return h("div", {}, acts, grid, h("p", { class: "pv-hint", text: "Playlists are kept in Leonote's settings. Export one as .m3u8 to use it in other players." }));
  }
  const IMPORT_LABEL = { spotify: "Spotify", youtube: "YouTube", shazam: "Shazam" };
  function playlistHead(keys) {
    const pl = M.playlists.all().find((p) => p.id === openList);
    if (!pl) return null;
    if (pl.tracks) return importedHead(pl, keys);
    const name = h("h2", { class: "pv-plh-name", text: pl.name, title: "Click to rename", onclick: () => inlineEdit(name, pl.name, { onCommit: (v) => M.playlists.rename(pl.id, v.trim()) }) });
    return h("div", { class: "pv-plh" },
      h("button", { class: "icon-btn", title: "All playlists", onclick: () => { openList = null; renderList(); } }, icon("back")),
      name, h("span", { class: "pv-gap" }),
      h("div", { class: "pv-plh-acts" },
        h("button", { class: "btn btn-primary pv-btn-sm", disabled: !keys.length, onclick: () => playL(keys, 0) }, gi("play"), "Play"),
        h("button", { class: "btn pv-btn-sm", disabled: !keys.length, onclick: () => { playL(keys, Math.floor(Math.random() * keys.length)); M.setShuffle(true); } }, gi("shuffle"), "Shuffle"),
        h("button", { class: "icon-btn", title: "More", onclick: (e) => playlistMenu(pl, e.currentTarget) }, icon("more"))));
  }
  function importedHead(pl, keys) {
    const total = pl.tracks.length;
    const got = pl.tracks.filter((t) => t.key).length;
    const onYt = pl.tracks.filter((t) => t.key && t.yt).length;
    const name = h("h2", { class: "pv-plh-name", text: pl.name, title: "Click to rename", onclick: () => inlineEdit(name, pl.name, { onCommit: (v) => M.playlists.rename(pl.id, v.trim()) }) });
    const where = IMPORT_LABEL[pl.from && pl.from.kind] || "elsewhere";
    return h("div", {},
      h("div", { class: "pv-plh" },
        h("button", { class: "icon-btn", title: "All playlists", onclick: () => { openList = null; renderList(); } }, icon("back")),
        name, h("span", { class: "pv-gap" }),
        h("div", { class: "pv-plh-acts" },
          h("button", { class: "btn btn-primary pv-btn-sm", disabled: !keys.length, onclick: () => playL(keys, 0) }, gi("play"), "Play what I have"),
          h("button", { class: "btn pv-btn-sm", onclick: () => rematch(pl) }, icon("rotateRight"), "Match again"),
          got < total ? h("button", { class: "btn pv-btn-sm", title: "Each song not in your music: the first video YouTube finds for its name and artist, so the whole list plays", onclick: () => findAllOnYt(pl) }, icon("globe"), "Find the rest on YouTube") : null,
          h("button", { class: "icon-btn", title: "More", onclick: (e) => playlistMenu(pl, e.currentTarget) }, icon("more")))),
      h("div", { class: "pv-imported" },
        h("span", { class: "pv-imported-count", text: `${got - onYt} of ${total} in your own music${onYt ? ` · ${onYt} found on YouTube` : ""}` }),
        h("span", { class: "pv-imported-note", text: pl.from && pl.from.kind === "shazam" ? "Imported from Shazam. The rest are names - Find on YouTube plays them." : `Imported from ${where}. The rest are names only - Leonote never plays or downloads from ${where}.` }),
        pl.from && pl.from.url ? h("button", { class: "link-btn", onclick: () => app.openUrl(pl.from.url) }, `Open on ${where}`) : null));
  }
  /** A track we do not have: still visible, with a way to find or open it. */
  function missingRow(t, pl, i) {
    const who = (t.artists || []).join(", ");
    const where = IMPORT_LABEL[pl.from && pl.from.kind] || "";
    return h("div", { class: "pv-row is-unmatched", dataset: { i: String(i) } },
      h("span", { class: "pv-r-num" }, h("span", { class: "pv-r-n", text: String(i + 1) })),
      h("span", { class: "pv-art is-sm is-ghost" }, icon("search")),
      h("span", { class: "pv-r-main" },
        h("span", { class: "pv-r-title", text: t.title }),
        h("span", { class: "pv-r-sub", text: [who, t.album, "not in your music"].filter(Boolean).join(" · ") })),
      t.duration ? h("span", { class: "pv-r-dur", text: fmtTime(t.duration) }) : null,
      h("div", { class: "pv-unmatched-acts" },
        h("button", { class: "btn pv-btn-sm", title: "Look for it in your own files", onclick: () => {
          search.value = `${t.title} ${who}`.trim();
          query = search.value;
          setTab("music");
          search.focus();
        } }, "Find in my files…"),
        h("button", { class: "btn pv-btn-sm", title: "The first video YouTube finds for its name and artist", onclick: () => findAllOnYt(pl, [t]) }, "Find on YouTube"),
        t.url ? h("button", { class: "icon-btn", title: `Open on ${where}`, onclick: () => app.openUrl(t.url) }, icon("globe")) : null));
  }

  /** A file picked on this computer, read: in the vault or outside it. */
  async function readPicked(abs) {
    const a = String(abs).replace(/\\/g, "/");
    const root = String(app.vault.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const inVault = !!root && a.toLowerCase().startsWith(root.toLowerCase() + "/");
    const rel = inVault ? a.slice(root.length + 1) : "";
    return { a, root, inVault, rel, text: await app.host.readText(inVault ? rel : (await app.host.guestOpen(abs)).path) };
  }
  /** A playlist file from another player: its songs, videos and links, as a playlist here. */
  async function importM3u() {
    const abs = await app.host.dialogOpen({ title: "A playlist file", multiple: false, directory: false, filters: [{ name: "Playlist", extensions: ["m3u8", "m3u"] }] });
    if (!abs) return;
    let a, root, inVault, rel, text;
    try { ({ a, root, inVault, rel, text } = await readPicked(abs)); }
    catch (e) { return app.toast("Could not read it: " + e, { kind: "error" }); }
    // a path next to the file is found from where the file is
    const dir = (inVault ? rel : a).replace(/\/[^/]*$/, "");
    const keys = [...new Set(fromM3u(text, inVault && !rel.includes("/") ? "" : dir).map((k) => {
      // a full path: the vault's own file when it lies in the vault, else a file outside it
      const p = k.startsWith("lib:") ? k.slice(4) : k;
      if (!/^[a-z]:\//i.test(p)) return k;
      return root && p.toLowerCase().startsWith(root.toLowerCase() + "/") ? p.slice(root.length + 1) : libKey(p);
    }))];
    if (!keys.length) return app.toast("Nothing to play in that file", { kind: "error" });
    const name = a.split("/").pop().replace(/\.m3u8?$/i, "") || "Imported playlist";
    const missing = keys.filter((k) => !isOnline(k) && !isLib(k) && !app.vault.files.has(k)).length;
    const pl = M.playlists.create(name, keys);
    openList = pl.id;
    limit = PAGE;
    renderList();
    app.toast(`Imported “${name}”: ${keys.length} item${keys.length === 1 ? "" : "s"}${missing ? ` · ${missing} not found in the vault (kept, marked missing)` : ""}`, { ms: 5000 });
  }
  /* The songs you Shazamed: shazam.com › My Shazam › Download (a CSV), or any list of "Artist - Title"
     lines. An imported playlist - your own files where they match, the rest by name, each a click from YouTube. */
  async function importShazam() {
    const abs = await app.host.dialogOpen({ title: "Your Shazam library (CSV), or a list of songs", multiple: false, directory: false, filters: [{ name: "Shazam library or a list", extensions: ["csv", "txt"] }] }).catch(() => null);
    if (!abs) return;
    let text;
    try { ({ text } = await readPicked(abs)); } catch (e) { return app.toast("Could not read it: " + e, { kind: "error" }); }
    const { parseCsv, csvSeparator } = await import("./officeview.js");
    const songs = shazamTracks(text, parseCsv(text, csvSeparator(text)));
    if (!songs.length) return app.toast("No songs in it - Shazam's CSV has Title and Artist columns; a list needs “Artist - Title” lines", { kind: "error", ms: 7000 });
    const { tracks, matched, total } = matchTracks(songs, M.playlists.candidates());
    const pl = M.playlists.create("Shazam", tracks.filter((t) => t.key).map((t) => t.key), { tracks, from: { kind: "shazam", url: "https://www.shazam.com/myshazam" } });
    tab = "playlists";
    openList = pl.id;
    limit = PAGE;
    app.setSetting("playerTab", tab);
    renderList();
    app.toast(`${total} songs from Shazam · ${matched} in your own music${matched < total ? " · Find the rest on YouTube plays the others" : ""}`, { ms: 6000 });
  }
  /* Songs known by name only, found on YouTube - the first video for "title artist" - one after another;
     each lands in Online media and plays in the list. */
  let finding = null;
  async function findAllOnYt(pl, only = null) {
    if (finding) return app.toast("Already looking - a moment", { ms: 1800 });
    const want = (only || pl.tracks).filter((t) => !t.key);
    if (!want.length) return;
    // each one costs about 100 of the 10,000 a Google app may use a day: a long list could use it all, the
    // playlist sending and reading too
    if (want.length > 50) {
      const { confirmDialog } = await import("./ui.js");
      if (!(await confirmDialog(`Look for ${want.length} songs on YouTube?`, `Each search uses about 100 of your Google app's 10,000 a day - ${want.length} would use about ${Math.min(100, Math.round(want.length))}% of today's, and playlist sending and reading wait for tomorrow if it runs out. Stop goes on working.`, { ok: "Look for them", danger: false, safe: true }))) return;
    }
    finding = { stop: false };
    const close = want.length > 1 ? app.toast(`Looking for ${want.length} on YouTube…`, { ms: 600000, action: { label: "Stop", run: () => { finding.stop = true; } } }) : null;
    let found = 0;
    let refused = ""; // through YouTube's service: no sign-in or key, or the day's allowance used up - the rest would fail the same
    try {
      for (const t of want) {
        if (finding.stop) break;
        const r = await findYtVideo(app, `${t.title} ${(t.artists || []).join(" ")}`).catch((e) => { refused = String(e.message || e); return null; });
        if (refused) break;
        if (!r || !r.id) continue;
        const key = ytKey(r.id);
        M.online.addMany([{ id: r.id, title: r.title || t.title }]);
        const now = M.playlists.all().find((p) => p.id === pl.id);
        if (!now) break;
        const tracks = now.tracks.map((x) => (x.title === t.title && (x.artists || []).join() === (t.artists || []).join() && !x.key ? { ...x, key, yt: true } : x));
        M.playlists.set(pl.id, tracks.filter((x) => x.key).map((x) => x.key), { tracks });
        found++;
        if (visible && openList === pl.id) renderList();
      }
    } finally { finding = null; if (close) close(); }
    if (refused) return app.toast(found ? `${found} found on YouTube. ${refused}` : refused, { kind: "error", ms: 9000 });
    app.toast(found ? `${found} found on YouTube${found < want.length ? ` · ${want.length - found} not` : ""}` : "Nothing found on YouTube", { ms: 4000 });
  }
  /* A YouTube playlist's songs taken out here: listed under it, each to restore - YouTube's daily read
     leaves them out until then. */
  function takenOut() {
    const pl = M.playlists.all().find((p) => p.id === openList);
    const keys = pl && pl.ytList ? (pl.ytSkip || []).filter((k) => !pl.items.includes(k)) : [];
    if (!keys.length) return null;
    const names = pl.ytSkipNames || {};
    const nameOf = (k) => names[k] || (M.online.entry(k) || {}).title || "A video";
    const restore = (ks) => {
      const skip = new Set(pl.ytSkip || []);
      for (const k of ks) skip.delete(k);
      M.online.addMany(ks.filter(isYt).map((k) => ({ id: ytIdOf(k), title: nameOf(k) })));
      // sent to YouTube too when this playlist sends its changes there
      M.playlists.set(pl.id, [...pl.items, ...ks], { ytSkip: [...skip] }, !(app.ytPush && app.ytPush.pushOn(pl)));
      app.toast(ks.length > 1 ? `${ks.length} back in “${pl.name}”` : `“${nameOf(ks[0])}” is back in “${pl.name}”`, { ms: 3000 });
    };
    return h("details", { class: "pv-taken" },
      h("summary", {}, `Taken out here · ${keys.length} - YouTube's daily read leaves ${keys.length === 1 ? "it" : "them"} out`,
        h("button", { class: "link-btn", onclick: (e) => { e.preventDefault(); restore(keys); } }, "Restore all")),
      ...keys.map((k) => h("div", { class: "pv-row is-unmatched" },
        h("span", { class: "pv-art is-sm", style: isYt(k) ? { backgroundImage: `url("${M.online.thumb(ytIdOf(k))}")`, backgroundSize: "cover" } : {} }),
        h("span", { class: "pv-r-main" }, h("span", { class: "pv-r-title", text: nameOf(k) }), h("span", { class: "pv-r-sub", text: "taken out of this playlist" })),
        h("div", { class: "pv-unmatched-acts" }, h("button", { class: "btn pv-btn-sm", onclick: () => restore([k]) }, "Restore")))));
  }
  function newPlaylist(keys) {
    const n = M.playlists.all().length + 1;
    const pl = M.playlists.create(`Playlist ${n}`, keys);
    tab = "playlists";
    openList = pl.id;
    app.setSetting("playerTab", tab);
    renderList();
    const name = listEl.querySelector(".pv-plh-name");
    if (name) name.click();
    return pl;
  }
  /** Read YouTube's list now: new videos in, and (if told to) the ones taken out there out. */
  async function refreshYt(pl) {
    app.toast("Reading the playlist…", { ms: 2000 });
    try { app.toast(syncSaid(pl.name, await syncYtList(app, M, pl), true), { ms: 6000 }); }
    catch (e) { app.toast(`Could not read “${pl.name}”: ${e.message || e}`, { kind: "error", ms: 6000 }); }
  }
  /** "Send my changes to YouTube": signed in first, if it is not. */
  async function pushSwitch(pl) {
    const yp = app.ytPush;
    if (!yp) return;
    if (yp.pushOn(pl)) { yp.setPushOn(pl, false); M.playlists.patch(pl.id, { ytPush: false }); return app.toast("Changes stay in Leonote", { ms: 2000 }); }
    if (!yp.connected()) {
      if (!(await confirmDialog("Sign in to YouTube?", "Taking a video out of this playlist here (or adding one) then does the same in the YouTube playlist - your own playlists only. It signs in with your Google app from Settings › Calendar, which needs the YouTube Data API v3 turned on.", { ok: "Sign in" }))) return;
      try { app.toast("Finish signing in in your browser…", { ms: 6000 }); await yp.connect(); }
      catch (e) { return app.toast(String(e.message || e), { kind: "error", ms: 8000 }); }
    }
    yp.setPushOn(pl, true);
    M.playlists.patch(pl.id, { ytPush: true });
    app.toast(`Changes to “${pl.name}” now go to YouTube too`, { ms: 3000 });
  }
  /** Any colour for a playlist, with the colour picker the drawing tools use; seen on its tiles as you pick. */
  function customPlColor(pl, at) {
    const spot = h("div", { style: { position: "fixed", left: at.x + "px", top: at.y + "px", width: "1px", height: "1px" } });
    document.body.append(spot);
    const hex0 = typeof pl.color === "string" && pl.color.startsWith("#") ? pl.color : "#e0a84a";
    let chosen = null;
    import("./colourpop.js").then(({ colourPop }) => colourPop(spot, {
      value: hex0, title: "Playlist colour",
      onPick: (hex) => { chosen = hex; for (const t of document.querySelectorAll(`[data-pl="${CSS.escape(pl.id)}"]`)) t.style.setProperty("--plc", hex); },
      onClose: () => { spot.remove(); if (chosen) { M.playlists.patch(pl.id, { color: chosen }); renderList(); } },
    }));
  }
  function playlistMenu(pl, anchor, e) {
    const r = anchor ? anchor.getBoundingClientRect() : null;
    app.menu(e ? e.clientX : r.left, e ? e.clientY : r.bottom + 4, [
      { label: "Play", icon: "play", run: () => playPl(pl) },
      (S.plLast || {})[pl.id] ? { label: "Play from the start", icon: "rotateLeft", run: () => { if (pl.items.length) { M.playList(pl.items, 0, pl.name); playingPl = pl.id; } } } : null,
      { label: "Add to queue", icon: "plus", run: () => M.enqueue(pl.items) },
      { label: "Colour", icon: "palette", sub: [
        ...PL_HUES.map(([hue, name]) => ({ label: name, swatch: `hsl(${hue} 72% 62%)`, checked: pl.color === hue, run: () => { M.playlists.patch(pl.id, { color: hue }); renderList(); } })),
        "sep",
        { label: "Another at random", icon: "shuffle", run: () => { M.playlists.patch(pl.id, { color: Math.floor(Math.random() * 360) }); renderList(); } },
        { label: "Your own…", icon: "palette", run: () => customPlColor(pl, r ? { x: r.left, y: r.bottom } : { x: e.clientX, y: e.clientY }) },
        { label: "Plain - no colour", checked: pl.color === "plain", run: () => { M.playlists.patch(pl.id, { color: "plain" }); renderList(); } },
      ] },
      pl.ytList ? { label: "Refresh from its link", icon: "redo", run: () => refreshYt(pl) } : null,
      pl.ytList ? { label: "Open the original", icon: "globe", run: () => app.openUrl(pl.ytList) } : null,
      // the same playlist at a new address (copied to another account, made again): the link it is read from
      pl.ytList ? { label: "Change its link…", icon: "link", run: async () => {
        const r = await askDialog("The playlist's link", [{ key: "url", label: "Link (the one with list=…)", value: pl.ytList }], { ok: "Use it", text: "Making it unlisted or public keeps its link - nothing to change then. A private playlist cannot be read by anyone but its owner." });
        const u = r && r.url.trim();
        if (!u || u === pl.ytList) return;
        if (!/[?&]list=[\w-]+/.test(u)) return app.toast("That link has no list=… in it", { kind: "error", ms: 4000 });
        M.playlists.patch(pl.id, { ytList: u });
        refreshYt({ ...pl, ytList: u });
      } } : null,
      pl.ytList ? { label: "Keep up with the original - new videos come in daily", icon: "rotateRight", checked: pl.ytSync === true, run: () => M.playlists.patch(pl.id, { ytSync: pl.ytSync !== true }) } : null,
      pl.ytList ? { label: "New videos at the top (off: in the original's order)", icon: "arrowUp", checked: pl.ytNewTop !== false, run: () => M.playlists.patch(pl.id, { ytNewTop: pl.ytNewTop === false }) } : null,
      pl.ytList ? { label: "A Windows notification when videos come or go", icon: "bell", checked: S.ytNotify !== false, run: () => app.setSetting("ytNotify", S.ytNotify === false) } : null,
      pl.ytList ? { label: "Take out what I remove in the original", icon: "minus", checked: !!pl.ytPrune, run: () => {
        M.playlists.patch(pl.id, { ytPrune: !pl.ytPrune });
        if (!pl.ytPrune) app.toast("A video you took out of the original playlist goes from here at the next read. One that is no longer on YouTube stays in your list.", { ms: 7000 });
      } } : null,
      pl.ytList ? { label: "Send my changes to YouTube", icon: "outside", checked: !!(app.ytPush && app.ytPush.pushOn(pl)), run: () => pushSwitch(pl) } : null,
      { label: "Rename", icon: "edit", run: () => { openList = pl.id; renderList(); const n = listEl.querySelector(".pv-plh-name"); if (n) n.click(); } },
      { label: "Export as .m3u8", icon: "save", run: () => M.playlists.export(pl.id).then((p) => app.toast(`Saved ${p}`, { action: { label: "Show", run: () => app.reveal(p) } })).catch((err) => app.toast("Could not export: " + err, { kind: "error" })) },
      "sep",
      { label: onlineShown(pl) ? "Hide from the Online tiles" : "Include among the Online tiles", icon: onlineShown(pl) ? "x" : "globe", run: () => setOnlineShown(pl, !onlineShown(pl)) },
      { label: "Delete playlist", icon: "trash", danger: true, run: async () => {
        // an imported YouTube playlist brought its videos in: they go with it, unless one was also added on its own or sits in another playlist
        const others = new Set(M.playlists.all().filter((p) => p.id !== pl.id).flatMap((p) => p.items));
        const own = pl.ytList ? pl.items.filter((k) => isOnline(k) && !others.has(k) && !(M.online.entry(k) || {}).loose) : [];
        const n = own.length;
        if (!(await confirmDialog(`Delete “${pl.name}”?`, n ? `Its ${n} video${n === 1 ? "" : "s"} go from Online media too - any also added on its own or kept in another playlist stay. Undo brings it all back.` : "The songs stay in your vault."))) return;
        const lists = M.playlists.all(), lib = M.online.list();
        M.playlists.remove(pl.id);
        if (n) M.online.remove(own);
        if (openList === pl.id) openList = null;
        renderList();
        const undo = () => { M.playlists.restore(lists); if (n) M.online.restore(lib); };
        undos.push(undo);
        app.toast(`Deleted “${pl.name}”${n ? ` and its ${n} video${n === 1 ? "" : "s"}` : ""}`, { ms: 8000, action: { label: "Undo", run: undo } });
      } },
    ]);
  }

  /* selection */
  function pick(key, e, all) {
    if (e.target.closest("button")) return;
    if (e.shiftKey && anchorKey && all.includes(anchorKey)) {
      const a = all.indexOf(anchorKey), b = all.indexOf(key);
      if (!e.ctrlKey) sel.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(all[i]);
    } else if (e.ctrlKey || e.metaKey) {
      sel.has(key) ? sel.delete(key) : sel.add(key);
      anchorKey = key;
    } else {
      // a plain click plays it, or pauses / resumes it when it is the one playing
      sel.clear();
      sel.add(key);
      anchorKey = key;
      if (M.current() === key) M.toggle();
      else playFrom(all, key);
    }
    paintSel();
  }
  function paintSel() {
    for (const [k, r] of rows) r.classList.toggle("is-sel", sel.has(k));
    const n = sel.size;
    selBar.hidden = n < 2;
    if (n < 2) return;
    const keys = visibleKeys().filter((k) => sel.has(k));
    selBar.replaceChildren(
      h("span", { class: "pv-sel-n", text: `${n} selected` }),
      h("button", { class: "btn btn-primary pv-btn-sm", onclick: () => playL(keys, 0) }, gi("play"), "Play"),
      h("button", { class: "btn pv-btn-sm", onclick: () => { M.enqueue(keys, { next: true }); app.toast(`${keys.length} will play next`, { ms: 1800 }); } }, "Play next"),
      h("button", { class: "btn pv-btn-sm", onclick: () => { M.enqueue(keys); app.toast(`Added ${keys.length} to the queue`, { ms: 1800 }); } }, "Add to queue"),
      h("button", { class: "btn pv-btn-sm", onclick: (e) => addToPlaylistMenu(keys, e.currentTarget) }, "Add to playlist"),
      h("span", { class: "pv-gap" }),
      h("button", { class: "icon-btn", title: "Clear selection (Esc)", onclick: () => { sel.clear(); paintSel(); } }, icon("x")));
  }
  // played from search results: the queue is what was found - until the search is cleared, when the
  // song goes on inside its whole list (the tab, or the open playlist) without stopping
  let fromSearch = null;
  function playFrom(all, key) {
    playL(all, Math.max(0, all.indexOf(key)));
    fromSearch = query.trim() && !draft ? { tab, openList, sig: all.join("\n") } : null;
  }
  function backFromSearch() {
    const f = fromSearch;
    fromSearch = null;
    if (f.tab !== tab || f.openList !== openList || M.queue.items.join("\n") !== f.sig) return; // the queue moved on since
    const all = visibleKeys(), k = M.current();
    if (all.includes(k)) M.requeue(all, all.indexOf(k), listName());
  }

  /* menus */
  const at = (anchor, e) => { if (e) return [e.clientX, e.clientY]; const r = anchor.getBoundingClientRect(); return [r.right - 220, r.bottom + 4]; };
  function addToPlaylistMenu(keys, anchor, e) {
    const [x, y] = at(anchor, e);
    app.menu(x, y, [
      { header: "Add to playlist" },
      { label: "New playlist…", icon: "plus", run: () => newPlaylist(keys) },
      ...M.playlists.all().map((p) => ({ label: p.name, icon: "list", run: () => { M.playlists.add(p.id, keys); app.toast(`Added to ${p.name}`, { ms: 1600 }); } })),
    ]);
  }
  /** `queueAt`: the row is the queue's - Play plays it there, and it can leave the queue. */
  function rowMenu(key, all, anchor, e, { queueAt = -1 } = {}) {
    const keys = sel.has(key) && sel.size > 1 ? all.filter((k) => sel.has(k)) : [key];
    const many = keys.length > 1;
    const [x, y] = at(anchor, e);
    const pl = tab === "playlists" && openList ? M.playlists.all().find((p) => p.id === openList) : null;
    const online = isOnline(key);
    const link = isYt(key) ? `https://www.youtube.com/watch?v=${ytIdOf(key)}` : urlOf(key);
    const goneOne = !many && isYt(key) && !!(M.online.entry(key) || {}).gone;
    app.menu(x, y, [
      goneOne ? { header: "No longer on YouTube" } : null,
      goneOne ? { label: "Find it again on YouTube", icon: "search", run: () => searchFor((M.online.entry(key) || {}).title || "") } : null,
      goneOne ? { label: "Search for it on…", icon: "globe", sub: SEARCH_SITES.map((site) => ({ label: site[0], run: () => searchFor((M.online.entry(key) || {}).title || "", site) })) } : null,
      goneOne ? { label: "Replace with another video…", icon: "swap", run: () => replaceGone(key) } : null,
      goneOne ? { label: "Copy the name", icon: "clipboard", run: () => navigator.clipboard.writeText((M.online.entry(key) || {}).title || "").then(() => app.toast("Copied", { ms: 1200 })) } : null,
      goneOne ? "sep" : null,
      { label: many ? `Play ${keys.length}` : "Play", icon: "play", run: () => (many ? playL(keys, 0) : queueAt >= 0 ? M.playAt(queueAt) : playFrom(all, key)) },
      queueAt >= 0 ? { label: "Remove from the queue", icon: "minus", run: () => M.removeAt(queueAt) } : null,
      { label: "Play next", icon: "forward", run: () => M.enqueue(keys, { next: true }) },
      { label: "Add to queue", icon: "plus", run: () => { M.enqueue(keys); app.toast(many ? `Added ${keys.length} to the queue` : "Added to the queue", { ms: 1600 }); } },
      { label: "Add to playlist…", icon: "list", run: () => addToPlaylistMenu(keys, null, { clientX: x, clientY: y }) },
      keys.some((k) => taggable(app, k)) ? { label: many ? `Tags for ${keys.filter((k) => taggable(app, k)).length}…` : "Tags…", icon: "hash", run: () => tagsDialog(app, M, keys.filter((k) => taggable(app, k)), knownTags()).then(() => setTimeout(renderList, 250)) } : null,
      !many && !online && AUDIO_FILE.test(key) && app.host.musicTagsWrite ? { label: "Edit details…", icon: "edit", run: () => detailsDialog(app, M, key).then((ok) => { if (ok) setTimeout(renderList, 400); }) } : null,
      "sep",
      ...fileItems(key, keys, many, x, y),
      !many && online ? { label: "Open in the browser here", icon: "globe", run: () => openHere(link, key) } : null,
      !many && online ? { label: "Open in your browser", icon: "outside", run: () => app.openUrl(link) } : null,
      !many && isYt(key) ? { label: "Open the channel", icon: "users", run: async () => {
        const { ytTitle } = await import("./youtube.js");
        const r = await ytTitle(ytIdOf(key));
        if (r && r.authorUrl) openHere(r.authorUrl); else app.toast(r && r.gone ? "The video is gone - so is the way to its channel" : "YouTube did not say whose it is", { ms: 2400 });
      } } : null,
      !many && online ? { label: "Copy link", icon: "link", run: () => { navigator.clipboard.writeText(link); app.toast("Link copied", { ms: 1400 }); } } : null,
      // only direct links to files: never for video sites
      !many && isUrl(key) ? { label: "Save to vault…", icon: "save", run: () => saveToVault(key, anchor, { clientX: x, clientY: y }) } : null,
      pl ? { label: "Remove from playlist", icon: "minus", danger: true, run: () => {
        const was = pl.items;
        M.playlists.set(pl.id, was.filter((k) => !keys.includes(k)));
        app.toast(`Removed ${keys.length === 1 ? "1 track" : `${keys.length} tracks`} from ${pl.name || "the playlist"}`, { ms: 6000, action: { label: "Undo", run: () => {
          // these tracks back where they were; anything added or removed since stays so
          const now = (M.playlists.all().find((p) => p.id === pl.id) || {}).items || [];
          M.playlists.set(pl.id, [...was.filter((k) => keys.includes(k) || now.includes(k)), ...now.filter((k) => !was.includes(k))]);
        } } });
      } } : null,
      !pl && keys.every(isOnline) ? { label: "Remove from Online media", icon: "trash", danger: true, run: () => removeOnline(keys) } : null,
      !pl && keys.every(isOnline) && S.onlineRemoveAsk === false ? { label: "Ask again before the card's trash removes", icon: "undo", run: () => { app.setSetting("onlineRemoveAsk", true); app.toast("The trash on a card asks again", { ms: 2000 }); } } : null,
    ]);
  }
  function groupMenu(keys, dir, anchor) {
    const [x, y] = at(anchor);
    app.menu(x, y, [
      { label: "Play next", icon: "forward", run: () => M.enqueue(keys, { next: true }) },
      { label: "Add to playlist…", icon: "list", run: () => addToPlaylistMenu(keys, null, { clientX: x, clientY: y }) },
      { label: "Save as a playlist", icon: "save", run: () => { const pl = M.playlists.create(leaf(dir), keys); app.toast(`Saved “${pl.name}”`, { ms: 1800 }); } },
      "sep",
      { label: "Show in Explorer", icon: "folder", run: () => (isLib(keys[0]) ? app.host.externalReveal(showPath(dir)).catch((e) => app.toast(String(e), { kind: "error" })) : app.reveal(dir || keys[0])) },
    ]);
  }
  async function readList() {
    const keys = visibleKeys().filter((k) => SE.analyzable(k) && !SE.analysisOf(k));
    if (!keys.length) return app.toast("Every song in this list has been read already", { ms: 2200 });
    app.toast(`Reading ${keys.length} song${keys.length === 1 ? "" : "s"} - tempo, key, loudness. It goes on in the background.`, { ms: 4000 });
    let done = 0;
    await Promise.all(keys.map((k) => SE.analyze(k).then(() => { done++; if (done % 10 === 0) renderList(); })));
    renderList();
    app.toast(`Read ${done} song${done === 1 ? "" : "s"}`, { ms: 2400 });
  }
  function moodMenu(anchor) {
    const keys = visibleKeys().filter((k) => SE.analysisOf(k));
    const by = new Map(MOODS.map(([id]) => [id, []]));
    for (const k of keys) { const m = SE.analysisOf(k).mood; if (by.has(m)) by.get(m).push(k); }
    const unread = visibleKeys().filter((k) => SE.analyzable(k) && !SE.analysisOf(k)).length;
    const r = anchor.getBoundingClientRect();
    app.menu(r.left, r.bottom + 4, [
      { header: "A playlist of…" },
      ...MOODS.map(([id, name, what]) => ({ label: `${name} · ${what} (${by.get(id).length})`, icon: "list", run: () => {
        const list = by.get(id);
        if (!list.length) return app.toast(`No ${name.toLowerCase()} songs here${unread ? " yet - read the list first" : ""}`, { ms: 2600 });
        const pl = M.playlists.create(`${name} music`, list);
        app.toast(`Made “${pl.name}” · ${list.length} songs`, { ms: 3000 });
      } })),
      unread ? "sep" : null,
      unread ? { label: `Read the ${unread} song${unread === 1 ? "" : "s"} not read yet`, icon: "sparkles", run: readList } : null,
    ].filter(Boolean));
  }
  app.bus.on("sound:analyze-list", () => readList());
  app.bus.on("sound:moods", (a) => moodMenu(a));

  function sortMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const set = (v) => {
      if (v === "random" && curSort() === "random") seed = (Math.random() * 1e9) | 0; // a fresh shuffle
      if (tab === "youtube") { onlineSort = v; app.setSetting("playerSortOnline", v); }
      else { sort = v; app.setSetting("playerSort", v); }
      paintTabs();
      renderList();
    };
    const show = (v) => { onlineShow = v; app.setSetting("playerOnlineShow", v); paintTabs(); renderList(); };
    const lib = tab === "youtube" ? M.online.list().map(M.online.keyOf) : [];
    app.menu(r.left, r.bottom + 4, [
      ...(tab === "youtube" ? [{ header: "Show" }, ...SHOWS.map(([id, label]) => [id, label, id === "all" ? -1 : id === "removed" ? removedList().length : lib.filter(SHOW_TEST[id]).length])
        .filter(([id, , n]) => n !== 0 || id === onlineShow)
        .map(([id, label, n]) => ({ label: n >= 0 ? `${label} · ${n}` : label, checked: onlineShow === id, run: () => show(id) })),
        // where the list and its search look: every video, or only the playlists ticked here
        ...(M.playlists.all().length ? [{ header: "Only in playlists" },
          ...(onlyPl().length ? [{ label: "Every video again", icon: "x", run: () => { app.setSetting("playerOnlyPl", []); inPlSet = null; paintTabs(); renderList(); } }] : []),
          ...M.playlists.all().map((p) => ({ label: `${p.name} · ${p.items.length}`, checked: onlyPl().includes(p.id), run: () => {
            const was = onlyPl();
            app.setSetting("playerOnlyPl", was.includes(p.id) ? was.filter((x) => x !== p.id) : [...was, p.id]);
            inPlSet = null; paintTabs(); renderList();
          } }))] : []),
        "sep"] : []),
      { header: "Sort by" },
      ...SORTS.map(([id, label]) => ({ label: id === "random" && curSort() === id ? `${label}  ⟲` : label, checked: curSort() === id, run: () => set(id) })),
      "sep",
      { label: "Read the songs here: BPM, key, loudness", icon: "sparkles", run: readList },
      { label: "Playlists by mood…", icon: "list", run: () => moodMenu(anchor) },
    ]);
  }

  /* ── where the music comes from: the vault and folders outside it ────── */
  function sourceMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const set = (v) => { source = v; app.setSetting("playerSource", v); limit = PAGE; renderList(); };
    const libs = M.libraries.list();
    app.menu(r.left, r.bottom + 4, [
      { header: "Show" },
      { label: "Everything", icon: "layers", checked: source === "all", run: () => set("all") },
      { label: "Vault only", icon: "folder", checked: source === "vault", run: () => set("vault") },
      ...libs.map((l) => ({ label: `${l.name}${M.libraries.state(l.path).count != null ? `  (${M.libraries.state(l.path).count})` : ""}`, icon: "hardDrive", checked: source === l.path, run: () => set(l.path) })),
      "sep",
      { label: "Add a folder…", icon: "folderPlus", run: () => addLibrary() },
      { label: "Manage libraries…", icon: "settings", run: () => { showLibs = true; renderList(); } },
    ]);
  }
  /* Rescan: the kept online pictures made small (a few KB each), one after another, with a count and Stop. */
  let shrinking = null;
  function rescanPictures() {
    if (shrinking || !M.online.smallPictures) return;
    shrinking = { stop: false };
    let close = null;
    M.online.smallPictures((n, all) => {
      if (n === 1 || n % 50 === 0 || n === all) { if (close) close(); close = app.toast(`Making the online pictures small · ${n} of ${all}`, { ms: 600000, action: { label: "Stop", run: () => { shrinking.stop = true; } } }); }
    }, () => shrinking.stop).then((n) => { if (close) close(); if (n) app.toast(`${n} picture${n === 1 ? "" : "s"} made small`, { ms: 3000 }); }).finally(() => { shrinking = null; });
  }
  function listMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const arrows = S.playerArrows === "volume" ? "volume" : "track";
    const setArrows = (v) => { app.setSetting("playerArrows", v); paintNow(); };
    app.menu(r.right - 240, r.bottom + 4, [
      { label: "Collapse all albums", icon: "chevron", run: () => foldAll(true) },
      { label: "Expand all albums", icon: "chevronDown", run: () => foldAll(false) },
      "sep",
      { label: "Libraries…", icon: "hardDrive", run: () => { showLibs = true; renderList(); } },
      { label: "Rescan libraries", icon: "rotateRight", title: "Your library folders read again, and the online pictures kept before made small", run: () => { M.libraries.ensure(true); rescanPictures(); } },
      "sep",
      { header: "Online pictures - kept small on this computer" },
      { label: "Fetch these pictures again", icon: "rotateRight", title: "The pictures of what this list shows, fetched again from YouTube", run: () => { const n = M.online.refreshPreviews(visibleKeys()); app.toast(n ? `Fetching ${n} picture${n === 1 ? "" : "s"} again` : "No online videos in this list", { ms: 2600 }); } },
      M.online.previewsDir() ? { label: "Show the pictures folder", icon: "reveal", run: () => app.host.externalReveal(M.online.previewsDir()).catch((e) => app.toast(String(e), { kind: "error" })) } : null,
      "sep",
      { header: "Up/Down arrows" },
      { label: "Previous / next track", checked: arrows === "track", run: () => setArrows("track") },
      { label: "Volume", checked: arrows === "volume", run: () => setArrows("volume") },
    ].filter(Boolean));
  }
  /** Are all the folders on screen closed? (drives the fold-all button) */
  const topDirs = () => folderTree(visibleKeys()).map((n) => n.dir);
  function allFolded() {
    const dirs = topDirs();
    return dirs.length ? dirs.every((d) => isFolded(d)) : false;
  }
  function foldAll(on) {
    if (!on) { setFolded([]); renderList(); return; }
    // the top folders are enough: what is inside them goes with them
    setFolded([...new Set([...folded(), ...topDirs()])]);
    renderList();
  }
  async function addLibrary() {
    let dir = null;
    try {
      dir = await app.host.dialogOpen({ directory: true, multiple: false, title: "Add a media folder" });
    } catch (e) { return app.toast("Could not open the folder picker: " + e, { kind: "error" }); }
    if (!dir) return;
    const path = Array.isArray(dir) ? dir[0] : dir;
    try {
      const r = await M.libraries.add(path);
      app.toast(r.capped ? `Added ${r.name} · first ${r.count} files (the folder is very large)` : `Added ${r.name} · ${r.count} file${r.count === 1 ? "" : "s"}`, { ms: 4000 });
      source = r.path;
      app.setSetting("playerSource", source);
      showLibs = false;
      renderList();
    } catch (e) {
      app.toast("Could not add that folder: " + (e && e.message ? e.message : e), { kind: "error", ms: 6000 });
    }
  }
  function libraryPanel() {
    const libs = M.libraries.list();
    const vaultCount = [...app.vault.files.values()].filter((f) => f.kind === "media" || AUDIO.test(f.path)).length;
    const row = (name, sub, count, acts, cls) => h("div", { class: "pv-libcard" + (cls || "") },
      h("span", { class: "pv-libicon" }, cls === " is-vault" ? icon("folder") : gi("drive")),
      h("div", { class: "pv-libmain" }, h("div", { class: "pv-libname", text: name }), h("div", { class: "pv-libsub", text: sub })),
      h("span", { class: "pv-libcount", text: count }),
      h("div", { class: "pv-libacts" }, acts));
    return h("div", { class: "pv-libs" },
      h("div", { class: "pv-libs-head" },
        h("h2", { class: "pv-libs-title", text: "Libraries" }),
        h("span", { class: "pv-gap" }),
        h("button", { class: "btn btn-primary pv-btn-sm", onclick: () => addLibrary() }, icon("folderPlus"), "Add a folder…"),
        h("button", { class: "icon-btn", title: "Done", onclick: () => { showLibs = false; renderList(); } }, icon("x"))),
      row("Vault", "Media stored with your notes", `${vaultCount}`, [
        h("button", { class: "btn pv-btn-sm", onclick: () => { source = "vault"; app.setSetting("playerSource", source); renderList(); } }, "Show only"),
      ], " is-vault"),
      libs.map((l) => {
        const st = M.libraries.state(l.path);
        const sub = (l.outpost ? "Outpost · " : "") + (st.error ? st.error : st.scanning ? "Scanning…" : l.path);
        return row(l.name, sub, st.error ? "–" : st.scanning ? "…" : `${st.count ?? l.count ?? 0}`, [
          h("button", { class: "btn pv-btn-sm", onclick: () => { source = l.path; app.setSetting("playerSource", source); showLibs = false; renderList(); } }, "Show only"),
          h("button", { class: "icon-btn", title: "Rescan", onclick: () => M.libraries.rescan(l.path) }, icon("rotateRight")),
          st.error ? h("button", { class: "btn pv-btn-sm", title: "The folder moved, or this is another computer: say where it is now. Playlists and the queue follow", onclick: () => app.relocateFolder && app.relocateFolder(l.path) }, "Find it…") : null,
          h("button", { class: "icon-btn", title: l.outpost ? "Stop playing this outpost here (it stays in the sidebar)" : "Remove this library (the files stay where they are)", onclick: async () => {
            if (!(await confirmDialog(l.outpost ? `Leave “${l.name}” out of the Player?` : `Remove “${l.name}”?`, l.outpost ? "The outpost stays in the sidebar. Its right-click menu brings it back here." : "Leonote forgets the folder. Nothing on your disk is touched.", { ok: l.outpost ? "Leave out" : "Remove", danger: false }))) return;
            M.libraries.remove(l.path);
            if (source === l.path) { source = "all"; app.setSetting("playerSource", source); }
            renderList();
          } }, icon("trash")),
        ], st.error ? " is-error" : "");
      }),
      libs.length ? null : h("p", { class: "pv-hint", text: "Add a music or videos folder from anywhere on this computer - a drive, a NAS share, wherever it lives. Leonote only reads it: files are played where they are, and they mix into the queue and playlists with everything else." }));
  }
  function speedMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    void r;
    M.speedPop(anchor, { get: () => M.rate, set: (s) => M.setRate(s) });
  }
  function sleepMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const s = M.sleepInfo();
    app.menu(r.left - 60, r.bottom + 4, [
      { header: "Sleep timer" },
      { label: "Off", checked: !s.at && !s.track, run: () => M.setSleep(0) },
      ...[15, 30, 45, 60, 90].map((m) => ({ label: `${m} minutes`, run: () => M.setSleep(m) })),
      { label: "End of this track", checked: s.track, run: () => M.setSleep("track") },
    ]);
  }
  function queueMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    app.menu(r.right - 220, r.bottom + 4, [
      { label: "Save as playlist", icon: "save", run: () => newPlaylist(M.queue.items) },
      { label: "Show the video tile", icon: "expand", run: () => M.showYtTile() },
      "sep",
      { label: "Clear the queue", icon: "trash", danger: true, run: () => M.clearQueue() },
    ]);
  }

  /* ── sources the user added: a link out, or their own API key ───────── */

  /** The block under the local results: search the sites the user added. */
  /** Results from the user's own YouTube Data API key. */
  async function playHit(it) {
    const key = await M.online.add({ id: it.id, title: it.title });
    M.playAt(M.enqueue([key], { next: true }));
  }
  function hitMenu(it, anchor, e) {
    const [x, y] = at(anchor, e);
    app.menu(x, y, [
      { label: "Play", icon: "play", run: () => playHit(it) },
      { label: "Add to queue", icon: "plus", run: async () => { M.enqueue([await M.online.add({ id: it.id, title: it.title })]); app.toast("Added to the queue", { ms: 1600 }); } },
      { label: "Add to playlist…", icon: "list", run: async () => addToPlaylistMenu([await M.online.add({ id: it.id, title: it.title })], null, { clientX: x, clientY: y }) },
      "sep",
      { label: "Open in the browser here", icon: "globe", run: () => openHere(`https://www.youtube.com/watch?v=${it.id}`) },
      { label: "Open in your browser", icon: "outside", run: () => app.openUrl(`https://www.youtube.com/watch?v=${it.id}`) },
    ]);
  }

  /** Match an imported list again (after new music arrived). */
  function rematch(pl) {
    const was = pl.tracks || [];
    const r = matchTracks(was, M.playlists.candidates());
    // a song found on YouTube stays found, unless it is now in your own music
    const tracks = r.tracks.map((t, i) => (!t.key && was[i] && was[i].yt ? was[i] : t));
    const { matched, total } = r;
    M.playlists.set(pl.id, tracks.filter((t) => t.key).map((t) => t.key), { tracks });
    app.toast(`${matched} of ${total} found in your own music`, { ms: 3500 });
    renderList();
  }

  /** Someone typed a site: it opens in the Player's browser. */
  function siteSuggestion(d) {
    const { host } = d.site;
    return h("div", { class: "pv-suggest is-site" },
      h("span", { class: "pv-sg-thumb", style: { background: colorFor(host) } }, icon("globe")),
      h("div", { class: "pv-sg-main" },
        h("div", { class: "pv-sg-title" }, "Open ", h("b", { text: host }), " in the Player's browser"),
        h("div", { class: "pv-sg-sub", text: "Any video you open there lands in Online media." })),
      h("div", { class: "pv-sg-acts" },
        h("button", { class: "btn btn-primary pv-btn-sm", onclick: () => { app.setSetting("playerBrowser", true); browserGo(`https://${host}`); clearBox(); if (tab !== "youtube") setTab("youtube"); else { renderList(); syncBrowser(); } } }, icon("globe"), "Open it here"),
        h("button", { class: "btn pv-btn-sm", onclick: () => app.openUrl(`https://${host}`) }, "In my browser")));
  }

  /* ── the browser in the Online tab ───────────────────────────────────────
     The same browser as a web tab, inside the Player: any site you like -
     Leonote names none. A video page you open there is added to Online
     media, so what you find is what you keep. ── */
  let wt = null;
  let browserEl = null;
  let dragKey = null; // the tile being dragged, for the make-a-playlist hover
  /** Whether a playlist sits among the Online tiles: only when put there (the ones made in the Online tab start there). */
  const onlineShown = (p) => (p.showOnline !== undefined ? !!p.showOnline : p.hideOnline !== undefined ? !p.hideOnline : false);
  function setOnlineShown(p, on) {
    const was = onlineShown(p);
    M.playlists.set(p.id, p.items, { showOnline: !!on, hideOnline: undefined });
    if (was && !on) {
      // its songs leave the queue too, save the one playing
      const items = new Set(p.items);
      for (let i = M.queue.items.length - 1; i >= 0; i--) if (items.has(M.queue.items[i]) && i !== M.queue.index) M.removeAt(i);
      undos.push(() => setOnlineShown(p, true));
      app.toast(`${p.name} hidden from Online - Ctrl+Z brings it back`, { ms: 3000 });
    }
  }
  let bTabs = []; // { wid, path, title } - the browser's own tabs
  let bCur = 0;
  let bSeq = 0;
  const bTab = () => bTabs[bCur] || null;
  const browserOn = () => S.playerBrowser !== false;
  const autoAdded = new Set();
  const lastSeen = new Map(); // wid -> the address last looked at
  const muted = new Set(); // wids whose page has been silenced
  const hostOfUrl = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const bLabel = (t) => (!t.path ? "New tab" : (t.title && t.title !== t.path ? t.title : hostOfUrl(t.path)) || t.path).slice(0, 40);
  /** A page sounds or not as the sound setting says. */
  // the page may not exist yet when its tab is shown: the mute is asked again a few times until it takes
  const silence = (t, tries = 0) => {
    if (!t) return;
    const on = !wantSound();
    if (muted.has(t.wid) === on && tries === 0) return;
    app.host.tabWebMute(t.wid, on).then(() => { on ? muted.add(t.wid) : muted.delete(t.wid); }).catch(() => { if (tries < 5) setTimeout(() => silence(t, tries + 1), 400 * (tries + 1)); });
  };
  function applySound() { for (const t of bTabs) silence(t, 1); paintSoundBtn(); }
  function ensureBrowser() {
    if (wt) return;
    browserEl = h("div", { class: "pv-browser", style: { height: Math.max(90, Number(S.playerBrowserH) || 520) + "px" } });
    wt = mountWebTab(app, browserEl, {
      findTab: (wid) => bTabs.find((t) => t.wid === wid) || null,
      changed: () => onBrowserChanged(),
      newTab: (url) => openBTab(url),
      replaceTab: (target) => { if (target.kind === "note") app.openNote(target.path, { newTab: true }); else if (target.kind === "file") app.openFile(target.path, { newTab: true }); else if (target.kind === "web") browserGo(target.path); },
      closeSelf: () => closeBTab(bTab()),
      linkInto: async (p, text) => { try { const n = app.vault.get(p); await app.vault.write(p, (n.content.replace(/\n*$/, "") + "\n\n" + text + "\n")); app.toast(`Linked in ${p}`, { ms: 2400 }); } catch (e) { app.toast(String(e), { kind: "error" }); } },
    });
    if (!bTabs.length) {
      // last time's tabs: all of them when asked, the pinned ones always
      const kept = Array.isArray(S.playerBTabs) ? S.playerBTabs.filter((t) => t && (t.pinned || S.playerBrowserRestore !== false)) : [];
      for (const t of kept) bTabs.push({ wid: "player-" + (++bSeq), path: t.path || "", title: t.title || "", pinned: !!t.pinned });
      bCur = Math.max(0, Math.min(bTabs.length - 1, Number(S.playerBTabCur) || 0));
    }
    if (!bTabs.length) bTabs.push({ wid: "player-" + (++bSeq), path: "", title: "" });
  }
  const rememberBTabs = debounce(() => { app.setSetting("playerBTabs", bTabs.map((t) => ({ path: t.path, title: t.title, pinned: !!t.pinned }))); app.setSetting("playerBTabCur", bCur); }, 400);
  function pinBTab(t, on) {
    t.pinned = on;
    // pinned tabs sit first, in their order
    const cur = bTab();
    bTabs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    bCur = Math.max(0, bTabs.indexOf(cur));
    paintBStrip(); rememberBTabs();
  }
  /** A page in the Player's browser, from anywhere in the Player: the tab shows, the browser opens, the page loads. A known video is not played again. */
  app.playerOpenHere = (url) => openHere(url);
  function openHere(url, key) {
    if (key) autoAdded.add(key);
    else { const d = readLink(url); if (d && d.key) autoAdded.add(d.key); }
    app.setSetting("playerBrowser", true);
    browserGo(url);
    if (tab !== "youtube") setTab("youtube"); else { renderList(); syncBrowser(); }
  }
  /** The current browser tab goes to `url` ("" is the start page). */
  function browserGo(url) {
    ensureBrowser();
    bTab().path = url || "";
    paintBStrip();
    rememberBTabs();
    if (visible && tab === "youtube" && browserOn()) syncBrowser();
  }
  function openBTab(url = "") {
    ensureBrowser();
    bTabs.push({ wid: "player-" + (++bSeq), path: url || "", title: "" });
    bCur = bTabs.length - 1;
    paintBStrip();
    syncBrowser();
    rememberBTabs();
  }
  function closeBTab(t) {
    const i = bTabs.indexOf(t);
    if (i < 0) return;
    if (t.pinned) { app.toast("A pinned tab stays - unpin it first", { ms: 2200 }); return; }
    bTabs.splice(i, 1);
    rememberBTabs();
    if (t.path) { bClosed.push({ path: t.path, title: t.title }); if (bClosed.length > 20) bClosed.shift(); }
    muted.delete(t.wid);
    app.host.tabWebClose([t.wid]).catch(() => {});
    if (!bTabs.length) bTabs.push({ wid: "player-" + (++bSeq), path: "", title: "" });
    bCur = Math.min(bCur, bTabs.length - 1);
    paintBStrip();
    syncBrowser();
  }
  /** The native page shows only while the Online tab is up with the browser open and the picture is not filling the view. */
  function syncBrowser() {
    if (!wt) return;
    const t = bTab();
    if (t && visible && tab === "youtube" && browserOn() && !theater && !fullscreen && browserEl.isConnected) { wt.show(t); silence(t); setTimeout(() => applyZoom(t), 60); }
    else wt.leave();
  }
  /** The bar's tab strip: one chip per browser tab, a cross to close, a plus for another. */
  function paintBStrip() {
    bStripEl.replaceChildren(
      ...bTabs.map((t, i) => { const el = h("span", { class: "pv-btab" + (i === bCur ? " is-on" : "") + (t.pinned ? " is-pinned" : ""), title: (t.pinned ? "Pinned · " : "") + (t.path || "New tab") + " · right-click for more" },
        h("button", { class: "pv-btab-main", onclick: () => { bCur = i; paintToolsMode(); syncBrowser(); rememberBTabs(); } }, icon(t.pinned ? "pin" : t.path ? "globe" : "home"), t.pinned ? null : h("span", { text: bLabel(t) })),
        t.pinned ? null : h("button", { class: "pv-btab-x", title: "Close this tab", onclick: (e) => { e.stopPropagation(); closeBTab(t); } }, icon("x")));
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY, [
          { label: t.pinned ? "Unpin" : "Pin this tab", icon: "pin", run: () => pinBTab(t, !t.pinned) },
          { label: "Duplicate", icon: "layers", run: () => openBTab(t.path) },
          "sep",
          { label: "Close", icon: "x", run: () => closeBTab(t) },
          { label: "Close the others", icon: "x", run: () => { for (const x of bTabs.slice()) if (x !== t && !x.pinned) closeBTab(x); bCur = bTabs.indexOf(t); paintBStrip(); syncBrowser(); } },
        ]); });
        return el; }),
      h("button", { class: "icon-btn pv-btab-add", title: "Another tab · right-click for closed ones", onclick: () => openBTab(""), oncontextmenu: (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [{ header: bClosed.length ? "Closed tabs" : "No closed tabs yet" }, ...[...bClosed].reverse().map((c) => ({ label: bLabel(c), icon: "globe", run: () => reopenBTab(c) }))]);
      } }, icon("plus")));
  }
  function browserPanel() {
    ensureBrowser();
    const grip = h("div", { class: "pv-browser-grip", title: "Drag up or down to change the browser's height" }, h("span", { class: "pv-browser-grip-bar" }));
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const y0 = e.clientY; const h0 = browserEl.getBoundingClientRect().height;
      let last = h0;
      const move = (ev) => { last = Math.max(90, Math.min(browserCap(), h0 + (ev.clientY - y0))); browserEl.style.height = last + "px"; };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); app.setSetting("playerBrowserH", Math.round(last)); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    requestAnimationFrame(() => { capBrowser(); syncBrowser(); });
    return h("div", { class: "pv-browser-wrap" }, browserEl, grip);
  }
  // the browser never grows past the list's own height: its grip stays in reach without scrolling
  const browserCap = () => Math.max(90, (listEl.clientHeight || innerHeight) - 48);
  const capBrowser = () => { if (!browserEl || !browserEl.isConnected) return; const hh = browserEl.getBoundingClientRect().height; const cap = browserCap(); if (hh > cap) browserEl.style.height = cap + "px"; };
  window.addEventListener("resize", () => requestAnimationFrame(capBrowser));
  /** A browser tab moved on: a video page goes where the "A video opened in the browser" choice says. */
  function onBrowserChanged() {
    paintBStrip();
    rememberBTabs();
    if (browserMode() && document.activeElement !== search) paintAddress();
    const cur = bTab(); if (cur) silence(cur);
    for (const t of bTabs) {
      const url = t.path;
      if (!url || lastSeen.get(t.wid) === url) continue;
      if (zoomHost(url) !== zoomHost(lastSeen.get(t.wid) || "")) applyZoom(t); // a new site: its own zoom
      lastSeen.set(t.wid, url);
      takeVideo(t, url, true);
    }
  }
  /** A video the browser reached - by its address, or by starting to play in a miniplayer - goes where that choice says. */
  function takeVideo(t, url, fromAddress) {
    const take = S.playerBrowserTake === "play" ? "add" : S.playerBrowserTake;
    if (take === "none") return;
    const d = readLink(url);
    if (!d || d.bad || d.site || !d.key) return;
    if (autoAdded.has(d.key)) return;
    autoAdded.add(d.key);
    // the page's title names the video when it is the video's own page; a miniplayer keeps the home page's, so the title is fetched instead
    // (never the page's title - the name comes from YouTube's own answer, fillTitles)
    const pageTitle = "";
    M.online.add(d.yt ? { ...d.yt, title: pageTitle || undefined } : d.direct).then((key) => {
      if (!key) return;
      if (take === "play") { M.playAt(M.enqueue([key], { next: true })); app.toast("Playing in the Player · kept in Online media", { ms: 2600 }); }
      else app.toast("Added to Online media", { ms: 2400, action: { label: "Play", run: () => M.playAt(M.enqueue([key], { next: true })) } });
      if (M.youtube && M.youtube.fillTitles) M.youtube.fillTitles();
    }).catch(() => {});
  }
  // a video started in one of the browser's pages (a miniplayer changes no address): the same thing happens
  app.bus.on("tabweb:video", (p) => {
    const t = p && bTabs.find((x) => x.wid === p.id);
    if (!t) return;
    const url = p.video ? `https://www.youtube.com/watch?v=${p.video}` : p.url;
    if (url) takeVideo(t, url, false);
  });
  // closed tabs come back: right-click the + (or Ctrl+Shift+T with the strip in view)
  const bClosed = [];
  function reopenBTab(entry) {
    const c = entry || bClosed.pop();
    if (!c) return;
    const i = bClosed.indexOf(c); if (i >= 0) bClosed.splice(i, 1);
    openBTab(c.path);
  }

  /* ── links: the smart box, paste and drop ────────────────────────────── */
  function readLink(text) {
    const t = String(text || "").trim();
    const site = bareDomain(t);
    if (site) return { text: t, site };
    if (!looksLikeUrl(t)) return null;
    const y = parseYouTube(t);
    // a video inside a playlist (watch?v=…&list=…): the playlist is what was meant - not for
    // YouTube's own mixes (RD…) or private lists (liked, watch later), which cannot be read
    if (y && y.id && y.list && !/^(RD|LL|WL|UL)/.test(y.list)) return { text: t, list: y.list, yt: y, key: ytKey(y.id) };
    if (y && y.id) return { text: t, yt: y, key: ytKey(y.id) };
    if (y && y.list) return { text: t, list: y.list };
    const d = parseDirect(/^www\./i.test(t) ? "https://" + t : t);
    if (d) return { text: t, direct: d, key: urlKey(d.url) };
    return { text: t, bad: "Leonote plays video links and links straight to audio or video files (.mp3, .mp4, .webm…). This link is neither." };
  }
  /** A whole YouTube playlist brought in: its videos join Online media and a playlist of them is made (or refreshed). */
  async function importYtList(link) {
    app.toast("Reading the playlist…", { ms: 2500 });
    let r;
    try { r = await readYtList(app, link); } catch (e) { app.toast(String(e.message || e), { kind: "error", ms: 9000 }); return false; }
    const items = (r.items || []).filter((x) => x && x.id);
    if (!items.length) { app.toast("No videos in that playlist", { kind: "error" }); return false; }
    const nameless = (x) => !x.title || /^\[(private|deleted) video\]$/i.test(x.title);
    M.online.addMany(items.map((x) => ({ id: x.id, title: nameless(x) ? "" : x.title, secs: x.secs })));
    const keys = items.map((x) => ytKey(x.id));
    // read through the YouTube sign-in: offered for removal when signing out (ytpush.js)
    const ytSignedIn = !!(app.ytPush && app.ytPush.connected());
    const pl = M.playlists.create(r.name || "Imported playlist", keys, { ytList: link, ytFetched: Date.now(), showOnline: true, ...(ytSignedIn ? { ytSignedIn } : {}) });
    // it arrives folded: one tile, its videos inside it
    app.setSetting("playerPlOpen", (S.playerPlOpen || []).filter((x) => x !== pl.id));
    if (tab !== "youtube") setTab("youtube");
    renderList();
    app.toast(`Imported “${pl.name}”: ${keys.length} videos${r.truncated ? " (as many as the site would list)" : ""} - its menu can keep it up with the original`, { ms: 5000 });
    return pl;
  }
  /** how: "auto" (play if idle, else next) | "play" | "queue" | "playlist" */
  async function addLink(text, how = "auto", anchor = null) {
    const d = typeof text === "string" ? readLink(text) : text;
    if (!d) return false;
    if (d.bad) { app.toast(d.bad, { ms: 5000, action: /^https?:/i.test(d.text) ? { label: "Open in the browser here", run: () => openHere(d.text) } : null }); return false; }
    if (d.list) return importYtList(d.text);
    const key = await M.online.add(d.yt || d.direct);
    if (!key) return false;
    // added on its own: a tile of its own, even when a playlist also has it
    if (M.online.mark && !(M.online.entry(key) || {}).loose) M.online.mark(key, { loose: true });
    if (how === "playlist") { addToPlaylistMenu([key], anchor); return true; }
    // only added: kept in Online media, nothing starts
    if (how === "add") { app.toast("Added to the Player's Online media", { ms: 2600, action: { label: "Play", run: () => M.playAt(M.enqueue([key], { next: true })) } }); renderList(); return true; }
    if (how === "queue") { M.enqueue([key]); app.toast("Added to the queue", { ms: 1800 }); }
    else if (how === "play" || !M.playing()) M.playAt(M.enqueue([key], { next: true }));
    else { M.enqueue([key], { next: true }); app.toast("Added to Online media - it plays next", { ms: 2600, action: { label: "Play now", run: () => M.playAt(M.queue.items.indexOf(key)) } }); }
    return true;
  }
  function clearBox() {
    search.value = "";
    query = "";
    draft = null;
    renderList();
  }
  function setDraft(text) {
    draft = readLink(text);
    if (draft && draft.yt && !M.online.entry(draft.key)) {
      const d = draft;
      ytTitle(d.yt.id).then((r) => { if (r && draft === d) { d.title = r.title; renderList(); } });
    }
  }
  // the row above the list while the box holds a link
  function suggestion(d) {
    if (d.site) return siteSuggestion(d);
    // a playlist link: Enter (or the paste itself) imports it; the video alone is one click away
    if (d.list) return h("div", { class: "pv-suggest" },
      h("span", { class: "pv-sg-thumb", style: d.yt ? { backgroundImage: `url("${M.online.thumb(d.yt.id)}")` } : { backgroundImage: gradientFor(d.list) } }, icon("list")),
      h("div", { class: "pv-sg-main" },
        h("div", { class: "pv-sg-title" }, "Import the playlist"),
        h("div", { class: "pv-sg-sub", text: "Its videos join Online media as one playlist tile · Enter imports it" })),
      h("div", { class: "pv-sg-acts" },
        h("button", { class: "btn btn-primary pv-btn-sm", onclick: () => addLink(d, "auto").then((ok) => ok && clearBox()) }, "Import playlist"),
        d.yt ? h("button", { class: "btn pv-btn-sm", onclick: () => addLink({ ...d, list: null }, "play").then((ok) => ok && clearBox()) }, gi("play"), "Just this video") : null));
    if (d.bad) return h("div", { class: "pv-suggest is-bad" }, h("span", { class: "pv-sg-thumb" }, icon("link")), h("div", { class: "pv-sg-main" }, h("div", { class: "pv-sg-title", text: d.bad })),
      /^https?:/i.test(d.text) ? h("button", { class: "btn pv-btn-sm", onclick: () => openHere(d.text) }, "Open in the browser here") : null,
      /^https?:/i.test(d.text) ? h("button", { class: "btn pv-btn-sm", onclick: () => app.openUrl(d.text) }, "In your browser") : null);
    const known = M.online.entry(d.key);
    const name = (known && known.title) || d.title || (d.direct ? d.direct.name : "video " + d.yt.id);
    const thumb = d.yt ? { backgroundImage: `url("${M.online.thumb(d.yt.id)}")` } : { backgroundImage: gradientFor(name) };
    const go = (how) => (e) => addLink(d, how, e.currentTarget).then((ok) => { if (ok && how !== "playlist") clearBox(); });
    return h("div", { class: "pv-suggest" },
      h("span", { class: "pv-sg-thumb", style: thumb }, d.direct ? icon(d.direct.audio ? "music" : "film") : null),
      h("div", { class: "pv-sg-main" },
        h("div", { class: "pv-sg-title" }, known ? "In Online media: " : "Add ", h("b", { text: `‘${name}’` }), known ? "" : " to Online media"),
        h("div", { class: "pv-sg-sub", text: d.direct ? `${d.direct.audio ? "Audio" : "Video"} file · ${hostOf(d.direct.url)} · Enter plays it` : "Online video · Enter plays it" })),
      h("div", { class: "pv-sg-acts" },
        h("button", { class: "btn btn-primary pv-btn-sm", onclick: go("play") }, gi("play"), "Play now"),
        h("button", { class: "btn pv-btn-sm", onclick: go("queue") }, "Add to queue"),
        h("button", { class: "btn pv-btn-sm", onclick: go("playlist") }, "Add to playlist…")));
  }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

  /** Someone typed a site: offer to make it a source (or set up YouTube). */
  function colorFor(host) {
    let hsh = 0;
    for (let i = 0; i < host.length; i++) hsh = Math.imul(hsh ^ host.charCodeAt(i), 2654435761);
    return `hsl(${(hsh >>> 0) % 360} 55% 55%)`;
  }

  /** Two lines, a link to the key page and a paste field. */
  function removeOnline(keys) {
    const before = M.online.list();
    const drop = new Set(keys);
    const held = M.playlists.all().filter((p) => p.items.some((k) => drop.has(k)));
    // out of every playlist too: a YouTube playlist's daily read then leaves it out (and lists it to restore)
    for (const p of held) M.playlists.set(p.id, p.items.filter((k) => !drop.has(k)));
    const gone = before.filter((x) => drop.has(M.online.keyOf(x))).map((x) => ({ ...x, removedAt: Date.now() }));
    const removedBefore = removedList();
    app.setSetting("onlineRemoved", [...gone, ...removedBefore].slice(0, 300));
    M.online.remove(keys);
    sel.clear();
    const undo = () => { M.online.restore(before); app.setSetting("onlineRemoved", removedBefore); for (const p of held) M.playlists.set(p.id, p.items, { ytSkip: p.ytSkip || [], ytMine: p.ytMine || [], ytSkipNames: p.ytSkipNames || {} }, true); };
    undos.push(undo);
    const from = held.length ? ` and ${held.length === 1 ? `“${held[0].name}”` : `${held.length} playlists`}` : "";
    app.toast(keys.length > 1 ? `Removed ${keys.length} from Online media${from}` : `Removed from Online media${from} - Ctrl+Z brings it back`, { ms: 6000, action: { label: "Undo", run: undo } });
  }

  // a copy of a direct media link in the vault: the original, or a smaller video
  async function saveToVault(key, anchor, ev) {
    const url = urlOf(key);
    const d = parseDirect(url);
    if (!d) return;
    let vp = null;
    if (!d.audio) { try { const mod = await import("./videopack.js"); if (mod.canPackVideo()) vp = mod; } catch {} }
    const r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : { left: innerWidth / 2, bottom: 120 };
    const choice = await new Promise((resolve) => app.menu(ev ? ev.clientX : r.left, ev ? ev.clientY : r.bottom + 4, [
      { header: "Save a copy in the vault" },
      { label: "Original file", icon: "save", run: () => resolve("original") },
      ...(vp ? Object.entries(vp.VIDEO_PRESETS).map(([k, p]) => ({ label: `Smaller · ${p.label}`, icon: "shrink", run: () => resolve(k) })) : []),
      d.audio ? { header: "Audio is saved as it is", plain: true } : vp ? { header: "A smaller copy takes about as long as the video plays", plain: true } : null,
    ]));
    const dir = await pickFolder(app, anchor && anchor.isConnected ? anchor : null, { title: "Save in", extra: [[d.audio ? "Music" : "Videos", d.audio ? "music" : "videos"]] });
    if (dir == null) return;
    const m = metaFor(key);
    const name = d.name;
    app.toast(`Downloading ${name}…`, { ms: 2500 });
    let bytes;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      app.toast("This site doesn't let Leonote download the file (or it's offline). You can save it from the original page.", { kind: "error", ms: 9000, action: { label: "Open in the browser here", run: () => openHere(url) } });
      return;
    }
    let ext = (/\.[a-z0-9]+$/i.exec(name) || [".bin"])[0].toLowerCase();
    if (choice !== "original" && vp) {
      const src = URL.createObjectURL(new Blob([bytes]));
      try {
        app.toast(`Making a smaller copy of ${name}…`, { ms: 3000 });
        const out = await vp.packVideo(src, { preset: choice });
        if (out.size < bytes.length) { bytes = new Uint8Array(await out.arrayBuffer()); ext = ".webm"; }
      } catch (e) {
        app.toast("Could not make a smaller copy - saving the original: " + (e.message || e), { kind: "error", ms: 5000 });
      } finally { URL.revokeObjectURL(src); }
    }
    try {
      const base = safeName(m.title || name.replace(/\.[^.]+$/, ""));
      const path = await app.host.importFile((dir ? dir + "/" : "") + base + ext, bytes);
      app.toast(`Saved ${path.slice(path.lastIndexOf("/") + 1)}`, { ms: 12000, action: { label: "Use it instead of the link", run: () => { M.online.replaceKey(key, path); app.toast("The queue and playlists now play the saved file", { ms: 2400 }); } } });
      return path;
    } catch (e) {
      app.toast("Could not save: " + e, { kind: "error" });
    }
  }

  function dropKeys(e) {
    const raw = e.dataTransfer.getData("application/x-leonote-play");
    if (raw) try { return JSON.parse(raw); } catch {}
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    const d = readLink((text || "").split(/\r?\n/).find((l) => l && !l.startsWith("#")));
    if (!d || d.bad) return null;
    M.online.add(d.yt || d.direct);
    return [d.key];
  }

  sortable(listEl, { item: ".pv-ytcard, .pv-pltile", axis: "x", onMove: (a, b, elm) => {
    if (words.length) return; // a filtered view has no order to give
    const inside = elm.classList.contains("pv-pltile") ? null : elm.closest("[data-pl]");
    if (inside) {
      const pl = M.playlists.all().find((p) => p.id === inside.dataset.pl);
      if (!pl) return;
      const shown = [...inside.querySelectorAll(".pv-ytcard")].map((c) => c.dataset.key);
      const [k] = shown.splice(a, 1); shown.splice(b, 0, k);
      M.playlists.set(pl.id, [...shown, ...pl.items.filter((x) => !shown.includes(x))]);
      return;
    }
    const pl = tab === "playlists" && openList ? M.playlists.all().find((p) => p.id === openList) : null;
    if (pl) {
      const shown = [...listEl.querySelectorAll(".pv-ytcard")].map((c) => c.dataset.key);
      const [k] = shown.splice(a, 1); shown.splice(b, 0, k);
      M.playlists.set(pl.id, [...shown, ...pl.items.filter((x) => !shown.includes(x))]);
      return;
    }
    if (tab !== "youtube") return;
    const top = [...elm.parentElement.children].filter((c) => c.matches(".pv-ytcard, .pv-pltile")).map((c) => c.dataset.key || "pl:" + c.dataset.pl);
    const [k] = top.splice(a, 1); top.splice(b, 0, k);
    saveOnlineOrder(top);
  } });
  // Online as a list: the same order as the tiles, by dragging rows - and a playlist's videos inside it
  sortable(listEl, { item: ".pv-ytlist > .pv-row, .pv-ytlist > .pv-plline-wrap", onMove: (a, b, elm) => {
    if (words.length || tab !== "youtube") return;
    const top = [...elm.parentElement.children].filter((c) => c.matches(".pv-row, .pv-plline-wrap")).map((c) => c.dataset.key || "pl:" + c.dataset.pl);
    const [k] = top.splice(a, 1); top.splice(b, 0, k);
    saveOnlineOrder(top);
  } });
  sortable(listEl, { item: ".pv-plline-body > .pv-row", onMove: (a, b, elm) => {
    const pl = M.playlists.all().find((p) => p.id === (elm.closest("[data-pl]") || {}).dataset?.pl);
    if (!pl || words.length) return;
    const shown = [...elm.parentElement.querySelectorAll(":scope > .pv-row")].map((c) => c.dataset.key);
    const [k] = shown.splice(a, 1); shown.splice(b, 0, k);
    M.playlists.set(pl.id, [...shown, ...pl.items.filter((x) => !shown.includes(x))]);
  } });
  /** Online's own order (tiles and list alike): kept, and Online sorted by it from now on. */
  function saveOnlineOrder(top) {
    app.setSetting("playerGridOrder", top);
    const rank = new Map(top.filter((x) => !x.startsWith("pl:")).map((x, i) => [x, i]));
    const list = M.online.list().slice().sort((x, y) => (rank.has(M.online.keyOf(x)) ? rank.get(M.online.keyOf(x)) : 1e9) - (rank.has(M.online.keyOf(y)) ? rank.get(M.online.keyOf(y)) : 1e9));
    if (onlineSort !== "custom") { onlineSort = "custom"; app.setSetting("playerSortOnline", "custom"); paintTabs(); }
    M.online.restore(list);
  }
  sortable(listEl, { item: ".pv-plrow", onMove: (a, b) => {
    const pl = M.playlists.all().find((p) => p.id === openList);
    if (!pl) return;
    const items = pl.items.slice();
    const [k] = items.splice(a, 1);
    items.splice(b, 0, k);
    M.playlists.set(pl.id, items);
  } });

  /* ── managing files and online items ─────────────────────────────────── */
  // vault files can be renamed, moved and trashed from here; library files
  // live outside the vault and are only ever read
  const vaultKeys = (keys) => keys.filter((k) => !isOnline(k) && !isLib(k));
  function fileItems(key, keys, many) {
    const out = [];
    const lib = isLib(key);
    const abs = lib ? (M.libraries.entry(key) || {}).abs || libPath(key) : key;
    if (!many && !isOnline(key)) out.push(
      lib ? null : { label: "Open file", icon: "file", run: () => app.openFile(key, { newTab: true }) },
      { label: "Open in default app", icon: "reveal", run: () => (lib ? app.host.externalOpenInApp(abs) : app.host.openPath(key)).catch((e) => app.toast(String(e), { kind: "error" })) },
      { label: "Show in Explorer", icon: "folder", run: () => (lib ? app.host.externalReveal(abs).catch((e) => app.toast(String(e), { kind: "error" })) : app.reveal(key)) },
      { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(abs); app.toast("Path copied", { ms: 1400 }); } });
    const mine = vaultKeys(keys);
    if (!many && !lib) out.push({ label: "Rename", icon: "edit", keys: "F2", run: () => renameItem(key) });
    if (mine.length && mine.length === keys.length) out.push(
      { label: many ? `Move ${keys.length} files to…` : "Move to folder…", icon: "folderPlus", run: () => moveItems(mine) },
      { label: many ? `Delete ${keys.length} files…` : "Delete file…", icon: "trash", danger: true, keys: "Del", run: () => trashItems(mine) });
    if (out.filter(Boolean).length) out.push("sep");
    return out.filter(Boolean);
  }
  function renameItem(key) {
    const r = rows.get(key);
    const t = r && r.querySelector(".pv-r-title, .pv-yttitle");
    if (!t) return;
    if (isOnline(key)) {
      inlineEdit(t, metaFor(key).title || "", { className: "pv-rename", onCommit: (v) => M.online.rename(key, v.trim()), onCancel: () => root.focus({ preventScroll: true }) });
      return;
    }
    if (isLib(key)) return app.toast("Files in a library folder are only read here - rename them in Explorer", { ms: 4000 });
    // the file's name (the tags stay as they are); the extension is kept
    const name = leaf(key);
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    inlineEdit(t, base, { className: "pv-rename", onCommit: (v) => app.renameFile(key, v.trim().replace(/\.[a-z0-9]{2,4}$/i, (m) => (m.toLowerCase() === ext.toLowerCase() ? "" : m)) + ext), onCancel: () => root.focus({ preventScroll: true }) });
  }
  async function moveItems(keys) {
    const dir = await pickFolder(app, null, { title: keys.length > 1 ? `Move ${keys.length} files to` : "Move to" });
    if (dir == null) return;
    for (const k of keys) if (folderOf(k) !== dir) await app.moveFile(k, dir);
  }
  function trashItems(keys) {
    const mine = vaultKeys(keys);
    if (!mine.length) return app.toast("Files in a library folder are only read here - delete them in Explorer", { ms: 4000 });
    if (app.askTrash) app.askTrash(mine.map((k) => [k, "file"]));
  }
  // F2 / Delete act on the selection (or the playing row)
  function selected() {
    const all = visibleKeys();
    const keys = all.filter((k) => sel.has(k));
    return keys.length ? keys : M.current() && all.includes(M.current()) ? [M.current()] : [];
  }
  function deleteSelected() {
    const keys = selected();
    if (!keys.length) return;
    const pl = tab === "playlists" && openList ? M.playlists.all().find((p) => p.id === openList) : null;
    if (pl) {
      M.playlists.set(pl.id, pl.items.filter((k) => !keys.includes(k)));
      undos.push(() => M.playlists.set(pl.id, pl.items));
      app.toast(keys.length > 1 ? `Removed ${keys.length} from ${pl.name}` : `Removed from ${pl.name} - Ctrl+Z brings it back`, { ms: 5000, action: { label: "Undo", run: () => M.playlists.set(pl.id, pl.items) } });
    } else if (keys.every(isOnline)) removeOnline(keys);
    else trashItems(keys);
  }

  /* ── how big the picture is ──────────────────────────────────────────
     A video used to take half the window whether you wanted it to or not,
     pushing the library out of reach. Four sizes now: a small picture that
     leaves the list where it is, a large one, a little window you can drag
     anywhere while you browse, and theatre for watching properly. The
     choice is remembered.                                              */
  const SIZES = [
    ["small", "Docked player", "In the corner, the library keeps the page"],
    ["large", "Theater", "The video leads, the list follows below"],
    ["float", "Popup player", "A small player you can drag anywhere"],
  ];
  const SIZE_ICON = { small: "picSmall", large: "film", float: "layers" };
  const vsize = () => (SIZES.some(([id]) => id === S.playerVideoSize) ? S.playerVideoSize : "small");
  function setVideoSize(id) {
    app.setSetting("playerVideoSize", id);
    if (id === "large" && browserOn()) { app.setSetting("playerBrowser", false); paintToolsMode(); const w = listEl.querySelector(".pv-browser-wrap"); if (w) w.remove(); syncBrowser(); }
    if (id === "float") placeFloat();
    paintNow();
    requestAnimationFrame(() => { const y = M.yt(); if (y) y.place(); });
  }
  // the little window: dragged by any empty part of it, kept on screen
  const floatGrip = h("div", { class: "pv-float-grip", title: "Drag to resize" });
  // and a way out of it: in a narrow window it covers everything else
  const floatClose = h("button", { class: "pv-float-close", title: "Close the popup player (Esc) - the picture goes back to the docked player", onclick: () => pickSize("float") }, icon("x"));
  now.append(floatGrip);
  exitBtn.after(floatClose);
  function floatPos() {
    const p = S.playerFloatPos && typeof S.playerFloatPos === "object" ? S.playerFloatPos : {};
    return { x: Number(p.x), y: Number(p.y), w: Number(p.w) || 360 };
  }
  function placeFloat() {
    const p = floatPos();
    const w = Math.max(240, Math.min(p.w, Math.min(900, innerWidth - 24)));
    const hgt = now.offsetHeight || 260;
    const x = Number.isFinite(p.x) ? p.x : innerWidth - w - 24;
    const y = Number.isFinite(p.y) ? p.y : innerHeight - hgt - 84;
    now.style.setProperty("--pvf-w", w + "px");
    now.style.setProperty("--pvf-x", Math.max(8, Math.min(x, innerWidth - w - 8)) + "px");
    now.style.setProperty("--pvf-y", Math.max(46, Math.min(y, innerHeight - 90)) + "px");
  }
  now.addEventListener("pointerdown", (e) => {
    if (vsize() !== "float" || theater || e.button !== 0) return;
    const onGrip = e.target === floatGrip;
    if (!onGrip && e.target.closest("button, input, .pv-seek, .pv-q-row, video, .pv-yt-anchor, .pv-eq")) return;
    e.preventDefault();
    const box = now.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const p = floatPos();
    now.classList.add("is-moving");
    // the online video is an iframe riding on the window: a pointer that
    // slips over it would be lost to us, and the drag would never end
    document.body.classList.add("is-pv-moving");
    try { now.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      if (onGrip) {
        const w = Math.max(240, Math.min(box.width + (ev.clientX - sx), Math.min(900, innerWidth - box.left - 12)));
        now.style.setProperty("--pvf-w", w + "px");
        p.w = w;
      } else {
        p.x = box.left + (ev.clientX - sx);
        p.y = box.top + (ev.clientY - sy);
        now.style.setProperty("--pvf-x", Math.max(8, Math.min(p.x, innerWidth - box.width - 8)) + "px");
        now.style.setProperty("--pvf-y", Math.max(46, Math.min(p.y, innerHeight - 90)) + "px");
      }
      // the online video is a layer of its own over the stage: it moves with us
      const y = M.yt();
      if (y) y.place();
    };
    const up = () => {
      now.classList.remove("is-moving");
      document.body.classList.remove("is-pv-moving");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      app.setSetting("playerFloatPos", { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w) });
      placeFloat();
      const y = M.yt();
      if (y) y.place();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  window.addEventListener("resize", () => { if (vsize() === "float" && hasVideo()) placeFloat(); });

  /* ── watching: theater and full screen ───────────────────────────────── */
  let theater = false;
  let fullscreen = false;
  let zenByUs = false;
  let idleTimer = 0;
  const hasVideo = () => !!M.videoEl() || (M.isYouTube() && !S.playerYtAudio);
  // `theater` is only the LAYOUT of full screen now (the picture fills the
  // view, the controls fade): it is entered and left by setFullscreen alone.
  function setTheater(on) {
    if (on && !hasVideo()) on = false;
    theater = on;
    root.classList.toggle("is-theater", on);
    if (on && browserOn()) { app.setSetting("playerBrowser", false); paintToolsMode(); const w = listEl.querySelector(".pv-browser-wrap"); if (w) w.remove(); }
    syncBrowser();
    requestAnimationFrame(() => { const y = M.yt(); if (y) y.place(); });
    wake();
    paintNow();
    requestAnimationFrame(() => { const y = M.yt(); if (y) y.place(); });
    if (on) root.focus({ preventScroll: true });
  }
  // Full screen as a video's own tab does it: the window goes truly full in one
  // step (host.videoFullscreen also cures a maximized window's leftover strip),
  // the title bar goes, Esc or F comes back to exactly the player that was there.
  let fsWasMax = false;
  async function setFullscreen(on) {
    on = !!on && hasVideo();
    if (on === fullscreen) return;
    fullscreen = on;
    setTheater(on);
    const appEl = document.getElementById("app");
    if (appEl) { appEl.classList.toggle("is-playerfull", on); if (on && !appEl.classList.contains("is-zen")) { appEl.classList.add("is-zen"); zenByUs = true; } else if (!on && zenByUs) { appEl.classList.remove("is-zen"); zenByUs = false; } }
    root.classList.toggle("is-full", on);
    if (on) document.body.append(wakeStrip); else wakeStrip.remove();
    clearInterval(idleClock);
    if (on) idleClock = setInterval(() => { if (fullscreen && Date.now() - lastWake > 2500 && !root.querySelector(".pv-ctrls:hover, .pv-n-meta:hover")) goIdle(); }, 500);
    paintModes();
    try {
      if (app.host.real && app.host.videoFullscreen) { if (on) fsWasMax = !!(await app.host.videoFullscreen(true, false)); else await app.host.videoFullscreen(false, fsWasMax); }
      else if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      else if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch { /* the window stays as it is; the view is still filled */ }
    requestAnimationFrame(() => { const y = M.yt(); if (y) y.place(); });
  }
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && fullscreen && !app.host.real) setFullscreen(false); });
  function paintModes() {
    const v = hasVideo();
    theaterBtn.hidden = !v;
    fullBtn.hidden = !v;
    popBtn.hidden = !v;
    exitBtn.hidden = !fullscreen;
    theaterBtn.classList.toggle("is-on", !fullscreen && vsize() === "large");
    popBtn.classList.toggle("is-on", !fullscreen && vsize() === "float");
    pipBtn.classList.toggle("is-on", !!document.pictureInPictureElement);
    fullBtn.classList.toggle("is-on", fullscreen);
    fullBtn.replaceChildren(gi(fullscreen ? "unfull" : "full"));
    fullBtn.title = fullscreen ? "Leave full screen (F)" : "Full screen (F)";
    if (fullscreen && !v) setFullscreen(false);
  }
  // controls fade after a moment without the mouse (the video keeps the stage)
  const replaceYt = () => { const y = M.yt(); if (y) y.place(); };
  // in full screen a steady clock decides, not the chain of events: the video layer eats the pointer, so a missed event must not keep the bar
  let lastWake = 0, idleClock = 0;
  const goIdle = () => { if (!root.classList.contains("is-idle")) { root.classList.add("is-idle"); replaceYt(); } };
  function wake() {
    lastWake = Date.now();
    if (root.classList.contains("is-idle")) { root.classList.remove("is-idle"); replaceYt(); }
    clearTimeout(idleTimer);
    if (!theater) return;
    idleTimer = setTimeout(() => {
      if (theater && M.playing() && (!M.isYouTube() || fullscreen) && !root.querySelector(".pv-ctrls:hover, .pv-n-meta:hover")) { root.classList.add("is-idle"); replaceYt(); }
    }, 2500);
  }
  root.addEventListener("mousemove", () => { if (theater) wake(); });
  root.addEventListener("mouseleave", () => { if (theater && M.playing() && (!M.isYouTube() || fullscreen)) { clearTimeout(idleTimer); root.classList.add("is-idle"); replaceYt(); } });
  // on the body, not in the player: the video layer is a body child at its own z-order, and nothing inside the player is sure to lie over it
  const wakeStrip = h("div", { class: "pv-wake", onmousemove: () => wake(), onmouseenter: () => wake(), onclick: () => { wake(); root.focus({ preventScroll: true }); } });

  /* ── now playing ─────────────────────────────────────────────────────── */
  let stageKey = null;
  let metaAsked = null;
  function paintStage() {
    const key = M.current();
    const video = M.videoEl();
    const yt = M.isYouTube();
    const audioOnly = !!S.playerYtAudio;
    stage.classList.toggle("is-video", !!video || (yt && !audioOnly));
    stage.classList.toggle("is-yt", yt);
    stage.classList.toggle("is-tile", yt && audioOnly);
    if (video) {
      if (video.parentNode !== stage) { stage.replaceChildren(video); video.controls = false; }
      M.setStage(null);
    } else if (yt) {
      if (stageKey !== key || !stage.contains(ytAnchor)) stage.replaceChildren(h("div", { class: "pv-cover is-yt", style: { backgroundImage: `url("https://i.ytimg.com/vi/${ytIdOf(key)}/hqdefault.jpg")` } }), ytAnchor);
      if (visible) M.setStage(ytAnchor);
    } else {
      M.setStage(null);
      const m = key ? metaFor(key) : null;
      const cover = h("div", { class: "pv-cover" + (key ? "" : " is-idle"), style: key ? coverStyle(m, key) : null });
      if (!key || (!m.cover && !folderCover(app, key))) cover.append(icon("music", "pv-cover-ico"));
      stage.replaceChildren(cover);
    }
    stageKey = key;
  }
  function paintNow() {
    dirty.now = !visible;
    if (!visible) return;
    const key = M.current();
    const m = key ? metaFor(key) : null;
    paintStage();
    nTitle.textContent = m ? m.title || leaf(key) : "Nothing playing";
    nSub.textContent = !m ? "Pick a song, an album or paste a link" : isYt(key) ? "Online" : isUrl(key) ? `Online · ${m.artist}` : [m.artist, m.album || leaf(folderOf(key))].filter(Boolean).join(" · ");
    nTitle.title = key ? (isOnline(key) ? nTitle.textContent : key) : "";
    playBtn.replaceChildren(gi(M.playing() ? "pause" : "play"));
    root.classList.toggle("is-playing", M.playing());
    shuffleBtn.classList.toggle("is-on", M.queue.shuffle);
    const rep = M.queue.repeat;
    repeatBtn.classList.toggle("is-on", rep !== "off");
    repeatBtn.replaceChildren(rep === "one" ? gi("repeatOne") : icon("repeat"));
    repeatBtn.title = { off: "Repeat: off (R)", all: "Repeat: all (R)", one: "Repeat: this one (R)" }[rep];
    const video = M.videoEl();
    pipBtn.hidden = !video || !document.pictureInPictureEnabled;
    vizBtn.hidden = M.isYouTube();
    root.classList.toggle("has-yt", M.isYouTube());
    // a video playing takes the room it deserves: the picture leads and the
    // library moves below it (theater goes all the way)
    // theatre is one of the states the player comes back in
    const vs = vsize();
    const showVideo = hasVideo() && !theater;
    // "small" is the layout the player has always had: the picture sits in
    // the now-playing column on the right and the library keeps the page.
    root.classList.toggle("is-video", showVideo && vs === "large");
    root.classList.toggle("is-vsmall", showVideo && vs === "small");
    root.classList.toggle("is-vlarge", showVideo && vs === "large");
    root.classList.toggle("is-vfloat", showVideo && vs === "float");
    if (showVideo && vs === "float") placeFloat();
    dispatchEvent(new Event("leo:overlay")); // the floating video came or went: a web page under it makes room
    paintModes();
    eqPanel.hidden = !eqOpen;
    paintLevels();
    prevBtn.title = S.playerArrows === "volume" ? "Previous (Shift+←)" : "Previous (Shift+← or ↑)";
    nextBtn.title = S.playerArrows === "volume" ? "Next (Shift+→)" : "Next (Shift+→ or ↓)";
    vol.title = S.playerArrows === "volume" ? "Volume (↑/↓)" : "Volume (Shift+↑/↓)";
    paintTime();
    paintPlaying();
    vizLoop();
    // tags for the playing item, asked once (a repaint must never ask again)
    if (key && !isOnline(key) && metaFor(key).guess && metaAsked !== key) {
      metaAsked = key;
      M.metaReady(key).then(() => { if (M.current() === key) { stageKey = null; paintNow(); const r = rows.get(key); if (r) patchRow(r, key); } });
    }
  }
  function paintLevels() {
    const v = M.muted ? 0 : M.volume;
    if (document.activeElement !== vol) vol.value = String(v);
    vol.style.setProperty("--p", (v * 100).toFixed(1) + "%");
    muteBtn.replaceChildren(gi(M.muted || v === 0 ? "mute" : v < 0.5 ? "volLow" : "vol"));
    speedBtn.textContent = M.rate + "×";
    speedBtn.classList.toggle("is-on", M.rate !== 1);
  }
  let dragging = null;
  function paintTime() {
    if (!visible) return;
    const d = M.duration();
    const t = dragging != null ? dragging : M.time();
    tNow.textContent = fmtTime(t);
    tDur.textContent = d ? (showLeft ? "−" + fmtTime(Math.max(0, d - t)) : fmtTime(d)) : "–:––";
    const p = d ? Math.min(1, t / d) : 0;
    seekFill.style.transform = `scaleX(${p})`;
    // what has arrived so far: a local file says by its buffered ranges, YouTube by its loaded fraction
    let buf = 0;
    const v = M.videoEl();
    if (v && d && v.buffered && v.buffered.length) { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t && v.buffered.end(i) >= buf) buf = v.buffered.end(i) / d; }
    else if (M.isYouTube()) { try { const y = M.yt(); const f = y && y.player && y.player.getVideoLoadedFraction ? y.player.getVideoLoadedFraction() : 0; buf = f || 0; } catch {} }
    seekBuf.style.transform = `scaleX(${Math.min(1, buf)})`;
    seekKnob.style.left = (p * 100).toFixed(3) + "%";
    seek.setAttribute("aria-valuenow", String(Math.round(t)));
    const s = M.sleepInfo();
    const left = s.at ? Math.max(0, Math.ceil((s.at - Date.now()) / 60000)) : 0;
    sleepBtn.replaceChildren(icon("moon"), s.track ? "end" : left ? `${left}m` : "");
    sleepBtn.classList.toggle("is-on", !!(s.at || s.track));
  }
  // only the rows that changed: the one that was current and the one that is
  let shownKey = null;
  function paintPlaying() {
    const key = M.current();
    const on = M.playing();
    for (const k of new Set([shownKey, key])) {
      const r = k && rows.get(k);
      if (!r) continue;
      r.classList.toggle("is-current", k === key);
      r.classList.toggle("is-live", k === key && on);
    }
    shownKey = key;
    // folded folders keep a quiet mark while something inside them plays
    for (const g of listEl.querySelectorAll(".pv-group.is-folded")) {
      const dir = g.dataset.dir || "";
      const inside = !!key && (dir ? key.startsWith(dir + "/") : !isOnline(key));
      g.classList.toggle("has-playing", inside);
      g.classList.toggle("is-live", inside && on);
    }
  }

  // seek bar: click, drag, arrows, a hover time
  const seekAt = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * M.duration(); };
  seek.addEventListener("pointerdown", (e) => {
    if (!M.duration()) return;
    seek.setPointerCapture(e.pointerId);
    dragging = seekAt(e);
    seek.classList.add("is-drag");
    paintTime();
  });
  seek.addEventListener("pointermove", (e) => {
    const d = M.duration();
    if (d) {
      const t = seekAt(e);
      seekHover.textContent = fmtTime(t);
      seekHover.style.left = ((t / d) * 100).toFixed(2) + "%";
    }
    if (dragging != null) { dragging = seekAt(e); paintTime(); }
  });
  const endDrag = () => { if (dragging == null) return; M.seek(dragging); dragging = null; seek.classList.remove("is-drag"); paintTime(); };
  seek.addEventListener("pointerup", endDrag);
  seek.addEventListener("pointercancel", () => { dragging = null; seek.classList.remove("is-drag"); });
  seek.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); M.seek(M.time() + (e.key === "ArrowLeft" ? -5 : 5)); }
  });
  vol.addEventListener("wheel", (e) => { e.preventDefault(); M.setVolume(M.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });

  stage.addEventListener("click", (e) => { if (M.videoEl() && e.target === M.videoEl()) { M.toggle(); flashState(); } });
  stage.addEventListener("dblclick", () => { if (hasVideo()) setFullscreen(!fullscreen); });
  stage.append(flash);

  /* queue */
  // A long queue is drawn a part at a time: 250 round what plays, and more above and below as the
  // scroll comes near either end - kept while what plays is inside it, so a click doesn't move the list.
  let qStart = 0, qEnd = 0, qGrow = null;
  function qRow(i) {
    const k = M.queue.items[i];
    const m = metaFor(k);
    const r = h("div", { class: "pv-qrow" + (i === M.queue.index ? " is-current" : "") + (i < M.queue.index ? " is-past" : ""), draggable: true, dataset: { i: String(i) } },
      art(k, "is-xs"),
      h("span", { class: "pv-q-main" }, h("span", { class: "pv-q-name", text: m.title || leaf(k) }), h("span", { class: "pv-q-sub", text: isYt(k) ? "Online" : isUrl(k) ? `Online · ${m.artist}` : m.artist || leaf(folderOf(k)) })),
      h("button", { class: "pv-q-x", title: "Remove from the queue", onclick: (e) => { e.stopPropagation(); M.removeAt(i); } }, icon("x")));
    // the one playing: pause or resume it, as in the list, rather than start it over
    r.addEventListener("click", () => (i === M.queue.index && M.current() === k ? M.toggle() : M.playAt(i)));
    r.addEventListener("contextmenu", (e) => { e.preventDefault(); rowMenu(k, [k], null, e, { queueAt: i }); });
    return r;
  }
  let qDrawn = null; // the items and the length the queue was drawn from
  function renderQueue() {
    dirty.queue = !visible;
    if (!visible) return;
    const q = M.queue;
    // only another song playing from the same queue: the marks move, nothing is drawn again
    if (qDrawn && qDrawn.items === q.items && qDrawn.n === q.items.length && !qFindIn.value.trim() && q.index >= qStart && q.index < qEnd) {
      qCount.textContent = `${q.index + 1} / ${q.items.length}`;
      for (const r of qList.querySelectorAll(".pv-qrow")) { const i = +r.dataset.i; r.classList.toggle("is-current", i === q.index); r.classList.toggle("is-past", i < q.index); }
      return;
    }
    qDrawn = null;
    qCount.textContent = q.items.length ? `${q.index + 1} / ${q.items.length}` : "";
    qFrom.textContent = q.items.length && q.from ? q.from : "";
    qFrom.title = q.from ? `Playing from “${q.from}”` : "";
    if (qGrow) qGrow.disconnect();
    if (!q.items.length) {
      qList.replaceChildren(h("div", { class: "pv-q-empty", text: document.documentElement.classList.contains("is-phone") ? "The queue is empty. Play a song and it starts here." : "The queue is empty. Double-click a song, or drag songs here." }));
      return;
    }
    // searching: the first 250 that match
    const find = qFindIn.value.trim().toLowerCase();
    if (find) {
      const matches = (k) => { const m = metaFor(k); return `${m.title || leaf(k)} ${m.artist || ""} ${m.album || ""}`.toLowerCase().includes(find); };
      const out = [];
      for (let i = 0; i < q.items.length && out.length < 250; i++) if (matches(q.items[i])) out.push(qRow(i));
      qList.replaceChildren(...(out.length ? out : [h("div", { class: "pv-q-empty", text: "Nothing in the queue matches" })]));
      qList.classList.add("is-finding");
      return;
    }
    qList.classList.remove("is-finding");
    // the whole queue at once: nothing is added above while scrolling, so the player never gets pushed away
    // (rows off screen cost next to nothing - content-visibility in media.css)
    const n = q.items.length;
    qStart = 0;
    qEnd = n;
    const out = [];
    for (let i = qStart; i < qEnd; i++) out.push(qRow(i));
    const top = h("div", { class: "pv-q-more" }), bottom = h("div", { class: "pv-q-more" });
    qList.replaceChildren(...[qStart > 0 ? top : null, ...out, qEnd < n ? bottom : null].filter(Boolean));
    qDrawn = { items: q.items, n };
    const c = qList.querySelector(".is-current");
    if (c) {
      const at = c.offsetTop - qList.offsetTop;
      if (at < qList.scrollTop || at > qList.scrollTop + qList.clientHeight - 40) qList.scrollTop = at - 40;
    }
    // more as either end comes near (the queue scrolls in its own box or with the panel: watched against the window)
    qGrow = new IntersectionObserver((es) => {
      for (const e of es) {
        if (!e.isIntersecting || !e.target.isConnected) continue;
        if (e.target === bottom) {
          const to = Math.min(M.queue.items.length, qEnd + 250);
          const rows = [];
          for (let i = qEnd; i < to; i++) rows.push(qRow(i));
          bottom.before(...rows);
          qEnd = to;
          if (qEnd >= M.queue.items.length) { qGrow.unobserve(bottom); bottom.remove(); }
          else { qGrow.unobserve(bottom); qGrow.observe(bottom); }
        } else {
          const from = Math.max(0, qStart - 250);
          const rows = [];
          for (let i = from; i < qStart; i++) rows.push(qRow(i));
          // added above without moving what is in view
          const anchor = top.nextElementSibling;
          const was = anchor ? anchor.getBoundingClientRect().top : 0;
          top.after(...rows);
          qStart = from;
          if (anchor) { const by = anchor.getBoundingClientRect().top - was; const sc = scrollerOf(qList); if (sc) sc.scrollTop += by; }
          if (qStart <= 0) { qGrow.unobserve(top); top.remove(); }
          else { qGrow.unobserve(top); qGrow.observe(top); }
        }
      }
    }, { rootMargin: "600px 0px" });
    if (top.isConnected) qGrow.observe(top);
    if (bottom.isConnected) qGrow.observe(bottom);
  }
  /** The box that scrolls an element: its nearest ancestor (or itself) that can. */
  function scrollerOf(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return e;
    return null;
  }
  sortable(qList, { item: ".pv-qrow", onMove: (a, b) => { if (qFindIn.value.trim()) return renderQueue(); const base = +qList.querySelector(".pv-qrow").dataset.i; M.move(base + a, base + b); } });
  // songs dragged from the library into the queue
  qList.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-leonote-play")) { e.preventDefault(); qList.classList.add("is-drop"); } });
  qList.addEventListener("dragleave", (e) => { if (!qList.contains(e.relatedTarget)) qList.classList.remove("is-drop"); });
  qList.addEventListener("drop", (e) => {
    qList.classList.remove("is-drop");
    const keys = dropKeys(e);
    if (!keys) return;
    e.preventDefault();
    const idle = !M.current();
    const i = M.enqueue(keys);
    if (idle) M.playAt(i);
  });

  /* ── equalizer & visualizer ──────────────────────────────────────────── */
  // the sound panel stays open (or shut) across restarts; the dot on its button says effects are on
  let eqOpen = S.soundPanel === true;
  eqBtn.classList.toggle("is-open", eqOpen);
  const paintEqDot = () => eqBtn.classList.toggle("is-on", Object.values(SE.cfg.chain).some((x) => x && x.on));
  SE.on(paintEqDot);
  SE.onChain(paintEqDot);
  paintEqDot();
  async function toggleEq() {
    eqOpen = !eqOpen;
    app.setSetting("soundPanel", eqOpen);
    eqBtn.classList.toggle("is-open", eqOpen);
    // the panel opens even when the sound graph cannot start - then it says why
    if (eqOpen) try { await M.graph(); } catch (e) { console.error("sound graph", e); app.toast("The sound effects could not start: " + (e && e.message ? e.message : e), { kind: "error", ms: 6000 }); }
    renderEq();
    paintNow();
  }
  let lab = null;
  function renderEq() {
    if (!eqOpen) { eqPanel.hidden = true; return; }
    eqPanel.hidden = false;
    eqPanel.classList.add("sl");
    try { if (!lab) lab = mountSoundLab(app, M, eqPanel); else lab.paint(); }
    catch (e) { console.error("sound lab", e); lab = null; eqPanel.replaceChildren(h("div", { class: "pv-eq-err", text: "The sound panel could not open: " + (e && e.message ? e.message : e) })); }
    paintEqDot();
  }

  let vizOn = !!S.playerViz;
  let vizRaf = 0;
  let bins = null;
  async function toggleViz() {
    vizOn = !vizOn;
    app.setSetting("playerViz", vizOn);
    if (vizOn) await M.graph();
    vizLoop();
  }
  function vizLoop() {
    const want = vizOn && visible && M.playing() && !M.isYouTube();
    vizBtn.classList.toggle("is-on", vizOn);
    viz.hidden = !vizOn || M.isYouTube();
    if (!want) { cancelAnimationFrame(vizRaf); vizRaf = 0; return; }
    if (!M.graphReady) { M.graph().then(() => { if (!vizRaf) vizLoop(); }); return; }
    if (vizRaf) return;
    const g = M.audio();
    const ctx = viz.getContext("2d");
    let color = "";
    const draw = () => {
      vizRaf = requestAnimationFrame(draw);
      const w = viz.clientWidth, hh = viz.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (viz.width !== Math.round(w * dpr)) { viz.width = Math.round(w * dpr); viz.height = Math.round(hh * dpr); color = ""; }
      if (!color) color = getComputedStyle(root).getPropertyValue("--accent").trim() || "#e0a84a";
      const n = g.bins();
      if (!bins || bins.length !== n) bins = new Uint8Array(n);
      if (!g.levels(bins)) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hh);
      const count = 48;
      const gap = 2;
      const bw = (w - gap * (count - 1)) / count;
      ctx.fillStyle = color;
      for (let i = 0; i < count; i++) {
        // log-ish spread: more bars for the low end where music lives
        const idx = Math.min(n - 1, Math.floor(Math.pow(i / count, 1.6) * n * 0.9));
        const v = bins[idx] / 255;
        const bh = Math.max(2, v * v * hh);
        ctx.globalAlpha = 0.35 + v * 0.65;
        const x = i * (bw + gap);
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, hh - bh, bw, bh, Math.min(2, bw / 2)) : ctx.rect(x, hh - bh, bw, bh);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    draw();
  }

  /* ── keys (while the player has focus) ───────────────────────────────── */
  // Ctrl+Z brings back what the Player removed, wherever the focus sits, as long as the Player is the view up
  document.addEventListener("keydown", (e) => {
    if (!visible || !((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && keyOf(e).toLowerCase() === "z") || isTyping(e.target) || !undos.length) return;
    if (document.querySelector(".menu, .dlg-back, .pal-back")) return;
    e.preventDefault(); e.stopPropagation();
    undos.pop()();
    app.toast("Brought back", { ms: 1800 });
  }, true);
  root.addEventListener("keydown", (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey) {
      if (e.key === "Escape" && e.target === search && search.value) clearBox();
      return;
    }
    const k = keyOf(e); // the key, not the letter: these work on a Ukrainian layout too
    if (k === " " && e.target.closest("button")) return;
    if (k === " " || k === "k" || k === "K") { M.toggle(); flashState(); }
    else if (k === "j" || k === "J") M.seek(M.time() - 10);
    else if (k === "l" || k === "L") M.seek(M.time() + 10);
    else if (/^[0-9]$/.test(k) && M.duration()) M.seek(M.duration() * (Number(k) / 10));
    else if (k === "Home" && M.duration()) M.seek(0);
    else if (k === "End" && M.duration()) M.seek(Math.max(0, M.duration() - 1));
    else if ((k === "<" || k === ",") && e.shiftKey === (k === "<")) M.setRate(Math.max(0.25, Math.round((M.rate - 0.25) * 4) / 4));
    else if ((k === ">" || k === ".") && e.shiftKey === (k === ">")) M.setRate(Math.min(3, Math.round((M.rate + 0.25) * 4) / 4));
    else if (k === "ArrowLeft" && e.shiftKey) M.prev();
    else if (k === "ArrowRight" && e.shiftKey) M.next();
    else if (k === "ArrowLeft") M.seek(M.time() - 5);
    else if (k === "ArrowRight") M.seek(M.time() + 5);
    else if (k === "ArrowUp" || k === "ArrowDown") {
      const up = k === "ArrowUp";
      const volume = (S.playerArrows === "volume") !== e.shiftKey;
      if (volume) M.setVolume(M.volume + (up ? 0.05 : -0.05));
      else up ? M.prev() : M.next();
    }
    else if (k === "m" || k === "M") M.toggleMute();
    else if (k === "s" || k === "S") M.setShuffle(!M.queue.shuffle);
    else if (k === "r" || k === "R") M.cycleRepeat();
    else if (k === "Escape" && fullscreen) setFullscreen(false);
    else if (k === "Escape" && root.classList.contains("is-vfloat")) pickSize("float");
    else if (k === "Escape" && sel.size) { sel.clear(); paintSel(); }
    else if ((k === "t" || k === "T") && hasVideo()) pickSize("large");
    else if ((k === "p" || k === "P") && hasVideo() && !e.ctrlKey && !e.metaKey) pickSize("float");
    else if ((k === "f" || k === "F") && hasVideo()) setFullscreen(!fullscreen);
    else if (k === "F2" && !theater) { const ks = selected(); if (ks.length === 1) renameItem(ks[0]); }
    else if (k === "Delete" && !theater) deleteSelected();
    else if (k === "Enter" && sel.size) { const all = visibleKeys(); const keys = all.filter((x) => sel.has(x)); if (keys.length === 1) playFrom(all, keys[0]); else playL(keys, 0); }
    else if (k === "/" ) { search.focus(); }
    else return;
    e.preventDefault();
  });
  root.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && keyOf(e).toLowerCase() === "a" && !isTyping(e.target)) { e.preventDefault(); for (const k of visibleKeys()) sel.add(k); paintSel(); }
    if ((e.ctrlKey || e.metaKey) && keyOf(e).toLowerCase() === "f") { e.preventDefault(); search.focus(); search.select(); }
  });
  search.addEventListener("input", debounce(() => {
    if (browserMode()) return; // the box is the browser's address bar then
    if (query === search.value) return;
    query = search.value;
    setDraft(search.value);
    if (!draft) lastWords = query;
    limit = PAGE;
    renderList();
  }, 120));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && browserMode()) { search.blur(); return; }
    if (e.key !== "Enter") return;
    if (browserMode()) {
      e.preventDefault();
      const v = search.value.trim();
      if (!v) return;
      browserGo(toUrl(v, S.webSearch || "google") || webSearchUrl(S.webSearch, v));
      search.blur();
      return;
    }
    const d = readLink(search.value);
    if (d) { e.preventDefault(); addLink(d, "play").then((ok) => ok && clearBox()); return; }
    // words the library does not have: the browser looks them up
    const v = search.value.trim();
    if (v && !visibleKeys().length) {
      e.preventDefault();
      if (tab !== "youtube") setTab("youtube");
      setBrowserOn(true);
      browserGo(webSearchUrl(S.webSearch, v));
    }
  });
  search.addEventListener("focus", () => { if (browserMode()) { paintAddress(); requestAnimationFrame(() => search.select()); } });
  // a link pasted into the box is meant for the library: add it (it plays if
  // nothing else is), and the row above the list offers the other choices
  search.addEventListener("paste", () => setTimeout(() => {
    const d = readLink(search.value);
    if (!d) return;
    query = search.value;
    draft = d;
    if (!d.bad) addLink(d, "auto");
    renderList();
  }, 0));
  // paste or drop a link anywhere in the Player
  document.addEventListener("paste", (e) => {
    if (!visible || isTyping(document.activeElement) || document.querySelector(".pal-back, .dlg-back, .menu")) return;
    const a = document.activeElement;
    if (a && a !== document.body && !root.contains(a)) return;
    const d = readLink(e.clipboardData && e.clipboardData.getData("text/plain"));
    if (!d) return;
    e.preventDefault();
    addLink(d, "auto");
  });
  const linkIn = (e) => { const t = e.dataTransfer.types; return !t.includes("application/x-leonote-play") && !t.includes("Files") && (t.includes("text/uri-list") || t.includes("text/plain")); };
  root.addEventListener("dragover", (e) => {
    if (!linkIn(e) || e.defaultPrevented) return;
    e.preventDefault();
    root.classList.add("is-linkdrop");
  });
  root.addEventListener("dragleave", (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove("is-linkdrop"); });
  root.addEventListener("drop", (e) => {
    root.classList.remove("is-linkdrop");
    if (e.defaultPrevented || !linkIn(e)) return;
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    const d = readLink((text || "").split(/\r?\n/).find((l) => l && !l.startsWith("#")));
    if (!d) return;
    e.preventDefault();
    addLink(d, "auto");
  });

  /* ── engine events: paint now if visible, else on the next show ──────── */
  M.bus.addEventListener("change", paintNow);
  M.bus.addEventListener("state", () => { if (visible) paintPlaying(); });
  // the Player took over: whatever the browser's pages were playing stops, so the two never run side by side
  const pausePages = () => { if (!app.host.real || S.playerBrowserPause === false) return; for (const t of bTabs) app.host.tabWebPost(t.wid, "leo:pause").catch(() => {}); };
  M.bus.addEventListener("state", () => { if (M.playing()) pausePages(); });
  M.bus.addEventListener("change", pausePages);
  M.bus.addEventListener("levels", () => { if (visible) paintLevels(); });
  M.bus.addEventListener("time", paintTime);
  M.bus.addEventListener("queue", renderQueue);
  M.bus.addEventListener("libraries", () => { if (visible) renderList(); else dirty.list = true; });
  M.bus.addEventListener("library", debounce(() => { if (!visible) dirty.list = true; else if (tab === "youtube" || tab === "playlists") renderList(); else paintTabs(); }, 120));
  const vaultChanged = debounce(() => { if (tab === "music" || tab === "videos") renderList(); }, 300);
  app.vault.bus.on("structure", vaultChanged);
  app.bus.on("settings", (k) => { if (k === "theme" || k === "accent") { vizRaf && cancelAnimationFrame(vizRaf); vizRaf = 0; vizLoop(); } });
  app.bus.on("view", (t) => {
    const on = !!t && t.kind === "view" && t.view === "music";
    if (on === visible) return;
    visible = on;
    if (!on) { if (fullscreen) setFullscreen(false); M.setStage(null); vizLoop(); }
    syncBrowser();
  });
  let clock = 0;

  return {
    /** A link from elsewhere (the browser's menu): a video into Online media, a playlist whole. */
    addLink: (text, how = "add") => addLink(text, how),
    show() {
      visible = true;
      M.libraries.ensure();
      // only the first paint after the view comes back is staggered; typing in
      // the search box repaints the list and must not replay it
      if (dirty.list) { renderList(); animateRows(listEl.querySelector(".pv-rows") || listEl); }
      if (dirty.queue) renderQueue();
      stageKey = null;
      paintNow();
      clearInterval(clock);
      // the sleep countdown, a minute at a time
      clock = setInterval(() => { if (!visible) return clearInterval(clock); if (!M.playing()) paintTime(); }, 20000);
      if (!el.contains(document.activeElement)) root.focus({ preventScroll: true });
      if (eqOpen) { M.graph().catch(() => {}); renderEq(); }
      syncBrowser();
    },
  };
}
