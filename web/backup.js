// Encrypted backups: move Leonote to another computer, or keep a copy.
// The file is encrypted with the user's password (the age format) before it
// is written; the password never leaves this device and is never stored.

import { h } from "./util.js";
import { icon } from "./icons.js";
import { fmtSize } from "./fileview.js";

const MIN_PASSWORD = 8;

/** A small modal. `body(close)` returns content; resolves with close(value). */
function modal(title, body) {
  return new Promise((resolve) => {
    const back = h("div", { class: "bk-back" });
    const prev = document.activeElement; // focus goes back there when it closes
    const close = (v) => { back.remove(); document.removeEventListener("keydown", esc, true); if (prev && prev.isConnected && prev.focus) prev.focus(); resolve(v); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
    back.append(h("div", { class: "bk-modal", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h3", { text: title }), body(close)));
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(null); });
    document.getElementById("overlay-root").append(back);
    document.addEventListener("keydown", esc, true);
    back.querySelector("input")?.focus();
  });
}

function passwordForm(close, { confirm, submit, note }) {
  const a = h("input", { type: "password", class: "text-input is-wide", placeholder: "Password", autocomplete: "new-password" });
  const b = confirm ? h("input", { type: "password", class: "text-input is-wide", placeholder: "Repeat the password", autocomplete: "new-password" }) : null;
  const err = h("div", { class: "bk-err" });
  const go = () => {
    if (a.value.length < MIN_PASSWORD) return (err.textContent = `Use at least ${MIN_PASSWORD} characters.`);
    if (b && a.value !== b.value) return (err.textContent = "The passwords don't match.");
    close(a.value);
  };
  for (const inp of [a, b]) if (inp) inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") go(); });
  return h("div", { class: "bk-form" },
    note ? h("p", { class: "bk-note", text: note }) : null,
    a, b, err,
    h("div", { class: "bk-btns" },
      h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
      h("button", { class: "btn btn-primary", onclick: go }, submit)));
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
};

export async function createBackup(app) {
  const host = app.host;
  const password = await modal("Encrypted backup", (close) => passwordForm(close, {
    confirm: true,
    submit: "Choose where to save…",
    note: "Everything in the backup is encrypted with this password. Nobody can open it without the password, including us, so keep it somewhere safe. Not in it: the saved passwords, earlier versions of notes, the trash, the AI access rules and plugins.",
  }));
  if (!password) return;
  const path = await host.dialogSave({
    title: "Save Leonote backup",
    defaultPath: `Leonote backup ${stamp()}.leonotebackup`,
    filters: [{ name: "Leonote backup", extensions: ["leonotebackup"] }],
  });
  if (!path) return;
  const includeVault = app.settings.backupIncludeVault !== false;
  const slow = app.settings.backupCompression === "smallest" ? " Smallest takes longer." : "";
  const t = app.toast((includeVault ? "Making the backup… (notes and files included)" : "Making the backup…") + slow, { ms: 60000 });
  try {
    await app.flushAll();
    const r = await host.backupExport(path, password, includeVault, app.settings.backupCompression || "balanced");
    if (typeof t === "function") t();
    const skipped = (r.skipped || []).length;
    app.toast(`Backup saved · ${fmtSize(r.bytes)} · ${(r.data_files || []).length} data files${includeVault ? `, ${r.vault_files ?? 0} notes and files` : ""}${skipped ? ` · ${skipped} could not be read and were left out` : ""}`, { ms: 8000, action: { label: "Show", run: () => host.externalReveal(path).catch(() => {}) } });
  } catch (e) {
    if (typeof t === "function") t();
    app.toast("Could not make the backup: " + e, { kind: "error" });
  }
}

export async function restoreBackup(app) {
  const host = app.host;
  const path = await host.dialogOpen({
    title: "Restore Leonote backup",
    multiple: false,
    directory: false,
    filters: [{ name: "Leonote backup", extensions: ["leonotebackup"] }],
  });
  if (!path) return;
  let password = null;
  let manifest = null;
  let note = "Enter the password this backup was made with.";
  while (!manifest) {
    const hint = note;
    password = await modal("Open backup", (close) => passwordForm(close, { submit: "Open", note: hint }));
    if (!password) return;
    try {
      manifest = await host.backupPeek(String(path), password);
    } catch (e) {
      if (String(e).includes("wrong password")) { note = "That password doesn't open this backup. Try again."; continue; }
      app.toast(String(e).includes("not a Leonote backup") ? "That file is not a Leonote backup." : "Could not open the backup: " + e, { kind: "error" });
      return;
    }
  }

  const m = manifest;
  const vaultBox = h("input", { type: "checkbox", checked: !!m.includes_vault, disabled: !m.includes_vault });
  const ok = await modal("Restore this backup?", (close) => h("div", { class: "bk-form" },
    h("dl", { class: "bk-facts" },
      h("dt", { text: "Made" }), h("dd", { text: m.created ? String(m.created).replace("T", " ").slice(0, 16) : "-" }),
      h("dt", { text: "On" }), h("dd", { text: m.device || "another computer" }),
      h("dt", { text: "Leonote" }), h("dd", { text: m.app_version || "-" }),
      h("dt", { text: "Contains" }), h("dd", { text: `${(m.data_files || []).length} data files${m.includes_vault ? `, ${m.vault_files} notes and files` : ""}` })),
    h("p", { class: "bk-note", text: "Tasks, habits, focus areas, stats and settings are replaced by the backup's. Your current ones are kept in a before-restore folder first. This computer keeps its own vault location and window layout." }),
    h("label", { class: "bk-check" }, vaultBox, m.includes_vault
      ? "Also restore notes and files into this vault (files that differ are moved to .trash first)"
      : "This backup has no notes or files"),
    h("div", { class: "bk-btns" },
      h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
      h("button", { class: "btn btn-primary", onclick: () => close({ vault: vaultBox.checked }) }, icon("undo"), "Restore and restart"))));
  if (!ok) return;
  try {
    await app.flushAll();
    const r = await host.backupImport(String(path), password, !!ok.vault && !!m.includes_vault);
    const files = r && r.vault_files ? ` · ${r.vault_files} notes and files written` : "";
    app.toast(`Restored${files}. Leonote restarts…`, { ms: 3000 });
    setTimeout(() => host.restart(), 900);
  } catch (e) {
    // the notes come first and the data files last: stopped in the notes, tasks and settings are as they were (the
    // notes written are back in place of the old ones, which are in .trash)
    app.toast("Could not restore all of it: " + e, { kind: "error", ms: 12000 });
  }
}
