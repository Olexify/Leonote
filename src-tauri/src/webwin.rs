//! Web panels: a shortcut you made opens as a real, separate browser window.
//!
//! Nothing clever happens to the page. It is a plain WebView2 window pointed
//! at a URL, with its own label so a second open focuses the window that is
//! already there instead of stacking another one. No script is injected, no
//! request is rewritten, nothing is blocked - the site behaves exactly as it
//! does in a browser, ads, logins and all.
//!
//! The windows carry no Tauri permissions: `capabilities/default.json` lists
//! `windows: ["main"]`, so a remote page that tries `invoke` is refused by
//! the ACL rather than by our good manners.
//!
//! Geometry is remembered by the frontend, in settings, next to the shortcut
//! itself - `web:closed` carries the last size and position out as the window
//! goes.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PREFIX: &str = "web-";

/// wry's default switches Microsoft's SmartScreen off along with two Edge
/// popups; the pages in the tabs are a browser, so the check on known-bad
/// sites and downloads stays on, as it is in Edge. Every view sharing the
/// profile has to pass the same string (the main window's is in
/// tauri.conf.json), or WebView2 refuses the second one.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI --autoplay-policy=no-user-gesture-required";

/* ── the websites' own profile ─────────────────────────────────────────────
   Websites (tabs, the split pane, page windows, add-on popups) have a browser profile of their own - cookies,
   site data, add-ons - apart from Leonote's own pages. Add-ons run only there: one allowed on every site
   would otherwise run inside Leonote's window too, where it could read the notes on screen and reach the
   app's commands. Leonote's pages keep add-ons switched off (tauri.conf.json, the mini player). */

/// tauri.conf.json's identifier: Leonote's own pages keep their profile in %LOCALAPPDATA%\<it>\EBWebView.
const APP_ID: &str = "com.oleks.leonote-rs";

/// Where the websites' profile is: %LOCALAPPDATA%\<app>\web (WebView2 keeps it in EBWebView inside).
pub(crate) fn web_data_dir() -> std::path::PathBuf {
    std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir).join(APP_ID).join("web")
}

/// Once, at start: the websites' profile begins as a copy of the one they shared with Leonote's pages until
/// now - sign-ins, site data, add-ons and their settings; caches stay behind. Never while a Leonote is still
/// running (its browser holds the lockfile): the next start does it then. Copied aside and renamed into
/// place, so a copy cut short is started again rather than used.
pub(crate) fn move_web_profile() {
    let to = web_data_dir().join("EBWebView");
    copy_profile(&web_data_dir().with_file_name("EBWebView"), &to);
}
fn copy_profile(from: &std::path::Path, to: &std::path::Path) {
    if to.exists() || !from.join("Default").is_dir() { return; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let lock = from.join("lockfile");
        if lock.exists() && std::fs::OpenOptions::new().read(true).share_mode(0).open(&lock).is_err() { return; }
    }
    const SKIP: &[&str] = &["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "Service Worker", "lockfile"];
    fn copy(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)?.flatten() {
            if SKIP.iter().any(|s| e.file_name() == *s) { continue; }
            let (s, d) = (e.path(), to.join(e.file_name()));
            if s.is_dir() { copy(&s, &d)?; } else { std::fs::copy(&s, &d)?; }
        }
        Ok(())
    }
    // one temp folder per process: two starts at once each copy into their own, and the second rename fails harmlessly
    let part = to.with_extension(format!("part{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&part);
    let done = copy(&from.join("Default"), &part.join("Default"))
        .and_then(|_| std::fs::copy(from.join("Local State"), part.join("Local State")).map(|_| ()))
        .and_then(|_| std::fs::rename(&part, to));
    if let Err(e) = done { crate::trace(&format!("websites' profile not copied: {e}")); let _ = std::fs::remove_dir_all(&part); }
}

#[cfg(test)]
mod web_profile_tests {
    use super::*;
    #[test]
    fn a_sign_in_popup_is_titled_by_its_address() {
        let t = |u: &str| popup_title(&u.parse().unwrap());
        assert_eq!(t("https://me:pw@accounts.google.com:8443/o?x=Sign+in"), "https://accounts.google.com:8443");
        assert_eq!(t("data:text/html,Sign in - Google Accounts"), "data");
    }
    #[test]
    fn a_video_message_speaks_only_for_where_it_came_from() {
        let id = "abcDEF12345";
        let (yt, evil, ad) = ("https://www.youtube.com/", "https://evil.example/", "https://ads.example/f");
        assert_eq!(video_message(&format!("{id}|x"), yt, yt), Some((id, yt)));
        // an embed on another page still counts
        assert_eq!(video_message(&format!("{id}|x"), "https://www.youtube-nocookie.com/embed/a", evil), Some((id, "https://www.youtube-nocookie.com/embed/a")));
        // any other page names only itself, whatever it says
        assert_eq!(video_message(&format!("{id}|https://evil.example/a.mp3"), evil, evil), Some(("", evil)));
        // a frame that is not YouTube says nothing; nor does a look-alike host
        assert_eq!(video_message(&format!("{id}|x"), ad, evil), None);
        assert_eq!(video_message(&format!("{id}|x"), "https://notyoutube.com/", evil), None);
        assert_eq!(video_message("../../x|y", yt, yt), Some(("", yt)));
    }
    #[test]
    fn the_websites_profile_is_a_copy_without_caches_and_never_of_a_running_one() {
        let root = std::env::temp_dir().join(format!("leo-webprofile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (from, to) = (root.join("EBWebView"), root.join("web").join("EBWebView"));
        for f in ["Default/Network/Cookies", "Default/Local Extension Settings/abc/000003.log", "Default/Cache/Cache_Data/f_1", "Default/Service Worker/x"] {
            let p = from.join(f); std::fs::create_dir_all(p.parent().unwrap()).unwrap(); std::fs::write(p, b"x").unwrap();
        }
        std::fs::write(from.join("Local State"), b"{}").unwrap();
        std::fs::write(from.join("lockfile"), b"").unwrap();
        #[cfg(windows)]
        {
            // a Leonote still running holds the lockfile: nothing is copied yet
            use std::os::windows::fs::OpenOptionsExt;
            let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(from.join("lockfile")).unwrap();
            copy_profile(&from, &to);
            assert!(!to.exists());
            drop(held);
        }
        copy_profile(&from, &to);
        assert!(to.join("Default/Network/Cookies").is_file() && to.join("Default/Local Extension Settings/abc/000003.log").is_file() && to.join("Local State").is_file());
        assert!(!to.join("Default/Cache").exists() && !to.join("Default/Service Worker").exists() && !to.with_extension("part").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn every_address_of_leonotes_own_is_kept_from_websites() {
        // Tauri's own three, and every protocol the app registers (a new one must be added to APP_HOSTS)
        for h in ["asset", "tauri", "ipc"] { assert!(APP_HOSTS.contains(&h), "{h}"); }
        let lib = include_str!("lib.rs");
        for part in lib.split("uri_scheme_protocol(\"").skip(1) {
            let name = part.split('"').next().unwrap();
            assert!(APP_HOSTS.contains(&name), "the {name}: protocol is not kept from websites");
        }
    }
    #[test]
    fn the_app_id_is_tauri_confs_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_ID);
    }
}

/// How many calls are using the blank helper view; the last one done closes it.
static HOST_USERS: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

/// A website view to reach the websites' profile through (add-ons, saved passwords): an open tab when there is
/// one (they all share the profile), else a blank, hidden one made for the call and closed when the last call
/// using it is done - so with no website open, the websites' browser does not stay up for it.
pub(crate) struct WebHost { pub wv: tauri::Webview, temp: bool }
impl Drop for WebHost {
    fn drop(&mut self) {
        if !self.temp { return; }
        let mut n = HOST_USERS.lock().unwrap_or_else(|e| e.into_inner());
        *n = n.saturating_sub(1);
        if *n == 0 { let _ = self.wv.close(); }
    }
}
pub(crate) fn web_host(app: &AppHandle) -> Result<WebHost, String> {
    if let Some((_, wv)) = app.webviews().into_iter().find(|(l, _)| l.starts_with(TAB_WEB) || l.starts_with(SPLIT_WEB)) {
        return Ok(WebHost { wv, temp: false });
    }
    let mut n = HOST_USERS.lock().unwrap_or_else(|e| e.into_inner());
    let wv = match app.get_webview("webhost") {
        Some(w) => w,
        None => {
            let window = app.get_window("main").ok_or("The main window is gone")?;
            let b = tauri::webview::WebviewBuilder::new("webhost", WebviewUrl::External("about:blank".parse().unwrap()))
                .browser_extensions_enabled(true).additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler().data_directory(web_data_dir());
            let wv = window.add_child(b, tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(1.0, 1.0)).map_err(|e| e.to_string())?;
            let _ = wv.hide();
            downloads_from_page(app, &wv, "webhost".into()); // a download from here asks too
            wv
        }
    };
    *n += 1;
    Ok(WebHost { wv, temp: true })
}

/* ── downloads ─────────────────────────────────────────────────────────────
   A page starting a download gets nothing saved until the frontend answers:
   the event carries the address, the file name and the size, the download
   waits on a WebView2 deferral, and `tab_web_download_reply` lets it go on
   or cancels it. WebView2 never runs what it saved; a file only lands in the
   user's Downloads folder. */
#[cfg(windows)]
thread_local! {
    static DOWNLOADS: std::cell::RefCell<std::collections::HashMap<u64, (webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs, webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral)>> = Default::default();
}

#[cfg(windows)]
unsafe fn pwstr(f: impl FnOnce(*mut windows_core::PWSTR) -> windows_core::Result<()>) -> String {
    let mut s = windows_core::PWSTR::null();
    if f(&mut s).is_err() || s.is_null() { return String::new(); }
    let out = s.to_string().unwrap_or_default();
    windows::Win32::System::Com::CoTaskMemFree(Some(s.0 as _));
    out
}

#[cfg(windows)]
fn downloads_from_page(app: &AppHandle, wv: &tauri::Webview, label: String) {
    use webview2_com::DownloadStartingEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
    use windows_core::Interface;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(c4) = core.cast::<ICoreWebView2_4>() else { return };
        let handler = DownloadStartingEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let op = args.DownloadOperation()?;
            let url = pwstr(|p| op.Uri(p));
            // the page that asked: "always allow" is about the site you are on, not where the file is kept
            let page = sender.map(|c| pwstr(|p| c.Source(p))).unwrap_or_default();
            let file = pwstr(|p| op.ResultFilePath(p));
            let mut bytes = 0i64;
            let _ = op.TotalBytesToReceive(&mut bytes);
            let deferral = args.GetDeferral()?;
            let token = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            DOWNLOADS.with(|d| d.borrow_mut().insert(token, (args.clone(), deferral)));
            let _ = handle.emit_to("main", "tabweb:download", json!({ "label": label, "token": token, "url": url, "page": page, "file": file, "bytes": bytes }));
            Ok(())
        }));
        let mut token = 0i64;
        let _ = c4.add_DownloadStarting(&handler, &mut token);
    });
}
#[cfg(not(windows))]
fn downloads_from_page(_app: &AppHandle, _wv: &tauri::Webview, _label: String) {}

