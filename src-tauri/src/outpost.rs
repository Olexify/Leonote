//! Outposts: folders that are NOT part of the vault but are hooked up next to
//! it - a music drive, a videos folder, a documents archive. They are browsed
//! and managed where they lie: nothing is copied into the vault, nothing is
//! indexed to disk, nothing is watched. Backups and (one day) sync leave them
//! out unless the user turns that on for one of them.
//!
//! Every path here is an absolute OS path, like external.rs and library.rs.
//! The list itself lives in the frontend's settings (`outposts: [{ path }]`);
//! what this module keeps is the runtime registry of their roots, because
//! everything that changes the disk - rename, new folder, Recycle Bin - is
//! refused for a path that is not inside one of them.

use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, State};

use crate::{lock, AppState};

/// One folder's listing never grows past this; the rest is reported as capped.
pub const MAX_LIST: usize = 5_000;
/// A name search walks at most this many entries, this deep, for this long.
pub const MAX_FIND_ENTRIES: usize = 400_000;
pub const MAX_FIND_DEPTH: usize = 14;
pub const MAX_FIND_MS: u128 = 2_500;

pub(crate) static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// `\\?\E:\Music` and `E:/Music/` are the same place as `E:\Music`.
pub fn plain(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\UNC\").map(|r| format!(r"\\{}", r)).unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
    let s = if cfg!(windows) { s.replace('/', "\\") } else { s };
    let trimmed = s.trim_end_matches(['\\', '/']);
    // a drive root keeps its slash: "E:" alone means "the current folder on E:"
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        return PathBuf::from(format!("{}\\", trimmed));
    }
    PathBuf::from(if trimmed.is_empty() { s.as_str() } else { trimmed })
}

fn key(p: &Path) -> String {
    let s = plain(p).to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// `p` is `dir` or lies under it - by whole segments, so `E:\Music2` is not
/// inside `E:\Music`. Anything with a `..` in it is inside nothing.
pub fn is_under(p: &Path, dir: &Path) -> bool {
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let (p, d) = (key(p), key(dir));
    let d = d.trim_end_matches(['\\', '/']);
    p == d || (p.starts_with(d) && p[d.len()..].starts_with(['\\', '/']))
}

/// The registered root `p` belongs to, if any.
pub fn root_of(roots: &[PathBuf], p: &Path) -> Option<PathBuf> {
    if !p.is_absolute() {
        return None;
    }
    roots.iter().filter(|r| is_under(p, r)).max_by_key(|r| r.as_os_str().len()).cloned()
}

/// Like `root_of`, but the real location counts too: a junction inside an
/// outpost that points somewhere else is not inside the outpost.
pub(crate) fn guard(p: &Path) -> Result<PathBuf, String> {
    let roots = lock(&ROOTS).clone();
    let root = root_of(&roots, p).ok_or_else(|| format!("{} is not inside an outpost", p.display()))?;
    let real = std::fs::canonicalize(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    let real_root = std::fs::canonicalize(&root).map_err(|e| format!("{}: {}", root.display(), e))?;
    if !is_under(&real, &real_root) {
        return Err(format!("{} leads outside its outpost", p.display()));
    }
    Ok(root)
}

/// `guard`, for a change: the outpost itself must be one the user handed over (an older one is asked about once),
/// so an outpost that reached app.json some other way is not written into unasked.
pub(crate) fn guard_write(app: &AppHandle, p: &Path) -> Result<PathBuf, String> {
    let root = guard(p)?;
    crate::grant::allow(app, &root, "change files in this linked folder", true)?;
    Ok(root)
}

pub fn saved_paths(settings: &Value) -> Vec<String> {
    settings
        .get("outposts")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.get("path").and_then(|p| p.as_str()).map(String::from)).collect())
        .unwrap_or_default()
}

fn register(app: &AppHandle, dir: &Path) {
    let dir = plain(dir);
    crate::library::allow(app, &dir);
    let mut roots = lock(&ROOTS);
    if !roots.iter().any(|r| key(r) == key(&dir)) {
        roots.push(dir);
    }
}

/// Every remembered outpost is registered on startup, there or not: a drive
/// that is unplugged now may be back before the app is restarted.
pub fn allow_saved(app: &AppHandle, settings: &Value) {
    for dir in saved_paths(settings) {
        if Path::new(&dir).is_absolute() {
            register(app, Path::new(&dir));
        }
    }
}

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// A music drive is full of formats the vault never lists.
pub fn kind_of(name: &str) -> &'static str {
    match crate::external::kind_of(name) {
        "other" => match name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
            Some("flac" | "aac" | "opus" | "m4b" | "wma" | "aiff" | "mkv" | "mov" | "avi" | "m4v") => "media",
            _ => "other",
        },
        k => k,
    }
}

