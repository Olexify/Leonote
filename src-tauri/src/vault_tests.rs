//! Tests for the Markdown vault. Hermetic: every test owns a temp directory,
//! and the migration tests use a fake home - never the user's real files.

use super::vault::*;
use serde_json::json;
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("leonote_vault_{}", name));
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

// ── paths ───────────────────────────────────────────────────────────────────

#[test]
fn unsafe_paths_are_rejected() {
    for bad in [
        "", "/abs.md", "C:/x.md", "a\\b.md", "../x.md", "a/../b.md", "./a.md", "a//b.md", "a/",
        ".trash/x.md", ".obsidian/a.md", "con.md", "Docs/AUX.md", "lpt1.txt.md", "a<b.md",
        "a?.md", "a*.md", "a|b.md", "a\"b.md", "dir./x.md", "dir /x.md", "a\nb.md",
    ] {
        assert!(resolve_note(Path::new("C:/vault"), bad).is_err(), "accepted {:?}", bad);
    }
}

#[test]
fn ordinary_paths_are_accepted() {
    let root = scratch("ok_paths");
    for good in ["Welcome.md", "Docs/Ideas/plan.md", "Нотатки/план.md", "a b/c-d_e (1).md", "console.md"] {
        let p = resolve_note(&root, good).unwrap_or_else(|e| panic!("{}: {}", good, e));
        assert!(p.starts_with(&root));
    }
    assert!(resolve_note(&root, "notes.txt").is_ok(), ".txt is a note too");
    assert!(resolve_note(&root, "notes.png").is_err(), "notes must be .md or .txt");
    assert!(resolve(&root, "Docs/Ideas").is_ok(), "folders need no extension");
}

#[test]
fn vault_location_precedence() {
    let home = Path::new("C:/Users/me");
    let s = json!({"vault": "D:/Notes"});
    assert_eq!(vault_root(Some("E:/V"), &s, home), PathBuf::from("E:/V"));
    assert_eq!(vault_root(Some(""), &s, home), PathBuf::from("D:/Notes"));
    assert_eq!(vault_root(None, &s, home), PathBuf::from("D:/Notes"));
    assert_eq!(vault_root(None, &json!({}), home), home.join("LeoNote"));
    assert_eq!(vault_root(None, &json!({"vault": ""}), home), home.join("LeoNote"));
    assert!(!is_default_vault(Some("E:/V"), &json!({})));
    assert!(!is_default_vault(None, &s));
    assert!(!is_default_vault(Some(" "), &s), "a blank env falls through to settings, like vault_root");
    assert!(is_default_vault(None, &json!({})));
    assert!(is_default_vault(Some(""), &json!({"vault": "  "})));
    assert!(is_default_vault(None, &serde_json::Value::Null));
}

// ── scan ────────────────────────────────────────────────────────────────────

#[test]
fn scan_skips_dot_entries_and_lists_empty_folders() {
    let root = scratch("scan");
    put(&root, "a.md", "A");
    put(&root, "Docs/Ideas/plan.md", "plan");
    put(&root, "Docs/readme.txt", "a text note");
    put(&root, ".obsidian/workspace.md", "hidden");
    put(&root, ".trash/2026 old.md", "trashed");
    put(&root, "Docs/.plan.md.tmp", "temp");
    put(&root, "Docs/.hidden.md", "hidden");
    std::fs::create_dir_all(root.join("Empty/Nested")).unwrap();

    let s = scan(&root, None);
    let paths: Vec<&str> = s.notes.iter().map(|n| n.path.as_str()).collect();
    assert_eq!(paths, vec!["Docs/Ideas/plan.md", "Docs/readme.txt", "a.md"]);
    assert_eq!(s.folders, vec!["Docs", "Docs/Ideas", "Empty", "Empty/Nested"]);
    assert_eq!(s.notes[2].content, "A");
    assert!(s.notes[2].mtime > 1_600_000_000_000, "mtime is epoch ms");
    assert!(s.files.is_empty(), "notes and dot entries are not files");
    assert_eq!(folders(&root, None), s.folders);
}

#[test]
fn our_own_data_folder_stays_out_of_the_users_tree() {
    let root = scratch("scan_data_root");
    put(&root, "a.md", "A");
    put(&root, "Docs/plan.md", "plan");
    // The "vault" data mode: a plain, Obsidian-visible folder holding our data.
    let data = root.join("LeoNote");
    put(&root, "LeoNote/log/ui.jsonl", "{}\n");
    put(&root, "LeoNote/tasks.json", "[]");
    put(&root, "LeoNote/stats.json", "{}");
    put(&root, "LeoNote/notes-of-ours.md", "not the user's");
    // A folder that merely starts the same is still theirs.
    put(&root, "LeoNotes/keep.md", "keep");

    let s = scan(&root, Some(&data));
    let notes: Vec<&str> = s.notes.iter().map(|n| n.path.as_str()).collect();
    assert_eq!(notes, vec!["Docs/plan.md", "LeoNotes/keep.md", "a.md"]);
    assert_eq!(s.folders, vec!["Docs", "LeoNotes"]);
    assert!(s.files.is_empty(), "no log or json of ours in the file list");
    assert_eq!(tree(&root, Some(&data)).folders, s.folders);
    assert_eq!(scan_under(&root, "", Some(&data)).len(), 3);
    // Without the skip it is all there, so the test proves the skip, not a
    // walk that never saw the folder.
    assert!(scan(&root, None).files.iter().any(|f| f.path.starts_with("LeoNote/")));
    // "vault-hidden" needs no skip at all: the dot rule already has it.
    let hidden = scratch("scan_data_root_hidden");
    put(&hidden, "a.md", "A");
    put(&hidden, ".leonote/log/ui.jsonl", "{}\n");
    assert_eq!(scan(&hidden, None).files.len(), 0);
    assert_eq!(scan(&hidden, None).notes.len(), 1);
}

