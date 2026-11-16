//! Browser add-ons for the tabs' web views: WebView2 loads unpacked
//! extensions into its profile, where they stay across restarts. An add-on
//! comes from a folder, a .zip/.crx, or a release on GitHub; it is unpacked
//! under ~/.leonote/extensions/<name>/ and handed to the profile. The profile
//! is the websites' own (webwin::web_data_dir) - never that of Leonote's pages -
//! reached through an open website view, or a hidden one made for the call (webwin::web_host).

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;

fn ext_root() -> PathBuf {
    crate::store::leonote_dir().join("extensions")
}

/// id -> the folder it was loaded from, so the manifest can be read back.
fn index() -> serde_json::Map<String, Value> {
    std::fs::read(ext_root().join("index.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}
fn remember(id: &str, dir: &Path) {
    let mut ix = index();
    ix.insert(id.to_string(), Value::String(dir.to_string_lossy().to_string()));
    let _ = std::fs::create_dir_all(ext_root());
    let _ = std::fs::write(ext_root().join("index.json"), serde_json::to_vec_pretty(&Value::Object(ix)).unwrap_or_default());
}

fn forget(id: &str) {
    let mut ix = index();
    if ix.remove(id).is_some() { let _ = std::fs::write(ext_root().join("index.json"), serde_json::to_vec_pretty(&Value::Object(ix)).unwrap_or_default()); }
}

/// Every add-on Leonote installed is in the websites' profile: one missing there (a profile copied over from
/// the shared one, or started over) is added again from its folder. Once a run, when the first website opens.
pub(crate) fn ensure_all(app: &AppHandle) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let app = app.clone();
    ONCE.call_once(move || { std::thread::spawn(move || {
        #[cfg(windows)]
        {
            let Ok(Value::Array(have)) = tauri::async_runtime::block_on(web_ext_list(app.clone())) else { return };
            let have: Vec<&str> = have.iter().filter_map(|r| r["id"].as_str()).collect();
            for (id, dir) in index() {
                if have.contains(&id.as_str()) { continue; }
                if let Some(d) = dir.as_str().filter(|d| Path::new(d).join("manifest.json").is_file()) {
                    if let Err(e) = add_folder_raw(&app, PathBuf::from(d)) { crate::trace(&format!("add-on {id} not added again: {e}")); }
                }
            }
        }
        #[cfg(not(windows))]
        let _ = app;
    }); });
}

/// id -> { source, tag }: where a store's or GitHub's add-on came from, so a newer version can be looked for.
fn sources() -> serde_json::Map<String, Value> {
    std::fs::read(ext_root().join("sources.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}
fn remember_source(id: &str, source: &str, tag: &str) {
    let mut s = sources();
    s.insert(id.to_string(), json!({ "source": source, "tag": tag }));
    let _ = std::fs::write(ext_root().join("sources.json"), serde_json::to_vec_pretty(&Value::Object(s)).unwrap_or_default());
}
fn manifest_version(dir: &Path) -> String {
    std::fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|m| m["version"].as_str().map(String::from)).unwrap_or_default()
}

/// A path a manifest names, inside the add-on's folder. Anything else (\\server\share, C:\x, ..) is refused:
/// only reading such a path would already sign this computer in to that server.
fn inside(dir: &Path, p: &str) -> Option<PathBuf> {
    let rel = Path::new(p.trim_start_matches('/'));
    rel.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)).then(|| dir.join(rel))
}

/// The name an add-on shows, its __MSG_ key looked up in its English messages.
fn manifest_name(dir: &Path) -> Option<String> {
    let m: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).ok()?).ok()?;
    let raw = m["name"].as_str()?;
    let Some(key) = raw.strip_prefix("__MSG_").and_then(|k| k.strip_suffix("__")) else { return Some(raw.to_string()) };
    for loc in ["en", "en_US", "en_GB", m["default_locale"].as_str().unwrap_or("en")] {
        if let Some(v) = inside(&dir.join("_locales"), loc).and_then(|d| std::fs::read(d.join("messages.json")).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            if let Some(t) = v[key]["message"].as_str() { return Some(t.to_string()); }
        }
    }
    Some(raw.to_string())
}

/// What the manifest says about an add-on: version, description, its icon as a data URL, its options and popup pages.
fn describe(id: &str, name: &str) -> Value {
    use base64::Engine;
    // installed before the index existed: found by the name in its manifest
    let dir = match index().get(id).and_then(|v| v.as_str()).map(PathBuf::from) {
        Some(d) => d,
        None => {
            let found = std::fs::read_dir(ext_root()).ok().into_iter().flatten().filter_map(|e| e.ok()).map(|e| e.path())
                .filter_map(|p| manifest_dir(&p))
                .find(|d| manifest_name(d).as_deref() == Some(name));
            match found { Some(d) => { remember(id, &d); d } None => return json!({}) }
        }
    };
    let Some(m) = std::fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return json!({}) };
    let icon = m["icons"].as_object().and_then(|ic| {
        let mut best: Option<(u32, &str)> = None;
        for (k, v) in ic { if let (Ok(n), Some(p)) = (k.parse::<u32>(), v.as_str()) { if n <= 128 && best.is_none_or(|b| n > b.0) { best = Some((n, p)); } } }
        best.map(|b| b.1.to_string())
    }).or_else(|| {
        // an action's icon: one path, or a size -> path map
        let a = if m["action"].is_object() { &m["action"]["default_icon"] } else { &m["browser_action"]["default_icon"] };
        a.as_str().map(String::from).or_else(|| a.as_object().and_then(|o| o.values().filter_map(|v| v.as_str()).last().map(String::from)))
    });
    let icon_url = icon.and_then(|p| inside(&dir, &p)).and_then(|p| std::fs::read(p).ok()).map(|b| {
        let mime = if b.starts_with(b"<") { "image/svg+xml" } else { "image/png" };
        format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(b))
    });
    let page = |v: &Value| v.as_str().map(|p| p.trim_start_matches('/').to_string());
    json!({
        "version": m["version"].as_str().unwrap_or(""),
        "description": m["description"].as_str().unwrap_or(""),
        "icon": icon_url,
        "options": page(&m["options_ui"]["page"]).or_else(|| page(&m["options_page"])),
        "popup": page(&m["action"]["default_popup"]).or_else(|| page(&m["browser_action"]["default_popup"])),
        "homepage": m["homepage_url"].as_str().unwrap_or(""),
        "dir": dir.to_string_lossy(),
        "sites": site_lists().get(id).cloned().unwrap_or(Value::Null),
    })
}

/// Where an unpacked add-on's manifest is: the folder itself, or a folder up
/// to three levels down (a source archive keeps it in <repo>/src/).
fn manifest_dir(dir: &Path) -> Option<PathBuf> {
    fn look(dir: &Path, depth: u32) -> Option<PathBuf> {
        if dir.join("manifest.json").is_file() {
            return Some(dir.to_path_buf());
        }
        if depth == 0 { return None; }
        let mut kids: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n == "node_modules" || n == "tests" || n == "test")).collect();
        kids.sort_by_key(|p| if p.file_name().is_some_and(|n| n == "src") { 0 } else { 1 });
        kids.into_iter().find_map(|k| look(&k, depth - 1))
    }
    look(dir, 3)
}

