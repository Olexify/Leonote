//! The vault: notes are plain Markdown files in a normal folder.
//!
//! No database, no sidecar index. That is the whole point: the same folder
//! opens in Obsidian, diffs in git, and an AI agent can edit a note with the
//! file tools it already has. Everything the app knows is re-derivable by
//! reading the folder.
//!
//! Every path that crosses the IPC boundary is VAULT-RELATIVE with forward
//! slashes (`Docs/Ideas/plan.md`) and is validated here, because the webview
//! is the less trusted side: a bug or an injected script there must not be
//! able to write `..\..\AppData\...`.

use serde::Serialize;
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Note {
    pub path: String,
    pub content: String,
    /// ms since the Unix epoch
    pub mtime: u64,
}

/// A vault file that is not a note: listed, served and opened externally,
/// never edited.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    /// ms since the Unix epoch
    pub mtime: u64,
    /// see `file_kind`
    pub kind: &'static str,
}

#[derive(Debug, Default, Serialize)]
pub struct Scan {
    pub notes: Vec<Note>,
    /// Every folder, including empty ones - the file list alone cannot show
    /// a folder the user just created.
    pub folders: Vec<String>,
    /// Every regular file that is not a note.
    pub files: Vec<FileEntry>,
}

/// Extensions that are text notes: scanned with content, edited, watched and
/// echo-hashed. Everything else in the vault is a `FileEntry`.
pub const NOTE_EXTS: &[&str] = &["md", "txt"];

/// Largest non-note text file `read_file_text` hands to the webview.
pub const MAX_TEXT_READ: u64 = 2 * 1024 * 1024;

/// A note file above this is not loaded as a note: everything is read at startup and held in the page. It stays in
/// the tree as a file that opens in its own app.
pub const MAX_NOTE: u64 = 64 * 1024 * 1024;

fn too_big_for_a_note(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() > MAX_NOTE)
}

/// Lowercase extension of the last path segment. A dotfile (`.md`) has none.
fn ext_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty() && !ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

/// A note by extension (`NOTE_EXTS`), for a bare name or a vault-relative path.
pub fn is_note(rel: &str) -> bool {
    ext_of(rel).is_some_and(|e| NOTE_EXTS.contains(&e.as_str()))
}

/// What the UI does with a non-note file:
/// `image` / `pdf` / `media` render inline, `text` previews read-only,
/// `office` / `other` open in the OS default app.
pub fn file_kind(rel: &str) -> &'static str {
    match ext_of(rel).as_deref().unwrap_or("") {
        "png" | "jpg" | "jpeg" | "jfif" | "gif" | "webp" | "svg" | "bmp" | "avif" | "ico" | "heic" | "heif" => "image",
        "pdf" => "pdf",
        "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" | "odt" | "ods" => "office",
        "csv" | "tsv" | "json" | "jsonc" | "yml" | "yaml" | "log" | "ini" | "cfg" | "conf" | "toml" | "xml"
        | "canvas" | "excalidraw" | "leovector" | "leopaint" | "leocanvas" | "leovideo" | "base" | "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "css" | "scss" | "sass" | "less"
        | "html" | "htm" | "vue" | "svelte" | "py" | "pyw" | "rs" | "go" | "java" | "kt" | "kts" | "c" | "h"
        | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "cs" | "php" | "rb" | "lua" | "r" | "sql" | "sh" | "bash"
        | "zsh" | "ps1" | "psm1" | "bat" | "cmd" | "swift" | "dart" | "scala" | "pl" | "ex" | "exs" | "erl"
        | "hs" | "clj" | "gradle" | "properties" | "env" | "gitignore" | "dockerfile" | "makefile" | "tex"
        | "rst" | "adoc" | "org" | "srt" | "vtt" | "diff" | "patch" => "text",
        "mp4" | "webm" | "mkv" | "mov" | "m4v" | "mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac" | "opus" | "oga" | "weba" => "media",
        "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "cab" | "iso" => "archive",
        _ => "other",
    }
}

