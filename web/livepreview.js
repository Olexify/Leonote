// Live preview: Markdown renders in place and its syntax only appears where
// the caret is. Built from the parse tree over the VISIBLE ranges only, so the
// cost is proportional to the screen, not the note.

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { StateEffect, StateField, Prec, Transaction } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { WIKI_RE, TAG_RE, isTagName, findHighlights, tableCellHtml, isWebPicture } from "./mdparse.js";
import { embedAt, setEmbedWidth, embedSide, setEmbedSide } from "./images.js";
import { icon } from "./icons.js";
import { imagePicking, pickImage, pickedOf, pictureMenu, KeepPick, deleteAction } from "./imagepick.js";
import { parseYouTube, ytTitle } from "./youtube.js";
import { buildPlayer, playersFor, clock, parseClock } from "./notemedia.js";
import { confirmDialog } from "./ui.js";
import { faviconOf } from "./favicons.js";
import { cssPlain, cssFetches } from "./util.js";
import { undo as cmUndo } from "@codemirror/commands";

/* The bin on a picture's bar moves the picture itself to the trash and takes its link out - asked first
   (it sits close to the other buttons), then said, with Undo for both. A video's bin takes only its link out;
   so does a picture's when it is no file of the vault (an address on the web). */
async function removeEmbed(view, opts, r, what) {
  const m = /^!\[\[([^\]|#]+)/.exec(r.text) || /^!\[[^\]]*\]\(([^)\s]+)/.exec(r.text);
  const file = what === "picture" && m && opts.picturePath ? opts.picturePath(decodeURI(m[1].trim())) : null;
  if (file && opts.trashFiles && opts.askPictureDelete) {
    // the same question as Delete: the link only, or the file to the trash as well
    const how = await opts.askPictureDelete([file]);
    if (!how) return;
    if (how === "relink" || how === "replace") { if (opts.replacePicture) opts.replacePicture(file, how, view); return; }
    const line = view.state.doc.lineAt(r.from);
    const alone = line.text.trim() === r.text;
    view.dispatch({ changes: alone ? { from: line.from, to: Math.min(line.to + 1, view.state.doc.length) } : { from: r.from, to: r.to }, userEvent: "delete" });
    if (how === "trash") opts.trashFiles([file], view);
    else {
      if (opts.keepFiles) opts.keepFiles([file]);
      if (opts.toast) opts.toast("The picture link left the note - the file stays", { ms: 7000, actions: [{ label: "Undo", run: () => { cmUndo(view); view.focus(); } }, deleteAction([file], (p) => opts.trashFiles(p, view))] });
    }
    view.focus();
    return;
  }
  const ok = await confirmDialog(`Take the ${what} link out of the note?`, `The ${what} itself stays in the vault - only its link leaves this note. Ctrl+Z puts it back.`, { ok: "Take the link out", danger: true });
  if (!ok) return;
  const line = view.state.doc.lineAt(r.from);
  const alone = line.text.trim() === r.text;
  view.dispatch({ changes: alone ? { from: line.from, to: Math.min(line.to + 1, view.state.doc.length) } : { from: r.from, to: r.to }, userEvent: "delete" });
  if (opts.toast) opts.toast(`The ${what} link left the note - the file stays`, { ms: 5000, action: { label: "Undo", run: () => { cmUndo(view); view.focus(); } } });
  view.focus();
}

const hide = Decoration.replace({});
// when a press landed while a menu was up (heard before the menu closes itself)
let menuDownAt = 0;
if (typeof document !== "undefined") document.addEventListener("pointerdown", () => { if (document.querySelector(".menu")) menuDownAt = Date.now(); }, true);

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-task-box" + (this.checked ? " is-checked" : "");
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    return el;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(o) { return o.depth === this.depth; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet d" + (this.depth % 3);
    return el;
  }
}

// a Markdown table as a real one: cells with bold, italic, code and links
class TableWidget extends WidgetType {
  constructor(src) { super(); this.src = src; }
  eq(o) { return o.src === this.src; }
  toDOM(view) {
    const el = document.createElement("div");
    el.className = "cm-tablew";
    const rows = this.src.split("\n").map((l) => l.replace(/\\\|/g, "\u0000").trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const align = (rows[1] || []).map((c) => (/^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : ""));
    const t = document.createElement("table");
    rows.forEach((r, i) => {
      if (i === 1) return;
      const tr = t.insertRow();
      r.forEach((c, k) => { const td = document.createElement(i ? "td" : "th"); td.innerHTML = tableCellHtml(c); if (align[k]) td.style.textAlign = align[k]; tr.append(td); });
    });
    el.append(t);
    // The editor leaves the mouse here alone, so the table stays drawn: a drag selects its text (the browser will not
    // start a selection inside an uneditable part of the editor, so it is made here), and Ctrl+C copies it (tableCopy).
    // A click edits the clicked cell in place (editCell); a double-click opens the source with the caret at that cell.
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("a")) return;
      const editing = el.querySelector("td.is-editing, th.is-editing");
      if (editing && e.detail < 2 && editing.contains(e.target)) return; // the caret moves inside the cell being typed in
      e.preventDefault();
      if (editing && e.detail < 2) { // another cell: what was typed is kept, and that cell is typed in next
        const to = e.target.closest("td, th");
        editing.commitEdit(to ? [to.parentElement.rowIndex, to.cellIndex] : null);
        return;
      }
      if (editing) editing.cancelEdit();
      if (e.detail >= 2) {
        const cell = e.target.closest("td, th");
        if (!cell) return;
        view.focus();
        const tr = cell.parentElement;
        view.dispatch({ selection: { anchor: view.posAtDOM(el) + cellOffset(this.src, tr.rowIndex ? tr.rowIndex + 1 : 0, cell.cellIndex) } });
        return;
      }
      view.focus();
      const at = (ev) => document.caretRangeFromPoint(ev.clientX, ev.clientY);
      const start = at(e);
      let moved = false;
      const move = (ev) => {
        const end = at(ev);
        if (!start || !end || !el.contains(end.startContainer)) return;
        moved = true;
        document.getSelection().setBaseAndExtent(start.startContainer, start.startOffset, end.startContainer, end.startOffset);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const cell = e.target.closest("td, th");
        if ((moved && !document.getSelection().isCollapsed) || !cell) return;
        editCell(view, el, this.src, cell, { x: e.clientX, y: e.clientY });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    return el;
  }
  ignoreEvent() { return true; }
}

/** Where the text of cell `col` in line `line` of a table's source starts and ends (trimmed), from the table's start. */
export function cellRange(src, line, col) {
  const a = cellOffset(src, line, col);
  let b = a;
  while (b < src.length && src[b] !== "\n" && !(src[b] === "|" && src[b - 1] !== "\\")) b++;
  while (b > a && src[b - 1] === " ") b--;
  return [a, b];
}

/** What is typed into a cell, as its source: one line, a pipe escaped so it stays inside the cell. */
export const cellSource = (text) => text.replace(/\s*\n\s*/g, " ").replace(/\\?\|/g, "\\|").trim();

/** Where the `shown`-th character of a cell's drawn text is in its source: the marks the drawing hides
 *  (* _ ` ~ [ ] and escapes) are stepped over. ponytail: a link's (address) counts as text; close enough for a caret. */
export function sourceOffset(src, shown) {
  let i = 0;
  for (let n = 0; i < src.length && n < shown; i++) {
    if (src[i] === "\\") { i++; n++; continue; }
    if (!"*_`~[]".includes(src[i])) n++;
  }
  return i;
}

/** Types into a drawn table's cell, in place: its source text to edit, written back on Enter, Tab or a click
 *  elsewhere; Escape leaves it as it was. Enter goes down a row, Tab to the next cell (Shift+Tab back). */
function editCell(view, el, src, cell, pt) {
  const row = cell.parentElement.rowIndex, col = cell.cellIndex;
  const line = row ? row + 1 : 0;
  const [a, b] = cellRange(src, line, col);
  const was = src.slice(a, b), kept = [...cell.childNodes]; // the drawn cell, put back as it was when nothing changed
  // clicked: the caret goes where the click was, counted in the drawn text (else at the end)
  let at = was.length;
  const hit = pt && document.caretRangeFromPoint(pt.x, pt.y);
  if (hit && cell.contains(hit.startContainer)) {
    const before = document.createRange();
    before.selectNodeContents(cell);
    before.setEnd(hit.startContainer, hit.startOffset);
    at = sourceOffset(was, before.toString().length);
  }
  cell.textContent = was;
  cell.contentEditable = "true";
  cell.spellcheck = true;
  cell.classList.add("is-editing");
  cell.focus();
  const range = document.createRange();
  if (cell.firstChild) range.setStart(cell.firstChild, at); else range.selectNodeContents(cell);
  range.collapse(true);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  let done = false;
  const end = () => { done = true; cell.removeAttribute("contenteditable"); cell.classList.remove("is-editing"); cell.removeEventListener("keydown", key); cell.removeEventListener("blur", blur); };
  cell.cancelEdit = () => { if (done) return; end(); cell.replaceChildren(...kept); };
  cell.commitEdit = (to) => finish(to);
  // `back`: finished from the keyboard with no cell to go on to - the note gets the keys again (Ctrl+Z undoes the cell)
  const finish = (to, back) => {
    if (done) return;
    const text = cellSource(cell.textContent);
    end();
    const start = view.posAtDOM(el);
    if (!to && back) view.focus();
    if (text === was) { cell.replaceChildren(...kept); if (to) openCell(view, el, src, to); return; }
    const nth = [...view.contentDOM.querySelectorAll(".cm-tablew")].indexOf(el); // the redrawn table: the one in its place
    view.dispatch({ changes: { from: start + a, to: start + b, insert: text + (a === b && src[b] === "|" ? " " : "") }, userEvent: "input.table" });
    if (to) {
      const next = src.slice(0, a) + text + (a === b && src[b] === "|" ? " " : "") + src.slice(b); // the table as it now is
      // the table is drawn again once the parser has read the change: looked for over a few frames
      let tries = 0;
      const look = () => {
        const w = view.contentDOM.querySelectorAll(".cm-tablew")[nth];
        if (w && w !== el) openCell(view, w, next, to);
        else if (++tries < 30) setTimeout(look, 16);
      };
      setTimeout(look, 0); // a plain timer: a frame callback waits while the window is hidden
    }
  };
  const rows = el.querySelector("table").rows;
  const key = (e) => {
    e.stopPropagation(); // the keys are the cell's while it is typed in
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyA") { // select all: this cell's text, not the note
      e.preventDefault();
      const all = document.createRange();
      all.selectNodeContents(cell);
      document.getSelection().removeAllRanges();
      document.getSelection().addRange(all);
    }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY") && cellSource(cell.textContent) === was) {
      // nothing typed in this cell yet: undo / redo go to the note, so the last cell written comes back
      e.preventDefault();
      cell.cancelEdit();
      view.focus();
      (e.code === "KeyY" || e.shiftKey ? redo : undo)(view);
    }
    else if (e.key === "Escape") { e.preventDefault(); cell.cancelEdit(); view.focus(); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(row + 1 < rows.length ? [row + 1, col] : null, true); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const n = rows[row].cells.length;
      let r = row, c = col + (e.shiftKey ? -1 : 1);
      if (c >= n) { r++; c = 0; } else if (c < 0) { r--; c = (rows[r] || rows[0]).cells.length - 1; }
      finish(r >= 0 && r < rows.length ? [r, c] : null, true);
    }
  };
  const blur = () => finish(null);
  cell.addEventListener("keydown", key);
  cell.addEventListener("blur", blur);
}
function openCell(view, el, src, [r, c]) {
  const cell = el.querySelector("table").rows[r]?.cells[c];
  if (cell) editCell(view, el, src, cell);
}

/** Where the text of cell `col` starts in line `line` of a table's source, counted from the table's start. */
export function cellOffset(src, line, col) {
  const lines = src.split("\n");
  let at = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  const l = lines[line] || "";
  let i = l.search(/\S/);
  if (l[i] === "|") i++;
  for (let k = 0; k < col && i < l.length; i++) if (l[i] === "|" && l[i - 1] !== "\\") k++;
  while (l[i] === " ") i++;
  return at + Math.min(i, l.length);
}

// Block widgets may only come from a state field, not a view plugin: the
// tables live here. A table with the caret in it shows its source instead.
// ponytail: walks the whole tree on every change, not just the viewport; fine until notes have hundreds of tables.
// where the tables are, kept per tree and text: a caret move only checks those, it does not walk the note again
const tableSpans = new WeakMap();
const spansOf = (state) => {
  const tree = syntaxTree(state);
  const kept = tableSpans.get(tree);
  if (kept && kept.doc === state.doc) return kept.spans;
  const spans = [];
  tree.iterate({ enter(ref) {
    if (ref.name !== "Table") return !/^(Paragraph|ATXHeading|SetextHeading|FencedCode)/.test(ref.name); // no table inside those: their inline nodes go unwalked
    spans.push([state.doc.lineAt(ref.from).from, state.doc.lineAt(ref.to).to]);
    return false;
  } });
  tableSpans.set(tree, { doc: state.doc, spans });
  return spans;
};
const tableDecos = (state) => {
  const sel = state.selection.ranges;
  const out = spansOf(state).filter(([a, b]) => !sel.some((r) => r.from <= b && r.to >= a))
    .map(([a, b]) => Decoration.replace({ widget: new TableWidget(state.doc.sliceString(a, b)), block: true }).range(a, b));
  return Decoration.set(out, true);
};
// text selected inside a drawn table is the page's own selection, not the editor's: let the browser copy it
const inTable = () => { const n = document.getSelection().anchorNode; return !document.getSelection().isCollapsed && !!(n && (n.nodeType === 1 ? n : n.parentElement).closest(".cm-tablew")); };
const tableCopy = EditorView.domEventHandlers({
  copy: () => inTable(),
  cut: (e) => { if (!inTable()) return false; e.preventDefault(); e.clipboardData.setData("text/plain", document.getSelection().toString()); return true; },
});
const tableField = StateField.define({
  create: tableDecos,
  update: (v, tr) => (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? tableDecos(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f),
});

// A link that stands alone on its line, shown as a card in its place (its address comes back
// while the caret or a selection is on the line): the page's title, a line about it, its picture
// and where it lives. Fetched once per page and kept for the session.
const CARDS = new Map();
const ASKING = new Map(); // url -> the request on its way
// a page that gives no title (or turns the request away): its address says it -
// ".../film-special-effects-bell-ringing-43862/" is "Film special effects bell ringing"
export function titleFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    const t = decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+]+/g, " ").replace(/\s+\d{3,}$/, "").trim();
    return /[a-z]/i.test(t) ? t[0].toUpperCase() + t.slice(1) : "";
  } catch { return ""; }
}
// the picture a page names for its card, as an address the card may load with no click: never one on this computer
// or the local network, as linkcard.rs's public_host judges the page itself (the page is someone else's, the request would be ours).
// Reads the address only: link_picture fetches it, and judges what the name resolves to and any redirect.
export function cardPicture(src, page) {
  let x; try { x = new URL(src, page); } catch { return ""; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return "";
  const h = x.hostname.toLowerCase().replace(/\.$/, "");
  let ok;
  if (h[0] === "[") ok = /^\[(?!2002:)[23][0-9a-f]{3}:/.test(h); // IPv6: global unicast only
  else if (/^[\d.]+$/.test(h)) {
    const [a, b, c] = h.split(".").map(Number);
    ok = !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && (b & 0xc0) === 64) || (a === 169 && b === 254) || (a === 172 && (b & 0xf0) === 16)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b & 0xfe) === 18));
  } else ok = h.includes(".") && !/\.(localhost|local|lan|internal)$/.test(h);
  return ok ? x.href : "";
}
// the pictures and icons of cards, one request each: a line drawn again does not ask again
// ponytail: bounded by count (64, at most 2 MB each), not bytes; a byte budget if cards ever weigh on memory
const PICS = new Map();
const cardImage = (opts, src) => {
  let p = PICS.get(src);
  if (!p) {
    p = opts.linkPicture ? opts.linkPicture(src).catch(() => "") : Promise.resolve("");
    PICS.set(src, p);
    if (PICS.size > 64) PICS.delete(PICS.keys().next().value);
  }
  return p;
};
class LinkCard extends WidgetType {
  constructor(url, opts, label = "") { super(); this.url = url; this.opts = opts; this.label = label; }
  eq(o) { return o.url === this.url && o.label === this.label; }
  toDOM(view) {
    const url = /^www\./i.test(this.url) ? "https://" + this.url : this.url;
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } })();
    const where = (() => { try { const u = new URL(url); return host + decodeURIComponent(u.pathname).replace(/\/$/, "").replace(/\//g, " › "); } catch { return url; } })();
    const el = document.createElement("a");
    el.className = "cm-linkcard";
    el.dataset.url = url;
    el.title = url;
    const fav = document.createElement("img"); fav.className = "cm-linkcard-fav"; fav.alt = ""; fav.addEventListener("error", () => fav.remove());
    const known = faviconOf(url);
    if (known) fav.src = known;
    else cardImage(this.opts, `https://${host}/favicon.ico`).then((s) => { if (s) fav.src = s; else fav.remove(); });
    const text = document.createElement("span"); text.className = "cm-linkcard-text";
    const title = document.createElement("span"); title.className = "cm-linkcard-title"; title.textContent = this.label || titleFromUrl(url) || host;
    const desc = document.createElement("span"); desc.className = "cm-linkcard-desc"; desc.textContent = "";
    const site = document.createElement("span"); site.className = "cm-linkcard-site"; site.textContent = where;
    text.append(title, desc, site);
    const pic = document.createElement("img"); pic.className = "cm-linkcard-pic"; pic.alt = ""; pic.hidden = true; pic.addEventListener("error", () => { pic.hidden = true; });
    el.append(fav, text, pic);
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.opts.openUrl && this.opts.openUrl(url); });
    // a right-click: the link's own menu, with its text in the note (for "title" / "bare address")
    el.addEventListener("contextmenu", (e) => {
      if (!this.opts.linkMenu) return;
      e.preventDefault(); e.stopPropagation();
      let span = null;
      try {
        const line = view.state.doc.lineAt(view.posAtDOM(el));
        const m = /^\s*(?:\[([^\]\n]*)\]\((\S+)\)|(\S+))\s*$/.exec(line.text);
        if (m) { const lead = line.text.length - line.text.trimStart().length; const text = line.text.trim(); span = { view, from: line.from + lead, to: line.from + lead + text.length, text, title: m[1] != null ? m[1] : null, url: m[2] || m[3] }; }
      } catch { /* no place found: the menu without the title choices */ }
      this.opts.linkMenu(this.url, e.clientX, e.clientY, span);
    });
    const paint = (d) => {
      if (!d) return;
      if (d.title && !this.label) title.textContent = d.title;
      if (d.description) desc.textContent = d.description;
      if (d.site && d.site.toLowerCase() !== host) site.textContent = `${d.site} · ${where}`;
      const shot = d.image && cardPicture(d.image, url);
      if (shot) cardImage(this.opts, shot).then((s) => { if (s) { pic.src = s; pic.hidden = false; } });
    };
    if (CARDS.has(url)) paint(CARDS.get(url));
    else if (this.opts.linkPreview) {
      // one request per page, shared while it is on its way: a line drawn again (a scroll, a keystroke near
      // it) or the same link twice does not ask again
      let p = ASKING.get(url);
      if (!p) {
        p = this.opts.linkPreview(url).then((d) => d || {}, () => ({})).then((d) => {
          ASKING.delete(url);
          CARDS.set(url, d);
          if (CARDS.size > 500) CARDS.delete(CARDS.keys().next().value); // bounded: the oldest goes
          return d;
        });
        ASKING.set(url, p);
      }
      p.then(paint);
    }
    return el;
  }
  ignoreEvent() { return true; }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr";
    return el;
  }
}

