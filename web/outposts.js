// Outposts: folders that are NOT in the vault but are hooked up under it - a
// music drive, a videos folder, an archive of documents. They are browsed
// and managed where they lie. Nothing is copied in, nothing is indexed to
// disk, nothing is watched: a folder is read when it is opened, and a name
// search is a walk made when it is asked for. Backups and sync leave them out.
//
// The list lives in settings (`outposts: [{ path, name }]`); which folders are
// open lives in memory only, so browsing never writes to the disk.

import { h, naturalCompare, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu, inlineEdit, confirmDialog } from "./ui.js";
import { KIND_ICON, fmtSize } from "./fileview.js";
import { extColor } from "./treestyle.js";
import { openSizes } from "./sizes.js";

/** What was dropped from Explorer: [relative path, File] for every file, folders walked (their structure kept). */
export async function droppedFiles(dt) {
  const jobs = [];
  const walk = (entry, base) => new Promise((done) => {
    if (entry.isFile) { entry.file((f) => { jobs.push([base + f.name, f]); done(); }, () => done()); return; }
    if (!entry.isDirectory) return done();
    const reader = entry.createReader();
    const all = [];
    const more = () => reader.readEntries(async (list) => {
      if (list.length) { all.push(...list); more(); return; }
      for (const x of all) await walk(x, base + entry.name + "/");
      done();
    }, () => done());
    more();
  });
  const entries = [...dt.items].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (entries.length) for (const en of entries) await walk(en, "");
  else for (const f of dt.files) jobs.push([f.name, f]);
  return jobs;
}

const nameOf = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p);
const same = (a, b) => String(a).replace(/[\\/]+$/, "").toLowerCase() === String(b).replace(/[\\/]+$/, "").toLowerCase();
/** "E:" for a drive path, the machine for a network one. */
const driveOf = (p) => { const m = /^([A-Za-z]:)|^\\\\([^\\]+)/.exec(String(p)); return m ? m[1] || m[2] : ""; };

export const outpostList = (app) => (Array.isArray(app.settings.outposts) ? app.settings.outposts.filter((o) => o && o.path) : []);
/** Folders the "This PC" search walks: the ones from Settings, plus every outpost. */
export const pcRootsOf = (app) => [...(app.settings.pcSearchRoots || []), ...outpostList(app).map((o) => o.path)];

/** Pick a folder and hook it up. Used by the sidebar and by Settings. */
export async function addOutpost(app) {
  const picked = await app.host.dialogOpen({ directory: true, multiple: false, title: "Hook up a folder as an outpost" }).catch(() => null);
  if (!picked) return null;
  let res;
  try {
    res = await app.host.outpostAdd(String(picked));
  } catch (e) {
    app.toast(String(e), { kind: "error", ms: 5000 });
    return null;
  }
  const list = outpostList(app);
  if (list.some((o) => same(o.path, res.path))) { app.toast(`${res.name} is an outpost already`); return res; }
  app.setSetting("outposts", [...list, { path: res.path, name: res.name, backup: false }]);
  app.toast(`${res.name} is hooked up. It stays where it is - Leonote only looks in.`, { ms: 4200 });
  return res;
}

/**
 * The folder lies somewhere else now - another drive letter, another computer.
 * Point at where it is; the label and the flags stay, and the Player's
 * playlists, queue and open tabs follow. Works for a plain Player library too.
 */
export async function relocateFolder(app, from) {
  const o = outpostList(app).find((r) => same(r.path, from));
  const picked = await app.host.dialogOpen({ directory: true, multiple: false, title: `Where is “${(o && o.name) || from}” now?` }).catch(() => null);
  if (!picked) return null;
  let res;
  try {
    res = o ? await app.host.outpostAdd(String(picked)) : await app.host.libraryAdd(String(picked));
  } catch (e) {
    app.toast(String(e), { kind: "error", ms: 5000 });
    return null;
  }
  if (same(res.path, from)) { app.toast("That is where it was already"); return res; }
  if (o) {
    if (outpostList(app).some((r) => same(r.path, res.path))) { app.toast(`${res.name} is an outpost already`, { kind: "error" }); return null; }
    app.host.outpostForget(from).catch(() => {});
  }
  // the playlists first: once the setting changes the Player rescans
  const moved = app.media && app.media.libraries.relocate ? app.media.libraries.relocate(from, res.path) : 0;
  if (o) app.setSetting("outposts", outpostList(app).map((r) => (same(r.path, from) ? { ...r, path: res.path } : r)));
  if (app.extMoved) app.extMoved(from, res.path);
  app.toast(`Found it at ${res.path}${moved ? ` · ${moved} playlist track${moved === 1 ? "" : "s"} re-pointed` : ""}`, { ms: 4500 });
  return res;
}

