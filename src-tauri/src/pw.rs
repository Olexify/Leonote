//! Passwords behind a master password: `~/.leonote/passwords.age`, encrypted with age's scrypt
//! passphrase mode (the same as backups). The master password is never written anywhere. While
//! unlocked the list lives in this process only, and locks itself after five idle minutes - checked
//! on every call, no timer. The page asks for one password at a time, when it is shown or copied.

use age::secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const IDLE: Duration = Duration::from_secs(5 * 60);
pub const LOCKED: &str = "locked";

struct Open { master: SecretString, items: Vec<Value>, used: Instant }
static OPEN: Mutex<Option<Open>> = Mutex::new(None);

fn file() -> PathBuf { crate::store::leonote_dir().join("passwords.age") }

fn seal(items: &[Value], master: &SecretString) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut w = crate::backup::encryptor(master.expose_secret()).wrap_output(&mut out).map_err(|e| e.to_string())?;
    w.write_all(&serde_json::to_vec(items).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    w.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

fn unseal(bytes: &[u8], master: &str) -> Result<Vec<Value>, String> {
    let d = age::Decryptor::new(bytes).map_err(|_| "the passwords file is damaged".to_string())?;
    let id = age::scrypt::Identity::new(SecretString::from(master.to_string()));
    let mut r = d.decrypt(std::iter::once(&id as &dyn age::Identity)).map_err(|_| crate::backup::WRONG_PASSWORD.to_string())?;
    let mut plain = Vec::new();
    r.read_to_end(&mut plain).map_err(|_| crate::backup::WRONG_PASSWORD.to_string())?;
    serde_json::from_slice(&plain).map_err(|_| "the passwords file is damaged".to_string())
}

/// The vault locks itself five idle minutes after its last use - not only at the next call: one thread sleeps
/// until that moment, looks again (a use in between moves it on), and locks, the master password and the list
/// dropped from memory. It ends with the lock; one at a time.
static WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn watch_idle() {
    use std::sync::atomic::Ordering::SeqCst;
    if WATCHING.swap(true, SeqCst) { return; }
    std::thread::spawn(|| loop {
        let wait = {
            let mut g = OPEN.lock().unwrap_or_else(|e| e.into_inner());
            match g.as_ref() {
                None => { WATCHING.store(false, SeqCst); return; }
                Some(o) if o.used.elapsed() >= IDLE => { *g = None; WATCHING.store(false, SeqCst); return; }
                Some(o) => IDLE - o.used.elapsed(),
            }
        };
        std::thread::sleep(wait + Duration::from_millis(250));
    });
}

/// The open list, if it is open and was used in the last five minutes.
fn with_open<T>(f: impl FnOnce(&mut Open) -> Result<T, String>) -> Result<T, String> {
    let mut g = crate::lock(&OPEN);
    if g.as_ref().is_some_and(|o| o.used.elapsed() > IDLE) { *g = None; }
    let o = g.as_mut().ok_or(LOCKED)?;
    o.used = Instant::now();
    f(o)
}

fn save(o: &Open) -> Result<(), String> {
    crate::vault::write_atomic(&file(), &seal(&o.items, &o.master)?).map_err(|e| format!("Could not save the passwords: {}", e))
}

/// What the page shows: everything but the passwords themselves.
fn shown(items: &[Value]) -> Value {
    json!(items.iter().map(|x| { let mut x = x.clone(); if let Some(m) = x.as_object_mut() { m.remove("password"); } x }).collect::<Vec<_>>())
}

#[tauri::command]
pub fn pw_status() -> Value {
    // earlier builds could keep the master password sealed for Windows Hello here; Leonote no longer has that
    let _ = std::fs::remove_file(crate::store::leonote_dir().join("passwords-hello.bin"));
    // looked at, not used: asking whether it is open must not keep it open (the page asks on every visit)
    let open = crate::lock(&OPEN).as_ref().is_some_and(|o| o.used.elapsed() <= IDLE);
    json!({ "exists": file().is_file(), "open": open })
}

/// Unlock with the master password, or make the file when there is none yet.
#[tauri::command]
pub async fn pw_unlock(master: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || unlock(master)).await.map_err(|e| e.to_string())?
}

fn unlock(master: String) -> Result<Value, String> {
    {
        if master.chars().count() < 8 { return Err("The master password needs 8 characters or more".into()); }
        let items = match std::fs::read(file()) {
            Ok(b) => unseal(&b, &master)?,
            // a new vault: 12 or more (one made with 8 under an older build still opens)
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && master.chars().count() < 12 => return Err("A new master password needs 12 characters or more - a short sentence is easy to remember".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let o = Open { master: SecretString::from(master.clone()), items: vec![], used: Instant::now() };
                save(&o)?;
                vec![]
            }
            Err(e) => return Err(e.to_string()),
        };
        let list = shown(&items);
        *crate::lock(&OPEN) = Some(Open { master: SecretString::from(master), items, used: Instant::now() });
        watch_idle();
        Ok(list)
    }
}

