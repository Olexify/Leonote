//! What agents may do with the notes, and their edits as proposals.
//!
//! Every note has an AI access, found the first way that says:
//!   1. its own front matter, `ai: private | review | open`
//!   2. the deepest folder given one (ai-access.json, set from the tree's menu)
//!   3. the default (ai-access.json, "review" unless changed)
//! private - agents neither see it in lists and searches nor read or write it
//! review  - an agent's write becomes a proposal the user accepts or rejects
//! open    - an agent writes it straight away (the old text kept, as always)
//!
//! Proposals are files in <data dir>/proposals/<id>.json, written by the MCP
//! server and read by the app; once decided they move to proposals/done/ and
//! a line goes to proposals/log.jsonl - who proposed what, and what became of it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access { Private, Review, Open }

impl Access {
    pub fn parse(s: &str) -> Option<Access> {
        match s.trim().to_ascii_lowercase().as_str() {
            "private" | "personal" | "no" | "none" | "false" => Some(Access::Private),
            "review" | "propose" | "ask" => Some(Access::Review),
            "open" | "yes" | "write" | "true" => Some(Access::Open),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str { match self { Access::Private => "private", Access::Review => "review", Access::Open => "open" } }
}

pub fn access_file(dir: &Path) -> PathBuf { dir.join("ai-access.json") }
pub fn proposals_dir(dir: &Path) -> PathBuf { dir.join("proposals") }

/// The rules as stored: { "default": "review", "folders": { "Diary": "private" } }.
/// No file yet is the default. A file that cannot be read or understood may hold private folders nobody can see
/// now: everything is kept from agents until it reads again, and nothing is saved over it (rules_to_change).
pub fn read_rules(dir: &Path) -> Value {
    let unreadable = || json!({ "default": "private", "folders": {}, "unreadable": true });
    match std::fs::read_to_string(access_file(dir)) {
        Ok(s) => serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok().filter(|v| v.is_object()).unwrap_or_else(unreadable),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({ "default": "review", "folders": {} }),
        Err(_) => unreadable(),
    }
}

/// The rules, to change and save - refused while the file cannot be read, so its rules are not lost.
fn rules_to_change(dir: &Path) -> Result<Value, String> {
    let rules = read_rules(dir);
    if rules.get("unreadable").is_some() { return Err("Leonote cannot read its AI access settings (ai-access.json) right now, so nothing was changed. Agents are kept out until it can.".into()); }
    Ok(rules)
}

/// A folder path after `from` became `to`, if it is that folder or inside it. Names on Windows ignore case.
fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    let (p, f) = (path.trim_matches('/').to_lowercase(), from.trim_matches('/').to_lowercase());
    if p != f && !p.starts_with(&format!("{}/", f)) { return None; }
    let rest: String = path.trim_matches('/').chars().skip(from.trim_matches('/').chars().count()).collect();
    Some(format!("{}{}", to.trim_matches('/'), rest))
}

/// A folder copied (Duplicate, copy and paste, a restore under a new name): the copy gets the same AI access as
/// the source, and so do the folders inside it - a private folder's copy is just as private. The source keeps its own.
pub fn copy_folder(dir: &Path, from: &str, to: &str) -> Result<(), String> {
    let rules = read_rules(dir);
    // judged by the folder rules as they are, without full access
    let mut base = rules.clone();
    if let Some(o) = base.as_object_mut() { o.remove("full"); }
    let mut copied: Vec<(String, Value)> = rules.get("folders").and_then(|v| v.as_object())
        .map(|f| f.iter().filter_map(|(k, v)| moved_path(k, from, to).map(|n| (n, v.clone()))).collect()).unwrap_or_default();
    // the source's own access counts too when it only has it from a folder it lies in ("Journal/2025" in a private
    // "Journal"): the copy keeps it wherever it lands
    let low = from.trim_matches('/').to_lowercase();
    let in_ruled = rules.get("folders").and_then(|v| v.as_object()).is_some_and(|f| f.keys().any(|k| low.starts_with(&format!("{}/", k.trim_matches('/').to_lowercase()))));
    // only access set on a folder it lies in, not the default "review": a plain folder copied into an open one is
    // open there. Private always goes with it, a private default too: a copy never opens what was kept from agents
    let src = access_of(&base, &format!("{from}/x.md"), None);
    if (in_ruled || src == Access::Private) && !copied.iter().any(|(n, _)| n.eq_ignore_ascii_case(to)) {
        copied.push((to.to_string(), Value::String(src.name().into())));
    }
    // a copied rule only ever makes the copy stricter than where it now lies: an "open" folder copied into a private
    // one stays private
    let strict = |a: Access| match a { Access::Private => 2, Access::Review => 1, Access::Open => 0 };
    let tighter: Vec<(String, Value)> = copied.into_iter().filter(|(new, v)| {
        let Some(want) = v.as_str().and_then(Access::parse) else { return false };
        strict(want) > strict(access_of(&base, &format!("{new}/x.md"), None))
    }).collect();
    if tighter.is_empty() { return Ok(()); }
    let mut rules = rules_to_change(dir)?;
    let Some(o) = rules.as_object_mut() else { return Ok(()) };
    let Some(folders) = o.entry("folders").or_insert_with(|| Value::Object(Default::default())).as_object_mut() else { return Ok(()) };
    for (new, v) in tighter { folders.insert(new, v); }
    save_rules(dir, &rules)
}

/// A folder renamed or moved: the AI access set on it, and on the folders inside it, goes with it.
pub fn move_folder(dir: &Path, from: &str, to: &str) -> Result<(), String> {
    let mut rules = rules_to_change(dir)?;
    let Some(folders) = rules.get_mut("folders").and_then(|v| v.as_object_mut()) else { return Ok(()) };
    let moved: Vec<(String, String)> = folders.keys().filter_map(|k| moved_path(k, from, to).map(|n| (k.clone(), n))).collect();
    if moved.is_empty() { return Ok(()); }
    for (old, new) in moved {
        if let Some(v) = folders.remove(&old) { folders.insert(new, v); }
    }
    save_rules(dir, &rules)
}

/// Tasks split between the user and AI (`"tasks": "split"`): agents see and change only
/// the tasks given to AI (`owner: "ai"`); the user's own stay out of their reach.
pub fn tasks_split(dir: &Path) -> bool {
    let rules = read_rules(dir);
    rules.get("unreadable").is_some() || rules.get("tasks").and_then(|v| v.as_str()) == Some("split")
}

fn save_rules(dir: &Path, rules: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = access_file(dir).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(rules).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, access_file(dir)).map_err(|e| e.to_string())
}

