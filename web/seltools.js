// The bar that floats over selected text in a note. Select a few words and
// the styles you would reach for are right there: bold, italic, strike,
// code, the marker, a link, a heading, lists and the rest behind one "more".
// It never takes focus, so the selection it is acting on stays exactly where
// it was, and it gets out of the way the moment the selection goes.

import { ViewPlugin } from "@codemirror/view";
import { h, motionOk } from "./util.js";
import { icon } from "./icons.js";
import { menu, closeMenu } from "./ui.js";
import {
  wrap, isWrapped, insertLink, wikiLink, toggleTask, setHeading, headingLevel,
  highlight, highlightAt, HIGHLIGHT_LABELS, toggleQuote, toggleBullets, toggleNumbers,
  callout, codeBlock, changeCase, clearFormat,
} from "./mdcommands.js";
import { HL_COLORS } from "./mdparse.js";

const GAP = 10; // between the selection and the bar

export function selectionBar(o) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.el = null;
        this.dragging = false;
        this.timer = 0;
        this.lastColor = "yellow";
        this.onUp = () => {
          if (!this.dragging) return;
          this.dragging = false;
          this.later();
        };
        this.onDown = (e) => {
          if (this.el && this.el.contains(e.target)) return;
          this.dragging = true;
          this.hide();
        };
        this.onScroll = () => { if (this.el && !this.el.hidden) this.place(); };
        this.onKey = (e) => { if (e.key === "Escape") this.hide(); };
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        view.dom.addEventListener("mousedown", this.onDown);
        window.addEventListener("mouseup", this.onUp);
        window.addEventListener("keydown", this.onKey, true);
        window.addEventListener("resize", this.onScroll);
      }

      update(u) {
        if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
        if (this.dragging) return;
        const r = u.state.selection.main;
        if (r.empty || !u.view.hasFocus) return this.hide();
        // typing replaces the selection; a formatting command keeps it
        if (u.docChanged && !u.transactions.some((t) => t.isUserEvent("input.format") || t.isUserEvent("input.toggle"))) return this.hide();
        this.later();
      }

      later() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.show(), 40);
      }

      /* ── building ───────────────────────────────────────────────────── */
      build() {
        const view = this.view;
        const run = (cmd) => (e) => {
          e.preventDefault();
          e.stopPropagation();
          cmd(view);
          view.focus();
          this.paint();
          this.place();
        };
        const btn = (name, title, cmd, mark) =>
          h("button", {
            class: "fb-btn",
            title,
            dataset: mark ? { mark } : {},
            onmousedown: (e) => e.preventDefault(),
            onclick: run(cmd),
          }, icon(name));

        this.bold = btn("bold", "Bold  (Ctrl+B)", wrap("**"), "**");
        this.italic = btn("italic", "Italic  (Ctrl+I)", wrap("*"), "*");
        this.strike = btn("strike", "Strikethrough  (Ctrl+Shift+X)", wrap("~~"), "~~");
        this.code = btn("code", "Code  (Ctrl+E)", wrap("`"), "`");
        this.head = h("button", { class: "fb-btn", title: "Heading", onmousedown: (e) => e.preventDefault(), onclick: (e) => { e.preventDefault(); this.headingMenu(e.currentTarget); } }, icon("heading"), h("span", { class: "fb-lv" }));

        // the marker: a click paints in the colour last used, the sliver
        // beside it opens the colours
        this.mark = h("button", { class: "fb-btn fb-mark", title: "Highlight  (Ctrl+Shift+H)", onmousedown: (e) => e.preventDefault(), onclick: run((v) => highlight(highlightAt(v.state) === this.lastColor ? null : this.lastColor)(v)) }, icon("marker"), h("span", { class: "fb-swatch" }));
        this.markMore = h("button", { class: "fb-btn fb-more-arrow", title: "Highlight colours", onmousedown: (e) => e.preventDefault(), onclick: (e) => { e.preventDefault(); this.colorMenu(e.currentTarget); } }, icon("chevronDown"));

        const sep = () => h("span", { class: "fb-sep" });
        this.el = h("div", { class: "fb", role: "toolbar", hidden: true },
          this.bold, this.italic, this.strike, this.code, sep(),
          h("span", { class: "fb-group" }, this.mark, this.markMore), sep(),
          btn("link", "Link  (Ctrl+K)", insertLink),
          this.head,
          btn("list", "Bulleted list", toggleBullets),
          btn("checkSquare", "Checkbox  (a task)", toggleTask),
          sep(),
          h("button", { class: "fb-btn", title: "More", onmousedown: (e) => e.preventDefault(), onclick: (e) => { e.preventDefault(); this.moreMenu(e.currentTarget); } }, icon("more")));
        // a click on the bar must never land in the note underneath
        this.el.addEventListener("contextmenu", (e) => e.stopPropagation());
        document.getElementById("overlay-root").append(this.el);
      }

      /* ── menus ──────────────────────────────────────────────────────── */
      at(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.bottom + 6 };
      }

      after(cmd) {
        cmd(this.view);
        this.view.focus();
        this.paint();
        this.place();
      }

      colorMenu(el) {
        const { x, y } = this.at(el);
        const now = highlightAt(this.view.state);
        menu(x, y, [
          { header: "Highlight" },
          ...HL_COLORS.map((c) => ({
            label: HIGHLIGHT_LABELS[c],
            swatch: `var(--hl-${c})`,
            checked: now === c,
            run: () => { this.lastColor = c; this.after(highlight(c)); },
          })),
          "sep",
          { label: "Remove highlight", icon: "x", run: () => this.after(highlight(null)) },
        ]);
      }

      headingMenu(el) {
        const { x, y } = this.at(el);
        const lv = headingLevel(this.view.state);
        menu(x, y, [
          { header: "Turn into" },
          ...[1, 2, 3, 4, 5, 6].map((n) => ({ label: "Heading " + n, icon: "heading", checked: lv === n, keys: `Ctrl Alt ${n}`, run: () => this.after(setHeading(n)) })),
          { label: "Body text", icon: "fileText", checked: lv === 0, run: () => this.after(setHeading(lv || 1)) },
        ]);
      }

      // the "…": the very menu a right-click on the selection brings, at the button
      moreMenu(el) {
        const { x, y } = this.at(el);
        const view = this.view;
        const r = view.state.selection.main;
        const inSel = view.coordsAtPos(Math.floor((r.from + r.to) / 2)) || view.coordsAtPos(r.from);
        if (inSel) {
          const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: inSel.left + 1, clientY: (inSel.top + inSel.bottom) / 2 });
          ev.leonoteMenuAt = { x, y };
          this.hide();
          view.contentDOM.dispatchEvent(ev);
          return;
        }
        menu(x, y, [
          { header: "Turn into" },
          { label: "Quote", icon: "quote", run: () => this.after(toggleQuote) },
          { label: "Callout", icon: "note", run: () => this.after(callout("note")) },
          { label: "Code block", icon: "code", run: () => this.after(codeBlock) },
          { label: "Numbered list", icon: "list", run: () => this.after(toggleNumbers) },
          { label: "To-do", icon: "checkSquare", keys: "Ctrl Enter", run: () => this.after(toggleTask) },
          "sep",
          { label: "Link to a note", icon: "link", run: () => this.after(wikiLink) },
          o.onSlashAction ? { label: "Make this a note of its own", icon: "filePlus", run: () => { const v = this.view; this.hide(); o.onSlashAction("extract", v, v.state.selection.main.from); } } : null,
          "sep",
          { label: "UPPERCASE", icon: "caseText", run: () => this.after(changeCase("upper")) },
          { label: "lowercase", icon: "caseText", run: () => this.after(changeCase("lower")) },
          { label: "Title Case", icon: "caseText", run: () => this.after(changeCase("title")) },
          { label: "Sentence case", icon: "caseText", run: () => this.after(changeCase("sentence")) },
          "sep",
          { label: "Copy", icon: "clipboard", run: () => { const r = this.view.state.selection.main; navigator.clipboard.writeText(this.view.state.sliceDoc(r.from, r.to)); } },
          { label: "Clear formatting", icon: "eraser", run: () => this.after(clearFormat) },
        ]);
      }

      /* ── showing ────────────────────────────────────────────────────── */
      paint() {
        const st = this.view.state;
        for (const b of [this.bold, this.italic, this.strike, this.code])
          b.classList.toggle("is-on", isWrapped(st, b.dataset.mark));
        const c = highlightAt(st);
        this.mark.classList.toggle("is-on", !!c);
        if (c) this.lastColor = c;
        this.el.style.setProperty("--fb-hl", `var(--hl-${c || this.lastColor})`);
        const lv = headingLevel(st);
        this.head.classList.toggle("is-on", lv > 0);
        this.head.querySelector(".fb-lv").textContent = lv ? String(lv) : "";
      }

      place() {
        const r = this.view.state.selection.main;
        let rect = null;
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed && this.view.dom.contains(sel.anchorNode)) {
          const b = sel.getRangeAt(0).getBoundingClientRect();
          if (b.width || b.height) rect = b;
        }
        if (!rect) {
          const a = this.view.coordsAtPos(r.from);
          const z = this.view.coordsAtPos(r.to);
          if (!a || !z) return this.hide();
          rect = { top: Math.min(a.top, z.top), bottom: Math.max(a.bottom, z.bottom), left: Math.min(a.left, z.left), right: Math.max(a.right, z.right) };
        }
        const box = this.el.getBoundingClientRect();
        const w = box.width || 260;
        const hgt = box.height || 34;
        let left = (rect.left + rect.right) / 2 - w / 2;
        left = Math.max(10, Math.min(left, innerWidth - w - 10));
        let top = rect.top - hgt - GAP;
        let below = false;
        if (top < 52) { top = rect.bottom + GAP; below = true; }
        // the editor may be scrolled so the selection is off-screen
        const host = this.view.scrollDOM.getBoundingClientRect();
        if (rect.bottom < host.top - 4 || rect.top > host.bottom + 4) return this.hide();
        this.el.classList.toggle("is-below", below);
        this.el.style.left = Math.round(left) + "px";
        this.el.style.top = Math.round(top) + "px";
      }

      show() {
        if (o.formatBar && !o.formatBar()) return this.hide();
        const r = this.view.state.selection.main;
        if (r.empty || !this.view.hasFocus) return this.hide();
        if (!this.el) this.build();
        const fresh = this.el.hidden;
        this.el.hidden = false;
        this.paint();
        this.place();
        if (fresh && motionOk()) {
          this.el.classList.remove("is-in");
          requestAnimationFrame(() => this.el && this.el.classList.add("is-in"));
        } else this.el.classList.add("is-in");
      }

      hide() {
        clearTimeout(this.timer);
        if (!this.el || this.el.hidden) return;
        this.el.classList.remove("is-in");
        this.el.hidden = true;
        // a menu the keyboard went into (the Menu key on a selection) is not this bar's to close
        if (!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".menu"))) closeMenu();
      }

      destroy() {
        clearTimeout(this.timer);
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        this.view.dom.removeEventListener("mousedown", this.onDown);
        window.removeEventListener("mouseup", this.onUp);
        window.removeEventListener("keydown", this.onKey, true);
        window.removeEventListener("resize", this.onScroll);
        if (this.el) this.el.remove();
        this.el = null;
      }
    }
  );
}
