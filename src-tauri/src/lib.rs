// Leonote (Rust/Tauri).
//
// Shares the Python app's data files, so two rules govern everything here:
//
//  1. TASKS ARE PASSED THROUGH AS RAW JSON. Modelling them as a struct means
//     every field I forget (due_jumped, due_time, scheduled_jumped, rec_id,
//     rec_date, ...) - and every field a future Python release adds - gets
//     silently dropped on save. Even Option<T> is unsafe: `"due_date": null`
//     round-trips to a MISSING key. serde_json::Value is exact by construction.
//     Typed views can be layered on later for logic that actually needs them.
//  2. WRITES ARE ATOMIC. Tasks are only ever appended as sparse ops; notes,
//     habits and settings go through temp+fsync+rename.

#[cfg(mobile)]
use crate::mobile::*;
#[cfg(mobile)]
mod mobile;
mod ai;
mod drive;
mod drivesync;
mod jev;
mod proposals;
mod officeconv;
mod backup;
mod pw;
mod clip;
mod datadir;
mod external;
mod imageedit;
mod interop;
mod library;
mod mcp;
mod outpost;
mod notehist;
mod oauth;
mod ytlist;
mod music;
mod voice;
mod speech;
mod obsidian;
mod paint;
mod pcsearch;
mod phone;
mod keep;
mod videoexport;
mod videoai;
mod project;
mod settings;
mod store;
mod trashbin;
mod sizes;
mod vault;
mod watch;
mod webwin;
mod viewer;
mod script;
mod claude_import;
mod update;
mod grant;
mod webext;
mod linkcard;
mod plugins;
#[cfg(test)]
#[path = "ai_tests.rs"]
mod ai_tests;
#[cfg(test)]
#[path = "mcp_tests.rs"]
mod mcp_tests;
#[cfg(test)]
#[path = "backup_tests.rs"]
mod backup_tests;
#[cfg(test)]
#[path = "datadir_tests.rs"]
mod datadir_tests;
#[cfg(test)]
#[path = "external_tests.rs"]
mod external_tests;
#[cfg(test)]
#[path = "interop_tests.rs"]
mod interop_tests;
#[cfg(test)]
#[path = "library_tests.rs"]
mod library_tests;
#[cfg(test)]
#[path = "outpost_tests.rs"]
mod outpost_tests;
#[cfg(test)]
#[path = "notehist_tests.rs"]
mod notehist_tests;
#[cfg(test)]
#[path = "oauth_tests.rs"]
mod oauth_tests;
#[cfg(test)]
#[path = "paint_tests.rs"]
mod paint_tests;
#[cfg(test)]
#[path = "pcsearch_tests.rs"]
mod pcsearch_tests;
#[cfg(test)]
#[path = "project_tests.rs"]
mod project_tests;
#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;
#[cfg(test)]
#[path = "trashbin_tests.rs"]
mod trashbin_tests;
#[cfg(test)]
#[path = "vault_tests.rs"]
mod vault_tests;
#[cfg(test)]
#[path = "watch_tests.rs"]
mod watch_tests;
#[cfg(test)]
#[path = "webwin_tests.rs"]
mod webwin_tests;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

fn home_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    )
}

fn tasks_path() -> PathBuf {
    // LEONOTE_TASKS lets a side-by-side trial run point at a copy instead of
    // the live file.
    match std::env::var("LEONOTE_TASKS") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => home_dir().join(".leonote_tasks.json"),
    }
}

/// Local-naive timestamp with milliseconds, matching what the Python app and
/// the frontend write. NOT UTC: the same strings drive the 24h Done/Archive
/// split and Python's trash purge, and a 3-hour skew corrupts both.
///
/// chrono::Local rather than hand-rolled FFI + civil-date math: timezone and
/// DST arithmetic is exactly where quiet bugs live, and this runs on a path
/// that stamps every task the user completes.
fn now_local() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

/// A poisoned mutex only means another command panicked mid-way; the data it
/// guards (a folded array, a hash map) is still usable, and refusing every
/// later command would be worse.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Lifecycle tracing on stderr, only when LEONOTE_DEBUG is set. Shutdown bugs
/// in a windowless release build are otherwise invisible.
pub(crate) fn trace(msg: &str) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ON.get_or_init(|| std::env::var_os("LEONOTE_DEBUG").is_some()) {
        let ms = START.get().map(|s| s.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0);
        eprintln!("[+{:>7.1} ms] {}", ms, msg);
    }
}

/// Process start, for startup timing in traces.
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Closing the clock's calendar (or any taskbar flyout) leaves the keys with
/// the taskbar, not with the app that had them. When the pointer is back over
/// Leonote and it is only the Windows shell that holds the foreground, take
/// it back. Never from another program.
#[tauri::command]
fn reclaim_focus(window: tauri::Window) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow};
        let fg = unsafe { GetForegroundWindow() };
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(fg, &mut buf) } as usize;
        let class = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
        let shell = fg.0.is_null() || matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow" | "XamlExplorerHostIslandWindow" | "TopLevelWindowForOverflowXamlIsland" | "Progman" | "WorkerW");
        // our own frame already has the foreground but the page has no keys
        // (coming back from another program): only the webview needs them
        let ours = window.hwnd().map(|h| h.0 == fg.0).unwrap_or(false);
        if !shell && !ours {
            return false;
        }
        let ok = ours || window.set_focus().is_ok();
        if let Some(w) = window.app_handle().get_webview("main") {
            std::thread::spawn(move || {
                let _ = w.set_focus();
            });
        }
        return ok;
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// The frontend reports its own milestones through here, so one trace shows
/// the whole startup: process, webview, script, boot, first paint.
/// A video fills the screen, or gives it back. A frameless window that is
/// maximized has its client area clamped to the work area (so it does not run
/// under the taskbar), and that clamp stays on while the window still carries
/// the maximized style - full screen from maximized leaves a strip of bare
/// window where the taskbar was. The style bit is taken off in place and the
/// frame recalculated: the window never leaves the screen's size, so nothing
/// behind it shows and nothing flashes. Returns whether it was maximized.
/// A Windows notification (the corner pop-up, kept in the notification centre): a title and a line.
/// Packaged (Store) it speaks as the app; installed, as the app's shortcut does (its id is the identifier).
#[tauri::command]
fn os_notify(title: String, body: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Data::Xml::Dom::XmlDocument;
        use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
        let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
        let xml = format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>", esc(&title), esc(&body));
        let e = |e: windows::core::Error| e.to_string();
        let doc = XmlDocument::new().map_err(e)?;
        doc.LoadXml(&HSTRING::from(xml)).map_err(e)?;
        let toast = ToastNotification::CreateToastNotification(&doc).map_err(e)?;
        let notifier = ToastNotificationManager::CreateToastNotifier()
            .or_else(|_| ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app.config().identifier.as_str())))
            .map_err(e)?;
        notifier.Show(&toast).map_err(e)?;
    }
    #[cfg(not(windows))]
    let _ = (title, body, app);
    Ok(())
}

#[tauri::command]
fn video_fullscreen(window: tauri::Window, on: bool, remax: bool) -> bool {
    let was_max = window.is_maximized().unwrap_or(false);
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if on {
            let _ = w.set_fullscreen(true);
            #[cfg(windows)]
            if was_max {
                use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_MAXIMIZE};
                if let Ok(hwnd) = w.hwnd() {
                    unsafe {
                        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                        SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_MAXIMIZE.0 as isize));
                        let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                    }
                }
            }
        } else {
            let _ = w.set_fullscreen(false);
            if remax && !w.is_maximized().unwrap_or(false) {
                let _ = w.maximize();
            }
        }
    });
    was_max
}

