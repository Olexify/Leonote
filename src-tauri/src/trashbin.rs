//! The vault's `.trash`, looked after.
//!
//! Deleting in Leonote moves a thing into `<vault>/.trash/<stamp> <name>`.
//! This module remembers where each entry came from (a small index beside
//! the entries), lists the trash, puts things back, and lets entries go for
//! good once they are older than the time the user chose in Settings.
//!
//! An entry's age comes from the index or from the stamp in its name - never
//! from the file's own dates, which a move keeps from long before. An entry
//! whose age cannot be told is never swept.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::vault::{self, Entry};
use crate::{lock, AppState};

const INDEX: &str = ".index.json";
const DAY_MS: i64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Origin {
    pub from: String,
    pub kind: String,
    pub at: i64,
}

type Index = BTreeMap<String, Origin>;

fn index_path(root: &Path) -> PathBuf {
    root.join(".trash").join(INDEX)
}

fn load(root: &Path) -> Index {
    std::fs::read(index_path(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(root: &Path, ix: &Index) {
    let p = index_path(root);
    if ix.is_empty() {
        let _ = std::fs::remove_file(p);
        return;
    }
    if let Ok(body) = serde_json::to_vec_pretty(ix) {
        let _ = vault::write_atomic(&p, &body);
    }
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

fn kind_name(kind: Entry) -> &'static str {
    match kind {
        Entry::Note => "note",
        Entry::File => "file",
        Entry::Folder => "folder",
    }
}

fn kind_of(s: &str) -> Entry {
    match s {
        "note" => Entry::Note,
        "folder" => Entry::Folder,
        _ => Entry::File,
    }
}

/// Delete something from the vault the way the user chose: into .trash (the
/// default), into the Windows Recycle Bin, or - asked for explicitly - for good.
pub fn dispose(root: &Path, rel: &str, kind: Entry, mode: Option<&str>, stamp: &str) -> Result<(), String> {
    match mode {
        Some("forever") => vault::destroy(root, rel, kind),
        Some("bin") => crate::outpost::recycle(&[vault::locate(root, rel, kind)?]),
        _ => {
            let entry = match kind {
                Entry::File => vault::trash_file(root, rel, stamp)?,
                k => vault::trash(root, rel, stamp, k == Entry::Note)?,
            };
            remember(root, &entry, rel, kind, now_ms());
            Ok(())
        }
    }
}

pub fn remember(root: &Path, entry: &str, from: &str, kind: Entry, at: i64) {
    let mut ix = load(root);
    ix.insert(entry.to_string(), Origin { from: from.to_string(), kind: kind_name(kind).into(), at });
    save(root, &ix);
}

/// When an entry went in, read from its name: "2026-09-15 101500 name" is a
/// deletion, "name (before mcp 20260915-101500).md" a copy kept for an agent.
pub fn stamp_ms(entry: &str) -> Option<i64> {
    use chrono::{Local, NaiveDateTime, TimeZone};
    let local = |n: NaiveDateTime| Local.from_local_datetime(&n).earliest().map(|d| d.timestamp_millis());
    if let Some(head) = entry.get(..17) {
        if let Ok(n) = NaiveDateTime::parse_from_str(head, "%Y-%m-%d %H%M%S") {
            return local(n);
        }
    }
    let i = entry.find("(before mcp ")? + 12;
    let n = NaiveDateTime::parse_from_str(entry.get(i..i + 15)?, "%Y%m%d-%H%M%S").ok()?;
    local(n)
}

#[derive(Serialize, Debug)]
pub struct Item {
    pub entry: String,
    pub name: String,
    /// Where it was, when the trash knows; a kept copy of an overwritten file has none.
    pub from: Option<String>,
    pub kind: String,
    pub at: Option<i64>,
    pub size: u64,
    /// Files inside, for a folder.
    pub count: u32,
}

fn weigh(p: &Path, depth: u32) -> (u64, u32) {
    let Ok(md) = p.symlink_metadata() else { return (0, 0) };
    if !md.is_dir() {
        return (md.len(), 1);
    }
    if depth > 24 {
        return (0, 0);
    }
    let mut sum = (0, 0);
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let (s, c) = weigh(&e.path(), depth + 1);
            sum = (sum.0 + s, sum.1 + c);
        }
    }
    sum
}

/// What is in the trash, newest first.
pub fn list(root: &Path) -> Vec<Item> {
    let ix = load(root);
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root.join(".trash")) else { return out };
    for e in rd.flatten() {
        let entry = e.file_name().to_string_lossy().to_string();
        if entry.starts_with('.') {
            continue;
        }
        let p = e.path();
        let is_dir = p.symlink_metadata().map(|m| m.is_dir()).unwrap_or(false);
        let known = ix.get(&entry);
        let stamped = entry.get(..17).is_some_and(|h| chrono::NaiveDateTime::parse_from_str(h, "%Y-%m-%d %H%M%S").is_ok());
        let name = match known {
            Some(o) => o.from.rsplit('/').next().unwrap_or(&o.from).to_string(),
            None if stamped => entry.get(18..).unwrap_or(&entry).to_string(),
            None => entry.clone(),
        };
        let kind = match known {
            Some(o) => o.kind.clone(),
            None if is_dir => "folder".into(),
            None if vault::is_note(&name) => "note".into(),
            None => "file".into(),
        };
        let (size, count) = weigh(&p, 0);
        out.push(Item { at: known.map(|o| o.at).or_else(|| stamp_ms(&entry)), from: known.map(|o| o.from.clone()), entry, name, kind, size, count });
    }
    out.sort_by(|a, b| b.at.unwrap_or(0).cmp(&a.at.unwrap_or(0)).then_with(|| a.entry.cmp(&b.entry)));
    out
}

