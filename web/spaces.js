// Spaces: separate sets of open tabs for separate parts of life (work,
// a project, a channel), switched from one button - the same idea as the
// Life Spaces plugin. Switching saves the tabs you leave and restores the
// tabs of the space you enter. The data lives in settings (spaces[]).

import { outpostList, addOutpost } from "./outposts.js";
import { emojiWords } from "./emoji.js";
import { h } from "./util.js";
import { icon } from "./icons.js";
import { menu, inlineEdit, sortable, confirmDialog } from "./ui.js";

// Built-in line icons are stored as "i:<name>"; anything else is an emoji.
// icons that suit a project space; they lead the picker's own row
const PROJECT_ICONS = ["code", "laptop", "monitor", "keyboard", "wrench", "hammer", "box", "layers", "atom", "flask", "dna", "calculator", "rocket", "bolt", "globe", "brush", "pen", "book", "film", "music", "gamepad", "cart", "building", "shield"];
const ICONS = ["astra", "star", "sparkles", "home", "briefcase", "coffee", "heart", "brain", "book", "cap", "code",
  "chart", "target", "focus", "lightbulb", "bolt", "flame", "rocket", "dumbbell", "music", "gamepad", "film", "camera",
  "palette", "plane", "globe", "mountain", "leaf", "sun", "moon", "paw", "tooth", "users", "cart", "wallet", "gift",
  "wrench", "calendar", "checkSquare", "inbox", "folder", "flag", "clock", "graph",
  "crown", "trophy", "medal", "gem", "key", "lock", "shield", "bell", "mail", "chat", "phone", "laptop", "monitor",
  "headphones", "mic", "guitar", "brush", "pen", "scissors", "hammer", "flask", "atom", "dna", "calculator",
  "clipboard", "bookmark", "box", "truck", "car", "bike", "train", "ship", "anchor", "compass", "map", "tent",
  "tree", "flower", "cloud", "umbrella", "snowflake", "drop", "feather", "fish", "bird", "cat", "smile", "pill",
  "stethoscope", "cake", "pizza", "apple", "wine", "building", "church", "piggy", "handshake", "infinity"];

const split = (s) => [...s.replace(/\s+/g, "")].reduce((a, c) => {
  // keep ZWJ sequences, variation selectors and skin tones on their base emoji
  const prev = a[a.length - 1];
  const flagHalf = /^[\u{1f1e6}-\u{1f1ff}]$/u;
  if (prev && (/[‍️\u{1f3fb}-\u{1f3ff}]/u.test(c) || prev.endsWith("‍") || (flagHalf.test(prev) && flagHalf.test(c)))) a[a.length - 1] += c;
  else a.push(c);
  return a;
}, []);

const EMOJI = [
  ["Popular", "🏠💼🧠📚🎯❤️🎨🎵🏋️✈️🌱💡🔥⭐🚀📝☕🎮💰🧘🌙✨🌟💫"],
  ["Smileys", "😀😃😄😁😆😅😂🤣😊😇🙂😉😌😍🥰😘😋😛😜🤪🤓😎🥳🤩🤔🤗🤫😴🥱😮‍💨😤😡🥶🥵🤯😱🙃🫠🤠👻👽🤖💀😺"],
  ["People", "👋🤚✋🖖👌🤌✌️🤞🤟🤘👍👎✊👏🙌🫶🙏💪🧠👀👤👥👨‍💻👩‍💻🧑‍🎓🧑‍🏫🧑‍🍳🧑‍🎨🧑‍🔬🧑‍⚕️🦷👶🧒👨‍👩‍👧💑🧘🏃🚴🏊🧗"],
  ["Nature", "🌱🌿🍀🌵🌴🌳🌲🍁🍂🌸🌺🌻🌹🌷🌼🍄🌾💐🌍🌎🌏🌙🌞⭐🌈☀️⛅🌧️❄️⚡🔥💧🌊🐶🐱🦊🐻🐼🐨🦁🐯🐸🐵🐧🐦🦉🦋🐝🐢🐙🐬🐳🦄🐉"],
  ["Food", "🍎🍊🍋🍌🍉🍇🍓🫐🍒🍑🥭🍍🥥🥑🥦🥕🌽🍞🥐🧀🥚🍳🥞🥓🍔🍟🍕🌮🍜🍣🍱🍩🍪🎂🍫🍿☕🍵🧋🥤🍷🍺🥂"],
  ["Activity", "⚽🏀🏈⚾🎾🏐🏓🏸🥊🥋⛳🏹🎣🎿🏂🛹🏋️🤸🧩🎲♟️🎯🎮🕹️🎨🖌️🎭🎬🎤🎧🎵🎹🥁🎸🎻📷🏆🥇🏅🎟️"],
  ["Travel", "🚗🚕🚌🏎️🚲🛴🏍️🚂✈️🚀🛸🚁⛵🚤🗺️🧭🏔️⛰️🌋🏕️🏖️🏝️🏜️🏞️🏠🏡🏢🏫🏥🏛️🗼🗽🏰🎡🌃🌆🌉"],
  ["Objects", "💼📁🗂️📅📌📎✏️🖊️📝📚📖🔖💻🖥️⌨️🖱️📱☎️🔋🔌💡🔦🕯️🧪🔬🔭📡🛠️🔧🔨⚙️🧲💰💳💎🧾📦🎁🛒🔑🗝️🔒🧸🪴🛏️🧼🧹🧺💊🩺"],
  ["Symbols", "❤️🧡💛💚💙💜🖤🤍🤎💖💯✅☑️✔️❌⭕🛑⚠️❗❓💬💭🔔📣♻️⚜️🔱💠🔷🔶🔴🟠🟡🟢🔵🟣⚫⚪🟥🟦🟩⬛➕➗✳️❇️🆕🆗🆒"],
  ["Flags", "🏁🚩🏳️🏴🇺🇦🇵🇱🇩🇪🇫🇷🇪🇸🇮🇹🇬🇧🇺🇸🇨🇦🇯🇵🇰🇷🇨🇳🇧🇷🇮🇳🇹🇷🇸🇪🇳🇱🇨🇿"],
].map(([name, s]) => [name, split(s)]);

