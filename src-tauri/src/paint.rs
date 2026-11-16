//! The `.leostudio` container: Leonote's layered pixel documents (Draw, Photo, Animate).
//! Files from before the rename are `.leopaint` and still load and save.
//!
//! # The format
//!
//! A `.leostudio` file is an ordinary zip archive. Rename one to `.zip`,
//! double-click it, and everything is there in plain sight:
//!
//! ```text
//! doc.json          the manifest (below), pretty-printed UTF-8 JSON
//! layers/<id>.png   one full-size RGBA PNG per layer, bottom-first
//! thumb.png         a small flattened preview (used by the file view)
//! ```
//!
//! `doc.json`:
//!
//! ```json
//! {
//!   "format": "leopaint",
//!   "version": 1,
//!   "app": "Leonote 1.0.0",
//!   "created": "2026-09-18T10:00:00.000Z",
//!   "modified": "2026-09-18T10:31:00.000Z",
//!   "width": 2048, "height": 2048, "dpi": 144,
//!   "background": "#ffffff",
//!   "selected": "l3k2a01",
//!   "layers": [
//!     { "id": "l3k2a01", "name": "Sketch", "file": "layers/l3k2a01.png",
//!       "opacity": 1, "visible": true, "locked": false,
//!       "alphaLock": false, "blend": "normal" }
//!   ]
//! }
//! ```
//!
//! Version 2 (Studio) adds, per layer and all optional: `"kind"` (`raster`,
//! `adjust`, `group`, `text`), `"clip"`, `"parent"` (the id of the group it is
//! in), `"mask"` (a second PNG, `layers/<id>-mask.png`, whose ALPHA is how much
//! of the layer shows), `"adjust"` (an adjustment's type and numbers) and
//! `"text"` (the words and their style). A layer without pixels has
//! `"file": null`. A document that uses none of this is still written as
//! version 1, so it opens in a Leonote from before Studio.
//!
//! Why a zip of PNGs and not a private binary blob: a drawing somebody made
//! in Leonote should still be eight PNGs and a readable JSON file in ten
//! years, whether or not Leonote is still around, and whether or not this
//! code still runs. Every layer opens in any image viewer. Nothing here is
//! compressed twice (PNG is already deflated, so the entries are *stored*),
//! nothing is encrypted, and a file that has lost its manifest can still be
//! salvaged by hand.
//!
//! # This module
//!
//! Three commands — save, load, inspect — plus the zip reading and writing
//! they share. Layer PNGs cross the IPC boundary as base64, because the
//! webview hands us canvas bitmaps as data URLs and takes them back the same
//! way; `inspect` exists precisely so the common case (a file view wanting a
//! thumbnail and a size) never pays for that.
//!
//! Paths go through `vault::resolve_file` like every other file command, so
//! `..`, dot-directories and absolute paths are refused before anything is
//! opened.

use std::io::{Cursor, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;
use zip::write::SimpleFileOptions;

use crate::vault;
use crate::AppState;

pub const EXT: &str = "leostudio";
/// The same container under its old name (the app renames these once; a straggler still opens).
pub const OLD_EXT: &str = "leopaint";
pub const MANIFEST: &str = "doc.json";
pub const THUMB: &str = "thumb.png";
pub const LAYER_DIR: &str = "layers/";

/// Biggest document we will write or read back. Twenty layers of a
/// 4000 × 4000 canvas compress to well under this; past it something has gone
/// wrong and we would rather say so than spend a minute finding out.
pub const MAX_DOC: usize = 512 * 1024 * 1024;
/// Biggest manifest. A manifest is a few hundred bytes per layer.
pub const MAX_MANIFEST: usize = 4 * 1024 * 1024;
pub const MAX_LAYERS: usize = 64;

/// One layer on its way in or out: the id from the manifest and its PNG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerBlob {
    pub id: String,
    /// base64 PNG bytes — no data-URL prefix
    pub png: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaintDoc {
    /// `doc.json` verbatim, for the frontend to parse
    pub manifest: String,
    pub layers: Vec<LayerBlob>,
    pub thumb: Option<String>,
    pub bytes: u64,
}

/// What the file view needs to show a `.leopaint` without decoding its layers.
#[derive(Debug, Clone, Serialize)]
pub struct PaintInfo {
    pub path: String,
    pub format: String,
    pub version: u64,
    pub width: u64,
    pub height: u64,
    pub dpi: u64,
    pub layers: usize,
    pub layer_names: Vec<String>,
    pub app: String,
    pub created: String,
    pub modified: String,
    pub thumb: Option<String>,
    pub bytes: u64,
    pub mtime: u64,
}

fn is_paint(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXT) || e.eq_ignore_ascii_case(OLD_EXT))
}

