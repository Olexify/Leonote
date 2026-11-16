// Plugins (plugins.rs keeps the folders and the user's yes). Each runs in a sandboxed frame of its own - scripts
// only, no same origin, no fetch - and reaches Leonote only by messages. Every message is judged here: it must come
// from that very frame's window, and ask only for what the plugin was given. Private notes are never given, and
// writes go through the folders' AI access as agents' do (proposals.js), never the full access given to AI. The
// engine still lets a frame look up names (DNS), so what a plugin reads it may be able to send out: the dialog says so.
// Docs: docs/plugins/PLUGINS.md.

import { h, dirname } from "./util.js";
import { icon } from "./icons.js";
import { themeVars, isDark } from "./dataview.js";
import { noteIn } from "./proposals.js";

/** The frame's policy: its own script and blob: scripts, nothing from anywhere else. Edge 156 ignores the webrtc line (pluginframe.js makes it harder, not impossible - see the install dialog's warning). */
export const frameCsp = (src) => `default-src 'none'; script-src ${src} blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'`;

function frameDoc() {
  const src = new URL("pluginframe.js", location.href).href;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(src)}">
<style>:root { ${themeVars()} color-scheme: ${isDark() ? "dark" : "light"}; } html, body { margin: 0; background: transparent; color: var(--text-normal); font: 13px/1.5 var(--font-text); } button, input, select, textarea { font: inherit; color: inherit; }</style>
</head><body><script src="${src}"></script></body></html>`;
}

const GUEST = /^(@guest\/|\.)/;
/** A plain path of a note in the vault: no way out of it, no second spelling Windows would read as another file. */
export function safeNotePath(path) {
  if (typeof path !== "string" || path.length > 1000 || !/\.md$/i.test(path) || GUEST.test(path)) return false;
  return path.split("/").every((seg) => seg && !seg.startsWith(".") && !/[.\s]$/.test(seg) && !/[\\:<>"|?*\u0000-\u001f]/.test(seg));
}

const NEED = { "commands.add": "commands", "panel.show": "panel", "panel.hide": "panel", "notes.list": "notes.read", "notes.read": "notes.read", "notes.write": "notes.write", "notes.append": "notes.write" };
const MAX_TEXT = 5 << 20;
const MAX_COMMANDS = 20;

/** Anything in a text that could be read as a web address, however it is spelled (a browser drops tabs in one). */
const webWords = (text) => new Set(String(text).replace(/\t/g, "").split(/\s+/).filter((w) => /https?:|[\\/]{2}|www\.|&#?\w+;/i.test(w)));
/**
 * Does this change add a web address? A note can load one by itself (a picture, a link card) or on a click, and the
 * address can carry what the plugin read to a host the user never allowed. So such a change waits for the user, even in an open note.
 */
export function addsWebAddress(old, next) {
  const had = webWords(old);
  return [...webWords(next)].some((w) => !had.has(w));
}
const string = (v, max, what) => { if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${what} must be text`); return v; };

/** Who a plugin's proposals are from: its name to read, its id to tell two of one name apart (ids are unique). */
export const pluginAgent = (row) => `Plugin: ${row.name} (${row.id})`;

/** How often a plugin may write and download: enough for any real use, too little to fill the disk, the notes'
 * version history or the review with edits, or to flood a server. */
export const LIMITS = { write: [30, 60000], fetch: [60, 60000], bytes: [20e6, 60000], proposal: [20, 3600000] };
function spend(p, kind, size = 0) {
  const now = Date.now();
  p.spent = p.spent || {};
  const recent = (k) => (p.spent[k] || []).filter(([t]) => now - t < LIMITS[k][1]);
  const calls = recent(kind);
  if (calls.length >= LIMITS[kind][0]) throw new Error(`This plugin is doing that too often - ${LIMITS[kind][0]} a minute at most`);
  // a write also counts its size: 30 writes of 5 MB would still be 150 MB a minute of notes or proposals
  const bytes = kind === "write" ? recent("bytes") : null;
  if (bytes && bytes.reduce((a, [, n]) => a + n, 0) + size > LIMITS.bytes[0]) throw new Error("This plugin is writing too much - 20 MB a minute at most");
  p.spent[kind] = [...calls, [now, 1]];
  if (bytes) p.spent.bytes = [...bytes, [now, size]];
}

