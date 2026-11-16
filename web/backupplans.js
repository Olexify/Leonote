// Backup plans: what to back up, how often, where - and whether Leonote does
// it by itself or asks first. Plans are plain zips (readable anywhere, no
// password), the everyday safety net; the encrypted backup in Settings is for
// moving to another computer. Also the recovery window: the task list's
// history copies, brought back through the log the way any writer would.

import { h, dayKey } from "./util.js";
import { icon } from "./icons.js";
import { menu, confirmDialog, cornerCard } from "./ui.js";
import { fmtSize } from "./fileview.js";

export const CATS = [
  ["notes", "Notes", "fileText", ".md .txt"],
  ["images", "Pictures", "image", ".png .jpg .webp…"],
  ["media", "Video & audio", "play", ".mp4 .mp3 .webm…"],
  ["documents", "Documents", "file", ".pdf .docx .xlsx…"],
  ["code", "Code & text files", "code", ".json .js .py…"],
  ["sketches", "Leopaint drawings", "pen", ".leopaint .excalidraw"],
  ["boards", "Boards", "grid", ".canvas"],
  ["drawings", "Studio drawings", "brush", ".leostudio"],
  ["other", "Everything else", "file", "any other file"],
  ["data", "Tasks, habits, focus areas, settings", "check", "Leonote's own data"],
];
const DAY = 86400000;
const plans = (S) => (Array.isArray(S.backupPlans) ? S.backupPlans : []);
const uid = () => "bp-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`; };

/** The usual place, unless the plan or Settings say otherwise: a "Leonote Backups" folder beside the vault. */
export function backupDir(app, plan) {
  const own = (plan && plan.dir) || app.settings.backupDir;
  if (own) return own;
  const root = String(app.vault.root || "").replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return root.slice(0, Math.max(0, root.lastIndexOf(sep))) + sep + "Leonote Backups";
}
const vaultName = (app) => String(app.vault.root || "vault").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "vault";
const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

/** Run one plan now. Resolves to the summary, or null when it failed (the toast said why). */
const running = new Set(); // a plan run twice in one minute would write the same file twice at once
export async function runPlan(app, plan, { quiet = false } = {}) {
  if (running.has(plan.id)) { if (!quiet) app.toast("That backup is running already", { ms: 2500 }); return null; }
  running.add(plan.id);
  try { return await runPlanOnce(app, plan, { quiet }); } finally { running.delete(plan.id); }
}
async function runPlanOnce(app, plan, { quiet = false } = {}) {
  const dir = backupDir(app, plan);
  const sep = dir.includes("\\") ? "\\" : "/";
  // this computer's name in it: on a vault synced to several, each one's clean-up keeps to its own zips
  const here = app.device ? ` (${safe(app.device)})` : "";
  const file = `${dir}${sep}${safe(vaultName(app))} - ${safe(plan.name || "backup")}${here} - ${stamp()}.zip`;
  const cats = plan.cats && plan.cats.length ? plan.cats : ["all"];
  // a corner card with a bar that fills as the files go in
  const bar = h("div", { class: "bp-prog-fill" });
  const label = h("span", { text: `Backing up ${plan.name}…` });
  const card = h("div", { class: "saved-chip bp-card is-progress", role: "status" }, icon("archive"), h("div", { class: "bp-prog" }, label, h("div", { class: "bp-prog-track" }, bar)));
  const off = app.bus.on("backup:progress", (p) => {
    if (!p) return;
    const f = p.totalBytes ? p.bytes / p.totalBytes : p.total ? p.done / p.total : 0;
    bar.style.transform = `scaleX(${Math.min(1, f)})`;
    label.textContent = `Backing up ${plan.name} · ${p.done} of ${p.total}${p.file ? " · " + String(p.file).split("/").pop() : ""}`;
  });
  const close = cornerCard(card, { ms: 3600000, reset: false });
  try {
    const r = await app.host.backupPlain(file, cats, plan.exts || [], plan.compression || app.settings.backupCompression || "balanced", Math.max(1, Number(plan.keep) || 10));
    off(); close();
    setLastHere(plan.id, Date.now());
    const next = plans(app.settings).map((p) => (p.id === plan.id ? { ...p, lastBy: app.device || "", last: Date.now(), lastFile: r.path, lastBytes: r.bytes, lastFiles: r.files, lastError: "", failingSince: 0, failCount: 0 } : p));
    app.setSetting("backupPlans", next);
    app.toast(`${plan.name}: ${r.files} files, ${fmtSize(r.bytes)}${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`, { ms: 6000, action: { label: "Show", run: () => app.host.externalReveal(r.path).catch(() => {}) } });
    return r;
  } catch (e) {
    off(); close();
    app.toast(`Backup ${plan.name} failed: ${e}`, { kind: "error", ms: 9000 });
    // remembered on the plan and shown on its row, and once said by Windows: a toast is missed while Leonote sits in
    // the tray, and a plan whose drive is unplugged would fail unseen for weeks
    const was = plans(app.settings).find((p) => p.id === plan.id) || plan;
    const count = (Number(was.failCount) || 0) + 1;
    app.setSetting("backupPlans", plans(app.settings).map((p) => (p.id === plan.id ? { ...p, lastError: String(e).slice(0, 300), failingSince: p.failingSince || Date.now(), failCount: count } : p)));
    if (count === 3 && app.host.osNotify) app.host.osNotify("A backup keeps failing", `${plan.name}: ${String(e).slice(0, 160)}`).catch(() => {});
    return null;
  }
}

