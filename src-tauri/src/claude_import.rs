//! Claude Code's sessions as notes: each session file under ~/.claude/projects (read, never changed) becomes one
//! readable note in a vault folder - a folder per project, the conversation only (your messages and Claude's
//! replies; tool calls and their output, thinking and the hidden system text left out), anything that looks
//! like a key or a password blanked, `ai: private` so other AI tools leave it alone. Run on a click; a session
//! that grew is written again - unless its note was edited here, which is then left as it is.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// One note at most this big (the rest stays in Claude's own file).
const MAX_NOTE: usize = 3 << 20;

fn claude_projects() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() { h ^= b as u64; h = h.wrapping_mul(0x1000_0000_01b3); }
    format!("{h:016x}")
}

/// Text from what a message holds: a string, or the text blocks of a list (tool calls, tool results and
/// thinking are not text blocks, and stay out).
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    }
}

/// The hidden text Claude Code puts in a turn (system reminders, a command's own output) out; a slash
/// command kept as its name and arguments.
pub fn clean(s: &str) -> String {
    let mut t = s.to_string();
    for tag in ["system-reminder", "local-command-stdout", "local-command-stderr", "command-message", "local-command-caveat"] {
        let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
        while let Some(a) = t.find(&open) {
            let Some(b) = t[a..].find(&close) else { t.truncate(a); break };
            t.replace_range(a..a + b + close.len(), "");
        }
    }
    for tag in ["command-name", "command-args"] { t = t.replace(&format!("<{tag}>"), "").replace(&format!("</{tag}>"), " "); }
    t.trim().to_string()
}

/// Keys, tokens and passwords blanked: the well-known key shapes, a private key's block, and the value after
/// a word like password / secret / token / api key. ponytail: by shape, not a full secret scanner - a key with
/// no known prefix and no label before it gets through.
pub fn redact(s: &str) -> String {
    const PREFIXES: &[&str] = &["sk-", "sk_live_", "sk_test_", "rk_live_", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "glpat-", "xoxb-", "xoxp-", "xapp-", "AKIA", "ASIA", "AIza", "ya29.", "hf_", "npm_", "pypi-"];
    const LABELS: &[&str] = &["password", "passwd", "secret", "token", "api_key", "apikey", "api-key", "access_key", "private_key", "client_secret", "authorization"];
    let mut out = String::with_capacity(s.len());
    let mut in_key = false;
    for line in s.split_inclusive('\n') {
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") { in_key = true; out.push_str("[private key removed]\n"); continue; }
        if in_key { if line.contains("-----END") { in_key = false; } continue; }
        // a word with a known key's start, long enough to be one - glued to anything: KEY=sk-..., url?key=AIza...
        let mut kept = line.to_string();
        for w in line.split(|c: char| "=:/?&\"'`,;()[]{}<>".contains(c) || c.is_whitespace()) {
            if w.len() >= 16 && PREFIXES.iter().any(|p| w.starts_with(p)) { kept = kept.replace(w, "[key removed]"); }
        }
        let lower = kept.to_ascii_lowercase();
        // "password: x", "token=x", "\"api_key\": \"x\"", "AWS_SECRET_ACCESS_KEY=x": what follows the label goes
        // (a name after it only when it ends in key: "token_count: 400", "tokens: 400" and "tokenizer: x" are other words)
        let labelled = LABELS.iter().flat_map(|l| lower.match_indices(l).map(|(i, _)| i + l.len())).filter_map(|at| {
            let rest = &kept[at..];
            let name = if rest.starts_with(['_', '-']) { rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len()) } else { 0 };
            if name > 0 && !lower[at..at + name].ends_with("key") { return None; }
            let sep = rest[name..].find([':', '='])? + name;
            let plain = rest[name..sep].trim_matches(|c: char| c == '"' || c == '\'' || c.is_whitespace()).is_empty();
            (plain && !rest[sep + 1..].trim().is_empty()).then_some(at + sep + 1)
        }).min();
        if let Some(end) = labelled {
            out.push_str(&kept[..end]);
            out.push_str(" [removed]");
            if kept.ends_with('\n') { out.push('\n'); }
            continue;
        }
        out.push_str(&kept);
    }
    out
}

/// A name that can be a file's: letters, digits and a few signs, at most `max` characters.
fn file_name(s: &str, max: usize) -> String {
    let t: String = s.chars().map(|c| if c.is_alphanumeric() || " -_()&,.'".contains(c) { c } else { ' ' }).collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = t.chars().take(max).collect();
    t.trim_end_matches(['.', ' ']).to_string()
}

