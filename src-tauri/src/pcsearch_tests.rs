//! The parts of "This PC" that have to be right whatever the disk looks
//! like: which roots are walked, what the walk refuses to enter, that it can
//! be stopped, and that the score matches the switcher's.
//!
//! The last test builds a real tree of a few thousand files and prints the
//! timings, so `cargo test -- --nocapture` is the honest answer to "how fast
//! is the index".

use super::pcsearch::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
}

/* ── roots ─────────────────────────────────────────────────────────────── */

#[test]
fn default_roots_are_the_user_own_folders_plus_the_vault() {
    let c = candidate_roots(Path::new("C:\\Users\\leo"), Path::new("G:\\Vault"), &[]);
    let names: Vec<String> = c.iter().map(|x| x.to_string_lossy().into_owned()).collect();
    for n in HOME_ROOTS {
        assert!(names.iter().any(|x| x.ends_with(n)), "missing {}", n);
    }
    assert!(names.iter().any(|x| x.ends_with("OneDrive")));
    assert_eq!(names.last().unwrap(), "G:\\Vault");
}

#[test]
fn extra_roots_from_settings_come_last_and_blanks_are_dropped() {
    let c = candidate_roots(
        Path::new("C:\\Users\\leo"),
        Path::new("G:\\Vault"),
        &["  ".into(), "D:\\Work".into(), "".into()],
    );
    assert_eq!(c.last().unwrap(), &p("D:\\Work"));
    assert_eq!(c.iter().filter(|x| x.as_os_str().is_empty()).count(), 0);
}

#[test]
fn a_root_inside_another_root_is_dropped() {
    let all = vec![p("C:\\Users\\leo\\Documents"), p("C:\\Users\\leo\\Documents\\Work"), p("D:\\Media")];
    let keep = dedupe_roots(all, &|_| true);
    assert_eq!(keep, vec![p("C:\\Users\\leo\\Documents"), p("D:\\Media")]);
}

#[test]
fn a_wider_root_added_later_swallows_the_narrow_one() {
    let all = vec![p("C:\\Users\\leo\\Documents\\Work"), p("C:\\Users\\leo\\Documents")];
    assert_eq!(dedupe_roots(all, &|_| true), vec![p("C:\\Users\\leo\\Documents")]);
}

#[test]
fn roots_that_are_not_there_are_dropped() {
    let all = vec![p("C:\\Users\\leo\\Desktop"), p("C:\\Users\\leo\\Videos")];
    let keep = dedupe_roots(all, &|x| x.to_string_lossy().ends_with("Desktop"));
    assert_eq!(keep, vec![p("C:\\Users\\leo\\Desktop")]);
}

#[test]
fn nesting_ignores_case_and_slash_direction_on_windows() {
    assert!(is_within(Path::new("C:/Users/leo/Documents/a"), Path::new("c:\\users\\leo\\documents")));
    assert!(is_within(Path::new("C:\\Users\\leo"), Path::new("C:\\Users\\leo\\")));
    // a prefix that is not a path boundary is not "inside"
    assert!(!is_within(Path::new("C:\\Users\\leonard"), Path::new("C:\\Users\\leo")));
}

/* ── skip rules ────────────────────────────────────────────────────────── */

#[test]
fn skips_dot_folders_dollar_stores_and_the_usual_caches() {
    for n in [".git", ".cache", "$Recycle.Bin", "$WinREAgent", "node_modules", "AppData", "__pycache__"] {
        assert!(skip_dir(n), "{} should be skipped", n);
    }
    assert!(skip_dir("APPDATA") && skip_dir("Node_Modules"), "the list is case-insensitive");
}

#[test]
fn skips_the_system_folders_but_keeps_ordinary_ones() {
    assert!(skip_dir("Windows") && skip_dir("Program Files") && skip_dir("Program Files (x86)"));
    for n in ["Documents", "My Notes", "Projects", "leonote-rs", "2026 taxes", "node modules"] {
        assert!(!skip_dir(n), "{} should be kept", n);
    }
}

/* ── scoring: the same rewards as search.js `fuzzy` ────────────────────── */

fn score(q: &str, t: &str) -> Option<f64> {
    fuzzy_score(&q.to_lowercase(), &t.to_lowercase())
}

#[test]
fn a_substring_beats_any_scattered_match() {
    let exact = score("report", "report.docx").unwrap();
    let scattered = score("report", "r e p o r t notes.txt").unwrap();
    assert!(exact > scattered, "{} !> {}", exact, scattered);
}