#[tauri::command]
fn trace_ui(msg: String) {
    trace(&format!("ui: {}", msg));
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

// ── state ───────────────────────────────────────────────────────────────────

pub struct Paths {
    pub home: PathBuf,
    /// Log root: `log/` and the base snapshot. ~/.leonote in "user" mode
    /// (LEONOTE_DIR overrides), the vault data root otherwise.
    pub dir: PathBuf,
    pub snapshot: PathBuf,
    pub habits: PathBuf,
    /// ALWAYS ~/.leonote/app.json, in every mode: it is the bootstrap that
    /// says where the rest of the data lives, so it can never live there.
    pub settings: PathBuf,
    /// "user" | "vault" | "vault-hidden" - see datadir.rs
    pub data_mode: &'static str,
    pub vault: PathBuf,
    /// No LEONOTE_VAULT / settings.vault override: the vault is ~/LeoNote and
    /// ours to seed. Any other vault is the user's and boot writes nothing there.
    pub vault_is_default: bool,
    /// ~/.leonote_recurring.json in "user" mode - same file and shape as the
    /// Python app
    pub recurring: PathBuf,
    /// life focus areas, shared with the Python app in "user" mode
    pub priorities: PathBuf,
    /// XP, counters, focus history
    pub stats: PathBuf,
    /// remembered cursor/scroll per note
    pub positions: PathBuf,
    /// graph view layout and comment frames
    pub graph: PathBuf,
    /// the workout, food and fasting log
    pub fit: PathBuf,
    /// ~/.leonote_config.json - READ ONLY, used once to seed stats
    pub legacy_config: PathBuf,
}

impl Paths {
    fn resolve() -> Paths {
        let home = home_dir();
        let user_dir = store::leonote_dir();
        let settings = user_dir.join("app.json");
        let env = std::env::var("LEONOTE_VAULT").ok();
        let cfg = read_json(&settings).unwrap_or(Value::Null);
        let vault = vault::vault_root(env.as_deref(), &cfg, &home);
        let vault_is_default = vault::is_default_vault(env.as_deref(), &cfg);
        let data_mode = datadir::mode_of(&cfg);
        let it = datadir::items(data_mode, &home, &user_dir, &tasks_path(), &vault);
        Paths {
            vault_is_default,
            data_mode,
            dir: it.dir,
            snapshot: it.snapshot,
            habits: it.habits,
            recurring: it.recurring,
            priorities: it.priorities,
            stats: it.stats,
            positions: it.positions,
            graph: it.graph,
            fit: it.fit,
            legacy_config: home.join(".leonote_config.json"),
            home,
            settings,
            vault,
        }
    }
}

/// The canonical folded tasks. Every task-store operation - append, fold,
/// import, compact - runs under this one mutex, so the diff we emit is always
/// against the state the frontend was last told about.
#[derive(Default)]
pub struct TaskState {
    pub tasks: Vec<Value>,
}

pub struct AppState {
    pub paths: Paths,
    pub tasks: Mutex<TaskState>,
    pub echo: Mutex<watch::Echo>,
    /// Serialises vault/habits/settings writes with their echo bookkeeping.
    io: Mutex<()>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Files already copied to .trash this session before being overwritten.
    backed_up: Mutex<std::collections::HashSet<String>>,
    /// When each note last had a routine version kept (notehist.rs).
    note_kept: Mutex<std::collections::HashMap<String, Instant>>,
    booted: AtomicBool,
    exited: AtomicBool,
}

// ── task logic (State-free, so tests drive it hermetically) ─────────────────

/// Append ops to `log/ui.jsonl`, re-fold, diff against `st`, adopt the fold.
pub(crate) fn apply_ops(dir: &Path, snapshot: &Path, st: &mut TaskState, ops: &[Value], now: &str) -> Result<Value, String> {
    let lines = store::ops_to_lines(ops, "ui", now)?;
    // the whole log is read again at every task change: a pasted book does not go in
    if lines.iter().any(|l| l.len() > 4 << 20) { return Err("a task change over 4 MB was refused".into()); }
    store::append(&store::log_path_in(dir, "ui"), &lines).map_err(|e| e.to_string())?;
    let f = store::fold_in(dir, snapshot);
    if let Some(c) = f.conflicted {
        return Err(format!("saved to the log, but it has git conflict markers and will not fold: {}", c));
    }
    let patch = store::diff(&st.tasks, &f.tasks);
    st.tasks = f.tasks;
    Ok(json!({ "patch": patch, "bad": f.bad.len() }))
}

/// Post-boot housekeeping: import Python's edits, compact, re-fold.
/// Returns the patch to emit, if the state moved.
pub(crate) fn import_and_compact(dir: &Path, snapshot: &Path, st: &mut TaskState, now: &str, stamp: &str) -> Option<Value> {
    let imp = interop::import_python_changes(dir, snapshot, now);
    let mut imported = false;
    if let Some(r) = &imp.refused {
        eprintln!("python import: {}", r);
    } else if !imp.ops.is_empty() {
        match store::ops_to_lines(&imp.ops, "py", now)
            .and_then(|l| store::append(&store::log_path_in(dir, "py"), &l).map_err(|e| e.to_string()))
        {
            Ok(()) => imported = true,
            Err(e) => eprintln!("python import: append failed: {}", e),
        }
    }
    let base_missing = !interop::base_path(dir).exists();
    if base_missing || store::log_bytes_in(dir) > 0 {
        if let Err(e) = store::compact(dir, snapshot, stamp) {
            eprintln!("compaction skipped: {}", e);
        }
    }
    let f = store::fold_in(dir, snapshot);
    if f.conflicted.is_some() {
        return None;
    }
    let patch = store::diff(&st.tasks, &f.tasks);
    if patch.is_empty() {
        return None;
    }
    st.tasks = f.tasks;
    let writers: Vec<&str> = if imported { vec!["py"] } else { vec![] };
    Some(json!({ "patch": patch, "writers": writers }))
}

fn compact_stamp() -> String {
    chrono::Local::now().format("%Y%m%dT%H%M%S%.3f").to_string()
}

// ── commands ────────────────────────────────────────────────────────────────
//
// Async so file IO runs off the main thread and never stalls the event loop.

/// Everything the first paint needs, in one round trip.
///
/// Listen for `tasks:patch` / `vault:*` BEFORE invoking this: the post-boot
/// import may emit a patch as soon as it returns.
#[tauri::command]
async fn boot(app: AppHandle, state: State<'_, AppState>) -> Result<Boot, String> {
    let t0 = Instant::now();
    trace("boot invoked");
    let p = &state.paths;
    // a vault the user picked is not made again empty when its folder is gone (an unplugged drive, a renamed folder):
    // the start page says so and offers the choices (vault_missing)
    if !p.vault_is_default && matches!(p.vault.try_exists(), Ok(false)) {
        return Err(format!("vault-missing:{}", p.vault.display()));
    }
    std::fs::create_dir_all(&p.vault).map_err(|e| format!("create vault {}: {}", p.vault.display(), e))?;
    {
        let _io = lock(&state.io);
        if let Err(e) = vault::migrate_on_boot(&p.vault, &p.home, p.vault_is_default) {
            eprintln!("migration: {}", e);
        }
    }
    let first = !state.booted.swap(true, Ordering::SeqCst);
    if first {
        allow_vault_assets(&app, &p.vault);
    }
    // Watcher before the scan: anything that changes in between is either in
    // the scan (hash matches, event skipped) or after it (event emitted).
    let mut watch_failed: Option<String> = None;
    if first {
        match watch::start(app.clone()) {
            Ok(w) => *lock(&state.watcher) = Some(w),
            // said in the page too: changes from outside (agents, another app, sync) would not show, with no sign why
            Err(e) => { eprintln!("file watching unavailable: {}", e); watch_failed = Some(e.to_string()); }
        }
    }
    let tasks_warning: Option<Value>;
    let tasks_bad: usize;
    let scan = vault::scan(&p.vault, Some(&p.dir));
    let habits = read_json(&p.habits).unwrap_or(Value::Null);
    let mut settings = settings::load(&p.settings, &p.vault);
    // the Player's libraries live outside the vault: give them back their
    // asset scope before the webview asks for the first cover
    if first {
        library::allow_saved(&app, &settings);
        outpost::allow_saved(&app, &settings);
        grant::list_far_folders(&settings, &p.vault);
    }
    grant::drop_unasked_guests(&mut settings);
    {
        let mut echo = lock(&state.echo);
        echo.reset_notes(&scan.notes);
        echo.folders = scan.folders.clone();
        echo.files = scan.files.clone();
        echo.habits = (!habits.is_null()).then(|| watch::hash_str(&habits.to_string()));
    }
    let (tasks, conflict) = {
        let mut g = lock(&state.tasks);
        let f = store::fold_in(&p.dir, &p.snapshot);
        g.tasks = f.tasks.clone();
        // the task file is damaged, or the list came up empty although a
        // history copy holds tasks: the frontend says so and offers the copy back
        let lost = store::snapshot_lost(&p.dir, &p.snapshot);
        let looked = if f.snapshot_bad.is_some() || f.tasks.is_empty() || lost { store::newest_history_tasks(&p.dir) } else { Ok(None) };
        let history_unreadable = looked.is_err();
        let newest = looked.unwrap_or(None);
        let warning = match (&f.snapshot_bad, &newest) {
            (Some(why), copy) => Some(json!({ "reason": format!("The task file is {}", why), "file": copy.as_ref().map(|c| c.0.to_string_lossy().into_owned()), "count": copy.as_ref().map(|c| c.1), "stamp": copy.as_ref().map(|c| c.2.clone()), "history_unreadable": history_unreadable })),
            (None, Some((file, n, stamp))) if f.tasks.is_empty() || lost => Some(json!({ "reason": if lost { "The task file is gone" } else { "The task list came up empty" }, "file": file.to_string_lossy(), "count": n, "stamp": stamp })),
            (None, None) if history_unreadable => Some(json!({ "reason": if lost { "The task file is gone" } else { "The task list came up empty" }, "history_unreadable": true })),
            _ => None,
        };
        if let Some(w) = &warning { trace(&format!("tasks: warning {}", w)); }
        tasks_warning = warning;
        tasks_bad = f.bad.len();
        (f.tasks, f.conflicted)
    };
    if first {
        let app = app.clone();
        let history_max = settings.get("historyCopies").and_then(|v| v.as_u64()).map(|n| n as usize).unwrap_or(store::MAX_HISTORY);
        std::thread::spawn(move || {
            let st = app.state::<AppState>();
            {
                let mut g = lock(&st.tasks);
                if let Some(patch) = import_and_compact(&st.paths.dir, &st.paths.snapshot, &mut g, &now_local(), &compact_stamp()) {
                    let _ = app.emit("tasks:patch", patch);
                }
            }
            store::adopt_damaged(&st.paths.dir, &st.paths.snapshot);
            // off the save path, once a launch: keep history inside its caps
            store::prune_history(&st.paths.dir, history_max);
            notehist::sweep(&st.paths.dir);
        });
    }
    let recurring = read_json(&p.recurring).unwrap_or(Value::Null);
    let priorities = read_json(&p.priorities).filter(|v| v.is_array()).unwrap_or_else(|| json!([]));
    let stats = load_stats(p);
    let positions = read_json(&p.positions).filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
    trace(&format!(
        "boot done in {:.1} ms ({} notes, {} files)",
        t0.elapsed().as_secs_f64() * 1000.0,
        scan.notes.len(),
        scan.files.len()
    ));
    Ok(Boot {
        vault: p.vault.to_string_lossy().into_owned(),
        vault_abs: vault_abs(&p.vault),
        data_dir: p.data_mode,
        data_root: vault_abs(&p.dir),
        settings_path: vault_abs(&settings::main_file(&p.settings, &p.vault)),
        notes: scan.notes,
        folders: scan.folders,
        files: scan.files,
        positions,
        tasks,
        tasks_conflict: conflict,
        tasks_warning,
        tasks_bad,
        watch_failed,
        capture_key_taken: CAPTURE_TAKEN.load(Ordering::SeqCst),
        device: std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default(),
        habits,
        settings,
        recurring,
        priorities,
        stats,
        ms: t0.elapsed().as_secs_f64() * 1000.0,
        // only the first boot of a --hidden launch stays hidden; a reload shows
        hidden: first && START_HIDDEN.load(Ordering::SeqCst),
        // files we were launched with (a .md double-clicked in Explorer),
        // handed over once - a reload must not reopen them
        open_paths: external::take_argv_files(),
        packaged: app_packaged(),
    })
}

/// What the frontend starts from. A struct, not a json!: that would copy the whole vault's text once more.
#[derive(serde::Serialize)]
struct Boot {
    vault: String,
    vault_abs: String,
    data_dir: &'static str,
    data_root: String,
    settings_path: String,
    notes: Vec<vault::Note>,
    folders: Vec<String>,
    files: Vec<vault::FileEntry>,
    positions: Value,
    tasks: Vec<Value>,
    tasks_conflict: Option<String>,
    tasks_warning: Option<Value>,
    /// lines in the task logs that could not be read (kept in quarantine.jsonl): while there are any, the logs are not
    /// compacted, so the page says so
    tasks_bad: usize,
    /// the vault could not be watched: changes made outside Leonote do not show until it starts again
    watch_failed: Option<String>,
    /// Ctrl+Alt+N is held by another app
    capture_key_taken: bool,
    /// this computer's name: backup plans tell their zips apart by it when a synced vault is used on several
    device: String,
    habits: Value,
    settings: Value,
    recurring: Value,
    priorities: Value,
    stats: Value,
    ms: f64,
    hidden: bool,
    open_paths: Vec<String>,
    packaged: bool,
}

/// The only task mutation: sparse ops, appended to this app's own log.
#[tauri::command]
async fn task_ops(ops: Vec<Value>, state: State<'_, AppState>) -> Result<Value, String> {
    let mut g = lock(&state.tasks);
    apply_ops(&state.paths.dir, &state.paths.snapshot, &mut g, &ops, &store::not_before_newest(now_local()))
}

#[tauri::command]
async fn note_write(app: AppHandle, path: String, content: String, state: State<'_, AppState>) -> Result<u64, String> {
    guest_ok(&app, &path, &state)?;
    let (mtime, outside) = note_write_full(&path, &content, &state)?;
    // what was on the disk came from outside Leonote (an agent, a sync, another app) and was not seen here before this
    // save replaced it: the page says so - it is kept in the note's versions
    if outside { let _ = app.emit("note:overwrote", json!({ "path": path })); }
    Ok(mtime)
}

/// A note written by the app, its earlier text kept in its history - also how an accepted proposal lands.
pub fn note_write_inner(path: &str, content: &str, state: &AppState) -> Result<u64, String> {
    note_write_full(path, content, state).map(|(m, _)| m)
}
/// The same, also saying whether it replaced words on the disk the page had not been shown yet.
fn note_write_full(path: &str, content: &str, state: &AppState) -> Result<(u64, bool), String> {
    // the path is checked before anything reads it: a network path would reach another computer just by being looked at
    vault::resolve_note(&state.paths.vault, path)?;
    let (path, content) = (path.to_string(), content.to_string());
    let _io = lock(&state.io);
    // Keep the bytes that are about to go, before anything else can fail.
    // Always when most of the note would disappear or they came from outside
    // Leonote (nobody else has a copy), otherwise now and then - see notehist.rs for the caps.
    let disk = vault::read_note(&state.paths.vault, &path);
    let outside = disk.as_ref().is_some_and(|n| lock(&state.echo).from_outside(&path, &n.content));
    // what the page should hear of: words on the disk it was never shown (written just as it saved)
    let unseen = disk.as_ref().is_some_and(|n| lock(&state.echo).unseen(&path, &n.content));
    {
        let mut kept = lock(&state.note_kept);
        notehist::before_write(
            &state.paths.dir,
            &state.paths.vault,
            &path,
            &content,
            &mut kept,
            &compact_stamp(),
            outside,
        );
    }
    // Recorded before the write so the watcher can never see the new bytes
    // without the matching hash.
    lock(&state.echo).note_seen(&path, &content);
    let mtime = vault::write(&state.paths.vault, &path, &content)?;
    lock(&state.echo).note_ours(&path, &content);
    Ok((mtime, unseen))
}

/// Erase tasks for good: their blanking (sent by the app just before) folded
/// into the task file by a compaction, which trims the logs, then every old
/// copy in history/ scrubbed of their words. For a key typed into a task.
#[tauri::command]
async fn tasks_erase(ids: Vec<String>, state: State<'_, AppState>) -> Result<usize, String> {
    let ids: std::collections::HashSet<String> = ids.into_iter().filter(|i| !i.is_empty()).collect();
    if ids.is_empty() { return Ok(0); }
    let _g = lock(&state.tasks);
    if store::log_bytes_in(&state.paths.dir) > 0 {
        store::compact(&state.paths.dir, &state.paths.snapshot, &compact_stamp()).map_err(|e| format!("the task file could not be folded just now ({}) - the words go at the next start", e))?;
    }
    Ok(store::scrub_history(&state.paths.dir, &ids))
}

/// Earlier versions of a note, newest first.
#[tauri::command]
async fn note_versions(path: String, state: State<'_, AppState>) -> Result<Vec<notehist::Version>, String> {
    vault::resolve_note(&state.paths.vault, &path)?;
    Ok(notehist::list(&state.paths.dir, &path))
}

/// Erase every trace of a note: its kept versions, its copies in the trash and
/// proposed edits holding its text. `dry` only counts. For a secret pasted into a
/// note; the app deletes the note itself first when that is asked too.
#[tauri::command]
async fn note_history_erase(path: String, dry: bool, state: State<'_, AppState>) -> Result<notehist::Erased, String> {
    let rel = proposals::safe_rel(&state.paths.vault, &path)?;
    let _io = lock(&state.io);
    notehist::erase(&state.paths.dir, &state.paths.vault, &rel, dry)
}

/// The text of one earlier version.
#[tauri::command]
async fn note_version_read(path: String, stamp: String, state: State<'_, AppState>) -> Result<String, String> {
    vault::resolve_note(&state.paths.vault, &path)?;
    notehist::read(&state.paths.dir, &path, &stamp)
}

/// Keep the note as it stands right now, whatever the throttle says. Restoring
/// an old version calls this first, so the restore itself can be undone.
#[tauri::command]
async fn note_version_keep(path: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let _io = lock(&state.io);
    let mut kept = lock(&state.note_kept);
    Ok(notehist::before_write(
        &state.paths.dir,
        &state.paths.vault,
        &path,
        "",
        &mut kept,
        &compact_stamp(),
        true,
    ))
}

#[tauri::command]
async fn note_create(path: String, content: String, state: State<'_, AppState>) -> Result<String, String> {
    let _io = lock(&state.io);
    let used = vault::create(&state.paths.vault, &path, &content)?;
    let mut echo = lock(&state.echo);
    echo.note_seen(&used, &content);
    echo.note_ours(&used, &content);
    drop(echo);
    Ok(used)
}

#[tauri::command]
async fn note_rename(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let _io = lock(&state.io);
    vault::rename(&state.paths.vault, &from, &to, true)?;
    notehist::moved(&state.paths.dir, &from, &to);
    lock(&state.echo).move_note(&from, &to);
    Ok(())
}

#[tauri::command]
async fn note_trash(path: String, mode: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let _io = lock(&state.io);
    trashbin::dispose(&state.paths.vault, &path, vault::Entry::Note, mode.as_deref(), &trash_stamp())?;
    lock(&state.echo).note_gone(&path);
    Ok(())
}

/// A file dropped in from Explorer: raw bytes, the path in `x-path`. Always a
/// new file (a taken name gets " 2", " 3"...); returns the path it got. The
/// watcher reports it like any file that appears.
#[tauri::command]
async fn file_import(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<String, String> {
    let raw = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("missing x-path header")?;
    let rel = percent_decode(raw)?;
    // it would land beside the outside file, in a folder nobody handed over
    if vault::is_guest(&rel) { return Err("that file is outside the vault - Leonote does not add files there".into()); }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if bytes.len() > 1024 * 1024 * 1024 {
        return Err("file is larger than 1 GB".into());
    }
    let wanted = vault::resolve(&state.paths.vault, &rel)?;
    let dir = wanted.parent().ok_or("no folder")?.to_path_buf();
    let name = wanted.file_name().and_then(|n| n.to_str()).ok_or("no name")?.to_string();
    let _paste = lock(&clip::PASTE);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let to = clip::free_name(&dir, &name);
    std::fs::write(&to, bytes).map_err(|e| format!("write {}: {}", name, e))?;
    let got = to.file_name().and_then(|n| n.to_str()).unwrap_or(&name).to_string();
    Ok(match rel.rfind('/') { Some(i) => format!("{}/{}", &rel[..i], got), None => got })
}

/// Paste files copied in Explorer into a vault folder ("" = the root).
/// Nothing is overwritten: taken names get " 2", " 3"...
#[tauri::command]
async fn paste_files(dir: String, state: State<'_, AppState>) -> Result<Value, String> {
    let sources = clip::clipboard_files();
    if sources.is_empty() {
        return Ok(json!({ "pasted": [], "count": 0 }));
    }
    let target = if dir.is_empty() { state.paths.vault.clone() } else { vault::resolve(&state.paths.vault, &dir)? };
    let vault = state.paths.vault.clone();
    // off the worker and outside state.io: a big folder must not hold up every save behind it
    let (made, count) = tauri::async_runtime::spawn_blocking(move || clip::paste_into(&vault, &target, &sources)).await.map_err(|e| e.to_string())??;
    let _io = lock(&state.io);
    lock(&state.echo).folders = vault::folders(&state.paths.vault, Some(&state.paths.dir));
    let files = files_now(&state.paths, &state.echo);
    Ok(json!({ "pasted": made, "count": count, "files": files }))
}

/// Notes, files or folders of the vault copied into a folder of it (a copy
/// beside the original is a duplicate) - never over anything: `name 2` instead.
#[tauri::command]
async fn vault_copy(paths: Vec<String>, dir: String, state: State<'_, AppState>) -> Result<Value, String> {
    let target = if dir.is_empty() { state.paths.vault.clone() } else { vault::resolve(&state.paths.vault, &dir)? };
    let sources = paths.iter().map(|p| vault::resolve(&state.paths.vault, p)).collect::<Result<Vec<_>, _>>()?;
    let vault = state.paths.vault.clone();
    // off the worker and outside state.io: a big folder must not hold up every save behind it. One at a time, so
    // each copy is known to come from its source (its AI access goes with it below)
    let pairs = paths.clone();
    let (made, count, copied, failed) = tauri::async_runtime::spawn_blocking(move || {
        let (mut made, mut count, mut copied, mut failed) = (Vec::new(), 0u64, Vec::new(), None);
        for (from, src) in pairs.into_iter().zip(sources) {
            let is_dir = src.is_dir();
            match clip::paste_into(&vault, &target, &[src]) {
                Ok((m, n)) => {
                    count += n;
                    if let Some(to) = m.first().filter(|_| is_dir) { copied.push((from, to.clone())); }
                    made.extend(m);
                }
                Err(e) => { failed = Some(e); break; }
            }
        }
        (made, count, copied, failed)
    }).await.map_err(|e| e.to_string())?;
    // a copied folder keeps the AI access of its source (private stays private: it is the same text) - also the
    // copies made before one of several failed
    for (from, to) in &copied { proposals::copy_folder(&state.paths.dir, from, to)?; }
    if let Some(e) = failed { return Err(e); }
    let _io = lock(&state.io);
    lock(&state.echo).folders = vault::folders(&state.paths.vault, Some(&state.paths.dir));
    let files = files_now(&state.paths, &state.echo);
    Ok(json!({ "made": made, "count": count, "files": files }))
}

#[tauri::command]
async fn folder_create(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let _io = lock(&state.io);
    vault::mkdir(&state.paths.vault, &path)?;
    lock(&state.echo).folders = vault::folders(&state.paths.vault, Some(&state.paths.dir));
    Ok(())
}

#[tauri::command]
async fn folder_rename(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let _io = lock(&state.io);
    vault::rename(&state.paths.vault, &from, &to, false)?;
    // its AI access goes with it - or it does not move at all: a private folder must not open by its new name
    if let Err(e) = proposals::move_folder(&state.paths.dir, &from, &to) {
        let _ = vault::rename(&state.paths.vault, &to, &from, false);
        return Err(e);
    }
    notehist::moved_folder(&state.paths.dir, &from, &to);
    let mut echo = lock(&state.echo);
    echo.move_prefix(&from, &to);
    echo.folders = vault::folders(&state.paths.vault, Some(&state.paths.dir));
    Ok(())
}

#[tauri::command]
async fn folder_trash(path: String, mode: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let _io = lock(&state.io);
    trashbin::dispose(&state.paths.vault, &path, vault::Entry::Folder, mode.as_deref(), &trash_stamp())?;
    let mut echo = lock(&state.echo);
    echo.prefix_gone(&path);
    echo.folders = vault::folders(&state.paths.vault, Some(&state.paths.dir));
    Ok(())
}

fn trash_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H%M%S").to_string()
}

/// Pretty, 2-space - the same shape the Python app writes, so its diffs stay small.
#[tauri::command]
async fn habits_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if backup::RESTORED.load(Ordering::SeqCst) { return Ok(()); } // a restore is in place; the restart reads it
    // the Python app reads this file too: never replaced by null, a list or a broken habits field
    if !data.is_object() || data.get("habits").is_some_and(|h| !h.is_array()) { return Err("habits data must be an object with a habits list".into()); }
    let body = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let _io = lock(&state.io);
    lock(&state.echo).habits = Some(watch::hash_str(&data.to_string()));
    vault::write_atomic(&state.paths.habits, body.as_bytes()).map_err(|e| format!("write habits: {}", e))
}

