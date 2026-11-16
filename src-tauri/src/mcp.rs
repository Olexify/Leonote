//! `leonote-rs.exe --mcp`: Leonote as a Model Context Protocol server, on
//! stdin and stdout, for any agent that speaks MCP - Claude Desktop, Claude
//! Code, Cursor, a local Hermes agent.
//!
//! It is the agent contract (AGENTS.md) behind a tool interface and nothing
//! more: notes are files in the vault, written whole by temp-then-rename, and
//! tasks are lines appended to this writer's own log. The running app sees
//! every change the way it sees any other agent's, live. No window opens, no
//! network is touched, and nothing outside the vault and the task log is ever
//! read or written.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

const WRITER: &str = "mcp";

/// Who is on the other end - the name its client gave at the start - for the proposals it makes.
static AGENT: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
fn agent_name() -> String { let a = AGENT.lock().map(|g| g.clone()).unwrap_or_default(); if a.is_empty() { "an agent".into() } else { a } }

/// A note's AI access (proposals.rs): private ones are not shown, read or written.
/// A media file a video project names (a clip's file, one an edit lays over): a file in the vault, and not in a
/// private place - else an agent could have any file on the computer, or a private recording, heard and read back.
pub(crate) fn media_ok(ctx: &Ctx, rel: &str) -> bool {
    let Ok(p) = vault_path(&ctx.vault, rel) else { return false };
    p.is_file() && access(ctx, &rel_of(&ctx.vault, &p), None) != crate::proposals::Access::Private
}

fn access(ctx: &Ctx, rel: &str, text: Option<&str>) -> crate::proposals::Access {
    // a folder kept out of the index is kept from agents too, even by a path they know
    if crate::vault::not_indexed(rel) { return crate::proposals::Access::Private; }
    // judged by its real name: on a drive with short names, TRASH~1 passes vault_path and is .trash
    if rel.split('/').any(|p| p.starts_with('.')) { return crate::proposals::Access::Private; }
    // Leonote's own data, when it lies in the vault: the kept versions of every note, private ones too
    if let (Ok(v), Ok(d)) = (ctx.vault.canonicalize(), ctx.dir.canonicalize()) { if v.join(rel).starts_with(d) { return crate::proposals::Access::Private; } }
    crate::proposals::access_of(&crate::proposals::read_rules(&ctx.dir), rel, text)
}
const PRIVATE: &str = "This note is private: the user keeps it from agents. Leave it alone.";
/// A video project changes by video_edit, whose edits are checked and listed for the user - not as text.
fn not_a_video(p: &Path) -> Result<(), String> {
    if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("leovideo")) { return Err("This is a video project: use video_edit to change it.".into()); }
    Ok(())
}

/// A write as the note's access allows: straight in (open), or a proposal for the user (review).
fn write_or_propose(ctx: &Ctx, p: &Path, old: Option<&str>, content: &str, kind: &str, why: &str) -> Result<String, String> {
    use crate::proposals::{Access, Proposal};
    let rel = rel_of(&ctx.vault, p);
    // a note the app would not read back (over 64 MB) would drop out of it, and a proposal that size is loaded whole
    if content.len() as u64 > crate::vault::MAX_NOTE { return Err(format!("that would make {rel} over {} MB - too big for a note", crate::vault::MAX_NOTE >> 20)); }
    match access(ctx, &rel, old) {
        Access::Private => Err(PRIVATE.into()),
        Access::Open => {
            // the line outlasts the access that wrote it, and it outranks the folder: only the user sets it (in review they see it)
            if crate::proposals::front_access(content) != old.and_then(crate::proposals::front_access) { return Err("The ai: line is the user's - change the note without it".into()); }
            if kind == "write" { keep_old(&ctx.vault, &rel, p)?; }
            write_whole(p, content)?;
            Ok(format!("{} {}", if kind == "append" { "Added to" } else if old.is_some() { "Replaced" } else { "Created" }, rel))
        }
        Access::Review => {
            let pr = Proposal { id: crate::proposals::new_id(), at: now()[..19].to_string(), agent: agent_name(), kind: kind.into(), path: rel.clone(), base: old.map(crate::proposals::hash), content: content.into(), why: why.trim().chars().take(2000).collect(), base_text: old.map(String::from) };
            crate::proposals::propose(&ctx.dir, &pr)?;
            Ok(format!("Proposed: the change to {} waits for the user to accept or reject it in Leonote (proposal {}). It is not in the note yet - do not write it again.", rel, pr.id))
        }
    }
}
/// What a note holds now, None when there is no note yet. One that cannot be read as text (not UTF-8) is an error:
/// taken as empty, an append would replace all of it.
pub(crate) fn old_text(p: &Path) -> Result<Option<String>, String> {
    // the app itself does not read a note this big: an agent neither (it would be handed all of it)
    if std::fs::metadata(p).is_ok_and(|m| m.len() > crate::vault::MAX_NOTE) {
        return Err(format!("this note is over {} MB - too big to read or change here", crate::vault::MAX_NOTE >> 20));
    }
    match std::fs::read_to_string(p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("this note cannot be read as text, so it was left alone: {}", e)),
    }
}
const PROTOCOL: &str = "2025-06-18";

