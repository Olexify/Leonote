// A folder worked on as a project: find in it, replace across it, go to any
// file, and git - each Space can have its own. The folder is an outpost (or
// the vault); src-tauri/src/project.rs does the reading, the writing (with a
// copy of every changed file kept for Undo) and runs the user's own git.

import { h, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast, confirmDialog } from "./ui.js";
import { outpostList, addOutpost } from "./outposts.js";

const SEP = String.fromCharCode(92);
const nameOf = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const absOf = (root, rel) => root.replace(/[\\/]+$/, "") + SEP + rel.split("/").join(SEP);

/** "## main...origin/main [ahead 1]" + " M file" lines -> { branch, ahead, behind, files: [{ code, path }] } */
export function parseStatus(out) {
  const lines = String(out || "").split("\n").filter(Boolean);
  const head = lines[0] && lines[0].startsWith("## ") ? lines.shift().slice(3) : "";
  const m = /^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head) || [];
  const track = m[3] || "";
  return {
    branch: m[1] || "",
    upstream: m[2] || "",
    ahead: +(/ahead (\d+)/.exec(track) || [0, 0])[1],
    behind: +(/behind (\d+)/.exec(track) || [0, 0])[1],
    files: lines.map((l) => { const path = l.slice(3); const to = path.includes(" -> ") ? path.split(" -> ").pop() : path; return { code: l.slice(0, 2), path: to.replace(/^"|"$/g, "") }; }),
  };
}
const CODE_WORD = (c) => (c.includes("?") ? "new" : c.includes("A") ? "added" : c.includes("D") ? "deleted" : c.includes("R") ? "renamed" : c.includes("U") ? "conflict" : "changed");

