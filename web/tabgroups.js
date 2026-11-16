// Tab groups and tab colours. The top half is pure (the rules of the strip,
// tested in tests/tabgroups.test.js); the bottom half builds the two small
// popovers (group editor, group peek) that main.js opens.
//
// A tab may carry `color` (one of COLORS) and `group` (a group id). Groups
// live per space: { id, name, color, collapsed }. The strip always reads:
// pinned tabs, then loose tabs and group blocks, each group contiguous.

import { h } from "./util.js";
import { icon } from "./icons.js";

export const COLORS = ["grey", "blue", "teal", "green", "yellow", "orange", "red", "purple"];
export const COLOR_NAMES = { grey: "Grey", blue: "Blue", teal: "Teal", green: "Green", yellow: "Yellow", orange: "Orange", red: "Red", purple: "Purple" };
const HEX = /^#[0-9a-f]{6}$/i;
export const colorVar = (c) => (HEX.test(c || "") ? c : `var(--tg-${COLORS.includes(c) ? c : "grey"})`);

export const pinnedCount = (tabs) => tabs.reduce((n, t, k) => (t.pinned ? k + 1 : n), 0);

/** [start, end) of a group's tabs, or null when it has none. */
export function groupRange(tabs, gid) {
  const start = tabs.findIndex((t) => t.group === gid);
  if (start < 0) return null;
  let end = start;
  while (end < tabs.length && tabs[end].group === gid) end++;
  return { start, end };
}

export const groupOf = (groups, t) => (t && t.group ? groups.find((g) => g.id === t.group) || null : null);
export const isHidden = (groups, t) => !!(groupOf(groups, t) || {}).collapsed;

/**
 * The one place the strip's rules are enforced: pinned first and never
 * grouped, every group contiguous (gathered where its first tab sits),
 * unknown group ids dropped, and groups without tabs removed.
 * Tab objects keep their identity so callers can find the active one again.
 */
export function normalize(tabs, groups) {
  const known = new Set(groups.map((g) => g.id));
  for (const t of tabs) if (t.group && (t.pinned || !known.has(t.group))) delete t.group;
  const out = tabs.filter((t) => t.pinned);
  const seen = new Set();
  for (const t of tabs) {
    if (t.pinned) continue;
    if (!t.group) { out.push(t); continue; }
    if (seen.has(t.group)) continue;
    seen.add(t.group);
    for (const x of tabs) if (!x.pinned && x.group === t.group) out.push(x);
  }
  return { tabs: out, groups: groups.filter((g) => seen.has(g.id)) };
}

/** The tab to show after the one at `i` went away: nearest one that is not tucked in a collapsed group. */
export function nearestVisible(tabs, groups, i) {
  for (let d = 0; d < tabs.length; d++) {
    for (const k of [i + d, i - d - 1]) if (k >= 0 && k < tabs.length && !isHidden(groups, tabs[k])) return k;
  }
  return -1;
}

/** What the strip draws, in order: loose tabs and group blocks. */
export function stripItems(tabs, groups) {
  const items = [];
  for (let i = 0; i < tabs.length; i++) {
    const g = groupOf(groups, tabs[i]);
    if (!g) { items.push({ kind: "tab", index: i }); continue; }
    const last = items[items.length - 1];
    if (last && last.kind === "group" && last.group === g) last.tabs.push(i);
    else items.push({ kind: "group", group: g, tabs: [i] });
  }
  return items;
}

export function uniqueId(groups) {
  let id;
  do id = "g" + Math.random().toString(36).slice(2, 8); while (groups.some((g) => g.id === id));
  return id;
}

/** A colour no other group uses yet, so new groups tell apart at a glance. */
export function nextColor(groups) {
  const used = new Set(groups.map((g) => g.color));
  return COLORS.slice(1).find((c) => !used.has(c)) || COLORS[1 + (groups.length % (COLORS.length - 1))];
}

export function makeGroup(groups, { name = "", color } = {}) {
  return { id: uniqueId(groups), name, color: COLORS.includes(color) ? color : nextColor(groups), collapsed: false };
}

/* ── moves (each returns a fresh { tabs, groups }) ────────────────────── */

