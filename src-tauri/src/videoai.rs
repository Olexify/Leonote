//! The video tools for agents (MCP): a `.leovideo` project read as text - its clips, and what is said
//! in them word by word, every word with an id (A12) - and changed by small edits anchored on those
//! ids, never on seconds an agent could get wrong. Leonote turns ids into times, and a cut lands in a
//! pause ffmpeg measured, not on Whisper's guess of where a word ends (it is off by 0.1-0.2 s). A cut
//! with no pause to land in is said so, for the user to look at.
//!
//! The heavy part - hearing the files - runs here, once per file, kept in `.leonote/media/`.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

/// A heard file: its length, its words (start, end, text) and its quiet stretches (from, to), in its own seconds.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default, Debug)]
pub struct Heard {
    pub dur: f64,
    pub words: Vec<(f64, f64, String)>,
    pub quiet: Vec<(f64, f64)>,
}

/// A file the project speaks from, with the letter its word ids carry.
pub struct Src {
    pub rel: String,
    pub tag: String,
    pub heard: Heard,
}

const PAD: f64 = 0.12; // of a pause, what stays on each side of a cut
const NEAR: f64 = 0.25; // how far from Whisper's word edge a measured pause may be

/* ── hearing ─────────────────────────────────────────────────────────── */

/// ffmpeg's silencedetect report read: the file's length and its quiet stretches.
pub fn parse_quiet(err: &str) -> (f64, Vec<(f64, f64)>) {
    let num = |s: &str| s.split(|c: char| c.is_whitespace() || c == '|' || c == ',').next().and_then(|x| x.parse::<f64>().ok());
    let (mut dur, mut quiet, mut open) = (0.0, Vec::new(), None);
    for l in err.lines() {
        if let Some(i) = l.find("Duration: ") {
            let p: Vec<f64> = l[i + 10..].split(',').next().unwrap_or("").split(':').filter_map(|v| v.trim().parse().ok()).collect();
            if p.len() == 3 { dur = p[0] * 3600.0 + p[1] * 60.0 + p[2]; }
        }
        if let Some(i) = l.find("silence_start: ") { open = num(&l[i + 15..]); }
        if let Some(i) = l.find("silence_end: ") {
            if let (Some(a), Some(b)) = (open.take(), num(&l[i + 13..])) { quiet.push((a.max(0.0), b)); }
        }
    }
    if let Some(a) = open { quiet.push((a, dur)); }
    (dur, quiet)
}

/// A file heard: from the cache when the file is unchanged, else Whisper (words) and ffmpeg (pauses) now.
pub fn hear(vault: &Path, rel: &str) -> Result<Heard, String> {
    // the same reading of the path as the check before it: join alone would let a rooted or UNC path leave the vault
    let p = crate::mcp::vault_path(vault, rel)?;
    let m = std::fs::metadata(&p).map_err(|_| format!("{rel} is not in the vault"))?;
    let ms = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    let key = crate::proposals::hash(&format!("{rel}|{}|{ms}", m.len()));
    let cache = vault.join(".leonote").join("media").join(format!("{key}.json"));
    if let Some(h) = std::fs::read_to_string(&cache).ok().and_then(|s| serde_json::from_str::<Heard>(&s).ok()) { return Ok(h); }
    if crate::external::whisper_paths().is_none() {
        return Err("Whisper is not installed, so the video can't be heard. In Leonote, right-click a clip in the video editor › Captions from its speech once - it offers to fetch Whisper - then ask again.".into());
    }
    let words = match crate::external::transcribe(&p, None, None, true) {
        Ok(w) => w.iter().filter_map(|x| {
            let t = x["text"].as_str()?.trim().to_string();
            // [BLANK_AUDIO], (music): Whisper's notes, not words
            if t.is_empty() || t.starts_with('[') || t.starts_with('(') { return None; }
            Some((x["start"].as_f64()?, x["end"].as_f64()?, t))
        }).collect(),
        Err(e) if e.contains("no sound") => Vec::new(),
        Err(e) => return Err(format!("{rel}: {e}")),
    };
    let ff = crate::external::tool_path("ffmpeg", None).ok_or("ffmpeg is needed to hear the pauses")?;
    let mut c = std::process::Command::new(ff);
    // ponytail: a fixed -35 dB floor; a noisy room hides its pauses (the cuts then say so) - measure the floor if that bites
    c.args(["-hide_banner", "-nostats", "-i"]).arg(&p).args(["-vn", "-af", "silencedetect=noise=-35dB:d=0.12", "-f", "null", "-"]);
    crate::external::hidden(&mut c);
    let o = c.output().map_err(|e| format!("ffmpeg did not start: {e}"))?;
    let (dur, quiet) = parse_quiet(&String::from_utf8_lossy(&o.stderr));
    let h = Heard { dur, words, quiet };
    if let Some(d) = cache.parent() { let _ = std::fs::create_dir_all(d); }
    let _ = std::fs::write(&cache, serde_json::to_string(&h).unwrap_or_default());
    Ok(h)
}

fn is_music_track(proj: &Value, track: &str) -> bool {
    proj["tracks"].as_array().into_iter().flatten().any(|t| t["id"] == track && t["name"].as_str().unwrap_or("").to_lowercase().contains("music"))
}

/// The files the project speaks from: its video and sound clips' files, but not those on a Music track.
pub fn speech_files(proj: &Value) -> Vec<String> {
    let mut out: Vec<String> = clips(proj).iter()
        .filter(|c| matches!(c["type"].as_str(), Some("video" | "audio")) && !is_music_track(proj, c["track"].as_str().unwrap_or("")))
        .filter_map(|c| c["src"].as_str().filter(|s| !s.is_empty() && !s.contains("://")).map(String::from)).collect();
    out.sort();
    out.dedup();
    out
}

