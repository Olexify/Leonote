//! Live file watching: what makes an agent's edit appear in the UI instantly.
//!
//! Directories are watched, never single files: every atomic save is a
//! rename-over, and a per-file watch dies with the file it was attached to.
//!
//! Echo suppression differs by kind, on purpose:
//!  * tasks - by result. The fold is pure, so our own append folds to the
//!    state we already hold and the diff is empty. No bookkeeping at all.
//!  * notes / habits - by content hash. There is no fold to compare, so we
//!    remember the hash of what we last wrote, scanned or emitted, and skip an
//!    event whose file still hashes the same. Content, not time: an agent
//!    write that lands 1 ms after ours still differs and still gets through.

use crate::{lock, store, vault, AppState};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Trailing quiet period: under the perception threshold, long enough to
/// coalesce the create/modify/rename burst of one save.
const QUIET: Duration = Duration::from_millis(40);
/// A writer that never goes quiet (an agent flushing 20 files) still gets
/// processed at this cadence.
const MAX_WAIT: Duration = Duration::from_millis(250);

pub fn hash_str(s: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// ── classification (pure) ───────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum Kind {
    /// A `.md` path inside the vault (vault-relative).
    Note(String),
    /// Anything else in the vault - possibly a folder (vault-relative, "" = root).
    VaultOther(String),
    /// A log file; carries the writer (file stem).
    Log(String),
    Snapshot,
    Habits,
    /// An agent's proposed edit, waiting in `<data>/proposals` (written by the MCP process).
    Proposals,
    Ignored,
}

pub struct Targets {
    pub vault: PathBuf,
    pub log_dir: PathBuf,
    pub snapshot: PathBuf,
    pub habits: PathBuf,
    /// Leonote's own data root. In the "vault" data mode it sits inside the
    /// vault, so everything under it that is not a log, the snapshot or habits
    /// (stats, positions, recurring, priorities, base.snapshot.json) has to be
    /// ignored rather than reported as a change to the user's tree.
    pub data_root: PathBuf,
}

/// Components as strings. Strips the `\\?\` verbatim prefix and unifies
/// separators: notify reports paths in the writer's casing and form, and
/// `canonicalize` on Windows adds the prefix, so a plain `==` misfires.
fn comps(p: &Path) -> Vec<String> {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s);
    s.split('/').filter(|c| !c.is_empty()).map(String::from).collect()
}

fn lower(v: &[String]) -> Vec<String> {
    v.iter().map(|s| s.to_lowercase()).collect()
}

/// Case-insensitive: Windows filesystems are, and an agent may write
/// `Docs/plan.md` while we watch `docs`.
pub fn classify(p: &Path, t: &Targets) -> Kind {
    let pc = comps(p);
    let pl = lower(&pc);
    if pl == lower(&comps(&t.habits)) {
        return Kind::Habits;
    }
    if pl == lower(&comps(&t.snapshot)) {
        return Kind::Snapshot;
    }
    // Logs before the vault: a vault configured as the home folder would
    // otherwise swallow ~/.leonote/log (as a dot-prefixed, ignored path).
    let ld = lower(&comps(&t.log_dir));
    if pl.len() == ld.len() + 1 && pl.starts_with(&ld) {
        let name = &pc[pc.len() - 1];
        return match name.to_lowercase().strip_suffix(".jsonl") {
            Some(_) if !name.starts_with('.') => Kind::Log(name[..name.len() - 6].to_string()),
            _ => Kind::Ignored,
        };
    }
    // An agent's proposal: the app hears of it here instead of asking every few seconds
    let pd = lower(&comps(&crate::proposals::proposals_dir(&t.data_root)));
    if pl.len() == pd.len() + 1 && pl.starts_with(&pd) {
        return if pl[pl.len() - 1].ends_with(".json") { Kind::Proposals } else { Kind::Ignored };
    }
    // Our own data root, after the logs (it contains them) and before the
    // vault (in "vault" mode it is inside one).
    let dr = lower(&comps(&t.data_root));
    if !dr.is_empty() && pl.len() >= dr.len() && pl[..dr.len()] == dr[..] {
        return Kind::Ignored;
    }
    let vd = lower(&comps(&t.vault));
    if pl.len() >= vd.len() && pl[..vd.len()] == vd[..] {
        let rest = &pc[vd.len()..];
        // .trash, .git, .obsidian, .leonote, our `.x.tmp` files
        if rest.iter().any(|s| s.starts_with('.')) {
            return Kind::Ignored;
        }
        let rel = rest.join("/");
        // a folder kept out of the index: its changes are not the vault's
        if vault::not_indexed(&rel) { return Kind::Ignored; }
        let note = rest.last().map(|s| vault::is_note(s)).unwrap_or(false);
        return if note { Kind::Note(rel) } else { Kind::VaultOther(rel) };
    }
    Kind::Ignored
}

