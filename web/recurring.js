// Recurring-task engine. Faithful port of the legacy Python engine in
// the old Python app (REC_* constants, _rec_norm .. rec_describe, and the
// App._rec_mark_done/_rec_snooze/_rec_skip_next/_rec_toggle_active/_rec_delete
// row actions as pure data mutations). Parity is proven by golden vectors
// generated from the Python code: web/tests/recurring_vectors.json.
//
// Pure ES module: no DOM, no imports, no clock reads except where a caller
// omits `today`. Dates are "YYYY-MM-DD" strings at the API boundary; all
// calendar maths runs on integer proleptic-Gregorian ordinals (Python's
// date.toordinal, 0001-01-01 = 1), so there is no timezone or DST drift.
//
// Rule / data shapes keep the Python JSON keys (last_fired, snooze_until,
// rule_id, ...) so the same file format round-trips.

export const REC_KINDS = ["daily", "weekly", "monthly", "once"];
export const REC_CATCHUP = ["collapse", "all", "skip"];
export const REC_MAX_SPAWN = 10;   // hard cap on tasks spawned per rule per catch-up
export const REC_SCAN_DAYS = 366;  // never look further back than this when catching up
export const REC_WD_SHORT = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]; // 0 = Monday
export const REC_TICK_MS = 60000;

const WD_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Python semantics helpers ────────────────────────────────────────────────
const hasOwn = (o, k) =>
  o != null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
/** dict.get(k, def) */
const get = (o, k, def = null) => (hasOwn(o, k) ? o[k] : def);
/** dict.setdefault(k, def) */
function setdefault(o, k, def) {
  if (!hasOwn(o, k)) o[k] = def;
  return o[k];
}

/** Python truthiness for JSON-ish values. */
function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Set || v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python int(): bools, truncating numbers, strict integer strings; raises otherwise. */
function pyInt(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("cannot convert " + v + " to integer");
    return Math.trunc(v) || 0;
  }
  if (typeof v === "string") {
    const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(v);
    if (!m) throw new RangeError("invalid literal for int(): " + JSON.stringify(v));
    return parseInt(m[1] + m[2].replace(/_/g, ""), 10) || 0;
  }
  throw new TypeError("int() argument must be a string or a number");
}

/** "%s" formatting of a scalar. */
function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** set(x) for the containers the engine sees (lists of ISO strings). */
function pySet(v) {
  if (Array.isArray(v)) return new Set(v);
  if (v instanceof Set) return v;
  if (typeof v === "string") return new Set(Array.from(v));
  if (v !== null && typeof v === "object") return new Set(Object.keys(v));
  throw new TypeError("object is not iterable");
}

/** `x in container` for a list of numbers (True == 1 in Python). */
function pyInList(list, x) {
  if (!Array.isArray(list)) {
    if (typeof list === "string" || (list !== null && typeof list === "object")) return false;
    throw new TypeError("argument is not iterable");
  }
  return list.some((e) => e === x || (typeof e === "boolean" && +e === x));
}

const fdiv = (a, b) => Math.floor(a / b);
const pmod = (a, b) => ((a % b) + b) % b;

