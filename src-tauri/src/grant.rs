//! Paths outside the vault that the user handed to Leonote themselves - opened with Leonote (Explorer, the command
//! line), picked in a Windows open or save dialog, a folder linked as an outpost - and so may be written, renamed,
//! moved or run. Anything else the page asks to change outside the vault is asked about first, in a Windows dialog
//! the page cannot answer: a script that slipped into the page cannot write a program into Startup or rewrite a
//! script file on its own, while ordinary use never sees the question.
//!
//! The list lives in ~/.leonote/granted.json, written only from here; the page has no command that writes there.

#[cfg(mobile)]
use crate::mobile::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static GRANTED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// A folder entry ends with this: everything under it is granted.
const DIR: &str = "\\*";
const MAX: usize = 5000;

fn file() -> PathBuf { crate::store::leonote_dir().join("granted.json") }

/// Absolute, as opening it will read it. GetFullPathNameW takes \??\ for a folder on this drive; opening a file takes
/// it as the prefix it is.
fn full(p: &Path) -> PathBuf {
    if p.as_os_str().as_encoded_bytes().starts_with(br"\??\") { return p.to_path_buf(); }
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// A drive path may be looked at. Any other spelling can reach a server (\\host\share, \\?\UNC\, \\.\UNC\,
/// \\?\GLOBALROOT\Device\Mup\, \??\UNC\): looking at it would log in there before anyone was asked. Judged as Windows
/// will read it: Rust finds no prefix in //host//share or \??\, and Windows opens both.
/// May reach another computer when looked at (the opposite of may_look_at): ask before is_file() or exists().
pub fn is_far(p: &Path) -> bool { !may_look_at(p) }
fn may_look_at(p: &Path) -> bool {
    use std::path::{Component, Prefix};
    match full(p).components().next() {
        Some(Component::Prefix(x)) => matches!(x.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)),
        Some(Component::RootDir) => !cfg!(windows),
        _ => true,
    }
}

/// One spelling per place: absolute, backslashes, no trailing separator, links resolved as far as the path exists,
/// any case (Windows paths are not case-sensitive).
fn norm(p: &Path) -> String {
    // "." and ".." resolved first, as Windows itself will (GetFullPathNameW): a granted folder followed by
    // "missing....elsewhere" must not pass for a place inside it
    let p = full(p);
    // the part that exists, resolved (a junction is where it leads); the rest as written
    let mut have = p.clone();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    // a path that may reach a server is taken as written
    let look = may_look_at(&p);
    while look && !have.exists() { match (have.file_name(), have.parent()) { (Some(n), Some(up)) => { rest.push(n.to_owned()); have = up.to_path_buf(); } _ => break } }
    let mut real = if look { std::fs::canonicalize(&have).unwrap_or(have) } else { have };
    for r in rest.iter().rev() { real.push(r); }
    let s = real.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix(r"\\?\UNC\").map(|u| format!(r"\\{u}")).unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
    s.trim_end_matches('\\').to_lowercase()
}

fn with<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut g = GRANTED.lock().unwrap_or_else(|e| e.into_inner());
    let set = g.get_or_insert_with(|| std::fs::read(file()).ok().and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok()).unwrap_or_default().into_iter().collect());
    f(set)
}
fn save(set: &HashSet<String>) {
    // tests keep the list in memory: never the user's own file
    if cfg!(test) { return; }
    let mut v: Vec<&String> = set.iter().collect();
    v.sort();
    let v: Vec<&String> = v.into_iter().take(MAX).collect();
    let _ = crate::vault::write_atomic(&file(), &serde_json::to_vec(&v).unwrap_or_default());
}

/// A file the user handed over.
pub fn grant(p: &Path) { let k = norm(p); with(|s| if s.insert(k) { save(s) }); }
/// A folder the user handed over: everything in it.
pub fn grant_dir(p: &Path) { let k = norm(p) + DIR; with(|s| if s.insert(k) { save(s) }); }

/// Handed over: the path itself, or a folder it is in.
pub fn granted(p: &Path) -> bool {
    let k = norm(p);
    with(|s| s.contains(&k) || s.iter().any(|g| g.strip_suffix(DIR).is_some_and(|d| in_folder(&k, d))))
}
fn in_folder(k: &str, d: &str) -> bool { k == d || k.starts_with(&format!("{d}\\")) }

