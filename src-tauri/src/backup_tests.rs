//! Tests for encrypted backup and restore.
//!
//! Hermetic: every test owns a temp root with its own home, vault and output
//! folder, so nothing here reads or writes the user's real data.

use super::backup::*;
use super::datadir::{self, Items};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const PW: &str = "correct horse battery";
const STAMP: &str = "2026-09-17 101500";
const NOW: &str = "2026-09-17T10:15:00.000";

/// One simulated device: a home, a vault and the data layout of one mode.
struct Device {
    home: PathBuf,
    vault: PathBuf,
    settings: PathBuf,
    it: Items,
}

#[cfg(windows)]
#[test]
fn an_archive_entry_cannot_reach_a_dot_folder_by_another_name() {
    let r = root("shortname");
    std::fs::create_dir_all(r.join(".git/hooks")).unwrap();
    // a junction stands in for the short name GIT~1
    assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(r.join("GIT~1")).arg(r.join(".git")).output().unwrap().status.success());
    assert!(lands_hidden(&r, Path::new("GIT~1/hooks/post-checkout")));
    assert!(lands_hidden(&r, Path::new(".git/config")));
    assert!(!lands_hidden(&r, Path::new("Docs/Report~2.pdf")), "a real name with a ~ is unpacked");
}

fn root(name: &str) -> PathBuf {
    let r = std::env::temp_dir().join(format!("leonote_backup_{}", name));
    let _ = std::fs::remove_dir_all(&r);
    std::fs::create_dir_all(r.join("out")).unwrap();
    r
}

fn device(root: &Path, name: &str, mode: &str) -> Device {
    let home = root.join(name).join("home");
    let vault = root.join(name).join("vault");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&vault).unwrap();
    let user_dir = home.join(".leonote");
    let it = datadir::items(mode, &home, &user_dir, &home.join(".leonote_tasks.json"), &vault);
    Device { settings: user_dir.join("app.json"), home, vault, it }
}

fn put(p: &Path, body: &[u8]) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

fn seed(d: &Device, tag: &str) {
    put(&d.it.snapshot, format!("[\"{}-tasks\"]", tag).as_bytes());
    put(&d.it.dir.join("base.snapshot.json"), format!("[\"{}-base\"]", tag).as_bytes());
    put(&d.it.dir.join("log/ui.jsonl"), format!("{}-ui\n", tag).as_bytes());
    put(&d.it.habits, format!("{}-habits", tag).as_bytes());
    put(&d.it.recurring, format!("{}-recurring", tag).as_bytes());
    put(&d.it.priorities, format!("{}-priorities", tag).as_bytes());
    put(&d.it.stats, format!("{}-stats", tag).as_bytes());
    put(&d.it.positions, format!("{}-positions", tag).as_bytes());
    put(&d.it.graph, format!("{}-graph", tag).as_bytes());
    put(&d.it.fit, format!("{}-fit", tag).as_bytes());
}

fn assert_data(d: &Device, tag: &str) {
    assert_eq!(read(&d.it.snapshot), format!("[\"{}-tasks\"]", tag));
    assert_eq!(read(&d.it.dir.join("base.snapshot.json")), format!("[\"{}-base\"]", tag));
    assert_eq!(read(&d.it.dir.join("log/ui.jsonl")), format!("{}-ui\n", tag));
    assert_eq!(read(&d.it.habits), format!("{}-habits", tag));
    assert_eq!(read(&d.it.recurring), format!("{}-recurring", tag));
    assert_eq!(read(&d.it.priorities), format!("{}-priorities", tag));
    assert_eq!(read(&d.it.stats), format!("{}-stats", tag));
    assert_eq!(read(&d.it.positions), format!("{}-positions", tag));
    assert_eq!(read(&d.it.graph), format!("{}-graph", tag));
    assert_eq!(read(&d.it.fit), format!("{}-fit", tag));
}

fn export_from(d: &Device, out: &Path, vault: bool) -> BackupSummary {
    let root = vault.then_some(d.vault.as_path());
    export(out, PW, &d.it, &d.settings, root, &Mutex::new(()), NOW).expect("export")
}

fn import_into(d: &Device, backup: &Path, pw: &str, vault: bool) -> Result<BackupSummary, String> {
    let root = vault.then_some(d.vault.as_path());
    import(backup, pw, &d.it, &d.settings, root, &Mutex::new(()), &Mutex::new(()), STAMP)
}