// ── calendar (ordinals, mirrors CPython's _datetimemodule.c) ────────────────
const DIM = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DBM = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y, m) => (m === 2 && isLeap(y) ? 29 : DIM[m]);
function ymdToOrd(y, m, d) {
  const y1 = y - 1;
  return y1 * 365 + fdiv(y1, 4) - fdiv(y1, 100) + fdiv(y1, 400) + DBM[m] + (m > 2 && isLeap(y) ? 1 : 0) + d;
}
function ordToYmd(ord) {
  let n = ord - 1;
  const n400 = fdiv(n, 146097); n = pmod(n, 146097);
  let year = n400 * 400 + 1;
  const n100 = fdiv(n, 36524); n %= 36524;
  const n4 = fdiv(n, 1461); n %= 1461;
  const n1 = fdiv(n, 365); n %= 365;
  year += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let month = (n + 50) >> 5;
  let preceding = DBM[month] + (month > 2 && leap ? 1 : 0);
  if (preceding > n) {
    month -= 1;
    preceding -= DIM[month] + (month === 2 && leap ? 1 : 0);
  }
  return [year, month, n - preceding + 1];
}
const MAX_ORD = ymdToOrd(9999, 12, 31);
const weekday = (ord) => (ord + 6) % 7; // Monday = 0
function addDays(ord, n) {
  const r = ord + Math.floor(n);
  if (!(r >= 1 && r <= MAX_ORD)) throw new RangeError("date value out of range");
  return r;
}
const monday = (ord) => addDays(ord, -weekday(ord));
function toIso(ord) {
  const [y, m, d] = ordToYmd(ord);
  return String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
function makeDate(y, m, d) {
  if (y < 1 || y > 9999) throw new RangeError("year " + y + " is out of range");
  if (m < 1 || m > 12) throw new RangeError("month must be in 1..12");
  if (d < 1 || d > daysInMonth(y, m)) throw new RangeError("day is out of range for month");
  return ymdToOrd(y, m, d);
}

/** CPython date.fromisoformat(): YYYY-MM-DD, YYYYMMDD, YYYY-Www[-D], YYYYWww[D]. */
function fromIsoFormat(t) {
  let len = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) return null; // lone surrogate: not UTF-8 encodable
    len += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  if (len !== 7 && len !== 8 && len !== 10) return null;
  const digits = (i, n) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = t.charCodeAt(i + k);
      if (!(c >= 48 && c <= 57)) return -1;
      v = v * 10 + (c - 48);
    }
    return v;
  };
  const year = digits(0, 4);
  if (year < 0) return null;
  let p = 4;
  const sep = t[p] === "-";
  if (sep) p++;
  if (t[p] === "W") {
    p++;
    const week = digits(p, 2);
    if (week < 0) return null;
    p += 2;
    let wd = 1;
    if (p < len) {
      if (sep && t[p++] !== "-") return null;
      wd = digits(p, 1);
      if (wd < 0) return null;
    }
    if (year < 1 || year > 9999) return null;
    const first = ymdToOrd(year, 1, 1);
    const firstWd = (first + 6) % 7;
    if (week <= 0 || week >= 53) {
      if (!(week === 53 && (firstWd === 3 || (firstWd === 2 && isLeap(year))))) return null;
    }
    if (wd <= 0 || wd >= 8) return null;
    let w1 = first - firstWd;
    if (firstWd > 3) w1 += 7;
    const ord = w1 + (week - 1) * 7 + wd - 1;
    if (ord < 1 || ord > MAX_ORD) return null;
    return ord;
  }
  const month = digits(p, 2);
  if (month < 0) return null;
  p += 2;
  if (sep && t[p++] !== "-") return null;
  const day = digits(p, 2);
  if (day < 0) return null;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return ymdToOrd(year, month, day);
}

/** _rec_date: tolerant parse of the first 10 characters -> ordinal or null. */
function recDate(s) {
  if (typeof s !== "string" || !s) return null;
  return fromIsoFormat(Array.from(s).slice(0, 10).join(""));
}

/** Required date argument (Python receives a real date here). */
function req(s, what = "date") {
  const o = recDate(s);
  if (o === null) throw new TypeError("invalid " + what + ": " + pyStr(s));
  return o;
}

function localTodayIso() {
  const n = new Date();
  return String(n.getFullYear()).padStart(4, "0") + "-" + String(n.getMonth() + 1).padStart(2, "0") +
    "-" + String(n.getDate()).padStart(2, "0");
}

function uuid4() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ── public: date parsing ────────────────────────────────────────────────────
/** Tolerant ISO date parse (Python _rec_date) -> "YYYY-MM-DD" or null. */
export function parseDate(s) {
  const o = recDate(s);
  return o === null ? null : toIso(o);
}