/// The embedded YouTube player's page, and the Referer it is sent with (see browser_keys_to_page).
#[cfg(windows)]
const YT_EMBED: &str = "https://www.youtube-nocookie.com/embed/";
/// The Store build: the hyphenated app name and the Store app id, as YouTube's Referer format asks.
// TODO(store): put the Store app id in once the name is reserved in Partner Center
#[cfg(all(windows, feature = "store"))]
const STORE_APP_REFERER: &str = "https://leonote.STORE-APP-ID";
#[cfg(all(windows, feature = "store"))]
const YT_REFERER: &str = STORE_APP_REFERER;
/// Other builds: the bundle identifier (tauri.conf.json); keep it the same across versions.
#[cfg(all(windows, not(feature = "store")))]
const YT_REFERER: &str = "https://com.oleks.leonote-rs";

/// F5, Ctrl+R and the like are WebView2's own browser shortcuts; turning
/// them off keeps a stray reload from wiping unsaved state (zoom and
/// devtools are separate settings and unaffected).
///
/// Ctrl+PageUp/PageDown (tabs) and Alt+PageUp/PageDown (spaces) are
/// different: WebView2 keeps them for itself even then, and the page never
/// sees the keydown. So they are caught here, before WebView2 acts, and sent
/// to the frontend as commands.
#[cfg(windows)]
fn browser_keys_to_page(app: &tauri::App) {
    use tauri::{Emitter, Manager};
    use webview2_com::{AcceleratorKeyPressedEventHandler, PermissionRequestedEventHandler};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_NEXT, VK_PRIOR, VK_SHIFT};
    use windows_core::Interface;
    let Some(w) = app.get_webview_window("main") else { return };
    let handle = app.handle().clone();
    let _ = w.with_webview(move |wv| unsafe {
        let controller = wv.controller();
        let s3 = controller
            .CoreWebView2()
            .and_then(|c| c.Settings())
            .and_then(|s| s.cast::<ICoreWebView2Settings3>());
        match s3 {
            Ok(s) => {
                let _ = s.SetAreBrowserAcceleratorKeysEnabled(false);
                trace("browser keys handed to the page");
            }
            Err(e) => trace(&format!("browser keys stay with WebView2: {}", e)),
        }

        // The microphone, for the app's own page only (the tabs' browser
        // keeps WebView2's prompt): a mic button here is the user's own
        // click, and a "no" once given to WebView2's prompt would otherwise
        // be remembered with no way back. Windows' own privacy switch for
        // desktop apps still has the last word.
        if let Ok(core) = controller.CoreWebView2() {
            let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                // asked by the app's own page only: a frame of another origin (an embed some day allowed the mic)
                // gets WebView2's own handling, not a silent yes
                let mut u = windows::core::PWSTR::null();
                args.Uri(&mut u)?;
                let uri = webview2_com::take_pwstr(u);
                let own = OWN_ORIGINS.iter().any(|o| uri == *o || uri.starts_with(&format!("{o}/")));
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && own {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_PermissionRequested(&handler, &mut token);

            // A YouTube page asked for from inside the app's own page - the embedded player's "Watch on
            // YouTube" - opens in the Player's browser, not in a window of its own
            let yt = handle.clone();
            let popup = webview2_com::NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = windows::core::PWSTR::null();
                args.Uri(&mut uri)?;
                let u = webview2_com::take_pwstr(uri);
                let host = u.split("://").nth(1).unwrap_or("").split(['/', '?']).next().unwrap_or("").to_ascii_lowercase();
                if host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com") {
                    args.SetHandled(true)?;
                    let _ = yt.emit("app:open-youtube", u);
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_NewWindowRequested(&popup, &mut token);

            // A right-click on the Player's YouTube frame: the Player's own menu, not the browser's
            // (Back, Refresh, Save as) - the app's page cannot hear a click inside another site's frame
            let ytm = handle.clone();
            if let Ok(c11) = core.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11>() {
                let menu = webview2_com::ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let target = args.ContextMenuTarget()?;
                    let mut f = windows::core::PWSTR::null();
                    target.FrameUri(&mut f)?;
                    if !webview2_com::take_pwstr(f).contains("youtube") { return Ok(()); }
                    let mut at = windows::Win32::Foundation::POINT::default();
                    args.Location(&mut at)?;
                    args.SetHandled(true)?;
                    let _ = ytm.emit_to("main", "player:menu", serde_json::json!({ "x": at.x, "y": at.y }));
                    Ok(())
                }));
                let mut token = 0i64;
                let _ = c11.add_ContextMenuRequested(&menu, &mut token);
            }

            // A Dataview block's frame (dataview.js names it "leonote-dataview") runs code a note carries, sandboxed, and so
            // does a plugin's (plugins.js, "leonote-plugin");
            // a sandboxed frame may still navigate itself, and the address could carry out what it read - so it stays put
            use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Frame2, ICoreWebView2_4};
            if let Ok(c4) = core.cast::<ICoreWebView2_4>() {
                let made = webview2_com::FrameCreatedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let frame = args.Frame()?;
                    let mut n = windows::core::PWSTR::null();
                    frame.Name(&mut n)?;
                    if !matches!(webview2_com::take_pwstr(n).as_str(), "leonote-dataview" | "leonote-plugin") { return Ok(()); }
                    let Ok(f2) = frame.cast::<ICoreWebView2Frame2>() else { return Ok(()) };
                    let stay = webview2_com::FrameNavigationStartingEventHandler::create(Box::new(|_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut u = windows::core::PWSTR::null();
                        args.Uri(&mut u)?;
                        if !webview2_com::take_pwstr(u).starts_with("about:") { args.SetCancel(true)?; }
                        Ok(())
                    }));
                    let mut token = 0i64;
                    let _ = f2.add_NavigationStarting(&stay, &mut token);
                    Ok(())
                }));
                let mut token = 0i64;
                let _ = c4.add_FrameCreated(&made, &mut token);
            }

            // The main window shows Leonote's own pages and nothing else: HTML slipped into it (a <meta> refresh, a
            // link with a target) cannot carry the window, and the commands it reaches, off to another address.
            // Web pages open in tabs and windows of their own; links go out through open_url.
            let stay = webview2_com::NavigationStartingEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut u = windows::core::PWSTR::null();
                args.Uri(&mut u)?;
                let uri = webview2_com::take_pwstr(u);
                // (a blob: of its own, as a save made by a link click starts, is its own too)
                let own = OWN_ORIGINS.iter().any(|o| uri == *o || uri.starts_with(&format!("{o}/")) || uri.starts_with(&format!("{o}?")) || uri.starts_with(&format!("blob:{o}/")));
                if !own && !uri.starts_with("about:") { args.SetCancel(true)?; }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_NavigationStarting(&stay, &mut token);

            // YouTube's Required Minimum Functionality: an app's embedded player says which app it is in, by a
            // Referer naming the app's id (WebView2's SetHeader, as YouTube's docs name it). Player and note players.
            use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT};
            let filter = windows_core::HSTRING::from(format!("{YT_EMBED}*"));
            let _ = match core.cast::<ICoreWebView2_22>() {
                Ok(c) => c.AddWebResourceRequestedFilterWithRequestSourceKinds(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT),
                Err(_) => core.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT),
            };
            let referer = webview2_com::WebResourceRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let req = args.Request()?;
                let mut u = windows::core::PWSTR::null();
                req.Uri(&mut u)?;
                // wry's own handler hears every filter too; this one touches only the player's page
                if !webview2_com::take_pwstr(u).starts_with(YT_EMBED) { return Ok(()); }
                req.Headers()?.SetHeader(&windows_core::HSTRING::from("Referer"), &windows_core::HSTRING::from(YT_REFERER))?;
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_WebResourceRequested(&referer, &mut token);
        }

        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            // Alt combinations arrive as "system" keys
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                return Ok(());
            }
            let mut vk = 0u32;
            args.VirtualKey(&mut vk)?;
            if vk != VK_PRIOR.0 as u32 && vk != VK_NEXT.0 as u32 {
                return Ok(());
            }
            // The keys go to WebView2's own process, so this thread's key
            // state never sees Ctrl or Alt go down: ask the system instead.
            let held = |k: VIRTUAL_KEY| (GetAsyncKeyState(k.0 as i32) as u16 & 0x8000) != 0;
            let next = vk == VK_NEXT.0 as u32;
            let cmd = match (held(VK_CONTROL), held(VK_MENU), held(VK_SHIFT)) {
                (true, false, false) => if next { "next-tab" } else { "prev-tab" },
                (false, true, false) => if next { "next-space" } else { "prev-space" },
                _ => return Ok(()),
            };
            args.SetHandled(true)?;
            let _ = handle.emit("app:command", cmd);
            Ok(())
        }));
        let mut token = 0i64;
        match controller.add_AcceleratorKeyPressed(&handler, &mut token) {
            Ok(()) => trace("Ctrl/Alt+PageUp/PageDown routed to the tab and space commands"),
            Err(e) => trace(&format!("tab keys stay with WebView2: {}", e)),
        }
    });
}

