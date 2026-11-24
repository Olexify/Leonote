// Skills: small automations kept as notes. A skill is a note with
// `type: skill` at its top and its steps as a numbered list - each step one
// action from a fixed set, run by Leonote itself, in order:
//
//   ---
//   type: skill
//   name: Morning page
//   description: Yesterday's finished tasks into today's daily note
//   trigger: daily 08:00          (manual · daily HH:MM · new note in <folder>)
//   inputs: topic                 (asked for when it runs by hand)
//   ---
//   1. tasks.list which=done-yesterday → done
//   2. note.append path="{{daily}}" text="## Done yesterday\n{{done}}"
//
// Nothing here writes free text of its own: an action does what it says, and a
// decision (jev.choice, jev.yes) is one of the answers it was given. Notes are
// written the way agents write them (proposals.js): a private note is refused,
// a note in review gets a proposal, an open one is written - so a skill an agent
// wrote cannot do more than the agent could.

import { h, basename, dirname } from "./util.js";
import { icon } from "./icons.js";
import { frontMatter } from "./frontmatter.js";

/* ── reading a skill ───────────────────────────────────────────────────── */

// names the templates fill in themselves: a step's output may not take them
const BUILT_IN = ["today", "yesterday", "tomorrow", "now", "time", "weekday", "input", "note"];
const STEP_RE = /^\s*(\d+)[.)]\s+(.+?)\s*$/;
const ARG_RE = /(\w+)=("((?:[^"\\]|\\.)*)"|\S+)/g;

/** One step line: `action key=value key="a value" → name`. */
export function parseStep(line) {
  let s = line.trim();
  let out = null;
  const o = /\s*(?:→|->)\s*([\w.]+)\s*$/.exec(s);
  if (o) { out = o[1]; s = s.slice(0, o.index); }
  const act = /^([a-z][\w.]*)\b/i.exec(s);
  if (!act) return { error: "a step starts with an action, like note.append" };
  const args = {};
  for (const m of s.slice(act[0].length).matchAll(ARG_RE)) args[m[1]] = m[3] !== undefined ? m[3].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : m[2];
  return { action: act[1].toLowerCase(), args, out };
}

/** A skill note: what it says about itself, and its steps. */
export function parseSkill(text, path = "") {
  const fm = frontMatter(text);
  const body = String(text || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const steps = [];
  const errors = [];
  for (const line of body.split(/\r?\n/)) {
    const m = STEP_RE.exec(line);
    if (!m) continue;
    const st = parseStep(m[2]);
    if (st.error) errors.push(`step ${m[1]}: ${st.error}`);
    else if (!ACTIONS[st.action]) errors.push(`step ${m[1]}: no action called ${st.action}`);
    else if (st.out && BUILT_IN.includes(st.out.split(".")[0])) errors.push(`step ${m[1]}: → ${st.out} would hide {{${st.out}}} - call it something else`);
    steps.push({ n: Number(m[1]), raw: m[2], ...st });
  }
  const list = (v) => [].concat(v ?? []).flatMap((x) => String(x).split(",")).map((x) => x.trim().replace(/[{}:].*$/, "").trim()).filter(Boolean);
  return {
    path, name: String(fm.name || basename(path).replace(/\.md$/i, "")), description: String(fm.description || ""),
    trigger: String(fm.trigger || "manual").trim(), inputs: list(fm.inputs), fallback: String(fm.fallback || "stop"),
    review: String(fm.mode || "") === "review", steps, errors,
  };
}

/** `daily 08:00` / `new note in Inbox` / `manual`. */
export function parseTrigger(t) {
  const s = String(t || "").trim();
  let m = /^daily\s+(\d{1,2}):(\d{2})$/i.exec(s);
  if (m) return { kind: "daily", h: Number(m[1]), m: Number(m[2]) };
  m = /^new note in\s+"?([^"]*?)"?\s*$/i.exec(s);
  if (m) return { kind: "newnote", folder: m[1].replace(/^\/+|\/+$/g, "") };
  return { kind: "manual" };
}

