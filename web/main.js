// Leonote. Boot, tabs, commands, keys, and the wiring between the stores
// (vault, tasks, habits) and the views. The window stays hidden until the
// first frame is painted, so there is never a loading screen to look at.

import { host } from "./host.js";
import { h, $, debounce, dayKey, addDays, parseDay, basename, dirname, joinPath, safeName, isTyping, emitter, relTime, clamp, resolveMotion, motionOk, motionFull } from "./util.js";
import { undo as cmUndo } from "@codemirror/commands";
import { mountSpaces } from "./spaces.js";
import * as TG from "./tabgroups.js";
import { mountFileView, KIND_ICON } from "./fileview.js";
import { mountExtView, osName, osDir } from "./extview.js";
import { outpostList } from "./outposts.js";
import { icon } from "./icons.js";
import { createVault, notUtf8 } from "./vault.js";
import { pickWriter } from "./savepick.js";
import { createTaskStore } from "./taskstore.js";
import { createEditor } from "./editor.js";
import { mountSidebar } from "./sidebar.js";
import { mountRightPanel } from "./rightpanel.js";
import { mountTasks } from "./tasksview.js";
import { mountHome, trackUsage } from "./home.js";
import { mountHabits } from "./habits.js";
import { mountSettings, migrateSettings, DEFAULTS, MEDIA_DIRS, ACCENTS, resolveHeadingStyle, resolveHeadingSize } from "./settings.js";
import { HL_COLORS, setOwnPictureRoots } from "./mdparse.js";
import { expandTemplate, templatesIn } from "./templates.js";
import { mountSplit } from "./split.js";
import { mountAutoscroll } from "./autoscroll.js";
import { playSound } from "./uisound.js";
import { openNewTab, pickFolder, folderChoices } from "./newtab.js";
import { mountBackupPlans } from "./backupplans.js";
import { createMedia } from "./media.js";
import { createStats, XP, rankOf } from "./stats.js";
import { createPomodoro, mountTimer } from "./focus.js";
import { createAreas, mountAreas } from "./areas.js";
import { createJev } from "./jev.js";
import { mountProposals } from "./proposals.js";
import { mountPlugins } from "./plugins.js";
import { deleteAction } from "./imagepick.js";
import { mountDeskBreaks } from "./deskbreak.js";
import { createSkills } from "./skills.js";
import { createRecurring } from "./recurview.js";
import { mountCalendar } from "./calendarview.js";
import { voiceButton } from "./voice.js";
import { createGcal } from "./gcal.js";
import { openPalette, closePalette } from "./palette.js";
import { toast, menu, closeMenu, confirmDialog, askDialog, cornerCard } from "./ui.js";
import { frontMatter } from "./frontmatter.js";
import { mountTrash } from "./trash.js";
import { mountNoteIds } from "./noteids.js";
import { setPictureStore, shownPics } from "./livepreview.js";
import { mountWebTab, tabTitle } from "./webtab.js";
import { customizeTab, tabLookOf, customizeGroup, groupLookOf } from "./tabstyle.js";
import { compressImage, attachmentDir, imageName, imagesIn, openViewer, withoutHeldPictures, setEmbedWidth, setEmbedSide, copyImageUrl, embedWidth } from "./images.js";
import { shareMenuItems } from "./imageshare.js";
import { fmtSize } from "./fileview.js";
import { supportCommands, diagnostics, maybeAskSupport } from "./support.js";
import { createZettel } from "./zettelui.js";
import { startYtSync } from "./ytsync.js";
import { createYtPush } from "./ytpush.js";
import { findProjects, makeProject, pickWorkspaceFolder, workspaceSpace, workspaceSpaceIds } from "./projects.js";
import { faviconOf, keepFavicon } from "./favicons.js";

const T0 = performance.now();

async function start() {
  await host.load();
  host.trace(`script running ${T0.toFixed(0)} ms after page start`);

  /* ── events are registered BEFORE boot: the background import/compaction
        can emit a patch the moment boot returns ────────────────────────── */
  const queue = [];
  let handlers = null;
  const route = (name) => (payload) => (handlers ? handlers[name](payload) : queue.push([name, payload]));
  await Promise.all(["vault:changed", "vault:folders", "vault:files", "tasks:patch", "habits:changed", "app:capture", "app:pomo", "app:command", "app:open-external", "tabweb:key", "tabweb:focus", "extpop:zoom", "extpop:resize", "tabweb:video", "tabweb:fullscreen", "backup:progress", "app:open-youtube", "player:menu", "pw:offer"].map((ev) => host.on(ev, route(ev))));

  let boot;
  try {
    boot = await host.boot();
  } catch (err) {
    const missing = /^vault-missing:(.*)$/s.exec(String(err));
    const pick = (create) => host.vaultMissing(create).then(() => host.restart(), (e) => alert(String(e)));
    document.body.replaceChildren(missing
      ? h("div", { class: "fatal" }, h("h1", { text: "The vault folder is not there" }), h("pre", { text: missing[1] }),
          h("p", { text: "A drive that is not plugged in, or a folder renamed or moved? Nothing was made in its place." }),
          h("p", {}, h("button", { class: "btn btn-primary", onclick: () => host.restart() }, "Try again"), " ",
            h("button", { class: "btn", onclick: () => pick(true) }, "Make an empty vault there"), " ",
            h("button", { class: "btn", onclick: () => pick(false) }, "Use the default vault")))
      : h("div", { class: "fatal" }, h("h1", { text: "Leonote could not start" }), h("pre", { text: String(err) })));
    host.win.show();
    return;
  }

  const PLUGINS_STARTING = "leonote.plugins-starting";
  /** The vault's Welcome.md is Leonote's own (Obsidian makes one by that name too). */
  const ownWelcome = () => /^# Welcome to Leonote/.test((app.vault.get("Welcome.md") || {}).content || "");
  const app = {
    host,
    packaged: !!boot.packaged, // the Microsoft Store (MSIX) build: a few choices show differently there
    device: String(boot.device || ""), // this computer's name (backup plans on a vault synced to several)
    bus: emitter(),
    vault: createVault(host),
    tasks: createTaskStore(host, {
      // Jev (Settings › Jev) gives a new task the priority and focus area you left out, when it is sure
      created: (t) => { app.stats.bump("tasks_created"); app.stats.award(XP.taskCreated, "taskCreated"); if (app.jev) app.jev.sortTask(t); },
      toggled: (t, done) => app.onTaskToggled(t, done),
      subtasks: (delta) => app.stats.award(delta * XP.subtaskDone, "subtaskDone", Math.abs(delta)),
      // a write that would empty a task or drop its steps: it happens, but
      // never quietly
      risky: (r) => toast(r.text, { ms: 9000, kind: "error", action: { label: "Undo", run: r.restore } }),
    }),
    settings: { ...DEFAULTS, ...(boot.settings || {}) },
    defaultSettings: DEFAULTS,
    errors: [], // the last page errors, for Copy diagnostics
    habits: boot.habits,
    activity: [],
    bootMs: 0,
    cursorLine: 0,
    toast,
    menu,
    isTyping,
    views: [
      { id: "home", name: "Home", icon: "home" },
      { id: "tasks", name: "Tasks", icon: "checkSquare" },
      { id: "habits", name: "Habits", icon: "flame" },
      { id: "calendar", name: "Calendar", icon: "calendar" },
      { id: "fit", name: "Workout", icon: "dumbbell" },
      { id: "focus", name: "Focus", icon: "focus" },
      { id: "timer", name: "Timer", icon: "clock" },
      { id: "graph", name: "Graph", icon: "graph" },
      { id: "music", name: "Player", icon: "music" },
      { id: "search", name: "Search", icon: "search" },
      { id: "docs", name: "Docs", icon: "clipboard" },
      { id: "phone", name: "Phone", icon: "phone" },
      { id: "space", name: "Disk space", icon: "chart" },
      { id: "web", name: "Web pages (old)", icon: "globe" },
      { id: "assistant", name: "Assistant", icon: "sparkles" },
      { id: "room", name: "Workspace room", icon: "briefcase" },
      { id: "project", name: "Code project", icon: "code" },
      { id: "settings", name: "Settings", icon: "settings" },
    ],
  };

  // One-time moves to newer defaults. Settings files store every value, so a
  // new default only reaches existing installs this way - and only where the
  // old default value is still in place (which may hide a deliberate pick).
  {
    const S0 = app.settings;
    const done = new Set((boot.settings && boot.settings.migrations) || []);
    if (!done.has("diary-1")) {
      if (S0.dailyFolder === "Daily") S0.dailyFolder = "Diary";
      if (S0.yearlyPath === "Daily/{YYYY}.md") S0.yearlyPath = "Diary/{YYYY}.md";
      if (S0.dailyMode === "daily") S0.dailyMode = "yearly";
      if (!(S0.folderStyles || {}).Diary) S0.folderStyles = { ...(S0.folderStyles || {}), Diary: { dim: true, size: "xs" } };
      S0.migrations = [...done, "diary-1"];
      host.saveSettings(S0).catch(() => {});
    }
  }
  window.leonote = app; // handy from devtools

  app.stats = createStats(host, boot.stats || {});
  // the clock ticking came on with the Python app's setting for some: off is the default now, once
  // (remembered on this computer, as the stats are shared by every vault: kept in a vault's settings, a new vault turned
  // it off again; not in the stats file either, which the Python app writes too and may drop a key it does not know)
  const tickDone = () => { try { return localStorage.getItem("leonote.tick-off-1") === "1"; } catch { return false; } };
  if ((app.settings.migrations || []).includes("tick-off-1") || tickDone()) {
    try { localStorage.setItem("leonote.tick-off-1", "1"); } catch {}
  } else {
    if (app.stats.data.pomo_tick_enabled) { app.stats.data.pomo_tick_enabled = false; host.saveStats(app.stats.data).catch(() => {}); }
    app.settings.migrations = [...(app.settings.migrations || []), "tick-off-1"];
    try { localStorage.setItem("leonote.tick-off-1", "1"); } catch {}
  }
  app.media = createMedia(app);
  app.pomo = createPomodoro(app);
  app.deskBreaks = mountDeskBreaks(app);
  mountBackupPlans(app);
  app.areas = createAreas(app, boot.priorities);
  app.jev = createJev(app);
  // notes that do things (skills.js): run by hand, at a time of day, or when a note arrives
  app.skills = createSkills(app);
  // tasks are already loaded, so catch-up sees existing spawns; created before
  // any view mounts so a restored Habits tab gets its recurring list
  app.recurring = createRecurring(app, boot.recurring);
  // Google Calendar: the events shown in the Calendar view, and tasks pushed there (Settings › Calendar)
  app.gcal = createGcal(app);
  // gentle interface sounds (Settings > Sounds)
  app.sound = (name) => { if (app.settings.uiSounds !== false) playSound(name, (Number(app.settings.uiSoundVolume) || 0) / 100); };
  app.openLevels = () => import("./levels.js").then((m) => m.openLevels(app));
  // the messages about levels, challenges and the streak: off unless Settings › Notices turns them on
  const gameSays = () => app.settings.gameNotices === true;
  app.stats.bus.on("levelup", (lvl, was) => {
    if (!gameSays()) return;
    app.sound("level");
    const r = rankOf(lvl), r0 = rankOf(was ?? lvl - 1);
    // a new rank (or tier) is the bigger news
    if (r.name !== r0.name) toast(`${r.rank !== r0.rank ? "New rank" : "Up a tier"}: ${r.name} · level ${lvl}`, { kind: "agent", ms: 7000, action: { label: "See", run: () => app.openLevels() } });
    else toast(`Level ${lvl} reached · ${r.name}`, { kind: "agent", ms: 5000, action: { label: "Levels", run: () => app.openLevels() } });
  });
  app.stats.bus.on("challenge", (c) => gameSays() && toast(c.all ? `All of today's challenges done · +${c.reward} and +50 XP` : `Challenge done: ${c.text} · +${c.reward} XP`, { ms: 3200 }));
  app.stats.bus.on("daybonus", ({ bonus, streak }) => gameSays() && toast(streak > 1 ? `${streak} days in a row · +${bonus} XP for showing up` : `First XP today · +${bonus}`, { ms: 3200 }));
  app.onTaskToggled = (t, done) => {
    app.sound(done ? "done" : "undone");
    app.stats.bump("tasks_done", done ? 1 : -1);
    app.stats.award(done ? XP.taskDone : -XP.taskDone, "taskDone");
    if (app.recurring) app.recurring.taskToggled(t, done);
  };

  app.vault.load(boot);
  host.setVaultAbs(boot.vault_abs || boot.vault);
  app.dataDir = boot.data_dir || "user"; // where tasks, habits and stats live
  app.dataRoot = boot.data_root || "";
  app.settingsPath = boot.settings_path || "";
  app.positions = boot.positions && typeof boot.positions === "object" ? boot.positions : {};
  app.tasks.load(boot.tasks || []);
  // a change is shown before it is saved: one that could not be saved must say so, or it is lost at the next start
  app.tasks.bus.on("error", (e) => toast("A task change was not saved: " + ((e && e.message) || e), { kind: "error", ms: 8000 }));
  // lines in the task logs that could not be read: kept aside, and the logs are not tidied while they are there
  if (boot.tasks_bad) toast(`${boot.tasks_bad} line${boot.tasks_bad === 1 ? "" : "s"} in the task logs could not be read (a copy is in quarantine.jsonl). While they stay in their log, the task logs are not tidied up`, { kind: "error", ms: 15000 });
  // a save that replaced words written outside Leonote it had not seen yet (an agent, a sync, another app, landing as
  // it saved): kept in the note's versions, and said
  host.on("note:overwrote", (p) => {
    if (!p || !p.path) return;
    toast(`“${basename(p.path)}” was changed outside Leonote just as you saved - your version is kept, the other is in its versions`, { ms: 12000, action: { label: "See versions", run: () => app.openVersions(p.path) } });
  });
  // text that could not be saved last time (Leonote closed, crashed or Windows shut down meanwhile): offered back
  setTimeout(() => host.rescueList().then((list) => {
    for (const r of list || []) {
      const n = app.vault.get(r.path);
      // no longer kept: the same as the note now, a note saved since (a save that got through after all, a new note by
      // that name), a file from outside the vault, or offered for two weeks and let be
      if ((n && n.content === r.content) || String(r.path).startsWith("@guest/") || Date.now() - (Number(r.at) || 0) > 14 * 864e5) { host.rescueDrop(r.path).catch(() => {}); continue; }
      // the note was saved since (by a save that got through, a sync, a new note by the name): it is not put over it -
      // the words go beside it as a note of their own
      if (n && (n.mtime || 0) > (Number(r.at) || 0)) {
        const copy = r.path.replace(/\.md$/i, "") + ` (unsaved ${new Date(Number(r.at) || Date.now()).toLocaleDateString()}).md`.replace(/\//g, "-");
        toast(`Words typed in “${basename(r.path)}” that could not be saved were kept; the note has changed since`, { ms: 30000, action: { label: "Keep them as a note beside it", run: () => app.vault.write(copy, r.content).then(() => { host.rescueDrop(r.path).catch(() => {}); app.openNote(copy); }, (e) => toast("Could not keep them: " + e, { kind: "error" })) } });
        continue;
      }
      toast(`Text of “${basename(r.path)}” that could not be saved last time was kept (offered for two weeks)`, { ms: 30000, action: { label: "Put it back", run: () => app.vault.write(r.path, r.content, { expected: true }).then(() => { host.rescueDrop(r.path).catch(() => {}); app.openNote(r.path); }, (e) => toast("Could not put it back: " + e, { kind: "error" })) } });
    }
  }, () => {}), 2500);
  // once per computer: the Welcome note promises it, and nothing else would say why it does nothing
  if (boot.capture_key_taken) { let said = false; try { said = !!localStorage.getItem("leonote.capture-taken"); localStorage.setItem("leonote.capture-taken", "1"); } catch {} if (!said) toast("Ctrl+Alt+N is taken by another app, so quick capture from anywhere in Windows is off. Inside Leonote, Ctrl+Shift+Space still captures.", { ms: 12000 }); }
  if (boot.watch_failed) toast(`Leonote cannot watch the vault folder, so changes made outside it (agents, other apps, sync) show only after a restart: ${boot.watch_failed}`, { kind: "error", ms: 15000 });
  if (boot.tasks_conflict) toast(`Task log has git conflict markers - tasks are read-only until resolved: ${boot.tasks_conflict}`, { kind: "error", ms: 20000 });
  // the task file is damaged or the list came up empty: nothing is compacted over it, and the newest history copy is offered back
  if (boot.tasks_warning) {
    const w = boot.tasks_warning;
    const when = w.stamp ? String(w.stamp).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2}).*$/, "$1-$2-$3 $4:$5") : "";
    toast(`${w.reason}. ${w.count ? `The last copy from ${when} holds ${w.count} tasks.` : w.history_unreadable ? "The history folder could not be read." : "No history copy holds tasks."} Nothing is written over the file until this is sorted.`,
      { kind: "error", ms: 120000, action: w.file && w.count ? { label: `Restore ${w.count}`, run: () => host.tasksRestore(w.file).then((n) => toast(`${n} tasks are back`, { ms: 4000 })).catch((e) => toast(String(e), { kind: "error" })) } : null });
  }

  /* ── settings ─────────────────────────────────────────────────────────── */
  // the online library (thousands of videos) goes along only when it changed - it has a file of its own
  let savedOnline = app.settings.youtubeLibrary;
  const saveSettings = debounce(() => {
    const s = app.settings;
    let out = s;
    if (s.youtubeLibrary === savedOnline) { const { youtubeLibrary, ...rest } = s; void youtubeLibrary; out = rest; }
    else savedOnline = s.youtubeLibrary;
    host.saveSettings(out).catch((e) => console.warn("settings", e));
  }, 500);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // Animations. The stored value may be "auto" (nobody has chosen), in which
  // case the system's reduce-motion preference decides - and keeps deciding
  // until someone picks a value in Settings.
  const lessMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  lessMotion.addEventListener("change", () => applySetting("motion"));

  function applySetting(k) {
    const S = app.settings;
    const root = document.documentElement;
    switch (k) {
      case "uiScale": case "uiScaleCompact": if (typeof applyZoom === "function") applyZoom(false); break;
      case "theme": root.dataset.theme = S.theme === "system" ? (media.matches ? "dark" : "light") : S.theme; break;
      case "motion": root.dataset.motion = resolveMotion(S.motion, lessMotion.matches); break;
      case "accent": root.style.setProperty("--accent", ACCENTS[S.accent] || ACCENTS.amber); break;
      case "fontSize": root.style.setProperty("--editor-size", clamp(S.fontSize, 12, 24) + "px"); break;
      case "lineWidth": root.style.setProperty("--line-width", { narrow: "620px", normal: "740px", wide: "960px", full: "100%" }[S.lineWidth] || "740px"); break;
      case "editorFont": root.dataset.font = S.editorFont; break;
      case "headingStyle": root.dataset.headings = resolveHeadingStyle(S.headingStyle); break;
      case "headingSize": root.dataset.headingSize = resolveHeadingSize(S.headingSize); break;
      case "highlightStyle": root.dataset.highlight = S.highlightStyle === "flat" ? "flat" : "marker"; break;
      case "sidebarWidth": root.style.setProperty("--sidebar-w", clamp(S.sidebarWidth, 190, 440) + "px"); break;
      case "rightPanelWidth": root.style.setProperty("--right-w", clamp(Number(S.rightPanelWidth) || 276, 220, 560) + "px"); break;
      case "sidebar": $("#app").classList.toggle("no-sidebar", !S.sidebar); break;
      case "tabGap": root.style.setProperty("--tab-gap", clamp(Number.isFinite(Number(S.tabGap)) ? Number(S.tabGap) : 3, 0, 16) + "px"); break;
      case "activeTabColor": if (/^#[0-9a-f]{6}$/i.test(S.activeTabColor || "")) root.style.setProperty("--tab-active", S.activeTabColor); else root.style.removeProperty("--tab-active"); break;
      case "tabMinWidth": root.style.setProperty("--tab-min", clamp(Number(S.tabMinWidth) || 90, 24, 240) + "px"); break;
      case "imageInvertDark": $("#app").classList.toggle("invert-images", !!S.imageInvertDark); break;
      case "imageLayout": paintLayout(); break;
      case "treeFontSize": root.style.setProperty("--tree-fs", clamp(Number(S.treeFontSize) || 13.5, 10, 20) + "px"); break;
      case "treeRowHeight": root.style.setProperty("--tree-row-h", (Number(S.treeRowHeight) || { compact: 23, snug: 25.5, cozy: 28, roomy: 33 }[S.treeRowHeight] || 28) + "px"); break;
      case "treeFolderWeight": root.style.setProperty("--tree-folder-w", String({ normal: 400, medium: 500, bold: 650 }[S.treeFolderWeight] || 500)); break;
      case "showAllFiles": if (typeof sidebar !== "undefined" && sidebar) sidebar.renderTree(); break;
      case "rightPanel":
        $("#rightpanel").hidden = !S.rightPanel;
        if ($("#rp-resizer")) $("#rp-resizer").hidden = !S.rightPanel;
        if (S.rightPanel) playOnce($("#rightpanel"));
        app.bus.emit("rightpanel");
        break;
      case "livePreview": for (const ed of [editor, ...(app.split ? app.split.editors : [])]) if (ed) ed.setLivePreview(S.livePreview); break;
      case "floatContain": document.body.classList.toggle("float-contain", !!S.floatContain); break;
      case "codeLineNumbers": document.body.classList.toggle("no-code-numbers", S.codeLineNumbers === false); break;
      case "spellcheck": for (const ed of [editor, ...(app.split ? app.split.editors : [])]) if (ed) ed.setSpellcheck(S.spellcheck); break;
      case "noteYtPreviews":
      case "linkPreviews": case "videoLinksPlay": case "webPictures": for (const ed of [editor, ...(app.split ? app.split.editors : [])]) if (ed) ed.refresh(); break;
      case "launchAtLogin":
        host.setAutostart(!!S.launchAtLogin)
          .then((on) => { if (on !== !!S.launchAtLogin) { S.launchAtLogin = on; app.bus.emit("settings", k); } })
          .catch((e) => toast("Could not change launch at login: " + e, { kind: "error" }));
        break;
    }
  }
  media.addEventListener("change", () => { if (app.settings.theme === "system") applySetting("theme"); });

  // Pasted pictures used to be squeezed to 35% by default, which shows. The
  // default is 80% now; a quality the user chose themselves is left alone.
  if (!(app.settings.migrations || []).includes("imgq-80")) {
    if (!app.settings.imageQuality || app.settings.imageQuality === 35) app.settings.imageQuality = 80;
    app.settings.migrations = [...(app.settings.migrations || []), "imgq-80"];
  }
  // Two earlier builds had other homes for quickly made things (Inbox, Drafts),
  // and those defaults were saved with the rest: they are not choices anyone
  // made, so they give way to the Workplace folder. A place set by hand stays.
  if (!(app.settings.migrations || []).includes("workplace-1")) {
    const old = { quickNoteDir: ["Inbox", "Drafts/Notes"], quickSketchDir: ["Inbox/Sketches", "Drafts/Sketches"], quickBoardDir: ["Drafts/Boards"], boardsFolder: ["Boards"] };
    for (const k in old) if (old[k].includes(app.settings[k])) app.settings[k] = "";
    app.settings.migrations = [...(app.settings.migrations || []), "workplace-1"];
  }
  // An older hidden setting for where boards go won over the visible "…boards go in" row: a place set there by hand
  // moves into that row, once, and the old one goes
  if (!(app.settings.migrations || []).includes("boards-folder-1")) {
    if (app.settings.boardsFolder && !app.settings.quickBoardDir) app.settings.quickBoardDir = app.settings.boardsFolder;
    app.settings.boardsFolder = "";
    app.settings.migrations = [...(app.settings.migrations || []), "boards-folder-1"];
  }
  // Media gets one home with a folder per kind. Only where nothing was chosen.
  if (!(app.settings.migrations || []).includes("media-folders-2")) {
    for (const k in MEDIA_DIRS) if (app.settings[k] === MEDIA_DIRS[k]) app.settings[k] = "";
    app.settings.migrations = [...(app.settings.migrations || []), "media-folders-2"];
  }
  // The Web pages view is retired: its shortcuts become a bookmark group on the
  // start page, and "in its own window" is a bookmark's right-click action now.
  if (!(app.settings.migrations || []).includes("web-pages-1")) {
    const S0 = app.settings;
    const old = Array.isArray(S0.webShortcuts) ? S0.webShortcuts.filter((x) => x && x.url) : [];
    if (old.length) {
      const have = new Set((S0.webBookmarks || []).map((b) => b.url));
      S0.webGroups = [...(S0.webGroups || []), { id: "g-webpages", name: "Web pages", color: "teal" }];
      S0.webBookmarks = [...(S0.webBookmarks || []), ...old.filter((x) => !have.has(x.url)).map((x) => ({ url: x.url, title: x.name || "", group: "g-webpages" }))];
    }
    S0.migrations = [...(S0.migrations || []), "web-pages-1"];
  }
  // two image tools on the start page: Squoosh (compress, in the browser) and NukeBG (backgrounds off, nothing uploaded)
  if (!(app.settings.migrations || []).includes("web-tools-1")) {
    const S0 = app.settings;
    const have = new Set((S0.webBookmarks || []).map((b) => b.url));
    S0.webBookmarks = [...(S0.webBookmarks || []), ...[["https://squoosh.app/", "Squoosh - compress images"], ["https://nukebg.app/", "NukeBG - remove backgrounds"]]
      .filter(([u]) => !have.has(u)).map(([url, title]) => ({ url, title }))];
    S0.migrations = [...(S0.migrations || []), "web-tools-1"];
  }
  if (!(app.settings.migrations || []).includes("image-side-1")) {
    if (app.settings.imagePasteSide === "right") app.settings.imagePasteSide = "left"; // build 90's default, not a choice
    app.settings.migrations = [...(app.settings.migrations || []), "image-side-1"];
  }
  /** A media folder: yours if you named one, Leonote's own otherwise. */
  app.mediaDir = (key) => app.settings[key] || MEDIA_DIRS[key];
  app.setSetting = (k, v) => {
    app.settings[k] = v;
    applySetting(k);
    app.bus.emit("settings", k);
    saveSettings();
  };
  let editor = null;
  for (const k of ["theme", "motion", "accent", "fontSize", "lineWidth", "editorFont", "headingStyle", "headingSize", "sidebarWidth", "sidebar", "rightPanel", "tabMinWidth", "tabGap", "activeTabColor", "treeFontSize", "treeRowHeight", "treeFolderWeight", "imageInvertDark"]) applySetting(k);

  // remembered caret + scroll per note, like Obsidian's remember-cursor-position
  const savePositions = debounce(() => host.savePositions(app.positions).catch(() => {}), 1500);
  function rememberPos(p, pos) {
    if (!p || !pos) return;
    delete app.positions[p];
    app.positions[p] = { anchor: pos.anchor, head: pos.head, scroll: Math.round(pos.scroll || 0), top: pos.top || 0, off: pos.off || 0, at: Date.now() };
    // the 1500 most recently visited notes: years of use for a few dozen KB
    const keys = Object.keys(app.positions);
    if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete app.positions[k];
    savePositions();
  }

  /* ── editor ───────────────────────────────────────────────────────────── */
  const dirty = new Set();
  // note path -> the editor that last typed into it. Per path, not one
  // global winner: two panes can hold two different notes at once.
  const lastTyped = new Map();
  const roomEds = new Set(), roomFiles = new Set(); // the editors and file views of the Workspace room's windows (app.mountDoc)
  let split = null;
  let noteOpts = null;
  app.vault.bus.on("structure", () => { noteOpts = null; });
  app.vault.bus.on("renamed", () => { noteOpts = null; });

  const cursorEmit = (() => {
    let raf = 0;
    return () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; app.bus.emit("cursor", app.cursorLine); }); };
  })();

  // What a note editor needs; `ed()` is that editor (the main one or the split's).
  const noteEditorOptions = (ed, scroller, own) => ({
    // note ids on: the header's id (and tags, kept in the Tags panel) out of the way
    hideMeta: () => app.settings.noteIds !== false,
    // right-click › Link to a note…: the note found by name, its link written at the caret
    pickLink: (put) => app.pickNote({ title: "Link to…", places: true, onPick: async (p, at) => put(await app.linkTo(p, at)) }),
    scroller,
    livePreview: app.settings.livePreview,
    spellcheck: app.settings.spellcheck,
    formatBar: () => app.settings.formatBar !== false,
    onChange: (p, undo, cut) => { lastTyped.set(p, ed()); dirty.add(p); setSaveState(); saveSoon(); if (undo || cut !== false) pasteUndoWatch(p, ed(), undo); },
    isDirty: (p) => dirty.has(p),
    noteOptions: () => noteOpts || (noteOpts = [...app.vault.notes.values()].map((n) => ({ title: n.title, folder: n.folder, link: app.vault.linkText(n.path) }))),
    tagOptions: () => [...app.vault.tagCounts().entries()].sort((a, b) => b[1] - a[1]),
    resolve: (t) => app.vault.resolve(t, ed().path),
    resolveUnindexed: (t) => app.vault.unindexedFor(t),
    openLink: (target, newTab, place) => openLink(target, newTab, ed().path, place),
    openUrl: (url) => app.followLink(url),
    linkCards: () => !!app.settings.linkPreviews,
    // a video's link alone on its line plays right there (on unless switched off in a link's menu)
    videoLinks: () => app.settings.videoLinksPlay !== false,
    ytPreviews: () => app.settings.noteYtPreviews !== false,
    webPictures: () => app.settings.webPictures === "always",
    linkTitle: (url) => (app.settings.linkAutoTitle === false ? Promise.resolve("") : host.linkPreview(url).then((d) => (d && d.title) || "")),
    linkPreview: (url) => host.linkPreview(url),
    linkPicture: (url) => host.linkPicture(url),
    codeMenu: (x, y, { lang, code, setLang }) => menu(x, y, [
      { header: lang ? `Code · ${lang}` : "Code", plain: true },
      { label: "Copy the code", icon: "clipboard", run: () => navigator.clipboard.writeText(code).then(() => toast("Code copied", { ms: 1400 })) },
      { label: "Line numbers", icon: "list", checked: app.settings.codeLineNumbers !== false, run: () => app.setSetting("codeLineNumbers", app.settings.codeLineNumbers === false) },
      { label: "Language", icon: "code", sub: [...["", "js", "ts", "python", "rust", "json", "yaml", "html", "css", "sql", "bash", "java", "go", "c", "cpp", "markdown"].map((l) => ({ label: l || "None (plain)", checked: (lang || "") === l, run: () => setLang(l) })),
        "sep", { label: "Another…", icon: "edit", run: () => askDialog("Language of the code", [{ key: "v", label: "Name", value: lang || "", placeholder: "kotlin, lua, php…" }], { ok: "Set" }).then((r) => r && setLang(r.v.trim().toLowerCase())) }] },
    ]),
    linkMenu: (url, x, y, span) => menu(x, y, [
      { header: url.length > 60 ? url.slice(0, 57) + "…" : url, plain: true },
      span && span.title == null ? { label: "Show the page's title instead", icon: "heading", run: () => host.linkPreview(span.url).then((d) => {
        const t = String((d && d.title) || "").trim().replace(/[\[\]]/g, "");
        if (!t) return toast("The page gave no title", { ms: 2200 });
        const md = `[${t}](${span.url})`;
        span.view.dispatch({ changes: { from: span.from, to: span.to, insert: md }, userEvent: "input" });
      }).catch((e) => toast(String(e), { kind: "error" })) } : null,
      span && span.title != null ? { label: "Show the bare address instead", icon: "link", run: () => span.view.dispatch({ changes: { from: span.from, to: span.to, insert: span.url }, userEvent: "input" }) } : null,
      span ? "sep" : null,
      { label: "Open in a Leonote tab", icon: "globe", run: () => app.newWebTab(/^www\./i.test(url) ? "https://" + url : url) },
      { label: "Open in its own Leonote window", icon: "layers", run: () => host.webOpen({ id: "l" + Math.abs([...url].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36), url: /^www\./i.test(url) ? "https://" + url : url }).catch((e) => toast(String(e), { kind: "error" })) },
      { label: "Open in your browser", icon: "outside", run: () => app.openUrl(/^www\./i.test(url) ? "https://" + url : url) },
      "sep",
      { label: "Copy the address", icon: "link", run: () => navigator.clipboard.writeText(url).then(() => toast("Address copied", { ms: 1600 })) },
      "sep",
      { el: (() => {
        const wrap = h("div", { class: "menu-segrow" }, h("span", { class: "menu-seglabel", text: "Links open in" }));
        const seg = h("div", { class: "segmented is-small" });
        const paint = () => { for (const b of seg.children) b.classList.toggle("is-active", b.dataset.v === (app.settings.linkOpen === "browser" ? "browser" : "tab")); };
        for (const [v, t] of [["tab", "Leonote"], ["browser", "Browser"]]) seg.append(h("button", { class: "seg", dataset: { v }, onclick: () => { app.setSetting("linkOpen", v); paint(); } }, t));
        paint(); wrap.append(seg); return wrap;
      })() },
      { el: (() => {
        const wrap = h("div", { class: "menu-segrow" }, h("span", { class: "menu-seglabel", text: "Then" }));
        const seg = h("div", { class: "segmented is-small" });
        const paint = () => { for (const b of seg.children) b.classList.toggle("is-active", b.dataset.v === (app.settings.linkTabBackground === false ? "go" : "stay")); };
        for (const [v, t] of [["stay", "Stay here"], ["go", "Go to it"]]) seg.append(h("button", { class: "seg", dataset: { v }, onclick: () => { app.setSetting("linkTabBackground", v === "stay"); paint(); } }, t));
        paint(); wrap.append(seg); return wrap;
      })() },
      { label: "Pasted links get the page's title", icon: "settings", checked: app.settings.linkAutoTitle !== false, run: () => app.setSetting("linkAutoTitle", app.settings.linkAutoTitle === false) },
      { label: "Link cards - a link on its own line shown as the page's card", icon: "image", checked: !!app.settings.linkPreviews, run: () => app.setSetting("linkPreviews", !app.settings.linkPreviews) },
      { label: "Video links play in the note - a YouTube link on its own line shown as its player", icon: "play", checked: app.settings.videoLinksPlay !== false, run: () => app.setSetting("videoLinksPlay", app.settings.videoLinksPlay === false) },
    ].filter(Boolean)),
    askText: (title, value, placeholder) => askDialog(title, [{ key: "v", label: "Address", value, placeholder }], { ok: "Set" }).then((r) => (r ? r.v : null)),
    openTag: (tag) => openPalette(app, "search", { query: "#" + tag, force: true }),
    onLeave: (p, pos) => rememberPos(p, pos),
    // images in notes: ![[pic.png]] and ![](path) resolve like Obsidian (by name, or relative)
    resolveImage: (target) => resolveImage(target, ed().path),
    onImages: (files, view, pos) => pasteImages(files, view, pos, ed()),
    onMedia: (files, view, pos) => pasteMedia(files, view, pos, ed()),
    resolveMedia: (target) => {
      const f = app.vault.resolveFile(target, ed().path);
      if (!f || f.kind !== "media") return null;
      return { url: assetOf(f.path), path: f.path, audio: /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i.test(f.path), name: f.path.slice(f.path.lastIndexOf("/") + 1) };
    },
    resolveAnyFile: (target) => !!app.vault.resolveFile(target, ed().path),
    notePlayer: () => app.settings.notePlayer || {},
    playInPlayer: (path, t) => { app.media.playList([path], 0); if (t) setTimeout(() => app.media.seek && app.media.seek(t), 400); },
    setNotePlayer: (k, v) => app.setSetting("notePlayer", { ...(app.settings.notePlayer || {}), [k]: v }),
    onImageOpen: (view, from, extra) => viewImages(view, from, ed().path, extra),
    menu: (x, y, items) => app.menu(x, y, items),
    contextExtras: (path) => [...splitRows(path), ...taskRows(path, ed()), ...assistantRows()],
    // right-click on a [[link]] or ![[embed]]: where it leads, in the tree and in Windows' Explorer
    revealPath: (p) => host.externalReveal(p).catch((e) => toast(String(e), { kind: "error" })),
    linkRows: (target) => {
      const n = app.vault.resolve(target, ed().path);
      const f = n ? null : app.vault.resolveFile(target, ed().path);
      const p = n || (f && f.path);
      if (!p) return [];
      return [
        { label: "Show in the file tree", icon: "folder", run: () => app.revealInTree(p) },
        { label: "Show in Explorer", icon: "outside", run: () => app.reveal(p) },
      ];
    },
    copyPicture: (target, want) => copyPicture(target, ed().path, want),
    pictureEdits: (target) => pictureEdits(target, ed().path),
    editedImage: (url) => editedImage(url),
    pictureExtras: (target) => originalRows(target, ed().path),
    picturePath: (target) => { const f = app.vault.resolveFile(target, ed().path); return f ? f.path : ""; },
    trashFiles: (paths, view) => trashPictures(ed().path, paths, view),
    askPictureDelete: (paths) => askPictureDelete(paths),
    // the question's Replace: the link stays and shows another picture (one of the vault, or the copied one)
    replacePicture: async (path, how, view) => {
      if (how === "replace") return replaceFromClipboard(path);
      const to = await pickVaultPicture(path);
      if (to) await relinkPicture(ed().path, view, path, to);
    },
    keepFiles: (paths) => { for (let i = recentPastes.length - 1; i >= 0; i--) if (paths.includes(recentPastes[i].path)) recentPastes.splice(i, 1); },
    deleteForever: (paths, view) => confirmForever(ed().path, paths, view),
    deleteForeverNow: (paths) => { for (let i = recentPastes.length - 1; i >= 0; i--) if (paths.includes(recentPastes[i].path)) recentPastes.splice(i, 1); return app.trashItems(paths.map((p) => [p, "file"]), { mode: "forever" }); },
    // shown elsewhere too (another copy in this note, or another note): the delete asks its own question then
    pictureElsewhere: (path, view) => usesIn(view.state.doc.toString(), ed().path, [path]).length > 1 || picturesUsedIn([path], ed().path).length > 0,
    toast: (t, o2) => toast(t, o2),
    resolveSketch: (target) => {
      const f = app.vault.resolveFile(target, ed().path);
      return f ? { path: f.path, stamp: f.mtime || 0 } : null;
    },
    sketchPreview: async (path, theme) => {
      const [mod, text] = await Promise.all([import("./sketch.js"), host.readText(path)]);
      return mod.renderSketchSvg(text, { theme, maxWidth: 1400 });
    },
    openFile: (path) => app.openFile(path, { newTab: true }),
    onSlashAction: (action, view, at) => {
      if (action === "sketch") newSketch({ view, at, ed: ed() });
      else if (action === "drawing") import("./paintmode.js").then((m) => m.newDrawing(app, { mode: "draw", view, at }));
      else if (action === "extract") app.zettel.extract();
      else if (action === "template") app.zettel.insertTemplate();
    },
    ...own,
  });
  editor = createEditor($("#editor"), noteEditorOptions(() => editor, $("#note-scroll"), {
    onCursor: (state) => { app.cursorLine = state.doc.lineAt(state.selection.main.head).number - 1; cursorEmit(); statusSoon(); },
  }));

  const imageVersion = new Map(); // path -> stamp, after a picture is rewritten
  const assetOf = (path) => host.assetUrl(path) + (imageVersion.has(path) ? `?v=${imageVersion.get(path)}` : "");
  const urlPaths = new Map(); // asset url -> vault path, for the pictures shown in notes
  function resolveImage(target, from = editor.path) {
    if (/^(https?:|data:)/i.test(target)) return target;
    const f = app.vault.resolveFile(target, from);
    if (!f || f.kind !== "image") return null;
    const url = assetOf(f.path);
    urlPaths.set(url, f.path);
    return url;
  }
  const editState = new Map(); // path -> "on" | "off": a picture's edits as its note last showed them
  /** The picture as edited, for a note's inline preview; null when there are no edits, or they are off (unless `evenOff`). */
  async function editedImage(url, evenOff = false) {
    const path = urlPaths.get(url);
    if (!path || /\.svg$/i.test(path)) return null;
    const store = await import("./imageeditstore.js");
    if (!(await store.hasEdits(app, path))) { editState.delete(path); return null; }
    const off = await store.editsOff(app, path);
    editState.set(path, off ? "off" : "on");
    return off && !evenOff ? null : store.editedUrl(app, path, url);
  }
  const pictureEdits = (target, from) => { const url = resolveImage(target, from); return (url && editState.get(urlPaths.get(url))) || null; };
  const editsChanged = () => document.dispatchEvent(new CustomEvent("leonote:image-edits"));
  app.bus.on("image-edits", editsChanged);

  // what the picture viewer can do with a vault file
  app.openUrl = (url) => host.openUrl(url).catch((e) => { toast("Could not open the link: " + e, { kind: "error" }); throw e; });
  /** A link followed from a note: your browser, or a Leonote tab, as Settings say. */
  app.followLink = (url) => {
    const u = /^www\./i.test(url) ? "https://" + url : url;
    // a file on this computer: in Leonote (a vault file as itself)
    if (/^file:\/\/\//i.test(u) && !/\.html?$/i.test(u)) {
      const rel = app.vaultPathOfUrl(u);
      if (rel) return app.vault.notes.has(rel) ? app.openNote(rel) : app.openFile(rel);
      try { return app.openExternal(decodeURIComponent(new URL(u).pathname).replace(/^\/+/, "")); } catch { /* not an address after all */ }
    }
    if (app.settings.linkOpen !== "browser" && app.newWebTab) return app.newWebTab(u);
    const r = app.openUrl(u);
    // "stay here": Leonote takes the front back from the browser that just opened
    if (app.settings.linkTabBackground !== false && host.real) for (const ms of [350, 900]) setTimeout(() => host.win.setFocus().catch(() => {}), ms);
    return r;
  };
  app.removePictureFile = async (it) => {
    if (!it.path) return false;
    const n = app.vault.notes.size ? picturesUsedIn([it.path], null).length : 0;
    const ok = await confirmDialog(`Delete “${it.name || it.path}”?`, `Its file goes to the trash.${n ? ` ${n} note${n > 1 ? "s" : ""} show it and keep their links.` : ""}`, { ok: "Move to the trash" });
    return ok ? !!(await app.trashItems([[it.path, "file"]], { mode: "trash" })) : false;
  };
  app.imageActions = () => ({
    barPos: () => app.settings.imageViewerBar || "top",
    setBarPos: (v) => app.setSetting("imageViewerBar", v),
    open: (it) => (it.path ? host.openPath(it.path) : app.openUrl(it.url)).catch?.((err) => toast(String(err), { kind: "error" })),
    reveal: (it) => { if (it.path) { app.setSetting("sidebar", true); setTimeout(() => sidebar.reveal(it.path), 60); } },
    explorer: (it) => { if (it.path) app.reveal(it.path); },
    usedIn: (it, x, y) => { if (it.path) app.showUsedIn(it.path, x, y); },
    confirm: (title, text) => confirmDialog(title, text, { ok: "Write into the file" }),
    save: async (it, blob) => {
      try {
        const entry = await host.writeFile(it.path, new Uint8Array(await blob.arrayBuffer()));
        if (entry && entry.path) app.vault.files.set(entry.path, entry);
        imageVersion.set(it.path, Date.now());
        // redraw pictures in the open note with the new pixels
        for (const ed of [editor, ...(split ? split.editors : [])]) if (ed && ed.view) ed.view.dispatch({ selection: ed.view.state.selection });
        toast(`Saved ${it.path.slice(it.path.lastIndexOf("/") + 1)}${entry ? ` · ${fmtSize(entry.size)}` : ""}`, { ms: 2200 });
        return assetOf(it.path);
      } catch (err) {
        toast("Could not save the picture: " + err, { kind: "error" });
        throw err;
      }
    },
    edit: (it) => (it.path ? app.editImage(it.path) : null),
    editedUrl: async (it) => {
      if (!it.path) return null;
      const store = await import("./imageeditstore.js");
      return store.editedUrl(app, it.path, assetOf(it.path));
    },
    editsOff: async (it) => (it.path ? (await import("./imageeditstore.js")).editsOff(app, it.path) : false),
    setEditsOff: async (it, off) => { if (it.path) { await (await import("./imageeditstore.js")).setEditsOff(app, it.path, off); app.bus.emit("image-edits", it.path); } },
    // all of them at once (the file was never changed); kept here a while for Undo, as the store deletes them outright
    removeEdits: async (it, after = () => {}) => {
      if (!it.path) return;
      try {
        const [store, model] = await Promise.all([import("./imageeditstore.js"), import("./imageeditmodel.js")]);
        const kept = await store.loadDoc(app, it.path);
        await store.clearDoc(app, it.path);
        app.bus.emit("image-edits", it.path);
        after();
        // back only while nothing new was drawn meanwhile: Undo must not throw away newer edits
        toast("Edits removed - the picture is as on disk", { ms: 8000, action: { label: "Undo", run: async () => {
          if (!model.isEmptyDoc(await store.loadDoc(app, it.path))) return toast("New edits were made since - kept as they are", { ms: 3000 });
          await store.saveDoc(app, it.path, kept); app.bus.emit("image-edits", it.path); after();
        } } });
      } catch (e) { toast("Could not remove the edits: " + e, { kind: "error" }); }
    },
    share: (it) => (it.path ? shareMenuItems(app, it.path) : []),
  });

  /**
   * Draw on a picture without writing to it. The layers and the colour
   * adjustments go into a sidecar beside the file (imageedit.js); the file
   * itself only ever changes through the editor's explicit flatten step.
   */
  app.editImage = async (path, { onFlatten } = {}) => {
    const f = app.vault.files.get(path);
    if (!f || f.kind !== "image") return toast("Only pictures can be edited here");
    if (/\.svg$/i.test(path)) return toast("SVG drawings are vectors — open them in their own app");
    const mod = await import("./imageedit.js");
    // whatever was drawn, adjusted or cropped shows in the notes once the editor closes
    const editorDone = mod.openImageEditor(app, {
      path,
      url: assetOf(path),
      onFlatten: (out) => {
        if (out === path) imageVersion.set(path, Date.now());
        for (const ed of [editor, ...(split ? split.editors : [])]) if (ed && ed.view) ed.view.dispatch({ selection: ed.view.state.selection });
        if (fileView) fileView.refresh();
        if (onFlatten) onFlatten(out);
      },
    });
    Promise.resolve(editorDone).then(editsChanged, editsChanged);
    return editorDone;
  };

  /* ── pasted and dropped videos and music → copied as they are, each kind to its own folder ── */
  const AUDIO_NAME = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i;
  const mediaFolderOf = (audio) => {
    const S = app.settings;
    return app.mediaDir(audio ? "audioFolder" : "videoFolder");
  };
  async function pasteMedia(files, view, pos, ed = editor) {
    const note = ed.path;
    if (!note) return;
    const links = [];
    const saved = []; // { path, audio, name } for the chip's "move to…"
    let bytesAll = 0;
    const busy = files.some((f) => f.size > 40 * 1024 * 1024) ? toast("Copying into the vault…", { ms: 60000 }) : null;
    for (const f of files) {
      try {
        if (f.size > 1024 * 1024 * 1024) { toast(`${f.name} is larger than 1 GB - add it through the file tree instead`, { kind: "error", ms: 5000 }); continue; }
        const audio = /^audio\//.test(f.type) || AUDIO_NAME.test(f.name);
        const dir = attachmentDir(mediaFolderOf(audio), note);
        const name = safeFileName(f.name || (audio ? "sound.mp3" : "video.mp4"));
        const bytes = new Uint8Array(await f.arrayBuffer());
        const path = await host.importFile(dir ? dir + "/" + name : name, bytes);
        // known at once, so the embed plays without waiting for the watcher
        app.vault.setFiles([...[...app.vault.files.values()].filter((x) => x.path !== path), { path, size: bytes.length, mtime: Date.now(), kind: "media" }]);
        const got = path.slice(path.lastIndexOf("/") + 1);
        links.push(`![[${got}]]`);
        saved.push({ path, audio, name: got });
        // undone right away (Ctrl+Z), the copy goes to the trash with its embed, as a pasted picture does
        recentPastes.push({ note, path, name: got, at: Date.now(), gone: false, media: audio ? "audio" : "video" });
        bytesAll += bytes.length;
      } catch (err) {
        toast("Could not add the file: " + err, { kind: "error" });
      }
    }
    if (busy && busy.remove) busy.remove();
    if (!links.length || ed.path !== note) return;
    const NLc = String.fromCharCode(10);
    const at = Math.min(pos, view.state.doc.length);
    const line = view.state.doc.lineAt(at);
    const text = (at > line.from && line.text.trim() ? NLc : "") + links.join(NLc) + NLc;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.paste" });
    mediaChip(saved, bytesAll, note);
  }
  const safeFileName = (n) => String(n).replace(/[\\/:*?"<>|\[\]#^]+/g, " ").replace(/\s+/g, " ").trim() || "file";

  /** Top right, like the picture chip: where they went, and a gear to choose where each kind goes. */
  const cardMs = () => Math.max(2, Number(app.settings.cornerSecs) || 6) * 1000;
  function mediaChip(saved, bytes, note) {
    const vids = saved.filter((s) => !s.audio).length;
    const auds = saved.length - vids;
    const what = [vids ? `${vids} video${vids > 1 ? "s" : ""}` : "", auds ? `${auds} song${auds > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
    const dirs = [...new Set(saved.map((s) => (s.path.includes("/") ? s.path.slice(0, s.path.lastIndexOf("/")) : "vault root")))];
    const el = h("div", { class: "saved-chip is-flat", role: "status" },
      icon(vids ? "film" : "music"),
      h("span", { text: `${what} · ${fmtSize(bytes)} → ${dirs.join(", ")}` }),
      h("button", { class: "saved-gear", title: "Where videos and music pasted into notes are kept", onclick: (e) => { e.stopPropagation(); mediaSettings(el, saved, note); } }, icon("settings")));
    chipEl = el;
    cornerCard(el, { ms: cardMs(), reset: app.settings.cornerHoverResets !== false, hold: () => !!document.querySelector(".saved-pop") });
  }
  function mediaSettings(chip, saved, note) {
    const old = document.querySelector(".saved-pop");
    if (old) return old.remove();
    clearTimeout(chipTimer);
    const S = app.settings;

    const field = (key, label) => {
      const input = h("input", { class: "input saved-pop-input", placeholder: MEDIA_DIRS[key], value: S[key] || "", spellcheck: false });
      const pick = h("button", { class: "icon-btn", title: "Choose a folder of the vault", onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const folders = ["", ...[...app.vault.folders].sort((a, b) => a.localeCompare(b))].slice(0, 400);
        menu(r.left, r.bottom + 4, [
          { label: "Next to the note  (./)", icon: "fileText", run: () => { input.value = "./"; app.setSetting(key, "./"); } },
          { label: "The usual place", icon: "folder", run: () => { input.value = ""; app.setSetting(key, ""); } },
          "sep",
          ...folders.map((d) => ({ label: d || "Vault root  (/)", icon: "folder", run: () => { input.value = d || "/"; app.setSetting(key, d || "/"); } })),
        ]);
      } }, icon("folder"));
      input.addEventListener("change", () => app.setSetting(key, input.value.trim()));
      input.addEventListener("keydown", (e) => e.stopPropagation());
      return h("label", { class: "saved-pop-row is-folder" }, h("span", { text: label }), h("span", { class: "saved-pop-field" }, input, pick));
    };
    const move = saved.length ? h("button", { class: "btn is-small", onclick: async () => {
      let n = 0;
      for (const s of saved) {
        const dir = attachmentDir(mediaFolderOf(s.audio), note);
        const to = dir ? dir + "/" + s.name : s.name;
        if (to === s.path) continue;
        try {
          if (dir && !app.vault.folders.has(dir)) await app.vault.createFolder(dir).catch(() => {});
          await app.vault.renameFile(s.path, to);
          s.path = to;
          n++;
        } catch (err) { toast("Could not move " + s.name + ": " + err, { kind: "error" }); }
      }
      toast(n ? `Moved ${n} file${n > 1 ? "s" : ""}` : "Already there", { ms: 2000 });
    } }, "Move what was just added there") : null;
    const pop = h("div", { class: "saved-pop" },
      h("div", { class: "saved-pop-title", text: "Videos and music in notes" }),
      field("videoFolder", "Videos go to"),
      field("audioFolder", "Music goes to"),
      h("div", { class: "saved-pop-note", text: "Empty is the usual place, shown in the field. ./ means next to the note, / the vault root. Files are copied as they are - nothing is re-encoded." }),
      move);
    const at = chip.getBoundingClientRect();
    pop.style.top = at.bottom + 8 + "px";
    pop.style.right = Math.max(8, innerWidth - at.right) + "px";
    const away = (e) => { if (!pop.contains(e.target) && !chip.contains(e.target) && !e.target.closest(".menu")) close(); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    function close() { pop.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); chipTimer = setTimeout(hide, 1500); }
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    document.body.append(pop);
  }

  /* ── pasted and dropped pictures → compressed WebP in the attachment folder ── */
  /* A pasted picture whose embed is undone (Ctrl+Z) goes to the trash with it,
     so the media folder does not gather pictures nobody uses; redone, it comes
     back. Only for ten minutes after the paste, and only if Settings say so. */
  const PASTE_WATCH_MS = 10 * 60 * 1000;
  const recentPastes = []; // { note, path, name, at, gone }
  let pasteWatchBusy = false;
  /* The same watch keeps a picture taken out with Shift+Delete (`del`): its file is
     in the trash while the embed is out of the note, and Ctrl+Z brings both back. */
  async function pasteUndoWatch(note, ed, undo) {
    if (pasteWatchBusy || !ed || !ed.view) return;
    if (!undo && !recentPastes.some((r) => r.note === note && !r.gone)) return;
    const now = Date.now();
    for (let i = recentPastes.length - 1; i >= 0; i--) if (now - recentPastes[i].at > PASTE_WATCH_MS) recentPastes.splice(i, 1);
    const mine = recentPastes.filter((r) => r.note === note && (r.del || app.settings.pasteUndoTrash !== false));
    if (!mine.length) return;
    // by name: a file in the trash no longer resolves
    const text = ed.view.state.doc.toString();
    const names = new Set(imagesIn(text).map((m) => basename(m.target.split("|")[0])));
    // videos and songs are embedded the same way: ![[name]]
    for (const m of text.matchAll(/!\[\[([^\]|#]+)/g)) names.add(basename(m[1].trim()));
    pasteWatchBusy = true;
    try {
      for (const r of mine) {
        const present = names.has(r.name);
        // its link taken out by hand (typed over, Backspace, a Delete answered "link"): the file stays, and is forgotten here
        if (!undo) { if (!present && !r.gone) recentPastes.splice(recentPastes.indexOf(r), 1); continue; }
        if (!present && !r.gone) {
          r.gone = true;
          // still shown in another note, or already gone (trashed another way): the file stays as it is
          if (!app.vault.files.has(r.path) || picturesUsedIn([r.path], note).length) continue;
          const what = r.media ? (r.media === "audio" ? "song" : "video") : "picture";
          if (await app.trashItems([[r.path, "file"]], { quiet: true, mode: "trash" })) toast(r.del ? `The ${what} went to the trash again · Ctrl+Z brings it back` : `The pasted ${what} went to the trash with it · Ctrl+Shift+Z brings both back`, { ms: 4200 });
        } else if (present && r.gone) {
          r.gone = false;
          try { await host.trashRestore({ from: r.path }); } catch (e) { toast(`Could not bring the picture back: ${e}`, { kind: "error" }); }
        }
      }
    } finally { pasteWatchBusy = false; }
  }

  /** Shift+Delete on picked pictures: the embeds are out already; the files go to the trash. Other notes keep their links. */
  async function trashPictures(note, paths, view) {
    // the same picture picked twice (copies of one embed) is one file
    paths = [...new Set(paths)].filter((p) => app.vault.files.has(p));
    if (!paths.length) return;
    // still used - copies left in this note, or other notes: asked what to do with the file
    const here = view ? usesIn(view.state.doc.toString(), note, paths) : [];
    const elsewhere = picturesUsedIn(paths, note);
    if (here.length || elsewhere.length) {
      const what = await stillUsedDialog(note, paths, here, elsewhere);
      if (what === "replace") { await replaceFromClipboard(paths[0]); return; }
      if (what === "relink") { const to = await pickVaultPicture(paths[0]); if (to) await relinkPicture(note, view, paths[0], to); return; }
      if (what !== "trash") {
        const n = here.length + elsewhere.reduce((k, o) => k + o.hits.length, 0);
        toast(`Only the link left this note - the picture stays, shown in ${n} more place${n > 1 ? "s" : ""}`, { ms: 5000, action: view ? { label: "Undo", run: () => { cmUndo(view); view.focus(); } } : undefined });
        return;
      }
    }
    if (!(await app.trashItems(paths.map((p) => [p, "file"]), { quiet: true, mode: "trash" }))) return;
    for (const p of paths) {
      for (let i = recentPastes.length - 1; i >= 0; i--) if (recentPastes[i].path === p) recentPastes.splice(i, 1);
      recentPastes.push({ note, path: p, name: basename(p), at: Date.now(), gone: true, del: true });
    }
    const others = picturesUsedIn(paths, note);
    const what = paths.length > 1 ? `${paths.length} pictures` : "The picture";
    toast(`${what} went to the trash · Ctrl+Z brings ${paths.length > 1 ? "them" : "it"} back${others.length ? ` · still in ${others.length} other note${others.length > 1 ? "s" : ""}` : ""}`, { ms: 9000, actions: [
      view ? { label: "Undo", run: () => { cmUndo(view); view.focus(); } } : null,
      others.length ? { label: "Where…", run: () => picturesElsewhere(paths, others) } : null,
    ] });
  }
  /**
   * Delete on a picture: the link only, or the file to the trash as well. The usual answer has the focus
   * (Enter takes it) - the link, unless the user made the trash their usual one. Resolves "link", "trash" or null.
   */
  function askPictureDelete(paths) {
    return new Promise((resolve) => {
      const usual = app.settings.pictureDelete === "trash" ? "trash" : "link";
      // remembered: no question at all
      if (app.settings.pictureDeleteAsk === false) { resolve(usual); return; }
      const remember = h("input", { type: "checkbox" });
      const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); if ((v === "link" || v === "trash") && remember.checked) { app.setSetting("pictureDelete", v); app.setSetting("pictureDeleteAsk", false); } resolve(v); };
      const n = paths.length;
      const link = h("button", { class: "btn" + (usual === "link" ? " btn-primary" : ""), onclick: () => done("link") }, n > 1 ? "Remove the links" : "Remove the link");
      const trash = h("button", { class: "btn" + (usual === "trash" ? " btn-danger" : ""), onclick: () => done("trash") }, icon("trash"), "Move to the trash");
      const box = h("div", { class: "dlg pic-del", role: "dialog", "aria-modal": "true" },
        // the pictures themselves, small, beside a short title; the file name quiet under it
        h("div", { class: "pic-del-head" },
          h("div", { class: "pic-del-thumbs" }, ...paths.slice(0, 3).map((p) => h("img", { src: assetOf(p), alt: "", draggable: false }))),
          h("div", { class: "pic-del-what" },
            h("h3", { class: "dlg-title", text: n > 1 ? `Remove ${n} pictures?` : "Remove this picture?" }),
            h("div", { class: "pic-del-name", title: paths.join("\n"), text: n > 1 ? paths.slice(0, 3).map((p) => basename(p)).join(", ") + (n > 3 ? "…" : "") : basename(paths[0]) }))),
        h("ul", { class: "pic-del-text" },
          h("li", {}, h("b", { text: n > 1 ? "Remove the links" : "Remove the link" }), ` - the file${n > 1 ? "s stay" : " stays"} in the vault`),
          h("li", {}, h("b", { text: "Move to the trash" }), " - the file goes too; Ctrl+Z brings both back")),
        h("div", { class: "dlg-btns" },
          // one picture can be swapped instead: its link stays and shows another picture
          n === 1 ? h("button", { class: "btn pic-del-swap", title: "Keep the link, show another picture in it", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, [
            { label: "A picture from the vault…", icon: "image", run: () => done("relink") },
            { label: "The copied picture (from the clipboard)", icon: "clipboard", run: () => done("replace") },
          ]); } }, "Replace with…") : null,
          h("button", { class: "btn", onclick: () => done(null) }, "Cancel"), link, trash),
        // quiet, under the buttons: for those who would rather not be asked
        h("label", { class: "pic-del-remember", title: "Change it in Settings › Images" }, remember, h("span", { text: "Remember my choice and stop asking" })));
      const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(null); } }, box);
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === "Enter" && document.activeElement !== remember) { e.preventDefault(); e.stopPropagation(); done(document.activeElement === trash ? "trash" : document.activeElement === link ? "link" : usual); }
      };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("overlay-root").append(back);
      requestAnimationFrame(() => { back.classList.add("is-in"); (usual === "trash" ? trash : link).focus(); });
    });
  }
  /** Shift+Delete on pictures: asked twice (Cancel the default the second time); where they are still shown is said. Resolves true to go ahead. */
  async function confirmForever(note, paths, view) {
    paths = [...new Set(paths)];
    const here = view ? usesIn(view.state.doc.toString(), note, paths).length - paths.length : 0;
    const elsewhere = picturesUsedIn(paths, note);
    const n = Math.max(0, here) + elsewhere.reduce((k, o) => k + o.hits.length, 0);
    const what = paths.length > 1 ? `${paths.length} pictures` : `“${basename(paths[0])}”`;
    const used = n ? ` ${paths.length > 1 ? "They are" : "It is"} still shown in ${n} more place${n > 1 ? "s" : ""}${elsewhere.length ? ` (${elsewhere.slice(0, 3).map((o) => basename(o.path).replace(/\.md$/i, "")).join(", ")}${elsewhere.length > 3 ? "…" : ""})` : ""} - ${n > 1 ? "they" : "it"} would show a broken picture.` : "";
    if (!(await confirmDialog(`Delete ${what} permanently?`, `Not to the trash: the file${paths.length > 1 ? "s are" : " is"} deleted for good and ${paths.length > 1 ? "their links leave" : "its link leaves"} this note.${used}`, { ok: "Delete permanently", safe: true }))) return false;
    return confirmDialog("Last check: delete for good?", `Nothing can bring ${paths.length > 1 ? "them" : "it"} back - not Ctrl+Z, not the trash.`, { ok: "Yes, delete for good", safe: true });
  }
  /** The embeds of `paths` in a note's text (by name; one in the trash no longer resolves). */
  function usesIn(text, notePath, paths) {
    const want = new Set(paths), names = new Set(paths.map((p) => basename(p)));
    return imagesIn(text).filter((m) => {
      const t = m.target.split("|")[0];
      if (!names.has(basename(t))) return false;
      const f = app.vault.resolveFile(t, notePath);
      return !f || want.has(f.path);
    });
  }
  /**
   * A picture being deleted that is still shown somewhere: where (each place a click away), and what to do -
   * keep the file (only this link went), replace the picture everywhere with the one on the clipboard, or move
   * it to the trash anyway. Resolves "keep", "replace", "trash" or null (closed).
   */
  function stillUsedDialog(note, paths, here, elsewhere) {
    return new Promise((resolve) => {
      const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
      const name = paths.length > 1 ? `${paths.length} pictures` : `“${basename(paths[0])}”`;
      const go = (path, offset) => { done(null); app.openNote(path, { offset }); };
      const place = (label, sub, path, offset) => h("button", { class: "used-row", title: "Go there", onclick: () => go(path, offset) },
        icon("fileText"), h("span", { class: "used-name", text: label }), sub ? h("span", { class: "used-sub", text: sub }) : null, icon("arrowRight"));
      const rows = [
        here.length ? place("This note", here.length > 1 ? `${here.length} more times` : "once more", note, here[0].from) : null,
        ...elsewhere.map((o) => place(basename(o.path).replace(/\.md$/i, ""), `${o.hits.length > 1 ? o.hits.length + " times · " : ""}${dirname(o.path) || "vault"}`, o.path, o.hits[0].from)),
      ].filter(Boolean);
      const keep = h("button", { class: "btn btn-primary", onclick: () => done("keep") }, "Keep the file");
      const box = h("div", { class: "dlg used-dlg", role: "alertdialog", "aria-modal": "true" },
        h("h3", { class: "dlg-title", text: `${name} ${paths.length > 1 ? "are" : "is"} still used in ${rows.length} place${rows.length > 1 ? "s" : ""}` }),
        h("p", { class: "dlg-text", text: "Its link left this note. Moved to the trash, the picture goes from every place below too (they show a broken picture until Ctrl+Z). Click a place to go there." }),
        h("div", { class: "used-list" }, ...rows),
        h("div", { class: "dlg-btns" },
          h("button", { class: "btn btn-danger", onclick: () => done("trash") }, "Move to the trash anyway"),
          paths.length === 1 ? h("button", { class: "btn", title: "Another picture in every place that shows this one", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, [
            { label: "A picture from the vault…", icon: "image", run: () => done("relink") },
            { label: "The copied picture (from the clipboard)", icon: "clipboard", run: () => done("replace") },
          ]); } }, "Replace with…") : null,
          keep));
      const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(null); } }, box);
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done("keep"); } };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("overlay-root").append(back);
      requestAnimationFrame(() => { back.classList.add("is-in"); keep.focus(); });
    });
  }
  /** A picture of the vault, chosen from its pictures by name (each shown small). Resolves its path, or null. */
  function pickVaultPicture(but) {
    return new Promise((resolve) => {
      const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
      const all = [...app.vault.files.keys()].filter((k) => IMG.test(k) && k !== but && !k.startsWith(".")).sort((a, b) => ((app.vault.files.get(b) || {}).mtime || 0) - ((app.vault.files.get(a) || {}).mtime || 0));
      const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
      const q = h("input", { class: "dlg-input", placeholder: `Find a picture by name - ${all.length} in the vault`, spellcheck: false });
      const grid = h("div", { class: "pick-pics" });
      const paint = () => {
        const f = q.value.trim().toLowerCase();
        const list = all.filter((k) => !f || k.toLowerCase().includes(f)).slice(0, 60);
        grid.replaceChildren(...(list.length ? list.map((k) => h("button", { class: "pick-pic", title: k, onclick: () => done(k) },
          h("img", { src: assetOf(k), alt: "", loading: "lazy", draggable: false }), h("span", { text: basename(k) }))) : [h("p", { class: "dlg-text", text: "No picture by that name" })]));
      };
      q.addEventListener("input", paint);
      const box = h("div", { class: "dlg pick-dlg", role: "dialog", "aria-modal": "true" },
        h("h3", { class: "dlg-title", text: "Replace it with which picture?" }), q, grid,
        h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(null) }, "Cancel")));
      const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(null); } }, box);
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); const b = grid.querySelector(".pick-pic"); if (b) b.click(); } };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("overlay-root").append(back);
      paint();
      requestAnimationFrame(() => { back.classList.add("is-in"); q.focus(); });
    });
  }
  /** Every embed of `from` (this note's, in the editor, and other notes') now shows `to`; `from` then goes to the trash, used nowhere. */
  async function relinkPicture(note, view, from, to) {
    // the new picture's link: its name, or its path when another file has the same name
    const name = basename(to);
    const link = [...app.vault.files.keys()].some((k) => k !== to && basename(k) === name) ? to : name;
    const swap = (text, m) => {
      const old = m.target.split("|")[0];
      const seg = text.slice(m.from, m.to);
      const at = seg.indexOf(old);
      return at < 0 ? seg : seg.slice(0, at) + (seg.startsWith("![[") ? link : encodeURI(link)) + seg.slice(at + old.length);
    };
    let n = 0;
    if (view) {
      const doc = view.state.doc.toString();
      const changes = usesIn(doc, note, [from]).map((m) => ({ from: m.from, to: m.to, insert: swap(doc, m) }));
      if (changes.length) { view.dispatch({ changes, userEvent: "input" }); n += changes.length; }
    }
    for (const o of picturesUsedIn([from], note)) {
      const cur = app.vault.notes.get(o.path);
      if (!cur) continue;
      let text = cur.content;
      for (const m of usesIn(text, o.path, [from]).reverse()) { text = text.slice(0, m.from) + swap(text, m) + text.slice(m.to); n++; }
      if (text !== cur.content) try { await app.vault.write(o.path, text, {}); } catch (e) { toast(`Could not change ${o.path}: ${e}`, { kind: "error" }); }
    }
    // used nowhere now (this note as the editor has it - its saved copy may lag behind)
    const still = (view ? usesIn(view.state.doc.toString(), note, [from]).length : 0) + picturesUsedIn([from], note).length;
    const trashed = !still && (await app.trashItems([[from, "file"]], { quiet: true, mode: "trash" }));
    toast(`${n} place${n === 1 ? " now shows" : "s now show"} “${name}”${trashed ? ` - “${basename(from)}” went to the trash` : ""}`, { ms: 5000 });
  }
  /** The picture on the clipboard written into `path` (in that file's format): every place that shows it shows the new one. The old one is kept in the trash. */
  async function replaceFromClipboard(path) {
    let blob = null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) { blob = await item.getType(type); break; }
      }
    } catch { /* nothing readable */ }
    if (!blob) { toast("No picture on the clipboard - the file is kept. Copy one and delete the link again to replace it", { kind: "error", ms: 6000 }); return; }
    const ext = (path.split(".").pop() || "").toLowerCase();
    const S = app.settings;
    try {
      let bytes;
      if (ext === "webp") bytes = (await compressImage(blob, { quality: clamp(Number(S.imageQuality) || 80, 5, 100) / 100, maxSide: Number(S.imageMaxSide) || 0, format: "webp" })).bytes;
      else if (blob.type === "image/" + (ext === "jpg" ? "jpeg" : ext)) bytes = new Uint8Array(await blob.arrayBuffer());
      else {
        // another format: drawn once and written as this file's own kind
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        c.getContext("2d").drawImage(bmp, 0, 0);
        const out = await new Promise((res) => c.toBlob(res, ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png", 0.92));
        bytes = new Uint8Array(await out.arrayBuffer());
      }
      const entry = await host.writeFile(path, bytes);
      if (entry && entry.path) app.vault.files.set(entry.path, entry);
      imageVersion.set(path, Date.now());
      for (const ed of [editor, ...(split ? split.editors : [])]) if (ed && ed.view) ed.view.dispatch({ selection: ed.view.state.selection });
      toast(`Replaced “${basename(path)}” everywhere it is shown - the old picture is in the trash`, { ms: 5000 });
    } catch (e) { toast("Could not replace the picture: " + e, { kind: "error" }); }
  }
  /** The notes (other than `but`) that embed one of `paths`, with each embed found. */
  function picturesUsedIn(paths, but) {
    const want = new Set(paths);
    const names = new Set(paths.map((p) => basename(p)));
    const out = [];
    for (const n of app.vault.notes.values()) {
      if (n.path === but || ![...names].some((x) => n.content.includes(x) || n.content.includes(encodeURI(x)))) continue;
      const hits = imagesIn(n.content).filter((m) => {
        const t = m.target.split("|")[0];
        if (!names.has(basename(t))) return false;
        const f = app.vault.resolveFile(t, n.path);
        return !f || want.has(f.path); // in the trash it no longer resolves: by name, then
      });
      if (hits.length) out.push({ path: n.path, hits });
    }
    return out;
  }
  // the notes still showing the picture; with a confirmation, its embeds come out of all of them
  async function picturesElsewhere(paths, others) {
    const NL = String.fromCharCode(10);
    const list = others.map((o) => `• ${o.path.replace(/\.md$/i, "")}${o.hits.length > 1 ? ` (${o.hits.length} times)` : ""}`).join(NL);
    if (!(await confirmDialog(`Still used in ${others.length} other note${others.length > 1 ? "s" : ""}`, `${list}${NL}${NL}Take it out of these notes too? The file is in the trash already.`, { ok: "Remove it everywhere" }))) return;
    const now = new Map(picturesUsedIn(paths, null).map((x) => [x.path, x]));
    let n = 0;
    for (const o of others) {
      const note = app.vault.notes.get(o.path);
      if (!note) continue;
      let text = note.content;
      // where the embeds are now: the note may have changed while the question was up
      const cur = now.get(o.path);
      if (!cur) continue;
      const at = new Set(cur.hits.map((x) => x.from));
      for (const m of [...imagesIn(text)].reverse()) {
        if (!at.has(m.from)) continue;
        // a line that was only the picture goes whole
        const ls = text.lastIndexOf(NL, m.from - 1) + 1;
        let le = text.indexOf(NL, m.to);
        if (le < 0) le = text.length;
        const alone = text.slice(ls, le).trim() === text.slice(m.from, m.to);
        text = alone ? text.slice(0, ls) + text.slice(Math.min(text.length, le + 1)) : text.slice(0, m.from) + text.slice(text[m.to] === " " ? m.to + 1 : m.to);
      }
      if (text === note.content) continue;
      try { await app.vault.write(o.path, text, {}); n++; } catch (e) { toast(`Could not change ${o.path}: ${e}`, { kind: "error" }); }
    }
    toast(`Taken out of ${n} note${n === 1 ? "" : "s"}`, { ms: 2600 });
  }

  async function pasteImages(files, view, pos, ed = editor) {
    const note = ed.path;
    if (!note) return;
    const S = app.settings;
    const folder = app.mediaDir("imageFolder");
    const dir = attachmentDir(folder, note);
    // what Leonote squeezed on the way in has its own folder; what was kept as it came goes with the pictures
    const cdir = attachmentDir(app.mediaDir("compressedImageFolder"), note);
    const links = [];
    const packed = []; // compressed ones, in case the full size is wanted after all
    let after = 0;
    let before = 0;
    const t0 = Date.now();
    for (const [i, f] of files.entries()) {
      try {
        // the original stays in memory for "Keep original" (a pasted file can't be read later)
        const orig = new Uint8Array(await f.arrayBuffer());
        const c = await compressImage(new Blob([orig], { type: f.type }), {
          quality: clamp(Number(S.imageQuality) || 80, 5, 100) / 100,
          maxSide: Number(S.imageMaxSide) || 0,
          format: S.imageFormat || "webp",
        });
        const name = imageName(note, c.ext, t0 + i);
        const into = c.kept ? dir : cdir;
        const list = await host.saveImage(into ? into + "/" + name : name, c.bytes);
        if (Array.isArray(list)) app.vault.setFiles(list);
        links.push(setEmbedSide(setEmbedWidth(`![[${name}]]`, Number(S.imagePasteWidth) || 0), S.imagePasteSide === "left" || S.imagePasteSide === "right" ? S.imagePasteSide : ""));
        recentPastes.push({ note, path: into ? into + "/" + name : name, name, at: Date.now(), gone: false });
        if (!c.kept) packed.push({ orig, type: f.type, path: into ? into + "/" + name : name, name, full: imageName(note, c.origExt, t0 + i) });
        after += c.bytes.length;
        before += c.before;
      } catch (err) {
        toast("Could not save the image: " + err, { kind: "error" });
      }
    }
    if (!links.length || ed.path !== note) return;
    const doc = view.state.doc;
    const at = Math.min(pos, doc.length);
    const line = doc.lineAt(at);
    const PICS = /^\s*(?:!\[\[[^\]\n]+\]\]\s*)+$/; // a line of nothing but pictures
    const inRow = (l) => setEmbedSide(l, ""); // a row of pictures does not float: they sit side by side, text below
    // right after pictures, on their own line: the new ones join the row. On the line under it the paste
    // is a new paragraph - the caret is put beside a picture (its indicator shows) to add to a row
    const rowLine = at === line.to && PICS.test(line.text) ? line : null;
    if (rowLine) {
      // the row's own size: a picture made smaller there, and the new ones come in at its width (pictures in a
      // row are most often alike) - not at full size beside it
      const last = (rowLine.text.match(/!\[\[[^\]\n]+\]\]/g) || []).pop();
      const w = last ? embedWidth(last) : 0;
      const row = rowLine.text.replace(/!\[\[[^\]\n]+\]\]/g, inRow).replace(/\s+$/, "") + " " + links.map((l) => inRow(w ? setEmbedWidth(l, w) : l)).join(" ");
      view.dispatch({ changes: { from: rowLine.from, to: rowLine.to, insert: row }, userEvent: "input.paste" });
    } else {
      // several at once: a row too
      // just the picture: no line is added under it - the caret waits right after it, and Enter goes below
      const text = links.length > 1 ? links.map(inRow).join(" ") : links[0];
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.paste" });
    }
    for (const it of packed) rememberOriginal(note, dir, it);
    // this paste again, from its originals, at another quality or size: the same files, overwritten (the
    // first overwrite keeps the old one in the trash)
    const redo = packed.length ? async (quality, maxSide) => {
      let total = 0;
      for (const it of packed) {
        const c = await compressImage(new Blob([it.orig], { type: it.type }), { quality: quality / 100, maxSide, format: "webp" });
        const entry = await host.writeFile(it.path, c.bytes);
        if (entry) app.vault.files.set(entry.path, entry);
        imageVersion.set(it.path, Date.now()); // the note shows the new pixels, not the cached ones
        total += c.bytes.length;
      }
      for (const ed of [editor, ...(split ? split.editors : [])]) if (ed && ed.view) ed.view.dispatch({ selection: ed.view.state.selection });
      return total;
    } : null;
    savedChip(links.length, before, after, packed.length ? () => keepOriginals(note, dir, packed) : null, redo);
  }

  /* The pasted originals stay in MEMORY for a while after the chip has gone
     (nothing is written anywhere, so no disk wear): ten minutes, 96 MB at the
     most. After that the clipboard is asked - if the same picture is still on
     it, that is the original too. */
  const ORIG_MS = 10 * 60 * 1000;
  const ORIG_MAX = 96 * 1024 * 1024;
  const originals = new Map(); // compressed path -> { note, dir, it, at }
  function rememberOriginal(note, dir, it) {
    originals.set(it.path, { note, dir, it, at: Date.now() });
    let sum = 0;
    for (const [k, v] of [...originals].reverse()) { sum += v.it.orig.length; if (sum > ORIG_MAX || Date.now() - v.at > ORIG_MS) originals.delete(k); }
    setTimeout(() => { const v = originals.get(it.path); if (v && Date.now() - v.at >= ORIG_MS) originals.delete(it.path); }, ORIG_MS + 500);
  }
  function originalRows(target, from) {
    const f = app.vault.resolveFile(target, from);
    // where the picture lies: in the tree, and on the disk
    const where = f ? [
      { label: "Where it is used…", icon: "link", run: () => app.showUsedIn(f.path, innerWidth / 2 - 120, 120) },
      { label: "Show in the file tree", icon: "folder", run: () => app.revealInTree(f.path) },
      { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(f.path) },
    ] : [];
    return [...where, ...originalOnly(f, from)];
  }
  function originalOnly(f, from) {
    if (!f || !/\.webp$/i.test(f.path)) return [];
    const held = originals.get(f.path);
    const fresh = held && Date.now() - held.at < ORIG_MS;
    // only a picture named the way a paste names it can have come from the clipboard
    if (!fresh && !/-\d{12,}\.webp$/i.test(f.path)) return [];
    return [{
      label: fresh ? `Bring back the original (${fmtSize(held.it.orig.length)})` : "Bring back the original from the clipboard",
      icon: "undo",
      run: () => (fresh ? keepOriginals(held.note, held.dir, [held.it]).then(() => originals.delete(f.path)) : originalFromClipboard(f.path, from)),
    }];
  }
  async function originalFromClipboard(path, note) {
    try {
      const items = await navigator.clipboard.read();
      let blob = null;
      for (const it of items) { const type = it.types.find((t) => /^image\//.test(t)); if (type) { blob = await it.getType(type); break; } }
      if (!blob) return toast("There is no picture on the clipboard any more", { ms: 2600 });
      const name = path.slice(path.lastIndexOf("/") + 1);
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp" })[blob.type] || "png";
      const orig = new Uint8Array(await blob.arrayBuffer());
      await keepOriginals(note, dir, [{ orig, type: blob.type, path, name, full: name.replace(/\.webp$/i, "." + ext) }]);
    } catch (err) {
      toast("Could not read the clipboard: " + err, { kind: "error" });
    }
  }

  // "Keep original": save the pasted pictures as they were, relink, drop the WebP copies
  async function keepOriginals(note, dir, packed) {
    let n = 0;
    for (const it of packed) {
      try {
        const list = await host.saveImage(dir ? dir + "/" + it.full : it.full, it.orig);
        if (Array.isArray(list)) app.vault.setFiles(list);
        for (const ed of [editor, ...(split ? split.editors : [])]) {
          if (!ed || ed.path !== note) continue;
          const text = ed.view.state.doc.toString();
          const from = text.indexOf(`![[${it.name}`);
          if (from >= 0) ed.view.dispatch({ changes: { from: from + 3, to: from + 3 + it.name.length, insert: it.full }, userEvent: "input" });
        }
        if (!editor.has(note) && !(split && split.editors.some((ed) => ed.has(note)))) {
          const c = app.vault.get(note)?.content;
          if (c && c.includes(`![[${it.name}`)) await app.vault.write(note, c.split(`![[${it.name}`).join(`![[${it.full}`));
        }
        await app.vault.trashFile(it.path).catch(() => {});
        n++;
      } catch (err) {
        toast("Could not keep the original: " + err, { kind: "error" });
      }
    }
    if (n) toast(n > 1 ? `Kept ${n} originals at full size` : "Kept the original at full size", { ms: 2200 });
  }

  // a tiny corner note: how much the compression saved on this paste
  let chipTimer = 0;
  let chipEl = null;
  const hide = () => { const el = chipEl; if (!el) return; chipEl = null; if (el.close) el.close(); else el.remove(); };
  function savedChip(count, before, after, undo, redo) {
    const saved = before - after;
    const what = count > 1 ? `${count} images` : "Image";
    const good = saved > before * 0.05;
    const el = h("div", { class: "saved-chip" + (good ? "" : " is-flat"), role: "status" },
      icon(good ? "check" : "image"),
      h("span", { class: "saved-sizes", text: `${what} · ${fmtSize(before)} → ${fmtSize(after)}` }),
      good ? h("b", { class: "saved-pct", text: `−${Math.round((saved / before) * 100)}%` }) : null,
      good && undo ? h("button", { class: "saved-undo", title: "Use the full-size original instead", onclick: () => { hide(); undo(); } }, "Keep original") : null,
      h("button", { class: "saved-gear", title: "How pasted pictures are saved", onclick: (e) => { e.stopPropagation(); pasteSettings(el); } }, icon("settings")));
    el.title = good ? "Squeezed on the way in" : "Saved as it came";
    el._undo = good && undo ? undo : null;
    el._redo = redo ? { run: redo, before, what } : null;
    chipEl = el;
    cornerCard(el, { ms: cardMs(), reset: app.settings.cornerHoverResets !== false, hold: () => !!document.querySelector(".saved-pop") });
  }

  /** The chip's gear: the same settings as Settings > Images, right where the paste happened. */
  function pasteSettings(chip) {
    const old = document.querySelector(".saved-pop");
    if (old) return old.remove();
    clearTimeout(chipTimer);
    const S = app.settings;
    const on = () => (S.imageFormat || "webp") !== "original";
    const fmt = h("div", { class: "segmented is-small" },
      ...[["webp", "Compress"], ["original", "Keep as is"]].map(([v, label]) => h("button", { dataset: { v }, onclick: () => { app.setSetting("imageFormat", v); paint(); if (v === "original" && chip._undo) { const u = chip._undo; chip._undo = null; u(); } } }, label)));
    const slide = (key, min, max, unit, step, zero) => {
      const out = h("span", { class: "slider-val" });
      const input = h("input", { type: "range", class: "slider", min, max, step, value: S[key] });
      const say = () => { out.textContent = zero && !Number(S[key]) ? zero : S[key] + unit; };
      input.addEventListener("input", () => { app.setSetting(key, Number(input.value)); say(); });
      say();
      return h("div", { class: "slider-wrap" }, input, out);
    };
    const q = h("label", { class: "saved-pop-row" }, h("span", { text: "Quality" }), slide("imageQuality", 10, 100, "%", 5));
    const m = h("label", { class: "saved-pop-row" }, h("span", { text: "Largest side" }), slide("imageMaxSide", 0, 4000, "px", 100, "as it is"));
    const paint = () => { for (const b of fmt.children) b.classList.toggle("is-active", (S.imageFormat || "webp") === b.dataset.v); q.classList.toggle("is-off", !on()); m.classList.toggle("is-off", !on()); };
    const pop = h("div", { class: "saved-pop" },
      h("div", { class: "saved-pop-title", text: "Pasted pictures" }),
      h("div", { class: "saved-pop-row" }, h("span", { text: "When pasting" }), fmt),
      q, m,
      h("div", { class: "saved-pop-note", text: "Applies from the next paste, in every note." }),
      h("button", { class: "link-btn", onclick: () => { close(); hide(); app.run("settings"); } }, "All image settings…"),
      thisPaste());
    // this paste on its own: squeezed again from the original, at its own quality and size
    function thisPaste() {
      const R = chip._redo;
      if (!R) return null;
      let qv = Number(S.imageQuality) || 80, mv = Number(S.imageMaxSide) || 0;
      const local = (get, set, min, max, step, unit, zero) => {
        const out = h("span", { class: "slider-val" });
        const say = () => { out.textContent = zero && !get() ? zero : get() + unit; };
        const input = h("input", { type: "range", class: "slider", min, max, step, value: get() });
        input.addEventListener("input", () => { set(Number(input.value)); say(); });
        say();
        return h("div", { class: "slider-wrap" }, input, out);
      };
      const go = h("button", { class: "btn btn-sm btn-primary", onclick: async () => {
        go.disabled = true; go.textContent = "Squeezing…";
        try {
          const after = await R.run(qv, mv);
          const sz = chip.querySelector(".saved-sizes"), pct = chip.querySelector(".saved-pct");
          if (sz) sz.textContent = `${R.what} · ${fmtSize(R.before)} → ${fmtSize(after)}`;
          if (pct) pct.textContent = `−${Math.max(0, Math.round(((R.before - after) / R.before) * 100))}%`;
          go.textContent = `Done · ${fmtSize(after)}`;
        } catch (err) { toast("Could not squeeze it again: " + err, { kind: "error" }); go.textContent = "Recompress"; }
        go.disabled = false;
      } }, "Recompress");
      return h("div", { class: "saved-pop-this" },
        h("div", { class: "saved-pop-title", text: "This paste" }),
        h("label", { class: "saved-pop-row" }, h("span", { text: "Quality" }), local(() => qv, (v) => { qv = v; }, 10, 100, 5, "%")),
        h("label", { class: "saved-pop-row" }, h("span", { text: "Largest side" }), local(() => mv, (v) => { mv = v; }, 0, 4000, 100, "px", "as it is")),
        h("div", { class: "saved-pop-row" }, h("span", { class: "saved-pop-note", text: "From the original, kept for ten minutes." }), go));
    }
    const at = chip.getBoundingClientRect();
    pop.style.top = at.bottom + 8 + "px";
    pop.style.right = Math.max(8, innerWidth - at.right) + "px";
    paint();
    const away = (e) => { if (!pop.contains(e.target) && !chip.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    function close() { pop.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); chipTimer = setTimeout(hide, 1500); }
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    document.body.append(pop);
  }

  /* ── full-screen viewer over every picture in the open note ─────────────── */
  function viewImages(view, from = -1, note = editor.path, extra = {}) {
    const text = view.state.doc.toString();
    let list = imagesIn(text).map((e) => {
      const url = resolveImage(e.target, note);
      if (!url) return null;
      const f = /^(https?:|data:)/i.test(e.target) ? null : app.vault.resolveFile(e.target, note);
      return { ...e, url, path: f ? f.path : null, name: f ? f.path.slice(f.path.lastIndexOf("/") + 1) : e.target.slice(0, 80) };
    }).filter(Boolean);
    // the note's videos step in between, where they stand in the text
    const VID = /!\[\[([^\[\]|#\n]+\.(?:mp4|webm|mov|mkv|m4v|ogv))(?:[|#][^\]\n]*)?\]\]/gi;
    for (let mm; (mm = VID.exec(text)); ) {
      const f = app.vault.resolveFile(mm[1].trim(), note);
      if (f) list.push({ from: mm.index, to: mm.index + mm[0].length, target: mm[1].trim(), url: assetOf(f.path), path: f.path, name: f.path.slice(f.path.lastIndexOf("/") + 1), video: true });
    }
    list.sort((a, b) => a.from - b.from);
    list = withoutHeldPictures(list, from, app.settings.webPictures === "always", shownPics);
    if (!list.length) return toast("No pictures or videos in this note");
    const at = list.findIndex((x) => x.from === from);
    if (at >= 0 && extra.t) list[at].startAt = extra.t;
    openViewer(list, at < 0 ? 0 : at, {
      ...app.imageActions(),
      playMedia: (it, t) => { app.media.playList([it.path], 0); if (t) setTimeout(() => app.media.seek && app.media.seek(t), 400); },
      // Delete in the viewer: the picture leaves the note; Shift+Delete: its file goes to the trash too
      remove: async (it, withFile) => {
        const line = view.state.doc.sliceString(it.from, it.to);
        if (!line || !line.startsWith("!")) { toast("The note has changed under it - delete it in the note"); return false; }
        const others = withFile && it.path ? picturesUsedIn([it.path], note) : [];
        const ok = await confirmDialog(withFile ? `Delete “${it.name}”?` : `Take “${it.name}” out of the note?`,
          withFile ? `It leaves this note and its file goes to the trash.${others.length ? ` ${others.length} other note${others.length > 1 ? "s" : ""} still show it and keep their links - the message after offers to take it out of them too.` : ""} Ctrl+Z in the note brings both back.`
            : "The file stays where it is. Ctrl+Z in the note puts it back.",
          { ok: withFile ? "Move to the trash" : "Take it out", danger: true });
        if (!ok) return false;
        const doc = view.state.doc;
        const ln = doc.lineAt(it.from);
        const alone = ln.text.trim() === line;
        const change = alone ? { from: ln.from, to: Math.min(ln.to + 1, doc.length) } : { from: it.from, to: doc.sliceString(it.to, it.to + 1) === " " ? it.to + 1 : it.to };
        const tr = view.state.update({ changes: change, userEvent: "delete" });
        view.dispatch(tr);
        // the others in the viewer keep pointing at their place in the text
        for (const x of list) if (x !== it) { x.from = tr.changes.mapPos(x.from, 1); x.to = tr.changes.mapPos(x.to, -1); }
        if (withFile && it.path) await trashPictures(note, [it.path], view);
        else toast(`The link to “${it.name}” left the note - the file stays`, { ms: 7000, actions: [{ label: "Undo", run: () => { cmUndo(view); view.focus(); } }, deleteAction([it.path], (p) => trashPictures(note, p, view))] });
        return true;
      },
      jump: (it) => {
        const len = view.state.doc.length;
        view.dispatch({ selection: { anchor: Math.min(it.to, len) }, scrollIntoView: true });
        view.focus();
      },
    });
  }
  app.editor = editor;
  app.zettel = createZettel(app);
  // a note picked by name, for whatever asks (a link to write, a missing note found again)
  app.pickNote = ({ title, onPick, places }) => openPalette(app, "pick", { placeholder: title, onPick, places, force: true });
  /* What a link points at: a note, a place in it (a heading, or a paragraph - which gets a ^id at its
     end, the way Obsidian links paragraphs), or a file outside the vault (by its file:/// address). */
  app.linkTo = async (path, at = {}) => {
    if (at.abs) return { url: "file:///" + encodeURI(at.abs.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\(/g, "%28").replace(/\)/g, "%29"), name: at.name || basename(at.abs) };
    const base = app.vault.linkText(path);
    if (at.heading) return base + "#" + at.heading.replace(/[#|^:\[\]]/g, " ").replace(/\s+/g, " ").trim();
    if (at.line == null) return base;
    const n = app.vault.get(path);
    const lines = n.content.split("\n");
    const line = lines[at.line] || "";
    const had = /\s\^([A-Za-z0-9-]+)\r?$/.exec(line);
    if (had) return base + "#^" + had[1];
    const id = Math.random().toString(36).slice(2, 8);
    lines[at.line] = line.replace(/\s*(\r?)$/, ` ^${id}$1`);
    await app.vault.write(path, lines.join("\n"));
    return base + "#^" + id;
  };
  /** The line a link's place is on: "#Heading" or "#^id". */
  const placeLine = (path, place) => {
    const n = place && app.vault.get(path);
    if (!n) return null;
    const lines = n.content.split("\n");
    const want = place.replace(/^#/, "").trim();
    const i = want.startsWith("^")
      ? lines.findIndex((l) => l.replace(/\r$/, "").endsWith(" " + want))
      : lines.findIndex((l) => { const h = /^#{1,6}\s+(.+?)\s*#*\r?$/.exec(l); return h && h[1].replace(/[#|^:\[\]]/g, " ").replace(/\s+/g, " ").trim().toLowerCase() === want.toLowerCase(); });
    return i >= 0 ? i : null;
  };
  app.isDirty = (p) => dirty.has(p);
  app.noteIds = mountNoteIds(app);
  // the pictures' shapes live in the vault too (livepreview.js)
  if (host.picsLoad) setPictureStore({ root: app.vault.root, load: host.picsLoad, save: host.picsSave });
  // a vault or outpost on a network share keeps showing its own pictures (mdparse.js isWebPicture)
  const ownRoots = () => setOwnPictureRoots([app.vault.root, ...outpostList(app).map((o) => o.path)]);
  ownRoots();
  app.bus.on("settings", (k) => { if (k === "outposts" || k === "vault") ownRoots(); });

  /**
   * A trailing debounce with a ceiling. 350 ms of quiet saves, and so does
   * 1.5 s of unbroken typing: a plain debounce never fires while the keys keep
   * coming, which is exactly the moment there is most to lose. So a crash can
   * cost at most a second and a half of typing, not a whole paragraph.
   */
  const SAVE_IDLE = 350;
  const SAVE_CEILING = 1500;
  const saveSoon = (() => {
    let t = null;
    let since = 0;
    const run = () => { t = null; since = 0; for (const p of [...dirty]) flushSave(p); };
    const d = () => {
      const now = performance.now();
      if (!since) since = now;
      clearTimeout(t);
      t = setTimeout(run, Math.max(0, Math.min(SAVE_IDLE, since + SAVE_CEILING - now)));
    };
    d.flush = () => { if (t) { clearTimeout(t); run(); } };
    d.cancel = () => { clearTimeout(t); t = null; since = 0; };
    return d;
  })();
  function flushSave(p) {
    if (!dirty.has(p)) return Promise.resolve();
    dirty.delete(p);
    // The note can be open in both panes, each with its own copy. The pane
    // that last typed into THIS note is the one holding the newest text -
    // focus is not evidence, and letting it decide meant that typing in the
    // split and then clicking into the main pane saved the main pane's older
    // copy and pushed it back over what had just been typed.
    const eds = [editor, ...(split ? split.editors : []), ...roomEds].filter((x) => x && x.has(p));
    const src = pickWriter(eds, p, lastTyped.get(p));
    lastTyped.delete(p);
    // no pane holds it: a write that failed is tried again from the model
    const c = src ? src.content(p) : app.vault.failed.has(p) ? app.vault.get(p)?.content : null;
    setSaveState();
    if (c == null || !app.vault.notes.has(p)) return Promise.resolve();
    for (const x of eds) if (x !== src) x.applyExternal(p, c);
    // a note in an older encoding (Windows-1251, UTF-16 from Notepad): its unreadable letters are saved as they show,
    // once said - the file as it was goes to the trash first
    if (notUtf8(app.vault.get(p), p) && !saidEncoding.has(p)) { saidEncoding.add(p); toast(`“${basename(p)}” has letters that could not be read (shown as �) and are saved that way. If the file was in another encoding, it was put in the trash as it was before this save.`, { ms: 15000 }); }
    return app.vault.write(p, c);
  }
  const saidEncoding = new Set();
  const flushAll = () => Promise.all([...dirty].map(flushSave));
  // into another pane while a note waits to be saved: saved first - the same note in two panes, typed into one and
  // then the other within the save's pause, kept only the second pane's copy
  document.addEventListener("focusin", (e) => { if (dirty.size && e.target.closest && e.target.closest(".cm-editor")) flushAll(); }, true);

  /** Put `content` into every editor holding `path` (a restore, an undo). */
  app.replaceInEditors = (path, content) => {
    dirty.delete(path);
    lastTyped.delete(path);
    for (const ed of [editor, ...(split ? split.editors : []), ...roomEds]) if (ed && ed.has(path)) ed.replace(path, content);
    setSaveState();
  };

  // "Restore an earlier version of this note…" - the versions themselves are
  // kept by the Rust side on every write that would lose a lot (notehist.rs)
  app.openVersions = async (path = app.currentPath()) => {
    if (!path) return toast("Open a note first");
    await flushSave(path);
    const mod = await import("./noteversions.js");
    return mod.openVersions(app, path);
  };

  const refreshLinks = debounce(() => { editor.refresh(); if (split) for (const ed of split.editors) ed.refresh(); }, 150);
  app.vault.bus.on("structure", refreshLinks);

  async function openLink(target, newTab, from = editor.path, place = "") {
    const p = app.vault.resolve(target, from);
    if (p) { const line = placeLine(p, place); return app.openNote(p, line == null ? { newTab } : { newTab, line }); }
    // a link to a video, a song, a PDF or any other file opens that file -
    // and never makes an empty note called "clip.mp4"
    const clean = String(target || "").split("|")[0].split("#")[0].trim();
    const f = app.vault.resolveFile(clean, from);
    if (f) return app.openFile(f.path, { newTab });
    // a note in a folder left out of indexing: opened from the disk (never an empty new note of the same name)
    const off = app.vault.unindexedFor(clean);
    if (off) return app.openExternal(`${String(app.vault.root || "").replace(/[\\/]+$/, "")}/${off}`, { newTab });
    // an ending with a letter in it is a file type (.mp4, .pdf); "13.11.2026" is a date, a note's name
    if (/\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,8}$/i.test(clean) && !/\.md$/i.test(clean)) { toast(`${clean} is not in the vault`, { ms: 2600 }); return; }
    const name = basename(clean); // [[New#Heading|alias]] makes "New", not "New Heading alias"
    // [[What?]] is the note What.md: a name a file cannot hold is found by the name it was saved under, not made
    // again - in the folder the link names, if it names one
    const saved = app.vault.resolve(clean.includes("/") ? joinPath(dirname(clean), safeName(name)) : safeName(name), from);
    if (saved) return app.openNote(saved, { newTab });
    const dir = clean.includes("/") ? dirname(clean) : app.settings.newNoteDir === "current" && from ? dirname(from) : app.newNoteDir();
    if (dir && !app.vault.folders.has(dir)) await app.vault.createFolder(dir).catch(() => {});
    try {
      const created = await app.vault.create(dir, name, "");
      app.openNote(created, { newTab });
    } catch (e) { toast(`Could not make a note called “${name}”: ${(e && e.message) || e}`, { kind: "error", ms: 5000 }); }
  }

  /* ── tabs, spaces & navigation ────────────────────────────────────────── */
  // Tabs hold documents (notes, files) and the views you pinned. Opening a
  // view from the sidebar does NOT create a tab: it shows in the "floating"
  // slot until you open a document. Each space keeps its own set of tabs.
  let tabs = [];
  let active = -1; // -1: the floating slot is showing
  let floating = { kind: "view", view: "home", back: [], fwd: [] };
  let seq = 0;
  const closed = [];
  const tabsEl = $("#tabs");
  const views = {};
  const mounts = { home: mountHome, tasks: mountTasks, habits: mountHabits, calendar: mountCalendar, settings: mountSettings, focus: mountAreas, timer: mountTimer,
    // the graph and the workout load on first use (about 230 KB that a start without them never reads)
    graph: (a, el) => { let v = null; const ready = import("./graph.js").then((m) => { v = m.mountGraph(a, el); if (!el.hidden) v.show(); }); return { show: (o) => (v ? v.show(o) : ready) }; },
    fit: (a, el) => { let v = null; let want = null; const ready = import("./fitview.js").then((m) => { v = m.mountFit(a, el); v.show(want || {}); }); return { show: (o) => (v ? v.show(o) : ((want = o || want), ready)) }; },
    // the assistant loads on first use; what was asked of it before it was up waits for it
    // the AI home: the box, then Chat (the Assistant), Activity, Skills, Access, Setup
    assistant: (a, el) => { let v = null; let wait = null; const ready = import("./aihome.js").then((m) => { v = m.mountAiHome(a, el); if (wait) v.ask(wait); else v.show(); }); return { show: () => (v ? v.show() : ready), ask: (o) => (v ? v.ask(o) : (wait = o)), adopt: (m) => (v ? v.adopt(m) : ready.then(() => v.adopt(m))), project: (o) => (v ? v.project(o) : ready.then(() => v.project(o))) }; },
    // a project seen as a whole: its brief, files, map, board, tasks and chats (projectroom.js)
    room: (a, el) => { let v = null; let wait = null; const ready = import("./projectroom.js").then((m) => { v = m.mountRoom(a, el); v.open(...(wait || [])); }); return { show: () => (v ? v.show() : ready), open: (f, l) => (v ? v.open(f, l) : (wait = [f, l])) }; },
    // a space's project: find and replace across a folder, go to file, git
    project: (a, el) => { let v = null; let wait = null; import("./projectview.js").then((m) => { v = m.mountProject(a, el); v.show(wait || {}); }); return { show: (o) => (v ? v.show(o) : (wait = o || wait)) }; },
    // the player loads on first use
    music: (a, el) => { let v = null; const ready = import("./musicview.js").then((m) => { v = m.mountMusic(a, el); if (!el.hidden) v.show && v.show(); }); return { show: () => (v ? v.show && v.show() : ready), addLink: (t, how) => ready.then(() => v.addLink(t, how)) }; },
    // so does the search page
    search: (a, el) => {
      let v = null;
      const ready = import("./searchview.js").then((m) => { v = m.mountSearch(a, el); v.show(); return v; });
      return { show: () => (v ? v.show() : ready), open: (o) => (v ? v.open(o) : ready.then((x) => x.open(o))) };
    },
    // Docs: ready texts, a click from the clipboard
    // what takes the room, anywhere on the PC (sizes.js)
    space: (a, el) => { let v = null; const ready = import("./sizes.js").then((m) => { v = m.mountSpace(a, el); v.show(); }); return { show: () => (v ? v.show() : ready) }; },
    phone: (a, el) => { let v = null; const ready = import("./phoneview.js").then((mod) => { v = mod.mountPhone(a, el); v.show(); }); return { show: () => (v ? v.show() : ready) }; },
    docs: (a, el) => { let v = null; const ready = import("./docsview.js").then((mod) => { v = mod.mountDocs(a, el); v.show(); }); return { show: () => (v ? v.show() : ready) }; },
    // web shortcuts: the list is in settings, the windows are Rust's
    web: (a, el) => { let v = null; const ready = import("./webpanel.js").then((m) => { v = m.mountWeb(a, el); v.show(); }); return { show: () => (v ? v.show() : ready) }; } };
  let fileView = null;
  let extView = null;
  let lastNote = null;
  let spaces = [];
  let space = null;
  let groups = []; // tab groups of the current space (tabgroups.js)
  let spacesUi = { paint() {} };

  // a browser tab is itself and no other, whatever page it is on: its `wid` says which
  const loc = (t) => (t.kind === "view" ? { kind: "view", view: t.view } : t.kind === "web" ? { kind: "web", path: t.path || "", wid: t.wid, ...(t.title ? { title: t.title } : {}) } : { kind: t.kind, path: t.path });
  const same = (a, b) => a.kind === b.kind && (a.kind === "view" ? a.view === b.view : a.kind === "web" ? !!a.wid && a.wid === b.wid : a.path === b.path);
  const cur = () => (active >= 0 && tabs[active]) || floating;
  const isDoc = (l) => l.kind === "note" || l.kind === "file";
  // what may sit in the split view: documents, and files outside the vault
  const canSplit = (l) => isDoc(l) || l.kind === "ext";
  const outpostOf = (p) => { const s = String(p).toLowerCase(); return outpostList(app).find((o) => { const r = String(o.path).replace(/[\\/]+$/, "").toLowerCase(); return s === r || s.startsWith(r + "\\") || s.startsWith(r + "/"); }); };
  const extIcon = (p) => (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p) ? "image" : /\.(mp3|wav|ogg|m4a|flac|aac|opus|wma)$/i.test(p) ? "music" : /\.(mp4|mkv|webm|mov|avi|m4v)$/i.test(p) ? "play" : /\.(md|txt|pdf)$/i.test(p) ? "fileText" : "file");
  // files outside the vault: nothing indexes them, so a tab counts as real
  // until a stat says otherwise (at startup, or when the view tries to open it)
  const extGone = new Set();
  const exists = (l) => (l.kind === "note" ? app.vault.notes.has(l.path) : l.kind === "file" ? app.vault.files.has(l.path) || guests.has(l.path) : l.kind === "ext" ? !extGone.has(l.path) : l.kind === "web" ? true : !!mounts[l.view]);
  // `from`: the tab that was in front when this one was opened. Kept in memory
  // only (never saved): closing a tab goes back to where it was opened from,
  // so a run of pictures opened one after another closes with Ctrl+W held,
  // walking back along the way they came, and ends on the note they began at.
  // tabs opened in this session (not brought back from the last one) wear a small mark, so the new ones stand out
  const freshTabs = new Set();
  let restoringTabs = false;
  // marked by tab, not by place: a duplicate (Ctrl+D) is a copy, not something new, and leaves the original as it was
  let dupping = false;
  const mkTab = (l, extra) => { const t = mkTab0(l, extra); if (!restoringTabs && !dupping) freshTabs.add(t.id); return t; };
  const mkTab0 = (l, extra) => {
    const t = { id: ++seq, back: [], fwd: [], from: active >= 0 && tabs[active] ? tabs[active].id : 0, fromView: active < 0 && floating.kind === "view" ? floating.view : null, ...l, ...extra, ...homePin(l) };
    // every page tab is told apart by its wid: one without (a duplicate, a tab from an older session) never
    // matched itself, so Back / Forward opened its page again as a new tab every time
    if (t.kind === "web" && !t.wid) t.wid = "w" + Date.now().toString(36) + "t" + t.id;
    return t;
  };
  // the Home tab stays in view, pinned, in every space - until you unpin one (then none is pinned by itself)
  const homePin = (l) => (l.kind === "view" && l.view === "home" && app.settings.homeTabPinned !== false ? { pinned: true, full: true } : {});
  const fileName = (p) => p.slice(p.lastIndexOf("/") + 1);
  let webTab = null;
  const flushCur = () => { const t = cur(); if (t.kind === "note" && dirty.has(t.path)) flushSave(t.path); if (t.kind !== "ext" && extView && extView.dirty) extView.flush(); };
  // a tab opened from a grouped tab joins its group
  const besideActive = () => (active >= 0 && tabs[active].group ? { group: tabs[active].group } : {});

  // re-apply the strip's rules (pinned first, groups together), keeping the active tab
  function reflow(next = TG.normalize(tabs, groups)) {
    const was = active >= 0 ? tabs[active] : null;
    ({ tabs, groups } = next);
    active = was ? tabs.indexOf(was) : -1;
  }

  function retarget(t, target, replace) {
    if (!replace) { t.back.push(loc(t)); if (t.back.length > 60) t.back.shift(); t.fwd = []; }
    delete t.path;
    delete t.view;
    delete t.wid;
    delete t.title;
    Object.assign(t, target);
  }

  /** The tab in front, again in a new tab beside it (a page at the address it is on now). */
  function duplicateTab() {
    const t = active >= 0 ? tabs[active] : null;
    if (!t) return;
    dupping = true;
    try { navigate(t.kind === "web" ? { kind: "web", path: t.path || "", ...(t.title ? { title: t.title } : {}) } : loc(t), { newTab: true }); } finally { dupping = false; }
  }
  function navigate(target, { newTab = false, replace = false, atEnd = false, background = false } = {}) {
    flushCur();
    // a document with an editor of its own (a video, a board, a drawing) is never open twice - two
    // editors of one file would save over each other; the one already open comes forward
    if (newTab && target.path && /\.(leovideo|leopaint|leocanvas|leostudio|leovector|excalidraw|canvas)$/i.test(target.path)) {
      const open = tabs.findIndex((x) => same(x, target));
      if (open >= 0) { active = open; return show(); }
    }
    if (newTab) {
      const t = mkTab(target, atEnd ? {} : besideActive());
      tabs.splice(active >= 0 && !atEnd ? active + 1 : tabs.length, 0, t);
      // opened behind: the tab is there, the one you are on stays in front
      if (background && active >= 0) { renderTabs(); saveSession(); return; }
      active = tabs.indexOf(t);
      return show();
    }
    // anything already open in a tab (a document, or a pinned view) is focused, never duplicated
    const open = tabs.findIndex((t) => same(t, target));
    if (open >= 0) { active = open; return show(); }
    if (target.kind === "view") {
      if (active >= 0) floating = { kind: "view", view: target.view, back: [loc(tabs[active])], fwd: [] };
      else if (!same(floating, target)) retarget(floating, target, replace);
      active = -1;
      return show();
    }
    // A document gets its own tab, next to the current one. Kinds listed in
    // tabReplaceKinds take over the current tab instead - only when that tab
    // shows the same kind, so a picture replaces a picture, never a note.
    const reuse = app.settings.tabReplaceKinds || [];
    if (active >= 0 && !tabs[active].pinned && reuse.includes(docKind(target)) && reuse.includes(docKind(tabs[active]))) {
      retarget(tabs[active], target, replace);
      return show();
    }
    const t = mkTab(target, besideActive());
    tabs.splice(active >= 0 ? active + 1 : tabs.length, 0, t);
    active = tabs.indexOf(t);
    show();
  }

  function docKind(l) {
    if (l.kind === "note") return "note";
    if (l.kind !== "file") return null;
    const f = app.vault.files.get(l.path);
    return f ? f.kind : "other";
  }

  function viewEl(id) {
    let el = $("#view-" + id);
    // a view without a container in index.html must never take startup down
    if (!el) {
      el = h("div", { class: "view", id: "view-" + id });
      $("#main").insertBefore(el, $("#statusbar"));
    }
    return el;
  }

  let shownEl = null;
  /** Run an enter animation once on an element that has just appeared. */
  function playOnce(el, cls = "is-entering", ms = 300) {
    if (!el || !motionOk()) return;
    // The reflow that restarts an animation costs a full layout of the view -
    // 30 ms with a few hundred rows in it - so it only happens when the class
    // is still on from a previous run, which is the rare case.
    if (el.classList.contains(cls)) { el.classList.remove(cls); void el.offsetWidth; }
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  // The view that becomes visible fades up 4 px. The graph keeps its own
  // render loop, so it is handed nothing to composite over.
  function enterView(el) {
    if (el === shownEl) return;
    shownEl = el;
    if (el && el.id !== "view-graph") playOnce(el);
  }
  app.playOnce = playOnce;

  function show() {
    let t = cur();
    if (!exists(t)) {
      if (active >= 0) { tabs.splice(active, 1); active = Math.min(active, tabs.length - 1); }
      else floating = { kind: "view", view: "home", back: [], fwd: [] };
      t = cur();
      if (!exists(t)) { active = -1; floating = { kind: "view", view: "home", back: [], fwd: [] }; t = floating; }
    }
    // reaching a tab tucked in a collapsed group (Ctrl+Tab, a link) opens the group
    const g = TG.groupOf(groups, active >= 0 ? t : null);
    if (g) g.collapsed = false;

    $("#view-note").hidden = t.kind !== "note";
    const fileEl = viewEl("file");
    fileEl.hidden = t.kind !== "file";
    const extEl = viewEl("ext");
    extEl.hidden = t.kind !== "ext";
    const webEl = viewEl("webtab"); // ("web" is the Web pages view)
    webEl.hidden = t.kind !== "web";
    if (webTab && t.kind !== "web") webTab.leave();
    for (const v of app.views) {
      const el = viewEl(v.id);
      const on = t.kind === "view" && t.view === v.id;
      el.hidden = !on;
      if (on && !views[v.id]) views[v.id] = mounts[v.id](app, el);
    }
    enterView(t.kind === "note" ? $("#view-note") : t.kind === "file" ? fileEl : t.kind === "ext" ? extEl : t.kind === "web" ? webEl : viewEl(t.view));

    if (fileView && t.kind !== "file" && fileView.dirty) fileView.flush();
    if (extView && t.kind !== "ext" && extView.dirty) extView.flush();
    if (t.kind === "note") {
      const n = app.vault.get(t.path);
      noteLayout = layoutOf(n.content);
      paintLayout();
      editor.open(t.path, n.content, { pos: app.positions[t.path] });
      lastNote = t.path;
      paintTitle();
      addRecent(t.path);
      document.title = `${n.title} - Leonote`;
    } else if (t.kind === "file") {
      if (!fileView) fileView = mountFileView(app, fileEl);
      fileView.show(t.path);
      addRecent(t.path); // the file search puts what was opened lately first
      document.title = `${fileName(t.path)} - Leonote`;
    } else if (t.kind === "ext") {
      if (!extView) extView = mountExtView(app, extEl, { makeEditor: (host, scroller, own) => { const ed = createEditor(host, noteEditorOptions(() => ed, scroller, own)); return ed; } });
      extView.show(t.path);
      document.title = `${osName(t.path)} - Leonote`;
    } else if (t.kind === "web") {
      if (!webTab) webTab = mountWebTab(app, webEl, {
        findTab: (wid) => tabs.find((x) => x.kind === "web" && x.wid === wid) || null,
        changed: () => { renderTabs(); saveSession(); const c = cur(); if (c.kind === "web") document.title = `${tabTitle(c)} - Leonote`; },
        // only the title moved: that tab's label, not the whole strip (a page can retitle itself every second)
        titled: (t) => {
          const el = [...tabsEl.querySelectorAll(".tab")].find((x) => x._tid === t.id), lab = el && el.querySelector(".tab-title");
          if (!lab) renderTabs(); else lab.textContent = tabInfo(t).title;
          saveSession();
          if (cur() === t) document.title = `${tabTitle(t)} - Leonote`;
        },
        newTab: (url) => app.newWebTab(url),
        replaceTab: (target) => { if (active >= 0 && tabs[active].kind === "web") { const w = tabs[active].wid; retarget(tabs[active], target, true); host.tabWebClose([w]).catch(() => {}); show(); if (target.kind === "note") editor.focus(); } else navigate(target); },
        closeSelf: () => { if (active >= 0 && tabs[active].kind === "web" && !tabs[active].path) closeTab(active); },
        linkInto: async (p, text) => { try { const n = app.vault.get(p); await app.vault.write(p, (n.content.replace(/\n*$/, "") + "\n\n" + text + "\n")); toast(`Linked in “${basename(p)}”`, { ms: 2400 }); } catch (e) { toast(String(e), { kind: "error" }); } },
      });
      webTab.show(t);
      document.title = `${tabTitle(t)} - Leonote`;
    } else {
      views[t.view].show && views[t.view].show();
      document.title = `${app.views.find((v) => v.id === t.view).name} - Leonote`;
    }
    recordTrail(t);
    renderTabs();
    status();
    app.bus.emit("view", t);
    saveSession();
  }

  function tabInfo(t) {
    if (t.kind === "note") return { title: basename(t.path), icon: "fileText", tip: t.path };
    if (t.kind === "file") {
      const f = app.vault.files.get(t.path);
      return { title: fileName(t.path), icon: KIND_ICON[f && f.kind] || "file", tip: t.path };
    }
    if (t.kind === "web") return { title: tabTitle(t), icon: t.path ? "globe" : "plus", tip: t.path || "New tab" };
    if (t.kind === "ext") {
      // a file in an outpost is half at home and looks like any file; a guest
      // - opened from anywhere else on the disk - is marked as one
      const o = outpostOf(t.path);
      if (o) return { title: osName(t.path), icon: extIcon(t.path), tip: `${o.name || o.path} (outpost) · ${t.path}`, outpost: true };
      return { title: osName(t.path), icon: "outside", tip: `Guest file, outside the vault · ${t.path}`, ext: true };
    }
    const v = app.views.find((x) => x.id === t.view) || { name: t.view, icon: "file" };
    return { title: v.name, icon: v.icon, tip: v.name };
  }

  function tabEl(t, i) {
    const inf = tabInfo(t);
    const look = tabLookOf(t, app.settings.tabColorStyle);
    const stuck = t.pinned && t.full;
    const el = h("div", {
      class: "tab" + (t.kind === "ext" ? (outpostOf(t.path) ? " is-outpost" : " is-ext") : "") + (i === active ? " is-active" : "") + (picked.has(t.id) ? " is-picked" : "") + (t.kind === "file" && app.media.isPlaying(t.path) ? " is-playing" : "") + (t.mini && !stuck ? " is-pinned" : "") + (stuck ? " is-stuck" : "") + (t.kind === "note" && dirty.has(t.path) ? " is-dirty" : "") + (freshTabs.has(t.id) && !t.pinned && !t.mini ? " is-new" + (t.kind === "web" && !t.path ? " is-blank" : "") : "") + (look.color ? " has-color" + look.fx.map((f) => " fx-" + f).join("") : "") + (look.bold ? " is-bold" : "") + (look.italic ? " is-italic" : "") + (look.dim ? " is-dim" : "") + (look.caps ? " is-caps" : "") + (look.size ? " is-size-" + look.size : ""),
      // no title: the card (showTabPeek) says the name and the rest, styled - Windows' own black tooltip came up
      // under it, or alone after a click on the tab
      dataset: { i: String(i), hint: [stuck ? "Pinned" : t.mini ? "Minimized" : "", i < 8 ? `Ctrl+${i + 1}` : "", "Shift or Ctrl+click picks several"].filter(Boolean).join(" · ") }, "aria-label": inf.tip, draggable: true,
      style: look.color ? { "--tc": look.color } : null,
    },
      // a page playing sound: the speaker stands in for its icon, a click mutes it
      t.kind === "web" && (t.audio || t.muted) ? h("button", { class: "tab-sound" + (t.muted ? " is-muted" : ""), dataset: { mute: String(i) }, title: t.muted ? "Unmute this page" : "Mute this page" }, icon(t.muted ? "volumeOff" : "volume"))
        : look.noIcon && !t.mini && !stuck ? null
        // a page shows its site's own icon, one small copy per site (favicons.js)
        : t.kind === "web" && t.path && !look.icon && faviconOf(t.path) ? h("img", { class: "tab-fav", src: faviconOf(t.path), alt: "" })
        : icon(look.icon || inf.icon),
      t.mini || stuck ? null : h("span", { class: "tab-title", text: inf.title }),
      t.pinned || t.mini ? null : h("button", { class: "tab-close", dataset: { close: String(i) }, title: "Close (Ctrl+W)" }, icon("x")));
    el._tid = t.id; // for the enter/leave animations, which diff by tab id
    // which tab is showing, for a screen reader (no tab role: it would hide the close and sound buttons inside)
    if (i === active) el.setAttribute("aria-current", "page");
    if (seenTabs.size && !seenTabs.has(t.id)) el.classList.add(t.id === rebornId ? "is-back" : "is-in");
    return el;
  }

  // A group is its chip followed by its tabs. Collapsed, the chip is just a
  // dot and a count (plus the name when tabGroupNames is on).
  function groupEl(g, members) {
    const gl = groupLookOf(g);
    const named = !!g.name && (!g.collapsed || !!app.settings.tabGroupNames || gl.keepName);
    // only a group that was not on the strip a moment ago grows in; a redraw
    // (a video starting to play, a save) must not replay it
    const fresh = seenGroups.size && !seenGroups.has(g.id) ? " is-new" : "";
    return h("div", { class: "tg" + fresh + (g.collapsed ? " is-collapsed" : "") + (gl.wash ? " is-wash" : "") + (gl.noLine ? " no-line" : ""), dataset: { group: g.id }, style: { "--gc": TG.colorVar(g.color), "--n": String(members.length) } },
      h("div", {
        class: "tg-chip" + fresh + (g.collapsed ? " is-collapsed" : "") + (named ? "" : " is-bare") + (gl.chip ? " is-" + gl.chip : "") + (gl.bold ? " is-bold" : "") + (gl.italic ? " is-italic" : "") + (gl.caps ? " is-caps" : "") + (gl.size ? " is-size-" + gl.size : ""), dataset: { group: g.id }, draggable: true,
        role: "button", "aria-expanded": String(!g.collapsed), "aria-label": `${g.name || "Unnamed"} group, ${members.length} tab${members.length === 1 ? "" : "s"}`,
      },
        gl.icon ? icon(gl.icon, "tg-ico") : h("span", { class: "tg-dot" }),
        named ? h("span", { class: "tg-label", text: g.name }) : null,
        g.collapsed ? h("span", { class: "tg-count", text: String(members.length) }) : null),
      g.collapsed ? null : members.map((i) => tabEl(tabs[i], i)));
  }

  // Tab motion: new tabs grow in, closed ones leave a ghost that shrinks, and
  // one accent bar slides to whichever tab is active. All of it is diffed by
  // tab id off the strip that is already on screen, before it is replaced.
  const seenTabs = new Set();
  const seenGroups = new Set();
  let lastTabCount = 0;
  const tabInd = h("div", { class: "tab-ind" });
  // tabs resize with the window, the sidebar and their own count; the bar
  // follows without a repaint of the strip
  const indRo = new ResizeObserver(() => paintTabInd(true));

  function paintTabInd(instant) {
    if (!tabInd.isConnected) tabsEl.append(tabInd);
    const el = tabsEl.querySelector(".tab.is-active");
    if (!el || !motionOk()) { tabInd.classList.remove("is-on"); return; }
    // offsets, not client rects: a tab still growing in is scaled, and the bar
    // must land where it will be, not where the animation has it this frame
    let left = 0;
    for (let n = el; n && n !== tabsEl; n = n.offsetParent) left += n.offsetLeft;
    const width = el.offsetWidth;
    if (!width) { tabInd.classList.remove("is-on"); return; }
    // a pin is a 24px chip: a short mark, centred under it
    const pad = el.classList.contains("is-stuck") ? 6 : el.classList.contains("is-pinned") ? 9 : 10;
    const x = `translateX(${Math.round(left + pad)}px)`;
    const w = Math.max(el.classList.contains("is-stuck") ? 6 : 10, Math.round(width - pad * 2)) + "px";
    // the resize observer calls straight back in: stop when nothing moved
    if (x === tabInd.style.transform && w === tabInd.style.width && tabInd.classList.contains("is-on")) return;
    if (instant) tabInd.style.transition = "none";
    tabInd.style.transform = x;
    tabInd.style.width = w;
    tabInd.style.setProperty("--tc", el.style.getPropertyValue("--tc") || "var(--accent)");
    tabInd.classList.add("is-on");
    if (instant) requestAnimationFrame(() => (tabInd.style.transition = ""));
    indRo.disconnect();
    indRo.observe(tabsEl);
    indRo.observe(el);
  }

  let shownActive = null;
  // Pinned tabs stay in view at the left while the rest scroll under them:
  // each sticks just right of the pinned ones before it.
  function placeStuck() {
    // after the workspace's Home, when the space has one
    const ws = tabsEl.querySelector(":scope > .tab-ws.is-held");
    let left = ws ? ws.offsetWidth + 4 : 0;
    // pinned tabs are small chips held at the strip's left corner, whatever scrolls
    for (const el of tabsEl.querySelectorAll(":scope > .tab.is-stuck")) { el.style.left = left + "px"; left += el.offsetWidth + 4; }
  }
  /* Pages playing sound, beside the mini player in the status bar: one small
     button each (its site's icon), a click goes to that tab - in whatever space
     it is - and a right-click plays, pauses, mutes, sets its loudness or closes
     it. A page paused from here stays listed, dimmed, so it can be played again. */
  const playingEl = h("span", { class: "sb-playing" });
  const pausedHere = new Set(); // wids paused from this menu
  const loud = new Map(); // wid -> the loudness last set from here
  // a button closed from its menu stays away until its page goes quiet and starts sounding again
  const dismissed = new Set();
  const wasSounding = new Map();
  function soundingTabs() {
    const out = [];
    const here = active >= 0 ? tabs[active] : null;
    for (const s of spaces) {
      const list = s === space ? tabs : s.tabs || [];
      for (const t of list) {
        if (t.kind !== "web" || !t.wid) continue;
        const sounding = !!t.audio;
        if (!sounding && wasSounding.get(t.wid)) dismissed.delete(t.wid);
        wasSounding.set(t.wid, sounding);
        if (!(sounding || pausedHere.has(t.wid)) || dismissed.has(t.wid)) continue;
        // the tab you are on needs no button: its own speaker is right there in the strip
        if (t === here) continue;
        out.push({ t, s });
      }
    }
    return out;
  }
  function goToTab(t, s) {
    if (s !== space) spacesApi.switchTo(s.id);
    const i = tabs.findIndex((x) => x === t || (x.kind === "web" && x.wid === t.wid));
    if (i < 0) return;
    flushCur();
    active = i;
    show();
  }
  function paintPlaying() {
    const list = soundingTabs();
    for (const w of [...pausedHere]) if (!list.some(({ t }) => t.wid === w)) pausedHere.delete(w);
    playingEl.hidden = !list.length;
    playingEl.replaceChildren(...list.map(({ t, s }) => {
      const paused = !t.audio && pausedHere.has(t.wid);
      const fav = t.path && faviconOf(t.path);
      const where = s === space ? "" : ` · in ${s.name}`;
      const b = h("button", { class: "sb-sound" + (paused ? " is-paused" : "") + (t.muted ? " is-muted" : ""), title: `${tabTitle(t)}${where}${paused ? " · paused" : t.muted ? " · muted" : ""}\nClick: go there · right-click: play, pause, loudness`,
        onclick: () => goToTab(t, s),
        oncontextmenu: (e) => {
          e.preventDefault();
          const post = (m) => host.tabWebPost(t.wid, m).catch(() => {});
          const now = loud.get(t.wid) ?? 1;
          menu(e.clientX, e.clientY - 8, [
            { header: tabTitle(t).slice(0, 48) },
            { label: "Go to it", icon: "outside", run: () => goToTab(t, s) },
            paused ? { label: "Play", icon: "play", run: () => { pausedHere.delete(t.wid); post("leo:play"); paintPlaying(); } }
              : { label: "Pause", icon: "pause", run: () => { pausedHere.add(t.wid); post("leo:pause"); paintPlaying(); } },
            { label: t.muted ? "Sound on" : "Mute", icon: t.muted ? "volume" : "volumeOff", run: () => host.tabWebMute(t.wid, !t.muted).then(() => { t.muted = !t.muted; renderTabs(); }).catch((err) => toast(String(err), { kind: "error" })) },
            { label: "Loudness", icon: "volumeLow", sub: [[1, "Full"], [0.75, "75%"], [0.5, "Half"], [0.25, "Quiet"], [0.1, "Barely"]].map(([v, label]) => ({ label, checked: Math.abs(now - v) < 0.01, run: () => { loud.set(t.wid, v); post("leo:vol:" + v); } })) },
            "sep",
            { label: "Close", icon: "x", run: () => { dismissed.add(t.wid); pausedHere.delete(t.wid); paintPlaying(); } },
          ]);
        } }, fav ? h("img", { src: fav, alt: "" }) : icon(t.muted ? "volumeOff" : "volume"));
      return b;
    }));
  }

  // in a workspace's space, a tiny first tab: the workspace's room
  function wsTab() {
    const folder = space && workspaceSpaceIds(app).get(space.id);
    const p = folder && app.projectAt(folder);
    if (!p) return [];
    const t = cur();
    const on = !!t && t.kind === "view" && t.view === "room";
    const pinned = app.settings.wsHomePinned !== false;
    return [h("button", { class: "tab-ws" + (on ? " is-on" : "") + (pinned ? " is-held" : ""), title: `${p.name}: the workspace's home (Alt+R) · right-click: ${pinned ? "unpin" : "pin"}`, onclick: (e) => { e.stopPropagation(); app.openRoom(folder); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY, [{ header: `${p.name} · Home` }, { label: "Open the workspace's home", icon: "home", run: () => app.openRoom(folder) },
        pinned ? { label: "Unpin - scrolls with the tabs", icon: "pin", run: () => { app.setSetting("wsHomePinned", false); renderTabs(); } } : { label: "Pin - stays at the left", icon: "pin", run: () => { app.setSetting("wsHomePinned", true); renderTabs(); } }]); } },
      icon("home"), h("span", { text: "Home" }))];
  }

  function renderTabs() {
    paintPlaying();
    reflow();
    // a tab arriving, moving or being grouped is not "closing several", so
    // the held width goes at once rather than waiting for its timer
    if (holdTimer && tabs.length > lastTabCount) releaseWidths();
    lastTabCount = tabs.length;
    if (TG.peekOpen()) TG.closeGroupPop();
    // measure what is leaving while it is still laid out
    const ghosts = [];
    if (motionFull() && seenTabs.size) {
      const live = new Set(tabs.map((t) => t.id));
      const kids = [...tabsEl.children];
      for (const el of tabsEl.querySelectorAll(".tab")) {
        if (!el._tid || live.has(el._tid) || !el.offsetWidth) continue;
        // a grouped tab's ghost goes INSIDE its group at the tab's own place - put before the
        // group, it shoved the whole group (every tab to the left of the closed one) along
        const tg = el.closest(".tg");
        if (tg) ghosts.push({ group: tg.dataset.group, at: [...tg.children].indexOf(el), gat: kids.indexOf(tg), gw: tg.offsetWidth, w: el.offsetWidth });
        else ghosts.push({ at: kids.indexOf(el), w: el.offsetWidth });
      }
    }
    const first = !seenTabs.size;
    const keepScroll = tabsEl.scrollLeft;
    const wasWide = tabsEl.scrollWidth; // before the closed tab goes: the strip must not get narrower under a held row
    tabsEl.replaceChildren(
      ...wsTab(),
      ...TG.stripItems(tabs, groups).map((it) => (it.kind === "tab" ? tabEl(tabs[it.index], it.index) : groupEl(it.group, it.tabs))),
      h("button", { class: "tab-new", title: "New tab (Ctrl+T) · right-click for a new note, sketch, drawing, board…", dataset: { newtab: "1" } }, icon("plus")));
    seenTabs.clear();
    for (const t of tabs) seenTabs.add(t.id);
    seenGroups.clear();
    seenGroups.add("");
    for (const g of groups) seenGroups.add(g.id);
    if (ghosts.length && tabsEl.classList.contains("is-holding") && keepScroll > 0) {
      // the row was scrolled: whatever width the strip lost, the slack gives back, so the scroll cannot clamp and shove the row right
      slackEl.style.width = "0px";
      tabsEl.append(slackEl);
      const deficit = wasWide - tabsEl.scrollWidth + ghosts.reduce((n, g) => n + g.w, 0);
      if (deficit > 0) slackEl.style.width = deficit + "px"; else slackEl.remove();
    }
    for (const g of ghosts.slice(0, 3)) {
      let home = tabsEl, at = g.at, w = g.w;
      if (g.group) {
        const tg = tabsEl.querySelector(`.tg[data-group="${g.group}"]`);
        if (tg) home = tg; else { at = g.gat; w = g.gw; } // the group went with its last tab: its whole width closes up
      }
      const ghost = h("div", { class: "tab-ghost", style: { width: w + "px" } });
      home.insertBefore(ghost, home.children[Math.max(0, at)] || null);
      requestAnimationFrame(() => (ghost.style.width = "0px"));
      setTimeout(() => ghost.remove(), 300);
    }
    const el = tabsEl.querySelector(".tab.is-active");
    tabsEl.scrollLeft = keepScroll;
    const nowActive = active >= 0 && tabs[active] ? tabs[active].id : null;
    if (el && (first || nowActive !== shownActive)) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      // on the last tab the + after it comes into view as well
      if (active === tabs.length - 1) tabsEl.scrollLeft = tabsEl.scrollWidth;
    }
    shownActive = nowActive;
    placeStuck();
    paintTabInd(first || inkSnap);
    inkSnap = false;
    // A closed tab's ghost closes up and the tabs after it slide left - they
    // move without changing size, which the resize observer never sees, so the
    // bar stayed where the active tab had been: under its neighbour. While
    // anything is closing up, the bar follows frame by frame.
    if (ghosts.length) {
      const until = performance.now() + 380;
      const follow = () => { paintTabInd(true); if (performance.now() < until) requestAnimationFrame(follow); };
      requestAnimationFrame(follow);
    }
  }

  const paintTabColorStyle = () => { tabsEl.dataset.color = ["line", "tint", "fill"].includes(app.settings.tabColorStyle) ? app.settings.tabColorStyle : "tint"; };
  paintTabColorStyle();
  app.bus.on("settings", (k) => { if (k === "tabGroupNames") renderTabs(); if (k === "tabColorStyle") { paintTabColorStyle(); renderTabs(); } });
  app.media.bus.addEventListener("change", () => renderTabs());

  // The middle button over the tabs works like the browser's autoscroll: from
  // where it was pressed, the further the pointer is to one side the faster
  // the strip runs that way. Held, it ends on release; clicked, it stays on
  // until the next press or Esc. It does not close a tab - with a long strip
  // that is too easy to do by accident (Ctrl+W and the x still close).
  let tabGlide = null;
  // the autoscroll's pace at `a` pixels from where the middle button went down (the side pane's tabs use it too)
  const stripSpeed = (a) => Math.min(450, 0.6 + a * 0.03 + a * a * 0.0008 + Math.max(0, a - 150) ** 2 * 0.004);
  app.stripSpeed = stripSpeed;
  const endTabGlide = () => {
    if (!tabGlide) return;
    cancelAnimationFrame(tabGlide.raf);
    document.removeEventListener("mousemove", tabGlide.move, true);
    tabsEl.classList.remove("is-panning");
    tabGlide = null;
  };
  tabsEl.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    if (tabGlide) { endTabGlide(); return; }
    const g = tabGlide = { x0: e.clientX, x: e.clientX, t0: Date.now(), moved: false, raf: 0 };
    g.move = (m) => { g.x = m.clientX; if (Math.abs(g.x - g.x0) > 6) g.moved = true; };
    const tick = () => {
      if (tabGlide !== g) return;
      const d = g.x - g.x0;
      const a = Math.abs(d) - 8; // a small dead zone round the start
      if (a > 0) tabsEl.scrollLeft += Math.sign(d) * stripSpeed(a); // a slow climb near the start, far out it keeps gaining
      g.raf = requestAnimationFrame(tick);
    };
    tabsEl.classList.add("is-panning");
    document.addEventListener("mousemove", g.move, true);
    g.raf = requestAnimationFrame(tick);
  });
  document.addEventListener("mouseup", (e) => { if (tabGlide && e.button === 1 && (tabGlide.moved || Date.now() - tabGlide.t0 > 350)) endTabGlide(); }, true);
  document.addEventListener("mousedown", (e) => { if (tabGlide && e.button !== 1) endTabGlide(); }, true);
  document.addEventListener("keydown", (e) => { if (tabGlide && e.key === "Escape") endTabGlide(); }, true);
  // a key pressed while a page's tab is up but the keys stayed with the app: the page takes them from here
  document.addEventListener("keydown", (e) => {
    const t = cur();
    if (!t || t.kind !== "web" || !t.path || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target && e.target !== document.body && e.target.matches("input, textarea, [contenteditable], select, button")) return;
    if (document.querySelector(".menu, .dlg-back, .pal-back")) return;
    host.tabWebFocus(t.wid).catch(() => {});
  });
  window.addEventListener("blur", endTabGlide);
  tabsEl.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  tabsEl.addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) {
      const tabEl2 = close.closest(".tab");
      if (tabEl2) holdWidths(tabEl2.getBoundingClientRect().width);
      return closeTab(+close.dataset.close);
    }
    if (e.target.closest("[data-newtab]")) return app.run("new-tab");
    const mute = e.target.closest("[data-mute]");
    if (mute) return muteTab(+mute.dataset.mute);
    const chip = e.target.closest(".tg-chip");
    if (chip) { TG.closeGroupPop(); return toggleGroup(groupById(chip.dataset.group)); }
    const tab = e.target.closest(".tab");
    if (!tab) return;
    const i = +tab.dataset.i;
    if (e.shiftKey || e.ctrlKey || e.metaKey) return pickTabs(i, e.shiftKey);
    if (picked.size) { picked.clear(); renderTabs(); }
    // clicking the tab you are on tells you what it is: path and file actions
    if (i === active && isDoc(tabs[i])) return tabMenu(i, tab.getBoundingClientRect());
    activate(i);
  });
  tabsEl.addEventListener("contextmenu", (e) => {
    // the + : a left click is a new tab as in a browser, the right button has the quick panel
    if (e.target.closest("[data-newtab]")) { e.preventDefault(); return openNewTab(app, tabsEl.querySelector(".tab-new")); }
    const chip = e.target.closest(".tg-chip");
    if (chip) { e.preventDefault(); TG.closeGroupPop(); return groupMenu(groupById(chip.dataset.group), chip.getBoundingClientRect()); }
    const tab = e.target.closest(".tab");
    if (!tab) { e.preventDefault(); return spacesUi.open(); } // empty strip: spaces
    e.preventDefault();
    const t = tabs[+tab.dataset.i];
    // a second right-click on the same tab puts its menu away again
    if (ctxAgain === t.id) { ctxAgain = null; ctxFor = null; return; }
    ctxFor = t.id;
    if (picked.size > 1 && picked.has(t.id)) return pickedMenu({ left: e.clientX, bottom: e.clientY });
    tabMenu(+tab.dataset.i, { left: e.clientX, bottom: e.clientY });
  });
  // (heard on the window, before the menu's own "a press outside closes me")
  let ctxFor = null;
  let ctxAgain = null;
  // a tab's menu is open: the next press on that tab, either button, just puts the menu away
  let swallowClick = false;
  window.addEventListener("pointerdown", (e) => {
    const open = !!document.querySelector(".menu");
    const tab = e.target.closest ? e.target.closest("#tabs .tab") : null;
    const id = tab && tabs[+tab.dataset.i] ? tabs[+tab.dataset.i].id : null;
    ctxAgain = open && id != null && id === ctxFor ? id : null;
    if (ctxAgain != null) { closeMenu(); swallowClick = true; e.preventDefault(); e.stopPropagation(); }
    if (!open || !tab) ctxFor = null;
  }, true);
  window.addEventListener("click", (e) => { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
  window.addEventListener("pointerup", () => { setTimeout(() => { swallowClick = false; }, 0); }, true);

  /* several tabs at once: Shift+click picks a range from the current tab,
     Ctrl+click adds or removes one; right-click a picked tab to act on all */
  const picked = new Set(); // tab ids
  function pickTabs(i, range) {
    const t = tabs[i];
    if (!t) return;
    if (range) {
      const from = active >= 0 ? active : i;
      const [a, b] = from < i ? [from, i] : [i, from];
      if (!picked.size && active >= 0) picked.add(tabs[active].id);
      for (let k = a; k <= b; k++) if (!TG.isHidden(groups, tabs[k])) picked.add(tabs[k].id);
    } else {
      if (!picked.size && active >= 0) picked.add(tabs[active].id);
      picked.has(t.id) ? picked.delete(t.id) : picked.add(t.id);
    }
    renderTabs();
  }
  const pickedTabs = () => tabs.filter((t) => picked.has(t.id));
  function pickedMenu(rect) {
    const list = pickedTabs();
    const n = list.length;
    const others = spaces.filter((s) => s !== space);
    const done = () => { picked.clear(); commit(); };
    menu(0, 0, [
      { header: `${n} tabs`, plain: true },
      { label: `Close ${n} tabs`, icon: "x", run: () => {
        for (const t of list) { if (t.kind === "note" && dirty.has(t.path)) flushSave(t.path); closed.push({ ...loc(t), at: tabs.indexOf(t), space: space.id, ...TG.tabExtras(t) }); }
        const was = active >= 0 ? tabs[active] : null;
        tabs = tabs.filter((t) => !picked.has(t.id));
        active = was && tabs.includes(was) ? tabs.indexOf(was) : Math.min(tabs.length - 1, Math.max(0, active - 1));
        picked.clear();
        show();
        closeWebs(list);
      } },
      { label: "Add to new group", icon: "plus", run: () => {
        const g = TG.makeGroup(groups);
        const first = list.find((t) => !t.pinned);
        if (!first) return;
        reflow(TG.addToNewGroup(tabs, groups, tabs.indexOf(first), g));
        for (const t of list) if (t !== first && !t.pinned) reflow(TG.addToGroup(tabs, groups, tabs.indexOf(t), g.id));
        done();
        editGroupAt(groupById(g.id), "New group");
      } },
      { label: "Pin all (stay in view)", icon: "pin", run: () => { for (const t of list) if (!t.pinned) setPinned(tabs.indexOf(t), true); done(); } },
      { label: "Minimize all (icon only)", icon: "shrink", run: () => { for (const t of list) t.mini = true; renderTabs(); saveSession(); done(); } },
      list.some(canSplit) ? { label: "Open side by side", icon: "columns", run: () => { for (const t of list) if (canSplit(t)) split.open(loc(t), { focus: false }); done(); } } : null,
      ...(others.length ? ["sep", { header: `Move ${n} tabs to space` }, ...others.map((s) => ({ label: `${emojiOf(s)}${s.name}`, icon: s.icon && s.icon.startsWith("i:") ? s.icon.slice(2) : undefined, run: () => {
        s.tabs = [...(s.tabs || []), ...list.filter((t) => !(s.tabs || []).some((l) => same(l, t))).map((t) => ({ ...loc(t), ...(t.color ? { color: t.color } : {}) }))];
        const was = active >= 0 ? tabs[active] : null;
        tabs = tabs.filter((t) => !picked.has(t.id));
        active = was && tabs.includes(was) ? tabs.indexOf(was) : Math.min(tabs.length - 1, 0);
        picked.clear();
        show();
        toast(`Moved ${n} tabs to ${emojiOf(s)}${s.name}`);
      } }))] : []),
      "sep",
      { label: "Clear selection", icon: "minus", keys: "Esc", run: () => { picked.clear(); renderTabs(); } },
    ], { anchor: { getBoundingClientRect: () => rect } });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picked.size && !document.querySelector(".menu, .pal-back")) { picked.clear(); renderTabs(); }
  });
  // a mouse wheel scrolls a crowded tab strip sideways
  // wheel down moves the strip left-to-right the other way round (down = back
  // toward the first tabs), with a little glide after a quick flick
  let glide = 0;
  let glideRaf = 0;
  const glideStep = () => {
    const before = tabsEl.scrollLeft;
    tabsEl.scrollLeft += glide;
    glide *= 0.86;
    if (Math.abs(glide) < 0.4 || tabsEl.scrollLeft === before) { glide = 0; glideRaf = 0; return; }
    glideRaf = requestAnimationFrame(glideStep);
  };
  tabsEl.addEventListener("wheel", (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || tabsEl.scrollWidth <= tabsEl.clientWidth) return;
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    glide = Math.max(-90, Math.min(90, glide + d * 0.16));
    if (!glideRaf) glideRaf = requestAnimationFrame(glideStep);
  }, { passive: false });

  function muteTab(i, on) {
    const t = tabs[i];
    if (!t || t.kind !== "web") return;
    const muted = on == null ? !t.muted : !!on;
    host.tabWebMute(t.wid, muted).then(() => { t.muted = muted; renderTabs(); }).catch((err) => toast(String(err), { kind: "error" }));
  }
  async function tabMenu(i, rect) {
    const t = tabs[i];
    if (!t) return;
    // however it was opened (a click on the current tab, or a right-click), the next press on this tab puts it away
    ctxFor = t.id;
    const doc = isDoc(t);
    const others = spaces.filter((s) => s !== space);
    // a background page can be unloaded; what its renderer holds is asked of WebView2 first
    const loaded = t.kind === "web" && i !== active && !!webTab && webTab.isLive(t.wid);
    const mem = loaded ? await host.tabWebMemory(t.wid).catch(() => null) : null;
    menu(0, 0, [
      doc ? { header: t.path, plain: true } : null,
      t.kind === "note" ? { label: "Reveal in sidebar", icon: "folder", run: () => { app.setSetting("sidebar", true); sidebar.reveal(t.path); } } : null,
      t.kind === "note" && app.settings.scriptMenu !== false ? { label: "Read as script", icon: "play", run: () => app.readAsScript(t.path) } : null,
      t.kind === "note" ? { label: "Print or save as PDF…", icon: "file", run: () => printNote(t.path) } : null,
      doc ? { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(t.path) } : null,
      doc ? { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(t.path); toast("Path copied"); } } : null,
      t.kind === "file" ? { label: "Open in default app", icon: "reveal", run: () => host.openPath(t.path).catch((err) => toast(String(err), { kind: "error" })) } : null,
      t.kind === "web" && t.path ? { label: "Open in its own Leonote window", icon: "layers", run: () => host.webOpen({ id: "t" + t.wid, url: t.path, title: t.title || "" }).catch((err) => toast(String(err), { kind: "error" })) } : null,
      t.kind === "web" && t.path ? { label: "Open in your browser", icon: "outside", run: () => app.openUrl(t.path) } : null,
      t.kind === "web" && t.path ? { label: "Copy the address", icon: "link", run: () => { navigator.clipboard.writeText(t.path); toast("Address copied"); } } : null,
      t.kind === "web" && t.path ? { label: t.muted ? "Unmute the page" : "Mute the page", icon: t.muted ? "volume" : "volumeOff", run: () => muteTab(i) } : null,
      loaded ? { label: mem > 0 ? `Unload the page - frees about ${fmtSize(mem)}` : "Unload the page - it loads again when opened", icon: "moon", run: () => { webTab.unload(t.wid); toast(mem > 0 ? `Page unloaded, about ${fmtSize(mem)} back` : "Page unloaded", { ms: 1800 }); } } : null,
      t.kind === "note" ? { label: "Rename", icon: "edit", keys: "F2", run: () => { activate(i); titleEl.focus(); titleEl.select(); } } : null,
      { label: "Duplicate", icon: "layers", keys: "Ctrl D", run: () => { activate(i); duplicateTab(); } },
      canSplit(t) ? { label: "Move to split view", icon: "columns", run: () => moveToSplit(i) } : null,
      doc ? { label: "Open to the side", icon: "columns", run: () => split.open(loc(t)) } : null,
      doc ? "sep" : null,
      t.pinned ? { label: "Unpin tab", icon: "pin", run: () => setPinned(i, false) } : { label: "Pin tab - stays in view at the left", icon: "pin", run: () => setPinned(i, true) },
      t.pinned ? null : t.mini ? { label: "Restore tab to full size", icon: "expand", run: () => setMini(i, false) } : { label: "Minimize tab - just its icon", icon: "shrink", run: () => setMini(i, true) },
      { label: "Preview tabs when the pointer rests on them", icon: "eye", checked: app.settings.tabPreview !== false, run: () => app.setSetting("tabPreview", app.settings.tabPreview === false) },
      app.settings.tabPreview !== false ? { label: "Preview how soon", icon: "clock", sub: [[0, "At once"], [250, "Quickly"], [650, "After a moment"]].map(([v, label]) => ({ label, checked: Number(app.settings.tabPreviewDelay ?? 250) === v, run: () => app.setSetting("tabPreviewDelay", v) })) } : null,
      { label: "Customize…", icon: "palette", run: () => customizeTab(rect, tabInfo(t), t, app.settings.tabColorStyle, () => { renderTabs(); saveSession(); }) },
      ...(t.pinned ? [] : groupItems(t, rect)),
      ...(others.length ? ["sep", { header: "Move to space" }, ...others.map((s) => ({ label: `${emojiOf(s)}${s.name}`, icon: s.icon && s.icon.startsWith("i:") ? s.icon.slice(2) : undefined, run: () => moveTabToSpace(i, s), sub: spotsIn(s, t) }))] : []),
      "sep",
      { label: "Close", icon: "x", keys: "Ctrl W", run: () => closeTab(i) },
      { label: "Close others", icon: "x", run: () => closeWhere((x, k) => k === i || x.pinned, t) },
      { label: "Close tabs to the right", icon: "x", run: () => closeWhere((x, k) => k <= i || x.pinned, t) },
      closed.length ? { label: "Reopen closed tab", icon: "undo", keys: "Ctrl Shift T", run: () => reopenTab() } : null,
    ], { anchor: { getBoundingClientRect: () => rect } });
  }

  /** Pinned tabs always sit first; unpinning leaves the tab right where the pinned group ends. */
  // A minimized tab is an ordinary tab that shows only its icon: it stays
  // where it is, drags and groups like any other.
  function setMini(i, on) {
    const t = tabs[i];
    if (!t) return;
    if (on) t.mini = true; else delete t.mini;
    renderTabs();
    saveSession();
  }
  function setPinned(i, on) {
    const t = tabs[i];
    if (!t) return;
    const was = active >= 0 ? tabs[active] : null;
    tabs.splice(i, 1);
    if (on) { t.pinned = true; t.full = true; delete t.mini; } else { delete t.pinned; delete t.full; }
    if (t.kind === "view" && t.view === "home") app.setSetting("homeTabPinned", !!on);
    const edge = tabs.reduce((n, x, k) => (x.pinned ? k + 1 : n), 0);
    tabs.splice(edge, 0, t);
    active = was ? tabs.indexOf(was) : -1;
    renderTabs();
    saveSession();
  }

  app.isViewPinned = (view) => tabs.some((t) => t.kind === "view" && t.view === view && t.pinned);
  app.pinView = (view) => {
    const i = tabs.findIndex((t) => t.kind === "view" && t.view === view);
    if (i >= 0) return setPinned(i, true);
    const t = mkTab({ kind: "view", view }, { pinned: true });
    const was = active >= 0 ? tabs[active] : null;
    const edge = tabs.reduce((n, x, k) => (x.pinned ? k + 1 : n), 0);
    tabs.splice(edge, 0, t);
    if (!was && floating.view === view) active = tabs.indexOf(t);
    else active = was ? tabs.indexOf(was) : -1;
    show();
  };
  app.unpinView = (view) => {
    const i = tabs.findIndex((t) => t.kind === "view" && t.view === view);
    if (i >= 0) setPinned(i, false);
  };

  /* tab groups: menus, chip, peek */
  const groupById = (id) => groups.find((g) => g.id === id);
  const groupLabel = (g) => g.name || `${TG.COLOR_NAMES[g.color]} group`;
  const chipOf = (g) => (g ? tabsEl.querySelector(`.tg-chip[data-group="${g.id}"]`) : null);
  const commit = () => { renderTabs(); saveSession(); };
  let lastFolded = null; // so the toggle command can reopen what it just folded

  function groupItems(t, rect) {
    const at = () => tabs.indexOf(t);
    const others = groups.filter((g) => g.id !== t.group);
    return [
      "sep",
      { label: "Add to new group", icon: "plus", keys: "Ctrl Alt G", run: () => newGroupFrom(at()) },
      others.length ? { label: "Add to group…", icon: "grid", run: () => menu(0, 0, [
        { header: "Add to group" },
        ...others.map((g) => ({ label: groupLabel(g), swatch: TG.colorVar(g.color), run: () => { reflow(TG.addToGroup(tabs, groups, at(), g.id)); commit(); } })),
      ], { anchor: { getBoundingClientRect: () => rect } }) } : null,
      t.group ? { label: "Remove from group", icon: "minus", run: () => { reflow(TG.removeFromGroup(tabs, groups, at())); commit(); } } : null,
    ];
  }

  function newGroupFrom(i) {
    if (!tabs[i] || tabs[i].pinned) return;
    const g = TG.makeGroup(groups);
    reflow(TG.addToNewGroup(tabs, groups, i, g));
    commit();
    editGroupAt(g, "New group");
  }

  function editGroupAt(g, title = "") {
    const chip = chipOf(g);
    if (!chip) return;
    chip.scrollIntoView({ block: "nearest", inline: "nearest" });
    customizeGroup(chip.getBoundingClientRect(), g, { title, onChange: commit });
  }

  // after groups fold, the tab you are on must stay in sight
  function settle() {
    if (active >= 0 && TG.isHidden(groups, tabs[active])) {
      flushCur();
      active = TG.nearestVisible(tabs, groups, active);
      return show();
    }
    commit();
  }

  let inkSnap = false; // the accent bar lands at once on the next paint (a fold moves every tab after it, and a slide across them reads as a jump)
  function toggleGroup(g) {
    if (!g) return;
    g.collapsed = !g.collapsed;
    lastFolded = g.collapsed ? g.id : null;
    inkSnap = true;
    settle();
  }

  function closeGroup(g) {
    const r = g && TG.groupRange(tabs, g.id);
    if (!r) return;
    closeWhere((x) => x.group !== g.id, tabs[r.end] || tabs[r.start - 1]); // saves, stops and keeps them to reopen
  }

  function moveGroupToSpace(g, s) {
    flushCur();
    const r = TG.groupRange(tabs, g.id);
    const out = TG.extractGroup(tabs, groups, g.id);
    Object.assign(s, TG.mergeIntoSpace(s, out.moved.map((t) => ({ ...loc(t), ...TG.tabExtras(t) })), g, same));
    const was = active >= 0 ? tabs[active] : null;
    ({ tabs, groups } = out);
    active = was && tabs.includes(was) ? tabs.indexOf(was) : TG.nearestVisible(tabs, groups, Math.min(r.start, tabs.length - 1));
    show();
    toast(`Moved ${groupLabel(g)} to ${emojiOf(s)}${s.name}`);
  }

  function groupMenu(g, rect) {
    if (!g) return;
    const others = spaces.filter((s) => s !== space);
    const count = tabs.filter((t) => t.group === g.id).length;
    menu(0, 0, [
      { header: `${g.name || "Unnamed group"} · ${count} tab${count === 1 ? "" : "s"}`, plain: true },
      { label: "Rename…", icon: "edit", run: () => editGroupAt(g) },
      { label: "Customize…", icon: "palette", run: () => editGroupAt(g) },
      { label: g.collapsed ? "Expand" : "Collapse", icon: g.collapsed ? "expand" : "shrink", keys: "Ctrl Alt Shift G", run: () => toggleGroup(g) },
      groups.length > 1 ? { label: "Collapse others", icon: "shrink", run: () => { for (const x of groups) x.collapsed = x !== g; settle(); } } : null,
      "sep",
      { label: "New tab in group", icon: "plus", run: () => { const r = TG.groupRange(tabs, g.id); activate(r.end - 1); app.run("new-tab"); } },
      { label: "Ungroup", icon: "minus", run: () => { reflow(TG.ungroup(tabs, groups, g.id)); commit(); } },
      ...(others.length ? ["sep", { header: "Move group to space" }, ...others.map((s) => ({ label: `${emojiOf(s)}${s.name}`, icon: s.icon && s.icon.startsWith("i:") ? s.icon.slice(2) : undefined, run: () => moveGroupToSpace(g, s) }))] : []),
      "sep",
      { label: "Close group", icon: "x", danger: true, run: () => closeGroup(g) },
    ], { anchor: { getBoundingClientRect: () => rect } });
  }

  // hovering a collapsed chip shows its name and tabs after a short pause
  let peekTimer = 0;
  tabsEl.addEventListener("mouseover", (e) => {
    clearTimeout(peekTimer);
    const chip = e.target.closest(".tg-chip.is-collapsed");
    if (!chip || dragTab >= 0 || dragGroup) return;
    peekTimer = setTimeout(() => {
      const g = groupById(chip.dataset.group);
      if (!g || !chip.isConnected || document.querySelector(".menu")) return;
      TG.peekGroup(chip, g, tabs.filter((t) => t.group === g.id).map((t) => {
        const inf = tabInfo(t);
        return { title: inf.title, icon: inf.icon, open: () => { flushCur(); active = tabs.indexOf(t); show(); } };
      }));
    }, 250);
  });
  tabsEl.addEventListener("mouseleave", () => clearTimeout(peekTimer));

  /* Rest the pointer on a tab and a small card shows what is inside it: the
     start of a note, a picture, or what kind of thing it is. It never takes
     the pointer, and any press, drag or move to another tab puts it away. */
  const tabPeek = h("div", { class: "tab-peek", hidden: true });
  document.body.append(tabPeek);
  let tabPeekTimer = 0;
  let tabPeekFor = null;
  const NL = String.fromCharCode(10);
  function hideTabPeek() {
    clearTimeout(tabPeekTimer);
    tabPeekFor = null;
    if (tabPeek.hidden) return;
    tabPeek.classList.remove("is-in");
    tabPeek.hidden = true;
    dispatchEvent(new Event("leo:overlay")); // a web page under it takes its room back now
  }
  function tabPeekBody(t) {
    if (t.kind === "note") {
      const note = app.vault.get(t.path);
      let text = note ? String(note.content || "") : "";
      if (text.startsWith("---")) { const end = text.indexOf(NL + "---", 3); if (end > 0) text = text.slice(text.indexOf(NL, end + 1) + 1); }
      // each shown line remembers which line of the note it is: a click lands there
      const lead = String(note ? note.content || "" : "").length - text.length;
      const first = lead > 0 ? String(note.content).slice(0, lead).split(NL).length : 1;
      const lines = text.split(NL).map((l, k) => ({ l: l.trimEnd(), n: first + k })).filter((x, k, a) => x.l || (k && a[k - 1].l)).slice(0, 80);
      if (!lines.some((x) => x.l)) return h("div", { class: "tab-peek-empty", text: "Empty note" });
      return h("div", { class: "tab-peek-text" }, lines.map(({ l, n }) => {
        const hd = /^(#{1,6})\s+(.*)$/.exec(l);
        if (hd) return h("div", { class: "tab-peek-h", dataset: { line: String(n) }, text: hd[2] });
        return h("div", { class: "tab-peek-l", dataset: { line: String(n) }, text: l.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a).replace(/[*_`~]{1,3}/g, "") || " " });
      }));
    }
    if (t.kind === "file") {
      const f = app.vault.files.get(t.path);
      if (f && f.kind === "image") return h("img", { class: "tab-peek-img", src: assetOf(t.path), alt: "", onload: () => placeTabPeek() });
      // Leonote's own documents say what they are, not "Text file"
      const own = [[/\.leovideo$/i, "Video project", "film"], [/\.leopaint$/i, "Leopaint board", "brush"], [/\.leostudio$/i, "Studio document", "palette"], [/\.canvas$/i, "Research board", "grid"], [/\.excalidraw$/i, "Drawing", "brush"], [/\.leocanvas$/i, "Leopaint board", "brush"]].find(([re]) => re.test(t.path));
      if (own) return h("div", { class: "tab-peek-empty" }, icon(own[2]), h("span", { text: own[1] }));
      return h("div", { class: "tab-peek-empty" }, icon(KIND_ICON[f && f.kind] || "file"), h("span", { text: f && f.kind ? f.kind[0].toUpperCase() + f.kind.slice(1) + " file" : "File" }));
    }
    const inf = tabInfo(t);
    return h("div", { class: "tab-peek-empty" }, icon(inf.icon), h("span", { text: t.kind === "ext" ? "Outside the vault" : inf.title }));
  }
  /** The same preview for anyone else: a note's first lines, a picture, or the kind of file. */
  app.peekBody = (kind, path) => tabPeekBody({ kind, path });
  let tabPeekAt = null;
  function placeTabPeek() {
    if (!tabPeekAt || tabPeek.hidden) return;
    const r = tabPeekAt;
    const w = tabPeek.offsetWidth;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    tabPeek.style.transform = `translate(${Math.round(x)}px, ${Math.round(r.bottom + 6)}px)`;
  }
  // `small`: the name and where it is only (the pointer resting on the tab just clicked)
  function showTabPeek(el, t, small = false) {
    const inf = tabInfo(t);
    tabPeek.classList.toggle("is-small", small);
    tabPeek.replaceChildren(...[
      h("div", { class: "tab-peek-head" }, icon(inf.icon), h("span", { class: "tab-peek-title", text: inf.title })),
      isDoc(t) || (t.kind === "web" && t.path) ? h("div", { class: "tab-peek-path", text: t.path }) : null,
      // a web page's own contents are never drawn here: only its name and address
      t.kind === "web" || small ? null : tabPeekBody(t),
      small || !el.dataset.hint ? null : h("div", { class: "tab-peek-keys", text: el.dataset.hint })].filter(Boolean));
    tabPeekAt = el.getBoundingClientRect();
    tabPeek.hidden = false;
    placeTabPeek();
    dispatchEvent(new Event("leo:overlay")); // shown without a click (a hover): a web page under it steps aside now
    el.removeAttribute("title"); // the card says it all; two tooltips would fight
    requestAnimationFrame(() => tabPeek.classList.add("is-in"));
  }
  // a press on a tab (a click, the menu, a drag) means the hand is busy there: no card until the pointer has been on another tab or off the strip
  let peekMuted = null;
  tabsEl.addEventListener("pointerdown", (e) => { const el = e.target.closest(".tab"); const t = el ? tabs[+el.dataset.i] : null; clearTimeout(tabPeekTimer); hideTabPeek(); peekMuted = t ? t.id : null; }, true);
  tabsEl.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".tab");
    const t = el ? tabs[+el.dataset.i] : null;
    if (t && peekMuted === t.id) {
      // the tab just pressed: no full card, but its name after a longer rest
      clearTimeout(tabPeekTimer);
      tabPeekTimer = setTimeout(() => { if (el.isConnected && el.matches(":hover") && !e.buttons && !document.querySelector(".menu") && tabPeek.hidden) { tabPeekFor = t.id; showTabPeek(el, t, true); } }, 900);
      return;
    }
    if (t) peekMuted = null; // another tab lifts the mute; the strip's own background (a redraw under a still pointer) does not
    if (t && tabPeekFor === t.id) { clearTimeout(tabPeekLeave); return; }
    hideTabPeek();
    if (!t || dragTab >= 0 || dragGroup || e.buttons) return;
    tabPeekFor = t.id;
    // previews turned off: still the name (the tab has no tooltip of its own), after a moment
    const off = app.settings.tabPreview === false;
    tabPeekTimer = setTimeout(() => {
      if (!el.isConnected || !el.matches(":hover") || document.querySelector(".menu")) return;
      showTabPeek(el, t, off);
    }, off ? 600 : Math.max(0, Number(app.settings.tabPreviewDelay ?? 250)));
  });
  // The card can be gone over to: leaving the tab gives the pointer a moment
  // to reach it, it stays while the pointer is on it (and scrolls, for a long
  // note), and a click on it opens that tab.
  let tabPeekLeave = 0;
  const leaveSoon = () => { clearTimeout(tabPeekLeave); tabPeekLeave = setTimeout(() => { if (!tabPeek.matches(":hover")) hideTabPeek(); }, 260); };
  tabsEl.addEventListener("mouseleave", () => { peekMuted = null; if (tabPeek.hidden) hideTabPeek(); else leaveSoon(); });
  tabPeek.addEventListener("mouseenter", () => clearTimeout(tabPeekLeave));
  tabPeek.addEventListener("mouseleave", leaveSoon);
  tabPeek.addEventListener("click", (e) => {
    const k = tabs.findIndex((x) => x.id === tabPeekFor);
    // the line that was clicked is where the caret goes
    const row = e.target.closest("[data-line]");
    const line = row ? Number(row.dataset.line) : 0;
    hideTabPeek();
    if (k < 0) return;
    activate(k);
    if (line && tabs[k] && tabs[k].kind === "note") { editor.selectLine(line - 1); editor.focus(); }
  });
  for (const ev of ["mousedown", "dragstart", "wheel", "contextmenu"]) tabsEl.addEventListener(ev, hideTabPeek, true);
  window.addEventListener("blur", hideTabPeek);

  /* drag and drop: reorder tabs, move whole groups, and (held) group tabs */
  let dragTab = -1;
  let dragGroup = null;
  const hold = { el: null, timer: 0, ready: -1 };
  const HOLD_MS = 600;

  // what the pointer is over, by position: the gaps between tabs count too
  function overAt(x) {
    for (const el of tabsEl.querySelectorAll(".tab, .tg-chip")) {
      const r = el.getBoundingClientRect();
      if (x > r.right) continue;
      const f = Math.max(0, (x - r.left) / r.width);
      return el.classList.contains("tab") ? { el, tab: +el.dataset.i, after: f > 0.5, f } : { el, chip: el.dataset.group, x: f };
    }
    return { end: true };
  }

  function clearHold() {
    clearTimeout(hold.timer);
    if (hold.el) hold.el.classList.remove("is-group-target");
    hold.el = null;
    hold.ready = -1;
  }
  function clearMarks() {
    for (const n of tabsEl.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-into")) n.classList.remove("is-drop-before", "is-drop-after", "is-drop-into");
  }

  // a thin insertion line where the drop would land (inside a group or beside it)
  function markSlot(slot, group) {
    clearMarks();
    if (slot == null) return;
    const byIndex = (i) => tabsEl.querySelector(`.tab[data-i="${i}"]`);
    const wrap = (id) => tabsEl.querySelector(`.tg[data-group="${id}"]`);
    const t = tabs[slot];
    const prev = tabs[slot - 1];
    let el = null;
    let side = "before";
    if (group && (groupById(group) || {}).collapsed) { el = chipOf(groupById(group)); side = "into"; }
    else if (group && prev && prev.group === group && (!t || t.group !== group)) { el = byIndex(slot - 1); side = "after"; }
    else if (t) el = t.group && ((t.group !== group && TG.groupRange(tabs, t.group).start === slot) || TG.isHidden(groups, t)) ? wrap(t.group) : byIndex(slot);
    else {
      el = prev && (prev.group ? wrap(prev.group) : byIndex(slot - 1));
      side = "after";
    }
    if (el) el.classList.add("is-drop-" + side);
  }

  // While a tab is dragged the browser scrolls whatever scrollable thing lies
  // near the pointer - the note under the strip creeps although nobody touched
  // it. Every scroller is held where it was until the drag is over.
  let heldScroll = null;
  const holdScroll = (e) => {
    const n = e.target;
    if (!heldScroll || !n || n.nodeType !== 1 || tabsEl.contains(n) || n === tabsEl) return;
    const at = heldScroll.get(n);
    if (at === undefined) return;
    if (n.scrollTop !== at[0]) n.scrollTop = at[0];
    if (n.scrollLeft !== at[1]) n.scrollLeft = at[1];
  };
  // `free`: scrollers left to move (a file or a tree row is dropped into the file tree, which scrolls at its edges)
  const holdStart = (free) => {
    heldScroll = new Map();
    for (const n of document.querySelectorAll(".note-scroll, .cm-scroller, .fv-body, .view, .sb-scroll")) if (!free || !n.matches(free)) heldScroll.set(n, [n.scrollTop, n.scrollLeft]);
    document.addEventListener("scroll", holdScroll, true);
    clearTimeout(holdT);
    holdT = setTimeout(holdEnd, 20000);
  };
  const holdEnd = () => { heldScroll = null; clearTimeout(holdT); document.removeEventListener("scroll", holdScroll, true); };
  // Whatever happens to the dragged tab - redrawn under the pointer, dropped
  // outside the window - the hold must let go: a drag's end is heard on the
  // document, any ordinary mouse move means no drag is going on (none arrive
  // during one), and as a last resort it times out.
  let holdT = 0;
  for (const ev of ["dragend", "drop", "mousemove", "pointerdown", "wheel", "keydown"]) document.addEventListener(ev, () => { if (heldScroll) holdEnd(); }, true);
  tabsEl.addEventListener("dragend", holdEnd);

  // A file carried in from Explorer (or out of the file tree) is usually on
  // its way to the tab strip, and its path crosses the open note. The note
  // does not take it, show a drop caret or scroll until the pointer has
  // RESTED over the text for a moment - then it is clearly meant for the note.
  const DROP_REST_MS = 650;
  let restSince = 0;
  let restArmed = false;
  const carriesFile = (dt) => !!dt && [...(dt.types || [])].some((t) => t === "Files" || t === "application/x-leonote-paths");
  const overText = (t) => !!(t && t.closest && t.closest(".cm-editor, .note-scroll, .editor-host"));
  const restReset = () => { restSince = 0; restArmed = false; document.body.classList.remove("is-drop-waiting", "is-drop-armed"); };
  document.addEventListener("dragover", (e) => {
    if (!carriesFile(e.dataTransfer) || dragTab >= 0 || dragGroup) return;
    // the tree's rows drop as links at once, anywhere over the note (the drop handler below writes them)
    if (fromTree(e.dataTransfer) && overText(e.target)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; return; }
    if (!heldScroll && !restArmed) holdStart(".sb-scroll");
    if (!overText(e.target)) { restSince = 0; if (restArmed) { restArmed = false; holdStart(".sb-scroll"); } document.body.classList.remove("is-drop-waiting", "is-drop-armed"); return; }
    if (restArmed) return;
    if (!restSince) restSince = performance.now();
    if (performance.now() - restSince >= DROP_REST_MS) { restArmed = true; holdEnd(); document.body.classList.remove("is-drop-waiting"); document.body.classList.add("is-drop-armed"); return; }
    document.body.classList.add("is-drop-waiting");
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "none";
  }, true);
  const fromTree = (dt) => !!dt && !dt.types.includes("Files") && dt.types.includes("application/x-leonote-paths");
  // What the tree's rows become in a note: a note's or a file's [[link]] (the drag's text), and for a
  // folder a list of links to the notes in it.
  const treeDropText = (dt) => {
    const t = dt.getData("text/plain");
    if (/^!?\[\[/.test(t)) return t;
    let paths = [];
    try { paths = JSON.parse(dt.getData("application/x-leonote-paths") || "[]"); } catch {}
    return paths.length ? paths.map((p) => `- [[${app.vault.linkText(p)}]]`).join("\n") : "";
  };
  document.addEventListener("drop", (e) => {
    // the tree's row let go anywhere over a note - on its text or the space under it: its link goes in there
    if (fromTree(e.dataTransfer) && overText(e.target)) {
      const ed = [editor, ...(split ? split.editors : [])].find((x) => x && x.view && (x.view.dom.contains(e.target) || e.target.contains(x.view.dom)));
      const text = ed && treeDropText(e.dataTransfer);
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        restReset();
        const v = ed.view;
        // under the text only when its end is on screen and the drop is lower (a long note's end is not drawn)
        const end = v.coordsAtPos(v.state.doc.length);
        const below = !!end && e.clientY > end.bottom;
        let pos = below ? v.state.doc.length : v.posAtCoords({ x: e.clientX, y: e.clientY }, false) ?? v.state.selection.main.head;
        const line = v.state.doc.lineAt(pos);
        // let go on a link: after it, never inside it
        for (const m of line.text.matchAll(/!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)/g)) {
          const a = line.from + m.index, b = a + m[0].length;
          if (pos > a && pos < b) { pos = b; break; }
        }
        const list = text.startsWith("- ");
        // a list (or a drop under the text) starts a line of its own; a link in a line gets a space before it
        const lead = (list || below) && pos > line.from ? "\n" : !list && pos > line.from && !/\s/.test(v.state.sliceDoc(pos - 1, pos)) ? " " : "";
        const ins = lead + text + (list && pos < line.to ? "\n" : "");
        v.dispatch({ changes: { from: pos, insert: ins }, selection: { anchor: pos + ins.length }, userEvent: "input.drop", scrollIntoView: true });
        v.focus();
        return;
      }
    }
    const waiting = carriesFile(e.dataTransfer) && overText(e.target) && !restArmed && dragTab < 0 && !dragGroup;
    if (waiting) { e.preventDefault(); e.stopPropagation(); toast("Hold the file over the text for a moment to drop it into the note", { ms: 2600 }); }
    restReset();
  }, true);
  document.addEventListener("dragend", restReset, true);
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) { restReset(); if (heldScroll && dragTab < 0 && !dragGroup) holdEnd(); } }, true);

  tabsEl.addEventListener("dragstart", (e) => {
    const src = e.target.closest(".tg-chip, .tab");
    if (!src) return;
    holdStart();
    TG.closeGroupPop();
    clearTimeout(peekTimer);
    if (src.classList.contains("tab")) {
      dragTab = +src.dataset.i;
      if (canSplit(tabs[dragTab])) e.dataTransfer.setData("application/x-leonote-tab", String(dragTab));
    }
    else dragGroup = src.dataset.group;
    (dragGroup ? src.parentElement : src).classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  });
  tabsEl.addEventListener("dragover", (e) => {
    if (dragTab < 0 && !dragGroup) {
      if (!acceptsDrop(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer);
      tabsEl.classList.add("is-file-drop");
      const p = planAt(e.clientX);
    markSlot(p.slot, p.group);
      return;
    }
    e.preventDefault();
    const over = overAt(e.clientX);
    if (dragGroup) return markSlot(TG.groupDropSlot(tabs, groups, dragGroup, over), null);
    // Grouping by drop is deliberate: only after resting on the middle third
    // of another tab for a moment, so quick reordering never groups.
    const aim = app.settings.tabGroupOnDrop === "hold" && over.tab != null && over.tab !== dragTab && over.f > 1 / 3 && over.f < 2 / 3
      && !tabs[over.tab].pinned && !tabs[dragTab].pinned ? over.el : null;
    if (aim !== hold.el) {
      clearHold();
      if (aim) {
        hold.el = aim;
        hold.timer = setTimeout(() => { hold.ready = +aim.dataset.i; clearMarks(); aim.classList.add("is-group-target"); }, HOLD_MS);
      }
    }
    if (hold.ready >= 0) return;
    const plan = TG.dropPlan(tabs, groups, dragTab, over);
    // no line where the tab would not move at all
    const still = (plan.slot === dragTab || plan.slot === dragTab + 1) && plan.group === (tabs[dragTab].group || null);
    markSlot(still ? null : plan.slot, plan.group);
  });
  tabsEl.addEventListener("dragleave", (e) => { if (!tabsEl.contains(e.relatedTarget)) { clearMarks(); clearHold(); tabsEl.classList.remove("is-file-drop"); } });
  // A drag near either end of the strip makes it glide that way: faster the
  // nearer the edge, and without waiting for the pointer to move again.
  const EDGE = 110;
  let edgeRaf = 0;
  let edgeX = 0;
  let edgeLast = 0;
  let edgeBox = null; // the strip's box, measured by dragover: a scroll moves the tabs, not the strip - no layout read per frame
  function edgeStep(now) {
    edgeRaf = 0;
    if (dragTab < 0 && !dragGroup && !tabsEl.classList.contains("is-file-drop")) return;
    const r = edgeBox;
    if (!r) return;
    const near = edgeX < r.left + EDGE ? -(1 - Math.max(0, edgeX - r.left) / EDGE) : edgeX > r.right - EDGE ? 1 - Math.max(0, r.right - edgeX) / EDGE : 0;
    if (!near) return;
    const dt = Math.min(40, now - (edgeLast || now)) || 16;
    edgeLast = now;
    const before = tabsEl.scrollLeft;
    // eased: a gentle start, up to about 1800 px a second right at the edge
    tabsEl.scrollLeft += Math.sign(near) * (0.12 + near * near * 1.7) * dt;
    if (tabsEl.scrollLeft !== before) edgeRaf = requestAnimationFrame(edgeStep);
  }
  const edgeGlide = (e) => { edgeX = e.clientX; edgeBox = tabsEl.getBoundingClientRect(); if (!edgeRaf) { edgeLast = 0; edgeRaf = requestAnimationFrame(edgeStep); } };
  const edgeStop = () => { if (edgeRaf) cancelAnimationFrame(edgeRaf); edgeRaf = 0; edgeX = (tabsEl.getBoundingClientRect().left + tabsEl.getBoundingClientRect().right) / 2; };
  tabsEl.addEventListener("dragover", edgeGlide);
  tabsEl.addEventListener("dragleave", (e) => { if (!tabsEl.contains(e.relatedTarget)) edgeStop(); });
  tabsEl.addEventListener("drop", edgeStop, true);

  function endDrag() {
    edgeStop();
    dragTab = -1;
    dragGroup = null;
    clearHold();
    clearMarks();
    for (const n of tabsEl.querySelectorAll(".is-dragging")) n.classList.remove("is-dragging");
  }
  tabsEl.addEventListener("dragend", endDrag);
  tabsEl.addEventListener("drop", (e) => {
    if (dragTab < 0 && !dragGroup) {
      if (!acceptsDrop(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      takeDrop(e.dataTransfer, planAt(e.clientX));
      return;
    }
    e.preventDefault();
    const over = overAt(e.clientX);
    let made = null;
    if (dragGroup) reflow(TG.moveGroup(tabs, groups, dragGroup, TG.groupDropSlot(tabs, groups, dragGroup, over)));
    else if (hold.ready >= 0 && over.tab === hold.ready) {
      const fresh = TG.makeGroup(groups);
      reflow(TG.groupOnto(tabs, groups, dragTab, hold.ready, fresh));
      made = groupById(fresh.id);
    } else reflow(TG.applyDrop(tabs, groups, dragTab, TG.dropPlan(tabs, groups, dragTab, over)));
    endDrag();
    tabsEl.classList.remove("is-file-drop");
    commit();
    if (made) toast("Grouped", { ms: 2600, action: { label: "Name it", run: () => editGroupAt(made, "New group") } });
  });

  /* ── files dropped on the tab strip ──────────────────────────────────── */
  // Dragged out of the file tree, a search result or Explorer: the drop lands
  // between two tabs, and that is where the file opens. Files from outside
  // the vault have no path we are allowed to see through a browser drop, so
  // they are copied in - and the toast says so, with a way to undo it.

  const dropTypes = (dt) => [...(dt ? dt.types || [] : [])];
  const hasVaultPaths = (dt) => dropTypes(dt).includes("application/x-leonote-paths");
  const hasOuterFiles = (dt) => dropTypes(dt).includes("Files") || dropTypes(dt).includes("application/x-leonote-archive");
  const fromPane = (dt) => dropTypes(dt).includes("application/x-leonote-split");
  const acceptsDrop = (dt) => hasVaultPaths(dt) || hasOuterFiles(dt) || fromPane(dt);

  // The answer has to agree with what the source allowed: say "link" to a drag
  // that only offers "move" and the browser quietly refuses the drop.
  function dropEffectFor(dt) {
    if (fromPane(dt)) return "move";
    if (hasOuterFiles(dt) && !hasVaultPaths(dt)) return "copy";
    const a = (dt.effectAllowed || "all").toLowerCase();
    if (a === "all" || a === "uninitialized" || a.includes("link")) return "link";
    if (a.includes("copy")) return "copy";
    return "move";
  }

  // The strip only spans the tabs themselves; a drop in the free titlebar
  // space beside them still means "open it here", at the near end.
  const bar = tabsEl.closest(".titlebar") || tabsEl.parentElement;
  const spare = (e) => !tabsEl.contains(e.target) && !e.target.closest("button, input, kbd, a, .inline-edit, .win");
  // past either end of the strip the glide carries on at full pace
  bar.addEventListener("dragover", (e) => { if ((dragTab >= 0 || dragGroup) && !tabsEl.contains(e.target)) { e.preventDefault(); tabsEl.dispatchEvent(new DragEvent("dragover", { clientX: e.clientX, clientY: e.clientY, cancelable: true })); } });
  bar.addEventListener("drop", (e) => { if ((dragTab >= 0 || dragGroup) && spare(e)) { e.preventDefault(); tabsEl.dispatchEvent(new DragEvent("drop", { clientX: e.clientX, clientY: e.clientY, cancelable: true })); } });
  bar.addEventListener("dragover", (e) => {
    if (dragTab >= 0 || dragGroup || !spare(e) || !acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer);
    tabsEl.classList.add("is-file-drop");
    const p = planAt(e.clientX);
    markSlot(p.slot, p.group);
  });
  bar.addEventListener("drop", (e) => {
    if (dragTab >= 0 || dragGroup || !spare(e) || !acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    takeDrop(e.dataTransfer, planAt(e.clientX));
  });
  bar.addEventListener("dragleave", (e) => { if (!bar.contains(e.relatedTarget)) { clearMarks(); tabsEl.classList.remove("is-file-drop"); } });

  /** Open what was dropped, wherever it came from. */
  function takeDrop(dt, plan) {
    clearMarks();
    tabsEl.classList.remove("is-file-drop");
    // a file from inside an archive: opened in a tab of its own
    const arch = dt.getData("application/x-leonote-archive");
    if (arch) { try { app.archiveOpen(JSON.parse(arch)); } catch {} return; }
    // a side pane's tab: it moves here, out of its pane
    const sp = dt.getData("application/x-leonote-split");
    if (sp) { try { const o = JSON.parse(sp); const l = split.take(o.pane, o.i); if (l) openAt([l], plan); } catch {} return; }
    let paths = [];
    try { paths = JSON.parse(dt.getData("application/x-leonote-paths") || "[]"); } catch {}
    if (paths.length) return openAt(paths.slice(0, 24).map(locFor), plan);
    copyInAndOpen(dt, plan);
  }

  /** Where a drop at this x would land: the slot, and the group it falls in. */
  function planAt(x) {
    // the same plan a dragged tab would get, so a file joins a group exactly
    // where the line shows - including at either end of one
    return TG.dropPlan(tabs.concat([{ kind: "note" }]), groups, tabs.length, overAt(x));
  }

  /** Open these documents as tabs, in order, where the drop plan says. */
  function openAt(locs, plan) {
    const list = locs.filter(Boolean);
    if (!list.length) return;
    flushCur();
    const group = plan.group || null;
    let at = Math.max(0, Math.min(plan.slot, tabs.length));
    let last = null;
    for (const l of list) {
      const open = tabs.findIndex((t) => same(t, l));
      let t;
      if (open >= 0) {
        [t] = tabs.splice(open, 1);
        if (open < at) at--;
      } else t = mkTab(l);
      if (group) t.group = group;
      else delete t.group;
      tabs.splice(at, 0, t);
      last = t;
      at++;
    }
    reflow();
    active = tabs.indexOf(last);
    show();
    commit();
  }

  const locFor = (p) => (app.vault.notes.has(p) ? { kind: "note", path: p } : app.vault.files.has(p) ? { kind: "file", path: p } : null);

  /** The vault index catches up through the watcher; wait for it, briefly. */
  function whenKnown(path, ms = 2500) {
    return new Promise((done) => {
      const t0 = performance.now();
      const tick = () => {
        if (locFor(path) || performance.now() - t0 > ms) return done(locFor(path));
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  /**
   * Files dropped on the tab bar from Explorer open as tabs and nothing more:
   * they are parked outside the vault (the webview never tells us where they
   * came from) and a card in the corner offers to add them, to a folder you
   * choose. Dropping onto a folder in the file tree still copies straight there.
   */
  async function copyInAndOpen(dt, plan) {
    const files = [...(dt.files || [])];
    if (!files.length) return;
    const close = files.length > 2 ? toast(`Opening ${files.length} files…`, { ms: 60000 }) : null;
    const staged = [];
    for (const f of files.slice(0, 24)) {
      // said before the whole file is read into the window; Open a file from your computer reads it where it lies
      if (f.size > 1024 ** 3) { toast(`${f.name} is over 1 GB - open it with Ctrl+P › Open a file from your computer instead`, { kind: "error", ms: 6000 }); continue; }
      try {
        staged.push(await host.stageExternal(f.name, new Uint8Array(await f.arrayBuffer())));
      } catch (e) {
        toast(`Could not open ${f.name}: ${e}`, { kind: "error" });
      }
    }
    if (close) close();
    if (!staged.length) return;
    for (const p of staged) extGone.delete(p);
    // a table, a document, a drawing: the way an outside file of its kind opens (as it would from Explorer)
    const guestOnes = host.guestOpen ? staged.filter((p) => GUEST_RE.test(p)) : [];
    for (const p of guestOnes) app.openGuest(p).catch((e) => toast("Could not open it: " + (e && e.message ? e.message : e), { kind: "error" }));
    const rest = staged.filter((p) => !guestOnes.includes(p));
    if (rest.length) openAt(rest.map((p) => ({ kind: "ext", path: p })), plan);
    const mode = app.settings.dropInto || "ask";
    if (mode === "vault") addToVault(staged, true);
    else if (mode === "ask") addToVaultCard(staged);
  }

  /** Every file into the folder for its kind - pictures, videos, songs, and documents for the rest. */
  const kindFolder = (p) => {
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    if (/^(png|jpe?g|gif|webp|svg|bmp|avif|heic|tiff?)$/.test(ext)) return app.mediaDir("imageFolder");
    if (/^(mp4|webm|mkv|mov|avi|m4v)$/.test(ext)) return app.mediaDir("videoFolder");
    if (/^(mp3|wav|ogg|oga|m4a|flac|aac|opus|wma)$/.test(ext)) return app.mediaDir("audioFolder");
    return app.mediaDir("docFolder");
  };
  /** The name a file gets in `dir` - the same rule the Rust side uses: "name 2.ext", "name 3.ext"… */
  function landingName(dir, name) {
    const has = (rel) => app.vault.files.has(rel) || app.vault.notes.has(rel) || app.vault.notes.has(rel.replace(/\.md$/i, "") + ".md");
    const at = (n) => (dir ? dir + "/" : "") + n;
    if (!has(at(name))) return name;
    const i = name.lastIndexOf(".");
    const [stem, ext] = i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
    for (let n = 2; n < 10000; n++) if (!has(at(`${stem} ${n}${ext}`))) return `${stem} ${n}${ext}`;
    return name;
  }
  /** Files whose name the folder already has: a dialog says what each becomes. Resolves false when the person backs out. */
  async function clashOk(paths, dirOf) {
    if (app.settings.importClashAsk === false) return true;
    const rows = paths.map((p) => { const name = p.split(/[\\/]/).pop(); const dir = dirOf(p); const to = landingName(dir, name); return to !== name ? { name, to, dir } : null; }).filter(Boolean);
    if (!rows.length) return true;
    return new Promise((resolve) => {
      const tick = h("input", { type: "checkbox" });
      const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); if (v && tick.checked) app.setSetting("importClashAsk", false); resolve(v); };
      const okBtn = h("button", { class: "btn btn-primary", onclick: () => done(true) }, rows.length === 1 ? "Add it" : "Add them");
      const box = h("div", { class: "dlg", role: "alertdialog", "aria-modal": "true" },
        h("h3", { class: "dlg-title", text: rows.length === 1 ? "That name is already there" : `${rows.length} names are already there` }),
        h("p", { class: "dlg-text", text: "The file already in the folder stays as it is; the new one gets the next free name:" }),
        h("div", { class: "clash-list" }, rows.map((r) => h("div", { class: "clash-row" }, h("span", { class: "clash-from", text: r.name }), h("span", { class: "clash-arrow", text: "→" }), h("span", { class: "clash-to", text: r.to }), h("span", { class: "clash-dir", text: r.dir || "vault root" })))),
        h("label", { class: "dlg-tick" }, tick, h("span", { text: "Don't ask again - the next free name is taken without a word (Settings › Files brings the question back)" })),
        h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), okBtn));
      const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } }, box);
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } else if (e.key === "Enter" && e.target !== tick) { e.preventDefault(); e.stopPropagation(); done(true); } };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("overlay-root").append(back);
      requestAnimationFrame(() => { back.classList.add("is-in"); okBtn.focus(); });
    });
  }
  async function addToVault(paths, silent) {
    let done = 0;
    let lastDir = "";
    if (!(await clashOk(paths, kindFolder))) return;
    for (const p of paths) {
      const dir = kindFolder(p);
      try {
        const res = await host.externalImport(p, dir, true);
        extGone.add(p);
        const rel = res.path;
        const known = () => (res.note ? app.vault.notes.has(rel) : app.vault.files.has(rel));
        for (let k = 0; k < 40 && !known(); k++) await new Promise((r) => setTimeout(r, 50));
        const ti = tabs.findIndex((t) => t.kind === "ext" && t.path === p);
        if (ti >= 0 && known()) retarget(tabs[ti], { kind: res.note ? "note" : "file", path: rel }, ti === active);
        lastDir = dir;
        done++;
      } catch (e) { toast(`Could not add ${p.split(/[\\/]/).pop()}: ${e}`, { kind: "error" }); }
    }
    if (done) { show(); if (!silent || done) toast(done > 1 ? `${done} files went into the vault, each to its kind's folder` : `Went into ${lastDir || "the vault"}`, { ms: 4000 }); }
  }

  /** The corner card after a drop: where should these live? Or nowhere - that is fine too. */
  function addToVaultCard(paths) {
    const names = paths.map((p) => p.split(/[\\/]/).pop());
    const folders = () => ["", ...[...app.vault.folders].sort((a, b) => a.localeCompare(b))];
    let dir = app.lastNotePath && app.lastNotePath() ? dirnameOf(app.lastNotePath()) : "";
    const input = h("input", { class: "drop-card-in", placeholder: "Vault root - or type a folder", spellcheck: false, value: dir });
    const list = h("div", { class: "drop-card-list", hidden: true });
    let rows = [];
    let at = -1;
    const paintList = () => {
      const q = input.value.trim().toLowerCase();
      rows = folders().filter((d) => !q || d.toLowerCase().includes(q)).slice(0, 7);
      at = Math.min(at, rows.length - 1);
      list.hidden = !rows.length;
      list.replaceChildren(...rows.map((d, k) => h("button", { class: "drop-card-row" + (k === at ? " is-on" : ""), onmousedown: (e) => { e.preventDefault(); input.value = d; list.hidden = true; } }, icon(d ? "folder" : "home"), h("span", { text: d || "Vault root" }))));
    };
    input.addEventListener("focus", paintList);
    input.addEventListener("input", () => { at = -1; paintList(); });
    input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 120));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (list.hidden) paintList(); at = (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(1, rows.length); paintList(); }
      else if (e.key === "Enter") { e.preventDefault(); if (at >= 0 && rows[at] != null && !list.hidden) { input.value = rows[at]; list.hidden = true; at = -1; } else add(); }
      else if (e.key === "Escape") { e.preventDefault(); if (!list.hidden) list.hidden = true; else shut(); }
    });
    // where it would make sense: where you are working, the attachments folder
    // for pictures and the like, the folders you were in lately
    const isNote = (n) => /\.(md|markdown|txt)$/i.test(n);
    const sugg = [];
    const suggest = (d, why) => { if (d == null || sugg.some((x) => x[0] === d) || (d && !app.vault.folders.has(d))) return; sugg.push([d, why]); };
    suggest(dir, "where you are working");
    if (!names.every(isNote)) suggest(app.mediaDir("imageFolder"), "attachments");
    for (const p of app.settings.recent || []) { if (sugg.length >= 5) break; suggest(dirnameOf(p), "recent"); }
    suggest("", "vault root");
    const chips = h("div", { class: "drop-card-chips" }, sugg.map(([d, why]) => h("button", { class: "drop-card-chip", title: why, onclick: () => { input.value = d; list.hidden = true; paintChips(); } }, icon(d ? "folder" : "home"), d ? d.slice(d.lastIndexOf("/") + 1) : "Vault root")));
    const paintChips = () => { const v = input.value.trim(); [...chips.children].forEach((c, k) => c.classList.toggle("is-on", sugg[k][0] === v)); };
    input.addEventListener("input", paintChips);
    paintChips();
    // a dropped file arrives as bytes only - the webview never says where it
    // came from - so there is no original for us to remove. A file opened
    // from its real place can be moved instead of copied.
    const real = paths.filter((p) => !/[\\/]leonote-dropped[\\/]/i.test(p));
    let moveIt = false;
    const moveBox = real.length ? h("label", { class: "drop-card-move" }, h("input", { type: "checkbox", onchange: async (e) => {
      if (e.target.checked && !(await confirmDialog("Remove the original after adding?", `${real.length > 1 ? "These files" : names[0]} will be moved into the vault and will no longer be where ${real.length > 1 ? "they are" : "it is"} now.`, { ok: "Move it", danger: true }))) e.target.checked = false;
      moveIt = e.target.checked;
    } }), h("span", { text: "Remove it from where it is now (move, not copy)" })) : h("div", { class: "drop-card-note", text: "The original stays where you dragged it from - a dropped file never tells Leonote where that is." });
    const addBtn = h("button", { class: "btn btn-primary", onclick: () => add() }, icon("filePlus"), paths.length > 1 ? `Add ${paths.length} to the vault` : "Add to the vault");
    const card = h("div", { class: "drop-card", role: "status" },
      h("button", { class: "drop-card-x icon-btn", title: "Leave it outside the vault", onclick: () => shut() }, icon("x")),
      h("div", { class: "drop-card-title" }, icon("file"), h("span", { text: paths.length > 1 ? `${paths.length} files opened` : `${names[0]} opened` })),
      h("div", { class: "drop-card-text", text: paths.length > 1 ? "They are open as tabs and are not in your vault. Add them if they belong there:" : "It is open as a tab and is not in your vault. Add it if it belongs there:" }),
      chips,
      h("div", { class: "drop-card-field" }, icon("folder"), input, list),
      moveBox,
      h("div", { class: "drop-card-acts" }, addBtn, h("button", { class: "btn", onclick: () => shut() }, "Not now")));
    function shut() { if (card.close) card.close(); else card.remove(); }
    async function add() {
      const want = input.value.trim().replace(/^[\\/]+|[\\/]+$/g, "").replace(/\\/g, "/");
      addBtn.disabled = true;
      if (!(await clashOk(paths, () => want))) { addBtn.disabled = false; return; }
      let done = 0;
      let last = null;
      for (const p of paths) {
        try {
          // a parked drop is always moved out of the temp folder
          const res = await host.externalImport(p, want, real.includes(p) ? moveIt : true);
          extGone.add(p);
          const rel = res.path;
          const known = () => (res.note ? app.vault.notes.has(rel) : app.vault.files.has(rel));
          for (let k = 0; k < 40 && !known(); k++) await new Promise((r) => setTimeout(r, 50));
          const target = { kind: res.note ? "note" : "file", path: rel };
          const ti = tabs.findIndex((t) => t.kind === "ext" && t.path === p);
          if (ti >= 0 && known()) { retarget(tabs[ti], target, ti === active); }
          last = rel;
          done++;
        } catch (e) {
          toast(`Could not add ${p.split(/[\\/]/).pop()}: ${e}`, { kind: "error" });
        }
      }
      shut();
      if (done) { show(); toast(done > 1 ? `${done} files added to ${want || "the vault root"}` : `Added to ${want || "the vault root"}`, { ms: 5000, action: last ? { label: "Show in the tree", run: () => { app.setSetting("sidebar", true); sidebar.reveal(last); } } : null }); }
    }
    // it stays while you type a folder or the list is open
    cornerCard(card, { ms: cardMs() * 2, reset: app.settings.cornerHoverResets !== false, hold: () => card.contains(document.activeElement) || !list.hidden });
  }
  app.revealInTree = (p) => { app.setSetting("sidebar", true); sidebar.reveal(p); };
  app.addToVaultCard = (paths) => addToVaultCard([].concat(paths));
  const dirnameOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

  function activate(i) {
    if (i < 0 || i >= tabs.length || i === active) return;
    flushCur();
    active = i;
    show();
  }

  /* ── closing several in a row ──────────────────────────────────────────
     Close a tab with its cross and the strip keeps the width it had, so the
     next cross is already under the pointer - close five without moving your
     hand. The moment the pointer leaves the strip, or a few seconds pass, the
     tabs glide back to the size they should be. */
  const KEEP_WIDTH_MS = 500; // once the ghost has closed up; longer while the pointer stays on the strip
  let holdTimer = 0;

  const slackEl = h("div", { class: "tab-slack" });
  let settleTimer = 0;
  function holdWidths(px) {
    if (!px || tabs.length < 2) return;
    clearTimeout(holdTimer);
    // a close while the row is still gliding back: it holds from where it is now
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; slackEl.style.transition = ""; }
    tabsEl.classList.remove("is-settling");
    tabsEl.style.setProperty("--tab-hold", px + "px");
    tabsEl.classList.add("is-holding");
    holdTimer = setTimeout(tick, KEEP_WIDTH_MS);
  }
  // as long as the pointer stays on the strip the widths stay: the row settles once the hand has moved on
  const tick = () => { if (tabsEl.matches(":hover")) holdTimer = setTimeout(tick, 400); else releaseWidths(); };

  // The hold ends in one glide: the tabs ease to the width they should have
  // while the room kept at the end of a scrolled row closes up with them, so
  // the row slides into place instead of jumping (a single step, taken at
  // once, threw a long scrolled row across by everything that had closed).
  const SETTLE_MS = 380;
  function finishRelease() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    if (slackEl.isConnected) slackEl.remove();
    slackEl.style.transition = "";
    tabsEl.classList.remove("is-holding", "is-settling");
    tabsEl.style.removeProperty("--tab-hold");
  }
  function releaseWidths() {
    clearTimeout(holdTimer);
    holdTimer = 0;
    if (!tabsEl.classList.contains("is-holding")) { if (slackEl.isConnected) slackEl.remove(); return; }
    if (settleTimer) return;
    const held = parseFloat(tabsEl.style.getPropertyValue("--tab-hold")) || 0;
    const slackW = slackEl.isConnected ? slackEl.offsetWidth : 0;
    const scrolled = tabsEl.scrollLeft; // the measuring below shortens the row for a moment, which would clamp this at once
    // where the tabs will end up: measured with the hold off, before anything is painted
    tabsEl.classList.remove("is-holding");
    if (slackW) slackEl.style.width = "0px";
    const sample = tabsEl.querySelector(".tab:not(.is-pinned)");
    const natural = sample ? sample.getBoundingClientRect().width : held;
    tabsEl.classList.add("is-holding");
    if (slackW) slackEl.style.width = slackW + "px";
    tabsEl.scrollLeft = scrolled;
    if (!motionOk() || !held || (Math.abs(natural - held) < 1 && !slackW)) return finishRelease();
    void tabsEl.offsetWidth; // the held state is the start of the glide
    tabsEl.classList.add("is-settling");
    tabsEl.style.setProperty("--tab-hold", natural + "px");
    if (slackW) { slackEl.style.transition = `width ${SETTLE_MS}ms cubic-bezier(0.33, 0, 0.15, 1)`; slackEl.style.width = "0px"; }
    settleTimer = setTimeout(finishRelease, SETTLE_MS + 40);
  }

  // leaving the strip means the hand has moved on
  tabsEl.addEventListener("mouseleave", () => { if (holdTimer) releaseWidths(); });

  /** After closing the tab at `i`: the nearest tab still open that is not a view - the one now in its place first,
      then the one before. -1 when only views are left. */
  function nextDocTab(i) {
    const ok = (k) => k >= 0 && k < tabs.length && tabs[k].kind !== "view" && !TG.isHidden(groups, tabs[k]);
    for (let d = 0; d < tabs.length; d++) { if (ok(i + d)) return i + d; if (ok(i - 1 - d)) return i - 1 - d; }
    return -1;
  }
  /** The tab visited before `t` in this space that is still open (not hidden in a folded group): { k, at }. */
  function prevVisited(t) {
    for (let a = trail.at; a >= 0; a--) {
      const l = trail.list[a];
      if (!l || l.space !== space.id || !l.tab || l.tab === t.id) continue;
      const k = tabs.findIndex((x) => x.id === l.tab);
      if (k >= 0 && !TG.isHidden(groups, tabs[k])) return { k, at: a };
    }
    return null;
  }
  function closeTab(i) {
    const t = tabs[i];
    if (!t) return;
    // whatever closed it - the cross, Ctrl+W, a menu - the other tabs keep their widths and the
    // accent bar lands on the new tab without a slide: only the tabs after the closed one move
    const el = [...tabsEl.querySelectorAll(".tab")].find((x) => x._tid === t.id);
    if (el) holdWidths(el.getBoundingClientRect().width);
    inkSnap = true;
    if (t.kind === "web" && t.wid) host.tabWebClose([t.wid]).catch(() => {});
    // closing the last tab of a playing file stops it
    if (t.kind === "file" && app.media.has(t.path) && !tabs.some((x, k) => k !== i && same(x, t))) app.media.dispose(t.path);
    if (t.kind === "note" && dirty.has(t.path)) flushSave(t.path);
    if (t.kind === "ext" && extView && extView.path === t.path && extView.dirty) extView.flush();
    closed.push({ ...loc(t), at: i, space: space.id, ...TG.tabExtras(t) });
    if (closed.length > 30) closed.shift();
    tabs.splice(i, 1);
    // whoever was opened from the closed tab now counts as opened from ITS opener
    for (const x of tabs) if (x.from === t.id) x.from = t.from;
    // the tab you were on before this one, in this space, still open: back to it - and Forward from there opens
    // the closed tab again (Back no longer brings it back, it was just the step before)
    const prev = i === active ? prevVisited(t) : null;
    if (prev) {
      active = prev.k;
      // its earlier visits leave the way back; the one step forward is it
      const before = trail.list.slice(0, prev.at + 1).filter((l) => l.tab !== t.id);
      trail.list = [...before, { ...loc(t), tab: t.id, space: space.id }];
      trail.at = before.length - 1;
      trail.walking = true;
      try { dropTabPane(t); show(); } finally { trail.walking = false; }
      return;
    }
    if (i === active) {
      const home = t.from ? tabs.findIndex((x) => x.id === t.from) : -1;
      // opened from a view (Home, the Player...) while other tabs are still open: the next tab, so Ctrl+W can go on
      // closing - the view comes back only once no tab is left (and Back still goes wherever you were)
      const fromAView = home < 0 ? !!t.fromView : tabs[home].kind === "view";
      const next = fromAView ? nextDocTab(i) : -1;
      if (next >= 0) active = next;
      else if (home < 0 && t.fromView && mounts[t.fromView]) { active = -1; floating = { kind: "view", view: t.fromView, back: [], fwd: [] }; }
      else active = home >= 0 && !TG.isHidden(groups, tabs[home]) ? home : TG.nearestVisible(tabs, groups, Math.min(i, tabs.length - 1));
    } else if (i < active) active--;
    dropTabPane(t);
    show();
  }

  // Ctrl+Shift+T: the last closed tab comes back where it was
  let rebornId = 0; // the tab Ctrl+Shift+T just brought back: it comes in its own way
  function reopenTab(anywhere = false) {
    // the last tab closed in this space: Ctrl+Shift+T never carries you off to another one
    let k = closed.length - 1;
    while (k >= 0 && (!exists(closed[k]) || (!anywhere && closed[k].space && closed[k].space !== space.id && spaces.some((x) => x.id === closed[k].space)))) k--;
    if (k < 0) {
      const other = [...closed].reverse().find((x) => exists(x) && x.space !== space.id && spaces.some((s) => s.id === x.space));
      if (other) {
        const sp = spaces.find((s) => s.id === other.space);
        toast(`No closed tab in this space - the last one was in “${(sp && sp.name) || "another space"}”`, { ms: 5000, action: { label: "Reopen it there", run: () => reopenTab(true) } });
      }
      return;
    }
    const l = closed.splice(k, 1)[0];
    if (l.space !== space.id && spaces.some((x) => x.id === l.space)) spacesApi.switchTo(l.space);
    const open = tabs.findIndex((t) => same(t, l));
    if (open >= 0) { active = open; return show(); }
    flushCur();
    const t = mkTab(l.kind === "view" ? { kind: "view", view: l.view } : { kind: l.kind, path: l.path }, TG.tabExtras(l));
    if (t.group && !groups.some((g) => g.id === t.group)) delete t.group;
    tabs.splice(Math.min(Math.max(0, l.at ?? tabs.length), tabs.length), 0, t);
    rebornId = t.id;
    reflow();
    active = tabs.indexOf(t);
    show();
    setTimeout(() => { if (rebornId === t.id) rebornId = 0; }, 800);
  }

  // their pages go too, or one left playing goes on with no tab to stop it. After show(): the page in view is not let go of
  const closeWebs = (gone) => { if (webTab) for (const t of gone) if (t.kind === "web" && t.wid) webTab.unload(t.wid); };
  function closeWhere(keep, anchorTab) {
    const was = active >= 0 ? tabs[active] : null;
    const gone = tabs.filter((x, k) => !keep(x, k));
    const kept = tabs.filter(keep);
    // as closing one tab does: saved first, a file playing only here stops, and Ctrl+Shift+T brings them back
    gone.forEach((x) => {
      if (x.kind === "note" && dirty.has(x.path)) flushSave(x.path);
      if (x.kind === "file" && app.media.has(x.path) && !kept.some((y) => same(y, x))) app.media.dispose(x.path);
      closed.push({ ...loc(x), at: tabs.indexOf(x), space: space.id, ...TG.tabExtras(x) });
    });
    while (closed.length > 30) closed.shift();
    tabs = kept;
    active = was && tabs.includes(was) ? tabs.indexOf(was) : tabs.indexOf(anchorTab);
    show();
    closeWebs(gone);
  }

  /* Back / Forward walk one trail of where you have been, across tabs and
     spaces: going back focuses the tab that showed it, or reopens it if that
     tab was closed. 80 small entries, nothing else to keep. */
  const trail = { list: [], at: -1, walking: false };
  function recordTrail(t) {
    if (trail.walking || !space) return;
    const l = { ...loc(t), tab: t === floating ? 0 : t.id, space: space.id };
    const c = trail.list[trail.at];
    if (c && same(c, l)) { c.tab = l.tab; c.space = l.space; return; }
    trail.list.splice(trail.at + 1);
    trail.list.push(l);
    if (trail.list.length > 80) trail.list.shift();
    trail.at = trail.list.length - 1;
  }
  // the entry `dir` steps away that can still be shown (skipping gone files)
  function trailStep(dir) {
    const here = cur();
    for (let i = trail.at + dir; i >= 0 && i < trail.list.length; i += dir) {
      const l = trail.list[i];
      // a page tab is one stop, whatever page it was on: stepping onto the tab already in front does nothing
      const front = active >= 0 ? tabs[active] : null;
      const sameTab = front && l.kind === "web" && front.kind === "web" && l.tab === front.id;
      if (exists(l) && (l.space !== space.id || (!same(l, here) && !sameTab))) return i;
    }
    return -1;
  }
  function goTrail(i) {
    const l = trail.list[i];
    if (!l) return false;
    trail.walking = true;
    try {
      trail.at = i;
      flushCur();
      if (l.space !== space.id && spaces.some((x) => x.id === l.space)) spacesApi.switchTo(l.space);
      let k = tabs.findIndex((t) => t.id === l.tab && same(t, l));
      if (k < 0) k = tabs.findIndex((t) => same(t, l));
      if (k >= 0) { active = k; show(); }
      else {
        // the tab it was in is still open: a page tab that slept and woke has a new webview, so it no longer
        // matched and the page was opened again as a new tab, every step. That tab comes forward instead
        // (its own page history is in its own arrows); a note's tab that went on to another note goes back to it
        const own = l.tab ? tabs.findIndex((t) => t.id === l.tab && t.kind === l.kind) : -1;
        if (own >= 0 && l.kind === "web") { active = own; show(); }
        else if (own >= 0 && !tabs[own].pinned) { active = own; retarget(tabs[own], { ...loc(l) }, false); show(); }
        else navigate({ ...loc(l) }, { newTab: isDoc(l) });
      }
    } finally {
      trail.walking = false;
    }
    return true;
  }
  function history(dir) {
    const i = trailStep(dir);
    return i >= 0 ? goTrail(i) : false;
  }
  // right-click on Back / Forward: the steps, to jump several at once
  function trailMenu(dir, anchor) {
    const items = [];
    for (let i = trail.at + dir; i >= 0 && i < trail.list.length && items.length < 16; i += dir) {
      const l = trail.list[i];
      if (!exists(l)) continue;
      const inf = tabInfo(l);
      const sp = l.space !== space.id ? spaces.find((x) => x.id === l.space) : null;
      items.push({ label: inf.title + (sp ? `  ·  ${sp.name}` : ""), icon: inf.icon, run: () => goTrail(i) });
    }
    if (!items.length) items.push({ header: dir < 0 ? "Nothing further back" : "Nothing further forward", plain: true });
    menu(0, 0, [{ header: dir < 0 ? "Back to" : "Forward to" }, ...items], { anchor });
  }

  function addRecent(p) {
    const r = (app.settings.recent || []).filter((x) => x !== p);
    r.unshift(p);
    app.settings.recent = r.slice(0, 40);
    saveSettings();
  }

  /* spaces: each keeps its own tabs */
  function storeSpace() {
    if (!space) return;
    space.tabs = tabs.map((t) => ({ ...loc(t), ...TG.tabExtras(t) }));
    space.groups = TG.saveGroups(groups);
    space.active = active;
    if (active >= 0) space.lastTab = active; // the tab it was on before a view took the screen
    space.floatingView = floating.kind === "view" ? floating.view : "home";
    if (split) storePanes();
  }

  function loadSpace() {
    tabs = [];
    restoringTabs = true;
    // a note in a folder left out of indexing is not in the vault's lists: its tab opens it from the disk, not closed
    const root = String(app.vault.root || "").replace(/[\\/]+$/, "");
    const unindexed = (p) => (Array.isArray(app.settings.noIndex) ? app.settings.noIndex : []).some((f) => p.toLowerCase().startsWith(String(f).toLowerCase().replace(/\/+$/, "") + "/"));
    for (let l of space.tabs || []) {
      if (l && l.kind === "note" && !exists(l) && root && unindexed(l.path)) l = { ...l, kind: "ext", path: root + "/" + l.path };
      // and back: the folder is indexed again, so the note is in the vault - its tab is a note tab again
      else if (l && l.kind === "ext" && root && String(l.path).startsWith(root + "/") && app.vault.notes.has(String(l.path).slice(root.length + 1))) l = { ...l, kind: "note", path: String(l.path).slice(root.length + 1) };
      if (!l || !exists(l)) continue;
      tabs.push(mkTab(l.kind === "view" ? { kind: "view", view: l.view } : { kind: l.kind, path: l.path }, TG.tabExtras(l)));
    }
    restoringTabs = false;
    // older sessions have no groups or colours; normalize copes either way
    ({ tabs, groups } = TG.normalize(tabs, TG.cleanGroups(space.groups)));
    active = Number.isInteger(space.active) && space.active >= 0 && space.active < tabs.length ? space.active : -1;
    floating = { kind: "view", view: mounts[space.floatingView] ? space.floatingView : "home", back: [], fwd: [] };
    // the workspace room belongs to workspaces' spaces: a plain space left on it comes back on its
    // own last tab instead (the room there would only list the workspaces)
    if (active < 0 && floating.view === "room" && tabs.length && !workspaceSpaceIds(app).has(space.id)) {
      active = Number.isInteger(space.lastTab) && space.lastTab < tabs.length ? space.lastTab : tabs.length - 1;
      floating.view = "home";
    }
    if (split) loadPanes();
  }

  // the emoji before a space name in plain text (built-in icons can't be text)
  const emojiOf = (s) => (s.icon && !s.icon.startsWith("i:") ? s.icon + "  " : "");

  function initSpaces() {
    const S = app.settings;
    if (Array.isArray(S.spaces) && S.spaces.length) {
      spaces = S.spaces.filter((s) => s && s.id);
    } else {
      // first run: the old single session becomes the Default space (documents only;
      // views no longer open as tabs)
      let old = S.session && Array.isArray(S.session.tabs) ? S.session.tabs.filter((l) => l && l.kind === "note") : [];
      // a brand-new vault: the note that explains the app is open, not a row in Home's Recent
      if (!old.length && ownWelcome()) old = [{ kind: "note", path: "Welcome.md" }];
      spaces = [{ id: "default", name: "Default", icon: "i:astra", tabs: old, active: old.length ? 0 : -1 }];
    }
    // the untouched default space takes the astra star (it used to be a house)
    const def = spaces.find((s) => s.id === "default");
    if (def && def.icon === "🏠" && !(S.migrations || []).includes("astra-1")) { def.icon = "i:astra"; S.migrations = [...(S.migrations || []), "astra-1"]; }
    const out = spaces.find((s) => s.id === "outside");
    if (out && out.icon === "📂") out.icon = "i:outside";
    space = spaces.find((s) => s.id === S.activeSpace) || spaces[0];
    loadSpace();
  }

  const saveSession = debounce(() => {
    storeSpace();
    app.settings.spaces = spaces;
    app.settings.activeSpace = space.id;
    delete app.settings.session;
    saveSettings();
  }, 300);

  let spaceBefore = null; // the space switched away from last: Alt+` goes back to it
  const spacesApi = {
    list: () => spaces,
    current: () => space,
    /** The space you were in before this one (still there), or null. */
    before: () => spaces.find((s) => s.id === spaceBefore && s !== space) || null,
    // back to the space you came from as a step BACK in history: Forward then returns here, and going
    // somewhere new drops that forward step, as Back does everywhere
    back() {
      const b = spacesApi.before();
      if (!b) return;
      for (let i = trail.at - 1; i >= 0; i--) if (trail.list[i].space === b.id && exists(trail.list[i])) return goTrail(i);
      spacesApi.switchTo(b.id);
    },
    /** What a space holds, for a look without going there: its groups, and its tabs with their titles. */
    peek(id) {
      const s = spaces.find((x) => x.id === id);
      if (!s) return null;
      const list = s === space ? tabs.map((t) => ({ ...loc(t), group: t.group || null })) : (s.tabs || []);
      const gs = (s === space ? groups : TG.cleanGroups(s.groups)).map((g) => ({ id: g.id, label: groupLabel(g), swatch: TG.colorVar(g.color) }));
      const on = s === space ? active : s.active;
      return { groups: gs, tabs: list.map((l, i) => ({ l, group: l.group || null, on: i === on, ...tabInfo(l) })) };
    },
    /** Go to a space and to one of its tabs. */
    openTab(id, l) {
      if (space.id !== id) spacesApi.switchTo(id);
      const i = tabs.findIndex((t) => same(t, l));
      if (i >= 0) { flushCur(); active = i; show(); }
    },
    switchTo(id) {
      const next = spaces.find((s) => s.id === id);
      if (!next || next === space) return;
      spaceBefore = space.id;
      flushCur();
      storeSpace();
      space = next;
      loadSpace();
      show();
      spacesUi.paint();
      app.bus.emit("space", space.id);
      toast(`${emojiOf(space)}${space.name}`, { ms: 900 });
      // the space you are in is the one the app opens in next time, however it is closed
      saveSession();
    },
    add({ name = "New space", icon = "✨" } = {}) {
      const s = { id: "sp-" + Date.now().toString(36), name, icon, tabs: [], active: -1 };
      spaces.push(s);
      saveSession();
      spacesUi.paint();
      return s;
    },
    rename(id, name) {
      const s = spaces.find((x) => x.id === id);
      if (s && name) { s.name = name; saveSession(); spacesUi.paint(); }
    },
    setIcon(id, emoji) {
      const s = spaces.find((x) => x.id === id);
      if (s) { s.icon = emoji; saveSession(); spacesUi.paint(); }
    },
    remove(id) {
      if (spaces.length < 2) return null;
      const i = spaces.findIndex((x) => x.id === id);
      if (i < 0) return null;
      storeSpace();
      const [s] = spaces.splice(i, 1);
      if (s === space) { space = spaces[Math.max(0, i - 1)]; loadSpace(); show(); app.bus.emit("space", space.id); }
      closeWebs(s.tabs || []);
      saveSession();
      spacesUi.paint();
      return () => { spaces.splice(Math.min(i, spaces.length), 0, s); saveSession(); spacesUi.paint(); };
    },
    /** The space as it would be saved right now (the current one's tabs are live, not stored yet). */
    snapshot() { storeSpace(); return space; },
    /** A deleted space comes back, at the end; an id that is taken again gets a new one. */
    restore(s) {
      const back = { ...s, id: spaces.some((x) => x.id === s.id) ? "sp-" + Date.now().toString(36) : s.id };
      spaces.push(back);
      saveSession();
      spacesUi.paint();
      return back;
    },
    move(from, to) {
      const [s] = spaces.splice(from, 1);
      spaces.splice(to, 0, s);
      saveSession();
      spacesUi.paint();
    },
    step(d) {
      const i = spaces.indexOf(space);
      spacesApi.switchTo(spaces[(i + d + spaces.length) % spaces.length].id);
    },
  };  app.spacesApi = spacesApi;


  /** Where in space `s` a tab can go: its start, its end, one of its groups - and the same, going along with it. */
  function spotsIn(s, t) {
    const gs = TG.cleanGroups(s.groups);
    const to = (o) => () => app.placeInSpace(t, s.id, { ...o, from: space.id });
    return [
      { header: `${emojiOf(s)}${s.name}` },
      { label: "At the start", icon: "back", run: to({ at: "start" }) },
      { label: "At the end", icon: "forward", run: to({ at: "end" }) },
      ...(gs.length ? [{ header: "Into a group" }, ...gs.map((g) => ({ label: groupLabel(g), swatch: TG.colorVar(g.color), run: to({ group: g.id }) }))] : []),
      "sep",
      { label: "At the end, and go there", icon: "outside", run: to({ at: "end", go: true }) },
    ];
  }
  function moveTabToSpace(i, s) {
    const t = tabs[i];
    if (!t) return;
    // a single tab leaves its group behind, but keeps its colour
    s.tabs = [...(s.tabs || []).filter((l) => !same(l, t)), { ...loc(t), ...(t.color ? { color: t.color } : {}) }];
    closeTab(i);
    toast(`Moved to ${emojiOf(s)}${s.name}`);
  }

  /* ── split view: a second pane with its own tabs ───────────────────────── */
  let splitFocused = false;
  split = app.split = mountSplit(app, $(".body"), {
    makeEditor: (host, scroller) => {
      const ed = createEditor(host, noteEditorOptions(() => ed, scroller, {}));
      return ed;
    },
    makeFileView: (el) => mountFileView(app, el),
    makeExtView: (el) => mountExtView(app, el, { makeEditor: (host, scroller, own) => { const ed = createEditor(host, noteEditorOptions(() => ed, scroller, own)); return ed; } }),
    tabInfo: (t) => (t.kind === "web" ? { icon: "globe", title: (() => { try { return new URL(t.path).hostname.replace(/^www\./, "") || "Browser"; } catch { return "Browser"; } })() } : tabInfo(t)),
    exists: (l) => (l.kind === "web" ? true : l.kind === "ext" ? !extGone.has(l.path) : l.kind === "note" ? app.vault.notes.has(l.path) : app.vault.files.has(l.path) || guests.has(l.path)),
    onSave: (p) => flushSave(p),
    mainDoc: () => { const t = cur(); return active >= 0 && isDoc(t) ? loc(t) : null; },
    // from the split to the main pane: swapped into the current tab, or a tab of its own
    onToMain: (l, fresh) => {
      if (l.kind === "web") return app.openUrl(l.path); // a page has no main-pane form: your browser takes it
      flushCur();
      if (fresh || active < 0) return navigate(loc(l));
      retarget(tabs[active], loc(l), false);
      show();
    },
    onTabDrop: (i) => moveToSplit(i),
    onArchiveDrop: (d) => app.archiveBeside(d),
    onChange: () => { splitChanged(); saveSession(); },
    shared: () => shown === "all",
    toggleShared: () => { setShared(shown !== "all"); for (const b of document.querySelectorAll(".sp-shared")) b.classList.toggle("is-on", shown === "all"); },
    onFocus: (on) => { splitFocused = on; },
  });
  function moveToSplit(i) {
    const t = tabs[i];
    if (!t || !canSplit(t)) return toast("Notes and files open in the split view");
    if (t.kind === "note" && dirty.has(t.path)) flushSave(t.path);
    if (t.kind === "ext" && extView && extView.dirty) extView.flush();
    // the tab goes first, so the side pane belongs to the one that is shown then
    const l = loc(t);
    if (!t.pinned) closeTab(i);
    split.open(l);
  }
  /** A note or file shown in `host` by the very views a tab uses (the note editor, the file view). */
  app.mountDoc = (host, l) => {
    if (l.kind === "note") {
      const edHost = h("div", { class: "editor-host" });
      const scroller = h("div", { class: "note-scroll" }, edHost);
      host.replaceChildren(scroller);
      const ed = createEditor(edHost, noteEditorOptions(() => ed, scroller, {}));
      const n = app.vault.get(l.path);
      ed.open(l.path, n ? n.content : "", { pos: app.positions[l.path] });
      roomEds.add(ed);
      return { destroy: () => { if (dirty.has(ed.path)) flushSave(ed.path); roomEds.delete(ed); try { ed.destroy(); } catch {} } };
    }
    const fv = mountFileView(app, host);
    fv.show(l.path);
    roomFiles.add(fv);
    return { destroy: () => { roomFiles.delete(fv); try { fv.destroy(); } catch {} } };
  };
  /** A look beside the current tab, in the split view's preview tab (the next look replaces it). */
  /* A look beside the current tab, in the split view's preview tab (the next look replaces it): on the
     right, and only with the tab (or view) it was opened from - any other tab and it steps aside. A
     file from outside the vault goes the way a tab takes it (Leonote's own kinds through the guest
     route, so Leopaint and the rest open as they do in a tab). */
  const routed = async (l) => {
    if (l.kind === "ext" && GUEST_RE.test(l.path) && host.guestOpen) {
      const entry = await host.guestOpen(l.path).catch(() => null);
      if (entry) { guests.set(entry.path, { ...entry, abs: l.path }); return { kind: "file", path: entry.path }; }
    }
    return l;
  };
  /** keep: a tab of the side pane that stays (not the preview the next look replaces). */
  app.previewBeside = async (l, { keep = false } = {}) => {
    l = await routed(l);
    claimSplit();
    if (!split.isOpen) split.setSide("right");
    split.open(l, { focus: false, preview: !keep });
  };
  /** A file of an archive kept beside (dropped onto the side pane, or "Keep it beside"). */
  app.archiveBeside = async ({ abs, entry }) => {
    try { await app.previewBeside({ kind: "ext", path: await host.archivePreview(abs, entry) }, { keep: true }); }
    catch (e) { toast("Could not take it out: " + e, { kind: "error", ms: 5000 }); }
  };
  // Research side by side: a path, or several (the graph opens many at once)
  app.openSplit = (paths) => {
    for (const p of [].concat(paths)) {
      if (app.vault.notes.has(p)) split.open({ kind: "note", path: p });
      else if (app.vault.files.has(p)) split.open({ kind: "file", path: p });
    }
  };
  function toggleSplit() {
    if (split.isOpen) return split.hide();
    const t = cur();
    if (active >= 0 && isDoc(t)) {
      // the tab before this one moves into view, this one goes to the side
      const prev = tabs.findIndex((x, k) => k !== active && isDoc(x));
      if (prev >= 0) { const l = loc(t); activate(prev); split.open(l, { focus: false }); return; }
      return split.open(loc(t));
    }
    const recent = (app.settings.recent || []).find((p) => app.vault.notes.has(p));
    if (recent) split.open({ kind: "note", path: recent });
    else toast("Open a note first, then split");
  }

  /* Whose side pane it is. By default the side pane belongs to the tab it was opened on: the next
     tab shows its own side pane, or none. Turned "across tabs", it is shared - every tab shows it,
     except a tab with a side pane of its own, which shows that one. What a tab's pane holds (its
     tabs, widths, pages) is kept while the tab is away. */
  const paneOf = new Map(); // tab key -> its side pane's state while it is not on screen
  let shown = null; // whose side pane is in the split now: a tab key, "all", or null
  let shared = null, sharedOn = false; // the shared one's state while it is away; whether there is one
  const hereKey = () => (active >= 0 && tabs[active] ? "t:" + tabs[active].id : "v:" + floating.view);
  const putAway = () => { if (!shown) return; const st = split.state({ all: true }); if (shown === "all") shared = st; else paneOf.set(shown, st); };
  function bringOut(want) { putAway(); split.load(want === "all" ? shared : paneOf.get(want) || null); if (want !== "all") paneOf.delete(want); shown = want; }
  function syncSplit() {
    const k = hereKey();
    const want = shown === k || paneOf.has(k) ? k : sharedOn ? "all" : null;
    if (want && want !== shown) bringOut(want);
    split.suspend(!want);
  }
  // about to open something in the side pane: it goes to this tab's own, unless a shared one is up here
  function claimSplit() {
    const k = hereKey();
    if (shown === k || (shown === "all" && !paneOf.has(k))) { split.suspend(false); return; }
    bringOut(k);
    split.suspend(false);
  }
  for (const fn of ["open", "openAt", "openWeb"]) { const f = split[fn]; split[fn] = (...a) => { claimSplit(); return f(...a); }; }
  // the pane emptied: it belongs to nobody now
  function splitChanged() {
    if (split.isOpen || !shown) return;
    if (shown === "all") { sharedOn = false; shared = null; }
    shown = null;
  }
  function setShared(on) {
    if (on && shown && shown !== "all") { sharedOn = true; shown = "all"; }
    else if (!on && shown === "all") { sharedOn = false; shared = null; shown = hereKey(); }
    saveSession();
    app.toast(on ? "The side pane now shows on every tab - a tab with its own shows that one" : "The side pane now stays with this tab", { ms: 3200 });
  }
  function dropTabPane(t) {
    const k = "t:" + t.id;
    paneOf.delete(k);
    if (shown === k) { split.load(null); shown = null; }
  }
  // a space keeps them by each tab's document (tab ids are per session)
  const locKey = (l) => `${l.kind}:${l.kind === "view" ? l.view : l.path}`;
  function storePanes() {
    const live = split.state();
    space.split = shown === "all" ? live : sharedOn ? shared : null;
    const own = {};
    for (const [k, st] of paneOf) { const t = tabs.find((x) => "t:" + x.id === k); if (t) own[locKey(loc(t))] = st; else if (k.startsWith("v:")) own["view:" + k.slice(2)] = st; }
    if (shown && shown !== "all") { const t = tabs.find((x) => "t:" + x.id === shown); if (t) own[locKey(loc(t))] = live; else if (shown.startsWith("v:")) own["view:" + shown.slice(2)] = live; }
    space.tabPanes = own;
  }
  function loadPanes() {
    paneOf.clear();
    for (const [lk, st] of Object.entries(space.tabPanes || {})) {
      if (lk.startsWith("view:")) { paneOf.set("v:" + lk.slice(5), st); continue; }
      const t = tabs.find((x) => locKey(loc(x)) === lk);
      if (t) paneOf.set("t:" + t.id, st);
    }
    // an older session's side pane, and a shared one, are shared
    sharedOn = !!(space.split && ((space.split.tabs || []).length || space.split.cols));
    shared = sharedOn ? space.split : null;
    shown = null;
    split.load(null);
    syncSplit();
  }
  app.bus.on("view", () => syncSplit());
  app.bus.on("view", (t) => { if (t && t.kind === "view" && t.view === "music" && app.settings.compact) setCompact(false); });

  // where the last right-click was: the Assistant's card opens there
  let ctxAt = { x: 240, y: 200 };
  document.addEventListener("contextmenu", (e) => { ctxAt = { x: e.clientX, y: e.clientY }; }, true);
  /** The Assistant about the text under the pointer: the selection, or the paragraph the click landed in. */
  // the selected words as a task that links back to this note ("check X" in a research note), no AI needed
  function taskRows(path, from = editor) {
    // the selection of the pane that was right-clicked (the split's own, not the main editor's)
    const line = String((from && from.range ? from.range() : editor.range()).text || "").trim().split("\n")[0].trim();
    if (!line || !path) return [];
    return [{ label: "Make a task of it", icon: "checkSquare", run: () => {
      const id = app.tasks.create(`${line.slice(0, 200)} [[${app.vault.linkText(path)}]]`, { priority: "none" });
      toast("Task added, linked to this note", { ms: 4000, action: { label: "Undo", run: () => app.tasks.trash(id) } });
    } }];
  }

  function assistantRows() {
    const picked = () => {
      const r = editor.range();
      if (r.text && r.text.trim()) return r.text;
      const para = editor.paragraph ? editor.paragraph() : "";
      return para || "";
    };
    const ask = (prompt) => {
      if (app.settings.aiInline === false) return app.askAssistant({ selection: picked(), prompt });
      // the picked range, so the answer can take its place: the selection, or the paragraph found around the caret
      const r = editor.range();
      let from = r.from, to = r.to, text = r.text && r.text.trim() ? r.text : "";
      if (!text) {
        const para = editor.paragraph ? editor.paragraph() : "";
        const all = editor.content(editor.path) || "";
        const i = para ? all.lastIndexOf(para, r.from) : -1;
        if (i >= 0 && i + para.length >= r.from) { from = i; to = i + para.length; text = para; } else { from = to = null; text = para || ""; }
      }
      import("./aipop.js").then((m) => m.askInline(app, { selection: text, prompt, path: editor.path, from, to, x: ctxAt.x, y: ctxAt.y }));
    };
    const mic = voiceButton({ cls: "icon-btn menu-mic", title: "Say what to do with this text", onText: (said) => { closeMenu(); ask(said); } });
    // your own commands (aiview.js keeps the list)
    const myAi = Array.isArray(app.settings.aiCommands) ? app.settings.aiCommands.filter((c) => c && c.label && c.prompt) : [];
    return [
      "sep",
      { label: "Ask the Assistant about this", icon: "sparkles", tail: mic, run: () => ask("") },
      { label: "Assistant", icon: "sparkles", sub: [
        { label: "Summarise", icon: "sparkles", run: () => ask("Summarise this in a few plain sentences.") },
        { label: "Improve the writing", icon: "edit", run: () => ask("Rewrite this so it reads better - same meaning, same voice, tighter. Give only the rewritten text.") },
        { label: "Fix spelling and grammar", icon: "check", run: () => ask("Fix the spelling and grammar only; change nothing else. Give only the corrected text.") },
        { label: "Explain", icon: "lightbulb", run: () => ask("Explain this plainly, as to a smart friend.") },
        { label: "Turn into tasks", icon: "checkSquare", run: () => ask("List the action items in this as Markdown checkboxes (- [ ] ...), only what the text supports.") },
        { label: "Continue writing", icon: "pen", run: () => ask("Continue this text for another paragraph or two in the same voice. Give only the continuation.") },
        ...(myAi.length ? ["sep", ...myAi.map((c) => ({ label: c.label, icon: "bolt", title: c.prompt, run: () => ask(c.prompt) }))] : []),
        "sep",
        { label: "A command of your own…", icon: "plus", run: () => import("./aiview.js").then((m) => m.addMyCommand(app)) },
      ] },
    ];
  }

  function splitRows(path) {
    if (!path) return [];
    const inSide = split.isOpen && splitFocused;
    const here = { kind: "note", path };
    const to = (s, fn) => () => { split.setSide(s); fn(); };
    const near = (f) => Math.abs(split.share - f) < 0.03;
    return [
      "sep",
      app.settings.scriptMenu !== false ? { label: "Read as script", icon: "play", run: () => app.readAsScript(path) } : null,
      { label: "Split view", icon: "columns", sub: [
        inSide ? null : { label: "Open this note on the right", icon: "panelRight", run: to("right", () => split.open(here, { focus: false })) },
        inSide ? null : { label: "Open this note on the left", icon: "sidebar", run: to("left", () => split.open(here, { focus: false })) },
        inSide || active < 0 ? null : { label: "Move this note to the side", icon: "forward", run: () => moveToSplit(active) },
        split.isOpen ? null : { label: "Split with the previous tab", icon: "columns", keys: "Ctrl Alt \\", run: () => toggleSplit() },
        { label: "Pick a note for the side…", icon: "search", run: () => pickForSplit() },
        { label: "Browser in the side pane", icon: "globe", run: () => split.openWeb("") },
        { label: "Search the web for the selection", icon: "search", run: () => { const r = editor.view.state.selection.main; const q = editor.view.state.sliceDoc(r.from, r.to).trim().slice(0, 200); split.openWeb(q || basename(path)); } },
        split.isOpen ? "sep" : null,
        split.isOpen ? { label: "Side pane on every tab", icon: "pin", checked: shown === "all", run: () => setShared(shown !== "all") } : null,
        split.isOpen ? { label: "Swap the two panes", icon: "swap", run: () => split.swap() } : null,
        split.isOpen ? { label: split.side === "left" ? "Side pane to the right" : "Side pane to the left", icon: split.side === "left" ? "panelRight" : "sidebar", run: () => split.setSide(split.side === "left" ? "right" : "left") } : null,
        split.isOpen ? { label: "Side pane: a third", checked: near(0.33), run: () => split.setShare(0.33) } : null,
        split.isOpen ? { label: "Side pane: half", checked: near(0.5), run: () => split.setShare(0.5) } : null,
        split.isOpen ? { label: "Side pane: two thirds", checked: near(0.66), run: () => split.setShare(0.66) } : null,
        split.isOpen ? "sep" : null,
        split.isOpen ? { label: inSide ? "Go to the main pane" : "Go to the side pane", icon: "columns", keys: "Ctrl Alt →", run: () => (inSide ? app.focusMain() : split.focus()) } : null,
        split.isOpen ? { label: "Close the split view", icon: "x", keys: "Ctrl Alt \\", run: () => split.hide() } : null,
      ].filter(Boolean) },
    ];
  }

  /** Choose any note for the side pane, with the folder picker's own search. */
  async function pickForSplit() {
    const notes = [...app.vault.notes.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 400);
    const input = h("input", { class: "pal-input", placeholder: "A note for the side pane…", spellcheck: false });
    const list = h("div", { class: "split-pick-list" });
    const box = h("div", { class: "split-pick" }, input, list);
    const close = () => { box.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = (e) => { if (!box.contains(e.target)) close(); };
    let rows = [];
    let at = 0;
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      rows = notes.filter((n) => !q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)).slice(0, 12);
      at = Math.min(at, Math.max(0, rows.length - 1));
      list.replaceChildren(...rows.map((n, i) => h("button", { class: "split-pick-row" + (i === at ? " is-on" : ""), onclick: () => go(n) }, icon("file"), h("span", { text: n.title }), h("small", { text: n.folder || "" }))));
    };
    const go = (n) => { close(); split.open({ kind: "note", path: n.path }); };
    input.addEventListener("input", () => { at = 0; paint(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); at = (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(1, rows.length); paint(); }
      else if (e.key === "Enter" && rows[at]) { e.preventDefault(); go(rows[at]); }
    });
    document.getElementById("overlay-root").append(box);
    paint();
    input.focus();
    setTimeout(() => document.addEventListener("pointerdown", away, true));
  }

  /* Drag a tab, or anything from the file tree, to the left or right edge of
     the workspace: it opens in a split on that side. The middle keeps what it
     did before (a note dropped into the text becomes a link). */
  {
    const mk = (cls, ic, text) => h("div", { class: "split-zone" + cls }, icon(ic), text);
    const Z = [
      ["left", "top", mk(" is-corner", "sidebar", "Top left")], ["left", null, mk("", "sidebar", "Open on the left")], ["left", "bottom", mk(" is-corner", "sidebar", "Bottom left")],
      ["right", "top", mk(" is-corner", "panelRight", "Top right")], ["right", null, mk("", "panelRight", "Open on the right")], ["right", "bottom", mk(" is-corner", "panelRight", "Bottom right")],
    ];
    const zoneC = h("div", { class: "split-zone is-c", hidden: true }, icon("layers"), "Back to the main tabs");
    const zones = h("div", { class: "split-zones" }, h("div", { class: "split-zone-col is-l" }, ...Z.slice(0, 3).map((z) => z[2])), h("div", { class: "split-zone-col is-r" }, ...Z.slice(3).map((z) => z[2])), zoneC);
    $("#main").append(zones);
    const TYPES = ["application/x-leonote-tab", "application/x-leonote-paths", "application/x-leonote-split"];
    const ours = (e) => e.dataTransfer && [...e.dataTransfer.types].some((t) => TYPES.includes(t));
    const off = () => { zones.classList.remove("is-on"); for (const z of zones.querySelectorAll(".is-over")) z.classList.remove("is-over"); };
    // A tab being moved along the strip is not on its way to a split: the
    // zones wait until it has clearly come down out of the title bar.
    const titleBar = $("#tabs").closest(".titlebar") || $("#tabs").parentElement;
    document.addEventListener("dragover", (e) => {
      if (!ours(e)) return;
      const types = [...e.dataTransfer.types];
      const isTab = types.includes("application/x-leonote-tab");
      zoneC.hidden = !types.includes("application/x-leonote-split");
      const below = e.clientY > titleBar.getBoundingClientRect().bottom + 36;
      if (!isTab || below) zones.classList.add("is-on");
      else if (!zones.querySelector(".is-over")) zones.classList.remove("is-on");
    }, true);
    document.addEventListener("dragend", off, true);
    document.addEventListener("drop", () => setTimeout(off), true);
    window.addEventListener("blur", off);
    // what a drop carries: a main tab, a pane's tab (taken out of its pane), or tree rows
    const carried = (e) => {
      const tab = e.dataTransfer.getData("application/x-leonote-tab");
      if (tab !== "") { const t = tabs[+tab]; return t && canSplit(t) ? [loc(t)] : []; }
      const sp = e.dataTransfer.getData("application/x-leonote-split");
      if (sp) { try { const o = JSON.parse(sp); const l = split.take(o.pane, o.i); return l ? [l] : []; } catch { return []; } }
      let paths = [];
      try { paths = JSON.parse(e.dataTransfer.getData("application/x-leonote-paths") || "[]"); } catch {}
      return paths.slice(0, 12).map(locFor).filter(Boolean);
    };
    const arm = (z, onDrop) => {
      z.addEventListener("dragover", (e) => { if (!ours(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; z.classList.add("is-over"); });
      z.addEventListener("dragleave", () => z.classList.remove("is-over"));
      z.addEventListener("drop", (e) => { if (!ours(e)) return; e.preventDefault(); e.stopPropagation(); off(); onDrop(carried(e)); });
    };
    for (const [side, pos, z] of Z) arm(z, (locs) => locs.forEach((l, k) => split.openAt(side, pos, l, { focus: k === 0 })));
    arm(zoneC, (locs) => { for (const l of locs) { if (l.kind === "web") app.openUrl(l.path); else navigate(l); } });
  }

  /** The picture itself (not its link) to the clipboard, as PNG: as it is shown (with your edits, unless they are
      off), or `want` "edited" / "original". */
  app.copyPicture = (path) => copyPicture(path, "");
  async function copyPicture(target, from, want) {
    const url = resolveImage(target, from);
    if (!url) return toast("That picture is not in the vault any more", { kind: "error" });
    try {
      // a big picture takes a moment to become a PNG: say so, so a paste waits for it
      const busy = setTimeout(() => toast("Copying the picture…", { ms: 1500 }), 150);
      // the clipboard is asked straight away, in the key press itself; which picture (edited or not) follows
      const which = want === "original" ? Promise.resolve(null) : editedImage(url, want === "edited").catch(() => null);
      await copyImageUrl(which.then((e) => e || url)).finally(() => clearTimeout(busy));
      const edited = await which;
      toast(edited ? "Picture copied with your edits" : pictureEdits(target, from) ? "Picture copied without your edits" : "Picture copied", { ms: 1600 });
    } catch (e) {
      toast("Could not copy this picture" + (e && e.message ? ": " + e.message : ""), { kind: "error" });
    }
  }

  /* ── inline title ─────────────────────────────────────────────────────── */
  const titleEl = $("#inline-title");
  const crumbsEl = $("#crumbs");
  const growTitle = () => { titleEl.style.height = "auto"; titleEl.style.height = titleEl.scrollHeight + "px"; };

  function paintTitle() {
    const p = editor.path;
    if (!p) return;
    if (document.activeElement !== titleEl) titleEl.value = basename(p);
    growTitle();
    const parts = dirname(p) ? dirname(p).split("/") : [];
    // a folder in the path: click finds it in the tree, double-click shows it in Explorer, right-click offers what can be made there
    crumbsEl.replaceChildren(...parts.flatMap((seg, i) => {
      const dir = parts.slice(0, i + 1).join("/");
      return [
        h("button", { class: "crumb", text: seg, title: `${dir} · click to find it in the sidebar, double-click to show it in Explorer, right-click for more`,
          onclick: () => { app.setSetting("sidebar", true); sidebar.reveal(dir); },
          ondblclick: () => app.reveal(dir),
          oncontextmenu: (e) => { e.preventDefault(); folderMenu(dir, e.clientX, e.clientY); } }),
        h("span", { class: "crumb-sep", text: "/" }),
      ];
    }));
    // a note with an id: the faintest mark, its id in the tip
    const n = app.vault.get(p);
    if (n && n.id) crumbsEl.append(h("span", { class: "crumb-id", title: `This note has an id (${n.id}) - renamed or moved outside Leonote, it is found again and its links follow. Settings › Editor › Note ids` }, "id"));
  }
  app.vault.bus.on("changed", (e) => { if (e.stamp && e.path === editor.path) paintTitle(); });
  /** Claude Code's sessions as notes (Rust claude_import): into their own folder, left out of indexing unless
   *  asked otherwise - thousands of long chats would slow every start - and still found by "search the
   *  not-indexed folders too". On a click only. */
  let importing = false;
  app.importClaude = async () => {
    if (importing) return;
    const dir = String(app.settings.claudeImportDir || "Claude sessions").trim().replace(/^\/+|\/+$/g, "") || "Claude sessions";
    if (app.settings.claudeImportKeepOut !== false) {
      const list = Array.isArray(app.settings.noIndex) ? app.settings.noIndex : [];
      if (!list.some((x) => x.toLowerCase() === dir.toLowerCase())) { const next = [...list, dir]; app.setSetting("noIndex", next); await host.noIndexSet(next).catch(() => {}); }
    }
    importing = true;
    toast("Reading Claude Code's sessions - the first time takes a little while", { ms: 4000 });
    try {
      const r = await host.claudeImport(dir);
      const parts = [r.added ? `${r.added} new` : "", r.updated ? `${r.updated} updated` : "", r.kept ? `${r.kept} you edited, kept as they were` : ""].filter(Boolean);
      toast(parts.length ? `Claude Code sessions in “${dir}”: ${parts.join(", ")}` : "Claude Code sessions: nothing new", { ms: 6000, action: { label: "Show", run: () => { app.setSetting("sidebar", true); sidebar.reveal(dir, true); } } });
    } catch (e) { toast("Could not import Claude Code's sessions: " + e, { kind: "error" }); }
    importing = false;
  };
  /** Is there a newer Leonote? (Rust update_check: one small file on leonote.app.) Told; an installed copy can then
   *  install it on a click (update.rs), the others get its page in the browser - nothing is downloaded by itself.
   *  `quiet`: the weekly ask, which says something only when there is news. */
  let updating = false;
  const installUpdate = async () => {
    if (updating) return;
    updating = true;
    toast("Downloading the update…", { ms: 60000 });
    try {
      const v = await host.updateFetch();
      toast(`Installing Leonote ${v} - it starts again in a moment`, { ms: 20000 });
      await shutdown(() => host.updateApply()); // everything saved as on a quit, then the new version takes over
    } catch (e) { updating = false; closing = false; toast(String(e), { kind: "error", ms: 8000 }); }
  };
  app.checkUpdate = async ({ quiet = false } = {}) => {
    if (app.packaged) { if (!quiet) toast("This copy comes from the Microsoft Store, which keeps it up to date", { ms: 3500 }); return; }
    try {
      const r = await host.updateCheck();
      app.setSetting("updateCheckedAt", Date.now());
      if (r && r.newer) toast(`Leonote ${r.latest} is out${r.security ? " - with security fixes" : ""} (you have ${r.current})`, { ms: 20000, action: r.installable ? { label: "Install", run: installUpdate } : { label: "Download page", run: () => app.openUrl(r.url) } });
      else if (!quiet) toast(`Leonote ${(r && r.current) || ""} is the latest`, { ms: 3000 });
    } catch (e) { if (!quiet) toast(String(e), { kind: "error" }); }
  };
  /** "Read as script": the note in the script window - large type, scrolling by itself, kept out of recordings. */
  let scriptNote = null;
  app.readAsScript = (path) => {
    const n = app.vault.get(path);
    if (!n || !host.real) return;
    scriptNote = path;
    host.scriptOpen(path, n.title || basename(path), n.content || "").catch((err) => toast(String(err), { kind: "error" }));
  };
  // an edit to the note being read: the window gets the new text (a moment after typing stops)
  const scriptSoon = debounce(() => {
    const n = scriptNote && app.vault.get(scriptNote);
    if (n) host.scriptPath().then((p) => { if (p === scriptNote) host.scriptOpen(scriptNote, n.title || basename(scriptNote), n.content || "", true); else if (!p) scriptNote = null; }).catch(() => {});
  }, 400);
  app.vault.bus.on("changed", (e) => { if (scriptNote && e.path === scriptNote) scriptSoon(); });
  // text edited in the script window: saved to that note (only the one it was opened with), as any edit
  host.on("script:edit", (p) => {
    if (!p || !scriptNote || p.path !== scriptNote || typeof p.text !== "string" || !app.vault.get(p.path)) return;
    // typed over a text the note has moved on from (sync, an agent; the window hears 400 ms later): not written over it.
    // The window gets the note as it is and turns Edit off. Said here too: closing the window sends the last words, and a hidden window tells nobody.
    const was = app.vault.get(p.path).content || "";
    if (typeof p.base === "string" && was !== p.base) { toast("This note changed elsewhere. The last words you typed in the script window were not saved.", { kind: "error" }); host.scriptOpen(p.path, app.vault.get(p.path).title || basename(p.path), was, true).catch(() => {}); return; }
    // never emptied from there: a note with words in it is not wiped by the script window (that once happened
    // on closing it) - clearing a note is done in the note itself
    if (!p.text.trim() && was.trim()) return;
    app.vault.write(p.path, p.text, {}).catch((err) => toast("Could not save the script: " + err, { kind: "error" }));
  });

  /** What can be done with a folder from wherever its name shows: new things in it (opened at once), finding it, searching it. */
  function folderMenu(dir, x, y) {
    menu(x, y, [
      { header: dir || "Vault root" },
      { label: "New note here", icon: "filePlus", run: () => app.newNote({ dir }) },
      { label: "New sketch here", icon: "brush", run: () => app.newSketch({ dir }) },
      { label: "New research board here", icon: "grid", run: () => app.newBoard({ dir }) },
      "sep",
      { label: "Find it in the sidebar", icon: "sidebar", run: () => { app.setSetting("sidebar", true); sidebar.reveal(dir); } },
      { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(dir) },
      { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(dir); toast("Path copied", { ms: 1600 }); } },
      { label: "Search in this folder…", icon: "search", run: () => app.openSearch({ folder: dir }) },
    ]);
  }

  titleEl.addEventListener("input", () => { titleEl.value = titleEl.value.replace(/\n/g, ""); growTitle(); if (editor.path) sidebar.markRenaming(editor.path, titleEl.value); });
  // the title being renamed lights its row in the tree up, and the tree's rename lights the title (renameMirror)
  titleEl.addEventListener("focus", () => { if (editor.path) sidebar.markRenaming(editor.path, titleEl.value); });
  /** From the tree's rename: the open note's title shows the same name, lit; false ends it, null puts the name back. */
  app.renameMirror = (path, v) => {
    if (editor.path !== path) return;
    titleEl.classList.toggle("is-mirror", typeof v === "string");
    if (typeof v === "string") titleEl.value = v;
    else if (v === null) titleEl.value = basename(path);
    growTitle();
  };
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); editor.focus(); }
    if (e.key === "Escape") { e.preventDefault(); titleEl.value = basename(editor.path || ""); editor.focus(); }
  });
  titleEl.addEventListener("blur", () => {
    const p = editor.path;
    const v = titleEl.value.trim();
    if (!p) return;
    sidebar.markRenaming(p, null);
    if (!v || v === basename(p)) { titleEl.value = basename(p); return; }
    app.renameNote(p, v);
  });

  /* ── note operations ──────────────────────────────────────────────────── */
  app.currentPath = () => { const t = cur(); return t.kind === "note" ? t.path : null; };
  /** The vault path of whatever the open tab shows - a note, a picture, a video, a board. */
  app.currentTabPath = () => { const t = cur(); return t && t.kind !== "view" && t.kind !== "web" ? t.path || null : null; };
  app.lastNotePath = () => lastNote;

  /* ── picture layout: in the text column, wide, or a full-width collage ── */
  // A note can choose for itself with Obsidian's `cssclasses` (wide-images /
  // collage); otherwise the setting applies. Text always stays in its column.
  let noteLayout = null;
  function layoutOf(text) {
    if (!text || !text.startsWith("---")) return null;
    const end = text.indexOf("\n---", 3);
    const fm = end > 0 ? text.slice(0, end) : "";
    if (/\bcollage\b/.test(fm) && /cssclass/.test(fm)) return "collage";
    if (/\bwide-images\b/.test(fm) && /cssclass/.test(fm)) return "wide";
    return null;
  }
  function paintLayout() {
    const mode = noteLayout || app.settings.imageLayout || "column";
    $("#view-note").dataset.pictures = mode;
  }
  paintLayout();
  document.body.classList.toggle("float-contain", !!app.settings.floatContain);
  document.body.classList.toggle("no-code-numbers", app.settings.codeLineNumbers === false);
  app.vault.bus.on("changed", (e) => {
    if (e.path !== app.currentPath()) return;
    const next = layoutOf(app.vault.get(e.path)?.content);
    if (next !== noteLayout) { noteLayout = next; paintLayout(); }
  });

  /* ── research boards (.canvas, Obsidian's JSON Canvas) ─────────────────── */
  const CARD_W = 400;
  const CARD_H = 300;
  const hexId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  app.boards = () => [...app.vault.files.keys()].filter((p) => /\.canvas$/i.test(p)).sort();
  app.imageUrl = (target, from) => {
    if (/^(https?:|data:)/i.test(target)) return target;
    const f = app.vault.resolveFile(target, from || editor.path);
    return f && f.kind === "image" ? assetOf(f.path) : null;
  };

  // note cards in a grid, or where the caller placed them
  function boardNodes(notes, origin = { x: 0, y: 0 }) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(notes.length)));
    return notes.map((n, i) => {
      const path = typeof n === "string" ? n : n.path;
      const placed = typeof n === "object" && Number.isFinite(n.x) && Number.isFinite(n.y);
      return {
        id: hexId(),
        type: "file",
        file: path,
        x: Math.round(placed ? n.x - CARD_W / 2 : origin.x + (i % cols) * (CARD_W + 40)),
        y: Math.round(placed ? n.y - CARD_H / 2 : origin.y + Math.floor(i / cols) * (CARD_H + 40)),
        width: CARD_W,
        height: CARD_H,
      };
    });
  }

  app.writeBoard = (path, data) => writeBoard(path, data);
  // projects (projectroom.js): a folder with a brief note
  app.projectAt = (folder) => findProjects(app.vault.notes.values()).find((p) => p.folder === folder) || null;
  app.makeProject = (folder) => makeProject(app, folder);
  app.pickWorkspaceFolder = () => pickWorkspaceFolder(app);
  async function writeBoard(path, data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, "\t"));
    const entry = await host.writeFile(path, bytes);
    if (entry && entry.path) app.vault.setFiles([...[...app.vault.files.values()].filter((f) => f.path !== entry.path), entry]);
    return entry;
  }

  /* ── Leopaint drawings (.leopaint: vectors, the open Excalidraw layout inside) ── */
  const EMPTY_SKETCH = () => ({
    type: "excalidraw",
    version: 2,
    source: "Leonote",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  });
  // a new drawing next to the note's pictures; from a note it is embedded at
  // the caret, then opened to draw in
  async function newSketch({ view, at, dir, name, ed = editor, anchor, tail } = {}) {
    const note = view ? ed.path : null;
    // not from inside a note and no folder given: ask where it goes
    if (!view && dir == null) {
      const pics = attachmentDir(app.mediaDir("imageFolder"), app.lastNotePath ? app.lastNotePath() || "" : "");
      dir = await pickFolder(app, anchor, { title: "New Leopaint drawing in", first: [app.workDir("sketch"), "the usual place"], stars: "vector", extra: [[pics, "pictures folder"]], tail });
      if (dir == null) return null;
    }
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const base = safeName(name || (note ? `${basename(note)} sketch ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}` : `Sketch ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`));
    const folder = dir != null ? dir : attachmentDir(app.mediaDir("imageFolder"), note || "");
    let path = (folder ? folder + "/" : "") + base + ".leopaint";
    for (let i = 2; app.vault.files.has(path); i++) path = (folder ? folder + "/" : "") + `${base} ${i}.leopaint`;
    try {
      const entry = await host.writeFile(path, new TextEncoder().encode(JSON.stringify(EMPTY_SKETCH(), null, 2)));
      if (entry && entry.path) app.vault.setFiles([...[...app.vault.files.values()].filter((f) => f.path !== entry.path), entry]);
      if (view && ed.path === note) {
        const pos = Math.min(at ?? view.state.selection.main.head, view.state.doc.length);
        const text = `![[${path.slice(path.lastIndexOf("/") + 1)}]]`;
        view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: "input" });
      }
      app.openFile(path, { newTab: true });
      return path;
    } catch (e) {
      toast("Could not create the drawing: " + e, { kind: "error" });
      return null;
    }
  }
  app.newSketch = (opts) => newSketch(opts);
  /** The folders a new sketch is offered, for menus that list them themselves. */
  app.sketchFolders = () => folderChoices(app, { first: [app.workDir("sketch"), "the usual place"], extra: [[attachmentDir(app.mediaDir("imageFolder"), app.lastNotePath ? app.lastNotePath() || "" : ""), "pictures folder"]] });

  app.newBoard = async ({ name, notes = [], dir } = {}) => {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const base = safeName(name || `Research ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`);
    const folder = dir != null ? dir : app.settings.boardsFolder || app.workDir("board");
    let path = (folder ? folder + "/" : "") + base + ".canvas";
    for (let i = 2; app.vault.files.has(path) || app.vault.notes.has(path); i++) path = (folder ? folder + "/" : "") + `${base} ${i}.canvas`;
    // graph positions arrive centred on the old layout; keep their shape
    const nodes = boardNodes(notes);
    try {
      await writeBoard(path, { nodes, edges: [] });
      app.openFile(path, { newTab: true });
      toast(notes.length ? `Board created with ${notes.length} note${notes.length === 1 ? "" : "s"}` : "New research board", { ms: 2200 });
      return path;
    } catch (e) {
      toast("Could not create the board: " + e, { kind: "error" });
      return null;
    }
  };

  app.addToBoard = async (path, notes = []) => {
    const paths = notes.map((n) => (typeof n === "string" ? n : n.path));
    // an open board takes them live, with undo and its own placement
    if (fileView && fileView.path === path && fileView.board) {
      fileView.board.addNotes(paths);
      app.openFile(path);
      return path;
    }
    try {
      let data = { nodes: [], edges: [] };
      const text = await host.readText(path).catch(() => "");
      if (text.trim()) data = JSON.parse(text);
      data.nodes = Array.isArray(data.nodes) ? data.nodes : [];
      data.edges = Array.isArray(data.edges) ? data.edges : [];
      const have = new Set(data.nodes.filter((n) => n.type === "file").map((n) => n.file));
      const fresh = paths.filter((p) => !have.has(p));
      const right = data.nodes.reduce((m, n) => Math.max(m, (n.x || 0) + (n.width || 0)), 0);
      const top = data.nodes.reduce((m, n) => Math.min(m, n.y || 0), Infinity);
      data.nodes.push(...boardNodes(fresh, { x: data.nodes.length ? right + 120 : 0, y: Number.isFinite(top) ? top : 0 }));
      await writeBoard(path, data);
      app.openFile(path, { newTab: true });
      toast(fresh.length ? `Added ${fresh.length} to ${basename(path)}` : "Those notes are already on the board", { ms: 2200 });
      return path;
    } catch (e) {
      toast("Could not add to the board: " + e, { kind: "error" });
      return null;
    }
  };
  app.activeTab = () => cur();
  // every open tab, in every space and the split, for the switcher
  app.tabList = () => {
    storeSpace();
    const out = [];
    for (const s of spaces) {
      const list = s === space ? tabs : (s.tabs || []);
      list.forEach((t, k) => {
        if (!exists(t)) return;
        const inf = tabInfo(t);
        // the tab you are in is listed too (it is easy to forget you are already there), marked as here
        out.push({ here: s === space && k === active, title: inf.title, icon: inf.icon, path: t.path || "", where: s === space ? "" : `${emojiOf(s)}${s.name}`, pinned: !!t.pinned, loc: loc(t), spaceId: s.id,
          go: () => { if (s !== space) spacesApi.switchTo(s.id); const i = tabs.findIndex((x) => same(x, t)); if (i >= 0) { flushCur(); active = i; show(); } } });
      });
      if (s === space && split.isOpen) for (const t of split.state().tabs) {
        if (split.current && same(split.current, t)) continue;
        const inf = tabInfo(t);
        out.push({ title: inf.title, icon: inf.icon, path: t.path, where: "Split view", go: () => split.open(t) });
      }
    }
    return out;
  };
  app.flushAll = () => flushAll();
  /** The spaces and their groups, for a menu that places a tab. */
  app.spacePlaces = () => {
    storeSpace();
    return spaces.map((s) => ({ id: s.id, label: `${emojiOf(s)}${s.name}`, current: s === space,
      groups: (s === space ? groups : TG.cleanGroups(s.groups)).map((g) => ({ id: g.id, label: groupLabel(g), swatch: TG.colorVar(g.color) })) }));
  };
  /**
   * A tab (a note, a file, a page, a view) put into a space: at its start (after the tabs pinned
   * there), at its end, or at the end of one of its groups. `from`: the space it is open in now -
   * it moves from there instead of being copied. `go`: switch to that space and show it.
   * One already open there is moved to the new place rather than doubled.
   */
  app.placeInSpace = (l, sid, { at = "end", group = null, from = null, go = false } = {}) => {
    const s = spaces.find((x) => x.id === sid);
    if (!s || !l) return;
    flushCur();
    storeSpace();
    const L = loc(l);
    const put = (list, entry) => {
      const k0 = list.findIndex((x) => same(x, L));
      if (k0 >= 0) list.splice(k0, 1);
      if (group) {
        entry.group = group;
        let last = -1;
        list.forEach((x, k) => { if (x.group === group) last = k; });
        if (last >= 0) { list.splice(last + 1, 0, entry); return; }
      } else delete entry.group;
      let k = 0;
      if (at === "start") { while (k < list.length && list[k].pinned && list[k].full) k++; list.splice(k, 0, entry); } else list.push(entry);
    };
    // out of the space it moves from
    if (from && from !== sid) {
      const fs = spaces.find((x) => x.id === from);
      if (fs === space) { const i = tabs.findIndex((x) => same(x, L)); if (i >= 0) closeTab(i); storeSpace(); }
      else if (fs) fs.tabs = (fs.tabs || []).filter((x) => !same(x, L));
    }
    if (s === space) {
      const was = active >= 0 ? tabs[active] : null;
      const old = tabs.find((x) => same(x, L));
      const t = old || mkTab(L.kind === "view" ? { kind: "view", view: L.view } : L);
      put(tabs, t);
      active = go || !was || !tabs.includes(was) ? tabs.indexOf(t) : tabs.indexOf(was);
      show();
      saveSession();
    } else {
      const list = [...(s.tabs || [])];
      put(list, { ...L });
      s.tabs = list;
      saveSession();
      if (go) { spacesApi.switchTo(s.id); const i = tabs.findIndex((x) => same(x, L)); if (i >= 0) { active = i; show(); } }
    }
    const g = group && (s === space ? groups : TG.cleanGroups(s.groups)).find((x) => x.id === group);
    toast(`${from && from !== sid ? "Moved" : "Put"} in ${emojiOf(s)}${s.name}${g ? ` · ${groupLabel(g)}` : at === "start" ? " · at the start" : ""}`, { ms: 2200 });
  };
  app.recentPaths = () => app.settings.recent || [];
  // a vault path, a guest file, or a path on disk (outposts, files from outside) - each the way it can be found
  app.reveal = (p) => (app.isGuest && app.isGuest(p) ? host.externalReveal(app.guestAbs(p)) : /^([a-z]:|[\\/]{2})/i.test(String(p)) ? host.externalReveal(p) : host.reveal(p)).catch((e) => toast(String(e), { kind: "error" }));
  app.palette = (mode, opts) => openPalette(app, mode, opts);

  app.openNote = (path, opts = {}) => {
    if (!app.vault.notes.has(path)) return;
    navigate({ kind: "note", path }, opts);
    if (opts.offset != null) editor.select(opts.offset);
    else if (opts.line != null) editor.selectLine(opts.line);
    if (opts.find) return editor.find(opts.find);
    if (opts.focusTitle) { titleEl.focus(); titleEl.select(); }
    else if (opts.focus !== false) editor.focus();
  };

  /* Things made in a hurry - a note from the start page, a sketch, a board, a
     drawing - have ONE home, so they never litter the vault and are tidied in
     one go: <Workplace>/Notes, /Leopaint, /Boards, /Studio/Designs and /Studio/Animations
     (one kind of file, sorted by what it is for). The folder's name is a setting;
     a kind can be given a place of its own (quick…Dir). */
  const WORK_KINDS = { note: ["Notes", "quickNoteDir"], sketch: ["Leopaint", "quickSketchDir"], board: ["Boards", "quickBoardDir"], drawing: ["Studio/Designs", "quickDrawingDir"], animation: ["Studio/Animations", "quickAnimationDir"], video: ["Videos", "quickVideoDir"] };
  app.workDir = (kind) => {
    const [sub2, key] = WORK_KINDS[kind] || ["Files", ""];
    const own = key && typeof app.settings[key] === "string" ? app.settings[key].trim().replace(/^\/+|\/+$/g, "") : "";
    if (own) return own;
    const root = String(app.settings.workFolder ?? "Workplace").trim().replace(/^\/+|\/+$/g, "");
    return root ? root + "/" + sub2 : sub2;
  };

  /**
   * Gather the media of one folder into the media folders of Settings.
   * Pictures named the way a paste names them go to the compressed folder,
   * other pictures to the pictures folder, videos and songs to theirs. A file
   * keeps its name, so [[name]] links go on working untouched; only a link
   * that spells out the old path - or a name that had to change because it
   * was taken - is rewritten.
   */
  app.gatherMedia = () => app.palette("move", { onPick: async (src) => {
    const S = app.settings;
    const AUDIO = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|wma)$/i;
    const dest = (f) => (f.kind === "image" ? (/-\d{12,}\.(webp|jpe?g|png)$/i.test(f.path) ? app.mediaDir("compressedImageFolder") : app.mediaDir("imageFolder"))
      : f.kind === "media" ? app.mediaDir(AUDIO.test(f.path) ? "audioFolder" : "videoFolder") : "");
    const clean = (d) => String(d || "").replace(/^\.?\/+|\/+$/g, "");
    const jobs = [...app.vault.files.values()]
      .filter((f) => (f.kind === "image" || f.kind === "media") && (!src || f.path.startsWith(src + "/")))
      .map((f) => ({ f, to: clean(dest(f)) }))
      .filter((j) => j.to && !j.to.startsWith(".") && dirname(j.f.path) !== j.to);
    if (!jobs.length) return toast(`Nothing to move from ${src || "the vault"} - its pictures, videos and songs are where the settings say already`, { ms: 5000 });
    const n = (k, test) => jobs.filter((j) => j.f.kind === k && test(j.f.path)).length;
    const parts = [[n("image", () => true), "picture"], [n("media", (p) => !AUDIO.test(p)), "video"], [n("media", (p) => AUDIO.test(p)), "song"]].filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`).join(", ");
    if (!(await confirmDialog(`Move ${parts} out of ${src || "the vault"}?`, "They go to the media folders set in Settings. Every file keeps its name, so links in your notes go on working; a link that spells out the old path is rewritten. Nothing is deleted.", { ok: "Move them", danger: false }))) return;
    const close = toast(`Moving ${jobs.length} files…`, { ms: 600000 });
    let moved = 0;
    let relinked = 0;
    for (const { f, to } of jobs) {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      const dot = name.lastIndexOf(".");
      let target = to + "/" + name;
      for (let i = 2; app.vault.files.has(target) || app.vault.notes.has(target); i++) target = `${to}/${dot > 0 ? name.slice(0, dot) : name} ${i}${dot > 0 ? name.slice(dot) : ""}`;
      try {
        await app.vault.renameFile(f.path, target);
        moved++;
        const renamed = target.slice(target.lastIndexOf("/") + 1) !== name;
        const low = f.path.toLowerCase();
        const spelled = [...app.vault.notes.values()].some((x) => x.content.toLowerCase().includes(low));
        if (renamed || spelled) relinked += await app.vault.relinkFile(f.path, target);
      } catch (e) { toast(`Could not move ${name}: ${e}`, { kind: "error" }); }
    }
    close();
    show();
    toast(`Moved ${moved} file${moved === 1 ? "" : "s"}${relinked ? ` · links updated in ${relinked} note${relinked === 1 ? "" : "s"}` : " · no link needed changing"}`, { ms: 7000 });
  } });

  /** Where a picture or file is used: a menu of the notes that show or link it, each opening at that line. */
  /** Files no note refers to, and embeds in notes that point at nothing: pick what goes. */
  app.tidyFiles = async () => {
    const EMBED = /!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!?\[[^\]]*\]\(([^)\s]+)\)/g;
    const used = new Set();
    const broken = []; // { note, line, text, from, to }
    for (const n of app.vault.notes.values()) {
      const c = n.content || "";
      for (let m; (m = EMBED.exec(c)); ) {
        let t = (m[1] || m[2] || "").trim();
        try { t = decodeURIComponent(t); } catch {}
        if (!t || /^(https?:|mailto:|data:)/i.test(t)) continue;
        const f = app.vault.resolveFile(t, n.path);
        if (f) { used.add(f.path); continue; }
        if (app.vault.resolve && app.vault.resolve(t, n.path)) continue;
        if (!m[0].startsWith("!")) continue; // a plain wiki link to a note not written yet is how notes grow
        broken.push({ note: n.path, line: c.slice(0, m.index).split("\n").length, text: m[0], from: m.index, to: m.index + m[0].length });
      }
    }
    // drawings and boards stand on their own; media and documents are what gathers unused
    const unused = [...app.vault.files.values()].filter((f) => !used.has(f.path) && !/\.(leovideo|leostudio|leocanvas|leovector|excalidraw|leopaint|leoboard|board|canvas|json)$/i.test(f.path) && !f.path.split("/").some((x) => x.startsWith("."))).sort((a, b) => a.path.localeCompare(b.path));
    const pickedFiles = new Set();
    const pickedRefs = new Set();
    let q = "";
    let kind = "all"; // all | image | media | doc
    const kindOf = (f) => (f.kind === "image" ? "image" : f.kind === "video" || f.kind === "audio" ? "media" : "doc");
    const filesBtn = h("button", { class: "btn btn-danger" });
    const refsBtn = h("button", { class: "btn btn-danger" });
    const paintBtns = () => { filesBtn.textContent = `Move ${pickedFiles.size} to the trash…`; filesBtn.disabled = !pickedFiles.size; refsBtn.textContent = `Remove ${pickedRefs.size} embed${pickedRefs.size === 1 ? "" : "s"}…`; refsBtn.disabled = !pickedRefs.size; };
    const filesList = h("div", { class: "tidy-list" });
    const refsList = h("div", { class: "tidy-list" });
    const peekOf = (p) => { const f = app.vault.files.get(p); return f && f.kind === "image" ? h("img", { class: "tidy-peek", src: host.assetUrl(p), alt: "" }) : null; };
    const fileRow = (f) => {
      const box = h("input", { type: "checkbox", checked: pickedFiles.has(f.path), onchange: () => { box.checked ? pickedFiles.add(f.path) : pickedFiles.delete(f.path); paintBtns(); paintHeads(); } });
      const row = h("label", { class: "tidy-row is-inner" }, box, icon(f.kind === "image" ? "image" : f.kind === "video" ? "film" : f.kind === "audio" ? "music" : "fileText"), h("span", { class: "tidy-name", text: basename(f.path) }), h("span", { class: "tidy-sub", text: f.size ? fmtSize(f.size) : "" }),
        h("button", { class: "icon-btn tidy-open", title: "Open it", onclick: (e) => { e.preventDefault(); app.openFile(f.path, { newTab: true }); } }, icon("expand")));
      row.addEventListener("mouseenter", () => { if (row._peeked) return; row._peeked = true; const img = peekOf(f.path); if (img) row.append(img); });
      return row;
    };
    const headBoxes = new Map();
    const paintHeads = () => { for (const [dir, { box, list }] of headBoxes) { const n = list.filter((f) => pickedFiles.has(f.path)).length; box.checked = n === list.length && n > 0; box.indeterminate = n > 0 && n < list.length; } };
    const paintFiles = () => {
      headBoxes.clear();
      const shown = unused.filter((f) => (kind === "all" || kindOf(f) === kind) && (!q || f.path.toLowerCase().includes(q)));
      if (!shown.length) { filesList.replaceChildren(h("div", { class: "trash-none", text: unused.length ? "Nothing matches" : "Every file is used somewhere" })); return; }
      // by folder, each with a box that picks the whole folder
      const byDir = new Map();
      for (const f of shown) { const d = dirname(f.path) || ""; if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(f); }
      const out = [];
      for (const [dir, list] of byDir) {
        const box = h("input", { type: "checkbox", onchange: () => { for (const f of list) box.checked ? pickedFiles.add(f.path) : pickedFiles.delete(f.path); paintFiles(); paintBtns(); } });
        headBoxes.set(dir, { box, list });
        out.push(h("label", { class: "tidy-row tidy-head" }, box, icon(dir ? "folder" : "home"), h("span", { class: "tidy-name", text: dir || "Vault root" }), h("span", { class: "tidy-sub", text: `${list.length} · ${fmtSize(list.reduce((n, f) => n + (f.size || 0), 0))}` })));
        for (const f of list) out.push(fileRow(f));
      }
      filesList.replaceChildren(...out);
      paintHeads();
    };
    const paintRefs = () => {
      const shown = broken.map((b, i) => [b, i]).filter(([b]) => !q || b.note.toLowerCase().includes(q) || b.text.toLowerCase().includes(q));
      if (!shown.length) { refsList.replaceChildren(h("div", { class: "trash-none", text: broken.length ? "Nothing matches" : "No embed points at nothing" })); return; }
      refsList.replaceChildren(...shown.map(([b, i]) => {
        const box = h("input", { type: "checkbox", checked: pickedRefs.has(i), onchange: () => { box.checked ? pickedRefs.add(i) : pickedRefs.delete(i); paintBtns(); } });
        return h("label", { class: "tidy-row" }, box, icon("fileText"), h("span", { class: "tidy-name", text: b.text }), h("span", { class: "tidy-sub", text: `${b.note} · line ${b.line}` }),
          h("button", { class: "icon-btn tidy-open", title: "Open the note there", onclick: (e) => { e.preventDefault(); app.openNote(b.note, { line: b.line - 1, newTab: true }); } }, icon("expand")));
      }));
    };
    const find = h("input", { class: "wt-lib-find", placeholder: "Filter by name or folder", spellcheck: "false" });
    find.addEventListener("input", () => { q = find.value.trim().toLowerCase(); paintFiles(); paintRefs(); });
    find.addEventListener("keydown", (e) => e.stopPropagation());
    const kinds = h("div", { class: "segmented is-small" }, [["all", "All"], ["image", "Pictures"], ["media", "Video & audio"], ["doc", "Documents"]].map(([v, label]) => h("button", { class: "seg" + (v === kind ? " is-active" : ""), onclick: (e) => { kind = v; for (const b of e.currentTarget.parentElement.children) b.classList.toggle("is-active", b === e.currentTarget); paintFiles(); } }, label)));
    const allBtn = h("button", { class: "btn btn-sm", onclick: () => { const shown = unused.filter((f) => (kind === "all" || kindOf(f) === kind) && (!q || f.path.toLowerCase().includes(q))); const all = shown.every((f) => pickedFiles.has(f.path)); for (const f of shown) all ? pickedFiles.delete(f.path) : pickedFiles.add(f.path); paintFiles(); paintBtns(); } }, "Pick all shown / none");
    paintBtns();
    paintFiles();
    paintRefs();
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".menu") && document.querySelectorAll(".dlg-back").length === 1) { e.preventDefault(); e.stopPropagation(); close(); } };
    filesBtn.onclick = async () => {
      const list = [...pickedFiles].map((p) => [p, "file"]);
      if (!(await app.trashAsk(list))) return; // the usual question, with the names and a preview
      close();
    };
    refsBtn.onclick = async () => {
      const n0 = pickedRefs.size;
      if (!(await confirmDialog(`Remove ${n0} embed${n0 === 1 ? "" : "s"} from ${new Set([...pickedRefs].map((i) => broken[i].note)).size} note${new Set([...pickedRefs].map((i) => broken[i].note)).size === 1 ? "" : "s"}?`, "The embeds point at files that no longer exist. Only the embed text goes; the notes' other lines stay. Ctrl+Z in a note brings its text back while it is open.", { ok: "Remove them" }))) return;
      const byNote = new Map();
      for (const i of pickedRefs) { const b = broken[i]; if (!byNote.has(b.note)) byNote.set(b.note, []); byNote.get(b.note).push(b); }
      let n = 0;
      for (const [note, list] of byNote) {
        const cur = app.vault.get(note);
        if (!cur) continue;
        let c = cur.content || "";
        for (const b of list.sort((a, z) => z.from - a.from)) { if (c.slice(b.from, b.to) === b.text) { c = c.slice(0, b.from) + c.slice(b.to); n++; } }
        await app.vault.write(note, c.replace(/\n{3,}/g, "\n\n"));
      }
      close();
      toast(`${n} embed${n === 1 ? "" : "s"} removed`, { ms: 3000 });
    };
    const box = h("div", { class: "dlg dlg-trashbin tidy", role: "dialog", "aria-modal": "true" },
      h("div", { class: "dlg-head" }, h("h3", { class: "dlg-title", text: "Tidy up" }), h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
      h("p", { class: "dlg-text", text: "Nothing is picked until you pick it. What goes to the trash can be brought back from there. Drawings and boards are left alone: they need no note to matter." }),
      h("div", { class: "trash-bar" }, find, kinds, h("span", { class: "trash-gap" }), allBtn),
      h("div", { class: "tidy-sec" }, h("div", { class: "trash-bar" }, h("b", { text: `${unused.length} file${unused.length === 1 ? "" : "s"} no note uses` }), h("span", { class: "trash-gap" }), filesBtn), filesList),
      h("div", { class: "tidy-sec" }, h("div", { class: "trash-bar" }, h("b", { text: `${broken.length} embed${broken.length === 1 ? "" : "s"} pointing at nothing` }), h("span", { class: "trash-gap" }), refsBtn), refsList));
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
  };

  app.showUsedIn = (path, x, y) => {
    const list = app.vault.usedIn(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    menu(x, y, [
      { header: list.length ? `${name} is used in ${list.length} note${list.length === 1 ? "" : "s"}` : `No note uses ${name}` },
      ...list.slice(0, 40).map((u) => ({ label: basename(u.path), icon: "fileText", keys: dirname(u.path) ? dirname(u.path).split("/").pop() : "", run: () => { const v = document.querySelector(".img-viewer"); if (v) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); app.openNote(u.path, { line: u.line }); } })),
      list.length > 40 ? { header: `and ${list.length - 40} more`, plain: true } : null,
      "sep",
      { label: "Move it to another folder…", icon: "folder", keys: "links follow", run: () => app.migrateFile(path) },
      list.length ? { label: "Search for it in all notes", icon: "search", run: () => app.openSearch({ query: name }) } : null,
    ].filter(Boolean));
  };

  /** Move one file to a folder you pick. Links by name go on working as they are; one that spells out the old path is rewritten. */
  app.migrateFile = (path) => app.palette("move", { onPick: async (to) => {
    to = String(to || "").replace(/^\.?\/+|\/+$/g, "");
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (dirname(path) === to) return toast(`${name} is in ${to || "the vault"} already`, { ms: 2600 });
    const dot = name.lastIndexOf(".");
    let target = (to ? to + "/" : "") + name;
    for (let i = 2; app.vault.files.has(target) || app.vault.notes.has(target); i++) target = `${to ? to + "/" : ""}${dot > 0 ? name.slice(0, dot) : name} ${i}${dot > 0 ? name.slice(dot) : ""}`;
    try {
      await app.vault.renameFile(path, target);
      const renamed = target.slice(target.lastIndexOf("/") + 1) !== name;
      const low = path.toLowerCase();
      const spelled = [...app.vault.notes.values()].some((x) => (x.content || "").toLowerCase().includes(low));
      const n = renamed || spelled ? await app.vault.relinkFile(path, target) : 0;
      show();
      toast(`Moved to ${to || "the vault"}${n ? ` · links updated in ${n} note${n === 1 ? "" : "s"}` : " · every link still points at it"}`, { ms: 5000 });
    } catch (e) { toast(`Could not move ${name}: ${e}`, { kind: "error" }); }
  } });

  /** A browser tab: "" is the start page. */
  let webSeq = 0;
  // a blank tab goes where "A new tab opens" says; a link opened in a new tab where "A link opens" says (next to the page it came from, as browsers do)
  /** A vault file's own address (file:///...) and back. */
  app.fileUrl = (path) => {
    if (app.isGuest && app.isGuest(path)) return "file:///" + encodeURI(app.guestAbs(path).replace(/\\/g, "/")).replace(/#/g, "%23"); const root = String(app.vault.root || "").replace(/[\\/]+$/, "").replace(/\\/g, "/"); return "file:///" + encodeURI(root.replace(/^\/+/, "") + "/" + path).replace(/#/g, "%23"); };
  app.vaultPathOfUrl = (url) => {
    if (!/^file:/i.test(url || "")) return null;
    // an outside page opened as a guest: back to it
    try { const d = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "").replace(/\//g, "\\").toLowerCase(); for (const [g, e] of guests) if (String(e.abs || "").replace(/\//g, "\\").toLowerCase() === d) return g; } catch {}
    let p; try { p = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, ""); } catch { return null; }
    const root = String(app.vault.root || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!root || p.toLowerCase().indexOf(root.toLowerCase() + "/") !== 0) return null;
    const rel = p.slice(root.length + 1);
    return app.vault.files.has(rel) || app.vault.notes.has(rel) ? rel : null;
  };
  /** This tab's file shown as the page it makes (an HTML file), in the same tab. */
  /** An HTML file shown as a page once opens as one again (Source, on the page, undoes it). */
  app.rememberAsPage = (path, on) => {
    const set = new Set(app.settings.htmlAsPage || []);
    if (on) set.add(path); else set.delete(path);
    app.setSetting("htmlAsPage", [...set].slice(-500));
  };
  app.viewAsPage = (path) => {
    app.rememberAsPage(path, true);
    const url = app.fileUrl(path);
    const i = tabs.findIndex((t) => t.kind === "file" && t.path === path);
    if (i < 0) return app.newWebTab(url);
    active = i;
    retarget(tabs[i], { kind: "web", path: url, wid: "w" + Date.now().toString(36) + (++webSeq).toString(36) }, true);
    show();
  };
  /**
   * The drawing formats were renamed: the layered pixel file is .leostudio,
   * and the vector one - .leovector, then .leocanvas - is .leopaint. Once,
   * before any tab opens them: the files are renamed on disk, the links to them
   * in notes follow, and so do open tabs and recent lists. Nothing is deleted.
   * (Before step 3 a .leopaint could also be a pixel file - a zip - which is .leostudio now.)
   */
  async function renameDrawings() {
    const S = app.settings;
    const v = Number(S.drawExtV) || 0;
    if (v >= 4) return;
    const all = [...app.vault.files.values()];
    // a .leopaint is a Studio drawing when it is a zip (before step 2 every one was), a Canvas drawing when it is JSON
    // (the Studio reader opening it is the test: a Canvas drawing's JSON is no zip)
    const isZip = async (p) => { if (v < 2) return true; try { await app.host.paintInspect(p); return true; } catch { return false; } };
    const plan = [];
    for (const f of all) {
      if (/\.leopaint$/i.test(f.path)) { if (v < 3 && (await isZip(f.path))) plan.push([f.path, ".leostudio"]); }
      else if (/\.(leovector|leocanvas)$/i.test(f.path)) plan.push([f.path, ".leopaint"]);
    }
    const moved = new Map();
    const free = (want) => { let q = want; for (let i = 2; app.vault.files.has(q); i++) q = want.replace(/(\.[a-z]+)$/i, ` ${i}$1`); return q; };
    for (const [from, ext] of plan) {
      const dest = free(from.replace(/\.[a-z]+$/i, ext));
      try { await app.vault.renameFile(from, dest); moved.set(from, dest); } catch (e) { console.warn("rename", from, e); }
    }
    app.setSetting("drawExtV", 4);
    if (!moved.size) return;
    // links in notes: by path or by name, wiki or Markdown
    const base = (p) => p.slice(p.lastIndexOf("/") + 1);
    const byKey = new Map();
    for (const [a, b] of moved) { byKey.set(a.toLowerCase(), b); byKey.set(base(a).toLowerCase(), base(b)); }
    const swap = (t) => { const k = t.trim().toLowerCase(); if (byKey.has(k)) return byKey.get(k); let d = t; try { d = decodeURIComponent(t); } catch {} const k2 = d.trim().toLowerCase(); return byKey.has(k2) ? encodeURI(byKey.get(k2)) : t; };
    let relinked = 0;
    for (const n of [...app.vault.notes.values()]) {
      if (!/\.(leopaint|leovector|leocanvas)/i.test(n.content)) continue;
      const out = n.content
        .replace(/(!?\[\[)([^\]|#\n]+\.(?:leopaint|leovector|leocanvas))(?=[\]|#])/gi, (m, open, t) => open + swap(t))
        .replace(/(\]\()([^)\s]+\.(?:leopaint|leovector|leocanvas))(?=\))/gi, (m, open, t) => open + swap(t));
      if (out !== n.content) { await app.vault.write(n.path, out, { expected: true }); relinked++; }
    }
    // every place a path is kept: tabs of every space, recent lists, pins
    const walk = (v) => (typeof v === "string" ? (moved.get(v) || v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
    for (const k of ["spaces", "recent", "pinned", "pinnedFiles", "session"]) if (S[k] != null) S[k] = walk(S[k]);
    saveSettings();
    const n1 = [...moved.values()].filter((p) => /\.leostudio$/i.test(p)).length, n2 = moved.size - n1;
    toast(`Drawings renamed: ${n1 ? `${n1} Studio drawing${n1 === 1 ? " is" : "s are"} .leostudio` : ""}${n1 && n2 ? ", " : ""}${n2 ? `${n2} Leopaint drawing${n2 === 1 ? " is" : "s are"} .leopaint` : ""}${relinked ? ` · links fixed in ${relinked} note${relinked === 1 ? "" : "s"}` : ""}`, { ms: 9000 });
  }

  app.newWebTab = (url = "", { background } = {}) => navigate({ kind: "web", path: url || "", wid: "w" + Date.now().toString(36) + (++webSeq).toString(36) }, { newTab: true, atEnd: (url ? app.settings.linkTabAt : app.settings.newTabAt) === "end", background: background ?? (!!url && app.settings.linkTabBackground !== false) });

  /** Settings, opened at one group, unfolded (the page mounts on first use, so this waits a frame). */
  app.openSettingsAt = (title) => {
    app.openView("settings");
    requestAnimationFrame(() => requestAnimationFrame(() => { const sec = document.querySelector(`.set-group[data-group="${title}"]`); if (sec) { if (sec.unfold) sec.unfold(); sec.scrollIntoView({ block: "start", behavior: "smooth" }); } }));
  };
  app.openView = (view, opts = {}) => navigate({ kind: "view", view }, opts);
  /** Settings, unfolded and scrolled to one of its groups. */
  app.openSettings = (group) => { app.openView("settings"); views.settings.show({ group }); };
  /** The Workout view on a tab or a day: { tab, day }. */
  app.showFit = (o) => { app.openView("fit"); views.fit.show(o || {}); };

  /** The Assistant, maybe with the editor's selection and a ready question. */
  /** A thread from the card, carried on in the Assistant tab. */
  app.continueAssistant = (msgs) => {
    app.openView("assistant");
    const go = () => { const v = views.assistant; if (v && v.adopt) v.adopt(msgs); else if (v && v.show) Promise.resolve(v.show()).then(() => views.assistant.adopt && views.assistant.adopt(msgs)); };
    go();
  };
  app.askAssistant = (opts = {}) => {
    const sel = opts.selection != null ? opts.selection : (cur().kind === "note" && editor ? editor.range().text : "");
    app.openView("assistant", opts.newTab ? { newTab: true } : {});
    const v = views.assistant;
    if (v && v.ask) v.ask({ selection: sel, prompt: opts.prompt || "" });
  };

  /** The Assistant in the main pane with the note kept in view beside it. */
  app.assistantBeside = () => {
    const sel = cur().kind === "note" && editor ? editor.range().text : "";
    const p = cur().kind === "note" ? cur().path : lastNote;
    if (p && app.vault.notes.has(p)) { if (dirty.has(p)) flushSave(p); split.open({ kind: "note", path: p }, { focus: false }); }
    app.askAssistant({ selection: sel });
  };

  /** The Search page, pre-filled: { query, paths, folder }. */
  /** The chat in the AI home, asked something (or just opened). */
  /** A video or a playlist into the Player's Online media, without leaving where you are (the Player loads out of sight if it has not yet). */
  // a page's icon, as WebView2 reports it: kept once per site, and the tabs of that site show it
  if (host.real) host.on("tabweb:favicon", (p) => { if (p && p.url && p.png) keepFavicon(p.url, p.png).then((changed) => { if (changed) renderTabs(); }); }).catch(() => {});
  // the browser's own password saving (Settings › Passwords), for every page now and later
  if (app.settings.webPasswords) host.webPasswordsSet(true).catch(() => {});
  app.bus.on("settings", (k) => { if (k === "webPasswords") host.webPasswordsSet(!!app.settings.webPasswords).catch(() => {}); });
  app.addToPlayer = (url) => {
    if (!views.music) {
      const el = viewEl("music");
      const here = cur();
      if (!(here.kind === "view" && here.view === "music")) el.hidden = true;
      views.music = mounts.music(app, el);
    }
    return views.music.addLink(url, "add");
  };
  app.askAssistant = (opts = {}) => {
    app.openView("assistant");
    const v = views.assistant;
    if (v && v.ask) v.ask(opts);
  };
  /** A project's chat in the AI home: { folder, name, notes, prompt?, open?: chat id, fresh? } */
  app.askProject = (opts) => {
    app.openView("assistant");
    const v = views.assistant;
    if (v && v.project) v.project(opts);
  };
  /** The project room, on a project folder (or the one it was on). */
  app.openRoom = (folder, lens) => {
    // a workspace opens in its own space first - its tabs, back on the one you left it at;
    // the room itself only when the space is new or a lens was asked for
    const p = folder && folder !== "*" ? app.projectAt(folder) : null;
    const s = p ? workspaceSpace(app, p) : null;
    if (s && s.id !== app.currentSpaceId()) {
      const had = (s.tabs || []).length > 0;
      spacesApi.switchTo(s.id);
      if (had && !lens) { app.setSetting("roomProject", folder); return; }
    }
    app.openView("room");
    const v = views.room;
    if (v && v.open) v.open(folder, lens);
  };
  app.openSearch = (opts = {}) => {
    app.openView("search", opts.newTab ? { newTab: true } : {});
    const v = views.search;
    if (v && v.open) v.open(opts);
  };

  /* ── other files (images, PDFs, Office docs...) ───────────────────────── */
  app.openFile = (path, opts = {}) => {
    if (!app.vault.files.has(path)) return;
    // an HTML file last read as a page opens as the page
    if (/\.x?html?$/i.test(path) && (app.settings.htmlAsPage || []).includes(path) && !opts.asText) {
      const url = app.fileUrl(path);
      const i = tabs.findIndex((t) => t.kind === "web" && t.path === url);
      if (i >= 0) { flushCur(); active = i; return show(); }
      return app.newWebTab(url, { background: false });
    }
    navigate({ kind: "file", path }, opts);
    if (opts.line && fileView && fileView.goLine) fileView.goLine(opts.line);
  };

  // Leaving the window for a moment - the clock, another program - must not
  // cost the caret. What had the keys is remembered when the window loses
  // them, and gets them back when it returns, unless something else took them
  // meanwhile.
  let hadFocus = null;
  // While the window is away the caret stays drawn where it was (class
  // "keeps-caret" on that editor), so the place is never lost from sight.
  const keepCaret = (on, a) => {
    for (const x of document.querySelectorAll(".keeps-caret")) x.classList.remove("keeps-caret");
    // on the editor's parent: CodeMirror rewrites its own element's classes
    const ed = on && a && a.closest ? a.closest(".cm-editor") : null;
    if (ed && ed.parentElement) ed.parentElement.classList.add("keeps-caret");
  };
  window.addEventListener("blur", () => { const a = document.activeElement; if (a && a !== document.body) hadFocus = a; keepCaret(true, a); });
  document.addEventListener("focusin", () => keepCaret(false), true);
  const comeBack = () => {
    const el = hadFocus;
    hadFocus = null;
    setTimeout(() => {
      const a = document.activeElement;
      // the element can still be "active" while the page has no keys at all
      // (the caret stands still): let go and take hold again, which wakes it
      if (a && a === el && a.closest && a.closest(".keeps-caret")) { try { a.blur(); a.focus({ preventScroll: true }); } catch {} return; }
      if (a && a !== document.body && a !== document.documentElement) return;
      if (el && el.isConnected && el.offsetParent) { try { el.focus({ preventScroll: true }); } catch {} return; }
      // nothing remembered (the webview dropped it first): a note in front takes the keys
      const t = cur();
      if (t && t.kind === "note" && editor && !document.querySelector(".menu, .pal, dialog[open]")) editor.focus();
    }, 30);
  };
  // The clock's calendar hands the keys to the taskbar when it closes, not
  // back to us. The pointer moving over Leonote again while only the Windows
  // shell has them asks for them back (the backend refuses for any other program).
  let askedAt = 0;
  document.addEventListener("mousemove", () => {
    if (document.hasFocus() || Date.now() - askedAt < 700) return;
    askedAt = Date.now();
    if (host.reclaimFocus) host.reclaimFocus().catch(() => {});
  }, true);
  window.addEventListener("focus", comeBack);
  // the frame can come back without the page hearing "focus" (the clock's
  // calendar does that): the backend says so as well
  host.on("app:focused", comeBack);

  // Undo and redo only ever reach what is in front of you. A pane that was
  // switched away from can still hold the keyboard focus - its editor is
  // hidden, not gone - and Ctrl+Z would then quietly change a file nobody is
  // looking at. Such a key is stopped, and the stale focus is dropped.
  const hiddenFocus = (el) => !!el && el !== document.body && el.nodeType === 1 && (!el.offsetParent && getComputedStyle(el).position !== "fixed" || !!el.closest("[hidden]"));
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.code !== "KeyZ" && e.code !== "KeyY") return;
    const t = document.activeElement;
    if (!hiddenFocus(t) && !hiddenFocus(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    try { t.blur(); } catch {}
    toast("Nothing to undo here - click into the file you mean first", { ms: 2400 });
  }, true);

  // Space plays and pauses the song or video of the tab that is up, wherever
  // the keys happen to be - in the file tree it would only scroll the list.
  document.addEventListener("keydown", (e) => {
    if (e.key !== " " || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, button, [contenteditable], .cm-editor, .fv-player, .menu, .pal, dialog")) return;
    const box = [...document.querySelectorAll(".fv-player")].find((b) => b.offsetParent);
    const m = box && box.querySelector("video.fv-media, audio.fv-media");
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    m.paused ? m.play().catch(() => {}) : m.pause();
  }, true);

  // A video going full screen takes the window with it. The window has no
  // frame of its own, and a maximized one that is simply told to fill the
  // screen keeps its work-area height - a strip of bare window is left where
  // the taskbar was. So: out of maximized first, full screen, and back after.
  let fsWasMax = false;
  let fsOurs = false;
  document.addEventListener("fullscreenchange", async () => {
    if (!host.win || !host.win.setFullscreen) return;
    try {
      if (document.fullscreenElement) {
        if (fsOurs) return;
        fsOurs = true;
        // one call, one turn of the window's thread: nothing in between is painted
        fsWasMax = !!(await host.videoFullscreen(true, false));
      } else if (fsOurs) {
        // stepping to the next video leaves and re-enters within a moment
        await new Promise((r) => setTimeout(r, 180));
        if (document.fullscreenElement) return;
        fsOurs = false;
        await host.videoFullscreen(false, fsWasMax);
      }
    } catch {}
  });

  /* ── files outside the vault ──────────────────────────────────────────── */
  // They are never copied in behind your back: the tab points at the file
  // where it lies, and the banner in extview.js is the only way in.
  // Outside files the note and code editors, the picture viewer and the player do not
  // already handle open in the vault's own file view, as guests: Word, Excel, PDF, drawings,
  // video projects, web pages - every viewer and editor, and saving back where the file lies.
  const GUEST_RE = /\.(pdf|docx?|xlsx?|csv|tsv|pptx?|odt|ods|rtf|leostudio|leopaint|leocanvas|leovector|excalidraw|leovideo|canvas|html?|zip|7z|rar|tar|gz)$/i;
  const guests = new Map(); // guest path -> { path, kind, size, mtime, abs }
  app.isGuest = (p) => String(p || "").startsWith("@guest/");
  app.guestFile = (p, entry) => { if (entry) guests.set(p, { ...(guests.get(p) || {}), ...entry }); return guests.get(p) || null; };
  app.guestAbs = (p) => (guests.get(p) || {}).abs || "";
  app.openGuest = async (abs, opts = {}) => {
    const entry = await host.guestOpen(abs);
    const was = guests.get(entry.path);
    guests.set(entry.path, { ...entry, abs });
    // open already, and changed since: the tab takes the new version
    if (was && was.mtime !== entry.mtime) setTimeout(() => { if (fileView) fileView.external(); }, 50);
    // remembered, so a guest tab comes back after a restart
    const kept = { ...(app.settings.guestFiles || {}) };
    kept[entry.path] = abs;
    const keys = Object.keys(kept);
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete kept[k];
    app.setSetting("guestFiles", kept);
    navigate({ kind: "file", path: entry.path }, { newTab: true, ...opts });
    return entry.path;
  };
  /* An outside file changes where only Windows sees it (another program saves it): looked at again when
     Leonote is back in front, or the file is opened again - its tab takes the new version, unless it has
     edits of its own not saved yet. */
  async function refreshGuest(p) {
    const g = guests.get(p);
    if (!g) return;
    const entry = await host.guestOpen(g.abs).catch(() => null);
    if (!entry || entry.mtime === g.mtime) return;
    guests.set(p, { ...entry, abs: g.abs });
    if (fileView) fileView.external();
    for (const sp of split.panes) if (sp.fileView && sp.current && sp.current.path === p) sp.fileView.external();
  }
  window.addEventListener("focus", () => {
    const seen = new Set();
    const t = cur();
    if (t && t.kind === "file" && app.isGuest(t.path)) seen.add(t.path);
    for (const sp of split.panes) if (sp.current && sp.current.kind === "file" && app.isGuest(sp.current.path)) seen.add(sp.current.path);
    for (const p of seen) refreshGuest(p);
  });
  async function restoreGuests() {
    await Promise.all(Object.values(app.settings.guestFiles || {}).map((abs) => host.guestOpen(abs).then((entry) => { guests.set(entry.path, { ...entry, abs }); }).catch(() => {})));
  }

  const extKey = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  /**
   * The space and tab where an outside file is open already, or null: in this space, and - for a
   * file handed over from Windows (`anywhere`) - in any space. A click inside the app stays here.
   */
  function findExt(p, anywhere = false) {
    const k = extKey(p);
    const i = tabs.findIndex((t) => t.kind === "ext" && extKey(t.path) === k);
    if (i >= 0) return { s: space, i };
    if (anywhere) for (const s of spaces) if (s !== space && (s.tabs || []).some((l) => l.kind === "ext" && extKey(l.path) === k)) return { s, i: -1 };
    return null;
  }
  function goToExt(p, hit) {
    if (hit.s !== space) spacesApi.switchTo(hit.s.id);
    const k = extKey(p);
    const i = tabs.findIndex((t) => t.kind === "ext" && extKey(t.path) === k);
    if (i < 0) return false;
    flushCur();
    active = i;
    show();
    return true;
  }
  app.openExternal = (path, opts = {}) => {
    const p = String(path || "").trim();
    if (!p) return;
    if (GUEST_RE.test(p) && host.guestOpen) return app.openGuest(p, opts).catch((e) => toast("Could not open it: " + (e && e.message ? e.message : e), { kind: "error" }));
    const hit = findExt(p, !!opts.anywhere);
    if (hit && goToExt(p, hit)) { if (opts.line && extView) extView.goLine(opts.line); return; }
    extGone.delete(p);
    navigate({ kind: "ext", path: p }, opts);
    if (opts.line && extView) extView.goLine(opts.line);
  };
  app.currentSpaceId = () => (space ? space.id : "");
  /**
   * Files handed over from outside - Open with, a double-click in Explorer, the
   * command line - open in their own space, "Opened files", made when first
   * needed, so the space you work in keeps its tabs. Alt+` (or the chip by the
   * spaces button) goes straight back. Settings › Spaces turns it off.
   */
  /** A path on this computer, as the vault's own path when it is a note or file of the vault; else null. */
  const relInVault = (abs) => {
    const root = String(app.vault.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const p = String(abs || "").replace(/\\/g, "/");
    if (!root || p.toLowerCase().indexOf(root.toLowerCase() + "/") !== 0) return null;
    const rel = p.slice(root.length + 1);
    return app.vault.notes.has(rel) || app.vault.files.has(rel) ? rel : null;
  };
  app.openFromOutside = (paths) => {
    let list = [].concat(paths || []).filter(Boolean);
    // songs go to the Player and play there, not into a tab
    const songs = list.filter((p) => /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|weba)$/i.test(p));
    if (songs.length && app.media) {
      app.media.playList(songs.map((p) => app.media.outsideKey(p)), 0);
      app.openView("music");
      list = list.filter((p) => !songs.includes(p));
    }
    if (!list.length) return;
    // pictures and videos: the viewer, a window of its own (Settings: a window each, one viewer window, or a tab)
    const how = app.settings.mediaOpen || "windows";
    const media = how === "tab" || !host.viewerOpen ? [] : list.filter((p) => /\.(png|jpe?g|jfif|gif|webp|svg|bmp|avif|ico|heic|heif|mp4|webm|mkv|mov|m4v|ogv)$/i.test(p));
    if (media.length) {
      host.viewerOpen(media, how === "one").catch((e) => toast(String(e), { kind: "error" }));
      list = list.filter((p) => !media.includes(p));
    }
    if (!list.length) return;
    // a file handed over while the window is compact: the full window, to read it in
    if (app.settings.compact) setCompact(false, { stay: true });
    // Every file handed over goes to "Opened files", the vault's own too (as its note or file tab), so the space
    // you work in keeps its tabs. Before, a file of the vault opened in the space you were in and the rest in
    // "Opened files" - which file went where looked random from Explorer.
    // A file of the vault is its note/file tab; an outside PDF, document or drawing already shown is its guest tab.
    const guestOf = (p) => { for (const [g, e] of guests) if (e && e.abs && extKey(e.abs) === extKey(p)) return g; return null; };
    const docs = list.map((p) => {
      const r = relInVault(p);
      if (r) return { kind: app.vault.notes.has(r) ? "note" : "file", path: r };
      const g = GUEST_RE.test(p) ? guestOf(p) : null;
      return g ? { kind: "file", path: g } : null;
    });
    const where = (l) => spaces.find((s) => (s === space ? tabs : s.tabs || []).some((x) => same(x, l))) || null;
    const focus = (l) => { const k = tabs.findIndex((x) => same(x, l)); if (k < 0) return false; flushCur(); active = k; show(); if (app.isGuest(l.path)) refreshGuest(l.path); return true; };
    // open somewhere already: that tab, in its space
    if (list.every((p, i) => (docs[i] ? where(docs[i]) : findExt(p, true)))) {
      list.forEach((p, i) => { if (!docs[i]) return app.openExternal(p, { anywhere: true }); const s = where(docs[i]); if (s !== space) spacesApi.switchTo(s.id); focus(docs[i]); });
      return;
    }
    if (app.settings.outsideSpace !== false && space) {
      let s = spaces.find((x) => x.id === "outside");
      if (!s) { s = { id: "outside", name: "Opened files", icon: "i:outside", tabs: [], active: -1 }; spaces.push(s); saveSession(); spacesUi.paint(); }
      if (space !== s) spacesApi.switchTo(s.id);
    }
    list.forEach((p, i) => {
      const l = docs[i];
      if (l && focus(l)) return;
      if (l && l.kind === "note") app.openNote(l.path, { newTab: true });
      else if (l && !app.isGuest(l.path)) app.openFile(l.path, { newTab: true });
      else app.openExternal(p, { newTab: true });
    });
  };
  /** An outside text file that is open in some tab - the current one first. */
  app.lastExternal = () => app.currentExternal() || ((tabs.filter((t) => t.kind === "ext").pop() || {}).path || null);
  app.currentExternal = () => {
    const t = active >= 0 ? tabs[active] : null;
    if (t && t.kind === "ext") return t.path;
    // an outside HTML file shown as a page: its tab holds its file:/// address
    if (t && t.kind === "web" && /^file:/i.test(t.path || "")) { try { return decodeURIComponent(new URL(t.path).pathname).replace(/^\/+(?=[a-z]:)/i, ""); } catch { return null; } }
    return null;
  };
  /** An outside file was renamed from the Outposts tree: its tabs follow it. */
  app.extMoved = (from, to) => {
    let hit = false;
    const under = (p) => p === from || p.startsWith(from + "\\") || p.startsWith(from + "/");
    for (const t of tabs) if (t.kind === "ext" && under(t.path)) { t.path = to + t.path.slice(from.length); hit = true; }
    if (hit) { saveSession(); show(); }
  };
  app.addPlayerLibrary = (dir) => app.media.libraries.add(dir)
    .then((r) => toast(`${r.name} plays in the Player now · ${r.count} file${r.count === 1 ? "" : "s"}`, { ms: 3600 }))
    .catch((e) => toast("Could not add it to the Player: " + e, { kind: "error" }));
  /** extview.js found the file gone: stop restoring it next time. */
  app.extGone = (path) => { extGone.add(path); saveSession(); };

  app.pickExternal = async () => {
    const picked = await host.dialogOpen({
      title: "Open a file from your computer",
      multiple: true,
      filters: [
        { name: "Notes and text", extensions: ["md", "markdown", "txt", "csv", "tsv", "json", "yml", "yaml", "toml", "log", "html", "css", "js", "ts", "py", "rs", "sh"] },
        { name: "Documents, drawings and videos", extensions: ["pdf", "docx", "xlsx", "pptx", "html", "leostudio", "leopaint", "leovideo", "excalidraw", "png", "jpg", "mp4", "mp3"] },
        { name: "All files", extensions: ["*"] },
      ],
    }).catch((e) => { toast("Could not open the file picker: " + e, { kind: "error" }); return null; });
    for (const p of [].concat(picked || [])) app.openExternal(p, { newTab: true });
  };

  /** Copy (or move) an outside file into the vault, then show it as a note. */
  /* A file inside an archive: looked at in a tab, or taken into a folder of the vault. It is read
     out to a folder of its own under the temp folder (archive_preview), never into the vault by itself. */
  app.archiveOpen = async ({ abs, entry }) => {
    try { app.openExternal(await host.archivePreview(abs, entry), { newTab: true }); }
    catch (e) { toast("Could not open it: " + e, { kind: "error", ms: 6000 }); }
  };
  app.archiveTake = async ({ abs, entry }, dir) => {
    try {
      const tmp = await host.archivePreview(abs, entry);
      const res = await host.externalImport(tmp, dir, true);
      const rel = res.path;
      toast(`${rel.split("/").pop()} is in ${dir || "the vault root"}`, { ms: 4000, action: { label: "Open", run: () => (res.note ? app.openNote(rel, { newTab: true }) : app.openFile(rel, { newTab: true })) } });
      return rel;
    } catch (e) { toast("Could not take it out: " + e, { kind: "error", ms: 6000 }); return null; }
  };
  /** Everything in an archive into a folder of the vault, its folders kept. */
  app.archiveTakeAll = async (abs, dir) => {
    const root = String(app.vault.root || "").replace(/[\\/]+$/, "");
    const sep = root.includes("\\") ? "\\" : "/";
    try {
      const n = await host.archiveExtract(abs, [], root + (dir ? sep + dir.split("/").join(sep) : ""));
      toast(`${n} file${n === 1 ? "" : "s"} taken out into ${dir || "the vault root"}`, { ms: 4000 });
    } catch (e) { toast(String(e), { kind: "error", ms: 8000 }); }
  };

  app.importExternal = async (path, { move = false, anchor } = {}) => {
    const dir = await pickFolder(app, anchor, { title: move ? "Move into" : "Copy into" });
    if (dir == null) return;
    if (!(await clashOk([path], () => dir))) return;
    let res;
    try {
      res = await host.externalImport(path, dir, move);
    } catch (e) {
      return toast("Could not add it to the vault: " + e, { kind: "error" });
    }
    const rel = res.path;
    const known = () => (res.note ? app.vault.notes.has(rel) : app.vault.files.has(rel));
    // the watcher reports it a moment later; opening before that would find nothing
    for (let i = 0; i < 40 && !known(); i++) await new Promise((r) => setTimeout(r, 50));
    if (move) extGone.add(path);
    if (!known()) return toast(`${move ? "Moved" : "Copied"} to ${rel} - it will appear in a moment`, { ms: 4000 });
    const target = { kind: res.note ? "note" : "file", path: rel };
    const i = tabs.findIndex((t) => t.kind === "ext" && t.path === path);
    if (i >= 0) { active = i; retarget(tabs[i], target, true); show(); }
    else navigate(target);
    // Undo: a copy goes to the vault's trash; a moved file goes back where it was first (and then the vault's copy to the trash)
    const undo = async () => {
      try {
        if (move) await host.externalPutBack(rel, path);
        await (res.note ? app.vault.trash(rel) : host.fileTrash(rel).then((list) => { if (Array.isArray(list)) app.vault.setFiles(list); }));
        extGone.delete(path);
        const j = tabs.findIndex((t) => t.path === rel);
        if (j >= 0) { active = j; retarget(tabs[j], { kind: "ext", path }, true); show(); }
        toast(move ? "Put back where it was" : "The copy is in the vault's trash", { ms: 2500 });
      } catch (e) { toast("Could not undo: " + e, { kind: "error" }); }
    };
    toast(`${move ? "Moved" : "Copied"} into ${dir || "the vault root"} · ${fileName(rel)}`, {
      ms: 8000,
      action: { label: "Undo", run: undo },
    });
  };

  // Session tabs pointing at files that are gone: dropped, quietly.
  async function pruneExternals() {
    const paths = new Set();
    // not a file on another computer: looking there can raise a question, and nobody opened these tabs just now
    for (const sp of spaces) for (const l of sp.tabs || []) if (l && l.kind === "ext" && !/^\s*([\\/]{2}|\\\?\?\\)/.test(l.path)) paths.add(l.path);
    if (!paths.size) return;
    await Promise.all([...paths].map((p) => host.externalStat(p).catch(() => extGone.add(p))));
    if (!extGone.size) return;
    for (const sp of spaces) if (sp.tabs) sp.tabs = sp.tabs.filter((l) => !(l.kind === "ext" && extGone.has(l.path)));
    const was = active >= 0 ? tabs[active] : null;
    const kept = tabs.filter((t) => !(t.kind === "ext" && extGone.has(t.path)));
    if (kept.length === tabs.length) return;
    tabs = kept;
    active = was ? tabs.indexOf(was) : -1;
    show();
  }

  function retargetDocs(from, to) {
    for (const t of [...tabs, floating]) {
      if (t.path === from) t.path = to;
      for (const s of [t.back, t.fwd]) for (const l of s) if (l.path === from) l.path = to;
    }
    for (const l of trail.list) if (l.path === from) l.path = to;
    for (const s of spaces) if (s !== space) for (const l of s.tabs || []) if (l.path === from) l.path = to;
    // side panes not on screen: this space's put away, every other space's; a space keeps its tabs' panes by path
    for (const st of [...paneOf.values(), shared]) retargetPane(st, from, to);
    for (const s of spaces) if (s !== space) {
      retargetPane(s.split, from, to);
      for (const [k, st] of Object.entries(s.tabPanes || {})) {
        retargetPane(st, from, to);
        const kind = k.slice(0, k.indexOf(":"));
        if (kind !== "view" && k === `${kind}:${from}`) { s.tabPanes[`${kind}:${to}`] = st; delete s.tabPanes[k]; }
      }
    }
  }
  // a stored side pane: its own tabs, or the panes of its two columns (split.js state())
  function retargetPane(st, from, to) {
    if (!st) return;
    for (const l of st.tabs || []) if (l.path === from) l.path = to;
    for (const c of Object.values(st.cols || {})) for (const p of (c && c.panes) || []) retargetPane(p, from, to);
  }

  /* Renames can be taken back (Ctrl+Z) and done again (Ctrl+Shift+Z or Ctrl+Y) from the file tree,
     in turn with the trash's own undo: app.fileOps keeps which of the two came last. */
  app.fileOps = app.fileOps || [];
  const renames = [], redos = [];
  let replaying = false, replayDone = false;
  const renamed = (kind, from, to) => { if (replaying) { replayDone = true; return; } renames.push({ kind, from, to }); redos.length = 0; app.fileOps.push("rename"); };
  const renameTo = (kind, path, target) => {
    const name = fileName(target);
    return kind === "note" ? app.renameNote(path, name.replace(/\.(md|txt)$/i, "")) : kind === "folder" ? app.renameFolder(path, name, dirname(target)) : app.renameFile(path, name);
  };
  async function replayRename(back) {
    if (replaying) return false;
    const op = (back ? renames : redos).pop();
    if (!op) return false;
    replaying = true;
    replayDone = false;
    // refused (the name is taken, the move failed): the rename has said why, nothing moved, the step stays
    try { await (back ? renameTo(op.kind, op.to, op.from) : renameTo(op.kind, op.from, op.to)); } finally { replaying = false; if (!replayDone) (back ? renames : redos).push(op); }
    if (!replayDone) return false;
    if (back) { app.fileOps.splice(app.fileOps.lastIndexOf("rename"), 1); redos.push(op); } else { renames.push(op); app.fileOps.push("rename"); }
    toast(`${back ? "Renamed back to" : "Renamed again to"} “${fileName(back ? op.from : op.to).replace(/\.(md|txt)$/i, "")}”`, { ms: 2200 });
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const redo = (e.code === "KeyZ" && e.shiftKey) || (e.code === "KeyY" && !e.shiftKey);
    const undo = e.code === "KeyZ" && !e.shiftKey;
    if (!(undo ? renames.length && app.fileOps[app.fileOps.length - 1] === "rename" : redo && redos.length)) return;
    // the same place the trash's undo works: the keys with the file list, or a row just clicked
    const a = document.activeElement, side = document.getElementById("sidebar");
    // a text field keeps its own Ctrl+Z, whatever was clicked in the tree before it
    if (a && a.matches("input, textarea, select, [contenteditable], [contenteditable] *")) return;
    const clicked = app.sidebarArmed && app.sidebarArmed();
    if (!clicked && (!a || !side || !side.contains(a) || a.matches("input, textarea, [contenteditable], [contenteditable] *"))) return;
    if (document.querySelector(".dlg-back")) return;
    e.preventDefault();
    e.stopPropagation();
    replayRename(undo);
  }, true);

  app.renameFile = async (path, name) => {
    const to = joinPath(dirname(path), safeName(name.trim()));
    if (to === path) return;
    try {
      await app.vault.renameFile(path, to);
      renamed("file", path, to);
      show();
    } catch (e) { toast("Rename failed: " + e, { kind: "error" }); }
  };

  app.moveFile = async (path, dir) => {
    try {
      // a name taken there already: the file is moved as "name 2", and the links follow it
      const name = fileName(path);
      const dot = name.lastIndexOf(".");
      let to = joinPath(dir, name);
      for (let i = 2; app.vault.files.has(to) || app.vault.notes.has(to); i++) to = joinPath(dir, `${dot > 0 ? name.slice(0, dot) : name} ${i}${dot > 0 ? name.slice(dot) : ""}`);
      await app.vault.renameFile(path, to);
      // notes that name it by its name alone go on finding it; the ones spelling out where it was are rewritten
      const n = await app.vault.relinkFile(path, to);
      show();
      toast(`Moved to ${dir || "vault root"}${n ? ` · links updated in ${n} note${n === 1 ? "" : "s"}` : ""}`);
    } catch (e) { toast("Move failed: " + e, { kind: "error" }); }
  };

  // One deletion, done properly: what is unsaved is written first, and a
  // file that was open is let go of. trash.js asks, tells and takes back.
  mountTrash(app, {
    raw: async (path, kind, mode) => {
      if (kind === "note") { await flushSave(path); return { content: await app.vault.trash(path, mode) }; }
      if (kind === "file") { await app.vault.trashFile(path, mode); show(); return {}; }
      await flushAll();
      await app.vault.trashFolder(path, mode);
      return {};
    },
  });
  app.trashFile = (path) => app.trashItems([[path, "file"]]);

  // where a new note goes when nobody said
  app.newNoteDir = () => app.settings.newNoteDir === "folder" ? (app.settings.newNoteFolder || "")
    : app.settings.newNoteDir === "work" ? app.workDir("note")
    : app.settings.newNoteDir === "current" && lastNote ? dirname(lastNote)
    : "";
  app.newNote = async ({ dir, name, content = "", newTab = false } = {}) => {
    const d = dir != null ? dir : app.newNoteDir();
    try {
      const p = await app.vault.create(d, name || "Untitled", content);
      app.openNote(p, { newTab, focusTitle: !name, offset: name ? content.length : undefined });
      return p;
    } catch (e) {
      toast("Could not create note: " + e, { kind: "error" });
    }
  };

  app.renameNote = async (path, name) => {
    const ext = /\.txt$/i.test(path) ? ".txt" : ".md";
    const clean = safeName(name.trim()).replace(/\.(md|txt)$/i, "");
    const to = joinPath(dirname(path), clean + ext);
    if (to === path) return;
    if (app.vault.notes.has(to) && to.toLowerCase() !== path.toLowerCase()) {
      toast(`“${clean}” already exists in this folder`, { kind: "error" });
      if (editor.path === path) titleEl.value = basename(path);
      return;
    }
    await flushSave(path);
    try {
      const r = await app.vault.rename(path, to);
      renamed("note", path, to);
      if (r.relinked && !replaying) toast(`Renamed · updated links in ${r.relinked} note${r.relinked === 1 ? "" : "s"}`);
    } catch (e) {
      toast("Rename failed: " + e, { kind: "error" });
      if (editor.path === path) titleEl.value = basename(path);
    }
  };

  app.moveNote = async (path, dir) => {
    if (!app.vault.notes.has(path)) return;
    // a .txt note stays a .txt note (not name.txt.md)
    const txt = /\.txt$/i.test(path);
    const to = app.vault.uniquePath(dir, txt ? basename(path).slice(0, -4) : basename(path), txt ? ".txt" : ".md");
    await flushSave(path);
    try {
      await app.vault.rename(path, to);
      toast(`Moved to ${dir || "vault root"}`);
    } catch (e) { toast("Move failed: " + e, { kind: "error" }); }
  };

  // settings that name a vault folder or a file in one
  const FOLDER_KEYS = ["dailyFolder", "yearlyPath", "newNoteFolder", "templateFolder", "zettelFolder", "referenceFolder", "boardsFolder", "workFolder", "docsFolder", "imageFolder", "compressedImageFolder", "videoFolder", "audioFolder", "docFolder", "playlistFolder"];
  const MEDIA_KEYS = new Set(["imageFolder", "compressedImageFolder", "videoFolder", "audioFolder", "docFolder", "playlistFolder"]);
  app.renameFolder = async (path, name, parent) => {
    // a folder moved keeps its own name ("C#" stays "C#"); only a new name is made safe
    const to = joinPath(parent != null ? parent : dirname(path), name === basename(path) ? name : safeName(name.trim()));
    if (to === path) return;
    if (app.vault.folders.has(to)) { toast(`“${to}” already exists`, { kind: "error" }); return; }
    await flushAll();
    await Promise.all([fileView && fileView.dirty ? fileView.flush() : null, split.flush(), ...[...roomFiles].map((fv) => fv.flush())]); // an open file's edits, written while it is still there
    try {
      const r = await app.vault.renameFolder(path, to);
      renamed("folder", path, to);
      app.settings.expanded = (app.settings.expanded || []).map((f) => (f === path || f.startsWith(path + "/") ? to + f.slice(path.length) : f));
      // the folders Leonote writes into (daily notes, the yearly note, templates, pictures…) follow it too,
      // or the next daily note would make a new folder under the old name
      const move = (p) => { const low = String(p || "").toLowerCase(), f = path.toLowerCase(); return low === f ? to : low.startsWith(f + "/") ? to + String(p).slice(path.length) : null; };
      const followed = [];
      for (const k of FOLDER_KEYS) {
        const now = MEDIA_KEYS.has(k) ? app.mediaDir(k) : app.settings[k];
        const next = now && move(now);
        if (next) { app.setSetting(k, next); followed.push(k); }
      }
      saveSettings();
      sidebar.renderTree();
      const said = [r && r.relinked ? `links updated in ${r.relinked} note${r.relinked === 1 ? "" : "s"}` : "", followed.length ? `${followed.length} setting${followed.length === 1 ? "" : "s"} pointed at it now point at “${basename(to)}”` : ""].filter(Boolean);
      if (said.length) toast(`Renamed · ${said.join(" · ")}`, { ms: 4000 });
    } catch (e) { toast("Rename failed: " + e, { kind: "error" }); }
  };

  app.trashNote = (path) => app.trashItems([[path, "note"]]);
  app.trashFolder = (path) => app.trashItems([[path, "folder"]]);

  trackUsage(app);
  app.togglePin = (path) => {
    const s = new Set(app.settings.pinned || []);
    s.has(path) ? s.delete(path) : s.add(path);
    app.setSetting("pinned", [...s]);
  };

  /* ── daily notes: one note per day, or one yearly note filled day by day ── */
  const DAILY_TEMPLATE = "## Focus\n- [ ] \n\n## Notes\n";
  // a note named "Daily" (or "Daily note") in the template folder starts each new day, its {{date}}, {{title}} and
  // {{cursor}} filled in for that day; without one, the fixed start above
  const dailyStart = (k) => {
    const t = templatesIn(app.vault.notes, app.settings.templateFolder || "Templates").find((n) => /^daily( note)?$/i.test(n.title));
    if (!t) return { text: DAILY_TEMPLATE, cursor: DAILY_TEMPLATE.indexOf("- [ ] ") + 6 };
    return expandTemplate(t.content, { title: k, date: parseDay(k) });
  };
  const pad2 = (n) => String(n).padStart(2, "0");
  const yearly = () => app.settings.dailyMode === "yearly";
  function fillDate(tpl, d) {
    return String(tpl).replace(/\{(YYYY|MM|DD|dddd|ddd)\}/g, (_, k) =>
      k === "YYYY" ? String(d.getFullYear()) : k === "MM" ? pad2(d.getMonth() + 1) : k === "DD" ? pad2(d.getDate())
        : d.toLocaleDateString("en-US", { weekday: k === "ddd" ? "short" : "long" }));
  }
  const dayHeading = (d) => fillDate(app.settings.dailyHeading || "# {DD}.{MM}.{YYYY}", d).trim();

  app.dailyPath = (k) => {
    if (yearly()) {
      let p = fillDate(app.settings.yearlyPath || "Daily/{YYYY}.md", parseDay(k)).trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (!/\.md$/i.test(p)) p += ".md";
      return p;
    }
    return joinPath((app.settings.dailyFolder || "").trim(), k + ".md");
  };

  async function ensureNoteAt(p, initial) {
    if (app.vault.notes.has(p)) return p;
    const dir = dirname(p);
    if (dir && !app.vault.folders.has(dir)) await app.vault.createFolder(dir).catch(() => {});
    return app.vault.create(dir, basename(p), initial);
  }

  const offsetOfLine = (lines, idx) => lines.slice(0, idx).reduce((s, l) => s + l.length + 1, 0);

  /** Find the day's heading in a yearly note, adding it at the top (after the
   *  note's own title) or at the bottom when it is not there yet. */
  function daySection(content, heading) {
    const lines = content.split("\n");
    let idx = lines.findIndex((l) => l.trim() === heading);
    if (idx >= 0) return { lines, idx, changed: false };
    if (app.settings.dailyInsert === "top") {
      let at = 0;
      // after the front matter (a day put above the --- would break it), then after the note's own title
      // (a note saved with Windows line ends or a byte-order mark has its --- too)
      const fm = String(lines[0] || "").replace(/^﻿/, "").trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
      if (fm > 0) { at = fm + 1; while (at < lines.length && lines[at].trim() === "") at++; }
      // a title, not another day's heading: a note with none would get today between yesterday's heading and its text
      // each date code as what it writes (digits, a weekday's letters), the rest of the heading as it is
      const CODE = { "{YYYY}": "\\d{4}", "{MM}": "\\d{2}", "{DD}": "\\d{2}", "{dddd}": "[A-Za-z]+", "{ddd}": "[A-Za-z]+" };
      const dayLike = new RegExp("^" + (app.settings.dailyHeading || "# {DD}.{MM}.{YYYY}").trim().split(/(\{(?:YYYY|MM|DD|dddd|ddd)\})/)
        .map((part) => CODE[part] || part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
      if (lines[at] && /^#{1,6}\s/.test(lines[at]) && lines[at].trim() !== heading && !dayLike.test(lines[at].trim())) {
        at++;
        while (at < lines.length && lines[at].trim() === "") at++;
      }
      lines.splice(at, 0, heading, "", "");
      idx = at;
    } else {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      if (lines.length) lines.push("");
      lines.push(heading, "", "");
      idx = lines.length - 3;
    }
    return { lines, idx, changed: true };
  }

  async function yearlyNote(d) {
    const p = await ensureNoteAt(app.dailyPath(dayKey(d)), `# ${d.getFullYear()}\n`);
    await flushSave(p);
    const base = editor.content(p) ?? app.vault.get(p).content;
    const sec = daySection(base, dayHeading(d));
    if (sec.changed) {
      const next = sec.lines.join("\n");
      app.vault.write(p, next);
      editor.applyExternal(p, next);
    }
    return { p, sec };
  }

  app.openDaily = async (k = dayKey(), opts = {}) => {
    if (yearly()) {
      const { p, sec } = await yearlyNote(parseDay(k));
      // caret on the first line under the day's heading
      return app.openNote(p, { ...opts, offset: offsetOfLine(sec.lines, Math.min(sec.idx + 1, sec.lines.length - 1)) });
    }
    const existed = app.vault.notes.has(app.dailyPath(k));
    const start = existed ? null : dailyStart(k);
    const p = await ensureNoteAt(app.dailyPath(k), start ? start.text : DAILY_TEMPLATE);
    app.openNote(p, { ...opts, offset: start && start.cursor != null ? start.cursor : undefined });
  };

  /** A yearly note's text with `block` at the end of day d's section (its heading added if it is not there yet). */
  function underDay(content, d, block) {
    const sec = daySection(content || `# ${d.getFullYear()}\n`, dayHeading(d));
    const lines = sec.lines;
    // the day's section ends at the next heading of the same or a higher level
    const level = (/^(#{1,6})\s/.exec(lines[sec.idx]) || [0, "#"])[1].length;
    const stop = new RegExp(`^#{1,${level}}\\s`);
    let end = sec.idx + 1;
    while (end < lines.length && !stop.test(lines[end])) end++;
    let at = end;
    while (at > sec.idx + 1 && lines[at - 1].trim() === "") at--;
    lines.splice(at, 0, block);
    return lines.join("\n");
  }
  /** For a skill writing to {{daily}}: today's section of the yearly note, or null with one note a day. */
  app.underToday = (content, block) => (yearly() ? underDay(content, new Date(), block) : null);

  app.appendToDaily = async (text) => {
    if (yearly()) {
      const { p, sec } = await yearlyNote(new Date());
      const next = underDay(sec.lines.join("\n"), new Date(), `- ${text}`);
      app.vault.write(p, next);
      editor.applyExternal(p, next);
      return;
    }
    const p = await ensureNoteAt(app.dailyPath(dayKey()), dailyStart(dayKey()).text);
    await flushSave(p);
    const base = editor.content(p) ?? app.vault.get(p).content;
    const next = base.replace(/\s*$/, "") + `\n- ${text}\n`;
    app.vault.write(p, next);
    editor.applyExternal(p, next);
  };

  /* ── habits ───────────────────────────────────────────────────────────── */
  const persistHabits = debounce(() => host.saveHabits(app.habits).catch((e) => toast("Could not save habits: " + e, { kind: "error" })), 250);
  app.saveHabits = () => { persistHabits(); app.bus.emit("habits"); };
  app.toggleHabit = (id, k) => {
    if (!app.habits || typeof app.habits !== "object") app.habits = { habits: [], log: {} };
    if (!app.habits.log) app.habits.log = {};
    const arr = app.habits.log[k] || (app.habits.log[k] = []);
    const i = arr.indexOf(id);
    i >= 0 ? arr.splice(i, 1) : arr.push(id);
    if (i < 0) app.sound("habit");
    app.stats.award(i >= 0 ? -XP.habitDone : XP.habitDone, "habitDone");
    app.saveHabits();
  };
  app.habitsBadge = () => {
    const hd = app.habits;
    if (!hd || !Array.isArray(hd.habits) || !hd.habits.length) return "";
    const done = ((hd.log && hd.log[dayKey()]) || []).filter((id) => hd.habits.some((x) => x.id === id)).length;
    return `${done}/${hd.habits.length}`;
  };

  /* ── status bar ───────────────────────────────────────────────────────── */
  // a writing target in the note's front matter (word_goal: 1500): " / 1,500 (21%)" after the count
  const goalOf = (n) => {
    const g = (n.content || "").startsWith("---") ? Number(frontMatter(n.content).word_goal) || 0 : 0;
    return g > 0 ? ` / ${g.toLocaleString()} (${Math.round((100 * n.words) / g)}%)` : "";
  };
  const statusEl = $("#statusbar");
  const saveDot = h("span", { class: "sb-save" });
  // the newest change from outside: a click opens it (or Home's list, when it was not a note that is still there)
  const agentEl = h("span", { class: "sb-agent", title: "Open what changed", style: "cursor:pointer", onclick: () => { const l = app.activity[0]; l && l.path && app.vault.get(l.path) ? app.openNote(l.path) : app.openView("home"); } });
  // the open file's name; hover unfolds the folder, click shows it in Explorer
  const pathDir = h("span", { class: "sb-path-dir" });
  const pathName = h("span", { class: "sb-path-name" });
  // a vault file: click finds it in the tree, double-click in Explorer; a file
  // from outside: click shows it in Explorer; a page: click copies its address
  const pathEl = h("button", { class: "sb-path", hidden: true,
    // the folder slides open to its own width (a far-off ceiling makes the slide snap open in a blink)
    onmouseenter: () => { pathDir.style.setProperty("--w", Math.min(pathDir.scrollWidth + 1, innerWidth * 0.6) + "px"); crumbs(true); },
    onmouseleave: () => crumbs(false),
    onclick: () => { const t = cur(); if (!t) return; if (isDoc(t)) { app.setSetting("sidebar", true); sidebar.reveal(t.path); } else if (t.kind === "ext") host.externalReveal(t.path).catch((e) => toast(String(e), { kind: "error" })); else if (t.kind === "web" && t.path) navigator.clipboard.writeText(t.path).then(() => toast("Address copied", { ms: 1600 })); },
    ondblclick: () => { const t = cur(); if (!t) return; if (isDoc(t)) app.reveal(t.path); else if (t.kind === "web" && t.path) app.openUrl(t.path); },
    oncontextmenu: (e) => {
      e.preventDefault();
      const t = cur();
      if (!t) return;
      if (isDoc(t)) {
        menu(e.clientX, e.clientY, [
          { header: t.path },
          { label: "Find it in the sidebar", icon: "sidebar", run: () => { app.setSetting("sidebar", true); sidebar.reveal(t.path); } },
          { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(t.path) },
          { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(t.path); toast("Path copied", { ms: 1600 }); } },
          t.kind === "file" ? { label: "Where it is used…", icon: "link", run: () => app.showUsedIn(t.path, e.clientX, e.clientY) } : null,
          "sep",
          { label: "The folder…", icon: "folder", sub: [
            { label: "New note here", icon: "filePlus", run: () => app.newNote({ dir: dirname(t.path) }) },
            { label: "New sketch here", icon: "brush", run: () => app.newSketch({ dir: dirname(t.path) }) },
            { label: "New research board here", icon: "grid", run: () => app.newBoard({ dir: dirname(t.path) }) },
            { label: "Show in Explorer", icon: "reveal", run: () => app.reveal(dirname(t.path)) },
            { label: "Search in this folder…", icon: "search", run: () => app.openSearch({ folder: dirname(t.path) }) },
          ] },
        ].filter(Boolean));
      } else if (t.kind === "ext") {
        menu(e.clientX, e.clientY, [{ header: t.path }, { label: "Show in Explorer", icon: "reveal", run: () => host.externalReveal(t.path).catch((err) => toast(String(err), { kind: "error" })) }, { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(t.path); toast("Path copied", { ms: 1600 }); } }]);
      } else if (t.kind === "web" && t.path) {
        menu(e.clientX, e.clientY, [{ header: t.path.slice(0, 80) }, { label: "Copy the address", icon: "link", run: () => { navigator.clipboard.writeText(t.path); toast("Address copied", { ms: 1600 }); } }, { label: "Open in your browser", icon: "outside", run: () => app.openUrl(t.path) }]);
      }
    } }, pathDir, pathName);
  const infoEl = h("span", { class: "sb-info" });
  const modeBtn = h("button", { class: "sb-mode", title: "Toggle live preview (Ctrl+Shift+E)", onclick: () => app.run("toggle-preview") });
  // Reading (pictures in the text column) or Collage (text stays, pictures use the full width)
  const layoutBtn = h("button", { class: "sb-mode sb-layout", onclick: () => {
    const next = (noteLayout || app.settings.imageLayout || "column") === "column" ? "collage" : "column";
    if (noteLayout) { toast("This note sets its own picture layout (cssclasses)", { ms: 2200 }); return; }
    app.setSetting("imageLayout", next);
    status();
  } });
  const pomoEl = h("button", { class: "sb-pomo", title: "Timer (Alt+P start/pause)", onclick: () => app.openView("timer") });
  // right click: the timer's controls, without leaving what you are doing
  pomoEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const P = app.pomo;
    const brk = P.phase === "break";
    app.menu(e.clientX, e.clientY - 8, [
      { header: `${brk ? "Break" : "Focus"} · ${P.label()} left` },
      { label: P.running ? "Pause" : "Resume", icon: P.running ? "pause" : "play", keys: "Alt P", run: () => P.toggle() },
      { label: brk ? "End the break - start focusing" : "Finish this block - take the break", icon: "forward", run: () => P.skip() },
      { label: "Add 5 minutes", icon: "plus", run: () => P.extend(5) },
      { label: "Start over (reset)", icon: "undo", run: () => P.reset() },
      "sep",
      { label: "Open the timer", icon: "clock", keys: "Alt 6", run: () => app.openView("timer") },
    ]);
  });
  const paintPomo = () => {
    const b = app.pomo.badge();
    pomoEl.hidden = !b;
    if (!b) return;
    pomoEl.className = "sb-pomo" + (app.pomo.phase === "break" ? " is-break" : "") + (app.pomo.running ? " is-running" : "");
    pomoEl.textContent = b;
    pomoEl.title = (app.pomo.phase === "break" ? "Break" : "Work") + (app.pomo.running ? "" : " - paused") + " - click for the timer (Alt+P start/pause) · right-click to pause, skip or reset";
  };
  app.bus.on("pomo", paintPomo);
  paintPomo();
  // agents' edits waiting for you, and what agents may do with each folder (proposals.js)
  app.proposals = mountProposals(app);
  app.plugins = mountPlugins(app);
  statusEl.append(saveDot, pathEl, agentEl, app.proposals.chip, app.media.pill, playingEl, h("span", { class: "sb-spacer" }), pomoEl, infoEl, layoutBtn, modeBtn);
  app.bus.on("settings", (k) => { if (k === "imageLayout") status(); });

  function setSaveState() {
    const pending = dirty.size || app.vault.saving;
    saveDot.className = "sb-save" + (pending ? " is-pending" : "");
    const said = app.vault.failed.size ? "Not saved" : pending ? "Saving…" : "Saved";
    if (saveDot.textContent !== said) saveDot.textContent = said;
    const t = cur();
    const activeEl = active >= 0 ? tabsEl.querySelector(".tab.is-active") : null;
    if (activeEl && t.kind === "note") activeEl.classList.toggle("is-dirty", dirty.has(t.path));
  }
  app.vault.bus.on("saving", setSaveState);
  // a failed write stays unsaved and is tried again, every few seconds; the toast once a minute, a full disk would raise one per try
  const saveFailToast = new Map();
  let saveRetry = 0;
  app.vault.bus.on("error", ({ path, err }) => {
    if (!(Date.now() - saveFailToast.get(path) < 60000)) {
      saveFailToast.set(path, Date.now());
      toast(`Could not save “${basename(path)}”: ${err}`, { kind: "error", ms: 10000 });
    }
    if (!app.vault.failed.has(path)) return;
    dirty.add(path);
    setSaveState();
    if (!saveRetry) saveRetry = setTimeout(() => { saveRetry = 0; saveSoon(); }, 5000);
  });
  // A note that suddenly loses most of itself: the write goes through (the
  // text you can see is the text you get), but the old version is one click
  // away, and older ones are in "Restore an earlier version…".
  app.vault.bus.on("shrank", ({ path, before, after, restore }) => {
    const gone = before.length - after.length;
    toast(`“${basename(path)}” shrank by ${gone.toLocaleString()} characters`, {
      kind: "error",
      ms: 9000,
      action: {
        label: "Undo",
        run: () => {
          dirty.delete(path);
          restore().then(() => {
            for (const ed of [editor, ...(split ? split.editors : [])]) if (ed && ed.has(path)) ed.replace(path, before);
            setSaveState();
          });
        },
      },
    });
  });

  // the path's folders as blocks over it, after a moment's hover: each one opens that folder in the sidebar
  let crumbEl = null, crumbTimer = 0;
  function crumbs(show) {
    clearTimeout(crumbTimer);
    if (!show) { crumbTimer = setTimeout(() => { if (crumbEl && !crumbEl.matches(":hover")) { crumbEl.remove(); crumbEl = null; } }, 250); return; }
    crumbTimer = setTimeout(() => {
      const t = cur();
      if (!t || !isDoc(t) || !t.path.includes("/")) return;
      const parts = t.path.split("/").slice(0, -1);
      const r = pathEl.getBoundingClientRect();
      crumbEl?.remove();
      crumbEl = h("div", { class: "sb-crumbs", style: { left: r.left + "px", bottom: innerHeight - r.top + 6 + "px" }, onmouseleave: () => crumbs(false) },
        // a click opens the folder in the sidebar and the blocks stay (for another, or a double-click); a double-click: Explorer
        parts.map((name, i) => h("button", { class: "sb-crumb", title: "Click: open this folder in the sidebar · double-click: in Explorer",
          onclick: () => { app.setSetting("sidebar", true); sidebar.reveal(parts.slice(0, i + 1).join("/"), true); },
          ondblclick: () => { app.reveal(parts.slice(0, i + 1).join("/")); crumbEl?.remove(); crumbEl = null; } }, icon("folder"), name)));
      document.getElementById("overlay-root").append(crumbEl);
    }, 600);
  }

  function status() {
    const t = cur();
    pathEl.hidden = !t || !(isDoc(t) || t.kind === "ext" || (t.kind === "web" && t.path));
    if (!pathEl.hidden) {
      const p = String(t.path);
      const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
      pathDir.textContent = cut >= 0 ? p.slice(0, cut + 1) : "";
      pathName.textContent = p.slice(cut + 1);
      pathEl.title = isDoc(t) ? `${p} · click to find it in the sidebar, double-click to show it in Explorer, right-click for more` : t.kind === "ext" ? `${p} · outside the vault · click to show it in Explorer` : `${p} · click to copy the address, double-click to open it in your browser`;
    }
    setSaveState();
    if (t && t.kind === "note") {
      const n = app.vault.get(t.path);
      // with words selected, what they come to (the same word rule as the note's count)
      const sr = editor.path === t.path && editor.view ? editor.view.state.selection.main : null;
      const s = sr && !sr.empty ? editor.view.state.sliceDoc(sr.from, sr.to) : "";
      const sw = s ? (s.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length : 0;
      infoEl.textContent = !n ? "" : sw ? `${sw.toLocaleString()} of ${n.words.toLocaleString()} words selected · ${s.length.toLocaleString()} characters`
        : `${n.words.toLocaleString()}${goalOf(n)} words · ${Math.max(1, Math.round(n.words / 230))} min read · Ln ${app.cursorLine + 1}`;
      infoEl.title = n && !sw ? "A writing target: add word_goal: 1500 to the note's front matter" : "";
      modeBtn.hidden = false;
      modeBtn.textContent = app.settings.livePreview ? "Live preview" : "Source";
      const lay = noteLayout || app.settings.imageLayout || "column";
      layoutBtn.hidden = false;
      // drawn again only when it changed: this runs at every pause of the cursor
      if (layoutBtn.dataset.k !== lay) { layoutBtn.dataset.k = lay; layoutBtn.replaceChildren(icon(lay === "column" ? "fileText" : "grid"), lay === "column" ? "Reading" : lay === "wide" ? "Wide" : "Collage"); }
      layoutBtn.title = lay === "column" ? "Pictures stay in the text column · click for Collage (pictures use the full width)" : "Pictures use the full width · click for Reading";
    } else {
      infoEl.textContent = t && t.view === "tasks" ? `${app.tasks.count("inbox")} open` : "";
      modeBtn.hidden = true;
      layoutBtn.hidden = true;
    }
    const last = app.activity[0];
    agentEl.hidden = !last;
    const said = last ? `${last.by} ${last.text} · ${relTime(last.at)}` : "";
    if (last && agentEl.dataset.k !== said) { agentEl.dataset.k = said; agentEl.replaceChildren(icon("sparkles"), said); }
  }
  const statusSoon = debounce(status, 120);
  app.vault.bus.on("changed", (e) => { if (e.path === app.currentPath()) statusSoon(); });
  setInterval(() => { if (app.activity.length && !document.hidden) status(); }, 30000); // "· 5 min ago" keeps up; nothing drawn while the window hides
  // trash keeps its promise whether or not the Tasks view is open
  app.tasks.sweepTrash();
  setInterval(() => app.tasks.sweepTrash(), 15 * 60000);

  /* ── store events → editor & tabs ─────────────────────────────────────── */
  app.vault.bus.on("renamed", ({ from, to }) => {
    statusSoon();
    editor.rename(from, to);
    split.rename(from, to);
    for (const ed of roomEds) ed.rename(from, to);
    const shown = [...tabs, floating].some((t) => t.path === from);
    retargetDocs(from, to);
    if (app.positions[from]) { app.positions[to] = app.positions[from]; delete app.positions[from]; savePositions(); }
    if (dirty.has(from)) { dirty.delete(from); dirty.add(to); }
    if (lastTyped.has(from)) { lastTyped.set(to, lastTyped.get(from)); lastTyped.delete(from); }
    if (lastNote === from) lastNote = to;
    const pins = app.settings.pinned || [];
    if (pins.includes(from)) app.setSetting("pinned", pins.map((p) => (p === from ? to : p)));
    app.settings.recent = (app.settings.recent || []).map((p) => (p === from ? to : p));
    if (shown) renderTabs();
    if (app.currentPath() === to) { paintTitle(); document.title = `${basename(to)} - Leonote`; }
    saveSession();
  });

  // a file renamed or moved, by itself or with its folder: its tabs, side panes and pin follow
  app.vault.bus.on("fileRenamed", ({ from, to }) => {
    const open = [...tabs, floating].some((t) => t.path === from);
    retargetDocs(from, to);
    split.rename(from, to);
    for (const p of split.panes) if (p.current && p.current.kind === "file" && p.current.path === to) p.render();
    const pins = app.settings.pinned || [];
    if (pins.includes(from)) app.setSetting("pinned", pins.map((p) => (p === from ? to : p)));
    if (open) { if (cur().path === to) show(); else renderTabs(); }
    saveSession();
  });
  // a renamed folder keeps its workspace: its space, its hidden state, the room's memory of it
  app.vault.bus.on("folderRenamed", ({ from, to }) => {
    const move = (p) => (p === from ? to : String(p).startsWith(from + "/") ? to + p.slice(from.length) : p);
    const S = app.settings;
    for (const k of ["roomSpaces", "roomChat", "roomBoards", "roomAnswered"]) if (S[k]) {
      // the board chosen and the questions answered ("path#text") name paths too, also when the key stays
      const next = Object.fromEntries(Object.entries(S[k]).map(([f, v]) => [move(f), k === "roomBoards" ? move(v) : k === "roomAnswered" ? v.map(move) : v]));
      if (JSON.stringify(next) !== JSON.stringify(S[k])) app.setSetting(k, next);
    }
    if ((S.roomHidden || []).some((f) => move(f) !== f)) app.setSetting("roomHidden", S.roomHidden.map(move));
    for (const k of ["roomProject", "roomLast"]) if (S[k] && move(S[k]) !== S[k]) app.setSetting(k, move(S[k]));
    // its chats too: the Assistant's group for the workspace, and the notes it was given
    const groups = Array.isArray(S.aiThreadGroups) ? S.aiThreadGroups : [];
    if (groups.some((g) => (g.project && move(g.project) !== g.project) || (g.notes || []).some((n) => move(n) !== n)))
      app.setSetting("aiThreadGroups", groups.map((g) => ({ ...g, ...(g.project ? { project: move(g.project) } : {}), ...(g.notes ? { notes: g.notes.map(move) } : {}) })));
  });

  app.vault.bus.on("relinked", ({ path, content }) => editor.applyExternal(path, content));
  app.vault.bus.on("relinkLeftOut", ({ why }) => toast(`Links not updated: ${why}`, { kind: "error", ms: 7000 }));

  /* A file that is gone (deleted here or outside) takes its tabs along. Checked a moment after the
     vault's file list changes, so a rename - gone here, there a moment later - keeps its tab, and only a
     file the list had before counts: a tab of a file the list never held is left alone. */
  let filesSeen = new Set(app.vault.files.keys());
  const closeGoneFiles = debounce(() => {
    const now = new Set(app.vault.files.keys());
    for (let i = tabs.length - 1; i >= 0; i--) {
      const t = tabs[i];
      if (t.kind === "file" && filesSeen.has(t.path) && !now.has(t.path) && !app.vault.notes.has(t.path) && !(app.isGuest && app.isGuest(t.path))) closeTab(i);
    }
    filesSeen = now;
  }, 1500);
  app.vault.bus.on("structure", closeGoneFiles);

  app.vault.bus.on("removed", ({ path, external }) => {
    // deleted outside Leonote while words typed in it were still to be saved: they are kept, and offered back
    if (external && dirty.has(path)) {
      const ed = [editor, ...(split ? split.editors : []), ...roomEds].find((x) => x && x.has(path));
      const text = ed && ed.content(path);
      if (text != null) {
        host.rescueKeep(path, text).catch(() => {});
        toast(`“${basename(path)}” was deleted outside Leonote while you typed in it - your text is kept`, { ms: 15000, action: { label: "Bring it back", run: () => app.vault.write(path, text).then(() => { host.rescueDrop(path).catch(() => {}); app.openNote(path); }, (e) => toast("Could not bring it back: " + e + " - it is still kept and offered at the next start", { kind: "error" })) } });
      }
    }
    editor.forget(path);
    split.removed(path);
    dirty.delete(path);
    lastTyped.delete(path);
    const t = cur();
    const wasActive = t.kind === "note" && t.path === path;
    const keep = active >= 0 ? tabs[active] : null;
    const before = tabs.length;
    tabs = tabs.filter((x) => !(x.kind === "note" && x.path === path) || x === keep);
    active = keep ? tabs.indexOf(keep) : -1;
    if (wasActive) {
      // back to where you were before; show() drops the tab whose document is gone
      const gone = active;
      if (trailStep(-1) >= 0 && gone >= 0) { tabs.splice(gone, 1); active = -1; history(-1); }
      else show();
      if (external) toast(`“${basename(path)}” was deleted outside Leonote`);
    } else if (tabs.length !== before) renderTabs();
  });

  app.vault.bus.on("changed", (e) => {
    const n = app.vault.get(e.path);
    // EVERY write reaches the panes holding that note, not only the ones from
    // outside: the search page's replace, a link rewrite, an append to the
    // daily note. Without this the tab keeps the text from before the write,
    // and the next keystroke in it saves that copy back - quietly undoing the
    // replace. applyExternal is a no-op when the text already matches, which
    // is the case for a pane saving its own typing.
    if (n) {
      if (editor.has(e.path)) editor.applyExternal(e.path, n.content);
      for (const ed of [...split.editors, ...roomEds]) if (ed.has(e.path)) ed.applyExternal(e.path, n.content);
    }
    if (!e.external) return;
    if (e.path === app.currentPath()) paintTitle();
    record({ by: "external", text: `${e.isNew ? "created" : "edited"} “${basename(e.path)}”`, path: e.path });
  });

  /* ── activity (agents) ────────────────────────────────────────────────── */
  function record(entry) {
    app.activity.unshift({ ...entry, at: Date.now() });
    if (app.activity.length > 60) app.activity.length = 60;
    app.bus.emit("activity");
    statusSoon();
  }

  function describe(id, v, t) {
    const name = `“${short((t && t.text) || "task")}”`;
    if (v === null) return `removed a task`;
    if (v.text !== undefined && v.created !== undefined) return `added ${name}`;
    if (v.done === true) return `completed ${name}`;
    if (v.done === false) return `reopened ${name}`;
    if (v.deleted === true) return `trashed ${name}`;
    if (v.deleted === false) return `restored ${name}`;
    if (v.subtasks) return `updated steps of ${name}`;
    if (v.text !== undefined) return `renamed ${name}`;
    if (v.priority !== undefined) return `set priority of ${name}`;
    if (v.due_date !== undefined || v.start_date !== undefined) return `rescheduled ${name}`;
    return `updated ${name}`;
  }
  const short = (s) => { s = s.replace(/\s+/g, " "); return s.length > 48 ? s.slice(0, 47) + "…" : s; };

  /* ── external events ──────────────────────────────────────────────────── */
  let drawingsSeen = "";
  handlers = {
    "vault:changed": (changes) => {
      const conflicts = changes.filter((c) => c.content != null && dirty.has(c.path) && app.vault.get(c.path) && app.vault.get(c.path).content !== c.content);
      const rest = changes.filter((c) => !conflicts.includes(c));
      if (rest.length) app.vault.external(rest);
      for (const c of conflicts) {
        toast(`“${basename(c.path)}” changed on disk while you were typing - kept your version`, {
          ms: 12000,
          action: { label: "Use theirs", run: () => { app.replaceInEditors(c.path, c.content); app.vault.write(c.path, c.content, { expected: true }); } },
        });
      }
    },
    // a file double-clicked in Explorer while Leonote was already running
    "app:open-external": (p) => app.openFromOutside((p && p.paths) || []),
    // a sign-in in a web tab: keep it in the vault?
    "pw:offer": (o) => o && import("./passwords.js").then((m) => m.offerSave(app, o)),
    // a right-click on the YouTube video (WebView2 gives the place in device pixels)
    // WebView2 gives the place inside YouTube's frame, in device pixels: the frame's own corner is added
    "player:menu": (p) => { if (!p) return; const f = document.querySelector(".yt-layer iframe"); const r = f ? f.getBoundingClientRect() : { left: 0, top: 0 }; app.media.menuAt(r.left + p.x / devicePixelRatio, r.top + p.y / devicePixelRatio + 8); },
    // the embedded YouTube player's "Watch on YouTube": in the Player's browser (opening the Player first)
    "app:open-youtube": (url) => {
      if (!url) return;
      if (!app.playerOpenHere) app.openView("music");
      requestAnimationFrame(() => (app.playerOpenHere ? app.playerOpenHere(url) : app.openUrl(url)));
    },
    "vault:folders": (list) => app.vault.setFolders(list),
    "vault:files": (list) => {
      app.vault.setFiles(list);
      // a drawing saved: a note that embeds it shows it by its time, and no "structure" says so when only the time changed
      const sig = list.filter((f) => /\.(leocanvas|leopaint|leovector|excalidraw)$/i.test(f.path)).map((f) => f.path + f.mtime).join();
      if (sig !== drawingsSeen) { drawingsSeen = sig; refreshLinks(); }
      const t = cur();
      if (t.kind === "file" && !app.vault.files.has(t.path)) show();
      else if (fileView) fileView.external();
      for (const p of split.panes) if (p.current && p.current.kind === "file") {
        if (!app.vault.files.has(p.current.path)) p.render();
        else if (p.fileView) p.fileView.external();
      }
    },
    "tasks:patch": ({ patch, writers }) => {
      const agents = (writers || []).filter((w) => w !== "ui");
      const changed = app.tasks.applyPatch(patch, agents.length ? agents : null);
      if (!agents.length || !changed.size) return;
      const lines = [];
      for (const id of changed) {
        const v = patch[id];
        if (v && Object.keys(v).every((k) => k === "ord")) continue; // compaction renumbering
        lines.push(describe(id, v, app.tasks.get(id)));
      }
      if (!lines.length) return;
      const by = agents.join(", ");
      for (const l of lines.slice(0, 10)) record({ by, text: l });
      if (app.settings.agentToasts) {
        toast(`${by} ${lines[0]}${lines.length > 1 ? ` and ${lines.length - 1} more` : ""}`, { kind: "agent", action: { label: "View", run: () => app.openView("tasks") } });
      }
    },
    "habits:changed": (data) => { app.habits = data; app.bus.emit("habits"); },
    "app:capture": () => openPalette(app, "capture", { force: true }),
    "app:pomo": () => app.pomo.toggle(),
    // a shortcut pressed while a browser tab's page had the keys: played to the window as if pressed here
    "tabweb:focus": () => app.bus.emit("extpop:blur"),
    "extpop:zoom": (p) => { if (p && p.zoom) app.setSetting("webExtPopZoom", Math.round(p.zoom * 100)); },
    "extpop:resize": (p) => app.bus.emit("extpop:resize", p),
    "tabweb:video": (p) => app.bus.emit("tabweb:video", p),
    "tabweb:fullscreen": (p) => app.bus.emit("tabweb:fullscreen", p),
    "backup:progress": (p) => app.bus.emit("backup:progress", p),
    "tabweb:key": (k) => {
      if (!k || !k.code) return;
      const key = /^Key(.)$/.test(k.code) ? k.code.slice(3).toLowerCase() : /^Digit(.)$/.test(k.code) ? k.code.slice(5) : k.code;
      window.dispatchEvent(new KeyboardEvent("keydown", { code: k.code, key, ctrlKey: !!k.ctrl, altKey: !!k.alt, shiftKey: !!k.shift, bubbles: true, cancelable: true }));
    },
    // keys the webview never hands to the page (Ctrl+PageUp/PageDown) arrive here
    "app:command": (id) => {
      if (!NATIVE_KEYS.has(id)) return;
      app.bus.emit("native-key", id);
      if (document.activeElement && document.activeElement.closest(".key-test")) return; // just being checked
      if (recentKey(id, "native")) return; // the page saw the same press
      app.run(id);
    },
  };

  /* ── commands ─────────────────────────────────────────────────────────── */
  const inNote = () => !!app.currentPath();
  /** A note pasted into a mail or Google Docs: the text without its front matter, formatted where the box takes it. */
  async function copyFormatted(path) {
    const n = path && app.vault.get(path);
    if (!n) return;
    const [{ mdToHtml }, { bodyOf }] = await Promise.all([import("./boardmodel.js"), import("./docsview.js")]);
    const text = bodyOf(n.content || "");
    try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([mdToHtml(text, { maxChars: Infinity })], { type: "text/html" }) })]); }
    catch { try { await navigator.clipboard.writeText(text); } catch { return toast("Could not copy", { kind: "error" }); } }
    toast(`Copied “${basename(path).replace(/\.md$/i, "")}”, formatted`, { ms: 1800 });
  }

  // the note drawn on its own in a hidden frame, then the Windows print dialog (Microsoft Print to PDF saves a PDF);
  // the same safe drawing as boards, pictures from the vault included, web pictures held as everywhere else
  async function printNote(path) {
    const n = path && app.vault.get(path);
    if (!n) return;
    const { mdToHtml, escapeHtml } = await import("./boardmodel.js");
    const body = mdToHtml(editor.content(path) ?? n.content, { maxChars: Infinity, image: (t) => { try { return app.imageUrl ? app.imageUrl(t, path) : null; } catch { return null; } }, webPictures: app.settings.webPictures === "always" });
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-same-origin allow-modals"); // nothing in it runs; the print dialog may open
    f.style.cssText = "position:fixed;width:0;height:0;border:0;left:-9999px";
    f.srcdoc = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(n.title)}</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:46em;margin:2em auto;color:#111}img{max-width:100%}pre{white-space:pre-wrap}button{display:none}</style><h1>${escapeHtml(n.title)}</h1>${body}`;
    f.onload = () => { const w = f.contentWindow; w.addEventListener("afterprint", () => f.remove()); setTimeout(() => w.print(), 300); };
    document.body.append(f);
  }
  // the group of the current tab, or the one the toggle just folded away
  const foldTarget = () => TG.groupOf(groups, active >= 0 ? tabs[active] : null) || groupById(lastFolded);
  const cycle = (d) => {
    if (!tabs.length) return;
    activate(active < 0 ? (d > 0 ? 0 : tabs.length - 1) : (active + d + tabs.length) % tabs.length);
  };
  app.commands = [
    { id: "switcher", name: "Quick switcher", keys: "Ctrl O", icon: "search", run: () => openPalette(app, "switcher") },
    { id: "commands", name: "Command palette", keys: "Ctrl P", icon: "command", run: () => openPalette(app, "commands") },
    { id: "search", name: "Search all notes", keys: "Ctrl Shift F", icon: "search", run: () => openPalette(app, "search") },
    { id: "capture", name: "Quick capture", keys: "Ctrl Shift Space", icon: "bolt", run: () => openPalette(app, "capture") },
    { id: "new-note", name: "New note", keys: "Ctrl N", icon: "filePlus", run: () => app.newNote({}) },
    { id: "new-sketch", name: "New sketch", icon: "brush", run: () => newSketch({ anchor: $("#tabs .tab-new") }) },
    // Sketch is vector on an endless board; Draw is a raster canvas with
    // layers. The sheet explains both and picks the canvas size (paintmode.js).
    { id: "new-drawing", name: "New drawing…", icon: "palette", run: () => import("./paintmode.js").then((m) => m.newDrawing(app, { anchor: $("#tabs .tab-new") })) },
    { id: "new-video", name: "New video project (reels, memes)", icon: "film", when: () => !(app.settings.navHidden || []).includes("video"), run: () => import("./videoedit.js").then((m) => m.newVideo(app)) },
    { id: "studio-photo", name: "Open a photo in Studio…", icon: "image", run: () => import("./paintexport.js").then((m) => m.libraryDialog(app, { tab: "photos" })) },
    { id: "studio-library", name: "Drawings and photos…", icon: "grid", run: () => import("./paintexport.js").then((m) => m.libraryDialog(app, {})) },

    { id: "insert-template", name: "Insert template…", keys: "Ctrl Alt T", icon: "clipboard", when: inNote, run: () => app.zettel.insertTemplate() },
    { id: "new-from-template", name: "New note from template…", icon: "filePlus", run: () => app.zettel.newFromTemplate() },
    { id: "zettel-idea", name: "New idea note", icon: "lightbulb", run: () => app.zettel.newIdea() },
    { id: "zettel-reference", name: "New reference note", icon: "book", run: () => app.zettel.newReference() },
    { id: "zettel-moc", name: "New Map of Content", icon: "compass", run: () => app.zettel.newMoc({}) },
    { id: "zettel-extract", name: "Make a note from the selection", icon: "sparkles", when: inNote, run: () => app.zettel.extract() },
    { id: "zettel-setup", name: "Set up the Zettelkasten folders and templates", icon: "brain", run: () => app.zettel.setup() },

    { id: "picture-layout", name: "Picture layout: switch (column, wide, collage)", icon: "image", run: () => {
      const order = ["column", "wide", "collage"];
      const next = order[(order.indexOf(app.settings.imageLayout || "column") + 1) % order.length];
      app.setSetting("imageLayout", next);
      toast(`Pictures: ${{ column: "in the text column", wide: "wide", collage: "full-width collage" }[next]}${noteLayout ? " (this note sets its own)" : ""}`, { ms: 2000 });
    } },
    { id: "insert-sketch", name: "Insert a new sketch here", icon: "brush", run: () => { if (inNote()) newSketch({ view: editor.view }); else newSketch({}); } },
    { id: "insert-drawing", name: "Insert a new drawing here", icon: "palette", run: () => import("./paintmode.js").then((m) => m.newDrawing(app, { mode: "draw", view: inNote() ? editor.view : null, at: inNote() ? editor.view.state.selection.main.head : null })) },
    { id: "new-board", name: "New research board", icon: "grid", run: () => app.newBoard({ notes: inNote() ? [editor.path] : [] }) },
    { id: "board-add-note", name: "Add this note to a research board…", icon: "grid", run: () => {
      if (!inNote()) return toast("Open a note first");
      const list = app.boards();
      menu(innerWidth / 2 - 120, 120, [
        { header: "Add to board" },
        ...list.map((b) => ({ label: basename(b).replace(/\.canvas$/i, ""), icon: "grid", run: () => app.addToBoard(b, [editor.path]) })),
        list.length ? "sep" : null,
        { label: "New board", icon: "plus", run: () => app.newBoard({ notes: [editor.path] }) },
      ]);
    } },
    { id: "open-source", name: "Open this note's source", icon: "globe", when: () => inNote(), run: () => {
      // a reference note's "- Source: url", or a workspace source note's "source:" in its front matter
      const text = editor.content(editor.path) || "";
      const m = /^source:\s*(\S+)/im.exec(text) || /^- Source:\s*(\S+)/m.exec(text);
      if (m && /^https?:\/\//i.test(m[1])) app.followLink(m[1]); else toast("This note has no source address", { ms: 2400 });
    } },
    { id: "view-images", name: "View the pictures in this note", keys: "Ctrl Shift I", icon: "image", run: () => { if (inNote()) viewImages(editor.view); } },
    { id: "open-external", name: "Open a file from your computer…", keys: "Ctrl Shift O", icon: "outside", run: () => app.pickExternal() },
    { id: "new-folder", name: "New folder", keys: "Ctrl Shift N", icon: "folderPlus", run: () => { app.setSetting("sidebar", true); sidebar.newFolderHere(); } },
    { id: "daily", name: "Open today's note", keys: "Alt D", icon: "note", run: () => app.openDaily() },
    { id: "yesterday", name: "Open yesterday's note", icon: "calendar", run: () => app.openDaily(dayKey(addDays(new Date(), -1))) },
    { id: "tomorrow", name: "Open tomorrow's note", icon: "calendar", run: () => app.openDaily(dayKey(addDays(new Date(), 1))) },
    { id: "welcome", name: "Welcome and the main keys", icon: "book", run: async () => {
      // Leonote's own Welcome note, if the vault has it - an Obsidian vault's Welcome.md is Obsidian's; then (or once
      // it was deleted) its text is shown, nothing written into the vault
      if (ownWelcome()) return app.openNote("Welcome.md");
      const text = await host.welcomeText().catch(() => "");
      const { openText } = await import("./support.js");
      openText("Welcome and the main keys", "data:,", "", text);
    } },
    { id: "daily-of", name: "Open the note of a day…", icon: "calendar", run: async () => { const r = await askDialog("Open the note of a day", [{ key: "d", label: "Day", type: "date", value: dayKey() }], { ok: "Open" }); if (r && /^\d{4}-\d{2}-\d{2}$/.test(r.d)) app.openDaily(r.d); } },
    { id: "home", name: "Go to Home", keys: "Alt 1", icon: "home", run: () => app.openView("home") },
    { id: "tasks", name: "Go to Tasks", keys: "Alt 2", icon: "checkSquare", run: () => app.openView("tasks") },
    { id: "docs", name: "Go to Docs - ready texts to copy", icon: "clipboard", run: () => app.openView("docs") },
    { id: "phone", name: "Phone - photos and files on a phone plugged in by USB", icon: "phone", run: () => app.openView("phone") },
    { id: "space", name: "Disk space - what takes the room, in the vault or anywhere on the PC", icon: "chart", run: () => app.openView("space") },
    { id: "habits", name: "Go to Habits", keys: "Alt 3", icon: "flame", run: () => app.openView("habits") },
    { id: "calendar", name: "Go to Calendar", keys: "Alt C", icon: "calendar", run: () => app.openView("calendar") },
    { id: "fit", name: "Go to Workout", keys: "Alt W", icon: "dumbbell", run: () => app.openView("fit") },
    { id: "fit-program", name: "Workout: Program (the book)", icon: "book", run: () => { app.openView("fit"); views.fit.show({ tab: "program" }); } },
    { id: "fit-food", name: "Workout: Food", icon: "apple", run: () => { app.openView("fit"); views.fit.show({ tab: "food" }); } },
    { id: "fit-fasting", name: "Workout: Fasting", icon: "clock", run: () => { app.openView("fit"); views.fit.show({ tab: "fasting" }); } },
    { id: "focus", name: "Go to Focus (life priorities)", keys: "Alt 5", icon: "focus", run: () => app.openView("focus") },
    { id: "jev-suggest", name: "Suggest a folder and tags for this note (Jev)", icon: "sparkles", run: () => app.jev.suggestNote(app.lastNotePath && app.lastNotePath()) },
    { id: "ai-quick", name: "Ask or do anything - the AI box", keys: "Ctrl Shift A", icon: "sparkles", run: () => import("./aihome.js").then((m) => m.openQuick(app)) },
    { id: "skills", name: "Skills: run one, see what they did, make a new one", icon: "bolt", run: () => app.skills.panel() },
    { id: "skill-ask", name: "Ask for something - Jev picks the skill that does it", icon: "sparkles", run: () => app.skills.ask() },
    { id: "skill-new", name: "New skill", icon: "plus", run: () => app.skills.newSkill() },
    { id: "proposals", name: "Review the edits agents proposed", icon: "sparkles", run: () => app.proposals.review() },
    { id: "jev-playground", name: "Jev playground: ask it anything, copy the request", icon: "sparkles", run: () => app.jev.playground() },
    { id: "timer", name: "Go to Timer", keys: "Alt 6", icon: "clock", run: () => app.openView("timer") },
    // found only by scrolling the Timer page before: the palette leads there too
    { id: "desk-breaks", name: "Breaks that move you - exercises, eyes and water in Timer breaks (presets, your own)", icon: "dumbbell", run: () => { app.openView("timer"); requestAnimationFrame(() => { const c = document.querySelector(".db-panel"); if (c) c.scrollIntoView({ block: "start", behavior: "smooth" }); }); } },
    { id: "desk-break-now", name: "Take a break now - an exercise, eyes, water", icon: "dumbbell", run: () => app.deskBreaks && app.deskBreaks.start(true) },
    { id: "pomo-toggle", name: "Start / pause timer", keys: "Alt P", icon: "clock", run: () => app.pomo.toggle() },
    { id: "pomo-skip", name: "Skip focus timer to next phase", icon: "forward", run: () => app.pomo.skip() },
    { id: "pomo-reset", name: "Reset focus timer", icon: "undo", run: () => app.pomo.reset() },
    { id: "graph", name: "Open graph", keys: "Alt 4", icon: "graph", run: () => app.openView("graph") },
    { id: "room", name: "Workspace room: a workspace as a whole", keys: "Alt R", icon: "briefcase", run: () => app.openRoom() },
    { id: "room-make", name: "Make a folder a workspace…", icon: "folderPlus", run: () => app.pickWorkspaceFolder() },
    { id: "music", name: "Open player", keys: "Alt 7", icon: "music", run: () => app.openView("music") },
    { id: "project-find", name: "Project: find and replace in this space's project", keys: "Ctrl Alt F", icon: "search", run: () => { app.openView("project"); views.project.show({ tab: "find" }); } },
    { id: "project-files", name: "Project: go to file", keys: "Ctrl Alt O", icon: "file", run: () => { app.openView("project"); views.project.show({ tab: "files" }); } },
    { id: "project-settings", name: "Project: this project's settings", icon: "settings", run: () => { app.openView("project"); views.project.show({ settings: true }); } },
    { id: "project-git", name: "Project: git - changes, commit, push, pull", keys: "Ctrl Alt K", icon: "code", run: () => { app.openView("project"); views.project.show({ tab: "git" }); } },
    { id: "assistant", name: "Assistant: ask a model about your notes", keys: "Alt 0", icon: "sparkles", run: () => app.askAssistant() },
    { id: "assistant-beside", name: "Assistant: open beside this note", icon: "columns", run: () => app.assistantBeside() },
    { id: "assistant-summarise", name: "Assistant: summarise this note or selection", icon: "sparkles", run: () => app.askAssistant({ prompt: "Summarise this in a few plain sentences, then the key points as a short list." }) },
    { id: "print-note", name: "Print this note or save it as PDF…", icon: "file", when: inNote, run: () => printNote(app.currentPath()) },
    { id: "copy-formatted", name: "Copy this note, formatted (for mail or Docs)", icon: "clipboard", when: inNote, run: () => copyFormatted(app.currentPath()) },
    { id: "read-script", name: "Read this note as a script (teleprompter window)", icon: "play", when: inNote, run: () => app.readAsScript(app.currentPath()) },
    { id: "assistant-actions", name: "Assistant: find the action items here", icon: "sparkles", run: () => app.askAssistant({ prompt: "List every action item in this as Markdown checkboxes (- [ ] ...), most urgent first. Only what the text supports." }) },
    { id: "search-all", name: "Search in all files", keys: "Alt 8", icon: "search", run: () => app.openSearch({}) },
    { id: "search-pc", name: "Search this PC by file name", icon: "monitor", run: () => app.openSearch({ scope: "pc" }) },
    { id: "web-open", name: "Open a web page…", icon: "globe", run: (e) => import("./webpanel.js").then((m) => m.webMenu(app)) },
    { id: "web-add", name: "Add a web page from a pasted address…", icon: "link", run: () => import("./webpanel.js").then((m) => m.promptForUrl(app)) },
    { id: "web", name: "Web pages (the old view)", keys: "Alt 9", icon: "globe", run: () => app.openView("web") },
    { id: "settings", name: "Settings", keys: "Ctrl ,", icon: "settings", run: () => app.openView("settings") },
    { id: "duplicate-tab", name: "Duplicate this tab", keys: "Ctrl D", icon: "layers", run: () => duplicateTab() },
    { id: "passwords", name: "Passwords (behind a master password)", icon: "shield", run: () => import("./passwords.js").then((m) => m.openPasswords(app)) },
    { id: "tags", name: "Browse tags", icon: "hash", run: () => openPalette(app, "tags") },
    { id: "check-links", name: "Check links - notes renamed or gone outside Leonote", icon: "link", run: () => app.noteIds.check() },
    { id: "random", name: "Open a random note", icon: "sparkles", run: () => { const all = [...app.vault.notes.keys()]; if (all.length) app.openNote(all[(Math.random() * all.length) | 0]); } },

    { id: "new-tab", name: "New tab - the start page, and a browser", keys: "Ctrl T", icon: "plus", run: () => app.newWebTab("") },
    { id: "new-tab-panel", name: "Quick new… panel (right-click the +)", icon: "plus", run: () => openNewTab(app, tabsEl.querySelector(".tab-new")) },
    { id: "web-address", name: "Browser tab: go to the address bar", keys: "Ctrl L", icon: "globe", when: () => cur().kind === "web", run: () => webTab && webTab.focusAddress() },
    { id: "web-bookmarks", name: "Bookmarks", icon: "star", run: () => { if (cur().kind !== "web") app.newWebTab(""); webTab.library("bookmarks"); } },
    { id: "web-history", name: "Browsing history", icon: "clock", run: () => { if (cur().kind !== "web") app.newWebTab(""); webTab.library("history"); } },
    // before only on a tab's right-click
    { id: "close-others", name: "Close other tabs (pinned stay)", icon: "x", when: () => active >= 0 && tabs.length > 1, run: () => closeWhere((x, k) => k === active || x.pinned, tabs[active]) },
    { id: "close-right", name: "Close tabs to the right", icon: "x", when: () => active >= 0 && active < tabs.length - 1, run: () => closeWhere((x, k) => k <= active || x.pinned, tabs[active]) },
    { id: "close-tab", name: "Close tab", keys: "Ctrl W", icon: "x", run: () => {
      if (splitFocused && split.isOpen) return split.closeCurrent();
      if (active >= 0) closeTab(active);
    } },
    { id: "split-web", name: "Split view: browser in the side pane", icon: "globe", run: () => split.openWeb("") },
    { id: "split-toggle", name: "Split view: open or close", keys: "Ctrl Alt \\", icon: "columns", run: () => toggleSplit() },
    { id: "split-move", name: "Split view: move this tab to the side", icon: "columns", when: () => active >= 0 && canSplit(tabs[active]), run: () => moveToSplit(active) },
    { id: "split-focus", name: "Split view: focus the other pane", keys: "Ctrl Alt →", icon: "columns", when: () => split.isOpen, run: () => (splitFocused ? app.focusMain() : split.focus()) },
    { id: "scroll-recorder", name: "Debug: Record scroll jumps (start / stop) - a report for fixing them", icon: "chart", run: () => scrollRecorder() },
    // tools for finding a fault, all under "Debug:" - typing "debug" lists them
    { id: "debug-report", name: "Debug: Copy a bug report (version, Windows, sizes, the last errors)", icon: "clipboard", run: () => app.diagnostics().then((t) => navigator.clipboard.writeText(t)).then(() => toast("Copied - paste it into your report", { ms: 2500 })) },
    { id: "pin-tab", name: "Pin / unpin current tab (stays in view)", icon: "pin", when: () => active >= 0, run: () => setPinned(active, !tabs[active].pinned) },
    { id: "minimize-tab", name: "Minimize / restore current tab (icon only)", icon: "shrink", when: () => active >= 0, run: () => { if (!tabs[active].pinned) setMini(active, !tabs[active].mini); else toast("A pinned tab is already small - unpin it first", { ms: 2500 }); } },
    { id: "group-new", name: "New tab group from current tab", keys: "Ctrl Alt G", icon: "plus", when: () => active >= 0 && !tabs[active].pinned, run: () => newGroupFrom(active) },
    { id: "group-toggle", name: "Toggle current tab group collapsed", keys: "Ctrl Alt Shift G", icon: "shrink", when: () => !!foldTarget(), run: () => toggleGroup(foldTarget()) },
    { id: "group-close", name: "Close current tab group", icon: "x", when: () => !!foldTarget(), run: () => closeGroup(foldTarget()) },
    { id: "spaces", name: "Spaces…", icon: "sparkles", run: () => spacesUi.open() },
    { id: "next-space", name: "Next space", keys: "Alt PageDown", icon: "forward", run: () => spacesApi.step(1) },
    { id: "prev-space", name: "Previous space", keys: "Alt PageUp", icon: "back", run: () => spacesApi.step(-1) },
    { id: "space-back", name: "Back to the space you were in", keys: "Alt `", icon: "undo", run: () => spacesApi.back() },
    { id: "reopen-tab", name: "Reopen closed tab", keys: "Ctrl Shift T", icon: "undo", run: () => reopenTab() },
    { id: "next-tab", name: "Next tab", keys: "Ctrl Tab", icon: "forward", run: () => cycle(1) },
    { id: "prev-tab", name: "Previous tab", keys: "Ctrl Shift Tab", icon: "back", run: () => cycle(-1) },
    // a view with its own way back (Disk space's folders) steps through that first
    { id: "back", name: "Go back", keys: "Alt ←", icon: "back", run: () => (app.localStep && app.localStep(-1)) || history(-1) },
    { id: "history", name: "History: jump back to…", icon: "back", run: () => trailMenu(-1, $("[data-cmd=back]") || $("#tabs")) },
    { id: "filter-files", name: "Filter files in the sidebar", keys: "Alt F", icon: "search", run: () => { app.setSetting("sidebar", true); app.filterFiles && app.filterFiles(); } },
    { id: "forward", name: "Go forward", keys: "Alt →", icon: "forward", run: () => (app.localStep && app.localStep(1)) || history(1) },

    { id: "toggle-sidebar", name: "Toggle sidebar", keys: "Ctrl \\", icon: "sidebar", run: () => app.setSetting("sidebar", !app.settings.sidebar) },
    { id: "toggle-right", name: "Toggle details panel", keys: "Ctrl Shift \\", icon: "panelRight", run: () => app.setSetting("rightPanel", !app.settings.rightPanel) },
    { id: "zen", name: "Focus mode", keys: "Ctrl Shift Enter", icon: "focus", run: () => { if ($("#app").classList.toggle("is-zen")) toast("Focus mode · Esc brings everything back", { ms: 2600 }); } },
    { id: "toggle-preview", name: "Toggle live preview / source", keys: "Ctrl Shift E", icon: "eye", run: () => { app.setSetting("livePreview", !app.settings.livePreview); status(); } },
    { id: "theme", name: "Toggle light / dark theme", icon: "moon", run: () => app.setSetting("theme", document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
    { id: "zoom-in", name: "Larger text", keys: "Ctrl =", icon: "plus", run: () => app.setSetting("fontSize", clamp(app.settings.fontSize + 1, 12, 24)) },
    { id: "zoom-out", name: "Smaller text", keys: "Ctrl -", icon: "minus", run: () => app.setSetting("fontSize", clamp(app.settings.fontSize - 1, 12, 24)) },
    { id: "zoom-reset", name: "Reset text size", keys: "Ctrl 0", icon: "square", run: () => app.setSetting("fontSize", 16) },
    { id: "fullscreen", name: "Toggle fullscreen", keys: "F11", icon: "square", run: async () => host.win.setFullscreen(!(await host.win.isFullscreen())) },
    { id: "quit", name: "Quit Leonote", keys: "Ctrl Q", icon: "x", run: () => host.requestQuit() },
    { id: "on-top", name: "Toggle keep on top", icon: "pin", run: () => toggleOnTop() },
    { id: "levels", name: "Levels, ranks, streak and badges", icon: "trophy", run: () => app.openLevels() },
    // With no taskbar entry a minimized window would be parked in a screen
    // corner, so "minimize" sends it to the tray instead.
    { id: "to-tray", name: "Minimize to tray", icon: "minus", run: () => { flushAll(); saveSettings.flush(); host.win.hide().catch((e) => toast("Could not minimize: " + e, { kind: "error" })); } },
    { id: "zoom-window-reset", name: "Reset window zoom (Ctrl+scroll zooms)", icon: "square", run: () => app.resetZoom() },
    { id: "claude-import", name: "Import Claude Code sessions", icon: "download", run: () => app.importClaude() },
    { id: "compact", name: "Toggle compact mode", keys: "Ctrl Shift C", icon: "shrink", run: () => setCompact(!app.settings.compact) },

    { id: "rename", name: "Rename note", keys: "F2", icon: "edit", when: inNote, run: () => { titleEl.focus(); titleEl.select(); } },
    { id: "move", name: "Move note to…", keys: "Ctrl Shift M", icon: "folder", when: inNote, run: () => openPalette(app, "move", { path: app.currentPath() }) },
    { id: "pin", name: "Pin / unpin note", icon: "pin", when: inNote, run: () => app.togglePin(app.currentPath()) },
    { id: "copy-link", name: "Copy link to note", icon: "link", when: inNote, run: () => { navigator.clipboard.writeText(`[[${app.vault.linkText(app.currentPath())}]]`); toast("Link copied"); } },
    { id: "reveal", name: "Show note in Explorer", icon: "reveal", when: inNote, run: () => app.reveal(app.currentPath()) },
    { id: "reveal-sidebar", name: "Reveal note in sidebar", icon: "folder", when: inNote, run: () => { app.setSetting("sidebar", true); sidebar.reveal(app.currentPath()); } },
    { id: "note-versions", name: "Restore an earlier version of this note…", icon: "undo", when: inNote, run: () => app.openVersions(app.currentPath()) },
    { id: "note-erase-history", name: "Erase every trace of this note (its versions, trash copies)…", icon: "trash", when: inNote, run: () => import("./noteversions.js").then((m) => m.eraseTraces(app, app.currentPath())) },
    { id: "note-delete-forever", name: "Delete this note for good, with its history…", icon: "trash", when: inNote, run: () => import("./noteversions.js").then((m) => m.eraseTraces(app, app.currentPath(), { andNote: true })) },
    { id: "trash-note", name: "Move note to trash", icon: "trash", when: inNote, run: () => app.trashNote(app.currentPath()) },
    { id: "gather-media", name: "Gather pictures, videos and songs of a folder into the media folders…", icon: "image", run: () => app.gatherMedia() },
    { id: "trash-view", name: "View trash - restore or delete for good", icon: "trash", run: () => app.openTrash() },
    { id: "tidy-files", name: "Tidy up: files no note uses, embeds pointing at nothing", icon: "search", run: () => app.tidyFiles() },
    { id: "trash-undo", name: "Bring back what was just deleted", icon: "undo", run: async () => { if (!(await app.undoTrash())) toast("Nothing was deleted in this session - the trash has the rest", { ms: 3200, action: { label: "View trash", run: () => app.openTrash() } }); } },
    { id: "find", name: "Find in note", keys: "Ctrl F", icon: "search", when: inNote, run: () => editor.run("find") },
    { id: "task", name: "Toggle checkbox", keys: "Ctrl Enter", icon: "checkSquare", when: inNote, run: () => editor.run("task") },
    { id: "sort-lines", name: "Sort the selected lines A→Z", icon: "list", when: inNote, run: () => editor.run("sort-lines") },
    { id: "done-bottom", name: "Ticked checkboxes to the bottom (selected lines)", icon: "check", when: inNote, run: () => editor.run("done-bottom") },
    { id: "bold", name: "Bold", keys: "Ctrl B", icon: "edit", when: inNote, run: () => editor.run("bold") },
    { id: "italic", name: "Italic", keys: "Ctrl I", icon: "edit", when: inNote, run: () => editor.run("italic") },
    { id: "strike", name: "Strikethrough", keys: "Ctrl Shift X", icon: "edit", when: inNote, run: () => editor.run("strike") },
    // ==yellow== is plain Markdown; the rest are <mark class="hl-…">, which
    // Obsidian renders as a highlight too. Same colour again = take it off.
    { id: "highlight", name: "Highlight (yellow)", keys: "Ctrl Shift H", icon: "pen", when: inNote, run: () => editor.run("hl-yellow") },
    ...HL_COLORS.slice(1).map((c) => ({ id: "highlight-" + c, name: "Highlight: " + c, icon: "pen", when: inNote, run: () => editor.run("hl-" + c) })),
    { id: "highlight-none", name: "Highlight: remove", icon: "x", when: inNote, run: () => editor.run("hl-none") },
    { id: "code", name: "Inline code", keys: "Ctrl E", icon: "edit", when: inNote, run: () => editor.run("code") },
    { id: "link", name: "Insert link", keys: "Ctrl K", icon: "link", when: inNote, run: () => editor.run("link") },
    { id: "h1", name: "Heading 1", keys: "Ctrl Alt 1", icon: "edit", when: inNote, run: () => editor.run("h1") },
    { id: "h2", name: "Heading 2", keys: "Ctrl Alt 2", icon: "edit", when: inNote, run: () => editor.run("h2") },
    { id: "h3", name: "Heading 3", keys: "Ctrl Alt 3", icon: "edit", when: inNote, run: () => editor.run("h3") },
  ];
  app.commands.push(...supportCommands(app));
  // only what is on this computer; no plugin, nothing more happens. A plugin that freezes the page at start would
  // freeze every start: a mark stays while they start, and a start that finds it leaves them off and says so
  const startPlugins = () => {
    try { localStorage.setItem(PLUGINS_STARTING, "1"); } catch {}
    app.plugins.hold(false);
    Promise.resolve(app.plugins.refresh()).finally(() => setTimeout(() => { try { localStorage.removeItem(PLUGINS_STARTING); } catch {} }, 10000));
  };
  app.startPlugins = startPlugins;
  let pluginsStuck = false;
  try { pluginsStuck = !!localStorage.getItem(PLUGINS_STARTING); localStorage.removeItem(PLUGINS_STARTING); } catch {}
  setTimeout(async () => {
    const on = pluginsStuck && (await app.host.pluginList().catch(() => [])).some((r) => r.on);
    if (!on) return startPlugins();
    app.plugins.hold(true); // Settings › Plugins lists them without starting them
    toast("Plugins were left off: the last start did not get past them. A plugin may be at fault - Settings › Plugins can turn it off.", { ms: 15000, action: { label: "Start them now", run: startPlugins } });
  }, 1500);
  setTimeout(() => maybeAskSupport(app), 8000);
  app.run = (id) => { const c = app.commands.find((x) => x.id === id); if (c && (!c.when || c.when())) c.run(); };

  // Physical key codes, not characters: shortcuts keep working on a
  // Ukrainian (or any non-Latin) keyboard layout.
  const KEYMAP = {
    "Ctrl+KeyO": "switcher", "Ctrl+KeyP": "commands", "Ctrl+Shift+KeyF": "search", "Ctrl+Alt+KeyF": "project-find", "Ctrl+Alt+KeyO": "project-files", "Ctrl+Alt+KeyK": "project-git", "Ctrl+Shift+Space": "capture",
    "Ctrl+KeyN": "new-note", "Ctrl+Shift+KeyI": "view-images", "Ctrl+Shift+KeyN": "new-folder", "Ctrl+Shift+KeyO": "open-external", "Alt+KeyD": "daily", "Alt+KeyC": "calendar", "Alt+KeyW": "fit", "Alt+Digit1": "home", "Alt+Digit2": "tasks", "Alt+Digit3": "habits", "Alt+Digit4": "graph", "Alt+Digit5": "focus", "Alt+Digit6": "timer", "Alt+Digit7": "music", "Alt+Digit8": "search-all", "Alt+Digit9": "web", "Alt+Digit0": "assistant", "Alt+KeyR": "room", "Alt+KeyP": "pomo-toggle",
    "Ctrl+Alt+KeyT": "insert-template", "Ctrl+KeyL": "web-address",
    "Ctrl+Comma": "settings", "Ctrl+KeyD": "duplicate-tab", "Ctrl+KeyT": "new-tab", "Ctrl+KeyW": "close-tab", "Ctrl+Shift+KeyT": "reopen-tab", "Ctrl+Alt+KeyG": "group-new", "Ctrl+Shift+Alt+KeyG": "group-toggle",
    "Ctrl+Tab": "next-tab", "Ctrl+Shift+Tab": "prev-tab", "Ctrl+PageDown": "next-tab", "Ctrl+PageUp": "prev-tab", "Alt+ArrowLeft": "back", "Alt+ArrowRight": "forward",
    "Ctrl+Backslash": "toggle-sidebar", "Ctrl+Shift+Backslash": "toggle-right", "Ctrl+Shift+Enter": "zen", "Ctrl+Shift+KeyE": "toggle-preview", "Ctrl+Alt+Backslash": "split-toggle", "Ctrl+Alt+ArrowRight": "split-focus", "Ctrl+Alt+ArrowLeft": "split-focus", "Alt+KeyF": "filter-files",
    "Ctrl+Equal": "zoom-in", "Ctrl+NumpadAdd": "zoom-in", "Ctrl+Minus": "zoom-out", "Ctrl+NumpadSubtract": "zoom-out", "Ctrl+Digit0": "zoom-reset",
    "F11": "fullscreen", "F2": "rename", "Ctrl+Shift+KeyM": "move", "Ctrl+KeyQ": "quit", "Ctrl+Shift+KeyC": "compact", "Ctrl+Shift+KeyA": "ai-quick", "Alt+PageDown": "next-space", "Alt+PageUp": "prev-space", "Alt+Backquote": "space-back",
  };

  // A press can reach us twice: from the page and from the window's native
  // handler (Ctrl/Alt + PageUp/PageDown). The second one within a moment is
  // the same press.
  const NATIVE_KEYS = new Set(["next-tab", "prev-tab", "next-space", "prev-space"]);
  let lastKey = { id: "", t: 0, src: "" };
  const recentKey = (id, src) => {
    const now = performance.now();
    // only a press seen from the other source counts as the same press;
    // quick repeats from one source are real presses
    const dup = lastKey.id === id && lastKey.src !== src && now - lastKey.t < 120;
    lastKey = { id, t: now, src };
    return dup;
  };
  // PageUp/PageDown by name: with NumLock off the keypad sends them with a
  // Numpad9/Numpad3 code
  const comboOf = (e) => {
    const code = e.key === "PageUp" || e.key === "PageDown" ? e.key : e.code;
    return ((e.ctrlKey || e.metaKey) ? "Ctrl+" : "") + (e.shiftKey ? "Shift+" : "") + (e.altKey ? "Alt+" : "") + code;
  };
  app.describeKey = (e) => { const combo = comboOf(e); return { combo: combo.replace(/\+/g, " + ").replace(/Key([A-Z])/, "$1").replace(/Digit(\d)/, "$1"), id: KEYMAP[combo] || null }; };

  window.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest(".key-test")) return;
    const mod = e.ctrlKey || e.metaKey;
    const combo = comboOf(e);
    // inside a board, a drawing, Studio, a PDF or a video project their own keys win - only the ones they really use:
    // zoom and grouping everywhere there; Studio's Ctrl+T transform, Ctrl+Shift+N layer, Ctrl+Shift+E export,
    // Ctrl+Shift+I invert; Ctrl+1 actual size in Studio and Sketch; Alt+arrows in Studio and the video editor
    const at = (sel) => !!(e.target.closest && e.target.closest(sel));
    const inCanvas = at(".fv-board-host");
    const canvasKey = (id) => inCanvas && (/^(zoom-|group-|insert-template)/.test(id)
      || (at(".pt") && /^(new-tab|new-folder|toggle-preview|view-images)$/.test(id))
      || (at(".pt, .ve") && /^(back|forward)$/.test(id)));
    if (mod && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code) && !at(".pt, .sk")) {
      e.preventDefault();
      const n = +e.code.slice(5);
      return activate(n === 9 ? tabs.length - 1 : n - 1);
    }
    let id = KEYMAP[combo];
    // zoom by the character the key types, not where it sits: German + and - are elsewhere, Czech = is on the minus key
    if (mod && !e.altKey && !/^Numpad/.test(e.code)) {
      if (e.key === "+" || e.key === "=") id = "zoom-in";
      else if (e.key === "-") id = "zoom-out";
    }
    if (!id) {
      if (e.key === "Escape" && $("#app").classList.contains("is-zen") && !document.querySelector(".pal-back, .menu")) $("#app").classList.remove("is-zen");
      return;
    }
    // Ctrl+L is the address bar only in a browser tab: everywhere else it stays the editor's own
    if (id === "web-address" && cur().kind !== "web") return;
    // AltGr is Ctrl+Alt to Windows: on many layouts it types a letter or a bracket ([ on Czech AltGr+F, ó on Polish
    // AltGr+O), which no Ctrl+Alt shortcut may take
    if (e.getModifierState && e.getModifierState("AltGraph")) return;
    if (canvasKey(id)) return;
    // a command that cannot run here (one for notes, outside a note) leaves its key to whatever has the focus
    const cmd = app.commands.find((x) => x.id === id);
    if (cmd && cmd.when && !cmd.when()) return;
    // after a click on a row in the tree, F2 renames it there (the tree takes it): click, F2, type, Enter, next
    if (id === "rename" && (!inNote() || (app.sidebarArmed && app.sidebarArmed()))) return;
    // Ctrl+D is the editors' own where they use it (a note's next match, a clip's copy, letting go of a selection)
    if (id === "duplicate-tab" && e.target.closest && e.target.closest(".cm-editor, input, textarea, select, [contenteditable], .ve, .ie, .pt, .fv-board-host, .fv-office-host")) return;
    // inside a drawing or a board, zoom keys zoom the canvas, not the app
    if (/^zoom-/.test(id) && e.target.closest && e.target.closest(".fv-board-host")) return;
    // ...and G keys group shapes there (AltGr is let through further up)
    if (/^(group-|insert-template)/.test(id) && e.target.closest && e.target.closest(".fv-board-host")) return;
    if (NATIVE_KEYS.has(id) && recentKey(id, "page")) { e.preventDefault(); return; }
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    app.run(id);
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const t = cur();
    if (t.kind !== "file") return;
    const f = app.vault.files.get(t.path);
    if (!f || f.kind === "text" || /\.(docx|xlsx|canvas|leovideo|leocanvas|leopaint|leovector|excalidraw)$/i.test(t.path)) return;
    const a = document.activeElement;
    if (a && (a.closest("input, textarea, [contenteditable], #sidebar, .menu, .pal-back, .img-viewer, .dlg-back"))) return;
    if (document.querySelector(".pal-back, .dlg-back, .img-viewer")) return;
    e.preventDefault();
    app.askTrash([[t.path, "file"]], { forever: e.shiftKey });
  });

  // a drag held near the top or bottom of a list that scrolls (tasks in the compact window, the file tree):
  // the list scrolls, faster nearer the edge - the browser does it only for the page, not for a list inside it
  // dragover only sets the speed; the list glides a little every frame, easing in, and stops once
  // dragovers stop coming (the pointer left, the drag ended) - not a jump per event
  const listGlide = { n: null, v: 0, want: 0, last: 0, raf: 0 };
  const listGlideTick = (t) => {
    if (!listGlide.n || t - listGlide.last > 200) listGlide.want = 0;
    listGlide.v += (listGlide.want - listGlide.v) * 0.18;
    if (Math.abs(listGlide.v) < 0.2 && !listGlide.want) { listGlide.v = 0; listGlide.raf = 0; return; }
    listGlide.n.scrollTop += listGlide.v;
    listGlide.raf = requestAnimationFrame(listGlideTick);
  };
  document.addEventListener("dragover", (e) => {
    // a note has its own, wider band (editor.js); this one is for the lists
    if (e.target instanceof Element && e.target.closest(".cm-editor, .note-scroll")) return;
    for (let n = e.target instanceof Element ? e.target : null; n; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      const oy = getComputedStyle(n).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      const r = n.getBoundingClientRect(), edge = Math.min(64, r.height / 4);
      const d = e.clientY < r.top + edge ? e.clientY - (r.top + edge) : e.clientY > r.bottom - edge ? e.clientY - (r.bottom - edge) : 0;
      // px per frame: slow at the band's inner side, up to 18 at the edge
      const k = Math.min(1, Math.abs(d) / edge);
      if (listGlide.n !== n) listGlide.v = 0;
      listGlide.n = n; listGlide.want = Math.sign(d) * (1.5 + 16.5 * k * k); listGlide.last = performance.now();
      if (d && !listGlide.raf) listGlide.raf = requestAnimationFrame(listGlideTick);
      return;
    }
    listGlide.want = 0;
  }, true);
  for (const ev of ["drop", "dragend"]) document.addEventListener(ev, () => { listGlide.want = 0; listGlide.v = 0; }, true);
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3) { e.preventDefault(); history(-1); }
    if (e.button === 4) { e.preventDefault(); history(1); }
  });
  // no browser chrome: the WebView's own context menu has nothing useful
  window.addEventListener("contextmenu", (e) => {
    if (!e.defaultPrevented && !e.target.closest(".cm-content, input, textarea")) e.preventDefault();
  });

  app.focusMain = () => {
    const t = cur();
    if (t.kind === "note") editor.focus();
    else if (views[t.view] && views[t.view].show && t.view === "tasks") views.tasks.show();
  };

  /* ── chrome ───────────────────────────────────────────────────────────── */
  const tbIcons = { "toggle-sidebar": "sidebar", back: "back", forward: "forward", "toggle-right": "panelRight", "on-top": "pin", "to-tray": "minus", compact: "shrink" };

  // The whole top bar moves the window: any empty spot, including the space
  // around the tabs. Done here rather than with data-tauri-drag-region, which
  // only reacts to the exact element carrying the attribute.
  $(".titlebar").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, .tab, .tg, .tg-chip, .tab-new, kbd, a, .inline-edit")) return;
    if (e.detail === 2) { host.win.toggleMaximize(); return; }
    host.win.startDragging().catch(() => {});
  });
  for (const b of document.querySelectorAll("[data-cmd]")) {
    if (tbIcons[b.dataset.cmd]) b.prepend(icon(tbIcons[b.dataset.cmd]));
    b.addEventListener("click", () => app.run(b.dataset.cmd));
    if (b.dataset.cmd === "back" || b.dataset.cmd === "forward") {
      b.addEventListener("contextmenu", (e) => { e.preventDefault(); trailMenu(b.dataset.cmd === "back" ? -1 : 1, b); });
      b.title += " · right-click for history";
    }
  }
  /* The top bar's buttons, each shown or hidden: right-click any of them (or the empty bar beside
     them) for the list. Keep on top starts hidden; its command stays in Ctrl+P either way. */
  const TB_BUTTONS = [["switcher", "Search or jump to"], ["toggle-sidebar", "Sidebar"], ["back", "Back"], ["forward", "Forward"], ["toggle-right", "Details panel"], ["on-top", "Keep on top"], ["compact", "Compact mode"]];
  const tbHidden = () => new Set(Array.isArray(app.settings.tbHidden) ? app.settings.tbHidden : ["on-top"]);
  function paintTbButtons() {
    const off = tbHidden();
    for (const [cmd] of TB_BUTTONS) for (const b of document.querySelectorAll(`.titlebar [data-cmd="${cmd}"]`)) b.classList.toggle("is-tb-off", off.has(cmd));
  }
  function tbMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const off = tbHidden();
    menu(e.clientX, e.clientY, [
      { header: "Buttons in the top bar" },
      ...TB_BUTTONS.map(([cmd, label]) => ({ label, icon: cmd === "switcher" ? "search" : tbIcons[cmd], checked: !off.has(cmd), keep: true, run: () => {
        const now = tbHidden();
        if (now.has(cmd)) now.delete(cmd); else now.add(cmd);
        app.setSetting("tbHidden", [...now]);
        paintTbButtons();
      } })),
    ]);
  }
  for (const [cmd] of TB_BUTTONS) {
    if (cmd === "back" || cmd === "forward") continue; // their right-click is the history
    for (const b of document.querySelectorAll(`.titlebar [data-cmd="${cmd}"]`)) { b.addEventListener("contextmenu", tbMenu); b.title += " · right-click to choose the top bar's buttons"; }
  }
  for (const side of document.querySelectorAll(".titlebar .tb-right, .titlebar .tb-left")) side.addEventListener("contextmenu", (e) => { if (e.target === side) tbMenu(e); });
  paintTbButtons();
  const winIcons = { min: "minus", max: "square", close: "x" };
  for (const b of document.querySelectorAll("[data-win]")) {
    b.append(icon(winIcons[b.dataset.win]));
    b.addEventListener("click", () => {
      const w = b.dataset.win;
      if (w === "min") host.win.minimize();
      if (w === "max") host.win.toggleMaximize();
      // the X quits for real (flushing first); hiding to the tray is for
      // Alt+F4 / taskbar closes and compact mode's minimize button
      if (w === "close") host.requestQuit();
    });
  }
  if (!host.real) document.querySelector(".win").hidden = true;
  const syncMax = async () => {
    const max = await host.win.isMaximized().catch(() => false);
    const b = document.querySelector('[data-win="max"]');
    b.replaceChildren(icon(max ? "restore" : "square"));
    $("#app").classList.toggle("is-maximized", !!max);
  };
  host.win.onResized(debounce(syncMax, 60)).catch(() => {});
  syncMax();

  /* ── compact mode: the old Leonote's small pinned sticky window ─────────── */
  const compactNav = $("#compact-nav");
  for (const [view, ic, name] of [["tasks", "checkSquare", "Tasks"], ["focus", "focus", "Focus"], ["habits", "flame", "Habits"], ["timer", "clock", "Timer"], ["home", "home", "Home"]]) {
    compactNav.append(h("button", { class: "tb-btn", title: name, dataset: { view }, onclick: () => app.openView(view) }, icon(ic)));
  }
  const paintCompactNav = () => {
    const t = cur();
    for (const b of compactNav.children) b.classList.toggle("is-on", !!t && t.kind === "view" && t.view === b.dataset.view);
  };
  app.bus.on("view", paintCompactNav);

  /* ── a phone: one panel at a time - the note tree slides in as a drawer, the views sit in a bar along the
     bottom, everything is big enough for a thumb. Only on a phone (`?phone` tries it in a browser): a narrow desktop
     window keeps the desktop layout. */
  if (/Android|iPhone|iPad/i.test(navigator.userAgent) || new URLSearchParams(location.search).has("phone")) {
    const root = $("#app");
    root.classList.add("is-phone");
    document.documentElement.classList.add("is-phone"); // toasts and dialogs sit outside #app
    const drawer = (open) => app.setSetting("sidebar", open);
    const nav = h("nav", { class: "phone-nav", "aria-label": "Views" });
    const items = [
      ["notes", "folder", "Notes", () => drawer(!app.settings.sidebar)],
      ["home", "home", "Home", () => { drawer(false); app.openView("home"); }],
      ["tasks", "checkSquare", "Tasks", () => { drawer(false); app.openView("tasks"); }],
      ["today", "calendar", "Today", () => { drawer(false); app.run("daily"); }],
      ["more", "grid", "More", () => { drawer(false); sheet(!sheetEl.classList.contains("is-open")); }],
    ];
    // More: the views the bar has no room for, as a sheet over the bottom - every part of Leonote within two taps
    const MORE = [["habits", "flame", "Habits"], ["calendar", "calendar", "Calendar"], ["timer", "clock", "Timer"], ["focus", "focus", "Focus"], ["fit", "dumbbell", "Workout"], ["assistant", "sparkles", "Assistant"], ["graph", "graph", "Graph"], ["music", "music", "Player"], ["settings", "settings", "Settings"]];
    const sheetEl = h("div", { class: "phone-sheet", role: "dialog", "aria-label": "More views" },
      MORE.map(([view, ic, name]) => h("button", { class: "phone-sheet-btn", dataset: { view }, onclick: () => { sheet(false); app.openView(view); } }, h("span", { class: "phone-sheet-ico" }, icon(ic)), h("span", { text: name }))));
    const sheetScrim = h("div", { class: "phone-sheet-scrim", onclick: () => sheet(false) });
    const sheet = (open) => { sheetEl.classList.toggle("is-open", open); sheetScrim.classList.toggle("is-open", open); sheetEl.inert = !open; paint(); };
    sheetEl.inert = true;
    root.append(sheetScrim, sheetEl);
    // the top bar says where you are, and search sits at its right end
    const titleEl = h("div", { class: "phone-title" });
    $(".tb-left").append(titleEl);
    $(".tb-right").append(h("button", { class: "tb-btn phone-search", "aria-label": "Search", onclick: () => { drawer(false); sheet(false); app.run("switcher"); } }, icon("search")));
    for (const [key, ic, name, run] of items) nav.append(h("button", { class: "phone-btn", dataset: { key }, "aria-label": name, onclick: run }, icon(ic), h("span", { text: name })));
    // a tap beside the open drawer closes it
    const scrim = h("div", { class: "phone-scrim", onclick: () => drawer(false) });
    root.append(scrim, nav);
    const paint = () => {
      const t = cur();
      const view = t && t.kind === "view" ? t.view : "";
      const more = sheetEl.classList.contains("is-open");
      for (const b of nav.children) b.classList.toggle("is-on", b.dataset.key === "more" ? more || MORE.some(([v]) => v === view) : !more && (b.dataset.key === "notes" ? !!app.settings.sidebar : view === b.dataset.key));
      for (const b of sheetEl.children) b.classList.toggle("is-on", b.dataset.view === view);
      titleEl.textContent = document.title.replace(/ - Leonote$/, "");
    };
    // the drawer starts shut and shuts when something opens from it
    if (app.settings.sidebar) drawer(false);
    app.bus.on("view", () => { if (app.settings.sidebar) drawer(false); sheet(false); });
    app.bus.on("settings", (k) => { if (k === "sidebar") paint(); });
    paint();
    // no slide at startup: the drawer is simply shut when the app appears
    root.classList.add("phone-still");
    setTimeout(() => root.classList.remove("phone-still"), 400);

    // typing a note: the bottom bar gives way to formatting, as a phone has no shortcuts
    const fmt = h("div", { class: "phone-fmt", role: "toolbar", "aria-label": "Formatting" });
    const keep = (e) => e.preventDefault(); // a press keeps the keyboard and the selection where they are
    for (const [cmd, ic, name] of [["undo", "undo", "Undo"], ["redo", "redo", "Redo"], ["bold", "bold", "Bold"], ["italic", "italic", "Italic"], ["task", "checkSquare", "Checkbox"], ["bullets", "list", "List"], ["h2", "heading", "Heading"], ["link", "link", "Link"], ["outdent", "back", "Less indent"], ["indent", "forward", "More indent"]]) {
      fmt.append(h("button", { class: "phone-fmt-btn", "aria-label": name, onpointerdown: keep, onmousedown: keep, onclick: () => app.editor.run(cmd) }, icon(ic)));
    }
    fmt.append(h("button", { class: "phone-fmt-btn is-done", "aria-label": "Done typing", onpointerdown: keep, onmousedown: keep, onclick: () => document.activeElement && document.activeElement.blur() }, icon("keyboard")));
    root.append(fmt);
    const typing = () => root.classList.toggle("is-typing", !!(document.activeElement && document.activeElement.closest && document.activeElement.closest("#editor .cm-content")));
    document.addEventListener("focusin", typing, true);
    document.addEventListener("focusout", () => setTimeout(typing, 0), true);

    // Android's back: closes what is on top (a dialog, the drawer), then goes back a step in Leonote; only
    // at the start of the trail does it leave the app. A placeholder history entry catches each press.
    const arm = () => { try { window.history.pushState({ leonote: 1 }, ""); } catch {} };
    arm();
    let leaving = 0;
    window.addEventListener("popstate", () => {
      const dlg = document.querySelector("#overlay-root > *");
      if (dlg) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (sheetEl.classList.contains("is-open")) sheet(false);
      else if (app.settings.sidebar) drawer(false);
      else if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".cm-content")) document.activeElement.blur();
      else if (trailStep(-1) >= 0) app.run("back");
      else if (Date.now() - leaving > 2500) { leaving = Date.now(); toast("Press back again to leave Leonote", { ms: 2500 }); }
      else { shutdown(); return; } // the second press in a row: everything saved, then Leonote closes
      arm();
    });

    // a swipe in from the left edge opens the drawer; a swipe left on it closes it
    let sx = 0, sy = 0, from = "";
    document.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      from = sx < 24 && !app.settings.sidebar ? "edge" : app.settings.sidebar && e.target.closest(".sidebar, .phone-scrim") ? "drawer" : "";
    }, { passive: true });
    document.addEventListener("touchend", (e) => {
      if (!from) return;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
      if (dy < 60 && from === "edge" && dx > 60) drawer(true);
      else if (dy < 60 && from === "drawer" && dx < -60) drawer(false);
      from = "";
    }, { passive: true });
  }

  let fullWas = null; // the tab the full window was on when it went compact
  const onTopNow = () => (app.settings.compact ? app.settings.compactOnTop !== false : !!app.settings.onTop);

  function paintChrome() {
    const pin = document.querySelector('[data-cmd="on-top"]');
    if (pin) { pin.classList.toggle("is-on", onTopNow()); pin.title = (onTopNow() ? "Pinned on top - click to unpin" : "Keep on top") + " · right-click to choose the top bar's buttons"; }
    const cb = document.querySelector('[data-cmd="compact"]');
    if (cb) { cb.replaceChildren(icon(app.settings.compact ? "expand" : "shrink")); cb.title = (app.settings.compact ? "Full window (Ctrl+Shift+C)" : "Compact mode (Ctrl+Shift+C)") + " · right-click to choose the top bar's buttons"; }
  }

  function toggleOnTop() {
    const S = app.settings;
    if (S.compact) S.compactOnTop = !onTopNow();
    else S.onTop = !S.onTop;
    host.win.setAlwaysOnTop(onTopNow()).catch(() => {});
    saveSettings();
    paintChrome();
  }

  async function geometry() {
    const scale = await host.win.scaleFactor();
    const pos = (await host.win.outerPosition()).toLogical(scale);
    const size = (await host.win.innerSize()).toLogical(scale);
    return { x: Math.round(pos.x), y: Math.round(pos.y), w: Math.round(size.width), h: Math.round(size.height) };
  }

  app.leaveCompact = () => setCompact(false, { stay: true });
  /* Scroll jumps, measured in the real app: every frame, the line a third of the way down the note is held up
     against the scroll - when it moves more than the scroll explains, that is a jump, written down with what
     came with it (the note grew or shrank, a picture had just loaded, which way you scrolled). Stopping copies
     the report to paste back. Nothing is changed in the note. */
  let recording = null;
  function scrollRecorder() {
    if (recording) { recording.stop(); return; }
    const sc = document.querySelector("#view-note .note-scroll") || document.querySelector(".note-scroll");
    if (!sc || !sc.isConnected) { toast("Open a note first, then start the recorder", { ms: 3000 }); return; }
    const t0 = performance.now();
    const ev = [];
    let ref = null, loads = 0, dir = 0, frames = 0, raf = 0;
    const onLoad = (e) => { if (e.target && e.target.tagName === "IMG") loads++; };
    const onWheel = (e) => { dir = Math.sign(e.deltaY); };
    document.addEventListener("load", onLoad, true);
    sc.addEventListener("wheel", onWheel, { passive: true });
    // who moves the scroll besides the wheel: every scrollTop set by code, with the place in the code it came from
    const sets = [];
    const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(sc, "scrollTop", {
      configurable: true,
      get() { return own.get.call(this); },
      set(v) {
        const from = own.get.call(this);
        own.set.call(this, v);
        if (sets.length < 120 && Math.abs(own.get.call(this) - from) > 2) {
          const where = (new Error().stack || "").split("\n").slice(2, 5).map((l) => l.trim().replace(/^at /, "").replace(/\(?https?:\/\/[^/]+\//, "(")).join(" < ");
          sets.push(`${((performance.now() - t0) / 1000).toFixed(1)} | ${Math.round(from)} -> ${Math.round(own.get.call(this))} | ${where}`);
        }
      },
    });
    const tick = () => {
      frames++;
      const r = sc.getBoundingClientRect();
      if (ref && ref.el.isConnected && ref.el.textContent === ref.text) {
        const d = ref.el.getBoundingClientRect().top - ref.top + (sc.scrollTop - ref.st);
        if (Math.abs(d) > 2) ev.push({ at: ((performance.now() - t0) / 1000).toFixed(1), d: Math.round(d), st: Math.round(sc.scrollTop), h: sc.scrollHeight, dh: sc.scrollHeight - ref.h, pics: loads - ref.loads, dir, pic: ref.pic });
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3);
      const el = hit && hit.closest && hit.closest(".cm-line");
      ref = el ? { el, top: el.getBoundingClientRect().top, st: sc.scrollTop, h: sc.scrollHeight, text: el.textContent, loads, pic: !!el.querySelector(".cm-img, .cm-media") } : null;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    recording = {
      stop() {
        cancelAnimationFrame(raf);
        delete sc.scrollTop;
        document.removeEventListener("load", onLoad, true);
        sc.removeEventListener("wheel", onWheel);
        recording = null;
        const secs = ((performance.now() - t0) / 1000).toFixed(0);
        const worst = ev.reduce((m, e) => Math.max(m, Math.abs(e.d)), 0);
        const report = [
          `Leonote scroll report · ${editor.path || "?"} · ${secs} s, ${frames} frames · ${ev.length} jumps, worst ${worst} px`,
          `window ${innerWidth}x${innerHeight} @${devicePixelRatio} · column ${Math.round((document.querySelector("#view-note .cm-content") || {}).clientWidth || 0)} px · note ${sc.scrollHeight} px · pictures beside text in their line: ${app.settings.floatContain ? "on" : "off"}`,
          "at s | jump px | scrolling | scrollTop | note height (change) | pictures just loaded | line read is a picture's",
          ...ev.slice(0, 150).map((e) => `${e.at} | ${e.d > 0 ? "+" : ""}${e.d} | ${e.dir < 0 ? "up" : e.dir > 0 ? "down" : "-"} | ${e.st} | ${e.h} (${e.dh > 0 ? "+" : ""}${e.dh}) | ${e.pics} | ${e.pic ? "yes" : ""}`),
          "",
          `scroll moved by code (not the wheel): ${sets.length}`,
          "at s | from -> to | where",
          ...sets,
        ].join("\n");
        navigator.clipboard.writeText(report).catch(() => {});
        toast(`${ev.length} jump${ev.length === 1 ? "" : "s"} recorded${ev.length ? `, worst ${worst} px` : ""} - the report is copied - send it to the Discord`, { ms: 6000 });
      },
    };
    toast("Recording scroll jumps - scroll the note as you do, then run the command again to stop", { ms: 4000 });
  }
  /* Compact and full are two windows in one: each keeps its own size and place, and its own view (the compact
     one its Tasks, Timer, Focus or Habits; the full one its tab). Going across: the view of the side being
     entered is put up first (compact: never the graph or the Player squeezed into the small window), then the
     window changes size and place in one native step. Nothing is hidden meanwhile - a fade-out left the window
     empty for as long as the resize (and Windows' maximize) took. */
  const COMPACT_VIEWS = ["tasks", "focus", "habits", "timer"];
  async function setCompact(on, { init = false, stay = false } = {}) {
    const S = app.settings;
    const moving = host.real && !init && on !== !!S.compact;
    // the compact side's own view, put up before the window shrinks
    if (on && !init && !S.compact) {
      const t = cur();
      fullWas = active >= 0 && tabs[active] ? tabs[active].id : null;
      S.fullWasAt = t ? loc(t) : null;
      app.openView(COMPACT_VIEWS.includes(S.compactView) ? S.compactView : "tasks");
    }
    if (!on && !init && S.compact) {
      // what the compact window was showing, for next time
      const t = cur();
      if (t && t.kind === "view" && COMPACT_VIEWS.includes(t.view)) S.compactView = t.view;
    }
    $("#app").classList.toggle("is-compact", on);
    if (moving) {
      try {
        if (on) {
          // where the full window is matters only for a first compact window, placed at its right edge
          const full = S.compactGeometry ? null : await geometry().catch(() => ({ x: 100, y: 100, w: 1280, h: 820 }));
          const g = S.compactGeometry || { w: 420, h: 720, x: full.x + Math.max(0, full.w - 440), y: full.y + 24 };
          S.fullGeometry = await host.win.place({ w: g.w, h: g.h, x: g.x, y: g.y });
        } else {
          const g = S.fullGeometry;
          S.compactGeometry = await host.win.place(g ? { w: Math.max(g.w, 720), h: Math.max(g.h, 480), x: g.x, y: g.y, max: !!g.max } : { w: 1280, h: 820 });
        }
      } catch (e) {
        console.warn("compact geometry", e);
      }
    }
    // The full window comes back to where it was left, not to whatever the
    // small window was last showing: the tab that was up is remembered on the
    // way in and brought back on the way out.
    // Kept in the settings too, so it survives a restart spent in compact mode (remembered above, before the
    // compact view was put up).
    if (!on && !init && S.compact) {
      const at = S.fullWasAt;
      let k = fullWas != null ? tabs.findIndex((x) => x.id === fullWas) : -1;
      if (k < 0 && at && at.kind !== "view") k = tabs.findIndex((x) => same(x, at));
      fullWas = null;
      S.fullWasAt = null;
      // stay: something was just opened (a file handed over) - that is what to show, not the old tab
      if (!stay) setTimeout(() => {
        if (k >= 0) { if (k !== active) activate(k); }
        else if (at && exists(at)) navigate(at);
      });
    }
    // compact is a task window first: on a start in compact mode too, a view that fits it
    if (on) {
      const t = cur();
      if (!(t && t.kind === "view" && COMPACT_VIEWS.includes(t.view))) app.openView(COMPACT_VIEWS.includes(S.compactView) ? S.compactView : "tasks");
    }
    S.compact = on;
    host.win.setAlwaysOnTop(onTopNow()).catch(() => {});
    // the small window lives in the tray's hidden icons, not on the taskbar
    host.win.setSkipTaskbar(on).catch(() => {});
    applyZoom(false);
    saveSettings();
    paintChrome();
    paintCompactNav();
    app.bus.emit("settings", "compact");
  }
  /* ── Ctrl+scroll zoom, remembered separately for compact and full ─────── */
  const zoomKey = () => (app.settings.compact ? "uiScaleCompact" : "uiScale");
  const zoomDefault = () => (app.settings.compact ? 0.9 : 1);
  const zoomNow = () => clamp(Number(app.settings[zoomKey()]) || zoomDefault(), 0.5, 2);
  let closeZoomToast = null;
  function applyZoom(announce) {
    const z = zoomNow();
    host.win.setZoom(z).catch(() => {});
    document.documentElement.dataset.uiZoom = String(z); // read by whatever must know the true size of a pixel (the Sketch rulers)
    if (announce) {
      if (closeZoomToast) closeZoomToast();
      closeZoomToast = toast(`Zoom ${Math.round(z * 100)}%`, { ms: 900 });
    }
  }
  // not passive, on purpose: Ctrl+wheel (and a touchpad's pinch, which comes as one) zooms the app and must stop the
  // page's own zoom. Chromium makes only the first wheel event of a scroll wait for it, so scrolling stays smooth
  window.addEventListener("wheel", (e) => {
    // what took Ctrl+wheel for itself (the video editor's timeline and preview, a graph…) zooms itself
    if (!e.ctrlKey || e.defaultPrevented) return;
    // over a drawing, a picture or a board the wheel is theirs: they zoom themselves
    if (e.target && e.target.closest && e.target.closest("canvas, .sk, .pt, .ie, .img-viewer, .bd, .gx, .fv-player, #view-webtab, .pv-browser, .ve-stage")) return;
    e.preventDefault();
    app.setSetting(zoomKey(), clamp(Math.round((zoomNow() + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100, 0.5, 2));
    applyZoom(true);
  }, { passive: false });
  app.resetZoom = () => {
    app.setSetting(zoomKey(), zoomDefault());
    applyZoom(true);
  };

  // before first paint: the window-state plugin has already restored whichever size was last used
  setCompact(!!app.settings.compact, { init: true });

  // sidebar resize
  const resizer = $("#sb-resizer");
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = app.settings.sidebarWidth;
    document.body.classList.add("is-resizing");
    const move = (ev) => {
      app.settings.sidebarWidth = clamp(startW + ev.clientX - startX, 190, 440);
      applySetting("sidebarWidth");
    };
    const up = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveSettings();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // the details panel resizes from its left edge; the grab strip lies over
  // the panel's own padding, clear of the note's scrollbar next to it
  const rpResizer = h("div", { class: "rp-resizer", id: "rp-resizer", title: "Drag to resize · double-click to reset", hidden: !app.settings.rightPanel });
  $("#rightpanel").before(rpResizer);
  applySetting("rightPanelWidth");
  rpResizer.addEventListener("dblclick", () => app.setSetting("rightPanelWidth", 276));
  rpResizer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = $("#rightpanel").getBoundingClientRect().width;
    document.body.classList.add("is-resizing");
    rpResizer.classList.add("is-active");
    const move = (ev) => {
      app.settings.rightPanelWidth = Math.round(clamp(startW - (ev.clientX - startX), 220, 560));
      applySetting("rightPanelWidth");
    };
    const up = () => {
      document.body.classList.remove("is-resizing");
      rpResizer.classList.remove("is-active");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveSettings();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  const sidebar = mountSidebar(app, $("#sidebar"));
  spacesUi = mountSpaces(app, spacesApi, $("#space-btn"));
  const spaceSlots = {
    // inside the sidebar toggle's own container, at its far end: as far from the
    // sidebar's edge as the toggle is from the window's
    tabs: (b) => $(".tb-left").append(b),
    right: (b) => $(".tb-search").after(b),
    // among the ribbon's buttons, draggable into any spot like them
    ribbon: (b) => (app.addNavButton ? app.addNavButton("spaces", b) : document.querySelector(".ribbon")?.insertBefore(b, document.querySelector(".ribbon-foot"))),
  };
  const placeSpaces = () => spacesUi.place(spaceSlots);
  app.bus.on("settings", (k) => { if (k === "spacesAt") placeSpaces(); });
  mountRightPanel(app, $("#rightpanel"));
  mountAutoscroll();

  /* ── never lose the last keystroke ────────────────────────────────────── */
  // Rust holds the close and asks us to flush; it exits by itself after 2.5 s
  // if we never answer, so this can only ever make closing safer.
  let closing = false;
  // `then`: what runs once everything is written, instead of quitting (installing an update)
  async function shutdown(then) {
    if (closing) return;
    closing = true;
    saveSession.cancel();
    saveSettings.cancel();
    persistHabits.flush();
    app.pomo.suspend();
    app.stats.flush();
    app.areas.flush();
    const pos = editor.position();
    if (pos && cur().kind === "note") rememberPos(pos.path, pos);
    savePositions.cancel();
    storeSpace();
    app.settings.spaces = spaces;
    app.settings.activeSpace = space.id;
    delete app.settings.session;
    const work = Promise.all([flushAll(), app.vault.idle(), host.saveSettings(app.settings), host.savePositions(app.positions), fileView ? fileView.flush() : null, extView ? extView.flush() : null, split.flush()]).catch(() => {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await Promise.race([work, wait(800)]); // a normal quit is done by now: no dialog flashing past
    const unwritten = () => Math.max(app.vault.saving, app.vault.failed.size);
    if (unwritten() && host.quitHold) {
      // notes are still being written: the app says so, keeps writing, and quits by itself the moment they are on disk - or now, if told to
      host.quitHold().catch(() => {});
      const n = unwritten();
      await new Promise((res) => {
        const title = h("h3", { class: "dlg-title", text: `Still saving ${n} note${n === 1 ? "" : "s"}…` });
        const text = h("p", { class: "dlg-text", text: "Leonote quits by itself the moment they are written. Quitting before that could lose the last keystrokes." });
        const waitEl = h("span", { class: "dlg-wait", text: "Writing…" });
        // a save that keeps failing (a full disk, a read-only file) is not "writing": it says so, offers the text,
        // and waits for the user instead of quitting by itself with the text lost
        const copyBtn = h("button", { class: "btn", hidden: true, onclick: () => {
          const all = [...app.vault.failed].map((p) => `# ${p}` + String.fromCharCode(10, 10) + ((editor.content(p) ?? (app.vault.get(p) || {}).content) || "")).join(String.fromCharCode(10, 10) + "---" + String.fromCharCode(10, 10));
          navigator.clipboard.writeText(all).then(() => { copyBtn.textContent = "Copied"; }).catch(() => {});
        } }, "Copy the text");
        const box = h("div", { class: "dlg", role: "alertdialog", "aria-modal": "true" }, title, text,
          h("div", { class: "dlg-btns" }, waitEl, h("span", { class: "trash-gap" }), copyBtn, h("button", { class: "btn btn-danger", onclick: () => res("now") }, "Quit now anyway")));
        const back = h("div", { class: "dlg-back is-in" }, box);
        document.getElementById("overlay-root").append(back);
        let late = setTimeout(() => res("late"), 55000);
        const update = () => {
          if (!unwritten()) return res("done");
          if (!app.vault.saving && app.vault.failed.size) {
            const names = [...app.vault.failed].map((p) => basename(p).replace(/\.md$/i, "")).join(", ");
            title.textContent = `Could not save ${names}`;
            text.textContent = "Copy the text before quitting, so nothing is lost. Leonote waits for you.";
            waitEl.textContent = "";
            copyBtn.hidden = false;
            clearTimeout(late); late = 0;
            if (host.quitHold) host.quitHold(true).catch(() => {}); // the app's own minute limit waits too
          } else {
            const k = unwritten();
            title.textContent = `Still saving ${k} note${k === 1 ? "" : "s"}…`;
          }
        };
        app.vault.bus.on("saving", update);
        update();
      });
    }
    await Promise.race([work, wait(1000)]);
    try { localStorage.removeItem(PLUGINS_STARTING); } catch {} // a quit soon after start is no stuck plugin
    if (typeof then === "function") return then();
    host.quit();
  }
  host.on("app:close-requested", shutdown);
  // hidden to the tray: nothing is lost, but write everything out now anyway
  host.on("app:hidden", () => {
    flushAll();
    if (fileView) fileView.flush();
    if (extView) extView.flush();
    split.flush();
    const pos = editor.position();
    if (pos && cur().kind === "note") rememberPos(pos.path, pos);
    savePositions.flush();
    saveSession.flush();
    saveSettings.flush();
    persistHabits.flush();
    app.stats.flush();
  });
  window.addEventListener("beforeunload", () => { flushAll(); });
  // nothing watches outside the vault: check when the window comes back
  window.addEventListener("focus", () => { if (extView && cur().kind === "ext") extView.refresh(); });

  /* ── restore session, paint, then show the window ─────────────────────── */
  migrateSettings(app);
  await renameDrawings();
  await restoreGuests();
  if (!host.real) app._renameDrawings = renameDrawings; // the browser mock's test hook
  initSpaces();
  app.pomo.restore();
  placeSpaces();
  show();

  for (const [name, payload] of queue.splice(0)) handlers[name](payload);
  pruneExternals();
  // the Sound engine: each song's tempo, pitch and loop, and the effects, wherever it plays - loaded once the start
  // is over (not in its way), or sooner when something plays; it then reads its settings and sets up the song that is on
  let soundAsked = false;
  const startSound = () => {
    if (soundAsked) return;
    soundAsked = true;
    app.media.bus.removeEventListener("change", startSound);
    import("./soundlab.js").then((mod) => { app.soundEngine = mod.soundEngine(app, app.media); }).catch((e) => console.warn("sound", e));
  };
  app.media.bus.addEventListener("change", startSound);
  (window.requestIdleCallback || ((f) => setTimeout(f, 2000)))(startSound, { timeout: 4000 });
  // imported YouTube playlists: new videos daily; and changes sent back, for the ones told to
  app.ytPush = createYtPush(app, app.media);
  app.diagnostics = () => diagnostics(app);
  const noteError = (msg) => { app.errors.push(`${new Date().toISOString().slice(0, 19)} ${String(msg).slice(0, 300)}`); if (app.errors.length > 20) app.errors.shift(); };
  window.addEventListener("error", (e) => noteError(e.message + (e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : "")));
  window.addEventListener("unhandledrejection", (e) => noteError((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  startYtSync(app, app.media);
  // the browser's add-ons: newer versions looked for once a day, a minute after start - only when switched on
  if (app.host.real && app.settings.webExtAutoUpdate === true) setTimeout(() => {
    if (Date.now() - (Number(app.settings.webExtCheckedAt) || 0) > 86400000) import("./webaddons.js").then((mod) => mod.updateAddons(app, { quiet: true })).catch(() => {});
  }, 60000);
  // documents the process was launched with (a .md double-clicked in Explorer)
  app.openFromOutside(boot.open_paths || []);
  // design/test hook, browser mock only: #note=Welcome.md  #view=tasks  #run=commands
  if (!host.real && location.hash.length > 1) {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get("theme")) app.setSetting("theme", q.get("theme"));
    if (q.get("note")) app.openNote(q.get("note"));
    if (q.get("view")) app.openView(q.get("view"));
    if (q.get("run")) setTimeout(() => app.run(q.get("run")), 50);
    if (q.get("agent")) setTimeout(() => window.mock[q.get("agent")](), 80);
  }

  requestAnimationFrame(() => {
    app.bootMs = performance.now() - T0;
    // launch at login names an exe: a portable copy run from somewhere new (an update in another folder) points it here
    // again, or Windows goes on starting the old one at login (or nothing, if that was deleted); switched off in Windows,
    // the setting follows
    if (app.settings.launchAtLogin && !app.packaged) host.autostartRepoint().then((on) => { if (!on) app.setSetting("launchAtLogin", false); }, () => {});
    // a newer version, asked weekly - only when turned on (Settings › About); the Store's copy updates itself
    if (app.settings.updateWeekly === true && !app.packaged && Date.now() - (Number(app.settings.updateCheckedAt) || 0) > 7 * 864e5) setTimeout(() => app.checkUpdate({ quiet: true }), 30000);
    // the names of the notes in folders left out of indexing (nothing in them is read): links to them stay whole
    if ((app.settings.noIndex || []).length) host.unindexedNames().then((list) => {
      app.vault.setUnindexed(list || []);
      for (const ed of [editor, ...(app.split ? app.split.editors : [])]) if (ed) ed.refresh();
    }).catch(() => {});
    if (!boot.hidden) host.win.show();
    host.trace(`first paint ${performance.now().toFixed(0)} ms after page start (app ${app.bootMs.toFixed(0)} ms, rust boot ${(boot.ms || 0).toFixed(1)} ms)`);
    if (cur().kind === "note") editor.focus();
    console.info(`Leonote ready in ${app.bootMs.toFixed(1)} ms (rust boot ${(boot.ms || 0).toFixed(1)} ms, ${app.vault.notes.size} notes, ${app.tasks.all.length} tasks)`);
  });
}

start().catch((err) => {
  console.error(err);
  document.body.replaceChildren(h("div", { class: "fatal" }, h("h1", { text: "Leonote hit an error while starting" }), h("pre", { text: String(err && err.stack || err) })));
  host.win && host.win.show();
});