// when a plan last ran ON THIS COMPUTER: the plans travel with a synced vault, and another computer's run made this
// one's data never look due
const LAST_HERE = "leonote.planLast.";
// (a run made before this was kept counts only if it was this computer's - lastBy says whose)
const lastHere = (p) => { try { const v = Number(localStorage.getItem(LAST_HERE + p.id)); if (v) return v; } catch {} return !p.lastBy || p.lastBy === deviceHere ? p.last || 0 : 0; };
let deviceHere = "";
// a snooze is this computer's too: one computer's "Tomorrow" did not put off the other's backup
const SNOOZE_HERE = "leonote.planSnooze.";
const snoozeHere = (id, until) => { try { localStorage.setItem(SNOOZE_HERE + id, String(until)); } catch {} };
const setLastHere = (id, t) => { try { localStorage.setItem(LAST_HERE + id, String(t)); } catch {} };
const due = (p) => p.mode !== "off" && (!lastHere(p) || Date.now() - lastHere(p) >= (Number(p.every) || 7) * DAY);
const snoozed = (p) => { let s = 0; try { s = Number(localStorage.getItem(SNOOZE_HERE + p.id)) || 0; } catch {} return Date.now() < s; };

/** A reminder card for a plan that is due: back up now, tomorrow, or skip this time. */
function remind(app, plan) {
  const el = h("div", { class: "saved-chip bp-card", role: "status" },
    icon("archive"),
    h("span", { text: `${plan.name} is due (every ${plan.every} day${plan.every === 1 ? "" : "s"})` }),
    h("button", { class: "saved-undo", onclick: () => { hide(); runPlan(app, plan); } }, "Back up now"),
    h("button", { class: "saved-undo", onclick: () => { hide(); snoozeHere(plan.id, Date.now() + DAY); } }, "Tomorrow"),
    h("button", { class: "saved-gear", title: "Skip this time", onclick: () => { hide(); setLastHere(plan.id, Date.now()); app.setSetting("backupPlans", plans(app.settings).map((p) => (p.id === plan.id ? { ...p, last: Date.now() } : p))); } }, icon("x")));
  const hide = cornerCard(el, { ms: 60000, reset: true });
}

/** Once at start (a little after) and every hour after: what is due runs, or asks. */
export function mountBackupPlans(app) {
  deviceHere = app.device || "";
  const tick = async () => {
    if (!app.host.real) return;
    for (const p of plans(app.settings)) {
      if (!due(p) || snoozed(p)) continue;
      if (p.mode === "auto") await runPlan(app, p, { quiet: true });
      else if (p.mode === "ask") { remind(app, p); snoozeHere(p.id, Date.now() + 6 * 3600000); }
    }
  };
  setTimeout(tick, 25000);
  setInterval(tick, 3600000);
}

/** The three plans most people want, added in one go (existing ones are kept). */
export function suggestedPlans() {
  return [
    { id: uid(), name: "Notes, weekly", cats: ["notes", "data"], exts: [], every: 7, mode: "ask", compression: "smallest" },
    { id: uid(), name: "Pictures and media, every two weeks", cats: ["images", "media", "documents"], exts: [], every: 14, mode: "ask", compression: "fast" },
    { id: uid(), name: "Whole vault, monthly", cats: ["all", "data"], exts: [], every: 30, mode: "ask", compression: "balanced" },
  ];
}

