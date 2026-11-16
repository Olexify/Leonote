// A file that is NOT in the vault: a .md double-clicked in Explorer, or one
// picked with Ctrl+Shift+O. It opens in a tab of its own, marked as outside,
// edits save straight back to where the file lies, and the banner on top can
// copy or move it into the vault whenever you decide it belongs there.

import { h, debounce, relTime } from "./util.js";
import { icon } from "./icons.js";
import { mountCode } from "./codeview.js";
import { fmtSize, KIND_ICON, archivePanel } from "./fileview.js";
import { outpostList } from "./outposts.js";
import { inlineEdit, confirmRenameExt } from "./ui.js";

/** Last segment of an OS path, either slash. */
export const osName = (p) => String(p).split(/[\\/]/).pop();
/** Everything before it - the folder the file sits in. */
export const osDir = (p) => {
  const s = String(p);
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i < 0 ? "" : s.slice(0, i);
};

/**
 * opts: { makeEditor(hostEl, scroller, own) } - the same note editor the main
 * and split panes use, so an outside .md behaves exactly like a note.
 */
export function mountExtView(app, el, { makeEditor } = {}) {
  let current = null;
  let info = null; // the last stat: size, mtime, kind
  let ed = null; // { getText(), focus(), destroy?() }
  let note = null; // the note editor, made once and kept
  let code = null; // the code editor of the file showing now
  let dirty = false;
  let saving = null;
  let player = null; // the player's box, when a video or song is showing

  /* ── the frame, built once: banner, note pane, code pane, card ───────── */
  const badge = h("button", { class: "xv-badge", title: "This file is outside your vault - Leonote edits it where it lies. Click to show it in Explorer.",
    onclick: () => { if (current) app.host.externalReveal(current).catch((e) => app.toast("Could not show it: " + e, { kind: "error" })); } }, icon("outside"), "Outside the vault");
  // double-click: rename it where it lies (asked first when its ending changes)
  const nameEl = h("div", { class: "xv-name", title: "Double-click to rename", ondblclick: () => {
    const was = current, name = osName(was);
    inlineEdit(nameEl, name, { selectBase: true, className: "fv-title-edit",
      onCommit: async (v) => {
        const n = String(v || "").trim();
        if (!n || n === name || !(await confirmRenameExt(name, n))) return paintHead();
        try { const to = await app.host.externalRename(was, n); app.extMoved && app.extMoved(was, to); }
        catch (e) { app.toast("Could not rename: " + e, { kind: "error" }); paintHead(); }
      } });
  } });
  const pathEl = h("div", { class: "xv-path" });
  const stateEl = h("span", { class: "fv-state", dataset: { state: "saved" }, text: "Saved" });
  const act = (label, title, ic, run, cls = "btn") => h("button", { class: cls, title, onclick: (e) => run(e.currentTarget) }, icon(ic), label);
  const head = h("header", { class: "xv-bar" }, badge,
    h("div", { class: "xv-meta" }, nameEl, pathEl),
    h("div", { class: "xv-acts" }, stateEl,
      // one card for both: where it goes (with suggestions), and whether the original stays
      act("Add to vault…", "Choose a folder in the vault - copy it, or move it there", "filePlus", async () => { const path = current; if (dirty) { saveSoon.cancel?.(); await save(); } app.addToVaultCard(path); }),
      act("", "Show in Explorer", "reveal", () => app.host.externalReveal(current).catch((e) => app.toast(String(e), { kind: "error" })), "icon-btn")));

  const edHost = h("div", { class: "editor-host" });
  const scroller = h("div", { class: "note-scroll xv-scroll" }, edHost);
  const codeBody = h("div", { class: "fv-body fv-code" });
  const cardBody = h("div", { class: "fv-body fv-center" });
  el.replaceChildren(h("div", { class: "fv xv" }, head, scroller, codeBody, cardBody));

  const pane = (which) => {
    scroller.hidden = which !== "note";
    codeBody.hidden = which !== "code";
    cardBody.hidden = which !== "card";
    head.hidden = which === "gone";
    stateEl.hidden = which === "card";
  };

  const setState = (s) => {
    stateEl.textContent = s === "dirty" ? "Edited" : s === "saving" ? "Saving…" : s === "error" ? "Not saved" : "Saved";
    stateEl.dataset.state = s;
  };

  const subText = () => [osDir(current), info ? fmtSize(info.size) : "", info && info.mtime ? relTime(info.mtime) : ""].filter(Boolean).join(" · ");
  const samePath = (a, b) => String(a).replace(/[\\/]+$/, "").toLowerCase() === String(b).replace(/[\\/]+$/, "").toLowerCase();
  /** the outpost this file lies in, if any: half at home, not a stray file */
  const outpostOf = (p) => outpostList(app).find((o) => samePath(p, o.path) || String(p).toLowerCase().startsWith(String(o.path).replace(/[\\/]+$/, "").toLowerCase() + "\\") || String(p).toLowerCase().startsWith(String(o.path).replace(/[\\/]+$/, "").toLowerCase() + "/"));
  const paintHead = () => {
    const o = outpostOf(current);
    head.classList.toggle("is-outpost", !!o);
    // a dropped file: only a copy in the temp folder - the webview never says where the original is
    const parked = /[\\/]leonote-dropped[\\/]/i.test(current);
    badge.replaceChildren(icon(o ? "folder" : "outside"), o ? (o.name || osName(o.path)) : parked ? "Temporary copy" : "Guest · external");
    badge.title = o ? `In your outpost “${o.name || o.path}” - the file stays where it lies. Click to show it in Explorer.` : parked ? "A temporary copy of the file you dropped: edits stay in this copy, not the original. Add it to the vault to keep them. Click to show it in Explorer." : "A guest: a file from somewhere else on this computer, opened where it lies. Add it to the vault if it should stay. Click to show it in Explorer.";
    nameEl.textContent = osName(current);
    pathEl.textContent = subText();
    pathEl.title = current;
  };

  async function save() {
    if (!dirty || !ed || !current) return saving;
    const path = current;
    const it = ed;
    dirty = false;
    setState("saving");
    const run = (async () => {
      try {
        const stat = await app.host.externalWrite(path, it.getText());
        if (current !== path) return;
        info = stat || info;
        paintHead();
        if (!dirty) setState("saved");
      } catch (e) {
        dirty = true;
        setState("error");
        app.toast(`Could not save ${osName(path)}: ${e}`, { kind: "error" });
      }
    })();
    saving = run;
    await run;
    if (saving === run) saving = null;
  }
  const saveSoon = debounce(save, 700);
  const edited = () => { dirty = true; setState("dirty"); saveSoon(); };

  async function add(move, anchor) {
    const path = current;
    if (dirty) { saveSoon.cancel?.(); await save(); }
    app.importExternal(path, { move, anchor });
  }

  function close() {
    if (dirty) { saveSoon.cancel?.(); save(); }
    if (code) { try { code.destroy(); } catch {} code = null; }
    if (player) { if (app.media) app.media.park(cardBody); player = null; cardBody.classList.remove("xv-player"); cardBody.replaceChildren(); }
    cardBody.classList.remove("xv-archive");
    if (note && current) note.forget(current);
    ed = null;
    dirty = false;
  }

  function card(text, anyway) {
    cardBody.replaceChildren(h("div", { class: "fv-card" },
      icon(KIND_ICON[(info && info.kind) || "other"] || "file"),
      h("h3", { text: osName(current) }),
      h("p", { text }),
      h("div", { class: "xv-card-acts" },
        anyway ? h("button", { class: "btn btn-primary", title: "Open it here all the same - a very big file makes the editor slow", onclick: anyway }, "Open anyway") : null,
        h("button", { class: anyway ? "btn" : "btn btn-primary", onclick: () => app.host.externalOpenInApp(current).catch((e) => app.toast(String(e), { kind: "error" })) }, "Open in default app"),
        h("button", { class: "btn", onclick: () => app.host.externalReveal(current).catch((e) => app.toast(String(e), { kind: "error" })) }, "Show in Explorer"))));
    pane("card");
  }

  // A picture, a video or a song, shown where it lies. The backend has to let
  // the webview load that one file first.
  async function preview(path, kind) {
    const ok = await app.host.externalAllow(path).catch(() => false);
    if (current !== path) return;
    const url = ok ? app.host.assetAbs(path) : "";
    if (!url) return card("Leonote could not load it - it opens in its own app.");
    if (kind === "image") {
      const img = h("img", { class: "xv-img", src: url, alt: osName(path), draggable: false, onerror: () => card("This picture format is not one Leonote can draw - it opens in its own app.") });
      cardBody.replaceChildren(img);
    } else {
      // the same player a song or video in the vault gets, with the playable
      // files beside it for previous and next
      let beside = [];
      if (outpostOf(path)) {
        const l = await app.host.outpostList(osDir(path)).catch(() => null);
        if (current !== path) return;
        beside = l ? (l.files || []).filter((f) => f.kind === "media").map((f) => f.path) : [];
      }
      const box = app.media.view(app.media.outsideKey(path, beside));
      player = box;
      cardBody.classList.add("xv-player");
      cardBody.replaceChildren(box);
      if (!document.activeElement?.closest?.("#sidebar, input, textarea")) requestAnimationFrame(() => { if (current === path) box.focus({ preventScroll: true }); });
    }
    pane("card");
    stateEl.hidden = true;
  }

  const bigOk = new Set(); // files the user said to open in spite of their size
  async function render(path) {
    close();
    info = null;
    paintHead();
    let data;
    try {
      data = await app.host.externalStat(path);
    } catch (e) {
      if (current !== path) return;
      pane("gone");
      cardBody.hidden = false;
      cardBody.replaceChildren(h("div", { class: "empty-state" }, icon("outside"),
        h("h3", { text: String(e).includes("Not allowed") ? "Leonote did not open this file" : "This file is not there any more" }), h("p", { text: String(e) })));
      app.extGone(path);
      return;
    }
    if (current !== path) return;
    info = data;
    paintHead();
    if (!data.editable) {
      if (data.kind === "image" || data.kind === "media") return preview(path, data.kind);
      // an archive outside the vault: what is in it, looked at and taken out as from one inside it
      if (/\.(zip|7z|rar|tar|gz|tgz|bz2|xz|cab|iso)$/i.test(path)) {
        cardBody.replaceChildren(archivePanel(app, path, { name: osName(path), openInApp: () => app.host.externalOpenInApp(path), alive: () => current === path }));
        cardBody.classList.add("xv-archive");
        return pane("card");
      }
      return card(data.kind === "pdf" ? "A PDF outside the vault opens in its own app. Copy it into the vault to read and mark it up here." : "Leonote can't show this file type - it opens in its own app.");
    }
    let text;
    try {
      const read = await app.host.externalRead(path, bigOk.has(path));
      if (current !== path) return;
      info = read;
      paintHead();
      text = read.text;
    } catch (e) {
      // too big to open by default: the user may say open it anyway
      return card(String(e), /is larger than/.test(String(e)) && !bigOk.has(path) ? () => { bigOk.add(path); render(path); } : null);
    }
    if (data.kind === "note" && makeEditor) {
      // the note editor, with the vault-only behaviour taken out: a link opens
      // a note that exists but never creates one, and pictures stay put
      if (!note) {
        note = makeEditor(edHost, scroller, {
          onChange: edited,
          isDirty: () => dirty,
          onLeave: () => {},
          openLink: (target, newTab) => {
            const p = app.vault.resolve(target);
            if (p) return app.openNote(p, { newTab });
            app.toast(`“${target}” is not a note in your vault - add this file to the vault to link it up`, { ms: 3600 });
          },
          onImages: () => app.toast("Pictures are pasted into notes inside the vault", { ms: 2600 }),
        });
      }
      note.open(path, text, {});
      ed = { getText: () => note.content(path) ?? text, focus: () => note.focus(), goLine: (n) => note.selectLine && note.selectLine(n) };
      pane("note");
      note.focus();
      toLine();
    } else {
      code = mountCode(codeBody, text, osName(path), {
        onChange: edited,
        onSave: () => { saveSoon.cancel?.(); save(); },
      });
      ed = { getText: code.getText, focus: code.focus, destroy: code.destroy, goLine: code.goLine };
      pane("code");
      code.focus();
      toLine();
    }
    setState(dirty ? "dirty" : "saved");
  }

  // Back from another program: take its version, unless there are edits here.
  async function refresh() {
    if (!current || !ed || dirty || saving) return;
    const path = current;
    const stat = await app.host.externalStat(path).catch(() => null);
    if (!stat || !info || stat.mtime === info.mtime) return;
    const read = await app.host.externalRead(path).catch(() => null);
    if (!read || current !== path || dirty) return;
    info = read;
    paintHead();
    if (read.text === ed.getText()) return;
    if (code) code.setText(read.text);
    else if (note) { note.forget(path); note.open(path, read.text, {}); ed.getText = () => note.content(path) ?? read.text; }
    app.toast(`${osName(path)} changed on disk - reloaded`, { ms: 2200 });
  }

  // a line asked for before the file was read waits for the editor
  let wantLine = 0;
  function toLine() { if (wantLine && ed && ed.goLine) { const n = wantLine; wantLine = 0; try { ed.goLine(n); } catch {} } }

  return {
    goLine(n) { wantLine = n; toLine(); },
    show(path) {
      if (path === current && ed) return;
      if (current && current !== path) close();
      current = path;
      render(path);
    },
    refresh,
    focus: () => ed && ed.focus && ed.focus(),
    /** Write pending edits now (tab switch, quit). */
    flush: () => { saveSoon.cancel?.(); return save(); },
    /** The view has left the screen for good: pending edits are saved (close), its editors go. */
    destroy() {
      if (player) cardBody.replaceChildren(); // out of the document, so it stops: parking would play on from the hidden dock
      close();
      current = null;
      if (note) { try { note.destroy(); } catch {} note = null; }
    },
    get dirty() { return dirty; },
    get path() { return current; },
  };
}
