// Docs: your ready texts - letters, replies, applications, prompts - one
// click from the clipboard. They are ordinary notes in one folder of the
// vault (Docs by default), so they sync, back up and search like any note;
// each folder inside it is a category. Show one category or several at once.
// A {{name}} in a doc is a blank: copying asks for it first and remembers
// what you gave last time. A copy carries the formatting too, for mail.
import { h, debounce, basename, safeName, relTime } from "./util.js";
import { icon } from "./icons.js";
import { askDialog, confirmDialog } from "./ui.js";
import { mdToHtml } from "./boardmodel.js";

const BLANK = /\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g;
/** The blanks a doc has, each once, in order. */
export const blanksIn = (text) => [...new Set([...String(text).matchAll(BLANK)].map((m) => m[1]))];
/** The doc with its blanks filled (a blank left empty stays as it is). */
export const fillBlanks = (text, values) => String(text).replace(BLANK, (w, k) => (values[k] != null && values[k] !== "" ? values[k] : w));
/** What is copied: the text without its front matter. */
export const bodyOf = (text) => String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^\s+/, "").replace(/\s+$/, "");

const LAST = "leonote.docBlanks";
const lastValues = () => { try { return JSON.parse(localStorage.getItem(LAST) || "{}") || {}; } catch { return {}; } };

