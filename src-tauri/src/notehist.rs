//! Earlier versions of a note, kept beside the task store's own rotated
//! snapshots in `~/.leonote/history/`.
//!
//! ```text
//! ~/.leonote/history/
//!   20260918T101500.123/        one compaction (store.rs)
//!   notes/
//!     Welcome-1f3c9a02/
//!       path.txt                the vault-relative path, verbatim
//!       20260918T101500.123.md  the bytes the note had BEFORE that write
//! ```
//!
//! What gets kept, and why only this much: a snapshot of every keystroke-batch
//! would be a second copy of the vault. So the previous bytes are copied
//!
//!   * always, when the incoming text is empty or keeps under a third of what
//!     was there - the shape of a bug, not of an edit;
//!   * otherwise at most once every few minutes per note, so an ordinary
//!     afternoon of writing leaves a handful of restore points rather than
//!     thousands.
//!
//! Everything is capped: per note by count and bytes, and the whole folder by
//! bytes and directory count, oldest first. History that grows without bound
//! is a bug of its own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Snapshots kept per note.
pub const MAX_PER_NOTE: usize = 24;
/// Bytes kept per note.
pub const MAX_NOTE_BYTES: u64 = 4 * 1024 * 1024;
/// Bytes kept across every note.
pub const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
/// Notes with any history at all.
pub const MAX_NOTE_DIRS: usize = 400;
/// An ordinary save snapshots at most this often. A big shrink always does.
pub const ROUTINE_EVERY: Duration = Duration::from_secs(180);
/// Under this there is nothing much to lose, and the ratio gets noisy.
pub const SHRINK_MIN: usize = 80;

/// One kept version, newest first as `list` returns them.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Version {
    /// The timestamp folder name; also the handle `read` takes.
    pub stamp: String,
    pub size: u64,
    /// The first non-empty line, trimmed - enough to recognise it by.
    pub first_line: String,
    /// Line count, so "the one before it went empty" is obvious.
    pub lines: usize,
}

pub fn root_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("history").join("notes")
}

/// FNV-1a over the exact relative path: two notes never share a folder, and
/// the same note always finds its own again.
fn hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// A folder name that is readable and unique: the note's stem, made safe, plus
/// a hash of the whole path.
pub fn slug(rel: &str) -> String {
    let stem = rel.rsplit('/').next().unwrap_or(rel);
    let stem = stem.strip_suffix(".md").unwrap_or(stem);
    let mut safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect();
    safe.truncate(40);
    let safe = safe.trim().trim_end_matches('.').to_string();
    let safe = if safe.is_empty() { "note".to_string() } else { safe };
    format!("{}-{:08x}", safe, hash(rel) as u32)
}

pub fn note_dir(data_dir: &Path, rel: &str) -> PathBuf {
    root_dir(data_dir).join(slug(rel))
}

/// True when replacing `before` with `after` throws most of the note away.
/// Kept in step with `shrank()` in web/vault.js.
pub fn shrank(before: &str, after: &str) -> bool {
    if before.trim().len() < SHRINK_MIN {
        return false;
    }
    after.trim().is_empty() || after.len() * 10 < before.len() * 3
}

/// The snapshots of one note, newest first.
pub fn list(data_dir: &Path, rel: &str) -> Vec<Version> {
    let dir = note_dir(data_dir, rel);
    let mut out: Vec<Version> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let p = e.path();
                    if p.extension().map(|x| x != "md").unwrap_or(true) {
                        return None;
                    }
                    let stamp = p.file_stem()?.to_string_lossy().to_string();
                    let text = std::fs::read_to_string(&p).ok()?;
                    let first_line = text
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("")
                        .trim()
                        .chars()
                        .take(120)
                        .collect();
                    Some(Version {
                        stamp,
                        size: text.len() as u64,
                        first_line,
                        lines: text.lines().count(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    out
}

/// What erasing a note's traces found (or, dry, would find).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Erased {
    pub versions: usize,
    pub trash: usize,
    pub proposals: usize,
}

/// Every trace of one note outside the note itself: its kept versions, the
/// copies in the vault's trash that came from this very path, and proposed
/// edits that hold its text (waiting or settled). `dry` only counts them.
/// Backups made earlier are archives of their own and are not opened.
pub fn erase(data_dir: &Path, vault: &Path, rel: &str, dry: bool) -> Result<Erased, String> {
    let mut out = Erased::default();
    let dir = note_dir(data_dir, rel);
    out.versions = std::fs::read_dir(&dir).map(|rd| rd.flatten().filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false)).count()).unwrap_or(0);
    // what came from this path, and the kept copies of overwritten text, which know only the name
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let trash: Vec<String> = crate::trashbin::list(vault).into_iter().filter(|i| i.from.as_deref() == Some(rel) || (i.from.is_none() && i.name == name)).map(|i| i.entry).collect();
    out.trash = trash.len();
    let mut props = Vec::new();
    let pdir = crate::proposals::proposals_dir(data_dir);
    for d in [pdir.clone(), pdir.join("done")] {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "json").unwrap_or(true) { continue; }
            let hit = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).and_then(|v| v.get("path").and_then(|x| x.as_str()).map(|x| x == rel)).unwrap_or(false);
            if hit { props.push(p); }
        }
    }
    out.proposals = props.len();
    if dry { return Ok(out); }
    if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|e| format!("the kept versions: {}", e))?; }
    if !trash.is_empty() { crate::trashbin::remove(vault, &trash)?; }
    for p in props { std::fs::remove_file(&p).map_err(|e| format!("a proposed edit: {}", e))?; }
    Ok(out)
}

