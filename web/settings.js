// Settings as a page, not a dialog. Every control applies instantly.

import { colorBlock } from "./treestyle.js";
import { playSound } from "./uisound.js";
import { h, animateRows } from "./util.js";
import { icon } from "./icons.js";
import { kbd, menu, confirmDialog } from "./ui.js";
import { plansPanel, recoveryDialog, backupDir } from "./backupplans.js";
import { aboutSection, keyChecker, openText } from "./support.js";
import { createBackup, restoreBackup } from "./backup.js";
import { fmtSize } from "./fileview.js";
import { outpostList, addOutpost, removeOutpost, pcRootsOf } from "./outposts.js";
import { addonsPanel } from "./webaddons.js";
import { pluginsPanel } from "./plugins.js";
import { CONSOLE_PAGE, icsOf } from "./gcal.js";
import { GOOGLE_APP_NOTE } from "./ytaccount.js";
import { SPEECH, speechOf, modelFor } from "./speech.js";

export const ACCENTS = {
  amber: "#e0a84a",
  violet: "#9b87f5",
  blue: "#5b9cf6",
  teal: "#3fbfa8",
  rose: "#ee6b8b",
  graphite: "#a1a1aa",
  // unlocked by the ranks (stats.js RANKS): a colour for each, a small thing for getting there
  leaf: "#6cc070", ember: "#f07a3c", savanna: "#d9b45f", ocean: "#3a8ee6", dusk: "#b276e8", pride: "#e04f5f",
  gold: "#f2c94c", aurora: "#4fd6c4", steel: "#8fa6c4", blossom: "#ff8ad8", evergreen: "#7ee081", sky: "#9ad0ff", sun: "#ffb020",
};
/** The colours a rank unlocks: accent key -> [rank, level]. */
export const ACCENT_UNLOCKS = {
  leaf: ["Lion cub", 3], ember: ["Apprentice", 7], savanna: ["Explorer", 12], ocean: ["Hunter", 18], dusk: ["Disciplined", 26], pride: ["Steady", 36],
  gold: ["Scholar", 50], aurora: ["Guardian", 70], steel: ["Veteran", 95], blossom: ["Strategist", 125], evergreen: ["Leader", 160], sky: ["Master", 200], sun: ["Leader", 250],
};

/* ── heading styles ──────────────────────────────────────────────────────
   Six designs, applied as <html data-headings> and drawn entirely in CSS -
   nothing in the file changes, so a note is still plain `# Heading` in
   Obsidian, and switching costs one attribute write. Numbered counts with
   CSS counters, so the numbers are a view, never text. */
export const HEADING_STYLES = [
  ["accent", "Accent", "A coloured bar in the margin, fading down the levels"],
  ["plain", "Plain", "Just the sizes"],
  ["underline", "Underlined", "A hairline under H1 and H2"],
  ["number", "Numbered", "1. / 1.1 / 1.1.1 counted for you"],
  ["boxed", "Boxed", "H1 on a soft panel, H2 as a chip"],
  ["serif", "Serif display", "H1 and H2 in the serif face"],
  ["tinted", "Tinted", "Headings in the accent colour"],
  ["caps", "Small caps", "Spaced capitals, quiet and even"],
  ["hash", "Hashes", "The # marks kept, in colour, as in the source"],
  ["rule", "Ruled", "A line on the side of every heading"],
];
export const HEADING_SIZES = ["compact", "normal", "large"];

/** Never let junk in the settings file turn into a bad data-headings. */
export const resolveHeadingStyle = (v) => (HEADING_STYLES.some(([k]) => k === v) ? v : "plain");
export const resolveHeadingSize = (v) => (HEADING_SIZES.includes(v) ? v : "normal");

const DATA_DIRS = {
  user: { label: "User folder", icon: "home", help: "Tasks, habits and stats stay in your user folder. The vault holds only notes." },
  vault: { label: "Vault, visible", icon: "folder", help: "A Leonote folder inside the vault: Obsidian sees it and it travels with the vault." },
  "vault-hidden": { label: "Vault, hidden", icon: "eye", help: "A .leonote folder inside the vault: it travels with the vault, and both apps hide it." },
};

/** Where media lives when its field in Settings is left empty. */
export const MEDIA_DIRS = { imageFolder: "Utilities/Media/Images", compressedImageFolder: "Utilities/Media/ImagesCompressed", videoFolder: "Utilities/Media/Videos", audioFolder: "Utilities/Media/Music", docFolder: "Utilities/Media/Documents", playlistFolder: "Utilities/Media/Playlists" };
export const DEFAULTS = {
  theme: "dark",
  accent: "amber",
  fontSize: 16,
  lineWidth: "normal",
  editorFont: "inter",
  headingStyle: "accent",
  headingSize: "normal",
  livePreview: true,
  spellcheck: false,
  scriptMenu: true, // "Read as script" in the menus of a note, its tab and its row in the tree
  // the bar that floats over selected text, and how a highlight is painted
  formatBar: true,
  // the player: how big a video is, and where the little window sits
  playerVideoSize: "small",
  onlineRemoveAsk: true, // the trash on an online card asks first
  playerKeepPreviews: true, // online videos' pictures copied into <vault>/.leonote/previews as their tiles show (and when played)
  playerOpenedJoins: false, // a file opened while something plays stays in the queue (true) or plays and gives way (false)
  playerYtControls: true, // YouTube's own controls drawn over the picture (the big pause, its bar); off leaves the picture clean
  navSize: 31,
  youtubeAuth: {},
  vaultsExtra: [],
  vaultsHidden: [],
  vaultOrder: [],
  playerFloatPos: null,
  playerDockW: 0, // the docked player's width, 0 = the usual
  playerBrowser: true, // the browser in the Player's Online tab is open
  playerBrowserH: 520, // and this tall
  playerBrowserZoom: 40, // drawn smaller: the room is small
  playerBrowserZoomHosts: {}, // a site's own zoom, set with the browser's − and + and kept
  playerBrowserSound: true, // the Player's browser pages sound
  playerBrowserTake: "none", // a video opened in the Player's browser: "play" here at once, "add" to Online media only, "none"
  playerBrowserPause: true, // the page's own video stops when the Player plays
  veLibrary: true, // the video editor's library panel
  veLibTab: "reuse",
  phoneDest: "", // where "Move to computer" last put a phone's files
  phoneKind: "all",
  phoneThumbs: true, // the phone's own tiny thumbnails on the tiles
  phoneTile: 150,
  phoneFullPhoto: false, // opening a photo reads the whole of it (else its thumbnail, large)
  phoneVideoPreview: 0, // seconds of a video made watchable on a double-click: 0 off, -1 all of it
  phoneVideoThumbs: "phone", // "phone": its own thumbnails; "made": a frame made from each video (reads it whole)
  phoneSkipSystem: true, // the whole-phone scan leaves out Android's own and hidden folders
  phoneMode: "folders",
  phoneTintNames: true, // tiles whose names share a shape (a camera's VID2026…) share a tint
  phoneMarkBig: false, // a glow on the tiles of big files (10-100 MB, over 100 MB)
  captionLang: "", // the video editor's captions from speech: the language spoken ("" finds it)
  phoneFindSort: "new", // the phone's Search: newest | oldest | big | small | name | folder | kind
  phoneFindList: false,
  phoneHideDeleted: false, // after deleting on the phone, files go from the list (else they stay, marked deleted) // the drawer: folders | photos | videos | largest | dupes | compress
  phonePicking: false,
  phoneCompress: null, // the last compress choices: { codec, level, photo } // the Phone view's Select mode: a click picks instead of opening
  phoneSort: "date",
  playerTileSize: 210, // the Online tiles' width, px
  ytPushQueue: [], // changes waiting to be sent to YouTube playlists
  cornerHoverResets: true, // a corner card hovered gets its whole time again
  treeRootIndent: 8, // px the whole tree starts from
  splitSide: "right",
  ribbonGap: "small",
  highlightStyle: "marker",
  taskPrio: "plain", // the line beside a task with a priority: plain (none, the wash only), glow, fade, edge, corner, underline, thick
  // "auto" means nobody has chosen: boot turns it into full or reduced
  // depending on the system's prefers-reduced-motion. See util.js resolveMotion.
  motion: "auto",
  dailyFolder: "Diary",
  newNoteDir: "current",
  newNoteFolder: "",
  templateFolder: "Templates",
  zettelFolder: "Zettelkasten",
  referenceFolder: "Reference Notes",
  agentToasts: true,
  closeToTray: true,
  settingsInVault: true, // the look, the tabs, the folders, the bookmarks: in <vault>/.leonote/settings.json, each vault its own
  tabMinWidth: 90,
  tabGap: 3,
  newTabAt: "end",
  linkTabAt: "after",
  linkTabBackground: false, // a link opened in a new tab stays behind; the tab you are on keeps the front // a link opened in a new tab: "after" the current one (as browsers do), or at the "end"
  spaceProjects: {},
  spaceSidebar: {},
  projectSettings: {},
  projectSidebarFirst: true,
  spacesLayout: "stack",
  spacesPopH: 0,
  spacesSplit: 0.5,
  spacesGitInfo: true,
  deletedSpaces: [],
  activeTabColor: "",
  tabGroupNames: false,
  tabColorStyle: "glow",
  tabGroupOnDrop: "hold",
  showAllFiles: true,
  navHidden: [],
  imageFormat: "webp",
  imageQuality: 80,
  trashKeepDays: 30,
  trashMode: "trash",
  imageMaxSide: 1600,
  imagePasteWidth: 420, // a pasted picture's width in the note; 0 = as wide as the text
  imagePasteSide: "left", // where a pasted picture sits: "" in the flow, "left" or "right" with the text beside it
  linkPreviews: false, // a card under a link that stands on its own line
  webPictures: "click", // a picture on the web in a note: loaded on a click, or "always"
  noteYtPreviews: true, // a YouTube link on its own line shows the video's picture and title (asked of YouTube when the note is shown)
  floatContain: true, // a picture beside text kept inside its own line (no jump when a tall one scrolls away)
  codeWrap: true, // long lines wrap in code and text files (the Wrap button there, remembered for all of them)
  csvAsText: false, // a .csv opens as a table (false) or as its raw text
  noteIds: true, // a linked note gets `id:` in its header: found again, links mended, if renamed outside the app
  linkOpen: "tab", // "browser": your default browser; "tab": a Leonote tab
  linkAutoTitle: true, // a pasted address becomes [the page's title](address)
  webHistoryFoldHosts: ["youtube.com"], // sites that keep only their last visit in the history
  imageFolder: "", // empty = MEDIA_DIRS, like the three below
  compressedImageFolder: "",
  videoFolder: "", // where videos pasted into notes go; empty = with the pictures
  audioFolder: "",
  docFolder: "", // documents and code dropped in (pdf, docx, md, code…); empty = MEDIA_DIRS
  playlistFolder: "", // where the Player exports .m3u8 playlists; empty = MEDIA_DIRS
  aiInline: true, // the note menu's Assistant answers in a card beside the text
  aiKeepChats: true, // every card's thread kept as a note in AI_Chats
  webMemWarnGB: 2, // a page using more than this many GB is pointed out, with a way to stop it; 0 = never
  playerBrowserRestore: true, // the Player's browser tabs come back next start
  dropInto: "ask",
  importClashAsk: true, // a file arriving under a name its folder already has: a dialog says what it becomes // a file dropped or opened from outside: "ask" (a card offers), "vault" (straight into its media folder), "outside" (stays where it is) // the same for music
  imageInvertDark: false,
  imageLayout: "column",
  uiSounds: true,
  compressReplace: false,
  uiSoundVolume: 35,
  cornerSecs: 6,
  gameNotices: false, // messages for a level, a challenge met, the day's streak
  taskAddOptions: true, // the options under the task box while writing one (mine/AI's, priority, due)
  aiTaskGrace: 1, // minutes before a task given to AI reaches agents
  tasksDefaultOwner: "human",
  pasteUndoTrash: true, // Ctrl+Z right after a paste takes the saved picture to the trash as well
  pictureDelete: "link", // Delete on a picture in a note: "link" (the file stays) or "trash" (the file goes to the trash too)
  pictureDeleteAsk: true, // Delete asks which, each time; off: it does the usual one at once
 // how long a card at the top right stays (a pasted picture's size, a file opened from outside)
  navRibbon: true,
  navOrder: [],
  tabReplaceKinds: [],
  hiddenPaths: [],
  showHidden: false,
  showDotFolders: false, // .leonote, .trash, .obsidian and the like at the foot of the tree - for looking, and opening as outside files
  treeFontSize: 13.5,
  treeRowHeight: "cozy",
  treeIndent: 14,
  treeFolderWeight: "medium",
  treeDimFiles: false,
  treeShowExt: "other",
  treeExtStyle: "tag",
  treeCounts: true,
  treeFolderIcons: false,
  treeGuides: false,
  treeAutoReveal: false,
  treeAccordion: false,
  treeExpandAll: "previous", // Expand all folders: "previous" = the ones open before Collapse all, "all" = every folder
  treePhoneButton: true, // a Phone button in the file tree's header (its menu hides it)
  folderStyles: { Diary: { dim: true, size: "xs" } },
  settingsInRibbon: false,
  spacesAt: ["titlebar"],
  boardsFolder: "",
  backupIncludeVault: true,
  backupCompression: "balanced",
  backupPlans: [], // what to back up, how often, ask or auto - see backupplans.js
  backupDir: "",
  historyCopies: 60, // task-list history folders kept (one per compaction; a launch and an exit each make one) // where plans put their zips; empty = a Leonote Backups folder beside the vault
  dailyMode: "yearly",
  yearlyPath: "Diary/{YYYY}.md",
  dailyHeading: "# {DD}.{MM}.{YYYY}",
  dailyInsert: "bottom",
  launchAtLogin: false,
  sidebar: true,
  rightPanel: true,
  sidebarWidth: 256,
  rightPanelWidth: 276,
  pinned: [],
  expanded: [],
  recent: [],
  // "This PC" search: extra folders to index, on top of the defaults
  pcSearchRoots: [],
  // web panels: shortcuts you added yourself; nothing is preconfigured
  webShortcuts: [],
  webBookmarks: [],
  webHistory: [],
  webHistoryOn: true,
  pwOffer: true, // a sign-in in a web tab: offer to keep it in the vault
  pwNever: [], // sites never asked about
  webPasswords: false, // the browser's own password saving (WebView2, encrypted by Windows) - off until the user turns it on
  webSearch: "google",
  tabSleepMin: 1, // minutes a browser tab is out of sight before it sleeps (its page paused, memory given back); 0 never
  tabAwakeMax: 10, // browser tabs kept awake at once; past that the longest unseen sleep at once; 0 no limit
  downloadHosts: [], // sites whose downloads go without the dialog (its "always" tick adds one)
  calWeekStart: 1, // the Calendar's first column: 1 Monday, 0 Sunday
  calHide: [], // sources left out of the Calendar: tasks, recurring, daily, google
  googleClientId: "", // the user's own Google app (an OAuth client of type Desktop app), for Google Calendar
  googleClientSecret: "",
  // ponytail: kept plain in this computer's settings (a quota key, not a sign-in); seal it if it ever opens more
  ytApiKey: "", // the Store build: the user's own YouTube Data API key
  gcal: null, // the Google Calendar sign-in: { access, refresh, expires, who, calendars, show, push }
  fitUnit: "kg", // what a bare weight means in the Workout view: kg or lb
  foodKcalGoal: 2000, // the Food tab's daily bar; 0 hides it
  fastHours: 16, // hours a fast is meant to last
  deskBreaks: false, // the Timer names something to do in each break (deskbreak.js)
  deskBreakAuto: false, // true: each break is ticked on trust, to be unticked if skipped
  deskBreakKinds: ["move", "eyes", "water"],
  deskMoves: [], // exercises of one's own for the breaks: { ex, need, reps, dur, w, unit }
  deskRemindMins: 0, // eyes and water every so many minutes of a running work block; 0 never
  deskDefaults: {}, // an exercise's numbers made its default (keyOf name -> { reps, dur, w, unit }), over last time's
  deskVoice: true, // a voice says the break and what it asks for (web/voice), and counts a timer's end down
  deskPopStay: false, // the desktop break card stays until closed (no running-down line)
  deskPopOut: true, // with Leonote minimized or in the tray, a break shows in a small window at the top right (breakpop.html)
  deskEquipment: [], // of mat, dumbbells, bar, band, kettlebell, barbell, bench
  deskPreset: "", // a ready-made set from deskbreak.js PRESETS ("oleks", "home", ...): its exercises only, "" = the built-in list
  fitAutoRest: 0, // seconds of rest started by itself after every set logged; 0 only by hand
  speech: { provider: "local", tier: "fast", lang: "", prompt: "" }, // the mic's ears: Whisper on this computer by default (free, private; installed on the first click): Windows, or a cloud model and which of its two
  webCustomEngines: [], // [{ id, label, url with %s }] - your own, beside the built-in ones
  webQuick: null, // the engine chips under the box; null = the usual row
  webBoxEngine: "lens", // the button at the end of the box
  webBoxEngineOn: true,
  webActsHidden: [], // start page buttons put away
  webActsOrder: [],
  webActsExtra: [], // parts of Leonote put on the buttons row: "v:<view>" // the buttons row in your order; "m:<url>" is a bookmark shown there
  webGroups: [], // bookmark groups on the start page
  webBaseGroup: null, // the base group's folded/wide/colour
  webMarkInto: "",
  webMarksOff: false, // no bookmarks section on the start page
  webExtIcons: {}, // add-on id -> a data URL of the icon you chose
  webExtPinned: [], // add-ons shown on the browser's bar (the rest wait under the puzzle piece)
  webExtOrder: [], // the pinned ones, in your order
  webExtPopSize: null, // { w, h } of an add-on's popup, once you resized it
  webExtPopZoom: 80, // the popup's own zoom, in percent
  webExtAutoUpdate: false, // on demand by default: Check for updates; switched on, the add-ons are looked at once a day and updated in place
  webExtCheckedAt: 0,
  workFolder: "Workplace",
  launchDelay: 0, // seconds Leonote waits after login before starting (launch at login only)
  docsFolder: "Docs", // the Docs hub: ready texts, a folder of notes; each folder in it a category
  quickNoteDir: "",
  quickSketchDir: "",
  quickBoardDir: "",
  quickDrawingDir: "",
  quickAnimationDir: "",
  newTabWallpaper: "lion",
};

