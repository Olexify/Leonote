// Agents' edits waiting for you (proposals.rs): a chip in the status bar while
// any wait, and the review - each change as a diff, with Accept and Reject.
// An accepted change goes in like any edit (the note's earlier text kept in its
// history); a rejected one is only noted in the proposals log.
//
// The same file holds the AI access of folders: Private, Review or Open.

import { h, basename, dirname, debounce } from "./util.js";
import { icon } from "./icons.js";
import { notUtf8 } from "./vault.js";

/**
 * The lines of `a` and `b` as kept / removed / added runs, by their longest common
 * subsequence; past a size where that costs too much, the whole of each as one run.
 */
export function lineDiff(a, b) {
  const A = String(a ?? "").split("\n");
  const B = String(b ?? "").split("\n");
  // the same start and end need no table
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a2 = A.slice(s, A.length - e), b2 = B.slice(s, B.length - e);
  const out = A.slice(0, s).map((t) => ({ op: "=", t }));
  if (a2.length * b2.length > 4_000_000) {
    out.push(...a2.map((t) => ({ op: "-", t })), ...b2.map((t) => ({ op: "+", t })));
  } else {
    const n = a2.length, m = b2.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { out.push({ op: "=", t: a2[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", t: a2[i++] });
      else out.push({ op: "+", t: b2[j++] });
    }
    while (i < n) out.push({ op: "-", t: a2[i++] });
    while (j < m) out.push({ op: "+", t: b2[j++] });
  }
  out.push(...A.slice(A.length - e).map((t) => ({ op: "=", t })));
  return out;
}

/**
 * The agent's changes put into the note as it is now: what it changed between `base` (the note when it
 * read it) and `theirs` goes in on top of `mine` (the note now) - lines the user wrote since stay, lines the
 * user took out stay out. Line by line, on the same diff as the review.
 */
export function mergeLines(base, mine, theirs) {
  const B = String(base ?? "").split("\n");
  const n = B.length;
  // per line of the base: kept or taken out, and what came in before it (index n: at the end)
  const side = (rows) => {
    const kept = new Array(n).fill(true), before = Array.from({ length: n + 1 }, () => []);
    let i = 0;
    let run = -1; // a line replaced: what replaces it goes where it was
    for (const r of rows) {
      if (r.op === "=") { i++; run = -1; }
      else if (r.op === "-") { if (run < 0) run = i; kept[i++] = false; }
      else before[run >= 0 ? run : i].push(r.t);
    }
    return { kept, before };
  };
  const t = side(lineDiff(base, theirs)), m = side(lineDiff(base, mine));
  const out = [];
  for (let i = 0; i <= n; i++) {
    out.push(...m.before[i], ...t.before[i]);
    if (i < n && m.kept[i] && t.kept[i]) out.push(B[i]);
  }
  return out.join("\n");
}

/** The diff as rows to show: changes with three lines around them, the long unchanged stretches folded. */
export function diffRows(rows, around = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.op !== "=") for (let k = Math.max(0, i - around); k <= Math.min(rows.length - 1, i + around); k++) keep[k] = true; });
  const out = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) { if (skipped) { out.push({ op: "…", t: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` }); skipped = 0; } out.push(r); }
    else skipped++;
  });
  if (skipped) out.push({ op: "…", t: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}

/** What the note becomes on Accept: the agent's text - fitted around what was written since, when it can be. */
function resultOf(p) {
  return p.changed && p.now != null && p.base_text != null ? mergeLines(p.base_text, p.now, p.content) : p.content;
}

const ACCESS_WORDS = { private: "private", personal: "private", no: "private", none: "private", false: "private", review: "review", propose: "review", ask: "review", open: "open", yes: "open", write: "open", true: "open" };
/**
 * `ai:` in a note's front matter, if it has one - read exactly as the agents' side reads it (proposals.rs
 * front_access; both are tested against tests/ai_access_cases.json): the front matter only at the very top (a
 * byte-order mark before it passed over), the key in any case with or without spaces before the colon, quotes and
 * a trailing `# comment` dropped, and a value that is none of the known words counts as private - kept out rather
 * than let in by a word nobody here understood.
 */
export function frontAccess(text) {
  const t = String(text || "").replace(/^\uFEFF/, "");
  const head = /^---\r?\n/.exec(t);
  if (!head) return null;
  for (const line of t.slice(head[0].length).split(/\r?\n/)) {
    const l = line.trim();
    if (l === "---" || l === "...") break;
    const key = /^ai\s*:/i.exec(l);
    if (!key) continue;
    const v = l.slice(key[0].length).replace(/(^|\s)#.*$/, "").trim().replace(/^["']+|["']+$/g, "").trim().toLowerCase();
    if (!v) return null;
    return Object.hasOwn(ACCESS_WORDS, v) ? ACCESS_WORDS[v] : "private";
  }
  return null;
}

const SHORT_NAME = /^[^.]{1,6}~\d{1,6}(\.[^.]{1,3})?$/;
/** Spelled like a Windows short name (PRIVAT~1, KEYS~1.MD) and nothing in the vault has that name: it may be another name for any file. */
function shortSpelled(path, vault) {
  const parts = String(path).split("/");
  return parts.some((seg, i) => {
    if (!SHORT_NAME.test(seg)) return false;
    const at = parts.slice(0, i + 1).join("/").toLowerCase();
    return ![...vault.notes.keys(), ...(vault.files ? vault.files.keys() : []), ...(vault.folders || [])].some((p) => { const l = p.toLowerCase(); return l === at || l.startsWith(at + "/"); });
  });
}

/** A note by its path, however the case is spelled: on Windows that is the same file. */
export function noteIn(notes, path) {
  const n = notes.get(path);
  if (n) return n;
  const low = String(path).toLowerCase();
  for (const [p, x] of notes) if (p.toLowerCase() === low) return x;
  return undefined;
}

/** Folder paths after `from` became `to`: that folder and those inside it follow, whatever the case. */
export function movedFolders(list, from, to) {
  const low = from.toLowerCase();
  return list.map((f) => { const l = String(f).toLowerCase().replace(/\/+$/, ""); return l === low || l.startsWith(low + "/") ? to + String(f).replace(/\/+$/, "").slice(from.length) : f; });
}

const isVideo = (path) => /\.leovideo$/i.test(path);

/**
 * Accept every proposal whose note did not change since the agent read it. Asked again for each: accepting one
 * changes the note under the next one on it, and that one then waits for a review. Returns how many failed.
 */
export async function acceptUnchanged(app, tell) {
  await app.flushAll();
  let failed = 0;
  for (const { id } of await app.host.proposalsList()) {
    const p = (await app.host.proposalsList()).find((x) => x.id === id);
    if (!p || p.changed) continue;
    try { await app.host.proposalAccept(p.id); tell(p.path, p.content); } catch { failed++; }
  }
  return failed;
}

export function mountProposals(app) {
  const chip = h("button", { class: "sb-proposals", hidden: true, title: "Agents' edits waiting for you - click to review", onclick: () => review() }, icon("sparkles"), h("span", { class: "sb-pn" }), h("span", { class: "sb-pt" }));
  let count = 0;
  let lastSeen = 0;
  // quiet: a proposal made here, already told about by whoever made it
  async function poll({ quiet = false } = {}) {
    let n = 0;
    try { n = await app.host.proposalsCount(); } catch { return; }
    if (n !== count) {
      const more = n > count;
      count = n;
      chip.hidden = !n;
      // the compact window shows the sparkle and the number only
      chip.querySelector(".sb-pn").textContent = String(n);
      chip.lastChild.textContent = n === 1 ? "proposed edit" : "proposed edits";
      chip.title = `${n} ${chip.lastChild.textContent} from agents - click to review`;
      if (more && !quiet && n > lastSeen && app.settings.agentToasts !== false) app.toast(`An agent proposes ${n === 1 ? "a change" : "changes"} to your notes`, { ms: 6000, action: { label: "Review", run: review } });
      lastSeen = n;
      app.bus.emit("proposals", n);
    }
  }
  poll();
  // a proposal written or settled anywhere (the MCP process, another window): the file watcher says so -
  // nothing is asked while nothing happens
  app.host.on("proposals:changed", () => poll());

  /* ── the review ── */
  let open = null;
  async function review() {
    if (open) return open.paint();
    // a review needs room: the compact window opens out to the full one first
    if (app.settings.compact && app.leaveCompact) await app.leaveCompact();
    const list = h("div", { class: "pr-list" });
    const view = h("div", { class: "pr-view" });
    const back = h("div", { class: "dlg-back" });
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); open = null; };
    const onKey = (e) => { if (e.key === "Escape" && !e.target.closest("input, textarea")) { e.preventDefault(); e.stopPropagation(); close(); } };
    let items = [];
    let at = 0;
    // the app wrote it, so the file watcher keeps quiet about it: the open note learns here (a video project is no note)
    const tell = (path, content) => { if (!isVideo(path)) app.vault.external([{ path, content, mtime: Date.now() }]); };
    async function decide(p, accept) {
      try {
        // written since and no record of what the agent saw: accepting replaces it all - asked first
        if (accept && p.changed && p.now != null && p.base_text == null && !(await import("./ui.js").then((m) => m.confirmDialog("You changed this note since", `This proposal is from before Leonote kept what the agent saw, so it cannot be fitted around your changes: accepting puts the agent's whole text in place of yours. The toast after has Undo.`, { ok: "Accept anyway", danger: true })))) return;
        if (accept) {
          // the note as it is now, the last typing saved first: what this shows may be older
          await app.flushAll();
          const fresh = (await app.host.proposalsList()).find((x) => x.id === p.id);
          if (fresh && fresh.now !== p.now) { app.toast("This note just changed - look at the change again", { ms: 4000 }); await paint(); return; }
          const text = resultOf(p);
          const was = p.now;
          await app.host.proposalAccept(p.id, text === p.content ? null : text);
          tell(p.path, text);
          app.toast(`Accepted · ${basename(p.path)}`, { ms: 8000, action: was == null ? null : { label: "Undo", run: async () => { if (isVideo(p.path)) await app.host.writeFile(p.path, new TextEncoder().encode(was)); else await app.vault.write(p.path, was); tell(p.path, was); app.toast("Put back as it was", { ms: 2000 }); } } });
        }
        else { await app.host.proposalReject(p.id); app.toast(`Rejected · ${p.path}`, { ms: 2200 }); }
      } catch (e) { app.toast(String(e), { kind: "error", ms: 5000 }); }
      await poll();
      paint();
    }
    async function paint() {
      try { items = await app.host.proposalsList(); } catch (e) { items = []; }
      if (!items.length) { close(); app.toast("No edits waiting", { ms: 1800 }); return; }
      at = Math.min(at, items.length - 1);
      list.replaceChildren(...items.map((p, i) => h("button", { class: "pr-item" + (i === at ? " is-on" : ""), onclick: () => { at = i; paint(); } },
        h("div", { class: "pr-item-name", text: basename(p.path) }),
        h("div", { class: "pr-item-sub", text: `${p.agent} · ${p.kind === "append" ? "adds" : p.now == null ? "new note" : "rewrites"} · ${p.at.slice(5, 16).replace("T", " ")}` }))));
      const p = items[at];
      const merged = p.changed && p.now != null && p.base_text != null;
      const rows = diffRows(lineDiff(p.now ?? "", resultOf(p)));
      const added = rows.filter((r) => r.op === "+").length, removed = rows.filter((r) => r.op === "-").length;
      // a video project's edit reads as what it does - the cuts, the captions - not as its JSON
      const video = isVideo(p.path);
      const diff = h("pre", { class: "pr-diff" }, ...rows.map((r) => h("div", { class: "pr-line is-" + ({ "=": "same", "+": "add", "-": "del", "…": "fold" })[r.op] }, h("span", { class: "pr-op", text: r.op === "=" ? " " : r.op === "…" ? "" : r.op }), h("span", { text: r.t || " " }))));
      view.replaceChildren(...[
        h("div", { class: "pr-head" },
          h("div", {}, h("div", { class: "pr-path", text: p.path }), h("div", { class: "pr-meta", text: `${p.agent} · +${added} −${removed}${p.why && !video ? " · " + p.why : ""}` })),
          h("span", { class: "fit-fill" }),
          p.now != null ? h("button", { class: "btn", onclick: () => { close(); app.openNote(p.path, { newTab: true }); } }, video ? "Open the video" : "Open the note") : null,
          h("button", { class: "btn", onclick: () => decide(p, false) }, icon("x"), "Reject"),
          h("button", { class: "btn btn-primary", onclick: () => decide(p, true) }, icon("check"), "Accept")),
        p.changed ? h("div", { class: "pr-warn" + (merged ? " is-fine" : ""), text: p.now == null ? "The note is gone since the agent wrote this - accepting makes it again."
          : merged ? "You wrote more in this note since the agent read it. What you wrote stays - this shows only what the agent's change does to the note as it is now."
          : "You changed this note since the agent read it, and this proposal is older than Leonote's way of fitting it around your changes: accepting replaces the whole note (red lines go)." }) : null,
        video ? h("div", { class: "pr-video" },
          h("ul", {}, ...String(p.why || "").split("\n").filter(Boolean).map((l) => h("li", { class: l.startsWith("To look at") ? "is-warn" : "", text: l }))),
          h("p", { class: "pr-meta", text: "Accept, then play it in the video editor - Ctrl+Z there puts it back as it was." }),
          h("details", {}, h("summary", { text: "The project's text" }), diff)) : diff].filter(Boolean));
    }
    back.append(h("div", { class: "dlg pr-dlg" },
      h("div", { class: "pr-top" }, h("h3", { class: "dlg-title" }, icon("sparkles"), " Proposed edits"),
        h("span", { class: "pr-meta", text: "Agents asked to change these notes. Nothing changes until you accept." }),
        h("span", { class: "fit-fill" }),
        h("button", { class: "btn", title: "Every one whose note did not change since the agent read it", onclick: async () => { try { const failed = await acceptUnchanged(app, tell); if (failed) app.toast(`${failed} could not be accepted and still wait`, { kind: "error", ms: 5000 }); } catch (e) { app.toast(String(e), { kind: "error", ms: 5000 }); } await poll(); paint(); } }, "Accept all unchanged"),
        h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
      h("div", { class: "pr-body" }, list, view)));
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    open = { paint };
    await app.flushAll().catch(() => {}); // what was just typed is in the note the review compares with
    await paint();
    requestAnimationFrame(() => back.classList.add("is-in"));
  }

  /* ── AI access ── */
  let rules = { default: "review", folders: {} };
  let reread = null;
  const loadRules = () => app.host.aiAccessGet().then((r) => {
    const was = rules.unreadable === true;
    rules = r || rules;
    clearTimeout(reread);
    // locked for a moment or damaged: agents are kept out only until the file reads again, so it is looked at again, only while it does not read
    if (rules.unreadable === true) reread = setTimeout(loadRules, 5000);
    if (!was || rules.unreadable !== true) app.bus.emit("aiaccess", rules);
  }).catch(() => {});
  const ready = loadRules();
  // a folder renamed or moved: the app moved its AI access with it, and what is left out of the index goes along here
  app.vault.bus.on("folderRenamed", ({ from, to }) => {
    loadRules();
    const list = Array.isArray(app.settings.noIndex) ? app.settings.noIndex : [];
    const next = movedFolders(list, from, to);
    if (next.some((f, i) => f !== list[i])) { app.setSetting("noIndex", next); app.host.noIndexSet(next).catch(() => {}); }
  });
  const MODES = [["private", "Private", "Agents don't see it - not listed, searched, read or written"], ["review", "Review", "Agents may read it; their changes wait for you to accept"], ["open", "Open", "Agents read and write it straight away (the old text kept)"]];
  /** A folder's own setting, or null when it takes its parent's. */
  const own = (folder) => (rules.folders || {})[folder] || null;
  function accessOf(folder, plugin = false) {
    // full access: every folder open to AI (a note's own ai: line still counts - noteAccess reads it first). Not to a
    // plugin: that is someone else's code, and full access was given to the user's AI
    if (rules.full === true && !plugin) return "open";
    let best = null, len = -1;
    // Windows names are not case-sensitive: "private/x" is in the folder "Private"
    const low = String(folder || "").toLowerCase();
    for (const [f, m] of Object.entries(rules.folders || {})) { const fl = f.toLowerCase(); if ((low === fl || low.startsWith(fl + "/")) && f.length > len) { best = m; len = f.length; } }
    return best || rules.default || "review";
  }
  /** A note's own `ai:` line in its front matter, else its folder's. */
  function noteAccess(path, content, plugin = false) {
    if (content === undefined) {
      const n = noteIn(app.vault.notes, path);
      // ponytail: judged by spelling, so a new note really named x~1.md is kept out too; asking the disk means an async check in every caller
      if (!n && shortSpelled(path, app.vault)) return "private";
      // a note too big to hold (over 64 MB, listed as a file): its own ai: line is unknown, so it is kept out
      if (!n && /\.(md|txt)$/i.test(path) && app.vault.files && app.vault.files.has(path)) return "private";
      // a note not in memory, in a folder left out of the index: what it says at its top is unknown, so it is kept out, as over MCP
      const low = String(path).toLowerCase();
      if (!n && Array.isArray(app.settings.noIndex) && app.settings.noIndex.some((f) => low.startsWith(String(f).toLowerCase().replace(/\/+$/, "") + "/"))) return "private";
      content = n && n.content;
    }
    return frontAccess(content) || accessOf(dirname(path), plugin);
  }
  /** A write on an AI's behalf: private refused, review proposed, open written. */
  async function writeFor(path, content, kind, agent, why, { review = false, plugin = false } = {}) {
    // the same file under another spelling: its text was built from nothing, so it would be lost
    const real = noteIn(app.vault.notes, path);
    if (real && real.path !== path) throw new Error(`The note is named ${real.path} - use that name`);
    const acc = noteAccess(path, undefined, plugin);
    if (acc === "private") return "private";
    if (acc === "review" || review) { await app.host.proposalMake(path, content, kind, agent, why); poll({ quiet: true }); return "proposed"; }
    // not UTF-8: its letters are not in `content` (the review path above is refused by the host), and this would replace them
    const bad = notUtf8(real, path);
    if (bad) throw new Error(bad);
    // the line outlasts the access that wrote it, and it outranks the folder: only the user sets it (in review they see it)
    if (frontAccess(content) !== frontAccess(real && real.content)) throw new Error("The ai: line is the user's - change the note without it");
    await app.vault.write(path, content, {});
    return "written";
  }
  /** The user's tasks kept apart from AI's: agents see and change only tasks with owner "ai". */
  const tasksSplit = () => rules.tasks === "split" || rules.unreadable === true;
  /** Full access: AI may read and change every note at once, except one that says ai: private itself. */
  const full = () => rules.full === true;
  async function setFull(on) {
    try { rules = await app.host.aiFullSet(on); app.bus.emit("aiaccess", rules); app.toast(on ? "AI has full access to the vault - a note with ai: private at its top is still kept out" : "AI access follows your folders again", { ms: 3200 }); }
    catch (e) { app.toast("Could not change it: " + e, { kind: "error" }); }
  }
  async function setTasksSplit(on) {
    try { rules = await app.host.aiTasksSet(on); app.bus.emit("aiaccess", rules); app.toast(on ? "Your tasks are yours - AI sees only the tasks you give it" : "AI sees every task again", { ms: 2600 }); }
    catch (e) { app.toast("Could not change it: " + e, { kind: "error" }); }
  }
  async function set(folder, mode) {
    try { rules = await app.host.aiAccessSet(folder || null, mode); app.bus.emit("aiaccess", rules); app.toast(folder ? `${folder}: ${mode ? MODES.find((m) => m[0] === mode)[1] : "as its parent"} for agents` : `Agents: ${MODES.find((m) => m[0] === mode)[1]} by default`, { ms: 2200 }); }
    catch (e) { app.toast(String(e), { kind: "error" }); }
  }
  /** Menu rows for a folder of the tree (or the vault, `folder` ""). */
  function menuFor(folder) {
    const mine = folder ? own(folder) : rules.default || "review";
    const now = accessOf(folder);
    return {
      label: `For AI agents: ${MODES.find((m) => m[0] === now)[1]}`, icon: now === "private" ? "lock" : "sparkles", sub: [
        { header: folder ? "This folder and what is in it" : "Every note, unless its folder says" },
        ...MODES.map(([id, name, hint]) => ({ label: name, tail: h("span", { class: "menu-hint", text: hint }), checked: mine === id, run: () => set(folder, id) })),
        folder && mine ? { label: `As its parent (${MODES.find((m) => m[0] === accessOf(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : ""))[1]})`, icon: "undo", run: () => set(folder, null) } : null,
        "sep",
        { header: "A note can say for itself, at its top: ai: private", plain: true },
      ].filter(Boolean),
    };
  }

  return { ready, chip, review, poll, menuFor, accessOf, noteAccess, writeFor, tasksSplit, setTasksSplit, full, setFull, own, rules: () => rules, setAccess: set };
}
