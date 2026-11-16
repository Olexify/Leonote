// The reading lens for the graph view. With the lens on, hovering a note
// lifts its text out onto a small card beside it: scrollable, movable,
// pinnable, and with a handle you drag onto another card or node to write a
// link. Cards are plain DOM over the canvas; the leader lines, the hint rings
// and the drag line are painted by graph.js through paint().

import { h, clamp } from "./util.js";
import { icon } from "./icons.js";
import { foldSections } from "./ui.js";
import { WIKI_RE } from "./mdparse.js";
import { relatedNodes, addLinkLine } from "./graphcore.js";

const CARD_W = 292;
const CARD_MAX_H = 330;
export const LENS_R = 74; // the glass: notes this close to the pointer stay open
const OUT_MS = 250; // default: how long a card lingers once the pointer moves off
const GONE_MS = 170; // the fade-out itself
const SWEEP_MS = 120; // while the layout moves, re-read the glass this often
const GAP = 18; // clear of the node, always
const BODY_CAP = 20000; // a huge note renders its first stretch only
const UNDO_MAX = 10; // link actions kept for Ctrl+Z

let seq = 0;

/**
 * api: { wrap, app, vault, settings, set, kick, indexOf(path), node(i),
 *        screen(i), toScreen(wx,wy), toWorld(sx,sy), pickScreen(cx,cy),
 *        relations(), linkText(path), linksTo(from,to), openNote(i,newTab),
 *        openSide(i), colors() }
 */