pub struct Ctx {
    pub vault: PathBuf,
    /// where `log/` lives
    pub dir: PathBuf,
    pub snapshot: PathBuf,
}

/// A path an agent gave, made safe: inside the vault, a note, not hidden.
pub fn note_path(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        return Err("a note path is needed, like \"Ideas/New idea.md\"".into());
    }
    let low = rel.to_ascii_lowercase();
    let rel = if low.ends_with(".md") || low.ends_with(".leovideo") { rel.to_string() } else { format!("{}.md", rel) };
    vault_path(vault, &rel)
}

/// Any file's path inside the vault (a note's, or a picture or sound a video project names): every part an
/// ordinary name, and where it really is - links followed - still inside the vault.
pub fn vault_path(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() { return Err("a path is needed".into()); }
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.starts_with('.') {
            return Err(format!("\"{}\" is not a path inside the vault", rel));
        }
        if part.chars().any(|c| (c as u32) < 32 || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
            return Err(format!("\"{}\" has characters a file name cannot hold", part));
        }
        // Windows drops a trailing dot or space: "Private." would be the folder "Private" under another name
        if part.ends_with('.') || part.ends_with(' ') {
            return Err(format!("\"{}\" cannot end with a dot or a space", part));
        }
        // a device, not a file, whatever follows the dot: NUL.md, com1.txt
        if crate::vault::is_device_name(part.split('.').next().unwrap_or("")) {
            return Err(format!("\"{}\" is a name Windows keeps for a device", part));
        }
    }
    let p = vault.join(rel);
    // where it really is: a junction or link inside the vault may not lead out of it
    if let (Ok(root), Some(real)) = (vault.canonicalize(), real_path(&p)) {
        if !real.starts_with(&root) { return Err(format!("\"{}\" leads outside the vault", rel)); }
    }
    Ok(p)
}

/// A path as it really is on disk - its folders' true names and case, links followed - for the part that exists.
pub(crate) fn real_path(p: &Path) -> Option<PathBuf> {
    let mut have = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !have.exists() { rest.push(have.file_name()?.to_owned()); have = have.parent()?.to_path_buf(); }
    let mut real = have.canonicalize().ok()?;
    for r in rest.iter().rev() { real.push(r); }
    Some(real)
}

/// The vault-relative name of a note as it is on disk - so "private/x.md", or a short 8.3 name, is judged as
/// the real "Private/x.md" it is - with forward slashes.
fn rel_of(vault: &Path, p: &Path) -> String {
    if let (Ok(root), Some(real)) = (vault.canonicalize(), real_path(p)) {
        if let Ok(r) = real.strip_prefix(&root) { return r.to_string_lossy().replace('\\', "/"); }
    }
    p.strip_prefix(vault).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn write_whole(path: &Path, content: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("md.mcp-tmp");
    // made new, never written through: a link left at that name (a synced vault can carry one) would lead the
    // text out of the vault. Whatever is there is taken away first - the link itself, not what it points at
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })?;
    // on the disk before it takes the note's place, as the app's own saves are: a power cut just after the rename
    // would otherwise leave the note empty (an append keeps no old copy)
    f.sync_all().map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })
}

/// The note as it was, kept in .trash before an agent overwrites it - a name of its own each time (two writes in one
/// second kept both), remembered where it came from, and no write when the copy could not be made.
fn keep_old(vault: &Path, rel: &str, path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let now = chrono::Local::now();
    // (not written into the trash's index: this is another process than the app, and the index has no lock - the
    // entry's name carries its date, and a restore puts it beside the note)
    crate::vault::backup_note(vault, rel, &now.format("%Y-%m-%d %H%M%S").to_string())
        .map_err(|e| format!("the note's text could not be kept before replacing it, so it was left as it is: {e}"))?;
    Ok(())
}

fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut a = std::collections::hash_map::RandomState::new().build_hasher();
    a.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let x = a.finish();
    let mut b = std::collections::hash_map::RandomState::new().build_hasher();
    b.write_u64(x ^ std::process::id() as u64);
    let y = b.finish();
    format!("{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}", (x >> 32) as u32, (x >> 16) as u16, (x & 0xfff) as u16, 0x8000 | ((y >> 48) as u16 & 0x3fff), y & 0xffff_ffff_ffff)
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