// a code block's first line: its language, and a Copy for the code under it
class FenceLabel extends WidgetType {
  constructor(lang, code) { super(); this.lang = lang; this.code = code; }
  eq(o) { return o.lang === this.lang && o.code === this.code; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-fence-label";
    el.textContent = this.lang || "";
    const copy = document.createElement("button");
    copy.className = "cm-fence-copy";
    copy.textContent = "Copy";
    copy.title = "Copy the code";
    copy.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    copy.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard.writeText(this.code).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1400); }).catch(() => {});
    });
    el.append(copy);
    return el;
  }
  ignoreEvent() { return true; }
}

/* Inline code: one small Copy that comes to whichever piece of code the pointer rests on. */
const inlineCopy = ViewPlugin.fromClass(class {
  constructor(view) {
    this.btn = document.createElement("button");
    this.btn.className = "cm-inline-copy";
    this.btn.textContent = "Copy";
    this.btn.hidden = true;
    this.btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    this.btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard.writeText(this.text || "").then(() => { this.btn.textContent = "Copied"; setTimeout(() => { this.btn.textContent = "Copy"; }, 1200); }).catch(() => {});
    });
    this.btn.addEventListener("mouseleave", () => this.hide());
    document.body.append(this.btn);
    this.over = (e) => {
      const el = e.target.closest && e.target.closest(".cm-inline-code");
      if (!el) { if (!this.btn.contains(e.relatedTarget)) this.hide(); return; }
      // the code itself: its pieces together, without the backticks around it
      let a = el;
      while (a.previousElementSibling && a.previousElementSibling.classList.contains("cm-inline-code")) a = a.previousElementSibling;
      let text = "";
      for (let n = a; n && n.classList && n.classList.contains("cm-inline-code"); n = n.nextElementSibling) text += n.textContent;
      this.text = text.replace(/^`+|`+$/g, "").trim();
      if (!this.text) return;
      const r = el.getBoundingClientRect();
      this.btn.style.left = Math.round(r.right + 2) + "px";
      this.btn.style.top = Math.round(r.top + r.height / 2 - 10) + "px";
      this.btn.hidden = false;
    };
    view.contentDOM.addEventListener("mouseover", this.over);
    view.scrollDOM.addEventListener("scroll", (this.hide = () => { this.btn.hidden = true; }), { passive: true });
    this.view = view;
  }
  destroy() { this.view.contentDOM.removeEventListener("mouseover", this.over); this.view.scrollDOM.removeEventListener("scroll", this.hide); this.btn.remove(); }
});

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i;
const SKETCH_EXT = /\.(leocanvas|leopaint|leovector|excalidraw)$/i;
// a line made only of image or drawing embeds (wiki or Markdown), with spaces between
const PICTURE_LINE = /^\s*(?:(?:!\[\[[^\[\]\n]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|leocanvas|leopaint|leovector|excalidraw)(?:\|[^\[\]\n]*)?\]\]|!\[[^\]\n]*\]\([^)\n]+\))\s*)+$/i;

// A drawing embedded in a note: a static preview drawn by the sketch module
// (loaded on first use), with the same toolbar idea as pictures.
const sketchCache = new Map(); // path + mtime + theme -> SVG element (cloned per use)

// Previews come from our renderer, but the drawing file is user data: keep
// only inert SVG (no scripts, no foreign HTML, no event handlers, no js: links).
function inertSvg(svg) {
  let el = svg;
  if (typeof svg === "string") {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    el = doc.documentElement;
    if (!el || el.nodeName.toLowerCase() !== "svg") return null;
  }
  if (!el || !el.querySelectorAll) return null;
  // not drawing: a script, a page inside it, page-wide styles, animations that can rewrite an attribute later
  for (const bad of el.querySelectorAll("script, foreignObject, iframe, object, embed, style, animate, set, animateMotion, animateTransform, discard, handler, listener")) bad.remove();
  for (const node of [el, ...el.querySelectorAll("*")]) {
    for (const at of [...node.attributes]) {
      const n = at.name.toLowerCase();
      // a link may only point inside the drawing (#id) or at a picture carried in it (data:image/…): no
      // javascript: (however it is spelled), no address that would be fetched; styles may not fetch anything either
      // read as CSS would: escapes decoded ("\75 rl(" is "url("), blanks and controls gone
      const v = cssPlain(at.value);
      const href = n === "href" || n.endsWith(":href") || n === "src";
      // in any attribute, nothing that would fetch: only url(#…), inside the drawing, may stay
      const fetches = cssFetches(v);
      // a link is read as the address parser reads it, not as CSS: blanks and controls out, no backslash at all
      // (the ends trimmed as the parser trims them; a space, control character or backslash left inside: refused)
      const raw = at.value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
      const inside = !/[\u0000- \u007f\\]/.test(raw) && (raw.startsWith("#") || /^data:image\/(png|jpe?g|webp|gif);/i.test(raw));
      if (n.startsWith("on") || fetches || (href && !inside)) node.removeAttribute(at.name);
    }
  }
  return document.importNode(el, true);
}
// ![[clip.mp4]] and ![[song.mp3]]: played right in the note, with the
// browser's own controls. A video takes Obsidian's |width like a picture.
const MEDIA_EXT = /\.(mp4|webm|mkv|mov|m4v|ogv|mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i;
class FloatBreak extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-float-break"; return s; }
  ignoreEvent() { return false; }
}
const floatBreak = new FloatBreak();

