//! Importing changes the Python app made to the snapshot.
//!
//! The hard part is that the Python app reads tasks ONCE at startup and
//! writes that whole array back on every close. So when its file differs from
//! ours, most of the difference is not an edit - it is a stale copy of what we
//! already moved past. A two-way diff against our current fold would import
//! all of it and revert every agent edit made since Python launched.
//!
//! So: a THREE-WAY merge against `base.snapshot.json`, the byte copy of the
//! snapshot we last wrote.
//!
//!   field differs from base  -> a real Python edit  -> import
//!   field equals base        -> merely stale        -> ignore
//!   id in base, gone in py   -> _purge_old_trash    -> tombstone
//!   id not in base at all    -> ours, unknown to py -> ignore
//!
//! That last pair matters: without it, either every task Python purged
//! resurrects on the next import, or a short read looks like a mass deletion.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// A read of Python's snapshot is only trusted if it looks whole.
/// The Python app's `save_tasks` is a plain truncating `open(w)`, so a read
/// landing mid-write sees a prefix - or nothing.
///
/// The fraction ALONE is wrong on small datasets: with 2 tasks, one ordinary
/// `_purge_old_trash` deletion is a 50% drop and would be rejected as a
/// partial write, silently ignoring a real purge forever. So a drop must be
/// both large in proportion AND larger than a handful of tasks before we
/// distrust it. Purging a few is normal; losing most of the file is not.
const MIN_SURVIVING_FRACTION: f64 = 0.6;
const ALWAYS_ALLOWED_SHRINK: usize = 5;

pub fn base_path(root: &Path) -> PathBuf {
    root.join("base.snapshot.json")
}

fn index(rows: &[Value]) -> Map<String, Value> {
    let mut m = Map::new();
    for r in rows {
        if let Some(id) = r.get("id").and_then(|v| v.as_str()) {
            m.insert(id.to_string(), r.clone());
        }
    }
    m
}

fn read_array(p: &Path) -> Option<Vec<Value>> {
    let raw = std::fs::read_to_string(p).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(a)) => Some(a),
        _ => None,
    }
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Import {
    /// Ops to append to log/py.jsonl.
    pub ops: Vec<Value>,
    /// Human-readable reason we imported nothing, when that is a refusal
    /// rather than "there was nothing to do".
    pub refused: Option<String>,
}

/// Compare Python's snapshot against our base and produce ops for the real
/// edits only. Never writes anything itself.
pub fn import_python_changes(root: &Path, snapshot: &Path, now: &str) -> Import {
    let mut out = Import::default();

    let base = match read_array(&base_path(root)) {
        Some(b) => b,
        // No base yet: we have never written a snapshot, so we cannot tell an
        // edit from staleness. Importing everything would be guesswork.
        None => {
            out.refused = Some("no base snapshot yet - nothing to compare against".into());
            return out;
        }
    };
    let py = match read_array(snapshot) {
        Some(p) => p,
        None => {
            out.refused = Some("snapshot missing, empty or unparseable - ignored".into());
            return out;
        }
    };

    // Truncated-read hardening. A parse failure is never an empty list, and a
    // suspiciously short array is a short read, not a mass deletion.
    if !base.is_empty() && py.len() < base.len() {
        let lost = base.len() - py.len();
        let frac = py.len() as f64 / base.len() as f64;
        if lost > ALWAYS_ALLOWED_SHRINK && frac < MIN_SURVIVING_FRACTION {
            out.refused = Some(format!(
                "snapshot has {} tasks vs {} in base ({:.0}%, {} lost) - looks like a partial write, ignored",
                py.len(),
                base.len(),
                frac * 100.0,
                lost
            ));
            return out;
        }
    }

    let (bi, pi) = (index(&base), index(&py));

    // 1. field-level edits
    for (id, pyv) in pi.iter() {
        let pym = match pyv.as_object() {
            Some(m) => m,
            None => continue,
        };
        let basem = match bi.get(id).and_then(|v| v.as_object()) {
            Some(m) => m,
            // Unknown to base: Python created it (or base predates it). A
            // create is a real edit, so take it whole.
            None => {
                let mut op = pym.clone();
                op.insert("t".into(), Value::String(now.into()));
                op.insert("by".into(), Value::String("py".into()));
                out.ops.push(Value::Object(op));
                continue;
            }
        };

        let mut changed = Map::new();
        for (k, v) in pym.iter() {
            if k == "id" {
                continue;
            }
            // THE load-bearing comparison: against BASE, not against our fold.
            // A field that merely differs from our fold is stale, not edited.
            if basem.get(k) != Some(v) {
                changed.insert(k.clone(), v.clone());
            }
        }
        // keys Python removed relative to base
        let gone: Vec<Value> = basem
            .keys()
            .filter(|k| *k != "id" && !pym.contains_key(*k))
            .map(|k| Value::String(k.clone()))
            .collect();

        if !changed.is_empty() || !gone.is_empty() {
            let mut op = changed;
            op.insert("id".into(), Value::String(id.clone()));
            op.insert("t".into(), Value::String(now.into()));
            op.insert("by".into(), Value::String("py".into()));
            if !gone.is_empty() {
                op.insert("$unset".into(), Value::Array(gone));
            }
            out.ops.push(Value::Object(op));
        }
    }

    // 2. ids present in base but absent from Python's array: _purge_old_trash
    //    hard-deleted them. A tombstone, never a silent disappearance - and
    //    never a resurrection either, because we only look at base.
    for id in bi.keys() {
        if !pi.contains_key(id) {
            out.ops.push(serde_json::json!({
                "id": id,
                "deleted": true,
                "purged": true,
                "t": now,
                "by": "py"
            }));
        }
    }

    out
}