/** The plan editor: name, what, extensions, how often, ask or auto, folder, compression. */
export function editPlan(app, plan) {
  return new Promise((resolve) => {
    const p = plan ? { ...plan, cats: [...(plan.cats || [])], exts: [...(plan.exts || [])] } : { id: uid(), name: "", cats: ["notes", "data"], exts: [], every: 7, mode: "ask", compression: app.settings.backupCompression || "balanced", dir: "" };
    const stats = new Map(); // category -> [count, bytes]; ext -> the same, keyed "ext:xyz"
    const name = h("input", { class: "text-input", value: p.name, placeholder: "Notes, weekly", spellcheck: false });
    const catBox = h("div", { class: "bp-cats" });
    const extBox = h("div", { class: "bp-exts", hidden: true });
    const extToggle = h("button", { class: "link-btn", text: "Pick file types one by one…", onclick: () => { extBox.hidden = !extBox.hidden; extToggle.textContent = extBox.hidden ? "Pick file types one by one…" : "Hide the file types"; } });
    const paintCats = () => {
      catBox.replaceChildren(...[["all", "Whole vault", "folder", "every file"], ...CATS].map(([id, label, ic, sub]) => {
        const st = id === "all" ? [...stats.entries()].filter(([k]) => !k.startsWith("ext:") && k !== "data").reduce((a, [, v]) => [a[0] + v[0], a[1] + v[1]], [0, 0]) : stats.get(id);
        const on = p.cats.includes(id) || (id !== "data" && id !== "all" && p.cats.includes("all"));
        return h("button", { class: "bp-cat" + (on ? " is-on" : ""), onclick: () => {
          if (id === "all") { p.cats = p.cats.includes("all") ? p.cats.filter((c) => c !== "all") : ["all", ...p.cats.filter((c) => c === "data")]; }
          else if (p.cats.includes(id)) p.cats = p.cats.filter((c) => c !== id);
          else p.cats = [...p.cats.filter((c) => c !== "all" || id === "data"), id];
          paintCats();
        } }, icon(ic), h("span", { class: "bp-cat-name", text: label }), h("span", { class: "bp-cat-sub", text: st && st[0] ? `${st[0]} · ${fmtSize(st[1])}` : id === "data" ? sub : sub }));
      }));
    };
    const paintExts = () => {
      const list = [...stats.entries()].filter(([k]) => k.startsWith("ext:")).sort((a, b) => b[1][1] - a[1][1]);
      extBox.replaceChildren(...(list.length ? list.map(([k, [n, b]]) => { const ext = k.slice(4); const on = p.exts.includes(ext); return h("button", { class: "chip-btn" + (on ? " is-on" : ""), onclick: () => { p.exts = on ? p.exts.filter((e) => e !== ext) : [...p.exts, ext]; paintExts(); } }, `.${ext || "(none)"} · ${n} · ${fmtSize(b)}`); }) : [h("span", { class: "bp-note", text: "Looking at the vault…" })]));
    };
    paintCats(); paintExts();
    app.host.backupCategories().then((rows) => {
      for (const r of rows) {
        const c = stats.get(r.category) || [0, 0]; stats.set(r.category, [c[0] + r.count, c[1] + r.bytes]);
        const k = "ext:" + r.ext; const e = stats.get(k) || [0, 0]; stats.set(k, [e[0] + r.count, e[1] + r.bytes]);
      }
      paintCats(); paintExts();
    }).catch(() => {});
    const every = h("input", { class: "text-input bp-every", type: "number", min: 1, max: 365, value: String(p.every || 7) });
    const keep = h("input", { class: "text-input bp-every", type: "number", min: 1, max: 999, value: String(p.keep || 10), title: "Older zips of this plan are removed once there are more than this" });
    const seg = (key, options) => { const wrap = h("div", { class: "segmented is-small" }); const paint = () => { for (const b of wrap.children) b.classList.toggle("is-active", b.dataset.v === String(p[key])); }; for (const [v, label] of options) wrap.append(h("button", { class: "seg", dataset: { v: String(v) }, onclick: () => { p[key] = v; paint(); } }, label)); paint(); return wrap; };
    const dirIn = h("input", { class: "text-input", value: p.dir || "", placeholder: backupDir(app, null), spellcheck: false });
    const browse = h("button", { class: "btn btn-sm", onclick: async () => { let picked = null; try { picked = await app.host.dialogOpen({ directory: true, multiple: false, title: "Where this plan's backups go" }); } catch {} const d = Array.isArray(picked) ? picked[0] : picked; if (d) dirIn.value = d; } }, icon("folder"), "Choose…");
    // a folder a cloud service keeps in sync: the backup is off this machine minutes after it is made
    const clouds = h("div", { class: "bp-clouds", hidden: true });
    app.host.syncFolders().then((list) => {
      if (!list || !list.length) return;
      clouds.hidden = false;
      clouds.replaceChildren(h("span", { class: "bp-note", text: "Into the cloud, through a folder it keeps in sync:" }), ...list.map((c) => h("button", { class: "chip-btn", title: c.path, onclick: () => { dirIn.value = c.path.replace(/[\\/]+$/, "") + (c.path.includes("\\") ? "\\" : "/") + "Leonote Backups"; } }, icon("globe"), c.name)));
    }).catch(() => {});
    const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const save = () => {
      p.name = name.value.trim() || "Backup";
      p.every = Math.max(1, Math.min(365, Number(every.value) || 7));
      p.keep = Math.max(1, Math.min(999, Number(keep.value) || 10));
      p.dir = dirIn.value.trim();
      if (!p.cats.length && !p.exts.length) { app.toast("Pick what to back up", { ms: 2200 }); return; }
      done(p);
    };
    const box = h("div", { class: "dlg dlg-trashbin bp-edit", role: "dialog", "aria-modal": "true" },
      h("div", { class: "dlg-head" }, h("h3", { class: "dlg-title", text: plan ? "Edit the plan" : "A backup plan" }), h("button", { class: "icon-btn", title: "Close (Esc)", onclick: () => done(null) }, icon("x"))),
      h("label", { class: "bp-field" }, h("span", { text: "Name" }), name),
      h("div", { class: "bp-field" }, h("span", { text: "What" }), catBox, extToggle, extBox),
      h("div", { class: "bp-field is-row" }, h("span", { text: "Every" }), every, h("span", { text: "days" }), h("span", { class: "trash-gap" }), h("span", { text: "Then" }), seg("mode", [["ask", "Ask me"], ["auto", "Back up by itself"], ["off", "Off"]])),
      h("div", { class: "bp-field is-row" }, h("span", { text: "Keep the last" }), keep, h("span", { text: "backups of this plan; older ones are removed" })),
      h("div", { class: "bp-field is-row" }, h("span", { text: "Squeeze" }), seg("compression", [["fast", "Fast"], ["balanced", "Balanced"], ["smallest", "Smallest"]]), h("span", { class: "bp-note", text: "pictures and media are stored as they are in every mode" })),
      h("div", { class: "bp-field" }, h("span", { text: "Folder" }), h("div", { class: "set-btns" }, dirIn, browse), clouds),
      h("p", { class: "bp-note", text: "A plain zip, readable anywhere: the vault's files under vault/, Leonote's data under data/. For an encrypted copy to carry to another computer, use the encrypted backup above. Not in it: the saved passwords, earlier versions of notes, the trash, the AI access rules and plugins. In a cloud folder anyone with that folder reads it - private notes too." }),
      h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(null) }, "Cancel"), h("button", { class: "btn btn-primary", onclick: save }, plan ? "Save" : "Add the plan")));
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(null); } }, box);
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } };
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => { back.classList.add("is-in"); name.focus(); });
  });
}