/// Full access for agents (`"full": true`): every note is open to them, whatever the
/// folders say; a note's own `ai: private` still keeps it out.
#[tauri::command]
pub async fn ai_full_set(full: bool, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let dir = &state.paths.dir;
    let mut rules = rules_to_change(dir)?;
    if full { rules["full"] = json!(true); } else if let Some(o) = rules.as_object_mut() { o.remove("full"); }
    save_rules(dir, &rules)?;
    Ok(rules)
}

/// Split the tasks between the user and AI, or not.
#[tauri::command]
pub async fn ai_tasks_set(split: bool, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let dir = &state.paths.dir;
    let mut rules = rules_to_change(dir)?;
    if split { rules["tasks"] = json!("split"); } else if let Some(o) = rules.as_object_mut() { o.remove("tasks"); }
    save_rules(dir, &rules)?;
    Ok(rules)
}

/// A note's header (front matter) - `---` to `---`, the line ends after it too - if it starts with one.
fn header_of(text: &str) -> Option<&str> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text.strip_prefix("---")?;
    let first = if rest.starts_with("\r\n") { 5 } else if rest.starts_with('\n') { 4 } else { return None };
    let mut at = first;
    for line in text[first..].split_inclusive('\n') {
        at += line.len();
        let l = line.trim();
        if l == "---" || l == "..." { return Some(&text[..at]); }
    }
    None
}

/// An agent's whole new text for a note that has a header (its id, its tags, its ai: line) but came
/// without one: the header stays on. Agents rewrite the words; the header is Leonote's and the user's.
pub fn keep_header(old: &str, new: &str) -> String {
    match (header_of(old), header_of(new)) {
        (Some(h), None) => format!("{}{}{}", h, if h.ends_with('\n') { "" } else { "\n" }, new.trim_start_matches(['\r', '\n'])),
        _ => new.to_string(),
    }
}

