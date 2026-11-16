// The AI home (Alt+0) and its quick box (Ctrl+Shift+A, from anywhere).
//
// One box for anything you want done: as you type it offers what fits - ask
// the chat, run a skill, add a task, make a note, search - and, with a Jev key,
// Jev reads what you typed and puts the likeliest first (Enter takes it).
// Under the box: Chat (the Assistant), Activity (edits waiting, skills run,
// what Jev and agents did), Skills, Access (what agents may do with which
// folders) and Setup (a short checklist of what is connected).

import { h, basename, debounce } from "./util.js";
import { icon } from "./icons.js";
import { mountChatTabs } from "./aitabs.js";

const ROUTES = {
  ask: "a question, or something to think through, write, explain or summarise",
  task: "something to do later - a to-do or a reminder",
  note: "a thought, idea or piece of information to keep",
  search: "looking for something already written in the notes",
};

/** Likeliest first, but a skill never allowed here stays under "Ask the chat": Enter must not land on it. */
export const byLikeliest = (askP, held) => {
  const key = (x) => (held.has(x.id) ? Math.min(x.p || 0, askP) : x.p || 0);
  return (a, b) => key(b) - key(a);
};

/* ── the box ───────────────────────────────────────────────────────────── */

/** The box and the list under it. `onDone()` after an item ran (the popup closes). */
export function quickBox(app, { onDone = () => {}, placeholder = "Ask, do, find… - Enter does the first", folding = false } = {}) {
  const input = h("input", { class: "aq-in", type: "text", placeholder, spellcheck: "false", autocomplete: "off" });
  const list = h("div", { class: "aq-list" });
  const badge = h("span", { class: "aq-jev", hidden: true });
  let items = [];
  let at = 0;
  let ranked = null; // what Jev said for the text now: { text, order: Map(id -> p) }

  const openChat = (prompt) => { app.askAssistant ? app.askAssistant({ prompt }) : app.openView("assistant"); };
  const skillRun = async (s, t) => {
    if (!(await app.skills.confirmOnce(s))) return;
    if (!s.inputs.length) return app.skills.run(s, { text: t }, { trigger: "asked" });
    if (s.inputs.length === 1) return app.skills.run(s, { [s.inputs[0]]: t, text: t }, { trigger: "asked" });
    return app.skills.runAsking(s);
  };

  function candidates(text) {
    const t = text.trim();
    const skills = app.skills ? app.skills.all().filter((s) => !s.errors.length) : [];
    if (!t) {
      const out = [];
      const waiting = app.proposals ? app.proposals.rules && document.querySelector(".sb-proposals:not([hidden])") : null;
      if (waiting) out.push({ id: "review", icon: "check", label: "Review the edits waiting", run: () => app.proposals.review() });
      for (const s of skills.slice(0, 6)) out.push({ id: "skill:" + s.path, icon: "bolt", label: s.name, sub: s.description || "skill", run: () => skillRun(s, "") });
      out.push({ id: "home", icon: "sparkles", label: "Open the AI home", sub: "Alt+0", run: () => app.openView("assistant") });
      return out;
    }
    const words = t.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const hit = (s) => words.some((w) => (s.name + " " + s.description).toLowerCase().includes(w));
    const out = [
      { id: "ask", icon: "sparkles", label: "Ask the chat", sub: t, run: () => openChat(t) },
      ...skills.map((s, i) => ({ id: "skill:" + s.path, icon: "bolt", label: "Run " + s.name, sub: s.description || "skill", run: () => skillRun(s, t), hidden: !hit(s), skill: i })),
      { id: "task", icon: "checkSquare", label: "Add a task", sub: t, run: () => { app.tasks.create(t, { priority: "none" }); app.toast("Task added", { ms: 1600 }); } },
      { id: "note", icon: "filePlus", label: "New note", sub: t, run: () => app.newNote({ name: t.slice(0, 80).replace(/[\\/:*?"<>|]+/g, " ").trim(), newTab: true }) },
      { id: "search", icon: "search", label: "Search the notes", sub: t, run: () => app.openSearch({ query: t }) },
    ];
    // Jev's reading: likeliest first, and a skill it picks shows even when no word matched
    if (ranked && ranked.text === t) {
      for (const it of out) { it.p = ranked.order.get(it.id) || 0; if (it.p >= 0.3) it.hidden = false; }
      out.sort(byLikeliest(ranked.order.get("ask") || 0, ranked.held));
    }
    return out.filter((x) => !x.hidden);
  }

  function paint() {
    items = candidates(input.value);
    at = Math.min(at, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((it, i) => h("button", { class: "aq-item" + (i === at ? " is-on" : ""), onmouseenter: () => { at = i; for (const [k, b] of [...list.children].entries()) b.classList.toggle("is-on", k === i); }, onclick: () => go(i) },
      icon(it.icon), h("span", { class: "aq-label", text: it.label }), it.sub ? h("span", { class: "aq-sub", text: it.sub }) : null,
      it.p ? h("span", { class: "aq-p", text: Math.round(it.p * 100) + "%" }) : null)));
  }
  function go(i) {
    const it = items[i];
    if (!it) return;
    if (it.p && app.jev) app.jev.log(`read “${input.value.trim().slice(0, 60)}” as ${it.label.toLowerCase()} (${Math.round(it.p * 100)}%)`);
    input.value = "";
    ranked = null;
    badge.hidden = true;
    paint();
    onDone();
    it.run();
  }
  // Jev reads the text while you pause typing: one quick question, the routes and every skill as answers
  const rank = debounce(async () => {
    const t = input.value.trim();
    if (!app.jev || !app.jev.ready() || t.split(/\s+/).length < 2) return;
    const skills = app.skills ? app.skills.all().filter((s) => !s.errors.length) : [];
    const crit = { ...ROUTES };
    skills.slice(0, 40).forEach((s) => { crit["skill:" + s.path] = s.description ? { what: s.name, does: s.description } : s.name; });
    try {
      const res = await app.host.jevAsk({ state: t, questions: { route: { type: "choice", instructions: "What does the person want done with what they typed?", criteria: crit } } });
      if (input.value.trim() !== t) return;
      const a = res.answers.route;
      const held = new Set();
      for (const s of skills) if (!(await app.skills.allowed(s))) held.add("skill:" + s.path);
      if (input.value.trim() !== t) return;
      ranked = { text: t, order: new Map(Object.entries(a.probabilities || {})), held };
      badge.hidden = false;
      badge.textContent = `Jev · ${res.latency_ms ?? "?"} ms`;
      at = 0;
      paint();
    } catch { /* no Jev now: the list stays as typed */ }
  }, 350);
  input.addEventListener("input", () => { ranked = null; badge.hidden = true; at = 0; paint(); rank(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); at = Math.min(items.length - 1, at + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); at = Math.max(0, at - 1); paint(); }
    else if (e.key === "Enter") { e.preventDefault(); go(at); }
  });
  paint();
  const el = h("div", { class: "aq" + (folding ? " is-folding" : "") }, h("div", { class: "aq-field" }, icon("sparkles", "aq-lead"), input, badge), list);
  if (folding) {
    const fold = () => el.classList.toggle("is-open", document.activeElement === input || !!input.value.trim());
    input.addEventListener("focus", fold);
    input.addEventListener("input", fold);
    // a click on an item comes before the blur would hide it
    input.addEventListener("blur", () => setTimeout(fold, 150));
    input.addEventListener("keydown", (e) => { if (e.key === "Escape" && input.value) { e.stopPropagation(); input.value = ""; ranked = null; badge.hidden = true; paint(); fold(); } });
  }
  return { el, input, paint, focus: () => input.focus() };
}

/** The quick popup: the box over whatever is open. */
export function openQuick(app) {
  if (document.querySelector(".aq-pop")) { document.querySelector(".aq-pop .aq-in").focus(); return; }
  const back = h("div", { class: "aq-pop-back" });
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const box = quickBox(app, { onDone: close });
  back.append(h("div", { class: "aq-pop" }, box.el, h("div", { class: "aq-foot", text: "↑↓ Enter · Esc · Alt+0 for the AI home" })));
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(back);
  requestAnimationFrame(() => box.focus());
}

/* ── the home ──────────────────────────────────────────────────────────── */

export function mountAiHome(app, el) {
  const S = app.settings;
  const box = quickBox(app, { placeholder: "Ask, do, find… - the chat, a skill, a task, a note, a search (Ctrl+Shift+A anywhere)", folding: true });
  const TABS = [["chat", "Chat"], ["activity", "Activity"], ["skills", "Skills"], ["access", "Access"], ["setup", "Setup"]];
  let tab = TABS.some(([k]) => k === S.aiHomeTab) ? S.aiHomeTab : "chat";
  const tabsEl = h("div", { class: "segmented is-small aih-tabs" });
  const panes = Object.fromEntries(TABS.map(([k]) => [k, h("div", { class: "aih-pane aih-" + k, hidden: true })]));
  el.replaceChildren(h("div", { class: "aih" }, h("div", { class: "aih-top" }, box.el, tabsEl), ...Object.values(panes)));

  // the chat is the Assistant, mounted once, under its own browser-like tabs (aitabs.js)
  const chatTabs = mountChatTabs(app, panes.chat);
  const chatReady = chatTabs.ready;

  function paintTabs() {
    // the one shown is said (not only coloured), and a tab pressed from the keyboard keeps the focus
    const had = [...tabsEl.children].indexOf(document.activeElement); // the tab the keyboard is on, by place
    tabsEl.replaceChildren(...TABS.map(([k, label]) => h("button", { class: "seg" + (k === tab ? " is-active" : ""), "aria-pressed": String(k === tab), onclick: () => setTab(k) }, label, k === "activity" && waiting ? h("span", { class: "aih-dot", text: String(waiting) }) : null)));
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== tab;
    if (had >= 0 && tabsEl.children[had]) tabsEl.children[had].focus();
  }
  function setTab(k) { tab = k; app.setSetting("aiHomeTab", k); paintTabs(); paintPane(); }
  let waiting = 0;
  app.bus.on("proposals", (n) => { waiting = n; paintTabs(); if (tab === "activity") paintPane(); });

  const ago = (t) => { const s = (Date.now() - new Date(t)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : new Date(t).toLocaleDateString(); };

  async function paintActivity() {
    const p = panes.activity;
    let props = [];
    try { props = await app.host.proposalsList(); } catch {}
    const rows = [
      ...(S.skillRuns || []).map((r) => ({ at: r.at, icon: "bolt", text: `${r.name}: ${r.ok ? "done" : "stopped"}${r.proposals ? ` · ${r.proposals} edit${r.proposals === 1 ? "" : "s"} proposed` : ""}`, sub: r.trigger, run: () => app.skills.panel(r.path) })),
      ...(S.jevLog || []).map((r) => ({ at: r.at, icon: "sparkles", text: "Jev " + r.text, sub: "Jev" })),
      ...(app.activity || []).map((r) => ({ at: r.at, icon: "brain", text: `${r.by}: ${r.text}`, sub: "agent", run: r.path ? () => app.openNote(r.path, { newTab: true }) : null })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 80);
    p.replaceChildren(
      h("div", { class: "aih-sec" },
        h("div", { class: "aih-sec-head" }, h("b", { text: props.length ? `${props.length} edit${props.length === 1 ? "" : "s"} waiting for you` : "No edits waiting" }), h("span", { class: "fit-fill" }), props.length ? h("button", { class: "btn btn-primary", onclick: () => app.proposals.review() }, "Review") : null),
        ...props.slice(0, 8).map((x) => h("button", { class: "aih-row", onclick: () => app.proposals.review() }, icon("edit"), h("span", { class: "aih-row-text", text: x.path }), h("span", { class: "aih-row-sub", text: `${x.agent} · ${x.kind === "append" ? "adds" : x.now == null ? "new" : "rewrites"}` })))),
      h("div", { class: "aih-sec" },
        h("div", { class: "aih-sec-head" }, h("b", { text: "What happened" })),
        ...(rows.length ? rows.map((r) => h(r.run ? "button" : "div", { class: "aih-row", onclick: r.run || null }, icon(r.icon), h("span", { class: "aih-row-text", text: r.text }), h("span", { class: "aih-row-sub", text: `${r.sub} · ${ago(r.at)}` })))
          : [h("div", { class: "aih-empty", text: "Nothing yet - skills run, Jev's decisions and agents' edits show here." })])));
  }

  function paintSkills() {
    const p = panes.skills;
    const body = h("div", { class: "sk-list" });
    p.replaceChildren(h("div", { class: "aih-sec-head" }, h("b", { text: "Skills - notes that do things" }), h("span", { class: "fit-fill" }),
      h("button", { class: "btn", onclick: () => app.skills.ask() }, icon("sparkles"), "Ask…"),
      h("button", { class: "btn", onclick: () => app.skills.newSkill() }, icon("plus"), "New skill")), body);
    app.skills.listInto(body);
  }

  function paintAccess() {
    const p = panes.access;
    const rules = app.proposals ? app.proposals.rules() : { default: "review", folders: {} };
    const MODES = [["private", "Private", "not seen"], ["review", "Review", "changes wait for you"], ["open", "Open", "written at once"]];
    const seg = (now, pick) => h("div", { class: "segmented is-small" }, ...MODES.map(([v, label, hint]) => h("button", { class: "seg" + (now === v ? " is-active" : ""), title: hint, onclick: () => pick(v) }, label)));
    const set = async (f, m) => { await app.proposals.setAccess(f, m); paintAccess(); };
    p.replaceChildren(
      h("p", { class: "aih-note", text: "What AI agents and skills may do with your notes. A folder's setting covers what is in it; a note can say for itself with ai: private at its top. Private folders show a lock in the tree." }),
      h("div", { class: "aih-sec" }, h("div", { class: "aih-sec-head" }, h("b", { text: "Every note, unless its folder says" }), h("span", { class: "fit-fill" }), seg(rules.default || "review", (m) => set("", m)))),
      h("div", { class: "aih-sec" },
        h("div", { class: "aih-sec-head" }, h("b", { text: "Folders" }), h("span", { class: "fit-fill" }),
          h("button", { class: "btn", onclick: () => app.palette("move", { onPick: (f) => { if (f) set(f, "private"); } }) }, icon("folderPlus"), "Add a folder…")),
        ...Object.entries(rules.folders || {}).sort().map(([f, m]) => h("div", { class: "aih-row" }, icon(m === "private" ? "lock" : "folder"), h("span", { class: "aih-row-text", text: f }), seg(m, (v) => set(f, v)),
          h("button", { class: "icon-btn", title: "As its parent", onclick: () => set(f, null) }, icon("x")))),
        !Object.keys(rules.folders || {}).length ? h("div", { class: "aih-empty", text: "No folder has its own setting. Right-click one in the tree, or add it here." }) : null));
  }

  async function paintSetup() {
    const p = panes.setup;
    const c = await chatReady;
    const using = c.using ? c.using() : null;
    const jev = app.jev && app.jev.hasKey();
    let mcp = null;
    try { mcp = await app.host.mcpCommand(); } catch {}
    const step = (done, title, text, ...btns) => h("div", { class: "aih-step" + (done ? " is-done" : "") }, h("span", { class: "aih-step-mark" }, icon(done ? "check" : "plus")),
      h("div", { class: "aih-step-body" }, h("b", { text: title }), h("div", { class: "aih-row-sub", text })), h("div", { class: "aih-step-btns" }, ...btns));
    const copy = (t, what) => navigator.clipboard.writeText(t).then(() => app.toast(`${what} copied`, { ms: 1600 }));
    p.replaceChildren(
      h("p", { class: "aih-note", text: "Three things to connect - each on its own, none needed for the rest of Leonote." }),
      step(!!using, "A chat model", using ? `${using.name}${using.model ? " · " + using.model : ""}` : "Claude, GPT, Gemini… with your key - or Claude Code / a local model with none.",
        h("button", { class: "btn btn-primary", onclick: () => { setTab("chat"); c.setup(true); } }, using ? "Change" : "Choose")),
      step(jev, "Jev - fast decisions", jev ? "Connected: tasks get sorted, the box puts the likeliest first, skills can decide." : "Optional. Sorts new tasks, reads what you type in the box, makes decisions in skills.",
        h("button", { class: "btn" + (jev ? "" : " btn-primary"), onclick: () => app.openSettingsAt && app.openSettingsAt("Jev") }, jev ? "Settings" : "Add the key"),
        h("button", { class: "btn", onclick: () => app.jev.playground() }, "Playground")),
      step(!!mcp, "Agents in your notes (MCP)", "Claude Code, Claude Desktop, Cursor… search, read and propose edits to your notes, and use Jev through your key.",
        mcp ? h("button", { class: "btn", onclick: () => copy(`claude mcp add leonote -- "${mcp.command}" ${mcp.args.join(" ")}`, "Claude Code command") }, "Copy for Claude Code") : null,
        mcp ? h("button", { class: "btn", onclick: () => copy(JSON.stringify({ mcpServers: { leonote: { command: mcp.command, args: mcp.args } } }, null, 2), "Config") }, "Copy config") : null),
      step(true, "Who may change what", "Agents and skills propose changes; private folders stay out of reach.", h("button", { class: "btn", onclick: () => setTab("access") }, "Access")));
  }

  function paintPane() {
    if (tab === "activity") paintActivity();
    else if (tab === "skills") paintSkills();
    else if (tab === "access") paintAccess();
    else if (tab === "setup") paintSetup();
  }
  app.bus.on("ai-activity", () => { if (tab === "activity") paintActivity(); });
  app.bus.on("aiaccess", () => { if (tab === "access") paintAccess(); });
  paintTabs();
  paintPane();

  return {
    // the tab asked for from elsewhere (Home's "How to connect one" opens Setup)
    show() { if (S.aiHomeTab !== tab && TABS.some(([k]) => k === S.aiHomeTab)) tab = S.aiHomeTab; paintTabs(); paintPane(); if (tab === "chat") chatReady.then((c) => c.show()); else requestAnimationFrame(() => box.focus()); },
    ask(o) { setTab("chat"); chatReady.then((c) => c.ask(o)); },
    /** A project room's chat: its group, the chat asked for, and maybe a question. */
    // a thread carried over from elsewhere gets a chat of its own: the open one is kept as it is
    adopt(m) { setTab("chat"); chatReady.then((c) => { chatTabs.newThread(); c.adopt(m); c.show(); }); },
    project(o) { setTab("chat"); chatReady.then((c) => { chatTabs.forProject(o); c.show(); if (o.prompt) c.ask({ prompt: o.prompt }); }); },
    tab: setTab,
  };
}