class MediaWidget extends WidgetType {
  constructor(hit, width, opts, side) { super(); this.hit = hit; this.width = width; this.opts = opts; this.side = side || ""; }
  eq(o) { return o.hit.url === this.hit.url && o.width === this.width && o.side === this.side; }
  // a new width or side keeps the very same player: what is playing plays on
  updateDOM(dom) {
    if (!dom._player || dom._url !== this.hit.url) return false;
    this.shape(dom);
    return true;
  }
  shape(wrap) {
    wrap.className = "cm-media" + (this.hit.audio ? " is-audio" : " is-video") + (this.side ? " is-float-" + this.side : "") + (this.width ? " has-w" : "")
      + ["is-picked", "is-playing", "is-tall", "is-idle", "is-broken"].filter((c) => wrap.classList.contains(c)).map((c) => " " + c).join("");
    wrap.style.width = this.width ? this.width + "px" : "";
    wrap._side = this.side;
  }
  toDOM(view) {
    const { path, audio } = this.hit;
    const opts = this.opts;
    const wrap = document.createElement("span");
    wrap._url = this.hit.url;
    this.shape(wrap);
    const range = () => { try { return embedAt(view.state.doc, view.posAtDOM(wrap)); } catch { return null; } };
    const write = (r, text, extra = {}) => view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, annotations: KeepPick.of(true), userEvent: "input", ...extra });
    const pick = (e) => { const r = range(); if (r && !pickedOf(view.state).includes(r.from)) pickImage(view, r.from, { add: !!e && (e.ctrlKey || e.metaKey), range: !!e && e.shiftKey }); };
    // the moment, written where the caret is: [[clip.mp4#t=1:23|1:23]] jumps back to it
    const onStamp = (t) => {
      const r = range();
      if (!r) return;
      const target = (/^!\[\[([^|\]#]+)/.exec(r.text) || [])[1] || this.hit.name;
      let at = view.state.selection.main.head;
      if (at >= r.from && at < r.to) at = r.to;
      const before = at > 0 ? view.state.doc.sliceString(at - 1, at) : "\n";
      const text = (/\s/.test(before) ? "" : " ") + `[[${target.trim()}#t=${clock(t)}|${clock(t)}]]` + (/^\s/.test(view.state.doc.sliceString(at, at + 1)) ? "" : " ");
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input" });
      view.focus();
    };
    const player = buildPlayer(wrap, {
      hit: this.hit,
      settings: () => (opts.notePlayer ? opts.notePlayer() : {}),
      setSetting: (k, v) => opts.setNotePlayer && opts.setNotePlayer(k, v),
      editorRoot: () => view.dom,
      onResize: () => view.requestMeasure(),
      onStamp,
      onFullscreen: audio || !opts.onImageOpen ? undefined : (t) => { const r = range(); if (r) opts.onImageOpen(view, r.from, { t }); },
    });
    const setSide = (next) => {
      const r = range();
      if (!r) return;
      const text = setEmbedSide(r.text, next);
      const end = view.state.doc.lineAt(r.from).to + text.length - r.text.length;
      write(r, text, { selection: next ? { anchor: end } : undefined, effects: declineBeside.of({ at: r.from, on: !next }), annotations: undefined });
      view.focus();
    };
    const remove = () => { const r = range(); if (r) removeEmbed(view, opts, r, "video"); };
    const edit = () => { const r = range(); if (r) { view.dispatch({ selection: { anchor: r.to - 2 }, effects: editEmbed.of({ from: r.from, to: r.to }) }); view.focus(); } };
    const open = (e) => { player.media.pause(); if (opts.openFile) opts.openFile(path, e && (e.ctrlKey || e.metaKey)); };
    const tool = (ico, title, run) => {
      const b = document.createElement("button");
      b.className = "cm-media-btn";
      b.title = title;
      b.append(icon(ico));
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); run(e); });
      return b;
    };
    // dragged by this handle (the player itself keeps its clicks and seeking): into a row beside a picture or
    // another video, or anywhere in the note, as a picture is
    const handle = tool("drag", "Drag to move it - onto a picture's or video's side to put it in that row", () => {});
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      const r = range();
      if (!r) { e.preventDefault(); return; }
      e.dataTransfer.setData("application/x-leonote-embed", JSON.stringify(r));
      e.dataTransfer.setData("text/plain", r.text);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setDragImage(wrap, 16, 16);
    });
    const bar = document.createElement("span");
    bar.className = "cm-media-bar";
    bar.append(
      handle,
      tool("columns", "Text beside it: left, right, off", () => setSide({ "": "left", left: "right", right: "" }[wrap._side || ""])),
      tool("expand", "Open in its own tab", open),
      tool("edit", "Edit the link", edit),
      tool("trash", "Remove from the note (the file stays)", remove));
    const grips = (audio ? ["e", "w"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"]).map((dir) => {
      const g = document.createElement("span");
      g.className = "cm-img-grip is-" + dir;
      g.dataset.dir = dir;
      g.title = "Drag to resize · double-click for the usual size";
      return g;
    });
    wrap.append(bar, ...grips);

    // a click picks it, like a picture - and, on the video itself, plays it
    player.box.addEventListener("mousedown", (e) => { if (!e.target.closest(".nv-vol-range")) e.preventDefault(); });
    player.box.addEventListener("click", (e) => {
      if (e.target.closest(".nv-row, .nv-seek")) return;
      e.preventDefault();
      if (e.detail > 1) return;
      pick(e);
      if (!audio && !(e.ctrlKey || e.metaKey || e.shiftKey)) player.toggle();
    });
    if (!audio) player.box.addEventListener("dblclick", (e) => { if (e.target.closest(".nv-row, .nv-seek")) return; e.preventDefault(); player.fullscreen(); });
    wrap.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!opts.menu) return;
      pick();
      const on = !player.media.paused;
      opts.menu(e.clientX, e.clientY, [
        { label: on ? "Pause" : "Play", icon: on ? "pauseSolid" : "playSolid", keys: "Enter", run: () => player.toggle() },
        { label: "Put this moment in the note", icon: "clock", run: () => player.stamp() },
        { label: "Loop", icon: "repeat", checked: player.media.loop, run: () => player.key("l") },
        audio ? null : { label: "Full screen, with the note's pictures", icon: "fullscreen", keys: "Double-click", run: () => player.fullscreen() },
        { label: "Open in its own tab", icon: "expand", run: () => open() },
        opts.playInPlayer ? { label: "Play in the Player", icon: "music", run: () => { const t = player.media.currentTime; player.media.pause(); opts.playInPlayer(path, t); } } : null,
        "sep",
        ...(opts.pictureExtras ? opts.pictureExtras(this.hit.name).slice(0, 3) : []),
        { label: "Copy path", icon: "link", run: () => { navigator.clipboard.writeText(path); if (opts.toast) opts.toast("Path copied", { ms: 1400 }); } },
        "sep",
        { label: "Text beside it, on the right", icon: "columns", checked: wrap._side === "left", run: () => setSide("left") },
        { label: "Text beside it, on the left", icon: "columns", checked: wrap._side === "right", run: () => setSide("right") },
        { label: "Text below it", icon: "arrowDown", checked: !wrap._side, run: () => setSide("") },
        "sep",
        { label: "The usual size", icon: "undo", keys: "0", run: () => { const r = range(); if (r) write(r, setEmbedWidth(r.text, 0)); } },
        { label: "Edit the link", icon: "edit", run: edit },
        { label: "Remove from the note", icon: "trash", keys: "Del", run: remove },
      ]);
    });

    for (const grip of grips) {
      const dir = grip.dataset.dir;
      grip.addEventListener("mousedown", (e) => e.preventDefault());
      grip.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
      grip.addEventListener("dblclick", (e) => { e.preventDefault(); const r = range(); if (r) write(r, setEmbedWidth(r.text, 0)); });
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX, y0 = e.clientY;
        const box = wrap.getBoundingClientRect();
        const w0 = box.width;
        const ar = box.height ? box.width / box.height : 1;
        const pull = (ev) => {
          const dx = (dir.includes("w") ? -1 : dir.includes("e") ? 1 : 0) * (ev.clientX - x0);
          const dy = (dir.includes("n") ? -1 : dir.includes("s") ? 1 : 0) * (ev.clientY - y0) * ar;
          return dir.length === 2 ? (Math.abs(dx) > Math.abs(dy) ? dx : dy) : dx || dy;
        };
        const max = view.contentDOM.clientWidth;
        let w = w0;
        try { grip.setPointerCapture(e.pointerId); } catch {}
        wrap.classList.add("is-resizing");
        let over = false;
        const move = (ev) => {
          if (!ev.buttons) return up();
          w = Math.round(Math.max(audio ? 220 : 160, Math.min(max, w0 + pull(ev))));
          wrap.style.width = w + "px";
          wrap.classList.add("has-w");
        };
        const up = () => {
          if (over) return;
          over = true;
          grip.removeEventListener("pointermove", move);
          for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) grip.removeEventListener(t, up);
          wrap.classList.remove("is-resizing");
          const r = range();
          if (r && Math.abs(w - w0) >= 2) write(r, setEmbedWidth(r.text, w));
        };
        grip.addEventListener("pointermove", move);
        for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) grip.addEventListener(t, up);
      });
    }
    return wrap;
  }
  destroy(dom) { if (dom._player) dom._player.destroy(); }
  // its own clicks stay its own; a drag over it reaches the editor (a row to join, a place to drop)
  ignoreEvent(e) { return e.type !== "dragover" && e.type !== "drop" && e.type !== "dragleave"; }
}

