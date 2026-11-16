// Browser add-ons for the tabs' pages: what WebView2 has loaded into the
// profile every tab shares. One panel, shown in Settings and as a popup from
// the browser's menus. An add-on comes from the Chrome Web Store or Edge
// Add-ons (a link or an id: the store's own download of the .crx), from a
// maker's GitHub release, or from a folder or file of your own.
import { h } from "./util.js";
import { icon } from "./icons.js";
import { toast, menu, closeMenu, confirmDialog, askDialog, sortable } from "./ui.js";

// installed from the Chrome Web Store, as a browser would (its listing and updates); `mine`: made by Leonote's maker
export const ADDONS = [
  { name: "Privacy Badger", note: "EFF's tracker blocker (GPLv3), from the Chrome Web Store.", store: "pkehgijcmpdhfbdbbnkijodmdjhbjlgp" },
  { name: "Kitsumi", note: "Made by Leonote's maker. From the Chrome Web Store.", store: "ciiembegoahhehnfdkbanhioobokjdkd", mine: true },
];
const addonSource = (a) => a.store ? storeCrx(a.store).url : a.source;

/** The store an address or an id points at, and the .crx download the store itself serves. */
export function storeCrx(text) {
  const t = String(text || "").trim();
  let id = null;
  let store = "";
  // the store's own host, not its name anywhere in the address (https://evil.example/?chromewebstore.google.com/detail/...)
  let at = "";
  try { const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : "https://" + t); at = /^https?:$/.test(u.protocol) ? u.hostname + u.pathname : ""; } catch {}
  const cws = /^chromewebstore\.google\.com\/detail\/(?:[^/]+\/)?([a-p]{32})/.exec(at) || /^chrome\.google\.com\/webstore\/detail\/(?:[^/]+\/)?([a-p]{32})/.exec(at);
  const edge = /^microsoftedge\.microsoft\.com\/addons\/detail\/(?:[^/]+\/)?([a-z]{32})/.exec(at);
  if (cws) { id = cws[1]; store = "chrome"; }
  else if (edge) { id = edge[1]; store = "edge"; }
  else if (/^[a-p]{32}$/.test(t)) { id = t; store = "chrome"; }
  if (!id) return null;
  const url = store === "edge"
    ? `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3D${id}%26installsource%3Dondemand%26uc`
    : `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
  return { id, store, url };
}

/** Asked before a store page's add-on goes in: it works on every site it asks for from then on. */

/** Newer versions of the add-ons from a store or a GitHub release, put in place - their settings and sign-ins stay.
 *  `quiet`: says something only when an add-on was updated or held back (the daily look: no word when offline). */
export async function updateAddons(app, { quiet = false } = {}) {
  if (!app.host.real || !app.host.webExtUpdate) return null;
  let r;
  try {
    const have = await app.host.webExtList();
    r = await app.host.webExtUpdate(have.map((x) => x.id), ADDONS.filter((a) => a.source).map((a) => a.source));
  } catch (e) { if (!quiet) toast("Could not look for updates: " + e, { kind: "error", ms: 6000 }); return null; }
  app.setSetting("webExtCheckedAt", Date.now());
  const up = r.updated || [], bad = r.failed || [];
  if (up.length) {
    app.bus.emit("addons");
    toast(`Updated ${up.map((x) => `${x.name} to ${x.to}`).join(", ")} - fully in use after a restart`, { ms: 10000, action: { label: "Restart", run: () => app.host.restart() } });
  }
  const say = quiet ? bad.filter((x) => !/^Could not download/.test(x.error)) : bad;
  if (say.length) toast(`Could not update ${say.map((x) => x.name).join(", ")}: ${say[0].error}`, { kind: "error", ms: 10000 });
  else if (!quiet && !up.length) toast("Every add-on is up to date", { ms: 5000 });
  return r;
}

/** An add-on's icon: the one you set, else its own, else a puzzle piece. */
export const iconOf = (app, x) => {
  const own = (app.settings.webExtIcons || {})[x.id];
  const src = own || x.icon;
  return src ? h("img", { class: "set-addon-ico", src, alt: "" }) : h("span", { class: "set-addon-ico is-blank" }, icon("puzzle"));
};
/** Pick a picture for an add-on's icon (the browser's own file box); `clear` puts its own back. */
export function setIcon(app, id, clear = false) {
  const icons = { ...(app.settings.webExtIcons || {}) };
  if (clear) { delete icons[id]; app.setSetting("webExtIcons", icons); app.bus.emit("addons"); return; }
  const inp = h("input", { type: "file", accept: "image/*", style: { display: "none" } });
  inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0];
    inp.remove();
    if (!f) return;
    if (f.size > 300000) return toast("Pick a smaller picture (under 300 KB)", { kind: "error" });
    const rd = new FileReader();
    rd.onload = () => { icons[id] = String(rd.result); app.setSetting("webExtIcons", icons); app.bus.emit("addons"); };
    rd.readAsDataURL(f);
  });
  document.body.append(inp);
  inp.click();
}
/** The sites an add-on may read and change: null = every site it asks for, a list = only those. */
export async function setAddonSites(app, x, sites) {
  try {
    const kept = await app.host.webExtSites(x.id, sites);
    toast(kept ? `${x.name} works on ${kept.length ? kept.join(", ") : "no site"} - reload a page that is open` : `${x.name} works on every site it asks for`, { ms: 3500 });
  } catch (e) { toast(String(e), { kind: "error" }); }
  app.bus.emit("addons");
}
/** The sites, as typed: one line of them, separated by commas or spaces. */
async function chooseSites(app, x) {
  const r = await askDialog(`Sites for ${x.name}`, [{ key: "s", label: "Sites, separated by commas", value: (x.sites || []).join(", "), placeholder: "youtube.com, github.com" }],
    { ok: "Save", text: "It can read and change only these sites and their subdomains. Empty: no site - pressing its button on a page then asks to let it work there." });
  if (r) await setAddonSites(app, x, r.s.split(/[\s,]+/).filter(Boolean));
}
const siteOf = (u) => { try { return /^https?:/.test(u) ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };

/** The add-on's own menu: options, the icon, on the bar or not, off, remove. */
export function addonMenu(app, x, at, after) {
  const pinned = new Set(app.settings.webExtPinned || []);
  const done = () => { app.bus.emit("addons"); if (after) after(); };
  menu(at.x, at.y, [
    { header: x.name + (x.version ? " " + x.version : "") },
    x.options ? { label: "Options", icon: "settings", run: () => app.newWebTab(`chrome-extension://${x.id}/${x.options}`) } : null,
    x.popup ? { label: "Its panel", icon: "layers", run: () => app.newWebTab(`chrome-extension://${x.id}/${x.popup}`) } : null,
    { label: "Manage extensions", icon: "puzzle", run: () => app.openSettingsAt("Browser add-ons") },
    x.homepage ? { label: "Its home page", icon: "globe", run: () => app.newWebTab(x.homepage) } : null,
    { label: pinned.has(x.id) ? "Unpin from the bar" : "Pin to the bar", icon: "pin", run: () => { pinned.has(x.id) ? pinned.delete(x.id) : pinned.add(x.id); app.setSetting("webExtPinned", [...pinned]); done(); } },
    { label: "Set an icon…", icon: "image", run: () => setIcon(app, x.id) },
    (app.settings.webExtIcons || {})[x.id] ? { label: "Its own icon again", icon: "undo", run: () => setIcon(app, x.id, true) } : null,
    { label: "Works on", icon: "globe", sub: [
      { label: "Every site it asks for", checked: !x.sites, run: () => setAddonSites(app, x, null).then(() => after && after()) },
      { label: x.sites ? `Only ${x.sites.length ? x.sites.join(", ") : "no site"}…` : "Only sites I choose…", checked: !!x.sites, run: () => chooseSites(app, x).then(() => after && after()) },
    ] },
    "sep",
    { label: x.enabled ? "Turn off" : "Turn on", icon: "bolt", run: async () => { try { await app.host.webExtSet(x.id, !x.enabled); } catch (e) { toast(String(e), { kind: "error" }); } done(); } },
    { label: "Remove…", icon: "trash", danger: true, run: async () => { if (!(await confirmDialog(`Remove ${x.name}?`, "It is taken out of the browser. Nothing else changes.", { ok: "Remove" }))) return; try { await app.host.webExtRemove(x.id); } catch (e) { toast(String(e), { kind: "error" }); } done(); } },
  ]);
}