/// The answer to `tabweb:download`: the download goes on, or is cancelled.
#[tauri::command]
pub async fn tab_web_download_reply(app: AppHandle, label: String, token: u64, allow: bool) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.with_webview(move |_| unsafe {
            if let Some((args, deferral)) = DOWNLOADS.with(|d| d.borrow_mut().remove(&token)) {
                let _ = args.SetCancel(!allow);
                let _ = deferral.Complete();
            }
        });
    }
    let _ = (&app, &label, token, allow);
    Ok(())
}

/// A shortcut id becomes a window label, and Tauri only accepts
/// `[a-zA-Z0-9-_/:.]` there. Anything else becomes `_`, which is fine: ids
/// are generated, so this is a guard, not a naming scheme.
fn label_for(id: &str) -> String {
    let mut s = String::from(PREFIX);
    for c in id.chars().take(48) {
        s.push(if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' });
    }
    s
}

pub fn is_web_label(label: &str) -> bool {
    label.starts_with(PREFIX)
}

/// http(s), and `file:` for a page on this computer (a local site being
/// built, a saved page). Never `data:` or `javascript:`: those would be a way
/// to run something from a stored string, so they never get this far.
pub fn check_url(url: &str) -> Result<String, String> {
    let u = url.trim();
    let low = u.to_ascii_lowercase();
    if !low.starts_with("http://") && !low.starts_with("https://") && !low.starts_with("chrome-extension://") && !low.starts_with("file://") {
        return Err("A web page has to start with http://, https:// or file://".into());
    }
    if u.len() > 2048 || u.contains(['\n', '\r']) {
        return Err("That address is not a web address".into());
    }
    // a file on this computer's drives only (file:///C:/...): never another computer's share - Windows would
    // sign in to that host to fetch it - however it is spelled (file://host/, file:////host, \\, %5C)
    if low.starts_with("file:") {
        let ok = tauri::Url::parse(u).ok().filter(|p| p.host_str().unwrap_or("").is_empty()).map(|p| {
            let path = p.path().to_string();
            let b = path.as_bytes();
            b.len() >= 4 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' && b[3] == b'/' && !path.contains('\\') && !path.to_ascii_lowercase().contains("%5c")
        }).unwrap_or(false);
        if !ok { return Err("Only a file on this computer's drives opens from here".into()); }
    }
    Ok(u.to_string())
}

/// Leonote's own addresses (tauri.localhost, heic.localhost, ...): never a page a browser tab or the split pane goes to.
pub(crate) fn app_address(url: &tauri::Url) -> bool {
    url.host_str().map(|h| h.to_ascii_lowercase().ends_with(".localhost")).unwrap_or(false)
}

/// Where no page may go: Leonote's own addresses, or a file on another computer (a link in a local page; Windows
/// would sign in to that host to fetch it).
fn off_limits(url: &tauri::Url) -> bool {
    app_address(url) || (url.scheme() == "file" && check_url(url.as_str()).is_err())
}

fn geometry(w: &tauri::WebviewWindow) -> Value {
    let scale = w.scale_factor().unwrap_or(1.0);
    let pos = w.outer_position().ok().map(|p| p.to_logical::<f64>(scale));
    let size = w.inner_size().ok().map(|s| s.to_logical::<f64>(scale));
    json!({
        "x": pos.map(|p| p.x.round()),
        "y": pos.map(|p| p.y.round()),
        "w": size.map(|s| s.width.round()),
        "h": size.map(|s| s.height.round()),
    })
}

/* ── the browser in the split pane ─────────────────────────────────────────
   A second webview INSIDE the main window, laid exactly over the split
   pane's placeholder (the frontend sends the rectangle whenever it moves).
   It is a plain browser like the web windows above: nothing injected,
   nothing blocked, no Tauri permissions (its label is in no capability), so
   sites behave as they do anywhere - which an <iframe> never could, since
   most sites refuse to be framed. */
const SPLIT_WEB: &str = "splitweb";

/// Each split pane's browser is a view of its own: `splitweb-<pane id>`.
fn split_label(id: &Option<String>) -> String {
    match id {
        Some(i) if !i.is_empty() => { let mut s = String::from(SPLIT_WEB); s.push('-'); s.extend(i.chars().take(16).map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })); s }
        _ => SPLIT_WEB.to_string(),
    }
}

fn split_rect(x: f64, y: f64, w: f64, h: f64) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
    (tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)), tauri::LogicalSize::new(w.max(1.0), h.max(1.0)))
}

/// Show the split browser at this rectangle (logical px in the window),
/// creating it if need be. `url` navigates; None keeps whatever page is there.
#[tauri::command]
pub async fn split_web_show(app: AppHandle, url: Option<String>, x: f64, y: f64, w: f64, h: f64, id: Option<String>) -> Result<Value, String> {
    let (pos, size) = split_rect(x, y, w, h);
    let label = split_label(&id);
    if let Some(wv) = app.get_webview(&label) {
        if let Some(u) = url {
            let parsed = check_url(&u)?.parse().map_err(|_| "That address is not a web address".to_string())?;
            wv.navigate(parsed).map_err(|e| e.to_string())?;
        }
        wv.set_position(pos).map_err(|e| e.to_string())?;
        wv.set_size(size).map_err(|e| e.to_string())?;
        punch_holes(&wv, &[]);
        let _ = wv.show();
        return Ok(json!({ "created": false }));
    }
    let u = url.ok_or("No page to open")?;
    let parsed: tauri::Url = check_url(&u)?.parse().map_err(|_| "That address is not a web address".to_string())?;
    let window = app.get_window("main").ok_or("The main window is gone")?;
    let nav = app.clone();
    let loaded = app.clone();
    let (id_nav, id_loaded) = (id.clone(), id.clone());
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .browser_extensions_enabled(true).data_directory(web_data_dir())
        .additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler()
        .on_navigation(move |url| {
            if off_limits(url) { return false; } // a page may not walk into Leonote's own addresses, or another computer's files
            let _ = nav.emit_to("main", "splitweb:url", json!({ "id": id_nav, "url": url.as_str() }));
            true
        })
        .on_page_load(move |wv, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = loaded.emit_to("main", "splitweb:url", json!({ "id": id_loaded, "url": payload.url().as_str(), "done": true }));
                let _ = wv;
            }
        });
    window.add_child(builder, pos, size).map_err(|e| format!("Could not open the browser here: {}", e))?;
    if let Some(wv) = app.get_webview(&label) { passwords_now(&wv); downloads_from_page(&app, &wv, label.clone()); }
    Ok(json!({ "created": true }))
}

/// Out of sight without losing the page (another split tab is up, the pane
/// is locked to a different tab, or a menu needs the space).
#[tauri::command]
pub async fn split_web_hide(app: AppHandle, id: Option<String>) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&split_label(&id)) {
        let _ = wv.hide();
    }
    Ok(())
}

#[tauri::command]
pub async fn split_web_close(app: AppHandle, id: Option<String>) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&split_label(&id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// back | forward | reload - the page's own history, asked of the page.
#[tauri::command]
pub async fn split_web_go(app: AppHandle, action: String, id: Option<String>) -> Result<(), String> {
    let Some(wv) = app.get_webview(&split_label(&id)) else { return Ok(()) };
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err("unknown action".into()),
    };
    wv.eval(js).map_err(|e| e.to_string())
}

/* ── browser tabs ──────────────────────────────────────────────────────────
   The same kind of view as the split pane's, one per browser tab of the main
   strip, laid over the tab's placeholder while that tab is up and hidden
   otherwise. Plain browsers: nothing blocked, no Tauri permissions for the pages. Two small scripts are
   added: Ctrl+wheel zoom (WHEEL_ZOOM_JS), and - only while "Offer to save sign-ins" is on - one that notices a
   sign-in so it can be offered for the password vault (SIGNIN_JS). */
const TAB_WEB: &str = "tabweb-";

/// Passwords and form entries offered to be saved, and filled in again - by
/// WebView2 itself, which keeps them in the browser profile, encrypted by
/// Windows for this user. Off unless the user turns it on (Settings › Browser).
static PASSWORDS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
pub(crate) fn passwords_in(wv: &tauri::Webview, on: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use windows_core::Interface;
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(s) = core.Settings().and_then(|s| s.cast::<ICoreWebView2Settings4>()) else { return };
        let _ = s.SetIsPasswordAutosaveEnabled(on);
        let _ = s.SetIsGeneralAutofillEnabled(on);
    });
}
#[cfg(not(windows))]
pub(crate) fn passwords_in(_wv: &tauri::Webview, _on: bool) {}