/* ── templates and conditions ── */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const show = (v) => (v == null ? "" : Array.isArray(v) ? v.map((x) => "- " + show(x)).join("\n") : typeof v === "object" ? (v.text ?? JSON.stringify(v)) : String(v));

/** {{name}}, {{input.x}}, {{today}}... filled from `vars`; a list becomes "- " lines. */
export function fill(text, vars, now = new Date()) {
  const day = (k) => { const d = new Date(now); d.setDate(d.getDate() + k); return ymd(d); };
  const base = { today: day(0), yesterday: day(-1), tomorrow: day(1), now: `${ymd(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}`, weekday: now.toLocaleDateString("en", { weekday: "long" }) };
  return String(text ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const path = k.split(".");
    let v = path[0] in vars ? vars[path[0]] : base[path[0]];
    for (const p of path.slice(1)) v = v == null ? v : v[p];
    return show(v);
  });
}

/** A step's `if=` as written, its sides filled in only after the split: a filled-in value ("no != maybe",
    "not yes") cannot add an operator of its own and turn the condition round. */
export function holdsIn(cond, vars) {
  const c = String(cond ?? "").trim();
  let m = /^([\s\S]*?)\s*(==|!=)\s*([^=!]*)$/.exec(c);
  if (m) { const eq = fill(m[1], vars).trim().toLowerCase() === fill(m[3], vars).trim().toLowerCase(); return m[2] === "==" ? eq : !eq; }
  m = /^not\s+([\s\S]*)$/i.exec(c);
  if (m) return !holdsIn(m[1], vars);
  const v = fill(c, vars).trim();
  return !!v && !/^(no|false|0|none|null)$/i.test(v);
}

/** `a == b`, `a != b`, `not a`, or just `a` (something, not "no" / "false" / "0"). */
export function holds(cond) {
  const c = String(cond ?? "").trim();
  // the sides may be lists filled in over several lines: the last == or != splits them
  let m = /^([\s\S]*?)\s*(==|!=)\s*([^=!]*)$/.exec(c);
  if (m) { const eq = m[1].trim().toLowerCase() === m[3].trim().toLowerCase(); return m[2] === "==" ? eq : !eq; }
  m = /^not\s+([\s\S]*)$/i.exec(c);
  if (m) return !holds(m[1]);
  return !!c && !/^(no|false|0|none|null)$/i.test(c);
}

/* ── the actions ───────────────────────────────────────────────────────── */

const notePath = (p) => { const s = String(p || "").trim().replace(/^\/+/, ""); if (!s) throw new Error("a path is needed"); if (s.startsWith("@")) throw new Error("skills work on notes in the vault only"); return /\.md$/i.test(s) ? s : s + ".md"; };

/**
 * Each action: (ctx, args) => output. `ctx` has the app, the skill and its
 * `write(path, text, kind)` - which goes through the note's AI access.
 */
