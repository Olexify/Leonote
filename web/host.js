// The only file that knows about Tauri. Everything else talks to `host`.
// In a plain browser (design work, tests) the same API is served by mock.js.

let backend = null;
const guestAbs = new Map(); // guest id -> where the outside file really is
let vaultAbs = "";

async function load() {
  const T = window.__TAURI__;
  if (T && T.core) {
    const invoke = T.core.invoke;
    const win = T.window.getCurrentWindow();
    backend = {
      real: true,
      invoke,
      listen: (ev, fn) => T.event.listen(ev, (e) => fn(e.payload)),
      emitTo: (label, ev, payload) => T.event.emitTo(label, ev, payload),
      win: {
        show: () => win.show().then(() => win.setFocus()).catch(() => {}),
        hide: () => win.hide().then(() => T.event.emit("app:hidden")),
        isVisible: () => win.isVisible(),
        isMinimized: () => win.isMinimized(),
        unminimize: () => win.unminimize(),
        minimize: () => win.minimize(),
        toggleMaximize: () => win.toggleMaximize(),
        close: () => win.close(),
        destroy: () => win.destroy(),
        isMaximized: () => win.isMaximized(),
        onResized: (fn) => win.onResized(fn),
        onCloseRequested: (fn) => win.onCloseRequested(fn),
        setAlwaysOnTop: (v) => win.setAlwaysOnTop(v),
        setFullscreen: (v) => win.setFullscreen(v),
        isFullscreen: () => win.isFullscreen(),
        startDragging: () => win.startDragging(),
        setSkipTaskbar: (v) => win.setSkipTaskbar(v),
        // page zoom of the webview itself: scales text, icons and layout
        // together with no reflow tricks on our side
        setZoom: (v) => T.webview.getCurrentWebview().setZoom(v),
        unmaximize: () => win.unmaximize(),
        maximize: () => win.maximize(),
        scaleFactor: () => win.scaleFactor(),
        outerPosition: () => win.outerPosition(),
        innerSize: () => win.innerSize(),
        setSize: (w, h) => win.setSize(new (T.dpi || T.window).LogicalSize(w, h)),
        /** Size, place and maximize in one native step; gives back where the window was ({ x, y, w, h, max }). */
        place: (o) => T.core.invoke("win_place", o),
        setPosition: (x, y) => win.setPosition(new (T.dpi || T.window).LogicalPosition(x, y)),
      },
    };
  } else {
    const mock = await import("./mock.js");
    backend = mock.createMockBackend();
  }
  return backend;
}

export const call = (cmd, args) => backend.invoke(cmd, args);

