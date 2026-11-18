//! Google Drive, the user's own: signing in and the few calls the sync needs. Only the `drive.file` scope is asked
//! for, so Leonote sees the files it made itself and nothing else on the user's Drive (Google's lighter category: no
//! paid security review). Sign-in is Google's own page in the user's browser, answered to a one-time address on this
//! computer (127.0.0.1, PKCE): Leonote never sees the password. The refresh token is sealed by Windows.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::time::Duration;

/// The app's Google sign-in ID (a "Desktop app" OAuth client). Empty until the owner makes one in Google Cloud:
/// sync then says it is not set up in this build. Google treats a desktop client's "secret" as not secret.
pub const CLIENT_ID: &str = "";
pub const CLIENT_SECRET: &str = "";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const FOLDER: &str = "application/vnd.google-apps.folder";

pub fn ready() -> Result<(), String> {
    if CLIENT_ID.is_empty() { Err("Drive sync is not set up in this build yet.".into()) } else { Ok(()) }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().https_only(true).timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(120)).build()
}
fn err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => "Google signed Leonote out - sign in to Drive again.".into(),
        ureq::Error::Status(403, r) => format!("Google refused: {}", r.into_string().unwrap_or_default().chars().take(300).collect::<String>()),
        ureq::Error::Status(c, r) => format!("Drive answered {c}: {}", r.into_string().unwrap_or_default().chars().take(300).collect::<String>()),
        e => format!("Could not reach Google Drive: {e}"),
    }
}

/* ── signing in ─────────────────────────────────────────────────────────── */

fn b64url(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}
fn random(n: usize) -> Result<String, String> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(b64url(&b))
}

/// The PKCE pair: the verifier kept here, its SHA-256 sent with the sign-in.
pub fn pkce() -> Result<(String, String), String> {
    use sha2::{Digest, Sha256};
    let verifier = random(48)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

/// Opens Google's sign-in in the browser (`open`), waits up to five minutes for its answer on a one-time port
/// here, and returns the refresh token. The answer must carry the `state` made here, or it is not ours.
pub fn sign_in(open: impl FnOnce(&str) -> Result<(), String>) -> Result<String, String> {
    ready()?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    let (verifier, challenge) = pkce()?;
    let state = random(16)?;
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        enc(CLIENT_ID), enc(&redirect), enc(SCOPE), challenge, state
    );
    open(&url)?;
    // looked at every fifth of a second, so a tab closed without answering ends the wait at the deadline
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    let code = loop {
        if std::time::Instant::now() > deadline { return Err("Signing in to Google took too long - try again.".into()); }
        let mut s = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(200)); continue; }
            Err(e) => return Err(e.to_string()),
        };
        s.set_nonblocking(false).ok();
        s.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let mut buf = [0u8; 4096];
        let n = s.read(&mut buf).unwrap_or(0);
        let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
        let q = query(&line);
        if q.get("state").map(String::as_str) != Some(state.as_str()) {
            let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue; // not the answer to our sign-in (another program, a stale tab): waited on
        }
        let page = if q.contains_key("code") { "Leonote is connected to your Google Drive. You can close this tab." } else { "Google Drive was not connected. You can close this tab." };
        let body = format!("<!doctype html><meta charset=utf-8><title>Leonote</title><p style=\"font:16px system-ui;margin:3em\">{page}</p>");
        let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
        match q.get("code") {
            Some(c) => break c.clone(),
            None => return Err(format!("Google did not connect Drive ({}).", q.get("error").cloned().unwrap_or_else(|| "no reason given".into()))),
        }
    };
    let r: Value = agent().post("https://oauth2.googleapis.com/token")
        .send_form(&[("code", &code), ("client_id", CLIENT_ID), ("client_secret", CLIENT_SECRET), ("code_verifier", &verifier), ("redirect_uri", &redirect), ("grant_type", "authorization_code")])
        .map_err(err)?.into_json().map_err(|e| e.to_string())?;
    r["refresh_token"].as_str().map(String::from).ok_or_else(|| "Google gave no lasting sign-in - try again.".into())
}

/// A fresh access token (an hour) from the kept refresh token.
pub fn access(refresh: &str) -> Result<String, String> {
    let r: Value = agent().post("https://oauth2.googleapis.com/token")
        .send_form(&[("refresh_token", refresh), ("client_id", CLIENT_ID), ("client_secret", CLIENT_SECRET), ("grant_type", "refresh_token")])
        .map_err(err)?.into_json().map_err(|e| e.to_string())?;
    r["access_token"].as_str().map(String::from).ok_or_else(|| "Google signed Leonote out - sign in to Drive again.".into())
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(v) => { out.push(v); i += 2; }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
/// The query of a request line ("GET /?code=..&state=.. HTTP/1.1").
fn query(line: &str) -> BTreeMap<String, String> {
    let target = line.split(' ').nth(1).unwrap_or("");
    let q = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    q.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (dec(k), dec(v))).collect()
}

