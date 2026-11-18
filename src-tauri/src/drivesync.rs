//! Sync with the user's own Google Drive - the plan. Given the notes on this device, the files in Leonote's Drive
//! folder and what both held at the last sync, it says what to do with each one. Nothing here touches a file or
//! the network: the plan is checked (`brake`) before anything runs, and run elsewhere.
//!
//! The rules keep every version of a note somewhere:
//! - changed on one side only: that side's version goes across;
//! - changed on both (or different on both at the first sync): both are kept - the Drive version lands next to
//!   this one as "name (from Drive <when>).md", then this one goes up;
//! - deleted on one side and untouched on the other: it goes to the other side's trash (Leonote's .trash, Drive's
//!   bin), where it can be got back - never deleted outright;
//! - deleted on one side and changed on the other: the change wins and the note comes back;
//! - a plan that would bin many notes at once stops and asks (`brake`): a missing or unreadable folder looks
//!   exactly like "everything was deleted".
#![allow(dead_code)] // wired to Settings once the app's Google sign-in ID exists

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// What one side has at a path: the MD5 of its bytes (Drive gives `md5Checksum` for every file it stores).
pub type Hash = String;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Act {
    /// this device's version goes to Drive (a new file or over the one there)
    Upload(String),
    /// Drive's version comes here (a new note or over this one)
    Download(String),
    /// both changed: Drive's version is saved here as `copy`, then this one goes up over it
    KeepBoth { path: String, copy: String },
    /// deleted here, untouched on Drive: Drive's file goes to Drive's bin
    BinRemote(String),
    /// deleted on Drive, untouched here: this note goes to Leonote's .trash
    BinLocal(String),
    /// the same on both sides: only what was synced is written down
    Same(String),
    /// gone from both sides: forgotten
    Forget(String),
}

/// The plan for every path either side has, or had at the last sync. `when` names conflict copies ("2026-11-18 1405").
pub fn plan(local: &BTreeMap<String, Hash>, remote: &BTreeMap<String, Hash>, last: &BTreeMap<String, Hash>, when: &str) -> Vec<Act> {
    let paths: BTreeSet<&String> = local.keys().chain(remote.keys()).chain(last.keys()).collect();
    let mut taken: BTreeSet<String> = local.keys().chain(remote.keys()).cloned().collect();
    let mut out = Vec::new();
    for p in paths {
        let (l, r, s) = (local.get(p), remote.get(p), last.get(p));
        let act = match (l, r) {
            (Some(l), Some(r)) if l == r => Act::Same(p.clone()),
            (Some(l), Some(r)) => match s {
                Some(s) if l == s => Act::Download(p.clone()),
                Some(s) if r == s => Act::Upload(p.clone()),
                _ => Act::KeepBoth { path: p.clone(), copy: conflict_name(p, when, &mut taken) },
            },
            (Some(l), None) => match s {
                Some(s) if l == s => Act::BinLocal(p.clone()),
                _ => Act::Upload(p.clone()),
            },
            (None, Some(r)) => match s {
                Some(s) if r == s => Act::BinRemote(p.clone()),
                _ => Act::Download(p.clone()),
            },
            (None, None) => Act::Forget(p.clone()),
        };
        out.push(act);
    }
    out
}

/// "Notes/Plan.md" -> "Notes/Plan (from Drive 2026-11-18 1405).md", with " 2", " 3"... if that is taken too.
fn conflict_name(path: &str, when: &str, taken: &mut BTreeSet<String>) -> String {
    let (stem, ext) = match path.rfind('.') {
        Some(i) if i > path.rfind('/').map_or(0, |s| s + 1) => (&path[..i], &path[i..]),
        _ => (path, ""),
    };
    let mut n = 1;
    loop {
        let more = if n == 1 { String::new() } else { format!(" {n}") };
        let name = format!("{stem} (from Drive {when}{more}){ext}");
        if taken.insert(name.clone()) { return name; }
        n += 1;
    }
}

/// Stops a plan that would bin many notes at once: more than 10 and more than a fifth of what was synced.
/// A vault on a drive that is not plugged in, or a folder that could not be read, looks like every note deleted.
pub fn brake(acts: &[Act], synced: usize) -> Result<(), String> {
    let (here, there) = acts.iter().fold((0, 0), |(h, t), a| match a {
        Act::BinLocal(_) => (h + 1, t),
        Act::BinRemote(_) => (h, t + 1),
        _ => (h, t),
    });
    for (n, side) in [(here, "on this device"), (there, "on Drive")] {
        if n > 10 && n * 5 > synced {
            return Err(format!("This sync would move {n} notes {side} to the trash. Nothing was changed - check that the vault folder and Drive look right, then confirm."));
        }
    }
    Ok(())
}