/// Writer names reach the UI as labels; keep them boring.
fn clean_writer(w: &str) -> Option<String> {
    let ok = !w.is_empty() && w.len() <= 32 && w.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    ok.then(|| w.to_string())
}

// ── echo memory ─────────────────────────────────────────────────────────────

/// What the frontend already knows about each note, by content hash.
#[derive(Default)]
pub struct Echo {
    /// lowercase rel path -> (rel path as last seen, Some(hash) | None = known gone)
    notes: HashMap<String, (String, Option<u64>)>,
    /// lowercase rel path -> hash of the text Leonote itself last loaded or wrote there
    ours: HashMap<String, u64>,
    pub folders: Vec<String>,
    /// The non-note file list the frontend last got (boot, emit, or a
    /// file command's return value).
    pub files: Vec<vault::FileEntry>,
    pub habits: Option<u64>,
}

impl Echo {
    /// Adopt a fresh file listing; true when it differs from the known one.
    pub fn set_files(&mut self, files: Vec<vault::FileEntry>) -> bool {
        if files == self.files {
            return false;
        }
        self.files = files;
        true
    }

    pub fn reset_notes(&mut self, notes: &[vault::Note]) {
        self.notes.clear();
        for n in notes {
            self.note_seen(&n.path, &n.content);
            self.note_ours(&n.path, &n.content);
        }
    }

    pub fn note_seen(&mut self, rel: &str, content: &str) {
        self.notes.insert(rel.to_lowercase(), (rel.to_string(), Some(hash_str(content))));
    }

    pub fn note_ours(&mut self, rel: &str, content: &str) {
        self.ours.insert(rel.to_lowercase(), hash_str(content));
    }

    /// This text on disk did not come from Leonote: someone else wrote it, seen by the watcher or not.
    pub fn from_outside(&self, rel: &str, disk: &str) -> bool {
        self.ours.get(&rel.to_lowercase()).is_some_and(|h| *h != hash_str(disk))
    }

    /// This text on disk has not been told to the page yet (the watcher has not got to it): a save now replaces words
    /// nobody here saw - unlike from_outside, which also holds for an outside change the page has long shown.
    pub fn unseen(&self, rel: &str, disk: &str) -> bool {
        self.notes.get(&rel.to_lowercase()).and_then(|(_, h)| *h).is_some_and(|h| h != hash_str(disk))
    }

    pub fn note_gone(&mut self, rel: &str) {
        self.ours.remove(&rel.to_lowercase());
        self.notes.insert(rel.to_lowercase(), (rel.to_string(), None));
    }

    /// Record the observed state; true when the frontend has not seen it yet.
    pub fn note_changed(&mut self, rel: &str, content: Option<&str>) -> bool {
        let key = rel.to_lowercase();
        let h = content.map(hash_str);
        match self.notes.get(&key) {
            Some((_, known)) if *known == h => false,
            // never known and already gone: nothing to tell anyone
            None if h.is_none() => false,
            _ => {
                self.notes.insert(key, (rel.to_string(), h));
                true
            }
        }
    }