/// Network folders on this computer's own lists (app.json: outposts, Player libraries, the vault; a vault's file
/// cannot add to them). Leonote goes there anyway, and older ones were linked before grants: a file in one opens
/// without a question. Looking only: changing it still needs a grant.
static LISTED: Mutex<Vec<String>> = Mutex::new(Vec::new());
pub fn list_far_folders(settings: &serde_json::Value, vault: &Path) {
    // the vault itself too: it is this computer's own choice, and Disk space starts there. Not the search roots: one
    // on another computer got only a looking-only yes, which must not become trust for opening its files; This PC
    // search asks about it again (looking only) each run
    let all = crate::outpost::saved_paths(settings).into_iter().chain(crate::library::saved_paths(settings)).chain(std::iter::once(vault.to_string_lossy().into_owned()));
    let mut l = LISTED.lock().unwrap_or_else(|e| e.into_inner());
    l.extend(all.filter(|d| !may_look_at(Path::new(d))).map(|d| norm(Path::new(&d))).filter(|k| !k.is_empty()));
}
fn asks_nothing(p: &Path) -> bool {
    may_look_at(p) || granted(p) || { let k = norm(p); LISTED.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|d| in_folder(&k, d)) }
}

/// A remembered file on another computer that nobody handed over is not brought back at start: the window waits for
/// that step, and a vault's list could hold hundreds. Opening it again asks.
pub fn drop_unasked_guests(settings: &mut serde_json::Value) {
    if let Some(g) = settings.get_mut("guestFiles").and_then(|g| g.as_object_mut()) {
        g.retain(|_, abs| abs.as_str().is_some_and(|p| asks_nothing(Path::new(p))));
    }
}

/// May the page do `what` to `p`? Yes when the user handed it over; else Windows asks the user, and a yes is kept.
/// `dir`: what is granted on a yes is the folder, everything in it.
pub fn allow(app: &tauri::AppHandle, p: &Path, what: &str, dir: bool) -> Result<(), String> {
    if granted(p) { return Ok(()); }
    asked(app, p, what)?;
    if dir { grant_dir(p) } else { grant(p) }
    Ok(())
}
fn asked(app: &tauri::AppHandle, p: &Path, what: &str) -> Result<(), String> {
    // the place as Windows will read it ("." and ".." resolved), not the page's spelling of it
    if ask(app, "Leonote is asking", &format!("Leonote wants to {what}:\n\n{}\n\nAllow it? Say no if you did not just ask Leonote for this.", full(p).display())) {
        Ok(())
    } else {
        Err(format!("Not allowed: {}", p.display()))
    }
}

/// A path that may reach a server is asked about before anything looks at it: looking logs in there, and a
/// vault's tabs and remembered files can name any path. A drive path passes unasked, nothing kept.
pub fn allow_far(app: &tauri::AppHandle, p: &Path) -> Result<(), String> {
    if asks_nothing(p) { Ok(()) } else { allow(app, p, "open this file from another computer (and save changes to it)", false) }
}
/// The same question for one look only: a yes is not kept, so it lets no later save or rename through.
pub fn allow_far_once(app: &tauri::AppHandle, p: &Path, what: &str) -> Result<(), String> {
    if asks_nothing(p) { Ok(()) } else { asked(app, p, what) }
}

/// For looking only, at a folder and what is in it (sizes, an archive's list): a yes is kept for this run so going
/// deeper does not ask again, but it is never a grant - no save, rename or delete gets through on it.
/// (place, with what is inside it)
static LOOKED: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());
pub fn allow_far_look(app: &tauri::AppHandle, p: &Path, what: &str) -> Result<(), String> {
    if asks_nothing(p) { return Ok(()); }
    let k = norm(p);
    if LOOKED.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|(d, deep)| if *deep { in_folder(&k, d) } else { &k == d }) { return Ok(()); }
    asked(app, p, what)?;
    if !k.is_empty() { LOOKED.lock().unwrap_or_else(|e| e.into_inner()).push((k.clone(), share_or_deeper(&k))); }
    Ok(())
}
/// Only a plain \\host\share (or a folder in it) covers what is inside it: a yes to a namespace root
/// (\\?\GLOBALROOT\..., \\.\..., \??\...) or to a host alone stays a yes to that exact place.
fn share_or_deeper(k: &str) -> bool {
    let Some(rest) = k.strip_prefix(r"\\") else { return false };
    let mut parts = rest.split('\\');
    match (parts.next(), parts.next()) {
        (Some(host), Some(share)) => !host.is_empty() && !share.is_empty() && host != "." && !host.starts_with('?'),
        _ => false,
    }
}
#[cfg(test)]
#[test]
fn only_a_real_share_covers_what_is_inside_it() {
    assert!(share_or_deeper(r"\\nas\notes"));
    assert!(share_or_deeper(r"\\nas\notes\2026"));
    assert!(!share_or_deeper(r"\\nas"));
    assert!(!share_or_deeper(r"\\?\GLOBALROOT\Device\Mup"));
    assert!(!share_or_deeper(r"\\.\UNC\nas\notes"));
    assert!(!share_or_deeper(r"\??\UNC\nas\notes"));
    assert!(!share_or_deeper(r"C:\x"));
}

