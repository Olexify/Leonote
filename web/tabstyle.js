// A tab's own look: colour (one of the eight, or any), how the colour shows,
// bold / italic, and an icon of your choosing. Kept on the tab (`color`,
// `look`) and saved with the session, like a folder's Customize in the tree.

import { h } from "./util.js";
import { icon } from "./icons.js";
import { COLORS, colorVar, closeGroupPop, swatchRow } from "./tabgroups.js";
import { colorBlock } from "./treestyle.js";

// how a tab's colour shows: any of these together
export const TAB_FX = [["glow", "Icon glow"], ["text", "Text"], ["tint", "Tint"], ["fill", "Fill"], ["border", "Border"], ["dash", "Dashed line"], ["dot", "Dot"]];
// what a colour looks like before anything is chosen, by the setting
const FX_DEFAULT = { glow: ["glow", "text"], tint: ["tint", "glow"], fill: ["fill"], line: ["dash"] };
const FX_OLD = { line: ["dash"], tint: ["tint", "glow"], fill: ["fill"], text: ["text"], dot: ["glow"] }; // `style`, one of, from before
export const TAB_ICONS = ["star", "heart", "flag", "bolt", "flame", "bookmark", "target", "rocket", "brain", "lightbulb", "book", "briefcase", "code", "palette", "music", "film", "camera", "globe",
  "calendar", "clock", "inbox", "archive", "chart", "wallet", "cart", "users", "chat", "mail", "key", "lock", "shield", "wrench", "flask", "leaf", "paw", "coffee"];

const HEX = /^#[0-9a-f]{6}$/i;

/** What a tab looks like, resolved: { color (css), style, bold, italic, icon }. */
export function tabLookOf(t, globalStyle) {
  const l = t.look && typeof t.look === "object" ? t.look : {};
  const known = (list) => list.filter((k) => TAB_FX.some(([v]) => v === k));
  const fx = Array.isArray(l.fx) ? known(l.fx) : FX_OLD[l.style] || FX_DEFAULT[globalStyle] || FX_DEFAULT.glow;
  return {
    fx,
    color: !t.color ? "" : HEX.test(t.color) ? t.color : COLORS.includes(t.color) ? colorVar(t.color) : "",
    bold: !!l.bold,
    italic: !!l.italic,
    dim: !!l.dim,
    caps: !!l.caps,
    noIcon: !!l.noIcon,
    size: l.size === "s" || l.size === "l" ? l.size : "",
    icon: TAB_ICONS.includes(l.icon) ? l.icon : "",
  };
}

let shut = null;