/**
 * One call from a plugin's frame. `p`: { row: { id, name, permissions }, alive, addCommand, showPanel, hidePanel }.
 * Everything a plugin can do is in here; anything else, or anything it was not given, is refused.
 */
export async function callPlugin(app, p, method, args) {
  const given = p.row.permissions;
  if (method === "net.fetch") {
    let host = null;
    try { const u = new URL(args[0]); if (u.protocol === "https:" && !u.port && !u.username && !u.password) host = u.hostname; } catch {}
    if (!host || !given.includes("net:" + host)) throw new Error("This plugin was not allowed to connect there");
    spend(p, "fetch");
    if ((p.fetching || 0) >= 4) throw new Error("This plugin has 4 downloads going already - wait for one");
    p.fetching = (p.fetching || 0) + 1;
    try { return await app.host.pluginFetch(p.row.id, args[0]); } finally { p.fetching--; }
  }
  if (!Object.hasOwn(NEED, method)) throw new Error("Leonote has no such call");
  if (!given.includes(NEED[method])) throw new Error(`This plugin was not allowed to use ${method}`);
  switch (method) {
    case "commands.add": return p.addCommand(string(args[0], 64, "A command's id"), string(args[1], 80, "A command's name"));
    case "panel.show": return p.showPanel();
    case "panel.hide": return p.hidePanel();
  }
  // AI access may still be loading, and the plugin may have been turned off meanwhile
  await app.proposals.ready;
  if (p.alive === false) throw new Error("This plugin is off");
  const access = app.proposals;
  const notes = app.vault.notes;
  if (method === "notes.list") return [...notes.values()].filter((n) => safeNotePath(n.path) && access.noteAccess(n.path, undefined, true) !== "private").map((n) => ({ path: n.path, mtime: n.mtime || 0 }));
  const path = args[0];
  if (!safeNotePath(path)) throw new Error("That is not the path of a note");
  if (method === "notes.read") {
    // a private note looks like no note at all
    const n = noteIn(notes, path);
    if (!n || access.noteAccess(n.path, undefined, true) === "private") throw new Error("No such note");
    return n.content;
  }
  const text = args[1];
  if (typeof text !== "string" || text.length > MAX_TEXT) throw new Error("The text must be text, 5 MB at most");
  const why = typeof args[2] === "string" ? args[2].slice(0, 300) : "";
  // a private note, under any spelling, takes nothing and is built on nothing, and the answer is what a note that is
  // not there would get: a refusal would tell the plugin a guessed name is right
  const hidden = access.noteAccess(path, undefined, true) === "private";
  const n = hidden ? null : noteIn(notes, path);
  const old = n ? n.content || "" : "";
  const sep = !old || old.endsWith("\n\n") ? "" : old.endsWith("\n") ? "\n" : "\n\n";
  const next = method === "notes.write" ? text : `${old}${sep}${text.trimEnd()}\n`;
  // what is charged is what would be stored (an append in review keeps the whole note), in UTF-8 bytes
  // (a plugin that may not read notes is charged its own text: the whole note's size would tell it how big the note is.
  // What a proposal stores - the whole note, twice - is bounded by the count of proposals below instead, which says
  // nothing about any note)
  spend(p, "write", new TextEncoder().encode(given.includes("notes.read") ? next : text).length);
  const review = addsWebAddress(old, next);
  const asIfMissing = () => (!review && access.accessOf(dirname(path), true) === "open" ? "written" : "proposed");
  // charged for whatever answers "proposed", a private note's pretend answer too, so the count tells nothing
  if (hidden ? asIfMissing() === "proposed" : review || access.noteAccess(path, undefined, true) === "review") spend(p, "proposal");
  if (hidden) return asIfMissing();
  const done = await access.writeFor(path, next, method === "notes.write" ? "write" : "append", pluginAgent(p.row), why, { review, plugin: true });
  return done === "private" ? asIfMissing() : done;
}