/// The history copies that hold tasks, newest first, for the recovery window.
#[tauri::command]
async fn tasks_history_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    Ok(store::history_tasks_all(&state.paths.dir)?.into_iter().map(|(f, n, stamp, bytes)| json!({ "file": f.to_string_lossy(), "count": n, "stamp": stamp, "bytes": bytes })).collect())
}

/// The frontend is still writing notes out: the 2.5 s fallback exit waits
/// (up to a minute) instead of pulling the plug under a save.
#[tauri::command]
async fn app_quit_hold(app: AppHandle, wait: Option<bool>) {
    QUIT_HOLD.store(true, Ordering::SeqCst);
    // a save that failed: the window offers the text and waits for the user, with no minute limit
    if wait == Some(true) { QUIT_WAIT.store(true, Ordering::SeqCst); }
    show_main(&app); // quit from the tray: the "Still saving" dialog must be seen
}

/// Inside the history folder for real: starts_with compares parts and does not resolve "..".
fn from_history(f: &Path, hist: &Path) -> bool {
    f.starts_with(hist) && !f.components().any(|c| matches!(c, std::path::Component::ParentDir))
}
#[cfg(test)]
#[test]
fn a_restore_cannot_climb_out_of_the_history() {
    let h = Path::new("C:/data/history");
    assert!(from_history(&h.join("2026-11-12.json"), h));
    assert!(!from_history(&h.join("..").join("..").join("x.json"), h));
    assert!(!from_history(Path::new("C:/elsewhere/x.json"), h));
}

/// A history copy of the tasks appended to a restore log, for the fold to
/// take in - the snapshot itself is never written here, a damaged one only moved aside.
#[tauri::command]
async fn tasks_restore(file: String, state: State<'_, AppState>) -> Result<usize, String> {
    let f = PathBuf::from(&file);
    let hist = state.paths.dir.join("history");
    if !from_history(&f, &hist) { return Err("only a copy from the history can be restored".into()); }
    let _io = lock(&state.io);
    // held over the append and the move of a damaged file: the watcher's fold comes after both, and tells the list
    let _tasks = lock(&state.tasks);
    store::restore_from(&state.paths.dir, &state.paths.snapshot, &f, &now_local())
}

/// Our own settings file. NEVER ~/.leonote_config.json: that one is the
/// Python app's non-atomic dump holding XP and months of pomodoro history.
#[tauri::command]
async fn settings_save(app: AppHandle, mut data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if backup::RESTORED.load(Ordering::SeqCst) { return Ok(()); } // a restore is in place; the restart reads it
    // a new vault, outpost or library is written into after a restart: one picked in a dialog passes, any other is
    // asked about, and a no leaves it out (the rest of the settings are still saved)
    // a no is asked once per run: the page still holds the folder and saves it with every change
    static REFUSED: Mutex<Vec<String>> = Mutex::new(Vec::new());
    settings::keep_allowed_folders(&state.paths.settings, &mut data, |list, p| {
        // a search root is only ever looked at, never written: a drive passes, a network folder gets the
        // looking-only question - never a grant to change everything on it
        if list == "pcSearchRoots" {
            if !grant::is_far(Path::new(p)) { return true; }
            // a no is asked once per run here too: the page keeps the folder and saves it with every change
            if lock(&REFUSED).iter().any(|r| r == p) { return false; }
            let yes = grant::allow_far_look(&app, Path::new(p), "search the file names in this folder on another computer (looking only)").is_ok();
            if !yes { lock(&REFUSED).push(p.to_string()); }
            return yes;
        }
        // picked in a folder dialog after an earlier no: the pick counts, not the no
        if grant::granted(Path::new(p)) { return true; }
        if lock(&REFUSED).iter().any(|r| r == p) { return false; }
        let yes = grant::allow(&app, Path::new(p), "let Leonote read and change the files in this folder", true).is_ok();
        if !yes { lock(&REFUSED).push(p.to_string()); }
        yes
    });
    let _io = lock(&state.io);
    settings::save(&state.paths.settings, &state.paths.vault, &data)
}

/// Move our own data between the three layouts (see datadir.rs) and record
/// the new one. Returns the new data root as an absolute path.
///
/// The move happens first and app.json is written last, so a crash in the
/// middle leaves the app pointing at the old root - which is where any file
/// that has not travelled yet still is. The other way round would point it at
/// a half-filled folder and look like data loss.
///
/// The caller must restart the app afterwards: every path is resolved once at
/// startup, and the watcher holds directory handles for the old root.
#[tauri::command]
async fn data_dir_set(mode: String, state: State<'_, AppState>) -> Result<String, String> {
    let want = datadir::parse_mode(mode.trim())
        .ok_or_else(|| format!("unknown data location: {}", mode))?;
    let p = &state.paths;
    datadir::check_target(want, &p.vault)?;
    let user_dir = store::leonote_dir();
    let snap = tasks_path();
    let new_root = datadir::data_root(want, &user_dir, &p.vault);
    if want == p.data_mode {
        return Ok(vault_abs(&new_root));
    }
    let old = datadir::items(p.data_mode, &p.home, &user_dir, &snap, &p.vault);
    let new = datadir::items(want, &p.home, &user_dir, &snap, &p.vault);
    // Both locks: no append may land in the old log while it is in flight.
    let _io = lock(&state.io);
    let _tasks = lock(&state.tasks);
    datadir::migrate(&old, &new)?;
    let mut cfg = read_json(&p.settings).filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
    cfg["dataDir"] = json!(want);
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    vault::write_atomic(&p.settings, body.as_bytes()).map_err(|e| format!("write settings: {}", e))?;
    Ok(vault_abs(&new_root))
}

/// XP, counters and focus history. The first time, carried over from the
/// Python app's config so nobody loses their level or months of pomodoro
/// history - read only: that file belongs to the Python app and is written
/// non-atomically, so we never write it.
fn load_stats(p: &Paths) -> Value {
    if let Some(v) = read_json(&p.stats).filter(|v| v.is_object()) {
        return v;
    }
    let mut out = serde_json::Map::new();
    if let Some(Value::Object(cfg)) = read_json(&p.legacy_config) {
        for k in [
            "xp", "tasks_created", "tasks_done", "pomo_total_work_secs", "pomo_total_break_secs",
            "pomo_daily", "pomo_work_mins", "pomo_break_mins", "pomo_tick_volume",
            "pomo_alert_enabled", "pomo_alert_volume", "pomo_no_tick_break",
        ] {
            if let Some(v) = cfg.get(k) {
                out.insert(k.to_string(), v.clone());
            }
        }
        out.insert("seeded_from".into(), json!("legacy config"));
    }
    Value::Object(out)
}

