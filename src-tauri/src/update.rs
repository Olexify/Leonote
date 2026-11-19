//! "Is there a newer Leonote?" - for the copies that do not update themselves (the stores' do). One small file on
//! leonote.app says the latest version: { "version": "1.2.0", "url": "https://leonote.app/download",
//! "notes": "...", "security": true, "level": "critical" }. `level` says how loudly users are told: "normal" (a short
//! message), "important" (a yellow one that stays until closed; "security": true counts as at least this) or
//! "critical" (a red window that waits for an answer). Asked about a minute after start and then once a day (the owner's choice,
//! 20 Nov 2026: users are told of every update), or on a click.
//! The installed copies (Windows installer, AppImage) can install it: `update_fetch` downloads it from the GitHub
//! release and checks its signature against the key in tauri.conf.json - by itself when "Update automatically" is on
//! (the default), else on a click. `update_apply` installs it and starts the new version; `update_install_quit`
//! installs it as Leonote quits. The portable exe and the .deb are only told, with the download page.

use serde_json::{json, Value};
#[cfg(desktop)]
use std::sync::Mutex;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

const VERSION_URL: &str = "https://leonote.app/version.json";

/// This copy can replace itself: installed by the Windows installer, or an AppImage (a phone updates from its store).
fn installable() -> bool {
    #[cfg(mobile)] { false }
    #[cfg(desktop)] {
        use tauri::utils::config::BundleType;
        matches!(tauri::utils::platform::bundle_type(), Some(BundleType::Nsis | BundleType::AppImage))
    }
}

/// The update downloaded and checked, waiting for the app to finish saving.
#[cfg(desktop)]
static READY: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>> = Mutex::new(None);

/// Downloads the newest version (signature checked by the updater) and keeps it until `update_apply`. On a click only.
#[tauri::command]
pub async fn update_fetch(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(mobile)] { let _ = app; Err("A phone updates from its app store.".into()) }
    #[cfg(desktop)] {
    if !installable() { return Err("This copy is updated by downloading the new version.".into()); }
    let up = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("Could not ask GitHub for the update: {e}"))?
        .ok_or("You have the newest version.")?;
    let bytes = up.download(|_, _| {}, || {}).await.map_err(|e| format!("The update could not be downloaded or failed its signature check: {e}"))?;
    let v = up.version.clone();
    *READY.lock().map_err(|e| e.to_string())? = Some((up, bytes));
    Ok(v)
    }
}

/// Installs what `update_fetch` got and starts the new version (on Windows the installer closes this one).
#[tauri::command]
pub fn update_apply(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(mobile)] { let _ = app; Err("A phone updates from its app store.".into()) }
    #[cfg(desktop)] {
    let (up, bytes) = READY.lock().map_err(|e| e.to_string())?.take().ok_or("No update is downloaded.")?;
    up.install(bytes).map_err(|e| format!("The update could not be installed: {e}"))?;
    app.restart()
    }
}

/// Installs what `update_fetch` got and quits (an update waiting when the user quits goes in then, as Firefox does).
/// The page has saved everything already. Nothing downloaded: just quits.
#[tauri::command]
pub fn update_install_quit(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let ready = READY.lock().map_err(|e| e.to_string())?.take();
        if let Some((up, bytes)) = ready {
            // an install that fails leaves the old version as it was; the quit goes on either way
            if let Err(e) = up.install(bytes) { eprintln!("update on quit: {e}"); }
        }
    }
    app.exit(0);
    Ok(())
}

/// The page a newer version may send the user to: Leonote's own sites only (a changed file cannot point at
/// a download somewhere else).
pub fn trusted_page(url: &str) -> bool {
    let Ok(u) = tauri::Url::parse(url) else { return false };
    u.scheme() == "https" && u.username().is_empty() && u.password().is_none()
        && matches!(u.host_str(), Some("leonote.app" | "www.leonote.app" | "olexify.dev" | "www.olexify.dev"))
}

/// A version as dotted numbers, at most four parts of at most six digits ("1.2.0"); None for anything else.
pub fn clean_version(v: &str) -> Option<String> {
    let v = v.trim().trim_start_matches('v');
    let parts: Vec<&str> = v.split('.').collect();
    (!parts.is_empty() && parts.len() <= 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))).then(|| v.to_string())
}

/// { current, latest, newer, url, notes, security } - latest/url/notes only when the file says something sound.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::webext::fetch_public(VERSION_URL, 64 << 10, "").map_err(|e| format!("Could not ask leonote.app: {e}"))?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "leonote.app answered with something else".to_string())?;
        let latest = v["version"].as_str().and_then(clean_version).ok_or("leonote.app gave no version")?;
        let url = v["url"].as_str().filter(|u| trusted_page(u)).unwrap_or("https://leonote.app").to_string();
        let notes: String = v["notes"].as_str().unwrap_or("").chars().take(300).collect();
        Ok(json!({ "current": current, "latest": latest, "newer": crate::webext::newer(&latest, &current), "url": url, "notes": notes, "security": v["security"] == true, "level": level_of(&v), "installable": installable() }))
    }).await.map_err(|e| e.to_string())?
}

/// How loudly an update is told: "critical", "important" (also any security fix) or "normal" - nothing else gets through.
fn level_of(v: &Value) -> &'static str {
    match v["level"].as_str() {
        Some("critical") => "critical",
        Some("important") => "important",
        _ if v["security"] == true => "important",
        _ => "normal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_levels() {
        assert_eq!(level_of(&json!({ "level": "critical" })), "critical");
        assert_eq!(level_of(&json!({ "level": "important" })), "important");
        assert_eq!(level_of(&json!({ "security": true })), "important");
        assert_eq!(level_of(&json!({ "security": true, "level": "critical" })), "critical");
        assert_eq!(level_of(&json!({ "level": "<b>shout</b>" })), "normal");
        assert_eq!(level_of(&json!({})), "normal");
    }
    #[test]
    fn only_leonotes_own_pages_and_plain_versions() {
        assert!(trusted_page("https://leonote.app/download"));
        assert!(trusted_page("https://olexify.dev/leonote"));
        assert!(!trusted_page("http://leonote.app/download"), "https only");
        assert!(!trusted_page("https://leonote.app.evil.com/x"));
        assert!(!trusted_page("https://leonote.app@evil.com/x"));
        assert!(!trusted_page("javascript:alert(1)"));
        assert_eq!(clean_version("v1.2.0").as_deref(), Some("1.2.0"));
        assert_eq!(clean_version("1.2.0-beta"), None);
        assert_eq!(clean_version("1.2.<script>"), None);
        assert!(crate::webext::newer("1.10.0", "1.9.3") && !crate::webext::newer("1.0.0", "1.0.0"));
    }
}
