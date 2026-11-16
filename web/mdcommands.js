// The formatting a note can have, in one place. Ctrl+B, the command palette,
// the slash menu and the bar that floats over a selection all call in here,
// so a button and its shortcut can never drift apart.

import { EditorSelection } from "@codemirror/state";
import { HL_COLORS, findHighlights, stripHighlights, highlightEdits } from "./mdparse.js";
import { menu } from "./ui.js";

/* ── wrapping marks ─────────────────────────────────────────────────────── */
export function wrap(mark) {
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((r) => {
        // the caret inside a word: the word is meant (it was cut in two by the marks: wo****rd); the caret stays a caret
        const caret = r.empty ? r.head : -1;
        if (r.empty) { const w = state.wordAt(r.head); if (w && w.from < r.head && r.head < w.to) r = EditorSelection.range(w.from, w.to); }
        const n = mark.length;
        const before = state.sliceDoc(r.from - n, r.from);
        const after = state.sliceDoc(r.to, r.to + n);
        // a single * inside **bold** is the bold's, not an italic to take away: Ctrl+I there makes ***bold italic***
        const boldOnly = mark === "*" && state.sliceDoc(r.from - 2, r.from) === "**" && state.sliceDoc(r.to, r.to + 2) === "**" && state.sliceDoc(r.from - 3, r.from) !== "***";
        if (before === mark && after === mark && !boldOnly) {
          return {
            changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }],
            range: caret >= 0 ? EditorSelection.cursor(caret - n) : EditorSelection.range(r.from - n, r.to - n),
          };
        }
        return {
          changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }],
          range: caret >= 0 ? EditorSelection.cursor(caret + n) : EditorSelection.range(r.from + n, r.to + n),
        };
      }),
      { userEvent: "input.format" }
    );
    return true;
  };
}

/** Is the selection already inside this mark? (So a button can look pressed.) */
export function isWrapped(state, mark) {
  const r = state.selection.main;
  const n = mark.length;
  if (state.sliceDoc(r.from - n, r.from) !== mark || state.sliceDoc(r.to, r.to + n) !== mark) return false;
  // a single * inside **bold** is the bold, not an italic of its own
  if (mark === "*" && state.sliceDoc(r.from - 2, r.from) === "**" && state.sliceDoc(r.to, r.to + 2) === "**") return false;
  return true;
}

export function insertLink(view) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to);
      if (!text) return { changes: { from: r.from, insert: "[]()" }, range: EditorSelection.cursor(r.from + 1) };
      if (/^https?:\/\/\S+$/.test(text))
        return { changes: { from: r.from, to: r.to, insert: `[](${text})` }, range: EditorSelection.cursor(r.from + 1) };
      return { changes: { from: r.from, to: r.to, insert: `[${text}]()` }, range: EditorSelection.cursor(r.from + text.length + 3) };
    }),
    { userEvent: "input.format" }
  );
  return true;
}

/** The selection becomes a [[wiki link]] to a note of that name. */
export function wikiLink(view) {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to).trim();
  if (!text) return false;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: `[[${text}]]` },
    selection: { anchor: r.from + 2, head: r.from + 2 + text.length },
    userEvent: "input.format",
  });
  return true;
}