// ── schema ──────────────────────────────────────────────────────────────────
/** Normalise one rule in place (Python _rec_norm). `today` replaces date.today(). */
export function normRule(r, today) {
  const T = today == null ? localTodayIso() : today;
  setdefault(r, "id", uuid4());
  setdefault(r, "title", "Recurring task");
  setdefault(r, "created", T);
  if (!hasOwn(r, "anchor")) r.anchor = truthy(get(r, "created")) ? r.created : T;
  setdefault(r, "until", null);
  setdefault(r, "time", "");
  setdefault(r, "priority", "none");
  setdefault(r, "mode", "task");
  setdefault(r, "catchup", "collapse");
  setdefault(r, "notify", true);
  setdefault(r, "active", true);
  setdefault(r, "last_fired", null);
  setdefault(r, "snooze_until", null);
  setdefault(r, "skip", []);
  setdefault(r, "deleted", false);
  setdefault(r, "deleted_at", null);
  let rule = get(r, "rule");
  if (!isPlainObject(rule)) rule = {};
  let kind = get(rule, "kind");
  if (!REC_KINDS.includes(kind)) kind = "weekly";
  const out = { kind };
  const orOne = (v) => (truthy(v) ? v : 1);
  if (kind === "daily") {
    out.interval = Math.max(1, pyInt(orOne(get(rule, "interval", 1))));
  } else if (kind === "weekly") {
    const raw = get(rule, "days", []);
    let days = [];
    if (Array.isArray(raw)) {
      for (const d of raw) {
        if ((typeof d === "number" || typeof d === "boolean") && pyInt(d) >= 0 && pyInt(d) <= 6) days.push(pyInt(d));
      }
    } else if (raw === null || typeof raw === "number" || typeof raw === "boolean") {
      throw new TypeError("days is not iterable");
    }
    days = [...new Set(days)].sort((a, b) => a - b);
    out.days = days.length ? days : [weekday(req(T, "today"))];
    out.interval = Math.max(1, pyInt(orOne(get(rule, "interval", 1))));
  } else if (kind === "monthly") {
    out.day = Math.min(31, Math.max(1, pyInt(orOne(get(rule, "day", 1)))));
    out.interval = Math.max(1, pyInt(orOne(get(rule, "interval", 1))));
  }
  r.rule = out;
  if (!REC_CATCHUP.includes(r.catchup)) r.catchup = "collapse";
  if (!["none", "low", "medium", "high"].includes(r.priority)) r.priority = "none";
  if (!["task", "reminder"].includes(r.mode)) r.mode = "task";
  if (!Array.isArray(r.skip)) r.skip = [];
  return r;
}

// ── engine (ordinal core) ───────────────────────────────────────────────────
function clampDom(y, m, day) {
  return makeDate(y, m, Math.min(day, daysInMonth(y, m)));
}

function addMonths(y, m, n) {
  const t = y * 12 + (m - 1) + n;
  return [fdiv(t, 12), pmod(t, 12) + 1];
}

function isOcc(rule, d, anchor) {
  if (d < anchor) return false;
  const k = get(rule, "kind");
  if (k === "once") return d === anchor;
  if (k === "daily") {
    const n = Math.max(1, pyInt(get(rule, "interval", 1)));
    return pmod(d - anchor, n) === 0;
  }
  if (k === "weekly") {
    const n = Math.max(1, pyInt(get(rule, "interval", 1)));
    if (!pyInList(get(rule, "days", []), weekday(d))) return false;
    return pmod(fdiv(monday(d) - monday(anchor), 7), n) === 0;
  }
  if (k === "monthly") {
    const n = Math.max(1, pyInt(get(rule, "interval", 1)));
    const [dy, dm] = ordToYmd(d);
    const [ay, am] = ordToYmd(anchor);
    if (pmod(dy * 12 + dm - (ay * 12 + am), n) !== 0) return false;
    return d === clampDom(dy, dm, pyInt(get(rule, "day", 1)));
  }
  return false;
}