// ── text notes and other files ──────────────────────────────────────────────

#[test]
fn txt_is_a_note_everywhere() {
    let root = scratch("txt_notes");
    put(&root, "Log/day.TXT", "plain");
    let s = scan(&root, None);
    let paths: Vec<&str> = s.notes.iter().map(|n| n.path.as_str()).collect();
    assert_eq!(paths, vec!["Log/day.TXT"]);
    assert_eq!(s.notes[0].content, "plain");
    assert!(s.files.is_empty(), "a note is not also a file");
    assert_eq!(read_note(&root, "Log/day.TXT").unwrap().content, "plain");

    write(&root, "Log/day.TXT", "edited").unwrap();
    assert_eq!(read(&root, "Log/day.TXT"), "edited");
    assert_eq!(create(&root, "Log/day.TXT", "again").unwrap(), "Log/day 1.TXT");
    rename(&root, "Log/day 1.TXT", "Log/renamed.txt", true).unwrap();
    assert_eq!(read(&root, "Log/renamed.txt"), "again");
    assert_eq!(trash(&root, "Log/renamed.txt", "s", true).unwrap(), "s renamed.txt");
    assert_eq!(read(&root, ".trash/s renamed.txt"), "again");
    for bad in ["../x.txt", "/x.txt", "C:/x.txt", ".obsidian/x.txt", "a\\b.txt", ".txt"] {
        assert!(write(&root, bad, "x").is_err(), "wrote {:?}", bad);
    }
    assert!(!is_note(".txt") && !is_note("Docs/.md"), "an extension alone is a dotfile");
    assert!(is_note("Board.excalidraw.md") && !is_note("a.md.png") && !is_note("README"));
    assert!(!is_note("Docs.md/readme"), "only the last segment counts");
}

#[test]
fn file_kinds() {
    for (name, kind) in [
        ("a.png", "image"), ("Pics/b.JPG", "image"), ("c.jpeg", "image"), ("d.gif", "image"),
        ("e.webp", "image"), ("f.svg", "image"), ("g.bmp", "image"), ("h.avif", "image"), ("i.ico", "image"),
        ("Scan.PDF", "pdf"),
        ("r.docx", "office"), ("r.doc", "office"), ("s.xlsx", "office"), ("s.xls", "office"),
        ("p.pptx", "office"), ("p.ppt", "office"), ("o.odt", "office"), ("o.ods", "office"),
        ("t.csv", "text"), ("t.json", "text"), ("t.yml", "text"), ("t.yaml", "text"), ("t.log", "text"),
        ("t.ini", "text"), ("t.toml", "text"), ("t.xml", "text"), ("t.js", "text"), ("t.ts", "text"),
        ("t.css", "text"), ("t.html", "text"), ("Board.canvas", "text"), ("Tasks.base", "text"),
        ("m.mp4", "media"), ("m.webm", "media"), ("m.mp3", "media"), ("m.wav", "media"),
        ("m.ogg", "media"), ("m.m4a", "media"),
        ("Shortcut.lnk", "other"), ("archive.zip", "archive"), ("README", "other"), (".png", "other"),
        ("dir.png/file", "other"), ("trailing.", "other"),
    ] {
        assert_eq!(file_kind(name), kind, "{}", name);
    }
}

#[test]
fn files_list_every_non_note_and_skip_dot_entries() {
    let root = scratch("files");
    put(&root, "a.md", "A");
    put(&root, "b.txt", "B");
    put(&root, "Board.excalidraw.md", "{}");
    put(&root, "Pics/shot.PNG", "12345");
    put(&root, "Pics/Deep/doc.pdf", "%PDF");
    put(&root, "Board.canvas", "{}");
    put(&root, "Link.lnk", "");
    put(&root, "README", "x");
    put(&root, ".obsidian/app.json", "{}");
    put(&root, ".trash/old.png", "x");
    put(&root, "Pics/.thumb.png", "x");
    put(&root, "Pics/.cache/c.png", "x");

    let s = scan(&root, None);
    let got: Vec<(&str, &str)> = s.files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
    assert_eq!(
        got,
        vec![
            ("Board.canvas", "text"),
            ("Link.lnk", "other"),
            ("Pics/Deep/doc.pdf", "pdf"),
            ("Pics/shot.PNG", "image"),
            ("README", "other"),
        ]
    );
    let shot = s.files.iter().find(|f| f.path == "Pics/shot.PNG").unwrap();
    assert_eq!(shot.size, 5);
    assert!(shot.mtime > 1_600_000_000_000, "mtime is epoch ms");
    assert_eq!(s.notes.len(), 3);
    assert_eq!(s.folders, vec!["Pics", "Pics/Deep"]);
    let t = tree(&root, None);
    assert_eq!(t.files, s.files, "the watcher's listing agrees with boot's");
    assert_eq!(t.folders, s.folders);
    assert!(t.notes.is_empty(), "the light walk reads no notes");
}

