//! Where Leonote's OWN data lives: the task log, the snapshot, habits,
//! recurring, priorities, stats and positions.
//!
//! Three modes, stored as `dataDir` in app.json:
//!
//!   "user"          today's layout - ~/.leonote/... plus the ~/.leonote_*.json
//!                   files the Python app also reads. The default, and the only
//!                   mode that keeps that app working.
//!   "vault"         <vault>/LeoNote/ - plain folder, so Obsidian shows it.
//!   "vault-hidden"  <vault>/.leonote/ - the scanner already skips dot dirs.
//!
//! app.json itself NEVER moves: it is the bootstrap that says where the rest
//! lives, so it stays at ~/.leonote/app.json in every mode.
//!
//! In the vault modes the files drop the leading dot and the "leonote_"
//! prefix: inside a folder named Leonote they would only be noise, and a
//! dot-file inside a vault is invisible to the user we just made it visible
//! for.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub const USER: &str = "user";
pub const VAULT: &str = "vault";
pub const VAULT_HIDDEN: &str = "vault-hidden";

/// The resolved location of every piece of our data, for one mode.
pub struct Items {
    /// Log root: holds `log/` and `base.snapshot.json`.
    pub dir: PathBuf,
    pub snapshot: PathBuf,
    pub habits: PathBuf,
    pub recurring: PathBuf,
    pub priorities: PathBuf,
    pub stats: PathBuf,
    pub positions: PathBuf,
    /// graph view: node positions, pins and comment frames
    pub graph: PathBuf,
    /// the workout, food and fasting log
    pub fit: PathBuf,
    /// the vault itself: its own settings files travel in a backup with or without its notes
    pub vault: PathBuf,
}

/// Unknown values fall back to "user" rather than failing: a settings file
/// from a newer build must never leave the app unable to find its tasks.
pub fn parse_mode(s: &str) -> Option<&'static str> {
    match s {
        USER => Some(USER),
        VAULT => Some(VAULT),
        VAULT_HIDDEN => Some(VAULT_HIDDEN),
        _ => None,
    }
}

pub fn mode_of(settings: &Value) -> &'static str {
    settings
        .get("dataDir")
        .and_then(|v| v.as_str())
        .and_then(parse_mode)
        .unwrap_or(USER)
}

/// A vault mode is only offered once there is a vault to put the data in.
/// Creating one here would scatter a Leonote folder into whatever path a
/// half-filled settings field happened to hold.
pub fn check_target(mode: &str, vault: &Path) -> Result<(), String> {
    if mode == USER {
        return Ok(());
    }
    if vault.as_os_str().is_empty() {
        return Err("pick a vault folder first".into());
    }
    if !vault.is_dir() {
        return Err(format!("vault folder does not exist: {}", vault.display()));
    }
    Ok(())
}

pub fn data_root(mode: &str, user_dir: &Path, vault: &Path) -> PathBuf {
    match mode {
        VAULT => vault.join("LeoNote"),
        VAULT_HIDDEN => vault.join(".leonote"),
        _ => user_dir.to_path_buf(),
    }
}

/// `user_snapshot` is passed in rather than derived, so LEONOTE_TASKS keeps
/// pointing a trial run at a copy of the live task file.
pub fn items(mode: &str, home: &Path, user_dir: &Path, user_snapshot: &Path, vault: &Path) -> Items {
    if mode == VAULT || mode == VAULT_HIDDEN {
        let r = data_root(mode, user_dir, vault);
        return Items {
            snapshot: r.join("tasks.json"),
            habits: r.join("habits.json"),
            recurring: r.join("recurring.json"),
            priorities: r.join("priorities.json"),
            stats: r.join("stats.json"),
            positions: r.join("positions.json"),
            graph: r.join("graph.json"),
            fit: r.join("fit.json"),
            dir: r,
            vault: vault.to_path_buf(),
        };
    }
    Items {
        dir: user_dir.to_path_buf(),
        snapshot: user_snapshot.to_path_buf(),
        habits: home.join(".leonote_habits.json"),
        recurring: home.join(".leonote_recurring.json"),
        priorities: home.join(".leonote_priorities.json"),
        stats: user_dir.join("stats.json"),
        positions: user_dir.join("positions.json"),
        graph: user_dir.join("graph.json"),
        fit: user_dir.join("fit.json"),
        vault: vault.to_path_buf(),
    }
}

/// Every file that has to travel, oldest-to-newest in importance order. The
/// log dir moves separately, first.
fn files(it: &Items) -> Vec<&PathBuf> {
    vec![
        &it.snapshot,
        &it.habits,
        &it.recurring,
        &it.priorities,
        &it.stats,
        &it.positions,
        &it.graph,
        &it.fit,
    ]
}

/// The Python-import baseline. Not in the mode's public list, but it sits in
/// the log root and a stale one would make the next import diff against the
/// wrong state, so it travels with the logs.
fn base(it: &Items) -> PathBuf {
    it.dir.join("base.snapshot.json")
}

fn is_non_empty(p: &Path) -> bool {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(true),
        Ok(m) => m.len() > 0,
        Err(_) => false,
    }
}

