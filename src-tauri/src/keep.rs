//! Google Keep, brought in from a Google Takeout export.
//!
//! Keep has no public API for personal accounts; Takeout (takeout.google.com,
//! "Keep") gives a folder with one .json per note plus its pictures. Each note
//! becomes a Markdown note in the vault: its title (or first line), its text,
//! a checklist as `- [ ]` / `- [x]` lines, its labels as tags, its links, its
//! pictures copied beside it and embedded, and when it was made and last
//! edited as properties (the file's own date is set to the last edit).
//! Archived notes go into an "Archived" folder; trashed ones are left out.
//! Nothing is overwritten: a name already taken gets " 2", " 3"...

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub struct KeepNote {
    pub title: String,
    pub markdown: String,
    pub edited_ms: i64,
    pub archived: bool,
    pub trashed: bool,
    pub attachments: Vec<String>,
}

fn usec_to_iso(us: i64) -> String {
    chrono::DateTime::from_timestamp(us / 1_000_000, 0).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

/// A file name from a title: no characters Windows refuses, not too long.
pub fn safe_title(t: &str) -> String {
    let s: String = t.chars().map(|c| if "<>:\"/\\|?*#^[]".contains(c) || (c as u32) < 32 { ' ' } else { c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s: String = s.chars().take(80).collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() { "Keep note".into() } else { s }
}

/// One Keep note (its Takeout JSON) as Markdown.
pub fn convert(v: &Value, attach_dir: &str) -> KeepNote {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let b = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
    let n = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    let text = s("textContent");
    let mut title = s("title").trim().to_string();
    if title.is_empty() {
        let first = text.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
            .or_else(|| v.get("listContent").and_then(|l| l.as_array()).and_then(|a| a.first()).and_then(|x| x.get("text")).and_then(|x| x.as_str()).map(|x| x.trim().to_string()))
            .unwrap_or_default();
        title = first.chars().take(60).collect();
    }
    if title.is_empty() { title = format!("Keep note {}", usec_to_iso(n("createdTimestampUsec")).get(..10).unwrap_or("")); }
    let labels: Vec<String> = v.get("labels").and_then(|l| l.as_array()).map(|a| a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str())).map(|n| n.split_whitespace().collect::<Vec<_>>().join("-")).filter(|n| !n.is_empty()).collect()).unwrap_or_default();
    let mut md = String::from("---\n");
    md.push_str("source: Google Keep\n");
    let created = n("createdTimestampUsec");
    let edited = n("userEditedTimestampUsec");
    if created > 0 { md.push_str(&format!("created: {}\n", usec_to_iso(created))); }
    if edited > 0 { md.push_str(&format!("edited: {}\n", usec_to_iso(edited))); }
    if b("isPinned") { md.push_str("pinned: true\n"); }
    let color = s("color");
    if !color.is_empty() && color != "DEFAULT" { md.push_str(&format!("color: {}\n", color.to_lowercase())); }
    if !labels.is_empty() { md.push_str(&format!("tags: [{}]\n", labels.join(", "))); }
    md.push_str("---\n\n");
    if !text.trim().is_empty() { md.push_str(text.trim_end()); md.push_str("\n"); }
    if let Some(list) = v.get("listContent").and_then(|l| l.as_array()) {
        if !text.trim().is_empty() { md.push('\n'); }
        for it in list {
            let t = it.get("text").and_then(|x| x.as_str()).unwrap_or("").replace('\n', " ");
            let done = it.get("isChecked").and_then(|x| x.as_bool()).unwrap_or(false);
            md.push_str(&format!("- [{}] {}\n", if done { "x" } else { " " }, t.trim()));
        }
    }
    let mut attachments = Vec::new();
    if let Some(a) = v.get("attachments").and_then(|l| l.as_array()) {
        if !a.is_empty() { md.push('\n'); }
        for it in a {
            if let Some(f) = it.get("filePath").and_then(|x| x.as_str()) {
                let leaf = f.rsplit(['/', '\\']).next().unwrap_or(f).to_string();
                md.push_str(&format!("![[{}{}]]\n", if attach_dir.is_empty() { String::new() } else { format!("{attach_dir}/") }, leaf));
                attachments.push(leaf);
            }
        }
    }
    if let Some(a) = v.get("annotations").and_then(|l| l.as_array()) {
        let links: Vec<String> = a.iter().filter_map(|x| { let u = x.get("url")?.as_str()?; let t = x.get("title").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).unwrap_or(u); Some(format!("- [{}]({})", t.replace(['[', ']'], ""), u)) }).collect();
        if !links.is_empty() { md.push('\n'); md.push_str(&links.join("\n")); md.push('\n'); }
    }
    if !labels.is_empty() { md.push('\n'); md.push_str(&labels.iter().map(|l| format!("#{l}")).collect::<Vec<_>>().join(" ")); md.push('\n'); }
    KeepNote { title, markdown: md, edited_ms: if edited > 0 { edited / 1000 } else { created / 1000 }, archived: b("isArchived"), trashed: b("isTrashed"), attachments }
}

fn free(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let p = dir.join(format!("{stem}.{ext}"));
    if !p.exists() { return p; }
    (2..100000).map(|i| dir.join(format!("{stem} {i}.{ext}"))).find(|p| !p.exists()).unwrap_or(p)
}

/// Bring a Takeout Keep folder into `into` (a vault folder). Returns what was done.
#[tauri::command]
pub async fn keep_import(app: tauri::AppHandle, dir: String, into: String, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    // a network path logs Windows in there when looked at: asked first, like the other folder readers
    crate::grant::allow_far_look(&app, Path::new(&dir), "bring in Google Keep notes from this folder on another computer (looking only)")?;
    let rel = into.trim().trim_matches('/').replace('\\', "/");
    if crate::vault::is_guest(&rel) { return Err("not a vault folder".into()); }
    let root = state.paths.vault.clone();
    // the vault's own check: no drive letters or absolute paths, no "..", no junction out of the vault
    crate::vault::resolve(&root, &rel).map_err(|_| "not a vault folder".to_string())?;
    tauri::async_runtime::spawn_blocking(move || import_dir(Path::new(&dir), &root, &rel)).await.map_err(|e| e.to_string())?
}