#[test]
fn file_read_text_is_bounded_and_text_only() {
    let root = scratch("file_read");
    put(&root, "Board.canvas", "{\"nodes\":[]}");
    assert_eq!(read_file_text(&root, "Board.canvas").unwrap(), "{\"nodes\":[]}");
    std::fs::write(root.join("latin1.csv"), b"caf\xe9").unwrap();
    assert_eq!(read_file_text(&root, "latin1.csv").unwrap(), "caf\u{FFFD}", "lossy UTF-8");
    std::fs::write(root.join("max.log"), vec![b'a'; MAX_TEXT_READ as usize]).unwrap();
    assert_eq!(read_file_text(&root, "max.log").unwrap().len(), MAX_TEXT_READ as usize);
    std::fs::write(root.join("big.log"), vec![b'a'; MAX_TEXT_READ as usize + 1]).unwrap();
    assert!(read_file_text(&root, "big.log").unwrap_err().contains("larger"));
    put(&root, "pic.png", "x");
    put(&root, "n.md", "x");
    put(&root, ".obsidian/app.json", "{}");
    put(&root, "Dir.json/inner.md", "");
    for bad in [
        "pic.png", "n.md", "missing.json", ".obsidian/app.json", "../x.json", "a/../Board.canvas",
        "/Board.canvas", "C:/x.json", "a\\b.json", "", "Dir.json",
    ] {
        assert!(read_file_text(&root, bad).is_err(), "read {:?}", bad);
    }
}

#[test]
fn files_rename_and_trash_like_notes() {
    let root = scratch("file_ops");
    put(&root, "Pics/a.png", "PNG");
    put(&root, "Pics/taken.png", "T");
    put(&root, "n.md", "N");
    rename_file(&root, "Pics/a.png", "Archive/2026/b.webp").unwrap();
    assert_eq!(read(&root, "Archive/2026/b.webp"), "PNG");
    assert!(!root.join("Pics/a.png").exists());
    assert!(rename_file(&root, "Archive/2026/b.webp", "Pics/taken.png").is_err(), "never overwrites");
    assert!(rename_file(&root, "Archive/2026/b.webp", "b.md").is_err(), "a file does not become a note");
    assert!(rename_file(&root, "n.md", "n.png").is_err(), "notes move through the note command");
    assert!(rename_file(&root, "Pics", "Pics2").is_err(), "a folder is not a file");
    assert!(rename_file(&root, "missing.png", "m2.png").is_err());
    rename_file(&root, "Pics/taken.png", "Pics/Taken.png").unwrap(); // case-only
    for bad in ["../x.png", "/x.png", "C:/x.png", ".trash/x.png", "Pics\\x.png", "a/../x.png"] {
        assert!(rename_file(&root, "Pics/Taken.png", bad).is_err(), "renamed to {:?}", bad);
        assert!(rename_file(&root, bad, "ok.png").is_err(), "renamed from {:?}", bad);
        assert!(trash_file(&root, bad, "s").is_err(), "trashed {:?}", bad);
    }
    assert_eq!(trash_file(&root, "Pics/Taken.png", "2026-09-15 101500").unwrap(), "2026-09-15 101500 Taken.png");
    assert_eq!(read(&root, ".trash/2026-09-15 101500 Taken.png"), "T");
    assert!(trash_file(&root, "n.md", "s").is_err(), "a note is trashed as a note");
    assert!(trash_file(&root, "Archive", "s").is_err(), "a folder is trashed as a folder");
    let files: Vec<String> = scan(&root, None).files.into_iter().map(|f| f.path).collect();
    assert_eq!(files, vec!["Archive/2026/b.webp"], "trash is invisible");
}

