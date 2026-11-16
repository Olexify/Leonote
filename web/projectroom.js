// The project room: a folder seen as a whole. A project is a folder with one
// brief note in it (`type: project` at its top, with goal, due, status and
// tags); notes elsewhere carrying one of its tags belong to it too. The room
// shows the brief in its header, every file by kind on the left, a lens in the
// middle (Map: the project's notes and what links to them; Board: its canvas;
// Tasks: tasks filed under it, tagged with it or linking its notes), and its
// chats on the right - an AI tab group bound to the folder, the brief going
// along with every question. Each project can have its own space.

import { h, debounce, basename, dirname } from "./util.js";
import { icon } from "./icons.js";
import { menu } from "./ui.js";
import { frontMatter } from "./frontmatter.js";
import { hiddenWorkspaces, hideWorkspace, workspaceSpace, SUMMARY_NONE_OLD, setFrontField, projectSummary, STATUS_DONE, STATUS_PAUSED, KINDS, SUMMARY_NONE, SUMMARY_SYSTEM, SUMMARY_WAIT, dayKey, esc, extFor, findProjects, kindOf, linkFacts, membersOf, questionsIn, sourceName, summaryPrompt, taskInProject, timelineOf } from "./projects.js";
import { makeResolver } from "./graphcore.js";
import { mountGraph } from "./graph.js";
import { htmlToMd } from "./htmlmd.js";
import { askOnce, activeProvider, whoOf, writeAsAi, mountAssistant } from "./aiview.js";
import { projectThread, saveThread } from "./aitabs.js";

export * from "./projects.js";

/* ── the view ─────────────────────────────────────────────────────────────── */

// replaceChildren writes a null as the word "null"; h() skips it, and so does this
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

/* ── the workspace's files, by kind: the room's rail and the sidebar's Workspace panel ── */
const outsideCache = new Map(); // dir outside the vault -> its listing, { error } or "loading"
const outsideOpen = new Set(); // its folders shown open
const openPath = (app, path, newTab) => (/\.md$/i.test(path) ? app.openNote(path, { newTab }) : app.openFile(path, { newTab }));
const leaf = (path) => path.slice(path.lastIndexOf("/") + 1);
const noteName = (path) => leaf(path).replace(/\.md$/i, "");
/** What the room sends to a model by itself or on a click never carries a private note: not its text, its name or its questions. */
const keptFromAi = (app, path) => !!app.proposals && app.proposals.noteAccess(path) === "private";
/** A private brief's name and goal stay out of whatever is sent about its workspace. */
const workspaceForAi = (app, p) => (keptFromAi(app, p.brief) ? { ...p, name: "this workspace", goal: "", said: "this workspace", briefOut: true } : { ...p, said: `the workspace "${p.name}"` });
/** A source to the model, for its summary. Its fellow notes go by name, the workspace's goal from the brief. */
export async function askSummary(app, p, path, members, src) {
  const kept = (x) => keptFromAi(app, x);
  if (kept(path)) throw new Error("it is private, so it was not sent to AI");
  const names = members.filter((n) => n.path !== path && !kept(n.path)).map((n) => noteName(n.path));
  return askOnce(app, { system: SUMMARY_SYSTEM, prompt: summaryPrompt(workspaceForAi(app, p), names, src) });
}
/** What "Ask what is missing" tells the model about the workspace. */
export function missingText(qs, loose, unread, kept) {
  const q = qs.filter((x) => !kept(x.path)), l = loose.filter((n) => !kept(n.path)), u = unread.filter((f) => !kept(f.path));
  return [
    q.length ? `Questions written in the notes:\n${q.slice(0, 15).map((x) => `- ${x.text} (in [[${noteName(x.path)}]])`).join("\n")}` : "",
    l.length ? `Notes nothing links to: ${l.slice(0, 15).map((n) => `[[${noteName(n.path)}]]`).join(", ")}` : "",
    u.length ? `Sources no note mentions: ${u.slice(0, 15).map((f) => leaf(f.path)).join(", ")}` : "",
  ].filter(Boolean).join("\n\n");
}
export function missingPrompt(app, p, text) {
  const w = workspaceForAi(app, p);
  return `Look at ${w.said} (${w.briefOut ? "" : "its brief is attached; "}you can read its notes). What is it still missing, and what should I do next?\n\n${text}`;
}
export const fitPrompt = (app, p, path) => `How does [[${noteName(path)}]] fit into ${workspaceForAi(app, p).said}? Read it, then name the notes it should link to and why.`;

/** A file of the room carried: onto a window, the side pane, the screen's edges (a pane there), or into a note as a link. */
export function dragPath(e, path) {
  e.dataTransfer.setData("text/plain", `[[${path.replace(/\.md$/i, "")}]]`);
  e.dataTransfer.setData("application/x-leonote-path", path);
  e.dataTransfer.setData("application/x-leonote-paths", JSON.stringify([path]));
}
function outsideRows(app, dir, depth, refresh) {
  const got = outsideCache.get(dir);
  if (!got) {
    outsideCache.set(dir, "loading");
    app.host.outpostList(dir).then((r) => outsideCache.set(dir, r), (e) => outsideCache.set(dir, { error: String(e) })).then(refresh);
  }
  if (!got || got === "loading") return [h("div", { class: "room-hint room-indent", text: "Reading…" })];
  if (got.error) return [h("div", { class: "room-hint room-indent", text: got.error })];
  const pad = { paddingLeft: 6 + depth * 12 + "px" };
  return [
    ...got.folders.flatMap((f) => [
      h("button", { class: "room-row", style: pad, title: f.path, onclick: () => { if (outsideOpen.has(f.path)) outsideOpen.delete(f.path); else outsideOpen.add(f.path); refresh(); } },
        icon(outsideOpen.has(f.path) ? "chevronDown" : "chevron"), h("span", { text: f.name })),
      ...(outsideOpen.has(f.path) ? outsideRows(app, f.path, depth + 1, refresh) : [])]),
    ...got.files.slice(0, 300).map((f) => h("button", { class: "room-row", style: pad, title: f.path,
      onclick: (e) => app.openExternal(f.path, { newTab: e.ctrlKey || e.metaKey }), onauxclick: (e) => { if (e.button === 1) app.openExternal(f.path, { newTab: true }); } },
      icon("file"), h("span", { text: f.name }))),
    // the rest is not listed here: said, with the way to all of it
    ...(got.files.length > 300 || got.capped ? [h("button", { class: "room-row room-hint", style: pad, title: dir, onclick: () => app.host.externalReveal(dir).catch(() => {}) },
      icon("outside"), h("span", { text: `${got.files.length > 300 ? `${got.files.length - 300}${got.capped ? "+" : ""} more` : "More"} - Show in Explorer` }))] : []),
  ];
}
let foldFocus = null; // the group header just folded or opened from the keyboard
/** The rows of a workspace's files, each kind a group that folds (remembered). `q` narrows them by name. */
export function workspaceRows(app, p, mem, { q = "", refresh = () => {}, limit = 200, open = null } = {}) {
  const folded = new Set(app.settings.roomFolded || []);
  const hit = (path) => !q || path.toLowerCase().includes(q);
  const row = (path, ic, sub) => h("button", { class: "room-row", title: path, draggable: true,
    onclick: (e) => (open ? open(path, e) : openPath(app, path, e.ctrlKey || e.metaKey)),
    onauxclick: (e) => { if (e.button === 1) openPath(app, path, true); },
    ondragstart: (e) => dragPath(e, path) },
  icon(ic), h("span", { text: leaf(path).replace(/\.md$/i, "") }), sub ? h("small", { text: sub }) : null);
  const group = (key, label, list, extra = null) => {
    if (!list.length && !extra) return [];
    const shut = folded.has(key) && !q;
    const toggle = () => {
      if (shut) folded.delete(key); else folded.add(key);
      app.setSetting("roomFolded", [...folded]);
      refresh();
    };
    // a header that folds: reachable and usable from the keyboard, and it says whether it is open; folded from the
    // keyboard, the header drawn again has the focus back
    const hdr = h("div", { class: "room-label room-fold" + (shut ? " is-shut" : ""), title: shut ? "Show them" : "Fold them away", tabIndex: 0, role: "button", "aria-expanded": String(!shut), onclick: toggle,
      onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); foldFocus = key; toggle(); } } }, icon("chevronDown"), h("span", { text: label }), list.length ? h("small", { text: String(list.length) }) : null, h("span", { class: "fit-fill" }), extra);
    if (foldFocus === key) { foldFocus = null; requestAnimationFrame(() => { if (hdr.isConnected) hdr.focus(); }); }
    return [hdr, ...(shut ? [] : list.slice(0, limit))];
  };
  const notes = mem.own.filter((n) => n.path !== p.brief && hit(n.path)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const files = mem.files.filter((f) => hit(f.path));
  const reread = (e) => { e.stopPropagation(); for (const d of [...outsideCache.keys()]) if (d === p.outside || d.startsWith(p.outside)) outsideCache.delete(d); refresh(); };
  return [
    row(p.brief, "star", "brief"),
    ...group("notes", "Notes", notes.map((n) => row(n.path, "fileText", dirname(n.path) !== p.folder ? dirname(n.path).slice(p.folder.length + 1) : ""))),
    ...KINDS.flatMap(([k, label, ic]) => group(k, label, files.filter((f) => kindOf(f.path) === k).map((f) => row(f.path, ic)))),
    ...group("other", "Other files", files.filter((f) => kindOf(f.path) === "other").map((f) => row(f.path, "file"))),
    ...group("tagged", "Tagged elsewhere", mem.tagged.filter((n) => hit(n.path)).map((n) => row(n.path, "hash", dirname(n.path)))),
    ...(p.outside ? group("outside", "Outside folder", folded.has("outside") ? [] : outsideRows(app, p.outside, 0, refresh),
      h("span", { class: "room-label-acts" },
        h("button", { class: "icon-btn is-tiny", title: "Read it again", onclick: reread }, icon("rotateRight")),
        h("button", { class: "icon-btn is-tiny", title: `Show ${p.outside} in Explorer`, onclick: (e) => { e.stopPropagation(); app.host.externalReveal(p.outside).catch((err) => app.toast(String(err), { kind: "error" })); } }, icon("outside")))) : []),
  ];
}

/** The sidebar's Workspace panel: the lenses a click away, a new note, the chat, and every file. */
export function workspacePanel(app, p, refresh) {
  const mem = membersOf(p, app.vault.notes.values(), app.vault.files.values());
  const go = (lens) => app.openRoom(p.folder, lens);
  return [
    h("div", { class: "sb-ws-acts" },
      ...LENSES.map(([k, label, ic]) => h("button", { class: "icon-btn", title: label, onclick: () => go(k) }, icon(ic))),
      h("span", { class: "fit-fill" }),
      h("button", { class: "icon-btn", title: "A new note in the workspace", onclick: () => app.newNote({ dir: p.folder, newTab: true }) }, icon("filePlus")),
      h("button", { class: "icon-btn", title: "The workspace's chat", onclick: () => { app.setSetting("roomDock", true); go(null); } }, icon("sparkles"))),
    ...workspaceRows(app, p, mem, { refresh, limit: 80 }),
  ];
}