/// Types Windows RUNS rather than opens. The vault is synced, shared and
/// written by agents; one click on a planted `.js`, `.bat` or `.lnk` must not
/// be a code-execution path. Reveal in Explorer still works for these.
const LAUNCHABLE: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi",
    "msp", "mst", "scr", "pif", "cpl", "hta", "reg", "lnk", "url", "appref-ms", "application", "jar",
    "gadget", "msc", "inf", "scf", "settingcontent-ms", "diagcab", "appx", "msix", "appinstaller",
    // help files and Excel add-ins run code; a disk image mounts (and its files skip Windows' "from the
    // internet" warning); library, search and site shortcuts point Windows elsewhere; script components;
    // Office files that carry macros
    "chm", "xll", "iso", "img", "vhd", "vhdx", "library-ms", "search-ms", "searchconnector-ms", "website",
    "wsc", "sct", "ws", "ps1xml", "psc1", "msh", "msh1", "msh2", "mshxml", "xbap", "url", "desktop",
    "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm",
    // Python runs a script it is handed; Java Web Start, remote-desktop and theme files and Windows update
    // packages act on their own; Access's compiled databases and shell scraps carry code
    "py", "pyw", "pyz", "pyzw", "jnlp", "rdp", "theme", "themepack", "deskthemepack", "msu", "mde", "accde", "ade", "adp", "shb", "shs",
    // shells and interpreters that may be installed (Git for Windows runs a .sh); compiled Python; Office add-ins,
    // troubleshooters and sandbox configs act on their own; more Office kinds that carry macros
    "sh", "bash", "pyc", "pyo", "pl", "rb", "vsto", "diagcfg", "diagpkg", "wsb", "xlsb", "xla", "xlt", "dot", "pot", "pps", "mdb", "accdb",
    // Excel web and data links; certificates (an install is one wizard away); saved web pages; more add-ins,
    // installers, libraries and Access shortcuts: the rest of what Outlook refuses to open as an attachment
    "iqy", "slk", "dqy", "rqy", "oqy", "odc", "udl", "cer", "crt", "der", "p7b", "p7c", "pfx", "p12", "mht", "mhtml",
    "appxbundle", "msixbundle", "vsix", "ocx", "dll", "sys", "drv", "xlm", "xlw", "ppa", "wll", "wiz",
    "bas", "vb", "vbp", "csh", "ksh", "fxp", "grp", "hlp", "hpj", "cnt", "htc", "ins", "isp", "its", "mcf", "osd", "plg", "prf", "prg",
    "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau", "mav", "maw", "mda", "mdt", "mdw", "mdz",
    "ps2", "ps2xml", "psc2", "psdm1", "msh1xml", "msh2xml", "vsmacros", "vsw", "webpnp", "xnk", "printerexport", "appcontent-ms",
    "app", "asp", "aspx", "asx", "bgi", "cab", "ops", "pcd", "pssc", "pst", "tmp",
    // a provisioning package changes the computer's settings
    "ppkg",
    // ponytail: a list, so a file type Windows adds later opens until it is added here; a list of what may open would stop that but refuse every unknown program's own files. .doc, .xls and .ppt stay out on purpose: common, and Office asks before it runs their macros
];

pub fn is_launchable(rel: &str) -> bool {
    // the name as Windows will take it: trailing dots and spaces dropped ("evil.exe." runs evil.exe); a colon in a
    // file's name is an alternate stream ("notes.txt:evil.exe"), never an ordinary file - never launched
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    if name.contains(':') { return true; }
    let name = name.trim_end_matches(['.', ' ']);
    ext_of(name).is_some_and(|e| LAUNCHABLE.contains(&e.as_str()))
}

/// What a rename or trash operates on. Notes and files are both regular
/// files; they are kept apart so a note move always goes through the
/// note command and its echo bookkeeping.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Entry {
    Note,
    File,
    Folder,
}

impl Entry {
    fn label(self) -> &'static str {
        match self {
            Entry::Note => "note",
            Entry::File => "file",
            Entry::Folder => "folder",
        }
    }
}

/// Vault location: `LEONOTE_VAULT`, then `settings.vault`, then `~/LeoNote`.
/// Pure so the precedence is testable without touching process env.
pub fn vault_root(env: Option<&str>, settings: &Value, home: &Path) -> PathBuf {
    if let Some(e) = env.filter(|e| !e.trim().is_empty()) {
        return PathBuf::from(e);
    }
    if let Some(s) = settings.get("vault").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(s);
        return if p.is_absolute() { p } else { home.join(p) };
    }
    home.join("LeoNote")
}

/// True when neither `LEONOTE_VAULT` nor `settings.vault` picks the vault -
/// the same precedence as `vault_root`.
pub fn is_default_vault(env: Option<&str>, settings: &Value) -> bool {
    env.filter(|e| !e.trim().is_empty()).is_none()
        && settings.get("vault").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).is_none()
}

// ── path validation ─────────────────────────────────────────────────────────

/// A name Windows keeps for a device (the part before the first dot: NUL.md, com1.txt, LPT¹.png, CONIN$) - a
/// file by that name opens the device instead. One list for every place that names a file.
pub fn is_device_name(stem: &str) -> bool {
    let s = stem.trim_end().to_uppercase();
    if matches!(s.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") { return true; }
    let mut c = s.chars();
    let head: String = c.by_ref().take(3).collect();
    let tail: Vec<char> = c.collect();
    (head == "COM" || head == "LPT") && tail.len() == 1 && matches!(tail[0], '0'..='9' | '¹' | '²' | '³')
}

/// Reject anything that is not a plain vault-relative path.
///
/// Dot-prefixed segments are refused too: `.trash`, `.git`, `.obsidian` and
/// `.leonote` belong to other tools (or to us), scan never shows them, and a
/// note written there would silently vanish from the UI.
pub fn check_rel(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("empty path".into());
    }
    if rel.starts_with('/') || rel.contains('\\') {
        return Err(format!("not a vault-relative forward-slash path: {}", rel));
    }
    for seg in rel.split('/') {
        if seg.is_empty() {
            return Err(format!("empty path segment in {}", rel));
        }
        if seg.starts_with('.') {
            return Err(format!("dot-prefixed names are reserved: {}", rel));
        }
        if seg.chars().any(|c| (c as u32) < 32 || "<>:\"|?*".contains(c)) {
            return Err(format!("invalid character in {}", rel));
        }
        // Windows silently strips these, so `a.` and `a` would be one file.
        if seg.ends_with(' ') || seg.ends_with('.') {
            return Err(format!("names may not end in a space or dot: {}", rel));
        }
        if is_device_name(seg.split('.').next().unwrap_or("")) {
            return Err(format!("reserved Windows name: {}", rel));
        }
    }
    Ok(())
}