#[test]
fn launchable_types_are_recognised() {
    for l in ["run.sh", "a.bash", "x.pyc", "t.pl", "t.rb", "b.xlsb", "o.dot", "s.pps", "d.accdb", "w.wsb"] { assert!(is_launchable(l), "{}", l); }
    for l in ["x.chm", "disk.iso", "a.vhdx", "b.xlsm", "c.library-ms", "run.py", "w.pyw", "pc.rdp", "dark.theme", "kb.msu"] { assert!(is_launchable(l), "{}", l); }
    // as Windows reads the name: a trailing dot or space dropped, a stream left off, a full path
    for l in ["run.exe", "a.BAT", "x.cmd", "s.ps1", "w.vbs", "tool.js", "Shortcut.lnk", "site.url", "setup.msi", "p.hta", "Dir/deep.scr", "evil.exe.", "evil.exe ", "evil.exe. .", "evil.bat:stream", "notes.txt:evil.exe",r"C:\Users\x\Downloads\evil.exe."] {
        assert!(is_launchable(l), "{}", l);
    }
    for l in ["q.iqy", "s.slk", "d.dqy", "root.cer", "root.crt", "a.appxbundle", "b.msixbundle", "e.vsix", "f.ocx", "page.mht", "p.ppkg", "a.app", "m.asx", "b.bgi", "o.ops", "c.pcd", "z.cab", "t.tmp", "o.pst"] { assert!(is_launchable(l), "{}", l); }
    for s in ["a.png", "b.pdf", "c.docx", "old.doc", "d.md", "e.txt", "f.canvas", "exe", "README", "run.exe/inside.png"] {
        assert!(!is_launchable(s), "{}", s);
    }
}

#[test]
fn a_renamed_picture_keeps_its_edits() {
    let root = scratch("sidecar_rename");
    put(&root, "Ideas/a.png", "P");
    put(&root, "Ideas/.leonote/a.png.leoedit.json", "{}");
    rename_file(&root, "Ideas/a.png", "Other/b.png").unwrap();
    assert_eq!(read(&root, "Other/.leonote/b.png.leoedit.json"), "{}");
    assert!(!root.join("Ideas/.leonote/a.png.leoedit.json").exists(), "a later a.png must not get them");
}

#[test]
fn a_huge_note_file_is_listed_as_a_file_and_not_read() {
    let root = scratch("huge");
    put(&root, "ok.md", "x");
    let big = root.join("big.log.txt");
    std::fs::File::create(&big).unwrap().set_len(MAX_NOTE + 1).unwrap();
    for s in [scan(&root, None), tree(&root, None)] {
        assert!(!s.notes.iter().any(|n| n.path == "big.log.txt"));
        assert_eq!(s.files.iter().find(|f| f.path == "big.log.txt").unwrap().kind, "other");
    }
    assert_eq!(scan(&root, None).notes.len(), 1);
    assert!(read_note(&root, "big.log.txt").is_none());
    assert!(file_entry(&root, "big.log.txt").is_ok(), "it can still be opened, renamed and trashed");
    assert!(file_entry(&root, "ok.md").is_err(), "an ordinary note is still a note");
    assert!(rename_file(&root, "ok.md", "ok2.md").is_err(), "and is not renamed as a file");
    rename_file(&root, "big.log.txt", "Sub/big2.txt").unwrap();
    crate::trashbin::dispose(&root, "Sub/big2.txt", Entry::File, None, "2026-01-01 000000").unwrap();
    let (got, kind) = crate::trashbin::restore(&root, None, Some("Sub/big2.txt")).unwrap();
    assert_eq!((got.as_str(), kind.as_str()), ("Sub/big2.txt", "file"));
    assert_eq!(std::fs::metadata(root.join("Sub/big2.txt")).unwrap().len(), MAX_NOTE + 1);
    let _ = std::fs::remove_dir_all(&root);
}

// a writer that allows writing but not deleting: the rename is refused, the text goes into place
#[cfg(windows)]
#[test]
fn a_file_held_open_is_written_in_place_at_exactly_the_new_length() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = scratch("held");
    put(&root, "n.md", "the old text, rather long");
    let held = std::fs::OpenOptions::new().read(true).share_mode(1 | 2).open(root.join("n.md")).unwrap();
    write_atomic(&root.join("n.md"), b"short").unwrap();
    assert_eq!(read(&root, "n.md"), "short");
    write_atomic(&root.join("n.md"), b"a good deal longer than it was").unwrap();
    assert_eq!(read(&root, "n.md"), "a good deal longer than it was");
    drop(held);
    assert!(!root.join(".n.md.tmp").exists());
}

// a link planted at the temp name is replaced, never written through (skipped where links cannot be made)
#[test]
fn a_link_at_the_temp_name_is_not_written_through() {
    let root = scratch("tmplink");
    let outside = scratch("tmplink_out").join("target.txt");
    std::fs::write(&outside, "untouched").unwrap();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(&outside, root.join(".n.md.tmp")).is_ok();
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&outside, root.join(".n.md.tmp")).is_ok();
    if !made { return; }
    write_atomic(&root.join("n.md"), b"the note").unwrap();
    assert_eq!(read(&root, "n.md"), "the note");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
}

// ── write / create ──────────────────────────────────────────────────────────