/** The panel: installed add-ons with on/off and remove, the store field, the known ones, your own. */
export function addonsPanel(app, { onDone } = {}) {
  const list = h("div", { class: "set-addons" });
  const busy = (on, what) => { list.classList.toggle("is-busy", on); if (on) list.dataset.busy = what || ""; };
  const paint = async () => {
    let have = [];
    try { have = await app.host.webExtList(); } catch (e) { list.replaceChildren(h("div", { class: "set-note", text: String(e) })); return; }
    list.replaceChildren(
      ...have.map((x) => h("div", { class: "set-addon" + (x.enabled ? "" : " is-off") },
        h("button", { class: "wt-ext-icobtn", title: "Set an icon for it", onclick: () => setIcon(app, x.id) }, iconOf(app, x)),
        h("div", { class: "set-addon-text" },
          h("div", { class: "set-addon-name" }, h("span", { text: x.name || x.id }), x.version ? h("span", { class: "set-addon-ver", text: x.version }) : null),
          x.description ? h("div", { class: "set-addon-desc", text: x.description }) : null),
        x.options ? h("button", { class: "btn btn-sm", title: "The add-on's own settings page", onclick: () => { if (app.newWebTab) app.newWebTab(`chrome-extension://${x.id}/${x.options}`); if (onDone) onDone(); } }, "Options") : null,
        h("label", { class: "set-addon-on", title: x.enabled ? "On - press to turn it off" : "Off - press to turn it on" }, h("input", { type: "checkbox", checked: !!x.enabled, onchange: async (e) => { try { await app.host.webExtSet(x.id, e.target.checked); } catch (err) { toast(String(err), { kind: "error" }); } app.bus.emit("addons"); paint(); } }), x.enabled ? "On" : "Off"),
        h("button", { class: "icon-btn", title: "More: icon, home page, remove…", onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); addonMenu(app, x, { x: r.right - 220, y: r.bottom + 4 }, paint); } }, icon("more")))),
      have.length ? null : h("div", { class: "set-note", text: "No add-ons yet." }));
  };
  const install = async (source, name) => {
    busy(true, `Getting ${name}…`);
    try { const r = await app.host.webExtInstall(source); toast(`${(r && r.name) || name} is on - it works in the tabs' pages from now`, { ms: 4000 }); app.bus.emit("addons"); if (onDone) onDone(r); }
    catch (e) { toast(String(e), { kind: "error", ms: 8000 }); }
    busy(false);
    paint();
  };
  // a link from the Chrome Web Store or Edge Add-ons, or an add-on's id
  const store = h("input", { class: "text-input is-wide", placeholder: "Search the Chrome Web Store - or paste an add-on's link or id to install it", spellcheck: "false" });
  const fromStore = () => {
    const q = store.value.trim();
    if (!q) return;
    const s = storeCrx(q);
    store.value = "";
    if (s) return install(s.url, s.store === "edge" ? "the Edge add-on" : "the Chrome add-on");
    if (app.newWebTab) { app.newWebTab("https://chromewebstore.google.com/search/" + encodeURIComponent(q)); if (onDone) onDone(); }
  };
  store.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") fromStore(); });
  paint();
  const checkBtn = h("button", { class: "btn btn-sm", title: "Add-ons from the Chrome Web Store, Edge Add-ons or a GitHub release; a folder or file of your own is yours to update", onclick: async () => {
    checkBtn.disabled = true;
    busy(true, "Looking for newer versions…");
    await updateAddons(app);
    busy(false);
    checkBtn.disabled = false;
    paint();
  } }, icon("rotateRight"), "Check for updates");
  const auto = h("input", { type: "checkbox", checked: app.settings.webExtAutoUpdate === true, onchange: (e) => app.setSetting("webExtAutoUpdate", e.target.checked) });
  return h("div", { class: "addons" },
    list,
    h("div", { class: "set-btns" }, checkBtn, h("label", { class: "set-addon-on", title: "Looked at once a day, a minute after Leonote starts" }, auto, "Update them by themselves")),
    h("div", { class: "addons-store" }, icon("search"), store, h("button", { class: "btn btn-sm", onclick: fromStore }, "Go")),
    h("div", { class: "set-note", text: "Edge's add-ons are Chrome's too. On an add-on's store page, press Install in the address bar - the store's own Add button cannot finish inside Leonote." }),
    h("div", { class: "set-btns" },
      app.newWebTab ? h("button", { class: "btn btn-sm", onclick: () => { app.newWebTab("https://chromewebstore.google.com/"); if (onDone) onDone(); } }, icon("globe"), "Chrome Web Store") : null,
      app.newWebTab ? h("button", { class: "btn btn-sm", onclick: () => { app.newWebTab("https://microsoftedge.microsoft.com/addons/"); if (onDone) onDone(); } }, icon("globe"), "Edge Add-ons") : null),
    h("div", { class: "set-btns" },
      ...ADDONS.map((a) => h("button", { class: "btn btn-sm", title: a.note, onclick: () => install(addonSource(a), a.name) }, icon("download"), `Get ${a.name}`)),
      h("button", { class: "btn btn-sm", title: "An unpacked add-on: a folder with a manifest.json in it", onclick: async () => { const p = await app.host.dialogOpen({ title: "The add-on's folder", directory: true, multiple: false }); if (p) install(p, "the add-on"); } }, icon("folder"), "From a folder…"),
      h("button", { class: "btn btn-sm", title: "A packed add-on: .zip or .crx", onclick: async () => { const p = await app.host.dialogOpen({ title: "The add-on's file", multiple: false, directory: false, filters: [{ name: "Add-on", extensions: ["zip", "crx"] }] }); if (p) install(p, "the add-on"); } }, icon("file"), "From a file…")));
}