class SketchWidget extends WidgetType {
  constructor(path, stamp, width, opts) { super(); this.path = path; this.stamp = stamp; this.width = width; this.opts = opts; }
  eq(o) { return o.path === this.path && o.stamp === this.stamp && o.width === this.width; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-sketch";
    if (this.width) wrap.style.width = this.width + "px";
    wrap.title = "Click to open the drawing";
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const key = this.path + "|" + this.stamp + "|" + theme;
    const fill = (svg) => {
      wrap.replaceChildren();
      if (!svg) { wrap.classList.add("is-empty"); wrap.textContent = "Empty drawing - click to draw"; return; }
      wrap.append(svg.cloneNode(true));
    };
    if (sketchCache.has(key)) fill(sketchCache.get(key));
    else {
      wrap.classList.add("is-loading");
      Promise.resolve(this.opts.sketchPreview && this.opts.sketchPreview(this.path, theme)).then((svg) => {
        const clean = svg ? inertSvg(svg) : null;
        // only the newest version of a drawing is kept (each save is a new key), and at most 40 drawings
        const pre = this.path + "|";
        for (const k of [...sketchCache.keys()]) if (k.startsWith(pre)) sketchCache.delete(k);
        sketchCache.set(key, clean);
        if (sketchCache.size > 40) sketchCache.delete(sketchCache.keys().next().value);
        wrap.classList.remove("is-loading");
        fill(clean);
      }).catch(() => { wrap.classList.remove("is-loading"); fill(""); });
    }
    wrap.addEventListener("mousedown", (e) => e.preventDefault());
    wrap.addEventListener("click", (e) => {
      e.preventDefault();
      if (this.opts.openFile) this.opts.openFile(this.path, e.ctrlKey || e.metaKey);
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

// An embedded picture: a click picks it (the caret lands right after it, its
// toolbar stays up; Shift/Ctrl pick more - imagepick.js), a double click
// opens the full-screen viewer. A toolbar on hover
// (line above / below, full screen, edit the link, remove), a corner grip to
// resize (written back as Obsidian's |width), and drag to move it.
const IMG_ACTIONS = [
  ["above", "arrowUp", "New line above"],
  ["below", "arrowDown", "New line below"],
  ["open", "expand", "Full screen (double-click, or Enter)"],
  ["size", "settings", "Size and arrangement (right-click)"],
  "sep",
  // the picture's place: the two it is not in are offered (Tab after the picture cycles them)
  ["sideLeft", "picLeft", "Picture on the left, text runs beside it"],
  ["sideNone", "picAlone", "Picture on a line of its own, text below"],
  ["sideRight", "picRight", "Picture on the right, text runs beside it"],
  "sep",
  ["edit", "edit", "Edit the link"],
  ["remove", "trash", "Move the picture to the trash (its link leaves the note too) - asked first"],
];

/* A picture's size, remembered from the first time it loaded. With it the
   <img> reserves its box before the file arrives, so scrolling past pictures
   that load late no longer makes the page jump under the reader. */
/* Pictures' shapes, remembered: a note lays a picture out at its size before it has loaded. Kept in the
   vault (.leonote/picture-sizes.json, by the picture's path in it), so they come along to any computer;
   without the app's store (the browser mock) in this browser's storage. */
const DIMS_KEY = "leonote.imgDims";
let dims = null;
let picRoot = "";
let picSave = null;
/** A picture's address as its path in the vault (the same on every computer); anything else as it is. */
const picKey = (src) => {
  let s = String(src).split("?")[0];
  if (!picRoot || /^(data|blob):/.test(s)) return s;
  try { s = decodeURIComponent(s); } catch { /* as it is */ }
  s = s.replace(/\\/g, "/");
  const i = s.toLowerCase().indexOf(picRoot);
  return i >= 0 ? s.slice(i + picRoot.length) : s;
};
const loadDims = () => { if (!dims) { try { dims = new Map(JSON.parse(localStorage.getItem(DIMS_KEY) || "[]")); } catch { dims = new Map(); } } };
const dimsOf = (src) => { loadDims(); return dims.get(picKey(src)); };
/** main.js: the vault's root and its store; what this browser remembered before moves in. */
export function setPictureStore({ root, load, save }) {
  loadDims();
  picRoot = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() + "/";
  picSave = save;
  const old = [...dims].map(([k, v]) => [picKey(k), v]);
  return load().then((o) => {
    dims = new Map([...old, ...Object.entries(o && typeof o === "object" ? o : {})]);
    if (old.length) { saveDims(); try { localStorage.removeItem(DIMS_KEY); } catch { /* fine */ } }
    // the notes already open lay their pictures out again, now with their sizes
    for (const v of liveViews) if (v.dom.isConnected) v.dispatch({ effects: refreshHeights.of(null) }); else liveViews.delete(v);
  }).catch(() => {});
}
const liveViews = new Set();
let dimsTimer = 0;
function saveDims() {
  clearTimeout(dimsTimer);
  dimsTimer = setTimeout(() => {
    const keep = [...dims].slice(-6000);
    if (picSave) picSave(Object.fromEntries(keep)).catch(() => {});
    else { try { localStorage.setItem(DIMS_KEY, JSON.stringify(keep)); } catch { /* full */ } }
  }, 1500);
}
function noteDims(src, w, h) {
  if (!w || !h || /^(data|blob):/.test(src)) return;
  const k = picKey(src);
  const old = dimsOf(src);
  if (old && old[0] === w && old[1] === h) return;
  dims.delete(k);
  dims.set(k, [w, h]);
  saveDims();
}

// a picture's edits changed (the editor closed, or the viewer's switch moved)
if (typeof document !== "undefined") document.addEventListener("leonote:image-edits", () => { for (const el of document.querySelectorAll(".cm-img")) if (el._edits) el._edits(); });

/* Pictures' lines keep their height while they are not drawn. The editor lays a note out from what
   the document itself carries, before anything is drawn - and the pictures are drawn only near the
   screen - so each line with a picture whose shape is remembered gets an invisible marker of its
   height: the picture's width (|420, or its own, held to the note's column) by its shape. Scrolling
   to a picture then moves nothing. */
let noteRoom = 700; // the note's column, last seen
// a picture whose shape is not known yet holds this box until it has loaded, as a video's player holds 16:9:
// the line has its height from the start, and the note does not jump when the picture comes in (once - then it is known)
const UNSIZED = [480, 360];
const refreshHeights = StateEffect.define();
class HeightHint extends WidgetType {
  constructor(h) { super(); this.h = h; }
  eq(o) { return o.h === this.h; }
  get estimatedHeight() { return this.h; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-height-hint"; return s; }
  ignoreEvent() { return true; }
}
function pictureHeights(opts) {
  const build = (doc) => {
    if (!opts.resolveImage || doc.length > 400000) return Decoration.none;
    // the note's picture layout caps a picture's height in some of them (wide: 80% of the window, collage: 75%)
    const layout = (document.querySelector("#view-note") || {}).dataset?.pictures;
    const cap = layout === "wide" ? innerHeight * 0.8 : layout === "collage" ? innerHeight * 0.75 : Infinity;
    const out = [];
    let pos = 0;
    for (const text of doc.iterLines()) {
      if (text.indexOf("![[") >= 0) {
        let tallest = 0;
        WIKI_RE.lastIndex = 0;
        for (const m of text.matchAll(WIKI_RE)) {
          const target = m[1].trim();
          if (text[m.index - 1] !== "!" || !IMAGE_EXT.test(target)) continue;
          const url = opts.resolveImage(target);
          const d = url && (dimsOf(url) || (/^(data|blob):/.test(url) ? null : UNSIZED));
          if (!d) continue;
          const parts = m[3] ? m[3].split("|").map((p) => p.trim().toLowerCase()) : [];
          const asked = parts.find((p) => /^\d+$/.test(p));
          let w = Math.min(asked ? +asked : d[0], noteRoom);
          if (parts.includes("left") || parts.includes("right")) w = Math.min(w, noteRoom * 0.55);
          tallest = Math.max(tallest, Math.round(Math.min(cap, (w * d[1]) / d[0])) + 8);
        }
        if (tallest >= 40) out.push(Decoration.widget({ widget: new HeightHint(tallest), side: 1 }).range(pos + text.length));
      }
      pos += text.length + 1;
    }
    return Decoration.set(out);
  };
  // a change away from any picture line only moves the markers along
  const touchesPictures = (tr) => {
    let hit = false;
    tr.changes.iterChangedRanges((fa, ta, fb, tb) => {
      if (hit) return;
      const was = tr.startState.doc, now = tr.state.doc;
      hit = was.sliceString(was.lineAt(fa).from, was.lineAt(ta).to).includes("![[") || now.sliceString(now.lineAt(fb).from, now.lineAt(tb).to).includes("![[");
    });
    return hit;
  };
  return StateField.define({
    create: (s) => build(s.doc),
    update: (v, tr) => (tr.effects.some((e) => e.is(refreshHeights)) || (tr.docChanged && touchesPictures(tr)) ? build(tr.state.doc) : tr.docChanged ? v.map(tr.changes) : v),
    provide: (f) => EditorView.decorations.from(f),
  });
}

export const shownPics = new Set(); // web pictures loaded with a click: they stay loaded while Leonote runs

class ImageWidget extends WidgetType {
  constructor(src, width, alt, opts, side = "", link = "") { super(); this.src = src; this.width = width; this.alt = alt; this.opts = opts; this.side = side; this.link = link; }
  eq(o) { return o.src === this.src && o.width === this.width && o.side === this.side && o.link === this.link; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-img" + (this.side ? " is-float-" + this.side : "");
    wrap.draggable = true;
    const img = document.createElement("img");
    img.className = "cm-embed-img";
    // a picture on the web waits for a click: loading it tells its site who opened the note, and when
    const held = isWebPicture(this.src) && this.opts.webPictures && !this.opts.webPictures() && !shownPics.has(this.src);
    if (held) wrap.classList.add("is-held"); else img.src = this.src;
    img.alt = this.alt || "";
    img.draggable = false;
    const known = dimsOf(this.src);
    // a long picture loads as soon as its line is made (just off screen), so it is there when reached;
    // the rest wait until they are nearly in view
    const tall = known && (Math.min(this.width || known[0], noteRoom) * known[1]) / known[0] > 500;
    img.loading = tall ? "eager" : "lazy";
    img.decoding = "async";
    const box = known || UNSIZED;
    img.width = box[0]; img.height = box[1];
    if (known) wrap.style.setProperty("--ar", (known[0] / known[1]).toFixed(3));
    else wrap.classList.add("is-unsized");
    // the picture's stored edits (drawing, colour, crop) show here too, unless
    // they were switched off in the viewer; the file itself is what loads first
    const base = this.src;
    wrap._edits = async () => {
      if (!this.opts.editedImage || wrap.classList.contains("is-held")) return;
      let url = null;
      try { url = await this.opts.editedImage(base); } catch {}
      if (!wrap.isConnected && !img.isConnected) return;
      const want = url || base;
      if (img.getAttribute("src") === want) return;
      // the edited picture keeps the box it had until it is in (a crop may change its shape then):
      // emptied, the line fell to nothing and the note jumped
      if (url) img.addEventListener("load", () => { if (!img.naturalHeight) return; wrap.style.setProperty("--ar", (img.naturalWidth / img.naturalHeight).toFixed(3)); if (img.hasAttribute("width")) { img.width = img.naturalWidth; img.height = img.naturalHeight; } view.requestMeasure(); }, { once: true });
      img.src = want;
      wrap.classList.toggle("is-edited", !!url);
    };
    wrap._edits();
    if (this.width) { img.style.width = this.width + "px"; wrap.style.setProperty("--w", this.width + "px"); wrap.classList.add("has-w"); }
    // a picture that links somewhere: a small chip in its corner opens the page
    if (this.link) {
      const chip = document.createElement("a");
      chip.className = "cm-img-link";
      // "note:Some note" links to a note in the vault (Ctrl opens it in a new tab), anything else is an address
      const note = /^note:/i.test(this.link) ? this.link.slice(5) : "";
      chip.dataset.url = this.link;
      chip.title = note ? "Open " + note : this.link;
      chip.append(icon(note ? "fileText" : "link"));
      chip.addEventListener("mousedown", (e) => e.stopPropagation());
      chip.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (note) this.opts.openLink && this.opts.openLink(note, e.ctrlKey || e.metaKey);
        else if (this.opts.openUrl) this.opts.openUrl(this.link);
      });
      wrap.append(chip);
      wrap.classList.add("has-link");
    }
    // the picture's shape, for justified rows in the collage layout
    img.addEventListener("load", () => {
      if (img.naturalHeight) wrap.style.setProperty("--ar", (img.naturalWidth / img.naturalHeight).toFixed(3));
      // the held box gives way to the picture's own shape
      if (wrap.classList.contains("is-unsized") && img.naturalWidth) { img.width = img.naturalWidth; img.height = img.naturalHeight; wrap.classList.remove("is-unsized"); }
      // a shape learnt for the first time: the height markers are made again with it
      const fresh = !dimsOf(this.src);
      noteDims(this.src, img.naturalWidth, img.naturalHeight);
      if (fresh && img.naturalWidth) requestAnimationFrame(() => { if (view.dom.isConnected) view.dispatch({ effects: refreshHeights.of(null) }); });
      wrap.classList.toggle("is-tiny", Math.min(img.clientWidth, img.clientHeight) < 90);
      // the line just changed height: the editor measures again, or a click below it lands lines away
      // (in a collage of many pictures the text under them took clicks meant far above)
      view.requestMeasure();
    }, { once: true });

    const bar = document.createElement("span");
    bar.className = "cm-img-bar";
    const here = { left: "sideLeft", right: "sideRight", "": "sideNone" }[this.side || ""];
    for (const act of IMG_ACTIONS) {
      if (act === "sep") { const sp = document.createElement("span"); sp.className = "cm-img-sep"; bar.append(sp); continue; }
      const [a, ic, title] = act;
      if (a === here) continue; // where it already is
      const b = document.createElement("button");
      b.className = "cm-img-btn";
      b.dataset.a = a;
      b.title = title;
      b.append(icon(ic));
      bar.append(b);
    }
    // eight handles, corners and edge centres; the picture keeps its shape, so
    // every one of them comes down to a new width
    const grips = ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((dir) => {
      const g = document.createElement("span");
      g.className = "cm-img-grip is-" + dir;
      g.dataset.dir = dir;
      g.title = "Drag to resize · double-click for the full size";
      return g;
    });
    wrap.append(img, bar, ...grips);
    if (held) {
      let site = ""; try { site = new URL(this.src).host; } catch {}
      const load = document.createElement("button");
      load.className = "cm-img-load";
      load.textContent = "Load picture from " + site;
      load.title = "A picture on the web - loading it lets " + site + " see that this note was opened";
      load.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      load.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); shownPics.add(this.src); wrap.classList.remove("is-held"); load.remove(); img.src = this.src; });
      wrap.append(load);
    }

    const range = () => embedAt(view.state.doc, view.posAtDOM(wrap));
    const write = (r, text) => view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, annotations: KeepPick.of(true), userEvent: "input" });

    img.title = "Click to pick · double-click to open";
    img.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.detail > 1) return; // the second half of a double click
      const r = range();
      if (!r) return;
      const mod = e.ctrlKey || e.metaKey || e.shiftKey;
      const had = pickedOf(view.state);
      // a click that only puts a menu away (the picture's own right-click menu,
      // most of all) opens nothing
      if (Date.now() - menuDownAt < 500) return;
      // already the picked one: the click has nothing left to pick, so it opens
      if (!mod && had.length === 1 && had[0] === r.from) { if (this.opts.onImageOpen) this.opts.onImageOpen(view, r.from); return; }
      pickImage(view, r.from, { add: e.ctrlKey || e.metaKey, range: e.shiftKey });
    });
    img.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (document.querySelector(".img-viewer")) return; // the first click of the pair already opened it
      const r = range();
      if (r && this.opts.onImageOpen) this.opts.onImageOpen(view, r.from);
    });
    const openMenu = (x, y) => {
      const r = range();
      if (!r || !this.opts.menu) return;
      if (!pickedOf(view.state).includes(r.from)) pickImage(view, r.from);
      this.opts.menu(x, y, pictureMenu(view, this.opts));
    };
    wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY); });
    bar.addEventListener("mousedown", (e) => e.preventDefault());
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      const r = b && range();
      if (!r) return;
      e.preventDefault();
      e.stopPropagation();
      const doc = view.state.doc;
      switch (b.dataset.a) {
        case "size": { const at = b.getBoundingClientRect(); openMenu(at.left, at.bottom + 4); return; }
        case "open": if (this.opts.onImageOpen) this.opts.onImageOpen(view, r.from); return;
        case "sideLeft": case "sideRight": case "sideNone": {
          const next = b.dataset.a === "sideLeft" ? "left" : b.dataset.a === "sideRight" ? "right" : "";
          const text = setEmbedSide(r.text, next);
          const end = view.state.doc.lineAt(r.from).to + text.length - r.text.length;
          // floated: the caret waits at the end of the line, ready to write beside it
          view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: next ? { anchor: end } : undefined, effects: declineBeside.of({ at: r.from, on: !next }), userEvent: "input" });
          break;
        }
        case "above": view.dispatch({ changes: { from: r.from, insert: "\n" }, selection: { anchor: r.from }, userEvent: "input" }); break;
        case "below": view.dispatch({ changes: { from: r.to, insert: "\n" }, selection: { anchor: r.to + 1 }, userEvent: "input" }); break;
        case "edit":
          view.dispatch({ selection: { anchor: r.to - (r.text.endsWith("]]") ? 2 : 1) }, effects: editEmbed.of({ from: r.from, to: r.to }) });
          break;
        case "remove":
          removeEmbed(view, this.opts || {}, r, "picture");
          return;
      }
      view.focus();
    });

    for (const grip of grips) {
    const dir = grip.dataset.dir;
    grip.addEventListener("mousedown", (e) => e.preventDefault()); // no drag-to-move from the grip
    grip.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    grip.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const r = range();
      if (r) write(r, setEmbedWidth(r.text, 0));
    });
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const box = img.getBoundingClientRect();
      const w0 = box.width;
      const ar = box.height ? box.width / box.height : 1;
      // how far this handle has been pulled outwards, as a change of width
      const pull = (ev) => {
        const dx = (dir.includes("w") ? -1 : dir.includes("e") ? 1 : 0) * (ev.clientX - x0);
        const dy = (dir.includes("n") ? -1 : dir.includes("s") ? 1 : 0) * (ev.clientY - y0) * ar;
        return dir.length === 2 ? (Math.abs(dx) > Math.abs(dy) ? dx : dy) : dx || dy;
      };
      // in a row of pictures the others keep room for themselves (60px each) and share the rest
      const line = wrap.closest(".cm-picture-line");
      const n = line ? Number(line.dataset.pics) || 1 : 1;
      const max = n > 1 && document.querySelector("#view-note[data-pictures=column], #view-note[data-pictures=collage]") ? line.clientWidth - (n - 1) * 66 : view.contentDOM.clientWidth;
      let w = w0;
      try { grip.setPointerCapture(e.pointerId); } catch {}
      wrap.classList.add("is-resizing");
      let over = false;
      const move = (ev) => {
        if (!ev.buttons) return up();
        w = Math.round(Math.max(40, Math.min(max, w0 + pull(ev))));
        img.style.width = w + "px";
        wrap.style.setProperty("--w", w + "px");
        wrap.classList.add("has-w");
      };
      const up = () => {
        if (over) return;
        over = true;
        grip.removeEventListener("pointermove", move);
        for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) grip.removeEventListener(t, up);
        wrap.classList.remove("is-resizing");
        const r = range();
        if (r && Math.abs(w - w0) >= 2) write(r, setEmbedWidth(r.text, w));
      };
      grip.addEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) grip.addEventListener(t, up);
    });
    }

    wrap.addEventListener("dragstart", (e) => {
      const r = range();
      if (!r) { e.preventDefault(); return; }
      e.dataTransfer.setData("application/x-leonote-embed", JSON.stringify(r));
      e.dataTransfer.setData("text/plain", r.text);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setDragImage(img, 16, 16);
    });
    return wrap;
  }
  // the widget handles its own pointer events; the editor must not move the
  // caret into it (that would swap the picture for its source)
  ignoreEvent(e) { return e.type !== "dragover" && e.type !== "drop"; }
}

