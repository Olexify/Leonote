// Parity tests for web/recurring.js against golden vectors produced by the legacy
// Python engine (web/tests/gen_recurring_vectors.py -> recurring_vectors.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as R from "../recurring.js";

const V = JSON.parse(readFileSync(new URL("./recurring_vectors.json", import.meta.url), "utf8"));
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const action = (data, res = null) => ({
  data,
  xp: res ? res.awardXp : 0,
  tasks_done: res && res.closeTaskId != null ? 1 : 0,
  closed: res && res.closeTaskId != null ? [res.closeTaskId] : [],
});

// Each runner returns the value in the exact shape the Python side serialised.
const RUNNERS = {
  parseDate: ([s]) => R.parseDate(s),
  normRule: ({ input, today }) => {
    const out = R.normRule(clone(input), today);
    if (!("id" in input)) {
      assert.match(out.id, UUID_RE);
      out.id = "<uuid>";
    }
    return out;
  },
  isOccurrence: ([rule, d, a]) => R.isOccurrence(rule, d, a),
  nextOccurrence: ([rule, f, a, u]) => R.nextOccurrence(rule, f, a, u),
  nextOccurrences: ([r, f, c, t]) => R.nextOccurrences(r, f, c, t),
  nextDue: ([r, t]) => {
    const x = R.nextDue(r, t);
    return [x.date, x.overdue];
  },
  dueOccurrences: ([r, lf, t, lim]) => {
    const x = R.dueOccurrences(r, lf, t, lim);
    return [x.dates, x.truncated];
  },
  occKey: ([rid, d]) => R.occKey(rid, d),
  catchUpPlan: ([rules, t, keys, log]) => {
    const x = R.catchUpPlan(rules, t, new Set(keys), log);
    return [x.spawns, x.updates, x.fired];
  },
  streak: ([r, log, t]) => R.streak(r, log, t),
  rate: ([r, log, t, w]) => {
    const x = R.rate(r, log, t, w);
    return [x.hits, x.total];
  },
  describe: ([r]) => R.describe(r),
  fmtDate: ([d, t]) => R.fmtDate(d, t),
  markDone: (a) => {
    const data = clone(a.data);
    return action(data, R.markDone(data, a.rid, a.today, clone(a.tasks)));
  },
  snooze: (a) => {
    const data = clone(a.data);
    R.snooze(data, a.rid, a.today, a.days);
    return action(data);
  },
  skipNext: (a) => {
    const data = clone(a.data);
    R.skipNext(data, a.rid, a.today);
    return action(data);
  },
  toggleActive: (a) => {
    const data = clone(a.data);
    R.toggleActive(data, a.rid);
    return action(data);
  },
  softDelete: (a) => {
    const data = clone(a.data);
    R.softDelete(data, a.rid, a.nowIso);
    return action(data);
  },
  // App._rec_catch_up: plan -> task-mode spawns inserted at the front -> last_fired
  catchUpApply: (a) => {
    const data = clone(a.data);
    const tasks = clone(a.tasks);
    const rules = data.rules ?? [];
    let newTasks = [];
    if (rules.length) {
      const plan = R.catchUpPlan(rules, a.today, R.taskKeys(tasks), data.log ?? {});
      const made = plan.spawns.filter((s) => s.mode === "task").map((s) => R.specToTask(s, a.nowIso));
      const byId = new Map(rules.map((r) => [r.id, r]));
      for (const [rid, patch] of Object.entries(plan.updates)) {
        const r = byId.get(rid);
        if (r) Object.assign(r, patch);
      }
      newTasks = made.reverse(); // each was insert(0, t) in Python
    }
    return { data, newTasks };
  },
};

const byFn = new Map();
for (const c of V.cases) {
  if (!byFn.has(c.fn)) byFn.set(c.fn, []);
  byFn.get(c.fn).push(c);
}

test("golden vectors cover every runner", () => {
  assert.equal(V.cases.length, V.meta.total);
  assert.deepEqual([...byFn.keys()].sort(), Object.keys(RUNNERS).sort());
});

for (const [fn, cases] of byFn) {
  test(`python parity: ${fn} (${cases.length} cases)`, () => {
    const failures = [];
    for (const c of cases) {
      const input = clone(c.args);
      try {
        if ("error" in c) {
          let threw = false;
          try {
            RUNNERS[fn](input);
          } catch {
            threw = true;
          }
          if (!threw) failures.push({ args: c.args, expected: `throws ${c.error}` });
        } else {
          assert.deepStrictEqual(RUNNERS[fn](input), c.ok);
        }
      } catch (e) {
        failures.push({ args: c.args, expected: c.ok, got: e.actual ?? String(e) });
      }
      if (failures.length >= 5) break;
    }
    if (failures.length) assert.fail(JSON.stringify(failures, null, 1).slice(0, 6000));
  });
}

test("API boundary: ISO strings in and out", () => {
  const r = R.normRule({ title: "Bins", anchor: "2024-01-31", created: "2024-01-31", rule: { kind: "monthly", day: 31 } }, "2024-01-31");
  assert.match(r.id, UUID_RE);
  assert.deepEqual(R.nextOccurrences(r, "2024-01-31", 3), ["2024-01-31", "2024-02-29", "2024-03-31"]);
  assert.equal(R.describe(r), "Monthly · day 31 (last)");
  assert.equal(R.fmtDate("2024-02-29", "2024-01-31"), "Thu 29 Feb");
  assert.equal(R.fmtDate("2025-02-28", "2024-01-31"), "Fri 28 Feb 2025");
  assert.deepEqual(R.nextDue(r, "2024-02-01"), { date: "2024-01-31", overdue: true });
  r.last_fired = "2024-01-31";
  assert.deepEqual(R.nextDue(r, "2024-02-01"), { date: "2024-02-29", overdue: false });
});

test("specToTask builds the legacy task fields", () => {
  const t = R.specToTask({ rule_id: "r1", title: "Pay rent", date: "2026-09-15", missed: 3, priority: "high", time: "08:30", mode: "task" }, "2026-09-15T09:30:00");
  assert.deepEqual(t, {
    text: "Pay rent  (+3 missed)", done: false, created: "2026-09-15T09:30:00", priority: "high", subtasks: [],
    rec_id: "r1", rec_date: "2026-09-15", due_date: "2026-09-15", due_time: "08:30",
    due_jumped: true, scheduled_jumped: true, deleted: false, start_date: null,
  });
  assert.equal(R.specToTask({ rule_id: "r1", title: "x", date: "2026-09-15", missed: 0 }, "n").text, "x");
});
