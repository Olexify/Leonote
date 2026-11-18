//! Plugins: folders in ~/.leonote/plugins (plugin.json and its files), never in the vault, so a synced vault cannot
//! plant one. The folders are written only by the install commands here, and a plugin runs only after a yes in a
//! Windows dialog the page cannot answer; that yes lives in allowed.json next to them, not in any settings a vault carries.
//! What a plugin may do is judged in web/plugins.js, which holds its sandboxed frame; net is judged here as well.

#[cfg(mobile)]
use crate::mobile::*;
use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const LIST_URL: &str = "https://raw.githubusercontent.com/Olexify/leonote-plugins/main/plugins.json";
const ISSUES_URL: &str = "https://github.com/Olexify/leonote-plugins/issues/new";
/// A plugin is a script and a few small files.
const MAX_BYTES: u64 = 64 << 20;
const MAX_FILES: usize = 2000;
const MAX_NET: u64 = 2 << 20;

#[derive(Clone, Debug, PartialEq)]
pub struct Manifest { pub id: String, pub name: String, pub version: String, pub author: String, pub description: String, pub main: String, pub permissions: Vec<String> }

/// One row of the public list, checked. `verified` is true only when its mark names this very version and sha256.
#[derive(Clone, Debug)]
pub struct Listed { id: String, name: String, author: String, description: String, repo: String, version: String, zip: String, sha256: String, permissions: Vec<String>, verified: bool, stars: u64 }

/* ── what may be written in a plugin.json or the list ── */

/// Text shown to the user: no control characters, nothing that turns text around or hides it.
fn text(v: &Value, key: &str, max: usize) -> Result<String, String> {
    let s = v[key].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("{key} is missing"))?;
    if s.chars().count() > max { return Err(format!("{key} is too long")); }
    if s.chars().any(|c| c.is_control() || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}')) { return Err(format!("{key} has characters that cannot be shown")); }
    Ok(s.to_string())
}
/// Lower case letters, digits, "-" and "." between them; it is also the folder's name, so never that of the file beside them.
fn valid_id(id: &str) -> bool {
    id != ALLOWED_FILE && !id.is_empty() && id.len() <= 64 && id.split('.').all(|p| !p.is_empty() && !p.starts_with('-') && !p.ends_with('-') && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}
fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() <= 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}
/// A .js file in the plugin's own folder, by a plain relative path.
fn valid_main(m: &str) -> bool {
    m.ends_with(".js") && m.len() <= 200 && m.split('/').all(|p| !p.is_empty() && !p.starts_with('.') && !p.ends_with('.') && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')))
}
/// A name on the internet: not an address, not this computer or the home network, no port, no wildcard.
fn valid_host(h: &str) -> bool {
    let labels: Vec<&str> = h.split('.').collect();
    h.len() <= 253 && labels.len() >= 2 && labels.iter().all(|l| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
        && !labels[labels.len() - 1].bytes().all(|b| b.is_ascii_digit())
        && crate::linkcard::public_host(&format!("https://{h}/"))
}
fn valid_permission(p: &str) -> bool {
    matches!(p, "commands" | "panel" | "notes.read" | "notes.write") || p.strip_prefix("net:").is_some_and(valid_host)
}
fn permissions(v: &Value) -> Result<Vec<String>, String> {
    let list = v["permissions"].as_array().ok_or("permissions is missing")?;
    if list.len() > 32 { return Err("it asks for too many permissions".into()); }
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let p = p.as_str().unwrap_or("");
        if !valid_permission(p) { return Err(format!("it asks for something Leonote does not offer: {}", p.chars().filter(|c| !c.is_control()).take(80).collect::<String>())); }
        if !out.iter().any(|x| x == p) { out.push(p.to_string()); }
    }
    Ok(out)
}

pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| "plugin.json is not valid JSON".to_string())?;
    let id = text(&v, "id", 64)?;
    if !valid_id(&id) { return Err("its id may have only lower case letters, digits, \"-\" and \".\"".into()); }
    let version = text(&v, "version", 40)?;
    if !valid_version(&version) { return Err("its version must be numbers with dots, like 1.0.0".into()); }
    let main = text(&v, "main", 200)?;
    if !valid_main(&main) { return Err("main must be a .js file inside the plugin's folder".into()); }
    Ok(Manifest { id, name: text(&v, "name", 60)?, version, author: text(&v, "author", 60)?, description: text(&v, "description", 300)?, main, permissions: permissions(&v)? })
}

/// A permission in plain words: the dialog, Settings and the search all show these.
pub fn words(p: &str) -> String {
    match p {
        "commands" => "Add commands to the Ctrl+P list".into(),
        "panel" => "Show a side panel. What you type in it, after clicking on it, goes to the plugin".into(),
        "notes.read" => "Read your notes, except private ones, and it may be able to send out what it reads".into(),
        "notes.write" => "Change your notes, except private ones: notes set to Review wait for you to accept, notes set to Open change at once unless the change adds a web address".into(),
        _ => format!("Connect to {} over the internet, and send it anything the plugin can read", p.strip_prefix("net:").unwrap_or(p)),
    }
}
fn all_words(list: &[String]) -> Vec<String> { list.iter().map(|p| words(p)).collect() }

/// Said in every dialog: the frame stops fetch, but the engine still lets it look up names and open connections.
pub const TRUST: &str = "Install only what you trust: a plugin may be able to send out anything it can read, even if it does not ask to connect to the internet.";

