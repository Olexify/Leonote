// Toasts, context menus, inline editors. No modal dialogs anywhere: every
// destructive action is instant and undoable from a toast instead.

import { h, plainError } from "./util.js";
import { icon } from "./icons.js";

// F6 reaches the newest message's button (its Undo) from the keyboard; the button used, focus goes back to where it was
let toastReturn = null;
let menuKeyAt = -1e9; // when the Menu key or Shift+F10 was last pressed
const backFromToast = () => { const t = toastReturn; toastReturn = null; if (t && t.isConnected && t.focus) t.focus(); };

export function toast(text, { action, actions, ms, kind } = {}) {
  ms ??= kind === "error" ? 10000 : 4200; // why something failed takes longer to read
  if (kind === "error") text = plainError(text); // "(os error 32)" said as a person would
  const root = document.getElementById("toasts");
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    // closed while used from the keyboard (by its button, Esc, or the app replacing it): focus goes back, not to the page
    if (el.contains(document.activeElement)) backFromToast();
    el.classList.remove("is-in");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  const el = h(
    "div",
    // the list itself is the polite live region (index.html); an error interrupts
    { class: "toast" + (kind ? " is-" + kind : ""), role: kind === "error" ? "alert" : null },
    kind === "agent" ? icon("sparkles") : null,
    h("span", { class: "toast-text", text }),
    ...(actions || [action]).filter(Boolean).map((a) => h("button", { class: "toast-btn", text: a.label, onmousedown: (e) => e.preventDefault(), onclick: () => { const kb = el.contains(document.activeElement); close(); a.run(); if (kb) backFromToast(); else toastReturn = null; } }))
  );
  root.append(el);
  // four at most: the oldest goes, but never the one being used from the keyboard (F6)
  while (root.children.length > 4) { const old = [...root.children].find((c) => !c.contains(document.activeElement)); if (!old) break; old.remove(); }
  requestAnimationFrame(() => el.classList.add("is-in"));
  timer = setTimeout(close, ms);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => { if (!el.contains(document.activeElement)) timer = setTimeout(close, 1600); });
  // reached by keyboard (F6): it stays while it has focus; Esc lets it go
  el.addEventListener("focusin", () => clearTimeout(timer));
  el.addEventListener("focusout", () => { timer = setTimeout(close, 1600); });
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  return close;
}

/**
 * A card at the top right: pasted pictures, files opened from outside. They
 * stack, each with a line draining at its foot that says how long it stays;
 * the line halts while the pointer is on the card (or while `hold()` says so).
 */
