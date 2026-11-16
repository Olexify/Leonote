// Google Calendar, for those who keep one. Two things, each optional and its
// own choice in Settings › Calendar:
//  - the events of the calendars ticked there, shown in the Calendar view;
//  - tasks with a due date and recurring rules put on one chosen calendar
//    and kept in step as they change (title, date, time, done), taken off
//    again when the date goes, the task is trashed or the rule is paused.
// Signing in is OAuth with PKCE against the user's own Google app (a Desktop
// client made at CONSOLE_PAGE), the way ytaccount.js does it: the browser
// signs in, the loopback listener in oauth.rs catches the redirect, and the
// code is traded for tokens by the Rust side (google_token) so no CORS rule
// stands in the way. Tokens live in settings under `gcal`.
//
// Pushed events carry a private extended property naming the task or rule,
// so the view never shows one twice (the task is shown, the event is not).

import { makeVerifier, challengeOf, authUrl, tokenRecord, tokenError, tokenStore, revokeGoogle, SIGNIN_NOTE, CONSOLE_PAGE } from "./ytaccount.js";
import * as R from "./recurring.js";
import { dayKey, parseDay, addDays, localIso, debounce, deadline } from "./util.js";

export { CONSOLE_PAGE };
export const SCOPES = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";
const TAG = "leonote";
const FRESH_MS = 5 * 60000; // how long a fetched range is trusted before it is asked for again
const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]; // the engine's 0 = Monday
const enc = encodeURIComponent;
const isTime = (s) => /^\d{2}:\d{2}$/.test(s || "");
const nextDay = (day) => dayKey(addDays(parseDay(day), 1));
const hm = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

// ── pure: our things as Google events, Google's events as our items ─────────
/** The RRULE for one of our rules ("" for a one-off). `allDay` picks the form UNTIL takes. */
export function rrule(r, allDay = true) {
  const rule = r.rule || {};
  const n = Math.max(1, Math.trunc(+rule.interval) || 1);
  let s;
  if (rule.kind === "daily") s = `FREQ=DAILY;INTERVAL=${n}`;
  else if (rule.kind === "weekly") s = `FREQ=WEEKLY;INTERVAL=${n};BYDAY=${(rule.days || []).map((d) => BYDAY[d]).filter(Boolean).join(",")}`;
  // ponytail: day 31 means "last" in the engine, as -1 here; a 30 in February the engine clamps and Google skips
  else if (rule.kind === "monthly") s = `FREQ=MONTHLY;INTERVAL=${n};BYMONTHDAY=${rule.day === 31 ? -1 : rule.day}`;
  else return "";
  const until = R.parseDate(r.until);
  // the end of that day where the user is, written in UTC as the format asks ("T235959Z" was midnight in London)
  if (until) s += `;UNTIL=${allDay ? until.replace(/-/g, "") : new Date(until + "T23:59:59").toISOString().replace(/[-:]|\.\d+/g, "")}`;
  return "RRULE:" + s;
}

/** Start and end of a thing on `day`: the whole day, or `time` and half an hour. */
export function when(day, time, tz) {
  if (!isTime(time)) return { start: { date: day }, end: { date: nextDay(day) } };
  const d = new Date(`${day}T${time}:00`);
  d.setMinutes(d.getMinutes() + 30);
  return { start: { dateTime: `${day}T${time}:00`, timeZone: tz }, end: { dateTime: localIso(d).slice(0, 19), timeZone: tz } };
}

/** A task as the event that stands for it on Google. */
export function taskEvent(t, tz) {
  return { summary: (t.done ? "✓ " : "") + t.text, ...when(t.due_date, t.due_time, tz), transparency: "transparent", extendedProperties: { private: { [TAG]: "task:" + t.id } } };
}

/** A recurring rule as one recurring event, or null when it has no date at all. */
export function ruleEvent(r, tz) {
  const first = R.nextOccurrence(r.rule, r.anchor, r.anchor, r.until);
  if (!first) return null;
  const rr = rrule(r, !isTime(r.time));
  // occurrences skipped in Leonote are skipped there too
  const skip = (r.skip || []).map((d) => R.parseDate(d)).filter(Boolean).sort();
  const ex = !rr || !skip.length ? "" : isTime(r.time)
    ? `EXDATE;TZID=${tz}:${skip.map((d) => d.replace(/-/g, "") + "T" + r.time.replace(":", "") + "00").join(",")}`
    : `EXDATE;VALUE=DATE:${skip.map((d) => d.replace(/-/g, "")).join(",")}`;
  return { summary: r.title, ...when(first, r.time, tz), ...(rr ? { recurrence: ex ? [rr, ex] : [rr] } : {}), transparency: "transparent", extendedProperties: { private: { [TAG]: "rule:" + r.id } } };
}

