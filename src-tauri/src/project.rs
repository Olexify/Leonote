//! A folder worked on as a PROJECT: find in it, replace across it, and git.
//!
//! The folder is an outpost (or lies in the vault) - nothing else on the disk
//! is ever touched. Files come from `git ls-files` when the folder is a
//! repository, so .gitignore is honoured exactly as git honours it; otherwise
//! from a walk that leaves the usual heavy folders out.
//!
//! Replace never just overwrites: every file it changes is first copied to
//! `<data>/history/projects/<stamp>/`, and `project_undo` puts those back.
//!
//! Git is the user's own git, run as they would run it: their config, their
//! credential helper, their remotes. Only a fixed set of actions exists, and
//! nothing typed in the app is ever passed where git would read an option.
//! A repository that names programs of its own is asked about once, on the first such action.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use tauri::State;

use crate::AppState;

const MAX_FILES: usize = 30_000;
const MAX_SIZE: u64 = 2 * 1024 * 1024;
const MAX_MATCHES: usize = 3000;
const HEAVY: [&str; 14] = ["node_modules", "target", "dist", "build", "out", "vendor", "__pycache__", "venv", "env", "bin", "obj", "coverage", "bower_components", "Pods"];

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// The project folder, checked: an outpost or a folder of the vault.
fn root_of(root: &str, state: &AppState) -> Result<PathBuf, String> {
    let p = PathBuf::from(root);
    // a folder on another computer is looked at only when it is a linked folder (or in the vault): looking logs Windows in there
    if crate::grant::is_far(&p) && !crate::outpost::is_under(&p, &state.paths.vault)
        && crate::outpost::root_of(&crate::outpost::ROOTS.lock().unwrap_or_else(|e| e.into_inner()), &p).is_none() {
        return Err(format!("{} is neither an outpost nor in the vault - hook it up as an outpost first", root));
    }
    if !p.is_absolute() || !p.is_dir() {
        return Err(format!("{} is not a folder", root));
    }
    if crate::outpost::guard(&p).is_ok() {
        return Ok(p);
    }
    let real = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    let vault = std::fs::canonicalize(&state.paths.vault).map_err(|e| e.to_string())?;
    if real.starts_with(&vault) {
        return Ok(p);
    }
    Err(format!("{} is neither an outpost nor in the vault - hook it up as an outpost first", root))
}

/// `root_of`, to write in: an outpost must be one the user handed over (see outpost::guard_write).
fn root_to_change(app: &tauri::AppHandle, root: &str, state: &AppState) -> Result<PathBuf, String> {
    let r = root_of(root, state)?;
    if crate::outpost::guard(&r).is_ok() { crate::outpost::guard_write(app, &r)?; }
    Ok(r)
}

/// A file of the project by its forward-slash relative path; never outside it.
pub fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') || rel.contains(':') || rel.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return Err(format!("not a path inside the project: {}", rel));
    }
    let mut p = root.to_path_buf();
    for seg in rel.split('/') {
        p.push(seg);
    }
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(&p), std::fs::canonicalize(root)) {
        if !a.starts_with(&b) {
            return Err(format!("{} leads outside the project", rel));
        }
    }
    Ok(p)
}

pub fn is_repo(root: &Path) -> bool {
    root.join(".git").exists()
}