/// Leonote's own addresses Tauri wires into every webview, which a website has no business reaching:
/// `asset:` (the vault, the music folders - served with the page's own origin allowed to read them, so a site
/// could fetch a note by its path), `tauri:` (the app's pages), `ipc:` (its commands; a website is refused them
/// anyway), `heic:` and `phone:` (pictures; guarded too). wry adds the filters that route these to Tauri; they
/// are taken away again here, the same way they were added, so for a website they are plain unknown hosts.
/// The scripts Leonote puts in a tab talk to it through WebView2's own message channel, not these.
pub(crate) const APP_HOSTS: &[&str] = &["asset", "tauri", "ipc", "heic", "phone"];
#[cfg(windows)]
pub(crate) fn no_app_files(wv: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL};
    use windows_core::{Interface, HSTRING};
    let _ = wv.with_webview(|pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        for host in APP_HOSTS {
            let filter = HSTRING::from(format!("http://{host}.*"));
            match core.cast::<ICoreWebView2_22>() {
                Ok(c) => { let _ = c.RemoveWebResourceRequestedFilterWithRequestSourceKinds(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL); }
                Err(_) => { let _ = core.RemoveWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL); }
            }
        }
    });
}
#[cfg(not(windows))]
pub(crate) fn no_app_files(_wv: &tauri::Webview) {}

/// The browser's history, in a file of its own beside the settings: every visit,
/// as the app keeps it (a JSON array). Empty when there is none yet.
fn history_path() -> std::path::PathBuf { crate::store::leonote_dir().join("web-history.json") }
#[tauri::command]
pub async fn web_history_get() -> Result<String, String> {
    Ok(std::fs::read_to_string(history_path()).unwrap_or_default())
}
/// Written whole, by rename: a crash mid-write leaves the last good copy.
#[tauri::command]
pub async fn web_history_set(json: String) -> Result<(), String> {
    if serde_json::from_str::<Value>(&json).map(|v| !v.is_array()).unwrap_or(true) { return Err("not a history".into()); }
    let p = history_path();
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// The browser's own password saving, on or off - for every page open now and every one opened later.
#[tauri::command]
pub async fn web_passwords_set(app: AppHandle, on: bool) -> Result<(), String> {
    PASSWORDS.store(on, std::sync::atomic::Ordering::Relaxed);
    for (l, wv) in app.webviews() {
        if l.starts_with(TAB_WEB) || l.starts_with(PREFIX) || l.starts_with(SPLIT_WEB) { passwords_in(&wv, on); }
    }
    Ok(())
}
/// The page's icon, whenever it changes: read as PNG from WebView2 itself (no
/// second request to the site) and handed to the app, which keeps one small copy
/// per site for every tab of it.
#[cfg(windows)]
fn favicon_from_page(app: &AppHandle, wv: &tauri::Webview, id: String) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_15, COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG};
    use webview2_com::{FaviconChangedEventHandler, GetFaviconCompletedHandler};
    use windows_core::Interface;
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(c15) = core.cast::<ICoreWebView2_15>() else { return };
        let c2 = c15.clone();
        let handler = FaviconChangedEventHandler::create(Box::new(move |_, _| {
            let mut src = windows_core::PWSTR::null();
            let url = if c2.Source(&mut src).is_ok() && !src.is_null() { let u = src.to_string().unwrap_or_default(); windows::Win32::System::Com::CoTaskMemFree(Some(src.0 as _)); u } else { String::new() };
            if !url.starts_with("http") { return Ok(()); }
            let (h2, id2) = (handle.clone(), id.clone());
            let done = GetFaviconCompletedHandler::create(Box::new(move |hr, stream| {
                let (true, Some(stream)) = (hr.is_ok(), stream) else { return Ok(()) };
                let mut bytes = Vec::new();
                let mut buf = [0u8; 8192];
                loop {
                    let mut got = 0u32;
                    if stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut got)).is_err() || got == 0 { break; }
                    bytes.extend_from_slice(&buf[..got as usize]);
                    if bytes.len() > 256 * 1024 { return Ok(()); } // not an icon
                }
                if !bytes.is_empty() {
                    use base64::Engine;
                    let _ = h2.emit_to("main", "tabweb:favicon", json!({ "id": id2, "url": url, "png": base64::engine::general_purpose::STANDARD.encode(&bytes) }));
                }
                Ok(())
            }));
            let _ = c2.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &done);
            Ok(())
        }));
        let mut token = 0i64;
        let _ = c15.add_FaviconChanged(&handler, &mut token);
    });
}
#[cfg(not(windows))]
fn favicon_from_page(_app: &AppHandle, _wv: &tauri::Webview, _id: String) {}

/// Every website view (tab, split pane, page window) goes through here once it is made.
fn passwords_now(wv: &tauri::Webview) {
    no_app_files(wv);
    crate::webext::ensure_all(wv.app_handle());
    passwords_in(wv, PASSWORDS.load(std::sync::atomic::Ordering::Relaxed));
}

/* ── sleeping tabs ─────────────────────────────────────────────────────────
   A tab out of sight for a while is suspended (WebView2's TrySuspend: the
   page's scripts, timers and rendering stop, as a sleeping tab in Edge) and
   its renderer is asked to give memory back. A tab playing sound is left
   awake, and a tab coming back up is resumed before it shows. */
static HIDDEN: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> = std::sync::LazyLock::new(Default::default);
static PLAYING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::LazyLock::new(Default::default);

/// The page put to sleep, if it is still there.
fn sleep_now(app: &AppHandle, label: &str) {
    crate::lock(&HIDDEN).remove(label);
    let Some(wv) = app.get_webview(label) else { return };
    #[cfg(windows)]
    let _ = wv.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW};
        use webview2_com::TrySuspendCompletedHandler;
        use windows_core::Interface;
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        if let Ok(c) = core.cast::<ICoreWebView2_19>() { let _ = c.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW); }
        if let Ok(c) = core.cast::<ICoreWebView2_3>() { let _ = c.TrySuspend(&TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())))); }
    });
    let _ = wv;
}

/// A hidden page that plays sound stays awake - suspending it would stop the music - but its
/// renderer is asked to keep less in memory, as Edge does for a tab in the background.
fn lighten(app: &AppHandle, label: &str) {
    let Some(wv) = app.get_webview(label) else { return };
    #[cfg(windows)]
    let _ = wv.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW};
        use windows_core::Interface;
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        if let Ok(c) = core.cast::<ICoreWebView2_19>() { let _ = c.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW); }
    });
    let _ = wv;
}

/// Hidden now: after `after` seconds still hidden and silent, the page
/// sleeps; and with more than `awake` tabs up (the one in view counted),
/// the longest-hidden silent ones sleep at once. A tab already counting
/// down keeps its clock - switching tabs does not start it over. 0 = no
/// limit for either.
fn doze(app: &AppHandle, label: String, after: u64, awake: u64) {
    if after == 0 && awake == 0 { return; }
    let gen = {
        let mut m = crate::lock(&HIDDEN);
        if m.contains_key(&label) { return; }
        let g = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(1);
        m.insert(label.clone(), g);
        g
    };
    if awake > 0 {
        loop {
            let over = {
                let m = crate::lock(&HIDDEN);
                if (m.len() as u64) + 1 <= awake { break; }
                let p = crate::lock(&PLAYING);
                m.iter().filter(|(l, _)| !p.contains(*l)).min_by_key(|(_, g)| **g).map(|(l, _)| l.clone())
            };
            let Some(old) = over else { break };
            sleep_now(app, &old);
        }
    }
    if after == 0 { return; }
    let app = app.clone();
    // a thread that only waits for the tab's sleep time (and ends at once if the tab came back meanwhile): one per
    // hiding, so it gets a small stack - 256 KB, not the default 2 MB that a dozen hidden tabs would each reserve
    let _ = std::thread::Builder::new().name("leonote-tab-sleep".into()).stack_size(256 * 1024).spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(after));
        if crate::lock(&HIDDEN).get(&label) != Some(&gen) { return; }
        if crate::lock(&PLAYING).contains(&label) { lighten(&app, &label); return; }
        sleep_now(&app, &label);
    });
}

/// Coming up: resumed, and its memory target back to normal.
fn wake(wv: &tauri::Webview, label: &str) {
    crate::lock(&HIDDEN).remove(label);
    #[cfg(windows)]
    let _ = wv.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
        use windows_core::Interface;
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        if let Ok(c) = core.cast::<ICoreWebView2_3>() { let _ = c.Resume(); }
        if let Ok(c) = core.cast::<ICoreWebView2_19>() { let _ = c.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL); }
    });
    let _ = wv;
}

/// A page that signs you in and answers the page that opened it (OAuth, a password asked again).
fn is_sign_in(url: &str) -> bool {
    let Ok(u) = tauri::Url::parse(url) else { return false };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let path = u.path().to_ascii_lowercase();
    host == "accounts.google.com" || host.starts_with("login.") || host.starts_with("auth.") || host.starts_with("signin.") || host.starts_with("accounts.")
        || path.contains("/oauth") || path.contains("/authorize") || path.contains("/signin") || path.contains("/login")
}

/// A sign-in popup has no address bar, so its title bar says whose page it is - never what the page calls itself.
fn popup_title(u: &tauri::Url) -> String {
    let o = u.origin();
    if o.is_tuple() { o.ascii_serialization() } else { u.scheme().to_string() }
}

/// At most 4 new windows or tabs from one tab in any 5 seconds.
fn popups_ok(tab: &str) -> bool {
    static SEEN: std::sync::Mutex<Option<std::collections::HashMap<String, (std::time::Instant, u32)>>> = std::sync::Mutex::new(None);
    let mut g = crate::lock(&SEEN);
    let m = g.get_or_insert_with(std::collections::HashMap::new);
    let e = m.entry(tab.to_string()).or_insert((std::time::Instant::now(), 0));
    if e.0.elapsed() > std::time::Duration::from_secs(5) { *e = (std::time::Instant::now(), 0); }
    e.1 += 1;
    e.1 <= 4
}

