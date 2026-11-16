// Tools Leonote uses but does not ship - ffmpeg (video export, compressing a
// phone's videos) and Whisper (speech on this computer). A feature that needs one asks for it here: if it is
// missing, the user is offered to install it right then - the project's own
// release, into Leonote's tools folder on this computer (never the vault), an optional module -, with its progress, and the feature goes on once it
// is in. Nothing is ever fetched without that click.
import { h } from "./util.js";

export const WHAT = {
  ffmpeg: { size: "about 100 MB", from: "gyan.dev's official build" },
  whisper: { size: "about 150 MB with its base model", from: "whisper.cpp's GitHub release and its model on Hugging Face" },
};

/** Resolves the tool's path, or null when it is not here and the user did not install it. */
export async function ensureTool(app, tool, why) {
  const host = app.host;
  if (!host.onlineTools) return null;
  const t = await host.onlineTools().catch(() => ({}));
  const have = t[tool];
  if (have) return have;
  if (!host.toolInstall) return null;
  const w = WHAT[tool] || { size: "", from: "" };
  const ok = await new Promise((resolve) => {
    const done = (v) => { back.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } else if (e.key === "Enter") e.stopPropagation(); }; // a download only on a click: Enter alone does not start one (on a focused button it is that button's click)
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } },
      h("div", { class: "dlg", role: "dialog" },
        h("h3", { class: "dlg-title", text: `${why} needs ${tool}` }),
        h("p", { class: "dlg-text", text: `${tool} is a free program Leonote can use but does not come with - an optional module. Install it now? ${w.size}, from ${w.from}, into Leonote's tools folder on this computer (not your vault). Every part of Leonote that uses it can from then on, and deleting that folder removes it.` }),
        h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(false) }, "Not now"), h("button", { class: "btn btn-primary", onclick: () => done(true) }, `Install ${tool}`))));
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
    document.addEventListener("keydown", key, true);
  });
  if (!ok) return null;
  return installTool(app, tool);
}

/** Is speech on this computer set up - Whisper and ffmpeg both here? */
export async function speechReady(app) {
  if (!app.host.onlineTools) return true;
  const t = await app.host.onlineTools().catch(() => ({}));
  return !!(t.whisper && t.ffmpeg);
}
/**
 * Speech on this computer in one go: what is missing of Whisper and ffmpeg, asked once with the whole
 * size, then installed one after the other. What captions, the video editor's AI and the agents' video
 * tools hear with. Resolves true when both are here.
 */
export async function setupSpeech(app) {
  const t = app.host.onlineTools ? await app.host.onlineTools().catch(() => ({})) : {};
  const need = [!t.whisper && "whisper", !t.ffmpeg && "ffmpeg"].filter(Boolean);
  if (!need.length) return true;
  const { confirmDialog } = await import("./ui.js");
  const what = need.map((k) => `${k === "whisper" ? "Whisper" : "ffmpeg"} - ${WHAT[k].size}, from ${WHAT[k].from}`).join("; and ");
  const ok = await confirmDialog("Set up speech on this computer?", `Leonote hears what is said in a video with free programs it does not come with: ${what}. They go into Leonote's tools folder on this computer, not your vault. Captions, the video editor's AI and agents' video tools all use them; nothing you say leaves the computer. Deleting the folders removes them.`, { ok: "Install" });
  if (!ok) return false;
  for (const k of need) if (!(await installTool(app, k))) return false;
  return true;
}

/** Install with a toast that follows its progress. Resolves the path, or null. */
export async function installTool(app, tool) {
  let close = app.toast(`Installing ${tool}…`, { ms: 600000 });
  const off = app.host.on ? app.host.on("tool:progress", (p) => {
    const d = p && (p.payload || p);
    if (!d || d.tool !== tool) return;
    const text = d.stage === "winget" ? `Installing ${tool} with winget…` : d.stage === "brew" ? `Installing ${tool} with Homebrew…` : d.stage === "download" ? `Downloading ${tool}… ${d.total ? Math.round((d.got / d.total) * 100) + "%" : Math.round(d.got / 1048576) + " MB"}` : d.stage === "unpack" ? `Unpacking ${tool}…` : d.stage === "model" ? `Downloading ${tool}'s model…` : null;
    if (text) { if (close) close(); close = app.toast(text, { ms: 600000 }); }
  }) : null;
  try {
    let p;
    try { p = await app.host.toolInstall(tool); }
    catch (e) {
      // no winget route: the project's own release, straight from its site - only if the user says so
      const from = /^DIRECT:(.+)$/.exec(String(e));
      if (!from) throw e;
      if (close) { close(); close = null; }
      const { confirmDialog } = await import("./ui.js");
      if (!(await confirmDialog(`Download ${tool} straight from its makers?`, tool === "whisper" ? `On Windows, ${tool} comes straight from ${from[1]}, with or without winget. Leonote holds that version to a fingerprint it carries and refuses a file that differs. Download this one?` : `winget is not on this computer, so ${tool} would come straight from ${from[1]}. Leonote holds that version to a fingerprint it carries and refuses a file that differs. With winget (Microsoft's "App Installer", from the Microsoft Store) you would get its newest version instead. Download this one?`, { ok: "Download" }))) return null;
      close = app.toast(`Installing ${tool}…`, { ms: 600000 });
      p = await app.host.toolInstall(tool, true);
    }
    app.toast(`${tool} is installed`, { ms: 3000 });
    return p;
  } catch (e) {
    app.toast(`Could not install ${tool}: ${e}`, { kind: "error", ms: 9000 });
    return null;
  } finally {
    if (close) close();
    if (off && typeof off.then === "function") off.then((u) => typeof u === "function" && u()).catch(() => {});
  }
}
