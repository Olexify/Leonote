//! "Is there a newer Leonote?" - for the copies that do not update themselves (the Store's does). One small file on
//! leonote.app says the latest version: { "version": "1.2.0", "url": "https://leonote.app/download",
//! "notes": "...", "security": true }. Asked on a click, or weekly when the user turns that on - never otherwise.
//! The installed copies (Windows installer, AppImage) can then install it on a click: `update_fetch` downloads it
//! from the GitHub release and checks its signature against the key in tauri.conf.json, the app saves everything
//! as on a quit, and `update_apply` installs it and starts the new version. The portable exe and the .deb are only
//! told, with the download page.

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
        Ok(json!({ "current": current, "latest": latest, "newer": crate::webext::newer(&latest, &current), "url": url, "notes": notes, "security": v["security"] == true, "installable": installable() }))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
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
