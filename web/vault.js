// The notes model: every note in memory, indexed for links, tags and search.
// Disk writes are serialised per path; the model updates first, so the UI
// never waits on the disk.

import { parseNote, rewriteLinks, moveLinkFolder } from "./mdparse.js";
import { basename, dirname, joinPath, safeName, emitter } from "./util.js";

/** A note not in UTF-8 reads with U+FFFD for its letters, so writing it back replaces them: why to leave it alone, or "".
 *  ponytail: goes by the text in memory, so a UTF-8 note that truly holds U+FFFD counts too; knowing for sure needs a new host call */
export const notUtf8 = (n, path) => (n && n.content.includes("\uFFFD") ? `${path} cannot be read as text, so it was left alone` : "");

/** Below this there is nothing much to lose, and the ratio gets noisy. */
export const SHRINK_MIN = 80;
/** Keeping under a third of a note is a loss worth mentioning. */
export const SHRINK_RATIO = 0.3;

/** True when replacing `before` with `after` throws most of the note away. */
export function shrank(before, after) {
  const was = String(before == null ? "" : before);
  if (was.trim().length < SHRINK_MIN) return false;
  const now = String(after == null ? "" : after);
  return !now.trim() || now.length < was.length * SHRINK_RATIO;
}

const ECHO_MS = 5000;

