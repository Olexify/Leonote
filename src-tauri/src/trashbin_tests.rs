//! Tests for the trash's bookkeeping. Hermetic: each owns a temp directory.

use super::trashbin::*;
use super::vault::Entry;
use std::path::{Path, PathBuf};

const DAY: i64 = 86_400_000;

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("leonote_trashbin_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn put(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap()
}

#[test]
fn a_deleted_note_comes_back_where_it_was() {
    let root = scratch("back");
    put(&root, "Docs/Deep/a.md", "A");
    dispose(&root, "Docs/Deep/a.md", Entry::Note, None, "2026-09-14 101500").unwrap();
    assert!(!root.join("Docs/Deep/a.md").exists());
    let items = list(&root);
    assert_eq!(items.len(), 1);
    assert_eq!((items[0].name.as_str(), items[0].from.as_deref(), items[0].kind.as_str()), ("a.md", Some("Docs/Deep/a.md"), "note"));

    // the folder it lived in went meanwhile: it is made again
    std::fs::remove_dir_all(root.join("Docs")).unwrap();
    let (path, kind) = restore(&root, None, Some("Docs/Deep/a.md")).unwrap();
    assert_eq!((path.as_str(), kind.as_str()), ("Docs/Deep/a.md", "note"));
    assert_eq!(read(&root, "Docs/Deep/a.md"), "A");
    assert!(list(&root).is_empty());
    assert!(!root.join(".trash/.index.json").exists(), "an empty index is not kept");
    assert!(restore(&root, None, Some("Docs/Deep/a.md")).is_err());
}

#[test]
fn restoring_never_overwrites() {
    let root = scratch("taken");
    put(&root, "a.md", "old");
    dispose(&root, "a.md", Entry::Note, None, "2026-09-14 101500").unwrap();
    put(&root, "a.md", "new");
    let (path, _) = restore(&root, None, Some("a.md")).unwrap();
    assert_eq!(path, "a 2.md");
    assert_eq!(read(&root, "a.md"), "new");
    assert_eq!(read(&root, "a 2.md"), "old");
}

#[test]
fn folders_and_files_and_the_newest_of_two() {
    let root = scratch("kinds");
    put(&root, "F/x.md", "1");
    put(&root, "F/pic.png", "P");
    dispose(&root, "F/pic.png", Entry::File, None, "2026-09-14 101500").unwrap();
    dispose(&root, "F", Entry::Folder, None, "2026-09-14 101501").unwrap();
    put(&root, "F/x.md", "2");
    dispose(&root, "F", Entry::Folder, None, "2026-09-14 101502").unwrap();
    let items = list(&root);
    assert_eq!(items.len(), 3);
    assert_eq!(items.iter().filter(|i| i.kind == "folder" && i.count == 1).count(), 2);

    // Ctrl+Z asks by path and gets the one deleted last... both share a
    // millisecond here, so ask by entry to be exact
    let newest = items.iter().find(|i| i.entry.starts_with("2026-09-14 101502")).unwrap().entry.clone();
    let (path, kind) = restore(&root, Some(&newest), None).unwrap();
    assert_eq!((path.as_str(), kind.as_str()), ("F", "folder"));
    assert_eq!(read(&root, "F/x.md"), "2");
    let (path, _) = restore(&root, None, Some("F/pic.png")).unwrap();
    assert_eq!(path, "F/pic.png");
}

#[test]
fn forever_skips_the_trash_and_checks_the_kind() {
    let root = scratch("forever");
    put(&root, "a.md", "A");
    put(&root, "F/b.md", "B");
    assert!(dispose(&root, "F", Entry::Note, Some("forever"), "s").is_err());
    assert!(dispose(&root, "", Entry::Folder, Some("forever"), "s").is_err(), "never the vault itself");
    assert!(dispose(&root, "../x", Entry::Folder, Some("forever"), "s").is_err());
    dispose(&root, "a.md", Entry::Note, Some("forever"), "s").unwrap();
    dispose(&root, "F", Entry::Folder, Some("forever"), "s").unwrap();
    assert!(!root.join("a.md").exists() && !root.join("F").exists());
    assert!(!root.join(".trash").exists());
}

#[test]
fn the_sweep_goes_by_the_stamp_never_by_file_dates() {
    let root = scratch("sweep");
    let at = stamp_ms("2026-09-14 101500 x.md").unwrap();
    assert_eq!(stamp_ms("Plan (before mcp 20260914-101500).md"), Some(at));
    assert_eq!(stamp_ms("holiday.png"), None);

    put(&root, ".trash/2026-09-14 101500 old.md", "o"); // no index line: a kept copy, aged by its name
    put(&root, ".trash/2026-09-20 101500 young.md", "y");
    put(&root, ".trash/by hand.md", "h"); // age unknown: never swept
    put(&root, "a.md", "A");
    dispose(&root, "a.md", Entry::Note, None, "2026-09-14 101500").unwrap();

    assert_eq!(sweep(&root, 0, at + 400 * DAY, 0), 0, "0 days keeps everything");
    assert_eq!(sweep(&root, 30, at + 3 * DAY, 0), 0);
    assert_eq!(sweep(&root, 3, at + 4 * DAY, at + 2 * DAY), 0, "nothing is older than the day the clean-up arrived");
    // the indexed one carries the real clock's time, so only the stamped old copy is due
    assert_eq!(sweep(&root, 3, at + 4 * DAY, 0), 1);
    let left: Vec<String> = list(&root).into_iter().map(|i| i.entry).collect();
    assert!(left.contains(&"by hand.md".to_string()) && left.contains(&"2026-09-20 101500 young.md".to_string()));
    assert!(!left.iter().any(|e| e.ends_with("old.md")));
}

#[test]
fn entries_are_plain_names_only() {
    let root = scratch("names");
    put(&root, ".trash/x.md", "x");
    put(&root, "keep.md", "k");
    for bad in ["", "..", ".index.json", "../keep.md", "a/b", "a\\b", "C:x"] {
        assert!(remove(&root, &[bad.to_string()]).is_err(), "removed {:?}", bad);
        assert!(restore(&root, Some(bad), None).is_err(), "restored {:?}", bad);
    }
    assert_eq!(read(&root, "keep.md"), "k");
    assert_eq!(remove(&root, &["x.md".to_string()]).unwrap(), 1);
}

