// Note ids, and tags kept in the same place.
//
// A note something links to carries `id: …` in its front matter - an ordinary
// property to Obsidian, hidden in Leonote's editor. Leonote remembers where each
// id was last seen (<vault>/.leonote/ids.json, so it travels with the vault):
// a note renamed or moved outside the app is found again by its id, and the
// links to it follow. A linked note that is gone is reported, with ways to put
// the links right: a note that may be it, any note picked, or the trash. The
// links themselves stay [[Name]], so the vault reads the same in Obsidian.
//
// Settings › Editor › Note ids (on by default). Off: no new ids are written;
// those there are still used.

import { h, debounce, basename } from "./util.js";
import { icon } from "./icons.js";
import { host } from "./host.js";
import { fuzzy, highlight } from "./search.js";
import { setFrontField } from "./projects.js";

/** A short id, unique enough for one person's notes: time, then a little chance. */
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;
const clean = (t) => t.trim().replace(/^["'#]+|["']+$/g, "");

/** The tags in a note's front matter, in whichever form they are written. */
export function frontTags(content) {
  const m = FM.exec(content);
  if (!m) return [];
  const fm = m[1];
  const inline = /^tags:[ \t]*\[(.*)\][ \t]*$/m.exec(fm);
  if (inline) return inline[1].split(",").map(clean).filter(Boolean);
  const block = /^tags:[ \t]*\r?\n((?:[ \t]*-[ \t]*.+(?:\r?\n|$))+)/m.exec(fm + "\n");
  if (block) return block[1].split("\n").map((l) => clean(l.replace(/^\s*-\s*/, ""))).filter(Boolean);
  const one = /^tags:[ \t]*(\S.*)$/m.exec(fm);
  return one ? one[1].split(/[,\s]+/).map(clean).filter(Boolean) : [];
}

/** The front matter's tags made `tags` (one line, `tags: [a, b]`; none, and the entry goes). */
export function setFrontTags(content, tags) {
  const line = tags.length ? `tags: [${tags.join(", ")}]` : null;
  const m = FM.exec(content);
  if (!m) return line ? `---\n${line}\n---\n${content}` : content;
  let fm = m[1]
    .replace(/^tags:[ \t]*\r?\n(?:[ \t]*-[ \t]*.+(?:\r?\n|$))+/m, "")
    .replace(/^tags:.*(?:\r?\n|$)/m, "")
    .replace(/\s+$/, "");
  if (line) fm = fm ? fm + "\n" + line : line;
  const body = content.slice(m[0].length);
  return fm.trim() ? `---\n${fm}\n---\n${body}` : body;
}

// a note that may be the missing one: one name holds the other, or they start the same way
const alike = (a, b) => {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  return k >= Math.min(5, Math.max(3, Math.floor(a.length / 2)));
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `#tag` taken out of the text (not the front matter); a line that held only tags and is empty now goes. */
function dropInlineTag(body, tag) {
  const re = new RegExp(`(^|[\\s(])#${esc(tag)}(?=$|[\\s.,;:!?)\\]])`, "gi");
  const out = [];
  for (const line of body.split("\n")) {
    if (!re.test(line)) { out.push(line); continue; }
    re.lastIndex = 0;
    const was = /^(\s*#[^\s#]+\s*)+$/.test(line);
    const next = line.replace(re, "$1").replace(/[ \t]{2,}/g, " ").replace(/\s+$/, "");
    if (was && !next.trim()) continue;
    out.push(next);
  }
  return out.join("\n");
}

export function mountNoteIds(app) {
  const vault = app.vault;
  const on = () => app.settings.noteIds !== false;
  let known = null; // id -> where it was last seen
  let missing = {}; // id -> where a linked note was, gone now, its links leading nowhere
  let told = false; // the first ids given: said once
  let saved = null; // what was last written: a pause in typing with nothing new writes nothing (a synced vault would upload it again)
  const save = () => {
    const data = { v: 1, at: known, missing, told }, text = JSON.stringify(data);
    if (text === saved) return;
    saved = text;
    host.saveIds(data).catch(() => { saved = null; });
  };
  const saveSoon = debounce(save, 1500);
  const remember = () => {
    const seen = new Map();
    for (const n of vault.notes.values()) {
      if (!n.id) continue;
      const first = seen.get(n.id);
      if (!first) { seen.set(n.id, n.path); continue; }
      // the same id twice: a copy. The note the id was known at keeps it; the other gives it up
      const keep = known && known[n.id] === n.path ? n.path : first;
      dropId(keep === n.path ? first : n.path);
      seen.set(n.id, keep);
    }
    known = Object.fromEntries(vault.ids());
    saveSoon();
  };
  const rememberSoon = debounce(remember, 2000);

  /* ── ids for the notes that are linked to ── */
  const queue = new Set();
  let draining = false;
  function wantIds(path) {
    const n = vault.get(path);
    if (!n) return;
    for (const l of n.links) {
      const t = vault.resolve(l.target, path);
      const tn = t && t !== path ? vault.get(t) : null;
      if (tn && !tn.id) queue.add(t);
    }
  }
  async function drain() {
    if (draining || !on()) return;
    draining = true;
    let given = 0;
    try {
      while (queue.size && on()) {
        for (const p of [...queue].slice(0, 25)) {
          queue.delete(p);
          const n = vault.get(p);
          // a note being typed in waits: its next change brings it back here
          if (!n || n.id || (app.isDirty && app.isDirty(p)) || vault.pending(p)) continue;
          await vault.stamp(p, setFrontField(n.content, "id", newId()));
          given++;
        }
        await new Promise((r) => setTimeout(r, 150)); // a little at a time: nothing else waits on it
      }
    } finally {
      draining = false;
      if (given) {
        remember();
        if (!told) {
          told = true;
          save();
          app.toast(`${given} linked note${given === 1 ? "" : "s"} got an id - a hidden line in the note's header that lets Leonote find it again if it is renamed outside the app. Settings › Editor › Note ids`, { ms: 9000 });
        }
      }
    }
  }
  const drainSoon = debounce(drain, 800);

  /* ── finding moved notes again; reporting the ones that are gone ── */
  // a note in a folder left out of indexing is not read, so not in the vault's lists - but it is not gone
  const unindexed = (p) => (Array.isArray(app.settings.noIndex) ? app.settings.noIndex : []).some((f) => p.toLowerCase().startsWith(String(f).toLowerCase().replace(/\/+$/, "") + "/"));
  // the link targets that lead nowhere, worked out once per pass: asking vault.brokenFor per gone note walks every link each time
  const danglingTargets = () => {
    const out = new Set();
    for (const n of vault.notes.values()) for (const l of n.links) if (!vault.resolve(l.target, n.path) && !vault.unindexedFor(l.target)) out.add(l.target.toLowerCase().replace(/\.md$/, ""));
    return out;
  };
  // a link written with the note's name or with any end of its path: what vault.brokenFor counts
  const isLinked = (targets, was) => { const parts = was.slice(0, -3).toLowerCase().split("/"); return parts.some((_, i) => targets.has(parts.slice(i).join("/"))); };
  async function heal({ quiet = false } = {}) {
    if (!known) return;
    const now = vault.ids();
    let targets = null;
    const linked = (was) => isLinked(targets ??= danglingTargets(), was);
    const moved = [];
    for (const [id, was] of Object.entries(known)) {
      const at = now.get(id);
      if (at && at !== was && !vault.notes.has(was)) moved.push({ id, from: was, to: at });
      else if (!at && !vault.notes.has(was) && !unindexed(was) && linked(was)) missing[id] = was;
    }
    const fixed = [];
    for (const m of moved) { const k = await vault.relinkMoved(m.from, m.to); if (k) { fixed.push({ ...m, notes: k }); targets = null; } }
    // back again (restored, renamed back) or its links mended another way: off the list
    for (const [id, p] of Object.entries(missing)) if (now.has(id) || unindexed(p) || !linked(p)) delete missing[id];
    remember();
    if (fixed.length) {
      const k = fixed.reduce((a, f) => a + f.notes, 0);
      app.toast(`${fixed.length === 1 ? `“${basename(fixed[0].to)}” was` : `${fixed.length} notes were`} renamed or moved outside Leonote - found by ${fixed.length === 1 ? "its id" : "their ids"}; ${k} note${k === 1 ? "" : "s"} relinked`, {
        ms: 9000, action: { label: "Which", run: () => report(fixed) },
      });
    }
    const miss = Object.keys(missing).length;
    if (miss && !quiet) {
      app.toast(`${miss === 1 ? `“${basename(Object.values(missing)[0])}”` : `${miss} linked notes`} went missing - the links to ${miss === 1 ? "it" : "them"} lead nowhere`, {
        kind: "error", ms: 12000, action: { label: "Fix…", run: fixer },
      });
    }
    return { fixed, missing: miss };
  }
  const healSoon = debounce(() => heal(), 600);

  /* ── the dialogs ── */
  function dialog(title, body) {
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const box = h("div", { class: "dlg ni-dlg", role: "dialog" }, h("h3", { class: "dlg-title", text: title }), body,
      h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => close() }, "Close")));
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
    document.body.append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
    document.addEventListener("keydown", onKey, true);
    return close;
  }
  function report(fixed) {
    dialog("Notes found again by their ids", h("div", { class: "ni-list" }, fixed.map((f) =>
      h("div", { class: "ni-row" }, icon("fileText"), h("span", { class: "ni-from", text: basename(f.from) }), icon("forward"),
        h("button", { class: "ni-name", onclick: () => app.openNote(f.to) }, f.to), h("small", { text: `${f.notes} note${f.notes === 1 ? "" : "s"} relinked` })))));
  }
  // each missing note: a note that may be it, any note, the trash - or let it go
  async function fixer() {
    const trash = await host.trashList().catch(() => []);
    let close = null;
    const rows = () => Object.entries(missing).map(([id, was]) => {
      const name = basename(was);
      const refs = vault.brokenFor(was);
      const like = [...vault.notes.values()].filter((n) => alike(name, n.title)).map((n) => [fuzzy(name, n.title), n]).sort((a, b) => (b[0] ? b[0].score : 0) - (a[0] ? a[0].score : 0)).slice(0, 3).map(([, n]) => n);
      const binned = (trash || []).find((t) => (t.from || "").toLowerCase() === was.toLowerCase() || (t.name || "").toLowerCase() === (name + ".md").toLowerCase());
      const mend = async (to) => {
        const k = await vault.relinkMoved(was, to);
        delete missing[id];
        save();
        app.toast(`${k} note${k === 1 ? "" : "s"} link to “${basename(to)}” now`, { ms: 3000 });
        close(); if (Object.keys(missing).length) fixer();
      };
      return h("div", { class: "ni-miss" },
        h("div", { class: "ni-miss-head" }, icon("alert"), h("b", { text: name }), h("small", { text: `${was} · ${refs.length} note${refs.length === 1 ? " links" : "s link"} to it: ${refs.slice(0, 3).map(basename).join(", ")}${refs.length > 3 ? "…" : ""}` })),
        h("div", { class: "ni-acts" },
          ...like.map((n) => h("button", { class: "chip-btn", title: n.path, onclick: () => mend(n.path) }, icon("link"), `It is “${n.title}”`)),
          h("button", { class: "chip-btn", onclick: () => { close(); app.pickNote({ title: `Which note is “${name}” now?`, onPick: mend }); } }, icon("search"), "Find it…"),
          binned ? h("button", { class: "chip-btn", title: "It was deleted in Leonote: bring it back", onclick: async () => {
            try { const r = await host.trashRestore({ entry: binned.entry }); const p = (r && r.path) || was; setTimeout(() => (p === was ? (delete missing[id], save(), close(), app.toast(`“${name}” is back`)) : mend(p)), 600); }
            catch (e) { app.toast("Could not restore: " + e, { kind: "error" }); }
          } }, icon("undo"), "Restore from the trash") : null,
          h("button", { class: "chip-btn", title: "Leave the links as they are and stop telling", onclick: () => { delete missing[id]; save(); close(); if (Object.keys(missing).length) fixer(); } }, icon("x"), "Let it go")));
    });
    const list = rows();
    close = dialog("Linked notes that went missing", list.length
      ? h("div", { class: "ni-list" }, h("p", { class: "dlg-text", text: "These notes had ids and others linked to them; they are not in the vault now - deleted, or renamed and changed outside Leonote at the same time. Deleted in Explorer: look in the Windows Recycle Bin." }), list)
      : h("p", { class: "dlg-text", text: "Every linked note is where its links say. Nothing to mend." }));
  }

  /* ── tags ── */
  const tagOf = (raw) => String(raw || "").replace(/^#+/, "").trim().replace(/\s+/g, "-");
  /** A tag added: into the front matter with note ids on, else on the note's first line. Returns what to undo, or null. */
  async function addTag(path, raw) {
    const tag = tagOf(raw);
    const n = tag && vault.get(path);
    if (!n) return null;
    if (n.tags.includes(tag.toLowerCase())) { app.toast(`Already tagged #${tag}`, { ms: 1800 }); return null; }
    const prev = n.content;
    let next;
    if (on()) next = setFrontTags(prev, [...frontTags(prev), tag]);
    else {
      const fm = FM.exec(prev);
      const head = fm ? fm[0] : "", rest = prev.slice(head.length);
      const first = rest.split("\n", 1)[0];
      next = /^(#[^\s#]+\s*)+$/.test(first.trim()) ? head + first.trimEnd() + " #" + tag + rest.slice(first.length) : head + "#" + tag + "\n" + rest;
    }
    await vault.write(path, next, { expected: true });
    return { prev, next, tag };
  }
  /** A tag taken off the note: from the front matter and from the text. */
  async function removeTag(path, raw) {
    const tag = tagOf(raw);
    const n = tag && vault.get(path);
    if (!n) return null;
    const prev = n.content;
    const low = tag.toLowerCase();
    const ft = frontTags(prev);
    let next = ft.some((t) => t.toLowerCase() === low) ? setFrontTags(prev, ft.filter((t) => t.toLowerCase() !== low)) : prev;
    const fm = FM.exec(next);
    const head = fm ? fm[0] : "";
    next = head + dropInlineTag(next.slice(head.length), tag);
    if (next === prev) { app.toast(`#${tag} is not written in this note itself`, { ms: 2400 }); return null; }
    await vault.write(path, next, { expected: true });
    return { prev, next, tag };
  }

  /* ── wiring ── */
  vault.bus.on("changed", (e) => {
    if (e.stamp) return;
    if (on() && e.linksChanged !== false) { wantIds(e.path); drainSoon(); }
    rememberSoon();
  });
  vault.bus.on("renamed", (e) => {
    // renamed outside the app (the watcher saw the same text leave one name and arrive at another): links follow
    if (e.external) vault.relinkMoved(e.from, e.to).then((k) => { if (k) app.toast(`“${basename(e.to)}” was renamed outside Leonote - ${k} note${k === 1 ? "" : "s"} relinked`, { ms: 5000 }); });
    rememberSoon();
  });
  vault.bus.on("removed", (e) => { if (e.external) healSoon(); else rememberSoon(); });
  vault.bus.on("structure", () => rememberSoon());
  app.bus.on("settings", (k) => { if (k === "noteIds" && on()) { for (const p of vault.notes.keys()) wantIds(p); drainSoon(); } });

  (async () => {
    const data = await host.loadIds().catch(() => null);
    told = !!(data && data.told);
    missing = (data && data.missing && typeof data.missing === "object") ? data.missing : {};
    known = data && data.at && typeof data.at === "object" ? data.at : null;
    if (known) await heal({ quiet: false });
    else remember();
    if (on()) { for (const p of vault.notes.keys()) wantIds(p); drainSoon(); }
  })();

  /** Tags that suit a note: those of the notes it links to and that link to it first, then of its folder - none it has. */
  function suggestTags(path) {
    const n = vault.get(path);
    if (!n) return [];
    const have = new Set(n.tags);
    const score = new Map();
    const add = (tags, w) => { for (const t of tags) if (!have.has(t)) score.set(t, (score.get(t) || 0) + w); };
    for (const l of n.links) { const t = vault.resolve(l.target, path); const tn = t && t !== path ? vault.get(t) : null; if (tn) add(tn.tags, 3); }
    for (const b of vault.backlinks(path)) add(b.note.tags, 3);
    for (const x of vault.notes.values()) if (x.folder === n.folder && x.path !== path) add(x.tags, 1);
    return [...score].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  }

  /** A field to tag a note with: before typing, tags that suit it; typing, the vault's tags that match (the
   *  used and the suitable first), and the new one typed. Enter takes the marked one, Tab fills it in,
   *  Shift+Enter adds exactly what was typed. `onAdded({ prev, next, tag })` for an undo. */
  function tagField(path, { onAdded, autofocus = false } = {}) {
    // worked out when the field is entered: what the vault holds by then
    let counts = new Map(), suits = [], have = new Set();
    const fresh = () => { counts = vault.tagCounts(); suits = suggestTags(path); const n0 = vault.get(path); have = new Set(n0 ? n0.tags : []); };
    const input = h("input", { class: "tag-field-input", placeholder: "+ tag", spellcheck: false, title: "A tag for this note - Enter" });
    const list = h("div", { class: "tag-field-list", hidden: true });
    let at = 0, shown = [];
    const rank = ([f, t, c]) => f.score + Math.log2(c + 1) * 8 + (suits.includes(t) ? 40 : 0);
    function paint() {
      const q = input.value.replace(/^#+/, "").trim().toLowerCase().replace(/\s+/g, "-");
      if (!q) shown = suits.filter((t) => !have.has(t)).map((t) => ({ t, hint: "suits it" }));
      else {
        shown = [...counts].filter(([t]) => !have.has(t)).map(([t, c]) => [fuzzy(q, t), t, c]).filter(([f]) => f)
          .sort((a, b) => rank(b) - rank(a)).slice(0, 8).map(([f, t, c]) => ({ t, f, hint: `${c} note${c === 1 ? "" : "s"}` }));
        if (!counts.has(q) && !have.has(q)) shown.push({ t: q, hint: "new" });
      }
      if (at >= shown.length) at = 0;
      list.replaceChildren(...shown.map((s, k) => h("button", { class: "tag-field-item" + (k === at ? " is-on" : ""), onmousedown: (e) => e.preventDefault(), onclick: () => pick(s.t) },
        h("span", {}, "#", s.f ? highlight(s.t, s.f.hits) : s.t), h("small", { text: s.hint }))));
      list.hidden = !shown.length || document.activeElement !== input;
    }
    async function pick(t) {
      if (!t) return;
      const r = await addTag(path, t);
      if (!r) return;
      have.add(r.tag.toLowerCase());
      input.value = "";
      if (onAdded) onAdded(r);
      paint();
    }
    input.addEventListener("input", () => { at = 0; paint(); });
    input.addEventListener("focus", () => { fresh(); paint(); });
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (shown.length) { at = (at + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; paint(); } }
      else if (e.key === "Enter") { e.preventDefault(); pick(e.shiftKey || !shown[at] ? input.value : shown[at].t); }
      else if (e.key === "Tab" && shown[at]) { e.preventDefault(); input.value = shown[at].t; paint(); }
      else if (e.key === "Escape") { e.preventDefault(); input.value = ""; input.blur(); }
    });
    if (autofocus) setTimeout(() => input.focus());
    return h("div", { class: "tag-field" }, input, list);
  }

  /** A copy keeps no id of its original's (two notes, one id, would be one note to the links). */
  function dropId(path) {
    const n = vault.get(path);
    if (!n || !n.id) return;
    const m = FM.exec(n.content);
    if (!m) return;
    const fm = m[1].replace(/^id:.*(?:\r?\n|$)/m, "").replace(/\s+$/, "");
    const body = n.content.slice(m[0].length);
    vault.stamp(path, fm.trim() ? `---\n${fm}\n---\n${body}` : body);
  }

  return {
    addTag, removeTag, frontTags, heal, fixer, dropId, tagField, suggestTags,
    missing: () => ({ ...missing }),
    /** The whole check, for the command: heal, then the dialog if anything is missing. */
    check: async () => { const r = await heal({ quiet: true }); if (r && r.missing) fixer(); else if (!r || !r.fixed.length) app.toast("Every link leads somewhere it was meant to", { ms: 2400 }); },
  };
}