/// Git's empty tree: as the attribute source, no `.gitattributes` in the folder applies.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<(i32, String, String), String> {
    // what Leonote runs on its own (listing, status, a diff, the log) only reads, and the folder may be synced
    // or downloaded: nothing in it may get to run a program there - not its .git/config (fsmonitor, an external
    // diff, a pager, hooks), not its .gitattributes (filter and diff drivers). A commit, push or pull is the
    // user's own click and keeps the repository's own setup (hooks, ssh, filters), once they allowed it: project_git.
    let reads = matches!(args.first().copied(), Some("ls-files" | "status" | "diff" | "log" | "branch" | "remote" | "config"));
    let drivers = if reads { read_guard(root)? } else { Vec::new() };
    let mut c = Command::new(crate::external::program("git"));
    c.arg("-C").arg(root);
    if reads {
        c.args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL", "-c", "diff.external=", "-c", "core.pager=cat",
            "-c", "core.attributesFile=NUL", "-c", "diff.submodule=short",
            // no signature checks on a read, and the signing programs pinned to the usual names: a repository's own
            // config could otherwise name any program as gpg.program and have `log` run it
            "-c", "log.showSignature=false", "-c", "gpg.program=gpg", "-c", "gpg.ssh.program=ssh-keygen", "-c", "gpg.x509.program=gpgsm", "-c", "gpg.format=openpgp",
            "--no-pager", &format!("--attr-source={EMPTY_TREE}")]);
        // the drivers the repository's own info/attributes names: emptied (the folder's .gitattributes is not read at all)
        for d in &drivers {
            for k in ["clean", "smudge", "process"] { c.args(["-c", &format!("filter.{d}.{k}=")]); }
            c.args(["-c", &format!("filter.{d}.required=false"), "-c", &format!("diff.{d}.textconv="), "-c", &format!("diff.{d}.command=")]);
        }
        // no system or user-wide git settings either: a read needs none of them
        c.env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "NUL").env("GIT_ATTR_NOSYSTEM", "1");
        // nothing fetched for a partial clone's missing object (its remote can name a program); the protocol ban is for gits before 2.45
        c.env("GIT_NO_LAZY_FETCH", "1").env("GIT_ALLOW_PROTOCOL", "none");
        // the .git the guard looked at and no other: when it is unusable git must not search on, for a parent
        // repository or the folder itself laid out as one (both relative to -C)
        c.env("GIT_DIR", ".git").env("GIT_WORK_TREE", ".");
    }
    // the switches right after the command: after a "--" git takes them for file names
    let at = if reads { 1 } else { 0 };
    c.args(&args[..at]);
    if reads && matches!(args[0], "diff" | "log") { c.args(["--no-textconv", "--no-ext-diff"]); }
    if reads && args[0] == "log" { c.arg("--no-show-signature"); }
    // a submodule's changed commit still shows; its files are not looked into, that would be a git run inside it,
    // with its own drivers (the same for diff.submodule=diff, pinned to short above)
    if reads && matches!(args[0], "status" | "diff") { c.arg("--ignore-submodules=dirty"); }
    c.args(&args[at..]);
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    let out = quiet(&mut c).output().map_err(|e| format!("git did not start ({}). Is git installed?", e))?;
    let code = out.status.code().unwrap_or(-1);
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    // a git older than 2.42 cannot be told to leave the folder's attributes alone: then it is not asked at all
    if reads && code != 0 && err.contains("attr-source") { return Err("git is too old to be read safely here (2.42 or newer is needed) - update git".into()); }
    Ok((code, String::from_utf8_lossy(&out.stdout).into_owned(), err))
}

/// Before Leonote reads a repository on its own: its git folder must be a plain folder here (not a pointer
/// elsewhere), and every driver its info/attributes names must be one that can be emptied. Gives those names.
fn read_guard(root: &Path) -> Result<Vec<String>, String> {
    let git = root.join(".git");
    let md = std::fs::symlink_metadata(&git).map_err(|_| "not a git repository".to_string())?;
    if !md.is_dir() || git.join("commondir").exists() { return Err("this repository's .git is not a plain folder here - Leonote does not read it on its own".into()); }
    let mut out: Vec<String> = Vec::new();
    let bytes = match std::fs::read(git.join("info").join("attributes")) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(_) => return Err("this repository's own attributes cannot be read - not read".into()),
    };
    // words as git parts them: only space, tab and line ends, whatever the bytes are - and a quoted pattern ends
    // at its quote with no blank after it, so the pattern's words are looked at too: at worst one driver too many
    let blank = [' ', '\t', '\r'];
    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines().map(|l| l.trim_matches(blank)).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        for w in line.split([' ', '\t', '\r', '"']) {
            let w = w.trim_start_matches(['-', '!']);
            let Some((key, d)) = w.split_once('=') else { continue };
            if !matches!(key, "filter" | "diff" | "merge") { continue; }
            if d.is_empty() || !d.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
                return Err("this repository's own attributes name a program Leonote cannot switch off - not read".into());
            }
            if !out.iter().any(|x| x == d) { out.push(d.to_string()); }
        }
    }
    Ok(out)
}