/// Unpack a .zip (or a .crx: a zip with a header in front) into `into`.
fn unpack(bytes: &[u8], into: &Path) -> Result<(), String> {
    // a crx carries a signature block before the zip: the zip starts at its own magic
    let start = bytes.windows(4).position(|w| w == b"PK\x03\x04").ok_or("Not a zip file")?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes[start..])).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    // an add-on is a few MB: 512 MB unpacked at most, so a small package cannot fill the disk
    const MAX_OUT: u64 = 512 << 20;
    let mut written = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { continue };
        // Leonote's own copy of the real manifest: one that came in the package would be trusted as if nobody had changed it
        if rel.file_name().is_some_and(|n| n.eq_ignore_ascii_case(ALL_SITES)) { continue; }
        let out = into.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        written += std::io::copy(&mut (&mut f).take(MAX_OUT - written + 1), &mut w).map_err(|e| e.to_string())?;
        if written > MAX_OUT { return Err("The add-on unpacks to more than 512 MB - not installed".into()); }
    }
    Ok(())
}

// says who is asking; a site that turns this name away gets no link title, not a false one
pub(crate) const AGENT: &str = concat!("Leonote/", env!("CARGO_PKG_VERSION"));

/// A download for an add-on: every step https, redirects included (ureq asks at each one), and only to
/// addresses on the internet.
pub(crate) fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let resp = public_builder().https_only(true).build()
        .get(url)
        .set("User-Agent", AGENT)
        .set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .call()
        .map_err(|e| { let e = e.to_string(); if e.contains("https_only") { "Not downloaded: the address leads to an unsecured connection (http)".to_string() } else { format!("Could not download: {}", e) } })?;
    let mut out = Vec::new();
    resp.into_reader().take(limit).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The same, and held against the SHA-256 its publisher gave, when it gave one: a file that differs is refused.
fn fetch_checked(url: &str, limit: u64, sha: Option<&str>) -> Result<Vec<u8>, String> {
    let bytes = fetch(url, limit)?;
    if let Some(sha) = sha { crate::external::check_sha256(&bytes, sha)?; }
    Ok(bytes)
}

/// The same, for an address someone else wrote (a link in a note): every connection it makes - redirects
/// included - may only go to an address on the internet. The name is looked up here and anything local is
/// dropped before connecting, so neither a redirect nor a name that points home can reach this computer or
/// the local network.
pub(crate) fn fetch_public(url: &str, limit: u64, lang: &str) -> Result<Vec<u8>, String> {
    let req = public_agent()
        .get(url)
        .set("User-Agent", AGENT)
        .set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8");
    let req = if lang.is_empty() { req } else { req.set("Accept-Language", lang) };
    let resp = req.call().map_err(|e| format!("Could not download: {}", e))?;
    let mut out = Vec::new();
    resp.into_reader().take(limit).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub(crate) fn public_agent() -> ureq::Agent { public_builder().build() }

pub(crate) fn public_builder() -> ureq::AgentBuilder {
    use std::net::ToSocketAddrs;
    let resolver = |netloc: &str| -> std::io::Result<Vec<std::net::SocketAddr>> {
        let all: Vec<std::net::SocketAddr> = netloc.to_socket_addrs()?.filter(|a| crate::linkcard::public_ip(a.ip())).collect();
        if all.is_empty() { Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not an address on the internet")) } else { Ok(all) }
    };
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(120))
        .redirects(5)
        .resolver(resolver)
}

/// A name matches a pattern of pieces joined by `*`, in order ("uBOLite_*.chromium.mv3.zip").
fn glob(pattern: &str, name: &str) -> bool {
    let mut at = 0;
    let pieces: Vec<&str> = pattern.split('*').collect();
    for (i, piece) in pieces.iter().enumerate() {
        if piece.is_empty() { continue; }
        let Some(k) = name[at..].find(piece) else { return false };
        if i == 0 && k != 0 { return false; }
        at += k + piece.len();
    }
    pattern.ends_with('*') || at == name.len()
}
fn herr(hr: &Result<(), windows_core::Error>) -> String {
    hr.as_ref().err().map(|e| e.to_string()).unwrap_or_default()
}

/// The download address of the newest release asset of a GitHub repo whose name matches `pattern`, its tag, and
/// the SHA-256 GitHub gives for it (older uploads and a release's source archive have none).
fn github_asset(repo: &str, pattern: &str) -> Result<(String, String, Option<String>), String> {
    let v: Value = serde_json::from_slice(&fetch(&format!("https://api.github.com/repos/{}/releases/latest", repo), 4 << 20)?).map_err(|e| e.to_string())?;
    let tag = v["tag_name"].as_str().unwrap_or("").to_string();
    // no pattern: the source of the release itself (an add-on kept unpacked in its repo)
    if pattern.is_empty() {
        return Ok((format!("https://github.com/{}/archive/refs/tags/{}.zip", repo, tag), tag, None));
    }
    for a in v["assets"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let name = a["name"].as_str().unwrap_or("");
        if glob(pattern, name) {
            if let Some(u) = a["browser_download_url"].as_str() {
                return Ok((u.to_string(), tag, a["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(String::from)));
            }
        }
    }
    Err(format!("No release file of {} matches {}", repo, pattern))
}

/* ── the websites' profile and its extensions, through a website view ──── */

#[cfg(windows)]
fn with_profile<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Profile7, mpsc::Sender<Result<T, String>>) + Send + 'static) -> Result<T, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile7, ICoreWebView2_13};
    use windows_core::Interface;
    // held to the end: a helper view made for this call is closed once the answer is in
    let host = crate::webwin::web_host(app)?;
    let w = &host.wv;
    let (tx, rx) = mpsc::channel::<Result<T, String>>();
    let tx2 = tx.clone();
    w.with_webview(move |pw| unsafe {
        let run = || -> Result<ICoreWebView2Profile7, String> {
            let core = pw.controller().CoreWebView2().map_err(|e| e.to_string())?;
            let c13 = core.cast::<ICoreWebView2_13>().map_err(|_| "This WebView2 runtime is too old for add-ons".to_string())?;
            let p = c13.Profile().map_err(|e| e.to_string())?;
            p.cast::<ICoreWebView2Profile7>().map_err(|_| "This WebView2 runtime is too old for add-ons".to_string())
        };
        match run() {
            Ok(p) => f(&p, tx2),
            Err(e) => { let _ = tx2.send(Err(e)); }
        }
    }).map_err(|e| e.to_string())?;
    drop(tx);
    rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "The web view did not answer".to_string())?
}

#[cfg(windows)]
unsafe fn pw(s: windows_core::PWSTR) -> String {
    if s.is_null() { String::new() } else { let out = s.to_string().unwrap_or_default(); windows::Win32::System::Com::CoTaskMemFree(Some(s.0 as _)); out }
}


/// Forget the passwords and form entries the browser saved (WebView2 keeps them, encrypted by
/// Windows; it lets no program read them - only clear them).
#[tauri::command]
pub async fn web_passwords_forget(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use webview2_com::ClearBrowsingDataCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_BROWSING_DATA_KINDS, COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL, COREWEBVIEW2_BROWSING_DATA_KINDS_PASSWORD_AUTOSAVE};
        return with_profile::<()>(&app, |p, tx| unsafe {
            let tx1 = tx.clone();
            let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS(COREWEBVIEW2_BROWSING_DATA_KINDS_PASSWORD_AUTOSAVE.0 | COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL.0);
            let r = p.ClearBrowsingData(kinds, &ClearBrowsingDataCompletedHandler::create(Box::new(move |hr| {
                let _ = tx1.send(if hr.is_ok() { Ok(()) } else { Err("The browser could not forget them".into()) });
                Ok(())
            })));
            if let Err(e) = r { let _ = tx.send(Err(e.to_string())); }
        });
    }
    #[allow(unreachable_code)]
    Err("Saved passwords are the Windows browser's".into())
}