export function mountProject(app, el) {
  const S = app.settings;
  const rootNow = () => { const m = S.spaceProjects || {}; return m[app.currentSpaceId()] || ""; };
  const setRoot = (path) => { app.setSetting("spaceProjects", { ...(S.spaceProjects || {}), [app.currentSpaceId()]: path }); info = null; draw(); };
  // what is set for THIS project, by its folder: settings.projectSettings[path]
  const conf = () => ((S.projectSettings || {})[rootNow()]) || {};
  const setConf = (k, v) => { const all = { ...(S.projectSettings || {}) }; const c = { ...(all[rootNow()] || {}) }; if (v === "" || v == null || v === false) delete c[k]; else c[k] = v; all[rootNow()] = c; app.setSetting("projectSettings", all); };
  const excludeList = () => String(conf().exclude || "").split(",").map((x) => x.trim()).filter(Boolean);
  let tab = "find";
  let info = null; // { repo, files }
  let q = "";
  let withText = "";
  let opts = { case: false, word: false };
  let only = "";
  let found = null;
  let busy = false;
  let fileList = null;
  let fileQ = "";
  let git = null; // parsed status
  let gitOut = "";
  let diffOf = "";
  let diffText = "";

  const open = (rel, line) => {
    const root = rootNow();
    const vaultAbs = (app.vault.root || "").replace(/[\\/]+$/, "");
    const abs = absOf(root, rel);
    // a file of the vault opens as what it is there
    if (vaultAbs && abs.toLowerCase().startsWith(vaultAbs.toLowerCase() + SEP)) {
      const v = abs.slice(vaultAbs.length + 1).split(SEP).join("/");
      if (app.vault.notes.has(v)) return app.openNote(v, { newTab: true, line });
      if (app.vault.files.has(v)) return app.openFile(v, { newTab: true, line });
    }
    app.openExternal(abs, { newTab: true, line });
  };

  function chooser(at) {
    const r = at.getBoundingClientRect();
    const cur = rootNow();
    menu(r.left, r.bottom + 4, [
      { header: "This space's project" },
      ...outpostList(app).map((o) => ({ label: o.name || nameOf(o.path), icon: "folder", checked: cur === o.path, run: () => setRoot(o.path) })),
      app.vault.root ? { label: "The vault itself", icon: "home", checked: cur === app.vault.root, run: () => setRoot(app.vault.root) } : null,
      "sep",
      { label: "Hook up a project folder…", icon: "folderPlus", run: async () => { const res = await addOutpost(app); if (res && res.path) setRoot(res.path); } },
      cur ? { label: "No project in this space", icon: "x", run: () => setRoot("") } : null,
    ]);
  }

  /* ── find and replace ─────────────────────────────────────────────────── */
  const runSearch = debounce(async () => {
    const root = rootNow();
    if (!root || q.trim().length < 2) { found = null; return draw(); }
    busy = true; paintBusy();
    const asked = q;
    try { const r = await app.host.projectSearch(root, q, { ...opts, exclude: excludeList() }, only); if (asked === q) found = r; }
    catch (e) { found = { hits: [], total: 0, files: 0, error: String(e) }; }
    busy = false;
    draw();
  }, 260);
  const paintBusy = () => { const s = el.querySelector(".pj-sum"); if (s && busy) s.textContent = "Searching…"; };

  async function replaceAll() {
    const root = rootNow();
    if (!found || !found.hits.length) return;
    const paths = [...new Set(found.hits.map((x) => x.path))];
    if (!(await confirmDialog(`Replace ${found.total} match${found.total === 1 ? "" : "es"} in ${paths.length} file${paths.length === 1 ? "" : "s"}?`,
      `“${q}” becomes “${withText}” on disk. A copy of every changed file is kept, and Undo puts them back.${found.partial ? " Only the matches listed are in these files - the search stopped early." : ""}`, { ok: "Replace", danger: false }))) return;
    try {
      const r = await app.host.projectReplace(root, q, withText, { ...opts, exclude: excludeList() }, paths);
      toast(`Replaced ${r.count} in ${r.files.length} file${r.files.length === 1 ? "" : "s"}`, { ms: 12000, action: { label: "Undo", run: async () => {
        try { const n = await app.host.projectUndo(root, r.stamp); toast(`${n} file${n === 1 ? "" : "s"} put back`); runSearch(); } catch (e) { toast(String(e), { kind: "error" }); }
      } } });
      runSearch();
    } catch (e) { toast("Replace failed: " + e, { kind: "error", ms: 7000 }); }
  }

  function findPane() {
    const input = h("input", { class: "pj-q", value: q, placeholder: "Find in project", spellcheck: false, oninput: (e) => { q = e.target.value; runSearch(); } });
    const rep = h("input", { class: "pj-q", value: withText, placeholder: "Replace with", spellcheck: false, oninput: (e) => { withText = e.target.value; } });
    const dir = h("input", { class: "pj-q is-dir", value: only, placeholder: "only in folder (src/ui)", spellcheck: false, oninput: (e) => { only = e.target.value.trim().replace(/^\/+|\/+$/g, ""); runSearch(); } });
    for (const i of [input, rep, dir]) i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && i === input) runSearch(); });
    const tog = (key, label, title) => h("button", { class: "pj-tog" + (opts[key] ? " is-on" : ""), title, onclick: () => { opts = { ...opts, [key]: !opts[key] }; draw(); runSearch(); } }, label);
    const groups = new Map();
    for (const x of found ? found.hits : []) { if (!groups.has(x.path)) groups.set(x.path, []); groups.get(x.path).push(x); }
    const chars = (s) => [...s];
    const hit = (x) => {
      const c = chars(x.text);
      return h("button", { class: "pj-hit", onclick: () => open(x.path, x.line) },
        h("span", { class: "pj-ln", text: String(x.line) }),
        h("span", { class: "pj-text" }, c.slice(0, x.from).join(""), h("mark", { text: c.slice(x.from, x.to).join("") }), c.slice(x.to).join("")),
        x.more ? h("span", { class: "pj-more", text: "+" + x.more }) : null);
    };
    return h("div", { class: "pj-pane" },
      h("div", { class: "pj-row" }, icon("search"), input, tog("case", "Aa", "Match case"), tog("word", "W", "Whole words")),
      h("div", { class: "pj-row" }, icon("edit"), rep, dir, h("button", { class: "btn btn-sm", disabled: !found || !found.hits.length, onclick: replaceAll }, "Replace all")),
      h("div", { class: "pj-sum", text: !found ? (q.trim().length < 2 ? "Type two letters or more" : "") : found.error ? found.error
        : `${found.total} match${found.total === 1 ? "" : "es"} in ${found.files} file${found.files === 1 ? "" : "s"} · ${found.scanned} files looked through · ${found.ms} ms${found.partial ? " · stopped early, narrow it down" : ""}` }),
      h("div", { class: "pj-list" }, ...[...groups].map(([path, list]) => h("div", { class: "pj-file" },
        h("button", { class: "pj-file-head", onclick: () => open(path, list[0].line) }, icon("file"), h("span", { class: "pj-file-name", text: path.slice(path.lastIndexOf("/") + 1) }), h("span", { class: "pj-file-dir", text: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" }), h("span", { class: "pj-count", text: String(list.length) })),
        ...list.map(hit)))));
  }

  /* ── go to file ───────────────────────────────────────────────────────── */
  function filesPane() {
    if (!fileList) { app.host.projectFiles(rootNow(), excludeList()).then((l) => { fileList = l; if (tab === "files") draw(); }).catch((e) => { fileList = []; toast(String(e), { kind: "error" }); }); }
    const words = fileQ.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = (fileList || []).filter((p) => { const l = p.toLowerCase(); return words.every((w) => l.includes(w)); }).slice(0, 400);
    const input = h("input", { class: "pj-q", value: fileQ, placeholder: "Go to file - words of its name or path", spellcheck: false, oninput: (e) => { fileQ = e.target.value; draw(); } });
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && shown[0]) open(shown[0]); });
    return h("div", { class: "pj-pane" },
      h("div", { class: "pj-row" }, icon("file"), input),
      h("div", { class: "pj-sum", text: fileList ? `${shown.length}${shown.length === 400 ? "+" : ""} of ${fileList.length} files` : "Reading…" }),
      h("div", { class: "pj-list" }, ...shown.map((p) => h("button", { class: "pj-hit", onclick: () => open(p) }, icon("file"), h("span", { class: "pj-file-name", text: p.slice(p.lastIndexOf("/") + 1) }), h("span", { class: "pj-file-dir", text: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "" })))));
  }

  /* ── git ──────────────────────────────────────────────────────────────── */
  const gitRun = async (action, arg, { quiet = false } = {}) => {
    try {
      const r = await app.host.projectGit(rootNow(), action, arg);
      if (!quiet) gitOut = ((r.out || "") + (r.err ? (r.out ? "\n" : "") + r.err : "")).trim() || (r.ok ? "Done." : `git ${action} failed (${r.code})`);
      return r;
    } catch (e) { gitOut = String(e); return { ok: false, out: "", err: String(e) }; }
  };
  async function loadGit() {
    const r = await gitRun("status", null, { quiet: true });
    git = r.ok ? parseStatus(r.out) : { error: (r.err || "").trim() || "Not a git repository" };
    if (tab === "git") draw();
  }
  async function act(action, arg) {
    gitOut = `git ${action}…`; draw();
    // this project's way: bring the branch up to date before pushing
    if (action === "push" && conf().pullFirst) { const r = await gitRun("pull"); if (!r.ok) return loadGit(); }
    await gitRun(action, arg);
    await loadGit();
  }
  function gitPane() {
    if (!git) { loadGit(); return h("div", { class: "pj-pane" }, h("div", { class: "pj-sum", text: "Asking git…" })); }
    if (git.error) return h("div", { class: "pj-pane" }, h("div", { class: "pj-empty" }, icon("code"), h("div", { text: info && !info.repo ? "This folder is not a git repository yet." : git.error }),
      info && !info.repo ? h("button", { class: "btn", onclick: () => act("init") }, "git init") : h("button", { class: "btn", onclick: loadGit }, "Try again")));
    const msg = h("textarea", { class: "pj-msg", placeholder: "Commit message", rows: 2, spellcheck: true });
    if (conf().commitStart) msg.value = conf().commitStart;
    msg.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } });
    const commit = () => { const m = msg.value.trim(); if (!m) return toast("A commit needs a message"); act("commit", m); };
    const branchMenu = async (at) => {
      const r = await app.host.projectGit(rootNow(), "branches").catch(() => null);
      const list = r && r.ok ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      const b = at.getBoundingClientRect();
      menu(b.left, b.bottom + 4, [
        { header: "Branches" },
        ...list.map((n) => ({ label: n, checked: n === git.branch, run: () => act("switch", n) })),
        "sep",
        { label: "New branch…", icon: "plus", run: () => { const n = prompt("Name of the new branch"); if (n && n.trim()) act("branch-new", n.trim()); } },
      ]);
    };
    const showDiff = async (path) => { diffOf = path; diffText = "…"; draw(); const r = await app.host.projectGit(rootNow(), "diff", path).catch((e) => ({ out: String(e) })); diffText = (r.out || "").trim() || "No diff to show - a new or binary file."; draw(); };
    const diffLines = diffText.split("\n").slice(0, 1500).map((l) => h("div", { class: "pj-dl" + (l.startsWith("+") && !l.startsWith("+++") ? " is-add" : l.startsWith("-") && !l.startsWith("---") ? " is-del" : l.startsWith("@@") ? " is-at" : ""), text: l || " " }));
    return h("div", { class: "pj-pane" },
      h("div", { class: "pj-row" },
        h("button", { class: "btn btn-sm", title: "Switch branch", onclick: (e) => branchMenu(e.currentTarget) }, icon("code"), git.branch || "(no branch)"),
        h("span", { class: "pj-track", text: [git.upstream, git.ahead ? `↑${git.ahead}` : "", git.behind ? `↓${git.behind}` : ""].filter(Boolean).join(" ") }),
        h("span", { class: "pj-gap" }),
        h("button", { class: "btn btn-sm", onclick: () => act("fetch") }, "Fetch"),
        h("button", { class: "btn btn-sm", title: "git pull --ff-only", onclick: () => act("pull") }, "Pull"),
        h("button", { class: "btn btn-sm btn-primary", onclick: () => act("push") }, "Push"),
        h("button", { class: "icon-btn", title: "Refresh", onclick: () => { git = null; draw(); } }, icon("rotateRight"))),
      h("div", { class: "pj-git" },
        h("div", { class: "pj-changes" },
          h("div", { class: "pj-sum", text: git.files.length ? `${git.files.length} changed file${git.files.length === 1 ? "" : "s"}` : "Nothing to commit - the working tree is clean" }),
          h("div", { class: "pj-list" }, ...git.files.map((f) => h("button", { class: "pj-hit" + (diffOf === f.path ? " is-on" : ""), title: "Show the diff · double-click opens the file", onclick: () => showDiff(f.path), ondblclick: () => open(f.path) },
            h("span", { class: "pj-code is-" + CODE_WORD(f.code), text: CODE_WORD(f.code) }), h("span", { class: "pj-file-name", text: f.path.slice(f.path.lastIndexOf("/") + 1) }), h("span", { class: "pj-file-dir", text: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "" })))),
          git.files.length ? h("div", { class: "pj-commit" }, msg, h("button", { class: "btn btn-primary", title: "Stage everything and commit (Ctrl+Enter)", onclick: commit }, "Commit all")) : null,
          gitOut ? h("pre", { class: "pj-out", text: gitOut }) : null),
        h("div", { class: "pj-diff" }, diffOf ? h("div", { class: "pj-diff-head", text: diffOf }) : h("div", { class: "pj-sum", text: "Pick a file to see what changed" }), ...(diffOf ? diffLines : []))));
  }

  /* ── this project's settings ──────────────────────────────────────────── */
  function settingsPane() {
    const field = (key, placeholder) => { const i = h("input", { class: "pj-q", value: conf()[key] || "", placeholder, spellcheck: false, onchange: (e) => { setConf(key, e.target.value.trim()); fileList = null; } }); i.addEventListener("keydown", (e) => e.stopPropagation()); return i; };
    const check = (key, label) => h("label", { class: "pj-check" }, h("input", { type: "checkbox", checked: !!conf()[key], onchange: (e) => setConf(key, e.target.checked) }), label);
    const pick = (key, options, dflt) => h("div", { class: "segmented is-small" }, options.map(([v, label]) => h("button", { class: "seg" + ((conf()[key] || dflt) === v ? " is-active" : ""), onclick: () => { setConf(key, v === dflt ? "" : v); draw(); } }, label)));
    const row = (label, hint, control) => h("div", { class: "pj-set" }, h("div", { class: "pj-set-text" }, h("div", { text: label }), h("div", { class: "pj-set-hint", text: hint })), control);
    return h("div", { class: "pj-pane pj-settings" },
      h("div", { class: "pj-sum", text: rootNow() }),
      row("Leave out of find, replace and go to file", "Folder or file names, paths from the root, endings - separated by commas: dist, docs/old, *.min.js. What .gitignore leaves out is left out already.", field("exclude", "dist, docs/old, *.min.js")),
      row("Opening the Project view starts on", "What you reach for first in this project", pick("startTab", [["find", "Find"], ["files", "Go to file"], ["git", "Git"]], "find")),
      row("Commit messages start with", "A ticket number, a prefix like “feat: ” - put in the box for you", field("commitStart", "feat: ")),
      row("Git", "", h("div", { class: "pj-checks" }, check("pullFirst", "Pull (fast-forward only) before every push"))),
      h("div", { class: "pj-row" }, h("button", { class: "btn btn-sm", onclick: () => { const all = { ...(S.projectSettings || {}) }; delete all[rootNow()]; app.setSetting("projectSettings", all); fileList = null; draw(); } }, "Reset this project's settings")));
  }

  /* ── the view ─────────────────────────────────────────────────────────── */
  // a redraw replaces the fields: whoever was typing keeps the keys and the caret
  function draw() {
    const fields = [...el.querySelectorAll("input, textarea")];
    const at = fields.indexOf(document.activeElement);
    const sel = at >= 0 ? [fields[at].selectionStart, fields[at].selectionEnd, fields[at].value] : null;
    paint();
    const now = [...el.querySelectorAll("input, textarea")];
    if (at >= 0 && now[at]) { now[at].focus(); if (now[at].tagName === "TEXTAREA") now[at].value = sel[2]; try { now[at].setSelectionRange(sel[0], sel[1]); } catch {} }
    else if (!el.hidden && now[0] && (document.activeElement === document.body || !document.activeElement)) now[0].focus();
  }
  function paint() {
    const root = rootNow();
    if (!root) {
      el.replaceChildren(h("div", { class: "pj-empty" }, icon("code"),
        h("h2", { text: "A project for this space" }),
        h("p", { text: "Pick a folder - a code project, a book, a site. This space then finds and replaces across that folder only, jumps to any of its files, and commits and pushes with your own git. Each space can have its own project." }),
        h("button", { class: "btn btn-primary", onclick: (e) => chooser(e.currentTarget) }, icon("folder"), "Choose the project…")));
      return;
    }
    if (!info) { info = {}; app.host.projectInfo(root).then((i) => { info = i; draw(); }).catch((e) => { info = { error: String(e) }; draw(); }); }
    const tabs = [["find", "Find and replace", "search"], ["files", "Go to file", "file"], ["git", "Git", "code"]];
    el.replaceChildren(
      h("div", { class: "pj-head" },
        h("button", { class: "pj-name", title: root, onclick: (e) => chooser(e.currentTarget) }, icon("folder"), h("span", { text: nameOf(root) }), icon("chevronDown")),
        h("span", { class: "pj-info", text: info.error ? info.error : info.files != null ? `${info.files} text files${info.repo ? " · git" : ""}` : "" }),
        h("div", { class: "segmented is-small" }, tabs.map(([id, label, ic]) => h("button", { class: "seg" + (tab === id ? " is-active" : ""), onclick: () => { tab = id; if (id === "git") git = null; draw(); } }, icon(ic), label))),
        h("button", { class: "icon-btn" + (tab === "settings" ? " is-on" : ""), title: "This project's settings", onclick: () => { tab = tab === "settings" ? (conf().startTab || "find") : "settings"; draw(); } }, icon("settings"))),
      tab === "settings" ? settingsPane() : tab === "find" ? findPane() : tab === "files" ? filesPane() : gitPane());
  }

  let lastSpace = null;
  return {
    show(opts2 = {}) {
      if (opts2.settings) tab = "settings";
      else if (opts2.tab) tab = opts2.tab;
      else if (lastSpace !== app.currentSpaceId() && conf().startTab) tab = conf().startTab;
      if (opts2.query != null) { q = opts2.query; runSearch(); }
      // another space, another project: nothing of the last one stays on screen
      if (lastSpace !== app.currentSpaceId()) { lastSpace = app.currentSpaceId(); info = null; found = null; fileList = null; git = null; diffOf = ""; gitOut = ""; }
      else if (tab === "git") git = null;
      draw();
    },
    root: rootNow,
  };
}