pub fn tools() -> Value {
    let s = |props: Value, req: &[&str]| json!({ "type": "object", "properties": props, "required": req, "additionalProperties": false });
    json!([
        { "name": "list_notes", "description": "List the notes in the vault (Markdown files), newest first. Give a folder to list only that folder.",
          "inputSchema": s(json!({ "folder": { "type": "string", "description": "e.g. \"Projects\". Omit for the whole vault." }, "limit": { "type": "integer", "description": "default 200" } }), &[]) },
        { "name": "search_notes", "description": "Find notes whose name or text contains every word of the query (case-insensitive). Returns each note with the lines that matched.",
          "inputSchema": s(json!({ "query": { "type": "string" }, "limit": { "type": "integer", "description": "notes to return, default 20" } }), &["query"]) },
        { "name": "read_note", "description": "Read one note. Notes are Markdown; [[Name]] links to another note, #tag is a tag, - [ ] is a checkbox.",
          "inputSchema": s(json!({ "path": { "type": "string", "description": "path inside the vault, e.g. \"Ideas/Agent swarm.md\"" } }), &["path"]) },
        { "name": "write_note", "description": "Create a note, or replace the whole text of an existing one. Depending on the note, the change is made at once (the previous text kept) or proposed for the user to accept in Leonote - the answer says which. Private notes cannot be written.",
          "inputSchema": s(json!({ "path": { "type": "string" }, "content": { "type": "string", "description": "the full Markdown text" }, "why": { "type": "string", "description": "one line for the user: what the change is for" } }), &["path", "content"]) },
        { "name": "append_to_note", "description": "Add text to the end of a note, creating it if it does not exist. Use this for logs, journals and running lists. Daily notes: by default one note a year, \"Diary/YYYY.md\", with a \"# DD.MM.YYYY\" heading for each day (the user can switch to one note a day, \"Diary/YYYY-MM-DD.md\"; list_notes shows which). Made at once or proposed to the user, as with write_note.",
          "inputSchema": s(json!({ "path": { "type": "string" }, "text": { "type": "string" }, "why": { "type": "string", "description": "one line for the user: what the addition is for" } }), &["path", "text"]) },
        { "name": "list_tasks", "description": "The user's tasks. By default only open ones. When the user keeps their own tasks apart, only the tasks they gave to AI are listed (owner: ai).",
          "inputSchema": s(json!({ "include_done": { "type": "boolean" } }), &[]) },
        { "name": "add_task", "description": "Add a task to the user's task list. It is marked as an AI task (owner: ai).",
          "inputSchema": s(json!({ "text": { "type": "string" }, "priority": { "type": "string", "enum": ["low", "medium", "high"] }, "due_date": { "type": "string", "description": "YYYY-MM-DD" } }), &["text"]) },
        { "name": "next_task", "description": "The next task the user gave to AI, to work on now - high priority and nearest due first - and it is marked as being worked on, so no other agent takes it too. When done call complete_task (with a short result); if you cannot do it, give_back_task with the reason. Nothing to do: says so.",
          "inputSchema": s(json!({}), &[]) },
        { "name": "complete_task", "description": "Mark a task done, by its id. For a task you worked on, give a short result - what you did, where it is - the user sees it on the task.",
          "inputSchema": s(json!({ "id": { "type": "string" }, "result": { "type": "string", "description": "one or two sentences: what was done, and where" } }), &["id"]) },
        { "name": "give_back_task", "description": "Hand an AI task back to the user, with why - you could not do it, or it needs them. It becomes theirs again and shows your reason.",
          "inputSchema": s(json!({ "id": { "type": "string" }, "why": { "type": "string" } }), &["id", "why"]) },
        { "name": "video_overview", "description": "Read a Leonote video project (.leovideo) as text: its tracks and clips, and what is said in it word by word as it plays on the timeline - every word with an id (A12: source A, word 12), pauses and cuts marked. Hearing a file the first time takes a while (Whisper, on the user's computer); after that it is instant. Read this before video_edit.",
          "inputSchema": s(json!({ "path": { "type": "string", "description": "the project, like \"Videos/Talk.leovideo\"" } }), &["path"]) },
        { "name": "video_edit", "description": "Change a video project with small edits anchored on word ids from video_overview - never seconds. Leonote turns ids into times and lands every cut in a pause it measured, so no word is clipped; a cut it could not land in a pause is reported. All edits apply or none. Edits: {\"op\":\"cut\",\"from\":\"A12\",\"to\":\"A30\"} takes those words out and closes the gap on every track (music under it plays on, only shorter); {\"op\":\"pause\",\"after\":\"A45\",\"keep\":0.25} shortens the pause after a word; {\"op\":\"captions\",\"style\":\"caption|meme|title\",\"words\":5} captions from the speech as it plays now (replaces earlier ones on the Captions track; do it after cuts); {\"op\":\"add\",\"file\":\"Pictures/x.png\",\"at\":\"A40\",\"to\":\"A52\"} (or \"dur\" seconds) lays a picture, video, GIF, sound or animation from the vault over the timeline from that word; {\"op\":\"set\",\"clip\":\"<id>\",\"volume\":0.3,\"opacity\":1,\"fadeIn\":0.5,\"fadeOut\":0.5,\"zoom\":0.1,\"text\":\"...\",\"transition\":\"fade\"}; {\"op\":\"remove\",\"clip\":\"<id>\"}. Like notes, the change may be made at once or proposed to the user - the answer says which. The answer ends with video_check's findings.",
          "inputSchema": s(json!({ "path": { "type": "string" }, "ops": { "type": "array", "items": { "type": "object" } }, "why": { "type": "string", "description": "one line for the user: what this edit is for" } }), &["path", "ops"]) },
        { "name": "video_check", "description": "Check a video project and get the problems as text: clips overlapping, holes in the speech, cuts inside a word, long pauses left, clips past their file's end, captions too long or too short. Nothing is rendered; no answer to look at when all is well.",
          "inputSchema": s(json!({ "path": { "type": "string" } }), &["path"]) },
        { "name": "jev_ask", "description": "Ask Jev, TypeSafe's System One model, through the user's own key in Leonote - or Laya, an open model of the same kind on the user's own computer, when they chose that (Settings › Jev; same questions, same answers, nothing leaves the machine): fast typed decisions (~0.1-0.5 s) with calibrated probabilities - never free text. Give a state (text or JSON) and named questions; each question is {\"type\":\"choice\",\"instructions\":...,\"criteria\":{option: description,...}} (one of up to 255 options), {\"type\":\"noul\",\"instructions\":\"a yes/no statement\"} (probability it is true), or {\"type\":\"score\",\"instructions\":...,\"criteria\":[level0, level1, ...]} (2-10 rubric levels). Many questions in one call cost one call. Use it to classify, route, score, filter or check - and act only on answers whose confidence is high. Docs: https://docs.typesafe.ai/api",
          "inputSchema": { "type": "object", "properties": {
              "state": { "description": "what to judge: text, or any JSON value" },
              "questions": { "type": "object", "description": "questions by name, e.g. {\"topic\": {\"type\":\"choice\",\"instructions\":\"What is this about?\",\"criteria\":{\"work\":\"...\",\"home\":\"...\"}}}" },
              "model": { "type": "string", "description": "default jev-latest" } },
            "required": ["state", "questions"], "additionalProperties": false } }
    ])
}