/// One snapshot's text.
pub fn read(data_dir: &Path, rel: &str, stamp: &str) -> Result<String, String> {
    if stamp.is_empty() || stamp.contains(['/', '\\', ':']) || stamp.contains("..") {
        return Err(format!("not a version stamp: {}", stamp));
    }
    let p = note_dir(data_dir, rel).join(format!("{}.md", stamp));
    std::fs::read_to_string(&p).map_err(|e| format!("{}: {}", stamp, e))
}

/// Copy `prev` into the note's history folder. Returns the stamp it got.
pub fn put(data_dir: &Path, rel: &str, prev: &str, stamp: &str) -> Result<String, String> {
    let dir = note_dir(data_dir, rel);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir history: {}", e))?;
    // so a folder full of hashes can still be read by a human
    let marker = dir.join("path.txt");
    if !marker.exists() {
        let _ = std::fs::write(&marker, rel);
    }
    // the newest version already holds this text: a write that keeps failing must not push the real ones out with copies
    let newest = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "md")).max();
    if let Some(p) = newest {
        if std::fs::read(&p).is_ok_and(|b| b == prev.as_bytes()) {
            return Ok(p.file_stem().unwrap_or_default().to_string_lossy().to_string());
        }
    }
    let mut name = format!("{}.md", stamp);
    let mut n = 1;
    while dir.join(&name).exists() {
        n += 1;
        name = format!("{}-{}.md", stamp, n);
    }
    crate::vault::write_atomic(&dir.join(&name), prev.as_bytes()).map_err(|e| format!("history {}: {}", rel, e))?;
    prune_note(&dir);
    Ok(name.trim_end_matches(".md").to_string())
}

/// A note was renamed or moved: its versions go with it. Best effort, like all of history.
pub fn moved(data_dir: &Path, from: &str, to: &str) {
    let (a, b) = (note_dir(data_dir, from), note_dir(data_dir, to));
    if a == b || !a.is_dir() || std::fs::create_dir_all(&b).is_err() {
        return;
    }
    for e in std::fs::read_dir(&a).into_iter().flatten().flatten() {
        let name = e.file_name();
        if name != "path.txt" && !b.join(&name).exists() {
            let _ = std::fs::rename(e.path(), b.join(&name));
        }
    }
    let _ = std::fs::write(b.join("path.txt"), to);
    let _ = std::fs::remove_file(a.join("path.txt"));
    let _ = std::fs::remove_dir(&a);
    prune_note(&b);
}

/// A folder was renamed or moved: the versions of every note that was under it.
pub fn moved_folder(data_dir: &Path, from: &str, to: &str) {
    let prefix = format!("{}/", from);
    for e in std::fs::read_dir(root_dir(data_dir)).into_iter().flatten().flatten() {
        let Ok(rel) = std::fs::read_to_string(e.path().join("path.txt")) else { continue };
        if let Some(rest) = rel.strip_prefix(&prefix) {
            moved(data_dir, &rel, &format!("{}/{}", to, rest));
        }
    }
}

/// Why a write is being snapshotted, or `None` when it is not.
fn worth_keeping(rel: &str, prev: &str, next: &str, last: &mut HashMap<String, Instant>) -> bool {
    if prev == next || prev.is_empty() {
        return false;
    }
    if shrank(prev, next) {
        return true;
    }
    match last.get(rel) {
        Some(t) if t.elapsed() < ROUTINE_EVERY => false,
        _ => true,
    }
}