#[tauri::command]
async fn recurring_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.is_object() {
        return Err("recurring data must be an object".into());
    }
    // indent=2 and raw UTF-8, like the Python writer, so diffs stay small
    let body = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let _io = lock(&state.io);
    vault::write_atomic(&state.paths.recurring, body.as_bytes()).map_err(|e| format!("write recurring: {}", e))
}

#[tauri::command]
async fn priorities_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.as_array().map(|a| a.iter().all(|v| v.is_object())).unwrap_or(false) {
        return Err("focus areas must be an array of objects".into());
    }
    let body = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let _io = lock(&state.io);
    vault::write_atomic(&state.paths.priorities, body.as_bytes()).map_err(|e| format!("write priorities: {}", e))
}

#[tauri::command]
async fn stats_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.is_object() {
        return Err("stats must be an object".into());
    }
    let body = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let _io = lock(&state.io);
    vault::write_atomic(&state.paths.stats, body.as_bytes()).map_err(|e| format!("write stats: {}", e))
}

/// Show a vault item in Explorer. "" reveals the vault folder itself.
#[tauri::command]
async fn reveal(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let abs = if path.is_empty() {
        state.paths.vault.clone()
    } else {
        vault::resolve(&state.paths.vault, &path)?
    };
    tauri_plugin_opener::reveal_item_in_dir(abs).map_err(|e| e.to_string())
}

/// Our settings file (app.json) is outside the vault, so `reveal` can't reach it.
#[tauri::command]
async fn reveal_settings(state: State<'_, AppState>) -> Result<(), String> {
    let p = &settings::main_file(&state.paths.settings, &state.paths.vault);
    if !p.exists() {
        return tauri_plugin_opener::reveal_item_in_dir(p.parent().unwrap_or(p)).map_err(|e| e.to_string());
    }
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

/// http(s) only: a note can contain any link text, and `file:` or a custom
/// protocol handler from the webview is a code-execution path.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    let l = url.trim().to_ascii_lowercase();
    // ms-settings: pages are Windows' own settings (the microphone's privacy switch, the sound devices)
    if !(l.starts_with("http://") || l.starts_with("https://") || l.starts_with("ms-settings:")) {
        return Err("only http(s) links can be opened".into());
    }
    tauri_plugin_opener::open_url(url.trim(), None::<&str>).map_err(|e| e.to_string())
}

// ── non-note vault files ────────────────────────────────────────────────────

/// The vault as an absolute OS path (backslashes and a drive letter on
/// Windows, no `\\?\` prefix), for the frontend's `convertFileSrc`. Not
/// canonicalized: the asset protocol canonicalizes every request itself.
fn vault_abs(vault: &Path) -> String {
    std::path::absolute(vault).unwrap_or_else(|_| vault.to_path_buf()).to_string_lossy().into_owned()
}

/// Let the webview load vault files (images, PDFs, media) over the asset
/// protocol: the vault, recursively, and nothing outside it. Dot-folders
/// (.obsidian, .trash, .git) stay out because tauri.conf.json sets
/// `requireLiteralLeadingDot`, so the `**` never matches a dot segment.
/// Allowed in canonical form: the protocol canonicalizes each request before
/// matching, and the glob match is case-sensitive, so `g:\vault` from
/// app.json would never match the on-disk `G:\Vault`.
fn allow_vault_assets(app: &AppHandle, vault: &Path) {
    let canon = std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
    if let Err(e) = app.asset_protocol_scope().allow_directory(&canon, true) {
        eprintln!("asset protocol scope for {}: {}", canon.display(), e);
    }
}

/// The main window moved and sized in one step (compact mode and back): where it was, maximized or not,
/// read and changed here in one go instead of five round trips from the page - so no in-between frame shows
/// the old size with the new layout. Gives back where it was.
#[tauri::command]
fn win_place(window: tauri::WebviewWindow, w: f64, h: f64, x: Option<f64>, y: Option<f64>, max: Option<bool>) -> Result<Value, String> {
    let e = |e: tauri::Error| e.to_string();
    let scale = window.scale_factor().map_err(e)?;
    let pos = window.outer_position().map_err(e)?.to_logical::<f64>(scale);
    let size = window.inner_size().map_err(e)?.to_logical::<f64>(scale);
    let was_max = window.is_maximized().unwrap_or(false);
    if was_max { window.unmaximize().map_err(e)?; }
    window.set_size(tauri::LogicalSize::new(w, h)).map_err(e)?;
    if let (Some(x), Some(y)) = (x, y) { window.set_position(tauri::LogicalPosition::new(x, y)).map_err(e)?; }
    if max == Some(true) { window.maximize().map_err(e)?; }
    Ok(json!({ "x": pos.x.round(), "y": pos.y.round(), "w": size.width.round(), "h": size.height.round(), "max": was_max }))
}

/// Leonote's own pages (the window, the mini player, quick capture) - never a browser tab's website.
fn own_page(label: &str) -> bool {
    matches!(label, "main" | "mini" | "miniplayer" | "quick" | "capture" | "viewer" | "script") || label.starts_with("viewer-")
}
/// Leonote's own page's origin.
const OWN_ORIGINS: &[&str] = &["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];
/// A request from Leonote's own page - its window, and inside it its own document, not a frame from elsewhere
/// (a YouTube player, a Dataview block): an Origin or Referer it gives must be the app's own.
fn own_request(label: &str, req: &tauri::http::Request<Vec<u8>>) -> bool {
    let own = |v: &str| OWN_ORIGINS.iter().any(|o| v == *o || v.starts_with(&format!("{o}/")));
    let header = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    // fail closed: at least one of the two must be there (the app's pictures and videos send a Referer), and
    // every one there must be the app's own
    let (o, r) = (header("origin"), header("referer"));
    own_page(label) && (o.is_some() || r.is_some()) && o.map(|o| own(&o)).unwrap_or(true) && r.map(|r| own(&r)).unwrap_or(true)
}

/// An answer for the `heic://` and `phone://` schemes. Never kept in the webview's cache on the disk:
/// what is on a phone stays on the phone until it is copied on purpose.
fn scheme_answer((status, ty, body): (u16, &'static str, Vec<u8>)) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder().status(status).header("Content-Type", ty).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store").header("Access-Control-Allow-Origin", "http://tauri.localhost").body(body).unwrap()
}

/// Fresh file listing, adopted as what the frontend knows (the caller
/// returns it), so the watcher does not echo the same list back.
fn files_now(p: &Paths, echo: &Mutex<watch::Echo>) -> Vec<vault::FileEntry> {
    let files = vault::tree(&p.vault, Some(&p.dir)).files;
    lock(echo).files = files.clone();
    files
}

/// Read-only preview of a non-note text file (`kind: "text"`), max 2 MB.
#[tauri::command]
async fn file_read_text(path: String, state: State<'_, AppState>) -> Result<String, String> {
    vault::read_file_text(&state.paths.vault, &path)
}

/// Open a vault file with the OS default app. Types Windows would execute
/// (.exe, .bat, .js, .lnk, ...) are refused; `reveal` still shows them.
#[tauri::command]
async fn open_path(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let abs = vault::resolve(&state.paths.vault, &path)?;
    if vault::is_launchable(&path) {
        return Err(format!("{} is a program or shortcut - use Show in Explorer to open it from there", path));
    }
    tauri_plugin_opener::open_path(abs, None::<&str>).map_err(|e| e.to_string())
}

/// Move a non-note file to `<vault>/.trash`. Returns the new file list.
#[tauri::command]
async fn file_trash(path: String, mode: Option<String>, state: State<'_, AppState>) -> Result<Vec<vault::FileEntry>, String> {
    if vault::is_guest(&path) { return Err("that file is outside the vault - Leonote does not delete it".into()); }
    let _io = lock(&state.io);
    trashbin::dispose(&state.paths.vault, &path, vault::Entry::File, mode.as_deref(), &trash_stamp())?;
    Ok(files_now(&state.paths, &state.echo))
}

/// Rename or move a non-note file; never overwrites, never into a note name.
/// Returns the new file list.
#[tauri::command]
async fn file_rename(from: String, to: String, state: State<'_, AppState>) -> Result<Vec<vault::FileEntry>, String> {
    if vault::is_guest(&from) || vault::is_guest(&to) { return Err("that file is outside the vault - Leonote does not move it".into()); }
    let _io = lock(&state.io);
    vault::rename_file(&state.paths.vault, &from, &to)?;
    Ok(files_now(&state.paths, &state.echo))
}

/// `%XX` escapes back to bytes: the path travels in a header, and headers
/// are ASCII only.
fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|_| "bad escape")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad escape")?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "path is not UTF-8".to_string())
}

/// A pasted or dropped image, already compressed by the webview. The bytes
/// come as the raw request body (a JSON number array would be ~4x larger and
/// slow), the vault-relative path in the `x-path` header. Images only, 50 MB
/// at most, and never over an existing file. Returns the new file list.
#[tauri::command]
async fn image_save(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<Vec<vault::FileEntry>, String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let rel = percent_decode(raw)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    // new pictures, and videos Leonote re-encoded (always a fresh .webm)
    let limit: usize = match vault::file_kind(&rel) {
        "image" => 50 * 1024 * 1024,
        "media" if rel.to_lowercase().ends_with(".webm") => 2 * 1024 * 1024 * 1024,
        _ => return Err(format!("not an image or .webm name: {}", rel)),
    };
    if bytes.is_empty() || bytes.len() > limit {
        return Err(format!("file is empty or larger than {} MB", limit / (1024 * 1024)));
    }
    let abs = vault::resolve_file(&state.paths.vault, &rel)?;
    let _io = lock(&state.io);
    if abs.exists() {
        return Err(format!("already exists: {}", rel));
    }
    vault::write_atomic(&abs, bytes).map_err(|e| format!("write {}: {}", rel, e))?;
    Ok(files_now(&state.paths, &state.echo))
}

/// Save a non-note file edited in Leonote: code and text, a transformed
/// picture, a .docx or .xlsx. Raw bytes in the body, the path in `x-path`.
/// The first overwrite of each file per session copies the old version to
/// .trash first. Returns the file's fresh entry (size, mtime).
#[tauri::command]
/// An outside file open in Leonote ("@guest/...") is written only if the user handed it over; else asked about.
fn guest_ok(app: &AppHandle, rel: &str, state: &AppState) -> Result<(), String> {
    if !vault::is_guest(rel) { return Ok(()); }
    let abs = vault::resolve(&state.paths.vault, rel)?;
    grant::allow(app, &abs, "save changes to", false)?;
    external::mark_parked_edited(&abs);
    Ok(())
}

#[tauri::command]
async fn file_write(app: AppHandle, request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> Result<vault::FileEntry, String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let rel = percent_decode(raw)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if !vault::is_writable(&rel) {
        return Err(format!("Leonote does not edit this kind of file: {}", rel));
    }
    guest_ok(&app, &rel, &state)?;
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("file is larger than 100 MB".into());
    }
    let abs = vault::resolve_file(&state.paths.vault, &rel)?;
    let _io = lock(&state.io);
    if abs.is_file() && lock(&state.backed_up).insert(rel.to_lowercase()) {
        if let Err(e) = vault::backup_file(&state.paths.vault, &rel, &trash_stamp()) {
            // no backup, no overwrite: forget it so the next save tries again
            lock(&state.backed_up).remove(&rel.to_lowercase());
            return Err(e);
        }
    }
    vault::write_atomic(&abs, bytes).map_err(|e| format!("write {}: {}", rel, e))?;
    vault::file_entry(&state.paths.vault, &rel)
}

/// Cursor/scroll per note. Compact rather than pretty: nobody diffs this and
/// the frontend saves it often.
#[tauri::command]
async fn positions_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.is_object() {
        return Err("positions must be an object".into());
    }
    let body = data.to_string();
    let _io = lock(&state.io);
    vault::write_atomic(&state.paths.positions, body.as_bytes()).map_err(|e| format!("write positions: {}", e))
}

