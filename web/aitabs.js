// The chat's tabs, like a browser's: one conversation each, pinned ones first,
// groups with a colour and a name (a group is a project - notes kept with it go
// along with every chat in it), dragged anywhere, into a group or out of one.
// The overview shows every chat, open and closed, by project, and finds a chat
// by anything said in it. Kept in settings: aiThreads, aiThreadGroups,
// aiThreadsClosed (30), aiThread. The strip's rules are the space tabs' own
// (tabgroups.js).

import { h, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu } from "./ui.js";
import { normalize, stripItems, makeGroup, addToNewGroup, addToGroup, removeFromGroup, ungroup, dropPlan, applyDrop, groupDropSlot, moveGroup, editGroup, colorVar, groupRange } from "./tabgroups.js";

const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const textOf = (c) => (typeof c === "string" ? c : (c || []).map((p) => p.text || "").join(" "));
const titleOf = (msgs) => { const u = msgs.find((m) => m.role === "user"); return (u ? textOf(u.content) : "").replace(/\s+/g, " ").trim().slice(0, 40); };
// what is kept of a message: its words and where they came from - not pictures sent along, not raw replies
const keep = (m) => {
  const o = {};
  for (const k of ["role", "content", "model", "who", "sources", "error", "stop", "tool_call_id", "is_error", "tool_calls", "steps", "path", "provider", "tainted"]) if (m[k] !== undefined) o[k] = m[k];
  if (Array.isArray(o.content)) o.content = o.content.filter((p) => p && p.type === "text");
  if (typeof o.content === "string" && o.content.length > 60000) o.content = o.content.slice(0, 60000);
  return o;
};
/**
 * A project's chat (the room's dock and the AI home share it): the group bound to
 * its folder, made the first time with its notes kept, and in it the chat asked
 * for (a closed one comes back), the newest one, or a new one. Gives its id.
 */
export function projectThread(app, { folder, name, notes = [], open = null, fresh = false, provider = null }) {
  const S = app.settings;
  const tabs = (Array.isArray(S.aiThreads) ? S.aiThreads : []).map((t) => ({ ...t }));
  const groups = (Array.isArray(S.aiThreadGroups) ? S.aiThreadGroups : []).map((g) => ({ ...g }));
  let g = groups.find((x) => x.project === folder);
  if (!g) { g = { ...makeGroup(groups, { name }), project: folder, notes: [] }; groups.push(g); }
  g.notes = [...new Set([...(g.notes || []), ...notes])];
  const atEnd = (t) => { const r = groupRange(tabs, g.id); tabs.splice(r ? r.end : tabs.length, 0, t); };
  let t = open ? tabs.find((x) => x.id === open) : null;
  if (open && !t) {
    const c = (S.aiThreadsClosed || []).find((x) => x.id === open);
    if (c) { app.setSetting("aiThreadsClosed", S.aiThreadsClosed.filter((x) => x.id !== open)); t = { ...c, group: g.id }; delete t.closedAt; atEnd(t); }
  }
  if (!t && !fresh) t = tabs.filter((x) => x.group === g.id).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  if (!t) { t = { id: newId(), title: "", msgs: [], at: Date.now(), group: g.id, provider }; atEnd(t); }
  app.setSetting("aiThreads", normalize(tabs, groups).tabs);
  app.setSetting("aiThreadGroups", groups);
  return t.id;
}
/** A chat's messages kept into its tab (what is kept of each: its words and where they came from). */
export function saveThread(app, id, msgs, extra = {}) {
  const kept = msgs.filter((m) => !m.live).slice(-120).map(keep);
  app.setSetting("aiThreads", (app.settings.aiThreads || []).map((t) => (t.id === id ? { ...t, msgs: kept, title: t.named ? t.title : kept.length ? titleOf(kept) || t.title : "", at: Date.now(), ...extra } : t)));
}

