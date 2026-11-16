// Code and plain-text files as a real editor: line numbers, folding, bracket
// matching, auto-indent and closing brackets, multiple cursors, search,
// comment toggling and word completion. Languages load on first use from
// @codemirror/language-data, so an unopened language costs nothing.

import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, scrollPastEnd,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, redo } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, indentUnit, LanguageDescription } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, completeAnyWord } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { classHighlighter } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { h } from "./util.js";

/** Tabs or spaces, and how many, from the file itself. */
export function detectIndent(text) {
  const counts = new Map();
  let tabs = 0;
  let spaces = 0;
  let prev = 0;
  for (const line of text.split("\n", 2000)) {
    const m = /^([ \t]*)\S/.exec(line);
    if (!m) continue;
    if (m[1].startsWith("\t")) { tabs++; continue; }
    const n = m[1].length;
    if (n) spaces++;
    const d = Math.abs(n - prev);
    if (d >= 2 && d <= 8) counts.set(d, (counts.get(d) || 0) + 1);
    prev = n;
  }
  if (tabs > spaces) return { unit: "\t", label: "Tabs" };
  let best = 4;
  let most = 0;
  for (const [d, c] of counts) if (c > most) { most = c; best = d; }
  return { unit: " ".repeat(best), label: `Spaces: ${best}` };
}

/**
 * Mount an editor for `text` in `el`. `name` picks the language.
 * opts: { onChange(), onSave() } - wrapping long lines is one choice for every file (Settings: codeWrap)
 * Returns { getText(), setText(text), focus(), destroy() }.
 */
export function mountCode(el, text, name, opts = {}) {
  const crlf = /\r\n/.test(text);
  const doc = crlf ? text.replace(/\r\n/g, "\n") : text;
  const indent = detectIndent(doc);
  const lang = new Compartment();
  const wrapping = new Compartment();
  const app = window.leonote;
  let wrap = app ? app.settings.codeWrap !== false : true;
  let external = false; // setText() is not a user edit

  const langLabel = h("span", { class: "cv-lang", text: "Plain text" });
  const pos = h("span", { class: "cv-pos" });
  const wrapBtn = h("button", { class: "cv-btn", title: "Wrap long lines (Alt+Z)", onclick: () => toggleWrap() }, "Wrap");
  const bar = h("div", { class: "cv-status" }, langLabel,
    h("span", { text: indent.label }), h("span", { text: crlf ? "CRLF" : "LF" }), h("span", { text: "UTF-8" }),
    h("span", { class: "cv-spacer" }), wrapBtn, pos);
  const host = h("div", { class: "cv-editor" });
  el.replaceChildren(host, bar);

  const paintPos = (state) => {
    const r = state.selection.main;
    const line = state.doc.lineAt(r.head);
    const sel = r.empty ? "" : ` (${Math.abs(r.to - r.from)} selected)`;
    const cursors = state.selection.ranges.length > 1 ? ` · ${state.selection.ranges.length} cursors` : "";
    pos.textContent = `Ln ${line.number}, Col ${r.head - line.from + 1}${sel}${cursors}`;
  };
  const toggleWrap = () => {
    wrap = !wrap;
    if (app) app.setSetting("codeWrap", wrap);
    wrapBtn.classList.toggle("is-on", wrap);
    view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
    return true;
  };

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of(indent.unit),
        EditorState.tabSize.of(indent.unit === "\t" ? 4 : indent.unit.length),
        syntaxHighlighting(classHighlighter),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ override: [completeAnyWord], icons: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        scrollPastEnd(),
        lang.of([]),
        wrapping.of(wrap ? EditorView.lineWrapping : []),
        keymap.of([
          { key: "Mod-s", run: () => { opts.onSave && opts.onSave(); return true; } },
          { key: "Mod-/", run: toggleComment },
          { key: "Alt-z", run: toggleWrap },
          indentWithTab,
          { key: "Mod-Shift-z", run: redo, preventDefault: true }, // Windows gets only Ctrl+Y from historyKeymap
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !external && opts.onChange) opts.onChange();
          if (u.selectionSet || u.docChanged) paintPos(u.state);
        }),
      ],
    }),
  });
  wrapBtn.classList.toggle("is-on", wrap);
  paintPos(view.state);

  // the language arrives a moment later; highlighting simply appears
  const desc = LanguageDescription.matchFilename(languages, name) || (/\.(jsonc)$/i.test(name) ? LanguageDescription.matchLanguageName(languages, "json") : null);
  if (desc) {
    langLabel.textContent = desc.name;
    desc.load().then((support) => { if (view.dom.isConnected) view.dispatch({ effects: lang.reconfigure(support) }); }).catch(() => {});
  }

  return {
    view,
    getText: () => {
      const t = view.state.doc.toString();
      return crlf ? t.replace(/\n/g, "\r\n") : t;
    },
    setText(t) {
      const next = crlf ? t.replace(/\r\n/g, "\n") : t;
      if (next === view.state.doc.toString()) return;
      external = true;
      const head = Math.min(view.state.selection.main.head, next.length);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: { anchor: head } });
      external = false;
    },
    focus: () => view.focus(),
    /** Caret to the start of line `n` (1-based), brought into the middle of the view. */
    goLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.round(n) || 1)));
      view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
