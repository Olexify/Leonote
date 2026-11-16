//! What takes the room in a folder (Show sizes…): its own files and folders by size, each folder
//! counted to the bottom, and the largest files anywhere under it. Read only; links and junctions
//! are not followed, so nothing is counted twice and no walk leaves the folder.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const LARGEST: usize = 100;

/// Bytes and files under `dir`, and the biggest files met on the way (kept to LARGEST).
fn walk(dir: &Path, big: &mut Vec<(u64, String)>) -> (u64, u64) {
    // past 300 levels deep (a runaway copy) the walk stops: deeper it would run out of stack and end the app
    if dir.components().count() > 300 { return (0, 0); }
    let (mut bytes, mut files) = (0u64, 0u64);
    let Ok(rd) = std::fs::read_dir(dir) else { return (0, 0) };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            let (b, f) = walk(&e.path(), big);
            bytes += b;
            files += f;
        } else if let Ok(m) = e.metadata() {
            bytes += m.len();
            files += 1;
            keep(big, m.len(), e.path().to_string_lossy().into_owned());
        }
    }
    (bytes, files)
}

fn keep(big: &mut Vec<(u64, String)>, size: u64, path: String) {
    if big.len() < LARGEST || size > big.last().map(|b| b.0).unwrap_or(0) {
        let at = big.partition_point(|b| b.0 >= size);
        big.insert(at, (size, path));
        big.truncate(LARGEST);
    }
}

pub fn sizes(dir: &Path) -> Result<Value, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let mut big = Vec::new();
    let mut children = Vec::new();
    let (mut total, mut count) = (0u64, 0u64);
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path().to_string_lossy().into_owned();
        let (size, files) = if ft.is_dir() {
            walk(&e.path(), &mut big)
        } else {
            let s = e.metadata().map(|m| m.len()).unwrap_or(0);
            keep(&mut big, s, path.clone());
            (s, 1)
        };
        total += size;
        count += files;
        children.push(json!({ "name": name, "path": path, "dir": ft.is_dir(), "size": size, "files": files }));
    }
    children.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    let largest: Vec<Value> = big.into_iter().map(|(s, p)| json!({ "path": p, "size": s })).collect();
    Ok(json!({ "path": dir.to_string_lossy(), "total": total, "files": count, "children": children, "largest": largest }))
}