const ago = (t) => { if (!t) return ""; const s = (Date.now() - new Date(t)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : new Date(t).toLocaleDateString(); };

/** Where a search hits a chat: a few words around the first match, or null. */
export function chatHit(t, q) {
  q = q.trim().toLowerCase();
  if (!q) return "";
  if ((t.title || "").toLowerCase().includes(q)) return "";
  for (const m of t.msgs || []) {
    const s = textOf(m.content);
    const i = s.toLowerCase().indexOf(q);
    if (i >= 0) return (i > 40 ? "…" : "") + s.slice(Math.max(0, i - 40), i + q.length + 60).replace(/\s+/g, " ") + "…";
  }
  return null;
}

export function mountChatTabs(app, pane) {
  const S = app.settings;
  const bar = h("div", { class: "aih-threads" });
  const host = h("div", { class: "aih-chat-host" });
  const over = h("div", { class: "aih-over", hidden: true });
  pane.append(bar, host, over);
  // a row above the chat, a list beside it, or out of sight (right-click the bar)
  const side = () => pane.dataset.tabs === "side";
  const placeTabs = () => { pane.dataset.tabs = ["side", "hidden"].includes(S.aiThreadsMode) ? S.aiThreadsMode : "row"; };
  placeTabs();

  let chat = null;
  if (!Array.isArray(S.aiThreads) || !S.aiThreads.length) app.setSetting("aiThreads", [{ id: newId(), title: "", msgs: [] }]);
  // copies: the strip's rules change tabs in place
  const state = () => ({
    tabs: S.aiThreads.map((t) => ({ ...t })),
    groups: (Array.isArray(S.aiThreadGroups) ? S.aiThreadGroups : []).map((g) => ({ ...g })),
  });
  const closed = () => (Array.isArray(S.aiThreadsClosed) ? S.aiThreadsClosed : []);
  let cur = state().tabs.some((t) => t.id === S.aiThread) ? S.aiThread : state().tabs[0].id;
  // a group outlives its last open chat while closed chats or notes still belong to it - it is a project
  let mine = false;
  function commit(tabs, groups) {
    mine = true;
    const n = normalize(tabs, groups);
    const kept = groups.filter((g) => n.groups.includes(g) || (g.notes && g.notes.length) || closed().some((t) => t.group === g.id));
    app.setSetting("aiThreads", n.tabs);
    app.setSetting("aiThreadGroups", kept);
    mine = false;
    paint();
    if (!over.hidden) paintOver();
  }
  const groupById = (id) => state().groups.find((g) => g.id === id) || null;
  const curTab = () => state().tabs.find((t) => t.id === cur) || null;

  // the chat on screen into its tab - none while a switch is half done (cur null) or its tab is gone
  function saveNow() {
    if (!chat || !cur) return;
    // started over elsewhere while this one was answering: nothing of it is kept, and once
    // the answer is done the chat empties here too
    const t0 = curTab();
    if (t0 && (t0.cleared || 0) > cleared) {
      if (!chat.busy()) { cleared = t0.cleared; chat.adopt(t0.msgs || []); }
      return;
    }
    const msgs = chat.messages().filter((m) => !m.live).slice(-120).map(keep);
    const { tabs, groups } = state();
    const t = tabs.find((x) => x.id === cur);
    if (!t) return;
    Object.assign(t, { msgs, title: t.named ? t.title : titleOf(msgs) || t.title, at: Date.now() });
    commit(tabs, groups);
  }
  const saveSoon = debounce(saveNow, 700);
  let cleared = 0;
  function switchTo(id) {
    if (id === cur) return;
    saveNow();
    cur = id;
    app.setSetting("aiThread", id);
    const t = curTab();
    cleared = (t && t.cleared) || 0;
    chat.useProvider(t && t.provider);
    chat.adopt(t ? t.msgs : []);
    chat.projectChanged();
    paint();
  }
  const patch = (id, o) => { const { tabs, groups } = state(); const t = tabs.find((x) => x.id === id); if (t) Object.assign(t, o); commit(tabs, groups); };

  /* ── opening, closing ── */
  // a new chat sits right after the one you are in, in its group: a project grows where you work
  function newThread({ group } = {}) {
    saveNow();
    const { tabs, groups } = state();
    const at = tabs.findIndex((t) => t.id === cur);
    const here = tabs[at];
    const t = { id: newId(), title: "", msgs: [], at: Date.now(), provider: (here && here.provider) || null };
    const g = group !== undefined ? group : here && !here.pinned ? here.group : null;
    if (g) { const r = groupRange(tabs, g); t.group = g; tabs.splice(r ? r.end : tabs.length, 0, t); }
    else tabs.splice(at < 0 ? tabs.length : at + 1, 0, t);
    commit(tabs, groups);
    cur = null;
    switchTo(t.id);
    if (!over.hidden) toggleOver(false);
  }
  function closeThread(id) {
    saveNow();
    const { tabs, groups } = state();
    const i = tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [t] = tabs.splice(i, 1);
    if (t.msgs && t.msgs.length) app.setSetting("aiThreadsClosed", [{ ...t, closedAt: Date.now() }, ...closed().filter((x) => x.id !== t.id)].slice(0, 30));
    if (!tabs.length) tabs.push({ id: newId(), title: "", msgs: [] });
    commit(tabs, groups);
    if (id === cur) { cur = null; switchTo(tabs[Math.max(0, i - 1)].id); }
  }
  function reopen(t) {
    saveNow();
    app.setSetting("aiThreadsClosed", closed().filter((x) => x.id !== t.id));
    const { tabs, groups } = state();
    const back = { ...t };
    delete back.closedAt;
    const r = back.group && groupRange(tabs, back.group);
    if (back.group && !groups.some((g) => g.id === back.group)) delete back.group;
    tabs.splice(r ? r.end : tabs.length, 0, back);
    commit(tabs, groups);
    cur = null;
    switchTo(back.id);
  }
  const openChat = (id) => { if (state().tabs.some((t) => t.id === id)) switchTo(id); else { const t = closed().find((x) => x.id === id); if (t) reopen(t); } };

  /* ── names, models, pins, groups ── */
  function rename(t, el) {
    const span = el.querySelector(".aih-thread-t");
    if (!span) return;
    const inp = h("input", { class: "input aih-thread-in", value: t.title || "" });
    span.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const end = (ok) => { if (done) return; done = true; const v = inp.value.trim(); if (ok && v !== (t.title || "")) patch(t.id, { title: v, named: !!v }); else paint(); };
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") end(true); if (e.key === "Escape") end(false); });
    inp.addEventListener("blur", () => end(true));
  }
  function forEvery(id) {
    const { tabs, groups } = state();
    for (const t of tabs) t.provider = id;
    commit(tabs, groups);
    app.setSetting("aiProvider", id);
    chat.useProvider(id);
    app.toast("Every chat answers with " + ((chat.providers().find((p) => p.id === id) || {}).who || "it"), { ms: 2200 });
  }
  const chipOf = (gid) => bar.querySelector(`.tg-chip[data-group="${gid}"]`);
  function nameGroup(gid, title = "") {
    const g = groupById(gid);
    const chip = chipOf(gid);
    if (!g || !chip) return;
    editGroup(chip.getBoundingClientRect(), g, { title, onChange: () => { const { tabs, groups } = state(); commit(tabs, groups.map((x) => (x.id === g.id ? { ...x, name: g.name, color: g.color } : x))); } });
  }
  function toNewGroup(id) {
    const { tabs, groups } = state();
    const g = makeGroup(groups);
    const n = addToNewGroup(tabs, groups, tabs.findIndex((t) => t.id === id), g);
    commit(n.tabs, n.groups);
    requestAnimationFrame(() => nameGroup(g.id, "New project"));
  }
  function tabMenu(t, e) {
    e.preventDefault();
    const { tabs, groups } = state();
    const i = tabs.findIndex((x) => x.id === t.id);
    const provs = chat ? chat.providers() : [];
    const own = t.provider && provs.some((p) => p.id === t.provider) ? t.provider : null;
    const others = groups.filter((g) => g.id !== t.group);
    const el = e.currentTarget;
    menu(e.clientX, e.clientY, [
      { label: "Rename", icon: "edit", run: () => rename(t, el) },
      { label: t.pinned ? "Unpin" : "Pin", icon: "pin", run: () => { tabs[i].pinned = !t.pinned; commit(tabs, groups); } },
      "sep",
      t.pinned ? null : { label: "Add to a new group", icon: "layers", run: () => toNewGroup(t.id) },
      !t.pinned && others.length ? { label: "Add to group", icon: "layers", sub: others.map((g) => ({ label: g.name || "Unnamed group", run: () => { const n = addToGroup(tabs, groups, i, g.id); commit(n.tabs, n.groups); } })) } : null,
      t.group ? { label: "Remove from group", icon: "x", run: () => { const n = removeFromGroup(tabs, groups, i); commit(n.tabs, n.groups); } } : null,
      "sep",
      provs.length ? { label: "Model for this chat", icon: "sparkles", sub: [
        { label: "The one in use everywhere", checked: !own, run: () => { patch(t.id, { provider: null }); if (t.id === cur) chat.useProvider(null); } },
        "sep",
        ...provs.map((p) => ({ label: p.label, checked: own === p.id, run: () => { patch(t.id, { provider: p.id }); if (t.id === cur) chat.useProvider(p.id); } }))] } : null,
      provs.length ? { label: "Use this chat's model in every chat", icon: "sparkles", run: () => forEvery(t.provider || (provs[0] || {}).id) } : null,
      "sep",
      { label: "Close", icon: "x", run: () => closeThread(t.id) },
      tabs.length > 1 ? { label: "Close the others", icon: "x", run: () => { for (const x of tabs) if (x.id !== t.id && !x.pinned) closeThread(x.id); } } : null,
    ].filter(Boolean).filter((x, k, a) => !(x === "sep" && (k === 0 || k === a.length - 1 || a[k - 1] === "sep"))));
  }
  function groupMenu(g, e) {
    e.preventDefault();
    const { tabs, groups } = state();
    menu(e.clientX, e.clientY, [
      { label: "Name and colour…", icon: "edit", run: () => nameGroup(g.id) },
      { label: "New chat in this group", icon: "plus", run: () => newThread({ group: g.id }) },
      { label: "Show the project", icon: "grid", run: () => toggleOver(true, g.id) },
      { label: g.collapsed ? "Expand" : "Collapse", icon: "chevronDown", run: () => collapse(g.id) },
      "sep",
      { label: "Ungroup", icon: "layers", run: () => { const n = ungroup(tabs, groups, g.id); commit(n.tabs, n.groups); } },
      { label: "Close the group", icon: "x", run: () => { for (const t of tabs) if (t.group === g.id) closeThread(t.id); } },
    ]);
  }
  function collapse(gid) {
    const { tabs, groups } = state();
    const g = groups.find((x) => x.id === gid);
    if (!g) return;
    g.collapsed = !g.collapsed;
    commit(tabs, groups);
    // the chat you are in stays in view; a collapsed group shows only it
  }

  /* ── the strip ── */
  const providerName = (t) => (t.provider && chat ? (chat.providers().find((p) => p.id === t.provider) || {}).who || "" : "");
  function tabEl(t, i) {
    return h("div", {
      class: "aih-thread" + (t.id === cur ? " is-on" : "") + (t.pinned ? " is-pinned" : ""), dataset: { id: t.id, i: String(i) }, draggable: true,
      title: (t.title || "New chat") + (providerName(t) ? " · " + providerName(t) : "") + "\nDouble-click to rename · drag to move or into a group · right-click for more",
      onclick: (e) => { if (!e.target.closest(".aih-thread-x, input")) switchTo(t.id); },
      ondblclick: (e) => { if (!e.target.closest(".aih-thread-x, input")) rename(t, e.currentTarget); },
      onauxclick: (e) => { if (e.button === 1 && !t.pinned) closeThread(t.id); },
      oncontextmenu: (e) => tabMenu(t, e),
    },
      icon(t.pinned ? "pin" : "sparkles"), h("span", { class: "aih-thread-t", text: t.title || "New chat" }),
      t.pinned ? null : h("button", { class: "aih-thread-x", title: "Close this chat (the overview keeps it)", onclick: () => closeThread(t.id) }, icon("x")));
  }
  function paint() {
    const { tabs, groups } = state();
    const out = [];
    for (const it of stripItems(tabs, groups)) {
      if (it.kind === "tab") { out.push(tabEl(tabs[it.index], it.index)); continue; }
      const g = it.group;
      const named = !!(g.name || "").trim();
      const chip = h("div", { class: "tg-chip aih-chip" + (g.collapsed ? " is-collapsed" : "") + (named ? "" : " is-bare"), dataset: { group: g.id }, draggable: true,
        title: `${named ? g.name : "A group"} · ${it.tabs.length} chat${it.tabs.length === 1 ? "" : "s"}${(g.notes || []).length ? ` · ${g.notes.length} note${g.notes.length === 1 ? "" : "s"} go along` : ""}\nClick to ${g.collapsed ? "open" : "fold"} it, right-click for more`,
        onclick: () => collapse(g.id), oncontextmenu: (e) => groupMenu(g, e) },
        h("span", { class: "tg-dot" }), named ? h("span", { class: "tg-label", text: g.name }) : null, g.collapsed ? h("span", { class: "tg-count", text: String(it.tabs.length) }) : null);
      out.push(h("div", { class: "aih-tg" + (g.collapsed ? " is-collapsed" : ""), style: `--gc:${colorVar(g.color)}` },
        chip, ...it.tabs.filter((i) => !g.collapsed || tabs[i].id === cur).map((i) => tabEl(tabs[i], i))));
    }
    bar.replaceChildren(...out,
      h("button", { class: "icon-btn aih-new", title: "New chat (in the group you are in)", onclick: () => newThread() }, icon("plus")),
      h("span", { class: "aih-gap" }),
      h("button", { class: "icon-btn" + (over.hidden ? "" : " is-on"), title: "Every chat by project - and a search through all of them", onclick: () => toggleOver() }, icon("grid")));
  }

  /* ── dragging: a tab anywhere (over a grouped tab joins its group), a group chip with its tabs ── */
  let drag = null; // { tab: index } | { group: id }
  const clearMarks = () => bar.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-into, .is-dragging").forEach((x) => x.classList.remove("is-drop-before", "is-drop-after", "is-drop-into", "is-dragging"));
  function overOf(e) {
    const tabEl = e.target.closest(".aih-thread");
    if (tabEl) { const r = tabEl.getBoundingClientRect(); return { el: tabEl, o: { tab: +tabEl.dataset.i, after: side() ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2 } }; }
    const chip = e.target.closest(".tg-chip");
    if (chip) { const r = chip.getBoundingClientRect(); return { el: chip, o: { chip: chip.dataset.group, x: side() ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width } }; }
    return { el: null, o: { end: true } };
  }
  bar.addEventListener("dragstart", (e) => {
    const t = e.target.closest(".aih-thread"), chip = e.target.closest(".tg-chip");
    if (t) drag = { tab: +t.dataset.i }; else if (chip) drag = { group: chip.dataset.group }; else return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
    requestAnimationFrame(() => (t || chip.parentElement).classList.add("is-dragging"));
  });
  bar.addEventListener("dragover", (e) => {
    if (!drag) return;
    e.preventDefault();
    bar.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-into").forEach((x) => x.classList.remove("is-drop-before", "is-drop-after", "is-drop-into"));
    const { el, o } = overOf(e);
    if (!el) return;
    if (o.chip && drag.tab != null && o.x >= 0.3) el.classList.add("is-drop-into");
    else el.classList.add(o.after || (o.chip && o.x > 0.5) ? "is-drop-after" : "is-drop-before");
  });
  bar.addEventListener("dragend", () => { drag = null; clearMarks(); });
  bar.addEventListener("drop", (e) => {
    if (!drag) return;
    e.preventDefault();
    const { o } = overOf(e);
    const { tabs, groups } = state();
    let n;
    if (drag.tab != null) { if (o.tab === drag.tab) n = null; else n = applyDrop(tabs, groups, drag.tab, dropPlan(tabs, groups, drag.tab, o)); }
    else n = moveGroup(tabs, groups, drag.group, groupDropSlot(tabs, groups, drag.group, o));
    drag = null;
    clearMarks();
    if (n) commit(n.tabs, n.groups);
  });
  bar.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".aih-thread, .tg-chip")) return;
    e.preventDefault();
    const mode = pane.dataset.tabs;
    menu(e.clientX, e.clientY, [
      ...[["row", "Chat tabs in a row"], ["side", "Chat tabs in a list beside the chat"], ["hidden", "Hide the chat tabs"]].map(([k, label]) => ({ label, checked: mode === k, run: () => { app.setSetting("aiThreadsMode", k); placeTabs(); paint(); } })),
      "sep",
      { label: "New chat", icon: "plus", run: () => newThread({ group: null }) },
      { label: "Every chat by project", icon: "grid", run: () => toggleOver(true) },
    ]);
  });

  /* ── the overview: every chat, by project ── */
  let query = "";
  let focusGroup = null;
  const search = h("input", { class: "input aih-over-q", placeholder: "Find a chat by anything said in it…", spellcheck: false });
  search.addEventListener("input", () => { query = search.value; paintOver(); });
  over.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); toggleOver(false); } });
  function toggleOver(on = over.hidden, gid = null) {
    over.hidden = !on;
    host.hidden = on;
    focusGroup = gid;
    paint();
    if (on) { paintOver(); requestAnimationFrame(() => { const sec = gid && over.querySelector(`[data-group="${gid}"]`); if (sec) sec.scrollIntoView({ block: "start" }); search.focus(); }); }
    else if (chat) chat.show();
  }
  let dragCard = null;
  function card(t, open) {
    const hit = chatHit(t, query);
    if (hit === null) return null;
    const last = [...(t.msgs || [])].reverse().find((m) => m.role === "assistant" && textOf(m.content));
    const n = (t.msgs || []).filter((m) => m.role === "user").length;
    return h("button", { class: "aih-card" + (t.id === cur ? " is-on" : "") + (open ? "" : " is-closed"), draggable: true, dataset: { id: t.id },
      onclick: () => { openChat(t.id); toggleOver(false); }, ondragstart: () => { dragCard = t.id; } },
      h("div", { class: "aih-card-top" }, t.pinned ? icon("pin") : null, h("b", { text: t.title || "New chat" })),
      h("div", { class: "aih-card-text", text: hit || (last ? textOf(last.content).replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").slice(0, 140) : "Nothing said yet") }),
      h("div", { class: "aih-card-sub", text: [providerName(t) || (last && last.who) || "", n ? `${n} question${n === 1 ? "" : "s"}` : "", open ? "" : "closed", ago(t.closedAt || t.at)].filter(Boolean).join(" · ") }));
  }
  // a card dropped on a project joins it; on "Other chats" leaves it
  function dropInto(sec, gid) {
    sec.addEventListener("dragover", (e) => { if (dragCard) { e.preventDefault(); sec.classList.add("is-drop"); } });
    sec.addEventListener("dragleave", () => sec.classList.remove("is-drop"));
    sec.addEventListener("drop", (e) => {
      sec.classList.remove("is-drop");
      if (!dragCard) return;
      e.preventDefault();
      const id = dragCard;
      dragCard = null;
      const { tabs, groups } = state();
      const i = tabs.findIndex((t) => t.id === id);
      if (i >= 0) {
        tabs[i].pinned = false;
        let n;
        if (!gid) n = removeFromGroup(tabs, groups, i);
        else if (groupRange(tabs, gid)) n = addToGroup(tabs, groups, i, gid);
        else { tabs[i].group = gid; n = { tabs }; }
        commit(n.tabs, groups);
      } else {
        app.setSetting("aiThreadsClosed", closed().map((t) => (t.id === id ? { ...t, group: gid || undefined } : t)));
        paintOver();
      }
    });
    return sec;
  }
  function setNotes(gid, notes) { const { tabs, groups } = state(); commit(tabs, groups.map((g) => (g.id === gid ? { ...g, notes } : g))); if (chat) chat.projectChanged(); }
  function paintOver() {
    const { tabs, groups } = state();
    const gone = closed();
    const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    const here = app.lastNotePath && app.lastNotePath();
    const section = (gid, head, list, extra) => {
      const cards = list.map(([t, open]) => card(t, open)).filter(Boolean);
      if (!cards.length && query && !extra) return null;
      return dropInto(h("section", { class: "aih-proj", dataset: { group: gid || "" } }, head, extra || null,
        h("div", { class: "aih-cards" }, ...cards, cards.length ? null : h("div", { class: "aih-empty", text: query ? "No chat here says that." : "No chats yet." }))), gid);
    };
    const projects = groups.map((g) => {
      const notes = (g.notes || []).filter((p) => app.vault.notes.has(p));
      const head = h("div", { class: "aih-proj-head", style: `--gc:${colorVar(g.color)}` },
        h("span", { class: "tg-dot" }), h("b", { text: g.name || "Unnamed group" }), h("span", { class: "fit-fill" }),
        h("button", { class: "btn btn-sm", onclick: () => newThread({ group: g.id }) }, icon("plus"), "New chat here"),
        g.project ? h("button", { class: "btn btn-sm", title: g.project, onclick: () => app.openRoom(g.project) }, icon("briefcase"), "Workspace room") : null,
        h("button", { class: "icon-btn", title: "Name and colour", onclick: () => { toggleOver(false); requestAnimationFrame(() => nameGroup(g.id)); } }, icon("edit")));
      const noteRow = h("div", { class: "aih-proj-notes" },
        h("span", { class: "aih-proj-label", text: notes.length ? "Goes with every chat here:" : "Notes kept with a project go along with every chat in it." }),
        ...notes.map((p) => h("span", { class: "ai-chip is-on" }, icon("fileText"), h("span", { text: nameOf(p), onclick: () => app.openNote(p, { newTab: true }) }), h("button", { class: "aih-x", title: "Stop sending it along", onclick: () => setNotes(g.id, notes.filter((x) => x !== p)) }, icon("x")))),
        here && !notes.includes(here) ? h("button", { class: "ai-chip is-add", title: "Keep the note you were last in with this project", onclick: () => setNotes(g.id, [...notes, here]) }, icon("plus"), nameOf(here)) : null);
      return section(g.id, head, [...tabs.filter((t) => t.group === g.id).map((t) => [t, true]), ...gone.filter((t) => t.group === g.id).map((t) => [t, false])], noteRow);
    });
    const known = new Set(groups.map((g) => g.id));
    const loose = [...tabs.filter((t) => !t.group || !known.has(t.group)).map((t) => [t, true]), ...gone.filter((t) => !t.group || !known.has(t.group)).map((t) => [t, false])];
    over.replaceChildren(
      h("div", { class: "aih-over-top" }, icon("search"), search, h("button", { class: "btn", onclick: () => { const { tabs, groups } = state(); const g = makeGroup(groups, { name: "New project" }); const t = { id: newId(), title: "", msgs: [], at: Date.now(), group: g.id }; tabs.push(t); commit(tabs, [...groups, g]); cur = null; switchTo(t.id); toggleOver(false); requestAnimationFrame(() => nameGroup(g.id, "New project")); } }, icon("layers"), "New project"),
        h("button", { class: "icon-btn", title: "Back to the chat (Esc)", onclick: () => toggleOver(false) }, icon("x"))),
      ...projects.filter(Boolean),
      section(null, h("div", { class: "aih-proj-head" }, h("b", { text: groups.length ? "Other chats" : "Chats" }), h("span", { class: "aih-proj-label", text: groups.length ? "drag a chat onto a project to file it" : "right-click a chat tab › Add to a new group to start a project" })), loose));
    if (focusGroup) over.querySelector(`[data-group="${focusGroup}"]`)?.classList.add("is-focus");
  }

  /* ── the chat itself ── */
  // notes kept with the group the chat is in go along with every question
  const project = () => { const t = curTab(); const g = t && t.group ? groupById(t.group) : null; return g ? { name: g.name || "this group", notes: (g.notes || []).filter((p) => app.vault.notes.has(p)) } : null; };
  const keepWithProject = (path, add) => {
    const t = curTab();
    if (!t || !t.group) return;
    const g = groupById(t.group);
    const notes = (g.notes || []).filter((p) => p !== path);
    setNotes(g.id, add ? [...notes, path] : notes);
  };
  const ready = import("./aiview.js").then((m) => {
    chat = m.mountAssistant(app, host, { onChange: () => saveSoon(), onProvider: (id) => patch(cur, { provider: id }), project, keepWithProject,
      // a chat in a project's group may change that project's notes
      writeScope: () => { const t = curTab(); const g = t && t.group ? groupById(t.group) : null; return g && g.project ? { folder: g.project, name: g.name || g.project } : null; },
      // Start over here empties the chat wherever else it is open (the project room's dock)
      onClear: () => { saveSoon.cancel(); cleared = Date.now(); patch(cur, { msgs: [], cleared, at: cleared, ...((curTab() || {}).named ? {} : { title: "" }) }); } });
    const t = curTab();
    cleared = (t && t.cleared) || 0;
    if (t && t.provider) chat.useProvider(t.provider);
    if (t && t.msgs.length) chat.adopt(t.msgs);
    paint();
    return chat;
  });
  // a project room's chats: the group bound to its folder (made the first time, the brief kept with it),
  // and in it the chat asked for, the newest one, or a new one
  function forProject(o) {
    saveNow();
    mine = true;
    const id = projectThread(app, { ...o, provider: (curTab() || {}).provider || null });
    mine = false;
    if (id === cur) { if (chat) chat.projectChanged(); paint(); } else { cur = null; switchTo(id); }
    if (!over.hidden) toggleOver(false);
  }
  // the same chat written elsewhere (the project room's dock): what it says now is shown here too
  app.bus.on("settings", (k) => {
    if (k !== "aiThreads" || mine || !chat || chat.busy()) return;
    const t = curTab();
    // started over elsewhere: emptied here too; else only a longer conversation is taken in -
    // a shorter one is an older save racing this one's
    if (t && (t.cleared || 0) > cleared) { cleared = t.cleared; chat.adopt(t.msgs || []); }
    else if (t && (t.msgs || []).length > chat.messages().filter((m) => !m.live).length) chat.adopt(t.msgs);
    paint();
  });
  paint();
  return { ready, paint, newThread, overview: (gid) => toggleOver(true, gid), forProject };
}