/* ── highlights ─────────────────────────────────────────────────────────── */
// Ctrl+Shift+H writes the plain Obsidian ==highlight==; the colours (which
// are inline <mark class="hl-…">, see mdparse.js) come from the command
// palette, the slash menu or the selection bar. Highlighting in the colour
// already there takes the highlight off again.
export const HIGHLIGHT_LABELS = { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", purple: "Purple", grey: "Grey" };

export function highlight(color) {
  return (view) => {
    const r = view.state.selection.main;
    const e = highlightEdits(view.state.doc.toString(), r.from, r.to, color);
    if (e.changes.length)
      view.dispatch({ changes: e.changes, selection: { anchor: e.from, head: e.to }, userEvent: "input.format" });
    return true;
  };
}

/** The colour over the selection, or null - so a button can show it. */
export function highlightAt(state) {
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  if (line.text.indexOf("==") < 0 && line.text.indexOf("<mark") < 0) return null;
  for (const hl of findHighlights(line.text)) {
    const a = line.from + hl.inner;
    const b = line.from + hl.innerTo;
    if (r.from >= a && r.to <= b) return hl.color;
  }
  return null;
}

export function highlightMenu(view, at) {
  const p = at || view.coordsAtPos(view.state.selection.main.head);
  const now = highlightAt(view.state);
  menu(p ? p.left : innerWidth / 2 - 90, p ? (p.bottom || p.top) + 6 : 120, [
    { header: "Highlight" },
    ...HL_COLORS.map((c) => ({ label: HIGHLIGHT_LABELS[c], swatch: `var(--hl-${c})`, checked: now === c, run: () => { highlight(c)(view); view.focus(); } })),
    "sep",
    { label: "Remove highlight", icon: "x", run: () => { highlight(null)(view); view.focus(); } },
  ]);
}

/* ── lines ──────────────────────────────────────────────────────────────── */
const TASK_LINE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]/;
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+/;

export function toggleTask(view) {
  const { state } = view;
  const changes = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      // a blank line inside a longer selection gets no checkbox
      if (!line.text.trim() && state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number) continue;
      let m;
      if ((m = TASK_LINE.exec(line.text))) {
        const at = line.from + m[0].length - 2;
        changes.push({ from: at, to: at + 1, insert: m[3] === " " ? "x" : " " });
      } else if ((m = LIST_LINE.exec(line.text))) {
        changes.push({ from: line.from + m[0].length, insert: "[ ] " });
      } else {
        const indent = /^\s*/.exec(line.text)[0].length;
        changes.push({ from: line.from + indent, insert: "- [ ] " });
      }
    }
  }
  view.dispatch({ changes, userEvent: "input.toggle" });
  return true;
}

export function setHeading(level) {
  return (view) => {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);
    const m = /^(#{1,6})\s+/.exec(line.text);
    const cur = m ? m[1].length : 0;
    const insert = cur === level ? "" : "#".repeat(level) + " ";
    const old = m ? m[0].length : 0;
    // the caret goes on after the marks and their space, ready for the heading's words
    const head = state.selection.main.head;
    const at = head <= line.from + old ? line.from + insert.length : head + insert.length - old;
    view.dispatch({ changes: { from: line.from, to: line.from + old, insert }, ...(state.selection.main.empty ? { selection: { anchor: at } } : {}), userEvent: "input.format" });
    return true;
  };
}

/** The heading level of the line the caret is on, 0 for body text. */
export function headingLevel(state) {
  const m = /^(#{1,6})\s+/.exec(state.doc.lineAt(state.selection.main.head).text);
  return m ? m[1].length : 0;
}

/** Every line the selection touches, once. */
function selectedLines(state) {
  const out = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(state.doc.line(n));
    }
  }
  return out;
}

const QUOTE_LINE = /^(\s*)>\s?/;
const BULLET_LINE = /^(\s*)[-*+]\s+/;
const ORDERED_LINE = /^(\s*)\d+[.)]\s+/;

/** Put a mark in front of the lines - or take it off when they all have it. */
function linePrefix(re, make) {
  return (view) => {
    const { state } = view;
    // blank lines between paragraphs stay blank (no "- " or "2." on them) - one empty line on its own still gets one;
    // a quote keeps them, so its paragraphs stay one quote
    // per cursor: a blank line a cursor sits on by itself keeps its mark; one inside a longer selection does not
    const alone = (l) => state.selection.ranges.some((r) => state.doc.lineAt(r.from).number === l.number && state.doc.lineAt(r.to).number === l.number);
    const lines = selectedLines(state).filter((l) => re === QUOTE_LINE || l.text.trim() || alone(l));
    if (!lines.length) return false;
    const all = lines.every((l) => re.test(l.text) || !l.text.trim());
    const changes = [];
    lines.forEach((l, i) => {
      const m = re.exec(l.text);
      if (all) {
        if (m) changes.push({ from: l.from + m[1].length, to: l.from + m[0].length });
      } else if (!m) {
        const indent = /^\s*/.exec(l.text)[0].length;
        // a line that is some other kind of list becomes this kind
        const other = re === QUOTE_LINE ? null : BULLET_LINE.exec(l.text) || ORDERED_LINE.exec(l.text);
        const to = l.from + (other ? other[0].length : indent);
        changes.push({ from: l.from + indent, to, insert: make(i) });
      }
    });
    if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
    return true;
  };
}

