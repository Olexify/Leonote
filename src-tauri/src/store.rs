//! The task store: one snapshot plus a directory of single-writer append-only
//! logs, folded by a pure function.
//!
//! Layout
//! ------
//! ```text
//! ~/.leonote_tasks.json      THE SNAPSHOT. Written only by compaction. Still
//!                            the exact shape the Python app reads.
//! ~/.leonote/
//!   log/ui.jsonl             this app's appends      (single writer)
//!   log/hermes.jsonl         an agent                (single writer)
//!   log/claude-w3.jsonl      another agent           (single writer)
//!   base.snapshot.json       byte copy of the snapshot we last wrote
//!   quarantine.jsonl         lines that would not parse, kept verbatim
//!   history/                 rotated snapshots and logs
//! ```
//!
//! Why one file per writer: with N processes appending to ONE file, a torn
//! write damages whatever record it lands in the middle of - including an
//! already-acknowledged one from a different writer. With one file per writer,
//! a half-written record can only ever damage its own author's tail, which the
//! next append heals. That deletes an entire class of corruption for about
//! twenty lines of reader code.
//!
//! Echo suppression falls out for free: the fold is pure, so our own write
//! produces a fold identical to the state we already hold and the diff is
//! empty. No self-write flag, no ignore window, no byte cursor - and therefore
//! no window in which a genuine agent write could be swallowed.

use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Envelope keys: metadata about the event, never task data.
const ENVELOPE: [&str; 4] = ["op", "id", "t", "by"];

/// Ordering gap between adjacent tasks. Inserting between two rows uses the
/// midpoint; compaction renormalises so the float never degrades.
pub const ORD_GAP: f64 = 1024.0;

/// A line we could not use, kept so nothing is ever silently dropped.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BadLine {
    pub file: String,
    pub lineno: usize,
    pub reason: String,
    pub raw: String,
}

#[derive(Debug, Default)]
pub struct Folded {
    pub tasks: Vec<Value>,
    pub bad: Vec<BadLine>,
    /// Set when a log contains git conflict markers. The fold refuses rather
    /// than silently dropping the conflicted region.
    pub conflicted: Option<String>,
    /// Set when the snapshot file is there but cannot be read as a task list
    /// (zero bytes after a hard reset, a torn write, not JSON). The fold then
    /// holds only what the logs say, and NOTHING may be compacted over the
    /// file: that is how a whole task list became `[]` once.
    pub snapshot_bad: Option<String>,
}

pub fn leonote_dir() -> PathBuf {
    if let Ok(d) = std::env::var("LEONOTE_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".leonote")
}

#[allow(dead_code)] // env-default convenience; the app uses the _in variants
pub fn log_dir() -> PathBuf {
    log_dir_in(&leonote_dir())
}

/// Explicit-root variants. The core takes its directory as a parameter so
/// tests are hermetic - an env-var override would be process-global and race
/// under cargo's parallel test threads.
pub fn log_dir_in(root: &Path) -> PathBuf {
    let d = root.join("log");
    let _ = std::fs::create_dir_all(&d);
    d
}

#[allow(dead_code)]
pub fn log_path(writer: &str) -> PathBuf {
    log_path_in(&leonote_dir(), writer)
}

pub fn log_path_in(root: &Path, writer: &str) -> PathBuf {
    log_dir_in(root).join(format!("{}.jsonl", sanitize(writer)))
}

/// Writer names become filenames, so keep them boring.
fn sanitize(w: &str) -> String {
    let s: String = w
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if s.is_empty() { "unknown".into() } else { s }
}

/// Append lines to one writer's log.
///
/// `read(true)` is load-bearing on Windows: `append(true)` alone grants
/// FILE_GENERIC_WRITE without FILE_READ_DATA, so the torn-tail heal below
/// fails with os error 5 on EVERY append. It passes on Linux either way, which
/// is exactly how that bug reaches a user.
pub fn append(path: &Path, lines: &[String]) -> std::io::Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    let mut buf: Vec<u8> = Vec::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    for l in lines {
        if l.len() > 1_000_000 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "log line exceeds 1 MB",
            ));
        }
        buf.extend_from_slice(l.as_bytes());
        buf.push(b'\n');
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut f = OpenOptions::new()
        .read(true)
        .create(true)
        .append(true)
        .open(path)?;
    let len = f.seek(SeekFrom::End(0))?;
    if len > 0 {
        let mut last = [0u8; 1];
        f.seek(SeekFrom::End(-1))?;
        f.read_exact(&mut last)?;
        if last[0] != b'\n' {
            // heal a torn tail left by our own crash
            f.write_all(b"\n")?;
        }
        f.seek(SeekFrom::End(0))?;
    }
    f.write_all(&buf)?;
    Ok(())
}

/// Record unreadable lines once per process. The watcher folds on every log
/// change, so without this the same bad line would be re-appended on every
/// agent write and the quarantine file would grow without bound.
fn quarantine(root: &Path, bad: &[BadLine]) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

    if bad.is_empty() {
        return;
    }
    let p = root.join("quarantine.jsonl");
    // seeded from what the file already holds: every start (and every --mcp session) folds the same bad lines again,
    // and they went in once more each time
    let mut seen = SEEN.get_or_init(|| {
        let mut s = HashSet::new();
        if let Ok(text) = std::fs::read_to_string(root.join("quarantine.jsonl")) {
            for l in text.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
                    s.insert(format!("{}\n{}\n{}\n{}", root.join("quarantine.jsonl").display(), v["file"].as_str().unwrap_or(""), v["lineno"].as_u64().unwrap_or(0), v["raw"].as_str().unwrap_or("")));
                }
            }
        }
        Mutex::new(s)
    }).lock().unwrap_or_else(|e| e.into_inner());
    let fresh: Vec<&BadLine> = bad
        .iter()
        .filter(|b| seen.insert(format!("{}\n{}\n{}\n{}", p.display(), b.file, b.lineno, b.raw)))
        .collect();
    if fresh.is_empty() {
        return;
    }
    let lines: Vec<String> = fresh
        .iter()
        .map(|b| {
            serde_json::json!({
                "file": b.file, "lineno": b.lineno,
                "reason": b.reason, "raw": b.raw
            })
            .to_string()
        })
        .collect();
    let _ = append(&p, &lines);
}

