// New tab (Ctrl+T or +): a small launcher under the + button - make a note
// (here or in a folder you used lately), a sketch or a board, reopen a recent
// file, or jump to a view. Typing anything turns it into the quick switcher.

import { h, basename, dirname } from "./util.js";
import { icon } from "./icons.js";
import { KIND_ICON } from "./fileview.js";

let open = null;

export function closeNewTab() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener("keydown", open.onKey, true);
  document.removeEventListener("mousedown", open.onDown, true);
  open = null;
}

export function openNewTab(app, anchor) {
  if (open) return closeNewTab();
  const recent = (app.settings.recent || []).filter((p) => app.vault.notes.has(p) || app.vault.files.has(p));
  // folders you wrote in lately, most recent first
  const folders = [];
  for (const p of recent) {
    const d = dirname(p);
    if (d && !folders.includes(d) && app.vault.folders.has(d)) folders.push(d);
    if (folders.length >= 3) break;
  }
  const here = app.lastNotePath && app.lastNotePath() ? dirname(app.lastNotePath()) : "";

  const items = [];
  const row = (ic, label, sub, run, keys) => {
    const b = h("button", { class: "nt-item", onclick: () => { closeNewTab(); run(); } },
      icon(ic), h("span", { class: "nt-label", text: label }), sub ? h("span", { class: "nt-sub", text: sub }) : null, keys ? h("kbd", { text: keys }) : null);
    items.push(b);
    return b;
  };
  const head = (t) => h("div", { class: "nt-head", text: t });
  const tile = (ic, label, run, title) => {
    const b = h("button", { class: "nt-tile", title: title || label, onclick: () => { closeNewTab(); run(); } }, icon(ic), h("span", { text: label }));
    items.push(b);
    return b;
  };

  const el = h("div", { class: "nt-pop", role: "menu" },
    h("div", { class: "nt-tiles" },
      tile("filePlus", "Note", () => app.newNote({ dir: here, newTab: true }), `New note${here ? " in " + here : ""} (Ctrl+N)`),
      tile("brush", "Sketch", () => app.newSketch({ anchor })),
      tile("grid", "Board", () => app.newBoard({})),
      tile("calendar", "Today", () => app.openDaily(undefined, { newTab: true })),
      tile("search", "Search", () => app.palette("switcher", { force: true, newTab: true }), "Search everything (Ctrl+O) - or just start typing")),
    folders.length ? head("New note in") : null,
    ...folders.map((d) => row("folder", basename(d), dirname(d) || null, () => app.newNote({ dir: d, newTab: true }))),
    recent.length ? head("Recent") : null,
    ...recent.slice(0, 6).map((p) => {
      const note = app.vault.notes.has(p);
      const f = note ? null : app.vault.files.get(p);
      return row(note ? "fileText" : KIND_ICON[f.kind] || "file", note ? basename(p) : p.slice(p.lastIndexOf("/") + 1), dirname(p) || null,
        () => (note ? app.openNote(p, { newTab: true }) : app.openFile(p, { newTab: true })));
    }),
    h("div", { class: "nt-views" },
      ...app.views.filter((v) => v.id !== "settings").map((v) => {
        const b = h("button", { class: "nt-view", title: v.name, onclick: () => { closeNewTab(); app.openView(v.id, { newTab: true }); } }, icon(v.icon));
        items.push(b);
        return b;
      })),
    (() => {
      // where the + puts a new tab
      const at = () => (app.settings.newTabAt === "end" ? "end" : "after");
      const seg = h("div", { class: "segmented is-small" }, [["after", "After current"], ["end", "At end"]].map(([v, label]) =>
        h("button", { class: "seg" + (at() === v ? " is-active" : ""), dataset: { v }, onclick: (e) => { e.stopPropagation(); app.setSetting("newTabAt", v); for (const b of seg.children) b.classList.toggle("is-active", b.dataset.v === v); } }, label)));
      return h("div", { class: "nt-where" }, h("span", { text: "A new tab opens" }), seg);
    })(),
    (() => {
      // a link opened in a new tab: switch to it, or stay where you are
      const bg = () => app.settings.linkTabBackground !== false;
      const seg = h("div", { class: "segmented is-small" }, [["stay", "Stay here"], ["go", "Switch to it"]].map(([v, label]) =>
        h("button", { class: "seg" + ((bg() ? "stay" : "go") === v ? " is-active" : ""), dataset: { v }, onclick: (e) => { e.stopPropagation(); app.setSetting("linkTabBackground", v === "stay"); for (const b of seg.children) b.classList.toggle("is-active", b.dataset.v === v); } }, label)));
      return h("div", { class: "nt-where" }, h("span", { text: "A link in a new tab" }), seg);
    })(),
    h("div", { class: "nt-foot", text: "Type to search · ↑↓ Enter" }));
  document.getElementById("overlay-root").append(el);

  const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 150, bottom: 80 };
  const w = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left - 8, innerWidth - w.width - 8)) + "px";
  el.style.top = Math.min(r.bottom + 6, innerHeight - w.height - 8) + "px";
  requestAnimationFrame(() => el.classList.add("is-in"));

  let idx = -1;
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return closeNewTab(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.key === "Tab" && !e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
      idx = (idx + d + items.length) % items.length;
      items[idx].focus();
      return;
    }
    if (e.key === "Enter" && idx < 0) { e.preventDefault(); e.stopPropagation(); closeNewTab(); app.newNote({ dir: here, newTab: true }); return; }
    // any printable key: search instead, starting with that letter
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      closeNewTab();
      app.palette("switcher", { force: true, newTab: true, query: e.key });
    }
  };
  const onDown = (e) => { if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) closeNewTab(); };
  // a click on a page's own view never reaches this document: the page says it took the keys, and the panel goes
  if (!openNewTab.watching && app.bus) { openNewTab.watching = true; app.bus.on("extpop:blur", () => closeNewTab()); window.addEventListener("blur", () => closeNewTab()); }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  open = { el, onKey, onDown };
}