/// Put one entry back where it came from (a kept copy, which came from
/// nowhere, lands in the vault's root). `from` instead of `entry` means the
/// newest entry that came from that path - what Ctrl+Z asks for.
#[cfg(test)]
pub fn restore(root: &Path, entry: Option<&str>, from: Option<&str>) -> Result<(String, String), String> {
    restore_where(root, entry, from).map(|(got, kind, _)| (got, kind))
}
/// The same, also saying where it came from: a folder put back under another name ("Private 2") keeps its AI access.
pub fn restore_where(root: &Path, entry: Option<&str>, from: Option<&str>) -> Result<(String, String, String), String> {
    let mut ix = load(root);
    let entry = match (entry, from) {
        (Some(e), _) => e.to_string(),
        (None, Some(f)) => ix
            .iter()
            .filter(|(e, o)| o.from == f && root.join(".trash").join(e).symlink_metadata().is_ok())
            .max_by_key(|(_, o)| o.at)
            .map(|(e, _)| e.clone())
            .ok_or_else(|| format!("{} is not in the trash any more", f))?,
        _ => return Err("nothing to restore".into()),
    };
    let item = list(root).into_iter().find(|i| i.entry == entry).ok_or_else(|| format!("not in the trash: {}", entry))?;
    let rel = item.from.clone().unwrap_or_else(|| item.name.clone());
    let got = vault::untrash(root, &entry, &rel, kind_of(&item.kind))?;
    ix.remove(&entry);
    save(root, &ix);
    Ok((got, item.kind, rel))
}

/// Let entries go for good. Returns how many went.
pub fn remove(root: &Path, entries: &[String]) -> Result<usize, String> {
    let mut ix = load(root);
    let mut n = 0;
    // each one on its own: one that cannot go (read-only, held open) does not keep the rest; the index is saved once
    let mut first_err = None;
    for e in entries {
        let r = vault::trash_path(root, e).and_then(|p| {
            let r = if p.symlink_metadata().map(|m| m.is_dir()).unwrap_or(false) { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
            r.map_err(|err| format!("delete {}: {}", e, err))
        });
        match r {
            Ok(()) => { ix.remove(e); n += 1; }
            Err(err) => { first_err.get_or_insert(err); }
        }
    }
    save(root, &ix);
    match first_err { Some(err) if n == 0 => Err(err), _ => Ok(n) }
}

/// Entries older than `days` go; 0 keeps everything. One whose age cannot be
/// told stays. `since` is when this clean-up first came to the vault: nothing
/// counts as older than that, so a trash that had been filling for a year
/// gets the full time once more and is not emptied on the first start.
pub fn sweep(root: &Path, days: u32, now: i64, since: i64) -> usize {
    if days == 0 {
        return 0;
    }
    let old: Vec<String> = list(root).into_iter().filter(|i| i.at.is_some_and(|at| now - at.max(since) > days as i64 * DAY_MS)).map(|i| i.entry).collect();
    if old.is_empty() {
        // index lines whose entry was taken out by hand are dropped along the way
        let mut ix = load(root);
        let before = ix.len();
        ix.retain(|e, _| root.join(".trash").join(e).symlink_metadata().is_ok());
        if ix.len() != before {
            save(root, &ix);
        }
        return 0;
    }
    // past an entry that cannot go (read-only, held open): it no longer keeps every older one in the trash for ever
    remove(root, &old).unwrap_or(0)
}

/* ── commands ───────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn trash_list(state: State<'_, AppState>) -> Result<Vec<Item>, String> {
    // no trash yet is an empty one; a trash that cannot be read must not look empty
    match std::fs::read_dir(state.paths.vault.join(".trash")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    Ok(list(&state.paths.vault))
}

/// The watcher reports what came back, like any file that appears.
#[tauri::command]
pub async fn trash_restore(entry: Option<String>, from: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let _io = lock(&state.io);
    let (path, kind, was) = restore_where(&state.paths.vault, entry.as_deref(), from.as_deref())?;
    if kind == "folder" && path != was { crate::proposals::copy_folder(&state.paths.dir, &was, &path)?; }
    Ok(json!({ "path": path, "kind": kind }))
}

#[tauri::command]
pub async fn trash_remove(entries: Vec<String>, state: State<'_, AppState>) -> Result<usize, String> {
    let _io = lock(&state.io);
    remove(&state.paths.vault, &entries)
}

#[tauri::command]
pub async fn trash_sweep(days: u32, since: Option<i64>, state: State<'_, AppState>) -> Result<usize, String> {
    let _io = lock(&state.io);
    Ok(sweep(&state.paths.vault, days, now_ms(), since.unwrap_or(0)))
}

/// Show the .trash folder - or, with `bin`, the Windows Recycle Bin - in the
/// file manager.
#[tauri::command]
pub async fn trash_open(bin: Option<bool>, state: State<'_, AppState>) -> Result<(), String> {
    if bin.unwrap_or(false) {
        #[cfg(windows)]
        {
            return std::process::Command::new(crate::external::program("explorer.exe")).arg("shell:RecycleBinFolder").spawn().map(|_| ()).map_err(|e| e.to_string());
        }
        #[cfg(not(windows))]
        {
            return Err("the Recycle Bin is only wired up on Windows".into());
        }
    }
    let dir = state.paths.vault.join(".trash");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .trash: {}", e))?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}