export function mountDocs(app, el) {
  const S = app.settings;
  const vault = app.vault;
  const root = () => String(S.docsFolder || "Docs").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "Docs";
  let shown = new Set(Array.isArray(S.docsShown) ? S.docsShown : []); // categories shown; none = all ("" is the unsorted ones)
  let q = "";
  let adding = null; // the new doc's card while its name is typed

  const inRoot = (p) => p.startsWith(root() + "/");
  const catOf = (path) => { const rest = path.slice(root().length + 1); return rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : ""; };
  const docs = () => [...vault.notes.values()].filter((n) => inRoot(n.path));
  const categories = () => [...vault.folders].filter((f) => inRoot(f) && !f.slice(root().length + 1).includes("/")).map((f) => f.slice(root().length + 1)).sort((a, b) => a.localeCompare(b));
  const setShown = (s) => { shown = s; app.setSetting("docsShown", [...s]); render(); };

  const search = h("input", { class: "qa-input", spellcheck: false, placeholder: "Search your docs - Enter copies the first" });
  let firstShown = null;
  search.addEventListener("input", debounce(() => { q = search.value.trim().toLowerCase(); render(); }, 120));
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { search.value = ""; q = ""; render(); }
    // drawn now (not after the pause), so the first is the one for what was just typed
    else if (e.key === "Enter") { e.preventDefault(); q = search.value.trim().toLowerCase(); render(); if (firstShown) copyDoc(firstShown); }
  });
  const newBtn = h("button", { class: "btn btn-primary", onclick: () => startNew() }, icon("plus"), "New doc");
  const cats = h("div", { class: "dx-cats" });
  const grid = h("div", { class: "dx-grid" });
  const empty = h("div", { class: "dx-empty", hidden: true });
  el.replaceChildren(h("div", { class: "view-inner docs-view" },
    h("header", { class: "vh" },
      h("div", {}, h("h1", { class: "vh-title", text: "Docs" }), h("div", { class: "vh-sub", text: "Your ready texts - letters, replies, prompts. Click one to copy it; {{blanks}} in it are asked for first." })),
      newBtn),
    h("div", { class: "qa dx-search" }, icon("search"), search),
    cats, grid, empty));

  /* ── copying ─────────────────────────────────────────────────────────── */
  async function copyText(text, title) {
    try {
      // plain text and formatted: a mail editor takes the bold and the lists, a plain box the text
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([mdToHtml(text, { maxChars: Infinity })], { type: "text/html" }) })]);
    } catch {
      try { await navigator.clipboard.writeText(text); } catch { return app.toast("Could not copy", { kind: "error" }); }
    }
    app.toast(`Copied “${title}”`, { ms: 1600 });
  }
  async function copyDoc(n) {
    const body = bodyOf(n.content || "");
    const blanks = blanksIn(body);
    if (!blanks.length) return copyText(body, n.title);
    const last = lastValues();
    const r = await askDialog(`Fill in “${n.title}”`, blanks.map((k) => ({ key: k, label: k, value: last[k] || "" })), { ok: "Copy" });
    if (!r) return;
    try { localStorage.setItem(LAST, JSON.stringify({ ...last, ...r })); } catch {}
    copyText(fillBlanks(body, r), n.title);
  }

  /* ── making and changing ─────────────────────────────────────────────── */
  function startNew() {
    adding = { cat: shown.size === 1 ? [...shown][0] : "" };
    render();
  }
  async function createDoc(name, cat) {
    const title = safeName(name.trim());
    if (!title) return;
    const dir = cat ? `${root()}/${cat}` : root();
    if (!vault.folders.has(dir)) await vault.createFolder(dir);
    const path = await vault.create(dir, title, "");
    adding = null;
    app.openNote(path, { newTab: true });
  }
  async function newCategory() {
    const r = await askDialog("New category", [{ key: "name", label: "Name", value: "", placeholder: "Mail, Applications, Prompts…" }], { ok: "Create" });
    const name = r && safeName(String(r.name || "").trim());
    if (!name) return;
    await vault.createFolder(`${root()}/${name}`);
    setShown(new Set([name]));
  }
  function catMenu(cat, e) {
    e.preventDefault();
    const dir = `${root()}/${cat}`;
    const n = docs().filter((d) => catOf(d.path) === cat).length;
    app.menu(e.clientX, e.clientY, [
      { header: cat },
      { label: "Show only this one", icon: "eye", run: () => setShown(new Set([cat])) },
      { label: "Rename…", icon: "edit", run: async () => { const r = await askDialog("Rename the category", [{ key: "name", label: "Name", value: cat }], { ok: "Rename" }); if (r && r.name && r.name.trim() !== cat) { await app.renameFolder(dir, r.name.trim()); if (shown.delete(cat)) shown.add(safeName(r.name.trim())); setShown(new Set(shown)); } } },
      { label: "Show in the file tree", icon: "folder", run: () => app.revealInTree(dir) },
      "sep",
      { label: n ? `Delete it and its ${n} doc${n === 1 ? "" : "s"}…` : "Delete it", icon: "trash", danger: true, run: async () => {
        if (n && !(await confirmDialog(`Delete “${cat}”?`, `Its ${n} doc${n === 1 ? "" : "s"} go to the vault's trash with it - Ctrl+Z in the file list brings them back.`, { ok: "Delete" }))) return;
        await app.trashFolder(dir);
        shown.delete(cat);
        setShown(new Set(shown));
      } },
    ]);
  }
  function docMenu(n, e) {
    e.preventDefault();
    const cs = categories();
    app.menu(e.clientX, e.clientY, [
      { label: "Copy", icon: "clipboard", run: () => copyDoc(n) },
      { label: "Open to edit", icon: "edit", run: () => app.openNote(n.path, { newTab: true }) },
      { label: "Rename…", icon: "edit", run: async () => { const r = await askDialog("Rename", [{ key: "name", label: "Name", value: n.title }], { ok: "Rename" }); if (r && r.name && r.name.trim()) app.renameNote(n.path, r.name.trim()); } },
      { label: "Duplicate", icon: "plus", run: async () => { const dir = n.path.slice(0, n.path.lastIndexOf("/")); await vault.create(dir, n.title + " copy", n.content || ""); } },
      cs.length ? "sep" : null,
      ...cs.filter((c) => c !== catOf(n.path)).map((c) => ({ label: `Move to ${c}`, icon: "folder", run: () => app.moveNote(n.path, `${root()}/${c}`) })),
      catOf(n.path) ? { label: "Move out of its category", icon: "folder", run: () => app.moveNote(n.path, root()) } : null,
      "sep",
      { label: "Delete", icon: "trash", danger: true, run: () => app.trashItems([[n.path, "note"]]) },
    ].filter(Boolean));
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */
  function render() {
    if (el.hidden) { stale = true; return; }
    stale = false;
    const cs = categories();
    const all = docs();
    const hasLoose = all.some((n) => !catOf(n.path));
    const before = shown.size;
    for (const c of [...shown]) if (c && !cs.includes(c)) shown.delete(c);
    // "Unsorted" with nothing unsorted left: its chip is gone, so it must not go on hiding every doc
    if (!hasLoose) shown.delete("");
    if (shown.size !== before) app.setSetting("docsShown", [...shown]);
    const chip = (id, label, count) => h("button", {
      class: "dx-cat" + (shown.has(id) ? " is-on" : ""), "aria-pressed": String(shown.has(id)), dataset: { cat: id },
      title: "Click to show it · Ctrl+click to show it beside the ones shown · right-click for more",
      onclick: (e) => { const s = new Set(e.ctrlKey || e.metaKey ? shown : []); if (shown.has(id) && (e.ctrlKey || e.metaKey || shown.size === 1)) s.delete(id); else s.add(id); setShown(s); },
      oncontextmenu: (e) => (id ? catMenu(id, e) : e.preventDefault()),
    }, label, h("span", { class: "dx-n", text: String(count) }));
    // a chip pressed from the keyboard keeps the focus through the redraw
    const focusCat = cats.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.cat : null;
    cats.replaceChildren(
      h("button", { class: "dx-cat" + (!shown.size ? " is-on" : ""), "aria-pressed": String(!shown.size), dataset: { cat: "*" }, onclick: () => setShown(new Set()) }, "All", h("span", { class: "dx-n", text: String(all.length) })),
      ...cs.map((c) => chip(c, c, all.filter((n) => catOf(n.path) === c).length)),
      ...(hasLoose ? [chip("", "Unsorted", all.filter((n) => !catOf(n.path)).length)] : []), // a bare null would show as the word "null"
      h("button", { class: "dx-cat is-add", title: "A new category - a folder in " + root(), onclick: newCategory }, icon("plus"), "Category"));
    if (focusCat != null) { const b = [...cats.children].find((x) => x.dataset && x.dataset.cat === focusCat); if (b) b.focus(); }

    let list = all.filter((n) => !shown.size || shown.has(catOf(n.path)));
    if (q) list = list.filter((n) => (n.title + "\n" + (n.content || "")).toLowerCase().includes(q));
    list.sort((a, b) => b.mtime - a.mtime);
    firstShown = list[0] || null;
    const cards = list.map((n) => {
      const body = bodyOf(n.content || "");
      const blanks = blanksIn(body);
      const cat = catOf(n.path);
      return h("div", { class: "dx-card", title: blanks.length ? "Click to fill the blanks and copy" : "Click to copy", onclick: (e) => { if (!e.target.closest("button")) copyDoc(n); }, oncontextmenu: (e) => docMenu(n, e) },
        h("div", { class: "dx-card-head" },
          h("span", { class: "dx-title", text: n.title }),
          h("button", { class: "icon-btn", title: "Open to edit", onclick: () => app.openNote(n.path, { newTab: true }) }, icon("edit")),
          h("button", { class: "icon-btn", title: "More", onclick: (e) => docMenu(n, e) }, icon("more"))),
        h("div", { class: "dx-ex", text: body.slice(0, 260) || "Empty - open it to write" }),
        h("div", { class: "dx-foot" },
          (shown.size !== 1 && cat) ? h("span", { class: "chip is-quiet", text: cat }) : null,
          blanks.length ? h("span", { class: "chip is-quiet dx-blanks", title: blanks.join(", "), text: `${blanks.length} blank${blanks.length === 1 ? "" : "s"}` }) : null,
          h("span", { class: "dx-when", text: relTime(n.mtime) }),
          h("button", { class: "btn btn-sm dx-copy", onclick: () => copyDoc(n) }, icon("clipboard"), blanks.length ? "Fill & copy" : "Copy")));
    });
    if (adding) {
      const name = h("input", { class: "text-input dx-new-name", placeholder: "Name - then Enter", spellcheck: false });
      const catSel = h("select", { class: "dx-new-cat" }, h("option", { value: "", text: "No category" }), ...cs.map((c) => h("option", { value: c, text: c, selected: c === adding.cat })));
      name.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && name.value.trim()) createDoc(name.value, catSel.value); if (e.key === "Escape") { adding = null; render(); } });
      cards.unshift(h("div", { class: "dx-card is-new" }, name, h("div", { class: "dx-foot" }, catSel, h("button", { class: "btn btn-sm", onclick: () => { adding = null; render(); } }, "Cancel"), h("button", { class: "btn btn-sm btn-primary", onclick: () => name.value.trim() && createDoc(name.value, catSel.value) }, "Create"))));
      requestAnimationFrame(() => name.focus());
    }
    grid.replaceChildren(...cards);
    empty.hidden = cards.length > 0;
    if (!cards.length) empty.replaceChildren(icon("clipboard", "dx-empty-ico"),
      h("h3", { text: q ? `Nothing matches “${q}”` : all.length ? "Nothing in this category yet" : "No docs yet" }),
      h("p", { text: `A doc is a note you reach for again and again: a cover letter, a visa reply, a prompt. They live in the ${root()} folder of your vault; {{company}} and {{date}} in one become blanks you fill when you copy it.` }));
  }
  let stale = true;
  const soon = debounce(() => render(), 150);
  vault.bus.on("structure", soon);
  vault.bus.on("changed", (e) => { if (e && e.path && inRoot(e.path)) soon(); });
  app.bus.on("settings", (k) => { if (k === "docsFolder") soon(); });
  return { show() { if (stale || !grid.childElementCount) render(); } };
}