/// System litter nobody wants to see in a tree.
fn skipped(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$') || name.eq_ignore_ascii_case("desktop.ini") || name.eq_ignore_ascii_case("thumbs.db")
        || name.eq_ignore_ascii_case("System Volume Information")
}

/// What an outpost may and may not be: a real folder, and neither the vault,
/// nor inside it, nor around it - those files are in the tree already.
pub fn check_new(dir: &Path, vault: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err("an outpost needs a full path".into());
    }
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let v = std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
    let d = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if is_under(&d, &v) {
        return Err("that folder is already in your vault".into());
    }
    if is_under(&v, &d) {
        return Err("that folder contains your vault - pick the folders next to it instead".into());
    }
    Ok(())
}

/// One folder, one level: folders first, then files, by name. Nothing is
/// read but names, sizes and times.
pub fn list_dir(dir: &Path) -> Result<Value, String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let mut folders: Vec<Value> = Vec::new();
    let mut files: Vec<Value> = Vec::new();
    let mut capped = false;
    for entry in rd.flatten() {
        if folders.len() + files.len() >= MAX_LIST {
            capped = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if skipped(&name) {
            continue;
        }
        // metadata() follows a junction, so a linked folder still lists as one
        let Ok(md) = std::fs::metadata(entry.path()) else { continue };
        let path = entry.path().to_string_lossy().into_owned();
        if md.is_dir() {
            folders.push(json!({ "path": path, "name": name, "mtime": mtime_ms(&md) }));
        } else {
            files.push(json!({ "path": path, "name": name, "size": md.len(), "mtime": mtime_ms(&md), "kind": kind_of(&name) }));
        }
    }
    Ok(json!({ "path": dir.to_string_lossy(), "folders": folders, "files": files, "capped": capped }))
}

/// Every word of the query is in the name, in any order, any case.
pub fn name_matches(words: &[String], name: &str) -> bool {
    let low = name.to_lowercase();
    words.iter().all(|w| low.contains(w.as_str()))
}

pub struct Found {
    pub hits: Vec<Value>,
    pub scanned: usize,
    pub partial: bool,
}

/// Names under `roots` that match `query`. A walk, not an index: outposts can
/// be huge and are searched rarely, so nothing about them is kept in memory
/// or on disk. Bounded by entries, depth, time and `limit`.
pub fn find(roots: &[PathBuf], query: &str, limit: usize, budget_ms: u128) -> Found {
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    let mut out = Found { hits: Vec::new(), scanned: 0, partial: false };
    if words.is_empty() {
        return out;
    }
    let t0 = Instant::now();
    'roots: for root in roots {
        let mut stack: Vec<(PathBuf, usize)> = vec![(root.clone(), 0)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                out.scanned += 1;
                if out.scanned >= MAX_FIND_ENTRIES || (out.scanned & 0x3FF == 0 && t0.elapsed().as_millis() > budget_ms) {
                    out.partial = true;
                    break 'roots;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if skipped(&name) {
                    continue;
                }
                let Ok(ft) = entry.file_type() else { continue };
                let is_dir = ft.is_dir();
                if is_dir && !ft.is_symlink() && depth + 1 < MAX_FIND_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
                if !name_matches(&words, &name) {
                    continue;
                }
                let md = entry.metadata().ok();
                out.hits.push(json!({
                    "path": entry.path().to_string_lossy(),
                    "name": name,
                    "dir": dir.to_string_lossy(),
                    "root": root.to_string_lossy(),
                    "isDir": is_dir,
                    "size": md.as_ref().map(|m| m.len()).unwrap_or(0),
                    "mtime": md.as_ref().map(mtime_ms).unwrap_or(0),
                    "kind": if is_dir { "folder" } else { kind_of(&name) },
                }));
                if out.hits.len() >= limit {
                    out.partial = true;
                    break 'roots;
                }
            }
        }
    }
    out
}

