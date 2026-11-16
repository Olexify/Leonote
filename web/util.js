// Small, dependency-free helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * h("div", { class: "row", onclick: fn, dataset: { id } }, child, "text")
 * Children may be nodes, strings, arrays or null. Built detached, so a whole
 * list is assembled off-document and attached in one go.
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "style" && typeof v === "object") {
        // custom properties only take effect through setProperty
        for (const s in v) s.startsWith("--") ? el.style.setProperty(s, v[s]) : (el.style[s] = v[s]);
      }
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c.nodeType ? c : String(c));
  }
}

// Local-naive ISO time. NOT UTC: the task files, the Python app and the AI
// contract all read these as the same wall clock.
export const localIso = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
export const dayKey = (d = new Date()) => localIso(d).slice(0, 10);

export function parseDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Props for a row or tile that acts as a button: Tab reaches it, Enter and Space press it. A mouse click leaves the
 *  focus where it was without the tabindex, so the view's keys keep working after a redraw. */
export const pressable = (fn) => ({
  tabindex: "0", role: "button",
  onfocus: (e) => { if (!e.currentTarget.matches(":focus-visible")) e.currentTarget.parentElement?.closest("[tabindex]")?.focus({ preventScroll: true }); },
  onkeydown: (e) => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget, up = el.parentElement?.closest("[tabindex]");
    fn(e);
    if (!el.isConnected) up?.focus({ preventScroll: true });
  },
});

