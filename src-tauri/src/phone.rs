//! A phone plugged in by USB, and HEIC pictures.
//!
//! A phone is not a drive: Windows reaches it through Portable Devices (MTP),
//! one request at a time, which is what makes Explorer crawl on a folder of
//! thousands of photos. Here the listing runs on a thread of its own and is
//! sent to the page in batches as it comes (the first photos show at once),
//! thumbnails come from the phone's own small copies on a second thread, and
//! copying runs on a third - so none of them waits for the others.
//!
//! Every thread keeps the device open once instead of opening it per request.
//! COM objects stay on the thread that made them: work is sent to a thread as
//! a closure and the answer comes back over a channel.
//!
//! HEIC (iPhone photos) the webview cannot show: Windows' own image codecs
//! decode it (the free "HEIF Image Extensions", with "HEVC Video Extensions"
//! for most photos) and it is handed on as a JPEG, through the `heic://`
//! scheme so every <img> in the app can simply point at it.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// A folder the scan leaves out when told to skip the system's own: hidden ones, and Android/data and Android/obb
/// (apps' private files). Not the rest of Android: Android/media is where WhatsApp, Telegram and others keep
/// the user's photos and videos. `path` is the folder it lies in, `depth` 1 a storage's top.
pub fn skip_system_folder(name: &str, path: &str, depth: usize) -> bool {
    name.starts_with('.') || (depth == 2 && path.rsplit('/').next() == Some("Android") && matches!(name, "data" | "obb"))
}
/// A folder read before the others, its subfolders too (`folder`: "<storage>/DCIM/Camera"): where the newest
/// photos and videos usually are, so they show within moments on a phone that takes minutes to read.
pub fn read_first(folder: &str) -> bool {
    matches!(folder.split('/').nth(1), Some("DCIM" | "Movies" | "Pictures" | "Download" | "Camera"))
}

/// How far a scan is, and how it ended: `unread` folders it could not read, `gone` the phone stopped answering,
/// `stopped` the user stopped it - in all three what was found is only part of the phone.
#[derive(Clone, Copy, Default, Debug)]
pub struct ScanState { pub folders: usize, pub unread: usize, pub gone: bool, pub stopped: bool, pub done: bool }

/// Every file on the phone, folder by folder, sent in batches to `sink`. `read` hands over what is in one folder as it
/// comes and fails if the phone did not answer: a phone answers one thing at a time and may be busy, so that folder is
/// read again after the others (what already came is not sent twice), and a whole folder is never lost in silence.
pub fn walk(skip_system: bool, stop: &std::sync::atomic::AtomicBool, mut read: impl FnMut(&str, &mut dyn FnMut(Value)) -> Result<(), String>, mut sink: impl FnMut(Vec<Value>, ScanState)) {
    const TRIES: u32 = 3;
    const GIVE_UP: u32 = 8; // this many failures in a row, some seconds apart: unplugged, or not answering at all
    let mut todo = std::collections::VecDeque::from([("DEVICE".to_string(), String::new(), 0usize, 1u32)]);
    let mut seen = std::collections::HashSet::new();
    let mut batch = Vec::new();
    let mut st = ScanState::default();
    let mut failing = 0u32;
    while let Some((pid, path, depth, tries)) = todo.pop_front() {
        if stop.load(std::sync::atomic::Ordering::Relaxed) { st.stopped = true; break; }
        if tries == 1 { st.folders += 1; }
        let r = read(&pid, &mut |mut it| {
            let id = it["id"].as_str().unwrap_or("").to_string();
            if !seen.insert(id.clone()) { return; }
            if it["dir"].as_bool().unwrap_or(false) {
                let name = it["name"].as_str().unwrap_or("");
                if skip_system && skip_system_folder(name, &path, depth) { return; }
                let folder = if path.is_empty() { name.to_string() } else { format!("{path}/{name}") };
                if read_first(&folder) { todo.push_front((id, folder, depth + 1, 1)); } else { todo.push_back((id, folder, depth + 1, 1)); }
            } else {
                it["path"] = json!(path);
                it["parent"] = json!(pid);
                batch.push(it);
                if batch.len() >= 200 { sink(std::mem::take(&mut batch), st); }
            }
        });
        if r.is_ok() { failing = 0; continue; }
        failing += 1;
        if failing >= GIVE_UP { st.gone = true; st.unread += 1 + todo.len(); break; }
        std::thread::sleep(std::time::Duration::from_millis(if cfg!(test) { 1 } else { 250 * failing as u64 }));
        if tries < TRIES { todo.push_back((pid, path, depth, tries + 1)); } else { st.unread += 1; }
    }
    st.done = true;
    sink(batch, st);
}

/// A file name as the phone gives it, made safe for Windows.
pub fn safe_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() { return "file".into(); }
    // CON.jpg, nul.txt, COM1.png: names Windows keeps for devices - kept, with a mark in front
    if crate::vault::is_device_name(s.split('.').next().unwrap_or("")) { format!("_{s}") } else { s }
}

/// `dir/name`, or `dir/name (2).ext` and so on when that is taken.
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() { return p; }
    let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i..]), _ => (name, "") };
    (2..10000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(p)
}

/// A file read to its end: `read` fills the buffer and says how much came and whether it failed, `take` gets what came.
/// A failed read is not the end of the file, nor is one that stops short of `size` (0: not known): part of a file never passes for the file.
pub fn read_whole(size: u64, buf_len: usize, mut read: impl FnMut(&mut [u8]) -> (usize, bool), mut take: impl FnMut(&[u8]) -> Result<(), String>) -> Result<u64, String> {
    let mut buf = vec![0u8; buf_len];
    let mut got = 0u64;
    loop {
        let (n, failed) = read(&mut buf);
        if n > 0 { take(&buf[..n])?; got += n as u64; }
        if failed && (size == 0 || got != size) { return Err(format!("the phone stopped answering after {got} bytes")); }
        if failed || n == 0 {
            if size > 0 && got != size { return Err(format!("{got} of {size} bytes came over")); }
            return Ok(got);
        }
    }
}

/// Whether what the phone lists now is the file that was fetched (`fetched`: its length). A phone that reports no size says 0: then the name has to do.
pub fn same_file(it: &Value, name: &str, fetched: Option<u64>) -> bool {
    it["name"] == name && matches!((it["size"].as_u64(), fetched), (Some(s), Some(f)) if s == 0 || s == f)
}