/// What is installed: [{ id, name, enabled }].
#[tauri::command]
pub async fn web_ext_list(app: AppHandle) -> Result<Value, String> {
    #[cfg(windows)]
    {
        use webview2_com::ProfileGetBrowserExtensionsCompletedHandler;
        return with_profile::<Value>(&app, |p, tx| unsafe {
            let tx1 = tx.clone();
            let r = p.GetBrowserExtensions(&ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |hr, list| {
                let mut out = Vec::new();
                if hr.is_ok() {
                    if let Some(list) = list {
                        let mut n = 0u32;
                        let _ = list.Count(&mut n);
                        for i in 0..n {
                            if let Ok(e) = list.GetValueAtIndex(i) {
                                let mut id = windows_core::PWSTR::null();
                                let mut name = windows_core::PWSTR::null();
                                let mut on = windows_core::BOOL(0);
                                let _ = e.Id(&mut id);
                                let _ = e.Name(&mut name);
                                let _ = e.IsEnabled(&mut on);
                                let id = pw(id);
                                let name = pw(name);
                                let mut row = describe(&id, &name);
                                if row.as_object().is_some_and(|o| o.is_empty()) && name.starts_with("Microsoft ") { continue; }
                                row["id"] = Value::String(id);
                                row["name"] = Value::String(name);
                                row["enabled"] = Value::Bool(on.as_bool());
                                out.push(row);
                            }
                        }
                    }
                }
                let _ = tx1.send(if hr.is_ok() { Ok(Value::Array(out)) } else { Err(herr(&hr)) });
                Ok(())
            })));
            if let Err(e) = r { let _ = tx.send(Err(e.to_string())); }
        });
    }
    #[allow(unreachable_code)]
    Ok(Value::Array(vec![]))
}

/// Hand an unpacked add-on folder to the profile. Returns { id, name }.
#[cfg(windows)]
fn add_folder(app: &AppHandle, dir: PathBuf) -> Result<Value, String> {
    let dir2 = dir.clone();
    let r = add_folder_raw(app, dir)?;
    if let Some(id) = r["id"].as_str() { remember(id, &dir2); }
    Ok(r)
}
#[cfg(windows)]
fn add_folder_raw(app: &AppHandle, dir: PathBuf) -> Result<Value, String> {
    use webview2_com::ProfileAddBrowserExtensionCompletedHandler;
    use windows_core::HSTRING;
    with_profile::<Value>(app, move |p, tx| unsafe {
        let path = HSTRING::from(dir.to_string_lossy().as_ref());
        let tx1 = tx.clone();
        let r = p.AddBrowserExtension(&path, &ProfileAddBrowserExtensionCompletedHandler::create(Box::new(move |hr, ext| {
            let res = if hr.is_ok() {
                if let Some(e) = ext {
                    let mut id = windows_core::PWSTR::null();
                    let mut name = windows_core::PWSTR::null();
                    let _ = e.Id(&mut id);
                    let _ = e.Name(&mut name);
                    Ok(json!({ "id": pw(id), "name": pw(name) }))
                } else { Err("The add-on did not load".to_string()) }
            } else { Err(format!("WebView2 refused the add-on: {}", herr(&hr))) };
            let _ = tx1.send(res);
            Ok(())
        })));
        if let Err(e) = r { let _ = tx.send(Err(e.to_string())); }
    })
}

/// What the Windows dialog says before an add-on is installed: its name, where it came from, and the sites
/// and permissions it asks for (the harmless ones left out, as for updates).
pub(crate) fn install_question(manifest: &Value, name: &str, source: &str) -> String {
    let clean = |s: &str, n: usize| s.split_whitespace().collect::<Vec<_>>().join(" ").chars().filter(|c| !c.is_control()).take(n).collect::<String>();
    let reach = asks_more(&Value::Null, manifest);
    // the store's download address says nothing to a person: the store and the add-on's id instead
    // only the stores' exact download address is named as the store (not one that merely mentions it), and only
    // with a well-formed add-on id
    let store = tauri::Url::parse(source).ok().filter(|u| u.scheme() == "https" && u.port().is_none() && u.username().is_empty()).and_then(|u| {
        let name = match (u.host_str(), u.path()) {
            (Some("clients2.google.com"), "/service/update2/crx") => "the Chrome Web Store",
            (Some("edge.microsoft.com"), "/extensionwebstorebase/v1/crx") => "Edge Add-ons",
            _ => return None,
        };
        let x = u.query_pairs().find(|(k, _)| k == "x").map(|(_, v)| v.into_owned())?;
        let id = x.split('&').find_map(|p| p.strip_prefix("id=")).filter(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))?;
        Some(format!("{name} (add-on {id})"))
    });
    let source = if let Some(s) = store { s } else if let Some(rest) = source.strip_prefix("github:") {
        format!("github.com/{} (its releases)", rest.split(':').next().unwrap_or(rest))
    } else { source.to_string() };
    let source = source.as_str();
    let mut list: Vec<String> = reach.iter().take(12).map(|r| if matches!(r.as_str(), "<all_urls>" | "*://*/*") { "every website".to_string() } else { clean(r, 120) }).collect();
    if reach.len() > 12 { list.push(format!("and {} more", reach.len() - 12)); }
    let asks = if list.is_empty() { "nothing beyond the basics".to_string() } else { list.join("\n") };
    format!("Install the browser add-on \"{}\" from:\n\n{}\n\nIt asks for:\n{}\n\nAn add-on can read and change the sites it asks for, in every tab, until it is removed. Install it? Say no if you did not just ask Leonote for this.",
        clean(name, 120), clean(source, 300), asks)
}

/// Asked in a Windows dialog the page cannot answer: a script in the page cannot install an add-on on its own.
#[cfg(windows)]
fn consent(app: &AppHandle, dir: &Path, source: &str) -> Result<(), String> {
    let m = read_manifest(&dir.join("manifest.json"))?;
    let name = manifest_name(dir).unwrap_or_else(|| "this add-on".into());
    if crate::grant::ask(app, "Leonote is asking", &install_question(&m, &name, source)) { Ok(()) } else { Err("Not installed".into()) }
}