export const ACTIONS = {
  "note.read": async (c, a) => { const n = c.app.vault.notes.get(notePath(a.path)); if (!n) throw new Error(`no note at ${a.path}`); if (c.access(n.path, n.content) === "private") throw new Error(`${n.path} is private`); return n.content; },
  "note.append": async (c, a) => {
    const p = notePath(a.path); const old = (c.app.vault.notes.get(p) || {}).content ?? ""; const text = String(a.text ?? "").trimEnd();
    // today's daily note kept in one note a year: under today's heading, not at the end of the file (yesterday's)
    const day = c.app.underToday && c.app.dailyPath && p === c.app.dailyPath(fill("{{today}}", {})) ? c.app.underToday(old, "\n" + text) : null;
    if (day != null) return c.write(p, day.replace(/\s*$/, "") + "\n", "append");
    const sep = !old || old.endsWith("\n\n") ? "" : old.endsWith("\n") ? "\n" : "\n\n"; return c.write(p, old + sep + text + "\n", "append");
  },
  "note.write": async (c, a) => c.write(notePath(a.path), String(a.text ?? ""), "write"),
  "note.create": async (c, a) => { const p = notePath(a.path); if (c.app.vault.notes.has(p)) return p; return c.write(p, String(a.text ?? ""), "write"); },
  "note.tag": async (c, a) => { const p = notePath(a.path); const n = c.app.vault.notes.get(p); if (!n) throw new Error(`no note at ${a.path}`); const tags = String(a.tags || "").split(/[\s,]+/).filter(Boolean).map((t) => "#" + t.replace(/^#/, "")); const has = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}_/-])", "u").test(n.content); const missing = tags.filter((t) => !has(t)); /* #work is not there because #workout is */ if (!missing.length) return p; return c.write(p, n.content.replace(/\s*$/, "") + "\n\n" + missing.join(" ") + "\n", "write"); },
  "note.move": async (c, a) => { const p = notePath(a.path); if (!c.app.vault.notes.has(p)) throw new Error(`no note at ${a.path}`); if (c.access(p) !== "open") throw new Error(`${p} is not open to skills: moving needs its folder set to Open`); const to = String(a.to || "").replace(/^\/+|\/+$/g, ""); if (/(^|\/)\.\.?(\/|$)/.test(to) || (c.app.proposals ? c.app.proposals.accessOf(to) : "review") !== "open" || c.access((to ? to + "/" : "") + basename(p) + ".md") !== "open") throw new Error(`${to || "the vault's top"} is not open to skills: moving into it needs it set to Open`); await c.app.moveNote(p, to); return (to ? to + "/" : "") + basename(p) + ".md"; },
  // the user's own task (owner: ai would hand it to agents' next_task), marked with the skill that made it
  "tasks.add": async (c, a) => c.app.tasks.create(String(a.text || "").trim() || "(untitled)", { from_skill: c.skill.name, priority: ["high", "medium", "low"].includes(a.priority) ? a.priority : "none", due_date: a.due && /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? a.due : null }),
  "tasks.list": async (c, a) => {
    // the user keeping their own tasks apart from AI ("tasks": "split"): a skill sees only AI's, as agents do
    const split = !!c.app.proposals && c.app.proposals.tasksSplit();
    const all = (c.app.tasks.all || []).filter((t) => !t.deleted && (!split || (t.owner === "ai" && !(Number(t.ai_from) > Date.now()))));
    const day = (k) => { const d = new Date(); d.setDate(d.getDate() + k); return ymd(d); };
    const doneOn = (t, d) => t.done && String(t.completed_at || "").slice(0, 10) === d;
    const pick = { open: (t) => !t.done, "due-today": (t) => !t.done && t.due_date && t.due_date <= day(0), overdue: (t) => !t.done && t.due_date && t.due_date < day(0), "done-today": (t) => doneOn(t, day(0)), "done-yesterday": (t) => doneOn(t, day(-1)) }[a.which || "open"];
    if (!pick) throw new Error(`tasks.list which= is one of open, due-today, overdue, done-today, done-yesterday`);
    return all.filter(pick).slice(0, Number(a.limit) || 50).map((t) => t.text);
  },
  search: async (c, a) => {
    const words = String(a.query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("search needs a query");
    const hits = [...c.app.vault.notes.values()].filter((n) => c.access(n.path, n.content) !== "private" && words.every((w) => (n.path + "\n" + n.content).toLowerCase().includes(w)));
    return hits.sort((x, y) => (y.mtime || 0) - (x.mtime || 0)).slice(0, Number(a.limit) || 10).map((n) => `[[${n.path.replace(/\.md$/i, "")}]]`);
  },
  "jev.choice": async (c, a, out, vars) => {
    const options = String(a.options || "").split("|").map((x) => x.trim()).filter(Boolean);
    if (options.length < 2) throw new Error('jev.choice needs options="one|two|three"');
    const crit = Object.fromEntries(options.map((o) => [o, o]));
    const res = await c.app.host.jevAsk({ state: String(a.state ?? ""), questions: { q: { type: "choice", instructions: String(a.question || "Which fits?"), criteria: crit } } });
    const ans = res.answers.q;
    if (out) vars[out + "_confidence"] = Math.round((ans.confidence || 0) * 100) / 100;
    return ans.confidence >= (Number(a.min) || 0) ? ans.choice : "unsure";
  },
  "jev.yes": async (c, a, out, vars) => {
    const res = await c.app.host.jevAsk({ state: String(a.state ?? ""), questions: { q: { type: "noul", instructions: String(a.question || "Is this true?") } } });
    const p = res.answers.q.noul;
    if (out) vars[out + "_p"] = Math.round(p * 100) / 100;
    return p >= (Number(a.min) || 0.5) ? "yes" : "no";
  },
  set: async (c, a) => String(a.value ?? ""),
  notify: async (c, a) => { c.app.toast(String(a.text ?? ""), { ms: 5000 }); return ""; },
  open: async (c, a) => { const p = notePath(a.path); c.app.openNote(p, { newTab: true }); return p; },
  stop: async () => { throw Object.assign(new Error("stopped"), { stop: true }); },
};

/** What each action is for - the list a new skill carries, and the help. */
export const ACTION_HELP = [
  ["note.read path=", "a note's text → name"],
  ["note.append path= text=", "add to the end of a note (made if missing)"],
  ["note.write path= text=", "the whole text of a note"],
  ["note.create path= text=", "a note, only if it is not there yet"],
  ["note.tag path= tags=", "add tags, space-separated"],
  ["note.move path= to=", "into a folder (the note's folder must be Open)"],
  ["tasks.add text= priority= due=", "a task; priority high/medium/low, due YYYY-MM-DD"],
  ["tasks.list which=", "open, due-today, overdue, done-today, done-yesterday → name"],
  ["search query= limit=", "notes with every word → name (as [[links]])"],
  ["jev.choice state= question= options=\"a|b\" min=", "Jev picks one → name (and name_confidence)"],
  ["jev.yes state= question= min=", "Jev answers yes or no → name (and name_p)"],
  ["set value=", "a value → name"],
  ["notify text=", "a message on screen"],
  ["open path=", "open a note"],
  ["stop", "end here - with if=, an early way out"],
];

/* ── running ───────────────────────────────────────────────────────────── */

export function createSkills(app) {
  const S = app.settings;

  /** Every skill in the vault: notes saying type: skill. */
  function all() {
    const out = [];
    for (const n of app.vault.notes.values()) {
      // the note's own front matter, at its very top - not a skill shown as an example further down
      if (!n.content.startsWith("---") || String(frontMatter(n.content).type || "").toLowerCase() !== "skill") continue;
      out.push(parseSkill(n.content, n.path));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  const accessOf = (path, content) => (app.proposals ? app.proposals.noteAccess(path, content) : "review");
  /** A note's text for a skill: empty when the note is private. */
  const textFor = (path) => { const c = (app.vault.notes.get(path) || {}).content || ""; return accessOf(path, c) === "private" ? "" : c; };

  // notes a skill makes while it runs start no skills of their own: one skill writing into a
  // folder another watches (or itself) would otherwise never stop
  // (the paths it writes are kept for a moment, so only those are skipped - not every note that syncs in meanwhile)
  const own = new Set();
  // runs go one after another: twenty notes synced in at once do not race each other's appends
  let queue = Promise.resolve();
  // only runs that start by themselves wait in it; a run asked for by hand goes at once. At most 20 wait at a time,
  // however the notes arrive (in one batch or in waves)
  let waiting = 0, skippedSaid = false;
  function run(skill, inputs = {}, opts = {}) {
    if (!opts.trigger || !/^(new note |daily )/.test(opts.trigger)) return runOnce(skill, inputs, opts);
    if (waiting >= 20) {
      if (!skippedSaid) { skippedSaid = true; app.toast("Many new notes at once: skills for the ones past the first 20 were skipped - run the skill by hand for those", { ms: 10000 }); }
      return Promise.resolve(null);
    }
    waiting++;
    const go = queue.then(() => runOnce(skill, inputs, opts)).finally(() => { if (--waiting === 0) skippedSaid = false; });
    queue = go.catch(() => {});
    return go;
  }
  async function runOnce(skill, inputs = {}, { trigger = "by hand", note = null } = {}) {
    // the note that started it: its text only if it is not private - a private note's words go to no skill (nor on to Jev)
    // {{daily}}: where today's daily note is as Settings say (one note a year by default, Diary/2026.md)
    const vars = { input: inputs, daily: app.dailyPath ? app.dailyPath(fill("{{today}}", {})) : `Daily/${fill("{{today}}", {})}.md`, note: note ? { path: note, title: basename(note).replace(/\.md$/i, ""), text: textFor(note) } : {} };
    const log = [];
    let ok = true, proposals = 0;
    const ctx = {
      app, skill, access: accessOf,
      async write(path, content, kind) {
        // a skill started by a new note in a folder makes no new note there: on two computers sharing the vault,
        // each one's note would start the other's skill, for ever
        const t = parseTrigger(skill.trigger);
        if (t.kind === "newnote" && trigger.startsWith("new note ") && !app.vault.notes.has(path) && (dirname(path) === t.folder || (!t.folder && !path.includes("/")))) throw new Error(`${path}: a skill started by a new note makes no new notes in the folder it watches`);
        own.add(path); setTimeout(() => own.delete(path), 5000);
        const r = await app.proposals.writeFor(path, content, kind, `skill: ${skill.name}`, `${skill.name} (${trigger})`, { review: skill.review });
        if (r === "private") throw new Error(`${path} is private`);
        if (r === "proposed") { proposals++; return path + " (proposed)"; }
        return path;
      },
    };
    if (skill.errors.length) { log.push({ ok: false, text: skill.errors.join("; ") }); ok = false; }
    else for (const st of skill.steps) {
      const args = Object.fromEntries(Object.entries(st.args).map(([k, v]) => [k, fill(v, vars)]));
      if ("if" in st.args && !holdsIn(st.args.if, vars)) { log.push({ n: st.n, ok: true, text: `${st.action} - skipped` }); continue; }
      try {
        const res = await ACTIONS[st.action](ctx, args, st.out, vars);
        if (st.out) vars[st.out] = res;
        log.push({ n: st.n, ok: true, text: `${st.action}${st.out ? " → " + st.out : ""}${res && typeof res === "string" && res.length < 80 ? ": " + res : Array.isArray(res) ? `: ${res.length}` : ""}` });
      } catch (e) {
        if (e.stop) { log.push({ n: st.n, ok: true, text: "stopped here" }); break; }
        log.push({ n: st.n, ok: false, text: `${st.action}: ${e.message || e}` });
        ok = false;
        if (skill.fallback !== "continue") break;
      }
    }
    const runs = [{ name: skill.name, path: skill.path, at: new Date().toISOString(), trigger, ok, proposals, log }, ...(S.skillRuns || [])].slice(0, 60);
    app.setSetting("skillRuns", runs);
    app.toast(`${skill.name}: ${ok ? "done" : "stopped - " + (log.find((l) => !l.ok) || {}).text}${proposals ? ` · ${proposals} edit${proposals === 1 ? "" : "s"} to review` : ""}`, { kind: ok ? undefined : "error", ms: 5000, action: proposals ? { label: "Review", run: () => app.proposals.review() } : { label: "Log", run: () => panel(skill.path) } });
    return { ok, log, vars };
  }

  async function runAsking(skill) {
    let inputs = {};
    if (skill.inputs.length) {
      const { askDialog } = await import("./ui.js");
      const r = await askDialog(skill.name, skill.inputs.map((k) => ({ key: k, label: k })), { ok: "Run", text: skill.description });
      if (!r) return null;
      inputs = r;
    }
    return run(skill, inputs);
  }

  /* ── triggers: a time of day, a new note in a folder ── */
  /* A skill that runs by itself came, maybe, with a synced or shared vault - someone else's steps. It runs on
     its own only once allowed on this computer, for exactly the text it has (an edit asks again). The yes is
     kept in this computer's own storage, never in the vault. A skill run by hand needs no yes. */
  const OK_KEY = "leonote.skills.allowed";
  const allowedMap = () => { try { return JSON.parse(localStorage.getItem(OK_KEY) || "{}") || {}; } catch { return {}; } };
  // SHA-256 of the skill's text: no other text can be made to pass as the one that was allowed
  const sha = async (text) => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text || "")); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); };
  const stamp = (sk) => sha((app.vault.notes.get(sk.path) || {}).content || "");
  const allowed = async (sk) => allowedMap()[sk.path] === await stamp(sk);
  const asked = new Set();
  /** Allow exactly the text that asked (`h`), and run it only if that is still the text on disk. */
  async function allowAndRun(sk, h, inputs, meta) {
    const m = allowedMap(); m[sk.path] = h; try { localStorage.setItem(OK_KEY, JSON.stringify(m)); } catch { /* fine */ }
    if (await stamp(sk) !== h) return app.toast(`“${sk.name}” changed since it asked - it will ask again`, { ms: 4000 });
    run(sk, inputs, meta);
  }
  /** Run a triggered skill only once it is allowed here; else ask once this session. */
  async function runOwn(sk, inputs, meta) {
    const h = await stamp(sk);
    if (allowedMap()[sk.path] === h) return run(sk, inputs, meta);
    if (asked.has(sk.path)) return;
    asked.add(sk.path);
    // what it would do, said before the yes: a skill that came with a synced vault is someone else's steps
    const does = [...new Set(sk.steps.map((st) => st.action))].join(", ");
    app.toast(`The skill “${sk.name}” wants to run by itself (${meta.trigger})${does ? " - it does: " + does : ""}. Skills that run on their own need your yes once on this computer.`, {
      ms: 20000, action: { label: "See its steps…", run: async () => {
        // the whole of each step, what it acts on included, before the yes
        const { confirmDialog } = await import("./ui.js");
        if (await confirmDialog(`Let “${sk.name}” run by itself?`, `It runs ${meta.trigger}. Its steps:\n${stepsText(sk)}`, { ok: "Allow and run", danger: false, safe: true })) allowAndRun(sk, h, inputs, meta);
      } } });
  }
  /** A skill's steps as written - the action and what it acts on - so a yes is to what it does. */
  // where it acts is never cut: only a long text= is shortened
  // built from what the parser took, not from the raw line: what is shown is what runs
  const stepsText = (sk) => sk.steps.map((st, i) => {
    const args = Object.entries(st.args || {}).sort(([a], [b]) => (a === "text") - (b === "text")).map(([k, v]) => { v = String(v).replace(/\s+/g, " "); return `${k}=${JSON.stringify(k === "text" && v.length > 200 ? v.slice(0, 200) + "… (more in the note)" : v)}`; });
    return `${i + 1}. ${[st.action, ...args].join(" ")}${st.out ? " → " + st.out : ""}`;
  }).join("\n");
  /** Picked by the quick box (Enter, Jev's first guess) rather than by name: never allowed here, its steps are shown first and the yes allows it. */
  async function confirmOnce(sk) {
    const h = await stamp(sk);
    if (allowedMap()[sk.path] === h) return true;
    const { confirmDialog } = await import("./ui.js");
    const steps = stepsText(sk);
    const auto = parseTrigger(sk.trigger).kind !== "manual" ? `\n\nYour yes also lets it run by itself (${sk.trigger}).` : "";
    if (!(await confirmDialog(`Run “${sk.name}”?`, `You have not run this skill from here yet. Its steps:\n${steps}${auto}`, { ok: "Allow and run", danger: false, safe: true }))) return false;
    const m = allowedMap(); m[sk.path] = h; try { localStorage.setItem(OK_KEY, JSON.stringify(m)); } catch { /* fine */ }
    return (await stamp(sk)) === h;
  }
  const lastDaily = () => S.skillDaily || {};
  // a skill's time of day: checked when the next one is due (at most 15 minutes off, so a skill added or
  // changed in the meantime, or a clock that jumped, is caught) - not every half minute
  function dailyCheck() {
    const now = new Date();
    const today = ymd(now);
    let wait = 15 * 60000;
    for (const sk of all()) {
      const t = parseTrigger(sk.trigger);
      if (t.kind !== "daily") continue;
      const at = new Date(now);
      at.setHours(t.h, t.m, 0, 0);
      if (lastDaily()[sk.path] !== today && at <= now) {
        app.setSetting("skillDaily", { ...lastDaily(), [sk.path]: today });
        runOwn(sk, {}, { trigger: `daily ${pad(t.h)}:${pad(t.m)}` });
      }
      if (at <= now) at.setDate(at.getDate() + 1);
      wait = Math.min(wait, at - now);
    }
    setTimeout(dailyCheck, Math.max(1000, wait + 500));
  }
  setTimeout(dailyCheck, 3000);
  // new notes are gathered for a moment: an import of a thousand notes reads the skills once, not a thousand times
  const fresh = new Set();
  let freshT = 0;
  const onNew = (path) => {
    if (!path || !/\.md$/i.test(path) || own.has(path)) return;
    fresh.add(path);
    clearTimeout(freshT);
    freshT = setTimeout(() => {
      const sks = all().map((sk) => [sk, parseTrigger(sk.trigger)]).filter(([, t]) => t.kind === "newnote");
      const paths = [...fresh];
      fresh.clear();
      for (const path of paths) for (const [sk, t] of sks) {
        if (sk.path !== path && (dirname(path) === t.folder || (!t.folder && !path.includes("/")))) runOwn(sk, { text: textFor(path) }, { trigger: `new note ${path}`, note: path });
      }
    }, 250);
  };
  app.vault.bus.on("changed", (e) => { if (e && e.isNew) onNew(e.path); });
  app.vault.bus.on("structure", (e) => { if (e && e.created) onNew(e.created); });

  /* ── asking: say what you want, Jev picks the skill ── */
  async function ask() {
    const skills = all().filter((s) => !s.errors.length);
    if (!skills.length) return app.toast("No skills yet - Ctrl+P › Skills › New skill", { ms: 3500 });
    const { askDialog } = await import("./ui.js");
    const r = await askDialog("What should be done?", [{ key: "text", label: "In your words", placeholder: "e.g. put yesterday's finished tasks in today's note" }], { ok: "Find the skill" });
    if (!r || !r.text.trim()) return;
    let pick = null;
    try {
      const res = await app.host.jevAsk({ state: r.text, questions: { skill: { type: "choice", instructions: "Which of these skills does the request ask for?", criteria: { ...Object.fromEntries(skills.map((s, i) => ["s" + i, s.description ? { what: s.name, does: s.description } : s.name])), none: "None of them" } } } });
      const a = res.answers.skill;
      if (a.choice !== "none" && a.confidence >= 0.6) pick = { skill: skills[Number(a.choice.slice(1))], sure: a.confidence };
    } catch (e) { return app.toast("Jev: " + e, { kind: "error", ms: 5000 }); }
    if (!pick) return app.toast("No skill fits that well enough", { ms: 3000, action: { label: "Skills", run: () => panel() } });
    // never run from here before: its steps are shown and the yes allows it, as in the quick box (a description is the
    // skill's own words, an agent can write a harmless one); allowed already: Jev's guess is still confirmed
    if (allowedMap()[pick.skill.path] !== (await stamp(pick.skill))) { if (!(await confirmOnce(pick.skill))) return; }
    else {
      const { confirmDialog } = await import("./ui.js");
      if (!(await confirmDialog(`Run “${pick.skill.name}”?`, `${pick.skill.description || ""}\nJev is ${Math.round(pick.sure * 100)}% sure this is the one.`, { ok: "Run", danger: false }))) return;
    }
    run(pick.skill, { text: r.text }, { trigger: "asked" });
  }

  /* ── the panel ── */
  async function newSkill() {
    const { askDialog } = await import("./ui.js");
    const r = await askDialog("A new skill", [{ key: "name", label: "Its name", placeholder: "Morning page" }], { ok: "Make it" });
    if (!r || !r.name.trim()) return;
    const name = r.name.trim();
    const path = `Skills/${name.replace(/[\\/:*?"<>|]+/g, " ").trim()}.md`;
    const text = `---\ntype: skill\nname: ${name}\ndescription: What it does, in one line - Jev reads this to pick it\ntrigger: manual\n---\n# ${name}\n\n1. tasks.list which=done-yesterday → done\n2. note.append path="{{daily}}" text="## Done yesterday\\n{{done}}"\n3. notify text="${name}: done"\n\n## Actions\n\n${ACTION_HELP.map(([a, d]) => `- \`${a}\` - ${d}`).join("\n")}\n\nAny step can take \`if="{{name}} == yes"\` to run only then. {{today}}, {{daily}} (today's daily note), {{yesterday}}, {{now}}, {{input.<name>}} and {{note.title}} / {{note.text}} (the note that triggered it) fill in. \`trigger:\` is manual, \`daily 08:00\`, or \`new note in Inbox\`. \`mode: review\` makes every write a proposal.\n`;
    if (app.vault.notes.has(path)) return app.openNote(path, { newTab: true });
    await app.vault.write(path, text, {});
    app.openNote(path, { newTab: true });
  }

  /** The skills as a list with Run and Open, into `body` - the panel's and the AI home's. Returns its repaint. */
  function listInto(body, { close = () => {}, focusPath = null } = {}) {
    const paint = () => {
      const skills = all();
      const runs = S.skillRuns || [];
      body.replaceChildren(...(skills.length ? skills.map((sk) => {
        const last = runs.find((x) => x.path === sk.path);
        const logEl = last ? h("details", { class: "sk-log", open: focusPath === sk.path }, h("summary", { text: `Last run ${new Date(last.at).toLocaleString()} · ${last.trigger} · ${last.ok ? "done" : "stopped"}${last.proposals ? ` · ${last.proposals} to review` : ""}` }),
          ...last.log.map((l) => h("div", { class: "sk-log-line" + (l.ok ? "" : " is-bad"), text: `${l.n ? l.n + ". " : ""}${l.text}` }))) : null;
        return h("div", { class: "sk-item" + (sk.errors.length ? " is-bad" : "") },
          h("div", { class: "sk-item-head" },
            h("div", {}, h("div", { class: "sk-name", text: sk.name }), h("div", { class: "sk-sub", text: [sk.description, `${sk.steps.length} step${sk.steps.length === 1 ? "" : "s"}`, sk.trigger !== "manual" ? sk.trigger : ""].filter(Boolean).join(" · ") })),
            h("span", { class: "fit-fill" }),
            h("button", { class: "btn", onclick: () => { close(); app.openNote(sk.path, { newTab: true }); } }, "Open"),
            h("button", { class: "btn btn-primary", disabled: !!sk.errors.length, onclick: async () => { await runAsking(sk); paint(); } }, icon("play"), "Run")),
          sk.errors.length ? h("div", { class: "sk-err", text: sk.errors.join(" · ") }) : null,
          logEl);
      }) : [h("div", { class: "skl-empty", text: "No skills yet. A skill is a note with type: skill and numbered steps - make one and it shows here." })]));
    };
    paint();
    return paint;
  }

  function panel(focusPath) {
    const back = h("div", { class: "dlg-back" });
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    const body = h("div", { class: "sk-list" });
    listInto(body, { close, focusPath });
    back.append(h("div", { class: "dlg sk-dlg" },
      h("div", { class: "sk-top" }, h("h3", { class: "dlg-title" }, icon("bolt"), " Skills"), h("span", { class: "sk-sub", text: "Notes that do things, step by step" }), h("span", { class: "fit-fill" }),
        h("button", { class: "btn", onclick: () => { close(); ask(); } }, icon("sparkles"), "Ask…"),
        h("button", { class: "btn", onclick: () => { close(); newSkill(); } }, icon("plus"), "New skill"),
        h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
      body));
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
  }

  return { all, run, runAsking, ask, panel, newSkill, listInto, allowed, confirmOnce };
}