#[cfg(windows)]
pub(crate) mod win {
    use super::*;
    use std::collections::HashMap;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use windows::core::{Interface, GUID, PCWSTR, PWSTR};
    use windows::Win32::Devices::PortableDevices::*;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantToFileTime, PROPVARIANT};
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Variant::{PSTF_UTC, VT_ERROR, VT_LPWSTR};

    type Job = Box<dyn FnOnce(&mut Devices) + Send>;
    /// The devices a thread has open, by their id.
    pub struct Devices(HashMap<String, IPortableDevice>);

    impl Devices {
        fn get(&mut self, id: &str) -> Result<IPortableDevice, String> {
            if let Some(d) = self.0.get(id) { return Ok(d.clone()); }
            let d = unsafe { open(id) }?;
            self.0.insert(id.to_string(), d.clone());
            Ok(d)
        }
        fn forget(&mut self, id: &str) { if let Some(d) = self.0.remove(id) { unsafe { let _ = d.Close(); } } }
    }

    /// A thread of its own, COM ready, running what is sent to it in order.
    fn worker(slot: &'static OnceLock<Mutex<Sender<Job>>>) -> Sender<Job> {
        slot.get_or_init(|| {
            let (tx, rx) = channel::<Job>();
            std::thread::spawn(move || {
                unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
                let mut devs = Devices(HashMap::new());
                // one job that fails badly does not take the phone away for the rest of the session
                for job in rx { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut devs))); }
            });
            Mutex::new(tx)
        }).lock().unwrap().clone()
    }
    static LISTER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
    static THUMBS: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
    static MOVER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

    /// Run `f` on a worker and wait for its answer. A device gone (unplugged) is forgotten, so the next call opens it again.
    pub fn on<T: Send + 'static>(which: u8, dev: Option<String>, f: impl FnOnce(&mut Devices) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (tx, rx) = channel();
        let w = worker(match which { 0 => &LISTER, 1 => &THUMBS, _ => &MOVER });
        w.send(Box::new(move |d: &mut Devices| {
            let r = f(d);
            if r.is_err() { if let Some(id) = &dev { d.forget(id); } }
            let _ = tx.send(r);
        })).map_err(|_| "the phone thread stopped".to_string())?;
        rx.recv().map_err(|_| "the phone thread stopped".to_string())?
    }
    /// Send work to a worker without waiting (a long copy).
    pub fn post(which: u8, f: impl FnOnce(&mut Devices) + Send + 'static) {
        let w = worker(match which { 0 => &LISTER, 1 => &THUMBS, _ => &MOVER });
        let _ = w.send(Box::new(f));
    }

    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    unsafe fn take(p: PWSTR) -> String {
        if p.is_null() { return String::new(); }
        let s = unsafe { p.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(p.0 as _)) };
        s
    }

    unsafe fn open(id: &str) -> Result<IPortableDevice, String> {
        unsafe {
            let dev: IPortableDevice = CoCreateInstance(&PortableDeviceFTM, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let info: IPortableDeviceValues = CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let w = wide(id);
            dev.Open(PCWSTR(w.as_ptr()), &info).map_err(|e| format!("could not open the phone ({e}) - unlock it and allow file transfer"))?;
            Ok(dev)
        }
    }

    /// The phones and cameras plugged in: [{ id, name }].
    pub fn devices() -> Result<Value, String> {
        on(0, None, |_| unsafe {
            let m: IPortableDeviceManager = CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let _ = m.RefreshDeviceList();
            let mut n = 0u32;
            m.GetDevices(std::ptr::null_mut(), &mut n).map_err(|e| e.to_string())?;
            let mut ids = vec![PWSTR::null(); n as usize];
            if n > 0 { m.GetDevices(ids.as_mut_ptr(), &mut n).map_err(|e| e.to_string())?; }
            let mut out = Vec::new();
            for p in ids.into_iter().take(n as usize) {
                let id = take(p);
                let w = wide(&id);
                let mut len = 0u32;
                let _ = m.GetDeviceFriendlyName(PCWSTR(w.as_ptr()), PWSTR::null(), &mut len);
                let mut buf = vec![0u16; len.max(1) as usize];
                let name = if m.GetDeviceFriendlyName(PCWSTR(w.as_ptr()), PWSTR(buf.as_mut_ptr()), &mut len).is_ok() { String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]) } else { String::new() };
                out.push(json!({ "id": id, "name": if name.is_empty() { "Phone".to_string() } else { name } }));
            }
            Ok(json!(out))
        })
    }

    unsafe fn keys() -> Result<IPortableDeviceKeyCollection, String> {
        unsafe {
            let k: IPortableDeviceKeyCollection = CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            for key in [WPD_OBJECT_ORIGINAL_FILE_NAME, WPD_OBJECT_NAME, WPD_OBJECT_SIZE, WPD_OBJECT_CONTENT_TYPE, WPD_OBJECT_DATE_MODIFIED, WPD_STORAGE_CAPACITY, WPD_STORAGE_FREE_SPACE_IN_BYTES] {
                let _ = k.Add(&key);
            }
            Ok(k)
        }
    }

    /// One object's details: { id, name, size, dir, mtime (ms), cap, free }.
    unsafe fn item(props: &IPortableDeviceProperties, k: &IPortableDeviceKeyCollection, id: &str) -> Option<Value> {
        unsafe {
            let w = wide(id);
            let v = props.GetValues(PCWSTR(w.as_ptr()), k).ok()?;
            let s = |key: &PROPERTYKEY| v.GetStringValue(key).map(|p| take(p)).ok().filter(|s| !s.is_empty());
            let name = s(&WPD_OBJECT_ORIGINAL_FILE_NAME).or_else(|| s(&WPD_OBJECT_NAME)).unwrap_or_else(|| id.to_string());
            let ty: GUID = v.GetGuidValue(&WPD_OBJECT_CONTENT_TYPE).unwrap_or_default();
            let dir = ty == WPD_CONTENT_TYPE_FOLDER || ty == WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT;
            let size = v.GetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE).unwrap_or(0);
            let mtime = v.GetValue(&WPD_OBJECT_DATE_MODIFIED).ok().and_then(|pv: PROPVARIANT| PropVariantToFileTime(&pv, PSTF_UTC).ok())
                .map(|ft| ((((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64) / 10_000).saturating_sub(11_644_473_600_000)).unwrap_or(0);
            let cap = v.GetUnsignedLargeIntegerValue(&WPD_STORAGE_CAPACITY).ok();
            let free = v.GetUnsignedLargeIntegerValue(&WPD_STORAGE_FREE_SPACE_IN_BYTES).ok();
            Some(json!({ "id": id, "name": name, "size": if dir { 0 } else { size }, "dir": dir, "mtime": mtime, "cap": cap, "free": free }))
        }
    }

    /// Every file on the phone (see super::walk). Each file carries `path` (its folders,
    /// "Internal storage/DCIM/Camera") and `parent` (its folder's id).
    /// `skip_system`: leaves out hidden folders and Android's own (see skip_system_folder).
    pub fn scan(dev: String, skip_system: bool, stop: std::sync::Arc<std::sync::atomic::AtomicBool>, sink: impl FnMut(Vec<Value>, ScanState) + Send + 'static) -> Result<(), String> {
        let d2 = dev.clone();
        on(0, Some(dev), move |devs| unsafe {
            let device = devs.get(&d2)?;
            let content = device.Content().map_err(|e| e.to_string())?;
            let props = content.Properties().map_err(|e| e.to_string())?;
            let k = keys()?;
            super::walk(skip_system, &stop, |pid, found| {
                let wp = wide(pid);
                let en = content.EnumObjects(0, PCWSTR(wp.as_ptr()), None).map_err(|e| e.to_string())?;
                let mut missing = 0;
                loop {
                    let mut ids = vec![PWSTR::null(); 64];
                    let mut got = 0u32;
                    let hr = en.Next(&mut ids, &mut got);
                    for p in ids.into_iter().take(got as usize) {
                        let id = take(p);
                        match item(&props, &k, &id).or_else(|| item(&props, &k, &id)) { Some(it) => found(it), None => missing += 1 }
                    }
                    if hr.is_err() { return Err(format!("{hr:?}")); }
                    // only nothing means the end: fewer than asked for may just be all it had ready
                    if got == 0 { break; }
                }
                if missing > 0 { Err(format!("{missing} could not be read")) } else { Ok(()) }
            }, sink);
            Ok(())
        })
    }

    /// What is in a folder of the phone ("" = its top: the storages), sent in batches to `sink` as it is read.
    pub fn list(dev: String, parent: String, sink: impl Fn(Vec<Value>, bool) + Send + 'static) -> Result<(), String> {
        let d2 = dev.clone();
        on(0, Some(dev.clone()), move |devs| unsafe {
            let device = devs.get(&d2)?;
            let content = device.Content().map_err(|e| e.to_string())?;
            let props = content.Properties().map_err(|e| e.to_string())?;
            let k = keys()?;
            let pid = if parent.is_empty() { "DEVICE".to_string() } else { parent };
            let wp = wide(&pid);
            let en = content.EnumObjects(0, PCWSTR(wp.as_ptr()), None).map_err(|e| e.to_string())?;
            let mut batch = Vec::new();
            let mut sent_first = false;
            loop {
                let mut ids = vec![PWSTR::null(); 64];
                let mut got = 0u32;
                let hr = en.Next(&mut ids, &mut got);
                for p in ids.into_iter().take(got as usize) {
                    let id = take(p);
                    if let Some(it) = item(&props, &k, &id) { batch.push(it); }
                    // the first few at once, then in bigger steps
                    if batch.len() >= if sent_first { 150 } else { 30 } { sink(std::mem::take(&mut batch), false); sent_first = true; }
                }
                if hr.is_err() || got == 0 { break; }
            }
            sink(batch, true);
            Ok(())
        })
    }

    unsafe fn read_resource(device: &IPortableDevice, id: &str, key: &PROPERTYKEY, max: u64) -> Result<Vec<u8>, String> {
        unsafe {
            let res = device.Content().and_then(|c| c.Transfer()).map_err(|e| e.to_string())?;
            let w = wide(id);
            let mut opt = 0u32;
            let mut stream: Option<IStream> = None;
            res.GetStream(PCWSTR(w.as_ptr()), key, 0 /* STGM_READ */, &mut opt, &mut stream).map_err(|e| e.to_string())?;
            let stream = stream.ok_or("no data")?;
            let mut out = Vec::new();
            let mut buf = vec![0u8; (opt as usize).clamp(64 * 1024, 1024 * 1024)];
            loop {
                let mut n = 0u32;
                let hr = stream.Read(buf.as_mut_ptr() as _, buf.len() as u32, Some(&mut n));
                if n > 0 { out.extend_from_slice(&buf[..n as usize]); }
                if out.len() as u64 > max { return Err("too big to show here - copy it to the computer".into()); }
                if hr.is_err() || n == 0 { break; }
            }
            Ok(out)
        }
    }

    /// The phone's own small picture of a photo or a video, if it has one.
    pub fn thumb(dev: String, id: String) -> Result<Vec<u8>, String> {
        let d2 = dev.clone();
        on(1, Some(dev), move |devs| unsafe { let d = devs.get(&d2)?; read_resource(&d, &id, &WPD_RESOURCE_THUMBNAIL, 8 << 20) })
    }
    /// A whole file from the phone (to show it: a photo, a HEIC), up to `max` bytes.
    pub fn file(dev: String, id: String, max: u64) -> Result<Vec<u8>, String> {
        let d2 = dev.clone();
        on(1, Some(dev), move |devs| unsafe { let d = devs.get(&d2)?; read_resource(&d, &id, &WPD_RESOURCE_DEFAULT, max) })
    }

    /// Files off the phone into `dir`, one by one: each written whole to a hidden name first, then
    /// given its own; `remove` takes it off the phone once it is safely here (size checked).
    pub fn copy(dev: String, items: Vec<(String, String, u64, u64)>, dir: PathBuf, remove: bool, progress: impl Fn(Value) + Send + 'static) {
        post(2, move |devs| unsafe {
            let total = items.len();
            let mut done = 0usize;
            let mut failed = 0usize;
            let mut moved: Vec<String> = Vec::new();
            let mut copied: Vec<String> = Vec::new();
            let device = match devs.get(&dev) { Ok(d) => d, Err(e) => { progress(json!({ "done": 0, "total": total, "failed": total, "error": e, "finished": true })); return; } };
            let _ = std::fs::create_dir_all(&dir);
            for (id, name, size, mtime) in items {
                let target = free_path(&dir, &safe_name(&name));
                let part = target.with_extension(format!("{}.part", target.extension().and_then(|e| e.to_str()).unwrap_or("")));
                let r = (|| -> Result<(), String> {
                    use std::io::Write;
                    let mut f = std::io::BufWriter::new(std::fs::File::create(&part).map_err(|e| e.to_string())?);
                    stream_whole(&device, &id, size, |b| f.write_all(b).map_err(|e| e.to_string()))?;
                    f.flush().map_err(|e| e.to_string())?;
                    // on the disk, not only in Windows' cache, before the phone's copy can go (Move deletes it next)
                    f.get_ref().sync_all().map_err(|e| e.to_string())?;
                    drop(f);
                    std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
                    if mtime > 0 { let _ = filetime::set_file_mtime(&target, filetime::FileTime::from_unix_time((mtime / 1000) as i64, 0)); }
                    Ok(())
                })();
                // `id` with `to` (where it is now) or `why`: each tile in the view says how its file went
                let mut ev = json!({ "name": name, "id": id });
                match r {
                    Ok(()) => { done += 1; ev["to"] = json!(target.to_string_lossy()); copied.push(id.clone()); if remove { moved.push(id); } }
                    Err(e) => { failed += 1; let _ = std::fs::remove_file(&part); ev["error"] = json!(format!("{name}: {e}")); ev["why"] = json!(e); }
                }
                ev["done"] = json!(done); ev["total"] = json!(total); ev["failed"] = json!(failed);
                progress(ev);
            }
            // `gone`: what the phone really deleted; the rest of a move is copied and still on it
            let gone = if moved.is_empty() { Vec::new() } else { delete_on(&device, &moved).unwrap_or_default() };
            progress(json!({ "done": done, "total": total, "failed": failed, "removed": gone.len(), "gone": gone, "copied": copied, "finished": true, "dir": dir.to_string_lossy() }));
        });
    }

    /// A file's bytes as they come off the phone: all of them or an error (see super::read_whole).
    unsafe fn stream_whole(device: &IPortableDevice, id: &str, size: u64, take: impl FnMut(&[u8]) -> Result<(), String>) -> Result<u64, String> {
        unsafe {
            let res = device.Content().and_then(|c| c.Transfer()).map_err(|e| e.to_string())?;
            let w = wide(id);
            let mut opt = 0u32;
            let mut stream: Option<IStream> = None;
            res.GetStream(PCWSTR(w.as_ptr()), &WPD_RESOURCE_DEFAULT, 0, &mut opt, &mut stream).map_err(|e| e.to_string())?;
            let stream = stream.ok_or("no data")?;
            super::read_whole(size, (opt as usize).clamp(256 * 1024, 4 << 20), |buf| {
                let mut n = 0u32;
                let hr = stream.Read(buf.as_mut_ptr() as _, buf.len() as u32, Some(&mut n));
                (n as usize, hr.is_err())
            }, take)
        }
    }
    /// An object's details as the phone gives them now.
    unsafe fn item_now(device: &IPortableDevice, id: &str) -> Option<Value> {
        unsafe { item(&device.Content().and_then(|c| c.Properties()).ok()?, &keys().ok()?, id) }
    }
    /// A file off the phone into `to`, streamed (a long video never sits in memory whole). `size`: as listed, 0 if not known.
    unsafe fn fetch_on(device: &IPortableDevice, id: &str, size: u64, to: &Path) -> Result<u64, String> {
        unsafe {
            use std::io::Write;
            let mut f = std::io::BufWriter::new(std::fs::File::create(to).map_err(|e| e.to_string())?);
            let got = stream_whole(device, id, size, |b| f.write_all(b).map_err(|e| e.to_string()))?;
            f.flush().map_err(|e| e.to_string())?;
            Ok(got)
        }
    }
    /// A file's content, fingerprinted as it streams off the phone (FNV-1a, 64 bits): two files with the same
    /// size and fingerprint are the same file. Nothing is kept.
    pub fn fingerprint(dev: String, id: String) -> Result<u64, String> {
        let d2 = dev.clone();
        on(2, Some(dev), move |devs| unsafe {
            let device = devs.get(&d2)?;
            let size = item_now(&device, &id).and_then(|it| it["size"].as_u64()).unwrap_or(0);
            let mut h: u64 = 0xcbf29ce484222325;
            stream_whole(&device, &id, size, |part| { for &b in part { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); } Ok(()) })?;
            Ok(h)
        })
    }
    /// Only a video's two ends into `to`, a file as long as the video with nothing between (sparse: the middle
    /// takes no room): its start holds the first frames, its end - in a phone's MP4 - the index. Enough for
    /// ffmpeg to make one frame, at a few MB instead of the whole video. Fails when the phone cannot seek.
    pub fn fetch_ends(dev: String, id: String, size: u64, to: PathBuf) -> Result<(), String> {
        const HEAD: u64 = 3 << 20;
        const TAIL: u64 = 2 << 20;
        let d2 = dev.clone();
        on(2, Some(dev), move |devs| unsafe {
            let device = devs.get(&d2)?;
            let res = device.Content().and_then(|c| c.Transfer()).map_err(|e| e.to_string())?;
            let w = wide(&id);
            let mut opt = 0u32;
            let mut stream: Option<IStream> = None;
            res.GetStream(PCWSTR(w.as_ptr()), &WPD_RESOURCE_DEFAULT, 0, &mut opt, &mut stream).map_err(|e| e.to_string())?;
            let stream = stream.ok_or("no data")?;
            let f = std::fs::File::create(&to).map_err(|e| e.to_string())?;
            {
                use std::os::windows::io::AsRawHandle;
                use windows::Win32::System::IO::DeviceIoControl;
                use windows::Win32::System::Ioctl::FSCTL_SET_SPARSE;
                let _ = DeviceIoControl(windows::Win32::Foundation::HANDLE(f.as_raw_handle() as _), FSCTL_SET_SPARSE, None, 0, None, 0, None, None);
            }
            f.set_len(size).map_err(|e| e.to_string())?;
            let take = |at: u64, len: u64| -> Result<(), String> {
                use std::os::windows::fs::FileExt;
                let mut buf = vec![0u8; 512 * 1024];
                let mut got = 0u64;
                while got < len {
                    let want = ((len - got) as usize).min(buf.len()) as u32;
                    let mut n = 0u32;
                    let hr = stream.Read(buf.as_mut_ptr() as _, want, Some(&mut n));
                    if n > 0 { f.seek_write(&buf[..n as usize], at + got).map_err(|e| e.to_string())?; got += n as u64; }
                    if hr.is_err() || n == 0 { break; }
                }
                Ok(())
            };
            let head = HEAD.min(size);
            take(0, head)?;
            if size > head {
                let tail = (size - head).min(TAIL);
                stream.Seek((size - tail) as i64, STREAM_SEEK_SET, None).map_err(|e| format!("the phone cannot read part of a file: {e}"))?;
                take(size - tail, tail)?;
            }
            Ok(())
        })
    }
    pub fn fetch(dev: String, id: String, size: u64, to: PathBuf) -> Result<u64, String> {
        fetch_if(dev, id, size, to, || true)
    }
    /// `fetch`, but only if `still()` says it is wanted when its turn on the phone comes: a preview of a video the
    /// user has already moved past is not copied (a whole video, often hundreds of MB, ahead of a delete or a copy).
    pub fn fetch_if(dev: String, id: String, size: u64, to: PathBuf, still: impl FnOnce() -> bool + Send + 'static) -> Result<u64, String> {
        let d2 = dev.clone();
        on(2, Some(dev), move |devs| unsafe {
            if !still() { return Ok(0); } // not an error: an error would make the worker close the phone
            let d = devs.get(&d2)?;
            fetch_on(&d, &id, size, &to)
        })
    }

    /// A file from this computer onto the phone, into the folder `parent`, named `name`. Returns the new object's id.
    unsafe fn upload_on(device: &IPortableDevice, parent: &str, name: &str, from: &Path) -> Result<String, String> {
        unsafe {
            let data = std::fs::read(from).map_err(|e| e.to_string())?;
            let content = device.Content().map_err(|e| e.to_string())?;
            let v: IPortableDeviceValues = CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let (wp, wn) = (wide(parent), wide(name));
            v.SetStringValue(&WPD_OBJECT_PARENT_ID, PCWSTR(wp.as_ptr())).map_err(|e| e.to_string())?;
            v.SetStringValue(&WPD_OBJECT_NAME, PCWSTR(wn.as_ptr())).map_err(|e| e.to_string())?;
            v.SetStringValue(&WPD_OBJECT_ORIGINAL_FILE_NAME, PCWSTR(wn.as_ptr())).map_err(|e| e.to_string())?;
            v.SetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE, data.len() as u64).map_err(|e| e.to_string())?;
            let low = name.to_ascii_lowercase();
            let fmt = if low.ends_with(".jpg") || low.ends_with(".jpeg") { WPD_OBJECT_FORMAT_EXIF } else if low.ends_with(".mp4") || low.ends_with(".mov") || low.ends_with(".m4v") { WPD_OBJECT_FORMAT_MP4 } else if low.ends_with(".3gp") { WPD_OBJECT_FORMAT_3GP } else { WPD_OBJECT_FORMAT_UNSPECIFIED };
            v.SetGuidValue(&WPD_OBJECT_FORMAT, &fmt).map_err(|e| e.to_string())?;
            let mut stream: Option<IStream> = None;
            let mut opt = 0u32;
            let mut cookie = PWSTR::null();
            content.CreateObjectWithPropertiesAndData(&v, &mut stream, &mut opt, &mut cookie).map_err(|e| format!("the phone did not take the file: {e}"))?;
            let _ = take(cookie);
            let stream = stream.ok_or("no stream to write")?;
            let step = (opt as usize).clamp(64 * 1024, 4 << 20);
            for chunk in data.chunks(step) {
                let mut n = 0u32;
                stream.Write(chunk.as_ptr() as _, chunk.len() as u32, Some(&mut n)).ok().map_err(|e| e.to_string())?;
                if n as usize != chunk.len() { return Err("the phone stopped taking the file".into()); }
            }
            stream.Commit(STGC_DEFAULT).map_err(|e| format!("the phone did not keep the file: {e}"))?;
            let ds: IPortableDeviceDataStream = stream.cast().map_err(|e| e.to_string())?;
            let id = ds.GetObjectID().map(|p| take(p)).map_err(|e| e.to_string())?;
            Ok(id)
        }
    }

    /// The compressed copy in the original's place: the original goes, the copy is put in the same folder under the
    /// same name. Should the phone not take the copy, the original (kept on this computer until now) is put back.
    pub fn replace(dev: String, parent: String, old: String, name: String, new_file: PathBuf, original: PathBuf) -> Result<String, String> {
        let d2 = dev.clone();
        on(2, Some(dev), move |devs| unsafe {
            let d = devs.get(&d2)?;
            // an id can have gone stale (a phone plugged in again may renumber): only the very file that was fetched is replaced
            let same = item_now(&d, &old).is_some_and(|it| super::same_file(&it, &name, std::fs::metadata(&original).ok().map(|m| m.len())));
            if !same { return Err("it is no longer the same file on the phone - nothing was changed".into()); }
            if delete_on(&d, &[old])?.is_empty() { return Err("the phone did not delete the original - nothing was changed".into()); }
            match upload_on(&d, &parent, &name, &new_file) {
                Ok(id) => Ok(id),
                Err(e) => match upload_on(&d, &parent, &name, &original) {
                    Ok(_) => Err(format!("{e} - the original was put back")),
                    Err(e2) => Err(format!("{e}; putting the original back failed too ({e2}) - it is kept at {}", super::keep_original(&original, &name).display())),
                },
            }
        })
    }

    /// A JPEG again at `quality` (0..1), its EXIF - date taken, place, camera, orientation - carried over whole.
    pub fn jpeg_again(from: &Path, to: &Path, quality: f32) -> Result<(), String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let f: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let w = wide(&from.to_string_lossy());
            let dec = f.CreateDecoderFromFilename(PCWSTR(w.as_ptr()), None, windows::Win32::Foundation::GENERIC_READ, WICDecodeMetadataCacheOnLoad).map_err(|e| e.to_string())?;
            let frame = dec.GetFrame(0).map_err(|e| e.to_string())?;
            let out = f.CreateStream().map_err(|e| e.to_string())?;
            let wo = wide(&to.to_string_lossy());
            out.InitializeFromFilename(PCWSTR(wo.as_ptr()), windows::Win32::Foundation::GENERIC_WRITE.0).map_err(|e| e.to_string())?;
            let enc = f.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()).map_err(|e| e.to_string())?;
            enc.Initialize(&out, WICBitmapEncoderNoCache).map_err(|e| e.to_string())?;
            let mut fe: Option<IWICBitmapFrameEncode> = None;
            let mut bag = None;
            enc.CreateNewFrame(&mut fe, &mut bag).map_err(|e| e.to_string())?;
            let fe = fe.ok_or("no frame")?;
            if let Some(b) = &bag {
                let mut name = wide("ImageQuality");
                let pb = windows::Win32::System::Com::StructuredStorage::PROPBAG2 { pstrName: PWSTR(name.as_mut_ptr()), ..Default::default() };
                let mut var = windows::Win32::System::Variant::VARIANT::default();
                (*var.Anonymous.Anonymous).vt = windows::Win32::System::Variant::VT_R4;
                (*var.Anonymous.Anonymous).Anonymous.fltVal = quality.clamp(0.5, 1.0);
                b.Write(1, &pb, &var).map_err(|e| e.to_string())?;
            }
            fe.Initialize(bag.as_ref()).map_err(|e| e.to_string())?;
            let (mut w0, mut h0) = (0u32, 0u32);
            frame.GetSize(&mut w0, &mut h0).map_err(|e| e.to_string())?;
            fe.SetSize(w0, h0).map_err(|e| e.to_string())?;
            let mut fmt = GUID_WICPixelFormat24bppBGR;
            let _ = frame.GetPixelFormat().map(|p| fmt = p);
            fe.SetPixelFormat(&mut fmt).map_err(|e| e.to_string())?;
            // the metadata, block for block: nothing of the photo's details is lost or reinterpreted
            let reader: IWICMetadataBlockReader = frame.cast().map_err(|e| e.to_string())?;
            let writer: IWICMetadataBlockWriter = fe.cast().map_err(|e| e.to_string())?;
            writer.InitializeFromBlockReader(&reader).map_err(|e| format!("its details could not be carried over ({e})"))?;
            let src: IWICBitmapSource = frame.cast().map_err(|e| e.to_string())?;
            let src = if fmt == GUID_WICPixelFormat24bppBGR { src } else { WICConvertBitmapSource(&fmt, &src).map_err(|e| e.to_string())? };
            fe.WriteSource(&src, std::ptr::null()).map_err(|e| e.to_string())?;
            fe.Commit().map_err(|e| e.to_string())?;
            enc.Commit().map_err(|e| e.to_string())?;
            Ok(())
        }
    }

    /// Deletes on the phone and returns the ids it really deleted: it can refuse some and still answer "done".
    unsafe fn delete_on(device: &IPortableDevice, ids: &[String]) -> Result<Vec<String>, String> {
        unsafe {
            let content = device.Content().map_err(|e| e.to_string())?;
            let col: IPortableDevicePropVariantCollection = CoCreateInstance(&PortableDevicePropVariantCollection, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let mut bufs: Vec<Vec<u16>> = ids.iter().map(|s| wide(s)).collect();
            for b in bufs.iter_mut() {
                let mut pv = PROPVARIANT::default();
                (*pv.Anonymous.Anonymous).vt = VT_LPWSTR;
                (*pv.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(b.as_mut_ptr());
                col.Add(&pv).map_err(|e| e.to_string())?;
                // the collection copied the string; ours is freed with `bufs`, never by PropVariantClear
                std::mem::forget(pv);
            }
            let mut results: Option<IPortableDevicePropVariantCollection> = None;
            content.Delete(PORTABLE_DEVICE_DELETE_WITH_RECURSION.0 as u32, &col, &mut results).map_err(|e| e.to_string())?;
            let refused = |i: usize| results.as_ref().is_some_and(|r| {
                let mut pv = PROPVARIANT::default();
                r.GetAt(i as u32, &mut pv).is_ok() && pv.Anonymous.Anonymous.vt == VT_ERROR && pv.Anonymous.Anonymous.Anonymous.scode < 0
            });
            Ok(ids.iter().enumerate().filter(|(i, _)| !refused(*i)).map(|(_, id)| id.clone()).collect())
        }
    }
    /// Files and folders deleted on the phone (a phone has no recycle bin).
    /// `expect`: each id's name and size as the page showed it - a phone plugged in again may renumber, and a stale id
    /// would delete another file: only those still the same file go
    pub fn delete(dev: String, ids: Vec<String>, expect: Option<Vec<Value>>) -> Result<Vec<String>, String> {
        let d2 = dev.clone();
        on(2, Some(dev), move |devs| unsafe {
            let d = devs.get(&d2)?;
            let ids: Vec<String> = match &expect {
                Some(ex) => ids.iter().zip(ex.iter()).filter(|(id, e)| {
                    item_now(&d, id).is_some_and(|it| super::same_file(&it, e["name"].as_str().unwrap_or(""), e["size"].as_u64()))
                }).map(|(id, _)| id.clone()).collect(),
                None => ids,
            };
            if ids.is_empty() { return Ok(Vec::new()); } // all changed since: nothing to ask the phone
            delete_on(&d, &ids)
        })
    }

    /// A HEIC (or any picture Windows can read) as a JPEG, at most `max_side` px on its long side (0: as it is).
    pub fn to_jpeg(bytes: Option<&[u8]>, path: Option<&Path>, max_side: u32) -> Result<Vec<u8>, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let f: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let dec = match (bytes, path) {
                (Some(b), _) => {
                    let s = windows::Win32::UI::Shell::SHCreateMemStream(Some(b)).ok_or("out of memory")?;
                    f.CreateDecoderFromStream(&s, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
                }
                (None, Some(p)) => { let w = wide(&p.to_string_lossy()); f.CreateDecoderFromFilename(PCWSTR(w.as_ptr()), None, windows::Win32::Foundation::GENERIC_READ, WICDecodeMetadataCacheOnDemand) }
                _ => return Err("nothing to read".into()),
            }.map_err(|_| "Windows cannot read this picture - for HEIC install \"HEIF Image Extensions\" and \"HEVC Video Extensions\" from the Microsoft Store".to_string())?;
            let frame = dec.GetFrame(0).map_err(|e| e.to_string())?;
            let (mut w, mut hgt) = (0u32, 0u32);
            frame.GetSize(&mut w, &mut hgt).map_err(|e| e.to_string())?;
            let mut src: IWICBitmapSource = frame.cast().map_err(|e| e.to_string())?;
            if max_side > 0 && w.max(hgt) > max_side {
                let k = max_side as f64 / w.max(hgt) as f64;
                let (nw, nh) = (((w as f64 * k).round() as u32).max(1), ((hgt as f64 * k).round() as u32).max(1));
                let sc = f.CreateBitmapScaler().map_err(|e| e.to_string())?;
                sc.Initialize(&src, nw, nh, WICBitmapInterpolationModeFant).map_err(|e| e.to_string())?;
                src = sc.cast().map_err(|e| e.to_string())?;
                w = nw; hgt = nh;
            }
            let src = WICConvertBitmapSource(&GUID_WICPixelFormat24bppBGR, &src).map_err(|e| e.to_string())?;
            let out = windows::Win32::UI::Shell::SHCreateMemStream(None).ok_or("out of memory")?;
            let enc = f.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()).map_err(|e| e.to_string())?;
            enc.Initialize(&out, WICBitmapEncoderNoCache).map_err(|e| e.to_string())?;
            let mut fe: Option<IWICBitmapFrameEncode> = None;
            let mut bag = None;
            enc.CreateNewFrame(&mut fe, &mut bag).map_err(|e| e.to_string())?;
            let fe = fe.ok_or("no frame")?;
            fe.Initialize(bag.as_ref()).map_err(|e| e.to_string())?;
            fe.SetSize(w, hgt).map_err(|e| e.to_string())?;
            let mut fmt = GUID_WICPixelFormat24bppBGR;
            fe.SetPixelFormat(&mut fmt).map_err(|e| e.to_string())?;
            fe.WriteSource(&src, std::ptr::null()).map_err(|e| e.to_string())?;
            fe.Commit().map_err(|e| e.to_string())?;
            enc.Commit().map_err(|e| e.to_string())?;
            let mut stat = STATSTG::default();
            out.Stat(&mut stat, STATFLAG_NONAME).map_err(|e| e.to_string())?;
            out.Seek(0, STREAM_SEEK_SET, None).map_err(|e| e.to_string())?;
            let mut v = vec![0u8; stat.cbSize as usize];
            let mut n = 0u32;
            let _ = out.Read(v.as_mut_ptr() as _, v.len() as u32, Some(&mut n));
            v.truncate(n as usize);
            Ok(v)
        }
    }
}

// ── commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn phone_devices() -> Result<Value, String> {
    #[cfg(windows)]
    { return tauri::async_runtime::spawn_blocking(win::devices).await.map_err(|e| e.to_string())?; }
    #[allow(unreachable_code)]
    Ok(json!([]))
}

/// A folder's contents, sent as `phone:list` events ({ req, items, done }) as they are read.
#[tauri::command]
pub async fn phone_list(app: tauri::AppHandle, dev: String, parent: String, req: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        return tauri::async_runtime::spawn_blocking(move || win::list(dev, parent, move |items, done| { let _ = app.emit_to("main", "phone:list", json!({ "req": req, "items": items, "done": done })); })).await.map_err(|e| e.to_string())?;
    }
    #[allow(unreachable_code)]
    { let _ = (app, dev, parent, req); Err("phones are read on Windows only".into()) }
}

/// The stop of the latest scan. Each scan has its own: a new one must not undo a stop an older one has yet to see.
static SCAN_STOP: std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> = std::sync::Mutex::new(None);

/// Every file on the phone, as `phone:scan` events ({ req, items, folders, done }).
#[tauri::command]
pub async fn phone_scan(app: tauri::AppHandle, dev: String, req: u64, skip_system: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // the scan before this is of no more use (its events are dropped) and would hold this one up
        if let Some(old) = SCAN_STOP.lock().map_err(|e| e.to_string())?.replace(stop.clone()) { old.store(true, std::sync::atomic::Ordering::Relaxed); }
        return tauri::async_runtime::spawn_blocking(move || win::scan(dev, skip_system, stop, move |items, st| { let _ = app.emit_to("main", "phone:scan", json!({ "req": req, "items": items, "folders": st.folders, "unread": st.unread, "gone": st.gone, "stopped": st.stopped, "done": st.done })); })).await.map_err(|e| e.to_string())?;
    }
    #[allow(unreachable_code)]
    { let _ = (app, dev, req, skip_system); Err("phones are read on Windows only".into()) }
}
/// Fingerprints of files' contents, to tell true copies from files that merely share a size.
#[tauri::command]
pub async fn phone_fingerprints(dev: String, ids: Vec<String>) -> Result<Value, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            let mut out = serde_json::Map::new();
            for id in ids { if let Ok(h) = win::fingerprint(dev.clone(), id.clone()) { out.insert(id, json!(format!("{h:016x}"))); } }
            Ok(Value::Object(out))
        }).await.map_err(|e| e.to_string())?;
    }
    #[allow(unreachable_code)]
    { let _ = (dev, ids); Err("phones are read on Windows only".into()) }
}

