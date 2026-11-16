// "Restore an earlier version of this note…"
//
// The versions themselves are kept by the Rust side (notehist.rs): the bytes a
// note had just before a write that emptied it or cut it down, plus a routine
// one every few minutes of writing. This is the window onto them - pick one,
// read it, put it back. Restoring keeps the current text first, so the restore
// is itself one step from being undone.

import { h, relTime, basename } from "./util.js";
import { icon } from "./icons.js";
import { toast } from "./ui.js";

/** `20260918T101500.123` → a Date, or null if it is not one of ours. */
export function parseStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** A one-line "what is in it" for the row. */
export function summary(v) {
  const first = (v.first_line || "").trim();
  return first || "(blank)";
}

const CSS = `
.nv { width: min(880px, calc(100vw - 32px)); max-height: 78vh; display: flex; flex-direction: column;
  padding: 16px 16px 12px; border-radius: 14px; background: var(--surface-2); box-shadow: var(--shadow-lg); }
.nv-head { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.nv-sub { margin: 0 0 12px; font-size: 12px; color: var(--text-3); }
.nv-cols { display: flex; gap: 12px; min-height: 0; flex: 1; }
.nv-list { width: 300px; flex: none; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.nv-item { display: block; width: 100%; text-align: left; padding: 7px 9px; border: 0; border-radius: 8px;
  background: transparent; color: var(--text); cursor: pointer; font: inherit; }
.nv-item:hover { background: var(--surface-3, rgba(127,127,127,.12)); }
.nv-item.is-on { background: var(--accent-soft, rgba(127,127,190,.22)); }
.nv-when { font-size: 12.5px; font-weight: 550; }
.nv-meta { font-size: 11px; color: var(--text-3); margin-top: 1px; }
.nv-first { font-size: 11.5px; color: var(--text-3); margin-top: 2px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.nv-prev { flex: 1; min-width: 0; overflow: auto; margin: 0; padding: 10px 12px; border-radius: 10px;
  background: var(--surface-1, rgba(127,127,127,.08)); font-family: var(--mono, monospace); font-size: 12px;
  line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2, var(--text)); }
.nv-btns { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.nv-note { margin-right: auto; font-size: 11.5px; color: var(--text-3); }
`;

function ensureCss() {
  if (document.getElementById("nv-css")) return;
  document.head.append(h("style", { id: "nv-css", text: CSS }));
}

/**
 * Show the versions of `path`. Returns when the dialog closes.
 * `app` needs: host, vault, editor, toast.
 */
export async function openVersions(app, path) {
  if (!path || !app.vault.get(path)) return app.toast("Open a note first");
  let versions = [];
  try {
    versions = (await app.host.noteVersions(path)) || [];
  } catch (err) {
    // the browser build has no Rust side, so there is no history to read
    if (/no command|not allowed|unknown/i.test(String(err))) return app.toast("Earlier versions are kept by the app itself, not in the browser preview");
    return app.toast(`Could not read the history of “${basename(path)}”: ${err}`, { kind: "error" });
  }
  if (!versions.length) {
    return app.toast(`No earlier versions of “${basename(path)}” have been kept yet`, { ms: 4200 });
  }

  ensureCss();
  const prev = document.activeElement;
  const cache = new Map(); // stamp -> text
  let chosen = versions[0];

  const preview = h("pre", { class: "nv-prev", text: "…" });
  const items = [];
  const restoreBtn = h("button", { class: "btn btn-primary", onclick: () => go() }, "Restore this version");

  const paint = () => {
    for (const [i, el] of items.entries()) el.classList.toggle("is-on", versions[i] === chosen);
  };

  const unreadable = new Set();
  async function show(v) {
    chosen = v;
    paint();
    if (cache.has(v.stamp)) return (preview.textContent = cache.get(v.stamp));
    preview.textContent = "Reading…";
    try {
      const text = await app.host.noteVersionRead(path, v.stamp);
      cache.set(v.stamp, text);
      if (chosen === v) preview.textContent = text;
    } catch (err) {
      unreadable.add(v.stamp);
      if (chosen === v) preview.textContent = `Could not read this version: ${err}`;
    }
  }

  for (const v of versions) {
    const at = parseStamp(v.stamp);
    const el = h("button", { class: "nv-item", onclick: () => show(v) },
      h("div", { class: "nv-when", text: at ? `${relTime(at.getTime())} · ${at.toLocaleString()}` : v.stamp }),
      h("div", { class: "nv-meta", text: `${fmtBytes(v.size)} · ${v.lines} ${v.lines === 1 ? "line" : "lines"}` }),
      h("div", { class: "nv-first", text: summary(v) }));
    items.push(el);
  }

  const now = app.vault.get(path).content;
  const box = h("div", { class: "nv", role: "dialog", "aria-modal": "true", "aria-label": "Earlier versions" },
    h("h3", { class: "nv-head", text: `Earlier versions of “${basename(path)}”` }),
    h("p", { class: "nv-sub", text: `The note has ${fmtBytes(now.length)} in it now. Restoring keeps this version too, so you can come straight back.` }),
    h("div", { class: "nv-cols" }, h("div", { class: "nv-list" }, items), preview),
    h("div", { class: "nv-btns" },
      h("span", { class: "nv-note" }, icon("undo"), " Kept in ~/.leonote/history/notes"),
      h("button", { class: "btn", title: "For a secret that got into the note: erase every kept version, its copies in the trash and proposed edits holding its text", onclick: () => { done(); eraseTraces(app, path); } }, icon("trash"), "Erase all of it…"),
      // a paragraph back without replacing the whole note: copy it from here
      h("button", { class: "btn", title: "Copy this version's text, to paste what you need into the note", onclick: () => { const t = cache.get(chosen.stamp); if (t != null) navigator.clipboard.writeText(t).then(() => toast("Copied", { ms: 1400 })).catch(() => {}); } }, icon("clipboard"), "Copy text"),
      h("button", { class: "btn", onclick: () => done() }, "Cancel"),
      restoreBtn));

  const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(); } }, box);
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    done();
  };

  let closed = false;
  function done() {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    if (prev && prev.focus) prev.focus();
  }

  async function go() {
    const v = chosen;
    const text = cache.get(v.stamp);
    // still being read, or it could not be: said, not a button that does nothing
    if (text == null) return toast(unreadable.has(v.stamp) ? "This version could not be read" : "Still reading this version - try again in a moment", { ms: 2500 });
    const before = app.vault.get(path).content;
    restoreBtn.disabled = true;
    try {
      // the note as it is right now becomes a version of its own, first
      await app.host.noteVersionKeep(path).catch(() => {});
      // editors first: a write that fails marks the note unsaved to be tried again, and replacing would clear that
      app.replaceInEditors(path, text);
      await app.vault.write(path, text, { expected: true });
      done();
      toast(`Restored “${basename(path)}” from ${relTime((parseStamp(v.stamp) || new Date()).getTime())}${app.vault.failed.has(path) ? " - not saved yet, still trying" : ""}`, {
        ms: 9000,
        action: {
          label: "Undo",
          run: () => { app.replaceInEditors(path, before); return app.vault.write(path, before, { expected: true }); },
        },
      });
    } catch (err) {
      restoreBtn.disabled = false;
      app.toast(`Could not restore: ${err}`, { kind: "error" });
    }
  }

  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(back);
  requestAnimationFrame(() => { back.classList.add("is-in"); restoreBtn.focus(); });
  show(versions[0]);
}