function nextOcc(rule, from, anchor, until) {
  if (anchor === null) anchor = from;
  const start = from > anchor ? from : anchor;
  const k = get(rule, "kind");
  let res = null;

  if (k === "once") {
    res = anchor >= from ? anchor : null;
  } else if (k === "daily") {
    const n = Math.max(1, pyInt(get(rule, "interval", 1)));
    const gap = start - anchor;
    res = addDays(anchor, fdiv(gap + n - 1, n) * n);
  } else if (k === "weekly") {
    const n = Math.max(1, pyInt(get(rule, "interval", 1)));
    const raw = get(rule, "days", []);
    if (!Array.isArray(raw)) throw new TypeError("days must be a list");
    const days = raw.slice().sort((a, b) => a - b);
    if (days.length) {
      let wk = monday(start);
      const aw = monday(anchor);
      const rem = pmod(fdiv(wk - aw, 7), n);
      if (rem) wk = addDays(wk, 7 * (n - rem));
      for (let i = 0; i < 2 && res === null; i++) {
        for (const wd of days) {
          const cand = addDays(wk, +wd);
          if (cand >= start && cand >= anchor) {
            res = cand;
            break;
          }
        }
        if (res === null) wk = addDays(wk, 7 * n);
      }
    }
  } else if (k === "monthly") {
    const n = Math.max(1, pyInt(get(rule, "interval", 1)));
    const dom = pyInt(get(rule, "day", 1));
    const [ay, amon] = ordToYmd(anchor);
    const [sy, smon] = ordToYmd(start);
    let off = sy * 12 + (smon - 1) - (ay * 12 + (amon - 1));
    if (off < 0) off = 0;
    if (pmod(off, n)) off += n - pmod(off, n);
    for (let i = 0; i < 400; i++) {
      const [y, m] = addMonths(ay, amon, off);
      const cand = clampDom(y, m, dom);
      if (cand >= start && cand >= anchor) {
        res = cand;
        break;
      }
      off += n;
    }
  }
  if (res !== null && until !== null && res > until) return null;
  return res;
}

function nextDueOrd(r, t) {
  if (!truthy(get(r, "active", true)) || truthy(get(r, "deleted"))) return { d: null, overdue: false };
  const anchor = recDate(get(r, "anchor")) ?? t;
  const until = recDate(get(r, "until"));
  const skip = pySet(get(r, "skip", []));
  const lf = recDate(get(r, "last_fired"));
  const floor = Math.max(anchor, lf !== null ? addDays(lf, 1) : anchor, addDays(t, -REC_SCAN_DAYS));
  const rule = get(r, "rule", {});
  let cur = floor;
  for (let i = 0; i < 64; i++) {
    const d = nextOcc(rule, cur, anchor, until);
    if (d === null) return { d: null, overdue: false };
    if (skip.has(toIso(d))) {
      cur = addDays(d, 1);
      continue;
    }
    const sn = recDate(get(r, "snooze_until"));
    if (sn !== null && sn >= t && d <= t) return { d: addDays(sn, 1), overdue: false };
    return { d, overdue: d < t };
  }
  return { d: null, overdue: false };
}

function dueOrd(r, lastFired, t, limit) {
  const anchor = recDate(get(r, "anchor")) ?? t;
  const created = recDate(get(r, "created")) ?? anchor;
  const until = recDate(get(r, "until"));
  const skip = pySet(get(r, "skip", []));
  const lf = recDate(lastFired);
  let floor = Math.max(anchor, created, addDays(t, -REC_SCAN_DAYS));
  if (lf !== null) floor = Math.max(floor, addDays(lf, 1));
  const rule = get(r, "rule", {});
  let out = [];
  let cur = floor;
  let truncated = false;
  while (cur <= t) {
    const d = nextOcc(rule, cur, anchor, until);
    if (d === null || d > t) break;
    if (!skip.has(toIso(d))) {
      out.push(d);
      if (out.length > limit * 4) {
        truncated = true;
        out = out.slice(-limit);
      }
    }
    cur = addDays(d, 1);
  }
  if (out.length > limit) {
    truncated = true;
    out = out.slice(-limit);
  }
  return { out, truncated };
}

function pastOccurrences(r, t, honorSkip) {
  const anchor = recDate(get(r, "anchor")) ?? t;
  const until = recDate(get(r, "until"));
  const skip = honorSkip ? pySet(get(r, "skip", [])) : null;
  const rule = get(r, "rule", {});
  const occ = [];
  let cur = Math.max(anchor, addDays(t, -REC_SCAN_DAYS));
  while (cur <= t && occ.length < 400) {
    const d = nextOcc(rule, cur, anchor, until);
    if (d === null || d > t) break;
    if (!skip || !skip.has(toIso(d))) occ.push(d);
    cur = addDays(d, 1);
  }
  return occ;
}