/**
 * "Where should it go?" - the same small popup, listing the folder you work
 * in, folders used lately, the pictures folder and the vault root, plus a
 * search over every folder. Resolves to a folder path ("" = root) or null.
 */
/** Where a new thing could go: [folder, why] pairs - the usual place first, then where you work, the extras, recent folders, the root. */
export function folderChoices(app, { extra = [], first = null } = {}) {
  const here = app.lastNotePath && app.lastNotePath() ? dirname(app.lastNotePath()) : "";
  const seen = new Set();
  const list = [];
  const add = (d, why) => { if (d == null || seen.has(d) || (d && !app.vault.folders.has(d))) return; seen.add(d); list.push([d, why]); };
  // the usual place leads, whether or not the folder exists yet - it is made with the file
  if (first && first[0] != null) { seen.add(first[0]); list.push([first[0], first[1] || "the usual place"]); }
  add(here, "where you work");
  for (const [d, why] of extra) add(d, why);
  for (const p of app.settings.recent || []) { if (list.length >= 6) break; add(dirname(p), "recent"); }
  add("", "vault root");
  return list;
}

/**
 * `tail(finish)`: an element set under the folders - the recent sketches, say - that may end the picker itself.
 * `stars`: a key (or a function giving one) under which the folders you star are kept: they lead the list,
 * marked, in the order you drag them to. Unset, the usual place is the one starred - one obvious choice.
 * `first` may be a function too, and `ctl.refresh()` redraws the list when what they give has changed.
 */
