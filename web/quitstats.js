// Breaking a habit, counted: the pure half of the quit trackers (quits.js).
// A tracker is { id, name, start, relapses: [ISO times] } - everything else is
// worked out from those, so nothing can drift out of step.

export const DAY = 86_400_000;
export const MILESTONES = [1, 3, 7, 14, 30, 60, 90, 180, 365, 730, 1095];

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKeyOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/** Calendar days from the day of `a` to the day of `b`, both counted. */
export function daysSpanned(a, b) {
  if (b < a) return 0;
  let n = 0;
  for (let d = dayStart(a); d <= b; d = dayStart(d + DAY * 1.5)) n++;
  return n;
}

/**
 * The numbers a tracker shows at `now` (milliseconds):
 * current - how long since the last relapse (or the start)
 * previous, best - the streak before this one, the longest (this one counted)
 * nextDayIn - until the next whole clean day
 * yearClean, yearTracked - calendar days of this year without a relapse, of the days tracked
 * next, progress - the next milestone in days, and how far to it (0-1)
 */
export function quitStats(q, now = Date.now()) {
  const start = Date.parse(q.start);
  const rel = (q.relapses || []).map((x) => Date.parse(x)).filter((t) => Number.isFinite(t) && t >= start && t <= now).sort((a, b) => a - b);
  const marks = [start, ...rel];
  const spans = [];
  for (let i = 1; i < marks.length; i++) spans.push(marks[i] - marks[i - 1]);
  const current = Math.max(0, now - marks[marks.length - 1]);
  const previous = spans.length ? spans[spans.length - 1] : null;
  const best = Math.max(current, ...spans);
  const y0 = new Date(new Date(now).getFullYear(), 0, 1).getTime();
  const from = Math.max(y0, start);
  const yearTracked = daysSpanned(from, now);
  const slipDays = new Set(rel.filter((t) => t >= y0).map(dayKeyOf));
  const yearClean = Math.max(0, yearTracked - slipDays.size);
  const days = current / DAY;
  const next = MILESTONES.find((m) => m > days) || Math.ceil((days + 1) / 365) * 365;
  const prevMark = [...MILESTONES].reverse().find((m) => m <= days) || 0;
  const progress = Math.min(1, Math.max(0, (days - prevMark) / (next - prevMark)));
  return { current, previous, best, nextDayIn: DAY - (current % DAY), yearClean, yearTracked, relapses: rel.length, next, progress, days: Math.floor(days) };
}

/** "12 d 04:23:51" - or "04:23:51" under a day. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const p = (n) => String(n).padStart(2, "0");
  const hms = `${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  return d ? `${d} d ${hms}` : hms;
}

/** "3 days", "5 h", "12 min" - a streak in words. */
export function span(ms) {
  if (ms == null) return "—";
  const d = ms / DAY;
  if (d >= 1) { const n = Math.floor(d); return `${n} day${n === 1 ? "" : "s"}`; }
  const h = ms / 3_600_000;
  if (h >= 1) return `${Math.floor(h)} h`;
  return `${Math.max(0, Math.floor(ms / 60_000))} min`;
}