#[test]
fn write_is_atomic_creates_parents_and_leaves_no_temp() {
    let root = scratch("write");
    let m = write(&root, "Deep/Er/n.md", "one").unwrap();
    assert!(m > 0);
    write(&root, "Deep/Er/n.md", "two").unwrap();
    assert_eq!(read(&root, "Deep/Er/n.md"), "two");
    let names: Vec<String> = std::fs::read_dir(root.join("Deep/Er"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["n.md"], "temp file left behind");
    assert!(write(&root, "../escape.md", "x").is_err());
}

#[test]
fn create_never_overwrites_and_suffixes() {
    let root = scratch("create");
    assert_eq!(create(&root, "F/Idea.md", "1").unwrap(), "F/Idea.md");
    assert_eq!(create(&root, "F/Idea.md", "2").unwrap(), "F/Idea 1.md");
    assert_eq!(create(&root, "F/Idea.md", "3").unwrap(), "F/Idea 2.md");
    assert_eq!(read(&root, "F/Idea.md"), "1");
    assert_eq!(read(&root, "F/Idea 2.md"), "3");
}

// ── rename ──────────────────────────────────────────────────────────────────

#[test]
fn rename_refuses_to_overwrite() {
    let root = scratch("rename_refuse");
    put(&root, "a.md", "A");
    put(&root, "b.md", "B");
    assert!(rename(&root, "a.md", "b.md", true).is_err());
    assert_eq!(read(&root, "b.md"), "B");
    assert!(rename(&root, "missing.md", "c.md", true).is_err());
}

#[test]
fn rename_moves_into_new_folders() {
    let root = scratch("rename_move");
    put(&root, "a.md", "A");
    rename(&root, "a.md", "New/Place/a2.md", true).unwrap();
    assert_eq!(read(&root, "New/Place/a2.md"), "A");
    assert!(!root.join("a.md").exists());
}

#[test]
fn case_only_rename_works() {
    let root = scratch("rename_case");
    put(&root, "note.md", "N");
    rename(&root, "note.md", "Note.md", true).unwrap();
    let names: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["Note.md"]);
}

#[test]
fn folder_rename_and_self_nesting() {
    let root = scratch("rename_folder");
    put(&root, "Old/x.md", "X");
    rename(&root, "Old", "Archive/New", false).unwrap();
    assert_eq!(read(&root, "Archive/New/x.md"), "X");
    assert!(rename(&root, "Archive", "Archive/Inner", false).is_err());
    assert!(rename(&root, "Archive/New/x.md", "y.md", false).is_err(), "a file is not a folder");
    put(&root, "Taken/k.md", "");
    assert!(rename(&root, "Archive", "Taken", false).is_err());
}

// ── trash / mkdir ───────────────────────────────────────────────────────────

#[test]
fn trash_moves_never_deletes() {
    let root = scratch("trash");
    put(&root, "Docs/a.md", "A");
    let e = trash(&root, "Docs/a.md", "2026-09-14 101500", true).unwrap();
    assert_eq!(e, "2026-09-14 101500 a.md");
    assert_eq!(read(&root, ".trash/2026-09-14 101500 a.md"), "A");
    put(&root, "a.md", "again");
    assert_eq!(trash(&root, "a.md", "2026-09-14 101500", true).unwrap(), "2026-09-14 101500 1 a.md");

    trash(&root, "Docs", "2026-09-14 101501", false).unwrap();
    assert!(root.join(".trash/2026-09-14 101501 Docs").is_dir());
    assert!(!root.join("Docs").exists());
    assert!(scan(&root, None).notes.is_empty(), "trash is invisible to scan");
}

#[test]
fn trash_checks_the_kind() {
    let root = scratch("trash_kind");
    put(&root, "F/a.md", "");
    assert!(trash(&root, "F", "s", true).is_err());
    mkdir(&root, "G/H").unwrap();
    assert!(root.join("G/H").is_dir());
    assert!(mkdir(&root, ".git").is_err());
}

// ── migration ───────────────────────────────────────────────────────────────

fn fake_home(name: &str) -> (PathBuf, PathBuf) {
    let base = scratch(name);
    let home = base.join("home");
    let vault = base.join("home").join("LeoNote");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join(".leonote_docs.json"),
        json!([
            {"id":"1","title":"Plan","body":"# plan","created":"2026-07-01T10:00:00","updated":"2026-07-29T00:42:57","deleted":false,"category":"Default"},
            {"id":"2","title":"Plan","body":"dup","created":"","updated":"","deleted":false},
            {"id":"3","title":"a/b: c?","body":"work","deleted":false,"category":"Work"},
            {"id":"4","title":"gone","body":"x","deleted":true,"category":"Work"},
            {"id":"5","title":"  ","body":"untitled","deleted":false,"category":""}
        ])
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        home.join(".leonote_priorities.json"),
        json!([
            {"id":"p","title":"Ship v1","notes":"Focus hard.","subtasks":[{"id":"s1","text":"tests","done":true},{"id":"s2","text":"docs","done":false}]},
            {"id":"q","title":"Rest","notes":"just notes","subtasks":[]}
        ])
        .to_string(),
    )
    .unwrap();
    (home, vault)
}

