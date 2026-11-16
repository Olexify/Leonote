// Bookmark grounds on the start page: named groups laid out as a grid, each
// folded or open, narrow or wide, coloured if you like, with bookmarks dragged
// between them. "Bookmarks" (id "") is the ground every bookmark starts in.
import { h } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast, confirmDialog, inlineEdit, sortable } from "./ui.js";
import { colorVar } from "./tabgroups.js";
import { customizeGroup, groupLookOf } from "./tabstyle.js";

// how wide a ground is, in columns of the grid
const WIDTHS = [["1", "One column"], ["2", "Two"], ["3", "Three"], ["full", "The whole row"], ["fit", "As wide as its bookmarks need"]];
const spanOf = (g, n) => (g.width === "full" ? "1 / -1" : g.width === "fit" ? `span ${Math.max(1, Math.min(4, Math.ceil(n / 4)))}` : g.width === "2" || g.width === "3" ? `span ${g.width}` : g.wide ? "span 2" : "");

const BASE = { id: "", name: "Bookmarks" };

/** Every ground, the base one first. */
export const groupsOf = (S) => {
  const own = Array.isArray(S.webGroups) ? S.webGroups.filter((g) => g && g.id) : [];
  const base = { ...BASE, ...(S.webBaseGroup || {}), id: "" };
  if (base.hidden) return own;
  const at = Math.max(0, Math.min(Number(base.at) || 0, own.length));
  return [...own.slice(0, at), base, ...own.slice(at)];
};

/**
 * ctx: { app, marks(), saveMarks(list), siteTile(b), open(url), newTab(url), redraw(), addMark(groupId) }
 * Returns the section element.
 */
