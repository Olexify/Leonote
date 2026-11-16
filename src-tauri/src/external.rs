//! Files that live outside the vault: a .md double-clicked in Explorer, or
//! picked from the open dialog. They are read and written where they lie -
//! nothing is copied in behind your back - and a single call imports one into
//! the vault when you decide it belongs there.
//!
//! Every path here is an absolute OS path, NOT a vault-relative one, so none
//! of vault.rs's containment rules apply. The guards that remain are the ones
//! that matter off-vault: only regular files, only text-like files into the
//! editor, a size ceiling, and never opening a type Windows would execute.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{lock, AppState};

/// Above this a file is not a note any more, it is a database. The editor
/// would stall and the debounced save would rewrite megabytes per keystroke.
pub const MAX_TEXT: u64 = 8 * 1024 * 1024;
/// What "Open anyway" reads at most.
pub const MAX_TEXT_ANYWAY: u64 = 256 * 1024 * 1024;

/// A NUL byte early on: no text file has one, every binary format has them
/// within the first block. Cheaper and far more reliable than sniffing
/// encodings, and the only mistake it can make is refusing a file.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// What the UI does with it: `note` opens in the Markdown editor, `text` in
/// the code editor, anything else gets a card with "Open in default app".
pub fn kind_of(name: &str) -> &'static str {
    if crate::vault::is_note(name) {
        "note"
    } else {
        crate::vault::file_kind(name)
    }
}

pub fn can_edit(name: &str) -> bool {
    matches!(kind_of(name), "note" | "text")
}

fn name_of(p: &Path) -> String {
    p.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Paths to open from a command line: `LeoNote.exe --hidden C:\notes\a.md`.
/// The program itself is skipped, flags are dropped, relative paths resolve
/// against `cwd`, and only files that really exist survive - a second launch
/// hands us whatever Explorer felt like passing.
pub fn file_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .map(|a| {
            let p = Path::new(a);
            let p = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
            std::path::absolute(&p).unwrap_or(p)
        })
        .filter(|p| p.is_file())
        .take(20)
        .collect()
}

/// Paths the process was started with, handed to the frontend once (in the
/// boot payload). A reload must not reopen them.
static ARGV_FILES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn remember_argv() {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let files = file_args(&args, &cwd);
    // files the user opened with Leonote: theirs to change
    for f in &files { crate::grant::grant(f); }
    *lock(&ARGV_FILES) = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
}

/// The startup paths, once; every later call gets nothing.
pub fn take_argv_files() -> Vec<String> {
    std::mem::take(&mut *lock(&ARGV_FILES))
}

fn stat(path: &Path) -> Result<Value, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    if !md.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let name = name_of(path);
    Ok(json!({
        "path": path.to_string_lossy(),
        "name": name,
        "dir": path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "size": md.len(),
        "mtime": mtime_ms(&md),
        // the wider list: a .flac or .mkv from a music drive is media too
        "kind": if kind_of(&name) == "other" { crate::outpost::kind_of(&name) } else { kind_of(&name) },
        "editable": can_edit(&name),
    }))
}

/// An outside file opened in Leonote's own viewer: registered as a guest (see
/// vault::GUESTS) and made loadable by the webview. Returns the name the
/// frontend uses for it, `@guest/<id>/<file name>`.
#[tauri::command]
pub async fn guest_open(app: tauri::AppHandle, path: String, state: tauri::State<'_, crate::AppState>) -> Result<crate::vault::FileEntry, String> {
    crate::grant::allow_far(&app, Path::new(&path))?;
    let p = std::fs::canonicalize(Path::new(&path)).map_err(|e| format!("{}: {}", path, e))?;
    if !p.is_file() {
        return Err(format!("not a file: {}", path));
    }
    let id = crate::vault::guest_id(&p);
    let name = name_of(&p);
    // the webview may load it (a PDF, a picture, a video) - this one file, nothing beside it
    { use tauri::Manager; app.asset_protocol_scope().allow_file(&p).map_err(|e| e.to_string())?; }
    crate::vault::GUESTS.lock().unwrap().insert(id.clone(), strip_verbatim(p));
    crate::vault::file_entry(&state.paths.vault, &format!("{}{}/{}", crate::vault::GUEST_PREFIX, id, name))
}

/// `\\?\C:\x` (what canonicalize gives on Windows) back to `C:\x`, which every API takes.
fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") { Some(rest) if !rest.starts_with("UNC") => std::path::PathBuf::from(rest), _ => p }
}

/// Name, size, time and kind - without reading the contents.
#[tauri::command]
pub async fn external_stat(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    crate::grant::allow_far(&app, Path::new(&path))?;
    stat(Path::new(&path))
}

/// A text-like file outside the vault, with its stat. Refused above
/// `MAX_TEXT` or when the bytes look binary, so a stray .exe renamed to .md
/// cannot fill the editor with mojibake.
#[tauri::command]
pub async fn external_read(app: tauri::AppHandle, path: String, anyway: Option<bool>) -> Result<Value, String> {
    use std::io::Read;
    let p = Path::new(&path);
    crate::grant::allow_far(&app, p)?;
    let mut info = stat(p)?;
    let name = name_of(p);
    if !can_edit(&name) {
        return Err(format!("{} is not a text file", name));
    }
    let f = std::fs::File::open(p).map_err(|e| format!("open {}: {}", name, e))?;
    let mut bytes = Vec::new();
    // bounded while reading, so a file growing under us cannot blow past it
    // the user said "open anyway": a bigger file, still bounded (an editor holding gigabytes would sink the app)
    let max = if anyway.unwrap_or(false) { MAX_TEXT_ANYWAY } else { MAX_TEXT };
    f.take(max + 1).read_to_end(&mut bytes).map_err(|e| format!("read {}: {}", name, e))?;
    if bytes.len() as u64 > max {
        return Err(format!("{} is larger than {} MB", name, max / (1024 * 1024)));
    }
    if looks_binary(&bytes) {
        return Err(format!("{} is not text", name));
    }
    let text = String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    info["text"] = Value::String(text);
    Ok(info)
}

/// Save an external file in place - temp + fsync + rename, like every vault
/// write. Only over a file that is already there: this never creates one.
#[tauri::command]
pub async fn external_write(app: tauri::AppHandle, path: String, content: String) -> Result<Value, String> {
    let p = Path::new(&path);
    crate::grant::allow(&app, p, "save changes to", false)?;
    let name = name_of(p);
    if !p.is_file() {
        return Err(format!("{} is gone", name));
    }
    if !can_edit(&name) {
        return Err(format!("{} is not a text file", name));
    }
    mark_parked_edited(p);
    crate::vault::write_atomic(p, content.as_bytes()).map_err(|e| format!("write {}: {}", name, e))?;
    stat(p)
}