export function cornerCard(el, { ms = 6000, hold, reset = true } = {}) {
  let root = document.getElementById("corner-cards");
  if (!root) { root = h("div", { id: "corner-cards" }); document.body.append(root); }
  const fill = h("div", { class: "cc-bar-fill" });
  el.classList.add("cc");
  el.append(h("div", { class: "cc-bar" }, fill));
  root.append(el);
  while (root.children.length > 6) root.firstChild.remove();
  requestAnimationFrame(() => el.classList.add("is-in"));
  const told = () => { if (typeof dispatchEvent === "function") dispatchEvent(new Event("leo:overlay")); }; // a web page under it makes room
  told();
  let left = ms;
  let last = performance.now();
  let paused = false;
  let raf = 0;
  const close = () => { cancelAnimationFrame(raf); el.classList.remove("is-in"); setTimeout(() => { el.remove(); told(); }, 220); };
  const tick = (now) => {
    if (!paused && !(hold && hold())) left -= now - last;
    // the pointer on it: the line fills back up, smoothly, to show the full time is coming back
    else if (paused && reset && left < ms) left = Math.min(ms, left + Math.max(ms * 0.004, (ms - left) * 0.14));
    last = now;
    fill.style.width = Math.max(0, (left / ms) * 100) + "%";
    if (left <= 0) return close();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  el.addEventListener("mouseenter", () => { paused = true; });
  el.addEventListener("mouseleave", () => { paused = false; });
  el.close = close;
  return close;
}

let openMenu = null;

export function closeMenu() {
  if (openMenu) { openMenu(); openMenu = null; }
}

/** items: { label, icon, run, keys, danger, checked, sub: [items] } | { el } | "sep" | null */
export function menu(x, y, items, { anchor } = {}) {
  closeMenu();
  // menus opened from a row of this one (it.sub), deepest last
  const subs = [];
  const dropSubs = (depth) => { while (subs.length > depth) subs.pop().el.remove(); };
  function openSub(b, list, depth) {
    if (subs[depth] && subs[depth].from === b) return;
    dropSubs(depth);
    const s = h("div", { class: "menu is-sub", role: "menu" });
    fill(s, list, depth + 1);
    document.getElementById("overlay-root").append(s);
    const at = b.getBoundingClientRect();
    const r = { width: s.offsetWidth, height: s.offsetHeight };
    // to the right when there is room, else to the left of the parent
    s.style.left = (at.right + r.width + 4 > innerWidth - 8 ? Math.max(8, at.left - r.width + 4) : at.right - 4) + "px";
    s.style.top = Math.max(8, Math.min(at.top - 6, innerHeight - r.height - 8)) + "px";
    requestAnimationFrame(() => s.classList.add("is-in"));
    subs.push({ el: s, from: b });
    for (const x of b.parentElement.querySelectorAll(".is-open")) x.classList.remove("is-open");
    b.classList.add("is-open");
  }
  function fill(into, list, depth) {
    // A press on a row must not take the focus from whoever opened the menu:
    // the editor losing it hides the selection bar, which closes this menu -
    // before the click that was on its way ever arrives ("Turn into" did nothing).
    into.addEventListener("mousedown", (e) => e.preventDefault());
    for (const it of list) {
      if (!it) continue;
      if (it === "sep") { into.append(h("div", { class: "menu-sep" })); continue; }
      // a row of the caller's own making (a strip of buttons, say): it stays open under the clicks
      if (it.el) { into.append(it.el); continue; }
      if (it.header) { into.append(h("div", { class: "menu-header" + (it.plain ? " is-plain" : ""), text: it.header })); continue; }
      const b = h(
        "button",
        // a tick is said, not only drawn
        { class: "menu-item" + (it.danger ? " is-danger" : "") + (it.checked ? " is-checked" : "") + (it.sub ? " has-sub" : ""), role: "checked" in it ? "menuitemcheckbox" : "menuitem", "aria-checked": "checked" in it ? String(!!it.checked) : null, title: it.title || null,
          onclick: () => {
            if (it.sub && !it.run) return openSub(b, it.sub, depth);
            // a toggle (keep: true) leaves the menu up and ticks in place: several can be set in one go
            if (it.keep) {
              it.checked = !it.checked;
              b.classList.toggle("is-checked", it.checked);
              b.setAttribute("aria-checked", String(!!it.checked));
              const tick = b.querySelector(".menu-tick");
              if (it.checked && !tick) b.append(icon("check", "menu-tick")); else if (!it.checked && tick) tick.remove();
              it.run();
              return;
            }
            closeMenu();
            it.run();
          } },
        it.swatch ? h("span", { class: "ico menu-swatch", style: { background: it.swatch } }) : it.icon ? icon(it.icon) : h("span", { class: "ico" }),
        h("span", { class: "menu-label", text: it.label }),
        it.tail ? it.tail : it.sub ? icon("chevron", "menu-more") : it.checked ? icon("check", "menu-tick") : it.keys ? h("kbd", { text: it.keys }) : null
      );
      // a tail control (a mic, say) acts on its own and leaves the menu up
      if (it.tail) it.tail.addEventListener("click", (e) => e.stopPropagation());
      b.addEventListener("mouseenter", () => { if (it.sub) openSub(b, it.sub, depth); else { dropSubs(depth); for (const x of into.querySelectorAll(".is-open")) x.classList.remove("is-open"); } });
      b.addEventListener("keydown", (e) => {
        if (it.sub && (e.key === "ArrowRight" || e.key === "Enter")) { e.preventDefault(); e.stopPropagation(); openSub(b, it.sub, depth); const f = subs[depth] && subs[depth].el.querySelector(".menu-item"); if (f) f.focus(); }
        else if (depth > 0 && e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); const from = subs[depth - 1] && subs[depth - 1].from; dropSubs(depth - 1); if (from) from.focus(); }
      });
      if (depth === 0) buttons.push(b);
      into.append(b);
    }
  }
  // Whoever had the keyboard gets it back when the menu goes. Without this the
  // clicked item takes focus to <body> with it, and the editor underneath goes
  // deaf: Ctrl+Z after a menu command did nothing at all.
  const hadFocus = document.activeElement;
  const el = h("div", { class: "menu", role: "menu" });
  const buttons = [];
  fill(el, items, 0);
  document.getElementById("overlay-root").append(el);
  // opened from the keyboard (the Menu key, Shift+F10): its first item takes the focus, so it is heard and used at
  // once (not on a click: the editor keeps its selection under the selection bar's menu)
  if (performance.now() - menuKeyAt < 600 && buttons[0]) requestAnimationFrame(() => buttons[0].focus());

  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  }
  // the size without the opening scale-in, or it lands a few px too far and its edge is cut
  const r = { width: el.offsetWidth, height: el.offsetHeight };
  el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  el.style.top = (y + r.height > innerHeight - 8 ? Math.max(8, y - r.height - (anchor ? 36 : 0)) : y) + "px";
  requestAnimationFrame(() => el.classList.add("is-in"));

  let idx = -1;
  const onDown = (e) => { if (!el.contains(e.target) && !subs.some((s) => s.el.contains(e.target))) closeMenu(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      // within whichever menu has the focus
      const home = document.activeElement && document.activeElement.closest(".menu");
      const list = home && home !== el ? [...home.querySelectorAll(".menu-item")] : buttons;
      const at = list.indexOf(document.activeElement);
      idx = ((at >= 0 ? at : list === buttons ? idx : -1) + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[idx].focus();
    }
  };
  // listeners go on after this tick (the opening click must not close it);
  // a menu closed before then must not leave them behind
  let closed = false;
  setTimeout(() => {
    if (closed) return;
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  // Leaving the window closes the menu - but only a REAL leaving. The window
  // coming to the front (a right-click on Leonote while another program had
  // the keys) hands the keys around for a moment, and that flicker of "blur"
  // used to shut the menu the instant it opened.
  const onBlur = () => setTimeout(() => { if (!closed && !document.hasFocus()) closeMenu(); }, 350);
  window.addEventListener("blur", onBlur);
  openMenu = () => {
    closed = true;
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    dropSubs(0);
    el.remove();
    const now = document.activeElement;
    if ((!now || now === document.body) && hadFocus && hadFocus !== document.body && hadFocus.isConnected) {
      try { hadFocus.focus({ preventScroll: true }); } catch {}
    }
  };
}

/**
 * Swap `target` for a text editor in place. Multi-line grows with content,
 * caret lands at the END. Enter commits (Shift+Enter = newline when
 * multiline), Escape cancels, blur commits.
 */
export function inlineEdit(target, value, { multiline = false, selectBase = false, className = "", onCommit, onCancel } = {}) {
  const ed = h(multiline ? "textarea" : "input", { class: "inline-edit " + className, spellcheck: multiline });
  ed.value = value;
  if (multiline) ed.rows = 1;
  const grow = () => {
    if (!multiline) return;
    ed.style.height = "auto";
    ed.style.height = ed.scrollHeight + "px";
  };
  target.replaceWith(ed);
  grow();
  // it is where it was clicked: focusing it must not scroll the list (under a sticky bar the row would slide away)
  ed.focus({ preventScroll: true });
  if (selectBase) {
    const dot = value.lastIndexOf(".");
    ed.setSelectionRange(0, dot > 0 ? dot : value.length);
  } else {
    ed.setSelectionRange(value.length, value.length);
  }
  ed.addEventListener("input", grow);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const next = ed.value;
    if (ed.isConnected) ed.replaceWith(target);
    if (commit && next.trim() && next !== value) onCommit && onCommit(next);
    else onCancel && onCancel();
  };
  ed.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    else if (e.key === "Enter" && !(multiline && e.shiftKey)) { e.preventDefault(); finish(true); }
  });
  ed.addEventListener("blur", () => finish(true));
  ed.addEventListener("mousedown", (e) => e.stopPropagation());
  ed.addEventListener("click", (e) => e.stopPropagation());
  return ed;
}