#[tauri::command]
pub async fn folder_sizes(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    crate::grant::allow_far_look(&app, Path::new(&path), "count what takes the room in this folder on another computer (looking only)")?; // looking logs Windows in there: asked first
    tauri::async_runtime::spawn_blocking(move || sizes(Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn counts_to_the_bottom_and_keeps_the_largest() {
        let d = std::env::temp_dir().join(format!("leonote-sizes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        std::fs::write(d.join("small.txt"), vec![0u8; 10]).unwrap();
        std::fs::write(d.join("a/b/big.bin"), vec![0u8; 5000]).unwrap();
        std::fs::write(d.join("a/mid.bin"), vec![0u8; 300]).unwrap();
        let v = super::sizes(&d).unwrap();
        assert_eq!(v["total"], 5310);
        assert_eq!(v["files"], 3);
        assert_eq!(v["children"][0]["name"], "a");
        assert_eq!(v["children"][0]["size"], 5300);
        assert!(v["largest"][0]["path"].as_str().unwrap().ends_with("big.bin"));
        assert_eq!(v["largest"].as_array().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }
}

/* ── Disk space, gradual: a count runs in the background - its top folders walked eight at a time,
   each block known the moment its folder is done - and every folder's total met on the way is kept,
   so a click into a subfolder afterwards is answered at once, from memory. "Count again" forgets. ── */

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Every folder's (bytes, files) from the counts so far, by its path in lower case.
fn totals() -> &'static Mutex<HashMap<String, (u64, u64)>> {
    static T: OnceLock<Mutex<HashMap<String, (u64, u64)>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}
/// The largest files met in any count (a few thousand), for "Largest files" under any folder.
fn largest_all() -> &'static Mutex<Vec<(u64, String)>> {
    static B: OnceLock<Mutex<Vec<(u64, String)>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(Vec::new()))
}
const LARGEST_KEPT: usize = 3000;
fn key(p: &Path) -> String { p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase() }

/// The largest files anywhere under each folder near the top of a count (its own blocks in the map).
fn tops() -> &'static Mutex<HashMap<String, Vec<(u64, String)>>> {
    static T: OnceLock<Mutex<HashMap<String, Vec<(u64, String)>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}
const TOPN: usize = 80; // files drawn inside a folder's block
const TOP_DEPTH: u32 = 2; // folders this deep under a count keep theirs (deeper ones are counted again when opened)
// folders this deep under a count keep their total: a whole drive's half a million folders would be tens
// of MB held for nothing - a folder deeper than this is counted again (it is small) when it is opened
const KEEP_DEPTH: u32 = 4;

fn keep_n(v: &mut Vec<(u64, String)>, size: u64, path: String, n: usize) {
    if v.len() < n || size > v.last().map(|b| b.0).unwrap_or(0) {
        let at = v.partition_point(|b| b.0 >= size);
        v.insert(at, (size, path));
        v.truncate(n);
    }
}
fn top_json(v: &[(u64, String)]) -> Value { json!(v.iter().map(|(s, p)| json!({ "path": p, "size": s })).collect::<Vec<_>>()) }

/// `walk`, writing every folder's total into `seen` and the near folders' largest files into `near`
/// on the way, and stopping when asked. Gives (bytes, files, the largest files under it).
#[allow(clippy::too_many_arguments)]
fn walk_keep(dir: &Path, depth: u32, big: &mut Vec<(u64, String)>, seen: &mut Vec<(String, u64, u64)>, near: &mut Vec<(String, Vec<(u64, String)>)>, stop: &AtomicBool, bytes_so_far: &AtomicU64) -> (u64, u64, Vec<(u64, String)>) {
    if depth > 300 { return (0, 0, Vec::new()); } // as walk: past this the stack would run out
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut top: Vec<(u64, String)> = Vec::new();
    if stop.load(Ordering::Relaxed) { return (0, 0, top); }
    let Ok(rd) = std::fs::read_dir(dir) else { return (0, 0, top) };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() { continue; }
        if ft.is_dir() {
            let (b, f, sub) = walk_keep(&e.path(), depth + 1, big, seen, near, stop, bytes_so_far);
            bytes += b;
            files += f;
            for (s, p) in sub { keep_n(&mut top, s, p, TOPN); }
        } else if let Ok(m) = e.metadata() {
            bytes += m.len();
            files += 1;
            bytes_so_far.fetch_add(m.len(), Ordering::Relaxed);
            let p = e.path().to_string_lossy().into_owned();
            if m.len() > 1 << 20 { keep(big, m.len(), p.clone()); }
            keep_n(&mut top, m.len(), p, TOPN);
        }
    }
    if depth <= KEEP_DEPTH { seen.push((key(dir), bytes, files)); }
    if depth <= TOP_DEPTH { near.push((key(dir), top.clone())); }
    (bytes, files, top)
}

struct Job {
    path: PathBuf,
    children: Vec<Value>, // { name, path, dir, size, files, done }
    done: bool,
    stop: Arc<AtomicBool>,
    counted: Arc<AtomicU64>,
}
fn jobs() -> &'static Mutex<HashMap<u64, Arc<Mutex<Job>>>> {
    static J: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Job>>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The folder's own entries, each folder's total from memory when it was counted before (None if not).
fn listing(dir: &Path) -> Result<Vec<(String, String, bool, Option<(u64, u64)>)>, String> {
    let t = crate::lock(&totals());
    let tp = crate::lock(&tops());
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() { continue; }
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        let known = if ft.is_dir() { t.get(&key(&path)).copied().filter(|_| tp.contains_key(&key(&path))) } else { e.metadata().ok().map(|m| (m.len(), 1)) };
        out.push((name, path.to_string_lossy().into_owned(), ft.is_dir(), known));
    }
    Ok(out)
}