export function createLens(api) {
  const layer = h("div", { class: "gx-lens-layer", hidden: true });
  const ring = h("div", { class: "gx-lens-ring", hidden: true });
  // the line being dragged rides above the cards, so it is never buried
  const wire = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wire.setAttribute("class", "gx-lens-wire");
  const wirePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  wire.append(wirePath);
  // suggested notes are marked above the cards, so a card can never hide one
  const pips = h("div", { class: "gx-lens-pips" });
  api.wrap.append(layer, pips, wire, ring);

  const cards = [];
  // heights change when a note is re-read or a hint row appears; measuring
  // here keeps the per-frame follow() free of forced layout
  const sizes = new WeakMap();
  const ro = new ResizeObserver((rows) => {
    let any = false;
    for (const r of rows) {
      const c = sizes.get(r.target);
      if (c && c.hgt !== r.target.offsetHeight) { c.hgt = r.target.offsetHeight; any = true; }
    }
    if (any) api.kick();
  });
  let on = false;
  let link = null; // { card, x, y, over, node } while dragging a link out
  let ptr = null; // last pointer position, wrap-local: the centre of the glass
  let sweptAt = 0;
  const undos = []; // link actions, newest last
  const redos = [];

  const S = () => api.settings();
  const maxCards = () => Math.max(2, S().lensCards || 6);
  const byPath = (p) => cards.find((c) => c.path === p) || null;

  /* ── on / off ──────────────────────────────────────────────────────────── */
  function setOn(v) {
    v = !!v;
    if (v === on) return;
    on = v;
    layer.hidden = !on;
    pips.hidden = !on;
    ring.hidden = true;
    syncRing();
    if (!on) { closePop(); closeAll(); }
    api.kick();
  }

  function closeAll() {
    endLink();
    for (const c of cards.slice()) drop(c, true);
    api.kick();
  }

  /* ── the glass ─────────────────────────────────────────────────────────── */
  // By default a card belongs to the note the pointer is actually on, and it
  // fades once the pointer moves off. With "keep cards" the whole lens circle
  // is the hover area instead, so sweeping a cluster lifts it out at once.
  // Either way, leaving only starts a timer: coming back cancels it, so the
  // card is never rebuilt and its scroll stays where the reader left it.
  function moved(sx, sy) {
    if (!on) return;
    ptr = { x: sx, y: sy };
    ring.hidden = false;
    ring.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
    sweep();
  }

  const HIT = 5; // the pointer's own reach, same slop as the graph's hit test
  const radius = () => Math.max(20, S().lensRadius || LENS_R);
  const delay = () => Math.max(80, S().lensDelay || OUT_MS);

  /** The ring shows the reach only when the reach is what decides. */
  function syncRing() {
    ring.style.setProperty("--lens-r", radius() + "px");
    ring.classList.toggle("is-spot", !S().lensKeep);
    layer.style.setProperty("--gx-lc-a", Math.round((S().lensAlpha ?? 0.89) * 100) + "%");
  }

  // Over a card the pointer is still the glass, it just stops being drawn as
  // one: the cards it covers must not start dying behind the one being read.
  layer.addEventListener("pointermove", (e) => {
    if (!on || link) return;
    const r = api.wrap.getBoundingClientRect();
    ptr = { x: e.clientX - r.left, y: e.clientY - r.top };
    ring.hidden = true;
    sweep(false);
  });
  // only a pointer that left the whole view lets go of everything
  api.wrap.addEventListener("pointerleave", (e) => { if (on) leave(e.relatedTarget); });

  function sweep(openNew = true) {
    if (!on || !ptr || link) return; // a link drag freezes every card
    sweptAt = performance.now();
    const keep = !!S().lensKeep;
    let near = api.nodesWithin(ptr.x, ptr.y, keep ? radius() : HIT) || [];
    // without "keep cards" only the note under the pointer counts, one card
    if (!keep && near.length > 1) near = near.slice(0, 1);
    const live = new Set();
    for (const e of near) {
      const nd = api.node(e.i);
      if (nd && nd.kind === "note") live.add(nd.id);
    }
    for (const c of cards) {
      if (onPips.size || c.pinned || c.over || c.moving || live.has(c.path)) disarm(c);
      else if (!c.timer) arm(c, delay()); // already counting down: leave it be
    }
    if (!openNew) return;
    const max = maxCards();
    for (const e of near) {
      const nd = api.node(e.i);
      if (!nd || nd.kind !== "note" || byPath(nd.id)) continue;
      if (cards.length >= max) {
        // the cap holds: only a card further out than this one gives way
        const out = furthest();
        if (!out || distOf(out) <= e.d) break;
        drop(out, true);
      }
      open(e.i);
    }
  }

  const distOf = (c) => {
    const p = api.screen(c.i);
    return p && ptr ? Math.hypot(p.x - ptr.x, p.y - ptr.y) : Infinity;
  };

  /** The unpinned card whose note sits furthest from the glass; oldest wins ties. */
  function furthest() {
    let best = null;
    let bd = -1;
    for (const c of cards) {
      if (c.pinned || c.over || c.moving) continue;
      const d = distOf(c);
      if (d > bd) { bd = d; best = c; }
    }
    return best;
  }

  // relatedTarget: a step onto a card is not leaving, the glass goes with it
  function leave(to) {
    if (link) return;
    if (to && (layer.contains(to) || api.wrap.contains(to))) { sweep(false); return; }
    ring.hidden = true;
    ptr = null;
    for (const c of cards) if (!c.pinned && !c.over && !c.timer) arm(c, delay());
  }

  function arm(c, ms) {
    if (c.dying || link) return;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => drop(c), ms);
  }
  function disarm(c) {
    clearTimeout(c.timer);
    c.timer = 0;
  }

  /* ── the card ──────────────────────────────────────────────────────────── */
  function open(i) {
    const nd = api.node(i);
    const note = api.vault.notes.get(nd.id);
    if (!note) return null;
    while (cards.length >= maxCards()) {
      const old = furthest() || cards.find((c) => !c.pinned) || cards[0];
      drop(old, true);
    }
    const c = {
      key: "lc" + seq++, i, path: nd.id, pinned: false, free: false, over: false, dying: false,
      timer: 0, w: CARD_W, hgt: 120, sx: 0, sy: 0, wx: 0, wy: 0, hints: [],
    };
    c.el = buildCard(c, nd, note);
    cards.push(c);
    layer.append(c.el);
    c.hgt = c.el.offsetHeight;
    sizes.set(c.el, c);
    ro.observe(c.el);
    place(c);
    syncPips(); // fillHints ran before the card joined the list
    requestAnimationFrame(() => c.el.classList.add("is-in"));
    api.kick();
    return c;
  }

  function buildCard(c, nd, note) {
    // Shift pins every open card, Alt frees them all; the hint says so on hover
    const pinBtn = h("button", {
      class: "gx-lc-btn", "aria-label": "Pin this card",
      onclick: (e) => (e.shiftKey ? pinAll(true) : e.altKey ? pinAll(false) : togglePin(c)),
    }, icon("pin"));
    const keyHint = h("div", { class: "gx-lc-keyhint" },
      h("b", { text: "Pin this card" }),
      h("span", {}, h("kbd", { text: "Shift" }), "click pins all open cards"),
      h("span", {}, h("kbd", { text: "Alt" }), "click unpins all"),
      h("span", {}, h("kbd", { text: "Ctrl Shift P" }), h("kbd", { text: "Ctrl Shift U" })));
    pinBtn.addEventListener("pointerenter", () => keyHint.classList.add("is-on"));
    pinBtn.addEventListener("pointerleave", () => keyHint.classList.remove("is-on"));
    pinBtn.addEventListener("focus", () => keyHint.classList.add("is-on"));
    pinBtn.addEventListener("blur", () => keyHint.classList.remove("is-on"));
    const head = h("div", { class: "gx-lc-head", title: "Drag to move this card" },
      icon("fileText", "gx-lc-kind"),
      h("span", { class: "gx-lc-title", text: nd.label }),
      pinBtn,
      h("button", { class: "gx-lc-btn", title: "Close (Esc closes all)", onclick: () => drop(c) }, icon("x")),
      keyHint);
    c.pinBtn = pinBtn;
    head.addEventListener("pointerdown", (e) => startMove(c, e));

    const body = h("div", { class: "gx-lc-body" }, renderBody(note.content, nd.label));
    body.title = "Double-click to open it in a tab";
    body.addEventListener("dblclick", (e) => { if (!e.target.closest("a, button")) api.app.openNote(c.path, { newTab: true }); });
    body.addEventListener("wheel", (e) => {
      // the card owns its own wheel: the canvas underneath must not zoom
      e.stopPropagation();
      const room = body.scrollHeight - body.clientHeight;
      if (room > 1) { e.preventDefault(); body.scrollTop = clamp(body.scrollTop + e.deltaY, 0, room); }
      keep(c);
    }, { passive: false });

    const hintsEl = h("div", { class: "gx-lc-hints", hidden: true });
    c.hintsEl = hintsEl;

    const handle = h("span", { class: "gx-lc-link", title: "Drag onto another card or note to link them (hold Shift to link both ways)" }, icon("link"));
    handle.addEventListener("pointerdown", (e) => startLink(c, e));

    const el = h("div", { class: "gx-lens-card", dataset: { path: c.path } },
      head,
      nd.tags && nd.tags.length ? h("div", { class: "gx-lc-tags" },
        nd.tags.slice(0, 6).map((t) => h("span", { class: "gx-tag", text: "#" + t })),
        nd.tags.length > 6 ? h("span", { class: "gx-tag is-more", text: `+${nd.tags.length - 6}` }) : null) : null,
      body,
      hintsEl,
      h("div", { class: "gx-lc-foot" },
        h("button", { class: "gx-lc-act", title: "Open this note", onclick: () => api.openNote(c.i, false) }, icon("fileText"), "Open"),
        h("button", { class: "gx-lc-act", title: "Open it to the side", onclick: () => api.openSide(c.i) }, icon("panelRight"), "Side"),
        h("span", { class: "gx-lc-spacer" }),
        handle));

    el.addEventListener("pointerenter", () => { c.over = true; disarm(c); });
    el.addEventListener("pointerleave", () => { c.over = false; if (!c.pinned && !link && !onPips.size) arm(c, delay()); });
    // a click anywhere in the card is a reading gesture, never a canvas one
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    fillHints(c, note.content);
    return el;
  }

  function keep(c) {
    c.over = true;
    disarm(c);
  }

  function setPin(c, v) {
    if (c.pinned === v) return false;
    c.pinned = v;
    c.el.classList.toggle("is-pinned", v);
    c.pinBtn.setAttribute("aria-label", v ? "Unpin this card" : "Pin this card");
    if (v) disarm(c);
    return true;
  }

  function togglePin(c) {
    setPin(c, !c.pinned);
    if (!c.pinned) sweep(); // back under the ordinary glass rules
    api.kick();
  }

  /** Pin or free every open card at once. Returns how many changed. */
  function pinAll(v) {
    let n2 = 0;
    for (const c of cards) if (setPin(c, v)) n2++;
    if (!v) { for (const c of cards) if (!c.over && !c.timer) arm(c, delay()); sweep(); }
    api.kick();
    if (n2) api.app.toast(v ? `Pinned ${n2} card${n2 === 1 ? "" : "s"}` : `Unpinned ${n2} card${n2 === 1 ? "" : "s"}`, { ms: 1600 });
    else api.app.toast(v ? "Every open card is already pinned" : "No pinned cards", { ms: 1600 });
    return n2;
  }

  function drop(c, now) {
    const at = cards.indexOf(c);
    if (at < 0) return;
    cards.splice(at, 1);
    disarm(c);
    c.dying = true;
    c.el.classList.remove("is-in");
    c.el.classList.add("is-out");
    ro.unobserve(c.el);
    setTimeout(() => c.el.remove(), now ? 0 : GONE_MS);
    if (link && link.card === c) endLink();
    syncPips();
    api.kick();
  }

  /* ── placement ─────────────────────────────────────────────────────────── */
  // A fresh card sits beside its node, clear of it, inside the view. Its own
  // offset is kept in screen pixels so it follows the node as the layout
  // moves; once dragged it holds a world point instead and stays put.
  function place(c) {
    const p = api.screen(c.i);
    const W = api.wrap.clientWidth;
    const H = api.wrap.clientHeight;
    if (!p) return;
    const gap = Math.max(GAP, p.r + GAP, (p.lw || 0) + 14, p.r + (S().lensGap || 0));
    const hgt = Math.min(c.hgt, H - 24);
    const sides = [p.x + gap, p.x - gap - c.w];
    if (sides[0] + c.w > W - 12) sides.reverse();
    // First spot clear of the node, of the cards already open, and of the
    // notes the cards suggest — a hint hidden under a card is a hint missed.
    const hints = hintPoints(c.hints);
    const cost = costAt(c, p, hgt, hints, gap);
    const maxX = Math.max(12, W - c.w - 12);
    const maxY = Math.max(12, H - hgt - 12);
    let best = null;
    const spots = [];
    for (const sx of sides) for (const dy of [-40, -hgt + 60, 40, -hgt - 20, 100, -hgt / 2]) spots.push([sx, p.y + dy]);
    spots.push([p.x - c.w / 2, p.y - hgt - gap], [p.x - c.w / 2, p.y + gap]);
    for (const [rx, ry] of spots) {
      const x = clamp(rx, 12, maxX);
      const y = clamp(ry, 12, maxY);
      const v = cost(x, y) + (x === rx && y === ry ? 0 : 60);
      if (!best || v < best.cost) best = { x, y, cost: v };
      if (!v) break;
    }
    // Crowded: hunt the whole view for the calmest free slot instead of
    // piling the card on a title someone is still reading.
    if (best.cost > 0) {
      for (let y = 12; y <= maxY; y += 30) {
        for (let x = 12; x <= maxX; x += 30) {
          const v = cost(x, y);
          if (v < best.cost) best = { x, y, cost: v };
        }
      }
    }
    c.offX = best.x - p.x;
    c.offY = best.y - p.y;
    c.sx = best.x;
    c.sy = best.y;
    paintAt(c);
  }

  const HEAD_H = 36;
  /**
   * What a spot would cost this card: burying another card's title is the
   * worst, then covering its own note or a hinted one, then plain overlap;
   * all else equal it stays near the note it belongs to.
   */
  function costAt(self, p, hgt, hints, gap = 0) {
    const heads = [];
    for (const o of cards) if (o !== self && !o.dying) heads.push(o);
    return (x, y) => {
      let v = 0;
      for (const o of heads) {
        if (x < o.sx + o.w && x + self.w > o.sx && y < o.sy + HEAD_H && y + hgt > o.sy) v += 1200;
      }
      v += overlap(self, x, y, hgt) * 6;
      const inside = (q, pad) => q.x > x - pad && q.x < x + self.w + pad && q.y > y - pad && q.y < y + hgt + pad;
      if (inside(p, 6)) v += 4000;
      // closer to the note than asked: the neighbours would end up under the card
      const away = Math.hypot(Math.max(x - p.x, 0, p.x - (x + self.w)), Math.max(y - p.y, 0, p.y - (y + hgt)));
      if (away < gap - 1) v += 1500 + (gap - away) * 12;
      for (const q of hints) if (inside(q, Math.max(q.r, 3) + 12)) v += 220;
      v += Math.hypot(x + self.w / 2 - p.x, y + hgt / 2 - p.y) * 0.5;
      return v;
    };
  }

  /* ── the lens's own settings, right where you right-clicked ───────────── */
  const pop = h("div", { class: "gx-lenspop", hidden: true });
  api.wrap.append(pop);
  let popAt = null;
  let previewT = 0;

  const put = (k, v, after) => { api.set(k, v); syncRing(); if (after) after(); api.kick(); };

  function swRow(label, key, after, hint) {
    const knob = h("span", { class: "switch" + (S()[key] ? " is-on" : "") });
    return h("button", {
      class: "gx-row", role: "switch", "aria-checked": String(!!S()[key]), title: hint || "",
      onclick: (e) => {
        put(key, !S()[key], after);
        knob.classList.toggle("is-on", !!S()[key]);
        e.currentTarget.setAttribute("aria-checked", String(!!S()[key]));
      },
    }, h("span", { class: "gx-row-label", text: label }), knob);
  }

  function slRow(label, key, min, max, step, fmt, after) {
    const out = h("span", { class: "gx-val" });
    const input = h("input", { type: "range", class: "gx-range", min, max, step });
    input.value = S()[key];
    const paint = () => {
      out.textContent = fmt(S()[key]);
      input.style.setProperty("--p", ((S()[key] - min) / (max - min)) * 100 + "%");
    };
    input.addEventListener("input", () => { put(key, Number(input.value), after); paint(); });
    paint();
    return h("label", { class: "gx-slider" }, h("span", { class: "gx-row-label", text: label }), out, input);
  }

  /** While the size slider moves, the ring itself shows the new reach. */
  function previewRing() {
    if (!popAt) return;
    ring.hidden = false;
    ring.classList.add("is-preview");
    ring.style.transform = `translate(${Math.round(popAt.x)}px, ${Math.round(popAt.y)}px)`;
    clearTimeout(previewT);
    previewT = setTimeout(() => { ring.classList.remove("is-preview"); if (!ptr) ring.hidden = true; }, 1100);
  }

  let popMode = "lens";
  const ms = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " s" : Math.round(v) + " ms");
  function buildPop() {
    const chip = (ico, label, title, run, off) =>
      h("button", { class: "gx-chip", disabled: !!off, title, onclick: run }, icon(ico), label);
    // Cards | Lens: the page of settings shown IS the way of reading that is on
    const go = (mode) => { popMode = mode; if ((mode === "lens") !== !!on && api.toggleLens) api.toggleLens(mode === "lens"); buildPop(); };
    const modeSeg = () => h("div", { class: "gx-mode is-pop", role: "group" },
      ...[["tip", "fileText", "Hover cards"], ["lens", "search", "Reading lens"]].map(([m, ico, label]) =>
        h("button", { class: "gx-mode-btn" + (popMode === m ? " is-on" : ""), title: m === "lens" ? "Read everything under the glass (M)" : "A small card for the note you point at", onclick: () => go(m) }, icon(ico), h("span", { text: label }))));
    // the plain hover card has its own few settings, in the same popover
    if (popMode === "tip") {
      pop.replaceChildren(
        h("div", { class: "gx-lenspop-head" },
          modeSeg(), h("span", { class: "gx-lenspop-t" }),
          h("button", { class: "gx-icon-btn is-tiny", title: "Close", onclick: closePop }, icon("x"))),
        h("div", { class: "gx-lenspop-body" },
          swRow("Show a card when you hover a note", "tips", rebuildPop),
          slRow("Appears after", "tipDelay", 0, 1500, 10, ms),
          slRow("Stays for", "tipLinger", 100, 4000, 50, ms),
          slRow("Distance from the note", "tipGap", 8, 260, 2, (v) => Math.round(v) + " px"),
          h("div", { class: "gx-lenspop-sep" }),
          h("div", { class: "gx-btnrow" },
            chip("search", "Reading lens settings…", "Switches to the reading lens (M) and shows its settings", () => go("lens")))));
      return;
    }
    pop.replaceChildren(
      h("div", { class: "gx-lenspop-head" },
        modeSeg(), h("span", { class: "gx-lenspop-t" }),
        h("button", { class: "gx-icon-btn is-tiny", title: "Close", onclick: closePop }, icon("x"))),
      h("div", { class: "gx-lenspop-body" }, foldSections([
        { title: "Lens and cards", icon: "search", open: true, body: [
        swRow("Keep cards until you hover elsewhere", "lensKeep",
          () => { sweep(); rebuildPop(); }, "Everything under the glass opens, not just the note you point at"),
        slRow("Lens size", "lensRadius", 30, 200, 2, (v) => Math.round(v) + " px", previewRing),
        slRow("Cards at once", "lensCards", 2, 12, 1, (v) => String(Math.round(v)), () => sweep()),
        slRow("Fade delay", "lensDelay", 80, 2000, 20, ms),
        slRow("Distance from the note", "lensGap", 18, 260, 2, (v) => Math.round(v) + " px", () => { for (const c of cards) if (!c.free && !c.moving) place(c); }),
        slRow("Card glass", "lensAlpha", 0.4, 1, 0.01, (v) => Math.round(v * 100) + "%")] },
        { title: "Suggestions", icon: "sparkles", body: [
        swRow("Suggest notes that might belong together", "lensHints", refreshHints),
        S().lensHints ? slRow("Suggestions per card", "lensHintMax", 1, 6, 1, (v) => String(Math.round(v)), refreshHints) : null,
        S().lensHints ? slRow("Only matches this strong", "lensHintMin", 1, 6, 0.5, (v) => v.toFixed(1), refreshHints) : null] },
        { title: "Keys", icon: "keyboard", body: [
        h("div", { class: "gx-lenspop-keys" },
          ...[["M", "lens on and off"], ["Ctrl Shift P", "pin every card"], ["Ctrl Shift U", "let them all go"],
            ["Ctrl Z", "take the last link back"], ["Esc", "close the cards"]]
            .map(([k, v]) => h("div", {}, h("kbd", { text: k }), h("span", { text: v }))))] },
        ], "leonote.graph.lens.sections"),
        h("div", { class: "gx-lenspop-sep" }),
        h("div", { class: "gx-btnrow" },
          chip("pin", "Pin all", "Ctrl+Shift+P, or Shift-click a card's pin", () => { pinAll(true); rebuildPop(); }, !cards.some((c) => !c.pinned)),
          chip("x", "Unpin all", "Ctrl+Shift+U, or Alt-click a card's pin", () => { pinAll(false); rebuildPop(); }, !cards.some((c) => c.pinned))),
        h("div", { class: "gx-btnrow" },
          chip("fileText", "Hover cards settings…", "Switches back to plain hover cards and shows their settings", () => go("tip"))),
        h("div", { class: "gx-btnrow" },
          chip("x", cards.length ? `Close all ${cards.length} cards` : "Close all cards", "Esc", () => { closeAll(); rebuildPop(); }, !cards.length)))
    );
  }

  const rebuildPop = () => { if (!pop.hidden) buildPop(); };

  function openPop(cx, cy, mode = "lens") {
    popMode = mode;
    const r = api.wrap.getBoundingClientRect();
    popAt = { x: clamp(cx - r.left, 0, r.width), y: clamp(cy - r.top, 0, r.height) };
    buildPop();
    pop.hidden = false;
    // measured once it is up, then nudged inside the view
    const w = pop.offsetWidth;
    const hgt = pop.offsetHeight;
    const x = clamp(popAt.x + 12, 8, Math.max(8, r.width - w - 8));
    const y = clamp(popAt.y - 20, 8, Math.max(8, r.height - hgt - 8));
    pop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    requestAnimationFrame(() => pop.classList.add("is-in"));
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", popKey, true);
    api.kick();
  }

  // its own Escape, so it closes wherever the focus happens to be
  function popKey(e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    closePop();
  }

  function closePop() {
    if (pop.hidden) return;
    pop.hidden = true;
    pop.classList.remove("is-in");
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("keydown", popKey, true);
    ring.classList.remove("is-preview");
    api.refreshPanel();
    api.kick();
  }

  const outside = (e) => { if (!pop.contains(e.target)) closePop(); };

  /* ── hint pips: the suggestions, always on top ─────────────────────────── */
  // A ring round the suggested note with a dot in the middle, in its own
  // layer above the cards: over the canvas the node shows through the ring,
  // over a card the dot is what says "there is a note under here". Clicking
  // one writes the link, the same as the chip inside the card.
  let pipList = [];
  const onPips = new Set(); // pips under the pointer: nothing fades while one is

  function syncPips() {
    const want = new Map();
    if (S().lensHints) {
      for (const c of cards) {
        if (c.dying) continue;
        for (const e of c.hints) if (!want.has(e.i)) want.set(e.i, { from: c.path, why: e.why });
      }
    }
    const keep = [];
    for (const p of pipList) {
      const w = want.get(p.i);
      if (w) { p.from = w.from; p.why = w.why; keep.push(p); want.delete(p.i); }
      else { onPips.delete(p); p.el.remove(); }
    }
    for (const [i, w] of want) keep.push(makePip(i, w));
    pipList = keep;
    placePips();
  }

  function makePip(i, w) {
    const nd = api.node(i);
    const name = nd ? nd.label : "";
    const p = { i, from: w.from, why: w.why, el: null };
    const label = h("span", { class: "gx-pip-label" }, h("b", { text: name }), h("span", { text: "Link it" }));
    p.el = h("button", {
      class: "gx-lens-pip", "aria-label": `Link to ${name}`,
      onclick: (e) => { e.stopPropagation(); writeLink(p.from, nd ? nd.id : "", false); },
    }, h("span", { class: "gx-pip-ring" }), label);
    // reaching for a pip means leaving the card that suggested it; the whole
    // set has to hold still or the pip is gone before the click lands
    p.el.addEventListener("pointerenter", () => {
      p.el.classList.add("is-open");
      onPips.add(p);
      for (const c of cards) disarm(c);
    });
    p.el.addEventListener("pointerleave", () => {
      p.el.classList.remove("is-open");
      onPips.delete(p);
      sweep(false);
    });
    pips.append(p.el);
    return p;
  }

  function placePips() {
    if (!pipList.length) return;
    for (const p of pipList) {
      const s = api.screen(p.i);
      if (!s) { p.el.hidden = true; continue; }
      p.el.hidden = false;
      p.el.style.setProperty("--r", Math.round(Math.max(s.r, 3) + 7) + "px");
      p.el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
      // over a card it needs its own body to be seen at all
      let behind = false;
      for (const c of cards) {
        if (c.dying) continue;
        if (s.x > c.sx && s.x < c.sx + c.w && s.y > c.sy && s.y < c.sy + c.hgt) { behind = true; break; }
      }
      p.el.classList.toggle("is-behind", behind);
    }
  }

  /** Screen points of every note the open cards point at, deduplicated. */
  function hintPoints(extra) {
    const seen = new Set();
    const out = [];
    const add = (list) => {
      for (const e of list) {
        if (seen.has(e.i)) continue;
        seen.add(e.i);
        const p = api.screen(e.i);
        if (p) out.push(p);
      }
    };
    for (const c of cards) add(c.hints);
    if (extra) add(extra);
    return out;
  }

  /** How much a candidate rectangle would sit on top of the other cards. */
  function overlap(self, x, y, hgt) {
    let sum = 0;
    for (const o of cards) {
      if (o === self || o.dying) continue;
      const ow = Math.min(x + self.w, o.sx + o.w) - Math.max(x, o.sx);
      const oh = Math.min(y + hgt, o.sy + Math.min(o.hgt, hgt + 400)) - Math.max(y, o.sy);
      if (ow > 0 && oh > 0) sum += ow * oh;
    }
    return sum / 1000;
  }

  function paintAt(c) {
    c.el.style.transform = `translate(${Math.round(c.sx)}px, ${Math.round(c.sy)}px)`;
  }

  /** Every frame the layout or camera moved: cards keep up with their node. */
  function follow() {
    if (!on || !cards.length) return;
    const W = api.wrap.clientWidth;
    const H = api.wrap.clientHeight;
    for (const c of cards.slice()) {
      const i = api.indexOf(c.path);
      if (i < 0) { drop(c); continue; }
      c.i = i;
      if (c.moving) continue; // the pointer owns it this frame
      if (c.free) {
        const s = api.toScreen(c.wx, c.wy);
        c.sx = s.x;
        c.sy = s.y;
      } else {
        const p = api.screen(i);
        if (!p) continue;
        c.sx = clamp(p.x + c.offX, 8, Math.max(8, W - c.w - 8));
        c.sy = clamp(p.y + c.offY, 8, Math.max(8, H - Math.min(c.hgt, H - 16) - 8));
      }
      paintAt(c);
    }
    placePips();
    // the layout can carry a note into or out of the glass on its own
    if (ptr && !link && performance.now() - sweptAt > SWEEP_MS) sweep();
  }

  /* ── moving a card ─────────────────────────────────────────────────────── */
  function startMove(c, e) {
    if (e.button !== 0 || e.target.closest(".gx-lc-btn")) return;
    e.preventDefault();
    e.stopPropagation();
    keep(c);
    const sx = e.clientX;
    const sy = e.clientY;
    const x0 = c.sx;
    const y0 = c.sy;
    c.el.classList.add("is-moving");
    c.moving = true;
    const move = (ev) => {
      // the view clips its children, so a card never goes over the edge
      const W = api.wrap.clientWidth;
      const H = api.wrap.clientHeight;
      c.sx = clamp(x0 + ev.clientX - sx, 8, Math.max(8, W - c.w - 8));
      c.sy = clamp(y0 + ev.clientY - sy, 8, Math.max(8, H - Math.min(c.hgt, H - 16) - 8));
      paintAt(c);
      api.kick();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      c.el.classList.remove("is-moving");
      c.moving = false;
      if (Math.abs(c.sx - x0) + Math.abs(c.sy - y0) > 3) {
        // from here on the card holds a point in the graph, not beside a node
        c.free = true;
        const w = api.toWorld(c.sx, c.sy);
        c.wx = w.x;
        c.wy = w.y;
      }
      api.kick();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ── linking ───────────────────────────────────────────────────────────── */
  function startLink(c, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    keep(c);
    const r = api.wrap.getBoundingClientRect();
    const hr = e.currentTarget.getBoundingClientRect();
    link = {
      card: c, hx: hr.left + hr.width / 2 - r.left, hy: hr.top + hr.height / 2 - r.top,
      x: e.clientX - r.left, y: e.clientY - r.top, over: null, node: -1, shift: false,
    };
    layer.classList.add("is-linking");
    const move = (ev) => {
      link.x = ev.clientX - r.left;
      link.y = ev.clientY - r.top;
      link.shift = ev.shiftKey;
      const was = link.over;
      link.over = cardAt(ev.clientX, ev.clientY, c);
      link.node = link.over ? -1 : api.pickScreen(ev.clientX, ev.clientY);
      if (was !== link.over) {
        if (was) was.el.classList.remove("is-target");
        if (link.over) link.over.el.classList.add("is-target");
      }
      drawWire();
      api.kick();
    };
    const up = (ev) => {
      const target = link.over ? link.over.path : link.node >= 0 ? nodePath(link.node) : null;
      const both = ev.shiftKey;
      endLink();
      if (target && target !== c.path) writeLink(c.path, target, both);
    };
    // every card is frozen until this comes off, so the drop target cannot
    // fade out from under the pointer
    link.off = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    for (const c2 of cards) disarm(c2);
    drawWire();
    api.kick();
  }

  // a soft curve from the handle to the pointer, bowed the way the drag goes
  function drawWire() {
    if (!link) { wirePath.removeAttribute("d"); return; }
    const a = { x: link.hx, y: link.hy };
    const mx = (a.x + link.x) / 2;
    const my = (a.y + link.y) / 2;
    const bow = Math.min(40, Math.hypot(link.x - a.x, link.y - a.y) * 0.18);
    wirePath.setAttribute("d", `M ${a.x} ${a.y} Q ${mx} ${my - bow} ${link.x} ${link.y}`);
  }

  function nodePath(i) {
    const nd = api.node(i);
    return nd && nd.kind === "note" ? nd.id : null;
  }

  function endLink() {
    if (!link) return;
    if (link.over) link.over.el.classList.remove("is-target");
    if (link.off) link.off();
    link = null;
    drawWire();
    layer.classList.remove("is-linking");
    // the freeze lifts: the glass decides again who stays
    sweep();
    for (const c of cards) if (!c.pinned && !c.over && !c.timer) arm(c, delay());
    api.kick();
  }

  function cardAt(cx, cy, not) {
    for (const c of cards) {
      if (c === not || c.dying) continue;
      const r = c.el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return c;
    }
    return null;
  }

  /** Write A -> B (and B -> A with Shift), skipping links already there. */
  async function writeLink(a, b, both) {
    const writes = [];
    const one = (from, to) => {
      const note = api.vault.notes.get(from);
      if (!note || api.linksTo(from, to)) return;
      writes.push({ path: from, prev: note.content, next: addLinkLine(note.content, api.linkText(to)) });
    };
    one(a, b);
    if (both) one(b, a);
    const nameA = label(a);
    const nameB = label(b);
    if (!writes.length) {
      api.app.toast(`‘${nameA}’ already links to ‘${nameB}’`);
      return;
    }
    try {
      for (const w of writes) await api.vault.write(w.path, w.next, { expected: true });
    } catch (err) {
      api.app.toast("Could not write the link: " + err, { kind: "error" });
      return;
    }
    const arrow = writes.length > 1 ? "↔" : "→";
    const entry = { writes, a, b, arrow };
    undos.push(entry);
    if (undos.length > UNDO_MAX) undos.shift();
    redos.length = 0;
    api.app.toast(`Linked ‘${nameA}’ ${arrow} ‘${nameB}’`, { action: { label: "Undo", run: () => undoLink(entry) } });
    touched(a, b);
  }

  const touched = (a, b) => { for (const c of cards) if (c.path === a || c.path === b) refresh(c); };
  // an entry only applies while the note still reads the way we left it
  const applies = (e, key) => e.writes.every((w) => {
    const note = api.vault.notes.get(w.path);
    return note && note.content === w[key];
  });

  /** Ctrl+Z in the graph, and the toast's own Undo, come through here. */
  function undoLink(only) {
    let at = only ? undos.indexOf(only) : -1;
    if (only && at < 0) return false; // already undone
    if (!only) { for (at = undos.length - 1; at >= 0 && !applies(undos[at], "next"); at--); }
    const e = at >= 0 ? undos[at] : null;
    if (!e || !applies(e, "next")) {
      if (!only) api.app.toast("Nothing here to unlink", { ms: 1800 });
      return false;
    }
    undos.splice(at, 1);
    for (const w of e.writes) api.vault.write(w.path, w.prev, { expected: true });
    redos.push(e);
    if (redos.length > UNDO_MAX) redos.shift();
    api.app.toast(`Unlinked ‘${label(e.a)}’ ${e.arrow} ‘${label(e.b)}’`, { ms: 2600, action: { label: "Redo", run: () => redoLink(e) } });
    touched(e.a, e.b);
    return true;
  }

  function redoLink(only) {
    let at = only ? redos.indexOf(only) : -1;
    if (only && at < 0) return false;
    if (!only) { for (at = redos.length - 1; at >= 0 && !applies(redos[at], "prev"); at--); }
    const e = at >= 0 ? redos[at] : null;
    if (!e || !applies(e, "prev")) {
      if (!only) api.app.toast("Nothing to redo", { ms: 1800 });
      return false;
    }
    redos.splice(at, 1);
    for (const w of e.writes) api.vault.write(w.path, w.next, { expected: true });
    undos.push(e);
    if (undos.length > UNDO_MAX) undos.shift();
    api.app.toast(`Linked ‘${label(e.a)}’ ${e.arrow} ‘${label(e.b)}’ again`, { ms: 2600 });
    touched(e.a, e.b);
    return true;
  }

  function label(p) {
    const i = api.indexOf(p);
    const nd = i >= 0 ? api.node(i) : null;
    return nd ? nd.label : p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  }

  /** A card whose note changed under it re-reads the text and the hints. */
  function refresh(c) {
    const note = api.vault.notes.get(c.path);
    if (!note) { drop(c); return; }
    const body = c.el.querySelector(".gx-lc-body");
    if (body) {
      const at = body.scrollTop;
      body.replaceChildren(...renderBody(note.content, label(c.path)));
      body.scrollTop = at;
    }
    fillHints(c, note.content);
  }

  /* ── correlation hints ─────────────────────────────────────────────────── */
  function fillHints(c, text) {
    c.hints = [];
    const el = c.hintsEl;
    if (!S().lensHints) { el.hidden = true; el.replaceChildren(); syncPips(); api.kick(); return; }
    const rel = api.relations();
    const i = api.indexOf(c.path);
    const list = rel && i >= 0 ? relatedNodes(rel, i, { text, limit: S().lensHintMax || 3, min: S().lensHintMin || 2 }) : [];
    c.hints = list;
    if (!list.length) { el.hidden = true; el.replaceChildren(); syncPips(); api.kick(); return; }
    el.hidden = false;
    el.replaceChildren(
      h("span", { class: "gx-lc-hintlead" }, icon("sparkles"), "Might belong together:"),
      h("span", { class: "gx-lc-hintrow" }, list.map((e) => {
        const nd = api.node(e.i);
        return h("button", {
          class: "gx-lc-hint", title: `Link this note to ‘${nd.label}’ — ${e.why}`,
          onclick: () => writeLink(c.path, nd.id, false),
        }, h("span", { text: nd.label }), icon("plus"));
      })));
    syncPips();
    api.kick();
  }

  function refreshHints() {
    for (const c of cards) {
      const note = api.vault.notes.get(c.path);
      if (note) fillHints(c, note.content);
    }
  }

  /* ── light Markdown, read-only ─────────────────────────────────────────── */
  const clean = (t) => t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_~`]/g, "");

  function inline(s) {
    const out = [];
    let last = 0;
    WIKI_RE.lastIndex = 0;
    for (const m of s.matchAll(WIKI_RE)) {
      if (m.index > last) out.push(clean(s.slice(last, m.index)));
      const target = m[1].trim();
      out.push(h("button", {
        class: "gx-lc-wiki", text: m[3] || target, title: `Open ‘${target}’`,
        onclick: () => { const i = api.indexOf(api.resolve(target, "")); if (i >= 0) api.openNote(i, false); },
      }));
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(clean(s.slice(last)));
    return out;
  }

  // A line that is nothing but tags: the chips above already say it.
  const TAGS_ONLY = /^(?:#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*[ \t]*)+$/u;

  function renderBody(text, title) {
    let body = String(text || "");
    if (body.startsWith("---\n")) {
      const end = body.indexOf("\n---", 4);
      if (end > 0) body = body.slice(end + 4);
    }
    if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP) + "\n…";
    const out = [];
    let fence = false;
    let buf = [];
    const flush = () => { if (buf.length) { out.push(h("pre", { class: "gx-lc-pre", text: buf.join("\n") })); buf = []; } };
    for (const raw of body.split("\n")) {
      if (/^\s*(```|~~~)/.test(raw)) { if (fence) flush(); fence = !fence; continue; }
      if (fence) { buf.push(raw); continue; }
      const l = raw.trim();
      if (!l) continue;
      if (TAGS_ONLY.test(l)) continue;
      let m;
      if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l))) {
        // the card header already carries the note's own title
        if (!out.length && title && m[2].trim().toLowerCase() === title.toLowerCase()) continue;
        out.push(h("div", { class: "gx-lc-h" }, inline(m[2])));
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(l)) { out.push(h("div", { class: "gx-lc-hr" })); continue; }
      if ((m = /^>\s?(.*)$/.exec(l))) { out.push(h("div", { class: "gx-lc-quote" }, inline(m[1]))); continue; }
      if ((m = /^(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(l))) {
        out.push(h("div", { class: "gx-lc-li" },
          m[1] === undefined ? h("span", { class: "gx-lc-dot" }) : h("span", { class: "gx-lc-box" + (m[1] === " " ? "" : " is-done") }),
          h("span", { class: "gx-lc-litext" }, inline(m[2]))));
        continue;
      }
      out.push(h("p", { class: "gx-lc-p" }, inline(l)));
    }
    flush();
    if (!out.length) out.push(h("p", { class: "gx-lc-p is-empty", text: "Empty note" }));
    return out;
  }

  /* ── canvas overlay: leader lines, hint rings, the link being drawn ────── */
  function paint(ctx, dpr, W, H) {
    if (!on || (!cards.length && !link)) return;
    const col = api.colors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();

    // a thin leader from each node to the nearest edge of its card
    ctx.globalAlpha = 1;
    for (const c of cards) {
      const p = api.screen(c.i);
      if (!p) continue;
      const a = anchor(c, p.x, p.y);
      ctx.strokeStyle = col.accent;
      ctx.globalAlpha = c.pinned ? 0.5 : 0.32;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
      ctx.globalAlpha = c.pinned ? 0.85 : 0.6;
      ctx.fillStyle = col.accent;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // the node end keeps a soft halo so the source is never in doubt
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(p.r, 3) + 7, 0, Math.PI * 2);
      ctx.fill();
    }

    if (link) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = col.accent;
      ctx.lineWidth = 2;
      if (link.node >= 0) {
        const p = api.screen(link.node);
        if (p) {
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(p.r, 4) + 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** The point on a card's border closest to (x, y). */
  function anchor(c, x, y) {
    const hgt = Math.min(c.hgt || 120, CARD_MAX_H + 90);
    return { x: clamp(x, c.sx, c.sx + c.w), y: clamp(y, c.sy, c.sy + hgt) };
  }

  /* ── the graph rebuilt under us ────────────────────────────────────────── */
  function rebuilt() {
    for (const c of cards.slice()) {
      const i = api.indexOf(c.path);
      if (i < 0) drop(c);
      else c.i = i;
    }
    refreshHints();
  }

  return {
    get on() { return on; },
    setOn,
    toggle: () => setOn(!on),
    moved,
    leave,
    closeAll,
    count: () => cards.length,
    settings: (cx, cy, mode) => openPop(cx, cy, mode),
    settingsOpen: () => !pop.hidden,
    /** The mode changed elsewhere (M, the toolbar): an open popover turns to its page. */
    showMode: (mode) => { if (!pop.hidden && popMode !== mode) { popMode = mode; buildPop(); } },
    closeSettings: closePop,
    syncRing,
    follow,
    paint,
    rebuilt,
    refresh: (path) => { const c = byPath(path); if (c) refresh(c); },
    refreshHints,
    linking: () => !!link,
    cancelLink: () => { const was = !!link; endLink(); return was; },
    pinAll,
    pinnable: () => cards.some((c) => !c.pinned),
    unpinnable: () => cards.some((c) => c.pinned),
    undoLink: () => undoLink(null),
    redoLink: () => redoLink(null),
    canUndo: () => undos.length > 0,
    // test handle
    state: () => cards.map((c) => ({ path: c.path, pinned: c.pinned, free: c.free, x: Math.round(c.sx), y: Math.round(c.sy), w: c.w, h: c.hgt, hints: c.hints.map((e) => { const nd = api.node(e.i); return nd ? nd.label : null; }) })),
    cardEl: (path) => { const c = byPath(path); return c ? c.el : null; },
    pin: (path) => { const c = byPath(path); if (c && !c.pinned) togglePin(c); },
    linkTo: (a, b, both) => writeLink(a, b, both),
    stacks: () => ({ undo: undos.length, redo: redos.length }),
  };
}