/// Graph view layout: positions, pins and comment frames. Loaded lazily by the
/// graph view rather than at boot, since most sessions never open it.
/// A note given its id by the app: written like any other, but its modified
/// time is put back, so an id line does not make the note look edited.
#[tauri::command]
async fn note_stamp(app: AppHandle, path: String, content: String, state: State<'_, AppState>) -> Result<u64, String> {
    guest_ok(&app, &path, &state)?;
    let p = vault::resolve_note(&state.paths.vault, &path)?;
    // not UTF-8: its letters are not in `content`, and an id is not worth them. Left as it is, without an error to
    // show at every start
    if std::fs::read(&p).is_ok_and(|b| std::str::from_utf8(&b).is_err()) {
        return std::fs::metadata(&p).map(|m| vault::mtime_ms(&m)).map_err(|e| e.to_string());
    }
    let was = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
    note_write_inner(&path, &content, &state)?;
    if let Some(t) = was {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&p) {
            let _ = f.set_modified(t);
        }
    }
    std::fs::metadata(&p).map(|m| vault::mtime_ms(&m)).map_err(|e| e.to_string())
}

/// The vault's note ids and where each note was last seen (`.leonote/ids.json`
/// in the vault, so it travels with it): how a note renamed outside the app is
/// found again.
#[tauri::command]
async fn ids_load(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(read_json(&state.paths.vault.join(".leonote").join("ids.json")).filter(|v| v.is_object()).unwrap_or_else(|| json!({})))
}

#[tauri::command]
async fn ids_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.is_object() {
        return Err("ids must be an object".into());
    }
    let _io = lock(&state.io);
    vault::write_atomic(&state.paths.vault.join(".leonote").join("ids.json"), data.to_string().as_bytes()).map_err(|e| format!("write ids: {}", e))
}

/// The pictures' shapes (`.leonote/picture-sizes.json`, vault path -> [width, height]): a note lays its
/// pictures out at their size before they load, on any computer the vault is on.
#[tauri::command]
async fn pics_load(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(read_json(&state.paths.vault.join(".leonote").join("picture-sizes.json")).filter(|v| v.is_object()).unwrap_or_else(|| json!({})))
}

#[tauri::command]
async fn pics_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.is_object() {
        return Err("picture sizes must be an object".into());
    }
    vault::write_atomic(&state.paths.vault.join(".leonote").join("picture-sizes.json"), data.to_string().as_bytes()).map_err(|e| format!("write picture sizes: {}", e))
}

#[tauri::command]
async fn graph_load(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(read_json(&state.paths.graph).filter(|v| v.is_object()).unwrap_or_else(|| json!({})))
}

#[tauri::command]
async fn graph_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.is_object() {
        return Err("graph must be an object".into());
    }
    let body = data.to_string();
    let _io = lock(&state.io);
    vault::write_atomic(&state.paths.graph, body.as_bytes()).map_err(|e| format!("write graph: {}", e))
}

/// The workout, food and fasting log, read when the Workout view opens.
#[tauri::command]
async fn fit_load(state: State<'_, AppState>) -> Result<Value, String> {
    let p = &state.paths.fit;
    if let Some(v) = read_json(p).filter(|v| v.is_object()) { return Ok(v); }
    // there but unreadable (a sync conflict, a hand edit): kept beside it before an empty log can be saved over it
    static KEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false); // once a run, not at every load
    if p.is_file() && !KEPT.swap(true, Ordering::SeqCst) { let _ = std::fs::copy(p, p.with_extension(format!("broken {}.json", trash_stamp()))); }
    Ok(json!({}))
}

#[tauri::command]
async fn fit_save(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    if !data.is_object() {
        return Err("the workout log must be an object".into());
    }
    let body = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let _io = lock(&state.io);
    vault::write_atomic(&state.paths.fit, body.as_bytes()).map_err(|e| format!("write fit: {}", e))
}

/// A text file written where a save dialog pointed (the Calendar's .ics export).
#[tauri::command]
async fn text_save(app: AppHandle, path: String, text: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("a full path is needed".into());
    }
    // where the save dialog pointed is the user's (grant::pick_save); any other place is asked about
    grant::allow(&app, &p, "save a file at", false)?;
    vault::write_atomic(&p, text.as_bytes()).map_err(|e| format!("write {}: {}", path, e))
}

/// Vaults Obsidian knows about, most recently opened first. Never an error:
/// no Obsidian means an empty list.
#[tauri::command]
async fn vault_candidates() -> Vec<obsidian::VaultCandidate> {
    obsidian::config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|text| obsidian::parse_vault_list(&text))
        .unwrap_or_default()
}

// ── owner lease ─────────────────────────────────────────────────────────────

/// Path of the ownership lease. While this file's mtime is fresh, the Python
/// app treats the task file as read-only and stops writing.
fn owner_lock_path() -> PathBuf {
    let d = home_dir().join(".leonote");
    let _ = std::fs::create_dir_all(&d);
    d.join("owner.lock")
}

/// Publish an ownership lease and keep it warm.
///
/// Why this exists: the Python app reads tasks ONCE at __init__ and then
/// `_maintenance_tick` re-saves that session-old array every 60 seconds with no
/// user action, and it is set to run at startup. So without a lease, an agent
/// ticking a task gets silently reverted ~40s later by a Python process nobody
/// touched. The lease lets Python stand down while this app is alive; it goes
/// stale 90s after we exit and Python resumes on its own.
fn start_owner_lease() {
    std::thread::spawn(|| {
        let path = owner_lock_path();
        loop {
            // Rewriting the file (rather than touching it) keeps the mtime
            // fresh on every filesystem, including ones with coarse timestamps.
            let _ = std::fs::write(&path, b"leonote-rs owns tasks\n");
            // well inside Python's 90 s: one write missed (a locked file) still leaves it fresh, with time to spare
            std::thread::sleep(std::time::Duration::from_secs(40));
        }
    });
}

// ── window shell ────────────────────────────────────────────────────────────

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Global quick capture, registered in Rust so it works while the webview is
/// hidden or busy. A taken hotkey is not fatal - the app just lacks it.
#[cfg(desktop)]
fn setup_capture_shortcut(app: &tauri::App) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let capture = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, sc, ev| {
            if ev.state() == ShortcutState::Pressed && *sc == capture {
                show_main(app);
                let _ = app.emit("app:capture", ());
            }
        })
        .build();
    if let Err(e) = app.handle().plugin(plugin) {
        eprintln!("global shortcut plugin: {}", e);
        return;
    }
    if let Err(e) = app.global_shortcut().register(capture) {
        eprintln!("Ctrl+Alt+N is unavailable (taken by another app?): {}", e);
        CAPTURE_TAKEN.store(true, Ordering::SeqCst);
    }
}

/// A note's text that could not be saved (a sync client holding the file, a full disk, deleted outside while typed in),
/// kept beside Leonote's data until a save gets through: a crash, a shutdown or "quit anyway" then loses nothing,
/// and the next start offers it back. One file per note, named by its path's fingerprint.
/// Kept in this computer's own Leonote folder whatever the data mode: in the vault, a sync would carry one computer's
/// unsaved words to another, to be offered over that computer's newer note.
fn rescue_dir() -> PathBuf { store::leonote_dir().join("unsaved") }
/// Named by the vault and the note's path together: the same name in another vault is another note.
fn rescue_file(state: &AppState, path: &str) -> PathBuf {
    rescue_dir().join(format!("{}.json", crate::external::sha256_hex(format!("{}\n{}", state.paths.vault.display(), path).as_bytes())))
}
#[tauri::command]
async fn rescue_keep(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let f = rescue_file(&state, &path);
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    vault::write_atomic(&f, json!({ "vault": state.paths.vault.display().to_string(), "path": path, "content": content, "at": at }).to_string().as_bytes()).map_err(|e| e.to_string())
}
#[tauri::command]
async fn rescue_drop(path: String, state: State<'_, AppState>) -> Result<(), String> {
    match std::fs::remove_file(rescue_file(&state, &path)) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) }
}
#[tauri::command]
async fn rescue_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let here = state.paths.vault.display().to_string();
    let dir = rescue_dir();
    Ok(std::fs::read_dir(&dir).into_iter().flatten().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()))
        .filter(|v| v["path"].is_string() && v["content"].is_string() && v["vault"].as_str() == Some(here.as_str()))
        .collect())
}

/// The Welcome note's text, to read without writing it into a vault that never had one (an Obsidian vault opened here).
#[tauri::command]
fn welcome_text() -> &'static str { vault::WELCOME }

/// Ctrl+Alt+N could not be had (another app holds it): the page says so once, with the key that still works.
static CAPTURE_TAKEN: AtomicBool = AtomicBool::new(false);

/// The window starts hidden and the frontend shows it after first paint (no
/// white flash). If the frontend dies before that, nobody would ever see the
/// window - so show it anyway after 3 s.
fn show_safety_net(app: AppHandle) {
    if START_HIDDEN.load(Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if let Some(w) = app.get_window("main") {
            if !w.is_visible().unwrap_or(true) {
                eprintln!("frontend did not show the window within 3 s; showing it");
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    });
}

/// Launched by autostart with `--hidden`: stay in the tray until summoned.
static START_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Set once a real quit is under way, so the close that follows is not
/// turned into a hide.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// Set by the frontend when a quit finds notes still saving: the fallback exit waits.
static QUIT_HOLD: AtomicBool = AtomicBool::new(false);
static QUIT_WAIT: AtomicBool = AtomicBool::new(false); // a note could not be saved: the user decides when to quit

/// `closeToTray` in app.json, default on. Read at close time, so the setting
/// applies the moment the frontend saves it.
fn close_to_tray(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    read_json(&st.paths.settings)
        .and_then(|v| v.get("closeToTray").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

/// Ask the frontend to flush its last keystrokes, then exit - after 2.5 s
/// regardless, so a hung webview can never keep the process alive.
fn request_quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    webwin::close_all(app);
    let _ = app.emit("app:close-requested", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        if QUIT_HOLD.load(Ordering::SeqCst) {
            // saving is under way: a minute more, then out regardless
            for _ in 0..120 { std::thread::sleep(std::time::Duration::from_millis(500)); if !QUIT_HOLD.load(Ordering::SeqCst) { break; } }
            // unless a note could not be saved: then only the user's own Quit (or a save that finally lands) ends it
            while QUIT_WAIT.load(Ordering::SeqCst) && QUIT_HOLD.load(Ordering::SeqCst) { std::thread::sleep(std::time::Duration::from_millis(500)); }
        }
        trace("quit fallback: frontend did not answer, exiting");
        handle.exit(0);
    });
}

#[tauri::command]
fn app_request_quit(app: AppHandle) {
    request_quit(&app);
}

/// Enable or disable launch-at-login (hidden). Returns the resulting state.
#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(mobile)] { let _ = (app, enabled); Ok(false) } // a phone starts nothing at login
    #[cfg(desktop)] {
        use tauri_plugin_autostart::ManagerExt;
        let m = app.autolaunch();
        if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())?;
        m.is_enabled().map_err(|e| e.to_string())
    }
}

/// At start, launch at login on: still on in Windows (Task Manager or Startup apps may have switched it off), it names
/// the exe that is running now - a portable copy run from a new folder is the one Windows starts. Off there stays off.
#[tauri::command]
fn autostart_repoint(app: AppHandle) -> Result<bool, String> {
    #[cfg(mobile)] { let _ = app; Ok(false) }
    #[cfg(desktop)] {
        use tauri_plugin_autostart::ManagerExt;
        let m = app.autolaunch();
        let on = m.is_enabled().map_err(|e| e.to_string())?;
        if on { m.enable().map_err(|e| e.to_string())?; }
        Ok(on)
    }
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "open", "Open Leonote", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Quick capture", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Leonote", true, None::<&str>)?;
    // the timer from the tray, without opening the window (Alt+P works only inside it)
    let pomo = MenuItem::with_id(app, "pomo", "Start / pause the timer", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &capture, &pomo, &sep, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Leonote")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "capture" => {
                show_main(app);
                let _ = app.emit("app:capture", ());
            }
            "pomo" => { let _ = app.emit("app:pomo", ()); }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// The frontend has flushed everything it holds; exit now. RunEvent::Exit
/// still runs the exit compaction below.
#[tauri::command]
fn app_quit(app: AppHandle) {
    trace("app_quit from frontend");
    app.exit(0);
}

/// Inherited by the relaunched process: Tauri restarts with the same
/// arguments, and a restart the user asked for must show the window even if
/// this process was autostarted with `--hidden`.
const RESTARTED_ENV: &str = "LEONOTE_RESTARTED";