/* ── this device: the notes as they are, and the plan run ─────────────── */

fn md5_hex(b: &[u8]) -> String {
    use md5::{Digest, Md5};
    Md5::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Every file in the vault by path, with its MD5 - taken again only when its size or time changed since the last
/// look (`seen`, kept with the sync). Folders and files whose name starts with "." (.trash, .git) are left out.
pub fn local(vault: &Path, seen: &mut BTreeMap<String, (u64, i64, String)>) -> Result<BTreeMap<String, Hash>, String> {
    if !vault.is_dir() { return Err(format!("The vault folder is not there: {}", vault.display())); }
    let mut out = BTreeMap::new();
    let mut stack = vec![vault.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?.flatten() {
            if e.file_name().to_string_lossy().starts_with('.') { continue; }
            let Ok(md) = e.metadata() else { continue };
            let p = e.path();
            if md.is_dir() { stack.push(p); continue; }
            if !md.is_file() { continue; }
            let rel = p.strip_prefix(vault).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
            let hash = match seen.get(&rel) {
                Some((size, t, h)) if *size == md.len() && *t == mtime => h.clone(),
                _ => {
                    let h = md5_hex(&std::fs::read(&p).map_err(|e| format!("could not read {rel}: {e}"))?);
                    seen.insert(rel.clone(), (md.len(), mtime, h.clone()));
                    h
                }
            };
            out.insert(rel, hash);
        }
    }
    seen.retain(|k, _| out.contains_key(k));
    Ok(out)
}

/// A file written whole: to a hidden name beside it, then renamed over, so the app (and a crash) never sees half.
/// A path from Drive that would leave the vault, or land in a hidden folder, is refused.
fn write_whole(vault: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
    if rel.split('/').any(|c| c.is_empty() || c == "." || c == ".." || c.starts_with('.') || c.contains('\\') || c.contains(':')) {
        return Err(format!("refused a path from Drive: {rel}"));
    }
    let to = vault.join(rel);
    if let Some(d) = to.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let tmp = to.with_file_name(format!(".{}.drive-sync", to.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &to).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })
}

/// What was synced, kept in ~/.leonote/drive-sync.json: Leonote's folder on Drive, each path's MD5 at the last
/// sync, and the local fingerprints (size, time, MD5).
#[derive(Default)]
pub struct State { pub root: String, pub last: BTreeMap<String, Hash>, pub seen: BTreeMap<String, (u64, i64, String)> }
impl State {
    pub fn load(p: &Path) -> State {
        let v: Value = std::fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        let empty = serde_json::Map::new();
        let map = |k: &str| v[k].as_object().unwrap_or(&empty).clone();
        State {
            root: v["root"].as_str().unwrap_or("").into(),
            last: map("last").into_iter().filter_map(|(k, h)| Some((k, h.as_str()?.to_string()))).collect(),
            seen: map("seen").into_iter().filter_map(|(k, t)| Some((k, (t[0].as_u64()?, t[1].as_i64()?, t[2].as_str()?.to_string())))).collect(),
        }
    }
    pub fn save(&self, p: &Path) -> Result<(), String> {
        let seen: serde_json::Map<String, Value> = self.seen.iter().map(|(k, (a, b, c))| (k.clone(), json!([a, b, c]))).collect();
        let v = json!({ "root": self.root, "last": self.last, "seen": seen });
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, p).map_err(|e| e.to_string())
    }
}

/// What a sync did, for the user.
#[derive(Default, Debug)]
pub struct Done { pub up: usize, pub down: usize, pub both: usize, pub binned: usize, pub failed: Vec<String> }

fn act_path(a: &Act) -> &str {
    match a { Act::Upload(p) | Act::Download(p) | Act::BinRemote(p) | Act::BinLocal(p) | Act::Same(p) | Act::Forget(p) => p, Act::KeepBoth { path, .. } => path }
}

