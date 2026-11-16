//! The Assistant's wire formats: where a request goes, what it carries, and
//! what is read out of a stream. No network is touched here.

use super::ai::*;
use serde_json::json;

#[test]
fn a_request_goes_to_the_right_address() {
    assert_eq!(chat_url("anthropic", "https://api.anthropic.com/"), "https://api.anthropic.com/v1/messages");
    assert_eq!(chat_url("anthropic", "https://proxy.example/v1"), "https://proxy.example/v1/messages");
    assert_eq!(chat_url("openai", "http://localhost:11434/v1/"), "http://localhost:11434/v1/chat/completions");
    assert_eq!(chat_url("openai", "https://api.perplexity.ai"), "https://api.perplexity.ai/chat/completions");
    assert_eq!(models_url("anthropic", "https://api.anthropic.com"), "https://api.anthropic.com/v1/models");
    assert_eq!(models_url("openai", "https://api.x.ai/v1"), "https://api.x.ai/v1/models");
}

#[test]
fn only_this_computer_counts_as_local() {
    assert!(is_local("http://localhost:11434/v1"));
    assert!(is_local("http://127.0.0.1:1234/v1"));
    assert!(is_local("http://[::1]:8080/v1"));
    assert!(!is_local("https://api.openai.com/v1"));
    assert!(!is_local("https://localhost.example.com/v1"));
}

#[test]
fn the_body_matches_the_wire_format() {
    let msgs = vec![json!({ "role": "user", "content": "hi" }), json!({ "role": "narrator", "content": "x" }), json!({ "role": "assistant", "content": "  " })];
    let a = chat_body("anthropic", "claude-sonnet-5", "be brief", &msgs, &[], 64000);
    assert_eq!(a["system"], "be brief");
    assert_eq!(a["messages"].as_array().unwrap().len(), 1);
    assert_eq!(a["stream"], true);
    assert!(a.get("fallbacks").is_none());
    assert!(a.get("temperature").is_none() && a.get("thinking").is_none());
    let o = chat_body("anthropic", "claude-opus-5", "", &msgs, &[], 64000);
    assert_eq!(o["fallbacks"], "default");
    assert!(o.get("system").is_none());
    let c = chat_body("openai", "hermes-3", "be brief", &msgs, &[], 64000);
    assert_eq!(c["messages"][0]["role"], "system");
    assert_eq!(c["messages"].as_array().unwrap().len(), 2);
    assert!(c.get("max_tokens").is_none());
}

#[test]
fn a_stream_is_read_piece_by_piece() {
    assert_eq!(parse_piece("anthropic", r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}"#), vec![Piece::Text("Hel".into())]);
    assert_eq!(parse_piece("anthropic", r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}"#), vec![]);
    assert_eq!(parse_piece("anthropic", r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#), vec![Piece::Stop("refusal".into())]);
    assert_eq!(parse_piece("openai", r#"{"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}"#), vec![Piece::Text("lo".into())]);
    assert_eq!(parse_piece("openai", r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"citations":["https://a.example"]}"#), vec![Piece::Stop("stop".into()), Piece::Sources(vec!["https://a.example".into()])]);
    assert_eq!(parse_piece("openai", " [DONE] "), vec![]);
    assert_eq!(parse_piece("openai", r#"{"error":{"message":"bad key"}}"#), vec![Piece::Error("bad key".into())]);
    assert_eq!(parse_piece("anthropic", "not json"), vec![]);
}

#[test]
fn a_turn_that_used_tools_goes_back_whole() {
    let tools = vec![json!({ "name": "search_notes", "description": "d", "input_schema": { "type": "object" } })];
    let raw = json!([{ "type": "thinking", "thinking": "", "signature": "sig" }, { "type": "tool_use", "id": "tu1", "name": "search_notes", "input": { "query": "x" } }]);
    let msgs = vec![
        json!({ "role": "user", "content": "find x" }),
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "tu1", "name": "search_notes", "input": { "query": "x" } }], "raw": raw, "raw_model": "claude-opus-5" }),
        json!({ "role": "tool", "tool_call_id": "tu1", "content": "A.md" }),
        json!({ "role": "tool", "tool_call_id": "tu2", "content": "nope", "is_error": true }),
    ];
    // the model that wrote the turn gets it back exactly, thinking and all
    let a = chat_body("anthropic", "claude-opus-5", "", &msgs, &tools, 64000);
    assert_eq!(a["messages"][1]["content"], raw);
    assert_eq!(a["tools"][0]["input_schema"]["type"], "object");
    // both results ride in ONE user message
    assert_eq!(a["messages"].as_array().unwrap().len(), 3);
    assert_eq!(a["messages"][2]["content"].as_array().unwrap().len(), 2);
    assert_eq!(a["messages"][2]["content"][1]["is_error"], true);
    // another Claude model gets the plain parts, without the foreign thinking
    let b = chat_body("anthropic", "claude-sonnet-5", "", &msgs, &tools, 64000);
    assert_eq!(b["messages"][1]["content"].as_array().unwrap().len(), 1);
    assert_eq!(b["messages"][1]["content"][0]["type"], "tool_use");
    // chat-completions: function calls with string arguments, one tool message each
    let c = chat_body("openai", "hermes-3", "", &msgs, &tools, 64000);
    assert_eq!(c["tools"][0]["function"]["name"], "search_notes");
    assert_eq!(c["messages"][1]["tool_calls"][0]["function"]["arguments"], "{\"query\":\"x\"}");
    assert_eq!(c["messages"][2]["role"], "tool");
    assert_eq!(c["messages"].as_array().unwrap().len(), 4);
}

#[test]
fn pictures_and_documents_ride_with_the_question() {
    let msgs = vec![json!({ "role": "user", "content": "what is this", "images": [{ "media_type": "image/png", "data": "AAAA" }], "docs": [{ "media_type": "application/pdf", "data": "BBBB", "name": "p.pdf" }] })];
    let a = chat_body("anthropic", "claude-opus-5", "", &msgs, &[], 64000);
    let blocks = a["messages"][0]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], "document");
    assert_eq!(blocks[1]["source"]["media_type"], "image/png");
    assert_eq!(blocks[2]["text"], "what is this");
    let o = chat_body("openai", "gpt", "", &msgs, &[], 64000);
    assert_eq!(o["messages"][0]["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA");
}

#[test]
fn tool_calls_are_gathered_from_both_kinds_of_stream() {
    let mut t = Turn::default();
    for d in [
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}"#,
        r#"{"type":"content_block_stop","index":0}"#,
        r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"read_note","input":{}}}"#,
        r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
        r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"A.md\"}"}}"#,
        r#"{"type":"content_block_stop","index":1}"#,
    ] { t.feed("anthropic", d); }
    assert_eq!(t.tool_calls(), vec![json!({ "id": "tu1", "name": "read_note", "input": { "path": "A.md" } })]);
    assert_eq!(t.raw()[0]["signature"], "abc");
    assert_eq!(t.raw()[1]["input"]["path"], "A.md");

    let mut o = Turn::default();
    for d in [
        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_notes","arguments":"{\"qu"}}]}}]}"#,
        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\":\"x\"}"}}]}}]}"#,
    ] { o.feed("openai", d); }
    assert_eq!(o.tool_calls(), vec![json!({ "id": "c1", "name": "search_notes", "input": { "query": "x" } })]);
    assert!(o.raw().is_empty());
}