    pub fn move_note(&mut self, from: &str, to: &str) {
        let known = self.notes.get(&from.to_lowercase()).and_then(|(_, h)| *h);
        let ours = self.ours.get(&from.to_lowercase()).copied();
        self.note_gone(from);
        if let Some(h) = ours {
            self.ours.insert(to.to_lowercase(), h);
        }
        if let Some(h) = known {
            self.notes.insert(to.to_lowercase(), (to.to_string(), Some(h)));
        }
    }

    fn under(&self, rel_dir: &str) -> Vec<String> {
        let prefix = if rel_dir.is_empty() { String::new() } else { format!("{}/", rel_dir.to_lowercase()) };
        self.notes
            .iter()
            .filter(|(k, (_, h))| h.is_some() && k.starts_with(&prefix))
            .map(|(_, (rel, _))| rel.clone())
            .collect()
    }

    /// Mark every known note under a folder gone; returns their paths.
    pub fn prefix_gone(&mut self, rel_dir: &str) -> Vec<String> {
        let gone = self.under(rel_dir);
        for r in &gone {
            self.note_gone(r);
        }
        gone
    }

    /// Our own folder rename: the notes moved, the frontend already knows.
    pub fn move_prefix(&mut self, from: &str, to: &str) {
        for old in self.under(from) {
            let new = format!("{}{}", to, &old[from.len()..]);
            self.move_note(&old, &new);
        }
    }
}

// ── the watcher thread ──────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct NoteChange {
    pub path: String,
    /// null when the file no longer exists
    pub content: Option<String>,
    pub mtime: u64,
}

/// What one batch's vault events mean for notes, folders and files.
pub struct VaultEffects {
    pub changes: Vec<NoteChange>,
    pub folders_dirty: bool,
    pub files_dirty: bool,
}

/// Note changes, plus whether the folder and file lists need a fresh walk.
/// Touches the filesystem (is it a folder now? what came with it?) but needs
/// no AppHandle, so tests drive it against a temp vault. However many files a
/// batch touched, the caller walks and emits at most once.
pub fn vault_effects(
    root: &Path,
    skip: Option<&Path>,
    mut others: BTreeSet<String>,
    note_rels: &BTreeSet<String>,
    echo: &mut Echo,
    rescan: bool,
) -> VaultEffects {
    let mut fx = VaultEffects { changes: Vec::new(), folders_dirty: rescan, files_dirty: rescan };
    if rescan {
        others.insert(String::new());
    }
    let known_folders: HashSet<String> = echo.folders.iter().map(|f| f.to_lowercase()).collect();
    for rel in &others {
        let abs = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
        let is_dir = abs.is_dir();
        let known = rel.is_empty() || known_folders.contains(&rel.to_lowercase());
        if is_dir != known {
            // a folder came or went, and took whatever files were inside
            fx.folders_dirty = true;
            fx.files_dirty = true;
        } else if !is_dir {
            // not a folder before or now: a non-note file was created,
            // changed, renamed or removed. A known folder that is still a
            // folder is only the parent-modified noise of a save inside it.
            fx.files_dirty = true;
        }
        if is_dir && (!known || rescan) {
            // A folder we did not know: created, or moved in / renamed by
            // someone else. Windows reports only the folder, not the notes
            // that came with it, so look inside. Known folders are skipped:
            // every save in `Docs/` also reports `Docs` as modified.
            let found = vault::scan_under(root, rel, skip);
            let present: HashSet<String> = found.iter().map(|n| n.path.to_lowercase()).collect();
            for n in found {
                if echo.note_changed(&n.path, Some(&n.content)) {
                    fx.changes.push(NoteChange { path: n.path, content: Some(n.content), mtime: n.mtime });
                }
            }
            for gone in echo.under(rel) {
                if !present.contains(&gone.to_lowercase()) && !vault::note_held(root, &gone) && echo.note_changed(&gone, None) {
                    fx.changes.push(NoteChange { path: gone, content: None, mtime: 0 });
                }
            }
        } else if !is_dir && known && !rel.is_empty() {
            // folder deleted or renamed away
            for gone in echo.prefix_gone(rel) {
                fx.changes.push(NoteChange { path: gone, content: None, mtime: 0 });
            }
        }
    }
    for rel in note_rels {
        // listed as a file, being too big for a note: gone, or cut down to a note, it leaves that list
        if !fx.files_dirty && echo.files.iter().any(|f| f.path == *rel) { fx.files_dirty = true; } // once found, not looked for again
        match vault::read_note(root, rel) {
            Some(n) => {
                if echo.note_changed(rel, Some(&n.content)) {
                    fx.changes.push(NoteChange { path: n.path, content: Some(n.content), mtime: n.mtime });
                }
            }
            None if root.join(rel).is_dir() => {
                // a folder named x.md
                fx.folders_dirty = true;
                fx.files_dirty = true;
            }
            // could not be read just now: it is not gone, and its next event brings the text
            None if vault::note_held(root, rel) => {}
            None => {
                if echo.note_changed(rel, None) {
                    fx.changes.push(NoteChange { path: rel.clone(), content: None, mtime: 0 });
                }
                // there, but too big to be a note: the tree lists it as a file
                if root.join(rel).is_file() { fx.files_dirty = true; }
            }
        }
    }
    fx
}