/**
 * Erase every trace of a note - its kept versions, its copies in the trash and
 * proposed edits holding its text - and with `andNote`, the note itself, for
 * good. For an API key or a password that got into a note. Two clicks on the
 * button: the first arms it, the second erases.
 */
export async function eraseTraces(app, path, { andNote = false } = {}) {
  let found;
  try { found = await app.host.noteHistoryErase(path, true); }
  catch (err) { return app.toast(`Could not look: ${err}`, { kind: "error" }); }
  const name = basename(path);
  const parts = [
    found.versions ? `${found.versions} kept version${found.versions === 1 ? "" : "s"}` : "",
    found.trash ? `${found.trash} cop${found.trash === 1 ? "y" : "ies"} in the trash` : "",
    found.proposals ? `${found.proposals} proposed edit${found.proposals === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (!parts.length && !andNote) return app.toast(`Nothing of “${name}” is kept anywhere else`, { ms: 3200 });
  ensureCss();
  const prev = document.activeElement;
  let armed = false, timer = 0;
  const go = h("button", { class: "btn btn-danger" }, icon("trash"), andNote ? "Delete it and erase…" : "Erase…");
  const box = h("div", { class: "nv nv-erase", role: "dialog", "aria-modal": "true", "aria-label": andNote ? "Delete for good" : "Erase every trace" },
    h("h3", { class: "nv-head", text: andNote ? `Delete “${name}” for good, with every trace?` : `Erase every trace of “${name}”?` }),
    h("p", { class: "nv-sub", text: (parts.length ? `This erases ${parts.join(", ")}` : "Nothing else of it is kept") + (andNote ? `${parts.length ? ", and" : " - this deletes"} the note itself: not to the trash, gone.` : ". The note stays as it is now.") }),
    h("p", { class: "nv-sub", text: "None of it can be brought back. Backups made earlier are archives of their own and keep what they had." }),
    h("div", { class: "nv-btns" }, h("span", { class: "fit-fill" }), h("button", { class: "btn", onclick: () => close() }, "Cancel"), go));
  const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  function close() { clearTimeout(timer); back.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus) prev.focus(); }
  go.addEventListener("click", async () => {
    // the first click only arms it; a second, within a few seconds, erases
    if (!armed) {
      armed = true;
      go.lastChild.textContent = "Click again to erase";
      go.classList.add("is-armed");
      timer = setTimeout(() => { armed = false; go.lastChild.textContent = andNote ? "Delete it and erase…" : "Erase…"; go.classList.remove("is-armed"); }, 4000);
      return;
    }
    clearTimeout(timer);
    go.disabled = true;
    try {
      // the note goes first, so nothing makes a fresh copy of it in between
      if (andNote && app.vault.get(path) && !(await app.trashItems([[path, "note"]], { mode: "forever", quiet: true }))) throw new Error("the note could not be deleted");
      const gone = await app.host.noteHistoryErase(path, false);
      close();
      const n = gone.versions + gone.trash + gone.proposals;
      app.toast(andNote ? `“${name}” is gone, with ${n} trace${n === 1 ? "" : "s"}` : `Erased ${n} trace${n === 1 ? "" : "s"} of “${name}”`, { ms: 4200 });
    } catch (err) {
      go.disabled = false;
      app.toast(`Could not erase: ${err}`, { kind: "error" });
    }
  });
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(back);
  requestAnimationFrame(() => { back.classList.add("is-in"); go.focus(); });
}
