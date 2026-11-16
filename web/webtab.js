// A browser tab in the main strip, and the page a new tab starts on.
//
// The page itself is a real, separate browser view the app lays over `slot`
// (host.tabWebShow) - never an iframe, which most sites refuse. Nothing is
// injected into it and nothing is blocked: a site shows what it shows in any
// browser, ads and logins included. This module only draws the bar above it,
// keeps the native view's rectangle up to date, and remembers bookmarks and
// (if wanted) history - both in Leonote's own settings, nowhere else.
//
// A tab with no address shows the start page: the search box, what the old
// "+" panel offered (new note, sketch, board, today, recent, folders, views),
// pinned sites, bookmarks and lately visited pages.

import { faviconOf } from "./favicons.js";
import { createHistory, openHistory } from "./webhistory.js";
import { h, basename, dirname, debounce } from "./util.js";
import { icon } from "./icons.js";
import { menu, toast, confirmDialog, askDialog, sortable } from "./ui.js";
import { bookmarkGrounds, groupsOf, markInto } from "./webmarks.js";
import { openAddons, storeCrx, addonButtons } from "./webaddons.js";
import { KIND_ICON, fmtSize } from "./fileview.js";

// the icon kept from when the site's page was open, else `none()`: a list drawn must not contact every site in it
const siteIcon = (host, cls, none) => { const d = faviconOf("https://" + host); return d ? h("img", { class: cls, alt: "", src: d }) : none(); };

/** The site a download answers to: "" (about:blank, nothing known) always asks. */
const downloadSite = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };
/** On the "always allow" list? It goes by the page that asked, not by where the file is kept. */
export const downloadAllowed = (p, hosts) => { const site = downloadSite(p.page); return !!site && hosts.includes(site); };

// name, the address a query is put behind, and the shelf it sits on in the menus
export const ENGINES = {
  google: ["Google", "https://www.google.com/search?q=", "Search"],
  duckduckgo: ["DuckDuckGo", "https://duckduckgo.com/?q=", "Search"],
  startpage: ["Startpage", "https://www.startpage.com/sp/search?query=", "Search"],
  youtube: ["YouTube", "https://www.youtube.com/results?search_query=", "Search"],
  bing: ["Bing", "https://www.bing.com/search?q=", "Search"],
  brave: ["Brave", "https://search.brave.com/search?q=", "Search"],
  kagi: ["Kagi", "https://kagi.com/search?q=", "Search"],
  ecosia: ["Ecosia", "https://www.ecosia.org/search?q=", "Search"],
  qwant: ["Qwant", "https://www.qwant.com/?q=", "Search"],
  mojeek: ["Mojeek", "https://www.mojeek.com/search?q=", "Search"],
  // assistants: the question goes along where the site takes one in its address
  chatgpt: ["ChatGPT", "https://chatgpt.com/?q=", "Ask"],
  claude: ["Claude", "https://claude.ai/new?q=", "Ask"],
  gemini: ["Gemini", "https://gemini.google.com/app?q=", "Ask"],
  copilot: ["Copilot", "https://copilot.microsoft.com/?q=", "Ask"],
  grok: ["Grok", "https://grok.com/?q=", "Ask"],
  mistral: ["Le Chat (Mistral)", "https://chat.mistral.ai/chat?q=", "Ask"],
  deepseek: ["DeepSeek", "https://chat.deepseek.com/?q=", "Ask"],
  meta: ["Meta AI", "https://www.meta.ai/?q=", "Ask"],
  you: ["You.com", "https://you.com/search?q=", "Ask"],
  phind: ["Phind", "https://www.phind.com/search?q=", "Ask"],
  perplexity: ["Perplexity", "https://www.perplexity.ai/search?q=", "Ask"],
  wolfram: ["Wolfram|Alpha", "https://www.wolframalpha.com/input?i=", "Ask"],
  wikipedia: ["Wikipedia", "https://en.wikipedia.org/w/index.php?search=", "Research"],
  scholar: ["Google Scholar", "https://scholar.google.com/scholar?q=", "Research"],
  semantic: ["Semantic Scholar", "https://www.semanticscholar.org/search?q=", "Research"],
  arxiv: ["arXiv", "https://arxiv.org/search/?searchtype=all&query=", "Research"],
  pubmed: ["PubMed", "https://pubmed.ncbi.nlm.nih.gov/?term=", "Research"],
  archive: ["Internet Archive", "https://archive.org/search?query=", "Research"],
  books: ["Google Books", "https://www.google.com/search?tbm=bks&q=", "Research"],
  github: ["GitHub", "https://github.com/search?q=", "Code and people"],
  stackoverflow: ["Stack Overflow", "https://stackoverflow.com/search?q=", "Code and people"],
  mdn: ["MDN", "https://developer.mozilla.org/en-US/search?q=", "Code and people"],
  reddit: ["Reddit", "https://www.reddit.com/search/?q=", "Code and people"],
  hn: ["Hacker News", "https://hn.algolia.com/?q=", "Code and people"],
  images: ["Google Images", "https://www.google.com/search?tbm=isch&q=", "Pictures"],
  lens: ["Google Lens - a picture's address", "https://lens.google.com/uploadbyurl?url=%s", "Pictures"],
  tineye: ["TinEye - a picture's address", "https://tineye.com/search?url=%s", "Pictures"],
  bingimg: ["Bing Images", "https://www.bing.com/images/search?q=", "Pictures"],
  ddgimg: ["DuckDuckGo Images", "https://duckduckgo.com/?iax=images&ia=images&q=", "Pictures"],
  unsplash: ["Unsplash", "https://unsplash.com/s/photos/", "Pictures"],
  pexels: ["Pexels", "https://www.pexels.com/search/", "Pictures"],
  pixabay: ["Pixabay", "https://pixabay.com/images/search/", "Pictures"],
  flickr: ["Flickr", "https://www.flickr.com/search/?text=", "Pictures"],
  giphy: ["GIPHY", "https://giphy.com/search/", "Pictures"],
  virustotal: ["VirusTotal", "https://www.virustotal.com/gui/search/", "Tools"],
  urlscan: ["urlscan.io", "https://urlscan.io/search/#", "Tools"],
  wayback: ["Wayback Machine", "https://web.archive.org/web/*/", "Tools"],
  browserling: ["Browserling", "https://www.browserling.com/", "Tools"],
  downfor: ["Is it down?", "https://downforeveryoneorjustme.com/", "Tools"],
  whois: ["Whois", "https://who.is/whois/", "Tools"],
  shodan: ["Shodan", "https://www.shodan.io/search?query=", "Tools"],
  caniuse: ["Can I use", "https://caniuse.com/?search=", "Tools"],
  npm: ["npm", "https://www.npmjs.com/search?q=", "Tools"],
  pypi: ["PyPI", "https://pypi.org/search/?q=", "Tools"],
  crates: ["crates.io", "https://crates.io/search?q=", "Tools"],
  dockerhub: ["Docker Hub", "https://hub.docker.com/search?q=", "Tools"],
  deepl: ["DeepL", "https://www.deepl.com/translator#auto/en/", "Tools"],
  mw: ["Merriam-Webster", "https://www.merriam-webster.com/dictionary/", "Tools"],
  amazon: ["Amazon", "https://www.amazon.com/s?k=", "Shopping and more"],
  ebay: ["eBay", "https://www.ebay.com/sch/i.html?_nkw=", "Shopping and more"],
  imdb: ["IMDb", "https://www.imdb.com/find/?q=", "Shopping and more"],
  goodreads: ["Goodreads", "https://www.goodreads.com/search?q=", "Shopping and more"],
  steam: ["Steam", "https://store.steampowered.com/search/?term=", "Shopping and more"],
  pinterest: ["Pinterest", "https://www.pinterest.com/search/pins/?q=", "Shopping and more"],
  x: ["X", "https://x.com/search?q=", "Shopping and more"],
  maps: ["Google Maps", "https://www.google.com/maps/search/", "Places and words"],
  osm: ["OpenStreetMap", "https://www.openstreetmap.org/search?query=", "Places and words"],
  translate: ["Google Translate", "https://translate.google.com/?sl=auto&tl=en&op=translate&text=", "Places and words"],
};
const DEFAULT_ENGINE = "google";
const LEO_SAYS = ["Purr.", "A note a day keeps the chaos away.", "Ctrl+P knows every command. I know every nap spot.", "Lions do not chase every tab. Close a few.", "Drink some water. I would, if I had thumbs.", "Ctrl+T: a fresh tab. Ctrl+W: one fewer.", "Shift+R in a sketch shows the rulers. Measure twice, draw once.", "The best time to write it down was an hour ago. The second best is now.", "Roar. (That is all.)", "Ctrl+Z is the bravest key."];
// the ones a press away under the search box
const QUICK = ["google", "duckduckgo", "startpage", "chatgpt", "perplexity", "wikipedia", "scholar", "github"]; // video sites are yours to add
// your own engines come from settings: [{ id, label, url }] with %s where the words go
let CUSTOM = [];
export const setCustomEngines = (list) => { CUSTOM = Array.isArray(list) ? list.filter((c) => c && c.id && c.url) : []; };
export const allEngines = () => ({ ...ENGINES, ...Object.fromEntries(CUSTOM.map((c) => [c.id, [c.label || hostOf(c.url) || "Your engine", c.url, "Your own", !c.url.includes("%s")]])) });
/** The address that searches engine `k` for `q` - or its front door, when q is empty. */
export const searchUrl = (k, q) => {
  const e = allEngines()[k] || ENGINES[DEFAULT_ENGINE];
  if (e[3]) return e[1]; // a page of your own: it opens, whatever is in the box
  const t = String(q || "").trim();
  // an engine that is only a front door (no place for the words) opens as it is
  // nothing to search for: the engine's own door - the first part of its path kept when it is a place (Maps, Images), never a search page
  if (!t || /^https?:\/\/[^/]+\/?$/.test(e[1])) { try { const u = new URL(e[1].replace("%s", "")); const seg = u.pathname.split("/")[1] || ""; const keep = seg && !u.search && !/^(search|s|find|results|sch|w|gui|browse|input|translator|new|app|chat)$/.test(seg); return u.origin + (keep ? "/" + seg + "/" : "/"); } catch { return ""; } }
  return e[1].includes("%s") ? e[1].replace("%s", encodeURIComponent(t)) : e[1] + encodeURIComponent(t);
};
/** Engines as menu rows, shelf by shelf. */
const engineRows = (isOn, pick) => {
  const out = [];
  let shelf = "";
  for (const [k, [label, , sh]] of Object.entries(allEngines())) {
    if (sh !== shelf) { shelf = sh; out.push({ header: sh }); }
    out.push({ label, checked: isOn(k), run: () => pick(k) });
  }
  return out;
};
export const WALLPAPERS = [["lion", "Leo"], ["aurora", "Aurora"], ["dusk", "Dusk"], ["paper", "Paper"], ["plain", "Plain"]];

