//! The pure parts of opening a file from outside the vault: which command
//! line arguments are paths, what counts as text, and what the free-name and
//! association helpers produce. Registry writes are not tested - they are one
//! `winreg` call each, and a test would edit the developer's own shell.

use super::clip::{free_name, paste_into};
use super::external::*;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("leonote_external_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_parked_file_the_user_saved_over_is_not_swept() {
    let dir = scratch("park").join("leonote-dropped");
    std::fs::create_dir_all(&dir).unwrap();
    for n in ["worked on.md", "only looked at.md"] { std::fs::write(dir.join(n), "x").unwrap(); }
    mark_parked_edited(&dir.join("worked on.md"));
    sweep_parked(&dir, std::time::SystemTime::now() + std::time::Duration::from_secs(60));
    assert!(dir.join("worked on.md").exists());
    assert!(!dir.join("only looked at.md").exists());
    // anywhere else nothing is marked
    let other = scratch("park2");
    mark_parked_edited(&other.join("a.md"));
    assert!(!other.join(".edited").exists());
}

#[cfg(windows)]
#[test]
fn a_program_beside_leonote_is_not_the_one_run() {
    let (own, on_path) = (scratch("own"), scratch("onpath"));
    for d in [&own, &on_path] { std::fs::write(d.join("git.exe"), "x").unwrap(); }
    let real = std::fs::canonicalize(&own).unwrap();
    assert_eq!(program_in("git", Some(&real), [own.clone(), on_path.clone()].into_iter()), Some(on_path.join("git.exe")));
    assert_eq!(program_in("git", Some(&real), [own.clone()].into_iter()), None);
    let low = |p: PathBuf| p.to_string_lossy().to_lowercase();
    assert!(low(program("cmd")).ends_with("\\system32\\cmd.exe"));
    assert!(low(program("explorer.exe")).ends_with("\\explorer.exe") && program("explorer.exe").is_absolute());
    assert!(low(program("powershell.exe")).ends_with("\\v1.0\\powershell.exe"));
    assert_eq!(program(r"C:\x\tool"), PathBuf::from(r"C:\x\tool"));
    assert!(program("no-such-program-here").is_absolute(), "found nowhere: fails to start, never a bare name for Windows to look for");
}

#[test]
fn argv_keeps_only_existing_files() {
    let dir = scratch("argv");
    std::fs::write(dir.join("note.md"), "hi").unwrap();
    std::fs::create_dir(dir.join("sub")).unwrap();
    let here = dir.join("note.md").to_string_lossy().into_owned();
    let got = file_args(
        &args(&[
            "C:\\Program Files\\LeoNote\\LeoNote.exe", // the program itself is never a document
            "--hidden",                                // flags out
            &here,
            &dir.join("gone.md").to_string_lossy(),    // not on disk
            &dir.join("sub").to_string_lossy(),        // a folder is not a file
        ]),
        &dir,
    );
    assert_eq!(got, vec![PathBuf::from(&here)]);
}

#[test]
fn argv_resolves_a_relative_path_against_the_launch_folder() {
    let dir = scratch("argv_rel");
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    let got = file_args(&args(&["leonote.exe", "a.txt"]), &dir);
    assert_eq!(got.len(), 1);
    assert!(got[0].is_absolute());
    assert!(got[0].ends_with("a.txt"));
}

#[test]
fn argv_with_no_documents_is_empty() {
    let dir = scratch("argv_none");
    assert!(file_args(&args(&["leonote.exe"]), &dir).is_empty());
    assert!(file_args(&args(&["leonote.exe", "--hidden"]), &dir).is_empty());
}

#[test]
fn binary_bytes_are_refused_but_text_and_unicode_are_not() {
    assert!(looks_binary(b"MZ\x90\x00\x03"));
    assert!(looks_binary(&[0x50, 0x4b, 0x03, 0x04, 0x00])); // a zip (.docx renamed .md)
    assert!(!looks_binary("# Heading\n\nсловник · 日本語\n".as_bytes()));
    assert!(!looks_binary(b""));
    // a NUL past the sniffed block is not worth a second read
    let mut late = vec![b'a'; 9000];
    late.push(0);
    assert!(!looks_binary(&late));
}

#[test]
fn kinds_decide_which_editor_opens() {
    assert_eq!(kind_of("README.md"), "note");
    assert_eq!(kind_of("notes.txt"), "note"); // NOTE_EXTS, the same list the vault uses
    assert_eq!(kind_of("main.rs"), "text");
    assert_eq!(kind_of("data.csv"), "text");
    assert_eq!(kind_of("shot.png"), "image");
    assert_eq!(kind_of("deck.pptx"), "office");
    assert!(can_edit("a.md") && can_edit("a.json"));
    assert!(!can_edit("a.png") && !can_edit("a.zip"));
}

#[test]
fn the_size_ceiling_is_eight_megabytes() {
    assert_eq!(MAX_TEXT, 8 * 1024 * 1024);
}

#[test]
fn importing_never_overwrites_a_name_already_in_the_folder() {
    let dir = scratch("free");
    std::fs::write(dir.join("Notes.md"), "one").unwrap();
    let second = free_name(&dir, "Notes.md");
    assert_eq!(second.file_name().unwrap(), "Notes 2.md");
    std::fs::write(&second, "two").unwrap();
    assert_eq!(free_name(&dir, "Notes.md").file_name().unwrap(), "Notes 3.md");
    assert_eq!(std::fs::read_to_string(dir.join("Notes.md")).unwrap(), "one");
}