pub fn import_dir(src: &Path, vault: &Path, rel: &str) -> Result<Value, String> {
    // the folder picked may be Takeout itself, or Takeout/Keep
    let src = if src.join("Keep").is_dir() { src.join("Keep") } else { src.to_path_buf() };
    let rd = std::fs::read_dir(&src).map_err(|e| format!("could not read {}: {e}", src.display()))?;
    let out = vault.join(rel);
    let (mut notes, mut archived, mut trashed, mut pics, mut bad) = (0, 0, 0, 0, 0);
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()).map(|x| !x.eq_ignore_ascii_case("json")).unwrap_or(true) { continue; }
        // a Keep note is a few KB: a huge .json in the folder is not one, and is not read whole into memory
        if e.metadata().map(|m| m.len() > 4 << 20).unwrap_or(true) { bad += 1; continue; }
        let Ok(text) = std::fs::read_to_string(&p) else { bad += 1; continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { bad += 1; continue };
        if v.get("textContent").is_none() && v.get("listContent").is_none() && v.get("title").is_none() { continue; } // not a note (Labels.txt and such)
        let n = convert(&v, "attachments");
        if n.trashed { trashed += 1; continue; }
        let dir = if n.archived { out.join("Archived") } else { out.clone() };
        std::fs::create_dir_all(dir.join("attachments")).map_err(|e| e.to_string())?;
        for a in &n.attachments {
            let from = src.join(a);
            // Takeout sometimes names the file .jpeg where the note says .jpg, or the other way
            let from = if from.exists() { from } else { let alt = if a.ends_with(".jpg") { a.replace(".jpg", ".jpeg") } else { a.replace(".jpeg", ".jpg") }; src.join(alt) };
            if from.exists() && !dir.join("attachments").join(a).exists() && std::fs::copy(&from, dir.join("attachments").join(a)).is_ok() { pics += 1; }
        }
        let path = free(&dir, &safe_title(&n.title), "md");
        crate::vault::write_atomic(&path, n.markdown.as_bytes()).map_err(|e| e.to_string())?;
        if n.edited_ms > 0 { let _ = filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(n.edited_ms / 1000, 0)); }
        if n.archived { archived += 1; } else { notes += 1; }
    }
    Ok(json!({ "notes": notes, "archived": archived, "trashed": trashed, "pictures": pics, "unreadable": bad, "folder": rel }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_keep_note_becomes_markdown() {
        let v: Value = serde_json::from_str(r#"{
            "color": "YELLOW", "isTrashed": false, "isPinned": true, "isArchived": false,
            "textContent": "Buy for the trip", "title": "",
            "listContent": [{"text": "tent", "isChecked": true}, {"text": "stove", "isChecked": false}],
            "labels": [{"name": "trips"}, {"name": "summer plans"}],
            "attachments": [{"filePath": "1a2b.jpg", "mimetype": "image/jpeg"}],
            "annotations": [{"url": "https://example.org/list", "title": "Packing list"}],
            "createdTimestampUsec": 1700000000000000, "userEditedTimestampUsec": 1700000500000000 }"#).unwrap();
        let n = convert(&v, "attachments");
        assert_eq!(n.title, "Buy for the trip");
        assert!(n.markdown.starts_with("---\nsource: Google Keep\ncreated: "));
        assert!(n.markdown.contains("pinned: true\ncolor: yellow\ntags: [trips, summer-plans]\n"));
        assert!(n.markdown.contains("Buy for the trip\n\n- [x] tent\n- [ ] stove\n"));
        assert!(n.markdown.contains("![[attachments/1a2b.jpg]]"));
        assert!(n.markdown.contains("- [Packing list](https://example.org/list)"));
        assert!(n.markdown.trim_end().ends_with("#trips #summer-plans"));
        assert_eq!(n.edited_ms, 1700000500000);
        assert_eq!(n.attachments, vec!["1a2b.jpg"]);
    }

    #[test]
    fn titles_and_a_whole_folder() {
        assert_eq!(safe_title("a/b: c?  #x"), "a b c x");
        assert_eq!(safe_title("   "), "Keep note");
        let dir = std::env::temp_dir().join(format!("leonote-keep-{}", std::process::id()));
        let (src, vault) = (dir.join("Takeout").join("Keep"), dir.join("vault"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(src.join("a.json"), r#"{"title":"Ideas","textContent":"one","isArchived":false,"isTrashed":false}"#).unwrap();
        std::fs::write(src.join("b.json"), r#"{"title":"Ideas","textContent":"two","isArchived":true,"isTrashed":false}"#).unwrap();
        std::fs::write(src.join("c.json"), r#"{"title":"Gone","textContent":"x","isTrashed":true}"#).unwrap();
        std::fs::write(src.join("d.json"), r#"{"title":"Ideas","textContent":"three"}"#).unwrap();
        std::fs::write(src.join("Labels.txt"), "x").unwrap();
        let r = import_dir(&dir.join("Takeout"), &vault, "Keep").unwrap();
        assert_eq!((r["notes"].as_i64(), r["archived"].as_i64(), r["trashed"].as_i64()), (Some(2), Some(1), Some(1)));
        assert!(vault.join("Keep/Ideas.md").exists() && vault.join("Keep/Ideas 2.md").exists() && vault.join("Keep/Archived/Ideas.md").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