/// `ai:` in a note's front matter, if it has one. The same rules as web/proposals.js frontAccess (both tested
/// against ACCESS_CASES): a byte-order mark before it is passed over, the key is `ai` in any case, with or without
/// spaces before the colon, quotes and a trailing `# comment` are dropped, and a value that is none of the known
/// words counts as private - a note that says something about AI is kept out rather than
/// let in by a word nobody here understood.
pub fn front_access(text: &str) -> Option<Access> {
    let rest = text.strip_prefix('\u{feff}').unwrap_or(text).strip_prefix("---")?;
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n'))?;
    for line in rest.lines() {
        let l = line.trim();
        if l == "---" || l == "..." { break; }
        let Some((k, v)) = l.split_once(':') else { continue };
        if !k.trim().eq_ignore_ascii_case("ai") { continue; }
        let v = match v.char_indices().find(|&(i, c)| c == '#' && (i == 0 || v[..i].ends_with(char::is_whitespace))) { Some((i, _)) => &v[..i], None => v };
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        if v.is_empty() { return None; }
        return Some(Access::parse(v).unwrap_or(Access::Private));
    }
    None
}

/// The access of a note at `rel` (vault-relative, forward slashes), its text if it has one.
pub fn access_of(rules: &Value, rel: &str, text: Option<&str>) -> Access {
    if let Some(a) = text.and_then(front_access) { return a; }
    // full access: every note open to agents - only a note's own `ai:` line still says otherwise
    if rules.get("full").and_then(|v| v.as_bool()) == Some(true) { return Access::Open; }
    // Windows names are not case-sensitive: "private/x.md" is in the folder "Private"
    let rel = rel.replace('\\', "/").to_lowercase();
    let mut best: Option<(usize, Access)> = None;
    if let Some(f) = rules.get("folders").and_then(|v| v.as_object()) {
        for (folder, v) in f {
            let folder = folder.trim_matches('/').to_lowercase();
            let inside = folder.is_empty() || rel.starts_with(&format!("{}/", folder));
            if !inside { continue; }
            if let Some(a) = v.as_str().and_then(Access::parse) {
                if best.map(|(n, _)| folder.len() >= n).unwrap_or(true) { best = Some((folder.len(), a)); }
            }
        }
    }
    best.map(|b| b.1).unwrap_or_else(|| rules.get("default").and_then(|v| v.as_str()).and_then(Access::parse).unwrap_or(Access::Review))
}

/// FNV-1a of the text: enough to tell "the note changed since the agent read it".
pub fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{:016x}", h)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Proposal {
    pub id: String,
    pub at: String,
    pub agent: String,
    /// "write" (the whole text) or "append"
    pub kind: String,
    pub path: String,
    /// the note's text when the agent wrote, hashed; None when there was no note
    pub base: Option<String>,
    /// the text the note would have
    pub content: String,
    /// the note's text as the agent read it: what lets its changes go in on top of what the user
    /// wrote since, instead of over it (proposals made before it was kept have none)
    #[serde(default)]
    pub base_text: Option<String>,
    #[serde(default)]
    pub why: String,
}

/// A note path as the vault knows it - the same check as the MCP tools': inside the vault, a .md,
/// no drive letters or absolute paths, no "..", nothing hidden. Anything else is refused.
pub fn safe_rel(vault: &Path, path: &str) -> Result<String, String> {
    let full = crate::mcp::note_path(vault, path)?;
    let rel = full.strip_prefix(vault).map_err(|_| "not a note of the vault".to_string())?.to_string_lossy().replace('\\', "/");
    // an outside file open in Leonote has a name like a path: accepting would write it, unasked
    if crate::vault::is_guest(&rel) { return Err("not a note of the vault".into()); }
    Ok(rel)
}

pub fn new_id() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", t)
}

/// Keep a proposal for the user to decide on.
pub fn propose(dir: &Path, p: &Proposal) -> Result<(), String> {
    let d = proposals_dir(dir);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let tmp = d.join(format!("{}.json.tmp", p.id));
    std::fs::write(&tmp, serde_json::to_vec_pretty(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, d.join(format!("{}.json", p.id))).map_err(|e| e.to_string())
}

/// The proposals waiting, oldest first.
pub fn waiting(dir: &Path) -> Vec<Proposal> {
    let mut out: Vec<Proposal> = std::fs::read_dir(proposals_dir(dir)).into_iter().flatten().flatten()
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok().and_then(|s| serde_json::from_str(&s).ok()))
        .collect();
    out.sort_by(|a: &Proposal, b: &Proposal| a.id.cmp(&b.id));
    out
}