struct Event {
    t: String,
    writer: String,
    lineno: usize,
    obj: Map<String, Value>,
}

/// Fold the snapshot plus every log into current state.
///
/// Pure with respect to the bytes on disk: it never assumes the log is an
/// immutable history, so an agent that edits a row IN PLACE and an agent that
/// appends both produce correct state through this one code path.
#[allow(dead_code)]
pub fn fold(snapshot: &Path) -> Folded {
    fold_in(&leonote_dir(), snapshot)
}

pub fn fold_in(root: &Path, snapshot: &Path) -> Folded {
    fold_sources(root, snapshot, &read_logs(root))
}

/// One log's bytes, read exactly once.
///
/// Compaction must fold and truncate against the SAME bytes: re-reading the
/// file between the two is how an agent's append made in that window used to
/// be erased.
pub struct LogSource {
    pub writer: String,
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    /// Bytes up to and including the last `\n` - the part the fold uses.
    /// Anything after it is a torn or in-flight tail and was never applied.
    pub consumed: u64,
}

/// Read every log in the directory once, sorted by filename for determinism.
pub fn read_logs(root: &Path) -> Vec<LogSource> {
    logs_in(&log_dir_in(root))
}

fn logs_in(dir: &Path) -> Vec<LogSource> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
        .into_iter()
        .filter_map(|path| {
            let bytes = std::fs::read(&path).ok()?;
            let consumed = bytes.iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0) as u64;
            let writer = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            Some(LogSource { writer, path, bytes, consumed })
        })
        .collect()
}

/// The fold proper, over preloaded log bytes.
pub fn fold_sources(root: &Path, snapshot: &Path, sources: &[LogSource]) -> Folded {
    let mut out = Folded::default();
    let mut state: IndexMap<String, Map<String, Value>> = IndexMap::new();
    let mut seeded: IndexMap<String, f64> = IndexMap::new();

    // 1. seed from the snapshot, verbatim, in array order. A file that is
    // missing is a first run; a file that is there but unreadable is damage,
    // and is said so - never mistaken for "no tasks".
    match std::fs::read_to_string(snapshot) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Array(arr)) => {
                for (i, v) in arr.into_iter().enumerate() {
                    if let Value::Object(m) = v {
                        if let Some(id) = m.get("id").and_then(|x| x.as_str()).map(String::from) {
                            seeded.insert(id.clone(), i as f64 * ORD_GAP);
                            state.insert(id, m);
                        }
                    }
                }
            }
            Ok(_) => out.snapshot_bad = Some("not a list of tasks".into()),
            Err(e) => out.snapshot_bad = Some(format!("not valid JSON ({} bytes): {}", raw.len(), e)),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => out.snapshot_bad = Some(format!("unreadable: {}", e)),
    }

    // 2. collect events from every log (sources arrive sorted by filename)
    let mut events: Vec<Event> = Vec::new();

    for src in sources {
        let writer = src.writer.clone();
        let is_marker = |l: &[u8]| l.starts_with(b"<<<<<<<") || l.starts_with(b">>>>>>>");
        if src.bytes.split(|b| *b == b'\n').any(is_marker) {
            // A git merge wrote conflict markers into a log. Dropping the
            // unparseable region would silently lose real edits, so refuse.
            out.conflicted = Some(src.path.to_string_lossy().to_string());
            return out;
        }
        // ignore anything after the last newline: a torn tail from a crash or
        // a writer that is mid-append right now
        let complete = &src.bytes[..src.consumed as usize];
        let mut raw_lines: Vec<&[u8]> = complete.split(|b| *b == b'\n').collect();
        raw_lines.pop(); // the empty remainder after the final '\n'
        for (i, raw_line) in raw_lines.into_iter().enumerate() {
            let lineno = i + 1;
            let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
            // A non-UTF-8 line is bad data, not a reason to skip the whole
            // file: skipping would let compaction truncate edits it never read.
            let line = match std::str::from_utf8(raw_line) {
                Ok(l) => l,
                Err(_) => {
                    out.bad.push(BadLine {
                        file: writer.clone(), lineno,
                        reason: "not valid UTF-8".into(),
                        raw: String::from_utf8_lossy(raw_line).into_owned(),
                    });
                    continue;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let obj = match serde_json::from_str::<Value>(line) {
                Ok(Value::Object(m)) => m,
                Ok(_) => {
                    out.bad.push(BadLine {
                        file: writer.clone(), lineno,
                        reason: "not a JSON object".into(), raw: line.into(),
                    });
                    continue;
                }
                Err(e) => {
                    out.bad.push(BadLine {
                        file: writer.clone(), lineno,
                        reason: format!("parse: {}", e), raw: line.into(),
                    });
                    continue;
                }
            };
            if obj.get("op").and_then(|o| o.as_str()) == Some("header") {
                continue;
            }
            if !obj.get("id").map(|v| v.is_string()).unwrap_or(false) {
                out.bad.push(BadLine {
                    file: writer.clone(), lineno,
                    reason: "missing string id".into(), raw: line.into(),
                });
                continue;
            }
            events.push(Event {
                t: obj.get("t").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                writer: writer.clone(),
                lineno,
                obj,
            });
        }
    }

    // 3. deterministic order across writers
    events.sort_by(|a, b| {
        a.t.cmp(&b.t)
            .then_with(|| a.writer.cmp(&b.writer))
            .then_with(|| a.lineno.cmp(&b.lineno))
    });
    for e in events.iter().rev() { if saw(&e.t) { break; } }

    // 4. apply, per-field last-occurrence-wins
    for ev in &events {
        let id = ev.obj.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        let is_snapshot = ev.obj.get("op").and_then(|o| o.as_str()) == Some("snapshot");
        let slot = state.entry(id.clone()).or_insert_with(|| {
            let mut m = Map::new();
            m.insert("id".into(), Value::String(id.clone()));
            m
        });
        if is_snapshot {
            slot.clear();
            slot.insert("id".into(), Value::String(id.clone()));
        }
        for (k, v) in ev.obj.iter() {
            if ENVELOPE.contains(&k.as_str()) {
                continue;
            }
            if k == "$unset" {
                if let Some(names) = v.as_array() {
                    for n in names {
                        if let Some(n) = n.as_str() {
                            slot.remove(n);
                        }
                    }
                }
                continue;
            }
            // arrays replace wholesale - subtasks is never deep-merged
            slot.insert(k.clone(), v.clone());
        }
    }

    // 5. order by `ord`, falling back to the seeded array position. Tasks
    //    created by a log with no ord sort after everything seeded, by id.
    let max_seed = seeded.values().cloned().fold(0.0_f64, f64::max);
    let mut rows: Vec<(f64, String, Value)> = state
        .into_iter()
        .map(|(id, m)| {
            let ord = m
                .get("ord")
                .and_then(|v| v.as_f64())
                .or_else(|| seeded.get(&id).cloned())
                .unwrap_or(max_seed + ORD_GAP);
            (ord, id, Value::Object(m))
        })
        .collect();
    rows.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(&b.1))
    });
    out.tasks = rows.into_iter().map(|(_, _, v)| v).collect();

    if !out.bad.is_empty() {
        quarantine(root, &out.bad);
    }
    out
}