/// Install from a folder, a .zip/.crx file, an https address of one, or "github:owner/repo:pattern".
#[tauri::command]
pub async fn web_ext_install(app: AppHandle, source: String) -> Result<Value, String> {
    #[cfg(not(windows))]
    { let _ = (&app, &source); return Err("Add-ons are only for the Windows build".into()); }
    #[cfg(windows)]
    {
        let src = source.trim().to_string();
        let mut got_tag = String::new();
        let (bytes, name) = if let Some(rest) = src.strip_prefix("github:") {
            let (repo, pattern) = rest.split_once(':').ok_or("github:owner/repo:pattern")?;
            let (url, tag, sha) = github_asset(repo, pattern)?;
            got_tag = tag.clone();
            (Some(fetch_checked(&url, 64 << 20, sha.as_deref())?), format!("{}-{}", repo.split('/').last().unwrap_or("addon"), tag))
        } else if src.starts_with("https://") {
            // a store download names the add-on by its id (…x=id%3D<id>…); anything else by its file name
            let name = src.split("id%3D").nth(1).map(|r| r.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>()).filter(|id| id.len() == 32)
                .unwrap_or_else(|| src.rsplit('/').next().unwrap_or("addon").split('?').next().unwrap_or("addon").trim_end_matches(".zip").trim_end_matches(".crx").to_string());
            let bytes = match store_check(&src) {
                Some(check) => {
                    let (_, url, sha) = store_offer(&check)?.ok_or("The store does not offer this add-on")?;
                    fetch_checked(&url, 64 << 20, sha.as_deref())?
                }
                None => fetch(&src, 64 << 20)?,
            };
            (Some(bytes), name)
        } else {
            let p = PathBuf::from(&src);
            // on another computer: asked before it is looked at, as any file from there
            crate::grant::allow_far_once(&app, &p, "install a browser add-on from another computer")?;
            if p.is_dir() {
                let dir = manifest_dir(&p).ok_or("No manifest.json in that folder")?;
                let own = !dir.starts_with(ext_root());
                consent(&app, &dir, &src)?;
                let r = add_folder(&app, dir)?;
                // a folder of your own is never narrowed: a limit left from a .zip of the same add-on no longer holds, so it is not shown
                if let Some(id) = r["id"].as_str().filter(|_| own) {
                    let mut all = site_lists();
                    if all.remove(id).is_some() { let _ = std::fs::write(ext_root().join("sites.json"), serde_json::to_vec_pretty(&Value::Object(all)).unwrap_or_default()); }
                }
                return Ok(r);
            }
            let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("addon".into());
            (Some(std::fs::read(&p).map_err(|e| e.to_string())?), name)
        };
        let into = ext_root().join(addon_folder(&name));
        // only ever a folder right inside the add-ons' own: a name like ".." would have wiped ~/.leonote itself
        if into.parent() != Some(ext_root().as_path()) { return Err("That add-on's name cannot be a folder name".into()); }
        let bytes = bytes.unwrap();
        // asked first, from a copy beside it: a "no" leaves the installed add-on as it was
        let staging = ext_root().join(format!(".asking-{}", addon_folder(&name)));
        let _ = std::fs::remove_dir_all(&staging);
        let asked = unpack(&bytes, &staging).and_then(|_| manifest_dir(&staging).ok_or("No manifest.json in the package".to_string())).and_then(|d| consent(&app, &d, &src));
        let _ = std::fs::remove_dir_all(&staging);
        asked?;
        if into.exists() { let _ = std::fs::remove_dir_all(&into); }
        unpack(&bytes, &into)?;
        let dir = manifest_dir(&into).ok_or("No manifest.json in the package")?;
        // installed again in its folder: the sites it was kept to stay, or it would reach every site while the app says otherwise
        if let Some(s) = kept_sites(&index(), &site_lists(), &dir) {
            if let Err(e) = apply_sites(&dir, Some(&s)) { let _ = std::fs::remove_dir_all(&into); return Err(e); }
        }
        let r = add_folder(&app, dir)?;
        // from a store or a release: remembered, so a newer version can come the same way
        if src.starts_with("github:") || src.starts_with("https://") {
            if let Some(id) = r["id"].as_str() { remember_source(id, &src, &got_tag); }
        }
        Ok(r)
    }
}

/// An add-on's folder name from its file or address: letters, digits, - _ and dots inside, never only dots
/// ("." and ".." are other folders) and never starting with one (a hidden folder).
pub(crate) fn addon_folder(name: &str) -> String {
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect();
    let safe = safe.trim_start_matches('.').trim_end_matches('.');
    if safe.is_empty() { "addon".into() } else { safe.to_string() }
}

/* ── updates ─────────────────────────────────────────────────────────────── */

/// Is dotted version `a` newer than `b`? ("2026.920.1710" > "2026.9.15")
pub(crate) fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| s.split('.').map(|x| x.trim().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (x, y) = (p(a), p(b));
    for i in 0..x.len().max(y.len()) {
        let (m, n) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
        if m != n { return m > n; }
    }
    false
}

/// The version in a store's update answer (Chrome's and Edge's speak the same gupdate XML).
pub(crate) fn gupdate_version(xml: &str) -> Option<String> {
    gupdate_attr(xml, "version").map(String::from)
}
fn gupdate_attr<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let u = &xml[xml.find("<updatecheck")?..];
    let u = &u[..u.find('>').unwrap_or(u.len())];
    let key = format!(" {name}=\"");
    let i = u.find(&key)? + key.len();
    u[i..].split('"').next().filter(|v| !v.is_empty())
}
/// A store's download address made secure. Edge answers with plain http, on a host whose certificate does not
/// fit https; the same files come over https from its "sf" host. Anything else that is not https is refused.
fn secure_codebase(url: &str) -> Result<String, String> {
    let url = url.replace("&amp;", "&");
    if url.starts_with("https://") { return Ok(url); }
    url.strip_prefix("http://msedgeextensions.").and_then(|r| r.split_once(".tlu.dl.delivery.mp.microsoft.com/"))
        .filter(|(sub, _)| !sub.contains('/'))
        .map(|(_, path)| format!("https://msedgeextensions.sf.tlu.dl.delivery.mp.microsoft.com/{path}"))
        .ok_or("Not downloaded: the store offers it only over an unsecured connection (http)".to_string())
}
/// Where to ask a store about an add-on, for an address of that store's.
/// The Chrome version the Chrome Web Store is told: one value everywhere (web/webaddons.js uses the same).
const PRODVERSION: &str = "130.0";

fn store_check(source: &str) -> Option<String> {
    let id = store_id(source)?;
    if source.starts_with("https://edge.microsoft.com/") {
        Some(format!("https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=updatecheck&x=id%3D{}%26v%3D0.0.0.0%26uc", id))
    } else if source.starts_with("https://clients2.google.com/") {
        Some(format!("https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion={PRODVERSION}&acceptformat=crx2,crx3&x=id%3D{}%26v%3D0.0.0.0%26uc", id))
    } else { None }
}
/// What the store offers: its version, a secure address and the file's SHA-256 (over https, so the file can be held to it).
fn store_offer(check: &str) -> Result<Option<(String, String, Option<String>)>, String> {
    let xml = String::from_utf8_lossy(&fetch(check, 1 << 20)?).into_owned();
    let (Some(version), Some(url)) = (gupdate_version(&xml), gupdate_attr(&xml, "codebase")) else { return Ok(None) };
    Ok(Some((version, secure_codebase(url)?, gupdate_attr(&xml, "hash_sha256").map(String::from))))
}

/// The store's id out of its download address (…x=id%3D<id>…).
fn store_id(source: &str) -> Option<String> {
    source.split("id%3D").nth(1).map(|r| r.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>()).filter(|id| id.len() == 32)
}

/// Where an add-on came from: what was remembered at install, else what its folder's name says
/// (installed before sources were kept: a store id, or <repo>-<tag> of an add-on Leonote offers).
pub(crate) fn source_of(rec: &serde_json::Map<String, Value>, id: &str, top: &str, known: &[String]) -> Option<(String, String)> {
    if let Some(r) = rec.get(id) {
        return Some((r["source"].as_str()?.to_string(), r["tag"].as_str().unwrap_or("").to_string()));
    }
    if top.len() == 32 && top.bytes().all(|c| (b'a'..=b'p').contains(&c)) {
        return Some((format!("https://clients2.google.com/service/update2/crx?response=redirect&prodversion={PRODVERSION}&acceptformat=crx2,crx3&x=id%3D{}%26uc", top), String::new()));
    }
    for k in known {
        let Some(rest) = k.strip_prefix("github:") else { continue };
        let Some(repo) = rest.split(':').next().and_then(|r| r.rsplit('/').next()) else { continue };
        if let Some(tag) = top.strip_prefix(&format!("{}-", repo)) {
            return Some((k.clone(), tag.to_string()));
        }
    }
    None
}