/** A message reaching the page: only a running plugin's own frame gets any answer, and only that frame hears it. */
export function onPluginMessage(app, frames, e) {
  const p = frames.get(e.source);
  const m = e.data;
  if (!p || p.alive === false || !m || typeof m !== "object") return;
  if (m.type === "plugin-ready") p.start();
  else if (m.type === "plugin-error") p.error = String(m.text).slice(0, 300);
  else if (m.type === "plugin-call" && Number.isSafeInteger(m.id)) {
    const reply = (r) => { if (p.alive !== false) e.source.postMessage({ type: "plugin-reply", id: m.id, ...r }, "*"); };
    callPlugin(app, p, String(m.method), Array.isArray(m.args) ? m.args : []).then((value) => reply({ ok: true, value }), (err) => reply({ ok: false, error: String((err && err.message) || err) }));
  }
}

/** Starts and stops the frames; commands and the side panel are theirs while they run. */
export function mountPlugins(app) {
  const frames = new Map(); // frame window -> plugin
  const running = new Map(); // id -> plugin
  let rows = [];
  let failed = null;
  let shown = null;
  let held = false; // the last start did not get past the plugins: none starts until the user says (main.js)

  const pane = document.getElementById("plugin-pane");
  const paneName = h("span", { class: "plugin-pane-name" });
  const paneBody = h("div", { class: "plugin-pane-body", tabindex: "0", "aria-label": "Plugin panel. Press Enter to use it." });
  const paneHint = h("span", { class: "plugin-pane-hint", text: "Click the panel to use it" });
  // A frame, shown or not, can take the keyboard by itself, with what the user meant for a note or a password box, and
  // inert does not stop its own script (Edge and WebView2 156). What inert does is keep clicks and Tab out, so the app
  // knows when the user went there: a frame that has the focus while inert took it, and is turned off.
  let lastFocus = null;
  let watching = 0;
  const sleep = () => {
    paneHint.hidden = false;
    if (!shown) return;
    shown.iframe.inert = true;
    if (document.activeElement === shown.iframe) shown.iframe.blur();
  };
  const wake = () => { if (!shown) return; shown.iframe.inert = false; paneHint.hidden = true; shown.iframe.focus(); };
  // (kept quick: keys typed before it looks would reach the plugin; a hidden window gets no keys, so it rests then)
  function watch() {
    if (document.hidden) return;
    const a = document.activeElement;
    const p = a && a.inert && [...running.values()].find((x) => x.iframe === a);
    if (!p) return;
    const { row } = p;
    const back = lastFocus;
    stop(row.id);
    if (back) back.focus();
    app.toast(`The plugin ${row.name} took the keyboard without a click, so it was turned off`, { kind: "error", ms: 8000 });
    app.host.pluginDisable(row.id).catch(() => {}).then(refresh);
  }
  paneBody.addEventListener("click", wake); // an inert frame lets the click through to here
  paneBody.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === paneBody) wake(); });
  document.addEventListener("pointerdown", (e) => { if (!paneBody.contains(e.target)) sleep(); }, true);
  document.addEventListener("focusin", (e) => { if (!paneBody.contains(e.target)) { lastFocus = e.target; sleep(); } }, true);
  addEventListener("blur", () => setTimeout(watch));
  const hidePane = () => { sleep(); if (shown) shown.iframe.classList.remove("is-on"); shown = null; pane.hidden = true; };
  // frames stay where they are, in a pane that may be hidden: moving one would load it anew. The pane sits beside
  // the main view, never over it.
  pane.append(h("div", { class: "plugin-pane-head" }, icon("puzzle"), paneName, paneHint, h("button", { class: "icon-btn", title: "Close the panel", onclick: hidePane }, icon("x"))), paneBody);

  function stop(id) {
    const p = running.get(id);
    if (!p) return;
    p.alive = false;
    running.delete(id);
    if (shown === p) hidePane();
    for (const [w, x] of frames) if (x === p) frames.delete(w);
    p.iframe.remove();
    if (!running.size) { clearInterval(watching); watching = 0; }
    for (let i = app.commands.length - 1; i >= 0; i--) if (app.commands[i].plugin === id) app.commands.splice(i, 1);
  }

  function start(row) {
    // the name is how the app (lib.rs) knows this frame and keeps it from navigating anywhere
    const iframe = h("iframe", { class: "plugin-frame", sandbox: "allow-scripts", title: `Plugin: ${row.name}`, name: "leonote-plugin" });
    iframe.inert = true;
    iframe.style.colorScheme = isDark() ? "dark" : "light";
    iframe.srcdoc = frameDoc();
    const p = {
      row, iframe, alive: true, begun: false, error: null,
      async start() {
        if (p.begun) return;
        p.begun = true;
        try {
          const code = await app.host.pluginMain(row.id);
          if (p.alive) iframe.contentWindow.postMessage({ type: "plugin-run", code }, "*");
        } catch (e) { p.error = String(e); }
      },
      addCommand(id, name) {
        const full = `plugin:${row.id}:${id}`;
        if (app.commands.some((c) => c.id === full)) return;
        if (app.commands.filter((c) => c.plugin === row.id).length >= MAX_COMMANDS) throw new Error("A plugin may add 20 commands at most");
        app.commands.push({ id: full, plugin: row.id, name: `Plugin ${row.name}: ${name}`, icon: "puzzle", run: () => { if (p.alive) iframe.contentWindow.postMessage({ type: "plugin-command", id }, "*"); } });
      },
      showPanel() {
        if (shown && shown !== p) { sleep(); shown.iframe.classList.remove("is-on"); }
        shown = p;
        iframe.classList.add("is-on");
        paneName.textContent = `Plugin: ${row.name}`;
        pane.hidden = false;
      },
      hidePanel() { if (shown === p) hidePane(); },
    };
    running.set(row.id, p);
    // while any plugin runs: a blur is not heard when focus was in another frame
    if (!watching) watching = setInterval(watch, 200);
    paneBody.append(iframe);
    const add = () => { if (p.alive && iframe.contentWindow) frames.set(iframe.contentWindow, p); };
    add();
    iframe.addEventListener("load", add);
  }

  /** Reads the list again, and makes what runs match it: what is off stops at once. */
  async function refresh() {
    try { rows = await app.host.pluginList(); failed = null; } catch (e) { rows = []; failed = String(e); }
    for (const id of [...running.keys()]) if (!rows.some((r) => r.id === id && r.on && r.version === running.get(id).row.version)) stop(id);
    if (!held) for (const r of rows) if (r.on && !running.has(r.id)) start(r);
    return rows;
  }

  addEventListener("message", (e) => onPluginMessage(app, frames, e));
  return { refresh, stop, hold: (v) => { held = !!v; }, held: () => held, rows: () => rows, failed: () => failed, errorOf: (id) => (running.get(id) || {}).error || null };
}

