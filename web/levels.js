// Levels, ranks, streak, challenges, colours, badges and the year so far: the lower part of the
// Timer view, scrolled to from the level chip at the foot of the sidebar, the level card, or Ctrl+P.

import { h, dayKey } from "./util.js";
import { icon } from "./icons.js";
import { XP, RANKS, rankOf, costOf, badgesOf, dayBonus, CHALLENGE_ALL, RANK_COLORS } from "./stats.js";
import { ACCENTS, ACCENT_UNLOCKS } from "./settings.js";

const EARN = [
  ["Finish a task", XP.taskDone], ["Add a task", XP.taskCreated], ["Tick a step of a task", XP.subtaskDone],
  ["Keep a habit for the day", XP.habitDone], ["Finish a repeating task", XP.recurringDone], ["A minute of focus (timer)", 1],
  ["A workout set", XP.workoutSet], ["A whole workout", XP.sessionDone], ["Finish a fast", XP.fastDone],
];

// outside the view: it is redrawn as stats change (the timer), and must stay open
let coloursAll = false;

/** To the Timer view, scrolled down to where the levels are. */
export function openLevels(app) {
  app.openView("timer");
}

/* The year so far (or one before): focus hours, tasks finished, the best day and month, the longest
   streak - read from what is kept already. */