#[test]
fn a_command_line_is_split_like_a_shell_would() {
    assert_eq!(split_command(r#"claude -p --tools "Read,Grep,Glob""#), vec!["claude", "-p", "--tools", "Read,Grep,Glob"]);
    assert_eq!(split_command(r#""C:\Program Files\x\tool.exe"  --tools """#), vec![r"C:\Program Files\x\tool.exe", "--tools", ""]);
    assert!(split_command("   ").is_empty());
}

#[test]
fn a_program_gets_the_conversation_as_one_text() {
    let one = transcript("be brief", &[json!({ "role": "user", "content": "hi" })]);
    assert_eq!(one, "be brief\n\nhi");
    let many = transcript("", &[json!({ "role": "user", "content": "a" }), json!({ "role": "assistant", "content": "b" }), json!({ "role": "tool", "content": "zzz" }), json!({ "role": "user", "content": "c" })]);
    assert!(many.contains("User: a\n\nAssistant: b\n\n") && many.ends_with("User: c") && !many.contains("zzz"));
}

#[test]
fn a_programs_output_is_read_line_by_line() {
    assert_eq!(parse_cli_line("text", "hello", false), vec![Piece::Text("hello\n".into())]);
    let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}"#;
    assert_eq!(parse_cli_line("claude-json", delta, false), vec![Piece::Text("Hi".into())]);
    assert_eq!(parse_cli_line("claude-json", r#"{"type":"system","subtype":"init"}"#, false), vec![]);
    // the final result repeats the text: it is only used when nothing streamed
    let done = r#"{"type":"result","is_error":false,"result":"Hi there"}"#;
    assert_eq!(parse_cli_line("claude-json", done, true), vec![Piece::Stop("end_turn".into())]);
    assert_eq!(parse_cli_line("claude-json", done, false), vec![Piece::Text("Hi there".into()), Piece::Stop("end_turn".into())]);
    assert_eq!(parse_cli_line("claude-json", r#"{"type":"result","is_error":true,"result":"Not logged in"}"#, false), vec![Piece::Error("Not logged in".into())]);
}

#[test]
fn a_key_is_bound_to_the_server_by_its_real_host() {
    use crate::ai::host_part;
    assert_eq!(host_part("https://api.anthropic.com"), "api.anthropic.com");
    assert_eq!(host_part("https://API.OpenAI.com/v1/"), "api.openai.com");
    // the part before @ is a user name: the server is evil.com
    assert_eq!(host_part("https://api.openai.com@evil.com/v1"), "evil.com");
    assert_eq!(host_part("https://api.openai.com.evil.com/v1"), "api.openai.com.evil.com");
    assert_eq!(host_part("not a url at all"), "");
}

#[test]
fn local_means_the_server_the_request_really_reaches() {
    use crate::ai::{is_local, server_of};
    assert!(is_local("http://localhost:11434/v1"));
    assert!(is_local("http://127.0.0.1:1234"));
    assert!(!is_local("http://localhost:x@evil.com/v1"), "the part before @ is a user name");
    assert!(!is_local("http://localhost.evil.com"));
    // https and http, or another port, are other servers
    assert_eq!(server_of("https://api.openai.com/v1"), "https://api.openai.com");
    assert_ne!(server_of("http://api.openai.com/v1"), server_of("https://api.openai.com/v1"));
    assert_ne!(server_of("https://api.openai.com:8443/v1"), server_of("https://api.openai.com/v1"));
}