/// May Leonote run this program (a command line)? Once per program, asked the first time.
pub fn allow_program(app: &tauri::AppHandle, command: &str, what: &str) -> Result<(), String> {
    let key = format!("program:{}", command.trim().to_lowercase());
    if with(|s| s.contains(&key)) { return Ok(()); }
    if ask(app, "Leonote is asking", &format!("Leonote wants to run this program {what}:\n\n{}\n\nAllow it, now and later? Say no if you did not set this up yourself.", one_line(command))) {
        with(|s| { s.insert(key); save(s) });
        Ok(())
    } else {
        Err("Not allowed: that program was not run".into())
    }
}

/// A command as it will be split to run: on one line, so nothing can be pushed out of the dialog's view.
fn one_line(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ").chars().filter(|c| !c.is_control()).collect()
}

/// May git work in this repository, which names programs of its own? Once per folder and setup: a hook or
/// setting added later asks again.
// ponytail: a hook's name, not its contents, is in the key; hash the hook files too if an edited hook should ask
pub fn allow_git_repo(app: &tauri::AppHandle, root: &Path, named: &[String]) -> Result<(), String> {
    let mut sorted = named.to_vec();
    sorted.sort();
    let key = format!("gitrepo:{}:{}", norm(root), crate::proposals::hash(&sorted.join("\n")));
    if with(|s| s.contains(&key)) { return Ok(()); }
    let mut list: Vec<String> = named.iter().take(8).map(|n| n.chars().filter(|c| !c.is_control()).take(120).collect()).collect();
    if named.len() > 8 { list.push(format!("and {} more", named.len() - 8)); }
    if ask(app, "Leonote is asking", &format!("This git repository has a setup of its own, and git could run programs because of it:\n\n{}\n\n{}\n\nAllow git to work in this folder, now and later? Say no if you did not set this repository up yourself or do not trust where it came from.", root.display(), list.join("\n"))) {
        with(|s| { s.insert(key); save(s) });
        Ok(())
    } else {
        Err("Not allowed: git did not run, nothing was changed".into())
    }
}

#[cfg(not(test))]
pub(crate) fn ask(app: &tauri::AppHandle, title: &str, text: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut d = app.dialog().message(text).title(title).kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Don't allow".into()));
    if let Some(w) = tauri::Manager::get_webview_window(app, "main") { d = d.parent(&w); }
    d.blocking_show()
}
#[cfg(test)]
pub(crate) fn ask(_: &tauri::AppHandle, _: &str, _: &str) -> bool { false }

/* ── the dialogs the page opens, through here: what the user picks is theirs ── */

/// The open dialog (one file, several, or a folder), as the page's `dialog.open` options say; what is picked is granted.
#[tauri::command]
pub async fn pick_open(app: tauri::AppHandle, opts: serde_json::Value) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file();
        if let Some(t) = opts["title"].as_str() { b = b.set_title(t); }
        if let Some(d) = opts["defaultPath"].as_str() { b = start_at(b, d); }
        // Android's picker knows files by kind, not by ending: a filter for an ending of our own would grey every file out
        #[cfg(not(target_os = "android"))]
        for f in opts["filters"].as_array().into_iter().flatten() {
            let exts: Vec<String> = f["extensions"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(String::from)).collect();
            let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
            b = b.add_filter(f["name"].as_str().unwrap_or(""), &refs);
        }
        let dir = opts["directory"].as_bool().unwrap_or(false);
        let many = opts["multiple"].as_bool().unwrap_or(false);
        let paths: Vec<PathBuf> = match (dir, many) {
            (true, false) => b.blocking_pick_folder().into_iter().collect(),
            (true, true) => b.blocking_pick_folders().unwrap_or_default(),
            (false, false) => b.blocking_pick_file().into_iter().collect(),
            (false, true) => b.blocking_pick_files().unwrap_or_default(),
        }.into_iter().enumerate().filter_map(|(i, f)| local(&app, f, i)).collect();
        for p in &paths { if dir { grant_dir(p) } else { grant(p) } }
        let s: Vec<serde_json::Value> = paths.iter().map(|p| serde_json::Value::String(p.to_string_lossy().into_owned())).collect();
        Ok(if many { serde_json::Value::Array(s) } else { s.into_iter().next().unwrap_or(serde_json::Value::Null) })
    }).await.map_err(|e| e.to_string())?
}

