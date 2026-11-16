//! The picture and video viewer: a borderless window of its own (viewer.html) for pictures and videos opened
//! from outside Leonote - like a photo viewer or a media player, not a tab. One window per file, or one window
//! that each new file replaces (Settings: the choice is the page's, `one`).
//!
//! The viewer may show, list and recycle only what it was handed and what lies beside it in the same folder:
//! those paths are remembered here, so a script in a page cannot have it recycle any other file.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static FILES: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
/// window label -> the file it opens with, taken by the page as it starts
static START: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A picture or a video the viewer shows (songs go to the Player).
pub fn is_viewable(p: &Path) -> bool {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    crate::vault::file_kind(&format!("x.{ext}")) == "image" || matches!(ext.as_str(), "mp4" | "webm" | "mkv" | "mov" | "m4v" | "ogv")
}

// a path on another computer is kept as written: resolving it would already reach that computer
fn key(p: &Path) -> PathBuf { if crate::grant::is_far(p) { return p.to_path_buf(); } std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()) }
fn remember(p: &Path) { crate::lock(&FILES).get_or_insert_with(HashSet::new).insert(key(p)); }
pub(crate) fn known(p: &Path) -> bool { crate::lock(&FILES).as_ref().is_some_and(|s| s.contains(&key(p))) }

/// Open pictures and videos in the viewer: each in a window of its own, or (`one`) all in the one viewer window,
/// the last of them shown.
#[tauri::command]
pub async fn viewer_open(app: AppHandle, paths: Vec<String>, one: bool) -> Result<(), String> {
    // a path on another computer is not looked at (is_file signs Windows in there) until the question is answered
    let mut paths: Vec<String> = paths.into_iter().filter(|p| is_viewable(Path::new(p)) && (crate::grant::is_far(Path::new(p)) || Path::new(p).is_file())).collect();
    // files the user opened with Leonote; any other is asked about - the viewer can move its folder's files to the bin
    for p in &paths { crate::grant::allow(&app, Path::new(p), "show in the viewer (and let it move pictures and videos beside it to the Recycle Bin)", false)?; }
    paths.retain(|p| Path::new(p).is_file());
    for p in &paths { remember(Path::new(p)); }
    if one {
        let Some(last) = paths.last() else { return Ok(()) };
        if let Some(w) = app.get_webview_window("viewer") {
            let _ = w.emit("viewer:open", last);
            let _ = w.unminimize();
            let _ = w.set_focus();
            return Ok(());
        }
        return make(&app, "viewer".into(), last);
    }
    for p in &paths { make(&app, format!("viewer-{}", SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1), p)?; }
    Ok(())
}

fn make(app: &AppHandle, label: String, path: &str) -> Result<(), String> {
    crate::lock(&START).get_or_insert_with(HashMap::new).insert(label.clone(), path.to_string());
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("viewer.html".into()))
        .additional_browser_args(crate::webwin::BROWSER_ARGS).disable_drag_drop_handler()
        .title(name)
        .decorations(false)
        .inner_size(1100.0, 760.0)
        .min_inner_size(320.0, 220.0)
        .center()
        .background_color(tauri::window::Color(14, 14, 16, 255))
        .build()
        .map(|_| ())
        .map_err(|e| format!("Could not open the viewer: {e}"))
}

/// The file this viewer window opens with.
#[tauri::command]
pub fn viewer_start(window: tauri::Window) -> Option<String> {
    crate::lock(&START).as_mut().and_then(|m| m.remove(window.label()))
}

/// The pictures and videos in the folder of one the viewer was handed (full paths; the page sorts them as
/// Explorer does). They become the viewer's too.
#[tauri::command]
pub async fn viewer_siblings(path: String) -> Result<Vec<String>, String> {
    let p = Path::new(&path);
    if !known(p) { return Err("not a file the viewer was given".into()); }
    let dir = p.parent().ok_or("no folder")?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let q = e.path();
        if q.is_file() && is_viewable(&q) { remember(&q); out.push(q.to_string_lossy().into_owned()); }
    }
    Ok(out)
}

/// To the Recycle Bin (Windows' own, undoable) - only a file the viewer was given or found beside one.
#[tauri::command]
pub async fn viewer_trash(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    if !known(&p) || !is_viewable(&p) { return Err("not a file the viewer was given".into()); }
    crate::outpost::recycle(&[p])?;
    Ok(Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_network_path_is_kept_as_written_not_looked_up() {
        let far = Path::new(r"\\leo-no-such-server\s\a.jpg");
        assert_eq!(key(far), far.to_path_buf());
        assert!(!known(far));
    }
    #[test]
    fn only_files_it_was_given_or_found_beside_them_may_be_recycled() {
        let d = std::env::temp_dir().join(format!("leo-viewer-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let (a, b, n) = (d.join("a.jpg"), d.join("b.mp4"), d.join("notes.md"));
        for f in [&a, &b, &n] { std::fs::write(f, b"x").unwrap(); }
        assert!(!known(&a));
        assert!(tauri::async_runtime::block_on(viewer_siblings(a.to_string_lossy().into_owned())).is_err(), "a file it was not given");
        remember(&a);
        let sib = tauri::async_runtime::block_on(viewer_siblings(a.to_string_lossy().into_owned())).unwrap();
        assert_eq!(sib.len(), 2, "pictures and videos only: {sib:?}");
        assert!(known(&b) && !known(&n));
        assert!(tauri::async_runtime::block_on(viewer_trash(n.to_string_lossy().into_owned())).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