#[test]
fn extensions_are_normalized_and_prog_ids_are_per_extension() {
    assert_eq!(clean_exts(&args(&[".MD", "md", " txt ", "", "../evil", "a b"])), vec!["md", "txt"]);
    assert_eq!(prog_id("md"), "LeoNote.md");
    assert_eq!(ext_label("md"), "Markdown note");
    assert_eq!(ext_label("txt"), "Text note");
    assert_eq!(ext_label("rs"), "RS file (Leonote)");
}

#[test]
fn srt_becomes_captions() {
    use crate::external::parse_srt;
    let s = "1\r\n00:00:00,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:00:02,500 --> 00:01:03,250\r\nsecond line\r\nwrapped\r\n\r\n";
    let c = parse_srt(s);
    assert_eq!(c.len(), 2);
    assert_eq!(c[0]["start"].as_f64(), Some(0.0));
    assert_eq!(c[0]["end"].as_f64(), Some(2.5));
    assert_eq!(c[1]["end"].as_f64(), Some(63.25));
    assert_eq!(c[1]["text"], "second line wrapped");
}

#[test]
fn the_dot_folders_are_searched_by_name() {
    let root = std::env::temp_dir().join(format!("leonote-dotfind-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".leonote").join("log")).unwrap();
    std::fs::create_dir_all(root.join("Notes")).unwrap();
    std::fs::write(root.join(".leonote").join("ids.json"), "{}").unwrap();
    std::fs::write(root.join(".leonote").join("log").join("ids-old.jsonl"), "").unwrap();
    std::fs::write(root.join("Notes").join("ids.json"), "{}").unwrap();
    let mut got: Vec<String> = crate::external::find_in_dot_folders(&root, "IDS", 10).iter().map(|v| v["path"].as_str().unwrap().to_string()).collect();
    got.sort();
    // only inside the dot-folders, at any depth
    assert_eq!(got, vec![".leonote/ids.json", ".leonote/log/ids-old.jsonl"]);
    assert!(crate::external::find_in_dot_folders(&root, "  ", 10).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_installers_failure_is_said_in_its_own_last_words() {
    // winget draws a spinner and progress bars with carriage returns; the message is what is left
    let out = "Found ffmpeg [Gyan.FFmpeg]\r\n  -\r  \\r  |\r\n  ██████████  1.20 MB / 18.0 MB\r\nInstaller hash does not match; this cannot be overridden when running as admin\r\n  -\r\n";
    assert_eq!(last_words(out), "Installer hash does not match; this cannot be overridden when running as admin");
    assert_eq!(last_words("  -\r  \\r  |\r\n"), "");
}

#[test]
fn not_indexed_folders_give_their_note_names_without_reading_them() {
    let root = scratch("unindexed_names");
    std::fs::create_dir_all(root.join("Heavy/Deep")).unwrap();
    std::fs::write(root.join("Heavy/a.md"), "x").unwrap();
    std::fs::write(root.join("Heavy/Deep/b.md"), "x").unwrap();
    std::fs::write(root.join("Heavy/log.json"), "x").unwrap();
    std::fs::write(root.join("Heavy/.hidden.md"), "x").unwrap();
    let mut got = names_unindexed(&root, &["Heavy".to_string()]);
    got.sort();
    assert_eq!(got, ["Heavy/Deep/b.md", "Heavy/a.md"]);
}

#[test]
fn a_download_that_differs_from_its_fingerprint_is_refused() {
    let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert!(check_sha256(b"abc", abc).is_ok());
    assert!(check_sha256(b"abc", &abc.to_uppercase()).is_ok(), "Edge writes them in capitals");
    assert!(check_sha256(b"abd", abc).unwrap_err().contains("fingerprint"));
    assert!(check_sha256(b"abc", "").is_err());
}

// on every system, not only Windows: Homebrew's Whisper fetches its model through this too
#[test]
fn the_fingerprint_is_real_sha256_at_every_length() {
    assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    assert_eq!(sha256_hex(&vec![b'a'; 1_000_000]), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    #[cfg(windows)]
    for len in 0..200 {
        use windows::Win32::Security::Cryptography::{BCryptHash, BCRYPT_SHA256_ALG_HANDLE};
        let data = vec![b'x'; len];
        let mut out = [0u8; 32];
        unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, &data, &mut out) }.ok().unwrap();
        assert_eq!(sha256_hex(&data), out.iter().map(|b| format!("{b:02x}")).collect::<String>(), "length {len}");
    }
}

#[test]
fn every_direct_download_is_pinned() {
    let model = (crate::external::WHISPER_MODEL.0, "", crate::external::WHISPER_MODEL.1);
    for (url, _, sha) in ["ffmpeg", "whisper"].iter().filter_map(|t| tool_source(t)).chain(EXTRA_TOOLS.iter().map(|t| t.source)).chain([model]) {
        assert!(url.starts_with("https://") && !url.contains("/latest/") && !url.contains("/resolve/main/"), "{url}");
        assert!(sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()), "{url}");
    }
}

#[test]
fn a_tool_is_known_or_refused() {
    assert!(tool_source("ffmpeg").is_some() && tool_source("unknown").is_none());
}

#[test]
fn pastes_at_the_same_moment_each_get_their_own_name() {
    let dir = std::env::temp_dir().join(format!("leonote_paste_race_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("to")).unwrap();
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    let all: Vec<_> = (0..8).map(|_| { let d = dir.clone(); std::thread::spawn(move || paste_into(&d, &d.join("to"), &[d.join("a.txt")]).unwrap().0) }).collect();
    let mut names: Vec<String> = all.into_iter().flat_map(|t| t.join().unwrap()).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 8);
    let _ = std::fs::remove_dir_all(&dir);
}
