// Tab groups: the rules of the strip (node --test web/tests/)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize, groupRange, stripItems, nearestVisible, nextColor, makeGroup, addToNewGroup, addToGroup,
  removeFromGroup, ungroup, dropPlan, applyDrop, groupOnto, groupDropSlot, moveGroup, extractGroup,
  tabExtras, cleanGroups, saveGroups, mergeIntoSpace, COLORS,
} from "../tabgroups.js";

// a strip from a short spec: "P" pinned, "a" loose, "a:g1" in group g1
const strip = (...spec) => spec.map((s) => {
  const [name, group] = s.split(":");
  return { name, ...(name === name.toUpperCase() && /[A-Z]/.test(name) ? { pinned: true } : {}), ...(group ? { group } : {}) };
});
const G = (id, extra) => ({ id, name: id, color: "blue", collapsed: false, ...extra });
const names = (tabs) => tabs.map((t) => (t.group ? `${t.name}:${t.group}` : t.name)).join(" ");

test("normalize: pinned first, groups gathered where they start, pinned never grouped", () => {
  const tabs = strip("a:g1", "b", "P:g1", "c:g1", "d:zz");
  const r = normalize(tabs, [G("g1"), G("g2")]);
  assert.equal(names(r.tabs), "P a:g1 c:g1 b d");
  assert.deepEqual(r.groups.map((g) => g.id), ["g1"]); // g2 had no tabs
  assert.equal(r.tabs[0], tabs[2]); // identity kept
});

test("groupRange and stripItems", () => {
  const tabs = strip("P", "a", "b:g1", "c:g1", "d");
  const groups = [G("g1")];
  assert.deepEqual(groupRange(tabs, "g1"), { start: 2, end: 4 });
  assert.equal(groupRange(tabs, "nope"), null);
  const items = stripItems(tabs, groups);
  assert.deepEqual(items.map((x) => (x.kind === "tab" ? x.index : x.tabs)), [0, 1, [2, 3], 4]);
  assert.equal(items[2].group, groups[0]);
});

test("nearestVisible skips tabs in collapsed groups", () => {
  const tabs = strip("a", "b:g1", "c:g1", "d");
  const groups = [G("g1", { collapsed: true })];
  assert.equal(nearestVisible(tabs, groups, 1), 0); // the left neighbour beats jumping the group
  assert.equal(nearestVisible(tabs, groups, 3), 3); // the tab that slid into place
  assert.equal(nearestVisible(strip("b:g1", "c:g1", "d"), groups, 0), 2);
  assert.equal(nearestVisible(strip("b:g1", "c:g1"), groups, 0), -1);
  assert.equal(nearestVisible(tabs, [], 1), 1);
});

test("new groups pick an unused colour", () => {
  assert.equal(nextColor([]), "blue");
  assert.equal(nextColor([{ color: "blue" }, { color: "teal" }]), "green");
  const all = COLORS.slice(1).map((color) => ({ color }));
  assert.ok(COLORS.includes(nextColor(all)));
  const g = makeGroup([G("g1")], { name: "Work" });
  assert.equal(g.name, "Work");
  assert.notEqual(g.id, "g1");
  assert.equal(g.collapsed, false);
});

test("menu actions: new group, join, leave, ungroup", () => {
  let s = { tabs: strip("P", "a", "b", "c"), groups: [] };
  s = addToNewGroup(s.tabs, s.groups, 0, G("x")); // pinned: refused
  assert.equal(s.groups.length, 0);
  s = addToNewGroup(s.tabs, s.groups, 2, G("g1"));
  assert.equal(names(s.tabs), "P a b:g1 c");
  s = addToGroup(s.tabs, s.groups, 1, "g1"); // joins at the right end
  assert.equal(names(s.tabs), "P b:g1 a:g1 c");
  s = addToGroup(s.tabs, s.groups, 3, "g1");
  assert.equal(names(s.tabs), "P b:g1 a:g1 c:g1");
  s = removeFromGroup(s.tabs, s.groups, 1); // leaves to just after the group
  assert.equal(names(s.tabs), "P a:g1 c:g1 b");
  s = ungroup(s.tabs, s.groups, "g1");
  assert.equal(names(s.tabs), "P a c b");
  assert.equal(s.groups.length, 0);
});

test("a new group from a tab inside another group lands next to it", () => {
  const s = addToNewGroup(strip("a:g1", "b:g1", "c:g1"), [G("g1")], 1, G("g2"));
  assert.equal(names(s.tabs), "a:g1 c:g1 b:g2");
  assert.equal(s.groups.length, 2);
});