const LENSES = [["home", "Home", "home"], ["map", "Map", "graph"], ["board", "Board", "grid"], ["tasks", "Tasks", "checkSquare"], ["timeline", "Timeline", "clock"], ["questions", "Open questions", "lightbulb"]];

export function mountRoom(app, el) {
  const S = app.settings;
  const vault = app.vault;
  let lens = LENSES.some(([k]) => k === S.roomLens) ? S.roomLens : "home";
  let filter = "";
  let stopMap = null;
  let board = null; // { path, mounted, save }

  const head = h("header", { class: "room-head" });
  const lensBar = h("div", { class: "segmented is-small room-lenses" });
  const rail = h("aside", { class: "room-rail" });
  const main = h("main", { class: "room-main" });
  const side = h("aside", { class: "room-side" });
  const railGrip = h("div", { class: "room-rail-grip", title: "Drag to make the files wider or narrower · double-click for the usual width" });
  /* A file picked in the room opens beside it (Open here: the split view's preview tab, the very view
     a tab uses) or in a tab of its own (In tabs). Ctrl+click and middle-click always make a tab. */
  /* Where a file picked in the room opens: in a window over the room (Windows), docked beside it in
     the side pane - on the right, with the room only (Docked: each file replacing the last unless that
     one was kept, or each in its own tab), or in a tab of its own (In tabs). Ctrl+click and middle-
     click always make a tab. */
  const openMode = () => S.roomOpenMode || (S.roomOpenHere === false ? "tabs" : "windows");
  // where a file picked in the room opens - a menu in the header, so it is at hand in every lens
  const OPEN_WAYS = [
    ["windows", "new", "In a window - a new one each time", "In small windows over the room; drag their tabs from one to another"],
    ["windows", "front", "In a window - the front one, as a tab", "Into the window in front, as one more tab"],
    ["docked", "replace", "Docked on the right - replacing the last", "The side pane; each file takes the last one's place unless that one was kept (double-click its tab)"],
    ["docked", "tab", "Docked on the right - a tab each", "The side pane, a tab for each file"],
    ["tabs", "", "In a tab of its own", "A tab of the app"],
  ];
  const wayNow = () => { const m = openMode(); return m === "windows" ? (S.roomWinFront ? "front" : "new") : m === "docked" ? (S.roomDockReplace === false ? "tab" : "replace") : ""; };
  function openMenuBtn() {
    const now = OPEN_WAYS.find(([m, w]) => m === openMode() && w === wayNow()) || OPEN_WAYS[0];
    return h("button", { class: "btn btn-sm room-opens", title: `Files open: ${now[2]} (Ctrl+click: always a tab)`, onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.bottom + 4, [{ header: "A file you pick here opens" }, ...OPEN_WAYS.map(([m, w, label, hint]) => ({ label, title: hint, checked: m === openMode() && w === wayNow(), run: () => {
        app.setSetting("roomOpenMode", m);
        if (m === "windows") app.setSetting("roomWinFront", w === "front");
        if (m === "docked") app.setSetting("roomDockReplace", w === "replace");
        paint();
      } }))]);
    } }, icon(openMode() === "windows" ? "layers" : openMode() === "docked" ? "panelRight" : "expand"), "Opens", icon("chevronDown"));
  }
  const kindOfDoc = (path) => (/\.(md|txt)$/i.test(path) && vault.notes.has(path) ? "note" : "file");
  const openFile = (path, e) => {
    const mode = openMode();
    if ((e && (e.ctrlKey || e.metaKey)) || mode === "tabs") return openPath(app, path, !!(e && (e.ctrlKey || e.metaKey)));
    if (mode === "docked") return app.previewBeside({ kind: kindOfDoc(path), path }, { keep: S.roomDockReplace === false });
    openWin(path);
  };

  /* Windows: files opened here in small windows over the room - the very views a tab uses (the note
     editor, the file view: pictures, video, Leopaint, boards…). A window holds tabs: drop a file of the
     room on it to add one. It moves by its title bar, sizes from its corner, minimizes to a chip at the
     foot of the room, and a tab opens in a tab of the app when there is work to do in it. They go when
     the workspace changes. */
  const winLayer = h("div", { class: "rw-layer" });
  const winDock = h("div", { class: "rw-dock" });
  const wins = []; // { tabs: [path], at, el, strip, bodyEl, doc, min }
  let winZ = 10, winFor = "";
  let carry = null; // a window's tab on its way somewhere: it leaves the window when it lands
  // a drop happens only where it was welcome: the carried tab landed
  document.addEventListener("drop", () => { if (carry) carry.landed = true; }, true);
  const nameOfDoc = (path) => leaf(path).replace(/\.md$/i, "");
  function raise(w) { w.el.style.zIndex = String(++winZ); for (const x of wins) x.el.classList.toggle("is-top", x === w); }
  function paintDock() {
    winDock.replaceChildren(...wins.filter((w) => w.min).map((w) => h("button", { class: "rw-chip", title: `${w.tabs.join(", ")} - open it again`, onclick: () => { w.min = false; w.el.hidden = false; raise(w); paintDock(); } },
      icon(kindOfDoc(w.tabs[w.at]) === "note" ? "fileText" : "file"), h("span", { text: nameOfDoc(w.tabs[w.at]) + (w.tabs.length > 1 ? ` +${w.tabs.length - 1}` : "") }))));
    winDock.hidden = !winDock.children.length;
  }
  function closeWin(w) {
    const i = wins.indexOf(w);
    if (i < 0) return;
    wins.splice(i, 1);
    try { w.doc && w.doc.destroy(); } catch {}
    w.el.remove();
    paintDock();
  }
  const closeAllWins = () => { for (const w of [...wins]) closeWin(w); };
  // the window shows its tab `k`: the view of the one before goes
  function showTab(w, k) {
    w.at = Math.max(0, Math.min(w.tabs.length - 1, k));
    try { w.doc && w.doc.destroy(); } catch {}
    w.doc = app.mountDoc(w.bodyEl, { kind: kindOfDoc(w.tabs[w.at]), path: w.tabs[w.at] });
    paintStrip(w);
  }
  function paintStrip(w) {
    w.strip.replaceChildren(...w.tabs.map((path, k) => h("span", { class: "rw-tab" + (k === w.at ? " is-on" : ""), title: path, draggable: true,
      // carried to another window, the app's tabs, the side pane or the screen's edges, it moves there
      ondragstart: (e) => { dragPath(e, path); e.dataTransfer.effectAllowed = "move"; carry = { w, path }; e.stopPropagation(); },
      ondragend: (e) => {
        const c = carry;
        carry = null;
        if (!c || !c.landed) return;
        const at = c.w.tabs.indexOf(c.path);
        if (at >= 0 && wins.includes(c.w)) closeTab(c.w, at);
      },
      onclick: (e) => { if (!e.target.closest("button") && k !== w.at) showTab(w, k); },
      onauxclick: (e) => { if (e.button === 1) closeTab(w, k); } },
      icon(kindOfDoc(path) === "note" ? "fileText" : "file"), h("span", { class: "rw-tab-name", text: nameOfDoc(path) }),
      h("button", { class: "rw-tab-x", title: "Close this one", onclick: () => closeTab(w, k) }, icon("x")))));
  }
  function closeTab(w, k) {
    w.tabs.splice(k, 1);
    if (!w.tabs.length) return closeWin(w);
    showTab(w, k <= w.at ? w.at - (k < w.at ? 1 : 0) : w.at);
  }
  function addTab(w, path) {
    const had = w.tabs.indexOf(path);
    if (had >= 0) return showTab(w, had);
    w.tabs.push(path);
    showTab(w, w.tabs.length - 1);
  }
  function openWin(path) {
    const had = wins.find((w) => w.tabs.includes(path));
    if (had) { had.min = false; had.el.hidden = false; raise(had); showTab(had, had.tabs.indexOf(path)); paintDock(); return; }
    // the front window takes it as a tab, when asked to
    const front = S.roomWinFront ? wins.filter((w) => !w.min).sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0] : null;
    if (front) { addTab(front, path); raise(front); return; }
    if (wins.length >= 8) closeWin(wins[0]); // eight at most: the oldest goes
    const bodyEl = h("div", { class: "rw-body" });
    const strip = h("div", { class: "rw-tabs" });
    const head = h("div", { class: "rw-head", title: "Drag to move · drop a file of the room here to add it as a tab" },
      h("span", { class: "rw-grip", title: "Drag to move the window" }, icon("drag")), strip, h("span", { class: "rw-fill" }),
      h("button", { class: "icon-btn", title: "Minimize to the foot of the room", onclick: () => { w.min = true; el.hidden = true; paintDock(); } }, icon("minus")),
      h("button", { class: "icon-btn", title: "Open this one in a tab of the app", onclick: () => { const t = w.tabs[w.at]; closeTab(w, w.at); openPath(app, t, true); } }, icon("expand")),
      h("button", { class: "icon-btn", title: "Close the window", onclick: () => closeWin(w) }, icon("x")));
    const el = h("div", { class: "rw-win" }, head, bodyEl);
    const w = { tabs: [path], at: 0, el, strip, bodyEl, doc: null, min: false };
    // first on the right of the room (left of the chat), each next one a little further in
    const r = winLayer.getBoundingClientRect();
    const ww = Math.min(560, Math.max(320, r.width * 0.42)), wh = Math.min(620, Math.max(280, r.height * 0.7));
    const k = wins.length % 6;
    const dock = body.classList.contains("no-dock") || body.classList.contains("is-overview") ? 0 : side.getBoundingClientRect().width;
    el.style.width = ww + "px"; el.style.height = wh + "px";
    el.style.left = Math.max(8, r.width - dock - ww - 16 - k * 28) + "px"; el.style.top = 12 + k * 28 + "px";
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, .rw-tab")) return;
      e.preventDefault();
      raise(w);
      head.setPointerCapture(e.pointerId);
      const x0 = e.clientX - el.offsetLeft, y0 = e.clientY - el.offsetTop;
      const move = (m) => {
        el.style.left = Math.max(0, Math.min(winLayer.clientWidth - 80, m.clientX - x0)) + "px";
        el.style.top = Math.max(0, Math.min(winLayer.clientHeight - 30, m.clientY - y0)) + "px";
      };
      const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
    });
    // a file of the room dropped on the window: one more tab in it
    el.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("application/x-leonote-path")) { e.preventDefault(); el.classList.add("is-drop"); } });
    el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("is-drop"); });
    el.addEventListener("drop", (e) => {
      const path2 = e.dataTransfer.getData("application/x-leonote-path");
      el.classList.remove("is-drop");
      if (!path2) return;
      e.preventDefault(); e.stopPropagation();
      // its own tab dropped back on it stays; another window's moves here (it leaves that one on dragend)
      if (carry && carry.w === w) { carry = null; return; }
      addTab(w, path2);
      raise(w);
    });
    el.addEventListener("pointerdown", () => raise(w));
    winLayer.append(el);
    wins.push(w);
    raise(w);
    showTab(w, 0);
    paintDock();
  }
  const body = h("div", { class: "room-body" }, rail, main, side, railGrip, winLayer, winDock);
  const railW = () => Math.max(160, Math.min(480, Number(S.roomRailW) || 220));
  body.style.setProperty("--rail-w", railW() + "px");
  railGrip.addEventListener("dblclick", () => { app.setSetting("roomRailW", 220); body.style.setProperty("--rail-w", "220px"); });
  railGrip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    railGrip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = railW();
    const w = (ev) => Math.max(160, Math.min(480, w0 + ev.clientX - x0));
    const move = (ev) => body.style.setProperty("--rail-w", w(ev) + "px");
    const up = (ev) => { railGrip.removeEventListener("pointermove", move); railGrip.removeEventListener("pointerup", up); app.setSetting("roomRailW", Math.round(w(ev))); };
    railGrip.addEventListener("pointermove", move);
    railGrip.addEventListener("pointerup", up);
  });
  // the files: in the workspace's own space the sidebar has them already, so there the rail starts folded
  const railShown = () => (S.roomRail != null ? S.roomRail !== false : !(spaceProject() && S.sidebar !== false));
  const dockBar = h("div", { class: "room-dock-bar" });
  const dockHost = h("div", { class: "room-dock" });
  const grip = h("div", { class: "room-grip", title: "Drag to make the chat wider or narrower" });
  side.append(grip, dockBar, dockHost);
  const dockW = () => Math.max(260, Math.min(720, Number(S.roomDockW) || 380));
  const placeDock = () => {
    body.style.setProperty("--dock-w", dockW() + "px");
    body.classList.toggle("no-dock", S.roomDock === false);
    const b = head.querySelector(".room-chat-btn");
    if (b) b.classList.toggle("is-on", S.roomDock !== false);
  };
  placeDock();
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = dockW();
    const move = (ev) => body.style.setProperty("--dock-w", Math.max(260, Math.min(720, w0 + x0 - ev.clientX)) + "px");
    const up = (ev) => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); app.setSetting("roomDockW", Math.round(Math.max(260, Math.min(720, w0 + x0 - ev.clientX)))); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  fill(el, h("div", { class: "room" }, head, body));

  const projects = () => findProjects(vault.notes.values());
  const shownProjects = (keep = "") => { const off = hiddenWorkspaces(app); return projects().filter((x) => !off.has(x.folder) || x.folder === keep); };
  // the space you are in may belong to a project: the room opens on it
  const spaceProject = () => { const id = app.currentSpaceId && app.currentSpaceId(); const m = S.roomSpaces || {}; return Object.keys(m).find((f) => m[f] === id) || null; };
  const ALL = "*";
  // A workspace is shown only in its own space; anywhere else (a plain space, a code project)
  // the room lists every workspace, and picking one goes to its space. "All workspaces" inside
  // a workspace's space shows the list there too, until the space changes.
  let showAll = false;
  function current() {
    if (showAll) return null;
    const f = spaceProject();
    return f ? projects().find((p) => p.folder === f) || null : null;
  }
  let lastSpace = null;
  function followSpace() {
    const id = app.currentSpaceId && app.currentSpaceId();
    if (id === lastSpace) return;
    lastSpace = id;
    showAll = false;
    const f = spaceProject();
    if (f && f !== S.roomProject) app.setSetting("roomProject", f);
  }
  // the space changed under an open room: it turns to that space's workspace (or the list)
  app.bus.on("space", () => { if (el.isConnected && !el.closest("[hidden]")) { followSpace(); paint(); } });
  const pick = (folder) => {
    if (folder === ALL) { showAll = true; app.setSetting("roomLast", ALL); paint(); return; }
    showAll = false;
    app.setSetting("roomProject", folder);
    if (!enterSpace(folder)) paint();
  };
  // a workspace has its own space: its tabs are the ones you open while in it. Going to a
  // workspace goes there (made the first time) and shows the room in it. True when it moved.
  function enterSpace(folder) {
    const p = projects().find((x) => x.folder === folder);
    const s = p && workspaceSpace(app, p);
    if (!s || !app.spacesApi || app.currentSpaceId() === s.id) return false;
    lastSpace = s.id;
    const had = (s.tabs || []).length > 0;
    app.spacesApi.switchTo(s.id);
    // back on the tab you left it at; a new workspace space starts on its room
    if (!had) app.openView("room");
    return true;
  }

  const pickFolder = () => app.pickWorkspaceFolder();
  // the workspace's folder in the tree (and the one outside the vault, in Explorer)
  const goFolder = (p) => app.revealInTree(p.brief);
  const folderItems = (p) => [
    { label: "Go to its folder", icon: "folder", run: () => goFolder(p) },
    p.outside ? { label: "Show the outside folder", icon: "outside", run: () => app.host.externalReveal(p.outside).catch((e) => app.toast(String(e), { kind: "error" })) } : null,
    hiddenWorkspaces(app).has(p.folder)
      ? { label: "Show it again", icon: "eye", run: () => { hideWorkspace(app, p.folder, false); paint(); } }
      : { label: "Hide this workspace", icon: "eye", run: () => { hideWorkspace(app, p.folder, true); app.toast(`${p.name} is hidden - All workspaces › Hidden brings it back`, { ms: 3600 }); paint(); } },
  ].filter(Boolean);

  /* ── the header ── */
  function paintHead(p, mem, tasks, asked) {
    const open = tasks.filter((t) => !t.done).length;
    const done = tasks.length - open;
    const picker = h("button", { class: "room-pick", title: "Another workspace", onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.bottom + 4, [
        { label: "All workspaces", icon: "grid", run: () => pick(ALL) },
        "sep",
        ...shownProjects(p.folder).map((x) => ({ label: x.name, icon: "briefcase", checked: x.folder === p.folder, run: () => pick(x.folder) })),
        "sep",
        ...folderItems(p),
        "sep",
        { label: "Make a folder a workspace…", icon: "folderPlus", run: pickFolder },
      ]);
    } }, icon("briefcase"), h("b", { text: p.name }), icon("chevronDown"));
    const goal = p.goal ? h("span", { class: "room-goal", text: p.goal, title: "The goal, from the brief" }) : h("button", { class: "link-btn", onclick: () => app.openNote(p.brief, { newTab: true }) }, "Write the goal in the brief");
    const on = railShown();
    const railBtn = h("button", { class: "icon-btn" + (on ? " is-on" : ""), title: on ? "Fold the files away" : "Show the workspace's files", onclick: () => { app.setSetting("roomRail", !on); body.classList.toggle("no-rail", on); paintHead(p, mem, tasks, asked); } }, icon("sidebar"));
    fill(head, railBtn, picker, goal,
      p.due ? h("span", { class: "room-chip", title: "Due" }, icon("calendar"), p.due) : null,
      p.status ? h("span", { class: "room-chip" }, p.status) : null,
      tasks.length ? h("span", { class: "room-chip is-accent", title: `${open} open, ${done} done` }, `${done} / ${tasks.length} tasks`) : null,
      h("span", { class: "room-chip", title: `${mem.own.length} in ${p.folder}, ${mem.tagged.length} tagged elsewhere` }, `${mem.own.length + mem.tagged.length} notes`),
      asked ? h("button", { class: "room-chip is-accent", title: "Questions written in the workspace's notes, not yet answered", onclick: () => { lens = "questions"; app.setSetting("roomLens", lens); paint(); } }, icon("lightbulb"), `${asked} open question${asked === 1 ? "" : "s"}`) : null,
      h("span", { class: "fit-fill" }),
      h("button", { class: "btn btn-sm", title: "A link or a file: kept in the workspace's Sources, read and summarized into a note", onclick: (e) => addSource(p, e.currentTarget) }, icon("plus"), "Add a source"),
      h("button", { class: "btn btn-sm", title: "Open the brief", onclick: () => app.openNote(p.brief, { newTab: true }) }, icon("fileText"), "Brief"),
      openMenuBtn(),
      h("button", { class: "btn btn-sm room-chat-btn" + (S.roomDock === false ? "" : " is-on"), title: "The workspace's chat, docked on the right", onclick: () => { app.setSetting("roomDock", S.roomDock === false); placeDock(); if (S.roomDock !== false && dock) dock.show(); } }, icon("sparkles"), "Chat"),
      lensBar);
    fill(lensBar, ...LENSES.map(([k, label, ic]) => h("button", { class: "seg" + (k === lens ? " is-active" : ""), onclick: () => { lens = k; app.setSetting("roomLens", k); paint(); } }, icon(ic), label)));
  }


  /* ── the rail: every file, by kind ── */
  function paintRail(p, mem) {
    const q = filter.trim().toLowerCase();
    const search = h("input", { class: "input room-filter", placeholder: "Find in the workspace", value: filter, spellcheck: false });

    search.addEventListener("input", debounce(() => { filter = search.value; const at = search.selectionStart; paint(); const s2 = rail.querySelector(".room-filter"); if (s2) { s2.focus(); s2.setSelectionRange(at, at); } }, 150));
    const STATE = { reading: "reading…", summing: "summarizing…", done: "ready", error: "could not" };
    fill(rail, search,
      ...(reading.length ? [h("div", { class: "room-label" }, "New sources", h("span", { class: "fit-fill" }), reading.every((x) => x.state === "done" || x.state === "error") ? h("button", { class: "link-btn", onclick: () => { reading = []; paint(); } }, "Clear") : null),
        ...reading.map((x) => h("button", { class: "room-row room-reading is-" + x.state, title: x.error || x.path || x.name, onclick: () => x.path && app.openNote(x.path, { newTab: true }) },
          icon(x.state === "error" ? "alert" : x.state === "done" ? "check" : "sparkles"), h("span", { text: x.name }), h("small", { text: STATE[x.state] })))] : []),
      ...workspaceRows(app, p, mem, { q, open: openFile, refresh: () => { const p2 = current(); if (p2) paintRail(p2, membersOf(p2, vault.notes.values(), vault.files.values())); } }));
  }

  /* ── the chat, docked: the project's own chats (the AI tab group bound to its folder) ── */
  let dock = null, dockThread = null, dockFolder = null, dockMine = false;
  let dockCleared = 0; // the last Start over of the docked chat taken in
  const groupOfFolder = (folder) => (S.aiThreadGroups || []).find((g) => g.project === folder) || null;
  const writeThreads = (fn) => { dockMine = true; try { fn(); } finally { dockMine = false; } };
  const dockSave = debounce(() => {
    if (!dock || !dockThread) return;
    // started over in the AI home while this one was answering: nothing of it is kept, and once
    // the answer is done the dock empties too
    const t0 = (S.aiThreads || []).find((x) => x.id === dockThread);
    if (t0 && (t0.cleared || 0) > dockCleared) {
      if (!dock.busy()) { dockCleared = t0.cleared; dock.adopt(t0.msgs || []); const p = current(); if (p && p.folder === dockFolder) paintDockBar(p); }
      return;
    }
    writeThreads(() => saveThread(app, dockThread, dock.messages()));
    const p = current();
    if (p && p.folder === dockFolder) paintDockBar(p); // its title comes from the first question
  }, 700);
  function dockOpen(p, { open = null, fresh = false } = {}) {
    if (dock && dockThread) dockSave.flush();
    const want = open || (fresh ? null : (S.roomChat || {})[p.folder]);
    let id;
    writeThreads(() => { id = projectThread(app, { folder: p.folder, name: p.name, notes: [p.brief], open: want, fresh }); });
    dockThread = id;
    dockFolder = p.folder;
    app.setSetting("roomChat", { ...(S.roomChat || {}), [p.folder]: id });
    const t = (S.aiThreads || []).find((x) => x.id === id);
    if (!dock) {
      dock = mountAssistant(app, dockHost, {
        compact: true,
        writeScope: () => { const g = groupOfFolder(dockFolder); return dockFolder ? { folder: dockFolder, name: (g && g.name) || basename(dockFolder) } : null; },
        onChange: () => dockSave(),
        onClear: () => { dockSave.cancel(); dockCleared = Date.now(); writeThreads(() => saveThread(app, dockThread, [], { cleared: dockCleared })); const p = current(); if (p) paintDockBar(p); },
        onProvider: (pid) => writeThreads(() => app.setSetting("aiThreads", (S.aiThreads || []).map((x) => (x.id === dockThread ? { ...x, provider: pid } : x)))),
        project: () => { const g = groupOfFolder(dockFolder); return g ? { name: g.name || basename(dockFolder), notes: (g.notes || []).filter((x) => vault.notes.has(x)) } : null; },
        keepWithProject: (path, add) => {
          const g = groupOfFolder(dockFolder);
          if (!g) return;
          const notes = (g.notes || []).filter((x) => x !== path);
          writeThreads(() => app.setSetting("aiThreadGroups", (S.aiThreadGroups || []).map((x) => (x.id === g.id ? { ...x, notes: add ? [...notes, path] : notes } : x))));
          dock.projectChanged();
        },
      });
    }
    dockCleared = (t && t.cleared) || 0;
    dock.useProvider(t && t.provider);
    dock.adopt(t ? t.msgs : []);
    dock.projectChanged();
    paintDockBar(p);
    return dock;
  }
  function paintDockBar(p) {
    const g = groupOfFolder(p.folder);
    const chats = g ? [...(S.aiThreads || []), ...(S.aiThreadsClosed || [])].filter((t) => t.group === g.id).sort((a, b) => (b.at || 0) - (a.at || 0)) : [];
    const t = chats.find((x) => x.id === dockThread);
    fill(dockBar,
      h("button", { class: "room-dock-pick", title: "The workspace's chats", onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        menu(r.left, r.bottom + 4, [
          ...chats.slice(0, 40).map((x) => ({ label: x.title || "New chat", icon: "sparkles", checked: x.id === dockThread, keys: String((x.msgs || []).filter((m) => m.role === "user").length), run: () => dockOpen(p, { open: x.id }) })),
          chats.length ? "sep" : null,
          { label: "New chat", icon: "plus", run: () => dockOpen(p, { fresh: true }) },
        ].filter(Boolean));
      } }, icon("sparkles"), h("span", { text: (t && t.title) || "New chat" }), chats.length > 1 ? h("small", { text: String(chats.length) }) : null, icon("chevronDown")),
      h("span", { class: "fit-fill" }),
      h("button", { class: "icon-btn", title: "New chat for the workspace", onclick: () => { dockOpen(p, { fresh: true }); dock.show(); } }, icon("plus")),
      h("button", { class: "icon-btn", title: "Open this chat in the AI home", onclick: () => { dockSave.flush(); app.askProject({ folder: p.folder, name: p.name, notes: [p.brief], open: dockThread }); } }, icon("expand")),
      h("button", { class: "icon-btn", title: "Hide the chat (Chat in the header brings it back)", onclick: () => { app.setSetting("roomDock", false); placeDock(); } }, icon("x")));
  }
  // the same chat written in the AI home: what it says now is shown here too
  app.bus.on("settings", (k) => {
    if (dockMine || !dock || !dockThread || !el.isConnected) return;
    if (k === "aiThreadGroups") { dock.projectChanged(); return; }
    if (k !== "aiThreads" || dock.busy()) return;
    const t = (S.aiThreads || []).find((x) => x.id === dockThread);
    const p = current();
    if (!t) { if (p && p.folder === dockFolder) dockOpen(p); return; }
    // started over in the AI home: emptied here too; else only a longer conversation is taken in -
    // a shorter one is an older save racing this one's
    if ((t.cleared || 0) > dockCleared) { dockCleared = t.cleared; dock.adopt(t.msgs || []); }
    else if ((t.msgs || []).length > dock.messages().filter((m) => !m.live).length) dock.adopt(t.msgs);
    if (p && p.folder === dockFolder) paintDockBar(p);
  });
  // the room's own questions go to the dock
  function askDock(p, prompt, opts = {}) {
    if (S.roomDock === false) { app.setSetting("roomDock", true); placeDock(); }
    const d = dockFolder === p.folder && !opts.fresh ? dock : dockOpen(p, opts);
    if (prompt) d.ask({ prompt }); else d.show();
  }

  /* ── lens: the map - the graph itself (graph.js), showing the workspace's notes and files only.
     Its look is kept apart from the main graph's, and it never writes graph.json. ── */
  let graph = null, graphEl = null, graphFor = "", graphKey = "", members = null;
  function mapLens(p, mem) {
    const ids = [...mem.own, ...mem.tagged, ...mem.files].map((x) => x.path);
    members = new Set(ids);
    if (!graphEl) {
      graphEl = h("div", { class: "room-graph" });
      graph = mountGraph(app, graphEl, { key: "roomGraph", saved: false, members: () => members, defaults: { panel: false } });
    }
    graphEl.hidden = false;
    fill(main, graphEl, glanceDrawer(p, mem, ids.length));
    const key = ids.sort().join("|");
    if (graphFor !== p.folder || key !== graphKey) { graph.rescope(graphFor !== p.folder); graphFor = p.folder; graphKey = key; }
    else graph.show();
    return () => { graphEl.hidden = true; };
  }

  /* ── under the map: a drawer with the workspace at a glance - its numbers, what changed,
     its boards, pictures and media as tiles. Folds to one line (remembered). ── */
  function glanceDrawer(p, mem, shown) {
    const open = S.roomDrawer !== false;
    const ago = (t) => agoText(t);
    const tile = (f, kind) => {
      const name = leaf(f.path).replace(/\.md$/i, "");
      const pic = kind === "image" ? h("span", { class: "room-tile-pic", style: { backgroundImage: `url("${app.host.assetUrl(f.path)}")` } }) : h("span", { class: "room-tile-pic is-icon" }, icon(kind === "board" ? "grid" : kind === "video" ? "film" : kind === "sound" ? "music" : kind === "source" ? "book" : "fileText"));
      return h("button", { class: "room-tile", title: f.path, draggable: true, ondragstart: (e) => dragPath(e, f.path), onclick: (e) => openFile(f.path, e) }, pic, h("span", { class: "room-tile-name", text: name }), h("small", { text: ago(f.mtime) }));
    };
    const byTime = (a, b) => (b.mtime || 0) - (a.mtime || 0);
    const images = mem.files.filter((f) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.path)).sort(byTime);
    const videos = mem.files.filter((f) => /\.(mp4|webm|mov|mkv|m4v|leovideo)$/i.test(f.path)).sort(byTime);
    const sounds = mem.files.filter((f) => /\.(mp3|wav|flac|m4a|ogg|opus)$/i.test(f.path)).sort(byTime);
    const boards = mem.files.filter((f) => kindOf(f.path) === "boards").sort(byTime);
    const sources = mem.files.filter((f) => kindOf(f.path) === "sources").sort(byTime);
    const recent = [...mem.own, ...mem.tagged, ...mem.files].sort(byTime).slice(0, 14);
    const rowOf = (label, list, kind) => (list.length ? h("div", { class: "room-drawer-row" }, h("div", { class: "room-label", text: `${label} ${list.length}` }), h("div", { class: "room-tiles" }, ...list.slice(0, 30).map((f) => tile(f, typeof kind === "function" ? kind(f) : kind)))) : null);
    const kindOfFile = (f) => (/\.md$/i.test(f.path) ? "note" : /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.path) ? "image" : kindOf(f.path) === "boards" ? "board" : /\.(mp4|webm|mov|mkv|m4v)$/i.test(f.path) ? "video" : kindOf(f.path) === "sources" ? "source" : "file");
    const tasks = tasksOf(p, mem);
    const stat = (n, label, run) => h("button", { class: "room-stat", onclick: run || null }, h("b", { text: String(n) }), h("span", { text: label }));
    const head = h("div", { class: "room-drawer-head", onclick: (e) => { if (e.target.closest("a, .link-btn")) return; app.setSetting("roomDrawer", !open); paint(); } },
      icon("chevronDown"), h("b", { text: "At a glance" }),
      h("span", { class: "room-hint", text: `${shown} on the map` }),
      h("span", { class: "fit-fill" }),
      h("button", { class: "link-btn", onclick: (e) => {
        e.stopPropagation();
        app.openView("graph");
        // through the graph, so its Back returns to what it showed before
        if (app.graphScope) app.graphScope("folder", p.folder);
        else { app.setSetting("graph", { ...(S.graph || {}), scope: "folder", folder: p.folder }); }
      } }, "Open in the graph"));
    const drawer = h("div", { class: "room-drawer" + (open ? " is-open" : ""), style: open && S.roomDrawerH ? { height: `${S.roomDrawerH}px` } : null });
    // its top edge moves up and down (remembered); double-click: back to the usual height
    const grip = open ? h("div", { class: "room-drawer-grip", title: "Drag up or down · double-click for the usual height",
      ondblclick: () => { app.setSetting("roomDrawerH", 0); drawer.style.height = ""; },
      onpointerdown: (e) => {
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        const y0 = e.clientY, h0 = drawer.getBoundingClientRect().height;
        const room = main.getBoundingClientRect().height;
        const hh = (ev) => Math.max(90, Math.min(room - 80, h0 + y0 - ev.clientY));
        const move = (ev) => { drawer.style.height = hh(ev) + "px"; };
        const up = (ev) => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); app.setSetting("roomDrawerH", Math.round(hh(ev))); };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
      } }) : null;
    drawer.append(...[grip, head, open ? h("div", { class: "room-drawer-body" },
      h("div", { class: "room-stats" },
        stat(mem.own.length + mem.tagged.length, "notes"), stat(mem.files.length, "files"), stat(sources.length, "sources", () => setLens("home")),
        stat(boards.length, "boards", () => setLens("board")), stat(tasks.filter((t) => !t.done).length, "open tasks", () => setLens("tasks")),
        stat(openQuestions(p, mem).length, "open questions", () => setLens("questions")),
        p.outside ? stat("↗", "outside folder", () => app.host.externalReveal(p.outside).catch(() => {})) : null),
      rowOf("Recent", recent, kindOfFile),
      rowOf("Boards and canvases", boards, "board"),
      rowOf("Pictures", images, "image"),
      rowOf("Videos and animations", videos, "video"),
      rowOf("Sound", sounds, "sound"),
      rowOf("Sources", sources, "source")) : null].filter(Boolean));
    return drawer;
  }

  /* ── lens: home - the workspace at a glance: what changed, what was read, what is open ── */
  async function newBoard(p) {
    let np = `${p.folder}/${p.name} board.canvas`;
    for (let i = 2; vault.files.has(np); i++) np = `${p.folder}/${p.name} board ${i}.canvas`;
    try { await app.writeBoard(np, { nodes: [], edges: [] }); app.setSetting("roomBoards", { ...(S.roomBoards || {}), [p.folder]: np }); return np; } catch (e) { app.toast("Could not make the board: " + e, { kind: "error" }); return null; }
  }
  const setLens = (k) => { lens = k; app.setSetting("roomLens", k); paint(); };
  function homeLens(p, mem, tasks, qs) {
    const ago = (t) => agoText(t);
    const card = (title, ic, more, ...rows) => h("section", { class: "room-home-card" },
      h("div", { class: "room-home-head" }, icon(ic), h("b", { text: title }), h("span", { class: "fit-fill" }), more),
      ...(rows.flat().filter(Boolean).length ? rows.flat() : [h("div", { class: "room-hint", text: "Nothing yet." })]));
    // a line that is a file of the vault carries like the rail's rows
    const line = (ic, text, sub, run, title = "") => h("button", { class: "room-row", title, onclick: run, draggable: !!title && (vault.files.has(title) || vault.notes.has(title)), ondragstart: (e) => dragPath(e, title) }, icon(ic), h("span", { text }), sub ? h("small", { text: sub }) : null);
    const more = (label, run) => h("button", { class: "link-btn", onclick: run }, label);
    // recent: notes and files, by when they changed - and the outside folder's, once read
    const outside = p.outside && outsideCache.get(p.outside);
    const recent = [
      ...[...mem.own, ...mem.tagged].map((n) => ({ path: n.path, at: n.mtime || 0, ic: n.path === p.brief ? "star" : "fileText" })),
      ...mem.files.map((f) => ({ path: f.path, at: f.mtime || 0, ic: (KINDS.find((k) => k[0] === kindOf(f.path)) || [0, 0, "file"])[2] })),
      ...(outside && outside.files ? outside.files.map((f) => ({ path: f.path, at: f.mtime || 0, ic: "outside", out: true })) : []),
    ].sort((a, b) => b.at - a.at).slice(0, 10);
    // research: the sources kept in the workspace, newest first
    const sources = [
      ...mem.own.filter((n) => /^---[\s\S]*?\ntype: source\b/.test(n.content.slice(0, 400))).map((n) => ({ path: n.path, at: n.mtime || 0, ic: "book", wait: n.content.includes(SUMMARY_NONE) || n.content.includes(SUMMARY_WAIT) })),
      ...mem.files.filter((f) => kindOf(f.path) === "sources").map((f) => ({ path: f.path, at: f.mtime || 0, ic: "file" })),
    ].sort((a, b) => b.at - a.at);
    const gids = new Set((S.aiThreadGroups || []).filter((g) => g.project === p.folder).map((g) => g.id));
    const chats = [...(S.aiThreads || []), ...(S.aiThreadsClosed || [])].filter((t) => gids.has(t.group) && (t.msgs || []).length).sort((a, b) => (b.at || 0) - (a.at || 0));
    const open = tasks.filter((t) => !t.done).sort((a, b) => String(a.due_date || "9").localeCompare(String(b.due_date || "9")));
    const sum = projectSummary(p, { notes: vault.notes.values(), files: vault.files.values(), tasks: app.tasks.all.filter((t) => !t.deleted), chats, answered: answered(p) });
    const maxDay = Math.max(1, ...sum.strip);
    const taskIn = h("input", { class: "input room-task-in", placeholder: "A task (Enter)" });
    taskIn.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !taskIn.value.trim()) return;
      const tag = p.tags[0] && !new RegExp(`#${esc(p.tags[0])}\\b`, "i").test(taskIn.value) ? ` #${p.tags[0]}` : "";
      app.tasks.create(taskIn.value.trim() + tag, { project: p.folder });
      taskIn.value = "";
      paint();
    });
    const act = (ic, label, run, title = "") => h("button", { class: "btn btn-sm", title, onclick: run }, icon(ic), label);
    fill(main, h("div", { class: "room-home" },
      h("div", { class: "room-home-acts" },
        act("filePlus", "New note", () => app.newNote({ dir: p.folder, newTab: true }), `A note in ${p.folder}`),
        act("plus", "Add a source", (e) => addSource(p, e.currentTarget), "A link or a file, read and summarized into a note"),
        act("grid", "New board", async () => { if (await newBoard(p)) setLens("board"); }),
        act("sparkles", "New chat", () => askDock(p, "", { fresh: true })),
        act("folder", "Its folder", () => goFolder(p), "Show it in the file tree"),
        h("span", { class: "fit-fill" }),
        h("div", { class: "room-home-strip", title: "The last two weeks" }, ...sum.strip.map((c) => h("span", { class: c ? "" : "is-empty", style: `--h:${Math.round((c / maxDay) * 100)}%` }))),
        h("small", { class: "room-hint", text: sum.last ? `last change ${ago(sum.last)}` : "" })),
      h("div", { class: "room-home-grid" },
        card("Recent", "clock", more("Timeline", () => setLens("timeline")),
          recent.map((r) => line(r.ic, leaf(r.path).replace(/\.md$/i, ""), ago(r.at), (e) => (r.out ? app.openExternal(r.path, { newTab: e.ctrlKey }) : openFile(r.path, e)), r.path))),
        card("Research", "book", more("Add a source", (e) => addSource(p, e.currentTarget)),
          reading.map((x) => line(x.state === "error" ? "alert" : x.state === "done" ? "check" : "sparkles", x.name, x.state, () => x.path && app.openNote(x.path, { newTab: true }))),
          sources.slice(0, 8).map((r) => line(r.ic, leaf(r.path).replace(/\.md$/i, ""), r.wait ? "not summarized" : ago(r.at), (e) => openFile(r.path, e), r.path)),
          sources.length > 8 ? h("small", { class: "room-hint", text: `and ${sources.length - 8} more in the files` }) : null),
        card("Open questions", "lightbulb", qs.length ? more("All of them", () => setLens("questions")) : null,
          qs.slice(0, 6).map((q) => line("lightbulb", q.text, nameOf(q.path), (e) => app.openNote(q.path, { line: q.line, newTab: e.ctrlKey }), q.path))),
        card("Tasks", "checkSquare", more(open.length ? `${open.length} open` : "Tasks", () => setLens("tasks")), taskIn,
          open.slice(0, 6).map((t) => h("div", { class: "room-task" },
            h("button", { class: "room-check", title: "Done", onclick: () => { app.tasks.toggle(t.id); paint(); } }),
            h("span", { class: "room-task-t", text: t.text }), t.due_date ? h("small", { text: t.due_date }) : null))),
        card("Chats", "sparkles", more("New chat", () => askDock(p, "", { fresh: true })),
          chats.slice(0, 6).map((t) => line("sparkles", t.title || "Chat", ago(t.at), () => askDock(p, "", { open: t.id })))))));
  }

  /* ── lens: the board ── */
  async function boardLens(p, mem) {
    const boards = mem.files.filter((f) => /\.canvas$/i.test(f.path)).map((f) => f.path);
    const want = p.board && boards.find((b) => b === p.board || b.endsWith("/" + p.board) || b.replace(/\.canvas$/i, "").endsWith(p.board));
    const path = want || boards.find((b) => b === S.roomBoards?.[p.folder]) || boards[0];
    const make = h("button", { class: "btn btn-sm", onclick: async () => { if (await newBoard(p)) paint(); } }, icon("plus"), "New board");
    if (!path) { fill(main, h("div", { class: "room-empty" }, h("p", { text: "No board in this workspace yet - a canvas to lay out sources, notes and the argument." }), make)); return; }
    const host = h("div", { class: "room-board" });
    const bar = h("div", { class: "room-legend" },
      boards.length > 1 ? h("button", { class: "btn btn-sm", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, boards.map((b) => ({ label: basename(b).replace(/\.canvas$/i, ""), checked: b === path, run: () => { app.setSetting("roomBoards", { ...(S.roomBoards || {}), [p.folder]: b }); paint(); } }))); } }, icon("grid"), basename(path).replace(/\.canvas$/i, ""), icon("chevronDown"))
        : h("span", { class: "room-hint", text: basename(path).replace(/\.canvas$/i, "") }),
      h("span", { class: "fit-fill" }), make,
      h("button", { class: "btn btn-sm", onclick: () => app.openFile(path, { newTab: true }) }, icon("expand"), "Open in a tab"));
    fill(main, host, bar);
    try {
      const [mod, text] = await Promise.all([import("./board.js"), app.host.readText(path)]);
      if (lens !== "board" || !host.isConnected) return;
      let b = null;
      const save = debounce(async () => { if (!b) return; try { await app.host.writeFile(path, new TextEncoder().encode(b.getText())); } catch (e) { app.toast("Could not save the board: " + e, { kind: "error" }); } }, 600);
      b = await mod.mountBoard(host, text, { app, path, onChange: save });
      // the room moved on while it was loading: let it go, or it would stay alive with no screen and save over the file
      if (lens !== "board" || !host.isConnected) { b.destroy(); return; }
      board = { destroy: () => { save.flush(); b.destroy(); } };
    } catch (e) { fill(host, h("div", { class: "room-empty", text: "Could not open the board: " + e })); }
  }

  const resolver = () => makeResolver(vault.notes.keys(), (t, from) => vault.resolve(t, from));
  const nameOf = noteName;
  const kept = (path) => keptFromAi(app, path);
  const today = () => dayKey(Date.now());
  // questions marked answered here, by project: "path#text"
  const answered = (p) => new Set((S.roomAnswered || {})[p.folder] || []);
  const markAnswered = (p, q) => { const all = { ...(S.roomAnswered || {}) }; all[p.folder] = [`${q.path}#${q.text}`, ...(all[p.folder] || [])].slice(0, 500); app.setSetting("roomAnswered", all); paint(); };
  function openQuestions(p, mem) {
    const done = answered(p);
    return [...mem.own, ...mem.tagged].flatMap((n) => questionsIn(n.path, n.content)).filter((q) => !done.has(`${q.path}#${q.text}`));
  }
  const ask = (p, prompt) => askDock(p, prompt);

  /* ── new sources: a link or a file in, a summarized note out ── */
  let reading = []; // { name, state: "reading" | "summing" | "done" | "error", path?, error? }
  function addSource(p, anchor) {
    const back = h("div", { class: "room-add-back", onclick: (e) => { if (e.target === back) back.remove(); } });
    const input = h("input", { class: "input", placeholder: "Paste a link to a page or a PDF", spellcheck: false });
    const picker = h("input", { type: "file", multiple: true, hidden: true, accept: ".pdf,.epub,.txt,.md,.html,.htm,.docx" });
    const go = () => { const v = input.value.trim(); if (!v) return; back.remove(); capture(p, { url: /^https?:\/\//i.test(v) ? v : "https://" + v }); };
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") back.remove(); });
    picker.addEventListener("change", () => { const fs = [...picker.files]; back.remove(); for (const f of fs) capture(p, { file: f }); });
    const r = anchor.getBoundingClientRect();
    back.append(h("div", { class: "room-add", style: `top:${r.bottom + 6}px;left:${Math.max(12, Math.min(r.left, innerWidth - 440))}px` },
      h("b", { text: `A source for ${p.name}` }),
      h("p", { class: "room-hint", text: `Kept in ${p.folder}/Sources with a note beside it. ${activeProvider(app) ? `${whoOf(activeProvider(app))} reads it and writes the summary - what it says, quotes, what it means here with links to your notes, and its open questions.` : "Set up a model in Settings › Assistant to have it summarized."}` }),
      input,
      h("div", { class: "room-add-row" }, h("button", { class: "btn", onclick: () => picker.click() }, icon("file"), "Choose files…"), h("span", { class: "fit-fill" }), h("button", { class: "btn btn-primary", onclick: go }, "Add")),
      picker));
    document.body.append(back);
    input.focus();
  }
  // a file dropped on the room is a source too
  el.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  el.addEventListener("drop", (e) => {
    const fs = e.dataTransfer ? [...e.dataTransfer.files] : [];
    const p = current();
    if (!fs.length || !p) return;
    e.preventDefault();
    for (const f of fs) capture(p, { file: f });
  });

  async function keepFile(dir, name, bytes) {
    let path = `${dir}/${name}`;
    const dot = name.lastIndexOf(".");
    for (let i = 2; vault.files.has(path) || vault.notes.has(path); i++) path = `${dir}/${name.slice(0, dot)} ${i}${name.slice(dot)}`;
    const entry = await app.host.writeFile(path, bytes);
    if (entry && entry.path) vault.setFiles([...[...vault.files.values()].filter((f) => f.path !== entry.path), entry]);
    return (entry && entry.path) || path;
  }
  async function fileText(path, bytes) {
    if (/\.pdf$/i.test(path)) {
      const { openDocument } = await import("./pdfview.js");
      const doc = await openDocument(bytes);
      const parts = [];
      for (let i = 1; i <= Math.min(doc.numPages, 80); i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        parts.push(`[page ${i}]\n` + tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(""));
      }
      doc.loadingTask.destroy();
      return parts.join("\n\n");
    }
    if (/\.(txt|md|html?)$/i.test(path)) { const t = new TextDecoder().decode(bytes); return /\.html?$/i.test(path) ? readPage(t).md : t; }
    return "";
  }
  // a page's own text: its article or main part, without menus, scripts and footers
  function readPage(html) {
    const d = new DOMParser().parseFromString(html, "text/html");
    const og = d.querySelector('meta[property="og:title"]');
    const title = (og && og.getAttribute("content")) || (d.querySelector("title") || {}).textContent || "";
    for (const x of d.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,iframe,svg,button")) x.remove();
    const main2 = d.querySelector("article") || d.querySelector("main") || d.querySelector('[role="main"]') || d.body;
    return { title: title.trim(), md: main2 ? htmlToMd(main2.innerHTML).replace(/\n{3,}/g, "\n\n").trim() : "" };
  }
  const stamp = () => dayKey(Date.now());
  const setReading = (it, o) => { Object.assign(it, o); const p = current(); if (p) paintRail(p, membersOf(p, vault.notes.values(), vault.files.values())); };

  async function capture(p, { url = null, file = null }) {
    const it = { name: file ? file.name : url, state: "reading" };
    reading = [it, ...reading].slice(0, 8);
    setReading(it, {});
    const dir = `${p.folder}/Sources`;
    const tag = p.tags[0] ? `\ntags: [${p.tags[0]}]` : "";
    try {
      if (!vault.folders.has(dir)) await vault.createFolder(dir).catch(() => {});
      let title, text = "", body;
      if (url) {
        const r = await app.host.sourceFetch(url);
        if (r.text != null && !/pdf/i.test(r.type)) {
          const page = readPage(r.text);
          title = sourceName(r.url, page.title);
          text = page.md;
          body = `---\ntype: source\nsource: ${r.url}\ncaptured: ${stamp()}${tag}\n---\n# ${title}\n\n${r.url}\n\n## Summary\n\n${activeProvider(app) ? SUMMARY_WAIT : SUMMARY_NONE}\n\n## The page\n\n${text.slice(0, 80000)}\n`;
        } else {
          const bytes = r.b64 != null ? Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(r.text || "");
          const name = sourceName(r.url);
          const kept = await keepFile(dir, name + extFor(name, r.type), bytes);
          title = basename(kept).replace(/\.[^.]+$/, "");
          text = await fileText(kept, bytes).catch(() => "");
          body = `---\ntype: source\nsource: ${r.url}\ncaptured: ${stamp()}${tag}\n---\n# ${title}\n\nSource: [[${kept.slice(kept.lastIndexOf("/") + 1)}]] · ${r.url}\n\n## Summary\n\n${activeProvider(app) && text ? SUMMARY_WAIT : text ? SUMMARY_NONE : "_No text could be read from it - a scan, perhaps._"}\n`;
        }
      } else {
        // read whole into the page and handed over: a huge video goes into the vault through the file tree instead
        if (file.size > 100 * 1048576) throw new Error("it is larger than 100 MB - put it in the vault through the file tree");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const kept = await keepFile(dir, sourceName("", file.name.replace(/\.[^.]+$/, "")) + (file.name.match(/\.[^.]+$/) || [""])[0], bytes);
        title = basename(kept).replace(/\.[^.]+$/, "");
        text = await fileText(kept, bytes).catch(() => "");
        body = `---\ntype: source\ncaptured: ${stamp()}${tag}\n---\n# ${title}\n\nSource: [[${kept.slice(kept.lastIndexOf("/") + 1)}]]\n\n## Summary\n\n${activeProvider(app) && text ? SUMMARY_WAIT : text ? SUMMARY_NONE : "_No text could be read from it - a scan, perhaps._"}\n`;
      }
      const path = await vault.create(dir, vault.notes.has(`${dir}/${title}.md`) ? `${title} (source)` : title, body);
      setReading(it, { path, name: title });
      if (activeProvider(app) && text) await summarize(p, path, text, url, it);
      else setReading(it, { state: "done" });
      paint();
    } catch (e) {
      setReading(it, { state: "error", error: String(e && e.message ? e.message : e) });
      app.toast(`Could not add ${it.name}: ${it.error}`, { kind: "error" });
    }
  }
  // the source's own text: the page kept in its note, or the file it links
  async function sourceText(path) {
    const n = vault.notes.get(path);
    if (!n) return "";
    const page = /\n## The page\n([\s\S]*)$/.exec(n.content);
    if (page) return page[1].trim();
    const link = /Source: \[\[([^\]|]+)/.exec(n.content);
    const f = link && vault.resolveFile && vault.resolveFile(link[1], path);
    if (!f || kept(f.path || f)) return "";
    const bytes = new Uint8Array(await (await fetch(app.host.assetUrl(f.path || f), { cache: "no-store" })).arrayBuffer());
    return fileText(f.path || f, bytes);
  }
  async function summarize(p, path, text = null, url = null, it = null) {
    const item = it || { name: basename(path), path, state: "summing" };
    if (!it) reading = [item, ...reading].slice(0, 8);
    setReading(item, { state: "summing" });
    try {
      const src = text != null ? text : await sourceText(path);
      if (!src.trim()) throw new Error("no text to read in it");
      const n0 = vault.notes.get(path);
      const fm = frontMatter(n0 ? n0.content : "");
      const mem = membersOf(p, vault.notes.values(), vault.files.values());
      const { text: out, who } = await askSummary(app, p, path, [...mem.own, ...mem.tagged], { title: basename(path), url: url || fm.source || "", text: src });
      // its own big headings would end the Summary section early: they become ###
      const out2 = out.trim().replace(/^#{1,2} /gm, "### ");
      const now = (vault.notes.get(path) || {}).content || "";
      const at = /## Summary\n\n([\s\S]*?)(?=\n## |$)/.exec(now);
      const next = at ? now.slice(0, at.index) + `## Summary\n\n${out2}\n` + now.slice(at.index + at[0].length) : now.replace(/\s*$/, "") + `\n\n## Summary\n\n${out2}\n`;
      const r = await writeAsAi(app, path, next, "write", who, `Summary of a new source for ${p.name}`, () => vault.write(path, next, {}));
      setReading(item, { state: r === "private" ? "error" : "done", error: r === "private" ? "the note was not changed" : "" });
      if (r === "written") app.toast(`${basename(path)} is summarized`, { ms: 2600, action: { label: "Open", run: () => app.openNote(path, { newTab: true }) } });
    } catch (e) {
      setReading(item, { state: "error", error: String(e && e.message ? e.message : e) });
      // a private source is never read: its note must not go on saying it is being read
      const c = (vault.notes.get(path) || {}).content || "";
      if (kept(path) && c.includes(SUMMARY_WAIT)) vault.write(path, c.replace(SUMMARY_WAIT, "_Private, so it was not sent to AI._"), {}).catch(() => {});
    }
  }
  const unsummarized = (mem) => mem.own.filter((n) => /^---[\s\S]*?\ntype: source\b/.test(n.content.slice(0, 400)) && (n.content.includes(SUMMARY_NONE) || n.content.includes(SUMMARY_NONE_OLD) || n.content.includes(SUMMARY_WAIT)));

  /* ── lens: open questions - what the project still lacks ── */
  function questionsLens(p, mem, tasks, qs) {
    const inside = new Set([...mem.own, ...mem.tagged].map((n) => n.path));
    const facts = linkFacts(vault.notes.values(), inside, resolver(), vault.resolveFile ? (t, from) => vault.resolveFile(t, from) : null);
    const loose = [...mem.own, ...mem.tagged].filter((n) => n.path !== p.brief && !facts.out.has(n.path) && !facts.in.has(n.path));
    const unread = mem.files.filter((f) => kindOf(f.path) === "sources" && !facts.files.has(f.path));
    const busy = new Set(reading.filter((x) => x.state === "reading" || x.state === "summing").map((x) => x.path));
    const unsummed = unsummarized(mem).filter((n) => !busy.has(n.path) && !kept(n.path));
    const stubs = mem.own.filter((n) => n.path !== p.brief && typeof n.words === "number" && n.words < 25 && !loose.includes(n));
    const late = tasks.filter((t) => !t.done && t.due_date && t.due_date < today());
    const act = (label, ic, run, title = "") => h("button", { class: "btn btn-sm", title, onclick: run }, icon(ic), label);
    const sec = (title, hint, rows) => (rows.length ? h("section", { class: "room-q" }, h("div", { class: "room-q-head" }, h("b", { text: `${title} ${rows.length}` }), h("span", { class: "room-hint", text: hint })), ...rows.slice(0, 60)) : null);
    const row = (main2, sub2, ...acts) => h("div", { class: "room-q-row" }, h("div", { class: "room-q-text" }, main2, sub2 ? h("small", { text: sub2 }) : null), h("div", { class: "room-q-acts" }, ...acts));
    const link = (text, path, line) => h("button", { class: "link-btn room-q-link", text, title: path, onclick: (e) => app.openNote(path, { line, newTab: e.ctrlKey }) });
    const tag = p.tags[0] ? ` #${p.tags[0]}` : "";
    const sourceNote = async (f) => {
      const base = nameOf(f.path).replace(/\.[^.]+$/, "");
      try {
        const np = await vault.create(dirname(f.path), `${base} - notes`, `Source: [[${f.path.slice(f.path.lastIndexOf("/") + 1)}]]\n\n## What it says\n\n## What it means for ${p.name}\n`);
        app.openNote(np, { newTab: true });
      } catch (e) { app.toast("Could not make the note: " + e, { kind: "error" }); }
    };
    const total = qs.length + loose.length + unread.length + stubs.length + late.length + unsummed.length;
    const summary = () => missingText(qs, loose, unread, kept);
    fill(main, h("div", { class: "room-qs" },
      h("div", { class: "room-q-top" },
        h("span", { class: "room-hint", text: total ? "What the workspace still lacks: questions you wrote down, notes standing alone, sources nobody has read into a note." : "Nothing open: every question is answered, every note linked, every source read into a note." }),
        h("span", { class: "fit-fill" }),
        total ? act("Ask what is missing", "sparkles", () => ask(p, missingPrompt(app, p, summary()))) : null),
      sec("Questions you wrote", "lines ending in ? and items under a Questions heading", qs.map((q) => row(link(q.text, q.path, q.line), nameOf(q.path),
        act("Task", "checkSquare", () => { app.tasks.create(`${q.text} [[${nameOf(q.path)}]]${tag}`, { project: p.folder }); app.toast("Task added", { ms: 1600 }); paint(); }, "A task to answer it"),
        kept(q.path) ? null : act("Ask", "sparkles", () => ask(p, `${q.text}\n\n(from [[${nameOf(q.path)}]] - answer from the workspace's notes, and say what is still unknown)`), "Ask the workspace chat"),
        act("Answered", "check", () => markAnswered(p, q), "Take it off this list")))),
      sec("Notes nothing links to", "no link out, none in", loose.map((n) => row(link(nameOf(n.path), n.path), dirname(n.path),
        kept(n.path) ? null : act("Ask how it fits", "sparkles", () => ask(p, fitPrompt(app, p, n.path)))))),
      sec("Sources not summarized yet", activeProvider(app) ? `${whoOf(activeProvider(app))} reads them` : "set up a model first", unsummed.map((n) => row(link(nameOf(n.path), n.path), dirname(n.path),
        activeProvider(app) ? act("Summarize", "sparkles", () => { summarize(p, n.path); paint(); }) : act("Set up a model", "settings", () => app.openView("assistant"))))),
      sec("Sources no note talks about", "no note links to them yet", unread.map((f) => row(h("button", { class: "link-btn room-q-link", text: f.path.slice(f.path.lastIndexOf("/") + 1), onclick: () => app.openFile(f.path, { newTab: true }) }), dirname(f.path),
        act("Make a note on it", "filePlus", () => sourceNote(f), "A note beside it that links it, with room for what it says and what it means here")))),
      sec("Barely started", "fewer than 25 words", stubs.map((n) => row(link(nameOf(n.path), n.path), `${n.words} words`))),
      sec("Overdue tasks", "", late.map((t) => row(h("span", { text: t.text }), `due ${t.due_date}`, act("Done", "check", () => { app.tasks.toggle(t.id); paint(); })))),
      total ? null : h("div", { class: "room-empty" }, icon("check"))));
  }

  /* ── lens: timeline - what happened, by day ── */
  let tlKind = "all";
  function timelineLens(p, mem, tasks) {
    const ids = new Set((S.aiThreadGroups || []).filter((g) => g.project === p.folder).map((g) => g.id));
    const chats = [...(S.aiThreads || []), ...(S.aiThreadsClosed || [])].filter((t) => ids.has(t.group));
    const all = timelineOf({ notes: [...mem.own, ...mem.tagged], files: mem.files, tasks, chats }, { since: Date.now() - 90 * 86400000 });
    const KIND = { note: ["Notes", "fileText", "edited"], file: ["Files", "file", "changed"], task: ["Tasks", "plus", "task added"], done: ["Tasks", "check", "done"], chat: ["Chats", "sparkles", "chat"] };
    const shown = all.filter((e) => tlKind === "all" || KIND[e.kind][0] === tlKind);
    const yest = dayKey(Date.now() - 86400000);
    const dayName = (d) => (d === today() ? "Today" : d === yest ? "Yesterday" : new Date(d + "T12:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }));
    const open = (e) => (e.path ? (/\.md$/i.test(e.path) ? app.openNote(e.path) : app.openFile(e.path)) : e.chat ? askDock(p, "", { open: e.chat }) : app.openView("tasks"));
    const out = [];
    let last = "";
    for (const e of shown) {
      if (e.day !== last) { last = e.day; const n = shown.filter((x) => x.day === e.day).length; out.push(h("div", { class: "room-tl-day", dataset: { day: e.day } }, h("b", { text: dayName(e.day) }), h("small", { text: `${n}` }))); }
      out.push(h("button", { class: "room-tl-row is-" + e.kind, onclick: () => open(e) },
        h("span", { class: "room-tl-time", text: new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) }),
        icon(KIND[e.kind][1]), h("span", { class: "room-tl-text", text: e.text }), h("small", { text: KIND[e.kind][2] })));
    }
    const chipsEl = h("div", { class: "segmented is-small" }, ...["all", "Notes", "Files", "Tasks", "Chats"].map((k) => h("button", { class: "seg" + (tlKind === k ? " is-active" : ""), onclick: () => { tlKind = k; paint(); } }, k === "all" ? "Everything" : k)));
    // the last 30 days as a strip: how busy each day was
    const counts = new Map();
    for (const e of all) counts.set(e.day, (counts.get(e.day) || 0) + 1);
    const max = Math.max(1, ...counts.values());
    const strip = h("div", { class: "room-tl-strip", title: "The last 30 days" }, ...Array.from({ length: 30 }, (_, k) => {
      const d = dayKey(Date.now() - (29 - k) * 86400000);
      const c = counts.get(d) || 0;
      return h("span", { class: "room-tl-bar" + (c ? "" : " is-empty"), style: `--h:${Math.round((c / max) * 100)}%`, title: `${dayName(d)}: ${c}`, onclick: () => { const at = main.querySelector(`[data-day="${d}"]`); if (at) at.scrollIntoView({ block: "start" }); } });
    }));
    fill(main, h("div", { class: "room-tl" }, h("div", { class: "room-q-top" }, chipsEl, h("span", { class: "fit-fill" }), strip),
      ...(out.length ? out : [h("div", { class: "room-empty", text: "Nothing in the last 90 days." })])));
  }

  /* ── lens: tasks ── */
  function tasksOf(p, mem) {
    const names = new Set([...mem.own, ...mem.tagged].map((n) => basename(n.path).toLowerCase()));
    return app.tasks.all.filter((t) => taskInProject(t, p, names));
  }
  function tasksLens(p, tasks) {
    const input = h("input", { class: "input room-task-in", placeholder: `A task for ${p.name} (Enter)` });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      const tag = p.tags[0] && !new RegExp(`#${esc(p.tags[0])}\\b`, "i").test(input.value) ? ` #${p.tags[0]}` : "";
      app.tasks.create(input.value.trim() + tag, { project: p.folder });
      input.value = "";
      paint();
    });
    const row = (t) => h("div", { class: "room-task" + (t.done ? " is-done" : "") },
      h("button", { class: "room-check", title: t.done ? "Open it again" : "Done", onclick: () => { app.tasks.toggle(t.id); paint(); } }, t.done ? icon("check") : null),
      h("span", { class: "room-task-t", text: t.text }),
      t.due_date ? h("small", { text: t.due_date }) : null,
      t.priority && t.priority !== "none" ? h("small", { class: "room-prio is-" + t.priority, text: t.priority }) : null);
    const open = tasks.filter((t) => !t.done).sort((a, b) => String(a.due_date || "9").localeCompare(String(b.due_date || "9")));
    const done = tasks.filter((t) => t.done).sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || ""))).slice(0, 30);
    fill(main, h("div", { class: "room-tasks" }, input,
      h("p", { class: "room-hint", text: `A task is the workspace's when it is added here, tagged #${p.tags[0] || "its-tag"}, or links one of its notes.` }),
      ...open.map(row),
      done.length ? h("div", { class: "room-label", text: `Done ${done.length}` }) : null,
      ...done.map(row)));
  }

  /* ── the overview: every project as a card ── */
  let show = "active";
  const SHOWS = [["active", "Active"], ["paused", "Paused"], ["done", "Done"], ["all", "All"], ["hidden", "Hidden"]];
  const stateOf = (p) => (STATUS_DONE.test(p.status) ? "done" : STATUS_PAUSED.test(p.status) ? "paused" : "active");
  async function setStatus(p, status) {
    const n = vault.notes.get(p.brief);
    if (!n) return;
    try { await vault.write(p.brief, setFrontField(n.content, "status", status), {}); paint(); } catch (e) { app.toast(`Could not mark ${p.name || "the workspace"} as ${status}: ${(e && e.message) || e}`, { kind: "error" }); }
  }
  const agoText = (t) => { if (!t) return "nothing yet"; const s2 = (Date.now() - t) / 1000; return s2 < 3600 ? `${Math.max(1, Math.round(s2 / 60))} min ago` : s2 < 86400 ? `${Math.round(s2 / 3600)} h ago` : s2 < 86400 * 30 ? `${Math.round(s2 / 86400)} days ago` : new Date(t).toLocaleDateString(); };
  function overview() {
    const all = projects();
    const groups = S.aiThreadGroups || [];
    const threads = [...(S.aiThreads || []), ...(S.aiThreadsClosed || [])];
    const rows = all.map((p) => {
      const ids = new Set(groups.filter((g) => g.project === p.folder).map((g) => g.id));
      const chats = threads.filter((t) => ids.has(t.group));
      return { p, chats, sum: projectSummary(p, { notes: vault.notes.values(), files: vault.files.values(), tasks: app.tasks.all.filter((t) => !t.deleted), chats, answered: answered(p) }) };
    });
    const off = hiddenWorkspaces(app);
    const counts = { active: 0, paused: 0, done: 0, all: 0, hidden: 0 };
    for (const r of rows) if (off.has(r.p.folder)) counts.hidden++; else { counts[stateOf(r.p)]++; counts.all++; }
    if (show === "hidden" && !counts.hidden) show = "active";
    const order = { active: 0, paused: 1, done: 2 };
    const shown = rows.filter((r) => (show === "hidden" ? off.has(r.p.folder) : !off.has(r.p.folder) && (show === "all" || stateOf(r.p) === show))).sort((a, b) => order[stateOf(a.p)] - order[stateOf(b.p)] || b.sum.last - a.sum.last);
    fill(head, h("div", { class: "room-pick is-title" }, icon("grid"), h("b", { text: "Workspaces" })),
      h("div", { class: "segmented is-small" }, ...SHOWS.filter(([k]) => k !== "hidden" || counts.hidden).map(([k, label]) => h("button", { class: "seg" + (show === k ? " is-active" : ""), onclick: () => { show = k; paint(); } }, label, counts[k] ? h("span", { class: "room-count", text: String(counts[k]) }) : null))),
      h("span", { class: "fit-fill" }),
      h("button", { class: "btn btn-sm", onclick: pickFolder }, icon("folderPlus"), "Make a folder a workspace"));
    const card = ({ p, sum, chats }) => {
      const st = stateOf(p);
      const pct = sum.tasks ? Math.round((sum.done / sum.tasks) * 100) : 0;
      const max = Math.max(1, ...sum.strip);
      const dueText = sum.due == null ? "" : sum.due < 0 ? `${-sum.due} day${sum.due === -1 ? "" : "s"} late` : sum.due === 0 ? "due today" : `due in ${sum.due} day${sum.due === 1 ? "" : "s"}`;
      const statusBtn = h("button", { class: "room-chip room-status is-" + st, title: "Change the status (written in the brief)", onclick: (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        menu(r.left, r.bottom + 4, ["active", "paused", "done"].map((v) => ({ label: v[0].toUpperCase() + v.slice(1), checked: st === v, run: () => setStatus(p, v) })));
      } }, p.status || "active");
      return h("div", { class: "room-card is-" + st, tabindex: "0", onclick: (e) => { if (!e.target.closest("button")) pick(p.folder); }, onkeydown: (e) => { if (e.key === "Enter") pick(p.folder); } },
        h("div", { class: "room-card-top" }, icon("briefcase"), h("b", { text: p.name }), h("span", { class: "fit-fill" }), statusBtn),
        h("div", { class: "room-card-goal", text: p.goal || "No goal written yet" + (p.goal ? "" : " - it goes in the brief") }),
        h("div", { class: "room-card-bar", title: sum.tasks ? `${sum.done} of ${sum.tasks} tasks done` : "No tasks yet" }, h("span", { style: `width:${pct}%` })),
        h("div", { class: "room-card-facts" },
          h("span", { text: sum.tasks ? `${sum.done} / ${sum.tasks} tasks` : "no tasks" }),
          sum.overdue ? h("span", { class: "is-warn", text: `${sum.overdue} overdue` }) : null,
          dueText ? h("span", { class: sum.due < 0 ? "is-warn" : "", text: dueText }) : null,
          h("span", { text: `${sum.notes} note${sum.notes === 1 ? "" : "s"}` }),
          sum.sources ? h("span", { text: `${sum.sources} source${sum.sources === 1 ? "" : "s"}` }) : null,
          sum.questions ? h("button", { class: "link-btn", text: `${sum.questions} open question${sum.questions === 1 ? "" : "s"}`, onclick: () => { lens = "questions"; app.setSetting("roomLens", lens); pick(p.folder); } }) : null,
          chats.length ? h("span", { text: `${chats.length} chat${chats.length === 1 ? "" : "s"}` }) : null),
        h("div", { class: "room-card-foot" },
          h("div", { class: "room-card-strip", title: "The last two weeks" }, ...sum.strip.map((c) => h("span", { class: c ? "" : "is-empty", style: `--h:${Math.round((c / max) * 100)}%` }))),
          h("small", { text: agoText(sum.last) }),
          h("span", { class: "fit-fill" }),
          h("button", { class: "icon-btn", title: "Its chat, in the room", onclick: () => { pick(p.folder); askDock(p, ""); } }, icon("sparkles")),
          h("button", { class: "icon-btn", title: "The brief", onclick: () => app.openNote(p.brief, { newTab: true }) }, icon("fileText")),
          h("button", { class: "icon-btn", title: "More", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, folderItems(p)); } }, icon("more"))));
    };
    fill(main, h("div", { class: "room-cards-wrap" },
      shown.length ? h("div", { class: "room-cards" }, ...shown.map(card))
        : h("div", { class: "room-empty", text: rows.length ? `No ${show} workspace.` : "No workspace yet." })));
  }

  /* ── painting ── */
  function paint() {
    if (stopMap) { stopMap(); stopMap = null; }
    // the board is mounted afresh each time (its edits are saved first): another project, another board
    if (board) { board.destroy(); board = null; }
    const p = current();
    if ((p ? p.folder : "") !== winFor) { closeAllWins(); winFor = p ? p.folder : ""; }
    // remembered for the next time the room is opened from elsewhere: this workspace, or the list
    if (p && S.roomLast !== p.folder) app.setSetting("roomLast", p.folder);
    body.classList.toggle("is-overview", !p);
    body.classList.toggle("no-rail", !!p && !railShown());
    if (!p && projects().length) { fill(rail); fill(side); overview(); return; }
    if (!p) {
      fill(head, h("b", { text: "Workspace room" }));
      fill(rail, ); fill(side, );
      fill(main, h("div", { class: "room-empty room-first" },
        icon("briefcase"),
        h("h3", { text: "See a workspace as a whole" }),
        h("p", { text: "A workspace is a folder with a brief note in it. Notes tagged like the workspace belong too, wherever they are. Here you get its files, a map of its notes, its board, its tasks and its own chats - and it can have a space of its own." }),
        h("button", { class: "btn btn-primary", onclick: pickFolder }, icon("folderPlus"), "Make a folder a workspace"),
        h("p", { class: "room-hint", text: "Or right-click a folder in the tree › Make it a workspace." })));
      return;
    }
    if (S.roomProject !== p.folder) app.setSetting("roomProject", p.folder);
    const mem = membersOf(p, vault.notes.values(), vault.files.values());
    const tasks = tasksOf(p, mem);
    const qs = openQuestions(p, mem);
    paintHead(p, mem, tasks, qs.length);
    paintRail(p, mem);
    if (dockFolder !== p.folder || !dock) dockOpen(p); else paintDockBar(p);
    if (lens === "home") homeLens(p, mem, tasks, qs);
    else if (lens === "map") stopMap = mapLens(p, mem);
    else if (lens === "board") boardLens(p, mem);
    else if (lens === "timeline") timelineLens(p, mem, tasks);
    else if (lens === "questions") questionsLens(p, mem, tasks, qs);
    else tasksLens(p, tasks);
  }
  // the vault changes under the room: paint again, but not while you type in it or draw on its board
  const later = debounce(() => { if (el.isConnected && !el.closest("[hidden]") && lens !== "board" && !el.contains(document.activeElement)) paint(); }, 800);
  app.bus.on("settings", (k) => { if (k === "roomHidden" && el.isConnected && !el.closest("[hidden]")) paint(); });
  vault.bus.on("structure", later);
  vault.bus.on("changed", (e) => { if (e && e.linksChanged) later(); });
  // a note or file renamed, by itself or with its folder: the windows' tabs follow it. A note's editor follows
  // by itself; a file's view opens again on the new path. The workspace itself renamed is not another workspace.
  const followWins = ({ from, to }) => {
    for (const w of wins) {
      const k = w.tabs.indexOf(from);
      if (k < 0) continue;
      w.tabs[k] = to;
      if (k === w.at && kindOfDoc(to) === "file") showTab(w, k); else paintStrip(w);
      paintDock();
    }
  };
  vault.bus.on("renamed", followWins);
  vault.bus.on("fileRenamed", followWins);
  vault.bus.on("folderRenamed", ({ from, to }) => { if (winFor === from || winFor.startsWith(from + "/")) winFor = to + winFor.slice(from.length); });

  return {
    show() {
      followSpace();
      const last = S.roomLast;
      if (!spaceProject() && !showAll && last && last !== ALL && projects().some((x) => x.folder === last)) {
        const s = workspaceSpace(app, projects().find((x) => x.folder === last));
        if (s && app.spacesApi && s.id !== app.currentSpaceId()) { lastSpace = s.id; app.spacesApi.switchTo(s.id); app.openView("room"); return; }
      }
      paint();
    },
    open(folder, to) {
      if (to && LENSES.some(([k]) => k === to)) { lens = to; app.setSetting("roomLens", to); }
      if (folder) { app.setSetting("roomProject", folder); if (enterSpace(folder)) return; lastSpace = app.currentSpaceId && app.currentSpaceId(); } else followSpace();
      paint();
    },
  };
}
