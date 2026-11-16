//! Songs' own details, read and written in the file itself: title, artist,
//! album, album artist, year, track, genre, cover - and the user's tags,
//! kept in the file's Grouping field (ID3 TIT1, MP4 ©grp, Vorbis GROUPING)
//! so any player sees them. MP3, M4A, FLAC, OGG, Opus, WAV, AIFF and more,
//! through lofty (pure Rust, no codecs). A write goes to a hidden copy
//! beside the file and replaces it only once the copy is whole, so a failed
//! write never leaves a broken song. Only files in the vault or in one of the
//! user's music folders (libraries, outposts) are touched.

use base64::Engine as _;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::Tag;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// A vault path, or "lib:<absolute path>" inside one of the user's music folders (then that folder too).
fn target(state: &crate::AppState, path: &str) -> Result<(PathBuf, Option<PathBuf>), String> {
    let Some(abs) = path.strip_prefix("lib:") else {
        return crate::vault::resolve_file(&state.paths.vault, path).map(|p| (p, None));
    };
    let settings = crate::settings::load(&state.paths.settings, &state.paths.vault);
    let mut roots = crate::library::saved_paths(&settings);
    roots.extend(crate::outpost::saved_paths(&settings));
    let refused = || "that file is not in the vault or one of your music folders".to_string();
    // resolving a path on another computer already signs Windows in there: only one in a music folder is looked at
    if crate::grant::is_far(Path::new(abs)) && !roots.iter().any(|r| crate::outpost::is_under(Path::new(abs), Path::new(r))) { return Err(refused()); }
    let p = std::fs::canonicalize(abs).map_err(|e| format!("{}: {}", abs, e))?;
    roots.iter().find_map(|r| std::fs::canonicalize(r).ok().filter(|rc| p.starts_with(rc))).map(|root| (p, Some(root))).ok_or_else(refused)
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The file read by its content, whatever its name says.
fn open(p: &Path) -> Result<lofty::file::TaggedFile, String> {
    lofty::probe::Probe::open(p).map_err(|e| e.to_string())?.guess_file_type().map_err(|e| e.to_string())?.read().map_err(|e| e.to_string())
}

/// The details as the Player uses them; `cover`: the front cover too, as base64.
pub fn read_tags(p: &Path, cover: bool) -> Result<Value, String> {
    let tagged = open(p)?;
    let duration = tagged.properties().duration().as_secs_f64();
    let Some(t) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(json!({ "duration": duration }));
    };
    let s = |v: Option<std::borrow::Cow<'_, str>>| v.map(|x| x.trim().to_string()).unwrap_or_default();
    let key = |k: ItemKey| t.get_string(k).map(|x| x.trim().to_string()).unwrap_or_default();
    let pic = if cover {
        t.pictures().iter().find(|x| x.pic_type() == PictureType::CoverFront).or_else(|| t.pictures().first()).map(|x| {
            json!({ "data": base64::engine::general_purpose::STANDARD.encode(x.data()), "mime": x.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into()) })
        })
    } else {
        None
    };
    Ok(json!({
        "title": s(t.title()), "artist": s(t.artist()), "album": s(t.album()), "albumArtist": key(ItemKey::AlbumArtist),
        "year": t.date().map(|d| d.year.to_string()).unwrap_or_default(),
        "track": t.track().map(|n| n.to_string()).unwrap_or_default(),
        "genre": s(t.genre()), "grouping": key(ItemKey::ContentGroup), "comment": s(t.comment()),
        "duration": duration, "cover": pic, "hasCover": !t.pictures().is_empty(),
    }))
}