/* ── the files ──────────────────────────────────────────────────────────── */

#[derive(Debug, Clone)]
pub struct File { pub id: String, pub name: String, pub parent: String, pub md5: String, pub folder: bool }

/// Every file and folder Leonote made on this Drive and not binned (drive.file shows nothing else).
pub fn list(token: &str) -> Result<Vec<File>, String> {
    let mut out = Vec::new();
    let mut page = String::new();
    loop {
        let mut req = agent().get(&format!("{API}/files"))
            .set("Authorization", &format!("Bearer {token}"))
            .query("q", "trashed = false")
            .query("fields", "nextPageToken,files(id,name,parents,md5Checksum,mimeType)")
            .query("pageSize", "1000")
            .query("spaces", "drive");
        if !page.is_empty() { req = req.query("pageToken", &page); }
        let r: Value = req.call().map_err(err)?.into_json().map_err(|e| e.to_string())?;
        for f in r["files"].as_array().into_iter().flatten() {
            out.push(File {
                id: f["id"].as_str().unwrap_or("").into(),
                name: f["name"].as_str().unwrap_or("").into(),
                parent: f["parents"][0].as_str().unwrap_or("").into(),
                md5: f["md5Checksum"].as_str().unwrap_or("").into(),
                folder: f["mimeType"] == FOLDER,
            });
        }
        match r["nextPageToken"].as_str() { Some(p) => page = p.into(), None => return Ok(out) }
    }
}

/// The vault's files under `root` (Leonote's folder), by path ("Notes/a.md"), with the folders by path too.
/// Google's own documents (no MD5) are left out: they are not files Leonote can hold.
pub fn tree(files: &[File], root: &str) -> (BTreeMap<String, File>, BTreeMap<String, String>) {
    let by_id: BTreeMap<&str, &File> = files.iter().map(|f| (f.id.as_str(), f)).collect();
    let path_of = |f: &File| -> Option<String> {
        let mut parts = vec![f.name.clone()];
        let mut p = f.parent.as_str();
        for _ in 0..64 {
            if p == root { parts.reverse(); return Some(parts.join("/")); }
            let up = by_id.get(p)?;
            parts.push(up.name.clone());
            p = up.parent.as_str();
        }
        None
    };
    let (mut docs, mut dirs) = (BTreeMap::new(), BTreeMap::new());
    for f in files {
        let Some(p) = path_of(f) else { continue };
        if f.folder { dirs.insert(p, f.id.clone()); } else if !f.md5.is_empty() { docs.insert(p, f.clone()); }
    }
    (docs, dirs)
}

pub fn make_folder(token: &str, name: &str, parent: Option<&str>) -> Result<String, String> {
    let mut meta = json!({ "name": name, "mimeType": FOLDER });
    if let Some(p) = parent { meta["parents"] = json!([p]); }
    let r: Value = agent().post(&format!("{API}/files?fields=id")).set("Authorization", &format!("Bearer {token}")).send_json(meta).map_err(err)?.into_json().map_err(|e| e.to_string())?;
    r["id"].as_str().map(String::from).ok_or_else(|| "Drive made no folder".into())
}

