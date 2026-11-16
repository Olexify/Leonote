// Tasks: the same objects the Python app and every AI agent read. The UI only
// ever sends sparse ops ({id, field: value}); Rust appends them to log/ui.jsonl
// and the fold decides the truth. Local state updates optimistically.

import { emitter, localIso, uuid, dayKey } from "./util.js";

export const ORD_GAP = 1024;
const DAY = 86400000;
export const TRASH_KEEP = DAY; // how long a trashed task waits before it is gone
const stamp = () => localIso().slice(0, 19);
const same = (a, b) => a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

/** Keeping under a third of a task's text is a loss, not an edit. */
const SHRINK = 0.3;

/**
 * What a write would destroy, or null when it destroys nothing. `before` is
 * the task as it stands; `fields` is the sparse op about to be applied.
 */
export function losses(before, fields) {
  if (!before || !fields) return null;
  const out = {};
  const oldText = String(before.text || "");
  if ("text" in fields) {
    const next = fields.text == null ? "" : String(fields.text);
    if (oldText.trim() && (!next.trim() || next.length < oldText.length * SHRINK)) out.text = oldText;
  }
  if ("subtasks" in fields) {
    const oldSteps = Array.isArray(before.subtasks) ? before.subtasks : [];
    const next = Array.isArray(fields.subtasks) ? fields.subtasks : [];
    // by id where there are ids, so reordering reads as reordering and a
    // swap (one out, one in) is still seen for what it is; by count otherwise
    const ided = oldSteps.every((s) => s && s.id);
    const keptIds = new Set(next.map((s) => s && s.id).filter(Boolean));
    const gone = ided ? oldSteps.filter((s) => !keptIds.has(s.id)) : [];
    if (oldSteps.length && (next.length < oldSteps.length || gone.length)) {
      out.subtasks = oldSteps.map((s) => ({ ...s }));
      out.stepsLost = gone.length || oldSteps.length - next.length;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Plain words for the toast that offers the way back. */
export function lossText(before, lost) {
  const name = String((before && before.text) || "task").replace(/\s+/g, " ").slice(0, 40);
  if (lost.text && lost.subtasks) return `“${name}” was emptied`;
  if (lost.text) return `“${name}” lost its text`;
  const n = lost.stepsLost || lost.subtasks.length;
  return `“${name}” lost ${n === 1 ? "a step" : `${n} steps`}`;
}

// hooks: { created(), toggled(task, done), subtasks(deltaDone, task) } - fired
// for the user's own actions only, never for agent or Python changes, so XP
// is earned by doing things, not by an agent's log.
//
// hooks.risky({ id, text, restore }) - a write was about to blank a task or
// drop its steps. It still goes through (refusing would lose the edit just as
// silently), but never without a way back.
export function createTaskStore(host, hooks = {}) {
  const bus = emitter();
  const byId = new Map();
  const sortKey = new Map();
  const touchedBy = new Map(); // id -> { by, at }  (external writers, this session)
  let list = [];

  function rebuild() {
    list = [...byId.values()].sort((a, b) => sortKey.get(a.id) - sortKey.get(b.id) || (a.id < b.id ? -1 : 1));
  }
  const maxKey = () => { let m = 0; for (const v of sortKey.values()) m = Math.max(m, v); return m; };
  const minKey = () => { let m = Infinity; for (const v of sortKey.values()) m = Math.min(m, v); return m === Infinity ? 0 : m; };

  function applyPatch(patch, writers) {
    const changed = new Set();
    const keys = new Map(); // id -> Set of changed field names
    let structural = false;
    for (const id in patch) {
      const v = patch[id];
      if (v === null) {
        if (byId.delete(id)) { sortKey.delete(id); structural = true; changed.add(id); }
        continue;
      }
      let t = byId.get(id);
      if (!t) {
        t = { ...v, id };
        byId.set(id, t);
        sortKey.set(id, typeof v.ord === "number" ? v.ord : maxKey() + ORD_GAP);
        structural = true;
        changed.add(id);
        keys.set(id, new Set(Object.keys(v)));
      } else {
        // an agent or the Python app emptying a task the user may be in the
        // middle of: apply it, but hand back the way to undo it
        if (writers && writers.length) guard(id, v, false);
        let any = false;
        for (const k in v) {
          if (k === "id" || same(t[k], v[k])) continue;
          t[k] = v[k];
          any = true;
          if (!keys.has(id)) keys.set(id, new Set());
          keys.get(id).add(k);
          if (k === "ord" && typeof v[k] === "number") { sortKey.set(id, v[k]); structural = true; }
        }
        if (any) changed.add(id);
      }
      if (changed.has(id) && writers && writers.length) touchedBy.set(id, { by: writers.join(", "), at: Date.now() });
    }
    if (structural) rebuild();
    if (changed.size) bus.emit("changed", { ids: changed, keys, structural, writers: writers || null });
    return changed;
  }

  /**
   * Nothing may empty a task or drop its steps without an undo. Called before
   * the write, so `before` is still the truth. `expected` is for the actions
   * whose whole point is to remove something (delete a step, trash a task).
   */
  function guard(id, fields, expected) {
    if (expected || !hooks.risky) return;
    const before = byId.get(id);
    const lost = losses(before, fields);
    if (!lost) return;
    // only the fields themselves go back, never the bookkeeping beside them
    const snapshot = {};
    if ("text" in lost) snapshot.text = lost.text;
    if ("subtasks" in lost) snapshot.subtasks = lost.subtasks;
    hooks.risky({
      id,
      text: lossText(before, lost),
      restore: () => send([{ id, ...snapshot }]),
    });
  }

  async function send(ops) {
    const local = {};
    for (const op of ops) {
      const { id, $unset, ...rest } = op;
      local[id] = Object.assign(local[id] || {}, rest);
      if ($unset) for (const k of $unset) local[id][k] = null;
    }
    applyPatch(local);
    try {
      const res = await host.taskOps(ops);
      if (res && res.patch) applyPatch(res.patch);
    } catch (err) {
      bus.emit("error", err);
    }
  }

  // gone for good means its words too: blanked here, then every old copy the store keeps
  // (rotated snapshots and logs) scrubbed of them - a key typed into a task does not live on
  function purge(ids) {
    return Promise.resolve(send(ids.map((id) => ({ id, purged: true, text: "", subtasks: [] }))))
      .then(() => host.tasksErase && host.tasksErase(ids))
      .catch(() => {});
  }

  const today = () => dayKey();

  const buckets = {
    inbox: (t) => !t.deleted && !t.done && (!t.start_date || t.start_date <= today()),
    upcoming: (t) => !t.deleted && !t.done && !!t.start_date && t.start_date > today(),
    today: (t) => !t.deleted && !t.done && !!t.due_date && t.due_date <= today(),
    done: (t) => !t.deleted && t.done && (!t.completed_at || Date.now() - new Date(t.completed_at) <= DAY),
    archive: (t) => !t.deleted && t.done && !!t.completed_at && Date.now() - new Date(t.completed_at) > DAY,
    // a purged task is gone for good - it is only still in the log so that
    // the Python app and this one agree about why it disappeared
    trash: (t) => !!t.deleted && !t.purged,
    // the tasks given to AI (owner: ai), open - their own list when the user keeps theirs apart
    ai: (t) => !t.deleted && !t.done && t.owner === "ai",
  };

  return {
    bus,
    buckets,
    touchedBy,
    get all() { return list; },
    get: (id) => byId.get(id),

    load(tasks) {
      byId.clear();
      sortKey.clear();
      tasks.forEach((t, i) => {
        byId.set(t.id, t);
        sortKey.set(t.id, typeof t.ord === "number" ? t.ord : i * ORD_GAP);
      });
      rebuild();
    },

    applyPatch,

    select(bucket) {
      const f = buckets[bucket];
      const rows = list.filter(f);
      if (bucket === "done" || bucket === "archive")
        rows.sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
      if (bucket === "trash") rows.sort((a, b) => String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")));
      if (bucket === "upcoming") rows.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
      return rows;
    },

    count: (bucket) => list.reduce((n, t) => n + (buckets[bucket](t) ? 1 : 0), 0),

    /** opts.silent: created by the app itself (recurring), not the user - no XP */
    create(text, extra = {}, opts = {}) {
      const id = uuid();
      send([{
        id,
        text,
        done: false,
        created: stamp(),
        priority: "none",
        subtasks: [],
        deleted: false,
        start_date: null,
        due_date: null,
        due_time: "",
        scheduled_jumped: false,
        due_jumped: false,
        ord: minKey() - ORD_GAP,
        ...extra,
      }]);
      if (hooks.created && !opts.silent) hooks.created(byId.get(id));
      return id;
    },

    toggle(id) {
      const t = byId.get(id);
      if (!t) return;
      const done = !t.done;
      send([{ id, done, completed_at: done ? stamp() : null }]);
      if (hooks.toggled) hooks.toggled(t, done);
    },

    update: (id, fields, opts = {}) => { guard(id, fields, opts.expected); return send([{ id, ...fields }]); },
    trash: (id) => send([{ id, deleted: true, deleted_at: stamp() }]),

    /** How long a trashed task has left, in ms (0 once it is up). */
    trashLeft: (t) => {
      if (!t || !t.deleted || t.purged) return 0;
      if (!t.deleted_at) return TRASH_KEEP; // no stamp: it waits a full day
      return Math.max(0, TRASH_KEEP - (Date.now() - new Date(t.deleted_at).getTime()));
    },

    /**
     * Empty what is past its day. The Python app does this too (its
     * `_purge_old_trash`); doing it here as well means the promise holds
     * whether or not that app ever runs again.
     */
    sweepTrash(force = false) {
      const gone = list.filter((t) => {
        if (!t.deleted || t.purged) return false;
        if (force) return true;
        // no stamp, no clock: it waits until something gives it one
        return !!t.deleted_at && Date.now() - new Date(t.deleted_at).getTime() >= TRASH_KEEP;
      });
      // what "Delete for good" left readable before it erased its words too
      const left = list.filter((t) => t.deleted && t.purged && (t.text || (t.subtasks || []).length));
      if (gone.length || left.length) purge([...gone, ...left].map((t) => t.id));
      return gone.length;
    },
    purge,
    restore: (id) => send([{ id, deleted: false, deleted_at: null }]),

    /** These tasks in this order, in the places they hold now: the others stay where they are. One send. */
    reorder(ids) {
      const keys = ids.map((id) => sortKey.get(id)).filter((k) => k != null).sort((a, b) => a - b);
      if (keys.length !== ids.length) return;
      send(ids.map((id, i) => ({ id, ord: keys[i] })));
    },

    /** Move `id` between two neighbours (either may be null). */
    place(id, beforeId, afterId) {
      const a = beforeId ? sortKey.get(beforeId) : null;
      const b = afterId ? sortKey.get(afterId) : null;
      let ord;
      if (a != null && b != null) ord = (a + b) / 2;
      else if (a != null) ord = a + ORD_GAP;
      else if (b != null) ord = b - ORD_GAP;
      else return;
      send([{ id, ord }]);
    },

    setSubtasks(id, subtasks, opts = {}) {
      const t = byId.get(id);
      const doneCount = (list) => (Array.isArray(list) ? list.filter((s) => s.done).length : 0);
      const delta = doneCount(subtasks) - doneCount(t && t.subtasks);
      guard(id, { subtasks }, opts.expected);
      send([{ id, subtasks }]);
      if (delta && hooks.subtasks) hooks.subtasks(delta, t);
    },
  };
}

/**
 * Tasks that look like what is being typed, done ones included: something
 * similar was probably solved before, with steps worth reusing. Cheap: a word
 * overlap score over the task texts, no index.
 */
/**
 * Tasks narrowed down: `words` all found in the task or its steps; `status`
 * "active" | "resolved" | "trashed" | "all"; `when` "created" | "resolved"
 * with `period` "all" | "7" | "30" | "year" | "YYYY-MM"; `priority` "" or
 * high/medium/low/none. Purged ones never show. Newest first by `when`.
 */
export function filterTasks(tasks, { words = [], status = "all", when = "created", period = "all", priority = "" } = {}, now = new Date()) {
  const ws = words.map((w) => String(w).toLowerCase()).filter(Boolean);
  const dateOf = (x) => (when === "resolved" ? x.completed_at || (x.deleted ? x.deleted_at : "") : x.created) || "";
  const since = period === "7" || period === "30" ? new Date(now.getTime() - Number(period) * 86400000) : null;
  const year = String(now.getFullYear());
  const out = [];
  for (const x of tasks) {
    if (!x || x.purged) continue;
    if (status === "active" && (x.done || x.deleted)) continue;
    if (status === "resolved" && (!x.done || x.deleted)) continue;
    if (status === "trashed" && !x.deleted) continue;
    if (priority && (x.priority || "none") !== priority) continue;
    const d = dateOf(x);
    if (period !== "all") {
      if (!d) continue;
      if (since && new Date(d) < since) continue;
      if (period === "year" && !d.startsWith(year)) continue;
      if (/^\d{4}-\d{2}$/.test(period) && !d.startsWith(period)) continue;
    }
    if (ws.length) {
      const hay = [x.text || "", ...(x.subtasks || []).map((s) => s.text || "")].join("\n").toLowerCase();
      if (!ws.every((w) => hay.includes(w))) continue;
    }
    out.push(x);
  }
  return out.sort((a, b) => (dateOf(b) > dateOf(a) ? 1 : dateOf(b) < dateOf(a) ? -1 : 0));
}

export function similarTasks(text, tasks, { limit = 3, self = null } = {}) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  if (words.length < 1) return [];
  const want = new Set(words);
  const out = [];
  for (const t of tasks) {
    if (t.deleted || t.id === self) continue;
    const low = String(t.text || "").toLowerCase();
    const mine = new Set(low.match(/[\p{L}\p{N}]{3,}/gu) || []);
    if (!mine.size) continue;
    let hit = 0;
    for (const w of want) if (mine.has(w)) hit++;
    if (!hit) continue;
    // a near-identical text scores highest; steps make a task worth reusing
    let score = hit / want.size + hit / mine.size;
    if (low === String(text).toLowerCase().trim()) score += 1;
    if ((t.subtasks || []).length) score += 0.35;
    if (t.done) score -= 0.15;
    out.push([score, t]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, t]) => t);
}

/**
 * Quick-add syntax:  "call mom !h @tomorrow"
 *   !h !m !l  (or !high !medium !low, !1 !2 !3)   priority
 *   @today @tomorrow @mon..@sun @2026-09-20 @+3   due date
 *   ^tomorrow ^fri ...                            start (scheduled) date
 */
export function parseQuickAdd(input, now = new Date(), resolveArea = null) {
  let text = input;
  const out = { priority: null, due_date: null, start_date: null, focus_id: null, area: null };
  // +Business files the task under a focus area - only when one matches, so
  // "+1 idea" or "C++" stay plain text
  if (resolveArea) {
    text = text.replace(/(^|\s)\+([\p{L}\p{N}_\-]+)(?=\s|$)/u, (whole, s, name) => {
      const a = resolveArea(name);
      if (!a) return whole;
      out.focus_id = a.id;
      out.area = a.title;
      return s;
    });
  }
  const P = { h: "high", high: "high", 1: "high", m: "medium", med: "medium", medium: "medium", 2: "medium", l: "low", low: "low", 3: "low" };
  text = text.replace(/(^|\s)!(high|medium|med|low|h|m|l|1|2|3)(?=\s|$)/i, (_, s, p) => { out.priority = P[p.toLowerCase()]; return s; });
  text = text.replace(/(^|\s)([@^])([\w+\-]+)(?=\s|$)/g, (whole, s, sigil, word) => {
    const d = parseDateWord(word, now);
    if (!d) return whole;
    out[sigil === "@" ? "due_date" : "start_date"] = d;
    return s;
  });
  out.text = text.replace(/\s{2,}/g, " ").trim();
  return out;
}

export function parseDateWord(word, now = new Date()) {
  const w = word.toLowerCase();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fmt = (d) => dayKey(d);
  if (w === "today" || w === "tod") return fmt(base);
  if (w === "tomorrow" || w === "tom" || w === "tmr") { base.setDate(base.getDate() + 1); return fmt(base); }
  if (/^\+\d{1,3}$/.test(w)) { base.setDate(base.getDate() + Number(w.slice(1))); return fmt(base); }
  // a day that exists: 2026-02-30 is not one (it would sort before March and show as 2 March)
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) { const [y, m, d] = w.split("-").map(Number); const t = new Date(y, m - 1, d); return t.getMonth() === m - 1 && t.getDate() === d ? w : null; }
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  // whole day names only: @friend and @monica are people
  const i = /^(sun(day)?|mon(day)?|tue(s|sday)?|wed(s|nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?)$/.test(w) ? days.indexOf(w.slice(0, 3)) : -1;
  if (i >= 0) {
    let delta = (i - base.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    base.setDate(base.getDate() + delta);
    return fmt(base);
  }
  if (w === "week" || w === "nextweek") { base.setDate(base.getDate() + 7); return fmt(base); }
  return null;
}
