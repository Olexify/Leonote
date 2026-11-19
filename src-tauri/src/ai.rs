//! The Assistant's way out to a model: the user's own key, the user's own
//! provider, and nothing sent that the page did not put into the request.
//!
//! Two wire formats cover everything. "anthropic" is the Messages API.
//! "openai" is chat-completions, which OpenAI, Gemini, xAI, Perplexity,
//! OpenRouter, Ollama, LM Studio and llama.cpp all speak - so a local Hermes
//! is the same code path as a hosted model, with a localhost address.
//!
//! The requests are made here rather than in the webview for two reasons: a
//! local server refuses a browser origin it does not know, and a key held
//! here never has to be handed to the page. Keys live in
//! `~/.leonote/ai_keys.json`, each sealed with Windows DPAPI for this user on
//! this computer; they are never in the vault, never in a backup that could
//! be opened elsewhere, and no command returns one.

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashSet::new()))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/* ── keys ─────────────────────────────────────────────────────────────── */

fn keys_path() -> PathBuf {
    crate::store::leonote_dir().join("ai_keys.json")
}

#[cfg(windows)]
pub(crate) fn seal(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, None, None, None, None, 0, &mut out).map_err(|e| format!("could not seal the key: {}", e))?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Ok(v)
    }
}

#[cfg(windows)]
pub(crate) fn unseal(sealed: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: sealed.len() as u32, pbData: sealed.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut out).map_err(|_| "this key was saved by another Windows user or on another computer - enter it again".to_string())?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Ok(v)
    }
}

// A phone: kept as they are in the app's own storage, which Android closes to every other app (the owner's choice,
// 19 November 2026). They never leave it: not in a backup, not in the vault, not in a sync. The hardware keystore later.
#[cfg(target_os = "android")]
pub(crate) fn seal(plain: &[u8]) -> Result<Vec<u8>, String> { Ok(plain.to_vec()) }
#[cfg(target_os = "android")]
pub(crate) fn unseal(sealed: &[u8]) -> Result<Vec<u8>, String> { Ok(sealed.to_vec()) }

#[cfg(not(any(windows, target_os = "android")))]
pub(crate) fn seal(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("keys can only be kept on Windows for now".into())
}
#[cfg(not(any(windows, target_os = "android")))]
pub(crate) fn unseal(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("keys can only be kept on Windows for now".into())
}

