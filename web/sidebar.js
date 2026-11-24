// Sidebar: views, pinned notes, the file tree and tags.
// Content edits never touch the tree; only structural changes rebuild it,
// and the rebuild is one detached build + one replaceChildren.

import { h, basename, dirname, joinPath, naturalCompare, debounce, dayKey, motionFull } from "./util.js";
import { icon } from "./icons.js";
import { menu, closeMenu, inlineEdit, sortable, confirmDialog, askDialog, kbd } from "./ui.js";
import { openPalette } from "./palette.js";
import { KIND_ICON } from "./fileview.js";
import { folderLook, groundOf, customizeFolder, extColor } from "./treestyle.js";
import { vaultPanel } from "./vaults.js";
import { mountOutposts, droppedFiles } from "./outposts.js";
import { rankOf, rankColor } from "./stats.js";
import { openSizes } from "./sizes.js";

// settings that change how the tree is drawn
const TREE_KEYS = new Set(["treeSort", "hiddenPaths", "showHidden", "showDotFolders", "treeRootIndent", "folderStyles", "treeIndent", "treeShowExt", "treeCounts", "treeFolderIcons", "treeGuides", "treeDimFiles", "treeExtStyle", "theme"]);

// Expand all: the folders open before the last Collapse all, or every folder when
// asked to, or when fewer than two of those are remembered (and still there)
export function foldersToExpand(before, mode, allFolders) {
  const all = allFolders instanceof Set ? allFolders : new Set(allFolders);
  if (mode === "all") return [...all];
  const back = (before || []).filter((f) => all.has(f));
  return back.length > 1 ? back : [...all];
}