/// Files from outside the vault the user opened in Leonote ("guests"), by id.
/// They go through every file command under `@guest/<id>/<name>`, so the
/// vault's own viewers and editors work on them unchanged - but only these
/// exact files, each one opened on purpose.
pub static GUESTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, PathBuf>>> = std::sync::LazyLock::new(Default::default);
pub const GUEST_PREFIX: &str = "@guest/";

/// A stable id for an outside file: the same path gives the same id, run after run.
pub fn guest_id(abs: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in abs.to_string_lossy().to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:012x}", h & 0xffff_ffff_ffff)
}

pub fn is_guest(rel: &str) -> bool {
    rel.starts_with(GUEST_PREFIX)
}

/// Validated absolute path for a vault-relative one.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if let Some(rest) = rel.strip_prefix(GUEST_PREFIX) {
        let (id, name) = rest.split_once('/').unwrap_or((rest, ""));
        let p = GUESTS.lock().unwrap().get(id).cloned().ok_or_else(|| format!("that outside file is not open: {}", rel))?;
        // exactly that file: a name beside it in its folder is not a way in
        let own = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if own != name.to_lowercase() {
            return Err(format!("only the outside file itself can be used: {}", rel));
        }
        return Ok(p);
    }
    check_rel(rel)?;
    let mut p = root.to_path_buf();
    for seg in rel.split('/') {
        p.push(seg);
    }
    ensure_inside(root, &p)?;
    Ok(p)
}

pub fn resolve_note(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !is_note(rel) {
        return Err(format!("notes must end in .{}: {}", NOTE_EXTS.join(" or ."), rel));
    }
    resolve(root, rel)
}

/// Validated absolute path for a non-note file.
pub fn resolve_file(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // checked first: a size look at the page's raw path (a network path replaces the root) would reach another computer
    let p = resolve(root, rel)?;
    if is_note(rel) && (is_guest(rel) || !too_big_for_a_note(&p)) {
        return Err(format!("a note, not a file: {}", rel));
    }
    Ok(p)
}

/// What renames, moves, deletes or restores: an outside file is never one of them, whatever the page asks.
fn resolve_entry(root: &Path, rel: &str, kind: Entry) -> Result<PathBuf, String> {
    if is_guest(rel) { return Err("that file is outside the vault - Leonote does not move or delete it".into()); }
    match kind {
        Entry::Note => resolve_note(root, rel),
        Entry::File => resolve_file(root, rel),
        Entry::Folder => resolve(root, rel),
    }
}

/// The lexical checks cannot see a junction or symlink inside the vault that
/// points elsewhere, so resolve the deepest part that exists and compare.
fn ensure_inside(root: &Path, p: &Path) -> Result<(), String> {
    let croot = match std::fs::canonicalize(root) {
        Ok(c) => c,
        Err(_) => return Ok(()), // no vault yet: nothing inside it can point out
    };
    let mut probe = p;
    loop {
        if probe.symlink_metadata().is_ok() {
            let c = std::fs::canonicalize(probe).map_err(|e| format!("resolve {}: {}", probe.display(), e))?;
            if !c.starts_with(&croot) {
                return Err(format!("path escapes the vault: {}", p.display()));
            }
            return Ok(());
        }
        match probe.parent() {
            Some(pp) if pp.starts_with(root) => probe = pp,
            _ => return Ok(()),
        }
    }
}

/// Vault-relative forward-slash form of an absolute path under `root`.
pub fn rel_of(root: &Path, abs: &Path) -> Option<String> {
    let rest = abs.strip_prefix(root).ok()?;
    let parts: Vec<String> = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    if parts.is_empty() { None } else { Some(parts.join("/")) }
}

/// Kinds Leonote may write back: text and code, pictures, PDFs, and the Office
/// formats it can edit. Legacy binary .doc/.xls are read-only.
///
/// Saying yes to a kind here does not weaken anything else: `file_write` still
/// resolves the path inside the vault and still copies the old file into
/// `.trash` before the first overwrite of a session. PDFs earn their place
/// because Leonote now writes them itself (annotations, page order, filled
/// forms) rather than handing them to another program.
pub fn is_writable(rel: &str) -> bool {
    match file_kind(rel) {
        "text" | "image" | "pdf" | "media" => true,
        "office" => matches!(ext_of(rel).as_deref(), Some("docx") | Some("xlsx")),
        _ if ext_of(rel).as_deref() == Some("rtf") => true,
        _ => false,
    }
}

/// A file's entry as the frontend knows it, fresh from disk.
pub fn file_entry(root: &Path, rel: &str) -> Result<FileEntry, String> {
    let p = resolve_file(root, rel)?;
    // a guest's kind comes from its own name, like any file's
    let md = std::fs::metadata(&p).map_err(|e| format!("{}: {}", rel, e))?;
    Ok(FileEntry { kind: file_kind(rel), path: rel.to_string(), size: md.len(), mtime: mtime_ms(&md) })
}

