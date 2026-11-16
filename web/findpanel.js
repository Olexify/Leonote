// Find and replace inside a note: Leonote's own panel over CodeMirror's search
// state - one field, a count of where you are, the options as small toggles,
// and replace folded away until it is wanted.
import { SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, replaceNext, replaceAll, closeSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { h, keyOf } from "./util.js";
import { icon } from "./icons.js";

const MAX_COUNT = 5000;
// the panel of each editor, so Ctrl+H from the text can unfold its replace row
const PANELS = new WeakMap();
let wantReplace = false; // past this the count reads "5000+": a note that long is not worth the wait

export function findPanel(view) {
  let replaceOpen = wantReplace;
  wantReplace = false;
  const input = h("input", { class: "fp-input", type: "text", placeholder: "Find in this note", spellcheck: "false", "main-field": "true" });
  const count = h("span", { class: "fp-count" });
  const rep = h("input", { class: "fp-input", type: "text", placeholder: "Replace with", spellcheck: "false" });
  const opt = (name, text, title) => h("button", { class: "fp-opt", type: "button", title, dataset: { opt: name }, onmousedown: (e) => e.preventDefault(), onclick: () => { opts[name] = !opts[name]; commit(); jump(); } }, text);
  const opts = { caseSensitive: false, wholeWord: false, regexp: false };
  const optEls = [opt("caseSensitive", "Aa", "Match case"), opt("wholeWord", "W", "Whole words"), opt("regexp", ".*", "Regular expression")];
  const btn = (ic, title, run, cls = "") => h("button", { class: "fp-btn " + cls, type: "button", title, onmousedown: (e) => e.preventDefault(), onclick: run }, icon(ic));
  const fold = btn("chevronDown", "Replace", () => { replaceOpen = !replaceOpen; paint(); if (replaceOpen) rep.focus(); else input.focus(); }, "fp-fold");
  const repRow = h("div", { class: "fp-row fp-rep" },
    h("div", { class: "fp-field" }, icon("pen", "fp-lead"), rep),
    h("button", { class: "fp-text", type: "button", title: "Replace this one (Enter)", onclick: () => replaceNext(view) }, "Replace"),
    h("button", { class: "fp-text", type: "button", title: "Replace every one (Ctrl+Enter)", onclick: () => replaceAll(view) }, "All"));
  const dom = h("div", { class: "fp" },
    h("div", { class: "fp-row" },
      fold,
      h("div", { class: "fp-field" }, icon("search", "fp-lead"), input, count, ...optEls),
      btn("arrowUp", "Previous (Shift+Enter)", () => findPrevious(view)),
      btn("arrowDown", "Next (Enter)", () => findNext(view)),
      btn("x", "Close (Esc)", () => closeSearchPanel(view))),
    repRow);

  function commit() {
    const q = new SearchQuery({ search: input.value, replace: rep.value, caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord, regexp: opts.regexp });
    view.dispatch({ effects: setSearchQuery.of(q) });
  }
  // typing or pasting goes to the first match from where the search began (round to the top when there is none after it)
  let origin = null;
  function jump() {
    const q = getSearchQuery(view.state);
    if (!q.search || !q.valid) return;
    if (origin == null) origin = view.state.selection.main.from;
    let first = null, hit = null;
    const c = q.getCursor(view.state);
    for (let m = c.next(), n = 0; !m.done && n < MAX_COUNT; m = c.next(), n++) { first ||= m.value; if (m.value.from >= origin) { hit = m.value; break; } }
    hit ||= first;
    if (hit) view.dispatch({ selection: { anchor: hit.from, head: hit.to }, effects: EditorView.scrollIntoView(hit.from, { y: "center" }) });
  }
  function paint() {
    repRow.hidden = !replaceOpen;
    fold.classList.toggle("is-on", replaceOpen);
    for (const el of optEls) el.classList.toggle("is-on", !!opts[el.dataset.opt]);
  }
  function paintCount(state) {
    const q = getSearchQuery(state);
    if (!q.search || !q.valid) { count.textContent = q.search ? "?" : ""; dom.classList.toggle("is-none", !!q.search); return; }
    const at = state.selection.main.from;
    let n = 0;
    let cur = 0;
    const c = q.getCursor(state);
    for (let m = c.next(); !m.done && n < MAX_COUNT; m = c.next()) { n++; if (m.value.from === at && m.value.to === state.selection.main.to) cur = n; }
    count.textContent = n ? `${cur || "–"} / ${n >= MAX_COUNT ? MAX_COUNT + "+" : n}` : "none";
    dom.classList.toggle("is-none", !n);
  }
  // typing or moving the caret recounts the whole note: once a frame, not once a keystroke
  let countFrame = 0;
  const countSoon = () => { cancelAnimationFrame(countFrame); countFrame = requestAnimationFrame(() => paintCount(view.state)); };
  function sync(state) {
    const q = getSearchQuery(state);
    if (document.activeElement !== input) input.value = q.search;
    if (document.activeElement !== rep) rep.value = q.replace;
    opts.caseSensitive = q.caseSensitive; opts.wholeWord = q.wholeWord; opts.regexp = q.regexp;
    paint();
    paintCount(state);
  }

  input.addEventListener("input", () => { commit(); jump(); });
  rep.addEventListener("input", commit);
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeSearchPanel(view); view.focus(); }
    else if (e.key === "Enter" && e.target === input) { e.preventDefault(); (e.shiftKey ? findPrevious : findNext)(view); }
    else if (e.key === "Enter" && e.target === rep) { e.preventDefault(); (e.ctrlKey || e.metaKey ? replaceAll : replaceNext)(view); }
    else if ((e.ctrlKey || e.metaKey) && (keyOf(e) === "h" || keyOf(e) === "H")) { e.preventDefault(); replaceOpen = true; paint(); rep.focus(); }
    else if ((e.ctrlKey || e.metaKey) && (keyOf(e) === "f" || keyOf(e) === "F")) { e.preventDefault(); input.focus(); input.select(); }
    else return;
    e.stopPropagation();
  });

  sync(view.state);
  PANELS.set(view, { replace() { replaceOpen = true; paint(); rep.focus(); rep.select(); } });
  return {
    dom,
    top: true,
    mount() { origin = view.state.selection.main.from; if (replaceOpen) { rep.focus(); rep.select(); } else { input.focus(); input.select(); } },
    destroy() { PANELS.delete(view); cancelAnimationFrame(countFrame); },
    update(u) {
      const changed = u.transactions.some((tr) => tr.effects.some((ef) => ef.is(setSearchQuery)));
      if (changed) sync(u.state);
      else if (u.docChanged || u.selectionSet) countSoon();
    },
  };
}

/** Open the panel on `text` and stand on its first match in the note. */
export function findFirst(view, text, open) {
  const q = new SearchQuery({ search: text });
  view.dispatch({ effects: setSearchQuery.of(q) });
  open(view);
  const m = q.getCursor(view.state).next();
  if (!m.done) view.dispatch({ selection: { anchor: m.value.from, head: m.value.to }, effects: EditorView.scrollIntoView(m.value.from, { y: "center" }) });
}

/** Find and replace at once: the panel open with its replace row out (Ctrl+H). */
export function openReplace(view, open) {
  const p = PANELS.get(view);
  if (p) { p.replace(); return true; }
  wantReplace = true;
  return open(view);
}
