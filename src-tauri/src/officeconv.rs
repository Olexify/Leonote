//! An older Office file (.ppt, .doc, .xls) turned into its newer form (.pptx,
//! .docx, .xlsx) by a program already on the computer - LibreOffice, else
//! PowerPoint, Word or Excel themselves - so the app's
//! own viewer can draw it as designed. Nothing is installed; without either, the
//! app falls back to the text and pictures it reads itself. Results are cached
//! in the temp folder by the file's path, size and time, so a second opening is
//! instant; the vault is never written.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn soffice() -> Option<PathBuf> {
    for base in [std::env::var("ProgramFiles").ok(), std::env::var("ProgramFiles(x86)").ok()].into_iter().flatten() {
        let p = Path::new(&base).join("LibreOffice").join("program").join("soffice.exe");
        if p.exists() { return Some(p); }
    }
    // on PATH
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join("soffice.exe")).find(|p| p.exists()))
}

fn run(mut cmd: std::process::Command, limit: Duration) -> Result<(), String> {
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            return if st.success() { Ok(()) } else { Err(format!("it stopped with {}", st)) };
        }
        if t0.elapsed() > limit { let _ = child.kill(); return Err("it took too long".into()); }
        std::thread::sleep(Duration::from_millis(120));
    }
}

/// The newer form of a vault's .ppt / .doc / .xls, as bytes (base64), made once and kept in temp.
#[tauri::command]
pub async fn office_convert(path: String, state: tauri::State<'_, crate::AppState>) -> Result<String, String> {
    let src = crate::vault::resolve_file(&state.paths.vault, &path)?;
    tauri::async_runtime::spawn_blocking(move || convert(&src)).await.map_err(|e| e.to_string())?
}

pub fn convert(src: &Path) -> Result<String, String> {
    use base64::Engine;
    let ext = src.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    // the newer form, and the Office program that can make it: its automation name, how it opens a
    // file read-only, and the number of the newer format in its SaveAs. The 'x' is a password given in advance: a
    // file that has one fails at once instead of asking in a window nobody can see; other files ignore it
    let (new_ext, app, open, format) = match ext.as_str() {
        "ppt" => ("pptx", "PowerPoint.Application", "$d = $p.Presentations.Open('IN', $true, $false, $false)", 24),
        "doc" => ("docx", "Word.Application", "$p.Visible = $false; $p.DisplayAlerts = 0; $d = $p.Documents.Open('IN', $false, $true, $false, 'x')", 16),
        "xls" => ("xlsx", "Excel.Application", "$p.Visible = $false; $p.DisplayAlerts = $false; $d = $p.Workbooks.Open('IN', 0, $true, [Type]::Missing, 'x')", 51),
        _ => return Err("only .ppt, .doc and .xls are converted".into()),
    };
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    let stamp = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in format!("{}|{}|{}", src.display(), meta.len(), stamp).bytes() { h ^= b as u64; h = h.wrapping_mul(0x1000_0000_01b3); }
    let dir = std::env::temp_dir().join("leonote-office").join(format!("{:016x}", h));
    let out = dir.join(format!("converted.{}", new_ext));
    if !out.exists() {
        // the copies of earlier files go after two weeks: they should not outlive the originals by long
        if let Ok(rd) = std::fs::read_dir(std::env::temp_dir().join("leonote-office")) {
            for d in rd.flatten() {
                let old = d.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|e| e.as_secs() > 14 * 86_400).unwrap_or(false);
                if old { let _ = std::fs::remove_dir_all(d.path()); }
            }
        }
        let _ = std::fs::create_dir_all(&dir);
        // a copy with a plain name: LibreOffice names its output after its input
        let input = dir.join(format!("source.{}", ext));
        std::fs::copy(src, &input).map_err(|e| e.to_string())?;
        let office = match new_ext { "pptx" => "PowerPoint", "docx" => "Word", _ => "Excel" };
        let mut why = format!("neither LibreOffice nor {} is on this computer", office);
        if let Some(lo) = soffice() {
            let mut c = std::process::Command::new(lo);
            // a profile of its own, so a LibreOffice already open does not swallow the job
            let profile = format!("-env:UserInstallation=file:///{}", dir.join("lo-profile").display().to_string().replace('\\', "/"));
            c.args([profile.as_str(), "--headless", "--norestore", "--convert-to", new_ext, "--outdir"]).arg(&dir).arg(&input);
            match run(c, Duration::from_secs(120)) {
                Ok(()) => { let made = dir.join(format!("source.{}", new_ext)); if made.exists() { let _ = std::fs::rename(&made, &out); } }
                Err(e) => why = format!("LibreOffice could not convert it: {}", e),
            }
            let _ = std::fs::remove_dir_all(dir.join("lo-profile"));
        }
        #[cfg(windows)]
        if !out.exists() {
            // the Office program itself, through its own automation: open read-only, save in the newer format, close
            // with every macro off (AutomationSecurity 3 = msoAutomationSecurityForceDisable) before the file opens: a file
            // opened through automation otherwise runs its macros (AutoOpen, Workbook_Open) without a word - and these come from anywhere.
            // Whatever fails, Word or Excel is told to quit, or it stays in memory unseen; not PowerPoint, which is one
            // program shared with what the user has open
            let q = |p: &Path| p.display().to_string().replace('\'', "''");
            let ps = format!(
                "$ErrorActionPreference='Stop'; $p = New-Object -ComObject {}; try {{ $p.AutomationSecurity = 3; {}; try {{ $d.SaveAs('{}', {}) }} finally {{ $d.Close() }} }} finally {{ {} }}",
                app, open.replace("IN", &q(&input)), q(&out), format, if new_ext == "pptx" { "" } else { "$p.Quit()" });
            let mut c = std::process::Command::new(crate::external::program("powershell.exe"));
            c.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
            if let Err(e) = run(c, Duration::from_secs(120)) { if soffice().is_none() { why = format!("LibreOffice is not on this computer, and {} could not convert it ({})", office, e); } }
        }
        let _ = std::fs::remove_file(&input);
        if !out.exists() { return Err(why); }
    }
    let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    /// Converts a real .ppt, .doc or .xls when LEONOTE_PPT names one (and LibreOffice or Office is here):
    /// cargo test --release officeconv -- --ignored
    #[test]
    #[ignore]
    fn a_ppt_becomes_a_pptx() {
        let Ok(p) = std::env::var("LEONOTE_PPT") else { return };
        use base64::Engine;
        let b64 = super::convert(std::path::Path::new(&p)).expect("converted");
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        assert_eq!(&bytes[..2], b"PK", "the newer form is a zip");
        let t0 = std::time::Instant::now();
        super::convert(std::path::Path::new(&p)).unwrap();
        assert!(t0.elapsed().as_millis() < 2000, "the second time comes from the cache");
    }
}