/// Copy a file into .trash before it is first overwritten, so an editor
/// mistake is one restore away. Returns the backup's name.
pub fn backup_file(root: &Path, rel: &str, stamp: &str) -> Result<String, String> {
    copy_to_trash(root, &resolve_file(root, rel)?, rel, stamp)
}

/// The same for a note whose bytes a version could not hold (not UTF-8).
pub fn backup_note(root: &Path, rel: &str, stamp: &str) -> Result<String, String> {
    copy_to_trash(root, &resolve_note(root, rel)?, rel, stamp)
}

/// A name cut to fit with a trash stamp or a temp mark around it under Windows' 255-character limit (a note
/// named that long outside Leonote could otherwise be neither saved nor trashed); its file type is kept.
fn fit(name: &str) -> String {
    if name.encode_utf16().count() <= 200 { return name.into(); }
    let (stem, ext) = name.rsplit_once('.').filter(|(_, e)| e.len() <= 10).unwrap_or((name, ""));
    let (mut s, mut w) = (String::new(), 0);
    for c in stem.chars() { w += c.len_utf16(); if w > 190 { break; } s.push(c); }
    if !ext.is_empty() { s.push('.'); s.push_str(ext); }
    s
}

fn copy_to_trash(root: &Path, p: &Path, rel: &str, stamp: &str) -> Result<String, String> {
    let name = fit(&p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let tdir = root.join(".trash");
    std::fs::create_dir_all(&tdir).map_err(|e| format!("mkdir .trash: {}", e))?;
    let mut entry = format!("{} {}", stamp, name);
    let mut n = 1;
    while tdir.join(&entry).exists() {
        n += 1;
        entry = format!("{} {} ({})", stamp, name, n);
    }
    std::fs::copy(p, tdir.join(&entry)).map_err(|e| format!("back up {}: {}", rel, e))?;
    Ok(entry)
}

pub fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lossy rather than failing: one stray Latin-1 file must not hide a note.
fn read_text(p: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(p)?;
    Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

// ── reading ─────────────────────────────────────────────────────────────────

/// `skip` is Leonote's own data root. In the "vault" data mode it sits inside
/// the vault as a plain folder, and it must stay out of the user's tree: those
/// are our logs and our snapshot, not their notes. A root that lies outside
/// the vault simply never matches. Passed in rather than global so the walk
/// stays hermetic, like every other root here.
/* Folders the user keeps out of the index (Settings › Files › Not indexed; the setting "noIndex", vault-relative
   paths). Left out like a dot-folder: not loaded, searched, graphed or linked, not seen by AI tools - and still
   looked into on request (search's "the not-indexed folders too", the tree's hidden files). */
static NO_INDEX: std::sync::RwLock<Vec<String>> = std::sync::RwLock::new(Vec::new());
/// The list as the user wrote it (any slashes, any case).
pub fn set_no_index(list: &[String]) {
    *NO_INDEX.write().unwrap_or_else(|e| e.into_inner()) = list.iter()
        .map(|s| s.trim().replace('\\', "/").trim_matches('/').to_string())
        // a folder of the vault and nothing else: "C:/Users/me" (a synced settings file can carry any text) would make
        // the search read, and the tree list, a folder outside it
        .filter(|s| check_rel(s).is_ok())
        .collect();
}
/// Read from the settings, where the app keeps it.
pub fn load_no_index(p: &crate::Paths) {
    let s = crate::settings::load(&p.settings, &p.vault);
    let list: Vec<String> = s.get("noIndex").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    set_no_index(&list);
}
pub fn no_index() -> Vec<String> { NO_INDEX.read().unwrap_or_else(|e| e.into_inner()).clone() }
/// A vault-relative path in (or being) a folder left out of the index.
pub fn not_indexed(rel: &str) -> bool {
    let r = rel.replace('\\', "/").to_lowercase();
    NO_INDEX.read().unwrap_or_else(|e| e.into_inner()).iter().any(|f| { let f = f.to_lowercase(); r == f || r.starts_with(&format!("{f}/")) })
}

pub fn scan(root: &Path, skip: Option<&Path>) -> Scan {
    let mut s = Scan::default();
    walk(root, root, &mut s, true, skip);
    read_all(root, &mut s.notes);
    s.notes.sort_by(|a, b| a.path.cmp(&b.path));
    s.folders.sort();
    s.files.sort_by(|a, b| a.path.cmp(&b.path));
    s
}

/// Folders and files, no notes - no file reads (directory listings and the
/// metadata they already carry), so the watcher can afford it.
pub fn tree(root: &Path, skip: Option<&Path>) -> Scan {
    let mut s = Scan::default();
    walk(root, root, &mut s, false, skip);
    s.folders.sort();
    s.files.sort_by(|a, b| a.path.cmp(&b.path));
    s
}

pub fn folders(root: &Path, skip: Option<&Path>) -> Vec<String> {
    tree(root, skip).folders
}

/// Notes under one vault-relative folder ("" = whole vault).
pub fn scan_under(root: &Path, rel_dir: &str, skip: Option<&Path>) -> Vec<Note> {
    let dir = if rel_dir.is_empty() { root.to_path_buf() } else { root.join(rel_dir) };
    let mut s = Scan::default();
    walk(root, &dir, &mut s, true, skip);
    read_all(root, &mut s.notes);
    s.notes.sort_by(|a, b| a.path.cmp(&b.path));
    s.notes
}

/// The walk only lists notes; their text is read here by a few threads at once (a cold start reads
/// thousands of files). A note that cannot be read is left out, as before.
fn read_all(root: &Path, notes: &mut Vec<Note>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let next = AtomicUsize::new(0);
    let texts: Vec<std::sync::Mutex<Option<String>>> = notes.iter().map(|_| std::sync::Mutex::new(None)).collect();
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8).min(notes.len().max(1));
    std::thread::scope(|sc| {
        for _ in 0..workers {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(n) = notes.get(i) else { break };
                if let Ok(t) = read_text(&root.join(&n.path)) { *texts[i].lock().unwrap_or_else(|e| e.into_inner()) = Some(t); }
            });
        }
    });
    let mut texts = texts.into_iter().map(|m| m.into_inner().unwrap_or_else(|e| e.into_inner()));
    notes.retain_mut(|n| match texts.next().flatten() { Some(t) => { n.content = t; true } None => false });
}

