//! Sidecars for non-destructive picture edits.
//!
//! Leonote never writes over someone's photo. Drawn layers and colour
//! adjustments live in a small JSON file beside the picture, inside the
//! folder's hidden `.leonote` directory:
//!
//! ```text
//! Ideas/moodboard.png  ->  Ideas/.leonote/moodboard.png.leoedit.json
//! ```
//!
//! Hidden, because `vault::scan` skips dot-directories: the sidecars stay out
//! of the file tree, search, the graph and boards, while still travelling with
//! the pictures when a folder is moved, copied or synced.
//!
//! `vault::check_rel` refuses dot-prefixed segments on purpose, so the rest of
//! the app cannot reach these paths. That is why this is its own small module
//! with its own three commands, each of which only ever touches
//! `<image folder>/.leonote/<image name>.leoedit.json` for a real picture.

use std::path::{Path, PathBuf};
use tauri::State;

use crate::vault;
use crate::AppState;

/// Biggest sidecar we will read or write. Thousands of pen strokes fit well
/// inside this; anything larger is a mistake or a stray file.
pub const MAX_SIDECAR: usize = 8 * 1024 * 1024;

pub const SIDECAR_DIR: &str = ".leonote";
pub const SIDECAR_EXT: &str = ".leoedit.json";

/// The sidecar's absolute path for a vault-relative picture.
///
/// The picture path goes through the ordinary validation first (no traversal,
/// no dot segments, inside the vault), and the hidden folder is only ever
/// appended to the directory that validated path already named.
pub fn sidecar_for(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if vault::file_kind(rel) != "image" {
        return Err(format!("not a picture: {}", rel));
    }
    let abs = vault::resolve(root, rel)?;
    let dir = abs.parent().ok_or_else(|| format!("no folder for {}", rel))?;
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("odd file name: {}", rel))?;
    Ok(dir.join(SIDECAR_DIR).join(format!("{}{}", name, SIDECAR_EXT)))
}

/// The edits stored for a picture, or `None` when it has never been edited.
#[tauri::command]
pub async fn image_edit_read(path: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let p = sidecar_for(&state.paths.vault, &path)?;
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() as usize > MAX_SIDECAR {
        return Err(format!("edits for {} are larger than {} MB", path, MAX_SIDECAR / (1024 * 1024)));
    }
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) => Err(format!("read edits for {}: {}", path, e)),
    }
}

/// Store the edits for a picture. The picture itself is not opened.
#[tauri::command]
pub async fn image_edit_write(app: tauri::AppHandle, path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    if content.len() > MAX_SIDECAR {
        return Err(format!("edits for {} are larger than {} MB", path, MAX_SIDECAR / (1024 * 1024)));
    }
    // a sidecar is always a JSON object; anything else is a bug upstream
    if !content.trim_start().starts_with('{') {
        return Err("edits must be a JSON object".into());
    }
    let p = sidecar_for(&state.paths.vault, &path)?;
    crate::guest_ok(&app, &path, &state)?;
    vault::write_atomic(&p, content.as_bytes()).map_err(|e| format!("write edits for {}: {}", path, e))
}

/// Forget the edits for a picture. Missing is success: the point is that
/// afterwards there are none.
#[tauri::command]
pub async fn image_edit_delete(app: tauri::AppHandle, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = sidecar_for(&state.paths.vault, &path)?;
    crate::guest_ok(&app, &path, &state)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove edits for {}: {}", path, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let d = std::env::temp_dir().join(format!("leonote-imageedit-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sidecar_sits_in_a_hidden_folder_beside_the_picture() {
        let r = root();
        let p = sidecar_for(&r, "Ideas/moodboard.png").unwrap();
        assert_eq!(p, r.join("Ideas").join(".leonote").join("moodboard.png.leoedit.json"));
        let top = sidecar_for(&r, "photo.webp").unwrap();
        assert_eq!(top, r.join(".leonote").join("photo.webp.leoedit.json"));
    }

    #[test]
    fn only_pictures_get_sidecars() {
        let r = root();
        assert!(sidecar_for(&r, "Notes/thing.md").is_err());
        assert!(sidecar_for(&r, "budget.xlsx").is_err());
        assert!(sidecar_for(&r, "clip.mp4").is_err());
    }

    /// The whole promise of this module: storing edits leaves the picture's
    /// bytes exactly as they were.
    #[test]
    fn storing_edits_never_touches_the_picture() {
        let r = root().join("untouched");
        std::fs::create_dir_all(r.join("Ideas")).unwrap();
        let pic = r.join("Ideas").join("moodboard.png");
        let bytes: Vec<u8> = (0u16..600).map(|i| (i % 251) as u8).collect();
        std::fs::write(&pic, &bytes).unwrap();
        let before = std::fs::metadata(&pic).unwrap().modified().unwrap();

        let side = sidecar_for(&r, "Ideas/moodboard.png").unwrap();
        let doc = r#"{"leoedit":1,"layers":[{"id":"a","shapes":[]}]}"#;
        crate::vault::write_atomic(&side, doc.as_bytes()).unwrap();
        assert_eq!(std::fs::read_to_string(&side).unwrap(), doc);
        assert!(side.parent().unwrap().ends_with(SIDECAR_DIR));

        assert_eq!(std::fs::read(&pic).unwrap(), bytes, "the picture changed");
        assert_eq!(std::fs::metadata(&pic).unwrap().modified().unwrap(), before, "the picture was rewritten");

        std::fs::remove_file(&side).unwrap();
        assert_eq!(std::fs::read(&pic).unwrap(), bytes);
        std::fs::remove_dir_all(&r).ok();
    }

    #[test]
    fn the_picture_path_is_still_validated() {
        let r = root();
        assert!(sidecar_for(&r, "../outside.png").is_err());
        assert!(sidecar_for(&r, ".trash/old.png").is_err());
        assert!(sidecar_for(&r, "a\\b.png").is_err());
        assert!(sidecar_for(&r, "").is_err());
    }
}