fn check_name(rel: &str) -> Result<(), String> {
    if !is_paint(rel) {
        return Err(format!("not a drawing: {}", rel));
    }
    Ok(())
}

/// A layer id, as it is allowed to appear inside the archive. The id becomes a
/// file name, so it is restricted to characters that cannot climb out of the
/// `layers/` folder or mean something to a file system.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/* ── the container ───────────────────────────────────────────────────────── */

/// Build a `.leopaint` in memory. Kept separate from the command so the tests
/// can round-trip a document without a vault or an app handle.
pub fn pack(manifest: &str, layers: &[(String, Vec<u8>)], thumb: Option<&[u8]>) -> Result<Vec<u8>, String> {
    if manifest.len() > MAX_MANIFEST {
        return Err("the manifest is too large".into());
    }
    // every layer may carry a mask, which travels as a second PNG under the
    // id "<layer>-mask"; the ceiling is on layers, and on masks, separately
    let masks = layers.iter().filter(|(id, _)| id.ends_with("-mask")).count();
    if layers.len() - masks > MAX_LAYERS || masks > MAX_LAYERS {
        return Err(format!("a drawing cannot have more than {} layers", MAX_LAYERS));
    }
    // the manifest has to be JSON: a container whose doc.json does not parse is
    // not worth writing over somebody's file
    let parsed: serde_json::Value = serde_json::from_str(manifest).map_err(|e| format!("the manifest is not JSON: {}", e))?;
    if !parsed.is_object() {
        return Err("the manifest is not an object".into());
    }
    let mut out = Vec::with_capacity(1 << 20);
    {
        let mut zw = zip::ZipWriter::new(Cursor::new(&mut out));
        // PNG is already deflated; deflating it again costs time and saves
        // nothing, and stored entries mean a reader can memory-map them
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let json_opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zw.start_file(MANIFEST, json_opts).map_err(|e| e.to_string())?;
        zw.write_all(manifest.as_bytes()).map_err(|e| e.to_string())?;
        for (id, png) in layers {
            if !safe_id(id) {
                return Err(format!("odd layer id: {}", id));
            }
            zw.start_file(format!("{}{}.png", LAYER_DIR, id), opts).map_err(|e| e.to_string())?;
            zw.write_all(png).map_err(|e| e.to_string())?;
        }
        if let Some(t) = thumb {
            zw.start_file(THUMB, opts).map_err(|e| e.to_string())?;
            zw.write_all(t).map_err(|e| e.to_string())?;
        }
        zw.finish().map_err(|e| e.to_string())?;
    }
    if out.len() > MAX_DOC {
        return Err(format!("the drawing is larger than {} MB", MAX_DOC / (1024 * 1024)));
    }
    Ok(out)
}

/// Read one entry out of a container. `None` when it is not there. `room` is how many bytes may still be
/// unpacked: a small file can name one big entry over and over, so each entry's own size says too little.
fn entry<R: std::io::Read + std::io::Seek>(zr: &mut zip::ZipArchive<R>, name: &str, room: &mut usize) -> Result<Option<Vec<u8>>, String> {
    let mut f = match zr.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if f.size() > *room as u64 {
        return Err(format!("{} is too large", name));
    }
    *room -= f.size() as usize;
    let mut buf = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut buf).map_err(|e| format!("{}: {}", name, e))?;
    Ok(Some(buf))
}

