// Passwords behind a master password (pw.rs keeps them encrypted, and unlocked only in memory).
// The list never holds a password: one is asked for when it is shown or copied. Closing locks it.
import { h } from "./util.js";
import { icon } from "./icons.js";
import { confirmDialog, menu } from "./ui.js";

/** onUnlock: only the master password is asked, then the dialog closes (unlocked) and this runs. */
export async function openPasswords(app, { onUnlock } = {}) {
  const host = app.host;
  let items = [];
  let q = "";
  const body = h("div", { class: "pw-body" });
  const close = () => { host.pwLock().catch(() => {}); back.remove(); document.removeEventListener("keydown", onKey, true); app.focusMain(); };
  const box = h("div", { class: "dlg pw", role: "dialog", "aria-modal": "true" },
    h("div", { class: "pw-head" }, icon("shield"), h("h3", { class: "dlg-title", text: "Passwords" }), h("button", { class: "icon-btn", title: "Lock and close (Esc)", onclick: close }, icon("x"))), body);
  const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
  // the app's keys stop here (capture), so each screen's Enter / Esc is handled here too
  let keys = { Escape: close };
  const onKey = (e) => { const open = document.querySelectorAll(".dlg-back"); if (!back.isConnected || open[open.length - 1] !== back || document.querySelector(".menu")) return; e.stopPropagation(); if (e.key === "Enter" && e.target.tagName === "BUTTON") return; const k = keys[e.key]; if (k && !e.shiftKey) { e.preventDefault(); k(); } };
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(back);
  requestAnimationFrame(() => back.classList.add("is-in"));

  // any call made after the five idle minutes finds it locked: back to the master password
  const call = (p) => p.catch((e) => { if (String(e).includes("locked")) unlockForm(true); else app.toast(String(e), { kind: "error" }); throw e; });

  async function unlockForm(timedOut = false) {
    const st = await host.pwStatus();
    // not type=password: the browser engine underneath would offer to save the master password, or fill in
    // one it saved for a website - a text box drawn as dots is one it leaves alone
    const secret = (placeholder) => h("input", { class: "dlg-input pw-secret", type: "text", placeholder, autocomplete: "off", spellcheck: false, "data-lpignore": "true", name: "lnm-" + Math.random().toString(36).slice(2), oncopy: (e) => e.preventDefault(), oncut: (e) => e.preventDefault() });
    const a = secret("Master password");
    const b = st.exists ? null : secret("The same again");
    const err = h("p", { class: "pw-err" });
    const go = async () => {
      if (b && a.value !== b.value) { err.textContent = "The two do not match"; return; }
      err.textContent = st.exists ? "Opening…" : "Making the vault…";
      try { opened(await host.pwUnlock(a.value)); }
      catch (e) { err.textContent = String(e) === "wrong password" ? "Wrong master password" : String(e); a.select(); }
    };
    const opened = (list0) => { items = list0; if (onUnlock) { back.remove(); document.removeEventListener("keydown", onKey, true); onUnlock(); } else list(); };
    // a forgotten master password: the old vault is put aside, never deleted - remembered later, it still opens it
    const forgot = async () => {
      if (!(await confirmDialog("Start a new vault?", "Without the master password nobody can open the saved passwords - not Leonote, not anyone. The old vault is kept as a file beside the new one (in .leonote, \"passwords forgotten <date>.age\"): if the password comes back to you, it still opens it. The new vault starts empty; the sites themselves let you reset a password with their own \"Forgot password\" link.", { ok: "Start a new vault" }))) return;
      try { const kept = await host.pwReset(); if (kept) app.toast("The old vault is kept: " + kept, { ms: 8000 }); unlockForm(); } catch (e) { err.textContent = String(e); }
    };
    keys = { Escape: close, Enter: go };
    body.replaceChildren(
      h("p", { class: "dlg-text", text: timedOut ? "Locked after five idle minutes." : st.exists ? "Enter the master password to see them." : "Choose a master password of 12 characters or more (a short sentence works). It is never saved: forget it and these passwords cannot be brought back - by you or anyone." }),
      a, b || "", err,
      h("div", { class: "dlg-btns" },
        st.exists ? h("button", { class: "link-btn pw-forgot", onclick: forgot }, "Forgot it?") : null,
        h("button", { class: "btn btn-primary", onclick: go }, icon("lock"), st.exists ? "Unlock" : "Make the vault")));
    a.focus();
  }

  function list() {
    const search = h("input", { class: "dlg-input", placeholder: "Search", value: q, oninput: () => { q = search.value; rows(); } });
    const wrap = h("div", { class: "pw-list" });
    const rows = () => {
      const f = q.trim().toLowerCase();
      const shown = items.filter((x) => !f || `${x.site} ${x.user} ${x.note || ""}`.toLowerCase().includes(f));
      wrap.replaceChildren(...(shown.length ? shown.map(row) : [h("p", { class: "dlg-text", text: items.length ? "Nothing matches" : "No passwords yet" })]));
    };
    const row = (x) => {
      const pass = h("span", { class: "pw-pass", text: "••••••••" });
      let hide = 0;
      return h("div", { class: "pw-row" },
        h("div", { class: "pw-who" }, h("b", { text: x.site || "(no site)" }), h("span", { text: x.user || "" }), x.note ? h("small", { text: x.note }) : null),
        pass,
        h("button", { class: "icon-btn", title: "Show for 15 seconds", onclick: async () => {
          clearTimeout(hide);
          pass.textContent = await call(host.pwReveal(x.id));
          hide = setTimeout(() => (pass.textContent = "••••••••"), 15000);
        } }, icon("eye")),
        // copied by Leonote itself: never through the page, kept out of the clipboard history, gone after 30 s
        h("button", { class: "icon-btn", title: "Copy the password (gone from the clipboard after 30 seconds, never in its history)", onclick: async () => { await call(host.pwCopy(x.id)); app.toast("Password copied - for 30 seconds", { ms: 2000 }); } }, icon("clipboard")),
        h("button", { class: "icon-btn", title: "Change", onclick: () => edit(x) }, icon("edit")),
        h("button", { class: "icon-btn", title: "Remove", onclick: async () => { if (await confirmDialog(`Remove the password for ${x.site || "this entry"}?`, "It is gone for good: the vault keeps no trash.", { ok: "Remove", safe: true })) { items = await call(host.pwRemove(x.id)); rows(); } } }, icon("trash")));
    };
    body.replaceChildren(
      h("div", { class: "pw-bar" }, search, h("button", { class: "btn btn-primary", onclick: () => edit({}) }, icon("plus"), "Add"), h("button", { class: "btn", title: "Lock now", onclick: () => { host.pwLock(); unlockForm(); } }, icon("lock"))),
      wrap);
    keys = { Escape: close };
    rows();
    search.focus();
  }

  function edit(x) {
    const f = (k, ph, type = "text") => h("input", { class: "dlg-input", type, placeholder: ph, value: x[k] || "", autocomplete: "off", spellcheck: "false" });
    const site = f("site", "Site or app"), user = f("user", "User name or email"), note = f("note", "Note (optional)");
    const pass = f("password", x.id ? "Password (empty keeps the old one)" : "Password", "password");
    // a copy from this box goes the safe way too: out of the clipboard's history, gone after 30 seconds
    pass.oncopy = pass.oncut = (e) => {
      e.preventDefault();
      const t = pass.value.slice(pass.selectionStart, pass.selectionEnd);
      if (!t || pass.type === "password") return;
      call(host.pwCopyText(t)).then(() => { if (e.type === "cut") pass.setRangeText(""); app.toast("Password copied - for 30 seconds", { ms: 2000 }); }).catch(() => {});
    };
    const gen = () => { const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?"; const r = crypto.getRandomValues(new Uint32Array(20)); pass.value = [...r].map((n) => a[n % a.length]).join(""); pass.type = "text"; };
    const save = async () => { items = await call(host.pwPut({ id: x.id || "", site: site.value.trim(), user: user.value.trim(), note: note.value.trim(), password: pass.value || (x.id ? null : "") })); list(); };
    body.replaceChildren(h("div", { class: "pw-edit" }, site, user,
      h("div", { class: "pw-bar" }, pass, h("button", { class: "btn", title: "Make a strong one", onclick: gen }, "Generate"), h("button", { class: "icon-btn", title: "Show what is typed", onclick: () => (pass.type = pass.type === "password" ? "text" : "password") }, icon("eye"))),
      note,
      h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: list }, "Cancel"), h("button", { class: "btn btn-primary", onclick: save }, "Save"))));
    keys = { Escape: list, Enter: save };
    site.focus();
  }

  const st = await host.pwStatus().catch(() => ({ exists: false, open: false }));
  if (st.open) { items = await host.pwList(); list(); } else unlockForm();
}