export const toggleQuote = linePrefix(QUOTE_LINE, () => "> ");
export const toggleBullets = linePrefix(BULLET_LINE, () => "- ");
export const toggleNumbers = linePrefix(ORDERED_LINE, (i) => `${i + 1}. `);

/** A callout: a quote with a kind, which live preview draws as a panel. */
export function callout(kind = "note") {
  return (view) => {
    const { state } = view;
    const lines = selectedLines(state);
    if (!lines.length) return false;
    const changes = [];
    lines.forEach((l, i) => {
      const m = QUOTE_LINE.exec(l.text);
      const indent = /^\s*/.exec(l.text)[0].length;
      const head = i === 0 ? `> [!${kind}] ` : "> ";
      changes.push({ from: l.from + indent, to: l.from + (m ? m[0].length : indent), insert: head });
    });
    view.dispatch({ changes, userEvent: "input.format" });
    return true;
  };
}

/** Fence the selected lines as a code block. */
export function codeBlock(view) {
  const { state } = view;
  const lines = selectedLines(state);
  if (!lines.length) return false;
  const first = lines[0];
  const last = lines[lines.length - 1];
  view.dispatch({
    changes: [{ from: first.from, insert: "```\n" }, { from: last.to, insert: "\n```" }],
    selection: { anchor: first.from + 3 },
    userEvent: "input.format",
  });
  return true;
}

/* ── the text itself ────────────────────────────────────────────────────── */
const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of", "on", "or", "the", "to", "up", "via", "with"]);

function cased(text, kind) {
  if (kind === "upper") return text.toUpperCase();
  if (kind === "lower") return text.toLowerCase();
  if (kind === "sentence") return text.toLowerCase().replace(/(^\s*\p{L}|[.!?]\s+\p{L})/gu, (s) => s.toUpperCase());
  return text.toLowerCase().replace(/[\p{L}\p{N}']+/gu, (w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
}

/**
 * Numbered lines counted again, in order, from the first one's number: "1) a / 1) new / 2) b" becomes
 * "1) a / 2) new / 3) b". A number at the start of a line followed by ")" or "." counts, whatever
 * stands before it ("(1)", "+-2)"); other lines are left as they are and do not break the count.
 */
export function renumberText(text) {
  let n = null;
  return String(text).split("\n").map((line) => {
    const m = /^(\s*[^\w\s]{0,3})(\d+)(?=[).])/.exec(line);
    if (!m) return line;
    n = n === null ? +m[2] : n + 1;
    return m[1] + n + line.slice(m[0].length);
  }).join("\n");
}
/** The lines the selection touches, renumbered (renumberText). */
export function renumber(view) {
  const { state } = view;
  const r = state.selection.main;
  const from = state.doc.lineAt(r.from).from, to = state.doc.lineAt(r.to).to;
  const was = state.sliceDoc(from, to);
  const next = renumberText(was);
  if (next !== was) view.dispatch({ changes: { from, to, insert: next }, userEvent: "input.format" });
  return true;
}

const indentOf = (l) => /^\s*/.exec(l)[0].replace(/\t/g, "    ").length;
/**
 * The lines moved as items: each with the more-indented lines under it (a step under its task, a line under its
 * item), and a blank line stays where it is - the runs between blank lines are reordered each on their own.
 */
function byItems(text, order) {
  const out = [];
  let block = [];
  const flush = () => {
    const items = [];
    for (const l of block) { const it = items[items.length - 1]; if (it && indentOf(l) > indentOf(it[0])) it.push(l); else items.push([l]); }
    out.push(...order(items).flat());
    block = [];
  };
  for (const l of String(text).split("\n")) { if (l.trim()) block.push(l); else { flush(); out.push(l); } }
  flush();
  return out.join("\n");
}
/** Lines A→Z by their words, a list's marks and checkboxes left out of it (2 before 10). */
export function sortLinesText(text) {
  const key = (it) => it[0].replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/, "").toLowerCase();
  return byItems(text, (items) => [...items].sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true })));
}
/** Ticked checkboxes moved below the open ones, each group in its order, each with what is under it. */
export function doneToBottomText(text) {
  const done = (it) => /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/.test(it[0]);
  return byItems(text, (items) => [...items.filter((it) => !done(it)), ...items.filter(done)]);
}
/** The lines the selection touches, changed by fn - one step to undo. */
const onLines = (fn) => (view) => {
  const { state } = view;
  const r = state.selection.main;
  // a selection that ends at the start of a line (Shift+Down) does not take that line in
  const end = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
  const from = state.doc.lineAt(r.from).from, to = state.doc.lineAt(end).to;
  const was = state.sliceDoc(from, to), next = fn(was);
  if (next !== was) view.dispatch({ changes: { from, to, insert: next }, userEvent: "input.format" });
  return true;
};
export const sortLines = onLines(sortLinesText);
export const doneToBottom = onLines(doneToBottomText);