/// The notes and text files under `roots`, newest first, for a search of what
/// is written in them. Only the list: the caller reads the few it wants. The
/// same bounds as `find`, and nothing bigger than `max_size` - a log of half a
/// gigabyte is not something to read into a search box.
pub fn texts(roots: &[PathBuf], limit: usize, max_size: u64, budget_ms: u128) -> Found {
    let mut out = Found { hits: Vec::new(), scanned: 0, partial: false };
    let mut all: Vec<(u64, Value)> = Vec::new();
    let t0 = Instant::now();
    'roots: for root in roots {
        let mut stack: Vec<(PathBuf, usize)> = vec![(root.clone(), 0)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                out.scanned += 1;
                if out.scanned >= MAX_FIND_ENTRIES || (out.scanned & 0x3FF == 0 && t0.elapsed().as_millis() > budget_ms) {
                    out.partial = true;
                    break 'roots;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if skipped(&name) {
                    continue;
                }
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_dir() {
                    if !ft.is_symlink() && depth + 1 < MAX_FIND_DEPTH {
                        stack.push((entry.path(), depth + 1));
                    }
                    continue;
                }
                if !crate::external::can_edit(&name) {
                    continue;
                }
                let Ok(md) = entry.metadata() else { continue };
                if md.len() == 0 || md.len() > max_size {
                    continue;
                }
                let mt = mtime_ms(&md);
                all.push((mt, json!({
                    "path": entry.path().to_string_lossy(),
                    "name": name,
                    "root": root.to_string_lossy(),
                    "size": md.len(),
                    "mtime": mt,
                })));
            }
        }
    }
    all.sort_by(|a, b| b.0.cmp(&a.0));
    if all.len() > limit {
        out.partial = true;
        all.truncate(limit);
    }
    out.hits = all.into_iter().map(|(_, v)| v).collect();
    out
}

/// A name a person typed, made safe for the disk: no separators, nothing
/// Windows forbids, not a reserved device name.
pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("a name is needed".into());
    }
    if n.chars().any(|c| (c as u32) < 32 || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')) {
        return Err("a name cannot contain  < > : \" / \\ | ? *".into());
    }
    let n = n.trim_end_matches(['.', ' ']);
    if n.is_empty() || n == "." || n == ".." {
        return Err("that name is not allowed".into());
    }
    if crate::vault::is_device_name(n.split('.').next().unwrap_or("")) {
        return Err(format!("{} is a name Windows keeps for itself", n));
    }
    Ok(n.to_string())
}

/// Rename in place. Never over something that is already there.
pub fn rename_in_place(path: &Path, name: &str) -> Result<PathBuf, String> {
    let name = clean_name(name)?;
    let parent = path.parent().ok_or("nothing to rename")?;
    let to = parent.join(&name);
    // a change of case only is still a rename on Windows
    let same = key(&to) == key(path);
    if to.exists() && !same {
        return Err(format!("{} is already there", name));
    }
    std::fs::rename(path, &to).map_err(|e| format!("rename {}: {}", name_of(path), e))?;
    Ok(to)
}