export function mountSidebar(app, el) {
  const { vault } = app;
  const expanded = new Set(app.settings.expanded || []);
  let raf = 0;

  const nav = h("nav", { class: "sb-nav" });
  const pinned = h("div", { class: "sb-list" });
  const tree = h("div", { class: "tree", tabIndex: 0 });
  const tags = h("div", { class: "sb-tags" });

  const section = (id, title, body, actions = []) => {
    const collapsed = (app.settings.sbCollapsed || []).includes(id);
    const sec = h("section", { class: "sb-sec" + (collapsed ? " is-collapsed" : "") },
      h("div", { class: "sb-sec-head" },
        h("button", { class: "sb-sec-title", onclick: () => {
          sec.classList.toggle("is-collapsed");
          const set = new Set(app.settings.sbCollapsed || []);
          sec.classList.contains("is-collapsed") ? set.add(id) : set.delete(id);
          app.setSetting("sbCollapsed", [...set]);
        } }, icon("chevronDown", "sb-caret"), title),
        h("div", { class: "sb-sec-acts" }, actions)
      ),
      h("div", { class: "sb-sec-body" }, body)
    );
    return sec;
  };
  const act = (ic, title, run) => h("button", { class: "icon-btn", title, onclick: (e) => { e.stopPropagation(); run(e); } }, icon(ic));

  const pinnedSec = section("pinned", "Pinned", pinned);
  const allBtn = act("chevronDown", "Expand or collapse all folders (right-click: what Expand opens)", () => toggleAll());
  allBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const mode = app.settings.treeExpandAll;
    menu(e.clientX, e.clientY, [
      { label: "Expand: folders open before", checked: mode !== "all", run: () => app.setSetting("treeExpandAll", "previous") },
      { label: "Expand: every folder", checked: mode === "all", run: () => app.setSetting("treeExpandAll", "all") },
    ]);
  });
  // the Phone view one click away; the tree header's menu hides it
  const phoneBtn = act("phone", "Phone - files on a phone plugged in by USB", () => app.openView("phone"));
  phoneBtn.hidden = app.settings.treePhoneButton === false;
  app.bus.on("settings", (k) => { if (k === "treePhoneButton") phoneBtn.hidden = app.settings.treePhoneButton === false; });
  const rootName = h("span", { class: "sb-root-name", text: vaultName() });
  // quick filter: narrows the tree to matching names, folders open themselves
  let filterQ = "";
  const filterInput = h("input", { class: "sb-filter-input", placeholder: "Filter files…", spellcheck: "false",
    oninput: () => { filterQ = filterInput.value.trim().toLowerCase(); schedule(); outposts.setFilter(filterQ); },
    onkeydown: (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeFilter(); }
      if (e.key === "Enter") { const r = tree.querySelector(".tree-row.is-note, .tree-row.is-file"); if (r) r.click(); }
      if (e.key === "ArrowDown") { e.preventDefault(); tree.focus(); }
    } });
  // names only, or what is written in the notes as well - remembered
  const insideOn = () => !!app.settings.treeFilterInside;
  const insideBtn = h("button", { class: "icon-btn sb-filter-inside", onclick: () => { app.setSetting("treeFilterInside", !insideOn()); paintInside(); if (filterQ) renderTree(); filterInput.focus(); } }, icon("fileText"));
  const paintInside = () => { insideBtn.classList.toggle("is-on", insideOn()); insideBtn.title = insideOn() ? "Searching names and the text inside notes - click for names only" : "Searching names only - click to search the text inside notes too"; filterInput.placeholder = insideOn() ? "Filter by name or text…" : "Filter files…"; };
  paintInside();
  const filterRow = h("div", { class: "sb-filter", hidden: true }, icon("search"), filterInput, insideBtn,
    h("button", { class: "icon-btn", title: "Clear filter (Esc)", onclick: () => closeFilter() }, icon("x")));
  function openFilter() {
    if (filesSec.classList.contains("is-collapsed")) { filesSec.classList.remove("is-collapsed"); app.setSetting("sbCollapsed", (app.settings.sbCollapsed || []).filter((x) => x !== "files")); }
    filterRow.hidden = false;
    filterInput.focus();
    filterInput.select();
  }
  // the row last picked while filtering: clearing the filter lands on it in the full tree
  let filterPick = "";
  function closeFilter() {
    filterRow.hidden = true;
    filterInput.value = "";
    const go = filterQ ? filterPick : "";
    filterPick = "";
    if (!filterQ) return;
    filterQ = "";
    outposts.setFilter("");
    renderTree();
    if (go && (vault.notes.has(go) || vault.files.has(go) || vault.folders.has(go))) { reveal(go); tree.focus({ preventScroll: true }); }
  }
  app.filterFiles = openFilter;
  app.clearFileFilter = closeFilter;
  const filesSec = section("files", rootName, h("div", {}, filterRow, tree), [
    act("search", "Filter files (Alt+F)", () => (filterRow.hidden || filesSec.classList.contains("is-collapsed") ? openFilter() : closeFilter())),
    act("filePlus", "New note (Ctrl+N)", () => app.newNote({})),
    // the header's button makes it at the top of the vault; Ctrl+Shift+N, where you are
    act("folderPlus", "New folder at the top of the vault (Ctrl+Shift+N: in the folder you are in)", () => newFolder("")),
    phoneBtn,
    allBtn,
  ]);
  filesSec.classList.add("is-root");
  filesSec.querySelector(".sb-sec-title").title = `Vault: ${vault.root || ""}`;
  let lastFolder = null; // where Ctrl+Shift+N puts a folder
  let cursor = null; // the keyboard-selected row, by path
  const tagsSec = section("tags", "Tags", tags);
  // folders outside the vault, at the very bottom and dressed differently
  const outposts = mountOutposts(app, { section, act });

  const levelChip = h("button", { class: "sb-level", onclick: () => app.openLevels(),
    oncontextmenu: (e) => { e.preventDefault(); levelCard(false); menu(e.clientX, e.clientY, [
      { label: "Levels, ranks and badges", icon: "star", run: () => app.openLevels() },
      // only the rank's icon: the level and its bar stay (the whole badge: Settings › Notices › Level badge)
      { label: app.settings.showRankIcon === false ? "Show the rank icon" : "Hide the rank icon", icon: "eye", run: () => app.setSetting("showRankIcon", app.settings.showRankIcon === false) },
    ]); } });
  // hovering the badge: a card with the rank, the way to the next level and the next rank
  let cardEl = null, cardTimer = 0;
  const levelCard = (show) => {
    clearTimeout(cardTimer);
    if (!show) { if (cardEl) { cardEl.remove(); cardEl = null; } return; }
    cardTimer = setTimeout(() => {
      const p = app.stats.progress(), r = rankOf(p.level), c = rankColor(p.level);
      const st = app.stats.streak ? app.stats.streak() : { count: 0 };
      const box = levelChip.getBoundingClientRect();
      cardEl?.remove();
      cardEl = h("div", { class: "sb-level-card", style: { "--rc": c, left: Math.max(8, box.left) + "px", bottom: innerHeight - box.top + 8 + "px" } },
        h("div", { class: "sb-lc-head" }, h("span", { class: "sb-lc-ico" }, icon(r.icon)),
          h("div", {}, h("div", { class: "sb-lc-rank", text: r.name }), h("div", { class: "sb-lc-sub", text: `Level ${p.level} · ${app.stats.xp.toLocaleString()} XP` }))),
        h("div", { class: "sb-lc-bar" }, h("span", { style: { width: `${Math.round((p.into / p.span) * 100)}%` } })),
        h("div", { class: "sb-lc-line", text: `${(p.span - p.into).toLocaleString()} XP to level ${p.level + 1}` }),
        r.next ? h("div", { class: "sb-lc-line", text: `Next rank: ${r.next.name} at level ${r.next.level}` }) : null,
        st.count > 1 ? h("div", { class: "sb-lc-line", text: `${st.count} days in a row` }) : null);
      document.getElementById("overlay-root").append(cardEl);
    }, 250);
  };
  levelChip.addEventListener("mouseenter", () => levelCard(true));
  levelChip.addEventListener("mouseleave", () => levelCard(false));
  app.bus.on("settings", (k) => { if (k === "showLevel" || k === "showRankIcon") renderLevel(); });

  // One click lists the vaults, two opens this one in the file manager, so the
  // single click has to wait a moment to find out which it was.
  let vaultClick = 0;
  const vaultBtn = h("button", {
    class: "sb-vault", title: "Vaults - double-click to open this folder",
    onclick: () => { clearTimeout(vaultClick); vaultClick = setTimeout(() => vaultPanel(app, vaultBtn), 220); },
    ondblclick: () => { clearTimeout(vaultClick); app.reveal(""); },
    oncontextmenu: (e) => { e.preventDefault(); vaultPanel(app, vaultBtn); },
  }, icon("folder"), h("span", { class: "sb-vault-name", text: vaultName() }));
  /* ── the line under the views: drag it to make them taller ────────────
     One number, kept in settings: how tall a view button is. Dragging the
     line gives the block the height the user pulls it to, which is the same
     thing said in pixels. Double-click puts it back. */
  const NAV_MIN = 26;
  const NAV_MAX = 64;
  const navH = () => Math.min(NAV_MAX, Math.max(NAV_MIN, Number(app.settings.navSize) || 31));
  const navCount = () => Math.max(1, nav.querySelectorAll(".sb-item").length);
  const applyNavH = (px) => el.style.setProperty("--sb-item-h", Math.round(px) + "px");

  const navResizer = h("div", { class: "sb-navresize", title: "Drag to make the views taller or shorter (double-click to reset)" },
    h("span", { class: "sb-navgrip" }));
  navResizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || app.settings.navRibbon) return;
    e.preventDefault();
    const start = navH();
    const n = navCount();
    const y0 = e.clientY;
    let now = start;
    try { navResizer.setPointerCapture(e.pointerId); } catch {}
    navResizer.classList.add("is-dragging");
    const move = (ev) => {
      // the whole block follows the pointer: each row takes its share
      now = Math.min(NAV_MAX, Math.max(NAV_MIN, start + (ev.clientY - y0) / n));
      applyNavH(now);
    };
    const up = () => {
      navResizer.classList.remove("is-dragging");
      navResizer.removeEventListener("pointermove", move);
      navResizer.removeEventListener("pointerup", up);
      navResizer.removeEventListener("pointercancel", up);
      if (Math.round(now) !== start) app.setSetting("navSize", Math.round(now));
    };
    navResizer.addEventListener("pointermove", move);
    navResizer.addEventListener("pointerup", up);
    navResizer.addEventListener("pointercancel", up);
  });
  navResizer.addEventListener("dblclick", () => { app.setSetting("navSize", 31); applyNavH(31); });

  /* In a project space the sidebar can show the project's folder where the
     vault's files otherwise are. One switch at the top, remembered per space. */
  const projectBar = h("div", { class: "sb-project", hidden: true });
  const projectNow = () => (app.settings.spaceProjects || {})[app.currentSpaceId ? app.currentSpaceId() : ""] || "";
  const sideOf = () => { const m = app.settings.spaceSidebar || {}; const v = m[app.currentSpaceId ? app.currentSpaceId() : ""]; return v || (app.settings.projectSidebarFirst === false ? "vault" : "project"); };
  function paintProjectBar() {
    const root = projectNow();
    const isVault = !!root && root === (app.vault.root || "");
    const on = !!root && !isVault && sideOf() === "project";
    projectBar.hidden = !root || isVault;
    el.classList.toggle("is-project", on);
    outposts.focus(on ? root : "");
    if (projectBar.hidden) return;
    const name = String(root).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    const set = (v) => { app.setSetting("spaceSidebar", { ...(app.settings.spaceSidebar || {}), [app.currentSpaceId()]: v }); paintProjectBar(); };
    projectBar.replaceChildren(h("div", { class: "segmented is-small" },
      h("button", { class: "seg" + (on ? "" : " is-active"), title: "The vault's notes and files", onclick: () => set("vault") }, icon("home"), "Vault"),
      // a long name keeps its END in view (that is the telling part) and shows whole on hover
      h("button", { class: "seg is-name" + (on ? " is-active" : ""), title: name + " · " + root, onclick: () => set("project") }, icon("code"), h("span", { class: "sb-project-name" }, h("bdi", { text: name })))));
  }
  app.bus.on("space", paintProjectBar);
  app.bus.on("settings", (k) => { if (k === "spaceProjects" || k === "projectSidebarFirst") paintProjectBar(); });
  setTimeout(paintProjectBar);

  /* In a workspace's space, the workspace stays at hand whatever tab is up: its
     lenses, a new note, its chat and its files, each kind folding (projectroom.js). */
  const wsBody = h("div", { class: "sb-ws" });
  const wsTitle = h("span", { class: "sb-ws-name", text: "Workspace" });
  let wsNow = "";
  const wsSec = section("workspace", h("span", { class: "sb-ws-title" }, icon("briefcase"), wsTitle), wsBody,
    [act("expand", "The workspace room (Alt+R)", () => wsNow && app.openRoom(wsNow))]);
  wsSec.hidden = true;
  const paintWs = debounce(async () => {
    const id = app.currentSpaceId ? app.currentSpaceId() : "";
    const map = app.settings.roomSpaces || {};
    const folder = Object.keys(map).find((f) => map[f] === id) || "";
    const p = folder && app.projectAt ? app.projectAt(folder) : null;
    wsNow = p ? folder : "";
    wsSec.hidden = !p;
    if (!p) return;
    wsTitle.textContent = p.name;
    wsTitle.title = p.outside ? `${p.folder} · ${p.outside}` : p.folder;
    const m = await import("./projectroom.js");
    wsBody.replaceChildren(...m.workspacePanel(app, p, paintWs));
  }, 80);
  app.bus.on("space", paintWs);
  app.bus.on("settings", (k) => { if (k === "roomSpaces" || k === "roomFolded") paintWs(); });
  vault.bus.on("structure", paintWs);
  setTimeout(paintWs);

  // the files' search, when their header has scrolled out of sight: it slides into the top right corner
  const floatSearch = h("div", { class: "sb-float" }, h("button", { class: "icon-btn sb-float-search", title: "Filter files (Alt+F)", onclick: () => { openFilter(); filterRow.scrollIntoView({ block: "nearest" }); } }, icon("search")));
  const sbScroll = h("div", { class: "sb-scroll" }, floatSearch, wsSec, pinnedSec, filesSec, outposts.el, tagsSec);
  let floatRaf = 0;
  sbScroll.addEventListener("scroll", () => {
    if (floatRaf) return;
    floatRaf = requestAnimationFrame(() => {
      floatRaf = 0;
      const head = filesSec.querySelector(".sb-sec-head");
      floatSearch.classList.toggle("is-on", !!head && head.getBoundingClientRect().bottom < sbScroll.getBoundingClientRect().top + 2);
    });
  }, { passive: true });
  el.append(
    nav,
    navResizer,
    projectBar,
    sbScroll,
    h("div", { class: "sb-foot" },
      vaultBtn,
      levelChip,
      h("button", { class: "icon-btn sb-foot-settings", title: "Settings (Ctrl+,)", onclick: () => app.openView("settings"), oncontextmenu: (e) => gearMenu(e) }, icon("settings"))
    )
  );

  applyNavH(navH());

  function vaultName() {
    const r = vault.root || "Vault";
    return r.split(/[\\/]/).filter(Boolean).pop() || r;
  }

  /* ── nav ────────────────────────────────────────────────────────────── */
  const navItems = [
    { id: "home", name: "Home", icon: "home", keys: "Alt 1" },
    { id: "tasks", name: "Tasks", icon: "checkSquare", keys: "Alt 2", badge: () => app.tasks.count("inbox") || "" },
    { id: "focus", name: "Focus", icon: "focus", keys: "Alt 5" },
    { id: "habits", name: "Habits", icon: "flame", keys: "Alt 3", badge: () => app.habitsBadge() },
    { id: "calendar", name: "Calendar", icon: "calendar", keys: "Alt C" },
    { id: "fit", name: "Workout", icon: "dumbbell", keys: "Alt W" },
    { id: "timer", name: "Timer", icon: "clock", keys: "Alt 6", badge: () => app.pomo.badge() },
    { id: "graph", name: "Graph", icon: "graph", keys: "Alt 4" },
    { id: "music", name: "Player", icon: "music", keys: "Alt 7" },
    { id: "search", name: "Search", icon: "search", keys: "Alt 8" },
    { id: "assistant", name: "Assistant", icon: "sparkles", keys: "Alt 0" },
    { id: "room", name: "Workspace room", icon: "briefcase", keys: "Alt R" },
    { id: "daily", name: "Today's note", icon: "note", keys: "Alt D" },
    { id: "sketch", name: "Drawing", icon: "brush", keys: "Paint, Studio, Filter or Animate - new, or a recent one" },
    { id: "video", name: "Video", icon: "film", keys: "a reel or meme: new, or a recent one" },
  ];
  const recentSketches = () => [...vault.files.values()].filter((f) => /\.(leocanvas|leopaint|leovector|excalidraw)$/i.test(f.path)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 40);
  /** The recent sketches in a box `rows` tall that scrolls; `done` is called before one opens. */
  function recentBox(rows, done) {
    const recent = recentSketches();
    if (!recent.length) return null;
    return h("div", { class: "nt-recent" },
      h("div", { class: "nt-head", text: "Recent sketches" }),
      h("div", { class: "nt-recent-list", style: { maxHeight: rows * 30 + "px" } },
        ...recent.map((f) => h("button", { class: "nt-item", onclick: () => { if (done) done(); app.openFile(f.path, { newTab: true }); } },
          icon("brush"), h("span", { class: "nt-label", text: basename(f.path).replace(/\.(leocanvas|leopaint|leovector|excalidraw)$/i, "") }), h("span", { class: "nt-sub", text: dirname(f.path) || "vault root" })))));
  }
  // the Sketch button: where a new one goes, and the recent ones under that, in one card by the button
  const ACTIONS = { daily: () => app.openDaily(), sketch: () => import("./paintmode.js").then((m) => m.drawingPortal(app, navEls.get("sketch")?.b)),
    video: () => videoPortal() };
  // the Video button: where a new project goes, and the recent ones under that
  async function videoPortal() {
    const anchor = navEls.get("video")?.b;
    const { pickFolder } = await import("./newtab.js");
    const recent = [...vault.files.values()].filter((f) => /\.leovideo$/i.test(f.path)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 30);
    const dir = await pickFolder(app, anchor, {
      title: "New video in",
      first: [app.workDir("video"), "the usual place"],
      tail: (finish) => (recent.length ? h("div", { class: "nt-recent" }, h("div", { class: "nt-head", text: "Recent" }), h("div", { class: "nt-recent-list", style: { maxHeight: 6 * 30 + "px" } },
        ...recent.map((f) => h("button", { class: "nt-item", onclick: () => { finish(null); app.openFile(f.path, { newTab: true }); } }, icon("film"), h("span", { class: "nt-label", text: basename(f.path).replace(/\.leovideo$/i, "") }), h("span", { class: "nt-sub", text: dirname(f.path) || "vault root" }))))) : null),
    });
    if (dir == null) return;
    const m = await import("./videoedit.js");
    m.newVideo(app, { dir });
  }
  const navEls = new Map();
  for (const it of navItems) {
    const badge = h("span", { class: "sb-badge" });
    const b = h("button", { class: "sb-item", draggable: true, dataset: { id: it.id, tip: it.name, keys: it.keys || "" }, onclick: (e) => ACTIONS[it.id] ? ACTIONS[it.id]() : app.openView(it.id, { newTab: e.ctrlKey }) },
      icon(it.icon), h("span", { class: "sb-label", text: it.name }), badge);
    navEls.set(it.id, { b, badge, it });
    b.addEventListener("contextmenu", (e) => navMenu(e, it));
    nav.append(b);
  }

  // Drag the buttons into any order (sidebar or ribbon); the order is a setting.
  function orderNav() {
    const order = app.settings.navOrder || [];
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 100 + navItems.findIndex((n) => n.id === id) : i; };
    for (const [id, x] of navExtras) if (!x.isConnected) navExtras.delete(id); // taken away elsewhere
    const all = [...navItems.map((it) => navEls.get(it.id).b), ...navExtras.values()];
    const idx = (b) => { const i = order.indexOf(b.dataset.id); return i < 0 ? 100 + all.indexOf(b) : i; };
    for (const b of all.sort((a, c) => idx(a) - idx(c))) nav.append(b);
  }
  // other buttons that can sit among these and be dragged like them
  const navExtras = new Map();
  app.addNavButton = (id, b) => {
    b.dataset.id = id;
    b.classList.add("sb-item", "is-extra");
    b.draggable = true;
    navExtras.set(id, b);
    nav.append(b);
    orderNav();
  };
  sortable(nav, {
    item: ".sb-item",
    onMove: (from, to) => {
      const ids = [...nav.children].map((b) => b.dataset.id);
      const [m] = ids.splice(from, 1);
      ids.splice(to, 0, m);
      app.setSetting("navOrder", ids);
      orderNav();
    },
  });
  orderNav();

  // Hidden buttons are a setting, and the last visible one can't be hidden -
  // it is the way back to the rest.
  const hiddenNav = () => new Set(app.settings.navHidden || []);
  const setHiddenNav = (s) => { app.setSetting("navHidden", [...s]); renderNav(); };

  function navMenu(e, it) {
    e.preventDefault();
    e.stopPropagation();
    const hidden = hiddenNav();
    const view = !ACTIONS[it.id];
    const sketchRows = it.id === "sketch" ? [
      { header: "New sketch in" },
      ...app.sketchFolders().map(([d, why]) => ({ label: d ? basename(d) : "Vault root", icon: d ? "folder" : "home", keys: why, run: () => app.newSketch({ dir: d }) })),
      { label: "Another folder…", icon: "search", run: () => app.newSketch({ anchor: navEls.get("sketch")?.b }) },
      (() => { const el = recentBox(3, closeMenu); return el ? { el } : null; })(),
      "sep",
    ] : [];
    const pinned = view && app.isViewPinned(it.id);
    const { clientX: x, clientY: y } = e;
    // toggling a button keeps the menu open, so several can be flipped in a row
    const again = () => navMenu({ preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y }, it);
    const flip = (id) => {
      const s = hiddenNav();
      if (s.has(id)) s.delete(id);
      else if (navItems.length - s.size > 1) s.add(id);
      else return app.toast("One button always stays, as the way back to the rest");
      setHiddenNav(s);
      again();
    };
    const order = [...nav.children].map((b) => navEls.get(b.dataset.id)?.it).filter(Boolean);
    menu(x, y, [
      // views open without a tab; right-click pins one as a tab that stays
      view ? { label: pinned ? "Unpin tab" : "Pin as tab", icon: "pin", run: () => (pinned ? app.unpinView(it.id) : app.pinView(it.id)) } : null,
      it.id === "sketch" ? null : { label: "Open in new tab", icon: "plus", run: () => (view ? app.openView(it.id, { newTab: true }) : app.openDaily(dayKey(), { newTab: true })) },
      ...sketchRows,
      { header: "Buttons shown" },
      ...order.map((n) => ({ label: n.name, icon: n.icon, checked: !hidden.has(n.id), run: () => flip(n.id) })),
      "sep",
      app.settings.navRibbon ? spacingRow() : null,
      app.settings.navRibbon
        ? { label: "Move back into the sidebar", icon: "sidebar", run: () => app.setSetting("navRibbon", false) }
        : { label: "Show as a side ribbon", icon: "sidebar", run: () => app.setSetting("navRibbon", true) },
    ]);
  }
  // how close the ribbon's buttons sit: four steps, the second is the default
  const RIBBON_GAPS = [["tight", "Tight"], ["small", "Small"], ["medium", "Medium"], ["roomy", "Roomy"]];
  const ribbonGap = () => (RIBBON_GAPS.some(([id]) => id === app.settings.ribbonGap) ? app.settings.ribbonGap : "small");
  const applyRibbonGap = () => { ribbon.dataset.gap = ribbonGap(); };
  const spacingRow = () => ({ label: "Space between buttons", icon: "list", sub: RIBBON_GAPS.map(([id, label]) => ({ label, checked: ribbonGap() === id, run: () => app.setSetting("ribbonGap", id) })) });

  // Obsidian-style ribbon: the views as an always-visible icon strip left of
  // the sidebar, so the sidebar is all files. The same buttons move there.
  const ribbonFoot = h("div", { class: "ribbon-foot", hidden: true },
    h("button", { class: "sb-item", title: "Settings (Ctrl+,)", onclick: () => app.openView("settings"), oncontextmenu: (e) => gearMenu(e) }, icon("settings")));
  // the settings button lives by the level bar; with a ribbon it can move there
  function gearMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const inRibbon = !!app.settings.settingsInRibbon;
    menu(e.clientX, e.clientY, [
      { label: "Open settings", icon: "settings", keys: "Ctrl ,", run: () => app.openView("settings") },
      app.settings.navRibbon
        ? { label: inRibbon ? "Place in the sidebar" : "Place in the ribbon", icon: "sidebar", run: () => app.setSetting("settingsInRibbon", !inRibbon) }
        : null,
    ]);
  }
  // In the ribbon a button is only an icon, so hovering shows a small card
  // with its name and shortcut, beside the strip, out of the way.
  const tipCard = h("div", { class: "rb-tip", hidden: true });
  let tipTimer = 0;
  function showTip(b) {
    const name = b.dataset.tip || b.title;
    if (!name || !app.settings.navRibbon) return;
    const keys = (b.dataset.keys || "").trim();
    tipCard.replaceChildren(h("span", { class: "rb-tip-name", text: name }), ...(keys ? [kbd(keys)] : [])); // a null child would read "null"
    tipCard.hidden = false;
    const r = b.getBoundingClientRect();
    tipCard.style.top = Math.round(r.top + r.height / 2) + "px";
    tipCard.style.left = Math.round(r.right + 8) + "px";
    requestAnimationFrame(() => tipCard.classList.add("is-in"));
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipCard.classList.remove("is-in");
    tipTimer = setTimeout(() => { tipCard.hidden = true; }, 120);
  }
  const ribbon = h("div", { class: "ribbon", hidden: true }, ribbonFoot);
  document.getElementById("overlay-root").append(tipCard);
  ribbon.addEventListener("pointerover", (e) => {
    const b = e.target.closest(".sb-item, .space-btn");
    if (!b) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(b), 260);
  });
  ribbon.addEventListener("pointerout", (e) => { if (!ribbon.contains(e.relatedTarget)) hideTip(); });
  ribbon.addEventListener("pointerdown", hideTip);
  el.parentElement.insertBefore(ribbon, el);
  function placeNav() {
    applyRibbonGap();
    const on = !!app.settings.navRibbon;
    document.getElementById("app").classList.toggle("has-ribbon", on);
    ribbon.hidden = !on;
    const gearInRibbon = on && !!app.settings.settingsInRibbon;
    ribbonFoot.hidden = !gearInRibbon;
    document.getElementById("app").classList.toggle("settings-in-ribbon", gearInRibbon);
    if (on) ribbon.prepend(nav);
    else el.prepend(nav);
  }
  ribbon.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".sb-item")) return;
    e.preventDefault();
    menu(e.clientX, e.clientY, [spacingRow(), "sep", { label: "Move back into the sidebar", icon: "sidebar", run: () => app.setSetting("navRibbon", false) }]);
  });

  function renderNav() {
    const tab = app.activeTab();
    const hidden = hiddenNav();
    for (const [id, { b, badge, it }] of navEls) {
      b.hidden = hidden.has(id);
      const active = tab && ((tab.kind === "view" && tab.view === id) || (id === "daily" && tab.kind === "note" && tab.path === app.dailyPath(dayKey())));
      b.classList.toggle("is-active", !!active);
      if (it.badge) badge.textContent = String(it.badge());
    }
  }

  /* ── pinned ─────────────────────────────────────────────────────────── */
  function renderPinned() {
    const list = (app.settings.pinned || []).filter((p) => vault.notes.has(p) || vault.files.has(p));
    pinnedSec.hidden = !list.length;
    pinned.replaceChildren(...list.map((p) => {
      const note = vault.notes.has(p);
      const f = note ? null : vault.files.get(p);
      return h("div", { class: "tree-row " + (note ? "is-note" : "is-file"), dataset: { path: p, kind: note ? "note" : "file", pin: "1" }, draggable: true, style: { paddingLeft: "10px" }, title: p },
        icon(note ? "pin" : KIND_ICON[f.kind] || "file", "tree-ico"), h("span", { class: "tree-label", text: note ? basename(p) : p.slice(p.lastIndexOf("/") + 1) }));
    }));
    markActive();
  }

  /* ── tree ───────────────────────────────────────────────────────────── */
  // Hidden paths are a plain list in settings; with none hidden this costs
  // nothing, otherwise one set lookup per path segment.
  const hiddenSet = () => new Set(app.settings.hiddenPaths || []);
  function buildIndex() {
    const kids = new Map(); // dir -> { folders:Set, notes:[] }
    const get = (d) => { if (!kids.has(d)) kids.set(d, { folders: new Set(), notes: [], files: [] }); return kids.get(d); };
    const hid = app.settings.showHidden ? new Set() : hiddenSet();
    const gone = (p) => {
      if (!hid.size) return false;
      for (let q = p; q; q = dirname(q)) if (hid.has(q)) return true;
      return false;
    };
    get("");
    for (const f of vault.folders) { if (gone(f)) continue; get(dirname(f)).folders.add(f); get(f); }
    // a folder left out of the index is not in the vault's lists, yet stays in its place in the tree, marked
    for (const f of noIdx()) if (!gone(f)) { for (let d = f; d; d = dirname(d)) { get(dirname(d)).folders.add(d); get(d); } }
    for (const n of vault.notes.values()) if (!gone(n.path)) get(n.folder).notes.push(n);
    if (app.settings.showAllFiles !== false) for (const f of vault.files.values()) if (!gone(f.path)) get(dirname(f.path)).files.push(f);
    return kids;
  }

  function setHidden(path, on) {
    const s = hiddenSet();
    on ? s.add(path) : s.delete(path);
    app.setSetting("hiddenPaths", [...s]);
    if (on && !app.settings.showHidden) app.toast(`Hidden ${basename(path) || path}`, { action: { label: "Undo", run: () => setHidden(path, false) } });
  }

  let renaming = null; // the path being renamed: redraws wait for it
  let missed = false;

  function renderTree() { keepPlace(buildTree); }
  app.bus.on("aiaccess", () => renderTree());
  function buildTree() {
    // A rename box owns the tree while it is open: every redraw - a vault
    // event, the fold-out animation finishing, anything - waits for it.
    if (renaming) {
      if (el.querySelector(".tree-edit")) { missed = true; return; }
      renaming = null;
    }
    const S = app.settings;
    const kids = buildIndex();
    const frag = document.createDocumentFragment();
    const styles = S.folderStyles || {};
    const ground = groundOf(el);
    const step = Math.max(6, Math.min(32, Number(S.treeIndent) || 14));
    const shift = S.treeFolderIcons ? 18 : 0; // a folder's icon: its name starts that much later, and so do the rows under it
    const base = Math.max(0, Math.min(32, Number(S.treeRootIndent ?? 8))); // where the whole tree starts
    const ext = S.treeShowExt || "other";
    const tagged = S.treeExtStyle !== "inline";
    tree.style.setProperty("--indent", step + "px");
    tree.classList.toggle("has-guides", !!S.treeGuides);
    tree.classList.toggle("dim-files", !!S.treeDimFiles);
    // with a filter: only matching items, and the folders on the way to them
    const words = filterQ ? filterQ.split(/\s+/) : null;
    const hit = (p) => { const nm = p.slice(p.lastIndexOf("/") + 1).toLowerCase(); return words.every((w) => nm.includes(w)); };
    // the part of a name that matched is marked - only while filtering, and
    // only on the rows that are drawn, so it costs nothing otherwise
    const label = (name) => {
      const el = h("span", { class: "tree-label" });
      if (!words) { el.textContent = name; return el; }
      const low = name.toLowerCase();
      const spans = [];
      for (const w of words) for (let i = low.indexOf(w); w && i >= 0; i = low.indexOf(w, i + w.length)) spans.push([i, i + w.length]);
      spans.sort((a, b) => a[0] - b[0]);
      let at = 0;
      for (const [a, b] of spans) {
        if (b <= at) continue;
        const from = Math.max(a, at);
        if (from > at) el.append(name.slice(at, from));
        el.append(h("mark", { class: "tree-hit", text: name.slice(from, b) }));
        at = b;
      }
      if (at < name.length) el.append(name.slice(at));
      return el;
    };
    // with "inside" on, a note also matches by what is written in it
    const inside = !!words && insideOn();
    // how many times the words stand inside a note (0 unless every word is there); counted once per note per paint
    const insideN = new Map();
    const hitInside = (p) => {
      if (!inside) return 0;
      if (insideN.has(p)) return insideN.get(p);
      const n = vault.get(p);
      let c = 0;
      if (n && n.content) {
        const t = n.lower;
        if (words.every((w) => t.includes(w))) for (const w of words) for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + w.length)) c++;
      }
      insideN.set(p, c);
      return c;
    };
    let keep = null;
    let via = null; // folders that only lead to matches: shown open
    if (words) {
      keep = new Set();
      via = new Set();
      const up = (p) => { for (let d = dirname(p); d && !via.has(d); d = dirname(d)) { via.add(d); keep.add(d); } };
      for (const [d, k] of kids) {
        for (const n of k.notes) if (hit(n.path) || hitInside(n.path)) { keep.add(n.path); up(n.path); }
        for (const f of k.files) if (hit(f.path)) { keep.add(f.path); up(f.path); }
        if (d && hit(d)) { keep.add(d); up(d); }
      }
    }
    tree.classList.toggle("is-filtered", !!words);
    const walk = (dir, depth, inherited) => {
      const k = kids.get(dir);
      if (!k) return;
      const fs = [...k.folders].filter((f) => !keep || keep.has(f)).sort((a, b) => naturalCompare(basename(a), basename(b)));
      for (const f of fs) {
        const open = expanded.has(f) || (!!via && via.has(f));
        const own = styles[f];
        const count = S.treeCounts !== false ? countNotes(kids, f) : 0;
        const row = h("div", { class: "tree-row is-folder" + (open ? " is-open" : ""), dataset: { path: f, kind: "folder" }, draggable: true, style: { paddingLeft: base + depth * step + "px", "--d": depth } },
          icon("chevron", "tree-caret"), S.treeFolderIcons ? icon("folder", "tree-ico") : null,
          label(basename(f)),
          // kept from AI agents (right-click › For AI agents)
          app.proposals && app.proposals.own(f) === "private" ? h("span", { class: "tree-ai-lock", title: "Private: AI agents don't see what is in this folder" }, icon("lock")) : null,
          noIdx().includes(f) ? h("span", { class: "tree-noindex", title: "Left out of indexing: not in search, links, the graph or AI. Right-click › Index again" }, "not indexed") : null,
          h("span", { class: "tree-count", text: count ? String(count) : "" }));
        if (ground && (own || inherited)) paintLook(row, folderLook(own, inherited, ground));
        frag.append(row);
        // a coloured folder hands its colour down, one fading step per level
        const pass = own && own.color ? (own.inherit === true ? { style: own, depth: 1 } : null)
          : inherited ? { style: inherited.style, depth: inherited.depth + 1 } : null;
        if (open) walk(f, depth + 1, pass);
      }
      // notes and other files sorted together by name, like Obsidian
      // an extension is either a tag at the right edge or part of the name
      const named = (path, base, show) => {
        const full = path.slice(path.lastIndexOf("/") + 1);
        const dot = full.lastIndexOf(".");
        const e = dot > 0 ? full.slice(dot + 1) : "";
        if (!show || !e) return { name: base, tag: "" };
        return tagged ? { name: base, tag: e } : { name: full, tag: "" };
      };
      const items = [
        ...(keep ? k.notes.filter((n) => keep.has(n.path)) : k.notes).map((n) => ({ n, ...named(n.path, n.title, ext === "all") })),
        ...(keep ? k.files.filter((f) => keep.has(f.path)) : k.files).map((f) => {
          const full = f.path.slice(f.path.lastIndexOf("/") + 1);
          const dot = full.lastIndexOf(".");
          return { f, ...named(f.path, dot > 0 ? full.slice(0, dot) : full, ext !== "none") };
        }),
      ].sort((a, b) => (app.settings.treeSort === "changed" ? ((b.n || b.f).mtime || 0) - ((a.n || a.f).mtime || 0) : 0) || naturalCompare(a.name, b.name) || naturalCompare(a.tag, b.tag));
      const tagEl = (t) => (t ? h("span", { class: "tree-ext", text: t, style: { "--c": extColor(t) } }) : null);
      for (const it of items) {
        if (it.n) {
          // found by what is written in it, not by its name: marked green
          const row = h("div", { class: "tree-row is-note" + (words && inside && !hit(it.n.path) && hitInside(it.n.path) ? " is-inside-hit" : ""), dataset: { path: it.n.path, kind: "note" }, draggable: true, style: { paddingLeft: base + depth * step + 16 + shift + "px", "--d": depth } },
            label(it.name), tagEl(it.tag));
          if (row.classList.contains("is-inside-hit")) { row.dataset.find = words[0]; row.append(h("span", { class: "tree-hits", text: String(hitInside(it.n.path)), title: "Times it stands inside this note - click to open the note on the first one" })); }
          if (styles[it.n.path]) paintLook(row, folderLook(styles[it.n.path], null, ground));
          frag.append(row);
        } else {
          const row = h("div", { class: "tree-row is-file", dataset: { path: it.f.path, kind: "file" }, draggable: true, style: { paddingLeft: base + depth * step - 2 + shift + "px", "--d": depth } },
            icon(KIND_ICON[it.f.kind] || "file", "tree-ico"), label(it.name), tagEl(it.tag));
          if (styles[it.f.path]) paintLook(row, folderLook(styles[it.f.path], null, ground));
          frag.append(row);
        }
      }
    };
    // a coloured root hands its colour to the top-level folders
    const root = rootStyle();
    walk("", 0, root.color && root.inherit === true ? { style: root, depth: 1 } : null);
    paintRoot(ground);
    if (keep && !keep.size) frag.append(h("div", { class: "tree-empty", text: "Nothing matches" }));
    if (!vault.notes.size && !vault.folders.size && !vault.files.size) {
      frag.append(h("div", { class: "tree-empty" }, "No files yet. ", h("button", { class: "link-btn", text: "Create one", onclick: () => app.newNote({}) })));
    }
    if (app.settings.showHidden) {
      const hid = hiddenSet();
      if (hid.size) for (const r of frag.querySelectorAll(".tree-row")) if (hid.has(r.dataset.path)) r.classList.add("is-hidden");
    }
    // the system folders under the vault's own (searching: their hits as one shut group)
    if (app.settings.showDotFolders && app.host.real) frag.append(dotFolders(words));
    tree.replaceChildren(frag);
    markActive();
    markPicked();
    markCursor();
  }

  /* The vault's dot-folders, for a look inside: .leonote, .trash, .obsidian.
     Listed on demand from the disk (the scanner never enters them), opened
     as files from outside the vault, never written to from here. */
  const dotOpen = new Set();
  // the listings kept: a redraw shows the rows at once from here, and the disk is asked again after,
  // redrawing only if something changed. Filled in late on every redraw, the rows pushed the whole
  // tree down by their height a moment after each fold or unfold - the jump at the top of the list
  const dotCache = new Map();
  let dotFoundOpen = false; // the system folders' hits while searching: shut until opened
  function dotFolders(words = null) {
    const box = h("div", { class: "tree-dot" });
    const fill = async (into, rel, depth) => {
      // searching: what in them has the words, each with the folder it is in
      if (words) {
        let found = [];
        try { found = await app.host.hiddenFind(words.join(" ")); } catch { found = []; }
        // what the system folders hold comes as one group, shut until it is opened, so the vault's own hits lead
        if (!found.length) { into.replaceChildren(); return; }
        const list = h("div", { class: "tree-dot-found", hidden: !dotFoundOpen });
        const head = h("div", { class: "tree-row is-dot is-folder tree-dot-head", title: "Hits in the system folders (.trash, .leonote...) - click to show or hide them",
          onclick: (e) => { e.stopPropagation(); dotFoundOpen = !dotFoundOpen; list.hidden = !dotFoundOpen; head.firstChild.replaceWith(icon(dotFoundOpen ? "chevronDown" : "chevron")); } },
          icon(dotFoundOpen ? "chevronDown" : "chevron"), icon("eye"), h("span", { class: "tree-name", text: "Hidden files" }), h("span", { class: "tree-badge", text: `${found.length} found` }));
        into.replaceChildren(head, list);
        draw(list, found, rel, 0, true);
        tree.querySelector(".tree-empty")?.remove();
        return;
      }
      if (dotCache.has(rel)) draw(into, dotCache.get(rel), rel, depth);
      let list = [];
      try { list = await app.host.hiddenList(rel); } catch { list = []; }
      const same = dotCache.has(rel) && JSON.stringify(list) === JSON.stringify(dotCache.get(rel));
      dotCache.set(rel, list);
      if (!same) draw(into, list, rel, depth);
    };
    const draw = (into, list, rel, depth, found = false) => {
      into.replaceChildren(...list.map((it) => {
        const row = h("div", { class: "tree-row is-dot" + (it.dir ? " is-folder" : " is-file"), style: { paddingLeft: 8 + depth * Math.max(6, Math.min(32, Number(app.settings.treeIndent) || 14)) + "px" }, title: it.abs,
          onclick: (e) => { e.stopPropagation(); if (it.dir) { dotOpen.has(it.path) ? dotOpen.delete(it.path) : dotOpen.add(it.path); paint(); } else app.openExternal(it.abs, { newTab: true }); },
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY, [
            { header: it.path },
            it.dir ? null : { label: "Open", icon: "file", run: () => app.openExternal(it.abs, { newTab: true }) },
            { label: "Show in Explorer", icon: "reveal", run: () => app.host.externalReveal(it.abs).catch((err) => app.toast(String(err), { kind: "error" })) },
            { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(it.abs); app.toast("Path copied", { ms: 1600 }); } },
          ].filter(Boolean)); } },
          h("span", { class: "tree-indent" }), it.dir ? icon(dotOpen.has(it.path) ? "chevronDown" : "chevron") : null, icon(it.dir ? "folder" : "file"),
          h("span", { class: "tree-name", text: it.name }), found ? h("span", { class: "tree-sys", text: it.path.slice(0, it.path.lastIndexOf("/")) }) : depth === 0 ? h("span", { class: "tree-sys", text: "system" }) : null, it.dir ? null : h("span", { class: "tree-badge", text: it.size > 1048576 ? (it.size / 1048576).toFixed(1) + " MB" : it.size > 1024 ? Math.round(it.size / 1024) + " KB" : it.size + " B" }));
        const kids = !found && it.dir && dotOpen.has(it.path) ? h("div", { class: "tree-kids" }) : null;
        if (kids) fill(kids, it.path, depth + 1);
        return kids ? h("div", {}, row, kids) : row;
      }));
    };
    const paint = () => fill(box, "", 0);
    paint();
    return h("div", { class: "tree-dot-wrap", title: "System folders - Leonote's own, the trash, Obsidian's. For looking; nothing here is changed from the tree." }, box);
  }

  const ROOT_DEFAULTS = { dim: true, inherit: false };
  const rootStyle = () => ({ ...ROOT_DEFAULTS, ...((app.settings.folderStyles || {})[""] || {}) });

  function paintRoot(ground) {
    const title = filesSec.querySelector(".sb-sec-title");
    title.removeAttribute("style");
    title.classList.remove("is-tinted");
    rootName.textContent = vaultName();
    paintLook(title, folderLook(rootStyle(), null, ground || groundOf(el)));
  }

  function customizeItem(row, path, name) {
    return { label: "Customize…", icon: "palette", run: () => customizeFolder(row, name, () => (app.settings.folderStyles || {})[path], (st) => setFolderStyle(path, st), { file: true }) };
  }

  function boardPicker(x, y, paths) {
    const list = app.boards();
    menu(x, y, [
      { header: "Add to board" },
      ...list.map((b) => ({ label: basename(b).replace(/\.canvas$/i, ""), icon: "grid", run: () => app.addToBoard(b, paths) })),
      list.length ? "sep" : null,
      { label: "New board", icon: "plus", run: () => app.newBoard({ notes: paths }) },
    ]);
  }

  /* Folders left out of the index (the setting noIndex, also in Settings › Files): not read at start, so not in
     search, links, the graph or AI - for heavy folders. Leonote reads the list as it starts. */
  const noIdx = () => (Array.isArray(app.settings.noIndex) ? app.settings.noIndex : []);
  async function setNoIndex(path, on) {
    const next = on ? [...noIdx().filter((x) => x !== path), path] : noIdx().filter((x) => x !== path);
    app.setSetting("noIndex", next);
    await app.host.noIndexSet(next).catch(() => {});
    buildTree();
    app.toast(`${on ? "Left out of indexing" : "Indexed again"}: ${basename(path)} - from the next start`, { ms: 8000, action: { label: "Restart now", run: () => app.host.restart() } });
  }

  function hideItem(path) {
    const hidden = hiddenSet().has(path);
    return { label: hidden ? "Unhide" : "Hide", icon: "eye", run: () => setHidden(path, !hidden) };
  }

  function rootMenu(x, y) {
    const nHidden = (app.settings.hiddenPaths || []).length;
    menu(x, y, [
      { header: vault.root || vaultName(), plain: true },
      { label: "New note", icon: "filePlus", keys: "Ctrl N", run: () => app.newNote({ dir: "" }) },
      { label: "New folder", icon: "folderPlus", run: () => newFolder("") },
      app.proposals ? app.proposals.menuFor("") : null,
      { label: "Paste files here", icon: "clipboard", keys: "Ctrl V", run: () => pasteFiles("") },
      "sep",
      { label: "Customize…", icon: "palette", run: () => customizeFolder(filesSec.querySelector(".sb-sec-head"), vaultName(), rootStyle, (st) => setFolderStyle("", st), { defaults: ROOT_DEFAULTS }) },
      { label: "Show in Explorer", icon: "reveal", run: () => app.reveal("") },
      { label: "Disk space…", icon: "chart", run: () => openSizes(app, "") },
      { label: "Trash - bring back what was deleted…", icon: "trash", run: () => app.openTrash() },
      { label: expanded.size ? "Collapse all folders" : "Expand all folders", icon: "chevronDown", run: () => toggleAll() },
      { label: "Sort files", icon: "clock", sub: [["name", "By name"], ["changed", "Newest changed first"]].map(([v, label]) => ({ label, checked: (app.settings.treeSort || "name") === v, run: () => app.setSetting("treeSort", v) })) },
      { label: "Row height", icon: "settings", sub: [["compact", "Compact"], ["snug", "Snug"], ["cozy", "Cozy"], ["roomy", "Roomy"]].map(([v, label]) => ({ label, checked: app.settings.treeRowHeight === v, run: () => app.setSetting("treeRowHeight", v) })) },
      { label: "Phone button", icon: "phone", checked: app.settings.treePhoneButton !== false, run: () => app.setSetting("treePhoneButton", app.settings.treePhoneButton === false) },
      { label: "Folder icons", icon: "folder", checked: !!app.settings.treeFolderIcons, run: () => app.setSetting("treeFolderIcons", !app.settings.treeFolderIcons) },
      nHidden ? { label: `Show hidden items (${nHidden})`, icon: "eye", checked: !!app.settings.showHidden, run: () => app.setSetting("showHidden", !app.settings.showHidden) } : null,
    ]);
  }
  filesSec.querySelector(".sb-sec-head").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    rootMenu(e.clientX, e.clientY);
  });

  function paintLook(row, look) {
    for (const [k, v] of Object.entries(look)) {
      if (k.startsWith("--")) row.style.setProperty(k, v);
      else row.style[k] = v;
    }
    if (look.background) row.classList.add("is-tinted");
  }

  function setFolderStyle(path, style) {
    const all = { ...(app.settings.folderStyles || {}) };
    if (style) all[path] = style;
    else delete all[path];
    app.setSetting("folderStyles", all);
  }

  // Ctrl+Shift+N: the folder last clicked in the tree, else the open note's
  function contextFolder() {
    if (lastFolder !== null && (lastFolder === "" || vault.folders.has(lastFolder))) return lastFolder;
    const cur = app.currentPath();
    return cur ? dirname(cur) : "";
  }

  // what was open before the last Collapse all - Expand all brings it back (memory only)
  let openBefore = [];
  function toggleAll() {
    if (expanded.size) { openBefore = [...expanded]; expanded.clear(); }
    else for (const f of foldersToExpand(openBefore, app.settings.treeExpandAll, vault.folders)) expanded.add(f);
    app.setSetting("expanded", [...expanded]);
    renderTree();
  }

  function markCursor() {
    for (const r of tree.querySelectorAll(".tree-row.is-cursor")) r.classList.remove("is-cursor");
    if (cursor === null) return;
    const row = [...tree.querySelectorAll(".tree-row")].find((r) => r.dataset.path === cursor);
    if (row) row.classList.add("is-cursor");
  }

  // each folder counted once per tree build (the index is new each build), not again by every folder above it
  const counted = new WeakMap();
  function countNotes(kids, dir) {
    let memo = counted.get(kids);
    if (!memo) counted.set(kids, (memo = new Map()));
    if (memo.has(dir)) return memo.get(dir);
    const k = kids.get(dir);
    let c = k ? k.notes.length + k.files.length : 0;
    if (k) for (const f of k.folders) c += countNotes(kids, f);
    memo.set(dir, c);
    return c;
  }

  function markActive() {
    const t = app.activeTab();
    // an HTML file shown as a page holds its file:/// address: back to its vault path, or its path on disk (an outpost)
    const cur = !t || t.kind === "view" ? null : t.kind === "web" ? (app.vaultPathOfUrl && app.vaultPathOfUrl(t.path)) || (app.currentExternal && app.currentExternal()) : t.path;
    for (const r of el.querySelectorAll(".tree-row.is-active")) r.classList.remove("is-active");
    if (!cur) return;
    const same = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
    const want = same(cur); // once, not once per row
    for (const r of el.querySelectorAll(".tree-row.is-note, .tree-row.is-file")) if (r.dataset.path === cur || same(r.dataset.path) === want) r.classList.add("is-active");
  }

  // While a name is being typed, a rebuild would yank the box away mid-word,
  // so redraws wait for it and run once it is finished either way.
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; keepPlace(() => { renderTree(); renderPinned(); renderNav(); }); });
  }
  /* A redraw never moves the list under you: the first row in sight is noted
     with where it sits on screen, and after the redraw the list is scrolled so
     that same row sits there again - in the same frame, so nothing flickers,
     whatever grew or shrank above it (pinned notes, a file saved by rename). */
  function keepPlace(fn) {
    const sc = el.querySelector(".sb-scroll");
    if (!sc || !sc.scrollTop) return fn();
    const top = sc.getBoundingClientRect().top;
    // the first row in sight, and the rows above it in case that one is gone after the redraw
    // (it was inside a folder that closed): the nearest survivor above holds the place instead
    const rows = [...tree.children].filter((r) => r.dataset && r.dataset.path);
    let i = rows.findIndex((r) => r.getBoundingClientRect().bottom > top);
    if (i < 0) return fn();
    const anchors = [];
    for (let k = i; k >= 0 && anchors.length < 12; k--) anchors.push({ path: rows[k].dataset.path, at: rows[k].getBoundingClientRect().top });
    fn();
    for (const a of anchors) {
      const r = tree.querySelector(`.tree-row[data-path="${CSS.escape(a.path)}"]`);
      if (!r) continue;
      const d = r.getBoundingClientRect().top - a.at;
      if (Math.abs(d) > 0.5) sc.scrollTop += d;
      return;
    }
  }
  function endRename() {
    renaming = null;
    if (missed) { missed = false; schedule(); }
  }

  /* A folder's rows are contiguous in the flat tree, which is what makes both
     of these cheap: opening stages the new rows in, closing lifts them into
     one box and shuts its height. The expanded set changes either way first -
     the animation never owns the state. */
  function revealUnder(path) {
    if (!motionFull()) return;
    const pre = path + "/";
    // a big folder opens at once: rows sliding in one after another over a long list read as a jitter, not a reveal
    const under = [...tree.querySelectorAll(".tree-row")].filter((r) => r.dataset.path && r.dataset.path.startsWith(pre));
    if (under.length > 8) return;
    let i = 0;
    for (const r of under) {
      r.classList.add("is-reveal");
      r.style.setProperty("--i", String(i++));
    }
    if (!i) return;
    setTimeout(() => {
      for (const r of tree.querySelectorAll(".tree-row.is-reveal")) { r.classList.remove("is-reveal"); r.style.removeProperty("--i"); }
    }, 320);
  }

  /** How long a fold box takes, from its own transition (the motion level sets it): the box is let go only after. */
  const foldMs = (box) => (parseFloat(getComputedStyle(box).transitionDuration) || 0) * 1000 + 30;
  function foldOut(path) {
    if (!motionFull()) return false;
    const pre = path + "/";
    const kids = [...tree.querySelectorAll(".tree-row")].filter((r) => r.dataset.path && r.dataset.path.startsWith(pre));
    if (!kids.length || kids.length > 60) return false; // a huge subtree just goes
    const row = [...tree.querySelectorAll(".tree-row")].find((r) => r.dataset.path === path);
    if (row) row.classList.remove("is-open"); // the caret turns at once
    const box = h("div", { class: "tree-fold" });
    kids[0].before(box);
    box.append(...kids);
    box.style.height = box.offsetHeight + "px";
    requestAnimationFrame(() => { box.style.height = "0px"; box.style.opacity = "0"; });
    setTimeout(() => { box.remove(); renderTree(); }, foldMs(box));
    return true;
  }

  function toggleFolder(path, force) {
    const open = force ?? !expanded.has(path);
    const closing = [];
    if (open && app.settings.treeAccordion) {
      // one folder open at a time: close the siblings and everything in them
      const parent = dirname(path);
      for (const f of [...expanded]) {
        if (f === path || dirname(f) !== parent) continue;
        closing.push(f);
        for (const g of [...expanded]) if (g === f || g.startsWith(f + "/")) expanded.delete(g);
      }
    }
    open ? expanded.add(path) : expanded.delete(path);
    app.setSetting("expanded", [...expanded]);
    if (!open && foldOut(path)) return; // renderTree runs when the fold finishes
    // siblings the accordion closes shut with the same fold as a closed folder, while the new rows come in
    const folds = motionFull() ? closing.map((f) => [f, [...tree.querySelectorAll(".tree-row")].filter((r) => r.dataset.path && r.dataset.path.startsWith(f + "/"))]).filter(([, rows]) => rows.length && rows.length <= 60) : [];
    renderTree();
    for (const [f, rows] of folds) {
      const head = [...tree.querySelectorAll(".tree-row")].find((r) => r.dataset.path === f);
      if (!head) continue;
      const box = h("div", { class: "tree-fold" });
      box.append(...rows);
      head.after(box);
      box.style.height = box.offsetHeight + "px";
      requestAnimationFrame(() => { box.style.height = "0px"; box.style.opacity = "0"; });
      setTimeout(() => box.remove(), foldMs(box));
    }
    if (open && !unfoldIn(path)) revealUnder(path);
  }

  /* A folder opening grows its rows out of the folder's row, the mirror of
     foldOut: what sits below slides down instead of jumping by the whole
     subtree at once. The rows sit in a box for the 200 ms and are then let
     out; a redraw meanwhile simply draws them plain. */
  function unfoldIn(path) {
    if (!motionFull()) return false;
    const pre = path + "/";
    const kids = [...tree.querySelectorAll(".tree-row")].filter((r) => r.dataset.path && r.dataset.path.startsWith(pre));
    if (!kids.length || kids.length > 60) return false;
    const box = h("div", { class: "tree-fold" });
    kids[0].before(box);
    box.append(...kids);
    const full = box.offsetHeight;
    box.style.height = "0px";
    box.style.opacity = "0";
    requestAnimationFrame(() => { box.style.height = full + "px"; box.style.opacity = "1"; });
    setTimeout(() => { if (box.isConnected) box.replaceWith(...box.childNodes); }, foldMs(box));
    return true;
  }

  /* The browser's smooth scroll takes as long as the list is long - over a
     second in a big vault. Here the far part of the way is a jump and only
     the last stretch glides, 140ms whatever the distance; with animations off
     (or reduced) the row is simply there. */
  function glideTo(row) {
    let sc = row.parentElement;
    while (sc && sc !== el && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    if (!sc) return row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    const box = sc.getBoundingClientRect();
    if (r.top >= box.top + 40 && r.bottom <= box.bottom - 40) return; // in plain sight already
    const to = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, sc.scrollTop + (r.top + r.height / 2) - (box.top + box.height / 2)));
    if (!motionFull()) { sc.scrollTop = to; return; }
    const glide = Math.sign(to - sc.scrollTop) * Math.min(Math.abs(to - sc.scrollTop), 120);
    const from = to - glide;
    sc.scrollTop = from;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 140);
      sc.scrollTop = from + glide * (1 - Math.pow(1 - k, 3));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Find `path` in the tree; `open`: a folder is opened too. */
  function reveal(path, open = false) {
    let d = dirname(path);
    let changed = false;
    if (open && !expanded.has(path)) { expanded.add(path); changed = true; }
    while (d) { if (!expanded.has(d)) { expanded.add(d); changed = true; } d = dirname(d); }
    if (changed) { app.setSetting("expanded", [...expanded]); renderTree(); }
    const row = [...tree.querySelectorAll(".tree-row")].find((r) => r.dataset.path === path);
    if (!row) return;
    glideTo(row);
    cursor = path;
    markCursor();
    // a short sweep of light so the eye lands on the right row
    row.classList.remove("is-found");
    void row.offsetWidth;
    row.classList.add("is-found");
    setTimeout(() => row.classList.remove("is-found"), 2000);
  }

  let makingFolder = false;
  async function newFolder(parent) {
    // A folder that is still being named is the one being made: the key held
    // or pressed again must not leave a row of "New folder 1, 2, 3" behind.
    // The name box simply gets the keys back.
    const box = el.querySelector(".inline-edit");
    if (makingFolder || box) { if (box && box.focus) { box.focus(); if (box.select) box.select(); } return; }
    makingFolder = true;
    try { await newFolderNow(parent); } finally { makingFolder = false; }
  }
  async function newFolderNow(parent) {
    let name = "New folder";
    for (let i = 1; vault.folders.has(joinPath(parent, name)); i++) name = `New folder ${i}`;
    const path = joinPath(parent, name);
    await vault.createFolder(path);
    if (parent) expanded.add(parent);
    renderTree();
    // creating the folder queued a redraw for the next frame, which would
    // rebuild the row out from under the rename box; open it after that
    await new Promise((r) => requestAnimationFrame(r));
    startRename(path, "folder");
  }

  /** A new folder where this one is, with this one moved inside it - then named. */
  async function newParent(path) {
    const parent = dirname(path);
    let name = "New folder";
    for (let i = 1; vault.folders.has(joinPath(parent, name)); i++) name = `New folder ${i}`;
    const np = joinPath(parent, name);
    await vault.createFolder(np);
    await app.renameFolder(path, basename(path), np);
    expanded.add(np);
    app.setSetting("expanded", [...expanded]);
    renderTree();
    await new Promise((r) => requestAnimationFrame(r));
    startRename(np, "folder");
  }

  function startRename(path, kind) {
    const row = [...el.querySelectorAll(".tree-row")].find((r) => r.dataset.path === path && r.dataset.kind === kind);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    const label = row.querySelector(".tree-label");
    row.draggable = false;
    renaming = path;
    // the name comes up selected, so typing replaces it; the extension stays
    const mirror = (v) => app.renameMirror && app.renameMirror(path, v);
    const input = inlineEdit(label, basename(path), {
      className: "tree-edit",
      selectBase: true,
      onCommit: async (name) => {
        mirror(false);
        endRename();
        await (kind === "folder" ? app.renameFolder(path, name) : kind === "file" ? app.renameFile(path, name) : app.renameNote(path, name));
        const to = joinPath(dirname(path), kind === "folder" ? name : name + (path.slice(path.lastIndexOf("/") + 1).match(/\.[^.]+$/) || [""])[0]);
        cursor = to;
        requestAnimationFrame(() => { markCursor(); tree.focus({ preventScroll: true }); });
        // the new name may sort it far away: bring it into view, where you are about to work
        const show = () => { const r = [...el.querySelectorAll(".tree-row")].find((x) => x.dataset.path === to); if (r) r.scrollIntoView({ block: "nearest" }); return !!r; };
        requestAnimationFrame(() => { if (!show()) setTimeout(show, 250); });
      },
      onCancel: () => { mirror(null); endRename(); row.draggable = true; tree.focus({ preventScroll: true }); },
    });
    // the note's title, if it is open, lights up with it and follows what is typed
    mirror(input.value);
    input.addEventListener("input", () => mirror(input.value));
    // the name comes up selected, and pressing on selected text drags it: let go of the selection first, so a
    // press-and-move here always selects a piece of the name
    input.addEventListener("mousedown", () => { if (input.selectionStart !== input.selectionEnd) input.setSelectionRange(input.selectionEnd, input.selectionEnd); });
  }
  /** The title being renamed: its row lights up and shows the name as it is typed; null puts it back. */
  function markRenaming(path, value) {
    const row = [...el.querySelectorAll(".tree-row")].find((r) => r.dataset.path === path);
    const label = row && row.querySelector(".tree-label");
    if (!label) return;
    label.classList.toggle("is-mirror", value != null);
    label.textContent = value != null ? value : basename(path);
  }

  /* ── events (delegated) ─────────────────────────────────────────────── */
  const rowOf = (e) => e.target.closest(".tree-row");

  // Several files and folders at once, like Explorer: Ctrl+click adds or
  // removes one, Shift+click picks a range, Ctrl+Shift+click adds a range.
  // Right-click a picked row, or drag it, to act on all of them.
  const picked = new Map(); // path -> kind
  const rowsOf = () => [...tree.querySelectorAll(".tree-row")];
  function markPicked() {
    for (const r of el.querySelectorAll(".tree-row.is-picked")) r.classList.remove("is-picked");
    // while rows are picked, the open file's own highlight steps back: what
    // Delete would take is then the only thing that looks taken
    el.classList.toggle("has-picked", picked.size > 0);
    if (!picked.size) return;
    for (const r of rowsOf()) if (picked.get(r.dataset.path) === r.dataset.kind) r.classList.add("is-picked");
  }
  function clearPicked() { if (picked.size) { picked.clear(); markPicked(); } }
  let pickAnchor = null;
  function pickRows(row, range, keep) {
    const rows = rowsOf();
    if (range) {
      if (!keep) picked.clear();
      const a = rows.findIndex((r) => r.dataset.path === (pickAnchor ?? cursor));
      const b = rows.indexOf(row);
      if (a < 0 || b < 0) picked.set(row.dataset.path, row.dataset.kind);
      else for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.set(r.dataset.path, r.dataset.kind);
    } else if (picked.has(row.dataset.path)) picked.delete(row.dataset.path);
    else {
      // the row the cursor was on joins in, as in Explorer - but not when it is
      // merely the file that is open: open is not picked, and Delete must not
      // take a note along that nobody chose
      if (!picked.size && cursor != null) { const c = rows.find((r) => r.dataset.path === cursor); if (c && !c.classList.contains("is-active")) picked.set(c.dataset.path, c.dataset.kind); }
      picked.set(row.dataset.path, row.dataset.kind);
    }
    if (!range) pickAnchor = row.dataset.path;
    cursor = row.dataset.path;
    markCursor();
    markPicked();
  }
  // a picked folder already carries what is inside it
  const pickedTop = () => {
    const all = [...picked];
    return all.filter(([p]) => !all.some(([q, k]) => k === "folder" && q !== p && p.startsWith(q + "/")));
  };
  function pickedMenu(x, y, row) {
    const items = pickedTop();
    const docs = items.filter(([, k]) => k !== "folder");
    const notes = items.filter(([, k]) => k === "note").map(([p]) => p);
    const folders = items.filter(([, k]) => k === "folder").map(([p]) => p);
    const n = items.length;
    const moveAll = async (dir) => {
      for (const [p, k] of items) {
        if (k === "note") { if (dirname(p) !== dir) await app.moveNote(p, dir); }
        else if (k === "file") { if (dirname(p) !== dir) await app.moveFile(p, dir); }
        else if (dir !== p && !dir.startsWith(p + "/") && dirname(p) !== dir) await app.renameFolder(p, basename(p), dir);
      }
      clearPicked();
    };
    menu(x, y, [
      { header: `${n} selected`, plain: true },
      docs.length ? { label: `Open ${docs.length} in tabs`, icon: "plus", run: () => { for (const [p, k] of docs.slice(0, 20)) k === "note" ? app.openNote(p, { newTab: true }) : app.openFile(p, { newTab: true }); } } : null,
      docs.length && app.openSplit ? { label: "Open side by side", icon: "columns", run: () => app.openSplit(docs.slice(0, 12).map(([p]) => p)) } : null,
      notes.length ? { label: "Add notes to research board…", icon: "grid", run: () => boardPicker(x, y, notes.slice(0, 60)) } : null,
      docs.length ? { label: "Pin", icon: "pin", run: () => { const s = new Set(app.settings.pinned || []); for (const [p] of docs) s.add(p); app.setSetting("pinned", [...s]); } } : null,
      docs.some(([p]) => (app.settings.pinned || []).includes(p)) ? { label: "Unpin", icon: "pin", run: () => { const off = new Set(docs.map(([p]) => p)); app.setSetting("pinned", (app.settings.pinned || []).filter((p) => !off.has(p))); } } : null,
      notes.length ? { label: `Copy ${notes.length === 1 ? "link" : notes.length + " links"}`, icon: "link", run: () => navigator.clipboard.writeText(notes.map((p) => `- [[${vault.linkText(p)}]]`).join("\n") + "\n").then(() => app.toast("Copied", { ms: 1400 })) } : null,
      "sep",
      docs.length ? { label: `Search in these ${docs.length} files…`, icon: "search", run: () => app.openSearch({ paths: docs.map(([p]) => p) }) } : null,
      { label: "Move to…", icon: "folder", run: () => openPalette(app, "move", { onPick: moveAll }) },
      folders.length ? { label: `Customize ${folders.length === 1 ? "folder" : folders.length + " folders"}…`, icon: "palette", run: () => customizeFolder(row, `${folders.length} folders`, () => (app.settings.folderStyles || {})[folders[0]], (st) => { for (const f of folders) setFolderStyle(f, st); }) } : null,
      folders.length ? { label: "Expand all", icon: "chevronDown", run: () => { for (const f of folders) expanded.add(f); app.setSetting("expanded", [...expanded]); schedule(); } } : null,
      { label: "Hide", icon: "eye", run: () => { const s = hiddenSet(); for (const [p] of items) s.add(p); app.setSetting("hiddenPaths", [...s]); clearPicked(); } },
      "sep",
      { label: `Move ${n} to trash`, icon: "trash", danger: true, keys: "Del", run: async () => { await app.trashItems(items); clearPicked(); } },
      { label: "Clear selection", icon: "minus", keys: "Esc", run: clearPicked },
    ]);
  }
  tree.addEventListener("keydown", (e) => { if (e.key === "Escape" && picked.size) { e.preventDefault(); clearPicked(); } });
  // a click anywhere else lets the picked rows go (a menu or a dialog over them does not)
  document.addEventListener("mousedown", (e) => { if (picked.size && !tree.contains(e.target) && !e.target.closest(".menu, .dlg-back, .pal-back, #corner-cards")) clearPicked(); }, true);

  // a second click counts as a double-click (rename) only this quickly - shorter than Windows' own
  // double-click time, so a slower pair of clicks folds and unfolds instead
  const RENAME_MS = 320;
  const FOLDER_RENAME_MS = 450; // two clicks on a folder this close together: it folds and unfolds, and is renamed
  let lastClick = { path: null, at: 0 }, quickPair = false;
  // A redraw between the press and the release (a fold finishing, a file saved) replaces the pressed
  // row, and the browser then sends no click at all: the release over the same row stands in for it
  let pressed = null;
  el.addEventListener("mousedown", (e) => { const r = e.button === 0 && rowOf(e); pressed = r && r.dataset.path ? { el: r, path: r.dataset.path } : null; }, true);
  el.addEventListener("mouseup", (e) => {
    const p = pressed;
    pressed = null;
    if (!p || e.button !== 0 || p.el.isConnected) return;
    const r = rowOf(e);
    if (!r || r.dataset.path !== p.path) return;
    onRowClick({ target: r, detail: e.detail, timeStamp: e.timeStamp, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, preventDefault: () => {} });
  });
  el.addEventListener("click", (e) => onRowClick(e));
  function onRowClick(e) {
    const row = rowOf(e);
    if (!row || e.target.closest(".inline-edit")) return;
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && row.closest(".tree")) {
      e.preventDefault();
      getSelection().removeAllRanges();
      pickRows(row, e.shiftKey, e.ctrlKey || e.metaKey);
      tree.focus({ preventScroll: true });
      return;
    }
    clearPicked();
    pickAnchor = row.dataset.path;
    const { path, kind } = row.dataset;
    armed = row.closest(".tree") ? { path, kind } : null;
    if (filterQ && armed) filterPick = path;
    lastFolder = kind === "folder" ? path : dirname(path);
    cursor = path;
    markCursor();
    // the second click of a double-click belongs to the rename, not to opening
    // the note again or folding the folder back up
    // a folder: every click folds or unfolds, however fast they come, and a double-click also renames it
    const gap = e.timeStamp - lastClick.at;
    const pair = e.detail > 1 && lastClick.path === path;
    // a folder goes by Windows' own double-click (its speed is the user's setting): the two clicks fold and unfold, so it is left as it was
    quickPair = pair && gap < RENAME_MS;
    // a folder: every click folds or unfolds; a second click on it soon enough also renames it. Timed here,
    // not by the browser's double-click - the first click redraws the tree, and the browser then no longer
    // counts the second as a double-click
    const folderPair = kind === "folder" && lastClick.path === path && gap < FOLDER_RENAME_MS && !filterQ;
    lastClick = folderPair ? { path: null, at: 0 } : { path, at: e.timeStamp };
    if (folderPair && row.closest(".tree")) requestAnimationFrame(() => startRename(path, "folder"));
    if (quickPair && kind !== "folder") { if (row.closest(".tree")) tree.focus({ preventScroll: true }); return; }
    // a folder picked from the search results is the one wanted: it opens (never folds) and the tree comes back around it
    if (kind === "folder" && filterQ && row.closest(".tree")) { expanded.add(path); app.setSetting("expanded", [...expanded]); closeFilter(); return; }
    if (kind === "folder") { toggleFolder(path); if (row.closest(".tree")) tree.focus({ preventScroll: true }); }
    else if (e.altKey && app.openSplit) app.openSplit(path);
    else if (kind === "file") app.openFile(path);
    else app.openNote(path, row.dataset.find ? { find: row.dataset.find } : {});
  }
  // A name that does not fit shows whole, at once, over its own row (the
  // browser's own tooltip takes a second and sits somewhere else).
  let nameTip = null;
  let nameTipT = 0;
  const dropNameTip = () => { clearTimeout(nameTipT); if (nameTip) { nameTip.remove(); nameTip = null; } };
  el.addEventListener("mouseover", (e) => {
    const row = rowOf(e);
    const label = row && row.querySelector(".tree-label");
    if (nameTip && nameTip._row === row) return;
    dropNameTip();
    if (!label || label.scrollWidth <= label.clientWidth + 1 || row.querySelector(".inline-edit")) return;
    nameTipT = setTimeout(() => {
      if (!row.isConnected || !row.matches(":hover")) return;
      const r = label.getBoundingClientRect();
      const p = row.dataset.path || "";
      const ext = row.dataset.kind === "file" && p.includes(".") ? p.slice(p.lastIndexOf(".")) : "";
      nameTip = h("div", { class: "tree-nametip", text: label.textContent + (label.textContent.endsWith(ext) ? "" : ext) });
      nameTip._row = row;
      const cs = getComputedStyle(label);
      Object.assign(nameTip.style, { left: r.left - 7 + "px", top: r.top - 3 + "px", minHeight: r.height + 6 + "px", font: cs.font, maxWidth: Math.max(240, innerWidth - r.left - 16) + "px" });
      document.getElementById("overlay-root").append(nameTip);
    }, 90);
  });
  el.addEventListener("mouseleave", dropNameTip);
  for (const ev of ["mousedown", "wheel", "dragstart", "contextmenu"]) el.addEventListener(ev, dropNameTip, true);

  el.addEventListener("dblclick", (e) => {
    const row = rowOf(e);
    if (!row || e.shiftKey || e.ctrlKey || e.altKey || e.target.closest(".inline-edit") || row.dataset.pin) return;
    if (!quickPair || row.dataset.kind === "folder") return; // two slower clicks; a folder renames from its clicks
    e.preventDefault();
    const { path, kind } = row.dataset;
    getSelection().removeAllRanges();
    requestAnimationFrame(() => startRename(path, kind));
  });
  // The middle button is for scrolling the list (the webview's autoscroll).
  // It used to open whatever row happened to be under it in a new tab as
  // well; Ctrl+click and the row menu open in a new tab.
  el.addEventListener("auxclick", (e) => { if (e.button === 1 && rowOf(e)) e.preventDefault(); });

  el.addEventListener("contextmenu", (e) => {
    const row = rowOf(e);
    const inTree = e.target.closest(".tree, .sb-sec-body");
    if (!row && !inTree) return;
    e.preventDefault();
    if (row && filterQ && row.closest(".tree")) filterPick = row.dataset.path;
    if (!row) {
      rootMenu(e.clientX, e.clientY);
      return;
    }
    const { path, kind } = row.dataset;
    if (picked.size > 1 && picked.has(path)) return pickedMenu(e.clientX, e.clientY, row);
    clearPicked();
    lastFolder = kind === "folder" ? path : dirname(path);
    if (kind === "folder") {
      menu(e.clientX, e.clientY, [
        { label: "New note here", icon: "filePlus", run: () => { expanded.add(path); app.newNote({ dir: path }); } },
        { label: "New subfolder (inside)", icon: "folderPlus", keys: "Ctrl Shift N", run: () => newFolder(path) },
        { label: "New parent folder (around it)", icon: "folder", run: () => newParent(path) },
        { label: "New research board here", icon: "grid", run: () => app.newBoard({ dir: path }) },
        { label: "New sketch here", icon: "brush", run: () => app.newSketch({ dir: path }) },
        { label: "New drawing here", icon: "palette", run: () => import("./paintmode.js").then((m) => m.newDrawing(app, { dir: path })) },
        hiddenNav().has("video") ? null : { label: "New video project here", icon: "film", run: () => import("./videoedit.js").then((m) => m.newVideo(app, { dir: path })) },
        { label: "Paste files here", icon: "clipboard", keys: "Ctrl V", run: () => pasteFiles(path) },
        app.zettel ? { label: "Map of this folder's notes", icon: "map", run: () => app.zettel.newMoc({ title: `${path}/${basename(path)} map`, links: [...vault.notes.keys()].filter((n) => dirname(n) === path).map((n) => vault.linkText(n)) }) } : null,
        { label: "Board of this folder's notes", icon: "grid", run: () => app.newBoard({ name: basename(path), notes: [...vault.notes.keys()].filter((n) => dirname(n) === path).slice(0, 60) }) },
        { label: "Search in this folder…", icon: "search", run: () => app.openSearch({ folder: path }) },
        { label: "Disk space…", icon: "chart", run: () => openSizes(app, path) },
        app.proposals ? app.proposals.menuFor(path) : null,
        app.projectAt(path)
          ? { label: "Open its workspace room", icon: "briefcase", keys: "Alt R", run: () => app.openRoom(path) }
          : { label: "Make it a workspace", icon: "briefcase", run: () => app.makeProject(path) },
        "sep",
        { label: "Customize…", icon: "palette", run: () => customizeFolder(row, basename(path), () => (app.settings.folderStyles || {})[path], (st) => setFolderStyle(path, st)) },
        hideItem(path),
        noIdx().includes(path)
          ? { label: "Index again", icon: "search", run: () => setNoIndex(path, false) }
          : { label: "Leave out of indexing (app load speed)", icon: "search", run: () => setNoIndex(path, true) },
        { label: "Rename", icon: "edit", keys: "F2", run: () => startRename(path, "folder") },
        { label: "Copy", icon: "clipboard", keys: "Ctrl C", run: () => copyRows([[path, "folder"]]) },
        { label: "Duplicate", icon: "layers", keys: "Ctrl D", run: () => duplicate([[path, "folder"]]) },
        // not into itself or a folder inside it
        { label: "Move to…", icon: "folder", run: () => openPalette(app, "move", { onPick: (dir) => { if (dir !== path && !dir.startsWith(path + "/") && dirname(path) !== dir) app.renameFolder(path, basename(path), dir); } }) },
        clip ? { label: `Paste ${clip.length === 1 ? `“${basename(clip[0][0])}”` : `${clip.length} items`} here`, icon: "clipboard", keys: "Ctrl V", run: () => copyInto(clip, path) } : null,
        { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(path) },
        "sep",
        { label: "Move to trash", icon: "trash", danger: true, keys: "Del", title: "Shift+Del deletes for good", run: () => app.trashFolder(path) },
      ]);
    } else if (kind === "file") {
      const name = path.slice(path.lastIndexOf("/") + 1);
      menu(e.clientX, e.clientY, [
        { label: "Open", icon: "file", run: () => app.openFile(path) },
        { label: "Open in new tab", icon: "plus", run: () => app.openFile(path, { newTab: true }) },
        { label: "Open to the side", icon: "columns", keys: "Alt Click", run: () => app.openSplit(path) },
        { label: "Open in default app", icon: "reveal", run: () => app.host.openPath(path).catch((err) => app.toast(String(err), { kind: "error" })) },
        /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(path) ? { label: "Open in Studio", icon: "palette", run: () => import("./paintmode.js").then((m) => m.openPhotoInStudio(app, path)) } : null,
        { label: (app.settings.pinned || []).includes(path) ? "Unpin" : "Pin", icon: "pin", run: () => app.togglePin(path) },
        "sep",
        { label: "Rename", icon: "edit", run: () => startRename(path, "file") },
        { label: "Copy", icon: "clipboard", keys: "Ctrl C", run: () => copyRows([[path, "file"]]) },
        { label: "Duplicate", icon: "layers", keys: "Ctrl D", run: () => duplicate([[path, "file"]]) },
        { label: "Move to…", icon: "folder", run: () => openPalette(app, "move", { onPick: (dir) => { if (dirname(path) !== dir) app.moveFile(path, dir); } }) },
        { label: "Copy embed link", icon: "link", run: () => navigator.clipboard.writeText(`![[${name}]]`).then(() => app.toast("Copied", { ms: 1400 })) },
        customizeItem(row, path, name),
        hideItem(path),
        { label: "Where it is used…", icon: "link", run: () => { const r = row.getBoundingClientRect(); app.showUsedIn(path, r.right + 6, r.top); } },
        { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(path) },
        "sep",
        { label: "Move to trash", icon: "trash", danger: true, keys: "Del", run: () => app.trashFile(path) },
      ]);
    } else {
      const isPinned = (app.settings.pinned || []).includes(path);
      menu(e.clientX, e.clientY, [
        { label: "Open in new tab", icon: "plus", run: () => app.openNote(path, { newTab: true }) },
        { label: "Open to the side", icon: "columns", keys: "Alt Click", run: () => app.openSplit(path) },
        { label: "Add to research board…", icon: "grid", run: () => boardPicker(e.clientX, e.clientY, [path]) },
        // a window to read it from while recording: large type, scrolling by itself, hidden from screen capture
        app.settings.scriptMenu !== false ? { label: "Read as script", icon: "play", run: () => app.readAsScript(path) } : null,
        { label: isPinned ? "Unpin" : "Pin", icon: "pin", run: () => app.togglePin(path) },
        "sep",
        { label: "Rename", icon: "edit", keys: "F2", run: () => startRename(path, "note") },
        { label: "Copy", icon: "clipboard", keys: "Ctrl C", run: () => copyRows([[path, "note"]]) },
        { label: "Duplicate", icon: "layers", keys: "Ctrl D", run: () => duplicate([[path, "note"]]) },
        { label: "Move to…", icon: "folder", run: () => openPalette(app, "move", { path }) },
        { label: "Copy link", icon: "link", run: () => navigator.clipboard.writeText(`[[${vault.linkText(path)}]]`).then(() => app.toast("Copied", { ms: 1400 })) },
        customizeItem(row, path, basename(path)),
        hideItem(path),
        { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(path) },
        "sep",
        { label: "Move to trash", icon: "trash", danger: true, keys: "Del", run: () => app.trashNote(path) },
        { label: "Delete for good, with its history…", icon: "trash", danger: true, run: () => import("./noteversions.js").then((m) => m.eraseTraces(app, path, { andNote: true })) },
      ]);
    }
  });

  /* The row you just clicked stays "in hand" although opening it puts the
     caret in the note, where it was, ready to type: the FIRST Delete asks to
     trash the file - a note, a board, a picture, anything - and the first
     Shift+Delete asks about deleting it for good. Only that first key: a
     click anywhere else, any other key (so, any typing), or leaving the
     window lets go, and from then on Delete is the text's. */
  let armed = null;
  document.addEventListener("pointerdown", (e) => { if (armed && !el.contains(e.target)) armed = null; }, true);
  window.addEventListener("blur", () => { armed = null; });
  document.addEventListener("keydown", (e) => {
    if (!armed) return;
    // F2 after a click on a row renames it here, in the tree - click, F2, type, Enter, and on to the next
    if (e.key === "F2" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !(e.target.closest && e.target.closest("input, textarea, select, .inline-edit"))) {
      const a = armed;
      armed = null;
      e.preventDefault();
      e.stopPropagation();
      startRename(a.path, a.kind);
      return;
    }
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (mod && ["KeyC", "KeyV", "KeyD"].includes(e.code) && !(e.target.closest && e.target.closest("input, textarea, select, .inline-edit"))) {
      const a = armed;
      const items = picked.size > 1 && picked.has(a.path) ? pickedTop() : [[a.path, a.kind]];
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "KeyC") copyRows(items); // the row stays armed: a Ctrl+V next pastes right there
      else if (e.code === "KeyD") { armed = null; duplicate(items); }
      else { armed = null; pasteHere(dirOfRow(a.path, a.kind)); }
      return;
    }
    if (e.key !== "Delete" || e.ctrlKey || e.altKey || e.metaKey) { if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) armed = null; return; }
    const t = e.target;
    // a field being typed in comes first: there Delete deletes text. The note
    // the click just opened does not count - nothing was typed or clicked in
    // it yet (either would have let go of the row), and the answer is a
    // question, not a deletion.
    if (t === tree || (t.closest && t.closest("input, textarea, select, .inline-edit"))) return;
    const a = armed;
    armed = null;
    if (!(a.kind === "note" ? vault.notes.has(a.path) : a.kind === "file" ? vault.files.has(a.path) : true)) return;
    e.preventDefault();
    e.stopPropagation();
    askTrash([[a.path, a.kind]], { forever: e.shiftKey });
  }, true);

  el.addEventListener("keydown", (e) => {
    if (e.target.closest(".inline-edit")) return;
    if (e.target === tree && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyV") { e.preventDefault(); pasteHere(hereDir()); return; }
    // Ctrl+C / Ctrl+D with the keys in the tree: the picked rows, or the one under the cursor
    if (e.target === tree && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.code === "KeyC" || e.code === "KeyD")) {
      const row = [...el.querySelectorAll(".tree-row")].find((r) => r.dataset.path === cursor);
      const items = picked.size > 1 ? pickedTop() : row ? [[cursor, row.dataset.kind]] : [];
      if (items.length) { e.preventDefault(); e.code === "KeyC" ? copyRows(items) : duplicate(items); }
      return;
    }
    // F2 with the keys in the tree: the row the cursor is on
    if (e.target === tree && e.key === "F2" && cursor) {
      const row = [...el.querySelectorAll(".tree-row")].find((r) => r.dataset.path === cursor);
      if (row) { e.preventDefault(); e.stopPropagation(); startRename(cursor, row.dataset.kind); return; }
    }
    if (e.target === tree && treeKey(e)) { e.preventDefault(); return; }
    if (e.code !== "F2") return;
    const cur = app.currentPath();
    if (cur) { e.preventDefault(); startRename(cur, "note"); }
  });

  // Where pasted or dropped files go: the folder under the keyboard cursor
  const hereDir = () => {
    const row = [...tree.querySelectorAll(".tree-row")].find((r) => r.dataset.path === cursor);
    if (!row) return lastFolder ?? "";
    return row.dataset.kind === "folder" ? cursor : dirname(cursor);
  };
  /* Copies of rows (notes, files, folders) into a folder - beside their originals, a duplicate. Never over
     anything: "Name 2". A copied note keeps none of its original's id. */
  let clip = null; // rows copied with Ctrl+C, waiting for a Ctrl+V
  window.addEventListener("blur", () => { clip = null; }); // gone to Explorer: its clipboard is the one that counts now
  async function copyInto(items, dir) {
    if (!items.length) return;
    try {
      const r = await app.host.copyInVault(items.map(([p]) => p), dir);
      if (Array.isArray(r.files) && r.files.length) vault.setFiles(r.files);
      (r.made || []).forEach((m, i) => {
        const src = items[i] && vault.get(items[i][0]);
        if (src && /\.md$/i.test(m)) { vault.external([{ path: m, content: src.content, mtime: Date.now() }]); if (app.noteIds) app.noteIds.dropId(m); }
      });
      if (dir) expanded.add(dir);
      renderTree();
      const first = (r.made || [])[0];
      if (first) setTimeout(() => reveal(first), 80);
      app.toast(items.length === 1 && first ? `Made “${basename(first)}”` : `Made ${(r.made || []).length} copies`, { ms: 2200 });
      if (app.sound) app.sound("add");
    } catch (e) { app.toast("Could not copy: " + e, { kind: "error" }); }
  }
  // each beside its original
  const duplicate = async (items) => { for (const it of items) await copyInto([it], dirname(it[0])); };
  // where a paste goes for a row: into it if a folder, else beside it
  const dirOfRow = (path, kind) => (kind === "folder" ? path : dirname(path));
  const copyRows = (items) => { clip = items; app.toast(`${items.length === 1 ? `“${basename(items[0][0])}”` : `${items.length} items`} copied - Ctrl+V on a folder or a file puts a copy there`, { ms: 2600 }); };
  const pasteHere = (dir) => (clip ? copyInto(clip, dir) : pasteFiles(dir));

  async function pasteFiles(dir) {
    try {
      const r = await app.host.pasteFiles(dir);
      if (!r || !r.pasted || !r.pasted.length) return app.toast("Nothing to paste - copy files in Explorer first (Ctrl+C)", { ms: 3000 });
      if (Array.isArray(r.files)) vault.setFiles(r.files);
      if (dir) { expanded.add(dir); schedule(); }
      app.toast(`Pasted ${r.count} file${r.count === 1 ? "" : "s"} into ${dir ? basename(dir) : "the vault"}`, { ms: 2600 });
      if (app.sound) app.sound("add");
    } catch (e) {
      app.toast("Could not paste: " + e, { kind: "error" });
    }
  }
  app.pasteFilesHere = () => pasteFiles(hereDir());

  // Files and folders dragged in from Explorer: every file is copied in,
  // folders keep their structure. Nothing is overwritten.
  async function importDropped(dt, dir) {
    const jobs = await droppedFiles(dt);
    if (!jobs.length) return;
    const close = jobs.length > 3 ? app.toast(`Copying ${jobs.length} files…`, { ms: 60000 }) : null;
    let ok = 0;
    for (const [rel, f] of jobs) {
      // the copy refuses over 1 GB anyway: said before the whole file is read into the window
      if (f.size > 1024 ** 3) { app.toast(`${rel} is over 1 GB - copy it in Explorer instead`, { kind: "error", ms: 5000 }); continue; }
      try {
        await app.host.importFile((dir ? dir + "/" : "") + rel, new Uint8Array(await f.arrayBuffer()));
        ok++;
      } catch (e) {
        app.toast(`Could not copy ${rel}: ${e}`, { kind: "error" });
      }
    }
    if (close) close();
    if (dir) { expanded.add(dir); schedule(); }
    if (ok) app.toast(`Copied ${ok} file${ok === 1 ? "" : "s"} into ${dir ? basename(dir) : "the vault"}`, { ms: 2600 });
  }

  // trash.js asks and deletes; here the list tidies up after it. The keys go
  // to the list when something went, so Ctrl+Z brings it straight back.
  async function askTrash(items, opts) {
    if (!items.length) return;
    // the row after the last one going (or before it): that is where the
    // cursor lands, armed, so Delete again takes the next one and Ctrl+Z brings the last back
    const gone = new Set(items.map(([p]) => p));
    const rows = [...tree.querySelectorAll(".tree-row[data-path]")];
    const last = rows.map((r, i) => (gone.has(r.dataset.path) ? i : -1)).filter((i) => i >= 0).pop();
    let next = null;
    if (last != null) {
      next = rows.slice(last + 1).find((r) => !gone.has(r.dataset.path) && !r.dataset.path.split("/").some((_, k, a) => gone.has(a.slice(0, k + 1).join("/")))) || rows.slice(0, last).reverse().find((r) => !gone.has(r.dataset.path));
    }
    const n = await app.trashAsk(items, opts);
    if (!n) return;
    clearPicked();
    const land = () => {
      if (next && next.dataset.path && (vault.notes.has(next.dataset.path) || vault.files.has(next.dataset.path) || vault.folders.has(next.dataset.path))) {
        cursor = next.dataset.path;
        armed = { path: cursor, kind: next.dataset.kind };
        markCursor();
      }
      tree.focus({ preventScroll: true });
    };
    land();
    requestAnimationFrame(land);
    setTimeout(land, 150);
  }
  app.sidebarArmed = () => !!armed;
  app.askTrash = askTrash;

  // Walking with the arrows shows what the cursor is on, once it rests: a held
  // key runs down the list at full speed and only the file it stops at opens.
  // The tree keeps the keys.
  let openT = 0;
  function openSoon(path, kind) {
    clearTimeout(openT);
    if (kind !== "note" && kind !== "file") return;
    openT = setTimeout(() => {
      if (cursor !== path || !el.contains(document.activeElement)) return;
      if (kind === "note") app.openNote(path, { focus: false });
      else app.openFile(path);
      const back = () => { if (cursor === path) tree.focus({ preventScroll: true }); };
      requestAnimationFrame(back);
      setTimeout(back, 90);
    }, 130);
  }

  // Arrows walk the tree like a file explorer: up/down move, right opens or
  // steps in, left closes or steps out, Enter opens, F2 renames.
  function treeKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const rows = [...tree.querySelectorAll(".tree-row")];
    if (!rows.length) return false;
    const i = rows.findIndex((r) => r.dataset.path === cursor);
    const row = rows[i];
    const go = (j) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      cursor = r.dataset.path;
      lastFolder = r.dataset.kind === "folder" ? cursor : dirname(cursor);
      markCursor();
      r.scrollIntoView({ block: "nearest" });
      openSoon(r.dataset.path, r.dataset.kind);
    };
    switch (e.key) {
      case "ArrowDown": go(i < 0 ? 0 : i + 1); return true;
      case "ArrowUp": go(i < 0 ? rows.length - 1 : i - 1); return true;
      case "Home": go(0); return true;
      case "End": go(rows.length - 1); return true;
      case "ArrowRight":
        if (row && row.dataset.kind === "folder") {
          if (!expanded.has(cursor)) toggleFolder(cursor, true);
          else go(i + 1);
        }
        return true;
      case "ArrowLeft": {
        if (!row) return true;
        if (row.dataset.kind === "folder" && expanded.has(cursor)) { toggleFolder(cursor, false); return true; }
        const up = dirname(cursor);
        const j = rows.findIndex((r) => r.dataset.path === up);
        if (up && j >= 0) go(j);
        return true;
      }
      case "Enter":
        if (row) row.click();
        return true;
      case "F2":
        if (row) startRename(cursor, row.dataset.kind);
        return true;
      case "Delete":
        askTrash(picked.size > 1 ? pickedTop() : row ? [[cursor, row.dataset.kind]] : [], { forever: e.shiftKey });
        return true;
    }
    return false;
  }

  // drag a note or folder onto a folder (or the empty tree area = root) to move it;
  // drag a note into the editor to insert a [[link]].
  let dragging = null;
  el.addEventListener("dragstart", (e) => {
    // text pressed and moved in the rename box is a selection being made, never the row going somewhere
    if (e.target.closest && e.target.closest("input, textarea, .tree-edit")) { e.preventDefault(); return; }
    const row = rowOf(e);
    if (!row) return;
    dragging = { path: row.dataset.path, kind: row.dataset.kind, pin: !!row.dataset.pin, many: picked.size > 1 && picked.has(row.dataset.path) ? pickedTop() : null };
    e.dataTransfer.effectAllowed = "move";
    const p = row.dataset.path;
    e.dataTransfer.setData("text/plain", row.dataset.kind === "note" ? `[[${vault.linkText(p)}]]` : row.dataset.kind === "file" ? `![[${p.slice(p.lastIndexOf("/") + 1)}]]` : p);
    // research boards take whole notes (a folder brings the notes inside it)
    const paths = row.dataset.kind === "folder" ? [...vault.notes.keys()].filter((n) => n.startsWith(p + "/")).slice(0, 60) : [p];
    e.dataTransfer.setData("application/x-leonote-paths", JSON.stringify(paths));
    row.classList.add("is-dragging");
    const n = dragging.many ? dragging.many.length : 1;
    const ghost = h("div", { class: "tree-ghost" }, icon(row.dataset.kind === "folder" ? "folder" : row.dataset.kind === "file" ? "file" : "fileText"), h("span", { text: n > 1 ? `${n} items` : (row.querySelector(".tree-label") || row).textContent.trim() }));
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 14, 16);
    setTimeout(() => ghost.remove(), 0);
  });
  el.addEventListener("dragend", () => {
    dragging = null;
    dropKey = "";
    for (const r of el.querySelectorAll(".is-dragging, .is-drop, .is-drop-before, .is-drop-after")) r.classList.remove("is-dragging", "is-drop", "is-drop-before", "is-drop-after");
    tree.classList.remove("is-drop-root");
  });
  // Pinned: drag to reorder; drop a note or file from the tree to pin it
  const pinSlot = (e) => {
    const rows = [...pinned.children];
    const i = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    return i < 0 ? rows.length : i;
  };
  const clearPinMarks = () => { for (const r of pinned.querySelectorAll(".is-pin-before, .is-pin-after")) r.classList.remove("is-pin-before", "is-pin-after"); };
  pinned.addEventListener("dragover", (e) => {
    if (!dragging || dragging.kind === "folder") return;
    e.preventDefault();
    e.stopPropagation();
    clearPinMarks();
    const rows = pinned.children;
    const i = pinSlot(e);
    if (rows[i]) rows[i].classList.add("is-pin-before");
    else if (rows.length) rows[rows.length - 1].classList.add("is-pin-after");
  });
  pinned.addEventListener("dragleave", (e) => { if (!pinned.contains(e.relatedTarget)) clearPinMarks(); });
  pinned.addEventListener("drop", (e) => {
    if (!dragging || dragging.kind === "folder") return;
    e.preventDefault();
    e.stopPropagation();
    clearPinMarks();
    const list = (app.settings.pinned || []).filter((p) => vault.notes.has(p) || vault.files.has(p));
    const rows = [...pinned.children].map((r) => r.dataset.path);
    const target = rows[pinSlot(e)];
    const from = list.indexOf(dragging.path);
    if (from >= 0) list.splice(from, 1);
    const at = target && target !== dragging.path ? list.indexOf(target) : from >= 0 && target === dragging.path ? from : list.length;
    list.splice(at < 0 ? list.length : at, 0, dragging.path);
    dragging = null;
    app.setSetting("pinned", list);
  });
  const outside = (e) => !dragging && [...(e.dataTransfer?.types || [])].some((t) => t === "Files" || t === "application/x-leonote-archive");
  let dropKey = "";
  tree.addEventListener("dragover", (e) => {
    if (outside(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const row = rowOf(e);
      for (const r of tree.querySelectorAll(".is-drop")) r.classList.remove("is-drop");
      const folder = row && row.dataset.kind === "folder" ? row : row ? tree.querySelector(`.tree-row.is-folder[data-path="${CSS.escape(dirname(row.dataset.path))}"]`) : null;
      if (folder) folder.classList.add("is-drop");
      tree.classList.toggle("is-drop-root", !folder);
      return;
    }
    if (!dragging || dragging.pin) return;
    e.preventDefault();
    const row = rowOf(e);
    const spot = dropSpot(e, row);
    // the marks are only redrawn when the spot changes - redoing them on every move restarted their fade and lagged behind
    const key = `${spot.dir}|${spot.line ? spot.line.row.dataset.path + spot.line.after : ""}`;
    if (key === dropKey) return;
    clearDropMarks();
    dropKey = key;
    if (spot.line) { spot.line.row.style.setProperty("--drop-x", getComputedStyle(spot.line.row).paddingLeft); spot.line.row.classList.add(spot.line.after ? "is-drop-after" : "is-drop-before"); }
    const lit = spot.dir ? tree.querySelector(`.tree-row.is-folder[data-path="${CSS.escape(spot.dir)}"]`) : null;
    if (lit) lit.classList.add("is-drop");
    tree.classList.toggle("is-drop-root", !spot.dir);
  });
  const clearDropMarks = () => { dropKey = ""; for (const r of tree.querySelectorAll(".is-drop, .is-drop-before, .is-drop-after")) r.classList.remove("is-drop", "is-drop-before", "is-drop-after"); };
  /**
   * Where a drop at the pointer lands: `dir` is the folder it goes into ("" the root).
   * Over a folder row, the middle is into it, the top or bottom edge beside it - its
   * parent, with a line to show the level. Over a note or file, beside it.
   */
  function dropSpot(e, row) {
    if (!row) return { dir: "" };
    const p = row.dataset.path;
    if (row.dataset.kind !== "folder") return { dir: dirname(p), line: { row, after: e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 } };
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    // a folder being dragged over itself or its insides has nowhere to go but beside
    if (y < 0.25 || y > 0.75) return { dir: dirname(p), line: { row, after: y > 0.5 } };
    return { dir: p };
  }
  tree.addEventListener("dragleave", (e) => {
    if (outside(e) && !tree.contains(e.relatedTarget)) { for (const r of tree.querySelectorAll(".is-drop")) r.classList.remove("is-drop"); tree.classList.remove("is-drop-root"); }
  });
  tree.addEventListener("drop", async (e) => {
    if (outside(e)) {
      e.preventDefault();
      const row = rowOf(e);
      const dir = row ? (row.dataset.kind === "folder" ? row.dataset.path : dirname(row.dataset.path)) : "";
      for (const r of tree.querySelectorAll(".is-drop")) r.classList.remove("is-drop");
      tree.classList.remove("is-drop-root");
      const arch = e.dataTransfer.getData("application/x-leonote-archive");
      if (arch) { try { app.archiveTake(JSON.parse(arch), dir); } catch {} return; }
      importDropped(e.dataTransfer, dir);
      return;
    }
    if (!dragging || dragging.pin) return;
    e.preventDefault();
    const row = rowOf(e);
    const target = dropSpot(e, row).dir;
    clearDropMarks();
    tree.classList.remove("is-drop-root");
    const d = dragging;
    dragging = null;
    if (d.many) {
      for (const [p, k] of d.many) {
        if (k === "note") { if (dirname(p) !== target) await app.moveNote(p, target); }
        else if (k === "file") { if (dirname(p) !== target) await app.moveFile(p, target); }
        else if (target !== p && !target.startsWith(p + "/") && dirname(p) !== target) await app.renameFolder(p, basename(p), target);
      }
      clearPicked();
      return;
    }
    if (d.kind === "note") { if (dirname(d.path) !== target) app.moveNote(d.path, target); }
    else if (d.kind === "file") { if (dirname(d.path) !== target) app.moveFile(d.path, target); }
    else if (target !== d.path && !target.startsWith(d.path + "/") && dirname(d.path) !== target) {
      app.renameFolder(d.path, basename(d.path), target);
    }
  });

  /* ── tags ───────────────────────────────────────────────────────────── */
  function renderTags() {
    const list = [...vault.tagCounts().entries()].sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]));
    tagsSec.hidden = !list.length;
    tags.replaceChildren(...list.slice(0, 60).map(([t, c]) =>
      h("button", { class: "tag-chip", onclick: () => openPalette(app, "search", { query: "#" + t, force: true }), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); tagMenu(t, e); } }, "#" + t, h("span", { class: "tag-count", text: String(c) }))));
  }
  // a tag groups notes as a folder does: the same things to do with them
  function tagMenu(t, e) {
    const paths = [...vault.notes.values()].filter((n) => (n.tags || []).some((x) => x === t || x.startsWith(t + "/"))).map((n) => n.path);
    menu(e.clientX, e.clientY, [
      { header: `#${t} · ${paths.length} note${paths.length === 1 ? "" : "s"}`, plain: true },
      { label: "Search for it", icon: "search", run: () => openPalette(app, "search", { query: "#" + t, force: true }) },
      app.zettel ? { label: "Map of these notes", icon: "map", run: () => app.zettel.newMoc({ title: `${t.replace(/\//g, " - ")} map`, links: paths.map((p) => vault.linkText(p)) }) } : null,
      { label: "Board of these notes", icon: "grid", run: () => app.newBoard({ name: t.replace(/\//g, " - "), notes: paths.slice(0, 60) }) },
      { label: "Copy as a list of links", icon: "link", run: () => navigator.clipboard.writeText(paths.map((p) => `- [[${vault.linkText(p)}]]`).join("\n") + "\n").then(() => app.toast("Copied", { ms: 1400 })) },
      "sep",
      { label: "Rename it in every note…", icon: "edit", run: () => renameTag(t, paths) },
    ].filter(Boolean));
  }
  async function renameTag(t, paths) {
    const r = await askDialog(`Rename #${t}`, [{ key: "to", label: "New name", value: t }], { ok: "Rename", text: `In ${paths.length} note${paths.length === 1 ? "" : "s"}, and the tags under it (#${t}/…) too. Renaming it back undoes it.` });
    const to = r && r.to.replace(/^#/, "").trim();
    if (!to || to === t) return;
    if (!/^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(to)) return app.toast("A tag is letters, digits, _ - and /, with no spaces", { kind: "error" });
    const { renameTagText, isTagName } = await import("./mdparse.js");
    if (!isTagName(to)) return app.toast("That is not a tag: it needs a letter in it", { kind: "error" });
    if (app.flushAll) await app.flushAll(); // what is being typed is saved first, and renamed with the rest
    let n = 0;
    for (const p of paths) {
      const note = vault.get(p);
      const next = note && renameTagText(note.content || "", t, to);
      if (next && next !== note.content) { await vault.write(p, next, {}); n++; }
    }
    app.toast(`#${t} is #${to} now, in ${n} note${n === 1 ? "" : "s"}`, { ms: 3500 });
  }
  const tagsSoon = debounce(renderTags, 400);

  /* ── subscriptions ──────────────────────────────────────────────────── */
  vault.bus.on("structure", schedule);
  // a note just made in the app: the tree brings it into view (after the redraw), however long the list
  vault.bus.on("structure", (e) => { if (e && e.created) setTimeout(() => reveal(e.created), 120); });
  vault.bus.on("renamed", schedule);
  // the notes changed from outside flash together: one pass over the rows and one layout, however many came at once
  const flashing = new Set();
  let flashRaf = 0;
  vault.bus.on("changed", (e) => {
    if (e.linksChanged) tagsSoon();
    if (!e.external) return;
    flashing.add(e.path);
    flashRaf ||= requestAnimationFrame(() => {
      flashRaf = 0;
      const rows = [...tree.querySelectorAll(".tree-row.is-note")].filter((r) => flashing.has(r.dataset.path));
      flashing.clear();
      for (const r of rows) r.classList.remove("is-flash");
      void tree.offsetWidth;
      for (const r of rows) r.classList.add("is-flash");
    });
  });
  app.bus.on("view", () => {
    markActive();
    renderNav();
    const cur = app.currentPath();
    if (cur && app.settings.treeAutoReveal) reveal(cur);
  });
  app.bus.on("settings", (k) => {
    if (k === "pinned") renderPinned();
    if (k === "navRibbon" || k === "settingsInRibbon") placeNav();
    if (k === "navSize") applyNavH(navH());
    if (k === "ribbonGap") applyRibbonGap();
    if (TREE_KEYS.has(k)) schedule();
  });
  // a renamed folder keeps its look and its open state
  vault.bus.on("folderRenamed", ({ from, to }) => {
    const move = (p) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    const styles = app.settings.folderStyles || {};
    if (Object.keys(styles).some((p) => move(p) !== p)) {
      app.setSetting("folderStyles", Object.fromEntries(Object.entries(styles).map(([p, v]) => [move(p), v])));
    }
    const next = [...expanded].map(move);
    expanded.clear();
    for (const p of next) expanded.add(p);
    app.setSetting("expanded", next);
    if (lastFolder) lastFolder = move(lastFolder);
    if (cursor) cursor = move(cursor);
    const hid = app.settings.hiddenPaths || [];
    if (hid.some((p) => move(p) !== p)) app.setSetting("hiddenPaths", hid.map(move));
  });
  const itemRenamed = ({ from, to }) => {
    const hid = app.settings.hiddenPaths || [];
    if (hid.includes(from)) app.setSetting("hiddenPaths", hid.map((p) => (p === from ? to : p)));
    const styles = app.settings.folderStyles || {};
    if (styles[from]) {
      const next = { ...styles, [to]: styles[from] };
      delete next[from];
      app.setSetting("folderStyles", next);
    }
  };
  vault.bus.on("renamed", itemRenamed);
  vault.bus.on("fileRenamed", itemRenamed);
  app.bus.on("habits", renderNav);
  app.bus.on("pomo", renderNav);
  const renderLevel = () => {
    const p = app.stats.progress();
    levelChip.hidden = app.settings.showLevel === false;
    const r = rankOf(p.level);
    levelChip.style.setProperty("--rc", rankColor(p.level));
    levelChip.replaceChildren(
      h("span", { class: "sb-level-num" }, app.settings.showRankIcon === false ? null : h("span", { class: "sb-level-ico" }, icon(r.icon)), `Lv ${p.level}`),
      h("span", { class: "sb-level-bar" }, h("span", { style: { width: `${Math.round((p.into / p.span) * 100)}%` } })));
    levelChip.setAttribute("aria-label", `Level ${p.level}, ${r.name}`);
  };
  app.stats.bus.on("changed", debounce(renderLevel, 200));
  renderLevel();
  app.tasks.bus.on("changed", debounce(renderNav, 50));

  placeNav();
  renderTree();
  renderPinned();
  renderTags();

  // Where the list was scrolled to comes back with the app. Scrolling only
  // notes the number; it reaches the disk with the next ordinary save of the
  // settings, so looking through the tree writes nothing by itself.
  {
    const sc = el.querySelector(".sb-scroll");
    const want = Number(app.settings.sidebarScrollTop) || 0;
    let restoring = want > 0;
    const put = () => { if (restoring && sc.scrollHeight - sc.clientHeight >= want - 4) { sc.scrollTop = want; restoring = false; } else if (restoring) sc.scrollTop = want; };
    // the tree fills in over the first moments: keep trying until it is long enough
    if (restoring) { let n = 0; const t = setInterval(() => { put(); if (!restoring || ++n > 40) { restoring = false; clearInterval(t); } }, 120); requestAnimationFrame(put); }
    sc.addEventListener("scroll", () => { if (!restoring) app.settings.sidebarScrollTop = Math.round(sc.scrollTop); }, { passive: true });
    sc.addEventListener("wheel", () => { restoring = false; }, { passive: true });
  }
  renderNav();

  return { renderTree, startRename, markRenaming, reveal, newFolder, toggleFolder, newFolderHere: () => newFolder(contextFolder()) };
}