/// A forgotten master password: the vault is put aside (never deleted - remembered later, it still
/// opens it, renamed back) and a new, empty one is made with the next master password.
#[tauri::command]
pub fn pw_reset() -> Result<String, String> {
    pw_lock();
    let f = file();
    if !f.is_file() { return Ok(String::new()); }
    let to = f.with_file_name(format!("passwords forgotten {}.age", chrono::Local::now().format("%Y-%m-%d %H%M%S")));
    std::fs::rename(&f, &to).map_err(|e| format!("Could not put the old vault aside: {}", e))?;
    Ok(to.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn pw_lock() { *crate::lock(&OPEN) = None; }

#[tauri::command]
pub fn pw_list() -> Result<Value, String> { with_open(|o| Ok(shown(&o.items))) }

/// One password, for showing or copying.
#[tauri::command]
pub fn pw_reveal(id: String) -> Result<String, String> {
    with_open(|o| Ok(o.items.iter().find(|x| x["id"] == id.as_str()).and_then(|x| x["password"].as_str()).unwrap_or("").to_string()))
}

/// One entry's password onto the clipboard - from here, so it never passes through the page - kept out of the
/// clipboard history and the cloud, and taken off after 30 seconds unless something else was copied since.
#[tauri::command]
pub fn pw_copy(id: String) -> Result<(), String> {
    let pass = pw_reveal(id)?;
    if pass.is_empty() { return Err("That entry has no password".into()); }
    crate::clip::copy_secret(&pass, std::time::Duration::from_secs(30))
}

/// What is selected in the entry form's password box, copied the same safe way.
#[tauri::command]
pub fn pw_copy_text(text: String) -> Result<(), String> {
    crate::clip::copy_secret(&text, std::time::Duration::from_secs(30))
}

/// Add or change one (by id); a password left out keeps the one it had.
#[tauri::command]
pub async fn pw_put(item: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || with_open(|o| {
        let id = item["id"].as_str().filter(|s| !s.is_empty()).map(String::from)
            .unwrap_or_else(|| format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
        let mut next = json!({ "id": id, "site": item["site"], "user": item["user"], "note": item["note"], "password": item["password"] });
        match o.items.iter_mut().find(|x| x["id"] == id.as_str()) {
            Some(x) => { if next["password"].is_null() { next["password"] = x["password"].clone(); } *x = next; }
            None => o.items.push(next),
        }
        save(o)?;
        Ok(shown(&o.items))
    })).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pw_remove(id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || with_open(|o| {
        o.items.retain(|x| x["id"] != id.as_str());
        save(o)?;
        Ok(shown(&o.items))
    })).await.map_err(|e| e.to_string())?
}

/// "https://www.github.com/login" and "github.com" are both github.com. Parsed as a URL, so a
/// "github.com:x@evil.com" address is evil.com (the part before @ is a user name, not the host).
fn host_of(s: &str) -> String {
    let s = s.trim();
    let full = if s.contains("://") { s.to_string() } else { format!("https://{}", s) };
    let h = tauri::Url::parse(&full).ok().and_then(|u| u.host_str().map(|h| h.trim_end_matches('.').to_ascii_lowercase())).unwrap_or_default();
    h.strip_prefix("www.").map(String::from).unwrap_or(h)
}
/// A page on the entry's site (or a subdomain of it).
fn same_site(page: &str, site: &str) -> bool {
    let (p, s) = (host_of(page), host_of(site));
    !s.is_empty() && (p == s || p.ends_with(&format!(".{}", s)))
}

/// Came over https, or from this computer itself (a local test server).
fn secure_page(page: &str) -> bool {
    let Ok(u) = tauri::Url::parse(page) else { return false };
    u.scheme() == "https" || (u.scheme() == "http" && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
}

/// Fills the page's sign-in fields: the visible password field, and the text field before it (or, on a
/// page asking for the name first, the likeliest name field). Set the way typing does, so the page's
/// script notices.
const FILL_JS: &str = r#"(function(u,p){var vis=function(e){return e.offsetParent!==null&&!e.disabled&&!e.readOnly};var set=function(e,v){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};var pw=Array.prototype.find.call(document.querySelectorAll('input[type=password]'),vis);var scope=(pw&&pw.form)||document;var users=Array.prototype.filter.call(scope.querySelectorAll('input[type=email],input[type=text],input[type=tel],input:not([type])'),vis);var un=null;if(pw){users.forEach(function(e){if(e.compareDocumentPosition(pw)&4)un=e})}else{un=users.find(function(e){return /user|mail|login|name|phone|account/i.test(e.name+e.id+e.autocomplete+e.placeholder)})||users[0]}if(un&&u)set(un,u);if(pw&&p)set(pw,p);var f=pw||un;if(f)f.focus()})"#;

/// A sign-in seen in a web tab, waiting for a yes: (offer id, site, user, password, when). Memory only, one at a
/// time, and gone after `OFFER_FOR` - a password nobody answered about is not kept in memory for the whole session.
static PENDING: Mutex<Option<(u64, String, String, SecretString, Instant)>> = Mutex::new(None);
const OFFER_FOR: Duration = Duration::from_secs(5 * 60);
static NEXT_OFFER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// A tab's page sent a sign-in: Leonote is asked whether to keep it (only the site and the name go to it).
/// Nothing is asked when an open vault already has exactly this.
pub fn offer(app: &tauri::AppHandle, tab: &str, page: &str, msg: &str) {
    use tauri::Emitter;
    if !page.starts_with("https://") && !page.starts_with("http://") { return; }
    let Ok(v) = serde_json::from_str::<Value>(msg) else { return };
    let (user, pass) = (v["u"].as_str().unwrap_or("").trim().to_string(), v["p"].as_str().unwrap_or("").to_string());
    let site = host_of(page);
    if pass.is_empty() || pass.len() > 1000 || user.len() > 300 || site.is_empty() { return; }
    let known = {
        let g = crate::lock(&OPEN);
        g.as_ref().filter(|o| o.used.elapsed() <= IDLE).and_then(|o| o.items.iter().find(|x| same_site(page, x["site"].as_str().unwrap_or("")) && x["user"].as_str().unwrap_or("") == user).map(|x| x["password"].as_str() == Some(pass.as_str())))
    };
    if known == Some(true) { return; }
    let id = NEXT_OFFER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    *crate::lock(&PENDING) = Some((id, site.clone(), user.clone(), SecretString::from(pass), Instant::now()));
    // unanswered, it goes by itself at the deadline (not only when the next question looks): one thread at most,
    // however many sign-ins a page sends, sleeping until the waiting one's deadline
    static SWEEPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !SWEEPING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        std::thread::spawn(|| loop {
            let wait = {
                let mut g = crate::lock(&PENDING);
                match g.as_ref() {
                    None => { SWEEPING.store(false, std::sync::atomic::Ordering::SeqCst); return; }
                    Some(p) if p.4.elapsed() >= OFFER_FOR => { *g = None; SWEEPING.store(false, std::sync::atomic::Ordering::SeqCst); return; }
                    Some(p) => OFFER_FOR - p.4.elapsed(),
                }
            };
            std::thread::sleep(wait + Duration::from_millis(250));
        });
    }
    let _ = app.emit_to("main", "pw:offer", json!({ "id": id, "tab": tab, "site": site, "user": user, "update": known == Some(false) }));
}

/// The sign-in waiting, taken only if it is the one this question was about: a later sign-in may have taken
/// its place since - another tab's, or a second try on the same site and name - and has a question of its own.
fn take_offer(id: u64) -> Option<(String, String, SecretString)> {
    let mut g = crate::lock(&PENDING);
    if g.as_ref().is_some_and(|p| p.4.elapsed() > OFFER_FOR) { *g = None; }
    if !g.as_ref().is_some_and(|p| p.0 == id) { return None; }
    g.take().map(|(_, site, user, pass, _)| (site, user, pass))
}

/// Yes: the sign-in waiting goes into the vault (the entry for that site and name gets the new password).
#[tauri::command]
pub async fn pw_offer_save(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_open(|o| {
        let (site, user, pass) = take_offer(id).ok_or("This sign-in is no longer waiting to be saved, so nothing was saved: a newer one took its place, or it waited more than 5 minutes.")?;
        let pass = pass.expose_secret().to_string();
        match o.items.iter_mut().find(|x| host_of(x["site"].as_str().unwrap_or("")) == site && x["user"].as_str().unwrap_or("") == user) {
            Some(x) => x["password"] = json!(pass),
            None => {
                let id = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
                o.items.push(json!({ "id": id, "site": site, "user": user, "note": "", "password": pass }));
            }
        }
        save(o)
    })).await.map_err(|e| e.to_string())?
}

/// No: forgotten at once.
#[tauri::command]
pub fn pw_offer_drop(id: u64) { take_offer(id); }

/// One entry filled into a web tab. Another site's page ("other-site") or one that came over http ("insecure") is
/// refused unless the user said yes to that very warning (`allow`) about that very page (`origin`): a page that moved
/// on while the question was open (a redirect, a hostile network) gets nothing, and a yes to one warning is not a yes
/// to the other.
#[tauri::command]
pub fn pw_fill(app: tauri::AppHandle, tab: String, id: String, allow: Option<Vec<String>>, origin: Option<String>) -> Result<(), String> {
    use tauri::Manager;
    let (site, user, pass) = with_open(|o| {
        let x = o.items.iter().find(|x| x["id"] == id.as_str()).ok_or("That entry is gone")?;
        let s = |k: &str| x[k].as_str().unwrap_or("").to_string();
        Ok((s("site"), s("user"), s("password")))
    })?;
    let wv = app.get_webview(&crate::webwin::tab_label(&tab)).ok_or("The page is gone")?;
    let page = wv.url().map(|u| u.to_string()).unwrap_or_default();
    let origin_now = tauri::Url::parse(&page).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    let allow = allow.unwrap_or_default();
    // a page with no origin of its own (data:, about:) - every one looks the same, so a yes could not name it
    if origin_now == "null" || origin_now.is_empty() { return Err("Passwords are filled only into web pages (http or https)".into()); }
    if !allow.is_empty() && origin.as_deref() != Some(origin_now.as_str()) {
        return Err("The page went on to another address while you were asked - nothing was filled".into());
    }
    if !allow.iter().any(|a| a == "other-site") && !same_site(&page, &site) { return Err("other-site".into()); }
    // a page that came unencrypted could have been changed on the way (a hostile Wi-Fi): asked first too
    if !allow.iter().any(|a| a == "insecure") && !secure_page(&page) { return Err("insecure".into()); }
    // the page checked above is the one filled: should it have moved on to another site in between, the script
    // finds itself elsewhere and fills nothing
    let origin = origin_now;
    let js = format!("if (location.origin === {}) {}({},{})", json!(origin), FILL_JS, json!(user), json!(pass));
    wv.eval(&js).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn sites_match_by_host() {
        assert!(super::same_site("https://github.com/login", "github.com"));
        assert!(super::same_site("https://gist.github.com/", "https://www.github.com"));
        assert!(!super::same_site("https://github.com.evil.io/", "github.com"));
        assert!(!super::same_site("https://notgithub.com/", "github.com"));
        assert!(!super::same_site("https://github.com/", ""));
        assert!(!super::same_site("https://github.com:x@evil.com/", "github.com"));
        assert!(!super::same_site("https://github.com@evil.com/", "github.com"));
    }
    #[test]
    fn only_encrypted_or_local_pages_are_filled_without_asking() {
        assert!(super::secure_page("https://github.com/login"));
        assert!(super::secure_page("http://localhost:3000/login"));
        assert!(super::secure_page("http://127.0.0.1/"));
        assert!(!super::secure_page("http://github.com/login"));
        assert!(!super::secure_page("http://localhost.evil.com/"));
        assert!(!super::secure_page("about:blank"));
    }
    use super::*;
    #[test]
    fn only_the_sign_in_asked_about_is_taken() {
        let wait = |id, p: &str| *crate::lock(&PENDING) = Some((id, "bank.example".into(), "me".into(), SecretString::from(p.to_string()), Instant::now()));
        // a mistyped password, then the right one on the same site and name: the older question touches nothing
        wait(1, "wrong");
        wait(2, "right");
        assert!(take_offer(1).is_none());
        let (site, user, pass) = take_offer(2).unwrap();
        assert_eq!((site.as_str(), user.as_str(), pass.expose_secret()), ("bank.example", "me", "right"));
        assert!(take_offer(2).is_none());
        // one nobody answered about for longer than OFFER_FOR is gone
        if let Some(old) = Instant::now().checked_sub(OFFER_FOR + Duration::from_secs(1)) {
            *crate::lock(&PENDING) = Some((3, "a".into(), "b".into(), SecretString::from("c".to_string()), old));
            assert!(take_offer(3).is_none());
            assert!(crate::lock(&PENDING).is_none());
        }
    }
    #[test]
    fn sealed_list_opens_only_with_its_password() {
        let items = vec![json!({ "id": "a", "site": "x.com", "password": "hunter22" })];
        let b = seal(&items, &SecretString::from("correct horse".to_string())).unwrap();
        assert!(!String::from_utf8_lossy(&b).contains("hunter22"));
        assert_eq!(unseal(&b, "correct horse").unwrap(), items);
        assert_eq!(unseal(&b, "wrong horse").unwrap_err(), crate::backup::WRONG_PASSWORD);
        assert!(shown(&items)[0].get("password").is_none());
    }
}
