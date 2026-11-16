// Pictures in a note, handled like things on a reference board: a click picks
// one (Shift or Ctrl picks more), and what is picked can be sized, lined up,
// reordered or removed together. A click no longer opens the viewer - the
// caret lands right after the picture instead, so the arrows and typing carry
// on from there. A click on the picked picture, a double click or Enter opens it.
//
// The note stays plain Markdown: every action here only rewrites embed text
// (the |width of ![[pic.png|300]]), or moves it within the line.

import { Annotation, StateEffect, StateField, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { confirmDialog } from "./ui.js";

/** The message after a link left a note offers Delete too: asked once more, then the file goes to the trash (Leonote's own, so it can come back). */
export function deleteAction(paths, trash) {
  paths = [...new Set(paths.filter(Boolean))];
  if (!paths.length || !trash) return null;
  const one = paths.length === 1;
  return { label: "Delete", run: async () => {
    const ok = await confirmDialog(one ? "Delete the file too?" : `Delete ${paths.length} files too?`, `${one ? "It goes" : "They go"} to the trash, where ${one ? "it" : "they"} can be brought back from.`, { ok: "Move to the trash", danger: true });
    if (ok) trash(paths);
  } };
}
import { embedAt, embedWidth, setEmbedWidth, imagesIn, embedLink, setEmbedLink, embedSide, setEmbedSide } from "./images.js";

const setPick = StateEffect.define(); // number[]: where each picked embed starts
/** A change made by the picture tools themselves: the pick survives it. */
export const KeepPick = Annotation.define();

const EMBED_G = /!\[\[[^\[\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g;

export const pickedField = StateField.define({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPick)) return e.value;
    if (!v.length) return v;
    if (tr.annotation(KeepPick)) return v.map((p) => tr.changes.mapPos(p, -1)).filter((p) => embedAt(tr.newDoc, p));
    // typing, or the caret going anywhere else, lets go of the pictures
    return tr.docChanged || tr.selection ? [] : v;
  },
});

export const pickedOf = (state) => state.field(pickedField, false) || [];

/** Pick the embed starting at `from`. add: toggle it in; range: everything between the last pick and it. */
export function pickImage(view, from, { add = false, range = false } = {}) {
  const r = embedAt(view.state.doc, from);
  if (!r) return;
  const have = pickedOf(view.state);
  let next = [from];
  if (range && have.length) {
    const a = Math.min(have[have.length - 1], from);
    const b = Math.max(have[have.length - 1], from);
    next = [...new Set([...have, ...embedsBetween(view.state.doc, a, b)])];
  } else if (add) next = have.includes(from) ? have.filter((p) => p !== from) : [...have, from];
  // the caret waits right after the picture: arrows and typing go on from here
  view.dispatch({ selection: { anchor: r.to }, effects: setPick.of(next), scrollIntoView: false });
  view.focus();
}

function embedsBetween(doc, a, b) {
  const out = [];
  for (let n = doc.lineAt(a).number; n <= doc.lineAt(b).number; n++) {
    const line = doc.line(n);
    EMBED_G.lastIndex = 0;
    for (let m; (m = EMBED_G.exec(line.text)); ) { const p = line.from + m.index; if (p >= a && p <= b) out.push(p); }
  }
  return out;
}

/** The pictures of one line, in order. */
function rowOf(doc, pos) {
  const line = doc.lineAt(pos);
  const out = [];
  EMBED_G.lastIndex = 0;
  for (let m; (m = EMBED_G.exec(line.text)); ) out.push({ from: line.from + m.index, to: line.from + m.index + m[0].length, text: m[0] });
  return out;
}

const picks = (view) => pickedOf(view.state).map((p) => embedAt(view.state.doc, p)).filter(Boolean).sort((a, b) => a.from - b.from);

function elFor(view, from) {
  for (const el of view.dom.querySelectorAll(".cm-img, .cm-media")) {
    try { if (view.posAtDOM(el) === from) return el; } catch {}
  }
  return null;
}
const shownWidth = (view, r) => { const el = elFor(view, r.from); const img = el && (el.querySelector("img") || (el.classList.contains("cm-media") ? el : null)); return img ? img.getBoundingClientRect().width : embedWidth(r.text) || 0; };
const shapeOf = (view, r) => { const el = elFor(view, r.from); const img = el && el.querySelector("img"); return img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1.4; };
const maxWidth = (view) => Math.max(120, view.contentDOM.clientWidth);

/** Rewrite the picked embeds; the pick stays on them. */
function rewrite(view, list, textOf) {
  const changes = [];
  for (const r of list) { const t = textOf(r); if (t !== r.text) changes.push({ from: r.from, to: r.to, insert: t }); }
  if (changes.length) view.dispatch({ changes, annotations: KeepPick.of(true), userEvent: "input" });
  return true;
}

export function scalePicked(view, factor) {
  const max = maxWidth(view);
  return rewrite(view, picks(view), (r) => {
    const w = shownWidth(view, r);
    return w ? setEmbedWidth(r.text, Math.round(Math.max(40, Math.min(max, w * factor)))) : r.text;
  });
}
export const widthPicked = (view, w) => rewrite(view, picks(view), (r) => setEmbedWidth(r.text, w ? Math.round(Math.min(maxWidth(view), w)) : 0));

/** Every picked picture as tall as the first one (widths follow their shapes). */
export function sameHeight(view) {
  const list = picks(view);
  if (list.length < 2) return true;
  const h = shownWidth(view, list[0]) / shapeOf(view, list[0]);
  return rewrite(view, list, (r) => setEmbedWidth(r.text, Math.round(Math.max(40, h * shapeOf(view, r)))));
}
export function sameWidth(view) {
  const list = picks(view);
  if (list.length < 2) return true;
  const w = Math.round(shownWidth(view, list[0]));
  return rewrite(view, list, (r) => setEmbedWidth(r.text, w));
}

/** The picked pictures side by side, filling the column: one row, one height. */
export function fitRow(view) {
  const list = picks(view);
  if (!list.length) return true;
  const gap = 8;
  const sum = list.reduce((n, r) => n + shapeOf(view, r), 0);
  const h = (maxWidth(view) - gap * (list.length - 1) - 4) / sum;
  const texts = list.map((r) => setEmbedWidth(r.text, Math.max(40, Math.floor(h * shapeOf(view, r)))));
  return regroup(view, list, texts.join(" "));
}
/** Each picked picture on a line of its own. */
export const stackPicked = (view) => { const list = picks(view); return list.length ? regroup(view, list, list.map((r) => r.text).join("\n")) : true; };

/** Take the picked embeds out of where they are and put `text` where the first one was. */
function regroup(view, list, text) {
  const doc = view.state.doc;
  const changes = [];
  list.forEach((r, i) => {
    // the space that tied it to its neighbour goes with it
    const to = doc.sliceString(r.to, r.to + 1) === " " ? r.to + 1 : r.to;
    const line = doc.lineAt(r.from);
    // the first one keeps its place; the space after it only goes when a picked neighbour follows
    if (i === 0) changes.push({ from: r.from, to: list.some((x) => x.from === to) ? to : r.to, insert: text });
    // a line it had to itself goes with it
    else if (line.text.trim() === r.text && !changes.some((c) => c.to > line.from)) changes.push({ from: line.from, to: Math.min(line.to + 1, doc.length) });
    else changes.push({ from: r.from, to });
  });
  const first = list[0].from;
  const tr = view.state.update({ changes, userEvent: "input" });
  // where the pictures are now
  const next = [];
  let at = first;
  for (const part of text.split(/(\s+)/)) { if (part.startsWith("!")) next.push(at); at += part.length; }
  view.dispatch({ changes, effects: setPick.of(next.filter((p) => embedAt(tr.newDoc, p))), selection: { anchor: Math.min(tr.newDoc.length, first + text.length) }, userEvent: "input" });
  return true;
}

/** Swap the picked picture with its neighbour in the row. */
export function nudgePicked(view, dir) {
  const list = picks(view);
  if (list.length !== 1) return !!list.length;
  const row = rowOf(view.state.doc, list[0].from);
  const i = row.findIndex((r) => r.from === list[0].from);
  const j = i + dir;
  if (i < 0) return true;
  if (j < 0 || j >= row.length) {
    // no neighbour that way: the picture floats to that side instead
    const r = list[0];
    const side = embedSide(r.text);
    const next = dir < 0 ? (side === "right" ? "" : "left") : (side === "left" ? "" : "right");
    const text = setEmbedSide(r.text, next);
    view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, effects: setPick.of([r.from]), selection: { anchor: r.from + text.length }, userEvent: "move" });
    return true;
  }
  const [a, b] = dir < 0 ? [row[j], row[i]] : [row[i], row[j]];
  const between = view.state.doc.sliceString(a.to, b.from);
  const moved = dir < 0 ? a.from : a.from + b.text.length + between.length;
  view.dispatch({ changes: { from: a.from, to: b.to, insert: b.text + between + a.text }, effects: setPick.of([moved]), selection: { anchor: moved + list[0].text.length }, userEvent: "move" });
  return true;
}

