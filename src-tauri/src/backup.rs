//! Encrypted backups: everything Leonote needs on another device, in one
//! password-protected `.leonotebackup` file.
//!
//! The file is an age passphrase (scrypt) stream whose plaintext is a zip:
//!
//!   manifest.json        always the FIRST entry and stored, so `peek` reads it
//!                        from the head of the stream without decrypting the rest
//!   data/<stable name>   our own data under the vault-mode names, whatever the
//!                        mode on disk: tasks.json, base.snapshot.json, log/...,
//!                        habits.json, recurring.json, priorities.json,
//!                        stats.json, positions.json, graph.json, fit.json
//!   settings/app.json
//!   vault/<rel path>     only when the vault is included
//!
//! age rather than zip's own AES: its passphrase format is a small, reviewed
//! spec, authenticated end to end, and the same file can go to a cloud later
//! without the server ever holding a key. The password lives only in memory
//! and is never logged.
//!
//! The zip is written in streaming mode straight into the age writer, so a
//! multi-GB vault never sits in memory and never exists unencrypted on disk.
//!
//! Core functions take explicit paths, like datadir.rs, so the tests stay
//! hermetic; the commands at the bottom are thin wrappers over AppState.

use crate::datadir::{self, Items};
use crate::{lock, vault, AppState};
use age::secrecy::{ExposeSecret, SecretString};
use age::DecryptError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const FORMAT: &str = "leonote-backup";
pub const VERSION: u32 = 1;
pub const WRONG_PASSWORD: &str = "wrong password";
pub const NOT_A_BACKUP: &str = "not a Leonote backup";
pub const MIN_PASSWORD: usize = 8;

const MANIFEST: &str = "manifest.json";
const SETTINGS: &str = "settings/app.json";
/// A manifest is a few KB; anything near this is not ours.
const MAX_MANIFEST: u64 = 1024 * 1024;
/// Tasks, logs and the like are read whole into memory: a real set is megabytes.
const MAX_DATA: u64 = 1 << 30;

/// Stable names of the single data files. The log dir travels as `log/...`.
const DATA_FILES: [&str; 9] = [
    "tasks.json",
    "base.snapshot.json",
    "habits.json",
    "recurring.json",
    "priorities.json",
    "stats.json",
    "positions.json",
    "graph.json",
    "fit.json",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct BackupManifest {
    pub format: String,
    pub version: u32,
    /// local time, like every other Leonote timestamp
    pub created: String,
    pub app_version: String,
    pub device: String,
    pub includes_vault: bool,
    /// stable names, `log/...` included
    pub data_files: Vec<String>,
    /// vault files (not folders) listed when the backup started
    pub vault_files: u64,
    /// uncompressed bytes of everything listed
    pub bytes: u64,
    /// "fast", "balanced" or "smallest"; older backups have none
    #[serde(default)]
    pub compression: String,
}

/// How hard to squeeze. Pictures, archives and media are stored as they are
/// in every mode: compressing them again only costs time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pack {
    /// deflate level 1: quick, still shrinks notes and logs well
    Fast,
    /// deflate level 6, the zip default
    Balanced,
    /// xz level 9 (pure Rust): the smallest files, slower to make
    Smallest,
}

impl Pack {
    pub fn parse(s: Option<&str>) -> Result<Pack, String> {
        match s.unwrap_or("balanced") {
            "fast" => Ok(Pack::Fast),
            "balanced" | "" => Ok(Pack::Balanced),
            "smallest" => Ok(Pack::Smallest),
            other => Err(format!("unknown compression: {}", other)),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Pack::Fast => "fast",
            Pack::Balanced => "balanced",
            Pack::Smallest => "smallest",
        }
    }
    fn options(self) -> SimpleFileOptions {
        match self {
            Pack::Fast => SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).compression_level(Some(1)),
            Pack::Balanced => SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            Pack::Smallest => SimpleFileOptions::default().compression_method(CompressionMethod::Xz).compression_level(Some(9)),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct BackupSummary {
    /// the backup file
    pub path: String,
    /// size of the backup file
    pub bytes: u64,
    pub data_files: Vec<String>,
    /// export: files written into the backup; import: files written into the vault
    pub vault_files: u64,
    /// when the backup was made
    pub created: String,
    /// export: vault files that could not be opened (locked, vanished);
    /// import: vault entries refused (bad name, inside the data folder, a
    /// folder in the way)
    pub skipped: Vec<String>,
    /// import: where this device's previous data was set aside
    pub before_restore: Option<String>,
    /// import: identical files left alone
    pub vault_unchanged: u64,
    /// import: differing files moved to the vault's .trash, then overwritten
    pub vault_replaced: u64,
}

// ── names ───────────────────────────────────────────────────────────────────

/// Where a stable data name lives in this mode, or None for a name we do not
/// know (a newer build's file: ignored rather than written somewhere odd).
fn data_path(it: &Items, name: &str) -> Option<PathBuf> {
    if let Some(rest) = name.strip_prefix("log/") {
        if rest.is_empty() || rest.ends_with('/') {
            return None;
        }
        let mut p = it.dir.join("log");
        for seg in rest.split('/') {
            p.push(seg);
        }
        return Some(p);
    }
    Some(match name {
        "tasks.json" => it.snapshot.clone(),
        "base.snapshot.json" => it.dir.join("base.snapshot.json"),
        "habits.json" => it.habits.clone(),
        "recurring.json" => it.recurring.clone(),
        "priorities.json" => it.priorities.clone(),
        "stats.json" => it.stats.clone(),
        "positions.json" => it.positions.clone(),
        "graph.json" => it.graph.clone(),
        "fit.json" => it.fit.clone(),
        _ => return None,
    })
}

/// Zip-slip guard, applied to every entry before anything is written: no
/// absolute paths, no drive letters or streams (`:`), no backslashes, no
/// `.`/`..` or empty segments (a trailing `/` marks a folder).
pub fn safe_entry_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') || name.contains(':') {
        return false;
    }
    if name.chars().any(|c| (c as u32) < 32) {
        return false;
    }
    let body = name.strip_suffix('/').unwrap_or(name);
    !body.is_empty() && body.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

/// Settings that describe THIS machine, not the user's preferences: a
/// restored `vault` or `dataDir` would point at folders that do not exist
/// here (or move the data root without moving the data), and window geometry
/// belongs to this screen.
fn device_key(k: &str) -> bool {
    k == "vault" || k == "dataDir" || k.starts_with("window") || k.starts_with("compact")
        // what runs on this computer and where its keys go (AI command lines, tools' paths, Google sign-in):
        // never taken from a backup - one someone sent could otherwise have the next chat or download run their program
        || crate::settings::device_only(k)
}

/// The backup's settings over the current ones, device keys left as they are
/// here (present or absent).
/// The vault's settings files as a backup names them, and where they are.
fn vault_settings_files(root: &Path) -> [(&'static str, PathBuf); 2] {
    let f = crate::settings::vault_file(root);
    [("settings/vault-settings.json", f.clone()), ("settings/vault-state.json", f.with_file_name("state.json"))]
}

pub fn merge_settings(current: &Value, backup: &Value) -> Value {
    let mut out = current.as_object().cloned().unwrap_or_default();
    if let Some(b) = backup.as_object() {
        for (k, v) in b {
            if !device_key(k) {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default()
}

/// Same rule as vault.rs: the same folder arrives with either separator and
/// any case.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn is_under(p: &Path, dir: &Path) -> bool {
    let (p, d) = (norm(p), norm(dir));
    p == d || p.starts_with(&format!("{}/", d))
}

/// Already-compressed formats: deflating them costs time and saves nothing.
fn stored_ext(rel: &str) -> bool {
    let ext = rel.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "heic" | "mp4" | "webm" | "mov" | "mkv" | "mp3"
            | "ogg" | "m4a" | "flac" | "zip" | "7z" | "gz" | "rar" | "docx" | "xlsx" | "pptx" | "odt" | "ods"
            | "leonotebackup"
    )
}

fn zip_time(t: std::time::SystemTime) -> Option<zip::DateTime> {
    let local: chrono::DateTime<chrono::Local> = t.into();
    zip::DateTime::try_from(local.naive_local()).ok()
}

fn apply_mtime(p: &Path, t: Option<zip::DateTime>) {
    let Some(naive) = t.and_then(|t| chrono::NaiveDateTime::try_from(t).ok()) else { return };
    if let Some(dt) = naive.and_local_timezone(chrono::Local).earliest() {
        let _ = filetime::set_file_mtime(p, filetime::FileTime::from_unix_time(dt.timestamp(), 0));
    }
}

/// Removes a temp file however the operation ends.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn sibling(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or_else(|| format!("no folder for {}", path.display()))?;
    let name = path.file_name().ok_or_else(|| format!("no file name in {}", path.display()))?;
    Ok(parent.join(format!(".{}{}", name.to_string_lossy(), suffix)))
}

// ── reading what to back up ─────────────────────────────────────────────────

fn read_opt(p: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(p) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {}", p.display(), e)),
    }
}

/// Every file under the log dir as (`log/...`, bytes). Dot names are our own
/// half-written temps.
fn read_log_dir(dir: &Path, prefix: &str, out: &mut Named) -> Result<(), String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(()) };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let stable = format!("{}/{}", prefix, name);
        if ft.is_dir() {
            read_log_dir(&e.path(), &stable, out)?;
        } else if ft.is_file() {
            if let Some(b) = read_opt(&e.path())? {
                out.push((stable, b));
            }
        }
    }
    Ok(())
}

