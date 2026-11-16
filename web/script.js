// The script window ("Read as script"): one note to read while recording - scrolling by itself, or word by
// word; what is read and what is to come faded as set; presets of size, place and settings; the place in each
// note remembered; the text editable here (saved to the note as you type). The window is kept out of screen
// capture by Leonote (script.rs). Its settings are this window's own conveniences, kept in localStorage.
(() => {
  const T = window.__TAURI__;
  const $ = (id) => document.getElementById(id);
  const page = $("page");
  const SM = globalThis.ScriptMap;
  let metas = []; // the blocks on screen and the note's lines each was read from (scriptmap.js)
  const win = T && T.window ? T.window.getCurrentWindow() : null;
  const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem("script." + k)); localStorage.setItem("script." + k, JSON.stringify(v)); } catch { return null; } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DEF = { mode: "scroll", px: 40, wpm: 150, size: 30, past: 35, ahead: 55 };
  const cfg = { ...DEF, ...(store("cfg") || {}) };
  // older single values, kept from the first version
  if (store("speed") && !store("cfg")) cfg.px = Number(store("speed")) || DEF.px;
  if (store("size") && !store("cfg")) cfg.size = Number(store("size")) || DEF.size;
  let note = null; // { path, title, text }
  let sent = null; // the blocks of the text last sent to the note, until it comes back
  let running = false;
  let words = []; // the word spans, in order (word mode)
  let at = 0; // the word now
  const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

  /* ── the text ── */
  /** The blocks on the page; in word mode each word its own span, to light up and to click. */
  function render() {
    if (!note) return;
    const out = [];
    let list = null;
    words = [];
    metas = SM.blocks(note.text);
    for (const [bi, b] of metas.entries()) {
      const el = document.createElement(b.tag);
      el.dataset.b = String(bi);
      if (cfg.mode === "words") {
        for (const [k, w] of b.text.split(/\s+/).filter(Boolean).entries()) {
          if (k) el.append(" ");
          const s = document.createElement("span");
          s.className = "w";
          s.textContent = w;
          s.dataset.i = String(words.length);
          words.push(s);
          el.append(s);
        }
      } else el.textContent = b.text;
      if (b.tag === "li") { if (!list) { list = document.createElement("ul"); out.push(list); } list.append(el); }
      else { list = null; out.push(el); }
    }
    page.replaceChildren(...out);
    measureEnd();
    paintedAt = -1;
    at = clamp(at, 0, Math.max(0, words.length - 1));
    paintWords(false);
  }
  function show(n, first) {
    if (!n) return;
    const same = note && note.path === n.path;
    const fresh = SM.blocks(n.text);
    const sameAs = (bs) => fresh.length === bs.length && fresh.every((b, i) => b.tag === bs[i].tag && b.text === bs[i].text);
    // what was sent did not come back: the main window does not put it over a note that has moved since
    let lost = same && sent && !sameAs(sent);
    // typing here: the blocks on screen point at the lines of the text they were read from
    if (isEditing()) {
      if (same && sameAs(metas)) {
        // our own save coming back, or a change outside the words read (an id in the front matter): typing goes on
        sent = null;
        note = n;
        metas = fresh;
        $("title").textContent = n.title || "Script";
        return;
      }
      if (same) {
        // the words moved under the edit: sent now, it would overwrite the wrong lines
        if (SM.apply(note.text, metas, onScreen()) !== note.text) lost = true;
        page.contentEditable = "false";
      }
      editing(false); // another note: what was typed goes to the one it was typed in
    }
    if (lost) say("This note changed elsewhere. The last words you typed were not saved.");
    sent = null;
    note = n;
    $("title").textContent = n.title || "Script";
    const keep = same ? { top: page.scrollTop } : null;
    if (!same || first) { const p = (store("places") || {})[n.path]; at = p ? p.word || 0 : 0; }
    render();
    if (keep) page.scrollTop = keep.top;
    else { const p = (store("places") || {})[n.path]; if (p && cfg.mode === "scroll") page.scrollTop = p.top || 0; else if (cfg.mode === "words") paintWords(true); }
  }

  /* ── where you are: kept per note ── */
  let placeTimer = 0;
  const savePlace = () => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      if (!note) return;
      const all = store("places") || {};
      all[note.path] = { top: Math.round(page.scrollTop), word: at, t: Date.now() };
      // the newest 100 notes are remembered
      const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
      for (const k of keys.slice(100)) delete all[k];
      store("places", all);
    }, 400);
  };
  page.addEventListener("scroll", savePlace, { passive: true });

  /* ── scroll mode ── */
  let last = 0, carry = 0;
  let endAt = 0; // how far the text scrolls: measured on start, on a new text and on a resize
  const measureEnd = () => { endAt = page.scrollHeight - page.clientHeight - 1; };
  addEventListener("resize", measureEnd);
  const scrollStep = (now) => {
    if (!running || cfg.mode !== "scroll") return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    carry += cfg.px * dt;
    const whole = Math.trunc(carry);
    if (whole) { page.scrollTop += whole; carry -= whole; }
    if (page.scrollTop >= endAt) { running = false; paint(); return; }
    requestAnimationFrame(scrollStep);
  };

  /* ── word mode ── */
  let wordTimer = 0;
  let paintedAt = -1; // the word lit last time (-1: the words were drawn afresh)
  function paintWords(follow) {
    if (cfg.mode !== "words") return;
    const [from, to] = paintedAt < 0 ? [0, words.length - 1] : [Math.min(paintedAt, at), Math.max(paintedAt, at)];
    for (let i = from; i <= to && i < words.length; i++) words[i].className = i < at ? "w past" : i === at ? "w now" : "w";
    paintedAt = at;
    const w = words[at];
    if (follow && w) {
      // the word now sits on the guide line, a third of the way down
      const r = w.getBoundingClientRect(), pr = page.getBoundingClientRect();
      const want = page.scrollTop + (r.top - pr.top) - page.clientHeight * 0.33 + r.height / 2;
      page.scrollTo({ top: want, behavior: "smooth" });
    }
    savePlace();
  }
  const go = (i) => { at = clamp(i, 0, Math.max(0, words.length - 1)); paintWords(true); };
  function nextWord() {
    if (!running || cfg.mode !== "words") return;
    if (at >= words.length - 1) { running = false; paint(); return; }
    go(at + 1);
    // a little longer at the end of a sentence or after a comma, as one reads aloud
    const t = words[at] ? words[at].textContent : "";
    const k = /[.!?…]["»”)]*$/.test(t) ? 2 : /[,;:—–-]$/.test(t) ? 1.4 : 1;
    wordTimer = setTimeout(nextWord, (60000 / cfg.wpm) * k);
  }
  page.addEventListener("click", (e) => { if (isEditing()) return; const w = e.target.closest(".w"); if (w && cfg.mode === "words") go(Number(w.dataset.i)); });

  /* ── start, stop, settings ── */
  function toggle(on = !running) {
    running = on;
    clearTimeout(wordTimer);
    last = 0; carry = 0;
    paint();
    if (!running) return;
    if (cfg.mode === "scroll") { measureEnd(); requestAnimationFrame(scrollStep); }
    else wordTimer = setTimeout(nextWord, 60000 / cfg.wpm);
  }
  const save = () => store("cfg", cfg);
  function set(k, v) {
    const lim = { px: [1, 600], wpm: [20, 900], size: [12, 120], past: [0, 100], ahead: [0, 100] }[k];
    if (lim) v = clamp(Math.round(Number(v) || 0), lim[0], lim[1]);
    const was = cfg[k];
    cfg[k] = v;
    save();
    if (k === "mode" && v !== was) { toggle(false); render(); if (v === "words") paintWords(true); }
    paint();
  }
  function paint() {
    $("play").innerHTML = running ? PAUSE : PLAY;
    $("play").classList.toggle("is-on", running);
    document.body.classList.toggle("scroll", cfg.mode === "scroll");
    document.body.classList.toggle("words", cfg.mode === "words");
    const r = document.documentElement.style;
    r.setProperty("--size", cfg.size + "px");
    r.setProperty("--past", String(cfg.past / 100));
    r.setProperty("--ahead", String(cfg.ahead / 100));
    const words_ = cfg.mode === "words";
    // the boxes show what is set - not while one is being typed in
    const put = (id, v) => { const b = $(id); if (document.activeElement !== b) b.value = String(v); };
    put("speedBox", words_ ? cfg.wpm : cfg.px);
    $("speedUnit").textContent = words_ ? "wpm" : "px/s";
    put("sizeBox", cfg.size); put("sizeBox2", cfg.size); put("pxBox", cfg.px); put("wpmBox", cfg.wpm); put("pastBox", cfg.past); put("aheadBox", cfg.ahead);
    $("modeScroll").classList.toggle("is-on", !words_);
    $("modeWords").classList.toggle("is-on", words_);
    $("help").textContent = words_ ? "Space start / stop · ← → word · ↑↓ speed · click a word to go there · Esc close" : "Space start / stop · ↑↓ speed · wheel to move · Esc close";
  }
  // a typed value counts as it is typed (Enter or leaving the box puts it right if it was out of range)
  const box = (id, k) => {
    const b = $(id);
    const key = typeof k === "function" ? k : () => k;
    b.addEventListener("input", () => { if (b.value !== "") set(key(), b.value); });
    b.addEventListener("change", () => { set(key(), b.value); b.value = String(cfg[key()]); });
    b.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") b.blur(); });
  };
  // the bar's speed box is the scroll speed, or the words a minute in word mode
  box("speedBox", () => (cfg.mode === "words" ? "wpm" : "px"));
  box("sizeBox", "size"); box("sizeBox2", "size"); box("pxBox", "px"); box("wpmBox", "wpm"); box("pastBox", "past"); box("aheadBox", "ahead");
  const speedBy = (d) => (cfg.mode === "words" ? set("wpm", cfg.wpm + d * 10) : set("px", cfg.px + d * 5));
  $("slower").onclick = () => speedBy(-1);
  $("faster").onclick = () => speedBy(1);
  $("smaller").onclick = () => set("size", cfg.size - 2);
  $("bigger").onclick = () => set("size", cfg.size + 2);

  /* ── presets: size, place and settings, by name ── */
  const presets = () => store("presets") || [];
  function paintPresets() {
    $("presets").replaceChildren(...presets().map((p, i) => {
      const row = document.createElement("div");
      row.className = "preset";
      const use = document.createElement("button");
      use.className = "name"; use.textContent = p.name; use.title = `${p.w}×${p.h} · ${p.mode === "words" ? p.wpm + " wpm" : p.px + " px/s"} · ${p.size}px`;
      use.onclick = () => applyPreset(p);
      const del = document.createElement("button");
      del.textContent = "×"; del.title = "Forget this preset";
      del.onclick = () => { const all = presets(); all.splice(i, 1); store("presets", all); paintPresets(); };
      row.append(use, del);
      return row;
    }));
  }
  async function applyPreset(p) {
    for (const k of Object.keys(DEF)) if (p[k] !== undefined) cfg[k] = p[k];
    save();
    toggle(false);
    render();
    paint();
    if (win && T.dpi && p.w) {
      try {
        await win.setSize(new T.dpi.PhysicalSize(p.w, p.h));
        await win.setPosition(new T.dpi.PhysicalPosition(p.x, p.y));
      } catch {}
    }
  }
  $("presetSave").onclick = async () => {
    const name = $("presetName").value.trim() || `Preset ${presets().length + 1}`;
    let geo = {};
    if (win) {
      try { const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]); geo = { x: pos.x, y: pos.y, w: size.width, h: size.height }; } catch {}
    }
    const all = presets().filter((p) => p.name !== name);
    all.push({ name, ...geo, ...Object.fromEntries(Object.keys(DEF).map((k) => [k, cfg[k]])) });
    store("presets", all);
    $("presetName").value = "";
    paintPresets();
  };
  $("presetName").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") $("presetSave").click(); });

  /* ── editing here ── */
  let sendTimer = 0;
  // Edit is a switch: the words on screen take the caret where they are, nothing else changes. Each block
  // goes back to the note's own lines it was read from (scriptmap.js) - the rest of the note as it was.
  const isEditing = () => page.isContentEditable;
  /** A message at the bottom of the window, for a few seconds. */
  const say = (text) => {
    const el = document.createElement("div");
    el.className = "help";
    el.style.cssText = "left:10px;font-size:13px;color:var(--accent);opacity:1";
    el.textContent = text;
    document.body.append(el);
    setTimeout(() => el.remove(), 8000);
  };
  function editing(on) {
    if (!on) flush(); // what was typed last goes to the note before the switch is off (flush sends only then)
    page.contentEditable = on ? "true" : "false";
    page.spellcheck = on;
    document.body.classList.toggle("editing", on);
    $("editBtn").classList.toggle("is-on", on);
    $("editBtn").title = on ? "Editing - type in the text; click again (or Esc) to stop" : "Edit the text right here - saved to the note as you type";
    if (on) { toggle(false); page.focus(); }
    else render();
  }
  /** What is on screen now, block by block, with the block each came from (a new one, made by Enter, has
   *  none - or carries the same one again, and counts as new). */
  const onScreen = () => {
    const out = [];
    for (const el of page.children) for (const x of el.tagName === "UL" ? el.children : [el]) out.push({ b: x.dataset.b != null && x.dataset.b !== "" ? Number(x.dataset.b) : null, text: x.textContent, tag: x.tagName.toLowerCase() });
    return out;
  };
  const flush = () => {
    clearTimeout(sendTimer);
    // only while editing: anything else on screen is never sent as the note's text
    if (!isEditing() || !note || !T || !T.event) return;
    const next = SM.apply(note.text, metas, onScreen());
    if (next === note.text) return;
    if (!next.trim() && note.text.trim()) return; // never empties a note from here
    // base: the text this was typed over, so the main window can see the note has moved since
    T.event.emit("script:edit", { path: note.path, text: next, base: note.text });
    note.text = next;
    // the blocks are the note's again: each one on screen points at its new lines (the caret stays where it is)
    sent = metas = SM.blocks(next);
    const els = [];
    for (const el of page.children) for (const x of el.tagName === "UL" ? el.children : [el]) if (SM.norm(x.textContent)) els.push(x);
    if (els.length === metas.length) els.forEach((x, i) => { x.dataset.b = String(i); });
    else render(); // a change that reshaped the blocks (a line typed as "# ...") draws them again; the caret goes to the start
  };
  // saved to the note a moment after typing stops (the main window writes it, as any edit)
  page.addEventListener("input", () => { if (!isEditing()) return; clearTimeout(sendTimer); sendTimer = setTimeout(flush, 700); });
  // and on leaving the window: choosing another note in the main window makes this one's edits unwelcome there
  addEventListener("blur", flush);
  // pasted or dropped: its words only - web content brings its own pictures (loaded from their site) and markup
  page.addEventListener("paste", (e) => {
    if (!isEditing()) return;
    e.preventDefault();
    const t = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    if (t) document.execCommand("insertText", false, t);
  });
  page.addEventListener("drop", (e) => { e.preventDefault(); if (!isEditing()) return; const t = e.dataTransfer && e.dataTransfer.getData("text/plain"); if (t) document.execCommand("insertText", false, t); });
  page.addEventListener("dragover", (e) => e.preventDefault());
  $("editBtn").onclick = () => editing(!isEditing());

  /* ── the bar ── */
  $("play").onclick = () => toggle();
  $("top").onclick = () => { page.scrollTop = 0; if (cfg.mode === "words") go(0); };
  const hideMe = () => { flush(); toggle(false); if (win) win.hide().catch(() => win.close()); };
  $("close").onclick = hideMe;
  $("gear").onclick = () => { const p = $("panel"); p.hidden = !p.hidden; document.body.classList.toggle("panel-open", !p.hidden); if (!p.hidden) paintPresets(); };
  $("modeScroll").onclick = () => set("mode", "scroll");
  $("modeWords").onclick = () => set("mode", "words");
  let onTop = true;
  $("pin").onclick = () => { onTop = !onTop; $("pin").classList.toggle("is-on", onTop); if (win) win.setAlwaysOnTop(onTop).catch(() => {}); };
  function dragBy(el, kind) {
    el.addEventListener("pointerdown", async (e) => {
      if (e.button !== 0 || !win || !T.dpi) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const sx = e.screenX, sy = e.screenY, dpr = devicePixelRatio || 1;
      let pos, size;
      try { [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]); } catch { return; }
      let want = null, busy = false;
      // one move at a time, always to where the pointer is now
      const apply = async () => {
        if (busy || !want) return;
        busy = true;
        const w = want; want = null;
        try { if (kind === "move") await win.setPosition(new T.dpi.PhysicalPosition(w.x, w.y)); else await win.setSize(new T.dpi.PhysicalSize(w.w, w.h)); } catch {}
        busy = false;
        apply();
      };
      const move = (ev) => {
        const dx = Math.round((ev.screenX - sx) * dpr), dy = Math.round((ev.screenY - sy) * dpr);
        want = kind === "move" ? { x: pos.x + dx, y: pos.y + dy } : { w: Math.max(Math.round(240 * dpr), size.width + dx), h: Math.max(Math.round(140 * dpr), size.height + dy) };
        apply();
      };
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }
  dragBy($("drag"), "move");
  dragBy($("grip"), "size");

  addEventListener("keydown", (e) => {
    if (isEditing() && e.key !== "Escape") return; // typing in the text: every key is the text's
    if (isEditing()) { e.preventDefault(); editing(false); return; }
    if (e.target.closest && e.target.closest("input, textarea")) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); speedBy(1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); speedBy(-1); }
    else if (e.key === "ArrowRight" && cfg.mode === "words") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowLeft" && cfg.mode === "words") { e.preventDefault(); go(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); page.scrollTop = 0; if (cfg.mode === "words") go(0); }
    else if (e.key === "Escape") { if (!$("panel").hidden) $("gear").click(); else hideMe(); }
    else if (e.ctrlKey && (e.key === "+" || e.key === "=")) { e.preventDefault(); set("size", cfg.size + 2); }
    else if (e.ctrlKey && e.key === "-") { e.preventDefault(); set("size", cfg.size - 2); }
  });
  // Ctrl + wheel: the text size; the wheel alone moves through the script, as any page
  page.addEventListener("wheel", (e) => { if (e.ctrlKey) { e.preventDefault(); set("size", cfg.size - Math.sign(e.deltaY) * 2); } }, { passive: false });

  // the bar and the help fade while the pointer rests, so only the words are left
  let idle = 0;
  const wake = () => { document.body.classList.remove("idle"); clearTimeout(idle); idle = setTimeout(() => { if (!document.querySelector(".bar:hover")) document.body.classList.add("idle"); }, 2500); };
  addEventListener("mousemove", wake, { passive: true });
  wake();

  paint();
  if (T && T.core) {
    T.core.invoke("script_start").then((n) => show(n, true)).catch(() => {});
    T.event.listen("script:note", (e) => show(e.payload, false));
  }
})();