/// A task the user gave to AI (or one an agent added).
/// AI's task: owner "ai", and handed over already - `ai_from` (ms since 1970), when set, is the
/// moment it reaches AI; until then the user can still take it back (given to AI by mistake).
fn is_ai_task(t: &Value) -> bool {
    if t.get("owner").and_then(|v| v.as_str()) != Some("ai") { return false; }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    t.get("ai_from").and_then(|v| v.as_u64()).map_or(true, |at| at <= now)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Taken by an agent less than two hours ago (a claim older than that is stale: it can be taken again).
fn taken(t: &Value, now: u64) -> bool {
    t.get("ai_status").and_then(|v| v.as_str()) == Some("working") && t.get("ai_started").and_then(|v| v.as_u64()).map_or(false, |at| now.saturating_sub(at) < 2 * 3600 * 1000)
}

/// Of the tasks given to AI and handed over, the one to work on next: open, not taken; high
/// priority first, then the nearest due date, then the oldest.
fn next_of(tasks: &[Value], now: u64) -> Option<&Value> {
    let rank = |t: &Value| match t.get("priority").and_then(|v| v.as_str()) { Some("high") => 0, Some("medium") => 1, Some("low") => 2, _ => 3 };
    let due = |t: &Value| t.get("due_date").and_then(|v| v.as_str()).unwrap_or("9999").to_string();
    tasks.iter()
        .filter(|t| is_ai_task(t) && t.get("done").and_then(|d| d.as_bool()) != Some(true) && t.get("deleted").and_then(|d| d.as_bool()) != Some(true) && !taken(t, now))
        .min_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| due(a).cmp(&due(b))))
}

fn str_arg<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a.get(k).and_then(|v| v.as_str()).ok_or_else(|| format!("\"{}\" is needed", k))
}