fn tag_of(i: usize) -> String {
    let mut n = i + 1;
    let mut s = String::new();
    while n > 0 { n -= 1; s.insert(0, (b'A' + (n % 26) as u8) as char); n /= 26; }
    s
}

/// Every speaking file heard - only those `ok` lets through (in the vault, not private). One left out is said.
pub fn listen(vault: &Path, proj: &Value, ok: &dyn Fn(&str) -> bool) -> Result<(Vec<Src>, Vec<String>), String> {
    let (mut out, mut notes) = (Vec::new(), Vec::new());
    for rel in speech_files(proj) {
        if !ok(&rel) { notes.push(format!("{rel} is not a file in the vault that may be heard - not heard")); continue; }
        let heard = hear(vault, &rel)?;
        out.push(Src { tag: tag_of(out.len()), rel, heard });
    }
    Ok((out, notes))
}

/* ── the project ─────────────────────────────────────────────────────── */

fn clips(proj: &Value) -> Vec<Value> { proj["clips"].as_array().cloned().unwrap_or_default() }
fn f(c: &Value, k: &str) -> f64 { c[k].as_f64().unwrap_or(0.0) }
fn speed(c: &Value) -> f64 { c["speed"].as_f64().filter(|s| *s > 0.0).unwrap_or(1.0) }
fn ramps(c: &Value) -> bool { c["speedTo"].as_f64().map_or(false, |s| s > 0.0) }
fn end(c: &Value) -> f64 { f(c, "start") + f(c, "dur") }
fn r2(x: f64) -> f64 { (x * 1000.0).round() / 1000.0 }

fn uid() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let mut n = h.finish();
    (0..7).map(|_| { let d = (n % 36) as u32; n /= 36; std::char::from_digit(d, 36).unwrap() }).collect()
}

/// The pieces of the timeline that play `rel`, in timeline order: (clip index, start, in, dur, speed).
fn pieces(proj: &Value, rel: &str) -> Vec<(usize, f64, f64, f64, f64)> {
    let mut v: Vec<_> = clips(proj).iter().enumerate()
        .filter(|(_, c)| c["src"].as_str() == Some(rel) && matches!(c["type"].as_str(), Some("video" | "audio")))
        .map(|(i, c)| (i, f(c, "start"), f(c, "in"), f(c, "dur"), speed(c))).collect();
    v.sort_by(|a, b| a.1.total_cmp(&b.1));
    v
}

/// Where a moment of the file plays on the timeline, if it does.
fn on_timeline(proj: &Value, rel: &str, t: f64) -> Option<f64> {
    pieces(proj, rel).into_iter().find(|p| t >= p.2 - 1e-6 && t <= p.2 + p.3 * p.4 + 1e-6).map(|p| p.1 + (t - p.2) / p.4)
}

fn word<'a>(srcs: &'a [Src], id: &str) -> Result<(&'a Src, usize), String> {
    let id = id.trim();
    let split = id.find(|c: char| c.is_ascii_digit()).ok_or_else(|| format!("\"{id}\" is not a word id like A12"))?;
    let (tag, n) = id.split_at(split);
    let s = srcs.iter().find(|s| s.tag.eq_ignore_ascii_case(tag)).ok_or_else(|| format!("there is no source {tag} - see video_overview"))?;
    let n: usize = n.parse().map_err(|_| format!("\"{id}\" is not a word id like A12"))?;
    if n == 0 || n > s.heard.words.len() { return Err(format!("{tag} has words {tag}1-{tag}{}, not {id}", s.heard.words.len())); }
    Ok((s, n - 1))
}

/* ── where cuts land ─────────────────────────────────────────────────── */

/// The measured pause around a gap between words (lo..hi): the one overlapping it most.
fn quiet_in(h: &Heard, lo: f64, hi: f64) -> Option<(f64, f64)> {
    let (a, b) = (lo.min(hi) - NEAR, hi.max(lo) + NEAR);
    h.quiet.iter().map(|&(qa, qb)| ((qa, qb), qb.min(b) - qa.max(a))).filter(|x| x.1 > 0.04).max_by(|x, y| x.1.total_cmp(&y.1)).map(|x| x.0)
}

/// Where a cut that removes word `i` onwards starts, and whether it found a pause.
fn cut_start(h: &Heard, i: usize) -> (f64, bool) {
    let lo = if i > 0 { h.words[i - 1].1 } else { 0.0 };
    match quiet_in(h, lo, h.words[i].0) { Some((qa, qb)) => (qa + PAD.min((qb - qa) / 2.0), true), None => ((lo + h.words[i].0) / 2.0, false) }
}

/// Where a cut that removes up to word `j` ends, and whether it found a pause.
fn cut_end(h: &Heard, j: usize) -> (f64, bool) {
    let hi = h.words.get(j + 1).map(|w| w.0).unwrap_or(h.dur.max(h.words[j].1));
    match quiet_in(h, h.words[j].1, hi) { Some((qa, qb)) => (qb - PAD.min((qb - qa) / 2.0), true), None => ((h.words[j].1 + hi) / 2.0, false) }
}

/* ── ripple ──────────────────────────────────────────────────────────── */

fn shift_keys(c: &mut Value, by: f64, max: f64) {
    if let Some(ks) = c["keys"].as_array() {
        let ks: Vec<Value> = ks.iter().filter_map(|k| { let t = f(k, "t") - by; if t < -1e-6 || t > max + 1e-6 { return None; } let mut k = k.clone(); k["t"] = json!(r2(t.max(0.0))); Some(k) }).collect();
        c["keys"] = json!(ks);
    }
}