export function customizeTab(rect, info, t, globalStyle, changed) {
  closeGroupPop();
  if (shut) shut();
  const look = () => (t.look && typeof t.look === "object" ? t.look : {});
  const setLook = (k, v) => {
    const l = { ...look() };
    if (v) l[k] = v; else delete l[k];
    if (Object.keys(l).length) t.look = l; else delete t.look;
    changed();
    paint();
  };
  const setColor = (c) => { if (c) t.color = c; else delete t.color; changed(); paint(); };

  // the same colour picker as a folder's Customize; one of the old eight named
  // colours shows as nothing chosen here and is replaced by what is picked
  const cb = colorBlock({ get: () => (HEX.test(t.color || "") ? t.color : null), set: (c) => setColor(c), fit: () => fit() });

  const fxNow = () => tabLookOf(t, globalStyle).fx;
  const styles = h("div", { class: "tab-cust-fx" }, TAB_FX.map(([v, label]) =>
    h("button", { class: "tab-cust-toggle", dataset: { v }, onclick: () => {
      const cur = fxNow();
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      const l = { ...look(), fx: next };
      delete l.style;
      t.look = l;
      changed();
      paint();
    } }, label)));
  const bold = h("button", { class: "tab-cust-toggle", title: "Bold name", onclick: () => setLook("bold", !look().bold) }, icon("bold"));
  const ital = h("button", { class: "tab-cust-toggle", title: "Italic name", onclick: () => setLook("italic", !look().italic) }, icon("italic"));
  const dim = h("button", { class: "tab-cust-toggle", title: "Dimmed - steps back until it is the tab in front", onclick: () => setLook("dim", !look().dim) }, "Dim");
  const caps = h("button", { class: "tab-cust-toggle", title: "Small capitals", onclick: () => setLook("caps", !look().caps) }, "AA");
  const noIcon = h("button", { class: "tab-cust-toggle", title: "Name only, no icon", onclick: () => setLook("noIcon", !look().noIcon) }, "No icon");
  const sizes = h("div", { class: "segmented is-small" }, [["s", "Small"], ["", "Normal"], ["l", "Large"]].map(([v, label]) =>
    h("button", { class: "seg", dataset: { v }, onclick: () => setLook("size", v) }, label)));
  const icons = h("div", { class: "tab-cust-icons" },
    h("button", { title: "The file's own icon", dataset: { v: "" }, onclick: () => setLook("icon", "") }, icon(info.icon)),
    ...TAB_ICONS.map((n) => h("button", { title: n, dataset: { v: n }, onclick: () => setLook("icon", n) }, icon(n))));
  const reset = h("button", { class: "btn btn-sm", onclick: () => { delete t.color; delete t.look; changed(); paint(); } }, "Reset");

  function paint() {
    cb.paint();
    for (const b of styles.children) { b.classList.toggle("is-active", fxNow().includes(b.dataset.v)); b.disabled = !t.color; }
    bold.classList.toggle("is-active", !!look().bold);
    ital.classList.toggle("is-active", !!look().italic);
    dim.classList.toggle("is-active", !!look().dim);
    caps.classList.toggle("is-active", !!look().caps);
    noIcon.classList.toggle("is-active", !!look().noIcon);
    for (const b of sizes.children) b.classList.toggle("is-active", b.dataset.v === (look().size || ""));
    for (const b of icons.children) b.classList.toggle("is-active", b.dataset.v === (look().icon || ""));
    reset.disabled = !t.color && !t.look;
  }

  const el = h("div", { class: "tg-pop tab-cust", role: "dialog" },
    h("div", { class: "tab-cust-head" }, icon("palette"), h("span", { text: info.title }), reset),
    h("div", { class: "tab-cust-label", text: "Colour" }), cb.row, cb.picker,
    h("div", { class: "tab-cust-label", text: "The colour shows as - any together" }), styles,
    h("div", { class: "tab-cust-label", text: "Name" }), h("div", { class: "tab-cust-row" }, bold, ital, caps, dim, noIcon),
    h("div", { class: "tab-cust-label", text: "Name size" }), sizes,
    h("div", { class: "tab-cust-label", text: "Icon" }), icons);
  function fit() { el.style.top = Math.max(6, Math.min(rect.bottom + 6, innerHeight - el.offsetHeight - 8)) + "px"; }
  const onDown = (e) => { if (!el.contains(e.target)) shut(); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shut(); } };
  shut = () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); el.remove(); shut = null; };
  setTimeout(() => { document.addEventListener("mousedown", onDown, true); document.addEventListener("keydown", onKey, true); });
  paint();
  document.getElementById("overlay-root").append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(rect.left, innerWidth - r.width - 8)) + "px";
  fit();
  requestAnimationFrame(() => el.classList.add("is-in"));
}

export const GROUP_CHIPS = [["", "Soft"], ["solid", "Solid"], ["outline", "Outline"], ["plain", "Plain"]];

/** A group's look, resolved. */
export function groupLookOf(g) {
  const l = g.look && typeof g.look === "object" ? g.look : {};
  return {
    chip: GROUP_CHIPS.some(([v]) => v && v === l.chip) ? l.chip : "",
    bold: !!l.bold, italic: !!l.italic, caps: !!l.caps, keepName: !!l.keepName, wash: !!l.wash, noLine: !!l.noLine,
    size: l.size === "s" || l.size === "l" ? l.size : "",
    icon: TAB_ICONS.includes(l.icon) ? l.icon : "",
  };
}