/// Copy (or move) an outside file into the vault folder `dir` ("" = the
/// root). Nothing is ever overwritten - a taken name gets " 2", " 3"... - and
/// a move only removes the original once the copy is on disk.
#[tauri::command]
pub async fn external_import(app: tauri::AppHandle, path: String, dir: String, move_it: bool, state: State<'_, AppState>) -> Result<Value, String> {
    let src = Path::new(&path);
    // moving takes it away from where it was: asked about unless the user handed it over
    if move_it { crate::grant::allow(&app, src, "move into the vault (taking it from where it is)", false)?; }
    // a copy from another computer is asked about too (looking at it signs Windows in there)
    else { crate::grant::allow_far_once(&app, src, "copy this file from another computer into the vault")?; }
    if !src.is_file() {
        return Err(format!("{} is gone", name_of(src)));
    }
    let root = &state.paths.vault;
    let target = if dir.is_empty() { root.clone() } else { crate::vault::resolve(root, &dir)? };
    let name = name_of(src);
    let _io = lock(&state.io);
    std::fs::create_dir_all(&target).map_err(|e| format!("{}: {}", target.display(), e))?;
    let to = crate::clip::free_name(&target, &name);
    std::fs::copy(src, &to).map_err(|e| format!("copy {}: {}", name, e))?;
    if move_it {
        std::fs::remove_file(src).map_err(|e| format!("the copy is in the vault, but {} could not be removed: {}", name, e))?;
    }
    let root_abs = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
    let to_abs = std::fs::canonicalize(&to).unwrap_or_else(|_| to.clone());
    let rel = to_abs
        .strip_prefix(&root_abs)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .map_err(|_| format!("{} landed outside the vault", name))?;
    Ok(json!({ "path": rel, "note": crate::vault::is_note(&rel), "from": src.to_string_lossy(), "moved": move_it }))
}

/// Undo of a move into the vault: the file copied back to where it came from
/// - never over something that is there now. The vault's copy is then
/// trashed by the caller, so nothing is lost either way.
#[tauri::command]
pub async fn external_put_back(app: tauri::AppHandle, path: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let src = crate::vault::resolve(&state.paths.vault, &path)?;
    let dst = PathBuf::from(&to);
    if !dst.is_absolute() { return Err("not a place on this computer".into()); }
    // back where it came from: a file the user had handed over; any other place is asked about
    crate::grant::allow(&app, &dst, "put a file back at", false)?;
    if dst.exists() { return Err(format!("something is at {} again - both are kept", to)); }
    if let Some(d) = dst.parent() { std::fs::create_dir_all(d).map_err(|e| format!("{}: {}", d.display(), e))?; }
    std::fs::copy(&src, &dst).map_err(|e| format!("copy back: {}", e))?;
    Ok(())
}

/// Open an outside file with its own program. Types Windows RUNS rather than
/// opens are refused here exactly as they are inside the vault.
/// A file dropped onto the tab bar. The webview hands over bytes, never the
/// path they came from, so the file is parked in the system's temp folder and
/// opened from there as an outside file - the vault is not touched until the
/// user says where it belongs. Parked files older than two weeks are swept, unless they were saved over.
#[tauri::command]
pub async fn external_stage(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let raw = request.headers().get("x-name").and_then(|v| v.to_str().ok()).ok_or("missing x-name header")?;
    let name = crate::percent_decode(raw)?;
    let name = name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("").trim().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return Err("no file name".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if bytes.len() > 1024 * 1024 * 1024 {
        return Err("file is larger than 1 GB".into());
    }
    let dir = std::env::temp_dir().join(PARKED);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    // Leonote made these itself: adding one to the vault or saving it asks nothing
    crate::grant::grant_dir(&dir);
    sweep_parked(&dir, std::time::SystemTime::now() - std::time::Duration::from_secs(14 * 24 * 3600));
    let to = crate::clip::free_name(&dir, &name);
    if let Some(n) = to.file_name() { let _ = std::fs::remove_file(dir.join(EDITED).join(n)); }
    std::fs::write(&to, bytes).map_err(|e| format!("write {}: {}", name, e))?;
    Ok(to.to_string_lossy().to_string())
}

const PARKED: &str = "leonote-dropped";
/// Beside the parked files: an empty file of the same name for each one the user saved over or renamed.
const EDITED: &str = ".edited";

/// Parked files older than `old` go - not one the user worked on: that text exists nowhere else.
pub(crate) fn sweep_parked(dir: &Path, old: std::time::SystemTime) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if e.metadata().and_then(|m| m.modified()).map(|t| t < old).unwrap_or(false) && !dir.join(EDITED).join(e.file_name()).exists() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Called on each save outside the vault: a parked file is the user's work from now on, the sweep leaves it.
pub(crate) fn mark_parked_edited(p: &Path) {
    let (Some(dir), Some(name)) = (p.parent(), p.file_name()) else { return };
    if dir.file_name().is_none_or(|d| d != PARKED) { return; }
    let marks = dir.join(EDITED);
    let _ = std::fs::create_dir_all(&marks);
    let _ = std::fs::write(marks.join(name), b"");
}

#[tauri::command]
pub async fn external_open_in_app(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    crate::grant::allow_far(&app, p)?;
    let name = name_of(p);
    if !p.is_file() {
        return Err(format!("{} is gone", name));
    }
    if crate::vault::is_launchable(&name) {
        return Err(format!("{} is a program or shortcut; use Show in Explorer instead", name));
    }
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string())
}

/// Show an outside file in Explorer.
#[tauri::command]
pub async fn external_reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    // asked first: even looking at a place on another computer signs in there (a synced workspace brief can name any)
    crate::grant::allow_far_once(&app, p, "show this place on another computer in Explorer")?;
    if !p.exists() {
        return Err(format!("{} is gone", name_of(p)));
    }
    // Explorer itself, the file selected: the shell call the vault uses failed silently for some outside folders
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let win = path.replace('/', "\\");
        // a folder opens as itself (a path written in a note); a file is only shown, selected - Explorer handed a
        // file would open it, and that could be a program
        let arg = if p.is_dir() { format!("\"{}\"", win) } else { format!("/select,\"{}\"", win) };
        return std::process::Command::new(program("explorer.exe")).raw_arg(arg).spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

// ── file associations (HKEY_CURRENT_USER only) ──────────────────────────────