/// (stable name, bytes)
type Named = Vec<(String, Vec<u8>)>;

/// Our data files by stable name, plus app.json. Small, so read whole; the
/// caller holds the io lock only for this.
fn read_data(it: &Items, settings: &Path) -> Result<(Named, Option<Vec<u8>>), String> {
    let mut out = Vec::new();
    for name in DATA_FILES {
        let p = data_path(it, name).expect("known name");
        if let Some(b) = read_opt(&p)? {
            out.push((name.to_string(), b));
        }
    }
    read_log_dir(&it.dir.join("log"), "log", &mut out)?;
    Ok((out, read_opt(settings)?))
}

struct VaultItem {
    rel: String,
    abs: PathBuf,
    size: u64,
    mtime: Option<std::time::SystemTime>,
    dir: bool,
}

/// The same walk rules as vault::walk: dot entries skipped (.obsidian, .trash,
/// .git, temps), links never followed, our data root left out. Listed first so
/// the manifest can lead the zip.
fn list_vault(root: &Path, dir: &Path, skip: &Path, out: &mut Vec<VaultItem>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        let Some(rel) = vault::rel_of(root, &path) else { continue };
        if ft.is_dir() {
            // an optional module (ffmpeg, Whisper…): fetched again on a click, never worth a backup's space
            if is_under(&path, skip) || path.join(crate::external::MODULE_MARK).exists() {
                continue;
            }
            out.push(VaultItem { rel, abs: path.clone(), size: 0, mtime: None, dir: true });
            list_vault(root, &path, skip, out);
        } else if ft.is_file() {
            // an earlier backup kept inside the vault is not backed up again: each one would hold all the ones before
            // it, growing until the disk is full
            // (a plan's own name only: "<vault> - <plan> - <stamp>.zip" - "Invoices - 2026-03-01 1200.zip" is the user's)
            let low = name.to_lowercase();
            let vname = root.file_name().map(|n| format!("{} - ", n.to_string_lossy())).unwrap_or_default();
            let plan_zip = !vname.is_empty() && name.starts_with(&vname) && name[vname.len()..].contains(" - ")
                && name.rfind(" - ").is_some_and(|i| is_stamp_zip(&name[i + 3..]));
            if low.ends_with(".leonotebackup") || plan_zip { continue; }
            let Ok(md) = e.metadata() else { continue };
            out.push(VaultItem { rel, abs: path, size: md.len(), mtime: md.modified().ok(), dir: false });
        }
    }
}

// ── crypto ──────────────────────────────────────────────────────────────────

pub(crate) fn encryptor(password: &str) -> age::Encryptor {
    #[allow(unused_mut)]
    let mut r = age::scrypt::Recipient::new(SecretString::from(password));
    // the default targets ~1 s per operation; tests run dozens
    #[cfg(test)]
    r.set_work_factor(10);
    age::Encryptor::with_recipients(std::iter::once(&r as &dyn age::Recipient))
        .expect("a lone scrypt recipient is always valid")
}

fn decrypt_err(e: DecryptError) -> String {
    match e {
        DecryptError::DecryptionFailed | DecryptError::KeyDecryptionFailed | DecryptError::NoMatchingKeys => {
            WRONG_PASSWORD.into()
        }
        DecryptError::ExcessiveWork { .. } => {
            "this backup's password protection needs more computing work than this device allows".into()
        }
        DecryptError::Io(e) if !matches!(e.kind(), io::ErrorKind::InvalidData | io::ErrorKind::UnexpectedEof) => {
            format!("read backup: {}", e)
        }
        _ => NOT_A_BACKUP.into(),
    }
}

/// Plaintext reader for a backup. The passphrase is checked here, against the
/// header, before a byte of payload is read.
/// The decrypted backup, read in place: age checks every piece it hands out (a tampered or cut file fails
/// there), and it can be read at any point, which a zip needs - so nothing decrypted is ever written to disk.
fn open_age(path: &Path, password: &str) -> Result<impl Read + io::Seek, String> {
    let f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let d = age::Decryptor::new_buffered(BufReader::with_capacity(1 << 16, f)).map_err(decrypt_err)?;
    // an age file for a key, not a passphrase, was not made by us
    if !d.is_scrypt() {
        return Err(NOT_A_BACKUP.into());
    }
    let id = age::scrypt::Identity::new(SecretString::from(password));
    d.decrypt(std::iter::once(&id as &dyn age::Identity)).map_err(decrypt_err)
}

/// Encrypt a finished plaintext, for tests that need a hand-made zip.
#[cfg(test)]
pub(crate) fn seal(plain: &[u8], out: &Path, password: &str) {
    let f = File::create(out).unwrap();
    let mut w = encryptor(password).wrap_output(f).unwrap();
    w.write_all(plain).unwrap();
    w.finish().unwrap().sync_all().unwrap();
}

fn check_manifest(m: &BackupManifest) -> Result<(), String> {
    if m.format != FORMAT || m.version == 0 {
        return Err(NOT_A_BACKUP.into());
    }
    if m.version > VERSION {
        return Err("this backup was made by a newer Leonote; update this one first".into());
    }
    Ok(())
}

// ── export ──────────────────────────────────────────────────────────────────

/// An entry's name as text: decoded as the zip says (UTF-8 or the old DOS code page), else byte by byte.
pub(crate) fn entry_name<R: Read + ?Sized>(f: &zip::read::ZipFile<'_, R>) -> String {
    f.name().map(|n| n.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(f.name_raw()).into_owned())
}

fn zip_err(e: zip::result::ZipError) -> String {
    format!("write backup: {}", e)
}

/// Write an encrypted backup to `out` (an absolute path the user picked).
/// `vault` is Some when the vault goes in too. `io` is held only while our
/// own data files are read, never for the vault walk.
#[cfg_attr(not(test), allow(dead_code))] // the app calls export_packed; tests use the default
pub fn export(
    out: &Path,
    password: &str,
    it: &Items,
    settings: &Path,
    vault_root: Option<&Path>,
    io: &Mutex<()>,
    created: &str,
) -> Result<BackupSummary, String> {
    export_packed(out, password, it, settings, vault_root, io, created, Pack::Balanced)
}

/// `export` with a chosen compression.
#[allow(clippy::too_many_arguments)]
pub fn export_packed(
    out: &Path,
    password: &str,
    it: &Items,
    settings: &Path,
    vault_root: Option<&Path>,
    io: &Mutex<()>,
    created: &str,
    pack: Pack,
) -> Result<BackupSummary, String> {
    if password.chars().count() < MIN_PASSWORD {
        return Err(format!("the password must be at least {} characters", MIN_PASSWORD));
    }
    if !out.is_absolute() {
        return Err(format!("not an absolute path: {}", out.display()));
    }
    if out.is_dir() {
        return Err(format!("a folder is in the way: {}", out.display()));
    }
    let tmp = sibling(out, ".tmp")?;
    if !tmp.parent().is_some_and(|p| p.is_dir()) {
        return Err(format!("folder does not exist: {}", out.display()));
    }

    let (data, app_json) = {
        let _io = lock(io);
        read_data(it, settings)?
    };
    let mut items = Vec::new();
    // a vault that cannot be read is said, not saved as an empty backup; a folder in it that cannot be read is listed
    let mut unread = Vec::new();
    if let Some(root) = vault_root {
        list_vault(root, root, &it.dir, &mut items);
        unread = plan_vault_check(root, &items)?;
    }
    let manifest = BackupManifest {
        format: FORMAT.into(),
        version: VERSION,
        created: created.into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        device: device_name(),
        includes_vault: vault_root.is_some(),
        data_files: data.iter().map(|(n, _)| n.clone()).collect(),
        vault_files: items.iter().filter(|i| !i.dir).count() as u64,
        bytes: data.iter().map(|(_, b)| b.len() as u64).sum::<u64>()
            + app_json.as_ref().map_or(0, |b| b.len() as u64)
            + items.iter().map(|i| i.size).sum::<u64>(),
        compression: pack.name().into(),
    };

    let guard = TempFile(tmp.clone());
    let f = File::create(&tmp).map_err(|e| format!("create {}: {}", tmp.display(), e))?;
    let enc = encryptor(password)
        .wrap_output(BufWriter::with_capacity(1 << 20, f))
        .map_err(|e| format!("write backup: {}", e))?;
    let mut zip = ZipWriter::new_stream(enc);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = pack.options();

    let body = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file(MANIFEST, stored).map_err(zip_err)?;
    zip.write_all(&body).map_err(|e| format!("write backup: {}", e))?;
    for (name, bytes) in &data {
        zip.start_file(format!("data/{}", name), deflated).map_err(zip_err)?;
        zip.write_all(bytes).map_err(|e| format!("write backup: {}", e))?;
    }
    if let Some(b) = &app_json {
        zip.start_file(SETTINGS, deflated).map_err(zip_err)?;
        zip.write_all(b).map_err(|e| format!("write backup: {}", e))?;
    }
    // the vault's own settings and state (the look, tabs and spaces, bookmarks, backup plans): with settings kept in
    // the vault - the default - nearly every preference is there, not in app.json
    {
        // (with or without the notes: they are the backup's "settings")
        for (entry, file) in vault_settings_files(&it.vault) {
            if let Ok(b) = std::fs::read(&file) {
                zip.start_file(entry, deflated).map_err(zip_err)?;
                zip.write_all(&b).map_err(|e| format!("write backup: {}", e))?;
            }
        }
    }

    let mut written = 0u64;
    let mut skipped = unread;
    for item in &items {
        let name = format!("vault/{}", item.rel);
        if item.dir {
            zip.add_directory(format!("{}/", name), stored).map_err(zip_err)?;
            continue;
        }
        // opened before the entry starts: a streamed entry cannot be taken back
        let mut src = match File::open(&item.abs) {
            Ok(f) => f,
            Err(_) => {
                skipped.push(item.rel.clone());
                continue;
            }
        };
        let mut opts = if stored_ext(&item.rel) { stored } else { deflated };
        // zip64 has to be chosen before the data (4 GB limit otherwise); with
        // headroom for a file still growing while we read it
        opts = opts.large_file(item.size >= 1 << 31);
        if let Some(t) = item.mtime.and_then(zip_time) {
            opts = opts.last_modified_time(t);
        }
        zip.start_file(name, opts).map_err(zip_err)?;
        io::copy(&mut src, &mut zip).map_err(|e| format!("back up {}: {}", item.rel, e))?;
        written += 1;
    }

    let enc = zip.finish().map_err(zip_err)?.into_inner();
    let buf = enc.finish().map_err(|e| format!("write backup: {}", e))?;
    let f = buf.into_inner().map_err(|e| format!("write backup: {}", e.error()))?;
    f.sync_all().map_err(|e| format!("write backup: {}", e))?;
    drop(f);
    std::fs::rename(&tmp, out).map_err(|e| format!("save {}: {}", out.display(), e))?;
    drop(guard);

    Ok(BackupSummary {
        path: out.to_string_lossy().into_owned(),
        bytes: std::fs::metadata(out).map(|m| m.len()).unwrap_or(0),
        data_files: manifest.data_files,
        vault_files: written,
        created: manifest.created,
        skipped,
        ..Default::default()
    })
}