/// Is this the Microsoft Store (MSIX) build? Inside a package Windows keeps
/// its own copy of the registry keys the app would write for "launch at login"
/// and file associations - the package's manifest declares those instead -
/// and a few choices are shown differently. An exe built for the Store is the
/// Store build wherever it runs, so it never asks for what it left out.
fn app_packaged() -> bool {
    if cfg!(feature = "store") { return true; }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
        let mut len = 0u32;
        // not packaged: APPMODEL_ERROR_NO_PACKAGE (15700); packaged: the buffer is too small (122)
        return GetCurrentPackageFullName(&mut len, None).0 != 15700;
    }
    #[allow(unreachable_code)]
    false
}

/// The Store build started by Windows at login (its manifest's startup task): no `--hidden` comes with it, so the
/// activation says it - and it stays in the tray like the other build's launch at login.
fn store_startup_task() -> bool {
    #[cfg(windows)]
    if app_packaged() {
        use windows::ApplicationModel::{Activation::ActivationKind, AppInstance};
        return AppInstance::GetActivatedEventArgs().and_then(|a| a.Kind()).map(|k| k == ActivationKind::StartupTask).unwrap_or(false);
    }
    false
}

/// Relaunch - e.g. after the frontend saved a new `settings.vault`.
///
/// Async on purpose, and `request_restart` rather than `restart`: on the main
/// thread (where sync commands run) `restart` relaunches straight away,
/// skipping RunEvent::Exit - no exit compaction, and the single-instance
/// mutex may still be held when the new process checks it, in which case
/// the new process just forwards its arguments to us and quits.
/// `request_restart` exits normally (plugins release the mutex, RunEvent::Exit
/// runs `on_exit`) and relaunches after. `on_exit` also runs here first - it
/// is idempotent - so the compaction happens even if the exit request fails
/// and Tauri falls back to relaunching directly.
/// The start page's answer to a missing vault: make the folder again, or go back to the default vault. A restart follows.
#[tauri::command]
async fn vault_missing(create: bool, state: State<'_, AppState>) -> Result<(), String> {
    let p = &state.paths;
    if p.vault.exists() { return Ok(()); }
    if create {
        std::fs::create_dir_all(&p.vault).map_err(|e| format!("create {}: {}", p.vault.display(), e))
    } else if let Some(v) = std::env::var("LEONOTE_VAULT").ok().filter(|v| !v.trim().is_empty()) {
        Err(format!("The vault is set by the LEONOTE_VAULT environment variable ({}): change or remove it there.", v))
    } else {
        settings::forget_vault(&p.settings)
    }
}

#[tauri::command]
async fn app_restart(app: AppHandle) {
    trace("app_restart from frontend");
    QUITTING.store(true, Ordering::SeqCst);
    on_exit(&app);
    std::env::set_var(RESTARTED_ENV, "1");
    app.request_restart();
}