pub fn start(app: AppHandle) -> notify::Result<notify::RecommendedWatcher> {
    let st = app.state::<AppState>();
    let p = &st.paths;
    let targets = Targets {
        vault: p.vault.clone(),
        log_dir: store::log_dir_in(&p.dir),
        snapshot: p.snapshot.clone(),
        habits: p.habits.clone(),
        data_root: p.dir.clone(),
    };
    let (tx, rx) = channel();
    let mut w = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })?;
    w.watch(&targets.vault, RecursiveMode::Recursive)?;
    if let Err(e) = w.watch(&targets.log_dir, RecursiveMode::NonRecursive) {
        eprintln!("watch {}: {}", targets.log_dir.display(), e);
    }
    let pdir = crate::proposals::proposals_dir(&targets.data_root);
    let _ = std::fs::create_dir_all(&pdir);
    if let Err(e) = w.watch(&pdir, RecursiveMode::NonRecursive) {
        eprintln!("watch {}: {}", pdir.display(), e);
    }
    let mut parents = HashSet::new();
    for f in [&targets.snapshot, &targets.habits] {
        if let Some(d) = f.parent() {
            if parents.insert(d.to_path_buf()) {
                if let Err(e) = w.watch(d, RecursiveMode::NonRecursive) {
                    eprintln!("watch {}: {}", d.display(), e);
                }
            }
        }
    }
    std::thread::Builder::new()
        .name("leonote-watch".into())
        .spawn(move || run(app, targets, rx))
        .map_err(|e| notify::Error::generic(&e.to_string()))?;
    Ok(w)
}

#[derive(Default)]
struct Batch {
    paths: HashSet<PathBuf>,
    rescan: bool,
}

impl Batch {
    fn add(&mut self, res: notify::Result<notify::Event>) {
        match res {
            Ok(ev) => {
                // ReadDirectoryChangesW buffer overflow: events were dropped
                if ev.need_rescan() {
                    self.rescan = true;
                }
                self.paths.extend(ev.paths);
            }
            Err(e) => {
                eprintln!("watch error: {}", e);
                self.rescan = true;
            }
        }
    }
}