const T: &str = "%Y-%m-%dT%H:%M:%S%.3f";
/// The newest `t` a fold has seen. Last write wins by `t`, so after the clock goes back (summer time ending,
/// a corrected clock) a change stamped by it would lose at once to the older one and seem to undo itself.
static NEWEST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

fn saw(t: &str) -> bool {
    // a stamp far ahead is a broken one, not a clock that went back: it may not drag every change after it
    let Ok(d) = chrono::NaiveDateTime::parse_from_str(t, T) else { return false };
    if d > chrono::Local::now().naive_local() + chrono::Duration::days(2) { return false; }
    let mut n = NEWEST.lock().unwrap_or_else(|e| e.into_inner());
    if t > n.as_str() { *n = t.to_string(); }
    true
}

/// `now`, or just after the newest change already in the logs if the clock is behind it.
pub fn not_before_newest(now: String) -> String {
    let n = NEWEST.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if now > n { return now; }
    chrono::NaiveDateTime::parse_from_str(&n, T).map(|d| (d + chrono::Duration::milliseconds(1)).format(T).to_string()).unwrap_or(now)
}

/// Serialize ops as log lines, stamping `t` and `by` when absent.
pub fn ops_to_lines(ops: &[Value], writer: &str, now: &str) -> Result<Vec<String>, String> {
    let mut lines = Vec::with_capacity(ops.len());
    for op in ops {
        let mut m = match op {
            Value::Object(m) => m.clone(),
            _ => return Err("every op must be a JSON object".into()),
        };
        if !m.get("id").map(|v| v.is_string()).unwrap_or(false) {
            return Err("every op needs a string id".into());
        }
        m.entry("t").or_insert_with(|| Value::String(now.to_string()));
        m.entry("by").or_insert_with(|| Value::String(writer.to_string()));
        lines.push(Value::Object(m).to_string());
    }
    Ok(lines)
}

/// Field-level diff between two folds, keyed by task id. This is what the UI
/// patches with, and an empty diff is how an echo of our own write is
/// recognised - by result, not by timer.
pub fn diff(before: &[Value], after: &[Value]) -> Map<String, Value> {
    let index = |rows: &[Value]| -> IndexMap<String, Map<String, Value>> {
        rows.iter()
            .filter_map(|v| v.as_object())
            .filter_map(|m| {
                m.get("id")
                    .and_then(|i| i.as_str())
                    .map(|i| (i.to_string(), m.clone()))
            })
            .collect()
    };
    let (a, b) = (index(before), index(after));
    let mut out = Map::new();
    for (id, newm) in b.iter() {
        match a.get(id) {
            None => {
                out.insert(id.clone(), Value::Object(newm.clone()));
            }
            Some(oldm) => {
                let mut changed = Map::new();
                for (k, v) in newm.iter() {
                    if oldm.get(k) != Some(v) {
                        changed.insert(k.clone(), v.clone());
                    }
                }
                for k in oldm.keys() {
                    if !newm.contains_key(k) {
                        changed.insert(k.clone(), Value::Null);
                    }
                }
                if !changed.is_empty() {
                    out.insert(id.clone(), Value::Object(changed));
                }
            }
        }
    }
    for id in a.keys() {
        if !b.contains_key(id) {
            out.insert(id.clone(), Value::Null); // vanished from the fold
        }
    }
    out
}


/// Total bytes across all logs - the compaction trigger. From the listing alone: every caller asks only
/// whether there is anything, so no log is read for it.
pub fn log_bytes_in(root: &Path) -> u64 {
    let mut bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(log_dir_in(root)) {
        for e in rd.filter_map(|e| e.ok()) {
            if e.path().extension().map(|x| x == "jsonl").unwrap_or(false) {
                if let Ok(m) = e.metadata() { bytes += m.len(); }
            }
        }
    }
    bytes
}

// ── compaction ──────────────────────────────────────────────────────────────