// ── peek ────────────────────────────────────────────────────────────────────

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

/// The manifest from the head of the plaintext. The zip is streamed, so its
/// sizes sit in a data descriptor AFTER the data: read the local header by
/// hand, then exactly one JSON value.
fn read_head_manifest(r: &mut impl Read) -> Result<BackupManifest, String> {
    let bad = |_| NOT_A_BACKUP.to_string();
    let mut h = [0u8; 30];
    r.read_exact(&mut h).map_err(bad)?;
    let method = u16_at(&h, 8);
    if h[..4] != [0x50, 0x4b, 0x03, 0x04] || method != 0 {
        return Err(NOT_A_BACKUP.into());
    }
    let mut name = vec![0u8; u16_at(&h, 26) as usize];
    r.read_exact(&mut name).map_err(bad)?;
    if name != MANIFEST.as_bytes() {
        return Err(NOT_A_BACKUP.into());
    }
    io::copy(&mut r.by_ref().take(u16_at(&h, 28) as u64), &mut io::sink()).map_err(bad)?;
    let mut de = serde_json::Deserializer::from_reader(r.take(MAX_MANIFEST));
    let m = BackupManifest::deserialize(&mut de).map_err(|_| NOT_A_BACKUP.to_string())?;
    check_manifest(&m)?;
    Ok(m)
}

/// What a backup holds, without restoring anything. Only the head of the
/// file is decrypted, so this is instant even for a multi-GB backup.
pub fn peek(path: &Path, password: &str) -> Result<BackupManifest, String> {
    let mut r = open_age(path, password)?;
    read_head_manifest(&mut r)
}

// ── import ──────────────────────────────────────────────────────────────────

fn read_entry<R: Read + io::Seek>(zip: &mut ZipArchive<R>, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    let f = zip.by_name(name).map_err(|_| NOT_A_BACKUP.to_string())?;
    let mut out = Vec::new();
    f.take(limit).read_to_end(&mut out).map_err(|_| NOT_A_BACKUP.to_string())?;
    Ok(out)
}

/// An entry read whole, counted against what is `left`; going over means the file is not what it says.
fn read_capped<R: Read + io::Seek>(zip: &mut ZipArchive<R>, name: &str, left: &mut u64) -> Result<Vec<u8>, String> {
    let b = read_entry(zip, name, *left + 1)?;
    if b.len() as u64 > *left {
        return Err(NOT_A_BACKUP.into());
    }
    *left -= b.len() as u64;
    Ok(b)
}

fn unique_dir(base: PathBuf) -> PathBuf {
    let mut p = base.clone();
    let mut n = 2;
    while std::fs::symlink_metadata(&p).is_ok() {
        p = PathBuf::from(format!("{} {}", base.to_string_lossy(), n));
        n += 1;
    }
    p
}

fn truncate_all(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        match e.file_type() {
            Ok(t) if t.is_dir() => truncate_all(&e.path()),
            Ok(t) if t.is_file() => {
                let _ = std::fs::OpenOptions::new().write(true).truncate(true).open(e.path());
            }
            _ => {}
        }
    }
}

/// Steps a-c of a restore. Returns the before-restore folder.
fn restore_data(
    it: &Items,
    settings: &Path,
    data: &[(String, Vec<u8>)],
    app_json: Option<&Value>,
    stamp: &str,
) -> Result<PathBuf, String> {
    let before = unique_dir(it.dir.join(format!("before-restore-{}", stamp)));
    std::fs::create_dir_all(&before).map_err(|e| format!("create {}: {}", before.display(), e))?;
    let copy = |from: &Path, to: &Path| -> Result<(), String> {
        if from.is_file() {
            std::fs::copy(from, to).map_err(|e| format!("set aside {}: {}", from.display(), e))?;
        }
        Ok(())
    };
    // a. this device's data, under the same stable names
    for name in DATA_FILES {
        if name != "base.snapshot.json" {
            copy(&data_path(it, name).expect("known name"), &before.join(name))?;
        }
    }
    copy(settings, &before.join("app.json"))?;

    let with_undo = |e: String| format!("{} (the previous data is in {})", e, before.display());
    // b. the log and its import baseline are replaced as a whole: a device
    // log replayed over the backup's snapshot would be neither state, and a
    // stale baseline would read the difference as edits from the Python app
    let log = it.dir.join("log");
    datadir::move_item(&log, &before.join("log")).map_err(with_undo)?;
    datadir::move_item(&it.dir.join("base.snapshot.json"), &before.join("base.snapshot.json")).map_err(with_undo)?;
    // move_item falls back to copy+delete; if the delete failed (a handle
    // held open), empty what is left - the copy is already safe
    truncate_all(&log);
    std::fs::create_dir_all(&log).map_err(|e| with_undo(format!("create {}: {}", log.display(), e)))?;
    for (name, bytes) in data {
        let Some(p) = data_path(it, name) else { continue };
        vault::write_atomic(&p, bytes).map_err(|e| with_undo(format!("write {}: {}", p.display(), e)))?;
    }

    // c. preferences travel, this machine's paths and geometry do not
    if let Some(theirs) = app_json {
        let ours = crate::read_json(settings).filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
        let merged = merge_settings(&ours, theirs);
        let body = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
        vault::write_atomic(settings, body.as_bytes())
            .map_err(|e| with_undo(format!("write settings: {}", e)))?;
    }
    Ok(before)
}

