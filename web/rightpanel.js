// Details panel for the open note: outline, backlinks, related notes, unlinked
// mentions, emerging topics, info. In a workspace's space it also carries the
// workspace: its files, what links to what is open, its research. Sections fold,
// and move - drag one by its title to another place (remembered). Skips all work
// while hidden.

import { h, relTime, debounce, basename } from "./util.js";
import { icon } from "./icons.js";
import { WIKI_RE } from "./mdparse.js";
import { confirmDialog } from "./ui.js";

export function mountRightPanel(app, el) {
  const { vault } = app;
  let curLine = -1;
  let outlineEls = [];
  let headings = [];

  function section(title, count, body, id, help) {
    const collapsed = (app.settings.rpCollapsed || []).includes(id);
    const sec = h("section", { class: "rp-sec" + (collapsed ? " is-collapsed" : ""), dataset: { id } },
      h("button", { class: "rp-head", title: help || "Click to fold · drag to move it", draggable: true, "aria-expanded": String(!collapsed),
        ondragstart: (e) => { e.dataTransfer.setData("text/x-rp", id); e.dataTransfer.effectAllowed = "move"; sec.classList.add("is-dragging"); },
        ondragend: () => { sec.classList.remove("is-dragging"); for (const x of el.querySelectorAll(".is-drop-before")) x.classList.remove("is-drop-before"); },
        onclick: () => {
        sec.classList.toggle("is-collapsed");
        sec.querySelector(".rp-head").setAttribute("aria-expanded", String(!sec.classList.contains("is-collapsed")));
        const s = new Set(app.settings.rpCollapsed || []);
        sec.classList.contains("is-collapsed") ? s.add(id) : s.delete(id);
        app.setSetting("rpCollapsed", [...s]);
      } }, icon("chevronDown", "rp-caret"), h("span", { text: title }), count != null ? h("span", { class: "rp-count", text: String(count) }) : null,
        help ? h("span", { class: "rp-help", "aria-label": help }, "?") : null),
      h("div", { class: "rp-body" }, body));
    return sec;
  }

  // the order the sections were dragged into
  const ordered = (list) => {
    const want = app.settings.rpOrder || [];
    const rank = (sec) => { const i = want.indexOf(sec.dataset.id); return i < 0 ? 1000 + list.indexOf(sec) : i; };
    return list.slice().sort((a, b) => rank(a) - rank(b));
  };
  el.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("text/x-rp")) return;
    e.preventDefault();
    const over = e.target.closest && e.target.closest(".rp-sec");
    for (const x of el.querySelectorAll(".is-drop-before")) if (x !== over) x.classList.remove("is-drop-before");
    if (over) over.classList.add("is-drop-before");
  });
  el.addEventListener("drop", (e) => {
    const id = e.dataTransfer.getData("text/x-rp");
    if (!id) return;
    e.preventDefault();
    const over = e.target.closest && e.target.closest(".rp-sec");
    const now = [...el.querySelectorAll(".rp-sec")].map((x) => x.dataset.id).filter((x) => x !== id);
    const at = over && over.dataset.id !== id ? now.indexOf(over.dataset.id) : now.length;
    now.splice(at < 0 ? now.length : at, 0, id);
    // ids not on screen now keep their place after these
    const rest = (app.settings.rpOrder || []).filter((x) => !now.includes(x));
    app.setSetting("rpOrder", [...now, ...rest]);
    render();
  });

  /* the workspace this space belongs to, and its sections */
  let roomMod = null;
  function workspaceNow() {
    const id = app.currentSpaceId ? app.currentSpaceId() : "";
    const map = app.settings.roomSpaces || {};
    const folder = Object.keys(map).find((f) => map[f] === id);
    return folder && app.projectAt ? app.projectAt(folder) : null;
  }
  function workspaceSections(p, path) {
    if (!roomMod) { import("./projectroom.js").then((m) => { roomMod = m; render(); }); return []; }
    const out = [];
    const files = h("div", { class: "rp-ws" }, ...roomMod.workspacePanel(app, p, soon));
    out.push(section(`Workspace · ${p.name}`, null, files, "ws-files"));
    // its research: boards and sources, newest first
    const mem = roomMod.membersOf(p, vault.notes.values(), vault.files.values());
    const boards = mem.files.filter((f) => roomMod.kindOf(f.path) === "boards");
    const sources = [...mem.files.filter((f) => roomMod.kindOf(f.path) === "sources"), ...mem.own.filter((n) => /^---[\s\S]*?\ntype: source\b/.test(n.content.slice(0, 400)))].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    const item = (f, ic) => h("button", { class: "rp-link-title", title: f.path, onclick: (e) => (/\.md$/i.test(f.path) ? app.openNote(f.path, { newTab: e.ctrlKey }) : app.openFile(f.path, { newTab: e.ctrlKey })) }, icon(ic), basename(f.path).replace(/\.md$/i, ""));
    const research = h("div", { class: "rp-links" },
      boards.length ? h("div", { class: "rp-sub", text: "Boards" }) : null, ...boards.slice(0, 12).map((f) => item(f, "grid")),
      sources.length ? h("div", { class: "rp-sub", text: "Sources" }) : null, ...sources.slice(0, 20).map((f) => item(f, "book")),
      h("div", { class: "rp-ws-acts" },
        h("button", { class: "chip-btn", onclick: () => app.openRoom(p.folder, "board") }, icon("grid"), " Board"),
        h("button", { class: "chip-btn", onclick: () => app.openRoom(p.folder, "home") }, icon("plus"), " Add a source")));
    out.push(section("Research", boards.length + sources.length || null, research, "ws-research"));
    // what is open, a file rather than a note: the notes that show or link it
    if (path && !vault.get(path)) {
      const used = vault.usedIn ? vault.usedIn(path) : [];
      out.push(section("Links", used.length, used.length
        ? h("div", { class: "rp-links" }, used.slice(0, 40).map((u) => h("button", { class: "rp-link-title", title: u.path + " · Ctrl+click: in a new tab", onclick: (e) => app.openNote(u.path, { line: u.line, newTab: e.ctrlKey }) }, icon("fileText"), basename(u.path))))
        : h("div", { class: "rp-none", text: "No note links it yet" }), "ws-links"));
    }
    return out;
  }

  function outlineOf(n) {
    headings = n.headings;
    outlineEls = headings.map((hd) =>
      h("button", { class: "rp-outline-item l" + hd.level, onclick: () => { app.editor.selectLine(hd.line); app.editor.focus(); },
        // right-click: a link to this very heading, for linking to a section rather than the whole note
        oncontextmenu: (e) => { e.preventDefault(); app.menu(e.clientX, e.clientY, [{ label: "Copy a link to this heading", icon: "link", run: () => navigator.clipboard.writeText(`[[${vault.linkText(n.path)}#${hd.text.replace(/[#|^:[\]]/g, " ").replace(/\s+/g, " ").trim()}]]`).then(() => app.toast("Link copied", { ms: 1400 })) }]); } },
        hd.text.replace(/[*_`~]/g, "").replace(WIKI_RE, (_, t, _h, a) => a || t)));
    // the headings as an indented list: a script's outline, a video's chapters
    const copy = () => {
      const top = Math.min(...headings.map((hd) => hd.level));
      navigator.clipboard.writeText(headings.map((hd, i) => "  ".repeat(hd.level - top) + "- " + outlineEls[i].textContent).join("\n")).then(() => app.toast("Outline copied", { ms: 1400 }));
    };
    return headings.length ? h("div", { class: "rp-outline" }, outlineEls, h("button", { class: "chip-btn", title: "The headings as an indented list", onclick: copy }, "Copy outline")) : h("div", { class: "rp-none", text: "No headings - a line starting with # becomes one" });
  }

  // backlinks and unlinked mentions come from the other notes: typing in this one does not change them,
  // so the pause after a save reuses them (each is a walk over every note)
  let fromOthers = null;
  const othersOf = (p) => (fromOthers && fromOthers.path === p ? fromOthers : (fromOthers = { path: p, bl: vault.backlinks(p), um: vault.unlinked(p) }));
  const forget = () => { fromOthers = null; };
  for (const ev of ["structure", "renamed", "removed", "relinked"]) vault.bus.on(ev, forget);

  // the panel is drawn anew after each save, a tag removed, a mention linked: whoever was on a button in it from
  // the keyboard stays on the same button (or the panel's first), not thrown out to the page
  function keepFocus(draw) {
    const f = el.contains(document.activeElement) ? document.activeElement : null;
    // by kind and text (not the classes a redraw changes, like the current heading's), and which one of several alike
    const keyOf = (x) => x.tagName + "|" + [...x.classList].filter((c) => !c.startsWith("is-")).join(".") + "|" + x.textContent;
    const key = f && keyOf(f);
    const nth = f ? [...el.querySelectorAll(f.tagName)].filter((x) => keyOf(x) === key).indexOf(f) : -1;
    draw();
    if (!key) return;
    const alike = [...el.querySelectorAll(f.tagName)].filter((x) => keyOf(x) === key);
    const to = alike[Math.min(nth, alike.length - 1)] || el.querySelector("button");
    if (to) to.focus({ preventScroll: true });
  }

  function render() {
    if (el.hidden) return;
    const path = app.currentPath();
    const n = path && vault.get(path);
    const ws = workspaceNow();
    const wsSecs = ws ? workspaceSections(ws, app.currentTabPath ? app.currentTabPath() : path) : [];
    const emerging = app.zettel ? app.zettel.emergingPanel() : { count: 0, body: null };
    const emergingSec = emerging.body ? section("Emerging topics", emerging.count || null, emerging.body, "emerging",
      "Links that several of your notes point to, with no note behind them yet - topics your writing keeps coming back to. “Make a map” starts that note with the notes that mention it listed. Below: notes nothing links to, and notes barely started. × hides a topic.") : null;
    if (!n) {
      keepFocus(() => el.replaceChildren(...(wsSecs.length ? ordered([...wsSecs, emergingSec].filter(Boolean))
        : [h("div", { class: "rp-empty" }, icon("list"), h("p", { text: "Open a note to see its outline, links and details." })), emergingSec].filter(Boolean))));
      return;
    }

    const outline = outlineOf(n);

    const { bl, um } = othersOf(path);
    // the notes that link here as a list of links: a map of content, a script's references
    const copyBacklinks = () => navigator.clipboard.writeText(bl.map(({ note }) => `- [[${vault.linkText(note.path)}]]`).join("\n")).then(() => app.toast("Backlinks copied", { ms: 1400 }));
    const backlinks = bl.length
      ? h("div", { class: "rp-links" }, h("button", { class: "chip-btn", title: "The notes that link here, as a list of links", onclick: copyBacklinks }, "Copy as a list"), bl.map(({ note, lines }) =>
          h("div", { class: "rp-link" },
            h("button", { class: "rp-link-title", title: "Click: open · Ctrl+click: in a new tab", onclick: (e) => app.openNote(note.path, { newTab: e.ctrlKey }) }, icon("fileText"), note.title),
            lines.slice(0, 3).map((l) => h("button", { class: "rp-ctx", onclick: () => app.openNote(note.path, { line: l.line }) }, contextText(l.text))))))
      : h("div", { class: "rp-none", text: `No backlinks yet - writing [[${n.title}]] in another note makes one` });

    const unlinked = um.length
      ? h("div", { class: "rp-links" }, um.slice(0, 20).map((note) =>
          h("div", { class: "rp-link rp-unlinked" },
            h("button", { class: "rp-link-title", onclick: () => app.openNote(note.path) }, icon("fileText"), note.title),
            h("button", { class: "chip-btn", title: "Turn the first mention into a link", onclick: () => linkMention(note, n) }, "Link"))))
      : null;

    const readMin = Math.max(1, Math.round(n.words / 230));
    const info = h("div", { class: "rp-info" },
      row("Words", n.words.toLocaleString()),
      row("Characters", n.content.length.toLocaleString()),
      row("Reading", `${readMin} min`),
      // said out loud at the teleprompter's own pace (Script window, 150 words a minute unless set there)
      row("Speaking", `~${Math.max(1, Math.round(n.words / speakWpm()))} min`),
      n.tasks ? row("Checklist", `${n.done}/${n.tasks}`) : null,
      row("Links out", String(n.links.length)),
      row("Modified", relTime(n.mtime)),
      h("div", { class: "rp-path", title: n.path, text: n.path }),
      h("button", {
        class: "chip-btn",
        style: "margin-top:8px",
        title: "Earlier copies of this note, kept whenever a write would lose a lot of it",
        onclick: () => app.openVersions(n.path),
      }, icon("undo"), " Restore an earlier version…"));

    const rel = app.zettel ? app.zettel.relatedPanel(path) : null;

    // the note's tags: wherever they are written; one added goes in the header (note ids on) or on the first line
    const undoTo = (r, what) => app.toast(what, { ms: 4000, action: { label: "Undo", run: () => { const x = vault.get(n.path); if (x && x.content === r.next) vault.write(n.path, r.prev, { expected: true }); } } });
    const tagBox = h("div", { class: "rp-tagbox" },
      n.tags.map((t) => h("span", { class: "tag-chip is-static" },
        h("button", { class: "rp-tag-name", title: "Notes with this tag", onclick: () => app.openTag && app.openTag(t) }, "#" + t),
        h("button", { class: "rp-tag-x", title: "Take this tag off the note…", onclick: async () => {
          if (!(await confirmDialog(`Remove #${t}?`, "The tag comes off this note - from its header and from its text. Other notes keep theirs.", { ok: "Remove" }))) return;
          const r = app.noteIds && (await app.noteIds.removeTag(n.path, t));
          if (r) undoTo(r, `#${t} removed`);
        } }, icon("x")))),
      app.noteIds ? app.noteIds.tagField(n.path, { onAdded: (r) => undoTo(r, `#${r.tag} added`) }) : null);

    keepFocus(() => el.replaceChildren(...ordered([
      ...wsSecs,
      section("Outline", headings.length || null, outline, "outline"),
      section("Tags", n.tags.length || null, tagBox, "tags"),
      section("Backlinks", bl.length, backlinks, "backlinks"),
      rel ? section("Related notes", rel.count || null, rel.body, "related") : null,
      unlinked ? section("Unlinked mentions", um.length, unlinked, "unlinked") : null,
      emergingSec,
      section("Details", null, info, "info"),
    ].filter(Boolean))));
    curLine = -1;
    highlight(app.cursorLine || 0);
  }

  const speakWpm = () => { try { return Number((JSON.parse(localStorage.getItem("script.cfg")) || {}).wpm) || 150; } catch { return 150; } };
  const row = (k, v) => h("div", { class: "rp-row" }, h("span", { text: k }), h("span", { text: v }));

  function contextText(text) {
    return text.replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "").replace(WIKI_RE, (_, t, _h, a) => a || t).trim().slice(0, 160) || "…";
  }

  function linkMention(note, target) {
    const title = basename(target.path);
    const lower = note.content.toLowerCase();
    let i = lower.indexOf(title.toLowerCase());
    while (i >= 0) {
      const before = note.content.lastIndexOf("[[", i);
      const closed = note.content.lastIndexOf("]]", i);
      if (before < 0 || closed > before) break; // not inside an existing link
      i = lower.indexOf(title.toLowerCase(), i + title.length);
    }
    if (i < 0) return;
    const original = note.content.slice(i, i + title.length);
    const link = original === title ? `[[${vault.linkText(target.path)}]]` : `[[${vault.linkText(target.path)}|${original}]]`;
    const next = note.content.slice(0, i) + link + note.content.slice(i + title.length);
    vault.write(note.path, next);
    app.editor.applyExternal(note.path, next);
    app.toast(`Linked in “${note.title}”`);
    render();
  }

  function highlight(line) {
    if (el.hidden || !headings.length) return;
    let idx = -1;
    for (let i = 0; i < headings.length; i++) if (headings[i].line <= line) idx = i;
    if (idx === curLine) return;
    if (outlineEls[curLine]) outlineEls[curLine].classList.remove("is-cur");
    curLine = idx;
    if (outlineEls[idx]) outlineEls[idx].classList.add("is-cur");
  }

  const soon = debounce(render, 250);
  // after the note has been painted: a render walks every note, and holding Ctrl+Tab only needs the last one
  let viewQueued = false;
  app.bus.on("view", () => {
    if (viewQueued) return;
    viewQueued = true;
    requestAnimationFrame(() => setTimeout(() => { viewQueued = false; render(); }));
  });
  app.bus.on("space", render);
  app.bus.on("cursor", highlight);
  app.bus.on("rightpanel", render);
  // a save with no link change waits for a real pause: a render scans every note
  // and never under a tag being typed in the panel: it would take the field away
  const afterPause = debounce(() => {
    if (el.contains(document.activeElement) && document.activeElement.matches("input, textarea")) afterPause();
    else render();
  }, 2500);
  vault.bus.on("changed", (e) => {
    if (e.linksChanged || e.path !== app.currentPath()) forget();
    if (e.linksChanged) { afterPause.cancel(); soon(); }
    else if (e.path === app.currentPath()) {
      // the outline is cheap, and its clicks need the lines as they are now
      const n = vault.get(e.path), body = !el.hidden && n && el.querySelector('.rp-sec[data-id="outline"] .rp-body');
      if (body) { keepFocus(() => body.replaceChildren(outlineOf(n))); curLine = -1; highlight(app.cursorLine || 0); }
      afterPause();
    }
  });
  vault.bus.on("structure", soon);

  return { render };
}