/** What was typed, as an address: a URL stays one, a bare domain gets https, anything else is searched for. */
export function toUrl(text, engine = DEFAULT_ENGINE) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  // a local page: file:///E:/site/index.html, E:\site\index.html, or a UNC path
  if (/^file:\/\//i.test(t)) return t;
  if (/^[a-z]:[\\/]/i.test(t)) return "file:///" + t.replace(/\\/g, "/");
  if (/^\\\\[^\\]+\\/.test(t)) return "file:" + t.replace(/\\/g, "/");
  if (!/\s/.test(t) && (/^[^\s/]+\.[a-z]{2,}(\/|:|$)/i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t))) return (/^localhost/i.test(t) ? "http://" : "https://") + t;
  return searchUrl(allEngines()[engine] ? engine : DEFAULT_ENGINE, t);
}
export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
export const tabTitle = (t) => (t.path ? t.title || hostOf(t.path) || t.path : "New tab");

// Leo, the mascot (a lion cub): on the start page, and soft in its corner
const LION = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
<path d="M100 22c12 0 17 9 27 11s21-2 28 7 2 19 7 28 15 14 14 26-11 16-14 25-1 21-10 27-19 1-28 5-14 13-24 13-15-9-24-13-19 1-28-5-7-18-10-27-13-13-14-25 9-17 14-26 0-19 7-28 18-5 28-7 15-11 27-11z" fill="var(--mane)" opacity=".9"/>
<circle cx="58" cy="62" r="17" fill="var(--fur)"/><circle cx="142" cy="62" r="17" fill="var(--fur)"/>
<circle cx="58" cy="63" r="8.5" fill="var(--ear)"/><circle cx="142" cy="63" r="8.5" fill="var(--ear)"/>
<ellipse cx="100" cy="106" rx="52" ry="49" fill="var(--fur)"/>
<ellipse cx="100" cy="127" rx="25" ry="19" fill="var(--muzzle)"/>
<ellipse cx="80" cy="99" rx="5.2" ry="6.6" fill="#2a1d12"/><ellipse cx="120" cy="99" rx="5.2" ry="6.6" fill="#2a1d12"/>
<circle cx="81.8" cy="96.6" r="1.8" fill="#fff"/><circle cx="121.8" cy="96.6" r="1.8" fill="#fff"/>
<path d="M91 116h18l-9 9z" fill="#5a3a2a"/>
<path d="M100 125v6m0 0c-3 5-9 5-12 1m12-1c3 5 9 5 12 1" stroke="#5a3a2a" stroke-width="2.6"/>
<path d="M66 121l-15-3m15 9l-15 3m83-9l15-3m-15 9l15 3" stroke="#5a3a2a" stroke-width="1.6" opacity=".55"/>
<circle cx="70" cy="114" r="6" fill="#f2a08a" opacity=".35"/><circle cx="130" cy="114" r="6" fill="#f2a08a" opacity=".35"/>
</g></svg>`;

// our own constant drawing, never anything from a page
const art = (cls, svg) => { const d = h("div", { class: cls }); d.innerHTML = svg; return d; };

export function mountWebTab(app, el, api) {
  const S = app.settings;
  setCustomEngines(S.webCustomEngines);
  app.bus.on("settings", (k) => { if (k === "webCustomEngines") setCustomEngines(S.webCustomEngines); });
  const E = allEngines;
  const engine = () => (E()[S.webSearch] ? S.webSearch : DEFAULT_ENGINE);
  /** Ask for a search engine of your own; resolves its id, or null. */
  async function newEngine() {
    const r = await askDialog("Your own engine, or a page", [{ key: "label", label: "Name", placeholder: "Wiktionary" }, { key: "url", label: "Address - with %s where the words go, or just a page to open", placeholder: "https://en.wiktionary.org/w/index.php?search=%s" }], { ok: "Add it", text: "With %s in it, the words in the box are searched there. Without, the page simply opens." });
    if (!r || !r.url) return null;
    const url = toUrl(r.url.replace("%s", "QQWORDSQQ"), engine()).replace("QQWORDSQQ", "%s");
    if (url === searchUrl(engine(), r.url)) { toast("That is not an address", { kind: "error" }); return null; }
    const id = "c-" + Date.now().toString(36);
    app.setSetting("webCustomEngines", [...(S.webCustomEngines || []), { id, label: r.label || hostOf(url), url }]);
    return id;
  }
  let tab = null; // the tab that is up
  let fullWid = null; // the tab whose page is in full screen, if any
  let fullWasMax = false;
  const shown = new Map(); // wid -> the address its native view was last sent to
  const live = []; // wids with a native view, oldest first
  const stopped = new Map(); // wid -> why the page was stopped; it loads again on a click
  const loading = new Set(); // wids whose page is on its way
  const warnedAt = new Map(); // wid -> the size it was last warned at
  // how many tabs stay awake, and how long a hidden one waits before it sleeps (Settings › Browser); 0 = no limit
  const awakeMax = () => Math.max(0, Math.round(+app.settings.tabAwakeMax || 0));
  const sleepSecs = () => Math.round(Math.max(0, +app.settings.tabSleepMin || 0) * 60);
  // sleeping pages cost little, so many can stay; past this the longest unseen are closed and load again when opened
  const MAX_LIVE = 24;

  /* ── bookmarks and history: plain lists in settings ───────────────────── */
  const marks = () => (Array.isArray(S.webBookmarks) ? S.webBookmarks : []);
  const saveMarks = (list) => {
    // a bookmark landing in no group brings the base group back
    const ids = new Set(groupsOf(S).map((g) => g.id));
    if (S.webBaseGroup && S.webBaseGroup.hidden && list.some((b) => !ids.has(b.group || ""))) app.setSetting("webBaseGroup", { ...S.webBaseGroup, hidden: false });
    app.setSetting("webBookmarks", list);
  };
  const isMarked = (url) => marks().some((b) => b.url === url);
  // the history: every visit, in its own file (webhistory.js)
  const H = createHistory(app);
  const visited = (url, title) => H.visited(url, title);

  /* ── the bar ──────────────────────────────────────────────────────────── */
  const addr = h("input", { class: "wt-addr", spellcheck: "false", autocomplete: "off", placeholder: "Search the web, or type an address", "aria-label": "Address" });
  const star = h("button", { class: "icon-btn wt-star", title: "Bookmark this page", onclick: (e) => {
      if (!tab || !tab.path || isMarked(tab.path) || groupsOf(S).length < 2) return toggleMark();
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.right - 220, r.bottom + 4, [{ header: "Bookmark into" }, ...groupsOf(S).map((g) => ({ label: g.name, icon: g.id === markInto(S) ? "star" : "folder", run: () => toggleMark(g.id) }))]);
    },
    oncontextmenu: (e) => { e.preventDefault(); if (!tab || !tab.path) return; menu(e.clientX, e.clientY, [{ header: "Bookmark into" }, ...groupsOf(S).map((g) => ({ label: g.name, checked: isMarked(tab.path) && (marks().find((b) => b.url === tab.path).group || "") === g.id, run: () => toggleMark(g.id) }))]); } }, icon("star"));
  const removeMark = (url, redraw) => {
    const at = marks().findIndex((x) => x.url === url), b = marks()[at];
    saveMarks(marks().filter((x) => x.url !== url));
    redraw();
    if (b) toast("Bookmark removed", { ms: 6000, action: { label: "Undo", run: () => { if (marks().some((x) => x.url === url)) return; const list = [...marks()]; list.splice(at, 0, b); saveMarks(list); redraw(); } } });
  };
  const btn = (ic, title, run) => h("button", { class: "icon-btn", title, onclick: run }, icon(ic));
  // on an add-on's store page: the way in that works here
  const installBtn = h("button", { class: "btn btn-sm btn-primary wt-install", hidden: true, title: "Install this add-on into Leonote's browser", onclick: async () => {
    const st = storeCrx(tab && tab.path);
    if (!st) return; // the Windows question comes once it is downloaded, naming what it may reach
    installBtn.disabled = true;
    toast("Getting the add-on…", { ms: 4000 });
    try { const r = await app.host.webExtInstall(st.url); toast(`${(r && r.name) || "The add-on"} is on`, { ms: 4000 }); app.bus.emit("addons"); } catch (e) { toast(String(e), { kind: "error", ms: 8000 }); }
    installBtn.disabled = false;
  } }, icon("download"), "Install");
  // The page keeps its own history; what it cannot know is that the start
  // page came before it. `trail` counts the pages loaded since, so Back on
  // the first of them returns to the start page - and Forward from there
  // goes to the page again.
  const go = (action) => {
    if (!tab) return;
    if (!tab.path) {
      // back from the start page Home led to: the page as it was left, its own history and all
      // back from the start page Home led to: the page as it was left; forward: that page, then on into its own
      // forward history - Home takes nothing away from either
      if (tab.behind && (action === "back" || (action === "forward" && tab.behind.fwd))) {
        const b = tab.behind; delete tab.behind; tab.path = b.path; tab.title = b.title; tab.trail = b.trail; tab.fwd = b.fwd; paint(); api.changed();
        if (action === "forward") app.host.tabWebGo(tab.wid, "forward").catch(() => {});
        return;
      }
      if (action === "forward" && tab.ahead) open(tab.ahead);
      return;
    }
    // a page stopped (could not be reached, crashed): Reload loads it again, as the button on its note does
    if (action === "reload" && stopped.has(tab.wid)) { stopped.delete(tab.wid); warnedAt.delete(tab.wid); place(true); return; }
    if (action === "back" && (tab.trail || []).length <= 1) { const was = tab.path; open(""); tab.ahead = was; return; }
    if (action === "back") tab.trail.pop();
    app.host.tabWebGo(tab.wid, action).catch(() => {});
  };
  let exts = null;
  // a page that is an HTML file of the vault: its text a click away
  const srcBtn = h("button", { class: "btn btn-sm wt-src", hidden: true, title: "Back to the file's text", onclick: () => { const rel = tab && app.vaultPathOfUrl && app.vaultPathOfUrl(tab.path); if (rel) { app.rememberAsPage && app.rememberAsPage(rel, false); api.replaceTab({ kind: "file", path: rel }); } } }, icon("code"), "Source");
  const addrWrap = h("div", { class: "wt-addr-wrap" }, icon("globe", "wt-addr-ico"), addr, installBtn,
    h("button", { class: "icon-btn wt-key", title: "Fill in a password from your vault", onclick: (e) => { if (tab && tab.path) { const a = e.currentTarget; import("./passwords.js").then((m) => m.fillMenu(app, a, tab.wid, tab.path)); } } }, icon("key")),
    star);
  const backBtn = btn("back", "Back (Alt+Left)", () => go("back")), fwdBtn = btn("forward", "Forward (Alt+Right)", () => go("forward"));
  const bar = h("div", { class: "wt-bar" },
    backBtn, fwdBtn, btn("rotateRight", "Reload (F5)", () => go("reload")),
    btn("home", "The start page", () => goHome()),
    addrWrap,
    srcBtn,
    app.host.real ? (exts = addonButtons(app, () => (tab && tab.path) || "")) : null,
    btn("outside", "Open this page in your own browser", () => { if (tab && tab.path) app.openUrl(tab.path); }),
    h("button", { class: "icon-btn", title: "Bookmarks, history and the start page", onclick: (e) => moreMenu(e.currentTarget) }, icon("more")));
  const note = h("div", { class: "wt-note", hidden: true });
  // an add-on's store page: the way in, said plainly under the bar
  const storeBar = h("div", { class: "wt-storebar", hidden: true },
    icon("puzzle"), h("span", { class: "wt-storebar-text" }),
    h("button", { class: "btn btn-sm btn-primary", onclick: () => installBtn.click() }, icon("download"), "Install into Leonote"),
    h("button", { class: "icon-btn", title: "Not now", onclick: () => { storeBar.hidden = true; storeBarOff = tab && tab.path; } }, icon("x")));
  let storeBarOff = "";
  const slot = h("div", { class: "wt-slot" }, note);
  const start = h("div", { class: "wt-start", hidden: true });
  el.classList.add("wt");
  el.replaceChildren(bar, storeBar, slot, start);

  // what you type in the address bar finds your history and bookmarks as it goes, as Firefox's does
  addrWrap.append(withSuggestions(addr, { bar: true, esc: () => { addr.value = tab && tab.path ? tab.path : ""; addr.blur(); }, changed: () => place(true) }));
  addr.addEventListener("focus", () => addr.select());

  function toggleMark(group) {
    if (!tab || !tab.path) return;
    const have = marks().find((b) => b.url === tab.path);
    if (have && group != null) { saveMarks(marks().map((b) => (b.url === tab.path ? { ...b, group } : b))); app.setSetting("webMarkInto", group); toast(`Moved to ${groupName(group)}`, { ms: 1800 }); }
    else if (have) { removeMark(tab.path, paintBar); return; } // with Undo, as on the start page
    else {
      const g = group != null ? group : markInto(S);
      saveMarks([{ url: tab.path, title: tab.title || hostOf(tab.path), group: g }, ...marks()]);
      if (group != null) app.setSetting("webMarkInto", g);
      toast(`Bookmarked - in ${groupName(g)} on the start page`, { ms: 2200 });
    }
    paintBar();
  }
  const groupName = (id) => (groupsOf(S).find((g) => g.id === (id || "")) || groupsOf(S)[0] || { name: "Bookmarks" }).name;
  /** Add a bookmark by hand: a small box at the pointer takes the address; `g` is a group, or "row" for the buttons row. */
  function addMark(g, at) {
    g = g == null ? "" : g;
    document.querySelector(".wt-addpop")?.remove();
    const input = h("input", { class: "wt-addpop-in", placeholder: "Type or paste the page's address", spellcheck: "false", autocomplete: "off" });
    const pop = h("div", { class: "wt-addpop" }, icon("globe"), input);
    const close = () => { pop.remove(); document.removeEventListener("mousedown", off, true); };
    const off = (e) => { if (!pop.contains(e.target)) close(); };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") return close();
      if (e.key !== "Enter") return;
      const url = toUrl(input.value, engine());
      if (!url || url === searchUrl(engine(), input.value)) return toast("That is not an address", { kind: "error" });
      close();
      if (isMarked(url)) saveMarks(marks().map((b) => (b.url === url ? { ...b, pinned: g === "row" || b.pinned, group: g === "row" ? b.group : g } : b)));
      else saveMarks([...marks(), { url, title: hostOf(url), group: g === "row" ? "" : g, pinned: g === "row" }]);
      if (g !== "row") app.setSetting("webMarkInto", g);
      toast(`Added ${hostOf(url)} - right-click it to name it`, { ms: 2600 });
      drawStart();
    });
    document.getElementById("overlay-root").append(pop);
    const x = at ? at.x : innerWidth / 2 - 150;
    const y = at ? at.y : innerHeight / 3;
    pop.style.left = Math.max(8, Math.min(x, innerWidth - 316)) + "px";
    pop.style.top = Math.max(8, Math.min(y, innerHeight - 50)) + "px";
    setTimeout(() => document.addEventListener("mousedown", off, true));
    input.focus();
  }
  function paintBar() {
    if (!tab) return;
    bar.classList.toggle("is-loading", !!tab.path && loading.has(tab.wid));
    if (document.activeElement !== addr) addr.value = tab.path || "";
    star.hidden = !tab.path;
    // nowhere to go: greyed
    backBtn.disabled = !tab.path && !tab.behind;
    fwdBtn.disabled = tab.path ? !tab.fwd : !(tab.ahead || (tab.behind && tab.behind.fwd));
    installBtn.hidden = !(app.host.real && tab.path && storeCrx(tab.path));
    storeBar.hidden = installBtn.hidden || storeBarOff === tab.path;
    if (!storeBar.hidden) storeBar.querySelector(".wt-storebar-text").textContent = "This is an add-on's page. The store's own Add button cannot finish inside Leonote - install it from here instead:";
    star.classList.toggle("is-on", !!tab.path && isMarked(tab.path));
    star.title = tab.path && isMarked(tab.path) ? "Remove this bookmark" : "Bookmark this page";
  }

  /** Go somewhere in the tab that is up. "" is the start page. */
  /* Home, as in a browser: the start page comes up and the page steps behind it, kept (hidden, its history with
     it) - Back returns to it as it was, and an address typed here loads in it, so Back still reaches what came
     before. Only Back past the first page leaves the page for good (open("")). */
  function goHome() {
    if (!tab || !tab.path) return;
    tab.behind = { path: tab.path, title: tab.title, trail: tab.trail || [], fwd: !!tab.fwd };
    tab.path = "";
    delete tab.ahead; delete tab.title;
    paint();
    api.changed();
  }
  function open(url) {
    if (!tab) return;
    // from the start page Home led to: the same page goes on, its history kept
    if (url && tab.behind) { tab.trail = tab.behind.trail; delete tab.behind; }
    else if (!url) delete tab.behind;
    tab.path = url;
    delete tab.ahead;
    if (!url) { delete tab.title; tab.trail = []; shown.delete(tab.wid); app.host.tabWebClose([tab.wid]).catch(() => {}); const i = live.indexOf(tab.wid); if (i >= 0) live.splice(i, 1); }
    else tab.title = "";
    paint();
    api.changed();
  }

  /* ── the native view follows its slot ─────────────────────────────────── */
  let scaleFactor = 1;
  if (app.host.real && app.host.win.scaleFactor) app.host.win.scaleFactor().then((f) => { scaleFactor = f || 1; }).catch(() => {});
  let rectKey = "";
  let up = false;
  // anything of the app's own that floats over the page (menus, dialogs, the
  // palette, toasts) would be UNDER a native view, so the view steps aside
  // Returns null when the page must go out of sight altogether, else how
  // much to cut off the top and the bottom: a menu hanging down from the tab
  // strip or a toast at the foot only takes its own strip of the page.
  // The app's menus and popups cannot be drawn over the native view. A
  // full-window overlay hides it; anything smaller becomes a hole cut into it
  // (physical px, relative to the view), so the page stays where it is.
  const cuts = () => {
    const r = slot.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const holes = [];
    for (const o of document.querySelectorAll("#overlay-root > *, .dlg-back, .pt-sheet-back, .menu, .img-viewer, .ie, .drop-card, .toast, .pal-back, .tab-peek, .nt-pop, .tg-pop, .folder-pop, .yt-layer, .pv.is-vfloat .pv-now, .speed-pop, .wt-addr-wrap > .wt-sug:not([hidden]), #corner-cards > .cc")) {
      const b = o.getBoundingClientRect();
      if (!(b.width && b.height && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top)) continue;
      if (o.matches(".dlg-back, .pt-sheet-back, .pal-back, .img-viewer, .ie")) return null;
      // the add-on popup's frame is rounded: so is its hole, or the page's corners would show as black squares
      if (o.matches(".wt-extpop-frame")) { holes.push([Math.floor((b.left - r.left) * dpr), Math.floor((b.top - r.top) * dpr), Math.ceil(b.width * dpr), Math.ceil(b.height * dpr), Math.round(32 * dpr)]); continue; }
      // the hole is the shape of what it is for: a toast's rounded corners would otherwise show the page's dark
      // ground as black corners. Menus keep a small band for their shadow
      const pad = o.matches(".toast") ? 0 : 4;
      const rad = parseFloat(getComputedStyle(o).borderRadius) || 0;
      holes.push([Math.floor((b.left - r.left - pad) * dpr), Math.floor((b.top - r.top - pad) * dpr), Math.ceil((b.width + 2 * pad) * dpr), Math.ceil((b.height + 2 * pad) * dpr), rad ? Math.round((rad + pad) * 2 * dpr) : 0]);
    }
    // an add-on's popup is a view of its own over the page: the page gives it room
    const p = app._extPop;
    if (p) holes.push([Math.floor((p.x - r.left) * dpr), Math.floor((p.y - r.top) * dpr), Math.ceil(p.w * dpr), Math.ceil(p.h * dpr)]);
    return { top: 0, bottom: 0, holes };
  };
  function place(force) {
    // the Player in full screen owns the window: every page view but a page's own full screen goes away
    // and so does anything of the app's own in full screen (a YouTube player's full-screen button)
    const playerFull = (!!document.querySelector("#app.is-playerfull") || !!document.fullscreenElement) && !(tab && fullWid === tab.wid);
    const want = !!tab && !!tab.path && !el.hidden && el.offsetParent !== null && !playerFull;
    if (!app.host.real) {
      note.hidden = !(tab && tab.path);
      if (tab && tab.path) note.replaceChildren(icon("globe"), h("div", { text: "The page opens here in the Leonote app." }), h("button", { class: "btn", onclick: () => app.openUrl(tab.path) }, "Open in your browser"));
      return;
    }
    note.hidden = true;
    if (want && stopped.has(tab.wid)) {
      if (up) { up = false; rectKey = ""; app.host.tabWebHide(tab.wid, 0, 0).catch(() => {}); }
      const wid = tab.wid;
      note.hidden = false;
      note.replaceChildren(icon(/^Could not reach/.test(stopped.get(wid)) ? "globe" : "moon"), h("div", { text: stopped.get(wid) }), h("button", { class: "btn", onclick: () => { stopped.delete(wid); warnedAt.delete(wid); place(true); } }, icon("rotateRight"), "Load it again"));
      return;
    }
    const cut = want ? cuts() : null;
    if (!want || !cut) { if (up) { up = false; rectKey = ""; app.host.tabWebHide(tab ? tab.wid : undefined, sleepSecs(), awakeMax()).catch(() => {}); } return; }
    // a page in full screen (its video's own button) takes the whole window, the app's frame and all
    const full = fullWid === tab.wid;
    const r = full ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : slot.getBoundingClientRect();
    const z = (window.devicePixelRatio || 1) / scaleFactor; // CSS px -> the window's logical px
    const rect = full ? { x: 0, y: 0, w: Math.round(innerWidth * z), h: Math.round(innerHeight * z), holes: [] } : { x: Math.round(r.left * z), y: Math.round((r.top + cut.top) * z), w: Math.round(r.width * z), h: Math.round((r.height - cut.top - cut.bottom) * z), holes: cut.holes };
    const key = `${tab.wid}:${rect.x},${rect.y},${rect.w},${rect.h}:${cut.holes.join(";")}`;
    const nav = shown.get(tab.wid) !== tab.path;
    if (!force && !nav && key === rectKey && up) return;
    if (rect.w < 40 || rect.h < 40) return;
    rectKey = key;
    up = true;
    shown.set(tab.wid, tab.path);
    const at = live.indexOf(tab.wid);
    if (at >= 0) live.splice(at, 1);
    live.push(tab.wid);
    memWatch();
    // many pages kept alive cost memory: the ones longest unseen are let go
    // of and simply load again when their tab comes up
    // (a tab playing sound is not let go of: the music would stop)
    for (let k = 0; live.length > MAX_LIVE && k < live.length;) { const old = live[k]; const t = api.findTab(old); if (t && t.audio && old !== tab.wid) { k++; continue; } live.splice(k, 1); shown.delete(old); app.host.tabWebClose([old]).catch(() => {}); }
    const wid = tab.wid;
    app.host.tabWebShow(wid, nav ? tab.path : null, rect, sleepSecs(), awakeMax()).catch((e) => { up = false; shown.delete(wid); note.hidden = false; note.replaceChildren(icon("globe"), h("div", { text: String(e) })); });
  }
  // the page's own full screen: the window goes full too, and the view covers everything until the page leaves it (Esc, its button)
  if (app.host.real) app.bus.on("tabweb:fullscreen", async (p) => {
    if (!p || !api.findTab(p.id)) return;
    const on = !!p.on;
    if (on === (fullWid === p.id)) return;
    fullWid = on ? p.id : null;
    const appEl = document.getElementById("app");
    if (appEl) appEl.classList.toggle("is-playerfull", on);
    try { if (on) fullWasMax = !!(await app.host.videoFullscreen(true, false)); else await app.host.videoFullscreen(false, fullWasMax); } catch {}
    rectKey = "";
    place(true);
  });
  // the page view follows the app's own layout: every frame for a second after anything moves (a click, a key, a
  // menu or toast coming, a resize, a panel sliding), then twice a second - a page read in quiet no longer keeps the
  // whole window drawing at the screen's rate
  let loop = 0, slow = 0, calmSince = 0, lastKey = "";
  const follow = () => {
    loop = 0; slow = 0;
    place(false);
    if (!tab || el.hidden) return;
    const now = performance.now();
    if (rectKey !== lastKey) { lastKey = rectKey; calmSince = now; }
    if (now - calmSince < 1000) loop = requestAnimationFrame(follow);
    else slow = setTimeout(follow, 500);
  };
  const kick = () => { calmSince = performance.now(); clearTimeout(slow); slow = 0; if (!loop && tab && !el.hidden) loop = requestAnimationFrame(follow); };
  // on the window: a key typed inside a page comes back as an event on the window (tabweb:key), never through document
  for (const ev of ["pointerdown", "pointerup", "keydown", "wheel", "resize", "leo:overlay"]) addEventListener(ev, kick, { capture: true, passive: true });
  if (typeof MutationObserver === "function") {
    const mo = new MutationObserver(kick);
    for (const id of [null, "overlay-root", "toasts", "corner-cards"]) { const n = id ? document.getElementById(id) : document.body; if (n) mo.observe(n, { childList: true }); }
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(kick).observe(slot);
  app.bus.on("extpop", () => place(true));

  if (app.host.real) {
    // a page wanting a new window - window.open, "Open link in new window", or Leonote's own rows in its menu
    app.host.on("tabweb:newtab", (p) => {
      if (!p || !p.url) return;
      if (p.how === "window") return ownWindow(p.url, "");
      if (p.how === "browser") return app.openUrl(p.url);
      if (p.how === "player") return app.addToPlayer(p.url);
      // a page's own window.open: web pages only - Leonote opening a local file or an add-on's page for it would
      // take the page somewhere it could not go itself
      if (/^https?:/i.test(p.url)) api.newTab(p.url);
    });
    // a page starting a download: nothing lands until you say so, or the site is on the always-allowed list
    app.host.on("tabweb:download", (p) => {
      if (!p || !p.label) return;
      // the list goes by the page that asked; the dialog also says where the file comes from
      const host = downloadSite(p.page), from = downloadSite(p.url);
      const reply = (ok) => app.host.tabWebDownloadReply(p.label, p.token, ok);
      if (downloadAllowed(p, app.settings.downloadHosts || [])) return reply(true);
      const name = basename(p.file || "") || p.url;
      const tick = h("input", { type: "checkbox" });
      const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); if (v && tick.checked && host) app.setSetting("downloadHosts", [...(app.settings.downloadHosts || []), host]); reply(v); };
      const okBtn = h("button", { class: "btn btn-primary", onclick: () => done(true) }, "Download");
      const box = h("div", { class: "dlg", role: "alertdialog", "aria-modal": "true" },
        h("h3", { class: "dlg-title", text: "Download this file?" }),
        h("p", { class: "dlg-text", text: `${name}${p.bytes > 0 ? " · " + fmtSize(p.bytes) : ""} from ${from || "the page"} - it goes to your Downloads folder, and nothing runs it.` }),
        host ? h("label", { class: "dlg-tick" }, tick, h("span", { text: `Always allow downloads from ${host} (Settings › Browser lists these)` })) : null,
        h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), okBtn));
      const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } }, box);
      // one key answers one dialog: the topmost (a page starting twenty downloads gets twenty questions, not one yes)
      const onKey = (e) => { if (back !== back.parentNode?.lastElementChild || (e.key !== "Escape" && e.key !== "Enter")) return; e.stopImmediatePropagation(); if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } else if (e.key === "Enter" && e.target !== tick) { e.preventDefault(); e.stopPropagation(); done(true); } };
      document.addEventListener("keydown", onKey, true);
      document.getElementById("overlay-root").append(back);
      requestAnimationFrame(() => { back.classList.add("is-in"); okBtn.focus(); });
    });
    app.host.on("tabweb:url", (p) => {
      if (!p || !p.url || /^about:/i.test(p.url)) return;
      // a page on its way shows it: a line running under the address until the page has come (or failed)
      if (p.done) loading.delete(p.id); else if (p.fwd === undefined) loading.add(p.id);
      const t = api.findTab(p.id);
      if (!t || !t.path) return;
      t.path = p.url;
      if (p.fwd !== undefined) t.fwd = p.fwd; // WebView2's own word on what lies ahead
      shown.set(p.id, p.url);
      if (t === tab) paintBar();
      if (p.done) {
        t.trail = t.trail || [];
        if (t.trail[t.trail.length - 1] !== p.url) { t.trail.push(p.url); if (t.trail.length > 200) t.trail.shift(); }
        visited(p.url, t.title);
        api.changed();
      }
    });
    // the zoom a site was left at (Ctrl+wheel, Ctrl +/-), kept per site and put back whenever it is opened again
    const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
    const zoomNow = new Map(); // wid -> the zoom its page is at
    app.host.on("tabweb:zoom", (p) => {
      const t = p && api.findTab(p.id);
      const site = t && t.path ? siteOf(t.path) : "";
      if (!site || !(p.zoom > 0)) return;
      zoomNow.set(p.id, p.zoom);
      const z = Math.round(p.zoom * 100) / 100;
      const hosts = { ...(app.settings.webZoomHosts || {}) };
      if (Math.abs(z - 1) < 0.01) delete hosts[site]; else hosts[site] = z;
      if (JSON.stringify(hosts) !== JSON.stringify(app.settings.webZoomHosts || {})) app.setSetting("webZoomHosts", hosts);
    });
    app.host.on("tabweb:url", (p) => {
      if (!p || !p.done || !api.findTab(p.id)) return;
      const want = Number((app.settings.webZoomHosts || {})[siteOf(p.url)]) || 1;
      if (Math.abs((zoomNow.get(p.id) ?? 1) - want) > 0.005) { zoomNow.set(p.id, want); app.host.tabWebZoom(p.id, want).catch(() => {}); }
    });
    app.host.on("tabweb:audio", (p) => {
      const t = p && api.findTab(p.id);
      if (!t) return;
      t.audio = !!p.playing;
      if (p.muted != null) t.muted = !!p.muted;
      api.changed();
    });
    app.host.on("tabweb:title", (p) => {
      const t = p && api.findTab(p.id);
      if (!t || !t.path || !p.title) return;
      const title = String(p.title).slice(0, 200);
      // a page that ticks its title (a timer, a chat) does not redraw the whole tab strip each time
      if (t.title === title) return;
      t.title = title;
      H.setTitle(t.path, t.title);
      if (api.titled) api.titled(t); else api.changed();
    });
  }

  /** A page in a top-level Leonote window of its own: movable to another screen, kept on top if you like. */
  const ownWindow = (url, title) => app.host.webOpen({ id: "w" + Math.abs([...url].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36), url, title: title || hostOf(url) }).catch((e) => toast(String(e), { kind: "error" }));

  /* ── the start page ───────────────────────────────────────────────────── */
  const siteTile = (b, { remove } = {}) => {
    const host = hostOf(b.url);
    const fav = siteIcon(host, "wt-fav", () => h("span", { class: "wt-fav is-letter", text: (host[0] || "?").toUpperCase() }));
    const t = h("button", { class: "wt-site", title: b.url, draggable: true, dataset: { url: b.url }, onclick: () => open(b.url), oncontextmenu: (e) => { e.preventDefault(); siteMenu(e, b); } }, fav, h("span", { text: b.title || host }));
    if (remove) t.append(h("span", { class: "wt-site-x", title: "Remove", onclick: (e) => { e.stopPropagation(); remove(); } }, icon("x")));
    return t;
  };
  function siteMenu(e, b) {
    menu(e.clientX, e.clientY, [
      { label: "Open", icon: "globe", run: () => open(b.url) },
      { label: "Open in a new tab", icon: "plus", run: () => api.newTab(b.url) },
      { label: "Open in its own Leonote window", icon: "outside", run: () => ownWindow(b.url, b.title) },
      { label: "Open in your own browser", icon: "outside", run: () => app.openUrl(b.url) },
      "sep",
      { label: b.pinned ? "Take it out of the buttons row" : "Show it among the buttons", icon: "pin", run: () => { saveMarks(marks().map((x) => (x.url === b.url ? { ...x, pinned: !x.pinned } : x))); drawStart(); } },
      { label: "Move to", icon: "folder", sub: groupsOf(S).map((g) => ({ label: g.name, checked: (b.group || "") === g.id, run: () => { saveMarks(marks().map((x) => (x.url === b.url ? { ...x, group: g.id } : x))); drawStart(); } })) },
      { label: "Edit…", icon: "edit", run: async () => { const r = await askDialog("Edit bookmark", [{ key: "title", label: "Name", value: b.title || "" }, { key: "url", label: "Address", value: b.url }], { ok: "Save" }); if (!r || !r.url) return; const url = toUrl(r.url, engine()); saveMarks(marks().map((x) => (x.url === b.url ? { ...x, title: r.title, url } : x))); drawStart(); } },
      { label: "Remove bookmark", icon: "trash", danger: true, run: () => removeMark(b.url, drawStart) },
    ]);
  }

  /** A box's list of suggestions as you type (notes, bookmarks, history, then the search or address itself):
      arrows walk it, Enter takes the lit one. `bar`: the page's address bar - it keeps its page (no notes search), and
      `esc` and `changed` (the page view leaves room for the list) are the caller's. Returns the list, placed by the caller. */
  function withSuggestions(box, { esc, changed = () => {}, bar = false }) {
    const list = h("div", { class: "wt-sug", hidden: true });
    let rows = [];
    let at = 0;
    const show = (on) => { list.hidden = !on; changed(); };
    const paintSug = () => {
      rows = suggest(box.value, bar);
      at = Math.max(0, rows.findIndex((r) => r.web));
      list.replaceChildren(...rows.map((r, i) => h("button", { class: "wt-sug-row" + (i === at ? " is-on" : ""), onmousedown: (e) => { e.preventDefault(); show(false); r.run(); } }, icon(r.ic), h("span", { class: "wt-row-label", text: r.label }), r.sub ? h("span", { class: "wt-row-sub", text: r.sub }) : null)));
      show(!!rows.length);
    };
    box.addEventListener("input", (e) => {
      // the address bar finishes a site you have been to as you type its start (Firefox's autofill): the rest is
      // selected, so typing on replaces it and Backspace takes it away
      const t = box.value;
      if (bar && e.inputType && !e.inputType.startsWith("delete") && /^[\w.-]+$/.test(t) && box.selectionStart === t.length) {
        const low = t.toLowerCase();
        const site = [...marks(), ...H.pages()].map((b) => hostOf(b.url).replace(/^www\./, "")).find((x) => x.length > low.length && x.startsWith(low));
        if (site) { box.value = t + site.slice(t.length); box.setSelectionRange(t.length, box.value.length); }
      }
      paintSug();
    });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (rows.length && !list.hidden) { at = (at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length; [...list.children].forEach((c, i) => c.classList.toggle("is-on", i === at)); } }
      else if (e.key === "Enter") { e.preventDefault(); if (list.hidden || !rows[at]) { const u = toUrl(box.value, engine()); if (u) open(u); } else { show(false); rows[at].run(); } }
      else if (e.key === "Escape") { if (!list.hidden && bar) show(false); else { esc(); if (!bar) paintSug(); } }
    });
    box.addEventListener("blur", () => setTimeout(() => show(false), 120));
    // the start page's box shows them again on focus; the address bar only once you type (it holds the page's address)
    if (!bar) box.addEventListener("focus", () => { if (box.value) paintSug(); });
    return list;
  }

  function suggest(q, bar) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const notes = [];
    for (const n of app.vault.notes.values()) { if (notes.length >= (bar ? 3 : 5)) break; if (basename(n.path).toLowerCase().includes(s)) notes.push({ ic: "fileText", label: basename(n.path), sub: dirname(n.path) || "note", run: () => api.replaceTab({ kind: "note", path: n.path }) }); }
    // every word typed, in any order, somewhere in the title or the address - as Firefox matches
    const words = s.split(/\s+/);
    const seen = new Set(), links = [];
    for (const b of [...marks(), ...H.pages()]) {
      if (links.length >= (bar ? 7 : 9 - notes.length)) break;
      if (seen.has(b.url) || !words.every((w) => `${b.title || ""} ${b.url}`.toLowerCase().includes(w))) continue;
      seen.add(b.url);
      links.push({ ic: isMarked(b.url) ? "star" : "clock", label: b.title || hostOf(b.url), sub: b.url, run: () => open(b.url) });
    }
    // the address bar is about pages: the links first, your notes after them
    const out = bar ? [...links, ...notes] : [...notes, ...links];
    const u = toUrl(q, engine());
    const isAddr = u !== searchUrl(engine(), q);
    if (isAddr && /\.(jpe?g|png|webp|gif|bmp|avif)(\?|$)/i.test(u)) out.push({ ic: "image", label: "Find this picture with Google Lens", sub: u, run: () => open(searchUrl("lens", u)) });
    out.push({ ic: isAddr ? "globe" : "search", label: isAddr ? `Go to ${u}` : `Search ${E()[engine()][0]} for “${q.trim()}”`, sub: "", run: () => open(u), web: true });
    if (!bar) out.push({ ic: "search", label: `Search your notes for “${q.trim()}”`, sub: "Ctrl+Shift+F", run: () => { api.closeSelf(); app.openSearch({ query: q.trim() }); } });
    return out;
  }

  // New things made from here go to ONE tidy place each, so a burst of quick
  // notes, sketches and boards never litters the vault and is cleaned up in
  // one go. Right-click a tile for another place, or to change the usual one.
  const MAKERS = {
    note: { label: "Note", ic: "filePlus", key: "quickNoteDir", make: (dir) => app.newNote({ dir, newTab: true }) },
    sketch: { label: "Leopaint", ic: "brush", key: "quickSketchDir", make: (dir) => app.newSketch({ dir }) },
    board: { label: "Board", ic: "grid", key: "quickBoardDir", make: (dir) => app.newBoard({ dir }) },
    drawing: { label: "Studio", ic: "studio", key: "quickDrawingDir", make: (dir) => import("./paintmode.js").then((m) => m.newDrawing(app, { dir })) },
    animation: { label: "Animate", ic: "animate", key: "quickAnimationDir", make: (dir) => import("./paintmode.js").then((m) => m.newDrawing(app, { mode: "draw", persona: "animate", dir, preset: app.settings.animCanvas || "an-post", go: true })) },
    video: { label: "Video", ic: "film", key: "quickVideoDir", make: (dir) => import("./videoedit.js").then((m) => m.newVideo(app, { dir })) },
  };
  const usualDir = (m) => app.workDir(Object.keys(MAKERS).find((k) => MAKERS[k] === m));
  function maker(kind) {
    const m = MAKERS[kind];
    const make = (dir) => { api.closeSelf(); m.make(dir); };
    const where = (d) => d || "the vault's root";
    return h("button", { class: "wt-act", title: `New ${m.label.toLowerCase()} in ${where(usualDir(m))} · right-click for another place`, onclick: () => make(usualDir(m)),
      oncontextmenu: (e) => {
        e.preventDefault();
        const here = app.lastNotePath && app.lastNotePath() ? dirname(app.lastNotePath()) : "";
        menu(e.clientX, e.clientY, [
          { header: `New ${m.label.toLowerCase()}` },
          { label: `In ${where(usualDir(m))} - the usual place`, icon: "folder", run: () => make(usualDir(m)) },
          here !== usualDir(m) ? { label: `In ${where(here)} - where you work`, icon: "fileText", run: () => make(here) } : null,
          { label: "Choose a place…", icon: "search", run: () => app.palette("move", { onPick: (dir) => make(dir) }) },
          "sep",
          { label: "Change the usual place…", icon: "settings", run: () => app.palette("move", { onPick: (dir) => { app.setSetting(m.key, dir); drawStart(); toast(`New ${m.label.toLowerCase()}s go to ${where(dir)}`, { ms: 3200 }); } }) },
          S[m.key] ? { label: "Back to the Workplace folder", icon: "undo", run: () => { app.setSetting(m.key, ""); drawStart(); } } : null,
          ...hideItems(kind),
        ]);
      } }, icon(m.ic), h("span", { text: m.label }), h("span", { class: "wt-act-where", text: usualDir(m) || "root" }));
  }

  const searchWith = (k, text) => { const u = searchUrl(k, text); if (u) open(u); };

  /* ── the row of engine chips: yours to reorder, swap, hide and add to ── */
  const quick = () => (Array.isArray(S.webQuick) ? S.webQuick.filter((k) => E()[k]) : QUICK);
  const saveQuick = (list) => { app.setSetting("webQuick", list); drawStart(); };
  function chipMenu(e, k, i) {
    e.preventDefault();
    const list = quick();
    const swap = (j) => { if (j < 0 || j >= list.length) return; const l = list.slice(); [l[i], l[j]] = [l[j], l[i]]; saveQuick(l); };
    const put = (id, at) => { const l = list.filter((x) => x !== id); l.splice(at, 0, id); saveQuick(l); };
    menu(e.clientX, e.clientY, [
      { header: E()[k][0] },
      { label: "Move left", icon: "arrowUp", run: () => swap(i - 1) },
      { label: "Move right", icon: "arrowDown", run: () => swap(i + 1) },
      { label: "Replace with", icon: "search", sub: [{ label: "Your own engine or page…", icon: "plus", run: async () => { const id = await newEngine(); if (id) { const l = list.slice(); l[i] = id; saveQuick(l); } } }, "sep", ...engineRows((x) => x === k, (x) => { const l = list.slice(); l[i] = x; saveQuick([...new Set(l)]); })] },
      { label: "Add one after it", icon: "plus", sub: [{ label: "Your own engine or page…", icon: "plus", run: async () => { const id = await newEngine(); if (id) put(id, i + 1); } }, "sep", ...engineRows((x) => list.includes(x), (x) => put(x, i + 1))] },
      { label: "Hide it", icon: "x", run: () => saveQuick(list.filter((x) => x !== k)) },
      "sep",
      { label: "The usual row", icon: "undo", run: () => saveQuick(null) },
    ]);
  }
  /* ── the button at the end of the box ─────────────────────────────────── */
  const boxEngine = () => (E()[S.webBoxEngine] ? S.webBoxEngine : "lens");
  function boxBtn(box) {
    if (S.webBoxEngineOn === false) return null;
    const k = boxEngine();
    const ic = k === "images" || k === "lens" ? "image" : E()[k][2] === "Ask" ? "sparkles" : E()[k][2] === "Media and places" ? "globe" : "search";
    // Lens wants a picture's address; plain words go to Google Images instead
    const go = () => { const q = box.value.trim(); const isAddr = !!q && toUrl(q, engine()) !== searchUrl(engine(), q); if (k === "lens" && q && !isAddr) return searchWith("images", q); searchWith(k, q); };
    return h("button", { class: "wt-q-eng", title: `Search ${E()[k][0]} for what is in the box - or open it, when the box is empty · right-click for another`, onmousedown: (e) => e.preventDefault(), onclick: go,
      oncontextmenu: (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
        { header: "The button at the end of the box" },
        { label: "Another engine", icon: "search", sub: engineRows((x) => x === k, (x) => { app.setSetting("webBoxEngine", x); drawStart(); }) },
        { label: "Your own engine or page…", icon: "plus", run: async () => { const id = await newEngine(); if (id) { app.setSetting("webBoxEngine", id); drawStart(); } } },
        "sep",
        { label: "Hide the button", icon: "x", run: () => { app.setSetting("webBoxEngineOn", false); drawStart(); } },
      ]); } }, icon(ic), h("span", { text: E()[k][0].replace(/^Google /, "").replace(/ - .*$/, "") }));
  }
  /* ── the buttons row: the makers, Today, Find, Assistant - and bookmarks you put there ── */
  const ACT_IDS = ["note", "sketch", "board", "drawing", "animation", "video", "today", "find", "assistant"];
  // views you put on the row as well: "v:<view id>"
  const extraActs = () => (Array.isArray(S.webActsExtra) ? S.webActsExtra.filter((x) => x.startsWith("v:") && app.views.some((v) => v.id === x.slice(2))) : []);
  const ACT_LABEL = { note: "Note", sketch: "Sketch", board: "Board", drawing: "Drawing", animation: "Animate", video: "Video", today: "Today", find: "Find", assistant: "Assistant" };
  const hiddenActs = () => (Array.isArray(S.webActsHidden) ? S.webActsHidden : []);
  const actsOrder = () => {
    const ids = Array.isArray(S.webActsOrder) ? S.webActsOrder : [];
    const pinnedIds = marks().filter((b) => b.pinned).map((b) => "m:" + b.url);
    const ex = extraActs();
    return [...ids.filter((x) => ACT_IDS.includes(x) || pinnedIds.includes(x) || ex.includes(x)), ...ACT_IDS.filter((x) => !ids.includes(x)), ...pinnedIds.filter((x) => !ids.includes(x)), ...ex.filter((x) => !ids.includes(x))];
  };
  const hideItems = (id) => {
    const hid = hiddenActs();
    return [
      "sep",
      { label: `Hide ${ACT_LABEL[id] || "this button"}`, icon: "x", run: () => { app.setSetting("webActsHidden", [...new Set([...hid, id])]); drawStart(); } },
      hid.length ? { label: "Show again", icon: "plus", sub: [...hid.map((x) => ({ label: ACT_LABEL[x] || x, run: () => { app.setSetting("webActsHidden", hid.filter((y) => y !== x)); drawStart(); } })), "sep", { label: "Show them all", run: () => { app.setSetting("webActsHidden", []); drawStart(); } }] } : null,
    ];
  };
  const markAct = (b) => {
    const host = hostOf(b.url);
    const fav = siteIcon(host, "wt-fav", () => h("span", { class: "wt-fav is-letter", text: (host[0] || "?").toUpperCase() }));
    return h("button", { class: "wt-act is-mark", title: b.url, draggable: true, dataset: { act: "m:" + b.url }, onclick: () => open(b.url), oncontextmenu: (e) => { e.preventDefault(); siteMenu(e, b); } }, fav, h("span", { text: b.title || host }));
  };

  function drawStart() {
    const wall = String(S.newTabWallpaper || "lion");
    start.dataset.wall = WALLPAPERS.some(([k]) => k === wall) ? wall : wall.startsWith("img:") ? "img" : "lion";
    start.style.backgroundImage = wall.startsWith("img:") && app.host.assetUrl ? `linear-gradient(rgba(10,10,14,.55), rgba(10,10,14,.72)), url("${app.host.assetUrl(wall.slice(4))}")` : "";
    const recent = (S.recent || []).filter((p) => app.vault.notes.has(p) || app.vault.files.has(p));
    const folders = [];
    for (const p of recent) { const d = dirname(p); if (d && !folders.includes(d) && app.vault.folders.has(d)) folders.push(d); if (folders.length >= 4) break; }
    const here = app.lastNotePath && app.lastNotePath() ? dirname(app.lastNotePath()) : "";
    const act = (id, ic, label, run, title) => h("button", { class: "wt-act", title: (title || label) + " · right-click to hide", onclick: run, oncontextmenu: (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [{ header: label }, ...hideItems(id).slice(1)]); } }, icon(ic), h("span", { text: label }));
    const row = (ic, label, sub, run) => h("button", { class: "wt-row", onclick: run }, icon(ic), h("span", { class: "wt-row-label", text: label }), sub ? h("span", { class: "wt-row-sub", text: sub }) : null);
    const openDoc = (p) => api.replaceTab(app.vault.notes.has(p) ? { kind: "note", path: p } : { kind: "file", path: p });
    const leaveFor = (run) => () => { api.closeSelf(); run(); };

    const box = h("input", { class: "wt-q", spellcheck: "false", autocomplete: "off", placeholder: `Search ${ENGINES[engine()][0]}, your notes, or type an address`, "aria-label": "Search" });
    const list = withSuggestions(box, { esc: () => { box.value = ""; } });

    // the engine chips, dragged into your order
    const engines = h("div", { class: "wt-engines" },
      ...quick().map((k, i) => h("button", { class: "wt-engine" + (k === engine() ? " is-on" : ""), draggable: true, title: `Search ${E()[k][0]} for what is in the box - or open it, when the box is empty · right-click to move, swap or hide it`, onclick: () => searchWith(k, box.value), oncontextmenu: (e) => chipMenu(e, k, i) }, E()[k][0])),
      h("button", { class: "wt-engine is-more", title: "Every search and research engine · right-click to add one to the row", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); const q = box.value; menu(r.left, r.bottom + 4, engineRows(() => false, (k) => searchWith(k, q))); },
        oncontextmenu: (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [{ header: "Add to the row" }, { label: "Your own engine or page…", icon: "plus", run: async () => { const id = await newEngine(); if (id) saveQuick([...quick(), id]); } }, quick() !== QUICK ? { label: "The usual row", icon: "undo", run: () => saveQuick(null) } : null, "sep", ...engineRows((x) => quick().includes(x), (x) => saveQuick([...new Set([...quick(), x])]))]); } }, "More…"));
    sortable(engines, { axis: "x", item: ".wt-engine:not(.is-more)", onMove: (i, j) => { const l = quick().slice(); const [m] = l.splice(i, 1); l.splice(j, 0, m); saveQuick(l); } });
    // the buttons row: built-in ones and the bookmarks you put there, in your order, the hidden ones away
    const hid = hiddenActs();
    const actEl = (id) => {
      if (id.startsWith("m:")) { const b = marks().find((x) => x.url === id.slice(2)); return b ? markAct(b) : null; }
      if (MAKERS[id]) { const el = maker(id); el.dataset.act = id; return el; }
      if (id.startsWith("v:")) {
        const v = app.views.find((x) => x.id === id.slice(2));
        const el = h("button", { class: "wt-act", title: v.name + " · right-click to take it out", onclick: () => app.openView(v.id), oncontextmenu: (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [{ header: v.name }, { label: "Take it out of the row", icon: "x", run: () => { app.setSetting("webActsExtra", extraActs().filter((x) => x !== id)); drawStart(); } }]); } }, icon(v.icon), h("span", { text: v.name }));
        el.dataset.act = id;
        return el;
      }
      const el = id === "today" ? act(id, "calendar", "Today", leaveFor(() => app.openDaily(undefined, { newTab: true })))
        : id === "find" ? act(id, "search", "Find", () => app.palette("switcher", { force: true }), "Search everything (Ctrl+O)")
        : act(id, "sparkles", "Assistant", () => app.openView("assistant"));
      el.dataset.act = id;
      return el;
    };
    const shown = actsOrder().filter((id) => !hid.includes(id));
    const onRow = new Set(extraActs());
    const acts = h("div", { class: "wt-acts" }, ...shown.map(actEl),
      h("button", { class: "icon-btn wt-acts-add", title: "More buttons: the ones you hid, a page, a part of Leonote", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, [
        hid.length ? { label: "Show again", icon: "undo", sub: [...hid.map((x) => ({ label: ACT_LABEL[x] || x, run: () => { app.setSetting("webActsHidden", hid.filter((y) => y !== x)); drawStart(); } })), "sep", { label: "Show them all", run: () => { app.setSetting("webActsHidden", []); drawStart(); } }] } : null,
        { label: "A page…", icon: "globe", run: () => addMark("row", { x: r.left, y: r.bottom + 4 }) },
        { label: "A part of Leonote", icon: "grid", sub: app.views.filter((v) => v.id !== "settings").map((v) => ({ label: v.name, icon: v.icon, checked: onRow.has("v:" + v.id), run: () => { const id = "v:" + v.id; app.setSetting("webActsExtra", onRow.has(id) ? extraActs().filter((x) => x !== id) : [...extraActs(), id]); drawStart(); } })) },
        marks().some((b) => !b.pinned) ? { label: "A bookmark", icon: "star", sub: marks().filter((b) => !b.pinned).slice(0, 30).map((b) => ({ label: b.title || hostOf(b.url), run: () => { saveMarks(marks().map((x) => (x.url === b.url ? { ...x, pinned: true } : x))); drawStart(); } })) } : null,
      ].filter(Boolean)); } }, icon("plus")));
    for (const el of acts.querySelectorAll(".wt-act:not(.is-ghost)")) el.draggable = true;
    sortable(acts, { axis: "x", item: ".wt-act:not(.is-ghost)", onMove: (i, j) => { const l = shown.slice(); const [m] = l.splice(i, 1); l.splice(j, 0, m); app.setSetting("webActsOrder", [...l, ...hid]); drawStart(); } });
    const lately = H.pages().filter((x) => !isMarked(x.url));
    // a list that shows a page of rows and adds the next page as you near its end
    const growing = (items, render, empty, page = 10) => {
      const el = h("div", { class: "wt-rows is-scroll" }, ...items.slice(0, page).map(render), items.length ? null : empty);
      let shown = page;
      el.addEventListener("scroll", () => { if (shown < items.length && el.scrollTop + el.clientHeight > el.scrollHeight - 80) { el.append(...items.slice(shown, shown + page).map(render)); shown += page; } });
      return el;
    };
    const section = (title, body, more) => h("section", { class: "wt-sec" }, h("div", { class: "wt-sec-head" }, h("span", { text: title }), more || null), body);
    const link = (label, run) => h("button", { class: "wt-link", onclick: run }, label);

    start.replaceChildren(
      art("wt-wall", start.dataset.wall === "lion" ? LION : ""),
      h("button", { class: "icon-btn wt-gear", title: "Wallpaper, search engine, history", onclick: (e) => startMenu(e.currentTarget) }, icon("settings")),
      h("div", { class: "wt-inner" },
        h("div", { class: "wt-hero" }, Object.assign(art("wt-logo", LION), { title: "Leo" }), h("div", { class: "wt-hello", text: hello() })),
        h("div", { class: "wt-q-wrap" }, icon("search", "wt-q-ico"), box, boxBtn(box), list),
        engines,
        acts,
        S.webMarksOff ? h("div", { class: "wt-marks-back" }, h("button", { class: "wt-link", onclick: () => { app.setSetting("webMarksOff", false); drawStart(); } }, icon("star"), "Bookmarks")) : bookmarkGrounds({ app, marks, saveMarks, siteTile, open, newTab: (u) => api.newTab(u), redraw: drawStart, addMark, library }),
        h("div", { class: "wt-cols" },
          section("Lately visited", growing(lately, (x) => row("clock", x.title || hostOf(x.url), hostOf(x.url), () => open(x.url)),
              h("div", { class: "wt-empty", text: S.webHistoryOn === false ? "History is off." : "Pages you visit show up here." }), 14),
            H.visits().length ? link("History", () => library("history")) : null),
          h("div", { class: "wt-stack" },
            section("Recent", growing(recent, (p) => { const n = app.vault.notes.has(p); const f = n ? null : app.vault.files.get(p); return row(n ? "fileText" : KIND_ICON[f.kind] || "file", n ? basename(p) : p.slice(p.lastIndexOf("/") + 1), dirname(p) || null, () => openDoc(p)); },
              h("div", { class: "wt-empty", text: "Notes you open show up here." }))),
            folders.length ? section("New note in", h("div", { class: "wt-rows" }, ...folders.map((d) => row("folder", basename(d), dirname(d) || null, leaveFor(() => app.newNote({ dir: d, newTab: true })))))) : null)),
        h("button", { class: "wt-paw", title: "Leo", onclick: (e) => { const b = e.currentTarget; b.classList.remove("is-purr"); void b.offsetWidth; b.classList.add("is-purr"); toast(LEO_SAYS[Math.floor(Math.random() * LEO_SAYS.length)], { ms: 3200 }); } }, "🐾")));
    // the box takes focus when the page comes up - unless the keys are already going somewhere else (the Player's filter, say)
    requestAnimationFrame(() => { const a = document.activeElement; if (!start.hidden && tab && !tab.path && !(a && a !== box && a.matches("input, textarea, [contenteditable]"))) box.focus(); });
  }
  // A picture pasted here goes to Google's search by picture. Its bytes cannot
  // travel in an address, so the page is opened with its picture box up and
  // the picture is pasted again there - it is still on the clipboard.
  start.addEventListener("paste", (e) => {
    const items = [...(e.clipboardData ? e.clipboardData.items : [])];
    const pic = items.find((x) => x.kind === "file" && x.type.startsWith("image/"));
    if (!pic) return;
    e.preventDefault();
    open("https://www.google.com/imghp?sbi=1&hl=en");
    toast("Google's search by picture is opening - press Ctrl+V there to drop your picture in", { ms: 6000 });
  });
  const hello = () => { const hr = new Date().getHours(); return hr < 5 ? "Still up?" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"; };

  function startMenu(at) {
    const r = at.getBoundingClientRect();
    const wall = String(S.newTabWallpaper || "lion");
    const pics = [...app.vault.files.values()].filter((f) => f.kind === "image").sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 14);
    menu(r.left, r.bottom + 4, [
      { header: "Wallpaper" },
      ...WALLPAPERS.map(([k, label]) => ({ label, checked: wall === k, run: () => { app.setSetting("newTabWallpaper", k); drawStart(); } })),
      pics.length ? { label: "A picture from your vault", icon: "image", sub: pics.map((f) => ({ label: f.path.slice(f.path.lastIndexOf("/") + 1), checked: wall === "img:" + f.path, run: () => { app.setSetting("newTabWallpaper", "img:" + f.path); drawStart(); } })) } : null,
      "sep",
      { label: "Search with", icon: "search", sub: [{ label: "Your own engine or page…", icon: "plus", run: async () => { const id = await newEngine(); if (id) { app.setSetting("webSearch", id); drawStart(); } } }, "sep", ...engineRows((k) => engine() === k, (k) => { app.setSetting("webSearch", k); drawStart(); })] },
      { label: "Remember pages I visit", checked: S.webHistoryOn !== false, run: () => { app.setSetting("webHistoryOn", S.webHistoryOn === false); drawStart(); } },
      { label: "The start page", icon: "home", sub: [
        { label: "A button at the end of the box", checked: S.webBoxEngineOn !== false, run: () => { app.setSetting("webBoxEngineOn", S.webBoxEngineOn === false); drawStart(); } },
        { label: "The usual row of engines", icon: "undo", run: () => saveQuick(null) },
        { label: "Show every button", icon: "undo", run: () => { app.setSetting("webActsHidden", []); drawStart(); } },
        { label: "Bookmarks on the start page", checked: !S.webMarksOff, run: () => { app.setSetting("webMarksOff", !S.webMarksOff); drawStart(); } },
        ...((S.webCustomEngines || []).length ? ["sep", { header: "Your own engines" }, ...(S.webCustomEngines || []).map((c) => ({ label: `Forget ${c.label}`, icon: "trash", run: () => { app.setSetting("webCustomEngines", (S.webCustomEngines || []).filter((x) => x.id !== c.id)); drawStart(); } }))] : []),
      ] },
      "sep",
      { label: "Bookmarks…", icon: "star", run: () => library("bookmarks") },
      { label: "Add-ons…", icon: "download", run: () => openAddons(app) },
      { label: "History…", icon: "clock", run: () => library("history") },
    ]);
  }
  function moreMenu(at) {
    const r = at.getBoundingClientRect();
    menu(r.right - 220, r.bottom + 4, [
      { label: "New tab", icon: "plus", keys: "Ctrl T", run: () => api.newTab("") },
      { label: "The start page", icon: "home", run: () => goHome() },
      "sep",
      { label: "Bookmarks…", icon: "star", run: () => library("bookmarks") },
      { label: "Add-ons…", icon: "download", run: () => openAddons(app) },
      { label: "History…", icon: "clock", run: () => library("history") },
      tab && tab.path && storeCrx(tab.path) ? { label: "Install this add-on", icon: "download", run: async () => { const st = storeCrx(tab.path); toast("Getting the add-on…", { ms: 3000 }); try { const r = await app.host.webExtInstall(st.url); toast(`${(r && r.name) || "The add-on"} is on`, { ms: 4000 }); } catch (e) { toast(String(e), { kind: "error", ms: 8000 }); } } } : null,
      tab && tab.path ? { label: "Open this page in its own Leonote window", icon: "outside", run: () => ownWindow(tab.path, tab.title) } : null,
      tab && tab.path && /youtube\.com\/(watch|shorts\/|playlist)|youtu\.be\/|[?&]list=/i.test(tab.path) ? { label: /[?&]list=/i.test(tab.path) ? "Add the playlist to the Player" : "Add this video to the Player", icon: "music", run: () => app.addToPlayer(tab.path) } : null,
      tab && tab.path ? { label: "Copy the address", icon: "link", run: () => navigator.clipboard.writeText(tab.path).then(() => toast("Address copied", { ms: 1600 })) } : null,
      tab && tab.path ? { label: "Copy as a link", icon: "link", run: () => navigator.clipboard.writeText(`[${String(tab.title || hostOf(tab.path)).replace(/[[\]]/g, "")}](${tab.path})`).then(() => toast("Copied", { ms: 1400 })) } : null,
      tab && /^https?:/i.test(tab.path || "") && app.zettel ? { label: "New reference note from this page", icon: "book", run: () => app.zettel.newReference({ url: tab.path, title: tab.title || "" }) } : null,
      tab && tab.path ? { label: "Link to this page in the last note", icon: "fileText", run: () => { const p = app.lastNotePath && app.lastNotePath(); if (!p) return toast("Open a note first"); api.linkInto(p, `[${tab.title || hostOf(tab.path)}](${tab.path})`); } } : null,
      "sep",
      { label: "Search with", icon: "search", sub: engineRows((k) => engine() === k, (k) => app.setSetting("webSearch", k)) },
    ]);
  }

  // the address box's own menu: the text's edits, and what the address can become - the Player's
  // too, for a video or a playlist (the Player says so when a link is not one it plays)
  addr.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const typed = addr.value.trim();
    const url = /^https?:\/\//i.test(typed) ? typed : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(typed) ? "https://" + typed : tab && tab.path;
    const picked = addr.value.slice(addr.selectionStart, addr.selectionEnd);
    const media = url && /youtube\.com\/(watch|shorts\/|playlist)|youtu\.be\/|[?&]list=|\.(mp3|mp4|m4a|webm|ogg|opus|flac|wav)(\?|#|$)/i.test(url);
    menu(e.clientX, e.clientY, [
      { label: "Cut", icon: "scissors", keys: "Ctrl X", run: () => { if (!picked) return; navigator.clipboard.writeText(picked); addr.setRangeText("", addr.selectionStart, addr.selectionEnd, "start"); } },
      { label: "Copy", icon: "clipboard", keys: "Ctrl C", run: () => navigator.clipboard.writeText(picked || addr.value) },
      { label: "Paste", icon: "clipboard", keys: "Ctrl V", run: async () => { const t = await navigator.clipboard.readText().catch(() => ""); addr.focus(); addr.setRangeText(t, addr.selectionStart, addr.selectionEnd, "end"); } },
      { label: "Paste and go", icon: "send", run: async () => { const t = (await navigator.clipboard.readText().catch(() => "")).trim(); if (t) open(t); } },
      { label: "Select all", icon: "cursor", keys: "Ctrl A", run: () => { addr.focus(); addr.select(); } },
      url ? "sep" : null,
      url ? { label: media ? (/[?&]list=|\/playlist/i.test(url) ? "Add the playlist to the Player" : "Add to the Player") : "Try it in the Player", icon: "music", run: () => app.addToPlayer(url) } : null,
      url ? { label: "Open in a new tab", icon: "plus", run: () => api.newTab(url) } : null,
      url ? { label: "Open in its own Leonote window", icon: "outside", run: () => ownWindow(url, "") } : null,
      url ? { label: "Open in your browser", icon: "globe", run: () => app.openUrl(url) } : null,
      url ? { label: "Link to it in the last note", icon: "fileText", run: () => { const p = app.lastNotePath && app.lastNotePath(); if (!p) return toast("Open a note first"); api.linkInto(p, `[${hostOf(url)}](${url})`); } } : null,
    ].filter(Boolean));
  });

  /* ── bookmarks and history, looked through ────────────────────────────── */
  function library(which) {
    if (which === "history") return openHistory(app, H, {
      open: (url) => (tab ? open(url) : api.newTab(url)), newTab: (url) => api.newTab(url),
      bookmark: (url, title) => saveMarks([...marks(), { url, title, group: markInto(S) }]), isMarked, bookmarks: () => library("bookmarks"),
    });
    let mode = "bookmarks";
    let q = "";
    let sort = "new"; // new | old | site | most
    const find = h("input", { class: "wt-lib-find", placeholder: "Filter", spellcheck: "false" });
    const list = h("div", { class: "trash-list wt-lib-list" });
    const seg = h("div", { class: "segmented is-small" }, [["bookmarks", "Bookmarks"], ["history", "History"]].map(([v, label]) => h("button", { class: "seg", dataset: { v }, onclick: () => { if (v === "history") { close(); library("history"); } } }, label)));
    const sortSeg = h("div", { class: "segmented is-small" }, [["new", "Newest"], ["old", "Oldest"], ["site", "By site"], ["most", "Most visited"]].map(([v, label]) => h("button", { class: "seg", dataset: { v }, onclick: () => { sort = v; draw(); } }, label)));
    const dayKey = (t) => { const d = new Date(t || 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const dayName = (k) => { const today = dayKey(Date.now()); const yday = dayKey(Date.now() - 86400000); if (k === today) return "Today"; if (k === yday) return "Yesterday"; const d = new Date(k + "T12:00:00"); return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); };
    const clock = (t) => new Date(t || 0).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const clear = h("span");
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); if (tab && !tab.path) drawStart(); };
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".menu") && document.querySelectorAll(".dlg-back").length === 1) { e.preventDefault(); e.stopPropagation(); close(); } };
    const rowMenu = (e, x) => {
      e.preventDefault();
      const host = hostOf(x.url);
      menu(e.clientX, e.clientY, [
        { header: host },
        { label: "Open", icon: "globe", run: () => { close(); if (tab) open(x.url); else api.newTab(x.url); } },
        { label: "Open in a new tab", icon: "plus", run: () => { close(); api.newTab(x.url); } },
        { label: "Copy the address", icon: "link", run: () => navigator.clipboard.writeText(x.url).then(() => toast("Address copied", { ms: 1600 })) },
        isMarked(x.url) ? null : { label: "Bookmark it", icon: "star", run: () => { saveMarks([...marks(), { url: x.url, title: x.title || host, group: markInto(S) }]); toast("Bookmarked", { ms: 1600 }); } },
        "sep",
      ].filter(Boolean));
    };
    const row = (x, sub) => h("div", { class: "trash-row wt-hist-row", oncontextmenu: (e) => rowMenu(e, x) },
      siteIcon(hostOf(x.url), "wt-fav is-small", () => icon(mode === "history" ? "clock" : x.pinned ? "pin" : "star")),
      h("button", { class: "trash-main wt-lib-open", onclick: () => { close(); if (tab) open(x.url); else api.newTab(x.url); } },
        h("div", { class: "trash-name", text: x.title || hostOf(x.url) }),
        h("div", { class: "trash-meta", text: sub })),
      mode === "bookmarks" ? h("button", { class: "icon-btn", title: x.pinned ? "Take it out of the buttons row" : "Show it among the start page buttons", onclick: () => { saveMarks(marks().map((b) => (b.url === x.url ? { ...b, pinned: !b.pinned } : b))); draw(); } }, icon("pin")) : h("span", { class: "wt-hist-when", text: clock(x.at) }),
      h("button", { class: "icon-btn", title: "Open in a new tab", onclick: () => { close(); api.newTab(x.url); } }, icon("plus")),
      h("button", { class: "icon-btn is-danger", title: "Remove", onclick: () => removeMark(x.url, draw) }, icon("x")));
    function draw() {
      for (const b of seg.children) b.classList.toggle("is-active", b.dataset.v === mode);
      for (const b of sortSeg.children) b.classList.toggle("is-active", b.dataset.v === sort);
      sortSeg.hidden = mode !== "history";
      clear.hidden = true;
      const src = marks().filter((x) => !q || (x.title || "").toLowerCase().includes(q) || x.url.toLowerCase().includes(q));
      if (!src.length) { list.replaceChildren(h("div", { class: "trash-none" }, icon(mode === "history" ? "clock" : "star"), h("div", { text: q ? "Nothing matches" : mode === "history" ? "No history" : "No bookmarks yet" }))); return; }
      list.replaceChildren(...src.slice(0, 300).map((x) => row(x, x.url)), ...(src.length > 300 ? [h("div", { class: "trash-none", text: `The first 300 of ${src.length} - type to find the rest` })] : []));
    }
    find.addEventListener("input", () => { q = find.value.trim().toLowerCase(); draw(); });
    find.addEventListener("keydown", (e) => e.stopPropagation());
    const box = h("div", { class: "dlg dlg-trashbin wt-lib", role: "dialog", "aria-modal": "true" },
      h("div", { class: "dlg-head" }, seg, h("span", { class: "trash-sum" }), h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
      h("div", { class: "trash-bar" }, find, sortSeg, h("span", { class: "trash-gap" }), clear),
      list);
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => { back.classList.add("is-in"); find.focus(); });
    draw();
  }

  document.addEventListener("fullscreenchange", () => place(true));
  const NET_FAIL = {
    1: "its certificate is for another name", 2: "its certificate has run out", 4: "its certificate was withdrawn", 5: "its certificate is not valid",
    // not 9 (connection aborted): WebView2 says that of a load cut short by the next one - a page that moves itself on
    // as it loads (Google's store does) - and closing the page then left a "failure" that came back on every retry
    6: "the server does not answer", 7: "it took too long to answer", 10: "the connection was reset",
    11: "this computer is offline", 12: "the connection was refused - a firewall, a VPN or the site itself", 13: "the name does not lead anywhere (no internet, or a typo)",
  };
  function stop(wid, why) {
    stopped.set(wid, why);
    shown.delete(wid);
    const i = live.indexOf(wid);
    if (i >= 0) live.splice(i, 1);
    if (tab && tab.wid === wid) { up = false; rectKey = ""; }
    if (app.host.real) app.host.tabWebClose([wid]).catch(() => {});
    place(true);
  }
  const pageName = (wid) => { const t = api.findTab(wid); return t ? tabTitle(t) : "A page"; };
  // every half minute (a page fills up over minutes; each look asks the browser for its every process): what each page holds. Past the limit (Settings › Browser) it is said once, and again only if it keeps growing
  // it runs only while a page is loaded: started when one is, stopped when the last one goes
  let memTimer = 0;
  function memWatch() {
    if (!app.host.real || memTimer || !live.length || !(Number(app.settings.webMemWarnGB) > 0)) return;
    memTimer = setInterval(memCheck, 30000);
  }
  async function memCheck() {
    const limit = (Number(app.settings.webMemWarnGB) || 0) * 1024 ** 3;
    if (!limit || !live.length) { clearInterval(memTimer); memTimer = 0; return; }
    if (document.hidden) return; // in the tray: looked at again once the window is back
    for (const wid of [...live]) {
      const mem = await app.host.tabWebMemory(wid).catch(() => null);
      if (!(mem > limit) || mem < (warnedAt.get(wid) || 0) * 1.5 || !live.includes(wid)) continue;
      warnedAt.set(wid, mem);
      app.toast(`${pageName(wid)} is using ${fmtSize(mem)} - enough to bring Leonote down with it`, { ms: 20000, kind: "error", action: { label: "Stop the page", run: () => stop(wid, `Stopped while using ${fmtSize(mem)}, before it could take Leonote down.`) } });
    }
  }
  app.bus.on("settings", (k) => { if (k === "webMemWarnGB") memWatch(); });
  app.host.on("tabweb:failed", (p) => {
    if (!p || !live.includes(p.id)) return;
    if (p.kind === "nav") {
      loading.delete(p.id);
      if (tab && tab.wid === p.id) paintBar();
      // only the network's own failures: a server's 404 page, a download or a cancelled load are not
      const why = NET_FAIL[p.status];
      if (why) stop(p.id, `Could not reach ${hostOf((api.findTab(p.id) || {}).path || "") || "the page"}: ${why}`);
      return;
    }
    if (p.kind === "unresponsive") app.toast(`${pageName(p.id)} is not answering`, { ms: 20000, kind: "error", action: { label: "Stop the page", run: () => stop(p.id, "Stopped: the page had stopped answering.") } });
    else stop(p.id, "The page crashed - Leonote is fine.");
  });

  function paint() {
    if (!tab) return;
    const blank = !tab.path;
    srcBtn.hidden = !(app.vaultPathOfUrl && app.vaultPathOfUrl(tab.path));
    // the start page coming up (not redrawn in place): its parts come in one after another
    if (blank && start.hidden) { start.classList.remove("is-arriving"); void start.offsetWidth; start.classList.add("is-arriving"); clearTimeout(start._arrive); start._arrive = setTimeout(() => start.classList.remove("is-arriving"), 900); }
    start.hidden = !blank;
    slot.hidden = blank;
    paintBar();
    if (blank) { drawStart(); if (up) { up = false; rectKey = ""; app.host.real && app.host.tabWebHide(undefined, sleepSecs(), awakeMax()).catch(() => {}); } }
    place(true);
    kick();
  }

  return {
    // the page takes the keys a moment after its tab is chosen: the click that chose it lands in the app first, so the keys would come back here otherwise
    show(t) {
      tab = t; paint();
      if (!(t && t.path && app.host.real)) return;
      // twice: the click that chose the tab may still be settling when the first one lands
      const give = () => { if (tab === t && !(document.activeElement && el.contains(document.activeElement) && document.activeElement.matches("input, textarea"))) app.host.tabWebFocus(t.wid).catch(() => {}); };
      setTimeout(give, 120); setTimeout(give, 420); setTimeout(give, 900);
    },
    /** Another kind of tab is up: the native view goes out of sight, nothing is lost. */
    leave() { const w = tab ? tab.wid : undefined; tab = null; if (up) { up = false; rectKey = ""; } if (app.host.real) app.host.tabWebHide(w, sleepSecs(), awakeMax()).catch(() => {}); },
    /** Tabs were closed: native views of tabs that are gone are closed too. */
    reconcile(wids) { if (!app.host.real) return; for (const w of [...shown.keys()]) if (!wids.includes(w)) { shown.delete(w); const i = live.indexOf(w); if (i >= 0) live.splice(i, 1); } app.host.tabWebClose(wids, true).catch(() => {}); },
    focusAddress() { if (tab && tab.path) addr.focus(); else { const b = start.querySelector(".wt-q"); if (b) b.focus(); } },
    /** Whether this tab has a native view up (loaded, awake or asleep). */
    isLive(wid) { return live.includes(wid); },
    /** The page stopped outright, even the one in view: its view closed, a note and a button in its place. */
    stop,
    /** The native view let go of: its memory comes back, the page loads again when the tab comes up. */
    unload(wid) { if (tab && tab.wid === wid) return; shown.delete(wid); const i = live.indexOf(wid); if (i >= 0) live.splice(i, 1); if (app.host.real) app.host.tabWebClose([wid]).catch(() => {}); },
    library,
  };
}