#[tauri::command]
pub fn phone_scan_stop() { if let Ok(s) = SCAN_STOP.lock() { if let Some(s) = s.as_ref() { s.store(true, std::sync::atomic::Ordering::Relaxed); } } }

/// Copy (or move) files off the phone into a folder on this computer; `phone:copy` events tell how it goes.
#[tauri::command]
pub async fn phone_copy(app: tauri::AppHandle, dev: String, items: Vec<Value>, dir: String, remove: bool, job: u64) -> Result<(), String> {
    let dir = PathBuf::from(dir.trim());
    if !dir.is_absolute() { return Err("choose a folder on this computer".into()); }
    crate::grant::allow(&app, &dir, "copy files from the phone into", true)?;
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let list: Vec<(String, String, u64, u64)> = items.iter().filter_map(|v| Some((v["id"].as_str()?.to_string(), v["name"].as_str().unwrap_or("file").to_string(), v["size"].as_u64().unwrap_or(0), v["mtime"].as_u64().unwrap_or(0)))).collect();
        win::copy(dev, list, dir, remove, move |mut p| { p["job"] = json!(job); let _ = app.emit_to("main", "phone:copy", p); });
        return Ok(());
    }
    #[allow(unreachable_code)]
    { let _ = (app, dev, items, remove, job); Err("phones are read on Windows only".into()) }
}

