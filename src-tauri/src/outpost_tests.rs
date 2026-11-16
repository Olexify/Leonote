//! Outposts: what counts as inside one, what a listing and a name search
//! return, and which names and folders are refused. The Recycle Bin and the
//! asset scope are Windows and Tauri calls and are not exercised here.

use super::outpost::*;
use serde_json::json;
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("leonote_outpost_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn names(v: &serde_json::Value, key: &str) -> Vec<String> {
    let mut n: Vec<String> = v[key].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect();
    n.sort();
    n
}

#[test]
fn inside_is_by_whole_segments() {
    let root = scratch("under");
    assert!(is_under(&root.join("a/b.mp3"), &root));
    assert!(is_under(&root, &root));
    let sibling = PathBuf::from(format!("{}2", root.to_string_lossy()));
    assert!(!is_under(&sibling.join("x"), &root));
    assert!(!is_under(&root.join("a/../../x"), &root));
    assert!(!is_under(root.parent().unwrap(), &root));
}

#[cfg(windows)]
#[test]
fn windows_spellings_of_one_path_agree() {
    assert_eq!(plain(Path::new(r"\\?\E:\Music\")), PathBuf::from(r"E:\Music"));
    assert_eq!(plain(Path::new("E:/Music/Car")), PathBuf::from(r"E:\Music\Car"));
    assert_eq!(plain(Path::new("E:")), PathBuf::from("E:\\"));
    assert_eq!(plain(Path::new(r"\\?\UNC\nas\share\")), PathBuf::from(r"\\nas\share"));
    assert!(is_under(Path::new(r"e:\music\car\a.mp3"), Path::new(r"E:\Music")));
    assert!(is_under(Path::new(r"E:\x"), Path::new("E:\\")));
}

#[test]
fn the_deepest_root_wins_and_strangers_have_none() {
    let root = scratch("rootof");
    let roots = vec![root.clone(), root.join("Deep")];
    assert_eq!(root_of(&roots, &root.join("Deep/x.mp3")), Some(root.join("Deep")));
    assert_eq!(root_of(&roots, &root.join("x.mp3")), Some(root.clone()));
    assert_eq!(root_of(&roots, &std::env::temp_dir().join("elsewhere.mp3")), None);
    assert_eq!(root_of(&roots, Path::new("relative/x.mp3")), None);
}

#[test]
fn the_vault_and_what_surrounds_it_cannot_be_outposts() {
    let base = scratch("checknew");
    let vault = base.join("Vault");
    std::fs::create_dir_all(vault.join("Notes")).unwrap();
    std::fs::create_dir_all(base.join("Music")).unwrap();
    std::fs::write(base.join("file.txt"), b"x").unwrap();
    assert!(check_new(&base.join("Music"), &vault).is_ok());
    assert!(check_new(&vault, &vault).is_err());
    assert!(check_new(&vault.join("Notes"), &vault).is_err());
    assert!(check_new(&base, &vault).is_err());
    assert!(check_new(&base.join("file.txt"), &vault).is_err());
    assert!(check_new(&base.join("missing"), &vault).is_err());
    assert!(check_new(Path::new("Music"), &vault).is_err());
}

#[test]
fn a_listing_is_one_level_without_litter() {
    let dir = scratch("list");
    std::fs::create_dir_all(dir.join("Album/Disc 1")).unwrap();
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join("song.flac"), b"12345").unwrap();
    std::fs::write(dir.join("clip.mp4"), b"x").unwrap();
    std::fs::write(dir.join("manual.pdf"), b"x").unwrap();
    std::fs::write(dir.join("desktop.ini"), b"x").unwrap();
    std::fs::write(dir.join("Thumbs.db"), b"x").unwrap();
    std::fs::write(dir.join("Album/deep.mp3"), b"x").unwrap();
    let v = list_dir(&dir).unwrap();
    assert_eq!(names(&v, "folders"), vec!["Album"]);
    assert_eq!(names(&v, "files"), vec!["clip.mp4", "manual.pdf", "song.flac"]);
    assert_eq!(v["capped"], json!(false));
    let flac = v["files"].as_array().unwrap().iter().find(|f| f["name"] == "song.flac").unwrap();
    assert_eq!(flac["kind"], "media");
    assert_eq!(flac["size"], 5);
    assert!(list_dir(&dir.join("nope")).is_err());
}

#[test]
fn kinds_cover_what_a_music_drive_holds() {
    for n in ["a.FLAC", "b.mkv", "c.opus", "d.mp3", "e.mp4"] {
        assert_eq!(kind_of(n), "media", "{}", n);
    }
    assert_eq!(kind_of("n.md"), "note");
    assert_eq!(kind_of("p.png"), "image");
    assert_eq!(kind_of("x.bin"), "other");
}

#[test]
fn a_search_matches_every_word_in_any_order() {
    let dir = scratch("find");
    std::fs::create_dir_all(dir.join("Road Trip/2024")).unwrap();
    std::fs::create_dir_all(dir.join(".cache")).unwrap();
    std::fs::write(dir.join("Road Trip/2024/Night Drive (remix).mp3"), b"x").unwrap();
    std::fs::write(dir.join("Road Trip/Day drive.mp3"), b"x").unwrap();
    std::fs::write(dir.join(".cache/night drive.mp3"), b"x").unwrap();
    let f = find(&[dir.clone()], "  DRIVE night ", 50, 5_000);
    assert_eq!(f.hits.len(), 1);
    assert_eq!(f.hits[0]["name"], "Night Drive (remix).mp3");
    assert_eq!(f.hits[0]["root"], json!(dir.to_string_lossy()));
    assert!(!f.partial);
    // folders are found by name too
    let f = find(&[dir.clone()], "road", 50, 5_000);
    assert_eq!(f.hits.len(), 1);
    assert_eq!(f.hits[0]["isDir"], json!(true));
    // the limit stops the walk and says so
    let f = find(&[dir.clone()], "drive", 1, 5_000);
    assert_eq!(f.hits.len(), 1);
    assert!(f.partial);
    assert!(find(&[dir.clone()], "   ", 50, 5_000).hits.is_empty());
    assert!(find(&[dir.join("gone")], "x", 50, 5_000).hits.is_empty());
}

#[test]
fn names_a_disk_would_choke_on_are_refused() {
    assert_eq!(clean_name("  Live set.mp3 ").unwrap(), "Live set.mp3");
    assert_eq!(clean_name("trailing dots...").unwrap(), "trailing dots");
    for bad in ["", "   ", "a/b", "a\\b", "what?", "a:b", "..", ".", "CON", "nul.txt", "lpt1", "tab\there"] {
        assert!(clean_name(bad).is_err(), "{:?}", bad);
    }
}

#[test]
fn a_rename_never_lands_on_something_else() {
    let dir = scratch("rename");
    std::fs::write(dir.join("a.mp3"), b"a").unwrap();
    std::fs::write(dir.join("b.mp3"), b"b").unwrap();
    assert!(rename_in_place(&dir.join("a.mp3"), "b.mp3").is_err());
    assert_eq!(std::fs::read(dir.join("b.mp3")).unwrap(), b"b");
    let to = rename_in_place(&dir.join("a.mp3"), "c.mp3").unwrap();
    assert_eq!(to, dir.join("c.mp3"));
    assert!(!dir.join("a.mp3").exists());
    assert!(rename_in_place(&dir.join("c.mp3"), "x/y.mp3").is_err());
    // a change of case only goes through
    let to = rename_in_place(&dir.join("c.mp3"), "C.mp3").unwrap();
    assert_eq!(to.file_name().unwrap(), "C.mp3");
}

#[test]
fn a_dropped_folder_makes_its_subfolders_and_only_inside_an_outpost() {
    let d = scratch("dropped");
    let out = scratch("dropped-outside");
    crate::lock(&ROOTS).push(d.clone());
    assert_eq!(make_subfolders(&d, &["Album", "Disc 1"]).unwrap(), d.join("Album").join("Disc 1"));
    assert!(d.join("Album").join("Disc 1").is_dir());
    assert!(make_subfolders(&d, &["Album", "Disc 1"]).is_ok(), "there already: fine");
    assert!(make_subfolders(&out, &["Album"]).is_err());
    assert!(!out.join("Album").exists());
    assert!(make_subfolders(&d, &[".."]).is_err());
}

#[test]
fn the_remembered_list_is_read_back() {
    let s = json!({ "outposts": [{ "path": "E:\\Music", "name": "Car" }, { "name": "no path" }, 7] });
    assert_eq!(saved_paths(&s), vec!["E:\\Music".to_string()]);
    assert!(saved_paths(&json!({})).is_empty());
}

#[test]
fn texts_lists_notes_and_text_only_and_skips_the_huge() {
    let d = scratch("texts");
    std::fs::create_dir_all(d.join("sub")).unwrap();
    std::fs::write(d.join("a.md"), "hello").unwrap();
    std::fs::write(d.join("sub").join("b.txt"), "world").unwrap();
    std::fs::write(d.join("song.mp3"), "xx").unwrap();
    std::fs::write(d.join("big.txt"), vec![b'x'; 5000]).unwrap();
    let f = texts(&[d.clone()], 100, 1000, 2_000);
    let mut names: Vec<String> = f.hits.iter().map(|h| h["name"].as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["a.md", "b.txt"]);
    assert!(!f.partial);
}