/**
 * Drag to reorder siblings matching `item` inside `container` (delegated, so
 * rows can be re-rendered freely). onMove(fromIndex, toIndex, draggedEl) gets
 * indices among the dragged element's matching siblings.
 */
export function sortable(container, { item, onMove, adopt = null, onAdopt = null, axis = "y" }) {
  // axis "x": the items stand in a row (chips, tiles), so before/after is left/right
  const firstHalf = (e, r) => (axis === "x" ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2);
  // `adopt` (a selector) + `onAdopt(el, host, before)`: an item may also be
  // dropped on a host of another list - a step dragged onto a different task.
  // `before` is the item of that list it landed ahead of, or null for the end.
  let from = null;
  const siblings = (el) => [...el.parentElement.children].filter((c) => c.matches(item));
  const clear = () => {
    for (const x of container.querySelectorAll(".drop-before, .drop-after, .drop-into")) x.classList.remove("drop-before", "drop-after", "drop-into");
  };
  const end = () => {
    clear();
    if (from) from.classList.remove("is-dragging");
    from = null;
    document.removeEventListener("dragover", outside);
    document.removeEventListener("drop", outsideDrop);
  };
  /**
   * The sibling a pointer position means. The element under the pointer is
   * often NOT one: it is a step inside another task, the gap between two rows,
   * or the empty space under the last one. Each of those used to be a dead
   * zone where the drop was simply refused, which felt like dragging "sometimes
   * not working". So: climb to a sibling if there is one above the target,
   * otherwise take the nearest sibling by height.
   */
  const target = (e) => {
    if (!from || !from.parentElement) return null;
    for (let n = e.target && e.target.closest && e.target.closest(item); n; n = n.parentElement && n.parentElement.closest(item)) {
      if (n.parentElement === from.parentElement) return n;
    }
    let best = null;
    let gap = Infinity;
    for (const c of siblings(from)) {
      const r = c.getBoundingClientRect();
      if (axis === "y" && (e.clientX < r.left - 60 || e.clientX > r.right + 60)) continue;
      const dy = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
      const dx = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
      const d = axis === "x" ? Math.hypot(dx, dy) : dy;
      if (d < gap) { gap = d; best = c; }
    }
    return gap < 140 ? best : null;
  };
  /** A host of another list under the pointer, for an item that may change lists. */
  const hostOf = (e) => {
    if (!adopt || !onAdopt || !from) return null;
    const host = e.target && e.target.closest && e.target.closest(adopt);
    if (!host || !container.contains(host) || host.contains(from) || from.matches(adopt)) return null;
    return host;
  };

  /** Mark where a drop here would land. True when there is somewhere for it to land. */
  function hover(e) {
    const host = hostOf(e);
    clear();
    if (host) {
      const over = e.target.closest(item);
      if (over && over !== host && host.contains(over) && over.classList[0] === from.classList[0] && over.draggable) {
        const r = over.getBoundingClientRect();
        over.classList.add(firstHalf(e, r) ? "drop-before" : "drop-after");
      } else host.classList.add("drop-into");
      return true;
    }
    const el = target(e);
    if (!el) return false;
    if (el !== from) {
      const r = el.getBoundingClientRect();
      el.classList.add(firstHalf(e, r) ? "drop-before" : "drop-after");
    }
    return true;
  }

  function land(e) {
    const host = hostOf(e);
    if (host) {
      const mark = host.querySelector(".drop-before, .drop-after");
      let before = null;
      if (mark) before = mark.classList.contains("drop-before") ? mark : mark.nextElementSibling && mark.nextElementSibling.matches(item) ? mark.nextElementSibling : null;
      const el = from;
      end();
      onAdopt(el, host, before);
      return;
    }
    const el = target(e);
    if (el && el !== from && from.parentElement) {
      const list = siblings(from);
      const i = list.indexOf(from);
      const r = el.getBoundingClientRect();
      let j = list.indexOf(el) + (firstHalf(e, r) ? 0 : 1);
      if (j > i) j--;
      const moved = from;
      end();
      if (i >= 0 && j !== i) onMove(i, j, moved);
      return;
    }
    end();
  }

  // the space under the last row, or beside the list, is outside `container`:
  // while something is in the air the whole document listens
  function outside(e) {
    if (!from || container.contains(e.target)) return;
    if (hover(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
  }
  function outsideDrop(e) {
    if (!from || container.contains(e.target)) return;
    e.preventDefault();
    land(e);
  }

  container.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return; // our own notice from the hand-made drag below
    const el = e.target.closest && e.target.closest(item);
    if (!el || !container.contains(el) || e.target.closest("input, textarea")) return;
    from = el;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
    el.classList.add("is-dragging");
    document.addEventListener("dragover", outside);
    document.addEventListener("drop", outsideDrop);
  });
  container.addEventListener("dragover", (e) => {
    if (!from) return;
    if (!hover(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
  });
  container.addEventListener("drop", (e) => {
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    land(e);
  });
  container.addEventListener("dragend", (e) => { if (e.dataTransfer) end(); });

  /*
   * The browser will not start a drag on a press that counts as a double
   * click - and "click a row, then at once drag it" is exactly that. The press
   * did nothing at all, which is the other half of "dragging sometimes does
   * not work". For that one case the drag is done by hand, with the same
   * marks and the same landing as the real thing.
   */
  container.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.detail < 2 || from) return;
    const el = e.target.closest && e.target.closest(item);
    if (!el || !container.contains(el) || !el.draggable || e.target.closest("input, textarea, button, .inline-edit")) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let live = false;
    const at = (ev) => ({ target: document.elementFromPoint(ev.clientX, ev.clientY), clientX: ev.clientX, clientY: ev.clientY });
    const move = (ev) => {
      if (!live) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        live = true;
        from = el;
        el.classList.add("is-dragging");
        document.body.classList.add("is-hand-dragging");
        container.dispatchEvent(new CustomEvent("dragstart"));
      }
      ev.preventDefault();
      hover(at(ev));
    };
    const up = (ev) => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      if (!live) return;
      document.body.classList.remove("is-hand-dragging");
      // the release must not also count as a click on whatever is under it
      const eat = (c) => { c.stopPropagation(); c.preventDefault(); };
      document.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", eat, true), 0);
      land(at(ev));
      container.dispatchEvent(new CustomEvent("dragend"));
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  });
}

