//! Tests for the data-location modes and the move between them.
//!
//! Hermetic: every test owns a temp home and a temp vault, so nothing here can
//! touch the user's real ~/.leonote, and no process env is read or written.

use super::datadir::*;
use serde_json::json;
use std::path::{Path, PathBuf};

/// A throwaway home + vault pair, unique per test.
fn scratch(name: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("leonote_datadir_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let vault = root.join("vault");
    std::fs::create_dir_all(home.join(".leonote/log")).unwrap();
    std::fs::create_dir_all(&vault).unwrap();
    (home, vault)
}

fn put(p: &Path, body: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

fn user_items(home: &Path) -> Items {
    let dir = home.join(".leonote");
    let snap = home.join(".leonote_tasks.json");
    items(USER, home, &dir, &snap, Path::new(""))
}

fn vault_items(mode: &str, home: &Path, vault: &Path) -> Items {
    let dir = home.join(".leonote");
    let snap = home.join(".leonote_tasks.json");
    items(mode, home, &dir, &snap, vault)
}

/// Seed one recognisable byte-string in every place the app reads from.
fn seed(it: &Items) {
    put(&it.dir.join("log/ui.jsonl"), "ui-log\n");
    put(&it.dir.join("log/py.jsonl"), "py-log\n");
    put(&it.dir.join("base.snapshot.json"), "[]");
    put(&it.snapshot, "snapshot");
    put(&it.habits, "habits");
    put(&it.recurring, "recurring");
    put(&it.priorities, "priorities");
    put(&it.stats, "stats");
    put(&it.positions, "positions");
    put(&it.graph, "graph");
}

fn assert_seeded(it: &Items) {
    assert_eq!(read(&it.dir.join("log/ui.jsonl")), "ui-log\n");
    assert_eq!(read(&it.dir.join("log/py.jsonl")), "py-log\n");
    assert_eq!(read(&it.dir.join("base.snapshot.json")), "[]");
    assert_eq!(read(&it.snapshot), "snapshot");
    assert_eq!(read(&it.habits), "habits");
    assert_eq!(read(&it.recurring), "recurring");
    assert_eq!(read(&it.priorities), "priorities");
    assert_eq!(read(&it.stats), "stats");
    assert_eq!(read(&it.positions), "positions");
    assert_eq!(read(&it.graph), "graph");
}

// ── modes ───────────────────────────────────────────────────────────────────

#[test]
fn mode_parsing_falls_back_to_user() {
    assert_eq!(mode_of(&json!({})), USER);
    assert_eq!(mode_of(&json!({ "dataDir": "vault" })), VAULT);
    assert_eq!(mode_of(&json!({ "dataDir": "vault-hidden" })), VAULT_HIDDEN);
    assert_eq!(mode_of(&json!({ "dataDir": "user" })), USER);
    // A settings file from a newer build must not strand the tasks.
    assert_eq!(mode_of(&json!({ "dataDir": "somewhere-new" })), USER);
    assert_eq!(mode_of(&json!({ "dataDir": 7 })), USER);
    assert_eq!(parse_mode("nonsense"), None);
}

#[test]
fn user_mode_keeps_todays_exact_paths() {
    let (home, _) = scratch("resolve_user");
    let it = user_items(&home);
    assert_eq!(it.dir, home.join(".leonote"));
    assert_eq!(it.snapshot, home.join(".leonote_tasks.json"));
    assert_eq!(it.habits, home.join(".leonote_habits.json"));
    assert_eq!(it.recurring, home.join(".leonote_recurring.json"));
    assert_eq!(it.priorities, home.join(".leonote_priorities.json"));
    assert_eq!(it.stats, home.join(".leonote/stats.json"));
    assert_eq!(it.positions, home.join(".leonote/positions.json"));
    assert_eq!(it.graph, home.join(".leonote/graph.json"));
}

#[test]
fn vault_mode_uses_a_visible_folder() {
    let (home, vault) = scratch("resolve_vault");
    let it = vault_items(VAULT, &home, &vault);
    let r = vault.join("LeoNote");
    assert_eq!(data_root(VAULT, &home.join(".leonote"), &vault), r);
    assert_eq!(it.dir, r);
    assert_eq!(it.snapshot, r.join("tasks.json"));
    assert_eq!(it.habits, r.join("habits.json"));
    assert_eq!(it.recurring, r.join("recurring.json"));
    assert_eq!(it.priorities, r.join("priorities.json"));
    assert_eq!(it.stats, r.join("stats.json"));
    assert_eq!(it.positions, r.join("positions.json"));
    assert_eq!(it.graph, r.join("graph.json"));
}

#[test]
fn vault_hidden_mode_uses_a_dot_folder() {
    let (home, vault) = scratch("resolve_hidden");
    let it = vault_items(VAULT_HIDDEN, &home, &vault);
    let r = vault.join(".leonote");
    assert_eq!(it.dir, r);
    assert_eq!(it.snapshot, r.join("tasks.json"));
    assert_eq!(it.positions, r.join("positions.json"));
    // The two vault modes must never share a root, or a switch would be a
    // move onto itself.
    assert_ne!(it.dir, vault_items(VAULT, &home, &vault).dir);
}

// ── moving ──────────────────────────────────────────────────────────────────

#[test]
fn move_user_to_vault_and_back() {
    let (home, vault) = scratch("round_trip");
    let u = user_items(&home);
    let v = vault_items(VAULT, &home, &vault);
    seed(&u);

    migrate(&u, &v).unwrap();
    assert_seeded(&v);
    // Nothing is left behind at the old location.
    assert!(!u.snapshot.exists());
    assert!(!u.habits.exists());
    assert!(!u.dir.join("log").exists());

    migrate(&v, &u).unwrap();
    assert_seeded(&u);
    assert!(!v.dir.join("log").exists());
    assert!(!v.snapshot.exists());
}

#[test]
fn the_ai_rules_proposals_and_kept_versions_move_too() {
    let (home, vault) = scratch("beside_the_logs");
    let u = user_items(&home);
    let v = vault_items(VAULT_HIDDEN, &home, &vault);
    seed(&u);
    for f in ["ai-access.json", "proposals/p.json", "quarantine.jsonl", "claude-import.json", "history/notes/N-1/a.md", "history/20260101T000000/tasks.json"] {
        put(&u.dir.join(f), f);
    }
    put(&u.dir.join("history/settings/app 1.json"), "stays with app.json");

    migrate(&u, &v).unwrap();
    for f in ["ai-access.json", "proposals/p.json", "quarantine.jsonl", "claude-import.json", "history/notes/N-1/a.md", "history/20260101T000000/tasks.json"] {
        assert_eq!(read(&v.dir.join(f)), f);
        assert!(!u.dir.join(f).exists(), "{f} left behind");
    }
    assert_eq!(read(&u.dir.join("history/settings/app 1.json")), "stays with app.json");
    assert!(!v.dir.join("history/settings").exists());
    // the copy made before the move is not set aside by the history coming after it
    assert!(std::fs::read_dir(v.dir.join("history")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("before-move-")));
    assert!(!v.dir.join("history.bak").exists());
}

#[test]
fn what_an_older_move_left_behind_is_joined_not_set_aside() {
    let (home, vault) = scratch("stranded");
    let u = user_items(&home);
    let v = vault_items(VAULT_HIDDEN, &home, &vault);
    seed(&v);
    // left in the home root by an older build's move; the vault root has grown its own since
    put(&u.dir.join("ai-access.json"), r#"{"default":"review","folders":{"Diary":"private","Work":"open"}}"#);
    put(&u.dir.join("claude-import.json"), r#"{"a.jsonl":{"size":1}}"#);
    put(&u.dir.join("proposals/old.json"), "old");
    put(&u.dir.join("history/notes/N-1/old.md"), "old");
    put(&v.dir.join("ai-access.json"), r#"{"default":"review","folders":{"Work":"private"}}"#);
    put(&v.dir.join("claude-import.json"), r#"{"b.jsonl":{"size":2}}"#);
    put(&v.dir.join("proposals/new.json"), "new");
    put(&v.dir.join("history/notes/N-1/new.md"), "new");

    migrate(&v, &u).unwrap();
    let rules: serde_json::Value = serde_json::from_str(&read(&u.dir.join("ai-access.json"))).unwrap();
    assert_eq!(rules["folders"], json!({ "Diary": "private", "Work": "private" }));
    let memo: serde_json::Value = serde_json::from_str(&read(&u.dir.join("claude-import.json"))).unwrap();
    assert!(memo.get("a.jsonl").is_some() && memo.get("b.jsonl").is_some(), "{memo}");
    for f in ["proposals/old.json", "proposals/new.json", "history/notes/N-1/old.md", "history/notes/N-1/new.md"] {
        assert!(u.dir.join(f).exists(), "{f} lost");
    }
    for f in ["ai-access.json.bak", "proposals.bak", "history/notes.bak"] { assert!(!u.dir.join(f).exists(), "{f}"); }
    assert!(!v.dir.join("ai-access.json").exists() && !v.dir.join("proposals").exists());
}

#[test]
fn move_between_the_two_vault_modes() {
    let (home, vault) = scratch("vault_to_hidden");
    let v = vault_items(VAULT, &home, &vault);
    let h = vault_items(VAULT_HIDDEN, &home, &vault);
    seed(&v);
    migrate(&v, &h).unwrap();
    assert_seeded(&h);
    assert!(!v.dir.exists() || std::fs::read_dir(&v.dir).unwrap().next().is_none());
}

#[test]
fn a_file_in_the_way_is_set_aside_not_overwritten() {
    let (home, vault) = scratch("bak");
    let u = user_items(&home);
    let v = vault_items(VAULT, &home, &vault);
    seed(&u);
    // Leftovers from an earlier life in the vault.
    put(&v.snapshot, "older tasks");
    put(&v.dir.join("log/ui.jsonl"), "older log\n");

    migrate(&u, &v).unwrap();
    assert_seeded(&v);
    assert_eq!(read(&v.dir.join("tasks.json.bak")), "older tasks");
    assert_eq!(read(&v.dir.join("log.bak/ui.jsonl")), "older log\n");
}

#[test]
fn an_empty_file_in_the_way_is_just_replaced() {
    let (home, vault) = scratch("empty_dest");
    let u = user_items(&home);
    let v = vault_items(VAULT, &home, &vault);
    seed(&u);
    put(&v.snapshot, "");
    std::fs::create_dir_all(v.dir.join("log")).unwrap();

    migrate(&u, &v).unwrap();
    assert_seeded(&v);
    assert!(!v.dir.join("tasks.json.bak").exists());
    assert!(!v.dir.join("log.bak").exists());
}

#[test]
fn a_second_collision_does_not_clobber_the_first_backup() {
    let (home, vault) = scratch("bak_twice");
    let u = user_items(&home);
    let v = vault_items(VAULT, &home, &vault);
    put(&v.snapshot, "first");
    put(&u.snapshot, "second");
    migrate(&u, &v).unwrap();
    put(&v.snapshot, "third");
    put(&u.snapshot, "fourth");
    migrate(&u, &v).unwrap();
    assert_eq!(read(&v.snapshot), "fourth");
    assert_eq!(read(&v.dir.join("tasks.json.bak")), "first");
    assert_eq!(read(&v.dir.join("tasks.json.bak.2")), "third");
}

#[test]
fn missing_sources_are_not_an_error() {
    let (home, vault) = scratch("partial");
    let u = user_items(&home);
    let v = vault_items(VAULT, &home, &vault);
    // Only one file exists; the rest were never created.
    put(&u.snapshot, "snapshot");
    migrate(&u, &v).unwrap();
    assert_eq!(read(&v.snapshot), "snapshot");
    assert!(!v.habits.exists());
}

#[test]
fn moving_onto_the_same_paths_is_harmless() {
    let (home, _) = scratch("same");
    let u = user_items(&home);
    seed(&u);
    migrate(&u, &user_items(&home)).unwrap();
    assert_seeded(&u);
}

#[test]
fn a_vault_mode_is_refused_without_a_vault() {
    let (_, vault) = scratch("no_vault");
    assert!(check_target(VAULT, Path::new("")).is_err());
    assert!(check_target(VAULT_HIDDEN, Path::new("")).is_err());
    assert!(check_target(VAULT, &vault.join("not-there")).is_err());
    // A file is not a vault either.
    put(&vault.join("file.md"), "x");
    assert!(check_target(VAULT, &vault.join("file.md")).is_err());
    assert!(check_target(VAULT, &vault).is_ok());
    // "user" needs no vault at all.
    assert!(check_target(USER, Path::new("")).is_ok());
}

// ── ordering: settings written only after the data arrived ──────────────────

/// The command writes `dataDir` only after `migrate` returns Ok. This is the
/// same sequence without Tauri state, so the ordering rule is covered: a
/// failed move must leave app.json untouched.
fn set_mode(settings: &Path, old: &Items, new: &Items, mode: &str) -> Result<(), String> {
    migrate(old, new)?;
    let mut cfg = std::fs::read_to_string(settings)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}));
    cfg["dataDir"] = json!(mode);
    std::fs::write(settings, cfg.to_string()).map_err(|e| e.to_string())
}

#[test]
fn app_json_records_the_mode_only_after_the_data_arrived() {
    let (home, vault) = scratch("settings_last");
    let settings = home.join(".leonote/app.json");
    put(&settings, "{}");
    let u = user_items(&home);
    let v = vault_items(VAULT, &home, &vault);
    seed(&u);

    set_mode(&settings, &u, &v, VAULT).unwrap();
    assert_seeded(&v);
    assert_eq!(mode_of(&serde_json::from_str(&read(&settings)).unwrap()), VAULT);
    // app.json itself never travels.
    assert!(settings.exists());
    assert!(!v.dir.join("app.json").exists());
}

#[test]
fn a_failed_move_leaves_the_old_mode_in_app_json() {
    let (home, vault) = scratch("settings_kept");
    let settings = home.join(".leonote/app.json");
    put(&settings, "{}");
    let u = user_items(&home);
    seed(&u);
    // A data root that cannot be created: a plain file sits where the vault
    // folder would have to be.
    put(&vault.join("blocked"), "not a folder");
    let bad = items(VAULT, &home, &u.dir, &u.snapshot, &vault.join("blocked"));

    assert!(set_mode(&settings, &u, &bad, VAULT).is_err());
    assert_eq!(mode_of(&serde_json::from_str(&read(&settings)).unwrap()), USER);
    assert_seeded(&u);
}