#[test]
fn a_match_at_the_start_and_at_a_word_start_scores_higher() {
    assert!(score("tax", "tax return.pdf").unwrap() > score("tax", "my tax return.pdf").unwrap());
    assert!(score("tax", "my tax return.pdf").unwrap() > score("tax", "syntax.md").unwrap());
}

#[test]
fn the_shorter_name_wins_a_tie() {
    assert!(score("cat", "cat.png").unwrap() > score("cat", "cat in a very long filename.png").unwrap());
}

#[test]
fn a_name_missing_a_letter_does_not_match_at_all() {
    assert!(score("xyz", "report.docx").is_none());
    assert!(score("", "anything").is_some(), "an empty query matches everything");
}

#[test]
fn the_cheap_gate_agrees_with_the_scorer() {
    // the prefilter must never throw out something the scorer would have kept
    for (q, t) in [("rpt", "report.docx"), ("doc", "report.docx"), ("zzz", "report.docx"), ("re po", "report.docx")] {
        assert_eq!(is_subsequence(q, t), fuzzy_score(q, t).is_some(), "{} in {}", q, t);
    }
}

/* ── the walk ──────────────────────────────────────────────────────────── */

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmp(tag: &str) -> Tmp {
    let d = std::env::temp_dir().join(format!("leonote-pc-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Tmp(d)
}

fn touch(p: &Path) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, b"x").unwrap();
}

/// Names, with a `/` after the folders, so one list shows both.
fn collect(roots: &[PathBuf], budget: u128, stop: &dyn Fn() -> bool) -> (Vec<String>, Walk) {
    let mut names = Vec::new();
    let w = walk(roots, budget, stop, |buf| {
        for e in buf.drain(..) {
            names.push(format!("{}{}", e.name(), if e.is_dir() { "/" } else { "" }));
        }
    });
    (names, w)
}

#[test]
fn the_walk_indexes_files_and_folders_but_not_the_skipped_ones() {
    let t = tmp("skip");
    touch(&t.0.join("Notes/plan.md"));
    touch(&t.0.join("Notes/node_modules/left-pad/index.js"));
    touch(&t.0.join(".git/config"));
    touch(&t.0.join("Pictures/holiday.png"));
    let (names, w) = collect(&[t.0.clone()], 5_000, &|| false);
    assert!(names.iter().any(|n| n == "plan.md"));
    assert!(names.iter().any(|n| n == "holiday.png"));
    assert!(names.iter().any(|n| n == "Notes/"), "folders are indexed too, marked as folders");
    assert!(!names.iter().any(|n| n == "index.js"), "node_modules is never entered");
    assert!(!names.iter().any(|n| n == "config"), "dot folders are never entered");
    assert!(!w.cancelled && !w.capped);
    assert_eq!(w.total, names.len());
}

#[test]
fn stopping_ends_the_walk_where_it_stands() {
    let t = tmp("cancel");
    for i in 0..40 {
        touch(&t.0.join(format!("d{}/f{}.txt", i, i)));
    }
    let seen = AtomicUsize::new(0);
    let flag = AtomicBool::new(false);
    let stop = || {
        // let the roots and the first folder through, then pull the handle
        if seen.fetch_add(1, Ordering::SeqCst) >= 2 {
            flag.store(true, Ordering::SeqCst);
        }
        flag.load(Ordering::SeqCst)
    };
    let (names, w) = collect(&[t.0.clone()], 5_000, &stop);
    assert!(w.cancelled, "the walk must report that it was stopped");
    assert!(names.len() < 40 + 41, "it stopped early: {}", names.len());
    assert!(names.iter().any(|n| n.starts_with('d')), "what it did reach is kept");
    assert!(names.iter().all(|n| !n.is_empty()));
}

#[test]
fn the_time_budget_ends_a_walk_that_would_run_too_long() {
    let t = tmp("budget");
    for i in 0..300 {
        touch(&t.0.join(format!("d{}/f.txt", i)));
    }
    let (_, w) = collect(&[t.0.clone()], 0, &|| false);
    assert!(w.capped, "a zero budget must cap immediately");
    assert!(!w.cancelled, "capped is not the same as cancelled");
}

/* ── a realistic tree, with timings ────────────────────────────────────── */