// Every single-code-point emoji, read from the Unicode properties the JS
// engine already knows - no data file. Ones the system font cannot draw
// (newer than Windows' emoji font) are dropped: an emoji font paints them in
// colour, a missing glyph is a monochrome box. Built once, on demand, in
// small slices so the picker never stalls, and remembered per browser build.
let ALL = null;
let GOOD = null; // the preset lists, minus what this system cannot draw
const ALL_KEY = "leonote.emoji.v3";
// no religious symbols, places of worship or star signs in the picker
const LEFT_OUT = new Set([..."🕌🕍🛕⛩🕋☪🕉☸✡🔯☯🪯🛐📿🪬🧕✝☦⛪♈♉♊♋♌♍♎♏♐♑♒♓⛎"].map((c) => c.replace(/️/g, "")));
let tester = null;
/** Whether this system paints the emoji (colour, one glyph wide) - never a box or a broken sequence. */
export const canDraw = (e) => !LEFT_OUT.has(e.replace(/️/g, "")) && (tester || (tester = glyphTester()))(e);

// Two cheap checks per emoji on a tiny canvas: colour pixels (a missing glyph
// is a monochrome box) and width (a sequence the font does not know falls
// apart into several faces side by side).
function glyphTester() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 20;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.font = '16px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  g.textBaseline = "top";
  const one = g.measureText("\u{1f600}").width || 20;
  return (ch) => {
    if (g.measureText(ch).width > one * 1.35) return false;
    g.clearRect(0, 0, 64, 20);
    g.fillStyle = "#000";
    g.fillText(ch, 0, 0);
    const d = g.getImageData(0, 0, 24, 20).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40 && (Math.abs(d[i] - d[i + 1]) > 18 || Math.abs(d[i + 1] - d[i + 2]) > 18)) return true;
    }
    return false;
  };
}

export async function emojiSets() {
  if (ALL) return { all: ALL, good: GOOD };
  try {
    const c = JSON.parse(localStorage.getItem(ALL_KEY) || "null");
    if (c && c.ua === navigator.userAgent && Array.isArray(c.all) && Array.isArray(c.bad)) {
      const bad = new Set(c.bad);
      GOOD = EMOJI.map(([n, l]) => [n, l.filter((e) => !bad.has(e))]);
      return { all: (ALL = c.all), good: GOOD };
    }
  } catch {}
  const ok = glyphTester();
  const bad = EMOJI.flatMap(([, l]) => l).filter((e) => !ok(e));
  const badSet = new Set(bad);
  GOOD = EMOJI.map(([n, l]) => [n, l.filter((e) => !badSet.has(e))]);
  const seen = new Set(EMOJI.flatMap(([, l]) => l));
  const out = [];
  for (const [a, b] of [[0x2300, 0x2bff], [0x1f000, 0x1faff]]) {
    for (let cp = a; cp <= b; cp++) {
      if (cp % 128 === 0) await new Promise((r) => setTimeout(r));
      const ch = String.fromCodePoint(cp);
      if (!/\p{Emoji}/u.test(ch) || /\p{Emoji_Component}/u.test(ch)) continue;
      const e = /\p{Emoji_Presentation}/u.test(ch) ? ch : ch + "\ufe0f";
      if (seen.has(e) || seen.has(ch) || LEFT_OUT.has(ch) || !ok(e)) continue;
      out.push(e);
    }
  }
  try { localStorage.setItem(ALL_KEY, JSON.stringify({ ua: navigator.userAgent, all: out, bad })); } catch {}
  ALL = out;
  return { all: ALL, good: GOOD };
}

/** A space's icon as a node: a built-in line icon or an emoji. */
export function spaceIcon(v, cls = "space-emoji") {
  v = v || "i:astra";
  if (v.startsWith("i:")) { const s = h("span", { class: cls + " is-icon" }); s.append(icon(v.slice(2))); return s; }
  return h("span", { class: cls, text: v });
}

/**
 * api: { list(), current(), switchTo(id), add() -> space, rename(id, name),
 *        setIcon(id, emoji), remove(id) -> undo fn | null, move(from, to), step(d) }
 */