/// Take timeline seconds t0..t1 out of every track and close the gap. The files in `split` (the speech)
/// are cut through, so what follows stays in sync; anything else running across - music, a picture - only
/// gets shorter, and plays on unbroken.
fn ripple(proj: &mut Value, t0: f64, t1: f64, split: &HashSet<String>) -> Result<(), String> {
    let d = t1 - t0;
    if d <= 1e-3 { return Ok(()); }
    let e = 1e-3;
    let mut out = Vec::new();
    for mut c in clips(proj) {
        let (a, b) = (f(&c, "start"), end(&c));
        let media = matches!(c["type"].as_str(), Some("video" | "audio" | "gif" | "studio"));
        let cuts_through = matches!(c["type"].as_str(), Some("video" | "audio")) && c["src"].as_str().map_or(false, |s| split.contains(s));
        if cuts_through && ramps(&c) && b > t0 + e && a < t1 - e {
            return Err(format!("clip {} changes speed as it plays - cut that one by hand", c["id"].as_str().unwrap_or("?")));
        }
        if b <= t0 + e { out.push(c); continue; }
        if a >= t1 - e { c["start"] = json!(r2(a - d)); out.push(c); continue; }
        if a >= t0 - e && b <= t1 + e { continue; }
        if a < t0 && b > t1 {
            if cuts_through {
                let sp = speed(&c);
                let mut two = c.clone();
                c["dur"] = json!(r2(t0 - a));
                c["fadeOut"] = json!(0);
                shift_keys(&mut c, 0.0, t0 - a);
                two["id"] = json!(uid());
                two["start"] = json!(r2(t0));
                two["in"] = json!(r2(f(&two, "in") + (t1 - a) * sp));
                two["dur"] = json!(r2(b - t1));
                two["fadeIn"] = json!(0);
                two["transition"] = Value::Null;
                shift_keys(&mut two, t1 - a, b - t1);
                out.push(c);
                out.push(two);
            } else {
                c["dur"] = json!(r2(f(&c, "dur") - d));
                out.push(c);
            }
            continue;
        }
        if a < t0 { c["dur"] = json!(r2(t0 - a)); shift_keys(&mut c, 0.0, t0 - a); }
        else {
            let gone = t1 - a;
            if media { c["in"] = json!(r2(f(&c, "in") + gone * speed(&c))); }
            c["start"] = json!(r2(t0));
            c["dur"] = json!(r2(b - t1));
            shift_keys(&mut c, gone, b - t1);
        }
        if f(&c, "dur") >= 0.05 { out.push(c); }
    }
    proj["clips"] = json!(out);
    if let Some(ms) = proj["markers"].as_array() {
        let ms: Vec<Value> = ms.iter().map(|m| { let t = f(m, "t"); let mut m = m.clone(); if t >= t1 { m["t"] = json!(r2(t - d)); } else if t > t0 { m["t"] = json!(r2(t0)); } m }).collect();
        proj["markers"] = json!(ms);
    }
    Ok(())
}

/// Take a stretch of a file (its own seconds) out wherever the timeline plays it. Seconds taken out.
fn cut_file(proj: &mut Value, rel: &str, s0: f64, s1: f64, split: &HashSet<String>) -> Result<f64, String> {
    let mut spans: Vec<(f64, f64)> = pieces(proj, rel).into_iter().filter_map(|(_, st, inn, dur, sp)| {
        let (a, b) = (s0.max(inn), s1.min(inn + dur * sp));
        (b - a > 0.01).then(|| (st + (a - inn) / sp, st + (b - inn) / sp))
    }).collect();
    // the same stretch on two tracks (a video and its sound apart) is one cut
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for s in spans { match merged.last_mut() { Some(m) if s.0 <= m.1 + 1e-3 => m.1 = m.1.max(s.1), _ => merged.push(s) } }
    let mut gone = 0.0;
    for (a, b) in merged.into_iter().rev() { ripple(proj, a, b, split)?; gone += b - a; }
    Ok(gone)
}

fn words_text(h: &Heard, i: usize, j: usize) -> String {
    let all: Vec<&str> = h.words[i..=j].iter().map(|w| w.2.as_str()).collect();
    let s = all.join(" ");
    if s.chars().count() > 60 { format!("{}…", s.chars().take(60).collect::<String>()) } else { s }
}

/* ── the edits ───────────────────────────────────────────────────────── */

fn track_named(proj: &mut Value, name: &str, kind: &str, top: bool) -> String {
    if let Some(t) = proj["tracks"].as_array().into_iter().flatten().find(|t| t["name"] == name && t["kind"] == kind) { return t["id"].as_str().unwrap_or("").to_string(); }
    let id = format!("{}{}", if kind == "audio" { "a" } else { "v" }, uid());
    let t = json!({ "id": id, "kind": kind, "name": name, "hidden": false, "muted": false });
    if let Some(ts) = proj["tracks"].as_array_mut() { if top { ts.insert(0, t); } else { ts.push(t); } } else { proj["tracks"] = json!([t]); }
    id
}

fn new_clip(track: &str, kind: &str, src: &str, start: f64, dur: f64) -> Value {
    json!({ "id": uid(), "track": track, "type": kind, "src": src, "start": r2(start), "in": 0, "dur": r2(dur.max(0.1)),
        "x": 0.5, "y": 0.5, "scale": 1, "rotate": 0, "opacity": 1, "fit": "contain", "filter": {}, "fadeIn": 0, "fadeOut": 0, "zoom": 0,
        "volume": 1, "speed": 1, "keys": [] })
}

