//! Where the settings live. Two files:
//!
//!   ~/.leonote/app.json             the bootstrap and what belongs to this
//!                                   machine: which vault, where the data is,
//!                                   window zoom, music libraries, outposts…
//!   <vault>/.leonote/settings.json  everything else - the look, the tabs and
//!                                   spaces, the folders, the browser's
//!                                   bookmarks - so each vault keeps its own,
//!                                   the way Obsidian's .obsidian folder does.
//!
//!   …/state.json                    what changes on nearly every click - the
//!                                   spaces with their tabs, the browser's
//!                                   history - beside whichever file holds
//!                                   the rest, so the preferences are not
//!                                   rewritten hundreds of times a day and a
//!                                   torn state file cannot take them along.
//!
//! `settingsInVault` in app.json (default on) says whether the second file is
//! used at all. Off, everything sits in app.json as it did before.
//! A file is only rewritten when its bytes would change.
//!
//! The frontend sees one merged object and saves one merged object; the split
//! happens here. A vault without a settings file starts from Leonote's
//! defaults, not from another vault's choices - that is the point.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// What stays in app.json in every mode: the machine's own affairs, and what
/// the Rust side reads before any vault is open.
pub const GLOBAL_KEYS: &[&str] = &[
    "vault", "vaultsExtra", "vaultsHidden", "vaultOrder", "dataDir", "settingsInVault",
    "playerLibraries", "outposts", "pcSearchRoots",
    "launchAtLogin", "closeToTray", "youtubeAuth",
    "uiScale", "uiScaleCompact", "compact",
    // browser add-ons are installed into the one WebView2 profile: their icons and pins go with them
    "webExtIcons", "webExtPinned", "webExtOrder", "webExtPopSize", "webExtPopZoom",
    // what names a program to run, an address that gets a key, or a sign-in: this computer's alone.
    // A vault is synced, shared and written by agents - none of them may choose what Leonote runs
    // or where it sends a key (DEVICE_ONLY below keeps a copy in the vault from being read)
    "aiProviders", "aiProvider", "downloadHosts", "googleClientId", "googleClientSecret", "ytApiKey", "gcal",
    // what this computer said yes to: code allowed to run (dataviewjs), pictures loaded from the web
    "dvTrusted", "webPictures",
    // what Jev did, with the start of each task's text: the tasks live outside the vault, so does this
    "jevLog",
    // the sites this computer has been on: its Player browser's tabs, the sites it zooms, never remembers or never asks about
    "playerBTabs", "playerBTabCur", "playerBrowserZoomHosts", "webZoomHosts", "webHistoryNever", "webHistoryFoldHosts", "pwNever",
    // where what is typed in the address box goes, and whether notes fetch link cards: a synced file must not choose it
    "webSearch", "webCustomEngines", "webBoxEngine", "linkPreviews",
    // changes waiting to be made to YouTube with this computer's sign-in: a synced vault, an agent or an old backup
    // must not queue them (and two computers sending one queue added each video twice)
    "ytPushQueue", "ytPushLists",
];
/// Lists from when they lived in the vault: kept here once, gone from the vault at the next save.
const MOVED_OUT: &[&str] = &["jevLog", "playerBTabs", "playerBTabCur", "playerBrowserZoomHosts", "webZoomHosts", "webHistoryNever", "webHistoryFoldHosts", "pwNever"];

/// The global keys that must never be taken from a vault's settings file, even when app.json
/// has no value for them yet (a planted one would otherwise be used).
pub(crate) const DEVICE_ONLY: &[&str] = &["playerLibraries", "outposts", "pcSearchRoots", "aiProviders", "aiProvider", "downloadHosts", "googleClientId", "googleClientSecret", "ytApiKey", "gcal", "dvTrusted", "webPictures", "webSearch", "webCustomEngines", "webBoxEngine", "linkPreviews", "ytPushQueue", "ytPushLists"];

/// A video tool's program path. Matched by its shape, not listed, so that a build without the tool still leaves it
/// in app.json: one start of such a build must not move a path from this computer into the synced vault.
fn tool_path(key: &str) -> bool {
    key.starts_with("yt") && key.ends_with("Path")
}

/// What is never taken from a vault's settings or from a backup.
pub(crate) fn device_only(key: &str) -> bool {
    DEVICE_ONLY.contains(&key) || tool_path(key)
}
/// An AI provider safe to carry over from a vault: a web service at one of the known providers' own
/// addresses, or a server on this computer - not a program to run, not an address anyone could have put there.
fn known_provider(p: &Value) -> bool {
    const SERVICES: &[&str] = &["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com", "api.x.ai", "api.perplexity.ai", "openrouter.ai"];
    if p.get("kind").and_then(|v| v.as_str()) == Some("cli") || p.get("cli").and_then(|v| v.as_bool()) == Some(true) { return false; }
    let Ok(u) = tauri::Url::parse(p.get("base").and_then(|v| v.as_str()).unwrap_or("").trim()) else { return false };
    // the address as a browser reads it: no name or password tucked in front of the host
    if !u.username().is_empty() || u.password().is_some() { return false; }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    (u.scheme() == "https" && SERVICES.contains(&host.as_str())) || (u.scheme() == "http" && matches!(host.as_str(), "localhost" | "127.0.0.1"))
}

/// Set in app.json once the device-only keys a vault file held from before have been moved over.
const DEVICE_MOVED: &str = "deviceKeysMoved";
const WEB_MOVED: &str = "webKeysMoved";

pub fn is_global(key: &str) -> bool {
    GLOBAL_KEYS.contains(&key) || key == DEVICE_MOVED || key == WEB_MOVED || tool_path(key)
}

/// State that is this computer's and not the vault's: the browser's history stays out of a synced vault.
pub const DEVICE_STATE_KEYS: &[&str] = &["webHistory"];

