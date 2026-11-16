//! Tests for the fold/append store.
//!
//! Every test is hermetic: it builds its own root directory and snapshot, so
//! nothing here can touch the user's live data and nothing races under cargo's
//! parallel test threads.

use super::store::*;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// A throwaway root + snapshot path. Unique per test via the test's own name.
fn scratch(name: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("leonote_store_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("log")).unwrap();
    let snap = root.join("tasks.json");
    (root, snap)
}

fn write_snapshot(p: &Path, tasks: &Value) {
    std::fs::write(p, serde_json::to_string_pretty(tasks).unwrap()).unwrap();
}

fn ids(f: &Folded) -> Vec<String> {
    f.tasks
        .iter()
        .map(|t| t["id"].as_str().unwrap_or("?").to_string())
        .collect()
}

fn task(f: &Folded, id: &str) -> Map<String, Value> {
    f.tasks
        .iter()
        .find(|t| t["id"] == id)
        .unwrap_or_else(|| panic!("task {} missing from fold", id))
        .as_object()
        .unwrap()
        .clone()
}

/// The user's real file, if present. These tests skip rather than fail on a
/// machine that has never run Leonote.
fn real_snapshot() -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    std::fs::read_to_string(PathBuf::from(home).join(".leonote_tasks.json")).ok()
}

// ── 1. the identity property ────────────────────────────────────────────────

#[test]
fn fold_of_untouched_snapshot_equals_snapshot() {
    let raw = match real_snapshot() {
        Some(r) => r,
        None => return,
    };
    let (root, snap) = scratch("identity");
    std::fs::write(&snap, &raw).unwrap();

    let before: Value = serde_json::from_str(&raw).unwrap();
    let f = fold_in(&root, &snap);

    assert!(f.conflicted.is_none());
    assert!(f.bad.is_empty(), "clean snapshot produced bad lines");
    assert_eq!(
        Value::Array(f.tasks.clone()),
        before,
        "fold with no logs must be the snapshot, byte for byte, in order"
    );
    println!("folded {} real tasks unchanged", f.tasks.len());
}

#[test]
fn numeric_fidelity_is_preserved() {
    let (root, snap) = scratch("numeric");
    write_snapshot(
        &snap,
        &json!([{"id":"a","n":3,"big":9007199254740993i64,"f":1.5,"zero":0}]),
    );
    let f = fold_in(&root, &snap);
    let t = task(&f, "a");
    assert!(t["n"].is_i64(), "int widened to float");
    assert_eq!(t["big"], json!(9007199254740993i64));
    assert_eq!(t["f"], json!(1.5));
    assert!(t["zero"].is_i64());
}

// ── 2. unknown keys ─────────────────────────────────────────────────────────

#[test]
fn unknown_keys_survive_a_patch() {
    let (root, snap) = scratch("unknown");
    // rec_id/rec_date/deleted_at do not exist in the live data today, so this
    // is where the "unknown keys survive" property is actually proven rather
    // than assumed.
    write_snapshot(
        &snap,
        &json!([{
            "id":"a","text":"x","done":false,
            "rec_id":"r1","rec_date":"2026-09-01","deleted_at":null,
            "something_a_future_release_adds":{"deep":[1,2,3]}
        }]),
    );
    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000","by":"hermes"}).to_string()],
    )
    .unwrap();

    let t = task(&fold_in(&root, &snap), "a");
    assert_eq!(t["done"], json!(true), "the patch applied");
    assert_eq!(t["rec_id"], json!("r1"), "rec_id dropped");
    assert_eq!(t["rec_date"], json!("2026-09-01"));
    assert_eq!(t["deleted_at"], Value::Null, "explicit null became missing");
    assert_eq!(t["something_a_future_release_adds"]["deep"], json!([1, 2, 3]));
}

