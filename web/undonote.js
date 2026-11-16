// Undo and redo that say what they did. A step can land anywhere in a long
// note: the view jumps, and it is not obvious what changed. So every undo or
// redo shows a short line in the corner ("Undo · removed “…” · line 42") and
// the lines it touched glow for a moment.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";

const flash = StateEffect.define(); // [from, to] in the new document, or null
const lineMark = Decoration.line({ class: "cm-undo-flash" });
const flashField = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flash)) continue;
      if (!e.value) { v = Decoration.none; continue; }
      const marks = [];
      const doc = tr.newDoc;
      const last = doc.lineAt(Math.min(doc.length, e.value[1])).number;
      for (let n = doc.lineAt(Math.min(doc.length, e.value[0])).number; n <= last && marks.length < 40; n++) marks.push(lineMark.range(doc.line(n).from));
      v = Decoration.set(marks);
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const snip = (s) => {
  if (!s.trim()) return /\n/.test(s) ? (s.split("\n").length > 2 ? `${s.split("\n").length - 1} line breaks` : "a line break") : "spaces";
  const t = s.replace(/\s+/g, " ").trim();
  return "“" + (t.length > 42 ? t.slice(0, 40) + "…" : t) + "”";
};

// the longer telling, for the opened-up chip: more of the text, line breaks kept
const long = (s) => {
  const t = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!t) return snip(s);
  return t.length > 600 ? t.slice(0, 598) + "…" : t;
};

/** What one undo/redo transaction did, in words. Exported for the tests. */
export function describeStep(tr, kind) {
  let places = 0, gone = "", came = "", from = Infinity, to = 0;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    places++;
    if (places === 1) { gone = tr.startState.doc.sliceString(fromA, toA); came = inserted.toString(); }
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
  });
  if (!places) return null;
  let what;
  // a replacement usually shares most of its text with what it replaced:
  // say only the part that differs
  if (gone && came) {
    let a = 0;
    while (a < gone.length && a < came.length && gone[a] === came[a]) a++;
    let b = 0;
    while (b < gone.length - a && b < came.length - a && gone[gone.length - 1 - b] === came[came.length - 1 - b]) b++;
    gone = gone.slice(a, gone.length - b);
    came = came.slice(a, came.length - b);
  }
  if (gone && came) what = kind === "undo" ? `changed ${snip(gone)} back to ${snip(came)}` : `changed ${snip(gone)} to ${snip(came)}`;
  else if (came) what = (kind === "undo" ? "brought back " : "put in ") + snip(came);
  else what = (kind === "undo" ? "took out " : "removed ") + snip(gone);
  const line = tr.newDoc.lineAt(Math.min(tr.newDoc.length, from)).number;
  const detail = [];
  if (gone) detail.push({ label: kind === "undo" ? (came ? "was" : "taken out") : "removed", text: long(gone) });
  if (came) detail.push({ label: kind === "undo" ? (gone ? "is again" : "brought back") : (gone ? "now" : "put in"), text: long(came) });
  return { detail, text: `${kind === "undo" ? "Undo" : "Redo"} · ${what}`, where: places > 1 ? `${places} places, from line ${line}` : `line ${line}`, from, to };
}

export function undoNotes() {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; this.chip = null; this.timer = 0; this.clear = 0; }
    update(u) {
      for (const tr of u.transactions) {
        const kind = tr.isUserEvent("undo") ? "undo" : tr.isUserEvent("redo") ? "redo" : "";
        if (!kind || !tr.docChanged) continue;
        const d = describeStep(tr, kind);
        if (d) setTimeout(() => this.show(d), 0);
      }
    }
    show(d) {
      const view = this.view;
      if (!view.dom.isConnected) return;
      view.dispatch({ effects: flash.of([d.from, d.to]) });
      clearTimeout(this.clear);
      this.clear = setTimeout(() => { if (view.dom.isConnected) view.dispatch({ effects: flash.of(null) }); }, 1300);
      const app = window.leonote;
      const opened = () => !!(app && app.settings && app.settings.undoChipOpen);
      if (!this.chip) {
        // what happened, where, and - opened up - the text itself. It can be
        // clicked: the arrow opens and shuts it, and that is remembered.
        this.chip = document.createElement("div");
        this.chip.className = "undo-chip";
        const head = document.createElement("div");
        head.className = "undo-chip-head";
        const more = document.createElement("button");
        more.className = "undo-chip-more";
        more.title = "Show more or less of what changed - remembered";
        more.textContent = "›";
        head.append(document.createElement("span"), document.createElement("span"), more);
        head.children[1].className = "undo-chip-where";
        const body = document.createElement("div");
        body.className = "undo-chip-body";
        this.chip.append(head, body);
        more.addEventListener("click", (e) => { e.stopPropagation(); if (app && app.setSetting) app.setSetting("undoChipOpen", !opened()); this.paintOpen(); this.linger(); });
        this.chip.addEventListener("mouseenter", () => clearTimeout(this.timer));
        this.chip.addEventListener("mouseleave", () => this.linger());
        this.paintOpen = () => this.chip.classList.toggle("is-open", opened());
        this.linger = () => {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { this.chip.classList.remove("is-in"); setTimeout(() => { if (!this.chip.classList.contains("is-in")) this.chip.remove(); }, 250); }, opened() ? 9000 : 4500);
        };
      }
      const box = (view.dom.closest(".view, .pane") || view.dom).getBoundingClientRect();
      this.chip.style.top = Math.max(8, box.top + 10) + "px";
      this.chip.style.right = Math.max(8, innerWidth - box.right + 22) + "px";
      const head = this.chip.firstChild;
      head.children[0].textContent = d.text;
      head.children[1].textContent = d.where;
      const body = this.chip.lastChild;
      body.replaceChildren(...(d.detail || []).map((x) => { const row = document.createElement("div"); row.className = "undo-chip-row"; const l = document.createElement("span"); l.className = "undo-chip-label"; l.textContent = x.label; const t = document.createElement("span"); t.className = "undo-chip-text"; t.textContent = x.text; row.append(l, t); return row; }));
      this.paintOpen();
      if (!this.chip.isConnected) document.body.append(this.chip);
      this.chip.classList.remove("is-in");
      void this.chip.offsetWidth;
      this.chip.classList.add("is-in");
      this.linger();
    }
    destroy() { clearTimeout(this.timer); clearTimeout(this.clear); if (this.chip) this.chip.remove(); }
  });
  return [flashField, plugin];
}