/** The plans, as rows for Settings: run, edit, remove; add one, or the usual three. */
export function plansPanel(app) {
  deviceHere = app.device || "";
  const S = app.settings;
  const list = h("div", { class: "bp-list" });
  const save = (next) => { app.setSetting("backupPlans", next); paint(); };
  const paint = () => {
    const all = plans(S);
    list.replaceChildren(...(all.length ? all.map((p) => {
      const what = p.cats.includes("all") ? "whole vault" : p.cats.map((c) => (CATS.find(([id]) => id === c) || [c, c])[1].toLowerCase()).join(", ");
      // this computer's last run (another one's would say "last today" on a row marked due)
      const when = (lastHere(p) ? `last ${dayKey(lastHere(p))}${p.lastBytes && (!p.lastBy || p.lastBy === deviceHere) ? " · " + fmtSize(p.lastBytes) : ""}` : "never yet here")
        + (p.lastError ? ` · failing since ${dayKey(p.failingSince || Date.now())}: ${p.lastError}` : "");
      const state = p.mode === "off" ? "off" : due(p) ? "due" : "";
      return h("div", { class: "bp-row" + (state === "due" ? " is-due" : "") + (p.mode === "off" ? " is-off" : "") },
        icon("archive"),
        h("div", { class: "bp-main" }, h("div", { class: "bp-name", text: p.name }), h("div", { class: "bp-sub", text: `${what}${p.exts && p.exts.length ? " + ." + p.exts.join(" .") : ""} · every ${p.every} day${p.every === 1 ? "" : "s"} · keeps ${p.keep || 10} · ${p.mode === "auto" ? "by itself" : p.mode === "ask" ? "asks first" : "off"} · ${when}` })),
        h("button", { class: "btn btn-sm", onclick: () => runPlan(app, p) }, "Run now"),
        h("button", { class: "icon-btn", title: "Edit", onclick: async () => { const e = await editPlan(app, p); if (e) save(plans(S).map((x) => (x.id === p.id ? e : x))); } }, icon("edit")),
        h("button", { class: "icon-btn", title: "Remove the plan (backups already made stay)", onclick: async () => { if (await confirmDialog(`Remove the plan “${p.name}”?`, "Backups already made stay where they are.", { ok: "Remove" })) save(plans(S).filter((x) => x.id !== p.id)); } }, icon("trash")));
    }) : [h("div", { class: "bp-empty", text: "No plans yet. Add one, or take the usual three: notes weekly, pictures and media every two weeks, the whole vault monthly - each asks first." })]));
  };
  paint();
  app.bus.on("settings", (k) => { if (k === "backupPlans") paint(); });
  return h("div", { class: "bp-panel" }, list,
    h("div", { class: "set-btns" },
      h("button", { class: "btn btn-primary", onclick: async () => { const p = await editPlan(app, null); if (p) save([...plans(S), p]); } }, icon("plus"), "Add a plan"),
      plans(S).length ? null : h("button", { class: "btn", onclick: () => save([...plans(S), ...suggestedPlans()]) }, icon("sparkles"), "The usual three"),
      h("button", { class: "btn", onclick: () => app.host.externalReveal(backupDir(app, null)).catch(() => app.toast("No backups folder yet - the first backup makes it", { ms: 3000 })) }, icon("reveal"), "Backups folder")));
}