fn copy_over(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let (s, d) = (e.path(), to.join(e.file_name()));
        if s.is_dir() { copy_over(&s, &d)?; } else { std::fs::copy(&s, &d).map_err(|e| format!("{}: {}", d.display(), e))?; }
    }
    Ok(())
}

/// Named permissions that reach no site of their own: no browser asks again for these.
const QUIET: [&str; 10] = ["storage", "unlimitedStorage", "alarms", "contextMenus", "activeTab", "scripting", "offscreen", "idle", "sidePanel", "notifications"];

/// A match pattern as scheme, host and path; <all_urls> is every one of them.
fn pattern_parts(p: &str) -> Option<(&str, &str, &str)> {
    if p == "<all_urls>" { return Some(("*", "*", "/*")); }
    let (scheme, rest) = p.split_once("://")?;
    let (host, path) = rest.find('/').map_or((rest, "/*"), |i| rest.split_at(i));
    Some((scheme, host, path))
}

/// Does the site pattern `old` already reach everything `new` does? Unsure is no.
fn covers(old: &str, new: &str) -> bool {
    let Some((ns, nh, np)) = pattern_parts(new) else { return false };
    if old == "<all_urls>" { return true; }
    let Some((os, oh, op)) = pattern_parts(old) else { return false };
    let bare = nh.split(':').next().unwrap_or("");
    (os == ns || (os == "*" && matches!(ns, "http" | "https")))
        && (oh == "*" || oh == nh || oh == bare || oh.strip_prefix("*.").is_some_and(|b| bare == b || bare.ends_with(&format!(".{b}"))))
        && (op == np || op.strip_suffix('*').is_some_and(|b| np.starts_with(b)))
}

/// What the new manifest reaches that the old one did not: permissions and the sites of content scripts.
/// (Optional ones ask when they are used.) The browsers stop an update here until you accept it.
pub(crate) fn asks_more(old: &Value, new: &Value) -> Vec<String> {
    let reach = |m: &Value| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for k in ["permissions", "host_permissions"] { out.extend(m[k].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from))); }
        for c in m["content_scripts"].as_array().into_iter().flatten() { out.extend(c["matches"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from))); }
        out
    };
    let have = reach(old);
    // *:// is http and https: each may be covered by a pattern of its own
    let covered = |p: &str| match p.strip_prefix("*://") {
        Some(r) => ["http", "https"].iter().all(|s| have.iter().any(|o| covers(o, &format!("{s}://{r}")))),
        None => have.iter().any(|o| covers(o, p)),
    };
    let mut more: Vec<String> = Vec::new();
    for p in reach(new) {
        if have.contains(&p) || QUIET.contains(&p.as_str()) || covered(&p) || more.contains(&p) { continue; }
        more.push(p);
    }
    more
}

/// A newer version put in place of the old, in the same folder: the same
/// folder is the same id, so the add-on keeps its settings and sign-ins.
/// Some((version, tag)) when it was updated.
fn update_one(app: &AppHandle, id: &str, dir: &Path, source: &str, tag: &str) -> Result<Option<(String, String)>, String> {
    let have = manifest_version(dir);
    let (url, new_tag, sha) = if let Some(rest) = source.strip_prefix("github:") {
        let (repo, pattern) = rest.split_once(':').ok_or("github:owner/repo:pattern")?;
        let (url, t, sha) = github_asset(repo, pattern)?;
        if t.is_empty() || t == tag { return Ok(None); }
        (url, t, sha)
    } else {
        let check = store_check(source).ok_or("No store id in its address")?;
        match store_offer(&check)? { Some((v, url, sha)) if newer(&v, &have) => (url, String::new(), sha), _ => return Ok(None) }
    };
    let staging = ext_root().join(".update");
    let _ = std::fs::remove_dir_all(&staging);
    unpack(&fetch_checked(&url, 64 << 20, sha.as_deref())?, &staging)?;
    let fresh = manifest_dir(&staging).ok_or("No manifest.json in the new version")?;
    let to = manifest_version(&fresh);
    let kept = site_lists().get(id).and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok());
    // asking for more than it had: it stays as it is until you install it again yourself
    let all = dir.join(ALL_SITES);
    let more = read_manifest(&if all.is_file() { all } else { dir.join("manifest.json") }).and_then(|old| {
        let new = read_manifest(&fresh.join("manifest.json"))?;
        Ok(match &kept { Some(s) => asks_more(&restrict(&old, s), &restrict(&new, s)), None => asks_more(&old, &new) })
    });
    let more = match more { Ok(m) => m, Err(e) => { let _ = std::fs::remove_dir_all(&staging); return Err(e); } };
    if !more.is_empty() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("it now asks for more ({}) - not updated. Install it again to allow that.", more.join(", ")));
    }
    // kept to some sites: the new version is narrowed before it goes live (its own manifest kept beside it,
    // replacing the old one's), and a manifest that cannot be narrowed stops the update - never unrestricted
    if let Some(s) = &kept {
        if let Err(e) = apply_sites(&fresh, Some(s)) { let _ = std::fs::remove_dir_all(&staging); return Err(e); }
    }
    // a file still held open: copied over instead
    let swapped = std::fs::remove_dir_all(dir).is_ok() && std::fs::rename(&fresh, dir).is_ok();
    if !swapped { copy_over(&fresh, dir)?; }
    let _ = std::fs::remove_dir_all(&staging);
    // handed to the profile again: it loads the new files (or does at the next start)
    #[cfg(windows)]
    add_folder_raw(app, dir.to_path_buf())?;
    #[cfg(not(windows))]
    { let _ = app; }
    Ok(Some((to, new_tag)))
}

