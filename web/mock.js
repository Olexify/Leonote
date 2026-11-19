import { fuzzy } from "./search.js";

// In-browser stand-in for the Rust backend, for design work and UI tests
// without Tauri. Never loaded inside the app.
//
//   window.mock.agentTicks()   simulate an agent completing a task
//   window.mock.agentEdits()   simulate an agent editing the open note

const today = new Date();
const key = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const stamp = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
const ago = (h) => Date.now() - h * 3600000;

const NOTES = {
  "Welcome.md": `# Welcome to Leonote

Your notes are plain Markdown files in a folder you own. Everything is instant: there is nothing to wait for.

## The essentials
- [[Getting around]] - the keyboard is the fast path
- Link notes with double brackets, like [[Projects/Leonote roadmap]]
- Tag anything with #ideas or #work/planning
- [x] Open Leonote
- [ ] Press **Ctrl+O** and jump to a note
- [ ] Press **Ctrl+P** to see every command

> [!note] AI agents welcome
> Agents can edit these files and append task changes to \`~/.leonote/log\`. You'll see their edits appear live.

---

Built for *speed*, ~~bloat~~ removed.
`,
  "Getting around.md": `# Getting around

| Keys | Does |
| --- | --- |
| Ctrl O | Quick switcher |
| Ctrl P | Commands |
| Ctrl Shift F | Search all notes |
| Alt D | Today's note |

Type \`/\` at the start of a line for blocks. Type \`[[\` to link a note.

\`\`\`js
const fast = true;
\`\`\`

Back to [[Welcome]].
`,
  "Projects/Leonote roadmap.md": `# Leonote roadmap #work/planning

## Now
- [x] Rust store with append-only logs
- [x] Live preview editor
- [ ] Frosted translucent theme
- [ ] Kanban board with git history

## Later
- Sync via git
- Mobile companion

Related: [[Ideas/Agent swarm]], [[Missing note]]
`,
  "Ideas/Agent swarm.md": `# Agent swarm

Several agents work at once. Each agent appends to its own log, so a torn write can only damage its own tail. #ideas #ai

See [[Projects/Leonote roadmap]].
`,
  "Ideas/Reading list.md": `# Reading list #ideas

1. Designing Data-Intensive Applications
2. The Pragmatic Programmer
3. A Philosophy of Software Design
`,
  [`Daily/${key(new Date(today.getTime() - 86400000))}.md`]: `## Focus\n- [x] Ship the store\n- [ ] Review agent logs\n\n## Notes\nLong day, good progress on [[Projects/Leonote roadmap]].\n`,
};

function task(text, extra = {}) {
  return {
    id: crypto.randomUUID(), text, done: false, created: stamp(new Date(ago(30))), priority: "none", subtasks: [],
    deleted: false, start_date: null, due_date: null, due_time: "", scheduled_jumped: false, due_jumped: false, ...extra,
  };
}

const MOCK_PICTURE = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#173157"/><stop offset="0.42" stop-color="#5f7fae"/><stop offset="0.62" stop-color="#e9a86a"/><stop offset="0.72" stop-color="#f3cf8e"/></linearGradient><linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c98f57"/><stop offset="1" stop-color="#1b2c46"/></linearGradient></defs><rect width="960" height="640" fill="url(#sky)"/><circle cx="690" cy="360" r="46" fill="#ffe9b0"/><path d="M0 470 L150 350 L260 430 L390 300 L520 440 L640 372 L780 452 L960 348 L960 470 Z" fill="#33425e"/><path d="M0 470 L120 392 L240 462 L360 372 L470 470 Z" fill="#2a3853"/><rect y="470" width="960" height="170" fill="url(#water)"/><ellipse cx="690" cy="530" rx="34" ry="9" fill="#ffd98f" opacity="0.7"/><ellipse cx="690" cy="566" rx="24" ry="6" fill="#ffd98f" opacity="0.45"/><path d="M118 470 l26 -58 l26 58 z" fill="#20304a"/><rect x="0" y="628" width="960" height="12" fill="#101a2b"/></svg>');

/* ── "This PC" ────────────────────────────────────────────────────────────
   A make-believe tree so the Search page's This PC tab, its index progress
   and every row action can be driven in a plain browser. Same shape as
   src-tauri/src/pcsearch.rs returns, names only. */

const PC_ROOTS = ["C:\\Users\\you\\Desktop", "C:\\Users\\you\\Documents", "C:\\Users\\you\\Downloads", "C:\\Users\\you\\Pictures", "C:\\Users\\you\\LeoNote"];

function mockPcTree() {
  const out = [];
  const add = (dir, name, isDir, size, days) =>
    out.push({ path: dir + "\\" + name, name, dir, isDir, size, mtime: Date.now() - days * 86400000,
      kind: isDir ? "folder" : /\.(md|txt)$/i.test(name) ? "note" : /\.(json|csv|log|js|rs|css|ya?ml)$/i.test(name) ? "text"
        : /\.(png|jpe?g|webp|gif)$/i.test(name) ? "image" : /\.pdf$/i.test(name) ? "pdf" : /\.(docx?|xlsx?|pptx?)$/i.test(name) ? "office"
        : /\.(mp4|mp3|webm|m4a)$/i.test(name) ? "media" : "other",
      canOpen: !isDir && /\.(md|txt|json|csv|log|js|rs|css|ya?ml|toml)$/i.test(name) });
  const words = ["report", "invoice", "holiday", "budget", "notes", "recipe", "resume", "screenshot", "contract", "roadmap", "reading list", "tax return", "meeting notes", "book club"];
  const exts = [".md", ".pdf", ".png", ".docx", ".txt", ".xlsx", ".jpg", ".mp4", ".json", ".zip"];
  for (const root of PC_ROOTS) {
    add(root.slice(0, root.lastIndexOf("\\")), root.slice(root.lastIndexOf("\\") + 1), true, 0, 400);
    for (let f = 0; f < 6; f++) {
      const folder = root + "\\" + ["2026", "Archive", "Projects", "Scans", "Shared", "Old"][f];
      add(root, folder.slice(folder.lastIndexOf("\\") + 1), true, 0, 30 + f);
      for (let i = 0; i < 24; i++) {
        const w = words[(i + f * 3) % words.length];
        add(folder, `${w} ${2019 + (i % 7)}${exts[(i + f) % exts.length]}`, false, 1024 * (37 + i * 91), (i * 3 + f) % 900);
      }
    }
  }
  return out;
}

