// Deleting, and taking it back.
//
// Delete moves a thing to .trash in the vault (or, if chosen, to the Windows
// Recycle Bin); Shift+Delete asks about deleting it for good. What went to
// .trash comes back with Ctrl+Z or the toast's Undo, and the trash itself can
// be looked through: restore, delete for good, empty. Entries older than the
// time chosen in Settings are let go of - checked at start and a few times a
// day, which reads a folder and writes nothing unless something is due.

import { h, basename } from "./util.js";
import { icon } from "./icons.js";
import { toast, menu, confirmDialog } from "./ui.js";
import { fmtSize } from "./fileview.js";

export const KEEP_CHOICES = [[1, "1 day"], [7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "Forever"]];
export const keepLabel = (days) => (KEEP_CHOICES.find(([d]) => d === days) || [0, days + " days"])[1];

/** "3 days left", "5 hours left", "due" - for an entry deleted at `at`. */
export function timeLeft(at, days, now = Date.now()) {
  if (!days) return "kept until you delete it";
  if (at == null) return "age unknown - kept";
  const ms = at + days * 86400000 - now;
  if (ms <= 0) return "goes at the next clean-up";
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d} day${d === 1 ? "" : "s"} left`;
  const hrs = Math.max(1, Math.round(ms / 3600000));
  return `${hrs} hour${hrs === 1 ? "" : "s"} left`;
}

export function agoText(at, now = Date.now()) {
  if (at == null) return "";
  const m = Math.round((now - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) { const x = Math.round(m / 60); return `${x} hour${x === 1 ? "" : "s"} ago`; }
  const d = Math.round(m / 1440);
  return d < 60 ? `${d} day${d === 1 ? "" : "s"} ago` : new Date(at).toLocaleDateString();
}

const KIND_ICON = { note: "file", file: "file", folder: "folder" };

/**
 * `raw(path, kind, mode)` does the one deletion (saving first, closing tabs)
 * and resolves to { content } for a note; it throws when it could not.
 */
export function mountTrash(app, { raw }) {
  const S = app.settings;
  const keepDays = () => { const n = Number(S.trashKeepDays); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 30; };
  const modeNow = () => (S.trashMode === "bin" ? "bin" : "trash");
  const nameOf = (p) => basename(p) || p;

  // what Ctrl+Z takes back: one entry per deletion, a deletion being all the
  // things that went together
  const stack = [];

  /** items: [[path, kind]...]. mode: "trash" | "bin" | "forever" (default: the setting). */
  async function trashItems(items, { mode = modeNow(), quiet = false } = {}) {
    const done = [];
    for (const [path, kind] of items) {
      try {
        const r = await raw(path, kind, mode);
        done.push({ path, kind, content: r && r.content });
      } catch (e) {
        toast(`Could not delete “${nameOf(path)}”: ${e}`, { kind: "error" });
      }
    }
    if (!done.length) return 0;
    if (app.sound) app.sound("trash");
    const what = done.length === 1 ? `“${nameOf(done[0].path)}”` : `${done.length} items`;
    if (mode === "forever") { if (!quiet) toast(`Deleted ${what} for good`); return done.length; }
    const batch = { mode, items: done };
    stack.push(batch);
    if (app.fileOps) app.fileOps.push("trash");
    if (stack.length > 30) stack.shift();
    if (!quiet) toast(mode === "bin" ? `Moved ${what} to the Recycle Bin` : `Moved ${what} to trash · Ctrl+Z in the file list brings ${done.length === 1 ? "it" : "them"} back`,
      { ms: 7000, action: { label: "Undo", run: () => undo(batch) } });
    return done.length;
  }

  const waitFor = (test, ms = 2500) => new Promise((res) => {
    const t0 = Date.now();
    const tick = () => (test() ? res(true) : Date.now() - t0 > ms ? res(false) : setTimeout(tick, 60));
    tick();
  });

  async function undo(batch = stack[stack.length - 1]) {
    if (!batch) return false;
    const i = stack.indexOf(batch);
    if (i >= 0) stack.splice(i, 1);
    if (app.fileOps && app.fileOps.lastIndexOf("trash") >= 0) app.fileOps.splice(app.fileOps.lastIndexOf("trash"), 1);
    let back = 0;
    let lastNote = null;
    const inBin = [];
    for (const it of [...batch.items].reverse()) {
      try {
        if (batch.mode === "bin") {
          // the Recycle Bin hands nothing back to a program; a note is still
          // held in memory and is written again, the rest is Windows' to restore
          if (it.kind === "note" && it.content != null) { lastNote = await app.vault.restore(it.path, it.content); back++; }
          else inBin.push(it);
          continue;
        }
        const r = await app.host.trashRestore({ from: it.path });
        back++;
        if (r && r.kind === "note") lastNote = r.path;
      } catch (e) {
        toast(`Could not bring back “${nameOf(it.path)}”: ${e}`, { kind: "error" });
      }
    }
    if (inBin.length) toast(`${inBin.length === 1 ? `“${nameOf(inBin[0].path)}” is` : inBin.length + " items are"} in the Windows Recycle Bin - restore from there`, { ms: 9000, action: { label: "Open it", run: () => app.host.trashOpen(true).catch(() => {}) } });
    if (!back) return false;
    toast(back === 1 ? "Brought back from trash" : `Brought ${back} items back from trash`, { ms: 2600 });
    // the file watcher reports what came back; a lone note is opened again
    if (lastNote && batch.items.length === 1 && (await waitFor(() => app.vault.notes.has(lastNote)))) app.openNote(lastNote);
    return true;
  }

  /* ── the question ─────────────────────────────────────────────────────── */

  function gearMenu(at, repaint) {
    const r = at.getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      { header: "Keep things in trash for" },
      ...KEEP_CHOICES.map(([d, label]) => ({ label, checked: keepDays() === d, run: () => { app.setSetting("trashKeepDays", d); repaint(); } })),
      "sep",
      { header: "Delete moves things to" },
      { label: "Leonote's trash (Ctrl+Z brings back)", checked: modeNow() === "trash", run: () => { app.setSetting("trashMode", "trash"); repaint(); } },
      { label: "Windows Recycle Bin", checked: modeNow() === "bin", run: () => { app.setSetting("trashMode", "bin"); repaint(); } },
      "sep",
      { label: "View trash…", icon: "trash", run: () => openTrash() },
    ]);
  }

  /** Ask, then delete. forever: the Shift+Delete question. Resolves to how many went. */
  function askTrash(items, { forever = false } = {}) {
    items = (items || []).filter(Boolean);
    if (!items.length) return Promise.resolve(0);
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const one = items.length === 1 ? items[0] : null;
      // a folder is never "one item": say how much goes with it
      const inside = (dir) => { let n = 0; for (const p of app.vault.notes.keys()) if (p.startsWith(dir + "/")) n++; for (const p of app.vault.files.keys()) if (p.startsWith(dir + "/")) n++; return n; };
      const counts = new Map(items.filter(([, k]) => k === "folder").map(([p]) => [p, inside(p)]));
      const nFolders = counts.size;
      const nLoose = items.length - nFolders;
      const nInside = [...counts.values()].reduce((a, b) => a + b, 0);
      const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
      const what = one ? (one[1] === "folder" ? `folder “${nameOf(one[0])}” and the ${pl(nInside, "file")} in it` : `“${nameOf(one[0])}”`)
        : nFolders ? `${pl(nFolders, "folder")}${nLoose ? " and " + pl(nLoose, "file") : ""} - ${pl(nInside + nLoose, "file")} in all`
        : pl(items.length, "file");
      const done = async (yes) => {
        hidePeek(); peek.remove();
        back.remove();
        document.removeEventListener("keydown", onKey, true);
        // for good is asked twice: a second, last question, where Enter means Cancel
        if (yes && forever) yes = await confirmDialog("Last check: delete permanently?", `${what[0].toUpperCase() + what.slice(1)} will be gone for good - not in the trash, not in the Recycle Bin. Nothing can bring ${one && one[1] !== "folder" ? "it" : "them"} back.`, { ok: "Yes, delete for good", safe: true });
        if (prev && prev.focus && prev.isConnected) prev.focus();
        resolve(yes ? await trashItems(items, { mode: forever ? "forever" : modeNow() }) : 0);
      };
      const text = h("p", { class: "dlg-text" });
      const okBtn = h("button", { class: "btn btn-danger", onclick: () => done(true) });
      const paint = () => {
        const d = keepDays();
        const go = one ? "It goes" : "They go";
        const it = one ? "it" : "them";
        text.textContent = forever ? `This cannot be taken back - ${one ? "it does" : "they do"} not go to the trash.`
          : modeNow() === "bin" ? `${go} to the Windows Recycle Bin and can be restored from there.`
          : d ? `${go} to .trash in your vault and ${one ? "stays" : "stay"} there for ${keepLabel(d)}. Ctrl+Z in the file list brings ${it} back.`
          : `${go} to .trash in your vault and ${one ? "stays" : "stay"} until you empty it. Ctrl+Z in the file list brings ${it} back.`;
        okBtn.textContent = forever ? "Delete permanently" : modeNow() === "bin" ? "Move to Recycle Bin" : "Move to trash";
      };
      paint();
      const gear = h("button", { class: "icon-btn dlg-gear", title: "How long the trash keeps things, where Delete puts them, and the trash itself", onclick: () => gearMenu(gear, paint) }, icon("settings"));
      // what is listed: the items, or - for one folder - everything inside it, by its path within the folder
      const within = (dir) => [...[...app.vault.notes.keys()].filter((p) => p.startsWith(dir + "/")).map((p) => [p, "note"]), ...[...app.vault.files.keys()].filter((p) => p.startsWith(dir + "/")).map((p) => [p, "file"])].sort((a, b) => a[0].localeCompare(b[0]));
      // every folder is followed by what is inside it, set in from the folder's row
      const listed = items.flatMap(([p, k]) => (k === "folder" ? [[p, k, ""], ...within(p).map(([q, kk]) => [q, kk, p])] : [[p, k, ""]]));
      // hovering a row shows what is in it, to the right of the card, so you can see what you are about to lose
      const peek = h("div", { class: "dlg-peek", hidden: true });
      let peekTimer = 0;
      const hidePeek = () => { clearTimeout(peekTimer); peek.hidden = true; };
      const showPeek = (row, p, k) => {
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => {
          if (!app.peekBody || k === "folder") return;
          peek.replaceChildren(h("div", { class: "tab-peek-head" }, icon(KIND_ICON[k] || "file"), h("span", { class: "tab-peek-title", text: nameOf(p) })), h("div", { class: "tab-peek-path", text: p }), app.peekBody(k, p));
          const b = box.getBoundingClientRect();
          const r = row.getBoundingClientRect();
          peek.hidden = false;
          const right = b.right + 10 + peek.offsetWidth <= innerWidth - 8;
          peek.style.left = (right ? b.right + 10 : Math.max(8, b.left - 10 - peek.offsetWidth)) + "px";
          peek.style.top = Math.max(8, Math.min(r.top, innerHeight - peek.offsetHeight - 8)) + "px";
        }, 180);
      };
      const li = ([p, k, under]) => h("li", { class: under ? "is-inner" : "", onmouseenter: (e) => showPeek(e.currentTarget, p, k), onmouseleave: hidePeek }, icon(KIND_ICON[k] || "file"), h("span", { text: under ? p.slice(under.length + 1) : nameOf(p) }), k === "folder" ? h("em", { text: pl(counts.get(p) || 0, "file") }) : null);
      const names = one && one[1] !== "folder" ? null : h("ul", { class: "dlg-names" },
        ...listed.slice(0, 7).map(li),
        listed.length > 7 ? h("li", { class: "is-more" }, h("button", { class: "dlg-more", text: `and ${listed.length - 7} more - show all`, onclick: (e) => {
          e.currentTarget.parentElement.replaceWith(...listed.slice(7).map(li));
        } })) : null);
      const box = h("div", { class: "dlg dlg-trash" + (forever ? " is-forever" : ""), role: "alertdialog", "aria-modal": "true" },
        h("div", { class: "dlg-head" }, h("h3", { class: "dlg-title", text: forever ? `Delete ${what} permanently?` : `Delete ${what}?` }), gear),
        names, text,
        h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), okBtn));
      const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } }, box);
      const onKey = (e) => {
        if (document.querySelector(".menu")) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === "Enter" && document.activeElement !== gear) { e.preventDefault(); e.stopPropagation(); done(document.activeElement !== box.querySelector(".dlg-btns .btn:first-child")); }
      };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("overlay-root").append(back, peek);
      // for good: Cancel has the focus, so Enter alone deletes nothing
      requestAnimationFrame(() => { back.classList.add("is-in"); (forever ? box.querySelector(".dlg-btns .btn:first-child") : okBtn).focus(); });
    });
  }

  /* ── the trash itself ─────────────────────────────────────────────────── */

  let openBack = null;
  async function openTrash() {
    if (openBack) return;
    const list = h("div", { class: "trash-list" });
    const sum = h("div", { class: "trash-sum" });
    const keep = h("select", { class: "select", title: "How long the trash keeps things", onchange: () => { app.setSetting("trashKeepDays", Number(keep.value)); draw(); } },
      ...KEEP_CHOICES.map(([d, label]) => h("option", { value: String(d), text: label })));
    let items = [];
    let failed = false;
    const close = () => { if (!openBack) return; openBack.remove(); openBack = null; document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".menu") && document.querySelectorAll(".dlg-back").length === 1) { e.preventDefault(); e.stopPropagation(); close(); } };
    const load = async () => { failed = false; try { items = await app.host.trashList(); } catch (e) { items = []; failed = true; toast("Could not read the trash: " + e, { kind: "error" }); } draw(); };
    const forget = (path) => { for (const b of [...stack]) { b.items = b.items.filter((x) => x.path !== path); if (!b.items.length) stack.splice(stack.indexOf(b), 1); } };
    const restore = async (it) => {
      try {
        const r = await app.host.trashRestore({ entry: it.entry });
        if (it.from) forget(it.from);
        toast(`“${it.name}” is back${r && r.path ? " at " + r.path : ""}`, { ms: 3200 });
      } catch (e) { toast("Could not restore: " + e, { kind: "error" }); }
      load();
    };
    // everything back where it was (an overwrite copy, with no place of its own, into the vault's root)
    const restoreAll = async () => {
      const all = [...items];
      if (!all.length || !(await confirmDialog(`Restore all ${all.length} item${all.length === 1 ? "" : "s"}?`, "Each goes back where it was; anything without a place goes in the vault's root.", { ok: "Restore all", danger: false }))) return;
      let back = 0;
      for (const it of all) {
        try { await app.host.trashRestore({ entry: it.entry }); if (it.from) forget(it.from); back++; }
        catch (e) { toast(`Could not restore “${it.name}”: ${e}`, { kind: "error" }); }
      }
      toast(`${back} item${back === 1 ? "" : "s"} back`, { ms: 3000 });
      load();
    };
    const destroy = async (list2, title) => {
      if (!list2.length) return;
      if (!(await confirmDialog(title, "This cannot be taken back.", { ok: "Delete permanently", safe: true }))) return;
      try { await app.host.trashRemove(list2.map((x) => x.entry)); for (const x of list2) if (x.from) forget(x.from); } catch (e) { toast("Could not delete: " + e, { kind: "error" }); }
      load();
    };
    // the time left first: a long folder path is what gets cut off
    const metaOf = (it) => [
      timeLeft(it.at == null ? null : Math.max(it.at, Number(S.trashSweepSince) || 0), keepDays()),
      it.from ? (it.from.includes("/") ? "from " + it.from.slice(0, it.from.lastIndexOf("/")) : "from the vault's root") : "a copy kept before an overwrite",
      it.kind === "folder" ? `${it.count} file${it.count === 1 ? "" : "s"}` : null,
      fmtSize(it.size || 0), agoText(it.at),
    ].filter(Boolean).join(" · ");
    function draw() {
      keep.value = String(keepDays());
      const total = items.reduce((n, x) => n + (x.size || 0), 0);
      sum.textContent = items.length ? `${items.length} item${items.length === 1 ? "" : "s"} · ${fmtSize(total)}` : "";
      emptyBtn.disabled = !items.length;
      restoreAllBtn.disabled = !items.length;
      if (!items.length) { list.replaceChildren(h("div", { class: "trash-none" }, icon("trash"), h("div", { text: failed ? "Could not read the trash. Open folder shows it in Explorer." : "The trash is empty" }))); return; }
      list.replaceChildren(...items.map((it) => h("div", { class: "trash-row" },
        icon(KIND_ICON[it.kind] || "file"),
        h("div", { class: "trash-main" },
          h("div", { class: "trash-name", text: it.name, title: it.entry }),
          h("div", { class: "trash-meta", text: metaOf(it), title: metaOf(it) })),
        h("button", { class: "btn btn-sm", title: it.from ? "Put it back where it was" : "Put it in the vault's root", onclick: () => restore(it) }, "Restore"),
        h("button", { class: "icon-btn is-danger", title: "Delete permanently", onclick: () => destroy([it], `Delete “${it.name}” permanently?`) }, icon("x")))));
      // the row just restored or deleted is gone: the keyboard stays in the list, not lost to the page
      if (openBack && openBack.isConnected && (!document.activeElement || document.activeElement === document.body)) { const b = list.querySelector("button") || box.querySelector("button"); if (b) b.focus(); }
    }
    const restoreAllBtn = h("button", { class: "btn btn-sm", title: "Put everything in the trash back where it was", onclick: () => restoreAll() }, "Restore all");
    const emptyBtn = h("button", { class: "btn btn-sm btn-danger", onclick: () => destroy(items, `Empty the trash - ${items.length} item${items.length === 1 ? "" : "s"}?`) }, "Empty trash");
    const box = h("div", { class: "dlg dlg-trashbin", role: "dialog", "aria-modal": "true" },
      h("div", { class: "dlg-head" }, h("h3", { class: "dlg-title", text: "Trash" }), sum,
        h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
      h("div", { class: "trash-bar" },
        h("label", { class: "trash-keep" }, h("span", { text: "Keep for" }), keep),
        h("span", { class: "trash-gap" }),
        h("button", { class: "btn btn-sm", title: "The .trash folder in your vault", onclick: () => app.host.trashOpen(false).catch((e) => toast(String(e), { kind: "error" })) }, icon("folder"), "Open folder"),
        restoreAllBtn, emptyBtn),
      list);
    openBack = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === openBack) close(); } }, box);
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(openBack);
    requestAnimationFrame(() => openBack && openBack.classList.add("is-in"));
    draw();
    load();
  }

  /* ── Ctrl+Z, when the keys are with the file list and not in a text ───── */
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.code !== "KeyZ" || !stack.length) return;
    if (app.fileOps && app.fileOps.length && app.fileOps[app.fileOps.length - 1] !== "trash") return; // a rename came after: that goes back first
    const a = document.activeElement;
    const side = document.getElementById("sidebar");
    // the keys are with the file list - or a row was just clicked and nothing typed since (the note it opened has no undo of its own yet)
    // a text field keeps its own Ctrl+Z, whatever was clicked in the tree before it
    if (a && a.matches("input, textarea, select, [contenteditable], [contenteditable] *")) return;
    const rowJustClicked = app.sidebarArmed && app.sidebarArmed();
    if (!rowJustClicked && (!a || !side || !side.contains(a) || a.matches("input, textarea, [contenteditable], [contenteditable] *"))) return;
    if (document.querySelector(".dlg-back")) return;
    e.preventDefault();
    e.stopPropagation();
    undo();
  }, true);

  /* ── old entries are let go of ────────────────────────────────────────── */
  // The first time this runs in a vault, the day is written down once and
  // nothing counts as older than it: a trash that filled up before there was
  // any clean-up gets the full time again and is not emptied on first start.
  const since = () => { if (!Number(S.trashSweepSince)) app.setSetting("trashSweepSince", Date.now()); return Number(S.trashSweepSince); };
  const sweep = () => { const d = keepDays(); const from = since(); if (d) app.host.trashSweep(d, from).catch(() => {}); };
  setTimeout(sweep, 25000);
  setInterval(sweep, 6 * 3600000);

  app.trashItems = trashItems;
  app.trashAsk = askTrash;
  if (!app.askTrash) app.askTrash = askTrash;
  app.undoTrash = () => undo();
  app.openTrash = openTrash;
  return { askTrash, trashItems, undo, openTrash, canUndo: () => stack.length > 0 };
}