/// Case- and separator-insensitive: the same folder reaches us as
/// `G:\Vault\LeoNote` from one path join and `G:/Vault/leonote` from another.
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().replace('\\', "/").to_lowercase()
        == b.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn walk(root: &Path, dir: &Path, out: &mut Scan, read_notes: bool, skip: Option<&Path>) {
    // a folder 200 levels inside the vault (a runaway copy, an archive's own loop) is left out: deeper, the walk would
    // run out of stack and take the app with it
    if dir.components().count() > root.components().count() + 200 { return; }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // .trash, .git, .obsidian, .leonote and our own `.x.tmp` files
        if name.starts_with('.') {
            continue;
        }
        // file_type() does not follow links, so a junction loop cannot hang us
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let path = e.path();
        if ft.is_dir() {
            // our own data folder, when the user put it in the vault
            if skip.map(|s| same_path(s, &path)).unwrap_or(false) {
                continue;
            }
            if let Some(r) = rel_of(root, &path) {
                if not_indexed(&r) { continue; }
                out.folders.push(r);
            }
            walk(root, &path, out, read_notes, skip);
        } else if ft.is_file() && is_note(&name) && !e.metadata().is_ok_and(|m| m.len() > MAX_NOTE) {
            if !read_notes {
                continue;
            }
            let (Some(rel), Ok(md)) = (rel_of(root, &path), e.metadata()) else {
                continue;
            };
            out.notes.push(Note { path: rel, content: String::new(), mtime: mtime_ms(&md) });
        } else if ft.is_file() {
            // DirEntry::metadata comes with the listing on Windows: no extra IO
            let (Some(rel), Ok(md)) = (rel_of(root, &path), e.metadata()) else {
                continue;
            };
            out.files.push(FileEntry { kind: file_kind(&name), path: rel, size: md.len(), mtime: mtime_ms(&md) });
        }
    }
}

/// A non-note text file (kind `text`) for read-only preview. Lossy UTF-8;
/// refused above `MAX_TEXT_READ`, bounded while reading, so a file growing
/// under us cannot blow past the limit either.
pub fn read_file_text(root: &Path, rel: &str) -> Result<String, String> {
    use std::io::Read;
    let p = resolve_file(root, rel)?;
    if file_kind(rel) != "text" {
        return Err(format!("not a text file: {}", rel));
    }
    let f = std::fs::File::open(&p).map_err(|e| format!("open {}: {}", rel, e))?;
    if !f.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return Err(format!("not a file: {}", rel));
    }
    let mut bytes = Vec::new();
    f.take(MAX_TEXT_READ + 1).read_to_end(&mut bytes).map_err(|e| format!("read {}: {}", rel, e))?;
    if bytes.len() as u64 > MAX_TEXT_READ {
        return Err(format!("{} is larger than {} MB", rel, MAX_TEXT_READ / (1024 * 1024)));
    }
    Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// One note, or None when it is gone (or is not a file).
pub fn read_note(root: &Path, rel: &str) -> Option<Note> {
    let p = root.join(rel);
    let md = std::fs::metadata(&p).ok()?;
    if !md.is_file() || md.len() > MAX_NOTE {
        return None;
    }
    Some(Note { path: rel.to_string(), content: read_text(&p).ok()?, mtime: mtime_ms(&md) })
}

/// `read_note` found nothing, but the file is there as a note: a sync or a scanner is holding it. Not gone.
pub fn note_held(root: &Path, rel: &str) -> bool {
    let p = root.join(rel);
    std::fs::metadata(&p).map_or_else(|_| p.try_exists().unwrap_or(true), |m| m.is_file() && m.len() <= MAX_NOTE)
}

// ── writing ─────────────────────────────────────────────────────────────────

/// Rename with a short retry: an editor, indexer or AV scanner holding the
/// target open without FILE_SHARE_DELETE fails the rename for a few ms.
fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for i in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(e),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(15 * (i + 1)));
    }
    Err(last.unwrap())
}