/// A proposal decided: out of the waiting ones, into done/, and onto the log.
pub fn settle(dir: &Path, id: &str, outcome: &str) -> Result<Proposal, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) { return Err("not a proposal".into()); }
    let d = proposals_dir(dir);
    let f = d.join(format!("{}.json", id));
    let p: Proposal = serde_json::from_str(&std::fs::read_to_string(&f).map_err(|_| "that proposal is gone - already decided?".to_string())?).map_err(|e| e.to_string())?;
    let done = d.join("done");
    std::fs::create_dir_all(&done).map_err(|e| e.to_string())?;
    std::fs::rename(&f, done.join(format!("{}.json", id))).map_err(|e| e.to_string())?;
    let line = json!({ "id": p.id, "agent": p.agent, "path": p.path, "kind": p.kind, "outcome": outcome, "proposed": p.at, "decided": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string() });
    use std::io::Write;
    if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(d.join("log.jsonl")) { let _ = writeln!(log, "{}", line); }
    Ok(p)
}

/* ── the app's side ───────────────────────────────────────────────────── */

/// The waiting proposals, each with the note's text now and whether it changed since.
#[tauri::command]
pub async fn proposals_list(state: tauri::State<'_, crate::AppState>) -> Result<Vec<Value>, String> {
    let paths = &state.paths;
    // a proposal file is only data: a path that is not a note of the vault is not read (a \\host name would sign in to it)
    Ok(waiting(&paths.dir).into_iter().filter_map(|p| safe_rel(&paths.vault, &p.path).ok().map(|rel| (p, rel))).map(|(p, rel)| {
        let now = std::fs::read_to_string(paths.vault.join(&rel)).ok();
        let changed = match (&p.base, &now) { (Some(b), Some(n)) => &hash(n) != b, (None, Some(_)) => true, (Some(_), None) => true, (None, None) => false };
        json!({ "id": p.id, "at": p.at, "agent": p.agent, "kind": p.kind, "path": p.path, "why": p.why, "content": p.content, "now": now, "changed": changed, "base_text": p.base_text })
    }).collect())
}

/// How many wait - asked when the file watcher says the folder changed.
#[tauri::command]
pub async fn proposals_count(state: tauri::State<'_, crate::AppState>) -> Result<usize, String> {
    Ok(std::fs::read_dir(proposals_dir(&state.paths.dir)).into_iter().flatten().flatten().filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false)).count())
}

/// A proposal accepted: its text is written first and settled only then - a write that fails leaves it waiting.
fn accept(dir: &Path, vault: &Path, id: &str, merged: Option<&str>, write: impl FnOnce(&str, &str) -> Result<(), String>) -> Result<String, String> {
    // a proposal file is only data (anything can drop one in the folder): its path is checked
    // again before anything is written, and a bad one is refused without being settled
    let p = waiting(dir).into_iter().find(|x| x.id == id).ok_or("that proposal is gone - already decided?")?;
    let rel = safe_rel(vault, &p.path)?;
    // made before agents' texts kept the header: it is kept now
    let now = crate::mcp::old_text(&vault.join(&rel))?.unwrap_or_default();
    // the note changed after the agent read it: the app merged the agent's changes into it (`merged`)
    write(&rel, &keep_header(&now, merged.unwrap_or(&p.content)))?;
    settle(dir, id, "accepted")?;
    Ok(rel)
}

/// A video project is no note: written whole, the one it replaces kept in the trash.
fn write_project(vault: &Path, rel: &str, text: &str, stamp: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(text).map_err(|_| "This edit no longer fits the video project, so nothing was changed. Reject it and ask again.".to_string())?;
    let abs = vault.join(rel);
    if abs.is_file() { crate::vault::backup_file(vault, rel, stamp)?; }
    crate::vault::write_atomic(&abs, text.as_bytes()).map_err(|e| format!("write {}: {}", rel, e))
}