/// Clear the destination for an incoming move. An empty leftover is just
/// deleted; anything with content is renamed to `<name>.bak` so a wrong
/// button press is never a data loss.
fn clear_dest(dest: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(dest).is_err() {
        return Ok(());
    }
    if !is_non_empty(dest) {
        let _ = std::fs::remove_file(dest);
        let _ = std::fs::remove_dir_all(dest);
        return Ok(());
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let parent = dest.parent().ok_or_else(|| format!("no parent for {}", dest.display()))?;
    let mut bak = parent.join(format!("{}.bak", name));
    let mut n = 2;
    while std::fs::symlink_metadata(&bak).is_ok() {
        bak = parent.join(format!("{}.bak.{}", name, n));
        n += 1;
    }
    std::fs::rename(dest, &bak).map_err(|e| format!("set aside {}: {}", dest.display(), e))
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let m = std::fs::symlink_metadata(from)?;
    if !m.is_dir() {
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(from, to)?;
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        copy_tree(&e.path(), &to.join(e.file_name()))?;
    }
    Ok(())
}

/// Move one file or directory. rename first (instant, atomic), copy+delete as
/// the fallback: a vault on another drive makes rename fail with EXDEV.
pub fn move_item(from: &Path, to: &Path) -> Result<(), String> {
    if from == to || std::fs::symlink_metadata(from).is_err() {
        return Ok(());
    }
    clear_dest(to)?;
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("create {}: {}", p.display(), e))?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_tree(from, to).map_err(|e| format!("copy {} -> {}: {}", from.display(), to.display(), e))?;
    // The copy is the data now; a failed cleanup is untidy, not lossy.
    if std::fs::symlink_metadata(from).map(|m| m.is_dir()).unwrap_or(false) {
        let _ = std::fs::remove_dir_all(from);
    } else {
        let _ = std::fs::remove_file(from);
    }
    Ok(())
}

/// Move a folder into one that may be there already, entry by entry: a root an older build moved away from still
/// holds kept versions and proposals of its own. Only a file of the same name is set aside.
fn merge_item(from: &Path, to: &Path) -> Result<(), String> {
    if !(from.is_dir() && to.is_dir()) {
        return move_item(from, to);
    }
    for e in std::fs::read_dir(from).map_err(|e| format!("read {}: {}", from.display(), e))?.flatten() {
        merge_item(&e.path(), &to.join(e.file_name()))?;
    }
    let _ = std::fs::remove_dir(from); // only when nothing is left in it
    Ok(())
}

/// The same for rules and memos kept by name: what is in use wins, what only the other root knows stays
/// (a folder marked private there is still private).
fn merge_json(from: &Path, to: &Path) -> Result<(), String> {
    let read = |p: &Path| std::fs::read(p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(Value::is_object);
    let (Some(new), Some(mut kept)) = (read(from), read(to)) else { return move_item(from, to) };
    for (k, v) in new.as_object().into_iter().flatten() {
        match (kept.get_mut(k).and_then(Value::as_object_mut), v.as_object()) {
            (Some(m), Some(o)) => m.extend(o.clone()),
            _ => kept[k.as_str()] = v.clone(),
        }
    }
    crate::vault::write_atomic(to, kept.to_string().as_bytes()).map_err(|e| format!("write {}: {}", to.display(), e))?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// Move everything from one mode's layout to another's. Logs first: they are
/// the source of truth, and a snapshot without them is merely stale.
pub fn migrate(old: &Items, new: &Items) -> Result<(), String> {
    std::fs::create_dir_all(&new.dir).map_err(|e| format!("create {}: {}", new.dir.display(), e))?;
    // a copy of the task snapshot goes into the new root's history before
    // anything moves: whatever else happens to the move, the tasks as they
    // were are one file away (history entries are kept like compaction's)
    if old.snapshot.is_file() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let keep = new.dir.join("history").join(format!("before-move-{}", stamp));
        if std::fs::create_dir_all(&keep).is_ok() {
            let _ = std::fs::copy(&old.snapshot, keep.join("tasks.json"));
            for (f, name) in [(&old.habits, "habits.json"), (&old.recurring, "recurring.json"), (&old.priorities, "priorities.json")] {
                if f.is_file() { let _ = std::fs::copy(f, keep.join(name)); }
            }
        }
    }
    if old.dir != new.dir {
        move_item(&old.dir.join("log"), &new.dir.join("log"))?;
        move_item(&base(old), &base(new))?;
        // what else the root holds: waiting proposals, lines nobody could parse, the memo of what was imported from Claude Code
        merge_item(&old.dir.join("proposals"), &new.dir.join("proposals"))?;
        move_item(&old.dir.join("quarantine.jsonl"), &new.dir.join("quarantine.jsonl"))?;
        merge_json(&old.dir.join("claude-import.json"), &new.dir.join("claude-import.json"))?;
    }
    for (o, n) in files(old).into_iter().zip(files(new)) {
        move_item(o, n)?;
    }
    // history last and entry by entry: new.dir/history already holds the copy made above, and history/settings
    // belongs to app.json, which stays. Old copies not moving (a full disk) must not stop the move: they stay where they are.
    if old.dir != new.dir {
        let hist = old.dir.join("history");
        for e in std::fs::read_dir(&hist).into_iter().flatten().flatten() {
            if e.file_name() != "settings" { let _ = merge_item(&e.path(), &new.dir.join("history").join(e.file_name())); }
        }
        let _ = std::fs::remove_dir(&hist); // only when nothing is left in it
        // the AI access rules last: a running agent server reads them from the old root until app.json says otherwise
        merge_json(&old.dir.join("ai-access.json"), &new.dir.join("ai-access.json"))?;
    }
    Ok(())
}
