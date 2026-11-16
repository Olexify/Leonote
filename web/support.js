// Where to find us: the one place that lists Leonote's support and
// community links, used by Settings > About and the command palette.

import { h, motionFull } from "./util.js";
import { icon } from "./icons.js";

/* The people who helped make Leonote, at the foot of Settings. `for` is what they did - a few words, or "" for just the name. */
const CREDITS = [
  { name: "Mat", for: "" },
  { name: "Volodymyr", for: "" },
  { name: "Purrv", for: "" },
  { name: "Pato", for: "" },
];

export const LINKS = [
  { id: "site", name: "olexify.dev", url: "https://olexify.dev", icon: "globe", note: "Website and support" },
  { id: "patreon", name: "Patreon", url: "https://www.patreon.com/c/Olexifyyy", icon: "heart", note: "Support ongoing work" },
  { id: "discord", name: "Discord", url: "https://discord.gg/UpmNHxT7PF", icon: "chat", note: "Community and help" },
  { id: "github", name: "GitHub", url: "https://github.com/Olexify", icon: "code", note: "Other projects" },
];

/** Commands for the palette: one per link. */
export function supportCommands(app) {
  return LINKS.filter((l) => !(app.packaged && l.id === "patreon")).map((l) => ({ id: "open-" + l.id, name: `Open ${l.name}`, icon: l.icon, run: () => app.openUrl(l.url) }));
}

/** Settings > About: version, licence line and the links. */
/** The notices that travel with the app (written at build into licenses.txt), in a reader of their own. */
/** A text that travels with the app (made at build time from its one source), in a reader. */
export function openText(title, file, missing, prefix = "") {
  const pre = h("pre", { class: "lic-text", text: "Loading…" });
  const close = () => { back.remove(); document.removeEventListener("keydown", esc, true); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const back = h("div", { class: "dlg-back is-in", onmousedown: (e) => { if (e.target === back) close(); } },
    h("div", { class: "dlg lic", role: "dialog" },
      h("div", { class: "lic-head" }, h("h3", { class: "dlg-title", text: title }), h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
      pre));
  document.addEventListener("keydown", esc, true);
  document.getElementById("overlay-root").append(back);
  fetch(file).then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then((t) => { pre.textContent = prefix + t; })
    .catch(() => { pre.textContent = missing; });
}
const openLicenses = () => openText("Open-source licences", "licenses.txt", "The list is made when Leonote is built; this copy has none. See THIRD-PARTY-NOTICES.md.");

export function aboutSection(app) {
  const version = h("span", { class: "about-ver", text: "" });
  const T = window.__TAURI__;
  if (T && T.app && T.app.getVersion) T.app.getVersion().then((v) => { version.textContent = `Version ${v}`; }).catch(() => {});
  const goal = app.packaged ? null : goalBar();
  const el = h("div", { class: "about" },
    h("div", { class: "about-head" },
      h("b", { text: "Leonote" }), version),
    h("div", { class: "about-sub", text: `Booted in ${app.bootMs.toFixed(0)} ms · ${app.vault.notes.size} notes · ${app.tasks.all.length} tasks` }),
    h("div", { class: "about-sub", text: "Leonote is free. Nothing you write leaves this computer unless you use a feature that goes online - the privacy policy lists each one." }),
    h("div", { class: "about-sub about-btns" },
      h("button", { class: "btn", title: "What Leonote sends where, and when", onclick: () => openText("Privacy policy", "privacy.txt", "Read it at leonote.app/privacy.") }, icon("eye"), "Privacy policy"),
      h("button", { class: "btn", title: "The terms you use Leonote under", onclick: () => openText("Licence", "licence.txt", "Read it at leonote.app/terms.") }, icon("fileText"), "Licence"),
      h("button", { class: "btn", title: "Every open-source library, font and sound in Leonote, with its licence", onclick: () => openLicenses() }, icon("fileText"), "Open-source licences"),
      app.packaged ? null : h("button", { class: "btn", title: "Asks leonote.app which version is the latest - nothing is downloaded; a newer one opens its page in your browser", onclick: () => app.checkUpdate() }, icon("download"), "Check for updates"),
      app.packaged ? null : h("label", { class: "btn", title: "Once a week, when Leonote starts: is there a newer version? Off until you turn it on." },
        h("input", { type: "checkbox", checked: app.settings.updateWeekly === true, onchange: (e) => app.setSetting("updateWeekly", e.target.checked) }), "Check weekly"),
      h("button", { class: "btn", title: "Version, Windows, sizes and the last errors - for a bug report. Nothing is sent anywhere; it goes to the clipboard.", onclick: () => diagnostics(app).then((t) => navigator.clipboard.writeText(t)).then(() => app.toast("Copied - paste it into your report", { ms: 2500 })) }, icon("clipboard"), "Copy diagnostics")),
    h("div", { class: "about-links" }, LINKS.filter((l) => l.id !== "patreon").map((l) =>
      h("button", { class: "about-link", title: l.url, onclick: () => app.openUrl(l.url) },
        icon(l.icon), h("span", { class: "about-link-name", text: l.name }), h("span", { class: "about-link-note", text: l.note })))),
    goal,
    donateRow(app),
    h("div", { class: "about-sub" }, h("a", { href: "mailto:olexifyyy@gmail.com?subject=" + encodeURIComponent("AI content in Leonote"), title: "olexifyyy@gmail.com - something an AI answer in Leonote said that it should not have",
      // mail opens in the user's mail app; where it cannot, the address goes to the clipboard
      onclick: (e) => { e.preventDefault(); app.host.openUrl(e.currentTarget.href).catch(() => navigator.clipboard.writeText("olexifyyy@gmail.com").then(() => app.toast("Copied olexifyyy@gmail.com - write to it about the AI content", { ms: 3500 }))); } }, "Report a problem with AI content")),
    h("div", { class: "about-credits" },
      h("div", { class: "about-credits-head" }, icon("heart"), "Credits"),
      h("div", { class: "about-credits-list" }, CREDITS.map((c) =>
        h("span", { class: "about-credit" }, h("b", { text: c.name }), c.for ? h("span", { text: c.for }) : null)))));
  el.opened = () => goal && goal.ask(); // the About card opened by the user: the goal may be fetched now
  return el;
}

/** What a bug report needs, as text. Nothing personal beyond the vault's path. */
/**
 * A report is pasted where others read it: the vault's own path becomes <vault> and a Windows user's folder
 * <you> - where things are, without who the user is or what their folders are called.
 */
export function anonymise(text, vaultRoot = "") {
  let t = String(text);
  const root = String(vaultRoot || "").replace(/[\\/]+$/, "");
  if (root) for (const r of new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])) t = t.split(r).join("<vault>");
  return t.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s"'<>]+/gi, "$1<you>").replace(/(\/home\/|\/Users\/)[^/\s"'<>]+/g, "$1<you>");
}