export const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      });

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...a); }, ms);
  };
  d.flush = (...a) => { if (t) { clearTimeout(t); t = null; fn(...a); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

export const basename = (p) => {
  const b = p.slice(p.lastIndexOf("/") + 1);
  return b.toLowerCase().endsWith(".md") ? b.slice(0, -3) : b;
};
export const dirname = (p) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
export const joinPath = (dir, name) => (dir ? dir + "/" + name : name);

/** Characters Windows refuses in a filename, plus the path separators. */
export function safeName(s) {
  // the same characters written as escapes (not raw control bytes); a name kept under 200 so Windows' 255
  // still holds it with a trash stamp or a temp mark around it
  const out = s.replace(/[<>:"/\\|?*#^[\]\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/, "").replace(/[. ]+$/, "");
  return out || "Untitled";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const naturalCompare = (a, b) => collator.compare(a, b);

export function relTime(ms, now = Date.now()) {
  const s = Math.round((now - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d > 300 ? "numeric" : undefined });
}

export function fmtDay(d, opts) {
  return d.toLocaleDateString(undefined, opts || { weekday: "short", day: "numeric", month: "short" });
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Tiny pub/sub. The app is a handful of stores talking through this. */
export function emitter() {
  const map = new Map();
  return {
    on(ev, fn) {
      if (!map.has(ev)) map.set(ev, new Set());
      map.get(ev).add(fn);
      return () => map.get(ev).delete(fn);
    },
    emit(ev, payload) {
      const s = map.get(ev);
      if (s) for (const fn of [...s]) fn(payload);
    },
  };
}

/** Is focus in something that owns its own keystrokes? */
export function isTyping(el = document.activeElement) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const t = el.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

/**
 * Hand focus back to where it was when an overlay closes, WITHOUT the page
 * moving. A plain `focus()` on an editor scrolls its caret into view, and a
 * note whose caret is still on line one jumps to the top - so every scroller
 * above the element is put back exactly where it was.
 */
export function refocus(el) {
  if (!el || typeof el.focus !== "function" || !el.isConnected) return;
  const kept = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.scrollTop || n.scrollLeft) kept.push([n, n.scrollTop, n.scrollLeft]);
  }
  const put = () => { for (const [n, top, left] of kept) { if (n.scrollTop !== top) n.scrollTop = top; if (n.scrollLeft !== left) n.scrollLeft = left; } };
  try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  put();
  // an editor may react to the focus a frame later (selection sync)
  requestAnimationFrame(put);
}

/* ── motion ───────────────────────────────────────────────────────────────
   One setting drives every animation: <html data-motion> is the switch, CSS
   does the work. JS only asks before it animates something itself. */

export const MOTION_MODES = ["full", "lively", "gorgeous", "reduced", "off"];

/** What the app should do given a stored value (undefined = never chosen). */
export const resolveMotion = (stored, prefersReduced = false) =>
  MOTION_MODES.includes(stored) ? stored : prefersReduced ? "reduced" : "full";

/** The mode in force right now, read off <html>. */
export const motionMode = () =>
  typeof document === "undefined" ? "full" : resolveMotion(document.documentElement.dataset.motion);

/** May we animate at all? False only when motion is Off. */
export const motionOk = () => motionMode() !== "off";
/** May we *move* things? False for Reduced and Off - fades are still fine. */
export const motionFull = () => !["off", "reduced"].includes(motionMode());

/**
 * Fade+rise a freshly painted list, 12 ms apart. Capped at ten rows, and the
 * class goes on those ten only - a list of five hundred pays for ten, and
 * nothing below the fold animates at all. The classes come off again so a
 * later re-render does not replay it.
 */
export function staggerIn(els, cap = 10) {
  if (!motionOk()) return;
  const rows = [];
  for (const el of els) { if (rows.length >= cap) break; rows.push(el); }
  if (!rows.length) return;
  rows.forEach((el, i) => { el.classList.add("anim-row"); if (i) el.style.setProperty("--i", String(i)); });
  // When the rows themselves rise, the pane around them only cross-fades:
  // a transform on a container of hundreds of rows while ten of them animate
  // inside it is the one combination that costs frames.
  const view = rows[0].closest && rows[0].closest(".view");
  if (view) view.classList.add("no-lift");
  setTimeout(() => {
    for (const el of rows) { el.classList.remove("anim-row"); el.style.removeProperty("--i"); }
    if (view) view.classList.remove("no-lift");
  }, 460);
}

/** staggerIn for a list container that has just been repainted. */
export function animateRows(container) {
  if (container && !container.hidden) staggerIn(container.children);
}

/** Count a number up to its new value. Jumps straight there when motion is off. */
export function countTo(el, to, { ms = 220, fmt = String } = {}) {
  if (!el) return;
  const from = Number(String(el.textContent).replace(/[^\d-]/g, ""));
  if (!motionFull() || !Number.isFinite(from) || from === to || Math.abs(to - from) > 999 || !el.isConnected) {
    el.textContent = fmt(to);
    return;
  }
  cancelAnimationFrame(el._countRaf || 0);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) * (1 - k) * (1 - k); // ease-out cubic
    el.textContent = fmt(k < 1 ? Math.round(from + (to - from) * e) : to);
    if (k < 1) el._countRaf = requestAnimationFrame(step);
  };
  el._countRaf = requestAnimationFrame(step);
}

/**
 * Collapse a row out of a list, then remove it. Returns at once - the caller
 * has already forgotten the row, this only animates the hole closing.
 */
export function collapseOut(el, ms = 160) {
  if (!el || !el.isConnected) return;
  const r = motionFull() && el.getBoundingClientRect();
  // nothing animates for a row nobody can see - it just goes
  if (!r || !r.height || r.bottom < 0 || r.top > innerHeight) { el.remove(); return; }
  const h0 = r.height;
  el.style.height = h0 + "px";
  el.classList.add("is-collapsing");
  requestAnimationFrame(() => {
    // padding and margin go too, or a row with padding never reaches zero
    el.style.cssText += ";height:0;opacity:0;padding-top:0;padding-bottom:0;margin-top:0;margin-bottom:0";
  });
  setTimeout(() => el.remove(), ms + 40);
}

/**
 * The key a shortcut means, whatever the keyboard layout: on a Cyrillic (or
 * any non-Latin) layout e.key for the Z key is "я", and Ctrl+Z, B for brush,
 * [ and ] all went dead. Letters and the punctuation shortcuts use come from
 * the physical key instead; everything else is e.key as it was.
 */
const PUNCT = { BracketLeft: "[{", BracketRight: "]}", Backslash: "\|", Comma: ",<", Period: ".>", Slash: "/?", Minus: "-_", Equal: "=+", Semicolon: ";:", Quote: "'\"" };
export function keyOf(e) {
  const c = e.code || "";
  // a Latin letter is the letter typed (German Z sits where US Y is, French A where Q is); only another alphabet
  // (я, с on a Ukrainian layout) falls back to where the key sits
  if (/^[a-z]$/i.test(e.key || "")) return e.key;
  // AltGr (Ctrl+Alt to Windows) types its own characters - Czech [ on F, Polish ś on S: they stay what they type
  if (e.getModifierState && e.getModifierState("AltGraph")) return e.key;
  if (/^Key[A-Z]$/.test(c)) return e.shiftKey ? c[3] : c[3].toLowerCase();
  if (PUNCT[c] && !/^[ -~]$/.test(e.key)) return PUNCT[c][e.shiftKey ? 1 : 0];
  return e.key;
}

/** A request's deadline: aborted after `ms`, or sooner by `signal` when one is given. Every call to a site
    outside has one, so a connection that hangs never leaves a wait behind. */
export const deadline = (ms, signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** An attribute's value as CSS reads it: escapes decoded, blanks and control characters out, lower case. */
export function cssPlain(s) {
  return String(s)
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, x) => { const n = parseInt(x, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " "; })
    .replace(/\\(.)/g, "$1")
    .replace(/[\u0000- \u007f]+/g, "")
    .toLowerCase();
}
/** Whether a value (as cssPlain gives it) would fetch something: url() to anywhere but #inside, image-set(), @import… */
export const cssFetches = (v) => /@import|image-set\(|cross-fade\(|(^|[^-a-z])image\(|url\((?!['"]?#)/.test(v);

// what Windows said, in plain words: "Access is denied. (os error 5)" and the like, as a person would say it
const OS_WORDS = {
  2: "the file is not there (moved or deleted?)",
  3: "the folder is not there (moved or deleted?)",
  5: "Windows refused access - it may be open in another program, read-only or protected",
  32: "another program has it open - close it there and try again",
  33: "another program has it open - close it there and try again",
  39: "the disk is full",
  112: "the disk is full",
  53: "the network place cannot be reached",
  64: "the network place cannot be reached",
  67: "the network place cannot be reached",
  206: "the name or path is too long",
};
/** An error's text with the system's own wording ("… (os error 32)") put in plain words; anything else as it was. */
export function plainError(e) {
  return String((e && e.message) || e).replace(/[^:]*?\s*\(os error (\d+)\)\.?/g, (m, n) => (OS_WORDS[n] ? " " + OS_WORDS[n] : m));
}