/// Session state, not preferences: rewritten constantly, kept in its own file.
pub const STATE_KEYS: &[&str] = &["spaces", "webHistory"];

pub fn is_state(key: &str) -> bool {
    STATE_KEYS.contains(&key)
}

fn state_file(beside: &Path) -> PathBuf {
    beside.with_file_name("state.json")
}

/// Open browser tabs stay out of a synced vault: its state.json holds a stand-in where a tab's address was
/// (`spaces` keeps the rest, so the vault's spaces and note tabs still travel), and this computer's own
/// state.json holds what each stand-in means, per vault. A stand-in another computer does not know: that tab
/// is not shown there, and its saves put it back, so the computer it belongs to still has it.
const WEB_TABS: &str = "webTabs";
const STAND_IN: &str = "leonote-tab:";
// ponytail: a plain hash, so someone reading the vault could confirm a guessed address; random ones if that ever matters
fn stand_in(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    format!("{STAND_IN}{:x}", h.finish())
}
/// Every `{ kind: "web", path, title }` and every side pane kept under "web:<address>", anywhere in `spaces`.
fn hide_web_tabs(v: &mut Value, kept: &mut Map<String, Value>) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(|x| hide_web_tabs(x, kept)),
        Value::Object(m) => {
            if m.get("kind").and_then(|k| k.as_str()) == Some("web") {
                let url = m.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
                if !url.is_empty() && !url.starts_with(STAND_IN) {
                    let token = stand_in(&url);
                    let title = m.remove("title").unwrap_or(Value::Null);
                    kept.insert(token.clone(), json!({ "path": url, "title": title }));
                    m.insert("path".into(), Value::String(token));
                }
            }
            for k in m.keys().filter(|k| k.len() > 4 && k.starts_with("web:") && !k[4..].starts_with(STAND_IN)).cloned().collect::<Vec<_>>() {
                let (url, token) = (k[4..].to_string(), stand_in(&k[4..]));
                let pane = m.remove(&k).unwrap_or(Value::Null);
                m.insert(format!("web:{token}"), pane);
                kept.entry(token).or_insert_with(|| json!({ "path": url, "title": null }));
            }
            m.values_mut().for_each(|x| hide_web_tabs(x, kept));
        }
        _ => {}
    }
}
/// The other way, for loading: stand-ins this computer does not know are left out of what it sees, and so is
/// a real address - this computer writes only stand-ins there, so one is what someone else put in the vault.
fn show_web_tabs(v: &mut Value, kept: &Map<String, Value>) {
    let unknown = |x: &Value| x.get("kind").and_then(|k| k.as_str()) == Some("web")
        && x.get("path").and_then(|p| p.as_str()).is_some_and(|p| !p.is_empty() && !kept.contains_key(p));
    match v {
        Value::Array(a) => {
            a.retain(|x| !unknown(x));
            a.iter_mut().for_each(|x| show_web_tabs(x, kept));
        }
        Value::Object(m) => {
            let token = m.get("path").and_then(|p| p.as_str()).filter(|p| p.starts_with(STAND_IN)).map(str::to_string);
            if let (Some("web"), Some(t)) = (m.get("kind").and_then(|k| k.as_str()), token) {
                if let Some(e) = kept.get(&t) {
                    m.insert("path".into(), e["path"].clone());
                    if let Some(title) = e.get("title").filter(|t| t.is_string()) { m.insert("title".into(), title.clone()); }
                }
            }
            for k in m.keys().filter(|k| k.starts_with("web:") && k[4..].starts_with(STAND_IN)).cloned().collect::<Vec<_>>() {
                let pane = m.remove(&k).unwrap_or(Value::Null);
                if let Some(url) = kept.get(&k[4..]).and_then(|e| e["path"].as_str()) { m.insert(format!("web:{url}"), pane); }
            }
            m.values_mut().for_each(|x| show_web_tabs(x, kept));
        }
        _ => {}
    }
}

/// What each stand-in means, for every vault on this computer: a stand-in means the same address in all of
/// them, and this also survives a vault moved or renamed.
fn known_tabs(own: &Map<String, Value>) -> Map<String, Value> {
    own.get(WEB_TABS).and_then(|w| w.as_object()).into_iter().flat_map(|w| w.values()).filter_map(|m| m.as_object()).flatten().map(|(k, v)| (k.clone(), v.clone())).collect()
}
/// A save: the page tabs of other computers, in the vault's `old` spaces but never shown here, go back into `new`.
/// At the end of their list, so this computer's `active` still counts its own tabs; the other computer finds them
/// moved to the end of the space, and a space removed here takes them with it.
// ponytail: a computer no longer used leaves its stand-ins here for good - a few short hashes, nothing to read; a "forget other computers' tabs" button if that ever matters
fn keep_foreign_tabs(new: &mut Value, old: &Value, known: &Map<String, Value>) {
    let foreign = |p: &str| p.starts_with(STAND_IN) && !known.contains_key(p);
    match (new, old) {
        (Value::Array(n), Value::Array(o)) => {
            for x in o {
                if x.get("kind").and_then(|k| k.as_str()) == Some("web") && x.get("path").and_then(|p| p.as_str()).is_some_and(foreign) {
                    if !n.contains(x) { n.push(x.clone()); }
                } else if let Some(id) = x.get("id") {
                    if let Some(same) = n.iter_mut().find(|y| y.get("id") == Some(id)) { keep_foreign_tabs(same, x, known); }
                }
            }
        }
        (Value::Object(n), Value::Object(o)) => {
            for (k, v) in o {
                if k.strip_prefix("web:").is_some_and(foreign) { n.entry(k.clone()).or_insert_with(|| v.clone()); }
                else if let Some(same) = n.get_mut(k) { keep_foreign_tabs(same, v, known); }
            }
        }
        _ => {}
    }
}

