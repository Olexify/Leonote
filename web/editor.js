// One CodeMirror view for the whole app. Each open note keeps its own
// EditorState (undo history, selection, scroll), so switching notes is a
// setState - no re-parse, no re-render of anything else, no flicker.

import { emojiPicker } from "./emoji.js";
import { EditorState, StateEffect, StateField, Compartment, Annotation, Prec } from "@codemirror/state";
import { EditorView, keymap, drawSelection, dropCursor, rectangularSelection, crosshairCursor, placeholder, Decoration, showTooltip } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo, undoDepth, redoDepth, selectAll } from "@codemirror/commands";
// CodeMirror's own keys, less two: Ctrl+/ comments a line out - and on a German keyboard Ctrl+Shift+7 IS Ctrl+/, so the
// numbered list became an HTML comment; Ctrl+M switched Tab to leaving the editor, with no sign of it
const EDIT_KEYS = defaultKeymap.filter((b) => b.key !== "Mod-/" && b.key !== "Mod-m" && b.key !== "Ctrl-m");
import { undoNotes } from "./undonote.js";
// The language and its list commands only - NOT markdown(), which drags in
// the HTML, CSS and JavaScript parsers (~140 KB, 20% of the bundle) to
// highlight embedded HTML that notes don't need.
import { markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, LanguageSupport, Language, LanguageDescription, ParseContext } from "@codemirror/language";
import { parseCode } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";
import { autocompletion, closeBrackets, closeBracketsKeymap, startCompletion } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { findPanel, findFirst, openReplace } from "./findpanel.js";
import { livePreview } from "./livepreview.js";
import { selectionBar } from "./seltools.js";
// every formatting command lives in mdcommands.js, so the keyboard, the
// palette, the slash menu and the selection bar all run the same code
import { wrap, insertLink, wikiLink, toggleTask, setHeading, headingLevel, highlight, highlightMenu, commandMap, toggleQuote, toggleBullets, toggleNumbers, callout, codeBlock, clearFormat, HIGHLIGHT_LABELS, renumber, sortLines, doneToBottom, changeCase } from "./mdcommands.js";
import { dayKey, debounce } from "./util.js";
import { writtenPath } from "./mdparse.js";
import { htmlToMd, isRich, isCode, guessLang } from "./htmlmd.js";

/* Code blocks in notes in their language's colours: the language named after the ``` is loaded the first
   time a note uses it (the same lazy parsers the code editor uses), and the block is drawn again when it
   arrives. Markdown itself stays the light parser - no HTML parser comes along. */
const codeParser = (info) => {
  const name = /\S*/.exec(info || "")[0];
  if (!name) return null;
  const found = LanguageDescription.matchLanguageName(languages, name, true);
  if (!found) return null;
  return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
};
const notesLanguage = new Language(markdownLanguage.data, markdownLanguage.parser.configure(parseCode({ codeParser })), [], "markdown");

export const External = Annotation.define();

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "tk-h" },
  { tag: t.heading2, class: "tk-h" },
  { tag: t.heading3, class: "tk-h" },
  { tag: [t.heading4, t.heading5, t.heading6], class: "tk-h" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.strikethrough, textDecoration: "line-through", class: "tk-strike" },
  { tag: t.link, class: "tk-link" },
  { tag: t.url, class: "tk-url" },
  { tag: t.monospace, class: "tk-code" },
  { tag: t.quote, class: "tk-quote" },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], class: "tk-mark" },
  { tag: t.list, class: "tk-list" },
  { tag: [t.meta, t.comment], class: "tk-meta" },
  { tag: [t.keyword, t.operator], class: "tk-kw" },
  { tag: [t.string, t.regexp], class: "tk-str" },
  { tag: [t.number, t.bool, t.atom], class: "tk-num" },
  { tag: [t.propertyName, t.attributeName], class: "tk-prop" },
  { tag: [t.typeName, t.className, t.namespace], class: "tk-type" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tk-fn" },
]);

/* ── transient highlight for text changed outside the app ───────────────── */
const addFlash = StateEffect.define();
const clearFlash = StateEffect.define();
const flashMark = Decoration.mark({ class: "cm-flash" });
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFlash) && e.value.to > e.value.from) deco = deco.update({ add: [flashMark.range(e.value.from, e.value.to)] });
      if (e.is(clearFlash)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ── slash menu ────────────────────────────────────────────────────────── */
// "|" marks where the caret lands.
const SLASH = [
  { label: "Heading 1", kw: "h1 title", insert: "# |" },
  { label: "Heading 2", kw: "h2", insert: "## |" },
  { label: "Heading 3", kw: "h3", insert: "### |" },
  { label: "Heading 4", kw: "h4", insert: "#### |" },
  { label: "Heading 5", kw: "h5", insert: "##### |" },
  { label: "Heading 6", kw: "h6", insert: "###### |" },
  { label: "To-do", kw: "task checkbox todo", insert: "- [ ] |" },
  { label: "Bullet list", kw: "ul unordered", insert: "- |" },
  { label: "Numbered list", kw: "ol ordered", insert: "1. |" },
  { label: "Highlight", kw: "mark == marker", insert: "==|==" },
  { label: "Highlight in a colour…", kw: "mark colour color yellow green blue pink purple grey", action: "highlight" },
  { label: "Quote", kw: "blockquote", insert: "> |" },
  { label: "Callout", kw: "note info warning", insert: "> [!note] |" },
  { label: "Code block", kw: "fence pre", insert: "```\n|\n```" },
  { label: "Table", kw: "grid", insert: "| | |\n| --- | --- |\n| | |" },
  { label: "Divider", kw: "hr rule line", insert: "---\n|" },
  { label: "Link to note", kw: "wikilink page", action: "link" },
  { label: "Today's date", kw: "date now", insert: () => dayKey() + "|" },
  { label: "Current time", kw: "time now clock", insert: () => new Date().toTimeString().slice(0, 5) + "|" },
  { label: "Leopaint drawing", kw: "sketch vector excalidraw whiteboard diagram arrows draw paint canvas leopaint leocanvas prototype", action: "sketch" },
  { label: "Drawing", kw: "paint draw raster layers brush art studio photo filter animate leostudio", action: "drawing" },
  { label: "Note from this paragraph", kw: "extract atomic zettel split selection", action: "extract" },
  { label: "Insert template…", kw: "template zettel", action: "template" },
];

/** Image files on a clipboard or a drop, screenshots included. */
// videos and music dropped or pasted into a note (by type, or by name when the type is missing)
const MEDIA_NAME = /\.(mp4|webm|mkv|mov|m4v|ogv|mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i;
function mediaFiles(dt) {
  if (!dt) return [];
  const is = (f) => f && (/^(video|audio)\//.test(f.type) || MEDIA_NAME.test(f.name || ""));
  const out = [...(dt.files || [])].filter(is);
  if (!out.length && dt.items) {
    for (const it of dt.items) if (it.kind === "file") { const f = it.getAsFile(); if (is(f)) out.push(f); }
  }
  return out;
}
function imageFiles(dt) {
  if (!dt) return [];
  const out = [...(dt.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!out.length && dt.items) {
    for (const it of dt.items) if (it.kind === "file" && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) out.push(f); }
  }
  return out;
}

function applySnippet(view, from, to, tpl, complete) {
  const text = typeof tpl === "function" ? tpl() : tpl;
  const caret = text.indexOf("|");
  const insert = text.replace("|", "");
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + (caret < 0 ? insert.length : caret) },
    userEvent: "input.complete",
  });
  if (complete) startCompletion(view);
}