/// On exit: stop watching (an RDCW registration holds directory handles) and
/// compact, so the Python app - which reads the snapshot once at launch -
/// starts from current state.
fn on_exit(app: &AppHandle) {
    let st = app.state::<AppState>();
    if st.exited.swap(true, Ordering::SeqCst) {
        return;
    }
    clip::clear_secret();
    trace("on_exit: dropping watcher");
    lock(&st.watcher).take();
    trace("on_exit: taking task lock");
    let _g = lock(&st.tasks);
    if store::log_bytes_in(&st.paths.dir) > 0 {
        trace("on_exit: compacting");
        if let Err(e) = store::compact(&st.paths.dir, &st.paths.snapshot, &compact_stamp()) {
            eprintln!("exit compaction skipped: {}", e);
        }
    }
    trace("on_exit: done");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // a phone has no home folder: the app's own private storage is it (the vault, ~/.leonote, the tasks), named by the
    // package the process runs as. ponytail: private to the app; a vault the user picks (or Drive) comes next.
    #[cfg(target_os = "android")]
    if std::env::var_os("HOME").map_or(true, |h| h.is_empty() || h == "/") {
        if let Ok(cmd) = std::fs::read("/proc/self/cmdline") {
            let first = cmd.split(|b| *b == 0).next().unwrap_or(&[]);
            let pkg = String::from_utf8_lossy(first).split(':').next().unwrap_or("").to_string();
            if !pkg.is_empty() && !pkg.contains('/') {
                let d = format!("/data/data/{pkg}/files");
                let _ = std::fs::create_dir_all(&d);
                std::env::set_var("HOME", d);
            }
        }
    }
    // an agent asked for the vault over MCP: no window, no plugins, no
    // single-instance handshake - just stdin and stdout until they close
    if std::env::args().any(|a| a == "--mcp") {
        let _ = std::env::set_current_dir(home_dir());
        let p = Paths::resolve();
        // the folders kept out of the index are kept from agents too
        vault::load_no_index(&p);
        // ffmpeg and Whisper, for the video tools
        external::set_modules_root(&p.vault);
        mcp::serve(mcp::Ctx { vault: p.vault, dir: p.dir, snapshot: p.snapshot });
        return;
    }
    START.get_or_init(Instant::now);
    external::remember_argv();
    // the folder Leonote was started from may be one somebody sent (a note double-clicked in it): cmd and the programs it starts would
    // take a winget.cmd or a config file lying there for the real thing
    let _ = std::env::set_current_dir(home_dir());
    // before any thread starts; removed so programs we open do not inherit it
    let restarted = std::env::var_os(RESTARTED_ENV).is_some();
    std::env::remove_var(RESTARTED_ENV);
    START_HIDDEN.store(!restarted && (std::env::args().any(|a| a == "--hidden") || store_startup_task()), Ordering::SeqCst);
    let paths = Paths::resolve();
    vault::load_no_index(&paths);
    // optional modules (ffmpeg, Whisper…) live on this computer, in %LOCALAPPDATA%\LeoNote\tools\<program>
    external::set_modules_root(&paths.vault);
    // launched at login with a wait asked for: the rest of Windows starts first. Opening
    // Leonote meanwhile starts it at once, and this one then finds it and steps aside
    if START_HIDDEN.load(Ordering::SeqCst) {
        let secs = settings::load(&paths.settings, &paths.vault).get("launchDelay").and_then(|v| v.as_u64()).unwrap_or(0).min(600);
        if secs > 0 { std::thread::sleep(std::time::Duration::from_secs(secs)); }
    }
    // websites get a browser profile of their own, add-ons included; once, a copy of the shared one - before the
    // window is built (its browser would hold the shared profile's lockfile from then on)
    webwin::move_web_profile();
    start_owner_lease();
    let state = AppState {
        paths,
        tasks: Mutex::new(TaskState::default()),
        echo: Mutex::new(watch::Echo::default()),
        io: Mutex::new(()),
        watcher: Mutex::new(None),
        backed_up: Mutex::new(std::collections::HashSet::new()),
        note_kept: Mutex::new(std::collections::HashMap::new()),
        booted: AtomicBool::new(false),
        exited: AtomicBool::new(false),
    };

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        use tauri_plugin_window_state::StateFlags;
        // single-instance must be registered first to intercept the launch;
        // a second launch while we live in the tray just shows the window
        builder = builder
                        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
                show_main(app);
                // a .md double-clicked while we already run: the second
                // process dies, so its documents have to travel to this one
                let files = external::file_args(&args, std::path::Path::new(&cwd));
                // files the user opened with Leonote: theirs to change
                for f in &files { grant::grant(f); }
                if !files.is_empty() {
                    let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                    let _ = app.emit("app:open-external", json!({ "paths": paths }));
                }
            }))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    // geometry only: visibility belongs to the frontend's
                    // show-after-first-paint
                    .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                    // web panels keep their geometry next to their shortcut in
                    // settings, so the plugin must not also file them away
                    .with_filter(|label| !webwin::is_web_label(label))
                    .build(),
            )
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ))
            // installs a new version on a click (update.rs); nothing is fetched by itself
            .plugin(tauri_plugin_updater::Builder::new().build());
    }
    // a phone hands over picked files as content links, which only this plugin can open (grant.rs: pick_open, pick_save)
    #[cfg(target_os = "android")]
    { builder = builder.plugin(tauri_plugin_fs::init()); }
    trace("building app");
    let app = builder
        .on_page_load(|_w, p| match p.event() {
            tauri::webview::PageLoadEvent::Started => trace("page load started"),
            tauri::webview::PageLoadEvent::Finished => {
                trace("page load finished");
                // Leonote's own page never takes the browser's form memory (passwords, autofill): set again once
                // the page is up, as the switch made at setup did not always hold
                if _w.label() == "main" { webwin::passwords_in(_w, false); }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // pictures the webview cannot load itself: HEIC from the disk, and what is on a phone
        // - answered only to Leonote's own windows: a website open in a tab gets nothing from them
        .register_asynchronous_uri_scheme_protocol("heic", |ctx, req, responder| {
            if !own_request(ctx.webview_label(), &req) { return responder.respond(scheme_answer((403, "text/plain", b"not for this page".to_vec()))); }
            let uri = req.uri().to_string();
            std::thread::spawn(move || responder.respond(scheme_answer(phone::serve("heic", &uri))));
        })
        .register_asynchronous_uri_scheme_protocol("phone", |ctx, req, responder| {
            if !own_request(ctx.webview_label(), &req) { return responder.respond(scheme_answer((403, "text/plain", b"not for this page".to_vec()))); }
            let uri = req.uri().to_string();
            std::thread::spawn(move || responder.respond(scheme_answer(phone::serve("phone", &uri))));
        })
        .manage(state)
        .setup(|app| {
            trace("setup");
            #[cfg(desktop)]
            {
                setup_capture_shortcut(app);
                if let Err(e) = setup_tray(app) {
                    eprintln!("tray unavailable: {}", e);
                }
            }
            #[cfg(windows)]
            browser_keys_to_page(app);
            // Leonote's own window never offers to save what is typed in it (the passwords' master password, a key):
            // the browser's saving is for the pages in the tabs only, and only when it is switched on there
            if let Some(wv) = app.get_webview("main") { webwin::passwords_in(&wv, false); }
            {
                let settings = app.state::<AppState>().paths.settings.clone();
                std::thread::spawn(move || external::refresh_type_icons(&settings));
            }
            std::thread::spawn(|| phone::sweep_work(&phone::work_root(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)));
            show_safety_net(app.handle().clone());
            Ok(())
        })
        // Close is decided here, not by a JS close-requested listener: that
        // path depends on the webview answering and on window ACLs, and in
        // practice left the process running after a plain WM_CLOSE. Rust
        // holds the close, asks the frontend to flush its last keystrokes,
        // and exits when it answers - or after 2.5 s regardless.
        .on_window_event(|window, event| {
            // Coming back from the clock's calendar or a tray popup, Windows
            // activates the frame but leaves the keys outside the webview, so
            // the page never hears "focus" and the caret stays gone. Hand the
            // keys to the webview, and tell the page it is back.
            if let tauri::WindowEvent::Focused(true) = event {
                if window.label() == "main" {
                    // The frame is active again but WebView2 does not always get
                    // the keys back by itself (Alt+Tab, the taskbar): hand them
                    // to the webview. From another thread - asked from inside
                    // this handler it waits on the very thread it runs on and
                    // the app hangs - and at most once in half a second, so a
                    // Focused that the hand-over itself causes cannot chase it.
                    static LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                    if now.saturating_sub(LAST.swap(now, Ordering::SeqCst)) > 500 {
                        if let Some(w) = window.app_handle().get_webview("main") {
                            std::thread::spawn(move || {
                                // twice: a click on the title bar that brought the
                                // window back is still going on at the first
                                for ms in [40, 260] {
                                    std::thread::sleep(std::time::Duration::from_millis(ms));
                                    let _ = w.set_focus();
                                }
                            });
                        }
                    }
                    let _ = window.emit("app:focused", ());
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let app = window.app_handle();
                if !QUITTING.load(Ordering::SeqCst) && close_to_tray(app) {
                    // The expensive part of opening is WebView2 spawning its
                    // browser process (~600 ms), not us. Hiding means the next
                    // open costs nothing.
                    trace("close requested: hiding to tray");
                    let _ = window.hide();
                    let _ = window.emit("app:hidden", ());
                } else {
                    trace("close requested: quitting");
                    request_quit(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            win_place,
            task_ops,
            note_write,
            note_versions, note_history_erase, tasks_erase,
            note_version_read,
            note_version_keep,
            note_create,
            note_rename,
            note_trash,
            folder_create,
            folder_rename,
            folder_trash,
            habits_save,
            settings_save,
            tasks_restore,
            tasks_history_list,
            app_quit_hold,
            backup::backup_categories,
            backup::backup_plain,
            backup::archive_list,
            backup::archive_preview,
            backup::archive_extract,
            backup::sync_folders,
            data_dir_set,
            reveal,
            reveal_settings,
            open_url,
            app_quit,
            app_request_quit,
            autostart_set,
            autostart_repoint,
            recurring_save,
            priorities_save,
            stats_save,
            trace_ui,
            file_read_text,
            open_path,
            file_trash,
            file_rename,
            image_save,
            file_write,
            external::guest_open,
            paste_files,
            file_import,
            positions_save,
            graph_load,
            graph_save,
            note_stamp,
            vault_copy,
            ids_load,
            ids_save,
            fit_load,
            fit_save,
            text_save,
            vault_candidates,
            app_restart,
            vault_missing,
            welcome_text,
            rescue_keep,
            rescue_drop,
            rescue_list,
            external::external_stat,
            external::external_read,
            external::external_write,
            external::external_import,
            external::external_put_back,
            external::external_stage,
            external::external_open_in_app,
            external::external_reveal,
            external::external_rename,
            external::hidden_list,
            external::online_tools,
            external::online_install,
            external::tool_install,
            external::captions_make,
            external::hidden_find,
            videoai::video_ai,
            pics_load,
            pics_save,
            phone::phone_devices,
            phone::phone_list,
            phone::phone_copy,
            phone::phone_delete,
            phone::phone_compress,
            phone::phone_scan,
            keep::keep_import,
            phone::phone_scan_stop,
            phone::phone_fingerprints,
            phone::phone_compress_apply,
            phone::phone_compress_discard,
            videoexport::video_export_begin,
            videoexport::video_export_audio,
            videoexport::video_export_start,
            videoexport::video_export_frame,
            videoexport::video_export_end,
            videoexport::video_export_cancel,
            library::library_add,
            outpost::outpost_add,
            outpost::outpost_forget,
            outpost::outpost_list,
            video_fullscreen,
            os_notify,
            reclaim_focus,
            ai::ai_key_set,
            ai::ai_key_get,
            ai::ai_key_hide,
            ai::ai_key_hidden,
            jev::jev_ask, jev::jev_backend_get, jev::jev_backend_set, jev::laya_install, jev::laya_start,
            proposals::proposals_list,
            proposals::proposals_count,
            proposals::proposal_accept,
            proposals::proposal_reject,
            proposals::proposal_make,
            proposals::ai_access_get,
            proposals::ai_access_set, proposals::ai_tasks_set, proposals::ai_full_set,
            ai::ai_keys_have,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_models,
            ai::mcp_command,
            outpost::outpost_find,
            outpost::outpost_texts,
            outpost::outpost_rename,
            outpost::outpost_mkdir,
            outpost::outpost_import,
            outpost::outpost_trash,
            project::project_info,
            project::project_files,
            project::project_search,
            project::project_replace,
            project::project_undo,
            project::project_git,
            trashbin::trash_list,
            trashbin::trash_restore,
            trashbin::trash_remove,
            trashbin::trash_sweep,
            trashbin::trash_open,
            outpost::external_allow,
            external::unindexed_find, external::unindexed_names, external::no_index_set,
            grant::pick_open, grant::pick_save, grant::pick_save_done,
            script::script_open, script::script_start, script::script_path,
            claude_import::claude_import, update::update_check, update::update_fetch, update::update_apply,
            drive::drive_status, drive::drive_connect, drive::drive_disconnect, drive::drive_sync,
            viewer::viewer_open, viewer::viewer_start, viewer::viewer_siblings, viewer::viewer_trash,
            oauth::oauth_listen,
            oauth::oauth_wait,
            oauth::google_token,
            ytlist::yt_preview_bytes,
            ytlist::yt_preview_put,
            music::music_tags,
            music::music_tags_write,
            ytlist::yt_previews,
            ytlist::yt_preview_keep,
            voice::voice_listen,
            speech::speech_transcribe,
            library::library_scan,
            external::associate_files,
            external::associate_state,
            sizes::folder_sizes,
            sizes::sizes_start,
            sizes::sizes_poll,
            sizes::sizes_stop,
            sizes::drive_space,
            backup::backup_export,
            backup::backup_peek,
            backup::backup_import,
            imageedit::image_edit_read,
            imageedit::image_edit_write,
            imageedit::image_edit_delete,
            paint::paint_save,
            paint::paint_load,
            paint::paint_inspect,
            pcsearch::pc_index_start,
            pcsearch::pc_index_state,
            pcsearch::pc_index_cancel,
            pcsearch::pc_roots,
            pcsearch::pc_drives,
            pcsearch::pc_search,
            webwin::web_window_open,
            webwin::mini_player,
            webwin::yt_mini,
            webwin::break_pop,
            webwin::split_web_show,
            webwin::split_web_hide,
            webwin::split_web_close,
            webwin::split_web_go,
            webwin::tab_web_show, webwin::tab_web_focus, webwin::tab_web_zoom, webwin::tab_web_post, webwin::tab_web_mute, webwin::tab_web_memory, webwin::tab_web_download_reply,
            webwin::tab_web_hide,
            webwin::tab_web_close,
            webwin::tab_web_go,
            webwin::ext_pop_show,
            webwin::ext_pop_hide,
            plugins::plugin_list, plugins::plugin_install_folder, plugins::plugin_search, plugins::plugin_install_listed, plugins::plugin_enable, plugins::plugin_disable, plugins::plugin_remove, plugins::plugin_main, plugins::plugin_fetch,
            linkcard::link_preview,
            linkcard::source_fetch, linkcard::link_picture, pw::pw_copy_text, webwin::web_passwords_set, webext::web_passwords_forget, pw::pw_status, pw::pw_unlock, pw::pw_lock, pw::pw_list, pw::pw_reveal, pw::pw_copy, pw::pw_put, pw::pw_remove, pw::pw_fill, pw::pw_offer_save, pw::pw_offer_drop, pw::pw_reset, webwin::web_history_get, webwin::web_history_set, officeconv::office_convert,
            webext::web_ext_list,
            webext::web_ext_install,
            webext::web_ext_set,
            webext::web_ext_sites,
            webext::web_ext_remove,
            webext::web_ext_update,
            webwin::web_window_close,
            webwin::web_window_list
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => trace("exit requested"),
        tauri::RunEvent::Exit => {
            trace("exit");
            on_exit(handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_round_trips_unicode_paths() {
        assert_eq!(super::percent_decode("Utilities%2FCache%2F%D0%9D%D0%BE%D1%82%D0%B0-1.webp").unwrap(), "Utilities/Cache/Нота-1.webp");
        assert_eq!(super::percent_decode("a%20b.webp").unwrap(), "a b.webp");
        assert_eq!(super::percent_decode("plain.webp").unwrap(), "plain.webp");
        assert!(super::percent_decode("bad%zz.webp").is_err());
        assert_eq!(super::percent_decode("trailing%2").unwrap(), "trailing%2");
    }

    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("leonote_lib_{}", name));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("log")).unwrap();
        let snap = root.join("tasks.json");
        (root, snap)
    }

    /// Round-tripping the REAL data file must not add, drop or alter a single
    /// key. Read-only: it never writes the live file.
    #[test]
    fn roundtrip_preserves_every_field() {
        let raw = match std::fs::read_to_string(home_dir().join(".leonote_tasks.json")) {
            Ok(r) => r,
            Err(_) => return, // no data file here; nothing to prove
        };
        let original: Value = serde_json::from_str(&raw).expect("original parses");
        let tasks: Vec<Value> = serde_json::from_str(&raw).expect("parses as values");
        let back = serde_json::to_value(&tasks).expect("serializes back");
        assert_eq!(original, back, "round-trip altered the data");
    }

    /// The whole write path - ops, fold, compaction - on a synthetic snapshot
    /// full of keys this app knows nothing about must preserve every one.
    #[test]
    fn ops_then_compaction_preserve_unknown_fields() {
        let (root, snap) = scratch("ops_roundtrip");
        let original = json!([
            {"id":"a","text":"x","done":false,"rec_id":"r1","due_date":null,"n":3,"subtasks":[{"id":"s","text":"t","done":false}]},
            {"id":"b","text":"y","weird":{"nested":[1,2.5,"z"]}}
        ]);
        std::fs::write(&snap, serde_json::to_string_pretty(&original).unwrap()).unwrap();
        let mut st = TaskState { tasks: store::fold_in(&root, &snap).tasks };

        let r = apply_ops(&root, &snap, &mut st, &[json!({"id":"a","done":true})], "2026-09-14T10:00:00.000").unwrap();
        assert_eq!(r["patch"], json!({"a":{"done":true}}));
        assert_eq!(r["bad"], json!(0));

        std::fs::copy(&snap, interop::base_path(&root)).unwrap();
        // compaction is an identity except for renormalised `ord`, which the
        // UI does need to learn about - so that is all the patch may carry
        let out = import_and_compact(&root, &snap, &mut st, "2026-09-14T10:00:01.000", "s1");
        for (_, fields) in out.expect("ord patch")["patch"].as_object().unwrap() {
            let keys: Vec<&String> = fields.as_object().unwrap().keys().collect();
            assert_eq!(keys, vec!["ord"]);
        }

        let after: Value = serde_json::from_str(&std::fs::read_to_string(&snap).unwrap()).unwrap();
        for (i, t) in after.as_array().unwrap().iter().enumerate() {
            let mut t = t.as_object().unwrap().clone();
            t.remove("ord");
            let mut want = original[i].as_object().unwrap().clone();
            if i == 0 {
                want.insert("done".into(), json!(true));
            }
            assert_eq!(t, want);
        }
    }

    #[test]
    fn our_own_ops_are_the_only_patch() {
        let (root, snap) = scratch("ops_patch");
        std::fs::write(&snap, r#"[{"id":"a","text":"x"}]"#).unwrap();
        let mut st = TaskState::default();
        st.tasks = store::fold_in(&root, &snap).tasks;
        let r = apply_ops(&root, &snap, &mut st, &[json!({"id":"n","text":"new"})], "2026-09-14T10:00:00.000").unwrap();
        assert_eq!(r["patch"], json!({"n":{"id":"n","text":"new"}}));
        // a re-fold with nothing new is empty - this is watcher echo suppression
        assert!(store::diff(&st.tasks, &store::fold_in(&root, &snap).tasks).is_empty());
        assert!(apply_ops(&root, &snap, &mut st, &[json!("junk")], "t").is_err());
        let log = store::log_path_in(&root, "ui");
        let before = std::fs::read(&log).unwrap();
        let huge = "x".repeat(5 << 20);
        assert!(apply_ops(&root, &snap, &mut st, &[json!({"id":"n","text":huge})], "t").is_err(), "a 5 MB change is refused");
        assert_eq!(std::fs::read(&log).unwrap(), before, "and the log is untouched");
    }

    #[test]
    fn post_boot_import_emits_python_edits_and_compacts() {
        let (root, snap) = scratch("post_boot");
        let base = json!([{"id":"a","text":"x","done":false}]);
        std::fs::write(&snap, base.to_string()).unwrap();
        std::fs::write(interop::base_path(&root), base.to_string()).unwrap();
        let mut st = TaskState { tasks: store::fold_in(&root, &snap).tasks };
        // the Python app edits the snapshot while we are not running
        std::fs::write(&snap, json!([{"id":"a","text":"x","done":true}]).to_string()).unwrap();
        st.tasks = vec![json!({"id":"a","text":"x","done":false})]; // what boot showed

        let out = import_and_compact(&root, &snap, &mut st, "2026-09-14T10:00:00.000", "pb").expect("a patch");
        assert_eq!(out["patch"]["a"]["done"], json!(true));
        assert_eq!(out["writers"], json!(["py"]));
        assert_eq!(std::fs::read_to_string(store::log_path_in(&root, "py")).unwrap(), "", "compacted");
    }
}
