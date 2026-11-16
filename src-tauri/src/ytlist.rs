//! Kept previews: a video's picture copied once into the vault, so the Player's tiles load from the disk.

use serde_json::{json, Value};
use std::time::Duration;

// ── kept previews ──────────────────────────────────────────────────────
// A video's picture copied once into <vault>/.leonote/previews/<id>.jpg, so
// the Player's tiles load from the disk and a video taken down keeps its
// face. A dot folder: the vault's own asset scope leaves it out, so it is
// opened to the webview by itself.

pub fn preview_dir(vault: &std::path::Path) -> std::path::PathBuf {
    vault.join(".leonote").join("previews-public")
}

/// Only a YouTube video id names a file here: 11 of [A-Za-z0-9_-].
pub fn is_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// A video's picture is kept 30 days at most, as YouTube's developer policies (III.E.4) ask of stored
/// data; a tile shown fetches it anew. A video that is gone has no new one, so its picture goes for good.
fn past_keeping(written: std::time::SystemTime) -> bool {
    written.elapsed().is_ok_and(|age| age > Duration::from_secs(30 * 86400))
}

/// `{ dir, ids, small }`: the folder (opened to the webview), the videos whose picture is kept, and
/// those kept small (`<id>.webp`, made by the webview; the rest are YouTube's own `<id>.jpg`).
#[tauri::command(async)]
pub fn yt_previews(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    use tauri::Manager;
    let dir = preview_dir(&state.paths.vault);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let canon = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    app.asset_protocol_scope().allow_directory(&canon, false).map_err(|e| e.to_string())?;
    let (mut ids, mut small) = (Vec::new(), Vec::new());
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let (id, webp) = match (name.strip_suffix(".jpg"), name.strip_suffix(".webp")) { (Some(i), _) => (i, false), (_, Some(i)) => (i, true), _ => continue };
        if is_video_id(id) {
            if e.metadata().and_then(|m| m.modified()).is_ok_and(past_keeping) { let _ = std::fs::remove_file(e.path()); continue; }
            if webp { small.push(id.to_string()); } else { ids.push(id.to_string()); }
        }
    }
    // the big one a small one replaced goes now (kept until then: a tile drawn with it kept its picture)
    let has_small: std::collections::HashSet<&String> = small.iter().collect();
    ids.retain(|id| if has_small.contains(id) { let _ = std::fs::remove_file(dir.join(format!("{}.jpg", id))); false } else { true });
    ids.extend(small.iter().cloned());
    let abs = std::path::absolute(&dir).unwrap_or(dir);
    Ok(json!({ "dir": abs.to_string_lossy(), "ids": ids, "small": small }))
}

/// A kept picture as YouTube gave it, for the webview to make small - as raw bytes, not a JSON list.
#[tauri::command(async)]
pub fn yt_preview_bytes(id: String, state: tauri::State<'_, crate::AppState>) -> Result<tauri::ipc::Response, String> {
    if !is_video_id(&id) { return Err("not a YouTube video id".into()); }
    std::fs::read(preview_dir(&state.paths.vault).join(format!("{}.jpg", id))).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The small picture (WebP, a few KB, sent as base64) beside YouTube's; the big one goes on the next start.
#[tauri::command(async)]
pub fn yt_preview_put(id: String, data: String, state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    use base64::Engine;
    if !is_video_id(&id) { return Err("not a YouTube video id".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    if !is_webp(&bytes) { return Err("not a small WebP picture".into()); }
    crate::vault::write_atomic(&preview_dir(&state.paths.vault).join(format!("{}.webp", id)), &bytes).map_err(|e| e.to_string())
}

/// A WebP file, and a small one: RIFF....WEBP, under 256 KB.
pub fn is_webp(b: &[u8]) -> bool {
    b.len() > 30 && b.len() < 256 * 1024 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP"
}

/// Keep one video's picture. `refresh`: fetched again even when kept (it was
/// played - the uploader may have changed it). Only a real picture is ever
/// written, so a video YouTube no longer has keeps the one it had. True when
/// a picture is there afterwards.
#[tauri::command]
pub async fn yt_preview_keep(id: String, refresh: bool, state: tauri::State<'_, crate::AppState>) -> Result<bool, String> {
    if !is_video_id(&id) {
        return Err("not a YouTube video id".into());
    }
    let file = preview_dir(&state.paths.vault).join(format!("{}.jpg", id));
    if (file.is_file() || file.with_extension("webp").is_file()) && !refresh {
        return Ok(true);
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
        let mut bytes = Vec::new();
        match agent.get(&format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", id)).call() {
            Ok(r) if r.status() == 200 => {
                r.into_reader().take(4 * 1024 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            }
            _ => return Ok(file.is_file() || file.with_extension("webp").is_file()),
        }
        // YouTube's grey stand-in is tiny; a real 320x180 picture is several KB
        if bytes.len() < 1500 || std::fs::read(&file).map(|old| old == bytes).unwrap_or(false) {
            return Ok(file.is_file() || file.with_extension("webp").is_file());
        }
        if let Some(d) = file.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        crate::vault::write_atomic(&file, &bytes).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_kept_picture_lasts_thirty_days() {
        let ago = |days: u64| std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86400);
        assert!(!super::past_keeping(ago(29)));
        assert!(super::past_keeping(ago(31)));
    }
    use super::*;

    #[test]
    fn only_a_small_webp_is_kept_as_a_preview() {
        let mut ok = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        ok.extend(vec![0u8; 40]);
        assert!(is_webp(&ok));
        assert!(!is_webp(b"\xff\xd8\xff\xe0 a jpeg"));
        assert!(!is_webp(&[ok.clone(), vec![0u8; 300 * 1024]].concat()));
    }

    #[test]
    fn only_a_video_id_names_a_kept_preview() {
        assert!(is_video_id("abcdefghijk"));
        assert!(is_video_id("a-b_c123XYZ"));
        assert!(!is_video_id("../../x.jpg"));
        assert!(!is_video_id("dQw4w9WgXc"));
        assert!(!is_video_id("dQw4w9WgXc/"));
        assert!(!is_video_id("abcdefghijkQ"));
    }

}