pub fn download(token: &str, id: &str) -> Result<Vec<u8>, String> {
    let r = agent().get(&format!("{API}/files/{id}?alt=media")).set("Authorization", &format!("Bearer {token}")).call().map_err(err)?;
    let mut out = Vec::new();
    r.into_reader().take(512 << 20).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// A new file in `parent`, or new bytes for `id`. Returns its id and the MD5 Drive computed.
pub fn upload(token: &str, id: Option<&str>, name: &str, parent: &str, bytes: &[u8]) -> Result<(String, String), String> {
    let auth = format!("Bearer {token}");
    let r: Value = match id {
        Some(id) => agent().request("PATCH", &format!("{UPLOAD}/files/{id}?uploadType=media&fields=id,md5Checksum")).set("Authorization", &auth).send_bytes(bytes),
        None => {
            let b = format!("leonote{}", random(12)?.replace(['-', '_'], "x"));
            let meta = json!({ "name": name, "parents": [parent] }).to_string();
            let mut body = format!("--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{b}\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
            body.extend_from_slice(bytes);
            body.extend_from_slice(format!("\r\n--{b}--").as_bytes());
            agent().post(&format!("{UPLOAD}/files?uploadType=multipart&fields=id,md5Checksum")).set("Authorization", &auth).set("Content-Type", &format!("multipart/related; boundary={b}")).send_bytes(&body)
        }
    }.map_err(err)?.into_json().map_err(|e| e.to_string())?;
    Ok((r["id"].as_str().unwrap_or("").into(), r["md5Checksum"].as_str().unwrap_or("").into()))
}

/// To Drive's bin, where the user can get it back for 30 days.
pub fn bin(token: &str, id: &str) -> Result<(), String> {
    agent().request("PATCH", &format!("{API}/files/{id}")).set("Authorization", &format!("Bearer {token}")).send_json(json!({ "trashed": true })).map_err(err)?;
    Ok(())
}


/* ── the commands Settings uses ─────────────────────────────────────────── */

fn token_file() -> std::path::PathBuf { crate::store::leonote_dir().join("drive_token") }
fn state_file() -> std::path::PathBuf { crate::store::leonote_dir().join("drive-sync.json") }
/// One sync at a time: a second press waits its turn instead of running beside the first.
static SYNCING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// { ready: this build can sign in, connected: a sign-in is kept here }
#[tauri::command]
pub fn drive_status() -> Value {
    json!({ "ready": ready().is_ok(), "connected": token_file().is_file() })
}

/// Google's sign-in in the browser; the lasting sign-in it gives is sealed by Windows and kept in ~/.leonote.
#[tauri::command]
pub async fn drive_connect(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        let refresh = sign_in(|url| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()))?;
        let sealed = crate::ai::seal(refresh.as_bytes())?;
        let _ = std::fs::create_dir_all(crate::store::leonote_dir());
        std::fs::write(token_file(), sealed).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Signs Drive out here: the kept sign-in goes. What was synced stays, on both sides.
#[tauri::command]
pub fn drive_disconnect() -> Result<(), String> {
    match std::fs::remove_file(token_file()) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) }
}

/// One sync of the vault; `sure` when the user confirmed a plan the brake stopped.
#[tauri::command]
pub async fn drive_sync(state: tauri::State<'_, crate::AppState>, sure: Option<bool>) -> Result<Value, String> {
    let vault = state.paths.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _one = SYNCING.lock().map_err(|e| e.to_string())?;
        let sealed = std::fs::read(token_file()).map_err(|_| "Connect Google Drive first.".to_string())?;
        let refresh = String::from_utf8(crate::ai::unseal(&sealed)?).map_err(|e| e.to_string())?;
        let now = chrono::Local::now();
        let d = crate::drivesync::sync(&vault, &state_file(), &refresh, &now.format("%Y-%m-%d %H%M").to_string(), &now.format("%Y-%m-%d %H%M%S").to_string(), sure.unwrap_or(false))?;
        Ok(json!({ "up": d.up, "down": d.down, "both": d.both, "binned": d.binned, "failed": d.failed }))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn f(id: &str, name: &str, parent: &str, md5: &str, folder: bool) -> File { File { id: id.into(), name: name.into(), parent: parent.into(), md5: md5.into(), folder } }
    #[test]
    fn paths_are_built_from_the_folders_up_to_leonotes_own() {
        let files = [f("R", "Leonote", "my-drive", "", true), f("d1", "Notes", "R", "", true), f("a", "a.md", "d1", "m1", false), f("b", "b.md", "R", "m2", false),
            f("g", "Doc", "R", "", false), f("x", "elsewhere.md", "other", "m3", false)];
        let (docs, dirs) = tree(&files, "R");
        assert_eq!(docs.keys().cloned().collect::<Vec<_>>(), ["Notes/a.md", "b.md"], "Google's own documents and files outside the folder are left out");
        assert_eq!(dirs.get("Notes").map(String::as_str), Some("d1"));
    }
    #[test]
    fn the_sign_in_answer_is_read_from_the_request_line() {
        let q = query("GET /?state=abc&code=4%2F0Ab_x%20y HTTP/1.1");
        assert_eq!(q.get("code").map(String::as_str), Some("4/0Ab_x y"));
        assert_eq!(q.get("state").map(String::as_str), Some("abc"));
        assert_eq!(enc("http://127.0.0.1:5"), "http%3A%2F%2F127.0.0.1%3A5");
    }
    #[test]
    fn pkce_is_the_sha256_of_the_verifier() {
        use sha2::{Digest, Sha256};
        let (v, c) = pkce().unwrap();
        assert!(v.len() >= 43 && v.len() <= 128, "RFC 7636 length");
        assert_eq!(c, b64url(&Sha256::digest(v.as_bytes())));
    }
}