/// Run one tool. The text that comes back is what the agent reads.
pub fn call(ctx: &Ctx, name: &str, a: &Value) -> Result<String, String> {
    // the folders kept out of the index, as the settings say now: this server outlives a change made in the app
    // meanwhile, and a folder left out since must be kept from the very next call (not in tests: they set the list)
    #[cfg(not(test))]
    crate::vault::load_no_index(&crate::Paths::resolve());
    match name {
        "list_notes" => {
            let folder = a.get("folder").and_then(|v| v.as_str()).unwrap_or("").trim().trim_matches('/').replace('\\', "/");
            let limit = a.get("limit").and_then(|v| v.as_u64()).unwrap_or(200).clamp(1, 5000) as usize;
            let mut notes = crate::vault::scan(&ctx.vault, Some(&ctx.dir)).notes;
            let rules = crate::proposals::read_rules(&ctx.dir);
            notes.retain(|n| (folder.is_empty() || n.path.starts_with(&format!("{}/", folder))) && crate::proposals::access_of(&rules, &n.path, Some(&n.content)) != crate::proposals::Access::Private);
            notes.sort_by(|x, y| y.mtime.cmp(&x.mtime));
            let total = notes.len();
            let lines: Vec<String> = notes.iter().take(limit).map(|n| n.path.clone()).collect();
            Ok(format!("{} note{}{}\n{}", total, if total == 1 { "" } else { "s" }, if total > limit { format!(", newest {} shown", limit) } else { String::new() }, lines.join("\n")))
        }
        "search_notes" => {
            let q = str_arg(a, "query")?.to_lowercase();
            let words: Vec<&str> = q.split_whitespace().collect();
            if words.is_empty() {
                return Err("the query is empty".into());
            }
            let limit = a.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).clamp(1, 200) as usize;
            let mut hits: Vec<(u64, String)> = Vec::new();
            let rules = crate::proposals::read_rules(&ctx.dir);
            for n in crate::vault::scan(&ctx.vault, Some(&ctx.dir)).notes {
                if crate::proposals::access_of(&rules, &n.path, Some(&n.content)) == crate::proposals::Access::Private { continue; }
                let hay = format!("{}\n{}", n.path, n.content).to_lowercase();
                if !words.iter().all(|w| hay.contains(w)) {
                    continue;
                }
                let lines: Vec<String> = n.content.lines().enumerate().filter(|(_, l)| { let l = l.to_lowercase(); words.iter().any(|w| l.contains(w)) }).take(6).map(|(i, l)| format!("  {}: {}", i + 1, l.trim().chars().take(200).collect::<String>())).collect();
                hits.push((n.mtime, format!("{}\n{}", n.path, lines.join("\n"))));
            }
            hits.sort_by(|x, y| y.0.cmp(&x.0));
            let total = hits.len();
            if total == 0 {
                return Ok("No note matches.".into());
            }
            Ok(format!("{} note{}{}\n\n{}", total, if total == 1 { " matches" } else { "s match" }, if total > limit { format!(", newest {} shown", limit) } else { String::new() }, hits.into_iter().take(limit).map(|h| h.1).collect::<Vec<_>>().join("\n\n")))
        }
        "read_note" => {
            let p = note_path(&ctx.vault, str_arg(a, "path")?)?;
            let text = old_text(&p)?.ok_or_else(|| format!("there is no note at {}", rel_of(&ctx.vault, &p)))?;
            if access(ctx, &rel_of(&ctx.vault, &p), Some(&text)) == crate::proposals::Access::Private { return Err(PRIVATE.into()); }
            Ok(text)
        }
        "write_note" => {
            let p = note_path(&ctx.vault, str_arg(a, "path")?)?;
            not_a_video(&p)?;
            let old = old_text(&p)?;
            // the note's header (its id, tags, ai: line) stays, even when the agent's text leaves it out
            let content = &crate::proposals::keep_header(old.as_deref().unwrap_or(""), str_arg(a, "content")?);
            write_or_propose(ctx, &p, old.as_deref(), content, "write", a.get("why").and_then(|v| v.as_str()).unwrap_or(""))
        }
        "append_to_note" => {
            let p = note_path(&ctx.vault, str_arg(a, "path")?)?;
            not_a_video(&p)?;
            let text = str_arg(a, "text")?;
            let had = old_text(&p)?;
            let old = had.clone().unwrap_or_default();
            let sep = if old.is_empty() || old.ends_with("\n\n") { "" } else if old.ends_with('\n') { "\n" } else { "\n\n" };
            write_or_propose(ctx, &p, had.as_deref(), &format!("{}{}{}\n", old, sep, text.trim_end()), "append", a.get("why").and_then(|v| v.as_str()).unwrap_or(""))
        }
        "list_tasks" => {
            let all = a.get("include_done").and_then(|v| v.as_bool()).unwrap_or(false);
            let folded = crate::store::fold_in(&ctx.dir, &ctx.snapshot);
            if let Some(f) = folded.conflicted {
                return Err(format!("the task log {} has merge conflict markers - the user has to resolve it first", f));
            }
            let split = crate::proposals::tasks_split(&ctx.dir);
            let rows: Vec<Value> = folded.tasks.into_iter().filter(|t| t.get("deleted").and_then(|d| d.as_bool()) != Some(true) && (all || t.get("done").and_then(|d| d.as_bool()) != Some(true)) && (!split || is_ai_task(t))).map(|t| {
                let mut o = serde_json::Map::new();
                for k in ["id", "text", "done", "priority", "due_date", "start_date", "subtasks"] {
                    if let Some(v) = t.get(k) { if !v.is_null() { o.insert(k.into(), v.clone()); } }
                }
                // not handed over yet: it reads as the user's
                if is_ai_task(&t) { o.insert("owner".into(), json!("ai")); }
                Value::Object(o)
            }).collect();
            serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())
        }
        "add_task" => {
            let text = str_arg(a, "text")?.trim();
            if text.is_empty() {
                return Err("a task needs some text".into());
            }
            if text.chars().count() > 4000 { return Err("a task's text is 4000 characters at most - put the rest in a note".into()); }
            let id = new_id();
            let mut op = json!({ "id": id, "text": text, "done": false, "created": now(), "owner": "ai" });
            // as the tool's description promises, not whatever came
            if let Some(v) = a.get("priority").and_then(|v| v.as_str()) {
                if !["none", "low", "medium", "high"].contains(&v) { return Err("priority is low, medium or high".into()); }
                op["priority"] = json!(v);
            }
            if let Some(v) = a.get("due_date").and_then(|v| v.as_str()) {
                let b = v.as_bytes();
                let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
                if !ok { return Err("due_date is YYYY-MM-DD".into()); }
                op["due_date"] = json!(v);
            }
            append_ops(ctx, &[op])?;
            Ok(format!("Added task {}", id))
        }
        "complete_task" => {
            let id = str_arg(a, "id")?;
            let folded = crate::store::fold_in(&ctx.dir, &ctx.snapshot);
            let Some(task) = folded.tasks.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id)) else {
                return Err(format!("there is no task with id {}", id));
            };
            if crate::proposals::tasks_split(&ctx.dir) && !is_ai_task(task) {
                return Err("that task is the user's own - only the tasks they gave to AI may be changed".into());
            }
            let t = now();
            let mut op = json!({ "id": id, "done": true, "completed_at": &t[..19] });
            if let Some(r) = a.get("result").and_then(|v| v.as_str()).map(str::trim).filter(|r| !r.is_empty()) {
                op["ai_result"] = json!(r.chars().take(600).collect::<String>());
            }
            if is_ai_task(task) { op["ai_status"] = json!("done"); }
            append_ops(ctx, &[op])?;
            Ok("Done".into())
        }
        "next_task" => {
            let folded = crate::store::fold_in(&ctx.dir, &ctx.snapshot);
            if let Some(f) = folded.conflicted {
                return Err(format!("the task log {} has merge conflict markers - the user has to resolve it first", f));
            }
            let now = now_ms();
            let Some(t) = next_of(&folded.tasks, now) else { return Ok("Nothing to do - no task given to AI is waiting.".into()) };
            let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let who = AGENT.lock().map(|g| g.clone()).unwrap_or_default();
            append_ops(ctx, &[json!({ "id": id, "ai_status": "working", "ai_started": now, "ai_by": if who.is_empty() { "an agent".to_string() } else { who } })])?;
            let mut o = serde_json::Map::new();
            for k in ["id", "text", "priority", "due_date", "start_date", "subtasks", "notes"] {
                if let Some(v) = t.get(k) { if !v.is_null() { o.insert(k.into(), v.clone()); } }
            }
            serde_json::to_string_pretty(&Value::Object(o)).map_err(|e| e.to_string())
        }
        "give_back_task" => {
            let id = str_arg(a, "id")?;
            let why = str_arg(a, "why")?.trim();
            let folded = crate::store::fold_in(&ctx.dir, &ctx.snapshot);
            let Some(task) = folded.tasks.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id)) else {
                return Err(format!("there is no task with id {}", id));
            };
            if !is_ai_task(task) { return Err("that task is not AI's - only a task given to AI can be given back".into()); }
            append_ops(ctx, &[json!({ "id": id, "owner": "human", "ai_status": "returned", "ai_result": why.chars().take(600).collect::<String>() })])?;
            Ok("Given back to the user".into())
        }
        "jev_ask" => {
            // Jev switched off in Leonote: jev::ask refuses, for agents as for everything else
            let mut body = json!({ "state": a.get("state").cloned().ok_or("\"state\" is needed")?, "questions": a.get("questions").cloned().ok_or("\"questions\" is needed")? });
            if let Some(mo) = a.get("model").and_then(|v| v.as_str()) { body["model"] = json!(mo); }
            let res = crate::jev::ask(body)?;
            // the answers, compact: what was chosen and how sure, then the full answer for anything finer
            let mut lines = Vec::new();
            if let Some(ans) = res.get("answers").and_then(|v| v.as_object()) {
                for (name, x) in ans {
                    let kind = x.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let conf = x.get("confidence").and_then(|v| v.as_f64()).map(|c| format!(" (confidence {:.2})", c)).unwrap_or_default();
                    let said = match kind {
                        "noul" => format!("{:.3} that it is true", x.get("noul").and_then(|v| v.as_f64()).unwrap_or(0.0)),
                        "choice" => format!("{}{}", x.get("choice").map(|v| v.to_string()).unwrap_or_default(), conf),
                        "score" => format!("{}{}", x.get("score").map(|v| v.to_string()).unwrap_or_default(), conf),
                        _ => x.to_string(),
                    };
                    lines.push(format!("{}: {}", name, said));
                }
            }
            Ok(format!("{}

{}", lines.join("
"), serde_json::to_string(&res).unwrap_or_default()))
        }
        "video_overview" | "video_edit" | "video_check" => {
            let p = note_path(&ctx.vault, str_arg(a, "path")?)?;
            let rel = rel_of(&ctx.vault, &p);
            if !rel.to_ascii_lowercase().ends_with(".leovideo") { return Err("a video project is needed - a .leovideo file".into()); }
            let text = old_text(&p)?.ok_or_else(|| format!("there is no video project at {}", rel))?;
            if access(ctx, &rel, None) == crate::proposals::Access::Private { return Err(PRIVATE.into()); }
            let mut proj: Value = serde_json::from_str(&text).map_err(|e| format!("{} is not a video project Leonote can read: {}", rel, e))?;
            let (srcs, notes) = crate::videoai::listen(&ctx.vault, &proj, &|f| media_ok(ctx, f))?;
            let notes = if notes.is_empty() { String::new() } else { format!("\n{}\n", notes.join("\n")) };
            let checked = |proj: &Value| { let c = crate::videoai::check(proj, &srcs); if c.is_empty() { "Check: no problems found.".to_string() } else { format!("Check:\n- {}", c.join("\n- ")) } };
            match name {
                "video_overview" => Ok(format!("{}{}", crate::videoai::overview(&proj, &rel, &srcs), notes)),
                "video_check" => Ok(format!("{}{}", checked(&proj), notes)),
                _ => {
                    let ops = a.get("ops").and_then(|v| v.as_array()).filter(|o| !o.is_empty()).ok_or("\"ops\" is needed - a list of edits")?;
                    let (done, look) = crate::videoai::apply(&mut proj, ops, &srcs, &|f| media_ok(ctx, f))?;
                    if done.is_empty() { return Ok(format!("Nothing changed.\n{}", look.join("\n"))); }
                    // written as the editor writes it, so the diff is only the change
                    let mut buf = Vec::new();
                    serde::Serialize::serialize(&proj, &mut serde_json::Serializer::with_formatter(&mut buf, serde_json::ser::PrettyFormatter::with_indent(b" "))).map_err(|e| e.to_string())?;
                    let new = String::from_utf8(buf).map_err(|e| e.to_string())?;
                    // the list the user reviews is what the edit does; the agent's own words are one line, marked as theirs
                    let why = a.get("why").and_then(|v| v.as_str()).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect::<String>();
                    let summary = format!("{}{}{}", if why.is_empty() { String::new() } else { format!("The agent says: {}\n", why) }, done.join("\n"), if look.is_empty() { String::new() } else { format!("\nTo look at: {}", look.join("; ")) });
                    let said = write_or_propose(ctx, &p, Some(&text), &new, "write", &summary)?;
                    Ok(format!("{}\n{}\n{}{}\n{}", said, done.join("\n"), if look.is_empty() { String::new() } else { format!("To look at:\n- {}\n", look.join("\n- ")) }, notes, checked(&proj)))
                }
            }
        }
        _ => Err(format!("there is no tool called {}", name)),
    }
}

