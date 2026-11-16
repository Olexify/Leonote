// Jev - TypeSafe's System One model - in Leonote: small decisions taken in a
// fraction of a second, each with how sure it is. A question gives the answers
// it may have (a choice, a score, a yes/no); Jev picks, never writes. What it
// decides is only done when it is sure enough (Settings › Jev), and can be undone.
//
// What it does here:
//   - a new task gets its priority and its focus area, when you gave none
//   - a note is offered the folder and the tags it belongs to
//   - the Jev playground: any question, its answer, the time it took - and the
//     request ready to copy as curl or JavaScript, for building your own
//
// The key is the user's own, sealed on this computer like the Assistant's
// (id "jev"); requests go out through the app (jev.rs), never from the page.
// https://docs.typesafe.ai/api

import { h, basename, dirname } from "./util.js";
import { icon } from "./icons.js";
import { notUtf8 } from "./vault.js";

export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
export const noul = (instructions, criteria) => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });
export const score = (instructions, criteria) => ({ type: "score", instructions, criteria });

/** The answer a choice gives, if it is sure enough and not one of the "can't tell" ones. */
export function sureChoice(answer, min, skip = ["none"]) {
  if (!answer || answer.type !== "choice" || skip.includes(answer.choice)) return null;
  return (answer.confidence ?? 0) >= min ? answer.choice : null;
}