#[test]
fn null_is_a_value_and_unset_is_removal() {
    let (root, snap) = scratch("null_vs_unset");
    write_snapshot(&snap, &json!([{"id":"a","start_date":null,"due_date":"2026-09-09"}]));
    append(
        &log_path_in(&root, "ui"),
        &[
            json!({"id":"a","start_date":null,"t":"2026-09-07T10:00:00.000"}).to_string(),
            json!({"id":"a","$unset":["due_date"],"t":"2026-09-07T10:00:01.000"}).to_string(),
        ],
    )
    .unwrap();
    let t = task(&fold_in(&root, &snap), "a");
    assert!(t.contains_key("start_date"), "null must not be a deletion");
    assert_eq!(t["start_date"], Value::Null);
    assert!(!t.contains_key("due_date"), "$unset must remove the key");
}

#[test]
fn arrays_replace_and_are_never_deep_merged() {
    let (root, snap) = scratch("arrays");
    write_snapshot(
        &snap,
        &json!([{"id":"a","subtasks":[{"id":"s1","text":"one","done":false},
                                      {"id":"s2","text":"two","done":false}]}]),
    );
    append(
        &log_path_in(&root, "ui"),
        &[json!({"id":"a","subtasks":[{"id":"s1","text":"one","done":true}],
                 "t":"2026-09-07T10:00:00.000"})
        .to_string()],
    )
    .unwrap();
    let t = task(&fold_in(&root, &snap), "a");
    assert_eq!(t["subtasks"].as_array().unwrap().len(), 1, "array must replace");
    assert_eq!(t["subtasks"][0]["done"], json!(true));
}

// ── 3. the Windows append bug ───────────────────────────────────────────────

#[test]
fn append_twice_produces_two_lines() {
    // Catches the missing read(true): on Windows, append(true) alone grants no
    // read access and the torn-tail heal fails with os error 5 on EVERY
    // append. This passes on Linux either way, which is how that bug ships.
    let (root, _snap) = scratch("append_twice");
    let p = log_path_in(&root, "ui");
    append(&p, &[json!({"id":"a","t":"1"}).to_string()]).unwrap();
    append(&p, &[json!({"id":"b","t":"2"}).to_string()]).unwrap();
    let body = std::fs::read_to_string(&p).unwrap();
    assert_eq!(body.lines().count(), 2, "second append failed: {:?}", body);
}

#[test]
fn torn_tail_is_ignored_then_healed_by_the_next_append() {
    let (root, snap) = scratch("torn");
    write_snapshot(&snap, &json!([{"id":"a","done":false}]));
    let p = log_path_in(&root, "ui");
    // a crash mid-write: a complete line, then a fragment with no newline
    std::fs::write(
        &p,
        format!(
            "{}\n{}",
            json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}),
            r#"{"id":"a","text":"half-writ"#
        ),
    )
    .unwrap();

    let f = fold_in(&root, &snap);
    assert_eq!(task(&f, "a")["done"], json!(true), "complete line must apply");
    assert!(f.bad.is_empty(), "a torn tail is not a bad line, it is incomplete");
    assert!(!task(&f, "a").contains_key("text"), "fragment must not apply");

    // the next append heals it
    append(&p, &[json!({"id":"a","priority":"high","t":"2026-09-07T10:00:02.000"}).to_string()])
        .unwrap();
    let body = std::fs::read_to_string(&p).unwrap();
    assert!(body.contains("half-writ\n"), "fragment should be newline-terminated");
    let f2 = fold_in(&root, &snap);
    assert_eq!(task(&f2, "a")["priority"], json!("high"));
    assert_eq!(f2.bad.len(), 1, "the healed fragment is now a parse failure");
}

// ── 4. bad input never stops the stream ─────────────────────────────────────

#[test]
fn corrupt_line_is_quarantined_and_the_stream_continues() {
    let (root, snap) = scratch("corrupt");
    write_snapshot(&snap, &json!([{"id":"a"},{"id":"b"}]));
    let p = log_path_in(&root, "hermes");
    std::fs::write(
        &p,
        format!(
            "{}\n{}\n{}\n{}\n",
            json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}),
            "{ this is not json",
            json!({"no_id":"here","t":"2026-09-07T10:00:01.000"}),
            json!({"id":"b","done":true,"t":"2026-09-07T10:00:02.000"})
        ),
    )
    .unwrap();

    let f = fold_in(&root, &snap);
    assert_eq!(f.bad.len(), 2, "expected 2 bad lines, got {:?}", f.bad);
    assert_eq!(task(&f, "a")["done"], json!(true), "line before the corruption");
    assert_eq!(task(&f, "b")["done"], json!(true), "line after the corruption");
    let q = std::fs::read_to_string(root.join("quarantine.jsonl")).unwrap();
    assert!(q.contains("not json"), "bad lines must be kept verbatim");
}