/// One sync of the vault with Leonote's folder on Drive. `sure`: the user confirmed a plan the brake stopped.
pub fn sync(vault: &Path, state_file: &Path, refresh: &str, when: &str, stamp: &str, sure: bool) -> Result<Done, String> {
    crate::drive::ready()?;
    let token = crate::drive::access(refresh)?;
    let mut st = State::load(state_file);
    let files = crate::drive::list(&token)?;
    if st.root.is_empty() || !files.iter().any(|f| f.id == st.root && f.folder) {
        // Leonote's folder: the one it made before (drive.file sees only those), or a new one
        st.root = match files.iter().find(|f| f.folder && f.name == "Leonote" && !files.iter().any(|g| g.id == f.parent)) {
            Some(f) => f.id.clone(),
            None => crate::drive::make_folder(&token, "Leonote", None)?,
        };
        st.save(state_file)?;
    }
    let (docs, mut dirs) = crate::drive::tree(&files, &st.root);
    let remote: BTreeMap<String, Hash> = docs.iter().map(|(p, f)| (p.clone(), f.md5.clone())).collect();
    let here = local(vault, &mut st.seen)?;
    let acts = plan(&here, &remote, &st.last, when);
    if !sure { brake(&acts, st.last.len())?; }
    let mut done = Done::default();
    let root = st.root.clone();
    // the folder a path goes in, made on Drive when missing
    let mut folder = |rel: &str| -> Result<String, String> {
        let mut at = root.clone();
        let parts: Vec<&str> = rel.split('/').collect();
        for i in 0..parts.len().saturating_sub(1) {
            let key = parts[..=i].join("/");
            at = match dirs.get(&key) {
                Some(id) => id.clone(),
                None => { let id = crate::drive::make_folder(&token, parts[i], Some(&at))?; dirs.insert(key, id.clone()); id }
            };
        }
        Ok(at)
    };
    let name = |rel: &str| rel.rsplit('/').next().unwrap_or(rel).to_string();
    for act in acts {
        let r: Result<(), String> = match &act {
            Act::Upload(p) => (|| {
                let bytes = std::fs::read(vault.join(p)).map_err(|e| e.to_string())?;
                let parent = folder(p)?;
                let (_, md5) = crate::drive::upload(&token, docs.get(p).map(|f| f.id.as_str()), &name(p), &parent, &bytes)?;
                if md5 != md5_hex(&bytes) { return Err("Drive stored something other than what was sent".into()); }
                st.last.insert(p.clone(), md5);
                done.up += 1;
                Ok(())
            })(),
            Act::Download(p) => (|| {
                let f = &docs[p];
                let bytes = crate::drive::download(&token, &f.id)?;
                if md5_hex(&bytes) != f.md5 { return Err("the download did not match Drive's copy".into()); }
                write_whole(vault, p, &bytes)?;
                st.last.insert(p.clone(), f.md5.clone());
                done.down += 1;
                Ok(())
            })(),
            Act::KeepBoth { path, copy } => (|| {
                let f = &docs[path];
                let theirs = crate::drive::download(&token, &f.id)?;
                if md5_hex(&theirs) != f.md5 { return Err("the download did not match Drive's copy".into()); }
                write_whole(vault, copy, &theirs)?; // Drive's version is kept here first, then this one goes up
                let mine = std::fs::read(vault.join(path)).map_err(|e| e.to_string())?;
                let parent = folder(path)?;
                let (_, m1) = crate::drive::upload(&token, Some(&f.id), &name(path), &parent, &mine)?;
                let (_, m2) = crate::drive::upload(&token, None, &name(copy), &parent, &theirs)?;
                st.last.insert(path.clone(), m1);
                st.last.insert(copy.clone(), m2);
                done.both += 1;
                Ok(())
            })(),
            Act::BinRemote(p) => crate::drive::bin(&token, &docs[p].id).map(|_| { st.last.remove(p); done.binned += 1; }),
            Act::BinLocal(p) => crate::vault::trash_file(vault, p, stamp).map(|_| { st.last.remove(p); done.binned += 1; }),
            Act::Same(p) => { st.last.insert(p.clone(), here[p].clone()); Ok(()) }
            Act::Forget(p) => { st.last.remove(p); Ok(()) }
        };
        if let Err(e) = r { done.failed.push(format!("{}: {e}", act_path(&act))); }
        st.save(state_file)?; // after each one: a sync cut short starts again where it was
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn m(v: &[(&str, &str)]) -> BTreeMap<String, Hash> { v.iter().map(|(p, h)| (p.to_string(), h.to_string())).collect() }
    fn one(l: &[(&str, &str)], r: &[(&str, &str)], s: &[(&str, &str)]) -> Act { plan(&m(l), &m(r), &m(s), "2026-11-18 1405").remove(0) }
    const P: &str = "Notes/a.md";

    #[test]
    fn new_notes_go_across() {
        assert_eq!(one(&[(P, "x")], &[], &[]), Act::Upload(P.into()));
        assert_eq!(one(&[], &[(P, "x")], &[]), Act::Download(P.into()));
    }
    #[test]
    fn the_changed_side_wins_when_only_one_changed() {
        assert_eq!(one(&[(P, "new")], &[(P, "old")], &[(P, "old")]), Act::Upload(P.into()));
        assert_eq!(one(&[(P, "old")], &[(P, "new")], &[(P, "old")]), Act::Download(P.into()));
        assert_eq!(one(&[(P, "x")], &[(P, "x")], &[(P, "old")]), Act::Same(P.into()), "both changed the same way");
    }
    #[test]
    fn changed_on_both_sides_keeps_both() {
        let want = Act::KeepBoth { path: P.into(), copy: "Notes/a (from Drive 2026-11-18 1405).md".into() };
        assert_eq!(one(&[(P, "mine")], &[(P, "theirs")], &[(P, "old")]), want);
        assert_eq!(one(&[(P, "mine")], &[(P, "theirs")], &[]), want, "different at the first sync: both kept, neither overwritten");
    }
    #[test]
    fn a_conflict_copy_never_takes_a_name_in_use() {
        let taken = "Notes/a (from Drive 2026-11-18 1405).md";
        let acts = plan(&m(&[(P, "mine"), (taken, "z")]), &m(&[(P, "theirs")]), &m(&[]), "2026-11-18 1405");
        assert!(acts.contains(&Act::KeepBoth { path: P.into(), copy: "Notes/a (from Drive 2026-11-18 1405 2).md".into() }));
        assert_eq!(conflict_name("Notes/v1.2/readme", "w", &mut BTreeSet::new()), "Notes/v1.2/readme (from Drive w)", "a dot in a folder is no extension");
    }
    #[test]
    fn a_deletion_goes_to_the_other_sides_trash() {
        assert_eq!(one(&[], &[(P, "x")], &[(P, "x")]), Act::BinRemote(P.into()));
        assert_eq!(one(&[(P, "x")], &[], &[(P, "x")]), Act::BinLocal(P.into()));
    }
    #[test]
    fn a_change_beats_a_deletion() {
        assert_eq!(one(&[(P, "edited")], &[], &[(P, "x")]), Act::Upload(P.into()), "deleted on Drive, edited here: comes back");
        assert_eq!(one(&[], &[(P, "edited")], &[(P, "x")]), Act::Download(P.into()), "deleted here, edited on Drive: comes back");
    }
    #[test]
    fn the_local_side_hashes_files_and_skips_hidden_ones() {
        let d = std::env::temp_dir().join(format!("leonote-dsync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("Notes")).unwrap();
        std::fs::create_dir_all(d.join(".trash")).unwrap();
        std::fs::write(d.join("Notes/a.md"), "hello").unwrap();
        std::fs::write(d.join(".trash/old.md"), "x").unwrap();
        let mut seen = BTreeMap::new();
        let got = local(&d, &mut seen).unwrap();
        assert_eq!(got.keys().cloned().collect::<Vec<_>>(), ["Notes/a.md"]);
        assert_eq!(got["Notes/a.md"], "5d41402abc4b2a76b9719d911017c592", "the MD5 Drive gives for the same bytes");
        assert!(write_whole(&d, "../escape.md", b"x").is_err() && write_whole(&d, ".git/x", b"x").is_err() && write_whole(&d, "C:/x.md", b"x").is_err(), "paths from Drive stay inside the vault");
        write_whole(&d, "New/b.md", b"hi").unwrap();
        assert_eq!(std::fs::read_to_string(d.join("New/b.md")).unwrap(), "hi");
        let st_file = d.join("state.json");
        let st = State { root: "R".into(), last: m(&[("a.md", "h")]), seen: [("a.md".to_string(), (5u64, 9i64, "h".to_string()))].into_iter().collect() };
        st.save(&st_file).unwrap();
        let back = State::load(&st_file);
        assert_eq!((back.root.as_str(), back.last, back.seen.get("a.md").cloned()), ("R", m(&[("a.md", "h")]), Some((5, 9, "h".to_string()))));
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn gone_from_both_is_forgotten() {
        assert_eq!(one(&[], &[], &[(P, "x")]), Act::Forget(P.into()));
    }
    #[test]
    fn the_brake_stops_a_mass_trashing() {
        let synced: BTreeMap<String, Hash> = (0..40).map(|i| (format!("n{i}.md"), "h".to_string())).collect();
        let none = BTreeMap::new();
        // the vault folder read as empty: every note "deleted here"
        let acts = plan(&none, &synced, &synced, "w");
        assert!(brake(&acts, synced.len()).unwrap_err().contains("40 notes on Drive"));
        // a few deleted on purpose: fine
        let mut most = synced.clone();
        for i in 0..5 { most.remove(&format!("n{i}.md")); }
        assert!(brake(&plan(&most, &synced, &synced, "w"), synced.len()).is_ok());
    }
}