/// What a count shows: the folder's entries by size, the total so far, the largest files under it.
fn view(path: &Path, children: &[Value], done: bool, counted: u64) -> Value {
    let mut kids = children.to_vec();
    kids.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    let total: u64 = kids.iter().map(|c| c["size"].as_u64().unwrap_or(0)).sum();
    let files: u64 = kids.iter().map(|c| c["files"].as_u64().unwrap_or(0)).sum();
    let pre = key(path);
    let largest: Vec<Value> = crate::lock(&largest_all()).iter()
        .filter(|(_, p)| { let k = p.to_lowercase(); k.starts_with(&pre) && k[pre.len()..].starts_with(['\\', '/']) })
        .take(LARGEST).map(|(s, p)| json!({ "path": p, "size": s })).collect();
    json!({ "path": path.to_string_lossy(), "total": total.max(if done { 0 } else { counted }), "files": files, "children": kids, "largest": largest, "done": done })
}

/// Start counting `path` - or, when every folder in it was counted before and `fresh` is not asked,
/// answer at once from memory: `{ result }` or `{ id }` to ask `sizes_poll` about.
#[tauri::command(async)]
pub fn sizes_start(app: tauri::AppHandle, path: String, fresh: bool) -> Result<Value, String> {
    crate::grant::allow_far_look(&app, Path::new(&path), "count what takes the room in this folder on another computer (looking only)")?;
    start_now(path, fresh)
}
fn start_now(path: String, fresh: bool) -> Result<Value, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() { return Err(format!("{} is not a folder", dir.display())); }
    if fresh {
        let pre = key(&dir);
        let under = |k: &String| k == &pre || k.starts_with(&(pre.clone() + "\\")) || k.starts_with(&(pre.clone() + "/"));
        crate::lock(&totals()).retain(|k, _| !under(k));
        crate::lock(&tops()).retain(|k, _| !under(k));
        crate::lock(&largest_all()).retain(|(_, p)| !p.to_lowercase().starts_with(&pre));
    }
    let list = listing(&dir)?;
    let children: Vec<Value> = { let tp = crate::lock(&tops()); list.iter().map(|(name, p, d, known)| {
        let (size, files) = known.unwrap_or((0, 0));
        let top = if *d { tp.get(&key(Path::new(p))).map(|v| top_json(v)).unwrap_or(json!([])) } else { json!([]) };
        json!({ "name": name, "path": p, "dir": d, "size": size, "files": files, "done": known.is_some(), "top": top })
    }).collect() };
    if children.iter().all(|c| c["done"] == true) {
        return Ok(json!({ "result": view(&dir, &children, true, 0) }));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let counted = Arc::new(AtomicU64::new(0));
    let job = Arc::new(Mutex::new(Job { path: dir.clone(), children, done: false, stop: stop.clone(), counted: counted.clone() }));
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    crate::lock(&jobs()).insert(id, job.clone());
    // the folders still to count, biggest first is not known - so as they come; eight walkers share them
    let todo: Vec<usize> = { let j = crate::lock(&job); j.children.iter().enumerate().filter(|(_, c)| c["done"] != true).map(|(i, _)| i).collect() };
    let queue = Arc::new(Mutex::new(todo));
    std::thread::spawn(move || {
        let n = crate::lock(&queue).len().clamp(1, 8);
        std::thread::scope(|s| {
            for _ in 0..n {
                let (queue, job, stop, counted) = (queue.clone(), job.clone(), stop.clone(), counted.clone());
                s.spawn(move || loop {
                    let Some(i) = crate::lock(&queue).pop() else { break };
                    if stop.load(Ordering::Relaxed) { break; }
                    let p = PathBuf::from(crate::lock(&job).children[i]["path"].as_str().unwrap_or("").to_string());
                    let (mut big, mut seen, mut near) = (Vec::new(), Vec::new(), Vec::new());
                    let (b, f, top) = walk_keep(&p, 1, &mut big, &mut seen, &mut near, &stop, &counted);
                    if stop.load(Ordering::Relaxed) { break; }
                    { let mut t = crate::lock(&totals()); for (k, b, f) in seen { t.insert(k, (b, f)); } }
                    { let mut t = crate::lock(&tops()); for (k, v) in near { t.insert(k, v); } }
                    { let mut all = crate::lock(&largest_all()); for (s, p) in big { if all.len() < LARGEST_KEPT || s > all.last().map(|x| x.0).unwrap_or(0) { let at = all.partition_point(|x| x.0 >= s); all.insert(at, (s, p)); all.truncate(LARGEST_KEPT); } } }
                    let mut j = crate::lock(&job);
                    j.children[i]["size"] = json!(b);
                    j.children[i]["files"] = json!(f);
                    j.children[i]["done"] = json!(true);
                    j.children[i]["top"] = top_json(&top);
                });
            }
        });
        // the files lying in the folder itself count among the largest too
        let mut j = crate::lock(&job);
        if !stop.load(Ordering::Relaxed) {
            let mut all = crate::lock(&largest_all());
            for c in j.children.iter().filter(|c| c["dir"] != true) {
                let (s, p) = (c["size"].as_u64().unwrap_or(0), c["path"].as_str().unwrap_or("").to_string());
                if s > 1 << 20 && !all.iter().any(|x| x.1 == p) { let at = all.partition_point(|x| x.0 >= s); all.insert(at, (s, p)); all.truncate(LARGEST_KEPT); }
            }
            let (tb, tf) = j.children.iter().fold((0u64, 0u64), |a, c| (a.0 + c["size"].as_u64().unwrap_or(0), a.1 + c["files"].as_u64().unwrap_or(0)));
            crate::lock(&totals()).insert(key(&j.path), (tb, tf));
        }
        j.done = true;
    });
    Ok(json!({ "id": id }))
}