#[tauri::command]
pub async fn phone_delete(dev: String, ids: Vec<String>, expect: Option<Vec<Value>>) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    { return tauri::async_runtime::spawn_blocking(move || win::delete(dev, ids, expect)).await.map_err(|e| e.to_string())?; }
    #[allow(unreachable_code)]
    { let _ = (dev, ids, expect); Err("phones are read on Windows only".into()) }
}

// ── compressing what is on the phone ─────────────────────────────────────
//
// Each file is fetched into a folder of Leonote's own in the temp folder, a
// smaller copy is made beside it, and both are kept there until the user has
// looked: Apply puts the copy on the phone in the original's place (same
// folder, same name, same kind of file, its details kept - so the gallery
// shows it where it was), Discard throws them away. Nothing on the phone
// changes before Apply. Photos: JPEG again at a high quality with the EXIF
// block copied whole (a HEIC is already small, and left alone). Videos: H.264
// or H.265 with ffmpeg, the sound copied as it is, the dates and the
// orientation kept, in the same container.

pub fn work_root() -> PathBuf { std::env::temp_dir().join("leonote-compress") }
/// The folder a compress job works in.
pub fn work_dir(job: u64) -> PathBuf { work_root().join(job.to_string()) }

/// Where a job keeps one file and its smaller copy. Two folders of a phone can hold the same name, so the
/// object's id goes in too; the ending stays last (ffmpeg and the /work preview go by it).
pub fn work_files(dir: &Path, id: &str, name: &str) -> (PathBuf, PathBuf) {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut h);
    let file = format!("{:016x}-{}", h.finish(), safe_name(name));
    (dir.join("orig").join(&file), dir.join("out").join(file))
}

/// An original the phone would not take back: moved out of its job's folder, which Discard and the sweep remove.
pub fn keep_original(orig: &Path, name: &str) -> PathBuf {
    // in Leonote's own folder, not %TEMP%: a disk clean-up empties that, and this may be the only copy left
    let dir = crate::store::leonote_dir().join("phone-originals");
    let to = free_path(&dir, &safe_name(name));
    if std::fs::create_dir_all(&dir).is_ok() && std::fs::rename(orig, &to).is_ok() { to } else { orig.to_path_buf() }
}

/// What a job left behind when Leonote closed before Apply or Discard goes a day later (a job's folder is named
/// by its start, in ms). `kept` is no job and stays. Once a launch.
pub fn sweep_work(root: &Path, now_ms: u64) {
    for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().parse::<u64>().is_ok_and(|job| now_ms.saturating_sub(job) > 86_400_000) { let _ = std::fs::remove_dir_all(e.path()); }
    }
}

/// Jobs thrown away while still at work: their thread stops at the next file and removes what it made since.
static DISCARDED: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());

/// ffmpeg's arguments for a video: `codec` "h264" | "h265", `level` "gentle" | "strong".
pub fn video_args(input: &str, output: &str, codec: &str, level: &str) -> Vec<String> {
    let (lib, crf, tag) = match (codec, level) {
        ("h265", "strong") => ("libx265", 28, true),
        ("h265", _) => ("libx265", 24, true),
        (_, "strong") => ("libx264", 25, false),
        _ => ("libx264", 21, false),
    };
    let mut a: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0", "-c:v", lib, "-preset", "slow", "-crf"].iter().map(|s| s.to_string()).collect();
    a.push(crf.to_string());
    if tag { a.extend(["-tag:v", "hvc1", "-x265-params", "log-level=error"].map(String::from)); }
    a.extend(["-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart+use_metadata_tags", output].map(String::from));
    a
}