/// The save dialog; the place picked is granted.
#[tauri::command]
pub async fn pick_save(app: tauri::AppHandle, opts: serde_json::Value) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file();
        if let Some(t) = opts["title"].as_str() { b = b.set_title(t); }
        if let Some(d) = opts["defaultPath"].as_str() { b = start_at(b, d); }
        // Android's picker knows files by kind, not by ending: a filter for an ending of our own would grey every file out
        #[cfg(not(target_os = "android"))]
        for f in opts["filters"].as_array().into_iter().flatten() {
            let exts: Vec<String> = f["extensions"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(String::from)).collect();
            let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
            b = b.add_filter(f["name"].as_str().unwrap_or(""), &refs);
        }
        let p = b.blocking_save_file().and_then(|f| save_place(&app, f, opts["defaultPath"].as_str().unwrap_or("file")));
        if let Some(p) = &p { grant(p); }
        Ok(p.map(|p| p.to_string_lossy().into_owned()))
    }).await.map_err(|e| e.to_string())?
}

/// A picked file as a path. A computer gives one; Android gives a content link, so the file is copied into the app's
/// own cache first and that copy's path is given (the copies of the pick before are cleared).
#[cfg(not(target_os = "android"))]
fn local(_: &tauri::AppHandle, f: tauri_plugin_dialog::FilePath, _: usize) -> Option<PathBuf> { f.into_path().ok() }
#[cfg(target_os = "android")]
fn local(app: &tauri::AppHandle, f: tauri_plugin_dialog::FilePath, i: usize) -> Option<PathBuf> {
    use tauri::Manager;
    use tauri_plugin_fs::{FsExt, OpenOptions};
    let url = match f { tauri_plugin_dialog::FilePath::Path(p) => return Some(p), url => url };
    let dir = app.path().cache_dir().ok()?.join("picked");
    // ponytail: one pick's copies at a time - a second pick while the first is still being read would pull it away; a folder per pick if that ever happens
    if i == 0 { let _ = std::fs::remove_dir_all(&dir); }
    std::fs::create_dir_all(&dir).ok()?;
    let to = dir.join(format!("picked-{}", i));
    let mut o = OpenOptions::new();
    o.read(true);
    let mut src = app.fs().open(url, o).ok()?;
    let mut out = std::fs::File::create(&to).ok()?;
    std::io::copy(&mut src, &mut out).ok()?;
    Some(to)
}

/// Where a save goes. A computer: the path picked. Android: a file in the app's own cache, which `pick_save_done`
/// copies to the place picked once it is written.
#[cfg(not(target_os = "android"))]
fn save_place(_: &tauri::AppHandle, f: tauri_plugin_dialog::FilePath, _: &str) -> Option<PathBuf> { f.into_path().ok() }
#[cfg(target_os = "android")]
static SAVING: Mutex<Vec<(PathBuf, tauri_plugin_dialog::FilePath)>> = Mutex::new(Vec::new());
#[cfg(target_os = "android")]
fn save_place(app: &tauri::AppHandle, f: tauri_plugin_dialog::FilePath, name: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let url = match f { tauri_plugin_dialog::FilePath::Path(p) => return Some(p), url => url };
    let dir = app.path().cache_dir().ok()?.join("saving");
    std::fs::create_dir_all(&dir).ok()?;
    let name: String = Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let tmp = dir.join(name);
    let mut l = SAVING.lock().unwrap_or_else(|e| e.into_inner());
    l.retain(|(p, _)| p != &tmp);
    l.push((tmp.clone(), url));
    Some(tmp)
}