/// Fill `buf` as far as the reader allows; short only at EOF.
fn fill(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

fn same_bytes(a: &mut impl Read, b: &mut impl Read) -> io::Result<bool> {
    let (mut x, mut y) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let (n, m) = (fill(a, &mut x)?, fill(b, &mut y)?);
        if n != m || x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Stream one entry to `dest` through a dot-temp in the same folder.
fn write_stream(dest: &Path, src: &mut impl Read) -> Result<(), String> {
    let tmp = sibling(dest, ".tmp")?;
    let guard = TempFile(tmp.clone());
    let res = (|| -> io::Result<()> {
        let mut w = BufWriter::with_capacity(1 << 20, File::create(&tmp)?);
        io::copy(src, &mut w)?;
        let f = w.into_inner().map_err(|e| e.into_error())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, dest)
    })();
    drop(guard);
    res.map_err(|e| format!("write {}: {}", dest.display(), e))
}

#[derive(Default)]
struct VaultOutcome {
    written: u64,
    unchanged: u64,
    replaced: u64,
    skipped: Vec<String>,
}

/// Step d: every `vault/...` entry into the current vault. Never outside it
/// (vault::resolve), never into our data folder, and a differing file already
/// there goes to .trash first.
fn restore_vault<R: Read + io::Seek>(
    zip: &mut ZipArchive<R>,
    root: &Path,
    data_root: &Path,
    io_lock: &Mutex<()>,
    stamp: &str,
    mut left: u64,
) -> Result<VaultOutcome, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("create vault {}: {}", root.display(), e))?;
    let mut out = VaultOutcome::default();
    for i in 0..zip.len() {
        let (name, is_dir, size) = {
            let f = zip.by_index(i).map_err(|_| NOT_A_BACKUP.to_string())?;
            if f.enclosed_name().is_none() {
                return Err(format!("unsafe path in backup: {}", entry_name(&f)));
            }
            (f.name().map_err(|_| NOT_A_BACKUP.to_string())?.into_owned(), f.is_dir(), f.size())
        };
        let Some(rel) = name.strip_prefix("vault/") else { continue };
        let rel = rel.trim_end_matches('/');
        if rel.is_empty() {
            continue;
        }
        // the vault's own files only: "@guest/..." names an outside file that is open, never something a backup restores
        let dest = match vault::resolve(root, rel) {
            Ok(p) if !vault::is_guest(rel) && !is_under(&p, data_root) => p,
            _ => {
                out.skipped.push(rel.to_string());
                continue;
            }
        };
        let _io = lock(io_lock);
        if is_dir {
            if std::fs::create_dir_all(&dest).is_err() {
                out.skipped.push(rel.to_string());
            }
            continue;
        }
        if let Ok(md) = std::fs::symlink_metadata(&dest) {
            if !md.is_file() {
                out.skipped.push(rel.to_string());
                continue;
            }
            let same = md.len() == size && {
                let mut a = File::open(&dest).map_err(|e| format!("read {}: {}", rel, e))?;
                let mut b = zip.by_index(i).map_err(|_| NOT_A_BACKUP.to_string())?;
                same_bytes(&mut a, &mut b).map_err(|_| NOT_A_BACKUP.to_string())?
            };
            if same {
                out.unchanged += 1;
                continue;
            }
            if vault::is_note(rel) {
                vault::trash(root, rel, stamp, true)?;
            } else {
                vault::trash_file(root, rel, stamp)?;
            }
            out.replaced += 1;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {}", parent.display(), e))?;
        }
        let mut f = zip.by_index(i).map_err(|_| NOT_A_BACKUP.to_string())?;
        let mtime = f.last_modified();
        write_stream(&dest, &mut (&mut f).take(left + 1))?;
        let got = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        if got > left {
            let _ = std::fs::remove_file(&dest);
            return Err("the backup unpacks to far more than its size - stopped".into());
        }
        left -= got;
        apply_mtime(&dest, mtime);
        out.written += 1;
    }
    Ok(out)
}

/// Restore a backup over this device's data. `vault_root` is Some when the
/// vault should be restored too (ignored if the backup has none). `io` and
/// then `tasks` (the order data_dir_set uses) are held while our data and
/// settings are replaced; the vault is written file by file under `io`.
#[allow(clippy::too_many_arguments)]
pub fn import<T>(
    path: &Path,
    password: &str,
    it: &Items,
    settings: &Path,
    vault_root: Option<&Path>,
    io_lock: &Mutex<()>,
    tasks: &Mutex<T>,
    stamp: &str,
) -> Result<BackupSummary, String> {
    // read straight from the encrypted file: a decrypted copy next to the backup would sit, whole and readable,
    // in the folder backups are usually kept in - one a cloud drive copies away (and a crash would leave it there)
    let mut zip = ZipArchive::new(BufReader::with_capacity(1 << 16, open_age(path, password)?)).map_err(|_| NOT_A_BACKUP.to_string())?;
    // zip-slip: refuse the whole file before writing anything
    if let Some(bad) = zip.file_names().find(|n| !n.as_ref().is_ok_and(|n| safe_entry_name(n))) {
        return Err(format!("unsafe path in backup: {}", bad.map(|b| b.into_owned()).unwrap_or_else(|_| "a name that is not text".into())));
    }
    let manifest: BackupManifest = serde_json::from_slice(&read_entry(&mut zip, MANIFEST, MAX_MANIFEST)?)
        .map_err(|_| NOT_A_BACKUP.to_string())?;
    check_manifest(&manifest)?;

    let names: Vec<String> = zip.file_names().map(|n| n.map(|n| n.into_owned())).collect::<Result<_, _>>().map_err(|_| NOT_A_BACKUP.to_string())?;
    let mut data = Vec::new();
    let mut left = MAX_DATA;
    for n in &names {
        if let Some(stable) = n.strip_prefix("data/") {
            if !n.ends_with('/') && data_path(it, stable).is_some() {
                data.push((stable.to_string(), read_capped(&mut zip, n, &mut left)?));
            }
        }
    }
    // the vault's settings and state, merged in the same way as app.json (this computer keeps its own paths)
    let mut vault_sets: Vec<(PathBuf, Value)> = Vec::new();
    {
        for (entry, file) in vault_settings_files(&it.vault) {
            if names.iter().any(|n| n == entry) {
                if let Ok(v) = serde_json::from_slice::<Value>(&read_entry(&mut zip, entry, MAX_MANIFEST * 16)?) {
                    if v.is_object() { vault_sets.push((file, v)); }
                }
            }
        }
    }
    // parsed before anything is touched, so a bad file cannot stop a restore half-way
    let app_json: Option<Value> = if names.iter().any(|n| n == SETTINGS) {
        let v = serde_json::from_slice(&read_entry(&mut zip, SETTINGS, MAX_MANIFEST * 16)?)
            .ok()
            .filter(|v: &Value| v.is_object())
            .ok_or_else(|| NOT_A_BACKUP.to_string())?;
        Some(v)
    } else {
        None
    };

    // the notes first, the data files last - just before the restart: while the notes were written (minutes for a big
    // vault) the page, still open, could save its old settings or habits over the restored ones. A vault that fails
    // now leaves tasks and settings as they were (what it wrote is undoable from .trash)
    // a real vault of films can pass MAX_OUT, but then its backup is about that big too
    let room = MAX_OUT.max(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0).saturating_mul(4));
    let vo = match vault_root {
        Some(root) if manifest.includes_vault => restore_vault(&mut zip, root, &it.dir, io_lock, stamp, room)?,
        _ => VaultOutcome::default(),
    };
    drop(zip);
    let before = {
        let _io = lock(io_lock);
        let _tasks = lock(tasks);
        let before = restore_data(it, settings, &data, app_json.as_ref(), stamp)
            .map_err(|e| if vo.written > 0 { format!("{e} - the notes and files were restored already") } else { e })?;
        for (file, theirs) in &vault_sets {
            // the current one kept beside the rest from before
            if let Some(n) = file.file_name() { let _ = std::fs::copy(file, before.join(format!("vault-{}", n.to_string_lossy()))); }
            let ours = crate::read_json(file).filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
            let body = serde_json::to_string_pretty(&merge_settings(&ours, theirs)).map_err(|e| e.to_string())?;
            vault::write_atomic(file, body.as_bytes()).map_err(|e| format!("write {}: {} (the previous data is in {})", file.display(), e, before.display()))?;
        }
        before
    };

    Ok(BackupSummary {
        path: path.to_string_lossy().into_owned(),
        bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        data_files: data.into_iter().map(|(n, _)| n).collect(),
        vault_files: vo.written,
        created: manifest.created,
        skipped: vo.skipped,
        before_restore: Some(before.to_string_lossy().into_owned()),
        vault_unchanged: vo.unchanged,
        vault_replaced: vo.replaced,
    })
}

// ── commands ────────────────────────────────────────────────────────────────

fn items_of(p: &crate::Paths) -> Items {
    Items {
        dir: p.dir.clone(),
        snapshot: p.snapshot.clone(),
        habits: p.habits.clone(),
        recurring: p.recurring.clone(),
        priorities: p.priorities.clone(),
        stats: p.stats.clone(),
        positions: p.positions.clone(),
        graph: p.graph.clone(),
        fit: p.fit.clone(),
        vault: p.vault.clone(),
    }
}

/// Save an encrypted backup to `path`, the absolute path from a save dialog.
#[tauri::command]
pub async fn backup_export(
    app: tauri::AppHandle,
    path: String,
    password: String,
    include_vault: bool,
    compression: Option<String>,
    state: State<'_, AppState>,
) -> Result<BackupSummary, String> {
    let password = SecretString::from(password);
    let pack = Pack::parse(compression.as_deref())?;
    // the save dialog has handed this one over; any other path is asked about
    crate::grant::allow(&app, Path::new(&path), "save a backup of everything to", false)?;
    let p = &state.paths;
    let root = include_vault.then_some(p.vault.as_path());
    export_packed(Path::new(&path), password.expose_secret(), &items_of(p), &p.settings, root, &state.io, &crate::now_local(), pack)
}

/// The manifest of a backup, to show before restoring. Errors are exactly
/// "wrong password" or "not a Leonote backup" for those two cases.
#[tauri::command]
pub async fn backup_peek(app: tauri::AppHandle, path: String, password: String) -> Result<BackupManifest, String> {
    crate::grant::allow_far_look(&app, Path::new(&path), "look inside this archive on another computer (looking only)")?; // a network path logs Windows in there when looked at: asked first
    let password = SecretString::from(password);
    peek(Path::new(&path), password.expose_secret())
}