fn append_ops(ctx: &Ctx, ops: &[Value]) -> Result<(), String> {
    let lines = crate::store::ops_to_lines(ops, WRITER, &crate::store::not_before_newest(now()))?;
    crate::store::append(&crate::store::log_path_in(&ctx.dir, &log_name(&ctx.dir)), &lines).map_err(|e| e.to_string())
}

/// One log file per writer: two agents' sessions at once each append to their own (mcp.jsonl, mcp-2.jsonl ...), the
/// first free one, held by a lock file beside the log folder (inside it, an open file would stop the folder being
/// moved) for as long as this process runs - picked again when the data folder changes. The lines still say `by: mcp`.
pub(crate) fn log_name(dir: &std::path::Path) -> String {
    static HELD: std::sync::Mutex<Option<(std::path::PathBuf, String, std::fs::File)>> = std::sync::Mutex::new(None);
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((d, name, _)) = held.as_ref() { if d == dir { return name.clone(); } }
    *held = None; // the old folder's lock let go
    let _ = std::fs::create_dir_all(dir);
    for n in 1..=16 {
        let name = if n == 1 { WRITER.to_string() } else { format!("{}-{}", WRITER, n) };
        let Ok(f) = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(format!("{}.lock", name))) else { continue };
        if f.try_lock().is_ok() {
            *held = Some((dir.to_path_buf(), name.clone(), f));
            return name;
        }
    }
    WRITER.to_string()
}

