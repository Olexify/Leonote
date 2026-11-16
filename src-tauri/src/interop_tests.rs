//! Three-way merge tests. The scenarios here are the ones that silently
//! destroyed data in the designs this replaced.

use super::interop::*;
use super::store::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("leonote_interop_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("log")).unwrap();
    (root.clone(), root.join("tasks.json"))
}

fn write(p: &Path, v: &Value) {
    std::fs::write(p, serde_json::to_string_pretty(v).unwrap()).unwrap();
}

const NOW: &str = "2026-09-07T12:00:00.000";

#[test]
fn a_stale_python_array_does_not_revert_an_agent_edit() {
    // THE scenario. Python launched when the task was open, an agent then
    // completed it, and Python writes its session-old array back on close.
    let (root, snap) = scratch("stale");
    let base = json!([{"id":"a","text":"x","done":false,"priority":"none"}]);
    write(&base_path(&root), &base);

    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"a","done":true,"t":"2026-09-07T11:00:00.000","by":"hermes"}).to_string()],
    )
    .unwrap();

    // Python writes back exactly what it read at launch - identical to base
    write(&snap, &base);

    let imp = import_python_changes(&root, &snap, NOW);
    assert!(imp.ops.is_empty(), "stale fields must not import: {:?}", imp.ops);

    let f = fold_in(&root, &snap);
    let t = f.tasks.iter().find(|t| t["id"] == "a").unwrap();
    assert_eq!(t["done"], json!(true), "the agent's edit was reverted");
}

#[test]
fn a_real_python_edit_is_imported() {
    let (root, snap) = scratch("real_edit");
    write(&base_path(&root), &json!([{"id":"a","text":"x","priority":"none"}]));
    write(&snap, &json!([{"id":"a","text":"x","priority":"high"}]));

    let imp = import_python_changes(&root, &snap, NOW);
    assert_eq!(imp.ops.len(), 1);
    assert_eq!(imp.ops[0]["priority"], json!("high"));
    assert_eq!(imp.ops[0]["by"], json!("py"));
    assert!(
        imp.ops[0].get("text").is_none(),
        "unchanged fields must not ride along"
    );
}

#[test]
fn both_sides_editing_different_fields_both_survive() {
    let (root, snap) = scratch("both_sides");
    write(
        &base_path(&root),
        &json!([{"id":"a","text":"x","priority":"none","done":false}]),
    );
    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"a","done":true,"t":"2026-09-07T11:00:00.000"}).to_string()],
    )
    .unwrap();
    // Python changed only priority; its done:false is stale
    write(
        &snap,
        &json!([{"id":"a","text":"x","priority":"high","done":false}]),
    );

    let imp = import_python_changes(&root, &snap, NOW);
    let lines: Vec<String> = imp.ops.iter().map(|o| o.to_string()).collect();
    append(&log_path_in(&root, "py"), &lines).unwrap();

    let f = fold_in(&root, &snap);
    let t = f.tasks.iter().find(|t| t["id"] == "a").unwrap();
    assert_eq!(t["priority"], json!("high"), "python's real edit was lost");
    assert_eq!(t["done"], json!(true), "stale data reverted the agent");
}

#[test]
fn a_purged_task_becomes_a_tombstone_not_a_resurrection() {
    let (root, snap) = scratch("purge");
    write(
        &base_path(&root),
        &json!([{"id":"a"},{"id":"gone","deleted":true}]),
    );
    // _purge_old_trash hard-deleted "gone" after 24h
    write(&snap, &json!([{"id":"a"}]));

    let imp = import_python_changes(&root, &snap, NOW);
    let tomb: Vec<&Value> = imp.ops.iter().filter(|o| o["id"] == "gone").collect();
    assert_eq!(tomb.len(), 1, "expected a tombstone: {:?}", imp.ops);
    assert_eq!(tomb[0]["deleted"], json!(true));
    assert_eq!(tomb[0]["purged"], json!(true));
}

#[test]
fn a_task_python_never_knew_about_is_not_deleted() {
    let (root, snap) = scratch("unknown_to_py");
    write(&base_path(&root), &json!([{"id":"a"}]));
    write(&snap, &json!([{"id":"a"}]));
    append(
        &log_path_in(&root, "ui"),
        &[json!({"id":"mine","text":"new","t":"2026-09-07T11:00:00.000"}).to_string()],
    )
    .unwrap();

    let imp = import_python_changes(&root, &snap, NOW);
    assert!(
        imp.ops.iter().all(|o| o["id"] != "mine"),
        "a task python never saw must not be tombstoned: {:?}",
        imp.ops
    );
    let f = fold_in(&root, &snap);
    assert!(f.tasks.iter().any(|t| t["id"] == "mine"));
}

#[test]
fn a_truncated_snapshot_is_rejected_not_treated_as_deletions() {
    let (root, snap) = scratch("truncated");
    let full: Vec<Value> = (0..100).map(|i| json!({"id": format!("t{}", i)})).collect();
    write(&base_path(&root), &Value::Array(full.clone()));
    // a read that landed mid-write: 40% of the array
    write(&snap, &Value::Array(full[..40].to_vec()));

    let imp = import_python_changes(&root, &snap, NOW);
    assert!(imp.ops.is_empty(), "must import nothing");
    assert!(imp.refused.unwrap().contains("partial write"));
}