fn kind_of(file: &str) -> Option<&'static str> {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    Some(match ext.as_str() {
        "mp4" | "webm" | "mov" | "m4v" | "mkv" => "video",
        "mp3" | "wav" | "ogg" | "oga" | "m4a" | "aac" | "flac" | "opus" | "weba" => "audio",
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "avif" | "svg" => "image",
        "gif" => "gif",
        "leostudio" => "studio",
        _ => return None,
    })
}

/// A word's place on the timeline: where it starts and ends there.
fn word_on(proj: &Value, s: &Src, i: usize) -> Result<(f64, f64), String> {
    let w = &s.heard.words[i];
    let a = on_timeline(proj, &s.rel, w.0).or_else(|| on_timeline(proj, &s.rel, (w.0 + w.1) / 2.0)).ok_or_else(|| format!("{}{} (“{}”) is not on the timeline - cut out", s.tag, i + 1, w.2))?;
    let b = on_timeline(proj, &s.rel, w.1).unwrap_or(a + (w.1 - w.0));
    Ok((a, b))
}

fn timeline_end(proj: &Value) -> f64 { clips(proj).iter().map(end).fold(0.0, f64::max) }

/// Captions from the words as they play: a few words each, broken at a sentence's end or a pause.
fn captions(proj: &mut Value, s: &Src, style: &str, per: usize) -> usize {
    let tr = track_named(proj, "Captions", "visual", true);
    let mut cs: Vec<Value> = clips(proj).into_iter().filter(|c| !(c["track"] == tr.as_str() && c["type"] == "text")).collect();
    let mut chunks: Vec<(f64, f64, Vec<String>)> = Vec::new();
    for (_, st, inn, dur, sp) in pieces(proj, &s.rel) {
        let mut cur: Option<(f64, f64, Vec<String>)> = None;
        let mut last_end = f64::MIN;
        for w in s.heard.words.iter().filter(|w| { let m = (w.0 + w.1) / 2.0; m >= inn && m <= inn + dur * sp }) {
            let (a, b) = (st + (w.0.max(inn) - inn) / sp, st + (w.1.min(inn + dur * sp) - inn) / sp);
            let brk = cur.as_ref().map_or(false, |c| c.2.len() >= per || c.2.last().map_or(false, |t| t.ends_with(['.', '?', '!'])) || w.0 - last_end >= 0.5);
            if brk { chunks.push(cur.take().unwrap()); }
            let c = cur.get_or_insert((a, b, Vec::new()));
            c.1 = b;
            c.2.push(w.2.clone());
            last_end = w.1;
        }
        if let Some(c) = cur { chunks.push(c); }
        // nothing runs past its piece
        let stop = st + dur;
        for c in chunks.iter_mut().rev().take_while(|c| c.0 >= st) { c.1 = c.1.min(stop); }
    }
    let (y, caps, kind) = match style { "meme" => (0.85, true, "meme"), "title" => (0.5, false, "title"), _ => (0.8, false, "caption") };
    let n = chunks.len();
    for k in 0..n {
        let next = chunks.get(k + 1).map(|c| c.0).unwrap_or(f64::MAX);
        let (a, b) = (chunks[k].0, (chunks[k].1 + 0.15).min(next));
        if b - a < 0.15 { continue; }
        let mut c = new_clip(&tr, "text", "", a, b - a);
        c["x"] = json!(0.5);
        c["y"] = json!(y);
        c["text"] = json!({ "text": chunks[k].2.join(" "), "style": kind, "size": 0.045, "color": "#ffffff", "strokeColor": "#000000", "align": "center", "caps": caps });
        cs.push(c);
    }
    proj["clips"] = json!(cs);
    n
}

