//! Tests for project find / replace. Hermetic: each owns a temp directory.

use super::project::*;
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("leonote_project_{}", name));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}
fn put(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}
fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap()
}

#[test]
fn finds_with_case_and_whole_words() {
    let o = |case, word| Opts { case, word, ..Default::default() };
    assert_eq!(find_in("let Foo = foo + food;", "foo", &o(false, false)), vec![(4, 7), (10, 13), (16, 19)]);
    assert_eq!(find_in("let Foo = foo + food;", "foo", &o(true, false)), vec![(10, 13), (16, 19)]);
    assert_eq!(find_in("let Foo = foo + food;", "foo", &o(false, true)), vec![(4, 7), (10, 13)]);
    assert_eq!(find_in("my_foo foo_", "foo", &o(false, true)), vec![]);
    assert_eq!(find_in("привіт Світ", "світ", &o(false, false)).len(), 1);
    assert!(find_in("x", "", &o(false, false)).is_empty());
}

#[test]
fn walks_leave_heavy_and_dot_folders_out() {
    let root = scratch("walk");
    put(&root, "src/a.js", "x");
    put(&root, "node_modules/lib/b.js", "x");
    put(&root, ".cache/c.js", "x");
    put(&root, "pic.png", "x");
    assert_eq!(files(&root), vec!["src/a.js"]);
}

#[test]
fn replace_keeps_a_copy_and_undo_puts_it_back() {
    let root = scratch("replace");
    let keep = scratch("replace_keep");
    put(&root, "a.js", "const oldName = 1;\r\nuse(oldName);\r\n");
    put(&root, "sub/b.py", "old_name = oldName\n");
    put(&root, "c.txt", "nothing here\n");
    let v = replace(&root, &keep, "oldName", "newName", &Opts { case: true, word: true, ..Default::default() }, &["a.js".into(), "sub/b.py".into(), "c.txt".into()]).unwrap();
    assert_eq!(v["count"], 3);
    assert_eq!(v["files"].as_array().unwrap().len(), 2);
    assert_eq!(read(&root, "a.js"), "const newName = 1;\r\nuse(newName);\r\n", "line endings are kept");
    assert_eq!(read(&root, "sub/b.py"), "old_name = newName\n");
    assert!(!keep.join("c.txt").exists(), "only what changed is kept");
    assert_eq!(undo(&root, &keep).unwrap(), 2);
    assert_eq!(read(&root, "a.js"), "const oldName = 1;\r\nuse(oldName);\r\n");
}

#[test]
fn nothing_outside_the_project() {
    let root = scratch("inside");
    put(&root, "a.js", "x");
    for bad in ["", "../a.js", "/etc/passwd", "C:/x", "a\\b", "sub/../../x", "./a.js"] {
        assert!(inside(&root, bad).is_err(), "{:?}", bad);
    }
    assert!(inside(&root, "a.js").is_ok());
    let keep = scratch("inside_keep");
    assert!(replace(&root, &keep, "x", "y", &Opts::default(), &["../a.js".into()]).is_err());
}

#[test]
fn search_reports_lines_and_where_the_match_is() {
    let root = scratch("search");
    put(&root, "src/a.js", "one\nfind me here, find me\nthree\n");
    let v = search(&root, "find me", &Opts::default(), None);
    assert_eq!(v["total"], 2);
    assert_eq!(v["files"], 1);
    let h = &v["hits"][0];
    assert_eq!((h["path"].as_str().unwrap(), h["line"].as_u64().unwrap(), h["from"].as_u64().unwrap(), h["to"].as_u64().unwrap(), h["more"].as_u64().unwrap()), ("src/a.js", 2, 0, 7, 1));
    assert_eq!(search(&root, "find me", &Opts::default(), Some("other"))["total"], 0);
}

#[test]
fn a_project_leaves_out_what_it_says() {
    let ex: Vec<String> = ["dist", "docs/old", "*.min.js", " "].iter().map(|s| s.to_string()).collect();
    for hit in ["dist/a.js", "src/dist/b.js", "docs/old/x.md", "lib/jquery.min.js", "Dist/c.js"] {
        assert!(excluded(hit, &ex), "{}", hit);
    }
    for miss in ["src/a.js", "docs/new/x.md", "distant/a.js", "lib/jquery.js"] {
        assert!(!excluded(miss, &ex), "{}", miss);
    }
    assert!(!excluded("a.js", &[]));
}