test("the last tab leaving removes its group", () => {
  const s = removeFromGroup(strip("a:g1", "b"), [G("g1")], 0);
  assert.equal(s.groups.length, 0);
  assert.equal(names(s.tabs), "a b");
});

test("drop: onto a grouped tab joins, onto a loose tab leaves", () => {
  const groups = [G("g1")];
  // x a b:g1 c:g1 d ; drag x between b and c
  let tabs = strip("x", "a", "b:g1", "c:g1", "d");
  let plan = dropPlan(tabs, groups, 0, { tab: 2, after: true });
  assert.deepEqual(plan, { slot: 3, group: "g1" });
  assert.equal(names(applyDrop(tabs, groups, 0, plan).tabs), "a b:g1 x:g1 c:g1 d");
  // drag c out past the right edge (over d's left half)
  tabs = strip("a", "b:g1", "c:g1", "d");
  plan = dropPlan(tabs, groups, 2, { tab: 3, after: false });
  assert.deepEqual(plan, { slot: 3, group: null });
  assert.equal(names(applyDrop(tabs, groups, 2, plan).tabs), "a b:g1 c d");
  // drag b out past the left edge (over a's right half)
  tabs = strip("a", "b:g1", "c:g1", "d");
  plan = dropPlan(tabs, groups, 1, { tab: 0, after: true });
  assert.equal(names(applyDrop(tabs, groups, 1, plan).tabs), "a b c:g1 d");
  // reordering inside a group keeps it
  tabs = strip("a:g1", "b:g1", "c:g1");
  plan = dropPlan(tabs, groups, 0, { tab: 2, after: true });
  assert.equal(names(applyDrop(tabs, groups, 0, plan).tabs), "b:g1 c:g1 a:g1");
});

test("drop: ordinary reordering of loose tabs never groups", () => {
  const tabs = strip("a", "b", "c");
  const plan = dropPlan(tabs, [], 0, { tab: 1, after: true });
  assert.deepEqual(plan, { slot: 2, group: null });
  const s = applyDrop(tabs, [], 0, plan);
  assert.equal(names(s.tabs), "b a c");
  assert.equal(s.groups.length, 0);
});

test("drop: onto a chip joins (or goes before it at the left edge)", () => {
  const groups = [G("g1")];
  const tabs = strip("a", "b:g1", "c:g1", "x");
  assert.deepEqual(dropPlan(tabs, groups, 3, { chip: "g1", x: 0.6 }), { slot: 1, group: "g1" });
  assert.deepEqual(dropPlan(tabs, groups, 3, { chip: "g1", x: 0.1 }), { slot: 1, group: null });
  const collapsed = [G("g1", { collapsed: true })];
  assert.deepEqual(dropPlan(tabs, collapsed, 0, { chip: "g1", x: 0.6 }), { slot: 3, group: "g1" });
  assert.equal(names(applyDrop(tabs, collapsed, 0, { slot: 3, group: "g1" }).tabs), "b:g1 c:g1 a:g1 x");
});

test("drop: pinned stay first, loose tabs stay after them", () => {
  const tabs = strip("P", "Q", "a", "b");
  assert.deepEqual(dropPlan(tabs, [], 3, { tab: 0, after: false }), { slot: 2, group: null });
  assert.deepEqual(dropPlan(tabs, [], 0, { tab: 3, after: true }), { slot: 2, group: null });
  assert.deepEqual(dropPlan(tabs, [], 0, { end: true }), { slot: 2, group: null });
  assert.equal(names(applyDrop(tabs, [], 0, { slot: 2, group: null }).tabs), "Q P a b");
});

test("drop and hold: makes a group, or joins the target's", () => {
  let s = groupOnto(strip("a", "b", "c"), [], 0, 2, G("g1"));
  assert.equal(names(s.tabs), "b c:g1 a:g1");
  assert.equal(s.groups.length, 1);
  s = groupOnto(strip("x", "a:g1", "b:g1"), [G("g1")], 0, 1, G("new"));
  assert.equal(names(s.tabs), "a:g1 x:g1 b:g1");
  assert.deepEqual(s.groups.map((g) => g.id), ["g1"]);
  // pinned tabs never group
  s = groupOnto(strip("P", "a"), [], 1, 0, G("g1"));
  assert.equal(s.groups.length, 0);
});