/// What the install dialog says. Only a version the list marks verified is spared "Not checked by Leonote".
pub fn consent_text(m: &Manifest, verified: bool, replaces: Option<&str>) -> String {
    let mut out = format!("Install the plugin \"{}\" {} by {}?\n\n{}\n\n", m.name, m.version, m.author, m.description);
    out += if verified { "Verified: this exact version was looked at. That is no guarantee.\n\n" } else { "Not checked by Leonote. Say no if you do not trust where it came from.\n\n" };
    out += &format!("{TRUST}\n\n");
    if m.permissions.is_empty() { out += "It asks for nothing: it cannot read your notes.\n"; }
    else {
        out += "It may:\n";
        for p in &m.permissions { out += &format!("- {}\n", words(p)); }
    }
    if let Some(v) = replaces { out += &format!("\nIt replaces version {v}, which you have now.\n"); }
    out
}
fn more_text(m: &Manifest, more: &[String]) -> String {
    let mut out = format!("The plugin \"{}\" {} by {} now asks for more.\n\nNot checked by Leonote. {TRUST}\n\nNew:\n", m.name, m.version, m.author);
    for p in more { out += &format!("- {}\n", words(p)); }
    out += "\nAll it may do then:\n";
    for p in &m.permissions { out += &format!("- {}\n", words(p)); }
    out
}

/* ── the folder, and the yes for each plugin ── */

/// The plugins' folder, or why there is none: inside the vault a sync could plant a plugin, so plugins stay off.
pub fn base_outside(dir: &Path, vault: &Path) -> Result<PathBuf, String> {
    let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    if !vault.as_os_str().is_empty() && real(dir).starts_with(real(vault)) {
        return Err("Plugins stay off while Leonote's data folder is inside your vault: a synced vault could plant one.".into());
    }
    Ok(dir.join("plugins"))
}
fn base(state: &crate::AppState) -> Result<PathBuf, String> { base_outside(&crate::store::leonote_dir(), &state.paths.vault) }

static ALLOWED: Mutex<()> = Mutex::new(());
const ALLOWED_FILE: &str = "allowed.json";
fn allowed_file(base: &Path) -> PathBuf { base.join(ALLOWED_FILE) }
fn read_allowed(base: &Path) -> Map<String, Value> {
    std::fs::read(allowed_file(base)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn change_allowed<T>(base: &Path, f: impl FnOnce(&mut Map<String, Value>) -> T) -> Result<T, String> {
    let _g = ALLOWED.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read_allowed(base);
    let out = f(&mut all);
    crate::vault::write_atomic(&allowed_file(base), &serde_json::to_vec_pretty(&all).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(out)
}
fn strings(v: &Value) -> Vec<String> { v.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect() }

fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let p = dir.join("plugin.json");
    let md = std::fs::symlink_metadata(&p).map_err(|_| "it has no plugin.json".to_string())?;
    if !md.is_file() || md.len() > 64 << 10 { return Err("its plugin.json cannot be used".into()); }
    parse_manifest(&std::fs::read(&p).map_err(|e| e.to_string())?)
}
fn more_than(m: &Manifest, granted: &[String]) -> Vec<String> { m.permissions.iter().filter(|p| !granted.contains(p)).cloned().collect() }

/// Every folder in the plugins' folder, as Settings shows it. `on` is what may run.
pub fn list(base: &Path) -> Vec<Value> {
    let allowed = read_allowed(base);
    let mut rows: Vec<Value> = Vec::new();
    for e in std::fs::read_dir(base).into_iter().flatten().flatten() {
        // a link is no folder here: what is listed is what the install put here
        if !e.file_type().is_ok_and(|t| t.is_dir()) { continue; }
        let name = e.file_name().to_string_lossy().into_owned();
        // what an install cut short left (a crash, a locked file): swept once it is an hour old, and only while no
        // install runs (a consent dialog left open keeps its folder, and so does the old version set aside)
        if name.starts_with(".incoming-") && INSTALLING.load(std::sync::atomic::Ordering::SeqCst) == 0 && e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_secs() > 3600) {
            let _ = std::fs::remove_dir_all(e.path());
        }
        if name.starts_with('.') { continue; }
        let rec = allowed.get(&name);
        let source = rec.map_or(Value::Null, |r| r["source"].clone());
        rows.push(match read_manifest(&e.path()) {
            Ok(m) if m.id == name => {
                let granted = rec.map_or(Vec::new(), |r| strings(&r["granted"]));
                let more = more_than(&m, &granted);
                let on = rec.is_some_and(|r| r["enabled"] == true) && more.is_empty();
                json!({ "id": m.id, "name": m.name, "version": m.version, "author": m.author, "description": m.description, "permissions": m.permissions, "words": all_words(&m.permissions),
                        "known": rec.is_some(), "on": on, "more": all_words(&more), "source": source })
            }
            Ok(_) => json!({ "id": name, "name": name, "bad": "its folder is not named after its id", "known": rec.is_some(), "on": false, "source": source }),
            Err(bad) => json!({ "id": name, "name": name, "bad": bad, "known": rec.is_some(), "on": false, "source": source }),
        });
    }
    rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    rows
}

/// The plugin if it may run now: installed through here, on, and asking no more than it was given.
pub fn runnable(base: &Path, id: &str) -> Result<Manifest, String> {
    if !valid_id(id) { return Err("no such plugin".into()); }
    let m = read_manifest(&base.join(id))?;
    let all = read_allowed(base);
    let rec = all.get(id).ok_or("that plugin was not installed through Leonote")?;
    if m.id != id || rec["enabled"] != true || !more_than(&m, &strings(&rec["granted"])).is_empty() { return Err("that plugin is off".into()); }
    Ok(m)
}

const CHANGED: &str = "its code was changed outside Leonote since it was installed, so it is off - install it again to use it";

/// A plugin's code as it runs: its main file, read once (no link, not too big) - what is hashed is what runs.
fn read_main(dir: &Path, m: &Manifest) -> Result<String, String> {
    let p = dir.join(&m.main);
    let md = std::fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    if !md.is_file() || md.len() > MAX_BYTES { return Err("its main file cannot be used".into()); }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}
fn code_hash(code: &str) -> String { crate::external::sha256_hex(code.as_bytes()) }

/// The yes was for the code installed then: code changed since (another program, an agent with file access) is
/// turned off, not run. A tripwire, not a wall: whoever can write here can also write allowed.json. One installed
/// before this check takes the code it has now as its own, once. Compared and turned off under the one lock, so an
/// update landing meanwhile is not turned off by a stale comparison.
pub fn code_unchanged(base: &Path, id: &str, code: &str) -> Result<(), String> {
    let h = code_hash(code);
    if read_allowed(base).get(id).is_some_and(|r| r["code"] == h.as_str()) { return Ok(()); }
    change_allowed(base, |all| {
        let Some(r) = all.get_mut(id) else { return Ok(()) };
        match r["code"].as_str() {
            None => { r["code"] = json!(h); Ok(()) }
            Some(c) if c == h => Ok(()),
            Some(_) => { r["enabled"] = json!(false); Err(CHANGED.to_string()) }
        }
    })?
}

/// A temporary folder beside the plugins, so moving it in is a rename; gone when dropped.
struct Incoming(PathBuf);
static INSTALLING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
impl Incoming {
    fn new(base: &Path) -> Result<Self, String> {
        INSTALLING.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let d = base.join(format!(".incoming-{stamp:x}"));
        let me = Self(d); // counted down when dropped, a failure below included
        std::fs::create_dir_all(&me.0).map_err(|e| e.to_string())?;
        Ok(me)
    }
}
impl Drop for Incoming { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); INSTALLING.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); } }

