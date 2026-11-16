//! Tests for watcher path classification and note echo memory. No watcher;
//! only the batch-effects test touches a (temp) filesystem.

use super::vault;
use super::watch::*;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn targets() -> Targets {
    Targets {
        vault: PathBuf::from(r"C:\Users\me\LeoNote"),
        log_dir: PathBuf::from(r"C:\Users\me\.leonote\log"),
        snapshot: PathBuf::from(r"C:\Users\me\.leonote_tasks.json"),
        habits: PathBuf::from(r"C:\Users\me\.leonote_habits.json"),
        data_root: PathBuf::from(r"C:\Users\me\.leonote"),
    }
}

fn k(p: &str) -> Kind {
    classify(Path::new(p), &targets())
}

/// The "vault" data mode: our data root is a plain folder INSIDE the vault.
fn vault_mode_targets() -> Targets {
    let root = PathBuf::from(r"C:\Users\me\LeoNote\LeoNote");
    Targets {
        vault: PathBuf::from(r"C:\Users\me\LeoNote"),
        log_dir: root.join("log"),
        snapshot: root.join("tasks.json"),
        habits: root.join("habits.json"),
        data_root: root,
    }
}

fn kv(p: &str) -> Kind {
    classify(Path::new(p), &vault_mode_targets())
}

#[test]
fn vault_paths() {
    assert_eq!(k(r"C:\Users\me\LeoNote\a.md"), Kind::Note("a.md".into()));
    assert_eq!(k(r"C:\Users\me\LeoNote\Docs\Ideas\plan.MD"), Kind::Note("Docs/Ideas/plan.MD".into()));
    // other casing and the verbatim prefix still match, and keep the event's casing
    assert_eq!(k(r"\\?\c:\users\ME\leonote\Docs\x.md"), Kind::Note("Docs/x.md".into()));
    assert_eq!(k("C:/Users/me/LeoNote/Docs"), Kind::VaultOther("Docs".into()));
    assert_eq!(k(r"C:\Users\me\LeoNote\img.png"), Kind::VaultOther("img.png".into()));
    assert_eq!(k(r"C:\Users\me\LeoNote"), Kind::VaultOther("".into()));
}

#[test]
fn txt_files_are_notes() {
    assert_eq!(k(r"C:\Users\me\LeoNote\Log\day.TXT"), Kind::Note("Log/day.TXT".into()));
    assert_eq!(k(r"C:\Users\me\LeoNote\Board.excalidraw.md"), Kind::Note("Board.excalidraw.md".into()));
    assert_eq!(k(r"C:\Users\me\LeoNote\Board.canvas"), Kind::VaultOther("Board.canvas".into()));
    assert_eq!(k(r"C:\Users\me\LeoNote\Docs.txt\img.png"), Kind::VaultOther("Docs.txt/img.png".into()));
    assert_eq!(k(r"C:\Users\me\LeoNote\.txt"), Kind::Ignored);
}

#[test]
fn our_own_data_inside_the_vault_is_ignored() {
    // The three the watcher acts on keep working from inside the vault.
    assert_eq!(kv(r"C:\Users\me\LeoNote\LeoNote\log\ui.jsonl"), Kind::Log("ui".into()));
    assert_eq!(kv(r"C:\Users\me\LeoNote\LeoNote\tasks.json"), Kind::Snapshot);
    assert_eq!(kv(r"C:\Users\me\LeoNote\LeoNote\habits.json"), Kind::Habits);
    // Everything else there is ours, not a change to the user's tree: without
    // this, every stats or positions save rebuilt the whole file list.
    for ours in [
        r"C:\Users\me\LeoNote\LeoNote\stats.json",
        r"C:\Users\me\LeoNote\LeoNote\positions.json",
        r"C:\Users\me\LeoNote\LeoNote\recurring.json",
        r"C:\Users\me\LeoNote\LeoNote\priorities.json",
        r"C:\Users\me\LeoNote\LeoNote\base.snapshot.json",
        r"C:\Users\me\LeoNote\LeoNote",
        r"c:\users\me\leonote\leonote\stats.json",
    ] {
        assert_eq!(kv(ours), Kind::Ignored, "{}", ours);
    }
    // The user's own notes and files are untouched by the rule.
    assert_eq!(kv(r"C:\Users\me\LeoNote\a.md"), Kind::Note("a.md".into()));
    assert_eq!(kv(r"C:\Users\me\LeoNote\Docs\plan.md"), Kind::Note("Docs/plan.md".into()));
    assert_eq!(kv(r"C:\Users\me\LeoNote\img.png"), Kind::VaultOther("img.png".into()));
    // A note whose folder merely starts with the same letters is not inside it.
    assert_eq!(kv(r"C:\Users\me\LeoNote\LeoNotes\a.md"), Kind::Note("LeoNotes/a.md".into()));
}

