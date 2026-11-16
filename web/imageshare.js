// Using one picture in several places.
//
// A picture in the vault is a file, not a copy: the same `![[photo.webp]]`
// can sit in ten notes and on three research boards and still be one file on
// disk. These are the small actions that make that obvious — copy the embed,
// drop it into another note, put it on a board.

import { basename, dirname, h } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast } from "./ui.js";
import { fuzzy } from "./search.js";
import { embedFor, insertEmbed } from "./imageeditmodel.js";

export { embedFor, insertEmbed };

/** `![[photo.webp]]` on the clipboard. */
export function copyEmbed(path) {
  const t = embedFor(path);
  navigator.clipboard.writeText(t).then(
    () => toast(`${t} copied — paste it into any note`, { ms: 2600 }),
    () => toast("Could not reach the clipboard", { kind: "error" }),
  );
}

/**
 * Append the embed to a note. The note is written through the vault, so an
 * open editor picks it up the same way an agent's edit does.
 */
export async function embedInNote(app, imagePath, notePath) {
  const note = app.vault.get(notePath);
  if (!note) return toast("That note is gone", { kind: "error" });
  const { text, added } = insertEmbed(note.content, embedFor(imagePath));
  if (!added) {
    return toast(`${basename(notePath)} already shows this picture`, {
      ms: 4000,
      action: { label: "Open it", run: () => app.openNote(notePath, { newTab: true }) },
    });
  }
  try {
    await app.vault.write(notePath, text);
    toast(`Added to ${basename(notePath)} — still one file on disk`, {
      ms: 5000,
      action: { label: "Open", run: () => app.openNote(notePath, { newTab: true }) },
    });
  } catch (e) {
    toast("Could not write that note: " + e, { kind: "error" });
  }
}

let pickerOpen = null;
export function closeNotePicker() {
  if (pickerOpen) { pickerOpen(); pickerOpen = null; }
}

/**
 * "Which note?" — recent notes first, then a fuzzy search over every note.
 * Resolves to a note path, or null.
 */
export function pickNote(app, { anchor, title = "Insert into a note" } = {}) {
  closeNotePicker();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; closeNotePicker(); resolve(v); };
    const input = h("input", { class: "np-input", placeholder: "Search notes…", spellcheck: false, autocomplete: "off" });
    const list = h("div", { class: "np-list", role: "listbox" });
    const el = h("div", { class: "np-pop", role: "dialog" },
      h("div", { class: "np-head" }, icon("search"), input),
      list,
      h("div", { class: "np-foot", text: "↑↓ Enter · Esc to cancel" }));
    let rows = [];
    let sel = 0;

    const recent = () => {
      const seen = new Set();
      const out = [];
      for (const p of app.recentPaths ? app.recentPaths() : []) {
        const n = app.vault.get(p);
        if (n && !seen.has(p)) { seen.add(p); out.push(n); }
      }
      for (const n of [...app.vault.notes.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))) {
        if (!seen.has(n.path)) { seen.add(n.path); out.push(n); }
      }
      return out.slice(0, 40);
    };

    function render() {
      const q = input.value.trim();
      const notes = q
        ? [...app.vault.notes.values()]
            .map((n) => [fuzzy(q, n.title) || fuzzy(q, n.path), n])
            .filter(([f]) => f)
            .sort((a, b) => b[0].score - a[0].score)
            .slice(0, 40)
            .map(([, n]) => n)
        : recent();
      rows = notes;
      sel = 0;
      list.replaceChildren(...notes.map((n, i) =>
        h("button", { class: "np-row" + (i === 0 ? " is-sel" : ""), onclick: () => finish(n.path) },
          icon("fileText"),
          h("span", { class: "np-title", text: n.title || basename(n.path) }),
          h("span", { class: "np-sub", text: n.folder || (n.path.includes("/") ? dirname(n.path) : "") }))));
      if (!notes.length) list.replaceChildren(h("div", { class: "np-empty", text: "No note matches" }));
    }
    const step = (d) => {
      if (!rows.length) return;
      list.children[sel]?.classList.remove("is-sel");
      sel = (sel + d + rows.length) % rows.length;
      const r = list.children[sel];
      r.classList.add("is-sel");
      r.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", render);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); step(-1); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (rows[sel]) finish(rows[sel].path); }
    };
    const onDown = (e) => { if (!el.contains(e.target)) finish(null); };
    el.prepend(h("div", { class: "np-title-bar", text: title }));
    document.getElementById("overlay-root").append(el);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 170, bottom: 90, top: 90, right: innerWidth / 2 + 170 };
    const w = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - w.width - 8)) + "px";
    el.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - w.height - 8)) + "px";
    requestAnimationFrame(() => { el.classList.add("is-in"); input.focus(); });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    pickerOpen = () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      el.remove();
    };
    render();
  });
}

/** Ask which note, then embed the picture there. */
export async function insertIntoNote(app, imagePath, { anchor } = {}) {
  const note = await pickNote(app, { anchor });
  if (note) await embedInNote(app, imagePath, note);
}

/** Research boards are `.canvas` files; a picture is an ordinary file node. */
export function boardsIn(app) {
  return [...app.vault.files.keys()].filter((p) => /\.canvas$/i.test(p)).sort();
}

/** "Add to a research board": pick one, or start a new one holding it. */
export function addToBoardMenu(app, imagePath, anchor) {
  if (!app.addToBoard || !app.newBoard) return toast("Research boards are not available in this version");
  const list = boardsIn(app);
  menu(0, 0, [
    { header: list.length ? "Add this picture to" : "No boards yet" },
    ...list.slice(0, 24).map((b) => ({ label: basename(b).replace(/\.canvas$/i, ""), icon: "grid", run: () => app.addToBoard(b, [imagePath]) })),
    list.length ? "sep" : null,
    { label: "New research board", icon: "plus", run: () => app.newBoard({ notes: [imagePath] }) },
  ], anchor ? { anchor } : {});
}

/**
 * The three "use it somewhere else" rows, for the viewer's and the file
 * view's menus. `anchor` is optional and only steers where popups land.
 */
export function shareMenuItems(app, imagePath, anchor) {
  return [
    { label: "Copy embed link", icon: "link", run: () => copyEmbed(imagePath) },
    { label: "Insert into a note…", icon: "filePlus", run: () => insertIntoNote(app, imagePath, { anchor }) },
    { label: "Add to a research board…", icon: "grid", run: () => addToBoardMenu(app, imagePath, anchor) },
  ];
}