/// Fold the logs back into the snapshot and truncate them.
///
/// This is the only destructive operation in the system, so it is paranoid:
///  * it refuses while any line is quarantined, because a process meant to be
///    a semantic identity must not erase edits it could not read;
///  * it asserts fold(before) == fold(after) - map AND order - in production,
///    not only under cargo test, and aborts on mismatch;
///  * it copies everything to history/ before touching anything;
///  * it TRUNCATES logs rather than deleting them, so an agent holding a file
///    handle keeps a valid inode and its next append lands at offset 0.
///
/// Never runs on the startup path: that is where the 39 ms budget lives.
pub fn compact(root: &Path, snapshot: &Path, stamp: &str) -> Result<usize, String> {
    compact_with_hook(root, snapshot, stamp, || {})
}

/// `after_read` runs right after the logs are read - the window in which a
/// concurrent append used to be lost. Tests use it to append in that window;
/// production passes a no-op.
pub(crate) fn compact_with_hook(
    root: &Path,
    snapshot: &Path,
    stamp: &str,
    after_read: impl FnOnce(),
) -> Result<usize, String> {
    let lock = root.join("compact.lock");
    // break a lock left by a crashed run
    if let Ok(md) = std::fs::metadata(&lock) {
        let stale = md
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs() > 60)
            .unwrap_or(true);
        if !stale {
            return Err("another compaction is running".into());
        }
        let _ = std::fs::remove_file(&lock);
    }
    if OpenOptions::new().write(true).create_new(true).open(&lock).is_err() {
        return Err("could not take the compaction lock".into());
    }
    let release = || {
        let _ = std::fs::remove_file(root.join("compact.lock"));
    };

    // Read each log ONCE. The fold, the history copy and the truncation below
    // all work from these bytes, so whatever lands after this point is kept.
    if snapshot_lost(root, snapshot) {
        release();
        return Err("refusing to compact: the task file is gone and a history copy holds tasks - what the logs alone hold would replace them".into());
    }
    let sources = read_logs(root);
    after_read();
    // an erase still in the logs (its own compaction was refused, or never came): folded now, so its words leave the old copies now too
    let erased: std::collections::HashSet<String> = sources.iter()
        .flat_map(|s| s.bytes[..s.consumed as usize].split(|b| *b == b'\n'))
        .filter_map(|l| serde_json::from_slice::<Value>(l).ok())
        .filter(|v| v["purged"] == true)
        .filter_map(|v| v["id"].as_str().map(String::from))
        .collect();
    let before = fold_sources(root, snapshot, &sources);
    if let Some(f) = before.conflicted {
        release();
        return Err(format!("refusing to compact: conflict markers in {}", f));
    }
    if let Some(why) = before.snapshot_bad {
        release();
        return Err(format!("refusing to compact: the task file is {} - writing what the logs alone hold would replace it", why));
    }
    if !before.bad.is_empty() {
        release();
        return Err(format!(
            "refusing to compact: {} unreadable line(s) quarantined - \
             compacting would erase edits that could not be parsed",
            before.bad.len()
        ));
    }

    // history first, so a failure after this point is still recoverable
    let hist = root.join("history").join(stamp);
    if std::fs::create_dir_all(&hist).is_err() {
        release();
        return Err("could not create history directory".into());
    }
    if snapshot.exists() {
        let _ = std::fs::copy(snapshot, hist.join("tasks.json"));
    }
    // history gets exactly the bytes that were folded, not a later re-read
    for s in &sources {
        if let Some(name) = s.path.file_name() {
            let _ = std::fs::write(hist.join(name), &s.bytes);
        }
    }

    // renormalise ord so the float never degrades, and emit in fold order
    let mut out: Vec<Value> = Vec::with_capacity(before.tasks.len());
    for (i, t) in before.tasks.iter().enumerate() {
        let mut m = t.as_object().cloned().unwrap_or_default();
        m.insert("ord".into(), Value::from(i as f64 * ORD_GAP));
        out.push(Value::Object(m));
    }

    let body = match serde_json::to_string_pretty(&out) {
        Ok(b) => b,
        Err(e) => {
            release();
            return Err(e.to_string());
        }
    };
    let tmp = snapshot.with_extension("json.compact.tmp");
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        Ok(())
    };
    if let Err(e) = write() {
        release();
        return Err(format!("write: {}", e));
    }

    // THE INVARIANT, checked in production: the new snapshot alone must fold
    // to exactly what snapshot+logs folded to. Only `ord` may differ, because
    // we just renormalised it.
    let verify_root = root.join("verify");
    let _ = std::fs::remove_dir_all(&verify_root);
    let _ = std::fs::create_dir_all(verify_root.join("log"));
    let after = fold_in(&verify_root, &tmp);
    let strip = |rows: &[Value]| -> Vec<Value> {
        rows.iter()
            .map(|v| {
                let mut m = v.as_object().cloned().unwrap_or_default();
                m.remove("ord");
                Value::Object(m)
            })
            .collect()
    };
    let ok = strip(&after.tasks) == strip(&before.tasks);
    let _ = std::fs::remove_dir_all(&verify_root);
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        release();
        return Err("compaction is not a semantic identity - aborted, nothing changed".into());
    }

    // an agent may edit its own log in place (AGENTS.md allows it): a log whose folded part is no longer what was read
    // would be trimmed by a count of bytes that no longer means those lines - nothing is changed, it is tried again later
    if sources.iter().any(|s| !prefix_unchanged(&s.path, &s.bytes[..s.consumed as usize])) {
        let _ = std::fs::remove_file(&tmp);
        release();
        return Err("a task log changed while it was being compacted - nothing changed, it is tried again later".into());
    }
    if let Err(e) = std::fs::rename(&tmp, snapshot) {
        let _ = std::fs::remove_file(&tmp);
        release();
        return Err(format!("rename: {}", e));
    }
    let _ = std::fs::copy(snapshot, root.join("base.snapshot.json"));

    // Truncate, never delete: an agent may be holding a handle. A log that
    // grew since the read keeps its unfolded suffix - dropping it loses an
    // agent's line, and keeping the whole file would replay already-compacted
    // events over the new snapshot and revert newer fields from other writers.
    for s in &sources {
        // changed in the moment since the check: left whole rather than cut at a count that no longer means those lines.
        // Its folded events then apply again over the new snapshot - which can bring back an older value another writer
        // had replaced - the lesser harm than cutting an agent's lines; said, and it can only happen in that moment
        if !prefix_unchanged(&s.path, &s.bytes[..s.consumed as usize]) { eprintln!("compact: {} changed while being trimmed - left whole", s.path.display()); continue; }
        if let Err(e) = drop_consumed_prefix(&s.path, s.consumed) {
            eprintln!("compact: could not trim {}: {}", s.path.display(), e);
        }
    }
    if !erased.is_empty() { scrub_history(root, &erased); }
    release();
    Ok(out.len())
}

