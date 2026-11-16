//! "This PC": finding a file by NAME anywhere in your own folders, the way
//! Everything does. Contents are never read - only names, and only under the
//! roots listed below.
//!
//! Speed comes from an index, not from walking on every keystroke. A
//! background thread walks the roots once per session into a flat
//! `Vec<Entry>` (each entry points at its parent, so a path is stored once
//! per folder rather than once per file), and every query is a linear pass
//! over that vector. The walk is bounded three ways - entries, depth and a
//! total time budget - and cancellable, so a mistaken root on a network drive
//! can never hang the app.
//!
//! Entries are appended in batches while the walk runs, so a search started
//! a moment after the app opened still answers, just from a smaller index;
//! the `pc:index` event tells the UI to ask again as more arrives.
//!
//! Every path here is an absolute OS path, like external.rs and library.rs.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

use crate::{lock, AppState};

/// Hard ceilings. 300k names is a big personal tree (a full Documents +
/// Downloads + code checkouts) and costs ~30 MB; past that the index stops
/// and says so rather than growing without end.
pub const MAX_ENTRIES: usize = 300_000;
/// Deeper than this is a build tree or a sync loop, not somebody's files.
pub const MAX_DEPTH: usize = 16;
/// The cold walk's whole budget. Past it the index is whatever was reached.
pub const MAX_BUILD_MS: u128 = 15_000;
/// With a whole drive among the roots (asked for in Settings): the walk is
/// breadth-first, so when a ceiling is met it is the deepest folders that miss out.
pub const MAX_ENTRIES_WIDE: usize = 1_200_000;
pub const MAX_BUILD_MS_WIDE: u128 = 120_000;
/// One query never blocks the UI for longer than this, however odd the index.
const QUERY_BUDGET_MS: u128 = 150;
/// How often the walk publishes what it has (entries, and at most this often).
const BATCH: usize = 2_048;
const EVENT_MS: u128 = 120;
/// A search against an index older than this quietly starts a rebuild.
pub const STALE_MS: u64 = 5 * 60 * 1_000;

const NO_PARENT: u32 = u32::MAX;
const SEP: char = if cfg!(windows) { '\\' } else { '/' };

/* ── the index ──────────────────────────────────────────────────────────── */

/// One file or folder. `name` is the last segment except on a root, where it
/// is the whole path; `lower` is kept only when lowercasing actually changes
/// something, which for most ASCII filenames it does not.
pub struct Entry {
    name: Box<str>,
    lower: Option<Box<str>>,
    parent: u32,
    is_dir: bool,
    size: u64,
    mtime: u64,
}

impl Entry {
    fn lower(&self) -> &str {
        self.lower.as_deref().unwrap_or(&self.name)
    }
}

/// Read-only views, for the tests that drive `walk` with no index behind it.
#[cfg(test)]
impl Entry {
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn is_dir(&self) -> bool {
        self.is_dir
    }
    pub fn size(&self) -> u64 {
        self.size
    }
}

fn entry(name: String, parent: u32, is_dir: bool, size: u64, mtime: u64) -> Entry {
    let low = name.to_lowercase();
    Entry {
        lower: if low == name { None } else { Some(low.into_boxed_str()) },
        name: name.into_boxed_str(),
        parent,
        is_dir,
        size,
        mtime,
    }
}

pub struct Index {
    entries: Vec<Entry>,
    roots: Vec<String>,
    /// Which build these entries belong to; a newer build discards them.
    gen: u64,
    building: bool,
    done: bool,
    capped: bool,
    build_ms: u64,
    /// Local time in ms when the walk finished, for the staleness check.
    built_at: u64,
    /// Directories read, purely so the progress line means something.
    dirs: u64,
    /// Every stored name's bytes, counted as they arrive - the report runs on
    /// each progress tick, and walking 300k strings to answer it would not.
    str_bytes: u64,
}

impl Index {
    const fn new() -> Index {
        Index {
            entries: Vec::new(),
            roots: Vec::new(),
            gen: 0,
            building: false,
            done: false,
            capped: false,
            build_ms: 0,
            built_at: 0,
            dirs: 0,
            str_bytes: 0,
        }
    }