/** The picked pictures out of the note and their files into the trash. */
/** Shift+Delete: out of the note, and the files to the trash (Ctrl+Z brings both back). */
export function trashPicked(view, opts) {
  const paths = pickedPaths(view, opts);
  if (!removePicked(view)) return false;
  if (paths.length && opts.trashFiles) opts.trashFiles(paths, view);
  return true;
}
/** Out of the note only - the file stays, and the message can put it back. */
function unlinkPicked(view, opts) {
  const n = picks(view).length;
  const paths = pickedPaths(view, opts);
  if (!removePicked(view)) return false;
  // chosen: a picture just pasted is not taken to the trash behind the user's back
  if (opts.keepFiles) opts.keepFiles(paths);
  if (opts.toast) opts.toast(`${n > 1 ? `${n} picture links` : "The picture link"} left the note - the file${n > 1 ? "s stay" : " stays"}`, { ms: 7000, actions: [{ label: "Undo", run: () => { undo(view); view.focus(); } }, deleteAction(paths, opts.trashFiles && ((p) => opts.trashFiles(p, view)))] });
  return true;
}
const pickedPaths = (view, opts) => [...new Set(picks(view).map((r) => (opts.picturePath && opts.picturePath(targetOf(r))) || "").filter(Boolean))];
/** Delete: asked - the link only (the usual answer) or the file to the trash as well. A picture from the web has only its link to lose. */
function deletePicked(view, opts) {
  const paths = pickedPaths(view, opts);
  if (!paths.length || !opts.askPictureDelete) return unlinkPicked(view, opts);
  opts.askPictureDelete(paths).then((how) => {
    if (how === "trash") trashPicked(view, opts);
    else if (how === "link") unlinkPicked(view, opts);
    else if ((how === "relink" || how === "replace") && opts.replacePicture) opts.replacePicture(paths[0], how, view);
    view.focus();
  });
  return true;
}
/** Shift+Delete: the files deleted for good - asked twice - and their links out of the note. */
function foreverPicked(view, opts) {
  const paths = pickedPaths(view, opts);
  if (!paths.length || !opts.deleteForever) return unlinkPicked(view, opts);
  opts.deleteForever(paths, view).then((yes) => {
    if (yes) { removePicked(view); opts.deleteForeverNow(paths); }
    view.focus();
  });
  return true;
}