const findRule = (data, rid) => (get(data, "rules", []) || []).find((x) => get(x, "id") === rid) || null;

// ── public engine API (ISO strings in/out) ──────────────────────────────────
/** True if `d` is an occurrence of `rule` (ignores until/skip/active). */
export function isOccurrence(rule, d, anchor) {
  return isOcc(rule, req(d), req(anchor, "anchor"));
}

/** First occurrence on or after `from` -> ISO or null. `anchor` defaults to `from`. */
export function nextOccurrence(rule, from, anchor = null, until = null) {
  const res = nextOcc(rule, req(from), anchor == null ? null : req(anchor, "anchor"),
    until == null ? null : req(until, "until"));
  return res === null ? null : toIso(res);
}

/** The next `count` non-skipped dates. `today` is only the fallback for a missing anchor. */
export function nextOccurrences(r, from, count = 3, today = null) {
  const anchor = recDate(get(r, "anchor")) ?? req(today == null ? localTodayIso() : today, "today");
  const until = recDate(get(r, "until"));
  const skip = pySet(get(r, "skip", []));
  const rule = get(r, "rule", {});
  const out = [];
  let cur = req(from);
  const iters = count * 8 + 24;
  for (let i = 0; i < iters; i++) {
    if (out.length >= count) break;
    const d = nextOcc(rule, cur, anchor, until);
    if (d === null) break;
    if (!skip.has(toIso(d))) out.push(toIso(d));
    cur = addDays(d, 1);
  }
  return out;
}

/** Next actionable date -> {date: ISO|null, overdue}. Snooze shows snooze_until + 1. */
export function nextDue(r, today) {
  const { d, overdue } = nextDueOrd(r, req(today, "today"));
  return { date: d === null ? null : toIso(d), overdue };
}

/** Occurrences in (lastFired, today] not yet materialised -> {dates, truncated}. */
export function dueOccurrences(r, lastFired, today, limit = REC_MAX_SPAWN) {
  const { out, truncated } = dueOrd(r, lastFired, req(today, "today"), limit);
  return { dates: out.map(toIso), truncated };
}

/** Idempotency key: one materialisation per (rule, occurrence date). */
export function occKey(rid, d) {
  return pyStr(rid) + "@" + pyStr(d);
}

/** Materialisation keys already present in a task list (Python App._rec_task_keys). */
export function taskKeys(tasks) {
  const keys = new Set();
  for (const t of tasks || []) {
    const rid = get(t, "rec_id");
    if (truthy(rid)) keys.add(occKey(rid, get(t, "rec_date", "")));
  }
  return keys;
}

/**
 * PURE. Decide what to materialise -> {spawns, updates, fired}.
 * spawns: [{rule_id, title, date, missed, priority, time, mode, notify, key}]
 * updates: {rid: {last_fired}} (apply with Object.assign), fired: [rid] to notify.
 * Only spawns with mode === "task" become tasks (see specToTask).
 */
export function catchUpPlan(rules, today, existingKeys = new Set(), log = null) {
  const t = req(today, "today");
  const lg = truthy(log) ? log : {};
  const keys = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
  const spawns = [];
  const updates = {};
  const fired = [];
  for (const r of rules) {
    if (truthy(get(r, "deleted")) || !truthy(get(r, "active", true))) continue;
    const rid = get(r, "id");
    const sn = recDate(get(r, "snooze_until"));
    if (sn !== null && sn >= t) continue;
    const { out: occ } = dueOrd(r, get(r, "last_fired"), t, REC_MAX_SPAWN);
    if (!occ.length) continue;
    const done = pySet(get(lg, pyStr(rid), []));
    const mode = get(r, "catchup", "collapse");
    const last = occ[occ.length - 1];
    let wanted;
    if (mode === "skip") wanted = last === t ? [last] : [];
    else if (mode === "all") wanted = occ;
    else wanted = [last];
    let made = false;
    for (const d of wanted) {
      const iso = toIso(d);
      const key = occKey(rid, iso);
      if (keys.has(key) || done.has(iso)) continue;
      spawns.push({
        rule_id: rid,
        title: get(r, "title", "Recurring task"),
        date: iso,
        missed: mode === "collapse" ? occ.length - 1 : 0,
        priority: get(r, "priority", "none"),
        time: get(r, "time", ""),
        mode: get(r, "mode", "task"),
        notify: truthy(get(r, "notify", true)),
        key,
      });
      made = true;
    }
    updates[pyStr(rid)] = { last_fired: toIso(last) };
    if (made && truthy(get(r, "notify", true))) fired.push(rid);
  }
  return { spawns, updates, fired };
}