/// The Player's online library - thousands of videos - lives in a file of its own beside the settings,
/// written only when it changes: every other setting saved (a volume, a song played) no longer
/// writes it out again.
pub const LIBRARY_KEYS: &[&str] = &["youtubeLibrary"];
fn library_file(beside: &Path) -> PathBuf {
    beside.with_file_name("online.json")
}
/// online.json laid over the settings; with none yet, the library still inside the settings moves into it.
fn with_library(mut m: Map<String, Value>, beside: &Path) -> Map<String, Value> {
    let file = library_file(beside);
    match read(&file) {
        Some(lib) => { for (k, v) in lib { if LIBRARY_KEYS.contains(&k.as_str()) { m.insert(k, v); } } }
        None => {
            let lib: Map<String, Value> = m.iter().filter(|(k, _)| LIBRARY_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
            if !lib.is_empty() { let _ = write(&file, &lib); }
        }
    }
    m
}

pub fn in_vault(global: &Value) -> bool {
    global.get("settingsInVault").and_then(|v| v.as_bool()).unwrap_or(true)
}

pub fn vault_file(vault: &Path) -> PathBuf {
    vault.join(".leonote").join("settings.json")
}

/// The folders Leonote may write into (the vault, outposts, Player libraries) that `data` names and app.json
/// does not yet: each must pass `ok` (picked in a dialog, or a yes), never be one the page added on its own.
/// One that does not is left out of `data`; the vault stays what app.json says.
pub fn keep_allowed_folders(settings_path: &Path, data: &mut Value, mut ok: impl FnMut(&str, &str) -> bool) {
    // each list on its own: a folder app.json holds only for searching is not thereby allowed as an outpost or the vault
    let all = |s: &Value| -> Vec<(&'static str, String)> {
        let mut v: Vec<(&'static str, String)> = crate::outpost::saved_paths(s).into_iter().map(|p| ("outposts", p)).collect();
        v.extend(crate::library::saved_paths(s).into_iter().map(|p| ("playerLibraries", p)));
        v.extend(s["pcSearchRoots"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(|p| ("pcSearchRoots", p.to_string()))));
        v.extend(s.get("vault").and_then(|x| x.as_str()).filter(|x| !x.trim().is_empty()).map(|p| ("vault", p.to_string())));
        v
    };
    let k = |p: &str| p.trim().trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    let old = Value::Object(read(settings_path).unwrap_or_default());
    let had: Vec<(&str, String)> = all(&old).into_iter().map(|(c, p)| (c, k(&p))).collect();
    let refused: Vec<(&str, String)> = all(data).into_iter().filter(|(c, p)| !had.contains(&(*c, k(p)))).filter(|(c, p)| !ok(c, p)).map(|(c, p)| (c, k(&p))).collect();
    if refused.is_empty() { return; }
    let no = |c: &str, p: &str| refused.contains(&(c, k(p)));
    let Value::Object(m) = data else { return };
    for list in ["outposts", "playerLibraries"] {
        if let Some(Value::Array(a)) = m.get_mut(list) {
            a.retain(|x| !x.get("path").and_then(|p| p.as_str()).is_some_and(|p| no(list, p)));
        }
    }
    if let Some(Value::Array(a)) = m.get_mut("pcSearchRoots") {
        a.retain(|x| !x.as_str().is_some_and(|p| no("pcSearchRoots", p)));
    }
    if m.get("vault").and_then(|x| x.as_str()).is_some_and(|p| no("vault", p)) {
        match old.get("vault") { Some(v) => { m.insert("vault".into(), v.clone()); } None => { m.remove("vault"); } }
    }
}

fn read(p: &Path) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(&std::fs::read_to_string(p).ok()?).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn write(p: &Path, m: &Map<String, Value>) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("create {}: {}", d.display(), e))?;
    }
    let body = serde_json::to_string_pretty(&Value::Object(m.clone())).map_err(|e| e.to_string())?;
    if std::fs::read(p).map(|old| old == body.as_bytes()).unwrap_or(false) { return Ok(()); }
    keep_previous(p);
    crate::vault::write_atomic(p, body.as_bytes()).map_err(|e| format!("write {}: {}", p.display(), e))
}

/// The vault folder named in app.json is gone: start on the default vault next time (the key removed, nothing else).
pub fn forget_vault(settings_path: &Path) -> Result<(), String> {
    let mut m = read(settings_path).ok_or("app.json could not be read")?;
    m.remove("vault");
    write(settings_path, &m)
}

/// (global, the rest without state, state)
/// How many earlier versions of each settings file stay, and how close two may be.
pub const KEEP_VERSIONS: usize = 20;
const VERSION_GAP_SECS: u64 = 600;

/// Before a settings file is replaced, the version on disk goes to
/// `history/settings/<name> <stamp>.json` beside it - at most one per ten
/// minutes per file, the oldest dropped past KEEP_VERSIONS. The rename write
/// already keeps a freeze mid-write from leaving half a file; this is for the
/// other case, a whole file written wrong (a reset, a bug), which a rename
/// cannot help with.
fn keep_previous(p: &Path) {
    let Ok(old) = std::fs::read(p) else { return };
    if old.is_empty() || serde_json::from_slice::<Value>(&old).is_err() { return; } // nothing worth keeping
    let (Some(dir), Some(name)) = (p.parent(), p.file_name().and_then(|n| n.to_str())) else { return };
    let stem = name.trim_end_matches(".json");
    let hist = dir.join("history").join("settings");
    let mut have: Vec<PathBuf> = std::fs::read_dir(&hist).ok().map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|f| f.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with(&format!("{} ", stem)) && n.ends_with(".json")).unwrap_or(false)).collect()).unwrap_or_default();
    have.sort();
    if let Some(last) = have.last() {
        let fresh = std::fs::metadata(last).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() < VERSION_GAP_SECS).unwrap_or(false);
        if fresh { return; }
    }
    if std::fs::create_dir_all(&hist).is_err() { return; }
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H%M%S").to_string();
    let _ = std::fs::write(hist.join(format!("{} {}.json", stem, stamp)), &old);
    if have.len() + 1 > KEEP_VERSIONS { for f in have.iter().take(have.len() + 1 - KEEP_VERSIONS) { let _ = std::fs::remove_file(f); } }
}