export const host = {
  load,
  get real() { return !!backend?.real; },
  get win() { return backend.win; },
  on: (ev, fn) => backend.listen(ev, fn),

  boot: () => call("boot"),

  writeNote: (path, content) => call("note_write", { path, content }),
  stampNote: (path, content) => call("note_stamp", { path, content }),
  copyInVault: (paths, dir) => call("vault_copy", { paths, dir }),
  loadIds: () => call("ids_load"),
  // the pictures' shapes, kept in the vault
  picsLoad: () => call("pics_load"),
  picsSave: (data) => call("pics_save", { data }),
  saveIds: (data) => call("ids_save", { data }),
  createNote: (path, content) => call("note_create", { path, content }),
  renameNote: (from, to) => call("note_rename", { from, to }),
  // mode: undefined/"trash" -> the vault's .trash, "bin" -> the Windows Recycle Bin, "forever" -> gone
  trashNote: (path, mode) => call("note_trash", { path, mode }),
  trashList: () => call("trash_list"),
  trashRestore: ({ entry, from }) => call("trash_restore", { entry, from }),
  trashRemove: (entries) => call("trash_remove", { entries }),
  trashSweep: (days, since) => call("trash_sweep", { days, since }),
  trashOpen: (bin) => call("trash_open", { bin: !!bin }),
  // earlier versions of a note, kept in ~/.leonote/history/notes (notehist.rs)
  noteVersions: (path) => call("note_versions", { path }),
  noteVersionRead: (path, stamp) => call("note_version_read", { path, stamp }),
  noteVersionKeep: (path) => call("note_version_keep", { path }),
  tasksErase: (ids) => call("tasks_erase", { ids }),
  noteHistoryErase: (path, dry) => call("note_history_erase", { path, dry: !!dry }),
  createFolder: (path) => call("folder_create", { path }),
  renameFolder: (from, to) => call("folder_rename", { from, to }),
  trashFolder: (path, mode) => call("folder_trash", { path, mode }),

  taskOps: (ops) => call("task_ops", { ops }),
  saveHabits: (data) => call("habits_save", { data }),
  saveSettings: (data) => call("settings_save", { data }),
  tasksRestore: (file) => call("tasks_restore", { file }),
  tasksHistoryList: () => call("tasks_history_list"),
  quitHold: (wait = false) => call("app_quit_hold", { wait }),
  backupCategories: () => call("backup_categories"),
  backupPlain: (path, categories, exts, compression, keep) => call("backup_plain", { path, categories, exts, compression, keep }),
  archiveList: (path) => call("archive_list", { path }),
  archivePreview: (path, entry) => call("archive_preview", { path, entry }),
  archiveExtract: (path, entries, into) => call("archive_extract", { path, entries, into }),
  syncFolders: () => call("sync_folders"),
  saveRecurring: (data) => call("recurring_save", { data }),
  savePriorities: (data) => call("priorities_save", { data }),
  saveStats: (data) => call("stats_save", { data }),

  aiKeySet: (id, key, base) => call("ai_key_set", { id, key, base: base || null }),
  aiKeyGet: (id) => call("ai_key_get", { id }),
  aiKeyHide: (id) => call("ai_key_hide", { id }),
  aiKeyHidden: (id) => call("ai_key_hidden", { id }),
  jevBackendGet: () => call("jev_backend_get"),
  jevBackendSet: (backend, base, model) => call("jev_backend_set", { backend, base: base || "", model: model || "" }),
  layaInstall: () => call("laya_install"),
  layaStart: () => call("laya_start"),
  jevAsk: (body) => call("jev_ask", { body }),
  proposalsList: () => call("proposals_list"),
  proposalsCount: () => call("proposals_count"),
  proposalAccept: (id, merged = null) => call("proposal_accept", { id, merged }),
  proposalReject: (id) => call("proposal_reject", { id }),
  proposalMake: (path, content, kind, agent, why) => call("proposal_make", { path, content, kind, agent, why }),
  aiAccessGet: () => call("ai_access_get"),
  aiAccessSet: (folder, mode) => call("ai_access_set", { folder, mode }),
  aiTasksSet: (split) => call("ai_tasks_set", { split: !!split }),
  aiFullSet: (full) => call("ai_full_set", { full: !!full }),
  aiKeysHave: () => call("ai_keys_have"),
  aiChat: (req) => call("ai_chat", { id: req.id, provider: req.provider, kind: req.kind, base: req.base, model: req.model, system: req.system || null, messages: req.messages, tools: req.tools && req.tools.length ? req.tools : null, maxTokens: req.maxTokens || null, format: req.format || null, look: !!req.look }),
  mcpCommand: () => call("mcp_command"),
  pluginList: () => call("plugin_list"),
  pluginInstallFolder: () => call("plugin_install_folder"),
  pluginSearch: () => call("plugin_search"),
  pluginInstallListed: (id) => call("plugin_install_listed", { id }),
  pluginEnable: (id) => call("plugin_enable", { id }),
  pluginDisable: (id) => call("plugin_disable", { id }),
  pluginRemove: (id) => call("plugin_remove", { id }),
  pluginMain: (id) => call("plugin_main", { id }),
  pluginFetch: (id, url) => call("plugin_fetch", { id, url }),
  aiCancel: (id) => call("ai_cancel", { id }),
  aiModels: (p) => call("ai_models", { provider: p.provider, kind: p.kind, base: p.base }),
  reclaimFocus: () => call("reclaim_focus"),
  // a folder as a project (project.rs): find, replace with copies kept, the user's own git
  projectInfo: (root) => call("project_info", { root }),
  projectFiles: (root, exclude) => call("project_files", { root, exclude: exclude || [] }),
  projectSearch: (root, query, opts, only) => call("project_search", { root, query, opts, only: only || null }),
  projectReplace: (root, query, withText, opts, paths) => call("project_replace", { root, query, with: withText, opts, paths }),
  projectUndo: (root, stamp) => call("project_undo", { root, stamp }),
  projectGit: (root, action, arg) => call("project_git", { root, action, arg: arg == null ? null : String(arg) }),
  videoFullscreen: (on, remax) => call("video_fullscreen", { on, remax: !!remax }),
  // a Windows notification: a title and a line
  osNotify: (title, body) => call("os_notify", { title, body }),
  quit: () => call("app_quit").catch(() => backend.win.destroy()),
  trace: (msg) => call("trace_ui", { msg }).catch(() => {}),
  requestQuit: () => call("app_request_quit"),
  setAutostart: (enabled) => call("autostart_set", { enabled }),
  autostartRepoint: () => call("autostart_repoint"),
  reveal: (path) => call("reveal", { path }),
  revealSettings: () => call("reveal_settings"),
  openPath: (path) => call("open_path", { path }),
  readText: (path) => call("file_read_text", { path }),
  fileTrash: (path, mode) => call("file_trash", { path, mode }),
  fileRename: (from, to) => call("file_rename", { from, to }),
  savePositions: (data) => call("positions_save", { data }),
  loadGraph: () => call("graph_load"),
  saveGraph: (data) => call("graph_save", { data }),
  fitLoad: () => call("fit_load"),
  fitSave: (data) => call("fit_save", { data }),
  textSave: (path, text) => call("text_save", { path, text }),
  vaultCandidates: () => call("vault_candidates"),
  dataDirSet: (mode) => call("data_dir_set", { mode }),
  restart: () => { try { localStorage.removeItem("leonote.plugins-starting"); } catch {} return call("app_restart"); }, // a restart is no stuck plugin
  vaultMissing: (create) => call("vault_missing", { create }),
  welcomeText: () => call("welcome_text"),
  rescueKeep: (path, content) => call("rescue_keep", { path, content }),
  rescueDrop: (path) => call("rescue_drop", { path }),
  rescueList: () => call("rescue_list"),

  setVaultAbs(abs) { vaultAbs = String(abs || ""); },
  getVaultAbs: () => vaultAbs,
  folderSizes: (path) => call("folder_sizes", { path }),
  // Disk space, gradual: { result } at once from memory, or { id } to poll; stop when another is asked
  sizesStart: (path, fresh = false) => call("sizes_start", { path, fresh }),
  sizesPoll: (id) => call("sizes_poll", { id }),
  sizesStop: (id) => call("sizes_stop", { id }),
  driveSpace: (path) => call("drive_space", { path }),
  /** URL the webview can load for a vault file (images, PDFs, media). */
  assetUrl(rel) {
    const T = window.__TAURI__;
    // HEIC (iPhone photos): the webview cannot read it, Windows can - phone.rs hands it over as a JPEG
    if (/\.(heic|heif)$/i.test(rel) && T && T.core && vaultAbs && !String(rel).startsWith("@guest/")) {
      const win = vaultAbs.includes("\\");
      const abs = vaultAbs.replace(/[\\/]+$/, "") + (win ? "\\" + rel.replace(/\//g, "\\") : "/" + rel);
      return this.assetAbs(abs);
    }
    // an outside file opened as a guest: its own place on the disk
    if (String(rel).startsWith("@guest/")) { const abs = guestAbs.get(String(rel).split("/")[1]); return abs && T && T.core ? T.core.convertFileSrc(abs) : backend && backend.assetUrl ? backend.assetUrl(rel) : ""; }
    if (!T || !T.core || !vaultAbs) return backend && backend.assetUrl ? backend.assetUrl(rel) : "";
    const win = vaultAbs.includes("\\");
    const sep = win ? "\\" : "/";
    const abs = vaultAbs.replace(/[\\/]+$/, "") + sep + (win ? rel.replace(/\//g, "\\") : rel);
    return T.core.convertFileSrc(abs);
  },
  /** URL for a file anywhere on the disk (a Player library outside the vault). */
  assetAbs(abs) {
    const T = window.__TAURI__;
    if (!T || !T.core) return backend && backend.assetAbs ? backend.assetAbs(abs) : "";
    if (/\.(heic|heif)$/i.test(abs)) return T.core.convertFileSrc("", "heic") + "?p=" + encodeURIComponent(abs);
    return T.core.convertFileSrc(abs);
  },
  // media folders outside the vault: the Rust side scans them and lets the
  // webview load them (the asset protocol only serves allowed directories)
  libraryAdd: (path) => call("library_add", { path }),
  // one loopback redirect for a sign-in the user does in their own browser
  oauthListen: (state) => call("oauth_listen", { state }),
  oauthWait: (port, timeoutMs) => call("oauth_wait", { port, timeoutMs }),
  googleToken: (form, slot) => call("google_token", { form, slot }),
  // names inside the vault's dot-folders, for the tree's search
  hiddenFind: (query, limit = 60) => call("hidden_find", { query, limit }),
  // the video editor's AI panel: the project's overview, or the project with edits applied
  videoAi: (project, ops = null) => call("video_ai", { project, ops }),
  ytPreviews: () => call("yt_previews"),
  ytPreviewKeep: (id, refresh) => call("yt_preview_keep", { id, refresh }),
  // a kept picture made small: its bytes out, the small WebP back in its place
  ytPreviewBytes: (id) => call("yt_preview_bytes", { id }),
  ytPreviewPut: (id, data) => call("yt_preview_put", { id, data }),
  voiceListen: () => call("voice_listen"),
  speechTranscribe: (o) => call("speech_transcribe", { base: o.base, model: o.model, keyIds: o.keyIds, audio: o.audio, mime: o.mime, lang: o.lang || null, prompt: o.prompt || null }),
  libraryScan: (path) => call("library_scan", { path }),
  openUrl: (url) => call("open_url", { url }),
  // raw bytes as the request body; the path rides in a header
  // encrypted backups (the password only travels to the local backend)
  backupExport: (path, password, includeVault, compression) => call("backup_export", { path, password, includeVault, compression }),
  backupPeek: (path, password) => call("backup_peek", { path, password }),
  backupImport: (path, password, restoreVault) => call("backup_import", { path, password, restoreVault }),
  // native save/open dialogs; the browser mock answers with a fixed path
  // through Leonote itself (grant.rs): what the user picks in these dialogs is theirs, and Leonote may then write there
  dialogSave: (opts) => (window.__TAURI__ && window.__TAURI__.dialog ? call("pick_save", { opts: opts || {} }) : Promise.resolve(backend.mockPath || null)),
  // after writing the file a save dialog gave: on a phone this carries it to the place picked (nothing to do on a computer)
  saveDone: (path) => (window.__TAURI__ && window.__TAURI__.dialog ? call("pick_save_done", { path }) : Promise.resolve()),
  dialogOpen: (opts) => (window.__TAURI__ && window.__TAURI__.dialog ? call("pick_open", { opts: opts || {} }) : Promise.resolve((backend.dialogOpen && backend.dialogOpen(opts)) || backend.mockPath || null)),
  writeFile: (path, bytes) => backend.invoke("file_write", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
  pasteFiles: (dir) => call("paste_files", { dir }),
  // files outside the vault: absolute OS paths, not vault-relative ones
  externalStat: (path) => call("external_stat", { path }),
  outpostTexts: (limit) => call("outpost_texts", { limit }),
  /** Pictures and videos in the viewer window(s): each its own, or (one) the one viewer window. */
  viewerOpen: (paths, one) => call("viewer_open", { paths, one: !!one }),
  scriptOpen: (path, title, text, update = false) => call("script_open", { path, title, text, update }),
  scriptPath: () => call("script_path"),
  externalRead: (path, anyway) => call("external_read", { path, anyway: !!anyway }),
  externalWrite: (path, content) => call("external_write", { path, content }),
  miniPlayer: (open) => call("mini_player", { open }),
  ytMini: (open) => call("yt_mini", { open }),
  breakPop: (open) => call("break_pop", { open }),
  splitWebShow: (url, r, id) => call("split_web_show", { url: url || null, x: r.x, y: r.y, w: r.w, h: r.h, id: id || null }),
  splitWebHide: (id) => call("split_web_hide", { id: id || null }),
  splitWebClose: (id) => call("split_web_close", { id: id || null }),
  splitWebGo: (action, id) => call("split_web_go", { action, id: id || null }),
  // a browser tab of the main strip: its own native view, by the tab's id
  tabWebFocus: (id) => call("tab_web_focus", { id }),
  tabWebZoom: (id, zoom) => call("tab_web_zoom", { id, zoom }),
  tabWebPost: (id, msg) => call("tab_web_post", { id, msg }),
  tabWebMute: (id, muted) => call("tab_web_mute", { id, muted }),
  tabWebMemory: (id) => call("tab_web_memory", { id }),
  tabWebDownloadReply: (label, token, allow) => call("tab_web_download_reply", { label, token, allow }),
  tabWebShow: (id, url, r, sleep, awake) => call("tab_web_show", { id, url: url || null, x: r.x, y: r.y, w: r.w, h: r.h, holes: r.holes || [], sleep: sleep || 0, awake: awake || 0 }),
  tabWebHide: (id, sleep, awake) => call("tab_web_hide", { id: id || null, sleep: sleep || 0, awake: awake || 0 }),
  tabWebClose: (ids, keep) => call("tab_web_close", { ids, keep: !!keep }),
  tabWebGo: (id, action) => call("tab_web_go", { id, action }),
  // browser add-ons for the tabs' web views (WebView2 extensions)
  webExtList: () => call("web_ext_list"),
  webExtInstall: (source) => call("web_ext_install", { source }),
  webExtSet: (id, enabled) => call("web_ext_set", { id, enabled }),
  webExtSites: (id, sites) => call("web_ext_sites", { id, sites }),
  webExtRemove: (id) => call("web_ext_remove", { id }),
  webExtUpdate: (ids, known) => call("web_ext_update", { ids, known }),
  extPopShow: (url, r, zoom) => call("ext_pop_show", { url, x: r.x, y: r.y, w: r.w, h: r.h, zoom: zoom || 1 }),
  extPopHide: () => call("ext_pop_hide"),
  // asked in this computer's languages: a site otherwise guesses one from where the request comes from
  officeConvert: (path) => call("office_convert", { path }),
  webHistoryGet: () => call("web_history_get"),
  webHistorySet: (json) => call("web_history_set", { json }),
  webPasswordsForget: () => call("web_passwords_forget"),
  webPasswordsSet: (on) => call("web_passwords_set", { on: !!on }),
  pwStatus: () => call("pw_status"),
  pwUnlock: (master) => call("pw_unlock", { master }),
  pwReset: () => call("pw_reset"),
  pwLock: () => call("pw_lock"),
  pwList: () => call("pw_list"),
  pwCopy: (id) => call("pw_copy", { id }),
  pwCopyText: (text) => call("pw_copy_text", { text }),
  pwReveal: (id) => call("pw_reveal", { id }),
  pwPut: (item) => call("pw_put", { item }),
  pwRemove: (id) => call("pw_remove", { id }),
  pwFill: (tab, id, allow, origin) => call("pw_fill", { tab, id, allow: allow || [], origin: origin || null }),
  pwOfferSave: (id) => call("pw_offer_save", { id }),
  pwOfferDrop: (id) => call("pw_offer_drop", { id }),
  sourceFetch: (url) => call("source_fetch", { url }),
  linkPicture: (url) => call("link_picture", { url }),
  linkPreview: (url) => call("link_preview", { url, lang: (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]).slice(0, 4).map((l, i) => (i ? `${l};q=${(1 - i * 0.1).toFixed(1)}` : l)).join(",") }),
  emitTo: (label, ev, payload) => (backend.emitTo ? backend.emitTo(label, ev, payload) : Promise.resolve()),
  stageExternal: (name, bytes) => backend.invoke("external_stage", bytes, { headers: { "x-name": encodeURIComponent(name) } }),
  externalImport: (path, dir, moveIt) => call("external_import", { path, dir, moveIt }),
  externalPutBack: (path, to) => call("external_put_back", { path, to }),
  externalOpenInApp: (path) => call("external_open_in_app", { path }),
  externalReveal: (path) => call("external_reveal", { path }),
  externalRename: (path, name) => call("external_rename", { path, name }),
  /** An outside file registered for the vault's own viewers: its FileEntry, under `@guest/<id>/<name>`. */
  guestOpen: (path) => call("guest_open", { path }).then((entry) => { guestAbs.set(String(entry.path).split("/")[1], path); return entry; }),
  hiddenList: (rel) => call("hidden_list", { rel }),
  /** Notes in the folders kept out of the index holding every word, read from the disk now. */
  unindexedFind: (query, limit = 60) => call("unindexed_find", { query, limit }),
  unindexedNames: () => call("unindexed_names"),
  noIndexSet: (list) => call("no_index_set", { list }),
  claudeImport: (dest) => call("claude_import", { dest }),
  updateCheck: () => call("update_check"),
  updateFetch: () => call("update_fetch"),
  updateApply: () => call("update_apply"),
  updateInstallQuit: () => call("update_install_quit"),
  apkFetch: (version) => call("apk_fetch", { version }),
  apkInstall: (path, ask) => call("apk_install", { path, ask: !!ask }),
  driveStatus: () => call("drive_status"),
  driveConnect: () => call("drive_connect"),
  driveDisconnect: () => call("drive_disconnect"),
  driveSync: (sure) => call("drive_sync", { sure: !!sure }),
  captionsMake: (rel, from, len, lang) => call("captions_make", { rel, from, len, lang: lang || null }),
  onlineTools: () => call("online_tools"),
  onlineInstall: (tool) => call("online_install", { tool }),
  toolInstall: (tool, direct) => call("tool_install", { tool, direct: !!direct }),
  // a phone by USB (phone.rs): its folders listed as `phone:list` events, files copied or moved with `phone:copy` events
  phoneDevices: () => call("phone_devices"),
  phoneList: (dev, parent, req) => call("phone_list", { dev, parent, req }),
  phoneCopy: (dev, items, dir, remove, job) => call("phone_copy", { dev, items, dir, remove: !!remove, job }),
  phoneDelete: (dev, ids, expect) => call("phone_delete", { dev, ids, expect }),
  keepImport: (dir, into) => call("keep_import", { dir, into }),
  phoneScan: (dev, req, skipSystem) => call("phone_scan", { dev, req, skipSystem: !!skipSystem }),
  phoneScanStop: () => call("phone_scan_stop"),
  phoneFingerprints: (dev, ids) => call("phone_fingerprints", { dev, ids }),
  phoneCompress: (dev, items, codec, level, photoQuality, job) => call("phone_compress", { dev, items, codec, level, photoQuality, job }),
  phoneCompressApply: (dev, parent, items, job) => call("phone_compress_apply", { dev, parent, items, job }),
  phoneCompressDiscard: (job) => call("phone_compress_discard", { job }),
  // the video editor's exact export through ffmpeg (videoexport.rs): frames as JPEGs, the sound as a WAV
  videoExportBegin: (rel, fps, crf, audio) => call("video_export_begin", { rel, fps, crf, audio: !!audio }),
  videoExportAudio: (id, bytes) => backend.invoke("video_export_audio", bytes, { headers: { "x-id": String(id) } }),
  videoExportStart: (id) => call("video_export_start", { id }),
  videoExportFrame: (id, bytes) => backend.invoke("video_export_frame", bytes, { headers: { "x-id": String(id) } }),
  videoExportEnd: (id, rel) => call("video_export_end", { id, rel }),
  videoExportCancel: (id) => call("video_export_cancel", { id }),
  musicTags: (path, cover) => call("music_tags", { path, cover: !!cover }),
  musicTagsWrite: (path, fields) => call("music_tags_write", { path, fields }),
  // lets the webview load one outside picture, video, song or PDF
  externalAllow: (path) => call("external_allow", { path }),
  // outposts: folders hooked up next to the vault, managed where they lie
  outpostAdd: (path) => call("outpost_add", { path }),
  outpostForget: (path) => call("outpost_forget", { path }),
  outpostList: (path) => call("outpost_list", { path }),
  outpostFind: (query, limit) => call("outpost_find", { query, limit }),
  outpostRename: (path, name) => call("outpost_rename", { path, name }),
  outpostMkdir: (dir, name) => call("outpost_mkdir", { dir, name }),
  outpostImport: (dir, path, bytes) => backend.invoke("outpost_import", bytes, { headers: { "x-dir": encodeURIComponent(dir), "x-path": encodeURIComponent(path) } }),
  outpostTrash: (paths) => call("outpost_trash", { paths }),
  associateFiles: (exts, enable) => call("associate_files", { exts, enable }),
  associateState: (exts) => call("associate_state", { exts }),
  importFile: (path, bytes) => backend.invoke("file_import", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
  // "This PC": an in-memory index of file and folder NAMES under your own
  // folders (src-tauri/src/pcsearch.rs). Contents are never read.
  pcIndexStart: (roots, force) => call("pc_index_start", { roots: roots || [], force: !!force }),
  pcIndexState: () => call("pc_index_state"),
  pcIndexCancel: () => call("pc_index_cancel"),
  pcRoots: (roots) => call("pc_roots", { roots: roots || [] }),
  pcDrives: () => call("pc_drives", {}),
  pcSearch: (query, limit) => call("pc_search", { query, limit }),
  // Web panels: a shortcut opens as its own ordinary browser window, with no
  // Tauri permissions and nothing injected into the page (webwin.rs).
  webOpen: (opts) => call("web_window_open", opts),
  webClose: (id) => call("web_window_close", { id }),
  webList: () => call("web_window_list"),
  // non-destructive picture edits: layers and colour adjustments stored in a
  // sidecar beside the picture, never inside it (see imageedit.rs)
  imageEditRead: (path) => call("image_edit_read", { path }),
  imageEditWrite: (path, content) => call("image_edit_write", { path, content }),
  imageEditDelete: (path) => call("image_edit_delete", { path }),
  saveImage: (path, bytes) => backend.invoke("image_save", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
  // Draw documents (.leopaint) - a zip of PNGs, written by src-tauri/src/paint.rs
  paintSave: (path, manifest, layers, thumb) => call("paint_save", { path, manifest, layers, thumb }),
  paintLoad: (path) => call("paint_load", { path }),
  paintInspect: (path) => call("paint_inspect", { path }),
};