export function removePicked(view) {
  const doc = view.state.doc;
  const list = picks(view);
  if (!list.length) return false;
  const changes = list.map((r) => {
    const line = doc.lineAt(r.from);
    if (line.text.trim() === r.text) return { from: line.from, to: Math.min(line.to + 1, doc.length) };
    return { from: r.from, to: doc.sliceString(r.to, r.to + 1) === " " ? r.to + 1 : r.to };
  });
  view.dispatch({ changes, effects: setPick.of([]), userEvent: "delete" });
  return true;
}

const targetOf = (r) => { const m = imagesIn(r.text)[0]; return m ? m.target : ""; };
/** Ctrl+C on a picked picture: the picture, not its link. */
export function copyPicked(view, opts) {
  const p = picks(view)[0];
  if (!p || !opts.copyPicture) return false;
  opts.copyPicture(targetOf(p));
  return true;
}
function copyPath(view, opts) {
  const list = picks(view).map((r) => (opts.picturePath && opts.picturePath(targetOf(r))) || targetOf(r)).filter(Boolean);
  if (!list.length) return;
  navigator.clipboard.writeText(list.join(String.fromCharCode(10))).then(() => opts.toast && opts.toast(list.length > 1 ? `${list.length} paths copied` : "Path copied", { ms: 1600 })).catch(() => {});
}