fn split(data: &Map<String, Value>) -> (Map<String, Value>, Map<String, Value>, Map<String, Value>) {
    let mut g = Map::new();
    let mut v = Map::new();
    let mut st = Map::new();
    for (k, val) in data {
        if is_global(k) { g.insert(k.clone(), val.clone()); } else if is_state(k) { st.insert(k.clone(), val.clone()); } else { v.insert(k.clone(), val.clone()); }
    }
    (g, v, st)
}

/// state.json laid over the file it sits beside; a key there wins.
fn with_state(mut m: Map<String, Value>, beside: &Path) -> Map<String, Value> {
    if let Some(st) = read(&state_file(beside)) { for (k, v) in st { if is_state(&k) { m.insert(k, v); } } }
    m
}

/// The merged view the frontend works with. A vault that has no settings file
/// yet gets one: the first time the mode is on, the non-global part of
/// app.json moves in (nothing anyone set is lost); after that a new vault
/// starts empty.
pub fn load(settings_path: &Path, vault: &Path) -> Value {
    let global = read(settings_path).unwrap_or_default();
    if !in_vault(&Value::Object(global.clone())) || vault.as_os_str().is_empty() || !vault.is_dir() {
        return Value::Object(with_library(with_state(global, settings_path), settings_path));
    }
    let file = vault_file(vault);
    let vault_part = match read(&file) {
        Some(m) => m,
        None => {
            let (g, mut v, st) = split(&global);
            let carried = g.len() != global.len(); // app.json still held per-vault keys: they move
            if carried {
                if write(&file, &v).is_ok() {
                    let _ = write(&state_file(&file), &st);
                    let _ = write(settings_path, &g);
                }
                v.extend(st);
                v
            } else {
                Map::new()
            }
        }
    };
    let mut vault_part = vault_part;
    // the device-only keys a vault file still holds from before they were device-only: moved into app.json
    // once (what was set is kept), and from then on never read from a vault
    let mut global = global;
    if !global.contains_key(DEVICE_MOVED) {
        // app.json as it is on disk now (the first load above may have just rewritten it)
        let mut disk = read(settings_path).unwrap_or_default();
        // Only what cannot hurt is carried over: the AI providers that talk to a known service or to this
        // computer, and which one was chosen. Never a program to run (a command-line provider, a tool's
        // path), never the sites allowed to download, never a Google app or sign-in - a vault may hold
        // what someone else put there; those are set again on this computer.
        let mut carry: Vec<(&str, Value)> = Vec::new();
        if let Some(Value::Array(list)) = vault_part.get("aiProviders") {
            let safe: Vec<Value> = list.iter().filter(|p| known_provider(p)).cloned().collect();
            if !safe.is_empty() { carry.push(("aiProviders", Value::Array(safe))); }
        }
        if let Some(v) = vault_part.get("aiProvider") { carry.push(("aiProvider", v.clone())); }
        for (k, v) in carry {
            global.entry(k.to_string()).or_insert(v.clone());
            disk.entry(k.to_string()).or_insert(v);
        }
        global.insert(DEVICE_MOVED.into(), Value::Bool(true));
        disk.insert(DEVICE_MOVED.into(), Value::Bool(true));
        let _ = write(settings_path, &disk);
    }
    // the search engine chosen became this computer's later: its name is carried over once, so an upgrade keeps the
    // choice. Only a name (an engine Leonote knows, or none at all); never an address - engines of one's own and link
    // cards are set again by hand, a vault file may hold what someone else put there
    if !global.contains_key(WEB_MOVED) {
        let mut disk = read(settings_path).unwrap_or_default();
        let mut carry: Vec<(&str, Value)> = Vec::new();
        for k in ["webSearch", "webBoxEngine"] {
            if let Some(v @ Value::String(id)) = vault_part.get(k) {
                if !id.is_empty() && id.len() <= 24 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) { carry.push((k, v.clone())); }
            }
        }
        for (k, v) in carry {
            global.entry(k.to_string()).or_insert(v.clone());
            disk.entry(k.to_string()).or_insert(v);
        }
        global.insert(WEB_MOVED.into(), Value::Bool(true));
        disk.insert(WEB_MOVED.into(), Value::Bool(true));
        let _ = write(settings_path, &disk);
    }
    for k in MOVED_OUT { if let Some(v) = vault_part.get(*k) { global.entry(k.to_string()).or_insert(v.clone()); } }
    // what is this computer's comes from app.json alone: a planted path here would be looked at on the next start
    vault_part.retain(|k, _| !is_global(k));
    let mut merged = with_state(vault_part, &file);
    // the browser's history: this computer's own state file, not the vault's (moved over the first time)
    let own = read(&state_file(settings_path)).unwrap_or_default();
    for k in DEVICE_STATE_KEYS { match own.get(*k) { Some(v) => { merged.insert(k.to_string(), v.clone()); } None => {} } }
    if let Some(sp) = merged.get_mut("spaces") {
        show_web_tabs(sp, &known_tabs(&own));
    }
    for (k, val) in global {
        if is_global(&k) { merged.insert(k, val); } else if !merged.contains_key(&k) { merged.insert(k, val); }
    }
    Value::Object(with_library(merged, &file))
}

