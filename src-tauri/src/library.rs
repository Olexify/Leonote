//! Media libraries outside the vault: a music drive, a videos folder, any
//! directory the user points at. Nothing is copied or written there - the
//! Player reads the files where they lie, so every path here is an absolute
//! OS path, like external.rs and unlike vault.rs.
//!
//! Two things make a folder usable: a scan (what is in it) and the asset
//! protocol scope (the webview may only load files from directories that were
//! allowed at runtime). `allow` is called at startup for every remembered
//! library and again when one is added.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// A wrong path must not turn into a minutes-long walk of a whole disk.
pub const MAX_FILES: usize = 20_000;
/// Deep trees are usually a mistake (a drive root); this still covers
/// Artist/Album/Disc 1/track.mp3 several times over.
const MAX_DEPTH: usize = 8;

/// Let the webview load files under `dir` (recursively). Canonical form only:
/// the protocol canonicalizes each request before matching the glob.
pub fn allow(app: &AppHandle, dir: &Path) {
    let canon = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if let Err(e) = app.asset_protocol_scope().allow_directory(&canon, true) {
        eprintln!("asset protocol scope for {}: {}", canon.display(), e);
    }
}

/// Every remembered library gets its scope back on startup. Reads the same
/// settings file the frontend writes (`playerLibraries: [{ path, ... }]`).
pub fn allow_saved(app: &AppHandle, settings: &Value) {
    for dir in saved_paths(settings) {
        allow(app, Path::new(&dir));
    }
}

pub fn saved_paths(settings: &Value) -> Vec<String> {
    settings
        .get("playerLibraries")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("path").and_then(|p| p.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn name_of(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// Media and the pictures next to it (cover.jpg and friends); everything else
/// in the folder is ignored, so a library of a photo drive stays small.
fn wanted(name: &str) -> Option<&'static str> {
    match crate::vault::file_kind(name) {
        "media" => Some("media"),
        "image" => Some("image"),
        _ => match name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
            // formats the vault does not list, but a music folder is full of
            Some("flac") | Some("aac") | Some("opus") | Some("m4b") | Some("wma") | Some("aiff")
            | Some("mkv") | Some("mov") | Some("avi") | Some("m4v") => Some("media"),
            _ => None,
        },
    }
}

/// Everything playable under `root`, recursively. Hidden and dot folders are
/// skipped, symlinked folders are not followed, and the walk stops at
/// `MAX_FILES` so a mistaken drive root cannot hang the app.
pub fn scan_dir(root: &Path) -> Result<Vec<Value>, String> {
    let md = std::fs::metadata(root).map_err(|e| format!("{}: {}", root.display(), e))?;
    if !md.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_FILES {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // a folder we may not read is simply not in the library
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with('$') {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
                continue;
            }
            let Some(kind) = wanted(&name) else { continue };
            let Ok(md) = entry.metadata() else { continue };
            out.push(json!({
                "path": entry.path().to_string_lossy(),
                "name": name,
                "size": md.len(),
                "mtime": mtime_ms(&md),
                "kind": kind,
            }));
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
    out.sort_by(|a, b| a["path"].as_str().unwrap_or("").cmp(b["path"].as_str().unwrap_or("")));
    Ok(out)
}

/// Add a folder as a library: check it, allow it for the asset protocol and
/// hand back what the Player needs. The list itself lives in the frontend's
/// settings, so there is one source of truth.
#[tauri::command]
pub async fn library_add(app: AppHandle, path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    // the question comes before anything looks at the path: looking at \\host\share logs in there. A folder picked in the dialog is already granted
    crate::grant::allow(&app, &p, "let the Player read the files in this folder", true)?;
    let canon = std::fs::canonicalize(&p).map_err(|e| format!("{}: {}", path, e))?;
    if !canon.is_dir() {
        return Err(format!("{} is not a folder", path));
    }
    allow(&app, &canon);
    let files = scan_dir(&canon)?;
    Ok(json!({
        "path": canon.to_string_lossy(),
        "name": name_of(&canon),
        "count": files.len(),
        "files": files,
        "capped": files.len() >= MAX_FILES,
    }))
}

/// Handed over, or already remembered (the Player also scans outposts; older ones were saved before grants). Nothing
/// looks at a network path here. Not granted at start for them: a grant also permits writing.
pub fn may_scan(p: &Path, path: &str, settings: &Value) -> bool {
    crate::grant::granted(p) || saved_paths(settings).iter().chain(&crate::outpost::saved_paths(settings)).any(|s| s == path)
}

/// Re-read a library (also re-allows it, so a folder added before a restart
/// works straight away).
#[tauri::command]
pub async fn library_scan(app: AppHandle, path: String, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    if !may_scan(&p, &path, &crate::settings::load(&state.paths.settings, &state.paths.vault)) {
        return Err(format!("{} is not one of your libraries", path));
    }
    if !p.is_dir() {
        return Err(format!("{} is not there any more", path));
    }
    allow(&app, &p);
    let files = scan_dir(&p)?;
    Ok(json!({
        "path": path,
        "name": name_of(&p),
        "count": files.len(),
        "files": files,
        "capped": files.len() >= MAX_FILES,
    }))
}