/// Extensions the Settings toggle registers, lowercase and without the dot.
pub fn clean_exts(exts: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for e in exts {
        let e = e.trim().trim_start_matches('.').to_ascii_lowercase();
        if !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()) && !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

/// ProgID for one extension: `LeoNote.md`, `LeoNote.txt`...
pub fn prog_id(ext: &str) -> String {
    format!("LeoNote.{}", ext)
}

/// The icon Explorer shows for a file Leonote opens: a plain page in its kind's colour with a short
/// label (MD, TXT, IMG, ♫...), so a file says what it is whichever app opens it. Drawn by
/// scripts/type-icons.py; the name is the .ico written beside the settings.
pub fn type_icon(ext: &str) -> (&'static str, &'static [u8]) {
    macro_rules! ico {
        ($n:literal) => {
            ($n, include_bytes!(concat!("../icons/types/", $n, ".ico")) as &[u8])
        };
    }
    match ext {
        "md" | "markdown" => ico!("note"),
        "txt" | "log" | "ini" | "cfg" | "conf" | "env" | "srt" | "vtt" | "rst" | "adoc" | "org" | "tex" | "properties" => ico!("text"),
        "json" | "jsonc" | "yml" | "yaml" | "toml" | "xml" | "base" => ico!("data"),
        "pdf" => ico!("pdf"),
        "docx" | "doc" | "odt" | "rtf" => ico!("doc"),
        "xlsx" | "xls" | "ods" | "csv" | "tsv" => ico!("sheet"),
        "pptx" | "ppt" | "odp" => ico!("slides"),
        "mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac" | "opus" | "oga" | "weba" => ico!("audio"),
        "mp4" | "webm" | "mkv" | "mov" | "m4v" => ico!("video"),
        "canvas" => ico!("board"),
        "excalidraw" | "leovector" | "leopaint" | "leocanvas" => ico!("sketch"),
        "leovideo" => ico!("movie"),
        _ => match crate::vault::file_kind(&format!("x.{}", ext)) {
            "image" => ico!("image"),
            "text" => ico!("code"),
            "archive" => ico!("archive"),
            _ => ico!("file"),
        },
    }
}

/// The extensions a type icon is looked for at start: Leonote's own "Open with" entries and the
/// installer's .md / .txt may point at the app's logo from an older build.
const ICON_EXTS: &[&str] = &[
    "md", "markdown", "txt", "log", "json", "jsonc", "yml", "yaml", "toml", "xml", "csv", "tsv", "ini", "cfg", "conf",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "mp3", "wav", "ogg", "m4a", "flac", "opus", "mp4", "webm",
    "mkv", "mov", "canvas", "excalidraw", "leovector", "leopaint", "leocanvas", "leovideo",
];

pub fn ext_label(ext: &str) -> String {
    match ext {
        "md" | "markdown" => "Markdown note".into(),
        "txt" => "Text note".into(),
        other => format!("{} file (Leonote)", other.to_ascii_uppercase()),
    }
}

#[cfg(windows)]
mod assoc {
    use super::{clean_exts, ext_label, prog_id};
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    fn exe() -> Result<String, String> {
        Ok(std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned())
    }

    /// The type's icon written to `dir` (once, or again when it changed), as a DefaultIcon value.
    fn icon_value(dir: &std::path::Path, ext: &str) -> Option<String> {
        let (name, bytes) = super::type_icon(ext);
        let p = dir.join(format!("{}.ico", name));
        if std::fs::read(&p).ok().as_deref() != Some(bytes) {
            std::fs::create_dir_all(dir).ok()?;
            let tmp = p.with_extension("ico.tmp");
            std::fs::write(&tmp, bytes).ok()?;
            std::fs::rename(&tmp, &p).ok()?;
        }
        Some(format!("\"{}\"", p.to_string_lossy()))
    }

    /// No app opens this type: no default under the extension, nothing picked in "Open with".
    fn unclaimed(ext: &str) -> bool {
        let root = RegKey::predef(winreg::enums::HKEY_CLASSES_ROOT);
        let default = root.open_subkey(format!(".{}", ext)).and_then(|k| k.get_value::<String, _>("")).unwrap_or_default();
        let picked = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{}\\UserChoice", ext))
            .and_then(|k| k.get_value::<String, _>("ProgId"))
            .unwrap_or_default();
        default.trim().is_empty() && picked.trim().is_empty()
    }

    /// Every file type that opens in this exe gets its type's icon instead of the app's logo: Leonote's
    /// own entries, the installer's (.md, .txt) and the one you picked in "Open with" - only where the
    /// type's open command is this app. Under HKEY_CURRENT_USER only; Explorer is told once at the end.
    pub fn refresh_icons(dir: &std::path::Path) {
        let Ok(exe) = exe() else { return };
        let me = std::path::Path::new(&exe).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        let root = RegKey::predef(winreg::enums::HKEY_CLASSES_ROOT);
        let Ok(classes) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE) else { return };
        let choice = |ext: &str| {
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(format!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.{}\\UserChoice", ext))
                .and_then(|k| k.get_value::<String, _>("ProgId"))
                .ok()
        };
        let mut changed = false;
        for ext in super::ICON_EXTS {
            let mut ids = vec![prog_id(ext)];
            ids.extend(root.open_subkey(format!(".{}", ext)).and_then(|k| k.get_value::<String, _>("")).ok());
            ids.extend(choice(ext));
            for id in ids {
                // "Applications\leonote-rs.exe" is the app itself, one icon for every type: left alone
                if id.is_empty() || id.contains('\\') {
                    continue;
                }
                let ours = root
                    .open_subkey(format!("{}\\shell\\open\\command", id))
                    .and_then(|k| k.get_value::<String, _>(""))
                    .map(|v| v.to_lowercase().contains(&me))
                    .unwrap_or(false);
                if !ours {
                    continue;
                }
                let Some(want) = icon_value(dir, ext) else { continue };
                let now = root.open_subkey(format!("{}\\DefaultIcon", id)).and_then(|k| k.get_value::<String, _>("")).unwrap_or_default();
                if now != want {
                    if let Ok((k, _)) = classes.create_subkey(format!("{}\\DefaultIcon", id)) {
                        changed |= k.set_value("", &want).is_ok();
                    }
                }
            }
        }
        // a type tied to the exe itself ("Open with" › another app › this exe) shows the app's logo:
        // a plain page instead - the kind can't be told there, Leonote's own entry per type can
        let app_key = format!("Applications\\{}", me);
        if root.open_subkey(&app_key).is_ok() {
            if let Some(want) = icon_value(dir, "") {
                let now = root.open_subkey(format!("{}\\DefaultIcon", app_key)).and_then(|k| k.get_value::<String, _>("")).unwrap_or_default();
                if now != want {
                    if let Ok((k, _)) = classes.create_subkey(format!("{}\\DefaultIcon", app_key)) {
                        changed |= k.set_value("", &want).is_ok();
                    }
                }
            }
        }
        if changed {
            shell_changed();
        }
    }

    /// Tell Explorer the association table changed, so the icon and the
    /// "Open with" list refresh without a sign-out.
    fn shell_changed() {
        use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    /// Register or unregister this exe for `exts`, for THIS USER only:
    /// everything lives under HKEY_CURRENT_USER\Software\Classes, so nothing
    /// here needs (or gets) administrator rights, and turning it off removes
    /// exactly what turning it on added.
    pub fn set(exts: &[String], enable: bool, icons: &std::path::Path) -> Result<(), String> {
        let exts = clean_exts(exts);
        if exts.is_empty() {
            return Err("no extensions".into());
        }
        let exe = exe()?;
        let classes = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
            .map_err(|e| format!("Software\\Classes: {}", e))?;
        for ext in &exts {
            let id = prog_id(ext);
            if enable {
                let (k, _) = classes.create_subkey(&id).map_err(|e| format!("{}: {}", id, e))?;
                k.set_value("", &ext_label(ext)).map_err(|e| e.to_string())?;
                let (ico, _) = k.create_subkey("DefaultIcon").map_err(|e| e.to_string())?;
                let icon = icon_value(icons, ext).unwrap_or_else(|| format!("\"{}\",0", exe));
                ico.set_value("", &icon).map_err(|e| e.to_string())?;
                // a picture or a video keeps its thumbnail; Leonote's mark sits small in its corner
                k.set_value("TypeOverlay", &format!("\"{}\",0", exe)).map_err(|e| e.to_string())?;
                let (cmd, _) = k.create_subkey("shell\\open\\command").map_err(|e| e.to_string())?;
                cmd.set_value("", &format!("\"{}\" \"%1\"", exe)).map_err(|e| e.to_string())?;
                // a type no app has claimed (no default, nothing picked) opens here, with its icon
                if unclaimed(ext) {
                    let (e, _) = classes.create_subkey(format!(".{}", ext)).map_err(|e| e.to_string())?;
                    e.set_value("", &id).map_err(|e| e.to_string())?;
                }
                // listed under the extension, never taking over its default:
                // the user picks Leonote in Explorer's "Open with" once
                let (e, _) = classes.create_subkey(format!(".{}\\OpenWithProgids", ext)).map_err(|e| e.to_string())?;
                e.set_value(&id, &"").map_err(|e| e.to_string())?;
            } else {
                if let Ok(e) = classes.open_subkey_with_flags(format!(".{}\\OpenWithProgids", ext), KEY_READ | KEY_WRITE) {
                    let _ = e.delete_value(&id);
                }
                // the default this switch took for an unclaimed type goes back
                if let Ok(e) = classes.open_subkey_with_flags(format!(".{}", ext), KEY_READ | KEY_WRITE) {
                    if e.get_value::<String, _>("").map(|v| v == id).unwrap_or(false) {
                        let _ = e.delete_value("");
                    }
                }
                let _ = classes.delete_subkey_all(&id);
            }
        }
        shell_changed();
        Ok(())
    }

    /// On when every extension asked about is registered to this exe.
    pub fn get(exts: &[String]) -> bool {
        let exts = clean_exts(exts);
        let Ok(exe) = exe() else { return false };
        let Ok(classes) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Classes") else { return false };
        !exts.is_empty()
            && exts.iter().all(|ext| {
                classes
                    .open_subkey(format!("{}\\shell\\open\\command", prog_id(ext)))
                    .and_then(|k| k.get_value::<String, _>(""))
                    .map(|v| v.to_lowercase().contains(&exe.to_lowercase()))
                    .unwrap_or(false)
            })
    }
}

#[cfg(not(windows))]
mod assoc {
    pub fn set(_exts: &[String], _enable: bool, _icons: &std::path::Path) -> Result<(), String> {
        Err("file associations are only set up on Windows".into())
    }
    pub fn refresh_icons(_dir: &std::path::Path) {}
    pub fn get(_exts: &[String]) -> bool {
        false
    }
}

/// Opt-in from Settings, never automatic, and the same switch turns it off.
#[tauri::command]
pub async fn associate_files(exts: Vec<String>, enable: bool, state: tauri::State<'_, crate::AppState>) -> Result<bool, String> {
    assoc::set(&exts, enable, &icons_dir(&state.paths.settings))?;
    Ok(assoc::get(&exts))
}

/// Where the type icons are written: ~/.leonote/icons, beside the settings.
pub fn icons_dir(settings: &Path) -> std::path::PathBuf {
    settings.parent().unwrap_or(Path::new(".")).join("icons")
}

/// At start, off the main thread: file types that open in Leonote show their type's icon.
pub fn refresh_type_icons(settings: &Path) {
    assoc::refresh_icons(&icons_dir(settings));
}

#[tauri::command]
pub async fn associate_state(exts: Vec<String>) -> Result<bool, String> {
    Ok(assoc::get(&exts))
}


/// The entries of a dot-folder in the vault (.leonote, .trash, .obsidian…), for
/// the tree's "hidden folders" listing. Read only: the tree shows them, opens
/// files as outside files, and never writes or deletes here. `rel` is the
/// vault-relative path; it must start with a dot segment and hold no "..".
#[tauri::command]
pub async fn hidden_list(rel: String, state: tauri::State<'_, crate::AppState>) -> Result<Vec<serde_json::Value>, String> {
    let rel = rel.trim().trim_matches('/').replace('\\', "/");
    if rel.split('/').any(|s| s == "..") || rel.contains(':') {
        return Err("not a vault path".into());
    }
    let root = &state.paths.vault;
    let dir = if rel.is_empty() { root.clone() } else { root.join(&rel) };
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(out) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // at the root only the dot-folders themselves are listed; inside one, everything
        if rel.is_empty() && !(name.starts_with('.') && e.path().is_dir()) { continue; }
        // inside a not-indexed folder: everything, as in a dot-folder
        let m = e.metadata().ok();
        let is_dir = m.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = m.as_ref().map(|m| m.len()).unwrap_or(0);
        let path = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        out.push(serde_json::json!({ "name": name, "path": path, "dir": is_dir, "size": size, "abs": e.path().to_string_lossy() }));
    }
    // at the root, the folders kept out of the index too - by their whole path, as they lie deeper
    if rel.is_empty() {
        for f in crate::vault::no_index() {
            let p = root.join(&f);
            if p.is_dir() { out.push(serde_json::json!({ "name": f, "path": f, "dir": true, "size": 0, "abs": p.to_string_lossy() })); }
        }
    }
    out.sort_by(|a, b| b["dir"].as_bool().cmp(&a["dir"].as_bool()).then_with(|| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase())));
    Ok(out)
}