/**
 * Defaults that changed after people already had settings saved: moved over
 * once, at start (not when the Settings page happens to be opened).
 */
export function migrateSettings(app) {
  const S = app.settings;
  // the mic moved to a cloud model by default; a saved "windows" from before follows once
  if (S.speech && S.speech.provider === "windows" && !S.speechV) { app.setSetting("speechV", 1); app.setSetting("speech", { ...S.speech, provider: "groq" }); }
  // Whisper on this computer became the default: the old default (Groq) moves over once; a chosen OpenAI, Mistral or Windows stays
  if ((S.speechV || 0) < 2) { app.setSetting("speechV", 2); if (!S.speech || S.speech.provider === "groq") app.setSetting("speech", { ...(S.speech || {}), provider: "local" }); }
  // pictures beside text stay in their line by default now (the note no longer corrects scrolling twice): on once for everyone
  if (!S.floatContainV) { app.setSetting("floatContainV", 1); app.setSetting("floatContain", true); }
  // a link opened in a Leonote tab goes to it
  if ((Number(S.linkGoV) || 0) < 2) { app.setSetting("linkGoV", 2); app.setSetting("linkTabBackground", false); }
  if (S.linkOpen === "browser" && !S.linkOpenV) { app.setSetting("linkOpenV", 1); app.setSetting("linkOpen", "tab"); }
}