// A YouTube link on its own line (or ![](youtube link)): a thumbnail with a
// play button; the real player (an iframe) only loads when clicked. "Play in
// Leonote" hands it to the app's player queue.
const ytTitles = new Map(); // id -> title | promise
const YT_LINE = /^\s*<?(https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/\S+?)>?\s*$/i;
const svgIcon = (d) => {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  return s;
};
class YouTubeWidget extends WidgetType {
  constructor(id, start, opts) { super(); this.id = id; this.start = start || 0; this.opts = opts; this.pics = !opts.ytPreviews || opts.ytPreviews(); }
  eq(o) { return o.id === this.id && o.start === this.start && o.pics === this.pics; }
  toDOM() {
    const { id, start, pics } = this;
    const wrap = document.createElement("span");
    wrap.className = "cm-yt";
    const frame = document.createElement("span");
    frame.className = "cm-yt-frame";
    const img = document.createElement("img");
    img.className = "cm-yt-thumb";
    if (pics) img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    img.alt = "";
    img.loading = "lazy";
    img.draggable = false;
    img.onerror = () => { img.remove(); frame.classList.add("is-nothumb"); };
    if (!pics) img.onerror(); // nothing asked of YouTube until it is played
    const play = document.createElement("button");
    play.className = "cm-yt-play";
    play.title = "Play here";
    play.append(svgIcon('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'));
    const title = document.createElement("span");
    title.className = "cm-yt-title";
    title.textContent = "Online video";
    const known = ytTitles.get(id);
    if (typeof known === "string") title.textContent = known;
    else if (pics) {
      const p = known || ytTitle(id).then((r) => { const t = r ? r.title : ""; ytTitles.set(id, t); return t; });
      ytTitles.set(id, p);
      p.then((t) => { if (t) title.textContent = t; });
    }
    frame.append(img, play, title);

    const bar = document.createElement("span");
    bar.className = "cm-yt-bar";
    const btn = (a, label, ic) => {
      const b = document.createElement("button");
      b.className = "cm-yt-btn";
      b.dataset.a = a;
      b.title = label;
      b.append(ic, document.createElement("span"));
      b.lastChild.textContent = label;
      return b;
    };
    bar.append(
      btn("app", "Play in Leonote", icon("music")),
      btn("queue", "Add to queue", icon("plus")),
      btn("open", "Open original", icon("globe")));
    wrap.append(frame, bar);

    const send = (queue) => document.dispatchEvent(new CustomEvent("leonote:youtube", { detail: { id, start, queue } }));
    const stopInline = () => { const f = frame.querySelector("iframe"); if (f) { f.remove(); frame.classList.remove("is-live"); } };
    wrap.addEventListener("mousedown", (e) => { if (e.button === 0) e.preventDefault(); });
    wrap.addEventListener("click", (e) => {
      e.preventDefault();
      const b = e.target.closest("[data-a]");
      if (b) {
        if (b.dataset.a === "open") this.opts.openUrl && this.opts.openUrl(`https://www.youtube.com/watch?v=${id}${start ? "&t=" + start : ""}`);
        else { if (b.dataset.a === "app") stopInline(); send(b.dataset.a === "queue"); }
        return;
      }
      if (frame.classList.contains("is-live") || !e.target.closest(".cm-yt-frame")) return;
      // the lite pattern: only now does YouTube load
      const f = document.createElement("iframe");
      f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1${start ? "&start=" + start : ""}`;
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      f.allowFullscreen = true;
      f.referrerPolicy = "strict-origin-when-cross-origin";
      f.title = title.textContent;
      frame.classList.add("is-live");
      frame.append(f);
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

// A picture shows its link text only after the pen button asks for it, not
// whenever the caret wanders next to it. The field holds that one embed's
// range while it is being edited; moving the caret out of it ends the edit.
const editEmbed = StateEffect.define();
const embedEditing = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(editEmbed)) return e.value;
    if (!v) return v;
    if (tr.docChanged) v = { from: tr.changes.mapPos(v.from, -1), to: tr.changes.mapPos(v.to, 1) };
    const s = tr.state.selection.main;
    if (s.from < v.from || s.to > v.to) return null;
    return v;
  },
});

class CalloutLabel extends WidgetType {
  constructor(kind) { super(); this.kind = kind; }
  eq(o) { return o.kind === this.kind; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-callout-label k-" + this.kind.toLowerCase();
    el.textContent = this.kind.charAt(0).toUpperCase() + this.kind.slice(1).toLowerCase();
    return el;
  }
}

function frontmatter(doc) {
  if (doc.lines < 2 || doc.line(1).text !== "---") return null;
  for (let i = 2; i <= Math.min(doc.lines, 200); i++) {
    const t = doc.line(i).text;
    if (t === "---" || t === "...") return { from: 0, to: doc.line(i).to, endLine: i };
  }
  return null;
}

function listDepth(node) {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") d++;
  return Math.max(0, d - 1);
}

function build(view, opts) {
  const { state } = view;
  const doc = state.doc;
  const deco = [];
  const focused = view.hasFocus;
  const ranges = state.selection.ranges;
  const touches = (from, to) => focused && ranges.some((r) => r.from <= to && r.to >= from);
  // a link card turns back into its address for the caret on its line, and for a selection over it: dragged
  // across cards, the note jumped
  // text with "-" or "=" under it is a heading in Markdown - but not while that line is being typed (a list
  // starting with "- " flashed the line above as a heading), and not for one lone "-" or "=": both stay plain
  const plainSetext = (node) => { const ul = doc.lineAt(node.to); return ul.text.trim().length < 2 || touches(ul.from, ul.to); };
  const editing = state.field(embedEditing, false);
  // text after a picture or a player that opens its line runs down beside it,
  // |left or no |left - unless Tab said "below" for this one
  // a picture that is one of a stack - pictures alone on the lines above or
  // below it, nothing between - does not float even if asked to: a column of
  // floats has no height of its own, and the editor loses track of where the
  // lines are (a click beside the last one lands on the first). Stacked, each
  // keeps its line; the one at the end of a stack still lets text run beside it.
  const pictureOnly = (ln) => /^\s*!\[\[[^\]]*\]\]\s*$|^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(ln.text);
  const stacked = (from) => {
    const ln = doc.lineAt(from);
    if (!pictureOnly(ln)) return false;
    const below = ln.number < doc.lines ? doc.line(ln.number + 1) : null;
    return !!(below && pictureOnly(below));
  };
  const autoSide = (from, to) => {
    const ln = doc.lineAt(from);
    const tail = doc.sliceString(to, ln.to);
    if (!tail.trim() || /!\[/.test(tail) || /!\[/.test(doc.sliceString(ln.from, from))) return ""; // alone, or one of a row of pictures
    return declined(view.state, from) ? "" : "left";
  };
  // what is written in FRONT of a floated embed keeps its own line above it:
  // only what comes after runs down the column beside it
  const frontBreak = (from, side) => {
    if (!side) return;
    const ln = doc.lineAt(from);
    if (doc.sliceString(ln.from, from).replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "").trim()) deco.push(Decoration.widget({ widget: floatBreak, side: -1 }).range(from));
    columnEnd(ln);
  };
  // The column beside a floated embed ends at the first blank line under it:
  // that line reaches down past the picture, so the paragraph after it starts
  // below - not beside a picture it has nothing to do with. The clearing is
  // inside the blank line, so its height is real and the editor measures it.
  const ended = new Set();
  const columnEnd = (ln) => {
    for (let n = ln.number + 1; n <= Math.min(doc.lines, ln.number + 200); n++) {
      const l = doc.line(n);
      if (l.text.trim()) continue;
      if (!ended.has(l.from)) { ended.add(l.from); deco.push(Decoration.line({ class: "cm-float-end" }).range(l.from)); }
      return;
    }
  };
  const editingEmbed = (from, to) => !!editing && editing.from <= to && editing.to >= from;
  const codeRanges = [];
  const inCode = (a, b) => codeRanges.some(([x, y]) => a < y && b > x);
  const fm = frontmatter(doc);
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    if (fm && from <= fm.to) {
      // note ids on: the id and the tags (kept in the Tags panel) step out of the way; the whole header
      // when that is all it holds. The caret in it (and the editor focused) brings it back to edit.
      const caret = doc.lineAt(state.selection.main.head).number;
      let hid = null;
      if (opts.hideMeta && opts.hideMeta() && !(view.hasFocus && caret <= fm.endLine)) {
        hid = new Set();
        let inTags = false;
        for (let i = 2; i < fm.endLine; i++) {
          const t = doc.line(i).text;
          if (/^id:/.test(t)) { hid.add(i); inTags = false; }
          else if (/^tags:/.test(t)) { hid.add(i); inTags = /^tags:\s*$/.test(t); }
          else if (inTags && /^\s*-\s/.test(t)) hid.add(i);
          else inTags = false;
        }
        if (hid.size === fm.endLine - 2) {
          hid.add(1); hid.add(fm.endLine);
          // and the empty line under it, or the note starts one line down
          if (fm.endLine < doc.lines && !doc.line(fm.endLine + 1).text.trim()) {
            const gap = doc.line(fm.endLine + 1);
            if (gap.from <= to) deco.push(Decoration.line({ class: "cm-front-hid" }).range(gap.from));
          }
        }
      }
      for (let i = 1; i <= fm.endLine; i++) {
        const l = doc.line(i);
        if (l.from > to) break;
        deco.push(Decoration.line({ class: "cm-front" + (i === 1 ? " is-first" : i === fm.endLine ? " is-last" : "") + (hid && hid.has(i) ? " cm-front-hid" : "") }).range(l.from));
      }
    }

    tree.iterate({
      from, to,
      enter: (ref) => {
        const name = ref.name;
        if (name === "Document") return;
        if (fm && ref.from <= fm.to) return false;

        switch (name) {
          case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
          case "ATXHeading4": case "ATXHeading5": case "ATXHeading6": {
            const line = doc.lineAt(ref.from);
            deco.push(Decoration.line({ class: "cm-h cm-h" + name.slice(-1) }).range(line.from));
            return;
          }
          case "SetextHeading1": case "SetextHeading2": {
            if (plainSetext(ref.node)) return;
            const line = doc.lineAt(ref.from);
            deco.push(Decoration.line({ class: "cm-h cm-h" + name.slice(-1) }).range(line.from));
            return;
          }
          case "HeaderMark": {
            if (ref.node.parent && /^Setext/.test(ref.node.parent.name) && plainSetext(ref.node.parent)) return;
            const line = doc.lineAt(ref.from);
            if (touches(line.from, line.to)) return;
            if (ref.from === line.from) {
              const end = doc.sliceString(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to;
              if (end > ref.from) deco.push(hide.range(ref.from, end));
            } else if (ref.to > ref.from) {
              // closing hashes, and setext underlines
              const start = doc.sliceString(ref.from - 1, ref.from) === " " ? ref.from - 1 : ref.from;
              deco.push(hide.range(start, ref.to));
            }
            return;
          }
          case "EmphasisMark":
          case "StrikethroughMark": {
            const p = ref.node.parent;
            if (p && !touches(p.from, p.to)) deco.push(hide.range(ref.from, ref.to));
            return;
          }
          case "InlineCode": {
            codeRanges.push([ref.from, ref.to]);
            deco.push(Decoration.mark({ class: "cm-inline-code" }).range(ref.from, ref.to));
            if (!touches(ref.from, ref.to)) {
              for (let c = ref.node.firstChild; c; c = c.nextSibling)
                if (c.name === "CodeMark") deco.push(hide.range(c.from, c.to));
            }
            return false;
          }
          case "FencedCode": {
            codeRanges.push([ref.from, ref.to]);
            const first = doc.lineAt(ref.from);
            const last = doc.lineAt(ref.to);
            const hot = touches(ref.from, ref.to);
            for (let n = first.number; n <= last.number; n++) {
              const l = doc.line(n);
              if (l.from > to && n > first.number) break;
              let cls = "cm-codeblock";
              if (n === first.number) cls += " is-first";
              if (n === last.number) cls += " is-last";
              // the code's lines are numbered in the margin (drawn by CSS, so they are never copied or selected)
              const fence = n === first.number || (n === last.number && /^\s*(```|~~~)\s*$/.test(l.text));
              deco.push(Decoration.line({ class: cls, attributes: fence ? {} : { "data-n": String(n - first.number) } }).range(l.from));
            }
            if (!hot) {
              const info = ref.node.getChild("CodeInfo");
              const lang = info ? doc.sliceString(info.from, info.to) : "";
              const closing = /^\s*(```|~~~)\s*$/.test(last.text) && last.number !== first.number;
              const code = last.number > first.number + (closing ? 1 : 0) ? doc.sliceString(doc.line(first.number + 1).from, closing ? doc.line(last.number - 1).to : last.to) : "";
              if (first.to > first.from) deco.push(Decoration.replace({ widget: new FenceLabel(lang, code) }).range(first.from, first.to));
              if (closing && last.to > last.from) deco.push(hide.range(last.from, last.to));
            }
            return false;
          }
          case "CodeBlock":
            codeRanges.push([ref.from, ref.to]);
            return false;
          case "Blockquote": {
            const a = doc.lineAt(ref.from).number;
            const b = doc.lineAt(ref.to).number;
            const head = /^(>\s*)\[!(\w+)\][+-]?\s?/.exec(doc.line(a).text);
            for (let n = a; n <= b; n++) {
              const l = doc.line(n);
              deco.push(Decoration.line({ class: "cm-quote" + (head ? " in-callout" : "") + (head && n === a ? " is-callout" : "") }).range(l.from));
            }
            if (head) {
              const l = doc.line(a);
              if (!touches(l.from, l.to))
                deco.push(Decoration.replace({ widget: new CalloutLabel(head[2]) }).range(l.from + head[1].length, l.from + head[0].length));
            }
            return;
          }
          case "QuoteMark": {
            const line = doc.lineAt(ref.from);
            if (!touches(line.from, line.to)) {
              const end = doc.sliceString(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to;
              deco.push(hide.range(ref.from, end));
            }
            return;
          }
          case "ListMark": {
            const item = ref.node.parent;
            if (!item || item.getChild("Task")) return;
            const bullet = item.parent && item.parent.name === "BulletList";
            if (bullet) {
              if (!touches(ref.from, ref.to + 1))
                deco.push(Decoration.replace({ widget: new BulletWidget(listDepth(item)) }).range(ref.from, ref.to));
            } else {
              deco.push(Decoration.mark({ class: "cm-ol-mark" }).range(ref.from, ref.to));
            }
            return;
          }
          case "TaskMarker": {
            const task = ref.node.parent;
            const item = task && task.parent;
            const mark = item && item.firstChild;
            const checked = /x/i.test(doc.sliceString(ref.from, ref.to));
            const start = mark && mark.name === "ListMark" ? mark.from : ref.from;
            const end = doc.sliceString(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to;
            if (!touches(start, end - 1)) {
              deco.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(start, end));
            }
            if (checked) {
              const line = doc.lineAt(ref.from);
              if (line.to > end) deco.push(Decoration.mark({ class: "cm-task-done" }).range(end, line.to));
            }
            return;
          }
          case "HorizontalRule": {
            const line = doc.lineAt(ref.from);
            if (!touches(ref.from, ref.to)) {
              deco.push(Decoration.line({ class: "cm-hr-line" }).range(line.from));
              deco.push(Decoration.replace({ widget: new HrWidget() }).range(ref.from, ref.to));
            }
            return;
          }
          case "Link": {
            // "[!note]" opening a callout is not a link
            if (doc.sliceString(ref.from, ref.from + 2) === "[!") return false;
            const marks = [];
            let url = "";
            for (let c = ref.node.firstChild; c; c = c.nextSibling) {
              if (c.name === "LinkMark") marks.push(c);
              if (c.name === "URL") url = doc.sliceString(c.from, c.to);
            }
            if (marks.length >= 2 && marks[1].from > marks[0].to) {
              const textFrom = marks[0].to;
              const textTo = marks[1].from;
              const ln = doc.lineAt(ref.from);
              const vid = /youtu/i.test(url) && opts.videoLinks && opts.videoLinks() && ln.text.trim() === doc.sliceString(ref.from, ref.to) ? parseYouTube(url) : null;
              if (vid && vid.id && !touches(ln.from, ln.to)) {
                // [title](a video's address) alone on its line: its player, playable in the note
                deco.push(Decoration.replace({ widget: new YouTubeWidget(vid.id, vid.start, opts) }).range(ref.from, ref.to));
              } else if (/^https?:/i.test(url) && opts.linkCards && opts.linkCards() && ln.text.trim() === doc.sliceString(ref.from, ref.to) && !touches(ln.from, ln.to)) {
                // [title](address) alone on its line becomes the page's card, as a bare address does
                deco.push(Decoration.replace({ widget: new LinkCard(url, opts, doc.sliceString(textFrom, textTo).trim()) }).range(ref.from, ref.to));
              } else if (!touches(ref.from, ref.to)) {
                deco.push(hide.range(ref.from, textFrom));
                deco.push(Decoration.mark({ class: "cm-link", attributes: url ? { "data-url": url } : {} }).range(textFrom, textTo));
                if (ref.to > textTo) deco.push(hide.range(textTo, ref.to));
              } else if (url) {
                deco.push(Decoration.mark({ class: "cm-link is-src", attributes: { "data-url": url } }).range(textFrom, textTo));
              }
            }
            return false;
          }
          case "Image": {
            // ![alt](path.png) - rendered in place when the caret is elsewhere.
            // The parser also sees Obsidian's ![[pic.png]] as an Image; that one
            // belongs to the wikilink pass below, so leave it alone here.
            const urlNode = ref.node.getChild("URL");
            if (!urlNode) return false;
            codeRanges.push([ref.from, ref.to]); // keep the wikilink/tag pass off it
            const src = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
            if (/youtu/i.test(src)) {
              const yt = parseYouTube(src);
              if (yt && yt.id) {
                if (!touches(ref.from, ref.to)) deco.push(Decoration.replace({ widget: new YouTubeWidget(yt.id, yt.start, opts) }).range(ref.from, ref.to));
                return false;
              }
            }
            if (editingEmbed(ref.from, ref.to) || !opts.resolveImage) return false;
            const url = src && opts.resolveImage(src);
            const alt = /^!\[([^\]]*)\]/.exec(doc.sliceString(ref.from, ref.to));
            const parts = alt ? alt[1].split("|") : [""];
            const aw = parts.slice(1).map((p) => p.trim()).find((p) => /^\d+$/.test(p));
            const as = stacked(ref.from) ? "" : (parts.slice(1).map((p) => p.trim().toLowerCase()).find((p) => p === "left" || p === "right") || autoSide(ref.from, ref.to));
            if (url) { frontBreak(ref.from, as); deco.push(Decoration.replace({ widget: new ImageWidget(url, aw ? +aw : 0, parts[0], opts, as) }).range(ref.from, ref.to)); }
            return false;
          }
          case "URL": {
            const p = ref.node.parent;
            if (!p || (p.name !== "Link" && p.name !== "Image" && p.name !== "LinkReference")) {
              const url = doc.sliceString(ref.from, ref.to);
              if (/^(https?:|www\.)/i.test(url)) {
                const ln = doc.lineAt(ref.from);
                const vid = /youtu/i.test(url) && ln.text.trim() === url ? parseYouTube(url) : null;
                // a video's bare address alone on its line: the line pass below lays its player there
                if (vid && vid.id && opts.videoLinks && opts.videoLinks()) { /* the player, from the YouTube line pass */ }
                else if (opts.linkCards && opts.linkCards() && ln.text.trim() === url && !touches(ln.from, ln.to)) deco.push(Decoration.replace({ widget: new LinkCard(url, opts) }).range(ref.from, ref.to));
                else deco.push(Decoration.mark({ class: "cm-url", attributes: { "data-url": url } }).range(ref.from, ref.to));
              }
            }
            return;
          }
          case "Table":
            for (let n = doc.lineAt(ref.from).number; n <= doc.lineAt(ref.to).number; n++)
              deco.push(Decoration.line({ class: "cm-table" }).range(doc.line(n).from));
            return false;
        }
      },
    });

    // wikilinks and tags are not CommonMark - a regex pass over visible lines
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      const text = line.text;
      if (fm && line.from <= fm.to) continue;

      // a line of nothing but pictures can leave the text column (wide /
      // collage layouts); the class is harmless in the default layout
      if (text.indexOf("![") >= 0 && PICTURE_LINE.test(text) && !/\|\s*(?:left|right)\s*[|\]]/i.test(text)) {
        const n = (text.match(/!\[/g) || []).length;
        deco.push(Decoration.line({ class: "cm-picture-line", attributes: { "data-pics": String(Math.min(n, 6)) } }).range(line.from));
      }

      // a line that is just a YouTube link: the lite embed (unless video links are switched to show as links)
      if (text.indexOf("youtu") >= 0 && !touches(line.from, line.to) && (!opts.videoLinks || opts.videoLinks())) {
        const m = YT_LINE.exec(text);
        const yt = m && parseYouTube(m[1]);
        if (yt && yt.id && !inCode(line.from, line.to)) {
          const a = line.from + text.indexOf(m[1]);
          deco.push(Decoration.replace({ widget: new YouTubeWidget(yt.id, yt.start, opts) }).range(a, a + m[1].length));
        }
      }

      if (text.indexOf("[[") >= 0) {
        WIKI_RE.lastIndex = 0;
        for (const m of text.matchAll(WIKI_RE)) {
          const a = line.from + m.index;
          const b = a + m[0].length;
          if (inCode(a, b)) continue;
          const target = m[1].trim();
          // ![[drawing.excalidraw]] - a drawing, previewed in place
          if (line.text[m.index - 1] === "!" && SKETCH_EXT.test(target) && opts.resolveSketch) {
            const hit = opts.resolveSketch(target);
            if (hit && !editingEmbed(a - 1, b)) {
              const ws = m[3] ? m[3].split("|").map((p) => p.trim()).find((p) => /^\d+$/.test(p)) : null;
              deco.push(Decoration.replace({ widget: new SketchWidget(hit.path, hit.stamp, ws ? +ws : 0, opts) }).range(a - 1, b));
              continue;
            }
          }
          // ![[clip.mp4|480]] and ![[song.mp3]] - played in place
          if (line.text[m.index - 1] === "!" && MEDIA_EXT.test(target) && opts.resolveMedia) {
            const hit = opts.resolveMedia(target);
            if (hit && !editingEmbed(a - 1, b)) {
              const ws = m[3] ? m[3].split("|").map((p) => p.trim()).find((p) => /^\d+$/.test(p)) : null;
              const side = (m[3] ? m[3].split("|").map((p) => p.trim().toLowerCase()).find((p) => p === "left" || p === "right") : "") || autoSide(a - 1, b);
              const link = m[3] ? (m[3].split("|").map((p) => p.trim()).find((p) => /^link:/i.test(p)) || "").slice(5) : "";
              frontBreak(a - 1, side);
              deco.push(Decoration.replace({ widget: new MediaWidget(hit, ws ? +ws : 0, opts, side) }).range(a - 1, b));
              continue;
            }
          }
          // ![[picture.png|300]] - Obsidian image embed
          if (line.text[m.index - 1] === "!" && IMAGE_EXT.test(target) && opts.resolveImage) {
            const url = opts.resolveImage(target);
            if (url && !editingEmbed(a - 1, b)) {
              // ![[pic.png|300]] and Obsidian's ![[pic.png|300|640x480]]
              const ws = m[3] ? m[3].split("|").map((p) => p.trim()).find((p) => /^\d+$/.test(p)) : null;
              const side = stacked(a - 1) ? "" : ((m[3] ? m[3].split("|").map((p) => p.trim().toLowerCase()).find((p) => p === "left" || p === "right") : "") || autoSide(a - 1, b));
              const link = m[3] ? (m[3].split("|").map((p) => p.trim()).find((p) => /^link:/i.test(p)) || "").slice(5) : "";
              // "20) " in front of a floated picture floats with it, so the
              // number stays where it was and the text runs down the other side
              const lead = line.text.slice(0, m.index - 1);
              if (side === "left" && /^\s*(?:[-*+]|\d{1,3}[.)])\s+$/.test(lead) && !touches(line.from, a - 1)) deco.push(Decoration.mark({ class: "cm-float-lead" }).range(line.from + (lead.length - lead.trimStart().length), a - 1));
              frontBreak(a - 1, side);
              deco.push(Decoration.replace({ widget: new ImageWidget(url, ws ? +ws : 0, target, opts, side, link) }).range(a - 1, b));
              continue;
            }
          }
          const cls = "cm-wikilink" + (opts.resolve(target) || (opts.resolveUnindexed && opts.resolveUnindexed(target)) || (opts.resolveImage && opts.resolveImage(target)) || (opts.resolveSketch && opts.resolveSketch(target)) || (opts.resolveMedia && opts.resolveMedia(target)) || (opts.resolveAnyFile && opts.resolveAnyFile(target)) ? "" : " is-missing") + (/\.(zip|7z|rar|tar|gz|tgz|bz2|xz|cab|iso)$/i.test(target.split(/[|#]/)[0].trim()) ? " is-archive" : "");
          if (touches(a, b)) {
            deco.push(Decoration.mark({ class: cls + " is-src", attributes: { "data-link": target } }).range(a, b));
            continue;
          }
          const moment = m[2] && MEDIA_EXT.test(target) ? parseClock(m[2].replace(/^#t=/i, "")) : null;
          if (moment != null) {
            const al = m[3] && m[3].trim() ? m[3] : null;
            deco.push(hide.range(a, al ? b - 2 - al.length : a + 2));
            deco.push(Decoration.mark({ class: cls + " cm-stamp", attributes: { "data-link": target, "data-t": String(moment), title: "Jump to this moment · Ctrl-click opens the file" } }).range(al ? b - 2 - al.length : a + 2, b - 2));
            deco.push(hide.range(b - 2, b));
            continue;
          }
          const alias = m[3];
          let shownFrom = a + 2;
          let shownTo = a + 2 + m[1].length + (m[2] ? m[2].length : 0);
          if (alias != null && alias.trim()) { shownFrom = b - 2 - alias.length; shownTo = b - 2; }
          deco.push(hide.range(a, shownFrom));
          deco.push(Decoration.mark({ class: cls, attributes: { "data-link": target, ...(m[2] ? { "data-place": m[2] } : {}) } }).range(shownFrom, shownTo));
          deco.push(hide.range(shownTo, b));
        }
      }

      // ==highlights== and their coloured <mark class="hl-…"> form. The marks
      // vanish like every other bit of syntax, unless the caret is in them.
      if (text.indexOf("==") >= 0 || text.indexOf("<mark") >= 0) {
        for (const hl of findHighlights(text)) {
          const a = line.from + hl.from;
          const b = line.from + hl.to;
          if (inCode(a, b) || hl.innerTo === hl.inner) continue;
          const cls = "cm-hl hl-" + hl.color;
          if (touches(a, b)) {
            deco.push(Decoration.mark({ class: "cm-hl-mark" }).range(a, line.from + hl.inner));
            deco.push(Decoration.mark({ class: cls + " is-src" }).range(line.from + hl.inner, line.from + hl.innerTo));
            deco.push(Decoration.mark({ class: "cm-hl-mark" }).range(line.from + hl.innerTo, b));
            continue;
          }
          deco.push(hide.range(a, line.from + hl.inner));
          deco.push(Decoration.mark({ class: cls }).range(line.from + hl.inner, line.from + hl.innerTo));
          deco.push(hide.range(line.from + hl.innerTo, b));
        }
      }

      // a paragraph's " ^id" (what a link to it points at) shows only while the caret is on its line
      const bid = text.indexOf("^") >= 0 && /\s\^[A-Za-z0-9-]+$/.exec(text);
      if (bid && !touches(line.from, line.to)) deco.push(hide.range(line.from + bid.index, line.to));

      if (text.indexOf("#") >= 0) {
        for (const m of text.matchAll(TAG_RE)) {
          if (!isTagName(m[2])) continue;
          const a = line.from + m.index + m[1].length;
          const b = a + 1 + m[2].length;
          if (inCode(a, b)) continue;
          deco.push(Decoration.mark({ class: "cm-tag", attributes: { "data-tag": m[2] } }).range(a, b));
        }
      }
    }
  }

  return Decoration.set(deco, true);
}

export function livePreview(opts) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) { this.view = view; this.atoms = Decoration.none; this.decorations = safeBuild(view, opts, this); this.room(view); liveViews.add(view); }
      destroy() { liveViews.delete(this.view); }
      // the note's column, measured: the picture lines' heights follow it when it changes
      room(view) {
        const r = view.contentDOM.clientWidth;
        if (r > 100 && Math.abs(r - noteRoom) > 6) { noteRoom = r; requestAnimationFrame(() => { if (view.dom.isConnected) view.dispatch({ effects: refreshHeights.of(null) }); }); }
      }
      update(u) {
        if (u.geometryChanged) this.room(u.view);
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(declineBeside))) ||
            u.startState.field(embedEditing, false) !== u.state.field(embedEditing, false) ||
            syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = safeBuild(u.view, opts, this);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        contextmenu(e, view) {
          // a code block: its own menu (copy, line numbers, its language)
          const blockLine = e.target.closest && e.target.closest(".cm-line.cm-codeblock");
          if (blockLine && opts.codeMenu && view.state.selection.main.empty) {
            const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
            let n = at == null ? null : syntaxTree(view.state).resolveInner(at, 1);
            while (n && n.name !== "FencedCode") n = n.parent;
            if (n) {
              const doc = view.state.doc;
              const first = doc.lineAt(n.from), last = doc.lineAt(n.to);
              const closing = last.number > first.number && /^\s*(```|~~~)\s*$/.test(last.text);
              const code = last.number > first.number + (closing ? 1 : 0) ? doc.sliceString(doc.line(first.number + 1).from, closing ? doc.line(last.number - 1).to : last.to) : "";
              const m = /^(\s*(?:```|~~~))\s*(\S*)/.exec(first.text) || ["", "```", ""];
              e.preventDefault();
              opts.codeMenu(e.clientX, e.clientY, { lang: m[2], code, setLang: (lang) => view.dispatch({ changes: { from: first.from, to: first.to, insert: m[1] + lang } }) });
              return true;
            }
          }
          const el = e.target.closest && e.target.closest("[data-url]");
          if (!el || !opts.linkMenu) return false;
          // inside a selection the selection's own menu comes, not the link's
          const sel = view.state.selection.main;
          const at = sel.empty ? null : view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (at != null && at >= sel.from && at <= sel.to) return false;
          e.preventDefault();
          // the link's own text in the note, so the menu can turn a bare address into a titled link and back
          let span = null;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos != null) {
            const line = view.state.doc.lineAt(pos);
            const re = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)|\bhttps?:\/\/[^\s<>()\]]+/g;
            for (let m; (m = re.exec(line.text)); ) {
              const from = line.from + m.index;
              const to = from + m[0].length;
              if (pos >= from && pos <= to) { span = { from, to, text: m[0], title: m[1] != null ? m[1] : null, url: m[2] || m[0] }; break; }
            }
          }
          opts.linkMenu(el.dataset.url, e.clientX, e.clientY, span ? { view, ...span } : null);
          return true;
        },
        mousedown(e, view) {
          if (e.button !== 0) return false;
          // a triple click on a line holding pictures takes the text that was clicked, not the
          // pictures' links with it (a click then a quick double click is three, too)
          if (e.detail === 3 && !e.shiftKey && !(e.target.closest && e.target.closest(".cm-img, .cm-media"))) {
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            const line = pos == null ? null : view.state.doc.lineAt(pos);
            const embeds = line ? [...line.text.matchAll(/!\[\[[^\[\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g)] : [];
            if (embeds.length) {
              let from = 0, to = line.text.length;
              const at = pos - line.from;
              for (const m of embeds) {
                const a = m.index, b = m.index + m[0].length;
                if (b <= at) from = Math.max(from, b);
                else if (a >= at) { to = Math.min(to, a); break; }
                else return false; // on the link itself
              }
              if (from === 0) from = (/^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s*|#{1,6}\s+)?/.exec(line.text) || [""])[0].length; // not its list marker
              const seg = line.text.slice(from, to);
              const lead = seg.length - seg.trimStart().length, trail = seg.length - seg.trimEnd().length;
              if (seg.trim()) {
                e.preventDefault();
                view.dispatch({ selection: { anchor: line.from + from + lead, head: line.from + to - trail }, userEvent: "select.pointer" });
                view.focus();
                return true;
              }
            }
          }
          // the empty space beside a floated picture belongs to the lines after it: a click there
          // puts the caret at the end of the picture's own line instead, so what is typed goes beside it
          if (!e.shiftKey && e.target.closest && !e.target.closest(".cm-img, .cm-media, .cm-task-box, [data-link], [data-url], [data-tag]")) {
            const under = e.target.closest(".cm-line");
            if (!under || under.classList.contains("cm-picture-line") || !under.textContent.trim()) {
              for (const f of view.contentDOM.querySelectorAll(".cm-img.is-float-left, .cm-img.is-float-right")) {
                const r = f.getBoundingClientRect();
                const side = f.classList.contains("is-float-right") ? e.clientX < r.left : e.clientX > r.right;
                if (!side || e.clientY < r.top || e.clientY > r.bottom || f.closest(".cm-line") === under) continue;
                let at;
                try { at = view.state.doc.lineAt(view.posAtDOM(f)).to; } catch { continue; }
                e.preventDefault();
                view.dispatch({ selection: { anchor: at }, userEvent: "select.pointer" });
                view.focus();
                return true;
              }
            }
          }
          const el = e.target.closest && e.target.closest(".cm-task-box,[data-link],[data-url],[data-tag]");
          if (!el) return false;

          if (el.classList.contains("cm-task-box")) {
            const pos = view.posAtDOM(el);
            const line = view.state.doc.lineAt(pos);
            const m = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]/.exec(line.text);
            if (!m) return false;
            const at = line.from + m[0].length - 2;
            view.dispatch({ changes: { from: at, to: at + 1, insert: m[3] === " " ? "x" : " " }, userEvent: "input.toggle" });
            e.preventDefault();
            return true;
          }

          const mod = e.ctrlKey || e.metaKey;
          const src = el.classList.contains("is-src");
          if (src && !mod) return false;
          e.preventDefault();
          if (el.dataset.t && !mod) {
            const hit = opts.resolveMedia && opts.resolveMedia(el.dataset.link);
            const pl = hit && playersFor(view.dom, hit.path)[0];
            if (pl) { pl.seek(+el.dataset.t, true); pl.box.scrollIntoView({ block: "nearest", behavior: "smooth" }); return true; }
          }
          if (el.dataset.link) opts.openLink(el.dataset.link, mod, el.dataset.place || "");
          else if (el.dataset.url) opts.openUrl(el.dataset.url);
          else if (el.dataset.tag) opts.openTag(el.dataset.tag);
          return true;
        },
      },
    }
  );
  const playerKeys = Prec.highest(EditorView.domEventHandlers({ keydown(e, view) {
    const had = pickedOf(view.state);
    if (had.length !== 1 || e.altKey) return false;
    let pl = null;
    for (const w of view.dom.querySelectorAll(".cm-media.is-picked")) if (w._player) pl = w._player;
    if (!pl) return false;
    const mod = e.ctrlKey || e.metaKey;
    let done = false;
    if (e.key === "Enter" && !mod && !e.shiftKey) { pl.toggle(); done = true; }
    else if (mod && e.key.toLowerCase() === "c") { const r = embedAt(view.state.doc, had[0]); if (r) navigator.clipboard.writeText(r.text).catch(() => {}); done = true; }
    else if (e.shiftKey && !mod) done = pl.key(e.key);
    if (done) { e.preventDefault(); e.stopPropagation(); }
    return done;
  } }));
  // a picture taken out with Backspace or Delete says so too, with Undo - as the bin on its bar does
  const pictureGone = EditorView.updateListener.of((u) => {
    if (!u.docChanged || !opts.toast) return;
    for (const tr of u.transactions) {
      const ev = tr.annotation(Transaction.userEvent) || "";
      if (!/^delete\.(backward|forward|selection)/.test(ev)) continue;
      const gone = [];
      tr.changes.iterChanges((fa, ta) => { gone.push(...(u.startState.doc.sliceString(fa, ta).match(/!\[\[[^\]\n]+\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)(\|[^\]\n]*)?\]\]|!\[[^\]\n]*\]\([^)\n]+\)/gi) || [])); });
      const n = gone.length;
      const paths = opts.picturePath ? gone.map((t) => { const m = t.match(/^!\[\[([^\]|]+)/) || t.match(/^!\[[^\]]*\]\(([^)]+)\)/); try { return m ? opts.picturePath(decodeURI(m[1].trim())) : null; } catch { return null; } }) : [];
      if (n) opts.toast(`${n > 1 ? `${n} picture links` : "The picture link"} left the note - the file${n > 1 ? "s stay" : " stays"}`, { ms: 7000, actions: [{ label: "Undo", run: () => { cmUndo(u.view); u.view.focus(); } }, opts.trashFiles ? deleteAction(paths, (p) => opts.trashFiles(p, u.view)) : null] });
    }
  });
  return [inlineCopy, playerKeys, embedEditing, besideDeclined, besideTyping, imagePicking(opts), plugin, tableField, tableCopy, pictureHeights(opts), pictureGone, EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms || Decoration.none), besideHint, besideKeys];
}

