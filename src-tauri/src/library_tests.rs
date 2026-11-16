//! Scanning a media folder outside the vault: what is picked up, what is
//! skipped, and how the remembered list is read back. The asset-protocol
//! scope is not tested - it is one Tauri call and needs a running app.

use super::library::*;
use serde_json::json;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("leonote_library_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn only_a_folder_handed_over_or_remembered_can_be_scanned() {
    let s = json!({ "playerLibraries": [{ "path": r"D:\Music" }], "outposts": [{ "path": r"E:\Linked" }] });
    assert!(may_scan(std::path::Path::new(r"D:\Music"), r"D:\Music", &s) && may_scan(std::path::Path::new(r"E:\Linked"), r"E:\Linked", &s));
    for no in [r"C:\Users\someone", r"\\leo-no-such-host\share"] {
        assert!(!may_scan(std::path::Path::new(no), no, &s), "{no}");
    }
}

#[test]
fn scan_finds_media_and_covers_only() {
    let dir = scratch("scan");
    std::fs::create_dir_all(dir.join("Album/Disc 1")).unwrap();
    std::fs::create_dir_all(dir.join(".hidden")).unwrap();
    std::fs::write(dir.join("Album/01 song.mp3"), b"x").unwrap();
    std::fs::write(dir.join("Album/cover.jpg"), b"x").unwrap();
    std::fs::write(dir.join("Album/notes.txt"), b"x").unwrap();
    std::fs::write(dir.join("Album/Disc 1/deep.flac"), b"x").unwrap();
    std::fs::write(dir.join("clip.mkv"), b"x").unwrap();
    std::fs::write(dir.join(".hidden/secret.mp3"), b"x").unwrap();
    let files = scan_dir(&dir).unwrap();
    let names: Vec<&str> = files.iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"01 song.mp3") && names.contains(&"cover.jpg"));
    assert!(names.contains(&"deep.flac"), "formats the vault ignores are still music here");
    assert!(names.contains(&"clip.mkv"));
    assert!(!names.contains(&"notes.txt"), "only media and its covers");
    assert!(!names.contains(&"secret.mp3"), "dot folders are skipped");
    let kinds: Vec<&str> = files.iter().map(|f| f["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"media") && kinds.contains(&"image"));
    assert!(files.iter().all(|f| f["path"].as_str().unwrap().starts_with(dir.to_str().unwrap())));
}

#[test]
fn scan_refuses_a_file_or_a_missing_folder() {
    let dir = scratch("refuse");
    let f = dir.join("a.mp3");
    std::fs::write(&f, b"x").unwrap();
    assert!(scan_dir(&f).is_err());
    assert!(scan_dir(&dir.join("nope")).is_err());
}

#[test]
fn saved_paths_reads_the_settings_shape() {
    let s = json!({ "playerLibraries": [{ "path": "D:/Music", "name": "Music" }, { "name": "no path" }] });
    assert_eq!(saved_paths(&s), vec!["D:/Music".to_string()]);
    assert!(saved_paths(&json!({})).is_empty());
}