/// The files of a folder, copied. A link in it is refused: it could lead anywhere.
fn copy_tree(from: &Path, to: &Path, files: &mut usize, bytes: &mut u64) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name();
        let low = name.to_string_lossy();
        if low.starts_with('.') || low == "node_modules" { continue; }
        let t = e.file_type().map_err(|e| e.to_string())?;
        if t.is_symlink() { return Err(format!("{low} is a link, which a plugin may not have")); }
        if t.is_dir() { copy_tree(&e.path(), &to.join(&name), files, bytes)?; continue; }
        *files += 1;
        *bytes += e.metadata().map_err(|e| e.to_string())?.len();
        if *files > MAX_FILES || *bytes > MAX_BYTES { return Err("that folder is too big for a plugin (64 MB and 2000 files at most)".into()); }
        std::fs::copy(e.path(), to.join(&name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A zip taken out into `into`: any entry landing outside it or being a link refuses the whole zip, as an archive
/// the app opens does; 64 MB unpacked at most, so a small file cannot fill the disk.
fn unzip(bytes: &[u8], into: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "the download is not a zip".to_string())?;
    if z.len() > MAX_FILES { return Err("that zip is too big for a plugin".into()); }
    let mut written = 0u64;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { return Err("refused: a file in the zip would land outside its folder".into()) };
        if f.is_symlink() { return Err("refused: the zip holds a link".into()); }
        let out = into.join(rel);
        if f.is_dir() { std::fs::create_dir_all(&out).map_err(|e| e.to_string())?; continue; }
        if let Some(p) = out.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        written += std::io::copy(&mut (&mut f).take(MAX_BYTES - written + 1), &mut w).map_err(|e| e.to_string())?;
        if written > MAX_BYTES { return Err("that zip unpacks to more than 64 MB".into()); }
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// plugin.json at the top of the folder, or in the one folder a release zip usually wraps it in.
fn plugin_root(stage: &Path) -> Result<PathBuf, String> {
    if stage.join("plugin.json").is_file() { return Ok(stage.to_path_buf()); }
    let kids: Vec<PathBuf> = std::fs::read_dir(stage).into_iter().flatten().flatten().map(|e| e.path()).collect();
    match kids.as_slice() { [one] if one.join("plugin.json").is_file() => Ok(one.clone()), _ => Err("it has no plugin.json".into()) }
}

/// The checks every install ends with, on the copy just made - what the dialog names is what goes in.
fn finish(base: &Path, stage: &Path, source: Value, listed: Option<&Listed>, yes: impl FnOnce(&str) -> bool) -> Result<Option<String>, String> {
    let root = plugin_root(stage)?;
    let m = read_manifest(&root)?;
    if !root.join(&m.main).is_file() { return Err(format!("its main file {} is missing", m.main)); }
    if let Some(l) = listed {
        if m.id != l.id || m.version != l.version { return Err("the download is not the plugin and version the list names".into()); }
        if !m.permissions.iter().all(|p| l.permissions.contains(p)) { return Err("the download asks for more than the list says".into()); }
    }
    let dest = base.join(&m.id);
    let replaces = read_manifest(&dest).ok().map(|o| o.version);
    let was = read_allowed(base).get(&m.id).cloned().unwrap_or(Value::Null);
    let mut ask = consent_text(&m, listed.is_some_and(|l| l.verified), replaces.as_deref());
    if let Some(l) = listed {
        // a row of the list with the same id does not replace a plugin that came from somewhere else
        let same = was["source"]["kind"] == "github" && was["source"]["repo"].as_str().is_some_and(|r| r.eq_ignore_ascii_case(&l.repo));
        if dest.exists() && !same {
            let from = match was["source"]["repo"].as_str() {
                Some(r) => format!("github.com/{r}"),
                None if was.is_null() => "the plugins folder, put there by hand".into(),
                None => "a folder on this computer".into(),
            };
            return Err(format!("the \"{}\" you have came from {from}, this one from github.com/{}: remove yours first to install it", m.id, l.repo));
        }
        ask += &format!("\nFrom github.com/{}\n", l.repo);
    }
    // an update names what it may do that the version you have may not
    if replaces.is_some() {
        let new = more_than(&m, &strings(&was["granted"]));
        if !new.is_empty() { ask += "\nNew in this version:\n"; for p in &new { ask += &format!("- {}\n", words(p)); } }
    }
    if !yes(&ask) { return Ok(None); }
    let code = code_hash(&read_main(&root, &m)?);
    let old = stage.with_extension("old");
    let had = dest.exists();
    if had { std::fs::rename(&dest, &old).map_err(|e| e.to_string())?; }
    if let Err(e) = std::fs::rename(&root, &dest) {
        if had { let _ = std::fs::rename(&old, &dest); }
        return Err(e.to_string());
    }
    if had { let _ = std::fs::remove_dir_all(&old); }
    // an update leaves a plugin that was off, off; the code's fingerprint (taken before anything moved) is what the yes was for
    let rec = json!({ "granted": m.permissions, "enabled": !had || was["enabled"].as_bool().unwrap_or(true), "source": source, "code": code });
    change_allowed(base, |all| { all.insert(m.id.clone(), rec); })?;
    Ok(Some(m.id))
}

pub fn install_folder(base: &Path, src: &Path, yes: impl FnOnce(&str) -> bool) -> Result<Option<String>, String> {
    let stage = Incoming::new(base)?;
    let (mut files, mut bytes) = (0, 0);
    copy_tree(src, &stage.0, &mut files, &mut bytes)?;
    finish(base, &stage.0, json!({ "kind": "folder", "path": src.to_string_lossy() }), None, yes)
}

/// The bytes the list named, or nothing: the fingerprint is checked before anything is written.
pub fn install_zip(base: &Path, bytes: &[u8], listed: &Listed, yes: impl FnOnce(&str) -> bool) -> Result<Option<String>, String> {
    crate::external::check_sha256(bytes, &listed.sha256)?;
    let stage = Incoming::new(base)?;
    unzip(bytes, &stage.0)?;
    finish(base, &stage.0, json!({ "kind": "github", "repo": listed.repo, "verified": listed.verified }), Some(listed), yes)
}

/// On again; a plugin.json that asks for more than was given asks again. False: the user said no.
pub fn enable(base: &Path, id: &str, yes: impl FnOnce(&str) -> bool) -> Result<bool, String> {
    if !valid_id(id) { return Err("no such plugin".into()); }
    let m = read_manifest(&base.join(id))?;
    if m.id != id { return Err("its folder is not named after its id".into()); }
    let rec = read_allowed(base).get(id).cloned().ok_or("that plugin was not installed through Leonote: remove it, then install it")?;
    let more = more_than(&m, &strings(&rec["granted"]));
    // turned off for changed code: on again would only be turned off again at its start
    if let Some(c) = rec["code"].as_str() { if code_hash(&read_main(&base.join(id), &m)?) != c { return Err(CHANGED.into()); } }
    if !more.is_empty() && !yes(&more_text(&m, &more)) { return Ok(false); }
    change_allowed(base, |all| { all.insert(id.to_string(), json!({ "granted": if more.is_empty() { rec["granted"].clone() } else { json!(m.permissions) }, "enabled": true, "source": rec["source"], "code": rec["code"] })); })?;
    Ok(true)
}
pub fn disable(base: &Path, id: &str) -> Result<(), String> {
    change_allowed(base, |all| { if let Some(r) = all.get_mut(id) { r["enabled"] = json!(false); } })
}
/// A folder of the list by the name it shows: one plain name, so nothing beside the plugins can be named.
pub fn remove(base: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\', ':']) { return Err("no such plugin".into()); }
    // the yes goes first: if a file stays in use, the plugin is off all the same
    change_allowed(base, |all| { all.remove(id); })?;
    match std::fs::remove_dir_all(base.join(id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("It is off, but its folder could not be removed: {e}")),
        _ => Ok(()),
    }
}

/* ── the public list ── */

fn sha_ok(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) }
fn repo_ok(r: &str) -> bool {
    let p: Vec<&str> = r.split('/').collect();
    p.len() == 2 && p.iter().all(|x| !x.is_empty() && *x != "." && *x != ".." && x.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')))
}
/// From that repository's own releases, by https, nowhere else.
fn zip_ok(zip: &str, repo: &str) -> bool {
    tauri::Url::parse(zip).is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("github.com") && u.port().is_none() && u.username().is_empty() && u.path().to_lowercase().starts_with(&format!("/{}/releases/download/", repo.to_lowercase())))
}
fn entry(v: &Value) -> Result<Listed, String> {
    let id = text(v, "id", 64)?;
    let version = text(v, "version", 40)?;
    let repo = text(v, "repo", 140)?;
    let zip = text(v, "zip", 500)?;
    let sha256 = text(v, "sha256", 64)?.to_lowercase();
    if !valid_id(&id) || !valid_version(&version) || !repo_ok(&repo) || !zip_ok(&zip, &repo) || !sha_ok(&sha256) { return Err("bad entry".into()); }
    let verified = v["verified"]["version"].as_str() == Some(&version) && v["verified"]["sha256"].as_str().is_some_and(|s| s.eq_ignore_ascii_case(&sha256));
    Ok(Listed { id, name: text(v, "name", 60)?, author: text(v, "author", 60)?, description: text(v, "description", 300)?, repo, version, zip, sha256, permissions: permissions(v)?, verified, stars: v["stars"].as_u64().unwrap_or(0) })
}
/// The rows that can be used; one bad row costs only itself.
pub fn parse_list(bytes: &[u8]) -> Result<Vec<Listed>, String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| "The plugin list could not be read.".to_string())?;
    Ok(v["plugins"].as_array().ok_or("The plugin list could not be read.")?.iter().filter_map(|e| entry(e).ok()).collect())
}
/// The list's own date (`"updated": "YYYY-MM-DD"`), shown with the stars it gives; anything else is no date.
pub fn list_date(bytes: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let d = v["updated"].as_str()?;
    (d.len() == 10 && d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })).then(|| d.to_string())
}
fn list_row(l: &Listed) -> Value {
    let report = tauri::Url::parse_with_params(ISSUES_URL, &[("title", format!("Report: {} {}", l.id, l.version))]).map(|u| u.to_string()).unwrap_or_default();
    json!({ "id": l.id, "name": l.name, "author": l.author, "description": l.description, "repo": l.repo, "version": l.version, "words": all_words(&l.permissions), "verified": l.verified, "stars": l.stars, "report": report })
}

