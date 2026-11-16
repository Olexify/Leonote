// XP, levels, counters and focus history. Same numbers and level curve as the
// Python app, carried over from its config on first run (see load_stats).

import { emitter, dayKey, debounce } from "./util.js";

export const LEVEL_XP = [0, 50, 120, 220, 350, 520, 740, 1020, 1370, 1800, 2400];

/* The level curve, made for years: the first ten levels by the table above, then 800 XP a level
   to level 30 (as it always was, so nobody loses a level), then each level costs 40 more than the
   last until 3000, and every level after that costs 3000 - steady, like a season pass that never
   ends. Level 100 is about 210,000 XP, 1000 about 2.9 million: no ceiling. */
const FLAT = 800, FLAT_TO = 30, STEP = 40, CAP = 2000;
const GROW_TO = FLAT_TO + (CAP - FLAT) / STEP; // 60: the first level at the cap
/** The XP a level costs, from the one before it. */
export function costOf(l) {
  if (l <= 0) return 0;
  if (l < LEVEL_XP.length) return LEVEL_XP[l] - LEVEL_XP[l - 1];
  return l <= FLAT_TO ? FLAT : Math.min(CAP, FLAT + (l - FLAT_TO) * STEP);
}
/** The XP a level is reached at. */
export function xpForLevel(l) {
  if (l <= 0) return 0;
  if (l < LEVEL_XP.length) return LEVEL_XP[l];
  let x = LEVEL_XP[LEVEL_XP.length - 1] + (Math.min(l, FLAT_TO) - (LEVEL_XP.length - 1)) * FLAT;
  if (l > FLAT_TO) {
    const k = Math.min(l, GROW_TO) - FLAT_TO;
    x += k * FLAT + (STEP * k * (k + 1)) / 2;
  }
  if (l > GROW_TO) x += (l - GROW_TO) * CAP;
  return x;
}

export function levelOf(xp) {
  let lo = 0, hi = 1;
  while (xpForLevel(hi) <= xp) hi *= 2;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xpForLevel(m) <= xp) lo = m; else hi = m; }
  return lo;
}

/* Ranks: the lion's life - awake, a cub growing up (to Scholar), the pride (Guardian to Lionheart), war and
   kingdom (Knight to King of the Pride) and myth (Legend to Starkindler, who lights dead stars again, at level 5,000).
   Each rank lasts about a fifth longer than the one before, so they come evenly all the way up; each is
   climbed in three tiers (Hunter I, II, III). Starkindler has no ceiling: a star for every 1,000 levels past it. */
export const RANKS = [
  [0, "Awakened", "rkEye"], [3, "Lion cub", "paw"], [7, "Apprentice", "rkBook"], [11, "Explorer", "compass"], [16, "Hunter", "rkPaw"], [22, "Disciplined", "rkBarbell"],
  [30, "Steady", "anchor"], [39, "Thinker", "lightbulb"], [50, "Scholar", "rkQuill"], [60, "Guardian", "rkShield"], [75, "Warrior", "rkLabrys"], [95, "Veteran", "rkMedal"],
  [120, "Strategist", "rkRook"], [145, "Leader", "rkHandFlag"], [175, "Master", "rkMasterKey"], [210, "Elder", "rkMonk"], [260, "Lionheart", "rkCrownHeart"], [310, "Knight", "rkKnight"],
  [380, "Champion", "trophy"], [460, "Commander", "rkCommand"], [550, "General", "rkGeneral"], [670, "Warlord", "rkHorned"], [800, "Lord", "rkKeep"], [960, "King of the Pride", "rkCrown"],
  [1150, "Legend", "rkLaurel"], [1400, "Titan", "rkTitan"], [1650, "Colossus", "rkSummit"], [2000, "Immortal", "infinity"], [2400, "Celestial", "rkCelestial"], [2900, "Sunborn", "rkSunborn"],
  [3450, "Sun Lion", "rkLion"], [4150, "Eternal", "rkTime"], [5000, "Starkindler", "rkKindler"]];