function moveTo(tabs, from, slot) {
  const out = tabs.slice();
  const [t] = out.splice(from, 1);
  out.splice(slot > from ? slot - 1 : slot, 0, t);
  return out;
}

/** Put tab `i` into a brand-new group `g` (it stays where it is). */
export function addToNewGroup(tabs, groups, i, g) {
  if (!tabs[i] || tabs[i].pinned) return { tabs, groups };
  tabs[i].group = g.id;
  return normalize(tabs, [...groups, g]);
}

/** Tab `i` joins group `gid` at its right end. */
export function addToGroup(tabs, groups, i, gid) {
  const t = tabs[i];
  const r = groupRange(tabs, gid);
  if (!t || t.pinned || !r || t.group === gid) return { tabs, groups };
  t.group = gid;
  return normalize(moveTo(tabs, i, r.end), groups);
}

/** Tab `i` leaves its group and sits just after it. */
export function removeFromGroup(tabs, groups, i) {
  const t = tabs[i];
  if (!t || !t.group) return { tabs, groups };
  const r = groupRange(tabs, t.group);
  delete t.group;
  return normalize(moveTo(tabs, i, r.end), groups);
}

export function ungroup(tabs, groups, gid) {
  for (const t of tabs) if (t.group === gid) delete t.group;
  return normalize(tabs, groups.filter((g) => g.id !== gid));
}

/**
 * Where a dragged tab lands. `over` is what the pointer is over:
 * { tab, after } (a tab index, and whether past its middle),
 * { chip, x } (a group chip, x = 0..1 across it), or { end: true } (the empty strip).
 * Over a grouped tab joins that group; over a loose tab leaves any group,
 * so dragging past a group's edge takes the tab out of it.
 */
export function dropPlan(tabs, groups, from, over) {
  const dragged = tabs[from];
  const pc = pinnedCount(tabs);
  let slot = tabs.length;
  let group = null;
  if (over.tab != null) {
    const target = tabs[over.tab];
    slot = over.tab + (over.after ? 1 : 0);
    if (!target.pinned) group = target.group || null;
  } else if (over.chip) {
    const g = groups.find((x) => x.id === over.chip);
    const r = g && groupRange(tabs, g.id);
    if (r) {
      // left part of the chip: in front of the group; the rest: into it
      if (over.x < 0.3) slot = r.start;
      else { group = g.id; slot = g.collapsed ? r.end : r.start; }
    }
  }
  if (dragged.pinned) return { slot: Math.min(slot, pc), group: null };
  return { slot: Math.max(slot, pc), group };
}

export function applyDrop(tabs, groups, from, plan) {
  const t = tabs[from];
  if (plan.group && !t.pinned) t.group = plan.group;
  else delete t.group;
  return normalize(moveTo(tabs, from, plan.slot), groups);
}

/**
 * Drop-and-hold onto a tab: join its group, or make a new one (`fresh`)
 * holding both. The dragged tab lands right after the target.
 */
export function groupOnto(tabs, groups, from, onto, fresh) {
  const a = tabs[from];
  const b = tabs[onto];
  if (!a || !b || a === b || a.pinned || b.pinned) return { tabs, groups };
  let next = groups;
  if (!b.group) { b.group = fresh.id; next = [...groups, fresh]; }
  a.group = b.group;
  return normalize(moveTo(tabs, from, onto + 1), next);
}

/** Where a dragged group lands: never inside another group, never among pinned tabs. */
export function groupDropSlot(tabs, groups, gid, over) {
  let slot = tabs.length;
  if (over.tab != null || over.chip) {
    const t = over.tab != null ? tabs[over.tab] : null;
    const hid = over.chip || (t && t.group);
    if (hid === gid) return null;
    if (hid) {
      const r = groupRange(tabs, hid);
      const pos = over.chip ? over.x : (over.tab - r.start + (over.after ? 1 : 0)) / (r.end - r.start);
      slot = pos > 0.5 ? r.end : r.start;
    } else slot = over.tab + (over.after ? 1 : 0);
  }
  return Math.max(slot, pinnedCount(tabs));
}