/* ── net ── */

/// May a plugin given these hosts ask this address? https, the very host, its usual port, no name and password in it.
fn net_allowed(url: &str, hosts: &[String]) -> bool {
    tauri::Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.port().is_none() && u.username().is_empty() && u.password().is_none()
        && u.host_str().is_some_and(|h| hosts.iter().any(|x| x == h)))
}
/// A GET through the guarded fetch (only addresses on the internet, the name looked up again at each connection).
/// Redirects are followed here, one by one: each must also be a listed host, or a listed site could lead anywhere.
fn fetch_listed(url: &str, hosts: &[String]) -> Result<Value, String> {
    let agent = crate::webext::public_builder().redirects(0).https_only(true).build();
    let mut at = url.to_string();
    for _ in 0..6 {
        if !net_allowed(&at, hosts) { return Err("That address is not on the list of hosts this plugin was allowed.".into()); }
        let resp = match agent.get(&at).set("User-Agent", crate::webext::AGENT).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("Could not connect: {e}")),
        };
        let status = resp.status();
        if (300..400).contains(&status) {
            let next = resp.header("location").ok_or("The site gave a redirect with no address.")?;
            at = tauri::Url::parse(&at).and_then(|u| u.join(next)).map_err(|e| e.to_string())?.to_string();
            continue;
        }
        let mut body = Vec::new();
        resp.into_reader().take(MAX_NET).read_to_end(&mut body).map_err(|e| e.to_string())?;
        return Ok(json!({ "status": status, "text": String::from_utf8_lossy(&body) }));
    }
    Err("Too many redirects.".into())
}