export const clearPick = (view) => { if (!pickedOf(view.state).length) return false; view.dispatch({ effects: setPick.of([]) }); return true; };

/** The rows of the menu: on the toolbar's size button, and on a right click. */
const linkOfPicked = (view) => { const p = picks(view)[0]; return p ? embedLink(p.text) : ""; };
export function pictureMenu(view, opts) {
  const n = picks(view).length;
  const many = n > 1;
  const full = maxWidth(view);
  // with edits of its own: copied as shown, and the other way too
  const edits = !many && opts.pictureEdits ? opts.pictureEdits(targetOf(picks(view)[0])) : null;
  return [
    { header: many ? `${n} pictures` : "Picture" },
    !many ? { label: "Open", icon: "expand", keys: "Enter", run: () => { const p = picks(view)[0]; if (p && opts.onImageOpen) opts.onImageOpen(view, p.from); } } : null,
    !many ? { label: edits === "on" ? "Copy picture with my edits" : edits === "off" ? "Copy picture as on disk" : "Copy picture", icon: "clipboard", keys: "Ctrl C", run: () => copyPicked(view, opts) } : null,
    edits ? { label: edits === "on" ? "Copy it without my edits" : "Copy it with my edits", icon: "layers", run: () => { const p = picks(view)[0]; if (p && opts.copyPicture) opts.copyPicture(targetOf(p), edits === "on" ? "original" : "edited"); } } : null,
    { label: many ? "Copy paths" : "Copy path", icon: "link", run: () => copyPath(view, opts) },
    // a picture Leonote compressed on the way in can go back to what was pasted, while that is still around
    ...(!many && opts.pictureExtras ? opts.pictureExtras(targetOf(picks(view)[0])) || [] : []),
    "sep",
    { label: "Small", icon: "shrink", run: () => widthPicked(view, 220) },
    { label: "Medium", icon: "image", run: () => widthPicked(view, 420) },
    { label: "Large", icon: "expand", run: () => widthPicked(view, 680) },
    { label: "Full width", icon: "columns", run: () => widthPicked(view, full) },
    { label: "Its own size", icon: "square", keys: "0", run: () => widthPicked(view, 0) },
    "sep",
    { label: "Bigger", icon: "plus", keys: "+", run: () => scalePicked(view, 1.15) },
    { label: "Smaller", icon: "minus", keys: "-", run: () => scalePicked(view, 1 / 1.15) },
    "sep",
    many ? { label: "Same height", icon: "columns", run: () => sameHeight(view) } : null,
    many ? { label: "Same width", icon: "columns", run: () => sameWidth(view) } : null,
    many ? { label: "Side by side, filling the row", icon: "image", run: () => fitRow(view) } : null,
    many ? { label: "One under another", icon: "list", run: () => stackPicked(view) } : null,
    !many ? { label: "Move left in the row", icon: "back", run: () => nudgePicked(view, -1) } : null,
    !many ? { label: "Move right in the row", icon: "forward", run: () => nudgePicked(view, 1) } : null,
    "sep",
    !many && opts.askText ? { label: linkOfPicked(view) ? "Change the link…" : "Add a link…", icon: "link", run: async () => { const u = await opts.askText("A link on the picture", linkOfPicked(view), "https://"); if (u == null) return; rewrite(view, picks(view), (r) => setEmbedLink(r.text, u.trim())); } } : null,
    // the picture opens a note: picked by name as the editor's own Link to a note does, kept as link:note:<its link>
    !many && opts.pickLink ? { label: /^note:/i.test(linkOfPicked(view) || "") ? "Link to another note…" : "Link to a note…", icon: "fileText", run: () => {
      const which = picks(view); // the note picker takes the focus, and with it the picked picture
      opts.pickLink((text) => {
        const t = String(text || "").replace(/^!?\[\[|\]\]$/g, "").split(/[|#\]]/)[0].trim(); // the note's link, bare or as [[…]]
        if (t) rewrite(view, which, (r) => setEmbedLink(r.text, "note:" + t));
      });
    } } : null,
    !many && linkOfPicked(view) ? { label: "Remove the link", icon: "x", run: () => rewrite(view, picks(view), (r) => setEmbedLink(r.text, "")) } : null,
    "sep",
    { label: many ? "Remove from the note (the files stay)" : "Remove from the note (the file stays)", icon: "x", danger: true, run: () => unlinkPicked(view, opts) },
    { label: many ? "Remove and move the files to the trash" : "Remove and move the file to the trash", icon: "trash", danger: true, run: () => trashPicked(view, opts) },
    { label: many ? "Delete the files permanently…" : "Delete the file permanently…", icon: "trash", keys: "Shift Del", danger: true, run: () => foreverPicked(view, opts) },
  ].filter(Boolean);
}

export function imagePicking(opts) {
  const has = (view) => pickedOf(view.state).length > 0;
  const when = (fn) => (view) => (has(view) ? fn(view) : false);
  const painter = ViewPlugin.fromClass(class {
    constructor(view) { this.paint(view); }
    update(u) { this.paint(u.view); }
    paint(view) {
      view.requestMeasure({
        key: "leonote-picked",
        read: () => {
          const want = new Set(pickedOf(view.state));
          if (!want.size && !this.had) return [];
          this.had = want.size > 0;
          const out = [];
          for (const el of view.dom.querySelectorAll(".cm-img, .cm-media")) {
            let on = false;
            if (want.size) { try { on = want.has(view.posAtDOM(el)); } catch {} }
            if (on !== el.classList.contains("is-picked")) out.push([el, on]);
          }
          return out;
        },
        write: (out) => {
          for (const [el, on] of out) el.classList.toggle("is-picked", on);
          // several picked: their toolbars step back, the frames say enough
          view.dom.classList.toggle("has-many-picked", pickedOf(view.state).length > 1);
        },
      });
    }
  }, {
    eventHandlers: {
      // Ctrl+wheel over a picked picture sizes it, like on a reference board
      wheel(e, view) {
        if (!e.ctrlKey || !has(view) || !(e.target.closest && e.target.closest(".cm-img.is-picked, .cm-media.is-picked"))) return false;
        e.preventDefault();
        e.stopPropagation();
        scalePicked(view, e.deltaY < 0 ? 1.08 : 1 / 1.08);
        return true;
      },
    },
  });
  return [
    pickedField,
    painter,
    Prec.highest(keymap.of([
      { key: "Escape", run: clearPick },
      { key: "Enter", run: when((view) => { const p = picks(view)[0]; if (p && opts.onImageOpen) opts.onImageOpen(view, p.from); return true; }) },
      { key: "Mod-c", run: when((v) => (pickedOf(v.state).length === 1 ? copyPicked(v, opts) : false)) },
      { key: "Delete", run: when((v) => deletePicked(v, opts)) },
      { key: "Backspace", run: when((v) => deletePicked(v, opts)) },
      { key: "Shift-Delete", run: when((v) => foreverPicked(v, opts)) },
      { key: "+", run: when((v) => scalePicked(v, 1.15)) },
      { key: "=", run: when((v) => scalePicked(v, 1.15)) },
      { key: "-", run: when((v) => scalePicked(v, 1 / 1.15)) },
      { key: "0", run: when((v) => widthPicked(v, 0)) },
    ])),
  ];
}