export function mountSettings(app, el) {
  const S = app.settings;

  // Long groups start folded. What the user folds or opens is remembered.
  // the page in categories; what is not everyday starts folded
  const CATEGORIES = [
    ["Look and feel", ["Appearance", "Tabs", "Editor", "File tree", "Sounds", "Notices"]],
    ["Notes and files", ["Files", "Where new things go", "Daily notes", "Images", "Media folders", "Trash", "Zettelkasten"]],
    ["Browser and Player", ["Browser", "Passwords", "Browser add-ons", "Player"]],
    ["Life", ["Calendar", "Workout"]],
    ["AI", ["Jev", "Assistant", "Speech recognition", "AI agents", "Claude Code"]],
    ["Data", ["Backup and moving to another computer", "Outposts", "Search on this PC"]],
    ["App", ["Start and close", "Plugins", "Optional modules", "Keyboard", "About"]],
  ];
  // what each category and group is, at a glance
  const CAT_ICON = { "Look and feel": "palette", "Notes and files": "fileText", "Browser and Player": "globe", "Life": "heart", "AI": "sparkles", "Data": "archive", "App": "settings" };
  const GROUP_ICON = {
    Appearance: "palette", Tabs: "layers", Editor: "edit", "File tree": "folder", Sounds: "volume", Notices: "bell",
    Files: "file", "Where new things go": "filePlus", "Daily notes": "calendar", Images: "image", "Media folders": "film", Trash: "trash", Zettelkasten: "graph",
    Browser: "globe", Passwords: "key", "Browser add-ons": "puzzle", Plugins: "puzzle", Player: "music",
    Calendar: "calendar", Workout: "dumbbell",
    Jev: "bolt", Assistant: "aiBot", "Speech recognition": "mic", "AI agents": "code", "Claude Code": "sparkles",
    "Backup and moving to another computer": "archive", Outposts: "outside", "Search on this PC": "search",
    "Start and close": "rotateRight", "Optional modules": "download", Keyboard: "keyboard", About: "heart",
  };
  const shortName = (t) => t.replace(/ and moving to another computer$/, "");
  const OPEN_AT_FIRST = new Set(["Appearance", "Tabs", "Editor", "Files", "Where new things go", "Daily notes", "Browser", "Passwords", "Player", "Calendar", "Workout", "Jev", "Assistant", "Speech recognition", "Backup and moving to another computer", "Start and close"]);
  const FOLDED_AT_FIRST = CATEGORIES.flatMap(([, names]) => names).filter((n) => !OPEN_AT_FIRST.has(n));
  // the page as category cards (build 0715): every group starts folded, once, so a card opens onto a short list
  if ((S.settingsFoldedV || 0) === 2) { const all = CATEGORIES.flatMap(([, names]) => names); S.settingsFolded = all; app.setSetting("settingsFolded", all); app.setSetting("settingsFoldedV", 3); }
  if (!S.settingsFoldedV) { const all = CATEGORIES.flatMap(([, names]) => names).filter((n) => n !== "About"); S.settingsFolded = all; app.setSetting("settingsFoldedV", 4); app.setSetting("settingsFolded", all); }
  // About opens unfolded (once for everyone; folding it again is remembered)
  if (S.settingsFoldedV === 3) { const f = (S.settingsFolded || []).filter((n) => n !== "About"); S.settingsFolded = f; app.setSetting("settingsFolded", f); app.setSetting("settingsFoldedV", 4); }
  const foldedGroups = () => new Set(Array.isArray(S.settingsFolded) ? S.settingsFolded : FOLDED_AT_FIRST);
  const groups = []; // { title, sec } in page order, for the jump bar
  const aboutEl = aboutSection(app);
  const group = (title, desc, ...rows) => {
    const count = rows.flat().filter(Boolean).length;
    const sec = h("section", { class: "set-group" + (foldedGroups().has(title) ? " is-folded" : "") });
    const setFolded = (on) => {
      sec.classList.toggle("is-folded", on);
      // unfolding: the rows come in (the Animations setting decides how much)
      if (!on) { sec.classList.add("is-opening"); clearTimeout(sec._opening); sec._opening = setTimeout(() => sec.classList.remove("is-opening"), 600); }
      const f = foldedGroups();
      on ? f.add(title) : f.delete(title);
      app.setSetting("settingsFolded", [...f]);
    };
    // unfolding a group opens its category card too (a link to "Settings › Player" lands on it, open)
    sec.unfold = (searching) => { if (sec.card && !searching) sec.card.open(); if (sec.classList.contains("is-folded")) setFolded(false); };
    sec.dataset.group = title;
    sec.append(
      h("button", { class: "set-group-head", title: "Fold or unfold this group", onclick: () => setFolded(!sec.classList.contains("is-folded")) },
        h("span", { class: "set-group-ico" }, icon(GROUP_ICON[title] || "settings")), h("h2", { text: shortName(title) }), count > 1 ? h("span", { class: "set-group-count", text: `${count} options` }) : null, icon("chevronDown", "set-group-caret")),
      ...(desc ? [h("p", { class: "set-desc", text: desc })] : []),
      h("div", { class: "set-rows" }, rows));
    groups.push({ title, sec });
    return sec;
  };

  /**
   * A row too big to leave open: folded until asked for, with a small preview
   * of what is inside. `build` runs on the first unfold, so a folded panel
   * costs nothing; `preview` returns text or nodes and is asked again on fold.
   */
  function foldRow(label, hint, preview, build) {
    let built = false;
    const pv = h("span", { class: "set-fold-preview" });
    const body = h("div", { class: "set-fold-body", hidden: true });
    const paint = () => pv.replaceChildren(...[].concat(preview()).filter((x) => x != null && x !== ""));
    const el = h("div", { class: "set-row is-stack is-fold" });
    const toggle = () => {
      const open = body.hidden;
      if (open && !built) { body.append(build(paint)); built = true; }
      body.hidden = !open;
      el.classList.toggle("is-open", open);
      paint();
    };
    el.append(h("button", { class: "set-fold-head", onclick: toggle },
      h("div", { class: "set-label" }, h("div", { text: label }), hint ? h("div", { class: "set-hint", text: hint }) : null),
      pv, icon("chevronDown", "set-fold-caret")), body);
    paint();
    return el;
  }

  function activeTabColor() {
    const cb = colorBlock({ get: () => (/^#[0-9a-f]{6}$/i.test(S.activeTabColor || "") ? S.activeTabColor : null), set: (c) => { app.setSetting("activeTabColor", c || ""); cb.paint(); } });
    cb.paint();
    return h("div", { class: "set-colorblock" }, cb.row, cb.picker);
  }

  /* The folders kept out of the index (the setting noIndex, vault-relative): chips to take one off, a button to
     add one. Leonote reads the list at start, so a change asks for a restart. */
  function noIndexList() {
    const box = h("div", { class: "set-btns set-noindex" });
    const list = () => (Array.isArray(S.noIndex) ? S.noIndex : []);
    const save = async (next) => {
      app.setSetting("noIndex", next);
      await app.host.noIndexSet(next).catch(() => {});
      paint();
      app.toast("Leonote reads this list as it starts", { ms: 8000, action: { label: "Restart now", run: () => app.host.restart() } });
    };
    const paint = () => box.replaceChildren(
      ...list().map((f) => h("span", { class: "chip", title: f }, icon("folder"), f,
        h("button", { class: "icon-btn", title: "Index it again", onclick: () => save(list().filter((x) => x !== f)) }, icon("x")))),
      h("button", { class: "btn", onclick: async () => {
        let picked = null;
        try { picked = await app.host.dialogOpen({ directory: true, multiple: false, title: "A folder of the vault to leave out of the index", defaultPath: app.vault.root }); } catch {}
        if (!picked) return;
        const root = String(app.vault.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
        const abs = String(picked).replace(/\\/g, "/");
        if (!root || abs.toLowerCase().indexOf(root.toLowerCase() + "/") !== 0) return app.toast("Pick a folder inside the vault", { kind: "error" });
        const rel = abs.slice(root.length + 1);
        if (!list().some((x) => x.toLowerCase() === rel.toLowerCase())) save([...list(), rel]);
      } }, icon("plus"), "Add folder…"));
    paint();
    return box;
  }
  const row = (label, hint, control, cls) =>
    h("div", { class: "set-row" + (cls ? " " + cls : "") }, h("div", { class: "set-label" }, h("div", { text: label }), hint ? h("div", { class: "set-hint", text: hint }) : null), h("div", { class: "set-ctl" }, control));

  // `now` lets a setting show what is actually in force rather than what is
  // stored - Animations keeps "auto" on disk so the system preference goes on
  // being honoured, but the buttons must still show which mode is running.
  function seg(key, options, now) {
    const wrap = h("div", { class: "segmented is-small" });
    const paint = () => { const v = String(now ? now() : S[key]); for (const b of wrap.children) b.classList.toggle("is-active", b.dataset.v === v); };
    for (const [v, label] of options) wrap.append(h("button", { class: "seg", dataset: { v: String(v) }, onclick: () => { app.setSetting(key, v); paint(); } }, label));
    paint();
    return wrap;
  }

  function toggleLabeled(key, label) {
    return h("label", { class: "set-inline" }, toggle(key), h("span", { text: label }));
  }

  // Jev's questions go to TypeSafe (your key) or to Laya, the open model of the same kind, on this computer
  function jevWhere() {
    const J = app.jev;
    const where = h("div", { class: "segmented is-small" });
    const keyRow = row("Key", "Your TypeSafe key, from console.typesafe.ai", jevKey());
    const addr = h("input", { class: "text-input", spellcheck: false, placeholder: "http://127.0.0.1:8000", style: { width: "220px" } });
    addr.addEventListener("keydown", (e) => e.stopPropagation());
    addr.addEventListener("change", () => J.setBackend("laya", addr.value.trim()).catch((e) => app.toast(String(e), { kind: "error" })));
    const ckpt = h("div", { class: "segmented is-small" });
    const test = h("button", { class: "btn" }, icon("bolt"), "Test");
    test.addEventListener("click", async () => {
      test.disabled = true;
      try {
        const r = await J.ask("I was billed twice this month, please refund one", { dept: { type: "choice", instructions: "Which team should take this?", criteria: { billing: "money, refunds, invoices", tech: "bugs and crashes" } } });
        const a = (r.answers || {}).dept || {};
        app.toast(`${J.name()} answered “${a.choice}” (${Math.round((a.confidence || 0) * 100)}% sure) in ${r.latency_ms} ms`, { ms: 4200 });
      } catch (e) { app.toast(String(e), { kind: "error", ms: 7000 }); }
      test.disabled = false;
    });
    const layaRows = [
      row("Laya's address", "Where laya-serve listens. On this computer by default; an address elsewhere must be https, and Leonote asks before sending Laya's key and notes there.", addr),
      row("Laya's model", "English (421M) or 100+ languages (322M); its default when unsure.", ckpt),
      row("Laya's key", "Only needed if your own Laya server asks for a key. Laya started from here needs none.",
        jevKey("laya", { name: "Laya", placeholder: "The LAYA_API_KEY your server uses", where: "Sent only to Laya's address above.", none: "Leave it empty for a server without a key" })),
      row("Laya", "Needs Python 3.10 or newer. Install it once, then start it; it listens on this computer only. The first start downloads the model (1-2 GB).",
        h("div", { class: "set-btns" },
          h("button", { class: "btn", onclick: () => app.host.layaInstall().then(() => app.toast("Installing Laya in its own window", { ms: 3000 })).catch((e) => app.toast(String(e), { kind: "error" })) }, icon("download"), "Install"),
          h("button", { class: "btn", onclick: () => app.host.layaStart().then(() => app.toast("Laya is starting in its own window - give it a moment to load", { ms: 3600 })).catch((e) => app.toast(String(e), { kind: "error" })) }, icon("play"), "Start"),
          test)),
    ];
    const paint = () => {
      const b = J.backend();
      for (const x of where.children) x.classList.toggle("is-active", x.dataset.v === b.backend);
      keyRow.hidden = b.backend === "laya";
      for (const r of layaRows) r.hidden = b.backend !== "laya";
      if (document.activeElement !== addr) addr.value = b.base || "";
      for (const x of ckpt.children) x.classList.toggle("is-active", x.dataset.v === (b.model || ""));
    };
    for (const [v, label] of [["typesafe", "TypeSafe - your key"], ["laya", "Laya - on this computer"]])
      where.append(h("button", { class: "seg", dataset: { v }, onclick: () => J.setBackend(v).then(paint).catch((e) => app.toast(String(e), { kind: "error" })) }, label));
    for (const [v, label] of [["", "Its default"], ["laya", "English"], ["laya-multilingual", "100+ languages"]])
      ckpt.append(h("button", { class: "seg", dataset: { v }, onclick: () => J.setBackend("laya", J.backend().base, v).then(paint) }, label));
    J.refresh().then(paint);
    app.bus.on("jev-backend", paint);
    paint();
    return [row("Where it runs", "TypeSafe's Jev in the cloud with your key, or Laya on your own computer: free and private, a little less accurate.", where), keyRow, ...layaRows];
  }

  function toggle(key) {
    const b = h("button", { class: "switch", role: "switch" });
    const paint = () => { b.classList.toggle("is-on", !!S[key]); b.setAttribute("aria-checked", String(!!S[key])); };
    b.addEventListener("click", () => { app.setSetting(key, !S[key]); paint(); });
    paint();
    return b;
  }

  // File associations live in the registry, not in settings: the switch asks
  // the backend what it is now, and flips it back if the change fails.
  function assocToggle(exts) {
    const b = h("button", { class: "switch", role: "switch", "aria-checked": "false", title: "Registers Leonote for these files under your own user account" });
    const paint = (on) => { b.classList.toggle("is-on", !!on); b.setAttribute("aria-checked", String(!!on)); };
    app.host.associateState(exts).then(paint).catch(() => {});
    b.addEventListener("click", async () => {
      const want = !b.classList.contains("is-on");
      paint(want);
      try {
        paint(await app.host.associateFiles(exts, want));
      } catch (e) {
        paint(!want);
        app.toast("Could not change the file associations: " + e, { kind: "error" });
      }
    });
    return b;
  }

  // Every design shown as it will look, with the same words in each card so
  // the difference you see is the design and nothing else.
  function headingPicker() {
    const wrap = h("div", { class: "hs-grid" });
    const paint = () => { for (const b of wrap.children) b.classList.toggle("is-active", b.dataset.v === S.headingStyle); };
    for (const [v, label, hint] of HEADING_STYLES) {
      wrap.append(h("button", { class: "hs-card", title: hint, dataset: { v, headings: v }, onclick: () => { app.setSetting("headingStyle", v); paint(); } },
        h("span", { class: "hs-paper" },
          h("span", { class: "hs-h hs-1", text: "Chapter" }),
          h("span", { class: "hs-line" }),
          h("span", { class: "hs-line is-short" }),
          h("span", { class: "hs-h hs-2", text: "A section" }),
          h("span", { class: "hs-line" }),
          h("span", { class: "hs-line is-short" }),
          h("span", { class: "hs-h hs-3", text: "Detail" }),
          h("span", { class: "hs-line" }),
          h("span", { class: "hs-h hs-4", text: "Point" }),
          h("span", { class: "hs-h hs-5", text: "Note" }),
          h("span", { class: "hs-line is-short" })),
        h("span", { class: "hs-name", text: label })));
    }
    paint();
    return wrap;
  }

  // every colour, named, a grid that opens under its row; the ranks' colours dimmed until reached
  function accents(repaint) {
    const level = app.stats ? app.stats.level : 0;
    const wrap = h("div", { class: "accent-grid" });
    const paint = () => { for (const b of wrap.children) b.classList.toggle("is-active", b.dataset.v === S.accent); };
    for (const [k, c] of Object.entries(ACCENTS)) {
      const lock = ACCENT_UNLOCKS[k];
      const shut = lock && level < lock[1];
      wrap.append(h("button", { class: "accent-pick" + (shut ? " is-locked" : ""), dataset: { v: k }, style: { "--c": c }, disabled: !!shut,
        title: shut ? `Unlocked at ${lock[0]} (level ${lock[1]})` : lock ? `From reaching ${lock[0]}` : "",
        onclick: () => { app.setSetting("accent", k); paint(); if (repaint) repaint(); } },
        h("i"), h("span", { text: k }), lock ? h("small", { text: shut ? `${lock[0]}` : lock[0] }) : null));
    }
    paint();
    return wrap;
  }

  // the six as they always were, in the row; "All colours" opens every one, the ranks' too, below it
  function accentRow() {
    const grid = h("div", { class: "set-row accent-more", hidden: true });
    const inline = h("div", { class: "swatches" });
    const paint = () => { for (const b of [...inline.children, ...grid.querySelectorAll("[data-v]")]) b.classList.toggle("is-active", b.dataset.v === S.accent); };
    for (const [k, c] of Object.entries(ACCENTS)) if (!ACCENT_UNLOCKS[k] || S.accent === k)
      inline.append(h("button", { class: "swatch", title: k, dataset: { v: k }, style: { "--c": c }, onclick: () => { app.setSetting("accent", k); paint(); } }));
    const more = h("button", { class: "swatch-more", onclick: () => {
      grid.hidden = !grid.hidden;
      if (!grid.hidden && !grid.children.length) grid.append(accents(paint));
      more.textContent = grid.hidden ? "All colours" : "Fewer";
      paint();
    } }, "All colours");
    inline.append(more);
    paint();
    return [row("Accent", null, inline), grid];
  }

  function slider(key, min, max, unit, step = 1) {
    const out = h("span", { class: "slider-val" });
    const input = h("input", { type: "range", min, max, step, value: S[key], class: "slider" });
    const paint = () => { out.textContent = S[key] + unit; };
    input.addEventListener("input", () => { app.setSetting(key, Number(input.value)); paint(); });
    paint();
    return h("div", { class: "slider-wrap" }, input, out);
  }

  // several options on at once, stored as a list
  function chips(key, options) {
    const wrap = h("div", { class: "segmented is-small is-multi" });
    const paint = () => { const on = S[key] || []; for (const b of wrap.children) b.classList.toggle("is-active", on.includes(b.dataset.v)); };
    for (const [v, label] of options) wrap.append(h("button", { class: "seg", dataset: { v }, onclick: () => {
      const on = new Set(S[key] || []);
      on.has(v) ? on.delete(v) : on.add(v);
      app.setSetting(key, [...on]);
      paint();
    } }, label));
    paint();
    return wrap;
  }

  function hiddenHint() {
    const n = (S.hiddenPaths || []).length;
    return n ? `${n} hidden. Right-click one to unhide it, or unhide all here.` : "Nothing hidden. Right-click a file or folder and choose Hide.";
  }

  function text(key, placeholder, wide) {
    const input = h("input", { class: "text-input" + (wide ? " is-wide" : ""), value: S[key] || "", placeholder, spellcheck: false });
    input.addEventListener("change", () => app.setSetting(key, input.value.trim().replace(/^\/+|\/+$/g, "")));
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") input.blur(); });
    return input;
  }

  async function exportIcs() {
    const path = await app.host.dialogSave({ defaultPath: "Leonote.ics", filters: [{ name: "Calendar", extensions: ["ics"] }] });
    if (!path) return;
    try {
      await app.host.textSave(path, icsOf(app.tasks.all, app.recurring ? app.recurring.data.rules : [], Intl.DateTimeFormat().resolvedOptions().timeZone));
      app.toast("Saved " + path, { ms: 4000 });
    } catch (e) { app.toast(String(e.message || e), { kind: "error" }); }
  }

  /* ── Speech recognition (speech.js) ── */
  const sp = () => S.speech || { provider: "local", tier: "fast" };
  const setSp = (patch) => { app.setSetting("speech", { ...sp(), ...patch }); app.bus.emit("speech"); };
  // the free programs Leonote can use but does not come with: each one's state, and an install on a click
  function modulesList() {
    const MODS = [
      ["whisper", "Whisper", "Hears speech on this computer - captions and the video editor's AI. Nothing leaves the computer.", "About 150 MB"],
      ["ffmpeg", "ffmpeg", "Video export, GIFs, compressing a phone's videos, and the sound Whisper hears.", "About 100 MB"],
    ];
    const box = h("div", { style: { display: "contents" } });
    const paint = async () => {
      const t = app.host.onlineTools ? await app.host.onlineTools().catch(() => ({})) : {};
      box.replaceChildren(...MODS.map(([id, name, what, size]) => {
        const at = t[id];
        return row(name, `${what} ${at ? "Installed: " + at : size + ", not installed."}`, at
          ? h("button", { class: "btn btn-sm", onclick: () => app.host.externalReveal(at) }, "Show")
          : h("button", { class: "btn btn-sm btn-primary", onclick: async (e) => { e.currentTarget.disabled = true; await (await import("./tools.js")).installTool(app, id); paint(); } }, "Install"));
      }));
    };
    paint();
    return box;
  }
  function speechProvider() {
    const wrap = h("div", { class: "segmented is-small" });
    // the chosen ears say what they are under the name; the Model and Key rows show only for ears that have them
    const paint = () => {
      for (const b of wrap.children) b.classList.toggle("is-active", b.dataset.v === sp().provider);
      const x = speechOf(sp().provider), row = wrap.closest(".set-row");
      if (!row) return;
      const hint = row.querySelector(".set-hint");
      if (hint) hint.textContent = x.blurb || `A cloud model: the clip goes to ${x.name} with your own key (${x.keyHint}).`;
      const rows = [...row.parentElement.querySelectorAll(".set-row")];
      const at = rows.indexOf(row);
      if (rows[at + 1]) rows[at + 1].hidden = !x.models.fast;
      if (rows[at + 2]) rows[at + 2].hidden = !x.keyId;
    };
    for (const x of SPEECH) wrap.append(h("button", { class: "seg", dataset: { v: x.id }, title: x.blurb || x.keyHint || "", onclick: () => { setSp({ provider: x.id }); paint(); } }, x.name));
    requestAnimationFrame(paint);
    return wrap;
  }
  function speechTier() {
    const box = h("div", { class: "set-stack" });
    const paint = () => {
      const x = speechOf(sp().provider);
      if (!x.models.fast) { box.replaceChildren(h("span", { class: "set-hint", text: x.blurb })); return; }
      const seg = h("div", { class: "segmented is-small" },
        h("button", { class: "seg" + (sp().tier !== "best" ? " is-active" : ""), title: x.models.fast[1], onclick: () => setSp({ tier: "fast" }) }, "Fast and cheap"),
        h("button", { class: "seg" + (sp().tier === "best" ? " is-active" : ""), title: x.models.best[1], onclick: () => setSp({ tier: "best" }) }, "Most accurate"));
      box.replaceChildren(seg, h("span", { class: "set-hint", text: (sp().tier === "best" ? x.models.best : x.models.fast)[1] }));
    };
    paint(); app.bus.on("speech", paint);
    return box;
  }
  // a switch that is on until switched off (the setting is unset to begin with)
  function toggleOn(key) {
    const b = h("button", { class: "switch", role: "switch" });
    const paint = () => { const on = S[key] !== false; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); };
    b.addEventListener("click", () => { app.setSetting(key, S[key] === false); paint(); });
    paint();
    return b;
  }
  // a key for Jev (TypeSafe) or for a Laya server started with LAYA_API_KEY - sealed like the Assistant's
  function jevKey(id = "jev", { name = "Jev", placeholder = "Your TypeSafe API key", where = "Requests go to api.typesafe.ai from the app itself.", none = "console.typesafe.ai › API keys" } = {}) {
    const box = h("div", { class: "set-stack" });
    let have = false, hidden = false, key = "";
    const load = async () => {
      try { have = (await app.host.aiKeysHave()).includes(id); hidden = have && (await app.host.aiKeyHidden(id)); key = have && !hidden ? (await app.host.aiKeyGet(id)) || "" : ""; } catch {}
      paint();
    };
    const save = async (v) => {
      try { await app.host.aiKeySet(id, v); app.jev.refresh(); app.toast(v ? `${name} key saved - sealed for this Windows user` : `${name} key removed`, { ms: 2500 }); } catch (e) { app.toast(String(e), { kind: "error" }); }
      await load();
    };
    const paint = () => {
      // hidden for good: it works, and is never shown again
      if (hidden) {
        box.replaceChildren(h("div", { class: "set-btns" }, h("span", { class: "set-hint", text: `A key is saved and hidden for good - ${name} uses it, nobody sees it.` }),
          h("button", { class: "btn", onclick: async () => { const { askDialog } = await import("./ui.js"); const r = await askDialog(`Another ${name} key`, [{ key: "k", label: "The new key", type: "password" }], { ok: "Save" }); if (r && r.k.trim()) save(r.k.trim()); } }, icon("key"), "Replace"),
          h("button", { class: "btn", onclick: () => save("") }, "Remove")));
        return;
      }
      const i = h("input", { class: "text-input is-wide", type: "password", placeholder, spellcheck: false, value: key });
      const eye = h("button", { class: "icon-btn", title: "Show or hide the key", onclick: () => { i.type = i.type === "password" ? "text" : "password"; } }, icon("eye"));
      i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") save(i.value.trim()); });
      box.replaceChildren(
        h("div", { class: "set-btns" }, i, eye,
          h("button", { class: "btn", onclick: () => save(i.value.trim()) }, icon("key"), have ? "Save" : "Save key"),
          have ? h("button", { class: "btn", onclick: () => save("") }, "Remove") : null,
          have ? h("button", { class: "btn", title: "It goes on working; Leonote never shows it again - not here, not anywhere", onclick: async () => { const { confirmDialog } = await import("./ui.js"); if (!(await confirmDialog("Hide the key for good?", `${name} keeps working with it, but Leonote will never show it again. To change it later you paste a new one.`, { ok: "Hide it", danger: false, safe: true }))) return; await app.host.aiKeyHide(id); load(); } }, icon("lock"), "Hide for good") : null),
        h("span", { class: "set-hint", text: have ? `Saved, sealed on this computer for your Windows user. ${where}` : none }));
    };
    load();
    return box;
  }
  function speechKey() {
    const box = h("div", { class: "set-stack" });
    let have = new Set();
    const paint = () => {
      const x = speechOf(sp().provider);
      if (!x.keyId) { box.replaceChildren(h("span", { class: "set-hint", text: x.id === "local" ? "No key: Whisper listens on this computer (Settings › Optional modules)." : "No key: Windows listens by itself." })); return; }
      const has = have.has(x.keyId);
      const i = h("input", { class: "text-input is-wide", type: "password", placeholder: has ? "A key is saved - paste another to replace it" : x.keyHint, spellcheck: false });
      i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") save.click(); });
      const save = h("button", { class: "btn", onclick: async () => { try {
        // an empty box removes the saved key - only when asked, never by an Enter in the empty box
        const v = i.value.trim();
        if (!v && (!has || !(await confirmDialog("Remove the saved key?", "Speech recognition through " + x.name + " stops until a key is saved again. The key itself stays in your account there - paste it again to bring it back.", { ok: "Remove key", safe: true })))) return;
        await app.host.aiKeySet(x.keyId, v); i.value = ""; have = new Set(await app.host.aiKeysHave()); paint(); app.toast(v ? "Key saved - sealed for this Windows user" : "Key removed", { ms: 2500 }); } catch (e) { app.toast(String(e), { kind: "error" }); } } }, icon("key"), "Save key");
      box.replaceChildren(h("div", { class: "set-btns" }, i, save), h("span", { class: "set-hint", text: (has ? "Saved. " : "") + x.keyHint + `. Model now: ${modelFor(x, sp().tier)}.` }));
    };
    app.host.aiKeysHave().then((ids) => { have = new Set(ids); paint(); }).catch(() => paint());
    paint(); app.bus.on("speech", paint);
    return box;
  }

  /* ── Google Calendar (gcal.js) ── each block repaints when the sign-in changes */
  const onGcal = (paint) => { paint(); app.bus.on("gcal", paint); };
  function googleApp() {
    const field = (key, placeholder, type) => {
      const i = h("input", { class: "text-input is-wide", type, value: S[key] || "", placeholder, spellcheck: false });
      i.addEventListener("change", () => app.setSetting(key, i.value.trim()));
      i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") i.blur(); });
      return i;
    };
    // the secret goes into Windows' seal, never into settings, and is never shown again
    const secretField = () => {
      const i = h("input", { class: "text-input is-wide", type: "password", value: "", placeholder: "Client secret, if the client has one", spellcheck: false });
      app.host.aiKeysHave().then((ids) => { if (ids.includes("google-secret")) i.placeholder = "Client secret saved, sealed on this computer - type a new one to replace it"; }).catch(() => {});
      i.addEventListener("change", () => {
        const v = i.value.trim();
        if (!v) return;
        app.host.aiKeySet("google-secret", v).then(() => { i.value = ""; i.placeholder = "Client secret saved, sealed on this computer - type a new one to replace it"; app.setSetting("googleClientSecret", ""); },
          () => app.setSetting("googleClientSecret", v)); // no seal on this system: kept as before
      });
      i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") i.blur(); });
      return i;
    };
    return h("div", { class: "set-stack" },
      field("googleClientId", "Client ID  (….apps.googleusercontent.com)", "text"),
      secretField(),
      h("div", { class: "set-hint", text: GOOGLE_APP_NOTE }),
      h("div", { class: "set-btns" }, h("button", { class: "btn", onclick: () => app.host.openUrl(CONSOLE_PAGE) }, icon("globe"), "Google Cloud console")));
  }
  function googleAccount() {
    const box = h("div", { class: "set-btns" });
    let busy = false;
    const run = async (what, fn) => {
      if (busy) return;
      busy = true; paint();
      try { await fn(); } catch (e) { app.toast(String(e.message || e), { kind: "error", ms: 7000 }); }
      busy = false; paint();
    };
    const paint = () => {
      const g = app.gcal;
      if (g.connected()) box.replaceChildren(
        h("span", { class: "set-inline" }, icon("check"), `Signed in as ${g.who() || "Google"}`),
        h("button", { class: "btn", disabled: busy, onclick: () => run("reload", () => g.reloadCalendars()) }, icon("redo"), "Reload calendars"),
        h("button", { class: "btn", disabled: busy, onclick: () => run("disconnect", () => g.disconnect()) }, icon("x"), "Sign out"));
      else box.replaceChildren(h("button", { class: "btn", disabled: busy, onclick: () => run("connect", () => g.connect()) }, icon("globe"), busy ? "Waiting for your browser…" : "Sign in with Google"));
    };
    onGcal(paint);
    return box;
  }
  function ytAccount() {
    const box = h("div", { class: "set-btns" });
    let busy = false;
    const paint = () => {
      const y = app.ytPush;
      if (!y) return box.replaceChildren();
      if (y.connected()) box.replaceChildren(h("span", { class: "set-inline" }, icon("check"), `Signed in${y.who() ? " as " + y.who() : ""}`), h("button", { class: "btn", onclick: () => y.disconnect() }, icon("x"), "Sign out"));
      else box.replaceChildren(h("button", { class: "btn", disabled: busy, onclick: async () => {
        busy = true; paint();
        try { await y.connect(); } catch (e) { app.toast(String(e.message || e), { kind: "error", ms: 8000 }); }
        busy = false; paint();
      } }, icon("globe"), busy ? "Waiting for your browser…" : "Sign in to YouTube"));
    };
    paint();
    app.bus.on("ytpush", paint);
    return box;
  }
  function googleShown() {
    const box = h("div", { class: "set-stack" });
    const paint = () => {
      const g = app.gcal;
      const cals = g.calendars();
      if (!g.connected()) { box.replaceChildren(h("span", { class: "set-hint", text: "Sign in first." })); return; }
      if (!cals.length) { box.replaceChildren(h("span", { class: "set-hint", text: "No calendars found - try Reload calendars." })); return; }
      const shown = new Set(g.shown());
      box.replaceChildren(...cals.map((c) => {
        const cb = h("input", { type: "checkbox", checked: shown.has(c.id) });
        cb.addEventListener("change", () => { cb.checked ? shown.add(c.id) : shown.delete(c.id); g.setShown([...shown]); });
        return h("label", { class: "set-inline" }, cb, h("span", { class: "cal-dot", style: { "--c": c.color || "" } }), h("span", { text: c.name }));
      }));
    };
    onGcal(paint);
    return box;
  }
  function googlePush() {
    const sel = h("select", { class: "text-input" });
    sel.addEventListener("change", () => app.gcal.setPush(sel.value));
    sel.addEventListener("keydown", (e) => e.stopPropagation());
    const paint = () => {
      const g = app.gcal;
      const cals = g.calendars().filter((c) => c.writable);
      sel.replaceChildren(h("option", { value: "", text: "Nowhere" }), ...cals.map((c) => h("option", { value: c.id, text: c.name })));
      sel.value = cals.some((c) => c.id === g.push()) ? g.push() : "";
      sel.disabled = !g.connected();
    };
    onGcal(paint);
    return sel;
  }

  // a media folder left empty is the place Leonote gives it, shown faintly in the field
  const folderText = (key) => text(key, MEDIA_DIRS[key], true);

  /* switching vaults restarts the app: every path, watcher and index belongs to one vault */
  async function switchVault(anchor) {
    let list = [];
    try { list = await app.host.vaultCandidates(); } catch {}
    const here = String(app.vault.root || "").replace(/[\\/]+$/, "").toLowerCase();
    const isHere = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase() === here;
    menu(0, 0, [
      { header: "Obsidian vaults" },
      ...(list.filter((v) => v.exists).length
        ? list.filter((v) => v.exists).map((v) => ({ label: v.name, icon: "folder", checked: isHere(v.path), run: () => useVault(v.path, v.name) }))
        : [{ label: "No Obsidian vaults found", icon: "x", run: () => {} }]),
      "sep",
      { label: "Leonote vault (default)", icon: "home", checked: !S.vault, run: () => useVault(null, "Leonote") },
    ], { anchor });
  }

  async function useVault(path, name) {
    if (path && String(path).replace(/[\\/]+$/, "").toLowerCase() === String(app.vault.root || "").replace(/[\\/]+$/, "").toLowerCase()) return;
    if (path) S.vault = path;
    else delete S.vault;
    app.toast(`Opening ${name}… Leonote restarts`, { ms: 4000 });
    try {
      await app.flushAll();
      await app.host.saveSettings(S);
      await app.host.restart();
    } catch (e) {
      app.toast("Could not switch vault: " + e, { kind: "error" });
    }
  }

  /* Tasks, habits and stats can live in the vault, so Obsidian sees them and
     they travel with it. Switching moves the data, then restarts. */
  function dataDirMenu(anchor) {
    const cur = app.dataDir || "user";
    menu(0, 0, [
      { header: "Leonote data lives in" },
      ...Object.entries(DATA_DIRS).filter(([mode]) => mode !== "vault" || cur === "vault").map(([mode, d]) => ({ label: d.label, icon: d.icon, checked: mode === cur, run: () => moveData(mode, d) })),
    ], { anchor });
  }

  async function moveData(mode, d) {
    if (mode === (app.dataDir || "user")) return;
    app.toast(`Moving data to ${d.label}… Leonote restarts`, { ms: 4000 });
    try {
      await app.flushAll();
      await app.host.dataDirSet(mode);
      await app.host.restart();
    } catch (e) {
      app.toast("Could not move the data: " + e, { kind: "error" });
    }
  }

  /* ── Zettelkasten ──────────────────────────────────────────────────────
     One button, and it says beforehand exactly what it will touch. It never
     overwrites a file: anything already there is left as it is. */
  function zettelHint() {
    const p = app.zettel.plan();
    if (p.nothingToDo) return "Everything is already in place. Running it again would change nothing.";
    const bits = [];
    if (p.folders.create.length) bits.push(`create ${p.folders.create.join(", ")}`);
    if (p.files.create.length) bits.push(`write ${p.files.create.map((f) => f.path).join(", ")}`);
    if (p.settings.newNoteFolder) bits.push(`send new notes to ${p.settings.newNoteFolder}`);
    if (p.settings.imageFolder) bits.push(`send attachments to ${p.settings.imageFolder}`);
    const kept = [...p.folders.skip, ...p.files.skip];
    return `Will ${bits.join(", ")}.${kept.length ? ` Leaves alone: ${kept.join(", ")}.` : ""}`;
  }

  function runZettelSetup(e) {
    const hint = e.currentTarget.closest(".set-row").querySelector(".set-hint");
    app.zettel.setup().then(() => { if (hint) hint.textContent = zettelHint(); });
  }

  function folderLooksHint() {
    const n = Object.keys(S.folderStyles || {}).length;
    return n ? `${n} folder${n === 1 ? "" : "s"} customized` : "No folders customized yet";
  }

  /* "This PC": which folders the name index walks. The defaults are shown so
     nobody has to guess what is already covered; only the ones you added can
     be taken away again. */
  function outpostsPanel(repaint) {
    const box = h("div", { class: "pc-roots" });
    const paint = () => {
      const list = outpostList(app);
      box.replaceChildren(...(list.length ? list.map((o) => h("div", { class: "pc-root is-mine is-outpost" }, icon("outside"),
        h("span", { class: "pc-root-path", title: o.path }, h("b", { text: o.name || o.path }), "  ", o.path),
        h("span", { class: "pc-root-tag", title: "Outposts are never part of a backup", text: "not in backups" }),
        h("button", { class: "icon-btn", title: "Show in Explorer", onclick: () => app.host.externalReveal(o.path).catch((e) => app.toast(String(e), { kind: "error" })) }, icon("reveal")),
        h("button", { class: "icon-btn", title: "Unhook - the folder itself stays where it is", onclick: () => { removeOutpost(app, o.path); paint(); repaint(); } }, icon("x"))))
        : [h("span", { class: "set-hint", text: "No outposts yet." })]));
    };
    paint();
    return h("div", { class: "pc-roots-wrap" }, box, h("div", { class: "set-btns" },
      h("button", { class: "btn", onclick: async () => { await addOutpost(app); paint(); repaint(); } }, icon("folderPlus"), "Hook up a folder…")));
  }

  function pcRootsPanel() {
    const box = h("div", { class: "pc-roots" });
    const stat = h("div", { class: "set-hint pc-roots-stat" });
    const extras = () => S.pcSearchRoots || [];
    const same = (a, b) => String(a).replace(/[\\/]+$/, "").toLowerCase() === String(b).replace(/[\\/]+$/, "").toLowerCase();

    const paint = async () => {
      let defaults = [];
      try {
        defaults = (await app.host.pcRoots([])).defaults || [];
      } catch (e) {
        return box.replaceChildren(h("span", { class: "set-hint", text: String(e) }));
      }
      const rows = defaults.map((p) => h("div", { class: "pc-root" }, icon("folder"), h("span", { class: "pc-root-path", text: p }), h("span", { class: "pc-root-tag", text: "default" })));
      for (const p of extras()) {
        if (defaults.some((d) => same(d, p))) continue;
        rows.push(h("div", { class: "pc-root is-mine" }, icon("folderPlus"), h("span", { class: "pc-root-path", text: p }),
          h("button", { class: "icon-btn", title: "Stop searching this folder", onclick: () => { app.setSetting("pcSearchRoots", extras().filter((e) => !same(e, p))); paint(); } }, icon("x"))));
      }
      box.replaceChildren(...rows);
      showState();
    };

    const showState = () => {
      app.host.pcIndexState().then((ix) => {
        const n = (ix.entries || 0).toLocaleString();
        stat.textContent = ix.status === "building" ? `Reading folders… ${n} names so far`
          : ix.status === "ready" ? `${n} names indexed in ${ix.ms} ms, about ${fmtSize(ix.bytes || 0)} of memory${ix.capped ? " (capped)" : ""}`
          : "Not indexed yet — it builds the first time you use the This PC tab";
      }).catch(() => {});
    };

    const add = async () => {
      const picked = await app.host.dialogOpen({ directory: true, multiple: false, title: "Also search this folder" }).catch(() => null);
      const dir = Array.isArray(picked) ? picked[0] : picked;
      if (!dir) return;
      if (extras().some((e) => same(e, dir))) return;
      app.setSetting("pcSearchRoots", [...extras(), String(dir)]);
      await paint();
      app.host.pcIndexStart(pcRootsOf(app), true).then(showState).catch(() => {});
    };

    const addDrives = async () => {
      const drives = await app.host.pcDrives().catch(() => []);
      const fresh = drives.filter((d) => !extras().some((e) => same(e, d)));
      if (!fresh.length) { app.toast(drives.length ? "Every drive is already on the list" : "No fixed drives found", { ms: 2200 }); return; }
      app.setSetting("pcSearchRoots", [...extras(), ...fresh]);
      await paint();
      app.toast(`Added ${fresh.join("  ")} - reading their folders now`, { ms: 3000 });
      app.host.pcIndexStart(pcRootsOf(app), true).then(showState).catch(() => {});
      const watch = setInterval(() => { if (!box.isConnected) return clearInterval(watch); showState(); }, 1500);
      setTimeout(() => clearInterval(watch), 130000);
    };

    paint();
    return h("div", { class: "pc-roots-wrap" }, box, stat, h("div", { class: "set-btns" },
      h("button", { class: "btn", onclick: add }, icon("folderPlus"), "Add a folder…"),
      h("button", { class: "btn", title: "Add each fixed disk of this PC (C:, D:, …). Windows, Program Files and hidden system folders are still skipped. The first index of whole drives takes longer and uses more memory; remove a drive with its ✕.", onclick: () => addDrives() }, icon("monitor"), "Add every drive"),
      h("button", { class: "btn", onclick: () => app.host.pcIndexStart(pcRootsOf(app), true).then(() => setTimeout(showState, 400)).catch(() => {}) }, icon("undo"), "Rebuild the index")));
  }

  const shortcuts = h("div", { class: "shortcuts" },
    app.commands.filter((c) => c.keys).map((c) => h("div", { class: "sc-row" }, h("span", { text: c.name }), kbd(c.keys))),
    // the ones that are not commands
    [["Go to tab 1–8 · 9 for the last", "Ctrl 1-9"], ["Open a file to the side (file tree)", "Alt click"], ["Spelling suggestions", "Ctrl right-click"], ["Heading 1-6 (also on German and Czech keyboards)", "Ctrl Shift 1-6"],
      ["Quick capture from anywhere in Windows", "Ctrl Alt N"], ["Emoji", "Ctrl ;"], ["Find and replace in the note", "Ctrl H"],
      ["Bulleted / numbered list", "Ctrl Shift 7 / 8"], ["Paste as plain text", "Ctrl Shift V"], ["Tick or untick the checkbox on this line", "Ctrl L"],
      ["Body text (no heading)", "Ctrl Alt 0"], ["Next / previous tab", "Ctrl PgDn / PgUp"], ["Pick several tabs", "Ctrl or Shift click"],
      ["Move a file tab's file to the trash · for good", "Del · Shift Del"], ["Back / forward", "Mouse side buttons"],
      ["Tasks: move down / up · add · reorder", "J / K · N or / · Alt ↑↓"], ["Calendar: month back / on · today", "PgUp / PgDn · Home"]]
      .map(([name, keys]) => h("div", { class: "sc-row" }, h("span", { text: name }), kbd(keys))));

  // a search over every row's words: what does not carry them steps aside, groups unfold to show what does
  // never filled in by the browser's own form memory (it once came up holding a web address, every group hidden)
  const search = h("input", { class: "set-search", placeholder: "Search the settings…", spellcheck: "false", type: "search", autocomplete: "off", name: "leonote-settings-search" });
  const noMatch = h("div", { class: "set-nomatch", hidden: true });
  // Chromium's form autofill still filled this box with a web address (autocomplete=off or not): it stays read-only - which
  // autofill leaves alone - until you click or tab into it, and anything autofill puts in anyway is wiped
  search.readOnly = true;
  const own = () => { search.readOnly = false; };
  search.addEventListener("pointerdown", own);
  search.addEventListener("keydown", own, true);
  search.addEventListener("focus", () => setTimeout(own, 0));
  const autofilled = () => { try { return search.matches(":autofill") || search.matches(":-webkit-autofill"); } catch { return false; } };
  const unfill = () => { if (search.value && autofilled()) { search.value = ""; search.dispatchEvent(new Event("input")); } };
  search.addEventListener("change", unfill);
  setTimeout(unfill, 400); setTimeout(unfill, 1500);
  search.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { search.value = ""; search.dispatchEvent(new Event("input")); } });
  search.addEventListener("input", () => {
    if (autofilled()) { search.value = ""; }
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const on = words.length > 0;
    el.classList.toggle("has-search", search.value.length > 0);
    el.classList.toggle("is-searching", on);
    let found = 0;
    for (const { title, sec } of groups) {
      const rows = [...sec.querySelectorAll(".set-row, .set-sub")];
      let any = false;
      const groupHit = on && words.every((w) => title.toLowerCase().includes(w));
      for (const r of rows) {
        const t = r.textContent.toLowerCase();
        const hit = !on || groupHit || words.every((w) => t.includes(w));
        r.classList.toggle("is-searched-out", !hit);
        if (hit) any = true;
      }
      sec.hidden = on && !any;
      if (any) found++;
      if (on && any) sec.unfold(true); // the card shows while searching without being opened for good
    }
    // a category whose groups all stepped aside goes with them; one with a match shows its groups while searching
    for (const card of el.querySelectorAll(".set-cat-card")) {
      const shown = [...card.querySelectorAll(".set-group")].some((g) => !g.hidden);
      card.hidden = on && !shown;
      card.classList.toggle("is-hit", on && shown);
    }
    // nothing matched: said so, with the way back, instead of an empty page
    noMatch.hidden = !on || found > 0;
    if (on && !found) noMatch.replaceChildren(h("span", { text: `No setting matches “${search.value.trim().slice(0, 60)}”.` }), h("button", { class: "link-btn", onclick: () => { search.value = ""; search.dispatchEvent(new Event("input")); search.focus(); } }, "Clear the search"));
  });
  el.append(h("div", { class: "view-inner settings-view" },
    h("header", { class: "vh" }, h("div", {}, h("h1", { class: "vh-title", text: "Settings" }), h("div", { class: "vh-sub", text: "Changes apply instantly and are saved automatically." }))),
    h("div", { class: "set-search-wrap" }, icon("search"), search,
      h("button", { class: "icon-btn set-search-x", title: "Clear (Esc)", onclick: () => { search.value = ""; search.dispatchEvent(new Event("input")); search.focus(); } }, icon("x"))),
    noMatch,

    group("Appearance", null,
      row("Theme", null, seg("theme", [["dark", "Dark"], ["light", "Light"], ["system", "System"]])),
      ...accentRow(),
      row("Editor font", null, seg("editorFont", [["inter", "Sans"], ["serif", "Serif"], ["mono", "Mono"]])),
      foldRow("Heading style", "How # ## ### look while you write and read. The note itself never changes - the numbers in Numbered are counted by the app, not written into the file, so Obsidian still sees plain headings.",
        () => h("span", { class: "set-fold-chip", text: (HEADING_STYLES.find(([v]) => v === resolveHeadingStyle(S.headingStyle)) || [])[1] || "Plain" }),
        (repaint) => { const p = headingPicker(); p.addEventListener("click", () => setTimeout(repaint)); return p; }),
      row("Heading size", "The whole ramp at once, from H1 down to H6", seg("headingSize", [["compact", "Compact"], ["normal", "Normal"], ["large", "Large"]])),
      row("Task priority", "The coloured line beside a task with a priority", seg("taskPrio", [["plain", "No line"], ["glow", "Glow"], ["fade", "Fade"], ["edge", "Edge"], ["corner", "Corner"], ["underline", "Underline"], ["thick", "Thick"]])),
      row("Text size", "Ctrl + and Ctrl − also work", slider("fontSize", 13, 22, "px")),
      row("Window zoom", "The whole app, larger or smaller. Ctrl+scroll anywhere does the same; this follows it.", (() => {
        const key = () => (S.compact ? "uiScaleCompact" : "uiScale");
        const pct = () => Math.round((Number(S[key()]) || (S.compact ? 0.9 : 1)) * 100);
        const out = h("span", { class: "slider-val", text: pct() + "%" });
        const input = h("input", { type: "range", min: 50, max: 200, step: 5, value: pct(), class: "slider" });
        input.addEventListener("input", () => { app.setSetting(key(), Number(input.value) / 100); out.textContent = input.value + "%"; });
        app.bus.on("settings", (k) => { if (k === "uiScale" || k === "uiScaleCompact" || k === "compact") { input.value = pct(); out.textContent = pct() + "%"; } });
        return h("div", { class: "set-btns" }, h("div", { class: "slider-wrap" }, input, out), h("button", { class: "btn", onclick: () => app.resetZoom() }, "Reset"));
      })()),
      row("Where Home, Tasks and Focus sit", "A side ribbon keeps them visible on the far left and gives the sidebar to your files", seg("navRibbon", [[false, "In the sidebar"], [true, "Side ribbon"]])),
      row("Where the Spaces button sits", "Where the Spaces button shows; pick one or several", chips("spacesAt", [["titlebar", "Title bar, left"], ["tabs", "Before the tabs"], ["right", "Title bar, right"], ["ribbon", "Side ribbon"]])),
      row("Line width", "How wide a note's column of text is", seg("lineWidth", [["narrow", "Narrow"], ["normal", "Normal"], ["wide", "Wide"], ["full", "Full"]])),
      row("Animations", "From nothing moving to everything gliding. Until you pick, Leonote follows Windows' “reduce motion” setting.",
        seg("motion", [["off", "Off"], ["reduced", "Calm"], ["full", "Normal"], ["lively", "Lively"], ["gorgeous", "Gorgeous"]], () => document.documentElement.dataset.motion))),

    group("Tabs", "How tabs look, and where a new one opens.",
      row("Open in the current tab", "Everything opens in a new tab. Kinds picked here replace the current tab instead, when it shows the same kind", chips("tabReplaceKinds", [["note", "Notes"], ["image", "Pictures"], ["media", "Video & audio"], ["pdf", "PDFs"], ["office", "Office"], ["text", "Code & text"]])),
      row("A tab's own colour", "How a coloured tab looks by default. A tab's Customize can switch each effect on or off.", seg("tabColorStyle", [["glow", "Glow + text"], ["tint", "Tint"], ["fill", "Fill"], ["line", "Dashed line"]], () => (["glow", "tint", "fill", "line"].includes(S.tabColorStyle) ? S.tabColorStyle : "glow"))),
      row("Tab group names", "Collapsed groups show only their colour dot; the name appears when you hover. Turn this on to always show it", toggle("tabGroupNames")),
      row("Group tabs by dragging", "Drop a tab onto another to group them. “Hold to group” waits a moment first, so ordinary reordering never groups by accident.", seg("tabGroupOnDrop", [["hold", "Hold to group"], ["off", "Menu only"]])),
      row("A new tab opens", "From the + and Ctrl+T. Also in the +'s right-click panel", seg("newTabAt", [["after", "After current"], ["end", "At end"]])),
      row("A link opens in a new tab", "From a page's menu, a bookmark, a link in a note: next to the tab it came from, as browsers do, or at the end", seg("linkTabAt", [["after", "After current"], ["end", "At end"]])),
      row("After a link opens", "Stay on the tab you are on, or switch to the new one. Also in the +'s right-click panel", seg("linkTabBackground", [[true, "Stay here"], [false, "Switch to it"]])),
      row("Space between tabs", "From touching to well apart", slider("tabGap", 0, 16, "px")),
      row("Active tab colour", "The outline and bar of the tab you are on. No colour means your accent; a tab's own colour still wins.", activeTabColor()),
      row("Smallest tab width", "Tabs shrink to this before the tab bar scrolls; below about 64px they show only their icon", slider("tabMinWidth", 24, 200, "px"))),

    group("Sounds", "Short, soft sounds when you finish a task, keep a habit or level up. The timer has its own sounds under Focus.",
      row("Interface sounds", null, toggle("uiSounds")),
      row("Volume", null, h("div", { class: "set-btns" }, slider("uiSoundVolume", 5, 100, "%", 5),
        h("button", { class: "btn", onclick: () => { const names = ["done", "habit", "add", "trash", "level"]; names.forEach((n, i) => setTimeout(() => playSound(n, (Number(S.uiSoundVolume) || 0) / 100), i * 650)); } }, icon("play"), "Listen")))),

    group("Notices", "The small cards at the top right - what a pasted picture weighs, a file opened from outside. Hover one to keep it.",
      row("Level badge", "Your level and rank at the foot of the sidebar; hovering it shows the way to the next one", toggleOn("showLevel")),
      row("Levels, challenges and the streak", "A message and a sound for a new level, a challenge met or the day's first XP. The Timer view shows them either way.", toggle("gameNotices")),
      row("A card stays for", null, slider("cornerSecs", 2, 30, " s")),
      row("Hovering a card starts its time over", "The line refills while the pointer is on it; off, it only pauses", toggle("cornerHoverResets"))),

    group("Editor", null,
      row("Live preview", "Render Markdown in place; syntax appears only where the caret is. Ctrl+Shift+E", toggle("livePreview")),
      row("Spellcheck", "Underlines misspelled words. Ctrl+right-click one for suggestions.", toggle("spellcheck")),
      row("Read as script in menus", "Read as script opens a note in a teleprompter window for recording: large type, scrolling by itself, kept out of screen recordings. Shows it when you right-click a note, its tab or its row in the file tree", toggle("scriptMenu")),
      row("Formatting bar over selected words", "Select a few words in a note and the styles appear above them", toggle("formatBar")),
      row("Highlighter look", "Marker paints an uneven band, like a highlighter pen on paper", seg("highlightStyle", [["marker", "Marker"], ["flat", "Flat"]])),
      row("Link cards", "A link on a line of its own shows as a card with the page's title and picture. The address comes back while you edit that line.", toggle("linkPreviews")),
      row("Pictures from the web", "A picture in a note that lives on a website. Loading it lets that site see your address and that the note was opened, so by default it waits for a click.", seg("webPictures", [["click", "On a click"], ["always", "Always"]])),
      row("Pictures beside text stay in their line", "Only the text on a picture's own line runs beside it. Tall pictures then never jump while you scroll.", toggle("floatContain")),
      row("YouTube links show the video", "A YouTube link on its own line shows the video's picture and title, fetched from YouTube when the note opens. Off: a plain play button, and YouTube is asked only when you play.", toggleOn("noteYtPreviews")),
      row("Pasted links get the page's title", "A pasted address becomes a link named after its page. The address shows again while you edit it.", toggle("linkAutoTitle")),
      row("Links open in", "Right-click a link for the other choice", seg("linkOpen", [["browser", "Your browser"], ["tab", "A Leonote tab"]])),
      row("Note ids", "Linked notes get a hidden id in their header, so links keep working when a note is renamed or moved outside Leonote. Obsidian sees it as an ordinary property.", h("div", { class: "set-btns" }, toggle("noteIds"),
        h("button", { class: "btn", title: "Finds links to notes renamed or gone outside Leonote", onclick: () => app.noteIds.check() }, icon("link"), "Check links now")))),

    group("Files", null,
      row("Vault", app.vault.root, h("div", { class: "set-btns" },
        h("button", { class: "btn", onclick: (e) => switchVault(e.currentTarget) }, icon("folder"), "Switch vault…"),
        h("button", { class: "btn", onclick: () => app.reveal("") }, icon("reveal"), "Show in Explorer"))),
      row("CSV files open as", "A table to edit like a spreadsheet, saved back as CSV - or the raw text, as written", seg("csvAsText", [[false, "A table"], [true, "Text"]])),
      row("Show all files", "Images, PDFs, Office documents and other files appear in the file tree", toggle("showAllFiles")),
      row("Folders not indexed", "Left out of search, the graph, links, tags and AI - for big folders (logs, exports, archives) that slow Leonote down. Their notes stay where they are: search finds them when you ask it to (“Search the not-indexed folders too” under the results), and the tree lists them with the hidden files. Takes effect after a restart.", noIndexList()),
      app.packaged ? row("Open .md, .markdown and .txt files with Leonote", "The Store version already offers itself for these files. To make it the default, pick it in Windows' default apps.", h("button", { class: "btn", onclick: () => app.openUrl("ms-settings:defaultapps") }, icon("outside"), "Default apps")) :
      row("Open .md, .markdown and .txt files with Leonote", "Adds Leonote to Explorer's “Open with” for these files. It changes only your own user's settings, and switching it off removes it again.", assocToggle(["md", "markdown", "txt"])),
      row("Also pictures, songs and videos", "The same for pictures, songs and videos (.png, .jpg, .mp3, .mp4 and more). Each kind keeps its own icon in Explorer.", assocToggle(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "mp3", "wav", "ogg", "m4a", "flac", "opus", "mp4", "webm", "mkv", "mov"])),
      row("Also code and data files", "The same, for .json, .yaml, .toml, .xml, .csv, .log, .ini and the like.", assocToggle(["json", "jsonc", "yml", "yaml", "toml", "xml", "csv", "tsv", "log", "ini", "cfg", "conf"])),
      row("Leonote data", app.dataRoot || (DATA_DIRS[app.dataDir || "user"] || {}).help, h("div", { class: "set-btns" },
        h("button", { class: "btn", onclick: (e) => dataDirMenu(e.currentTarget) }, icon("archive"), DATA_DIRS[app.dataDir || "user"] ? DATA_DIRS[app.dataDir || "user"].label : "Choose…"),
        app.dataRoot ? h("button", { class: "btn", title: app.dataRoot, onclick: () => app.host.externalReveal(app.dataRoot).catch((e) => app.toast(String(e), { kind: "error" })) }, icon("reveal"), "Show in Explorer") : null)),
      row("Settings live in the vault", "Each vault keeps its own look, tabs, folders and bookmarks, as Obsidian does. Off: one set for every vault. Takes effect on the next start.", toggle("settingsInVault")),
      row("System folders in the file tree", "For developers: shows .leonote, .trash, .obsidian and other dot-folders at the top of the tree, read-only. Not the same as folders you hide yourself.", (() => {
        const b = h("button", { class: "switch", role: "switch" });
        const paint = () => { b.classList.toggle("is-on", !!S.showDotFolders); b.setAttribute("aria-checked", String(!!S.showDotFolders)); };
        b.addEventListener("click", async () => {
          if (!S.showDotFolders && !(await confirmDialog("Show the system folders?", "This is meant for developers. .leonote holds Leonote's own settings and data, .trash what you deleted, .obsidian Obsidian's. Editing a file in there by hand can break things; the tree only lets you look and open. Proceed?", { ok: "Show them", danger: false }))) return;
          app.setSetting("showDotFolders", !S.showDotFolders); paint();
        });
        paint();
        return b;
      })())),

    group("Where new things go", "Where Ctrl+N and the quick New buttons put what they make.",
      row("A new note (Ctrl+N) goes in", "Current folder: beside the note you are in. Workplace: its Notes folder. One folder: always the folder you name below.", seg("newNoteDir", [["current", "Current folder"], ["root", "Vault root"], ["work", "Workplace"], ["folder", "One folder"]])),
      row("The one folder", "Only used when “One folder” is chosen above", text("newNoteFolder", "Zettelkasten")),
      row("Docs folder", "Your ready-made texts (letters, replies, prompts) as notes; each folder inside is a category. Open them from the Docs view.", text("docsFolder", "Docs")),
      row("Workplace folder", "Quick notes, sketches, boards and drawings go here, each kind in its own subfolder - one tidy place that is easy to clean up.", text("workFolder", "Workplace")),
      row("…but notes go in", "Leave empty for Workplace/Notes", text("quickNoteDir", "Workplace/Notes")),
      row("…Leopaint drawings go in", "Leave empty for Workplace/Leopaint", text("quickSketchDir", "Workplace/Leopaint")),
      row("…boards go in", "Leave empty for Workplace/Boards", text("quickBoardDir", "Workplace/Boards")),
      row("…Studio drawings go in", "Leave empty for Workplace/Studio/Designs", text("quickDrawingDir", "Workplace/Studio/Designs")),
      row("…animations go in", "Leave empty for Workplace/Studio/Animations - the same kind of file as a drawing, kept apart for sorting", text("quickAnimationDir", "Workplace/Studio/Animations"))),

    group("Daily notes", null,
      row("Daily notes", "Alt+D opens today. A yearly note is one file you fill day by day. A note named Daily in the template folder starts each new day.", seg("dailyMode", [["daily", "Note per day"], ["yearly", "Yearly note"]])),
      row("Daily notes folder", "For a note per day (the yearly note has its own file below)", text("dailyFolder", "Diary")),
      row("Yearly note file", "{YYYY} becomes the year, e.g. MyData/MyThoughts/{YYYY}.md", text("yearlyPath", "Diary/{YYYY}.md", true)),
      row("Day heading", "In the yearly note. {DD} {MM} {YYYY} {ddd} {dddd} - e.g. # {DD}.{MM}.{YYYY}", text("dailyHeading", "# {DD}.{MM}.{YYYY}", true)),
      row("New days go at the", "Of the yearly note", seg("dailyInsert", [["bottom", "Bottom"], ["top", "Top"]]))),

    group("Trash", "Deleted things go to .trash in your vault, and Ctrl+Z brings them back. Shift+Delete deletes for good, after asking twice.",
      row("Keep things in trash for", "After this they are deleted for good. Checked when Leonote starts and a few times a day", seg("trashKeepDays", [[1, "1 day"], [7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"], [0, "Forever"]], () => (Number.isFinite(Number(S.trashKeepDays)) ? Number(S.trashKeepDays) : 30))),
      row("Delete moves things to", "The Recycle Bin is Windows' own: Leonote cannot clean it up, and Ctrl+Z there brings back notes only.", seg("trashMode", [["trash", "Leonote's trash"], ["bin", "Windows Recycle Bin"]], () => (S.trashMode === "bin" ? "bin" : "trash"))),
      row("Open the trash", null, h("div", { class: "set-btns" },
        h("button", { class: "btn", onclick: () => app.openTrash() }, icon("trash"), "View trash…"),
        h("button", { class: "btn", onclick: () => app.host.trashOpen(false).catch((e) => app.toast(String(e), { kind: "error" })) }, icon("folder"), "Open the folder")))),

    group("Search on this PC", "Which folders the This PC search looks through. It matches names only and never reads inside your files.",
      foldRow("Folders searched", "The index is built once per session, in the background, and kept in memory only",
        () => { const n = (S.pcSearchRoots || []).length, o = outpostList(app).length; return `your own folders and the vault${n ? ` + ${n} added` : ""}${o ? ` + ${o} outpost${o === 1 ? "" : "s"}` : ""}`; },
        () => pcRootsPanel())),

    group("Jev", "A fast helper for small decisions, such as a new task's priority. It acts only when it is sure, and you can undo it. It uses your own TypeSafe key, or Laya on this computer.",
      row("Use Jev", "Off: nothing is sent to it. On, with a key: only what you allow below, and the notes you ask it about", toggleOn("jevOn")),
      ...jevWhere(),
      row("New tasks it files", "A new task without a priority or focus area is sent to Jev (its text, due date and your areas' names) to get them. Your own tasks never go while you keep them apart from AI.", seg("jevTasks", [["off", "None"], ["ai", "Given to AI"], ["all", "All"]], () => (S.jevTasks === "ai" || S.jevTasks === "all" ? S.jevTasks : "off"))),
      row("Sure enough at", "Below this Jev's answer is left unused.", seg("jevMin", [[0.6, "60%"], [0.7, "70%"], [0.8, "80%"], [0.9, "90%"]], () => Number(S.jevMin) || 0.8)),
      row("Notes and the playground", "Ask Jev where a note belongs (its folder and tags), or try any question in the playground.",
        h("div", { class: "set-btns" },
          h("button", { class: "btn", onclick: () => app.jev.suggestNote(app.lastNotePath && app.lastNotePath()) }, icon("sparkles"), "This note"),
          h("button", { class: "btn", onclick: () => app.jev.playground() }, "Playground")))),

    group("Assistant", "Ask an AI about your notes (Alt+0), with your own key or a model running on this computer. Nothing is sent until you press Send.",
      row("Providers and keys", "Keys are locked by Windows for you on this computer, kept out of the vault and backups, and never shown again.",
        h("button", { class: "btn", onclick: () => { app.openView("assistant"); } }, icon("sparkles"), "Open the Assistant")),
      row("Your standing instructions", "Added to every question: who you are, the language to answer in, the tone you like",
        (() => { const t = h("textarea", { class: "input", rows: 3, spellcheck: true, placeholder: "e.g. I am a biology PhD student. Answer in Ukrainian. Be direct." }); t.value = S.aiSystem || ""; t.addEventListener("change", () => app.setSetting("aiSystem", t.value.trim())); return t; })(), "is-stack"),
      row("From the note menu", "Where an answer shows when you ask about a piece of a note", seg("aiInline", [[true, "Beside the text"], [false, "In the Assistant tab"]], () => S.aiInline !== false)),
      row("Keep every thread", "Each conversation from the card is saved as a note, rewritten after every answer", toggle("aiKeepChats", true)),
      row("Threads go to", "Empty: AI_Chats in your Workplace folder", text("aiChatsFolder", "Workplace/AI_Chats")),
      row("Documents go to", "Saved answers and the documents you write with the Assistant. Empty: AI_Researches in your Workplace folder", text("aiResearchFolder", "Workplace/AI_Researches")),
      row("Most text sent with a question", "In thousands of characters. Over this the Assistant refuses to send rather than cutting your notes short",
        (() => { const n = h("input", { class: "input", type: "number", min: 20, max: 3000, step: 10, style: { width: "96px" } }); n.value = String(Math.round((Number(S.aiContextChars) || 400000) / 1000)); n.addEventListener("change", () => app.setSetting("aiContextChars", Math.max(20, Math.min(3000, Number(n.value) || 400)) * 1000)); return n; })())),

    group("Speech recognition", "What hears you when you press a mic button. Whisper on this computer is free and private, a cloud model needs your key, and Windows' own needs nothing installed.",
      row("Listening with", "What turns speech into text for the mic buttons", speechProvider()),
      row("Model", "Fast and cheap for a quick line; most accurate for names, accents or noise. Priced per hour of speech.", speechTier()),
      row("Key", null, speechKey()),
      row("Language", "A two-letter code (uk, en, de…) makes it surer and faster; empty means it works it out.", (() => { const i = h("input", { class: "text-input", placeholder: "auto", value: (S.speech || {}).lang || "", spellcheck: false, style: { width: "90px" } }); i.addEventListener("keydown", (e) => e.stopPropagation()); i.addEventListener("change", () => app.setSetting("speech", { ...(S.speech || {}), lang: i.value.trim().toLowerCase() })); return i; })()),
      row("Words it should know", "Names and terms it tends to mishear, comma-separated - given to the model as a hint.", (() => { const i = h("input", { class: "text-input is-wide", placeholder: "Leonote, Olexify, deadlift", value: (S.speech || {}).prompt || "", spellcheck: false }); i.addEventListener("keydown", (e) => e.stopPropagation()); i.addEventListener("change", () => app.setSetting("speech", { ...(S.speech || {}), prompt: i.value.trim() })); return i; })())),

    group("Outposts", "Folders outside your vault, such as a music drive, shown in the sidebar. They stay where they are, and backups leave them out.",
      foldRow("Hooked-up folders", "Also searched by the This PC tab and by the sidebar's file filter",
        () => { const l = outpostList(app); return l.length ? [h("span", { class: "set-fold-chip", text: String(l.length) }), l.slice(0, 2).map((o) => o.name || o.path).join(", ") + (l.length > 2 ? "…" : "")] : "none yet"; },
        (repaint) => outpostsPanel(repaint))),

    group("Plugins", "Small programs by other people that add to Leonote. Each runs fenced off, with only what you allowed. Leonote does not check them: install what you trust.",
      row("Your plugins", "Off and Remove take effect at once.", pluginsPanel(app), "is-stack")),
    group("Browser add-ons", "Extensions for the pages in your tabs; they stay installed across restarts. Leonote ships none - the ready ones listed here come from their makers' own releases.",
      row("Add-ons", "On or off, and removed, per add-on. A page open in a tab may need a reload to notice.", app.host.real ? addonsPanel(app) : h("div", { class: "set-note", text: "Add-ons need the Leonote app." }), "is-stack")),
    group("Browser", "The browser in your tabs: its history, how much memory pages may use, and downloads.",
      row("Remember pages I visit", null, toggle("webHistoryOn")),
      row("One entry per site", "Sites that keep only their last visit in history, so a dozen videos leave one line. One site per line, without www.", (() => { const t = h("textarea", { class: "input", rows: 3, spellcheck: "false", placeholder: "youtube.com" }); t.value = (S.webHistoryFoldHosts || []).join("\n"); t.addEventListener("change", () => app.setSetting("webHistoryFoldHosts", t.value.split(/[\n,]/).map((x) => x.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean))); t.addEventListener("keydown", (e) => e.stopPropagation()); return t; })()),
      row("Warn when a page uses more than", "A heavy page can slow Leonote down. Past this you are told, with a button to stop it.", seg("webMemWarnGB", [[0, "Never"], [1, "1 GB"], [2, "2 GB"], [4, "4 GB"]])),
      row("Tabs sleep when out of sight for", "A sleeping tab gives its memory back and picks up where it was when you return. A tab playing sound stays awake.", seg("tabSleepMin", [[0, "Never"], [0.25, "15 s"], [1, "1 min"], [5, "5 min"], [15, "15 min"], [60, "1 h"]])),
      row("Most tabs awake at once", "Past this many, the tabs longest out of sight sleep right away, whatever the time above. 0 is no limit.", slider("tabAwakeMax", 0, 40, "")),
      row("Downloads without asking", "Downloads ask first, except from the sites listed here. One site per line, without www.", (() => { const t = h("textarea", { class: "input", rows: 3, spellcheck: "false", placeholder: "github.com" }); t.value = (S.downloadHosts || []).join("\n"); t.addEventListener("change", () => app.setSetting("downloadHosts", t.value.split(/[\n,]/).map((x) => x.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean))); t.addEventListener("keydown", (e) => e.stopPropagation()); return t; })()),
      row("Add-on panel size", "How large the page of an add-on's panel draws. Drag the popup's corner for its size.", slider("webExtPopZoom", 60, 150, "%", 5)),
      row("The old Web pages view", `${(S.webShortcuts || []).length} saved there; they are bookmarks on the start page now.`, h("div", { class: "set-btns" },
        h("button", { class: "btn", onclick: () => app.openView("web") }, icon("globe"), "Open it")))),

    group("Passwords", "The browser's own saved sign-ins, and your password vault.",
      row("Offer to save passwords", "The browser offers to remember passwords and form entries and fills them in next time. Windows encrypts them for your user; Leonote never sees them.", toggle("webPasswords")),
      row("Saved passwords", "No program can list them, not even Leonote; a site fills them in when you sign in. You can forget them all here.",
        h("button", { class: "btn", onclick: async () => {
          if (!(await confirmDialog("Forget every saved password?", "The browser forgets the passwords, addresses and form entries it saved. Signing in again offers to save them anew.", { ok: "Forget them", safe: true }))) return;
          try { await app.host.webPasswordsForget(); app.toast("Saved passwords and form entries forgotten", { ms: 2600 }); } catch (e) { app.toast(String(e), { kind: "error" }); }
        } }, icon("trash"), "Forget them all…")),
      row("Your password vault", "Leonote's own encrypted file, opened with a master password that is never saved. It locks itself after five idle minutes.",
        h("button", { class: "btn", onclick: () => import("./passwords.js").then((m) => m.openPasswords(app)) }, icon("shield"), "Open the vault…")),
      row("Offer to save sign-ins in the vault", `When you sign in on a page, Leonote asks whether to keep the name and password in your vault. Nothing is kept unless you say Save.${(S.pwNever || []).length ? ` Never asked on: ${S.pwNever.join(", ")}.` : ""}`,
        h("div", { class: "set-inline" }, toggle("pwOffer"), (S.pwNever || []).length ? h("button", { class: "btn btn-sm", onclick: (e) => { app.setSetting("pwNever", []); e.currentTarget.remove(); } }, "Ask on every site again") : null))),

    group("Player", "The Player's music and online videos, and its own small browser.",
      row("A file opened while something plays", "Plays, then gives way: it plays at once, and the playlist carries on after it. Joins the queue: it waits its turn.", seg("playerOpenedJoins", [[false, "Plays, then gives way"], [true, "Joins the queue"]])),
      row("YouTube's own controls over the picture", "Off: a clean picture, with Leonote's own controls underneath. Takes effect on the next start.", toggle("playerYtControls")),
      row("Keep the pictures of online videos", `Each video's picture is saved in the vault (about 15 KB each), so big playlists load fast. Kept for 30 days at a time, as YouTube's rules ask.`, toggle("playerKeepPreviews")),
      row("The Player's browser remembers its tabs", "Its tabs come back next start; pinned tabs always do.", toggle("playerBrowserRestore")),
      row("The Player's browser", "How large pages show in the Player's small browser. Its − and + buttons remember a size per site.", slider("playerBrowserZoom", 25, 125, "%", 5)),
      row("YouTube account", `Reads playlists and finds songs through YouTube's official service, and lets a playlist send its changes to the same playlist on your YouTube channel. Uses your Google app (Calendar › Google app) with the YouTube Data API turned on.`, ytAccount()),
      row("YouTube key", "Instead of signing in: your own YouTube Data API key, for public playlists and finding songs. YouTube allows about 100 finds a day on one key.", text("ytApiKey", "Your key", true))),

    group("Calendar", "The month at a glance (Alt+C): tasks on their dates, daily notes and, once you sign in, your Google calendars.",
      row("Week starts on", null, seg("calWeekStart", [[1, "Monday"], [0, "Sunday"]])),
      row("Your Google app", "Make an OAuth client (type “Desktop app”) in the Google Cloud console, turn on the Google Calendar API, and paste its ID here - and its secret, if it has one.", googleApp()),
      row("Google Calendar", "You sign in in your browser. Nothing is read until you do, and nothing is written unless you pick a calendar below.", googleAccount()),
      row("Calendars shown", "Ticked ones appear in the Calendar view.", googleShown()),
      row("Tasks and recurring tasks go on", "Tasks with a due date become events on this calendar, recurring ones repeat, and they follow every change.", googlePush()),
      row("For other calendar apps", "A .ics file of your dated and recurring tasks, for Outlook, Apple Calendar, Thunderbird and others.", h("div", { class: "set-btns" }, h("button", { class: "btn", onclick: exportIcs }, icon("download"), "Save as .ics…")))),

    group("Workout", "Log sets, meals and fasts in the Workout view (Alt+W), typed or said like “10 pushups”.",
      row("Weights in", "What a bare number means when you type no unit.", seg("fitUnit", [["kg", "kg"], ["lb", "lb"]])),
      row("Calories a day", "The Food tab's bar fills towards this. 0 hides the bar.", slider("foodKcalGoal", 0, 4000, " kcal", 50)),
      row("Rest after a set", "The rest timer starts by itself this long after each set. 0: only when you press 30, 60 or 90.", seg("fitAutoRest", [[0, "Off"], [30, "30 s"], [45, "45 s"], [60, "60 s"], [90, "90 s"], [120, "2 min"], [180, "3 min"]])),
      row("Fasting goal", "Hours a fast is meant to last: the timer counts towards it, and a day joins the streak once a fast reaches it.", slider("fastHours", 8, 36, " h", 1))),

    group("Zettelkasten",
      "A way of keeping notes: one idea per note, in your own words, linked to the notes it touches. It stays plain Markdown, so Obsidian opens it too.",
      row("Set it up", zettelHint(), h("div", { class: "set-btns" },
        h("button", { class: "btn btn-primary", onclick: runZettelSetup }, icon("folderPlus"), "Set up the folders and templates"))),
      row("Idea notes", "Atomic notes, one idea each, all in one flat folder", text("zettelFolder", "Zettelkasten")),
      row("Reference notes", "One note per book, video, paper or course", text("referenceFolder", "Reference Notes")),
      row("Template folder", "Ctrl+Alt+T inserts one of these where the caret is", text("templateFolder", "Templates")),
      row("Day to day", "The same three are in Ctrl+P, and the details panel suggests connections while you write", h("div", { class: "set-btns" },
        h("button", { class: "btn", onclick: () => app.zettel.newIdea() }, icon("lightbulb"), "Idea"),
        h("button", { class: "btn", onclick: () => app.zettel.newReference() }, icon("book"), "Reference"),
        h("button", { class: "btn", onclick: () => app.zettel.newMoc({}) }, icon("compass"), "Map of Content")))),

    group("Images", "What happens when you paste or drop a picture into a note: it is shrunk to WebP and saved in its media folder.",
      row("Pasted images", null, seg("imageFormat", [["webp", "Compress to WebP"], ["original", "Keep as is"]])),
      row("Quality", "Lower means smaller files. 80% keeps photos and screenshots looking right; go lower only if size matters more", slider("imageQuality", 10, 100, "%", 5)),
      row("Largest size", "Bigger pictures are scaled down to this. 0 keeps their size", slider("imageMaxSide", 0, 4000, "px", 100)),
      row("Pasted picture's width", "How wide a picture is in the note when it lands. 0 is the whole width. Resize any picture later by its corner.", slider("imagePasteWidth", 0, 900, "px", 20)),
      row("Delete on a picture", "What Delete does with the file: remove only the link, or move the file to the trash too. Shift+Delete always deletes for good, after asking twice.", seg("pictureDelete", [["link", "Remove the link"], ["trash", "Move to the trash"]])),
      row("Ask each time", "Delete shows the question, with the usual answer ready for Enter.", toggleOn("pictureDeleteAsk")),
      row("Undo after a paste takes the file too", "Ctrl+Z right after pasting a picture also sends its file to the trash, so unused pictures don't pile up. Ctrl+Shift+Z brings both back.", toggle("pasteUndoTrash")),
      row("Unused pictures and files", "Find pictures and files no note uses, and embeds that point at nothing, and clear them out.", h("button", { class: "btn", onclick: () => app.tidyFiles() }, icon("search"), "Find unused files…")),
      row("Where a pasted picture sits", "Beside the text on one side, or in the text's flow", seg("imagePasteSide", [["left", "Left"], ["", "In the flow"], ["right", "Right"]])),
      row("Picture layout", "Wide lets pictures use the whole pane; Collage lays them out as a gallery. A note can choose its own with cssclasses.", seg("imageLayout", [["column", "In the text"], ["wide", "Wide"], ["collage", "Collage"]])),
      row("Invert pictures in dark theme", "White screenshots turn dark in notes. The viewer has its own invert (I)", toggle("imageInvertDark"))),

    group("Media folders", "One folder for each kind of file you paste or drop into a note. Leave a field empty for its usual place; ./ means next to the note.",
      h("div", { class: "set-sub", text: "Pictures" }),
      row("Pictures", "Pictures kept as they came (Keep as is, or Keep original).", folderText("imageFolder")),
      row("Compressed pictures", "Pictures Leonote squeezed to WebP on the way in.", folderText("compressedImageFolder")),
      h("div", { class: "set-sub", text: "Video" }),
      row("Videos", "Videos dropped or pasted into notes are copied here.", folderText("videoFolder")),
      h("div", { class: "set-sub", text: "Music" }),
      row("Music", "Songs and recordings.", folderText("audioFolder")),
      h("div", { class: "set-sub", text: "Documents" }),
      row("Documents and code", "PDFs, Word files, text, code - anything that is not a picture, a video or a song.", folderText("docFolder")),
      row("Playlists", "Where the Player saves a playlist exported as .m3u8.", folderText("playlistFolder")),
      h("div", { class: "set-sub", text: "Dropped in" }),
      row("A name already in the folder", "A file with a taken name becomes “report 2.pdf”. On: you are told first, with a tick to stop asking.", toggle("importClashAsk")),
      row("A file dropped or opened from outside", "Into the vault: straight into the folder for its kind. Ask: a card offers that. Outside: it opens where it is.", seg("dropInto", [["ask", "Ask"], ["vault", "Into the vault"], ["outside", "Leave it outside"]])),
      h("div", { class: "set-sub", text: "What you already have" }),
      row("Gather media into these folders", "Moves a folder's pictures, videos and songs into the folders above. Names stay, so links keep working. Asks first; nothing is deleted.", h("button", { class: "btn", onclick: () => app.gatherMedia() }, icon("folder"), "Gather media…"))),
    group("File tree", "How the file list looks and behaves. Right-click any folder › Customize to give it its own colour and size.",
      row("Reveal the open file", "Opening a note expands the tree down to it", toggle("treeAutoReveal")),
      row("One folder open at a time", "Opening a folder closes its siblings", toggle("treeAccordion")),
      row("Hidden files and folders", hiddenHint(), h("div", { class: "set-btns" },
        toggleLabeled("showHidden", "Show them"),
        h("button", { class: "btn", onclick: (e) => { app.setSetting("hiddenPaths", []); e.currentTarget.closest(".set-row").querySelector(".set-hint").textContent = hiddenHint(); } }, icon("eye"), "Unhide all"))),
      row("Text size", null, slider("treeFontSize", 11, 18, "px", 0.5)),
      row("Row height", "A named step, or any height you like", h("div", { class: "set-btns" },
        seg("treeRowHeight", [["compact", "Compact"], ["snug", "Snug"], ["cozy", "Cozy"], ["roomy", "Roomy"]]),
        (() => { const px = () => Number(S.treeRowHeight) || { compact: 23, snug: 25.5, cozy: 28, roomy: 33 }[S.treeRowHeight] || 28; const out = h("span", { class: "slider-val", text: px() + "px" }); const input = h("input", { type: "range", min: 18, max: 44, step: 1, value: Math.round(px()), class: "slider" }); input.addEventListener("input", () => { app.setSetting("treeRowHeight", Number(input.value)); out.textContent = input.value + "px"; }); app.bus.on("settings", (k) => { if (k === "treeRowHeight") { input.value = Math.round(px()); out.textContent = Math.round(px()) + "px"; } }); return h("div", { class: "slider-wrap" }, input, out); })())),
      row("Indent per level", null, slider("treeIndent", 6, 32, "px")),
      row("Space before the tree", "How far the tree sits from the left edge. A little more helps when folder icons are on.", slider("treeRootIndent", 0, 32, "px")),
      row("Folder names", null, seg("treeFolderWeight", [["normal", "Regular"], ["medium", "Medium"], ["bold", "Bold"]])),
      row("File extensions", "Notes hide .md unless you pick All; other files show theirs unless you pick Hidden", seg("treeShowExt", [["none", "Hidden"], ["other", "Non-notes"], ["all", "All"]])),
      row("How extensions show", "A coloured tag at the right edge, or written after the name", seg("treeExtStyle", [["tag", "Tag"], ["inline", "After the name"]])),
      row("Quieter files", "Folders stand out; notes and files are quieter", toggle("treeDimFiles")),
      row("Counts on folders", "How many notes each folder holds, beside its name", toggle("treeCounts")),
      row("Folder icons", "A folder icon before each folder's name", toggle("treeFolderIcons")),
      row("Indent guides", "Thin lines showing which folder a row belongs to", toggle("treeGuides")),
      row("Folder looks", folderLooksHint(), h("button", { class: "btn", onclick: async (e) => {
        const btn = e.currentTarget;
        const n = Object.keys(S.folderStyles || {}).length;
        if (!n) return app.toast("No folder is customized", { ms: 2000 });
        if (!(await confirmDialog("Reset every folder's look?", `${n} folder${n === 1 ? "" : "s"} will go back to the plain look. Colours, sizes and boldness you chose are lost.`, { ok: "Reset all", safe: true }))) return;
        app.setSetting("folderStyles", {});
        btn.closest(".set-row").querySelector(".set-hint").textContent = folderLooksHint();
      } }, icon("undo"), "Reset all"))),

    group("Backup and moving to another computer", "One encrypted file with everything, locked by a password only you know. Copy it anywhere and restore it on another computer.",
      row("Make a backup", null, h("div", { class: "set-btns" },
        toggleLabeled("backupIncludeVault", "Include notes and files"),
        h("button", { class: "btn btn-primary", onclick: () => createBackup(app) }, icon("archive"), "Create encrypted backup…"))),
      row("Compression", "Smallest packs notes and data hardest. Pictures and media are already compressed and stay as they are.", seg("backupCompression", [["fast", "Fast"], ["balanced", "Balanced"], ["smallest", "Smallest"]])),
      row("Restore a backup", "Replaces tasks, habits, focus areas, stats and settings; your current ones are kept aside first", h("div", { class: "set-btns" },
        h("button", { class: "btn", onclick: () => restoreBackup(app) }, icon("undo"), "Restore from file…"))),
      row("Backup plans", "What to back up, how often, and whether Leonote asks first. Plain zips, readable anywhere.", plansPanel(app), "is-stack"),
      row("Backups folder", "Where plans put their zips unless a plan names its own. Empty: a “Leonote Backups” folder beside the vault.", (() => {
        const dirIn = text("backupDir", backupDir(app, null), true);
        return h("div", { class: "set-btns" }, dirIn, h("button", { class: "btn", onclick: async () => { let picked = null; try { picked = await app.host.dialogOpen({ directory: true, multiple: false, title: "Where backups go" }); } catch {} const d = Array.isArray(picked) ? picked[0] : picked; if (d) { dirIn.value = d; app.setSetting("backupDir", d); } } }, icon("folder"), "Choose…"));
      })()),
      row("Import Google Keep", "Export Keep from Google Takeout (takeout.google.com), then pick that folder. Each note arrives in Keep/ with its checklists, labels, pictures and dates. Nothing is overwritten.", h("button", { class: "btn", onclick: async () => {
        let d = null;
        try { d = await app.host.dialogOpen({ directory: true, multiple: false, title: "The Takeout folder (or its Keep folder inside)" }); } catch {}
        d = Array.isArray(d) ? d[0] : d;
        if (!d) return;
        try {
          const r = await app.host.keepImport(String(d), "Keep");
          app.toast(`Imported ${r.notes} note${r.notes === 1 ? "" : "s"} from Google Keep${r.archived ? ` and ${r.archived} archived` : ""}${r.pictures ? ` · ${r.pictures} pictures` : ""}${r.unreadable ? ` · ${r.unreadable} could not be read` : ""}`, { ms: 8000, action: { label: "Show", run: () => { app.setSetting("sidebar", true); app.revealInTree && app.revealInTree("Keep"); } } });
        } catch (e) { app.toast("Could not import: " + e, { kind: "error", ms: 8000 }); }
      } }, icon("download"), "Choose the Takeout folder…")),
      row("Task history copies", "A copy of your task list is kept at each start and exit. The oldest go past this number.", slider("historyCopies", 5, 200, "")),
      row("Data recovery", "Bring back an earlier copy of your task list in a click. Deleted notes are in the trash; earlier versions are in a note's menu.", h("button", { class: "btn", onclick: () => recoveryDialog(app) }, icon("undo"), "Open recovery…")),
      driveRow(app, row),
      row("Leonote Cloud", "Coming later: keep your encrypted backup on our servers. Your password still never leaves your computer.", h("span", { class: "set-soon", text: "Soon" }))),

    group("Claude Code", "Your Claude Code sessions as notes: the conversation only (your messages and Claude's replies - not the tools' output or its thinking), keys and passwords blanked, private to AI. Claude Code's own files are only read. New and grown sessions come in on a click; a note you edit here is not overwritten.",
      row("Folder", "Where the sessions go - a folder per project", (() => { const n = h("input", { class: "input", type: "text", placeholder: "Claude sessions", style: { width: "220px" } }); n.value = S.claudeImportDir || ""; n.addEventListener("change", () => app.setSetting("claudeImportDir", n.value.trim())); return n; })()),
      row("Keep them out of indexing", "Long chats would slow every start. Off: they are searched, linked and in the graph like any note. Either way, search finds them with “search the not-indexed folders too”.", toggleOn("claudeImportKeepOut")),
      row("Import now", "Reads ~/.claude/projects on this computer", h("button", { class: "btn", onclick: () => app.importClaude() }, icon("download"), "Import Claude Code sessions"))),
    group("AI agents", "Rules for AI tools that read and change your notes and tasks.",
      row("The full agreement they follow", "What a tool must do when it works on your files itself. Give it to any AI tool you use.", h("button", { class: "btn", onclick: () => openText("Rules for AI agents", "agents.txt", "This copy of Leonote has no copy of the rules.",
        // the data kept in the vault: the folders the rules name are elsewhere here, and an agent writing to them would be lost
        app.dataDir && app.dataDir !== "user" && app.dataRoot ? `IN THIS COPY OF LEONOTE the data is in ${app.dataRoot}\n  tasks:       ${app.dataRoot}\\tasks.json   (not ~/.leonote_tasks.json)\n  task logs:   ${app.dataRoot}\\log\\<you>.jsonl   (not ~/.leonote/log)\n  AI access:   ${app.dataRoot}\\ai-access.json\nWherever the rules below say ~/.leonote, use that folder.\n\n` : "") }, icon("fileText"), "Read it")),
      row("Notify on agent changes", "A small toast when an agent edits a note or a task", toggle("agentToasts")),
      row("What agents may do with a note", "Review: changes wait for your OK. Open: they write at once, the old text kept. Private: they can't see it. Right-click a folder to set it there.",
        (() => {
          const wrap = h("div", { class: "segmented is-small" });
          const paint = () => { const now = app.proposals ? app.proposals.rules().default || "review" : "review"; for (const b of wrap.children) b.classList.toggle("is-active", b.dataset.v === now); };
          for (const [v, label] of [["private", "Private"], ["review", "Review"], ["open", "Open"]]) wrap.append(h("button", { class: "seg", dataset: { v }, onclick: async () => { await app.proposals.setAccess("", v); paint(); } }, label));
          paint();
          app.bus.on("aiaccess", paint);
          return wrap;
        })()),
      row("Full access to the vault", "AI tools may read and change every note at once, without proposals. A note marked ai: private is still kept out.",
        (() => {
          const b = h("button", { class: "switch", role: "switch" });
          const paint = () => { const on = !!(app.proposals && app.proposals.full()); b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); };
          b.addEventListener("click", async () => {
            const on = !app.proposals.full();
            if (on && !(await confirmDialog("Give AI full access to the vault?", "Every note becomes open to agents, skills and the chat: they read it and change it straight away, without asking. The old text of a replaced note is still kept in the trash and in its history. A note with ai: private at its top stays out. Plugins still follow your folders.", { ok: "Give full access", danger: false }))) return;
            await app.proposals.setFull(on);
            paint();
          });
          paint();
          app.bus.on("aiaccess", paint);
          return b;
        })()),
      row("Keep your tasks apart from AI's", "Each task is yours or AI's (switch it on its row). AI tools see and change only AI's tasks.",
        (() => {
          const b = h("button", { class: "switch", role: "switch" });
          const paint = () => { const on = !!(app.proposals && app.proposals.tasksSplit()); b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); };
          b.addEventListener("click", async () => { await app.proposals.setTasksSplit(!app.proposals.tasksSplit()); paint(); });
          paint();
          app.bus.on("aiaccess", paint);
          return b;
        })()),
      row("A new task is", "Whose a task you add is, unless you pick otherwise in the options under the box while writing it.", seg("tasksDefaultOwner", [["human", "Mine"], ["ai", "AI's"]], () => (S.tasksDefaultOwner === "ai" ? "ai" : "human"))),
      row("AI gets a task after", "A task given to AI reaches agents only after this delay, so you can take it back.", seg("aiTaskGrace", [[0, "At once"], [1, "1 min"], [5, "5 min"], [15, "15 min"]], () => String(S.aiTaskGrace ?? 1))),
      row("Options under the task box", "While you write a new task: mine or AI's, priority and due date, a click each.", toggle("taskAddOptions")),
      row("Edits waiting", null, h("button", { class: "btn", onclick: () => app.proposals.review() }, icon("sparkles"), "Review proposed edits"))),

    group("Start and close", null,
      row("Keep running when closed", "Alt+F4 or closing from the taskbar hides Leonote to the tray, so it reopens instantly. The X button, the tray menu and Ctrl+Q quit.", toggle("closeToTray")),
      row("Settings file", app.settingsPath || "app.json in your user folder",
        h("button", { class: "btn", onclick: () => app.host.revealSettings().catch((e) => app.toast(String(e), { kind: "error" })) }, icon("reveal"), "Show in Explorer")),
      app.packaged
        ? row("Launch at login", "Windows starts the Microsoft Store Leonote itself: switch it on under Startup apps.", h("button", { class: "btn", onclick: () => app.openUrl("ms-settings:startupapps") }, icon("outside"), "Startup apps"))
        : row("Launch at login", "Starts hidden in the tray, ready the moment you need it", toggle("launchAtLogin")),
      app.packaged ? null : row("Wait after login", "Lets the rest of Windows start first, then Leonote. Opening Leonote yourself meanwhile opens it at once.", seg("launchDelay", [[0, "No wait"], [30, "30 s"], [60, "1 min"], [120, "2 min"]]))),

    group("Optional modules", "Free extra programs Leonote can use. Each downloads only when you click Install, and deleting its folder removes it.",
      modulesList()),
    group("Keyboard", "Everything is reachable from Ctrl+P.",
      row("Check a shortcut", "Shows what Leonote receives and what it runs - handy when another app has taken a key", keyChecker(app)),
      foldRow("All shortcuts", null, () => `${app.commands.filter((c) => c.keys).length} shortcuts`, () => shortcuts)),

    group("About", null, aboutEl)));
  // the groups in their categories: each category a card - its icon, its name and what is in it - folded until opened
  const catsOpen = () => new Set(Array.isArray(S.settingsCatsOpen) ? S.settingsCatsOpen : []);
  {
    const host = groups[0].sec.parentElement;
    const byTitle = new Map(groups.map((g) => [g.title, g.sec]));
    const placed = new Set();
    for (const [cat, names] of CATEGORIES) {
      const secs = names.map((n) => byTitle.get(n)).filter(Boolean);
      if (!secs.length) continue;
      names.forEach((n) => placed.add(n));
      const card = h("section", { class: "set-cat-card" + (catsOpen().has(cat) ? " is-open" : ""), dataset: { cat } });
      const setOpen = (on) => {
        card.classList.toggle("is-open", on);
        if (on) { card.classList.add("is-opening"); clearTimeout(card._opening); card._opening = setTimeout(() => card.classList.remove("is-opening"), 600); }
        if (on && secs.includes(byTitle.get("About"))) aboutEl.opened(); // the donation goal is fetched only now (privacy policy)
        const o = catsOpen();
        on ? o.add(cat) : o.delete(cat);
        app.setSetting("settingsCatsOpen", [...o]);
      };
      card.open = () => { if (!card.classList.contains("is-open")) setOpen(true); };
      card.append(
        h("button", { class: "set-cat-head", title: "Open or close " + cat, onclick: () => setOpen(!card.classList.contains("is-open")) },
          h("span", { class: "set-cat-ico" }, icon(CAT_ICON[cat] || "settings")),
          h("span", { class: "set-cat-what" }, h("span", { class: "set-cat-name", text: cat }), h("span", { class: "set-cat-sub", text: names.filter((n) => byTitle.has(n)).map(shortName).join(" · ") })),
          icon("chevronDown", "set-cat-caret")),
        h("div", { class: "set-cat-body" }, ...secs));
      for (const sec of secs) sec.card = card;
      host.append(card);
    }
    for (const g of groups) if (!placed.has(g.title)) host.append(g.sec);
    const order = CATEGORIES.flatMap(([, names]) => names);
    groups.sort((a, b) => (order.indexOf(a.title) + 1 || 999) - (order.indexOf(b.title) + 1 || 999));
  }
  // a big group's rows in small sections under a heading of their own; a row is found by its label, and one without
  // a label (the accent's colour picker) stays with the row before it; rows not named keep their place at the end
  const SUBHEADS = {
    Appearance: [["Colours", ["Theme", "Accent"]], ["Text", ["Editor font", "Heading style", "Heading size", "Text size", "Line width"]], ["The window", ["Window zoom", "Where Home, Tasks and Focus sit", "Where the Spaces button sits", "Animations"]]],
    Tabs: [["Opening", ["Open in the current tab", "A new tab opens", "A link opens in a new tab", "After a link opens"]], ["Groups", ["Tab group names", "Group tabs by dragging"]], ["Look", ["A tab's own colour", "Active tab colour", "Space between tabs", "Smallest tab width"]]],
    Editor: [["Writing", ["Live preview", "Spellcheck", "Formatting bar over selected words", "Highlighter look"]], ["Links", ["Link cards", "YouTube links show the video", "Pasted links get the page's title", "Links open in", "Note ids"]], ["Pictures", ["Pictures beside text stay in their line"]]],
    "File tree": [["Behaviour", ["Reveal the open file", "One folder open at a time", "Hidden files and folders"]], ["Size and spacing", ["Text size", "Row height", "Indent per level", "Space before the tree"]], ["Look", ["Folder names", "File extensions", "How extensions show", "Quieter files", "Counts on folders", "Folder icons", "Indent guides", "Folder looks"]]],
    Files: [["Your vault", ["Vault", "Settings live in the vault", "Leonote data", "System folders in the file tree"]], ["Opening files", ["CSV files open as", "Show all files", "Open .md, .markdown and .txt files with Leonote", "Also pictures, songs and videos", "Also code and data files"]]],
    Images: [["Pasting", ["Pasted images", "Quality", "Largest size", "Pasted picture's width", "Where a pasted picture sits"]], ["Deleting", ["Delete on a picture", "Ask each time", "Undo after a paste takes the file too", "Unused pictures and files"]], ["Showing", ["Picture layout", "Invert pictures in dark theme"]]],
    "Media folders": [["Where each kind goes", ["Pictures", "Compressed pictures", "Videos", "Music", "Documents and code", "Playlists"]], ["When files come in", ["A name already in the folder", "A file dropped or opened from outside", "Gather media into these folders"]]],
    Player: [["Playing", ["A file opened while something plays", "YouTube's own controls over the picture", "Keep the pictures of online videos"]], ["Its browser", ["The Player's browser remembers its tabs", "The Player's browser", "YouTube account"]]],
    Jev: [["Connection", ["Where it runs", "Key", "Laya's address", "Laya's model", "Laya's key", "Laya"]], ["What it does", ["New tasks it files", "Sure enough at", "Notes and the playground"]]],
    "Backup and moving to another computer": [["Backups", ["Make a backup", "Compression", "Restore a backup", "Backup plans", "Backups folder"]], ["Bringing things in", ["Import Google Keep"]], ["Safety nets", ["Task history copies", "Data recovery"]], ["Cloud", ["Leonote Cloud"]]],
  };
  for (const [title, parts] of Object.entries(SUBHEADS)) {
    const g = groups.find((x) => x.title === title);
    const box = g && g.sec.querySelector(":scope > .set-rows");
    if (!box) continue;
    // each labelled row with the unlabelled ones after it
    const units = [];
    for (const el of [...box.children]) {
      const l = el.querySelector && el.querySelector(":scope > .set-label > div");
      if (l || !units.length) units.push({ label: l ? l.textContent : "", els: [el] });
      else units[units.length - 1].els.push(el);
    }
    const used = new Set();
    const order = [];
    for (const [head, labels] of parts) {
      const mine = labels.map((lb) => units.find((u) => u.label === lb && !used.has(u))).filter(Boolean);
      if (!mine.length) continue;
      order.push(h("div", { class: "set-subhead", text: head }));
      for (const u of mine) { used.add(u); order.push(...u.els); }
    }
    const rest = units.filter((u) => !used.has(u));
    // the master switch of a group (Use Jev) stays on top, above the first heading
    const top = rest.filter((u) => u === units[0]);
    box.replaceChildren(...top.flatMap((u) => u.els), ...order, ...rest.filter((u) => !top.includes(u)).flatMap((u) => u.els));
  }
  // where a jump landed: the group's name glows for a moment
  const arrived = (sec) => { sec.classList.remove("is-arrived"); void sec.offsetWidth; sec.classList.add("is-arrived"); clearTimeout(sec._arrived); sec._arrived = setTimeout(() => sec.classList.remove("is-arrived"), 1600); };

  // settings that do nothing while their group's switch is off are dimmed (still there to set ahead)
  const DEPENDS = [
    ["Sounds", () => !!S.uiSounds, ["Volume"]],
    ["Jev", () => S.jevOn !== false, ["Where it runs", "Key", "Laya's address", "New tasks it files", "Sure enough at", "Notes and the playground"]],
    ["Browser", () => !!S.webHistoryOn, ["One entry per site"]],
    ["Daily notes", () => (S.dailyMode || "yearly") === "yearly", ["Yearly note file", "Day heading", "New days go at the"]],
    ["Daily notes", () => S.dailyMode === "daily", ["Daily notes folder"]],
    ["Where new things go", () => S.newNoteDir === "folder", ["The one folder"]],
    ["Trash", () => S.trashMode !== "bin", ["Keep things in trash for"]],
  ];
  const paintDepends = () => {
    for (const [title, on, labels] of DEPENDS) {
      const g = groups.find((x) => x.title === title);
      if (!g) continue;
      for (const r of g.sec.querySelectorAll(".set-row")) {
        const l = r.querySelector(".set-label > div");
        if (l && labels.includes(l.textContent)) { r.classList.toggle("is-idle", !on()); r.title = on() ? "" : "Does nothing with what is set above"; }
      }
    }
  };
  paintDepends();
  app.bus.on("settings", (k) => { if (k === "uiSounds" || k === "jevOn" || k === "webHistoryOn" || k === "dailyMode" || k === "newNoteDir" || k === "trashMode") paintDepends(); });
  // a long explanation under a setting shows three lines; a click on it shows the rest (and folds it again)
  // a row of choices too wide for one line: two even rows of equal choices, not three and a stray one
  const evenRows = () => {
    for (const sg of el.querySelectorAll(".set-ctl .segmented")) {
      if (!sg.offsetParent) continue;
      sg.classList.remove("is-two");
      const kids = [...sg.children];
      if (kids.length < 3 || kids[kids.length - 1].offsetTop <= kids[0].offsetTop + 4) continue;
      sg.style.setProperty("--cols", String(Math.ceil(kids.length / 2)));
      sg.classList.add("is-two");
    }
  };
  const markLong = () => {
    evenRows(); for (const t of el.querySelectorAll(".set-label .set-hint")) t.classList.toggle("is-long", t.classList.contains("is-open") || t.scrollHeight > t.clientHeight + 2); };
  el.addEventListener("click", (e) => { const t = e.target.closest && e.target.closest(".set-label .set-hint.is-long"); if (t && !getSelection().toString()) t.classList.toggle("is-open"); });
  // watched on the page itself, which grows as groups unfold (the view around it keeps its size)
  if (window.ResizeObserver) { const ro = new ResizeObserver(() => markLong()); ro.observe(el); ro.observe(el.firstElementChild); }
  requestAnimationFrame(markLong);
  // quick ways round, at the top: the categories as small pills, and every group a fold away
  {
    const cardsNow = [...el.querySelectorAll(".set-cat-card")];
    const go = (target, glow) => { target.scrollIntoView({ behavior: "smooth", block: "start" }); if (glow) arrived(glow); };
    const all = h("div", { class: "set-quick-all", hidden: !S.settingsQuickOpen },
      ...CATEGORIES.map(([cat, names]) => {
        const gs = groups.filter((g) => names.includes(g.title));
        return gs.length ? h("div", { class: "set-quick-row" }, h("span", { class: "set-quick-lab", text: cat }),
          h("div", { class: "set-quick-chips" }, ...gs.map((g) => h("button", { class: "set-quick-chip", onclick: () => { g.sec.unfold(); go(g.sec, g.sec); } }, icon(GROUP_ICON[g.title] || "settings"), shortName(g.title))))) : null;
      }).filter(Boolean));
    const more = h("button", { class: "set-quick-more" + (S.settingsQuickOpen ? " is-open" : ""), title: "Every group, by category", onclick: () => {
      const open = all.hidden;
      all.hidden = !open; more.classList.toggle("is-open", open);
      if (open) { all.classList.remove("is-opening"); void all.offsetWidth; all.classList.add("is-opening"); }
      app.setSetting("settingsQuickOpen", open);
    } }, "All groups", icon("chevronDown"));
    const quick = h("nav", { class: "set-quick", "aria-label": "Quick ways round the settings" },
      h("div", { class: "set-quick-cats" },
        ...cardsNow.map((c) => h("button", { class: "set-quick-cat", title: c.querySelector(".set-cat-sub").textContent, onclick: () => { c.open(); go(c, c.querySelector(".set-group")); } },
          icon(CAT_ICON[c.dataset.cat] || "settings"), c.dataset.cat)),
        more),
      all);
    noMatch.after(quick);
  }
  // no field here is filled from the browser's own form memory
  for (const i of el.querySelectorAll("input:not([autocomplete])")) i.setAttribute("autocomplete", "off");
  animateRows(el.firstElementChild); // one-off: the page is built once
  return { show(o) { const g = o && o.group && groups.find((x) => x.title === o.group); if (g) { if (g.sec.card) g.sec.card.open(); g.sec.unfold(); g.sec.scrollIntoView({ block: "start" }); arrived(g.sec); } } };
}

/** Google Drive: the vault kept in a "Leonote" folder on the user's own Drive (only files Leonote made are seen).
 *  Hidden while this build cannot sign in to Google. A sync the brake stopped asks before it trashes many notes. */
function driveRow(app, row) {
  const btns = h("div", { class: "set-btns" });
  const el = row("Google Drive", "Your notes in a “Leonote” folder on your own Google Drive, on every device you sign in on. Leonote sees only the files it made there. A note changed in two places is kept twice, never overwritten; deleted notes go to a trash you can restore from.", btns);
  el.hidden = true;
  const say = (r) => {
    const parts = [r.up && `${r.up} up`, r.down && `${r.down} down`, r.both && `${r.both} kept twice (changed in both places)`, r.binned && `${r.binned} to a trash`].filter(Boolean);
    app.toast(parts.length ? `Drive: ${parts.join(", ")}${r.failed.length ? ` · ${r.failed.length} could not be synced` : ""}` : (r.failed.length ? `Drive: ${r.failed.length} could not be synced` : "Drive: everything is in sync"), { ms: 6000, kind: r.failed.length ? "error" : undefined });
    if (r.failed.length) console.warn("Drive sync:", r.failed);
  };
  const sync = async (sure) => {
    try {
      if (app.flushAll) await app.flushAll(); // what is being typed is on disk before Drive's copy can come down over it
      say(await app.host.driveSync(sure));
    }
    catch (e) {
      const m = String(e);
      if (!sure && /would move \d+ notes/.test(m) && (await confirmDialog("Move these notes to the trash?", m, { ok: "Yes, sync" }))) return sync(true);
      app.toast(m, { kind: "error", ms: 8000 });
    }
  };
  const paint = async () => {
    let s = { ready: false };
    try { s = await app.host.driveStatus(); } catch {}
    el.hidden = !s.ready;
    btns.replaceChildren(...(s.connected
      ? [h("button", { class: "btn btn-primary", onclick: () => sync(false) }, icon("rotateRight"), "Sync now"),
         h("button", { class: "btn", onclick: async () => { await app.host.driveDisconnect().catch(() => {}); paint(); } }, "Disconnect")]
      : [h("button", { class: "btn btn-primary", onclick: async () => {
          app.toast("Sign in to Google in your browser…", { ms: 8000 });
          try { await app.host.driveConnect(); app.toast("Google Drive connected", { ms: 3000 }); paint(); sync(false); }
          catch (e) { app.toast(String(e), { kind: "error", ms: 8000 }); }
        } }, icon("link"), "Connect Google Drive")]));
  };
  if (app.host.driveStatus) paint();
  return el;
}