/// Restore a backup. This device's previous data is set aside in
/// `<data root>/before-restore-<stamp>/` first.
///
/// The frontend must call `app_restart` afterwards: the task state, the
/// watcher and every open note still describe the data from before.
#[tauri::command]
pub async fn backup_import(
    app: tauri::AppHandle,
    path: String,
    password: String,
    restore_vault: bool,
    state: State<'_, AppState>,
) -> Result<BackupSummary, String> {
    // a network path logs Windows in there when opened: asked first, as for looking inside one (backup_peek)
    crate::grant::allow_far_look(&app, Path::new(&path), "restore this backup from another computer (reading it only)")?;
    let password = SecretString::from(password);
    let p = &state.paths;
    let root = restore_vault.then_some(p.vault.as_path());
    let r = import(
        Path::new(&path),
        password.expose_secret(),
        &items_of(p),
        &p.settings,
        root,
        &state.io,
        &state.tasks,
        &crate::trash_stamp(),
    );
    if r.is_ok() { RESTORED.store(true, std::sync::atomic::Ordering::SeqCst); }
    r
}

/// A restore wrote its files and the page restarts in a moment: until it does, the page's own whole-file saves (settings,
/// habits) are not written - they would put its old, in-memory state over what was just restored.
pub static RESTORED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);


// ── plans: plain zips of what you chose, made on a schedule ─────────────────
//
// A plan backs up categories of the vault (notes, pictures, media, documents,
// code, sketches, boards, drawings, other), any extensions picked one by one,
// and Leonote's own data. It is an ordinary zip - readable anywhere, no
// password - so it is the everyday safety net; the encrypted backup above is
// for moving to another computer.

/// The category a vault file belongs to, for the plan's choices.
pub fn category_of(rel: &str) -> &'static str {
    let ext = rel.rsplit('.').next().map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" | "txt" => "notes",
        "excalidraw" | "leovector" | "leopaint" | "leocanvas" => "sketches",
        "canvas" | "leoboard" => "boards",
        "leostudio" => "drawings",
        _ => match vault::file_kind(rel) {
            "image" => "images",
            "media" => "media",
            "pdf" | "office" => "documents",
            "text" => "code",
            _ => "other",
        },
    }
}

#[derive(Serialize)]
pub struct CategoryStat {
    pub category: String,
    pub ext: String,
    pub count: u64,
    pub bytes: u64,
}

/// What the vault holds, by category and extension: the plan's setup shows counts and sizes.
#[tauri::command]
pub async fn backup_categories(state: State<'_, AppState>) -> Result<Vec<CategoryStat>, String> {
    let p = &state.paths;
    let mut items = Vec::new();
    list_vault(&p.vault, &p.vault, &p.dir, &mut items);
    let mut by: std::collections::BTreeMap<(String, String), (u64, u64)> = std::collections::BTreeMap::new();
    for it in items.iter().filter(|i| !i.dir) {
        let ext = if it.rel.rsplit('/').next().unwrap_or("").contains('.') { it.rel.rsplit('.').next().map(|e| e.to_ascii_lowercase()).unwrap_or_default() } else { String::new() };
        let e = by.entry((category_of(&it.rel).to_string(), ext)).or_insert((0, 0));
        e.0 += 1;
        e.1 += it.size;
    }
    Ok(by.into_iter().map(|((category, ext), (count, bytes))| CategoryStat { category, ext, count, bytes }).collect())
}

#[derive(Serialize)]
pub struct PlainSummary {
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    pub skipped: Vec<String>,
}

/// The folder a plan uses unless told otherwise, beside the vault (backupDir in backupplans.js): no need to ask about it.
fn usual_backup_folder(dir: &Path, vault: &Path) -> bool {
    !dir.components().any(|c| matches!(c, std::path::Component::ParentDir))
        && vault.parent().is_some_and(|v| norm(dir) == norm(&v.join("Leonote Backups")))
}

/// Whether a plan can read what it was asked for: a vault that cannot be read is an error, not an empty backup.
/// Ok holds the folders inside it that could not be read (the walk passes over them).
fn plan_vault_check(vault: &Path, items: &[VaultItem]) -> Result<Vec<String>, String> {
    if std::fs::read_dir(vault).is_err() {
        return Err(format!("the vault cannot be read: {} - nothing was backed up, older backups are kept", vault.display()));
    }
    Ok(items.iter().filter(|i| i.dir && std::fs::read_dir(&i.abs).is_err()).map(|i| format!("{}/", i.rel)).collect())
}

/// A file or folder that could not be read and is no longer there: the drive went, as against one locked or barred.
fn gone(p: &Path) -> bool {
    std::fs::metadata(p).is_err_and(|e| e.kind() != io::ErrorKind::PermissionDenied)
}

/// May this zip push out an older one? Not when things went missing during the run, or when most of it could not be read.
/// A lone locked file or barred folder does not count: it would stop the plan's limit for good.
fn holds_enough(lost: bool, picked: usize, skipped: usize) -> bool {
    !lost && skipped * 2 <= picked
}

/// A plain zip at `path` of the chosen categories and extensions of the vault,
/// with Leonote's own data when "data" is among the categories.
#[tauri::command]
pub async fn backup_plain(app: tauri::AppHandle, path: String, categories: Vec<String>, exts: Vec<String>, compression: Option<String>, keep: Option<usize>, state: State<'_, AppState>) -> Result<PlainSummary, String> {
    use tauri::Emitter;
    let pack = Pack::parse(compression.as_deref())?;
    let out = PathBuf::from(&path);
    if !out.is_absolute() { return Err(format!("not an absolute path: {}", out.display())); }
    // plans and their folders can arrive in a synced vault's settings: nowhere new without the user's word
    if !out.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) { return Err(format!("not a zip: {}", out.display())); }
    if let Some(d) = out.parent() { if !usual_backup_folder(d, &state.paths.vault) { crate::grant::allow(&app, d, "save backups into", true)?; } }
    if let Some(d) = out.parent() { std::fs::create_dir_all(d).map_err(|e| format!("create {}: {}", d.display(), e))?; }
    let tmp = sibling(&out, ".tmp")?;
    let p = &state.paths;
    let want_data = categories.iter().any(|c| c == "data");
    let exts: Vec<String> = exts.iter().map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase()).filter(|e| !e.is_empty()).collect();
    let mut items = Vec::new();
    list_vault(&p.vault, &p.vault, &p.dir, &mut items);
    let asks_vault = !exts.is_empty() || categories.iter().any(|c| c != "data");
    let unread = if asks_vault { plan_vault_check(&p.vault, &items)? } else { Vec::new() };
    let picked: Vec<&VaultItem> = items.iter().filter(|i| !i.dir).filter(|i| {
        let ext = i.rel.rsplit('.').next().map(|e| e.to_ascii_lowercase()).unwrap_or_default();
        categories.iter().any(|c| c == "all" || c == category_of(&i.rel)) || exts.iter().any(|e| *e == ext)
    }).collect();
    // the task files read while no compaction folds them (it holds `tasks`): mid-fold, the backup had the old snapshot
    // and the logs already emptied
    let (data, app_json) = if want_data { let _io = lock(&state.io); let _tasks = lock(&state.tasks); read_data(&items_of(p), &p.settings)? } else { (Vec::new(), None) };
    let vault_settings = if want_data { read_opt(&crate::settings::vault_file(&p.vault))? } else { None };
    let vault_state = if want_data { read_opt(&crate::settings::vault_file(&p.vault).with_file_name("state.json"))? } else { None };
    let has_files = items.iter().any(|i| !i.dir);
    if picked.is_empty() && data.is_empty() && app_json.is_none() {
        if !has_files { return Err("there is nothing to back up - older backups are kept".into()); }
        // none of the plan's kinds in this vault yet: no empty zip, and no red toast every hour for it
        return Ok(PlainSummary { path: out.parent().unwrap_or(&out).to_string_lossy().into_owned(), bytes: 0, files: 0, skipped: unread });
    }
    let picked_n = picked.len();
    let mut lost = unread.iter().any(|r| gone(&p.vault.join(r)));

    let guard = TempFile(tmp.clone());
    let f = File::create(&tmp).map_err(|e| format!("create {}: {}", tmp.display(), e))?;
    let mut zip = ZipWriter::new(BufWriter::with_capacity(1 << 20, f));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = pack.options();
    let mut written = 0u64;
    let mut skipped = Vec::new();
    let total = picked.len() as u64 + data.len() as u64;
    let total_bytes: u64 = picked.iter().map(|i| i.size).sum();
    let mut done_bytes = 0u64;
    let mut last_tick = std::time::Instant::now();
    let progress = |done: u64, done_bytes: u64, rel: &str| { let _ = app.emit("backup:progress", serde_json::json!({ "done": done, "total": total, "bytes": done_bytes, "totalBytes": total_bytes, "file": rel })); };
    for (name, bytes) in &data {
        zip.start_file(format!("data/{}", name), deflated).map_err(zip_err)?;
        zip.write_all(bytes).map_err(|e| format!("write backup: {}", e))?;
        written += 1;
    }
    if let Some(b) = &app_json { zip.start_file(SETTINGS, deflated).map_err(zip_err)?; zip.write_all(b).map_err(|e| format!("write backup: {}", e))?; written += 1; }
    if let Some(b) = &vault_settings { zip.start_file("settings/vault-settings.json", deflated).map_err(zip_err)?; zip.write_all(b).map_err(|e| format!("write backup: {}", e))?; written += 1; }
    if let Some(b) = &vault_state { zip.start_file("settings/vault-state.json", deflated).map_err(zip_err)?; zip.write_all(b).map_err(|e| format!("write backup: {}", e))?; written += 1; }
    for item in picked {
        let mut src = match File::open(&item.abs) { Ok(f) => f, Err(_) => { lost = lost || gone(&item.abs); skipped.push(item.rel.clone()); continue; } };
        let mut opts = if stored_ext(&item.rel) { stored } else { deflated };
        opts = opts.large_file(item.size >= 1 << 31);
        if let Some(t) = item.mtime.and_then(zip_time) { opts = opts.last_modified_time(t); }
        zip.start_file(format!("vault/{}", item.rel), opts).map_err(zip_err)?;
        io::copy(&mut src, &mut zip).map_err(|e| format!("back up {}: {}", item.rel, e))?;
        written += 1;
        done_bytes += item.size;
        // a word every quarter second, or every 4 MB, whichever comes first - never per file on a vault of thousands
        if last_tick.elapsed().as_millis() >= 250 || item.size >= 4 << 20 { progress(written, done_bytes, &item.rel); last_tick = std::time::Instant::now(); }
    }
    progress(written, done_bytes, "");
    let buf = zip.finish().map_err(zip_err)?;
    let f = buf.into_inner().map_err(|e| format!("write backup: {}", e.error()))?;
    f.sync_all().map_err(|e| format!("write backup: {}", e))?;
    drop(f);
    std::fs::rename(&tmp, &out).map_err(|e| format!("finish {}: {}", out.display(), e))?;
    std::mem::forget(guard);
    let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    // only a backup that holds what was asked for pushes out an older one: a drive that dropped must not cost the good ones
    let whole = holds_enough(lost, picked_n, skipped.len()) && (!asks_vault || has_files) && (!want_data || !data.is_empty());
    skipped.extend(unread);
    if whole { if let Some(k) = keep { prune_siblings(&out, k); } }
    Ok(PlainSummary { path: out.to_string_lossy().into_owned(), bytes, files: written, skipped })
}