export function mountSpaces(app, api, button) {
  let pop = null;
  let anchor = button;
  const buttons = new Set();
  let closeTimer = 0;

  const backChip = h("button", { class: "space-back", hidden: true, onclick: () => api.back() });
  function paint() {
    const s = api.current();
    if (!s) return; // spaces load after the chrome mounts; main paints again then
    for (const b of buttons) {
      b.replaceChildren(spaceIcon(s.icon));
      b.title = `Space: ${s.name} · Alt+PageUp / Alt+PageDown · right-click to place this button`;
    }
    const all = api.list();
    const k = all.indexOf(s);
    if (all.length > 1 && typeof stepsOf !== "undefined") {
      const nb = (d) => all[(k + d + all.length) % all.length];
      layoutSteps();
      for (const st of stepsOf.values()) {
        st.prev.title = `Previous space: ${nb(-1).name} (Alt+PageUp) · drag to move`;
        st.next.title = `Next space: ${nb(1).name} (Alt+PageDown) · drag to move`;
      }
    } else if (typeof stepsOf !== "undefined") layoutSteps();
    // in "Opened files", one click (or Alt+`) back to where you were working
    const was = s.id === "outside" && api.before ? api.before() : null;
    const host = [...buttons].find((b) => !b.hidden && b.isConnected);
    backChip.hidden = !was || !host;
    if (was && host) {
      // after the button and the arrows that follow it
      let tail = host;
      const st = stepsOf.get(host);
      if (st) { const o = stepOrder(); for (const k of o.slice(o.indexOf("space") + 1)) tail = st[k]; }
      if (backChip.previousElementSibling !== tail) tail.after(backChip);
      // a step back in history, to where you were in that space: Forward returns here
      backChip.replaceChildren(icon("back"), spaceIcon(was.icon), h("span", { text: was.name }));
      backChip.title = `Back to ${was.name} (Alt+\`) - Forward returns here`;
    }
    if (pop) renderPop();
  }

  function close() {
    byHover = false;
    hidePeek();
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  const outside = (e) => { if (pop && !pop.contains(e.target) && ![...buttons].some((b) => b.contains(e.target)) && !e.target.closest?.(".menu, .emoji-pop")) close(); };
  const onKey = (e) => { if (e.key === "Escape" && !e.target.closest?.(".inline-edit, .emoji-pop")) { e.stopPropagation(); close(); } };

  function open(from) {
    if (pop) return close();
    if (from && from.getBoundingClientRect) anchor = from;
    else anchor = [...buttons].find((b) => b.offsetParent) || button;
    pop = h("div", { class: "space-pop", onmouseenter: stay, onmouseleave: leaveSoon });
    document.getElementById("overlay-root").append(pop);
    const r = anchor.getBoundingClientRect();
    // beside a button in the ribbon, below one in the title bar
    const side = r.left < 60 && r.top > 60;
    gitInfo.clear();
    pop.style.left = Math.max(6, Math.min(side ? r.right + 8 : r.left, innerWidth - 600)) + "px";
    pop.style.top = Math.max(6, Math.min(side ? r.top : r.bottom + 6, innerHeight - 320)) + "px";
    renderPop();
    pop.addEventListener("mousedown", () => { byHover = false; stay(); });
    setTimeout(() => {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", onKey, true);
    });
  }

  /* ── a space's project ─────────────────────────────────────────────────
     A space can carry a project folder (an outpost, or the vault): its find
     and replace, go-to-file and git then work on that folder alone. Kept in
     settings.spaceProjects by the space's id; projectview.js is the view. */
  const folderName = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  const projectOf = (id) => (app.settings.spaceProjects || {})[id] || "";
  const setProject = (id, path) => { const m = { ...(app.settings.spaceProjects || {}) }; if (path) m[id] = path; else delete m[id]; app.setSetting("spaceProjects", m); };
  // go to the space, then to that part of its project
  const openProject = (id, cmd) => { close(); api.switchTo(id); app.run(cmd); };
  async function newProjectSpace(path) {
    let at = path;
    if (!at) { const res = await addOutpost(app); if (!res || !res.path) return; at = res.path; }
    const taken = api.list().find((x) => projectOf(x.id) === at);
    if (taken) { api.switchTo(taken.id); app.run("project-find"); return close(); }
    const s = api.add({ name: folderName(at), icon: "i:code" });
    setProject(s.id, at);
    api.switchTo(s.id);
    close();
    app.run("project-files");
  }
  function projectItems(s) {
    const cur = projectOf(s.id);
    const pick = (path) => { setProject(s.id, path); renderPop(); };
    return [
      cur ? { label: "Find and replace in the project", icon: "search", keys: "Ctrl Alt F", run: () => openProject(s.id, "project-find") } : null,
      cur ? { label: "Go to file", icon: "file", keys: "Ctrl Alt O", run: () => openProject(s.id, "project-files") } : null,
      cur ? { label: "Git", icon: "code", keys: "Ctrl Alt K", run: () => openProject(s.id, "project-git") } : null,
      { label: cur ? `Code project folder · ${folderName(cur)}` : "Give this space a code project folder", icon: "folder", sub: [
        ...outpostList(app).map((o) => ({ label: o.name || folderName(o.path), checked: cur === o.path, run: () => pick(o.path) })),
        app.vault.root ? { label: "The vault itself", checked: cur === app.vault.root, run: () => pick(app.vault.root) } : null,
        "sep",
        { label: "Hook up a folder…", icon: "folderPlus", run: async () => { const res = await addOutpost(app); if (res && res.path) pick(res.path); } },
        cur ? { label: "No project", icon: "x", run: () => pick("") } : null,
      ].filter(Boolean) },
      "sep",
    ].filter(Boolean);
  }

  /* ── deleting a space: asked twice, and kept for a month ───────────────── */
  const KEEP_DAYS = 30;
  const binned = () => (Array.isArray(app.settings.deletedSpaces) ? app.settings.deletedSpaces : []).filter((x) => x && x.space && Date.now() - x.at < KEEP_DAYS * 86400000);
  async function deleteSpace(s) {
    const n = (s.tabs || []).length;
    close();
    if (!(await confirmDialog(`Delete the space “${s.name}”?`, `${n ? `Its ${n} tab${n === 1 ? "" : "s"} close` : "It has no tabs"}${projectOf(s.id) ? ", and it stops being a code project" : ""}. No file is touched - a space is only a set of tabs.`, { ok: "Delete…" }))) return;
    if (!(await confirmDialog(`Really delete “${s.name}”?`, `It stays in “Deleted spaces” at the foot of the switcher for ${KEEP_DAYS} days and can be brought back from there.`, { ok: "Delete space" }))) return;
    const project = projectOf(s.id);
    const snap = JSON.parse(JSON.stringify(s.id === api.current().id && api.snapshot ? api.snapshot() : s));
    if (!api.remove(s.id)) return;
    setProject(s.id, "");
    app.setSetting("deletedSpaces", [{ space: snap, project, at: Date.now() }, ...binned()].slice(0, 20));
    app.toast(`Deleted space “${s.name}”`, { ms: 8000, action: { label: "Undo", run: () => restoreSpace(snap.id) } });
  }
  function restoreSpace(id) {
    const it = binned().find((x) => x.space.id === id);
    if (!it) return;
    app.setSetting("deletedSpaces", binned().filter((x) => x !== it));
    const s = api.restore ? api.restore(it.space) : null;
    if (s && it.project) setProject(s.id, it.project);
    app.toast(`“${it.space.name}” is back`, { ms: 2400 });
    if (pop) renderPop();
  }
  function binMenu(at) {
    const r = at.getBoundingClientRect();
    menu(r.left, r.top - 8, [
      { header: `Deleted spaces · kept ${KEEP_DAYS} days` },
      ...binned().map((x) => ({ label: `${x.space.name} · ${(x.space.tabs || []).length} tabs`, icon: "undo", run: () => restoreSpace(x.space.id) })),
      "sep",
      { label: "Forget them all", icon: "trash", danger: true, run: async () => { if (await confirmDialog("Forget every deleted space?", "They can no longer be brought back. No file is touched.", { ok: "Forget", safe: true })) { app.setSetting("deletedSpaces", []); if (pop) renderPop(); } } },
    ]);
  }

  /* ── a space becomes a project, a project becomes a space ─────────────────
     Nothing about this is dangerous - the folder is never touched, only the
     link to it - but it changes what the space's search and git act on, so it
     is asked about once and never happens by a slip of the mouse. */
  async function toProject(s) {
    const list = outpostList(app);
    const go = async (path) => {
      if (!path) { const res = await addOutpost(app); if (!res || !res.path) return; path = res.path; }
      if (!(await confirmDialog(`Make “${s.name}” a code project space?`, `Its find and replace, go-to-file and git will work on ${folderName(path)}. The folder itself is not changed, and you can turn this off again.`, { ok: "Make it a code project", danger: false }))) return;
      setProject(s.id, path);
      open();
    };
    close();
    if (!list.length) return go("");
    const r = (anchor || button).getBoundingClientRect();
    menu(r.left, r.bottom + 6, [{ header: `Which folder is “${s.name}” about?` },
      ...list.map((o) => ({ label: o.name || folderName(o.path), icon: "folder", run: () => go(o.path) })), "sep",
      { label: "Another folder…", icon: "folderPlus", run: () => go("") }]);
  }
  async function toSpace(s) {
    close();
    if (await confirmDialog(`Stop “${s.name}” being a code project?`, `It becomes an ordinary space again. ${folderName(projectOf(s.id))} stays where it is, hooked up as before.`, { ok: "Make it a plain space", danger: false })) setProject(s.id, "");
    open();
  }

  // branch and changed files of each project, asked once per opening of the switcher
  const gitInfo = new Map();
  function askGit(path) {
    if (gitInfo.has(path) || !app.host.projectGit) return;
    gitInfo.set(path, null);
    app.host.projectGit(path, "status").then((r) => {
      if (!r || !r.ok) return gitInfo.set(path, { none: true });
      const lines = String(r.out).split("\n").filter(Boolean);
      const head = (lines[0] || "").replace(/^## /, "").replace(/^No commits yet on /, "");
      gitInfo.set(path, { branch: head.split("...")[0].split(" ")[0], changed: Math.max(0, lines.length - 1), ahead: +(/ahead (\d+)/.exec(head) || [0, 0])[1] });
      if (pop) renderPop();
    }).catch(() => gitInfo.set(path, { none: true }));
  }

  /* ── a look into a space: pointing at its row shows its groups and tabs ──
     beside the pop, with a filter on top and a search through its files */
  let peekT = 0;
  let peekOn = null; // the space being looked into
  let peekEl = null;
  function hidePeek() { clearTimeout(peekT); if (peekEl) peekEl.remove(); peekEl = null; peekOn = null; }
  function showPeek(s, row) {
    if (!pop || !row.isConnected || document.querySelector(".space-pop .inline-edit")) return;
    if (peekOn === s.id && peekEl && peekEl.isConnected) return;
    const data = api.peek && api.peek(s.id);
    if (!data) return;
    hidePeek();
    peekOn = s.id;
    const go = (l) => { close(); api.openTab(s.id, l); };
    const proj = projectOf(s.id);
    const q = h("input", { class: "space-peek-q", type: "text", placeholder: `Filter ${s.name}`, spellcheck: "false" });
    const vaultPaths = () => data.tabs.filter((t) => t.l.kind === "note" || t.l.kind === "file").map((t) => t.l.path);
    const searchBtn = h("button", { class: "icon-btn", title: proj ? `Find in ${s.name}'s project` : `Search the files open in ${s.name}`, onclick: () => {
      const text = q.value.trim();
      if (proj) return openProject(s.id, "project-find");
      close();
      api.switchTo(s.id);
      const paths = vaultPaths();
      app.openSearch(paths.length ? { paths, query: text } : { query: text });
    } }, icon("search"));
    const list = h("div", { class: "space-peek-list" });
    const clear = h("button", { class: "space-peek-x", title: "Clear", hidden: true, onclick: () => { q.value = ""; paintList(); q.focus(); } }, icon("x"));
    const dirOf = (p) => { const k = Math.max(String(p).lastIndexOf("/"), String(p).lastIndexOf("\\")); return k > 0 ? String(p).slice(0, k) : ""; };
    const leafOf = (d) => d.split(/[\\/]/).pop() || d;
    const where = (t) => (t.l.kind === "note" || t.l.kind === "file" || t.l.kind === "ext" ? dirOf(t.l.path) : t.l.kind === "web" ? "web" : "");
    const item = (t, sub) => h("button", { class: "space-peek-item" + (t.on ? " is-on" : ""), title: t.tip, onclick: () => go(t.l) },
      icon(t.icon), h("span", { class: "space-peek-title", text: t.title }), sub ? h("span", { class: "space-peek-sub", text: sub }) : null);
    function paintList() {
      const f = q.value.trim().toLowerCase();
      clear.hidden = !f;
      const hit = (t) => !f || t.title.toLowerCase().includes(f) || String(t.l.path || "").toLowerCase().includes(f);
      const out = [];
      const section = (lead, name, n, title) => h("div", { class: "space-peek-head", title: title || name }, lead, h("span", { text: name }), h("b", { text: String(n) }));
      // its groups, as the tab bar shows them
      for (const g of data.groups) {
        const ts = data.tabs.filter((t) => t.group === g.id && hit(t));
        if (!ts.length) continue;
        out.push(h("div", { class: "space-peek-sec", style: { "--g": g.swatch } }, section(h("i", { class: "space-peek-swatch" }), g.label, ts.length), ...ts.map((t) => item(t))));
      }
      // the rest: a folder holding several gets a heading; one-offs sit in one list, their folder beside them
      const loose = data.tabs.filter((t) => (!t.group || !data.groups.some((g) => g.id === t.group)) && hit(t));
      const byDir = new Map();
      for (const t of loose) { const d = where(t); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(t); }
      const singles = [];
      for (const [d, ts] of byDir) {
        if (ts.length < 2 || d === "") { singles.push(...ts); continue; }
        out.push(h("div", { class: "space-peek-sec" }, section(icon(d === "web" ? "globe" : "folder"), d === "web" ? "Web pages" : leafOf(d), ts.length, d), ...ts.map((t) => item(t))));
      }
      if (singles.length) out.push(h("div", { class: "space-peek-sec is-loose" }, ...(out.length ? [section(icon("file"), "Other tabs", singles.length)] : []), ...singles.map((t) => item(t, where(t) === "web" ? "web" : leafOf(where(t))))));
      list.replaceChildren(...(out.length ? out : [h("div", { class: "space-peek-empty", text: data.tabs.length ? "Nothing matches" : "No tabs open here" })]));
    }
    q.addEventListener("input", paintList);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") { const first = list.querySelector(".space-peek-item"); if (first) first.click(); } else if (e.key === "Escape") { e.stopPropagation(); hidePeek(); } });
    paintList();
    peekEl = h("div", { class: "space-peek", onmousedown: () => { byHover = false; stay(); } },
      h("div", { class: "space-peek-top" }, icon("search", "space-peek-lead"), q, clear, searchBtn),
      list);
    pop.append(peekEl);
    // beside the pop, level with the row; on the other side when there is no room
    const pr = pop.getBoundingClientRect(), rr = row.getBoundingClientRect();
    const w = 300;
    const right = pr.right + 6 + w < innerWidth - 8;
    peekEl.style.left = (right ? pr.width + 6 : -w - 6) + "px";
    const hgt = Math.min(peekEl.offsetHeight, innerHeight - 16);
    peekEl.style.top = Math.max(8 - pr.top, Math.min(rr.top - pr.top - 8, innerHeight - 8 - hgt - pr.top)) + "px";
  }

  function renderPop(renameId) {
    hidePeek();
    const cur = api.current();
    const all = api.list();
    const rowOf = (s) => {
      const proj = projectOf(s.id);
      const gi = proj ? gitInfo.get(proj) : null;
      if (proj && app.settings.spacesGitInfo !== false) askGit(proj);
      const name = h("span", { class: "space-name", text: s.name });
      const row = h("div", { class: "space-row" + (s.id === cur.id ? " is-active" : "") + (proj ? " has-project" : ""), dataset: { id: s.id }, draggable: true,
        onmouseenter: () => { clearTimeout(peekT); peekT = setTimeout(() => showPeek(s, row), peekOn ? 90 : 260); },
        onmouseleave: () => clearTimeout(peekT),
        onclick: (e) => {
          if (e.target.closest(".inline-edit, button")) return;
          // switch at once, close a moment later so a double click can rename
          clearTimeout(closeTimer);
          if (e.detail >= 2) return renderPop(s.id);
          api.switchTo(s.id);
          closeTimer = setTimeout(close, 260);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          menu(e.clientX, e.clientY, [
            ...projectItems(s),
            { label: "Rename", icon: "edit", run: () => rename(row, s) },
            { label: "Change icon", icon: "sparkles", run: () => pickEmoji(row, (emo) => api.setIcon(s.id, emo)) },
            proj ? { label: "Make it a plain space…", icon: "astra", run: () => toSpace(s) } : { label: "Make it a code project space…", icon: "code", run: () => toProject(s) },
            "sep",
            all.length > 1 ? { label: "Delete space…", icon: "trash", danger: true, run: () => deleteSpace(s) } : null,
          ]);
        } },
        h("button", { class: "space-emoji" + (s.icon && s.icon.startsWith("i:") ? " is-icon" : ""), title: "Change icon",
          onclick: (e) => { e.stopPropagation(); pickEmoji(row, (emo) => api.setIcon(s.id, emo)); } },
          s.icon && s.icon.startsWith("i:") ? icon(s.icon.slice(2)) : s.icon || icon("astra")),
        proj
          ? h("div", { class: "space-text" }, name, h("span", { class: "space-proj", title: proj },
              gi && gi.branch ? h("span", { class: "space-branch" }, icon("code"), gi.branch) : h("span", { class: "space-branch" }, icon("folder"), folderName(proj)),
              gi && gi.changed ? h("span", { class: "space-changed", title: `${gi.changed} changed file${gi.changed === 1 ? "" : "s"}`, text: "●" + gi.changed }) : null,
              gi && gi.ahead ? h("span", { class: "space-ahead", title: `${gi.ahead} commit${gi.ahead === 1 ? "" : "s"} to push`, text: "↑" + gi.ahead }) : null))
          : name,
        // a project's three doors, a press away from any space
        proj ? h("span", { class: "space-doors" },
          ...[["search", "Find and replace in the project", "project-find"], ["file", "Go to file", "project-files"], ["code", "Git", "project-git"]].map(([ic, title, cmd]) =>
            h("button", { class: "space-door", title, onclick: (e) => { e.stopPropagation(); clearTimeout(closeTimer); openProject(s.id, cmd); } }, icon(ic)))) : null,
        h("span", { class: "space-count", text: s.tabs && s.tabs.length ? String(s.tabs.length) : "" }));
      return row;
    };
    // a workspace's space (the workspace room's) is listed with the workspaces, not with the plain ones
    const wsIds = new Map(Object.entries(app.settings.roomSpaces || {}).map(([f, id]) => [id, f]));
    // a hidden workspace's space is left out, unless you are in it
    const hiddenWs = new Set(app.settings.roomHidden || []);
    const workspaces = all.filter((s) => !projectOf(s.id) && wsIds.has(s.id) && (!hiddenWs.has(wsIds.get(s.id)) || s.id === app.currentSpaceId()));
    const plain = all.filter((s) => !projectOf(s.id) && !wsIds.has(s.id));
    const projects = all.filter((s) => projectOf(s.id));
    const newProject = (e) => {
      const free = outpostList(app).filter((o) => !all.some((x) => projectOf(x.id) === o.path));
      if (!free.length) return newProjectSpace();
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.bottom + 4, [
        { header: "A code project space for" },
        ...free.map((o) => ({ label: o.name || folderName(o.path), icon: "folder", run: () => newProjectSpace(o.path) })),
        "sep",
        { label: "Another folder…", icon: "folderPlus", run: () => newProjectSpace() },
      ]);
    };
    const col = (kind, title, hint, rows, addBtn) => h("div", { class: "space-col", dataset: { kind } },
      h("div", { class: "space-col-head" }, h("b", { text: title }), h("span", { class: "space-col-n", text: rows.length ? String(rows.length) : "" }), addBtn),
      h("div", { class: "space-list" }, rows.length ? rows.map(rowOf) : h("div", { class: "space-none", text: hint })));
    const layout = app.settings.spacesLayout === "cols" ? "cols" : "stack";
    const popH = Math.max(0, Number(app.settings.spacesPopH) || 0);
    const split = Math.min(0.85, Math.max(0.15, Number(app.settings.spacesSplit) || 0.5));
    pop.dataset.layout = layout;
    pop.classList.toggle("is-sized", popH > 0);
    const wsplit = Math.min(0.85, Math.max(0.15, Number(app.settings.spacesWsSplit) || 0.5));
    const body = h("div", { class: "space-cols", style: popH ? { height: popH + "px", "--split": String(split) } : { "--split": String(split) } });
    const group = h("div", { class: "space-colgroup", style: { "--wsplit": String(wsplit) } });
    // a bar between two parts: dragged, it shares the room out (the height is held from then on)
    const splitBar = (box, key, name, across, title) => h("div", { class: "space-split" + (across ? "" : " is-rows"), title,
      ondblclick: () => { app.setSetting(key, 0.5); renderPop(); },
      onpointerdown: (e) => {
        e.preventDefault();
        const whole = body.getBoundingClientRect();
        if (!popH) app.settings.spacesPopH = Math.round(whole.height); // from now on the height is held, so the share means something
        body.style.height = Math.round(whole.height) + "px";
        pop.classList.add("is-sized");
        const r = box.getBoundingClientRect();
        const move = (m) => { const f = across ? (m.clientX - r.left) / r.width : (m.clientY - r.top) / r.height; box.style.setProperty(name, String(Math.min(0.85, Math.max(0.15, f)))); };
        const up = () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true); app.setSetting("spacesPopH", Math.round(body.getBoundingClientRect().height)); app.setSetting(key, Number(box.style.getPropertyValue(name)) || 0.5); };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", up, true);
      } });
    group.append(
      col("space", "Spaces", "Drag a code project here to make it a plain space", plain,
        h("button", { class: "icon-btn", title: "New space", onclick: () => { const s = api.add(); renderPop(s.id); } }, icon("plus"))),
      splitBar(group, "spacesWsSplit", "--wsplit", false, "Drag to share the room between spaces and workspaces · double-click for half each"),
      col("workspace", "Workspaces", "A workspace's own tabs - a folder seen as a whole in the workspace room (Alt+R). Press + or right-click a folder › Make it a workspace", workspaces,
        h("button", { class: "icon-btn", title: "Make a folder a workspace", onclick: () => { close(); app.pickWorkspaceFolder(); } }, icon("plus"))));
    body.append(group,
      // the bar between the two: drag it to give one of them more room
      splitBar(body, "spacesSplit", "--split", layout === "cols", "Drag to share the room between spaces and projects · double-click for half each"),
      col("project", "Code projects", "A space for a code folder you work on: its own tabs, find and replace across it, go to file, git. Press + or drag a space here", projects,
        h("button", { class: "icon-btn", title: "New code project space", onclick: newProject }, icon("plus"))));
    const grip = h("div", { class: "space-grip", title: "Drag to make the switcher taller or shorter · double-click for automatic",
      ondblclick: () => { app.setSetting("spacesPopH", 0); renderPop(); },
      onpointerdown: (e) => {
        e.preventDefault();
        const y0 = e.clientY;
        const h0 = body.getBoundingClientRect().height;
        pop.classList.add("is-sized");
        const move = (m) => { body.style.height = Math.max(150, Math.min(innerHeight - 140, h0 + m.clientY - y0)) + "px"; };
        const up = () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true); app.setSetting("spacesPopH", Math.round(body.getBoundingClientRect().height)); };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", up, true);
      } });
    const gear = h("button", { class: "icon-btn space-gear", title: "Settings for spaces and projects", onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const at = new Set(app.settings.spacesAt || ["titlebar"]);
      const flip = (k) => { at.has(k) ? at.delete(k) : at.add(k); if (!at.size) at.add("titlebar"); app.setSetting("spacesAt", [...at]); };
      menu(r.left, r.top - 8, [
        { header: "Code projects sit" },
        { label: "Under the spaces", checked: layout === "stack", run: () => { app.setSetting("spacesLayout", "stack"); renderPop(); } },
        { label: "Beside the spaces", checked: layout === "cols", run: () => { app.setSetting("spacesLayout", "cols"); renderPop(); } },
        { label: "Automatic height, half each", icon: "undo", run: () => { app.setSetting("spacesPopH", 0); app.setSetting("spacesSplit", 0.5); app.setSetting("spacesWsSplit", 0.5); renderPop(); } },
        "sep",
        { label: "Show each project's branch and changes", checked: app.settings.spacesGitInfo !== false, run: () => { app.setSetting("spacesGitInfo", app.settings.spacesGitInfo === false); gitInfo.clear(); renderPop(); } },
        { label: "In a code project space, the sidebar starts on the project's files", checked: app.settings.projectSidebarFirst !== false, run: () => app.setSetting("projectSidebarFirst", app.settings.projectSidebarFirst === false) },
        "sep",
        { label: "Previous-space arrow by the button", checked: stepOn("prev"), run: () => setStep("prev", !stepOn("prev")) },
        { label: "Next-space arrow by the button", checked: stepOn("next"), run: () => setStep("next", !stepOn("next")) },
        { label: "Open this on hover", checked: app.settings.spacesHover !== false, run: () => app.setSetting("spacesHover", app.settings.spacesHover === false) },
        { label: "Files opened from Windows go to “Opened files”", checked: app.settings.outsideSpace !== false, run: () => app.setSetting("outsideSpace", app.settings.outsideSpace === false) },
        { label: "Pictures and videos opened from Windows", icon: "image", sub: [
          { label: "In a viewer window each", checked: (app.settings.mediaOpen || "windows") === "windows", run: () => app.setSetting("mediaOpen", "windows") },
          { label: "In one viewer window", checked: app.settings.mediaOpen === "one", run: () => app.setSetting("mediaOpen", "one") },
          { label: "In a tab, like other files", checked: app.settings.mediaOpen === "tab", run: () => app.setSetting("mediaOpen", "tab") },
        ] },
        "sep",
        { header: "The spaces button shows" },
        ...PLACES.map(([k, label]) => ({ label, checked: at.has(k), run: () => flip(k) })),
        "sep",
        api.current() && projectOf(api.current().id) ? { label: "This project's settings…", icon: "settings", run: () => { close(); app.run("project-settings"); } } : null,
      ].filter(Boolean));
    } }, icon("settings"));
    // within a column rows reorder; dropped on the other column a space changes kind (asked first)
    const globalIndex = (id) => api.list().findIndex((x) => x.id === id);
    sortable(body, { item: ".space-row", adopt: ".space-col",
      onMove: (from, to, el) => {
        const colRows = [...el.parentElement.querySelectorAll(".space-row")].map((r) => r.dataset.id);
        const ids = colRows.filter((id) => id !== el.dataset.id);
        // `to` is where it lands among its column's rows: find the global place of the row it lands before
        const beforeId = ids[to] || null;
        const g = globalIndex(el.dataset.id);
        const target = beforeId ? globalIndex(beforeId) : api.list().length;
        api.move(g, target > g ? target - 1 : target);
        renderPop();
      },
      onAdopt: (el, host) => {
        const s = api.list().find((x) => x.id === el.dataset.id);
        if (!s) return;
        if (host.dataset.kind === "project" && !projectOf(s.id)) toProject(s);
        else if (host.dataset.kind === "space" && projectOf(s.id)) toSpace(s);
      } });

    const bin = binned();
    pop.replaceChildren(
      body,
      grip,
      h("div", { class: "space-foot" },
        gear,
        h("div", { class: "space-steps" },
          h("button", { title: "Previous space (Alt+PageUp)", onclick: () => api.step(-1) }, icon("chevron", "is-back"), "Prev"),
          h("button", { title: "Next space (Alt+PageDown)", onclick: () => api.step(1) }, "Next", icon("chevron"))),
        bin.length ? h("button", { class: "btn space-bin", title: "Deleted spaces - bring one back", onclick: (e) => binMenu(e.currentTarget) }, icon("trash"), String(bin.length)) : null));
    const list = body;

    if (renameId) {
      const row = list.querySelector(`[data-id="${renameId}"]`);
      const s = api.list().find((x) => x.id === renameId);
      if (row && s) rename(row, s);
    }
  }

  function rename(row, s) {
    const name = row.querySelector(".space-name");
    row.draggable = false;
    inlineEdit(name, s.name, { selectBase: true, onCommit: (v) => api.rename(s.id, v.trim()), onCancel: () => { row.draggable = true; } });
  }

  function pickEmoji(anchor, onPick) {
    document.querySelector(".emoji-pop")?.remove();
    const pick = (v) => { pop.remove(); document.removeEventListener("mousedown", off, true); onPick(v); };
    const btn = (v, child) => h("button", { class: "emoji-btn", dataset: { v }, title: v.startsWith("i:") ? v.slice(2) : "" }, child);
    const secs = [
      // ONE section of icons, the project ones first: everything below counts on
      // the emoji sections starting at index 1
      ["Icons", [...PROJECT_ICONS, ...ICONS.filter((n) => !PROJECT_ICONS.includes(n))].map((n) => btn("i:" + n, icon(n)))],
      ...(GOOD || EMOJI).map(([name, list]) => [name, list.map((emo) => btn(emo, emo))]),
      ["All emoji", null], // built on first view: ~1,400 buttons nobody may need
    ];
    const heads = [];
    const grids = [];
    const scroll = h("div", { class: "emoji-scroll" }, secs.flatMap(([name, btns]) => {
      const head = h("div", { class: "emoji-sec", text: name });
      const grid = h("div", { class: "emoji-grid" }, btns || []);
      heads.push(head);
      grids.push(grid);
      return [head, grid];
    }));
    const allGrid = grids[grids.length - 1];
    let allBuilt = null;
    const buildAll = () => {
      if (!allBuilt) {
        allGrid.append(h("div", { class: "emoji-loading", text: "Loading…" }));
        allBuilt = emojiSets().then(({ all }) => {
          allGrid.replaceChildren(...all.map((e) => btn(e, e)));
          if (search.value) search.dispatchEvent(new Event("input"));
        });
      }
      return allBuilt;
    };
    // first time only: drop preset emoji this system cannot draw
    if (!GOOD) emojiSets().then(({ good }) => {
      const keep = new Set(good.flatMap(([, l]) => l));
      for (let i = 1; i < grids.length - 1; i++) for (const b of [...grids[i].children]) if (!keep.has(b.dataset.v)) b.remove();
    });
    buildAll();
    const io = { disconnect() {} };

    // one listener for every button
    // the release on a button is the choice (a click can be eaten by whatever
    // closes around it: the row's menu, a drag that ended, the switcher itself)
    let picked = false;
    scroll.addEventListener("pointerup", (e) => { const b = e.target.closest(".emoji-btn"); if (b && e.button === 0 && !picked) { picked = true; pick(b.dataset.v); } });
    scroll.addEventListener("click", (e) => { const b = e.target.closest(".emoji-btn"); if (b && !picked) { picked = true; pick(b.dataset.v); } });

    // Search: icons by name, emoji by a short English word (the common ones), or paste one
    const hint = h("div", { class: "emoji-hint", hidden: true, text: "Nothing by that word" });
    const search = h("input", { class: "emoji-search", placeholder: "Find: heart, fire, check…", spellcheck: false });
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { pop.remove(); document.removeEventListener("mousedown", off, true); }
      if (e.key === "Enter") { const first = scroll.querySelector(".emoji-btn:not([hidden])"); if (first) pick(first.dataset.v); }
    });
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const isEmoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(q);
      if (isEmoji) buildAll();
      let any = false;
      const once = new Set();
      secs.forEach((_, i) => {
        let shown = 0;
        for (const b of grids[i].querySelectorAll(".emoji-btn")) {
          const v = b.dataset.v;
          const ok = !q || (v.startsWith("i:") ? !isEmoji && v.slice(2).toLowerCase().includes(q) : isEmoji ? v.includes(q) : emojiWords(v).some((w) => w.startsWith(q)));
          const dup = q && ok && once.has(v);
          if (q && ok) once.add(v);
          b.hidden = !ok || dup;
          if (dup) continue;
          if (ok) shown++;
        }
        heads[i].hidden = grids[i].hidden = q ? !shown : false;
        any = any || !!shown;
      });
      hint.hidden = !q || any;
      cats.hidden = !!q;
    });

    const cats = h("div", { class: "emoji-cats" }, secs.map(([name], i) =>
      h("button", { class: "emoji-cat", title: name, onclick: () => {
        if (i === secs.length - 1) buildAll();
        scroll.scrollTop = heads[i].offsetTop - scroll.offsetTop;
      } }, i === 0 ? icon("astra") : i === secs.length - 1 ? icon("grid") : EMOJI[i - 1][1][0])));
    const pop = h("div", { class: "emoji-pop" }, h("div", { class: "emoji-top" }, search), cats, hint, scroll);
    document.getElementById("overlay-root").append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left, innerWidth - 298)) + "px";
    pop.style.top = Math.max(6, Math.min(r.bottom + 4, innerHeight - 350)) + "px";
    const off = (e) => { if (!pop.contains(e.target)) { pop.remove(); io.disconnect(); document.removeEventListener("mousedown", off, true); } };
    setTimeout(() => document.addEventListener("mousedown", off, true));
    search.focus();
  }

  // where the button can live; the choice is a list, so it can be in several
  const PLACES = [
    ["titlebar", "Title bar, left"],
    ["tabs", "Before the tabs"],
    ["right", "Title bar, right"],
    ["ribbon", "Side ribbon"],
  ];
  function placeMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const on = app.settings.spacesAt || ["titlebar"];
    const again = () => placeMenu({ preventDefault() {}, stopPropagation() {}, clientX: e.clientX, clientY: e.clientY });
    menu(e.clientX, e.clientY, [
      { label: "Open spaces", icon: "sparkles", run: () => open(e.currentTarget || anchor) },
      "sep",
      { header: "Show this button in" },
      ...PLACES.map(([k, label]) => ({ label, checked: on.includes(k), run: () => {
        const next = on.includes(k) ? on.filter((x) => x !== k) : [...on, k];
        if (!next.length) return app.toast("The Spaces button needs at least one place");
        app.setSetting("spacesAt", next);
        again();
      } })),
      "sep",
      { header: "Previous / next arrows beside it" },
      ...PLACES.filter(([k]) => on.includes(k)).map(([k, label]) => ({ label, icon: "swap", checked: arrowsAt(k), run: () => { app.setSetting("spaceArrows", { ...(app.settings.spaceArrows || {}), [k]: !arrowsAt(k) }); layoutSteps(); again(); } })),
    ]);
  }
  let hoverT = 0;
  let byHover = false; // opened by pointing: leaving closes it; a click keeps it
  const busy = () => !!document.querySelector(".menu, .emoji-pop, .space-pop .inline-edit");
  const leaveSoon = () => { clearTimeout(hoverT); if (pop && byHover) hoverT = setTimeout(function again() { if (!byHover) return; if (busy()) { hoverT = setTimeout(again, 400); return; } close(); }, 380); };
  const stay = () => clearTimeout(hoverT);
  function attach(b) {
    buttons.add(b);
    b.addEventListener("click", (e) => { if (pop && byHover) { byHover = false; stay(); return; } byHover = false; open(e.currentTarget); });
    b.addEventListener("contextmenu", placeMenu);
    b.addEventListener("mouseenter", () => {
      stay();
      if (pop || app.settings.spacesHover === false) return;
      hoverT = setTimeout(() => { if (!pop) { open(b); byHover = true; } }, 220);
    });
    b.addEventListener("mouseleave", () => { if (pop) leaveSoon(); else clearTimeout(hoverT); });
  }
  attach(button);

  /* Previous and next space beside every spaces button - the title bar's, the one before the
     tabs, the ribbon's - on by default. Each arrow can be switched off (the pop's settings), and
     the three dragged into the order you like (the order is the same everywhere). */
  const stepBtn = (d) => h("button", { class: "tb-btn space-step", draggable: true, dataset: { step: d < 0 ? "prev" : "next" }, onclick: () => api.step(d) }, icon(d < 0 ? "back" : "forward"));
  const stepsOf = new Map(); // a spaces button -> its { prev, next }
  const stepOrder = () => { const o = Array.isArray(app.settings.spaceStepOrder) ? app.settings.spaceStepOrder.filter((x) => ["prev", "space", "next"].includes(x)) : []; return o.length === 3 ? o : ["prev", "space", "next"]; };
  const stepOn = (k) => (app.settings.spaceSteps || { prev: true, next: true })[k] !== false;
  // where the arrows show: each place switched on by itself (a right-click on its button), none to begin with
  const arrowsAt = (place) => !!(app.settings.spaceArrows || {})[place];
  const placeOf = (host) => (host === button ? "titlebar" : ["tabs", "right", "ribbon"].find((k) => host.classList.contains("is-" + k)) || "titlebar");
  let dragging = null;
  function stepsFor(host) {
    if (stepsOf.has(host)) return stepsOf.get(host);
    const st = { prev: stepBtn(-1), next: stepBtn(1) };
    stepsOf.set(host, st);
    // drag one of the three onto another to swap their places
    for (const el of [host, st.prev, st.next]) {
      el.draggable = true;
      el.addEventListener("dragstart", (e) => { dragging = el === host ? "space" : el.dataset.step; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); clearTimeout(hoverT); });
      el.addEventListener("dragover", (e) => { if (dragging) { e.preventDefault(); el.classList.add("is-drop"); } });
      el.addEventListener("dragleave", () => el.classList.remove("is-drop"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("is-drop");
        const to = el === host ? "space" : el.dataset.step;
        if (!dragging || dragging === to) return;
        const o = stepOrder();
        const a = o.indexOf(dragging), b = o.indexOf(to);
        [o[a], o[b]] = [o[b], o[a]];
        app.setSetting("spaceStepOrder", o);
        dragging = null;
        layoutSteps();
      });
      el.addEventListener("dragend", () => { dragging = null; });
    }
    return st;
  }
  function layoutSteps() {
    const order = stepOrder();
    const at = order.indexOf("space");
    for (const host of buttons) {
      const st = stepsFor(host);
      const par = host.parentElement;
      if (!par || !host.isConnected) { st.prev.remove(); st.next.remove(); continue; }
      let ref = host;
      for (let i = at - 1; i >= 0; i--) { const el = st[order[i]]; if (ref.previousSibling !== el) par.insertBefore(el, ref); ref = el; }
      ref = host;
      for (let i = at + 1; i < order.length; i++) { const el = st[order[i]]; if (ref.nextSibling !== el) ref.after(el); ref = el; }
      const place = placeOf(host);
      for (const k of ["prev", "next"]) { st[k].hidden = host.hidden || !arrowsAt(place) || !stepOn(k) || api.list().length < 2; st[k].classList.toggle("is-ribbon", place === "ribbon"); }
      // the group's first shown element takes the push to the right that the button alone had before the tabs
      const group = order.map((x) => (x === "space" ? host : st[x])).filter((x) => !x.hidden);
      for (const x of [host, st.prev, st.next]) x.classList.toggle("is-lead", x === group[0] && place === "tabs");
    }
  }
  const setStep = (k, on) => { app.setSetting("spaceSteps", { prev: stepOn("prev"), next: stepOn("next"), [k]: on }); layoutSteps(); };

  /** Put a copy of the button in each chosen place. `slots` maps place -> (button) => mount. */
  const extras = new Map();
  function place(slots) {
    const on = new Set(app.settings.spacesAt || ["titlebar"]);
    button.hidden = !on.has("titlebar");
    layoutSteps();
    for (const [k] of PLACES) {
      if (k === "titlebar") continue;
      const has = extras.get(k);
      if (on.has(k) && !has && slots[k]) {
        const b = h("button", { class: "tb-btn space-btn is-" + k });
        attach(b);
        slots[k](b);
        extras.set(k, b);
      } else if (!on.has(k) && has) {
        has.remove();
        const st = stepsOf.get(has);
        if (st) { st.prev.remove(); st.next.remove(); stepsOf.delete(has); }
        buttons.delete(has);
        extras.delete(k);
      }
    }
    paint();
  }

  paint();
  return { paint, open, close, place };
}