/// Settings a repository of the usual kind has, none of which can start a program. By list and not by what is
/// known to be bad: git adds new ways to name a program, and a setting not on it only costs one question.
/// `*` is a remote's or a branch's name.
const PLAIN_SETTINGS: &[&str] = &["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase",
    "core.precomposeunicode", "core.symlinks", "core.autocrlf", "core.eol", "core.safecrlf", "core.longpaths", "core.quotepath", "core.fscache",
    "extensions.objectformat", "extensions.refstorage", "user.name", "user.email", "pull.ff", "push.default",
    "remote.*.fetch", "remote.*.push", "remote.*.prune", "remote.*.tagopt", "remote.*.promisor", "remote.*.partialclonefilter",
    "remote.*.gh-resolved", "branch.*.merge", "branch.*.rebase", "branch.*.vscode-merge-base"];

/// An address on another computer, in git's own ways of reaching one. Anything else starts a program of that name
/// ("helper::", "helper://") or is a folder here, and a push runs that folder's hooks.
pub(crate) fn network_address(url: &str) -> bool {
    if url.contains("::") { return false; }
    if let Some((scheme, _)) = url.split_once("://") { return matches!(scheme, "http" | "https" | "ssh" | "git"); }
    // host:path; a one-letter host is a drive, and before a slash the colon is part of a file name
    url.split_once(':').is_some_and(|(host, _)| host.len() > 1 && !host.starts_with('-') && !host.contains(['/', '\\']))
}

/// `remotes`: the remotes that have an address. Which remote to use is plain only when it is one of them, or this
/// repository itself: git takes any other value for an address, so for a folder here.
fn plain_setting(key: &str, value: &str, remotes: &[&str]) -> bool {
    let k = key.to_lowercase();
    let (Some((section, _)), Some((_, name))) = (k.split_once('.'), k.rsplit_once('.')) else { return false };
    let middle = if k.len() > section.len() + name.len() + 1 { ".*" } else { "" };
    let short = format!("{section}{middle}.{name}");
    if matches!(short.as_str(), "remote.*.url" | "remote.*.pushurl") { return network_address(value); }
    if matches!(short.as_str(), "remote.pushdefault" | "branch.*.remote" | "branch.*.pushremote" | "extensions.partialclone") { return value == "." || remotes.contains(&value); }
    PLAIN_SETTINGS.contains(&short.as_str())
}