/// Rotated snapshots kept in `history/`. Every compaction adds one, and
/// compaction runs at every launch and every exit, so without a cap this grows
/// for as long as the app is used.
pub const MAX_HISTORY: usize = 60;

/// Drop the oldest `history/<stamp>/` folders. Note versions live in
/// `history/notes/`, which is not a stamp and is capped by notehist.rs.
///
/// Off the write path: called once a launch, after compaction.
/// The fields of a task that hold what was written in it - blanked when a task
/// is erased, so a key or a password typed into one does not live on in a copy.
const WORDS: [&str; 7] = ["text", "subtasks", "notes", "note", "description", "title", "url"];

/// Blank the words of the tasks `ids` in one value: a task object, a list of
/// them, or a log line. Says whether anything changed.
pub fn scrub_value(v: &mut Value, ids: &std::collections::HashSet<String>) -> bool {
    match v {
        Value::Array(a) => a.iter_mut().fold(false, |ch, x| scrub_value(x, ids) || ch),
        Value::Object(o) => {
            if !o.get("id").and_then(|i| i.as_str()).map(|i| ids.contains(i)).unwrap_or(false) { return false; }
            let mut ch = false;
            for k in WORDS {
                if let Some(x) = o.get_mut(k) {
                    let blank = if x.is_array() { Value::Array(vec![]) } else { Value::String(String::new()) };
                    if *x != blank { *x = blank; ch = true; }
                }
            }
            ch
        }
        _ => false,
    }
}

/// The same in a file: a snapshot (`.json`) or a log (`.jsonl`, line by line;
/// a line that does not parse is left as it was). Rewritten by rename.
pub fn scrub_file(path: &Path, ids: &std::collections::HashSet<String>) -> Result<bool, String> {
    let text = match std::fs::read_to_string(path) { Ok(t) => t, Err(_) => return Ok(false) };
    let out = if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
        let mut ch = false;
        let lines: Vec<String> = text.split_inclusive('\n').map(|l| {
            let body = l.trim_end_matches(['\r', '\n']);
            let Ok(mut v) = serde_json::from_str::<Value>(body) else { return l.to_string() };
            if !scrub_value(&mut v, ids) { return l.to_string(); }
            ch = true;
            format!("{}{}", serde_json::to_string(&v).unwrap_or_default(), &l[body.len()..])
        }).collect();
        if !ch { return Ok(false); }
        lines.concat()
    } else {
        let mut v: Value = match serde_json::from_str(&text) { Ok(v) => v, Err(_) => return Ok(false) };
        if !scrub_value(&mut v, ids) { return Ok(false); }
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?
    };
    let tmp = path.with_extension("scrub.tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Every old copy the store keeps of tasks - the rotated snapshots and logs in
/// `history/` (not the notes' versions) and the base copy - scrubbed of the
/// words of `ids`. Gives how many files changed.
pub fn scrub_history(root: &Path, ids: &std::collections::HashSet<String>) -> usize {
    fn walk(dir: &Path, ids: &std::collections::HashSet<String>, n: &mut usize) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().map(|f| f == "notes").unwrap_or(false) { continue; }
                walk(&p, ids, n);
            } else if p.extension().map(|x| x == "damaged").unwrap_or(false)
                || (p.file_name().map(|f| f == "tasks.json").unwrap_or(false) // a data move copies the task file as it is
                    && std::fs::read(&p).map(|b| !matches!(serde_json::from_slice::<Value>(&b), Ok(Value::Array(_)))).unwrap_or(false))
            {
                // a damaged task file cannot be scrubbed, and a task cut off before its id would not even be recognised: the whole file goes
                if std::fs::remove_file(&p).is_ok() { *n += 1; }
            } else if p.extension().map(|x| x == "json" || x == "jsonl").unwrap_or(false) && scrub_file(&p, ids).unwrap_or(false) {
                *n += 1;
            }
        }
    }
    let mut n = 0;
    walk(&root.join("history"), ids, &mut n);
    for f in ["base.snapshot.json", "quarantine.jsonl"] {
        if scrub_file(&root.join(f), ids).unwrap_or(false) { n += 1; }
    }
    n
}

/// A damaged task file into the history, where it ages out and an erase reaches it.
/// The task file may be on another drive than the data folder, which a rename cannot cross.
fn move_damaged(root: &Path, file: &Path, stamp: &str) -> std::io::Result<()> {
    let keep = root.join("history").join(stamp.replace(['-', ':'], ""));
    std::fs::create_dir_all(&keep)?;
    let to = keep.join("tasks.damaged");
    std::fs::rename(file, &to).or_else(|_| std::fs::copy(file, &to).and_then(|_| std::fs::remove_file(file)))
}

