//! Files copied in Explorer (Ctrl+C) pasted into a vault folder. The webview
//! only sees file contents one by one, so the list of paths comes straight
//! from the Windows clipboard and the copying happens here, streamed by the
//! OS - big files and whole folders are fine.

use std::path::{Path, PathBuf};

/// Paths on the clipboard (CF_HDROP), in order. Empty when there are none.
#[cfg(windows)]
pub fn clipboard_files() -> Vec<PathBuf> {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    const CF_HDROP: u32 = 15;
    let mut out = Vec::new();
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_err() || OpenClipboard(None).is_err() {
            return out;
        }
        if let Ok(HANDLE(h)) = GetClipboardData(CF_HDROP) {
            let g = HGLOBAL(h);
            let ptr = GlobalLock(g);
            if !ptr.is_null() {
                let drop = HDROP(ptr);
                let n = DragQueryFileW(drop, u32::MAX, None);
                for i in 0..n.min(10_000) {
                    let len = DragQueryFileW(drop, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    let got = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
                    out.push(PathBuf::from(String::from_utf16_lossy(&buf[..got.min(len)])));
                }
                let _ = GlobalUnlock(g);
            }
        }
        let _ = CloseClipboard();
    }
    out
}

#[cfg(not(windows))]
pub fn clipboard_files() -> Vec<PathBuf> {
    Vec::new()
}

/// A name in `dir` that isn't taken: "a.pdf", "a 2.pdf", "a 3.pdf"...
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..10_000)
        .map(|n| dir.join(format!("{} {}{}", stem, n, ext)))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Copy a file or a whole folder to `to` (which must not exist yet).
pub fn copy_any(from: &Path, to: &Path) -> std::io::Result<u64> {
    let md = std::fs::symlink_metadata(from)?;
    if md.is_dir() {
        std::fs::create_dir_all(to)?;
        let mut n = 0;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            n += copy_any(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(n)
    } else if md.is_file() {
        std::fs::copy(from, to)?;
        Ok(1)
    } else {
        Ok(0) // links and devices are left out
    }
}

/// Picking a free name and filling it are one step for the long copies, which run without the app's write lock.
// ponytail: an import or restore landing the same name in the same instant as a paste can still collide; they hold state.io, and waiting here would stall every save
pub static PASTE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Copy `sources` into `dir`, never overwriting. Returns the vault-relative
/// paths created (top-level items) and how many files were copied in total.
pub fn paste_into(vault: &Path, dir: &Path, sources: &[PathBuf]) -> Result<(Vec<String>, u64), String> {
    let _paste = crate::lock(&PASTE);
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let vault_abs = std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
    let dir_abs = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut made = Vec::new();
    let mut files = 0;
    for src in sources {
        let Some(name) = src.file_name().and_then(|n| n.to_str()) else { continue };
        // a folder can't be pasted into itself
        if let Ok(s) = std::fs::canonicalize(src) {
            if dir_abs.starts_with(&s) {
                return Err(format!("can't paste {} into itself", name));
            }
        }
        let to = free_name(dir, name);
        files += copy_any(src, &to).map_err(|e| format!("{}: {}", name, e))?;
        let to_abs = std::fs::canonicalize(&to).unwrap_or(to);
        if let Ok(rel) = to_abs.strip_prefix(&vault_abs) {
            made.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok((made, files))
}

/// A secret (a password) put on the clipboard as password managers do: marked so Windows keeps it out of the
/// clipboard history (Win+V) and the cloud clipboard, and taken off again after `clear_after` unless something
/// else was copied meanwhile.
/// The clipboard's number when a secret went on it, for the clearing at exit.
#[cfg(windows)]
static SECRET_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Another program may hold the clipboard a moment: tried for about a third of a second.
#[cfg(windows)]
fn open_patiently(mut open: impl FnMut() -> bool) -> bool {
    for _ in 0..20 {
        if open() { return true; }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    open()
}

/// Take the secret off, if it is still what is on the clipboard: nothing copied since.
#[cfg(windows)]
fn clear_if_ours(seq: u32) {
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard};
    unsafe {
        if GetClipboardSequenceNumber() == seq && open_patiently(|| OpenClipboard(None).is_ok()) {
            let _ = EmptyClipboard();
            let _ = CloseClipboard();
        }
    }
}

/// Leonote is closing: the 30-second timer dies with it, so the secret goes now.
#[cfg(windows)]
pub fn clear_secret() {
    let seq = SECRET_SEQ.swap(0, std::sync::atomic::Ordering::SeqCst);
    if seq != 0 { clear_if_ours(seq); }
}
#[cfg(not(windows))]
pub fn clear_secret() {}

#[cfg(windows)]
pub fn copy_secret(text: &str, clear_after: std::time::Duration) -> Result<(), String> {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_core::w;
    const CF_UNICODETEXT: u32 = 13;
    /// One clipboard entry, `bytes` copied into memory the clipboard then owns.
    unsafe fn put(format: u32, bytes: &[u8]) -> Result<(), String> {
        let g: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| e.to_string())?;
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() { return Err("no memory for the clipboard".into()); }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(g);
        SetClipboardData(format, Some(HANDLE(g.0))).map(|_| ()).map_err(|e| e.to_string())
    }
    let wide: Vec<u8> = text.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect();
    let seq = unsafe {
        if !open_patiently(|| OpenClipboard(None).is_ok()) { return Err("the clipboard is busy - try again".into()); }
        let r = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;
            put(CF_UNICODETEXT, &wide)?;
            // not into Win+V's history, not to other devices; clipboard watchers asked to look away
            put(RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")), &[0])?;
            put(RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")), &0u32.to_le_bytes())?;
            put(RegisterClipboardFormatW(w!("CanUploadToCloudClipboard")), &0u32.to_le_bytes())?;
            Ok(())
        })();
        let _ = CloseClipboard();
        r?;
        GetClipboardSequenceNumber()
    };
    SECRET_SEQ.store(seq, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(clear_after);
        clear_if_ours(seq);
    });
    Ok(())
}
#[cfg(not(windows))]
pub fn copy_secret(_text: &str, _clear_after: std::time::Duration) -> Result<(), String> { Err("copying a password is only in the Windows app".into()) }

#[cfg(all(test, windows))]
mod secret_tests {
    #[test]
    fn a_clipboard_held_a_moment_is_waited_for() {
        let mut held = 3;
        assert!(super::open_patiently(|| { held -= 1; held < 0 }));
        assert!(!super::open_patiently(|| false));
    }
}