/// Newer versions of the add-ons that came from a store or a GitHub release.
/// `ids`: the ones installed now; `known`: the sources of the add-ons Leonote
/// offers. A folder of your own is yours to update. Returns
/// { updated: [{ id, name, from, to }], failed: [{ name, error }] }.
#[tauri::command]
pub async fn web_ext_update(app: AppHandle, ids: Vec<String>, known: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (ix, rec, root) = (index(), sources(), ext_root());
        let (mut updated, mut failed) = (Vec::new(), Vec::new());
        for id in ids {
            let Some(dir) = ix.get(&id).and_then(|v| v.as_str()).map(PathBuf::from) else { continue };
            let Ok(rel) = dir.strip_prefix(&root) else { continue };
            let top = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
            let Some((source, tag)) = source_of(&rec, &id, &top, &known) else { continue };
            let name = manifest_name(&dir).unwrap_or_else(|| id.clone());
            let from = manifest_version(&dir);
            match update_one(&app, &id, &dir, &source, &tag) {
                Ok(Some((to, new_tag))) => {
                    remember_source(&id, &source, &new_tag);
                    updated.push(json!({ "id": id, "name": name, "from": from, "to": to }));
                }
                Ok(None) => { if !rec.contains_key(&id) { remember_source(&id, &source, &tag); } }
                Err(e) => failed.push(json!({ "name": name, "error": e })),
            }
        }
        Ok(json!({ "updated": updated, "failed": failed }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The sites each add-on may read and change, as the user chose: id -> [site]. Not listed: every site its
/// manifest asks for.
fn site_lists() -> serde_json::Map<String, Value> {
    std::fs::read(ext_root().join("sites.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// The sites kept for the add-on loaded from this folder, if any: the same folder is the same id.
fn kept_sites(ix: &serde_json::Map<String, Value>, lists: &serde_json::Map<String, Value>, dir: &Path) -> Option<Vec<String>> {
    let (id, _) = ix.iter().find(|(_, d)| d.as_str().map(Path::new) == Some(dir))?;
    serde_json::from_value(lists.get(id)?.clone()).ok()
}

/// A site as written ("https://www.youtube.com/watch?v=1", "YouTube.com") down to its host, without "www.".
pub(crate) fn site_host(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let s = s.split_once("://").map_or(s.as_str(), |x| x.1);
    let host = s.split(['/', '?', '#', ':']).next()?.trim_start_matches("www.").trim_matches('.');
    let ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    ok.then(|| host.to_string())
}

/// One of an add-on's match patterns narrowed to `sites`: a pattern over all of a site (or every site) becomes
/// that site and its subdomains; a pattern on part of a site stays as it is; the rest go (file:// among them).
pub(crate) fn narrow(pattern: &str, sites: &[String]) -> Vec<String> {
    let Some((scheme, host, path)) = pattern_parts(pattern) else { return vec![] };
    let host = host.split(':').next().unwrap_or("");
    if !matches!(scheme, "*" | "http" | "https" | "ws" | "wss") { return vec![]; }
    let base = host.trim_start_matches("*.");
    let under = |a: &str, b: &str| a == b || a.ends_with(&format!(".{b}"));
    let mut out: Vec<String> = Vec::new();
    for s in sites {
        let more = if host == "*" || (host.starts_with("*.") && under(s, base)) { vec![format!("{scheme}://{s}{path}"), format!("{scheme}://*.{s}{path}")] }
            else if under(base, s) { vec![pattern.to_string()] } else { vec![] };
        for m in more { if !out.contains(&m) { out.push(m); } }
    }
    out
}

/// Permissions that reach every site whatever the host permissions say (an add-on kept to some sites does without):
/// they attach to any tab, route all traffic, or report and capture every address.
const EVERY_SITE: [&str; 8] = ["debugger", "proxy", "webNavigation", "tabs", "history", "pageCapture", "tabCapture", "desktopCapture"];

/// A manifest whose site access is narrowed to `sites`: host permissions, URL permissions and content scripts
/// (one left with no site goes), and the permissions that reach every site gone. Everything else is the add-on's own.
pub(crate) fn restrict(m: &Value, sites: &[String]) -> Value {
    let mut m = m.clone();
    let narrow_all = |v: &Value, keep_other: bool| {
        let mut out: Vec<Value> = Vec::new();
        for p in v.as_array().into_iter().flatten() {
            match p.as_str() {
                Some(s) if s == "<all_urls>" || s.contains("://") => for n in narrow(s, sites) { if !out.contains(&json!(n)) { out.push(json!(n)); } },
                Some(s) if EVERY_SITE.contains(&s) => {}
                _ if keep_other => out.push(p.clone()),
                _ => {}
            }
        }
        Value::Array(out)
    };
    for k in ["host_permissions", "optional_host_permissions", "permissions", "optional_permissions"] {
        if m[k].is_array() { m[k] = narrow_all(&m[k], true); }
    }
    if let Some(cs) = m["content_scripts"].as_array() {
        let kept: Vec<Value> = cs.iter().filter_map(|c| {
            let mut c = c.clone();
            c["matches"] = narrow_all(&c["matches"], false);
            c["matches"].as_array().is_some_and(|a| !a.is_empty()).then_some(c)
        }).collect();
        m["content_scripts"] = Value::Array(kept);
    }
    m
}

/// The add-on's own manifest is kept beside it while it is narrowed, and comes back for "every site".
const ALL_SITES: &str = "manifest.leonote-all.json";
fn read_manifest(p: &Path) -> Result<Value, String> {
    let b = std::fs::read(p).map_err(|e| e.to_string())?;
    serde_json::from_slice(b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b)).map_err(|e| format!("The add-on's manifest is not plain JSON: {e}"))
}
fn apply_sites(dir: &Path, sites: Option<&[String]>) -> Result<(), String> {
    let (man, all) = (dir.join("manifest.json"), dir.join(ALL_SITES));
    let Some(sites) = sites else {
        if all.is_file() { std::fs::rename(&all, &man).map_err(|e| e.to_string())?; }
        return Ok(());
    };
    if !all.is_file() { std::fs::copy(&man, &all).map_err(|e| e.to_string())?; }
    let m = read_manifest(&all)?;
    let tmp = dir.join("manifest.json.part");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&restrict(&m, sites)).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &man).map_err(|e| e.to_string())
}

/// Which sites an add-on may read and change: `sites` None = every site it asks for; a list = only those (an
/// empty one: none). The narrowed manifest is handed to the profile again - same folder, same id, so the
/// add-on keeps its settings. Returns the sites as kept.
#[tauri::command]
pub async fn web_ext_sites(app: AppHandle, id: String, sites: Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = index().get(&id).and_then(|v| v.as_str()).map(PathBuf::from).ok_or("Leonote does not know this add-on's folder")?;
        if !dir.starts_with(ext_root()) { return Err("This add-on is loaded from a folder of your own, and Leonote leaves its files alone. Install it from its .zip to choose its sites.".to_string()); }
        let sites = sites.map(|v| { let mut o: Vec<String> = v.iter().filter_map(|s| site_host(s)).collect(); o.sort(); o.dedup(); o });
        apply_sites(&dir, sites.as_deref())?;
        let mut all = site_lists();
        match &sites { Some(s) => { all.insert(id.clone(), json!(s)); } None => { all.remove(&id); } }
        std::fs::write(ext_root().join("sites.json"), serde_json::to_vec_pretty(&Value::Object(all)).unwrap_or_default()).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        add_folder_raw(&app, dir)?;
        #[cfg(not(windows))]
        let _ = app;
        Ok(sites)
    }).await.map_err(|e| e.to_string())?
}

/// Turn an add-on on or off.
#[tauri::command]
pub async fn web_ext_set(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use webview2_com::{BrowserExtensionEnableCompletedHandler, ProfileGetBrowserExtensionsCompletedHandler};
        return with_profile::<()>(&app, move |p, tx| unsafe {
            let tx1 = tx.clone();
            let r = p.GetBrowserExtensions(&ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |_hr, list| {
                if let Some(e) = find(list.as_ref(), &id) {
                    let tx2 = tx1.clone();
                    let _ = e.Enable(enabled, &BrowserExtensionEnableCompletedHandler::create(Box::new(move |hr| { let _ = tx2.send(if hr.is_ok() { Ok(()) } else { Err(herr(&hr)) }); Ok(()) })));
                } else { let _ = tx1.send(Err("No such add-on".into())); }
                Ok(())
            })));
            if let Err(e) = r { let _ = tx.send(Err(e.to_string())); }
        });
    }
    #[allow(unreachable_code)]
    { let _ = (app, id, enabled); Ok(()) }
}

/// Uninstall an add-on.
#[tauri::command]
pub async fn web_ext_remove(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use webview2_com::{BrowserExtensionRemoveCompletedHandler, ProfileGetBrowserExtensionsCompletedHandler};
        return with_profile::<()>(&app, move |p, tx| unsafe {
            let tx1 = tx.clone();
            let r = p.GetBrowserExtensions(&ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |_hr, list| {
                if let Some(e) = find(list.as_ref(), &id) {
                    let tx2 = tx1.clone();
                    let gone = id.clone();
                    let _ = e.Remove(&BrowserExtensionRemoveCompletedHandler::create(Box::new(move |hr| { if hr.is_ok() { forget(&gone); } let _ = tx2.send(if hr.is_ok() { Ok(()) } else { Err(herr(&hr)) }); Ok(()) })));
                } else { let _ = tx1.send(Err("No such add-on".into())); }
                Ok(())
            })));
            if let Err(e) = r { let _ = tx.send(Err(e.to_string())); }
        });
    }
    #[allow(unreachable_code)]
    { let _ = (app, id); Ok(()) }
}