#[test]
fn user_mode_classification_is_unchanged() {
    // data_root is ~/.leonote, outside the vault: the rule never fires and
    // every path lands where it always did.
    assert_eq!(k(r"C:\Users\me\.leonote\log\ui.jsonl"), Kind::Log("ui".into()));
    assert_eq!(k(r"C:\Users\me\.leonote_tasks.json"), Kind::Snapshot);
    assert_eq!(k(r"C:\Users\me\.leonote_habits.json"), Kind::Habits);
    assert_eq!(k(r"C:\Users\me\.leonote\stats.json"), Kind::Ignored);
    assert_eq!(k(r"C:\Users\me\LeoNote\a.md"), Kind::Note("a.md".into()));
    // an agent's proposal is heard of; anything else in that folder (done/, temp files) is not
    assert_eq!(k(r"C:\Users\me\.leonote\proposals\p1.json"), Kind::Proposals);
    assert_eq!(k(r"C:\Users\me\.leonote\proposals\done\p1.json"), Kind::Ignored);
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_burst_of_pastes_is_one_files_update() {
    let root = std::env::temp_dir().join("leonote_watch_paste_burst");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Pics")).unwrap();
    std::fs::write(root.join("Pics/n.md"), "note").unwrap();
    let boot = vault::scan(&root, None);
    let mut echo = Echo::default();
    echo.reset_notes(&boot.notes);
    echo.folders = boot.folders.clone();
    assert!(!echo.set_files(boot.files), "boot state is not news");

    // 50 pastes land in one batch: 50 file events plus the folder itself
    let mut others = set(&["Pics"]);
    for i in 0..50 {
        let rel = format!("Pics/paste {}.png", i);
        std::fs::write(root.join(&rel), [0u8; 16]).unwrap();
        others.insert(rel);
    }
    let fx = vault_effects(&root, None, others, &BTreeSet::new(), &mut echo, false);
    assert!(fx.files_dirty && !fx.folders_dirty && fx.changes.is_empty());
    // the batch walks once and emits once; the same list again emits nothing
    let files = vault::tree(&root, None).files;
    assert_eq!(files.len(), 50);
    assert!(files.iter().all(|f| f.kind == "image" && f.size == 16));
    assert!(echo.set_files(files));
    assert!(!echo.set_files(vault::tree(&root, None).files));

    // a note save reports its known folder too; that is not a files change
    std::fs::write(root.join("Pics/n.md"), "edited").unwrap();
    let fx = vault_effects(&root, None, set(&["Pics"]), &set(&["Pics/n.md"]), &mut echo, false);
    assert!(!fx.files_dirty && !fx.folders_dirty);
    assert_eq!(fx.changes.len(), 1);
    assert_eq!(fx.changes[0].content.as_deref(), Some("edited"));

    // a removed image is one
    std::fs::remove_file(root.join("Pics/paste 7.png")).unwrap();
    let fx = vault_effects(&root, None, set(&["Pics", "Pics/paste 7.png"]), &BTreeSet::new(), &mut echo, false);
    assert!(fx.files_dirty && !fx.folders_dirty);
    assert!(echo.set_files(vault::tree(&root, None).files));
    assert_eq!(echo.files.len(), 49);

    // so is a folder of images moved in from outside
    std::fs::create_dir_all(root.join("Import")).unwrap();
    std::fs::write(root.join("Import/x.jpg"), "j").unwrap();
    let fx = vault_effects(&root, None, set(&["Import"]), &BTreeSet::new(), &mut echo, false);
    assert!(fx.files_dirty && fx.folders_dirty);
}

#[test]
fn a_note_file_too_big_for_a_note_keeps_the_file_list_fresh() {
    let root = std::env::temp_dir().join("leonote_watch_big_note");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let big = root.join("big.md");
    let f = std::fs::File::create(&big).unwrap();
    f.set_len(vault::MAX_NOTE + 1).unwrap();
    let mut echo = Echo::default();
    echo.set_files(vault::tree(&root, None).files);
    assert_eq!(echo.files.len(), 1);

    // cut down to a note outside the app: a note now, and off the file list
    f.set_len(4).unwrap();
    drop(f);
    let fx = vault_effects(&root, None, BTreeSet::new(), &set(&["big.md"]), &mut echo, false);
    assert!(fx.files_dirty && fx.changes.len() == 1);
    assert!(echo.set_files(vault::tree(&root, None).files));
    assert!(echo.files.is_empty());

    // deleted outside the app: the note was never known, the row must still go
    std::fs::File::create(&big).unwrap().set_len(vault::MAX_NOTE + 1).unwrap();
    echo.set_files(vault::tree(&root, None).files);
    std::fs::remove_file(&big).unwrap();
    let fx = vault_effects(&root, None, BTreeSet::new(), &set(&["big.md"]), &mut echo, false);
    assert!(fx.files_dirty);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dot_segments_are_ignored() {
    for p in [
        r"C:\Users\me\LeoNote\.trash\2026 a.md",
        r"C:\Users\me\LeoNote\.obsidian\workspace.json",
        r"C:\Users\me\LeoNote\Docs\.plan.md.tmp",
        r"C:\Users\me\LeoNote\.git\objects\ab\cd",
        r"C:\Users\me\LeoNote\.leonote\migrated-v1",
    ] {
        assert_eq!(k(p), Kind::Ignored, "{}", p);
    }
}

#[test]
fn task_files() {
    assert_eq!(k(r"C:\Users\me\.leonote\log\hermes.jsonl"), Kind::Log("hermes".into()));
    assert_eq!(k(r"C:\Users\me\.leonote\log\claude-w3.JSONL"), Kind::Log("claude-w3".into()));
    assert_eq!(k(r"C:\Users\me\.leonote\log\notes.txt"), Kind::Ignored);
    assert_eq!(k(r"C:\Users\me\.leonote\log\sub\x.jsonl"), Kind::Ignored);
    assert_eq!(k(r"C:\Users\me\.LEONOTE_TASKS.json"), Kind::Snapshot);
    assert_eq!(k(r"C:\Users\me\.leonote_tasks.json.compact.tmp"), Kind::Ignored);
    assert_eq!(k(r"C:\Users\me\.leonote_habits.json"), Kind::Habits);
    assert_eq!(k(r"C:\Users\me\..leonote_habits.json.tmp"), Kind::Ignored);
    assert_eq!(k(r"C:\Users\me\.leonote_config.json"), Kind::Ignored);
    assert_eq!(k(r"D:\elsewhere\a.md"), Kind::Ignored);
}

#[test]
fn a_vault_at_home_does_not_swallow_the_logs() {
    let mut t = targets();
    t.vault = PathBuf::from(r"C:\Users\me");
    assert_eq!(classify(Path::new(r"C:\Users\me\.leonote\log\ui.jsonl"), &t), Kind::Log("ui".into()));
    assert_eq!(classify(Path::new(r"C:\Users\me\.leonote_habits.json"), &t), Kind::Habits);
    assert_eq!(classify(Path::new(r"C:\Users\me\n.md"), &t), Kind::Note("n.md".into()));
}

#[test]
fn echo_suppresses_known_content_only() {
    let mut e = Echo::default();
    e.note_seen("Docs/a.md", "one");
    assert!(!e.note_changed("Docs/a.md", Some("one")), "our own write is an echo");
    assert!(!e.note_changed("docs/A.md", Some("one")), "case-insensitive");
    assert!(e.note_changed("Docs/a.md", Some("two")), "an agent edit gets through");
    assert!(!e.note_changed("Docs/a.md", Some("two")), "and is reported once");
    assert!(e.note_changed("Docs/a.md", None), "deletion is reported");
    assert!(!e.note_changed("Docs/a.md", None));
    assert!(!e.note_changed("never.md", None), "an unknown file vanishing is not news");
    assert!(e.note_changed("new.md", Some("")), "a new empty note is news");
}

#[test]
fn echo_follows_our_own_renames_and_trashes() {
    let mut e = Echo::default();
    e.note_seen("Old/x.md", "X");
    e.note_seen("Old/Sub/y.md", "Y");
    e.note_seen("Older/z.md", "Z");
    e.move_prefix("Old", "New");
    assert!(!e.note_changed("New/x.md", Some("X")));
    assert!(!e.note_changed("New/Sub/y.md", Some("Y")));
    assert!(!e.note_changed("Old/x.md", None), "the old path is already known gone");
    assert!(!e.note_changed("Older/z.md", Some("Z")), "a sibling with a shared prefix is untouched");

    let mut gone = e.prefix_gone("New");
    gone.sort();
    assert_eq!(gone, vec!["New/Sub/y.md", "New/x.md"]);
    assert!(!e.note_changed("New/x.md", None));

    e.note_seen("a.md", "A");
    e.move_note("a.md", "A.md");
    assert!(!e.note_changed("A.md", Some("A")), "case-only rename keeps the hash");
}

#[cfg(windows)]
#[test]
fn a_note_held_open_is_not_a_note_deleted() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = std::env::temp_dir().join("leonote_watch_held_note");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let p = root.join("n.md");
    std::fs::write(&p, "text").unwrap();
    let mut echo = Echo::default();
    echo.reset_notes(&vault::scan(&root, None).notes);

    let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&p).unwrap();
    assert!(vault_effects(&root, None, BTreeSet::new(), &set(&["n.md"]), &mut echo, false).changes.is_empty());
    assert!(vault_effects(&root, None, BTreeSet::new(), &BTreeSet::new(), &mut echo, true).changes.is_empty());
    drop(lock);

    std::fs::remove_file(&p).unwrap();
    assert_eq!(vault_effects(&root, None, BTreeSet::new(), &set(&["n.md"]), &mut echo, false).changes.len(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn text_from_outside_is_told_apart_even_after_the_watcher_saw_it() {
    let mut echo = Echo::default();
    echo.note_ours("n.md", "mine");
    assert!(echo.note_changed("n.md", Some("theirs")));
    assert!(echo.from_outside("n.md", "theirs"));
    assert!(!echo.from_outside("n.md", "mine"));
    echo.move_note("n.md", "m.md");
    assert!(echo.from_outside("m.md", "theirs"));
    assert!(!echo.from_outside("never-seen.md", "anything"));
}