/** Task fields the legacy app creates for one spawn (no id: the caller adds it). */
export function specToTask(spawn, nowIso) {
  const iso = spawn.date;
  let text = spawn.title;
  if (truthy(get(spawn, "missed"))) text = `${pyStr(spawn.title)}  (+${pyInt(spawn.missed)} missed)`;
  return {
    text,
    done: false,
    created: nowIso,
    priority: get(spawn, "priority", "none"),
    subtasks: [],
    rec_id: spawn.rule_id,
    rec_date: iso,
    due_date: iso,
    due_time: get(spawn, "time", ""),
    due_jumped: true,
    scheduled_jumped: true,
    deleted: false,
    start_date: null,
  };
}

// ── stats ───────────────────────────────────────────────────────────────────
/** Consecutive completed occurrences ending at the latest past one (today may be open). */
export function streak(r, log, today) {
  const t = req(today, "today");
  const done = pySet(get(truthy(log) ? log : {}, pyStr(get(r, "id")), []));
  const occ = pastOccurrences(r, t, true);
  let n = 0;
  for (let i = occ.length - 1; i >= 0; i--) {
    const d = occ[i];
    if (done.has(toIso(d))) n++;
    else if (d === t) continue;
    else break;
  }
  return n;
}

/** {hits, total} over the last `window` expected occurrences (skip list NOT honoured, as in Python). */
export function rate(r, log, today, window = 8) {
  const t = req(today, "today");
  const done = pySet(get(truthy(log) ? log : {}, pyStr(get(r, "id")), []));
  const occ = pastOccurrences(r, t, false).slice(-window);
  return { hits: occ.filter((d) => done.has(toIso(d))).length, total: occ.length };
}

// ── display ─────────────────────────────────────────────────────────────────
/** "today" / "tomorrow" / "yesterday" / "Tue 3 Sep" / "Tue 3 Sep 2027"; null -> "—". */
export function fmtDate(d, today) {
  const o = recDate(d);
  if (o === null) return "—";
  const t = req(today, "today");
  if (o === t) return "today";
  if (o === t + 1) return "tomorrow";
  if (o === t - 1) return "yesterday";
  const [y, m, day] = ordToYmd(o);
  let s = `${WD_EN[weekday(o)]} ${day} ${MON_EN[m - 1]}`;
  if (y !== ordToYmd(t)[0]) s += " " + String(y).padStart(4, "0");
  return s;
}

/** Cadence label: "Weekly · Tu", "Every 3 days", "Monthly · day 31 (last)". */
export function describe(r) {
  const rule = get(r, "rule", {});
  const k = get(rule, "kind");
  const iv = get(rule, "interval", 1);
  const n = pyInt(truthy(iv) ? iv : 1);
  if (k === "once") return "Once";
  if (k === "daily") return n === 1 ? "Daily" : `Every ${n} days`;
  if (k === "weekly") {
    const days = get(rule, "days", []);
    if (!Array.isArray(days)) throw new TypeError("days must be a list");
    const names = days.slice().sort((a, b) => a - b).map((d) => {
      const i = pyInt(d);
      const name = REC_WD_SHORT[i < 0 ? i + 7 : i];
      if (name === undefined) throw new RangeError("tuple index out of range");
      return name;
    }).join(", ");
    return `${n === 1 ? "Weekly" : `Every ${n} weeks`} · ${names || "—"}`;
  }
  if (k === "monthly") {
    const dom = pyInt(get(rule, "day", 1));
    return `${n === 1 ? "Monthly" : `Every ${n} months`} · day ${dom}${dom === 31 ? " (last)" : ""}`;
  }
  return "—";
}