export function moveGroup(tabs, groups, gid, slot) {
  const r = groupRange(tabs, gid);
  if (!r || slot == null || (slot >= r.start && slot <= r.end)) return { tabs, groups };
  const block = tabs.slice(r.start, r.end);
  const rest = [...tabs.slice(0, r.start), ...tabs.slice(r.end)];
  const at = slot > r.end ? slot - block.length : slot;
  rest.splice(at, 0, ...block);
  return normalize(rest, groups);
}

/** Take a group's tabs out of the strip (for moving them to another space). */
export function extractGroup(tabs, groups, gid) {
  return {
    moved: tabs.filter((t) => t.group === gid),
    group: groups.find((g) => g.id === gid) || null,
    ...normalize(tabs.filter((t) => t.group !== gid), groups.filter((g) => g.id !== gid)),
  };
}

/* ── saving ───────────────────────────────────────────────────────────── */

/** The extra fields a saved tab keeps (next to its location). */
export function tabExtras(t) {
  return {
    // "pinned" without "full" is a minimized tab from before the two were told apart
    ...(t.pinned && t.full ? { pinned: true, full: true } : {}),
    ...(t.mini || (t.pinned && !t.full) ? { mini: true } : {}),
    // a browser tab: which one it is, and the page's name for the strip
    ...(t.kind === "web" && t.wid ? { wid: String(t.wid), ...(t.title ? { title: String(t.title).slice(0, 200) } : {}) } : {}),
    // left on the start page (Home): the page behind it comes back with Back after a restart or a reopen
    ...(t.kind === "web" && t.behind && t.behind.path ? { behind: { path: String(t.behind.path), title: String(t.behind.title || "").slice(0, 200), trail: [], fwd: false } } : {}),
    ...(COLORS.includes(t.color) || /^#[0-9a-f]{6}$/i.test(t.color || "") ? { color: t.color } : {}),
    ...(t.look && typeof t.look === "object" && Object.keys(t.look).length ? { look: t.look } : {}),
    ...(t.group && !(t.pinned && t.full) ? { group: t.group } : {}),
  };
}

/** Groups as stored in settings; anything malformed (or from an older build) is fixed up or dropped. */
export function cleanGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const g of raw) {
    if (!g || typeof g.id !== "string" || !g.id || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({ id: g.id, name: typeof g.name === "string" ? g.name : "", color: COLORS.includes(g.color) || HEX.test(g.color || "") ? g.color : "grey", collapsed: !!g.collapsed, ...(g.look && typeof g.look === "object" && Object.keys(g.look).length ? { look: g.look } : {}) });
  }
  return out;
}

export const saveGroups = (groups) => groups.map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: !!g.collapsed, ...(g.look ? { look: g.look } : {}) }));

/**
 * Add a group and its saved tabs to another space's stored data. A tab the
 * space already has moves into the group; a clashing group id is renamed.
 */
export function mergeIntoSpace(space, savedTabs, group, same) {
  const groups = cleanGroups(space.groups);
  const g = { ...group, collapsed: !!group.collapsed };
  if (groups.some((x) => x.id === g.id)) g.id = uniqueId(groups);
  const incoming = savedTabs.map((l) => ({ ...l, group: g.id }));
  const kept = (space.tabs || []).filter((l) => l && !incoming.some((x) => same(x, l)));
  return { tabs: [...kept, ...incoming], groups: [...groups, g] };
}

/* ── popovers ─────────────────────────────────────────────────────────── */

let openPop = null;
export function closeGroupPop() { if (openPop) { const c = openPop; openPop = null; c(); } }

function place(el, rect) {
  document.getElementById("overlay-root").append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(rect.left, innerWidth - r.width - 8)) + "px";
  el.style.top = rect.bottom + 6 + "px";
  requestAnimationFrame(() => el.classList.add("is-in"));
}