/// A plan's zips are `<vault> - <plan> - <stamp>.zip`: drop the oldest of
/// the same `<vault> - <plan> - ` beyond `keep`, so a daily plan does not
/// fill the disk. Only the just-written archive's own family is touched.
/// "YYYY-MM-DD HHMM.zip", as a plan names its backups.
fn is_stamp_zip(rest: &str) -> bool {
    let b = rest.as_bytes();
    b.len() == 19 && rest.ends_with(".zip") && b.iter().take(15).enumerate().all(|(i, c)| match i { 4 | 7 => *c == b'-', 10 => *c == b' ', _ => c.is_ascii_digit() })
}

pub(crate) fn prune_siblings(out: &Path, keep: usize) {
    let keep = keep.max(1);
    let Some(name) = out.file_name().and_then(|n| n.to_str()) else { return };
    let Some(cut) = name.rfind(" - ") else { return };
    let prefix = &name[..cut + 3];
    let Some(dir) = out.parent() else { return };
    let mut family: Vec<PathBuf> = std::fs::read_dir(dir).ok().map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path())
        // only this plan's own: "V - Notes - " also starts "V - Notes - work - <stamp>", another plan's zips
        // and only a plan's own stamp after it ("2026-11-13 2130.zip"): a zip renamed to keep ("… - old laptop.zip")
        // is the user's
        .filter(|p| p.is_file() && p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with(prefix) && is_stamp_zip(&n[prefix.len()..])).unwrap_or(false))
        .collect()).unwrap_or_default();
    if family.len() <= keep { return; }
    family.sort(); // the stamp sorts oldest first
    for p in family.iter().take(family.len() - keep) { let _ = std::fs::remove_file(p); }
}

/// Folders on this computer that a cloud service keeps in sync - OneDrive,
/// Dropbox, Google Drive - offered as places for a plan's zips: a backup
/// there is off the machine minutes later, with no service of Leonote's own.
#[tauri::command]
pub async fn sync_folders() -> Vec<Value> {
    let mut out = Vec::new();
    let home = crate::home_dir();
    let mut add = |name: &str, p: PathBuf| { if p.is_dir() { out.push(json!({ "name": name, "path": p.to_string_lossy() })); } };
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Ok(p) = std::env::var(var) { if !p.is_empty() { add("OneDrive", PathBuf::from(p)); } }
    }
    add("Dropbox", home.join("Dropbox"));
    add("Google Drive", home.join("Google Drive"));
    add("Google Drive", home.join("My Drive"));
    for d in ["G:\\My Drive", "G:\\Мой диск"] { add("Google Drive", PathBuf::from(d)); }
    add("iCloud Drive", home.join("iCloudDrive"));
    add("Proton Drive", home.join("Proton Drive"));
    add("MEGA", home.join("MEGA"));
    out.dedup_by(|a, b| a["path"] == b["path"]);
    out
}

// ── archives: a look inside a zip, and files taken out of it ────────────────

#[derive(Serialize)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub packed: u64,
    pub dir: bool,
    pub modified: String,
}

fn is_7z(path: &str) -> bool { path.to_ascii_lowercase().ends_with(".7z") }
fn is_zip(path: &str) -> bool { path.to_ascii_lowercase().ends_with(".zip") }

/// An archive tool already on this PC - 7-Zip first (it reads rar, tar, gz
/// and the rest), UnRAR from WinRAR for rar alone. Nothing is bundled: a PC
/// without either opens zip and 7z only, and says so.
fn archive_tool(path: &str) -> Result<(PathBuf, bool), String> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
    let seven = [PathBuf::from(&pf).join("7-Zip").join("7z.exe"), PathBuf::from(&pf86).join("7-Zip").join("7z.exe")];
    if let Some(p) = seven.iter().find(|p| p.is_file()) { return Ok((p.clone(), true)); }
    if path.to_ascii_lowercase().ends_with(".rar") {
        let unrar = [PathBuf::from(&pf).join("WinRAR").join("UnRAR.exe"), PathBuf::from(&pf86).join("WinRAR").join("UnRAR.exe")];
        if let Some(p) = unrar.iter().find(|p| p.is_file()) { return Ok((p.clone(), false)); }
        return Err("No 7-Zip or WinRAR on this PC: install one and Leonote opens .rar files here.".into());
    }
    Err("No 7-Zip on this PC: install it and Leonote opens this kind of archive here.".into())
}

fn quiet(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
}

fn tool_list(path: &str) -> Result<Vec<ArchiveEntry>, String> {
    let (exe, seven) = archive_tool(path)?;
    let mut cmd = std::process::Command::new(&exe);
    // "--": a path that starts with "-" is a name, not a switch
    if seven { cmd.args(["l", "-slt", "-ba", "--", path]); } else { cmd.args(["lt", "-y", "--", path]); }
    quiet(&mut cmd);
    let out = cmd.output().map_err(|e| format!("run {}: {}", exe.display(), e))?;
    if !out.status.success() { return Err(format!("{} could not read it: {}", exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), String::from_utf8_lossy(&out.stderr).trim())); }
    let text = String::from_utf8_lossy(&out.stdout);
    // both tools print one block per entry, "Key = value" or "Key: value", blank line between
    let mut entries = Vec::new();
    let mut cur: Option<ArchiveEntry> = None;
    let flush = |cur: &mut Option<ArchiveEntry>, entries: &mut Vec<ArchiveEntry>| { if let Some(e) = cur.take() { if !e.name.is_empty() { entries.push(e); } } };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { flush(&mut cur, &mut entries); continue; }
        let (k, v) = match line.split_once(if seven { " = " } else { ": " }) { Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().to_string()), None => { if let Some((k, _)) = line.split_once(if seven { " =" } else { ":" }) { (k.trim().to_ascii_lowercase(), String::new()) } else { continue } } };
        match k.as_str() {
            "path" | "name" => { flush(&mut cur, &mut entries); cur = Some(ArchiveEntry { name: v.replace('\\', "/"), size: 0, packed: 0, dir: false, modified: String::new() }); }
            "size" => { if let Some(e) = cur.as_mut() { e.size = v.parse().unwrap_or(0); } }
            "packed size" => { if let Some(e) = cur.as_mut() { e.packed = v.parse().unwrap_or(0); } }
            "modified" => { if let Some(e) = cur.as_mut() { e.modified = v.chars().take(16).collect(); } }
            "attributes" => { if let Some(e) = cur.as_mut() { if v.contains('D') { e.dir = true; } } }
            "folder" => { if let Some(e) = cur.as_mut() { if v == "+" { e.dir = true; } } }
            "type" => { if let Some(e) = cur.as_mut() { if v.eq_ignore_ascii_case("directory") { e.dir = true; } } }
            _ => {}
        }
    }
    flush(&mut cur, &mut entries);
    Ok(entries)
}