/** Each rank's colour, in the order of RANKS. */
export const RANK_COLORS = [
  "#9ad0ff", "#f2c27b", "#8fd694", "#4fd6c4", "#c9a26b", "#7fb3ff", "#6fa8dc", "#ffd35c", "#b8a1ff",
  "#5aa9ff", "#ff6b5e", "#d9a84e", "#9a8bff", "#6cc070", "#e8b84a", "#ff7a45", "#ff4d6d",
  "#c9d4e2", "#ffc23d", "#ff8a3d", "#f5c542", "#ff4b2b", "#b98cff", "#ffb000",
  "#ffe08a", "#7ecbff", "#b4c7da", "#c99bff", "#86b2ff", "#ff9a3c", "#ffc53d", "#ece6ff", "#fff1b8"];
/** The colour of the rank a level is in. */
export function rankColor(level) {
  let i = 0;
  while (i + 1 < RANKS.length && RANKS[i + 1][0] <= level) i++;
  return RANK_COLORS[i];
}
const ROMAN = ["I", "II", "III"];
const STAR_EVERY = 1000;
/** { name, rank, tier, next: { name, level } } for a level - name with its tier ("Hunter II", "Sun King ★3"). */
export function rankOf(level) {
  let i = 0;
  while (i + 1 < RANKS.length && RANKS[i + 1][0] <= level) i++;
  const [start, rank, icon] = RANKS[i];
  const nx = RANKS[i + 1];
  if (!nx) {
    const stars = Math.floor((level - start) / STAR_EVERY);
    const nm = (n) => (n ? `${rank} ★${n}` : rank);
    return { name: nm(stars), rank, icon, tier: stars, next: { name: nm(stars + 1), level: start + (stars + 1) * STAR_EVERY } };
  }
  const tier = Math.min(2, Math.floor(((level - start) / (nx[0] - start)) * 3));
  const at = (t) => start + Math.ceil(((nx[0] - start) * t) / 3);
  const next = tier < 2 && at(tier + 1) < nx[0] ? { name: `${rank} ${ROMAN[tier + 1]}`, level: at(tier + 1) } : { name: i + 2 < RANKS.length ? `${nx[1]} I` : nx[1], level: nx[0] };
  return { name: `${rank} ${ROMAN[tier]}`, rank, icon, tier, next };
}

/* Badges: milestones read from what is counted already - nothing new is stored for them. Sixteen each,
   climbed in three stages (6, then 5, then 5): a stage shows until it is complete, the third is the last. */
export const BADGES = [
  ["tasks", "Tasks done", (d) => d.tasks_done || 0, [10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 20000], "checkSquare"],
  ["focus", "Hours of focus", (d) => Math.floor((d.pomo_total_work_secs || 0) / 3600), [1, 10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000], "clock"],
  // days with any focus in them, all told - a streak of a thousand is not a goal, a thousand days of work is
  ["days", "Days of work", (d) => Object.values(d.pomo_daily || {}).filter((x) => x && x.work > 0).length, [1, 3, 7, 14, 30, 50, 75, 100, 150, 200, 250, 300, 365, 500, 730, 1000], "calendar"],
  ["level", "Level", (d) => levelOf(d.xp || 0), [10, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000], "star"],
];
export const BADGE_STAGES = [[0, 6], [6, 11], [11, 16]];
/** Each badge line: its value, the steps reached, the next one, and the stage on show (its steps). */
export function badgesOf(data) {
  return BADGES.map(([id, label, value, steps, ic]) => {
    const v = value(data);
    const got = steps.filter((x) => v >= x).length;
    // the stage on show: the first not complete yet (the last stays once everything is reached)
    const open = BADGE_STAGES.findIndex(([, b]) => got < b);
    const at = open < 0 ? BADGE_STAGES.length - 1 : open;
    const [a, b] = BADGE_STAGES[at];
    return { id, label, icon: ic, value: v, steps, got, next: steps.find((x) => v >= 0 && v < x) ?? null, stage: at, shown: steps.slice(a, b) };
  });
}

/* Daily challenges: three a day, picked from the date (the same all day, new tomorrow), each
   counting something XP already counts. Habits, focus and repeating tasks are offered only once
   they have been used. Nothing runs on its own: they move only when XP is earned. */