/// Everything in a container: manifest, every layer PNG, the thumbnail.
pub fn unpack(bytes: &[u8]) -> Result<(String, Vec<(String, Vec<u8>)>, Option<Vec<u8>>), String> {
    let mut zr = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "this is not a Leonote drawing (not a zip)".to_string())?;
    let mut room = MAX_MANIFEST;
    let manifest = entry(&mut zr, MANIFEST, &mut room)?.ok_or("this drawing has no doc.json")?;
    room = MAX_DOC;
    let manifest = String::from_utf8(manifest).map_err(|_| "doc.json is not UTF-8".to_string())?;
    let meta: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| format!("doc.json is not JSON: {}", e))?;
    let mut layers = Vec::new();
    if let Some(arr) = meta.get("layers").and_then(|v| v.as_array()) {
        for l in arr.iter().take(MAX_LAYERS) {
            let id = match l.get("id").and_then(|v| v.as_str()) {
                Some(id) if safe_id(id) => id.to_string(),
                _ => continue,
            };
            // trust the manifest's own file name, but only inside layers/
            let file = l
                .get("file")
                .and_then(|v| v.as_str())
                .filter(|f| f.starts_with(LAYER_DIR) && !f.contains("..") && !f.contains('\\'))
                .map(|f| f.to_string())
                .unwrap_or_else(|| format!("{}{}.png", LAYER_DIR, id));
            // a layer whose PNG is missing opens as an empty layer rather than
            // failing the whole file: half a drawing beats none
            if let Some(png) = entry(&mut zr, &file, &mut room)? {
                layers.push((id.clone(), png));
            }
            // version 2: a layer's mask is a second PNG beside it, handed
            // back under the id "<layer>-mask"
            let mask = l
                .get("mask")
                .and_then(|v| v.as_str())
                .filter(|f| f.starts_with(LAYER_DIR) && !f.contains("..") && !f.contains('\\'));
            if let Some(file) = mask {
                if let Some(png) = entry(&mut zr, file, &mut room)? {
                    layers.push((format!("{}-mask", id), png));
                }
            }
        }
    }
    let thumb = entry(&mut zr, THUMB, &mut room)?;
    Ok((manifest, layers, thumb))
}

fn read_file(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    check_name(rel)?;
    let abs = vault::resolve_file(root, rel)?;
    let md = std::fs::metadata(&abs).map_err(|e| format!("{}: {}", rel, e))?;
    if md.len() as usize > MAX_DOC {
        return Err(format!("{} is larger than {} MB", rel, MAX_DOC / (1024 * 1024)));
    }
    std::fs::read(&abs).map_err(|e| format!("read {}: {}", rel, e))
}

/* ── commands ────────────────────────────────────────────────────────────── */

/// Write a drawing. The whole container is built in memory and then written
/// through `vault::write_atomic`, so a crash mid-save cannot leave half a
/// drawing where the old one was.
#[tauri::command]
pub async fn paint_save(
    app: tauri::AppHandle,
    path: String,
    manifest: String,
    layers: Vec<LayerBlob>,
    thumb: Option<String>,
    state: State<'_, AppState>,
) -> Result<vault::FileEntry, String> {
    check_name(&path)?;
    crate::guest_ok(&app, &path, &state)?;
    let mut decoded = Vec::with_capacity(layers.len());
    for l in &layers {
        decoded.push((l.id.clone(), b64_decode(&l.png).ok_or_else(|| format!("layer {} is not valid base64", l.id))?));
    }
    let thumb_bytes = match thumb.as_deref() {
        Some(t) if !t.is_empty() => Some(b64_decode(t).ok_or("the thumbnail is not valid base64")?),
        _ => None,
    };
    let bytes = pack(&manifest, &decoded, thumb_bytes.as_deref())?;
    let abs = vault::resolve_file(&state.paths.vault, &path)?;
    let _io = crate::lock(&state.io);
    // same rule as every other editor in the app: the first overwrite of a
    // file in a session leaves the previous version in .trash
    if abs.is_file() && crate::lock(&state.backed_up).insert(path.to_lowercase()) {
        if let Err(e) = vault::backup_file(&state.paths.vault, &path, &crate::trash_stamp()) {
            crate::lock(&state.backed_up).remove(&path.to_lowercase());
            return Err(e);
        }
    }
    vault::write_atomic(&abs, &bytes).map_err(|e| format!("write {}: {}", path, e))?;
    vault::file_entry(&state.paths.vault, &path)
}

