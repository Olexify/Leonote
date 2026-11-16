// Reading and writing the sidecars, and keeping the rendered result around.
//
// Everything that wants to know "has this picture been edited, and what does
// it look like now?" — the viewer, the file view, the editor — comes through
// here, so one picture is read, parsed and rendered once.

import { docChangesPicture, isEmptyDoc, normalizeDoc, serializeDoc, sidecarPath } from "./imageeditmodel.js";
import { renderDoc } from "./imageeditrender.js";

const docs = new Map(); // vault path -> { doc, stamp }
const urls = new Map(); // vault path -> { url, stamp }

export { sidecarPath };

const bump = () => Date.now() + Math.random();

let watching = false; // a renamed picture's edits went with it on disk; what is remembered under either name is stale

/** Drop everything remembered for a picture (it changed, or was trashed). */
export function forget(path) {
  const u = urls.get(path);
  if (u && u.url) URL.revokeObjectURL(u.url);
  urls.delete(path);
  docs.delete(path);
}

export function forgetAll() {
  for (const p of [...urls.keys()]) forget(p);
}

/** What is already known, without going to disk. */
export function peekDoc(path) {
  const e = docs.get(path);
  return e ? e.doc : null;
}

/**
 * The stored edits for a picture, or an empty document. Never throws: a
 * picture whose sidecar cannot be read simply has no edits.
 */
export async function loadDoc(app, path, { width = 0, height = 0, fresh = false } = {}) {
  if (!watching && app.vault) {
    watching = true;
    app.vault.bus.on("fileRenamed", ({ from, to }) => { forget(from); forget(to); });
  }
  if (!fresh && docs.has(path)) return docs.get(path).doc;
  let text = null;
  try {
    text = await app.host.imageEditRead(path);
  } catch {
    text = null;
  }
  const doc = normalizeDoc(text, { width, height });
  docs.set(path, { doc, stamp: bump() });
  return doc;
}

/** True when this picture has edits worth showing. */
export async function hasEdits(app, path) {
  const doc = await loadDoc(app, path);
  return docChangesPicture(doc);
}

/**
 * Store the edits. An empty document removes the sidecar instead of writing
 * one, so "undo everything" really does leave the folder as it was.
 */
export async function saveDoc(app, path, doc) {
  const d = normalizeDoc(doc);
  docs.set(path, { doc: d, stamp: bump() });
  const u = urls.get(path);
  if (u && u.url) URL.revokeObjectURL(u.url);
  urls.delete(path);
  if (isEmptyDoc(d)) {
    await app.host.imageEditDelete(path);
    return { removed: true };
  }
  await app.host.imageEditWrite(path, serializeDoc(d, { image: path.slice(path.lastIndexOf("/") + 1) }));
  return { removed: false };
}

/** Are this picture's edits switched off (kept, but not shown)? */
export async function editsOff(app, path) {
  const doc = await loadDoc(app, path);
  return !!doc.off;
}

/** The viewer's switch, remembered beside the edits themselves. */
export async function setEditsOff(app, path, off) {
  const doc = await loadDoc(app, path);
  if (!!doc.off === !!off || isEmptyDoc(doc)) return;
  const have = urls.get(path); // the render is still good: only the switch moved
  urls.delete(path);
  await saveDoc(app, path, { ...doc, off: !!off });
  if (have) urls.set(path, have);
}

export async function clearDoc(app, path) {
  forget(path);
  await app.host.imageEditDelete(path);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // local pictures load CORS-clean, so the rendered copy can be read back
    if (/^(blob:|data:)|asset\.localhost|^asset:/i.test(url)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not load " + url));
    img.src = url;
  });
}

/**
 * A URL for the picture as edited, or null when it has no edits (callers then
 * keep using the original file, which costs nothing).
 */
export async function editedUrl(app, path, srcUrl, { maxSide = 0 } = {}) {
  const doc = await loadDoc(app, path);
  if (!docChangesPicture(doc)) return null;
  const have = urls.get(path);
  if (have && have.maxSide === maxSide) return have.url;
  try {
    const img = await loadImage(srcUrl);
    const canvas = renderDoc(img, doc, { maxSide });
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    const old = urls.get(path);
    if (old && old.url) URL.revokeObjectURL(old.url);
    urls.set(path, { url, maxSide, stamp: bump() });
    return url;
  } catch {
    return null;
  }
}

export { loadImage };