export function createVault(host) {
  const bus = emitter();
  const notes = new Map(); // path -> note
  const files = new Map(); // path -> { path, size, mtime, kind }  (everything that isn't a note)
  let filesByName = new Map(); // lower file name -> [paths]  (Obsidian resolves attachments by name)
  let listed = new Set(); // the paths the last setFiles held (a file put in `files` directly is not news until a list brings it)
  const folders = new Set();
  const byName = new Map(); // lower title -> Set<path>
  const chains = new Map(); // path -> Promise (serialised writes)
  // renames, moves and trashings under way: a save made meanwhile lands where the note went (old path -> new,
  // null for the trash), not at the old path - that made a ghost note there and left the words out of the moved one
  const moves = new Set();
  function startMove() {
    let end;
    const m = { to: new Map(), done: new Promise((r) => (end = r)) };
    m.end = () => { moves.delete(m); end(); };
    moves.add(m);
    return m;
  }
  /** Where a write made now should land once the moves under way are over: the new path, or null (trashed). */
  function landing(path) {
    const ms = [...moves];
    return Promise.all(ms.map((m) => m.done)).then(() => ms.reduce((p, m) => (p != null && m.to.has(p) ? m.to.get(p) : p), path));
  }
  const recent = new Map(); // path -> [{ content, at }, what we wrote recently]
  const failed = new Set(); // paths whose last write did not reach the disk: the model is ahead of the file
  let saving = 0;
  let root = "";

  /** A link rewrite writes the note back whole: not when that replaces its letters. Said by "relinkLeftOut". */
  const leftOut = (x) => { const why = notUtf8(x, x.path); if (why) bus.emit("relinkLeftOut", { path: x.path, why }); return !!why; };

  const key = (p) => basename(p).toLowerCase();

  function addName(p) {
    const k = key(p);
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(p);
  }
  function delName(p) {
    const s = byName.get(key(p));
    if (s) { s.delete(p); if (!s.size) byName.delete(key(p)); }
  }
  function addFolderChain(dir) {
    while (dir && !folders.has(dir)) { folders.add(dir); dir = dirname(dir); }
  }

  let tagMemo = null;
  function upsert(path, content, mtime) {
    tagMemo = null;
    let n = notes.get(path);
    if (!n) {
      n = { path, ctime: mtime || Date.now() };
      notes.set(path, n);
      addName(path);
      addFolderChain(dirname(path));
    }
    n.title = basename(path);
    n.folder = dirname(path);
    n.content = content;
    n.lower = content.toLowerCase();
    n.mtime = mtime || Date.now();
    const m = parseNote(content);
    n.links = m.links;
    n.tags = m.tags;
    n.headings = m.headings;
    n.words = m.words;
    n.tasks = m.tasks;
    n.done = m.done;
    n.id = m.id;
    return n;
  }

  // a link target that named the note at `from`: its name, or its path
  const wasFor = (from) => {
    const base = basename(from).toLowerCase(), full = from.slice(0, -3).toLowerCase();
    return (t) => { const lt = t.toLowerCase().replace(/\.md$/, ""); return lt === base || lt === full || from.toLowerCase().endsWith("/" + lt + ".md"); };
  };

  // the notes holding a link, by the link's last name (all that wasFor's three matches share). Built once per tick: a
  // folder moved outside the app sends one rename per note, all in the same emit
  let holdersNow = null;
  function linkHolders() {
    if (holdersNow) return holdersNow;
    const m = new Map();
    for (const x of notes.values()) for (const l of x.links) {
      const t = l.target.toLowerCase().replace(/\.md$/, ""), k = t.slice(t.lastIndexOf("/") + 1);
      const a = m.get(k);
      if (!a) m.set(k, [x]); else if (a[a.length - 1] !== x) a.push(x);
    }
    holdersNow = m;
    queueMicrotask(() => { holdersNow = null; });
    return m;
  }

  function drop(path) {
    tagMemo = null;
    notes.delete(path);
    delName(path);
    recent.delete(path);
    failed.delete(path);
  }

  function remember(path, content) {
    const now = Date.now();
    const arr = recent.get(path) || [];
    arr.push({ content, at: now });
    if (arr.length > 6) arr.shift();
    recent.set(path, arr);
    // past the echo window they can never match (external): full copies of every note edited this session otherwise
    for (const [p, a] of recent) if (p !== path && !chains.has(p) && now - a[a.length - 1].at > ECHO_MS) recent.delete(p);
  }

  function enqueue(path, fn) {
    saving++;
    bus.emit("saving", saving);
    const prev = chains.get(path) || Promise.resolve();
    const p = prev
      .catch(() => {})
      .then(fn)
      .catch((err) => { bus.emit("error", { path, err }); })
      .finally(() => {
        saving--;
        bus.emit("saving", saving);
        if (chains.get(path) === p) chains.delete(path);
      });
    chains.set(path, p);
    return p;
  }

  function resolve(target, from) {
    let t = target.trim().replace(/\\/g, "/");
    if (!t) return null;
    if (t.toLowerCase().endsWith(".md")) t = t.slice(0, -3);
    if (t.includes("/")) {
      const want = t.toLowerCase().replace(/^\/+/, "") + ".md";
      // only the notes of that name: a link that leads nowhere does not read every path
      for (const p of byName.get(t.slice(t.lastIndexOf("/") + 1).toLowerCase()) || []) {
        const lp = p.toLowerCase();
        if (lp === want || lp.endsWith("/" + want)) return p;
      }
      return null;
    }
    const set = byName.get(t.toLowerCase());
    if (!set || !set.size) return null;
    if (set.size === 1) return set.values().next().value;
    const dir = from ? dirname(from) : "";
    const arr = [...set];
    return arr.find((p) => dirname(p) === dir) || arr.sort((a, b) => a.length - b.length)[0];
  }

  // the notes in folders left out of indexing: their paths only (Rust unindexed_names) - a link to one still
  // leads somewhere, and is never taken for a note that is gone. name.md (lower case) -> [paths]
  let unidx = new Map();
  function unindexedFor(target) {
    if (!unidx.size) return null;
    let t = String(target || "").split("|")[0].split("#")[0].trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    if (!t) return null;
    if (!t.endsWith(".md")) t += ".md";
    const arr = unidx.get(t.slice(t.lastIndexOf("/") + 1));
    if (!arr) return null;
    return t.includes("/") ? arr.find((p) => { const lp = p.toLowerCase(); return lp === t || lp.endsWith("/" + t); }) || null : arr[0];
  }

  /** The shortest link text that unambiguously reaches `path`. */
  function linkText(path) {
    const set = byName.get(key(path));
    return set && set.size > 1 ? path.slice(0, -3) : basename(path);
  }

  // `name` is used as it is (a moved note keeps its own name); a new name goes through safeName first
  function uniquePath(dir, base, ext = ".md") {
    let p = joinPath(dir, base + ext);
    for (let i = 1; notes.has(p) || [...notes.keys()].some((x) => x.toLowerCase() === p.toLowerCase()); i++)
      p = joinPath(dir, `${base} ${i}${ext}`);
    return p;
  }

  return {
    bus,
    notes,
    folders,
    failed,
    get root() { return root; },
    get saving() { return saving; },
    resolve,
    linkText,
    uniquePath,

    load(boot) {
      root = boot.vault || "";
      for (const n of boot.notes || []) upsert(n.path, n.content, n.mtime);
      for (const f of boot.folders || []) addFolderChain(f);
      this.setFiles(boot.files || [], true);
    },

    files,

    setFiles(list, quiet) {
      files.clear();
      filesByName = new Map();
      for (const f of list) {
        if (!f || !f.path) continue;
        files.set(f.path, f);
        addFolderChain(dirname(f.path));
        const k = f.path.slice(f.path.lastIndexOf("/") + 1).toLowerCase();
        if (!filesByName.has(k)) filesByName.set(k, []);
        filesByName.get(k).push(f.path);
      }
      // only a file saved or grown, none come or gone: nothing to redraw (the tree, boards and every editor do on "structure")
      const same = files.size === listed.size && [...files.keys()].every((p) => listed.has(p));
      listed = new Set(files.keys());
      if (!quiet && !same) bus.emit("structure", {});
    },

    /** An attachment reference like `pic.png`, `Utilities/Cache/pic.png` or a
     *  path relative to the note. Returns the file record or null. */
    resolveFile(target, from) {
      let t = String(target || "").split("|")[0].split("#")[0].trim().replace(/\\/g, "/");
      try { t = decodeURIComponent(t); } catch {}
      t = t.replace(/^\.\//, "").replace(/^\/+/, "");
      if (!t) return null;
      if (files.has(t)) return files.get(t);
      if (from) {
        const rel = joinPath(dirname(from), t);
        if (files.has(rel)) return files.get(rel);
      }
      const hits = filesByName.get(t.slice(t.lastIndexOf("/") + 1).toLowerCase());
      if (!hits || !hits.length) return null;
      const dir = from ? dirname(from) : "";
      return files.get(hits.find((p) => dirname(p) === dir) || hits[0]);
    },

    /** The notes that link to or show this file: [{ path, line }], one per note (its first mention). */
    usedIn(path) {
      const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
      const out = [];
      for (const n of notes.values()) {
        const c = n.content || "";
        if (!n.lower.includes(name)) continue;
        const re = /!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!?\[[^\]]*\]\(([^)\s]+)\)/g;
        for (let m; (m = re.exec(c)); ) {
          let t = (m[1] || m[2] || "").trim();
          try { t = decodeURIComponent(t); } catch {}
          const f = this.resolveFile(t, n.path);
          if (f && f.path === path) { out.push({ path: n.path, line: c.slice(0, m.index).split("\n").length - 1 }); break; }
        }
      }
      return out;
    },

    /** Point every note's link to file `from` at `to` instead: [[name]] / ![[name]] when the name changed,
     *  a link that spells out the old path ([[a/b.png]], ![](a/b.png), spaces as %20 too) to the new path. */
    async relinkFile(from, to) {
      const oldName = from.slice(from.lastIndexOf("/") + 1).toLowerCase();
      const newName = to.slice(to.lastIndexOf("/") + 1);
      const fromLow = from.toLowerCase();
      const nameChanged = newName.toLowerCase() !== oldName;
      const enc = (s) => s.replace(/ /g, "%20");
      let n = 0;
      for (const x of [...notes.values()]) {
        if (!x.lower.includes(oldName) && !x.lower.includes(enc(oldName))) continue;
        let c = x.content, changed = 0;
        let r = rewriteLinks(c, (t) => t.toLowerCase() === fromLow, to);
        c = r.content; changed += r.changed;
        if (nameChanged) { r = rewriteLinks(c, (t) => t.toLowerCase() === oldName, newName); c = r.content; changed += r.changed; }
        c = c.replace(/(\]\()([^)\s]+)(\))/g, (whole, a, target, b) => {
          const plain = target.replace(/%20/g, " ").replace(/^\.?\//, "");
          if (plain.toLowerCase() !== fromLow) return whole;
          changed++;
          return a + (target.includes("%20") || !target.includes(" ") ? enc(to) : to) + b;
        });
        if (changed && !leftOut(x)) { n++; await this.write(x.path, c); bus.emit("relinked", { path: x.path, content: c }); }
      }
      return n;
    },

    async renameFile(from, to) {
      await host.fileRename(from, to);
      const f = files.get(from);
      if (f) {
        const list = [...files.values()].filter((x) => x.path !== from);
        list.push({ ...f, path: to });
        this.setFiles(list);
      }
      bus.emit("fileRenamed", { from, to });
    },

    async trashFile(path, mode) {
      await host.fileTrash(path, mode);
      this.setFiles([...files.values()].filter((x) => x.path !== path));
    },

    get: (path) => notes.get(path),

    backlinks(path) {
      const out = [];
      for (const n of notes.values()) {
        if (n.path === path || !n.links.length) continue;
        const lines = [];
        for (const l of n.links) if (resolve(l.target, n.path) === path) lines.push(l.line);
        if (!lines.length) continue;
        const src = n.content.split("\n");
        out.push({ note: n, lines: [...new Set(lines)].map((i) => ({ line: i, text: src[i] || "" })) });
      }
      return out.sort((a, b) => b.note.mtime - a.note.mtime);
    },

    /** Notes that mention this note's title as plain text without linking it. */
    unlinked(path) {
      const title = basename(path).toLowerCase();
      if (title.length < 3) return [];
      const out = [];
      for (const n of notes.values()) {
        if (n.path === path || !n.lower.includes(title)) continue;
        if (n.links.some((l) => resolve(l.target, n.path) === path)) continue;
        out.push(n);
      }
      return out;
    },

    // asked at every key in the tag palette and every # completion: worked out again only after a note changes
    tagCounts() {
      if (tagMemo) return tagMemo;
      const m = new Map();
      for (const n of notes.values()) for (const t of n.tags) m.set(t, (m.get(t) || 0) + 1);
      return (tagMemo = m);
    },

    /* ── writes ─────────────────────────────────────────────────────────── */
    /**
     * opts.expected: the caller knows the note gets much shorter (replace all,
     * a rewrite the user asked for). Everything else - above all the editor's
     * own auto-save - goes through the shrink check: a note that suddenly
     * loses most of itself is far more often a bug than an intention, so the
     * write still happens, but with the old text kept and offered back.
     */
    write(path, content, opts = {}) {
      const n = notes.get(path);
      if (n && n.content === content && !failed.has(path)) return Promise.resolve();
      // the string, not the note object: upsert below rewrites `n` in place,
      // so a lazy `n.content` would hand back the very text we warned about
      const was = n ? n.content : null;
      if (was != null && !opts.expected && shrank(was, content))
        bus.emit("shrank", {
          path,
          before: was,
          after: content,
          restore: () => this.write(path, was, { expected: true }),
        });
      const linksBefore = n ? n.links.map((l) => l.target).join("\n") + n.tags.join(",") : "";
      const up = upsert(path, content, Date.now());
      remember(path, content);
      const linksChanged = up.links.map((l) => l.target).join("\n") + up.tags.join(",") !== linksBefore;
      bus.emit("changed", { path, local: true, linksChanged, isNew: !n });
      const where = landing(path);
      return enqueue(path, () => where.then((at) => {
        if (at == null) return;
        return host.writeNote(at, content).then((mtime) => {
          // saved at last: the rescue copy kept while it failed goes
          if (failed.delete(at) && host.rescueDrop) host.rescueDrop(at).catch(() => {});
          const x = notes.get(at);
          if (x && x.content === content && mtime) x.mtime = mtime;
        }, (err) => {
          if (notes.has(at)) failed.add(at);
          // not saved: the text is kept beside Leonote's data, not only in this window, until a save gets through
          // (not a file from outside the vault: it is open only for now, and would come back as a note of the vault)
          if (host.rescueKeep && !String(at).startsWith("@guest/")) host.rescueKeep(at, content).catch(() => {});
          throw err;
        });
      }));
    },

    async create(dir, name, content = "") {
      const want = uniquePath(dir, safeName(name));
      const real = (await host.createNote(want, content)) || want;
      upsert(real, content, Date.now());
      remember(real, content);
      bus.emit("structure", { created: real });
      return real;
    },

    /** Every note id in the vault and where it is (the first holder wins a duplicate). */
    ids() {
      const out = new Map();
      for (const n of notes.values()) if (n.id && !out.has(n.id)) out.set(n.id, n.path);
      return out;
    },

    /** The links written for a note that was at `from` - broken now, it is gone from there - lead to `to`
     *  (a note renamed or moved outside the app, found again). A link that still leads somewhere is left alone. */
    async relinkMoved(from, to) {
      const was = wasFor(from);
      const target = linkText(to);
      let relinked = 0;
      for (const x of linkHolders().get(basename(from).toLowerCase()) || []) {
        if (x.path === to) continue;
        const hit = (t) => was(t) && !resolve(t, x.path);
        if (!x.links.some((l) => hit(l.target))) continue;
        const r = rewriteLinks(x.content, hit, target);
        if (r.changed && !leftOut(x)) { relinked++; await this.write(x.path, r.content); bus.emit("relinked", { path: x.path, content: r.content }); }
      }
      return relinked;
    },

    /** The notes whose links were written for `from` and no longer lead anywhere. */
    /** The not-indexed folders' notes, by path: links to them count as leading somewhere. */
    setUnindexed(list) {
      unidx = new Map();
      for (const p of list || []) { const k = p.slice(p.lastIndexOf("/") + 1).toLowerCase(); if (!unidx.has(k)) unidx.set(k, []); unidx.get(k).push(p); }
    },
    /** A link's note in a not-indexed folder (its vault path), or null. */
    unindexedFor,

    brokenFor(from) {
      const was = wasFor(from);
      return [...notes.values()].filter((x) => x.links.some((l) => was(l.target) && !resolve(l.target, x.path) && !unindexedFor(l.target))).map((x) => x.path);
    },

    /** A change the app makes on the user's behalf (an id in a note's front matter): written, but the note
     *  keeps its modified time - it was not edited. */
    stamp(path, content) {
      const n = notes.get(path);
      if (!n || n.content === content) return Promise.resolve();
      upsert(path, content, n.mtime);
      remember(path, content);
      bus.emit("changed", { path, local: true, linksChanged: false, stamp: true });
      const where = landing(path); // stamped during a rename: written where the note went, as a save is
      return enqueue(path, () => where.then((at) => at != null && host.stampNote(at, content).then((t) => { const x = notes.get(at); if (x && x.content === content && t) x.mtime = t; })));
    },

    async rename(from, to) {
      if (from === to) return { path: to, relinked: 0 };
      await (chains.get(from) || Promise.resolve());
      const n = notes.get(from);
      if (!n) throw new Error("no such note");
      const titleChanged = basename(from) !== basename(to) || dirname(from) !== dirname(to);

      // find referrers BEFORE the move, while links still resolve to `from`
      const referrers = [];
      if (titleChanged) {
        for (const x of notes.values()) {
          if (x.path === from) continue;
          if (x.links.some((l) => resolve(l.target, x.path) === from)) referrers.push(x.path);
        }
      }

      const m = startMove();
      try { await host.renameNote(from, to); m.to.set(from, to); } finally { m.end(); }
      const content = n.content;
      const ctime = n.ctime;
      const unsaved = failed.has(from);
      drop(from);
      if (unsaved) failed.add(to);
      const moved = upsert(to, content, Date.now());
      moved.ctime = ctime;
      remember(to, content);
      bus.emit("renamed", { from, to });

      let relinked = 0;
      const target = linkText(to);
      for (const p of referrers) {
        const x = notes.get(p);
        if (!x) continue;
        const r = rewriteLinks(x.content, (t) => {
          const lt = t.toLowerCase().replace(/\.md$/, "");
          return lt === basename(from).toLowerCase() || lt === from.slice(0, -3).toLowerCase() || from.toLowerCase().endsWith("/" + lt + ".md");
        }, target);
        if (r.changed && !leftOut(x)) { relinked++; this.write(p, r.content); bus.emit("relinked", { path: p, content: r.content }); }
      }
      bus.emit("structure", {});
      return { path: to, relinked };
    },

    async trash(path, mode) {
      await (chains.get(path) || Promise.resolve());
      const n = notes.get(path);
      const m = startMove();
      try { await host.trashNote(path, mode); m.to.set(path, null); } finally { m.end(); }
      if (host.rescueDrop) host.rescueDrop(path).catch(() => {}); // binned on purpose: not offered back at the next start
      drop(path);
      bus.emit("removed", { path });
      bus.emit("structure", {});
      return n ? n.content : "";
    },

    /** Put a trashed note back (undo). */
    async restore(path, content) {
      const real = (await host.createNote(path, content)) || path;
      upsert(real, content, Date.now());
      remember(real, content);
      bus.emit("structure", { created: real });
      return real;
    },

    async createFolder(path) {
      await host.createFolder(path);
      addFolderChain(path);
      bus.emit("structure", {});
    },

    async renameFolder(from, to) {
      await Promise.allSettled([...chains.values()]);
      const pre = from + "/";
      const hadFiles = [...files.values()].filter((f) => f.path.startsWith(pre)); // before the wait: the watcher's new list can come first
      const m = startMove();
      try {
        await host.renameFolder(from, to);
        for (const p of notes.keys()) if (p.startsWith(pre)) m.to.set(p, to + "/" + p.slice(pre.length));
      } finally { m.end(); }
      for (const p of [...notes.keys()]) {
        if (!p.startsWith(pre)) continue;
        const n = notes.get(p);
        const np = to + "/" + p.slice(pre.length);
        const unsaved = failed.has(p);
        drop(p);
        if (unsaved) failed.add(np);
        upsert(np, n.content, n.mtime).ctime = n.ctime;
        remember(np, n.content);
        bus.emit("renamed", { from: p, to: np });
      }
      const fileMoves = hadFiles.map((f) => ({ ...f, path: to + "/" + f.path.slice(pre.length) }));
      if (fileMoves.length) {
        const landed = new Set(fileMoves.map((f) => f.path));
        this.setFiles([...[...files.values()].filter((f) => !f.path.startsWith(pre) && !landed.has(f.path)), ...fileMoves], true);
      }
      for (const f of [...folders]) {
        if (f === from || f.startsWith(pre)) { folders.delete(f); addFolderChain(to + f.slice(from.length)); }
      }
      addFolderChain(to);
      bus.emit("folderRenamed", { from, to });
      hadFiles.forEach((f, i) => bus.emit("fileRenamed", { from: f.path, to: fileMoves[i].path }));
      bus.emit("structure", {});
      // links written with the folder's name in them follow it
      let relinked = 0;
      const low = from.toLowerCase() + "/";
      for (const x of [...notes.values()]) {
        if (!x.lower.includes(low) && !x.lower.includes(low.replace(/ /g, "%20"))) continue;
        const r = moveLinkFolder(x.content, from, to);
        if (r.changed && !leftOut(x)) { relinked++; await this.write(x.path, r.content); bus.emit("relinked", { path: x.path, content: r.content }); }
      }
      return { relinked };
    },

    async trashFolder(path, mode) {
      await Promise.allSettled([...chains.values()]);
      const pre = path + "/";
      const m = startMove();
      try {
        await host.trashFolder(path, mode);
        for (const p of notes.keys()) if (p.startsWith(pre)) m.to.set(p, null);
      } finally { m.end(); }
      for (const p of [...notes.keys()]) if (p.startsWith(pre)) { if (host.rescueDrop) host.rescueDrop(p).catch(() => {}); drop(p); bus.emit("removed", { path: p }); }
      for (const f of [...folders]) if (f === path || f.startsWith(pre)) folders.delete(f);
      bus.emit("structure", {});
    },

    idle: () => Promise.allSettled([...chains.values()]),
    pending: (path) => chains.has(path),

    /* ── changes made outside the app ───────────────────────────────────── */
    external(changes) {
      const removed = [];
      const upserted = [];
      for (const c of changes) {
        if (c.content == null) {
          if (!notes.has(c.path) || chains.has(c.path)) continue;
          removed.push({ path: c.path, content: notes.get(c.path).content });
          drop(c.path);
        } else {
          const n = notes.get(c.path);
          if (n && n.content === c.content) continue;
          const mine = recent.get(c.path);
          // an echo of our own save - only while it can be one: later, the same text is someone restoring it
          if (mine && mine.some((e) => e.content === c.content && (chains.has(c.path) || Date.now() - e.at < ECHO_MS))) continue;
          upserted.push({ path: c.path, isNew: !n, before: n ? n.content : null });
          upsert(c.path, c.content, c.mtime);
        }
      }
      // a delete + create of identical content in one batch is a rename
      const renames = [];
      for (const r of removed) {
        const hit = upserted.find((u) => u.isNew && notes.get(u.path).content === r.content);
        if (hit) { renames.push({ from: r.path, to: hit.path }); hit.renamed = true; r.renamed = true; }
      }
      for (const x of renames) bus.emit("renamed", { ...x, external: true });
      for (const r of removed) if (!r.renamed) bus.emit("removed", { path: r.path, external: true });
      for (const u of upserted) if (!u.renamed) bus.emit("changed", { path: u.path, external: true, isNew: u.isNew, linksChanged: true });
      if (removed.length || upserted.some((u) => u.isNew)) bus.emit("structure", {});
      return { removed: removed.length, changed: upserted.length };
    },

    setFolders(list) {
      folders.clear();
      for (const f of list) addFolderChain(f);
      for (const p of notes.keys()) addFolderChain(dirname(p));
      bus.emit("structure", {});
    },
  };
}