export function pickFolder(app, anchor, { title = "Create in", extra = [], first = null, tail = null, head = null, stars = null, ctl = null } = {}) {
  closeNewTab();
  const STAR_MORE = Symbol("star");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; closeNewTab(); resolve(v); };
    let items = [];
    const listBox = h("div", { class: "nt-folders" });
    const starKey = () => (typeof stars === "function" ? stars() : stars);
    const firstNow = () => (typeof first === "function" ? first() : first);
    const starred = () => {
      const k = starKey();
      if (!k) return [];
      const kept = (app.settings.folderStars || {})[k];
      const f = firstNow();
      return Array.isArray(kept) ? kept : f && f[0] != null ? [f[0]] : [];
    };
    const saveStars = (list) => { const k = starKey(); if (k) app.setSetting("folderStars", { ...(app.settings.folderStars || {}), [k]: list }); };
    let dragFrom = null;
    const row = (ic, label, sub, run, extraEl = null, cls = "") => {
      // the star inside the row: the S key, since a button cannot hold another
      const b = h("button", { class: "nt-item" + cls, onclick: run, onkeydown: extraEl ? (e) => { if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); const d = extraEl.dataset.dir; extraEl.click(); idx = Math.max(0, items.findIndex((x) => x.querySelector(".nt-star")?.dataset.dir === d)); items[idx].focus(); } } : null }, icon(ic), h("span", { class: "nt-label", text: label }), sub ? h("span", { class: "nt-sub", text: sub }) : null, extraEl);
      items.push(b);
      return b;
    };
    function render() {
      items = [];
      const f = firstNow();
      const why = new Map(folderChoices(app, { extra, first: f }));
      const st = starred();
      const usual = f && f[0];
      const subOf = (d, w) => (d ? (dirname(d) ? dirname(d) + " · " : "") + (w || "") : "").replace(/ · $/, "");
      const starBtn = (d, on) => h("span", {
        class: "nt-star" + (on ? " is-on" : ""), role: "button", dataset: { dir: d }, title: on ? "Unstar - drag a starred folder to move it" : "Star: keep it at the top",
        onclick: (e) => { e.stopPropagation(); saveStars(on ? st.filter((x) => x !== d) : [...st, d]); render(); },
      }, icon("star"));
      const rows = [];
      st.forEach((d, i) => {
        const b = row(d ? "folder" : "home", d ? basename(d) : "Vault root", subOf(d, d === usual ? "the usual place" : why.get(d) || ""), () => finish(d), starBtn(d, true), " is-star");
        if (st.length > 1) {
          b.draggable = true;
          b.addEventListener("dragstart", (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; });
          b.addEventListener("dragover", (e) => { if (dragFrom != null) { e.preventDefault(); b.classList.add("is-drop"); } });
          b.addEventListener("dragleave", () => b.classList.remove("is-drop"));
          b.addEventListener("drop", (e) => { e.preventDefault(); if (dragFrom == null || dragFrom === i) return; const next = [...st]; const [m] = next.splice(dragFrom, 1); next.splice(i, 0, m); dragFrom = null; saveStars(next); render(); });
          b.addEventListener("dragend", () => { dragFrom = null; });
        }
        rows.push(b);
      });
      for (const [d, w] of why) if (!st.includes(d)) rows.push(row(d ? "folder" : "home", d ? basename(d) : "Vault root", subOf(d, w), () => finish(d), starKey() ? starBtn(d, false) : null));
      if (starKey()) rows.push(row("star", "Star a folder…", "", () => finish(STAR_MORE)));
      rows.push(row("search", "Another folder…", "", () => { finish(undefined); }));
      listBox.replaceChildren(...rows);
    }
    if (ctl) ctl.refresh = render;
    render();
    const el = h("div", { class: "nt-pop is-picker", role: "menu" },
      h("div", { class: "nt-head", text: title }),
      head,
      listBox,
      tail ? tail(finish) : null,
      h("div", { class: "nt-foot", text: starKey() ? "↑↓ Enter · S to star · Esc to cancel" : "↑↓ Enter · Esc to cancel" }));
    document.getElementById("overlay-root").append(el);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 150, right: innerWidth / 2 + 150, top: 80, bottom: 80 };
    const w = el.getBoundingClientRect();
    // beside a button in the side ribbon, under anything else
    const side = r.right < 120;
    el.style.left = Math.max(8, Math.min(side ? r.right + 8 : r.left - 8, innerWidth - w.width - 8)) + "px";
    el.style.top = Math.max(8, Math.min(side ? r.top - 8 : r.bottom + 6, innerHeight - w.height - 8)) + "px";
    requestAnimationFrame(() => el.classList.add("is-in"));
    let idx = 0;
    requestAnimationFrame(() => items[0] && items[0].focus());
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return finish(null); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        idx = (idx + (e.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[idx].focus();
      }
    };
    const onDown = (e) => { if (!el.contains(e.target)) finish(null); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    open = { el, onKey, onDown };
  }).then((v) => {
    if (v === STAR_MORE) {
      // a folder from the search, starred, and the picker back again
      return new Promise((res) => app.palette("move", { onPick: res })).then((d) => {
        if (d != null) {
          const k = typeof stars === "function" ? stars() : stars;
          const all = app.settings.folderStars || {};
          const f = typeof first === "function" ? first() : first;
          const now = Array.isArray(all[k]) ? all[k] : f && f[0] != null ? [f[0]] : [];
          if (!now.includes(d)) app.setSetting("folderStars", { ...all, [k]: [...now, d] });
        }
        return pickFolder(app, anchor, { title, extra, first, tail, head, stars, ctl });
      });
    }
    if (v !== undefined) return v;
    // any folder, through the folder search
    return new Promise((res) => app.palette("move", { onPick: res }));
  });
}
