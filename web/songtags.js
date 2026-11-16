// Your own tags for songs and videos ("car with friends", "calm", "lobby"…),
// and a song's details (title, artist, album, year, track, genre, cover).
// A file's tags live in the file itself, in its Grouping field, so any other
// player shows them too; an online video's live in its entry here. The
// details are written into the file by the app (a copy first, swapped in).
import { h } from "./util.js";
import { icon } from "./icons.js";
import { isOnline, isLib } from "./playqueue.js";
import { peekMeta, loadMeta, forgetMeta } from "./mediameta.js";

export const AUDIO_FILE = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|aiff?|wma|ape|wv|mpc)$/i;

/** "a; b, c" -> ["a", "b", "c"], each once, as written. */
export function splitTags(text) {
  const out = [];
  const seen = new Set();
  for (const t of String(text || "").split(/[;,]/)) {
    const v = t.trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
}
export const joinTags = (list) => list.join("; ");

/** A key's tags: the online entry's own, or the file's Grouping field (once its details are read). */
export function tagsOf(app, M, key) {
  if (isOnline(key)) return ((M.online.entry(key) || {}).tags || []).slice();
  const f = fileOf(app, M, key);
  const m = f && peekMeta(f);
  return m ? splitTags(m.grouping) : [];
}
export function fileOf(app, M, key) {
  return isLib(key) ? M.libraries.entry(key) : app.vault.files.get(key);
}
/** Can this one carry tags we can write? Online entries always; files: songs, when the app can write them. */
export const taggable = (app, key) => isOnline(key) || (AUDIO_FILE.test(key) && !!app.host.musicTagsWrite);

/** Write details into a song file, then forget what was read of it so the new facts are read back. */
export async function writeSong(app, M, key, fields) {
  const res = await app.host.musicTagsWrite(key, fields);
  const f = fileOf(app, M, key);
  if (f) {
    forgetMeta(f);
    if (res && res.mtime) f.mtime = res.mtime; // a library file's entry: its new version
  }
  return res;
}

/** Tags added to and taken from many at once; every other tag each one has stays. */
export async function retag(app, M, keys, add = [], remove = []) {
  const low = new Set(remove.map((x) => x.toLowerCase()));
  let done = 0, failed = 0, lastErr = "";
  for (const key of keys) {
    const before = tagsOf(app, M, key);
    const next = [...before.filter((t) => !low.has(t.toLowerCase())), ...add.filter((t) => !before.some((b) => b.toLowerCase() === t.toLowerCase()))];
    if (next.join("\n") === before.join("\n")) continue;
    try {
      if (isOnline(key)) M.online.mark(key, { tags: next });
      else {
        const f = fileOf(app, M, key);
        if (f && !peekMeta(f)) await loadMeta(app, f);
        await writeSong(app, M, key, { grouping: joinTags(next) });
      }
      done++;
    } catch (e) { failed++; lastErr = String(e); }
  }
  return { done, failed, lastErr };
}

/** Every tag in use among these keys, with how many carry it. */
export function tagCounts(app, M, keys) {
  const n = new Map();
  for (const k of keys) for (const t of tagsOf(app, M, k)) { const key = t.toLowerCase(); const e = n.get(key) || { tag: t, n: 0 }; e.n++; n.set(key, e); }
  return [...n.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

/* ── the dialogs ─────────────────────────────────────────────────────────── */

function dialog(title, body, { ok = "Save", onOk }) {
  return new Promise((resolve) => {
    const done = async (v) => {
      if (v && onOk) { okBtn.disabled = true; try { if ((await onOk()) === false) { okBtn.disabled = false; return; } } catch (e) { okBtn.disabled = false; err.textContent = String(e && e.message ? e.message : e); return; } }
      back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v);
    };
    const err = h("p", { class: "dlg-text st-err" });
    const okBtn = h("button", { class: "btn btn-primary", onclick: () => done(true) }, ok);
    const box = h("div", { class: "dlg st-dlg", role: "dialog", "aria-modal": "true" },
      h("h3", { class: "dlg-title", text: title }), body, err,
      h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), okBtn));
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } }, box);
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } else if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); done(true); } };
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
  });
}