fn tool_extract(path: &str, entries: &[String], into: &Path, no_dots: bool) -> Result<u64, String> {
    let (exe, seven) = archive_tool(path)?;
    let mut cmd = std::process::Command::new(&exe);
    if seven {
        // "--": no name after it is read as a switch (an entry called "-o..." stays a name)
        cmd.arg("x").arg("-y").arg("-aou").arg(format!("-o{}", into.display()));
        if no_dots { cmd.arg("-xr!.*"); for n in SHORT_DOTS { cmd.arg(format!("-xr!{n}")); } }
        cmd.arg("--").arg(path);
        for e in entries { cmd.arg(e.replace('/', "\\")); }
    } else {
        cmd.arg("x").arg("-y").arg("-or");
        if no_dots { cmd.args(["-x.*", "-x*\\.*"]); for n in SHORT_DOTS { cmd.arg(format!("-x{n}\\*")).arg(format!("-x*\\{n}\\*")); } }
        cmd.arg("--").arg(path);
        for e in entries { cmd.arg(e.replace('/', "\\")); }
        cmd.arg(format!("{}\\", into.display()));
    }
    quiet(&mut cmd);
    let out = cmd.output().map_err(|e| format!("run {}: {}", exe.display(), e))?;
    if !out.status.success() { return Err(format!("extraction failed: {}", String::from_utf8_lossy(&out.stderr).trim())); }
    // how many files came out: what the tool listed, or every file of the archive
    let want: std::collections::HashSet<&str> = entries.iter().map(|s| s.as_str()).collect();
    let n = tool_list(path)?.into_iter().filter(|e| !e.dir && !(no_dots && dot_path(Path::new(&e.name))) && (want.is_empty() || want.contains(e.name.as_str()) || want.iter().any(|w| e.name.starts_with(&format!("{}/", w))))).count();
    Ok(n as u64)
}

fn sevenz_list(path: &str) -> Result<Vec<ArchiveEntry>, String> {
    let sz = sevenz_rust::SevenZReader::open(path, sevenz_rust::Password::empty()).map_err(|e| format!("not a 7z archive: {}", e))?;
    Ok(sz.archive().files.iter().map(|f| {
        let modified = if f.has_last_modified_date { let t: std::time::SystemTime = f.last_modified_date().into(); chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%d %H:%M").to_string() } else { String::new() };
        ArchiveEntry { name: f.name().to_string(), size: f.size(), packed: 0, dir: f.is_directory(), modified }
    }).collect())
}

// ponytail: 64 GB written at most - far past any real archive, short of a few-KB "zip bomb" filling the disk
const MAX_OUT: u64 = 64 << 30;

/// A hidden file or folder somewhere on the path: `.leonote`, `.git` and the like, never unpacked into the vault.
fn dot_path(p: &Path) -> bool {
    p.components().any(|c| matches!(c, std::path::Component::Normal(s) if s.to_string_lossy().starts_with('.')))
}

/// The same, judged where the entry really lands: on a drive with short names GIT~1 is `.git`, and writing through it
/// would plant a hook. Only a name with a ~ is looked up on disk.
pub(crate) fn lands_hidden(root: &Path, rel: &Path) -> bool {
    if dot_path(rel) { return true; }
    if !rel.to_string_lossy().contains('~') { return false; }
    let (Ok(canon), Some(real)) = (root.canonicalize(), crate::mcp::real_path(&root.join(rel))) else { return false };
    real.strip_prefix(&canon).is_ok_and(dot_path)
}
/// `.git`, `.trash`, `.leonote` by their short names, for the outside tools, which cannot ask where an entry lands.
const SHORT_DOTS: [&str; 3] = ["GIT~?", "TRASH~?", "LEONOT~?"];

/// A new file at `dest`, or beside it under a free name: unpacking never replaces what is there.
fn new_file(dest: &Path) -> io::Result<(PathBuf, File)> {
    let (Some(dir), Some(name)) = (dest.parent(), dest.file_name()) else { return Err(io::ErrorKind::InvalidInput.into()) };
    let dest = crate::clip::free_name(dir, &name.to_string_lossy());
    let f = File::options().write(true).create_new(true).open(&dest)?;
    Ok((dest, f))
}

fn sevenz_extract(path: &str, want: &std::collections::HashSet<String>, root: &Path, no_dots: bool) -> Result<u64, String> {
    let mut sz = sevenz_rust::SevenZReader::open(path, sevenz_rust::Password::empty()).map_err(|e| format!("not a 7z archive: {}", e))?;
    let mut n = 0u64;
    let mut written = 0u64;
    let mut err: Option<String> = None;
    sz.for_each_entries(|entry, reader| {
        let name = entry.name().to_string();
        let take = want.is_empty() || want.contains(&name) || want.iter().any(|w| w.ends_with('/') && name.starts_with(w));
        if !take { return Ok(true); }
        // the same guard as the zip: nothing lands outside the folder
        let rel = Path::new(&name);
        // only plain names: "\Users\x" (root-relative) and "C:x" (drive-relative) are not "absolute" on Windows either
        if !rel.components().all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) { err = Some(format!("refused: {} would land outside the folder", name)); return Ok(false); }
        if no_dots && lands_hidden(root, rel) { return Ok(true); }
        let dest = root.join(rel);
        if entry.is_directory() { std::fs::create_dir_all(&dest)?; return Ok(true); }
        if let Some(d) = dest.parent() { std::fs::create_dir_all(d)?; }
        let (dest, mut out) = new_file(&dest)?;
        written += io::copy(&mut reader.take(MAX_OUT - written + 1), &mut out)?;
        if written > MAX_OUT { drop(out); let _ = std::fs::remove_file(&dest); err = Some("the archive unpacks to more than 64 GB - stopped".into()); return Ok(false); }
        n += 1;
        Ok(true)
    }).map_err(|e| format!("extract: {}", e))?;
    if let Some(e) = err { return Err(e); }
    Ok(n)
}

/// The entries of an archive - a zip or a 7z, a backup or any in the vault. Nothing is written.
#[tauri::command]
pub async fn archive_list(app: tauri::AppHandle, path: String) -> Result<Vec<ArchiveEntry>, String> {
    crate::grant::allow_far_look(&app, Path::new(&path), "look inside this archive on another computer (looking only)")?; // a network path logs Windows in there when looked at: asked first
    // 7-Zip and the readers block: on a thread of their own, so the app's other calls never wait behind them
    tauri::async_runtime::spawn_blocking(move || list_now(path)).await.map_err(|e| e.to_string())?
}
fn list_now(path: String) -> Result<Vec<ArchiveEntry>, String> {
    if is_7z(&path) { return sevenz_list(&path); }
    if !is_zip(&path) { return tool_list(&path); }
    let f = File::open(&path).map_err(|e| format!("open {}: {}", path, e))?;
    let mut z = ZipArchive::new(BufReader::new(f)).map_err(|e| format!("not a zip: {}", e))?;
    let mut out = Vec::with_capacity(z.len());
    for i in 0..z.len() {
        let e = z.by_index(i).map_err(zip_err)?;
        let modified = e.last_modified().map(|t| format!("{:04}-{:02}-{:02} {:02}:{:02}", t.year(), t.month(), t.day(), t.hour(), t.minute())).unwrap_or_default();
        out.push(ArchiveEntry { name: entry_name(&e), size: e.size(), packed: e.compressed_size(), dir: e.is_dir(), modified });
    }
    Ok(out)
}

/// Entries of a zip written under `into`, each at its own path inside the
/// archive; an entry that would land outside `into` is refused (zip slip).
/// `entries` empty means everything.
#[tauri::command]
pub async fn archive_extract(app: tauri::AppHandle, path: String, entries: Vec<String>, into: String, state: tauri::State<'_, crate::AppState>) -> Result<u64, String> {
    // an archive on another computer: asked before it is opened (opening logs Windows in there)
    crate::grant::allow_far_look(&app, Path::new(&path), "unpack files from this archive on another computer (reading it only)")?;
    // into the vault, or a folder the user picked; any other is asked about - a folder on another computer before it
    // is looked at (resolving it already reaches that computer)
    let target = PathBuf::from(&into);
    let vault = std::fs::canonicalize(&state.paths.vault).unwrap_or_else(|_| state.paths.vault.clone());
    // a folder on another computer is looked at only when its name puts it in the vault (a vault on a network share:
    // that is the vault's own server, reached anyway); then, as any other, it must really be there - no "..", no
    // junction leading out
    let named_in = !crate::grant::is_far(&target) || crate::outpost::is_under(&target, &state.paths.vault);
    let inside = named_in && std::fs::canonicalize(&target).map(|t| t.starts_with(&vault)).unwrap_or(false);
    if !inside { crate::grant::allow(&app, &target, "unpack files into", true)?; }
    let no_dots = inside || is_under(&target, &state.paths.vault);
    tauri::async_runtime::spawn_blocking(move || extract_now(path, entries, into, no_dots)).await.map_err(|e| e.to_string())?
}
fn extract_now(path: String, entries: Vec<String>, into: String, no_dots: bool) -> Result<u64, String> {
    let root = PathBuf::from(&into);
    if !root.is_absolute() { return Err("the folder must be an absolute path".into()); }
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {}", root.display(), e))?;
    if is_7z(&path) { let want: std::collections::HashSet<String> = entries.into_iter().collect(); return sevenz_extract(&path, &want, &root, no_dots); }
    if !is_zip(&path) { return tool_extract(&path, &entries, &root, no_dots); }
    let f = File::open(&path).map_err(|e| format!("open {}: {}", path, e))?;
    let mut z = ZipArchive::new(BufReader::new(f)).map_err(|e| format!("not a zip: {}", e))?;
    let want: std::collections::HashSet<String> = entries.into_iter().collect();
    let mut n = 0u64;
    let mut written = 0u64;
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(zip_err)?;
        let name = entry_name(&e);
        if !want.is_empty() && !want.contains(&name) && !want.iter().any(|w| w.ends_with('/') && name.starts_with(w)) { continue; }
        let Some(safe) = e.enclosed_name() else { return Err(format!("refused: {} would land outside the folder", name)) };
        if no_dots && lands_hidden(&root, &safe) { continue; }
        let dest = root.join(safe);
        if e.is_dir() { std::fs::create_dir_all(&dest).map_err(|er| format!("create {}: {}", dest.display(), er))?; continue; }
        if let Some(d) = dest.parent() { std::fs::create_dir_all(d).map_err(|er| format!("create {}: {}", d.display(), er))?; }
        let (dest, mut out) = new_file(&dest).map_err(|er| format!("write {}: {}", dest.display(), er))?;
        written += io::copy(&mut (&mut e).take(MAX_OUT - written + 1), &mut out).map_err(|er| format!("extract {}: {}", name, er))?;
        if written > MAX_OUT { drop(out); let _ = std::fs::remove_file(&dest); return Err("the archive unpacks to more than 64 GB - stopped".into()); }
        n += 1;
    }
    Ok(n)
}