/// A damaged task file an earlier build left beside the task file goes where one goes now.
pub fn adopt_damaged(root: &Path, snapshot: &Path) {
    let Some(name) = snapshot.file_name().map(|n| format!("{}.damaged-", n.to_string_lossy())) else { return };
    for e in std::fs::read_dir(snapshot.parent().unwrap_or(root)).into_iter().flatten().flatten() {
        if let Some(stamp) = e.file_name().to_string_lossy().strip_prefix(&name) { let _ = move_damaged(root, &e.path(), stamp); }
    }
}

/// A history folder's name as a compaction stamp: a data move names its copy
/// `before-move-<seconds>`, which by itself sorts after every date.
fn history_stamp(dir: &Path) -> String {
    let name = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    name.strip_prefix("before-move-").and_then(|s| s.parse().ok()).and_then(|s| chrono::DateTime::from_timestamp(s, 0))
        .map(|t| t.with_timezone(&chrono::Local).format("%Y%m%dT%H%M%S%.3f").to_string())
        .unwrap_or(name)
}

pub fn prune_history(root: &Path, max: usize) {
    let max = max.max(2); // the newest and one before it, whatever is asked
    let hist = root.join("history");
    let mut stamps: Vec<PathBuf> = match std::fs::read_dir(&hist) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| p.file_name().map(|n| n != "notes" && n != "settings").unwrap_or(false))
            .collect(),
        Err(_) => return,
    };
    if stamps.len() <= max {
        return;
    }
    stamps.sort_by_key(|p| history_stamp(p)); // the stamps sort oldest first
    let drop = stamps.len() - max;
    for p in stamps.into_iter().take(drop) {
        let _ = std::fs::remove_dir_all(&p);
    }
}

/// Remove the first `consumed` bytes of a log, keeping anything after them.
/// The log still starts with exactly the bytes that were folded.
fn prefix_unchanged(path: &Path, folded: &[u8]) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else { return folded.is_empty() };
    let mut now = vec![0u8; folded.len()];
    f.read_exact(&mut now).is_ok() && now == folded
}

fn drop_consumed_prefix(path: &Path, consumed: u64) -> std::io::Result<()> {
    let mut f = OpenOptions::new().read(true).write(true).open(path)?;
    let len = f.metadata()?.len();
    if len <= consumed {
        return f.set_len(0);
    }
    // Read-truncate-rewrite back to back to keep the unavoidable window (no
    // cooperative lock exists with foreign appenders) as short as possible.
    let mut rest = Vec::with_capacity((len - consumed) as usize);
    f.seek(SeekFrom::Start(consumed))?;
    f.read_to_end(&mut rest)?;
    f.set_len(0)?;
    f.seek(SeekFrom::Start(0))?;
    f.write_all(&rest)?;
    Ok(())
}


/// The newest history copy that holds tasks: (file, how many, the entry's
/// stamp). What a damaged or vanished task file is offered back from.
pub fn newest_history_tasks(root: &Path) -> Result<Option<(PathBuf, usize, String)>, String> {
    Ok(history_tasks_all(root)?.into_iter().next().map(|(f, n, _, _)| {
        let stamp = history_stamp(f.parent().unwrap_or(root));
        (f, n, stamp)
    }))
}

/// The task file has vanished although a history copy holds tasks, or may (the
/// history cannot be read), and nothing was restored since: damage, not a first run.
pub fn snapshot_lost(root: &Path, snapshot: &Path) -> bool {
    !snapshot.exists()
        && std::fs::metadata(log_path_in(root, "restore")).map(|m| m.len() == 0).unwrap_or(true)
        && !matches!(newest_history_tasks(root), Ok(None))
}

/// Every history copy that holds tasks, newest first: (file, how many, stamp, bytes).
/// No history folder is no copies; one that cannot be read is an error, not "none".
pub fn history_tasks_all(root: &Path) -> Result<Vec<(PathBuf, usize, String, u64)>, String> {
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(root.join("history")) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    entries.sort_by_key(|p| history_stamp(p));
    let mut out = Vec::new();
    let mut unread = None;
    for dir in entries.into_iter().rev() {
        let f = dir.join("tasks.json");
        let raw = match std::fs::read_to_string(&f) {
            Ok(raw) => raw,
            Err(e) => {
                // no copy in that folder, or a copy that is not text, is not a failure to look
                if !matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData) { unread = Some(e.to_string()); }
                continue;
            }
        };
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&raw) {
            let n = arr.iter().filter(|t| t.get("id").and_then(|i| i.as_str()).is_some()).count();
            if n > 0 { out.push((f, n, dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), raw.len() as u64)); }
        }
    }
    if let (true, Some(e)) = (out.is_empty(), unread) { return Err(e); }
    Ok(out)
}