export function kbd(keys) {
  return h("span", { class: "kbds" }, keys.split(" ").map((k) => h("kbd", { text: k })));
}

/**
 * A small dialog with a few text fields: fields = [{ key, label, value, placeholder }].
 * Resolves { key: value } on OK (Enter), null otherwise.
 */
export function askDialog(title, fields, { ok = "OK", text } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const inputs = fields.map((f) => h("input", { class: "dlg-input", type: f.type || "text", value: f.value || "", placeholder: f.placeholder || "", spellcheck: "false" }));
    const done = (v) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      if (prev && prev.focus) prev.focus();
      resolve(v ? Object.fromEntries(fields.map((f, i) => [f.key, inputs[i].value.trim()])) : null);
    };
    const box = h("div", { class: "dlg", role: "dialog", "aria-modal": "true" },
      h("h3", { class: "dlg-title", text: title }),
      text ? h("p", { class: "dlg-text", text }) : null,
      ...fields.map((f, i) => h("label", { class: "dlg-field" }, h("span", { class: "dlg-label", text: f.label }), inputs[i])),
      h("div", { class: "dlg-btns" }, h("button", { class: "btn", onclick: () => done(false) }, "Cancel"), h("button", { class: "btn btn-primary", onclick: () => done(true) }, ok)));
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } }, box);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      // Enter on a button is that button's click: Cancel cancels
      else if (e.key === "Enter" && !e.shiftKey && e.target.tagName !== "BUTTON") { e.preventDefault(); e.stopPropagation(); done(true); }
      else e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    // now, and again a frame later: whatever closed before this (a menu) hands
    // the keys back to where they were, and that must not win
    inputs[0].focus();
    inputs[0].select();
    requestAnimationFrame(() => { back.classList.add("is-in"); if (back.isConnected && !box.contains(document.activeElement)) inputs[0].focus(); });
  });
}

