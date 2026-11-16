// Split view: panes beside the main one, each with its own small tab strip.
// Notes and files open there for side-by-side research (a note next to the
// graph, two notes, a PDF and its summary). Up to two columns, left and
// right of the main pane, each holding one pane or two stacked; the panes
// keep their tabs per space, and main.js supplies the editor and file view
// they show them in.

import { h, basename, motionOk } from "./util.js";
import { icon } from "./icons.js";
import { menu } from "./ui.js";
// the browser tab's engines (webtab.js pulls in the editor, so it comes after this file; main.js has it loaded long before a click)
let web = null;
import("./webtab.js").then((m) => { web = m; }, () => {});

const MIN_W = 150; // a column, and what the main pane keeps

/* ── one pane ──────────────────────────────────────────────────────────── */
function mountPane(app, el, hooks, id) {
  const { makeEditor, makeFileView, makeExtView, tabInfo, exists, onFocus, onToMain, onTabDrop, onSave, onArchiveDrop } = hooks;
  let tabs = []; // { kind: "note" | "file" | "ext" | "web", path }
  let active = -1;
  let editor = null;
  let fileView = null;
  let extView = null; // files outside the vault: an outpost's, or a guest

  const strip = h("div", { class: "sp-tabs" });
  const title = h("div", { class: "sp-title" });
  const scroller = h("div", { class: "note-scroll sp-scroll" });
  const edHost = h("div", { class: "editor-host" });
  scroller.append(h("div", { class: "note-head sp-head" }, title), edHost);
  const noteEl = h("div", { class: "view view-note sp-note" }, scroller);
  const fileEl = h("div", { class: "view view-file sp-file", hidden: true });
  const extEl = h("div", { class: "view view-file sp-file sp-ext", hidden: true });
  const dropHint = h("div", { class: "sp-drop", hidden: true }, icon("columns"), "Open here");

  /* ── a browser tab ───────────────────────────────────────────────────
     For reading around a note without leaving it. The page is a real browser
     view the app lays over `webSlot` (host.splitWebShow) - never an iframe,
     which most sites refuse. This element only holds the address bar and
     keeps the native view's rectangle up to date. Each pane has a view of
     its own, named by the pane's id. */
  // the search engine chosen for the browser tab (Google until another is picked); nothing typed: its front door
  const toUrl = (text) => {
    const k = app.settings.webSearch;
    if (!web) return String(text || "").trim() ? "https://www.google.com/search?q=" + encodeURIComponent(String(text).trim()) : "https://www.google.com/";
    web.setCustomEngines(app.settings.webCustomEngines);
    return web.toUrl(text, k) || web.searchUrl(web.allEngines()[k] ? k : "google", "");
  };
  const addr = h("input", { class: "sp-web-addr", spellcheck: false, placeholder: "Search, or type an address", "aria-label": "Address" });
  const webSlot = h("div", { class: "sp-web-slot" });
  const webNote = h("div", { class: "sp-web-note" });
  webSlot.append(webNote);
  const wbtn = (ic, title, run) => h("button", { class: "icon-btn", title, onclick: run }, icon(ic));
  const webEl = h("div", { class: "view sp-web", hidden: true },
    h("div", { class: "sp-web-bar" },
      wbtn("back", "Back", () => app.host.splitWebGo("back", id).catch(() => {})),
      wbtn("forward", "Forward", () => app.host.splitWebGo("forward", id).catch(() => {})),
      wbtn("rotateRight", "Reload", () => app.host.splitWebGo("reload", id).catch(() => {})),
      addr,
      wbtn("outside", "Open this page in your browser", () => { const t = cur(); if (t && t.kind === "web") app.openUrl(t.path); })),
    webSlot);
  addr.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { const t = cur(); if (t && t.kind === "web") { t.path = toUrl(addr.value); addr.value = t.path; webShown = ""; placeWeb(true); paint(); hooks.onChange && hooks.onChange(); } }
    else if (e.key === "Escape") { const t = cur(); if (t) addr.value = t.path; addr.blur(); }
  });
  addr.addEventListener("focus", () => addr.select());
  let scaleFactor = 1;
  if (app.host.real && app.host.win.scaleFactor) app.host.win.scaleFactor().then((f) => { scaleFactor = f || 1; }).catch(() => {});
  let webShown = ""; // the url the native view was last sent to
  let webRect = "";
  let webUp = false;
  let suspended = false; // locked to another main tab: out of sight, nothing lost
  // anything of the app's own that floats over the pane (menus, dialogs, the
  // palette) would be UNDER a native view, so the view steps aside for it
  const covered = () => {
    const r = webSlot.getBoundingClientRect();
    for (const o of document.querySelectorAll("#overlay-root > *, .dlg-back, .pt-sheet-back, .pal-back, .menu, .img-viewer, .ie, .drop-card, .toast, .tab-peek:not([hidden]), .nt-pop, .tg-pop, .folder-pop, #corner-cards > .cc")) {
      const b = o.getBoundingClientRect();
      if (b.width && b.height && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) return true;
    }
    return false;
  };
  function placeWeb(force) {
    const t = cur();
    const want = !!t && t.kind === "web" && !el.hidden && !suspended && el.offsetParent !== null;
    if (!app.host.real) { webNote.hidden = false; webNote.replaceChildren(icon("globe"), h("div", { text: "The page opens here in the Leonote app." }), t && t.kind === "web" ? h("button", { class: "btn", onclick: () => app.openUrl(t.path) }, "Open in your browser") : null); return; }
    webNote.hidden = true;
    if (!want || covered()) { if (webUp) { webUp = false; webRect = ""; app.host.splitWebHide(id).catch(() => {}); } return; }
    const r = webSlot.getBoundingClientRect();
    // CSS px -> the window's logical px: the app's own zoom stands between them
    const z = (window.devicePixelRatio || 1) / scaleFactor;
    const rect = { x: Math.round(r.left * z), y: Math.round(r.top * z), w: Math.round(r.width * z), h: Math.round(r.height * z) };
    const key = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    const nav = webShown !== t.path;
    if (!force && !nav && key === webRect && webUp) return;
    if (rect.w < 40 || rect.h < 40) return;
    webRect = key;
    webUp = true;
    webShown = t.path;
    app.host.splitWebShow(nav ? t.path : null, rect, id).catch((e) => { webUp = false; webShown = ""; webNote.hidden = false; webNote.replaceChildren(icon("globe"), h("div", { text: String(e) })); });
  }
  // the pane moves with the window, the sidebar, the split's own grip, menus opening: follow cheaply
  let webLoop = 0;
  // only while a page is what this pane shows: a note or file in front, a hidden or set-aside pane, needs no frame loop
  // (showing a web tab again goes through paint, which starts it)
  // every frame for a second after anything moves, then twice a second (as the main page's tab does)
  let webSlow = 0, webCalm = 0, webLast = "";
  const showsWeb = () => { const t = cur(); return !!t && t.kind === "web" && !el.hidden && !suspended; };
  const followWeb = () => {
    webLoop = 0; webSlow = 0;
    placeWeb(false);
    if (!showsWeb()) return;
    const now = performance.now();
    const k = webRect + (webUp ? "+" : "-");
    if (k !== webLast) { webLast = k; webCalm = now; }
    if (now - webCalm < 1000) webLoop = requestAnimationFrame(followWeb);
    else webSlow = setTimeout(followWeb, 500);
  };
  const kickWeb = () => { webCalm = performance.now(); clearTimeout(webSlow); webSlow = 0; if (!webLoop && showsWeb()) webLoop = requestAnimationFrame(followWeb); };
  const nudge = () => { if (webLoop || webSlow) kickWeb(); };
  const listens = typeof document.addEventListener === "function" && typeof addEventListener === "function";
  if (listens) for (const ev of ["pointerdown", "pointerup", "keydown", "wheel", "resize", "leo:overlay"]) addEventListener(ev, nudge, { capture: true, passive: true });
  // the pane's place moves with the sidebar, the panels and the split's own grip
  const roWeb = typeof ResizeObserver === "function" ? new ResizeObserver(nudge) : null;
  if (roWeb) roWeb.observe(webSlot);
  const moWeb = typeof MutationObserver === "function" ? new MutationObserver(nudge) : null;
  if (moWeb && document.getElementById) for (const nid of [null, "overlay-root", "toasts", "corner-cards"]) { const n = nid ? document.getElementById(nid) : document.body; if (n) moWeb.observe(n, { childList: true }); }
  const closeWeb = () => { if (app.host.real && webShown) { webShown = ""; webUp = false; app.host.splitWebClose(id).catch(() => {}); } };
  const unlistenUrl = app.host.real ? app.host.on("splitweb:url", (p) => {
    const t = cur();
    if (!p || p.id !== id || !t || t.kind !== "web" || !p.url || /^about:/i.test(p.url)) return;
    t.path = p.url;
    webShown = p.url;
    if (document.activeElement !== addr) addr.value = p.url;
    if (p.done) { paint(); hooks.onChange && hooks.onChange(); }
  }) : null;

  el.append(
    h("div", { class: "sp-bar" }, strip,
      // the side pane: this tab's only (it steps aside on others), or on every tab
      hooks.shared ? h("button", { class: "icon-btn sp-shared", title: "This tab only - click to show it on every tab", onclick: (e) => { hooks.toggleShared(); paintShared(e.currentTarget); } }, icon("pin")) : null,
      h("button", { class: "icon-btn", title: "Swap with the main pane", onclick: () => swap() }, icon("swap")),
      h("button", { class: "icon-btn", title: "Close this pane", onclick: () => hide() }, icon("x"))),
    noteEl, fileEl, extEl, webEl, dropHint);
  function paintShared(b) {
    b = b || el.querySelector(".sp-shared");
    if (!b || !hooks.shared) return;
    const on = hooks.shared();
    b.classList.toggle("is-on", on);
    b.title = on ? "On every tab (a tab with its own side pane shows that one) - click to keep it with this tab only" : "This tab only - click to show it on every tab";
  }
  setTimeout(() => paintShared());
  el.addEventListener("focusin", () => onFocus && onFocus(true));
  el.addEventListener("focusout", (e) => { if (!el.contains(e.relatedTarget)) onFocus && onFocus(false); });
  el.addEventListener("mousedown", () => hooks.onPick && hooks.onPick());

  const cur = () => tabs[active] || null;
  const same = (a, b) => a.kind === b.kind && a.path === b.path;

  function paint() {
    const was = el.hidden;
    el.hidden = !tabs.length || suspended;
    // the pane slides in from its own edge the first time it opens
    if (was && !el.hidden && motionOk()) {
      el.classList.add("is-entering");
      setTimeout(() => el.classList.remove("is-entering"), 320);
    }
    strip.replaceChildren(...tabs.map((t, i) => {
      const inf = tabInfo(t);
      return h("div", { class: "sp-tab" + (i === active ? " is-active" : "") + (t.preview ? " is-preview" : ""), dataset: { i: String(i) }, title: t.preview ? `${t.path}\nA preview: the next one replaces it - double-click to keep it` : t.path, draggable: true },
        icon(inf.icon), h("span", { class: "tab-title", text: inf.title }),
        h("button", { class: "tab-main", dataset: { main: String(i) }, title: "Open in a tab of its own (the main pane)" }, icon("expand")),
        h("button", { class: "tab-close", dataset: { close: String(i) }, title: "Close" }, icon("x")));
    }));
    strip.querySelector(".is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function render() {
    tabs = tabs.filter(exists);
    if (active >= tabs.length) active = tabs.length - 1;
    if (!tabs.length) active = -1;
    else if (active < 0) active = 0;
    paint();
    const t = cur();
    if (!t) { placeWeb(false); closeWeb(); hooks.onChange && hooks.onChange(); return; }
    noteEl.hidden = t.kind !== "note";
    fileEl.hidden = t.kind !== "file";
    extEl.hidden = t.kind !== "ext";
    webEl.hidden = t.kind !== "web";
    if (extView && t.kind !== "ext" && extView.dirty) extView.flush();
    if (!tabs.some((x) => x.kind === "web")) closeWeb();
    if (t.kind === "web") {
      if (document.activeElement !== addr) addr.value = t.path;
      kickWeb();
      placeWeb(false);
    } else if (t.kind === "note") {
      placeWeb(false);
      if (fileView && fileView.dirty) fileView.flush();
      if (!editor) editor = makeEditor(edHost, scroller);
      const n = app.vault.get(t.path);
      editor.open(t.path, n.content, { pos: app.positions[t.path] });
      title.textContent = basename(t.path);
    } else if (t.kind === "ext") {
      placeWeb(false);
      if (!extView && makeExtView) extView = makeExtView(extEl);
      if (extView) extView.show(t.path);
    } else {
      placeWeb(false);
      if (!fileView) fileView = makeFileView(fileEl);
      fileView.show(t.path);
    }
    hooks.onChange && hooks.onChange();
  }

  /** A browser tab in the pane (one page at a time: a second call reuses it). */
  function openWeb(text, { focus = true } = {}) {
    const url = toUrl(text);
    const k = tabs.findIndex((t) => t.kind === "web");
    if (k >= 0) { tabs[k].path = url; active = k; }
    else { tabs.splice(active + 1, 0, { kind: "web", path: url }); active = active + 1; }
    render();
    if (focus && !text) requestAnimationFrame(() => addr.focus());
  }

  /* preview: a look, not a keep - one tab (in italics) that the next look replaces, as in a
     file list you walk with the arrows; opened again without it, or double-clicked, it stays */
  function open(l, { focus = true, preview = false } = {}) {
    if (!exists(l)) return;
    const k = tabs.findIndex((t) => same(t, l));
    if (k >= 0) { active = k; if (!preview) delete tabs[k].preview; }
    else {
      const pv = preview ? tabs.findIndex((t) => t.preview) : -1;
      if (pv >= 0) { tabs[pv] = { kind: l.kind, path: l.path, preview: true }; active = pv; }
      else {
        tabs.splice(active + 1, 0, preview ? { kind: l.kind, path: l.path, preview: true } : { kind: l.kind, path: l.path });
        active = active + 1;
      }
    }
    render();
    if (focus && cur().kind === "note") requestAnimationFrame(() => editor && editor.focus());
  }

  function close(i) {
    const t = tabs[i];
    if (!t) return;
    if (t.kind === "note" && onSave) onSave(t.path);
    tabs.splice(i, 1);
    if (active >= i) active = Math.max(active - 1, tabs.length ? 0 : -1);
    render();
  }

  /** Tab `i` taken out (to another pane, or the main one): its location. */
  function take(i) {
    const t = tabs[i];
    if (!t) return null;
    if (t.kind === "note" && onSave) onSave(t.path);
    if (fileView && fileView.dirty) fileView.flush();
    tabs.splice(i, 1);
    if (active >= i) active = Math.max(active - 1, tabs.length ? 0 : -1);
    render();
    return { kind: t.kind, path: t.path };
  }

  // before the tabs change hands: an emptied pane takes its editor with it, and what was typed there
  function saveAll() {
    for (const t of tabs) if (t.kind === "note" && onSave) onSave(t.path);
    if (fileView && fileView.dirty) fileView.flush();
    if (extView && extView.dirty) extView.flush();
  }

  function hide() {
    saveAll();
    tabs = [];
    active = -1;
    render();
  }

  // the pane's document goes to the main pane and the main one comes here
  function swap() {
    const t = cur();
    if (!t) return;
    if (t.kind === "note" && onSave) onSave(t.path);
    const back = hooks.mainDoc && hooks.mainDoc();
    if (back) tabs[active] = back;
    else tabs.splice(active, 1);
    render();
    onToMain && onToMain(t, !back);
  }

  // saved first, as in swap(): the last tab gone takes the pane's editor with it
  function toMain(i) {
    const t = tabs[i];
    if (!t) return;
    if (t.kind === "note" && onSave) onSave(t.path);
    tabs.splice(i, 1);
    render();
    onToMain && onToMain(t, true);
  }

  strip.addEventListener("click", (e) => {
    const x = e.target.closest("[data-close]");
    if (x) return close(+x.dataset.close);
    const m = e.target.closest("[data-main]");
    if (m) return toMain(+m.dataset.main);
    const tab = e.target.closest(".sp-tab");
    if (tab && +tab.dataset.i !== active) { active = +tab.dataset.i; render(); }
  });
  // a file of an archive dropped here opens as a tab of this pane
  for (const at of [strip, el]) {
    at.addEventListener("dragover", (e) => { if (onArchiveDrop && [...e.dataTransfer.types].includes("application/x-leonote-archive")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    at.addEventListener("drop", (e) => {
      const d = onArchiveDrop && e.dataTransfer.getData("application/x-leonote-archive");
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      try { onArchiveDrop(JSON.parse(d)); } catch {}
    });
  }
  strip.addEventListener("dblclick", (e) => {
    const tab = e.target.closest(".sp-tab");
    if (tab && tabs[+tab.dataset.i] && tabs[+tab.dataset.i].preview) { delete tabs[+tab.dataset.i].preview; paint(); }
  });
  strip.addEventListener("mousedown", (e) => {
    const tab = e.target.closest(".sp-tab");
    if (e.button === 1 && tab) { e.preventDefault(); close(+tab.dataset.i); }
  });
  strip.addEventListener("contextmenu", (e) => {
    const tab = e.target.closest(".sp-tab");
    if (!tab) return;
    e.preventDefault();
    const i = +tab.dataset.i;
    const t = tabs[i];
    menu(e.clientX, e.clientY, [
      { header: t.path, plain: true },
      { label: "Open in the main pane", icon: "columns", run: () => toMain(i) },
      t.kind !== "web" ? { label: "Find it in the file tree", icon: "sidebar", run: () => app.revealInTree && app.revealInTree(t.path) } : null,
      t.kind !== "web" ? { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(t.path) } : null,
      { label: t.kind === "web" ? "Copy the address" : "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(t.path); app.toast(t.kind === "web" ? "Address copied" : "Path copied", { ms: 1600 }); } },
      t.kind === "note" ? { label: "Copy link", icon: "link", run: () => { navigator.clipboard.writeText(`[[${app.vault.linkText(t.path)}]]`); app.toast("Link copied", { ms: 1600 }); } } : null,
      "sep",
      { label: "Close", icon: "x", run: () => close(i) },
      { label: "Close others", icon: "x", run: () => { tabs = [t]; active = 0; render(); } },
      "sep",
      { label: "Close this pane", icon: "x", run: () => hide() },
    ]);
  });
  // the wheel runs the tabs along; the middle button scrolls them as the main tabs do (held or clicked)
  strip.addEventListener("wheel", (e) => {
    if (e.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    strip.scrollLeft += (e.deltaMode === 1 ? 16 : 1) * (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
  }, { passive: false });
  strip.addEventListener("mousedown", (e) => {
    if (e.button !== 1 || strip.scrollWidth <= strip.clientWidth) return;
    e.preventDefault();
    const x0 = e.clientX, t0 = Date.now();
    let x = x0, raf = 0, moved = false;
    const move = (m) => { x = m.clientX; if (Math.abs(x - x0) > 6) moved = true; };
    const tick = () => { const d = x - x0, a = Math.abs(d) - 8; if (a > 0) strip.scrollLeft += Math.sign(d) * (app.stripSpeed ? app.stripSpeed(a) : a * 0.05); raf = requestAnimationFrame(tick); };
    const end = (u) => {
      if (u.type === "mouseup" && u.button === 1 && !moved && Date.now() - t0 < 350) return; // a click: it runs on until the next press
      cancelAnimationFrame(raf);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", end, true);
      document.removeEventListener("mousedown", end, true);
    };
    document.addEventListener("mousemove", move, true);
    setTimeout(() => { document.addEventListener("mouseup", end, true); document.addEventListener("mousedown", end, true); });
    raf = requestAnimationFrame(tick);
  });
  strip.addEventListener("auxclick", (e) => { if (e.button === 1 && e.target.closest(".sp-tab")) e.preventDefault(); });
  // reorder inside the strip; carried out of it, the tab can land in another pane, a split zone, or the main tabs
  let dragI = -1;
  strip.addEventListener("dragstart", (e) => {
    const tab = e.target.closest(".sp-tab");
    if (!tab) return;
    dragI = +tab.dataset.i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tabs[dragI].path);
    e.dataTransfer.setData("application/x-leonote-split", JSON.stringify({ pane: id, i: dragI }));
    e.stopPropagation();
  });
  strip.addEventListener("dragend", () => { dragI = -1; });

  // drops: a main tab, tree rows, another pane's tab, or reordering here
  const accepts = (e) => dragI >= 0 || [...e.dataTransfer.types].some((t) => t === "application/x-leonote-tab" || t === "application/x-leonote-paths" || t === "application/x-leonote-split");
  el.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragI < 0) dropHint.hidden = false;
  });
  el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) dropHint.hidden = true; });
  el.addEventListener("drop", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dropHint.hidden = true;
    if (dragI >= 0) {
      const over = e.target.closest(".sp-tab");
      const to = over ? +over.dataset.i : tabs.length - 1;
      const [t] = tabs.splice(dragI, 1);
      tabs.splice(to, 0, t);
      active = to;
      dragI = -1;
      return render();
    }
    const sp = e.dataTransfer.getData("application/x-leonote-split");
    if (sp) { try { const o = JSON.parse(sp); if (o.pane !== id) hooks.onSplitDrop && hooks.onSplitDrop(o); } catch {} return; }
    const tab = e.dataTransfer.getData("application/x-leonote-tab");
    if (tab !== "") { onTabDrop && onTabDrop(+tab); return; }
    let paths = [];
    try { paths = JSON.parse(e.dataTransfer.getData("application/x-leonote-paths") || "[]"); } catch {}
    for (const p of paths.slice(0, 12)) open(app.vault.notes.has(p) ? { kind: "note", path: p } : { kind: "file", path: p }, { focus: false });
  });

  return {
    id,
    el,
    open,
    close,
    closeCurrent: () => close(active),
    take,
    hide,
    render,
    get editor() { return editor; },
    get fileView() { return fileView; },
    get isOpen() { return tabs.length > 0; },
    get current() { return cur(); },
    openWeb,
    /** Locked to one main tab: shown with it, tucked away with any other. */
    suspend(on) { on = !!on; if (on === suspended) return; suspended = on; paint(); placeWeb(true); if (!on) kickWeb(); },
    get suspended() { return suspended; },
    swap,
    has: (l) => tabs.some((t) => same(t, l)),
    get hasPreview() { return tabs.some((t) => t.preview); },
    /** The preview tab closed (the tab it was for has gone). */
    dropPreview() { const i = tabs.findIndex((t) => t.preview); if (i >= 0) close(i); },
    focus() { if (cur() && cur().kind === "note" && editor) editor.focus(); },
    /** what a space remembers */
    // a preview is not kept with the space: it was only a look
    state: (o) => { const keep = o && o.all ? tabs : tabs.filter((t) => !t.preview); const at = keep.indexOf(tabs[active]); return { tabs: keep.map((t) => ({ kind: t.kind, path: t.path, ...(t.preview ? { preview: true } : {}) })), active: at >= 0 ? at : 0 }; },
    load(s) {
      saveAll();
      tabs = s && Array.isArray(s.tabs) ? s.tabs.filter((t) => t && (t.kind === "note" || t.kind === "file" || t.kind === "web" || t.kind === "ext") && t.path).map((t) => ({ kind: t.kind, path: t.path, ...(t.preview ? { preview: true } : {}) })) : [];
      active = s && Number.isInteger(s.active) ? s.active : 0;
      render();
    },
    rename(from, to) {
      for (const t of tabs) if (t.path === from) t.path = to;
      if (editor) editor.rename(from, to);
      paint();
      if (cur() && cur().path === to && cur().kind === "note") title.textContent = basename(to);
    },
    removed(path) {
      if (editor) editor.forget(path);
      if (tabs.some((t) => t.path === path)) render();
    },
    flush: () => (fileView && fileView.dirty ? fileView.flush() : null),
    /** The pane has left the screen for good: what it can let go of goes. */
    destroy() {
      saveAll();
      if (editor) { try { editor.destroy(); } catch {} editor = null; }
      if (fileView) { fileView.destroy(); fileView = null; }
      if (extView) { extView.destroy(); extView = null; }
      if (unlistenUrl) Promise.resolve(unlistenUrl).then((f) => f && f()).catch(() => {});
      if (listens) for (const ev of ["pointerdown", "pointerup", "keydown", "wheel", "resize", "leo:overlay"]) removeEventListener(ev, nudge, { capture: true });
      if (roWeb) roWeb.disconnect();
      if (moWeb) moWeb.disconnect();
      if (webLoop && typeof cancelAnimationFrame === "function") cancelAnimationFrame(webLoop); clearTimeout(webSlow);
    },
  };
}