/// One JSON-RPC message in, at most one out.
pub fn handle(ctx: &Ctx, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let ok = |result: Value| id.clone().map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    match method {
        "initialize" => {
            let asked = msg.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL);
            if let Some(n) = msg.pointer("/params/clientInfo/name").and_then(|v| v.as_str()) { if let Ok(mut g) = AGENT.lock() {
                // an agent names itself; it does not get to pass for one of the user's plugins in the review
                let n: String = n.chars().take(60).collect();
                // every agent's name is shown as one: no spelling (look-alike letters, "PIugin") gets past a check
                *g = format!("Agent {n}");
            } }
            ok(json!({
                "protocolVersion": asked,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "leonote", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "The user's Leonote vault: Markdown notes and a task list. Read before you write. Prefer append_to_note for adding to a note; write_note replaces the whole text. Never invent note paths - list or search first. Many notes take changes as proposals the user accepts in Leonote: when an answer says Proposed, the change is waiting - do not repeat it. Private notes are kept from you on purpose. Video projects (.leovideo): video_overview, then video_edit with word ids, then video_check."
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("");
            let args = msg.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
            // a vault folder that is gone (a drive unplugged, the folder renamed) is not made again by a write here: with
            // the data kept in the vault, one task added would bring back an empty vault the app then opens as if all was well
            // task tools and Jev keep working while the vault is offline - unless the task data lives in the vault too
            let vault_free = !ctx.dir.starts_with(&ctx.vault) && matches!(name, "list_tasks" | "add_task" | "complete_task" | "next_task" | "give_back_task" | "jev_ask");
            let gone = !vault_free && matches!(ctx.vault.try_exists(), Ok(false));
            let r = if gone { Err(format!("The vault folder is not there ({}). Nothing was written; ask the user to plug in the drive or open Leonote.", ctx.vault.display())) } else { call(ctx, name, &args) };
            let (text, is_error) = match r { Ok(t) => (t, false), Err(e) => (e, true) };
            ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
        }
        // notifications get no answer; an unknown request gets a proper error
        _ => id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {}", method) } })),
    }
}

/// Serve until stdin closes.
pub fn serve(mut ctx: Ctx) {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // the app may have moved its data since this server started: the AI rules, logs and kept versions are where app.json says now
        let p = crate::Paths::resolve();
        if crate::read_json(&p.settings).is_some() && (p.dir != ctx.dir || p.vault != ctx.vault) {
            crate::vault::load_no_index(&p);
            ctx = Ctx { vault: p.vault, dir: p.dir, snapshot: p.snapshot };
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(&ctx, &msg),
            Err(e) => Some(json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": -32700, "message": format!("parse error: {}", e) } })),
        };
        if let Some(r) = reply {
            if writeln!(out, "{}", r).is_err() || out.flush().is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    #[test]
    fn a_task_reaches_ai_when_its_moment_comes() {
        let later = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 60_000;
        assert!(super::is_ai_task(&json!({ "owner": "ai" })));
        assert!(super::is_ai_task(&json!({ "owner": "ai", "ai_from": 1 })));
        assert!(!super::is_ai_task(&json!({ "owner": "ai", "ai_from": later })));
        assert!(!super::is_ai_task(&json!({ "owner": "human" })));
    }
    #[test]
    fn the_next_task_is_the_most_pressing_one_nobody_has_taken() {
        let now = 10_000_000_000u64;
        let tasks = vec![
            json!({ "id": "a", "owner": "ai", "priority": "low" }),
            json!({ "id": "b", "owner": "ai", "priority": "high", "due_date": "2026-12-01" }),
            json!({ "id": "c", "owner": "ai", "priority": "high", "due_date": "2026-11-01" }),
            json!({ "id": "d", "owner": "ai", "priority": "high", "ai_status": "working", "ai_started": now - 1000 }),
            json!({ "id": "e", "owner": "human", "priority": "high" }),
            json!({ "id": "f", "owner": "ai", "priority": "high", "done": true }),
        ];
        assert_eq!(super::next_of(&tasks, now).and_then(|t| t["id"].as_str()), Some("c"));
        // a claim three hours old is stale: taken again
        let stale = vec![json!({ "id": "d", "owner": "ai", "ai_status": "working", "ai_started": now - 3 * 3600 * 1000 })];
        assert_eq!(super::next_of(&stale, now).and_then(|t| t["id"].as_str()), Some("d"));
    }
}