/* The address bar's key: the vault's entries for this page's site, filled into its sign-in form.
   pw.rs does the filling, so the password never passes through this page. */
// parsed as a URL: "github.com:x@evil.com" is evil.com (pw.rs checks the same way before it fills)
const hostOf = (u) => { const s = String(u || "").trim(); try { return new URL(s.includes("://") ? s : "https://" + s).hostname.replace(/\.$/, "").replace(/^www\./, ""); } catch { return ""; } };
export async function fillMenu(app, anchor, tabId, pageUrl) {
  let items;
  try { items = await app.host.pwList(); }
  catch (e) {
    if (String(e).includes("locked")) return openPasswords(app, { onUnlock: () => fillMenu(app, anchor, tabId, pageUrl) });
    return app.toast(String(e), { kind: "error" });
  }
  const page = hostOf(pageUrl);
  const mine = (x) => { const s = hostOf(x.site); return !!s && (page === s || page.endsWith("." + s)); };
  // each warning asked on its own, about this very page: a yes holds only while the tab is still at that address
  let origin = null;
  try { origin = new URL(pageUrl).origin; } catch {}
  const fill = async (x) => {
    const allow = [];
    for (let step = 0; step < 3; step++) {
      try { await app.host.pwFill(tabId, x.id, allow, origin); return; }
      catch (e) {
        const why = String(e);
        let ok = false;
        // the right site, but the page came unencrypted (http): anyone on the network could have changed it
        if (why === "insecure") ok = await confirmDialog(`Fill the password into ${page}?`, "This page came over plain http, not https: on a network you do not trust, someone could have changed it to catch what you type. Fill it only on a network you trust.", { ok: "Fill it", safe: true });
        else if (why === "other-site") ok = await confirmDialog(`Fill the password for ${x.site || "this entry"} into ${page}?`, "This page is not the site the password was saved for. A look-alike site is how passwords get stolen - fill it only if you are sure this is the right place.", { ok: "Fill it in anyway", safe: true });
        else return app.toast(why, { kind: "error" });
        if (!ok) return;
        allow.push(why);
      }
    }
  };
  const row = (x) => ({ label: x.user || "(no user name)", icon: "key", run: () => fill(x) });
  const near = items.filter(mine), rest = items.filter((x) => !mine(x));
  const r = anchor.getBoundingClientRect();
  menu(r.right - 260, r.bottom + 4, [
    { header: near.length ? `Fill in · ${page}` : `Nothing saved for ${page}` },
    ...near.map(row),
    rest.length ? { label: "Another entry", icon: "list", sub: rest.map((x) => ({ label: `${x.site || "?"} · ${x.user || ""}`, run: () => fill(x) })) } : null,
    "sep",
    { label: "Open the vault…", icon: "shield", run: () => openPasswords(app) },
  ].filter(Boolean));
}