/// A sign-in popup as a window of ours on the opener's environment, so window.opener still answers the page that
/// opened it - and a download still asks, as in any other page. A page's window.close() takes only wry's inner
/// container with it: the window itself is closed here, once that event is over.
fn sign_in_popup(app: &AppHandle, opener: &str, url: &tauri::Url, features: tauri::webview::NewWindowFeatures) -> Option<tauri::WebviewWindow> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let label = format!("signin-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let (tabs, opener) = (app.clone(), opener.to_string());
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().ok()?))
        .window_features(features)
        .disable_drag_drop_handler()
        .title(popup_title(url))
        .on_page_load(|w, p| { let _ = w.set_title(&popup_title(p.url())); })
        .on_navigation(|u| !off_limits(u))
        .on_new_window(move |u, _| {
            let _ = tabs.emit_to("main", "tabweb:newtab", json!({ "id": opener, "url": u.as_str() }));
            tauri::webview::NewWindowResponse::Deny
        })
        .build().ok()?;
    passwords_now(w.as_ref());
    downloads_from_page(app, w.as_ref(), label);
    #[cfg(windows)]
    {
        let win = w.clone();
        let _ = w.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let mut token = 0i64;
            let _ = core.add_WindowCloseRequested(&webview2_com::WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                let win = win.clone();
                tauri::async_runtime::spawn(async move { let _ = win.close(); });
                Ok(())
            })), &mut token);
        });
    }
    Some(w)
}

pub(crate) fn tab_label(id: &str) -> String {
    let mut s = String::from(TAB_WEB);
    for c in id.chars().take(40) {
        s.push(if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' });
    }
    s
}

/// Show tab `id`'s browser at this rectangle, creating it if need be, and
/// hide every other tab's. `url` navigates; None keeps the page that is there.
#[tauri::command]
pub async fn tab_web_show(app: AppHandle, id: String, url: Option<String>, x: f64, y: f64, w: f64, h: f64, holes: Option<Vec<Vec<f64>>>, sleep: Option<u64>, awake: Option<u64>) -> Result<Value, String> {
    let (pos, size) = split_rect(x, y, w, h);
    let label = tab_label(&id);
    for (l, wv) in app.webviews() {
        if l.starts_with(TAB_WEB) && l != label {
            let _ = wv.hide();
            doze(&app, l, sleep.unwrap_or(0), awake.unwrap_or(0));
        }
    }
    if let Some(wv) = app.get_webview(&label) {
        wake(&wv, &label);
        if let Some(u) = url {
            let parsed = check_url(&u)?.parse().map_err(|_| "That address is not a web address".to_string())?;
            wv.navigate(parsed).map_err(|e| e.to_string())?;
        }
        wv.set_position(pos).map_err(|e| e.to_string())?;
        wv.set_size(size).map_err(|e| e.to_string())?;
        punch_holes(&wv, holes.as_deref().unwrap_or(&[]));
        let _ = wv.show();
        return Ok(json!({ "created": false }));
    }
    let u = url.ok_or("No page to open")?;
    let parsed: tauri::Url = check_url(&u)?.parse().map_err(|_| "That address is not a web address".to_string())?;
    let window = app.get_window("main").ok_or("The main window is gone")?;
    let (nav, loaded, titled, popped) = (app.clone(), app.clone(), app.clone(), app.clone());
    let (id_nav, id_loaded, id_titled, id_popped) = (id.clone(), id.clone(), id.clone(), id.clone());
    // the script that notices a sign-in (to offer keeping it in the password vault): only while that offer is on
    let offer = { let p = crate::Paths::resolve(); crate::settings::load(&p.settings, &p.vault).get("pwOffer").and_then(|v| v.as_bool()) != Some(false) };
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .browser_extensions_enabled(true).data_directory(web_data_dir())
        .additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .initialization_script_for_all_frames(WHEEL_ZOOM_JS)
        .initialization_script(if offer { SIGNIN_JS } else { "" })
        .on_new_window(move |url, features| {
            // a page opening windows in a loop gets a few, not hundreds
            if !popups_ok(&id_popped) { return tauri::webview::NewWindowResponse::Deny; }
            // a sign-in popup (Google asking for the password again, "Sign in with..."): a real popup, so the
            // page that opened it hears back when it is done - as a tab it would wait for ever on a blank page
            if is_sign_in(url.as_str()) {
                return match sign_in_popup(&popped, &id_popped, &url, features) {
                    Some(window) => tauri::webview::NewWindowResponse::Create { window },
                    None => tauri::webview::NewWindowResponse::Deny,
                };
            }
            let _ = popped.emit_to("main", "tabweb:newtab", json!({ "id": id_popped, "url": url.as_str() }));
            tauri::webview::NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            if off_limits(url) { return false; } // a page may not walk into Leonote's own addresses, or another computer's files
            let _ = nav.emit_to("main", "tabweb:url", json!({ "id": id_nav, "url": url.as_str() }));
            true
        })
        .on_document_title_changed(move |_wv, title| {
            let title: String = title.chars().take(300).collect();
            let _ = titled.emit_to("main", "tabweb:title", json!({ "id": id_titled, "title": title }));
        })
        .on_page_load(move |_wv, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = loaded.emit_to("main", "tabweb:url", json!({ "id": id_loaded, "url": payload.url().as_str(), "done": true }));
            }
        });
    window.add_child(builder, pos, size).map_err(|e| format!("Could not open the browser here: {}", e))?;
    if let Some(wv) = app.get_webview(&label) { passwords_now(&wv); favicon_from_page(&app, &wv, id.clone()); app_keys_from_page(&app, &wv); address_from_page(&app, &wv, id.clone()); menu_from_page(&app, &wv, id.clone()); audio_from_page(&app, &wv, id.clone()); failure_from_page(&app, &wv, id.clone()); focus_from_page(&app, &wv, id.clone()); zoom_by_wheel(&app, &wv, false, id.clone()); fullscreen_from_page(&app, &wv, id.clone()); downloads_from_page(&app, &wv, label.clone()); }
    Ok(json!({ "created": true }))
}

/// The private memory of the renderer process holding this tab's page, in
/// bytes - what unloading the page gives back. None when it cannot be told
/// (the process is found through WebView2's process list by the page's
/// frame id; a renderer shared with another page of the same site counts
/// for both).
#[tauri::command]
pub async fn tab_web_memory(app: AppHandle, id: String) -> Result<Option<u64>, String> {
    let wv = app.get_webview(&tab_label(&id)).ok_or("That tab has no page")?;
    #[cfg(windows)]
    {
        use webview2_com::GetProcessExtendedInfosCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment13, ICoreWebView2FrameInfo2, ICoreWebView2_2, ICoreWebView2_20};
        use windows_core::Interface;
        let (tx, rx) = std::sync::mpsc::channel::<Option<u64>>();
        let _ = wv.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { let _ = tx.send(None); return };
            let mut frame = 0u32;
            if core.cast::<ICoreWebView2_20>().and_then(|c| c.FrameId(&mut frame)).is_err() { let _ = tx.send(None); return; }
            let Ok(env) = core.cast::<ICoreWebView2_2>().and_then(|c| c.Environment()).and_then(|e| e.cast::<ICoreWebView2Environment13>()) else { let _ = tx.send(None); return };
            let handler = GetProcessExtendedInfosCompletedHandler::create(Box::new(move |_, infos| {
                let mut found = None;
                if let Some(infos) = infos {
                    let mut n = 0u32;
                    let _ = infos.Count(&mut n);
                    'procs: for k in 0..n {
                        let Ok(info) = infos.GetValueAtIndex(k) else { continue };
                        let Ok(frames) = info.AssociatedFrameInfos() else { continue };
                        let Ok(it) = frames.GetIterator() else { continue };
                        let mut has = windows_core::BOOL(0);
                        while it.HasCurrent(&mut has).is_ok() && has.as_bool() {
                            if let Ok(f) = it.GetCurrent().and_then(|f| f.cast::<ICoreWebView2FrameInfo2>()) {
                                let mut fid = 0u32;
                                if f.FrameId(&mut fid).is_ok() && fid == frame {
                                    let mut pid = 0i32;
                                    if info.ProcessInfo().and_then(|p| p.ProcessId(&mut pid)).is_ok() && pid > 0 { found = private_bytes(pid as u32); }
                                    break 'procs;
                                }
                            }
                            let mut more = windows_core::BOOL(0);
                            if it.MoveNext(&mut more).is_err() || !more.as_bool() { break; }
                        }
                    }
                }
                let _ = tx.send(found);
                Ok(())
            }));
            if env.GetProcessExtendedInfos(&handler).is_err() { /* the handler owns tx now; nothing to send */ }
        });
        return Ok(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(None));
    }
    #[allow(unreachable_code)]
    Ok(None)
}

#[cfg(windows)]
fn private_bytes(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = K32GetProcessMemoryInfo(h, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb).as_bool();
        let _ = CloseHandle(h);
        ok.then_some(c.PrivateUsage as u64)
    }
}

/// A page's sound on or off, from its tab.
#[tauri::command]
pub async fn tab_web_mute(app: AppHandle, id: String, muted: bool) -> Result<(), String> {
    let wv = app.get_webview(&tab_label(&id)).ok_or("That tab has no page")?;
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
        use windows_core::Interface;
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = wv.with_webview(move |pw| unsafe {
            let r = pw.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_8>()).and_then(|c| c.SetIsMuted(muted));
            let _ = tx.send(r.map_err(|e| e.to_string()));
        });
        if let Ok(r) = rx.recv_timeout(std::time::Duration::from_secs(2)) { r?; }
    }
    Ok(())
}

/// A click on the page's own view: the frontend cannot see it, so the page
/// says when it takes the keys (an add-on's popup closes on that).
#[cfg(windows)]
fn focus_from_page(app: &AppHandle, wv: &tauri::Webview, id: String) {
    use tauri::Emitter;
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let handler = webview2_com::FocusChangedEventHandler::create(Box::new(move |_, _| { let _ = handle.emit_to("main", "tabweb:focus", json!({ "id": id })); Ok(()) }));
        let mut token = 0i64;
        let _ = pw.controller().add_GotFocus(&handler, &mut token);
    });
}
#[cfg(not(windows))]
fn focus_from_page(_app: &AppHandle, _wv: &tauri::Webview, _id: String) {}