/// Accepted: its text goes in through the app's own write - the note's earlier text kept in its history like any edit.
#[tauri::command]
pub async fn proposal_accept(id: String, merged: Option<String>, state: tauri::State<'_, crate::AppState>) -> Result<String, String> {
    accept(&state.paths.dir, &state.paths.vault, &id, merged.as_deref(), |rel, text| {
        if rel.to_ascii_lowercase().ends_with(".leovideo") {
            let _io = crate::lock(&state.io);
            write_project(&state.paths.vault, rel, text, &crate::trash_stamp())
        } else {
            crate::note_write_inner(rel, text, &state).map(|_| ())
        }
    })
}

#[tauri::command]
pub async fn proposal_reject(id: String, state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    settle(&state.paths.dir, &id, "rejected").map(|_| ())
}

/// A proposal made from inside the app - a skill's write to a note in review.
#[tauri::command]
pub async fn proposal_make(path: String, content: String, kind: String, agent: String, why: String, state: tauri::State<'_, crate::AppState>) -> Result<String, String> {
    let rel = safe_rel(&state.paths.vault, &path)?;
    // a proposal that big could never be accepted (the note would be over 64 MB): it would only wait forever
    if content.len() as u64 > crate::vault::MAX_NOTE { return Err(format!("that would make {rel} over {} MB - too big for a note", crate::vault::MAX_NOTE >> 20)); }
    let old = crate::mcp::old_text(&state.paths.vault.join(&rel))?;
    let p = Proposal { id: new_id(), at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(), agent: agent.chars().take(140).collect(), kind, path: rel, base: old.as_deref().map(hash), content: keep_header(old.as_deref().unwrap_or(""), &content), why: why.chars().take(500).collect(), base_text: old.clone() };
    propose(&state.paths.dir, &p)?;
    Ok(p.id)
}

#[tauri::command]
pub async fn ai_access_get(state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    Ok(read_rules(&state.paths.dir))
}