/** The panel as a popup, closed by Esc, the ✕ or a click outside. */
export function openAddons(app) {
  document.querySelector(".addons-back")?.remove();
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const box = h("div", { class: "dlg addons-dlg", role: "dialog", "aria-modal": "true" },
    h("div", { class: "addons-head" }, h("h3", { class: "dlg-title", text: "Browser add-ons" }), h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
    h("p", { class: "dlg-text", text: "Extensions for the pages in your tabs, loaded by WebView2 into the profile every tab shares. They stay across restarts; a page already open may need a reload." }),
    app.host.real ? addonsPanel(app, { onDone: close }) : h("div", { class: "set-note", text: "Add-ons need the Leonote app." }));
  const back = h("div", { class: "dlg-back addons-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(back);
  requestAnimationFrame(() => back.classList.add("is-in"));
}

/**
 * The add-ons' buttons for the browser's bar: one per add-on that is on,
 * its icon, its popup opened in a small view of its own (what the browsers
 * show when the icon is pressed). Returns the element; it repaints itself.
 */
export function addonButtons(app, pageUrl = () => "") {
  const el = h("div", { class: "wt-exts" });
  let scaleFactor = window.devicePixelRatio || 1;
  if (app.host.real && app.host.win && app.host.win.scaleFactor) app.host.win.scaleFactor().then((f) => { scaleFactor = f || scaleFactor; }).catch(() => {});
  let popOpen = false;
  let have = [];
  const hidePop = () => { if (!popOpen) return; popOpen = false; resizer = null; el.classList.remove("has-pop"); app._extPop = null; app.bus.emit("extpop"); if (el._frame) { el._frame.remove(); el._frame = null; } app.host.extPopHide().catch(() => {}); document.removeEventListener("mousedown", onDown, true); };
  const onDown = (e) => { if (!e.target.closest(".wt-ext")) hidePop(); };
  // the grip is in the popup's own page (webwin.rs draws it there); it posts how far it was dragged, in screen px
  let resizer = null;
  app.bus.on("extpop:resize", (p) => { if (resizer && p && p.d) resizer(p.d); });
  const showPop = (x, r) => {
    if (popOpen) hidePop();
    const z = (window.devicePixelRatio || 1) / scaleFactor;
    const want = app.settings.webExtPopSize && app.settings.webExtPopSize.w ? app.settings.webExtPopSize : { w: Math.min(1000, Math.round(innerWidth * 0.6)), h: innerHeight };
    const PAD = 2; // the frame's band around the view: a hairline, as the browsers draw it
    const place = (w, hh) => {
      const rect = { x: Math.max(PAD + 4, Math.min(r.right - w, innerWidth - w - PAD - 4)), y: r.bottom + 6, w, h: Math.min(hh, innerHeight - r.bottom - 30 - PAD) };
      app._extPop = rect;
      app.bus.emit("extpop");
      Object.assign(frame.style, { left: rect.x - PAD + "px", top: rect.y - PAD + "px", width: rect.w + 2 * PAD + "px", height: rect.h + 2 * PAD + "px" });
      return app.host.extPopShow(`chrome-extension://${x.id}/${x.popup}`, { x: Math.round(rect.x * z), y: Math.round(rect.y * z), w: Math.round(rect.w * z), h: Math.round(rect.h * z) }, (Number(app.settings.webExtPopZoom) || 80) / 100);
    };
    popOpen = true;
    el.classList.add("has-pop");
    // a frame drawn around the native view (which cannot carry one itself). The grip at its bottom-right corner is
    // the page's own: dragged right the popup grows wider (it hangs from its icon, so it reaches further left), dragged down taller
    const frame = h("div", { class: "wt-extpop-frame" });
    let start = null, last = null;
    resizer = (d) => {
      if (d === "done") { if (last) app.setSetting("webExtPopSize", { w: Math.round(last.w), h: Math.round(last.h) }); start = last = null; return; }
      const [dx, dy] = d.split(",").map(Number);
      if (!start) start = { w: app._extPop.w, h: app._extPop.h };
      last = { w: Math.max(260, start.w + dx / z), h: Math.max(200, start.h + dy / z) };
      place(last.w, last.h).catch(() => {});
    };
    document.getElementById("overlay-root").append(frame);
    el._frame = frame;
    place(want.w, want.h).catch((err) => { popOpen = false; resizer = null; frame.remove(); toast(String(err), { kind: "error" }); });
    setTimeout(() => document.addEventListener("mousedown", onDown, true));
  };
  let popFor = null;
  const act = async (x, r) => {
    // kept to some sites, and this one is not among them: asked first, as the browsers do "on click"
    const here = siteOf(pageUrl() || "");
    if (x.sites && here && !x.sites.some((s) => here === s || here.endsWith("." + s))) {
      if (!(await confirmDialog(`Let ${x.name} work on ${here}?`, `It can then read and change the pages of ${here}. Reload the page for it to start there.`, { ok: "Allow", danger: false }))) return;
      await setAddonSites(app, x, [...x.sites, here]);
      x.sites = [...x.sites, here];
    }
    if (x.popup) { if (popOpen && popFor === x.id) return hidePop(); popFor = x.id; showPop(x, r); } else if (x.options) app.newWebTab(`chrome-extension://${x.id}/${x.options}`);
  };
  // the popup's view lost the keys to a click somewhere else (the page, say): it goes - a moment later, so a click on its own icon still toggles
  // the page's view was clicked: the popup goes (the app's own surfaces are watched by onDown)
  app.bus.on("extpop:blur", () => { if (popOpen) hidePop(); });
  // the list under the puzzle piece: every add-on that is on, as the browsers show it
  const list = (btn0) => {
    document.querySelector(".wt-ext-pop")?.remove();
    // the bar repaints its buttons: the live puzzle piece is the anchor, not the one this was called with
    const btn = (el.querySelector(".wt-ext-all") && el.querySelector(".wt-ext-all").isConnected) ? el.querySelector(".wt-ext-all") : btn0;
    const r = btn.getBoundingClientRect();
    const on = have.filter((x) => x.enabled);
    const off = have.filter((x) => !x.enabled);
    const pinnedIds = new Set(app.settings.webExtPinned || []);
    const close = () => { pop.remove(); document.removeEventListener("mousedown", offDown, true); document.removeEventListener("keydown", onKey, true); };
    const offDown = (e) => { if (!pop.contains(e.target) && !e.target.closest(".menu")) close(); };
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".menu")) { e.stopPropagation(); close(); } };
    const row = (x) => h("div", { class: "wt-ext-row" + (x.enabled ? "" : " is-off"),
      onclick: (e) => { if (e.target.closest("button, .set-addon-ico")) return; close(); act(x, r); },
      oncontextmenu: (e) => { e.preventDefault(); hidePop(); addonMenu(app, x, { x: e.clientX, y: e.clientY }, () => list(btn)); } },
      h("button", { class: "wt-ext-icobtn", title: "Set an icon for it", onclick: () => setIcon(app, x.id) }, iconOf(app, x)),
      h("div", { class: "wt-ext-text" }, h("div", { class: "wt-ext-name", text: x.name }), h("div", { class: "wt-ext-sub", text: !x.enabled ? "Off" : x.popup ? "Press for its panel" : x.options ? "Press for its options" : x.version || "" })),
      h("button", { class: "icon-btn" + (pinnedIds.has(x.id) ? " is-on" : ""), title: pinnedIds.has(x.id) ? "Unpin from the bar" : "Pin to the bar", onclick: () => { const p = new Set(app.settings.webExtPinned || []); p.has(x.id) ? p.delete(x.id) : p.add(x.id); app.setSetting("webExtPinned", [...p]); app.bus.emit("addons"); list(btn); } }, icon("pin")),
      h("button", { class: "icon-btn", title: "More", onclick: (e) => { const b = e.currentTarget.getBoundingClientRect(); addonMenu(app, x, { x: b.right - 220, y: b.bottom + 4 }, () => list(btn)); } }, icon("more")));
    const pop = h("div", { class: "wt-ext-pop" },
      h("div", { class: "wt-ext-head", text: "Extensions" }),
      ...on.map(row),
      off.length ? h("div", { class: "wt-ext-head is-sub", text: "Off" }) : null,
      ...off.map(row),
      have.length ? null : h("div", { class: "wt-ext-sub", style: { padding: "6px 10px" }, text: "No add-ons yet." }),
      h("div", { class: "wt-ext-foot" },
        h("button", { class: "wt-ext-manage", onclick: () => { close(); openAddons(app); } }, icon("puzzle"), "Add add-ons…"),
        h("button", { class: "wt-ext-manage", onclick: () => { close(); app.openSettingsAt("Browser add-ons"); } }, icon("settings"), "Manage extensions"),
        have.length ? h("button", { class: "wt-ext-manage", title: "Looks for a newer version of each add-on now", onclick: () => { close(); toast("Looking for add-on updates…", { ms: 2000 }); updateAddons(app); } }, icon("rotateRight"), "Check for updates") : null));
    document.getElementById("overlay-root").append(pop);
    pop.style.left = Math.max(8, Math.min(r.right - 320, innerWidth - 328)) + "px";
    pop.style.top = (r.bottom + 6) + "px";
    setTimeout(() => { document.addEventListener("mousedown", offDown, true); document.addEventListener("keydown", onKey, true); });
  };
  const paint = async () => {
    try { have = await app.host.webExtList(); } catch { have = []; }
    // pinned ones on the bar, in your order; the rest wait under the puzzle piece
    const pinned = new Set(app.settings.webExtPinned || []);
    const order = app.settings.webExtOrder || [];
    const out = have.filter((x) => x.enabled && pinned.has(x.id)).sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
    el.replaceChildren(
      ...out.map((x) => h("button", { class: "icon-btn wt-ext", title: x.name + " · right-click for more · drag to move", draggable: true, dataset: { id: x.id },
        onclick: (e) => act(x, e.currentTarget.getBoundingClientRect()),
        oncontextmenu: (e) => { e.preventDefault(); hidePop(); addonMenu(app, x, { x: e.clientX, y: e.clientY }); } },
        iconOf(app, x))),
      h("button", { class: "icon-btn wt-ext wt-ext-all", title: "Extensions · right-click for more", onclick: (e) => list(e.currentTarget),
        oncontextmenu: (e) => { e.preventDefault(); hidePop(); const pinned = new Set(app.settings.webExtPinned || []); menu(e.clientX, e.clientY, [
          { header: "Extensions" },
          { label: "Add add-ons…", icon: "puzzle", run: () => openAddons(app) },
          { label: "Manage extensions", icon: "settings", run: () => app.openSettingsAt("Browser add-ons") },
          have.length ? { label: "Check for updates", icon: "rotateRight", run: () => { toast("Looking for add-on updates…", { ms: 2000 }); updateAddons(app); } } : null,
          "sep",
          { label: "Pin every add-on to the bar", icon: "pin", run: () => { app.setSetting("webExtPinned", have.filter((x) => x.enabled).map((x) => x.id)); app.bus.emit("addons"); } },
          pinned.size ? { label: "Unpin them all", icon: "x", run: () => { app.setSetting("webExtPinned", []); app.bus.emit("addons"); } } : null,
          "sep",
          { label: "Chrome Web Store", icon: "globe", run: () => app.newWebTab("https://chromewebstore.google.com/") },
          { label: "Edge Add-ons", icon: "globe", run: () => app.newWebTab("https://microsoftedge.microsoft.com/addons/") },
        ].filter(Boolean)); } }, icon("puzzle")));
  };
  sortable(el, { axis: "x", item: ".wt-ext:not(.wt-ext-all)", onMove: (i, j) => { const ids = [...el.querySelectorAll(".wt-ext[data-id]")].map((b) => b.dataset.id); const [m] = ids.splice(i, 1); ids.splice(j, 0, m); app.setSetting("webExtOrder", ids); paint(); } });
  el.hidePop = hidePop;
  app.bus.on("addons", paint);
  paint();
  return el;
}