fn read_keys() -> Map<String, Value> {
    std::fs::read_to_string(keys_path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn write_keys(m: &Map<String, Value>) -> Result<(), String> {
    let p = keys_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn is_service_key(id: &str) -> bool { id.starts_with("google-") || matches!(id, "jev" | "laya") }

pub(crate) fn key_of(id: &str) -> Option<String> {
    use base64::Engine;
    let sealed = base64::engine::general_purpose::STANDARD.decode(read_keys().get(id)?.as_str()?).ok()?;
    String::from_utf8(unseal(&sealed).ok()?).ok()
}

#[tauri::command]
pub async fn ai_key_set(id: String, key: String, base: Option<String>) -> Result<(), String> {
    use base64::Engine;
    if id.is_empty() || id.starts_with('~') { return Err("not a key's name".into()); }
    let key = key.trim();
    let mut m = read_keys();
    if key.is_empty() {
        m.remove(&id);
        // a removed key is no longer hidden: the next one starts shown
        let left: Vec<Value> = hidden_of(&m).into_iter().filter(|x| x != &id).map(Value::String).collect();
        m.insert(HIDDEN.into(), Value::Array(left));
    } else {
        m.insert(id.clone(), Value::String(base64::engine::general_purpose::STANDARD.encode(seal(key.as_bytes())?)));
    }
    // a key set (or taken away) anew: the server it may go to is the provider's own when it is given with the key
    // (so no call before its first use can tie it to another), else learnt on its first use
    if let Some(Value::Object(h)) = m.get_mut(HOSTS) { h.remove(&id); }
    let host = base.as_deref().map(server_of).unwrap_or_default();
    if !key.is_empty() && !host.is_empty() && !is_service_key(&id) {
        let hosts = m.entry(HOSTS.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(h) = hosts { h.insert(id.clone(), Value::String(host)); }
    }
    write_keys(&m)
}

/// id -> the server a provider's key was first sent to. The key only ever goes there again: a provider whose
/// address was changed (by hand, by a restored backup, by a page that should not have) cannot carry the key
/// elsewhere - its key is entered again for the new address.
const HOSTS: &str = "~hosts";
/// The server an address reaches, as scheme://host:port - https and http, or another port, are other servers.
pub(crate) fn server_of(base: &str) -> String {
    let b = base.trim();
    let full = if b.contains("://") { b.to_string() } else { format!("https://{b}") };
    tauri::Url::parse(&full).ok().filter(|u| u.host_str().is_some()).map(|u| u.origin().ascii_serialization()).unwrap_or_default()
}
pub(crate) fn host_part(base: &str) -> String {
    let b = base.trim();
    let full = if b.contains("://") { b.to_string() } else { format!("https://{b}") };
    tauri::Url::parse(&full).ok().and_then(|u| u.host_str().map(|h| h.trim_end_matches('.').to_ascii_lowercase())).unwrap_or_default()
}
pub(crate) fn key_may_go(id: &str, base: &str) -> Result<(), String> {
    // the Google sign-ins and secret, Jev's and Laya's keys only ever go to their own fixed services (not through
    // here, so never pinned): an address named by the page must not get them as a Bearer
    if is_service_key(id) { return Err("that key belongs to another service and is not sent anywhere else".into()); }
    let host = server_of(base);
    if host.is_empty() { return Err("that address is not a web address".into()); }
    let mut m = read_keys();
    let pinned = m.get(HOSTS).and_then(|h| h.get(id)).and_then(|v| v.as_str()).map(String::from);
    match pinned {
        Some(h) if h == host => Ok(()),
        Some(h) => Err(format!("this provider's key is tied to {h}, and its address is now {host} - enter the key again (Settings › Assistant) to use it there")),
        None => {
            let hosts = m.entry(HOSTS.to_string()).or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(h) = hosts { h.insert(id.to_string(), Value::String(host)); }
            write_keys(&m)
        }
    }
}

/// Seal a secret under `id` (a Google sign-in's refresh token).
pub(crate) fn key_put(id: &str, key: &str) -> Result<(), String> {
    use base64::Engine;
    let mut m = read_keys();
    m.insert(id.into(), Value::String(base64::engine::general_purpose::STANDARD.encode(seal(key.as_bytes())?)));
    write_keys(&m)
}

/// The ids whose keys are hidden for good: used, never shown again.
const HIDDEN: &str = "~hidden";
fn hidden_of(m: &Map<String, Value>) -> Vec<String> {
    m.get(HIDDEN).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Which providers have a key - never the keys themselves.
#[tauri::command]
pub async fn ai_keys_have() -> Result<Vec<String>, String> {
    Ok(read_keys().keys().filter(|k| !k.starts_with('~')).cloned().collect())
}

/// A saved key, to show in its field - unless it was hidden for good (then never again).
#[tauri::command]
pub async fn ai_key_get(id: String) -> Result<Option<String>, String> {
    let m = read_keys();
    // only the keys Settings shows back (Jev's and Laya's, until hidden for good): the speech and Assistant keys and the
    // Google sign-ins are used here, never handed to the page, so a script in it cannot read them either
    if hidden_of(&m).contains(&id) || !matches!(id.as_str(), "jev" | "laya") { return Ok(None); }
    Ok(key_of(&id))
}

/// Hide a saved key for good: it goes on working, but the app never shows it again.
#[tauri::command]
pub async fn ai_key_hide(id: String) -> Result<(), String> {
    let mut m = read_keys();
    if !m.contains_key(&id) { return Err("there is no saved key to hide".into()); }
    let mut h = hidden_of(&m);
    if !h.contains(&id) { h.push(id); }
    m.insert(HIDDEN.into(), Value::Array(h.into_iter().map(Value::String).collect()));
    write_keys(&m)
}

/// Is this key hidden for good?
#[tauri::command]
pub async fn ai_key_hidden(id: String) -> Result<bool, String> {
    Ok(hidden_of(&read_keys()).contains(&id))
}

/* ── the two wire formats ─────────────────────────────────────────────── */

pub fn base_of(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Where a chat request goes.
pub fn chat_url(kind: &str, base: &str) -> String {
    let b = base_of(base);
    if kind == "anthropic" {
        if b.ends_with("/v1") { format!("{}/messages", b) } else { format!("{}/v1/messages", b) }
    } else {
        format!("{}/chat/completions", b)
    }
}

pub fn models_url(kind: &str, base: &str) -> String {
    let b = base_of(base);
    if kind == "anthropic" && !b.ends_with("/v1") { format!("{}/v1/models", b) } else { format!("{}/models", b) }
}

/// Only a computer's own address counts as local: nothing leaves the machine.
pub fn is_local(base: &str) -> bool {
    // read as the request will be ("http://localhost:x@evil.com" goes to evil.com)
    let host = host_part(base);
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1" || host == "0.0.0.0"
}

/// These two decline some requests outright; the server can re-run a declined
/// request on the model Anthropic recommends for that kind of refusal.
fn wants_fallback(model: &str) -> bool {
    model.starts_with("claude-opus-5") || model.starts_with("claude-fable-5-1")
}

/* The page speaks one neutral shape and this turns it into each wire format:
     { role: "user", content, images?: [{ media_type, data }], docs?: [{ media_type, data, name }] }
     { role: "assistant", content, tool_calls?: [{ id, name, input }], raw?, raw_model? }
     { role: "tool", tool_call_id, content, is_error? }
   `raw` is the assistant turn exactly as Anthropic sent it - thinking blocks
   and their signatures included. A turn that used tools has to go back
   unchanged to the model that wrote it, so it is replayed verbatim there and
   rebuilt from its plain parts for any other model. */

fn text_of(m: &Value) -> &str {
    m.get("content").and_then(|c| c.as_str()).unwrap_or("")
}

fn anthropic_messages(model: &str, messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let flush = |out: &mut Vec<Value>, results: &mut Vec<Value>| {
        if !results.is_empty() {
            // every result of one turn goes back in ONE user message
            out.push(json!({ "role": "user", "content": std::mem::take(results) }));
        }
    };
    for m in messages {
        match m.get("role").and_then(|r| r.as_str()).unwrap_or("") {
            "tool" => results.push(json!({
                "type": "tool_result",
                "tool_use_id": m.get("tool_call_id").cloned().unwrap_or(Value::Null),
                "content": text_of(m),
                "is_error": m.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false),
            })),
            "user" => {
                flush(&mut out, &mut results);
                let mut blocks: Vec<Value> = Vec::new();
                for d in m.get("docs").and_then(|d| d.as_array()).into_iter().flatten() {
                    blocks.push(json!({ "type": "document", "title": d.get("name").cloned().unwrap_or(Value::Null), "source": { "type": "base64", "media_type": d.get("media_type").cloned().unwrap_or(json!("application/pdf")), "data": d.get("data").cloned().unwrap_or(Value::Null) } }));
                }
                for i in m.get("images").and_then(|d| d.as_array()).into_iter().flatten() {
                    blocks.push(json!({ "type": "image", "source": { "type": "base64", "media_type": i.get("media_type").cloned().unwrap_or(Value::Null), "data": i.get("data").cloned().unwrap_or(Value::Null) } }));
                }
                if blocks.is_empty() {
                    if !text_of(m).trim().is_empty() { out.push(json!({ "role": "user", "content": text_of(m) })); }
                } else {
                    if !text_of(m).trim().is_empty() { blocks.push(json!({ "type": "text", "text": text_of(m) })); }
                    out.push(json!({ "role": "user", "content": blocks }));
                }
            }
            "assistant" => {
                flush(&mut out, &mut results);
                let same = m.get("raw_model").and_then(|r| r.as_str()) == Some(model);
                if let (true, Some(raw)) = (same, m.get("raw").and_then(|r| r.as_array()).filter(|r| !r.is_empty())) {
                    out.push(json!({ "role": "assistant", "content": raw }));
                    continue;
                }
                let mut blocks: Vec<Value> = Vec::new();
                if !text_of(m).trim().is_empty() { blocks.push(json!({ "type": "text", "text": text_of(m) })); }
                for c in m.get("tool_calls").and_then(|d| d.as_array()).into_iter().flatten() {
                    blocks.push(json!({ "type": "tool_use", "id": c.get("id").cloned().unwrap_or(Value::Null), "name": c.get("name").cloned().unwrap_or(Value::Null), "input": c.get("input").cloned().unwrap_or(json!({})) }));
                }
                if !blocks.is_empty() { out.push(json!({ "role": "assistant", "content": blocks })); }
            }
            _ => {}
        }
    }
    flush(&mut out, &mut results);
    out
}

fn openai_messages(system: &str, messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    if !system.trim().is_empty() {
        out.push(json!({ "role": "system", "content": system }));
    }
    for m in messages {
        match m.get("role").and_then(|r| r.as_str()).unwrap_or("") {
            "tool" => out.push(json!({ "role": "tool", "tool_call_id": m.get("tool_call_id").cloned().unwrap_or(Value::Null), "content": text_of(m) })),
            "user" => {
                let images: Vec<&Value> = m.get("images").and_then(|d| d.as_array()).into_iter().flatten().collect();
                if images.is_empty() {
                    if !text_of(m).trim().is_empty() { out.push(json!({ "role": "user", "content": text_of(m) })); }
                } else {
                    let mut parts = vec![json!({ "type": "text", "text": text_of(m) })];
                    for i in images {
                        parts.push(json!({ "type": "image_url", "image_url": { "url": format!("data:{};base64,{}", i.get("media_type").and_then(|v| v.as_str()).unwrap_or("image/png"), i.get("data").and_then(|v| v.as_str()).unwrap_or("")) } }));
                    }
                    out.push(json!({ "role": "user", "content": parts }));
                }
            }
            "assistant" => {
                let calls: Vec<Value> = m.get("tool_calls").and_then(|d| d.as_array()).into_iter().flatten().map(|c| json!({
                    "id": c.get("id").cloned().unwrap_or(Value::Null), "type": "function",
                    "function": { "name": c.get("name").cloned().unwrap_or(Value::Null), "arguments": c.get("input").cloned().unwrap_or(json!({})).to_string() },
                })).collect();
                if calls.is_empty() {
                    if !text_of(m).trim().is_empty() { out.push(json!({ "role": "assistant", "content": text_of(m) })); }
                } else {
                    out.push(json!({ "role": "assistant", "content": if text_of(m).is_empty() { Value::Null } else { json!(text_of(m)) }, "tool_calls": calls }));
                }
            }
            _ => {}
        }
    }
    out
}

pub fn chat_body(kind: &str, model: &str, system: &str, messages: &[Value], tools: &[Value], max_tokens: u64) -> Value {
    if kind == "anthropic" {
        let mut b = json!({ "model": model, "max_tokens": max_tokens, "stream": true, "messages": anthropic_messages(model, messages) });
        if !system.trim().is_empty() {
            b["system"] = json!(system);
        }
        if !tools.is_empty() {
            b["tools"] = Value::Array(tools.iter().map(|t| json!({ "name": t["name"], "description": t["description"], "input_schema": t["input_schema"] })).collect());
        }
        if wants_fallback(model) {
            b["fallbacks"] = json!("default");
        }
        b
    } else {
        let mut b = json!({ "model": model, "stream": true, "messages": openai_messages(system, messages) });
        if !tools.is_empty() {
            b["tools"] = Value::Array(tools.iter().map(|t| json!({ "type": "function", "function": { "name": t["name"], "description": t["description"], "parameters": t["input_schema"] } })).collect());
        }
        b
    }
}

/// The whole turn, gathered as the stream goes by: the tools the model asked
/// for, and (Anthropic) the turn's blocks exactly as sent, for replaying.
#[derive(Default)]
pub struct Turn {
    blocks: Vec<Value>,
    json_parts: Vec<String>,
    calls: Vec<(String, String, String)>, // openai: id, name, arguments so far
}

impl Turn {
    pub fn feed(&mut self, kind: &str, data: &str) {
        let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { return };
        if kind == "anthropic" {
            let i = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            // the server names the index: a huge one would grow these lists until the app runs out of memory
            if i > 255 { return; }
            match v.get("type").and_then(|t| t.as_str()) {
                Some("content_block_start") => {
                    while self.blocks.len() <= i { self.blocks.push(Value::Null); self.json_parts.push(String::new()); }
                    self.blocks[i] = v.get("content_block").cloned().unwrap_or(Value::Null);
                }
                Some("content_block_delta") if i < self.blocks.len() => {
                    let d = &v["delta"];
                    let add = |b: &mut Value, key: &str, more: &str| { let cur = b.get(key).and_then(|t| t.as_str()).unwrap_or("").to_string(); b[key] = json!(cur + more); };
                    match d.get("type").and_then(|t| t.as_str()) {
                        Some("text_delta") => add(&mut self.blocks[i], "text", d["text"].as_str().unwrap_or("")),
                        Some("thinking_delta") => add(&mut self.blocks[i], "thinking", d["thinking"].as_str().unwrap_or("")),
                        Some("signature_delta") => add(&mut self.blocks[i], "signature", d["signature"].as_str().unwrap_or("")),
                        Some("input_json_delta") => self.json_parts[i].push_str(d["partial_json"].as_str().unwrap_or("")),
                        _ => {}
                    }
                }
                Some("content_block_stop") if i < self.blocks.len() => {
                    if self.blocks[i].get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        let raw = std::mem::take(&mut self.json_parts[i]);
                        self.blocks[i]["input"] = if raw.trim().is_empty() { json!({}) } else { serde_json::from_str(&raw).unwrap_or(json!({ "__invalid_json": raw })) };
                    }
                }
                _ => {}
            }
        } else {
            for c in v.pointer("/choices/0/delta/tool_calls").and_then(|c| c.as_array()).into_iter().flatten() {
                let i = c.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                if i > 255 { continue; } // as above: the server's number, not a size to grow to
                while self.calls.len() <= i { self.calls.push(Default::default()); }
                if let Some(id) = c.get("id").and_then(|x| x.as_str()) { if !id.is_empty() { self.calls[i].0 = id.to_string(); } }
                if let Some(n) = c.pointer("/function/name").and_then(|x| x.as_str()) { self.calls[i].1.push_str(n); }
                if let Some(a) = c.pointer("/function/arguments").and_then(|x| x.as_str()) { self.calls[i].2.push_str(a); }
            }
        }
    }

    /// The tools asked for, in the neutral shape.
    pub fn tool_calls(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self.blocks.iter().filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use")).map(|b| json!({ "id": b["id"], "name": b["name"], "input": b["input"] })).collect();
        for (k, (id, name, args)) in self.calls.iter().enumerate() {
            if name.is_empty() { continue; }
            let input = if args.trim().is_empty() { json!({}) } else { serde_json::from_str(args).unwrap_or(json!({ "__invalid_json": args })) };
            out.push(json!({ "id": if id.is_empty() { format!("call_{}", k) } else { id.clone() }, "name": name, "input": input }));
        }
        out
    }

    pub fn raw(&self) -> Vec<Value> {
        self.blocks.iter().filter(|b| !b.is_null()).cloned().collect()
    }
}

/// What one `data:` line of a stream carries.
#[derive(Debug, PartialEq)]
pub enum Piece {
    Text(String),
    /// the model stopped, and why ("end_turn", "stop", "max_tokens", "refusal", ...)
    Stop(String),
    /// web sources a search model read (Perplexity sends them alongside the text)
    Sources(Vec<String>),
    Error(String),
}

pub fn parse_piece(kind: &str, data: &str) -> Vec<Piece> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return vec![];
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else { return vec![] };
    let mut out = Vec::new();
    if let Some(e) = v.get("error") {
        let msg = e.get("message").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| e.to_string());
        return vec![Piece::Error(msg)];
    }
    if kind == "anthropic" {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("content_block_delta") => {
                if let Some(t) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                    out.push(Piece::Text(t.to_string()));
                }
            }
            Some("message_delta") => {
                if let Some(r) = v.pointer("/delta/stop_reason").and_then(|t| t.as_str()) {
                    out.push(Piece::Stop(r.to_string()));
                }
            }
            _ => {}
        }
    } else {
        if let Some(t) = v.pointer("/choices/0/delta/content").and_then(|t| t.as_str()) {
            if !t.is_empty() {
                out.push(Piece::Text(t.to_string()));
            }
        }
        if let Some(r) = v.pointer("/choices/0/finish_reason").and_then(|t| t.as_str()) {
            out.push(Piece::Stop(r.to_string()));
        }
        if let Some(c) = v.get("citations").and_then(|c| c.as_array()) {
            let urls: Vec<String> = c.iter().filter_map(|u| u.as_str().map(String::from)).collect();
            if !urls.is_empty() {
                out.push(Piece::Sources(urls));
            }
        }
    }
    out
}

