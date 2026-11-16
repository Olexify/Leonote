//! "Is there a newer Leonote?" - for the copies that do not update themselves (the portable one; the Store's
//! does). One small file on leonote.app says the latest version: { "version": "1.2.0", "url": "https://leonote.app/download",
//! "notes": "...", "security": true }. Asked on a click, or weekly when the user turns that on - never otherwise.
//! Nothing is downloaded or run: a newer version is only told, with its page to open in the browser.

use serde_json::{json, Value};

const VERSION_URL: &str = "https://leonote.app/version.json";

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
        Ok(json!({ "current": current, "latest": latest, "newer": crate::webext::newer(&latest, &current), "url": url, "notes": notes, "security": v["security"] == true }))
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