/// Builds ~6000 files in ~600 folders, walks them, and searches the result.
/// Prints what it cost; run with `-- --nocapture` to see it.
#[test]
fn indexing_a_few_thousand_files_is_fast_and_small() {
    let t = tmp("bench");
    let (folders, per) = (600, 10);
    let mk = std::time::Instant::now();
    for d in 0..folders {
        let dir = t.0.join(format!("top{}/mid{}/leaf{}", d % 12, d % 60, d));
        std::fs::create_dir_all(&dir).unwrap();
        for f in 0..per {
            std::fs::write(dir.join(format!("report {}-{}.md", d, f)), b"x").unwrap();
        }
    }
    let made = mk.elapsed();

    let mut entries: Vec<super::pcsearch::Entry> = Vec::new();
    let t0 = std::time::Instant::now();
    let w = walk(&[t.0.clone()], 30_000, &|| false, |buf| entries.append(buf));
    let build = t0.elapsed();

    assert!(!w.capped && !w.cancelled);
    assert_eq!(entries.len(), w.total);
    assert!(entries.len() > folders * per, "every file is in: {}", entries.len());

    // what the index costs, measured the way the state report measures it
    let per_entry = std::mem::size_of::<super::pcsearch::Entry>();
    let bytes: usize = entries.len() * per_entry
        + entries.iter().map(|e| e.name().len()).sum::<usize>();

    // one query, the whole pipeline: gate, score, sort, cap
    let q = "rep41";
    let s0 = std::time::Instant::now();
    let mut scored: Vec<(f64, u64)> = entries
        .iter()
        .filter(|e| is_subsequence(q, &e.name().to_lowercase()))
        .filter_map(|e| fuzzy_score(q, &e.name().to_lowercase()).map(|s| (s, e.size())))
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(b.1.cmp(&a.1)));
    scored.truncate(200);
    let hits = scored.len();
    let query = s0.elapsed();

    println!(
        "\n  pcsearch: {} entries in {} folders\n    tree written in {:?}\n    index built in {:?} ({:.0} entries/ms)\n    ~{:.1} MB ({} bytes/entry)\n    one query: {:?} ({} candidates)\n",
        entries.len(),
        w.dirs,
        made,
        build,
        entries.len() as f64 / build.as_millis().max(1) as f64,
        bytes as f64 / 1_048_576.0,
        bytes / entries.len().max(1),
        query,
        hits
    );
    assert!(hits >= 1, "the query finds its file");
    assert!(query.as_millis() < 200, "a query over {} entries took {:?}", entries.len(), query);
}

/// The same measurement over a real folder, for when a synthetic tree is not
/// convincing. Ignored by default because it depends on the machine:
///
///   LEONOTE_PC_BENCH=C:\Users\me cargo test --release --lib real_tree -- --ignored --nocapture
#[test]
#[ignore]
fn indexing_a_real_tree_reports_its_cost() {
    let Ok(root) = std::env::var("LEONOTE_PC_BENCH") else {
        println!("set LEONOTE_PC_BENCH to a folder to run this");
        return;
    };
    let roots = vec![PathBuf::from(&root)];
    let mut entries: Vec<super::pcsearch::Entry> = Vec::new();
    let t0 = std::time::Instant::now();
    let w = walk(&roots, 120_000, &|| false, |buf| entries.append(buf));
    let build = t0.elapsed();
    let bytes: usize = entries.len() * std::mem::size_of::<super::pcsearch::Entry>()
        + entries.iter().map(|e| e.name().len()).sum::<usize>();
    let q = "report";
    let s0 = std::time::Instant::now();
    let hits = entries
        .iter()
        .filter(|e| is_subsequence(q, &e.name().to_lowercase()))
        .filter_map(|e| fuzzy_score(q, &e.name().to_lowercase()))
        .count();
    println!(
        "\n  pcsearch over {}:\n    {} entries in {} folders, built in {:?}{}\n    ~{:.1} MB ({} bytes/entry)\n    query \"{}\": {:?}, {} matches\n",
        root, entries.len(), w.dirs, build,
        if w.capped { " (capped)" } else { "" },
        bytes as f64 / 1_048_576.0, bytes / entries.len().max(1), q, s0.elapsed(), hits
    );
}

/* ── paths ─────────────────────────────────────────────────────────────── */

#[test]
fn a_path_is_rebuilt_from_the_parent_chain() {
    let t = tmp("paths");
    touch(&t.0.join("Notes/2026/plan.md"));
    let mut entries: Vec<super::pcsearch::Entry> = Vec::new();
    walk(&[t.0.clone()], 5_000, &|| false, |buf| entries.append(buf));
    let i = entries.iter().position(|e| e.name() == "plan.md").expect("plan.md indexed");
    let full = path_of(&entries, i);
    assert!(full.ends_with("Notes\\2026\\plan.md") || full.ends_with("Notes/2026/plan.md"), "{}", full);
    assert!(std::path::Path::new(&full).is_file(), "{} is a real path", full);
}