/// The edits applied, all or none. Returns what was done and what the user should look at.
pub fn apply(proj: &mut Value, ops: &[Value], srcs: &[Src], exists: &dyn Fn(&str) -> bool) -> Result<(Vec<String>, Vec<String>), String> {
    let split: HashSet<String> = srcs.iter().map(|s| s.rel.clone()).collect();
    let (mut done, mut look) = (Vec::new(), Vec::new());
    for (n, op) in ops.iter().enumerate() {
        let at = |e: String| format!("edit {} ({}): {}", n + 1, op["op"].as_str().unwrap_or("?"), e);
        let s = |k: &str| op[k].as_str().ok_or_else(|| at(format!("\"{k}\" is needed")));
        match op["op"].as_str().unwrap_or("") {
            "cut" => {
                let (sa, i) = word(srcs, s("from")?).map_err(at)?;
                let (sb, j) = word(srcs, op["to"].as_str().unwrap_or(s("from")?)).map_err(at)?;
                if sa.rel != sb.rel { return Err(at("from and to are in different files".into())); }
                let (i, j) = (i.min(j), i.max(j));
                let h = &sa.heard;
                let ((s0, p0), (s1, p1)) = (cut_start(h, i), cut_end(h, j));
                let gone = cut_file(proj, &sa.rel, s0, s1, &split).map_err(at)?;
                let ids = if i == j { format!("{}{}", sa.tag, i + 1) } else { format!("{t}{}-{t}{}", i + 1, j + 1, t = sa.tag) };
                let what = format!("{ids} “{}”", words_text(h, i, j));
                if gone < 0.01 { look.push(format!("{what} was already out of the timeline")); continue; }
                done.push(format!("Cut {what} ({gone:.1} s)"));
                if !p0 { look.push(format!("no pause before {}{} - the cut at its start may clip a sound", sa.tag, i + 1)); }
                if !p1 { look.push(format!("no pause after {}{} - the cut at its end may clip a sound", sa.tag, j + 1)); }
            }
            "pause" => {
                let (sa, i) = word(srcs, s("after")?).map_err(at)?;
                let h = &sa.heard;
                let Some(next) = h.words.get(i + 1) else { return Err(at(format!("{}{} is the last word", sa.tag, i + 1))) };
                let keep = op["keep"].as_f64().unwrap_or(0.25).clamp(0.0, 2.0);
                let (lo, hi) = (h.words[i].1, next.0);
                let (a, b, measured) = match quiet_in(h, lo, hi) { Some((qa, qb)) => (qa, qb, true), None => (lo, hi, false) };
                let (s0, s1) = (a + keep / 2.0, b - keep / 2.0);
                if s1 - s0 < 0.05 { look.push(format!("the pause after {}{} is already {:.2} s or less", sa.tag, i + 1, b - a)); continue; }
                let gone = cut_file(proj, &sa.rel, s0, s1, &split).map_err(at)?;
                done.push(format!("Pause after {}{} “{}” shortened by {gone:.1} s", sa.tag, i + 1, h.words[i].2));
                if !measured { look.push(format!("the pause after {}{} was not measured - only Whisper's guess", sa.tag, i + 1)); }
            }
            "captions" => {
                let src = match op["source"].as_str() {
                    Some(t) => srcs.iter().find(|x| x.tag.eq_ignore_ascii_case(t)).ok_or_else(|| at(format!("there is no source {t}")))?,
                    // the file with the most words playing
                    None => srcs.iter().max_by_key(|x| x.heard.words.iter().filter(|w| on_timeline(proj, &x.rel, w.0).is_some()).count()).ok_or_else(|| at("nothing in the project speaks".into()))?,
                };
                let per = op["words"].as_u64().unwrap_or(5).clamp(1, 12) as usize;
                let n = captions(proj, src, op["style"].as_str().unwrap_or("caption"), per);
                done.push(format!("Captions from {} ({n}), on the Captions track - earlier captions there replaced", src.tag));
            }
            "add" => {
                // backslashes first, then the leading slashes: \\server\share would otherwise stay //server/share, a network path
                let file = s("file")?.trim().replace('\\', "/").trim_start_matches('/').to_string();
                if file.split('/').any(|p| p == ".." || p.starts_with('.')) || file.contains(':') || !exists(&file) { return Err(at(format!("{file} is not a file in the vault"))); }
                let kind = kind_of(&file).ok_or_else(|| at(format!("{file} is not a picture, video, sound or animation")))?;
                // at a word (A40) - or, in a video with no speech, at a second on the timeline
                let (a, from) = match op["at"].as_f64() {
                    Some(sec) => (sec.max(0.0), format!("{sec:.1} s")),
                    None => { let (sa, i) = word(srcs, s("at")?).map_err(at)?; (word_on(proj, sa, i).map_err(at)?.0, format!("{}{}", sa.tag, i + 1)) }
                };
                let b = match (op["to"].as_str(), op["dur"].as_f64()) {
                    (Some(to), _) => { let (sb, j) = word(srcs, to).map_err(at)?; word_on(proj, sb, j).map_err(at)?.1 }
                    (None, Some(d)) => a + d.clamp(0.1, 600.0),
                    _ if kind == "audio" => timeline_end(proj).max(a + 1.0),
                    _ => a + 3.0,
                };
                if b - a < 0.1 { return Err(at("it would end before it starts".into())); }
                let audio = kind == "audio";
                // a track of its own kind where nothing is there already
                let mut tr = String::new();
                for k in 1..20 {
                    let name = if audio { if k == 1 { "Sound".to_string() } else { format!("Sound {k}") } } else if k == 1 { "Overlays".to_string() } else { format!("Overlays {k}") };
                    let id = track_named(proj, &name, if audio { "audio" } else { "visual" }, !audio);
                    if !clips(proj).iter().any(|c| c["track"] == id.as_str() && f(c, "start") < b - 1e-3 && end(c) > a + 1e-3) { tr = id; break; }
                }
                let mut c = new_clip(&tr, kind, &file, a, b - a);
                if !audio { c["fit"] = json!("cover"); }
                // a video laid over the talk keeps quiet; the talk has the sound
                if kind == "video" { c["volume"] = json!(op["volume"].as_f64().unwrap_or(0.0).clamp(0.0, 2.0)); }
                if audio { c["volume"] = json!(op["volume"].as_f64().unwrap_or(if speech_files(proj).contains(&file) { 1.0 } else { 0.35 }).clamp(0.0, 2.0)); }
                done.push(format!("Added {file} at {from} ({:.1}-{:.1} s), clip {}", a, b, c["id"].as_str().unwrap_or("")));
                if let Some(cs) = proj["clips"].as_array_mut() { cs.push(c); }
            }
            "set" | "remove" => {
                let id = s("clip")?;
                let Some(cs) = proj["clips"].as_array_mut() else { return Err(at("the project has no clips".into())) };
                let Some(k) = cs.iter().position(|c| c["id"] == id) else { return Err(at(format!("there is no clip {id}"))) };
                if op["op"] == "remove" { cs.remove(k); done.push(format!("Removed clip {id}")); continue; }
                let c = &mut cs[k];
                let mut what = Vec::new();
                for (key, lo, hi) in [("volume", 0.0, 2.0), ("opacity", 0.0, 1.0), ("fadeIn", 0.0, 5.0), ("fadeOut", 0.0, 5.0), ("zoom", 0.0, 1.0)] {
                    if let Some(v) = op[key].as_f64() { c[key] = json!(v.clamp(lo, hi)); what.push(key); }
                }
                if let Some(t) = op["text"].as_str() {
                    if c["type"] != "text" { return Err(at(format!("clip {id} is not a text"))); }
                    c["text"]["text"] = json!(t.chars().take(500).collect::<String>());
                    what.push("text");
                }
                if let Some(t) = op.get("transition").filter(|t| !t.is_null()) {
                    let kind = t["kind"].as_str().or(t.as_str()).unwrap_or("none");
                    const KINDS: [&str; 17] = ["none", "fade", "black", "white", "slide-left", "slide-right", "slide-up", "slide-down", "push-left", "push-up", "wipe", "iris", "zoom", "zoom-out", "spin", "whip", "blur"];
                    if !KINDS.contains(&kind) { return Err(at(format!("no transition called {kind} - one of {}", KINDS.join(", ")))); }
                    c["transition"] = if kind == "none" { Value::Null } else { json!({ "kind": kind, "len": t["len"].as_f64().unwrap_or(0.5).clamp(0.1, 3.0) }) };
                    what.push("transition");
                }
                if what.is_empty() { return Err(at("nothing to set - volume, opacity, fadeIn, fadeOut, zoom, text or transition".into())); }
                done.push(format!("Clip {id}: {} set", what.join(", ")));
            }
            other => return Err(at(format!("there is no edit \"{other}\" - cut, pause, captions, add, set or remove"))),
        }
    }
    Ok((done, look))
}