/// One file of an archive taken out to a folder of its own under the temp
/// folder, to be looked at (or copied into the vault from there); returns its
/// full path. What earlier looks left there for a day or more is cleared away.
#[tauri::command]
pub async fn archive_preview(app: tauri::AppHandle, path: String, entry: String) -> Result<String, String> {
    crate::grant::allow_far_look(&app, Path::new(&path), "look inside this archive on another computer (looking only)")?;
    tauri::async_runtime::spawn_blocking(move || preview_now(path, entry)).await.map_err(|e| e.to_string())?
}
fn preview_now(path: String, entry: String) -> Result<String, String> {
    let base = std::env::temp_dir().join("leonote-archive");
    // Leonote made these itself: taking one into the vault asks nothing
    crate::grant::grant_dir(&base);
    if let Ok(rd) = std::fs::read_dir(&base) {
        for d in rd.flatten() {
            let old = d.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|e| e.as_secs() > 86_400).unwrap_or(false);
            if old { let _ = std::fs::remove_dir_all(d.path()); }
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = base.join(format!("{:x}", stamp));
    let n = extract_now(path, vec![entry.clone()], dir.to_string_lossy().into_owned(), false)?;
    if n == 0 { return Err(format!("{} is not in the archive", entry)); }
    let rel = Path::new(&entry);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err("refused: a path outside the archive".into()); }
    let out = dir.join(rel);
    if !out.is_file() { return Err(format!("{} did not come out", entry)); }
    // one kind of separator, the system's: the entry's own "/" would mix with the folder's "\"
    Ok(out.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR))
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    #[test]
    fn a_plan_keeps_its_last_n_and_leaves_other_plans_alone() {
        let d = std::env::temp_dir().join(format!("leo-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        for i in 1..=5 { std::fs::write(d.join(format!("V - Notes - 2026-09-0{} 1200.zip", i)), b"x").unwrap(); }
        std::fs::write(d.join("V - Media - 2026-09-01 1200.zip"), b"x").unwrap();
        // a plan whose name starts with this one's: its zips are its own
        for i in 1..=3 { std::fs::write(d.join(format!("V - Notes - work - 2026-09-0{} 1200.zip", i)), b"x").unwrap(); }
        // one the user renamed to keep: not the plan's to delete
        std::fs::write(d.join("V - Notes - 2025 old laptop.zip"), b"x").unwrap();
        prune_siblings(&d.join("V - Notes - 2026-09-05 1200.zip"), 2);
        let mut left: Vec<String> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["V - Media - 2026-09-01 1200.zip", "V - Notes - 2025 old laptop.zip", "V - Notes - 2026-09-04 1200.zip", "V - Notes - 2026-09-05 1200.zip",
            "V - Notes - work - 2026-09-01 1200.zip", "V - Notes - work - 2026-09-02 1200.zip", "V - Notes - work - 2026-09-03 1200.zip"]);
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn a_plan_says_when_the_vault_or_a_folder_cannot_be_read() {
        let d = std::env::temp_dir().join(format!("leo-plancheck-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("v/gone")).unwrap();
        std::fs::write(d.join("v/n.md"), "x").unwrap();
        let mut items = Vec::new();
        list_vault(&d.join("v"), &d.join("v"), &d.join("data"), &mut items);
        assert!(plan_vault_check(&d.join("v"), &items).unwrap().is_empty());
        std::fs::remove_dir(d.join("v/gone")).unwrap();
        assert_eq!(plan_vault_check(&d.join("v"), &items).unwrap(), vec!["gone/"]);
        assert!(plan_vault_check(&d.join("nope"), &[]).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn a_zip_pushes_out_older_ones_only_when_it_holds_enough() {
        // the drive went partway: nothing older goes, however many were written
        assert!(!holds_enough(true, 1000, 999) && !holds_enough(true, 1000, 1));
        assert!(!holds_enough(false, 1000, 999), "most of it unread");
        // the keep limit still holds: a locked file, or no file of a kind (only data in the zip)
        assert!(holds_enough(false, 1000, 1) && holds_enough(false, 0, 0));
        let d = std::env::temp_dir().join(format!("leo-gone-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert!(!gone(&d) && gone(&d.join("nope")));
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn only_the_folder_beside_the_vault_goes_unasked() {
        let v = Path::new("E:\\Notes\\V");
        assert!(usual_backup_folder(Path::new("E:\\Notes\\Leonote Backups"), v));
        assert!(!usual_backup_folder(Path::new("E:\\Notes\\Leonote Backups\\..\\..\\x"), v));
        assert!(!usual_backup_folder(Path::new("\\\\attacker\\drop"), v));
    }
    #[test]
    fn categories_are_what_a_person_would_call_them() {
        assert_eq!(category_of("Diary/2026.md"), "notes");
        assert_eq!(category_of("Attachments/pic.webp"), "images");
        assert_eq!(category_of("Boards/x.canvas"), "boards");
        assert_eq!(category_of("Sketch 1.excalidraw"), "sketches");
        assert_eq!(category_of("a.leostudio"), "drawings");
        assert_eq!(category_of("a.leopaint"), "sketches");
        assert_eq!(category_of("paper.pdf"), "documents");
        assert_eq!(category_of("src/main.rs"), "code");
        assert_eq!(category_of("song.mp3"), "media");
        assert_eq!(category_of("thing.xyz"), "other");
    }
}

#[cfg(test)]
mod archive_tests {
    use std::io::Write;
    fn zip_of(p: &std::path::Path, files: &[(&str, &str)]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(p).unwrap());
        for (n, b) in files { z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap(); z.write_all(b.as_bytes()).unwrap(); }
        z.finish().unwrap();
    }
    #[test]
    fn unpacking_replaces_nothing_and_keeps_out_of_the_vaults_hidden_folders() {
        let d = std::env::temp_dir().join(format!("leo-extract-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("v/Daily")).unwrap();
        std::fs::write(d.join("v/Daily/n.md"), "mine").unwrap();
        let a = d.join("a.zip");
        zip_of(&a, &[("Daily/n.md", "theirs"), (".leonote/settings.json", "{}")]);
        let run = |into: &str, dots| super::extract_now(a.to_string_lossy().into_owned(), vec![], d.join(into).to_string_lossy().into_owned(), dots).unwrap();
        assert_eq!(run("v", true), 1);
        assert_eq!(std::fs::read_to_string(d.join("v/Daily/n.md")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(d.join("v/Daily/n 2.md")).unwrap(), "theirs");
        assert!(!d.join("v/.leonote").exists());
        // a folder elsewhere on the PC gets all of it
        assert_eq!(run("pc", false), 2);
        assert!(d.join("pc/.leonote/settings.json").is_file());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn a_restore_stops_at_its_limit_rather_than_cutting_a_file_short() {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(&mut buf);
        w.start_file("x", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(&[0u8; 100]).unwrap();
        w.finish().unwrap();
        let mut z = zip::ZipArchive::new(buf).unwrap();
        let (mut small, mut enough) = (99, 100);
        assert_eq!(super::read_capped(&mut z, "x", &mut small).unwrap_err(), super::NOT_A_BACKUP);
        assert_eq!(super::read_capped(&mut z, "x", &mut enough).unwrap().len(), 100);
        assert_eq!(enough, 0);
    }
    /// One file of a real archive taken out to look at, when LEONOTE_ARCHIVE names it (and LEONOTE_ENTRY one file):
    /// cargo test --release archive_tests -- --ignored --nocapture
    #[test]
    #[ignore]
    fn a_file_of_a_real_archive_comes_out_to_look_at() {
        let (Ok(a), Ok(e)) = (std::env::var("LEONOTE_ARCHIVE"), std::env::var("LEONOTE_ENTRY")) else { return };
        let t0 = std::time::Instant::now();
        let r = super::preview_now(a, e);
        println!("{:?} in {} ms", r, t0.elapsed().as_millis());
        assert!(r.is_ok());
    }
}