/** A small yes/no dialog. Resolves true when confirmed (Enter), false otherwise (Esc, Cancel, outside). */
export function confirmDialog(title, text, { ok = "Delete", danger = true, safe = false } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const done = (v) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      if (prev && prev.focus) prev.focus();
      resolve(v);
    };
    const okBtn = h("button", { class: "btn " + (danger ? "btn-danger" : "btn-primary"), onclick: () => done(true) }, ok);
    const cancelBtn = h("button", { class: "btn", onclick: () => done(false) }, "Cancel");
    const box = h("div", { class: "dlg", role: "alertdialog", "aria-modal": "true" },
      h("h3", { class: "dlg-title", text: title }),
      text ? h("p", { class: "dlg-text", text }) : null,
      h("div", { class: "dlg-btns" }, cancelBtn, okBtn));
    const back = h("div", { class: "dlg-back", onmousedown: (e) => { if (e.target === back) done(false); } }, box);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      // safe: Enter answers with the button that has the focus - Cancel to begin with, so a stray Enter does nothing. Otherwise only Cancel itself says no
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(safe ? document.activeElement === okBtn : document.activeElement !== cancelBtn); }
    };
    document.addEventListener("keydown", onKey, true);
    document.getElementById("overlay-root").append(back);
    requestAnimationFrame(() => { back.classList.add("is-in"); (safe ? cancelBtn : okBtn).focus(); });
  });
}