#[cfg(windows)]
unsafe fn find(list: Option<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2BrowserExtensionList>, id: &str) -> Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2BrowserExtension> {
    let list = list?;
    let mut n = 0u32;
    let _ = list.Count(&mut n);
    for i in 0..n {
        if let Ok(e) = list.GetValueAtIndex(i) {
            let mut s = windows_core::PWSTR::null();
            let _ = e.Id(&mut s);
            if pw(s) == id { return Some(e); }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_install_question_names_what_an_addon_reaches() {
        let m = json!({ "permissions": ["storage", "cookies"], "host_permissions": ["<all_urls>"] });
        let q = install_question(&m, "Good\n\n\n\nhelper", "https://example.com/a.crx");
        assert!(q.contains("\"Good helper\"") && q.contains("cookies\nevery website") && !q.contains("storage"), "{q}");
        assert!(install_question(&json!({}), "x", "y").contains("nothing beyond the basics"));
        let store = install_question(&m, "x", "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx2,crx3&x=id%3Dpkehgijcmpdhfbdbbnkijodmdjhbjlgp%26uc");
        assert!(store.contains("from:\n\nthe Chrome Web Store (add-on pkehgijcmpdhfbdbbnkijodmdjhbjlgp)"), "{store}");
        // an address that only mentions the store is shown as it is
        let fake = install_question(&m, "x", "https://evil.example/?clients2.google.com/service/update2/crx&x=id%3Dpkehgijcmpdhfbdbbnkijodmdjhbjlgp");
        assert!(!fake.contains("Chrome Web Store") && fake.contains("evil.example"), "{fake}");
    }
    /// The store's own .crx download, unpacked. Needs the network, which the
    /// test sandbox here forbids (10013): run by hand with `cargo test --lib webext -- --ignored`.
    #[test]
    fn an_addon_narrowed_to_sites_keeps_only_those() {
        let s = vec!["youtube.com".to_string()];
        assert_eq!(narrow("<all_urls>", &s), ["*://youtube.com/*", "*://*.youtube.com/*"]);
        assert_eq!(narrow("https://*/*", &s), ["https://youtube.com/*", "https://*.youtube.com/*"]);
        // asked for less than the site: kept as asked, never widened
        assert_eq!(narrow("https://www.youtube.com/watch*", &s), ["https://www.youtube.com/watch*"]);
        assert_eq!(narrow("https://youtube.com/*", &s), ["https://youtube.com/*"]);
        assert!(narrow("https://github.com/*", &s).is_empty());
        assert!(narrow("file:///*", &s).is_empty());
        let m = json!({ "permissions": ["storage", "<all_urls>", "tabs"], "host_permissions": ["*://*/*"],
            "content_scripts": [{ "matches": ["<all_urls>"], "js": ["a.js"] }, { "matches": ["https://github.com/*"], "js": ["b.js"] }] });
        let r = restrict(&m, &s);
        assert_eq!(r["permissions"], json!(["storage", "*://youtube.com/*", "*://*.youtube.com/*"]));
        assert_eq!(r["host_permissions"], json!(["*://youtube.com/*", "*://*.youtube.com/*"]));
        assert_eq!(r["content_scripts"].as_array().unwrap().len(), 1);
        // no sites at all: nothing reaches any page
        let none = restrict(&m, &[]);
        assert_eq!(none["host_permissions"], json!([]));
        assert_eq!(none["content_scripts"], json!([]));
        assert_eq!(site_host("https://www.YouTube.com/watch?v=1").as_deref(), Some("youtube.com"));
        assert_eq!(site_host("*.evil.com"), None); // never a pattern of its own
        assert_eq!(site_host("a b.com"), None);
    }
    #[test]
    fn a_manifest_path_stays_in_the_addons_folder() {
        let d = Path::new("C:\\addon");
        assert_eq!(inside(d, "/img/i.png"), Some(d.join("img/i.png")));
        for bad in ["\\\\attacker\\share\\i.png", "/\\\\attacker\\share\\i.png", "C:\\Windows\\x.png", "\\x.png", "../x.png", "a\\..\\..\\x.png"] {
            assert_eq!(inside(d, bad), None, "{bad}");
        }
    }
    #[test]
    fn an_update_asking_for_more_is_noticed() {
        let old = json!({ "permissions": ["storage"], "host_permissions": ["https://youtube.com/*"], "content_scripts": [{ "matches": ["https://youtube.com/*"] }] });
        assert!(asks_more(&old, &old).is_empty());
        assert!(asks_more(&old, &json!({ "permissions": ["storage", "alarms"], "host_permissions": ["https://youtube.com/*"] })).is_empty());
        assert_eq!(asks_more(&old, &json!({ "permissions": ["debugger"], "host_permissions": ["<all_urls>"], "content_scripts": [{ "matches": ["https://bank.example/*"] }] })), ["debugger", "<all_urls>", "https://bank.example/*"]);
        // already on every site: a narrower site is nothing new
        assert!(asks_more(&json!({ "host_permissions": ["<all_urls>"] }), &json!({ "host_permissions": ["https://a.example/*"] })).is_empty());
    }
    #[test]
    fn an_update_inside_what_it_had_is_not_asking_for_more() {
        let cs = |p: &str| json!({ "content_scripts": [{ "matches": [p] }] });
        let hp = |p: &[&str]| json!({ "host_permissions": p });
        // kept to a site: the new version's page on that site
        let sites = ["youtube.com".to_string()];
        let old = restrict(&hp(&["<all_urls>"]), &sites);
        assert!(asks_more(&old, &restrict(&cs("https://www.youtube.com/watch*"), &sites)).is_empty());
        assert!(asks_more(&hp(&["https://*.youtube.com/*"]), &cs("https://www.youtube.com/*")).is_empty());
        let both = hp(&["http://*/*", "https://*/*"]);
        assert!(asks_more(&both, &cs("https://a.example/*")).is_empty());
        assert!(asks_more(&both, &cs("*://a.example/*")).is_empty());
        // what looks close but is not inside
        let had = hp(&["https://*.youtube.com/watch*"]);
        for p in ["https://youtube.com.evil.example/watch", "https://notyoutube.com/watch", "http://www.youtube.com/watch", "https://www.youtube.com/feed", "*://www.youtube.com/watch", "<all_urls>"] {
            assert_eq!(asks_more(&had, &cs(p)), [p], "{p}");
        }
        assert_eq!(asks_more(&hp(&["*://*/*"]), &cs("file:///*")), ["file:///*"]);
        assert_eq!(asks_more(&hp(&["<all_urls>"]), &json!({ "permissions": ["debugger"] })), ["debugger"]);
    }
    #[test]
    fn an_addon_installed_again_keeps_its_sites() {
        let dir = std::env::temp_dir().join("leonote_ext_test_again");
        let (ix, lists) = (json!({ "x": dir.to_string_lossy() }), json!({ "x": ["youtube.com"] }));
        let found = kept_sites(ix.as_object().unwrap(), lists.as_object().unwrap(), &dir).unwrap();
        assert_eq!(found, ["youtube.com"]);
        assert!(kept_sites(ix.as_object().unwrap(), lists.as_object().unwrap(), &dir.join("other")).is_none());
    }
    #[test]
    fn the_public_agent_refuses_this_computer() {
        let e = public_agent().get("http://127.0.0.1:9/").call().unwrap_err().to_string();
        assert!(e.contains("not an address on the internet"), "{e}");
    }
    #[test]
    fn an_addon_download_is_https_only() {
        // ureq asks this at every connection, so a redirect to http ends the same way
        assert!(fetch("http://127.0.0.1:9/", 1).unwrap_err().contains("unsecured"));
        let s = |x| secure_codebase(x);
        assert_eq!(s("https://c/x.crx?a=1&amp;b=2").unwrap(), "https://c/x.crx?a=1&b=2");
        assert_eq!(s("http://msedgeextensions.f.tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/e7?P1=1&amp;P2=4").unwrap(), "https://msedgeextensions.sf.tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/e7?P1=1&P2=4");
        assert!(s("http://x/files/e7").unwrap_err().contains("unsecured"));
    }
    #[test]
    fn only_a_stores_own_address_asks_that_store() {
        let id = "a".repeat(32);
        assert!(store_check(&format!("https://evil.example/edge.microsoft.com/?x=id%3D{id}%26uc")).is_none());
        assert!(store_check(&format!("https://edge.microsoft.com/x?x=id%3D{id}%26uc")).unwrap().starts_with("https://edge.microsoft.com/"));
        assert!(store_check(&format!("https://clients2.google.com/x?x=id%3D{id}%26uc")).unwrap().starts_with("https://clients2.google.com/"));
    }
    /// Live: both stores' real answers and files, over https and matching their SHA-256.
    #[test]
    #[ignore]
    fn store_downloads_are_secure_and_match() {
        let edge = "https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3Dodfafepnkmbhccpbejgmiehpchacaeak%26installsource%3Dondemand%26uc";
        for src in [edge, "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx2,crx3&x=id%3Dddkjiahejlhfcafbddmgiahcphecmpfh%26uc"] {
            let (_, url, sha) = store_offer(&store_check(src).unwrap()).unwrap().expect("offered");
            assert!(url.starts_with("https://"));
            let sha = sha.expect("a hash");
            assert!(fetch_checked(&url, 64 << 20, Some(&sha)).unwrap().len() > 100_000);
            assert!(fetch_checked(&url, 64 << 20, Some(&"0".repeat(64))).unwrap_err().contains("fingerprint"));
        }
        // Edge's own redirect goes to plain http: that is what the secure address above replaces
        let e = fetch(edge, 1 << 20).unwrap_err();
        assert!(e.contains("unsecured"), "{e}");
    }
    #[test]
    fn an_addons_folder_never_leaves_the_addons_own() {
        for (name, want) in [("..", "addon"), (".", "addon"), ("...", "addon"), ("", "addon"), ("..evil", "evil"), ("uBOL-home-2026.920.1710", "uBOL-home-2026.920.1710"), ("a/../b", "a_.._b")] {
            assert_eq!(addon_folder(name), want, "{name:?}");
            assert_eq!(ext_root().join(addon_folder(name)).parent(), Some(ext_root().as_path()));
        }
    }
    #[test]
    #[ignore]
    fn kitsumi_from_the_chrome_web_store_unpacks() {
        let url = std::env::var("LEO_TEST_CRX").unwrap_or("https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx2,crx3&x=id%3Dciiembegoahhehnfdkbanhioobokjdkd%26uc".to_string());
        let bytes = fetch(&url, 64 << 20).expect("download");
        assert!(bytes.len() > 100_000, "too small: {}", bytes.len());
        let into = std::env::temp_dir().join("leonote_ext_test_kitsumi");
        let _ = std::fs::remove_dir_all(&into);
        unpack(&bytes, &into).expect("unpack");
        let dir = manifest_dir(&into).expect("manifest");
        let m: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert!(m["manifest_version"].as_u64().is_some());
        let _ = std::fs::remove_dir_all(&into);
    }
    #[test]
    fn a_package_cannot_bring_its_own_original_manifest() {
        use std::io::Write as _;
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for name in ["manifest.json", "manifest.leonote-all.json", "sub/Manifest.Leonote-All.JSON"] {
            z.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"{}").unwrap();
        }
        let bytes = z.finish().unwrap().into_inner();
        let into = std::env::temp_dir().join("leonote_ext_test_hidden_manifest");
        let _ = std::fs::remove_dir_all(&into);
        unpack(&bytes, &into).expect("unpack");
        assert!(into.join("manifest.json").is_file());
        assert!(!into.join(ALL_SITES).exists());
        assert!(!into.join("sub").join("Manifest.Leonote-All.JSON").exists());
        let _ = std::fs::remove_dir_all(&into);
    }
    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("2026.920.1710", "2026.9.15"));
        assert!(newer("7.5.41", "7.5.40"));
        assert!(newer("1.10", "1.9"));
        assert!(!newer("7.5.40", "7.5.40"));
        assert!(!newer("1.2", "1.2.0"));
        assert!(newer("1.2.1", "1.2"));
    }
    #[test]
    fn the_store_answer_says_its_version() {
        let edge = r#"<?xml version="1.0" encoding="utf-8"?><gupdate protocol="2.0"><daystart elapsed_days="2827" /><app appid="odfafepnkmbhccpbejgmiehpchacaeak" status="ok"><updatecheck status="ok" codebase="http://x/files/e7?P1=1&amp;P2=404" version="2026.916.75.0" hash_sha256="AF31" /></app></gupdate>"#;
        assert_eq!(gupdate_version(edge).as_deref(), Some("2026.916.75.0"));
        let chrome = r#"<gupdate><app appid="x" status="ok"><updatecheck codebase="https://c/x.crx" fp="1" size="9" status="ok" version="7.5.41"/></app></gupdate>"#;
        assert_eq!(gupdate_version(chrome).as_deref(), Some("7.5.41"));
        assert_eq!(gupdate_version(r#"<gupdate><app status="ok"><updatecheck status="noupdate"/></app></gupdate>"#), None);
    }
    #[test]
    fn an_add_on_installed_before_sources_were_kept_is_recognised() {
        let rec = serde_json::Map::new();
        let known = vec!["github:uBlockOrigin/uBOL-home:*chromium.zip".to_string(), "github:EFForg/privacybadger:".to_string()];
        let (s, t) = source_of(&rec, "x", "uBOL-home-2026.920.1710", &known).unwrap();
        assert_eq!((s.as_str(), t.as_str()), ("github:uBlockOrigin/uBOL-home:*chromium.zip", "2026.920.1710"));
        let (s, t) = source_of(&rec, "x", "privacybadger-release-2026.9.15", &known).unwrap();
        assert_eq!((s.as_str(), t.as_str()), ("github:EFForg/privacybadger:", "release-2026.9.15"));
        let (s, _) = source_of(&rec, "x", "ciiembegoahhehnfdkbanhioobokjdkd", &known).unwrap();
        assert_eq!(store_id(&s).as_deref(), Some("ciiembegoahhehnfdkbanhioobokjdkd"));
        // a file or folder of your own: nothing to update from
        assert!(source_of(&rec, "x", "kitsumi-7.5.40", &known).is_none());
        let mut rec = serde_json::Map::new();
        rec.insert("x".into(), json!({ "source": "github:a/b:*.zip", "tag": "v2" }));
        assert_eq!(source_of(&rec, "x", "whatever", &known).unwrap().1, "v2");
    }
    #[test]
    fn glob_matches_pieces_in_order() {
        assert!(glob("*chromium.zip", "uBOLite_2026.920.1710.chromium.zip"));
        assert!(!glob("*chromium.zip", "uBOLite_2026.920.1710.edge.zip"));
        assert!(glob("uBOLite_*.zip", "uBOLite_1.chromium.zip"));
    }
}
