//! Android (the APK from GitHub) updating itself, as the desktop installer copy does: the new APK is downloaded from
//! the GitHub release, checked against the .sha256 beside it, and handed to Android's installer
//! (src-tauri/android/UpdatePlugin.kt). Android refuses any APK that is not app.leonote signed with the same key, so
//! the release key is what keeps this safe; the checksum catches a broken download. Google Play's copy (feature
//! "play") has none of this: Play updates it, and Play's rules forbid an app updating itself. On a computer these
//! commands only say no.

#[cfg(all(target_os = "android", not(feature = "play")))]
use serde_json::json;
use serde_json::Value;

#[cfg(all(target_os = "android", not(feature = "play")))]
pub struct Native(pub tauri::plugin::PluginHandle<tauri::Wry>);

/// The Kotlin side, registered once at start.
#[cfg(all(target_os = "android", not(feature = "play")))]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    tauri::plugin::Builder::new("leoupdate")
        .setup(|app, api| {
            let h = api.register_android_plugin("app.leonote", "UpdatePlugin")?;
            app.manage(Native(h));
            Ok(())
        })
        .build()
}

#[cfg(all(target_os = "android", not(feature = "play")))]
fn native(app: &tauri::AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    use tauri::Manager;
    let h = app.try_state::<Native>().ok_or("the updater is not in this copy")?;
    h.0.run_mobile_plugin::<Value>(cmd, args).map_err(|e| e.to_string())
}

/// The folder downloaded updates go to: the app's own cache, emptied of older ones each time.
#[cfg(all(target_os = "android", not(feature = "play")))]
fn dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("update"))
}

/// The SHA-256 of `b` in lowercase hex.
#[cfg_attr(not(all(target_os = "android", not(feature = "play"))), allow(dead_code))] // used on Android; tested everywhere
pub fn sha256_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Does a .sha256 file (`<hex>  <name>`) name this hash?
#[cfg_attr(not(all(target_os = "android", not(feature = "play"))), allow(dead_code))]
pub fn sum_matches(file: &str, hex: &str) -> bool {
    file.split_whitespace().next().map(|h| h.eq_ignore_ascii_case(hex)).unwrap_or(false) && hex.len() == 64
}

/// Downloads the APK of `version` from its GitHub release and checks it; returns its path in the app's cache.
#[tauri::command]
pub async fn apk_fetch(app: tauri::AppHandle, version: String) -> Result<String, String> {
    #[cfg(all(target_os = "android", not(feature = "play")))]
    {
        let v = crate::update::clean_version(&version).ok_or("not a version")?;
        let dir = dir(&app)?;
        return tauri::async_runtime::spawn_blocking(move || {
            let url = format!("https://github.com/Olexify/Leonote/releases/download/v{v}/Leonote-android.apk");
            let sum = crate::webext::fetch_public(&format!("{url}.sha256"), 4096, "")?;
            let apk = crate::webext::fetch_public(&url, 400 << 20, "")?;
            let hex = sha256_hex(&apk);
            if !sum_matches(&String::from_utf8_lossy(&sum), &hex) { return Err("the download did not match its checksum - it was not kept".to_string()); }
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let to = dir.join(format!("Leonote-{v}.apk"));
            std::fs::write(&to, apk).map_err(|e| e.to_string())?;
            Ok(to.to_string_lossy().into_owned())
        }).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(all(target_os = "android", not(feature = "play"))))]
    { let _ = (app, version); Err("only the Android app from GitHub updates this way".into()) }
}

/// Hands a downloaded APK to Android's installer. Without the user's "Install unknown apps" yes for Leonote: with
/// `ask`, Android's page for it opens (a click of the user's); without, it only answers { "needs": "permission" }.
#[tauri::command]
pub async fn apk_install(app: tauri::AppHandle, path: String, ask: bool) -> Result<Value, String> {
    #[cfg(all(target_os = "android", not(feature = "play")))]
    {
        let p = std::path::PathBuf::from(&path);
        let inside = p.canonicalize().ok().zip(dir(&app)?.canonicalize().ok()).map(|(a, b)| a.starts_with(b)).unwrap_or(false);
        if !inside { return Err("not a downloaded update".into()); }
        let allowed = native(&app, "canInstall", json!({}))?.get("allowed").and_then(|a| a.as_bool()).unwrap_or(false);
        if !allowed {
            if ask { native(&app, "askPermission", json!({}))?; }
            return Ok(json!({ "needs": "permission" }));
        }
        native(&app, "install", json!({ "path": path }))?;
        return Ok(json!({ "needs": "" }));
    }
    #[cfg(not(all(target_os = "android", not(feature = "play"))))]
    { let _ = (app, path, ask); Err("only the Android app from GitHub updates this way".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksums() {
        let h = sha256_hex(b"leonote");
        assert_eq!(h.len(), 64);
        assert!(sum_matches(&format!("{h}  Leonote-android.apk\n"), &h));
        assert!(sum_matches(&format!("{}  x", h.to_uppercase()), &h));
        assert!(!sum_matches("deadbeef  Leonote-android.apk", &h));
        assert!(!sum_matches("", &h));
    }
}
