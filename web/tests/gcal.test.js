// Google Calendar: the pure parts - our rules as RRULEs, tasks as events,
// Google's events as the view's items, and the month grid. No network here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rrule, when, taskEvent, ruleEvent, sigOf, eventItems, gridDays, icsOf } from "../gcal.js";

test("a rule becomes the RRULE Google reads", () => {
  assert.equal(rrule({ rule: { kind: "daily", interval: 1 } }), "RRULE:FREQ=DAILY;INTERVAL=1");
  assert.equal(rrule({ rule: { kind: "daily", interval: 3 }, until: "2026-12-31" }), "RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261231");
  // a timed one ends at the end of that day where the user is, written in UTC
  const end = new Date("2026-12-31T23:59:59").toISOString().replace(/[-:]|\.\d+/g, "");
  assert.equal(rrule({ rule: { kind: "daily", interval: 3 }, until: "2026-12-31" }, false), "RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=" + end);
  assert.match(end, /^\d{8}T\d{6}Z$/);
  assert.equal(rrule({ rule: { kind: "weekly", days: [0, 3, 6], interval: 2 } }), "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH,SU");
  assert.equal(rrule({ rule: { kind: "monthly", day: 15, interval: 1 } }), "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15");
  assert.equal(rrule({ rule: { kind: "monthly", day: 31 } }), "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1");
  assert.equal(rrule({ rule: { kind: "once" } }), "");
});

test("a day is a whole-day span; a time is half an hour in the zone", () => {
  assert.deepEqual(when("2026-09-25", "", "Europe/Kyiv"), { start: { date: "2026-09-25" }, end: { date: "2026-09-26" } });
  assert.deepEqual(when("2026-12-31", "junk", "Europe/Kyiv"), { start: { date: "2026-12-31" }, end: { date: "2027-01-01" } });
  assert.deepEqual(when("2026-09-25", "23:45", "Europe/Kyiv"), { start: { dateTime: "2026-09-25T23:45:00", timeZone: "Europe/Kyiv" }, end: { dateTime: "2026-09-26T00:15:00", timeZone: "Europe/Kyiv" } });
});

test("a task is an event that names it, ticked once done, and its signature moves with it", () => {
  const t = { id: "t1", text: "call mom", due_date: "2026-09-25", due_time: "", done: false };
  const ev = taskEvent(t, "UTC");
  assert.equal(ev.summary, "call mom");
  assert.equal(ev.extendedProperties.private.leonote, "task:t1");
  assert.equal(ev.transparency, "transparent");
  const a = sigOf("cal@x", ev);
  assert.equal(a, sigOf("cal@x", taskEvent({ ...t }, "UTC")));
  assert.notEqual(a, sigOf("other", ev));
  assert.notEqual(a, sigOf("cal@x", taskEvent({ ...t, done: true }, "UTC")));
  assert.equal(taskEvent({ ...t, done: true }, "UTC").summary, "✓ call mom");
  assert.notEqual(a, sigOf("cal@x", taskEvent({ ...t, due_time: "09:00" }, "UTC")));
});