export function swatchRow(current, onPick, { none = false } = {}) {
  const row = h("div", { class: "tg-swatches", role: "radiogroup" });
  const paint = (c) => { for (const b of row.children) { const on = b.dataset.c === (c || ""); b.classList.toggle("is-active", on); b.setAttribute("aria-checked", String(on)); } };
  const opts = none ? ["", ...COLORS] : COLORS;
  for (const c of opts) {
    row.append(h("button", {
      class: "tg-swatch" + (c ? "" : " is-none"), dataset: { c }, title: c ? COLOR_NAMES[c] : "No colour", role: "radio",
      style: c ? { "--c": colorVar(c) } : null,
      onclick: (e) => { e.preventDefault(); paint(c); onPick(c || null); },
    }, c ? null : icon("x")));
  }
  paint(current);
  return row;
}

/**
 * The small group editor: a name field and the colours. Changes apply as
 * you make them; Enter or a click elsewhere keeps them, Escape undoes.
 */
export function editGroup(rect, g, { onChange, title = "" }) {
  closeGroupPop();
  const before = { name: g.name, color: g.color };
  const input = h("input", { class: "tg-name", value: g.name, placeholder: "Name this group", spellcheck: false, maxlength: 60 });
  const el = h("div", { class: "tg-pop tg-editor", role: "dialog" },
    title ? h("div", { class: "tg-pop-head", text: title }) : null,
    input,
    swatchRow(g.color, (c) => { g.color = c; onChange(); }));
  input.addEventListener("input", () => { g.name = input.value; onChange(); });
  const finish = (keep) => {
    if (keep) g.name = g.name.trim();
    else Object.assign(g, before);
    onChange();
    closeGroupPop();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    e.stopPropagation(); // app shortcuts stay out of the name
  });
  const onDown = (e) => { if (!el.contains(e.target)) finish(true); };
  setTimeout(() => document.addEventListener("mousedown", onDown, true));
  openPop = () => { document.removeEventListener("mousedown", onDown, true); el.remove(); };
  place(el, rect);
  input.focus();
  input.select();
}

/** A bare colour picker (for a tab's own colour). */
export function pickColor(rect, current, onPick) {
  closeGroupPop();
  const el = h("div", { class: "tg-pop tg-colors", role: "dialog" },
    h("div", { class: "tg-pop-head", text: "Tab colour" }),
    swatchRow(current, (c) => { onPick(c); closeGroupPop(); }, { none: true }));
  const onDown = (e) => { if (!el.contains(e.target)) closeGroupPop(); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeGroupPop(); } };
  setTimeout(() => { document.addEventListener("mousedown", onDown, true); document.addEventListener("keydown", onKey, true); });
  openPop = () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); el.remove(); };
  place(el, rect);
}

/**
 * The quick look at a collapsed group: its name and its tabs. Hovering the
 * chip opens it after a short pause; leaving both chip and popup closes it.
 * `rows` is [{ title, icon, active, open() }].
 */
export function peekGroup(chip, g, rows) {
  if (openPop && openPop.chip === chip) return;
  closeGroupPop();
  const el = h("div", { class: "tg-pop tg-peek", style: { "--gc": colorVar(g.color) } },
    h("div", { class: "tg-peek-head" }, h("span", { class: "tg-dot" }),
      h("span", { class: "tg-peek-name" + (g.name ? "" : " is-empty"), text: g.name || "Unnamed group" }),
      h("span", { class: "tg-peek-count", text: `${rows.length} tab${rows.length === 1 ? "" : "s"}` })),
    h("div", { class: "tg-peek-list" }, rows.map((r) =>
      h("button", { class: "tg-peek-row" + (r.active ? " is-active" : ""), onclick: () => { closeGroupPop(); r.open(); } },
        icon(r.icon), h("span", { class: "tg-peek-title", text: r.title })))));
  let timer = 0;
  const leave = () => { clearTimeout(timer); timer = setTimeout(closeGroupPop, 160); };
  const stay = () => clearTimeout(timer);
  for (const n of [chip, el]) { n.addEventListener("mouseleave", leave); n.addEventListener("mouseenter", stay); }
  const close = () => {
    clearTimeout(timer);
    chip.removeEventListener("mouseleave", leave);
    chip.removeEventListener("mouseenter", stay);
    el.remove();
  };
  close.chip = chip;
  openPop = close;
  place(el, chip.getBoundingClientRect());
}

export const peekOpen = () => !!(openPop && openPop.chip);