fn agent() -> ureq::Agent {
    // a long read timeout: a model that thinks first can be silent for minutes
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(12)).timeout_read(Duration::from_secs(600)).build()
}

fn with_auth(mut req: ureq::Request, kind: &str, model: &str, key: Option<&str>) -> ureq::Request {
    req = req.set("content-type", "application/json");
    if kind == "anthropic" {
        req = req.set("anthropic-version", "2023-06-01");
        if wants_fallback(model) {
            req = req.set("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        if let Some(k) = key {
            req = req.set("x-api-key", k);
        }
    } else if let Some(k) = key {
        req = req.set("authorization", &format!("Bearer {}", k));
    }
    req
}

/// A failed call, said the way a person can act on.
fn explain(code: u16, body: &str, local: bool) -> String {
    let said = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").or_else(|| v.get("error")).or_else(|| v.get("message")).and_then(|m| m.as_str().map(String::from)))
        .unwrap_or_else(|| body.chars().take(300).collect());
    let lead = match code {
        401 | 403 => "The provider did not accept the key",
        404 => "The provider does not know this model or address",
        429 => "The provider says slow down, or the account is out of credit",
        500..=599 => "The provider had a problem of its own",
        _ => "The provider refused the request",
    };
    let _ = local;
    if said.is_empty() { format!("{} ({}).", lead, code) } else { format!("{} ({}): {}", lead, code, said) }
}

fn send_error(e: ureq::Error, local: bool) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let mut body = String::new();
            let _ = resp.into_reader().take(16_384).read_to_string(&mut body);
            explain(code, &body, local)
        }
        ureq::Error::Transport(t) => {
            if local {
                format!("Nothing answered at that address - is the local model server running? ({})", t)
            } else {
                format!("Could not reach the provider: {}", t)
            }
        }
    }
}

