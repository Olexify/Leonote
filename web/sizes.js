// Disk space: what takes the room, the way WizTree shows it - a map of blocks sized by what they
// hold, its files and folders by size with a bar each, and the largest files anywhere under it.
// A click into a folder, Up past where you started, any drive of the PC; open, show in Explorer or
// move to the trash from the map or the list. Its own view; a folder's "Disk space…" opens it there.
// The counting is done in Rust (sizes.rs), nothing is kept.

import { h } from "./util.js";
import { icon } from "./icons.js";
import { menu, confirmDialog } from "./ui.js";
import { fmtSize } from "./fileview.js";

const nameOf = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const parentOf = (p) => { const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")); return i > 0 ? p.slice(0, i) : p; };
const isDriveRoot = (p) => /^[a-z]:[\\/]?$/i.test(p) || p === "/";

/** `path`: a folder on disk, or one in the vault ("" for the whole vault) - shown in the Disk space view. */
export function openSizes(app, path) {
  app.openView("space");
  // the view may be loading still: it reads the place asked for when it is up
  app.spaceAsk = path;
  if (app.spaceGo) app.spaceGo(path);
}

/* A squarified treemap: the items (with .size) laid in the rectangle w × h, rows chosen so the blocks
   stay as square as they can. Each item gets { x, y, w, h }. */
export function squarify(items, w, h) {
  const out = [];
  const total = items.reduce((s, x) => s + x.size, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.filter((x) => x.size > 0).map((x) => ({ item: x, area: x.size * scale }));
  let x0 = 0, y0 = 0, W = w, H = h;
  const worst = (row, side) => { const s = row.reduce((a, r) => a + r.area, 0); const mx = Math.max(...row.map((r) => r.area)), mn = Math.min(...row.map((r) => r.area)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
  while (rest.length) {
    const side = Math.min(W, H);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((a, r) => a + r.area, 0);
    if (W >= H) { // a column on the left
      const cw = s / H;
      let y = y0;
      for (const r of row) { const rh = r.area / cw; out.push({ ...r.item, x: x0, y, w: cw, h: rh }); y += rh; }
      x0 += cw; W -= cw;
    } else { // a row on top
      const rh = s / W;
      let x = x0;
      for (const r of row) { const rw = r.area / rh; out.push({ ...r.item, x, y: y0, w: rw, h: rh }); x += rw; }
      y0 += rh; H -= rh;
    }
  }
  return out;
}

// a block's colour: folders in the accent's family, files by what they are
const KIND = [[/\.(mp4|mkv|mov|webm|avi|m4v)$/i, "#d63a6f"], [/\.(png|jpe?g|gif|webp|bmp|avif|heic|psd|tiff?)$/i, "#2ea36b"], [/\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i, "#9a4fd6"],
  [/\.(zip|7z|rar|tar|gz|iso)$/i, "#8a6a45"], [/\.(exe|dll|msi|sys|bin)$/i, "#d9443a"], [/\.(pdf|docx?|xlsx?|pptx?|md|txt)$/i, "#2f6fd9"]];
const colourOf = (c) => (c.dir ? "" : (KIND.find(([re]) => re.test(c.name)) || [0, "#7d8794"])[1]);

export function mountSpace(app, el) {
  const vaultAbs = (app.host.getVaultAbs ? app.host.getVaultAbs() : "").replace(/[\\/]+$/, "");
  const win = vaultAbs.includes("\\");
  const absOf = (path) => (/^([a-z]:|[\\/])/i.test(path) ? String(path) : path ? vaultAbs + (win ? "\\" : "/") + (win ? path.replace(/\//g, "\\") : path) : vaultAbs).replace(/[\\/]+$/, "") || path;
  // a vault path for a file on disk, or null when it lies outside the vault
  const relOf = (p) => {
    if (!vaultAbs) return null;
    const a = p.toLowerCase(), v = vaultAbs.toLowerCase();
    return a === v ? "" : a.startsWith(v + "\\") || a.startsWith(v + "/") ? p.slice(vaultAbs.length + 1).replace(/\\/g, "/") : null;
  };
  let root = vaultAbs, at = vaultAbs;
  let tab = ["map", "here", "largest"].includes(app.settings.spaceTab) ? app.settings.spaceTab : "map";
  let data = null, asked = 0;

  const places = h("div", { class: "sz-places" });
  // where you have been, as a browser keeps it: Back, Forward (Alt+arrows, the mouse's side buttons)
  const back = [], fwd = [];
  const backBtn = h("button", { class: "icon-btn", title: "Back (Alt+Left)", onclick: () => step(back, fwd) }, icon("back"));
  const fwdBtn = h("button", { class: "icon-btn", title: "Forward (Alt+Right)", onclick: () => step(fwd, back) }, icon("forward"));
  function step(from, to) {
    if (!from.length) return;
    to.push({ root, at });
    const p = from.pop();
    root = p.root; at = p.at;
    load();
  }
  const crumbs = h("div", { class: "sz-crumbs" });
  const total = h("div", { class: "sz-total" });
  const seg = h("div", { class: "segmented is-small" });
  const list = h("div", { class: "sz-list" });
  const mapEl = h("div", { class: "sz-map" });
  const box = h("div", { class: "sz is-view" },
    h("div", { class: "sz-head" },
      h("div", { class: "sz-title" }, icon("chart"), "Disk space"),
      backBtn, fwdBtn,
      h("button", { class: "btn btn-sm", title: "The folder this one is in (Backspace)", onclick: () => up() }, icon("arrowUp"), "Up"),
      h("button", { class: "icon-btn", title: "Count again (what was counted before is forgotten)", onclick: () => load(true) }, icon("undo"))),
    places, crumbs, h("div", { class: "sz-bar" }, total, seg), mapEl, list);
  el.replaceChildren(box);
  el.tabIndex = -1;
  el.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "Backspace") { e.preventDefault(); up(); }
  });
  // Alt+arrows go through the app's Back and Forward, which ask here first while this is on screen
  const prevStep = app.localStep; // the graph asks too: whichever is on screen answers
  app.localStep = (dir) => {
    if (el.hidden || !el.isConnected || !(dir < 0 ? back : fwd).length) return prevStep ? prevStep(dir) : false;
    dir < 0 ? step(back, fwd) : step(fwd, back);
    return true;
  };
  el.addEventListener("mouseup", (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.stopPropagation(); e.button === 3 ? step(back, fwd) : step(fwd, back); } });
  for (const [v, t] of [["map", "Map"], ["here", "In this folder"], ["largest", "Largest files"]])
    seg.append(h("button", { class: "seg", dataset: { v }, onclick: () => { tab = v; app.setSetting("spaceTab", v); paint(); } }, t));

  const fail = (e) => app.toast(String(e), { kind: "error" });
  function go(p, asRoot = false) {
    if (p !== at) { back.push({ root, at }); if (back.length > 100) back.shift(); fwd.length = 0; }
    if (asRoot) root = p;
    at = p;
    load();
  }
  function up() {
    if (isDriveRoot(at)) return;
    let p = parentOf(at);
    if (/^[a-z]:$/i.test(p)) p += "\\";
    go(p, at === root || !at.startsWith(root));
  }
  function openIt(p, dir) {
    if (dir) return go(p);
    const rel = relOf(p);
    if (rel == null) app.openExternal(p, { newTab: true });
    else if (app.vault.notes.has(rel)) app.openNote(rel, { newTab: true });
    else app.openFile(rel, { newTab: true });
  }
  async function trashIt(p, dir) {
    const rel = relOf(p);
    // a vault item follows the trash setting: the Recycle Bin gives back notes only to Undo, the rest from Windows
    const bin = rel == null || app.settings.trashMode === "bin";
    const ok = await confirmDialog(`Move “${nameOf(p)}” to the ${bin ? "Recycle Bin" : "trash"}?`,
      bin ? "It goes to the Windows Recycle Bin; you can restore it from there." : "You can bring it back with Undo, or from the trash later.", { ok: bin ? "Move to Recycle Bin" : "Move to trash" });
    if (!ok) return;
    try {
      // a vault item goes the app's own way: a note is saved first, Undo is offered, the trash setting is followed
      if (rel == null) await app.host.outpostTrash([p]);
      else await app.trashItems([[rel, dir ? "folder" : app.vault.notes.has(rel) ? "note" : "file"]]);
      load();
    } catch (e) { fail(e); }
  }
  function rowMenu(e, p, dir) {
    e.preventDefault();
    menu(e.clientX, e.clientY, [
      { header: p },
      { label: dir ? "Look inside" : "Open", icon: dir ? "folder" : "play", run: () => openIt(p, dir) },
      { label: "Show in Explorer", icon: "reveal", run: () => app.host.externalReveal(p).catch(fail) },
      { label: "Copy the path", icon: "link", run: () => navigator.clipboard.writeText(p).then(() => app.toast("Copied", { ms: 1400 })) },
      "sep",
      { label: relOf(p) == null ? "Move to the Recycle Bin…" : "Move to the trash…", icon: "trash", danger: true, run: () => trashIt(p, dir) },
    ]);
  }
  const row = (p, dir, size, max, sub) => h("button", { class: "sz-row", title: p, onclick: () => openIt(p, dir), oncontextmenu: (e) => rowMenu(e, p, dir) },
    icon(dir ? "folder" : "file"),
    h("span", { class: "sz-name" }, h("span", { class: "sz-n", text: nameOf(p) }), sub ? h("span", { class: "sz-sub", text: sub }) : null),
    h("span", { class: "sz-meter" }, h("span", { style: { width: `${max ? Math.max(0.5, (size / max) * 100) : 0}%` } })),
    h("span", { class: "sz-size", text: fmtSize(size) }));

  // the places to start from: the vault, the outposts, each drive of the PC
  async function paintPlaces() {
    const outposts = (Array.isArray(app.settings.outposts) ? app.settings.outposts : []).map((o) => o && o.path).filter(Boolean);
    let drives = [];
    try { drives = app.host.pcDrives ? await app.host.pcDrives() : []; } catch { /* none to offer */ }
    places.replaceChildren(
      h("button", { class: "chip-btn", title: vaultAbs, onclick: () => go(vaultAbs, true) }, icon("folder"), "Vault"),
      ...outposts.map((p) => h("button", { class: "chip-btn", title: p, onclick: () => go(p, true) }, icon("outside"), nameOf(p))),
      ...drives.map((d) => {
        const b = h("button", { class: "chip-btn sz-drive", title: `All of ${d} - counting a whole drive takes a while`, onclick: () => go(d.replace(/[\\/]+$/, "") + (win ? "\\" : "/"), true) }, icon("box"), d.replace(/[\\/]+$/, ""));
        // how full it is: a thin bar under the name, the free space beside it
        if (app.host.driveSpace) app.host.driveSpace(d).then((sp) => {
          if (!sp || !sp.total) return;
          const used = 1 - sp.free / sp.total;
          b.title = `${d} - ${fmtSize(sp.free)} free of ${fmtSize(sp.total)}\nClick to count all of it (that takes a while)`;
          b.append(h("span", { class: "sz-free", text: `${fmtSize(sp.free)} free` }), h("i", { class: "sz-fill" + (used > 0.9 ? " is-full" : ""), style: { width: `${Math.round(used * 100)}%` } }));
        }).catch(() => {});
        return b;
      }));
  }

  function paintMap() {
    const r = mapEl.getBoundingClientRect();
    const kids = (data && data.children) || [];
    const blocks = squarify(kids.slice(0, 400), r.width, r.height);
    mapEl.replaceChildren(...blocks.map((b, i) => {
      const big = b.w > 70 && b.h > 34;
      const c = colourOf(b);
      // the folder's own files, flattened (no subfolders drawn): the largest ones, and what is left
      const inner = [];
      if (b.dir && b.top && b.top.length && b.w > 80 && b.h > 80) {
        const head = 40, iw = b.w - 10, ih = b.h - head - 6;
        const shown = b.top.reduce((s, f) => s + f.size, 0);
        const items = [...b.top.map((f) => ({ ...f, name: nameOf(f.path) })), ...(b.size > shown ? [{ name: "…the rest", size: b.size - shown, rest: true }] : [])];
        for (const f of squarify(items, iw, ih)) {
          if (f.w < 3 || f.h < 3) continue;
          const fc = f.rest ? "#4a4a50" : colourOf({ name: f.name });
          inner.push(h("div", { class: "sz-file" + (f.rest ? " is-rest" : ""), title: f.rest ? `${fmtSize(f.size)} in smaller files` : `${f.name}\n${fmtSize(f.size)}\n${f.path}`,
            style: { left: 5 + f.x + "px", top: head + f.y + "px", width: Math.max(0, f.w - 1) + "px", height: Math.max(0, f.h - 1) + "px", "--fc": fc },
            onclick: f.rest ? null : (e) => { e.stopPropagation(); openIt(f.path, false); },
            oncontextmenu: f.rest ? null : (e) => { e.stopPropagation(); rowMenu(e, f.path, false); } },
            f.w > 70 && f.h > 18 ? h("span", { class: "sz-fname", text: f.name }) : null));
        }
      }
      return h("div", {
        class: "sz-block" + (b.dir ? " is-dir" : "") + (b.done === false ? " is-counting" : ""), title: `${b.name}\n${fmtSize(b.size)}${b.dir ? ` · ${b.files.toLocaleString()} files` : ""}`,
        style: { left: b.x + "px", top: b.y + "px", width: Math.max(0, b.w - 2) + "px", height: Math.max(0, b.h - 2) + "px", ...(c ? { "--bc": c } : { "--bc": `hsl(${(i * 47) % 360} 45% 42%)` }) },
        onclick: () => openIt(b.path, b.dir), oncontextmenu: (e) => rowMenu(e, b.path, b.dir),
      }, big ? h("span", { class: "sz-bname", text: b.name }) : null, big ? h("span", { class: "sz-bsize", text: fmtSize(b.size) }) : null, ...inner);
    }));
    if (!blocks.length) mapEl.replaceChildren(h("div", { class: "sz-empty", text: data ? "Nothing in here." : "" }));
  }

  function paint() {
    backBtn.disabled = !back.length;
    fwdBtn.disabled = !fwd.length;
    for (const b of seg.children) b.classList.toggle("is-active", b.dataset.v === tab);
    // the way down from where you started, each step a way back up
    const parts = [at];
    for (let p = at; !isDriveRoot(p) && parentOf(p) !== p; ) { p = parentOf(p); if (/^[a-z]:$/i.test(p)) p += "\\"; parts.unshift(p); }
    crumbs.replaceChildren(...parts.flatMap((p, i) => [i ? h("span", { class: "sz-sep", text: "›" }) : null,
      h("button", { class: "sz-crumb" + (p === at ? " is-here" : ""), title: p, onclick: () => { if (p !== at) go(p, true); } }, isDriveRoot(p) ? p.replace(/[\\/]$/, "") : nameOf(p))]).filter(Boolean));
    mapEl.hidden = tab !== "map";
    list.hidden = tab === "map";
    if (!data) { total.textContent = "Counting…"; list.replaceChildren(); mapEl.replaceChildren(); return; }
    const left = (data.children || []).filter((c) => c.done === false).length;
    total.textContent = `${fmtSize(data.total)} · ${data.files.toLocaleString()} file${data.files === 1 ? "" : "s"}${data.done === false ? ` · counting, ${left} folder${left === 1 ? "" : "s"} to go…` : ""}`;
    if (tab === "map") return requestAnimationFrame(paintMap);
    if (tab === "here") {
      const max = data.children.length ? data.children[0].size : 0;
      list.replaceChildren(...data.children.map((c) => row(c.path, c.dir, c.size, max, c.dir ? `${c.files.toLocaleString()} file${c.files === 1 ? "" : "s"}` : "")));
    } else {
      const max = data.largest.length ? data.largest[0].size : 0;
      const dirOf = (p) => p.slice(at.length + 1, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1).replace(/\\/g, "/");
      list.replaceChildren(...data.largest.map((f) => row(f.path, false, f.size, max, dirOf(f.path))));
    }
    if (!list.children.length) list.append(h("div", { class: "sz-empty", text: "Nothing in here." }));
  }
  /* Counting: answered at once from what earlier counts found, or counted in the background - eight top
     folders at a time, each block in as its folder is done - and asked about four times a second. */
  let running = 0, starting = 0;
  async function load(fresh = false) {
    const n = ++asked;
    if (running) { app.host.sizesStop && app.host.sizesStop(running).catch(() => {}); running = 0; }
    data = null;
    paint();
    try {
      if (!app.host.sizesStart) { const d = await app.host.folderSizes(at); if (n === asked) { data = { ...d, done: true }; paint(); } return; }
      starting = n; // a slow folder can keep the answer away for a while: leaving now must count as well
      const r = await app.host.sizesStart(at, fresh);
      if (n !== asked) { if (r.id) app.host.sizesStop(r.id).catch(() => {}); return; } // no longer wanted: its count stops too
      if (r.result) { data = r.result; paint(); return; }
      running = r.id;
      while (n === asked) {
        const d = await app.host.sizesPoll(r.id);
        if (n !== asked) return;
        data = d;
        paint();
        if (d.done) { running = 0; return; }
        await new Promise((ok) => setTimeout(ok, 250));
      }
    } catch (e) { if (n === asked) total.textContent = String(e); }
    finally { if (starting === n) starting = 0; }
  }
  // the map follows the view's size
  new ResizeObserver(() => { if (tab === "map" && data && !el.hidden) paintMap(); }).observe(mapEl);

  let cutShort = false;
  app.bus.on("view", (t) => {
    const here = !!t && t.kind === "view" && t.view === "space";
    if (!here && (running || starting)) { if (running) app.host.sizesStop(running).catch(() => {}); running = starting = 0; asked++; cutShort = true; }
  });
  app.spaceGo = (path) => { app.spaceAsk = null; const p = absOf(path); go(p, true); };
  return {
    show() {
      paintPlaces();
      if (app.spaceAsk != null) app.spaceGo(app.spaceAsk);
      else if ((!data && asked === 0) || cutShort) { cutShort = false; load(); } // what was counted before is not counted again
    },
  };
}