/// The notes in the folders kept out of the index that hold every word of `query` (in their name or their
/// text), for the search's "the not-indexed folders too" - read now, from the disk: { name, path, abs, snippet }.
#[tauri::command]
pub async fn unindexed_find(query: String, limit: usize, state: tauri::State<'_, crate::AppState>) -> Result<Vec<serde_json::Value>, String> {
    let root = state.paths.vault.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(find_unindexed(&root, &query, limit.clamp(1, 200)))).await.map_err(|e| e.to_string())?
}
/// The notes in the not-indexed folders, by their paths only - nothing in them is read: links to them still
/// lead somewhere (and a link is never taken for a note that is gone).
#[tauri::command]
pub async fn unindexed_names(state: tauri::State<'_, crate::AppState>) -> Result<Vec<String>, String> {
    let root = state.paths.vault.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(names_unindexed(&root, &crate::vault::no_index()))).await.map_err(|e| e.to_string())?
}
pub fn names_unindexed(root: &Path, folders: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = folders.iter().map(|f| (root.join(f), f.clone())).collect();
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            // ponytail: 200 000 names at most - far past a real folder of notes
            if out.len() >= 200_000 { return out; }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') { continue; }
            let path = format!("{}/{}", rel, name);
            // file_type() does not follow a link: nothing outside the vault, no loop
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() { stack.push((e.path(), path)); } else if crate::vault::is_note(&name) { out.push(path); }
        }
    }
    out
}