/* ── a program on this computer, instead of a server ──────────────────────
   Claude Code, Codex, Gemini CLI and their like sign in with the user's own
   subscription and have a documented way to be asked one thing and answer:
   the question goes in on stdin, the answer comes out on stdout. No key, no
   address - and nothing of Leonote's is involved in the signing in. */

/// A command line as typed, split the way a shell would: spaces separate,
/// double quotes keep a piece together.
pub fn split_command(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in line.trim().chars() {
        match c {
            '"' => { quoted = !quoted; any = true; }
            c if c.is_whitespace() && !quoted => { if any || !cur.is_empty() { out.push(std::mem::take(&mut cur)); any = false; } }
            c => cur.push(c),
        }
    }
    if any || !cur.is_empty() { out.push(cur); }
    out
}

/// The whole conversation as one piece of text, for a program that takes one.
pub fn transcript(system: &str, messages: &[Value]) -> String {
    let turns: Vec<&Value> = messages.iter().filter(|m| matches!(m.get("role").and_then(|r| r.as_str()), Some("user" | "assistant")) && !text_of(m).trim().is_empty()).collect();
    let mut out = String::new();
    if !system.trim().is_empty() {
        out.push_str(system.trim());
        out.push_str("\n\n");
    }
    if turns.len() <= 1 {
        if let Some(m) = turns.first() { out.push_str(text_of(m)); }
        return out;
    }
    out.push_str("The conversation so far:\n\n");
    for m in &turns[..turns.len() - 1] {
        out.push_str(if m["role"] == "user" { "User: " } else { "Assistant: " });
        out.push_str(text_of(m).trim());
        out.push_str("\n\n");
    }
    out.push_str("Answer the user's next message.\n\nUser: ");
    out.push_str(text_of(turns[turns.len() - 1]).trim());
    out
}