/* ── writing beside a picture ──────────────────────────────────────────────
   With the caret right after a picture that sits on its own line, a faint
   hint says Tab puts the text beside it: Tab floats the picture left and
   whatever you type flows along its right side. */
// a list or number marker may come first: "20) ![[pic.png]]" is still a picture on its own
const LONE_PIC = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(!\[\[[^\[\]\n]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|mp4|webm|mkv|mov|m4v|ogv|mp3|wav|ogg|oga|m4a|flac|aac|opus)(?:\|[^\[\]\n]*)?\]\]|!\[[^\]\n]*\]\([^)\n]+\))\s*$/i;
function lonePicture(state) {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return null;
  const m = LONE_PIC.exec(line.text);
  if (!m || embedSide(m[1])) return null;
  const from = line.from + line.text.indexOf(m[1]);
  return { line, from, to: from + m[1].length, text: m[1] };
}
export function writeBeside(view, r) {
  const next = setEmbedSide(r.text, "left");
  const end = r.from + next.length;
  const line = view.state.doc.lineAt(r.from);
  const tail = view.state.doc.sliceString(r.to, line.to);
  view.dispatch({ changes: { from: r.from, to: r.to, insert: next }, selection: { anchor: end + tail.length }, userEvent: "input" });
  view.focus();
}
/* Typing right after a lone picture goes beside it without being asked: the
   embed gets Obsidian's |left and the browser's own float does the rest -
   nothing is measured or calculated here, which is why it costs nothing.
   Tab says no (the text drops under the picture) and Tab again says yes;
   a picture that was told no is remembered, so typing does not float it again. */
