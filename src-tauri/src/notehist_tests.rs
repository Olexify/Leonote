//! Tests for the note version history. Hermetic: every test owns a temp vault
//! and a temp data directory, never the user's `~/.leonote`.

use super::notehist::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

struct Bed {
    vault: PathBuf,
    data: PathBuf,
    last: HashMap<String, Instant>,
    n: u32,
}

fn bed(name: &str) -> Bed {
    let root = std::env::temp_dir().join(format!("leonote_hist_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    let vault = root.join("vault");
    let data = root.join("data");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    Bed { vault, data, last: HashMap::new(), n: 0 }
}

impl Bed {
    fn put(&self, rel: &str, body: &str) {
        let p = self.vault.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    /// A fresh, increasing stamp - the real one comes from the clock.
    fn stamp(&mut self) -> String {
        self.n += 1;
        format!("20260918T1200{:04}.000", self.n)
    }
    /// The save path: what note_write does before it overwrites.
    fn write(&mut self, rel: &str, next: &str) -> Option<String> {
        let s = self.stamp();
        let got = before_write(&self.data.clone(), &self.vault.clone(), rel, next, &mut self.last, &s, false);
        self.put(rel, next);
        got
    }
    fn versions(&self, rel: &str) -> Vec<Version> {
        list(&self.data, rel)
    }
}

const LONG: &str = "# Notes\n\nA paragraph long enough to be worth keeping, several times over, so the ratio means something at all.\n";

// ── what gets kept ──────────────────────────────────────────────────────────

#[test]
fn an_emptying_write_always_keeps_the_previous_text() {
    let mut b = bed("empty");
    b.put("Note.md", LONG);
    assert!(b.write("Note.md", "").is_some());
    let v = b.versions("Note.md");
    assert_eq!(v.len(), 1);
    assert_eq!(read(&b.data, "Note.md", &v[0].stamp).unwrap(), LONG);
}

#[test]
fn a_write_that_keeps_most_of_the_note_is_not_worth_a_version() {
    let mut b = bed("ratio");
    b.put("Note.md", LONG);
    // the routine snapshot fires once, then the throttle takes over
    b.write("Note.md", &format!("{}more", LONG));
    b.write("Note.md", &format!("{}even more", LONG));
    assert_eq!(b.versions("Note.md").len(), 1);
}

#[test]
fn every_big_shrink_is_kept_however_fast_they_come() {
    let mut b = bed("shrinks");
    b.put("Note.md", LONG);
    b.write("Note.md", "# Notes\n");
    b.put("Note.md", &format!("{}two", LONG));
    b.write("Note.md", "");
    b.put("Note.md", &format!("{}three", LONG));
    b.write("Note.md", "x");
    assert_eq!(b.versions("Note.md").len(), 3);
}

#[test]
fn ordinary_saves_are_throttled_but_not_silenced() {
    let mut b = bed("throttle");
    b.put("Note.md", LONG);
    for i in 0..30 {
        b.write("Note.md", &format!("{}{}", LONG, i));
    }
    assert_eq!(b.versions("Note.md").len(), 1, "one routine version, not thirty");
    // ...and once the window has passed, the next save keeps one again
    b.last.insert("Note.md".into(), Instant::now() - ROUTINE_EVERY - Duration::from_secs(1));
    b.write("Note.md", &format!("{}later", LONG));
    assert_eq!(b.versions("Note.md").len(), 2);
}

#[test]
fn a_write_that_changes_nothing_keeps_nothing() {
    let mut b = bed("same");
    b.put("Note.md", LONG);
    b.write("Note.md", LONG);
    assert!(b.versions("Note.md").is_empty());
}

#[test]
fn a_note_that_is_not_there_yet_has_nothing_to_keep() {
    let mut b = bed("new");
    assert!(b.write("Fresh.md", "hello").is_none());
    assert!(b.versions("Fresh.md").is_empty());
}

#[test]
fn keeping_can_be_forced_for_a_restore() {
    let mut b = bed("forced");
    b.put("Note.md", LONG);
    let s = b.stamp();
    let (data, vault) = (b.data.clone(), b.vault.clone());
    assert!(before_write(&data, &vault, "Note.md", "", &mut b.last, &s, true).is_some());
    // ...and again straight away, throttle or no throttle
    b.put("Note.md", &format!("{}more", LONG));
    let s2 = b.stamp();
    assert!(before_write(&data, &vault, "Note.md", "", &mut b.last, &s2, true).is_some());
    assert_eq!(b.versions("Note.md").len(), 2);
}

#[test]
fn a_write_that_keeps_failing_keeps_the_note_once_however_often_it_retries() {
    let mut b = bed("retries");
    let (data, vault) = (b.data.clone(), b.vault.clone());
    b.put("Note.md", LONG);
    std::fs::write(vault.join("old.md"), b"# \xCE\xF2\xF7\xE5\xF2\n").unwrap(); // Windows-1251
    for _ in 0..3 {
        // nothing is written between tries: the disk still holds the same bytes
        let s = b.stamp();
        before_write(&data, &vault, "Note.md", "new", &mut b.last, &s, true);
        before_write(&data, &vault, "old.md", "new", &mut b.last, &s, true);
    }
    assert_eq!(b.versions("Note.md").len(), 1);
    assert_eq!(crate::trashbin::list(&vault).len(), 1);
}

// ── what comes back ─────────────────────────────────────────────────────────

#[test]
fn versions_come_back_newest_first_with_enough_to_recognise_them() {
    let mut b = bed("list");
    let one = format!("# One\n\n{}", LONG);
    let two = format!("\n\n# Two\n\n{}", LONG);
    b.put("Note.md", &one);
    b.write("Note.md", "");
    b.put("Note.md", &two);
    b.write("Note.md", "");
    let v = b.versions("Note.md");
    assert_eq!(v.len(), 2);
    assert!(v[0].stamp > v[1].stamp, "newest first");
    assert_eq!(v[0].first_line, "# Two", "leading blank lines skipped");
    assert_eq!(v[1].first_line, "# One");
    assert_eq!(v[1].size, one.len() as u64);
    assert_eq!(v[1].lines, one.lines().count());
}

#[test]
fn two_notes_never_share_a_folder_however_alike_their_names() {
    let mut b = bed("slugs");
    b.put("a/Note.md", LONG);
    b.put("b/Note.md", &format!("{}different", LONG));
    b.write("a/Note.md", "");
    b.write("b/Note.md", "");
    assert_ne!(slug("a/Note.md"), slug("b/Note.md"));
    assert_eq!(b.versions("a/Note.md").len(), 1);
    assert_eq!(b.versions("b/Note.md").len(), 1);
    assert_eq!(read(&b.data, "a/Note.md", &b.versions("a/Note.md")[0].stamp).unwrap(), LONG);
}

#[test]
fn an_awkward_name_still_makes_a_usable_folder() {
    for rel in ["../../etc/passwd.md", "Ідеї/Нотатка.md", "a/b/c/  ..md", "x.md"] {
        let s = slug(rel);
        assert!(!s.is_empty());
        assert!(!s.contains('/') && !s.contains('\\') && !s.contains(".."), "{} -> {}", rel, s);
    }
}

#[test]
fn a_stamp_may_not_wander_out_of_the_folder() {
    let b = bed("escape");
    for bad in ["../../secret", "a/b", "..", "a\\b", ""] {
        assert!(read(&b.data, "Note.md", bad).is_err(), "{}", bad);
    }
}

#[test]
fn a_note_in_another_encoding_goes_to_the_trash_as_it_was_before_it_is_overwritten() {
    let mut b = bed("encoding");
    let raw = b"# \xCE\xF2\xF7\xE5\xF2\n"; // Windows-1251
    std::fs::write(b.vault.join("report.md"), raw).unwrap();
    b.write("report.md", "# \u{FFFD}\u{FFFD}\n");
    let items = crate::trashbin::list(&b.vault);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].from.as_deref(), Some("report.md"));
    assert_eq!(std::fs::read(b.vault.join(".trash").join(&items[0].entry)).unwrap(), raw);
}

#[test]
fn versions_follow_a_renamed_note_and_a_renamed_folder() {
    let mut b = bed("moved");
    b.put("Old/a.md", LONG);
    b.write("Old/a.md", "");
    moved(&b.data, "Old/a.md", "Old/b.md");
    assert!(b.versions("Old/a.md").is_empty());
    let v = b.versions("Old/b.md");
    assert_eq!(read(&b.data, "Old/b.md", &v[0].stamp).unwrap(), LONG);
    moved_folder(&b.data, "Old", "New/Place");
    assert_eq!(b.versions("New/Place/b.md").len(), 1);
    // and the moved note's folder knows its new name, so it can move again
    moved_folder(&b.data, "New", "Newer");
    assert_eq!(b.versions("Newer/Place/b.md").len(), 1);
    // a name that kept versions of its own keeps them too
    b.put("c.md", LONG);
    b.write("c.md", "");
    moved(&b.data, "Newer/Place/b.md", "c.md");
    assert_eq!(b.versions("c.md").len(), 2);
}

// ── the caps ────────────────────────────────────────────────────────────────

#[test]
fn a_note_keeps_only_its_most_recent_versions() {
    let mut b = bed("cap");
    for i in 0..(MAX_PER_NOTE + 8) {
        b.put("Note.md", &format!("{}{}", LONG, i));
        b.write("Note.md", "");
    }
    let v = b.versions("Note.md");
    assert_eq!(v.len(), MAX_PER_NOTE);
    // the ones kept are the newest, and the very last write is among them
    assert!(v[0].first_line.starts_with("# Notes"));
    assert!(read(&b.data, "Note.md", &v[0].stamp).unwrap().ends_with(&format!("{}", MAX_PER_NOTE + 7)));
}

#[test]
fn the_sweep_drops_the_least_recently_touched_notes() {
    let mut b = bed("sweep");
    // more notes than the cap, oldest stamps first - and last by name, so age and the alphabet disagree
    for i in 0..(MAX_NOTE_DIRS + 5) {
        let rel = format!("N{:03}.md", MAX_NOTE_DIRS + 4 - i);
        b.put(&rel, LONG);
        b.write(&rel, "");
    }
    let dirs = |p: &Path| std::fs::read_dir(p).map(|r| r.count()).unwrap_or(0);
    assert_eq!(dirs(&root_dir(&b.data)), MAX_NOTE_DIRS + 5);
    sweep(&b.data);
    assert_eq!(dirs(&root_dir(&b.data)), MAX_NOTE_DIRS);
    // the newest survived, the oldest did not
    assert_eq!(b.versions("N000.md").len(), 1);
    assert_eq!(b.versions(&format!("N{:03}.md", MAX_NOTE_DIRS + 4)).len(), 0);
}

#[test]
fn shrank_agrees_with_the_frontend_rule() {
    let long = "x".repeat(400);
    assert!(shrank(&long, ""));
    assert!(shrank(&long, &"x".repeat(100)));
    assert!(!shrank(&long, &"x".repeat(399)));
    assert!(!shrank(&"x".repeat(SHRINK_MIN - 1), ""));
}

// ── the task store's own rotated snapshots ──────────────────────────────────

#[test]
fn rotated_task_snapshots_are_capped_and_note_versions_are_left_alone() {
    use super::store;
    let b = bed("hist");
    let hist = b.data.join("history");
    for i in 0..(store::MAX_HISTORY + 7) {
        let d = hist.join(format!("20260918T{:06}.000", i));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("tasks.json"), "[]").unwrap();
    }
    std::fs::create_dir_all(hist.join("notes").join("Note-0000")).unwrap();
    store::prune_history(&b.data, store::MAX_HISTORY);
    let left: Vec<String> = std::fs::read_dir(&hist)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(left.contains(&"notes".to_string()), "note versions are not a compaction stamp");
    assert_eq!(left.len(), store::MAX_HISTORY + 1);
    // the newest survived, the oldest did not
    assert!(left.iter().any(|n| n.ends_with(&format!("{:06}.000", store::MAX_HISTORY + 6))));
    assert!(!left.iter().any(|n| n.ends_with("000000.000")));
}