/* ── the commands ── */

static LISTED: Mutex<Vec<Listed>> = Mutex::new(Vec::new());

#[tauri::command]
pub async fn plugin_list(state: tauri::State<'_, crate::AppState>) -> Result<Vec<Value>, String> { Ok(list(&base(&state)?)) }

/// Windows' folder dialog, then the install dialog: the page names no path and answers neither.
#[tauri::command]
pub async fn plugin_install_folder(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let base = base(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(src) = app.dialog().file().set_title("Pick the plugin's folder").blocking_pick_folder().and_then(|f| f.into_path().ok()) else { return Ok(None) };
        install_folder(&base, &src, |t| crate::grant::ask(&app, "Install a plugin", t))
    }).await.map_err(|e| e.to_string())?
}

/// The one public file, read when the search is opened; what can be installed is what this returned.
#[tauri::command]
pub async fn plugin_search() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let bytes = crate::webext::fetch(LIST_URL, 4 << 20)?;
        let rows = parse_list(&bytes)?;
        let date = list_date(&bytes);
        let out = rows.iter().map(|l| { let mut r = list_row(l); r["updated"] = json!(date); r }).collect();
        *LISTED.lock().unwrap_or_else(|e| e.into_inner()) = rows;
        Ok(out)
    }).await.map_err(|e| e.to_string())?
}

