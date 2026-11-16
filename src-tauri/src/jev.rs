//! Jev, TypeSafe's System One model: a question about some state, answered
//! with one of the answers it was given and how sure it is - in a fraction of
//! a second. One endpoint, the user's own key (kept sealed like the other AI
//! keys, under the id "jev"); the request body is the API's own, passed
//! through, so everything the API can ask works from the app.
//! https://docs.typesafe.ai/api
//!
//! The same questions can go to Laya instead (Convai Innovations, Apache-2.0,
//! https://github.com/NandhaKishorM/laya): an open model of the same kind that
//! runs on the user's own computer - `laya-serve` answers `POST /v1/systemone`
//! with the same body and the same answers. Nothing leaves the machine then.
//! Which one is in `~/.leonote/jev.json`, read on every call, so the MCP
//! server follows the app's setting.

use serde_json::Value;
use std::io::Read;
use std::time::{Duration, Instant};

pub const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
pub const MODEL: &str = "jev-latest";
pub const LAYA_BASE: &str = "http://127.0.0.1:8000";

fn config_path() -> std::path::PathBuf {
    crate::store::leonote_dir().join("jev.json")
}

/// Where Jev's questions go: `{ backend: "typesafe" | "laya", base, model }`.
pub fn config() -> Value {
    let v: Value = std::fs::read(config_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let backend = if v.get("backend").and_then(|b| b.as_str()) == Some("laya") { "laya" } else { "typesafe" };
    let base = v.get("base").and_then(|b| b.as_str()).filter(|b| !b.trim().is_empty()).unwrap_or(LAYA_BASE).trim().trim_end_matches('/').to_string();
    let model = v.get("model").and_then(|b| b.as_str()).unwrap_or("").trim().to_string();
    serde_json::json!({ "backend": backend, "base": base, "model": model })
}

#[tauri::command]
pub async fn jev_backend_get() -> Result<Value, String> {
    Ok(config())
}

/// The key and the note go to this address: https anywhere, plain http only on this computer.
fn safe_laya(base: &str) -> bool {
    tauri::Url::parse(base).ok().is_some_and(|u| u.scheme() == "https" || (u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
}

/// TypeSafe's API or a Laya server (an http(s) address; on this computer by default).
#[tauri::command]
pub async fn jev_backend_set(app: tauri::AppHandle, backend: String, base: String, model: String) -> Result<Value, String> {
    let base = if base.trim().is_empty() { LAYA_BASE.to_string() } else { base.trim().trim_end_matches('/').to_string() };
    if !(base.starts_with("http://") || base.starts_with("https://")) || base.len() > 300 || base.contains(char::is_whitespace) {
        return Err("Laya's address starts with http:// - for example http://127.0.0.1:8000".into());
    }
    // only when Laya is what is chosen: switching back to TypeSafe never trips over an old Laya address
    if backend == "laya" && !safe_laya(&base) {
        return Err("Laya on another computer needs an https:// address - over http the key and your notes would cross the network unencrypted".into());
    }
    // Laya's key and the notes go to this address: one that is not on this computer, and new, is the user's to allow
    // (a script in a page could otherwise point it at its own server)
    let local = tauri::Url::parse(&base).ok().is_some_and(|u| matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")));
    // (skipped only for the very address Laya already had: one saved with TypeSafe chosen was never asked about)
    let cfg = config();
    let allowed = cfg["backend"].as_str() == Some("laya") && cfg["base"].as_str() == Some(base.as_str());
    if backend == "laya" && !local && !allowed
        && !crate::grant::ask(&app, "Leonote is asking", &format!("Send Laya's key and the notes it is asked about to this address?\n\n{base}\n\nSay no if you did not just set it in Settings."))
    {
        return Err(format!("Not allowed: {base}"));
    }
    let model: String = model.trim().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')).take(80).collect();
    let v = serde_json::json!({ "backend": if backend == "laya" { "laya" } else { "typesafe" }, "base": base, "model": model });
    let p = config_path();
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(v)
}

/// Install Laya's server with pip, in a console of its own (only when asked).
#[tauri::command]
pub async fn laya_install() -> Result<(), String> {
    #[cfg(windows)]
    {
        let line = "python -m pip install --upgrade \"laya[serve]\" & echo. & echo When it is done, press Start Laya in Leonote. You can close this window. & pause";
        std::process::Command::new(crate::external::program("cmd")).args(["/c", "start", "Installing Laya", "cmd", "/c", line]).spawn().map_err(|e| format!("Could not start the install: {}", e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("install it with: pip install \"laya[serve]\"".into())
}

/// Start `laya-serve` in a console of its own, listening on this computer only
/// (its own default would be every network address).
#[tauri::command]
pub async fn laya_start() -> Result<(), String> {
    let base = config()["base"].as_str().unwrap_or(LAYA_BASE).to_string();
    let port: u16 = base.rsplit(':').next().and_then(|p| p.trim_end_matches('/').parse().ok()).unwrap_or(8000);
    #[cfg(windows)]
    {
        let line = format!("set LAYA_HOST=127.0.0.1&& set LAYA_PORT={port}&& laya-serve || (echo. & echo laya-serve did not start - install it first: pip install \"laya[serve]\" & pause)");
        std::process::Command::new(crate::external::program("cmd")).args(["/c", "start", "Laya", "cmd", "/c", &line]).spawn().map_err(|e| format!("Could not start Laya: {}", e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(format!("start it with: LAYA_HOST=127.0.0.1 LAYA_PORT={port} laya-serve"))
}

/// The request shape both servers take: a state and questions by name.
fn checked(body: &Value) -> Result<(), String> {
    let o = body.as_object().ok_or("the request must be a JSON object")?;
    if !o.contains_key("state") { return Err("the request needs a state".into()); }
    if !o.get("questions").map(|q| q.is_object()).unwrap_or(false) { return Err("the request needs questions, by name".into()); }
    Ok(())
}

/// The body as the API wants it: a model named when none is, nothing else touched.
pub fn with_model(mut body: Value) -> Result<Value, String> {
    checked(&body)?;
    let o = body.as_object_mut().unwrap();
    if !o.get("model").map(|m| m.is_string()).unwrap_or(false) { o.insert("model".into(), Value::String(MODEL.into())); }
    Ok(body)
}

/// The body for Laya: its own checkpoint when one is set, never TypeSafe's model name.
pub fn for_laya(mut body: Value, model: &str) -> Result<Value, String> {
    checked(&body)?;
    let o = body.as_object_mut().unwrap();
    if o.get("model").and_then(|m| m.as_str()).map(|m| m.starts_with("jev")).unwrap_or(false) { o.remove("model"); }
    if !model.is_empty() { o.insert("model".into(), Value::String(model.into())); }
    Ok(body)
}

/// What a failed call means, in words a person can act on.
pub fn explain(code: u16, body: &str) -> String {
    let said = serde_json::from_str::<Value>(body).ok()
        .and_then(|v| v.pointer("/error/message").or_else(|| v.get("detail")).or_else(|| v.get("message")).or_else(|| v.get("error")).map(|m| if let Some(s) = m.as_str() { s.to_string() } else { m.to_string() }))
        .unwrap_or_else(|| body.chars().take(300).collect());
    let lead = match code {
        401 | 403 => "Jev did not accept the key",
        422 => "Jev could not take the question as it was asked",
        429 => "Jev says slow down",
        529 => "Jev is overloaded just now",
        500..=599 => "Jev had a problem of its own",
        _ => "Jev refused the request",
    };
    if said.trim().is_empty() { format!("{} ({}).", lead, code) } else { format!("{} ({}): {}", lead, code, said.trim()) }
}

/// Ask Jev. Rate limits and overload are waited out a few times (as the API
/// asks: backing off, not hammering); the answer comes back as the API gave
/// it, with `latency_ms` - the whole round trip - added for the caller.
#[tauri::command]
pub async fn jev_ask(body: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || ask(body)).await.map_err(|e| e.to_string())?
}

/// The same, where waiting is fine (the MCP server answers one call at a time).
pub fn ask(body: Value) -> Result<Value, String> {
    // Jev switched off in Leonote (Settings › Jev): nothing goes to it - from the app, skills or agents alike
    let p = crate::Paths::resolve();
    if crate::settings::load(&p.settings, &p.vault).get("jevOn").and_then(|v| v.as_bool()) == Some(false) {
        return Err("Jev is switched off in Leonote (Settings › Jev) - the user has chosen not to send anything to it".into());
    }
    let cfg = config();
    let laya = cfg["backend"] == "laya";
    let (url, key, body) = if laya {
        let base = cfg["base"].as_str().unwrap_or(LAYA_BASE);
        // also an address saved before this was checked
        if !safe_laya(base) { return Err("Laya on another computer needs an https:// address (Settings › Jev) - over http the key and your notes would cross the network unencrypted".into()); }
        // a key only when the server was started with LAYA_API_KEY
        (format!("{}/v1/systemone", base), crate::ai::key_of("laya"), for_laya(body, cfg["model"].as_str().unwrap_or(""))?)
    } else {
        (ENDPOINT.to_string(), Some(crate::ai::key_of("jev").ok_or("No Jev key yet: add yours in Leonote, Settings › Jev")?), with_model(body)?)
    };
    let who = if laya { "Laya" } else { "Jev" };
    {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(60)).build();
        let t0 = Instant::now();
        let mut wait = 400u64;
        for attempt in 0..4 {
            let req = agent.post(&url).set("content-type", "application/json");
            let req = match &key { Some(k) => req.set("authorization", &format!("Bearer {}", k)), None => req };
            let res = req.send_json(body.clone());
            match res {
                Ok(r) => {
                    let mut v: Value = r.into_json().map_err(|e| format!("{}'s answer could not be read: {}", who, e))?;
                    if let Some(o) = v.as_object_mut() {
                        o.insert("latency_ms".into(), Value::from(t0.elapsed().as_millis() as u64));
                        o.insert("backend".into(), Value::from(if laya { "laya" } else { "typesafe" }));
                    }
                    return Ok(v);
                }
                Err(ureq::Error::Status(code, resp)) => {
                    let mut text = String::new();
                    let _ = resp.into_reader().take(16_384).read_to_string(&mut text);
                    if (code == 429 || code == 529 || code >= 500) && attempt < 3 {
                        std::thread::sleep(Duration::from_millis(wait));
                        wait *= 2;
                        continue;
                    }
                    return Err(if laya { explain(code, &text).replacen("Jev", "Laya", 1) } else { explain(code, &text) });
                }
                Err(ureq::Error::Transport(t)) => {
                    if attempt < 1 { std::thread::sleep(Duration::from_millis(wait)); continue; }
                    return Err(if laya { format!("Could not reach Laya at {} - is it running? (Settings › Jev › Start Laya): {}", cfg["base"].as_str().unwrap_or(LAYA_BASE), t) } else { format!("Could not reach Jev: {}", t) });
                }
            }
        }
        Err("Jev did not answer".into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn laya_over_plain_http_only_on_this_computer() {
        assert!(super::safe_laya("http://127.0.0.1:8000"));
        assert!(super::safe_laya("http://localhost:8000"));
        assert!(super::safe_laya("https://laya.example"));
        assert!(!super::safe_laya("http://192.168.1.5:8000"));
        assert!(!super::safe_laya("http://127.0.0.1.evil.example:8000"));
        assert!(!super::safe_laya("http://localhost@evil.example"));
    }
    use super::*;
    use serde_json::json;

    #[test]
    fn laya_gets_the_same_body_without_typesafes_model_name() {
        let q = json!({ "state": "billed twice", "questions": { "dept": { "type": "choice", "instructions": "which team?", "criteria": { "billing": "refunds", "tech": "bugs" } } } });
        let b = for_laya(with_model(q.clone()).unwrap(), "").unwrap();
        assert!(b.get("model").is_none(), "jev-latest means nothing to Laya");
        assert_eq!(b["questions"], q["questions"]);
        assert_eq!(for_laya(q.clone(), "laya-multilingual").unwrap()["model"], "laya-multilingual");
        assert!(for_laya(json!({ "questions": {} }), "").is_err());
    }

    #[test]
    fn the_model_is_named_when_the_request_does_not() {
        let b = with_model(json!({ "state": "x", "questions": { "q": { "type": "noul", "instructions": "?" } } })).unwrap();
        assert_eq!(b["model"], MODEL);
        let b = with_model(json!({ "state": "x", "model": "jev-1.13", "questions": {} })).unwrap();
        assert_eq!(b["model"], "jev-1.13");
    }

    #[test]
    fn a_request_without_state_or_questions_is_refused_here() {
        assert!(with_model(json!({ "questions": {} })).is_err());
        assert!(with_model(json!({ "state": "x" })).is_err());
        assert!(with_model(json!("text")).is_err());
    }

    #[test]
    fn errors_say_what_to_do() {
        assert!(explain(401, r#"{"detail":"bad key"}"#).starts_with("Jev did not accept the key (401): bad key"));
        assert!(explain(422, r#"{"error":{"message":"criteria needs 2 options"}}"#).contains("criteria needs 2 options"));
        assert_eq!(explain(529, ""), "Jev is overloaded just now (529).");
    }
}