    fn status(&self) -> &'static str {
        if self.building {
            "building"
        } else if self.done {
            "ready"
        } else if self.entries.is_empty() {
            "idle"
        } else {
            "stopped"
        }
    }

    /// Roughly what the index costs in RAM: the structs plus every string.
    fn bytes(&self) -> u64 {
        self.entries.capacity() as u64 * std::mem::size_of::<Entry>() as u64 + self.str_bytes
    }

    fn state(&self) -> Value {
        json!({
            "status": self.status(),
            "entries": self.entries.len(),
            "dirs": self.dirs,
            "roots": self.roots,
            "ms": self.build_ms,
            "bytes": self.bytes(),
            "capped": self.capped,
            "done": self.done,
            "builtAt": self.built_at,
        })
    }
}

static INDEX: Mutex<Index> = Mutex::new(Index::new());
/// Bumped for every build; a walk whose generation is stale stops itself.
static GEN: AtomicU64 = AtomicU64::new(0);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ── roots (pure, tested) ───────────────────────────────────────────────── */

/// The folders a person keeps their own things in. Not the whole disk: a home
/// tree is what "my files" means, and it is what stays fast.
pub const HOME_ROOTS: &[&str] = &["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"];

/// Every root we would like, in order, before checking what is really there.
pub fn candidate_roots(home: &Path, vault: &Path, extra: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = HOME_ROOTS.iter().map(|n| home.join(n)).collect();
    out.push(home.join("OneDrive"));
    out.push(vault.to_path_buf());
    for e in extra {
        let t = e.trim();
        if !t.is_empty() {
            out.push(PathBuf::from(t));
        }
    }
    out
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// Is `a` the same folder as `b`, or inside it?
pub fn is_within(a: &Path, b: &Path) -> bool {
    let (a, b) = (norm(a), norm(b));
    a == b || (a.len() > b.len() && a.starts_with(&b) && a.as_bytes()[b.len()] == b'\\')
}

/// Keep the roots that exist, drop duplicates, and drop any root already
/// inside another - walking a folder twice doubles the index for nothing.
/// `exists` is a parameter so the rule can be tested without a disk.
pub fn dedupe_roots(list: Vec<PathBuf>, exists: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut keep: Vec<PathBuf> = Vec::new();
    for p in list {
        if !exists(&p) || keep.iter().any(|k| is_within(&p, k)) {
            continue;
        }
        keep.retain(|k| !is_within(k, &p)); // the wider root wins
        keep.push(p);
    }
    keep
}

/// A folder on another computer is walked only after a looking-only yes (looking logs Windows in there);
/// drives, outposts, Player libraries and the vault pass without a question; a search root on another computer is asked
/// about (looking only) each run.
fn asked_roots(app: &AppHandle, roots: Vec<String>) -> Vec<String> {
    // judged exactly as it will be used: trimmed first (" \\host\share" must not pass as a local path and then be trimmed)
    roots.iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty())
        .filter(|r| crate::grant::allow_far_look(app, Path::new(r), "search the file names in this folder on another computer (looking only)").is_ok()).collect()
}

pub fn resolve_roots(home: &Path, vault: &Path, extra: &[String]) -> Vec<PathBuf> {
    dedupe_roots(candidate_roots(home, vault, extra), &|p| p.is_dir())
}

/* ── skip rules (pure, tested) ──────────────────────────────────────────── */

/// Folders that are never somebody's own documents: caches, package stores,
/// the recycle bin, Windows itself. `appdata` is here too - but the test only
/// ever runs on a folder found DURING a walk, so a root pointed explicitly
/// inside AppData is still indexed.
pub const SKIP_DIRS: &[&str] = &[
    "appdata",
    "node_modules",
    "$recycle.bin",
    "system volume information",
    "__pycache__",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
];

pub fn skip_dir(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || b[0] == b'.' || b[0] == b'$' {
        return true; // dot folders and every $-prefixed system store
    }
    let low = name.to_ascii_lowercase();
    SKIP_DIRS.contains(&low.as_str())
}

/// Hidden, system, and reparse points (junctions, OneDrive placeholders that
/// point elsewhere, `Documents\My Music` loops). Following those is how a
/// walker ends up going round in circles.
#[cfg(windows)]
pub fn skip_meta(md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    const REPARSE: u32 = 0x400;
    md.file_attributes() & (HIDDEN | SYSTEM | REPARSE) != 0
}
#[cfg(not(windows))]
pub fn skip_meta(_md: &std::fs::Metadata) -> bool {
    false
}