/** Tags for one or many: chips to take away, a box to add, your other tags one click away. */
export function tagsDialog(app, M, keys, known = []) {
  const all = keys.map((k) => tagsOf(app, M, k));
  // what every one of them has shows as a chip; what only some have shows faded, and a click on it gives it to all
  const common = all.length ? all[0].filter((t) => all.every((l) => l.some((x) => x.toLowerCase() === t.toLowerCase()))) : [];
  const partial = [...new Set(all.flat())].filter((t) => !common.some((c) => c.toLowerCase() === t.toLowerCase()));
  const add = new Set(), remove = new Set();
  const chips = h("div", { class: "st-chips" });
  const input = h("input", { class: "text-input is-wide", placeholder: "A tag, then Enter - calm, car with friends, lobby…", spellcheck: false });
  const shown = () => [...common.filter((t) => !remove.has(t)), ...add].filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i);
  const paint = () => {
    chips.replaceChildren(
      ...shown().map((t) => h("span", { class: "st-chip" }, t, h("button", { class: "st-x", title: "Take it away", onclick: () => { if (add.has(t)) add.delete(t); else remove.add(t); paint(); } }, icon("x")))),
      ...partial.filter((t) => !remove.has(t) && !add.has(t)).map((t) => h("button", { class: "st-chip is-some", title: "Only some have it - click to give it to all", onclick: () => { add.add(t); paint(); } }, t, " ·")),
    );
    const own = new Set(shown().map((t) => t.toLowerCase()));
    sugg.replaceChildren(...known.filter((t) => !own.has(t.toLowerCase())).slice(0, 18).map((t) => h("button", { class: "chip-btn", onclick: () => { add.add(t); remove.delete(t); paint(); } }, "+ " + t)));
  };
  const sugg = h("div", { class: "st-sugg" });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.ctrlKey) {
      e.preventDefault();
      for (const t of splitTags(input.value)) { add.add(t); remove.delete(t); }
      input.value = "";
      paint();
    }
  });
  paint();
  setTimeout(() => input.focus(), 30);
  const files = keys.filter((k) => !isOnline(k)).length;
  const body = h("div", { class: "st-body" },
    h("p", { class: "dlg-text", text: keys.length > 1 ? `${keys.length} picked. ${files ? "A song's tags are written into the file itself (its Grouping field), so other players see them too." : ""}` : files ? "Written into the song file itself (its Grouping field), so other players see them too." : "Kept with this video in Leonote." }),
    chips, input, known.length ? h("div", { class: "st-label", text: "Your tags" }) : null, sugg);
  return dialog(keys.length > 1 ? `Tags for ${keys.length}` : "Tags", body, {
    onOk: async () => {
      for (const t of splitTags(input.value)) add.add(t);
      const r = await retag(app, M, keys, [...add], [...remove]);
      if (r.failed) throw new Error(`${r.failed} could not be written: ${r.lastErr}`);
      if (r.done) app.toast(`Tags saved for ${r.done}`, { ms: 1800 });
    },
  });
}

/** One song's details, written into the file. */
export async function detailsDialog(app, M, key) {
  const f = fileOf(app, M, key);
  let now = {};
  try { now = await app.host.musicTags(key, true); } catch (e) { app.toast("Could not read it: " + e, { kind: "error" }); return false; }
  const FIELDS = [["title", "Title"], ["artist", "Artist"], ["album", "Album"], ["albumArtist", "Album artist"], ["year", "Year"], ["track", "Track"], ["genre", "Genre"]];
  const inputs = new Map(FIELDS.map(([k, label]) => [k, h("input", { class: "text-input", value: now[k] || "", placeholder: label, spellcheck: false, onkeydown: (e) => e.stopPropagation() })]));
  let cover = undefined; // undefined: as it is · string: new picture (base64) · null: none
  let coverMime = "image/jpeg";
  const art = h("div", { class: "st-cover" });
  const paintArt = (src) => { art.replaceChildren(src ? h("img", { src, alt: "" }) : h("span", { class: "st-nocover" }, icon("music"))); };
  paintArt(now.cover ? `data:${now.cover.mime};base64,${now.cover.data}` : "");
  const pick = () => {
    const inp = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", style: { display: "none" } });
    inp.addEventListener("change", () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) return app.toast("Pick a smaller picture (under 8 MB)", { kind: "error" });
      const rd = new FileReader();
      rd.onload = () => { const url = String(rd.result); coverMime = file.type || "image/jpeg"; cover = url.slice(url.indexOf(",") + 1); paintArt(url); };
      rd.readAsDataURL(file);
    });
    document.body.append(inp);
    inp.click();
  };
  const body = h("div", { class: "st-body st-details" },
    h("div", { class: "st-cover-col" }, art, h("div", { class: "st-cover-acts" }, h("button", { class: "chip-btn", onclick: pick }, icon("image"), "Change…"), h("button", { class: "chip-btn", onclick: () => { cover = null; paintArt(""); } }, "Remove"))),
    h("div", { class: "st-grid" }, ...FIELDS.map(([k, label]) => h("label", { class: "st-field" }, h("span", { text: label }), inputs.get(k)))));
  const name = key.slice(key.lastIndexOf("/") + 1);
  return dialog(name, body, {
    onOk: async () => {
      const fields = {};
      for (const [k] of FIELDS) { const v = inputs.get(k).value.trim(); if (v !== String(now[k] || "")) fields[k] = v; }
      if (cover !== undefined) { fields.cover = cover; fields.coverMime = coverMime; }
      if (!Object.keys(fields).length) return true;
      await writeSong(app, M, key, fields);
      if (f) loadMeta(app, f).catch(() => {});
      app.toast(`Saved into ${name}`, { ms: 1800 });
    },
  });
}