/// What git could run on behalf of this repository when it works in it for real: hooks, settings not known to be
/// plain, a repository inside it (git asks that one for its status, and it has a config of its own). Empty for a
/// plain repository. What cannot be told, a .git that is a pointer elsewhere for one, is named too. Only reads.
pub(crate) fn programs_named(root: &Path) -> Vec<String> {
    let read = |args: &[&str]| git(root, args).and_then(|(code, out, err)| if code == 0 { Ok(out) } else { Err(err) });
    // as git itself reads the file; includes are not followed, an include is a setting not on the list
    let config = match read(&["config", "--local", "--list", "-z"]) { Ok(t) => t, Err(e) => return vec![e] };
    let index = match read(&["ls-files", "--stage"]) { Ok(t) => t, Err(e) => return vec![e] };
    let mut out = Vec::new();
    let pairs: Vec<(&str, &str)> = config.split('\0').filter(|p| !p.is_empty()).map(|p| p.split_once('\n').unwrap_or((p, ""))).collect();
    let remotes: Vec<&str> = pairs.iter().filter_map(|(k, _)| k.strip_prefix("remote.")?.strip_suffix(".url")).collect();
    for (k, v) in &pairs {
        if !plain_setting(k, v, &remotes) { out.push(format!("{k} = {v}")); }
    }
    // Push's fallback says "origin": with no such remote that is this folder, if it is there
    if !remotes.contains(&"origin") && root.join("origin").exists() { out.push("a folder named origin, which a push would go to".into()); }
    // git's older places for a remote's address, read when the config has none
    for place in ["remotes", "branches"] {
        match std::fs::read_dir(root.join(".git").join(place)) {
            Ok(rd) => out.extend(rd.flatten().map(|e| format!("{place}: {}", e.file_name().to_string_lossy()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => out.push(format!("its {place} folder cannot be read")),
        }
    }
    match std::fs::read_dir(root.join(".git").join("hooks")) {
        Ok(rd) => out.extend(rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.ends_with(".sample")).map(|n| format!("hook: {n}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => out.push("its hooks folder cannot be read".into()),
    }
    out.extend(index.lines().filter(|l| l.starts_with("160000 ")).map(|l| format!("repository inside: {}", l.split_once('\t').map_or(l, |x| x.1))));
    out
}

/// Relative paths of the project's text files.
pub fn files(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if is_repo(root) {
        if let Ok((0, stdout, _)) = git(root, &["ls-files", "-co", "--exclude-standard", "-z"]) {
            for rel in stdout.split('\0') {
                if out.len() >= MAX_FILES {
                    break;
                }
                let name = rel.rsplit('/').next().unwrap_or(rel);
                if !rel.is_empty() && crate::external::can_edit(name) {
                    out.push(rel.to_string());
                }
            }
            return out;
        }
    }
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if out.len() >= MAX_FILES {
                return out;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with('$') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            let r = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            if ft.is_dir() {
                if !ft.is_symlink() && depth < 24 && !HEAVY.iter().any(|h| h.eq_ignore_ascii_case(&name)) {
                    stack.push((e.path(), r, depth + 1));
                }
            } else if crate::external::can_edit(&name) {
                out.push(r);
            }
        }
    }
    out.sort();
    out
}

#[derive(Deserialize, Clone, Default)]
pub struct Opts {
    #[serde(default)]
    pub case: bool,
    #[serde(default)]
    pub word: bool,
    /// The project's own "leave out": folder or file names, paths from the
    /// root ("docs/old"), and endings ("*.min.js").
    #[serde(default)]
    pub exclude: Vec<String>,
}

pub fn excluded(rel: &str, list: &[String]) -> bool {
    let low = rel.to_lowercase();
    list.iter().map(|e| e.trim().trim_matches('/').to_lowercase()).filter(|e| !e.is_empty()).any(|e| {
        if let Some(end) = e.strip_prefix('*') {
            return low.ends_with(end);
        }
        low == e || low.starts_with(&format!("{}/", e)) || low.split('/').any(|seg| seg == e)
    })
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Byte ranges of `needle` in `line`. Without `case`, a line whose lower-case
/// form has another length (rare: İ, ß) is matched as it stands.
pub fn find_in(line: &str, needle: &str, o: &Opts) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let (hay, pin) = if o.case {
        (line.to_string(), needle.to_string())
    } else {
        let l = line.to_lowercase();
        if l.len() == line.len() { (l, needle.to_lowercase()) } else { (line.to_string(), needle.to_string()) }
    };
    let mut at = 0;
    while let Some(i) = hay[at..].find(&pin) {
        let (a, b) = (at + i, at + i + pin.len());
        if !line.is_char_boundary(a) || !line.is_char_boundary(b) {
            at = a + 1;
            while at < hay.len() && !hay.is_char_boundary(at) {
                at += 1;
            }
            continue;
        }
        let ok = !o.word || (!line[..a].chars().next_back().is_some_and(is_word) && !line[b..].chars().next().is_some_and(is_word));
        if ok {
            out.push((a, b));
        }
        at = b.max(a + 1);
        if at >= hay.len() {
            break;
        }
    }
    out
}

fn read_text(p: &Path) -> Option<String> {
    let md = p.metadata().ok()?;
    if md.len() == 0 || md.len() > MAX_SIZE {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub fn search(root: &Path, query: &str, o: &Opts, only: Option<&str>) -> Value {
    let t0 = Instant::now();
    let list: Vec<String> = files(root).into_iter().filter(|r| !excluded(r, &o.exclude)).collect();
    let mut hits = Vec::new();
    let (mut total, mut in_files, mut partial) = (0usize, 0usize, false);
    for rel in &list {
        if let Some(pre) = only {
            if !pre.is_empty() && !(rel == pre || rel.starts_with(&format!("{}/", pre))) {
                continue;
            }
        }
        let Ok(p) = inside(root, rel) else { continue };
        let Some(text) = read_text(&p) else { continue };
        let mut found = false;
        for (n, line) in text.lines().enumerate() {
            let ms = find_in(line, query, o);
            if ms.is_empty() {
                continue;
            }
            found = true;
            total += ms.len();
            // what is shown is cut round the first match; offsets are in chars of what is shown
            let (a, b) = ms[0];
            let start = line[..a].char_indices().rev().nth(60).map(|(i, _)| i).unwrap_or(0);
            let end = line[b..].char_indices().nth(160).map(|(i, _)| b + i).unwrap_or(line.len());
            hits.push(json!({ "path": rel, "line": n + 1, "text": &line[start..end], "from": line[start..a].chars().count(), "to": line[start..b].chars().count(), "more": ms.len() - 1 }));
            if hits.len() >= MAX_MATCHES {
                partial = true;
                break;
            }
        }
        if found {
            in_files += 1;
        }
        if partial || t0.elapsed().as_secs() > 12 {
            partial = true;
            break;
        }
    }
    json!({ "hits": hits, "total": total, "files": in_files, "scanned": list.len(), "partial": partial, "ms": t0.elapsed().as_millis() as u64 })
}

/// Replace in these files. Each changed file is copied to `keep/<rel>` first.
pub fn replace(root: &Path, keep: &Path, query: &str, with: &str, o: &Opts, paths: &[String]) -> Result<Value, String> {
    let (mut changed, mut count) = (Vec::new(), 0usize);
    for rel in paths {
        let p = inside(root, rel)?;
        let Some(text) = read_text(&p) else { continue };
        let mut out = String::with_capacity(text.len());
        let mut n = 0;
        // line by line, keeping each line's own ending
        for line in text.split_inclusive('\n') {
            let body = line.trim_end_matches(['\n', '\r']);
            let ms = find_in(body, query, o);
            if ms.is_empty() {
                out.push_str(line);
                continue;
            }
            let mut at = 0;
            for (a, b) in ms {
                out.push_str(&body[at..a]);
                out.push_str(with);
                at = b;
                n += 1;
            }
            out.push_str(&body[at..]);
            out.push_str(&line[body.len()..]);
        }
        if n == 0 {
            continue;
        }
        let bak = inside(keep, rel)?;
        if let Some(d) = bak.parent() {
            std::fs::create_dir_all(d).map_err(|e| format!("keep a copy of {}: {}", rel, e))?;
        }
        std::fs::copy(&p, &bak).map_err(|e| format!("keep a copy of {}: {}", rel, e))?;
        crate::vault::write_atomic(&p, out.as_bytes()).map_err(|e| format!("write {}: {}", rel, e))?;
        changed.push(rel.clone());
        count += n;
    }
    Ok(json!({ "files": changed, "count": count }))
}

/// Put back what a replace kept. Returns how many files.
pub fn undo(root: &Path, keep: &Path) -> Result<usize, String> {
    fn walk(dir: &Path, rel: String, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name } else { format!("{}/{}", rel, name) };
            // file_type() does not follow a link: nothing outside, no loop
            if e.file_type().is_ok_and(|t| t.is_dir()) { walk(&e.path(), r, out) } else { out.push(r) }
        }
    }
    let mut list = Vec::new();
    walk(keep, String::new(), &mut list);
    for rel in &list {
        let to = inside(root, rel)?;
        std::fs::copy(inside(keep, rel)?, &to).map_err(|e| format!("restore {}: {}", rel, e))?;
    }
    Ok(list.len())
}

fn keep_dir(state: &AppState, stamp: &str) -> Result<PathBuf, String> {
    if stamp.is_empty() || !stamp.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("bad stamp".into());
    }
    Ok(state.paths.dir.join("history").join("projects").join(stamp))
}

/* ── commands ───────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn project_info(root: String, state: State<'_, AppState>) -> Result<Value, String> {
    let r = root_of(&root, &state)?;
    Ok(json!({ "repo": is_repo(&r), "files": files(&r).len() }))
}

#[tauri::command]
pub async fn project_files(root: String, exclude: Option<Vec<String>>, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let ex = exclude.unwrap_or_default();
    Ok(files(&root_of(&root, &state)?).into_iter().filter(|r| !excluded(r, &ex)).collect())
}

#[tauri::command]
pub async fn project_search(root: String, query: String, opts: Option<Opts>, only: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let r = root_of(&root, &state)?;
    Ok(search(&r, &query, &opts.unwrap_or_default(), only.as_deref()))
}

#[tauri::command]
pub async fn project_replace(app: tauri::AppHandle, root: String, query: String, with: String, opts: Option<Opts>, paths: Vec<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let r = root_to_change(&app, &root, &state)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut v = replace(&r, &keep_dir(&state, &stamp)?, &query, &with, &opts.unwrap_or_default(), &paths)?;
    v["stamp"] = json!(stamp);
    Ok(v)
}

#[tauri::command]
pub async fn project_undo(app: tauri::AppHandle, root: String, stamp: String, state: State<'_, AppState>) -> Result<usize, String> {
    let r = root_to_change(&app, &root, &state)?;
    undo(&r, &keep_dir(&state, &stamp)?)
}

/// One of a fixed set of git actions. `arg` is a file, a branch or a message,
/// by the action; it never reaches git where an option could be read.
#[tauri::command]
pub async fn project_git(app: tauri::AppHandle, root: String, action: String, arg: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    // the reads stay open; anything that changes the repository needs the same yes as any other write
    let writes = !matches!(action.as_str(), "status" | "diff" | "log" | "branches");
    let r = if writes { root_to_change(&app, &root, &state)? } else { root_of(&root, &state)? };
    let a = arg.unwrap_or_default();
    if a.starts_with('-') {
        return Err("that cannot start with a dash".into());
    }
    // these run with the repository's own setup, the reads below do not
    if matches!(action.as_str(), "switch" | "branch-new" | "commit" | "push" | "pull" | "fetch") {
        let named = programs_named(&r);
        if !named.is_empty() { crate::grant::allow_git_repo(&app, &r, &named)?; }
    }
    let run = |args: &[&str]| -> Result<Value, String> {
        let (code, out, err) = git(&r, args)?;
        Ok(json!({ "ok": code == 0, "code": code, "out": out, "err": err }))
    };
    match action.as_str() {
        "status" => run(&["status", "--porcelain=v1", "-b", "-uall"]),
        "diff" => {
            inside(&r, &a)?;
            let v = run(&["diff", "HEAD", "--", &a])?;
            if v["ok"] == json!(true) && !v["out"].as_str().unwrap_or("").is_empty() { Ok(v) } else { run(&["diff", "--", &a]) }
        }
        "log" => run(&["log", "--oneline", "--decorate", "-n", "40"]),
        "branches" => run(&["branch", "--format=%(refname:short)"]),
        // a trailing "--": the name is a branch, never a file whose unsaved changes checkout would throw away
        "switch" => run(&["switch", "--", &a]).or_else(|_| run(&["checkout", &a, "--"])),
        "branch-new" => run(&["switch", "-c", &a]),
        "commit" => {
            if a.trim().is_empty() {
                return Err("a commit needs a message".into());
            }
            let add = run(&["add", "-A"])?;
            if add["ok"] != json!(true) {
                return Ok(add);
            }
            run(&["commit", "-m", &a])
        }
        "push" => {
            let v = run(&["push"])?;
            // a branch that has never been pushed gets its upstream
            if v["ok"] != json!(true) && v["err"].as_str().unwrap_or("").contains("no upstream") { run(&["push", "-u", "origin", "HEAD"]) } else { Ok(v) }
        }
        "pull" => run(&["pull", "--ff-only"]),
        "fetch" => run(&["fetch", "--prune"]),
        "remote" => run(&["remote", "-v"]),
        "init" => run(&["init"]),
        _ => Err(format!("unknown git action: {}", action)),
    }
}