export async function diagnostics(app) {
  const T = window.__TAURI__;
  const v = T && T.app ? await Promise.all([T.app.getVersion(), T.app.getTauriVersion()]).catch(() => []) : [];
  const S = app.settings;
  const nonDefault = app.defaultSettings ? Object.keys(S).filter((k) => JSON.stringify(S[k]) !== JSON.stringify(app.defaultSettings[k])) : [];
  return [
    `Leonote ${v[0] || "dev"}${app.packaged ? " (Microsoft Store)" : ""} · Tauri ${v[1] || "-"}`,
    `${navigator.userAgent}`,
    `${navigator.language} · ${Intl.DateTimeFormat().resolvedOptions().timeZone} · ${screen.width}×${screen.height} @${devicePixelRatio} · window ${innerWidth}×${innerHeight}`,
    `Vault ${S.vault || "~/LeoNote"} · ${app.vault.notes.size} notes · ${app.vault.files.size} files · ${app.tasks.all.length} tasks · booted in ${app.bootMs.toFixed(0)} ms`,
    `Settings changed: ${nonDefault.join(", ") || "none"}`,
    `Last errors:${app.errors.length ? "" : " none"}`,
    ...app.errors.map((e) => `  ${e}`),
  ].map((l) => anonymise(l, app.vault.root || S.vault)).join("\n");
}

/**
 * A field that shows what Leonote receives for a key press, and which
 * command it runs - for "this shortcut does nothing" moments. Keys the
 * window catches before the page (Ctrl/Alt + PageUp/PageDown) show up as
 * well, reported by the app.
 */
export function keyChecker(app) {
  const out = h("span", { class: "key-test-out", text: "Click here and press a shortcut" });
  const box = h("div", { class: "key-test", tabIndex: 0 }, icon("keyboard"), out);
  const show = (combo, id, via) => {
    const cmd = id && app.commands.find((c) => c.id === id);
    out.textContent = `${combo}  →  ${cmd ? cmd.name : id || "no command"}${via ? ` (${via})` : ""}`;
    box.classList.toggle("is-bound", !!id);
  };
  box.addEventListener("keydown", (e) => {
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const k = app.describeKey(e);
    show(k.combo, k.id, "");
  });
  app.bus.on("native-key", (id) => { if (document.activeElement === box) show(id.includes("space") ? "Alt + PageUp/PageDown" : "Ctrl + PageUp/PageDown", id, "caught by the window"); });
  return box;
}