/// Compress files off the phone; `phone:compress` events give each result (before, after, or why not).
#[tauri::command]
pub async fn phone_compress(app: tauri::AppHandle, dev: String, items: Vec<Value>, codec: String, level: String, photo_quality: f64, job: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let dir = work_dir(job);
        std::fs::create_dir_all(dir.join("orig")).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(dir.join("out")).map_err(|e| e.to_string())?;
        let ffmpeg = crate::external::tool_path("ffmpeg", None);
        std::thread::spawn(move || {
            let emit = |v: Value| { let mut v = v; v["job"] = json!(job); let _ = app.emit_to("main", "phone:compress", v); };
            let total = items.len();
            let dropped = || DISCARDED.lock().map(|d| d.contains(&job)).unwrap_or(false);
            for (i, it) in items.iter().enumerate() {
                if dropped() { let _ = std::fs::remove_dir_all(&dir); return; }
                let (id, name) = (it["id"].as_str().unwrap_or("").to_string(), it["name"].as_str().unwrap_or("file").to_string());
                let low = name.to_ascii_lowercase();
                let video = [".mp4", ".mov", ".m4v", ".3gp"].iter().any(|e| low.ends_with(e));
                let photo = low.ends_with(".jpg") || low.ends_with(".jpeg");
                let base = json!({ "id": id, "name": name, "i": i + 1, "total": total });
                let mut r = base.clone();
                if !video && !photo { r["state"] = json!("skipped"); r["why"] = json!(if low.ends_with(".heic") || low.ends_with(".heif") { "HEIC is already small" } else { "not a photo or video it can make smaller" }); emit(r); continue; }
                if video && ffmpeg.is_none() { r["state"] = json!("skipped"); r["why"] = json!("videos need ffmpeg"); emit(r); continue; }
                let (orig, out) = work_files(&dir, &id, &name);
                emit(json!({ "id": id, "name": name, "i": i + 1, "total": total, "state": "reading" }));
                let before = match win::fetch(dev.clone(), id.clone(), it["size"].as_u64().unwrap_or(0), orig.clone()) { Ok(n) => n, Err(e) => { r["state"] = json!("failed"); r["why"] = json!(e); let _ = std::fs::remove_file(&orig); emit(r); continue; } };
                if dropped() { continue; }
                // a motion photo (its video after the picture) or an Ultra HDR one (its gain map): a new JPEG of the
                // picture alone would drop that, and look like a big saving - kept as it is
                if photo && std::fs::read(&orig).is_ok_and(|b| [&b"MotionPhoto"[..], b"MicroVideo", b"hdrgm:", b"Container:Directory", b"MPF\0"].iter().any(|m| b.windows(m.len()).any(|w| w == *m))) {
                    r["state"] = json!("skipped"); r["why"] = json!("it holds more than one picture (motion, HDR, depth) - a smaller copy would keep only the first");
                    let _ = std::fs::remove_file(&orig); emit(r); continue;
                }
                emit(json!({ "id": id, "name": name, "i": i + 1, "total": total, "state": "compressing", "before": before }));
                let made = if photo { win::jpeg_again(&orig, &out, photo_quality as f32) } else {
                    let mut cmd = std::process::Command::new(ffmpeg.as_ref().unwrap());
                    cmd.args(video_args(&orig.to_string_lossy(), &out.to_string_lossy(), &codec, &level)).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
                    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
                    match cmd.output() { Ok(o) if o.status.success() => Ok(()), Ok(o) => Err(String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("ffmpeg failed").to_string()), Err(e) => Err(e.to_string()) }
                };
                let after = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
                r["before"] = json!(before);
                r["orig"] = json!(orig.to_string_lossy());
                match made {
                    Err(e) => { r["state"] = json!("failed"); r["why"] = json!(e); let _ = std::fs::remove_file(&out); let _ = std::fs::remove_file(&orig); }
                    Ok(()) if after == 0 || after as f64 > before as f64 * 0.95 => { r["state"] = json!("skipped"); r["why"] = json!("it is already about as small as it gets"); r["after"] = json!(after); let _ = std::fs::remove_file(&out); let _ = std::fs::remove_file(&orig); }
                    Ok(()) => { r["state"] = json!("ready"); r["after"] = json!(after); r["out"] = json!(out.to_string_lossy()); }
                }
                emit(r);
            }
            if dropped() { let _ = std::fs::remove_dir_all(&dir); }
            emit(json!({ "finished": true, "total": total }));
        });
        return Ok(());
    }
    #[allow(unreachable_code)]
    { let _ = (app, dev, items, codec, level, photo_quality, job); Err("phones are read on Windows only".into()) }
}

/// Put the compressed copies on the phone in their originals' places. Returns how many, and what went wrong.
#[tauri::command]
pub async fn phone_compress_apply(dev: String, parent: String, items: Vec<Value>, job: u64) -> Result<Value, String> {
    #[cfg(windows)]
    {
        let dir = work_dir(job);
        return tauri::async_runtime::spawn_blocking(move || {
            let (mut done, mut errors) = (0, Vec::new());
            let mut ids = serde_json::Map::new();
            for it in items {
                let (id, name) = (it["id"].as_str().unwrap_or(""), it["name"].as_str().unwrap_or(""));
                let (orig, out) = work_files(&dir, id, name);
                if !out.exists() || !orig.exists() { errors.push(format!("{name}: its copy is gone")); continue; }
                match win::replace(dev.clone(), parent.clone(), id.to_string(), name.to_string(), out.clone(), orig.clone()) {
                    Ok(new_id) => {
                        done += 1;
                        ids.insert(id.to_string(), json!({ "id": new_id, "size": std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) }));
                        // the full-quality original goes to the Recycle Bin under its own name, not away for good: the
                        // phone has no bin, and a smaller copy can lose what it held (a motion photo's video, HDR)
                        let named = keep_original(&orig, name);
                        // the bin refused it (too big, turned off): kept, and said where - the only full-size copy
                        if crate::outpost::recycle(&[named.clone()]).is_err() { errors.push(format!("{name}: replaced; the original is kept at {}", named.display())); }
                        let _ = std::fs::remove_file(&out);
                    }
                    Err(e) => errors.push(format!("{name}: {e}")),
                }
            }
            Ok(json!({ "done": done, "errors": errors, "ids": ids }))
        }).await.map_err(|e| e.to_string())?;
    }
    #[allow(unreachable_code)]
    { let _ = (dev, parent, items, job); Err("phones are read on Windows only".into()) }
}

/// Throw a compress job's files away (after Apply, or instead of it).
#[tauri::command]
pub fn phone_compress_discard(job: u64) {
    if let Ok(mut d) = DISCARDED.lock() { d.push(job); }
    let _ = std::fs::remove_dir_all(work_dir(job));
}