/// Atomic write: `.<name>.tmp` in the SAME directory (so the rename never
/// crosses a volume, and the dot keeps it out of scan and the watcher),
/// fsync, rename over. A crash leaves the old file or the new one, never half.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| std::io::Error::other("no parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let name = path.file_name().ok_or_else(|| std::io::Error::other("no file name"))?;
    let (full, short) = (name.to_string_lossy(), fit(&name.to_string_lossy()));
    let tmp = if short == full { parent.join(format!(".{full}.tmp")) } else {
        // two long names alike in their first 190 characters must not share one temp
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        full.hash(&mut h);
        parent.join(format!(".{short} {:08x}.tmp", h.finish() as u32))
    };
    let mut only_copy = false; // the old text is going and the new is not all there yet: the temp is what is left
    let res = (|| {
        // made new, never written through: a link planted at the temp name (a synced vault can carry one)
        // would lead the text out of the vault. The link itself is taken away first, not what it points at
        let _ = std::fs::remove_file(&tmp);
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        match rename_retry(&tmp, path) {
            // Windows refuses to swap a file something holds open (Explorer's preview pane, a scanner, a
            // program that had it): written into place instead - the share it was opened with allows that.
            // Grown first, not emptied: a disk without room says so here, with the old text still whole
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && path.is_file() => {
                let len = bytes.len() as u64;
                std::fs::OpenOptions::new().write(true).open(path)
                    .and_then(|mut f| {
                        if len > f.metadata()?.len() { f.set_len(len)?; }
                        only_copy = true;
                        f.write_all(bytes)?;
                        f.set_len(len)?;
                        f.sync_all()?;
                        only_copy = false;
                        Ok(())
                    })
                    .map_err(|_| e)
            }
            r => r,
        }
    })();
    if !only_copy { let _ = std::fs::remove_file(&tmp); } // dot files are not scanned; the next save takes it over
    res
}

/// A note the app would refuse to read back (over MAX_NOTE) is never written: it would look gone.
fn fits(rel: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_NOTE { Err(format!("{} is larger than {} MB - too big for a note", rel, MAX_NOTE >> 20)) } else { Ok(()) }
}

pub fn write(root: &Path, rel: &str, content: &str) -> Result<u64, String> {
    fits(rel, content)?;
    let p = resolve_note(root, rel)?;
    write_atomic(&p, content.as_bytes()).map_err(|e| format!("write {}: {}", rel, e))?;
    std::fs::metadata(&p).map(|m| mtime_ms(&m)).map_err(|e| e.to_string())
}

/// Create a note without ever overwriting: `name.md`, `name 1.md`, ...
/// create_new is the actual guard, so two concurrent creates cannot both win
/// the same name; the existence probe is only the loop.
pub fn create(root: &Path, rel: &str, content: &str) -> Result<String, String> {
    fits(rel, content)?;
    resolve_note(root, rel)?;
    let (dir, file) = match rel.rfind('/') {
        Some(i) => (&rel[..=i], &rel[i + 1..]),
        None => ("", rel),
    };
    // resolve_note guarantees an extension
    let (stem, ext) = file.split_at(file.rfind('.').unwrap_or(file.len()));
    for n in 0..10_000u32 {
        let cand = if n == 0 { rel.to_string() } else { format!("{}{} {}{}", dir, stem, n, ext) };
        let p = resolve(root, &cand)?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
        match OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                // A brand-new file: a crash here can only lose this new note,
                // so a direct write is as safe as temp+rename and keeps the
                // create_new guarantee.
                f.write_all(content.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| format!("write {}: {}", cand, e))?;
                return Ok(cand);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("create {}: {}", cand, e)),
        }
    }
    Err(format!("no free name for {}", rel))
}

/// Rename a note (`note`=true) or a folder. Refuses to overwrite, except that
/// a case-only rename of the same file (`a.md` -> `A.md`) must work on a
/// case-insensitive filesystem, where `to` "exists" because it IS `from`.
pub fn rename(root: &Path, from: &str, to: &str, note: bool) -> Result<(), String> {
    rename_entry(root, from, to, if note { Entry::Note } else { Entry::Folder })
}

/// Rename a non-note file. Both ends must be non-notes: turning `a.png` into
/// `a.md` would slip a binary into the editor past the note bookkeeping.
pub fn rename_file(root: &Path, from: &str, to: &str) -> Result<(), String> {
    rename_entry(root, from, to, Entry::File)?;
    // a picture's drawn layers and adjustments go with it (imageedit.rs)
    if let (Ok(a), Ok(b)) = (crate::imageedit::sidecar_for(root, from), crate::imageedit::sidecar_for(root, to)) {
        if a.exists() {
            if let Some(d) = b.parent() { let _ = std::fs::create_dir_all(d); }
            let _ = std::fs::rename(a, b);
        }
    }
    Ok(())
}