fn local_time(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

/// One session file as a note: (folder name, file name, text) - None when it holds no conversation.
pub fn session_note(file: &Path) -> Option<(String, String, String)> {
    let f = std::fs::File::open(file).ok()?;
    let id = file.file_stem()?.to_string_lossy().into_owned();
    let (mut started, mut cwd, mut summary, mut first_ask) = (String::new(), String::new(), String::new(), String::new());
    let mut body = String::new();
    let mut cut = false;
    for line in BufReader::new(f).lines() {
        let Ok(line) = line else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["type"] == "summary" { if let Some(s) = v["summary"].as_str() { summary = s.to_string(); } continue; }
        let who = match v["type"].as_str() { Some("user") => "You", Some("assistant") => "Claude", _ => continue };
        // a helper agent's own turns, and the turns Claude Code makes up itself, are not the conversation
        if v["isSidechain"] == true || v["isMeta"] == true { continue; }
        if cwd.is_empty() { if let Some(c) = v["cwd"].as_str() { cwd = c.to_string(); } }
        let ts = v["timestamp"].as_str().unwrap_or("");
        if started.is_empty() && !ts.is_empty() { started = local_time(ts); }
        let text = clean(&text_of(&v["message"]["content"]));
        if text.is_empty() || cut { continue; }
        if who == "You" && first_ask.is_empty() { first_ask = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string(); }
        let when = local_time(ts);
        body.push_str(&format!("**{who}**{}\n\n{}\n\n", if when.len() >= 16 { format!(" · {}", &when[11..16]) } else { String::new() }, redact(&text)));
        if body.len() > MAX_NOTE { body.push_str("*(cut here - the rest is in Claude's own file)*\n"); cut = true; }
    }
    if body.is_empty() { return None; }
    let project = Path::new(&cwd).file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Other".into());
    let title = if !summary.is_empty() { summary } else { first_ask };
    let title = file_name(&redact(&title), 60); // a file name and a heading are not covered by ai: private
    let title = if title.is_empty() { format!("Session {}", id.chars().take(8).collect::<String>()) } else { title };
    let stamp = if started.len() >= 16 { started[..16].replace(':', "") } else { String::new() };
    let name = file_name(&format!("{stamp} {title}"), 90);
    let head = format!("---\nai: private\nsource: claude-code\nsession: {id}\nproject: \"{}\"\nstarted: {started}\ntags: [claude]\n---\n# {title}\n\n", cwd.replace('\\', "/").replace('"', "'"));
    Some((file_name(&project, 60), name, head + &body))
}

/// Bring Claude Code's sessions into the vault folder `dest`: new ones as notes, grown ones written again
/// (a note edited here is kept as it is). Progress goes to the page as `claude:progress`.
/// -> { added, updated, kept, total }
#[tauri::command]
pub async fn claude_import(app: AppHandle, dest: String, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let dest = dest.trim().trim_matches('/').replace('\\', "/");
    crate::vault::check_rel(&dest)?;
    let (vault, data) = (state.paths.vault.clone(), state.paths.dir.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root = claude_projects().ok_or("No home folder")?;
        let files: Vec<PathBuf> = std::fs::read_dir(&root).map_err(|_| "Claude Code has no sessions on this computer (~/.claude/projects)".to_string())?
            .flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
        let memo_path = data.join("claude-import.json");
        let mut memo: HashMap<String, Value> = std::fs::read(&memo_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let (mut added, mut updated, mut kept) = (0, 0, 0);
        let total = files.len();
        for (i, file) in files.iter().enumerate() {
            if i % 20 == 0 { let _ = app.emit_to("main", "claude:progress", json!({ "done": i, "total": total })); }
            let key = file.to_string_lossy().into_owned();
            let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
            let was = memo.get(&key).cloned();
            if was.as_ref().is_some_and(|w| w["size"] == size) { continue; } // unchanged since the last time
            let Some((folder, name, text)) = session_note(file) else { memo.insert(key, json!({ "size": size })); continue };
            // the note it already has, or a new one
            let rel = was.as_ref().and_then(|w| w["note"].as_str().map(String::from)).unwrap_or_else(|| format!("{dest}/{folder}/{name}.md"));
            if crate::vault::check_rel(&rel).is_err() { continue; }
            let abs = vault.join(&rel);
            if let Some(w) = &was {
                // edited in Leonote since it was written: left as it is
                if let Ok(now) = std::fs::read_to_string(&abs) { if w["hash"].as_str() != Some(fnv(&now).as_str()) { kept += 1; memo.insert(key, json!({ "size": size, "note": rel, "hash": w["hash"] })); continue; } }
            }
            if let Some(p) = abs.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            crate::vault::write_atomic(&abs, text.as_bytes()).map_err(|e| format!("write {rel}: {e}"))?;
            if was.as_ref().and_then(|w| w.get("note")).is_some() { updated += 1 } else { added += 1 }
            memo.insert(key, json!({ "size": size, "note": rel, "hash": fnv(&text) }));
        }
        let _ = crate::vault::write_atomic(&memo_path, &serde_json::to_vec(&memo).unwrap_or_default());
        let _ = app.emit_to("main", "claude:progress", json!({ "done": total, "total": total }));
        Ok(json!({ "added": added, "updated": updated, "kept": kept, "total": total }))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This computer's real sessions, converted in memory (nothing written, no text printed): how many, how
    /// long, how big. cargo test --release --lib claude_import -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_sessions_measured() {
        let root = claude_projects().unwrap();
        let t = std::time::Instant::now();
        let (mut files, mut notes, mut bytes_in, mut bytes_out) = (0, 0, 0u64, 0usize);
        for d in std::fs::read_dir(&root).unwrap().flatten() {
            for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
                let p = f.path();
                if p.extension().is_none_or(|x| x != "jsonl") { continue; }
                files += 1;
                bytes_in += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                if let Some((_, _, text)) = session_note(&p) { notes += 1; bytes_out += text.len(); }
            }
        }
        println!("{files} session files, {} MB read -> {notes} notes, {} MB of notes, in {:.1} s", bytes_in >> 20, bytes_out >> 20, t.elapsed().as_secs_f64());
    }
    #[test]
    fn hidden_text_goes_and_keys_are_blanked() {
        assert_eq!(clean("<system-reminder>secret rules</system-reminder>Hi there"), "Hi there");
        assert_eq!(clean("<command-message>x</command-message><command-name>/secure-code</command-name>"), "/secure-code");
        let r = redact("my key sk-ant-api03-abcdefghijklmnop and ghp_0123456789abcdefABCDEF here\npassword: hunter2\n\"api_key\": \"abc123\"\nnormal line\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\ncommit 3dc95b2a1b and done");
        assert!(!r.contains("sk-ant-api03") && !r.contains("ghp_0123") && !r.contains("hunter2") && !r.contains("abc123") && !r.contains("MIIE"), "{r}");
        assert!(r.contains("normal line") && r.contains("commit 3dc95b2a1b"), "ordinary text and short hashes stay: {r}");
        let r = redact("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI\nSECRET_KEY=abc1\nthe token expired, password: hunter2\nOPENAI_KEY=sk-proj-abcdefghijklmnop\nsee url?key=AIzaSyAbcdefghijklmnop&x=1\nfoo:ghp_0123456789abcdefABCDEF\ntokens: 400\nthe tokenizer: splits words\n");
        for gone in ["wJalr", "abc1", "hunter2", "sk-proj", "AIzaSy", "ghp_0123"] { assert!(!r.contains(gone), "{gone}: {r}"); }
        assert!(r.contains("the token expired, password: [removed]") && r.contains("&x=1"), "{r}");
        assert!(r.contains("tokens: 400") && r.contains("the tokenizer: splits words"), "other words stay: {r}");
        // a key before a label goes too, and a name after a label is only blanked when it names a key
        let r = redact("my key ghp_0123456789abcdefABCDEF, the token expired, password: hunter2\nsk-proj-abcdefghijklmnop token_count: 5\nexport OPENAI_KEY=sk-proj-abcdefghijklmnop; export DB_PASSWORD=x1\nsee url?key=AIzaSyAbcdefghijklmnop&token=abc2\ntoken_count: 400\nsecret-santa: Bob\n");
        for gone in ["ghp_0123", "hunter2", "sk-proj", "AIzaSy", "x1", "abc2"] { assert!(!r.contains(gone), "{gone}: {r}"); }
        assert!(r.contains("[key removed] token_count: 5") && r.contains("token_count: 400") && r.contains("secret-santa: Bob"), "{r}");
    }

    #[test]
    fn a_session_becomes_a_note_of_the_conversation() {
        let dir = std::env::temp_dir().join(format!("leonote-claude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("0123abcd-0000-0000-0000-000000000000.jsonl");
        let lines = [
            json!({ "type": "user", "cwd": "D:\\Work\\demo", "timestamp": "2026-10-20T10:00:00Z", "message": { "role": "user", "content": "<system-reminder>x</system-reminder>Fix the login bug" } }),
            json!({ "type": "assistant", "timestamp": "2026-10-20T10:01:00Z", "message": { "role": "assistant", "content": [{ "type": "thinking", "thinking": "private thoughts" }, { "type": "text", "text": "Found it in auth.rs" }, { "type": "tool_use", "name": "Bash", "input": { "command": "cat .env" } }] } }),
            json!({ "type": "user", "timestamp": "2026-10-20T10:02:00Z", "message": { "role": "user", "content": [{ "type": "tool_result", "content": "TOKEN=abc" }] } }),
            json!({ "type": "assistant", "isSidechain": true, "message": { "content": [{ "type": "text", "text": "a helper's own words" }] } }),
        ];
        std::fs::write(&f, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        let (folder, name, text) = session_note(&f).unwrap();
        assert_eq!(folder, "demo");
        assert!(name.ends_with("Fix the login bug"), "{name}");
        assert!(text.starts_with("---\nai: private\n"), "private to AI");
        assert!(text.contains("Fix the login bug") && text.contains("Found it in auth.rs"));
        for gone in ["private thoughts", "cat .env", "TOKEN=abc", "a helper's own words", "<system-reminder>"] { assert!(!text.contains(gone), "{gone} should be left out"); }
        // a key in the first message stays out of the file name and the heading
        let g = dir.join("0123abce-0000-0000-0000-000000000000.jsonl");
        std::fs::write(&g, json!({ "type": "user", "timestamp": "2026-10-20T10:00:00Z", "message": { "role": "user", "content": "use ghp_0123456789abcdefABCDEF, the token expired, password: x" } }).to_string()).unwrap();
        let (_, name, text) = session_note(&g).unwrap();
        assert!(!name.contains("ghp_") && !text.contains("ghp_"), "{name}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