test("dragging a whole group", () => {
  const groups = [G("g1"), G("g2")];
  const tabs = strip("P", "a", "b:g1", "c:g1", "d", "e:g2", "f:g2");
  // over d's right half: after d
  let slot = groupDropSlot(tabs, groups, "g1", { tab: 4, after: true });
  assert.equal(slot, 5);
  assert.equal(names(moveGroup(tabs, groups, "g1", slot).tabs), "P a d b:g1 c:g1 e:g2 f:g2");
  // over another group: snaps to its nearer edge, never inside it
  slot = groupDropSlot(tabs, groups, "g1", { tab: 6, after: true });
  assert.equal(slot, 7);
  assert.equal(names(moveGroup(tabs, groups, "g1", slot).tabs), "P a d e:g2 f:g2 b:g1 c:g1");
  assert.equal(groupDropSlot(tabs, groups, "g1", { tab: 5, after: false }), 5);
  // among pinned: right after them
  slot = groupDropSlot(tabs, groups, "g2", { tab: 0, after: false });
  assert.equal(names(moveGroup(tabs, groups, "g2", slot).tabs), "P e:g2 f:g2 a b:g1 c:g1 d");
  // over itself: nothing
  assert.equal(groupDropSlot(tabs, groups, "g1", { tab: 2, after: true }), null);
  assert.equal(moveGroup(tabs, groups, "g1", null).tabs, tabs);
});

test("extractGroup takes a group's tabs out", () => {
  const tabs = strip("a", "b:g1", "c:g1", "d");
  const r = extractGroup(tabs, [G("g1"), G("g2")], "g1");
  assert.equal(names(r.moved), "b:g1 c:g1");
  assert.equal(r.group.id, "g1");
  assert.equal(names(r.tabs), "a d");
  assert.deepEqual(r.groups, []);
});

test("saving: extras and groups round-trip, old data loads", () => {
  assert.deepEqual(tabExtras({ kind: "note", path: "a.md" }), {});
  // a real pin stays out of groups; "pinned" alone is a minimized tab from before the two were told apart
  assert.deepEqual(tabExtras({ pinned: true, full: true, color: "red", group: "g1" }), { pinned: true, full: true, color: "red" });
  assert.deepEqual(tabExtras({ pinned: true, color: "red", group: "g1" }), { mini: true, color: "red", group: "g1" });
  assert.deepEqual(tabExtras({ mini: true, color: "#3b9eff", look: { bold: true } }), { mini: true, color: "#3b9eff", look: { bold: true } });
  assert.deepEqual(tabExtras({ color: "nope", group: "g1" }), { group: "g1" });
  assert.deepEqual(cleanGroups(undefined), []);
  const raw = [G("g1", { collapsed: 1, extra: 5 }), null, { id: "" }, G("g1"), { id: "g2", color: "pink" }];
  const clean = cleanGroups(raw);
  assert.deepEqual(clean, [
    { id: "g1", name: "g1", color: "blue", collapsed: true },
    { id: "g2", name: "", color: "grey", collapsed: false },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(saveGroups(clean))), clean);
  // a customized look survives a save and a load
  const styled = cleanGroups([G("g3", { look: { icon: "star", bold: true } })]);
  assert.deepEqual(cleanGroups(saveGroups(styled)), styled);
  assert.deepEqual(styled[0].look, { icon: "star", bold: true });
});

test("mergeIntoSpace moves a group into another space's saved tabs", () => {
  const same = (a, b) => a.kind === b.kind && a.path === b.path;
  const target = { tabs: [{ kind: "note", path: "x.md" }, { kind: "note", path: "b.md", color: "red" }], groups: [G("g1")] };
  const r = mergeIntoSpace(target, [{ kind: "note", path: "b.md" }, { kind: "note", path: "c.md" }], G("g1", { name: "Trip" }), same);
  assert.equal(r.groups.length, 2);
  const g = r.groups[1];
  assert.notEqual(g.id, "g1"); // clashing id renamed
  assert.equal(g.name, "Trip");
  assert.deepEqual(r.tabs.map((l) => `${l.path}${l.group ? ":" + (l.group === g.id ? "new" : l.group) : ""}`), ["x.md", "b.md:new", "c.md:new"]);
  // loads into a clean strip
  const loaded = normalize(r.tabs.map((l) => ({ ...l, name: l.path })), cleanGroups(r.groups));
  assert.equal(loaded.groups.length, 1);
});