#[cfg(windows)]
pub(crate) fn recycle(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW};
    // the list is NUL-separated and ends with a second NUL
    let mut from: Vec<u16> = Vec::new();
    for p in paths {
        from.extend(plain(p).as_os_str().encode_wide());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        // FOF_ALLOWUNDO is the whole point: to the Recycle Bin, never gone for good. Where there is no bin
        // (a USB stick, a share) it would destroy the file: FOF_WANTNUKEWARNING has Windows ask first
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0 | FOF_WANTNUKEWARNING.0) as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("Windows could not move it to the Recycle Bin (code {})", code));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("moving to the Recycle Bin was cancelled".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn recycle(_paths: &[PathBuf]) -> Result<(), String> {
    Err("the Recycle Bin is only wired up on Windows - delete it in your file manager".into())
}

/* ── commands ───────────────────────────────────────────────────────────── */

/// Hook a folder up. Returns the path as it will be remembered.
#[tauri::command]
pub async fn outpost_add(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Value, String> {
    let dir = plain(Path::new(path.trim()));
    check_new(&dir, &state.paths.vault)?;
    // a folder picked in the dialog is the user's; any other is asked about - an outpost can be written into
    crate::grant::allow(&app, &dir, "link this folder to Leonote, to read and change the files in it", true)?;
    register(&app, &dir);
    Ok(json!({ "path": dir.to_string_lossy(), "name": name_of(&dir) }))
}

/// Unhook it. Nothing on the disk changes.
#[tauri::command]
pub async fn outpost_forget(path: String) -> Result<(), String> {
    let k = key(Path::new(&path));
    lock(&ROOTS).retain(|r| key(r) != k);
    Ok(())
}

#[tauri::command]
pub async fn outpost_list(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    let roots = lock(&ROOTS).clone();
    if root_of(&roots, &p).is_none() {
        return Err(format!("{} is not inside an outpost", path));
    }
    list_dir(&p)
}

/// Names only, across every outpost (or the ones in `roots`).
#[tauri::command]
pub async fn outpost_find(query: String, roots: Option<Vec<String>>, limit: Option<usize>) -> Result<Value, String> {
    let known = lock(&ROOTS).clone();
    let roots: Vec<PathBuf> = match roots {
        Some(r) => r.iter().map(|s| plain(Path::new(s))).filter(|p| known.iter().any(|k| key(k) == key(p))).collect(),
        None => known,
    };
    let t0 = Instant::now();
    let f = find(&roots, &query, limit.unwrap_or(300).clamp(1, 2_000), MAX_FIND_MS);
    Ok(json!({ "hits": f.hits, "scanned": f.scanned, "partial": f.partial, "ms": t0.elapsed().as_millis() as u64 }))
}

/// The text files of every outpost, for the Search page to read through.
#[tauri::command]
pub async fn outpost_texts(limit: Option<usize>) -> Result<Value, String> {
    let roots = lock(&ROOTS).clone();
    let f = texts(&roots, limit.unwrap_or(600).clamp(1, 3_000), 2 * 1024 * 1024, MAX_FIND_MS);
    Ok(json!({ "files": f.hits, "scanned": f.scanned, "partial": f.partial }))
}

#[tauri::command]
pub async fn outpost_rename(app: AppHandle, path: String, name: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let root = guard_write(&app, &p)?;
    if key(&root) == key(&p) {
        return Err("an outpost itself is renamed in Explorer - here you can give it another label".into());
    }
    Ok(rename_in_place(&p, &name)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn outpost_mkdir(app: AppHandle, dir: String, name: String) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    guard_write(&app, &d)?;
    let to = crate::clip::free_name(&d, &clean_name(&name)?);
    std::fs::create_dir(&to).map_err(|e| format!("{}: {}", to.display(), e))?;
    Ok(to.to_string_lossy().into_owned())
}

/// The subfolders of a dropped folder, made one level at a time and each checked once it exists:
/// a junction inside the outpost cannot carry the rest somewhere else.
pub(crate) fn make_subfolders(dir: &Path, subs: &[&str]) -> Result<PathBuf, String> {
    guard(dir)?;
    let mut target = dir.to_path_buf();
    for s in subs {
        target.push(clean_name(s)?);
        std::fs::create_dir_all(&target).map_err(|e| format!("{}: {}", target.display(), e))?;
        guard(&target)?;
    }
    Ok(target)
}

/// A file dragged in from Explorer and let go on an outpost's folder: copied
/// there (`rel` may hold subfolders, for a dropped folder), never over anything.
#[tauri::command]
pub async fn outpost_import(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let head = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let dir = crate::percent_decode(&head("x-dir").ok_or("missing x-dir")?)?;
    let rel = crate::percent_decode(&head("x-path").ok_or("missing x-path")?)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    if bytes.len() > 1024 * 1024 * 1024 { return Err("file is larger than 1 GB".into()); }
    let parts: Vec<&str> = rel.split('/').filter(|x| !x.is_empty()).collect();
    let (name, subs) = parts.split_last().ok_or("no name")?;
    guard_write(&app, Path::new(&dir))?;
    let target = make_subfolders(Path::new(&dir), subs)?;
    let to = crate::clip::free_name(&target, &clean_name(name)?);
    std::fs::write(&to, bytes).map_err(|e| format!("{}: {}", to.display(), e))?;
    Ok(to.to_string_lossy().into_owned())
}

/// To the Recycle Bin - the one deletion Leonote does outside the vault, and
/// it is Windows' own undoable one.
#[tauri::command]
pub async fn outpost_trash(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let mut list = Vec::new();
    for s in &paths {
        let p = PathBuf::from(s);
        let root = guard_write(&app, &p)?;
        if key(&root) == key(&p) {
            return Err("an outpost is unhooked, not deleted".into());
        }
        list.push(p);
    }
    if list.is_empty() {
        return Ok(());
    }
    recycle(&list)
}

/// Let the webview load ONE outside picture, video, song or PDF, so a file
/// opened from anywhere can be shown and not only named.
#[tauri::command]
pub async fn external_allow(app: AppHandle, path: String) -> Result<bool, String> {
    use tauri::Manager;
    let p = Path::new(&path);
    // asked before anything looks at it: on another computer, looking signs Windows in there
    if !crate::viewer::known(p) { crate::grant::allow_far_once(&app, p, "show this file from another computer")?; }
    if !p.is_file() {
        return Err(format!("{} is gone", name_of(p)));
    }
    if !matches!(kind_of(&name_of(p)), "image" | "media" | "pdf") {
        return Ok(false);
    }
    let canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    app.asset_protocol_scope().allow_file(&canon).map_err(|e| e.to_string())?;
    Ok(true)
}