/// Read a drawing back: the manifest, every layer's PNG and the thumbnail.
#[tauri::command]
pub async fn paint_load(path: String, state: State<'_, AppState>) -> Result<PaintDoc, String> {
    let bytes = read_file(&state.paths.vault, &path)?;
    let (manifest, layers, thumb) = unpack(&bytes)?;
    Ok(PaintDoc {
        manifest,
        layers: layers.into_iter().map(|(id, png)| LayerBlob { id, png: b64_encode(&png) }).collect(),
        thumb: thumb.map(|t| b64_encode(&t)),
        bytes: bytes.len() as u64,
    })
}

/// What a drawing is, without decoding its layers: size, layer names and the
/// thumbnail. This is what the file view and previews use, and it stays cheap
/// however big the drawing is.
#[tauri::command]
pub async fn paint_inspect(path: String, state: State<'_, AppState>) -> Result<PaintInfo, String> {
    check_name(&path)?;
    let abs = vault::resolve_file(&state.paths.vault, &path)?;
    let md = std::fs::metadata(&abs).map_err(|e| format!("{}: {}", path, e))?;
    if md.len() as usize > MAX_DOC { return Err(format!("{} is larger than {} MB", path, MAX_DOC / (1024 * 1024))); }
    // read where it lies: a card needs the manifest and the small thumbnail, not the whole drawing in memory
    let file = std::fs::File::open(&abs).map_err(|e| format!("read {}: {}", path, e))?;
    let mut zr = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|_| "this is not a Leonote drawing (not a zip)".to_string())?;
    let mut room = MAX_MANIFEST;
    let manifest = entry(&mut zr, MANIFEST, &mut room)?.ok_or("this drawing has no doc.json")?;
    // this runs for every card on screen, and a thumbnail is a small picture
    room = MAX_MANIFEST;
    let meta: serde_json::Value = serde_json::from_slice(&manifest).map_err(|e| format!("doc.json is not JSON: {}", e))?;
    let thumb = entry(&mut zr, THUMB, &mut room)?.map(|t| b64_encode(&t));
    let names: Vec<String> = meta
        .get("layers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|l| l.get("name").and_then(|v| v.as_str()).unwrap_or("Layer").to_string())
                .collect()
        })
        .unwrap_or_default();
    let s = |k: &str| meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let n = |k: &str, d: u64| meta.get(k).and_then(|v| v.as_u64()).unwrap_or(d);
    Ok(PaintInfo {
        path,
        format: s("format"),
        version: n("version", 1),
        width: n("width", 0),
        height: n("height", 0),
        dpi: n("dpi", 72),
        layers: names.len(),
        layer_names: names,
        app: s("app"),
        created: s("created"),
        modified: s("modified"),
        thumb,
        bytes: md.len(),
        mtime: md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

/* ── base64 ──────────────────────────────────────────────────────────────── */
//
// Hand-rolled rather than a new dependency: this is the only place in the app
// that needs it, it is forty lines, and the tests below pin it.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    // tolerate a data-URL prefix and any whitespace the webview slipped in
    let body = match s.find("base64,") {
        Some(i) => &s[i + 7..],
        None => s,
    };
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for ch in body.bytes() {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