/// Set what `f` names (a field left out stays as it is; an empty one is removed).
fn apply(tag: &mut Tag, f: &Value) -> Result<(), String> {
    let text = |k: &str| f.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string());
    if let Some(v) = text("title") { if v.is_empty() { tag.remove_title() } else { tag.set_title(v) } }
    if let Some(v) = text("artist") { if v.is_empty() { tag.remove_artist() } else { tag.set_artist(v) } }
    if let Some(v) = text("album") { if v.is_empty() { tag.remove_album() } else { tag.set_album(v) } }
    if let Some(v) = text("genre") { if v.is_empty() { tag.remove_genre() } else { tag.set_genre(v) } }
    if let Some(v) = text("comment") { if v.is_empty() { tag.remove_comment() } else { tag.set_comment(v) } }
    for (k, item) in [("albumArtist", ItemKey::AlbumArtist), ("grouping", ItemKey::ContentGroup)] {
        if let Some(v) = text(k) {
            tag.remove_key(item.clone());
            if !v.is_empty() { tag.insert_text(item, v); }
        }
    }
    if let Some(v) = text("track") {
        match v.split('/').next().unwrap_or("").trim().parse::<u32>() { Ok(n) if n > 0 => tag.set_track(n), _ => tag.remove_track() }
    }
    if let Some(v) = text("year") {
        match v.parse::<lofty::tag::items::Timestamp>() { Ok(d) if !v.is_empty() => tag.set_date(d), _ => tag.remove_date() }
    }
    // the cover: new picture bytes (base64), or null to take it away
    match f.get("cover") {
        Some(Value::String(b64)) => {
            let data = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
            let mime = f.get("coverMime").and_then(|v| v.as_str()).unwrap_or("image/jpeg");
            tag.remove_picture_type(PictureType::CoverFront);
            tag.push_picture(Picture::unchecked(data).pic_type(PictureType::CoverFront).mime_type(MimeType::from_str(mime)).build());
        }
        Some(Value::Null) => { while !tag.pictures().is_empty() { tag.remove_picture(0); } }
        _ => {}
    }
    Ok(())
}

/// Write `f` into the song at `p` - through a hidden copy beside it, swapped in once whole.
pub fn write_tags(p: &Path, f: &Value) -> Result<Value, String> {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // the copy keeps the real extension: the format is known by it (and by its first bytes)
    let ext = p.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = p.with_file_name(format!(".{}.leonote-tags.{}", stem, ext));
    std::fs::copy(p, &tmp).map_err(|e| format!("copy {}: {}", name, e))?;
    let wrote = (|| -> Result<(), String> {
        let mut tagged = open(&tmp)?;
        if tagged.primary_tag_mut().is_none() {
            let ty = tagged.primary_tag_type();
            tagged.insert_tag(Tag::new(ty));
        }
        let tag = tagged.primary_tag_mut().ok_or("the file takes no tags")?;
        apply(tag, f)?;
        tag.save_to_path(&tmp, WriteOptions::default()).map_err(|e| e.to_string())
    })();
    if let Err(e) = wrote {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {}", name, e));
    }
    std::fs::rename(&tmp, p).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("{}: {}", name, e) })?;
    Ok(json!({ "mtime": mtime_ms(p), "size": std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) }))
}

#[tauri::command]
pub async fn music_tags(path: String, cover: Option<bool>, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let (p, _) = target(&state, &path)?;
    let cover = cover.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || read_tags(&p, cover)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn music_tags_write(app: tauri::AppHandle, path: String, fields: Value, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    crate::guest_ok(&app, &path, &state)?;
    let (p, root) = target(&state, &path)?;
    // a music folder outside the vault is changed only with a yes, once for the folder - as a linked folder is
    if let Some(root) = root { crate::grant::allow(&app, &root, "change song details in files in this music folder", true)?; }
    tauri::async_runtime::spawn_blocking(move || write_tags(&p, &fields)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny, valid WAV (silence) to write tags into.
    fn wav(path: &Path) {
        let data = vec![0u8; 800];
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&8000u32.to_le_bytes());
        b.extend_from_slice(&16000u32.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&data);
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn details_and_tags_go_into_the_file_and_come_back() {
        let dir = std::env::temp_dir().join(format!("leonote-music-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("song.wav");
        wav(&p);
        write_tags(&p, &json!({ "title": "Night Drive", "artist": "Leo", "album": "Roads", "year": "2024", "track": "3", "genre": "Synthwave", "grouping": "car with friends; energetic" })).unwrap();
        let t = read_tags(&p, false).unwrap();
        assert_eq!(t["title"], "Night Drive");
        assert_eq!(t["artist"], "Leo");
        assert_eq!(t["grouping"], "car with friends; energetic");
        assert_eq!(t["year"], "2024");
        assert_eq!(t["track"], "3");
        // an empty field is removed, one left out stays
        write_tags(&p, &json!({ "genre": "", "grouping": "calm" })).unwrap();
        let t = read_tags(&p, false).unwrap();
        assert_eq!(t["genre"], "");
        assert_eq!(t["title"], "Night Drive");
        assert_eq!(t["grouping"], "calm");
        assert!(!dir.join(".song.leonote-tags.wav").exists(), "the working copy is gone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