/* A sign-in seen in a web tab: "keep it in the vault?" - the password itself stays in pw.rs until Save. */
export function offerSave(app, { id, site, user, update }) {
  const S = app.settings;
  if (S.pwOffer === false || (S.pwNever || []).includes(site)) return app.host.pwOfferDrop(id).catch(() => {});
  const save = () => app.host.pwOfferSave(id).then(() => app.toast(`Saved in your vault: ${site}`, { ms: 2200 })).catch((e) => {
    if (String(e).includes("locked")) openPasswords(app, { onUnlock: () => app.host.pwOfferSave(id).then(() => app.toast(`Saved in your vault: ${site}`, { ms: 2200 })).catch((e2) => app.toast(String(e2), { kind: "error" })) });
    else app.toast(String(e), { kind: "error" });
  });
  app.toast(`${update ? "Update the password" : "Save the password"} for ${user || "this sign-in"} on ${site} in your vault?`, { ms: 20000, actions: [
    { label: update ? "Update" : "Save", run: save },
    { label: "Not now", run: () => app.host.pwOfferDrop(id).catch(() => {}) },
    { label: "Never for this site", run: () => { app.host.pwOfferDrop(id).catch(() => {}); app.setSetting("pwNever", [...(S.pwNever || []), site]); } },
  ] });
}