/// A page's video going full screen (its own button): the page says so, and
/// the frontend gives its view the whole window; leaving it, the same event.
#[cfg(windows)]
fn fullscreen_from_page(app: &AppHandle, wv: &tauri::Webview, id: String) {
    use tauri::Emitter;
    use webview2_com::ContainsFullScreenElementChangedEventHandler;
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core) = sender else { return Ok(()) };
            let mut on = windows_core::BOOL(0);
            let _ = core.ContainsFullScreenElement(&mut on);
            let _ = handle.emit_to("main", "tabweb:fullscreen", json!({ "id": id, "on": on.as_bool() }));
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ContainsFullScreenElementChanged(&handler, &mut token);
    });
}
#[cfg(not(windows))]
fn fullscreen_from_page(_app: &AppHandle, _wv: &tauri::Webview, _id: String) {}

/// A page starting or stopping sound tells its tab (WebView2's IsDocumentPlayingAudioChanged).
#[cfg(windows)]
fn audio_from_page(app: &AppHandle, wv: &tauri::Webview, id: String) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use webview2_com::IsDocumentPlayingAudioChangedEventHandler;
    use windows_core::Interface;
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(c8) = core.cast::<ICoreWebView2_8>() else { return };
        let handler = IsDocumentPlayingAudioChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core) = sender else { return Ok(()) };
            let Ok(c8) = core.cast::<ICoreWebView2_8>() else { return Ok(()) };
            let mut playing = windows_core::BOOL(0);
            let mut muted = windows_core::BOOL(0);
            let _ = c8.IsDocumentPlayingAudio(&mut playing);
            let _ = c8.IsMuted(&mut muted);
            { let mut p = crate::lock(&PLAYING); if playing.as_bool() { p.insert(tab_label(&id)); } else { p.remove(&tab_label(&id)); } }
            let _ = handle.emit_to("main", "tabweb:audio", json!({ "id": id, "playing": playing.as_bool(), "muted": muted.as_bool() }));
            Ok(())
        }));
        let mut token = 0i64;
        let _ = c8.add_IsDocumentPlayingAudioChanged(&handler, &mut token);
    });
}
#[cfg(not(windows))]
fn audio_from_page(_app: &AppHandle, _wv: &tauri::Webview, _id: String) {}

/// The page's renderer crashing or hanging, told to its tab (WebView2's ProcessFailed).
#[cfg(windows)]
fn failure_from_page(app: &AppHandle, wv: &tauri::Webview, id: String) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE};
    use webview2_com::ProcessFailedEventHandler;
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let (handle2, id2) = (handle.clone(), id.clone());
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = Default::default();
            let _ = args.ProcessFailedKind(&mut kind);
            let what = if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE { "unresponsive" }
                else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED { "crashed" }
                else { return Ok(()) };
            let _ = handle.emit_to("main", "tabweb:failed", json!({ "id": id, "kind": what }));
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
        // a page that could not be reached (no network, a firewall, a name that does not resolve): its tab is
        // told why, instead of a blank view that says nothing
        let done = webview2_com::NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut ok = windows_core::BOOL(0);
            let _ = args.IsSuccess(&mut ok);
            if ok.as_bool() { return Ok(()); }
            let mut status = Default::default();
            let _ = args.WebErrorStatus(&mut status);
            let _ = handle2.emit_to("main", "tabweb:failed", json!({ "id": id2, "kind": "nav", "status": status.0 }));
            Ok(())
        }));
        let mut token2 = 0i64;
        let _ = core.add_NavigationCompleted(&done, &mut token2);
    });
}
#[cfg(not(windows))]
fn failure_from_page(_app: &AppHandle, _wv: &tauri::Webview, _id: String) {}

/// A word to a page's script (the Player's browser: "leo:pause" stops its videos).
#[tauri::command]
pub async fn tab_web_post(app: AppHandle, id: String, msg: String) -> Result<(), String> {
    let Some(wv) = app.get_webview(&tab_label(&id)) else { return Ok(()) };
    #[cfg(windows)]
    {
        let _ = wv.with_webview(move |pw| unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() { let _ = core.PostWebMessageAsString(&windows_core::HSTRING::from(msg)); }
        });
    }
    Ok(())
}

/// A page's zoom, for a browser that has little room (the Player's).
#[tauri::command]
pub async fn tab_web_zoom(app: AppHandle, id: String, zoom: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&tab_label(&id)) { wv.set_zoom(zoom.clamp(0.25, 3.0)).map_err(|e| e.to_string())?; }
    Ok(())
}

/// The page takes the keys: Space pauses its video without a click first.
#[tauri::command]
pub async fn tab_web_focus(app: AppHandle, id: String) -> Result<(), String> {
    let Some(wv) = app.get_webview(&tab_label(&id)) else { return Ok(()) };
    wv.set_focus().map_err(|e| e.to_string())?;
    // and the controller itself, in case the window's focus and WebView2's disagree
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
        let _ = wv.with_webview(|pw| unsafe {
            let mut hwnd = windows::Win32::Foundation::HWND::default();
            if pw.controller().ParentWindow(&mut hwnd).is_ok() && !hwnd.is_invalid() { let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(hwnd)); }
            let _ = pw.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        });
    }
    Ok(())
}

/// The app's own shortcuts still work while the page has the keys: Ctrl and
/// Alt combinations are caught before WebView2 acts on them and sent to the
/// frontend as a key event. Only the app's combinations are taken; a page
/// keeps Ctrl+C, Ctrl+F and the like.
#[cfg(windows)]
fn app_keys_from_page(app: &AppHandle, wv: &tauri::Webview) {
    use tauri::Emitter;
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_RMENU, VK_SHIFT};
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let controller = pw.controller();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN { return Ok(()); }
            let mut vk = 0u32;
            args.VirtualKey(&mut vk)?;
            let held = |k: VIRTUAL_KEY| (GetAsyncKeyState(k.0 as i32) as u16 & 0x8000) != 0;
            let (ctrl, alt, shift) = (held(VK_CONTROL), held(VK_MENU), held(VK_SHIFT));
            if !ctrl && !alt { return Ok(()); }
            // AltGr (the right Alt with a Ctrl Windows adds) types ą ó ł, @ € { } [ ]: the page's, always. A right Alt
            // with no Ctrl (US keyboards) stays an Alt, for Alt+1..0 and the rest
            if ctrl && held(VK_RMENU) { return Ok(()); }
            let code = match vk {
                0x41..=0x5A => format!("Key{}", (vk as u8) as char),
                0x30..=0x39 => format!("Digit{}", (vk as u8) as char),
                0x09 => "Tab".to_string(), 0x21 => "PageUp".to_string(), 0x22 => "PageDown".to_string(),
                0xBC => "Comma".to_string(), 0xBE => "Period".to_string(), 0xC0 => "Backquote".to_string(), 0xDC => "Backslash".to_string(),
                0x70..=0x7B => format!("F{}", vk - 0x6F),
                _ => return Ok(()),
            };
            // only the keys Leonote itself answers (main.js KEYMAP and the tab keys) leave the page: the rest - Ctrl+B
            // and Ctrl+I in a mail, Ctrl+Shift+V, Ctrl+Shift+Z, Alt+F4 - are the page's own
            let combo = format!("{}{}{}{}", if ctrl { "Ctrl+" } else { "" }, if shift { "Shift+" } else { "" }, if alt { "Alt+" } else { "" }, code);
            if !app_key(&combo) { return Ok(()); }
            args.SetHandled(true)?;
            let _ = handle.emit_to("main", "tabweb:key", json!({ "code": code, "ctrl": ctrl, "alt": alt, "shift": shift }));
            Ok(())
        }));
        let mut token = 0i64;
        let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
    });
}
/// The combos the app's window answers (main.js KEYMAP, Ctrl+1-9 for tabs) - kept in step with it by hand.
#[cfg(windows)]
fn app_key(combo: &str) -> bool {
    const KEYS: &[&str] = &[
        "Ctrl+KeyN", "Ctrl+KeyO", "Ctrl+KeyQ", "Ctrl+KeyT", "Ctrl+KeyW", "Ctrl+Comma", "Ctrl+Tab", "Ctrl+PageUp", "Ctrl+PageDown",
        "Ctrl+Backslash", "Ctrl+Digit0",
        "Ctrl+Shift+KeyA", "Ctrl+Shift+KeyC", "Ctrl+Shift+KeyE", "Ctrl+Shift+KeyF", "Ctrl+Shift+KeyI", "Ctrl+Shift+KeyN",
        "Ctrl+Shift+KeyO", "Ctrl+Shift+KeyT", "Ctrl+Shift+Tab", "Ctrl+Shift+Backslash", "Ctrl+Shift+Alt+KeyG",
        "Ctrl+Alt+KeyF", "Ctrl+Alt+KeyG", "Ctrl+Alt+KeyK", "Ctrl+Alt+KeyO", "Ctrl+Alt+Backslash",
        "Alt+KeyC", "Alt+KeyD", "Alt+KeyF", "Alt+KeyP", "Alt+KeyR", "Alt+KeyW", "Alt+PageUp", "Alt+PageDown", "Alt+Backquote",
    ];
    KEYS.contains(&combo) || combo.strip_prefix("Ctrl+Digit").or_else(|| combo.strip_prefix("Alt+Digit")).is_some_and(|d| d.len() == 1)
}
#[cfg(not(windows))]
fn app_keys_from_page(_app: &AppHandle, _wv: &tauri::Webview) {}