/// A plugin of the list last loaded, by its id: the address and fingerprint are the list's, not the page's.
#[tauri::command]
pub async fn plugin_install_listed(app: tauri::AppHandle, id: String, state: tauri::State<'_, crate::AppState>) -> Result<Option<String>, String> {
    let base = base(&state)?;
    let l = LISTED.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|l| l.id == id).cloned().ok_or("Open the search again: that plugin is not on the list")?;
    tauri::async_runtime::spawn_blocking(move || install_zip(&base, &crate::webext::fetch(&l.zip, MAX_BYTES)?, &l, |t| crate::grant::ask(&app, "Install a plugin", t))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plugin_enable(app: tauri::AppHandle, id: String, state: tauri::State<'_, crate::AppState>) -> Result<bool, String> {
    let base = base(&state)?;
    tauri::async_runtime::spawn_blocking(move || enable(&base, &id, |t| crate::grant::ask(&app, "A plugin asks for more", t))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugin_disable(id: String, state: tauri::State<'_, crate::AppState>) -> Result<(), String> { disable(&base(&state)?, &id) }
#[tauri::command]
pub async fn plugin_remove(id: String, state: tauri::State<'_, crate::AppState>) -> Result<(), String> { remove(&base(&state)?, &id) }

/// The script of a plugin that may run.
#[tauri::command]
pub async fn plugin_main(id: String, state: tauri::State<'_, crate::AppState>) -> Result<String, String> {
    let base = base(&state)?;
    let m = runnable(&base, &id)?;
    let code = read_main(&base.join(&id), &m)?;
    code_unchanged(&base, &id, &code)?;
    Ok(code)
}

/// A plugin's GET, judged again here against what it was given.
#[tauri::command]
pub async fn plugin_fetch(id: String, url: String, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let m = runnable(&base(&state)?, &id)?;
    let hosts: Vec<String> = m.permissions.iter().filter_map(|p| p.strip_prefix("net:").map(String::from)).collect();
    tauri::async_runtime::spawn_blocking(move || fetch_listed(&url, &hosts)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("leo-plugins-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn manifest(id: &str, perms: &[&str]) -> String {
        json!({ "id": id, "name": "Word count", "version": "1.0.0", "author": "Someone", "description": "Counts words.", "main": "main.js", "permissions": perms }).to_string()
    }
    fn plugin_dir(root: &Path, id: &str, perms: &[&str]) -> PathBuf {
        let d = root.join(format!("src-{id}"));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("plugin.json"), manifest(id, perms)).unwrap();
        std::fs::write(d.join("main.js"), "leonote;").unwrap();
        d
    }
    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (n, t) in files { z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap(); z.write_all(t.as_bytes()).unwrap(); }
        z.finish().unwrap().into_inner()
    }
    fn listed(id: &str, bytes: &[u8], perms: &[&str]) -> Listed {
        Listed { id: id.into(), name: "Word count".into(), author: "Someone".into(), description: "Counts.".into(), repo: "someone/wc".into(), version: "1.0.0".into(), zip: String::new(), sha256: crate::external::sha256_hex(bytes), permissions: perms.iter().map(|s| s.to_string()).collect(), verified: false, stars: 0 }
    }

    #[test]
    fn a_manifest_is_checked_before_anything_else() {
        assert_eq!(parse_manifest(manifest("word-count", &["commands", "panel", "notes.read", "notes.write", "net:api.example.com"]).as_bytes()).unwrap().permissions.len(), 5);
        for id in ["allowed.json", "../evil", "A", "a b", "a/b", "a\\b", "", ".a", "a..b", "-a", "a.", &"x".repeat(65)] { assert!(parse_manifest(manifest(id, &[]).as_bytes()).is_err(), "{id}"); }
        for p in ["tasks", "settings", "files", "passwords", "programs", "net:*", "net:*.example.com", "net:localhost", "net:127.0.0.1", "net:192.168.1.1", "net:router.local", "net:[::1]", "net:intranet", "net:example.com:8080", "net:Example.com", "net:https://example.com"] {
            assert!(parse_manifest(manifest("a", &[p]).as_bytes()).is_err(), "{p}");
        }
        let with = |k: &str, v: &str| { let mut j: Value = serde_json::from_str(&manifest("a", &[])).unwrap(); j[k] = json!(v); j.to_string() };
        for m in ["../main.js", "C:/x.js", "/x.js", "a\\b.js", "main.exe", ".hidden.js", "a/../b.js"] { assert!(parse_manifest(with("main", m).as_bytes()).is_err(), "{m}"); }
        for v in ["1.0.0-beta", "", "1..0", "v1", "1.2.3.4.5"] { assert!(parse_manifest(with("version", v).as_bytes()).is_err(), "{v}"); }
        assert!(parse_manifest(with("name", "Safe\u{202E}gnp.exe").as_bytes()).is_err(), "text that turns itself around");
        assert!(parse_manifest(with("name", "two\nlines").as_bytes()).is_err());
        assert!(parse_manifest(b"not json").is_err());
    }

    #[test]
    fn the_example_and_the_template_are_valid() {
        let m = parse_manifest(include_bytes!("../../docs/plugins/example/plugin.json")).unwrap();
        assert_eq!((m.id.as_str(), m.main.as_str()), ("word-count", "main.js"));
        assert_eq!(m.permissions, ["commands", "panel", "notes.read"]);
        assert!(!m.permissions.iter().any(|p| p.starts_with("net:") || p == "notes.write"), "the example asks for what it uses");
        let rows = parse_list(include_bytes!("../../docs/plugins/plugins.template.json")).unwrap();
        assert_eq!(rows.len(), 1, "the template's row is usable as it stands");
    }

    #[test]
    fn the_dialog_names_the_plugin_and_each_permission_in_plain_words() {
        let m = parse_manifest(manifest("a", &["commands", "panel", "notes.read", "notes.write", "net:api.example.com"]).as_bytes()).unwrap();
        let t = consent_text(&m, false, None);
        assert!(t.contains("Word count") && t.contains("Someone") && t.contains("Not checked by Leonote"));
        for p in &m.permissions { assert!(t.contains(&words(p)), "{p}"); assert!(!words(p).contains("notes.") && !words(p).contains("net:"), "plain words"); }
        assert!(t.contains("api.example.com"));
        assert!(!consent_text(&m, true, None).contains("Not checked"), "only a verified version is spared it");
        assert!(consent_text(&m, false, Some("0.9")).contains("0.9"));
        // a frame can still send by name lookups: every dialog says so, and none says a plugin cannot reach the internet
        let none = parse_manifest(manifest("b", &[]).as_bytes()).unwrap();
        for t in [t, consent_text(&m, true, None), consent_text(&none, false, None), more_text(&m, &m.permissions)] { assert!(t.contains(TRUST) && !t.contains("cannot reach"), "{t}"); }
        assert_eq!(list_date(br#"{"updated":"2026-11-10","plugins":[]}"#).as_deref(), Some("2026-11-10"));
        for bad in [&br#"{"updated":"10 Nov"}"#[..], br#"{"updated":"2026-11-10<b>"}"#, br#"{}"#, b"nope"] { assert_eq!(list_date(bad), None); }
    }

    #[test]
    fn off_until_a_yes_and_a_no_leaves_nothing() {
        let root = temp("yes");
        let (base, src) = (root.join("plugins"), plugin_dir(&root, "wc", &["commands"]));
        let mut said = String::new();
        assert_eq!(install_folder(&base, &src, |t| { said = t.to_string(); false }).unwrap(), None);
        assert!(said.contains("Not checked by Leonote"));
        assert!(list(&base).is_empty() && runnable(&base, "wc").is_err() && !base.join("wc").exists());
        assert_eq!(install_folder(&base, &src, |_| true).unwrap().as_deref(), Some("wc"));
        let rows = list(&base);
        assert_eq!(rows[0]["on"], true);
        assert_eq!(rows[0]["source"]["kind"], "folder");
        assert!(rows[0]["source"]["path"].as_str().unwrap().contains("src-wc"), "says where it came from");
        assert_eq!(runnable(&base, "wc").unwrap().id, "wc");
        assert_eq!(std::fs::read_dir(&base).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with('.')).count(), 0, "no temporary folder stays");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plugin_cannot_take_the_place_of_the_file_of_yeses() {
        let root = temp("taken");
        let (base, good, evil) = (root.join("plugins"), plugin_dir(&root, "wc", &["commands"]), plugin_dir(&root, ALLOWED_FILE, &[]));
        install_folder(&base, &good, |_| true).unwrap();
        assert!(install_folder(&base, &evil, |_| panic!("no dialog for that name")).is_err());
        let z = zip_of(&[("plugin.json", &manifest(ALLOWED_FILE, &[])), ("main.js", "x")]);
        assert!(install_zip(&base, &z, &listed(ALLOWED_FILE, &z, &[]), |_| panic!("no dialog for that name")).is_err());
        assert!(allowed_file(&base).is_file() && runnable(&base, "wc").is_ok());
        remove(&base, "wc").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plugin_json_that_asks_for_more_asks_again() {
        let root = temp("more");
        let (base, src) = (root.join("plugins"), plugin_dir(&root, "wc", &["commands"]));
        install_folder(&base, &src, |_| true).unwrap();
        std::fs::write(base.join("wc/plugin.json"), manifest("wc", &["commands", "notes.read"])).unwrap();
        assert_eq!(list(&base)[0]["on"], false);
        assert_eq!(list(&base)[0]["more"][0], words("notes.read"));
        assert!(runnable(&base, "wc").is_err(), "off at once");
        let mut said = String::new();
        assert!(!enable(&base, "wc", |t| { said = t.to_string(); false }).unwrap());
        assert!(said.contains(&words("notes.read")) && said.contains("Not checked by Leonote"));
        assert!(runnable(&base, "wc").is_err(), "a no keeps it off");
        assert!(enable(&base, "wc", |_| true).unwrap());
        assert!(runnable(&base, "wc").is_ok());
        // asking less needs no question, and neither does turning it on again
        std::fs::write(base.join("wc/plugin.json"), manifest("wc", &["commands"])).unwrap();
        disable(&base, "wc").unwrap();
        assert!(runnable(&base, "wc").is_err() && list(&base)[0]["on"] == false, "off takes effect at once");
        assert!(enable(&base, "wc", |_| panic!("nothing new to ask")).unwrap());
        // its code changed behind Leonote's back: off, not run (its plugin.json alone is judged by its asks above)
        let main = |b: &Path| read_main(&b.join("wc"), &read_manifest(&b.join("wc")).unwrap()).unwrap();
        assert!(code_unchanged(&base, "wc", &main(&base)).is_ok());
        std::fs::write(base.join("wc/main.js"), "steal()").unwrap();
        assert!(code_unchanged(&base, "wc", &main(&base)).is_err() && runnable(&base, "wc").is_err(), "turned off");
        assert!(enable(&base, "wc", |_| true).is_err(), "on again would only be off again: install it again");
        // one installed before the check takes its code as its own, once
        change_allowed(&base, |all| { all["wc"]["code"] = Value::Null; all["wc"]["enabled"] = json!(true); }).unwrap();
        assert!(code_unchanged(&base, "wc", &main(&base)).is_ok());
        assert!(code_unchanged(&base, "wc", "other()").is_err());
        remove(&base, "wc").unwrap();
        assert!(list(&base).is_empty() && !base.join("wc").exists() && runnable(&base, "wc").is_err());
        for bad in ["..", "../x", "a/b", "a\\b", "", "C:x", ".incoming"] { assert!(remove(&base, bad).is_err(), "{bad}"); }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_vault_cannot_plant_a_plugin() {
        let root = temp("plant");
        let (home, vault) = (root.join("home/.leonote"), root.join("vault"));
        std::fs::create_dir_all(&home).unwrap();
        // what a synced vault could carry: a plugin folder in every place it could think of, and its own yes
        for d in [vault.join(".leonote/plugins/evil"), vault.join("plugins/evil"), vault.join("LeoNote/plugins/evil")] {
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("plugin.json"), manifest("evil", &["notes.read"])).unwrap();
            std::fs::write(d.parent().unwrap().join("allowed.json"), json!({ "evil": { "granted": ["notes.read"], "enabled": true } }).to_string()).unwrap();
        }
        let base = base_outside(&home, &vault).unwrap();
        assert!(base.starts_with(&home) && list(&base).is_empty() && runnable(&base, "evil").is_err());
        // Leonote's data folder inside the vault (a vault set to the home folder): plugins stay off
        assert!(base_outside(&vault.join(".leonote"), &vault).is_err());
        assert!(base_outside(&root.join("home/.leonote"), &root.join("home")).is_err());
        // a folder dropped into the real place without the install: listed so it can be removed, never run
        std::fs::create_dir_all(base.join("evil")).unwrap();
        std::fs::write(base.join("evil/plugin.json"), manifest("evil", &[])).unwrap();
        assert_eq!(list(&base)[0]["on"], false);
        assert_eq!(list(&base)[0]["known"], false);
        assert!(runnable(&base, "evil").is_err());
        assert!(enable(&base, "evil", |_| true).is_err(), "only the install can bring it in");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_update_keeps_its_source_and_its_off() {
        let root = temp("update");
        let base = root.join("plugins");
        let v1 = zip_of(&[("wc/plugin.json", &manifest("wc", &["commands"])), ("wc/main.js", "x")]);
        assert!(install_zip(&base, &v1, &listed("wc", &v1, &["commands"]), |_| true).unwrap().is_some());
        disable(&base, "wc").unwrap();
        // the same repo, asking for more: the new permission is named, and the plugin stays off
        let v2 = zip_of(&[("wc/plugin.json", &manifest("wc", &["commands", "notes.read"])), ("wc/main.js", "y")]);
        let mut said = String::new();
        assert!(install_zip(&base, &v2, &listed("wc", &v2, &["commands", "notes.read"]), |t| { said = t.into(); true }).unwrap().is_some());
        assert!(said.contains("New in this version") && said.contains("github.com/someone/wc"), "{said}");
        assert_eq!(list(&base)[0]["on"], false, "turned off before the update, off after it");
        // a row with the same id from another repo does not replace it
        let mut other = listed("wc", &v2, &["commands", "notes.read"]);
        other.repo = "stranger/wc".into();
        assert!(install_zip(&base, &v2, &other, |_| panic!("not even asked")).is_err());
        assert_eq!(list(&base)[0]["source"]["repo"], "someone/wc");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_download_is_held_to_the_list() {
        let root = temp("zip");
        let base = root.join("plugins");
        let good = zip_of(&[("wc-1.0.0/plugin.json", &manifest("wc", &["commands"])), ("wc-1.0.0/main.js", "x")]);
        // a different file than the list names: refused before anything is written or asked
        let mut l = listed("wc", &good, &["commands"]);
        l.sha256 = "0".repeat(64);
        assert!(install_zip(&base, &good, &l, |_| panic!("no dialog for a bad file")).is_err());
        assert!(!base.exists());
        // right fingerprint, wrong contents
        assert!(install_zip(&base, &good, &listed("other", &good, &["commands"]), |_| panic!()).is_err(), "another plugin");
        assert!(install_zip(&base, &good, &listed("wc", &good, &[]), |_| panic!()).is_err(), "asks for more than the list says");
        let mut verified = listed("wc", &good, &["commands"]);
        verified.verified = true;
        let mut said = String::new();
        assert_eq!(install_zip(&base, &good, &verified, |t| { said = t.into(); true }).unwrap().as_deref(), Some("wc"));
        assert!(said.contains("Verified"));
        assert_eq!(list(&base)[0]["source"]["repo"], "someone/wc");
        assert!(base.join("wc/main.js").is_file(), "the wrapping folder is gone");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_zip_cannot_write_outside_its_folder() {
        let root = temp("slip");
        let base = root.join("plugins");
        for evil in ["../evil.txt", "../../evil.txt", "a/../../evil.txt"] {
            let z = zip_of(&[("plugin.json", &manifest("wc", &[])), ("main.js", "x"), (evil, "x")]);
            assert!(install_zip(&base, &z, &listed("wc", &z, &[]), |_| panic!("no dialog for {evil}")).is_err(), "{evil}");
        }
        assert!(!root.join("evil.txt").exists() && !base.join("evil.txt").exists());
        assert!(list(&base).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn verified_means_this_version_and_this_file() {
        let sha = "a".repeat(64);
        let row = |version: &str, mark: Value, zip: &str| json!({ "plugins": [{ "id": "wc", "name": "Word count", "author": "Someone", "description": "Counts.", "repo": "someone/wc", "version": version, "zip": zip, "sha256": sha, "permissions": ["commands"], "verified": mark, "stars": 12 }] }).to_string();
        let ok = "https://github.com/someone/wc/releases/download/v1/wc.zip";
        let one = |r: String| parse_list(r.as_bytes()).unwrap();
        let exact = json!({ "version": "1.0.0", "sha256": sha });
        assert!(one(row("1.0.0", exact.clone(), ok))[0].verified);
        assert_eq!(one(row("1.0.0", exact.clone(), ok))[0].stars, 12);
        assert!(!one(row("1.0.1", exact.clone(), ok))[0].verified, "a newer version is not verified");
        assert!(!one(row("1.0.0", json!({ "version": "1.0.0", "sha256": "b".repeat(64) }), ok))[0].verified, "another file is not verified");
        assert!(!one(row("1.0.0", json!(true), ok))[0].verified && !one(row("1.0.0", Value::Null, ok))[0].verified);
        // only from the repository's own releases
        for bad in ["http://github.com/someone/wc/releases/download/v1/wc.zip", "https://evil.example/someone/wc/releases/download/v1/wc.zip", "https://github.com/other/wc/releases/download/v1/wc.zip", "https://github.com@evil.example/someone/wc/releases/download/v1/wc.zip", "https://github.com:8443/someone/wc/releases/download/v1/wc.zip", "https://github.com/someone/wc/archive/main.zip"] {
            assert!(one(row("1.0.0", Value::Null, bad)).is_empty(), "{bad}");
        }
        assert!(parse_list(b"<html>404</html>").is_err() && parse_list(b"{}").is_err());
        let r = list_row(&one(row("1.0.0", Value::Null, ok))[0]);
        assert!(r["report"].as_str().unwrap().starts_with("https://github.com/Olexify/leonote-plugins/issues/new?title="));
        assert!(r.get("zip").is_none() && r.get("sha256").is_none(), "the page never gets to name what is downloaded");
    }

    #[test]
    fn net_reaches_only_the_listed_hosts() {
        let hosts = vec!["api.example.com".to_string()];
        assert!(net_allowed("https://api.example.com/v1?q=a", &hosts));
        for bad in ["http://api.example.com/", "https://api.example.com:8443/", "https://user:pw@api.example.com/", "https://sub.api.example.com/", "https://api.example.com.evil.net/", "https://evil.net/?h=api.example.com", "https://127.0.0.1/", "file:///C:/x", "not a url"] {
            assert!(!net_allowed(bad, &hosts), "{bad}");
        }
        assert!(fetch_listed("https://evil.example/", &hosts).is_err(), "refused before any connection");
    }
}