pub fn find_unindexed(root: &Path, query: &str, limit: usize) -> Vec<serde_json::Value> {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    let mut out = Vec::new();
    if words.is_empty() { return out; }
    let mut stack: Vec<(PathBuf, String)> = crate::vault::no_index().into_iter().map(|f| (root.join(&f), f)).collect();
    // ponytail: 20 000 files and 512 MB read at most per search - a huge folder stays answerable; ask more precisely past that
    let (mut seen, mut read) = (0usize, 0u64);
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 20_000 || out.len() >= limit || read > 512 << 20 { return out; }
            let name = e.file_name().to_string_lossy().into_owned();
            let path = format!("{}/{}", rel, name);
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() { stack.push((e.path(), path)); continue; }
            if !crate::vault::is_note(&name) && !name.to_lowercase().ends_with(".txt") { continue; }
            let low_name = name.to_lowercase();
            let mut snippet = String::new();
            let hit = if words.iter().all(|w| low_name.contains(w.as_str())) { true } else {
                read += m.len();
                let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
                let low = text.to_lowercase();
                if !words.iter().all(|w| low.contains(w.as_str())) { false } else {
                    // a few words either side of the first one found
                    if let Some(i) = low.find(words[0].as_str()) {
                        let a = text.char_indices().map(|(k, _)| k).filter(|&k| k <= i).rev().nth(60).unwrap_or(0);
                        let b = text.char_indices().map(|(k, _)| k).find(|&k| k >= i + words[0].len() + 80).unwrap_or(text.len());
                        snippet = text[a..b].split_whitespace().collect::<Vec<_>>().join(" ");
                    }
                    true
                }
            };
            if hit { out.push(serde_json::json!({ "name": name, "path": path, "abs": e.path().to_string_lossy(), "snippet": snippet })); }
        }
    }
    out
}

/// The list of folders kept out of the index, as the settings now say (the page saves the setting itself).
#[tauri::command]
pub fn no_index_set(list: Vec<String>) { crate::vault::set_no_index(&list); }


/// Names inside the vault's dot-folders (.leonote, .trash, .obsidian) holding every word of `query`,
/// for the tree's search when it shows them: the same rows as `hidden_list`, at most `limit`.
#[tauri::command]
pub async fn hidden_find(query: String, limit: usize, state: tauri::State<'_, crate::AppState>) -> Result<Vec<serde_json::Value>, String> {
    let root = state.paths.vault.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(find_in_dot_folders(&root, &query, limit.clamp(1, 200)))).await.map_err(|e| e.to_string())?
}

pub fn find_in_dot_folders(root: &std::path::Path, query: &str, limit: usize) -> Vec<serde_json::Value> {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    let mut out = Vec::new();
    if words.is_empty() { return out; }
    let mut stack: Vec<(PathBuf, String)> = std::fs::read_dir(root).into_iter().flatten().flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with('.') && e.path().is_dir())
        .map(|e| (e.path(), e.file_name().to_string_lossy().into_owned())).collect();
    // ponytail: 60 000 entries looked at, at most - a trash or a previews folder of any size stays quick
    let mut seen = 0usize;
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 60_000 || out.len() >= limit { return out; }
            let name = e.file_name().to_string_lossy().into_owned();
            let path = format!("{}/{}", rel, name);
            let m = e.metadata().ok();
            let is_dir = m.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let low = name.to_lowercase();
            if words.iter().all(|w| low.contains(w.as_str())) {
                out.push(serde_json::json!({ "name": name, "path": path, "dir": is_dir, "size": m.as_ref().map(|m| m.len()).unwrap_or(0), "abs": e.path().to_string_lossy() }));
            }
            if is_dir { stack.push((e.path(), path)); }
        }
    }
    out
}

/// A program by bare name, as a full path: the system's own folders, then PATH. Never the folder Leonote's exe lies
/// in, where Windows itself looks first: the portable exe often sits in Downloads, and a git.exe or cmd.exe a website
/// dropped there would run as Leonote. A name with a folder in it stays as it is; a name found nowhere does not start.
pub(crate) fn program(name: &str) -> PathBuf {
    #[cfg(windows)]
    if Path::new(name).file_name().is_some_and(|f| f == name) {
        let own = std::env::current_exe().and_then(std::fs::canonicalize).ok();
        let root = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
        let sys = root.join("System32");
        let path = std::env::var_os("PATH").unwrap_or_default();
        let dirs = [sys.clone(), root, sys.join("WindowsPowerShell").join("v1.0")].into_iter().chain(std::env::split_paths(&path));
        return program_in(name, own.as_deref().and_then(Path::parent), dirs).unwrap_or_else(|| sys.join(name));
    }
    PathBuf::from(name)
}

#[cfg(windows)]
pub(crate) fn program_in(name: &str, own: Option<&Path>, dirs: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    // no extension means .exe, as Windows and std take it
    let file = if name.contains('.') { name.to_string() } else { format!("{name}.exe") };
    // the link itself, not what it leads to: winget is a Store app alias, which cannot be followed
    dirs.filter(|d| d.is_absolute() && std::fs::canonicalize(d).ok().as_deref() != own).map(|d| d.join(&file)).find(|p| std::fs::symlink_metadata(p).is_ok())
}

/// Does this program run (it answers its version flag)? Most, winget too,
/// take `--version`, ffmpeg `-version`.
fn runs(exe: &std::ffi::OsStr, flag: &str) -> bool {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(flag).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Where a tool is: the file the user chose, the name on PATH, or winget's
/// link folder - winget puts portable tools (ffmpeg) there, and the
/// PATH this process has is the one from before an install made in the meantime.
pub(crate) fn tool_path(name: &str, custom: Option<&str>) -> Option<PathBuf> {
    if name == "whisper" { return whisper_paths().map(|(exe, _)| exe); }
    let flag = if name == "ffmpeg" { "-version" } else { "--version" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(c) = custom.map(str::trim).filter(|c| !c.is_empty()) { candidates.push(program(c)); }
    candidates.push(program(name));
    // what Leonote fetched: in this computer's tools\<program>, or (earlier builds) right in the tools folder
    if let Some(d) = module_dir(name) { candidates.push(d.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))); }
    if let Some(d) = own_tools_dir() { candidates.push(d.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))); }
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links").join(format!("{name}.exe")));
    }
    candidates.extend(PKG_BINS.iter().map(|b| Path::new(b).join(name)));
    candidates.into_iter().find(|p| runs(p.as_os_str(), flag))
}