/* Every dialog, whoever opens it: a dialog to a screen reader, named after its heading, the keys inside it while it is open (on the dialog
   itself when it focuses nothing of its own) and back where they were after. Paint's own panels
   sit beside the picture and leave the keys alone. */
const dlgPrev = new WeakMap();
function dialogOpened(back) {
  // any dialog box, not only .dlg ones (Versions and Erase draw their own): Tab stays inside it
  const box = back.querySelector(".dlg, [role=dialog], [role=alertdialog]"), title = back.querySelector(".dlg-title");
  if (box && !box.hasAttribute("role")) box.setAttribute("role", "dialog");
  if (box && title && !box.hasAttribute("aria-label")) box.setAttribute("aria-label", title.textContent);
  dlgPrev.set(back, document.activeElement);
  // a frame later: the dialog's own focus has landed by then, and so has what a closing palette hands the keys to
  requestAnimationFrame(() => {
    if (!box || !back.isConnected || box.contains(document.activeElement)) return;
    dlgPrev.set(back, document.activeElement);
    box.tabIndex = -1;
    box.style.outline = "none";
    box.focus();
  });
}
function dialogClosed(back) {
  const prev = dlgPrev.get(back), a = document.activeElement;
  if (a && a !== document.body) return;
  if (prev && prev.isConnected && prev !== document.body) prev.focus();
  // what had the keys is gone: back to the page, unless something else is still open over it
  else if (!document.querySelector(".dlg-back:not(.pt-dlg-back), .pal-back:not(.is-out)")) window.leonote?.focusMain?.();
}
function topDialog() {
  const backs = document.querySelectorAll(".dlg-back:not(.pt-dlg-back)");
  return backs.length ? backs[backs.length - 1].querySelector(".dlg, [role=dialog], [role=alertdialog]") : null;
}
/* Enter on a dialog's button is that button's click, whatever the dialog's own keys say Enter means: Cancel cancels.
   This listener is there from the start, so it runs before the one any dialog adds when it opens. */