#[test]
fn migration_imports_docs_once_and_leaves_priorities_alone() {
    let (home, vault) = fake_home("migrate");
    let docs_before = std::fs::read(home.join(".leonote_docs.json")).unwrap();

    assert!(migrate(&vault, &home).unwrap());
    assert!(read(&vault, "Welcome.md").contains("[[Welcome]]"));
    assert_eq!(read(&vault, "Docs/Plan.md"), "# plan");
    assert_eq!(read(&vault, "Docs/Plan 1.md"), "dup");
    assert_eq!(read(&vault, "Docs/Work/a-b- c-.md"), "work");
    assert_eq!(read(&vault, "Docs/Untitled.md"), "untitled");
    assert!(!vault.join("Docs/Work/gone.md").exists(), "deleted docs are skipped");
    assert!(!vault.join("Focus").exists(), "focus areas live in the Focus view, not as notes");

    // mtime follows `updated` (local time)
    let want = chrono::NaiveDateTime::parse_from_str("2026-07-29T00:42:57", "%Y-%m-%dT%H:%M:%S")
        .unwrap()
        .and_local_timezone(chrono::Local)
        .earliest()
        .unwrap()
        .timestamp_millis() as u64;
    let got = scan(&vault, None).notes.iter().find(|n| n.path == "Docs/Plan.md").unwrap().mtime;
    assert_eq!(got / 1000, want / 1000);

    let count = scan(&vault, None).notes.len();
    assert!(!migrate(&vault, &home).unwrap(), "second run is a no-op");
    assert_eq!(scan(&vault, None).notes.len(), count);
    assert_eq!(std::fs::read(home.join(".leonote_docs.json")).unwrap(), docs_before, "source untouched");
}

#[test]
fn migration_keeps_an_existing_welcome_and_tolerates_missing_sources() {
    let base = scratch("migrate_empty");
    let vault = base.join("v");
    put(&vault, "Welcome.md", "mine");
    assert!(migrate(&vault, &base.join("nohome")).unwrap());
    assert_eq!(read(&vault, "Welcome.md"), "mine");
    assert_eq!(scan(&vault, None).notes.len(), 1);
}

/// Everything under `root`, dot entries included - "wrote nothing" must mean nothing.
fn all_entries(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            out.push(e.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            }
        }
    }
    out.sort();
    out
}

#[test]
fn migration_never_touches_a_vault_the_user_already_has() {
    // a picked vault (e.g. Obsidian) that already holds a note
    let (home, _) = fake_home("migrate_user_vault");
    let vault = home.parent().unwrap().join("MyVault");
    put(&vault, "Projects/idea.md", "mine");
    put(&vault, "img.png", "PNG");
    let before = all_entries(&vault);

    assert!(!migrate_on_boot(&vault, &home, false).unwrap());
    assert!(!vault.join("Welcome.md").exists());
    assert!(!vault.join("Docs").exists());
    assert!(!vault.join(".leonote").exists(), "not even the marker");
    assert_eq!(all_entries(&vault), before, "nothing written");
    assert!(!migrate_on_boot(&vault, &home, false).unwrap(), "and the same on every boot");

    // a .txt note counts too, and so does a fresh Obsidian vault with no notes yet
    let txt = home.parent().unwrap().join("TxtVault");
    put(&txt, "log.txt", "mine");
    assert!(!migrate_on_boot(&txt, &home, false).unwrap());
    let obs = home.parent().unwrap().join("FreshObsidian");
    put(&obs, ".obsidian/app.json", "{}");
    assert!(!migrate_on_boot(&obs, &home, false).unwrap());
    assert_eq!(all_entries(&obs), vec![".obsidian", ".obsidian/app.json"]);
}

#[test]
fn migration_still_seeds_the_default_vault_and_an_empty_picked_folder() {
    let (home, vault) = fake_home("migrate_gate_default");
    put(&vault, "already.md", "notes from before the import");
    assert!(migrate_on_boot(&vault, &home, true).unwrap(), "the default vault always migrates");
    assert_eq!(read(&vault, "Docs/Plan.md"), "# plan");
    assert!(!migrate_on_boot(&vault, &home, true).unwrap(), "once");

    let (home2, _) = fake_home("migrate_gate_empty");
    let picked = home2.parent().unwrap().join("NewFolder");
    put(&picked, "Pics/only-an-image.png", "PNG");
    assert!(migrate_on_boot(&picked, &home2, false).unwrap(), "no notes yet: seed it");
    assert!(picked.join("Welcome.md").exists());
    assert!(!migrate_on_boot(&picked, &home2, false).unwrap());
}

#[test]
fn filenames_are_sanitized() {
    assert_eq!(sanitize_name(""), "Untitled");
    assert_eq!(sanitize_name("..."), "Untitled");
    assert_eq!(sanitize_name(".hidden"), "hidden");
    assert_eq!(sanitize_name("a\nb\tc"), "a b c");
    assert_eq!(sanitize_name("x [[y]] #z"), "x --y-- -z");
    assert_eq!(sanitize_name("trail. "), "trail");
    assert_eq!(sanitize_name("CON"), "_CON");
    assert_eq!(sanitize_name(&"я".repeat(300)).chars().count(), 120);
    for t in ["a/b", "CON", "x:y", "..", "a. "] {
        assert!(check_rel(&format!("{}.md", sanitize_name(t))).is_ok(), "{}", t);
    }
}