/// The whole before-a-write step: read what is on disk, decide, keep it.
///
/// Never fails a write: history is a safety net, and a net that can stop you
/// saving is worse than no net. Errors are reported, not propagated.
pub fn before_write(
    data_dir: &Path,
    vault: &Path,
    rel: &str,
    next: &str,
    last: &mut HashMap<String, Instant>,
    stamp: &str,
    force: bool,
) -> Option<String> {
    let p = crate::vault::resolve_note(vault, rel).ok()?;
    let prev = match String::from_utf8(std::fs::read(&p).ok()?) {
        Ok(s) => s,
        // another encoding: what goes over it holds only replacement letters, and a version could not be read back.
        // The bytes go to the trash as they are; after this write the note is UTF-8, so this happens once.
        // A write that keeps failing comes back here on every retry: bytes the trash already holds stay out
        Err(e) => {
            let raw = e.into_bytes();
            let trash = vault.join(".trash");
            if !crate::trashbin::list(vault).iter().any(|i| i.from.as_deref() == Some(rel) && std::fs::read(trash.join(&i.entry)).is_ok_and(|b| b == raw)) {
                match crate::vault::backup_note(vault, rel, &crate::trash_stamp()) {
                    Ok(entry) => crate::trashbin::remember(vault, &entry, rel, crate::vault::Entry::Note, chrono::Local::now().timestamp_millis()),
                    Err(e) => eprintln!("note history: {}", e),
                }
            }
            return None;
        }
    };
    if !force && !worth_keeping(rel, &prev, next, last) {
        return None;
    }
    if prev.is_empty() {
        return None;
    }
    match put(data_dir, rel, &prev, stamp) {
        Ok(s) => {
            last.insert(rel.to_string(), Instant::now());
            Some(s)
        }
        Err(e) => {
            eprintln!("note history: {}", e);
            None
        }
    }
}

/// Drop this note's oldest snapshots until it is back inside its caps.
pub fn prune_note(dir: &Path) {
    let mut files: Vec<(String, u64, PathBuf)> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if p.extension().map(|x| x != "md").unwrap_or(true) {
                    return None;
                }
                let len = e.metadata().ok()?.len();
                Some((p.file_name()?.to_string_lossy().to_string(), len, p))
            })
            .collect(),
        Err(_) => return,
    };
    files.sort_by(|a, b| a.0.cmp(&b.0)); // stamps sort oldest first
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    let mut i = 0;
    // never the newest: the copy just kept stays even when it alone is over the size budget (a note over 4 MB)
    while i + 1 < files.len() && (files.len() - i > MAX_PER_NOTE || total > MAX_NOTE_BYTES) {
        if std::fs::remove_file(&files[i].2).is_ok() {
            total = total.saturating_sub(files[i].1);
        }
        i += 1;
    }
}

fn dir_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

/// Keep the whole notes history inside its caps, least recently written first.
/// Cheap enough to run once at startup; never on the save path.
pub fn sweep(data_dir: &Path) {
    let root = root_dir(data_dir);
    let mut dirs: Vec<(String, u64, PathBuf)> = match std::fs::read_dir(&root) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| {
                let p = e.path();
                // newest stamp in the folder: its "last touched"
                let newest = std::fs::read_dir(&p)
                    .map(|rd2| {
                        rd2.filter_map(|x| x.ok())
                            .map(|x| x.path())
                            .filter(|x| x.extension().is_some_and(|e| e == "md")) // not path.txt, which sorts above every stamp
                            .filter_map(|x| x.file_stem().map(|s| s.to_string_lossy().to_string()))
                            .max()
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                let bytes = dir_bytes(&p);
                (newest, bytes, p)
            })
            .collect(),
        Err(_) => return,
    };
    for (_, _, p) in &dirs {
        prune_note(p);
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0)); // oldest-touched first
    let mut total: u64 = dirs.iter().map(|d| d.1).sum();
    let mut i = 0;
    while i < dirs.len() && (dirs.len() - i > MAX_NOTE_DIRS || total > MAX_TOTAL_BYTES) {
        if std::fs::remove_dir_all(&dirs[i].2).is_ok() {
            total = total.saturating_sub(dirs[i].1);
        }
        i += 1;
    }
}