/// `folder` "" with `mode` sets the default; a folder with null mode lets it inherit again.
#[tauri::command]
pub async fn ai_access_set(folder: Option<String>, mode: Option<String>, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let dir = &state.paths.dir;
    let mut rules = rules_to_change(dir)?;
    let mode = mode.and_then(|m| Access::parse(&m)).map(|a| a.name());
    match folder.map(|f| f.trim().trim_matches('/').replace('\\', "/")).filter(|f| !f.is_empty()) {
        None => { rules["default"] = json!(mode.unwrap_or("review")); }
        Some(f) => {
            if !rules.get("folders").map(|v| v.is_object()).unwrap_or(false) { rules["folders"] = json!({}); }
            let folders = rules["folders"].as_object_mut().unwrap();
            match mode { Some(m) => { folders.insert(f, json!(m)); } None => { folders.remove(&f); } }
        }
    }
    save_rules(dir, &rules)?;
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_says_first_then_the_deepest_folder_then_the_default() {
        let rules = json!({ "default": "review", "folders": { "Diary": "private", "Diary/Shared": "open", "Projects": "open" } });
        assert_eq!(access_of(&rules, "Diary/2026.md", None), Access::Private);
        assert_eq!(access_of(&rules, "Diary/Shared/plan.md", None), Access::Open);
        assert_eq!(access_of(&rules, "Ideas/x.md", None), Access::Review);
        assert_eq!(access_of(&rules, "Projects/x.md", Some("---\nai: private\n---\nhi")), Access::Private);
        assert_eq!(access_of(&rules, "diary/2026.md", None), Access::Private, "Windows names are not case-sensitive");
        assert_eq!(access_of(&rules, "Diaryish/x.md", None), Access::Review, "a folder whose name only begins the same is another folder");
        assert_eq!(access_of(&json!({}), "a.md", None), Access::Review, "no rules: review");
    }

    #[test]
    fn full_access_opens_every_folder_but_not_a_note_that_says_private() {
        let rules = json!({ "default": "private", "folders": { "Diary": "private" }, "full": true });
        assert_eq!(access_of(&rules, "Diary/2026.md", None), Access::Open);
        assert_eq!(access_of(&rules, "a.md", None), Access::Open);
        assert_eq!(access_of(&rules, "Keys.md", Some("---\nai: private\n---\nsk-")), Access::Private);
    }

    #[test]
    fn rules_that_cannot_be_read_keep_agents_out_and_are_not_saved_over() {
        let d = std::env::temp_dir().join(format!("leo-rules-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(access_of(&read_rules(&d), "a.md", None), Access::Review, "no file yet: the default");
        assert!(!tasks_split(&d));
        for bad in ["{\"folders\":{\"Diary\":\"pri", "[]", ""] {
            std::fs::write(access_file(&d), bad).unwrap();
            assert_eq!(access_of(&read_rules(&d), "a.md", None), Access::Private, "{bad:?}");
            assert!(tasks_split(&d));
            assert!(rules_to_change(&d).is_err() && move_folder(&d, "a", "b").is_err());
            assert_eq!(std::fs::read_to_string(access_file(&d)).unwrap(), bad);
        }
        std::fs::write(access_file(&d), "\u{feff}{\"default\":\"open\"}").unwrap();
        assert_eq!(access_of(&read_rules(&d), "a.md", None), Access::Open, "a byte-order mark is no damage");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_copy_of_a_private_folder_is_private_too() {
        let d = std::env::temp_dir().join(format!("leo-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        copy_folder(&d, "Private", "Private 2").unwrap();
        assert!(!access_file(&d).exists(), "no rules, nothing to save");
        std::fs::write(access_file(&d), r#"{"default":"open","folders":{"Private":"private","Private/Shared":"review"}}"#).unwrap();
        copy_folder(&d, "Private", "Private 2").unwrap();
        let r = read_rules(&d);
        assert_eq!(access_of(&r, "Private 2/secret.md", None), Access::Private);
        assert_eq!(access_of(&r, "Private 2/Shared/x.md", None), Access::Review);
        assert_eq!(access_of(&r, "Private/secret.md", None), Access::Private, "the source keeps its own");
        // an open folder copied into a private one does not open a hole in it
        std::fs::write(access_file(&d), r#"{"default":"review","folders":{"Vault":"private","Shared":"open"}}"#).unwrap();
        copy_folder(&d, "Shared", "Vault/Shared").unwrap();
        assert_eq!(access_of(&read_rules(&d), "Vault/Shared/x.md", None), Access::Private);
        // a folder private only because it lies in a private one stays private when copied out of it
        std::fs::write(access_file(&d), r#"{"default":"review","folders":{"Journal":"private"}}"#).unwrap();
        copy_folder(&d, "Journal/2025", "2025").unwrap();
        assert_eq!(access_of(&read_rules(&d), "2025/x.md", None), Access::Private);
        // a plain folder (the default's) copied into an open one is open there, as anything put there is
        std::fs::write(access_file(&d), r#"{"default":"review","folders":{"Shared":"open"}}"#).unwrap();
        copy_folder(&d, "Plain", "Shared/Plain").unwrap();
        assert_eq!(access_of(&read_rules(&d), "Shared/Plain/x.md", None), Access::Open);
        // but with everything private by default, the copy stays private even in an open folder
        std::fs::write(access_file(&d), r#"{"default":"private","folders":{"Shared":"open"}}"#).unwrap();
        copy_folder(&d, "Plain", "Shared/Plain").unwrap();
        assert_eq!(access_of(&read_rules(&d), "Shared/Plain/x.md", None), Access::Private);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_folders_access_goes_with_it_when_it_moves() {
        let d = std::env::temp_dir().join(format!("leo-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        move_folder(&d, "Diary", "Journal").unwrap();
        assert!(!access_file(&d).exists(), "no rules, nothing to save");
        std::fs::write(access_file(&d), r#"{"default":"open","folders":{"Diary":"private","Diary/Shared":"review","Diaryish":"review"}}"#).unwrap();
        move_folder(&d, "diary", "Old/Journal").unwrap();
        let r = read_rules(&d);
        assert_eq!(access_of(&r, "Old/Journal/x.md", None), Access::Private);
        assert_eq!(access_of(&r, "Old/Journal/Shared/x.md", None), Access::Review);
        assert_eq!(access_of(&r, "Diaryish/x.md", None), Access::Review, "a folder whose name only begins the same stays");
        assert!(r["folders"].get("Diary").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_proposal_stays_waiting_until_its_text_is_in() {
        let root = std::env::temp_dir().join(format!("leo-accept-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (d, v) = (root.join("data"), root.join("vault"));
        std::fs::create_dir_all(&v).unwrap();
        std::fs::write(v.join("a.leovideo"), "{\"clips\":[1]}").unwrap();
        let p = Proposal { id: "abc".into(), at: "2026-10-02T10:00:00".into(), agent: "claude".into(), kind: "write".into(), path: "a.leovideo".into(), base: None, content: "{\"clips\":[]}".into(), why: String::new(), base_text: None };
        propose(&d, &p).unwrap();
        assert!(accept(&d, &v, "abc", None, |_, _| Err("locked".into())).is_err());
        assert_eq!(waiting(&d).len(), 1, "a write that failed leaves it to decide on");
        assert!(accept(&d, &v, "abc", Some("{ not json"), |r, t| write_project(&v, r, t, "2026-10-02 100000")).is_err());
        assert_eq!(std::fs::read_to_string(v.join("a.leovideo")).unwrap(), "{\"clips\":[1]}", "a broken project is not written");
        // what cannot be read as text is not taken for an empty note
        std::fs::write(v.join("a.leovideo"), [0xff, 0xfe]).unwrap();
        assert!(accept(&d, &v, "abc", None, |_, _| panic!("must not write")).is_err());
        std::fs::write(v.join("a.leovideo"), "{\"clips\":[1]}").unwrap();
        accept(&d, &v, "abc", None, |r, t| write_project(&v, r, t, "2026-10-02 100000")).unwrap();
        assert_eq!(std::fs::read_to_string(v.join("a.leovideo")).unwrap(), "{\"clips\":[]}");
        assert!(waiting(&d).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_agents_text_keeps_the_notes_header() {
        let old = "---\nid: abc\ntags: [a]\n---\nOld words\n";
        assert_eq!(keep_header(old, "New words\n"), "---\nid: abc\ntags: [a]\n---\nNew words\n");
        // its own header wins; a note without one gets none
        assert_eq!(keep_header(old, "---\nid: x\n---\nB"), "---\nid: x\n---\nB");
        assert_eq!(keep_header("plain", "New"), "New");
        assert_eq!(keep_header("\u{feff}---\nai: private\n---\nOld", "New"), "---\nai: private\n---\nNew", "a byte-order mark does not cost the header");
    }

    #[test]
    fn front_matter_is_read_only_at_the_top() {
        assert_eq!(front_access("---\ntitle: x\nai: open\n---\n"), Some(Access::Open));
        assert_eq!(front_access("ai: open\n"), None);
        assert_eq!(front_access("---\ntitle: x\n---\nai: open"), None);
    }

    #[test]
    fn the_app_and_the_agents_read_ai_lines_alike() {
        // the very cases web/tests/proposals.test.js checks frontAccess against
        let cases: Vec<(String, Option<String>)> = serde_json::from_str(include_str!("../../web/tests/ai_access_cases.json")).unwrap();
        for (text, want) in cases { assert_eq!(front_access(&text).map(|a| a.name().to_string()), want, "{text:?}"); }
    }

    #[test]
    fn a_proposal_waits_until_it_is_settled_once() {
        let d = std::env::temp_dir().join(format!("leo-prop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = Proposal { id: new_id(), at: "2026-10-02T10:00:00".into(), agent: "claude".into(), kind: "write".into(), path: "a.md".into(), base: None, content: "new".into(), why: String::new(), base_text: None };
        propose(&d, &p).unwrap();
        assert_eq!(waiting(&d).len(), 1);
        assert_eq!(settle(&d, &p.id, "rejected").unwrap().content, "new");
        assert!(waiting(&d).is_empty());
        assert!(settle(&d, &p.id, "accepted").is_err(), "a decided proposal cannot be decided again");
        assert!(settle(&d, "../x", "accepted").is_err());
        assert!(std::fs::read_to_string(d.join("proposals").join("log.jsonl")).unwrap().contains("\"rejected\""));
        // nothing outside the vault, however it is spelled
        let v = Path::new("V");
        // (a network path loses its leading slashes and lands inside the vault: server/share/x.md)
        assert_eq!(safe_rel(v, "\\\\server\\share\\x").unwrap(), "server/share/x.md");
        for bad in ["C:/Windows/x", "C:\\x.md", "/C:/x", "../x", "a/../../x", ".trash/x", "a:b", ""] {
            assert!(safe_rel(v, bad).is_err(), "{:?} must be refused", bad);
        }
        assert_eq!(safe_rel(v, "Ideas/plan").unwrap(), "Ideas/plan.md");
        assert_eq!(safe_rel(v, "/Ideas\\plan.md").unwrap(), "Ideas/plan.md");
        let _ = std::fs::remove_dir_all(&d);
    }
}