/// Every task of a history copy appended to a restore log as a `set` each, the
/// way any writer restores: the fold does the rest. A damaged task file is moved
/// into the history afterwards, so the fold and compaction work again and it ages
/// out with the copies there. Returns how many went.
pub fn restore_from(root: &Path, snapshot: &Path, file: &Path, now: &str) -> Result<usize, String> {
    if !file.is_file() { return Err("that copy is gone".into()); }
    let dir = file.parent().unwrap_or(root);
    // the copy is the list from before that session, and that session's edits lie beside it: together, how it ended
    let copy = fold_sources(dir, file, &logs_in(dir));
    if copy.snapshot_bad.is_some() || copy.conflicted.is_some() { return Err("that copy is not a list of tasks".into()); }
    // without a task file, the logs are all that is left of the work since the copy: they are newer, so only what they lack comes from it
    let cur = fold_in(root, snapshot);
    let lost = cur.snapshot_bad.is_some() || !snapshot.exists();
    let have: std::collections::HashMap<&str, &Value> = if lost { cur.tasks.iter().filter_map(|t| Some((t.get("id")?.as_str()?, t))).collect() } else { Default::default() };
    let mut lines: Vec<String> = Vec::new();
    let mut n = 0;
    for t in copy.tasks {
        let Value::Object(mut m) = t else { continue };
        let Some(id) = m.get("id").and_then(|i| i.as_str()).map(String::from) else { continue };
        n += 1;
        if let Some(Value::Object(c)) = have.get(id.as_str()) {
            m.retain(|k, _| k == "id" || !c.contains_key(k));
            if m.len() == 1 { continue; }
        }
        m.insert("t".into(), Value::String(now.to_string()));
        m.insert("by".into(), Value::String("restore".into()));
        lines.push(serde_json::to_string(&Value::Object(m)).map_err(|e| e.to_string())?);
    }
    // the restore log says a restore happened, even when the copy had nothing to add (snapshot_lost)
    if lost { lines.push(format!("{{\"op\":\"header\",\"by\":\"restore\",\"t\":\"{}\"}}", now)); }
    append(&log_path_in(root, "restore"), &lines).map_err(|e| e.to_string())?;
    if cur.snapshot_bad.is_some() {
        move_damaged(root, snapshot, now)
            .map_err(|e| format!("The tasks are saved, but the damaged task file could not be moved away: {}. Close what holds it and start Leonote again.", e))?;
    }
    Ok(n)
}