/// Git's side of the guard, run for real: every "program" below only leaves a marker file.
#[test]
fn a_git_read_runs_nothing_the_repository_names() {
    use std::process::Command;
    if Command::new("git").arg("--version").output().is_err() { return; }
    let base = scratch("git_guard");
    let mark = base.join("ran");
    let mark_s = mark.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
    let setup = |root: &Path, args: &[&str]| {
        let out = Command::new("git").arg("-C").arg(root).args(["-c", "user.name=a", "-c", "user.email=a@a", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    // a repository with one committed file, edited to the same size so that git has to read it through any filter
    let repo = |name: &str, driver: &str| {
        let root = base.join(name);
        std::fs::create_dir_all(&root).unwrap();
        setup(&root, &["init", "-q"]);
        setup(&root, &["config", &format!("filter.{driver}.clean"), &format!("touch {mark_s}; cat")]);
        put(&root, "f", "x");
        setup(&root, &["add", "f"]);
        setup(&root, &["commit", "-q", "-m", "c"]);
        put(&root, "f", "y");
        root
    };
    let reads_clean = |root: &Path| {
        for args in [&["status", "--porcelain=v1", "-b", "-uall"][..], &["diff", "HEAD", "--", "f"], &["diff", "HEAD", "--", "sm"]] {
            let _ = git(root, args);
            assert!(!mark.exists(), "{} ran something on {args:?}", root.display());
        }
    };

    // the plain case still reads: the switches are switches, not file names
    let plain = repo("plain", "evil");
    assert!(git(&plain, &["diff", "HEAD", "--", "f"]).unwrap().1.contains("+y"));

    // attributes with a byte that is not UTF-8 still name their driver
    let bad = repo("bad", "evil");
    std::fs::write(bad.join(".git/info/attributes"), b"* filter=evil\n\xff\n").unwrap();
    reads_clean(&bad);

    // only space, tab and line ends part words for git: this driver's name has a form feed in it
    let ff = repo("ff", "ev\x0cil");
    std::fs::write(ff.join(".git/info/attributes"), "* filter=ev\x0cil\n").unwrap();
    reads_clean(&ff);

    // a quoted pattern ends at its closing quote: no blank is needed before the attribute
    let quoted = repo("quoted", "evil");
    std::fs::write(quoted.join(".git/info/attributes"), "\"*\"filter=evil
").unwrap();
    reads_clean(&quoted);

    // git reads config and attributes from where commondir points
    let shared = repo("shared", "evil");
    put(&shared, ".git/commondir", &base.join("bad/.git").to_string_lossy());
    assert!(git(&shared, &["status"]).is_err());

    // an empty .git inside a repository: git would walk up and read the parent, which was not checked
    put(&bad, "child/g", "x");
    std::fs::create_dir_all(bad.join("child/.git")).unwrap();
    setup(&bad, &["-c", "filter.evil.clean=cat", "add", "child/g"]);
    put(&bad, "child/g", "y");
    reads_clean(&bad.join("child"));

    // the same under a parent whose name has the separator of git's ceiling list in it
    let semi = repo("c;d", "evil");
    std::fs::write(semi.join(".git/info/attributes"), "* filter=evil
").unwrap();
    std::fs::create_dir_all(semi.join("child/.git")).unwrap();
    reads_clean(&semi.join("child"));

    // an empty .git, and the folder itself laid out as a git folder that git would take instead
    let own = base.join("own");
    std::fs::create_dir_all(&own).unwrap();
    setup(&own, &["init", "-q", "--bare", "."]);
    setup(&own, &["config", "core.bare", "false"]);
    setup(&own, &["config", "core.worktree", "."]);
    put(&own, "f", "x");
    setup(&own, &["add", "f"]);
    setup(&own, &["commit", "-q", "-m", "c"]);
    setup(&own, &["config", "filter.evil.clean", &format!("touch {mark_s}; cat")]);
    put(&own, "info/attributes", "* filter=evil
");
    put(&own, "f", "y");
    std::fs::create_dir_all(own.join(".git")).unwrap();
    reads_clean(&own);

    // a partial clone's lazy fetch through an ext:: remote
    let lazy = repo("lazy", "unused");
    let blob = setup(&lazy, &["rev-parse", "HEAD:f"]);
    setup(&lazy, &["config", "core.repositoryformatversion", "1"]);
    setup(&lazy, &["config", "extensions.partialClone", "origin"]);
    setup(&lazy, &["config", "remote.origin.promisor", "true"]);
    setup(&lazy, &["config", "protocol.ext.allow", "always"]);
    setup(&lazy, &["config", "remote.origin.url", &format!("ext::sh -c touch% {mark_s}")]);
    std::fs::remove_file(lazy.join(".git/objects").join(&blob[..2]).join(&blob[2..])).unwrap();
    reads_clean(&lazy);

    // a submodule with its own driver: its commit still shows as changed, its files are not looked into
    let top = repo("top", "unused");
    let sm = repo("top/sm", "evil");
    std::fs::write(sm.join(".git/info/attributes"), "* filter=evil\n").unwrap();
    setup(&top, &["add", "sm"]);
    setup(&top, &["commit", "-q", "-m", "s"]);
    reads_clean(&top);
    setup(&sm, &["-c", "filter.evil.clean=cat", "commit", "-q", "-am", "moved"]);
    reads_clean(&top);
    assert!(git(&top, &["status", "--porcelain=v1"]).unwrap().1.contains(" M sm"));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_repository_that_names_programs_is_told_from_a_plain_one() {
    use std::process::Command;
    let base = scratch("git_named");
    let repo = |name: &str, setting: Option<(&str, &str)>| {
        let root = base.join(name);
        std::fs::create_dir_all(&root).unwrap();
        assert!(Command::new("git").arg("-C").arg(&root).args(["init", "-q"]).status().unwrap().success());
        for (k, v) in [("remote.origin.url", "https://example.com/a.git"), ("branch.main.remote", "origin"), ("user.name", "a")].into_iter().chain(setting) {
            assert!(Command::new("git").arg("-C").arg(&root).args(["config", k, v]).status().unwrap().success());
        }
        root
    };
    assert_eq!(programs_named(&repo("plain", None)), Vec::<String>::new());
    for (i, s) in [("core.fsmonitor", "x.exe"), ("core.sshCommand", "x.exe"), ("core.hooksPath", "x"), ("filter.a.clean", "x.exe"), ("credential.helper", "x"),
        ("include.path", "other"), ("remote.origin.uploadpack", "x.exe"), ("remote.origin.url", "ext::x"), ("branch.main.mergeoptions", "-s x"), ("something.new", "x")].into_iter().enumerate() {
        assert_eq!(programs_named(&repo(&format!("r{i}"), Some(s))).len(), 1, "{s:?}");
    }
    // an address on another computer asks nothing, anything else does: a push runs a local folder's hooks
    let mut n = 0;
    let mut one = |s: (&str, &str)| { n += 1; programs_named(&repo(&format!("a{n}"), Some(s))).len() };
    for url in ["git@github.com:a/b.git", "github.com:a/b.git", "ssh://git@h/a", "git://h/a", "http://h/a"] {
        assert_eq!(one(("remote.origin.url", url)), 0, "{url}");
    }
    for url in [".git/x.git", "x.git", "../x", "C:/x.git", "C:\\x.git", "c:x", ".git\\x:y", "file:///x", "foo://x", ""] {
        assert_eq!(one(("remote.origin.url", url)), 1, "{url}");
        assert_eq!(one(("remote.origin.pushurl", url)), 1, "{url}");
    }
    assert!(!network_address("-oX=y:z"));
    // which remote to use: one that has an address, or the repository itself; git takes anything else for a folder
    assert_eq!(one(("branch.main.remote", ".")), 0);
    for key in ["branch.main.remote", "branch.main.pushremote", "remote.pushDefault", "extensions.partialClone"] {
        assert_eq!(one((key, "origin")), 0, "{key}");
        assert_eq!(one((key, ".git/x.git")), 1, "{key}");
        assert_eq!(one((key, "evil")), 1, "{key}");
    }
    // nothing in the config at all: git's older places for an address
    for place in [".git/remotes/origin", ".git/branches/origin"] {
        let old = repo(&place.replace('/', "_"), None);
        put(&old, place, "URL: .git/x.git");
        assert_eq!(programs_named(&old).len(), 1, "{place}");
    }
    // Push's fallback pushes to "origin": a folder of that name, when no remote has it
    let folder = repo("origin_folder", None);
    put(&folder, "origin/HEAD", "ref: refs/heads/main");
    assert_eq!(programs_named(&folder), Vec::<String>::new());
    assert!(Command::new("git").arg("-C").arg(&folder).args(["remote", "remove", "origin"]).status().unwrap().success());
    assert_eq!(programs_named(&folder).len(), 1);
    let hook = repo("hook", None);
    put(&hook, ".git/hooks/pre-commit", "#!/bin/sh");
    assert_eq!(programs_named(&hook), vec!["hook: pre-commit".to_string()]);
    // a repository inside it: git asks that one for its status, and its config can name a program
    let inner = repo("inner", None);
    let id = String::from_utf8(Command::new("git").arg("-C").arg(&inner).args(["hash-object", "-t", "tree", "--stdin"]).stdin(std::process::Stdio::null()).output().unwrap().stdout).unwrap();
    assert!(Command::new("git").arg("-C").arg(&inner).args(["update-index", "--add", "--cacheinfo", &format!("160000,{},sub", id.trim())]).status().unwrap().success());
    assert_eq!(programs_named(&inner), vec!["repository inside: sub".to_string()]);
    // a .git that is a pointer elsewhere cannot be judged here
    let pointer = base.join("pointer");
    std::fs::create_dir_all(&pointer).unwrap();
    put(&pointer, ".git", "gitdir: ../plain/.git");
    assert_eq!(programs_named(&pointer).len(), 1);
    // and the git action goes through the question
    let body = include_str!("project.rs").split("pub async fn project_git").nth(1).unwrap();
    assert!(body.contains("grant::allow_git_repo(&app, &r, &named)?"));
    let _ = std::fs::remove_dir_all(&base);
}