/// What one line of a program's output says. `claude -p --output-format
/// stream-json` wraps the Messages stream; anything else is plain text.
pub fn parse_cli_line(format: &str, line: &str, seen_text: bool) -> Vec<Piece> {
    if format != "claude-json" {
        return vec![Piece::Text(format!("{}\n", line))];
    }
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return vec![] };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => v.get("event").map(|e| parse_piece("anthropic", &e.to_string())).unwrap_or_default().into_iter().filter(|p| matches!(p, Piece::Text(_))).collect(),
        Some("result") => {
            let text = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
            if v.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
                vec![Piece::Error(if text.is_empty() { "the program reported an error".into() } else { text.to_string() })]
            } else if !seen_text && !text.is_empty() {
                vec![Piece::Text(text.to_string()), Piece::Stop("end_turn".into())]
            } else {
                vec![Piece::Stop("end_turn".into())]
            }
        }
        _ => vec![],
    }
}

fn children() -> &'static Mutex<std::collections::HashMap<String, std::process::Child>> {
    static C: OnceLock<Mutex<std::collections::HashMap<String, std::process::Child>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn spawn_cli(argv: &[String], cwd: &std::path::Path) -> Result<std::process::Child, String> {
    use std::process::{Command, Stdio};
    let build = |program: &str, args: &[String]| {
        let mut c = Command::new(crate::external::program(program));
        c.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // no console window flashing up
        }
        c
    };
    match build(&argv[0], &argv[1..]).spawn() {
        Ok(c) => Ok(c),
        // an npm-installed tool is a .cmd shim, which only the command interpreter can start
        Err(e) if cfg!(windows) && e.kind() == std::io::ErrorKind::NotFound => {
            let mut all = vec!["/C".to_string()];
            all.extend(argv.iter().cloned());
            // cmd looks in the folder it runs in first, and that may be the vault: a "claude.bat" put there would
            // run instead of the real one. This makes cmd look on PATH only.
            let mut c = build("cmd", &all);
            c.env("NoDefaultCurrentDirectoryInExePath", "1");
            c.spawn().map_err(|_| format!("“{}” was not found on this computer - is it installed, and does it run in a terminal?", argv[0]))
        }
        Err(e) => Err(format!("could not start “{}”: {}", argv[0], e)),
    }
}