function yearCard(app, year, setYear) {
  const S = app.stats;
  const n = (x) => Number(x).toLocaleString();
  const y = String(year);
  const focus = Object.entries(S.data.pomo_daily || {}).filter(([d]) => d.startsWith(y));
  const secs = focus.reduce((a, [, v]) => a + ((v && v.work) || 0), 0);
  const best = focus.reduce((b, [d, v]) => (((v && v.work) || 0) > b[1] ? [d, v.work] : b), ["", 0]);
  const months = Array.from({ length: 12 }, (_, m) => focus.filter(([d]) => Number(d.slice(5, 7)) === m + 1).reduce((a, [, v]) => a + ((v && v.work) || 0), 0));
  const top = Math.max(1, ...months);
  const bestMonth = months.indexOf(Math.max(...months));
  const done = (app.tasks.all || []).filter((t) => t.done && String(t.completed_at || "").startsWith(y)).length;
  const added = (app.tasks.all || []).filter((t) => String(t.created || t.created_at || "").startsWith(y)).length;
  const monthName = (m) => new Date(2000, m, 1).toLocaleDateString(undefined, { month: "long" });
  const years = [...new Set(Object.keys(S.data.pomo_daily || {}).map((d) => Number(d.slice(0, 4))).filter(Boolean))];
  const fact = (big, small) => h("div", { class: "lv-fact" }, h("b", { text: big }), h("small", { text: small }));
  return h("section", { class: "lv-card lv-year" },
    h("h3", {}, icon("calendar"), `Your ${year}`, h("span", { class: "lv-gap" }),
      years.includes(year - 1) ? h("button", { class: "icon-btn", title: String(year - 1), onclick: () => setYear(year - 1) }, icon("back")) : null,
      year < new Date().getFullYear() ? h("button", { class: "icon-btn", title: String(year + 1), onclick: () => setYear(year + 1) }, icon("forward")) : null),
    h("div", { class: "lv-facts" },
      fact(`${n(Math.round(secs / 3600))} h`, "of focus"),
      fact(n(done), `tasks finished${added ? ` (of ${n(added)} added)` : ""}`),
      fact(best[1] ? `${Math.round(best[1] / 60)} min` : "-", best[0] ? `best day, ${new Date(best[0] + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "best day"),
      fact(months[bestMonth] ? monthName(bestMonth) : "-", "the month you focused most"),
      fact(`${(S.streak().best) || 0}`, "longest streak, days")),
    h("div", { class: "lv-months", title: "Focus, month by month" }, ...months.map((v, m) => h("div", { class: "lv-month", title: `${monthName(m)}: ${Math.round(v / 3600)} h` },
      h("span", { style: { height: `${v ? Math.max(4, (v / top) * 100) : 0}%` } }), h("small", { text: monthName(m).slice(0, 1) })))));
}

/** The levels part of the Timer view: drawn afresh when the stats change. */
export function levelsSection(app, host) {
  let year = new Date().getFullYear();
  const draw = () => host.replaceChildren(body(app, year, (y) => { year = y; draw(); }));
  draw();
  return draw;
}

const RANK_SAYS = {
  "Awakened": "You opened your eyes - the journey starts here.",
  "Lion cub": "Small paws, big steps. The first levels are yours.",
  "Apprentice": "You came to learn, and you keep coming back.",
  "Explorer": "You left the trodden path and found your own.",
  "Hunter": "You chase what you want - and you catch it.",
  "Disciplined": "Day after day, you show up. That is the whole secret.",
  "Steady": "Storms come; you hold your ground.",
  "Thinker": "You don't just do - you understand.",
  "Scholar": "Knowledge kept, written down and put to use.",
  "Guardian": "You guard what matters: your time, your focus.",
  "Warrior": "Every hard task met head on.",
  "Veteran": "Battle-tested. Seen it all, still standing.",
  "Strategist": "You plan three moves ahead.",
  "Elder": "Wisdom grown slowly, like an old tree.",
  "Master": "You hold the key to your craft.",
  "Leader": "The way you work is a way others could follow.",
  "Lionheart": "Courage made into a habit.",
  "Knight": "Sworn to your goals, sword in hand.",
  "Champion": "You won the long fight with yourself.",
  "Commander": "Your days answer to you.",
  "General": "Whole campaigns, carried through.",
  "Warlord": "Relentless. Nothing stands in your way for long.",
  "Lord": "A realm of your own, built stone by stone.",
  "King of the Pride": "The pride is yours. Long may you reign.",
  "Legend": "They will tell stories about this.",
  "Titan": "Strength beyond the human scale.",
  "Colossus": "You stand on the mountains you climbed.",
  "Immortal": "Time cannot wear you down any more.",
  "Celestial": "You walk among the stars now.",
  "Sunborn": "Born of fire, burning bright.",
  "Sun Lion": "The sun's own lion - golden and fierce.",
  "Eternal": "Beyond the reach of hours.",
  "Starkindler": "You light the dead stars again - one more for every 1,000 levels.",
};

function body(app, year, setYear) {
  const S = app.stats;
  const p = S.progress();
  const rank = rankOf(p.level);
  const st = S.streak();
  const n = (x) => Number(x).toLocaleString();

  // the last 12 weeks, a square a day
  const days = S.data.xp_days || {};
  const cells = [];
  let most = 1;
  for (let i = 83; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = dayKey(d); cells.push([k, days[k] || 0]); most = Math.max(most, days[k] || 0); }
  const heat = h("div", { class: "lv-heat", title: "XP each day, the last 12 weeks" }, ...cells.map(([k, v]) => h("span", { class: v ? "" : "is-empty", style: { "--a": String(v ? 0.25 + 0.75 * (v / most) : 0) }, title: `${k}: ${n(v)} XP` })));

  const ladder = h("div", { class: "lv-ranks" }, ...RANKS.map(([lv, name, ic], i) => {
    const on = rank.rank === name;
    const past = lv <= p.level && !on;
    // what is reached glows, and the higher the rank the more: k runs 0..1 up the ladder; the later arcs shimmer
    // the page is drawn afresh whenever the stats change: each effect's start is set by the clock, so it
    // carries on where it was instead of starting over
    const k = i / (RANKS.length - 1);
    const tier = k >= 0.72 ? " is-mythic" : k >= 0.48 ? " is-epic" : k >= 0.24 ? " is-rare" : "";
    // each rank its own colour; each arc its own effect - a glow, a heartbeat, rising embers, and stars that
    // twinkle round the myths even before they are reached
    const fx = i >= 24 ? " fx-stars" : i >= 17 ? " fx-embers" : i >= 9 ? " fx-pulse" : " fx-glow";
    return h("div", { class: "lv-rank" + fx + (i % 2 ? " is-rev" : "") + (on ? " is-on" : past ? " is-past" : "") + (on || past ? " is-got" + tier : ""), style: { "--k": k.toFixed(3), "--rc": RANK_COLORS[i] || "var(--accent)", "--d": (2.1 + ((i * 37) % 17) / 10).toFixed(2) + "s", "--dl": `-${(performance.now() / 1000 + i * 0.73).toFixed(3)}s` } },
      h("span", { class: "lv-rank-ic" }, icon(ic)), h("b", { text: name }), h("small", { text: i === RANKS.length - 1 ? `level ${lv} · a ★ every 1,000 levels` : `level ${lv}` }));
  }));

  // the rank under the pointer rolls out a line: a little celebration of what got you there, or what is still ahead
  const says = h("div", { class: "lv-says", hidden: true });
  ladder.append(says);
  let saysFor = null;
  ladder.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".lv-rank");
    // moving over the card's own parts (its icon, its name) keeps the line as it is
    if (!el || el === saysFor) return;
    saysFor = el;
    const [lv, name] = RANKS[[...ladder.querySelectorAll(".lv-rank")].indexOf(el)] || [];
    if (name == null) return;
    const got = el.classList.contains("is-got");
    says.replaceChildren(h("b", { text: got ? name : `${name} · level ${lv}` }), h("span", { text: got ? RANK_SAYS[name] || "" : `Reached at level ${lv} - ${Math.max(0, lv - p.level)} to go.` }));
    says.classList.toggle("is-got", got);
    says.style.left = Math.max(0, Math.min(ladder.clientWidth - 240, el.offsetLeft + el.offsetWidth / 2 - 120)) + "px";
    says.style.top = el.offsetTop + el.offsetHeight + 6 + "px";
    says.hidden = false;
    says.classList.remove("is-in");
    requestAnimationFrame(() => says.classList.add("is-in"));
  });
  ladder.addEventListener("mouseleave", () => { says.hidden = true; saysFor = null; });

  const badges = h("div", { class: "lv-badges" }, ...badgesOf(S.data).map((b) => h("div", { class: "lv-badge" },
    h("div", { class: "lv-badge-head" }, icon(b.icon), h("b", { text: b.label }), h("small", { class: "lv-stage", text: b.got >= b.steps.length ? "complete" : `stage ${b.stage + 1} of 3` }), h("span", { class: "lv-gap" }), h("small", { text: b.next ? `${n(b.value)} / ${n(b.next)}` : `${n(b.value)} - all of them` })),
    h("div", { class: "lv-steps" }, ...b.shown.map((x) => h("span", { class: b.value >= x ? "is-got" : "", title: `${n(x)}`, text: x >= 1000 ? `${x / 1000}k` : String(x) }))))));

  // today's three: how far each has got
  const ch = S.challenges();
  const today = h("section", { class: "lv-card lv-today" },
    h("h3", {}, icon("target"), "Today", h("span", { class: "lv-gap" }), h("small", { text: `${ch.filter((c) => c.done).length} of ${ch.length} · all of them: +${CHALLENGE_ALL} more` })),
    ...ch.map((c) => h("div", { class: "lv-ch" + (c.done ? " is-done" : "") },
      h("span", { class: "lv-ch-mark" }, c.done ? icon("check") : null),
      h("span", { class: "lv-ch-text", text: c.text }),
      h("small", { text: c.done ? `+${c.reward}` : `${Math.min(c.have, c.target)} / ${c.target} · +${c.reward}` }),
      h("span", { class: "lv-ch-bar" }, h("span", { style: { width: `${Math.round((Math.min(c.have, c.target) / c.target) * 100)}%` } })))),
    h("p", { class: "lv-note", text: "New ones each day. They move only when you do the work - nothing to keep an eye on." }));

  // the colours the ranks unlock: a click wears one
  // the ones you have and the next one; the rest behind "+N more"
  const near = ([, [, lv]]) => p.level >= lv - 10;
  const paintColours = () => colours.replaceChildren(...Object.entries(ACCENT_UNLOCKS).filter((e) => coloursAll || near(e)).map(([k, [rk, lv]]) => {
    const shut = p.level < lv;
    return h("button", { class: "lv-colour" + (shut ? " is-locked" : "") + (app.settings.accent === k ? " is-on" : ""), style: { "--c": ACCENTS[k] }, disabled: shut,
      title: shut ? `Unlocked at ${rk} (level ${lv})` : `${k} - wear it`, onclick: () => { app.setSetting("accent", k); paintColours(); } },
      h("i"), h("small", { text: shut ? `${rk}` : k }));
  }), Object.entries(ACCENT_UNLOCKS).some((e) => !near(e)) ? h("button", { class: "swatch-more", onclick: () => { coloursAll = !coloursAll; paintColours(); } }, coloursAll ? "Fewer" : `+${Object.entries(ACCENT_UNLOCKS).filter((e) => !near(e)).length} more`) : "");
  const colours = h("div", { class: "lv-colours" });
  paintColours();

  return h("div", { class: "lv lv-in" },
    h("div", { class: "lv-top" },
      h("div", { class: "lv-level" }, h("small", { text: "Level" }), h("b", { text: n(p.level) })),
      h("div", { class: "lv-who" },
        h("h2", { class: "lv-rank-title" }, icon(rank.icon), rank.name),
        h("div", { class: "lv-bar" }, h("span", { style: { width: `${Math.round((p.into / p.span) * 100)}%` } })),
        h("small", { text: `${n(S.xp)} XP · ${n(p.next - S.xp)} to level ${n(p.level + 1)} · ${rank.next.name} at level ${n(rank.next.level)}` }))),
    h("div", { class: "lv-grid" },
      today,
      yearCard(app, year, setYear),
      h("section", { class: "lv-card" },
        h("h3", {}, icon("palette"), "Colours"),
        h("p", { text: "Each rank unlocks an accent colour for the whole app - wear it here, or in Settings › Appearance." }),
        colours),
      h("section", { class: "lv-card" },
        h("h3", {}, icon("flame"), "Streak"),
        h("div", { class: "lv-streak" }, h("b", { text: String(st.count) }), h("span", { text: st.count === 1 ? "day in a row" : "days in a row" })),
        h("p", { text: `The first XP of each day brings a bonus: ${dayBonus(1)} XP, and ${dayBonus(2) - dayBonus(1)} more for every day the streak has lasted, up to ${dayBonus(99)}. ${st.today ? `Today's bonus is in (+${dayBonus(st.count)}).` : `Do anything today for +${dayBonus(st.count + 1)}.`} Best so far: ${st.best} day${st.best === 1 ? "" : "s"}.` }),
        heat),
      h("section", { class: "lv-card" },
        h("h3", {}, icon("sparkles"), "How you earn XP"),
        h("div", { class: "lv-earn" }, ...EARN.map(([what, xp]) => h("div", {}, h("span", { text: what }), h("b", { text: `+${xp}` }))),
          h("div", {}, h("span", { text: "The first XP of the day" }), h("b", { text: `+${dayBonus(1)}…${dayBonus(99)}` }))),
        h("p", { class: "lv-note", text: "Taking something back (a task opened again, a habit unticked) takes its XP back too." })),
      h("section", { class: "lv-card" },
        h("h3", {}, icon("chart"), "How levels work"),
        h("p", { text: `The first levels come quickly. From level 10 each costs ${n(costOf(11))} XP, from level 31 a little more each time (${n(costOf(31))}, ${n(costOf(32))}, …), until ${n(costOf(9999))} XP a level - and from there they keep coming at that pace, with no last level. Level ${n(p.level + 1)} costs you ${n(costOf(p.level + 1))}.` }),
        h("p", { text: "Ranks are names for where the levels have got you - the lion cub grows up. Each is climbed in three tiers (I, II, III); the last earns a star every 1,000 levels." }),
        ladder),
      h("section", { class: "lv-card" },
        h("h3", {}, icon("trophy"), "Badges"),
        badges)));
}