const declineBeside = StateEffect.define(); // { at, on }
const besideDeclined = StateField.define({
  create: () => [],
  update(v, tr) {
    if (v.length && tr.docChanged) v = v.map((p) => tr.changes.mapPos(p, -1));
    for (const e of tr.effects) if (e.is(declineBeside)) v = e.value.on ? [...v.filter((p) => p !== e.value.at), e.value.at].slice(-50) : v.filter((p) => p !== e.value.at);
    return v;
  },
});
const declined = (state, at) => (state.field(besideDeclined, false) || []).includes(at);

/** The picture a line starts with, when the caret is at that line's end. */
function floatedPicture(state) {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  const m = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(!\[\[[^\[\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\))/.exec(line.text);
  // Tab only means this at the end of the line; anywhere else it is a Tab
  if (!m || sel.head !== line.to) return null;
  const from = line.from + line.text.indexOf(m[1]);
  return { line, from, to: from + m[1].length, text: m[1], side: embedSide(m[1]) };
}

const besideTyping = EditorView.inputHandler.of((view, from, to, text) => {
  // not in the middle of an input method's composition (Japanese, Chinese...): a space put in then breaks it
  if (view.composing || !text || /^[\r\n]+$/.test(text) || from !== to) return false;
  const r = lonePicture(view.state);
  if (!r || from !== r.line.to || declined(view.state, r.from)) return false;
  const lead = from > r.to || /^\s/.test(text) ? "" : " ";
  view.dispatch({
    changes: [{ from, insert: lead + text }],
    selection: { anchor: from + lead.length + text.length },
    userEvent: "input.type",
    scrollIntoView: true,
  });
  return true;
});

class BesideHint extends WidgetType {
  constructor(off) { super(); this.off = off; }
  eq(o) { return o.off === this.off; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-beside-hint";
    s.textContent = this.off ? "Tab: write beside it" : "Typing goes beside it · Tab: keep it below";
    return s;
  }
  ignoreEvent() { return false; }
}
const besideHint = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(declineBeside)))) this.decorations = this.build(u.view); }
  build(view) {
    const r = view.hasFocus && lonePicture(view.state);
    return r ? Decoration.set([Decoration.widget({ widget: new BesideHint(declined(view.state, r.from)), side: 1 }).range(r.line.to)]) : Decoration.none;
  }
}, { decorations: (v) => v.decorations });
const besideKeys = Prec.high(keymap.of([{ key: "Tab", run: (view) => {
  const r = lonePicture(view.state);
  if (r) {
    // not told no yet: Tab is the no. Told no: Tab takes it back.
    if (declined(view.state, r.from)) { view.dispatch({ effects: declineBeside.of({ at: r.from, on: false }) }); writeBeside(view, r); }
    else view.dispatch({ effects: declineBeside.of({ at: r.from, on: true }) });
    return true;
  }
  const f = floatedPicture(view.state);
  if (!f) return false;
  // beside it only because text follows it: Tab says below, Tab again says beside
  if (!f.side) { view.dispatch({ effects: declineBeside.of({ at: f.from, on: !declined(view.state, f.from) }) }); return true; }
  // beside the picture already: Tab drops the text back under it - and Tab
  // once more, on a picture that was told no, puts it beside again
  const next = setEmbedSide(f.text, f.side ? "" : "left");
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: f.from, to: f.to, insert: next },
    selection: { anchor: Math.max(f.from + next.length, head + next.length - f.text.length) },
    effects: declineBeside.of({ at: f.from, on: !!f.side }),
    userEvent: "input",
  });
  return true;
} }]));

// A decoration bug must never take the editor down with it: fall back to
// plain source for that update and keep the user typing.
function safeBuild(view, opts, self) {
  try {
    const set = build(view, opts);
    // pictures are single units for the caret: arrows step over them and
    // Backspace takes the whole embed
    const atoms = [];
    for (let it = set.iter(); it.value; it.next()) if (it.value.spec.widget instanceof ImageWidget || it.value.spec.widget instanceof YouTubeWidget || it.value.spec.widget instanceof MediaWidget) atoms.push(it.value.range(it.from, it.to));
    self.atoms = Decoration.set(atoms);
    return set;
  } catch (err) {
    console.error("live preview", err);
    return self.decorations || Decoration.none;
  }
}