export function changeCase(kind) {
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((r) => {
        if (r.empty) return { range: r };
        const next = cased(state.sliceDoc(r.from, r.to), kind);
        return { changes: { from: r.from, to: r.to, insert: next }, range: EditorSelection.range(r.from, r.from + next.length) };
      }),
      { userEvent: "input.format" }
    );
    return true;
  };
}

/** Take the marks off: bold, italic, strike, code, highlights and links. */
export function clearFormat(view) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      // nothing selected: the caret's line (it did nothing, without a word) - not a line with a picture or a rule
      // (![[pic]] would lose its !, *** would become a bullet), and the caret stays a caret
      let caretOnly = false;
      if (r.empty) {
        const line = state.doc.lineAt(r.head);
        if (/!\[/.test(line.text) || /^\s*([*_-])\s*\1\s*\1[\s*_-]*$/.test(line.text)) return { range: r };
        caretOnly = true;
        r = EditorSelection.range(line.from, line.to);
      }
      if (r.empty) return { range: r };
      let text = stripHighlights(state.sliceDoc(r.from, r.to));
      text = text
        .replace(/\[\[([^\[\]\n|]+)\|([^\[\]\n]*)\]\]/g, "$2")
        .replace(/\[\[([^\[\]\n|#]+)(?:#[^\[\]\n]*)?\]\]/g, "$1")
        .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
        .replace(/(\*\*\*|___)([\s\S]+?)\1/g, "$2")
        .replace(/(\*\*|__)([\s\S]+?)\1/g, "$2")
        .replace(/(\*|_)(?!\s)([\s\S]+?)\1/g, "$2")
        .replace(/~~([\s\S]+?)~~/g, "$1")
        .replace(/`([^`\n]+)`/g, "$1");
      return { changes: { from: r.from, to: r.to, insert: text }, range: caretOnly ? EditorSelection.cursor(r.from + text.length) : EditorSelection.range(r.from, r.from + text.length) };
    }),
    { userEvent: "input.format" }
  );
  return true;
}

/** Every command the app can run by name: the palette and the toolbars share it. */
export function commandMap() {
  const map = {
    bold: wrap("**"), italic: wrap("*"), strike: wrap("~~"), code: wrap("`"),
    link: insertLink, wiki: wikiLink, task: toggleTask,
    h1: setHeading(1), h2: setHeading(2), h3: setHeading(3), h4: setHeading(4), h5: setHeading(5), h6: setHeading(6),
    quote: toggleQuote, bullets: toggleBullets, numbers: toggleNumbers,
    callout: callout("note"), codeblock: codeBlock, clear: clearFormat,
    "case-upper": changeCase("upper"), "case-lower": changeCase("lower"),
    "case-title": changeCase("title"), "case-sentence": changeCase("sentence"),
    "hl-none": highlight(null), "sort-lines": sortLines, "done-bottom": doneToBottom,
  };
  for (const c of HL_COLORS) map["hl-" + c] = highlight(c);
  return map;
}