#[test]
fn git_conflict_markers_abort_the_fold_rather_than_dropping_edits() {
    let (root, snap) = scratch("conflict");
    write_snapshot(&snap, &json!([{"id":"a"}]));
    std::fs::write(
        log_path_in(&root, "ui"),
        "<<<<<<< HEAD\n{\"id\":\"a\",\"done\":true}\n=======\n{\"id\":\"a\",\"done\":false}\n>>>>>>> other\n",
    )
    .unwrap();
    let f = fold_in(&root, &snap);
    assert!(f.conflicted.is_some(), "must refuse, not silently drop a side");
}

// ── 5. ordering ─────────────────────────────────────────────────────────────

#[test]
fn snapshot_array_order_is_preserved_without_ord() {
    let (root, snap) = scratch("order_seed");
    write_snapshot(&snap, &json!([{"id":"c"},{"id":"a"},{"id":"b"}]));
    assert_eq!(ids(&fold_in(&root, &snap)), vec!["c", "a", "b"],
               "array position is real state; it must not be re-sorted");
}

#[test]
fn ord_moves_a_task_and_merges_like_any_other_field() {
    let (root, snap) = scratch("order_ord");
    write_snapshot(&snap, &json!([{"id":"c"},{"id":"a"},{"id":"b"}]));
    // send "b" to the top: below c's seeded 0.0
    append(
        &log_path_in(&root, "ui"),
        &[json!({"id":"b","ord":-1024.0,"t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    assert_eq!(ids(&fold_in(&root, &snap)), vec!["b", "c", "a"]);
}

#[test]
fn a_task_created_only_in_a_log_appears_after_seeded_ones() {
    let (root, snap) = scratch("order_new");
    write_snapshot(&snap, &json!([{"id":"a"},{"id":"b"}]));
    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"z","text":"made by an agent","t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    let f = fold_in(&root, &snap);
    assert_eq!(ids(&f), vec!["a", "b", "z"]);
    assert_eq!(task(&f, "z")["text"], json!("made by an agent"),
               "a set on an unseen id creates the task");
}

// ── 6. multi-writer determinism ─────────────────────────────────────────────

#[test]
fn writers_interleave_by_timestamp_not_by_filename() {
    let (root, snap) = scratch("interleave");
    write_snapshot(&snap, &json!([{"id":"a","priority":"none"}]));
    // hermes sorts before ui by filename, but its edit is LATER in time
    append(
        &log_path_in(&root, "ui"),
        &[json!({"id":"a","priority":"low","t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"a","priority":"high","t":"2026-09-07T10:00:05.000"}).to_string()],
    )
    .unwrap();
    assert_eq!(task(&fold_in(&root, &snap), "a")["priority"], json!("high"),
               "later timestamp must win regardless of file order");
}

#[test]
fn two_writers_touching_different_fields_both_survive() {
    // The lost-update case that a whole-file read-modify-write cannot handle.
    let (root, snap) = scratch("no_lost_update");
    write_snapshot(&snap, &json!([{"id":"a","text":"orig","priority":"none","done":false}]));
    append(
        &log_path_in(&root, "ui"),
        &[json!({"id":"a","text":"edited in the app","t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"a","done":true,"t":"2026-09-07T10:00:01.000"}).to_string()],
    )
    .unwrap();
    let t = task(&fold_in(&root, &snap), "a");
    assert_eq!(t["text"], json!("edited in the app"), "the app's edit was lost");
    assert_eq!(t["done"], json!(true), "the agent's edit was lost");
}

#[test]
fn an_agent_editing_a_row_in_place_still_folds_correctly() {
    // Agents will rewrite a line rather than append; the fold reads current
    // bytes and never assumes an immutable history, so this must just work.
    let (root, snap) = scratch("in_place");
    write_snapshot(&snap, &json!([{"id":"a","done":false}]));
    let p = log_path_in(&root, "hermes");
    std::fs::write(&p, format!("{}\n", json!({"id":"a","done":false,"t":"2026-09-07T10:00:00.000"})))
        .unwrap();
    assert_eq!(task(&fold_in(&root, &snap), "a")["done"], json!(false));

    std::fs::write(&p, format!("{}\n", json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"})))
        .unwrap();
    assert_eq!(task(&fold_in(&root, &snap), "a")["done"], json!(true),
               "an in-place edit must be picked up");
}

// ── 7. op:snapshot replaces ─────────────────────────────────────────────────

#[test]
fn op_snapshot_replaces_the_whole_task() {
    let (root, snap) = scratch("op_snapshot");
    write_snapshot(&snap, &json!([{"id":"a","text":"x","priority":"high","stale":"yes"}]));
    append(
        &log_path_in(&root, "ui"),
        &[json!({"op":"snapshot","id":"a","text":"replaced","t":"2026-09-07T10:00:00.000"})
            .to_string()],
    )
    .unwrap();
    let t = task(&fold_in(&root, &snap), "a");
    assert_eq!(t["text"], json!("replaced"));
    assert!(!t.contains_key("stale"), "op:snapshot must drop prior fields");
    assert!(!t.contains_key("priority"));
}

#[test]
fn header_lines_are_ignored() {
    let (root, snap) = scratch("header");
    write_snapshot(&snap, &json!([{"id":"a"}]));
    append(
        &log_path_in(&root, "ui"),
        &[json!({"op":"header","fmt":"leonote-log/1","t":"2026-09-07T09:00:00.000"}).to_string()],
    )
    .unwrap();
    let f = fold_in(&root, &snap);
    assert!(f.bad.is_empty(), "a header has no id but is not a bad line");
    assert_eq!(f.tasks.len(), 1);
}

// ── 8. the diff, and echo suppression by result ─────────────────────────────

#[test]
fn our_own_write_produces_an_empty_diff() {
    // This IS the echo suppression: no flag, no timer, no byte cursor.
    let (root, snap) = scratch("echo");
    write_snapshot(&snap, &json!([{"id":"a","done":false}]));
    let before = fold_in(&root, &snap);
    append(
        &log_path_in(&root, "ui"),
        &[json!({"id":"a","done":false,"t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    let after = fold_in(&root, &snap);
    assert!(diff(&before.tasks, &after.tasks).is_empty(),
            "a write that changes nothing must diff to nothing");
}

#[test]
fn diff_reports_only_changed_fields() {
    let (root, snap) = scratch("diff_fields");
    write_snapshot(&snap, &json!([{"id":"a","text":"x","done":false,"priority":"low"}]));
    let before = fold_in(&root, &snap);
    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    let d = diff(&before.tasks, &fold_in(&root, &snap).tasks);
    assert_eq!(d.len(), 1, "one task changed");
    let a = d["a"].as_object().unwrap();
    assert_eq!(a.len(), 1, "only `done` changed, got {:?}", a);
    assert_eq!(a["done"], json!(true));
}

#[test]
fn diff_reports_a_new_task_whole() {
    let (root, snap) = scratch("diff_new");
    write_snapshot(&snap, &json!([{"id":"a"}]));
    let before = fold_in(&root, &snap);
    append(
        &log_path_in(&root, "hermes"),
        &[json!({"id":"n","text":"new","t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    let d = diff(&before.tasks, &fold_in(&root, &snap).tasks);
    assert_eq!(d["n"]["text"], json!("new"));
}

// ── 9. op serialization ─────────────────────────────────────────────────────

#[test]
fn ops_to_lines_stamps_t_and_by_and_rejects_junk() {
    let ops = vec![json!({"id":"a","done":true})];
    let lines = ops_to_lines(&ops, "ui", "2026-09-07T10:00:00.000").unwrap();
    let v: Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(v["t"], json!("2026-09-07T10:00:00.000"));
    assert_eq!(v["by"], json!("ui"));

    // an explicit by/t is respected (an agent stamping its own)
    let ops = vec![json!({"id":"a","done":true,"by":"hermes","t":"2026-01-01T00:00:00.000"})];
    let v: Value =
        serde_json::from_str(&ops_to_lines(&ops, "ui", "2026-09-07T10:00:00.000").unwrap()[0])
            .unwrap();
    assert_eq!(v["by"], json!("hermes"));
    assert_eq!(v["t"], json!("2026-01-01T00:00:00.000"));

    assert!(ops_to_lines(&[json!("nope")], "ui", "t").is_err());
    assert!(ops_to_lines(&[json!({"done": true})], "ui", "t").is_err(), "needs an id");
}

#[test]
fn a_line_may_not_exceed_one_megabyte() {
    let (root, _snap) = scratch("bigline");
    let huge = "x".repeat(1_000_001);
    assert!(append(&log_path_in(&root, "ui"), &[huge]).is_err());
}

#[test]
fn writer_names_cannot_escape_the_log_directory() {
    let (root, _snap) = scratch("sanitize");
    let p = log_path_in(&root, "../../etc/passwd");
    assert!(p.starts_with(root.join("log")), "path traversal via writer name: {:?}", p);
}

// ── 10. a newline inside task text survives ─────────────────────────────────

#[test]
fn text_containing_a_newline_round_trips() {
    // The live data has exactly one of these, and it is why the format is
    // JSONL rather than one-markdown-line-per-task.
    let (root, snap) = scratch("newline");
    write_snapshot(&snap, &json!([{"id":"a","text":"line one\nline two"}]));
    append(
        &log_path_in(&root, "ui"),
        &[json!({"id":"a","text":"still\nmulti\nline","t":"2026-09-07T10:00:00.000"}).to_string()],
    )
    .unwrap();
    let f = fold_in(&root, &snap);
    assert_eq!(task(&f, "a")["text"], json!("still\nmulti\nline"));
    assert!(f.bad.is_empty(), "an embedded newline must not break the line grammar");
    let body = std::fs::read_to_string(log_path_in(&root, "ui")).unwrap();
    assert_eq!(body.lines().count(), 1, "the newline must be escaped, not literal");
}

// ── 11. scale ───────────────────────────────────────────────────────────────

#[test]
fn fold_of_the_real_snapshot_plus_a_log_is_fast() {
    let raw = match real_snapshot() {
        Some(r) => r,
        None => return,
    };
    let (root, snap) = scratch("perf");
    std::fs::write(&snap, &raw).unwrap();
    let tasks: Vec<Value> = serde_json::from_str(&raw).unwrap();
    let lines: Vec<String> = tasks
        .iter()
        .take(200)
        .enumerate()
        .map(|(i, t)| {
            json!({"id": t["id"], "priority":"low", "t": format!("2026-09-07T10:00:{:02}.000", i % 60)})
                .to_string()
        })
        .collect();
    append(&log_path_in(&root, "ui"), &lines).unwrap();

    let t0 = std::time::Instant::now();
    let f = fold_in(&root, &snap);
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    assert!(!f.tasks.is_empty());
    println!("fold of {} tasks + {} log lines: {:.2} ms", f.tasks.len(), lines.len(), ms);
    assert!(ms < 100.0, "fold took {:.1} ms - the no-tail-reader argument assumes it is cheap", ms);
}

// ── 12. compaction ──────────────────────────────────────────────────────────

#[test]
fn compaction_is_a_semantic_identity() {
    let (root, snap) = scratch("compact_identity");
    write_snapshot(&snap, &json!([
        {"id":"a","text":"one","done":false,"rec_id":"r1"},
        {"id":"b","text":"two","done":false},
        {"id":"c","text":"three","done":true,"completed_at":"2026-09-01T10:00:00"}
    ]));
    append(&log_path_in(&root, "ui"), &[
        json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}).to_string(),
        json!({"id":"z","text":"new one","t":"2026-09-07T10:00:01.000"}).to_string(),
    ]).unwrap();
    append(&log_path_in(&root, "hermes"), &[
        json!({"id":"b","priority":"high","t":"2026-09-07T10:00:02.000"}).to_string(),
    ]).unwrap();

    let before = fold_in(&root, &snap);
    let n = compact(&root, &snap, "20260907T100000").expect("compaction");
    assert_eq!(n, before.tasks.len());

    let after = fold_in(&root, &snap);
    let strip = |f: &Folded| -> Vec<Value> {
        f.tasks.iter().map(|v| {
            let mut m = v.as_object().cloned().unwrap();
            m.remove("ord");
            Value::Object(m)
        }).collect()
    };
    assert_eq!(strip(&after), strip(&before), "compaction changed the data");
    assert_eq!(ids(&after), ids(&before), "compaction reshuffled the order");

    // logs are empty but still present
    let ui = log_path_in(&root, "ui");
    assert!(ui.exists(), "logs must be truncated, not deleted");
    assert_eq!(std::fs::read_to_string(&ui).unwrap().trim(), "");

    // everything was archived first
    let hist = root.join("history").join("20260907T100000");
    assert!(hist.join("tasks.json").exists());
    assert!(hist.join("ui.jsonl").exists());
    assert!(hist.join("hermes.jsonl").exists());
    assert!(root.join("base.snapshot.json").exists());
}

#[test]
fn compaction_renormalises_ord_without_reordering() {
    let (root, snap) = scratch("compact_ord");
    write_snapshot(&snap, &json!([{"id":"a"},{"id":"b"},{"id":"c"}]));
    // drag c to the top with a fractional ord
    append(&log_path_in(&root, "ui"), &[
        json!({"id":"c","ord":-512.5,"t":"2026-09-07T10:00:00.000"}).to_string(),
    ]).unwrap();
    assert_eq!(ids(&fold_in(&root, &snap)), vec!["c", "a", "b"]);

    compact(&root, &snap, "20260907T100001").unwrap();
    let f = fold_in(&root, &snap);
    assert_eq!(ids(&f), vec!["c", "a", "b"], "order must survive compaction");
    let ords: Vec<f64> = f.tasks.iter().map(|t| t["ord"].as_f64().unwrap()).collect();
    assert_eq!(ords, vec![0.0, 1024.0, 2048.0], "ord must be renormalised");
}

#[test]
fn compaction_refuses_while_a_line_is_quarantined() {
    let (root, snap) = scratch("compact_refuse");
    write_snapshot(&snap, &json!([{"id":"a"}]));
    std::fs::write(
        log_path_in(&root, "hermes"),
        format!("{}\n{}\n", json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}), "{ broken"),
    ).unwrap();

    let err = compact(&root, &snap, "20260907T100002").unwrap_err();
    assert!(err.contains("unreadable"), "got: {}", err);
    // and it changed nothing
    let body = std::fs::read_to_string(log_path_in(&root, "hermes")).unwrap();
    assert!(body.contains("broken"), "the log must be untouched");
}

#[test]
fn compaction_refuses_on_conflict_markers() {
    let (root, snap) = scratch("compact_conflict");
    write_snapshot(&snap, &json!([{"id":"a"}]));
    std::fs::write(log_path_in(&root, "ui"),
        "<<<<<<< HEAD\n{\"id\":\"a\"}\n>>>>>>> b\n").unwrap();
    assert!(compact(&root, &snap, "20260907T100003").is_err());
}

#[test]
fn compaction_output_is_still_readable_by_the_python_app_shape() {
    // The snapshot IS ~/.leonote_tasks.json: a pretty-printed array of objects.
    let (root, snap) = scratch("compact_shape");
    write_snapshot(&snap, &json!([{"id":"a","text":"x","done":false,"subtasks":[]}]));
    append(&log_path_in(&root, "ui"), &[
        json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}).to_string(),
    ]).unwrap();
    compact(&root, &snap, "20260907T100004").unwrap();

    let raw = std::fs::read_to_string(&snap).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert!(v.is_array(), "must stay a JSON array");
    assert!(v[0].is_object());
    assert_eq!(v[0]["done"], json!(true));
    assert!(raw.contains("\n  "), "must stay pretty-printed for git diffs");
}

#[test]
fn a_second_compaction_is_a_no_op() {
    let (root, snap) = scratch("compact_twice");
    write_snapshot(&snap, &json!([{"id":"a","text":"x"}]));
    append(&log_path_in(&root, "ui"), &[
        json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}).to_string(),
    ]).unwrap();
    compact(&root, &snap, "c1").unwrap();
    let once = std::fs::read_to_string(&snap).unwrap();
    compact(&root, &snap, "c2").unwrap();
    assert_eq!(std::fs::read_to_string(&snap).unwrap(), once, "compaction must be idempotent");
}

// ── 13. compaction vs a concurrent appender ─────────────────────────────────

#[test]
fn a_line_appended_during_compaction_survives_and_still_applies() {
    let (root, snap) = scratch("compact_race_survives");
    write_snapshot(&snap, &json!([{"id":"a","text":"x","done":false}]));
    let hermes = log_path_in(&root, "hermes");
    append(&hermes, &[
        json!({"id":"a","text":"compacted","t":"2026-09-07T10:00:00.000"}).to_string(),
    ]).unwrap();

    let late = json!({"id":"a","done":true,"t":"2026-09-07T10:00:05.000"}).to_string();
    compact_with_hook(&root, &snap, "race1", || {
        // an agent appends after compaction read the logs, before it truncates
        append(&hermes, &[late.clone()]).unwrap();
    })
    .expect("compaction");

    let body = std::fs::read_to_string(&hermes).unwrap();
    assert_eq!(body, format!("{}\n", late), "only the unfolded line may remain");
    let snap_task = &serde_json::from_str::<Value>(&std::fs::read_to_string(&snap).unwrap()).unwrap()[0];
    assert_eq!(snap_task["done"], json!(false), "the late line was not part of this compaction");
    let f = fold_in(&root, &snap);
    assert_eq!(task(&f, "a")["done"], json!(true), "the late append must still apply");
    assert_eq!(task(&f, "a")["text"], json!("compacted"));
}

#[test]
fn compaction_never_replays_an_already_compacted_event() {
    // hermes set text early; ui set it later, so the snapshot says "new". If
    // hermes' log were kept whole because it grew, its old line would be
    // replayed on top of that snapshot - and with ui's log truncated there is
    // nothing newer left to beat it, so "old" would come back.
    let (root, snap) = scratch("compact_race_no_replay");
    write_snapshot(&snap, &json!([{"id":"a","text":"orig"}]));
    let hermes = log_path_in(&root, "hermes");
    append(&hermes, &[
        json!({"id":"a","text":"old","t":"2026-09-07T10:00:00.000"}).to_string(),
    ]).unwrap();
    append(&log_path_in(&root, "ui"), &[
        json!({"id":"a","text":"new","t":"2026-09-07T10:00:01.000"}).to_string(),
    ]).unwrap();

    compact_with_hook(&root, &snap, "race2", || {
        append(&hermes, &[
            json!({"id":"a","priority":"high","t":"2026-09-07T10:00:02.000"}).to_string(),
        ]).unwrap();
    })
    .expect("compaction");

    let body = std::fs::read_to_string(&hermes).unwrap();
    assert!(!body.contains("\"old\""), "compacted line was kept and would be replayed: {}", body);
    assert_eq!(std::fs::read_to_string(log_path_in(&root, "ui")).unwrap(), "");
    // Once ui's log is empty, a replayed "old" (t=10:00:00) would have nothing
    // newer to lose against in the logs and would overwrite the snapshot's "new".
    let f = fold_in(&root, &snap);
    assert_eq!(task(&f, "a")["text"], json!("new"));
    assert_eq!(task(&f, "a")["priority"], json!("high"));
}

#[test]
fn a_torn_tail_present_at_read_time_is_kept_for_its_writer_to_finish() {
    let (root, snap) = scratch("compact_race_torn");
    write_snapshot(&snap, &json!([{"id":"a"}]));
    let hermes = log_path_in(&root, "hermes");
    let done = json!({"id":"a","done":true,"t":"2026-09-07T10:00:00.000"}).to_string();
    std::fs::write(&hermes, format!("{}\n{{\"id\":\"a\",\"pri", done)).unwrap();

    compact(&root, &snap, "race3").expect("compaction");

    assert_eq!(std::fs::read_to_string(&hermes).unwrap(), "{\"id\":\"a\",\"pri");
    assert_eq!(task(&fold_in(&root, &snap), "a")["done"], json!(true));
}


#[test]
fn erased_tasks_lose_their_words_in_every_old_copy() {
    let (root, _snap) = scratch("scrub");
    let hist = root.join("history").join("20260918T120000.000");
    std::fs::create_dir_all(&hist).unwrap();
    std::fs::create_dir_all(root.join("history").join("notes").join("Keys-1")).unwrap();
    std::fs::write(hist.join("tasks.json"), serde_json::to_string_pretty(&json!([{ "id": "k", "text": "api key sk-123", "subtasks": [{ "id": "s", "text": "rotate it" }] }, { "id": "o", "text": "keep me" }])).unwrap()).unwrap();
    std::fs::write(hist.join("ui.jsonl"), "{\"id\":\"k\",\"text\":\"api key sk-123\",\"t\":\"2026-09-18T12:00:00.000\"}\nnot json\n{\"id\":\"o\",\"done\":true}\n").unwrap();
    std::fs::write(root.join("history").join("tasks-day1.json"), r#"[{"id":"k","text":"api key sk-123"}]"#).unwrap();
    let note = root.join("history").join("notes").join("Keys-1").join("a.md");
    std::fs::write(&note, "sk-123").unwrap();
    let ids: std::collections::HashSet<String> = ["k".to_string()].into();
    assert_eq!(scrub_history(&root, &ids), 3);
    let all = [hist.join("tasks.json"), hist.join("ui.jsonl"), root.join("history").join("tasks-day1.json")].iter().map(|p| std::fs::read_to_string(p).unwrap()).collect::<String>();
    assert!(!all.contains("sk-123") && !all.contains("rotate it"), "{}", all);
    assert!(all.contains("keep me") && all.contains("not json"), "other tasks and unreadable lines stay");
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "sk-123", "notes' versions are not the tasks' to touch");
    assert_eq!(scrub_history(&root, &ids), 0, "a second pass finds nothing");
}

// after the clock goes back, a change is stamped just after the newest one already logged, so it is not undone
#[test]
fn a_change_after_the_clock_went_back_still_wins() {
    let (root, snap) = scratch("clock_back");
    write_snapshot(&snap, &json!([{ "id": "a", "text": "x" }]));
    let ahead = (chrono::Local::now() + chrono::Duration::hours(1)).format("%Y-%m-%dT%H:%M:%S%.3f").to_string();
    std::fs::write(root.join("log/ui.jsonl"), format!("{}\n", json!({ "id": "a", "text": "before", "t": ahead }))).unwrap();
    fold_in(&root, &snap);
    let now = not_before_newest(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string());
    assert!(now > ahead, "{now} after {ahead}");
    append(&log_path_in(&root, "ui"), &ops_to_lines(&[json!({ "id": "a", "text": "after" })], "ui", &now).unwrap()).unwrap();
    assert_eq!(fold_in(&root, &snap).tasks[0]["text"], "after");
    // a stamp years ahead is a broken one: it does not drag the next change there
    let far = json!({ "id": "a", "text": "far", "t": "2099-01-01T00:00:00.000" });
    std::fs::write(root.join("log/x.jsonl"), format!("{far}\n")).unwrap();
    fold_in(&root, &snap);
    assert!(not_before_newest("2026-01-01T00:00:00.000".into()) < "2099".to_string());
}