/** Name, any colour, how the chip looks, its icon, and what the group does to its tabs. */
export function customizeGroup(rect, g, { onChange, title = "" }) {
  closeGroupPop();
  if (shut) shut();
  const look = () => (g.look && typeof g.look === "object" ? g.look : {});
  const setLook = (k, v) => {
    const l = { ...look() };
    if (v) l[k] = v; else delete l[k];
    if (Object.keys(l).length) g.look = l; else delete g.look;
    onChange();
    paint();
  };
  const input = h("input", { class: "tg-name", value: g.name, placeholder: "Name this group", spellcheck: false, maxlength: 60 });
  input.addEventListener("input", () => { g.name = input.value; onChange(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); shut(); } e.stopPropagation(); });
  // the eight named colours follow the theme; any other is taken as it is
  const named = h("div");
  const cb = colorBlock({ get: () => (HEX.test(g.color || "") ? g.color : null), set: (c) => { g.color = c || "grey"; onChange(); paint(); }, fit: () => fit() });
  const seg = (key, opts) => h("div", { class: "segmented is-small", dataset: { key } }, opts.map(([v, label]) =>
    h("button", { class: "seg", dataset: { v }, onclick: () => setLook(key, v) }, label)));
  const chips = seg("chip", GROUP_CHIPS);
  const sizes = seg("size", [["s", "Small"], ["", "Normal"], ["l", "Large"]]);
  const tog = (key, label, tip) => h("button", { class: "tab-cust-toggle", title: tip, dataset: { key }, onclick: () => setLook(key, !look()[key]) }, label);
  const toggles = [tog("bold", icon("bold"), "Bold name"), tog("italic", icon("italic"), "Italic name"), tog("caps", "AA", "Small capitals"),
    tog("keepName", "Keep name", "Show the name when the group is folded too"), tog("wash", "Tint tabs", "Wash the group's tabs in its colour"), tog("noLine", "No line", "No line under the group's tabs")];
  const icons = h("div", { class: "tab-cust-icons" },
    h("button", { title: "A dot", dataset: { v: "" }, onclick: () => setLook("icon", "") }, h("span", { class: "tg-dot", style: { "--gc": "currentColor" } })),
    ...TAB_ICONS.map((n) => h("button", { title: n, dataset: { v: n }, onclick: () => setLook("icon", n) }, icon(n))));
  const reset = h("button", { class: "btn btn-sm", onclick: () => { delete g.look; onChange(); paint(); } }, "Reset look");

  function paint() {
    named.replaceChildren(swatchRow(COLORS.includes(g.color) ? g.color : null, (c) => { g.color = c || "grey"; onChange(); paint(); }));
    cb.paint();
    for (const box of [chips, sizes]) for (const b of box.children) b.classList.toggle("is-active", b.dataset.v === (look()[box.dataset.key] || ""));
    for (const b of toggles) b.classList.toggle("is-active", !!look()[b.dataset.key]);
    for (const b of icons.children) b.classList.toggle("is-active", b.dataset.v === (look().icon || ""));
    reset.disabled = !g.look;
  }
  const el = h("div", { class: "tg-pop tab-cust", role: "dialog" },
    h("div", { class: "tab-cust-head" }, icon("palette"), h("span", { text: title || "Tab group" }), reset),
    input,
    h("div", { class: "tab-cust-label", text: "Colour" }), named, cb.row, cb.picker,
    h("div", { class: "tab-cust-label", text: "Chip" }), chips,
    h("div", { class: "tab-cust-label", text: "Name" }), h("div", { class: "tab-cust-row" }, toggles.slice(0, 3)), sizes,
    h("div", { class: "tab-cust-label", text: "Group" }), h("div", { class: "tab-cust-row" }, toggles.slice(3)),
    h("div", { class: "tab-cust-label", text: "Icon" }), icons);
  function fit() { el.style.top = Math.max(6, Math.min(rect.bottom + 6, innerHeight - el.offsetHeight - 8)) + "px"; }
  const onDown = (e) => { if (!el.contains(e.target)) shut(); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shut(); } };
  shut = () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); g.name = (g.name || "").trim(); el.remove(); shut = null; onChange(); };
  setTimeout(() => { document.addEventListener("mousedown", onDown, true); document.addEventListener("keydown", onKey, true); });
  paint();
  document.getElementById("overlay-root").append(el);
  el.style.left = Math.max(8, Math.min(rect.left, innerWidth - el.offsetWidth - 8)) + "px";
  fit();
  requestAnimationFrame(() => el.classList.add("is-in"));
  input.focus();
  input.select();
}
