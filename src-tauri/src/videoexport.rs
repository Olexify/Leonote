//! The video editor's export through ffmpeg: frame by frame, exact.
//!
//! The page draws each frame of the timeline at its exact time (every video
//! seeked there first, so nothing is dropped or doubled however slow the
//! machine is) and sends it as a JPEG; the sound is mixed beforehand, offline,
//! as a WAV. ffmpeg - the user's own - joins them
//! into an H.264/AAC MP4 at the quality asked, written under a hidden name and
//! given its own once whole. The WAV is a temporary file of our own, removed
//! when the export ends either way.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

struct Job {
    out: PathBuf,
    part: PathBuf,
    wav: PathBuf,
    has_audio: bool,
    fps: u32,
    crf: u32,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

static JOBS: Mutex<Option<HashMap<u64, Job>>> = Mutex::new(None);
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn with<T>(id: u64, f: impl FnOnce(&mut Job) -> Result<T, String>) -> Result<T, String> {
    let mut g = crate::lock(&JOBS);
    let job = g.get_or_insert_with(HashMap::new).get_mut(&id).ok_or("that export is over")?;
    f(job)
}
fn take(id: u64) -> Option<Job> { crate::lock(&JOBS).get_or_insert_with(HashMap::new).remove(&id) }

/// The ffmpeg command line for a job (without the program itself).
pub fn args(fps: u32, crf: u32, wav: Option<&str>, out: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate"].map(String::from).to_vec();
    a.push(fps.to_string());
    a.extend(["-i", "-"].map(String::from));
    if let Some(w) = wav { a.extend(["-i".to_string(), w.to_string()]); }
    a.extend(["-map", "0:v"].map(String::from));
    if wav.is_some() { a.extend(["-map", "1:a", "-c:a", "aac", "-b:a", "192k"].map(String::from)); }
    a.extend(["-c:v", "libx264", "-preset", "medium", "-crf"].map(String::from));
    a.push(crf.clamp(10, 35).to_string());
    a.extend(["-pix_fmt", "yuv420p", "-r"].map(String::from));
    a.push(fps.to_string());
    a.extend(["-movflags", "+faststart", "-f", "mp4", out].map(String::from));
    a
}

/// ffmpeg's arguments for a GIF from piped frames: its own palette made from the frames, looping forever.
pub fn gif_args(fps: u32, out: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate"].map(String::from).to_vec();
    a.push(fps.to_string());
    a.extend(["-i", "-", "-vf", "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a", "-loop", "0", "-f", "gif", out].map(String::from));
    a
}

/// A new export into `rel` (a vault path ending in .mp4). Nothing runs yet: the sound comes first, if there is any.
#[tauri::command]
pub fn video_export_begin(rel: String, fps: u32, crf: u32, audio: bool, state: tauri::State<'_, crate::AppState>) -> Result<Value, String> {
    let rel = rel.trim().trim_matches('/').replace('\\', "/");
    if rel.split('/').any(|s| s == ".." || s.is_empty()) || rel.contains(':') || !(rel.to_ascii_lowercase().ends_with(".mp4") || rel.to_ascii_lowercase().ends_with(".gif")) { return Err("not a vault path for a video or a GIF".into()); }
    // the shared check: no junction out of the vault, no dot folder, no reserved name, never an outside file
    if crate::vault::is_guest(&rel) { return Err("not a vault path for a video or a GIF".into()); }
    let out = crate::vault::resolve(&state.paths.vault, &rel)?;
    if let Some(d) = out.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let ext = if rel.to_ascii_lowercase().ends_with(".gif") { "gif" } else { "mp4" };
    let part = out.with_file_name(format!(".{}.part.{ext}", out.file_name().and_then(|n| n.to_str()).unwrap_or("video")));
    let wav = std::env::temp_dir().join(format!("leonote-export-{}-{}.wav", std::process::id(), id));
    crate::lock(&JOBS).get_or_insert_with(HashMap::new).insert(id, Job { out, part, wav, has_audio: audio, fps: fps.clamp(1, 120), crf, child: None, stdin: None });
    Ok(json!({ "id": id }))
}

fn id_of(request: &tauri::ipc::Request<'_>) -> Result<u64, String> {
    request.headers().get("x-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or("missing x-id".to_string())
}

/// The mixed sound, as a WAV.
#[tauri::command]
pub async fn video_export_audio(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = id_of(&request)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    with(id, |j| std::fs::write(&j.wav, bytes).map_err(|e| e.to_string()))
}

/// ffmpeg starts, waiting for frames.
#[tauri::command]
pub async fn video_export_start(id: u64) -> Result<(), String> {
    let ffmpeg = crate::external::tool_path("ffmpeg", None).ok_or("ffmpeg is not on this computer - Settings › Optional modules can install it")?;
    with(id, |j| {
        let wav = if j.has_audio && j.wav.exists() { Some(j.wav.to_string_lossy().into_owned()) } else { None };
        let mut cmd = Command::new(&ffmpeg);
        let part = j.part.to_string_lossy().into_owned();
        let a = if part.ends_with(".gif") { gif_args(j.fps, &part) } else { args(j.fps, j.crf, wav.as_deref(), &part) };
        cmd.args(a).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
        let mut child = cmd.spawn().map_err(|e| format!("ffmpeg did not start: {e}"))?;
        j.stdin = child.stdin.take();
        j.child = Some(child);
        Ok(())
    })
}

/// One frame, a JPEG.
#[tauri::command]
pub async fn video_export_frame(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = id_of(&request)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
    let stdin = with(id, |j| j.stdin.as_ref().and_then(|s| s.try_clone_handle()).ok_or("the export is not running".to_string()))?;
    let mut s = stdin;
    s.write_all(bytes).map_err(|e| format!("ffmpeg stopped taking frames: {e}"))
}

/// The last frame is in: ffmpeg finishes, and the video takes its own name. Returns its vault path.
#[tauri::command]
pub async fn video_export_end(id: u64, rel: String) -> Result<Value, String> {
    let mut j = take(id).ok_or("that export is over")?;
    tauri::async_runtime::spawn_blocking(move || {
        drop(j.stdin.take());
        let mut err = String::new();
        let ok = match j.child.take() {
            Some(mut c) => { if let Some(mut e) = c.stderr.take() { let _ = e.read_to_string(&mut err); } c.wait().map(|s| s.success()).unwrap_or(false) }
            None => false,
        };
        let _ = std::fs::remove_file(&j.wav);
        if !ok { let _ = std::fs::remove_file(&j.part); return Err(format!("ffmpeg could not make the video: {}", err.lines().last().unwrap_or("it stopped"))); }
        std::fs::rename(&j.part, &j.out).map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&j.out).map(|m| m.len()).unwrap_or(0);
        Ok(json!({ "path": rel, "size": size }))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn video_export_cancel(id: u64) {
    if let Some(mut j) = take(id) {
        drop(j.stdin.take());
        if let Some(mut c) = j.child.take() { let _ = c.kill(); let _ = c.wait(); }
        let _ = std::fs::remove_file(&j.part);
        let _ = std::fs::remove_file(&j.wav);
    }
}

/// ChildStdin cannot be cloned; frames are written through a duplicate of its handle so the lock is not held while ffmpeg reads.
trait CloneHandle { fn try_clone_handle(&self) -> Option<std::fs::File>; }
impl CloneHandle for ChildStdin {
    fn try_clone_handle(&self) -> Option<std::fs::File> {
        #[cfg(windows)]
        { use std::os::windows::io::{AsHandle, OwnedHandle}; let h: OwnedHandle = self.as_handle().try_clone_to_owned().ok()?; Some(std::fs::File::from(h)) }
        #[cfg(unix)]
        { use std::os::fd::{AsFd, OwnedFd}; let h: OwnedFd = self.as_fd().try_clone_to_owned().ok()?; Some(std::fs::File::from(h)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gif_from_frames() {
        let a = gif_args(12, "o.gif").join(" ");
        assert!(a.contains("-framerate 12") && a.contains("palettegen") && a.ends_with("-loop 0 -f gif o.gif"));
        let Some(ff) = crate::external::tool_path("ffmpeg", None) else { return };
        let dir = std::env::temp_dir().join(format!("leonote-gif-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let jpg = dir.join("f.jpg");
        if !Command::new(&ff).args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=green:s=64x64:d=0.04", "-frames:v", "1"]).arg(&jpg).status().map(|s| s.success()).unwrap_or(false) { return; }
        let frame = std::fs::read(&jpg).unwrap();
        let out = dir.join("o.gif");
        let mut c = Command::new(&ff).args(gif_args(12, &out.to_string_lossy())).stdin(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        { let mut s = c.stdin.take().unwrap(); for _ in 0..4 { s.write_all(&frame).unwrap(); } }
        assert!(c.wait().unwrap().success());
        assert!(std::fs::read(&out).unwrap().starts_with(b"GIF8"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_command_line() {
        let a = args(30, 19, Some("a.wav"), "out.mp4");
        let s = a.join(" ");
        assert!(s.starts_with("-y -hide_banner -loglevel error -f image2pipe -c:v mjpeg -framerate 30 -i - -i a.wav -map 0:v -map 1:a -c:a aac"));
        assert!(s.contains("-crf 19") && s.ends_with("-movflags +faststart -f mp4 out.mp4"));
        let n = args(24, 99, None, "o.mp4").join(" ");
        assert!(!n.contains("1:a") && n.contains("-crf 35"));
    }

    /// With ffmpeg here: three frames piped in become an MP4 (skipped where ffmpeg is not installed).
    #[test]
    fn ffmpeg_makes_a_video_from_frames() {
        let Some(ff) = crate::external::tool_path("ffmpeg", None) else { return };
        let dir = std::env::temp_dir().join(format!("leonote-vx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // one tiny JPEG made by ffmpeg itself, sent three times
        let jpg = dir.join("f.jpg");
        let ok = Command::new(&ff).args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.04", "-frames:v", "1"]).arg(&jpg).status().map(|s| s.success()).unwrap_or(false);
        if !ok { return; }
        let frame = std::fs::read(&jpg).unwrap();
        let out = dir.join("v.mp4");
        let mut c = Command::new(&ff).args(args(10, 23, None, &out.to_string_lossy())).stdin(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        { let mut s = c.stdin.take().unwrap(); for _ in 0..3 { s.write_all(&frame).unwrap(); } }
        assert!(c.wait().unwrap().success());
        let b = std::fs::read(&out).unwrap();
        assert!(b.len() > 200 && &b[4..8] == b"ftyp", "an mp4");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod audio_tests {
    use super::*;
    /// Frames plus a WAV through the same command line: the MP4 has picture and sound.
    #[test]
    fn frames_and_sound() {
        let Some(ff) = crate::external::tool_path("ffmpeg", None) else { return };
        let dir = std::env::temp_dir().join(format!("leonote-vxa-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let jpg = dir.join("f.jpg");
        if !Command::new(&ff).args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.04", "-frames:v", "1"]).arg(&jpg).status().map(|s| s.success()).unwrap_or(false) { return; }
        // one second of a 440 Hz tone, 48 kHz stereo 16-bit, written the way the page writes it
        let (rate, n) = (48000u32, 48000usize);
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF"); w.extend_from_slice(&(36 + n as u32 * 4).to_le_bytes()); w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes()); w.extend_from_slice(&1u16.to_le_bytes()); w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&rate.to_le_bytes()); w.extend_from_slice(&(rate * 4).to_le_bytes()); w.extend_from_slice(&4u16.to_le_bytes()); w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data"); w.extend_from_slice(&(n as u32 * 4).to_le_bytes());
        for i in 0..n { let s = ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 8000.0) as i16; w.extend_from_slice(&s.to_le_bytes()); w.extend_from_slice(&s.to_le_bytes()); }
        let wav = dir.join("a.wav");
        std::fs::write(&wav, &w).unwrap();
        let frame = std::fs::read(&jpg).unwrap();
        let out = dir.join("v.mp4");
        let mut c = Command::new(&ff).args(args(10, 23, Some(&wav.to_string_lossy()), &out.to_string_lossy())).stdin(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        { let mut s = c.stdin.take().unwrap(); for _ in 0..10 { s.write_all(&frame).unwrap(); } }
        assert!(c.wait().unwrap().success());
        if let Some(probe) = crate::external::tool_path("ffprobe", None) {
            let o = Command::new(probe).args(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0"]).arg(&out).output().unwrap();
            let s = String::from_utf8_lossy(&o.stdout);
            assert!(s.contains("video") && s.contains("audio"), "{s}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