fn rename_entry(root: &Path, from: &str, to: &str, kind: Entry) -> Result<(), String> {
    let a = resolve_entry(root, from, kind)?;
    // a note file too big to be a note passed as a file above: it may keep a note's name, which does not exist yet
    let b = if kind == Entry::File && is_note(from) { resolve(root, to)? } else { resolve_entry(root, to, kind)? };
    let md = a.symlink_metadata().map_err(|_| format!("does not exist: {}", from))?;
    let ok = if kind == Entry::Folder { md.is_dir() } else { md.is_file() };
    if !ok {
        return Err(format!("not a {}: {}", kind.label(), from));
    }
    if from == to {
        return Ok(());
    }
    if kind == Entry::Folder && to.to_lowercase().starts_with(&format!("{}/", from.to_lowercase())) {
        return Err("cannot move a folder into itself".into());
    }
    if b.symlink_metadata().is_ok() {
        let same = matches!(
            (std::fs::canonicalize(&a), std::fs::canonicalize(&b)),
            (Ok(x), Ok(y)) if x == y
        );
        if !same {
            return Err(format!("already exists: {}", to));
        }
    }
    if let Some(parent) = b.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    rename_retry(&a, &b).map_err(|e| format!("rename {} -> {}: {}", from, to, e))
}

/// Move a note or folder into `<vault>/.trash/<stamp> <name>`. Never deletes:
/// the trash is an ordinary folder the user can restore from by hand.
/// Returns the trash entry's name.
pub fn trash(root: &Path, rel: &str, stamp: &str, note: bool) -> Result<String, String> {
    trash_entry(root, rel, stamp, if note { Entry::Note } else { Entry::Folder })
}

/// Trash a non-note file, exactly like a note.
pub fn trash_file(root: &Path, rel: &str, stamp: &str) -> Result<String, String> {
    trash_entry(root, rel, stamp, Entry::File)
}

fn trash_entry(root: &Path, rel: &str, stamp: &str, kind: Entry) -> Result<String, String> {
    let p = resolve_entry(root, rel, kind)?;
    let md = p.symlink_metadata().map_err(|_| format!("does not exist: {}", rel))?;
    if (kind != Entry::Folder) != md.is_file() {
        return Err(format!("{} is not a {}", rel, kind.label()));
    }
    let name = fit(&p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let tdir = root.join(".trash");
    std::fs::create_dir_all(&tdir).map_err(|e| format!("mkdir .trash: {}", e))?;
    let mut entry = format!("{} {}", stamp, name);
    let mut n = 1;
    while tdir.join(&entry).symlink_metadata().is_ok() {
        entry = format!("{} {} {}", stamp, n, name);
        n += 1;
    }
    rename_retry(&p, &tdir.join(&entry)).map_err(|e| format!("trash {}: {}", rel, e))?;
    Ok(entry)
}

/// A note, file or folder that is really there and really of that kind.
pub fn locate(root: &Path, rel: &str, kind: Entry) -> Result<PathBuf, String> {
    let p = resolve_entry(root, rel, kind)?;
    let md = p.symlink_metadata().map_err(|_| format!("does not exist: {}", rel))?;
    if (kind != Entry::Folder) != md.is_file() {
        return Err(format!("{} is not a {}", rel, kind.label()));
    }
    Ok(p)
}

/// Gone for good, without a stop in .trash. Only ever on the user's own
/// "delete permanently", which the app asks about first.
pub fn destroy(root: &Path, rel: &str, kind: Entry) -> Result<(), String> {
    let p = locate(root, rel, kind)?;
    let r = if kind == Entry::Folder { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    r.map_err(|e| format!("delete {}: {}", rel, e))
}

/// One entry of `<vault>/.trash`, by its plain name.
pub fn trash_path(root: &Path, entry: &str) -> Result<PathBuf, String> {
    if entry.is_empty() || entry.starts_with('.') || entry.chars().any(|c| (c as u32) < 32 || "/\\:".contains(c)) {
        return Err(format!("not a trash entry: {}", entry));
    }
    let p = root.join(".trash").join(entry);
    p.symlink_metadata().map_err(|_| format!("not in the trash: {}", entry))?;
    Ok(p)
}

/// Put a trash entry back at `rel`. Folders that went missing meanwhile are
/// made again, and a name taken since gets " 2" - nothing is overwritten.
/// Returns the vault-relative path it got.
pub fn untrash(root: &Path, entry: &str, rel: &str, kind: Entry) -> Result<String, String> {
    let src = trash_path(root, entry)?;
    if (kind == Entry::Folder) != src.is_dir() {
        return Err(format!("{} is not a {}", entry, kind.label()));
    }
    // a note file too big to be a note went in as a file; nothing is at its name now to say so
    let want = if kind == Entry::File && too_big_for_a_note(&src) { resolve(root, rel)? } else { resolve_entry(root, rel, kind)? };
    let parent = want.parent().ok_or_else(|| format!("no folder for {}", rel))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    let name = want.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let to = crate::clip::free_name(parent, &name);
    rename_retry(&src, &to).map_err(|e| format!("restore {}: {}", rel, e))?;
    let got = to.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
    Ok(match rel.rfind('/') {
        Some(i) => format!("{}/{}", &rel[..i], got),
        None => got,
    })
}

pub fn mkdir(root: &Path, rel: &str) -> Result<(), String> {
    let p = resolve(root, rel)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {}", rel, e))
}

// ── one-time migration ──────────────────────────────────────────────────────

pub const WELCOME: &str = "# Welcome to Leonote

Every note is a plain Markdown file in this folder. Open it in any editor, put
it in git, point Obsidian at it - nothing is locked inside the app.

## Try it
- [ ] Press Ctrl+O and type a name: open a note, or make a new one
- [ ] Press Ctrl+P: every command, with its key
- [ ] Type `[[` to link a note - `[[Welcome]]` links back here
- [ ] Press Alt+D: today's note (in Diary/<year>.md, one heading a day - Settings › Daily notes for a file a day)
- [ ] Add a task on Home: `call the bank !h @fri` (high priority, due Friday)

## Writing
- `/` at the start of a line: headings, lists, tables, pictures and more.
- Tag anything with #tags.
- Checklists: `- [ ]` for open, `- [x]` for done.

## Keys
- Ctrl+P - command palette
- Ctrl+O - quick switcher
- Ctrl+Shift+F - search every note
- Alt+D - today's daily note
- Alt+1 … Alt+0 - Home, Tasks, Habits, Graph and the other views
- Ctrl+Shift+Space - quick capture inside the app
- Ctrl+Alt+N - quick capture, from anywhere in Windows

## AI agents
AI agents can edit your notes and tasks while the app is open, and their
changes show up instantly. Notes are just these files. Tasks have a small
contract agents must follow - see Settings › AI agents.
";

/// Characters Windows forbids, plus the ones Obsidian refuses in link targets.
pub fn sanitize_name(title: &str) -> String {
    let mapped: String = title
        .chars()
        .map(|c| match c {
            c if (c as u32) < 32 => ' ',
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '#' | '^' | '[' | ']' => '-',
            c => c,
        })
        .collect();
    let mut s = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_start_matches('.').to_string();
    if s.chars().count() > 120 {
        s = s.chars().take(120).collect();
    }
    let s = s.trim_end_matches(|c| c == '.' || c == ' ').trim().to_string();
    if s.is_empty() {
        return "Untitled".into();
    }
    if is_device_name(s.split('.').next().unwrap_or("")) {
        return format!("_{}", s);
    }
    s
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// `updated` as epoch ms: local-naive ISO string (the Python app's format) or
/// a number of seconds/ms.
fn parse_time_ms(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_f64() {
        return Some(if n > 1e11 { n as i64 } else { (n * 1000.0) as i64 });
    }
    let s = v.as_str()?.trim();
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return dt.and_local_timezone(chrono::Local).earliest().map(|d| d.timestamp_millis());
        }
    }
    None
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Null) | None => false,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Any note anywhere under `dir` (dot entries skipped, stops at the first).
/// Each level's files are checked before descending, so a real vault answers
/// after one or two directory listings.
fn has_notes(dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    let mut subdirs = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        match e.file_type() {
            Ok(ft) if ft.is_file() && is_note(&name) => return true,
            Ok(ft) if ft.is_dir() => subdirs.push(e.path()),
            _ => {}
        }
    }
    subdirs.iter().any(|d| has_notes(d))
}