export function createMockBackend() {
  // the vault's .trash, in memory: what went, where from, and the notes inside
  const bin = [{ entry: "2026-09-01 101500 Old plan.md", name: "Old plan.md", from: "Ideas/Old plan.md", kind: "note", at: Date.now() - 20 * 86400000, size: 1840, count: 1, notes: [{ path: "Ideas/Old plan.md", content: "# Old plan\n\nFrom the trash.", mtime: Date.now() }] },
    { entry: "2026-09-18 090000 report.pdf", name: "report.pdf", from: null, kind: "file", at: Date.now() - 3 * 86400000, size: 482113, count: 1, notes: [] }];
  const binPut = (from, kind, list) => bin.unshift({ entry: `${new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "")} ${from.split("/").pop()}`, name: from.split("/").pop(), from, kind, at: Date.now(), size: list.reduce((n, x) => n + x.content.length, 0), count: list.length, notes: list });
  const listeners = new Map();
  const emit = (ev, payload) => (listeners.get(ev) || []).forEach((fn) => fn(payload));
  const notes = new Map(Object.entries(NOTES).map(([p, c], i) => [p, { path: p, content: c, mtime: ago(i * 5 + 1) }]));
  // ?mock&big=5000: a large vault, to measure a start
  const big = Number(new URLSearchParams(location.search).get("big")) || 0;
  for (let i = 0; i < big; i++) {
    const d = i % 50, p = `f${d}/Note ${i}.md`;
    notes.set(p, { path: p, content: `---\ntags: [a${d}]\n---\n# Note ${i}\n\n${"Some words of a paragraph. ".repeat(70)}\n- [ ] a task [[Note ${(i + 1) % big}]] #t${i % 100}\n`, mtime: ago(i) });
  }
  const folders = new Set(["Projects", "Ideas", "Daily", "Archive"]);
  const tasks = [
    task("Back up the photo folder", { priority: "high", due_date: key(today) }),
    task("Renew domain before it lapses", { due_date: key(new Date(today.getTime() - 86400000)), priority: "medium" }),
    task("Write the agent contract examples\nwith one example per operation", { subtasks: [{ id: "s1", text: "complete", done: true }, { id: "s2", text: "retitle", done: false }, { id: "s3", text: "tick a subtask", done: false }] }),
    task("Call the accountant", { priority: "low", focus_id: "a2" }),
    task("Book flights to Osaka", { focus_id: "a3", due_date: key(new Date(today.getTime() + 5 * 86400000)) }),
    task("Plan kanban board", { start_date: key(new Date(today.getTime() + 3 * 86400000)) }),
    task("Back up the vault", { done: true, completed_at: stamp(new Date(ago(2))) }),
    task("Old finished thing", { done: true, completed_at: stamp(new Date(ago(60))) }),
    task("Something trashed", { deleted: true, deleted_at: stamp(new Date(ago(3))) }),
  ];
  const habitIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const log = {};
  for (let i = 0; i < 120; i++) {
    const d = key(new Date(today.getTime() - i * 86400000));
    log[d] = habitIds.filter((_, j) => Math.sin(i * (j + 1.3)) > -0.35 && !(i === 0 && j > 0));
  }
  let habits = { habits: [{ id: habitIds[0], name: "Morning walk" }, { id: habitIds[1], name: "Drink water" }, { id: habitIds[2], name: "Read 20 pages" }], log };
  let settings = {};
  let priorities = [
    { id: "a1", title: "Health", notes: "Move every day, sleep well.", subtasks: [{ id: "s1", text: "Walk 30 minutes five days a week", done: false }] },
    { id: "a2", title: "Work", notes: "Ship the side project.", subtasks: [{ id: "s2", text: "Write the landing page", done: true }, { id: "s3", text: "Collect feedback", done: false }] },
    { id: "a3", title: "Travel", notes: "", subtasks: [] },
  ];
  let recurring = {
    version: 1,
    rules: [{
      id: "r1", title: "Back up the photo folder", created: key(new Date(today.getTime() - 40 * 86400000)),
      anchor: key(new Date(today.getTime() - 40 * 86400000)), rule: { kind: "weekly", days: [1], interval: 1 },
      priority: "medium", mode: "task", catchup: "collapse", notify: true, active: true, time: "", skip: [], deleted: false,
    }],
    log: {},
  };
  const stats = { xp: 1950, tasks_created: 95, tasks_done: 47, pomo_total_work_secs: 26507, pomo_daily: {}, pomo_work_mins: 20, pomo_break_mins: 3 };
  for (let i = 0; i < 14; i++) if (i % 3) stats.pomo_daily[key(new Date(today.getTime() - i * 86400000))] = { work: 600 + i * 400, break: 120 };

  const byId = () => new Map(tasks.map((t) => [t.id, t]));
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 1));

  const mockFiles = [
    { path: "Ideas/moodboard 2.png", size: 99320, mtime: ago(3), kind: "image" },
    { path: "Ideas/sketch of the flow.pdf", size: 412000, mtime: ago(5), kind: "pdf" },
    { path: "Ideas/voice memo.mp3", size: 2412000, mtime: ago(6), kind: "media" },
    { path: "Ideas/screen recording.mp4", size: 8412000, mtime: ago(6), kind: "media" },
    { path: "Ideas/screen recording 2.mp4", size: 9412000, mtime: ago(7), kind: "media" },
    { path: "Ideas/moodboard.png", size: 184320, mtime: ago(3), kind: "image" },
    { path: "Projects/brief.pdf", size: 912000, mtime: ago(20), kind: "pdf" },
    { path: "Projects/budget.xlsx", size: 20480, mtime: ago(40), kind: "office" },
    { path: "notes.txt", size: 120, mtime: ago(8), kind: "text" },
    { path: "data.csv", size: 40, mtime: ago(9), kind: "text" },
    { path: "Projects/sync.py", size: 180, mtime: ago(5), kind: "text" },
  ];
  const texts = new Map([["data.csv", "1\n2\n3\n4\n5\n6\n7\n8\n"], ["Projects/sync.py", "import time\n\n\ndef sync(items):\n    \"\"\"Push every item once.\"\"\"\n    for item in items:\n        if item.dirty:\n            item.push()\n    return len(items)\n"]]);
  const blobs = new Map(); // pasted images and PDFs, by vault path
  // The real backend copies a file into <vault>/.trash before the first
  // overwrite of each session (src-tauri/src/lib.rs, `file_write`). The mock
  // keeps the same promise so the browser build can show - and test - it.
  const backedUp = new Set();
  const sidecars = new Map(); // non-destructive picture edits, by vault path
  const libFiles = new Map(); // media libraries outside the vault, by folder
  const paints = new Map(); // Draw documents (.leopaint), by vault path
  let mockBackup = null;
  let associated = false;
  const desk = "C:\\Users\\you\\Desktop\\";
  const outside = new Map([
    [desk + "Meeting notes.md", { text: "# Meeting notes\n\nThis one lives on the desktop, not in the vault.\n\n- [ ] Decide where it belongs\n- A link like [[Welcome]] still opens the vault note\n", mtime: ago(2) }],
    [desk + "server.log", { text: "12:00:01 boot\n12:00:02 ready\n12:00:09 request /notes 14ms\n", mtime: ago(5) }],
    [desk + "holiday.heic", { size: 2400000, mtime: ago(30) }],
  ]);

  // a file on the desktop, or one inside a make-believe outpost
  const outsideFile = (path) => {
    if (outside.has(path)) return outside.get(path);
    const i = path.lastIndexOf("\\");
    const d = opTree.get(path.slice(0, i));
    if (!d || !d.files.includes(path.slice(i + 1))) return null;
    const made = { size: 4200000, mtime: ago(9), text: /\.(md|txt)$/i.test(path) ? "# Playlist notes\n\nA note that lives on the music drive.\n" : undefined };
    outside.set(path, made);
    return made;
  };
  const aiKeys = new Set();
  const aiStop = new Set();
  const opTree = new Map([
    ["E:\\Music\\MyCarMusic", { folders: ["Road Trip", "Calm"], files: ["Intro.mp3", "cover.jpg", "playlist notes.md"] }],
    ["E:\\Music\\MyCarMusic\\Road Trip", { folders: [], files: ["Night Drive.mp3", "Day Drive.flac", "Sunrise.mp3"] }],
    ["E:\\Music\\MyCarMusic\\Calm", { folders: [], files: ["Rain.mp3", "booklet.pdf"] }],
  ]);

  // "This PC": a fake index that fills in over a second, like a real walk
  const pcAll = mockPcTree();
  let pcIndexed = 0;
  let pcTimer = null;
  let pcBuiltAt = 0;
  const pcState = () => ({
    status: pcTimer ? "building" : pcIndexed ? "ready" : "idle",
    entries: pcIndexed, dirs: Math.round(pcIndexed / 24), roots: PC_ROOTS,
    ms: pcTimer ? Date.now() - pcBuiltAt : 840, bytes: pcIndexed * 69, capped: false, done: !pcTimer && pcIndexed > 0, builtAt: pcBuiltAt,
  });
  const pcBuild = () => {
    clearInterval(pcTimer);
    pcIndexed = 0;
    pcBuiltAt = Date.now();
    pcTimer = setInterval(() => {
      pcIndexed = Math.min(pcAll.length, pcIndexed + Math.ceil(pcAll.length / 7));
      if (pcIndexed >= pcAll.length) { clearInterval(pcTimer); pcTimer = null; }
      emit("pc:index", pcState());
    }, 130);
    emit("pc:index", pcState());
  };

  // web panels: ordinary browser windows, so the mock opens browser tabs
  const webWins = new Map();

  const api = {
    boot: () => { if (/missing-vault/.test(location.search)) throw "vault-missing:D:/Notes"; return { vault: "C:\\Users\\you\\LeoNote", notes: [...notes.values()], folders: [...folders], tasks: structuredClone(tasks), habits: structuredClone(habits), settings, recurring: structuredClone(recurring), stats: structuredClone(stats), priorities: structuredClone(priorities), ms: 3.2,
      files: [...mockFiles],
      positions: {}, vault_abs: "", data_dir: "user", data_root: "C:\\Users\\you\\.leonote", open_paths: [], ...(new URLSearchParams(location.search).has("play") ? { packaged: true, store: "Google Play" } : {}) }; }, // ?play: the Google Play build
    note_write: ({ path, content }) => { notes.set(path, { path, content, mtime: Date.now() }); return Date.now(); },
    vault_copy: ({ paths, dir }) => {
      const made = [];
      for (const p of paths) {
        const n = notes.get(p);
        if (!n) continue;
        const name = p.slice(p.lastIndexOf("/") + 1, -3);
        let to = (dir ? dir + "/" : "") + name + ".md";
        for (let k = 2; notes.has(to); k++) to = (dir ? dir + "/" : "") + `${name} ${k}.md`;
        notes.set(to, { path: to, content: n.content, mtime: Date.now() });
        made.push(to);
      }
      return { made, count: made.length, files: [] };
    },
    note_stamp: ({ path, content }) => { const was = notes.get(path); const t = was ? was.mtime : Date.now(); notes.set(path, { path, content, mtime: t }); return t; },
    ids_load: () => { try { return JSON.parse(localStorage.getItem("leonote.mock.ids") || "{}"); } catch { return {}; } },
    ids_save: ({ data }) => { try { localStorage.setItem("leonote.mock.ids", JSON.stringify(data)); } catch {} return null; },
    note_create: ({ path, content }) => {
      let p = path;
      for (let i = 1; notes.has(p); i++) p = path.replace(/\.md$/, ` ${i}.md`);
      notes.set(p, { path: p, content, mtime: Date.now() });
      return p;
    },
    note_rename: ({ from, to }) => { const n = notes.get(from); notes.delete(from); notes.set(to, { ...n, path: to }); return null; },
    note_trash: ({ path, mode }) => { const n = notes.get(path); notes.delete(path); if (n && (!mode || mode === "trash")) binPut(path, "note", [n]); return null; },
    trash_list: () => bin.map(({ notes: _n, ...x }) => x),
    trash_restore: ({ entry, from }) => {
      const it = entry ? bin.find((x) => x.entry === entry) : [...bin].reverse().find((x) => x.from === from);
      if (!it) throw new Error("not in the trash any more");
      bin.splice(bin.indexOf(it), 1);
      for (const n of it.notes) notes.set(n.path, n);
      if (it.kind === "folder") { folders.add(it.from); setTimeout(() => emit("vault:folders", [...folders]), 20); }
      setTimeout(() => emit("vault:changed", it.notes.map((n) => ({ path: n.path, content: n.content, mtime: Date.now() }))), 30);
      return { path: it.from, kind: it.kind };
    },
    trash_remove: ({ entries }) => { for (const e of entries) { const i = bin.findIndex((x) => x.entry === e); if (i >= 0) bin.splice(i, 1); } return entries.length; },
    trash_sweep: () => 0,
    trash_open: () => null,
    project_info: () => ({ repo: true, files: 3 }),
    project_files: () => ["src/main.js", "src/ui/menu.js", "README.md"],
    project_search: ({ query }) => ({ hits: [{ path: "src/main.js", line: 12, text: "  const " + query + " = load();", from: 8, to: 8 + query.length, more: 1 }, { path: "src/ui/menu.js", line: 3, text: "export function " + query + "Menu() {", from: 16, to: 16 + query.length, more: 0 }], total: 3, files: 2, scanned: 3, partial: false, ms: 4 }),
    project_replace: ({ paths }) => ({ files: paths, count: 3, stamp: "20260921-220000" }),
    project_undo: () => 2,
    project_git: ({ action }) => (action === "status" ? { ok: true, code: 0, out: "## main...origin/main [ahead 1]\n M src/main.js\n?? notes/todo.md\n", err: "" } : action === "diff" ? { ok: true, code: 0, out: "diff --git a/src/main.js b/src/main.js\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;\n unchanged", err: "" } : action === "branches" ? { ok: true, code: 0, out: "main\ndev\n", err: "" } : { ok: true, code: 0, out: "Everything up-to-date", err: "" }),
    source_fetch: ({ url }) => (/\.pdf$/i.test(url) ? { url, type: "application/pdf", b64: "JVBERi0xLjQK" } : { url, type: "text/html; charset=utf-8", text: "<html><head><title>Sleep and memory - a review</title><meta property='og:title' content='Sleep and memory'></head><body><nav>Home | About</nav><article><h1>Sleep and memory</h1><p>REM sleep helps the brain keep what it learned during the day.</p><h2>Findings</h2><ul><li>Recall was 20% better after a night's sleep.</li></ul></article><footer>cookies</footer></body></html>" }),
    link_picture: () => "",
    link_preview: ({ url }) => ({ title: "A page at " + url, description: "What the page says about itself, in the mock.", image: "", site: "mock" }),
    web_ext_list: () => [{ id: "abcdefghijklmnopabcdefghijklmnop", name: "Mock blocker", enabled: true, version: "1.2.3", description: "A pretend add-on for the mock.", popup: "popup.html", options: "options.html" }], ext_pop_show: () => null, ext_pop_hide: () => null, web_ext_install: () => ({ id: "x", name: "Mock add-on" }), web_ext_set: () => null, web_ext_sites: ({ sites }) => sites, web_ext_remove: () => null, web_ext_update: () => ({ updated: [], failed: [] }),
    tab_web_show: () => ({ created: true }), tab_web_hide: () => null, tab_web_close: () => null, tab_web_go: () => null,
    folder_create: ({ path }) => { folders.add(path); return null; },
    folder_rename: ({ from, to }) => {
      for (const [p, n] of [...notes]) if (p.startsWith(from + "/")) { notes.delete(p); const np = to + p.slice(from.length); notes.set(np, { ...n, path: np }); }
      folders.delete(from); folders.add(to); return null;
    },
    folder_trash: ({ path, mode }) => { const inside = []; for (const p of [...notes.keys()]) if (p.startsWith(path + "/")) { inside.push(notes.get(p)); notes.delete(p); } folders.delete(path); if (!mode || mode === "trash") binPut(path, "folder", inside); return null; },
    task_ops: ({ ops }) => {
      const m = byId();
      const patch = {};
      for (const op of ops) {
        const { id, t, by, op: _o, $unset, ...rest } = op;
        let tk = m.get(id);
        if (!tk) { tk = { id }; tasks.push(tk); m.set(id, tk); }
        Object.assign(tk, rest);
        if ($unset) for (const k of $unset) delete tk[k];
        patch[id] = { ...rest };
      }
      return { patch, bad: 0 };
    },
    habits_save: ({ data }) => { habits = data; return null; },
    settings_save: ({ data }) => { settings = data; return null; },
    reveal: () => null,
    reveal_settings: () => null,
    app_quit: () => null,
    trace_ui: () => null,
    app_request_quit: () => null,
    recurring_save: ({ data }) => { recurring = data; return null; },
    stats_save: () => null,
    priorities_save: ({ data }) => { priorities = data; return null; },
    open_path: () => null,
    file_read_text: ({ path }) => texts.get(path) ?? `Sample text of ${path}\nsecond line`,
    file_write: (bytes, opts) => {
      const path = decodeURIComponent(opts.headers["x-path"]);
      let f = mockFiles.find((x) => x.path === path);
      if (!f) {
        const ext = path.split(".").pop().toLowerCase();
        f = { path, size: 0, mtime: Date.now(), kind: /^(png|jpe?g|gif|webp|svg)$/.test(ext) ? "image" : ext === "pdf" ? "pdf" : "text" };
        mockFiles.push(f);
      } else if (!backedUp.has(path.toLowerCase())) {
        // first overwrite this session: the old version goes to .trash
        backedUp.add(path.toLowerCase());
        const name = path.slice(path.lastIndexOf("/") + 1);
        const kept = `.trash/${stamp().replace("T", " ").replace(/:/g, "")} ${name}`;
        const was = blobs.get(path) || null;
        if (was) blobs.set(kept, was);
        mockFiles.push({ path: kept, size: f.size, mtime: Date.now(), kind: f.kind });
      }
      if (f.kind === "text") texts.set(path, new TextDecoder().decode(bytes));
      if (f.kind === "image") blobs.set(path, URL.createObjectURL(new Blob([bytes])));
      if (f.kind === "pdf") blobs.set(path, URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })));
      Object.assign(f, { size: bytes.length, mtime: Date.now() });
      setTimeout(() => emit("vault:files", [...mockFiles]), 20);
      return { ...f };
    },
    file_trash: ({ path }) => { binPut(path, "file", []); return null; },
    file_rename: () => null,
    positions_save: () => null,
    // the graph layout survives a reload in the browser too
    graph_load: () => { try { return JSON.parse(localStorage.getItem("leonote.mock.graph") || "{}"); } catch { return {}; } },
    fit_load: () => { try { return JSON.parse(localStorage.getItem("leonote.mock.fit") || "{}"); } catch { return {}; } },
    fit_save: ({ data }) => { try { localStorage.setItem("leonote.mock.fit", JSON.stringify(data)); } catch {} return null; },
    text_save: () => null,
    voice_listen: () => new Promise((r) => setTimeout(() => r("ten push ups"), 300)),
    speech_transcribe: () => ({ text: "ten push ups" }),
    // kept pictures: one big one to make small; what is put back is kept for a test to look at
    yt_previews: () => ({ dir: "C:/Users/you/LeoNote/.leonote/previews", ids: ["aaaaaaaaaaa"], small: [] }),
    yt_preview_keep: () => true,
    yt_preview_bytes: async () => { const c = new OffscreenCanvas(320, 180); const g = c.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 320, 180); g.fillStyle = "#fff"; g.fillRect(40, 40, 120, 60); const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.92 }); return await b.arrayBuffer(); },
    yt_preview_put: ({ id, data }) => { const bytes = [...atob(data)].map((c) => c.charCodeAt(0)); (window.__puts = window.__puts || []).push({ id, n: bytes.length, kind: String.fromCharCode(...bytes.slice(0, 4), ...bytes.slice(8, 12)) }); return null; },
    video_ai: ({ project, ops }) => {
      const p = JSON.parse(project);
      if (!ops) return { overview: `this project - ${p.clips.length} clips - c3 text "${((p.clips.find((c) => c.id === "c3") || {}).text || {}).text || ""}"`, notes: [], check: [] };
      for (const o of ops) { const c = p.clips.find((x) => x.id === o.clip); if (o.op === "set" && c && o.text) c.text.text = o.text; }
      return { project: p, done: ops.map((o) => `Clip ${o.clip}: text set`), look: [], check: [] };
    },
    graph_save: ({ data }) => { try { localStorage.setItem("leonote.mock.graph", JSON.stringify(data)); } catch {} return null; },
    vault_candidates: () => [{ path: "G:\\Vaults\\Personal", name: "Personal", exists: true, open: true }, { path: "G:\\Vaults\\Archive", name: "Archive", exists: true, open: false }],
    app_restart: () => { location.reload(); return null; },
    backup_export: ({ path, password, includeVault }) => {
      if (!password || password.length < 8) throw new Error("password too short");
      mockBackup = { password, includes_vault: !!includeVault };
      return { path, bytes: 48213, data_files: ["tasks.json", "habits.json", "stats.json", "recurring.json", "priorities.json", "log/ui.jsonl"], vault_files: includeVault ? notes.size : 0, created: new Date().toISOString(), skipped: [] };
    },
    backup_peek: ({ password }) => {
      if (!mockBackup) throw new Error("not a Leonote backup");
      if (password !== mockBackup.password) throw new Error("wrong password");
      return { format: "leonote-backup", version: 1, created: new Date().toISOString(), app_version: "1.0.0", device: "DESKTOP-DEMO", includes_vault: mockBackup.includes_vault, data_files: ["tasks.json", "habits.json", "stats.json"], vault_files: notes.size };
    },
    backup_import: ({ path, restoreVault }) => ({ path, bytes: 48213, data_files: ["tasks.json"], vault_files: restoreVault ? notes.size : 0, skipped: [], before_restore: null, vault_unchanged: 0, vault_replaced: 0 }),
    paste_files: () => ({ pasted: [], count: 0 }),
    // files outside the vault (extview.js): a few make-believe ones on the
    // desktop, so the browser build can show the banner and both editors
    guest_open: ({ path }) => {
      let h = 0;
      for (const c of String(path).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      const name = String(path).split(/[\\/]/).pop();
      const kind = /\.pdf$/i.test(name) ? "pdf" : /\.(docx?|xlsx?|pptx?)$/i.test(name) ? "office" : /\.(png|jpe?g|webp|gif)$/i.test(name) ? "image" : /\.(mp4|webm|mp3)$/i.test(name) ? "media" : /\.(html?|json|leocanvas|leovideo)$/i.test(name) ? "text" : "other";
      return { path: `@guest/${h.toString(16)}/${name}`, kind, size: 41000, mtime: Date.now() - 72e6 };
    },
    external_stat: ({ path }) => {
      const f = outsideFile(path);
      if (!f) throw new Error(`${path}: the system cannot find the file specified`);
      const name = path.split(/[\\/]/).pop();
      const kind = /\.(mp3|flac|mp4|mkv)$/i.test(name) ? "media" : /\.(jpe?g|png)$/i.test(name) ? "image" : /\.pdf$/i.test(name) ? "pdf" : /\.(md|txt)$/i.test(name) ? "note" : /\.(js|json|csv|py|rs|css|html|log|ya?ml|toml)$/i.test(name) ? "text" : "other";
      return { path, name, dir: path.slice(0, Math.max(0, path.length - name.length - 1)), size: f.text ? f.text.length : f.size || 0, mtime: f.mtime, kind, editable: kind === "note" || kind === "text" };
    },
    external_read: (a) => {
      const st = api.external_stat(a);
      if (!st.editable) throw new Error(`${st.name} is not a text file`);
      return { ...st, text: outsideFile(a.path).text };
    },
    external_write: ({ path, content }) => {
      const f = outside.get(path);
      if (!f) throw new Error(`${path} is gone`);
      Object.assign(f, { text: content, mtime: Date.now() });
      return api.external_stat({ path });
    },
    external_put_back: () => null,
    phone_devices: () => [{ id: "mock-phone", name: "Pixel 8" }],
    phone_list: ({ parent, req }) => {
      const top = [{ id: "s1", name: "Internal shared storage", dir: true, size: 0, mtime: 0, cap: 128e9, free: 9e9 }];
      const dcim = [{ id: "cam", name: "Camera", dir: true, size: 0, mtime: 0 }, { id: "shots", name: "Screenshots", dir: true, size: 0, mtime: 0 }];
      const cam = Array.from({ length: 120 }, (_, i) => ({ id: "p" + i, name: (i % 9 === 0 ? "VID_2026" + i + ".mp4" : i % 7 === 0 ? "IMG_" + i + ".heic" : "IMG_2026" + i + ".jpg"), dir: false, size: (i % 9 === 0 ? 180e6 : 3e6) + i * 1000, mtime: Date.now() - i * 3600e3 }));
      const list = parent === "" ? top : parent === "s1" ? [{ id: "dcim", name: "DCIM", dir: true, size: 0, mtime: 0 }, { id: "dl", name: "Download", dir: true, size: 0, mtime: 0 }] : parent === "dcim" ? dcim : parent === "cam" ? cam : [];
      for (let i = 0; i < list.length; i += 40) setTimeout(() => emit("phone:list", { req, items: list.slice(i, i + 40), done: i + 40 >= list.length }), 50 + i * 2);
      if (!list.length) setTimeout(() => emit("phone:list", { req, items: [], done: true }), 30);
      return null;
    },
    phone_copy: ({ items, dir, remove, job }) => { items.forEach((it, i) => setTimeout(() => emit("phone:copy", { job, done: i + 1, total: items.length, failed: 0, name: it.name, id: it.id, to: `${dir}/${it.name}` }), 40 * (i + 1))); setTimeout(() => emit("phone:copy", { job, done: items.length, total: items.length, failed: 0, removed: remove ? items.length : 0, copied: items.map((x) => x.id), finished: true, dir }), 40 * (items.length + 2)); return null; },
    phone_delete: ({ ids }) => ids.length,
    phone_scan: ({ req }) => {
      const all = Array.from({ length: window.__phoneFiles || 300 }, (_, i) => ({ id: "s" + i, name: i % 10 === 0 ? `VID_${i}.mp4` : i % 13 === 0 ? `doc_${i}.pdf` : `IMG_${i % 150}.jpg`, dir: false, size: i % 10 === 0 ? 90e6 + i : (i % 150) * 20000 + 60000, mtime: Date.now() - i * 86400e3, path: i % 3 ? "Internal shared storage/DCIM/Camera" : "Internal shared storage/Pictures/WhatsApp", parent: i % 3 ? "cam" : "wa" }));
      const gone = !!window.__phoneGone; // a phone that stops answering, for the checks
      for (let i = 0; i < all.length; i += 100) setTimeout(() => emit("phone:scan", { req, items: all.slice(i, i + 100), folders: 10 + i / 10, unread: gone ? 7 : 0, gone, stopped: false, done: i + 100 >= all.length }), 60 + i * (window.__phoneSlow || 1));
      return null;
    },
    phone_scan_stop: () => null,
    phone_fingerprints: ({ ids }) => Object.fromEntries(ids.map((id, i) => [id, i % 3 === 0 ? "aa" + id : "same"])),
    phone_compress: ({ items, job }) => { items.forEach((it, i) => setTimeout(() => emit("phone:compress", { job, id: it.id, name: it.name, state: /heic/i.test(it.name) ? "skipped" : "ready", why: "HEIC is already small", before: it.size, after: Math.round(it.size * 0.42), orig: "C:/tmp/o", out: "C:/tmp/n" }), 60 * (i + 1))); setTimeout(() => emit("phone:compress", { job, finished: true }), 60 * (items.length + 2)); return null; },
    phone_compress_apply: ({ items }) => ({ done: items.length, errors: [], ids: Object.fromEntries(items.map((x) => [x.id, { id: x.id + "n", size: 1000 }])) }),
    phone_compress_discard: () => null,
    online_tools: () => ({ ffmpeg: null, winget: true }),
    // no winget in the mock: the app answers that it would download directly, and asks first
    // a not-indexed folder with one note in it
    unindexed_names: () => [],
    unindexed_find: ({ query }) => (/baka/i.test(query) ? [{ name: "log.md", path: "Chats/log.md", abs: "C:/Vault/Chats/log.md", snippet: "we talked about baka mitai" }] : []),
    no_index_set: () => null,
    // ?update=critical|important|normal tries how an update is told
    update_check: () => { const l = new URLSearchParams(location.search).get("update") || "important"; return { current: "1.0.0", latest: "1.1.0", newer: true, url: "https://leonote.app/download", notes: l === "critical" ? "Fixes a problem that could lose notes saved during a sync." : "", security: l !== "normal", level: l, installable: false }; },
    claude_import: () => ({ added: 3, updated: 0, kept: 0, total: 3 }),
    tool_install: ({ tool, direct }) => { if (!direct) throw "DIRECT:https://example.org/" + tool + ".zip"; return "C:/tools/" + tool + ".exe"; },
    online_install: () => null,
    // song details, kept in memory: what the app writes into the file
    music_tags: ({ path }) => ({ duration: /sfx|click/i.test(path) ? 2 : 200, ...((globalThis.__mockTags || {})[path] || {}) }),
    music_tags_write: ({ path, fields }) => { const m = (globalThis.__mockTags = globalThis.__mockTags || {}); m[path] = { ...(m[path] || {}), ...fields }; return { mtime: Date.now(), size: 1 }; },
    external_import: ({ path, dir, moveIt }) => {
      const f = outside.get(path);
      if (!f) throw new Error(`${path} is gone`);
      const name = path.split(/[\\/]/).pop();
      let rel = dir ? dir + "/" + name : name;
      const dot = rel.lastIndexOf(".");
      for (let i = 2; notes.has(rel) || mockFiles.some((x) => x.path === rel); i++) rel = `${rel.slice(0, dot)} ${i}${rel.slice(dot)}`;
      const isNote = /\.(md|txt)$/i.test(name);
      if (isNote) notes.set(rel, { path: rel, content: f.text || "", mtime: Date.now() });
      else mockFiles.push({ path: rel, size: f.size || 0, mtime: Date.now(), kind: "other" });
      if (moveIt) outside.delete(path);
      setTimeout(() => emit(isNote ? "vault:changed" : "vault:files", isNote ? [notes.get(rel)] : [...mockFiles]), 20);
      return { path: rel, note: isNote, from: path, moved: !!moveIt };
    },
    external_allow: () => true,
    // outposts: a make-believe music drive, held in memory
    outpost_add: ({ path }) => { const p = String(path).replace(/[\\/]+$/, ""); if (!opTree.has(p)) opTree.set(p, { folders: [], files: [] }); return { path: p, name: p.split(/[\\/]/).pop() }; },
    outpost_forget: () => null,
    outpost_list: ({ path }) => {
      const d = opTree.get(path);
      if (!d) throw new Error(`${path}: the system cannot find the path specified`);
      return { path, capped: false,
        folders: d.folders.map((n) => ({ path: path + "\\" + n, name: n, mtime: ago(9) })),
        files: d.files.map((n) => ({ path: path + "\\" + n, name: n, size: 4200000, mtime: ago(9), kind: /\.(mp3|flac|mp4|mkv)$/i.test(n) ? "media" : /\.(jpg|png)$/i.test(n) ? "image" : /\.pdf$/i.test(n) ? "pdf" : /\.(md|txt)$/i.test(n) ? "note" : "other" })) };
    },
    // a make-believe model: it says what it was sent, a word at a time
    ai_key_set: ({ id, key }) => { key ? aiKeys.add(id) : aiKeys.delete(id); },
    ai_key_get: ({ id }) => (aiKeys.has(id) && !(window.__hiddenKeys || new Set()).has(id) ? "ts_test_" + id : null),
    ai_key_hide: ({ id }) => { (window.__hiddenKeys ||= new Set()).add(id); },
    ai_key_hidden: ({ id }) => !!(window.__hiddenKeys && window.__hiddenKeys.has(id)),
    ai_keys_have: () => [...aiKeys],
    // agents' proposals and AI access, kept in memory
    proposals_count: () => (window.__props || []).length,
    proposals_list: () => (window.__props || []).map((p) => ({ ...p, now: (notes.get(p.path) || {}).content ?? null, changed: false })),
    proposal_accept: ({ id }) => { const p = (window.__props || []).find((x) => x.id === id); window.__props = (window.__props || []).filter((x) => x.id !== id); return p ? p.path : ""; },
    proposal_make: ({ path, content, kind, agent, why }) => { const id = "m" + Date.now().toString(36); window.__props = [...(window.__props || []), { id, at: new Date().toISOString().slice(0, 19), agent, kind, path, why, content }]; return id; },
    proposal_reject: ({ id }) => { window.__props = (window.__props || []).filter((x) => x.id !== id); },
    web_passwords_set: () => {},
    pw_status: () => ({ exists: !!globalThis.__pw, open: !!globalThis.__pwOpen }),
    pw_reset: () => { globalThis.__pw = null; globalThis.__pwOpen = false; return "~/.leonote/passwords forgotten (mock).age"; },
    pw_unlock: ({ master }) => { if (globalThis.__pw && globalThis.__pw.m !== master) throw "wrong password"; globalThis.__pw ||= { m: master, items: [] }; globalThis.__pwOpen = true; return globalThis.__pw.items.map(({ password, ...x }) => x); },
    pw_lock: () => { globalThis.__pwOpen = false; },
    pw_list: () => globalThis.__pw.items.map(({ password, ...x }) => x),
    pw_reveal: ({ id }) => globalThis.__pw.items.find((x) => x.id === id).password,
    pw_put: ({ item }) => { const L = globalThis.__pw.items; const o = L.find((x) => x.id === item.id); if (o) Object.assign(o, item, item.password == null ? { password: o.password } : {}); else L.push({ ...item, id: String(Date.now()) }); return L.map(({ password, ...x }) => x); },
    pw_remove: ({ id }) => { globalThis.__pw.items = globalThis.__pw.items.filter((x) => x.id !== id); return globalThis.__pw.items.map(({ password, ...x }) => x); },
    web_history_get: () => window.__webHist || "",
    web_history_set: ({ json }) => { window.__webHist = json; },
    tasks_erase: ({ ids }) => { window.__tasksErased = [...(window.__tasksErased || []), ...ids]; return ids.length; },
    note_history_erase: ({ path, dry }) => { const n = (window.__erased = window.__erased || {}); if (n[path]) return { versions: 0, trash: 0, proposals: 0 }; if (!dry) n[path] = true; return { versions: 3, trash: 1, proposals: 0 }; },
    jev_backend_get: () => window.__jevBackend || { backend: "typesafe", base: "http://127.0.0.1:8000", model: "" },
    jev_backend_set: ({ backend, base, model }) => (window.__jevBackend = { backend: backend === "laya" ? "laya" : "typesafe", base: base || "http://127.0.0.1:8000", model: model || "" }),
    laya_install: () => {},
    laya_start: () => {},
    ai_full_set: ({ full }) => { const r = window.__access || { default: "review", folders: {} }; if (full) r.full = true; else delete r.full; window.__access = r; return r; },
    ai_tasks_set: ({ split }) => { const r = window.__access || { default: "review", folders: {} }; if (split) r.tasks = "split"; else delete r.tasks; window.__access = r; return r; },
    // plugins: a test sets window.__plugins (rows) and window.__pluginMain ({ id: script })
    plugin_list: () => window.__plugins || [],
    plugin_install_folder: () => null,
    plugin_search: () => { throw "mock: no list"; },
    plugin_install_listed: () => null,
    plugin_enable: ({ id }) => { (window.__plugins || []).find((p) => p.id === id).on = true; return true; },
    plugin_disable: ({ id }) => { (window.__plugins || []).find((p) => p.id === id).on = false; },
    plugin_remove: ({ id }) => { window.__plugins = (window.__plugins || []).filter((p) => p.id !== id); },
    plugin_main: ({ id }) => (window.__pluginMain || {})[id] || "",
    plugin_fetch: () => { throw "mock: no network"; },
    ai_access_get: () => window.__access || { default: "review", folders: {} },
    ai_access_set: ({ folder, mode }) => { const r = window.__access || { default: "review", folders: {} }; if (!folder) r.default = mode || "review"; else if (mode) r.folders[folder] = mode; else delete r.folders[folder]; window.__access = r; return r; },
    // Jev, pretended: each choice its first answer, each yes/no a lean towards yes
    jev_ask: ({ body }) => {
      const answers = {};
      for (const [name, q] of Object.entries(body.questions || {})) {
        if (q.type === "noul") answers[name] = { type: "noul", noul: 0.72 };
        else if (q.type === "score") answers[name] = { type: "score", score: 1, legend: Object.fromEntries((q.criteria || []).map((c, i) => [i, c])), probabilities: Object.fromEntries((q.criteria || []).map((c, i) => [i, i === 1 ? 0.7 : 0.3 / Math.max(1, q.criteria.length - 1)])), confidence: 0.7 };
        else { const keys = Object.keys(q.criteria || {}); answers[name] = { type: "choice", choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i ? 0.1 / (keys.length - 1) : 0.9])), confidence: 0.9 }; }
      }
      return { model: "jev-latest", answers, usage: { input_tokens: 120, output_tokens: 0 }, latency_ms: 84 };
    },
    archive_list: () => [{ name: "notes/readme.md", size: 120, packed: 80, dir: false, modified: "2026-09-30 10:00" }, { name: "pic.png", size: 2048, packed: 1900, dir: false, modified: "2026-09-30 10:01" }],
    archive_preview: () => "C:\\Users\\you\\Desktop\\Meeting notes.md",
    mcp_command: () => ({ command: "C:\\Program Files\\LeoNote\\leonote-rs.exe", args: ["--mcp"] }),
    ai_models: ({ kind }) => (kind === "anthropic" ? ["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5", "claude-sonnet-5"] : ["hermes-3-llama-3.1-8b", "qwen3-14b", "mock-large"]),
    ai_cancel: ({ id }) => { aiStop.add(id); },
    ai_chat: ({ id, model, system, messages, tools, kind, base, look }) => {
      if (kind === "cli") model = `${base.split(" ")[0]} (program${look ? ", reads the vault" : ""})`;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      // a project chat asked to change something: the mock appends to the brief, edits it, makes a note, and tries to get out
      const proj = /whose notes are in the folder "([^"]+)"/.exec(system || "");
      if (proj && tools && tools.some((t) => t.name === "append_to_note") && messages[messages.length - 1].role !== "tool" && /\bchange\b|\badd\b/i.test(lastUser.content)) {
        const folder = proj[1], brief = folder + "/" + folder.split("/").pop() + ".md";
        setTimeout(() => emit("ai", { id, type: "done", stop: "tool_use", tool_calls: [
          { id: "ta_" + id, name: "append_to_note", input: { path: brief, text: "## From the chat\n- an added line" } },
          { id: "te_" + id, name: "edit_note", input: { path: brief, find: "## Goal", replace: "## Goal\nShip it." } },
          { id: "tw_" + id, name: "write_note", input: { path: "Plan.md", content: "# Plan\n\n- step one\n" } },
          { id: "tx_" + id, name: "write_note", input: { path: "../Outside.md", content: "no" } },
        ], raw: [] }), 60);
        return;
      }
      if (tools && tools.length && messages[messages.length - 1].role !== "tool" && /\bfind\b|\bsearch\b/i.test(lastUser.content)) {
        setTimeout(() => emit("ai", { id, type: "done", stop: "tool_use", tool_calls: [{ id: "tu_" + id, name: "search_notes", input: { query: "agent" } }, { id: "tr_" + id, name: "read_note", input: { path: "Welcome" } }], raw: [] }), 60);
        return;
      }
      // the video editor's AI panel: one sentence and an edit
      if (/Leonote's video editor/.test(system || "")) {
        const words = ["I'll change the caption.", "```json", JSON.stringify({ ops: [{ op: "set", clip: "c3", text: "Edited by AI" }] }), "```"].join("\n");
        setTimeout(() => { emit("ai", { id, type: "text", text: words }); emit("ai", { id, type: "done", stop: "end_turn" }); }, 60);
        return;
      }
      const looked = messages.filter((m) => m.role === "tool").length;
      const last = lastUser.content + (looked ? ` (after ${looked} look-ups)` : "") + ((lastUser.images || []).length ? ` [${lastUser.images.length} picture]` : "");
      const notes = (system.match(/<note path="([^"]+)">/g) || []).length;
      const words = `## A mock answer

You asked: **${last.slice(0, 80)}**

- model: \`${model}\`
- notes sent along: ${notes}${/<selection/.test(system) ? " (and a selection)" : ""}
- [ ] a task it found

See [[Welcome]] and https://example.com for more.`.split(/(?<= )/);
      let i = 0;
      const t = setInterval(() => {
        if (aiStop.delete(id)) { clearInterval(t); return emit("ai", { id, type: "done", stop: "cancelled" }); }
        if (i >= words.length) { clearInterval(t); return emit("ai", { id, type: "done", stop: "end_turn", sources: /sonar/.test(model) ? ["https://example.com/a", "https://example.org/b"] : [] }); }
        emit("ai", { id, type: "text", text: words[i++] });
      }, 25);
    },
    outpost_texts: () => {
      const files = [];
      for (const [dir, d] of opTree) for (const n of d.files) if (/\.(md|txt)$/i.test(n)) files.push({ path: dir + "\\" + n, name: n, root: "E:\\Music\\MyCarMusic", size: 60, mtime: ago(9) });
      return { files, scanned: 40, partial: false };
    },
    outpost_find: ({ query }) => {
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [];
      for (const [dir, d] of opTree) {
        const root = [...opTree.keys()].filter((k) => dir === k || dir.startsWith(k + "\\")).sort((a, b) => a.length - b.length)[0];
        for (const n of d.folders) if (words.every((w) => n.toLowerCase().includes(w))) hits.push({ path: dir + "\\" + n, name: n, dir, root, isDir: true, size: 0, mtime: ago(9), kind: "folder" });
        for (const n of d.files) if (words.every((w) => n.toLowerCase().includes(w))) hits.push({ path: dir + "\\" + n, name: n, dir, root, isDir: false, size: 4200000, mtime: ago(9), kind: "media" });
      }
      return { hits, scanned: 40, partial: false, ms: 3 };
    },
    outpost_rename: ({ path, name }) => {
      const i = path.lastIndexOf("\\"); const dir = path.slice(0, i); const old = path.slice(i + 1); const d = opTree.get(dir);
      if (!d) throw new Error("not inside an outpost");
      if (d.files.includes(name) || d.folders.includes(name)) throw new Error(`${name} is already there`);
      const to = dir + "\\" + name;
      if (d.folders.includes(old)) { d.folders[d.folders.indexOf(old)] = name; for (const [k, v] of [...opTree]) if (k === path || k.startsWith(path + "\\")) { opTree.delete(k); opTree.set(to + k.slice(path.length), v); } }
      else d.files[d.files.indexOf(old)] = name;
      return to;
    },
    outpost_mkdir: ({ dir, name }) => { const d = opTree.get(dir); if (!d) throw new Error("not inside an outpost"); let n = name; for (let i = 2; d.folders.includes(n); i++) n = `${name} ${i}`; d.folders.push(n); opTree.set(dir + "\\" + n, { folders: [], files: [] }); return dir + "\\" + n; },
    folder_sizes: ({ path }) => ({ path, total: 9_412_000 + 8_412_000 + 2_412_000 + 51_000, files: 4,
      children: [{ name: "Ideas", path: path + "\\Ideas", dir: true, size: 20_236_000, files: 3 }, { name: "Welcome.md", path: path + "\\Welcome.md", dir: false, size: 51_000, files: 1 }],
      largest: [["screen recording 2.mp4", 9_412_000], ["screen recording.mp4", 8_412_000], ["voice memo.mp3", 2_412_000], ["Welcome.md", 51_000]].map(([n, size]) => ({ path: path + (n === "Welcome.md" ? "\\" : "\\Ideas\\") + n, size })) }),
    outpost_trash: ({ paths }) => { for (const p of paths) { const i = p.lastIndexOf("\\"); const d = opTree.get(p.slice(0, i)); if (d) { d.folders = d.folders.filter((n) => n !== p.slice(i + 1)); d.files = d.files.filter((n) => n !== p.slice(i + 1)); } opTree.delete(p); } return null; },
    external_open_in_app: () => null,
    external_reveal: () => null,

    pc_index_start: ({ force }) => { if (force || (!pcTimer && !pcIndexed)) pcBuild(); return pcState(); },
    pc_index_state: () => pcState(),
    pc_index_cancel: () => { clearInterval(pcTimer); pcTimer = null; return pcState(); },
    pc_drives: () => ["C:\\", "D:\\"],
    // Disk space, gradual: the mock answers at once from its one listing
    sizes_start: ({ path }) => { const r = api.folder_sizes({ path }); return { result: { ...r, done: true, children: r.children.map((c) => (c.dir ? { ...c, top: [{ path: c.path + "\clip.mp4", size: 9_412_000 }, { path: c.path + "\shot.png", size: 8_412_000 }, { path: c.path + "\song.mp3", size: 2_000_000 }] } : c)) } }; },
    sizes_poll: () => ({ done: true, children: [], largest: [], total: 0, files: 0 }),
    sizes_stop: () => null,
    drive_space: () => ({ free: 120e9, total: 512e9 }),
    pc_roots: ({ roots }) => ({ effective: [...PC_ROOTS, ...(roots || [])], defaults: PC_ROOTS }),
    pc_search: ({ query, limit }) => {
      const q = String(query || "").trim();
      if (!q) return { hits: [], matched: 0, scanned: 0, ms: 0, partial: false, index: pcState() };
      const t0 = performance.now();
      const scored = [];
      for (const e of pcAll.slice(0, pcIndexed)) {
        const f = fuzzy(q, e.name);
        if (f) scored.push({ ...e, score: f.score });
      }
      scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
      return { hits: scored.slice(0, limit || 200), matched: scored.length, scanned: pcIndexed, ms: Math.round(performance.now() - t0), partial: false, index: pcState() };
    },

    web_window_open: ({ id, url }) => {
      if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("A web page has to start with http:// or https://");
      const had = webWins.has(id);
      webWins.set(id, { url });
      if (!had) window.open(url, "leonote-web-" + id);
      return { label: "web-" + id, focused: had };
    },
    web_window_close: ({ id }) => { const had = webWins.delete(id); return { closed: had, geometry: { x: 120, y: 90, w: 980, h: 760 } }; },
    web_window_list: () => [...webWins.keys()].map((id) => ({ label: "web-" + id, geometry: { x: 120, y: 90, w: 980, h: 760 } })),
    associate_files: ({ exts, enable }) => { associated = !!enable && exts.length > 0; return associated; },
    associate_state: () => associated,
    external_stage: (bytes, opts) => {
      const name = decodeURIComponent(opts.headers["x-name"]);
      let path = "C:\\Temp\\leonote-dropped\\" + name;
      for (let i = 2; outside.has(path); i++) path = "C:\\Temp\\leonote-dropped\\" + name.replace(/(\.[^.]*)?$/, ` ${i}$1`);
      outside.set(path, { text: new TextDecoder().decode(bytes), size: bytes.length, mtime: Date.now() });
      return path;
    },
    file_import: (bytes, opts) => {
      let path = decodeURIComponent(opts.headers["x-path"]);
      const dot = path.lastIndexOf(".");
      for (let i = 2; mockFiles.some((f) => f.path === path); i++) path = dot > path.lastIndexOf("/") ? `${path.slice(0, dot)} ${i}${path.slice(dot)}` : `${path} ${i}`;
      const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      const kind = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(ext) ? "image" : ext === "pdf" ? "pdf" : /^(docx?|xlsx?|pptx?)$/.test(ext) ? "office" : /^(mp4|webm|mp3|wav|ogg|m4a)$/.test(ext) ? "media" : "other";
      if (kind === "pdf" || kind === "image") blobs.set(path, URL.createObjectURL(new Blob([bytes], { type: kind === "pdf" ? "application/pdf" : "image/png" })));
      mockFiles.push({ path, size: bytes.length, mtime: Date.now(), kind });
      setTimeout(() => emit("vault:files", [...mockFiles]), 30);
      return path;
    },
    // non-destructive picture edits: the browser mock keeps the sidecars in
    // localStorage, so a drawing survives a reload the way the real one does
    image_edit_read: ({ path }) => {
      if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(String(path || ""))) throw new Error("not a picture: " + path);
      try { return localStorage.getItem("leonote.mock.leoedit:" + path); } catch { return sidecars.get(path) ?? null; }
    },
    image_edit_write: ({ path, content }) => {
      if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(String(path || ""))) throw new Error("not a picture: " + path);
      if (!String(content).trim().startsWith("{")) throw new Error("edits must be a JSON object");
      sidecars.set(path, content);
      try { localStorage.setItem("leonote.mock.leoedit:" + path, content); } catch {}
      return null;
    },
    image_edit_delete: ({ path }) => {
      sidecars.delete(path);
      try { localStorage.removeItem("leonote.mock.leoedit:" + path); } catch {}
      return null;
    },
    image_save: (bytes, opts) => {
      const path = decodeURIComponent(opts.headers["x-path"]);
      if (mockFiles.some((f) => f.path === path)) throw new Error("already exists: " + path);
      // media too (browser tests of the player), by extension
      const media = /\.(mp3|wav|ogg|m4a|mp4|webm)$/i.exec(path);
      const type = media ? { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm" }[media[1].toLowerCase()] : "image/webp";
      blobs.set(path, URL.createObjectURL(new Blob([bytes], { type })));
      mockFiles.push({ path, size: bytes.length, mtime: Date.now(), kind: media ? "media" : "image" });
      return [...mockFiles];
    },
    // Draw documents. The real backend zips these into a .leopaint
    // (src-tauri/src/paint.rs); the browser mock keeps the same three pieces
    // in memory so the editor can be saved, reopened and exported here too.
    paint_save: ({ path, manifest, layers, thumb }) => {
      if (!/\.leostudio$/i.test(String(path || ""))) throw new Error("not a drawing: " + path);
      JSON.parse(manifest); // the real one refuses a manifest that is not JSON
      const bytes = manifest.length + (thumb || "").length + layers.reduce((n, l) => n + l.png.length, 0);
      paints.set(path, { manifest, layers: layers.map((l) => ({ ...l })), thumb: thumb || null, bytes });
      let f = mockFiles.find((x) => x.path === path);
      if (!f) { f = { path, size: 0, mtime: Date.now(), kind: "other" }; mockFiles.push(f); }
      Object.assign(f, { size: bytes, mtime: Date.now() });
      setTimeout(() => emit("vault:files", [...mockFiles]), 20);
      return { ...f };
    },
    paint_load: ({ path }) => {
      const d = paints.get(path);
      if (!d) throw new Error("this is not a Leonote drawing (not a zip)");
      return { manifest: d.manifest, layers: d.layers, thumb: d.thumb, bytes: d.bytes };
    },
    paint_inspect: ({ path }) => {
      const d = paints.get(path);
      if (!d) throw new Error("this is not a Leonote drawing (not a zip)");
      const m = JSON.parse(d.manifest);
      return {
        path, format: m.format, version: m.version, width: m.width, height: m.height, dpi: m.dpi,
        layers: (m.layers || []).length, layer_names: (m.layers || []).map((l) => l.name),
        app: m.app || "", created: m.created || "", modified: m.modified || "",
        thumb: d.thumb, bytes: d.bytes, mtime: Date.now(),
      };
    },
    data_dir_set: ({ mode }) => (mode === "user" ? "C:\Users\You\.leonote" : "G:\Vaults\Personal\\" + (mode === "vault" ? "LeoNote" : ".leonote")),
    autostart_set: ({ enabled }) => enabled,
    autostart_repoint: () => true,
    welcome_text: () => "# Welcome to Leonote (mock)",
    rescue_keep: () => null, rescue_drop: () => null, rescue_list: () => [],
    open_url: ({ url }) => { window.open(url, "_blank"); return null; },
    // media libraries outside the vault: a folder of made-up songs, so the
    // Player can be worked on in the browser
    // the sign-in loopback: the browser mock answers as if the user came back
    oauth_listen: ({ state } = {}) => ({ port: 7788, redirect: "http://127.0.0.1:7788/callback" }),
    oauth_wait: () => (window.__mockOauth || { error: "no browser here" }),
    library_add: ({ path }) => api.library_scan({ path }),
    library_scan: ({ path }) => {
      const sep = path.includes("\\") ? "\\" : "/";
      const dir = String(path).replace(/[\\/]+$/, "");
      const base = dir.replace(/\\/g, "/");
      const name = base.slice(base.lastIndexOf("/") + 1) || dir;
      let files = libFiles.get(dir);
      if (!files) {
        files = [
          { path: `${dir}${sep}${name} - Opening.mp3`, name: `${name} - Opening.mp3`, size: 4200000, mtime: Date.now() - 86400000, kind: "media" },
          { path: `${dir}${sep}Second track.mp3`, name: "Second track.mp3", size: 3100000, mtime: Date.now() - 3600000, kind: "media" },
          { path: `${dir}${sep}Live set.mp4`, name: "Live set.mp4", size: 82000000, mtime: Date.now() - 7200000, kind: "media" },
        ];
        libFiles.set(dir, files);
      }
      return { path: dir, name, count: files.length, files, capped: false };
    },
  };

  window.mock = {
    agentTicks() {
      const t = tasks.find((x) => !x.done && !x.deleted);
      if (!t) return;
      t.done = true;
      t.completed_at = stamp();
      emit("tasks:patch", { patch: { [t.id]: { done: true, completed_at: t.completed_at } }, writers: ["hermes"] });
    },
    agentAdds(text = "Investigate flaky sync test") {
      const t = task(text, { priority: "medium" });
      tasks.push(t);
      emit("tasks:patch", { patch: { [t.id]: t }, writers: ["claude-w3"] });
    },
    agentEdits(path = "Welcome.md") {
      const n = notes.get(path);
      const content = n.content.replace("## The essentials", "## The essentials\n- Agents just added this line, live");
      notes.set(path, { path, content, mtime: Date.now() });
      emit("vault:changed", [{ path, content, mtime: Date.now() }]);
    },
    agentCreates() {
      const path = "Ideas/From an agent.md";
      const content = "# From an agent\n\nSummary of tonight's run. #ai\n";
      notes.set(path, { path, content, mtime: Date.now() });
      emit("vault:changed", [{ path, content, mtime: Date.now() }]);
    },
    capture() { emit("app:capture", null); },
    /** A .md double-clicked in Explorer while Leonote is already running. */
    openExternal(path = desk + "Meeting notes.md") { emit("app:open-external", { paths: [path] }); },
    externalPaths: () => [...outside.keys()],
  };

  return {
    real: false,
    mockPath: "C:\Users\you\Documents\LeoNote backup.leonotebackup",
    // a stand-in picture, so image views, embeds and the picture editor have
    // something with real colour in them in the browser mock
    assetAbs: (abs) => blobs.get(abs) || (/.(mp3|flac|mp4|mkv)$/i.test(abs) ? "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=" : ""),
    assetUrl: (rel) => blobs.get(rel) || MOCK_PICTURE,
    // the open dialog: our "from your computer" picker gets a desktop file,
    // anything else (backups) the fixed path
    dialogOpen: (opts = {}) => (opts.directory ? "D:/Media/Lake sessions" : /computer/i.test(opts.title || "") ? desk + "Meeting notes.md" : null),
    invoke: (cmd, args, opts) => {
      if (!api[cmd]) return Promise.reject(`mock: no command ${cmd}`);
      try { return delay(api[cmd](args || {}, opts || {})); } catch (e) { return Promise.reject(String(e)); }
    },
    listen: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return Promise.resolve(() => {});
    },
    win: {
      show: async () => {}, minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, destroy: async () => {},
      isMaximized: async () => false, onResized: async () => () => {}, onCloseRequested: async () => () => {},
      setAlwaysOnTop: async () => {},
      startDragging: async () => {}, unmaximize: async () => {}, scaleFactor: async () => 1,
      setSkipTaskbar: async () => {}, hide: async () => {}, isVisible: async () => true, isMinimized: async () => false, setZoom: async (v) => { document.documentElement.style.zoom = v; },
      outerPosition: async () => ({ toLogical: () => ({ x: 0, y: 0 }) }),
      innerSize: async () => ({ toLogical: () => ({ width: innerWidth, height: innerHeight }) }),
      setSize: async () => {}, setPosition: async () => {}, setFullscreen: async (v) => { v ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.(); }, isFullscreen: async () => !!document.fullscreenElement,
    },
  };
}