fn run(app: AppHandle, t: Targets, rx: Receiver<notify::Result<notify::Event>>) {
    // Ends when the watcher is dropped (app exit): the sender goes with it.
    while let Ok(first) = rx.recv() {
        let mut batch = Batch::default();
        batch.add(first);
        let start = Instant::now();
        loop {
            let left = MAX_WAIT.saturating_sub(start.elapsed());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(QUIET.min(left)) {
                Ok(ev) => batch.add(ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        process(&app, &t, batch);
    }
}

fn process(app: &AppHandle, t: &Targets, batch: Batch) {
    // the home folder is watched for the task and habit files only: another program writing beside them (a shell's
    // history, an app's settings) comes to nothing here, without walking the vault's folders for it
    if !batch.rescan && batch.paths.iter().all(|p| matches!(classify(p, t), Kind::Ignored)) { return; }
    let st = app.state::<AppState>();
    let mut note_rels: BTreeSet<String> = BTreeSet::new();
    let mut others: BTreeSet<String> = BTreeSet::new();
    let mut writers: BTreeSet<String> = BTreeSet::new();
    let (mut tasks_dirty, mut habits_dirty) = (batch.rescan, batch.rescan);
    let mut proposals_dirty = batch.rescan;

    for p in &batch.paths {
        match classify(p, t) {
            Kind::Note(rel) => {
                note_rels.insert(rel);
            }
            Kind::VaultOther(rel) => {
                others.insert(rel);
            }
            Kind::Log(w) => {
                tasks_dirty = true;
                if let Some(w) = clean_writer(&w) {
                    writers.insert(w);
                }
            }
            Kind::Snapshot => tasks_dirty = true,
            Kind::Habits => habits_dirty = true,
            Kind::Proposals => proposals_dirty = true,
            Kind::Ignored => {}
        }
    }

    // ── notes, folders and files
    let fx = vault_effects(&t.vault, Some(&t.data_root), others, &note_rels, &mut lock(&st.echo), batch.rescan);
    let changes = fx.changes;
    if fx.folders_dirty || fx.files_dirty {
        // one light walk per batch, however many files it touched; with the lock let go, so a save does not wait for the
        // disk. A folder made during the walk may miss this list: its own event is still to come and walks again.
        let tree = vault::tree(&t.vault, Some(&t.data_root));
        let mut echo = lock(&st.echo);
        if tree.folders != echo.folders {
            echo.folders = tree.folders;
            let _ = app.emit("vault:folders", &echo.folders);
        }
        if echo.set_files(tree.files) {
            crate::trace(&format!("watch: vault:files ({} files)", echo.files.len()));
            let _ = app.emit("vault:files", &echo.files);
        }
    }
    if !changes.is_empty() {
        crate::trace(&format!("watch: vault:changed {:?}", changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>()));
        let _ = app.emit("vault:changed", changes);
    }

    // ── tasks: fold and diff under the task mutex; our own writes diff empty
    if tasks_dirty {
        let mut g = lock(&st.tasks);
        let f = store::fold_in(&st.paths.dir, &st.paths.snapshot);
        if let Some(c) = &f.conflicted {
            eprintln!("tasks: conflict markers in {}, not folding", c);
        } else if let Some(why) = &f.snapshot_bad {
            eprintln!("tasks: the task file is {} - keeping what is in memory", why);
        } else {
            let patch = store::diff(&g.tasks, &f.tasks);
            if !patch.is_empty() {
                g.tasks = f.tasks;
                crate::trace(&format!("watch: tasks:patch {} task(s) by {:?}", patch.len(), writers));
                // emitted under the lock so patches reach the UI in fold order
                let _ = app.emit("tasks:patch", serde_json::json!({ "patch": patch, "writers": writers }));
            }
        }
    }

    if proposals_dirty {
        let _ = app.emit("proposals:changed", ());
    }

    // ── habits (Python rewrites this non-atomically: a torn read just fails
    //    to parse, and the write's own next event brings the whole file)
    if habits_dirty {
        let parsed = std::fs::read_to_string(&t.habits)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        if let Some(v) = parsed {
            let h = hash_str(&v.to_string());
            let mut echo = lock(&st.echo);
            if echo.habits != Some(h) {
                echo.habits = Some(h);
                drop(echo);
                let _ = app.emit("habits:changed", v);
            }
        }
    }
}

#[cfg(test)]
mod unseen_tests {
    use super::*;
    #[test]
    fn only_words_the_page_was_not_shown_count() {
        let mut e = Echo::default();
        e.note_seen("a.md", "mine");
        assert!(!e.unseen("a.md", "mine"));
        // an agent wrote, the watcher has not told the page yet
        assert!(e.unseen("a.md", "agent's"));
        // the watcher told it: no longer news, though still not Leonote's own text
        e.note_changed("a.md", Some("agent's"));
        assert!(!e.unseen("a.md", "agent's"));
        assert!(!e.unseen("new.md", "x"), "a note never seen is not news");
    }
}