// ── pure: an .ics file for every other calendar app ─────────────────────────
const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (line) => { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = " " + s.slice(74); } out.push(s); return out.join("\r\n"); };
const icsWhen = (w, tz) => w.start.date
  ? [`DTSTART;VALUE=DATE:${w.start.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${w.end.date.replace(/-/g, "")}`]
  : [`DTSTART;TZID=${tz}:${w.start.dateTime.replace(/[-:]/g, "")}`, `DTEND;TZID=${tz}:${w.end.dateTime.replace(/[-:]/g, "")}`];

/** Tasks with a due date and the active rules as one VCALENDAR (RFC 5545), for Outlook, Apple Calendar and the rest to import. */
export function icsOf(tasks, rules, tz, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Leonote//Calendar//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Leonote"];
  const vevent = (uid, summary, w, extra) => lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEsc(summary)}`, ...icsWhen(w, tz), ...extra, "END:VEVENT");
  for (const t of tasks || []) if (!t.deleted && R.parseDate(t.due_date)) vevent(`task-${t.id}@leonote`, (t.done ? "✓ " : "") + t.text, when(t.due_date, t.due_time, tz), []);
  for (const r of rules || []) {
    if (r.deleted || !r.active) continue;
    const ev = ruleEvent(r, tz);
    if (ev) vevent(`rule-${r.id}@leonote`, r.title, ev, ev.recurrence || []);
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** What of an event has to match for it to be left alone. */
export const sigOf = (cal, body) => cal + "|" + JSON.stringify([body.summary, body.start, body.end, body.recurrence || ""]);

/**
 * One of Google's events as the view's items, one per day it covers. Events
 * Leonote made are left out: the task or rule they stand for is shown instead.
 */
export function eventItems(ev, cal) {
  if (!ev || ev.status === "cancelled") return [];
  if (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private[TAG]) return [];
  const st = ev.start || {}, en = ev.end || {};
  const base = { kind: "event", id: ev.id, cal: cal.id, color: cal.color || "", title: ev.summary || "(no title)", link: ev.htmlLink || "", time: "", end: "", raw: { start: st, end: en, etag: ev.etag } };
  if (st.date) {
    const out = [];
    const stop = en.date || nextDay(st.date);
    for (let d = st.date, i = 0; d < stop && i < 62; d = nextDay(d), i++) out.push({ ...base, day: d, span: stop > nextDay(st.date) });
    return out;
  }
  if (!st.dateTime) return [];
  const a = new Date(st.dateTime);
  return [{ ...base, day: dayKey(a), time: hm(a), end: en.dateTime ? hm(new Date(en.dateTime)) : "" }];
}

/** The 42 days a month's grid shows, from the week holding the 1st. weekStart: 1 Monday, 0 Sunday. */
export function gridDays(ym, weekStart = 1) {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = addDays(first, -((first.getDay() - weekStart + 7) % 7));
  return Array.from({ length: 42 }, (_, i) => dayKey(addDays(start, i)));
}

// ── the account, the events cache and the push ──────────────────────────────
export function createGcal(app) {
  const { S, save, live } = tokenStore(app, "gcal");
  const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const creds = () => ({ clientId: (app.settings.googleClientId || "").trim(), clientSecret: (app.settings.googleClientSecret || "").trim() });
  // a sign-in Google has ended (a test app's 7 days, a revoke) is not connected: Settings offers Sign in again, and
  // nothing keeps asking Google every minute
  const connected = () => { const g = S(); return !!(g && (g.refresh || g.sealed) && !g.expired); };
  // a client secret still kept plainly in settings moves into Windows' seal (google_token adds it from there)
  const plain = (app.settings.googleClientSecret || "").trim();
  if (plain) app.host.aiKeySet("google-secret", plain).then(() => app.setSetting("googleClientSecret", "")).catch(() => {});

  async function token(form) {
    const { clientId, clientSecret } = creds();
    const r = await app.host.googleToken({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), ...form }, "gcal");
    if (r && r.body && r.body.error === "invalid_grant" && form.grant_type === "refresh_token") { save({ expired: true }); app.bus.emit("gcal"); }
    if (!r || r.status !== 200 || !r.body) throw new Error(tokenError(r ? r.status : 0, r && r.body));
    return r.body;
  }

  let refreshing = null;
  async function bearer() {
    const g = S();
    if (!g || !(g.refresh || g.sealed)) throw new Error("Google Calendar is not connected (Settings › Calendar).");
    if (g.expired) throw new Error("The Google sign-in has ended - sign in again in Settings › Calendar.");
    if (live()) return live();
    if (!refreshing) refreshing = token({ grant_type: "refresh_token", refresh_token: g.refresh }).then((j) => { save(tokenRecord(j, g)); return live(); }).finally(() => { refreshing = null; });
    return refreshing;
  }

  const said = (status, json) => {
    const msg = (json && json.error && (json.error.message || json.error.status)) || "";
    if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(msg)) return "Turn on the Google Calendar API for this Google project, then try again.";
    if (status === 429) return "Google says slow down; it will be tried again in a minute.";
    return msg ? `Google said: ${msg}` : `Google answered with ${status}.`;
  };

  async function api(method, path, { params, body, retry = true, ifMatch } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const res = await fetch(url, { method, signal: deadline(20000), headers: { Authorization: `Bearer ${await bearer()}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(ifMatch ? { "If-Match": ifMatch } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && retry) { save({ expires: 0 }); return api(method, path, { params, body, retry: false, ifMatch }); }
    if (res.status === 204) return null;
    if (method === "DELETE" && (res.status === 404 || res.status === 410)) return null; // gone already: as good as done
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(said(res.status, json)), { status: res.status });
    return json;
  }

  let lastWarn = 0;
  const warn = (e) => { if (Date.now() - lastWarn < 60000) return; lastWarn = Date.now(); app.toast(String((e && e.message) || e), { kind: "error", ms: 6000 }); };

  async function connect() {
    if (!creds().clientId) throw new Error("Paste your Google app's Client ID first.");
    const verifier = makeVerifier(), state = makeVerifier(24);
    const { port, redirect } = await app.host.oauthListen(state);
    app.toast(SIGNIN_NOTE, { ms: 9000 });
    app.host.openUrl(authUrl({ clientId: creds().clientId, redirect, challenge: await challengeOf(verifier), state, scopes: SCOPES }));
    const r = await app.host.oauthWait(port, 240000);
    if (r.error) throw new Error(r.error === "access_denied" ? "Sign-in was refused." : `Sign-in failed: ${r.error}`);
    if (r.state !== state) throw new Error("The sign-in answer did not belong to this request.");
    const j = await token({ grant_type: "authorization_code", code: r.code, redirect_uri: redirect, code_verifier: verifier });
    save({ ...tokenRecord(j), calendars: [], show: null, push: "", who: "", expired: false });
    await reloadCalendars();
    syncSoon();
  }

  async function reloadCalendars() {
    const j = await api("GET", "/users/me/calendarList", { params: { minAccessRole: "reader", maxResults: 100 } });
    const cals = (j.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || "", primary: !!c.primary, writable: ["owner", "writer"].includes(c.accessRole) }))
      .sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
    const g = S() || {};
    const primary = cals.find((c) => c.primary);
    save({ calendars: cals, who: primary ? primary.id : g.who || "", show: Array.isArray(g.show) ? g.show.filter((id) => cals.some((c) => c.id === id)) : cals.filter((c) => c.primary).map((c) => c.id) });
    cache.clear();
    app.bus.emit("gcal");
  }

  async function disconnect() {
    await revokeGoogle(app, "gcal", S());
    app.setSetting("gcal", null);
    app.host.aiKeySet("google-gcal", "").catch(() => {});
    cache.clear();
    app.bus.emit("gcal");
  }

  // ── events shown ──
  const cache = new Map(); // "from..to" -> { at, items, busy }
  const iso = (day) => new Date(day + "T00:00:00").toISOString();

  /** Events on the ticked calendars from `from` up to `to` (exclusive), out of the cache; a missing or stale range is fetched and "gcal" fires when it lands. */
  function events(from, to) {
    if (!connected() || (app.settings.calHide || []).includes("google")) return [];
    // asked in fixed blocks of three months (Jan, Apr, Jul, Oct): a calendar scrolling about asks the same
    // blocks again and gets them from here, instead of a fetch for every slightly different range
    const out = [];
    for (let y = +from.slice(0, 4), q = Math.floor((+from.slice(5, 7) - 1) / 3); ; q++) {
      if (q > 3) { q = 0; y++; }
      const a = `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`;
      if (a >= to) break;
      const b = q === 3 ? `${y + 1}-01-01` : `${y}-${String(q * 3 + 4).padStart(2, "0")}-01`;
      for (const it of block(a, b)) if (it.day >= from && it.day < to) out.push(it);
    }
    return out;
  }
  /** Every event already fetched with these words in its title (no request). */
  function cachedFind(words) {
    const seen = new Set(), out = [];
    for (const c of cache.values()) for (const it of c.items) {
      const k = it.id + "|" + it.day;
      if (!seen.has(k) && it.title.toLowerCase().includes(words)) { seen.add(k); out.push(it); }
    }
    return out;
  }
  /** Google's own search over every date of the ticked calendars: one request each, asked for by a click. */
  async function search(words) {
    const g = S();
    if (!connected() || !g) return [];
    const cals = (g.calendars || []).filter((c) => (g.show || []).includes(c.id));
    const lists = await Promise.all(cals.map(async (cal) => {
      const j = await api("GET", `/calendars/${enc(cal.id)}/events`, { params: { q: words, singleEvents: "true", maxResults: 250 } });
      return (j.items || []).flatMap((ev) => eventItems(ev, cal));
    }));
    return lists.flat();
  }
  function block(from, to) {
    const key = from + ".." + to;
    let c = cache.get(key);
    if (!c) {
      c = { at: 0, items: [], busy: false };
      cache.set(key, c);
      // bounded: the oldest block asked for goes first
      if (cache.size > 24) cache.delete(cache.keys().next().value);
    }
    if (!c.busy && Date.now() - c.at > FRESH_MS) {
      c.busy = true;
      fetchRange(from, to).then((items) => { c.items = items; c.at = Date.now(); app.bus.emit("gcal"); })
        .catch((e) => { c.at = Date.now() - FRESH_MS + 60000; warn(e); })
        .finally(() => { c.busy = false; });
    }
    return c.items;
  }

  async function fetchRange(from, to) {
    const g = S();
    const cals = (g.calendars || []).filter((c) => (g.show || []).includes(c.id));
    const lists = await Promise.all(cals.map(async (cal) => {
      const out = [];
      let page = "";
      for (let i = 0; i < 4; i++) {
        const j = await api("GET", `/calendars/${enc(cal.id)}/events`, { params: { timeMin: iso(from), timeMax: iso(to), singleEvents: "true", orderBy: "startTime", maxResults: 250, pageToken: page } });
        for (const ev of j.items || []) out.push(...eventItems(ev, cal));
        page = j.nextPageToken || "";
        if (!page) break;
      }
      return out;
    }));
    return lists.flat().sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time));
  }

  /** A new event of the user's own, on `cal` (the push calendar, else the first writable one shown). */
  async function addEvent({ title, day, time, cal }) {
    const g = S() || {};
    const id = cal || g.push || ((g.calendars || []).find((c) => c.writable && (g.show || []).includes(c.id)) || {}).id;
    if (!id) throw new Error("No calendar of yours to put it on - tick one in Settings › Calendar.");
    await api("POST", `/calendars/${enc(id)}/events`, { body: { summary: title, ...when(day, time, tz()) } });
    cache.clear();
    app.bus.emit("gcal");
  }

  /** A Google event moved by whole days (dragged onto another day in the Calendar), its length kept. */
  async function moveEvent(it, toDay) {
    const delta = Math.round((parseDay(toDay) - parseDay(it.day)) / 86400000);
    if (!delta || !it.raw) return;
    const shift = (p) => {
      if (!p) return p;
      if (p.date) return { date: dayKey(addDays(parseDay(p.date), delta)) };
      const d = new Date(p.dateTime);
      d.setDate(d.getDate() + delta);
      // the time is written in this computer's zone, so it is labelled so (the event's own zone, with this
      // computer's clock time, put a New York event hours off)
      return { dateTime: localIso(d).slice(0, 19), timeZone: tz() };
    };
    const start = shift(it.raw.start), end = shift(it.raw.end);
    // only if it is still the event shown: changed on Google (a phone) since, the move would put back the old time
    let ev;
    try { ev = await api("PATCH", `/calendars/${enc(it.cal)}/events/${enc(it.id)}`, { body: { start, end }, ifMatch: it.raw.etag }); }
    catch (e) { if (e.status === 412) { cache.clear(); app.bus.emit("gcal"); throw new Error("It was changed on Google since - the Calendar shows it as it is now. Move it again."); } throw e; }
    cache.clear();
    app.bus.emit("gcal");
    return { ...it.raw, start, end, etag: ev && ev.etag }; // where it is now, for an Undo that moves it back
  }

  // ── the push ──
  let busy = false, again = false;
  // one retry waiting at a time, later each time it fails again (1 min, 2, 4… up to 30), and the same failure said once
  let retryT = 0, retryDelay = 60000, lastFail = "";
  const retryLater = (e) => {
    const msg = String((e && e.message) || e);
    if (msg !== lastFail) { lastFail = msg; warn(e); }
    clearTimeout(retryT);
    retryT = setTimeout(syncSoon, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30 * 60000);
  };
  const syncSoon = debounce(() => { sync(); }, 1500);

  /** One thing brought in line with what it should be on Google. Returns its new `gcal` record, null once taken off, undefined when nothing changed. */
  // what a PATCH sends: start and end whole (all-day to timed would otherwise keep the old date beside the new time,
  // which Google refuses), and no repeat cleared as such (a rule turned to Once stayed weekly)
  const patchOf = (body) => ({ ...body, start: { date: null, dateTime: null, timeZone: null, ...body.start }, end: { date: null, dateTime: null, timeZone: null, ...body.end }, recurrence: body.recurrence || [] });
  async function place(have, body, cal) {
    const want = body ? sigOf(cal, body) : "";
    if (!want && !have) return undefined;
    if (have && (!want || have.cal !== cal)) {
      await api("DELETE", `/calendars/${enc(have.cal)}/events/${enc(have.id)}`);
      have = null;
      if (!want) return null;
    }
    if (have && have.sig === want) return undefined;
    // PATCH, not PUT: what was added to the event on Google (a place, a note, reminders) stays
    if (have) {
      try { await api("PATCH", `/calendars/${enc(cal)}/events/${enc(have.id)}`, { body: patchOf(body) }); return { id: have.id, cal, sig: want }; }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; } // deleted on Google's side: made anew
    }
    // made before, its answer lost (a timeout, a quit, an older task file restored): taken up again, not made twice
    const tag = body.extendedProperties.private[TAG];
    const found = await api("GET", `/calendars/${enc(cal)}/events`, { params: { privateExtendedProperty: `${TAG}=${tag}`, maxResults: 1, showDeleted: "false" } }).catch(() => null);
    const old = found && found.items && found.items[0];
    if (old) { await api("PATCH", `/calendars/${enc(cal)}/events/${enc(old.id)}`, { body: patchOf(body) }); return { id: old.id, cal, sig: want }; }
    const ev = await api("POST", `/calendars/${enc(cal)}/events`, { body });
    return { id: ev.id, cal, sig: want };
  }

  async function sync() {
    const g = S();
    // signed in, the refresh token kept plainly or (as now) sealed by Windows - the push used to stop once it was sealed
    if (!g || !(g.refresh || g.sealed) || !g.push || g.expired) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const cal = g.push, zone = tz();
      // one that fails (a malformed date, a 403) does not hold up the rest; anything that failed is tried again in a minute
      let failed = null;
      for (const t of app.tasks.all) {
        // a task a rule spawned is the rule's event already; a done task stays only if it was ever pushed
        try {
          const body = !t.deleted && t.due_date && !t.rec_id && (!t.done || t.gcal) ? taskEvent(t, zone) : null;
          const next = await place(t.gcal, body, cal);
          if (next !== undefined) app.tasks.update(t.id, { gcal: next });
        } catch (e) { failed = failed || e; }
      }
      for (const r of app.recurring.data.rules) {
        try {
          const body = !r.deleted && r.active ? ruleEvent(r, zone) : null;
          const next = await place(r.gcal, body, cal);
          if (next !== undefined) { r.gcal = next; app.recurring.touch(); }
        } catch (e) { failed = failed || e; }
      }
      if (failed) retryLater(failed); else { retryDelay = 60000; lastFail = ""; }
    } catch (e) { retryLater(e); }
    finally { busy = false; if (again) { again = false; syncSoon(); } }
  }

  /** Which calendar tasks and rules go on ("" for none); the push starts at once. */
  function setPush(id) { save({ push: id || "" }); cache.clear(); syncSoon(); }
  function setShown(ids) { save({ show: ids }); cache.clear(); app.bus.emit("gcal"); }

  app.tasks.bus.on("changed", syncSoon);
  app.bus.on("recurring", syncSoon);
  setTimeout(() => { sync(); }, 6000);

  return { connected, connect, disconnect, reloadCalendars, events, cachedFind, search, addEvent, moveEvent, setPush, setShown, sync, calendars: () => ((S() || {}).calendars || []), who: () => (S() || {}).who || "", push: () => (S() || {}).push || "", shown: () => (S() || {}).show || [] };
}
