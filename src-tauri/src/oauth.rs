//! The loopback half of an OAuth sign-in (Authorization Code with
//! PKCE). The user's browser does the signing in; we only need to catch the
//! one redirect it makes back to this machine.
//!
//! The listener is as small as it can be: bound to 127.0.0.1 on a port the OS
//! picks, it answers exactly one request, hands the query back to the
//! frontend and closes. It is never reachable from outside this computer, it
//! serves one fixed page, and it stops by itself after the timeout even if
//! the user walks away. No secrets pass through it - PKCE means the token
//! exchange happens from the frontend with a verifier that never left it.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

/// A sign-in that takes longer than this was abandoned.
const MAX_WAIT: Duration = Duration::from_secs(300);
/// A request larger than this is not a browser redirect.
const MAX_REQUEST: usize = 8 * 1024;

static PENDING: Mutex<Option<HashMap<u16, Receiver<Value>>>> = Mutex::new(None);

fn page(title: &str, body: &str) -> String {
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{t}</title>\
         <style>body{{font:15px/1.5 system-ui,sans-serif;background:#18181b;color:#ececef;display:grid;place-items:center;height:100vh;margin:0}}\
         div{{text-align:center;max-width:32em;padding:2em}}h1{{font-size:19px;margin:0 0 .4em}}p{{color:#b8b8bf;margin:0}}</style>\
         <div><h1>{t}</h1><p>{b}</p></div>",
        t = title,
        b = body
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
        html.len(),
        html
    )
}

/// `GET /callback?code=...&state=... HTTP/1.1` -> the query pairs.
pub fn parse_request(head: &str) -> Option<HashMap<String, String>> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut out = HashMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    Some(out)
}

fn percent_decode(s: &str) -> String {
    let b = s.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&String::from_utf8_lossy(&b[i + 1..i + 3]), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The request, answered: only the one that carries this sign-in's `state` is told it worked (or was refused).
fn serve_one(stream: &mut TcpStream, state: &str) -> Option<HashMap<String, String>> {
    // short: one connection is served at a time, and a client holding it open would hold the real redirect up
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = [0u8; 1024];
    let mut head = Vec::new();
    while head.len() < MAX_REQUEST {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let q = parse_request(&text).filter(|q| q.get("state").map(String::as_str) == Some(state));
    let reply = match &q {
        Some(q) if q.contains_key("code") => page("You're signed in", "Leonote has what it needs. You can close this tab and go back to the app."),
        Some(q) if q.contains_key("error") => page("Sign-in was refused", "Nothing was changed. You can close this tab and try again in Leonote."),
        _ => page("Nothing to do here", "This page only catches a sign-in redirect for Leonote."),
    };
    let _ = stream.write_all(reply.as_bytes());
    let _ = stream.flush();
    q
}

/// Start listening for one redirect. Returns the port to put in the
/// `redirect_uri`; the answer is collected by `oauth_wait`.
#[tauri::command]
pub async fn oauth_listen(state: String) -> Result<Value, String> {
    // anything on this computer, or a web page in the browser, can reach the port: an answer without this sign-in's
    // state is shown "nothing to do here" and the wait goes on, so it cannot end the sign-in before Google answers
    if state.len() < 16 { return Err("a sign-in needs its state".into()); }
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|e| format!("could not listen on this computer: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // not blocking: the wait below looks at the clock between tries, so a sign-in nobody finishes
    // closes its port at the deadline instead of holding it open until Leonote quits
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // one request, then the socket closes with the thread
        let deadline = std::time::Instant::now() + MAX_WAIT;
        loop {
            if std::time::Instant::now() > deadline {
                let _ = tx.send(json!({ "error": "timeout" }));
                return;
            }
            match listener.accept() {
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
                Ok((mut stream, peer)) => {
                    // a connection taken from a non-blocking listener is non-blocking too on Windows
                    let _ = stream.set_nonblocking(false);
                    if !peer.ip().is_loopback() {
                        continue; // cannot normally happen: we bound to 127.0.0.1
                    }
                    let q = serve_one(&mut stream, &state);
                    let Some(q) = q else { continue };
                    if !q.contains_key("code") && !q.contains_key("error") {
                        continue; // a favicon request, say
                    }
                    let _ = tx.send(json!({
                        "code": q.get("code").cloned().unwrap_or_default(),
                        "state": q.get("state").cloned().unwrap_or_default(),
                        "error": q.get("error").cloned().unwrap_or_default(),
                    }));
                    return;
                }
                Err(_) => {
                    let _ = tx.send(json!({ "error": "the sign-in listener stopped" }));
                    return;
                }
            }
        }
    });
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(port, rx);
    Ok(json!({ "port": port, "redirect": format!("http://127.0.0.1:{}/callback", port) }))
}

/// The other half of a Google sign-in: the code the listener caught (or a
/// refresh token) traded for tokens. Done from here rather than the page so
/// no CORS rule stands in the way; only Google's own token endpoint is ever
/// spoken to, and the answer goes back as it came (status and body) for the
/// frontend to read.
#[tauri::command]
pub async fn google_token(mut form: HashMap<String, String>, slot: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // `slot` (gcal, youtube): the refresh token is sealed by Windows (ai.rs) and never handed back to the
        // page; a plain one still in settings moves into the seal the first time it is used
        let id = slot.map(|s| format!("google-{}", s));
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(25)).build();
        // signing out: the refresh token (the sealed one when none is given) revoked at Google, so it stops working
        // there too and not only here; the caller forgets it afterwards whatever Google answers
        if form.get("grant_type").map(String::as_str) == Some("revoke") {
            let t = form.get("refresh_token").filter(|t| !t.is_empty()).cloned().or_else(|| id.as_deref().and_then(crate::ai::key_of));
            let Some(t) = t else { return Ok(json!({ "status": 200, "body": Value::Null })) };
            let status = match agent.post("https://oauth2.googleapis.com/revoke").send_form(&[("token", t.as_str())]) {
                Ok(r) => r.status(),
                Err(ureq::Error::Status(code, _)) => code,
                Err(e) => return Err(format!("No answer from Google - is this computer online? ({})", e)),
            };
            return Ok(json!({ "status": status, "body": Value::Null }));
        }
        // the Google app's client secret, sealed the same way (Settings › Calendar › Google app)
        if form.get("client_secret").map_or(true, |s| s.is_empty()) {
            if let Some(s) = crate::ai::key_of("google-secret") { form.insert("client_secret".into(), s); }
        }
        if let Some(id) = &id {
            if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
                match form.get("refresh_token").filter(|t| !t.is_empty()).cloned() {
                    Some(t) => { let _ = crate::ai::key_put(id, &t); }
                    None => { form.insert("refresh_token".into(), crate::ai::key_of(id).ok_or("Google's sign-in is no longer on this computer - connect again")?); }
                }
            }
        }
        let pairs: Vec<(&str, &str)> = form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let (status, body) = match agent.post("https://oauth2.googleapis.com/token").send_form(&pairs) {
            Ok(r) => (r.status(), r.into_string().unwrap_or_default()),
            Err(ureq::Error::Status(code, r)) => (code, r.into_string().unwrap_or_default()),
            Err(e) => return Err(format!("No answer from Google - is this computer online? ({})", e)),
        };
        let mut body = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
        if let (Some(id), Some(o)) = (&id, body.as_object_mut()) {
            if let Some(t) = o.get("refresh_token").and_then(|v| v.as_str()).map(String::from) {
                // kept by Windows' seal or not at all: plain in the settings it would go into every backup, and an
                // older sealed one must not stand in for the new one
                if let Err(e) = crate::ai::key_put(id, &t) {
                    // not kept, so not left working on the account either: revoked at Google, as far as it answers
                    let _ = agent.post("https://oauth2.googleapis.com/revoke").send_form(&[("token", t.as_str())]);
                    return Err(format!("the Google sign-in could not be stored securely on this computer ({e}) - nothing was kept"));
                }
                o.remove("refresh_token");
            }
            if crate::ai::key_of(id).is_some() { o.insert("sealed".into(), Value::Bool(true)); }
        }
        Ok(json!({ "status": status, "body": body }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wait for the redirect started by `oauth_listen` on `port`.
#[tauri::command]
pub async fn oauth_wait(port: u16, timeout_ms: Option<u64>) -> Result<Value, String> {
    let rx = PENDING
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|m| m.remove(&port))
        .ok_or("that sign-in is not waiting any more")?;
    let wait = Duration::from_millis(timeout_ms.unwrap_or(180_000)).min(MAX_WAIT);
    let out = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(wait))
        .await
        .map_err(|e| e.to_string())?;
    match out {
        Ok(v) => Ok(v),
        Err(RecvTimeoutError::Timeout) => Err("sign-in timed out".into()),
        Err(RecvTimeoutError::Disconnected) => Err("the sign-in window closed".into()),
    }
}