/* An occasional ask for support: first on day 3, then further apart each
   time (2 weeks, a month, 2 months, then every 3). The goal comes from
   olexify.dev/goal.json ({"raised": 120, "goal": 1000}); offline it just
   shows the goal. */
const GOAL_URL = "https://olexify.dev/goal.json";
const DAY = 864e5, GAPS = [14, 30, 60, 90];
/** The monthly goal and its bar. Fetched at most every 6 hours; the last answer is kept. */
/** The month's goal: what was fetched last is shown. olexify.dev is asked only by `ask` (or `.ask()`), which runs
    when the user opens the About card themselves - a popup that comes by itself sends nothing. */
export function goalBar({ ask = false } = {}) {
  const goal = h("div", { class: "don-goal", text: "Monthly goal: $1000" });
  const bar = h("div", { class: "don-bar" }, h("i", { style: "width:0%" }));
  const show = ({ raised, goal: g = 1000 } = {}) => {
    if (typeof raised !== "number") return;
    goal.textContent = `Monthly goal: $${Math.round(raised)} / $${g}`;
    bar.firstChild.style.width = Math.min(100, raised / g * 100) + "%";
  };
  let c = null;
  try { c = JSON.parse(localStorage.getItem("leonote-goal")); } catch { /* none yet */ }
  if (c) show(c.v);
  const wrap = h("div", { class: "don-wrap" }, goal, bar);
  // called when the user opens About (settings.js), not when Settings is built
  wrap.ask = () => {
    if (wrap.asked || (c && Date.now() - c.t <= 6 * 36e5)) return;
    wrap.asked = true;
    fetch(GOAL_URL, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).then((v) => {
      show(v);
      try { localStorage.setItem("leonote-goal", JSON.stringify({ t: Date.now(), v })); } catch { /* fine */ }
    }).catch(() => {});
  };
  if (ask) wrap.ask();
  return wrap;
}

/* The ways to donate, as in Kitsumi: a bank link opens; crypto shows its address, a copy button and a QR (web/pay).
   Ko-fi stays greyed: it cannot pay out to a Ukrainian PayPal. */
const EVM = "0x97369cf0f17593505df60249cc48bd1a60cefb32", ERC20 = "Ethereum (ERC-20)";
export const DONATE_METHODS = [
  { name: "Monobank", chip: "M", url: "https://send.monobank.ua/jar/4jizk5cDBp" },
  { name: "USDT", net: ERC20, chip: "₮", addr: EVM, qr: "eth" },
  { name: "USDC", net: ERC20, chip: "$", addr: EVM, qr: "eth" },
  { name: "BTC", net: "Bitcoin", chip: "₿", addr: "bc1q9ajz2q3evfrw4jkpyck6jtgvlz8pgkk4duw2wp", qr: "btc" },
  { name: "ETH", net: "Ethereum", chip: "Ξ", addr: EVM, qr: "eth" },
  { name: "XMR", net: "Monero", chip: "ɱ", addr: "83VuZZ56m5UALCf8kuuSY9dbNxj9AH3uxcLZv7CEx3fYfimjKprtAaHGTGzBeyDzRRVZEqJPDBUYQirQiyCSjANSBtwDxFj", qr: "xmr" },
  { name: "SOL", net: "Solana", chip: "◎", addr: "CELaFhXdDAWD5AZc6WARgMe2guHbuN3pHroQWRwKMe2U", qr: "sol" },
  { name: "LTC", net: "Litecoin", chip: "Ł", addr: "ltc1qxrgvajveu2w05ktyyhpwu6g45llexe5vjqxcjt", qr: "ltc" },
  { name: "Ko-fi", chip: "K", off: true },
];

/** Patreon, the one donate button and the arrow to see every way. Everything unfolds in place.
    While folded the names cycle (CSS only, no timer, off with less motion), and a click takes the name shown. */