/// A page that moves on without loading anew (a store, a video site) still
/// tells the bar its address: WebView2's SourceChanged, sent along.
#[cfg(windows)]
fn address_from_page(app: &AppHandle, wv: &tauri::Webview, id: String) {
    use tauri::Emitter;
    use webview2_com::SourceChangedEventHandler;
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let handler = SourceChangedEventHandler::create(Box::new(move |sender, _args| {
            let Some(core) = sender else { return Ok(()) };
            let mut s = windows_core::PWSTR::null();
            if core.Source(&mut s).is_ok() && !s.is_null() {
                let url = s.to_string().unwrap_or_default();
                windows::Win32::System::Com::CoTaskMemFree(Some(s.0 as _));
                // and whether Forward can go anywhere (the bar greys it when not)
                let mut fwd = windows_core::BOOL(0);
                let _ = core.CanGoForward(&mut fwd);
                let _ = handle.emit_to("main", "tabweb:url", json!({ "id": id, "url": url, "fwd": fwd.as_bool() }));
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_SourceChanged(&handler, &mut token);
    });
}
#[cfg(not(windows))]
fn address_from_page(_app: &AppHandle, _wv: &tauri::Webview, _id: String) {}

/// The page's own right-click menu, with Leonote's rows at the top: a link
/// opens in a new tab or in a window of its own.
#[cfg(windows)]
fn menu_from_page(app: &AppHandle, wv: &tauri::Webview, id: String) {
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment9, ICoreWebView2_11, ICoreWebView2_2, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR};
    use webview2_com::{ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler};
    use windows_core::{Interface, HSTRING};
    let handle = app.clone();
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(c11) = core.cast::<ICoreWebView2_11>() else { return };
        let Ok(env) = core.cast::<ICoreWebView2_2>().and_then(|c| c.Environment()).and_then(|e| e.cast::<ICoreWebView2Environment9>()) else { return };
        let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let Ok(target) = args.ContextMenuTarget() else { return Ok(()) };
            let mut s = windows_core::PWSTR::null();
            let _ = target.LinkUri(&mut s);
            if s.is_null() { return Ok(()); }
            let url = s.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(s.0 as _));
            if !url.starts_with("http") { return Ok(()); }
            let Ok(items) = args.MenuItems() else { return Ok(()) };
            let mut at = 0u32;
            // the page's own "Open link in new window" goes: it could only ever open a Leonote tab here
            let mut n = 0u32;
            if items.Count(&mut n).is_ok() {
                for i in (0..n).rev() {
                    let Ok(it) = items.GetValueAtIndex(i) else { continue };
                    let mut nm = windows_core::PWSTR::null();
                    if it.Name(&mut nm).is_ok() && !nm.is_null() {
                        let name = nm.to_string().unwrap_or_default();
                        windows::Win32::System::Com::CoTaskMemFree(Some(nm.0 as _));
                        if name == "openLinkInNewWindow" { let _ = items.RemoveValueAtIndex(i); }
                    }
                }
            }
            // a video, a playlist or a media file: the Player can take it
            let low = url.to_ascii_lowercase();
            let playable = low.contains("youtube.com/watch") || low.contains("youtu.be/") || low.contains("youtube.com/shorts/") || low.contains("youtube.com/playlist") || low.contains("list=")
                || [".mp3", ".mp4", ".m4a", ".webm", ".ogg", ".opus", ".flac", ".wav", ".mkv", ".mov"].iter().any(|e| low.split(['?', '#']).next().unwrap_or("").ends_with(e));
            let rows: &[(&str, &str)] = if playable {
                &[("Open link in a new Leonote tab", "tab"), ("Open link in its own Leonote window", "window"), ("Open link in your browser", "browser"), ("Add to the Player", "player")]
            } else {
                &[("Open link in a new Leonote tab", "tab"), ("Open link in its own Leonote window", "window"), ("Open link in your browser", "browser")]
            };
            for &(label, what) in rows {
                let Ok(item) = env.CreateContextMenuItem(&HSTRING::from(label), None, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND) else { continue };
                let (h2, u2, id2) = (handle.clone(), url.clone(), id.clone());
                let pick = CustomItemSelectedEventHandler::create(Box::new(move |_, _| { let _ = h2.emit_to("main", "tabweb:newtab", json!({ "id": id2, "url": u2, "how": what })); Ok(()) }));
                let mut token = 0i64;
                let _ = item.add_CustomItemSelected(&pick, &mut token);
                let _ = items.InsertValueAtIndex(at, &item);
                at += 1;
            }
            if let Ok(sep) = env.CreateContextMenuItem(&HSTRING::new(), None, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR) { let _ = items.InsertValueAtIndex(at, &sep); }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = c11.add_ContextMenuRequested(&handler, &mut token);
    });
}
#[cfg(not(windows))]
fn menu_from_page(_app: &AppHandle, _wv: &tauri::Webview, _id: String) {}

/// An add-on's popup (its action page) in a small view over the page, at this rectangle (logical px).
static POP_ZOOM: std::sync::Mutex<f64> = std::sync::Mutex::new(1.0);

/// The popup's corner radius in physical pixels: 12 logical, at the window's scale.
fn pop_radius(app: &AppHandle) -> i32 {
    let scale = app.get_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
    (24.0 * scale).round() as i32
}

/// Ctrl+wheel in a page or a popup: the page posts the direction, the zoom factor steps by 10%.
const WHEEL_ZOOM_JS: &str = "window.addEventListener('wheel', function (e) { if (!e.ctrlKey || !window.chrome || !window.chrome.webview) return; e.preventDefault(); window.chrome.webview.postMessage(e.deltaY < 0 ? 'leo:zoom:in' : 'leo:zoom:out'); }, { passive: false, capture: true });\
window.chrome && window.chrome.webview && window.chrome.webview.addEventListener('message', function (e) { if (e.data === 'leo:pause') document.querySelectorAll('video, audio').forEach(function (v) { try { v.pause(); } catch (_) {} }); else if (e.data === 'leo:play') { var all = Array.prototype.slice.call(document.querySelectorAll('video, audio')); var v = all.filter(function (x) { return x.currentTime > 0; })[0] || all[0]; if (v) { try { v.play(); } catch (_) {} } } else if (typeof e.data === 'string' && e.data.indexOf('leo:vol:') === 0) { var k = Math.max(0, Math.min(1, parseFloat(e.data.slice(8)) || 0)); document.querySelectorAll('video, audio').forEach(function (v) { try { v.volume = k; } catch (_) {} }); } });document.addEventListener('play', function (e) { if (!e.target || e.target.tagName !== 'VIDEO' || !window.chrome || !window.chrome.webview) return; var id = ''; try { var p = document.getElementById('movie_player'); if (p && p.getVideoData) id = p.getVideoData().video_id || ''; } catch (_) {} window.chrome.webview.postMessage('leo:video:' + id + '|' + location.href); }, true);";

/// A sign-in noticed in a tab's top page: a filled password field sent off (a form submitted, a button
/// clicked, Enter) - the name and password go to Leonote, which offers to keep them in the vault. A page
/// asking for the name first keeps it for its next step (sessionStorage is the site's own).
const SIGNIN_JS: &str = r#"(function(){if(window.top!==window||!window.chrome||!window.chrome.webview)return;var vis=function(e){return e.offsetParent!==null};var last='';function grab(){var pw=Array.prototype.find.call(document.querySelectorAll('input[type=password]'),function(e){return vis(e)&&e.value});var scope=(pw&&pw.form)||document;var users=Array.prototype.filter.call(scope.querySelectorAll('input[type=email],input[type=text],input[type=tel],input:not([type])'),function(e){return vis(e)&&e.value});var un=null;if(pw){users.forEach(function(e){if(e.compareDocumentPosition(pw)&4)un=e})}else{un=users.find(function(e){return /user|mail|login|name|phone|account|identifier/i.test(e.name+e.id+e.autocomplete+e.placeholder+e.type)})}if(!pw){if(un){try{sessionStorage.setItem('leo:u',un.value)}catch(_){}}return}var u=un?un.value:'';if(!u){try{u=sessionStorage.getItem('leo:u')||''}catch(_){}}var k=u+'\n'+pw.value;if(k===last)return;last=k;window.chrome.webview.postMessage('leo:signin:'+JSON.stringify({u:u,p:pw.value}))}document.addEventListener('submit',grab,true);document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('button,input[type=submit],input[type=button],[role=button]');if(b)grab()},true);document.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target&&e.target.tagName==='INPUT')grab()},true)})();"#;

/// A resize grip in the popup's own page, bottom right (the app cannot draw
/// over a native view): the drag's distance is posted, in screen px, and
/// "done" when let go. Pointer capture keeps the drag alive once the corner
/// has moved from under the pointer.
const POP_GRIP_JS: &str = "(function () { if (window.top !== window || !window.chrome || !window.chrome.webview) return; function add() { if (document.getElementById('leo-grip')) return; var g = document.createElement('div'); g.id = 'leo-grip'; g.title = 'Drag to resize'; g.style.cssText = 'position:fixed;right:0;bottom:0;width:16px;height:16px;z-index:2147483647;cursor:nwse-resize;opacity:.75;background:linear-gradient(135deg,transparent 46%,#8a8a8a 46%,#8a8a8a 54%,transparent 54%,transparent 70%,#8a8a8a 70%,#8a8a8a 78%,transparent 78%)'; g.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); try { g.setPointerCapture(e.pointerId); } catch (_) {} var x0 = e.screenX, y0 = e.screenY; var mv = function (ev) { window.chrome.webview.postMessage('leo:resize:' + (ev.screenX - x0) + ',' + (ev.screenY - y0)); }; var up = function () { g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); window.chrome.webview.postMessage('leo:resize:done'); }; g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up); }); (document.body || document.documentElement).appendChild(g); } if (document.body) add(); else document.addEventListener('DOMContentLoaded', add); })();";

/// "A video started", as a page says it: the top page, or a YouTube frame (an embed), about itself - the address is
/// where the message came from, and only YouTube's own pages may name a video by its id. An ad's frame says nothing.
fn video_message<'a>(rest: &'a str, source: &'a str, top: &str) -> Option<(&'a str, &'a str)> {
    let host = tauri::Url::parse(source).ok()?.host_str()?.to_ascii_lowercase();
    let yt = ["youtube.com", "youtube-nocookie.com"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")));
    if source != top && !yt { return None; }
    let vid = rest.split('|').next().unwrap_or("");
    let ok = yt && vid.len() == 11 && vid.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    Some((if ok { vid } else { "" }, source))
}