#[test]
fn pruning_a_history_that_is_not_there_is_fine() {
    let b = bed("nohist");
    super::store::prune_history(&b.data, super::store::MAX_HISTORY);
    sweep(&b.data);
}

// ── erasing every trace ─────────────────────────────────────────────────────

#[test]
fn erasing_takes_versions_trash_copies_and_proposals_of_that_note_only() {
    let mut b = bed("erase");
    b.put("Keys.md", LONG);
    b.write("Keys.md", "");
    b.put("Other.md", LONG);
    b.write("Other.md", "");
    // a copy of Keys.md in the trash, one of Other.md, and a kept copy that knows only the name
    let trash = b.vault.join(".trash");
    std::fs::create_dir_all(&trash).unwrap();
    for (entry, from) in [("2026-09-18 120000 Keys.md", Some("Keys.md")), ("2026-09-18 120001 Other.md", Some("Other.md")), ("2026-09-18 120002 Keys.md", None)] {
        std::fs::write(trash.join(entry), "sk-secret").unwrap();
        if let Some(f) = from { crate::trashbin::remember(&b.vault, entry, f, crate::vault::Entry::Note, 1); }
    }
    let props = b.data.join("proposals");
    std::fs::create_dir_all(props.join("done")).unwrap();
    std::fs::write(props.join("a.json"), r#"{"path":"Keys.md","content":"sk-secret"}"#).unwrap();
    std::fs::write(props.join("done").join("b.json"), r#"{"path":"Keys.md","content":"sk-secret"}"#).unwrap();
    std::fs::write(props.join("c.json"), r#"{"path":"Other.md","content":"x"}"#).unwrap();

    let dry = erase(&b.data, &b.vault, "Keys.md", true).unwrap();
    assert_eq!((dry.versions, dry.trash, dry.proposals), (1, 2, 2));
    assert_eq!(b.versions("Keys.md").len(), 1, "a dry run touches nothing");

    erase(&b.data, &b.vault, "Keys.md", false).unwrap();
    assert!(b.versions("Keys.md").is_empty());
    assert_eq!(b.versions("Other.md").len(), 1, "another note's history stays");
    let left: Vec<String> = std::fs::read_dir(&trash).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !n.starts_with('.')).collect();
    assert_eq!(left, vec!["2026-09-18 120001 Other.md".to_string()]);
    assert!(!props.join("a.json").exists() && !props.join("done").join("b.json").exists() && props.join("c.json").exists());
    assert!(b.vault.join("Keys.md").exists(), "the note itself is the caller's to remove");
}