/// Whisper's program and model, when both are there: the model in tools\Whisper, the program beside it
/// (Windows) or Homebrew's whisper-cpp (macOS, Linux).
pub fn whisper_paths() -> Option<(PathBuf, PathBuf)> {
    let d = module_dir("whisper")?;
    let model = d.join("ggml-base.bin");
    if !model.exists() { return None; }
    let exe = ["whisper-cli.exe", "main.exe"].iter().map(|n| d.join(n)).chain(PKG_BINS.iter().map(|b| Path::new(b).join("whisper-cli"))).find(|p| p.exists())?;
    Some((exe, model))
}
// its address at one revision, with the sha256 Hugging Face gives for the file
pub(crate) const WHISPER_MODEL: (&str, &str) = ("https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin", "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe");

/// A file's SHA-256 in hex, written out here so every system checks alike: no crate carries it for us, and Homebrew's
/// Whisper still fetches its model through this on macOS and Linux.
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut tail = data[data.len() - data.len() % 64..].to_vec();
    tail.push(0x80);
    while tail.len() % 64 != 56 { tail.push(0); }
    tail.extend_from_slice(&(data.len() as u64 * 8).to_be_bytes());
    for block in data.chunks_exact(64).chain(tail.chunks_exact(64)) {
        let mut w = [0u32; 64];
        for (i, b) in block.chunks_exact(4).enumerate() { w[i] = u32::from_be_bytes([b[0], b[1], b[2], b[3]]); }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            v = [t1.wrapping_add(s0.wrapping_add(maj)), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for (a, b) in h.iter_mut().zip(v) { *a = a.wrapping_add(b); }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}
/// A download against the SHA-256 its publisher gave: a file that differs is refused, before anything is written.
pub(crate) fn check_sha256(data: &[u8], want: &str) -> Result<(), String> {
    if sha256_hex(data).eq_ignore_ascii_case(want.trim()) { return Ok(()); }
    Err("the download does not match its published fingerprint, so it was not installed. Nothing was changed. Try again later".into())
}

/* Optional modules (ffmpeg, Whisper) live on this computer only, in
   %LOCALAPPDATA%\LeoNote\tools\<program>. Earlier builds put them in the vault's Utilities folder - but a vault is
   synced, shared and written by agents, so a program there may not be the one Leonote put there: those are never
   run any more. A tool is fetched again on a click; only Whisper's model (data, not a program, 142 MB) is
   carried over from the old folder. */
static OLD_MODULES: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
/// Remembers where earlier builds kept the modules (the vault's Utilities), only to carry Whisper's model over.
pub fn set_modules_root(vault: &Path) { let _ = OLD_MODULES.set(vault.join("Utilities")); }
fn module_name(tool: &str) -> &str { match tool { "ffmpeg" | "ffprobe" => "FFmpeg", "whisper" => "Whisper", other => extra_tool(other).map_or(other, |t| t.folder) } }
/// The program's own folder on this computer: tools\FFmpeg, tools\Whisper…
pub fn module_dir(tool: &str) -> Option<PathBuf> {
    own_tools_dir().map(|d| d.join(module_name(tool)))
}
/// A module's folder is marked, so backups leave it out (it is fetched again on a click, and big).
pub const MODULE_MARK: &str = ".leonote-module";


/// SRT text as [{ start, end, text }] in seconds.
pub fn parse_srt(s: &str) -> Vec<Value> {
    let t = |x: &str| -> Option<f64> { let (hms, ms) = x.trim().split_once(',')?; let p: Vec<f64> = hms.split(':').filter_map(|v| v.parse().ok()).collect(); if p.len() != 3 { return None; } Some(p[0] * 3600.0 + p[1] * 60.0 + p[2] + ms.parse::<f64>().ok()? / 1000.0) };
    let mut out = Vec::new();
    for block in s.replace("\r\n", "\n").split("\n\n") {
        let mut lines = block.lines().filter(|l| !l.trim().is_empty());
        let first = lines.next().unwrap_or("");
        let times = if first.contains("-->") { first } else { lines.next().unwrap_or("") };
        let Some((a, b)) = times.split_once("-->") else { continue };
        let (Some(a), Some(b)) = (t(a), t(b)) else { continue };
        let text: Vec<&str> = lines.collect();
        let text = text.join(" ").trim().to_string();
        if !text.is_empty() { out.push(serde_json::json!({ "start": a, "end": b, "text": text })); }
    }
    out
}

/// Captions from what is said in a vault file's sound, from `from` seconds for `len` seconds: its sound taken out
/// with ffmpeg (16 kHz, mono, as Whisper wants it), heard by Whisper on this computer, and handed back as
/// [{ start, end, text }] counted from `from`. Nothing leaves the computer; the temporary files are removed.
#[tauri::command]
pub async fn captions_make(rel: String, from: f64, len: f64, lang: Option<String>, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let rel = rel.trim().trim_matches('/').replace('\\', "/");
    if rel.split('/').any(|s| s == "..") || rel.contains(':') || PathBuf::from(&rel).is_absolute() { return Err("not a vault file".into()); }
    // inside the vault, whatever the path says (a link out of it included)
    let base = state.paths.vault.canonicalize().map_err(|e| e.to_string())?;
    let src = state.paths.vault.join(&rel).canonicalize().map_err(|_| "not a vault file".to_string())?;
    if !src.starts_with(&base) { return Err("not a vault file".into()); }
    tauri::async_runtime::spawn_blocking(move || transcribe(&src, Some((from, len)), lang.as_deref(), false).map(Value::Array)).await.map_err(|e| e.to_string())?
}

/// A program started with no console window flashing up.
pub fn hidden(c: &mut std::process::Command) { #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); } }

/// What is said in a file's sound - all of it, or `span` (from, len) seconds of it: taken out with ffmpeg
/// (16 kHz, mono, as Whisper wants it) and heard by Whisper on this computer, as [{ start, end, text }]
/// counted from where it begins. `words`: one entry per word instead of per sentence. The temporary files go.
pub fn transcribe(src: &std::path::Path, span: Option<(f64, f64)>, lang: Option<&str>, words: bool) -> Result<Vec<Value>, String> {
    let ff = tool_path("ffmpeg", None).ok_or("ffmpeg is needed to take the sound out")?;
    let (exe, model) = whisper_paths().ok_or("Whisper is not installed")?;
    let tmp = std::env::temp_dir().join(format!("leonote-cap-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let wav = tmp.join("a.wav");
    let mut c = std::process::Command::new(&ff);
    c.args(["-y", "-loglevel", "error"]);
    if let Some((from, len)) = span { c.args(["-ss", &format!("{from:.3}"), "-t", &format!("{len:.3}")]); }
    c.arg("-i").arg(src).args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]).arg(&wav);
    hidden(&mut c);
    let ok = c.status().map(|s| s.success()).unwrap_or(false);
    let r = (|| {
        if !ok { return Err("this clip has no sound ffmpeg could read".to_string()); }
        let out = tmp.join("cap");
        let mut w = std::process::Command::new(&exe);
        w.arg("-m").arg(&model).arg("-f").arg(&wav).args(["-osrt", "-np", "-l", lang.filter(|l| !l.is_empty()).unwrap_or("auto"), "-of"]).arg(&out);
        // a word at a time: segments one word long, split at words rather than tokens
        if words { w.args(["-ml", "1", "-sow"]); }
        if let Some(d) = exe.parent() { w.current_dir(d); }
        hidden(&mut w);
        let o = w.output().map_err(|e| format!("Whisper did not start: {e}"))?;
        if !o.status.success() { return Err(format!("Whisper could not do it: {}", String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or(""))); }
        let srt = std::fs::read_to_string(out.with_extension("srt")).map_err(|_| "Whisper wrote no captions".to_string())?;
        Ok(parse_srt(&srt))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    r
}

/// Where earlier builds kept the tools they fetched: %LOCALAPPDATA%\LeoNote\tools.
pub(crate) fn own_tools_dir() -> Option<PathBuf> {
    // elsewhere (Linux, macOS): beside Leonote's settings, ~/.leonote/tools
    Some(std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("LeoNote").join("tools")).unwrap_or_else(|| crate::store::leonote_dir().join("tools")))
}

/// Where Homebrew and the system put programs (macOS, Linux): a program started from the desktop may have a
/// PATH without them.
#[cfg(not(windows))]
const PKG_BINS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin"];
#[cfg(windows)]
const PKG_BINS: &[&str] = &[];

/// A tool besides the ones named below; there are none now. `source` as in tool_source.
pub struct ExtraTool { pub name: &'static str, pub folder: &'static str, pub winget: &'static str, #[cfg_attr(windows, allow(dead_code))] pub brew: &'static str, pub source: (&'static str, &'static str, &'static str) }
pub(crate) const EXTRA_TOOLS: &[ExtraTool] = &[];
fn extra_tool(name: &str) -> Option<&'static ExtraTool> { EXTRA_TOOLS.iter().find(|t| t.name == name) }

/* A tool comes from a package manager when there is one: winget on Windows, Homebrew on macOS (and Linux).
   It checks what it downloads against a fingerprint kept in its own package list, apart from the project's
   releases, so a swapped file is refused rather than run. When it fails, that is said as it is - never answered
   with a download of Leonote's own, which would undo the check. */

/// The tool installed by winget or Homebrew; None when neither is here (or has it).
fn by_package_manager(name: &str, say: &dyn Fn(&str, u64, u64)) -> Option<Result<(), String>> {
    #[cfg(windows)]
    {
        let id = match name {
            "ffmpeg" => "Gyan.FFmpeg",
            other => extra_tool(other)?.winget,
        };
        let winget = program("winget");
        if !runs(winget.as_os_str(), "--version") { return None; }
        say("winget", 0, 0);
        let mut c = std::process::Command::new(winget);
        c.args(["install", "--id", id, "--exact", "--source", "winget", "--silent", "--disable-interactivity", "--accept-source-agreements", "--accept-package-agreements"]);
        Some(run_installer(c, "winget"))
    }
    #[cfg(not(windows))]
    {
        let formula = match name {
            "ffmpeg" => "ffmpeg",
            "whisper" => "whisper-cpp",
            other => extra_tool(other)?.brew,
        };
        let brew = std::iter::once(PathBuf::from("brew")).chain(PKG_BINS.iter().map(|b| Path::new(b).join("brew"))).find(|p| runs(p.as_os_str(), "--version"))?;
        say("brew", 0, 0);
        let mut c = std::process::Command::new(&brew);
        c.args(["install", formula]);
        if let Some(d) = brew.parent().filter(|d| !d.as_os_str().is_empty()) { c.env("PATH", format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", d.display())); }
        Some(run_installer(c, "Homebrew"))
    }
}
fn run_installer(mut c: std::process::Command, who: &str) -> Result<(), String> {
    hidden(&mut c);
    let o = c.output().map_err(|e| format!("{who} did not start: {e}"))?;
    if o.status.success() { return Ok(()); }
    let last = last_words(&format!("{}\n{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)));
    Err(format!("{who} could not install it{}", if last.is_empty() { String::new() } else { format!(": {last}") }))
}
/// An installer's last line that says something - its progress bars and spinners left out.
pub(crate) fn last_words(out: &str) -> String {
    out.split(['\n', '\r']).map(str::trim).filter(|l| l.chars().filter(|c| c.is_alphabetic()).count() >= 3).last().unwrap_or("").to_string()
}

/// Where each tool comes from when there is no winget: the projects' own releases, each pinned to one version
/// with the SHA-256 GitHub publishes for it (`gh api repos/<owner>/<repo>/releases/tags/<tag>`, the asset's digest).
/// A new version is a change here, made by hand before a release: (address, "exe" or "zip", sha256).
pub fn tool_source(tool: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match tool {
        // gyan.dev's own build, from its GitHub releases: gyan.dev drops old versions, these stay
        "ffmpeg" => Some(("https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip", "zip", "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba")),
        // speech to text, on this computer: whisper.cpp's program, then its base model (both into tools\Whisper)
        // (its newest stable release with a Windows program in it: v1.9.3 and later carry none, only prereleases do)
        "whisper" => Some(("https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip", "zip", "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a")),
        other => extra_tool(other).map(|t| t.source),
    }
}

/// The answer that asks first: no package manager here, so the tool would come straight from this address.
pub const DIRECT: &str = "DIRECT:";

/// Install a tool Leonote uses, on the user's own click, quietly and waited for: winget or Homebrew when it is
/// here (by_package_manager), else on Windows the project's own release fetched into Leonote's tools folder (a
/// zip: only the programs taken out of it); elsewhere the system's package manager is named instead. `tool:progress` events say how it goes. Returns where it is now.
#[tauri::command]
pub async fn tool_install(app: tauri::AppHandle, tool: String, direct: Option<bool>) -> Result<String, String> {
    use tauri::Emitter;
    let name: &'static str = match tool.as_str() {
        "ffmpeg" => "ffmpeg",
        "whisper" => "whisper",
        other => extra_tool(other).ok_or("unknown tool")?.name,
    };
    let (url, kind, sha) = tool_source(name).ok_or("unknown tool")?;
    let say = move |stage: &str, got: u64, total: u64| { let _ = app.emit_to("main", "tool:progress", serde_json::json!({ "tool": tool, "stage": stage, "got": got, "total": total })); };
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        if let Some(p) = tool_path(name, None) { return Ok(p.to_string_lossy().into_owned()); }
        let packaged = match by_package_manager(name, &say) {
            Some(r) => { r?; true }
            // no winget: the project's own release, held to its pinned fingerprint - only once the user has said yes to that
            None if cfg!(windows) => { if direct != Some(true) { return Err(format!("{DIRECT}{url}")); } false }
            None => return Err(format!("Install {name} with your system's package manager - for example `sudo apt install {name}` or `brew install {}` - then try again. It checks what it installs.", if name == "whisper" { "whisper-cpp" } else { name })),
        };
        // winget and Homebrew put the program where tool_path looks; Whisper still needs its model below
        if packaged && name != "whisper" {
            let p = tool_path(name, None).ok_or("it was installed, but Leonote cannot find it yet - restart Leonote")?;
            say("done", 1, 1);
            return Ok(p.to_string_lossy().into_owned());
        }
        // the project's own release, into this computer's tools\<program> - never the vault
        let dir = module_dir(name).ok_or("no folder for modules")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = std::fs::write(dir.join(MODULE_MARK), format!("{name} - fetched by Leonote on a click; delete this folder to remove it. Backups leave it out.\n"));
        let fetch = |u: &str| -> Result<Vec<u8>, String> {
            // a read timeout is the silence between two reads, not the whole download: a stalled server gives up
            // after a minute, a slow line still finishes
            let resp = ureq::AgentBuilder::new().https_only(true).timeout_connect(std::time::Duration::from_secs(20)).timeout_read(std::time::Duration::from_secs(60)).build().get(u).call().map_err(|e| format!("could not download it: {e}"))?;
            let total: u64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
            // the server's Content-Length is a hint, not a size to reserve: a huge one would end the app
            let mut body = Vec::with_capacity(total.min(256 << 20) as usize);
            let mut r = resp.into_reader();
            let mut buf = vec![0u8; 256 * 1024];
            let mut last = 0u64;
            loop {
                let n = std::io::Read::read(&mut r, &mut buf).map_err(|e| e.to_string())?;
                if n == 0 { break; }
                body.extend_from_slice(&buf[..n]);
                if body.len() as u64 - last > 2 << 20 { last = body.len() as u64; say("download", last, total); }
            }
            Ok(body)
        };
        if !packaged {
            let body = fetch(url)?;
            check_sha256(&body, sha)?;
            say("unpack", body.len() as u64, body.len() as u64);
            let exe = std::env::consts::EXE_SUFFIX;
            if kind == "exe" {
                let p = dir.join(format!("{name}{exe}"));
                let part = dir.join(format!("{name}.part"));
                std::fs::write(&part, &body).map_err(|e| e.to_string())?;
                std::fs::rename(&part, &p).map_err(|e| e.to_string())?;
            } else {
                let mut z = zip::ZipArchive::new(std::io::Cursor::new(body)).map_err(|e| e.to_string())?;
                let mut got = 0;
                for i in 0..z.len() {
                    let mut f = z.by_index(i).map_err(|e| e.to_string())?;
                    let fname = crate::backup::entry_name(&f).replace('\\', "/");
                    let leaf = fname.rsplit('/').next().unwrap_or("").to_string();
                    let low = leaf.to_ascii_lowercase();
                    let wanted = if extra_tool(name).is_some() { leaf == format!("{name}.exe") } else if name == "whisper" { low.ends_with(".dll") || low == "whisper-cli.exe" || low == "main.exe" } else { fname.contains("/bin/") && ["ffmpeg.exe", "ffprobe.exe"].contains(&leaf.as_str()) };
                    if !wanted { continue; }
                    let mut out = Vec::new();
                    std::io::Read::read_to_end(&mut f, &mut out).map_err(|e| e.to_string())?;
                    let part = dir.join(format!("{leaf}.part"));
                    std::fs::write(&part, &out).map_err(|e| e.to_string())?;
                    std::fs::rename(&part, dir.join(&leaf)).map_err(|e| e.to_string())?;
                    got += 1;
                }
                if got == 0 { return Err(format!("the download had no {name} in it")); }
            }
        }
        // Whisper also needs its model: the base one, good for most languages, 142 MB - carried over from the old
        // folder in the vault when an earlier build fetched it there (it is data, not a program), else fetched
        if name == "whisper" && !dir.join("ggml-base.bin").exists() {
            // (only the file itself: a vault is synced and written by others, and a different one is fetched anew)
            if let Some(old) = OLD_MODULES.get().map(|u| u.join("Whisper").join("ggml-base.bin")).filter(|p| std::fs::read(p).is_ok_and(|b| check_sha256(&b, WHISPER_MODEL.1).is_ok())) {
                let _ = std::fs::copy(&old, dir.join("ggml-base.bin"));
            }
        }
        if name == "whisper" && !dir.join("ggml-base.bin").exists() {
            say("model", 0, 0);
            let m = fetch(WHISPER_MODEL.0)?;
            check_sha256(&m, WHISPER_MODEL.1)?;
            let part = dir.join("ggml-base.bin.part");
            std::fs::write(&part, &m).map_err(|e| e.to_string())?;
            std::fs::rename(&part, dir.join("ggml-base.bin")).map_err(|e| e.to_string())?;
        }
        let p = tool_path(name, None).ok_or("it was fetched but does not run")?;
        say("done", 1, 1);
        Ok(p.to_string_lossy().into_owned())
    }).await.map_err(|e| e.to_string())?
}

/// Install a tool with winget, in a console window of its own so the
/// user sees what it does. Only ever on the user's own click.
#[tauri::command]
pub async fn online_install(tool: String) -> Result<(), String> {
    let id = match tool.as_str() {
        "ffmpeg" => "Gyan.FFmpeg",
        other => extra_tool(other).ok_or("unknown tool")?.winget,
    };
    #[cfg(windows)]
    {
        if !runs(program("winget").as_os_str(), "--version") {
            return Err("winget is not on this computer - it comes with \"App Installer\" from the Microsoft Store".into());
        }
        let line = format!("winget install --id {id} -e --accept-source-agreements --accept-package-agreements & echo. & echo You can close this window. & pause");
        std::process::Command::new(program("cmd")).args(["/c", "start", &format!("Installing {tool}"), "cmd", "/c", &line]).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(format!("install {id} with your package manager"))
}

/// Which of the optional programs are on this computer, and whether winget could install them.
pub fn tools_found() -> Value {
    serde_json::json!({
        "ffmpeg": tool_path("ffmpeg", None).map(|p| p.to_string_lossy().into_owned()),
        "whisper": whisper_paths().map(|(p, _)| p.to_string_lossy().into_owned()),
        "winget": true, // the installer tries winget and falls back to the project's release: never a reason not to offer it
    })
}
#[tauri::command]
pub async fn online_tools() -> Value {
    tauri::async_runtime::spawn_blocking(tools_found).await.unwrap_or_default()
}

/// A file opened from outside the vault, renamed where it lies (the name only: it stays in its folder).
#[tauri::command]
pub async fn external_rename(app: tauri::AppHandle, path: String, name: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    crate::grant::allow(&app, &p, "rename", false)?; // asked first: looking at a network path already reaches it
    if !p.is_file() { return Err("That file is not there any more".into()); }
    let to = crate::outpost::rename_in_place(&p, &name)?;
    mark_parked_edited(&to);
    Ok(to.to_string_lossy().into_owned())
}