/* ── Settings › Plugins ── */

/** What the Verified tag means, word for word as LIST-RULES.md says it. */
export const VERIFIED = "Verified: the list's maintainer read the code of this exact version and file for network use it does not declare, and nothing else. Not a security audit, and no guarantee.";

/** Where an installed plugin came from, said plainly. */
export function sourceWords(s) {
  if (!s) return "Found in the plugins folder, not installed through Leonote";
  return s.kind === "github" ? `From GitHub: ${s.repo}${s.verified ? " (a verified version)" : ""}` : `From a folder on this computer: ${s.path}`;
}
/** Is version a newer than version b? Numbers with dots. */
export function newer(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
/** A row of the opened search against what is installed. */
export function listState(entry, rows) {
  const have = rows.find((r) => r.id === entry.id && !r.bad);
  if (!have) return "install";
  // one by that id from another repo or a folder is not replaced by this one (plugins.rs finish)
  const same = have.source && have.source.kind === "github" && String(have.source.repo || "").toLowerCase() === String(entry.repo || "").toLowerCase();
  return !same ? "elsewhere" : newer(entry.version, have.version) ? "update" : "installed";
}

export function pluginsPanel(app) {
  const list = h("div", { class: "set-addons" });
  const found = h("div", { class: "set-addons" });
  let results = null;
  const fail = (e) => app.toast(String(e), { kind: "error", ms: 8000 });
  const again = async (id) => { if (id) app.plugins.stop(id); await app.plugins.refresh(); paint(); };
  const act = (run, id) => async () => { try { await run(); } catch (e) { fail(e); } await again(id); };

  // what a removed plugin proposed would stay in the review, from something no longer there
  async function dropProposals(row) {
    const mine = (await app.host.proposalsList().catch(() => [])).filter((p) => p.agent === pluginAgent(row));
    for (const p of mine) await app.host.proposalReject(p.id).catch(() => {});
    if (mine.length) app.toast(`${mine.length} edit${mine.length === 1 ? "" : "s"} it proposed dropped`, { ms: 3000 });
  }

  async function installListed(entry) {
    app.toast(`Downloading ${entry.name} from GitHub…`, { ms: 3000 });
    try {
      const id = await app.host.pluginInstallListed(entry.id);
      await again(id);
      // an update leaves a plugin that was off, off
      if (id) app.toast(app.plugins.rows().some((r) => r.id === id && r.on) ? `${entry.name} is on` : `${entry.name} is updated - still off`, { ms: 3000 });
    } catch (e) { fail(e); }
  }

  const tag = (text, cls = "", title) => h("span", { class: "plugin-tag " + cls, text, title });
  const words = (x) => (x.words && x.words.length ? h("ul", { class: "plugin-words" }, x.words.map((w) => h("li", { text: w }))) : h("div", { class: "plugin-sub", text: "Asks for nothing" }));

  function installedRow(x) {
    // offered only for the repo it came from: another one with the same id would be refused (plugins.rs finish)
    const update = results && !x.bad ? results.find((e) => e.id === x.id && newer(e.version, x.version) && x.source && x.source.kind === "github" && String(x.source.repo || "").toLowerCase() === String(e.repo || "").toLowerCase()) : null;
    const err = app.plugins.errorOf(x.id);
    return h("div", { class: "set-addon plugin-row" + (x.on ? "" : " is-off") },
      h("div", { class: "set-addon-text" },
        h("div", { class: "set-addon-name" }, h("span", { text: x.name }), x.version ? h("span", { class: "set-addon-ver", text: x.version }) : null, x.author ? h("span", { class: "set-addon-ver", text: `by ${x.author}` }) : null, tag(x.on ? ((app.plugins.held && app.plugins.held()) ? "Held off this start" : "On") : "Off")),
        x.description ? h("div", { class: "set-addon-desc", text: x.description }) : null,
        h("div", { class: "plugin-sub", text: sourceWords(x.source) }),
        x.bad ? h("div", { class: "plugin-sub is-warn", text: `It cannot run: ${x.bad}` }) : words(x),
        x.more && x.more.length ? h("div", { class: "plugin-sub is-warn", text: `Off because it now asks for more: ${x.more.join("; ")}` }) : null,
        err ? h("div", { class: "plugin-sub is-warn", text: `Last error: ${err}` }) : null),
      update ? h("button", { class: "btn btn-sm", title: "Downloads it from GitHub, then asks you", onclick: () => installListed(update) }, `Update available: ${update.version}`) : null,
      x.on ? h("button", { class: "btn btn-sm", onclick: act(() => app.host.pluginDisable(x.id), x.id) }, "Turn off")
        : x.known && !x.bad ? h("button", { class: "btn btn-sm", onclick: act(async () => { if (!(await app.host.pluginEnable(x.id))) app.toast(`${x.name} stays off`, { ms: 2500 }); }) }, x.more && x.more.length ? "Review and allow…" : "Turn on") : null,
      // its folder is deleted from this computer: asked first (Turn off keeps it)
      h("button", { class: "btn btn-sm", onclick: async () => { const { confirmDialog } = await import("./ui.js"); if (await confirmDialog(`Remove ${x.name}?`, "Its folder is deleted from this computer, and the edits it proposed and you have not looked at go with it. Turn off keeps it instead.", { ok: "Remove" })) act(async () => { await app.host.pluginRemove(x.id); await dropProposals(x); }, x.id)(); } }, "Remove"));
  }

  function foundRow(e) {
    const state = listState(e, app.plugins.rows());
    return h("div", { class: "set-addon plugin-row" },
      h("div", { class: "set-addon-text" },
        h("div", { class: "set-addon-name" }, h("span", { text: e.name }), h("span", { class: "set-addon-ver", text: e.version }), h("span", { class: "set-addon-ver", text: `by ${e.author}` }),
          tag(e.verified ? "Verified" : "Not verified", e.verified ? "is-good" : "", e.verified ? VERIFIED : "Nobody looked at this version for the list"), h("span", { class: "set-addon-ver", text: `${e.stars} GitHub ${e.stars === 1 ? "star" : "stars"}${e.updated ? ` as of ${e.updated}` : ""}` })),
        h("div", { class: "set-addon-desc", text: e.description }),
        words(e)),
      h("button", { class: "btn btn-sm", title: "Opens the list's issue page on GitHub", onclick: () => app.host.openUrl(e.report).catch(fail) }, "Report"),
      state === "installed" ? h("span", { class: "plugin-sub", text: "Installed" })
        : state === "elsewhere" ? h("span", { class: "plugin-sub", text: "One by this name is installed from elsewhere - remove it first" })
        : h("button", { class: "btn btn-sm btn-primary", title: "Downloads it from GitHub, then asks you", onclick: () => installListed(e) }, state === "update" ? "Update" : "Install"));
  }

  const foundList = h("div");
  const filter = h("input", { class: "text-input is-wide", placeholder: "Filter by name, author or what it does", spellcheck: "false", oninput: () => paintFound(), onkeydown: (e) => e.stopPropagation() });
  function paintFound() {
    if (!results) return;
    const q = filter.value.trim().toLowerCase();
    const shown = results.filter((e) => !q || `${e.name} ${e.author} ${e.description}`.toLowerCase().includes(q));
    // the box stays where it is while typing: taking it out and back in loses the cursor after one letter
    if (filter.parentNode !== found) found.replaceChildren(filter, foundList);
    foundList.replaceChildren(...shown.map(foundRow), ...(shown.length ? [] : [h("div", { class: "set-note", text: results.length ? "Nothing matches." : "The list is empty." })]), h("div", { class: "set-note", text: "Free plugins by other people, on GitHub. Verified applies to that exact version and file only, and is no guarantee." }));
  }

  /** The search, on the click that opens it: this and only this loads the public list. */
  async function openSearch() {
    found.replaceChildren(h("div", { class: "set-note", text: "Loading the list from GitHub…" }));
    try { results = await app.host.pluginSearch(); }
    catch { results = null; found.replaceChildren(h("div", { class: "set-note", text: "The plugin list could not be loaded. You may be offline, or the list may not be up yet. You can still install from a folder." })); return; }
    paint();
  }

  function paint() {
    const rows = app.plugins.rows();
    const failed = app.plugins.failed();
    const held = (app.plugins.held && app.plugins.held()) && rows.some((r) => r.on)
      ? h("div", { class: "set-note" }, "Held off this start: the last one did not get past the plugins. Turn off the one at fault, then ",
          h("button", { class: "btn btn-sm", onclick: async () => { app.startPlugins(); paint(); } }, "start the rest"))
      : null;
    list.replaceChildren(...(held ? [held] : []), ...rows.map(installedRow), ...(failed ? [h("div", { class: "set-note", text: failed })] : rows.length ? [] : [h("div", { class: "set-note", text: "No plugins yet." })]));
    paintFound();
  }
  app.plugins.refresh().then(paint);

  return h("div", { class: "plugin-panel" },
    h("div", { class: "plugin-actions" },
      h("button", { class: "btn", title: "Loads one public list from GitHub", onclick: openSearch }, icon("search"), "Search plugins"),
      h("button", { class: "btn", onclick: async () => { try { const id = await app.host.pluginInstallFolder(); if (id) await again(id); } catch (e) { fail(e); } } }, icon("folder"), "Install from a folder…")),
    list, found);
}