#[cfg(windows)]
fn zoom_by_wheel(app: &AppHandle, wv: &tauri::Webview, pop: bool, id: String) {
    use tauri::Emitter;
    use webview2_com::WebMessageReceivedEventHandler;
    let handle = app.clone();
    let (zoom_handle, zoom_id) = (app.clone(), id.clone());
    let _ = wv.with_webview(move |pw| unsafe {
        let controller = pw.controller().clone();
        let Ok(core) = controller.CoreWebView2() else { return };
        let ctl = controller.clone();
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut s = windows_core::PWSTR::null();
            if args.TryGetWebMessageAsString(&mut s).is_err() || s.is_null() { return Ok(()); }
            let msg = s.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(s.0 as _));
            // a video began in the page: the frontend decides what that means (the Player's browser plays it in the Player)
            if let Some(rest) = msg.strip_prefix("leo:video:") {
                let source = pwstr(|p| args.Source(p));
                let top = sender.map(|c| pwstr(|p| c.Source(p))).unwrap_or_default();
                if let Some((vid, href)) = video_message(rest, &source, &top) {
                    let _ = handle.emit_to("main", "tabweb:video", json!({ "id": id, "video": vid, "url": href }));
                }
                return Ok(());
            }
            // a sign-in in a tab: the vault offers to keep it. The site is where the message came from, not what it says
            if let Some(j) = msg.strip_prefix("leo:signin:") {
                if pop { return Ok(()); }
                let mut src = windows_core::PWSTR::null();
                if args.Source(&mut src).is_err() || src.is_null() { return Ok(()); }
                let page = src.to_string().unwrap_or_default();
                windows::Win32::System::Com::CoTaskMemFree(Some(src.0 as _));
                crate::pw::offer(&handle, &id, &page, j);
                return Ok(());
            }
            // the popup's grip: how far it was dragged, or "done"
            if let Some(d) = msg.strip_prefix("leo:resize:") {
                if pop { let _ = handle.emit_to("main", "extpop:resize", json!({ "d": d })); }
                return Ok(());
            }
            let step = match msg.as_str() { "leo:zoom:in" => 1.1, "leo:zoom:out" => 1.0 / 1.1, _ => return Ok(()) };
            let mut z = 1.0f64;
            let _ = ctl.ZoomFactor(&mut z);
            let z = (z * step).clamp(0.25, 5.0);
            let _ = ctl.SetZoomFactor(z);
            // a tab says its zoom through ZoomFactorChanged below - for the wheel and for Ctrl +/- alike
            if pop { *crate::lock(&POP_ZOOM) = z; let _ = handle.emit_to("main", "extpop:zoom", json!({ "zoom": z })); }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_WebMessageReceived(&handler, &mut token);
        // every change of a tab's zoom (Ctrl+wheel, Ctrl +/-, Ctrl+0), so the site keeps it
        if !pop {
            let (zh, zid) = (zoom_handle, zoom_id);
            let changed = webview2_com::ZoomFactorChangedEventHandler::create(Box::new(move |c, _| {
                let Some(c) = c else { return Ok(()) };
                let mut z = 1.0f64;
                let _ = c.ZoomFactor(&mut z);
                let _ = zh.emit_to("main", "tabweb:zoom", json!({ "id": zid, "zoom": z }));
                Ok(())
            }));
            let mut t2 = 0i64;
            let _ = controller.add_ZoomFactorChanged(&changed, &mut t2);
        }
    });
}
#[cfg(not(windows))]
fn zoom_by_wheel(_app: &AppHandle, _wv: &tauri::Webview, _pop: bool, _id: String) {}

#[tauri::command]
pub async fn ext_pop_show(app: AppHandle, url: String, x: f64, y: f64, w: f64, h: f64, zoom: Option<f64>) -> Result<(), String> {
    let (pos, size) = split_rect(x, y, w, h);
    let zoom = zoom.unwrap_or(1.0).clamp(0.5, 2.0);
    let parsed: tauri::Url = check_url(&url)?.parse().map_err(|_| "That address is not a web address".to_string())?;
    if off_limits(&parsed) { return Err("That address is not a web address".into()); }
    *crate::lock(&POP_ZOOM) = zoom;
    if let Some(wv) = app.get_webview("extpop") {
        // the same page again (a resize, a re-open): it stays as it is, no reload
        if wv.url().map(|u| u != parsed).unwrap_or(true) { wv.navigate(parsed).map_err(|e| e.to_string())?; }
        wv.set_position(pos).map_err(|e| e.to_string())?;
        wv.set_size(size).map_err(|e| e.to_string())?;
        let _ = wv.show();
        raise_view(&wv);
        let _ = wv.set_zoom(zoom);
        round_view(&wv, pop_radius(&app));
        return Ok(());
    }
    let window = app.get_window("main").ok_or("The main window is gone")?;
    // the zoom set before the page is up does not always hold: set again once it has loaded
    let builder = tauri::webview::WebviewBuilder::new("extpop", WebviewUrl::External(parsed)).browser_extensions_enabled(true).data_directory(web_data_dir()).additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler().zoom_hotkeys_enabled(true)
        .initialization_script_for_all_frames(WHEEL_ZOOM_JS)
        .initialization_script_for_all_frames(POP_GRIP_JS)
        // as in every other web view: never into Leonote's own pages or a file on another computer
        .on_navigation(|u| !off_limits(u))
        .on_page_load(|wv, payload| { if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) { let z = *crate::lock(&POP_ZOOM); let _ = wv.set_zoom(z); } });
    window.add_child(builder, pos, size).map_err(|e| e.to_string())?;
    if let Some(wv) = app.get_webview("extpop") {
        no_app_files(&wv);
        raise_view(&wv);
        let _ = wv.set_zoom(zoom);
        round_view(&wv, pop_radius(&app));
        zoom_by_wheel(&app, &wv, true, "extpop".into());
        downloads_from_page(&app, &wv, "extpop".into()); // an add-on's popup asks before a download, as a tab does
    }
    Ok(())
}
/// A child view brought to the front of its siblings (the page's view sits beneath it).
#[cfg(windows)]
fn raise_view(wv: &tauri::Webview) {
    let _ = wv.with_webview(|pw| unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE};
        let mut hwnd = windows::Win32::Foundation::HWND::default();
        if pw.controller().ParentWindow(&mut hwnd).is_ok() && !hwnd.is_invalid() {
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    });
}
#[cfg(not(windows))]
fn raise_view(_wv: &tauri::Webview) {}

#[tauri::command]
pub async fn ext_pop_hide(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview("extpop") { let _ = wv.close(); }
    Ok(())
}

/// Out of sight without losing the page. No id hides them all.
#[tauri::command]
pub async fn tab_web_hide(app: AppHandle, id: Option<String>, sleep: Option<u64>, awake: Option<u64>) -> Result<(), String> {
    let only = id.map(|i| tab_label(&i));
    for (l, wv) in app.webviews() {
        if l.starts_with(TAB_WEB) && only.as_ref().is_none_or(|o| *o == l) {
            let _ = wv.hide();
            doze(&app, l, sleep.unwrap_or(0), awake.unwrap_or(0));
        }
    }
    Ok(())
}

/// Close these tabs' browsers; `keep` instead closes every one that is NOT listed.
#[tauri::command]
pub async fn tab_web_close(app: AppHandle, ids: Vec<String>, keep: Option<bool>) -> Result<(), String> {
    let labels: Vec<String> = ids.iter().map(|i| tab_label(i)).collect();
    for (l, wv) in app.webviews() {
        if l.starts_with(TAB_WEB) && (labels.contains(&l) != keep.unwrap_or(false)) {
            let _ = wv.close();
            crate::lock(&HIDDEN).remove(&l);
            crate::lock(&PLAYING).remove(&l);
        }
    }
    Ok(())
}

/// back | forward | reload | stop - the page's own history, asked of the page.
#[tauri::command]
pub async fn tab_web_go(app: AppHandle, id: String, action: String) -> Result<(), String> {
    let Some(wv) = app.get_webview(&tab_label(&id)) else { return Ok(()) };
    // WebView2's own commands: they work on a page that is blank, stuck or crashed, where a script cannot run
    #[cfg(windows)]
    {
        let a = action.clone();
        let done = wv.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let _ = match a.as_str() { "back" => core.GoBack(), "forward" => core.GoForward(), "reload" => core.Reload(), "stop" => core.Stop(), _ => Ok(()) };
        });
        if done.is_ok() && matches!(action.as_str(), "back" | "forward" | "reload" | "stop") { return Ok(()); }
    }
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        _ => return Err("unknown action".into()),
    };
    wv.eval(js).map_err(|e| e.to_string())
}

/// The app's own menus and popups cannot be drawn over a native view: the
/// view is cut away under them instead (rectangles in physical px, relative
/// to the view), so what is beneath - the app - shows through the holes.
#[cfg(windows)]
fn punch_holes(wv: &tauri::Webview, holes: &[Vec<f64>]) {
    let holes: Vec<Vec<f64>> = holes.to_vec();
    let _ = wv.with_webview(move |pw| unsafe {
        use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF};
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
        // the child window wry made for this view: the one the controller sits in
        let mut hwnd = windows::Win32::Foundation::HWND::default();
        if pw.controller().ParentWindow(&mut hwnd).is_err() || hwnd.is_invalid() { return }
        if holes.is_empty() {
            let _ = SetWindowRgn(hwnd, None, true);
            return;
        }
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let rgn = CreateRectRgn(0, 0, rc.right - rc.left, rc.bottom - rc.top);
        for h in &holes {
            if h.len() < 4 { continue; }
            // a fifth number is a corner radius: the hole is rounded, like the frame it is for
            let r = h.get(4).copied().unwrap_or(0.0) as i32;
            let hole = if r > 0 { CreateRoundRectRgn(h[0] as i32, h[1] as i32, (h[0] + h[2]) as i32, (h[1] + h[3]) as i32, r, r) } else { CreateRectRgn(h[0] as i32, h[1] as i32, (h[0] + h[2]) as i32, (h[1] + h[3]) as i32) };
            let _ = CombineRgn(Some(rgn), Some(rgn), Some(hole), RGN_DIFF);
            let _ = DeleteObject(hole.into());
        }
        let _ = SetWindowRgn(hwnd, Some(rgn), true); // the system owns the region from here
    });
}
#[cfg(not(windows))]
fn punch_holes(_wv: &tauri::Webview, _holes: &[Vec<f64>]) {}