#[cfg(test)]
mod damage_tests {
    use super::*;
    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("leonote-damage-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(d.join("log")).unwrap();
        d
    }
    #[test]
    fn a_zero_byte_task_file_is_damage_not_emptiness() {
        let d = tmp();
        let snap = d.join("tasks.json");
        std::fs::write(&snap, b"").unwrap();
        let f = fold_in(&d, &snap);
        assert!(f.snapshot_bad.is_some(), "an empty file must be reported, not folded as no tasks");
        let r = compact(&d, &snap, "t1");
        assert!(r.is_err(), "compaction must refuse over a damaged file");
        assert_eq!(std::fs::read(&snap).unwrap(), b"", "the file is left as it was");
    }
    #[test]
    fn a_missing_task_file_is_a_first_run() {
        let d = tmp();
        let f = fold_in(&d, &d.join("tasks.json"));
        assert!(f.snapshot_bad.is_none());
        assert!(f.tasks.is_empty());
    }
    #[test]
    fn a_history_copy_comes_back_through_the_log() {
        let d = tmp();
        std::fs::create_dir_all(d.join("history").join("20260922T165901")).unwrap();
        std::fs::write(d.join("history").join("20260922T165901").join("tasks.json"), br#"[{"id":"a","text":"one"},{"id":"b","text":"two"}]"#).unwrap();
        let (file, n, _) = newest_history_tasks(&d).unwrap().unwrap();
        assert_eq!(n, 2);
        assert_eq!(restore_from(&d, &d.join("tasks.json"), &file, "2026-09-24T02:00:00.000").unwrap(), 2);
        let f = fold_in(&d, &d.join("tasks.json"));
        assert_eq!(f.tasks.len(), 2);
    }
    #[test]
    fn a_damaged_task_file_recovers_the_last_session_and_keeps_newer_edits() {
        let d = tmp();
        let snap = d.join("tasks.json");
        let h = d.join("history").join("20260922T165901");
        std::fs::create_dir_all(&h).unwrap();
        std::fs::write(h.join("tasks.json"), br#"[{"id":"a","text":"old","prio":"low"}]"#).unwrap();
        // that session's edits, kept beside the copy
        std::fs::write(h.join("app.jsonl"), "{\"id\":\"a\",\"text\":\"session\",\"t\":\"2026-09-22T10:00:00.000\"}\n{\"id\":\"b\",\"text\":\"made then\",\"t\":\"2026-09-22T10:00:01.000\"}\n").unwrap();
        // an edit since, in the live log, and a task file that is gone bad
        std::fs::write(log_path_in(&d, "app"), "{\"id\":\"b\",\"text\":\"newest\",\"t\":\"2026-09-23T10:00:00.000\"}\n").unwrap();
        std::fs::write(&snap, b"").unwrap();
        let file = h.join("tasks.json");
        let text = |id: &str| fold_in(&d, &snap).tasks.iter().find(|t| t["id"] == id).map(|t| t["text"].as_str().unwrap().to_string());
        assert_eq!(restore_from(&d, &snap, &file, "2026-09-24T02:00:00.000").unwrap(), 2);
        assert!(fold_in(&d, &snap).snapshot_bad.is_none(), "the damaged file is out of the way");
        let kept = d.join("history").join("20260924T020000.000").join("tasks.damaged");
        assert!(kept.is_file(), "and kept with the old copies");
        assert_eq!(newest_history_tasks(&d).unwrap().unwrap().0, file, "it is no copy to restore from");
        assert_eq!(text("a").as_deref(), Some("session"));
        assert_eq!(text("b").as_deref(), Some("newest"));
        // a second click takes nothing back
        restore_from(&d, &snap, &file, "2026-09-24T03:00:00.000").unwrap();
        assert_eq!(text("b").as_deref(), Some("newest"));
        assert!(compact(&d, &snap, "t2").is_ok(), "compaction works again");
        // no words stay behind after an erase
        scrub_history(&d, &["a".to_string()].into());
        assert!(!kept.exists(), "erasing a task leaves no damaged copy that may still hold its words");
    }
    #[test]
    fn an_erase_reaches_every_damaged_copy() {
        let d = tmp();
        let snap = d.join("tasks.json");
        std::fs::create_dir_all(d.join("history").join("20260922T165901")).unwrap();
        let copy = d.join("history").join("20260922T165901").join("tasks.json");
        std::fs::write(&copy, br#"[{"id":"x","text":"sk-123"},{"id":"o","text":"other"}]"#).unwrap();
        // a data move copied a damaged task file under the ordinary name
        let moved = d.join("history").join("before-move-1000000000");
        std::fs::create_dir_all(&moved).unwrap();
        std::fs::write(moved.join("tasks.json"), b"[{\"id\":\"x\",\"text\":\"sk-1").unwrap();
        // erased while the task file is damaged: the compaction is refused, the erase stays in the log
        std::fs::write(&snap, b"[{\"id\":\"x\",\"text\":\"sk-1").unwrap();
        std::fs::write(log_path_in(&d, "app"), "{\"id\":\"x\",\"purged\":true,\"text\":\"\",\"subtasks\":[],\"t\":\"2026-09-24T01:00:00.000\"}\n").unwrap();
        assert!(compact(&d, &snap, "t1").is_err());
        restore_from(&d, &snap, &copy, "2026-09-24T02:00:00.000").unwrap();
        let kept = d.join("history").join("20260924T020000.000").join("tasks.damaged");
        assert!(kept.is_file(), "still there: nothing has folded the erase yet");
        // the next compaction folds it, and nothing has to ask again
        compact(&d, &snap, "20260924T030000.000").unwrap();
        assert!(!kept.exists() && !moved.join("tasks.json").exists(), "no damaged copy outlives the erase");
        assert!(!std::fs::read_to_string(&copy).unwrap().contains("sk-123"));
        assert!(std::fs::read_to_string(&copy).unwrap().contains("other"), "other tasks in a readable copy stay");
    }
    #[test]
    fn a_damaged_file_from_an_earlier_build_joins_the_history() {
        let d = tmp();
        let beside = d.join("home");
        std::fs::create_dir_all(&beside).unwrap();
        let snap = beside.join(".tasks.json");
        let old = beside.join(".tasks.json.damaged-2026-09-24T020000.000");
        std::fs::write(&old, b"[{").unwrap();
        std::fs::write(beside.join("other.damaged-x"), b"mine").unwrap();
        adopt_damaged(&d, &snap);
        assert!(!old.exists() && beside.join("other.damaged-x").exists());
        let kept = d.join("history").join("20260924T020000.000").join("tasks.damaged");
        assert!(kept.is_file());
        scrub_history(&d, &["x".to_string()].into());
        assert!(!kept.exists());
    }
    #[test]
    fn a_copy_from_before_a_data_move_takes_its_place_by_date() {
        let d = tmp();
        let copy = |name: &str| {
            let h = d.join("history").join(name);
            std::fs::create_dir_all(&h).unwrap();
            std::fs::write(h.join("tasks.json"), br#"[{"id":"a","text":"one"}]"#).unwrap();
            h
        };
        let moved = copy("before-move-1000000000"); // 2001
        let session = copy("20260922T165901.000");
        let (file, _, stamp) = newest_history_tasks(&d).unwrap().unwrap();
        assert_eq!(file, session.join("tasks.json"), "the newest by date, not by how the name sorts");
        assert_eq!(stamp, "20260922T165901.000");
        assert_eq!(history_tasks_all(&d).unwrap()[1].0, moved.join("tasks.json"));
        copy("20260923T165901.000");
        prune_history(&d, 2);
        assert!(!moved.exists(), "and it ages out first");
        // when it is the newest it says when, for the toast's date
        copy("before-move-4000000000");
        let stamp = newest_history_tasks(&d).unwrap().unwrap().2;
        assert!(stamp.starts_with("2096") && stamp.contains('T'), "{}", stamp);
    }
    #[test]
    fn a_history_that_cannot_be_read_is_not_no_copies() {
        let d = tmp();
        let snap = d.join("tasks.json");
        // a file where the folder belongs: read_dir fails, as it does for a folder the user may not open
        std::fs::write(d.join("history"), b"").unwrap();
        assert!(history_tasks_all(&d).is_err());
        assert!(newest_history_tasks(&d).is_err());
        assert!(snapshot_lost(&d, &snap), "no task file and no way to look: nothing may replace it");
        assert!(compact(&d, &snap, "t1").unwrap_err().contains("refusing"));
        // and a folder that reads, with the only copy not readable
        std::fs::remove_file(d.join("history")).unwrap();
        std::fs::create_dir_all(d.join("history").join("20260922T165901").join("tasks.json")).unwrap();
        assert!(history_tasks_all(&d).is_err(), "a copy that could not be read is not none");
        // no history at all is a first run
        std::fs::remove_dir_all(d.join("history")).unwrap();
        assert!(matches!(newest_history_tasks(&d), Ok(None)));
        assert!(!snapshot_lost(&d, &snap));
    }
    #[test]
    fn a_vanished_task_file_is_not_replaced_by_what_the_logs_alone_hold() {
        let d = tmp();
        let snap = d.join("tasks.json");
        let h = d.join("history").join("20260922T165901");
        std::fs::create_dir_all(&h).unwrap();
        std::fs::write(h.join("tasks.json"), br#"[{"id":"a","text":"one"}]"#).unwrap();
        std::fs::write(log_path_in(&d, "agent"), "{\"id\":\"a\",\"done\":true,\"t\":\"2026-09-23T10:00:00.000\"}\n").unwrap();
        assert!(snapshot_lost(&d, &snap));
        assert!(compact(&d, &snap, "t1").is_err());
        assert!(!snap.exists());
        restore_from(&d, &snap, &h.join("tasks.json"), "2026-09-24T02:00:00.000").unwrap();
        assert!(!snapshot_lost(&d, &snap));
        compact(&d, &snap, "t2").unwrap();
        let t = fold_in(&d, &snap).tasks;
        assert_eq!((t[0]["text"].as_str(), t[0]["done"].as_bool()), (Some("one"), Some(true)));
    }
}