/// How far a count has got: what `sizes_start` would answer, with `done` false while it runs.
#[tauri::command]
pub fn sizes_poll(id: u64) -> Result<Value, String> {
    let job = crate::lock(&jobs()).get(&id).cloned().ok_or("That count is over")?;
    let j = crate::lock(&job);
    let v = view(&j.path, &j.children, j.done, j.counted.load(Ordering::Relaxed));
    if j.done { crate::lock(&jobs()).remove(&id); }
    Ok(v)
}

/// Stop a count (another folder was asked for): what it finished stays known.
#[tauri::command]
pub fn sizes_stop(id: u64) {
    if let Some(job) = crate::lock(&jobs()).remove(&id) { crate::lock(&job).stop.store(true, Ordering::Relaxed); }
}

#[cfg(test)]
mod gradual_tests {
    #[test]
    fn counts_then_answers_from_memory() {
        let d = std::env::temp_dir().join(format!("leonote-sizes-g-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        std::fs::create_dir_all(d.join("c")).unwrap();
        std::fs::write(d.join("a/b/big.bin"), vec![0u8; 5000]).unwrap();
        std::fs::write(d.join("c/x.bin"), vec![0u8; 300]).unwrap();
        std::fs::write(d.join("top.txt"), vec![0u8; 10]).unwrap();
        let p = d.to_string_lossy().into_owned();
        let first = super::start_now(p.clone(), true).unwrap();
        let id = first["id"].as_u64().expect("a count to run");
        let mut v;
        loop { v = super::sizes_poll(id).unwrap(); if v["done"] == true { break; } std::thread::sleep(std::time::Duration::from_millis(10)); }
        assert_eq!(v["total"], 5310);
        assert_eq!(v["children"][0]["name"], "a");
        // a folder inside it: known now, answered at once
        let inner = super::start_now(d.join("a").to_string_lossy().into_owned(), false).unwrap();
        assert_eq!(inner["result"]["total"], 5000);
        // the folder's own block holds its largest files, the biggest first
        assert!(v["children"][0]["top"][0]["path"].as_str().unwrap().ends_with("big.bin"));
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// Free and whole space of the drive a folder is on: `{ free, total }` in bytes.
#[tauri::command(async)]
pub fn drive_space(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    crate::grant::allow_far_look(&app, Path::new(&path), "count what takes the room in this folder on another computer (looking only)")?;
    #[cfg(windows)]
    {
        extern "system" { fn GetDiskFreeSpaceExW(dir: *const u16, free_to_caller: *mut u64, total: *mut u64, total_free: *mut u64) -> i32; }
        let w: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let (mut free, mut total, mut all_free) = (0u64, 0u64, 0u64);
        if unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut free, &mut total, &mut all_free) } == 0 { return Err("Windows did not say".into()); }
        Ok(json!({ "free": free, "total": total }))
    }
    #[cfg(not(windows))]
    { let _ = path; Err("not on this system".into()) }
}