const CHALLENGES = [
  ["tasks", "taskDone", [3, 5, 8], (t) => `Finish ${t} tasks`],
  ["steps", "subtaskDone", [3, 6, 10], (t) => `Tick ${t} steps of tasks`],
  ["focus", "focusMin", [25, 45, 90], (t) => `Focus for ${t} minutes`],
  ["habits", "habitDone", [1, 2, 3], (t) => `Keep ${t} habit${t > 1 ? "s" : ""} today`],
  ["repeat", "recurringDone", [1, 2, 3], (t) => `Finish ${t} repeating task${t > 1 ? "s" : ""}`],
];
const ALWAYS = new Set(["taskDone", "subtaskDone"]);
export const CHALLENGE_ALL = 50; // all three of a day
/** The day's challenges: [{ id, kind, target, text, reward }], the same for the same day and kinds used. */
export function challengesFor(day, used) {
  let seed = 0;
  for (const c of day) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pool = CHALLENGES.filter(([, kind]) => ALWAYS.has(kind) || (used[kind] || 0) > 0);
  const out = [];
  while (pool.length && out.length < 3) {
    const [id, kind, targets, text] = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    const k = Math.floor(rnd() * targets.length);
    out.push({ id, kind, target: targets[k], text: text(targets[k]), reward: 20 + 10 * k });
  }
  return out;
}

/** The bonus for the first XP of a day: 10, and 5 more for each day of the streak, to 60. */
export const dayBonus = (streak) => 10 + 5 * Math.min(10, Math.max(0, streak - 1));

// Award table, as in the Python app
export const XP = { taskCreated: 5, taskDone: 15, subtaskDone: 3, habitDone: 10, recurringDone: 10, workoutSet: 3, fastDone: 15, sessionDone: 20 };

const DEFAULTS = {
  xp: 0,
  tasks_created: 0,
  tasks_done: 0,
  pomo_total_work_secs: 0,
  pomo_total_break_secs: 0,
  pomo_daily: {},
  pomo_work_mins: 20,
  pomo_break_mins: 3,
  pomo_tick_enabled: false,
  pomo_tick_volume: 0.3,
  pomo_alert_enabled: true,
  pomo_notify_enabled: true, // the message when a focus block or a break ends
  pomo_alert_volume: 0.6,
  pomo_no_tick_break: true,
};