export function bookmarkGrounds(ctx) {
  const { app, marks, saveMarks, siteTile, newTab, redraw, addMark } = ctx;
  const S = app.settings;
  const groups = groupsOf(S);
  const known = new Set(groups.map((g) => g.id));
  const gid = (b) => (b.group && known.has(b.group) ? b.group : groups.length ? groups[0].id : "");
  const saveGroups = (list) => app.setSetting("webGroups", list.filter((g) => g.id));
  const patchGroup = (id, patch) => {
    if (!id) return app.setSetting("webBaseGroup", { ...(S.webBaseGroup || {}), ...patch });
    saveGroups(groupsOf(S).filter((g) => g.id).map((g) => (g.id === id ? { ...g, ...patch } : g)));
  };
  /** Put group `id` before group `beforeId` (null = the end), the base one included. */
  const placeGroup = (id, beforeId) => {
    const all = groupsOf(S).filter((g) => g.id !== id);
    const at = beforeId == null ? all.length : all.findIndex((g) => g.id === beforeId);
    all.splice(at < 0 ? all.length : at, 0, groupsOf(S).find((g) => g.id === id));
    saveGroups(all.filter((g) => g.id));
    app.setSetting("webBaseGroup", { ...(S.webBaseGroup || {}), at: all.findIndex((g) => !g.id) });
    redraw();
  };
  const newGroup = () => {
    const g = { id: "g-" + Date.now().toString(36), name: "New group" };
    saveGroups([...groupsOf(S).filter((x) => x.id), g]);
    app.setSetting("webMarkInto", g.id);
    redraw();
    requestAnimationFrame(() => { const el = document.querySelector(`.wt-ground[data-id="${g.id}"] .wt-ground-name`); if (el) startRename(el, g); });
  };
  const startRename = (nameEl, g) => inlineEdit(nameEl, g.name, { onCommit: (v) => { if (v.trim()) patchGroup(g.id, { name: v.trim() }); redraw(); }, onCancel: () => redraw() });
  const openAll = (list) => { for (const b of list.slice(0, 20)) newTab(b.url); if (list.length > 20) toast("The first 20 opened", { ms: 2200 }); };

  // write the marks back grouped: within a group the order is what was shown
  const write = (byGroup) => saveMarks(groups.flatMap((g) => byGroup.get(g.id) || []));
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  for (const b of marks()) byGroup.get(gid(b)).push(b);

  const ground = (g) => {
    const list = byGroup.get(g.id);
    const name = h("b", { class: "wt-ground-name", text: g.name, title: "Double-click to rename", ondblclick: (e) => { e.stopPropagation(); startRename(name, g); } });
    // the same customizer as a tab group's: colour, chip, name style, icon
    const customize = () => {
      const draft = { name: g.name, color: g.color || "grey", look: g.look ? { ...g.look } : undefined };
      customizeGroup(el.querySelector(".wt-ground-head").getBoundingClientRect(), draft, { title: "Bookmark group", onChange: () => {
        patchGroup(g.id, { name: draft.name || g.name, color: draft.color === "grey" && !draft.look ? "" : draft.color, look: draft.look || null });
        redraw();
      } });
    };
    const look = groupLookOf(g);
    const gmenu = (x, y) => menu(x, y, [
      { header: g.name },
      { label: "Rename", icon: "edit", run: () => startRename(name, g) },
      { label: "Customize…", icon: "palette", keys: "colour, icon, name", run: () => customize() },
      { label: "Width", icon: "columns", sub: WIDTHS.map(([v, label]) => ({ label, checked: (g.width || (g.wide ? "2" : "1")) === v, run: () => { patchGroup(g.id, { width: v, wide: false }); redraw(); } })) },
      { label: g.folded ? "Unfold" : "Fold", icon: "chevronDown", run: () => { patchGroup(g.id, { folded: !g.folded }); redraw(); } },
      "sep",
      { label: "Add a bookmark…", icon: "plus", run: () => addMark(g.id, { x, y }) },
      list.length ? { label: `Open all ${list.length} in tabs`, icon: "globe", run: () => openAll(list) } : null,
      "sep",
      { label: "Delete group…", icon: "trash", danger: true, run: async () => {
        const into = groups.find((x) => x.id !== g.id);
        const what = !list.length ? "The group is empty; nothing else changes." : into ? `Its ${list.length} bookmark${list.length === 1 ? "" : "s"} move to ${into.name}. Nothing else changes.` : `Its ${list.length} bookmark${list.length === 1 ? "" : "s"} go with it - it is the last group.`;
        if (!(await confirmDialog(`Delete ${g.name}?`, what, { ok: "Delete the group", safe: !into }))) return;
        saveMarks(into ? marks().map((b) => (gid(b) === g.id ? { ...b, group: into.id } : b)) : marks().filter((b) => gid(b) !== g.id));
        if (g.id) saveGroups(groups.filter((x) => x.id && x.id !== g.id));
        else app.setSetting("webBaseGroup", { ...(S.webBaseGroup || {}), hidden: true });
        redraw();
      } },
    ]);
    const body = h("div", { class: "wt-sites wt-ground-body", dataset: { group: g.id } },
      ...list.map((b) => siteTile(b)),
      list.length ? null : h("div", { class: "wt-empty is-drop", text: "Drop bookmarks here, press +, or the star in the address bar on a page." }));
    let el;
    el = h("div", { class: "wt-ground" + (g.folded ? " is-folded" : "") + (look.chip ? " is-" + look.chip : "") + (look.wash ? " is-wash" : "") + (look.noLine ? " no-line" : "") + (look.size ? " is-" + look.size : "") + (look.bold ? " is-bold" : "") + (look.italic ? " is-italic" : "") + (look.caps ? " is-caps" : ""),
      dataset: { id: g.id, color: g.color || "" }, style: { "--gc": g.color ? colorVar(g.color) : "var(--accent)", gridColumn: spanOf(g, list.length) || "" } },
      h("div", { class: "wt-ground-head", draggable: true, title: "Drag to move the group · click to fold it", onclick: (e) => { if (e.target.closest("button, .inline-edit")) return; patchGroup(g.id, { folded: !g.folded }); el.classList.toggle("is-folded"); },
        oncontextmenu: (e) => { e.preventDefault(); gmenu(e.clientX, e.clientY); },
        ondragstart: (e) => { if (e.target.closest(".inline-edit")) return e.preventDefault(); dragGroup = g.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "group:" + g.id); el.classList.add("is-dragging"); },
        ondragend: () => { dragGroup = null; for (const x of grid.querySelectorAll(".is-dragging, .drop-before, .drop-after")) x.classList.remove("is-dragging", "drop-before", "drop-after"); } },
        h("span", { class: "wt-ground-fold" }, icon("chevronDown")),
        look.icon ? icon(look.icon, "wt-ground-ico") : null,
        name,
        h("span", { class: "wt-ground-n", text: list.length ? String(list.length) : "" }),
        h("button", { class: "icon-btn wt-ground-btn", title: "Add a bookmark to this group", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); addMark(g.id, { x: r.left, y: r.bottom + 4 }); } }, icon("plus")),
        h("button", { class: "icon-btn wt-ground-btn", title: "Rename, colour, width, open all…", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); gmenu(r.right - 200, r.bottom + 4); } }, icon("more"))),
      body);
    return el;
  };

  let dragGroup = null;
  const grid = h("div", { class: "wt-grounds" }, ...groups.map(ground),
    groups.length ? null : h("div", { class: "wt-empty", text: "No groups. Press New group, or the star in the address bar on a page." }));
  // a group in the air lands before or after the one it is over (by the pointer's side of it)
  const overGroup = (e) => { const t = e.target.closest && e.target.closest(".wt-ground"); return t && t.dataset.id !== dragGroup ? t : null; };
  grid.addEventListener("dragover", (e) => {
    if (!dragGroup) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    for (const x of grid.querySelectorAll(".drop-before, .drop-after")) x.classList.remove("drop-before", "drop-after");
    const t = overGroup(e);
    if (t) { const r = t.getBoundingClientRect(); t.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after"); }
  });
  grid.addEventListener("drop", (e) => {
    if (!dragGroup) return;
    e.preventDefault();
    const t = overGroup(e);
    const id = dragGroup;
    dragGroup = null;
    if (!t) return placeGroup(id, null);
    const r = t.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    const ids = groupsOf(S).map((g) => g.id);
    const k = ids.indexOf(t.dataset.id);
    placeGroup(id, before ? t.dataset.id : ids[k + 1] == null ? null : ids[k + 1]);
  });
  // bookmarks move within a group and between groups by dragging
  sortable(grid, {
    axis: "x",
    item: ".wt-site",
    adopt: ".wt-ground-body",
    onMove: (i, j, el) => {
      const g = el.closest(".wt-ground-body").dataset.group;
      const list = byGroup.get(g);
      const [m] = list.splice(i, 1);
      list.splice(j, 0, m);
      write(byGroup);
      redraw();
    },
    onAdopt: (el, host, before) => {
      const from = el.closest(".wt-ground-body").dataset.group;
      const to = host.dataset.group;
      const src = byGroup.get(from);
      const b = src.find((x) => x.url === el.dataset.url);
      if (!b) return;
      src.splice(src.indexOf(b), 1);
      const dst = byGroup.get(to);
      const at = before ? dst.findIndex((x) => x.url === before.dataset.url) : -1;
      const moved = { ...b, group: to };
      if (at >= 0) dst.splice(at, 0, moved); else dst.push(moved);
      write(byGroup);
      redraw();
    },
  });

  return h("section", { class: "wt-sec wt-marks" },
    h("div", { class: "wt-sec-head" }, h("span", { text: "Bookmarks" }),
      h("span", { class: "wt-sec-tools" },
        h("button", { class: "wt-link", title: "A new group of bookmarks - references, work, reading: whatever you keep together", onclick: newGroup }, icon("plus"), "New group"),
        marks().length ? h("button", { class: "wt-link", onclick: () => ctx.library("bookmarks") }, "All bookmarks") : null,
        h("button", { class: "wt-link", title: "Take bookmarks off the start page (the gear brings them back)", onclick: () => { app.setSetting("webMarksOff", true); redraw(); } }, icon("x"), "Hide"))),
    grid);
}

/** The group a new bookmark goes into: the one last added to by hand, if it still exists. */
export function markInto(S) {
  const id = S.webMarkInto || "";
  return groupsOf(S).some((g) => g.id === id) ? id : "";
}