/// The video editor's AI panel: the project as it is in the editor (unsaved changes and all). Without
/// `ops`: its text overview and what looks wrong. With `ops`: the project with them applied, what was done
/// and what to look at - the editor takes it as one step to undo. A file that cannot be heard (no Whisper)
/// only leaves its words out.
#[tauri::command]
pub async fn video_ai(project: String, ops: Option<Vec<Value>>, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let vault = state.paths.vault.clone();
    // what the AI's edits may lay in: files AI may see - a transcript (the words of a clip) could ask for a private one
    let ctx = crate::mcp::Ctx { vault: vault.clone(), dir: state.paths.dir.clone(), snapshot: state.paths.snapshot.clone() };
    tauri::async_runtime::spawn_blocking(move || {
        let mut proj: Value = serde_json::from_str(&project).map_err(|e| format!("not a video project: {e}"))?;
        // files in the vault only (a shared project could name any file on the computer); private ones too - this is
        // the user's own editor, not an agent
        let (srcs, notes) = listen(&vault, &proj, &|f| crate::mcp::vault_path(&vault, f).is_ok_and(|p| p.is_file())).unwrap_or_else(|e| (Vec::new(), vec![e]));
        match ops {
            None => {
                // the transcript panel: every word as it plays, in timeline order
                let mut words: Vec<PlayWord> = srcs.iter().flat_map(|s| play_words(&proj, s)).collect();
                words.sort_by(|a, b| a.t.total_cmp(&b.t));
                // where each file speaks, in its own seconds: words less than 0.6 s apart run together
                let speech: serde_json::Map<String, Value> = srcs.iter().map(|s| {
                    let mut runs: Vec<(f64, f64)> = Vec::new();
                    for w in &s.heard.words {
                        match runs.last_mut() { Some(r) if w.0 - r.1 < 0.6 => r.1 = r.1.max(w.1), _ => runs.push((w.0, w.1)) }
                    }
                    (s.rel.clone(), json!(runs.iter().map(|r| [r2(r.0), r2(r.1)]).collect::<Vec<_>>()))
                }).collect();
                Ok(json!({ "overview": overview(&proj, "this project", &srcs), "notes": notes, "check": check(&proj, &srcs), "words": words, "speech": speech }))
            }
            Some(ops) => {
                let (done, look) = apply(&mut proj, &ops, &srcs, &|f| crate::mcp::media_ok(&ctx, f))?;
                Ok(json!({ "project": proj, "done": done, "look": look, "check": check(&proj, &srcs), "notes": notes }))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ── reading it ──────────────────────────────────────────────────────── */

/// A word as it plays: its id, its text, its timeline second, the pause before it (0.4 s or more), and
/// whether the timeline skips just before it (`cut`) or it opens a piece (`first`).
#[derive(serde::Serialize)]
pub struct PlayWord { pub id: String, pub text: String, pub t: f64, pub gap: Option<f64>, pub cut: bool, #[serde(skip)] pub first: bool }

/// The words of one file in the order the timeline plays them.
pub fn play_words(proj: &Value, s: &Src) -> Vec<PlayWord> {
    let mut out = Vec::new();
    for (n, (_, st, inn, dur, sp)) in pieces(proj, &s.rel).into_iter().enumerate() {
        let mut prev: Option<f64> = None;
        for (k, w) in s.heard.words.iter().enumerate() {
            let m = (w.0 + w.1) / 2.0;
            if m < inn || m > inn + dur * sp { continue; }
            out.push(PlayWord { id: format!("{}{}", s.tag, k + 1), text: w.2.clone(), t: r2(st + (w.0.max(inn) - inn) / sp),
                gap: prev.map(|p| r2(w.0 - p)).filter(|g| *g >= 0.4), cut: n > 0 && prev.is_none(), first: prev.is_none() });
            prev = Some(w.1);
        }
    }
    out
}

/// The project as text: tracks, clips, and the words as they play, with their ids.
pub fn overview(proj: &Value, rel: &str, srcs: &[Src]) -> String {
    let mut o = format!("{rel} - {}×{}, {} fps, {:.1} s long\n", proj["width"].as_u64().unwrap_or(1080), proj["height"].as_u64().unwrap_or(1920), proj["fps"].as_u64().unwrap_or(30), timeline_end(proj));
    let tracks: Vec<String> = proj["tracks"].as_array().into_iter().flatten().map(|t| format!("{} {} ({})", t["id"].as_str().unwrap_or(""), t["name"].as_str().unwrap_or(""), t["kind"].as_str().unwrap_or(""))).collect();
    o += &format!("Tracks, top first: {}\n\nClips (timeline seconds):\n", tracks.join(" · "));
    let mut cs = clips(proj);
    cs.sort_by(|a, b| f(a, "start").total_cmp(&f(b, "start")));
    for c in &cs {
        let what = if c["type"] == "text" { format!("“{}”", c["text"]["text"].as_str().unwrap_or("").chars().take(50).collect::<String>()) } else { c["src"].as_str().unwrap_or("").to_string() };
        let mut extra = String::new();
        if matches!(c["type"].as_str(), Some("video" | "audio")) && f(c, "in") > 0.0 { extra += &format!(", from {:.2} in it", f(c, "in")); }
        if (speed(c) - 1.0).abs() > 1e-3 { extra += &format!(", speed {}", speed(c)); }
        if c["volume"].as_f64().map_or(false, |v| (v - 1.0).abs() > 1e-3) && c["type"] != "text" { extra += &format!(", volume {}", c["volume"]); }
        o += &format!("  {} {} {} {} {:.2}-{:.2}{}\n", c["id"].as_str().unwrap_or(""), c["track"].as_str().unwrap_or(""), c["type"].as_str().unwrap_or(""), what, f(c, "start"), end(c), extra);
    }
    for s in srcs {
        o += &format!("\nSpeech {} = {} ({:.1} s, {} words). As it plays: [12.4] a timeline second, ⟨0.9⟩ a pause in seconds, ✂ the timeline skips here.\n", s.tag, s.rel, s.heard.dur, s.heard.words.len());
        let mut line: Vec<String> = Vec::new();
        for w in play_words(proj, s) {
            if w.cut { line.push("✂".into()); }
            if let Some(g) = w.gap { line.push(format!("⟨{g:.1}⟩")); }
            if w.first || line.iter().rev().take_while(|x| !x.starts_with('[')).count() >= 24 { line.push(format!("[{:.1}]", w.t)); }
            line.push(format!("{} {}", w.id, w.text));
        }
        if line.is_empty() { o += "  (none of it is on the timeline)\n"; continue; }
        for chunk in line.chunks(16) { o += &format!("  {}\n", chunk.join(" ")); }
    }
    o
}

/// What looks wrong, as text: nothing to watch, nothing spent until something fails.
pub fn check(proj: &Value, srcs: &[Src]) -> Vec<String> {
    let mut out = Vec::new();
    let cs = clips(proj);
    let id = |c: &Value| c["id"].as_str().unwrap_or("?").to_string();
    // two clips on one track at once
    for (i, a) in cs.iter().enumerate() {
        for b in cs.iter().skip(i + 1) {
            if a["track"] == b["track"] && f(a, "start") < end(b) - 0.05 && f(b, "start") < end(a) - 0.05 {
                out.push(format!("clips {} and {} overlap on track {}", id(a), id(b), a["track"].as_str().unwrap_or("")));
            }
        }
    }
    for s in srcs {
        let ps = pieces(proj, &s.rel);
        for w in ps.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if cs[a.0]["track"] == cs[b.0]["track"] && b.1 - (a.1 + a.3) > 0.05 { out.push(format!("a {:.2} s hole on the timeline at {:.2} (between {} and {})", b.1 - (a.1 + a.3), a.1 + a.3, id(&cs[a.0]), id(&cs[b.0]))); }
        }
        for &(k, st, inn, dur, sp) in &ps {
            let c = &cs[k];
            let out_at = inn + dur * sp;
            if s.heard.dur > 0.0 && out_at > s.heard.dur + 0.05 { out.push(format!("clip {} runs {:.2} s past the end of {}", id(c), out_at - s.heard.dur, s.rel)); }
            for (edge, t) in [("starts", inn), ("ends", out_at)] {
                if let Some((n, w)) = s.heard.words.iter().enumerate().find(|(_, w)| t > w.0 + 0.04 && t < w.1 - 0.04) {
                    out.push(format!("clip {} {} inside the word {}{} “{}” at {:.2} - a sound is clipped there", id(c), edge, s.tag, n + 1, w.2, if edge == "starts" { st } else { st + dur }));
                }
            }
            for w in s.heard.words.windows(2) {
                let (a, b) = (w[0].1, w[1].0);
                if a >= inn && b <= out_at && b - a >= 1.0 { out.push(format!("a {:.1} s pause at {:.1} on the timeline (before “{}”)", b - a, st + (a - inn) / sp, w[1].2)); }
            }
        }
    }
    for c in cs.iter().filter(|c| c["type"] == "text") {
        let t = c["text"]["text"].as_str().unwrap_or("");
        if t.chars().count() > 60 { out.push(format!("text {} is {} characters - too long to read in time", id(c), t.chars().count())); }
        if f(c, "dur") < 0.4 && !t.is_empty() { out.push(format!("text {} shows for only {:.2} s", id(c), f(c, "dur"))); }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rooted_path_is_not_heard_from_outside_the_vault() {
        let base = std::env::temp_dir().join(format!("leonote-hear-{}", std::process::id()));
        let (vault, outside) = (base.join("vault"), base.join("outside.m4a"));
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(&outside, "sound").unwrap();
        // "/Users/.../outside.m4a": no drive, so it passes as a vault path; what was heard from there is in the cache, so nothing runs
        let abs = outside.to_string_lossy().replace('\\', "/");
        let rel = &abs[abs.find('/').unwrap()..];
        let m = std::fs::metadata(&outside).unwrap();
        let ms = m.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let cache = vault.join(".leonote/media");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join(format!("{}.json", crate::proposals::hash(&format!("{rel}|{}|{ms}", m.len())))), serde_json::to_string(&Heard::default()).unwrap()).unwrap();
        assert!(hear(&vault, rel).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    fn talk() -> (Value, Vec<Src>) {
        // "so um today we look" - a pause measured round "um"
        let heard = Heard { dur: 5.0, words: vec![(0.2, 0.5, "so".into()), (1.0, 1.3, "um".into()), (2.0, 2.4, "today".into()), (2.5, 2.8, "we".into()), (2.9, 3.3, "look.".into())], quiet: vec![(0.0, 0.2), (0.55, 0.95), (1.35, 1.95), (3.35, 5.0)] };
        let proj = json!({ "width": 1080, "height": 1920, "fps": 30,
            "tracks": [{ "id": "v1", "kind": "visual", "name": "Main" }, { "id": "a1", "kind": "audio", "name": "Music" }],
            "clips": [
                { "id": "talk", "track": "v1", "type": "video", "src": "t.mp4", "start": 0, "in": 0, "dur": 5, "speed": 1, "keys": [] },
                { "id": "song", "track": "a1", "type": "audio", "src": "m.mp3", "start": 0, "in": 0, "dur": 5, "speed": 1, "keys": [] }] });
        (proj, vec![Src { rel: "t.mp4".into(), tag: "A".into(), heard }])
    }

    #[test]
    fn ffmpegs_pauses_are_read() {
        let (d, q) = parse_quiet("  Duration: 00:01:02.50, start: 0\n[silencedetect @ 0] silence_start: 1.25\n[silencedetect @ 0] silence_end: 2.5 | silence_duration: 1.25\n[silencedetect @ 0] silence_start: 60\n");
        assert_eq!(d, 62.5);
        assert_eq!(q, vec![(1.25, 2.5), (60.0, 62.5)]);
    }

    #[test]
    fn a_cut_lands_in_the_measured_pauses_and_the_music_plays_on() {
        let (mut p, srcs) = talk();
        let (done, look) = apply(&mut p, &[json!({ "op": "cut", "from": "A2" })], &srcs, &|_| true).unwrap();
        assert!(look.is_empty(), "{look:?}");
        assert!(done[0].contains("“um”"));
        // pause before "um" 0.55-0.95 → cut from 0.67; pause after 1.35-1.95 → to 1.83
        let cs = p["clips"].as_array().unwrap();
        let talk: Vec<&Value> = cs.iter().filter(|c| c["src"] == "t.mp4").collect();
        assert_eq!(talk.len(), 2);
        assert_eq!(talk[0]["dur"], json!(0.67));
        assert_eq!(talk[1]["start"], json!(0.67));
        assert_eq!(talk[1]["in"], json!(1.83));
        // the song is not cut through, only shorter
        let song = cs.iter().find(|c| c["id"] == "song").unwrap();
        assert_eq!((song["in"].as_f64().unwrap(), song["dur"].as_f64().unwrap()), (0.0, 3.84));
        // "um" is gone from what plays; the words after it moved up
        assert!(word_on(&p, &srcs[0], 1).is_err());
        assert!((word_on(&p, &srcs[0], 2).unwrap().0 - (0.67 + 2.0 - 1.83)).abs() < 1e-6);
        assert!(check(&p, &srcs).is_empty(), "{:?}", check(&p, &srcs));
    }

    #[test]
    fn a_cut_with_no_pause_says_so_and_check_finds_a_clipped_word() {
        let (mut p, mut srcs) = talk();
        srcs[0].heard.quiet.clear();
        let (_, look) = apply(&mut p, &[json!({ "op": "cut", "from": "A4", "to": "A4" })], &srcs, &|_| true).unwrap();
        assert_eq!(look.len(), 2);
        // a clip cut by hand inside "today"
        let (mut q, srcs2) = talk();
        q["clips"][0]["in"] = json!(2.2);
        q["clips"][0]["dur"] = json!(2.0);
        assert!(check(&q, &srcs2).iter().any(|x| x.contains("inside the word A3")));
    }

    #[test]
    fn captions_follow_the_words_and_edits_are_all_or_none() {
        let (mut p, srcs) = talk();
        apply(&mut p, &[json!({ "op": "captions", "words": 2 })], &srcs, &|_| true).unwrap();
        let texts: Vec<String> = p["clips"].as_array().unwrap().iter().filter(|c| c["type"] == "text").map(|c| c["text"]["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(texts, vec!["so", "um", "today we", "look."]);
        // one bad edit fails the lot (the tool then writes nothing)
        assert!(apply(&mut p, &[json!({ "op": "pause", "after": "A1" }), json!({ "op": "cut", "from": "A99" })], &srcs, &|_| true).unwrap_err().starts_with("edit 2 (cut)"));
        assert_eq!(tag_of(0), "A");
        assert_eq!(tag_of(26), "AA");
    }

    #[test]
    fn a_file_laid_over_is_asked_for_as_a_vault_path_never_a_network_one() {
        let (mut p, srcs) = talk();
        let asked = std::cell::RefCell::new(Vec::new());
        let r = apply(&mut p, &[json!({ "op": "add", "file": r"\\server\share\x.png", "at": 1.0, "dur": 1.0 })], &srcs, &|f| { asked.borrow_mut().push(f.to_string()); false });
        assert!(r.is_err());
        assert_eq!(asked.borrow().as_slice(), ["server/share/x.png"], "the leading slashes go after the backslashes are turned");
    }
}