/// The page wrote the file a save dialog gave it. A computer has nothing more to do; on Android the file goes from the
/// app's cache to the place picked, and an error here means it did not arrive.
#[tauri::command]
pub async fn pick_save_done(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_fs::{FsExt, OpenOptions};
        let tmp = PathBuf::from(&path);
        let url = { let mut l = SAVING.lock().unwrap_or_else(|e| e.into_inner()); l.iter().position(|(p, _)| p == &tmp).map(|i| l.remove(i).1) };
        let Some(url) = url else { return Ok(()) };
        return tauri::async_runtime::spawn_blocking(move || {
            let mut o = OpenOptions::new();
            o.write(true).truncate(true).create(true);
            let mut out = app.fs().open(url, o).map_err(|e| format!("could not write to the place picked: {}", e))?;
            let mut src = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut out).map_err(|e| format!("could not write to the place picked: {}", e))?;
            let _ = std::fs::remove_file(&tmp);
            Ok(())
        }).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, path); Ok(()) }
}

/// A dialog's starting place: a folder opens there; a file's path opens its folder with its name filled in.
fn start_at<R: tauri::Runtime>(b: tauri_plugin_dialog::FileDialogBuilder<R>, d: &str) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    let p = Path::new(d);
    if p.is_dir() { return b.set_directory(p); }
    let b = match p.parent().filter(|x| x.is_dir()) { Some(up) => b.set_directory(up), None => b };
    match p.file_name() { Some(n) => b.set_file_name(n.to_string_lossy()), None => b }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_command_is_shown_on_one_line() {
        assert_eq!(one_line("claude\n\n\n   --dangerously-skip-permissions\t-p\u{7}"), "claude --dangerously-skip-permissions -p");
    }
    #[test]
    fn what_was_handed_over_is_granted_and_nothing_else() {
        let d = std::env::temp_dir().join(format!("leo-grant-{}", std::process::id()));
        std::fs::create_dir_all(d.join("Linked/Deep")).unwrap();
        std::fs::write(d.join("opened.txt"), "x").unwrap();
        grant(&d.join("opened.txt"));
        grant_dir(&d.join("Linked"));
        assert!(granted(&d.join("opened.txt")) && granted(&d.join("OPENED.TXT")), "any case");
        assert!(granted(&d.join("Linked/Deep/new.md")), "inside a granted folder, even a file not made yet");
        assert!(!granted(&d.join("other.txt")) && !granted(&d.join("LinkedX/a.md")) && !granted(&d), "nothing beside them");
        // out of a granted folder through ".." parts that do not exist: judged where it really lands
        assert!(!granted(&d.join("Linked").join("missing").join("..").join("..").join("other.txt")));
        assert!(!granted(&d.join("Linked").join("..").join("other.txt")));
        assert!(granted(&d.join("Linked").join("Deep").join("..").join("x.md")), "still inside");
        // a network path is judged as written: nothing goes to that server before the question
        grant_dir(Path::new(r"\\leo-no-such-server\drop"));
        assert!(granted(Path::new(r"\\LEO-no-such-server\drop\a.zip")) && !granted(Path::new(r"\\leo-no-such-server\other\a.zip")));
        for far in [r"\\host\drop", r"\\?\UNC\host\drop", r"\\.\UNC\host\drop", r"\\?\GLOBALROOT\Device\Mup\host\drop", "//./UNC/host/drop", "//host//drop/a.pdf", r"\??\UNC\host\drop\a.pdf", r"\??\C:\x"] {
            assert!(!may_look_at(Path::new(far)), "{far}");
        }
        assert!(may_look_at(Path::new(r"C:\x")) && may_look_at(Path::new(r"\\?\C:\x")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn at_start_only_a_network_file_someone_handed_over_comes_back() {
        grant(Path::new(r"\\leo-guest-host\s\given.pdf"));
        list_far_folders(&serde_json::json!({"outposts": [{"path": r"\\leo-guest-host\music"}], "pcSearchRoots": ["//leo-guest-host/docs", r"\\", "C:/x"]}), Path::new("C:/vault"));
        let mut s = serde_json::json!({"guestFiles": {
            "local": r"C:\x\a.pdf", "given": r"\\leo-guest-host\s\given.pdf", "linked": r"\\leo-guest-host\music\a.pdf", "searched": r"\\leo-guest-host\docs\a.pdf",
            "planted": r"\\leo-guest-host\s\other.pdf", "spelled": "//leo-guest-host//s/a.pdf", "nt": r"\??\UNC\leo-guest-host\s\a.pdf"
        }});
        drop_unasked_guests(&mut s);
        let mut left: Vec<&String> = s["guestFiles"].as_object().unwrap().keys().collect();
        left.sort();
        assert_eq!(left, ["given", "linked", "local"], "a search root is not trust for opening its files");
    }
}