/// Ask a program. `look` lets a program that can read files work from the vault folder.
/// The notes a program may read, copied into a folder of their own: every note that is not private to AI
/// (by its own `ai:` line or its folder's), nothing else - no attachments, no hidden folders, no .leonote.
/// At most 64 MB of notes. None when there is no vault.
fn look_copy(id: &str) -> Option<std::path::PathBuf> {
    let p = crate::Paths::resolve();
    if p.vault.as_os_str().is_empty() || !p.vault.is_dir() { return None; }
    let rules = crate::proposals::read_rules(&p.dir);
    let tag: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(32).collect();
    let dir = std::env::temp_dir().join(format!("leonote-look-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let mut total = 0usize;
    for n in crate::vault::scan(&p.vault, Some(&p.dir)).notes {
        if crate::proposals::access_of(&rules, &n.path, Some(&n.content)) == crate::proposals::Access::Private { continue; }
        if n.path.split('/').any(|part| part.is_empty() || part.starts_with('.') || part == "..") { continue; }
        total += n.content.len();
        if total > 64 << 20 { break; }
        let to = dir.join(&n.path);
        if let Some(d) = to.parent() { let _ = std::fs::create_dir_all(d); }
        let _ = std::fs::write(&to, n.content.as_bytes());
    }
    Some(dir)
}
/// The copied notes, removed when the run is over (however it ends).
struct LookDir(Option<std::path::PathBuf>);
impl Drop for LookDir {
    fn drop(&mut self) { if let Some(d) = &self.0 { let _ = std::fs::remove_dir_all(d); } }
}

fn run_cli(app: AppHandle, id: String, command: String, format: String, prompt: String, look: bool) {
    let emit = |v: Value| { let _ = app.emit("ai", v); };
    let argv = split_command(&command);
    if argv.is_empty() {
        return emit(json!({ "id": id, "type": "error", "message": "this provider has no command yet" }));
    }
    // "Can look through the vault": the program reads files itself, so it gets a copy of only the notes AI may
    // see - never the vault folder, where it would also find the private notes, .leonote (settings, history,
    // sign-ins) and anything else lying there. The copy goes when the answer is done.
    let look_dir = if look { look_copy(&id) } else { None };
    let _gone = LookDir(look_dir.clone());
    let cwd = look_dir.unwrap_or_else(std::env::temp_dir);
    let mut child = match spawn_cli(&argv, &cwd) {
        Ok(c) => c,
        Err(m) => return emit(json!({ "id": id, "type": "error", "message": m })),
    };
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    lock(children()).insert(id.clone(), child);
    let errs = std::thread::spawn(move || { let mut s = String::new(); if let Some(e) = stderr { let _ = e.take(8192).read_to_string(&mut s); } s });
    let mut seen = false;
    let mut failed: Option<String> = None;
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            for piece in parse_cli_line(&format, &line, seen) {
                match piece {
                    Piece::Text(t) => { seen = true; emit(json!({ "id": id, "type": "text", "text": t })); }
                    Piece::Error(m) => failed = Some(m),
                    _ => {}
                }
            }
        }
    }
    let status = lock(children()).remove(&id).and_then(|mut c| c.wait().ok());
    let said = errs.join().unwrap_or_default();
    if lock(cancelled()).remove(&id) {
        return emit(json!({ "id": id, "type": "done", "stop": "cancelled" }));
    }
    if let Some(m) = failed {
        return emit(json!({ "id": id, "type": "error", "message": m }));
    }
    if !seen || status.map(|s| !s.success()).unwrap_or(false) {
        let why = said.trim();
        return emit(json!({ "id": id, "type": "error", "message": if why.is_empty() { format!("“{}” gave no answer. Run it once in a terminal to check it is signed in.", argv[0]) } else { format!("“{}” said: {}", argv[0], why.chars().take(600).collect::<String>()) } }));
    }
    emit(json!({ "id": id, "type": "done", "stop": "end_turn" }));
}