#[test]
fn code_files_are_text_and_office_edits_are_limited() {
    for f in ["a.py", "b.rs", "c.tsx", "d.go", "e.sql", "f.ps1", "g.yaml", "h.css"] {
        assert_eq!(file_kind(f), "text", "{}", f);
        assert!(is_writable(f), "{}", f);
    }
    assert!(is_writable("x.docx") && is_writable("x.xlsx") && is_writable("p.webp"));
    // Leonote writes PDFs itself now (marks, page order, filled forms)
    assert!(is_writable("x.pdf") && is_writable("Reports/Q3 report.PDF"));
    // an animation saved as a video, and the vector drawings' own files
    assert!(is_writable("Art/loop.mp4") && is_writable("Art/loop.webm"));
    assert_eq!(file_kind("Board.leopaint"), "text");
    assert_eq!(file_kind("Poster.leostudio"), "other");
    assert!(is_writable("Reels/Meme.leovideo"));
    assert_eq!(file_kind("x.pdf"), "pdf");
    assert!(!is_writable("x.doc") && !is_writable("x.xls") && !is_writable("x.pptx"));
    assert!(!is_writable("app.exe") && !is_writable("n.md"));
}

/// A PDF must go through the same door as everything else Leonote writes:
/// inside the vault, and never overwritten before a copy is in .trash.
#[test]
fn pdf_writes_are_vault_bound_and_backed_up() {
    let root = std::env::temp_dir().join(format!("leonote_pdfw_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Docs")).unwrap();
    std::fs::write(root.join("Docs/brief.pdf"), b"%PDF-1.7 original").unwrap();

    // the path still has to resolve inside the vault
    assert!(resolve_file(&root, "../escape.pdf").is_err());
    assert!(resolve_file(&root, "Docs/brief.pdf").is_ok());

    let kept = backup_file(&root, "Docs/brief.pdf", "2026-09-18 120000").unwrap();
    write_atomic(&root.join("Docs/brief.pdf"), b"%PDF-1.7 edited").unwrap();
    assert_eq!(std::fs::read(root.join(".trash").join(&kept)).unwrap(), b"%PDF-1.7 original");
    assert_eq!(std::fs::read(root.join("Docs/brief.pdf")).unwrap(), b"%PDF-1.7 edited");
    let e = file_entry(&root, "Docs/brief.pdf").unwrap();
    assert_eq!(e.kind, "pdf");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn backup_copies_into_trash_without_clobbering() {
    let root = std::env::temp_dir().join(format!("leonote_backup_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("code")).unwrap();
    std::fs::write(root.join("code/a.py"), "print(1)").unwrap();
    let first = backup_file(&root, "code/a.py", "2026-09-17 101010").unwrap();
    let second = backup_file(&root, "code/a.py", "2026-09-17 101010").unwrap();
    assert_ne!(first, second);
    assert_eq!(std::fs::read_to_string(root.join(".trash").join(&first)).unwrap(), "print(1)");
    assert!(root.join("code/a.py").exists(), "the original stays");
    let e = file_entry(&root, "code/a.py").unwrap();
    assert_eq!((e.size, e.kind), (8, "text"));
    let _ = std::fs::remove_dir_all(&root);
}

/// An outside file opened in Leonote goes through the file commands under its
/// guest name - that file, and nothing beside it.
#[test]
fn a_guest_is_exactly_its_own_file() {
    let dir = std::env::temp_dir().join(format!("leonote-guest-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("Report.docx");
    std::fs::write(&f, b"x").unwrap();
    let id = guest_id(&f);
    GUESTS.lock().unwrap().insert(id.clone(), f.clone());
    let root = dir.join("vault");
    assert_eq!(resolve(&root, &format!("@guest/{}/Report.docx", id)).unwrap(), f);
    assert!(resolve(&root, &format!("@guest/{}/Other.mp4", id)).is_err(), "a sibling is not the guest");
    assert!(resolve(&root, "@guest/nope/Report.docx").is_err());
    assert_eq!(file_entry(&root, &format!("@guest/{}/Report.docx", id)).unwrap().kind, "office");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Moving or deleting an outside file by its guest name, past the question Windows asks, is refused.
#[test]
fn a_guest_cannot_be_moved_or_deleted() {
    let dir = std::env::temp_dir().join(format!("leonote-guest-keep-{}", std::process::id()));
    let root = dir.join("vault");
    std::fs::create_dir_all(&root).unwrap();
    let f = dir.join("Outside.md");
    std::fs::write(&f, b"x").unwrap();
    let id = guest_id(&f);
    GUESTS.lock().unwrap().insert(id.clone(), f.clone());
    let g = format!("@guest/{}/Outside.md", id);
    assert!(destroy(&root, &g, Entry::Note).is_err());
    assert!(trash(&root, &g, "2026-01-01 000000", true).is_err());
    assert!(rename(&root, &g, "Inside.md", true).is_err());
    assert!(f.exists() && !root.join("Inside.md").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_folder_kept_out_of_the_index_is_not_scanned_and_found_only_on_request() {
    let root = std::env::temp_dir().join(format!("leo-noindex-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Zz-NoIndex/Chats")).unwrap();
    std::fs::write(root.join("Zz-NoIndex/Chats/log.md"), "we talked about baka mitai").unwrap();
    std::fs::write(root.join("Zz-NoIndex/kept.md"), "a note that stays").unwrap();
    std::fs::write(root.join("top.md"), "top").unwrap();
    set_no_index(&[r"zz-noindex\chats".to_string()]);
    let s = scan(&root, None);
    let names: Vec<&str> = s.notes.iter().map(|n| n.path.as_str()).collect();
    assert!(names.contains(&"top.md") && names.contains(&"Zz-NoIndex/kept.md"), "{names:?}");
    assert!(!names.iter().any(|n| n.contains("Chats")), "not-indexed: {names:?}");
    assert!(not_indexed("Zz-NoIndex/Chats/log.md") && !not_indexed("Zz-NoIndex/Chatsx/a.md"));
    let found = crate::external::find_unindexed(&root, "BAKA mitai", 10);
    assert_eq!(found.len(), 1);
    assert!(found[0]["snippet"].as_str().unwrap().contains("baka mitai"));
    // nothing outside the vault, by any spelling
    set_no_index(&["C:/Users/Alex".to_string(), "../up".to_string(), ".git".to_string(), "/abs".to_string()]);
    assert_eq!(no_index(), vec!["abs".to_string()], "a leading slash is only trimmed; the rest are refused");
    set_no_index(&[]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn every_windows_device_name_is_refused() {
    use crate::vault::{check_rel, is_device_name};
    for s in ["CON", "nul", "Com1", "COM0", "LPT9", "LPT0", "COM¹", "lpt³", "CONIN$", "conout$", "AUX "] { assert!(is_device_name(s), "{s}"); }
    for s in ["CONSOLE", "COM10", "LPT", "COMA", "NULL", "Notes"] { assert!(!is_device_name(s), "{s}"); }
    assert!(check_rel("Ideas/COM0.md").is_err());
    assert!(check_rel("Ideas/LPT².txt").is_err());
    assert!(check_rel("Ideas/note.md:stream").is_err());
    assert!(check_rel("Ideas/Console.md").is_ok());
}

#[test]
fn a_note_too_big_to_read_back_is_never_written() {
    let root = scratch("too_big");
    let big = "x".repeat(MAX_NOTE as usize + 1);
    assert!(write(&root, "a.md", &big).is_err());
    assert!(create(&root, "b.md", &big).is_err());
    assert!(!root.join("a.md").exists() && !root.join("b.md").exists());
    assert!(write(&root, "a.md", "small").is_ok());
}

#[test]
fn a_network_path_is_refused_before_anything_looks_at_it() {
    let root = scratch("far_paths");
    for p in ["//127.0.0.1/c$/x.md", "C:/x.md", "../x.md"] {
        assert!(resolve_file(&root, p).is_err(), "{p}");
        assert!(resolve_note(&root, p).is_err(), "{p}");
    }
    std::fs::write(root.join("pic.png"), b"x").unwrap();
    assert!(resolve_file(&root, "pic.png").is_ok());
}

// a note named near Windows' 255 limit outside Leonote can still be saved and trashed
#[test]
fn a_very_long_name_can_be_saved_and_trashed() {
    let root = scratch("long");
    let name = format!("{}.md", "n".repeat(245));
    put(&root, &name, "old");
    write_atomic(&root.join(&name), b"new").unwrap();
    assert_eq!(read(&root, &name), "new");
    let entry = trash(&root, &name, "2026-11-13 120000", true).unwrap();
    assert!(entry.ends_with(".md") && entry.len() < 255, "{entry}");
    assert!(!root.join(&name).exists());
}

/// What a start costs on a big vault: 5000 notes of ~2 KB, read the way boot reads them. Run by hand:
/// cargo test --release --lib -- --ignored scan_of_a_big_vault --nocapture
#[test]
#[ignore]
fn scan_of_a_big_vault_measured() {
    let root = std::env::temp_dir().join("leonote_bigvault");
    if !root.join("f49").exists() {
        for d in 0..50 {
            let dir = root.join(format!("f{d}"));
            std::fs::create_dir_all(&dir).unwrap();
            for n in 0..100 {
                let body = format!("---\ntags: [a{d}]\n---\n# Note {d}-{n}\n\n{}\n- [ ] a task [[Note {}-{}]] #t{n}\n", "Some words of a paragraph. ".repeat(70), (d + 1) % 50, n);
                std::fs::write(dir.join(format!("Note {d}-{n}.md")), body).unwrap();
            }
        }
    }
    for _ in 0..3 {
        let t = std::time::Instant::now();
        let s = scan(&root, None);
        eprintln!("scan: {} notes in {:?}", s.notes.len(), t.elapsed());
    }
}
