// The Zettelkasten, wired into the app: the setup action, the template
// commands, and the two right-panel helpers. Everything is optional and
// reversible - nothing here runs on its own, and no note changes without a
// click. The thinking lives in zettel.js; this file only asks and applies.

import { h, basename, dirname } from "./util.js";
import { icon } from "./icons.js";
import { menu } from "./ui.js";
import { expandTemplate, templatesIn } from "./templates.js";
import * as Z from "./zettel.js";

export function createZettel(app) {
  const { vault } = app;
  let nodes = null; // the link index, rebuilt lazily after any change

  const S = () => app.settings;
  const clean = (s) => String(s || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const folderOf = (key, fallback) => clean(S()[key] || fallback);
  const ideaDir = () => folderOf("zettelFolder", Z.FOLDERS.zettel);
  // templates and the diary are workflow, not ideas: they never count as orphans
  const ignored = () => [folderOf("templateFolder", Z.FOLDERS.templates), clean(S().dailyFolder), dirname(clean(S().yearlyPath))].filter(Boolean);
  const index = () => nodes || (nodes = Z.buildIndex(vault.notes.values(), (t, f) => vault.resolve(t, f), { ignore: ignored() }));

  let topicMemo = null; // emerging topics: a whole-vault link scan, done again only after a change
  const stale = () => { nodes = null; topicMemo = null; };
  for (const ev of ["structure", "renamed", "removed"]) vault.bus.on(ev, stale);
  // a save that changed no link or tag (most of typing): that one note's words and time are brought up to date in
  // place, instead of resolving every link in the vault again at the next look
  vault.bus.on("changed", (e) => {
    const node = e && e.linksChanged === false && !e.isNew && nodes && nodes.get(e.path);
    const note = node && vault.notes.get(e.path);
    if (!note) return stale();
    node.lower = note.lower || String(note.content || "").toLowerCase();
    node.words = note.words;
    node.mtime = note.mtime;
  });

  /* ── templates ───────────────────────────────────────────────────────── */
  const templates = () => templatesIn(vault.notes, folderOf("templateFolder", Z.FOLDERS.templates));
  const named = (re, fallback) => { const t = templates().find((n) => re.test(n.title)); return t ? t.content : fallback; };
  const ideaTemplate = () => named(/core idea|idea/i, Z.CORE_IDEA);
  const mocTemplate = () => named(/map of content|moc/i, Z.MAP_OF_CONTENT);
  const refTemplate = () => named(/reference/i, Z.REFERENCE);

  function pickTemplate(title, onPick) {
    const list = templates();
    if (!list.length) {
      return app.toast(`No templates in “${folderOf("templateFolder", Z.FOLDERS.templates)}” yet - any note in that folder is one.`, {
        ms: 6000, action: { label: "Set one up", run: () => app.openSettings("Zettelkasten") },
      });
    }
    menu(innerWidth / 2 - 140, 120, [{ header: title }, ...list.map((n) => ({ label: n.title, icon: "file", run: () => onPick(n) }))]);
  }

  function insertTemplate() {
    const path = app.currentPath();
    if (!path) return app.toast("Open a note first");
    pickTemplate("Insert template", (n) => {
      // the picker is not modal: make sure we are still in the note the
      // template was asked for, or the selection it replaces is a stranger's
      if (app.editor.path !== path) return app.toast("That template was for another note - open it and try again", { ms: 4200 });
      const ex = expandTemplate(n.content, { title: basename(path), date: new Date() });
      app.editor.insert(ex.text, ex.cursor);
      app.editor.focus();
      app.toast(`Inserted “${n.title}”`);
    });
  }

  /** Create a note from a template. With no name the caret lands in the title. */
  // `name` is a title, never a path: a slash in it is the user's own text and
  // vault.create sanitises it. Only newMoc, which starts from a link target,
  // is allowed to read a folder out of the name.
  async function fromTemplate(text, { dir, name = "", values, body, type = "note", open = true } = {}) {
    const title = name.trim();
    const ex = Z.composeNote(text, { title: title || "Untitled", date: new Date(), values, body });
    try {
      const p = await vault.create(dir, title || `Untitled ${type}`, ex.text);
      if (open) app.openNote(p, { focusTitle: !title, offset: ex.cursor == null ? undefined : ex.cursor });
      return p;
    } catch (e) {
      app.toast("Could not create the note: " + e, { kind: "error" });
    }
  }

  const newFromTemplate = () => pickTemplate("New note from template", (n) => fromTemplate(n.content, { dir: ideaDir() }));
  const newIdea = () => fromTemplate(ideaTemplate(), { dir: ideaDir(), type: "idea" });

  // `url` and `title`: a page being read (a web tab's menu); otherwise the source comes from the clipboard
  async function newReference({ url = "", title = "" } = {}) {
    let clip = url;
    if (!clip) try { clip = await navigator.clipboard.readText(); } catch {}
    const src = Z.sourceValue(clip);
    const p = await fromTemplate(refTemplate(), { dir: folderOf("referenceFolder", Z.FOLDERS.reference), name: String(title || "").slice(0, 120), values: { source: src }, type: "reference" });
    if (p && src && !url) app.toast("Source taken from the clipboard");
    return p;
  }

  /** A Map of Content, optionally starting from the notes that asked for it. */
  async function newMoc({ title = "", links = [] } = {}) {
    let text = Z.composeNote(mocTemplate(), { title: title || "Untitled", date: new Date() }).text;
    if (links.length) text = Z.fillKeyIdeas(text, links);
    const slash = title.lastIndexOf("/");
    const dir = slash >= 0 ? clean(title.slice(0, slash)) : ideaDir();
    const name = slash >= 0 ? title.slice(slash + 1) : title;
    // the caret waits under Overview, which is the only part still to write
    const head = text.indexOf("## Overview");
    const at = head < 0 ? undefined : text.indexOf("\n\n", head) + 2;
    try {
      const p = await vault.create(dir, name || "Untitled map", text);
      app.openNote(p, { focusTitle: !name, offset: at });
      return p;
    } catch (e) {
      app.toast("Could not create the map: " + e, { kind: "error" });
    }
  }

  /* ── a note out of the selection ─────────────────────────────────────── */
  function extract() {
    const path = app.currentPath();
    if (!path) return app.toast("Open a note first");
    const r = app.editor.range({ block: true });
    if (!r.text.trim()) return app.toast("Select some text, or put the caret in a paragraph");
    if (r.from === 0 && /^---\r?\n/.test(r.text)) return app.toast("That is the note's properties — select the text you mean instead");
    const { title, body } = Z.noteFromSelection(r.text);

    // the new note is not opened: you stay where you were writing, with a link
    const make = async (name) => {
      const p = await fromTemplate(ideaTemplate(), { dir: ideaDir(), name, body, type: "idea", open: false });
      if (!p) return;
      const link = vault.linkText(p);
      if (app.editor.path !== path) app.openNote(path);
      // Making the note took a round trip, and naming it took as long as the
      // user liked. Replace only the text we actually read: if the note moved
      // on underneath - an agent wrote to it, the caret went elsewhere - those
      // offsets now point at somebody else's words.
      const doc = app.editor.path === path ? app.editor.view.state.doc.toString() : "";
      if (doc.slice(r.from, r.to) !== r.text) {
        return app.toast(`“${basename(p)}” was made, but this note changed in the meantime, so nothing here was replaced`, {
          ms: 8000, action: { label: "Open it", run: () => app.openNote(p) },
        });
      }
      const rep = Z.replaceSelection(doc, r.from, r.to, link);
      app.editor.apply({ from: r.from, to: r.to, insert: `[[${link}]]`, cursor: rep.cursor });
      app.editor.focus();
      app.toast(`“${basename(p)}” made and linked here`, { action: { label: "Open it", run: () => app.openNote(p) } });
    };

    if (title) return make(title);
    app.palette("prompt", { placeholder: "Name this note…", verb: "Create it and link it here", icon: "filePlus", onPick: make });
  }

  /* ── the setup ───────────────────────────────────────────────────────── */
  function plan() {
    return Z.setupPlan(
      { folders: vault.folders, notes: vault.notes.keys(), settings: S() },
      { folders: {
        zettel: folderOf("zettelFolder", Z.FOLDERS.zettel),
        reference: folderOf("referenceFolder", Z.FOLDERS.reference),
        templates: folderOf("templateFolder", Z.FOLDERS.templates),
        files: Z.FOLDERS.files,
      } }
    );
  }

  async function setup() {
    const p = plan();
    try {
      for (const d of p.folders.create) await vault.createFolder(d);
      for (const f of p.files.create) await vault.create(dirname(f.path), f.name, f.content);
    } catch (e) {
      return app.toast("Could not finish the setup: " + e, { kind: "error" });
    }
    for (const k in p.settings) app.setSetting(k, p.settings[k]);
    stale();
    app.bus.emit("zettel", p);
    app.toast(Z.planSummary(p), { ms: 6000 });
    return p;
  }

  /* ── right panel: related notes ──────────────────────────────────────── */
  function connect(target) {
    const path = app.currentPath();
    if (!path || app.editor.path !== path) return app.toast("Open the note first");
    const link = vault.linkText(target);
    const edit = Z.connectionInsert(app.editor.view.state.doc.toString(), link);
    app.editor.apply(edit);
    app.editor.focus();
  }

  function relatedPanel(path) {
    const list = Z.relatedNotes(index(), path, { limit: 6 });
    if (!list.length) return { count: 0, body: h("div", { class: "rp-none", text: "Nothing to suggest yet. Tags, shared links and plain mentions show up here." }) };
    return {
      count: list.length,
      body: h("div", { class: "rp-links" }, list.map((r) =>
        h("div", { class: "rp-link zk-rel" },
          h("button", { class: "rp-link-title", title: r.path, onclick: (e) => app.openNote(r.path, { newTab: e.ctrlKey }) }, icon(r.mention ? "search" : "link"), r.title),
          h("div", { class: "zk-foot" },
            h("span", { class: "zk-why", text: r.why.join(" · ") }),
            h("button", { class: "chip-btn", title: "Add it under ## Connections, then say how it relates", onclick: () => connect(r.path) }, "Connect")))))
    };
  }

  /* ── right panel: emerging topics, orphans and stubs ─────────────────── */
  function emergingPanel() {
    // topics you said are not topics stay hidden
    const gone = new Set((S().zkDismissed || []).map((x) => String(x).toLowerCase()));
    const memoKey = gone.size + "|" + ignored().join("|");
    if (!topicMemo || topicMemo.key !== memoKey) topicMemo = { key: memoKey, list: Z.unresolvedLinks(vault.notes.values(), (t, f) => vault.resolve(t, f), { min: 2, limit: 5 + gone.size, ignore: ignored() }) };
    const topics = topicMemo.list
      .filter((t) => !gone.has(String(t.target).toLowerCase())).slice(0, 5);
    const { orphans, stubs, orphanCount, stubCount } = Z.orphansAndStubs(index(), { stubWords: 25, limit: 8 });
    if (!topics.length && !orphanCount && !stubCount) return { count: 0, body: null };

    const rows = topics.map((t) =>
      h("div", { class: "rp-link zk-topic" },
        h("span", { class: "zk-topic-name" }, icon("link"), h("span", { text: t.display, title: t.display }),
          h("button", { class: "icon-btn zk-dismiss", title: "Not a topic - hide it", onclick: (e) => {
            e.stopPropagation();
            const was = S().zkDismissed || [];
            app.setSetting("zkDismissed", [...was, t.target].slice(-200)); app.bus.emit("rightpanel");
            // hidden nowhere to be found again: the toast is the way back
            app.toast(`“${t.display}” hidden from Emerging topics`, { ms: 5000, action: { label: "Undo", run: () => { app.setSetting("zkDismissed", (S().zkDismissed || []).filter((x) => x !== t.target)); app.bus.emit("rightpanel"); } } });
          } }, icon("x"))),
        h("div", { class: "zk-foot" },
          h("span", { class: "zk-why", text: `${t.count} notes link to it — nothing there yet` }),
          h("button", { class: "chip-btn", title: "Create it from the Map of Content template, with these notes listed under Key ideas", onclick: () => newMoc({ title: t.target, links: t.notes.map((p) => vault.linkText(p)) }) }, "Make a map")),
        t.notes.slice(0, 3).map((p) => h("button", { class: "rp-ctx", onclick: () => app.openNote(p) }, basename(p)))));

    const hint = (label, list, words, why) => {
      if (!list.length) return null;
      const items = h("div", { class: "zk-hint-list", hidden: true }, list.map((n) =>
        h("button", { class: "rp-ctx", onclick: () => app.openNote(n.path) }, words ? `${n.title} · ${n.words} words` : n.title)));
      const b = h("button", { class: "zk-hint", title: why, onclick: () => { items.hidden = !items.hidden; b.classList.toggle("is-open", !items.hidden); } }, icon("chevronDown", "zk-hint-caret"), label);
      return h("div", { class: "zk-hints" }, b, items);
    };

    return {
      count: topics.length,
      body: h("div", { class: "rp-links" },
        rows,
        hint(orphanCount === 1 ? "1 note with no links either way" : `${orphanCount} notes with no links either way`, orphans, false, "Notes that no other note links to, and that link to none - the easiest to lose track of"),
        hint(stubCount === 1 ? "1 note is barely started" : `${stubCount} notes are barely started`, stubs, true, "Notes under 25 words - started and left")),
    };
  }

  return { setup, plan, templates, insertTemplate, newFromTemplate, newIdea, newReference, newMoc, extract, connect, relatedPanel, emergingPanel, index, folderOf };
}
