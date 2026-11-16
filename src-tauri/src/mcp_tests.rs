//! The MCP server: which paths an agent may name, what the tools do to a
//! vault on disk, and that the protocol answers the way a client expects.

use super::mcp::*;
use serde_json::json;
use std::path::PathBuf;

fn ctx(name: &str) -> Ctx {
    let root = std::env::temp_dir().join(format!("leonote_mcp_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("vault")).unwrap();
    std::fs::create_dir_all(root.join("data")).unwrap();
    std::fs::write(root.join("data").join("tasks.json"), "[]").unwrap();
    Ctx { vault: root.join("vault"), dir: root.join("data"), snapshot: root.join("data").join("tasks.json") }
}

#[test]
fn only_notes_inside_the_vault_can_be_named() {
    let v = PathBuf::from("V");
    assert_eq!(note_path(&v, "Ideas/New").unwrap(), v.join("Ideas/New.md"));
    assert_eq!(note_path(&v, r"\Ideas\A.md").unwrap(), v.join("Ideas/A.md"));
    for bad in ["", "../x", "a/../../x", ".trash/x", "a/.git/x", "C:/x", "a/b?.md", "Private./x.md", "Private /x.md", "NUL.md", "a/com1.md", "LPT9"] {
        assert!(note_path(&v, bad).is_err(), "{} should be refused", bad);
    }
    // a file a video project names goes by the same rules: nothing outside the vault, by any spelling
    assert_eq!(vault_path(&v, "Videos/talk.mp4").unwrap(), v.join("Videos/talk.mp4"));
    for bad in ["C:/Users/me/call.m4a", "../a.mp4", "a.mp4:hidden", "Diary/aux.wav"] {
        assert!(vault_path(&v, bad).is_err(), "{} should be refused", bad);
    }
    // a network path loses its leading slashes: it can only name a folder of the vault, never the server
    assert_eq!(vault_path(&v, r"\\server\share\a.mp4").unwrap(), v.join("server/share/a.mp4"));
    assert!(note_path(&v, "Consoles.md").is_ok() && note_path(&v, "COM10.md").is_ok(), "only the device names themselves");
}

#[cfg(windows)]
#[test]
fn a_dot_folder_by_another_name_stays_out_of_agents_reach() {
    let c = ctx("shortname");
    let trash = c.vault.join(".trash");
    std::fs::create_dir_all(&trash).unwrap();
    std::fs::write(trash.join("gone.md"), "deleted words").unwrap();
    // a junction stands in for the short name TRASH~1: a name with no dot that is the dot folder
    assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(c.vault.join("TRASH~1")).arg(&trash).output().unwrap().status.success());
    assert!(call(&c, "read_note", &json!({ "path": "TRASH~1/gone.md" })).is_err());
}

#[test]
fn kept_versions_in_the_vault_stay_out_of_agents_reach() {
    let mut c = ctx("datadir");
    // the data folder inside the vault, as an install in the "vault" mode has it
    c.dir = c.vault.join("LeoNote");
    let kept = c.dir.join("history").join("notes").join("diary");
    std::fs::create_dir_all(&kept).unwrap();
    std::fs::write(kept.join("1.md"), "secret words").unwrap();
    std::fs::write(c.vault.join("plain.md"), "plain").unwrap();
    assert!(!call(&c, "list_notes", &json!({})).unwrap().contains("history"));
    assert_eq!(call(&c, "search_notes", &json!({ "query": "secret" })).unwrap(), "No note matches.");
    assert!(call(&c, "read_note", &json!({ "path": "LeoNote/history/notes/diary/1.md" })).is_err());
    assert!(call(&c, "read_note", &json!({ "path": "plain.md" })).is_ok());
}

#[test]
fn a_video_project_is_not_changed_as_text() {
    let c = ctx("videotext");
    std::fs::write(c.dir.join("ai-access.json"), r#"{"default":"open","folders":{}}"#).unwrap();
    std::fs::write(c.vault.join("a.leovideo"), "{}").unwrap();
    assert!(call(&c, "write_note", &json!({ "path": "a.LeoVideo", "content": "x" })).is_err());
    assert!(call(&c, "append_to_note", &json!({ "path": "a.leovideo", "text": "x" })).is_err());
    assert_eq!(std::fs::read_to_string(c.vault.join("a.leovideo")).unwrap(), "{}");
}

#[test]
fn a_note_that_is_not_utf8_is_not_replaced_by_an_append() {
    let c = ctx("encoding");
    std::fs::write(c.dir.join("ai-access.json"), r#"{"default":"open","folders":{}}"#).unwrap();
    std::fs::write(c.vault.join("old.md"), b"\xCE\xF2\xF7\xE5\xF2").unwrap();
    assert!(call(&c, "append_to_note", &json!({ "path": "old", "text": "more" })).is_err());
    assert!(call(&c, "write_note", &json!({ "path": "old", "content": "new" })).is_err());
    assert_eq!(std::fs::read(c.vault.join("old.md")).unwrap(), b"\xCE\xF2\xF7\xE5\xF2");
}

#[test]
fn an_agent_cannot_write_the_ai_line_itself() {
    let c = ctx("ailine");
    std::fs::write(c.dir.join("ai-access.json"), r#"{"default":"open","folders":{}}"#).unwrap();
    std::fs::write(c.vault.join("a.md"), "words").unwrap();
    assert!(call(&c, "write_note", &json!({ "path": "a", "content": "---\nai: open\n---\nwords" })).is_err());
    assert_eq!(std::fs::read_to_string(c.vault.join("a.md")).unwrap(), "words");
    assert!(call(&c, "write_note", &json!({ "path": "new", "content": "---\nai: open\n---\nwords" })).is_err());
    assert!(!c.vault.join("new.md").exists());
    // a line the user put there rides along untouched
    std::fs::write(c.vault.join("b.md"), "---\nai: open\n---\nwords").unwrap();
    assert!(call(&c, "write_note", &json!({ "path": "b", "content": "other" })).is_ok());
    assert!(std::fs::read_to_string(c.vault.join("b.md")).unwrap().starts_with("---\nai: open\n---\n"));
}

#[test]
fn notes_are_written_read_found_and_kept() {
    let c = ctx("notes");
    // a vault whose notes agents may write straight away
    std::fs::write(c.dir.join("ai-access.json"), r#"{"default":"open","folders":{}}"#).unwrap();
    assert!(call(&c, "write_note", &json!({ "path": "Ideas/Swarm", "content": "# Swarm\nmany small agents" })).unwrap().starts_with("Created"));
    assert_eq!(call(&c, "read_note", &json!({ "path": "Ideas/Swarm.md" })).unwrap(), "# Swarm\nmany small agents");
    call(&c, "append_to_note", &json!({ "path": "Ideas/Swarm", "text": "- [ ] try it" })).unwrap();
    assert_eq!(call(&c, "read_note", &json!({ "path": "Ideas/Swarm" })).unwrap(), "# Swarm\nmany small agents\n\n- [ ] try it\n");
    assert!(call(&c, "search_notes", &json!({ "query": "SMALL agents" })).unwrap().contains("Ideas/Swarm.md"));
    assert_eq!(call(&c, "search_notes", &json!({ "query": "nothing-like-this" })).unwrap(), "No note matches.");
    assert!(call(&c, "list_notes", &json!({})).unwrap().starts_with("1 note\n"));
    // replacing keeps what was there
    assert!(call(&c, "write_note", &json!({ "path": "Ideas/Swarm", "content": "new" })).unwrap().starts_with("Replaced"));
    let kept = || std::fs::read_dir(c.vault.join(".trash")).unwrap().flatten().filter(|e| !e.file_name().to_string_lossy().starts_with('.')).count();
    assert_eq!(kept(), 1);
    // twice in the same second: both earlier texts are kept, neither over the other
    call(&c, "write_note", &json!({ "path": "Ideas/Swarm", "content": "newer" })).unwrap();
    assert_eq!(kept(), 2);
    assert!(call(&c, "read_note", &json!({ "path": "Nope" })).is_err());
    assert!(call(&c, "write_note", &json!({ "path": "../out", "content": "x" })).is_err());
}

#[test]
fn tasks_go_through_the_log() {
    let c = ctx("tasks");
    let said = call(&c, "add_task", &json!({ "text": "ship it", "priority": "high" })).unwrap();
    let id = said.trim_start_matches("Added task ").to_string();
    assert_eq!(id.len(), 36);
    let open = call(&c, "list_tasks", &json!({})).unwrap();
    assert!(open.contains("ship it") && open.contains(&id));
    assert_eq!(std::fs::read_to_string(&c.snapshot).unwrap(), "[]", "the snapshot is never written");
    call(&c, "complete_task", &json!({ "id": id })).unwrap();
    assert!(!call(&c, "list_tasks", &json!({})).unwrap().contains("ship it"));
    assert!(call(&c, "list_tasks", &json!({ "include_done": true })).unwrap().contains("ship it"));
    assert!(call(&c, "complete_task", &json!({ "id": "no-such" })).is_err());
}

#[test]
fn an_agent_takes_the_next_task_does_it_or_gives_it_back() {
    let c = ctx("loop");
    let later = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 600_000;
    std::fs::write(&c.snapshot, format!(r#"[{{"id":"mine","text":"call mum","done":false}},
      {{"id":"soon","text":"not handed over yet","done":false,"owner":"ai","ai_from":{}}},
      {{"id":"low","text":"tidy the inbox","done":false,"owner":"ai","priority":"low"}},
      {{"id":"high","text":"write the release notes","done":false,"owner":"ai","priority":"high"}}]"#, later)).unwrap();
    let first = call(&c, "next_task", &json!({})).unwrap();
    assert!(first.contains("write the release notes"), "the high one first: {}", first);
    // taken now: the next call gets the other one, then nothing
    assert!(call(&c, "next_task", &json!({})).unwrap().contains("tidy the inbox"));
    assert!(call(&c, "next_task", &json!({})).unwrap().starts_with("Nothing to do"));
    call(&c, "complete_task", &json!({ "id": "high", "result": "Drafted in Releases/1.0.md" })).unwrap();
    call(&c, "give_back_task", &json!({ "id": "low", "why": "needs your mail login" })).unwrap();
    assert!(call(&c, "give_back_task", &json!({ "id": "mine", "why": "x" })).is_err(), "only AI's tasks go back");
    let all = crate::store::fold_in(&c.dir, &c.snapshot).tasks;
    let get = |id: &str| all.iter().find(|t| t["id"] == id).unwrap().clone();
    assert_eq!(get("high")["ai_result"], "Drafted in Releases/1.0.md");
    assert_eq!(get("high")["done"], true);
    assert_eq!(get("low")["owner"], "human");
    assert_eq!(get("low")["ai_status"], "returned");
}

#[test]
fn split_tasks_keep_the_users_own_out_of_reach() {
    let c = ctx("split");
    // the user's own task, and one given to AI, already in the snapshot
    std::fs::write(&c.snapshot, r#"[{"id":"mine","text":"call mum","done":false},{"id":"theirs","text":"tidy the inbox","done":false,"owner":"ai"}]"#).unwrap();
    // not split: everything is listed
    assert!(call(&c, "list_tasks", &json!({})).unwrap().contains("call mum"));
    std::fs::write(c.dir.join("ai-access.json"), r#"{"default":"review","folders":{},"tasks":"split"}"#).unwrap();
    let seen = call(&c, "list_tasks", &json!({})).unwrap();
    assert!(!seen.contains("call mum") && seen.contains("tidy the inbox"));
    assert!(call(&c, "complete_task", &json!({ "id": "mine" })).unwrap_err().contains("the user's own"));
    call(&c, "complete_task", &json!({ "id": "theirs" })).unwrap();
    // what an agent adds is its own
    let said = call(&c, "add_task", &json!({ "text": "draft the reply" })).unwrap();
    assert!(call(&c, "list_tasks", &json!({})).unwrap().contains("draft the reply"));
    assert!(said.starts_with("Added task "));
}

#[test]
fn the_protocol_answers_as_a_client_expects() {
    let c = ctx("rpc");
    let init = handle(&c, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert!(handle(&c, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
    let list = handle(&c, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 14);
    let bad = handle(&c, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "read_note", "arguments": { "path": "x" } } })).unwrap();
    assert_eq!(bad["result"]["isError"], true);
    assert_eq!(handle(&c, &json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).unwrap()["error"]["code"], -32601);
}

#[test]
fn review_makes_a_proposal_and_private_is_kept_away() {
    let c = ctx("access");
    std::fs::write(c.dir.join("ai-access.json"), r#"{"default":"review","folders":{"Diary":"private"}}"#).unwrap();
    std::fs::create_dir_all(c.vault.join("Diary")).unwrap();
    std::fs::write(c.vault.join("Diary").join("today.md"), "secret").unwrap();
    std::fs::write(c.vault.join("plan.md"), "# Plan\n").unwrap();
    // review: nothing changes in the note, a proposal waits
    let said = call(&c, "append_to_note", &json!({ "path": "plan", "text": "- step one", "why": "a first step" })).unwrap();
    assert!(said.starts_with("Proposed"), "{}", said);
    assert_eq!(std::fs::read_to_string(c.vault.join("plan.md")).unwrap(), "# Plan\n");
    let w = crate::proposals::waiting(&c.dir);
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].content, "# Plan\n\n- step one\n");
    assert_eq!(w[0].why, "a first step");
    assert_eq!(w[0].base.as_deref(), Some(crate::proposals::hash("# Plan\n").as_str()));
    // private: not listed, not found, not read, not written
    assert!(!call(&c, "list_notes", &json!({})).unwrap().contains("Diary/today.md"));
    assert_eq!(call(&c, "search_notes", &json!({ "query": "secret" })).unwrap(), "No note matches.");
    assert!(call(&c, "read_note", &json!({ "path": "Diary/today" })).is_err());
    // the same folder named another way is still the same private folder
    for other in ["diary/today", "DIARY/today", "Diary./today", "Diary /today"] {
        assert!(call(&c, "read_note", &json!({ "path": other })).is_err(), "{} must stay private", other);
    }
    assert!(call(&c, "write_note", &json!({ "path": "Diary/today", "content": "x" })).is_err());
    assert_eq!(std::fs::read_to_string(c.vault.join("Diary").join("today.md")).unwrap(), "secret");
    // a note can open itself up
    std::fs::write(c.vault.join("Diary").join("shared.md"), "---\nai: open\n---\nok").unwrap();
    assert!(call(&c, "read_note", &json!({ "path": "Diary/shared" })).is_ok());
}

#[test]
fn an_agent_gets_no_oversized_note_and_no_odd_task() {
    let c = ctx("limits");
    let f = c.vault.join("big.md");
    std::fs::write(&f, "x").unwrap();
    std::fs::OpenOptions::new().write(true).open(&f).unwrap().set_len(crate::vault::MAX_NOTE + 1).unwrap();
    assert!(call(&c, "read_note", &json!({ "path": "big.md" })).is_err(), "too big to hand over");
    assert!(call(&c, "append_to_note", &json!({ "path": "big.md", "text": "y" })).is_err(), "too big to change");
    assert!(call(&c, "add_task", &json!({ "text": "x", "priority": "urgent" })).is_err());
    assert!(call(&c, "add_task", &json!({ "text": "x", "due_date": "tomorrow" })).is_err());
    assert!(call(&c, "add_task", &json!({ "text": "y".repeat(4001) })).is_err());
    assert!(call(&c, "add_task", &json!({ "text": "fine", "priority": "low", "due_date": "2026-11-20" })).is_ok());
}

#[test]
fn a_second_session_writes_its_own_log() {
    let c = ctx("second_session");
    // another --mcp process holds the first log
    let other = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(c.dir.join("mcp.lock")).unwrap();
    other.try_lock().unwrap();
    assert_eq!(log_name(&c.dir), "mcp-2");
    assert_eq!(log_name(&c.dir), "mcp-2", "kept for the rest of the session");
    assert!(!crate::store::log_dir_in(&c.dir).join("mcp.lock").exists(), "no lock inside the log folder");
}

#[test]
fn a_missing_vault_is_not_made_again() {
    let c = ctx("vault_gone");
    std::fs::remove_dir_all(&c.vault).unwrap();
    let call = |c: &Ctx, name: &str, args: serde_json::Value| handle(c, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}})).unwrap();
    // a note tool would write into it
    assert_eq!(call(&c, "write_note", json!({"path":"a","text":"x"}))["result"]["isError"], true);
    assert!(!c.vault.exists());
    // tasks kept outside the vault still work
    assert_eq!(call(&c, "add_task", json!({"text":"x"}))["result"]["isError"], false);
    // tasks kept inside it ("vault" data mode) are refused too
    let inside = Ctx { dir: c.vault.join("LeoNote"), snapshot: c.vault.join("LeoNote").join("tasks.json"), vault: c.vault.clone() };
    assert_eq!(call(&inside, "add_task", json!({"text":"x"}))["result"]["isError"], true);
    assert!(!c.vault.exists());
}