export function createJev(app) {
  const S = app.settings;
  let haveKey = false;
  // where the questions go: TypeSafe's API with your key, or Laya - the open model of the same kind - on this computer
  let backend = { backend: "typesafe", base: "http://127.0.0.1:8000", model: "" };
  const refresh = () => Promise.all([
    app.host.aiKeysHave().then((ids) => { haveKey = ids.includes("jev"); }).catch(() => {}),
    app.host.jevBackendGet ? app.host.jevBackendGet().then((b) => { if (b) backend = b; }).catch(() => {}) : null,
  ]);
  refresh();
  const local = () => backend.backend === "laya";
  const min = () => Math.max(0.5, Math.min(0.99, Number(S.jevMin) || 0.8));
  const ready = () => (haveKey || local()) && S.jevOn !== false;
  async function setBackend(kind, base = backend.base, model = backend.model) {
    backend = await app.host.jevBackendSet(kind, base, model);
    app.bus.emit("jev-backend", backend);
    return backend;
  }

  /** What Jev decided, kept for the AI home's Activity (the last 60). */
  function log(text) { app.setSetting("jevLog", [{ at: new Date().toISOString(), text }, ...(S.jevLog || [])].slice(0, 60)); app.bus.emit("ai-activity"); }

  /** Ask Jev: `state` (text or an object), `questions` by name. Resolves to the API's answer (plus latency_ms). */
  async function ask(state, questions, model) {
    return app.host.jevAsk({ state, questions, ...(model ? { model } : {}) });
  }

  /* ── tasks: their priority and focus area, when you gave none ── */
  // Which new tasks may go to Jev - none until you choose: "ai" the ones given to AI (once handed over),
  // "all" every one - but never your own while you keep them apart from AI (Settings › AI access)
  const mayGo = (t) => {
    const ai = t.owner === "ai" && !(Number(t.ai_from) > Date.now());
    if (S.jevTasks === "ai") return ai;
    if (S.jevTasks === "all") return ai || !(app.proposals && app.proposals.tasksSplit());
    return false;
  };
  async function sortTask(t) {
    if (!ready() || !t || !t.text || !mayGo(t)) return;
    const areas = (app.areas && app.areas.all ? app.areas.all : []).filter((a) => a && a.id && a.title);
    const q = {};
    if (!t.priority || t.priority === "none") q.priority = choice("How urgent and important is this task for the person who wrote it?", {
      high: "Has to happen soon, or something real is lost if it does not",
      medium: "Matters, but can wait a few days",
      low: "Nice to do, someday, small",
      none: "The words do not say enough to tell",
    });
    if (!t.focus_id && areas.length) {
      const crit = {};
      for (const a of areas.slice(0, 250)) crit[a.id] = a.description ? { what: a.title, about: a.description } : a.title;
      crit.none = "None of these areas of life";
      q.area = choice("Which area of the person's life is this task part of?", crit);
    }
    if (!Object.keys(q).length) return;
    let res;
    try { res = await ask({ task: t.text, due: t.due_date || null, today: new Date().toISOString().slice(0, 10) }, q); }
    catch (e) { if (!/No Jev key/.test(String(e))) app.toast("Jev: " + e, { kind: "error", ms: 5000 }); return; }
    const a = res.answers || {};
    const patch = {};
    const pr = sureChoice(a.priority, min());
    if (pr) patch.priority = pr;
    const ar = sureChoice(a.area, min());
    if (ar) patch.focus_id = ar;
    if (!Object.keys(patch).length) return;
    const cur = app.tasks.get(t.id);
    if (!cur) return;
    // only what is still unset: you may have changed it in the meantime
    if (cur.priority && cur.priority !== "none") delete patch.priority;
    if (cur.focus_id) delete patch.focus_id;
    if (!Object.keys(patch).length) return;
    app.tasks.update(t.id, patch);
    log(`filed the task “${t.text.slice(0, 60)}”: ${[patch.priority, patch.focus_id && (areas.find((x) => x.id === patch.focus_id) || {}).title].filter(Boolean).join(", ")}`);
    const area = patch.focus_id && areas.find((x) => x.id === patch.focus_id);
    const said = [area ? area.title : "", patch.priority ? patch.priority + " priority" : ""].filter(Boolean).join(" · ");
    app.toast(`Jev filed “${t.text.slice(0, 40)}”: ${said} · ${res.latency_ms ?? "?"} ms`, { ms: 4500, action: { label: "Undo", run: () => app.tasks.update(t.id, { ...(patch.priority ? { priority: "none" } : {}), ...(patch.focus_id ? { focus_id: null } : {}) }) } });
  }

  /* ── notes: the folder and the tags they belong to ── */
  function folderChoices() {
    const count = new Map();
    for (const n of app.vault.notes.values()) { const d = dirname(n.path); count.set(d, (count.get(d) || 0) + 1); }
    for (const f of app.vault.folders) if (!count.has(f)) count.set(f, 0);
    // a private folder's name is not sent along either
    return [...count.entries()].filter(([d]) => !d.split("/").some((x) => x.startsWith(".")) && !(app.proposals && d && app.proposals.accessOf(d) === "private")).sort((a, b) => b[1] - a[1]).slice(0, 250).map(([d]) => d);
  }
  async function suggestFor(path) {
    const n = app.vault.notes.get(path);
    if (!n) throw new Error("Open a note first");
    if (app.proposals && app.proposals.noteAccess(path) === "private") throw new Error("This note is private - AI does not read it");
    const folders = folderChoices();
    const fcrit = {};
    folders.forEach((d, i) => { fcrit["f" + i] = d || "The top of the vault (no folder)"; });
    // the tags of notes AI may read: one found only in private notes stays out
    const counts = new Map();
    for (const m of app.vault.notes.values()) if (!(app.proposals && app.proposals.noteAccess(m.path) === "private")) for (const t of m.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
    const have = new Set((n.tags || []).map((t) => String(t).replace(/^#/, "").toLowerCase()));
    const q = { folder: choice("Which folder of this vault does this note belong in?", fcrit) };
    tags.forEach((t, i) => { if (!have.has(t.toLowerCase())) q["t" + i] = noul(`Should this note carry the tag #${t}?`); });
    const res = await ask({ title: basename(path), folder: dirname(path) || "(top of the vault)", text: String(n.content || "").slice(0, 4000) }, q);
    const a = res.answers || {};
    const fi = a.folder && a.folder.choice ? Number(a.folder.choice.slice(1)) : -1;
    return {
      latency: res.latency_ms,
      folder: fi >= 0 ? folders[fi] : null,
      folderSure: a.folder ? a.folder.confidence : 0,
      tags: tags.map((t, i) => ({ tag: t, p: a["t" + i] ? a["t" + i].noul : 0 })).filter((x) => x.p >= 0.5).sort((x, y) => y.p - x.p).slice(0, 6),
    };
  }
  /** The card that offers them; nothing moves until a button is pressed. */
  async function suggestNote(path) {
    // Laya runs on this computer and needs no key
    if (!haveKey && !local()) { await refresh(); if (!haveKey && !local()) return app.toast("Add your Jev key in Settings › Jev first", { ms: 4000, action: { label: "Open", run: () => app.openSettingsAt && app.openSettingsAt("Jev") } }); }
    if (!path) return app.toast("Open a note first", { ms: 2500 });
    const n = app.vault.notes.get(path);
    if (n && app.proposals && app.proposals.noteAccess(path, n.content) === "private") return app.toast("This note is private - kept from AI, Jev included", { ms: 3500 });
    app.toast("Jev is reading it…", { ms: 1200 });
    let s;
    try { s = await suggestFor(path); } catch (e) { return app.toast("Jev: " + (e.message || e), { kind: "error", ms: 6000 }); }
    const here = dirname(path);
    const move = s.folder != null && s.folder !== here;
    const picked = new Set(s.tags.filter((x) => x.p >= min()).map((x) => x.tag));
    const chips = s.tags.map((x) => {
      const b = h("button", { class: "chip-btn jev-tag" + (picked.has(x.tag) ? " is-on" : ""), title: `${Math.round(x.p * 100)}% sure`, onclick: () => { picked.has(x.tag) ? picked.delete(x.tag) : picked.add(x.tag); b.classList.toggle("is-on"); } }, "#" + x.tag, h("span", { class: "jev-p", text: Math.round(x.p * 100) + "%" }));
      return b;
    });
    const back = h("div", { class: "dlg-back" });
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    const apply = async (doMove, doTags) => {
      close();
      let p = path;
      if (doTags && picked.size) {
        const note = app.vault.notes.get(p);
        const bad = notUtf8(note, p);
        if (bad) return app.toast(bad, { kind: "error" });
        const add = [...picked].map((t) => "#" + t).join(" ");
        await app.vault.write(p, note.content.replace(/\s*$/, "") + "\n\n" + add + "\n", {});
      }
      if (doMove && move) { await app.moveNote(p, s.folder); p = (s.folder ? s.folder + "/" : "") + basename(p) + ".md"; }
      app.toast(`Done${doMove && move ? " · moved to " + (s.folder || "the top") : ""}${doTags && picked.size ? " · " + picked.size + " tag" + (picked.size === 1 ? "" : "s") : ""}`, { ms: 3000 });
    };
    back.append(h("div", { class: "dlg jev-card" },
      h("h3", { class: "dlg-title" }, icon("sparkles"), " Jev suggests"),
      h("p", { class: "dlg-text", text: `${basename(path)} · answered in ${s.latency ?? "?"} ms` }),
      h("div", { class: "jev-row" }, h("span", { class: "jev-lab", text: "Folder" }),
        s.folder == null ? h("span", { text: "no idea" }) : h("span", { class: move ? "" : "jev-dim", text: (s.folder || "top of the vault") + (move ? "" : " - where it is already") }),
        s.folder != null ? h("span", { class: "jev-p", text: Math.round(s.folderSure * 100) + "%" }) : null),
      h("div", { class: "jev-row" }, h("span", { class: "jev-lab", text: "Tags" }), chips.length ? h("div", { class: "jev-chips" }, ...chips) : h("span", { class: "jev-dim", text: "none of your tags fits" })),
      h("div", { class: "dlg-btns" },
        h("button", { class: "btn", onclick: close }, "Not now"),
        chips.length ? h("button", { class: "btn", onclick: () => apply(false, true) }, "Add the tags") : null,
        move ? h("button", { class: "btn", onclick: () => apply(true, false) }, "Move it") : null,
        move || chips.length ? h("button", { class: "btn btn-primary", onclick: () => apply(true, true) }, move && chips.length ? "Both" : "Do it") : null)));
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => back.classList.add("is-in"));
  }

  /* ── the playground: any question, for trying Jev and building with it ── */
  const EXAMPLE = {
    state: "Hi, my order #4411 arrived with a cracked screen. I'd like a replacement, not a refund. Delivered Tuesday.",
    questions: {
      department: { type: "choice", instructions: "Which team should handle this?", criteria: { returns: "Exchanges, wrong or damaged items", shipping: "Delivery status, delays, lost packages", billing: "Charges, invoices, payment problems" } },
      angry: { type: "noul", instructions: "Is the customer angry?" },
      urgency: { type: "score", instructions: "How urgent is this?", criteria: ["Not urgent", "Soon", "Today", "Right now"] },
    },
  };
  function playground() {
    const stateIn = h("textarea", { class: "jev-in", spellcheck: "false" });
    const qIn = h("textarea", { class: "jev-in is-code", spellcheck: "false" });
    // the last thing asked comes back; the first time, an example
    const last = S.jevPlay || {};
    stateIn.value = last.state ?? EXAMPLE.state;
    qIn.value = last.questions ?? JSON.stringify(EXAMPLE.questions, null, 2);
    const out = h("div", { class: "jev-out" }, h("div", { class: "jev-dim", text: "Ask, and the answers show here - each with how sure Jev is." }));
    const stateVal = () => { const t = stateIn.value.trim(); if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch {} } return t; };
    const body = () => ({ model: "jev-latest", state: stateVal(), questions: JSON.parse(qIn.value) });
    const bar = (label, p, on) => h("div", { class: "jev-bar" + (on ? " is-on" : "") }, h("span", { class: "jev-bar-lab", text: label }), h("span", { class: "jev-bar-track" }, h("i", { style: { width: Math.round((p || 0) * 100) + "%" } })), h("span", { class: "jev-p", text: Math.round((p || 0) * 100) + "%" }));
    const run = async () => {
      let b;
      try { b = body(); } catch (e) { out.replaceChildren(h("div", { class: "jev-err", text: "The questions are not valid JSON: " + e.message })); return; }
      out.replaceChildren(h("div", { class: "jev-dim", text: "Asking…" }));
      app.setSetting("jevPlay", { state: stateIn.value, questions: qIn.value });
      try {
        const res = await app.host.jevAsk(b);
        const parts = [h("div", { class: "jev-meta", text: `${res.model || "jev"} · ${res.latency_ms ?? "?"} ms${res.usage ? ` · ${res.usage.input_tokens ?? "?"} tokens in` : ""}` })];
        for (const [name, a] of Object.entries(res.answers || {})) {
          const head = h("div", { class: "jev-ans-head" }, h("b", { text: name }), h("span", { class: "jev-dim", text: a.type }));
          let body2;
          if (a.type === "noul") body2 = bar("yes", a.noul, a.noul >= 0.5);
          else if (a.probabilities) body2 = h("div", {}, ...Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([k, p]) => bar(a.legend && a.legend[k] != null ? `${k} · ${a.legend[k]}` : k, p, String(k) === String(a.choice ?? a.score))), h("div", { class: "jev-dim", text: `confidence ${Math.round((a.confidence || 0) * 100)}%` }));
          else body2 = h("pre", { class: "jev-pre", text: JSON.stringify(a, null, 2) });
          parts.push(h("div", { class: "jev-ans" }, head, body2));
        }
        parts.push(h("details", { class: "jev-raw" }, h("summary", { text: "The answer as JSON" }), h("pre", { class: "jev-pre", text: JSON.stringify(res, null, 2) })));
        out.replaceChildren(...parts);
      } catch (e) { out.replaceChildren(h("div", { class: "jev-err", text: String(e) })); }
    };
    const copy = (kind) => {
      let b;
      try { b = body(); } catch { return app.toast("Fix the questions first", { ms: 2000 }); }
      const json = JSON.stringify(b, null, 2);
      const text = kind === "curl"
        ? `curl https://api.typesafe.ai/v1/systemone \\\n  -H "Authorization: Bearer $TYPESAFE_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${json.replace(/'/g, "'\\''")}'`
        : `const res = await fetch("https://api.typesafe.ai/v1/systemone", {\n  method: "POST",\n  headers: { Authorization: \`Bearer \${process.env.TYPESAFE_API_KEY}\`, "Content-Type": "application/json" },\n  body: JSON.stringify(${json}),\n});\nconst { answers } = await res.json();`;
      navigator.clipboard.writeText(text).then(() => app.toast(kind === "curl" ? "Copied as curl" : "Copied as JavaScript", { ms: 1800 })).catch(() => {});
    };
    const back = h("div", { class: "dlg-back" });
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } };
    back.append(h("div", { class: "dlg jev-play" },
      h("div", { class: "jev-play-head" }, h("h3", { class: "dlg-title" }, icon("sparkles"), " Jev playground"), h("span", { class: "jev-dim", text: "state in, typed answers out - Ctrl+Enter asks" }), h("button", { class: "icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
      h("div", { class: "jev-play-body" },
        h("div", { class: "jev-col" }, h("label", { class: "jev-lab", text: "State - text, or JSON" }), stateIn, h("label", { class: "jev-lab", text: "Questions - by name: choice, noul or score" }), qIn,
          h("div", { class: "dlg-btns" },
            h("button", { class: "btn", onclick: () => app.openUrl && app.openUrl("https://docs.typesafe.ai/primitives") }, icon("book"), "Docs"),
            h("button", { class: "btn", onclick: () => copy("curl") }, "Copy as curl"),
            h("button", { class: "btn", onclick: () => copy("js") }, "Copy as JS"),
            h("button", { class: "btn btn-primary", onclick: run }, "Ask Jev"))),
        h("div", { class: "jev-col" }, h("label", { class: "jev-lab", text: "Answers" }), out))));
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => { back.classList.add("is-in"); stateIn.focus(); });
  }

  return { ask, sortTask, suggestNote, suggestFor, playground, refresh, log, ready: () => ready(), hasKey: () => haveKey || local(),
    backend: () => backend, setBackend, local, name: () => (local() ? "Laya" : "Jev") };
}
