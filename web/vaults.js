// The vault list behind the folder button in the sidebar foot.
//
// One click shows every vault Leonote knows about: the built-in one, the
// Obsidian vaults it found, and any folder the user added by hand. The list
// is the user's own - drag to reorder, hide the ones that are noise - and
// clicking one opens it (which restarts the app, because every path, watcher
// and index belongs to a single vault). Double-clicking the button skips all
// of this and opens the current vault in the file manager.

import { h } from "./util.js";
import { icon } from "./icons.js";
import { sortable, menu } from "./ui.js";

const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
const LEO = "leonote:built-in"; // the built-in vault has no path of its own

let closeOpen = () => {}; // only one panel at a time

/** Every vault we know of, in the user's order, with the hidden ones marked. */
export async function vaultList(app) {
  const S = app.settings;
  let found = [];
  try { found = (await app.host.vaultCandidates()) || []; } catch {}
  const extra = Array.isArray(S.vaultsExtra) ? S.vaultsExtra : [];
  const here = norm(app.vault.root);

  const rows = [{ key: LEO, path: null, name: "Leonote", kind: "built in", exists: true }];
  for (const v of found) {
    if (!v || !v.path || rows.some((r) => r.key === norm(v.path))) continue;
    rows.push({ key: norm(v.path), path: v.path, name: v.name || v.path, kind: "Obsidian", exists: v.exists !== false });
  }
  for (const v of extra) {
    if (!v || !v.path || rows.some((r) => r.key === norm(v.path))) continue;
    rows.push({ key: norm(v.path), path: v.path, name: v.name || v.path, kind: "folder", exists: true, added: true });
  }

  const hidden = new Set((S.vaultsHidden || []).map(norm));
  const order = (S.vaultOrder || []).map(norm);
  const rank = (r, i) => { const j = order.indexOf(r.key); return j < 0 ? order.length + i : j; };
  rows.forEach((r, i) => { r.rank = rank(r, i); });
  rows.sort((a, b) => a.rank - b.rank);
  for (const r of rows) {
    r.hidden = hidden.has(r.key) && !(r.path ? norm(r.path) === here : !S.vault);
    r.current = r.path ? norm(r.path) === here : !S.vault;
  }
  return rows;
}

