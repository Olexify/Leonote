//! The script window ("Read as script"): one note in large type, scrolling by itself, in a small window that
//! stays on top - and is kept out of screen recordings and shares (OBS, Zoom, Teams, the Snipping Tool: Windows'
//! "exclude from capture", through Tauri's content protection). What is on the monitor itself, a camera or a
//! capture card still sees it.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// The note the window shows: { path, title, text } - taken by the page as it starts, and sent again on a change.
static NOTE: Mutex<Option<Value>> = Mutex::new(None);

/// Async, as every command that makes or touches a window must be: a plain (sync) command runs on the main
/// thread, and making a window from there deadlocks on Windows - the window came up black and Leonote froze.
///
/// Show a note in the script window (opened, or brought up with the new text). `update`: only a change to the
/// note already shown - nothing is opened or raised for it.
#[tauri::command]
pub async fn script_open(app: AppHandle, path: String, title: String, text: String, update: Option<bool>) -> Result<(), String> {
    let note = json!({ "path": path, "title": title, "text": text });
    *NOTE.lock().unwrap() = Some(note.clone());
    if let Some(w) = app.get_webview_window("script") {
        let _ = w.emit("script:note", note);
        if !update.unwrap_or(false) { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
        return Ok(());
    }
    if update.unwrap_or(false) { return Ok(()); }
    WebviewWindowBuilder::new(&app, "script", WebviewUrl::App("script.html".into()))
        .additional_browser_args(crate::webwin::BROWSER_ARGS).disable_drag_drop_handler()
        .title(format!("Script - {title}"))
        .decorations(false)
        .always_on_top(true)
        .inner_size(560.0, 380.0)
        .center()
        .min_inner_size(240.0, 140.0)
        .background_color(tauri::window::Color(14, 14, 16, 255))
        .build()
        .map(|_| ())
        .map_err(|e| format!("Could not open the script window: {e}"))
}

/// The note this window opens with. Asked by the page once it has loaded: only then is the window kept out of
/// screen capture - set while the window was still being made, WebView2 drew nothing in it (a black window).
#[tauri::command]
pub async fn script_start(window: tauri::WebviewWindow) -> Option<Value> {
    let _ = window.set_content_protected(true);
    NOTE.lock().unwrap().clone()
}

/// The path shown, so the main window knows which note's edits to send (None: no script window).
#[tauri::command]
pub async fn script_path(app: AppHandle) -> Option<String> {
    app.get_webview_window("script")?;
    NOTE.lock().unwrap().as_ref().and_then(|n| n["path"].as_str().map(String::from))
}