function dialogEnter(e) {
  if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const a = document.activeElement, box = a && a.tagName === "BUTTON" ? topDialog() : null;
  if (box && box.contains(a)) e.stopImmediatePropagation();
}
function dialogTab(e) {
  if (e.key !== "Tab") return;
  const box = topDialog();
  if (!box) return;
  const a = document.activeElement;
  // a menu or picker over the dialog keeps its own Tab
  if (!box.contains(a) && a !== document.body && !a.closest("#app")) return;
  const items = [...box.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled && el.getClientRects().length);
  if (!items.length) return;
  const edge = e.shiftKey ? items[0] : items[items.length - 1];
  if (a !== edge && box.contains(a) && !(a === box && e.shiftKey)) return;
  e.preventDefault();
  (e.shiftKey ? items[items.length - 1] : items[0]).focus();
}
if (typeof MutationObserver === "function") {
  const isDlg = (n) => n.classList && n.classList.contains("dlg-back") && !n.classList.contains("pt-dlg-back");
  const seen = new MutationObserver((list) => {
    for (const r of list) {
      for (const n of r.addedNodes) if (isDlg(n)) dialogOpened(n);
      for (const n of r.removedNodes) if (isDlg(n)) dialogClosed(n);
    }
  });
  seen.observe(document.body, { childList: true });
  const root = document.getElementById("overlay-root");
  if (root) seen.observe(root, { childList: true });
  document.addEventListener("keydown", dialogTab, true);
  document.addEventListener("keydown", dialogEnter, true);
}

/** A file renamed to another ending (.jpg to .png): yes or no first, the old and the new name shown. True when the ending stays. */
export function confirmRenameExt(from, to) {
  const ext = (n) => (/\.([^.\\/]+)$/.exec(n) || [, ""])[1].toLowerCase();
  if (ext(from) === ext(to)) return Promise.resolve(true);
  return confirmDialog("Change the file's type?", `${from}  →  ${to}. Only the name changes - what is inside stays as it was, so a program may not open it if the new ending does not fit.`, { ok: ext(to) ? `Make it .${ext(to)}` : "Take the ending off", danger: false });
}

/**
 * A long panel of options in sections that fold, as Settings' groups do: each section a row with an icon,
 * its name and an arrow, its options under it when open. Which ones are open is remembered under `key`
 * (this computer only); the first time, the sections marked `open` are.
 * sections: [{ title, icon, body: [nodes], open, id }] - id (else the title) is what is remembered
 */
export function foldSections(sections, key) {
  let open;
  try { const saved = JSON.parse(localStorage.getItem(key) || "null"); open = new Set(Array.isArray(saved) ? saved : sections.filter((s) => s.open).map((s) => s.id || s.title)); }
  catch { open = new Set(sections.filter((s) => s.open).map((s) => s.id || s.title)); }
  const save = () => { try { localStorage.setItem(key, JSON.stringify([...open])); } catch { /* fine */ } };
  return h("div", { class: "fsec-list" }, ...sections.map((sec) => {
    const id = sec.id || sec.title;
    const wrap = h("div", { class: "fsec" + (open.has(id) ? " is-open" : "") });
    const head = h("button", { class: "fsec-head", type: "button", onclick: () => {
      const on = !wrap.classList.contains("is-open");
      wrap.classList.toggle("is-open", on);
      on ? open.add(id) : open.delete(id);
      save();
      if (on) { wrap.classList.remove("is-opening"); void wrap.offsetWidth; wrap.classList.add("is-opening"); }
    } }, h("span", { class: "fsec-ico" }, icon(sec.icon || "settings")), h("span", { class: "fsec-title", text: sec.title }), icon("chevronDown", "fsec-caret"));
    wrap.append(head, h("div", { class: "fsec-body" }, ...sec.body.filter(Boolean)));
    return wrap;
  }));
}

// F6 to the newest message (toastReturn above) - set up last, so the listeners before it keep their order
if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("keydown", (e) => {
  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) menuKeyAt = performance.now();
  if (e.key !== "F6" || e.ctrlKey || e.altKey || e.metaKey) return;
  const b = [...document.querySelectorAll("#toasts .toast:not(.is-out) .toast-btn")].pop();
  if (!b) return;
  e.preventDefault();
  // a second F6 (already in a message) keeps the place to go back to
  if (!document.getElementById("toasts").contains(document.activeElement)) toastReturn = document.activeElement;
  b.focus();
}, true); // first, before anything that keeps the key to itself