#[test]
fn an_unparseable_snapshot_is_never_an_empty_list() {
    let (root, snap) = scratch("unparseable");
    write(&base_path(&root), &json!([{"id":"a"},{"id":"b"}]));
    std::fs::write(&snap, "[{\"id\": \"a\"").unwrap(); // torn JSON
    let imp = import_python_changes(&root, &snap, NOW);
    assert!(imp.ops.is_empty());
    assert!(imp.refused.is_some());
}

#[test]
fn an_empty_snapshot_file_is_rejected() {
    let (root, snap) = scratch("empty");
    write(&base_path(&root), &json!([{"id":"a"}]));
    std::fs::write(&snap, "").unwrap();
    let imp = import_python_changes(&root, &snap, NOW);
    assert!(imp.ops.is_empty());
    assert!(imp.refused.is_some());
}

#[test]
fn without_a_base_we_refuse_rather_than_guess() {
    let (root, snap) = scratch("nobase");
    write(&snap, &json!([{"id":"a","done":true}]));
    let imp = import_python_changes(&root, &snap, NOW);
    assert!(imp.ops.is_empty());
    assert!(imp.refused.unwrap().contains("no base"));
}

#[test]
fn a_key_python_removed_is_unset_not_ignored() {
    let (root, snap) = scratch("removed_key");
    write(
        &base_path(&root),
        &json!([{"id":"a","due_date":"2026-09-09","text":"x"}]),
    );
    write(&snap, &json!([{"id":"a","text":"x"}]));
    let imp = import_python_changes(&root, &snap, NOW);
    assert_eq!(imp.ops.len(), 1);
    assert_eq!(imp.ops[0]["$unset"], json!(["due_date"]));
}

#[test]
fn a_task_python_created_is_imported_whole() {
    let (root, snap) = scratch("py_create");
    write(&base_path(&root), &json!([{"id":"a"}]));
    write(
        &snap,
        &json!([{"id":"a"},{"id":"new","text":"typed in python","done":false}]),
    );
    let imp = import_python_changes(&root, &snap, NOW);
    let new: Vec<&Value> = imp.ops.iter().filter(|o| o["id"] == "new").collect();
    assert_eq!(new.len(), 1);
    assert_eq!(new[0]["text"], json!("typed in python"));
}

#[test]
fn importing_twice_is_idempotent() {
    let (root, snap) = scratch("idempotent");
    write(&base_path(&root), &json!([{"id":"a","priority":"none"}]));
    write(&snap, &json!([{"id":"a","priority":"high"}]));

    let imp = import_python_changes(&root, &snap, NOW);
    let lines: Vec<String> = imp.ops.iter().map(|o| o.to_string()).collect();
    append(&log_path_in(&root, "py"), &lines).unwrap();
    let first = fold_in(&root, &snap);

    // base has not moved, so the same edit is seen again - folding it twice
    // must not change anything
    let imp2 = import_python_changes(&root, &snap, "2026-09-07T13:00:00.000");
    let lines2: Vec<String> = imp2.ops.iter().map(|o| o.to_string()).collect();
    append(&log_path_in(&root, "py"), &lines2).unwrap();
    let second = fold_in(&root, &snap);

    assert_eq!(first.tasks, second.tasks, "a repeated import changed state");
}

#[test]
fn a_small_legitimate_purge_is_not_mistaken_for_a_partial_write() {
    // Regression: the fraction guard alone rejected an ordinary purge whenever
    // the dataset was small (2 tasks -> 1 is a 50% drop), so real deletions
    // were silently ignored forever.
    for (total, purged) in [(2usize, 1usize), (10, 3), (98, 5)] {
        let (root, snap) = scratch(&format!("small_purge_{}_{}", total, purged));
        let full: Vec<Value> = (0..total).map(|i| json!({"id": format!("t{}", i)})).collect();
        write(&base_path(&root), &Value::Array(full.clone()));
        write(&snap, &Value::Array(full[purged..].to_vec()));

        let imp = import_python_changes(&root, &snap, NOW);
        assert!(imp.refused.is_none(), "{} of {} refused: {:?}", purged, total, imp.refused);
        let tombs = imp.ops.iter().filter(|o| o["purged"] == json!(true)).count();
        assert_eq!(tombs, purged, "expected {} tombstones from {} tasks", purged, total);
    }
}

#[test]
fn a_large_drop_is_still_refused() {
    let (root, snap) = scratch("large_drop");
    let full: Vec<Value> = (0..50).map(|i| json!({"id": format!("t{}", i)})).collect();
    write(&base_path(&root), &Value::Array(full.clone()));
    write(&snap, &Value::Array(full[..10].to_vec()));   // lost 40 of 50
    let imp = import_python_changes(&root, &snap, NOW);
    assert!(imp.refused.is_some(), "losing 80% must still be refused");
}