/* ── scoring (a faithful port of search.js `fuzzy`) ─────────────────────── */

fn boundary(c: char) -> bool {
    c.is_whitespace() || c == '/' || c == '_' || c == '-' || c == '.'
}

/// Does `t` contain every character of `q`, in order? The same question the
/// scorer answers, but without the arithmetic - it throws out the 99% of
/// names that cannot match before any of the expensive work starts.
pub fn is_subsequence(q: &str, t: &str) -> bool {
    let mut it = t.chars();
    'outer: for c in q.chars() {
        if c == ' ' {
            continue;
        }
        for d in it.by_ref() {
            if d == c {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

/// `q` and `t` must already be lowercase. Same rewards as the vault's
/// switcher: a substring beats any scattered match, word starts and runs of
/// adjacent characters score, and a shorter name wins a tie.
pub fn fuzzy_score(q: &str, t: &str) -> Option<f64> {
    if q.is_empty() {
        return Some(0.0);
    }
    let tlen = t.chars().count() as f64;
    if let Some(at) = t.find(q) {
        let before = &t[..at];
        let ci = before.chars().count() as f64;
        let at_word = at == 0 || before.chars().next_back().is_some_and(boundary);
        return Some(
            1000.0 - ci * 2.0 + if at_word { 200.0 } else { 0.0 } + if at == 0 { 150.0 } else { 0.0 } - tlen * 0.5,
        );
    }
    let tc: Vec<char> = t.chars().collect();
    let mut score = 0.0f64;
    let mut ti = 0usize;
    let mut run = 0.0f64;
    let mut last: Option<usize> = None;
    for c in q.chars() {
        if c == ' ' {
            continue;
        }
        let mut found: Option<usize> = None;
        for j in ti..tc.len() {
            if tc[j] != c {
                continue;
            }
            if found.is_none() {
                found = Some(j);
            }
            // a word start is always preferred; otherwise give up after a
            // short window so "abc" cannot claw a hit from the far end
            if j == 0 || boundary(tc[j - 1]) {
                found = Some(j);
                break;
            }
            if j - ti > 12 {
                break;
            }
        }
        let f = found?;
        let at_word = f == 0 || boundary(tc[f - 1]);
        run = if f > 0 && last == Some(f - 1) { run + 1.0 } else { 0.0 };
        score += 10.0 + run * 15.0 + if at_word { 25.0 } else { 0.0 } - (f - ti).min(10) as f64;
        last = Some(f);
        ti = f + 1;
    }
    Some(score - tlen * 0.5)
}

/* ── the walk ───────────────────────────────────────────────────────────── */

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How one walk ended. The entries themselves left through `flush`, in
/// batches, so nothing is ever held twice.
pub struct Walk {
    pub total: usize,
    pub dirs: u64,
    pub capped: bool,
    pub cancelled: bool,
}

/// Breadth-first so partial results are the shallow, likely files rather than
/// whatever corner of the tree came first. `stop` is asked once per folder,
/// which is what makes a build cancellable mid-walk.
pub fn walk(roots: &[PathBuf], budget_ms: u128, stop: &dyn Fn() -> bool, mut flush: impl FnMut(&mut Vec<Entry>)) -> Walk {
    let t0 = Instant::now();
    let mut buf: Vec<Entry> = Vec::new();
    let mut total: usize = 0;
    let mut dirs: u64 = 0;
    let mut capped = false;
    let mut cancelled = false;
    let mut queue: VecDeque<(PathBuf, u32, usize)> = VecDeque::new();

    for r in roots {
        let md = std::fs::metadata(r);
        let mtime = md.as_ref().map(mtime_ms).unwrap_or(0);
        buf.push(entry(r.to_string_lossy().into_owned(), NO_PARENT, true, 0, mtime));
        queue.push_back((r.clone(), total as u32, 0));
        total += 1;
    }

    // a whole drive among the roots is a bigger ask, made on purpose: more room
    let max_entries = if roots.iter().any(|r| is_drive_root(r)) { MAX_ENTRIES_WIDE } else { MAX_ENTRIES };
    while let Some((dir, parent, depth)) = queue.pop_front() {
        if stop() {
            cancelled = true;
            break;
        }
        if total >= max_entries {
            capped = true;
            break;
        }
        if t0.elapsed().as_millis() > budget_ms {
            capped = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue }; // unreadable folder: simply not in the index
        dirs += 1;
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = ft.is_dir();
            if is_dir && skip_dir(&name) {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if skip_meta(&md) {
                continue;
            }
            let idx = total as u32;
            buf.push(entry(name, parent, is_dir, if is_dir { 0 } else { md.len() }, mtime_ms(&md)));
            total += 1;
            if is_dir && depth + 1 < MAX_DEPTH {
                queue.push_back((e.path(), idx, depth + 1));
            }
            if total >= max_entries {
                capped = true;
                break;
            }
        }
        if buf.len() >= BATCH {
            flush(&mut buf);
        }
    }
    flush(&mut buf);
    Walk { total, dirs, capped, cancelled }
}

pub fn path_of(entries: &[Entry], i: usize) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut k = i;
    loop {
        let e = &entries[k];
        parts.push(&e.name);
        if e.parent == NO_PARENT {
            break;
        }
        k = e.parent as usize;
    }
    let mut s = String::new();
    for (n, p) in parts.iter().rev().enumerate() {
        if n == 0 {
            s.push_str(p.trim_end_matches(['\\', '/']));
        } else {
            s.push(SEP);
            s.push_str(p);
        }
    }
    s
}

fn spawn_build(app: AppHandle, roots: Vec<PathBuf>) {
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    CANCEL.store(false, Ordering::SeqCst);
    {
        let mut ix = lock(&INDEX);
        ix.entries.clear();
        ix.entries.shrink_to_fit();
        ix.roots = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        ix.gen = gen;
        ix.building = true;
        ix.done = false;
        ix.capped = false;
        ix.dirs = 0;
        ix.str_bytes = 0;
        ix.build_ms = 0;
    }
    std::thread::spawn(move || {
        let t0 = Instant::now();
        let mut last_event = Instant::now();
        let stop = || CANCEL.load(Ordering::SeqCst) || GEN.load(Ordering::SeqCst) != gen;
        let mut publish = |buf: &mut Vec<Entry>| {
            if buf.is_empty() {
                return;
            }
            let added: u64 = buf.iter().map(|e| (e.name.len() + e.lower.as_ref().map_or(0, |l| l.len())) as u64).sum();
            let n = {
                let mut ix = lock(&INDEX);
                if ix.gen != gen {
                    buf.clear();
                    return;
                }
                ix.entries.append(buf);
                ix.str_bytes += added;
                ix.entries.len()
            };
            if last_event.elapsed().as_millis() >= EVENT_MS {
                last_event = Instant::now();
                let _ = app.emit("pc:index", json!({ "status": "building", "entries": n, "ms": t0.elapsed().as_millis() as u64 }));
            }
        };
        let budget = if roots.iter().any(|r| is_drive_root(r)) { MAX_BUILD_MS_WIDE } else { MAX_BUILD_MS };
        let w = walk(&roots, budget, &stop, &mut publish);
        crate::trace(&format!(
            "pc index: {} entries in {} folders, {:?}{}{}",
            w.total, w.dirs, t0.elapsed(),
            if w.capped { ", capped" } else { "" },
            if w.cancelled { ", cancelled" } else { "" }
        ));
        let state = {
            let mut ix = lock(&INDEX);
            if ix.gen != gen {
                return; // a newer build owns the index now
            }
            ix.building = false;
            ix.done = !w.cancelled;
            ix.capped = w.capped;
            ix.dirs = w.dirs;
            ix.build_ms = t0.elapsed().as_millis() as u64;
            ix.built_at = now_ms();
            ix.entries.shrink_to_fit();
            ix.state()
        };
        let _ = app.emit("pc:index", state);
    });
}

/* ── commands ───────────────────────────────────────────────────────────── */

/// Start (or restart) the index. `roots` are the extra folders from Settings;
/// the defaults and the vault are added here. Returns at once - the walk runs
/// on its own thread and reports through the `pc:index` event.
#[tauri::command]
pub async fn pc_index_start(app: AppHandle, state: State<'_, AppState>, roots: Vec<String>, force: bool) -> Result<Value, String> {
    let roots = asked_roots(&app, roots);
    let list = resolve_roots(&state.paths.home, &state.paths.vault, &roots);
    let wanted: Vec<String> = list.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    {
        let ix = lock(&INDEX);
        let stale = ix.built_at > 0 && now_ms().saturating_sub(ix.built_at) > STALE_MS;
        let fresh = ix.building || (ix.done && !stale && ix.roots == wanted);
        if fresh && !force {
            return Ok(ix.state());
        }
    }
    spawn_build(app, list);
    Ok(lock(&INDEX).state())
}

#[tauri::command]
pub async fn pc_index_state() -> Result<Value, String> {
    Ok(lock(&INDEX).state())
}

/// Stop a walk in flight. What was already indexed stays searchable.
#[tauri::command]
pub async fn pc_index_cancel() -> Result<Value, String> {
    CANCEL.store(true, Ordering::SeqCst);
    Ok(lock(&INDEX).state())
}

/// `C:\`, `d:` - a drive itself rather than a folder on it.
pub fn is_drive_root(p: &Path) -> bool {
    let n = norm(p);
    let b = n.as_bytes();
    b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

#[cfg(windows)]
extern "system" {
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
}

/// The fixed disks of this PC. Network and removable drives are left out: a
/// share that is not answering would stall the walk, and a stick comes and goes.
#[tauri::command]
pub async fn pc_drives() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        const DRIVE_FIXED: u32 = 3;
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            if unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_FIXED {
                out.push(root);
            }
        }
        Ok(out)
    }
    #[cfg(not(windows))]
    {
        Ok(vec!["/".to_string()])
    }
}