// A table pasted straight under a line of text (or a picture) would be read as more of that paragraph - Markdown
// wants an empty line above a table: it is put in, so the table is a table here, in Obsidian and on GitHub alike.
const TABLE_START = /^[ \t]*\|[^\n]*\r?\n[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*(\r?\n|$)/;
const pastedTable = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("input.paste")) return tr;
  let ch = null, n = 0;
  tr.changes.iterChanges((fa, ta, _fb, _tb, ins) => { n++; ch = { fa, ta, ins: ins.toString() }; });
  if (n !== 1 || !TABLE_START.test(ch.ins)) return tr;
  const doc = tr.startState.doc, line = doc.lineAt(ch.fa);
  const before = doc.sliceString(line.from, ch.fa);
  const lead = before.trim() ? "\n\n" : line.number > 1 && doc.line(line.number - 1).text.trim() ? "\n" : "";
  if (!lead) return tr;
  const insert = lead + ch.ins;
  return { changes: { from: ch.fa, to: ch.ta, insert }, selection: { anchor: ch.fa + insert.length }, userEvent: "input.paste", scrollIntoView: true };
});

export function createEditor(parent, o) {
  let picsMarked = false; // a picture wears the selection: cleared when the selection goes
  let plainNext = false; // Ctrl+Shift+V was pressed: the next paste goes in as plain text
  const lpConf = new Compartment();
  const spellConf = new Compartment();
  let lpOn = o.livePreview !== false;
  let spell = !!o.spellcheck;
  let cfgVersion = 0;

  const cache = new Map(); // path -> { state, scroll, cfg, used }
  let cur = null;
  let flashTimer = null;

  const lpExt = () => (lpOn ? livePreview(o) : []);
  const spellExt = () => EditorView.contentAttributes.of({ spellcheck: String(spell), autocorrect: "on", autocapitalize: "sentences" });

  function wikiSource(ctx) {
    const m = ctx.matchBefore(/\[\[[^\[\]\n|#]*$/);
    if (!m) return null;
    return {
      from: m.from + 2,
      options: o.noteOptions().map((n) => ({
        label: n.title,
        detail: n.folder,
        type: "note",
        apply: (view, _c, from, to) => {
          const after = view.state.sliceDoc(to, to + 2);
          const ins = n.link + (after === "]]" ? "" : "]]");
          view.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + n.link.length + 2 }, userEvent: "input.complete" });
        },
      })),
      validFor: /^[^\[\]\n|#]*$/,
    };
  }

  function tagSource(ctx) {
    const m = ctx.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_\-/]+$/u);
    if (!m) return null;
    const hash = m.text.lastIndexOf("#");
    return {
      from: m.from + hash + 1,
      options: o.tagOptions().map(([tag, count]) => ({ label: tag, detail: String(count), type: "tag" })),
      validFor: /^[\p{L}\p{N}_\-/]*$/u,
    };
  }

  function slashSource(ctx) {
    const m = ctx.matchBefore(/\/[\p{L}\d]*$/u);
    if (!m) return null;
    const line = ctx.state.doc.lineAt(m.from);
    if (ctx.state.sliceDoc(line.from, m.from).trim() !== "") return null;
    return {
      from: m.from + 1,
      options: SLASH.map((s, i) => ({
        label: s.label,
        detail: s.kw.split(" ")[0],
        type: "slash",
        boost: -i,
        apply: (view, _c, from, to) => {
          if (!s.action) return applySnippet(view, from - 1, to, s.insert, s.complete);
          // actions replace the "/word" and let the host do the rest
          view.dispatch({ changes: { from: from - 1, to }, selection: { anchor: from - 1 } });
          if (s.action === "highlight") return highlightMenu(view);
          if (s.action === "link") return pickNoteLink(view);
          if (o.onSlashAction) o.onSlashAction(s.action, view, from - 1);
        },
      })),
      validFor: /^[\p{L}\d]*$/u,
    };
  }

  /** A note picked by name in its own box (typing goes there, not into the note), linked at the caret;
      selected words become what the link shows. */
  const pickNoteLink = (view) => o.pickLink && o.pickLink((t) => {
    const r = view.state.selection.main;
    const words = view.state.sliceDoc(r.from, r.to).trim();
    // a file outside the vault is a link by address
    const ins = typeof t === "object" ? `[${words || t.name}](${t.url})` : `[[${t}${words && words !== t ? "|" + words : ""}]]`;
    view.dispatch({ changes: { from: r.from, to: r.to, insert: ins }, selection: { anchor: r.from + ins.length }, userEvent: "input" });
    view.focus();
  });
  /* "[" just typed (its "]" came along): a small bubble offers a link - to a note, or to a web address. Mouse
     only, so typing on or Enter never takes it by mistake; it goes as soon as the brackets are not empty. */
  const emptyBrackets = (st) => { const r = st.selection.main; return r.empty && st.sliceDoc(r.from - 1, r.from + 1) === "[]" && !/[[!]/.test(st.sliceDoc(r.from - 2, r.from - 1)) && !/^\s*([-*+]|\d+[.)])\s*$/.test(st.sliceDoc(st.doc.lineAt(r.from).from, r.from - 1)); };
  const bracketTip = StateField.define({
    create: () => null,
    update(v, tr) {
      const st = tr.state;
      if (!emptyBrackets(st)) return null;
      if (tr.docChanged && tr.isUserEvent("input.type")) {
        const pos = st.selection.main.from;
        return { pos, above: false, strictSide: false, create: (view) => {
          const dom = document.createElement("div");
          dom.className = "cm-bracket-tip";
          const btn = (label, title, run) => { const b = document.createElement("button"); b.textContent = label; b.title = title; b.addEventListener("mousedown", (e) => { e.preventDefault(); run(); }); return b; };
          dom.append(
            btn("Note…", "Link to a note: pick it by name", () => { const p = view.state.selection.main.from; view.dispatch({ changes: { from: p - 1, to: p + 1 }, selection: { anchor: p - 1 } }); pickNoteLink(view); }),
            btn("Web link", "[text](address)", () => { const p = view.state.selection.main.from; view.dispatch({ changes: { from: p + 1, insert: "()" }, selection: { anchor: p } }); view.focus(); }));
          return { dom };
        } };
      }
      return v && tr.docChanged ? null : v;
    },
    provide: (f) => showTooltip.from(f),
  });

  const rowHint = { el: null, side: null }; // the picture a dragged picture would join, and on which side

  // a heading back to plain text: its own level toggled off (setHeading(0) would leave a stray space)
  const bodyText = (v) => (headingLevel(v.state) ? setHeading(headingLevel(v.state))(v) : true);
  const appKeys = [
    // CodeMirror binds redo to Ctrl+Y on Windows and keeps Ctrl+Shift+Z for
    // Mac and Linux only - but it is the one every other editor here answers to
    { key: "Mod-Shift-z", run: redo, preventDefault: true },
    { key: "Mod-b", run: wrap("**") },
    { key: "Mod-i", run: wrap("*") },
    { key: "Mod-Shift-x", run: wrap("~~") },
    { key: "Mod-Shift-h", run: highlight("yellow") },
    { key: "Mod-e", run: wrap("`") },
    { key: "Mod-k", run: insertLink },
    { key: "Mod-Enter", run: toggleTask },
    { key: "Mod-l", run: toggleTask },
    // as in Google Docs and Word online
    { key: "Mod-Shift-7", run: toggleNumbers },
    { key: "Mod-Shift-8", run: toggleBullets },
    { key: "Mod-Alt-1", run: setHeading(1) },
    { key: "Mod-Alt-2", run: setHeading(2) },
    { key: "Mod-Alt-3", run: setHeading(3) },
    { key: "Mod-Alt-4", run: setHeading(4) },
    { key: "Mod-Alt-5", run: setHeading(5) },
    { key: "Mod-Alt-6", run: setHeading(6) },
    { key: "Mod-Alt-0", run: bodyText }, // back to plain text
    // the same with Ctrl+Shift: on German and Czech keyboards Ctrl+Alt+2 is AltGr+2 and types ² (or waits for an accent)
    // (Ctrl+Shift+1-6 go by the key itself - see headingKeys below)
    { key: "Mod-f", run: openSearchPanel },
    { key: "Mod-h", run: (v) => openReplace(v, openSearchPanel) },
  ];

  const extensions = () => [
    pastedTable,
    bracketTip,
    history(),
    undoNotes(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    search({ top: true, createPanel: findPanel }),
    EditorView.lineWrapping,
    new LanguageSupport(notesLanguage),
    Prec.high(keymap.of([{ key: "Enter", run: (v) => {
      // "77)" or "3." typed alone (no space after it) is a label, not an empty list item to clear: Enter just goes on
      const r = v.state.selection.main, line = v.state.doc.lineAt(r.head);
      if (r.empty && r.head === line.to && /^\s*\d+[.)]$/.test(line.text)) return false;
      return insertNewlineContinueMarkup(v);
    } }, { key: "Backspace", run: deleteMarkupBackward }])),
    syntaxHighlighting(mdHighlight),
    flashField,
    lpConf.of(lpExt()),
    spellConf.of(spellExt()),
    autocompletion({ override: [slashSource, wikiSource, tagSource], icons: false }),
    selectionBar(o),
    placeholder("Start writing…   /  for blocks   [[  to link"),
    // Ctrl+Shift+1-6 make headings by the key pressed, not the character: on a Czech keyboard Shift+1 types "1", and
    // CodeMirror would then look for Ctrl+1 (and on German ones Ctrl+Alt+2 is AltGr, which types ²)
    EditorView.domEventHandlers({ keydown: (e, v) => {
      const m = /^Digit([1-6])$/.exec(e.code || "");
      if (!m || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return false;
      e.preventDefault();
      return setHeading(+m[1])(v);
    } }),
    keymap.of([{ key: "Mod-;", run: (v) => { const c = v.coordsAtPos(v.state.selection.main.head); emojiAt(v, c ? c.left : 200, c ? c.bottom + 4 : 200); return true; } }, ...appKeys, ...closeBracketsKeymap, ...EDIT_KEYS, ...searchKeymap, ...historyKeymap, indentWithTab]),
    // pictures inside a text selection wear the selection too, so Ctrl+A or a drag over them reads as "these are picked"
    EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged && !u.viewportChanged) return;
      const ranges = u.state.selection.ranges.filter((r) => !r.empty);
      // nothing selected and nothing marked: no picture to look at (this runs at every key and caret move)
      if (!ranges.length && !picsMarked) return;
      picsMarked = false;
      for (const el of u.view.dom.querySelectorAll(".cm-img, .cm-media")) {
        let inSel = false;
        if (ranges.length) { try { const p = u.view.posAtDOM(el); inSel = ranges.some((r) => p >= r.from && p < r.to); } catch {} }
        if (inSel) picsMarked = true;
        el.classList.toggle("is-in-sel", inSel);
      }
    }),
    // a selection over a line with a picture beside its text: the browser's own highlight, which follows the
    // text as it wraps round the picture - the drawn one takes lines as full width and leaves odd bars
    EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged && !u.viewportChanged) return;
      const v = u.view, sel = v.state.selection.main;
      let on = false;
      if (!sel.empty) for (const f of v.contentDOM.querySelectorAll(".cm-img.is-float-left, .cm-img.is-float-right, .cm-media.is-float-left, .cm-media.is-float-right")) {
        let at; try { at = v.posAtDOM(f); } catch { continue; }
        const line = v.state.doc.lineAt(at);
        if (sel.from <= line.to && sel.to >= line.from) { on = true; break; }
      }
      v.dom.classList.toggle("sel-native", on);
    }),
    EditorView.updateListener.of((u) => {
      // `undo`: the change was Ctrl+Z or Ctrl+Shift+Z (what a pasted picture's file follows)
      if (u.docChanged && cur && !u.transactions.every((tr) => tr.annotation(External))) {
        // `cut`: something was taken out, or typed into a line with an embed (![[photo-old.png]] breaks the link
        // to photo.png without deleting anything) - other typing cannot remove a picture's embed
        let cut = false;
        u.changes.iterChanges((fromA, toA) => { if (toA > fromA || u.startState.doc.lineAt(fromA).text.includes("![[")) cut = true; });
        o.onChange(cur, u.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo")), cut);
      }
      if ((u.selectionSet || u.docChanged) && o.onCursor) o.onCursor(u.state);
    }),
    EditorView.domEventHandlers({
      // a third click takes everything between spaces (a whole e-mail address, link or path - a double click
      // stops at its dots and @), a fourth the whole line
      mousedown(e, view) {
        if (e.button !== 0 || e.detail < 3 || e.shiftKey || e.altKey) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const line = view.state.doc.lineAt(pos);
        let from = line.from, to = line.to;
        if (e.detail === 3) {
          const at = pos - line.from, t = line.text;
          let a = at, b = at;
          while (a > 0 && !/\s/.test(t[a - 1])) a--;
          while (b < t.length && !/\s/.test(t[b])) b++;
          if (a === b) return false;
          from = line.from + a; to = line.from + b;
        }
        e.preventDefault();
        view.dispatch({ selection: { anchor: from, head: to }, userEvent: "select.pointer" });
        return true;
      },
      // Ours, always: the webview's own knows nothing of this editor. Its one gift is
      // spelling suggestions - Ctrl+right-click brings it for those.
      contextmenu(e, view) {
        if (!o.menu || e.ctrlKey || e.target.closest(".cm-img, .cm-yt, .cm-sketch")) return false;
        e.preventDefault();
        const sel = view.state.selection.main;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos != null && (sel.empty || pos < sel.from || pos > sel.to)) view.dispatch({ selection: { anchor: pos } });
        const has = !view.state.selection.main.empty;
        const text = () => { const r = view.state.selection.main; return view.state.sliceDoc(r.from, r.to); };
        const back = (fn) => () => { fn(); view.focus(); };
        const run = (cmd) => back(() => cmd(view));
        // a block of text on a line of its own, the caret left inside or after it
        const block = (text, caretBack = 0) => back(() => {
          const r = view.state.selection.main;
          const line = view.state.doc.lineAt(r.from);
          const lead = line.text.trim() && r.from === r.to ? "\n" : "";
          const at = lead ? line.to : r.from;
          view.dispatch({ changes: { from: at, to: lead ? at : r.to, insert: lead + text }, selection: { anchor: at + lead.length + text.length - caretBack }, userEvent: "input", scrollIntoView: true });
        });
        const footnote = back(() => {
          const r = view.state.selection.main;
          // the highest number + 1: with [^1] and [^3] written, a count would give a second [^3]
          const n = Math.max(0, ...(view.state.doc.toString().match(/\[\^\d+\]:/g) || []).map((m) => +m.slice(2, -2))) + 1;
          const mark = `[^${n}]`;
          const tail = `\n\n[^${n}]: `;
          const end = view.state.doc.length;
          view.dispatch({ changes: [{ from: r.to, insert: mark }, { from: end, insert: tail }], selection: { anchor: end + mark.length + tail.length }, userEvent: "input", scrollIntoView: true });
        });
        const level = headingLevel(view.state);
        // a link to a note found by name, at the caret; selected words become what the link shows
        const pickLink = o.pickLink ? back(() => pickNoteLink(view)) : null;
        const at = e.leonoteMenuAt || { x: e.clientX, y: e.clientY };
        // the [[link]] or ![[embed]] the click is on: where its note or file is
        let linked = [];
        if (pos != null && o.linkRows) {
          const line = view.state.doc.lineAt(pos);
          for (const m of line.text.matchAll(/!?\[\[([^\]|#\n]+)[^\]\n]*\]\]/g)) {
            const a = line.from + m.index;
            if (pos >= a && pos <= a + m[0].length) { linked = o.linkRows(m[1].trim()); break; }
          }
        }
        // a folder or file path written out (G:\Notes\Work): Explorer opens there - a folder opened, a file only
        // shown in its folder, never run
        let osPath = null;
        if (pos != null && o.revealPath) {
          const line = view.state.doc.lineAt(pos);
          for (const m of line.text.matchAll(/[A-Za-z]:\\/g)) {
            const a = line.from + m.index, p = writtenPath(line.text, m.index);
            if (pos >= a && pos <= a + p.length) { osPath = p; break; }
          }
        }
        o.menu(at.x, at.y, [
          osPath ? { label: "Open in Explorer", icon: "folder", run: () => o.revealPath(osPath) } : null,
          osPath ? "sep" : null,
          ...linked,
          linked.length ? "sep" : null,
          pickLink ? { label: has ? "Link these words to a note…" : "Link to a note…", icon: "link", run: pickLink } : null,
          { label: "Format", icon: "bold", sub: [
            { label: "Bold", icon: "bold", keys: "Ctrl B", run: run(wrap("**")) },
            { label: "Italic", icon: "italic", keys: "Ctrl I", run: run(wrap("*")) },
            { label: "Strikethrough", icon: "strike", keys: "Ctrl Shift X", run: run(wrap("~~")) },
            { label: "Highlight", icon: "edit", sub: [
              ...Object.entries(HIGHLIGHT_LABELS).map(([c, name]) => ({ label: name, swatch: `var(--hl-${c})`, run: run(highlight(c)) })),
              "sep",
              { label: "Remove highlight", icon: "eraser", run: run(highlight(null)) },
            ] },
            "sep",
            { label: "Code", icon: "code", keys: "Ctrl E", run: run(wrap("`")) },
            { label: "Math", icon: "hash", run: run(wrap("$")) },
            { label: "Comment", icon: "eye", run: run(wrap("%%")) },
            "sep",
            { label: "Clear formatting", icon: "eraser", run: run(clearFormat) },
          ] },
          { label: "Paragraph", icon: "heading", sub: [
            { label: "Bullet list", icon: "list", keys: "Ctrl Shift 8", run: run(toggleBullets) },
            { label: "Numbered list", icon: "list", keys: "Ctrl Shift 7", run: run(toggleNumbers) },
            { label: "Task list", icon: "checkSquare", run: run(toggleTask) },
            "sep",
            ...[1, 2, 3, 4, 5, 6].map((n) => ({ label: "Heading " + n, icon: "heading", keys: `Ctrl Alt ${n}`, checked: level === n, run: run(setHeading(n)) })),
            { label: "Body", icon: "minus", keys: "Ctrl Alt 0", checked: level === 0, run: run(bodyText) },
            "sep",
            { label: "Quote", icon: "quote", run: run(toggleQuote) },
            "sep",
            { label: "Renumber the list", icon: "list", title: "The numbered lines you selected, counted 1) 2) 3)… again in order", run: run(renumber) },
            { label: "Sort lines A→Z", icon: "list", title: "The lines you selected, by their words (list marks and checkboxes left out of it)", run: run(sortLines) },
            { label: "Ticked to the bottom", icon: "check", title: "In the lines you selected, done checkboxes go below the open ones", run: run(doneToBottom) },
          ] },
          has ? { label: "Change case", icon: "caseText", sub: [
            { label: "UPPERCASE", icon: "caseText", run: run(changeCase("upper")) },
            { label: "lowercase", icon: "caseText", run: run(changeCase("lower")) },
            { label: "Title Case", icon: "caseText", run: run(changeCase("title")) },
            { label: "Sentence case", icon: "caseText", run: run(changeCase("sentence")) },
          ] } : null,
          has && o.onSlashAction ? { label: "Make this a note of its own", icon: "filePlus", run: () => o.onSlashAction("extract", view, view.state.selection.main.from) } : null,
          { label: "Insert", icon: "plus", sub: [
            // with nothing selected there are no words to link: the picker instead
            { label: has ? "Link these words to a note" : "Link to a note…", icon: "link", run: has || !pickLink ? run(wikiLink) : pickLink },
            { label: "Web link", icon: "globe", keys: "Ctrl K", run: run(insertLink) },
            { label: "Footnote", icon: "edit", run: footnote },
            "sep",
            { label: "Table", icon: "columns", run: block("| Column | Column |\n| --- | --- |\n|  |  |\n", 8) },
            { label: "Callout", icon: "quote", run: run(callout("note")) },
            { label: "Horizontal rule", icon: "minus", run: block("---\n") },
            "sep",
            { label: "Code block", icon: "code", run: run(codeBlock) },
            { label: "Math block", icon: "hash", run: block("$$\n\n$$\n", 4) },
            "sep",
            { label: "Today's date", icon: "calendar", run: back(() => view.dispatch(view.state.replaceSelection(new Date().toLocaleDateString("sv")), { userEvent: "input" })) },
            { label: "The time now", icon: "clock", run: back(() => view.dispatch(view.state.replaceSelection(new Date().toTimeString().slice(0, 5)), { userEvent: "input" })) },
          ] },
          { label: "Emoji…", icon: "smile", keys: "Ctrl ;", run: () => emojiAt(view, e.clientX, e.clientY) },
          "sep",
          undoDepth(view.state) ? { label: "Undo", icon: "undo", keys: "Ctrl Z", run: back(() => undo(view)) } : null,
          redoDepth(view.state) ? { label: "Redo", icon: "redo", keys: "Ctrl Shift Z", run: back(() => redo(view)) } : null,
          undoDepth(view.state) || redoDepth(view.state) ? "sep" : null,
          has ? { label: "Cut", icon: "scissors", keys: "Ctrl X", run: back(() => { navigator.clipboard.writeText(text()).catch(() => {}); view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut" }); }) } : null,
          has ? { label: "Copy", icon: "clipboard", keys: "Ctrl C", run: back(() => navigator.clipboard.writeText(text()).catch(() => {})) } : null,
          { label: "Paste", icon: "clipboard", keys: "Ctrl V", run: async () => {
            let t = "";
            try { t = await navigator.clipboard.readText(); } catch {}
            if (t) view.dispatch(view.state.replaceSelection(t), { userEvent: "input.paste", scrollIntoView: true });
            view.focus();
          } },
          { label: "Paste as plain text", icon: "clipboard", keys: "Ctrl Shift V", run: async () => {
            let t = "";
            try { t = await navigator.clipboard.readText(); } catch {}
            // what a web page or a document brings along: links, emphasis, heading marks
            t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2").replace(/^#{1,6}\s+/gm, "");
            if (t) view.dispatch(view.state.replaceSelection(t), { userEvent: "input.paste", scrollIntoView: true });
            view.focus();
          } },
          { label: "Select all", icon: "check", keys: "Ctrl A", run: back(() => selectAll(view)) },
          ...(o.contextExtras ? o.contextExtras(cur) : []),
          spell ? { header: "Ctrl+right-click: spelling suggestions", plain: true } : null,
        ].filter(Boolean));
        return true;
      },
      dragover(e, view) {
        const t = e.dataTransfer && e.dataTransfer.types;
        if (t && (t.includes("application/x-leonote-embed") || t.includes("Files"))) e.preventDefault();
        // a picture dragged over another picture: a bar on the side it would join that row on
        const pic = t && t.includes("application/x-leonote-embed") && e.target.closest && e.target.closest(".cm-img, .cm-media");
        const side = pic ? (e.clientX < pic.getBoundingClientRect().left + pic.getBoundingClientRect().width / 2 ? "before" : "after") : null;
        if (rowHint.el && (rowHint.el !== pic || rowHint.side !== side)) rowHint.el.classList.remove("drop-before", "drop-after");
        rowHint.el = pic || null; rowHint.side = side;
        if (pic) pic.classList.add("drop-" + side);
        return false;
      },
      dragleave(e) {
        if (rowHint.el && !rowHint.el.contains(e.relatedTarget)) { rowHint.el.classList.remove("drop-before", "drop-after"); rowHint.el = null; }
        return false;
      },
      drop(e, view) {
        const dt = e.dataTransfer;
        if (!dt) return false;
        let pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const moved = dt.getData("application/x-leonote-embed");
        // dropped on a picture's side: right before or after that picture, in its row
        if (rowHint.el) {
          const el = rowHint.el, side = rowHint.side;
          el.classList.remove("drop-before", "drop-after");
          rowHint.el = null;
          if (moved) try {
            const at = view.posAtDOM(el);
            const m = /^(!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\))/.exec(view.state.sliceDoc(at, at + 2000));
            if (m) pos = side === "before" ? at : at + m[0].length;
          } catch { /* not in this note: the plain drop */ }
        }
        if (moved) {
          // an image dragged inside the note: move its embed text
          e.preventDefault();
          const src = JSON.parse(moved);
          const len = src.to - src.from;
          if (pos == null || (pos >= src.from && pos <= src.to) || view.state.sliceDoc(src.from, src.to) !== src.text) return true;
          // next to another picture it joins that row with a space; the gap it left closes
          const before = view.state.sliceDoc(Math.max(0, pos - 1), pos);
          const after = view.state.sliceDoc(pos, pos + 1);
          const ins = (before && !/\s/.test(before) ? " " : "") + src.text + (after === "!" ? " " : "");
          const gap = view.state.sliceDoc(src.to, src.to + 1) === " " ? 1 : 0;
          // a picture that stood alone on its line takes the line along (and one empty line after it), so no hole is left
          const doc = view.state.doc, line = doc.lineAt(src.from);
          let cut = { from: src.from, to: src.to + gap };
          if (line.text.trim() === src.text && line.number < doc.lines) {
            const next = doc.line(line.number + 1);
            const end = !next.text.trim() && next.number < doc.lines ? next.to + 1 : line.to + 1;
            if (pos < line.from || pos > end) cut = { from: line.from, to: end };
          }
          view.dispatch({
            changes: [cut, { from: pos, insert: ins }],
            selection: { anchor: pos > src.to ? pos : pos + len },
            userEvent: "move.drop",
          });
          return true;
        }
        const files = imageFiles(dt);
        const media = mediaFiles(dt);
        if (media.length && o.onMedia) {
          e.preventDefault();
          e.stopPropagation();
          const at = pos ?? view.state.selection.main.head;
          if (files.length && o.onImages) o.onImages(files, view, at);
          o.onMedia(media, view, at);
          return true;
        }
        if (!files.length || !o.onImages) return false;
        e.preventDefault();
        o.onImages(files, view, pos ?? view.state.selection.main.head);
        return true;
      },
      // Ctrl+Shift+V: the paste that follows goes in as plain text (the paste event itself never says Shift was held)
      keydown(e) { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyV") plainNext = true; return false; },
      paste(e, view) {
        const plain0 = plainNext;
        plainNext = false;
        const clips = mediaFiles(e.clipboardData);
        if (clips.length && o.onMedia) {
          e.preventDefault();
          o.onMedia(clips, view, view.state.selection.main.from);
          return true;
        }
        const pics = imageFiles(e.clipboardData);
        if (pics.length && o.onImages) {
          e.preventDefault();
          o.onImages(pics, view, view.state.selection.main.from);
          return true;
        }
        // code copied from a code editor comes as HTML that loses its lines: its plain text goes in, as a code
        // block in its language (inside a code block already, just the text)
        const html = e.clipboardData && e.clipboardData.getData("text/html");
        const plain = e.clipboardData && e.clipboardData.getData("text/plain");
        if (html && plain && plain.includes("\n") && isCode(html) && !plain0) {
          const r0 = view.state.selection.main;
          const line = view.state.doc.lineAt(r0.from);
          let inCode = false;
          for (let n = 1; n < line.number; n++) if (/^\s*(```|~~~)/.test(view.state.doc.line(n).text)) inCode = !inCode;
          const code = plain.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
          const md = inCode ? code : `${line.text.slice(0, r0.from - line.from).trim() ? "\n" : ""}\`\`\`${guessLang(code)}\n${code}\n\`\`\`\n`;
          view.dispatch({ changes: { from: r0.from, to: r0.to, insert: md }, selection: { anchor: r0.from + md.length }, userEvent: "input.paste" });
          e.preventDefault();
          return true;
        }
        // rich text (a table, headings, a list) comes in as Markdown, not as its flattened words
        if (html && isRich(html) && !plain0) {
          const md = htmlToMd(html);
          if (md.trim()) { const r0 = view.state.selection.main; view.dispatch({ changes: { from: r0.from, to: r0.to, insert: md }, selection: { anchor: r0.from + md.length }, userEvent: "input.paste" }); e.preventDefault(); return true; }
        }
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        const r = view.state.selection.main;
        // a bare address pasted on its own: in it goes, and the page's title follows once it is known
        if (text && r.empty && /^https?:\/\/\S+$/.test(text.trim()) && o.linkTitle && !plain0) {
          const url = text.trim();
          const at = r.from;
          view.dispatch({ changes: { from: at, insert: url }, selection: { anchor: at + url.length }, userEvent: "input.paste" });
          e.preventDefault();
          o.linkTitle(url).then((title) => {
            const t = String(title || "").trim().replace(/[\[\]]/g, "");
            if (!t || t === url) return;
            const doc = view.state.doc;
            if (at + url.length > doc.length || doc.sliceString(at, at + url.length) !== url) return;
            const before = at > 0 ? doc.sliceString(at - 1, at) : "";
            if (before === "(" || before === "[" || before === "<") return;
            const md = `[${t}](${url})`;
            view.dispatch({ changes: { from: at, to: at + url.length, insert: md }, selection: view.state.selection.main.from === at + url.length ? { anchor: at + md.length } : undefined, userEvent: "input.paste" });
          }).catch(() => {});
          return true;
        }
        if (plain0 || !text || r.empty || !/^https?:\/\/\S+$/.test(text.trim())) return false;
        const sel = view.state.sliceDoc(r.from, r.to);
        view.dispatch({ changes: { from: r.from, to: r.to, insert: `[${sel}](${text.trim()})` }, userEvent: "input.paste" });
        e.preventDefault();
        return true;
      },
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: extensions() }) });
  const scroller = o.scroller;

  /*
   * Where the reader is, said in a way that survives the page changing height
   * under them: the document position of the line at the top of the window and
   * how far into that line the edge is. Pixels alone go wrong whenever pictures
   * load late, a note is reopened, or live preview is switched (in source view
   * every picture collapses to one line of text).
   */
  function topAnchor() {
    const h = scroller.getBoundingClientRect().top - view.documentTop;
    if (h <= 0) return { top: 0, off: 0 }; // still in the title above the text: pixels are exact there
    const b = view.lineBlockAtHeight(h);
    return { top: b.from, off: Math.max(0, Math.round(h - b.top)) };
  }
  let settling = 0;
  // a jump asked for (a search hit, a heading, a line) wins over the scroll the note is reopened at, which settles over
  // a second and a half: `aimed` ends that settling
  let reopened = 0;
  const aimed = () => { settling++; reopened++; };
  /** Put that line back at the top, and again as the layout settles - until the reader scrolls. */
  function settleTop(a, path) {
    if (!a || !(a.top > 0 || a.off > 0)) return;
    const token = ++settling;
    const fix = () => {
      if (token !== settling || cur !== path || !view.dom.isConnected) return;
      const b = view.lineBlockAt(Math.min(a.top, view.state.doc.length));
      const d = view.documentTop + b.top + Math.min(a.off, Math.max(0, b.height - 4)) - scroller.getBoundingClientRect().top;
      if (Math.abs(d) > 1) scroller.scrollTop += d;
    };
    const stop = () => { if (token === settling) settling++; };
    for (const t of ["wheel", "pointerdown", "keydown", "touchstart"]) scroller.addEventListener(t, stop, { once: true, passive: true, capture: true });
    fix();
    requestAnimationFrame(fix);
    for (const ms of [60, 180, 400, 800, 1500]) setTimeout(fix, ms);
  }
  const whereNow = () => { const r = view.state.selection.main; return { anchor: r.anchor, head: r.head, scroll: scroller.scrollTop, ...topAnchor() }; };

  function stash() {
    if (!cur) return;
    const at = whereNow();
    const e = cache.get(cur);
    if (e) { e.state = view.state; e.scroll = at.scroll; e.top = { top: at.top, off: at.off }; }
    if (o.onLeave) o.onLeave(cur, at);
  }
  /*
   * Dragging text or a picture to another part of the note: the page scrolls
   * as soon as the pointer comes near the top or bottom edge - a wide band
   * (a fifth of the height, at least 90px), faster the closer to the edge,
   * and fastest once the pointer is past it (over the tab bar, say). The
   * browser's own drag-scroll only wakes up in the last few pixels, and the
   * mouse wheel is dead while a drag is held - the webview sends no wheel
   * events then - so this band is the way to travel.
   */
  const listening = new AbortController(); // ended by destroy(): these listeners live on the document
  {
    let y = 0;
    let raf = 0;
    let live = false;
    let seen = 0;
    let r = null; // the note's box, measured by dragover (a scroll moves what is inside it, not the box): no layout read per frame
    const tick = () => {
      raf = 0;
      // dragover keeps coming while a drag is held, even with the hand still: silence means it ended
      if (!live || performance.now() - seen > 500 || !r) { live = false; return; }
      const band = Math.max(90, Math.min(200, r.height * 0.2));
      let v = 0;
      if (y < r.top + band) v = -Math.min(1.6, (r.top + band - y) / band);
      else if (y > r.bottom - band) v = Math.min(1.6, (y - (r.bottom - band)) / band);
      if (v) scroller.scrollTop += Math.sign(v) * (4 + 34 * v * v);
      raf = requestAnimationFrame(tick);
    };
    const stopDrag = () => { live = false; if (raf) cancelAnimationFrame(raf); raf = 0; };
    document.addEventListener("dragover", (e) => {
      if (!view.dom.isConnected || !view.dom.offsetParent) return;
      r = scroller.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right) { live = false; return; }
      y = e.clientY;
      seen = performance.now();
      if (!live) { live = true; if (!raf) raf = requestAnimationFrame(tick); }
    }, { capture: true, signal: listening.signal });
    for (const t of ["dragend", "drop", "dragleave"]) document.addEventListener(t, (e) => { if (t !== "dragleave" || !e.relatedTarget) stopDrag(); }, { capture: true, signal: listening.signal });
    listening.signal.addEventListener("abort", stopDrag);
  }

  // a note left open for hours is remembered too, not only one that was left:
  // the place survives a crash or the PC going down
  const noteScroll = debounce(() => { if (cur && o.onLeave && view.dom.isConnected && view.dom.offsetParent) o.onLeave(cur, whereNow()); }, 2000);
  scroller.addEventListener("scroll", noteScroll, { passive: true });

  function evict() {
    if (cache.size <= 40) return;
    const victims = [...cache.entries()]
      .filter(([p]) => p !== cur && !o.isDirty(p))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [p] of victims.slice(0, cache.size - 40)) cache.delete(p);
  }

  function diffChange(oldText, next) {
    if (oldText === next) return null;
    let s = 0;
    const max = Math.min(oldText.length, next.length);
    while (s < max && oldText.charCodeAt(s) === next.charCodeAt(s)) s++;
    let e = 0;
    while (e < max - s && oldText.charCodeAt(oldText.length - 1 - e) === next.charCodeAt(next.length - 1 - e)) e++;
    return { from: s, to: oldText.length - e, insert: next.slice(s, next.length - e) };
  }

  return {
    view,
    /** This editor is going for good: its document listeners, its cached notes and its view go with it. */
    destroy() { listening.abort(); noteScroll.cancel(); cache.clear(); view.destroy(); },
    /** The paragraph the caret is in (blank lines bound it), for "about this" with nothing selected. */
    paragraph() {
      const st = view.state, at = st.selection.main.head;
      let a = st.doc.lineAt(at), b = a;
      while (a.number > 1 && st.doc.line(a.number - 1).text.trim()) a = st.doc.line(a.number - 1);
      while (b.number < st.doc.lines && st.doc.line(b.number + 1).text.trim()) b = st.doc.line(b.number + 1);
      return st.sliceDoc(a.from, b.to).trim();
    },
    get path() { return cur; },

    /** pos: a remembered { anchor, head, scroll } for a note not yet in the cache */
    open(path, content, { cursor, pos } = {}) {
      if (cur === path) return;
      stash();
      let e = cache.get(path);
      if (!e) {
        const len = content.length;
        const anchor = pos ? Math.min(pos.anchor || 0, len) : cursor === "end" ? len : 0;
        const head = pos ? Math.min(pos.head ?? pos.anchor ?? 0, len) : anchor;
        e = { state: EditorState.create({ doc: content, extensions: extensions(), selection: { anchor, head } }), scroll: pos ? pos.scroll || 0 : 0, top: pos && pos.top != null ? { top: Math.min(pos.top, len), off: pos.off || 0 } : null, cfg: cfgVersion };
        cache.set(path, e);
      }
      e.used = performance.now();
      cur = path;
      view.setState(e.state);
      if (e.cfg !== cfgVersion) {
        view.dispatch({ effects: [lpConf.reconfigure(lpExt()), spellConf.reconfigure(spellExt())] });
        e.cfg = cfgVersion;
      }
      scroller.scrollTop = e.scroll;
      // the first layout of a fresh state can clamp the scroll; apply it again once measured
      const want = e.scroll, tok = ++reopened;
      if (want) requestAnimationFrame(() => { if (cur === path && tok === reopened && Math.abs(scroller.scrollTop - want) > 2) scroller.scrollTop = want; });
      // and then by the line that was at the top, which no late picture can shift
      settleTop(e.top, path);
      evict();
    },

    /** Current caret and scroll of the open note, for remembering. */
    position() {
      if (!cur) return null;
      const r = view.state.selection.main;
      return { path: cur, anchor: r.anchor, head: r.head, scroll: scroller.scrollTop, ...topAnchor() };
    },

    /** Detach from any note (e.g. the open note was deleted). */
    clear() {
      stash();
      cur = null;
      view.setState(EditorState.create({ doc: "", extensions: extensions() }));
    },

    content(path) {
      if (path === cur) return view.state.doc.toString();
      const e = cache.get(path);
      return e ? e.state.doc.toString() : null;
    },

    has: (path) => cache.has(path),

    forget(path) {
      cache.delete(path);
      if (cur === path) cur = null;
    },

    rename(from, to) {
      const e = cache.get(from);
      if (e) { cache.delete(from); cache.set(to, e); }
      if (cur === from) cur = to;
    },

    /** Apply text changed on disk as a minimal edit: selection, undo history
     *  and scroll survive, and the changed span glows briefly. */
    applyExternal(path, content) {
      if (path === cur) {
        const ch = diffChange(view.state.doc.toString(), content);
        if (!ch) return false;
        const flashTo = ch.from + ch.insert.length;
        view.dispatch({ changes: ch, annotations: External.of(true), effects: addFlash.of({ from: ch.from, to: flashTo }) });
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => view.dispatch({ effects: clearFlash.of(null) }), 1800);
        return true;
      }
      const e = cache.get(path);
      if (!e) return false;
      const ch = diffChange(e.state.doc.toString(), content);
      if (ch) e.state = e.state.update({ changes: ch, annotations: External.of(true) }).state;
      return !!ch;
    },

    /** Replace the whole document (user chose "use their version"). */
    replace(path, content) {
      if (path === cur) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, annotations: External.of(true) });
      } else cache.delete(path);
    },

    focus() { view.focus(); },
    hasFocus: () => view.hasFocus,

    select(from, to = from, center = true) {
      const len = view.state.doc.length;
      from = Math.min(from, len);
      to = Math.min(to, len);
      aimed();
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: center ? "center" : "nearest" }) });
    },

    /** The find panel open on `text`, the caret on its first match. */
    find(text) { aimed(); findFirst(view, text, openSearchPanel); },

    selectLine(lineNo) {
      const n = Math.min(Math.max(1, lineNo + 1), view.state.doc.lines);
      const line = view.state.doc.line(n);
      aimed();
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 80 }) });
    },

    insert(text, cursor) {
      const r = view.state.selection.main;
      const at = r.from + (cursor == null ? text.length : cursor);
      view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: at }, userEvent: "input" });
    },

    /**
     * The selection, or the block around the caret when there is none. On a
     * blank line it is the block just above: typing "/" under a paragraph
     * means that paragraph.
     */
    range({ block = false } = {}) {
      const r = view.state.selection.main;
      if (!r.empty || !block) return { from: r.from, to: r.to, text: view.state.sliceDoc(r.from, r.to) };
      const doc = view.state.doc;
      let n = doc.lineAt(r.head).number;
      while (n > 1 && !doc.line(n).text.trim()) n--;
      if (!doc.line(n).text.trim()) return { from: r.head, to: r.head, text: "" };
      let a = n;
      let b = n;
      while (a > 1 && doc.line(a - 1).text.trim()) a--;
      while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
      const from = doc.line(a).from;
      const to = doc.line(b).to;
      return { from, to, text: view.state.sliceDoc(from, to) };
    },

    /** One edit, with the caret placed at an absolute offset afterwards. */
    apply({ from, to = from, insert = "", cursor }) {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: Math.min(cursor == null ? from + insert.length : cursor, view.state.doc.length - (to - from) + insert.length) },
        userEvent: "input",
      });
    },

    run(cmd) {
      const map = { ...commandMap(), find: openSearchPanel };
      if (map[cmd]) { map[cmd](view); view.focus(); }
    },

    setLivePreview(on) {
      // what was at the top stays at the top: pictures appear or collapse to
      // a line of text, and everything below them moves
      const at = cur ? topAnchor() : null;
      lpOn = on;
      cfgVersion++;
      view.dispatch({ effects: lpConf.reconfigure(lpExt()) });
      if (at) settleTop(at, cur);
      const e = cur && cache.get(cur);
      if (e) e.cfg = cfgVersion;
    },

    setSpellcheck(on) {
      spell = on;
      cfgVersion++;
      view.dispatch({ effects: spellConf.reconfigure(spellExt()) });
      const e = cur && cache.get(cur);
      if (e) e.cfg = cfgVersion;
    },

    /** Re-run live preview (e.g. a link target now exists). */
    refresh() {
      if (lpOn) {
        cfgVersion++;
        view.dispatch({ effects: lpConf.reconfigure(lpExt()) });
        const e = cur && cache.get(cur);
        if (e) e.cfg = cfgVersion;
      }
    },
  };
}

/** The emoji picker, its pick typed where the caret was. */
function emojiAt(view, x, y) {
  const at = view.state.selection.main;
  emojiPicker(x, y, (e) => { view.focus(); view.dispatch({ changes: { from: at.from, to: at.to, insert: e }, selection: { anchor: at.from + e.length }, userEvent: "input" }); });
}