fn before_dirs(d: &Device) -> Vec<PathBuf> {
    std::fs::read_dir(&d.it.dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("before-restore-"))
                .collect()
        })
        .unwrap_or_default()
}

/// No decrypted or half-written temp may outlive a call.
fn assert_no_temps(dir: &Path) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        assert!(!(n.starts_with('.') && n.ends_with(".tmp")), "temp left behind: {}", n);
    }
}

#[test]
fn data_round_trip_across_modes_keeps_device_settings() {
    let r = root("data_round_trip");
    // user mode on one machine, vault mode (other names on disk) on the other
    let a = device(&r, "a", datadir::USER);
    let b = device(&r, "b", datadir::VAULT);
    seed(&a, "A");
    put(&a.settings, br#"{"theme":"dark","vault":"C:/A","windowWidth":900,"compactSidebar":false,"font":14}"#);
    seed(&b, "B");
    put(&b.it.dir.join("log/agent.jsonl"), b"B-agent\n");
    put(&b.settings, br#"{"vault":"D:/B","dataDir":"vault","compactSidebar":true,"theme":"light","onlyHere":1}"#);

    let out = r.join("out/a.leonotebackup");
    let s = export_from(&a, &out, false);
    assert!(s.bytes > 0 && out.is_file());
    assert_eq!(s.vault_files, 0);
    assert_no_temps(&r.join("out"));
    // encrypted: no plaintext of ours anywhere in the file
    let raw = std::fs::read(&out).unwrap();
    assert!(raw.starts_with(b"age-encryption.org/v1"));
    assert!(!raw.windows(8).any(|w| w == b"A-habits"));

    let m = peek(&out, PW).expect("peek");
    assert_eq!(m.format, "leonote-backup");
    assert_eq!(m.version, 1);
    assert_eq!(m.created, NOW);
    assert_eq!(m.app_version, env!("CARGO_PKG_VERSION"));
    assert!(!m.includes_vault);
    assert_eq!(m.vault_files, 0);
    for n in ["tasks.json", "base.snapshot.json", "habits.json", "stats.json", "positions.json", "log/ui.jsonl"] {
        assert!(m.data_files.iter().any(|f| f == n), "manifest lists {}", n);
    }
    assert_eq!(s.data_files, m.data_files);
    assert!(m.bytes > 0);

    let got = import_into(&b, &out, PW, false).expect("import");
    assert_no_temps(&r.join("out"));
    assert_data(&b, "A");
    // the log is replaced as a whole: B's own writer is gone from it...
    assert!(!b.it.dir.join("log/agent.jsonl").exists());
    // ...and set aside, with every other file, under the stable names
    let before = PathBuf::from(got.before_restore.clone().unwrap());
    assert_eq!(before_dirs(&b), vec![before.clone()]);
    assert_eq!(read(&before.join("log/agent.jsonl")), "B-agent\n");
    assert_eq!(read(&before.join("log/ui.jsonl")), "B-ui\n");
    assert_eq!(read(&before.join("tasks.json")), "[\"B-tasks\"]");
    assert_eq!(read(&before.join("base.snapshot.json")), "[\"B-base\"]");
    assert_eq!(read(&before.join("habits.json")), "B-habits");
    assert_eq!(read(&before.join("positions.json")), "B-positions");
    assert!(read(&before.join("app.json")).contains("\"light\""));

    let cfg: Value = serde_json::from_str(&read(&b.settings)).unwrap();
    assert_eq!(
        cfg,
        json!({"vault":"D:/B","dataDir":"vault","compactSidebar":true,"theme":"dark","onlyHere":1,"font":14})
    );
    assert!(cfg.get("windowWidth").is_none(), "window geometry is this screen's");
    assert_eq!(got.created, NOW);
    assert_eq!(got.vault_files, 0);
}

#[test]
fn vault_round_trip_trashes_differing_and_skips_identical() {
    let r = root("vault_round_trip");
    // vault mode: the data root sits inside the vault and must stay out
    let a = device(&r, "a", datadir::VAULT);
    seed(&a, "A");
    put(&a.vault.join("Welcome.md"), b"# from A");
    put(&a.vault.join("Docs/same.md"), b"same bytes");
    put(&a.vault.join("img/pic.png"), &[0u8, 159, 146, 150, 255, 0, 1]);
    std::fs::create_dir_all(a.vault.join("Empty")).unwrap();
    put(&a.vault.join(".obsidian/app.json"), b"{}");
    put(&a.vault.join(".trash/old.md"), b"old");
    put(&a.vault.join(".Welcome.md.tmp"), b"half");

    let out = r.join("out/v.leonotebackup");
    let s = export_from(&a, &out, true);
    assert_eq!(s.vault_files, 3);
    assert!(s.skipped.is_empty());
    let m = peek(&out, PW).unwrap();
    assert!(m.includes_vault);
    assert_eq!(m.vault_files, 3);

    let b = device(&r, "b", datadir::VAULT_HIDDEN);
    seed(&b, "B");
    put(&b.vault.join("Welcome.md"), b"# B's own welcome");
    put(&b.vault.join("Docs/same.md"), b"same bytes");
    put(&b.vault.join("Mine.md"), b"only on B");

    let got = import_into(&b, &out, PW, true).expect("import");
    assert_data(&b, "A");
    // read in place: nothing decrypted was ever written beside the backup (a cloud folder would copy it away)
    let beside: Vec<_> = std::fs::read_dir(out.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(beside, [std::ffi::OsString::from("v.leonotebackup")]);
    assert_eq!(got.vault_files, 2, "Welcome.md and pic.png written");
    assert_eq!(got.vault_unchanged, 1);
    assert_eq!(got.vault_replaced, 1);
    assert!(got.skipped.is_empty(), "{:?}", got.skipped);
    assert_eq!(read(&b.vault.join("Welcome.md")), "# from A");
    assert_eq!(read(&b.vault.join(format!(".trash/{} Welcome.md", STAMP))), "# B's own welcome");
    assert_eq!(std::fs::read(b.vault.join("img/pic.png")).unwrap(), vec![0u8, 159, 146, 150, 255, 0, 1]);
    assert!(b.vault.join("Empty").is_dir());
    assert_eq!(read(&b.vault.join("Mine.md")), "only on B");
    // nothing from A's hidden or data folders came along
    assert!(!b.vault.join(".obsidian").exists());
    assert!(!b.vault.join(".trash/old.md").exists());
    assert!(!b.vault.join("LeoNote").exists());
    // only the replaced note went to the trash; the identical one stayed put
    let trash: Vec<_> = std::fs::read_dir(b.vault.join(".trash")).unwrap().flatten().collect();
    assert_eq!(trash.len(), 1);
    assert_no_temps(&b.vault);
    assert_no_temps(&r.join("out"));
}

#[test]
fn data_only_backup_leaves_the_vault_alone() {
    let r = root("data_only_vault");
    let a = device(&r, "a", datadir::USER);
    seed(&a, "A");
    put(&a.vault.join("Welcome.md"), b"# A");
    let out = r.join("out/d.leonotebackup");
    export_from(&a, &out, false);

    let b = device(&r, "b", datadir::USER);
    put(&b.vault.join("Welcome.md"), b"# B");
    let got = import_into(&b, &out, PW, true).unwrap();
    assert_eq!(got.vault_files, 0);
    assert_eq!(read(&b.vault.join("Welcome.md")), "# B");
    assert!(!b.vault.join(".trash").exists());
    assert_data(&b, "A");
}

#[test]
fn restore_without_vault_ignores_the_vault_in_the_backup() {
    let r = root("skip_vault");
    let a = device(&r, "a", datadir::USER);
    put(&a.vault.join("Welcome.md"), b"# A");
    let out = r.join("out/v.leonotebackup");
    export_from(&a, &out, true);
    let b = device(&r, "b", datadir::USER);
    let got = import_into(&b, &out, PW, false).unwrap();
    assert_eq!(got.vault_files, 0);
    assert!(!b.vault.join("Welcome.md").exists());
}

#[test]
fn wrong_password_is_reported_and_changes_nothing() {
    let r = root("wrong_password");
    let a = device(&r, "a", datadir::USER);
    seed(&a, "A");
    let out = r.join("out/a.leonotebackup");
    export_from(&a, &out, false);

    assert_eq!(peek(&out, "not the password").unwrap_err(), "wrong password");
    let b = device(&r, "b", datadir::USER);
    seed(&b, "B");
    assert_eq!(import_into(&b, &out, "not the password", false).unwrap_err(), "wrong password");
    assert_data(&b, "B");
    assert!(before_dirs(&b).is_empty());
    assert_no_temps(&r.join("out"));
}

#[test]
fn garbage_is_not_a_backup() {
    let r = root("garbage");
    let junk = r.join("out/junk.leonotebackup");
    put(&junk, b"PK\x03\x04 this is not an age file at all, just some bytes");
    assert_eq!(peek(&junk, PW).unwrap_err(), "not a Leonote backup");
    let empty = r.join("out/empty.leonotebackup");
    put(&empty, b"");
    assert_eq!(peek(&empty, PW).unwrap_err(), "not a Leonote backup");

    // a genuine age file, right password, but not our zip inside
    let foreign = r.join("out/foreign.leonotebackup");
    seal(b"hello, not a zip", &foreign, PW);
    assert_eq!(peek(&foreign, PW).unwrap_err(), "not a Leonote backup");
    let b = device(&r, "b", datadir::USER);
    seed(&b, "B");
    assert_eq!(import_into(&b, &foreign, PW, false).unwrap_err(), "not a Leonote backup");
    assert_eq!(import_into(&b, &junk, PW, false).unwrap_err(), "not a Leonote backup");
    assert_data(&b, "B");
    assert!(before_dirs(&b).is_empty());

    // a damaged payload: the header still checks out, the data does not
    let a = device(&r, "a", datadir::USER);
    seed(&a, "A");
    let out = r.join("out/a.leonotebackup");
    export_from(&a, &out, false);
    let mut raw = std::fs::read(&out).unwrap();
    let n = raw.len();
    raw[n - 20] ^= 0xff;
    std::fs::write(&out, &raw).unwrap();
    assert_eq!(import_into(&b, &out, PW, false).unwrap_err(), "not a Leonote backup");
    assert!(before_dirs(&b).is_empty());
    assert_no_temps(&r.join("out"));
}

/// A zip made by hand, as an attacker would, then sealed with the password.
fn hand_made(out: &Path, entries: &[(&str, &[u8])]) {
    use zip::write::SimpleFileOptions;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let o = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, body) in entries {
            z.start_file(*name, o).unwrap();
            z.write_all(body).unwrap();
        }
        z.finish().unwrap();
    }
    seal(buf.get_ref(), out, PW);
}

fn manifest_json(version: u32) -> Vec<u8> {
    json!({"format":"leonote-backup","version":version,"created":NOW,"includes_vault":true}).to_string().into_bytes()
}

#[test]
fn zip_slip_entries_are_refused_before_anything_is_written() {
    let r = root("zip_slip");
    let b = device(&r, "b", datadir::USER);
    seed(&b, "B");
    let m = manifest_json(1);
    for (i, evil) in ["vault/../evil.md", "vault/..\\evil.md", "/abs.md", "C:/x.md", "data/log/../../evil.json"]
        .iter()
        .enumerate()
    {
        let out = r.join(format!("out/slip{}.leonotebackup", i));
        hand_made(&out, &[("manifest.json", &m), ("data/habits.json", b"evil"), (evil, b"pwned")]);
        // the manifest alone is fine, so peek still describes the file
        assert!(peek(&out, PW).unwrap().includes_vault);
        let err = import_into(&b, &out, PW, true).unwrap_err();
        assert!(err.starts_with("unsafe path in backup"), "{}: {}", evil, err);
    }
    assert_data(&b, "B");
    assert!(before_dirs(&b).is_empty());
    assert!(!r.join("b/evil.md").exists() && !b.home.join("evil.json").exists());

    for ok in ["manifest.json", "vault/a/b.md", "vault/Empty/", "data/log/ui.jsonl"] {
        assert!(safe_entry_name(ok), "{}", ok);
    }
    for bad in ["", "/a", "a/../b", "..", "./a", "a//b", "a\\b", "C:/a", "a/b.md:stream", "a/\u{1}", "/"] {
        assert!(!safe_entry_name(bad), "{:?}", bad);
    }
}

#[test]
fn vault_entries_cannot_reach_hidden_or_data_folders() {
    let r = root("vault_guard");
    // vault mode: <vault>/LeoNote is our data root and must not be written
    let b = device(&r, "b", datadir::VAULT);
    seed(&b, "B");
    let out = r.join("out/g.leonotebackup");
    hand_made(
        &out,
        &[
            ("manifest.json", &manifest_json(1)),
            ("vault/.obsidian/plugins.json", b"x"),
            ("vault/LeoNote/tasks.json", b"[\"evil\"]"),
            ("vault/ok.md", b"fine"),
        ],
    );
    let got = import_into(&b, &out, PW, true).unwrap();
    assert_eq!(got.vault_files, 1);
    assert_eq!(got.skipped, vec![".obsidian/plugins.json".to_string(), "LeoNote/tasks.json".to_string()]);
    assert_eq!(read(&b.vault.join("ok.md")), "fine");
    assert!(!b.vault.join(".obsidian").exists());
    // data files were replaced by the backup's (none), never by a vault entry
    assert_ne!(read(&b.it.snapshot), "[\"evil\"]");
}

#[test]
fn newer_or_foreign_manifests_are_refused() {
    let r = root("manifest_version");
    let b = device(&r, "b", datadir::USER);
    seed(&b, "B");
    let newer = r.join("out/newer.leonotebackup");
    hand_made(&newer, &[("manifest.json", &manifest_json(2))]);
    assert!(peek(&newer, PW).unwrap_err().contains("newer Leonote"));
    assert!(import_into(&b, &newer, PW, false).unwrap_err().contains("newer Leonote"));

    let other = r.join("out/other.leonotebackup");
    hand_made(&other, &[("manifest.json", br#"{"format":"something-else","version":1}"#)]);
    assert_eq!(peek(&other, PW).unwrap_err(), "not a Leonote backup");
    // manifest missing entirely
    let none = r.join("out/none.leonotebackup");
    hand_made(&none, &[("data/habits.json", b"x")]);
    assert_eq!(peek(&none, PW).unwrap_err(), "not a Leonote backup");
    assert_eq!(import_into(&b, &none, PW, false).unwrap_err(), "not a Leonote backup");
    assert_data(&b, "B");
    assert!(before_dirs(&b).is_empty());
}

#[test]
fn export_refuses_short_passwords_and_bad_paths() {
    let r = root("export_checks");
    let a = device(&r, "a", datadir::USER);
    let io = Mutex::new(());
    let out = r.join("out/a.leonotebackup");
    let err = export(&out, "short7!", &a.it, &a.settings, None, &io, NOW).unwrap_err();
    assert!(err.contains("at least 8"), "{}", err);
    assert!(!out.exists());
    assert!(export(Path::new("relative.leonotebackup"), PW, &a.it, &a.settings, None, &io, NOW).is_err());
    assert!(export(&r.join("missing/a.leonotebackup"), PW, &a.it, &a.settings, None, &io, NOW).is_err());
    assert!(export(&r.join("out"), PW, &a.it, &a.settings, None, &io, NOW).is_err());
    // eight characters is enough, and an empty device still makes a backup
    let s = export(&out, "12345678", &a.it, &a.settings, None, &io, NOW).unwrap();
    assert!(s.data_files.is_empty());
    assert!(peek(&out, "12345678").unwrap().data_files.is_empty());
    assert_no_temps(&r.join("out"));
}

#[test]
fn a_second_restore_gets_its_own_before_folder() {
    let r = root("second_restore");
    let a = device(&r, "a", datadir::USER);
    seed(&a, "A");
    let out = r.join("out/a.leonotebackup");
    export_from(&a, &out, false);
    let b = device(&r, "b", datadir::USER);
    seed(&b, "B");
    let first = import_into(&b, &out, PW, false).unwrap().before_restore.unwrap();
    let second = import_into(&b, &out, PW, false).unwrap().before_restore.unwrap();
    assert_ne!(first, second);
    assert_eq!(read(&Path::new(&first).join("habits.json")), "B-habits");
    assert_eq!(read(&Path::new(&second).join("habits.json")), "A-habits");
    assert_data(&b, "A");
}

#[test]
fn settings_merge_keeps_device_keys_as_they_are() {
    let ours = json!({"vault":"D:/B","windowX":5,"theme":"light"});
    let theirs = json!({"vault":"C:/A","dataDir":"vault","windowX":1,"windowY":2,"compactMode":true,"theme":"dark","lang":"uk"});
    assert_eq!(merge_settings(&ours, &theirs), json!({"vault":"D:/B","windowX":5,"theme":"dark","lang":"uk"}));
    assert_eq!(merge_settings(&Value::Null, &json!({"a":1})), json!({"a":1}));
    // a backup someone sent: its command lines, allowed sites and sign-in never replace this computer's own
    let mine = json!({"aiProviders":[{"id":"c","kind":"cli","base":"claude -p"}],"downloadHosts":["a.example"]});
    let sent = json!({"aiProviders":[{"id":"c","kind":"cli","base":"cmd /c evil"}],"downloadHosts":["evil.example"],"googleClientId":"x","theme":"dark"});
    assert_eq!(merge_settings(&mine, &sent), json!({"aiProviders":[{"id":"c","kind":"cli","base":"claude -p"}],"downloadHosts":["a.example"],"theme":"dark"}));
    // nor the folders Leonote may reach: a backup cannot link one
    let sent = json!({"outposts":[{"path":"C:/Users/Someone"}],"playerLibraries":[{"path":"C:/Users"}],"pcSearchRoots":["C:/"],"theme":"dark"});
    assert_eq!(merge_settings(&json!({"outposts":[{"path":"E:/Music"}]}), &sent), json!({"outposts":[{"path":"E:/Music"}],"theme":"dark"}));
}

#[test]
fn every_compression_round_trips_and_smallest_is_smallest() {
    let r = root("pack");
    let a = device(&r, "a", "user");
    seed(&a, "a");
    // text that compresses: a long, repetitive note
    let note: String = (0..4000).map(|i| format!("- line {} about the same research topic
", i % 50)).collect();
    put(&a.vault.join("Long.md"), note.as_bytes());
    let mut sizes = Vec::new();
    for (i, pack) in [Pack::Fast, Pack::Balanced, Pack::Smallest].into_iter().enumerate() {
        let out = r.join("out").join(format!("{}.leonotebackup", i));
        let s = export_packed(&out, PW, &a.it, &a.settings, Some(&a.vault), &Mutex::new(()), NOW, pack).expect("export");
        sizes.push(s.bytes);
        let m = peek(&out, PW).expect("peek");
        assert_eq!(m.compression, ["fast", "balanced", "smallest"][i]);
        let b = device(&r, &format!("b{}", i), "user");
        import_into(&b, &out, PW, true).expect("import");
        assert_eq!(read(&b.vault.join("Long.md")), note);
        assert_data(&b, "a");
    }
    assert!(sizes[2] < sizes[1], "smallest {} should beat balanced {}", sizes[2], sizes[1]);
    assert!(Pack::parse(Some("huge")).is_err());
    assert_eq!(Pack::parse(None).unwrap(), Pack::Balanced);
}

#[test]
fn the_vault_settings_travel_with_an_encrypted_backup() {
    let r = root("vault_settings");
    let a = device(&r, "a", datadir::USER);
    seed(&a, "A");
    let sa = crate::settings::vault_file(&a.vault);
    put(&sa, br#"{"theme":"dark","backupPlans":[{"id":"p1"}],"vault":"C:/A"}"#);
    put(&sa.with_file_name("state.json"), br#"{"spaces":[{"id":"s1"}]}"#);
    let out = r.join("out/s.leonotebackup");
    export_from(&a, &out, true);

    let b = device(&r, "b", datadir::USER);
    let sb = crate::settings::vault_file(&b.vault);
    put(&sb, br#"{"theme":"light","vault":"D:/B"}"#);
    import_into(&b, &out, PW, true).unwrap();
    let got: serde_json::Value = serde_json::from_str(&read(&sb)).unwrap();
    assert_eq!(got["theme"], "dark", "the look comes back");
    assert_eq!(got["backupPlans"][0]["id"], "p1");
    assert_eq!(got["vault"], "D:/B", "this computer keeps its own vault");
    let st: serde_json::Value = serde_json::from_str(&read(&sb.with_file_name("state.json"))).unwrap();
    assert_eq!(st["spaces"][0]["id"], "s1");
}

#[test]
fn the_vault_settings_travel_without_the_notes_too() {
    let r = root("vault_settings_data_only");
    let a = device(&r, "a", datadir::USER);
    seed(&a, "A");
    put(&crate::settings::vault_file(&a.vault), br#"{"theme":"dark"}"#);
    let out = r.join("out/d.leonotebackup");
    export_from(&a, &out, false);
    let b = device(&r, "b", datadir::USER);
    import_into(&b, &out, PW, false).unwrap();
    let got: serde_json::Value = serde_json::from_str(&read(&crate::settings::vault_file(&b.vault))).unwrap();
    assert_eq!(got["theme"], "dark", "a tasks-and-settings backup brings the settings");
}