/// Parse `a=1&b=2` (percent-encoded values).
fn query(q: &str) -> std::collections::HashMap<String, String> {
    q.split('&').filter_map(|kv| { let (k, v) = kv.split_once('=')?; Some((k.to_string(), percent_decode(v))) }).collect()
}
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) { out.push(v); i += 3; continue; }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A path on a drive of this computer (C:\\..., \\\\?\\C:\\...) - never a network share, a device or a relative path,
/// however it is spelled (\\\\host\\share, //host/share, \\\\?\\UNC\\host, \\\\.\\device).
pub fn local_disk_path(p: &Path) -> bool {
    use std::path::{Component, Prefix};
    let mut parts = p.components();
    matches!(parts.next(), Some(Component::Prefix(pre)) if matches!(pre.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        && matches!(parts.next(), Some(Component::RootDir))
}

/// `heic://localhost/?p=<abs path>&s=<max side>` and `phone://localhost/thumb|file?d=<dev>&o=<object>`:
/// pictures the webview cannot load itself, answered as JPEG (or the phone's own bytes).
pub fn serve(scheme: &str, uri: &str) -> (u16, &'static str, Vec<u8>) {
    let (path, q) = uri.split_once('?').unwrap_or((uri, ""));
    let q = query(q);
    let ok = |b: Vec<u8>, t: &'static str| (200u16, t, b);
    let fail = |e: String| (404u16, "text/plain", e.into_bytes());
    #[cfg(windows)]
    {
        let side = q.get("s").and_then(|s| s.parse().ok()).unwrap_or(0u32);
        if scheme == "heic" {
            let p = PathBuf::from(q.get("p").cloned().unwrap_or_default());
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if !["heic", "heif", "hif"].contains(&ext.as_str()) { return fail("only HEIC pictures".into()); }
            // a picture on this computer only: a network path (\host\share, //host) would make Windows sign in to that host
            if !local_disk_path(&p) { return fail("only a picture on this computer".into()); }
            return match win::to_jpeg(None, Some(&p), side) { Ok(b) => ok(b, "image/jpeg"), Err(e) => fail(e) };
        }
        if scheme == "phone" && path.ends_with("/work") {
            // only what a compress job made, in its own folder
            let f = PathBuf::from(q.get("f").cloned().unwrap_or_default());
            let root = work_root();
            let inside = f.canonicalize().ok().zip(root.canonicalize().ok()).map(|(a, b)| a.starts_with(b)).unwrap_or(false);
            if !inside { return fail("not a compressed copy".into()); }
            let low = f.to_string_lossy().to_ascii_lowercase();
            return match std::fs::read(&f) { Ok(b) => { let t = if low.ends_with(".mp4") || low.ends_with(".mov") || low.ends_with(".m4v") { "video/mp4" } else { sniff(&b) }; ok(b, t) } Err(e) => fail(e.to_string()) };
        }
        if scheme == "phone" && (path.ends_with("/preview") || path.ends_with("/vthumb")) {
            // a video made watchable (H.264, small, the first seconds) or one frame of it, with ffmpeg; the
            // video is fetched to a temporary file for that (a phone's MP4 keeps its index at the end) and removed at once
            let (d, o) = (q.get("d").cloned().unwrap_or_default(), q.get("o").cloned().unwrap_or_default());
            // the phone is part of it: two phones can number their files alike
            let key = format!("{}|{}|{}|{}", path.rsplit('/').next().unwrap_or(""), d, o, q.get("secs").cloned().unwrap_or_default());
            if let Some(b) = made_cache(&key, None) { return ok(b, if path.ends_with("/vthumb") { "image/jpeg" } else { "video/mp4" }); }
            let Some(ff) = crate::external::tool_path("ffmpeg", None) else { return fail("ffmpeg is not on this computer".into()) };
            let tmp = std::env::temp_dir().join(format!("leonote-pv-{}-{}", std::process::id(), NEXT_TMP.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
            let _ = std::fs::create_dir_all(&tmp);
            let src = tmp.join(format!("v.{}", q.get("n").and_then(|n| n.rsplit('.').next().map(|e| e.to_ascii_lowercase())).unwrap_or_else(|| "mp4".into())));
            let size: u64 = q.get("z").and_then(|z| z.parse().ok()).unwrap_or(0);
            let vthumb = path.ends_with("/vthumb");
            // one frame: first from the video's two ends only (a few MB), the whole video only when that does not do
            let frame = |src: &PathBuf, out: &PathBuf, at: &str| -> bool {
                let mut cmd = std::process::Command::new(&ff);
                cmd.args(["-y", "-loglevel", "error", "-ss", at, "-i"]).arg(src).args(["-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4"]).arg(out);
                { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
                cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                cmd.status().map(|s| s.success()).unwrap_or(false) && out.metadata().map(|m| m.len() > 0).unwrap_or(false)
            };
            if vthumb && size > 0 {
                let out = tmp.join("t.jpg");
                if win::fetch_ends(d.clone(), o.clone(), size, src.clone()).is_ok() && frame(&src, &out, "0") {
                    if let Ok(b) = std::fs::read(&out) { let _ = std::fs::remove_dir_all(&tmp); made_cache(&key, Some(b.clone())); return ok(b, "image/jpeg"); }
                }
                let _ = std::fs::remove_file(&src);
                // asked for quickly (the tile of a phone without its own thumbnails): no whole video for it
                if q.get("quick").is_some() { let _ = std::fs::remove_dir_all(&tmp); return fail("no quick frame".into()); }
            }
            // only the newest preview asked for is worth a whole video: arrowing through ten videos queued ten copies
            // the phone had to finish before a delete or a move could start (a frame for a tile is not affected)
            let want = (!vthumb).then(|| { let n = PREVIEW_WANT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1; n });
            let still = move || want.map_or(true, |n| PREVIEW_WANT.load(std::sync::atomic::Ordering::SeqCst) == n);
            let r = win::fetch_if(d, o, size, src.clone(), still).and_then(|got| {
                if got == 0 && size > 0 { return Err("a newer preview was asked for".to_string()); }
                let out = tmp.join(if vthumb { "t.jpg" } else { "p.mp4" });
                let mut cmd = std::process::Command::new(&ff);
                if vthumb {
                    cmd.args(["-y", "-loglevel", "error", "-ss", "1", "-i"]).arg(&src).args(["-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4"]).arg(&out);
                } else {
                    let secs: u32 = q.get("secs").and_then(|s| s.parse().ok()).unwrap_or(0);
                    cmd.args(["-y", "-loglevel", "error", "-i"]).arg(&src);
                    if secs > 0 { cmd.args(["-t", &secs.to_string()]); }
                    cmd.args(["-vf", "scale=-2:'min(540,ih)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"]).arg(&out);
                }
                { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
                cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                if !cmd.status().map(|s| s.success()).unwrap_or(false) { return Err("ffmpeg could not read this video".to_string()); }
                std::fs::read(&out).map_err(|e| e.to_string())
            });
            let _ = std::fs::remove_dir_all(&tmp);
            return match r { Ok(b) => { made_cache(&key, Some(b.clone())); ok(b, if path.ends_with("/vthumb") { "image/jpeg" } else { "video/mp4" }) } Err(e) => fail(e) };
        }
        if scheme == "phone" {
            let (d, o) = (q.get("d").cloned().unwrap_or_default(), q.get("o").cloned().unwrap_or_default());
            let nm = q.get("n").map(|n| n.to_ascii_lowercase()).unwrap_or_default();
            let heic = nm.ends_with(".heic") || nm.ends_with(".heif");
            let video = [".mp4", ".mov", ".3gp", ".mkv", ".webm", ".m4v"].iter().any(|e| nm.ends_with(e));
            // a video without the phone's own thumbnail is not read whole just for one: the page asks for a made frame if it wants one
            if path.ends_with("/thumb") { if let Some(b) = thumb_cache(&format!("{d}|{o}"), None) { return ok(b.clone(), sniff(&b)); } }
            let tkey = format!("{d}|{o}");
            let r = if path.ends_with("/thumb") { win::thumb(d.clone(), o.clone()).map(|b| { thumb_cache(&tkey, Some(b.clone())); b }).or_else(|e| if video { Err(e) } else { win::file(d, o, 40 << 20).and_then(|b| win::to_jpeg(Some(&b), None, side.max(320))) }) } else { win::file(d, o, 400 << 20) };
            return match r {
                Ok(b) if heic && !path.ends_with("/thumb") => match win::to_jpeg(Some(&b), None, side) { Ok(j) => ok(j, "image/jpeg"), Err(e) => fail(e) },
                Ok(b) => { let t = sniff(&b); ok(b, t) }
                Err(e) => fail(e),
            };
        }
    }
    let _ = (scheme, path, q);
    fail("not here".into())
}

static NEXT_TMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// The number of the newest video preview asked for (see `fetch_if`).
static PREVIEW_WANT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The phone's own thumbnails this session (at most 120 MB - tens of thousands of tiles), so a grid drawn again
/// after a delete, a sort or a scroll back shows them at once instead of asking the phone for each one again.
/// Keyed by phone and object id; a deleted file's id is not reused by the phone while it stays plugged in.
fn thumb_cache(key: &str, put: Option<Vec<u8>>) -> Option<Vec<u8>> {
    type Cache = (std::collections::HashMap<String, Vec<u8>>, std::collections::VecDeque<String>, usize);
    static C: std::sync::OnceLock<std::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    let mut g = crate::lock(C.get_or_init(Default::default));
    let (map, order, bytes) = &mut *g;
    if let Some(b) = put {
        if let Some(old) = map.insert(key.to_string(), b) { *bytes -= old.len(); } else { order.push_back(key.to_string()); }
        *bytes += map[key].len();
        while *bytes > 120 << 20 { let Some(k) = order.pop_front() else { break }; if let Some(b) = map.remove(&k) { *bytes -= b.len(); } }
        return None;
    }
    map.get(key).cloned()
}
/// Previews and frames made this session, kept in memory (at most 60 MB), so a video watched again is not fetched again.
fn made_cache(key: &str, put: Option<Vec<u8>>) -> Option<Vec<u8>> {
    static C: std::sync::Mutex<Vec<(String, Vec<u8>)>> = std::sync::Mutex::new(Vec::new());
    let mut c = crate::lock(&C);
    if let Some(b) = put {
        c.retain(|(k, _)| k != key);
        c.push((key.to_string(), b));
        while c.iter().map(|(_, b)| b.len()).sum::<usize>() > 60 << 20 && c.len() > 1 { c.remove(0); }
        return None;
    }
    c.iter().find(|(k, _)| k == key).map(|(_, b)| b.clone())
}

/// The type of a file from its first bytes (what the phone sent).
pub(crate) fn sniff(b: &[u8]) -> &'static str {
    if b.starts_with(&[0xFF, 0xD8]) { "image/jpeg" }
    else if b.starts_with(b"\x89PNG") { "image/png" }
    else if b.starts_with(b"GIF8") { "image/gif" }
    else if b.len() > 12 && &b[8..12] == b"WEBP" { "image/webp" }
    else if b.len() > 12 && &b[4..8] == b"ftyp" { "video/mp4" }
    else if b.starts_with(b"%PDF") { "application/pdf" }
    else if b.starts_with(b"ID3") || (b.len() > 1 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0) { "audio/mpeg" }
    else if b.starts_with(b"fLaC") { "audio/flac" }
    else if b.starts_with(b"OggS") { "audio/ogg" }
    else if b.len() > 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WAVE" { "audio/wav" }
    else if std::str::from_utf8(&b[..b.len().min(4096)]).is_ok() { "text/plain; charset=utf-8" }
    else { "application/octet-stream" }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_phone_without_sizes_can_still_be_replaced_but_never_another_file() {
        use serde_json::json;
        let same = |name: &str, size: u64| super::same_file(&json!({ "name": name, "size": size }), "a.mp4", Some(9));
        assert!(same("a.mp4", 9));
        assert!(same("a.mp4", 0), "no size reported");
        assert!(!same("a.mp4", 8) && !same("b.mp4", 9) && !same("b.mp4", 0));
        assert!(!super::same_file(&json!({ "name": "a.mp4", "size": 0 }), "a.mp4", None), "the original kept here is gone");
    }

    #[test]
    fn a_read_that_fails_or_stops_short_is_not_the_whole_file() {
        // `chunks`: what each read hands over; `fail`: whether the read after them fails, else it says the end
        let run = |size: u64, chunks: &[usize], fail: bool| {
            let mut left = chunks.to_vec().into_iter();
            let mut seen = 0u64;
            let r = super::read_whole(size, 16, |_| match left.next() { Some(n) => (n, false), None => (0, fail) }, |b| { seen += b.len() as u64; Ok(()) });
            (r, seen)
        };
        assert_eq!(run(20, &[16, 4], false), (Ok(20), 20));
        assert_eq!(run(0, &[16, 4], false), (Ok(20), 20), "size not known, the phone says the end");
        assert_eq!(run(20, &[16, 4], true), (Ok(20), 20), "all of it came: a phone that errors at the end has given the file");
        assert!(run(20, &[16], false).0.is_err(), "stops short");
        assert!(run(20, &[16], true).0.is_err(), "fails midway");
        assert!(run(0, &[16], true).0.is_err(), "fails midway, size not known");
        assert!(run(0, &[], true).0.is_err(), "fails at once: two such files must not look the same");
    }

    #[test]
    fn same_names_from_two_folders_never_share_a_work_file() {
        let d = std::path::Path::new("job");
        let (a, a2) = super::work_files(d, "o1", "video.mp4");
        let (b, b2) = super::work_files(d, "o2", "video.mp4");
        assert!(a != b && a2 != b2);
        assert_eq!(super::work_files(d, "o1", "video.mp4").0, a, "Apply finds what the job made");
        assert_eq!(a.extension().unwrap(), "mp4");
    }

    #[test]
    fn the_sweep_takes_old_jobs_only_and_never_a_kept_original() {
        let root = std::env::temp_dir().join(format!("leonote-sweep-{}", std::process::id()));
        for d in ["1000", "90000000", "kept"] { std::fs::create_dir_all(root.join(d)).unwrap(); }
        super::sweep_work(&root, 90_000_000);
        assert!(!root.join("1000").exists() && root.join("90000000").exists() && root.join("kept").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copying_off_the_phone_asks_for_a_folder_not_handed_over() {
        let body = include_str!("phone.rs").split("pub async fn phone_copy").nth(1).unwrap().split("#[cfg(windows)]").next().unwrap();
        assert!(body.contains("grant::allow(&app, &dir,"));
    }

    #[test]
    fn a_busy_phone_loses_no_folder_and_a_gone_one_is_said_so() {
        use super::{walk, ScanState};
        use serde_json::{json, Value};
        use std::cell::RefCell;
        use std::collections::HashMap;
        use std::sync::atomic::AtomicBool;
        let file = |id: &str| json!({ "id": id, "name": format!("{id}.mp4"), "dir": false });
        let dir = |id: &str| json!({ "id": id, "name": id, "dir": true });
        let phone: HashMap<&str, Vec<Value>> = HashMap::from([
            ("DEVICE", vec![dir("Storage")]),
            ("Storage", vec![dir("DCIM"), dir("Telegram"), file("top")]),
            ("DCIM", vec![file("a"), file("b"), file("c")]),
            ("Telegram", vec![file("d")]),
        ]);
        // `fails`: how many times each folder fails, after handing over its first file
        let run = |fails: HashMap<&'static str, u32>, stop: bool| {
            let left = RefCell::new(fails);
            let (mut names, mut end) = (Vec::new(), ScanState::default());
            walk(true, &AtomicBool::new(stop), |pid, found| {
                let list = &phone[pid];
                let mut l = left.borrow_mut();
                if l.get(pid).copied().unwrap_or(0) > 0 {
                    *l.get_mut(pid).unwrap() -= 1;
                    if let Some(first) = list.first() { found(first.clone()); }
                    return Err("busy".into());
                }
                for it in list { found(it.clone()); }
                Ok(())
            }, |items, st| { names.extend(items.into_iter().map(|i| i["id"].as_str().unwrap().to_string())); end = st; });
            names.sort();
            (names, end)
        };
        let all: Vec<String> = ["a", "b", "c", "d", "top"].map(String::from).to_vec();
        let (names, st) = run(HashMap::new(), false);
        assert_eq!(names, all);
        assert!(st.done && st.unread == 0 && !st.gone);
        // busy twice, then answers: everything, each file once
        let (names, st) = run(HashMap::from([("DCIM", 2), ("Storage", 2)]), false);
        assert_eq!(names, all, "read again, nothing twice");
        assert_eq!((st.unread, st.gone, st.folders), (0, false, 4));
        // never answers: the rest still comes, and it is said
        let (names, st) = run(HashMap::from([("DCIM", 99)]), false);
        assert_eq!(names, ["a", "d", "top"]);
        assert_eq!((st.unread, st.gone), (1, false));
        // unplugged: stops soon instead of going through everything, and says so
        let (names, st) = run(HashMap::from([("DEVICE", 99), ("Storage", 99), ("DCIM", 99), ("Telegram", 99)]), false);
        assert!(names.len() < 5);
        assert!(st.gone && st.done && st.unread > 0);
        // stopped by the user: said too
        let (_, st) = run(HashMap::new(), true);
        assert!(st.stopped && st.done);
    }

    /// What a scan of the phone plugged in finds: `cargo test --lib real_phone_scan -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_phone_scan() {
        let list = super::win::devices().unwrap();
        let dev = list[0]["id"].as_str().expect("a phone plugged in").to_string();
        let t0 = std::time::Instant::now();
        let (mut files, mut videos) = (0, 0);
        super::win::scan(dev, true, Default::default(), move |items, st| {
            files += items.len();
            videos += items.iter().filter(|i| { let n = i["name"].as_str().unwrap_or("").to_lowercase(); [".mp4", ".mov", ".3gp", ".mkv", ".webm", ".m4v"].iter().any(|e| n.ends_with(e)) }).count();
            println!("{} folders, {files} files, {videos} videos, {}s {st:?}", st.folders, t0.elapsed().as_secs());
        }).unwrap();
    }

    #[test]
    fn the_scan_skips_only_what_is_the_systems_and_reads_the_camera_first() {
        use super::{read_first, skip_system_folder as skip};
        let top = "Internal shared storage";
        assert!(!skip("Android", top, 1), "Android itself is walked: Android/media holds people's videos");
        assert!(!skip("media", "Internal shared storage/Android", 2));
        assert!(skip("data", "Internal shared storage/Android", 2));
        assert!(skip("obb", "Internal shared storage/Android", 2));
        assert!(!skip("data", "Internal shared storage/Work", 2), "a folder of the user's own called data stays");
        assert!(skip(".thumbnails", "Internal shared storage/DCIM", 2));
        assert!(read_first("Internal shared storage/DCIM") && read_first("Internal shared storage/DCIM/Camera"));
        assert!(!read_first("Internal shared storage/Android/media") && !read_first("Internal shared storage"));
    }
    use super::*;

    #[test]
    fn video_arguments_keep_what_the_gallery_needs() {
        let a = video_args("in.mp4", "out.mp4", "h265", "gentle").join(" ");
        assert!(a.contains("-map_metadata 0") && a.contains("-c:a copy") && a.contains("libx265") && a.contains("-crf 24") && a.contains("-tag:v hvc1") && a.ends_with("out.mp4"));
        let b = video_args("in.mp4", "out.mp4", "h264", "strong").join(" ");
        assert!(b.contains("libx264") && b.contains("-crf 25") && !b.contains("hvc1"));
    }

    #[test]
    fn names_and_free_paths() {
        assert_eq!(safe_name("a:b?.jpg"), "a_b_.jpg");
        assert_eq!(safe_name("  . "), "file");
        assert_eq!(safe_name("CON.jpg"), "_CON.jpg");
        assert_eq!(safe_name("com1.png"), "_com1.png");
        assert_eq!(safe_name("Console.jpg"), "Console.jpg");
        let dir = std::env::temp_dir().join(format!("leonote-phone-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("IMG_1.jpg"), b"x").unwrap();
        assert_eq!(free_path(&dir, "IMG_1.jpg").file_name().unwrap(), "IMG_1 (2).jpg");
        assert_eq!(free_path(&dir, "IMG_2.jpg").file_name().unwrap(), "IMG_2.jpg");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(percent_decode("a%20b%2Fc+d"), "a b/c d");
    }

    /// Windows' codecs turn a picture into a JPEG (a BMP here: every Windows reads it), scaled down when asked.
    #[cfg(windows)]
    #[test]
    fn wic_makes_a_jpeg() {
        let (w, h) = (40u32, 20u32);
        let row = ((w * 3 + 3) / 4 * 4) as usize;
        let mut bmp = Vec::new();
        let size = 54 + row * h as usize;
        bmp.extend_from_slice(b"BM"); bmp.extend_from_slice(&(size as u32).to_le_bytes()); bmp.extend_from_slice(&[0; 4]); bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes()); bmp.extend_from_slice(&(w as i32).to_le_bytes()); bmp.extend_from_slice(&(h as i32).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes()); bmp.extend_from_slice(&24u16.to_le_bytes()); bmp.extend_from_slice(&[0; 24]);
        bmp.extend(std::iter::repeat(0x80u8).take(row * h as usize));
        let j = win::to_jpeg(Some(&bmp), None, 10).expect("a jpeg");
        assert!(j.starts_with(&[0xFF, 0xD8]), "JPEG magic");
        // and the phone list answers (empty or not) without failing
        assert!(win::devices().is_ok());
    }
}

#[cfg(all(test, windows))]
mod compress_tests {
    use super::*;
    use std::process::Command;

    fn ff() -> Option<PathBuf> { crate::external::tool_path("ffmpeg", None) }

    /// A photo made again keeps being a JPEG, of the same size in pixels, and gets smaller.
    #[test]
    fn a_jpeg_again() {
        let Some(ff) = ff() else { return };
        let dir = std::env::temp_dir().join(format!("leonote-cj-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.jpg");
        assert!(Command::new(&ff).args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1600x1200:d=0.04", "-frames:v", "1", "-q:v", "1"]).arg(&src).status().unwrap().success());
        let out = dir.join("b.jpg");
        win::jpeg_again(&src, &out, 0.86).expect("made again");
        let (a, b) = (std::fs::metadata(&src).unwrap().len(), std::fs::metadata(&out).unwrap().len());
        assert!(b < a, "{b} < {a}");
        let j = std::fs::read(&out).unwrap();
        assert!(j.starts_with(&[0xFF, 0xD8]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A video made again keeps its sound, its date and its container, and gets smaller.
    #[test]
    fn a_video_again_keeps_its_date() {
        let Some(ff) = ff() else { return };
        let Some(probe) = crate::external::tool_path("ffprobe", None) else { return };
        let dir = std::env::temp_dir().join(format!("leonote-cv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("v.mp4");
        assert!(Command::new(&ff).args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-crf", "8", "-c:a", "aac", "-metadata", "creation_time=2025-06-01T10:00:00Z"]).arg(&src).status().unwrap().success());
        let out = dir.join("o.mp4");
        let a = video_args(&src.to_string_lossy(), &out.to_string_lossy(), "h264", "gentle");
        assert!(Command::new(&ff).args(&a).status().unwrap().success());
        let o = Command::new(&probe).args(["-v", "error", "-show_entries", "stream=codec_type:format_tags=creation_time", "-of", "default=nw=1"]).arg(&out).output().unwrap();
        let s = String::from_utf8_lossy(&o.stdout);
        assert!(s.contains("codec_type=video") && s.contains("codec_type=audio") && s.contains("2025-06-01T10:00:00"), "{s}");
        assert!(std::fs::metadata(&out).unwrap().len() < std::fs::metadata(&src).unwrap().len());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod path_tests {
    #[test]
    fn heic_reads_only_drive_paths() {
        use std::path::Path;
        for ok in [r"C:\Pics\a.heic", r"\\?\C:\Pics\a.heic", "D:/Pics/a.heic"] { assert!(super::local_disk_path(Path::new(ok)), "{ok}"); }
        for bad in [r"\\host\share\a.heic", "//host/share/a.heic", r"\\?\UNC\host\share\a.heic", r"\\.\pipe\x.heic", r"Pics\a.heic", r"C:a.heic", r"\Pics\a.heic"] {
            assert!(!super::local_disk_path(Path::new(bad)), "{bad} must be refused");
        }
    }
}