/** Open the list above `anchor`. */
export function vaultPanel(app, anchor) {
  closeOpen();
  const S = app.settings;
  const el = h("div", { class: "vaultpop", role: "dialog" });
  let rows = [];
  let showHidden = false;

  const shut = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    el.remove();
    closeOpen = () => {};
  };
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) shut(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
  closeOpen = shut;

  document.getElementById("overlay-root").append(el);
  draw();
  vaultList(app).then((list) => { rows = list; draw(); });
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  requestAnimationFrame(() => el.classList.add("is-in"));

  function save() {
    app.setSetting("vaultOrder", rows.map((r) => r.key));
    app.setSetting("vaultsHidden", rows.filter((r) => r.hidden).map((r) => r.key));
  }

  async function open(r) {
    if (r.current) { shut(); return app.reveal(""); }
    if (!r.exists) return app.toast(`${r.name} is not there any more`, { kind: "error" });
    shut();
    if (r.path) S.vault = r.path; else delete S.vault;
    app.toast(`Opening ${r.name}… Leonote restarts`, { ms: 4000 });
    try {
      await app.flushAll();
      await app.host.saveSettings(S);
      await app.host.restart();
    } catch (e) {
      app.toast("Could not switch vault: " + e, { kind: "error" });
    }
  }

  async function addFolder() {
    let picked = null;
    try { picked = await app.host.dialogOpen({ directory: true, multiple: false, title: "Open a folder as a vault" }); } catch {}
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    const name = String(path).split(/[\\/]/).filter(Boolean).pop() || path;
    const extra = Array.isArray(S.vaultsExtra) ? S.vaultsExtra : [];
    if (!extra.some((v) => norm(v.path) === norm(path))) app.setSetting("vaultsExtra", [...extra, { path, name }]);
    rows = await vaultList(app);
    draw();
  }

  function forget(r) {
    app.setSetting("vaultsExtra", (S.vaultsExtra || []).filter((v) => norm(v.path) !== r.key));
    rows = rows.filter((x) => x !== r);
    save();
    draw();
  }

  function row(r) {
    return h("div", {
      class: "vp-row" + (r.current ? " is-on" : "") + (r.hidden ? " is-off" : "") + (r.exists ? "" : " is-gone"),
      draggable: true, dataset: { key: r.key },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const abs = r.path || app.vault.root || "";
        menu(e.clientX, e.clientY, [
          { header: r.name },
          r.current ? null : { label: "Open this vault", icon: "folder", run: () => open(r) },
          abs ? { label: "Show in Explorer", icon: "reveal", run: () => app.host.externalReveal(abs).catch((err) => app.toast(String(err), { kind: "error" })) } : null,
          abs ? { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(abs); app.toast("Path copied", { ms: 1600 }); } } : null,
          "sep",
          r.current ? null : { label: r.hidden ? "Show it in this list" : "Hide it from this list", icon: "eye", run: () => { r.hidden = !r.hidden; save(); draw(); } },
          r.added ? { label: "Forget this folder", icon: "x", danger: true, run: () => forget(r) } : null,
        ].filter(Boolean));
      },
    },
      h("span", { class: "vp-grip", title: "Drag to reorder" }, icon("drag")),
      h("button", {
        class: "vp-main",
        title: r.current ? "You are in this one - click to open its folder" : r.path || "The vault Leonote keeps for you",
        onclick: () => open(r),
      }, icon("folder"), h("span", { class: "vp-name", text: r.name }),
        h("span", { class: "vp-kind", text: r.exists ? (r.current ? "open" : r.kind) : "missing" })),
      r.current ? h("span", { class: "vp-tick" }, icon("check")) : null,
      r.current ? null : h("button", {
        class: "icon-btn vp-eye", title: r.hidden ? "Show it in this list" : "Hide it from this list",
        onclick: () => { r.hidden = !r.hidden; save(); draw(); },
      }, icon("eye")),
      r.added ? h("button", { class: "icon-btn vp-x", title: "Forget this folder", onclick: () => forget(r) }, icon("x")) : null);
  }

  function draw() {
    const shown = rows.filter((r) => !r.hidden || showHidden);
    const list = h("div", { class: "vp-list" }, shown.map(row));
    sortable(list, {
      item: ".vp-row",
      onMove: (from, to) => {
        const keys = shown.map((r) => r.key);
        const [k] = keys.splice(from, 1);
        keys.splice(to, 0, k);
        const at = (r) => { const i = keys.indexOf(r.key); return i < 0 ? keys.length + rows.indexOf(r) : i; };
        rows.sort((a, b) => at(a) - at(b));
        save();
        draw();
      },
    });
    const nHidden = rows.filter((r) => r.hidden).length;
    el.replaceChildren(
      h("div", { class: "vp-head" }, h("span", { text: "Vaults" }), h("span", { class: "vp-hint", text: "drag to reorder" })),
      rows.length ? list : h("div", { class: "vp-empty", text: "Looking…" }),
      h("div", { class: "vp-foot" },
        h("button", { class: "vp-act", onclick: addFolder }, icon("folderPlus"), h("span", { text: "Open a folder…" })),
        nHidden ? h("button", { class: "vp-act", onclick: () => { showHidden = !showHidden; draw(); } }, icon("eye"), h("span", { text: showHidden ? "Hide the hidden" : `Show ${nHidden} hidden` })) : null,
        h("button", { class: "vp-act", onclick: () => { shut(); app.reveal(""); } }, icon("reveal"), h("span", { text: "Open this folder" }))));
    place();
  }

  function place() {
    const r = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - box.width - 8)) + "px";
    el.style.top = Math.max(8, r.top - box.height - 6) + "px";
  }

  return el;
}