export function removeOutpost(app, path) {
  app.setSetting("outposts", outpostList(app).filter((o) => !same(o.path, path)));
  app.host.outpostForget(path).catch(() => {});
}

export function mountOutposts(app, { section, act }) {
  app.relocateFolder = (p) => relocateFolder(app, p);
  // Folders showing their contents. Remembered between sessions: written only
  // when a folder is opened or shut by hand, never on a timer.
  const saveOpen = debounce(() => app.setSetting("outpostsOpen", [...open].slice(-300)), 900);
  const open = new (class extends Set {
    add(v) { const had = this.has(v); super.add(v); if (!had) saveOpen(); return this; }
    delete(v) { const had = super.delete(v); if (had) saveOpen(); return had; }
  })();
  for (const d of Array.isArray(app.settings.outpostsOpen) ? app.settings.outpostsOpen : []) if (outpostList(app).some((o) => String(d).toLowerCase().startsWith(String(o.path).toLowerCase()))) Set.prototype.add.call(open, d);
  const cache = new Map(); // dir -> { folders, files, capped } | { error }
  const loading = new Set();
  let found = null; // { q, hits, partial } while the sidebar filter is on
  let query = "";
  let seq = 0;

  const body = h("div", { class: "tree op-tree", tabIndex: 0 }); // reachable with Tab; arrows move, Enter opens
  const sec = section("outposts", h("span", { class: "op-title" }, icon("outside"), "Outposts"), body, [
    act("undo", "Read the open folders again", () => refresh()),
    act("folderPlus", "Hook up a folder from this PC…", () => addOutpost(app)),
    act("phone", "A phone plugged in by USB: its photos and files, to move to this computer or delete", () => app.openView("phone")),
  ]);
  sec.classList.add("op-sec");
  sec.querySelector(".sb-sec-title").title = "Folders outside your vault. They stay where they are, and backups and sync leave them out.";

  const step = () => Math.max(6, Math.min(32, Number(app.settings.treeIndent) || 14));

  async function load(dir, { quiet = false } = {}) {
    if (loading.has(dir)) return;
    loading.add(dir);
    if (!quiet) render();
    try {
      const r = await app.host.outpostList(dir);
      r.folders.sort((a, b) => naturalCompare(a.name, b.name));
      r.files.sort((a, b) => naturalCompare(a.name, b.name));
      cache.set(dir, r);
    } catch (e) {
      cache.set(dir, { error: String(e) });
    }
    loading.delete(dir);
    renderSoon();
  }
  // several folders read at once draw once
  let rq = 0;
  const renderSoon = () => { if (!rq) rq = requestAnimationFrame(() => { rq = 0; render(); }); };

  function refresh() {
    for (const d of [...cache.keys()]) if (!open.has(d)) cache.delete(d);
    // read again what is on screen; a folder open inside a closed one is read when it shows (walk)
    for (const d of open) if (cache.has(d)) load(d, { quiet: true });
    if (query) search(query);
  }

  function toggle(dir) {
    if (open.has(dir)) { open.delete(dir); render(); return; }
    open.add(dir);
    load(dir); // always read again: nothing watches these folders
  }

  const openFile = (path, newTab) => app.openExternal(path, { newTab });
  const parentOf = (p) => { const s = String(p).replace(/[\\/]+$/, ""); const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/")); return i < 0 ? s : s.slice(0, i) || s; };
  const fail = (what) => (e) => app.toast(`${what}: ${e}`, { kind: "error", ms: 5000 });

  function rename(row, path, isDir) {
    const label = row.querySelector(".tree-label");
    if (!label) return;
    inlineEdit(label, nameOf(path), {
      selectBase: !isDir,
      className: "tree-edit",
      onCancel: () => render(),
      onCommit: async (v) => {
        const name = String(v || "").trim();
        if (!name || name === nameOf(path)) return render();
        try {
          const to = await app.host.outpostRename(path, name);
          if (isDir && open.delete(path)) open.add(to);
          app.extMoved && app.extMoved(path, to);
        } catch (e) { fail("Could not rename")(e); }
        load(parentOf(path), { quiet: true });
      },
    });
  }

  async function newFolder(dir) {
    try {
      const made = await app.host.outpostMkdir(dir, "New folder");
      open.add(dir);
      await load(dir, { quiet: true });
      const row = [...body.querySelectorAll(".tree-row")].find((r) => r.dataset.path === made);
      if (row) rename(row, made, true);
    } catch (e) { fail("Could not make a folder")(e); }
  }

  /* Files dragged in from Explorer and let go on an outpost's folder (or the outpost itself): copied
     there, folders with what is inside them - never over anything. */
  const fromExplorer = (e) => [...(e.dataTransfer ? e.dataTransfer.types : [])].includes("Files");
  const dropRow = (e) => { const r = e.target.closest(".tree-row"); return r && ["folder", "root", "hitdir"].includes(r.dataset.kind) ? r : null; };
  body.addEventListener("dragover", (e) => {
    if (!fromExplorer(e)) return;
    const r = dropRow(e);
    for (const x of body.querySelectorAll(".is-drop")) if (x !== r) x.classList.remove("is-drop");
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    r.classList.add("is-drop");
  });
  body.addEventListener("dragleave", (e) => { if (!body.contains(e.relatedTarget)) for (const x of body.querySelectorAll(".is-drop")) x.classList.remove("is-drop"); });
  body.addEventListener("drop", async (e) => {
    if (!fromExplorer(e)) return;
    const r = dropRow(e);
    for (const x of body.querySelectorAll(".is-drop")) x.classList.remove("is-drop");
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = r.dataset.path;
    const jobs = await droppedFiles(e.dataTransfer);
    if (!jobs.length) return;
    const close = jobs.length > 3 ? app.toast(`Copying ${jobs.length} files…`, { ms: 60000 }) : null;
    let ok = 0;
    for (const [rel, f] of jobs) {
      // the copy refuses over 1 GB anyway: said before the whole file is read into the window
      if (f.size > 1024 ** 3) { app.toast(`${rel} is over 1 GB - copy it in Explorer instead`, { kind: "error", ms: 5000 }); continue; }
      try { await app.host.outpostImport(dir, rel, new Uint8Array(await f.arrayBuffer())); ok++; }
      catch (err) { app.toast(`Could not copy ${rel}: ${err}`, { kind: "error" }); }
    }
    if (close) close();
    open.add(dir);
    await load(dir, { quiet: true });
    if (ok) app.toast(`Copied ${ok} file${ok === 1 ? "" : "s"} into ${nameOf(dir)}`, { ms: 2600 });
  });

  async function recycle(path, isDir) {
    const ok = await confirmDialog(`Move “${nameOf(path)}” to the Recycle Bin?`,
      isDir ? "The whole folder goes to the Windows Recycle Bin. You can restore it from there." : "It goes to the Windows Recycle Bin. You can restore it from there.",
      { ok: "Move to Recycle Bin" });
    if (!ok) return;
    try {
      await app.host.outpostTrash([path]);
      open.delete(path);
      app.toast(`${nameOf(path)} is in the Recycle Bin`, { ms: 2600 });
    } catch (e) { fail("Could not delete")(e); }
    load(parentOf(path), { quiet: true });
    if (query) search(query);
  }

  function relabel(row, o) {
    const label = row.querySelector(".tree-label");
    inlineEdit(label, o.name || nameOf(o.path), {
      className: "tree-edit",
      onCancel: () => render(),
      onCommit: (v) => {
        const name = String(v || "").trim() || nameOf(o.path);
        app.setSetting("outposts", outpostList(app).map((x) => (same(x.path, o.path) ? { ...x, name } : x)));
        render();
      },
    });
  }

  const copyPath = (p) => navigator.clipboard.writeText(p).then(() => app.toast("Path copied", { ms: 1600 })).catch(() => {});
  const reveal = (p) => app.host.externalReveal(p).catch(fail("Could not show it"));

  function rowMenu(e, row) {
    e.preventDefault();
    const { path, kind } = row.dataset;
    const x = e.clientX, y = e.clientY;
    if (kind === "root") {
      const o = outpostList(app).find((r) => same(r.path, path));
      if (!o) return;
      const isLib = (app.settings.playerLibraries || []).some((l) => same(l.path, path));
      return menu(x, y, [
        { header: path },
        { label: "New folder here", icon: "folderPlus", run: () => newFolder(path) },
        { label: "Read it again", icon: "undo", run: () => { open.add(path); load(path); } },
        { label: "Show in Explorer", icon: "reveal", run: () => reveal(path) },
        { label: "Disk space…", icon: "chart", run: () => openSizes(app, path) },
        { label: "Copy path", icon: "clipboard", run: () => copyPath(path) },
        "sep",
        { label: "Give it another label…", icon: "edit", run: () => relabel(row, o) },
        isLib ? { label: "Already a Player library", icon: "play", disabled: true }
          : { label: "Its music and videos show in the Player", icon: "play", checked: o.player !== false, run: () => app.setSetting("outposts", outpostList(app).map((r) => (same(r.path, path) ? { ...r, player: o.player === false } : r))) },
        { label: "It moved - say where it is now…", icon: "folder", run: () => relocateFolder(app, path).then((r) => { if (r) { open.add(r.path); } }) },
        "sep",
        { label: "Unhook this outpost", icon: "x", run: async () => {
          const ok = await confirmDialog(`Unhook “${o.name || nameOf(path)}”?`, "It only leaves this list. The folder and everything in it stay exactly where they are.", { ok: "Unhook", danger: false });
          if (ok) { open.delete(path); removeOutpost(app, path); }
        } },
      ].filter(Boolean));
    }
    if (kind === "folder") {
      return menu(x, y, [
        { label: "New folder inside", icon: "folderPlus", run: () => newFolder(path) },
        { label: "Show in Explorer", icon: "reveal", run: () => reveal(path) },
        { label: "Disk space…", icon: "chart", run: () => openSizes(app, path) },
        { label: "Copy path", icon: "clipboard", run: () => copyPath(path) },
        "sep",
        { label: "Rename", icon: "edit", keys: "F2", run: () => rename(row, path, true) },
        { label: "Move to Recycle Bin", icon: "trash", danger: true, run: () => recycle(path, true) },
      ]);
    }
    menu(x, y, [
      { label: "Open", icon: "outside", run: () => openFile(path, false) },
      { label: "Open in a new tab", icon: "filePlus", run: () => openFile(path, true) },
      { label: "Open in its own app", icon: "play", run: () => app.host.externalOpenInApp(path).catch(fail("Could not open it")) },
      { label: "Show in Explorer", icon: "reveal", run: () => reveal(path) },
      "sep",
      { label: "Copy into the vault…", icon: "download", run: () => app.addToVaultCard ? app.addToVaultCard(path) : app.importExternal(path, {}) },
      { label: "Copy path", icon: "clipboard", run: () => copyPath(path) },
      "sep",
      { label: "Rename", icon: "edit", keys: "F2", run: () => rename(row, path, false) },
      { label: "Move to Recycle Bin", icon: "trash", danger: true, run: () => recycle(path, false) },
    ]);
  }

  /* ── drawing ───────────────────────────────────────────────────────────── */
  const extTag = (name) => {
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || app.settings.treeShowExt === "none") return { base: name, tag: null };
    const e = name.slice(dot + 1);
    return { base: name.slice(0, dot), tag: h("span", { class: "tree-ext", text: e, style: { "--c": extColor(e) } }) };
  };
  const fileRow = (f, depth, sub) => {
    const { base, tag } = extTag(f.name);
    return h("div", { class: "tree-row is-file op-row", title: `${f.path}\n${fmtSize(f.size || 0)}`, dataset: { path: f.path, kind: "file" }, style: { paddingLeft: 8 + depth * step() - 2 + "px", "--d": depth } },
      icon(KIND_ICON[f.kind] || (f.kind === "note" ? "fileText" : "file"), "tree-ico"), h("span", { class: "tree-label", text: base }), sub ? h("span", { class: "op-where", text: sub }) : null, tag);
  };

  function walk(frag, dir, depth) {
    const r = cache.get(dir);
    const pad = { paddingLeft: 8 + depth * step() + 16 + "px" };
    // read when it first shows: remembered open folders inside closed ones are not read at start
    if (!r) { if (!loading.has(dir)) load(dir, { quiet: true }); return frag.append(h("div", { class: "op-note", style: pad, text: "Reading…" })); }
    if (r.error) {
      // at the top of an outpost this is a missing drive, or another computer
      const root = outpostList(app).find((o) => same(o.path, dir));
      return frag.append(h("div", { class: "op-note is-error", style: pad, title: r.error }, "Can't be read right now",
        root ? h("button", { class: "op-link", title: "The folder moved, or this is another computer: say where it is now. Playlists follow", onclick: () => relocateFolder(app, dir) }, "Find it…") : null));
    }
    for (const f of r.folders) {
      const isOpen = open.has(f.path);
      frag.append(h("div", { class: "tree-row is-folder op-row" + (isOpen ? " is-open" : ""), title: f.path, dataset: { path: f.path, kind: "folder" }, style: { paddingLeft: 8 + depth * step() + "px", "--d": depth } },
        icon("chevron", "tree-caret"), app.settings.treeFolderIcons ? icon("folder", "tree-ico") : null, h("span", { class: "tree-label", text: f.name })));
      if (isOpen) walk(frag, f.path, depth + 1);
    }
    for (const f of r.files) frag.append(fileRow(f, depth));
    if (!r.folders.length && !r.files.length) frag.append(h("div", { class: "op-note", style: pad, text: "Empty" }));
    if (r.capped) frag.append(h("div", { class: "op-note", style: pad, text: "…and more. Open it in Explorer to see everything." }));
  }

  // One folder alone, straight open and without its own row: a project space
  // showing its project where the vault's files otherwise are.
  let only = "";
  function render() {
    const list = outpostList(app);
    const frag = document.createDocumentFragment();
    sec.classList.toggle("is-only", !!only);
    if (only && !found) {
      if (!cache.has(only) && !loading.has(only)) load(only, { quiet: true });
      walk(frag, only, 0);
      body.replaceChildren(frag);
      markCursor();
      return;
    }
    if (!list.length) {
      frag.append(h("div", { class: "op-empty" },
        h("p", { text: "Hook up folders that live outside your vault - music, videos, documents - and browse them from here. They stay where they are." }),
        h("button", { class: "link-btn", onclick: () => addOutpost(app) }, "Hook up a folder…")));
    } else if (found) {
      if (!found.hits.length) frag.append(h("div", { class: "op-note", text: found.busy ? "Looking…" : "Nothing in the outposts matches" }));
      for (const hit of found.hits) {
        const o = list.find((r) => same(r.path, hit.root));
        const where = (o ? o.name || nameOf(o.path) : "") + hit.dir.slice(hit.root.length).replace(/[\\/]/g, " › ");
        if (hit.isDir) frag.append(h("div", { class: "tree-row is-folder op-row is-hit", title: hit.path, dataset: { path: hit.path, kind: "hitdir", root: hit.root }, style: { paddingLeft: "8px" } },
          icon("folder", "tree-ico"), h("span", { class: "tree-label", text: hit.name }), h("span", { class: "op-where", text: where })));
        else frag.append(fileRow(hit, 0, where));
      }
      if (found.partial && found.hits.length) frag.append(h("div", { class: "op-note", text: "There is more - add a word to narrow it down" }));
    } else {
      for (const o of list) {
        const isOpen = open.has(o.path);
        const r = cache.get(o.path);
        const away = !!(r && r.error);
        frag.append(h("div", { class: "tree-row is-folder op-row op-root" + (isOpen ? " is-open" : "") + (away ? " is-away" : ""), title: away ? `${o.path}\nNot reachable right now - is the drive plugged in?` : o.path, dataset: { path: o.path, kind: "root" }, style: { paddingLeft: "8px" } },
          icon("chevron", "tree-caret"), h("span", { class: "tree-label", text: o.name || nameOf(o.path) }),
          h("span", { class: "op-drive", text: away ? "away" : driveOf(o.path) })));
        if (isOpen) walk(frag, o.path, 1);
      }
    }
    body.replaceChildren(frag);
    markCursor();
    const cur = app.currentExternal && app.currentExternal();
    // the same file however its path is written (\ or /, letter case)
    const same = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
    if (cur) for (const r of body.querySelectorAll(".tree-row.is-file")) if (same(r.dataset.path) === same(cur)) r.classList.add("is-active");
  }

  const search = debounce(async (q) => {
    const my = ++seq;
    try {
      const r = await app.host.outpostFind(q, 200);
      if (my !== seq || q !== query) return;
      found = { q, hits: r.hits || [], partial: !!r.partial };
    } catch { if (my === seq) found = { q, hits: [], partial: false }; }
    render();
  }, 260);

  body.addEventListener("click", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row || body.querySelector(".tree-edit")) return;
    const { path, kind } = row.dataset;
    if (kind === "file") return openFile(path, e.ctrlKey || e.metaKey);
    if (kind === "hitdir") {
      // leave the search and show the folder in place
      const root = row.dataset.root;
      app.clearFileFilter && app.clearFileFilter();
      for (let d = path; d && d.length >= root.length; d = parentOf(d)) { open.add(d); if (same(d, root)) break; }
      for (const d of open) if (!cache.has(d)) load(d, { quiet: true });
      return render();
    }
    toggle(path);
  });
  // the middle button is for scrolling the list (the webview's autoscroll), never for opening
  body.addEventListener("contextmenu", (e) => { const row = e.target.closest(".tree-row"); if (row) rowMenu(e, row); });
  // the keyboard: a cursor row (its own outline from the tree's CSS), kept across redraws by its path
  let cursorPath = null;
  const rows = () => [...body.querySelectorAll(".tree-row")];
  function markCursor() { for (const r of rows()) r.classList.toggle("is-cursor", r.dataset.path === cursorPath); }
  body.addEventListener("click", (e) => { const r = e.target.closest(".tree-row"); if (r) { cursorPath = r.dataset.path; markCursor(); } }, true);
  body.addEventListener("keydown", (e) => {
    if (e.target !== body) return; // a button inside the list (Find it…) keeps its own keys
    const all = rows(), at = all.findIndex((r) => r.dataset.path === cursorPath), row = all[at];
    const go = (i) => { const r = all[Math.max(0, Math.min(all.length - 1, i))]; if (!r) return; cursorPath = r.dataset.path; markCursor(); r.scrollIntoView({ block: "nearest" }); };
    if (e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(at < 0 ? 0 : at - 1); }
    else if (e.key === "Enter" && row) { e.preventDefault(); row.click(); }
    else if (e.key === "F2") { const r = row || body.querySelector(".tree-row:hover"); if (r && r.dataset.kind !== "root") { e.preventDefault(); rename(r, r.dataset.path, r.dataset.kind === "folder"); } }
    else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && row) { e.preventDefault(); const b = row.getBoundingClientRect(); rowMenu({ preventDefault() {}, clientX: b.left + 20, clientY: b.bottom }, row); }
  });
  // files drag out as text: their path, for a note or another program
  body.addEventListener("dragstart", (e) => { const row = e.target.closest(".tree-row"); if (row) e.dataTransfer.setData("text/plain", row.dataset.path); });

  app.bus.on("settings", (k) => { if (k === "outposts" || k === "treeIndent" || k === "treeShowExt" || k === "treeFolderIcons") render(); });
  render(); // reads the open folders that show, as it draws them

  return {
    el: sec,
    render,
    refresh,
    /** Show this one folder alone ("" for all the outposts again). */
    focus(path) { only = path || ""; if (only) open.add(only); render(); },
    /** The sidebar's file filter reaches in here too. */
    setFilter(q) {
      query = String(q || "").trim();
      if (!query || !outpostList(app).length) { found = null; seq++; return render(); }
      found = { q: query, hits: found ? found.hits : [], partial: false, busy: true };
      render();
      search(query);
    },
  };
}