/// One merged object in; app.json gets the global keys (and only those, in
/// vault mode), the vault's file the rest.
pub fn save(settings_path: &Path, vault: &Path, data: &Value) -> Result<(), String> {
    let Value::Object(data) = data else { return Err("settings must be a JSON object".into()) };
    let use_vault = in_vault(&Value::Object(data.clone())) && !vault.as_os_str().is_empty() && vault.is_dir();
    // the online library: to its own file, and only when it came along (the app sends it when it changed)
    let mut data = data.clone();
    let lib: Map<String, Value> = LIBRARY_KEYS.iter().filter_map(|k| data.remove(*k).map(|v| (k.to_string(), v))).collect();
    if !lib.is_empty() { write(&library_file(&if use_vault { vault_file(vault) } else { settings_path.to_path_buf() }), &lib)?; }
    let data = &data;
    let (g, v, mut st) = split(data);
    if !use_vault {
        let mut all = g; all.extend(v);
        // a vault that is away for now (a drive unplugged): its tabs' addresses wait for it
        if let Some(w) = read(&state_file(settings_path)).and_then(|mut own| own.remove(WEB_TABS)) { st.insert(WEB_TABS.into(), w); }
        write(&state_file(settings_path), &st)?;
        return write(settings_path, &all);
    }
    let file = vault_file(vault);
    // device state beside app.json, the rest of the state beside the vault's settings
    let (mine, mut st): (Map<String, Value>, Map<String, Value>) = st.into_iter().partition(|(k, _)| DEVICE_STATE_KEYS.contains(&k.as_str()));
    let mut kept = Map::new();
    if let Some(sp) = st.get_mut("spaces") { hide_web_tabs(sp, &mut kept); }
    if !mine.is_empty() || st.contains_key("spaces") {
        let mut own = read(&state_file(settings_path)).unwrap_or_default();
        own.extend(mine);
        if st.contains_key("spaces") {
            // known: what this computer had before this save too, so a tab closed here stays closed
            let mut known = known_tabs(&own);
            known.extend(kept.clone());
            if let (Some(sp), Some(old)) = (st.get_mut("spaces"), read(&state_file(&file)).and_then(|mut o| o.remove("spaces"))) { keep_foreign_tabs(sp, &old, &known); }
            let all = own.entry(WEB_TABS.to_string()).or_insert_with(|| json!({}));
            if !all.is_object() { *all = json!({}); }
            all[vault.to_string_lossy().as_ref()] = Value::Object(kept);
        }
        write(&state_file(settings_path), &own)?; // first, so the vault never holds a stand-in nothing here explains
    }
    write(&state_file(&file), &st)?;
    write(&file, &v)?;
    write(settings_path, &g)
}