test("a rule is one repeating event from its first date; one without dates is nothing", () => {
  const r = { id: "r1", title: "Water plants", anchor: "2026-09-23", until: null, time: "", rule: { kind: "weekly", days: [0, 4], interval: 1 } };
  const ev = ruleEvent(r, "UTC");
  assert.equal(ev.start.date, "2026-09-25"); // the Friday after a Wednesday anchor
  assert.deepEqual(ev.recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR"]);
  assert.equal(ev.extendedProperties.private.leonote, "rule:r1");
  const once = ruleEvent({ id: "r2", title: "Once", anchor: "2026-10-01", until: null, time: "10:00", rule: { kind: "once" } }, "UTC");
  assert.equal(once.recurrence, undefined);
  assert.equal(once.start.dateTime, "2026-10-01T10:00:00");
  assert.equal(ruleEvent({ id: "r3", title: "Gone", anchor: "2026-10-01", until: "2026-09-01", time: "", rule: { kind: "daily", interval: 1 } }, "UTC"), null);
});

test("Google's events become one item per day covered; Leonote's own are left out", () => {
  const cal = { id: "c", color: "#abc" };
  const two = eventItems({ id: "e1", summary: "Trip", htmlLink: "https://x", start: { date: "2026-09-25" }, end: { date: "2026-09-27" } }, cal);
  assert.deepEqual(two.map((i) => i.day), ["2026-09-25", "2026-09-26"]);
  assert.equal(two[0].span, true);
  assert.equal(two[0].color, "#abc");
  assert.equal(two[0].link, "https://x");
  const one = eventItems({ id: "e2", start: { date: "2026-09-25" } }, cal);
  assert.equal(one.length, 1);
  assert.equal(one[0].title, "(no title)");
  assert.equal(one[0].span, false);
  const timed = eventItems({ id: "e3", summary: "Call", start: { dateTime: "2026-09-25T14:30:00Z" }, end: { dateTime: "2026-09-25T15:00:00Z" } }, cal);
  assert.equal(timed.length, 1);
  assert.match(timed[0].time, /^\d\d:\d\d$/);
  assert.match(timed[0].end, /^\d\d:\d\d$/);
  assert.deepEqual(eventItems({ id: "e4", status: "cancelled", start: { date: "2026-09-25" } }, cal), []);
  assert.deepEqual(eventItems({ id: "e5", start: { date: "2026-09-25" }, extendedProperties: { private: { leonote: "task:t1" } } }, cal), []);
  assert.deepEqual(eventItems({ id: "e6" }, cal), []);
});

test("the grid is six weeks from the week of the 1st, on the chosen first day", () => {
  const mon = gridDays("2026-09", 1);
  assert.equal(mon.length, 42);
  assert.equal(mon[0], "2026-08-31"); // 1 Sep 2026 is a Tuesday
  assert.equal(mon[41], "2026-10-11");
  const sun = gridDays("2026-09", 0);
  assert.equal(sun[0], "2026-08-30");
  assert.equal(gridDays("2026-02", 1)[0], "2026-01-26");
});

test("skipped occurrences travel as EXDATE, in the form the event's time asks for", () => {
  const r = { id: "r1", title: "Water plants", anchor: "2026-09-23", until: null, time: "", skip: ["2026-10-02", "2026-09-28"], rule: { kind: "weekly", days: [0, 4], interval: 1 } };
  assert.deepEqual(ruleEvent(r, "Europe/Kyiv").recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR", "EXDATE;VALUE=DATE:20260928,20261002"]);
  assert.deepEqual(ruleEvent({ ...r, time: "09:30" }, "Europe/Kyiv").recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR", "EXDATE;TZID=Europe/Kyiv:20260928T093000,20261002T093000"]);
  assert.deepEqual(ruleEvent({ ...r, skip: [] }, "Europe/Kyiv").recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR"]);
});

test("the .ics carries tasks and rules, escaped and folded", () => {
  const tasks = [
    { id: "t1", text: "Call mom; bring cake, please", due_date: "2026-09-25", due_time: "", done: false },
    { id: "t2", text: "Timed", due_date: "2026-09-26", due_time: "14:00", done: true },
    { id: "t3", text: "No date", due_date: null },
    { id: "t4", text: "Trashed", due_date: "2026-09-27", deleted: true },
  ];
  const rules = [{ id: "r1", title: "Water plants", anchor: "2026-09-23", until: "2026-12-31", time: "", skip: ["2026-09-28"], active: true, deleted: false, rule: { kind: "weekly", days: [0, 4], interval: 1 } }];
  const ics = icsOf(tasks, rules, "Europe/Kyiv", new Date("2026-09-25T10:00:00Z"));
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.ok(ics.includes("SUMMARY:Call mom\\; bring cake\\, please"));
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20260925\r\nDTEND;VALUE=DATE:20260926"));
  assert.ok(ics.includes("SUMMARY:✓ Timed"));
  assert.ok(ics.includes("DTSTART;TZID=Europe/Kyiv:20260926T140000\r\nDTEND;TZID=Europe/Kyiv:20260926T143000"));
  assert.ok(ics.includes("UID:rule-r1@leonote"));
  assert.ok(ics.includes("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR;UNTIL=20261231"));
  assert.ok(ics.includes("EXDATE;VALUE=DATE:20260928"));
  assert.ok(ics.includes("DTSTAMP:20260925T100000Z"));
  for (const line of ics.split("\r\n")) assert.ok(line.length <= 75, line);
  const long = icsOf([{ id: "t9", text: "x".repeat(200), due_date: "2026-09-25" }], [], "UTC");
  assert.ok(long.includes("\r\n x"));
});

test("an account's hour-long access token is kept in memory, never in the settings", async () => {
  const { tokenStore, tokenRecord } = await import("../ytaccount.js");
  const settings = { gcal: { refresh: "", sealed: true, access: "old-token", expires: 1 } };
  const app = { settings, setSetting: (k, v) => { settings[k] = v; } };
  const { S, save, live } = tokenStore(app, "gcal");
  assert.ok(!("access" in S()) && !("expires" in S()), "an earlier version's token is taken out");
  save(tokenRecord({ access_token: "tok-91xQ", expires_in: 3600, sealed: true }));
  assert.equal(live(), "tok-91xQ");
  assert.ok(!JSON.stringify(settings).includes("tok-91xQ"), "not in the settings");
  assert.equal(S().sealed, true);
  save({ expires: 0 });
  assert.equal(live(), "", "expired: asked for again");
});