/// A child view with rounded corners, as the frame drawn around it has.
#[cfg(windows)]
fn round_view(wv: &tauri::Webview, radius_px: i32) {
    let _ = wv.with_webview(move |pw| unsafe {
        use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
        let mut hwnd = windows::Win32::Foundation::HWND::default();
        if pw.controller().ParentWindow(&mut hwnd).is_err() || hwnd.is_invalid() { return }
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let rgn = CreateRoundRectRgn(0, 0, rc.right - rc.left + 1, rc.bottom - rc.top + 1, radius_px, radius_px);
        let _ = SetWindowRgn(hwnd, Some(rgn), true);
    });
}
#[cfg(not(windows))]
fn round_view(_wv: &tauri::Webview, _radius_px: i32) {}

#[cfg(windows)]
fn round_window(w: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
    let (Ok(hwnd), Ok(size)) = (w.hwnd(), w.outer_size()) else { return };
    let d = (w.scale_factor().unwrap_or(1.0) * 34.0).round() as i32; // the card's 16px corners, a hair wider
    unsafe {
        // the system owns the region once it is set
        let rgn = CreateRoundRectRgn(0, 0, size.width as i32 + 1, size.height as i32 + 1, d, d);
        let _ = SetWindowRgn(hwnd, Some(rgn), true);
    }
}
#[cfg(not(windows))]
fn round_window(_w: &tauri::WebviewWindow) {}

/// The mini player: a small always-on-top window of Leonote's own (mini.html)
/// that shows what is playing and has the three buttons. The webview's
/// document-picture-in-picture is not there in WebView2, so this is a real
/// window. `open: false` closes it. Returns whether it is open afterwards.
#[tauri::command]
pub async fn mini_player(app: AppHandle, open: bool) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("mini") {
        if open {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(true);
        }
        w.close().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    if !open {
        return Ok(false);
    }
    let mini = WebviewWindowBuilder::new(&app, "mini", WebviewUrl::App("mini.html".into()))
        .additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler()
        .title("Leonote player")
        .inner_size(400.0, 104.0)
        // from a full card down to a button-sized square: mini.html lays itself out by what it is given
        .min_inner_size(56.0, 56.0)
        .max_inner_size(1100.0, 640.0)
        .decorations(false)
        // see-through, so the card's rounded corners are the window's corners:
        // an opaque window left its square corners showing round the card
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(true)
        .build()
        .map_err(|e| format!("Could not open the mini player: {}", e))?;
    // The window itself is cut to the card's rounded shape: see-through alone
    // still left the frame's square corners showing round the card.
    round_window(&mini);
    let again = mini.clone();
    mini.on_window_event(move |ev| {
        if matches!(ev, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
            round_window(&again);
        }
    });
    Ok(true)
}

/// The video's own small window (ytmini.html): an online video goes on in it, on top of everything and in sight,
/// while Leonote is minimized or in the tray - YouTube's player terms ask for a player that is seen, at least
/// 200 px high. `open: false` closes it. Closed in any way, the main window hears "gone".
#[tauri::command]
pub async fn yt_mini(app: AppHandle, open: bool) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("ytmini") {
        if open { let _ = w.unminimize(); let _ = w.show(); return Ok(true); }
        w.close().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    if !open { return Ok(false); }
    let w = WebviewWindowBuilder::new(&app, "ytmini", WebviewUrl::App("ytmini.html".into()))
        .additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler()
        .title("Leonote video")
        .inner_size(400.0, 253.0)
        // never under the player's least: 356 x 200 of video, the bar above it
        .min_inner_size(356.0, 228.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true)
        // the player's own "watch on YouTube" and such: in the browser, not in a bare window
        .on_new_window(move |u, _| {
            if matches!(u.scheme(), "http" | "https") { let _ = tauri_plugin_opener::open_url(u.as_str(), None::<&str>); }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| format!("Could not open the video window: {}", e))?;
    let main = app.clone();
    w.on_window_event(move |ev| {
        if matches!(ev, tauri::WindowEvent::Destroyed) { let _ = main.emit_to("main", "ytmini:cmd", json!({ "cmd": "gone" })); }
    });
    Ok(true)
}

/// A break's card on the desktop while Leonote is minimized or in the tray (breakpop.html): small, on top, at the
/// top right of the screen, never taking the focus. `open: false` closes it.
#[tauri::command]
pub async fn break_pop(app: AppHandle, open: bool) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("breakpop") {
        if open { let _ = w.show(); return Ok(true); }
        w.close().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    if !open { return Ok(false); }
    let (wd, ht) = (320.0, 150.0); // breakpop.js fits the height to what it shows
    let mut b = WebviewWindowBuilder::new(&app, "breakpop", WebviewUrl::App("breakpop.html".into()))
        .additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler()
        .title("Leonote break")
        .inner_size(wd, ht)
        .min_inner_size(240.0, 100.0)
        .resizable(true)
        .decorations(false)
        // see-through and cut round, as the mini player: no square corners round the card
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true);
    if let Some(m) = app.primary_monitor().ok().flatten() {
        let s = m.scale_factor();
        let (mx, my) = (m.position().x as f64 / s, m.position().y as f64 / s);
        let mw = m.size().width as f64 / s;
        b = b.position(mx + mw - wd - 16.0, my + 16.0);
    }
    let w = b.build().map_err(|e| format!("Could not show the break: {}", e))?;
    round_window(&w);
    let again = w.clone();
    w.on_window_event(move |ev| { if matches!(ev, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) { round_window(&again); } });
    Ok(true)
}

/// Open the shortcut's window, or focus it if it is already open.
#[tauri::command]
pub async fn web_window_open(
    app: AppHandle,
    id: String,
    url: String,
    title: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    x: Option<f64>,
    y: Option<f64>,
    always_on_top: Option<bool>,
    navigate: Option<bool>,
) -> Result<Value, String> {
    let url = check_url(&url)?;
    let label = label_for(&id);
    if let Some(w) = app.get_webview_window(&label) {
        // A shortcut only focuses its window - whatever the user browsed to
        // stays. A search says `navigate`, because the window is the slot and
        // the query is what changed.
        if navigate.unwrap_or(false) {
            if let Ok(parsed) = url.parse() {
                let _ = w.navigate(parsed);
            }
        }
        let _ = w.unminimize();
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(json!({ "label": label, "focused": true }));
    }
    let parsed = url.parse().map_err(|_| "That address is not a web address".to_string())?;
    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .browser_extensions_enabled(true).data_directory(web_data_dir())
        .additional_browser_args(BROWSER_ARGS).disable_drag_drop_handler()
        .on_navigation(|u| !off_limits(u))
        .title(title.unwrap_or_else(|| "Leonote — web".into()))
        .inner_size(width.unwrap_or(980.0).clamp(240.0, 6000.0), height.unwrap_or(760.0).clamp(200.0, 6000.0))
        .always_on_top(always_on_top.unwrap_or(false))
        .visible(true);
    match (x, y) {
        (Some(x), Some(y)) => b = b.position(x, y),
        _ => b = b.center(),
    }
    let w = b.build().map_err(|e| format!("Could not open that page: {}", e))?;
    passwords_now(w.as_ref());
    downloads_from_page(&app, w.as_ref(), label.clone());

    // The last size and position travel home as the window closes, so the
    // shortcut opens where you left it next time.
    let handle = app.clone();
    let wid = id.clone();
    let win = w.clone();
    w.on_window_event(move |ev| {
        if let tauri::WindowEvent::CloseRequested { .. } = ev {
            let _ = handle.emit("web:closed", json!({ "id": wid, "geometry": geometry(&win) }));
        }
    });
    Ok(json!({ "label": label, "focused": false }))
}

#[tauri::command]
pub async fn web_window_close(app: AppHandle, id: String) -> Result<Value, String> {
    let label = label_for(&id);
    let Some(w) = app.get_webview_window(&label) else {
        return Ok(json!({ "closed": false }));
    };
    let g = geometry(&w);
    w.close().map_err(|e| e.to_string())?;
    Ok(json!({ "closed": true, "geometry": g }))
}

/// Which shortcuts have a window open, and where each one is.
#[tauri::command]
pub async fn web_window_list(app: AppHandle) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for (label, w) in app.webview_windows() {
        if !is_web_label(&label) {
            continue;
        }
        out.push(json!({ "label": label, "geometry": geometry(&w) }));
    }
    Ok(out)
}

/// Quitting Leonote takes its web panels with it: they are part of the app,
/// not stray browser windows the user has to hunt down afterwards.
pub fn close_all(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if is_web_label(&label) {
            let _ = w.destroy();
        }
    }
}

#[cfg(test)]
mod url_tests {
    #[test]
    fn a_page_goes_to_no_other_computers_files() {
        let off = |u: &str| super::off_limits(&u.parse().unwrap());
        for bad in ["file://host/share/x.html", "file:////host/share/x", "file:///%5C%5Chost/x", "http://tauri.localhost/"] { assert!(off(bad), "{bad}"); }
        for ok in ["file:///C:/site/index.html", "https://example.com/"] { assert!(!off(ok), "{ok}"); }
    }
    #[test]
    fn file_addresses_only_on_this_computers_drives() {
        for ok in ["file:///C:/Users/me/page.html", "https://example.com"] { assert!(super::check_url(ok).is_ok(), "{ok}"); }
        for bad in ["file://host/share/a.html", "file:////host/share/a.html", "file:///%5C%5Chost/a.html", "file:///C:/a%5Cb.html", "file:///etc/x", "file:"] {
            assert!(super::check_url(bad).is_err(), "{bad} must be refused");
        }
    }
}