/// Ask, and stream the answer back as `ai` events carrying the request's id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_chat(app: AppHandle, id: String, provider: String, kind: String, base: String, model: String, system: Option<String>, messages: Vec<Value>, tools: Option<Vec<Value>>, max_tokens: Option<u64>, format: Option<String>, look: Option<bool>) -> Result<(), String> {
    if kind == "cli" {
        // the program behind a chat runs as the user: asked about once per command (the tool switch after it aside)
        let core = base.trim().trim_end_matches(" --tools \"Read,Grep,Glob\"").trim_end_matches(" --tools \"\"").to_string();
        crate::grant::allow_program(&app, &core, "for the AI chat")?;
        let prompt = transcript(system.as_deref().unwrap_or(""), &messages);
        lock(cancelled()).remove(&id);
        std::thread::spawn(move || run_cli(app, id, base, format.unwrap_or_else(|| "text".into()), prompt, look.unwrap_or(false)));
        return Ok(());
    }
    if model.trim().is_empty() {
        return Err("choose a model first".into());
    }
    let local = is_local(&base);
    let key = key_of(&provider);
    if key.is_none() && !local {
        return Err("this provider has no key yet - add one in Settings › Assistant".into());
    }
    if key.is_some() {
        key_may_go(&provider, &base)?;
    }
    let url = chat_url(&kind, &base);
    let body = chat_body(&kind, model.trim(), system.as_deref().unwrap_or(""), &messages, tools.as_deref().unwrap_or(&[]), max_tokens.unwrap_or(64_000));
    lock(cancelled()).remove(&id);
    std::thread::spawn(move || {
        let emit = |v: Value| { let _ = app.emit("ai", v); };
        let req = with_auth(agent().post(&url), &kind, model.trim(), key.as_deref());
        let resp = match req.send_json(body) {
            Ok(r) => r,
            Err(e) => return emit(json!({ "id": id, "type": "error", "message": send_error(e, local) })),
        };
        let mut stop = String::new();
        let mut sources: Vec<String> = Vec::new();
        let mut turn = Turn::default();
        for line in BufReader::new(resp.into_reader()).lines() {
            if lock(cancelled()).remove(&id) {
                return emit(json!({ "id": id, "type": "done", "stop": "cancelled" }));
            }
            let Ok(line) = line else { break };
            let Some(data) = line.strip_prefix("data:") else { continue };
            turn.feed(&kind, data);
            for piece in parse_piece(&kind, data) {
                match piece {
                    Piece::Text(t) => emit(json!({ "id": id, "type": "text", "text": t })),
                    Piece::Stop(r) => stop = r,
                    Piece::Sources(s) => sources = s,
                    Piece::Error(m) => return emit(json!({ "id": id, "type": "error", "message": m })),
                }
            }
        }
        emit(json!({ "id": id, "type": "done", "stop": stop, "sources": sources, "tool_calls": turn.tool_calls(), "raw": if kind == "anthropic" { turn.raw() } else { Vec::new() } }));
    });
    Ok(())
}