/* ── the panes together ────────────────────────────────────────────────────
   Two columns at most, left and right of the main pane, each with one pane
   or two stacked. `body` is the flex row the main pane sits in; a column is
   made when something first opens on that side and goes when its last pane
   empties. The API main.js talks to names "the pane": the one last focused
   or opened into, made on the settings' side if there is none. */
export function mountSplit(app, body, hooks) {
  const cols = { left: null, right: null }; // { side, el, share, split, panes }
  let seq = 0;
  let focused = null;
  let suspended = false;
  const all = () => ["left", "right"].flatMap((s) => (cols[s] ? cols[s].panes : []));
  const main = () => body.querySelector("#main");
  const colOf = (pane) => (cols.left && cols.left.panes.includes(pane) ? cols.left : cols.right);
  const paintApp = () => document.getElementById("app")?.classList.toggle("has-split", all().some((p) => p.isOpen) && !suspended);

  function col(side) {
    if (cols[side]) return cols[side];
    const grip = h("div", { class: "sp-grip", title: "Drag to resize · double-click for half" });
    const el = h("div", { class: "split-col" + (side === "left" ? " is-left" : "") }, grip);
    body.append(el);
    const c = (cols[side] = { side, el, share: 0.45, split: 0.5, panes: [] });
    // resize by the inner edge; the share survives window resizes
    grip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const total = main().getBoundingClientRect().width + r.width;
      document.body.classList.add("is-resizing");
      const move = (ev) => {
        const px = Math.max(MIN_W, Math.min(total - MIN_W, side === "left" ? ev.clientX - r.left : r.right - ev.clientX));
        c.share = px / total;
        el.style.width = px + "px";
      };
      const up = () => {
        document.body.classList.remove("is-resizing");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        hooks.onChange && hooks.onChange();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    grip.addEventListener("dblclick", () => { c.share = 0.5; layout(c); hooks.onChange && hooks.onChange(); });
    return c;
  }

  function layout(c) {
    if (!c) return;
    if (!c.panes.length) { c.el.remove(); cols[c.side] = null; return; }
    c.el.hidden = c.panes.every((p) => p.el.hidden);
    const m = main();
    const total = (m ? m.getBoundingClientRect().width : 0) + c.el.getBoundingClientRect().width;
    const px = total > 0 ? Math.max(MIN_W, Math.min(total - MIN_W, total * c.share)) : 0;
    c.el.style.width = px ? px + "px" : Math.round(c.share * 100) + "%";
    const two = c.panes.filter((p) => !p.el.hidden).length > 1;
    c.panes.forEach((p, k) => {
      p.el.style.flex = two && k === 0 ? `0 0 ${Math.round(c.split * 1000) / 10}%` : "1 1 0";
      p.vgrip.hidden = !(two && k === 0);
    });
  }

  function newPane(side, pos) {
    const c = col(side);
    const id = "p" + ++seq;
    const el = h("div", { class: "split" });
    const vgrip = h("div", { class: "sp-vgrip", hidden: true, title: "Drag to resize · double-click for half" });
    const pane = mountPane(app, el, {
      ...hooks,
      onChange: () => { reflow(); hooks.onChange && hooks.onChange(); },
      onFocus: (on) => { if (on) focused = pane; hooks.onFocus && hooks.onFocus(on); },
      onPick: () => { focused = pane; },
      onTabDrop: (i) => { focused = pane; hooks.onTabDrop && hooks.onTabDrop(i); },
      onSplitDrop: (o) => { const l = take(o.pane, o.i); if (l) { focused = pane; pane.open(l); } },
    }, id);
    pane.vgrip = vgrip;
    el.append(vgrip);
    // the two panes of a column share its height by this grip
    vgrip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = c.el.getBoundingClientRect();
      document.body.classList.add("is-resizing-v");
      const move = (ev) => { c.split = Math.max(0.12, Math.min(0.88, (ev.clientY - r.top) / Math.max(1, r.height))); layout(c); };
      const up = () => { document.body.classList.remove("is-resizing-v"); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); hooks.onChange && hooks.onChange(); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    vgrip.addEventListener("dblclick", () => { c.split = 0.5; layout(c); hooks.onChange && hooks.onChange(); });
    if (pos === "top") { c.panes.unshift(pane); c.el.insertBefore(el, c.el.children[1] || null); }
    else { c.panes.push(pane); c.el.append(el); }
    if (suspended) pane.suspend(true);
    focused = pane;
    layout(c);
    return pane;
  }

  /** Empty panes go, empty columns with them; the rest is laid out again. */
  function reflow() {
    for (const side of ["left", "right"]) {
      const c = cols[side];
      if (!c) continue;
      for (const p of [...c.panes]) if (!p.isOpen) { p.destroy(); p.el.remove(); c.panes.splice(c.panes.indexOf(p), 1); if (focused === p) focused = null; }
      layout(c);
    }
    if (!focused || !all().includes(focused)) focused = all()[0] || null;
    paintApp();
  }

  const cur = () => (focused && all().includes(focused) ? focused : all()[0] || newPane(app.settings.splitSide === "left" ? "left" : "right", "bottom"));
  const peek = () => (focused && all().includes(focused) ? focused : all()[0] || null);

  function take(paneId, i) {
    const p = all().find((x) => x.id === paneId);
    return p ? p.take(i) : null;
  }

  /** Open at a place: a side's column as a whole (its first pane), or its top or bottom half. */
  function openAt(side, pos, l, opts) {
    const c = cols[side];
    let pane;
    if (!c || !c.panes.length) pane = newPane(side, "bottom");
    else if (!pos) pane = c.panes[0];
    else if (c.panes.length >= 2) pane = pos === "top" ? c.panes[0] : c.panes[1];
    else pane = newPane(side, pos);
    focused = pane;
    pane.open(l, opts);
  }

  function open(l, opts) {
    const has = all().find((p) => p.has(l)) || (opts && opts.preview ? all().find((p) => p.hasPreview) : null);
    if (has) { focused = has; return has.open(l, opts); }
    cur().open(l, opts);
  }

  window.addEventListener("resize", () => { for (const s of ["left", "right"]) if (cols[s]) layout(cols[s]); });

  return {
    open,
    openAt,
    take,
    close: (i) => { const p = peek(); if (p) p.close(i); },
    closeCurrent: () => { const p = peek(); if (p) p.closeCurrent(); },
    hide() { for (const p of all()) p.hide(); reflow(); },
    render() { for (const p of all()) p.render(); },
    get panes() { return all(); },
    get editor() { const p = peek(); return p ? p.editor : null; },
    get editors() { return all().map((p) => p.editor).filter(Boolean); },
    get fileView() { const p = peek(); return p ? p.fileView : null; },
    get isOpen() { return all().some((p) => p.isOpen); },
    get current() { const p = peek(); return p ? p.current : null; },
    openWeb: (text, opts) => cur().openWeb(text, opts),
    /** Locked to one main tab: shown with it, tucked away with any other. */
    suspend(on) { on = !!on; if (on === suspended) return; suspended = on; for (const p of all()) p.suspend(on); reflow(); },
    get hasPreview() { return all().some((p) => p.hasPreview); },
    dropPreview() { for (const p of all()) p.dropPreview(); },
    get suspended() { return suspended; },
    get side() { const p = peek(); return p ? colOf(p).side : app.settings.splitSide === "left" ? "left" : "right"; },
    /** The pane moves to the other column; the setting says where the next one opens. */
    setSide(s) {
      s = s === "left" ? "left" : "right";
      app.setSetting("splitSide", s);
      const p = peek();
      if (!p) return;
      const from = colOf(p);
      if (from.side === s) return;
      from.panes.splice(from.panes.indexOf(p), 1);
      const to = col(s);
      to.panes.push(p);
      to.el.append(p.el);
      layout(from);
      layout(to);
      hooks.onChange && hooks.onChange();
    },
    get share() { const p = peek(); return p ? colOf(p).share : 0.45; },
    setShare(f) { const p = peek(); if (!p) return; const c = colOf(p); c.share = Math.max(0.1, Math.min(0.9, f)); layout(c); hooks.onChange && hooks.onChange(); },
    swap() { const p = peek(); if (p) p.swap(); },
    has: (l) => all().some((p) => p.has(l)),
    focus() { const p = peek(); if (p) p.focus(); },
    /** what a space remembers: each column's share and its panes' tabs; `tabs` lists them all for the lists that read it */
    state: (o) => ({
      cols: Object.fromEntries(["left", "right"].map((s) => [s, cols[s] ? { share: Math.round(cols[s].share * 1000) / 1000, split: Math.round(cols[s].split * 1000) / 1000, panes: cols[s].panes.map((p) => p.state(o)) } : null])),
      tabs: all().flatMap((p) => p.state(o).tabs),
    }),
    load(s) {
      for (const p of all()) p.load(null);
      reflow();
      if (!s) return;
      // the older shape: one pane, on the settings' side
      if (!s.cols && Array.isArray(s.tabs)) { const side = app.settings.splitSide === "left" ? "left" : "right"; const p = newPane(side, "bottom"); cols[side].share = s.width > 0.1 && s.width < 0.9 ? s.width : 0.45; p.load(s); reflow(); return; }
      for (const side of ["left", "right"]) {
        const c = s.cols && s.cols[side];
        if (!c || !Array.isArray(c.panes)) continue;
        for (const ps of c.panes.slice(0, 2)) { const p = newPane(side, "bottom"); p.load(ps); }
        if (cols[side]) { cols[side].share = c.share > 0.05 && c.share < 0.95 ? c.share : 0.45; cols[side].split = c.split > 0.1 && c.split < 0.9 ? c.split : 0.5; }
      }
      reflow();
    },
    rename(from, to) { for (const p of all()) p.rename(from, to); },
    removed(path) { for (const p of all()) p.removed(path); },
    flush: () => Promise.all(all().map((p) => p.flush())),
  };
}