/** Data recovery: the task list's history copies, with a restore each; the trash and note versions pointed at. */
export async function recoveryDialog(app) {
  let copies = [];
  let failed = null;
  try { copies = await app.host.tasksHistoryList(); } catch (e) { failed = e; }
  const when = (s) => String(s).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2}).*$/, "$1-$2-$3 $4:$5").replace(/^before-move-(\d+)$/, (m, t) => "before a move · " + dayKey(Number(t) * 1000));
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".menu") && document.querySelectorAll(".dlg-back").length === 1) { e.preventDefault(); e.stopPropagation(); close(); } };
  const rows = copies.slice(0, 60).map((c) => h("div", { class: "trash-row" },
    icon("check"),
    h("div", { class: "trash-main" }, h("div", { class: "trash-name", text: `${c.count} task${c.count === 1 ? "" : "s"}` }), h("div", { class: "trash-meta", text: `${when(c.stamp)} · ${fmtSize(c.bytes)}` })),
    h("button", { class: "btn btn-sm btn-primary", onclick: async () => {
      if (!(await confirmDialog(`Bring back ${c.count} tasks from ${when(c.stamp)}?`, "They are written as changes on top of what is there now: a task you still have is updated to that copy's version, one that is missing comes back, nothing is removed. Ctrl+Z does not undo this; a later copy can be restored over it.", { ok: "Restore", danger: false }))) return;
      try { const n = await app.host.tasksRestore(c.file); app.toast(`${n} tasks are back`, { ms: 4000 }); close(); } catch (e) { app.toast(String(e), { kind: "error" }); }
    } }, "Restore")));
  const box = h("div", { class: "dlg dlg-trashbin bp-recover", role: "dialog", "aria-modal": "true" },
    h("div", { class: "dlg-head" }, h("h3", { class: "dlg-title", text: "Data recovery" }), h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
    h("p", { class: "dlg-text", text: "Every compaction keeps a copy of the task list first; here they are, newest first. Notes deleted go to the trash; earlier versions of a note are in its menu. Earlier versions of the settings and state files are in history/settings beside them, plain JSON to copy back." }),
    h("div", { class: "trash-bar" }, h("b", { text: failed ? "The copies of the task list" : `${copies.length} cop${copies.length === 1 ? "y" : "ies"} of the task list` }), h("span", { class: "trash-gap" }),
      h("button", { class: "btn btn-sm", onclick: () => { close(); app.openTrash(); } }, icon("trash"), "The trash"),
      h("button", { class: "btn btn-sm", onclick: () => app.host.externalReveal(app.dataRoot ? app.dataRoot + (app.dataRoot.includes("\\") ? "\\history" : "/history") : "").catch(() => {}) }, icon("reveal"), "History folder")),
    h("div", { class: "trash-list" }, ...(rows.length ? rows : [h("div", { class: "trash-none", text: failed ? `Could not read the copies: ${failed}. They are kept in the history folder - open it above.` : "No copies yet - one is kept at every compaction" })])));
  const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(back);
  requestAnimationFrame(() => back.classList.add("is-in"));
}