#[tauri::command]
pub async fn ai_cancel(id: String) -> Result<(), String> {
    // a program is stopped outright; its reader then sees the end of its output
    if let Some(c) = lock(children()).get_mut(&id) {
        let _ = c.kill();
    }
    lock(cancelled()).insert(id);
    Ok(())
}

/// The models a provider offers, so nobody has to type an id from memory.
#[tauri::command]
pub async fn ai_models(provider: String, kind: String, base: String) -> Result<Vec<String>, String> {
    let local = is_local(&base);
    let key = key_of(&provider);
    if key.is_none() && !local {
        return Err("add a key first".into());
    }
    if key.is_some() { key_may_go(&provider, &base)?; }
    let req = with_auth(agent().get(&models_url(&kind, &base)), &kind, "", key.as_deref());
    let v: Value = req.call().map_err(|e| send_error(e, local))?.into_json().map_err(|e| e.to_string())?;
    let list = v.get("data").or_else(|| v.get("models")).and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let mut ids: Vec<String> = list.iter().filter_map(|m| m.get("id").or_else(|| m.get("name")).and_then(|i| i.as_str()).map(|s| s.trim_start_matches("models/").to_string())).collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// What an MCP client needs to start Leonote as a server: this very program,
/// with `--mcp`. Shown in the Assistant for copying into the client's config.
#[tauri::command]
pub async fn mcp_command() -> Result<Value, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(json!({ "command": exe.to_string_lossy(), "args": ["--mcp"] }))
}

#[cfg(test)]
mod key_tests {
    #[test]
    fn a_service_key_is_never_sent_to_an_address_the_page_names() {
        for id in ["google-gcal", "google-youtube", "google-secret", "jev", "laya"] {
            assert!(super::key_may_go(id, "https://evil.example").is_err(), "{id}");
        }
    }
}

#[cfg(test)]
mod shown_tests {
    #[test]
    fn only_the_keys_settings_shows_are_handed_to_the_page() {
        for id in ["speech-openai", "openai-123", "google-gcal", "anything"] {
            assert_eq!(tauri::async_runtime::block_on(super::ai_key_get(id.into())).unwrap(), None, "{id}");
        }
    }
}