/// The file that holds most of the settings right now, for "Show in Explorer".
pub fn main_file(settings_path: &Path, vault: &Path) -> PathBuf {
    let global = read(settings_path).map(Value::Object).unwrap_or_else(|| json!({}));
    if in_vault(&global) && vault.is_dir() { vault_file(vault) } else { settings_path.to_path_buf() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("leonote-settings-{}-{}", std::process::id(), rand_tag()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    // the clock alone is not enough: Windows' ticks are 100 ns apart, and tests run side by side
    fn rand_tag() -> String { static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0); format!("{}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) }

    #[test]
    fn the_online_library_lives_apart_and_is_written_only_when_it_comes_along() {
        let d = tmp();
        let app = d.join("app.json");
        let vault = d.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        // an install from before: the library inside the settings - the first load moves it out
        std::fs::create_dir_all(vault.join(".leonote")).unwrap();
        std::fs::write(vault_file(&vault), r#"{"theme":"dark","youtubeLibrary":[{"id":"a"}]}"#).unwrap();
        let s = load(&app, &vault);
        assert_eq!(s["youtubeLibrary"][0]["id"], "a");
        assert!(library_file(&vault_file(&vault)).is_file());
        // saved without it (nothing changed in it): the settings drop it, the library stays
        save(&app, &vault, &serde_json::json!({ "theme": "light" })).unwrap();
        assert!(read(&vault_file(&vault)).unwrap().get("youtubeLibrary").is_none());
        assert_eq!(load(&app, &vault)["youtubeLibrary"][0]["id"], "a");
        // saved with it: its own file changes
        save(&app, &vault, &serde_json::json!({ "theme": "light", "youtubeLibrary": [{ "id": "b" }] })).unwrap();
        let s = load(&app, &vault);
        assert_eq!((s["theme"].as_str(), s["youtubeLibrary"][0]["id"].as_str()), (Some("light"), Some("b")));
    }

    #[test]
    fn a_tools_path_stays_on_this_computer_in_every_build() {
        let d = tmp();
        let app = d.join("app.json");
        let vault = d.join("vault");
        std::fs::create_dir_all(vault.join(".leonote")).unwrap();
        std::fs::write(&app, r#"{"vault":"x","settingsInVault":true,"deviceKeysMoved":true,"ytToolPath":"C:/mine.exe"}"#).unwrap();
        std::fs::write(vault_file(&vault), r#"{"theme":"dark"}"#).unwrap();
        let s = load(&app, &vault);
        save(&app, &vault, &s).unwrap();
        assert_eq!(read(&app).unwrap()["ytToolPath"], "C:/mine.exe");
        assert!(read(&vault_file(&vault)).unwrap().get("ytToolPath").is_none());
        std::fs::write(vault_file(&vault), r#"{"ytToolPath":"//evil/s/x.exe"}"#).unwrap();
        assert_eq!(load(&app, &vault)["ytToolPath"], "C:/mine.exe", "a planted one is never read");
        assert!(device_only("ytToolPath"));
    }

    #[test]
    fn a_folder_the_page_adds_is_saved_only_when_allowed() {
        let d = tmp();
        let app = d.join("app.json");
        std::fs::write(&app, r#"{"vault":"C:\\Notes","outposts":[{"path":"D:\\Old"}],"pcSearchRoots":["C:\\Startup"]}"#).unwrap();
        let mut data = json!({ "theme": "dark", "vault": "C:\\Startup", "outposts": [{ "path": "d:/old/" }, { "path": "C:\\Startup" }, { "path": "E:\\Picked" }], "playerLibraries": [{ "path": "C:\\Startup" }], "pcSearchRoots": ["C:\\Startup"] });
        let mut asked = Vec::new();
        keep_allowed_folders(&app, &mut data, |_, p| { asked.push(p.to_string()); p == "E:\\Picked" });
        // C:\Startup is in app.json only as a search root: kept there, still asked about as an outpost, library or vault
        assert_eq!(asked, ["C:\\Startup", "E:\\Picked", "C:\\Startup", "C:\\Startup"], "what app.json already has in the same list is not asked about");
        assert_eq!(data, json!({ "theme": "dark", "vault": "C:\\Notes", "outposts": [{ "path": "d:/old/" }, { "path": "E:\\Picked" }], "playerLibraries": [], "pcSearchRoots": ["C:\\Startup"] }));
    }

    #[test]
    fn a_vault_cannot_choose_what_runs_or_where_keys_go() {
        let d = tmp();
        let app = d.join("app.json");
        let vault = d.join("vault");
        std::fs::create_dir_all(vault.join(".leonote")).unwrap();
        std::fs::write(&app, r#"{"vault":"x","settingsInVault":true}"#).unwrap();
        // from before: the user's own providers sat in the vault. Moved to this computer once - but only those
        // that talk to a known service or to this computer; never a program to run, a look-alike address, a path
        std::fs::write(vault_file(&vault), r#"{"theme":"dark","downloadHosts":["a.example"],"aiProviders":[
            {"id":"mine","kind":"openai","base":"https://api.openai.com/v1"},
            {"id":"local","kind":"openai","base":"http://localhost:11434/v1"},
            {"id":"cmd","kind":"cli","base":"evil.exe"},
            {"id":"lookalike","kind":"openai","base":"https://api.openai.com.evil.example/v1"},
            {"id":"tucked","kind":"openai","base":"http://localhost:80@evil.example/v1"}]}"#).unwrap();
        let s = load(&app, &vault);
        let ids: Vec<&str> = s["aiProviders"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["mine", "local"]);
        assert!(s.get("downloadHosts").is_none(), "what is allowed to download is set again on this computer, never carried over");
        save(&app, &vault, &s).unwrap();
        assert!(read(&vault_file(&vault)).unwrap().get("aiProviders").is_none(), "no longer written into the vault");
        // later, someone with write access to the vault plants a program and a provider: never read
        std::fs::write(vault_file(&vault), r#"{"theme":"dark","aiProviders":[{"id":"evil"}],"downloadHosts":["evil.com"],
            "webSearch":"evil","webCustomEngines":[{"id":"evil","url":"https://evil.example/?q=%s"}],"webBoxEngine":"evil","linkPreviews":true}"#).unwrap();
        let s = load(&app, &vault);
        assert_eq!(s["aiProviders"][0]["id"], "mine");
        assert!(s.get("downloadHosts").is_none());
        for k in ["webSearch", "webCustomEngines", "webBoxEngine", "linkPreviews"] { assert!(s.get(k).is_none(), "{k} taken from the vault"); }
        // the browser's history stays on this computer, out of the vault
        let mut with_hist = s.clone();
        with_hist["webHistory"] = serde_json::json!([{ "url": "https://a.example" }]);
        save(&app, &vault, &with_hist).unwrap();
        assert!(read(&state_file(&vault_file(&vault))).unwrap_or_default().get("webHistory").is_none());
        assert_eq!(load(&app, &vault)["webHistory"][0]["url"], "https://a.example");
    }

    #[test]
    fn the_search_engine_chosen_before_it_was_this_computers_is_kept_once() {
        let d = tmp();
        let app = d.join("app.json");
        let vault = d.join("vault");
        std::fs::create_dir_all(vault.join(".leonote")).unwrap();
        std::fs::write(&app, r#"{"vault":"x","settingsInVault":true,"deviceKeysMoved":true}"#).unwrap();
        std::fs::write(vault_file(&vault), r#"{"webSearch":"ddg","webCustomEngines":[{"id":"a","url":"https://a.example/?q=%s"},{"id":"b","url":"http://b.example/?q=%s"}],"linkPreviews":true}"#).unwrap();
        let s = load(&app, &vault);
        assert_eq!(s["webSearch"], "ddg");
        assert!(s.get("webCustomEngines").is_none(), "an engine's address never comes from the vault");
        assert!(s.get("linkPreviews").is_none(), "link cards are switched on again by hand");
        // once only: what the vault holds later is not read
        std::fs::write(vault_file(&vault), r#"{"webSearch":"evil"}"#).unwrap();
        assert_eq!(load(&app, &vault)["webSearch"], "ddg");
    }

    #[test]
    fn no_file_in_a_vault_can_add_this_computers_keys() {
        let d = tmp();
        let app = d.join("app.json");
        let vault = d.join("vault");
        std::fs::create_dir_all(vault.join(".leonote")).unwrap();
        std::fs::write(&app, r#"{"vault":"x","deviceKeysMoved":true}"#).unwrap();
        let planted = "//evil/s";
        std::fs::write(vault_file(&vault), format!(r#"{{"theme":"dark","outposts":[{{"path":"{planted}"}}],"playerLibraries":[{{"path":"{planted}"}}]}}"#)).unwrap();
        std::fs::write(state_file(&vault_file(&vault)), format!(r#"{{"spaces":[1],"outposts":[{{"path":"{planted}"}}]}}"#)).unwrap();
        std::fs::write(library_file(&vault_file(&vault)), format!(r#"{{"youtubeLibrary":[{{"id":"a"}}],"outposts":[{{"path":"{planted}"}}],"aiProvider":"{planted}"}}"#)).unwrap();
        let s = load(&app, &vault);
        assert_eq!((s["theme"].as_str(), s["spaces"][0].as_i64(), s["youtubeLibrary"][0]["id"].as_str()), (Some("dark"), Some(1), Some("a")));
        for k in ["outposts", "playerLibraries", "aiProvider"] { assert!(s.get(k).is_none(), "{k}"); }
        // this computer's own list still counts
        std::fs::write(&app, r#"{"vault":"x","deviceKeysMoved":true,"outposts":[{"path":"E:/Music"}]}"#).unwrap();
        assert_eq!(load(&app, &vault)["outposts"][0]["path"], "E:/Music");
    }

    #[test]
    fn first_load_moves_per_vault_keys_into_the_vault() {
        let d = tmp();
        let app = d.join("app.json");
        let vault = d.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(&app, r#"{"vault":"x","theme":"light","uiScale":1.2}"#).unwrap();
        let merged = load(&app, &vault);
        assert_eq!(merged["theme"], "light");
        assert_eq!(merged["uiScale"], 1.2);
        let v = read(&vault_file(&vault)).unwrap();
        assert_eq!(v["theme"], "light");
        assert!(v.get("uiScale").is_none());
        let g = read(&app).unwrap();
        assert!(g.get("theme").is_none());
        assert_eq!(g["uiScale"], 1.2);
    }

    #[test]
    fn save_splits_and_a_new_vault_starts_clean() {
        let d = tmp();
        let app = d.join("app.json");
        let a = d.join("a");
        let b = d.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(&app, "{}").unwrap();
        save(&app, &a, &json!({ "vault": "a", "accent": "rose", "closeToTray": false })).unwrap();
        assert_eq!(read(&app).unwrap().get("accent"), None);
        assert_eq!(read(&vault_file(&a)).unwrap()["accent"], "rose");
        let other = load(&app, &b);
        assert!(other.get("accent").is_none(), "b must not inherit a's accent");
        assert_eq!(other["closeToTray"], false);
        assert!(!vault_file(&b).exists(), "an empty vault file is not written");
    }

    #[test]
    fn open_tab_addresses_and_jev_log_stay_out_of_the_vault_and_come_back_here() {
        let d = tmp();
        let app = d.join("app.json");
        let a = d.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(&app, "{}").unwrap();
        let spaces = json!([{ "id": "default", "tabs": [
            { "kind": "note", "path": "n.md" },
            { "kind": "web", "path": "https://secret.example/page", "wid": "w1", "title": "Secret page" },
            { "kind": "web", "path": "", "wid": "w2" },
        ], "tabPanes": { "web:https://secret.example/page": { "tabs": [{ "kind": "web", "path": "https://pane.example/" }] }, "note:n.md": { "tabs": [] } } }]);
        save(&app, &a, &json!({ "spaces": spaces, "jevLog": [{ "text": "filed the task secret title" }] })).unwrap();
        // nothing in the vault says where the tabs were or what Jev filed
        for f in [state_file(&vault_file(&a)), vault_file(&a)] {
            let body = std::fs::read_to_string(&f).unwrap();
            for word in ["secret", "Secret", "pane.example"] { assert!(!body.contains(word), "{word} in {}: {body}", f.display()); }
        }
        // this computer gets them all back, exactly
        let s = load(&app, &a);
        assert_eq!(s["spaces"], spaces);
        assert_eq!(s["jevLog"][0]["text"], "filed the task secret title");
        // a real address in the vault's state is not shown: this computer writes only stand-ins there, so
        // whoever can write the synced folder cannot open a page in a tab at launch
        std::fs::write(state_file(&vault_file(&a)), r#"{"spaces":[{"id":"default","tabs":[{"kind":"web","path":"https://old.example/"}]}]}"#).unwrap();
        assert_eq!(load(&app, &a)["spaces"][0]["tabs"], json!([]));
        // another computer, the same synced vault: the note tab comes, the page tabs it knows nothing of do not
        let other = d.join("pc2").join("app.json");
        save(&app, &a, &json!({ "spaces": spaces })).unwrap();
        std::fs::create_dir_all(d.join("pc2")).unwrap(); std::fs::write(&other, "{}").unwrap();
        let s = load(&other, &a);
        let tabs = s["spaces"][0]["tabs"].as_array().unwrap();
        assert_eq!(tabs.iter().map(|t| t["path"].as_str().unwrap()).collect::<Vec<_>>(), ["n.md", ""]);
        assert!(s["spaces"][0]["tabPanes"].get("note:n.md").is_some());
        assert_eq!(s["spaces"][0]["tabPanes"].as_object().unwrap().len(), 1);
        // the vault away for a moment: what its tabs mean is kept for when it is back
        save(&app, &d.join("gone"), &json!({ "settingsInVault": true })).unwrap();
        assert_eq!(load(&app, &a)["spaces"], spaces);
    }

    #[test]
    fn another_computer_saving_a_synced_vault_leaves_this_computers_page_tabs_alone() {
        let d = tmp();
        let (pc1, pc2) = (d.join("pc1").join("app.json"), d.join("pc2").join("app.json"));
        let a = d.join("a");
        std::fs::create_dir_all(&a).unwrap();
        for f in [&pc1, &pc2] { std::fs::create_dir_all(f.parent().unwrap()).unwrap(); std::fs::write(f, "{}").unwrap(); }
        let web = |u: &str| json!({ "kind": "web", "path": u, "wid": u.len().to_string() });
        let note = json!({ "kind": "note", "path": "n.md" });
        let mine = json!([{ "id": "default", "tabs": [web("https://one.example/"), note, web("https://two.example/")],
            "tabPanes": { "web:https://one.example/": { "tabs": [web("https://pane.example/")] } } }]);
        save(&pc1, &a, &json!({ "spaces": mine })).unwrap();
        // the second computer sees the note and saves what it sees, with a page tab of its own
        let mut there = load(&pc2, &a);
        there["spaces"][0]["tabs"].as_array_mut().unwrap().insert(0, web("https://theirs.example/"));
        save(&pc2, &a, &json!({ "spaces": there["spaces"] })).unwrap();
        let body = std::fs::read_to_string(state_file(&vault_file(&a))).unwrap();
        for word in ["one.example", "two.example", "pane.example", "theirs.example"] { assert!(!body.contains(word), "{word} in the vault: {body}"); }
        // back on the first: all its page tabs and their side pane, the other's tab not shown
        let back = load(&pc1, &a);
        let paths = |s: &Value| s["spaces"][0]["tabs"].as_array().unwrap().iter().map(|t| t["path"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(paths(&back), ["n.md", "https://one.example/", "https://two.example/"]);
        assert_eq!(back["spaces"][0]["tabPanes"]["web:https://one.example/"]["tabs"][0]["path"], "https://pane.example/");
        // its own save does not lose the other's, and the other's sees only its own, as many saves on
        save(&pc1, &a, &json!({ "spaces": back["spaces"] })).unwrap();
        assert_eq!(paths(&load(&pc2, &a)), ["n.md", "https://theirs.example/"]);
        // a tab closed on the first stays closed on the first
        let mut closing = load(&pc1, &a);
        closing["spaces"][0]["tabs"].as_array_mut().unwrap().retain(|t| t["path"] != "https://two.example/");
        save(&pc1, &a, &json!({ "spaces": closing["spaces"] })).unwrap();
        assert_eq!(paths(&load(&pc1, &a)), ["n.md", "https://one.example/"]);
    }

    #[test]
    fn the_sites_this_computer_was_on_leave_the_vault_once_and_stay_here() {
        let d = tmp();
        let app = d.join("app.json");
        let a = d.join("a");
        std::fs::create_dir_all(a.join(".leonote")).unwrap();
        std::fs::write(&app, "{}").unwrap();
        // a vault file from before: nothing set is lost
        std::fs::write(vault_file(&a), r#"{"accent":"rose","webHistoryNever":["never.example"],"pwNever":["bank.example"],"webZoomHosts":{"zoom.example":1.5},"playerBTabs":[{"path":"https://tab.example/"}]}"#).unwrap();
        let s = load(&app, &a);
        assert_eq!(s["webHistoryNever"][0], "never.example");
        assert_eq!(s["pwNever"][0], "bank.example");
        save(&app, &a, &s).unwrap();
        let body = std::fs::read_to_string(vault_file(&a)).unwrap();
        for word in ["never.example", "bank.example", "zoom.example", "tab.example"] { assert!(!body.contains(word), "{word} in the vault: {body}"); }
        assert_eq!(load(&app, &a)["webZoomHosts"]["zoom.example"], 1.5);
    }

    #[test]
    fn state_lives_in_its_own_file_and_the_preferences_are_left_alone() {
        let d = tmp();
        let app = d.join("app.json");
        let a = d.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(&app, "{}").unwrap();
        save(&app, &a, &json!({ "accent": "rose", "spaces": [1], "webHistory": ["x"] })).unwrap();
        let prefs = vault_file(&a);
        assert!(read(&prefs).unwrap().get("spaces").is_none());
        assert_eq!(read(&state_file(&prefs)).unwrap()["spaces"], json!([1]));
        let before = std::fs::metadata(&prefs).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        save(&app, &a, &json!({ "accent": "rose", "spaces": [2], "webHistory": ["x"] })).unwrap();
        assert_eq!(std::fs::metadata(&prefs).unwrap().modified().unwrap(), before, "only state changed: the preferences file is not rewritten");
        let m = load(&app, &a);
        assert_eq!(m["spaces"], json!([2]));
        assert_eq!(m["accent"], "rose");
    }

    #[test]
    fn the_version_on_disk_is_kept_before_a_change_and_rate_limited() {
        let d = tmp();
        let app = d.join("app.json");
        std::fs::write(&app, "{}").unwrap();
        save(&app, Path::new(""), &json!({ "settingsInVault": false, "accent": "rose" })).unwrap();
        save(&app, Path::new(""), &json!({ "settingsInVault": false, "accent": "mint" })).unwrap();
        save(&app, Path::new(""), &json!({ "settingsInVault": false, "accent": "sky" })).unwrap();
        let hist = d.join("history").join("settings");
        let kept: Vec<PathBuf> = std::fs::read_dir(&hist).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(kept.len(), 1, "within ten minutes only the first previous version is kept");
        assert!(kept[0].file_name().unwrap().to_str().unwrap().starts_with("app "));
        assert!(!std::fs::read_to_string(&kept[0]).unwrap().contains("accent"), "the kept file is what was on disk before the first change");
    }

    #[test]
    fn switched_off_everything_goes_back_to_app_json() {
        let d = tmp();
        let app = d.join("app.json");
        let a = d.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(&app, "{}").unwrap();
        save(&app, &a, &json!({ "settingsInVault": false, "accent": "rose" })).unwrap();
        assert_eq!(read(&app).unwrap()["accent"], "rose");
        assert!(!vault_file(&a).exists());
        assert_eq!(load(&app, &a)["accent"], "rose");
    }
}