export function donateRow(app, onPatreon) {
  // the Store package: one way out to the website, nothing else (Microsoft Store Policy 10.8.2 limits how voluntary donations may be received)
  if (app.packaged) {
    const { url } = LINKS.find((l) => l.id === "site");
    return h("div", { class: "don-picker" }, h("div", { class: "don-row" },
      h("button", { class: "btn btn-primary", type: "button", title: url, onclick: () => { app.openUrl(url); if (onPatreon) onPatreon(); } }, icon("heart"), "Support Leonote")));
  }
  let cur = DONATE_METHODS[0];
  const now = h("span", { class: "don-now" });
  const face = h("span", { class: "don-face" }, now, DONATE_METHODS.filter((m) => !m.off).map((m, i) =>
    h("span", { class: "don-c", "aria-hidden": "true", style: { "--i": i }, text: m.name })));
  const list = h("div", { class: "don-list", hidden: true });
  const box = h("div", { class: "don-box", hidden: true });
  const more = h("button", { class: "icon-btn don-more", type: "button", title: "More ways to donate", "aria-label": "More ways to donate", "aria-expanded": "false",
    onclick: () => { const open = !list.hidden || !box.hidden; box.hidden = true; show(!open); } }, icon("chevronDown"));
  const copy = async () => {
    const b = box.querySelector("button");
    try { await navigator.clipboard.writeText(cur.addr); } catch { getSelection().selectAllChildren(box.querySelector("code")); return; } // no clipboard: selected, for Ctrl+C
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy address"; }, 1500);
  };
  const go = h("button", { class: "btn btn-primary don-go", type: "button", title: "Donate",
    onclick: () => {
      if (row.classList.contains("is-cycling")) { // what it says is what it does
        const shown = [...face.querySelectorAll(".don-c")].find((s) => +getComputedStyle(s).opacity > 0.5);
        const m = shown && DONATE_METHODS.find((x) => x.name === shown.textContent);
        if (m) pick(m);
      }
      if (cur.addr) { copy(); box.hidden = false; show(false); } else app.openUrl(cur.url);
    } }, icon("heart"), face);
  const row = h("div", { class: "don-row" },
    h("button", { class: "btn btn-primary", type: "button", onclick: () => { app.openUrl(LINKS.find((l) => l.id === "patreon").url); if (onPatreon) onPatreon(); } }, icon("heart"), "Patreon"),
    go, more, list, box);
  function cycle(rest) {
    row.classList.remove("is-cycling");
    if (!motionFull() || !list.hidden || !box.hidden) return;
    face.style.setProperty("--wait", rest);
    void face.offsetWidth; // from the start again
    row.classList.add("is-cycling");
  }
  function pick(m) {
    cur = m; now.textContent = m.name;
    box.hidden = !m.addr; box.textContent = "";
    if (m.addr) box.append(
      h("img", { class: "don-qr", src: `pay/qr-${m.qr}.svg`, alt: `QR code of the ${m.name} address`, width: 128, height: 128 }),
      h("div", { class: "don-side" },
        h("b", { text: `${m.name} - ${m.net}` }),
        h("code", { text: m.addr }),
        h("button", { class: "btn", type: "button", onclick: copy }, "Copy address"),
        h("small", { text: `Send only ${m.name} on ${m.net} to this address - anything else can be lost.` }),
        h("small", { text: "Please do not donate if you are subject to sanctions or from a sanctioned region; a donation buys nothing." })));
    [...list.children].forEach((b, i) => b.setAttribute("aria-current", DONATE_METHODS[i] === m ? "true" : "false"));
  }
  const closeOut = (e) => { if (!row.contains(e.target)) show(false); }; // (a row gone from the page ends this at the next click)
  function show(on) {
    list.hidden = !on; more.setAttribute("aria-expanded", String(on || !box.hidden));
    document[on ? "addEventListener" : "removeEventListener"]("mousedown", closeOut, true);
    cycle("5s");
  }
  list.append(...DONATE_METHODS.map((m) =>
    h("button", { class: "don-pick", type: "button", disabled: !!m.off,
      onclick: () => { pick(m); show(false); if (m.url) app.openUrl(m.url); } },
      h("span", { class: "don-chip", text: m.chip }),
      h("span", { class: "don-label" }, h("b", { text: m.name }), h("small", { text: m.off ? "not available yet" : m.url ? "Pay by card" : m.net })))));
  list.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); show(false); more.focus(); } });
  pick(cur);
  cycle("0s");
  return h("div", { class: "don-picker" }, row);
}

export function maybeAskSupport(app) {
  const now = Date.now(), d = { ...(app.settings.donate || {}) };
  if (!d.first) { app.setSetting("donate", { first: now, next: now + 3 * DAY, n: 0 }); return; }
  if (now < d.next || document.querySelector(".dlg-back")) return;
  const n = (d.n || 0) + 1;
  const later = (days) => app.setSetting("donate", { ...d, n, next: Date.now() + days * DAY });
  later(GAPS[Math.min(n - 1, GAPS.length - 1)]);
  const close = () => back.remove();
  const box = h("div", { class: "dlg don", role: "dialog" },
    h("h3", { class: "dlg-title" }, icon("heart"), " Do you like Leonote?"),
    h("p", { class: "dlg-text", text: "It would mean the world to me if you supported the project. Every bit keeps it going." }),
    app.packaged ? null : goalBar({ ask: false }),
    donateRow(app, close),
    h("div", { class: "dlg-btns" },
      h("button", { class: "btn", onclick: () => { later(180); close(); } }, "I already do"),
      h("button", { class: "btn", onclick: close }, "Later")));
  const back = h("div", { class: "dlg-back is-in", onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.getElementById("overlay-root").append(back);
}