/// The migration as boot runs it. In a vault the user picked, it runs only
/// when that folder is still empty of notes and is not an Obsidian vault: an
/// existing vault must never get a Welcome.md, a Docs/ import or even a
/// `.leonote/` marker - so a refusal writes nothing at all. The default
/// ~/LeoNote always migrates (once, by marker).
pub fn migrate_on_boot(root: &Path, home: &Path, default_vault: bool) -> Result<bool, String> {
    if !default_vault && (root.join(".obsidian").is_dir() || has_notes(root)) {
        return Ok(false);
    }
    migrate(root, home)
}

/// First-boot import of the Python app's docs and priorities into Markdown.
///
/// Guarded by `<vault>/.leonote/migrated-v1` so it runs once; the source JSON
/// files are only ever READ - the Python app still owns them. `home` is a
/// parameter so tests never see the real user's files.
/// Returns true when it ran.
pub fn migrate(root: &Path, home: &Path) -> Result<bool, String> {
    let marker = root.join(".leonote").join("migrated-v1");
    if marker.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(root).map_err(|e| format!("create vault: {}", e))?;

    // An existing vault (e.g. an Obsidian one) may already have a Welcome.md
    if !root.join("Welcome.md").exists() {
        create(root, "Welcome.md", WELCOME)?;
    }

    if let Some(Value::Array(docs)) = read_json(&home.join(".leonote_docs.json")) {
        for d in &docs {
            if truthy(d.get("deleted")) {
                continue;
            }
            let title = sanitize_name(d.get("title").and_then(|v| v.as_str()).unwrap_or(""));
            let cat = d.get("category").and_then(|v| v.as_str()).unwrap_or("").trim();
            let dir = if cat.is_empty() || cat.eq_ignore_ascii_case("default") {
                "Docs".to_string()
            } else {
                format!("Docs/{}", sanitize_name(cat))
            };
            let body = d.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let used = create(root, &format!("{}/{}.md", dir, title), body)?;
            if let Some(ms) = d.get("updated").and_then(parse_time_ms) {
                let ft = filetime::FileTime::from_unix_time(ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32);
                let _ = filetime::set_file_mtime(root.join(&used), ft);
            }
        }
    }

    // Priorities (life focus areas) are NOT turned into notes: the Focus view
    // edits ~/.leonote_priorities.json directly, and copies here would drift.

    // marker last: a crash mid-migration re-runs it rather than skipping it
    std::fs::create_dir_all(marker.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&marker, b"docs imported\n").map_err(|e| e.to_string())?;
    Ok(true)
}