// ── row actions as pure data mutations ──────────────────────────────────────
/**
 * Complete the pending occurrence of rule `rid` (Python App._rec_mark_done).
 * `openTasks` is the task list (filtered here to this rule's open spawned tasks):
 * the oldest open one pins which occurrence is closed; otherwise the pending
 * occurrence from nextDue is used, and a future-only rule is refused.
 * Mutates `data` (log entry, last_fired, snooze_until). Returns null when refused,
 * else {iso, closeTaskId, awardXp}: when closeTaskId is set the caller marks that
 * task done (completed_at, tasks_done += 1); awardXp is the total XP to add
 * (15 for a closed task, 10 otherwise).
 */
export function markDone(data, rid, today, openTasks = []) {
  const t = req(today, "today");
  const r = findRule(data, rid);
  if (!r) return null;
  const open = (openTasks || []).filter((tk) => get(tk, "rec_id") === rid && truthy(get(tk, "rec_date")) &&
    !truthy(get(tk, "done")) && !truthy(get(tk, "deleted")));
  let occ = null;
  if (open.length) {
    open.sort((a, b) => (a.rec_date < b.rec_date ? -1 : a.rec_date > b.rec_date ? 1 : 0));
    occ = recDate(open[0].rec_date);
  }
  if (occ === null) {
    const { d } = nextDueOrd(r, t);
    if (d === null || d > t) return null; // nothing pending: the XP-farm guard
    occ = d;
  }
  const iso = toIso(occ);
  const lst = setdefault(setdefault(data, "log", {}), pyStr(rid), []);
  if (lst.includes(iso)) return null; // already completed
  const lf = recDate(get(r, "last_fired"));
  if (lf === null || occ > lf) r.last_fired = iso;
  r.snooze_until = null;
  let closed = false;
  let closeTaskId = null;
  for (const tk of open) {
    if (get(tk, "rec_date") === iso) {
      closed = true;
      closeTaskId = get(tk, "id");
      break;
    }
  }
  // _rec_award: the log is the ledger; a falsy rid writes nothing and pays nothing
  let awardXp = closed ? 15 : 0;
  if (truthy(rid)) {
    lst.push(iso);
    if (!closed) awardXp = 10;
  }
  return { iso, closeTaskId, awardXp };
}

/** Snooze through today + days - 1 (Python App._rec_snooze). Returns snooze_until or null. */
export function snooze(data, rid, today, days = 1) {
  const t = req(today, "today");
  const r = findRule(data, rid);
  if (!r) return null;
  r.snooze_until = days > 1 ? toIso(addDays(t, days - 1)) : toIso(t);
  return r.snooze_until;
}

/** Wave off the pending occurrence (Python App._rec_skip_next). Returns the skipped ISO or null. */
export function skipNext(data, rid, today) {
  const t = req(today, "today");
  const r = findRule(data, rid);
  if (!r) return null;
  const { d } = nextDueOrd(r, t);
  if (d === null) return null;
  const iso = toIso(d);
  const skip = setdefault(r, "skip", []);
  if (!skip.includes(iso)) skip.push(iso);
  r.skip = r.skip.slice(-60);
  const lf = recDate(get(r, "last_fired"));
  if (d <= t && (lf === null || d > lf)) r.last_fired = iso;
  return iso;
}

/** Flip `active` (Python App._rec_toggle_active). Returns the new value or null. */
export function toggleActive(data, rid) {
  const r = findRule(data, rid);
  if (!r) return null;
  r.active = !truthy(get(r, "active", true));
  return r.active;
}

/** Soft delete (Python App._rec_delete). `nowIso` = local "YYYY-MM-DDTHH:MM:SS". */
export function softDelete(data, rid, nowIso) {
  const r = findRule(data, rid);
  if (!r) return false;
  r.deleted = true;
  r.deleted_at = nowIso;
  r.active = false;
  return true;
}