/// The roots that would be walked right now, for the Settings page.
#[tauri::command]
pub async fn pc_roots(app: AppHandle, state: State<'_, AppState>, roots: Vec<String>) -> Result<Value, String> {
    let roots = asked_roots(&app, roots);
    let home = &state.paths.home;
    let vault = &state.paths.vault;
    Ok(json!({
        "effective": resolve_roots(home, vault, &roots).iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        "defaults": dedupe_roots(candidate_roots(home, vault, &[]), &|p| p.is_dir())
            .iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
    }))
}

/// Names only - nothing here opens a file. Scores every indexed name and
/// returns the best `limit`, newest first within the same score.
#[tauri::command]
pub async fn pc_search(query: String, limit: Option<usize>) -> Result<Value, String> {
    let q = query.trim().to_lowercase();
    let cap = limit.unwrap_or(200).clamp(1, 2_000);
    let ix = lock(&INDEX);
    if q.is_empty() {
        return Ok(json!({ "hits": [], "matched": 0, "scanned": 0, "ms": 0, "partial": false, "index": ix.state() }));
    }
    let t0 = Instant::now();
    let mut hits: Vec<(f64, u64, usize)> = Vec::new();
    let mut scanned = 0usize;
    let mut partial = false;
    for (i, e) in ix.entries.iter().enumerate() {
        if i & 0xFFF == 0 && t0.elapsed().as_millis() > QUERY_BUDGET_MS {
            partial = true;
            break;
        }
        scanned = i + 1;
        let low = e.lower();
        if !is_subsequence(&q, low) {
            continue;
        }
        let Some(s) = fuzzy_score(&q, low) else { continue };
        hits.push((s, e.mtime, i));
    }
    let matched = hits.len();
    hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(b.1.cmp(&a.1)));
    hits.truncate(cap);
    let out: Vec<Value> = hits
        .iter()
        .map(|(score, _, i)| {
            let e = &ix.entries[*i];
            let full = path_of(&ix.entries, *i);
            let dir = if e.parent == NO_PARENT { String::new() } else { path_of(&ix.entries, e.parent as usize) };
            json!({
                "path": full,
                "name": e.name.as_ref(),
                "dir": dir,
                "isDir": e.is_dir,
                "size": e.size,
                "mtime": e.mtime,
                "kind": if e.is_dir { "folder" } else { crate::external::kind_of(&e.name) },
                "canOpen": !e.is_dir && crate::external::can_edit(&e.name),
                "score": score,
            })
        })
        .collect();
    Ok(json!({
        "hits": out,
        "matched": matched,
        "scanned": scanned,
        "ms": t0.elapsed().as_millis() as u64,
        "partial": partial,
        "index": ix.state(),
    }))
}