export function createStats(host, initial) {
  const bus = emitter();
  const data = { ...DEFAULTS, ...(initial || {}) };
  if (!data.pomo_daily || typeof data.pomo_daily !== "object") data.pomo_daily = {};
  const persist = debounce(() => host.saveStats(data).catch((e) => console.warn("stats", e)), 800);
  const changed = () => { persist(); bus.emit("changed"); };

  return {
    bus,
    data,
    get xp() { return data.xp || 0; },
    get level() { return levelOf(data.xp || 0); },

    progress() {
      const level = levelOf(data.xp || 0);
      const a = xpForLevel(level);
      const b = xpForLevel(level + 1);
      return { level, into: (data.xp || 0) - a, span: b - a, next: b };
    },

    /** XP earned. kind (taskDone, focusMin, …) and units count it for the day's challenges. */
    award(n, kind = null, units = 1) {
      if (!n) return;
      if (kind) this.count(kind, n > 0 ? units : -units);
      const before = levelOf(data.xp || 0);
      // the first XP of a day keeps the streak and earns its bonus (taking XP back - a task
      // opened again - neither starts a day nor pays a bonus)
      let bonus = 0;
      if (n > 0) {
        const today = dayKey();
        const st = data.streak && typeof data.streak === "object" ? data.streak : (data.streak = { last: "", count: 0, best: 0 });
        if (st.last !== today) {
          const y = new Date(); y.setDate(y.getDate() - 1);
          st.count = st.last === dayKey(y) ? (st.count || 0) + 1 : 1;
          st.last = today;
          st.best = Math.max(st.best || 0, st.count);
          bonus = dayBonus(st.count);
          bus.emit("daybonus", { bonus, streak: st.count });
        }
        const days = data.xp_days && typeof data.xp_days === "object" ? data.xp_days : (data.xp_days = {});
        days[today] = (days[today] || 0) + n + bonus;
        const keys = Object.keys(days);
        if (keys.length > 400) for (const k of keys.sort().slice(0, keys.length - 400)) delete days[k];
      }
      data.xp = Math.max(0, (data.xp || 0) + n + bonus);
      changed();
      const after = levelOf(data.xp);
      if (after > before) bus.emit("levelup", after, before);
    },
    /** What was done today, by kind; and what was ever done (which challenges can be offered). */
    count(kind, d) {
      const day = dayKey();
      if (!data.today || data.today.day !== day) data.today = { day, n: {}, done: [] };
      const t = data.today;
      t.n[kind] = Math.max(0, (t.n[kind] || 0) + d);
      if (d > 0) (data.kinds || (data.kinds = {}))[kind] = (data.kinds[kind] || 0) + d;
      // taken back below a challenge already met (a task opened again): the challenge, and its XP, go too
      const many = this.challenges().length;
      for (const c of this.challenges()) {
        if (!c.done || c.have >= c.target) continue;
        const all = t.done.length === many;
        t.done = t.done.filter((x) => x !== c.id);
        this.award(-(c.reward + (all ? CHALLENGE_ALL : 0)));
      }
      // a challenge met: its XP (with no kind - it counts toward nothing), once
      for (const c of this.challenges()) {
        if (c.done || c.have < c.target) continue;
        t.done.push(c.id);
        const all = t.done.length === many;
        bus.emit("challenge", { ...c, all });
        this.award(c.reward + (all ? CHALLENGE_ALL : 0));
      }
    },
    /** Today's challenges, with how far each has got. */
    challenges() {
      const day = dayKey();
      const t = data.today && data.today.day === day ? data.today : { n: {}, done: [] };
      // what was used before the challenges existed counts too (focus has its own total)
      const used = { ...(data.kinds || {}), focusMin: (data.kinds || {}).focusMin || (data.pomo_total_work_secs > 0 ? 1 : 0) };
      return challengesFor(day, used).map((c) => ({ ...c, have: t.n[c.kind] || 0, done: t.done.includes(c.id) }));
    },
    /** The streak as it stands today: 0 when the last day with XP was before yesterday. */
    streak() {
      const st = data.streak || {};
      const y = new Date(); y.setDate(y.getDate() - 1);
      const live = st.last === dayKey() || st.last === dayKey(y);
      return { count: live ? st.count || 0 : 0, best: st.best || 0, today: st.last === dayKey() };
    },

    bump(key, d = 1) {
      data[key] = Math.max(0, (data[key] || 0) + d);
      changed();
    },

    /** Seconds of focus or break; 1 XP per completed work minute. */
    addFocus(phase, secs) {
      if (!(secs > 0)) return;
      const day = data.pomo_daily[dayKey()] || (data.pomo_daily[dayKey()] = { work: 0, break: 0 });
      if (phase === "work") {
        const prev = data.pomo_total_work_secs || 0;
        data.pomo_total_work_secs = prev + secs;
        day.work = (day.work || 0) + secs;
        const gained = Math.floor((prev + secs) / 60) - Math.floor(prev / 60);
        if (gained > 0) this.award(gained, "focusMin", gained);
        else changed();
      } else {
        data.pomo_total_break_secs = (data.pomo_total_break_secs || 0) + secs;
        day.break = (day.break || 0) + secs;
        changed();
      }
    },

    /** Correct a day's focus by hand: the totals and the focus XP follow. */
    setFocusOn(key, secs) {
      const day = data.pomo_daily[key] || (data.pomo_daily[key] = { work: 0, break: 0 });
      const old = day.work || 0;
      secs = Math.max(0, Math.round(secs));
      if (secs === old) return;
      const prev = data.pomo_total_work_secs || 0;
      data.pomo_total_work_secs = Math.max(0, prev + secs - old);
      day.work = secs;
      const xp = Math.floor(data.pomo_total_work_secs / 60) - Math.floor(prev / 60);
      if (xp < 0 && data.xp_days && data.xp_days[key]) data.xp_days[key] = Math.max(0, data.xp_days[key] + xp);
      if (xp) this.award(xp, "focusMin", Math.abs(xp)); else changed();
    },

    focusOn(key) {
      const d = data.pomo_daily[key];
      return d ? d.work || 0 : 0;
    },

    set(key, value) {
      data[key] = value;
      changed();
    },

    flush() { persist.flush(); },
  };
}

export function fmtDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
